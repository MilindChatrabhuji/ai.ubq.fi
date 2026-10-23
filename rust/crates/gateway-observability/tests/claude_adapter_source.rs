//! Only the exact request-bound SourceJson and finite settings-selector adapters.
mod support;
use gateway_admin_runtime::capabilities::{CodexRequest, Context, ProviderRequest};
use gateway_auth::crypto::sha256_hex;
use gateway_core::{
    GatewayError,
    query::{QueryPage, QueryRequest, QueryStore},
    source_json::SourceJson,
    state::{AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, StoredRecord},
};
use gateway_observability::{
    ObservabilityRuntime,
    capacity_shapes::{history_point, unavailable_snapshot},
    host_types::CapacityAccountRef,
    types::ObservabilityHost,
};
use serde_json::json;
use std::{cell::RefCell, rc::Rc};
use support::{Host, Memory, run};
const AT: i64 = 7_200_000;
fn context() -> Context {
    Context {
        request_id: "source-adapter-request".into(),
        now_ms: AT,
    }
}
struct AdapterHost {
    base: Host,
    raw: Vec<u8>,
}
impl ObservabilityHost for AdapterHost {
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
    async fn capacity_observation_body(&self, context: &Context) -> Result<Vec<u8>, GatewayError> {
        assert_eq!(context.request_id, "source-adapter-request");
        Ok(self.raw.clone())
    }
    async fn codex_capacity_accounts(&self) -> Result<Vec<CapacityAccountRef>, GatewayError> {
        Ok(vec![CapacityAccountRef {
            slot: 1,
            account_id: "fixture-account".into(),
            label: None,
        }])
    }
}
fn host(raw: Vec<u8>) -> AdapterHost {
    let base = Host::default();
    base.at.set(AT);
    AdapterHost { base, raw }
}
fn document(text: &str) -> SourceJson {
    SourceJson::parse(text).unwrap()
}
#[test]
fn request_bound_comparison_uses_authoritative_source_utf8_single_bom_and_original_raw_bytes() {
    let scalar = SourceJson::from_serializable(
        &json!({"host":"neighbour","history":[history_point(&unavailable_snapshot(AT))]}),
    )
    .unwrap();
    for raw in [
        scalar.as_bytes().to_vec(),
        format!("  {} \n", scalar.as_str()).into_bytes(),
    ] {
        let source = SourceJson::parse_bytes(&raw).unwrap();
        let memory = Memory::default();
        let runtime = ObservabilityRuntime::new(memory.clone(), host(raw));
        let response = run(runtime.provider(
            ProviderRequest::Observations { document: source },
            context(),
        ))
        .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body.as_json().unwrap()["accepted"], 1);
        assert_eq!(memory.commits.get(), 1);
    }
    let invalid_envelope = "Invalid capacity observation envelope";
    let mismatch = "Capacity observations do not match the request-bound body";
    let mut bom = vec![0xef, 0xbb, 0xbf];
    bom.extend_from_slice(scalar.as_bytes());
    let mut double_bom = vec![0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf];
    double_bom.extend_from_slice(scalar.as_bytes());
    let cases = vec![
        (bom, scalar.clone(), invalid_envelope),
        (double_bom, scalar, mismatch),
        (
            b"{\"host\":\"neighbour\",\"history\":[],\"extra\":\"\xff\"}".to_vec(),
            document(r#"{"host":"neighbour","history":[],"extra":"�"}"#),
            invalid_envelope,
        ),
        (
            br#"{"host":"neighbour","history":[],"extra":"\ud800"}"#.to_vec(),
            document(r#"{"host":"neighbour","history":[],"extra":"\ud800"}"#),
            invalid_envelope,
        ),
        (
            br#"{"host":"neighbour","history":[],"extra":"\ud800"}"#.to_vec(),
            document(r#"{"host":"neighbour","history":[],"extra":"�"}"#),
            mismatch,
        ),
        (
            b"{\"host\":".to_vec(),
            document(r#"{"host":"neighbour"}"#),
            mismatch,
        ),
    ];
    for (raw, source, message) in cases {
        let memory = Memory::default();
        let runtime = ObservabilityRuntime::new(memory.clone(), host(raw));
        let error = run(runtime.provider(
            ProviderRequest::Observations { document: source },
            context(),
        ))
        .unwrap_err();
        assert_eq!(error.status, 400);
        assert_eq!(error.envelope.error.message, message);
        assert_eq!(memory.commits.get(), 0);
    }
}
fn settings(overage: bool, source: SourceJson) -> CodexRequest {
    if overage {
        CodexRequest::SetOverageSettings { document: source }
    } else {
        CodexRequest::SetResetSettings { document: source }
    }
}
#[test]
fn settings_source_selector_types_and_boolean_validation_precede_identity_mismatch() {
    for overage in [false, true] {
        let field = if overage { "allow" } else { "enabled" };
        let cases = [
            ("{}", 400),
            ("[]", 400),
            (r#"{"account_id_hash":null,"FLAG":true}"#, 400),
            (r#"{"account_id_hash":3,"FLAG":true}"#, 400),
            (r#"{"account_id_hash":false,"FLAG":true}"#, 400),
            (r#"{"account_id_hash":"\ud800","FLAG":"true"}"#, 400),
            (r#"{"account_id_hash":"\ud800"}"#, 400),
            (r#"{"account_id_hash":"\ud800","FLAG":true}"#, 409),
            (r#"{"account_id_hash":"\udc00","FLAG":false}"#, 409),
            (r#"{"account_id_hash":"�","FLAG":true}"#, 409),
            (r#"{"account_id_hash":"","FLAG":true}"#, 409),
            (r#"{"account_id_hash":"retired","FLAG":true}"#, 409),
        ];
        for (raw, status) in cases {
            let memory = Memory::default();
            let runtime = ObservabilityRuntime::new(memory.clone(), host(vec![]));
            let error = run(runtime.codex(
                settings(overage, document(&raw.replace("FLAG", field))),
                context(),
            ))
            .unwrap_err();
            assert_eq!(error.status, status, "{raw}");
            if status == 409 {
                assert_eq!(
                    error.envelope.error.message,
                    "Subscription changed. Reload Providers."
                );
            } else {
                assert_eq!(
                    error.envelope.error.message,
                    format!("account_id_hash and boolean {field} are required")
                );
            }
            assert_eq!(memory.commits.get(), 0);
            assert!(memory.rows.borrow().is_empty());
        }
    }
}
#[derive(Clone, Default)]
struct AuditMemory {
    inner: Memory,
    transitions: Rc<RefCell<Vec<AtomicTransition>>>,
}
impl AuthorityStore for AuditMemory {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.inner.read(key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        self.transitions.borrow_mut().push(transition.clone());
        self.inner.commit(transition).await
    }
}
impl QueryStore for AuditMemory {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        self.inner.query(request).await
    }
}
#[test]
fn only_matched_existing_ascii_hash_enters_unchanged_boolean_keys_no_checks_and_response() {
    let hash = sha256_hex(b"fixture-account");
    for overage in [false, true] {
        let field = if overage { "allow" } else { "enabled" };
        let memory = AuditMemory::default();
        let runtime = ObservabilityRuntime::new(memory.clone(), host(vec![]));
        let key = if overage {
            gateway_authority::keys::overage(&hash)
        } else {
            gateway_authority::keys::reset_usage(&hash)
        };
        for flag in [true, false] {
            let quoted = serde_json::to_string(&hash).unwrap();
            let first = hash.as_bytes()[0];
            let escaped = format!("\"\\u{first:04x}{}\"", &hash[1..]);
            let raw =
                format!(r#"{{"account_id_hash":{escaped},"{field}":{flag},"ignored":"\ud800"}}"#);
            assert_ne!(escaped, quoted);
            let response =
                run(runtime.codex(settings(overage, document(&raw)), context())).unwrap();
            assert_eq!(response.status, 200);
            assert_eq!(
                response.body.as_json().unwrap(),
                &json!({"account_id_hash":hash,field:flag})
            );
            let rows = memory.inner.rows.borrow();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[&key.0].json_value().unwrap(), &json!({field:flag}));
            assert_eq!(rows[&key.0].expires_at_ms, None);
        }
        assert_eq!(memory.transitions.borrow().len(), 2);
        for transition in memory.transitions.borrow().iter() {
            assert!(transition.checks.is_empty());
            assert_eq!(transition.mutations.len(), 1);
        }
        let body = if overage {
            run(runtime.overage_settings_response(None))
        } else {
            run(runtime.reset_settings_response(None))
        }
        .unwrap();
        assert_eq!(body.status, 200);
        assert_eq!(body.body.as_json().unwrap()["data"][0][field], false);
    }
}
