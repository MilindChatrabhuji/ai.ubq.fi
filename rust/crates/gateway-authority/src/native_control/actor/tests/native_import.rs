use super::*;
use crate::{
    native_control::{
        NativeRenewalAuthority, NativeRenewalCancellation, RegisteredRenewalOwner, actor,
    },
    paid_control::{PAID_CONTROL_CONFIG_VERSION, PaidControlConfig, PaidControlOwner},
    routing::{PoolAccount, SubscriptionPool},
};
use gateway_auth::{
    crypto::{base64url, sha256_hex},
    native_auth::{
        NativeAuthHeaders, NativeAuthenticator, NativeCapability, NativeNonceAuthority,
        NativeTransportIdentity,
    },
    native_import::*,
    provider_credentials::{
        CodexNativeOwner, CodexSourceAccount, CodexSourcePool, codex_source_pool_key,
    },
};
use gateway_core::identity::PoolVersionstamp;
use std::collections::BTreeSet;
struct Cancel;
impl NativeRenewalCancellation for Cancel {
    fn cancelled(&self) -> bool {
        false
    }
}
#[derive(Default)]
struct Replay(Mutex<BTreeSet<String>>);
impl NativeNonceAuthority for Replay {
    async fn consume_nonce(
        &self,
        _: &str,
        nonce: &str,
        _: i64,
        _: i64,
    ) -> Result<(), GatewayError> {
        if self.0.lock().unwrap().insert(nonce.into()) {
            Ok(())
        } else {
            Err(fail())
        }
    }
}
fn identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "import-test".into(),
        "owner".into(),
        "epoch".into(),
        [7; 32],
        BTreeSet::from([NativeCapability::CodexAuthImport]),
    )
    .unwrap()
}
fn seed(store: &Store, id: &NativeTransportIdentity) -> String {
    store.seed(
        keys::paid_control_owner(),
        "owner-1",
        PaidControlOwner {
            v: 1,
            owner_id: "owner".into(),
            owner_epoch: "epoch".into(),
            key_fingerprint: id.key_fingerprint().into(),
        },
    );
    let runtime = gateway_auth::store::key(json!(["uos_ai", "runtime_config", "v2"]));
    store.seed(
        keys::paid_control_config(),
        "config-1",
        PaidControlConfig {
            v: PAID_CONTROL_CONFIG_VERSION,
            owner_id: "owner".into(),
            owner_epoch: "epoch".into(),
            generation: "config-generation".into(),
            configuration_fingerprint: "fixture-config".into(),
            surplus_binding: None,
            openlux_discovery_binding: None,
            openlux_binding: None,
            source_checks: vec![crate::paid_control::PaidSourceCheck {
                key: runtime.0,
                expected_revision: None,
            }],
        },
    );
    let mut account = CodexSourceAccount {
        account_id: "synthetic-account".into(),
        access_token: Secret::new("SYNTHETIC_ACCESS".into()),
        refresh_token: Secret::new(String::new()),
        updated_at_ms: 1_000_000.0,
        native_owner: Some(CodexNativeOwner {
            codex_home: "/tmp/native-import-synthetic-owner".into(),
            generation_hash: sha256_hex(b"native-generation"),
            native_refreshed_at: None,
            external_user_id: None,
            managed_source: Some(gateway_auth::provider_credentials::ManagedNativeSource {
                v: gateway_auth::provider_credentials::MANAGED_NATIVE_SOURCE_VERSION,
                generation_hash: sha256_hex(b"physical-native-generation"),
            }),
        }),
    };
    let identity = account.identity();
    let owner = account.native_owner.as_mut().unwrap();
    owner.generation_hash = identity.native_generation_hash.clone();
    let hash = identity.routing_account_hash.0.clone();
    store.seed(
        codex_source_pool_key(),
        "source-1",
        CodexSourcePool {
            accounts: vec![account],
            updated_at_ms: 1_000_000.0,
        }
        .private_source_value(),
    );
    store.seed(
        keys::pool(),
        "pool-1",
        SubscriptionPool {
            v: 1,
            pool_versionstamp: PoolVersionstamp("source-1".into()),
            accounts: vec![PoolAccount {
                account_id_hash: identity.routing_account_hash,
                admin_account_hash: identity.administrative_account_hash,
                credential_version: identity.credential_version,
                enabled: true,
            }],
        },
    );
    hash
}
async fn header(
    id: &NativeTransportIdentity,
    meta: &NativeImportMetadata,
    body: &[u8],
    salt: u8,
) -> NativeImportAdmission {
    let digest = sha256_hex(body);
    let nonce = base64url(&[salt; 32]);
    let mac = id
        .sign_import(
            NativeImportKind::CodexAuth,
            meta,
            &digest,
            1_000_000,
            &nonce,
        )
        .unwrap();
    NativeAuthenticator::new(id, &Replay::default())
        .admit_import(
            NativeImportKind::CodexAuth,
            NativeImportAuthHeaders {
                auth: NativeAuthHeaders {
                    version: "1",
                    key_id: id.key_id(),
                    time_ms: "1000000",
                    nonce: &nonce,
                    mac: &mac,
                },
                body_sha256: &digest,
            },
            meta,
            1_000_000,
        )
        .await
        .unwrap()
}
#[test]
fn existing_import_uses_actual_admin_source_before_header_and_body_proof() {
    run(async {
        let store = Store::default();
        let id = identity();
        let hash = seed(&store, &id);
        let token = session_setup(&store, true, true);
        let authority = authority(&store);
        let cfg = config();
        let actor = actor::authenticate_admin_actor(
            &authority,
            &Host::new(&store),
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let registered = RegisteredRenewalOwner::configured(
            "native-owner".into(),
            "/tmp/native-import-synthetic-owner".into(),
        )
        .unwrap();
        let control =
            NativeRenewalAuthority::configured(&authority, &id, &registered, &cfg, &Cancel);
        let prepared = control
            .prepare_import(
                &actor,
                NativeImportTarget::ExistingAccount {
                    account_id_hash: hash,
                },
            )
            .await
            .unwrap();
        let meta = prepared.metadata().clone();
        let body = b"ORIGINAL_SYNTHETIC_DOCUMENT";
        let admitted = control
            .admit_import(header(&id, &meta, body, 1).await)
            .await
            .unwrap();
        let proof = control.finish_import(admitted, body).await.unwrap();
        assert_eq!(proof.metadata(), &meta);
        assert!(proof.require_body(b"different", 1_000_000).is_err());
        control.recheck_import(&proof).await.unwrap();
        {
            let rows = store.rows.lock().unwrap();
            let row = rows
                .get(&crate::native_control::rows::key("action", &meta.action_ref).0)
                .unwrap();
            let json = serde_json::to_string(&row.value).unwrap();
            assert!(!json.contains(&sha256_hex(body)));
            assert!(!json.contains("ORIGINAL_SYNTHETIC_DOCUMENT"));
            assert!(!json.contains(&token));
            let custody_key = crate::native_control::rows::key("action", &meta.action_ref);
            assert_eq!(row.value["v"], 3);
            assert!(row.value.as_object().unwrap().contains_key("publication"));
            assert!(row.value["publication"].is_null());
            crate::native_control::validate_native_control_custody(&custody_key, row).unwrap();
            let mut malformed = row.clone();
            malformed.value["body_sha256"] = json!(sha256_hex(body));
            assert!(
                crate::native_control::validate_native_control_custody(&custody_key, &malformed)
                    .is_err()
            );
            malformed = row.clone();
            malformed.value["v"] = json!(4);
            assert!(
                crate::native_control::validate_native_control_custody(&custody_key, &malformed)
                    .is_err()
            );
            malformed = row.clone();
            malformed.expires_at_ms = Some(1_100_000);
            assert!(
                crate::native_control::validate_native_control_custody(&custody_key, &malformed)
                    .is_err()
            );
        }
        store.seed(
            passkeys::key("users", "user-fixture"),
            "user-demoted",
            user(false),
        );
        assert!(control.recheck_import(&proof).await.is_err());
    });
}
#[test]
fn import_source_owner_action_epoch_and_expiry_replacement_refuse_mint() {
    run(async {
        for changed in ["source", "owner", "action", "expiry", "session", "race"] {
            let store = Store::default();
            let id = identity();
            let hash = seed(&store, &id);
            let token = session_setup(&store, true, true);
            let authority = authority(&store);
            let cfg = config();
            let actor = actor::authenticate_admin_actor(
                &authority,
                &Host::new(&store),
                &cfg,
                &request(&token),
                &context("passkey-user:user-fixture", None),
            )
            .await
            .unwrap();
            let registered = RegisteredRenewalOwner::configured(
                "native-owner".into(),
                "/tmp/native-import-synthetic-owner".into(),
            )
            .unwrap();
            let control =
                NativeRenewalAuthority::configured(&authority, &id, &registered, &cfg, &Cancel);
            let prepared = control
                .prepare_import(
                    &actor,
                    NativeImportTarget::ExistingAccount {
                        account_id_hash: hash,
                    },
                )
                .await
                .unwrap();
            let mut meta = prepared.metadata().clone();
            let admission = header(&id, &meta, b"document", 2).await;
            match changed {
                "source" => {
                    let key = codex_source_pool_key();
                    let value = store
                        .rows
                        .lock()
                        .unwrap()
                        .get(&key.0)
                        .unwrap()
                        .value
                        .clone();
                    store.seed(key, "source-replaced", value);
                }
                "session" => {
                    let key = session_index::index_key(&session_index::digest(&token)).unwrap();
                    store.rows.lock().unwrap().remove(&key.0);
                }
                "race" => {
                    let key = codex_source_pool_key();
                    let row = store.rows.lock().unwrap().get(&key.0).unwrap().clone();
                    store.race(
                        key,
                        Some(StoredRecord::json("source-raced", row.value, None)),
                    );
                }
                "owner" => store.seed(
                    keys::paid_control_owner(),
                    "owner-new",
                    PaidControlOwner {
                        v: 1,
                        owner_id: "owner".into(),
                        owner_epoch: "other-epoch".into(),
                        key_fingerprint: id.key_fingerprint().into(),
                    },
                ),
                "action" => {
                    meta.action_ref = "foreign-action".into();
                    let other = header(&id, &meta, b"document", 3).await;
                    assert!(control.admit_import(other).await.is_err());
                    continue;
                }
                _ => {
                    store.now.store(1_045_001, Ordering::SeqCst);
                }
            }
            assert!(control.admit_import(admission).await.is_err(), "{changed}");
        }
    });
}
#[test]
fn unsupported_slots_profiles_and_wrong_original_actor_have_no_fake_fences() {
    run(async {
        let store = Store::default();
        let id = identity();
        let hash = seed(&store, &id);
        let token = session_setup(&store, true, true);
        let authority = authority(&store);
        let cfg = config();
        let actor = actor::authenticate_admin_actor(
            &authority,
            &Host::new(&store),
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let registered = RegisteredRenewalOwner::configured(
            "native-owner".into(),
            "/tmp/native-import-synthetic-owner".into(),
        )
        .unwrap();
        let control =
            NativeRenewalAuthority::configured(&authority, &id, &registered, &cfg, &Cancel);
        for target in [
            NativeImportTarget::PreparedAccountSlot {
                slot_ref: "explicit-slot".into(),
            },
            NativeImportTarget::PreparedProfile {
                profile_ref: "explicit-profile".into(),
            },
            NativeImportTarget::ExistingAccount {
                account_id_hash: sha256_hex(b"foreign-account"),
            },
        ] {
            assert!(control.prepare_import(&actor, target).await.is_err());
        }
        let client = actor::authenticate_client_actor(
            &authority,
            &Host::new(&store),
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        assert!(
            control
                .prepare_import(
                    &client,
                    NativeImportTarget::ExistingAccount {
                        account_id_hash: hash
                    }
                )
                .await
                .is_err()
        );
    });
}

mod effects;

mod custody_session;
