mod support;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    query::{QueryPage, QueryRequest, QueryStore},
    source_json::SourceJson,
    source_serialization as source,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
    tuple_key::{DecodedKeyPart, TupleKey},
};
use gateway_observability::{
    ObservabilityRuntime,
    host_types::BuildIdentity,
    replay_crypto::{ReplayBody, ReplayKey},
    replay_producer::{
        ClientFailureObservation, FailureObservation, PersistResult, ReplayInput, ReplayRequest,
    },
    replay_retention_schema::RetentionLimits,
    replay_trace::UpstreamTrace,
    types::ObservabilityHost,
};
use serde_json::Value;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
};
use support::{Host, Memory, run};
#[derive(Clone)]
struct CaptureHost {
    clock: Host,
    revision: Rc<RefCell<String>>,
}
impl ObservabilityHost for CaptureHost {
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        self.clock.source_string_collator()
    }
    fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }
    fn random_bytes(&self, n: usize) -> Result<Vec<u8>, GatewayError> {
        self.clock.random_bytes(n)
    }
    fn compare_labels(&self, a: &str, b: &str) -> Result<std::cmp::Ordering, GatewayError> {
        Ok(a.cmp(b))
    }
    async fn wait_ms(&self, n: u32) -> Result<(), GatewayError> {
        self.clock.wait_ms(n).await
    }
    fn build_identity(&self) -> Result<BuildIdentity, GatewayError> {
        Ok(BuildIdentity {
            git_sha: self.revision.borrow().clone(),
            deployment_id: format!("fixture-{}", self.revision.borrow()),
        })
    }
}
fn host() -> CaptureHost {
    let clock = Host::default();
    clock.at.set(1000);
    CaptureHost {
        clock,
        revision: Rc::new(RefCell::new("a".repeat(40))),
    }
}
fn input(host: &CaptureHost, id: &str, bytes: Vec<u8>) -> ReplayInput {
    ReplayInput::new(
        host,
        ReplayRequest {
            endpoint: "/v1/responses?source=fixture".into(),
            method: "POST".into(),
            body: ReplayBody::from_vec(bytes),
            content_type: Some(" application/json ".into()),
            headers: BTreeMap::from([
                ("Authorization".into(), "must-never-be-captured".into()),
                ("x-secret".into(), "private".into()),
                ("openai-beta".into(), " responses=v2 ".into()),
            ]),
            request_id: id.into(),
            upstream: UpstreamTrace::empty(),
        },
    )
    .unwrap()
}
fn failure() -> FailureObservation {
    FailureObservation {
        status: 502,
        stream: Some(false),
        completed: false,
        terminal_type: Some("http.error".into()),
        failure_kind: Some("upstream_error".into()),
        synthetic_terminal_type: None,
        provider_route: "deepseek".into(),
    }
}
fn client(failure: &FailureObservation) -> ClientFailureObservation {
    let mut client = ClientFailureObservation::from_internal(failure);
    client.observed_body(br#"{"error":{"code":"upstream_error"}}"#);
    client
}
fn ready<S: QueryStore>(runtime: &ObservabilityRuntime<S, CaptureHost>, limits: RetentionLimits) {
    for attempt in 0..20 {
        let status = run(runtime.maintain_replays(limits)).unwrap_or_else(|error| {
            let budget = run(runtime
                .store()
                .read(&gateway_observability::replay_model::key("budget")))
            .unwrap();
            panic!(
                "maintenance pass {attempt}: {error:?}; budget encoding {:?}",
                budget.map(|row| row.value_encoding)
            )
        });
        if status["accounting_complete"] == true {
            return;
        }
    }
    panic!("bootstrap did not finish its bounded passes")
}
fn key() -> ReplayKey {
    ReplayKey::decode(&URL_SAFE_NO_PAD.encode([7; 32])).unwrap()
}
fn body() -> Vec<u8> {
    br#"{"model":"model-fixture","reasoning":{"effort":"max"},"stream":false,"unknown":"\ud800"}"#
        .to_vec()
}
#[test]
fn actual_ciphertext_publication_exports_decrypts_and_duplicate_keeps_the_original_build() {
    let store = Memory::default();
    let host = host();
    let runtime = ObservabilityRuntime::new(store.clone(), host.clone());
    let limits = RetentionLimits::for_fixture(16 * 1024 * 1024);
    ready(&runtime, limits);
    let key = key();
    let f = failure();
    let first = run(runtime.persist_failure_with_limits(
        input(&host, "one", body()),
        f.clone(),
        client(&f),
        Some(&key),
        limits,
    ))
    .unwrap();
    let PersistResult::Stored {
        manifest,
        manifest_key,
    } = first
    else {
        panic!("stored capture")
    };
    let response = run(runtime.export_capture_request("one")).unwrap();
    let exported: Value = serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap();
    let mut encrypted = Vec::new();
    for chunk in exported["data"][0]["chunks"].as_array().unwrap() {
        encrypted.extend(URL_SAFE_NO_PAD.decode(chunk.as_str().unwrap()).unwrap());
    }
    let iv: [u8; 12] = URL_SAFE_NO_PAD
        .decode(&manifest.iv)
        .unwrap()
        .try_into()
        .unwrap();
    let plain = key.decrypt(&iv, &manifest.fingerprint, &encrypted).unwrap();
    let length = u32::from_be_bytes(plain[..4].try_into().unwrap()) as usize;
    let metadata: Value = serde_json::from_slice(&plain[4..4 + length]).unwrap();
    assert_eq!(&plain[4 + length..], body());
    assert_eq!(metadata["settings"]["model_requested"], "model-fixture");
    assert_eq!(metadata["capture_status"], "incomplete");
    assert_eq!(metadata["replay_coverage"], "unavailable");
    assert!(
        metadata["compatibility_headers"]
            .get("Authorization")
            .is_none()
    );
    assert!(
        !std::str::from_utf8(&plain[4..4 + length])
            .unwrap()
            .contains("must-never-be-captured")
    );
    assert_eq!(metadata["git_sha"], "a".repeat(40));
    *host.revision.borrow_mut() = "b".repeat(40);
    host.clock.at.set(2000);
    let duplicate = run(runtime.persist_failure_with_limits(
        input(&host, "two", body()),
        f.clone(),
        client(&f),
        Some(&key),
        limits,
    ))
    .unwrap();
    let PersistResult::Duplicate {
        manifest_key: winning,
        ..
    } = duplicate
    else {
        panic!("duplicate")
    };
    assert_eq!(winning, manifest_key);
    let response = run(runtime.export_capture_request("two")).unwrap();
    let exported: Value = serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap();
    assert_eq!(exported["capture_status"]["captured_at_ms"], 1000.0);
    assert_eq!(
        exported["capture_status"]["expires_at_ms"],
        manifest.expires_at_ms
    );
    let incidents = run(runtime.list_incidents(None, None, 20)).unwrap();
    let incidents: Value = serde_json::from_slice(&incidents.body.to_bytes().unwrap()).unwrap();
    assert_eq!(incidents["data"][0]["failing_revision"], "a".repeat(40));
    assert_eq!(incidents["data"][0]["latest"]["revision"], "b".repeat(40));
    let retention = run(runtime.replay_retention_status(limits));
    assert_eq!(retention["records"], 1.0);
    assert_eq!(retention["reserved_bytes"], 0.0);
    host.clock
        .at
        .set(1001 + gateway_observability::replay_model::PAYLOAD_TTL);
    run(runtime.maintain_replays(limits)).unwrap();
    run(runtime.maintain_replays(limits)).unwrap();
    let retention = run(runtime.replay_retention_status(limits));
    assert_eq!(retention["stored_bytes"], 0.0);
    assert_eq!(retention["records"], 0.0);
    assert_eq!(retention["expired_records"], 1.0);
    assert_eq!(retention["evicted_records"], 0.0);
}
#[derive(Clone)]
struct FaultStore {
    memory: Memory,
    stage: Rc<Cell<bool>>,
    delete: Rc<Cell<bool>>,
}
impl AuthorityStore for FaultStore {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.memory.read(key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        for mutation in &transition.mutations {
            let key = match mutation {
                RecordMutation::Put { key, .. } | RecordMutation::Delete { key } => key,
            };
            let parts = TupleKey::from_record_key(key)?.decoded_parts()?;
            let chunk = matches!(parts.get(3),Some(DecodedKeyPart::String(v))if v==b"chunk");
            if chunk {
                if let RecordMutation::Put { .. } = mutation
                    && matches!(parts.get(5),Some(DecodedKeyPart::Number(n))if *n>=12.0)
                    && self.stage.replace(false)
                {
                    return Err(GatewayError::unavailable(
                        "fixture stage failure",
                        "fixture_stage_failure",
                    ));
                }
                if let RecordMutation::Delete { .. } = mutation
                    && self.delete.replace(false)
                {
                    return Err(GatewayError::unavailable(
                        "fixture cleanup failure",
                        "fixture_cleanup_failure",
                    ));
                }
            }
        }
        self.memory.commit(transition).await
    }
}
impl QueryStore for FaultStore {
    async fn query(&self, q: QueryRequest) -> Result<QueryPage, GatewayError> {
        self.memory.query(q).await
    }
}
#[test]
fn interrupted_multibatch_staging_keeps_charge_until_restart_proves_all_chunks_gone() {
    let memory = Memory::default();
    let store = FaultStore {
        memory: memory.clone(),
        stage: Rc::new(Cell::new(true)),
        delete: Rc::new(Cell::new(true)),
    };
    let host = host();
    let runtime = ObservabilityRuntime::new(store.clone(), host.clone());
    let limits = RetentionLimits::for_fixture(16 * 1024 * 1024);
    ready(&runtime, limits);
    let mut random = 0x123456789abcdef_u64;
    let mut text = String::from("{\"padding\":\"");
    for _ in 0..1_100_000 {
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        let mut ch = 33 + (random % 90) as u8;
        if ch == b'"' || ch == b'\\' {
            ch = b'~'
        }
        text.push(char::from(ch));
    }
    text.push_str("\"}");
    let f = failure();
    let result = run(runtime.persist_failure_with_limits(
        input(&host, "staging", text.into_bytes()),
        f.clone(),
        client(&f),
        Some(&key()),
        limits,
    ));
    assert!(result.is_err());
    let status = run(runtime.replay_retention_status(limits));
    assert!(status["reserved_bytes"].as_f64().unwrap() > 0.0);
    assert_eq!(status["records"], 0.0);
    drop(runtime);
    let restarted = ObservabilityRuntime::new(store, host);
    run(restarted.maintain_replays(limits)).unwrap();
    let status = run(restarted.replay_retention_status(limits));
    assert_eq!(status["reserved_bytes"], 0.0);
    assert_eq!(status["stored_bytes"], 0.0);
    assert!(!memory.rows.borrow().keys().any(|key| {
        TupleKey::from_record_key(&RecordKey(key.clone()))
            .unwrap()
            .decoded_parts()
            .unwrap()
            .get(3)
            .is_some_and(|part| matches!(part,DecodedKeyPart::String(v)if v==b"chunk"))
    }));
}
#[test]
fn success_and_cancelled_transport_never_write_capture_or_incident_rows() {
    let store = Memory::default();
    let host = host();
    let runtime = ObservabilityRuntime::new(store.clone(), host.clone());
    let mut f = failure();
    f.status = 200;
    f.completed = true;
    f.terminal_type = Some("response.completed".into());
    f.failure_kind = None;
    assert!(
        run(runtime.persist_failure(
            input(&host, "success", body()),
            f.clone(),
            client(&f),
            Some(&key())
        ))
        .is_err()
    );
    f.status = 502;
    f.completed = false;
    f.terminal_type = Some("cancelled".into());
    assert!(
        run(runtime.persist_failure(
            input(&host, "cancelled", body()),
            f.clone(),
            client(&f),
            Some(&key())
        ))
        .is_err()
    );
    assert_eq!(store.reads.get(), 0);
    assert_eq!(store.commits.get(), 0);
}

#[test]
fn raw_error_param_retains_units_but_stored_ascii_policy_and_body_evidence_are_unchanged() {
    let cases = [
        (JsString16::from_utf8("input[0].content"), true),
        (JsString16::from_utf8("a_.:-[]"), true),
        (JsString16::from_units(vec![97; 128]), true),
        (JsString16::from_units(vec![97; 129]), false),
        (JsString16::from_units(vec![105, 0xd800]), false),
        (JsString16::from_utf8("é"), false),
        (JsString16::from_utf8("input value"), false),
        (JsString16::from_utf8("input/value"), false),
        (JsString16::from_utf8(""), false),
    ];
    for (param, allowed) in cases {
        let store = Memory::default();
        let host = host();
        let runtime = ObservabilityRuntime::new(store, host.clone());
        let limits = RetentionLimits::for_fixture(16 * 1024 * 1024);
        ready(&runtime, limits);
        let key = key();
        let failure = failure();
        let mut client = ClientFailureObservation::from_internal(&failure);
        client.error_param = Some(param.clone());
        let raw = SourceJson::from_serializable(&client).unwrap();
        let observed: JsString16 = source::member(&raw, "error_param")
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(observed, param);
        let terminal = source::object(vec![(
            "error",
            source::object(vec![("param", param.to_source_json().unwrap())]).unwrap(),
        )])
        .unwrap();
        client.observed_body(terminal.as_bytes());
        let result = run(runtime.persist_failure_with_limits(
            input(&host, "param", body()),
            failure,
            client,
            Some(&key),
            limits,
        ))
        .unwrap();
        let PersistResult::Stored { manifest, .. } = result else {
            panic!("stored parameter fixture")
        };
        let response = run(runtime.export_capture_request("param")).unwrap();
        let exported: Value = serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap();
        let mut encrypted = Vec::new();
        for chunk in exported["data"][0]["chunks"].as_array().unwrap() {
            encrypted.extend(URL_SAFE_NO_PAD.decode(chunk.as_str().unwrap()).unwrap());
        }
        let iv: [u8; 12] = URL_SAFE_NO_PAD
            .decode(&manifest.iv)
            .unwrap()
            .try_into()
            .unwrap();
        let plain = key.decrypt(&iv, &manifest.fingerprint, &encrypted).unwrap();
        let length = u32::from_be_bytes(plain[..4].try_into().unwrap()) as usize;
        let metadata =
            SourceJson::parse(std::str::from_utf8(&plain[4..4 + length]).unwrap()).unwrap();
        let client = source::member(&metadata, "client_observation").unwrap();
        let stored: Option<JsString16> = source::member(&client, "error_param")
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(stored, allowed.then_some(param));
        let downstream = source::member(&metadata, "downstream").unwrap();
        let downstream_param: Option<JsString16> = source::member(&downstream, "error_param")
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(downstream_param, stored);
        let encoded: String = source::member(&downstream, "body_base64")
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(STANDARD.decode(encoded).unwrap(), terminal.as_bytes());
    }
}
