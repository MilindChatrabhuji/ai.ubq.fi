//! Actual original admin/admission/start + genuine MAC peer; verifier itself is readonly.
use super::*;
use crate::native_control::import::{
    AuthenticatedNativeImport, ImportCustodyStartedRequest, NativeImportClaim, NativeImportMode,
};
use gateway_auth::{
    native::{NATIVE_CONTROL_PATH, NATIVE_RENEWAL_AUTHORITY_PATH},
    native_auth::AuthenticatedNativeOwner,
};
use std::sync::atomic::AtomicBool;
#[derive(Default)]
struct UniqueTokens(AtomicUsize);
impl TokenSource for UniqueTokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok(format!(
            "custody-fixture-{}",
            self.0.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
#[derive(Default)]
struct CancelNow(AtomicBool);
impl NativeRenewalCancellation for CancelNow {
    fn cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
#[derive(Default)]
struct CountReplay {
    nonces: Mutex<BTreeSet<String>>,
    calls: AtomicUsize,
}
impl NativeNonceAuthority for CountReplay {
    async fn consume_nonce(
        &self,
        _: &str,
        nonce: &str,
        _: i64,
        _: i64,
    ) -> Result<(), GatewayError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.nonces.lock().unwrap().insert(nonce.into()) {
            Ok(())
        } else {
            Err(fail())
        }
    }
}
struct Fixture {
    store: Store,
    authority: Authority<Store, UniqueTokens>,
    id: NativeTransportIdentity,
    registered: RegisteredRenewalOwner,
    cfg: AuthConfig,
    cancel: CancelNow,
    hash: String,
    replay: CountReplay,
}
impl Fixture {
    fn new() -> Self {
        let store = Store::default();
        let id = identity();
        let hash = seed(&store, &id);
        let authority =
            Authority::with_clock(store.clone(), UniqueTokens::default(), store.clone());
        Self {
            store,
            authority,
            id,
            registered: RegisteredRenewalOwner::configured(
                "native-owner".into(),
                "/tmp/native-import-synthetic-owner".into(),
            )
            .unwrap(),
            cfg: config(),
            cancel: CancelNow::default(),
            hash,
            replay: CountReplay::default(),
        }
    }
    fn control(&self) -> NativeRenewalAuthority<'_, Store, UniqueTokens, CancelNow> {
        NativeRenewalAuthority::configured(
            &self.authority,
            &self.id,
            &self.registered,
            &self.cfg,
            &self.cancel,
        )
    }
    async fn prepare(
        &self,
        start: bool,
    ) -> (
        AuthenticatedNativeImport,
        NativeImportClaim,
        ImportCustodyStartedRequest,
    ) {
        self.prepare_version(start, false).await
    }
    async fn prepare_version(
        &self,
        start: bool,
        v3: bool,
    ) -> (
        AuthenticatedNativeImport,
        NativeImportClaim,
        ImportCustodyStartedRequest,
    ) {
        let token = session_setup(&self.store, true, true);
        let actor = actor::authenticate_admin_actor(
            &self.authority,
            &Host::new(&self.store),
            &self.cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let control = self.control();
        let target = NativeImportTarget::ExistingAccount {
            account_id_hash: self.hash.clone(),
        };
        let prepared = if v3 {
            control.prepare_import(&actor, target).await.unwrap()
        } else {
            control
                .prepare_import_legacy_v2_fixture(&actor, target)
                .await
                .unwrap()
        };
        let body = b"ORIGINAL_SYNTHETIC_CUSTODY_BODY";
        let admitted = control
            .admit_import(header(&self.id, prepared.metadata(), body, 42).await)
            .await
            .unwrap();
        let proof = control.finish_import(admitted, body).await.unwrap();
        let mut claim = control.claim_import(&proof).await.unwrap();
        let original_started = if start {
            Some(
                control
                    .start_import(&mut claim, &proof)
                    .await
                    .unwrap()
                    .unwrap()
                    .custody_request()
                    .unwrap(),
            )
        } else {
            None
        };
        let binding = claim.binding();
        let key = crate::native_control::rows::key("operation", &binding.operation_id);
        let revision = self
            .store
            .rows
            .lock()
            .unwrap()
            .get(&key.0)
            .unwrap()
            .revision
            .clone();
        let data = ImportCustodyStartedRequest {
            v: 1,
            operation_id: binding.operation_id.clone(),
            action_ref: binding.action_ref.clone(),
            claim_ref: binding.claim_ref.clone(),
            native_owner_id: binding.native_owner_id.clone(),
            account_id_hash: binding.account_id_hash.clone(),
            source_native_generation: binding.source_native_generation.clone(),
            owner_revision: binding.owner_revision.clone(),
            source_revision: binding.source_revision.clone(),
            normalized_revision: binding.normalized_revision.clone(),
            started_revision: revision,
            deadline_ms: proof.deadline_ms(),
        };
        if let Some(actual) = original_started {
            assert_eq!(
                actual.canonical_bytes().unwrap(),
                data.canonical_bytes().unwrap()
            );
        }
        (proof, claim, data)
    }
    async fn peer(&self, data: &ImportCustodyStartedRequest, salt: u8) -> AuthenticatedNativeOwner {
        self.peer_as(data, &self.id, NATIVE_RENEWAL_AUTHORITY_PATH, salt)
            .await
    }
    async fn peer_as(
        &self,
        data: &ImportCustodyStartedRequest,
        id: &NativeTransportIdentity,
        path: &str,
        salt: u8,
    ) -> AuthenticatedNativeOwner {
        let body = data.canonical_bytes().unwrap();
        let nonce = base64url(&[salt; 32]);
        let now = self.store.now.load(Ordering::SeqCst);
        let time = now.to_string();
        let mac = id.sign(path, now, &nonce, &body).unwrap();
        NativeAuthenticator::new(id, &self.replay)
            .authenticate(
                path,
                NativeAuthHeaders {
                    version: "1",
                    key_id: id.key_id(),
                    time_ms: &time,
                    nonce: &nonce,
                    mac: &mac,
                },
                &body,
                now,
            )
            .await
            .unwrap()
    }
    fn snapshot(&self) -> serde_json::Value {
        serde_json::to_value(&*self.store.rows.lock().unwrap()).unwrap()
    }
    fn assert_readonly(&self, before: &serde_json::Value, tokens: usize, nonces: usize) {
        assert!(
            *before == self.snapshot(),
            "custody verification must not mutate any authority row"
        );
        assert_eq!(self.authority.tokens.0.load(Ordering::SeqCst), tokens);
        assert_eq!(self.replay.calls.load(Ordering::SeqCst), nonces);
    }
}
#[test]
fn real_original_started_and_import_only_mac_mint_readonly_current_observation() {
    run(async {
        let f = Fixture::new();
        let (proof, claim, data) = f.prepare(true).await;
        let peer = f.peer(&data, 1).await;
        let snapshot = f.snapshot();
        let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
        let nonces = f.replay.calls.load(Ordering::SeqCst);
        let result = f
            .control()
            .verify_started_custody(&peer, &data)
            .await
            .unwrap();
        assert_eq!(
            result.request().canonical_bytes().unwrap(),
            data.canonical_bytes().unwrap()
        );
        assert_eq!(result.deadline_ms(), proof.deadline_ms());
        assert_eq!(result.verified_at_ms(), 1_000_000);
        // Repeated readonly observation does NOT restore the consumed start permit.
        f.control()
            .verify_started_custody(&peer, &data)
            .await
            .unwrap();
        assert_eq!(claim.mode(), NativeImportMode::ReconcileOnly);
        f.assert_readonly(&snapshot, tokens, nonces);
    });
}
#[test]
fn authentic_wrong_peer_capability_key_epoch_path_and_request_refuse() {
    run(async {
        for changed in ["capability", "key", "epoch", "owner", "path", "body"] {
            let f = Fixture::new();
            let (_, _, data) = f.prepare(true).await;
            let id = NativeTransportIdentity::new(
                "import-test".into(),
                if changed == "owner" { "other" } else { "owner" }.into(),
                if changed == "epoch" { "other" } else { "epoch" }.into(),
                if changed == "key" { [8; 32] } else { [7; 32] },
                BTreeSet::from([if changed == "capability" {
                    NativeCapability::OwnerRenewal
                } else {
                    NativeCapability::CodexAuthImport
                }]),
            )
            .unwrap();
            let mut signed: ImportCustodyStartedRequest =
                serde_json::from_slice(&data.canonical_bytes().unwrap()).unwrap();
            if changed == "body" {
                signed.claim_ref = "different-claim".into();
            }
            let peer = f
                .peer_as(
                    &signed,
                    &id,
                    if changed == "path" {
                        NATIVE_CONTROL_PATH
                    } else {
                        NATIVE_RENEWAL_AUTHORITY_PATH
                    },
                    2,
                )
                .await;
            let snapshot = f.snapshot();
            let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
            let nonces = f.replay.calls.load(Ordering::SeqCst);
            assert!(
                f.control()
                    .verify_started_custody(&peer, &data)
                    .await
                    .is_err(),
                "{changed}"
            );
            f.assert_readonly(&snapshot, tokens, nonces);
        }
    });
}
#[test]
fn every_original_binding_and_started_revision_mismatch_refuses_without_writes() {
    run(async {
        for changed in [
            "operation",
            "action",
            "claim",
            "native_owner",
            "account",
            "physical",
            "owner_revision",
            "source_revision",
            "normalized_revision",
            "started_revision",
            "deadline",
        ] {
            let f = Fixture::new();
            let (_, _, mut data) = f.prepare(true).await;
            match changed {
                "operation" => data.operation_id = "other-operation".into(),
                "action" => data.action_ref = sha256_hex(b"other-action"),
                "claim" => data.claim_ref = "other-claim".into(),
                "native_owner" => data.native_owner_id = "other-owner".into(),
                "account" => data.account_id_hash = sha256_hex(b"other-account"),
                "physical" => data.source_native_generation = sha256_hex(b"other-physical"),
                "owner_revision" => data.owner_revision = "other-owner-revision".into(),
                "source_revision" => data.source_revision = "other-source".into(),
                "normalized_revision" => data.normalized_revision = "other-normalized".into(),
                "started_revision" => data.started_revision = "other-started".into(),
                _ => data.deadline_ms -= 1,
            }
            let peer = f.peer(&data, 3).await;
            let snapshot = f.snapshot();
            let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
            let nonces = f.replay.calls.load(Ordering::SeqCst);
            assert!(
                f.control()
                    .verify_started_custody(&peer, &data)
                    .await
                    .is_err(),
                "{changed}"
            );
            f.assert_readonly(&snapshot, tokens, nonces);
        }
    });
}
#[test]
fn unstarted_unknown_completed_and_generation_or_operation_outcomes_never_authorize_stop() {
    run(async {
        for changed in [
            "unstarted",
            "unknown",
            "published",
            "operation_terminal",
            "operation_digest",
            "generation_claim",
            "generation_operation",
            "generation_terminal",
        ] {
            let f = Fixture::new();
            let (_, claim, data) = f.prepare(changed != "unstarted").await;
            let opkey = crate::native_control::rows::key("operation", &data.operation_id);
            let generation_id = crate::native_control::facts::digest(&(
                "uos-native-renewal-generation-v1",
                &data.native_owner_id,
                &data.account_id_hash,
                &data.source_native_generation,
            ))
            .unwrap();
            let genkey = crate::native_control::rows::key("generation", &generation_id);
            if changed == "unknown" {
                f.control().unknown_import(&claim).await.unwrap();
            } else if changed != "unstarted" {
                let mut rows = f.store.rows.lock().unwrap();
                let operation = rows.get_mut(&opkey.0).unwrap();
                match changed {
                    "published" => operation.value["phase"] = json!("published"),
                    "operation_terminal" => {
                        operation.value["publication_revision"] = json!("forged-terminal")
                    }
                    "operation_digest" => {
                        operation.value["request_digest"] = json!(sha256_hex(b"wrong-binding"))
                    }
                    "generation_claim" => {
                        rows.get_mut(&genkey.0).unwrap().value["claim_ref"] = json!("foreign-claim")
                    }
                    "generation_operation" => {
                        rows.get_mut(&genkey.0).unwrap().value["operation_id"] =
                            json!("foreign-operation")
                    }
                    _ => {
                        rows.get_mut(&genkey.0).unwrap().value["publication_revision"] =
                            json!("foreign-terminal")
                    }
                }
            }
            let peer = f.peer(&data, 4).await;
            let snapshot = f.snapshot();
            let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
            let nonces = f.replay.calls.load(Ordering::SeqCst);
            assert!(
                f.control()
                    .verify_started_custody(&peer, &data)
                    .await
                    .is_err(),
                "{changed}"
            );
            f.assert_readonly(&snapshot, tokens, nonces);
        }
    });
}
#[test]
fn current_admin_session_owner_source_config_time_cancellation_and_cas_races_refuse() {
    run(async {
        for changed in [
            "admin",
            "session",
            "owner",
            "source",
            "config",
            "runtime",
            "expired",
            "cancel",
            "race",
            "commit_expiry",
        ] {
            let f = Fixture::new();
            let (_, _, data) = f.prepare(true).await;
            match changed {
                "admin" => f.store.seed(
                    passkeys::key("users", "user-fixture"),
                    "demoted",
                    user(false),
                ),
                "session" => {
                    let mut rows = f.store.rows.lock().unwrap();
                    let key = rows
                        .keys()
                        .find(|k| {
                            rows.get(*k)
                                .is_some_and(|r| r.value.get("session_digest").is_some())
                        })
                        .unwrap()
                        .clone();
                    rows.remove(&key);
                }
                "owner" | "source" | "config" | "runtime" => {
                    let key = match changed {
                        "owner" => keys::paid_control_owner(),
                        "source" => codex_source_pool_key(),
                        "config" => keys::paid_control_config(),
                        _ => gateway_auth::store::key(json!(["uos_ai", "runtime_config", "v2"])),
                    };
                    let mut rows = f.store.rows.lock().unwrap();
                    if let Some(row) = rows.get_mut(&key.0) {
                        row.revision = "replaced".into();
                    } else {
                        rows.insert(key.0, StoredRecord::json("replaced", json!({}), None));
                    }
                }
                "expired" => f.store.now.store(data.deadline_ms + 1, Ordering::SeqCst),
                "cancel" => f.cancel.0.store(true, Ordering::SeqCst),
                "race" => {
                    let key = crate::native_control::rows::key("operation", &data.operation_id);
                    let mut row = f.store.rows.lock().unwrap().get(&key.0).unwrap().clone();
                    row.revision = "raced-started".into();
                    f.store.race(key, Some(row));
                }
                _ => f
                    .store
                    .commit_time
                    .store(data.deadline_ms + 1, Ordering::SeqCst),
            }
            let peer = f.peer(&data, 5).await;
            let snapshot = f.snapshot();
            let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
            let nonces = f.replay.calls.load(Ordering::SeqCst);
            assert!(
                f.control()
                    .verify_started_custody(&peer, &data)
                    .await
                    .is_err(),
                "{changed}"
            );
            if changed != "race" {
                f.assert_readonly(&snapshot, tokens, nonces);
            } else {
                assert_eq!(f.authority.tokens.0.load(Ordering::SeqCst), tokens);
                assert_eq!(f.replay.calls.load(Ordering::SeqCst), nonces);
            }
        }
    });
}
#[test]
fn request_data_has_exact_required_fields_version_and_existing_finite_domains() {
    run(async {
        let f = Fixture::new();
        let (_, _, data) = f.prepare(true).await;
        let original = serde_json::to_value(&data).unwrap();
        for field in original.as_object().unwrap().keys() {
            let mut missing = original.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                serde_json::from_value::<ImportCustodyStartedRequest>(missing).is_err(),
                "{field}"
            );
        }
        let mut extra = original.clone();
        extra["body_sha256"] = json!(sha256_hex(b"not-allowed"));
        assert!(serde_json::from_value::<ImportCustodyStartedRequest>(extra).is_err());
        for changed in ["version", "reference", "hash", "revision", "time"] {
            let mut raw = original.clone();
            match changed {
                "version" => raw["v"] = json!(2),
                "reference" => raw["claim_ref"] = json!("/a/path"),
                "hash" => raw["source_native_generation"] = json!("f".repeat(63)),
                "revision" => raw["started_revision"] = json!("x".repeat(4097)),
                _ => raw["deadline_ms"] = json!(-1),
            }
            let data: ImportCustodyStartedRequest = serde_json::from_value(raw).unwrap();
            assert!(data.canonical_bytes().is_err(), "{changed}");
        }
        let fields = original.as_object().unwrap();
        assert_eq!(fields.len(), 12);
        assert!(!fields.contains_key("token"));
        assert!(!fields.contains_key("path"));
    });
}

#[test]
fn normal_v3_required_null_action_and_actual_started_request_preserve_original_lifetime() {
    run(async {
        let f = Fixture::new();
        let (proof, mut claim, data) = f.prepare_version(true, true).await;
        let key = crate::native_control::rows::key("action", &data.action_ref);
        let row = f.store.rows.lock().unwrap().get(&key.0).unwrap().clone();
        assert_eq!(row.value["v"], 3);
        assert!(row.value.as_object().unwrap().contains_key("publication"));
        assert!(row.value["publication"].is_null());
        assert_eq!(data.deadline_ms, proof.deadline_ms());
        crate::native_control::validate_native_control_custody(&key, &row).unwrap();
        let peer = f.peer(&data, 70).await;
        let snapshot = f.snapshot();
        let observation = f
            .control()
            .verify_started_custody(&peer, &data)
            .await
            .unwrap();
        assert_eq!(observation.deadline_ms(), data.deadline_ms);
        assert_eq!(f.snapshot(), snapshot);
        assert!(
            f.control()
                .start_import(&mut claim, &proof)
                .await
                .unwrap()
                .is_none()
        );
        for mutation in ["missing", "unknown", "partial"] {
            let mut wrong = row.clone();
            match mutation {
                "missing" => {
                    wrong.value.as_object_mut().unwrap().remove("publication");
                }
                "unknown" => {
                    wrong.value["extra"] = json!(true);
                }
                _ => {
                    wrong.value["publication"] = json!({"v":1});
                }
            }
            assert!(
                crate::native_control::validate_native_control_custody(&key, &wrong).is_err(),
                "{mutation}"
            );
        }
    });
}
#[test]
fn historical_v2_preparation_remains_lossless_without_publication_permission() {
    run(async {
        let f = Fixture::new();
        let (_, _, data) = f.prepare(true).await;
        let key = crate::native_control::rows::key("action", &data.action_ref);
        let row = f.store.rows.lock().unwrap().get(&key.0).unwrap().clone();
        assert_eq!(row.value["v"], 2);
        assert!(!row.value.as_object().unwrap().contains_key("publication"));
        let mut wrong = row.clone();
        wrong.value["publication"] = json!(null);
        assert!(crate::native_control::validate_native_control_custody(&key, &wrong).is_err());
        crate::native_control::validate_native_control_custody(&key, &row).unwrap();
    });
}

mod publication;

mod phase;

mod completion;
