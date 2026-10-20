use super::*;
use gateway_core::js_string::JsString16;
use gateway_core::state::StoredRecord;
use gateway_core::value::PortableValue;

fn claude_roster() -> serde_json::Value {
    let fingerprints = [
        "9cc246b6cca9922b599dc79dd47742b480f503ff93a750dafb3f63e9893b0425",
        "56c1de9eedd97e337a68013110eaeed44cb4da2422d9c9b99b791f14fe910396",
    ];
    let accounts: Vec<_> = fingerprints.iter().enumerate().map(|(slot, fingerprint)| {
        let id = slot + 1;
        serde_json::json!({
            "account_id":format!("aaaaaaaa-aaaa-aaaa-aaaa-{id:012}"),
            "account_cohort_id":format!("bbbbbbbb-bbbb-bbbb-bbbb-{id:012}"),
            "evidence_generation":format!("cccccccc-cccc-cccc-cccc-{id:012}"),
            "credential_fingerprint":fingerprint,
            "credential":{"kind":"api_key","secret":format!("fixture-only-claude-key-{id}"),"hint":"fixture","label":null,"source":"kv","updated_at_ms":NOW},
            "workspace":{"id":format!("wrkspc_fixture{id}"),"name":null,"source":"kv","discovered_at_ms":null,"verified_at_ms":NOW,"last_error":null}
        })
    }).collect();
    serde_json::json!({"v":1,"accounts":accounts,"active_account_id":accounts[0]["account_id"],"active_reason":"first_configured","updated_at_ms":NOW})
}

fn claude_quota(roster: &serde_json::Value, slot: usize, kind: &str) -> serde_json::Value {
    serde_json::json!({
        "updated_at_ms":NOW,"windows":{},"standard":{},"representative_claim":null,
        "blocked_until_ms":NOW+300_000,"block_window":"5h","cooldown_until_ms":null,"last_error":null,
        "pool_proofs":{"source-key":{"kind":kind,"model_id":if kind=="auth_invalid" { serde_json::Value::Null } else { serde_json::json!("paid-model") },
        "observed_at_ms":NOW,"expires_at_ms":NOW+300_000,"evidence_generation":roster["accounts"][slot]["evidence_generation"]}}
    })
}

fn claude_key(roster: &serde_json::Value, slot: usize) -> gateway_core::state::RecordKey {
    keys::claude_quota(
        roster["accounts"][slot]["account_id"].as_str().unwrap(),
        roster["accounts"][slot]["account_cohort_id"]
            .as_str()
            .unwrap(),
    )
}

fn claude_setup(store: &MemoryStore) -> serde_json::Value {
    paid_setup(store);
    let roster = claude_roster();
    store.seed(keys::claude_accounts(), &roster);
    for slot in 0..2 {
        store.seed(
            claude_key(&roster, slot),
            &claude_quota(
                &roster,
                slot,
                if slot == 0 {
                    "auth_invalid"
                } else {
                    "quota_exhausted"
                },
            ),
        );
    }
    roster
}

fn utf16_tree(value: PortableValue) -> PortableValue {
    match value {
        PortableValue::Object(items) => PortableValue::ObjectUtf16(
            items
                .into_iter()
                .map(|(key, value)| (JsString16::from_utf8(&key), utf16_tree(value)))
                .collect(),
        ),
        PortableValue::String(value) => PortableValue::StringUtf16(JsString16::from_utf8(&value)),
        PortableValue::Array(items) => {
            PortableValue::Array(items.into_iter().map(utf16_tree).collect())
        }
        value => value,
    }
}

fn typed_field<'a>(value: &'a mut PortableValue, name: &str) -> &'a mut PortableValue {
    let PortableValue::Object(fields) = value else {
        panic!("expected fixture object")
    };
    &mut fields.iter_mut().find(|(key, _)| key == name).unwrap().1
}

fn quota_record(
    roster: &serde_json::Value,
    slot: usize,
    utf16: bool,
    expiry: Option<i64>,
) -> StoredRecord {
    let mut value = PortableValue::from_json(&claude_quota(
        roster,
        slot,
        if slot == 0 {
            "auth_invalid"
        } else {
            "quota_exhausted"
        },
    ));
    let PortableValue::Object(fields) = &mut value else {
        unreachable!()
    };
    fields.push((
        "operator_note".to_owned(),
        PortableValue::string_utf16(vec![0xd800]),
    ));
    fields.push(("unused_window".to_owned(), PortableValue::number(-0.0)));
    if utf16 {
        value = utf16_tree(value);
        let PortableValue::ObjectUtf16(fields) = &mut value else {
            unreachable!()
        };
        fields.push((
            JsString16::from_units(vec![0xdc00]),
            PortableValue::number(-0.0),
        ));
        let PortableValue::ObjectUtf16(proofs) = &mut fields
            .iter_mut()
            .find(|(key, _)| key.as_units() == JsString16::from_utf8("pool_proofs").as_units())
            .unwrap()
            .1
        else {
            unreachable!()
        };
        proofs[0].0 = JsString16::from_units(vec![0xd800]);
    }
    StoredRecord::profile_v2(format!("typed-quota-{slot}"), value, expiry).unwrap()
}

#[test]
fn claude_profile_v2_proofs_reserve_paid_without_reencoding_operator_values() {
    for utf16 in [false, true] {
        let store = MemoryStore::default();
        let roster = claude_setup(&store);
        let records = [
            quota_record(&roster, 0, utf16, None),
            quota_record(&roster, 1, utf16, None),
        ];
        for (slot, record) in records.iter().enumerate() {
            store.seed_record(claude_key(&roster, slot), record.clone());
        }
        let authority = authority(&store);
        let proof = run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
            .unwrap()
            .unwrap();
        assert_eq!(proof.selected_count(), 2);
        let authorization = PaidAuthorization::ClaudeSubscriptionUnavailable(proof);
        assert!(matches!(
            run(reserve_paid(
                &authority,
                &paid_request("claude-typed", PaidProvider::Surplus),
                &authorization,
                NOW
            ))
            .unwrap(),
            PaidAdmission::Reserved(_)
        ));
        for (slot, record) in records.iter().enumerate() {
            assert_eq!(store.row(&claude_key(&roster, slot)).as_ref(), Some(record));
        }
    }
}

#[test]
fn claude_profile_proof_fields_remain_strict_and_missing_model_is_not_null() {
    for fault in [
        "missing-model",
        "undefined-model",
        "auth-model",
        "wrong-model",
        "generation",
        "future",
        "expired",
        "fractional",
        "nonfinite",
        "unsafe",
        "transient",
        "updated",
    ] {
        let store = MemoryStore::default();
        let roster = claude_setup(&store);
        let slot = usize::from(!matches!(
            fault,
            "missing-model" | "undefined-model" | "auth-model"
        ));
        let mut value = quota_record(&roster, slot, false, None)
            .profile_v2_value()
            .unwrap();
        if fault == "updated" {
            *typed_field(&mut value, "updated_at_ms") = PortableValue::number(f64::NAN);
        } else {
            let proof = typed_field(typed_field(&mut value, "pool_proofs"), "source-key");
            match fault {
                "missing-model" => {
                    let PortableValue::Object(fields) = proof else {
                        unreachable!()
                    };
                    fields.retain(|(key, _)| key != "model_id");
                }
                "undefined-model" => *typed_field(proof, "model_id") = PortableValue::Undefined,
                "auth-model" | "wrong-model" => {
                    *typed_field(proof, "model_id") =
                        PortableValue::String("other-model".to_owned())
                }
                "generation" => {
                    *typed_field(proof, "evidence_generation") =
                        PortableValue::String("old-generation".to_owned())
                }
                "future" => {
                    *typed_field(proof, "observed_at_ms") = PortableValue::number((NOW + 1) as f64)
                }
                "expired" => {
                    *typed_field(proof, "expires_at_ms") = PortableValue::number(NOW as f64)
                }
                "fractional" => {
                    *typed_field(proof, "observed_at_ms") = PortableValue::number(NOW as f64 - 0.5)
                }
                "nonfinite" => {
                    *typed_field(proof, "expires_at_ms") = PortableValue::number(f64::INFINITY)
                }
                "unsafe" => {
                    *typed_field(proof, "expires_at_ms") =
                        PortableValue::number(9_007_199_254_740_992.0)
                }
                "transient" => {
                    *typed_field(proof, "kind") = PortableValue::String("transient".to_owned())
                }
                _ => unreachable!(),
            }
        }
        let record = StoredRecord::profile_v2("fault-quota", value, None).unwrap();
        store.seed_record(claude_key(&roster, slot), record.clone());
        assert!(
            run(authority(&store).prove_claude_unavailable(&"paid-model".into(), NOW))
                .unwrap()
                .is_none(),
            "{fault}"
        );
        assert_eq!(store.row(&claude_key(&roster, slot)), Some(record));
    }
}

#[test]
fn claude_quota_encoding_is_explicit_and_other_authority_reads_stay_json_only() {
    for fault in [
        "profile-v1",
        "schema",
        "malformed",
        "json-tag",
        "typed-roster",
        "legacy-roster",
    ] {
        let store = MemoryStore::default();
        let roster = claude_setup(&store);
        let mut record = quota_record(&roster, 1, false, None);
        match fault {
            "profile-v1" => {
                record = StoredRecord::profile(
                    "old-profile",
                    PortableValue::from_json(&claude_quota(&roster, 1, "quota_exhausted")),
                    None,
                )
                .unwrap()
            }
            "schema" => record.schema_version += 1,
            "malformed" => {
                record.value = serde_json::json!({"type":"number_bits","value":"invalid"})
            }
            "json-tag" => record = StoredRecord::json("tag-shaped-json", record.value, None),
            "typed-roster" => {
                record = StoredRecord::profile_v2(
                    "typed-roster",
                    PortableValue::from_json(&roster),
                    None,
                )
                .unwrap();
                // Named roster decoding opts in; generic JSON reads still reject typed rows.
                assert!(record.json_value().is_err());
            }
            "legacy-roster" => {
                record =
                    StoredRecord::profile("legacy-roster", PortableValue::from_json(&roster), None)
                        .unwrap()
            }
            _ => unreachable!(),
        }
        let key = if matches!(fault, "typed-roster" | "legacy-roster") {
            keys::claude_accounts()
        } else {
            claude_key(&roster, 1)
        };
        store.seed_record(key.clone(), record.clone());
        let result = run(authority(&store).prove_claude_unavailable(&"paid-model".into(), NOW));
        if fault == "json-tag" {
            assert!(result.unwrap().is_none());
        } else if fault == "typed-roster" {
            assert!(result.unwrap().is_some(), "{fault}");
        } else {
            assert!(result.is_err(), "{fault}");
        }
        assert_eq!(store.row(&key), Some(record));
    }
}

#[test]
fn claude_typed_quota_revisions_generation_and_absolute_ttl_still_fence_paid_use() {
    for fault in ["revision", "generation", "ttl"] {
        let store = MemoryStore::default();
        let mut roster = claude_setup(&store);
        for slot in 0..2 {
            store.seed_record(
                claude_key(&roster, slot),
                quota_record(
                    &roster,
                    slot,
                    true,
                    (fault == "ttl" && slot == 0).then_some(NOW + 1),
                ),
            );
        }
        let authority = authority(&store);
        let proof = run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
            .unwrap()
            .unwrap();
        match fault {
            "revision" => {
                let mut row = store.row(&claude_key(&roster, 0)).unwrap();
                row.revision = "replaced-quota".to_owned();
                store.seed_record(claude_key(&roster, 0), row);
            }
            "generation" => {
                roster["accounts"][0]["evidence_generation"] =
                    serde_json::json!("dddddddd-dddd-dddd-dddd-000000000001");
                store.seed(keys::claude_accounts(), &roster);
            }
            "ttl" => store.jump_on_read(claude_key(&roster, 1), NOW + 1),
            _ => unreachable!(),
        }
        assert!(
            run(reserve_paid(
                &authority,
                &paid_request("claude-typed-stale", PaidProvider::Surplus),
                &PaidAuthorization::ClaudeSubscriptionUnavailable(proof),
                NOW
            ))
            .is_err(),
            "{fault}"
        );
        assert!(
            store
                .row(&keys::paid_attempt("key-a", "claude-typed-stale"))
                .is_none()
        );
        assert!(store.row(&keys::paid_gate()).is_none());
    }
    let store = MemoryStore::default();
    let roster = claude_setup(&store);
    for slot in 0..2 {
        store.seed_record(
            claude_key(&roster, slot),
            quota_record(&roster, slot, false, (slot == 0).then_some(NOW + 1)),
        );
    }
    store.jump_on_read(claude_key(&roster, 1), NOW + 1);
    assert!(
        run(authority(&store).prove_claude_unavailable(&"paid-model".into(), NOW))
            .unwrap()
            .is_none()
    );
}

#[test]
fn claude_current_mixed_cohort_authorizes_once_without_exposing_secrets() {
    let store = MemoryStore::default();
    claude_setup(&store);
    let authority = authority(&store);
    let proof = run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
        .unwrap()
        .unwrap();
    assert!(proof.model().matches_scalar("paid-model"));
    assert_eq!(proof.selected_count(), 2);
    assert!(!format!("{proof:?}").contains("fixture-only-claude-key"));
    let input = paid_request("claude-paid", PaidProvider::Surplus);
    let authorization = PaidAuthorization::ClaudeSubscriptionUnavailable(proof);
    assert!(matches!(
        run(reserve_paid(&authority, &input, &authorization, NOW)).unwrap(),
        PaidAdmission::Reserved(_)
    ));
    assert!(matches!(
        run(reserve_paid(&authority, &input, &authorization, NOW)).unwrap(),
        PaidAdmission::Existing(_)
    ));
    let window: PaidWindow = serde_json::from_value(
        store
            .row(&keys::paid_window("key-a", policy().usage_reset_at_ms))
            .unwrap()
            .value,
    )
    .unwrap();
    assert_eq!(window.pending_count, 1);
    assert_eq!(window.reserved_microcredits, 1_000);
}

#[test]
fn claude_absent_empty_and_no_active_pools_never_fabricate_exhaustion() {
    let store = MemoryStore::default();
    let authority = authority(&store);
    assert!(
        run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
            .unwrap()
            .is_none()
    );
    let mut roster = claude_setup(&store);
    roster["active_account_id"] = serde_json::Value::Null;
    store.seed(keys::claude_accounts(), &roster);
    assert!(
        run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
            .unwrap()
            .is_none()
    );
    roster["accounts"] = serde_json::json!([]);
    store.seed(keys::claude_accounts(), &roster);
    assert!(
        run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
            .unwrap()
            .is_none()
    );
}

#[test]
fn claude_only_current_applicable_fresh_source_pool_proofs_count() {
    for fault in [
        "missing",
        "transient",
        "configuration",
        "wrong-model",
        "generation",
        "future",
        "expired",
        "unsafe",
        "malformed",
    ] {
        let store = MemoryStore::default();
        let roster = claude_setup(&store);
        let authority = authority(&store);
        let mut quota = claude_quota(&roster, 1, "quota_exhausted");
        let proof = &mut quota["pool_proofs"]["source-key"];
        match fault {
            "missing" => quota["pool_proofs"] = serde_json::json!({}),
            "transient" | "configuration" => proof["kind"] = serde_json::json!(fault),
            "wrong-model" => proof["model_id"] = serde_json::json!("another-model"),
            "generation" => proof["evidence_generation"] = serde_json::json!("old-generation"),
            "future" => proof["observed_at_ms"] = serde_json::json!(NOW + 1),
            "expired" => proof["expires_at_ms"] = serde_json::json!(NOW),
            "unsafe" => proof["expires_at_ms"] = serde_json::json!(9_007_199_254_740_992_i64),
            "malformed" => quota["updated_at_ms"] = serde_json::Value::Null,
            _ => unreachable!(),
        }
        store.seed(claude_key(&roster, 1), &quota);
        assert!(
            run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
                .unwrap()
                .is_none(),
            "{fault}"
        );
    }
}

#[test]
fn claude_roster_fingerprint_validation_fails_closed() {
    for field in [
        "credential_fingerprint",
        "account_id",
        "account_cohort_id",
        "evidence_generation",
        "secret",
        "workspace",
    ] {
        let store = MemoryStore::default();
        let mut roster = claude_setup(&store);
        let authority = authority(&store);
        match field {
            "secret" => {
                roster["accounts"][0]["credential"]["secret"] =
                    serde_json::json!("replacement-fixture")
            }
            "workspace" => {
                roster["accounts"][0]["workspace"]["id"] = serde_json::json!("wrkspc_changed")
            }
            _ => roster["accounts"][0][field] = serde_json::json!("corrupt"),
        }
        store.seed(keys::claude_accounts(), &roster);
        assert!(
            run(authority.prove_claude_unavailable(&"paid-model".into(), NOW)).is_err(),
            "{field}"
        );
    }
}

#[test]
fn claude_proof_fences_every_roster_and_quota_revision() {
    for fault in [
        "reorder",
        "active",
        "add",
        "generation",
        "cohort",
        "credential",
        "workspace",
        "quota",
    ] {
        let store = MemoryStore::default();
        let mut roster = claude_setup(&store);
        let authority = authority(&store);
        let proof = run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
            .unwrap()
            .unwrap();
        match fault {
            "reorder" => roster["accounts"].as_array_mut().unwrap().reverse(),
            "active" => roster["active_account_id"] = roster["accounts"][1]["account_id"].clone(),
            "add" => {
                let mut third = roster["accounts"][0].clone();
                third["account_id"] = serde_json::json!("aaaaaaaa-aaaa-aaaa-aaaa-000000000003");
                roster["accounts"].as_array_mut().unwrap().push(third);
            }
            "generation" => {
                roster["accounts"][0]["evidence_generation"] =
                    serde_json::json!("dddddddd-dddd-dddd-dddd-000000000001")
            }
            "cohort" => {
                roster["accounts"][0]["account_cohort_id"] =
                    serde_json::json!("dddddddd-dddd-dddd-dddd-000000000001")
            }
            "credential" => {
                roster["accounts"][0]["credential"]["secret"] = serde_json::json!("changed-fixture")
            }
            "workspace" => {
                roster["accounts"][0]["workspace"]["id"] = serde_json::json!("wrkspc_changed")
            }
            "quota" => store.seed(
                claude_key(&roster, 0),
                &serde_json::json!({"updated_at_ms":NOW,"pool_proofs":{}}),
            ),
            _ => unreachable!(),
        }
        if fault != "quota" {
            store.seed(keys::claude_accounts(), &roster);
        }
        let input = paid_request("claude-stale", PaidProvider::Surplus);
        assert!(
            run(reserve_paid(
                &authority,
                &input,
                &PaidAuthorization::ClaudeSubscriptionUnavailable(proof),
                NOW
            ))
            .is_err(),
            "{fault}"
        );
        assert!(
            store
                .row(&keys::paid_attempt("key-a", "claude-stale"))
                .is_none()
        );
        assert!(store.row(&keys::paid_gate()).is_none());
    }
}

#[test]
fn claude_check_only_and_paid_cas_races_never_admit_stale_proof() {
    let store = MemoryStore::default();
    let roster = claude_setup(&store);
    let authority = authority(&store);
    let empty = serde_json::json!({"updated_at_ms":NOW,"pool_proofs":{}});
    store.race(claude_key(&roster, 1), &empty);
    assert!(
        run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
            .unwrap()
            .is_none()
    );
    store.seed(
        claude_key(&roster, 1),
        &claude_quota(&roster, 1, "quota_exhausted"),
    );
    let proof = run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
        .unwrap()
        .unwrap();
    store.race(claude_key(&roster, 0), &empty);
    assert!(
        run(reserve_paid(
            &authority,
            &paid_request("claude-race", PaidProvider::Surplus),
            &PaidAuthorization::ClaudeSubscriptionUnavailable(proof),
            NOW
        ))
        .is_err()
    );
    assert!(
        store
            .row(&keys::paid_attempt("key-a", "claude-race"))
            .is_none()
    );
    assert!(store.row(&keys::paid_gate()).is_none());
}

#[test]
fn claude_expiry_crossing_async_reads_never_reserves_paid_exposure() {
    let store = MemoryStore::default();
    let roster = claude_setup(&store);
    let authority = authority(&store);
    store.jump_on_read(claude_key(&roster, 1), NOW + 300_000);
    assert!(
        run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
            .unwrap()
            .is_none()
    );
    store.clock(NOW);
    let proof = run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
        .unwrap()
        .unwrap();
    store.jump_on_read(keys::paid_deletion("key-a"), NOW + 300_000);
    assert!(
        run(reserve_paid(
            &authority,
            &paid_request("claude-expired", PaidProvider::Surplus),
            &PaidAuthorization::ClaudeSubscriptionUnavailable(proof),
            NOW
        ))
        .is_err()
    );
    assert!(
        store
            .row(&keys::paid_attempt("key-a", "claude-expired"))
            .is_none()
    );
    assert!(store.row(&keys::paid_gate()).is_none());
}

#[test]
fn claude_model_scope_clock_and_current_paid_policy_remain_required() {
    let store = MemoryStore::default();
    claude_setup(&store);
    let authority = authority(&store);
    let proof = run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
        .unwrap()
        .unwrap();
    let mut input = paid_request("claude-wrong-model", PaidProvider::Surplus);
    input.model = "gpt-test".into();
    assert!(
        run(reserve_paid(
            &authority,
            &input,
            &PaidAuthorization::ClaudeSubscriptionUnavailable(proof.clone()),
            NOW
        ))
        .is_err()
    );
    let mut changed = policy();
    changed.paid_fallback_enabled = false;
    store.race(keys::api_policy("key-a"), &changed);
    assert!(
        run(reserve_paid(
            &authority,
            &paid_request("claude-disabled", PaidProvider::Surplus),
            &PaidAuthorization::ClaudeSubscriptionUnavailable(proof),
            NOW
        ))
        .is_err()
    );
    assert!(store.row(&keys::paid_gate()).is_none());
    let no_clock = gateway_authority::Authority::new(store.clone(), Tokens::default());
    assert_eq!(
        run(no_clock.prove_claude_unavailable(&"paid-model".into(), NOW))
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("authority_clock_unavailable")
    );
}

#[test]
fn claude_json_integer_representations_and_codex_precedence_match_source() {
    let store = MemoryStore::default();
    let mut roster = claude_setup(&store);
    let authority = authority(&store);
    roster["v"] = serde_json::json!(1.0);
    roster["updated_at_ms"] = serde_json::json!(NOW as f64);
    store.seed(keys::claude_accounts(), &roster);
    for slot in 0..2 {
        let mut quota = claude_quota(&roster, slot, "auth_invalid");
        quota["pool_proofs"]["source-key"]["observed_at_ms"] = serde_json::json!(NOW as f64);
        quota["pool_proofs"]["source-key"]["expires_at_ms"] =
            serde_json::json!((NOW + 300_000) as f64);
        store.seed(claude_key(&roster, slot), &quota);
    }
    let proof = run(authority.prove_claude_unavailable(&"gpt-test".into(), NOW))
        .unwrap()
        .unwrap();
    let mut input = paid_request("claude-codex", PaidProvider::Surplus);
    input.model = "gpt-test".into();
    let error = run(reserve_paid(
        &authority,
        &input,
        &PaidAuthorization::ClaudeSubscriptionUnavailable(proof),
        NOW,
    ))
    .unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("codex_routing_unavailable")
    );
    assert!(store.row(&keys::paid_gate()).is_none());
}

#[test]
fn claude_existing_pending_attempt_cannot_reuse_expired_authorization() {
    let store = MemoryStore::default();
    claude_setup(&store);
    let authority = authority(&store);
    let proof = run(authority.prove_claude_unavailable(&"paid-model".into(), NOW))
        .unwrap()
        .unwrap();
    let authorization = PaidAuthorization::ClaudeSubscriptionUnavailable(proof);
    let input = paid_request("claude-existing", PaidProvider::Surplus);
    assert!(matches!(
        run(reserve_paid(&authority, &input, &authorization, NOW)).unwrap(),
        PaidAdmission::Reserved(_)
    ));
    store.jump_on_read(
        keys::paid_attempt("key-a", "claude-existing"),
        NOW + 300_000,
    );
    assert!(run(reserve_paid(&authority, &input, &authorization, NOW)).is_err());
    let window: PaidWindow = serde_json::from_value(
        store
            .row(&keys::paid_window("key-a", policy().usage_reset_at_ms))
            .unwrap()
            .value,
    )
    .unwrap();
    assert_eq!(window.pending_count, 1);
    assert_eq!(window.reserved_microcredits, 1_000);
}

#[test]
fn claude_model_proof_retains_lone_units_and_never_matches_escape_text_or_other_model() {
    use gateway_core::{
        model::ModelId, source_control::encode_source_control_record, source_json::SourceJson,
    };
    let store = MemoryStore::default();
    let roster = claude_setup(&store);
    let model = ModelId::from_source(JsString16::from_units(vec![0xd800]));
    let generation = roster["accounts"][1]["evidence_generation"]
        .as_str()
        .unwrap();
    let row = SourceJson::parse(&format!(r#"{{"updated_at_ms":{NOW},"pool_proofs":{{"model:\ud800":{{"kind":"quota_exhausted","model_id":"\ud800","observed_at_ms":{NOW},"expires_at_ms":{},"evidence_generation":"{generation}"}}}}}}"#, NOW + 300_000)).unwrap();
    let record = encode_source_control_record("opaque-model-proof", &row, None).unwrap();
    store.seed_record(claude_key(&roster, 1), record.clone());
    let authority = authority(&store);
    let proof = run(authority.prove_claude_unavailable(&model, NOW))
        .unwrap()
        .unwrap();
    assert_eq!(proof.model(), &model);
    assert!(
        run(authority.prove_claude_unavailable(&r"\ud800".into(), NOW))
            .unwrap()
            .is_none()
    );
    assert!(
        run(authority.prove_claude_unavailable(
            &ModelId::from_source(JsString16::from_units(vec![0xdc00])),
            NOW
        ))
        .unwrap()
        .is_none()
    );
    assert_eq!(store.row(&claude_key(&roster, 1)).as_ref(), Some(&record));
}
