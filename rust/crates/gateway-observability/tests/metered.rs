mod support;
use gateway_core::{GatewayError, state::StoredRecord};
use gateway_observability::{metered, types::ObservabilityHost};
use serde_json::{Value, json};
use std::{cell::Cell, rc::Rc};
use support::{Host, Memory, run};
struct Monitoring {
    clock: Host,
    store: Memory,
    fetches: Rc<Cell<u32>>,
    invalidate: bool,
}
impl ObservabilityHost for Monitoring {
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
    async fn wait_ms(&self, n: u32) -> Result<(), GatewayError> {
        self.clock.wait_ms(n).await
    }
    async fn metered_balance_fingerprint(&self) -> Result<Option<String>, GatewayError> {
        Ok(Some("fingerprint".into()))
    }
    async fn fetch_metered_quota(&self, _deadline: i64) -> Result<Value, GatewayError> {
        self.fetches.set(self.fetches.get() + 1);
        if self.invalidate {
            self.store.rows.borrow_mut().insert(
                metered::key("invalidation").0,
                StoredRecord::json(
                    "invalidate-during-fetch",
                    json!({"invalidated_at_ms":self.now_ms()}),
                    None,
                ),
            );
        }
        Ok(
            json!({"success":true,"data":{"unlimited_quota":false,"total_available":-25,"total_granted":10,"total_used":35}}),
        )
    }
}
#[test]
fn current_token_totals_never_become_wallet_or_quota_authorization() {
    let state=metered::token_usage_state(&json!({"success":true,"data":{"unlimited_quota":false,"total_available":-25,"total_granted":10,"total_used":35}}),100).unwrap();
    assert!(metered::valid_state(&state));
    let snapshot = metered::snapshot_view(&state, "refreshed");
    assert_eq!(snapshot["state"]["current_balance_quota"], 0);
    assert!(snapshot["balance_credits"].is_null());
    assert_eq!(snapshot["total_available"], -25);
    assert!(snapshot["remaining_percent"].is_null());
    assert!(metered::token_usage_state(&json!({"success":true,"data":{"unlimited_quota":false,"total_available":"25","total_granted":10,"total_used":35}}),100).is_err());
}
#[test]
fn monitoring_refresh_is_durable_lease_guarded_and_account_history_is_independent() {
    let store = Memory::default();
    let clock = Host::default();
    clock.at.set(1000);
    let fetches = Rc::new(Cell::new(0));
    let host = Monitoring {
        clock: clock.clone(),
        store: store.clone(),
        fetches: fetches.clone(),
        invalidate: false,
    };
    let first = run(metered::quota_snapshot(&store, &host, false, 11000))
        .unwrap()
        .unwrap();
    assert_eq!(first["cache_state"], "refreshed");
    assert_eq!(fetches.get(), 1);
    assert!(
        store
            .rows
            .borrow()
            .get(&metered::key("refresh_lease").0)
            .is_none()
    );
    let restarted = run(metered::cached_snapshot(&store, 1001))
        .unwrap()
        .unwrap();
    assert_eq!(restarted["cache_state"], "fresh");
    let second = run(metered::quota_snapshot(&store, &host, false, 11000))
        .unwrap()
        .unwrap();
    assert_eq!(second["cache_state"], "fresh");
    assert_eq!(fetches.get(), 1);
    assert!(store.rows.borrow().values().any(|r| {
        r.json_value()
            .ok()
            .is_some_and(|v| v["v"] == 1 && v["observed_at_ms"] == 1000)
    }));
    clock.at.set(301001);
    assert_eq!(
        run(metered::cached_snapshot(&store, clock.now_ms()))
            .unwrap()
            .unwrap()["cache_state"],
        "stale"
    );
    clock.at.set(86_401_001);
    assert!(
        run(metered::cached_snapshot(&store, clock.now_ms()))
            .unwrap()
            .is_none()
    );
}
#[test]
fn invalidation_between_read_and_provider_completion_prevents_stale_publication() {
    let store = Memory::default();
    let clock = Host::default();
    clock.at.set(1000);
    let host = Monitoring {
        clock,
        store: store.clone(),
        fetches: Rc::new(Cell::new(0)),
        invalidate: true,
    };
    assert!(
        run(metered::quota_snapshot(&store, &host, true, 11000))
            .unwrap()
            .is_none()
    );
    assert!(!store.rows.borrow().contains_key(&metered::key("state").0));
    assert!(
        store
            .rows
            .borrow()
            .contains_key(&metered::key("invalidation").0)
    );
    assert!(
        !store
            .rows
            .borrow()
            .contains_key(&metered::key("refresh_lease").0)
    );
}
