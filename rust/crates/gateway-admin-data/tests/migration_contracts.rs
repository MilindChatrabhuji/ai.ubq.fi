use gateway_admin_data::{
    migration::{
        self, ImportOptions, ObservedRow, Profile, audit, counter, kernel,
        retention::{self, DAY, Expiry},
    },
    profile,
};
use gateway_core::{
    state::{AtomicTransition, RecordMutation, StoredRecord},
    value::{PortableValue, ValueEncoding},
};
use serde_json::{Value, json};

fn row(parts: Value, value: Value) -> ObservedRow {
    ObservedRow::json(
        parts.as_array().unwrap().clone(),
        StoredRecord::json("observed", value, None),
    )
    .unwrap()
}
fn puts(transition: &AtomicTransition, parts: &[Value]) -> Vec<ObservedRow> {
    let mut index = 0;
    transition
        .mutations
        .iter()
        .filter_map(|mutation| match mutation {
            RecordMutation::Put { key, record } => {
                let mut observed = row(parts[index].clone(), Value::Null);
                index += 1;
                assert_eq!(&observed.key, key);
                observed.record = record.clone();
                Some(observed)
            }
            _ => None,
        })
        .collect()
}
fn window() -> Value {
    json!({"v":2,"scope":"repo","owner":"owner","repo":"repo","usage_requests":4,"usage_reset_at_ms":10000,"applied_window_ms":1000,"created_at_ms":100,"updated_at_ms":100})
}
fn reservation(request: &str, state: &str) -> Value {
    json!({"v":2,"scope":"repo","owner":"owner","repo":"repo","request_id":request,"route":"/v1/responses","window_created_at_ms":100,"window_reset_at_ms":10000,"reserved_at_ms":101,"lease_expires_at_ms":200,"state":state,"terminal_intent":null,"committed_at_ms":if state=="committed"{json!(120)}else{Value::Null},"released_at_ms":if state=="released"{json!(120)}else{Value::Null},"release_reason":if state=="released"{json!("cancelled")}else{Value::Null}})
}

#[test]
fn retention_uses_source_anchors_and_keeps_pending_durable() {
    let request = json!([
        "uos_ai",
        "api_key_usage",
        "v3",
        "request",
        "key",
        "v3:1000",
        100,
        "request"
    ]);
    assert_eq!(
        retention::migration_expiry(
            request.as_array().unwrap(),
            &json!({"created_at_ms":99999999}),
            2000
        ),
        Expiry::At(1100 + 7 * DAY)
    );
    let mut invalid = request.clone();
    invalid[5] = json!("v3:01000");
    assert_eq!(
        retention::migration_expiry(invalid.as_array().unwrap(), &json!({}), 0),
        Expiry::Skip
    );
    assert_eq!(
        retention::migration_expiry(request.as_array().unwrap(), &json!({}), 1100 + 7 * DAY),
        Expiry::Skip
    );
    assert_eq!(
        retention::migration_expiry(
            json!(["uos_ai", "paid_fallback", "v3", "pending", "key", "request"])
                .as_array()
                .unwrap(),
            &json!({"created_at_ms":0}),
            99 * DAY
        ),
        Expiry::Durable
    );
    let lease = json!([
        "uos_ai",
        "paid_fallback",
        "v3",
        "reconciliation_lease",
        "key"
    ]);
    assert_eq!(
        retention::migration_expiry(
            lease.as_array().unwrap(),
            &json!({"expires_at_ms":2000}),
            2000
        ),
        Expiry::Skip
    );
    assert_eq!(
        retention::migration_expiry(
            lease.as_array().unwrap(),
            &json!({"expires_at_ms":2001}),
            2000
        ),
        Expiry::At(2001)
    );
    assert_eq!(
        retention::bounded_expiry(Some(9_007_199_254_740_991), 1, 0),
        Expiry::Skip
    );
}

#[test]
fn import_classification_keeps_bootstrap_transient_and_cache_boundaries() {
    let local = ImportOptions::for_profile(Profile::Local);
    let prod = ImportOptions::for_profile(Profile::Prod);
    let key = |v: Value| v.as_array().unwrap().clone();
    assert_eq!(
        migration::classify_key(&key(json!(["ubq_ai", "codex_auth"])), &local).action,
        "import"
    );
    assert_eq!(
        migration::classify_key(&key(json!(["ubq_ai", "codex_auth"])), &prod).reason,
        "refreshed_by_deploy_bootstrap"
    );
    assert_eq!(
        migration::classify_key(
            &key(json!(["uos_ai", "auth", "sessions", "session"])),
            &local
        )
        .reason,
        "transient_runtime_state"
    );
    assert_eq!(
        migration::classify_key(
            &key(json!(["embeddings", "v2", "cache_index", "id"])),
            &prod
        )
        .action,
        "optional"
    );
    assert_eq!(
        migration::classify_key(&key(json!(["key", "config", "id"])), &prod).reason,
        "legacy_skipped"
    );
    assert_eq!(
        migration::classify_key(&key(json!(["unknown"])), &local).reason,
        "unknown_prefix"
    );
}

#[test]
fn profile_import_requires_schema_binding_and_does_not_refresh_expiry() {
    let line = r#"{"key":[{"type":"string","value":"uos_ai"},{"type":"string","value":"paid_fallback"},{"type":"string","value":"v3"},{"type":"string","value":"window"},{"type":"string","value":"key"}],"value":{"type":"object","value":{"window_reset_at_ms":{"type":"number","value":1000}}}}"#;
    let entry = profile::normalize_import_line(line).unwrap().unwrap();
    let mut options = ImportOptions::for_profile(Profile::Prod);
    options.dry_run = false;
    let old = StoredRecord::json("existing-null", Value::Null, None);
    let plan = migration::plan_import(&entry, Some(&old), &options, 2000, "new").unwrap();
    assert!(plan.requires_schema_binding);
    let transition = plan.transition.unwrap();
    assert_eq!(
        transition.checks[0].expected_revision.as_deref(),
        Some("existing-null")
    );
    let RecordMutation::Put { record, .. } = &transition.mutations[0] else {
        panic!("expected put")
    };
    assert_eq!(record.expires_at_ms, Some(1000 + 365 * DAY));
    assert_eq!(record.value_encoding, ValueEncoding::Json);
    let existing = StoredRecord::profile("typed", PortableValue::KvU64("5".into()), None).unwrap();
    assert_eq!(
        migration::plan_import(&entry, Some(&existing), &options, 2000, "new")
            .unwrap()
            .outcome,
        "skipped"
    );
    assert!(migration::plan_import(&entry, None, &options, 2000, "").is_err());
    assert!(
        migration::plan_import(&entry, None, &options, 1000 + 365 * DAY, "new")
            .unwrap()
            .transition
            .is_none()
    );
}

#[test]
fn typed_counter_import_keeps_explicit_encoding() {
    let entry=profile::normalize_import_line(r#"{"key":[{"type":"string","value":"uos_ai"},{"type":"string","value":"api_key_usage"},{"type":"string","value":"v2"},{"type":"string","value":"key"}],"value":{"type":"KvU64","value":"18446744073709551615"}}"#).unwrap().unwrap();
    let mut options = ImportOptions::for_profile(Profile::Local);
    options.dry_run = false;
    let plan = migration::plan_import(&entry, None, &options, 1, "new").unwrap();
    let RecordMutation::Put { record, .. } = &plan.transition.unwrap().mutations[0] else {
        panic!("expected put")
    };
    assert_eq!(record.value_encoding, ValueEncoding::ProfileV1);
    assert!(record.json_value().is_err());
    assert_eq!(
        record.portable_value().unwrap(),
        PortableValue::KvU64("18446744073709551615".into())
    );
}

#[test]
fn counter_handoff_applies_only_new_legacy_delta_and_checks_all_snapshots() {
    let policy = json!({"key_id":"key","policy_version":"v3:1000","window_start_ms":0,"usage_reset_at_ms":1000});
    let counter_parts = json!(["uos_ai", "api_key_usage", "v2", "key", "1000", 0]);
    let mut legacy = row(counter_parts, Value::Null);
    legacy.record =
        StoredRecord::profile("counter-5", PortableValue::KvU64("5".into()), None).unwrap();
    let seeded = counter::plan_counter_handoff(
        &policy,
        counter::CounterEntries {
            baseline: None,
            counter: Some(&legacy),
            window: None,
        },
        counter::CounterContext {
            legacy_usage: 3,
            now: 2000,
            initialized: false,
            new_revision: "seeded",
        },
    )
    .unwrap();
    assert!(seeded.baseline_created);
    assert_eq!(seeded.legacy_usage_delta_applied, 5);
    assert_eq!(seeded.transition.checks.len(), 3);
    let parts = [
        json!([
            "uos_ai",
            "migrations",
            "kv_read_incident_v2",
            "api_key_usage_baseline",
            "key",
            "v3:1000",
            0
        ]),
        json!([
            "uos_ai",
            "api_key_usage",
            "v3",
            "window",
            "key",
            "v3:1000",
            0
        ]),
    ];
    let rows = puts(&seeded.transition, &parts);
    let baseline = &rows[0];
    let aggregate = &rows[1];
    assert_eq!(aggregate.value().unwrap()["committed_requests"], 5);
    assert_eq!(aggregate.record.expires_at_ms, Some(2000 + 7 * DAY));
    legacy.record =
        StoredRecord::profile("counter-8", PortableValue::KvU64("8".into()), None).unwrap();
    let updated = counter::plan_counter_handoff(
        &policy,
        counter::CounterEntries {
            baseline: Some(baseline),
            counter: Some(&legacy),
            window: Some(aggregate),
        },
        counter::CounterContext {
            legacy_usage: 3,
            now: 2001,
            initialized: true,
            new_revision: "updated",
        },
    )
    .unwrap();
    assert_eq!(updated.legacy_usage_delta_applied, 3);
    let rows = puts(&updated.transition, &parts);
    assert_eq!(rows[0].value().unwrap()["reconciliation_runs"], 1);
    assert_eq!(rows[1].value().unwrap()["committed_requests"], 8);
    let repeated = counter::plan_counter_handoff(
        &policy,
        counter::CounterEntries {
            baseline: Some(&rows[0]),
            counter: Some(&legacy),
            window: Some(&rows[1]),
        },
        counter::CounterContext {
            legacy_usage: 3,
            now: 2002,
            initialized: true,
            new_revision: "repeated",
        },
    )
    .unwrap();
    assert_eq!(repeated.legacy_usage_delta_applied, 0);
    let wrong = json!({"key_id":"other","policy_version":"v3:1000","window_start_ms":0,"usage_reset_at_ms":1000});
    assert!(
        counter::plan_counter_handoff(
            &wrong,
            counter::CounterEntries {
                baseline: Some(baseline),
                counter: Some(&legacy),
                window: Some(aggregate)
            },
            counter::CounterContext {
                legacy_usage: 3,
                now: 2000,
                initialized: false,
                new_revision: "no"
            }
        )
        .is_err()
    );
}

#[test]
fn kernel_policy_parser_retains_source_normalization_and_identity() {
    let value = json!({"v":2,"scope":"repo","owner":"owner","repo":"repo","window_ms":"1000.9","usage_limit_requests":"25.9","expires_at_ms":"100","created_at_ms":0,"updated_at_ms":1});
    let policy = kernel::normalize_policy(&value, "repo", "owner", Some("repo")).unwrap();
    assert_eq!(policy["window_ms"], 1000);
    assert_eq!(policy["usage_limit_requests"], 25);
    assert_eq!(policy["expires_at_ms"], -1);
    assert!(kernel::normalize_policy(&value, "repo", "other", Some("repo")).is_none());
    assert!(kernel::normalize_policy(&value, "org", "owner", None).is_none());
    let mut malformed = value.clone();
    malformed["created_at_ms"] = json!("0");
    assert!(kernel::normalize_policy(&malformed, "repo", "owner", Some("repo")).is_none());
    malformed = value;
    malformed["window_ms"] = json!(0);
    assert!(kernel::normalize_policy(&malformed, "repo", "owner", Some("repo")).is_none());
}

#[test]
fn kernel_legacy_reserved_aggregate_is_reconciled_only_from_complete_inventory() {
    let observed = row(
        json!([
            "uos_ai",
            "kernel_quota",
            "v2",
            "repo_window",
            "owner",
            "repo"
        ]),
        window(),
    );
    let active = row(
        json!([
            "uos_ai",
            "kernel_quota",
            "v2",
            "repo_reservation",
            "owner",
            "repo",
            100,
            "active"
        ]),
        reservation("active", "reserved"),
    );
    let done = row(
        json!([
            "uos_ai",
            "kernel_quota",
            "v2",
            "repo_reservation",
            "owner",
            "repo",
            100,
            "done"
        ]),
        reservation("done", "committed"),
    );
    let partial = std::slice::from_ref(&active);
    assert!(kernel::reconcile_imported_window(&observed, partial, false, 500, "new").is_err());
    let transition =
        kernel::reconcile_imported_window(&observed, &[active, done], true, 500, "new")
            .unwrap()
            .unwrap();
    let migrated = puts(
        &transition,
        &[serde_json::to_value(&observed.parts).unwrap()],
    );
    assert_eq!(migrated[0].value().unwrap()["reserved_requests"], 1);
    assert!(
        kernel::reconcile_imported_window(&migrated[0], &[], true, 500, "again")
            .unwrap()
            .is_none()
    );
}

#[test]
fn kernel_audit_rejects_reset_mismatch_and_bad_terminal_intervals() {
    let mut w = window();
    w["reserved_requests"] = json!(1);
    let observed = row(
        json!([
            "uos_ai",
            "kernel_quota",
            "v2",
            "repo_window",
            "owner",
            "repo"
        ]),
        w,
    );
    let mut r = reservation("request", "reserved");
    r["window_reset_at_ms"] = json!(10001);
    let reservation_row = row(
        json!([
            "uos_ai",
            "kernel_quota",
            "v2",
            "repo_reservation",
            "owner",
            "repo",
            100,
            "request"
        ]),
        r,
    );
    assert!(
        audit::inspect_kernel(&[observed, reservation_row])
            .unwrap()
            .errors
            .iter()
            .any(|e| e
                .try_utf8()
                .is_ok_and(|text| text.contains("reset is inconsistent")))
    );
    let mut invalid = reservation("request", "reserved");
    invalid["lease_expires_at_ms"] = json!(101);
    assert!(kernel::normalize_reservation(&invalid, "repo", "owner", Some("repo")).is_none());
    invalid = reservation("request", "released");
    invalid["release_reason"] = json!("  ");
    assert!(kernel::normalize_reservation(&invalid, "repo", "owner", Some("repo")).is_none());
    assert!(audit::inspect_source_rows(&[], false, 500).is_err());
}
