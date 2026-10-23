mod support;
use gateway_core::{
    lifecycle::DeliveryOutcome, state::StoredRecord, tuple_key::TupleKey, value::PortableValue,
};
use gateway_observability::{
    ObservabilityRuntime,
    ledger::{ErrorObservation, REQUEST_RETENTION_MS},
    prompt::PromptEvent,
    telemetry::*,
};
use serde_json::{Value, json};
use support::{Host, Memory, run};
fn event(model: &str) -> PromptEvent {
    PromptEvent {
        provider: Some("chatgpt_codex".into()),
        model: Some(model.into()),
        route: "responses".into(),
        status: 200,
        completed: true,
        usage_telemetry_status: "reported".into(),
        input_tokens: Some(100),
        cached_input_tokens: Some(0),
        cache_write_input_tokens: Some(0),
        cache_write_tokens_present: true,
        prompt_cache_key_present: false,
        prompt_cache_mode: Some("implicit".into()),
        fallback_reason: None,
    }
}
#[test]
fn existing_request_ledger_retries_preserves_creation_retention_and_restarts() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(1000);
    let r = ObservabilityRuntime::new(memory.clone(), host.clone());
    memory.conflicts.set(2);
    run(r.record_request_log("key",&json!({"id":"request","route":"responses","created_at_ms":500,"method":"post","status_code":200,"provider":"unknown"}))).unwrap();
    assert_eq!(memory.commits.get(), 3);
    host.at.set(2000);
    run(r.update_request_log(
        "key",
        500,
        "request",
        &json!({"input_tokens":12.9,"provider":"surplus","status_code":700,"id":"must-not-change"}),
    ))
    .unwrap();
    let logs = run(r.request_logs("key", 20)).unwrap();
    let record: Value = logs[0].deserialize().unwrap();
    assert_eq!(record["id"], "request");
    assert_eq!(record["provider"], "surplus");
    assert_eq!(record["status_code"].as_f64(), Some(599.0));
    assert_eq!(record["input_tokens"].as_f64(), Some(12.0));
    assert_eq!(
        memory.rows.borrow().values().next().unwrap().expires_at_ms,
        Some(500 + REQUEST_RETENTION_MS)
    );
    let restarted = ObservabilityRuntime::new(memory.clone(), host);
    assert_eq!(run(restarted.request_logs("key", 20)).unwrap(), logs);
    let before = memory.rows.borrow().len();
    run(r.update_request_log("key", 500, "absent", &json!({"status_code":200}))).unwrap();
    assert_eq!(memory.rows.borrow().len(), before);
}
#[test]
fn gateway_auth401_and_success_keep_zero_kv_and_error_expiry_uses_write_clock() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(1000);
    let r = ObservabilityRuntime::new(memory.clone(), host);
    let mut e = ErrorObservation {
        request_id: "r".into(),
        route: "responses".into(),
        status: 401,
        provider: "gateway".into(),
        model: None,
        reasoning: None,
        stream: None,
        terminal_type: None,
        failure_kind: None,
        delivery_outcome: DeliveryOutcome::Unobserved,
        created_at_ms: 100,
        latency_ms: 10,
        git_sha: None,
        deno_revision: None,
    };
    assert!(!run(r.record_admin_error(&e)).unwrap());
    assert_eq!((memory.reads.get(), memory.commits.get()), (0, 0));
    e.status = 200;
    e.provider = "codex".into();
    assert!(!run(r.record_admin_error(&e)).unwrap());
    assert_eq!(memory.commits.get(), 0);
    e.status = 502;
    assert!(run(r.record_admin_error(&e)).unwrap());
    let rows = memory.rows.borrow();
    let row = rows.values().next().unwrap();
    assert_eq!(row.expires_at_ms, Some(1000 + 7 * 86_400_000));
    assert_eq!(row.value["terminal_type"], "http.error");
    assert_eq!(row.value["failure_kind"], "http_502");
    assert_eq!(row.value["delivery_outcome"], "unobserved");
}
#[test]
fn counters_are_real_u64_and_valid_zero_cache_fields_stay_present() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(1_800_000);
    let r = ObservabilityRuntime::new(memory.clone(), host.clone());
    let e = event("private-model-name");
    assert_eq!(
        run(r.record_prompt_analytics(&e, "abcdef0"))["status"],
        "recorded"
    );
    assert_eq!(
        run(r.record_prompt_telemetry(&e, "abcdef0"))["status"],
        "recorded"
    );
    let view = run(r.prompt_analytics(&["key_presence".into()])).unwrap();
    assert_eq!(view["status"], "ready");
    let b = &view["buckets"][0];
    assert_eq!(b["cache_write_input_tokens"], 0);
    assert_eq!(b["cache_write_reported_sample_count"], 1);
    assert_eq!(b["usage_reported_sample_count"], 1);
    for (key, row) in memory.rows.borrow().iter() {
        assert!(!key.contains("private-model-name"));
        if row.value_encoding == gateway_core::value::ValueEncoding::ProfileV1 {
            assert!(matches!(
                row.portable_value().unwrap(),
                PortableValue::KvU64(_)
            ));
        }
    }
    let restarted = ObservabilityRuntime::new(memory, host);
    assert_eq!(
        run(restarted.prompt_analytics(&["key_presence".into()])).unwrap(),
        view
    );
}
#[test]
fn fixed_cohort_cap_keeps_aggregate_and_marks_incomplete_overflow() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(1_800_000);
    let r = ObservabilityRuntime::new(memory, host);
    for i in 0..34 {
        let v = run(r.record_prompt_analytics(&event(&format!("model-{i}")), "abcdef0"));
        assert_eq!(
            v["reason"],
            if i < 32 {
                "recorded"
            } else {
                "recorded_cardinality_capped"
            }
        );
    }
    let view = run(r.prompt_analytics(&["model".into()])).unwrap();
    assert_eq!(view["cardinality_limited"], true);
    assert_eq!(view["truncated"], true);
    assert_eq!(view["buckets"].as_array().unwrap().len(), 33);
    let sum: u64 = view["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["sample_count"].as_u64().unwrap())
        .sum();
    assert_eq!(sum, 34);
}
#[test]
fn gate_baseline_uses_original_u64_ratio_and_never_accepts_malformed_json_counters() {
    let memory = Memory::default();
    let host = Host::default();
    let r = ObservabilityRuntime::new(memory.clone(), host);
    let model = gateway_auth::crypto::sha256_hex(b"uos-prompt-cache-telemetry-model-v1\0m");
    for (route, completed) in [("responses", 9000), ("chat.completions", 1000)] {
        for (counter, n) in [
            ("completed", completed),
            ("reported", completed),
            ("cache_write_reported", completed),
        ] {
            let key = TupleKey::from_json_parts(
                json!([
                    "uos_ai",
                    "prompt_cache_telemetry_gate",
                    "v1",
                    "abcdef0",
                    "chatgpt_codex",
                    model,
                    route,
                    counter
                ])
                .as_array()
                .unwrap(),
            )
            .unwrap()
            .to_record_key();
            memory.rows.borrow_mut().insert(
                key.0,
                StoredRecord::profile("r", PortableValue::KvU64(n.to_string()), None).unwrap(),
            );
        }
    }
    assert_eq!(
        run(r.prompt_telemetry_baseline("chatgpt_codex", "m", "abcdef0"))["status"],
        "eligible"
    );
    let key = TupleKey::from_json_parts(
        json!([
            "uos_ai",
            "prompt_cache_telemetry_gate",
            "v1",
            "abcdef0",
            "chatgpt_codex",
            model,
            "responses",
            "reported"
        ])
        .as_array()
        .unwrap(),
    )
    .unwrap()
    .to_record_key();
    memory.rows.borrow_mut().insert(
        key.0,
        StoredRecord::json("bad", json!({"value":"9000"}), None),
    );
    let view = run(r.prompt_telemetry_baseline("chatgpt_codex", "m", "abcdef0"));
    assert_eq!(view["status"], "not_ready");
    assert_eq!(view["reason"], "invalid_counter");
}
#[test]
fn ignored_optional_telemetry_has_no_kv_side_effect_and_failures_remain_unavailable() {
    let memory = Memory::default();
    let host = Host::default();
    let r = ObservabilityRuntime::new(memory.clone(), host);
    let mut e = event("m");
    e.completed = false;
    assert_eq!(
        run(r.record_prompt_analytics(&e, "abcdef0"))["reason"],
        "not_completed_2xx"
    );
    assert_eq!(memory.reads.get(), 0);
    e.completed = true;
    assert_eq!(
        run(r.record_prompt_analytics(&e, "unknown"))["reason"],
        "unknown_release"
    );
    assert_eq!(memory.reads.get(), 0);
    memory.unavailable.set(true);
    assert_eq!(
        run(r.record_prompt_analytics(&e, "abcdef0"))["status"],
        "unavailable"
    );
    assert_eq!(
        run(r.prompt_analytics(&[])).unwrap()["status"],
        "unavailable"
    );
}
#[test]
fn fault_only_incomplete_and_explicit_failures_get_upstream_error_attribution() {
    assert_eq!(
        responses_terminal_health(
            "response.incomplete",
            &json!({"response":{"incomplete_details":{"reason":"max_output_tokens"}}})
        ),
        Some(gateway_observability::types::HealthEvent::Reachable)
    );
    assert_eq!(
        response_incomplete_failure_kind(
            &json!({"response":{"incomplete_details":{"reason":"UPSTREAM_timeout"}}})
        ),
        Some("response_incomplete:UPSTREAM_timeout".into())
    );
    assert_eq!(
        responses_terminal_health(
            "response.incomplete",
            &json!({"response":{"incomplete_details":{"reason":"server_error"}}})
        ),
        Some(gateway_observability::types::HealthEvent::UpstreamError)
    );
    assert_eq!(
        responses_terminal_health("response.failed", &Value::Null),
        Some(gateway_observability::types::HealthEvent::UpstreamError)
    );
}
