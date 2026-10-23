use super::*;
use gateway_core::{
    provider::PaidProvider,
    state::{AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation, StoredRecord},
};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    rc::Rc,
    task::{Context, Poll, Waker},
};

const NOW: i64 = 1_792_329_600_000;
#[derive(Clone, Default)]
struct Store {
    rows: Rc<RefCell<BTreeMap<String, StoredRecord>>>,
    sequence: Rc<Cell<u64>>,
    failure: Rc<RefCell<Option<(RecordKey, bool)>>>,
    race: Rc<RefCell<Option<(RecordKey, Value)>>>,
}
impl Store {
    fn put(&self, key: RecordKey, value: Value) {
        let revision = self.next_token().unwrap();
        self.rows
            .borrow_mut()
            .insert(key.0, StoredRecord::json(revision, value, None));
    }
    fn row(&self, key: &RecordKey) -> StoredRecord {
        self.rows.borrow().get(&key.0).unwrap().clone()
    }
    fn value(&self, key: &RecordKey) -> Value {
        self.row(key).json_value().unwrap().clone()
    }
    fn fail(&self, key: RecordKey, error: bool) {
        *self.failure.borrow_mut() = Some((key, error));
    }
    fn authority(&self) -> Authority<Self, Self> {
        Authority::new(self.clone(), self.clone())
    }
}
impl TokenSource for Store {
    fn next_token(&self) -> Result<String, GatewayError> {
        let next = self.sequence.get() + 1;
        self.sequence.set(next);
        Ok(format!("revision-{next}"))
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let fail = self.failure.borrow().as_ref().is_some_and(|(key, _)| {
            transition.mutations.iter().any(|mutation| match mutation {
                RecordMutation::Put { key: k, .. } | RecordMutation::Delete { key: k } => k == key,
            })
        });
        if fail {
            let (_, error) = self.failure.borrow_mut().take().unwrap();
            if error {
                return Err(crate::unavailable(
                    "fixture_store_failure",
                    "source fixture commit failed",
                ));
            }
            return Ok(CommitOutcome::Conflict);
        }
        let race = self
            .race
            .borrow()
            .as_ref()
            .is_some_and(|(key, _)| transition.checks.iter().any(|check| &check.key == key));
        if race {
            let (key, value) = self.race.borrow_mut().take().unwrap();
            self.put(key, value);
        }
        let mut rows = self.rows.borrow_mut();
        if transition.checks.iter().any(|check| {
            rows.get(&check.key.0).map(|row| &row.revision) != check.expected_revision.as_ref()
        }) {
            return Ok(CommitOutcome::Conflict);
        }
        for mutation in transition.mutations {
            match mutation {
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
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        let validated = request.validate()?;
        let mut entries = Vec::new();
        for (key, record) in self.rows.borrow().iter() {
            let key = RecordKey(key.clone());
            if validated.accepts_record(&key, record)? {
                entries.push(gateway_core::query::QueryEntry {
                    key,
                    record: record.clone(),
                });
            }
        }
        entries.sort_by_key(|entry| {
            TupleKey::from_record_key(&entry.key)
                .unwrap()
                .sort_bytes()
                .to_vec()
        });
        let more = entries.len() > request.limit as usize;
        entries.truncate(request.limit as usize);
        let next_cursor = if more {
            entries
                .last()
                .map(|entry| validated.cursor_after(&entry.key))
                .transpose()?
        } else {
            None
        };
        Ok(QueryPage {
            entries,
            next_cursor,
        })
    }
}
fn run<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
}
fn decode_json<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, GatewayError> {
    gateway_core::source_json::SourceJson::from_serializable(&value)?.deserialize()
}
fn request(id: &str, settled: bool) -> Value {
    json!({"v":3,"reservation":{"key_id":"key","request_id":format!("original-{id}"),"attempt_id":id,"provider":"metered","window_reset_at_ms":NOW,"created_at_ms":NOW-1000,"reserved_microcredits":10},
        "policy_version":"v1","model":" model ","route":"responses","path":"/v1/responses","stream":false,"reasoning":null,"quota_per_credit":1_000_000,"provider_request_id":id,
        "dispatch_state":"dispatched","terminal_state":"completed","billing_state":if settled {"settled"} else {"pending"},"provider_quota":if settled {json!(1.5)} else {Value::Null},
        "input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"spend_microcredits":if settled {json!(5)} else {Value::Null},"transport_started":true,"reconciliation_attempts":0,
        "last_reconciliation_at_ms":null,"dispatched_at_ms":NOW-900,"terminal_at_ms":NOW-800,"settled_at_ms":if settled {json!(NOW-800)} else {Value::Null},"updated_at_ms":NOW-800,"usage_rollup_at_ms":null,"source_extra":{"preserved":true}})
}
fn key(id: &str) -> RecordKey {
    keys::paid_attempt("key", id)
}
fn rollup_key(id: &str) -> RecordKey {
    keys::paid_rollup(
        (NOW - 1000) / 3_600_000 * 3_600_000,
        "model",
        "metered",
        crate::paid::rollup_shard(id),
    )
}
fn window(reset: i64) -> Value {
    json!({"v":3,"key_id":"key","policy_version":"v1","window_reset_at_ms":reset,"limit_microcredits":-1,"settled_microcredits":0,"reserved_microcredits":0,"pending_count":0,"updated_at_ms":NOW,"source_extra":"retained"})
}
fn backfill(store: &Store, limit: u32) -> PaidBackfillReceipt {
    run(store.authority().backfill_paid_usage(limit, NOW)).unwrap()
}

#[test]
fn historical_fold_is_atomic_and_marked_restart_only_restores_anchored_ttl() {
    let store = Store::default();
    store.put(key("a"), request("a", true));
    let first = backfill(&store, 10);
    assert_eq!(
        (
            first.requests.processed,
            first.requests.rollups_written,
            first.requests.failed,
            first.requests.truncated
        ),
        (1, 1, 0, false)
    );
    let original = store.value(&key("a"));
    assert_eq!(original["usage_rollup_at_ms"], NOW);
    assert_eq!(original["source_extra"], json!({"preserved":true}));
    let rollup = store.value(&rollup_key("a"));
    assert_eq!(rollup["model"], "model");
    assert_eq!(rollup["quota_sum"].as_f64(), Some(1.5));
    assert_eq!(rollup["spend_microcredits"].as_f64(), Some(5.0));
    assert_eq!(rollup["cached_input_tokens"], 2);
    assert_eq!(
        store.row(&key("a")).expires_at_ms,
        Some(NOW - 1000 + crate::PAID_RETENTION_MS)
    );
    // Simulate export/import losing expiry, then construct a fresh authority over the same store.
    store.put(key("a"), original.clone());
    let repeated = backfill(&store, 10);
    assert_eq!(
        (
            repeated.requests.processed,
            repeated.requests.rollups_written
        ),
        (0, 0)
    );
    assert_eq!(store.value(&key("a")), original);
    assert_eq!(store.value(&rollup_key("a")), rollup);
    assert_eq!(
        store.row(&key("a")).expires_at_ms,
        Some(NOW - 1000 + crate::PAID_RETENTION_MS)
    );
}
#[test]
fn inclusive_request_cursor_restarts_before_unprocessed_row_without_double_count() {
    let store = Store::default();
    for id in ["a", "b", "c"] {
        store.put(key(id), request(id, true));
    }
    let first = backfill(&store, 1);
    assert_eq!(
        (
            first.requests.scanned,
            first.requests.processed,
            first.requests.truncated
        ),
        (2, 1, true)
    );
    assert_eq!(
        store.value(&family("rollup_backfill_cursor"))["request_key"],
        json!(["uos_ai", "paid_fallback", "v3", "request", "key", "a"])
    );
    let second = backfill(&store, 1);
    assert_eq!(
        (
            second.requests.scanned,
            second.requests.processed,
            second.requests.truncated
        ),
        (3, 1, true)
    );
    let third = backfill(&store, 1);
    assert_eq!(
        (third.requests.processed, third.requests.truncated),
        (1, false)
    );
    assert!(
        !store
            .rows
            .borrow()
            .contains_key(&family("rollup_backfill_cursor").0)
    );
    for id in ["a", "b", "c"] {
        assert_eq!(store.value(&rollup_key(id))["request_count"], 1);
    }
}
#[test]
fn marked_rows_consume_scan_budget_but_not_fold_budget_and_resume_is_finite() {
    let store = Store::default();
    for index in 0..12 {
        let id = format!("a{index:02}");
        let mut value = request(&id, true);
        value["usage_rollup_at_ms"] = json!(NOW - 1);
        store.put(key(&id), value);
    }
    store.put(key("z"), request("z", true));
    let first = backfill(&store, 1);
    assert_eq!(
        (
            first.requests.scanned,
            first.requests.processed,
            first.requests.truncated
        ),
        (11, 0, true)
    );
    assert_eq!(
        store.value(&family("rollup_backfill_cursor"))["request_key"][5],
        "a09"
    );
    let next = backfill(&store, 1);
    assert_eq!(
        (
            next.requests.processed,
            next.requests.rollups_written,
            next.requests.truncated
        ),
        (1, 1, false)
    );
}
#[test]
fn rollup_race_stops_before_failed_row_and_later_success_cannot_skip_it() {
    let store = Store::default();
    for id in ["a", "b", "c"] {
        store.put(key(id), request(id, true));
    }
    let row: PaidAttempt = decode_json(request("b", true)).unwrap();
    let mut racing = values::merge_rollup(
        None,
        &row,
        "model",
        "metered",
        (NOW - 1000) / 3_600_000 * 3_600_000,
        NOW,
    )
    .unwrap();
    racing["request_count"] = json!(5);
    *store.race.borrow_mut() = Some((rollup_key("b"), racing));
    let first = backfill(&store, 10);
    assert_eq!(
        (
            first.requests.processed,
            first.requests.failed,
            first.requests.truncated
        ),
        (1, 1, true)
    );
    assert!(store.value(&key("b"))["usage_rollup_at_ms"].is_null());
    assert!(store.value(&key("c"))["usage_rollup_at_ms"].is_null());
    assert_eq!(
        store.value(&family("rollup_backfill_cursor"))["request_key"][5],
        "a"
    );
    let next = backfill(&store, 10);
    assert_eq!(next.requests.processed, 2);
    assert_eq!(store.value(&rollup_key("a"))["request_count"], 1);
    assert_eq!(store.value(&rollup_key("b"))["request_count"], 6);
}
#[test]
fn thrown_fold_commit_keeps_prior_marker_and_retry_cannot_duplicate_it() {
    let store = Store::default();
    for id in ["a", "b"] {
        store.put(key(id), request(id, true));
    }
    store.fail(key("b"), true);
    assert!(run(store.authority().backfill_paid_usage(10, NOW)).is_err());
    assert_eq!(store.value(&key("a"))["usage_rollup_at_ms"], NOW);
    assert!(store.value(&key("b"))["usage_rollup_at_ms"].is_null());
    assert_eq!(backfill(&store, 10).requests.processed, 1);
    assert_eq!(store.value(&rollup_key("a"))["request_count"], 1);
}
#[test]
fn pending_row_gets_marker_and_retention_but_no_inferred_spend_or_settlement() {
    let store = Store::default();
    let original = request("a", false);
    store.put(key("a"), original.clone());
    let result = backfill(&store, 10);
    assert_eq!(
        (result.requests.processed, result.requests.rollups_written),
        (1, 0)
    );
    assert_eq!(
        store.value(&key("a"))["billing_state"],
        original["billing_state"]
    );
    assert!(store.value(&key("a"))["spend_microcredits"].is_null());
    assert!(!store.rows.borrow().contains_key(&rollup_key("a").0));
}
#[test]
fn window_batch_skips_inclusive_cursor_and_reports_the_real_final_batch() {
    let store = Store::default();
    for reset in [NOW - 1, NOW, NOW + 1] {
        store.put(keys::paid_window("key", reset), window(reset));
    }
    let first = backfill(&store, 1);
    assert_eq!(
        (first.windows.rewritten, first.windows.truncated),
        (1, true)
    );
    let second = backfill(&store, 1);
    assert_eq!(
        (
            second.windows.scanned,
            second.windows.rewritten,
            second.windows.truncated
        ),
        (2, 1, true)
    );
    let third = backfill(&store, 1);
    assert_eq!(
        (
            third.windows.scanned,
            third.windows.rewritten,
            third.windows.truncated
        ),
        (2, 1, false)
    );
    assert!(
        !store
            .rows
            .borrow()
            .contains_key(&family("rollup_backfill_window_cursor").0)
    );
    for reset in [NOW - 1, NOW, NOW + 1] {
        let key = keys::paid_window("key", reset);
        assert_eq!(store.value(&key), window(reset));
        assert_eq!(
            store.row(&key).expires_at_ms,
            Some(reset + crate::PAID_RETENTION_MS)
        );
    }
}
#[test]
fn failed_window_cas_or_throw_resumes_before_the_unwritten_ttl() {
    for error in [false, true] {
        let store = Store::default();
        for reset in [NOW - 1, NOW, NOW + 1] {
            store.put(keys::paid_window("key", reset), window(reset));
        }
        store.fail(keys::paid_window("key", NOW), error);
        let first = backfill(&store, 10);
        assert_eq!(
            (first.windows.rewritten, first.windows.truncated),
            (1, true)
        );
        assert_eq!(
            store.row(&keys::paid_window("key", NOW)).expires_at_ms,
            None
        );
        assert_eq!(
            store.row(&keys::paid_window("key", NOW + 1)).expires_at_ms,
            None
        );
        let next = backfill(&store, 10);
        assert_eq!((next.windows.rewritten, next.windows.truncated), (2, false));
    }
}
#[test]
fn invalid_windows_skip_and_expired_anchors_get_one_millisecond_not_a_fresh_year() {
    let store = Store::default();
    let mut invalid = window(1);
    invalid["pending_count"] = json!(-1);
    store.put(keys::paid_window("key", 1), invalid.clone());
    store.put(keys::paid_window("key", 2), window(2));
    let result = backfill(&store, 10);
    assert_eq!(
        (
            result.windows.scanned,
            result.windows.rewritten,
            result.windows.truncated
        ),
        (2, 1, false)
    );
    assert_eq!(store.value(&keys::paid_window("key", 1)), invalid);
    assert_eq!(store.row(&keys::paid_window("key", 1)).expires_at_ms, None);
    assert_eq!(
        store.row(&keys::paid_window("key", 2)).expires_at_ms,
        Some(NOW + 1)
    );
}
#[test]
fn marked_ttl_conflict_stops_without_changing_marker_or_following_row() {
    let store = Store::default();
    let mut marked = request("a", true);
    marked["usage_rollup_at_ms"] = json!(NOW - 5);
    store.put(key("a"), marked.clone());
    store.put(key("b"), request("b", true));
    store.fail(key("a"), false);
    let first = backfill(&store, 10);
    assert_eq!(
        (
            first.requests.failed,
            first.requests.processed,
            first.requests.truncated
        ),
        (1, 0, true)
    );
    assert_eq!(store.value(&key("a")), marked);
    assert!(store.value(&key("b"))["usage_rollup_at_ms"].is_null());
    assert_eq!(backfill(&store, 10).requests.rollups_written, 1);
}
#[test]
fn invalid_clock_and_request_identity_never_mutate_paid_state() {
    let store = Store::default();
    let before = request("a", true);
    store.put(key("a"), before.clone());
    assert!(run(store.authority().backfill_paid_usage(10, -1)).is_err());
    assert_eq!(store.value(&key("a")), before);
    let mut wrong = before;
    wrong["reservation"]["attempt_id"] = json!("foreign");
    store.put(key("a"), wrong.clone());
    assert!(run(store.authority().backfill_paid_usage(10, NOW)).is_err());
    assert_eq!(store.value(&key("a")), wrong);
}
#[test]
fn source_valid_rollup_preserves_identity_and_accumulates_exact_fields() {
    let row: PaidAttempt = decode_json(request("a", true)).unwrap();
    assert_eq!(row.reservation.provider, PaidProvider::Metered);
    let first = values::merge_rollup(None, &row, "model", "metered", 100, NOW).unwrap();
    let second =
        values::merge_rollup(Some(&first), &row, "other", "surplus", 200, NOW + 1).unwrap();
    assert_eq!(second["model"], "model");
    assert_eq!(second["provider"], "metered");
    assert_eq!(second["bucket_start_at_ms"], 100);
    assert_eq!(second["request_count"], 2);
    assert_eq!(second["input_tokens"], 20);
    assert_eq!(second["cached_input_tokens"], 4);
    assert_eq!(second["output_tokens"], 6);
    assert_eq!(second["quota_sum"].as_f64(), Some(3.0));
    assert_eq!(second["spend_microcredits"].as_f64(), Some(10.0));
    let invalid = json!({"v":1,"quota_sum":"unknown"});
    assert_eq!(
        values::merge_rollup(Some(&invalid), &row, "model", "metered", 100, NOW).unwrap(),
        first
    );
}

#[test]
fn generated_backfill_rollup_roundtrips_the_existing_live_settlement_dto() {
    let store = Store::default();
    store.put(key("a"), request("a", true));
    assert_eq!(backfill(&store, 10).requests.rollups_written, 1);
    let raw = store.value(&rollup_key("a"));
    let typed: crate::paid::PaidRollup = decode_json(raw.clone()).unwrap();
    assert_eq!(typed.provider_quota, 1.5);
    assert_eq!(typed.spend_microcredits, 5.0);
    let restored = serde_json::to_value(typed).unwrap();
    assert_eq!(restored["quota_sum"].as_f64(), raw["quota_sum"].as_f64());
    assert!(restored.get("provider_quota").is_none());
    for field in [
        "model",
        "provider",
        "request_count",
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
    ] {
        assert_eq!(restored[field], raw[field], "{field}");
    }
}

#[test]
fn genuine_fractional_source_rollup_spend_is_not_rounded_to_fit_the_live_dto() {
    let row: PaidAttempt = decode_json(request("a", true)).unwrap();
    let mut existing = values::merge_rollup(None, &row, "model", "metered", 100, NOW).unwrap();
    existing["spend_microcredits"] = json!(0.25);
    let merged = values::merge_rollup(Some(&existing), &row, "model", "metered", 100, NOW).unwrap();
    assert_eq!(merged["spend_microcredits"].as_f64(), Some(5.25));
    assert_eq!(merged["quota_sum"].as_f64(), Some(3.0));
}

fn pending_for_live_settlement(store: &Store, model: &str) -> PaidAttempt {
    let mut raw = request("a", false);
    raw["model"] = json!(model);
    let row: PaidAttempt = decode_json(raw.clone()).unwrap();
    store.put(key("a"), raw);
    store.put(
        keys::paid_pending("key", "a"),
        json!({"key_id":"key","attempt_id":"a","created_at_ms":NOW-1000,
            "next_reconciliation_at_ms":NOW}),
    );
    let mut active = window(NOW);
    active["reserved_microcredits"] = json!(10);
    active["pending_count"] = json!(1);
    store.put(keys::paid_window("key", NOW), active);
    row
}
fn live_usage() -> crate::paid::PaidUsage {
    crate::paid::PaidUsage {
        provider_quota: 5.0,
        input_tokens: 10,
        cached_input_tokens: Some(2),
        output_tokens: 3,
        correlation: crate::paid::PaidCorrelation::ProviderRequestId("a".into()),
    }
}
#[test]
fn pending_backfill_marker_does_not_block_later_real_settlement_or_double_fold() {
    // Actual frozen source oracle under pinned Bun1.4: a pending backfill marker
    // does not suppress paidFallbackSettlementRollupV3's later actual usage fold.
    let store = Store::default();
    let row = pending_for_live_settlement(&store, "model");
    assert_eq!(backfill(&store, 10).requests.rollups_written, 0);
    assert_eq!(store.value(&key("a"))["usage_rollup_at_ms"], NOW);
    let authority = store.authority();
    assert!(run(authority.settle_paid(&row.reservation, &live_usage(), NOW + 1)).unwrap());
    assert_eq!(store.value(&key("a"))["billing_state"], "settled");
    assert_eq!(store.value(&rollup_key("a"))["request_count"], 1);
    assert_eq!(store.value(&rollup_key("a"))["spend_microcredits"], 5);
    assert!(!run(authority.settle_paid(&row.reservation, &live_usage(), NOW + 2)).unwrap());
    assert_eq!(backfill(&store, 10).requests.rollups_written, 0);
    assert_eq!(store.value(&rollup_key("a"))["request_count"], 1);
}
#[test]
fn later_live_settlement_uses_the_same_source_trimmed_rollup_identity() {
    let store = Store::default();
    let row = pending_for_live_settlement(&store, " model ");
    assert!(
        run(store
            .authority()
            .settle_paid(&row.reservation, &live_usage(), NOW))
        .unwrap()
    );
    let rollup = store.value(&rollup_key("a"));
    assert_eq!(rollup["model"], "model");
    assert_eq!(rollup["quota_sum"].as_f64(), Some(5.0));
    assert_eq!(backfill(&store, 10).requests.rollups_written, 0);
    assert_eq!(store.value(&rollup_key("a"))["request_count"], 1);
}

#[test]
fn source_valid_fractional_rollup_remains_settleable_without_fractional_billing() {
    // Actual source validator + prepareSettlementRollupV3 accepted this imported
    // aggregate in the pinned Bun oracle. Only spend/quota accept fractions;
    // request/token counters remain source-safe integers. Request/window bill 5.
    // Oracle result SHA256 c0b184bd0ac26d7ec2261177b5da5464d3161d104cbd51216ad972b90a784134.
    let store = Store::default();
    let row = pending_for_live_settlement(&store, "model");
    let imported = json!({
        "v": 1,
        "bucket_start_at_ms": (NOW - 1000) / 3_600_000 * 3_600_000,
        "model": "model",
        "provider": "metered",
        "request_count": 1,
        "quota_sum": 1.5,
        "input_tokens": 10,
        "cached_input_tokens": 2,
        "output_tokens": 3,
        "spend_microcredits": 0.25,
        "first_request_at_ms": NOW - 1000,
        "last_request_at_ms": NOW - 1000,
        "updated_at_ms": NOW,
    });
    store.put(rollup_key("a"), imported.clone());
    let authority = store.authority();
    let result = run(authority.settle_paid(&row.reservation, &live_usage(), NOW + 1));
    if result.is_err() {
        assert_eq!(store.value(&rollup_key("a")), imported);
        assert_eq!(store.value(&key("a"))["billing_state"], "pending");
        assert_eq!(
            store.value(&keys::paid_window("key", NOW))["settled_microcredits"],
            0
        );
    }
    assert!(
        matches!(result, Ok(true)),
        "Actual source accepts this fractional historical aggregate: {result:?}"
    );
    let rollup = store.value(&rollup_key("a"));
    assert_eq!(rollup["spend_microcredits"].as_f64(), Some(5.25));
    assert_eq!(rollup["request_count"], 2);
    assert_eq!(rollup["quota_sum"].as_f64(), Some(6.5));
    assert_eq!(rollup["input_tokens"], 20);
    assert_eq!(rollup["cached_input_tokens"], 4);
    assert_eq!(rollup["output_tokens"], 6);
    assert_eq!(store.value(&key("a"))["spend_microcredits"], 5);
    let window = store.value(&keys::paid_window("key", NOW));
    assert_eq!(window["settled_microcredits"], 5);
    assert_eq!(window["reserved_microcredits"], 0);
    assert_eq!(window["pending_count"], 0);
    assert!(!run(authority.settle_paid(&row.reservation, &live_usage(), NOW + 2)).unwrap());
    assert_eq!(store.value(&rollup_key("a")), rollup);
}

#[test]
fn shared_surplus_usage_adapter_matches_all_actual_source_pricing_cases() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../paid_source_usage_cases.json")).unwrap();
    assert_eq!(cases.len(), 26);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut row: PaidAttempt = decode_json(request("a", false)).unwrap();
        row.reservation.provider = PaidProvider::Surplus;
        row.reservation.attempt_id.0 = case["attempt_id"].as_str().unwrap().into();
        row.model = case["model"].as_str().unwrap().into();
        row.quota_per_credit = case["quota_per_credit"].as_i64().unwrap();
        let usage = gateway_core::source_usage::extract_usage_tokens(Some(&case["raw"]));
        let pricing = case
            .get("pricing")
            .filter(|value| !value.is_null())
            .map(gateway_core::source_json::SourceJson::from_serializable)
            .transpose()
            .unwrap();
        let actual = crate::paid::surplus_usage_from_source(&row, usage.as_ref(), pricing.as_ref());
        let expected = &case["expected"];
        if expected.is_null() {
            assert!(actual.is_none(), "{name}: unexpected billing input");
            continue;
        }
        let actual = actual.unwrap_or_else(|| panic!("{name}: source expects billing input"));
        assert_eq!(
            Some(actual.provider_quota),
            expected["provider_quota"].as_f64(),
            "{name}"
        );
        assert_eq!(
            json!(actual.input_tokens),
            expected["input_tokens"],
            "{name}"
        );
        assert_eq!(
            json!(actual.cached_input_tokens),
            expected["cached_input_tokens"],
            "{name}"
        );
        assert_eq!(
            json!(actual.output_tokens),
            expected["output_tokens"],
            "{name}"
        );
        let crate::paid::PaidCorrelation::SurplusReservation {
            attempt_id,
            buyer_cost_micro,
        } = actual.correlation
        else {
            panic!("{name}: wrong correlation");
        };
        assert_eq!(attempt_id, row.reservation.attempt_id, "{name}");
        assert_eq!(
            json!(buyer_cost_micro),
            expected["buyer_cost_micro"],
            "{name}"
        );
    }
}

#[test]
fn fractional_aggregate_spend_does_not_widen_counters_request_or_window_billing() {
    let store = Store::default();
    store.put(key("a"), request("a", true));
    assert_eq!(backfill(&store, 10).requests.rollups_written, 1);
    let raw = store.value(&rollup_key("a"));
    for field in [
        "request_count",
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
    ] {
        let mut invalid = raw.clone();
        invalid[field] = json!(0.25);
        assert!(
            decode_json::<crate::paid::PaidRollup>(invalid).is_err(),
            "{field}"
        );
    }
    for value in [json!(-0.25), json!("0.25"), Value::Null] {
        let mut invalid = raw.clone();
        invalid["spend_microcredits"] = value;
        assert!(decode_json::<crate::paid::PaidRollup>(invalid).is_err());
    }
    let mut invalid_request = request("a", true);
    invalid_request["spend_microcredits"] = json!(0.25);
    assert!(decode_json::<PaidAttempt>(invalid_request).is_err());
    let mut invalid_window = window(NOW);
    invalid_window["settled_microcredits"] = json!(0.25);
    assert!(decode_json::<crate::paid::PaidWindow>(invalid_window).is_err());
}

mod source_control;
