use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    task::{Context, Poll, Waker},
};

use gateway_admin::{
    audit::{self, KeyChange},
    keys::*,
    *,
};
use gateway_auth::{crypto::Secret, passkeys::*, upstream::*, *};
use gateway_core::state::*;
use serde_json::{Value, json};

fn run<F: Future>(future: F) -> F::Output {
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
struct Store {
    rows: RefCell<BTreeMap<String, StoredRecord>>,
    conflict: Cell<bool>,
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        if self.conflict.replace(false) {
            return Ok(CommitOutcome::Conflict);
        }
        let mut rows = self.rows.borrow_mut();
        for check in transition.checks {
            if rows.get(&check.key.0).map(|row| &row.revision) != check.expected_revision.as_ref() {
                return Ok(CommitOutcome::Conflict);
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
#[derive(Default)]
struct Host {
    serial: Cell<u64>,
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        1_000_000
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        let n = self.serial.get() + 1;
        self.serial.set(n);
        Ok((0..len).map(|i| (n + i as u64) as u8).collect())
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture network denied",
            "fixture_network_denied",
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
            "Fixture kernel absent",
            "fixture_kernel_absent",
        ))
    }
}
struct Capabilities {
    pending: bool,
}
impl AdminHost for Capabilities {
    async fn execute(
        &self,
        operation: AdminOperation,
        _: AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        Err(missing_capability(operation))
    }
    async fn prepare_key_deletion(&self, _: &str) -> Result<Vec<RevisionCheck>, GatewayError> {
        if self.pending {
            Err(GatewayError::new(
                409,
                "Cannot delete API key while metered billing is pending or unresolved",
                Some("paid_fallback_billing_outstanding"),
            ))
        } else {
            Ok(Vec::new())
        }
    }
    async fn paid_key_policy(&self, _: &Value) -> Result<PaidKeyFields, GatewayError> {
        Err(GatewayError::unavailable(
            "No pricing fixture",
            "paid_fallback_pricing_unavailable",
        ))
    }
}
fn actor() -> AuthPrincipal {
    AuthPrincipal {
        token: Some(Secret::new("private-credential".into())),
        method: AuthMethod::AdminAllowlist,
        is_admin: true,
        is_super_admin: true,
    }
}

#[test]
fn every_source_admin_endpoint_is_accounted_for() {
    let source = include_str!("../../../../src/handler/index.ts");
    let table = source
        .split("const ADMIN_ROUTES:")
        .nth(1)
        .unwrap()
        .split("\n];")
        .next()
        .unwrap();
    let mut seen = 0;
    for tail in table.split("path: \"").skip(1) {
        let path = tail.split('"').next().unwrap();
        assert!(
            ["GET", "POST", "PATCH", "DELETE"]
                .iter()
                .any(|method| match_route(method, path).is_some()),
            "missing {path}"
        );
        seen += 1;
    }
    assert!(seen >= 45);
    assert_eq!(
        match_route("GET", "/admin/api-keys/key/paid-fallbacks")
            .unwrap()
            .operation,
        AdminOperation::ApiKeyPaidFallbacks
    );
    assert_eq!(
        match_route("POST", "/admin/providers/codex/2/recheck")
            .unwrap()
            .parameter
            .as_deref(),
        Some("2")
    );
    assert!(match_route("POST", "/admin/providers/codex/../../recheck").is_none());
}

#[test]
fn audit_never_persists_credential_material() {
    let raw = json!({"name":"key","usage_limit_requests":50,"token":"private-token","hash":"private-hash","authorization":"Bearer private","prompt":"private"});
    let sanitized = audit::safe_changed(&raw);
    assert_eq!(sanitized, json!({"name":"key","usage_limit_requests":50}));
    let shared = audit::actor(&actor());
    assert_eq!(shared.kind, "shared_admin_credential");
    assert_eq!(shared.principal_id, None);
}

#[test]
fn key_creation_commits_identity_policy_window_and_audit_together() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Capabilities { pending: false };
        let service = KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture-release",
        };
        let result = service
            .create(
                &json!({"name":"Fixture key","usage_limit_requests":0}),
                &actor(),
                "request",
            )
            .await
            .unwrap();
        assert_eq!(result.status, 200);
        let id = result.body["id"].as_str().unwrap();
        let token = result.body["token"].as_str().unwrap();
        assert!(gateway_auth::api_keys::api_key_shape(token));
        assert!(
            store
                .read(&gateway_auth::api_keys::id_key(id))
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .read(&authority_policy_key(id))
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .read(&gateway_authority::keys::api_window(
                    id,
                    &format!("v3:{}", gateway_auth::api_keys::WEEK_MS),
                    1_000_000
                ))
                .await
                .unwrap()
                .is_some()
        );
        let audit = store
            .rows
            .borrow()
            .values()
            .find_map(|row| {
                serde_json::from_value::<KeyChange>(row.json_value().unwrap().clone()).ok()
            })
            .unwrap();
        assert_eq!(audit.action, "create");
        assert!(!serde_json::to_string(&audit).unwrap().contains(token));
        assert!(result.body.get("hash").is_none());
    });
}

#[test]
fn conflicting_creation_writes_nothing() {
    run(async {
        let store = Store::default();
        store.conflict.set(true);
        let host = Host::default();
        let caps = Capabilities { pending: false };
        let service = KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture",
        };
        assert_eq!(
            service
                .create(&json!({"name":"Fixture"}), &actor(), "request")
                .await
                .unwrap_err()
                .status,
            409
        );
        assert!(store.rows.borrow().is_empty());
    });
}

#[test]
fn malformed_or_unpriced_paid_key_never_writes_state() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Capabilities { pending: false };
        let service = KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture",
        };
        for body in [
            json!({"name":"bad\nkey"}),
            json!({"name":"key","paid_fallback_enabled":true}),
            json!({"name":"key","token":"wrong"}),
            json!({"name":"key","window_ms":0}),
        ] {
            assert_eq!(
                service
                    .create(&body, &actor(), "request")
                    .await
                    .unwrap_err()
                    .status,
                400
            );
            assert!(store.rows.borrow().is_empty());
        }
        assert_eq!(service.create(&json!({"name":"key","paid_fallback_enabled":true,"paid_fallback_limit_credits":1}),&actor(),"request").await.unwrap_err().status,503);
        assert!(store.rows.borrow().is_empty());
    });
}

#[test]
fn revoked_deletion_never_discards_pending_billing() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Capabilities { pending: true };
        let service = KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture",
        };
        let created = service
            .create(&json!({"name":"Fixture"}), &actor(), "create")
            .await
            .unwrap();
        let id = created.body["id"].as_str().unwrap();
        assert_eq!(
            service
                .mutate(
                    AdminOperation::ApiKeysDelete,
                    &json!({"id":id}),
                    &actor(),
                    "delete"
                )
                .await
                .unwrap_err()
                .status,
            400
        );
        service
            .mutate(
                AdminOperation::ApiKeysRevoke,
                &json!({"id":id}),
                &actor(),
                "revoke",
            )
            .await
            .unwrap();
        let before = store.rows.borrow().clone();
        assert_eq!(
            service
                .mutate(
                    AdminOperation::ApiKeysDelete,
                    &json!({"id":id}),
                    &actor(),
                    "delete"
                )
                .await
                .unwrap_err()
                .status,
            409
        );
        assert_eq!(*store.rows.borrow(), before);
        let policy = store
            .read(&authority_policy_key(id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            policy.json_value().unwrap()["expires_at_ms"],
            json!(1_000_000)
        );
    });
}

impl gateway_auth::webauthn::WebAuthnCrypto for Host {
    async fn validate_key(
        &self,
        _: &gateway_auth::webauthn::CosePublicKey,
    ) -> Result<(), GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture verifier absent",
            "fixture_verifier_absent",
        ))
    }
    async fn verify_signature(
        &self,
        _: gateway_auth::webauthn::SignatureInput,
    ) -> Result<bool, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture verifier absent",
            "fixture_verifier_absent",
        ))
    }
}
