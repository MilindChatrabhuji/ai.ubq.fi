mod support;
use gateway_observability::{ObservabilityRuntime, metered};
use serde_json::{Value, json};
use support::{Host, Memory, run};

#[test]
fn unavailable_metered_diagnostics_distinguish_configuration_without_fabricated_zeroes() {
    for configured in [false, true] {
        let result = metered::diagnostics(configured, None);
        assert_eq!(result["configured"], configured);
        assert_eq!(result["available"], false);
        assert_eq!(result.as_object().unwrap().len(), 20);
        for (name, value) in result.as_object().unwrap() {
            if !["configured", "available"].contains(&name.as_str()) {
                assert!(value.is_null(), "{name} must stay unknown");
            }
        }
    }
    assert_eq!(
        metered::diagnostics(false, Some(&json!({}))),
        metered::diagnostics(false, None)
    );
}

#[test]
fn source_token_monitoring_diagnostics_do_not_invent_credit_accounting() {
    let snapshot = metered::snapshot_view(
        &json!({
            "current_balance_quota":0, "post_refill_baseline_quota":0,
            "quota_per_credit":1, "observed_at_ms":1000, "cycle_started_at_ms":1000,
            "confidence":"provisional", "last_known_debits_quota":0,
            "last_inferred_credit_quota":0, "last_credit_at_ms":null,
            "latest_refill_id":null, "latest_refill_amount_credits":null,
            "latest_refill_completed_at_ms":null, "unlimited_quota":false,
            "total_available":400, "total_granted":1000, "total_used":600,
        }),
        "fresh",
    );
    assert_eq!(
        metered::diagnostics(true, Some(&snapshot)),
        json!({
            "configured":true, "available":true, "cache_state":"fresh",
            "confidence":null, "balance_credits":null, "baseline_credits":null,
            "remaining_percent":null, "used_percent":null, "observed_at_ms":1000,
            "cycle_started_at_ms":null, "last_known_debits_credits":null,
            "last_inferred_credit_credits":null, "last_credit_at_ms":null,
            "latest_refill_id":null, "latest_refill_amount_credits":null,
            "latest_refill_completed_at_ms":null, "unlimited_quota":false,
            "total_available":400, "total_granted":1000, "total_used":600,
        })
    );
}

#[test]
fn source_legacy_credit_diagnostics_preserve_rollup_fields() {
    let snapshot = metered::snapshot_view(
        &json!({
            "current_balance_quota":500, "post_refill_baseline_quota":1000,
            "quota_per_credit":100, "observed_at_ms":5000, "cycle_started_at_ms":1000,
            "confidence":"confirmed", "last_known_debits_quota":300,
            "last_inferred_credit_quota":200, "last_credit_at_ms":3000,
            "latest_refill_id":"fixture-refill", "latest_refill_amount_credits":2,
            "latest_refill_completed_at_ms":3000,
        }),
        "stale",
    );
    let result = metered::diagnostics(true, Some(&snapshot));
    for (name, value) in [
        ("balance_credits", json!(5.0)),
        ("baseline_credits", json!(10.0)),
        ("last_known_debits_credits", json!(3.0)),
        ("last_inferred_credit_credits", json!(2.0)),
        ("remaining_percent", json!(50.0)),
        ("used_percent", json!(50.0)),
        ("observed_at_ms", json!(5000)),
        ("cycle_started_at_ms", json!(1000)),
        ("last_credit_at_ms", json!(3000)),
        ("latest_refill_id", json!("fixture-refill")),
        ("latest_refill_amount_credits", json!(2)),
        ("latest_refill_completed_at_ms", json!(3000)),
        ("cache_state", json!("stale")),
        ("confidence", json!("confirmed")),
        ("unlimited_quota", json!(false)),
    ] {
        assert_eq!(result[name], value, "{name}");
    }
    for name in ["total_available", "total_granted", "total_used"] {
        assert_eq!(result[name], Value::Null);
    }
}

#[test]
fn retention_maintenance_failure_is_unavailable_diagnostics_not_admin_failure() {
    let store = Memory::default();
    store.unavailable.set(true);
    let host = Host::default();
    host.at.set(1000);
    let runtime = ObservabilityRuntime::new(store.clone(), host);
    assert_eq!(
        run(runtime.error_retention_diagnostics()),
        json!({
            "state":"unavailable", "scope":"capture_owned_kv_payload",
            "budget_bytes":null, "stored_bytes":null, "reserved_bytes":null,
            "records":null, "metadata_bytes":null, "status_records":null,
            "evicted_records":null, "evicted_bytes":null, "expired_records":null,
            "last_eviction_at_ms":null, "last_warning_at_ms":null,
            "over_budget":false, "near_capacity":false, "accounting_complete":false,
            "accounting_error":"unavailable", "skipped_reason":null,
        })
    );
    assert_eq!(store.commits.get(), 0);
}

#[test]
fn retention_diagnostics_use_current_store_after_runtime_rebind_and_restart() {
    let first = Memory::default();
    let host = Host::default();
    host.at.set(1000);
    let runtime = ObservabilityRuntime::new(first.clone(), host.clone());
    let original = run(runtime.error_retention_diagnostics());
    assert_eq!(original["state"], "ok");
    // One source maintenance pass may intentionally leave the owner index incomplete.
    assert_eq!(original["accounting_complete"], false);
    let mut ready = false;
    for _ in 0..20 {
        if run(runtime.error_retention_diagnostics())["accounting_complete"] == true {
            ready = true;
            break;
        }
    }
    assert!(ready, "source bounded bootstrap must eventually finish");
    let unavailable = Memory::default();
    unavailable.unavailable.set(true);
    let rebound =
        ObservabilityRuntime::with_state(unavailable, host.clone(), runtime.shared_state());
    assert_eq!(
        run(rebound.error_retention_diagnostics())["state"],
        "unavailable"
    );
    let restarted = ObservabilityRuntime::new(first, host);
    let after = run(restarted.error_retention_diagnostics());
    assert_eq!(after["state"], "ok");
    assert_eq!(after["accounting_complete"], true);
    assert_eq!(after["budget_bytes"], 1_073_741_824.0);
}

#[test]
fn observational_codex_runtime_never_redeems_a_manual_reset() {
    let store = Memory::default();
    let host = Host::default();
    host.at.set(1000);
    let runtime = ObservabilityRuntime::new(store.clone(), host);
    let error = run(runtime.codex(
        gateway_admin_runtime::capabilities::CodexRequest::ConsumeReset {
            account_id_hash: "a".repeat(64),
        },
        gateway_admin_runtime::capabilities::Context {
            request_id: "read-only-diagnostics".into(),
            now_ms: 1000,
        },
    ))
    .unwrap_err();
    assert_eq!(error.status, 503);
    assert!(
        error
            .envelope
            .error
            .message
            .contains("native_manual_reset_owner")
    );
    assert_eq!(store.reads.get(), 0);
    assert_eq!(store.commits.get(), 0);
}
