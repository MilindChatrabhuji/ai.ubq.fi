mod support;
use gateway_core::{
    js_string::JsString16,
    lifecycle::DeliveryOutcome,
    source_json::SourceJson,
    source_serialization as source,
    state::{RecordKey, StoredRecord},
    tuple_key::{DecodedKeyPart, TupleKey},
    value::{PortableValue, ValueEncoding},
};
use gateway_observability::{
    ObservabilityRuntime,
    incidents::IncidentObservation,
    ledger::{ERROR_RETENTION_MS, ErrorObservation},
    prompt::PromptEvent,
    records::{admin_error_record_source, record_source_json},
};
use serde_json::json;
use support::{Host, Memory, run};
fn units(document: &SourceJson, name: &str) -> Vec<u16> {
    source::member(document, name)
        .unwrap()
        .deserialize::<JsString16>()
        .unwrap()
        .into_units()
}
fn error() -> ErrorObservation {
    ErrorObservation {
        request_id: "source-error".into(),
        route: "responses".into(),
        status: 503,
        provider: "surplus".into(),
        model: Some(JsString16::from_units(vec![0xd800])),
        reasoning: Some(JsString16::from_units(vec![0xdc00])),
        stream: Some(false),
        terminal_type: Some("  response.failed  ".into()),
        failure_kind: None,
        delivery_outcome: DeliveryOutcome::Unobserved,
        created_at_ms: 1000,
        latency_ms: 5,
        git_sha: None,
        deno_revision: None,
    }
}
#[test]
fn error_actual_writer_and_named_reader_keep_model_effort_revision_and_retention() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(1000);
    let runtime = ObservabilityRuntime::new(memory.clone(), clock);
    assert!(run(runtime.record_admin_error(&error())).unwrap());
    let rows = memory.rows.borrow();
    let record = rows.values().next().unwrap();
    assert_eq!(record.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(record.expires_at_ms, Some(1000 + ERROR_RETENTION_MS));
    let restored: StoredRecord =
        serde_json::from_slice(&serde_json::to_vec(record).unwrap()).unwrap();
    let doc = admin_error_record_source(&restored).unwrap();
    assert_eq!(units(&doc, "model"), [0xd800]);
    assert_eq!(units(&doc, "reasoning"), [0xdc00]);
    assert_eq!(
        units(&doc, "terminal_type"),
        "response.failed".encode_utf16().collect::<Vec<_>>()
    );
    assert_eq!(record.revision, restored.revision);
    assert_eq!(record.expires_at_ms, restored.expires_at_ms);
    println!(
        "M39_WRITER_FIXTURE={}",
        json!({"family":"admin_error_log_v1","rows":rows.iter().map(|(key,record)|json!({"key":key,"record":record})).collect::<Vec<_>>()})
    );
}
#[test]
fn request_source_entrypoint_cas_patch_and_restart_keep_exact_units_without_shadow() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(1000);
    let runtime = ObservabilityRuntime::new(memory.clone(), clock.clone());
    let doc=SourceJson::parse(r#"{"id":"source-request","route":"responses","created_at_ms":1000,"model":"\ud800","reasoning":"r\udfff"}"#).unwrap();
    run(runtime.record_request_log_source("source-key", &doc)).unwrap();
    run(runtime.update_request_log_source(
        "source-key",
        1000,
        "source-request",
        &SourceJson::parse(r#"{"status_code":503}"#).unwrap(),
    ))
    .unwrap();
    let runtime = ObservabilityRuntime::new(memory.clone(), clock);
    let rows = run(runtime.request_logs("source-key", 10)).unwrap();
    assert_eq!(units(&rows[0], "model"), [0xd800]);
    assert_eq!(units(&rows[0], "reasoning"), [114, 0xdfff]);
    assert_eq!(
        source::number(&source::member(&rows[0], "status_code").unwrap()),
        Some(503.0)
    );
    let rows = memory.rows.borrow();
    println!(
        "M39_WRITER_FIXTURE={}",
        json!({"family":"request_log","rows":rows.iter().map(|(key,record)|json!({"key":key,"record":record})).collect::<Vec<_>>()})
    );
}
#[test]
fn incident_latest_intentionally_redacts_non_slug_source_units_without_hashing_them() {
    for (model, effort, expected) in [
        (
            JsString16::from_units(vec![0xd800]),
            JsString16::from_units(vec![0xdc00]),
            None,
        ),
        (
            JsString16::from_utf8("astral😀"),
            JsString16::from_utf8(r"\ud800"),
            None,
        ),
        (
            JsString16::from_utf8(" gpt-test "),
            JsString16::from_utf8(" high "),
            None,
        ),
        (
            JsString16::from_utf8("gpt-test"),
            JsString16::from_utf8("new-tier"),
            Some(("gpt-test", "new-tier")),
        ),
    ] {
        let memory = Memory::default();
        let host = Host::default();
        host.at.set(1000);
        let runtime = ObservabilityRuntime::new(memory, host);
        let receipt = run(runtime.record_incident_index(&IncidentObservation {
            endpoint: "/v1/responses".into(),
            method: "POST".into(),
            git_sha: "a".repeat(40),
            observed_at_ms: 1000,
            status: 502,
            stream: true,
            completed: false,
            framing_valid: true,
            terminal_type: Some("response.failed".into()),
            provider: Some("surplus".into()),
            model: Some(model),
            reasoning: Some(effort),
            failure_kind: None,
        }))
        .unwrap();
        let document = receipt.record.json_value().unwrap();
        match expected {
            Some((model, effort)) => {
                assert_eq!(document["latest"]["model"], model);
                assert_eq!(document["latest"]["reasoning"], effort);
            }
            None => {
                assert!(document["latest"]["model"].is_null());
                assert!(document["latest"]["reasoning"].is_null());
            }
        }
        assert_eq!(document["context"]["sample"], json!([]));
    }
}
fn prompt(model: JsString16) -> PromptEvent {
    PromptEvent {
        provider: Some("surplus".into()),
        model: Some(model),
        route: "responses".into(),
        status: 200,
        completed: true,
        usage_telemetry_status: "reported".into(),
        input_tokens: Some(10),
        cached_input_tokens: Some(2),
        cache_write_input_tokens: None,
        cache_write_tokens_present: false,
        prompt_cache_key_present: false,
        prompt_cache_mode: None,
        fallback_reason: None,
    }
}
#[test]
fn prompt_models_use_source_text_encoder_hashes_and_never_enter_durable_keys() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(1000);
    let runtime = ObservabilityRuntime::new(memory.clone(), host);
    let release = "a".repeat(40);
    let high =
        run(runtime
            .record_prompt_telemetry(&prompt(JsString16::from_units(vec![0xd800])), &release));
    let replacement =
        run(runtime
            .record_prompt_telemetry(&prompt(JsString16::from_units(vec![0xfffd])), &release));
    let literal =
        run(runtime.record_prompt_telemetry(&prompt(JsString16::from_utf8(r"\ud800")), &release));
    assert_eq!(high["status"], "recorded");
    assert_eq!(high["model_hash"], replacement["model_hash"]);
    assert_ne!(high["model_hash"], literal["model_hash"]);
    for key in memory.rows.borrow().keys() {
        let parts = TupleKey::from_record_key(&RecordKey(key.clone()))
            .unwrap()
            .decoded_parts()
            .unwrap();
        let DecodedKeyPart::String(hash) = &parts[5] else {
            panic!("existing model digest slot")
        };
        assert_eq!(hash.len(), 64);
        assert!(hash.iter().all(u8::is_ascii_hexdigit));
    }
}
#[test]
fn named_error_reader_refuses_missing_fields_and_wrong_codec_without_general_admission() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(1000);
    let runtime = ObservabilityRuntime::new(memory.clone(), host);
    run(runtime.record_admin_error(&error())).unwrap();
    let record = memory.rows.borrow().values().next().unwrap().clone();
    let doc = admin_error_record_source(&record).unwrap();
    let mut fields = doc.object_entries().unwrap();
    fields.retain(|(name, _)| name.try_utf8().ok().as_deref() != Some("model"));
    let missing = source::object_keys(fields).unwrap();
    let missing =
        gateway_core::source_control::encode_source_control_record("r", &missing, None).unwrap();
    assert!(admin_error_record_source(&missing).is_err());
    let wrong = StoredRecord::profile("r", PortableValue::Null, None).unwrap();
    assert!(record_source_json(&wrong).is_err());
    let wrong = StoredRecord::profile_v2("r", PortableValue::Map(vec![]), None).unwrap();
    assert!(record_source_json(&wrong).is_err());
}
#[test]
fn scalar_error_wire_is_unchanged_and_gateway_auth_failure_keeps_zero_kv_path() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(1000);
    let runtime = ObservabilityRuntime::new(memory.clone(), host);
    let mut input = error();
    input.status = 401;
    input.provider = "gateway".into();
    assert!(!run(runtime.record_admin_error(&input)).unwrap());
    assert_eq!(memory.reads.get(), 0);
    assert_eq!(memory.commits.get(), 0);
    input.status = 503;
    input.provider = "surplus".into();
    input.model = Some(JsString16::from_utf8(" gpt-test "));
    input.reasoning = Some(JsString16::from_utf8("new-tier"));
    run(runtime.record_admin_error(&input)).unwrap();
    let rows = memory.rows.borrow();
    let record = rows.values().next().unwrap();
    assert_eq!(record.value_encoding, ValueEncoding::Json);
    let expected = json!({"request_id":"source-error","route":"responses","status":503,"provider":"surplus","model":" gpt-test ","reasoning":"new-tier","stream":false,"terminal_type":"response.failed","failure_kind":"http_503","delivery_outcome":"unobserved","created_at_ms":1000,"latency_ms":5,"git_sha":null,"deno_revision":null,"version":1});
    assert_eq!(record.json_value().unwrap(), &expected);
    assert_eq!(
        serde_json::to_vec(record.json_value().unwrap()).unwrap(),
        serde_json::to_vec(&expected).unwrap()
    );
}

#[test]
fn actual_source_observation_goldens_match_telemetry_and_analytics_hash_preimages() {
    // Actual Bun source oracle be843b8e-aeaa-49c5-bdfa-b4dcf8226594.
    for (raw, telemetry, analytics) in [
        (
            r#""\ud800""#,
            "11d18b80a73d34d1e400e21f36a11796f89a1a316f326be51fb236a3a8ae81f0",
            "ba9743d5dae988ee76cc3b16ee9c4b8f5f9a901e6757e55a97dbfb7afe4b9d98",
        ),
        (
            r#""\udc00""#,
            "11d18b80a73d34d1e400e21f36a11796f89a1a316f326be51fb236a3a8ae81f0",
            "ba9743d5dae988ee76cc3b16ee9c4b8f5f9a901e6757e55a97dbfb7afe4b9d98",
        ),
        (
            r#""\ufffd""#,
            "11d18b80a73d34d1e400e21f36a11796f89a1a316f326be51fb236a3a8ae81f0",
            "ba9743d5dae988ee76cc3b16ee9c4b8f5f9a901e6757e55a97dbfb7afe4b9d98",
        ),
        (
            r#""\ud83d\ude00""#,
            "230deee29e1103ef98eaa7ef9cc2ee7c13d94abe15e49b2ee631e79a7b55a691",
            "80c26c661c717585707f0ca01982bddaf92481f0ebf53270f677d9b5b4877c5e",
        ),
        (
            r#""\\ud800""#,
            "5fefdeb297d5074f244febff846f48150e49cf7b5a4374bfcf09d75ade293204",
            "cbe2813b66e58dc006a6ce0f56f78f908fc1f6d9026350589910452a0e8efbc3",
        ),
        (
            r#"" gpt-test ""#,
            "536313502b8647d2d49f5e5c2733f031a156ca1ae63c0dfca984c94089c94585",
            "cd87653aa46fbbf9c59816ef8df34ba69fc5aa6c753017336c7e71b0c766f066",
        ),
        (
            r#""gpt-test""#,
            "536313502b8647d2d49f5e5c2733f031a156ca1ae63c0dfca984c94089c94585",
            "cd87653aa46fbbf9c59816ef8df34ba69fc5aa6c753017336c7e71b0c766f066",
        ),
        (
            r#""new-tier""#,
            "7625d52a09c1c4fe276025a1311bb833354df7dd3e4f3335cd995cea6bf24d38",
            "00b8cfeca7d4c722aa4441ebb6d51a0aa45c5f16fd039f064096e73e1f615f04",
        ),
    ] {
        let model = SourceJson::parse(raw)
            .unwrap()
            .deserialize::<JsString16>()
            .unwrap();
        let memory = Memory::default();
        let host = Host::default();
        host.at.set(1000);
        let runtime = ObservabilityRuntime::new(memory.clone(), host);
        let event = prompt(model);
        let recorded = run(runtime.record_prompt_telemetry(&event, &"a".repeat(40)));
        assert_eq!(recorded["model_hash"], telemetry);
        assert_eq!(
            run(runtime.record_prompt_analytics(&event, &"a".repeat(40)))["status"],
            "recorded"
        );
        let mut found = false;
        for key in memory.rows.borrow().keys() {
            let parts = TupleKey::from_record_key(&RecordKey(key.clone()))
                .unwrap()
                .decoded_parts()
                .unwrap();
            if matches!(parts.get(1),Some(DecodedKeyPart::String(name))if name==b"prompt_cache_analytics")
                && matches!(parts.get(3),Some(DecodedKeyPart::String(name))if name==b"dimension")
            {
                let DecodedKeyPart::String(hash) = &parts[6] else {
                    panic!("source model digest slot")
                };
                assert_eq!(hash.as_slice(), analytics.as_bytes());
                found = true;
            }
        }
        assert!(found);
    }
}
