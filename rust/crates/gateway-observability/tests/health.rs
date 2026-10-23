mod support;
use gateway_core::state::{RevisionCheck, StoredRecord};
use gateway_observability::{
    ObservabilityRuntime,
    health::*,
    types::{HealthEvent as E, HealthProvider as P, HealthTarget, HealthWrite as W},
};
use serde_json::json;
use std::{
    future::Future,
    pin::pin,
    task::{Context, Poll, Waker},
};
use support::{Host, Memory, run};

#[test]
fn source_paid_health_borrows_only_complete_bounded_exception_evidence() {
    let credit = br#"{"error":{"code":" Insufficient_Credit "}}"#;
    let original = credit.to_vec();
    assert_eq!(
        paid_health(P::Surplus, Some(402), credit, true),
        Some(E::QuotaExhausted)
    );
    assert_eq!(
        paid_health(P::Surplus, Some(402), credit, false),
        Some(E::UpstreamError)
    );
    assert_eq!(
        paid_health(
            P::Surplus,
            Some(402),
            br#"{"type":"INSUFFICIENT_CREDIT"}"#,
            true
        ),
        Some(E::QuotaExhausted)
    );
    assert_eq!(
        paid_health(
            P::Surplus,
            Some(402),
            br#"{"error":{"message":"insufficient_credit"}}"#,
            true
        ),
        Some(E::UpstreamError)
    );
    assert_eq!(
        paid_health(P::Surplus, Some(403), credit, true),
        Some(E::AuthInvalid)
    );
    assert_eq!(
        paid_health(P::Surplus, Some(503), credit, true),
        Some(E::UpstreamError)
    );
    assert_eq!(
        paid_health(
            P::Metered,
            Some(403),
            br#"{"error":{"code":"local:insufficient_quota"}}"#,
            true
        ),
        Some(E::QuotaExhausted)
    );
    assert_eq!(
        paid_health(
            P::Metered,
            Some(403),
            br#"{"error":{"message":"Quota is not enough to proceed"}}"#,
            true
        ),
        Some(E::QuotaExhausted)
    );
    assert_eq!(
        paid_health(P::Metered, None, credit, true),
        Some(E::UpstreamError)
    );
    let oversized = [
        br#"{"code":"insufficient_credit","pad":""#.as_slice(),
        vec![b'x'; 65536].as_slice(),
        br#""}"#.as_slice(),
    ]
    .concat();
    assert_eq!(
        paid_health(P::Surplus, Some(402), &oversized, true),
        Some(E::UpstreamError)
    );
    assert_eq!(credit.as_slice(), original);
    assert_eq!(
        paid_health(
            P::Surplus,
            Some(402),
            br#"{"error":[],"code":"insufficient_credit"}"#,
            true
        ),
        Some(E::UpstreamError)
    );
    assert_eq!(
        paid_health(
            P::Surplus,
            Some(402),
            br#"{"error":null,"code":"insufficient_credit"}"#,
            true
        ),
        Some(E::QuotaExhausted)
    );
    assert_eq!(
        paid_health(
            P::Surplus,
            Some(402),
            br#"{"error":{},"code":"insufficient_credit"}"#,
            true
        ),
        Some(E::UpstreamError)
    );
}
#[test]
fn request_ids_match_source_utf16_control_and_trim_bounds() {
    assert_eq!(
        normalize_provider_request_id(Some(" \u{feff}abc\u{00a0}")),
        Some("abc".into())
    );
    assert_eq!(
        normalize_provider_request_id(Some(&"😀".repeat(128))),
        Some("😀".repeat(128))
    );
    assert_eq!(normalize_provider_request_id(Some(&"😀".repeat(129))), None);
    assert_eq!(normalize_provider_request_id(Some("abc\nxyz")), None);
    assert_eq!(normalize_provider_request_id(Some("abc\u{7f}")), None);
}
#[test]
fn durable_health_transitions_first_correlation_heartbeat_and_restart() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(100000);
    let runtime = ObservabilityRuntime::new(memory.clone(), host.clone());
    let target = HealthTarget::codex("account");
    assert_eq!(
        run(runtime.observe_provider(target.clone(), E::Success, Some(200), None)),
        W::Stored
    );
    assert_eq!(
        run(runtime.observe_provider(target.clone(), E::Success, Some(200), None)),
        W::Throttled
    );
    assert_eq!(
        run(runtime.observe_provider(target.clone(), E::Success, Some(200), Some("r1"))),
        W::Stored
    );
    host.at.set(100001);
    assert_eq!(
        run(runtime.observe_provider(target.clone(), E::Success, Some(200), Some("r2"))),
        W::Throttled
    );
    assert_eq!(
        run(runtime.provider_health(&target, 100001)).unwrap()["last_provider_request_id"],
        "r1"
    );
    assert_eq!(
        run(runtime.observe_provider(target.clone(), E::UpstreamError, Some(503), None)),
        W::Stored
    );
    assert_eq!(
        run(runtime.observe_provider(target.clone(), E::Success, Some(200), None)),
        W::Stored
    );
    let view = run(runtime.provider_health(&target, 100001)).unwrap();
    assert_eq!(view["state"], "healthy");
    assert_eq!(view["last_provider_request_id"], serde_json::Value::Null);
    assert_eq!(
        run(runtime.provider_health(&target, 100001 + STALE_AFTER_MS)).unwrap()["stale"],
        false
    );
    assert_eq!(
        run(runtime.provider_health(&target, 100002 + STALE_AFTER_MS)).unwrap()["stale"],
        true
    );
    let restarted = ObservabilityRuntime::new(memory.clone(), host);
    assert_eq!(
        run(restarted.provider_health(&target, 100001)).unwrap(),
        view
    );
    assert!(
        memory
            .rows
            .borrow()
            .values()
            .all(|row| row.expires_at_ms.is_none())
    );
}
#[test]
fn concurrent_cold_bursts_coalesce_and_transitions_preserve_arrival_order() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(10);
    let runtime = ObservabilityRuntime::new(memory.clone(), host);
    let target = HealthTarget::codex("account");
    memory.pause.set(true);
    let mut cx = Context::from_waker(Waker::noop());
    let first = runtime.observe_provider(target.clone(), E::Success, Some(200), None);
    let mut first = pin!(first);
    assert!(matches!(first.as_mut().poll(&mut cx), Poll::Pending));
    let same = runtime.observe_provider(target.clone(), E::Success, Some(200), None);
    let mut same = pin!(same);
    assert!(matches!(same.as_mut().poll(&mut cx), Poll::Pending));
    let next = runtime.observe_provider(target.clone(), E::UpstreamError, Some(503), None);
    let mut next = pin!(next);
    assert!(matches!(next.as_mut().poll(&mut cx), Poll::Pending));
    memory.pause.set(false);
    assert_eq!(run(first), W::Stored);
    assert_eq!(run(next), W::Stored);
    assert_eq!(run(same), W::Coalesced);
    assert_eq!(memory.commits.get(), 2);
    assert_eq!(
        run(runtime.provider_health(&target, 10)).unwrap()["last_event"],
        "upstream_error"
    );
}
#[test]
fn stale_claude_binding_and_store_failures_never_create_routing_evidence() {
    let memory = Memory::default();
    let host = Host::default();
    let runtime = ObservabilityRuntime::new(memory.clone(), host);
    let row_key = gateway_core::tuple_key::TupleKey::from_json_parts(&[json!("source-binding")])
        .unwrap()
        .to_record_key();
    memory.rows.borrow_mut().insert(
        row_key.0.clone(),
        StoredRecord::json("generation2", json!({}), None),
    );
    let target = HealthTarget {
        provider: P::ClaudeCode,
        identity: "account:cohort:1".into(),
        source_checks: vec![RevisionCheck {
            key: row_key,
            expected_revision: Some("generation1".into()),
        }],
    };
    assert_eq!(
        run(runtime.observe_provider(target.clone(), E::QuotaExhausted, Some(429), None)),
        W::BindingChanged
    );
    assert_eq!(
        run(runtime.provider_health(&target, 0)).unwrap(),
        unknown_health()
    );
    assert_eq!(memory.commits.get(), 0);
    memory.unavailable.set(true);
    assert_eq!(
        run(runtime.observe_provider(HealthTarget::codex("account"), E::Success, Some(200), None)),
        W::Unavailable
    );
}
