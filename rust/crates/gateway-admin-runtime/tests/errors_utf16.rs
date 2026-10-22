use gateway_admin::{AdminHost, AdminInput, AdminOperation};
use gateway_admin_runtime::{
    AdminRuntime, RuntimeConfig,
    capabilities::{Context, ErrorDiagnostics, RuntimeCapabilities},
};
use gateway_auth::{AuthHost, AuthMethod, AuthPrincipal, upstream::*, webauthn::*};
use gateway_core::{
    GatewayError, js_string::JsString16, query::*, source_json::SourceJson, state::*,
    tuple_key::TupleKey, value::PortableValue,
};
use serde_json::{Value, json};
use std::{
    cell::Cell,
    collections::BTreeMap,
    future::Future,
    task::{Context as TaskContext, Poll, Waker},
};
fn run<F: Future>(future: F) -> F::Output {
    let mut context = TaskContext::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(result) = future.as_mut().poll(&mut context) {
            return result;
        }
        std::thread::yield_now();
    }
}
#[derive(Default)]
struct Store {
    rows: BTreeMap<String, StoredRecord>,
    queries: Cell<usize>,
}
impl Store {
    fn put(&mut self, time: i64, id: &str, record: StoredRecord) {
        self.rows.insert(
            gateway_auth::store::key(json!(["uos_ai", "admin_error_log", "v1", time, id])).0,
            record,
        );
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.rows.get(&key.0).cloned())
    }
    async fn commit(&self, _: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        panic!("Error reader must not write")
    }
}
impl QueryStore for Store {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        self.queries.set(self.queries.get() + 1);
        let validated = request.validate()?;
        let mut rows = Vec::new();
        for (key, record) in &self.rows {
            let key = RecordKey(key.clone());
            if validated.accepts_record(&key, record)? {
                rows.push(QueryEntry {
                    key,
                    record: record.clone(),
                });
            }
        }
        rows.sort_by_key(|row| TupleKey::from_record_key(&row.key).unwrap());
        if request.reverse {
            rows.reverse();
        }
        let more = rows.len() > request.limit as usize;
        rows.truncate(request.limit as usize);
        let next_cursor = if more {
            Some(validated.cursor_after(&rows.last().unwrap().key)?)
        } else {
            None
        };
        Ok(QueryPage {
            entries: rows,
            next_cursor,
        })
    }
}
struct Host;
impl WebAuthnCrypto for Host {
    async fn validate_key(&self, _: &CosePublicKey) -> Result<(), GatewayError> {
        panic!("No crypto in error history")
    }
    async fn verify_signature(&self, _: SignatureInput) -> Result<bool, GatewayError> {
        panic!("No crypto in error history")
    }
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        1_000_000
    }
    fn random_bytes(&self, _: usize) -> Result<Vec<u8>, GatewayError> {
        panic!("Error history is read only")
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        panic!("No network in error history")
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        panic!("No kernel in error history")
    }
}
#[derive(Default)]
struct Capabilities(Cell<usize>);
impl RuntimeCapabilities for Capabilities {
    async fn error_diagnostics(&self, _: Context) -> Result<ErrorDiagnostics, GatewayError> {
        self.0.set(self.0.get() + 1);
        Ok(ErrorDiagnostics {
            retention: json!({"state":"unavailable","scope":"capture_owned_kv_payload"}),
            log_files: json!({"scope":"host_text_logs","total_bytes":null}),
        })
    }
}
fn input(admin: bool) -> AdminInput {
    AdminInput {
        parameter: None,
        query: BTreeMap::from([("limit".into(), vec!["1".into()])]),
        body: SourceJson::from_serializable(&Value::Null).unwrap(),
        actor: AuthPrincipal {
            token: None,
            method: AuthMethod::AdminAllowlist,
            is_admin: admin,
            is_super_admin: false,
        },
        request_id: "error-reader-fixture".into(),
        now_ms: 1_000_000,
    }
}
fn row(time: i64, id: &str) -> Value {
    json!({"version":1,"request_id":id,"route":"responses","status":503,"provider":"deepseek","model":null,"reasoning":null,"stream":true,"terminal_type":"error","failure_kind":"http_503","delivery_outcome":"interrupted","created_at_ms":time,"latency_ms":3,"git_sha":null,"deno_revision":null})
}
fn field(value: &SourceJson, name: &str) -> SourceJson {
    value
        .object_entries()
        .unwrap()
        .into_iter()
        .rev()
        .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
        .unwrap()
        .1
}
#[test]
fn error_history_preserves_utf16_filter_order_buckets_expiry_and_diagnostics() {
    let mut store = Store::default();
    store.put(
        900001,
        "older",
        StoredRecord::json("older", row(900001, "older"), Some(2_000_000)),
    );
    let mut raw = PortableValue::from_json(&row(900002, "raw"));
    let PortableValue::Object(fields) = &mut raw else {
        panic!("fixture object")
    };
    fields
        .iter_mut()
        .find(|(key, _)| key == "failure_kind")
        .unwrap()
        .1 = PortableValue::StringUtf16(JsString16::from_units(vec![0xd83d]));
    fields.push((
        "extra".into(),
        PortableValue::ObjectUtf16(vec![(
            JsString16::from_units(vec![0xd83d]),
            PortableValue::StringUtf16(JsString16::from_units(vec![0xde00])),
        )]),
    ));
    store.put(
        900002,
        "raw",
        StoredRecord::profile_v2("raw", raw, Some(2_000_000)).unwrap(),
    );
    let mut legacy = row(900003, "legacy");
    legacy["status"] = json!(200);
    legacy["failure_kind"] = json!("missing_sse_terminal");
    legacy["git_sha"] = json!("4d2928f47f3ba3ad66b8c15e6323bcccd0a39390");
    store.put(900003, "legacy", StoredRecord::json("legacy", legacy, None));
    store.put(
        900004,
        "expired",
        StoredRecord::json("expired", row(900004, "expired"), Some(999999)),
    );
    store.put(
        900005,
        "malformed",
        StoredRecord::json("malformed", json!({"version":1,"status":503}), None),
    );
    let host = Host;
    let capabilities = Capabilities::default();
    let config = RuntimeConfig::default();
    let runtime = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &capabilities,
        config: &config,
    };
    let response = run(runtime.execute(AdminOperation::Errors, input(true))).unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.headers["cache-control"], "no-store");
    let body = SourceJson::parse_bytes(&response.body.to_bytes().unwrap()).unwrap();
    let data = field(&body, "data").array_items().unwrap();
    assert_eq!(data.len(), 1);
    assert_eq!(
        field(&data[0], "request_id")
            .deserialize::<String>()
            .unwrap(),
        "raw"
    );
    assert_eq!(
        field(&data[0], "failure_kind")
            .deserialize::<JsString16>()
            .unwrap()
            .as_units(),
        &[0xd83d]
    );
    let extra = field(&data[0], "extra").object_entries().unwrap();
    assert_eq!(extra[0].0.as_units(), &[0xd83d]);
    assert_eq!(
        extra[0].1.deserialize::<JsString16>().unwrap().as_units(),
        &[0xde00]
    );
    let buckets: Value = field(&body, "five_xx_buckets").deserialize().unwrap();
    assert_eq!(buckets, json!([{"bucket_start_at_ms":900000,"count":2}]));
    assert_eq!(
        field(&body, "retention").deserialize::<Value>().unwrap()["scope"],
        "capture_owned_kv_payload"
    );
    assert_eq!(
        field(&body, "log_files").deserialize::<Value>().unwrap()["total_bytes"],
        Value::Null
    );
    assert_eq!(store.queries.get(), 1);
    assert_eq!(capabilities.0.get(), 1);
}
#[test]
fn unauthorized_and_invalid_limit_keep_zero_query_budget() {
    let store = Store::default();
    let host = Host;
    let capabilities = Capabilities::default();
    let config = RuntimeConfig::default();
    let runtime = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &capabilities,
        config: &config,
    };
    assert_eq!(
        run(runtime.execute(AdminOperation::Errors, input(false)))
            .unwrap_err()
            .status,
        401
    );
    let mut request = input(true);
    request.query.insert("limit".into(), vec!["0".into()]);
    assert_eq!(
        run(runtime.execute(AdminOperation::Errors, request))
            .unwrap_err()
            .status,
        400
    );
    assert_eq!(store.queries.get(), 0);
    assert_eq!(capabilities.0.get(), 0);
}
#[test]
fn error_history_never_reinterprets_profile_v1_as_json() {
    let mut store = Store::default();
    store.put(
        900000,
        "wrong-codec",
        StoredRecord::profile(
            "wrong-codec",
            PortableValue::from_json(&row(900000, "wrong-codec")),
            None,
        )
        .unwrap(),
    );
    let host = Host;
    let capabilities = Capabilities::default();
    let config = RuntimeConfig::default();
    let runtime = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &capabilities,
        config: &config,
    };
    assert_eq!(
        run(runtime.execute(AdminOperation::Errors, input(true)))
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("incompatible_value_encoding")
    );
    assert_eq!(capabilities.0.get(), 0);
}
