use super::*;
use crate::{
    native_control::{
        NativeRenewalAuthority, NativeRenewalCancellation, NativeRenewalContext,
        NativeRenewalControl, NativeRenewalMode, RegisteredRenewalOwner,
    },
    paid_control::{PaidControlConfig, PaidControlOwner, PaidSourceCheck},
    routing::{LiveRouteSelection, PoolAccount, SubscriptionPool},
};
use gateway_auth::{
    native::NATIVE_CONTROL_PATH,
    native_auth::{
        NativeAuthHeaders, NativeAuthenticator, NativeCapability, NativeNonceAuthority,
        NativeTransportIdentity,
    },
    native_control::{NativeControlEnvelope, NativeControlRequest},
    provider_credentials::{
        CodexNativeOwner, CodexSourceAccount, CodexSourcePool, MANAGED_NATIVE_SOURCE_VERSION,
        ManagedNativeSource, codex_source_pool_key,
    },
};
use gateway_core::{
    identity::PoolVersionstamp,
    js_string::JsString16,
    tuple_key::{ScalarKeyPart, TupleKey},
};
use std::collections::BTreeSet;

struct Sequence(AtomicUsize);
impl TokenSource for Sequence {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok(format!(
            "renewal-v2-fixture-{}",
            self.0.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
struct Alive;
impl NativeRenewalCancellation for Alive {
    fn cancelled(&self) -> bool {
        false
    }
}
fn identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "renewalfixture".into(),
        "renew-owner".into(),
        "renew-epoch".into(),
        [44; 32],
        BTreeSet::from([
            NativeCapability::OwnerRenewal,
            NativeCapability::AccessPublish,
        ]),
    )
    .unwrap()
}
fn runtime_key() -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("runtime_config"),
        ScalarKeyPart::String("v2"),
    ])
    .to_record_key()
}
fn mapping_key() -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("codex_live_calls"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("renew-call"),
    ])
    .to_record_key()
}
fn seed_owned(store: &Store, id: &NativeTransportIdentity) {
    let access = format!(
        "e30.{}.synthetic",
        gateway_auth::crypto::base64url(br#"{"exp":1030}"#)
    );
    let mut account = CodexSourceAccount {
        account_id: "renew-account".into(),
        access_token: Secret::new(access),
        refresh_token: Secret::new(String::new()),
        updated_at_ms: 1_000_000.0,
        native_owner: None,
    };
    let leaf = account.identity();
    account.native_owner = Some(CodexNativeOwner {
        codex_home: "/tmp/ai-rust-wasm-20261018/synthetic-home".into(),
        generation_hash: leaf.native_generation_hash,
        native_refreshed_at: None,
        external_user_id: None,
        managed_source: Some(ManagedNativeSource {
            v: MANAGED_NATIVE_SOURCE_VERSION,
            generation_hash: "d".repeat(64),
        }),
    });
    let binding = account.identity();
    store.seed(
        codex_source_pool_key(),
        "renew-source",
        CodexSourcePool {
            accounts: vec![account],
            updated_at_ms: 1_000_000.0,
        }
        .private_source_value(),
    );
    store.seed(
        keys::pool(),
        "renew-normalized",
        SubscriptionPool {
            v: 1,
            pool_versionstamp: PoolVersionstamp("renew-source".into()),
            accounts: vec![PoolAccount {
                account_id_hash: binding.routing_account_hash,
                admin_account_hash: binding.administrative_account_hash,
                credential_version: binding.credential_version,
                enabled: true,
            }],
        },
    );
    store.seed(runtime_key(), "runtime-version", json!({"v":2}));
    store.seed(
        keys::paid_control_owner(),
        "owner-version",
        PaidControlOwner {
            v: 1,
            owner_id: id.owner_id().into(),
            owner_epoch: id.owner_epoch().into(),
            key_fingerprint: id.key_fingerprint().into(),
        },
    );
    store.seed(
        keys::paid_control_config(),
        "config-version",
        PaidControlConfig {
            v: 2,
            owner_id: id.owner_id().into(),
            owner_epoch: id.owner_epoch().into(),
            generation: "config-generation".into(),
            configuration_fingerprint: "e".repeat(64),
            surplus_binding: None,
            openlux_discovery_binding: None,
            openlux_binding: None,
            source_checks: vec![PaidSourceCheck {
                key: runtime_key().0,
                expected_revision: Some("runtime-version".into()),
            }],
        },
    );
    store.seed(mapping_key(),"mapping-version",json!({"account_id":"renew-account","principal_id":"passkey-user:user-fixture","created_at_ms":1_000_000}));
}
#[derive(Default)]
struct Nonces(Mutex<BTreeSet<String>>);
impl NativeNonceAuthority for Nonces {
    async fn consume_nonce(&self, _: &str, n: &str, _: i64, _: i64) -> Result<(), GatewayError> {
        if self.0.lock().unwrap().insert(n.into()) {
            Ok(())
        } else {
            Err(fail())
        }
    }
}
async fn owner_proof(
    identity: &NativeTransportIdentity,
    body: &[u8],
    n: u8,
) -> gateway_auth::native_auth::AuthenticatedNativeOwner {
    let nonce = gateway_auth::crypto::base64url(&[n; 32]);
    let mac = identity
        .sign(NATIVE_CONTROL_PATH, 1_000_000, &nonce, body)
        .unwrap();
    NativeAuthenticator::new(identity, &Nonces::default())
        .authenticate(
            NATIVE_CONTROL_PATH,
            NativeAuthHeaders {
                version: "1",
                key_id: "renewalfixture",
                time_ms: "1000000",
                nonce: &nonce,
                mac: &mac,
            },
            body,
            1_000_000,
        )
        .await
        .unwrap()
}

async fn publication_proof(
    identity: &NativeTransportIdentity,
    body: &[u8],
    n: u8,
) -> gateway_auth::native_auth::AuthenticatedNativeOwner {
    let path = gateway_auth::native::NATIVE_PUBLICATION_PATH;
    let nonce = gateway_auth::crypto::base64url(&[n; 32]);
    let mac = identity.sign(path, 1_000_000, &nonce, body).unwrap();
    NativeAuthenticator::new(identity, &Nonces::default())
        .authenticate(
            path,
            NativeAuthHeaders {
                version: "1",
                key_id: "renewalfixture",
                time_ms: "1000000",
                nonce: &nonce,
                mac: &mac,
            },
            body,
            1_000_000,
        )
        .await
        .unwrap()
}
fn body(reference: &str, operation: &str) -> Vec<u8> {
    serde_json::to_vec(&NativeControlEnvelope {
        v: 1,
        operation_id: operation.into(),
        request: NativeControlRequest::CodexRenewAccess {
            action_ref: reference.into(),
        },
    })
    .unwrap()
}

#[test]
fn live_renewal_v2_mints_from_actual_actor_without_inference_state_and_preserves_utf16() {
    run(async {
        let store = Store::default();
        let id = identity();
        seed_owned(&store, &id);
        let token = session_setup(&store, true, true);
        let auth =
            Authority::with_clock(store.clone(), Sequence(AtomicUsize::new(1)), store.clone());
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_client_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let model = JsString16::from_units(vec![0xd800]);
        let LiveRouteSelection::Eligible(selected) = auth
            .select_live_account(Some(&model), 1_000_000)
            .await
            .unwrap()
        else {
            panic!()
        };
        let registered = RegisteredRenewalOwner::configured(
            "native-owner".into(),
            "/tmp/ai-rust-wasm-20261018/synthetic-home".into(),
        )
        .unwrap();
        let alive = Alive;
        let service = NativeRenewalAuthority::configured(&auth, &id, &registered, &cfg, &alive);
        let action = service
            .prepare_live_create_renewal(&actor, &selected)
            .await
            .unwrap();
        assert_eq!(action.fence().v, 2);
        assert!(
            matches!(&action.fence().context,NativeRenewalContext::LiveCreate{model_utf16:Some(units),..} if units==&vec![0xd800])
        );
        let encoded = serde_json::to_value(action.fence()).unwrap();
        assert!(encoded.get("model").is_none());
        assert!(encoded.get("original_admission_digest").is_none());
        assert!(encoded["context"].get("attempt_id").is_none());
        assert!(
            !store
                .rows
                .lock()
                .unwrap()
                .contains_key(&crate::native_control::rows::session_key("original-request").0)
        );
        let mut stale = encoded;
        stale["v"] = json!(1);
        assert!(
            serde_json::from_value::<crate::native_control::NativeRenewalFence>(stale).is_err()
        );
        assert_eq!(host.fetches.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn one_physical_generation_cannot_refresh_twice_across_live_contexts() {
    run(async {
        let store = Store::default();
        let id = identity();
        seed_owned(&store, &id);
        let token = session_setup(&store, true, true);
        let auth =
            Authority::with_clock(store.clone(), Sequence(AtomicUsize::new(1)), store.clone());
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_client_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let LiveRouteSelection::Eligible(selected) =
            auth.select_live_account(None, 1_000_000).await.unwrap()
        else {
            panic!()
        };
        let registered = RegisteredRenewalOwner::configured(
            "native-owner".into(),
            "/tmp/ai-rust-wasm-20261018/synthetic-home".into(),
        )
        .unwrap();
        let alive = Alive;
        let service = NativeRenewalAuthority::configured(&auth, &id, &registered, &cfg, &alive);
        let create = service
            .prepare_live_create_renewal(&actor, &selected)
            .await
            .unwrap();
        let frame = body(create.action_ref(), "create-operation");
        let proof = owner_proof(&id, &frame, 1).await;
        let mut claim = service
            .claim(&proof, create.action_ref(), "create-operation", &frame)
            .await
            .unwrap();
        assert_eq!(claim.mode(), NativeRenewalMode::RenewOnce);
        assert_eq!(
            service.start(&mut claim).await.unwrap(),
            NativeRenewalMode::RenewOnce
        );
        assert_eq!(
            service.start(&mut claim).await.unwrap(),
            NativeRenewalMode::ReconcileOnly
        );
        let prefix = crate::native_control::rows::prefix().0;
        for (key, record) in store
            .rows
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
        {
            crate::native_control::validate_native_control_custody(&RecordKey(key.clone()), record)
                .unwrap();
        }
        let action_key = crate::native_control::rows::key("action", create.action_ref());
        let mut stale = store
            .rows
            .lock()
            .unwrap()
            .get(&action_key.0)
            .unwrap()
            .json_value()
            .unwrap()
            .clone();
        stale["fence"]["v"] = json!(1);
        assert!(
            crate::native_control::validate_native_control_custody(
                &action_key,
                &StoredRecord::json("stale-version", stale, None)
            )
            .is_err()
        );
        let effect_key = crate::native_control::rows::generation_key(create.fence()).unwrap();
        let effect = store
            .rows
            .lock()
            .unwrap()
            .get(&effect_key.0)
            .unwrap()
            .clone();
        let mut expiring = effect.clone();
        expiring.expires_at_ms = Some(2_000_000);
        assert!(
            crate::native_control::validate_native_control_custody(&effect_key, &expiring).is_err()
        );
        let mapped = service
            .prepare_live_mapped_renewal(&actor, "renew-call")
            .await
            .unwrap();
        let frame = body(mapped.action_ref(), "mapped-operation");
        let proof = owner_proof(&id, &frame, 2).await;
        let mut claim = service
            .claim(&proof, mapped.action_ref(), "mapped-operation", &frame)
            .await
            .unwrap();
        assert_eq!(claim.mode(), NativeRenewalMode::ReconcileOnly);
        assert_eq!(
            service.start(&mut claim).await.unwrap(),
            NativeRenewalMode::ReconcileOnly
        );
    });
}

#[test]
fn live_mapped_renewal_rejects_changed_mapping_before_owner_start() {
    run(async {
        let store = Store::default();
        let id = identity();
        seed_owned(&store, &id);
        let token = session_setup(&store, true, true);
        let auth =
            Authority::with_clock(store.clone(), Sequence(AtomicUsize::new(1)), store.clone());
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_client_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let registered = RegisteredRenewalOwner::configured(
            "native-owner".into(),
            "/tmp/ai-rust-wasm-20261018/synthetic-home".into(),
        )
        .unwrap();
        let alive = Alive;
        let service = NativeRenewalAuthority::configured(&auth, &id, &registered, &cfg, &alive);
        let action = service
            .prepare_live_mapped_renewal(&actor, "renew-call")
            .await
            .unwrap();
        store.seed(
            mapping_key(),
            "mapping-replaced",
            json!({"account_id":"other-account","principal_id":"other-principal"}),
        );
        let frame = body(action.action_ref(), "stale-operation");
        let proof = owner_proof(&id, &frame, 3).await;
        assert!(
            service
                .claim(&proof, action.action_ref(), "stale-operation", &frame)
                .await
                .is_err()
        );
    });
}

#[test]
fn opaque_old_access_adopts_only_current_usable_publication_without_a_fabricated_expiry() {
    run(async {
        let store = Store::default();
        let id = identity();
        seed_owned(&store, &id);
        let raw = store
            .rows
            .lock()
            .unwrap()
            .get(&codex_source_pool_key().0)
            .unwrap()
            .json_value()
            .unwrap()
            .clone();
        let mut source = gateway_auth::provider_credentials::parse_codex_source_pool(&raw)
            .unwrap()
            .unwrap();
        source.accounts[0].access_token = Secret::new("OPAQUE_SYNTHETIC_ACCESS".into());
        source.accounts[0].updated_at_ms = 0.0;
        let identity_old = source.accounts[0].identity();
        source.accounts[0]
            .native_owner
            .as_mut()
            .unwrap()
            .generation_hash = identity_old.native_generation_hash;
        store.seed(
            codex_source_pool_key(),
            "opaque-source",
            source.private_source_value(),
        );
        store.seed(
            keys::pool(),
            "opaque-normalized",
            SubscriptionPool {
                v: 1,
                pool_versionstamp: PoolVersionstamp("opaque-source".into()),
                accounts: vec![PoolAccount {
                    account_id_hash: identity_old.routing_account_hash,
                    admin_account_hash: identity_old.administrative_account_hash,
                    credential_version: identity_old.credential_version,
                    enabled: true,
                }],
            },
        );
        let token = session_setup(&store, true, true);
        let auth =
            Authority::with_clock(store.clone(), Sequence(AtomicUsize::new(1)), store.clone());
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_client_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let owner = RegisteredRenewalOwner::configured(
            "native-owner".into(),
            "/tmp/ai-rust-wasm-20261018/synthetic-home".into(),
        )
        .unwrap();
        let alive = Alive;
        let service = NativeRenewalAuthority::configured(&auth, &id, &owner, &cfg, &alive);
        let action = service
            .prepare_live_mapped_renewal(&actor, "renew-call")
            .await
            .unwrap();
        assert_eq!(action.fence().access_expires_at_ms, None);
        let frame = body(action.action_ref(), "opaque-operation");
        let proof = owner_proof(&id, &frame, 10).await;
        let mut claim = service
            .claim(&proof, action.action_ref(), "opaque-operation", &frame)
            .await
            .unwrap();
        service.start(&mut claim).await.unwrap();
        let access = format!(
            "e30.{}.synthetic",
            gateway_auth::crypto::base64url(br#"{"exp":3000}"#)
        );
        let identity_new = gateway_auth::provider_credentials::codex_credential_identity(
            "renew-account",
            &Secret::new(access.clone()),
            &Secret::new(String::new()),
        );
        let fence = action.fence();
        let wire = json!({"operation":"managed_access_publish","v":2,"action_ref":action.action_ref(),"operation_id":"opaque-operation","native_owner_id":fence.native_owner_id,"owner_revision":fence.owner_revision,"source_revision":fence.source_revision,"normalized_revision":fence.normalized_revision,"publication_revision":"opaque-publication","account_id_hash":fence.account_id_hash,"previous_native_source_generation":fence.source_native_generation,"native_source_generation":"c".repeat(64),"access_generation":identity_new.native_generation_hash,"document":{"account_id":"renew-account","access_token":access,"native_refreshed_at":null}});
        let mut stale = wire.clone();
        stale["source_revision"] = json!("stale-source");
        let bytes = serde_json::to_vec(&stale).unwrap();
        assert!(
            service
                .publish_managed(&publication_proof(&id, &bytes, 11).await, &bytes)
                .await
                .is_err()
        );
        let mut invalid = wire.clone();
        invalid["document"]["access_token"] = json!("NOT_A_USABLE_NEW_JWT");
        let bytes = serde_json::to_vec(&invalid).unwrap();
        assert!(
            service
                .publish_managed(&publication_proof(&id, &bytes, 12).await, &bytes)
                .await
                .is_err()
        );
        let bytes = serde_json::to_vec(&wire).unwrap();
        let published = service
            .publish_managed(&publication_proof(&id, &bytes, 13).await, &bytes)
            .await
            .unwrap();
        assert_eq!(
            published.disposition,
            crate::native_control::NativeManagedPublicationDisposition::Applied
        );
        let accepted = service
            .verify_action_publication(&action, "opaque-operation", "opaque-publication")
            .await
            .unwrap();
        assert_eq!(accepted.access_expires_at_ms, Some(3_000_000));
        assert_eq!(accepted.source_revision, "opaque-publication");
        let replay = service
            .publish_managed(&publication_proof(&id, &bytes, 14).await, &bytes)
            .await
            .unwrap();
        assert_eq!(
            replay.disposition,
            crate::native_control::NativeManagedPublicationDisposition::AlreadyCurrent
        );
    });
}

#[test]
fn fixed_registry_selects_the_second_mapped_owner_without_home_or_environment_guessing() {
    run(async {
        let store = Store::default();
        let id = identity();
        seed_owned(&store, &id);
        let raw = store
            .rows
            .lock()
            .unwrap()
            .get(&codex_source_pool_key().0)
            .unwrap()
            .json_value()
            .unwrap()
            .clone();
        let mut source = gateway_auth::provider_credentials::parse_codex_source_pool(&raw)
            .unwrap()
            .unwrap();
        let mut second = source.accounts[0].clone();
        second.account_id = "renew-account-two".into();
        let identity_two = second.identity();
        let native = second.native_owner.as_mut().unwrap();
        native.codex_home = "/tmp/ai-rust-wasm-20261018/synthetic-home-two".into();
        native.generation_hash = identity_two.native_generation_hash;
        source.accounts.push(second);
        let accounts = source
            .accounts
            .iter()
            .map(|a| {
                let i = a.identity();
                PoolAccount {
                    account_id_hash: i.routing_account_hash,
                    admin_account_hash: i.administrative_account_hash,
                    credential_version: i.credential_version,
                    enabled: true,
                }
            })
            .collect();
        store.seed(
            codex_source_pool_key(),
            "two-source",
            source.private_source_value(),
        );
        store.seed(
            keys::pool(),
            "two-normalized",
            SubscriptionPool {
                v: 1,
                pool_versionstamp: PoolVersionstamp("two-source".into()),
                accounts,
            },
        );
        store.seed(mapping_key(),"mapping-two",json!({"account_id":"renew-account-two","principal_id":"passkey-user:user-fixture","created_at_ms":1_000_000}));
        let token = session_setup(&store, true, true);
        let auth =
            Authority::with_clock(store.clone(), Sequence(AtomicUsize::new(1)), store.clone());
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_client_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let registry = crate::native_control::RegisteredRenewalOwners::configured(vec![
            RegisteredRenewalOwner::configured(
                "native-one".into(),
                "/tmp/ai-rust-wasm-20261018/synthetic-home".into(),
            )
            .unwrap(),
            RegisteredRenewalOwner::configured(
                "native-two".into(),
                "/tmp/ai-rust-wasm-20261018/synthetic-home-two".into(),
            )
            .unwrap(),
        ])
        .unwrap();
        let selected = registry
            .for_live_mapped(&auth, &actor, &cfg, "renew-call")
            .await
            .unwrap();
        assert_eq!(selected.native_owner_id(), "native-two");
        let alive = Alive;
        let service = NativeRenewalAuthority::configured(&auth, &id, selected, &cfg, &alive);
        let action = service
            .prepare_live_mapped_renewal(&actor, "renew-call")
            .await
            .unwrap();
        assert_eq!(
            registry
                .for_action(&auth, action.action_ref())
                .await
                .unwrap()
                .native_owner_id(),
            "native-two"
        );
        let only_first = crate::native_control::RegisteredRenewalOwners::configured(vec![
            RegisteredRenewalOwner::configured(
                "native-one".into(),
                "/tmp/ai-rust-wasm-20261018/synthetic-home".into(),
            )
            .unwrap(),
        ])
        .unwrap();
        assert!(
            only_first
                .for_live_mapped(&auth, &actor, &cfg, "renew-call")
                .await
                .is_err()
        );
        assert!(crate::native_control::RegisteredRenewalOwners::configured(Vec::new()).is_err());
        assert!(
            crate::native_control::RegisteredRenewalOwners::configured(vec![
                RegisteredRenewalOwner::configured("duplicate".into(), "/tmp/one".into()).unwrap(),
                RegisteredRenewalOwner::configured("duplicate".into(), "/tmp/two".into()).unwrap()
            ])
            .is_err()
        );
    });
}

#[test]
fn native_action_source_custody_is_lossless_data_not_an_operation_capability() {
    use crate::native_control::{facts, rows, validate_native_control_custody};
    use gateway_core::{
        model::ModelId,
        source_control::{decode_source_control_record, encode_source_control_record},
        source_json::SourceJson,
        value::ValueEncoding,
    };
    run(async {
        let store = Store::default();
        let id = identity();
        seed_owned(&store, &id);
        let token = session_setup(&store, true, true);
        let auth =
            Authority::with_clock(store.clone(), Sequence(AtomicUsize::new(1)), store.clone());
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_client_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let registered = RegisteredRenewalOwner::configured(
            "native-owner".into(),
            "/tmp/ai-rust-wasm-20261018/synthetic-home".into(),
        )
        .unwrap();
        let alive = Alive;
        let service = NativeRenewalAuthority::configured(&auth, &id, &registered, &cfg, &alive);
        let action = service
            .prepare_live_mapped_renewal(&actor, "renew-call")
            .await
            .unwrap();
        let record = store
            .rows
            .lock()
            .unwrap()
            .get(&rows::key("action", action.action_ref()).0)
            .unwrap()
            .clone();
        validate_native_control_custody(&rows::key("action", action.action_ref()), &record)
            .expect("actual prepared action must satisfy its source custody schema");
        let template: rows::ActionRow = decode_source_control_record(&record)
            .unwrap()
            .deserialize()
            .unwrap();
        for (case, units) in [
            "fixture-model".encode_utf16().collect(),
            vec![0xd800],
            vec![0xdc00],
            vec![0xfffd],
            vec![0xd83d, 0xde80],
            vec![0, 10, 34, 92],
            r"\ud800".encode_utf16().collect(),
            vec![u16::from(b'm'); 4097],
        ]
        .into_iter()
        .enumerate()
        {
            // A data-only custody fixture is never passed off as an admitted
            // Journal or a minted native control/refresh permission.
            let mut row = template.clone();
            row.fence.context = NativeRenewalContext::Inference {
                attempt_id: "source-custody-attempt".into(),
                original_admission_digest: "f".repeat(64),
                model: ModelId::from_source(JsString16::from_units(units)),
                slot: 0,
            };
            let context_document = SourceJson::from_serializable(&row.fence.context).unwrap();
            let _: ModelId = gateway_core::source_serialization::member(&context_document, "model")
                .unwrap()
                .deserialize()
                .expect("the actual context model token must decode losslessly");
            let _: NativeRenewalContext = serde_json::from_str(context_document.as_str())
                .unwrap_or_else(|error| {
                    panic!("source custody case {case} context decode: {error}")
                });
            row.action_ref = facts::digest(&(
                "uos-native-renewal-action-v2",
                &row.fence.original_request_id,
                &row.fence.context,
                &row.fence.source_native_generation,
            ))
            .unwrap();
            let key = rows::key("action", &row.action_ref);
            let document = SourceJson::from_serializable(&row).unwrap();
            let record =
                encode_source_control_record("opaque-custody-revision", &document, None).unwrap();
            assert_eq!(
                record.value_encoding,
                if document.deserialize::<Value>().is_ok() {
                    ValueEncoding::Json
                } else {
                    ValueEncoding::ProfileV2
                }
            );
            let reopened: StoredRecord =
                serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
            let roundtrip: rows::ActionRow = decode_source_control_record(&reopened)
                .unwrap()
                .deserialize()
                .unwrap_or_else(|error| panic!("source custody case {case} row decode: {error}"));
            assert_eq!(roundtrip.fence, row.fence);
            assert_eq!(reopened.revision, "opaque-custody-revision");
            assert_eq!(reopened.expires_at_ms, None);
            validate_native_control_custody(&key, &record)
                .unwrap_or_else(|error| panic!("source custody case {case}: {error:?}"));
            let mut expired = reopened.clone();
            expired.expires_at_ms = Some(1_000_001);
            assert!(validate_native_control_custody(&key, &expired).is_err());
            let mut incompatible = reopened;
            incompatible.value_encoding = ValueEncoding::ProfileV1;
            assert!(validate_native_control_custody(&key, &incompatible).is_err());
            let mut corrupt = row;
            corrupt.fence.principal = "replaced-principal".into();
            let record = encode_source_control_record(
                "changed",
                &SourceJson::from_serializable(&corrupt).unwrap(),
                None,
            )
            .unwrap();
            assert!(validate_native_control_custody(&key, &record).is_err());
        }
        let scalar = NativeRenewalContext::Inference {
            attempt_id: "scalar-attempt".into(),
            original_admission_digest: "scalar-digest".into(),
            model: "fixture-model".into(),
            slot: 1,
        };
        let frozen = br#"{"kind":"inference","attempt_id":"scalar-attempt","original_admission_digest":"scalar-digest","model":"fixture-model","slot":1}"#;
        assert_eq!(serde_json::to_vec(&scalar).unwrap(), frozen);
        assert_eq!(
            facts::digest(&scalar).unwrap(),
            gateway_auth::crypto::sha256_hex(frozen)
        );
        assert_eq!(host.fetches.load(Ordering::SeqCst), 0);
    });
}
