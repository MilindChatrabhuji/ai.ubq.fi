mod support;
use gateway_core::{
    js_string::JsString16, source_usage::extract_usage_tokens, state::StoredRecord,
    tuple_key::TupleKey,
};
use gateway_observability::{ObservabilityRuntime, ledger::terminal_rollup::TerminalUsageRollup};
use serde_json::Value;
use support::{Host, Memory, run};
const NOW: i64 = 1_792_329_600_000;

#[test]
fn actual_source_terminal_writer_cases_match_shared_usage_and_bounded_atomic_storage() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("terminal_rollup_source_cases.json")).unwrap();
    assert_eq!(cases.len(), 25);
    let mut typed_cases = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        if case["no_kv"] == true {
            // Source null-KV is a pre-constructor capability boundary. This typed
            // runtime requires a store; its unavailable-store case is tested below.
            assert_eq!(case["expected"]["outcome"]["value"], false);
            continue;
        }
        typed_cases += 1;
        let store = Memory::default();
        let host = Host::default();
        host.at.set(NOW);
        store
            .conflicts
            .set(case["conflicts"].as_u64().unwrap() as usize);
        store.unavailable.set(case["read_error"] == true);
        if let Some(existing) = case.get("existing") {
            let key = &case["expected"]["rows"][0]["key"];
            let key = TupleKey::from_json_parts(key.as_array().unwrap())
                .unwrap()
                .to_record_key();
            store
                .rows
                .borrow_mut()
                .insert(key.0, StoredRecord::json("initial", existing.clone(), None));
        }
        let runtime = ObservabilityRuntime::new(store.clone(), host);
        let usage = extract_usage_tokens(Some(&case["raw"]));
        let model = case["model"].as_str().map(JsString16::from_utf8);
        let mut result = Ok(false);
        for _ in 0..case["calls"].as_u64().unwrap() {
            result = run(runtime.record_terminal_usage_rollup(TerminalUsageRollup {
                model: model.as_ref(),
                provider: case["provider"].as_str(),
                request_id: case["request_id"].as_str().unwrap(),
                request_created_at_ms: if case["created_nonfinite"] == true {
                    Some(f64::INFINITY)
                } else {
                    case.get("created").and_then(Value::as_f64)
                },
                usage: usage.as_ref(),
            }));
            if result.is_err() {
                break;
            }
        }
        let expected = &case["expected"];
        if expected["outcome"]["kind"] == "error" {
            assert!(result.is_err(), "{name}");
        } else {
            assert_eq!(
                result.unwrap(),
                expected["outcome"]["value"].as_bool().unwrap(),
                "{name}"
            );
        }
        assert_eq!(
            store.reads.get(),
            expected["reads"].as_u64().unwrap() as usize,
            "{name}"
        );
        assert_eq!(
            store.commits.get(),
            expected["commits"].as_u64().unwrap() as usize,
            "{name}"
        );
        let expected_rows = expected["rows"].as_array().unwrap();
        assert_eq!(store.rows.borrow().len(), expected_rows.len(), "{name}");
        for row in expected_rows {
            let key = TupleKey::from_json_parts(row["key"].as_array().unwrap())
                .unwrap()
                .to_record_key();
            let rows = store.rows.borrow();
            let actual = rows
                .get(&key.0)
                .unwrap_or_else(|| panic!("{name}: source key missing"));
            assert_eq!(actual.json_value().unwrap(), &row["value"], "{name}");
            assert_eq!(
                actual.expires_at_ms, None,
                "{name}: rollups never get a fresh TTL"
            );
        }
    }
    assert_eq!(typed_cases, 24);
}

#[test]
fn source_number_version_does_not_discard_a_valid_existing_aggregate() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("terminal_rollup_source_cases.json")).unwrap();
    let case = cases
        .iter()
        .find(|case| case["name"] == "valid_historical_fraction_kept")
        .unwrap();
    let mut imported = case["existing"].clone();
    // JSON 1 and 1.0 are the same source Number discriminator, not distinct schemas.
    imported["v"] = serde_json::json!(1.0);
    assert!(gateway_observability::api::valid_usage_rollup(&imported));
    let key = TupleKey::from_json_parts(case["expected"]["rows"][0]["key"].as_array().unwrap())
        .unwrap()
        .to_record_key();
    let store = Memory::default();
    store
        .rows
        .borrow_mut()
        .insert(key.0.clone(), StoredRecord::json("initial", imported, None));
    let host = Host::default();
    host.at.set(NOW);
    let runtime = ObservabilityRuntime::new(store.clone(), host);
    let usage = extract_usage_tokens(Some(&case["raw"]));
    let model = case["model"].as_str().map(JsString16::from_utf8);
    assert!(
        run(runtime.record_terminal_usage_rollup(TerminalUsageRollup {
            model: model.as_ref(),
            provider: case["provider"].as_str(),
            request_id: case["request_id"].as_str().unwrap(),
            request_created_at_ms: case["created"].as_f64(),
            usage: usage.as_ref(),
        }))
        .unwrap()
    );
    assert_eq!(
        store.rows.borrow()[&key.0].json_value().unwrap(),
        &case["expected"]["rows"][0]["value"]
    );
}
