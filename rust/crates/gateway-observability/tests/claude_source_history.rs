//! Actual frozen Bun writer cases, plus the named post-acceptance carrier only.
//! This fixture grants no quota, routing, native credential or live provider authority.
mod support;
use gateway_admin_runtime::capabilities::Context;
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    state::{RecordKey, RevisionCheck, StoredRecord},
    tuple_key::TupleKey,
    value::ValueEncoding,
};
use gateway_observability::{
    ObservabilityRuntime,
    capacity_shapes::{BUCKET_MS, RETENTION_MS, unavailable_snapshot},
    claude_capacity::*,
    host_types::*,
    types::{HealthProvider, HealthTarget, ObservabilityHost},
};
use serde::Deserialize;
use serde_json::{Value, json};
use support::{Host, Memory, run};
const AT: i64 = 7_200_000;
#[derive(Deserialize)]
struct Oracle {
    source_sha: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    event: SourceJson,
    rows: Vec<Expected>,
}
#[derive(Deserialize)]
struct Expected {
    key: Value,
    value: SourceJson,
    expires_at_ms: Option<i64>,
}
fn oracle() -> Oracle {
    SourceJson::parse(include_str!("fixtures/claude_capacity_source.json"))
        .unwrap()
        .deserialize()
        .unwrap()
}
fn key(value: Value) -> RecordKey {
    TupleKey::from_json_parts(value.as_array().unwrap())
        .unwrap()
        .to_record_key()
}
fn setup(at: i64) -> (Memory, ObservabilityRuntime<Memory, Host>) {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(at);
    (memory.clone(), ObservabilityRuntime::new(memory, host))
}
fn event(index: usize) -> ClaudeAcceptedObservation {
    ClaudeAcceptedObservation::from_source(&oracle().cases[index].event).unwrap()
}
fn member(value: &SourceJson, name: &str) -> SourceJson {
    source::member(value, name).unwrap()
}
fn number(value: &SourceJson, name: &str) -> f64 {
    source::number(&member(value, name)).unwrap()
}
fn text(value: &SourceJson, name: &str) -> JsString16 {
    member(value, name).deserialize().unwrap()
}
fn replace(value: &SourceJson, name: &str, replacement: SourceJson) -> SourceJson {
    let mut entries = source::entries(value).unwrap();
    let name = JsString16::from_utf8(name);
    if let Some((_, v)) = entries.iter_mut().find(|(k, _)| *k == name) {
        *v = replacement
    } else {
        entries.push((name, replacement));
    }
    source::object_keys(entries).unwrap()
}
fn rows(value: &SourceJson) -> Vec<SourceJson> {
    member(value, "points").array_items().unwrap()
}
fn response(value: gateway_auth::AuthResponse) -> SourceJson {
    assert_eq!(value.status, 200);
    assert_eq!(value.headers["cache-control"], "no-store");
    SourceJson::parse_bytes(&value.body.to_bytes().unwrap()).unwrap()
}
fn snapshot(memory: &Memory) -> Vec<(String, StoredRecord)> {
    memory
        .rows
        .borrow()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}
#[test]
fn actual_bun_writer_scalar_and_utf16_documents_match_point_digest_bucket_rollups_and_expiry() {
    let oracle = oracle();
    assert_eq!(
        oracle.source_sha,
        "893c14045e9aaaf436fe135a0b7743d3ea3fd9ac"
    );
    for (index, case) in oracle.cases.iter().enumerate() {
        let (memory, runtime) = setup(AT);
        let event = ClaudeAcceptedObservation::from_source(&case.event).unwrap();
        assert!(run(runtime.record_claude_capacity_observation(&event)).unwrap());
        assert_eq!(memory.rows.borrow().len(), 3);
        for expected in &case.rows {
            let key = key(expected.key.clone());
            let record = memory.rows.borrow()[&key.0].clone();
            assert_eq!(record.expires_at_ms, expected.expires_at_ms);
            assert!(!record.revision.is_empty());
            assert_eq!(
                record.value_encoding,
                if index != 1 {
                    ValueEncoding::Json
                } else {
                    ValueEncoding::ProfileV2
                }
            );
            let actual = if expected.key[4] == "history" {
                claude_history_bucket_record_source(&key, &record)
            } else {
                claude_rollup_record_source(&key, &record)
            }
            .unwrap();
            assert_eq!(
                source::canonical(&actual).unwrap(),
                source::canonical(&expected.value).unwrap()
            );
        }
        let before = snapshot(&memory);
        let restarted = ObservabilityRuntime::new(memory.clone(), runtime.host().clone());
        assert!(!run(restarted.record_claude_capacity_observation(&event)).unwrap());
        assert_eq!(before, snapshot(&memory));
        let history = run(restarted.claude_capacity_history(AT));
        assert_eq!(text(&history, "scan"), JsString16::from_utf8("ok"));
        assert_eq!(rows(&history).len(), 1);
        assert_eq!(
            text(&rows(&history)[0], "workspace_id"),
            event.workspace_id.unwrap()
        );
        let rollups = run(restarted.claude_capacity_rollups(0, AT));
        assert_eq!(rows(&rollups).len(), 2);
        if index == 1 {
            println!(
                "M39_CLAUDE_WRITER_FIXTURE={}",
                serde_json::to_string(&before).unwrap()
            );
        }
    }
}
#[test]
fn named_source_validators_keep_complete_key_version_numeric_flags_and_encoding_fences() {
    let (memory, runtime) = setup(AT);
    assert!(run(runtime.record_claude_capacity_observation(&event(1))).unwrap());
    for (raw, record) in snapshot(&memory) {
        let raw_key = RecordKey(raw);
        let value = decode_source_control_record(&record).unwrap();
        let history = source::member(&value, "points").is_some_and(|v| v.array_items().is_ok());
        let validate = |key: &RecordKey, row: &StoredRecord| {
            if history {
                claude_history_bucket_record_source(key, row)
            } else {
                claude_rollup_record_source(key, row)
            }
        };
        assert!(validate(&raw_key, &record).is_ok());
        assert!(validate(&RecordKey("bad".into()), &record).is_err());
        for field in if history {
            vec![
                "v",
                "bucket_start_at_ms",
                "account_id",
                "account_cohort_id",
                "flags",
                "points",
            ]
        } else {
            vec![
                "v",
                "bucket_start_at_ms",
                "account_id",
                "account_cohort_id",
                "credential_kind",
                "workspace_id",
                "window",
                "reset_at_ms",
                "samples",
                "available_sample_count",
                "unavailable_sample_count",
                "first_source_observed_at_ms",
                "last_source_observed_at_ms",
                "first_sampled_at_ms",
                "last_sampled_at_ms",
                "min_used_percent",
                "max_used_percent",
                "last_used_percent",
                "last_status",
            ]
        } {
            let damaged = replace(&value, field, SourceJson::parse("false").unwrap());
            let row = encode_source_control_record("same-revision", &damaged, record.expires_at_ms)
                .unwrap();
            assert!(
                validate(&raw_key, &row).is_err(),
                "accepted invalid {field}"
            );
        }
        let mut wrong = record.clone();
        wrong.schema_version += 1;
        assert!(validate(&raw_key, &wrong).is_err());
        let mut wrong = record.clone();
        wrong.value_encoding = ValueEncoding::ProfileV1;
        assert!(validate(&raw_key, &wrong).is_err());
        let decoded = TupleKey::from_record_key(&raw_key)
            .unwrap()
            .decoded_parts()
            .unwrap();
        assert_eq!(decoded.len(), if history { 8 } else { 10 });
        let mut parts = if history {
            json!([
                "uos_ai",
                "provider_capacity",
                "claude",
                "v1",
                "history",
                AT,
                "other",
                "synthetic-cohort"
            ])
        } else {
            json!([
                "uos_ai",
                "provider_capacity",
                "claude",
                "v1",
                "rollup",
                AT,
                "other",
                "synthetic-cohort",
                "five_hour",
                10800000
            ])
        };
        assert!(validate(&key(parts.clone()), &record).is_err());
        let original = oracle()
            .cases
            .into_iter()
            .nth(1)
            .unwrap()
            .rows
            .into_iter()
            .find(|expected| key(expected.key.clone()) == raw_key)
            .unwrap()
            .key;
        for index in 0..original.as_array().unwrap().len() {
            let mut wrong = original.clone();
            wrong[index] = wrong[index]
                .as_f64()
                .map_or_else(|| json!("wrong"), |n| json!(n + 1.0));
            assert!(
                validate(&key(wrong), &record).is_err(),
                "accepted mismatched key part {index}"
            );
        }
        parts[3] = json!("v2");
        assert!(validate(&key(parts), &record).is_err());
    }
}
#[test]
fn source_history_point_validation_retains_utf16_length_and_complete_window_standard_contract() {
    let p = point_for_observation(&event(1)).unwrap().unwrap();
    assert!(valid_history_point_source(&p));
    for name in [
        "v",
        "point_id",
        "account_id",
        "account_cohort_id",
        "credential_kind",
        "workspace_id",
        "state",
        "response_status",
        "sampled_at_ms",
        "source_observed_at_ms",
        "bucket_start_at_ms",
        "windows",
        "standard",
    ] {
        assert!(
            !valid_history_point_source(&replace(&p, name, SourceJson::parse("false").unwrap())),
            "accepted {name}"
        );
    }
    let long = JsString16::from_units(vec![0xd800; 201]);
    assert!(!valid_history_point_source(&replace(
        &p,
        "workspace_id",
        long.to_source_json().unwrap()
    )));
    let windows = member(&p, "windows");
    let window = member(&windows, "five_hour");
    for name in ["status", "used_percent", "reset_at_ms", "observed_at_ms"] {
        let invalid = replace(&window, name, SourceJson::parse("false").unwrap());
        assert!(!valid_history_point_source(&replace(
            &p,
            "windows",
            replace(&windows, "five_hour", invalid)
        )));
    }
    for bad in ["-1", "600", "1.1e30"] {
        assert!(!valid_history_point_source(&replace(
            &p,
            "response_status",
            SourceJson::parse(bad).unwrap()
        )));
    }
    let mut empty = event(0);
    empty.observation = SourceJson::parse(
        r#"{"windows":{},"standard":{},"representative_claim":null,"observed_at_ms":7200000}"#,
    )
    .unwrap();
    assert!(point_for_observation(&empty).unwrap().is_none());
    let mut injected = event(1);
    injected.observation = replace(
        &injected.observation,
        "secret",
        SourceJson::parse(r#""synthetic-never-digest""#).unwrap(),
    );
    assert_eq!(point_for_observation(&injected).unwrap(), Some(p));
}
#[test]
fn writer_cas_retries_are_bounded_atomic_and_expired_bucket_retains_original_revision_fence() {
    let (memory, runtime) = setup(AT);
    memory.conflicts.set(3);
    assert!(run(runtime.record_claude_capacity_observation(&event(1))).unwrap());
    assert_eq!(memory.commits.get(), 4);
    assert_eq!(memory.rows.borrow().len(), 3);
    let (memory, runtime) = setup(AT);
    memory.conflicts.set(4);
    assert!(run(runtime.record_claude_capacity_observation(&event(1))).is_err());
    assert_eq!(memory.commits.get(), 4);
    assert!(memory.rows.borrow().is_empty());
    let (memory, runtime) = setup(AT);
    let case = &oracle().cases[1];
    let expected = &case.rows[0];
    let key = key(expected.key.clone());
    memory.rows.borrow_mut().insert(
        key.0.clone(),
        encode_source_control_record("expired-original", &expected.value, Some(AT)).unwrap(),
    );
    assert!(run(runtime.record_claude_capacity_observation(&event(1))).unwrap());
    let row = memory.rows.borrow()[&key.0].clone();
    assert_eq!(row.expires_at_ms, Some(AT + BUCKET_MS + RETENTION_MS));
    assert_ne!(row.revision, "expired-original");
    assert_eq!(rows(&run(runtime.claude_capacity_history(AT))).len(), 1);
}
fn changed(
    mut event: ClaudeAcceptedObservation,
    util: f64,
    state: ClaudeObservationState,
    first: f64,
    second: f64,
) -> ClaudeAcceptedObservation {
    let windows = member(&event.observation, "windows");
    let update = |name, reset| {
        let w = member(&windows, name);
        replace(
            &replace(
                &w,
                "utilization",
                SourceJson::from_serializable(&util).unwrap(),
            ),
            "reset_at_ms",
            SourceJson::from_serializable(&reset).unwrap(),
        )
    };
    event.observation = replace(
        &event.observation,
        "windows",
        source::object(vec![
            ("5h", update("5h", first)),
            ("7d", update("7d", second)),
        ])
        .unwrap(),
    );
    event.state = state;
    event
}
#[test]
fn retention_keeps_two_normal_state_transitions_reset_flags_and_six_point_maximum() {
    use ClaudeObservationState::{Available as A, Unavailable as U};
    let (memory, runtime) = setup(AT);
    let cases = [
        (0.1, A, 10800000.0, 14400000.0, true),
        (0.2, A, 10800000.0, 14400000.0, true),
        (0.3, A, 10800000.0, 14400000.0, false),
        (0.4, U, 10800000.0, 14400000.0, true),
        (0.5, A, 10800000.0, 14400000.0, true),
        (0.6, A, 10800001.0, 14400000.0, true),
        (0.7, A, 10800001.0, 14400001.0, true),
        (0.8, U, 10800002.0, 14400002.0, false),
    ];
    for (util, state, first, second, kept) in cases {
        assert_eq!(
            run(runtime.record_claude_capacity_observation(&changed(
                event(1),
                util,
                state,
                first,
                second
            )))
            .unwrap(),
            kept
        );
    }
    let history = run(runtime.claude_capacity_history(AT));
    assert_eq!(rows(&history).len(), 6);
    let bucket = snapshot(&memory)
        .into_iter()
        .map(|(_, row)| decode_source_control_record(&row).unwrap())
        .find(|v| source::member(v, "points").is_some())
        .unwrap();
    let flags = member(&bucket, "flags");
    assert_eq!(number(&flags, "normal"), 2.0);
    for name in ["unavailable", "recovery", "five_hour", "seven_day"] {
        assert_eq!(member(&flags, name).as_str(), "true");
    }
}
#[test]
fn history_and_rollup_readers_preserve_default_future_skip_and_corruption_refusal_without_writes() {
    let (memory, runtime) = setup(AT);
    assert!(run(runtime.record_claude_capacity_observation(&event(1))).unwrap());
    let original = snapshot(&memory);
    let before = memory.commits.get();
    assert!(rows(&run(runtime.claude_capacity_history(AT - 1))).is_empty());
    let previous_hour = run(runtime.claude_capacity_rollups(0, AT - 1));
    assert_eq!(text(&previous_hour, "scan"), JsString16::from_utf8("ok"));
    assert!(rows(&previous_hour).is_empty());
    let (_, future_runtime) = setup(AT);
    let mut future = event(1);
    future.sampled_at_ms += 1;
    assert!(run(future_runtime.record_claude_capacity_observation(&future)).unwrap());
    assert!(rows(&run(future_runtime.claude_capacity_history(AT))).is_empty());
    assert_eq!(
        text(&run(future_runtime.claude_capacity_rollups(0, AT)), "scan"),
        JsString16::from_utf8("unavailable")
    );
    assert_eq!(memory.commits.get(), before);
    for (key, record) in original {
        let mut damaged = record.clone();
        damaged.schema_version += 1;
        memory.rows.borrow_mut().insert(key.clone(), damaged);
        let history = decode_source_control_record(&record)
            .unwrap()
            .as_str()
            .contains("\"points\"");
        let view = if history {
            run(runtime.claude_capacity_history(AT))
        } else {
            run(runtime.claude_capacity_rollups(0, AT))
        };
        assert_eq!(text(&view, "scan"), JsString16::from_utf8("unavailable"));
        assert!(rows(&view).is_empty());
        let snapshot = snapshot(&memory);
        assert!(
            run(runtime.record_claude_capacity_observation(&changed(
                event(1),
                0.9,
                ClaudeObservationState::Available,
                10800000.0,
                14400000.0
            )))
            .is_err()
        );
        assert_eq!(snapshot, snapshot_rows(&memory));
        memory.rows.borrow_mut().insert(key, record);
    }
    memory.unavailable.set(true);
    assert_eq!(
        text(&run(runtime.claude_capacity_history(AT)), "scan"),
        JsString16::from_utf8("unavailable")
    );
    assert_eq!(
        text(&run(runtime.claude_capacity_rollups(0, AT)), "scan"),
        JsString16::from_utf8("unavailable")
    );
    assert_eq!(memory.commits.get(), before);
}
fn snapshot_rows(memory: &Memory) -> Vec<(String, StoredRecord)> {
    snapshot(memory)
}
struct InventoryHost {
    base: Host,
    inventory: ProviderInventory,
}
impl ObservabilityHost for InventoryHost {
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        self.base.source_string_collator()
    }
    fn now_ms(&self) -> i64 {
        self.base.now_ms()
    }
    fn random_bytes(&self, n: usize) -> Result<Vec<u8>, GatewayError> {
        self.base.random_bytes(n)
    }
    async fn wait_ms(&self, n: u32) -> Result<(), GatewayError> {
        self.base.wait_ms(n).await
    }
    fn build_identity(&self) -> Result<BuildIdentity, GatewayError> {
        Ok(BuildIdentity {
            git_sha: "0123456789012345678901234567890123456789".into(),
            deployment_id: "synthetic-m39".into(),
        })
    }
    async fn provider_inventory(&self, _: &Context) -> Result<ProviderInventory, GatewayError> {
        Ok(self.inventory.clone())
    }
    async fn probe_upstream_health(&self, _: i64) -> Result<UpstreamHealthEvidence, GatewayError> {
        Ok(UpstreamHealthEvidence {
            auth: None,
            codex: ActiveProbe {
                status: 200,
                provider: ProbeProvider::ChatgptCodex,
                content_type: None,
                error: None,
            },
            metered_quota: None,
            claude_subscription: None,
            claude_workspace: self.inventory.claude.accounts[0]
                .workspace
                .as_ref()
                .map(SourceJson::from_serializable)
                .transpose()?,
        })
    }
}
fn inventory(memory: &Memory, current: bool) -> InventoryHost {
    let base = Host::default();
    base.at.set(AT);
    let source=SourceJson::parse(r#"{"kind":"api_key","secret":"sk-ant-api-ab\ud83d\ude00synthetic-hidden-middle-tail","label":"label\udc00","updated_at_ms":1}"#).unwrap();
    let credential = gateway_admin_runtime::claude::parse_source_credential(&source, "kv").unwrap();
    let bound = key(json!(["synthetic-binding"]));
    memory.rows.borrow_mut().insert(
        bound.0.clone(),
        StoredRecord::json("current", json!({}), None),
    );
    let account=ClaudeAccountReadback{target:HealthTarget{provider:HealthProvider::ClaudeCode,identity:"synthetic-account:synthetic-cohort".into(),source_checks:vec![RevisionCheck{key:bound,expected_revision:Some(if current{"current"}else{"replaced"}.into())}]},account_id:"synthetic-account".into(),account_cohort_id:"synthetic-cohort".into(),label:credential.label.clone(),credential:CredentialMetadata{kind:CredentialKind::ApiKey,source:credential.source.clone(),hint:credential.hint.clone(),label:credential.label.clone(),updated_at_ms:credential.updated_at_ms},workspace:Some(WorkspaceMetadata{id:JsString16::from_units(vec![0xd800]),name:Some(JsString16::from_units(vec![0xdc00])),source:Some("kv".into()),pinned_by_env:false,discovered_at_ms:None,verified_at_ms:None,last_error:Some(SourceJson::parse(r#""workspace\ud800""#).unwrap())}),quota:Some(SourceJson::parse(r#"{"windows":{"5h":{"status":"allow\udc00","utilization":0.25,"reset_at_ms":10800000,"observed_at_ms":7200000}},"standard":{},"representative_claim":null,"blocked_until_ms":null,"block_window":null,"cooldown_until_ms":null,"last_error":{"kind":"upstream_error","status":503,"message":"error\ud800","at_ms":7200000},"updated_at_ms":7200000,"pool_proofs":{"secret":"synthetic-forbidden"}}"#).unwrap())};
    InventoryHost {
        base,
        inventory: ProviderInventory {
            codex: CodexAuthMetadata {
                source: CredentialSource::None,
                updated_at_ms: None,
                access_token_exp_ms: None,
                accounts: vec![],
            },
            configured: Default::default(),
            claude: ClaudeRosterReadback {
                accounts: vec![account],
                active_account_id: Some("synthetic-account".into()),
                active_reason: Some(JsString16::from_units(vec![0xd800])),
                access: Some(ClaudeAccessReadback {
                    source: "kv".into(),
                    allowed_key_ids: vec![JsString16::from_units(vec![0xdc00])],
                    updated_at_ms: Some(AT),
                }),
                enabled: true,
            },
            metered_quota: None,
            quota_monitoring_configured: false,
            ubiquity_configured: false,
        },
    }
}
fn context() -> Context {
    Context {
        request_id: "synthetic-m39".into(),
        now_ms: AT,
    }
}
#[test]
fn passive_response_preserves_actual_source_masked_hint_labels_workspace_allowlist_and_stale_quota_fence()
 {
    for current in [true, false] {
        let memory = Memory::default();
        let host = inventory(&memory, current);
        let hint = host.inventory.claude.accounts[0].credential.hint.clone();
        assert_eq!(hint.as_units()[13], 0xd83d);
        let runtime = ObservabilityRuntime::new(memory.clone(), host);
        let before = snapshot(&memory);
        let body = response(run(runtime.passive_provider_response(false, context())).unwrap());
        let claude = member(&body, "claude_code");
        let account = &member(&claude, "accounts").array_items().unwrap()[0];
        assert_eq!(text(&member(account, "credential"), "hint"), hint);
        assert_eq!(text(account, "label").as_units().last(), Some(&0xdc00));
        assert_eq!(
            text(&member(account, "workspace"), "id").as_units(),
            [0xd800]
        );
        assert_eq!(text(&claude, "active_reason").as_units(), [0xd800]);
        assert_eq!(
            member(&member(&claude, "access"), "allowed_key_ids")
                .array_items()
                .unwrap()[0]
                .deserialize::<JsString16>()
                .unwrap()
                .as_units(),
            [0xdc00]
        );
        assert!(!body.as_str().contains("synthetic-hidden-middle"));
        assert!(!body.as_str().contains("synthetic-forbidden"));
        assert!(!body.as_str().contains("pool_proofs"));
        assert_eq!(
            member(account, "stale").as_str(),
            if current { "false" } else { "true" }
        );
        if current {
            assert_eq!(
                text(
                    &member(&member(&member(account, "quota"), "windows"), "5h"),
                    "status"
                )
                .as_units()
                .last(),
                Some(&0xdc00)
            );
        } else {
            assert_eq!(member(account, "quota").as_str(), "null");
            assert_eq!(member(&claude, "quota").as_str(), "null");
            assert_eq!(member(&claude, "configured").as_str(), "false");
        }
        assert_eq!(snapshot(&memory), before);
    }
}
#[test]
fn actual_capacity_history_rollups_and_upstream_response_bytes_keep_one_source_document_rail() {
    let memory = Memory::default();
    let host = inventory(&memory, true);
    let runtime = ObservabilityRuntime::new(memory.clone(), host);
    assert!(run(runtime.record_claude_capacity_observation(&event(1))).unwrap());
    memory.rows.borrow_mut().insert(
        key(json!(["uos_ai", "provider_capacity", "v1", "snapshot"])).0,
        StoredRecord::json("cached-synthetic", unavailable_snapshot(AT), None),
    );
    let before = snapshot(&memory);
    let body = response(run(runtime.capacity_response(false, context())).unwrap());
    let claude = member(&body, "claude");
    assert_eq!(text(&claude, "workspace_id").as_units(), [0xd800]);
    assert_eq!(
        text(&member(&member(&claude, "windows"), "five_hour"), "status")
            .as_units()
            .last(),
        Some(&0xdc00)
    );
    assert_eq!(
        text(&member(&claude, "last_error"), "message")
            .as_units()
            .last(),
        Some(&0xd800)
    );
    assert_eq!(rows(&member(&body, "claude_history")).len(), 1);
    assert!(!body.as_str().contains("pool_proofs"));
    assert!(!body.as_str().contains("synthetic-hidden-middle"));
    let rollups = response(run(runtime.capacity_rollups_response(90)).unwrap());
    assert_eq!(
        member(&rollups, "claude_rollups")
            .array_items()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        text(&rollups, "claude_rollup_scan"),
        JsString16::from_utf8("ok")
    );
    let health = response(run(runtime.upstream_health_response()).unwrap());
    assert_eq!(
        text(
            &member(&member(&health, "probes"), "claude_workspace"),
            "id"
        )
        .as_units(),
        [0xd800]
    );
    assert_eq!(snapshot(&memory), before);
}
