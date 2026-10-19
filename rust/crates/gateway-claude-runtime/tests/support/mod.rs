#![cfg(not(target_arch = "wasm32"))]
use gateway_admin_runtime::{
    claude::{self, AccountBinding, AccountStore, Credential, CredentialKind},
    claude_access,
};
use gateway_auth::{
    AuthHost,
    upstream::{AuthUpstreamRequest, AuthUpstreamResponse},
    webauthn::{CosePublicKey, SignatureInput, WebAuthnCrypto},
};
use gateway_catalog_runtime::ProviderBinding;
use gateway_claude_runtime::*;
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RevisionCheck, StoredRecord,
    },
};
use gateway_providers::Headers;
use gateway_schema::catalog::ProviderCatalog;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    cmp::Ordering,
    future::Future,
    path::Path,
    rc::Rc,
    sync::Arc,
    task::{Context, Poll, Waker},
};

pub const MODEL: &str = "claude-fixture";
pub const KEY: &str = "fixture-owner";
pub const NOW: i64 = 1_800_000_000_000;
pub type Action = Box<dyn FnOnce()>;
pub fn run<T>(future: impl Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(result) = future.as_mut().poll(&mut cx) {
            return result;
        }
    }
}
#[derive(Clone)]
pub struct Store {
    db: Rc<RefCell<Connection>>,
    pub now: Rc<Cell<i64>>,
    pub before_commit: Rc<RefCell<Option<Action>>>,
    pub after_read: Rc<RefCell<Option<(RecordKey, Action)>>>,
    pub commits: Rc<Cell<usize>>,
}
impl Store {
    pub fn new() -> Self {
        Self::from(Connection::open_in_memory().unwrap())
    }
    pub fn open(path: &Path) -> Self {
        Self::from(Connection::open(path).unwrap())
    }
    fn from(db: Connection) -> Self {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY,payload TEXT NOT NULL)",
        )
        .unwrap();
        Self {
            db: Rc::new(RefCell::new(db)),
            now: Rc::new(Cell::new(NOW)),
            before_commit: Rc::default(),
            after_read: Rc::default(),
            commits: Rc::new(Cell::new(0)),
        }
    }
    pub fn put(&self, key: &RecordKey, rev: &str, value: Value) {
        self.put_record(key, StoredRecord::json(rev, value, None));
    }
    pub fn put_record(&self, key: &RecordKey, row: StoredRecord) {
        self.db.borrow().execute("INSERT INTO records(key,payload) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",params![key.0,serde_json::to_string(&row).unwrap()]).unwrap();
    }
    pub fn get(&self, key: &RecordKey) -> Option<StoredRecord> {
        let raw: Option<String> = self
            .db
            .borrow()
            .query_row(
                "SELECT payload FROM records WHERE key=?1",
                params![key.0],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        raw.map(|s| serde_json::from_str::<StoredRecord>(&s).unwrap())
            .filter(|r| r.expires_at_ms.is_none_or(|at| at > self.now.get()))
    }
    pub fn roster(&self) -> AccountStore {
        claude::decode_roster_record(
            &self.get(&claude::account_store_key()).unwrap(),
            self.now.get(),
        )
        .unwrap()
        .unwrap()
    }
    pub fn quota(&self, account: &AccountBinding) -> Option<quota::QuotaState> {
        self.get(&quota_key(account))
            .and_then(|r| quota::parse_record(&r, self.now.get()).unwrap())
    }
    pub fn allow(&self, ids: Value) {
        self.put(
            &claude_access::policy_key(),
            "access-update",
            json!({"v":1,"source":"kv","allowed_key_ids":ids,"updated_at_ms":NOW}),
        );
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        let result = self.get(key);
        let action = {
            let mut hook = self.after_read.borrow_mut();
            if hook.as_ref().is_some_and(|(target, _)| target == key) {
                hook.take().map(|(_, action)| action)
            } else {
                None
            }
        };
        if let Some(action) = action {
            action()
        }
        Ok(result)
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let action = self.before_commit.borrow_mut().take();
        if let Some(action) = action {
            action()
        }
        let mut db = self.db.borrow_mut();
        let tx = db.transaction().unwrap();
        for check in &transition.checks {
            let raw: Option<String> = tx
                .query_row(
                    "SELECT payload FROM records WHERE key=?1",
                    params![check.key.0],
                    |r| r.get(0),
                )
                .optional()
                .unwrap();
            let current = raw
                .and_then(|s| serde_json::from_str::<StoredRecord>(&s).ok())
                .filter(|r| r.expires_at_ms.is_none_or(|at| at > self.now.get()));
            if current.as_ref().map(|r| &r.revision) != check.expected_revision.as_ref() {
                return Ok(CommitOutcome::Conflict);
            }
        }
        for mutation in transition.mutations {
            match mutation {
                gateway_core::state::RecordMutation::Put { key, record } => {
                    tx.execute("INSERT INTO records(key,payload) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",params![key.0,serde_json::to_string(&record).unwrap()]).unwrap();
                }
                gateway_core::state::RecordMutation::Delete { key } => {
                    tx.execute("DELETE FROM records WHERE key=?1", params![key.0])
                        .unwrap();
                }
            }
        }
        tx.commit().unwrap();
        self.commits.set(self.commits.get() + 1);
        Ok(CommitOutcome::Committed)
    }
}
pub fn account(n: u8) -> AccountBinding {
    let credential = Credential {
        kind: CredentialKind::Oauth,
        secret: Arc::new(claude::ClaudeSourceSecret::from_source(
            JsString16::from_utf8(&format!("fixture-secret-{n}")),
        )),
        hint: "configured".into(),
        label: None,
        source: "kv".into(),
        updated_at_ms: Some(NOW),
    };
    AccountBinding {
        account_id: format!("00000000-0000-4000-8000-{n:012x}"),
        account_cohort_id: format!("00000000-0000-4000-9000-{n:012x}"),
        evidence_generation: format!("00000000-0000-4000-a000-{n:012x}"),
        credential_fingerprint: claude::fingerprint(&credential, None),
        credential,
        workspace: None,
    }
}
pub fn seed(store: &Store, accounts: Vec<AccountBinding>) -> PoolConfig {
    let roster = AccountStore {
        v: 1,
        active_account_id: accounts.first().map(|a| a.account_id.clone()),
        accounts,
        active_reason: "first_configured".into(),
        updated_at_ms: NOW,
    };
    store.put_record(
        &claude::account_store_key(),
        claude::encode_roster_record("roster-1", &roster, None).unwrap(),
    );
    store.put(&native_key(), "native-1", json!({"fixture":"owner"}));
    store.allow(json!([KEY]));
    PoolConfig {
        allowed_key_ids: vec![KEY.into()],
        replay_scope: "fixture-principal-scope".into(),
        ..PoolConfig::default()
    }
}
pub fn native_key() -> RecordKey {
    gateway_auth::store::key(json!(["uos_ai", "fixture_claude_native_owner"]))
}
pub struct Host {
    pub store: Store,
    pub random: Cell<u64>,
    pub catalog_calls: Cell<usize>,
    pub catalog_action: RefCell<Option<Action>>,
    pub catalog: RefCell<ProviderCatalog>,
    pub workspace_calls: Cell<usize>,
    pub workspace_action: RefCell<Option<Action>>,
    pub workspace: RefCell<WorkspaceResponse>,
    pub accepted: RefCell<Vec<AcceptedObservation>>,
    pub health: RefCell<Vec<HealthObservation>>,
    pub fail_telemetry: Cell<bool>,
}
impl Host {
    pub fn new(store: &Store) -> Self {
        Self{store:store.clone(),random:Cell::new(50),catalog_calls:Cell::new(0),catalog_action:RefCell::default(),catalog:RefCell::new(ProviderCatalog{models:vec![gateway_core::source_json::SourceJson::from_serializable(&json!({"id":MODEL,"supports_disabled_thinking":true,"supported_reasoning_levels":["low","high","Custom"]})).unwrap()],updated_at_ms:Some(NOW),configured:true,available:true,stale:false}),workspace_calls:Cell::new(0),workspace_action:RefCell::default(),workspace:RefCell::new(WorkspaceResponse{status:200,body:json!({"data":[{"id":"wrkspc_first","name":"Other"},{"id":"wrkspc_default","name":"Default"}]}).to_string()}),accepted:RefCell::default(),health:RefCell::default(),fail_telemetry:Cell::new(false)}
    }
}
impl WebAuthnCrypto for Host {
    async fn validate_key(&self, _: &CosePublicKey) -> Result<(), GatewayError> {
        Err(GatewayError::unavailable(
            "Not a ceremony fixture",
            "fixture_crypto_unavailable",
        ))
    }
    async fn verify_signature(&self, _: SignatureInput) -> Result<bool, GatewayError> {
        Err(GatewayError::unavailable(
            "Not a ceremony fixture",
            "fixture_crypto_unavailable",
        ))
    }
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        self.store.now.get()
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        let n = self.random.get() + 1;
        self.random.set(n);
        Ok((0..length)
            .map(|i| ((n >> ((i % 8) * 8)) & 255) as u8)
            .collect())
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        Err(GatewayError::unavailable(
            "No external auth in fixture",
            "fixture_auth_unavailable",
        ))
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        Err(GatewayError::unavailable(
            "No kernel in fixture",
            "fixture_kernel_unavailable",
        ))
    }
}
impl ClaudePoolHost for Host {
    fn compare_principals(
        &self,
        left: &JsString16,
        right: &JsString16,
    ) -> Result<Ordering, GatewayError> {
        // This fixture has one principal. Its exact same-operand result is
        // known; every other operand is outside this finite source oracle.
        let principal = JsString16::from_utf8(KEY);
        if left != &principal || right != &principal {
            return Err(GatewayError::unavailable(
                "Unknown finite Claude principal oracle operand.",
                "fixture_claude_principal_oracle_unknown_operand",
            ));
        }
        Ok(Ordering::Equal)
    }
    fn parse_retry_after_date(&self, raw: &str) -> Option<i64> {
        (raw == "fixture-date").then_some(NOW + 1234)
    }
    async fn credential_checks(
        &self,
        _: &AccountBinding,
    ) -> Result<Vec<RevisionCheck>, GatewayError> {
        let key = native_key();
        Ok(vec![gateway_auth::store::check(
            &key,
            self.store.get(&key).as_ref(),
        )])
    }
    async fn catalog(
        &self,
        binding: &AccountBinding,
        identity: &ProviderBinding,
    ) -> Result<ProviderCatalog, GatewayError> {
        assert_eq!(
            binding.credential_fingerprint,
            claude::fingerprint(&binding.credential, binding.workspace.as_ref())
        );
        assert!(!identity.identity.is_empty());
        self.catalog_calls.set(self.catalog_calls.get() + 1);
        let action = self.catalog_action.borrow_mut().take();
        if let Some(action) = action {
            action()
        }
        Ok(self.catalog.borrow().clone())
    }
    async fn workspace_list(&self, _: &AccountBinding) -> Result<WorkspaceResponse, GatewayError> {
        self.workspace_calls.set(self.workspace_calls.get() + 1);
        let action = self.workspace_action.borrow_mut().take();
        if let Some(action) = action {
            action()
        }
        Ok(self.workspace.borrow().clone())
    }
    async fn accepted_observation(&self, event: &AcceptedObservation) -> Result<(), GatewayError> {
        self.accepted.borrow_mut().push(event.clone());
        if self.fail_telemetry.get() {
            Err(GatewayError::unavailable(
                "Optional subscriber down",
                "fixture_telemetry_unavailable",
            ))
        } else {
            Ok(())
        }
    }
    async fn health_observation(&self, event: &HealthObservation) -> Result<(), GatewayError> {
        self.health.borrow_mut().push(event.clone());
        if self.fail_telemetry.get() {
            Err(GatewayError::unavailable(
                "Optional subscriber down",
                "fixture_telemetry_unavailable",
            ))
        } else {
            Ok(())
        }
    }
}
pub fn raw() -> gateway_core::source_json::SourceJson {
    gateway_core::source_json::SourceJson::from_serializable(
        &json!({"model":MODEL,"input":"fixture"}),
    )
    .unwrap()
}
pub fn fixture_effort(raw: &gateway_core::source_json::SourceJson) -> Option<JsString16> {
    gateway_core::source_serialization::member(raw, "reasoning")
        .and_then(|value| gateway_core::source_serialization::member(&value, "effort"))
        .as_ref()
        .and_then(gateway_core::source_serialization::string)
}
pub fn selected(
    session: &ClaudePoolSession,
    store: &Store,
    host: &Host,
    raw: &gateway_core::source_json::SourceJson,
) -> SelectedAccount {
    match run(session.select(
        store,
        host,
        SelectionInput {
            key_id: KEY,
            model: &MODEL.into(),
            raw,
            effective_effort: fixture_effort(raw),
            selection: None,
        },
    ))
    .unwrap()
    {
        PoolSelection::Eligible(selected) => *selected,
        _ => panic!("expected a Claude account"),
    }
}
pub fn head(status: u16, headers: Headers, at: i64) -> ResponseObservation {
    ResponseObservation {
        status,
        headers,
        provider_request_id: Some("fixture-provider-id".into()),
        observed_at_ms: at,
    }
}
pub fn exhausted(at: i64) -> Headers {
    Headers::from([
        (
            "anthropic-ratelimit-unified-5h-status".into(),
            "limited".into(),
        ),
        (
            "anthropic-ratelimit-unified-5h-reset".into(),
            ((at + 60_000) / 1000).to_string(),
        ),
    ])
}
pub fn apply(
    session: &ClaudePoolSession,
    store: &Store,
    host: &Host,
    selected: &SelectedAccount,
    status: u16,
    headers: Headers,
    at: i64,
) -> OutcomeDecision {
    let head =
        run(session.observe_response(store, host, selected, head(status, headers, at))).unwrap();
    run(session.after_outcome(store, host, head, error_evidence(None, false))).unwrap()
}
pub fn error_evidence(prefix: Option<Vec<u16>>, complete: bool) -> response::ErrorEvidence {
    response::ErrorEvidence::from_prefix(prefix, complete).unwrap()
}
