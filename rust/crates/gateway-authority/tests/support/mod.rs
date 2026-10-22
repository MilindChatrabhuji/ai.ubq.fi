//! Deterministic conformance store, not a Worker/runtime acceptance substitute.
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use gateway_authority::quota::ApiKeyPolicy;
use gateway_authority::routing::{
    AdmittedAccount, PoolAccount, QuotaBlock, QuotaBlockSource, RouteSelection, SubscriptionPool,
};
use gateway_authority::{Authority, AuthorityClock, TokenSource};
use gateway_core::GatewayError;
use gateway_core::identity::{
    ApiKeyId, PoolVersionstamp, RoutingAccountHash, SubscriptionSelectionHash,
};
use gateway_core::provider::CodexQuotaClass;
use gateway_core::state::{
    AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
};
use gateway_core::tuple_key::TupleKey;
use serde::Serialize;

pub const NOW: i64 = 1_792_329_600_000;

#[derive(Clone)]
pub struct MemoryStore {
    rows: Arc<Mutex<BTreeMap<String, StoredRecord>>>,
    now: Arc<AtomicI64>,
    pub conflicts: Arc<AtomicUsize>,
    sequence: Arc<AtomicU64>,
    race: Arc<Mutex<Option<(RecordKey, serde_json::Value)>>>,
    jump: Arc<Mutex<Option<(RecordKey, i64)>>>,
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self {
            rows: Arc::new(Mutex::new(BTreeMap::new())),
            now: Arc::new(AtomicI64::new(NOW)),
            conflicts: Arc::new(AtomicUsize::new(0)),
            sequence: Arc::new(AtomicU64::new(1)),
            race: Arc::new(Mutex::new(None)),
            jump: Arc::new(Mutex::new(None)),
        }
    }
}

impl MemoryStore {
    pub fn seed_with_revision<T: Serialize>(&self, key: RecordKey, value: &T, revision: &str) {
        self.rows.lock().unwrap().insert(
            key.0,
            StoredRecord::json(revision, serde_json::to_value(value).unwrap(), None),
        );
    }
    pub fn seed<T: Serialize>(&self, key: RecordKey, value: &T) {
        self.rows.lock().unwrap().insert(
            key.0,
            StoredRecord::json(
                format!("seed-{}", self.sequence.fetch_add(1, Ordering::SeqCst)),
                serde_json::to_value(value).unwrap(),
                None,
            ),
        );
    }
    pub fn row(&self, key: &RecordKey) -> Option<StoredRecord> {
        self.rows.lock().unwrap().get(&key.0).cloned()
    }
    pub fn seed_record(&self, key: RecordKey, record: StoredRecord) {
        self.rows.lock().unwrap().insert(key.0, record);
    }
    pub fn clock(&self, now: i64) {
        self.now.store(now, Ordering::SeqCst);
    }
    pub fn race<T: Serialize>(&self, key: RecordKey, value: &T) {
        *self.race.lock().unwrap() = Some((key, serde_json::to_value(value).unwrap()));
    }
    pub fn is_empty(&self) -> bool {
        self.rows.lock().unwrap().is_empty()
    }
    pub fn jump_on_read(&self, key: RecordKey, now: i64) {
        *self.jump.lock().unwrap() = Some((key, now));
    }
}

impl AuthorityClock for MemoryStore {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(self.now.load(Ordering::SeqCst))
    }
}

impl AuthorityStore for MemoryStore {
    fn read(
        &self,
        key: &RecordKey,
    ) -> impl Future<Output = Result<Option<StoredRecord>, GatewayError>> {
        let mut jump = self.jump.lock().unwrap();
        if jump.as_ref().is_some_and(|(target, _)| target == key)
            && let Some((_, now)) = jump.take()
        {
            self.clock(now);
        }
        drop(jump);
        let key_valid = TupleKey::from_record_key(key).and_then(|key| key.validate_stored_key());
        let row = self.rows.lock().unwrap().get(&key.0).cloned();
        let now = self.now.load(Ordering::SeqCst);
        async move {
            key_valid?;
            if let Some(row) = &row {
                row.validate_version()?;
            }
            Ok(row.filter(|row| row.expires_at_ms.is_none_or(|expiry| expiry > now)))
        }
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        if self
            .conflicts
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                count.checked_sub(1)
            })
            .is_ok()
        {
            return Ok(CommitOutcome::Conflict);
        }
        let mut rows = self.rows.lock().unwrap();
        let now = self.now.load(Ordering::SeqCst);
        if let Some((key, value)) = self.race.lock().unwrap().take() {
            rows.insert(
                key.0,
                StoredRecord::json(
                    format!("race-{}", self.sequence.fetch_add(1, Ordering::SeqCst)),
                    value,
                    None,
                ),
            );
        }
        let checked: BTreeSet<_> = transition
            .checks
            .iter()
            .map(|check| check.key.0.clone())
            .collect();
        let mut mutated = BTreeSet::new();
        for check in &transition.checks {
            TupleKey::from_record_key(&check.key)?.validate_stored_key()?;
            let actual = rows
                .get(&check.key.0)
                .filter(|row| row.expires_at_ms.is_none_or(|expiry| expiry > now))
                .map(|row| row.revision.clone());
            if actual != check.expected_revision {
                return Ok(CommitOutcome::Conflict);
            }
        }
        for mutation in &transition.mutations {
            let key = match mutation {
                RecordMutation::Put { key, .. } | RecordMutation::Delete { key } => key,
            };
            assert!(
                checked.contains(&key.0),
                "mutation without a checked strong read"
            );
            assert!(mutated.insert(key.0.clone()), "duplicate mutation");
            if let RecordMutation::Put { record, .. } = mutation {
                record.validate_version()?;
                assert!(!record.revision.is_empty());
            }
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

#[derive(Clone, Default)]
pub struct Tokens(Arc<AtomicU64>);
impl TokenSource for Tokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok(format!(
            "fixture-opaque-{}",
            self.0.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
pub type TestAuthority = Authority<MemoryStore, Tokens>;
struct FixtureCollator;
impl gateway_schema::aliases::SourceStringCollator for FixtureCollator {
    fn compare(
        &self,
        left: &gateway_core::js_string::JsString16,
        right: &gateway_core::js_string::JsString16,
    ) -> Result<std::cmp::Ordering, GatewayError> {
        // Fixed test input ordering only; pinned locale-equivalence survivors are tested separately.
        Ok(left.as_units().cmp(right.as_units()))
    }
}
pub fn authority(store: &MemoryStore) -> TestAuthority {
    Authority::with_clock(store.clone(), Tokens::default(), store.clone())
        .with_source_string_collator(Arc::new(FixtureCollator))
}

pub fn run<F: Future>(future: F) -> F::Output {
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(result) => return result,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

pub fn pool() -> SubscriptionPool {
    SubscriptionPool {
        v: 1,
        pool_versionstamp: PoolVersionstamp("pool-original".to_owned()),
        accounts: ["a", "b"]
            .into_iter()
            .map(|id| {
                let identity = source_account(id, false).identity();
                PoolAccount {
                    account_id_hash: identity.routing_account_hash,
                    admin_account_hash: identity.administrative_account_hash,
                    credential_version: identity.credential_version,
                    enabled: true,
                }
            })
            .collect(),
    }
}
pub fn source_account(
    id: &str,
    refreshed: bool,
) -> gateway_auth::provider_credentials::CodexSourceAccount {
    use gateway_auth::crypto::Secret;
    gateway_auth::provider_credentials::CodexSourceAccount {
        access_token: Secret::new(format!("fixture-access-{id}-{}", u8::from(refreshed))),
        refresh_token: Secret::new(format!("fixture-refresh-{id}")),
        account_id: id.into(),
        updated_at_ms: NOW as f64,
        native_owner: None,
    }
}
pub fn routing_hash(id: &str) -> RoutingAccountHash {
    source_account(id, false).identity().routing_account_hash
}
pub fn admin_hash(id: &str) -> SubscriptionSelectionHash {
    source_account(id, false)
        .identity()
        .administrative_account_hash
}
pub fn seed_pool(store: &MemoryStore, pool: &SubscriptionPool) {
    let candidates = [
        source_account("a", false),
        source_account("a", true),
        source_account("b", false),
        source_account("b", true),
    ];
    let accounts = pool
        .accounts
        .iter()
        .map(|configured| {
            candidates
                .iter()
                .find(|source| {
                    let identity = source.identity();
                    identity.routing_account_hash == configured.account_id_hash
                        && identity.credential_version == configured.credential_version
                })
                .expect("fixture normalized pool must match actual fixture source credentials")
                .clone()
        })
        .collect();
    let source = gateway_auth::provider_credentials::CodexSourcePool {
        accounts,
        updated_at_ms: NOW as f64,
    };
    store.seed_with_revision(
        gateway_auth::provider_credentials::codex_source_pool_key(),
        &source.private_source_value(),
        &pool.pool_versionstamp.0,
    );
    store.seed(gateway_authority::keys::pool(), pool);
}
pub fn policy() -> ApiKeyPolicy {
    ApiKeyPolicy {
        v: 3,
        key_id: ApiKeyId("key-a".to_owned()),
        expires_at_ms: -1,
        usage_limit_requests: 2,
        window_ms: gateway_authority::DAY_MS,
        usage_reset_at_ms: NOW + gateway_authority::DAY_MS,
        paid_fallback_enabled: true,
        paid_fallback_limit_microcredits: 10_000,
        paid_fallback_quota_per_credit: 1_000_000,
        paid_fallback_pricing_checked_at_ms: NOW,
        paid_fallback_models: vec!["gpt-test".into(), "paid-model".into()],
        paid_fallback_max_exposure_microcredits: BTreeMap::from([
            ("gpt-test".into(), 1_000),
            ("paid-model".into(), 1_000),
        ]),
    }
}
pub fn admitted(authority: &TestAuthority) -> AdmittedAccount {
    match run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).unwrap()
    {
        RouteSelection::Eligible(account) => account,
        _ => panic!("expected eligible account"),
    }
}
pub fn block() -> QuotaBlock {
    QuotaBlock {
        blocked_until_ms: NOW + 60_000,
        source: QuotaBlockSource::BodyResetsAt,
        observed_at_ms: Some(NOW),
        legacy_fallback: false,
        reset_at_ms: Some(NOW + 60_000),
        reset_is_stable: true,
        reset_ambiguous: false,
        recovery_pending: false,
    }
}
