//! Actual admin/CAS effect tests. No native filesystem/provider callback is used.
use super::*;
use crate::native_control::import::{AuthenticatedNativeImport, NativeImportMode};
use std::sync::atomic::AtomicBool;
#[derive(Default)]
struct EffectTokens(AtomicUsize);
impl TokenSource for EffectTokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok(format!(
            "import-effect-fixture-token-{}",
            self.0.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
fn effect_authority(store: &Store) -> Authority<Store, EffectTokens> {
    Authority::with_clock(store.clone(), EffectTokens::default(), store.clone())
}
struct Cancellation(AtomicBool);
impl NativeRenewalCancellation for Cancellation {
    fn cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
async fn proof<C: NativeRenewalCancellation>(
    control: &NativeRenewalAuthority<'_, Store, EffectTokens, C>,
    store: &Store,
    id: &NativeTransportIdentity,
    cfg: &AuthConfig,
    hash: &str,
    salt: u8,
) -> AuthenticatedNativeImport {
    let token = session_setup(store, true, true);
    let actor = actor::authenticate_admin_actor(
        control.authority,
        &Host::new(store),
        cfg,
        &request(&token),
        &context("passkey-user:user-fixture", None),
    )
    .await
    .unwrap();
    let prepared = control
        .prepare_import_legacy_v2_fixture(
            &actor,
            NativeImportTarget::ExistingAccount {
                account_id_hash: hash.into(),
            },
        )
        .await
        .unwrap();
    let admission = control
        .admit_import(header(id, prepared.metadata(), b"SYNTHETIC_BODY", salt).await)
        .await
        .unwrap();
    control
        .finish_import(admission, b"SYNTHETIC_BODY")
        .await
        .unwrap()
}
fn registered() -> RegisteredRenewalOwner {
    RegisteredRenewalOwner::configured(
        "native-owner".into(),
        "/tmp/native-import-synthetic-owner".into(),
    )
    .unwrap()
}
#[test]
fn original_import_v2_single_start_replay_unknown_and_no_forged_terminal() {
    run(async {
        let store = Store::default();
        let id = identity();
        let hash = seed(&store, &id);
        let authority = effect_authority(&store);
        let cfg = config();
        let registered = registered();
        let cancellation = Cancellation(AtomicBool::new(false));
        let control =
            NativeRenewalAuthority::configured(&authority, &id, &registered, &cfg, &cancellation);
        let proof = proof(&control, &store, &id, &cfg, &hash, 20).await;
        let mut first = control.claim_import(&proof).await.unwrap();
        assert_eq!(first.mode(), NativeImportMode::ImportOnce);
        let mut replay = control.claim_import(&proof).await.unwrap();
        assert_eq!(replay.mode(), NativeImportMode::ReconcileOnly);
        assert!(
            control
                .start_import(&mut replay, &proof)
                .await
                .unwrap()
                .is_none()
        );
        let start = control
            .start_import(&mut first, &proof)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(start.binding(), first.binding());
        start.require_body(b"SYNTHETIC_BODY", 1_000_000).unwrap();
        assert!(start.require_body(b"OTHER_BODY", 1_000_000).is_err());
        assert!(
            control
                .start_import(&mut first, &proof)
                .await
                .unwrap()
                .is_none()
        );
        cancellation.0.store(true, Ordering::SeqCst);
        control.unknown_import(&first).await.unwrap();
        cancellation.0.store(false, Ordering::SeqCst);
        control.recheck_import_claim(&first).await.unwrap();
        let mut replay = control.claim_import(&proof).await.unwrap();
        assert_eq!(replay.mode(), NativeImportMode::ReconcileOnly);
        assert!(
            control
                .start_import(&mut replay, &proof)
                .await
                .unwrap()
                .is_none()
        );
        let forged = {
            let rows = store.rows.lock().unwrap();
            let operation = rows
                .get(
                    &crate::native_control::rows::key("operation", &proof.metadata().operation_id)
                        .0,
                )
                .unwrap();
            assert_eq!(operation.value["phase"], "unknown");
            assert!(operation.value["terminal"].is_null());
            let action = rows
                .get(&crate::native_control::rows::key("action", &proof.metadata().action_ref).0)
                .unwrap();
            assert_eq!(action.value["v"], 2);
            assert_ne!(
                action.value["facts"]["source_native_generation"],
                action.value["facts"]["access_generation"]
            );
            let generation_id = crate::native_control::facts::digest(&(
                "uos-native-renewal-generation-v1",
                "native-owner",
                &hash,
                sha256_hex(b"physical-native-generation"),
            ))
            .unwrap();
            let generation_key = crate::native_control::rows::key("generation", &generation_id);
            let generation = rows.get(&generation_key.0).unwrap();
            assert_eq!(
                generation.value["operation_id"],
                proof.metadata().operation_id
            );
            for (key, record) in [
                (
                    crate::native_control::rows::key("operation", &proof.metadata().operation_id),
                    operation,
                ),
                (generation_key, generation),
            ] {
                crate::native_control::validate_native_control_custody(&key, record).unwrap();
                assert!(
                    !serde_json::to_string(&record.value)
                        .unwrap()
                        .contains(&sha256_hex(b"SYNTHETIC_BODY"))
                );
            }
            let mut forged = operation.clone();
            forged.value["phase"] = json!("published");
            assert!(
                crate::native_control::validate_native_control_custody(
                    &crate::native_control::rows::key("operation", &proof.metadata().operation_id),
                    &forged
                )
                .is_err()
            );
            forged
        };
        store.rows.lock().unwrap().insert(
            crate::native_control::rows::key("operation", &proof.metadata().operation_id).0,
            forged,
        );
        assert!(control.claim_import(&proof).await.is_err());
    });
}
#[test]
fn cancellation_before_effect_and_current_actor_source_races_never_start() {
    run(async {
        for changed in [
            "cancel",
            "source",
            "owner",
            "actor",
            "generation",
            "deadline",
        ] {
            let store = Store::default();
            let id = identity();
            let hash = seed(&store, &id);
            let authority = effect_authority(&store);
            let cfg = config();
            let registered = registered();
            let cancellation = Cancellation(AtomicBool::new(false));
            let control = NativeRenewalAuthority::configured(
                &authority,
                &id,
                &registered,
                &cfg,
                &cancellation,
            );
            let proof = proof(&control, &store, &id, &cfg, &hash, 21).await;
            let mut claim = control.claim_import(&proof).await.unwrap();
            match changed {
                "cancel" => cancellation.0.store(true, Ordering::SeqCst),
                "source" => {
                    let key = codex_source_pool_key();
                    let mut rows = store.rows.lock().unwrap();
                    rows.get_mut(&key.0).unwrap().revision = "other-source".into();
                }
                "owner" => {
                    store
                        .rows
                        .lock()
                        .unwrap()
                        .get_mut(&keys::paid_control_owner().0)
                        .unwrap()
                        .revision = "other-owner".into();
                }
                "actor" => {
                    store.seed(
                        passkeys::key("users", "user-fixture"),
                        "user-demoted",
                        user(false),
                    );
                }
                "generation" => {
                    let id = crate::native_control::facts::digest(&(
                        "uos-native-renewal-generation-v1",
                        "native-owner",
                        &hash,
                        sha256_hex(b"physical-native-generation"),
                    ))
                    .unwrap();
                    let key = crate::native_control::rows::key("generation", &id);
                    store.rows.lock().unwrap().get_mut(&key.0).unwrap().value["operation_id"] =
                        json!("foreign-operation");
                }
                _ => store.now.store(1_045_001, Ordering::SeqCst),
            }
            let result = control.start_import(&mut claim, &proof).await;
            assert!(!matches!(result, Ok(Some(_))), "{changed}");
            let rows = store.rows.lock().unwrap();
            let operation = rows
                .get(
                    &crate::native_control::rows::key("operation", &proof.metadata().operation_id)
                        .0,
                )
                .unwrap();
            assert_eq!(operation.value["phase"], "claimed", "{changed}");
            assert!(operation.value["terminal"].is_null());
        }
    });
}
#[test]
fn legacy_import_v1_custody_is_lossless_but_cannot_acquire_effects() {
    run(async {
        let store = Store::default();
        let id = identity();
        let hash = seed(&store, &id);
        let authority = effect_authority(&store);
        let cfg = config();
        let registered = registered();
        let control =
            NativeRenewalAuthority::configured(&authority, &id, &registered, &cfg, &Cancel);
        let proof = proof(&control, &store, &id, &cfg, &hash, 22).await;
        let key = crate::native_control::rows::key("action", &proof.metadata().action_ref);
        {
            let mut rows = store.rows.lock().unwrap();
            let action = rows.get_mut(&key.0).unwrap();
            action.value["v"] = json!(1);
            let facts = action.value["facts"].as_object_mut().unwrap();
            let access = facts.remove("access_generation").unwrap();
            facts.insert("native_generation".into(), access);
            for field in [
                "source_native_generation",
                "owner_revision",
                "source_revision",
                "normalized_revision",
                "runtime_revision",
                "control_checks_digest",
                "account_digests",
            ] {
                facts.remove(field);
            }
            crate::native_control::validate_native_control_custody(&key, action).unwrap();
        }
        assert!(control.claim_import(&proof).await.is_err());
        let admission = header(&id, proof.metadata(), b"SYNTHETIC_BODY", 23).await;
        assert!(control.admit_import(admission).await.is_err());
        assert!(!store.rows.lock().unwrap().keys().any(|key| key
            == &crate::native_control::rows::key("operation", &proof.metadata().operation_id).0));
    });
}
