use gateway_admin::{AdminHost, AdminInput, AdminOperation, source_input as input};
use gateway_admin_runtime::{
    AdminRuntime, RuntimeConfig, capabilities::RuntimeCapabilities, claude_access, parse,
};
use gateway_auth::{upstream::*, *};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    model::ModelId,
    query::*,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    state::*,
    value::ValueEncoding,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    cmp::Ordering,
    collections::BTreeMap,
    future::Future,
    sync::OnceLock,
    task::{Context, Poll, Waker},
};
const NOW: i64 = 1_000_000;
fn run<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}
#[derive(Default)]
struct Store {
    rows: RefCell<BTreeMap<String, StoredRecord>>,
    conflict: Cell<bool>,
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, tx: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        if self.conflict.replace(false) {
            return Ok(CommitOutcome::Conflict);
        }
        let mut rows = self.rows.borrow_mut();
        if tx
            .checks
            .iter()
            .any(|c| rows.get(&c.key.0).map(|r| &r.revision) != c.expected_revision.as_ref())
        {
            return Ok(CommitOutcome::Conflict);
        }
        for m in tx.mutations {
            match m {
                RecordMutation::Put { key, record } => {
                    rows.insert(key.0, record);
                }
                RecordMutation::Delete { key } => {
                    rows.remove(&key.0);
                }
            }
        }
        Ok(CommitOutcome::Committed)
    }
}
impl QueryStore for Store {
    async fn query(&self, _: QueryRequest) -> Result<QueryPage, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture forbids queries",
            "fixture_query_denied",
        ))
    }
}
#[derive(Default)]
struct Host(Cell<u8>);
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        NOW
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        let n = self.0.get().wrapping_add(1);
        self.0.set(n);
        Ok((0..len).map(|i| n.wrapping_add(i as u8)).collect())
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture forbids network",
            "fixture_network_denied",
        ))
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture forbids kernel policy creation",
            "fixture_policy_denied",
        ))
    }
}
impl gateway_auth::webauthn::WebAuthnCrypto for Host {
    async fn validate_key(
        &self,
        _: &gateway_auth::webauthn::CosePublicKey,
    ) -> Result<(), GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture verifier absent",
            "fixture_verifier_absent",
        ))
    }
    async fn verify_signature(
        &self,
        _: gateway_auth::webauthn::SignatureInput,
    ) -> Result<bool, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture verifier absent",
            "fixture_verifier_absent",
        ))
    }
}

fn golden() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/source-principal-ids-golden.json")).unwrap()
    })
}
fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|unit| unit.as_u64().unwrap() as u16)
        .collect()
}
fn compare(left: &JsString16, right: &JsString16) -> Result<Ordering, GatewayError> {
    let ids = golden()["comparison_ids"].as_array().unwrap();
    let find = |text: &JsString16| ids.iter().position(|id| units(id) == text.as_units());
    let (Some(left), Some(right)) = (find(left), find(right)) else {
        return Err(GatewayError::unavailable(
            "Missing exact source comparison fixture",
            "fixture_collation_missing",
        ));
    };
    let pair = golden()["comparisons"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pair| {
            pair[0].as_u64() == Some(left as u64) && pair[1].as_u64() == Some(right as u64)
        })
        .unwrap();
    Ok(pair[2].as_i64().unwrap().cmp(&0))
}
struct Caps;
impl RuntimeCapabilities for Caps {
    fn compare_admin_labels(
        &self,
        left: &JsString16,
        right: &JsString16,
    ) -> Result<Ordering, GatewayError> {
        compare(left, right)
    }
    async fn metered_diagnostics(&self) -> Result<Value, GatewayError> {
        Ok(json!({"fixture":true}))
    }
}
fn input(body: SourceJson) -> AdminInput {
    AdminInput {
        parameter: None,
        query: BTreeMap::new(),
        body,
        actor: AuthPrincipal {
            token: None,
            method: AuthMethod::AdminAllowlist,
            is_admin: true,
            is_super_admin: false,
        },
        request_id: "fixture".into(),
        now_ms: NOW,
    }
}
fn source(response: &AuthResponse) -> SourceJson {
    SourceJson::parse_bytes(&response.body.to_bytes().unwrap()).unwrap()
}
fn text(value: &SourceJson, name: &str) -> JsString16 {
    input::member(value, name)
        .as_ref()
        .and_then(input::text)
        .unwrap()
}

#[test]
fn source_allowlist_predicate_set_and_order_match_actual_bun() {
    assert_eq!(golden()["bun"], "1.4.0");
    let rows = golden()["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 19);
    for row in rows {
        let value = SourceJson::parse(row["value_json"].as_str().unwrap()).unwrap();
        let parsed = claude_access::parse_source_ids(&value, &compare);
        if row["ids"].is_null() {
            assert_eq!(parsed.unwrap_err().status, 400, "{}", row["name"]);
        } else {
            let expected = row["ids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| JsString16::from_units(units(id)))
                .collect::<Vec<_>>();
            assert_eq!(parsed.unwrap(), expected, "{}", row["name"]);
        }
    }
    let calls = Cell::new(0);
    let failure =
        claude_access::parse_source_ids(&SourceJson::parse(r#"["a","z"]"#).unwrap(), &|_, _| {
            calls.set(calls.get() + 1);
            Err(GatewayError::unavailable(
                "Exact comparator failure",
                "fixture_collation_failed",
            ))
        })
        .unwrap_err();
    assert_eq!(calls.get(), 1);
    assert_eq!(
        failure.envelope.error.code.as_deref(),
        Some("fixture_collation_failed")
    );
}

#[test]
fn named_source_allowlist_retains_units_expiry_fence_and_scalar_principal_domain() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let cfg = RuntimeConfig::default();
        let runtime = AdminRuntime {
            store: &store,
            host: &host,
            capabilities: &Caps,
            config: &cfg,
        };
        let request = SourceJson::parse(
            r#"{"allowed_key_ids":["local-development","\ud800","local-development"]}"#,
        )
        .unwrap();
        let response = runtime
            .execute(AdminOperation::ClaudeAccessSet, input(request))
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        let key = claude_access::policy_key();
        let row = store.read(&key).await.unwrap().unwrap();
        assert_eq!(row.value_encoding, ValueEncoding::ProfileV2);
        let policy = claude_access::decode_policy_record(&row, NOW, &compare)
            .unwrap()
            .unwrap();
        assert!(policy.allows_scalar("local-development"));
        assert!(!policy.allows_scalar("\u{fffd}"));
        assert!(!policy.allows_scalar(""));
        let wire = input::member(&source(&response), "data").unwrap();
        let ids = input::member(&wire, "allowed_key_ids")
            .unwrap()
            .deserialize::<Vec<JsString16>>()
            .unwrap();
        assert_eq!(ids, policy.allowed_key_ids);
        let copied =
            claude_access::encode_policy_record("exact-revision", &policy, Some(NOW + 1)).unwrap();
        assert_eq!(copied.revision, "exact-revision");
        assert_eq!(copied.expires_at_ms, Some(NOW + 1));
        assert!(
            claude_access::decode_policy_record(&copied, NOW + 1, &compare)
                .unwrap()
                .is_none()
        );
        let current = claude_access::load_policy(&store, &host, &[], &compare)
            .await
            .unwrap();
        assert_eq!(current.check.expected_revision, Some(row.revision));
        let scalar=claude_access::parse_source_policy(&SourceJson::parse(r#"{"v":1,"source":"kv","allowed_key_ids":["local-development"],"updated_at_ms":1000000}"#).unwrap(),&compare).unwrap();
        assert_eq!(
            claude_access::encode_policy_record("scalar", &scalar, None)
                .unwrap()
                .value_encoding,
            ValueEncoding::Json
        );
        let previous = store.rows.borrow().clone();
        let mut denied = input(SourceJson::parse(r#"{"allowed_key_ids":["\udc00"]}"#).unwrap());
        denied.actor.is_admin = false;
        assert_eq!(
            runtime
                .execute(AdminOperation::ClaudeAccessSet, denied)
                .await
                .unwrap_err()
                .status,
            401
        );
        assert_eq!(*store.rows.borrow(), previous);
    });
}

#[test]
fn source_claude_submission_preserves_wide_fields_and_original_error_order() {
    let parsed=parse::claude_source(&SourceJson::parse(r#"{"credential":" sk-ant-\ud800 ","label":" \udc00 ","workspace_id":" wrkspc_\ud800 ","ignored":{"\udc00":1e999}}"#).unwrap()).unwrap();
    assert!(parsed.credential.unwrap().try_scalar_secret().is_err());
    assert_eq!(parsed.label.unwrap().as_units(), [0xdc00]);
    assert_eq!(
        parsed.workspace_id.unwrap().unwrap().as_units(),
        [119, 114, 107, 115, 112, 99, 95, 0xd800]
    );
    for (body, message) in [
        (
            r#"{"credential":" ","label":"x"}"#,
            "credential must not be blank",
        ),
        (
            r#"{"credential":"bad","workspace_id":false}"#,
            "credential must be an Anthropic API key or Claude Code OAuth token",
        ),
        (
            r#"{"credential":"sk-ant-x","workspace_id":" "}"#,
            "workspace_id must be a wrkspc_ workspace id",
        ),
        (
            r#"{"workspace_id":null,"account_id":"\ud800","create_new":1}"#,
            "account_id is invalid",
        ),
        (
            r#"{"workspace_id":null,"create_new":1,"activate":1}"#,
            "create_new must be boolean",
        ),
    ] {
        assert_eq!(
            parse::claude_source(&SourceJson::parse(body).unwrap())
                .err()
                .unwrap()
                .envelope
                .error
                .message,
            message
        );
    }
    assert!(
        parse::claude_source(&SourceJson::parse(r#"{"workspace_id":null}"#).unwrap())
            .unwrap()
            .workspace_id
            .unwrap()
            .is_none()
    );
    assert!(
        parse::claude_source(&SourceJson::parse(r#"{"workspace_id":""}"#).unwrap())
            .unwrap()
            .workspace_id
            .unwrap()
            .is_none()
    );
    assert!(
        parse::claude_source(
            &SourceJson::parse(r#"{"credential":"sk-ant-x","label":""}"#).unwrap()
        )
        .unwrap()
        .label
        .unwrap()
        .as_units()
        .is_empty()
    );
}

#[test]
fn defaults_model_effort_source_record_and_reflected_errors_never_scalarize() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let cfg = RuntimeConfig::default();
        let model = ModelId::from_source(JsString16::from_units(vec![109, 0xd800]));
        let row = input::object(vec![
            ("slug", input::json(&model)),
            ("default_reasoning_level", input::json("none")),
            ("supported_reasoning_levels", input::json(&vec!["none"])),
        ]);
        let snapshot = gateway_schema::snapshot::ModelSnapshot {
            models: vec![row],
            source: "fixture".into(),
            updated_at_ms: NOW,
            client_version: None,
        };
        let runtime_doc = gateway_schema::runtime_config::build_runtime_config(
            &snapshot,
            Some(&model),
            Some(&JsString16::from_utf8("none")),
            NOW,
        )
        .unwrap();
        let key = gateway_schema::catalog_store::runtime_config_key();
        store.rows.borrow_mut().insert(
            key.0.clone(),
            encode_source_control_record("initial", &runtime_doc, None).unwrap(),
        );
        let runtime = AdminRuntime {
            store: &store,
            host: &host,
            capabilities: &Caps,
            config: &cfg,
        };
        let effort = JsString16::from_units(vec![102, 0xdc00]);
        let response = runtime
            .execute(
                AdminOperation::DefaultsSet,
                input(input::object(vec![
                    ("model", input::json(&model)),
                    ("reasoning_effort", input::json(&effort)),
                ])),
            )
            .await
            .unwrap();
        let defaults = input::member(&source(&response), "defaults").unwrap();
        assert_eq!(text(&defaults, "model"), *model.as_js_string());
        assert_eq!(text(&defaults, "reasoning_effort"), effort);
        let row = store.read(&key).await.unwrap().unwrap();
        assert_eq!(row.value_encoding, ValueEncoding::ProfileV2);
        let stored = decode_source_control_record(&row).unwrap();
        assert_eq!(
            gateway_schema::runtime_config::default_model(&stored),
            Some(model)
        );
        assert_eq!(
            gateway_schema::runtime_config::default_reasoning_effort(&stored),
            Some(effort)
        );
        let before = store.rows.borrow().clone();
        let response = runtime
            .execute(
                AdminOperation::DefaultsSet,
                input(SourceJson::parse(r#"{"\ud800":1}"#).unwrap()),
            )
            .await
            .unwrap();
        assert_eq!(response.status, 400);
        let error = input::member(&source(&response), "error").unwrap();
        assert_eq!(text(&error, "message").as_units().last(), Some(&0xd800));
        assert_eq!(*store.rows.borrow(), before);
        let response = runtime
            .execute(
                AdminOperation::ProviderSelectionSet,
                input(SourceJson::parse(r#"{"provider_ids":["\udc00"]}"#).unwrap()),
            )
            .await
            .unwrap();
        assert_eq!(response.status, 400);
        let error = input::member(&source(&response), "error").unwrap();
        assert_eq!(text(&error, "message").as_units().last(), Some(&0xdc00));
        assert_eq!(*store.rows.borrow(), before);
    });
}

// Typed forwarding probe only. Status/phase expectations come from the actual
// extracted Bun handler with controlled lookup/clear dependencies; actual
// Worker guard clearing and its lookup policy remain M05 acceptance.
struct ClearProbe {
    seen: RefCell<Vec<Option<SourceJson>>>,
    status: u16,
}
impl RuntimeCapabilities for ClearProbe {
    async fn claude(
        &self,
        request: gateway_admin_runtime::capabilities::ClaudeRequest,
        _: gateway_admin_runtime::capabilities::Context,
    ) -> Result<AuthResponse, GatewayError> {
        let gateway_admin_runtime::capabilities::ClaudeRequest::ClearQuota { cohort_id, .. } =
            request
        else {
            return Err(GatewayError::unavailable(
                "Unexpected probe request",
                "fixture_request_invalid",
            ));
        };
        self.seen.borrow_mut().push(cohort_id);
        Ok(AuthResponse::json(
            self.status,
            json!({"fixture":"typed forwarding only"}),
        ))
    }
}
#[test]
fn clear_quota_named_leaf_preserves_source_presence_before_owner_lookup() {
    // Actual source oracle SHA256 5f03ce1a68bd7982447200bdd76e20f3cd64cb15c90d021a717641a0d2337edb.
    let cases: [(&str, &str, Option<&str>, u16); 10] = [
        ("absent", "{}", None, 200),
        (
            "present-null",
            "{\"account_cohort_id\":null}",
            Some("null"),
            409,
        ),
        (
            "present-number",
            "{\"account_cohort_id\":3}",
            Some("3"),
            409,
        ),
        (
            "present-current",
            "{\"account_cohort_id\":\"00000000-0000-4000-8000-000000000002\"}",
            Some("\"00000000-0000-4000-8000-000000000002\""),
            200,
        ),
        (
            "target-missing-cohort",
            "{\"account_id\":\"00000000-0000-4000-8000-000000000001\"}",
            None,
            400,
        ),
        (
            "target-null-cohort",
            "{\"account_id\":\"00000000-0000-4000-8000-000000000001\",\"account_cohort_id\":null}",
            Some("null"),
            400,
        ),
        (
            "target-current",
            "{\"account_id\":\"00000000-0000-4000-8000-000000000001\",\"account_cohort_id\":\"00000000-0000-4000-8000-000000000002\"}",
            Some("\"00000000-0000-4000-8000-000000000002\""),
            200,
        ),
        (
            "unknown-before-required",
            "{\"account_id\":\"00000000-0000-4000-8000-000000000099\"}",
            None,
            404,
        ),
        (
            "opaque-cohort",
            "{\"account_cohort_id\":\"\\ud800\"}",
            Some("\"\\ud800\""),
            409,
        ),
        (
            "no-active-null",
            "{\"account_cohort_id\":null}",
            Some("null"),
            200,
        ),
    ];
    for (name, body, cohort, status) in cases {
        run(async {
            let store = Store::default();
            let host = Host::default();
            let config = RuntimeConfig::default();
            let probe = ClearProbe {
                seen: RefCell::new(Vec::new()),
                status,
            };
            let runtime = AdminRuntime {
                store: &store,
                host: &host,
                capabilities: &probe,
                config: &config,
            };
            let response = runtime
                .execute(
                    AdminOperation::ClaudeQuotaClear,
                    input(SourceJson::parse(body).unwrap()),
                )
                .await
                .unwrap();
            assert_eq!(response.status, status, "{name}");
            let seen = probe.seen.borrow();
            assert_eq!(seen.len(), 1, "{name}: no early cohort refusal");
            assert_eq!(
                seen[0],
                cohort.map(|value| SourceJson::parse(value).unwrap()),
                "{name}: original named leaf"
            );
            assert!(store.rows.borrow().is_empty());
        });
    }
}
