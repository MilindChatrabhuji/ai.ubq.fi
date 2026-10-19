use super::auth;
use auth::{AuthHost, AuthRequest, GatewayError, passkeys::*, session_index, upstream::*};
use gateway_core::state::*;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    task::{Context, Poll, Waker},
};

pub fn run<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}

#[derive(Default)]
pub struct Store {
    pub rows: RefCell<BTreeMap<String, StoredRecord>>,
    pub history: RefCell<Vec<AtomicTransition>>,
    pub conflict: Cell<bool>,
    pub unknown_before: Cell<bool>,
    pub unknown_after: Cell<bool>,
}
impl Store {
    pub fn put<T: serde::Serialize>(
        &self,
        key: RecordKey,
        value: &T,
        revision: &str,
        expiry: Option<i64>,
    ) {
        self.rows.borrow_mut().insert(
            key.0,
            StoredRecord::json(revision, serde_json::to_value(value).unwrap(), expiry),
        );
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, tx: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        self.history.borrow_mut().push(tx.clone());
        if self.conflict.replace(false) {
            return Ok(CommitOutcome::Conflict);
        }
        if self.unknown_before.replace(false) {
            return Err(GatewayError::unavailable(
                "Synthetic unknown write outcome",
                "fixture_unknown_write",
            ));
        }
        let mut rows = self.rows.borrow_mut();
        for check in tx.checks {
            if rows.get(&check.key.0).map(|row| &row.revision) != check.expected_revision.as_ref() {
                return Ok(CommitOutcome::Conflict);
            }
        }
        for mutation in tx.mutations {
            match mutation {
                RecordMutation::Put { key, record } => {
                    rows.insert(key.0, record);
                }
                RecordMutation::Delete { key } => {
                    rows.remove(&key.0);
                }
            }
        }
        if self.unknown_after.replace(false) {
            return Err(GatewayError::unavailable(
                "Synthetic unknown write outcome",
                "fixture_unknown_write",
            ));
        }
        Ok(CommitOutcome::Committed)
    }
}

pub struct Host {
    pub now: Cell<i64>,
    serial: Cell<u64>,
}
impl Default for Host {
    fn default() -> Self {
        Self {
            now: Cell::new(1_000_000),
            serial: Cell::new(1),
        }
    }
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        self.now.get()
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        let serial = self.serial.get();
        self.serial.set(serial + 1);
        Ok((0..length)
            .map(|index| serial.wrapping_add(index as u64) as u8)
            .collect())
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        Err(GatewayError::unavailable(
            "Synthetic fixture denies network",
            "fixture_denied",
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
            "Synthetic fixture denies policy creation",
            "fixture_denied",
        ))
    }
}
impl auth::webauthn::WebAuthnCrypto for Host {
    async fn validate_key(&self, _: &auth::webauthn::CosePublicKey) -> Result<(), GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture does not execute ceremonies",
            "fixture_denied",
        ))
    }
    async fn verify_signature(
        &self,
        _: auth::webauthn::SignatureInput,
    ) -> Result<bool, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture does not execute ceremonies",
            "fixture_denied",
        ))
    }
}
pub fn request(token: &str) -> AuthRequest {
    AuthRequest {
        method: "POST".into(),
        url: "https://ai.ubq.fi/api/auth/logout".into(),
        headers: BTreeMap::from([("authorization".into(), format!("Bearer {token}"))]),
        ..Default::default()
    }
}
pub fn user(store: &Store, admin: bool, revision: &str) {
    store.put(
        key("users", "fixture-user"),
        &PasskeyUser {
            id: "fixture-user".into(),
            handle: "operator".into(),
            is_admin: admin,
            credential_ids: vec!["fixture-credential".into()],
            created_at_ms: 1,
            updated_at_ms: 1,
        },
        revision,
        None,
    );
}
pub fn session(token: &str, expiry: i64) -> PasskeySession {
    PasskeySession {
        token: token.into(),
        user_id: "fixture-user".into(),
        created_at_ms: 1,
        expires_at_ms: expiry,
        audience_origin: None,
    }
}
pub fn install(
    store: &Store,
    session: &PasskeySession,
    revision: &str,
    expiry: Option<i64>,
    indexed: bool,
) {
    store.put(key("sessions", &session.token), session, revision, expiry);
    if indexed {
        let index = session_index::record_for_session(session, revision, expiry).unwrap();
        store.rows.borrow_mut().insert(
            session_index::index_key(&session_index::digest(&session.token))
                .unwrap()
                .0,
            index,
        );
    }
}
