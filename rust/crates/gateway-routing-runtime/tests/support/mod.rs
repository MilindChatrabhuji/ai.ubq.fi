#[path = "../../../gateway-schema/tests/support/source_catalog.rs"]
mod source_catalog;
use gateway_auth::{AuthPrincipal, crypto::Secret};
use gateway_authority::{
    AuthorityClock, TokenSource, keys,
    paid::{PaidReservation, PaidUsage},
    routing::{CohortProof, PoolAccount, SubscriptionPool},
};
use gateway_core::{
    GatewayError,
    identity::{ApiKeyId, PoolVersionstamp},
    query::{QueryEntry, QueryPage, QueryRequest, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
    tuple_key::TupleKey,
};
use gateway_providers::{AuthMaterial, PrepareOptions};
use gateway_routing_runtime::*;
use serde::Serialize;
use serde_json::Value;
use source_catalog::json as fixture_json;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    },
    task::{Context, Poll, Waker},
};
mod input;
pub use input::{NOW, input};
#[derive(Clone)]
pub struct Store {
    rows: Arc<Mutex<BTreeMap<String, StoredRecord>>>,
    now: Arc<AtomicI64>,
    sequence: Arc<AtomicU64>,
}
impl Store {
    pub fn new() -> Self {
        Self {
            rows: Arc::new(Mutex::new(BTreeMap::new())),
            now: Arc::new(AtomicI64::new(NOW)),
            sequence: Arc::new(AtomicU64::new(1)),
        }
    }
    pub fn seed<T: Serialize>(&self, key: RecordKey, value: T) {
        let revision = self.next_token().unwrap();
        self.rows.lock().unwrap().insert(
            key.0,
            StoredRecord::json(revision, serde_json::to_value(value).unwrap(), None),
        );
    }
    pub fn value(&self, key: RecordKey) -> Value {
        self.rows
            .lock()
            .unwrap()
            .get(&key.0)
            .map(|r| r.json_value().unwrap().clone())
            .unwrap_or(Value::Null)
    }
    pub fn advance(&self, by: i64) {
        self.now.fetch_add(by, Ordering::SeqCst);
    }
}
impl AuthorityClock for Store {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(self.now.load(Ordering::SeqCst))
    }
}
impl TokenSource for Store {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok(format!(
            "fixture-{}",
            self.sequence.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        TupleKey::from_record_key(key)?.validate_stored_key()?;
        Ok(self
            .rows
            .lock()
            .unwrap()
            .get(&key.0)
            .filter(|r| {
                r.expires_at_ms
                    .is_none_or(|e| e > self.now.load(Ordering::SeqCst))
            })
            .cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let mut rows = self.rows.lock().unwrap();
        let now = self.now.load(Ordering::SeqCst);
        let mut checks = BTreeSet::new();
        for check in transition.checks {
            assert!(checks.insert(check.key.0.clone()), "duplicate CAS key");
            if rows
                .get(&check.key.0)
                .filter(|r| r.expires_at_ms.is_none_or(|e| e > now))
                .map(|r| r.revision.clone())
                != check.expected_revision
            {
                return Ok(CommitOutcome::Conflict);
            }
        }
        let mut keys = BTreeSet::new();
        for mutation in &transition.mutations {
            let key = match mutation {
                RecordMutation::Put { key, record } => {
                    record.validate_version()?;
                    key
                }
                RecordMutation::Delete { key } => key,
            };
            TupleKey::from_record_key(key)?.validate_stored_key()?;
            assert!(keys.insert(key.0.clone()), "duplicate mutation");
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
        let query = request.validate()?;
        let mut rows: Vec<_> = self
            .rows
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| QueryEntry {
                key: RecordKey(k.clone()),
                record: v.clone(),
            })
            .collect();
        rows.sort_by_key(|r| {
            TupleKey::from_record_key(&r.key)
                .unwrap()
                .sort_bytes()
                .to_vec()
        });
        if request.reverse {
            rows.reverse();
        }
        let mut accepted = vec![];
        for row in rows {
            if query.accepts_record(&row.key, &row.record)? {
                accepted.push(row);
            }
        }
        let more = accepted.len() > request.limit as usize;
        accepted.truncate(request.limit as usize);
        let next_cursor = if more {
            accepted
                .last()
                .map(|r| query.cursor_after(&r.key))
                .transpose()?
        } else {
            None
        };
        Ok(QueryPage {
            entries: accepted,
            next_cursor,
        })
    }
}
pub fn run<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(result) => return result,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}
pub fn seed_key(store: &Store) {
    store.seed(
        keys::api_policy("key-a"),
        gateway_authority::quota::ApiKeyPolicy {
            v: 3,
            key_id: ApiKeyId("key-a".into()),
            expires_at_ms: -1,
            usage_limit_requests: 10,
            window_ms: gateway_authority::DAY_MS,
            usage_reset_at_ms: NOW + gateway_authority::DAY_MS,
            paid_fallback_enabled: true,
            paid_fallback_limit_microcredits: 10000,
            paid_fallback_quota_per_credit: 1000000,
            paid_fallback_pricing_checked_at_ms: NOW,
            paid_fallback_models: vec![
                "gpt-test".into(),
                "paid-model".into(),
                "deepseek-v4.1-flash".into(),
            ],
            paid_fallback_max_exposure_microcredits: BTreeMap::from([
                ("gpt-test".into(), 1000),
                ("paid-model".into(), 1000),
                ("deepseek-v4.1-flash".into(), 1000),
            ]),
        },
    );
}
pub fn source_account(id: &str) -> gateway_auth::provider_credentials::CodexSourceAccount {
    gateway_auth::provider_credentials::CodexSourceAccount {
        access_token: Secret::new(format!("fixture-access-{id}")),
        refresh_token: Secret::new(format!("fixture-refresh-{id}")),
        account_id: id.into(),
        updated_at_ms: NOW as f64,
        native_owner: None,
    }
}
pub fn seed_pool(store: &Store) {
    let accounts = ["a", "b"].map(source_account).to_vec();
    let source = gateway_auth::provider_credentials::CodexSourcePool {
        accounts: accounts.clone(),
        updated_at_ms: NOW as f64,
    };
    let revision = "pool-original";
    store.rows.lock().unwrap().insert(
        source_key().0,
        StoredRecord::json(revision, source.private_source_value(), None),
    );
    store.seed(
        keys::pool(),
        SubscriptionPool {
            v: 1,
            pool_versionstamp: PoolVersionstamp(revision.into()),
            accounts: accounts
                .iter()
                .map(|account| {
                    let identity = account.identity();
                    PoolAccount {
                        account_id_hash: identity.routing_account_hash,
                        admin_account_hash: identity.administrative_account_hash,
                        credential_version: identity.credential_version,
                        enabled: true,
                    }
                })
                .collect(),
        },
    );
}
pub fn source_key() -> RecordKey {
    gateway_auth::provider_credentials::codex_source_pool_key()
}
pub fn window(store: &Store) -> Value {
    store.value(keys::api_window(
        "key-a",
        &format!("v3:{}", gateway_authority::DAY_MS),
        NOW,
    ))
}
#[derive(Clone)]
pub struct Host {
    pub claude_internal_error: bool,
    pub claude_effective: Arc<Mutex<Vec<Option<gateway_core::js_string::JsString16>>>>,
    pub store: Store,
    pub cancelled: Arc<AtomicBool>,
    pub cancel_wait_after_ms: Option<i64>,
    pub claude: Option<PublishedCredential>,
    pub claude_refused: Option<(
        u16,
        BTreeMap<String, String>,
        gateway_core::source_json::SourceJson,
    )>,
    pub claude_outcomes: Arc<Mutex<VecDeque<ClaudeOutcome>>>,
    pub claude_heads: Arc<AtomicU64>,
    pub consumed_heads: Arc<Mutex<BTreeSet<u64>>>,
    pub claude_evidence: Arc<Mutex<Vec<Option<Vec<u16>>>>>,
}
impl Host {
    pub fn new(store: &Store) -> Self {
        Self {
            claude_internal_error: false,
            claude_effective: Arc::new(Mutex::new(Vec::new())),
            store: store.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
            cancel_wait_after_ms: None,
            claude: None,
            claude_refused: None,
            claude_outcomes: Arc::new(Mutex::new(VecDeque::new())),
            claude_heads: Arc::new(AtomicU64::new(0)),
            consumed_heads: Arc::new(Mutex::new(BTreeSet::new())),
            claude_evidence: Arc::new(Mutex::new(Vec::new())),
        }
    }
}
impl RoutingHost for Host {
    type ClaudeHead = u64;
    fn source_string_collator(&self) -> Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        Arc::new(source_catalog::Collator::captured())
    }
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    fn cancellation_error(&self) -> GatewayError {
        GatewayError::new(499, "fixture cancelled", Some("fixture_cancelled"))
    }
    async fn wait(&self, milliseconds: i64) -> WaitOutcome {
        let elapsed_ms = self.cancel_wait_after_ms.unwrap_or(milliseconds);
        self.store.advance(elapsed_ms);
        let result = if self.cancel_wait_after_ms.is_some() {
            self.cancelled.store(true, Ordering::SeqCst);
            Err(self.cancellation_error())
        } else {
            Ok(())
        };
        WaitOutcome { elapsed_ms, result }
    }
    async fn credential(
        &self,
        input: CredentialRequest,
    ) -> Result<PublishedCredential, GatewayError> {
        if let Some(admission) = input.codex {
            let source = self.store.read(&source_key()).await?.unwrap();
            Ok(PublishedCredential::Scalar {
                material: AuthMaterial {
                    secret: "fixture-access-only".into(),
                    account_id: Some("fixture-account".into()),
                    ..Default::default()
                },
                fence: CredentialFence::Codex {
                    admission,
                    source_key: source_key(),
                    source_revision: source.revision,
                    native_generation: "fixture-generation".into(),
                },
                options: Box::new(PrepareOptions::default()),
            })
        } else if matches!(
            input.provider,
            gateway_core::provider::UpstreamProvider::Surplus
                | gateway_core::provider::UpstreamProvider::Metered
        ) {
            let config = self.store.value(keys::paid_control_config());
            let mut published =
                direct_credential(input.provider, &Secret::new("fixture-paid-secret".into()));
            let PublishedCredential::Scalar { fence, .. } = &mut published else {
                unreachable!()
            };
            *fence = CredentialFence::Paid {
                provider: input.provider,
                owner_id: config["owner_id"].as_str().unwrap_or_default().into(),
                owner_epoch: config["owner_epoch"].as_str().unwrap_or_default().into(),
                configuration_generation: config["generation"].as_str().unwrap_or_default().into(),
                credential_binding: config[if input.provider
                    == gateway_core::provider::UpstreamProvider::Surplus
                {
                    "surplus_binding"
                } else {
                    "openlux_binding"
                }]
                .as_str()
                .unwrap_or_default()
                .into(),
            };
            Ok(published)
        } else {
            Ok(direct_credential(
                input.provider,
                &Secret::new("fixture-secret".into()),
            ))
        }
    }
    async fn ensure_credential_current(
        &self,
        fence: &CredentialFence,
        _principal: &AuthPrincipal,
        _model: &gateway_core::model::ModelId,
    ) -> Result<(), GatewayError> {
        if let CredentialFence::Codex {
            source_key,
            source_revision,
            ..
        } = fence
            && self
                .store
                .read(source_key)
                .await?
                .as_ref()
                .map(|r| &r.revision)
                != Some(source_revision)
        {
            return Err(GatewayError::unavailable(
                "fixture publication changed",
                "fixture_generation_changed",
            ));
        }
        Ok(())
    }
    async fn refresh_codex(
        &self,
        _fence: &CredentialFence,
    ) -> Result<RefreshOutcome, GatewayError> {
        Ok(RefreshOutcome::Unavailable)
    }
    async fn select_claude(
        &self,
        _principal: &AuthPrincipal,
        _model: &gateway_core::model::ModelId,
        _raw: &gateway_core::source_json::SourceJson,
        effective_effort: Option<&gateway_core::js_string::JsString16>,
    ) -> Result<ClaudeSelection, GatewayError> {
        self.claude_effective
            .lock()
            .unwrap()
            .push(effective_effort.cloned());
        if self.claude_internal_error {
            return Ok(ClaudeSelection::InternalServerError);
        }
        if let Some((status, headers, body)) = &self.claude_refused {
            return Ok(ClaudeSelection::Refused {
                status: *status,
                headers: headers.clone(),
                body: body.clone(),
            });
        }
        Ok(self
            .claude
            .as_ref()
            .map(|value| ClaudeSelection::Eligible(Box::new(value.clone())))
            .unwrap_or(ClaudeSelection::NotApplicable))
    }
    async fn observe_claude_response(
        &self,
        _fence: &CredentialFence,
        _model: &gateway_core::model::ModelId,
        _response: ResponseHead,
    ) -> Result<Self::ClaudeHead, GatewayError> {
        Ok(self.claude_heads.fetch_add(1, Ordering::SeqCst))
    }
    async fn finish_claude_response(
        &self,
        head: Self::ClaudeHead,
        evidence: gateway_core::claude::ClaudeErrorEvidence,
    ) -> Result<ClaudeOutcome, GatewayError> {
        if !self.consumed_heads.lock().unwrap().insert(head) {
            return Err(GatewayError::unavailable(
                "Duplicate fixture head",
                "fixture_head_replayed",
            ));
        }
        self.claude_evidence
            .lock()
            .unwrap()
            .push(evidence.prefix().map(<[u16]>::to_vec));
        Ok(self
            .claude_outcomes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(ClaudeOutcome::Preserve))
    }
    async fn recover_codex(
        &self,
        _proof: &CohortProof,
        _model: &gateway_core::model::ModelId,
    ) -> Result<CodexRecovery, GatewayError> {
        Ok(CodexRecovery::Declined)
    }
    async fn lookup_paid(
        &self,
        _reservation: &PaidReservation,
    ) -> Result<Option<PaidUsage>, GatewayError> {
        Ok(None)
    }
}
