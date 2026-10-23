use gateway_auth::native_credentials::{NativeCredentials, NativeOwnerId};
use gateway_auth::provider_credentials::{
    CodexNativeOwner, CodexSourceAccount, CodexSourcePool, codex_source_pool_key,
    read_codex_source_pool,
};
use gateway_auth::{
    GatewayError,
    crypto::{Secret, base64url},
    native::NATIVE_RPC_PATH,
    native_auth::{
        AuthenticatedNativeOwner, NativeAuthHeaders, NativeAuthenticator, NativeCapability,
        NativeNonceAuthority, NativeTransportIdentity,
    },
    store,
};
use gateway_authority::routing::{PoolAccount, SubscriptionPool};
use gateway_authority::{
    keys,
    paid_control::{PaidControlConfig, PaidControlOwner},
};
use gateway_core::identity::PoolVersionstamp;
use gateway_core::{
    provider::PaidProvider,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
};
use gateway_publication::access_publication::{
    AccessCredentialSource, PreparedAccessPublication, RegisteredAccessOwner,
};
use gateway_publication::control_publication::*;
use gateway_publication::transport::{
    NativePublicationSender, PublicationCarrier, PublicationReceiver, PublicationRequest,
    PublicationResponse,
};
use gateway_publication::wire::{PreparedPublicationCommand, PublicationDisposition};
use serde_json::{Value, json};

struct AccessRead(NativeCredentials);
impl AccessCredentialSource for AccessRead {
    async fn read_current_access(
        &self,
        owner: &NativeOwnerId,
    ) -> Result<NativeCredentials, GatewayError> {
        assert_eq!(owner.0, "registered-owner");
        Ok(self.0.clone())
    }
}

fn access(expiry: i64, user: &str) -> NativeCredentials {
    let token=format!("e30.{}.fixture",base64url(json!({"exp":expiry,"https://api.openai.com/auth":{"chatgpt_user_id":user,"chatgpt_account_id":"workspace"}}).to_string().as_bytes()));
    NativeCredentials {
        account_id: "workspace".into(),
        access_token: Secret::new(token),
        refresh_token: Secret::new(String::new()),
        email: None,
        native_refreshed_at: Some(
            if expiry == 1_792_341_000 {
                "2026-10-18T17:00:00Z"
            } else {
                "2026-10-18T17:01:00Z"
            }
            .into(),
        ),
        external_user_id: Some(user.into()),
    }
}
fn seed_access(store: &Memory, old: &NativeCredentials) {
    let account = CodexSourceAccount {
        account_id: old.account_id.clone(),
        access_token: old.access_token.clone(),
        refresh_token: old.refresh_token.clone(),
        updated_at_ms: 1.0,
        native_owner: Some(CodexNativeOwner {
            managed_source: None,
            codex_home: "/tmp/uos-native-fixture".into(),
            generation_hash: old.generation_hash(),
            native_refreshed_at: old.native_refreshed_at.clone(),
            external_user_id: old.external_user_id.clone(),
        }),
    };
    let other = CodexSourceAccount {
        account_id: "other-workspace".into(),
        access_token: Secret::new("fixture-other-access".into()),
        refresh_token: Secret::new("fixture-other-refresh".into()),
        updated_at_ms: 1.0,
        native_owner: None,
    };
    let raw = CodexSourcePool {
        accounts: vec![account, other],
        updated_at_ms: 1.0,
    };
    let accounts = raw
        .accounts
        .iter()
        .map(|a| {
            let id = a.identity();
            PoolAccount {
                account_id_hash: id.routing_account_hash,
                admin_account_hash: id.administrative_account_hash,
                credential_version: id.credential_version,
                enabled: true,
            }
        })
        .collect();
    let normalized = SubscriptionPool {
        v: 1,
        pool_versionstamp: PoolVersionstamp("raw-r1".into()),
        accounts,
    };
    set(
        store,
        codex_source_pool_key(),
        "raw-r1",
        raw.private_source_value(),
    );
    set(
        store,
        keys::pool(),
        "normalized-r1",
        serde_json::to_value(normalized).unwrap(),
    );
}
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};

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
struct Memory(Mutex<BTreeMap<String, StoredRecord>>);
impl AuthorityStore for Memory {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.0.lock().unwrap().get(&key.0).cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let mut rows = self.0.lock().unwrap();
        if transition.checks.iter().any(|check| {
            rows.get(&check.key.0).map(|r| &r.revision) != check.expected_revision.as_ref()
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
struct Nonces;
impl NativeNonceAuthority for Nonces {
    async fn consume_nonce(&self, _: &str, _: &str, _: i64, _: i64) -> Result<(), GatewayError> {
        Ok(())
    }
}
fn make_identity(capability: NativeCapability) -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "fixture-key".into(),
        "fixture-owner".into(),
        "fixture-epoch".into(),
        [11; 32],
        BTreeSet::from([capability]),
    )
    .unwrap()
}
async fn proof(
    identity: &NativeTransportIdentity,
    body: &[u8],
    now: i64,
) -> AuthenticatedNativeOwner {
    let nonce = base64url(&[7; 32]);
    let mac = identity.sign(NATIVE_RPC_PATH, now, &nonce, body).unwrap();
    NativeAuthenticator::new(identity, &Nonces)
        .authenticate(
            NATIVE_RPC_PATH,
            NativeAuthHeaders {
                version: "1",
                key_id: identity.key_id(),
                time_ms: &now.to_string(),
                nonce: &nonce,
                mac: &mac,
            },
            body,
            now,
        )
        .await
        .unwrap()
}
fn inputs(secret: &str) -> ConfiguredPaidInputs {
    ConfiguredPaidInputs::new(
        Some(Secret::new(secret.into())),
        Some(Secret::new("fixture-openlux-key".into())),
        Some(Secret::new("fixture-openlux-key".into())),
        json!({"overage_enabled":true}),
    )
    .unwrap()
}
async fn bootstrap(store: &Memory, identity: &NativeTransportIdentity, now: i64) {
    let body = fixture_owner_statement(identity).unwrap();
    let proof = proof(identity, &body, now).await;
    bootstrap_fixture_owner(store, identity, &proof, now, "owner-r1")
        .await
        .unwrap();
}
fn set(store: &Memory, key: RecordKey, revision: &str, value: Value) {
    store
        .0
        .lock()
        .unwrap()
        .insert(key.0, StoredRecord::json(revision, value, None));
}

#[test]
fn real_authenticated_constructor_publishes_only_derived_fixed_control_facts() {
    run(async {
        let store = Memory::default();
        let identity = make_identity(NativeCapability::ConfigurationPublish);
        let now = 1_792_339_000_000;
        bootstrap(&store, &identity, now).await;
        let inputs = inputs("fixture-surplus-key");
        let publication = PreparedConfigurationPublication::capture(
            &store,
            &identity,
            &inputs,
            "generation-1",
            now,
        )
        .await
        .unwrap();
        let signed = proof(&identity, publication.statement(), now).await;
        let configured = publication
            .publish(&store, &signed, now, "config-r1")
            .await
            .unwrap();
        assert_eq!(
            configured.surplus_binding,
            inputs.binding(PaidProvider::Surplus)
        );
        assert_eq!(
            configured.openlux_binding,
            inputs.binding(PaidProvider::Metered)
        );
        assert_eq!(configured.v, 2);
        assert_eq!(
            configured.openlux_discovery_binding,
            inputs.discovery_binding(PaidProvider::Metered)
        );
        assert_eq!(configured.source_checks.len(), 1);
        assert_eq!(configured.source_checks[0].key, runtime_config_key().0);
        assert_eq!(configured.source_checks[0].expected_revision, None);
        let rows = store.0.lock().unwrap();
        let persisted = serde_json::to_string(&*rows).unwrap();
        assert!(!persisted.contains("fixture-surplus-key"));
        assert!(!persisted.contains("fixture-openlux-key"));
        assert_eq!(rows.len(), 2);
    });
}

#[test]
fn explicit_discovery_and_spend_roles_have_independent_configuration_fingerprints() {
    run(async {
        let store = Memory::default();
        let identity = make_identity(NativeCapability::ConfigurationPublish);
        bootstrap(&store, &identity, now()).await;
        let mut configurations = Vec::new();
        for (discovery, spend) in [
            (Some("fixture-discovery-a"), Some("fixture-spend-a")),
            (Some("fixture-discovery-b"), Some("fixture-spend-a")),
            (Some("fixture-discovery-a"), Some("fixture-spend-b")),
            (None, Some("fixture-spend-a")),
            (Some("fixture-discovery-a"), None),
        ] {
            let inputs = ConfiguredPaidInputs::new(
                None,
                discovery.map(|key| Secret::new(key.into())),
                spend.map(|key| Secret::new(key.into())),
                json!({"overage_enabled":true}),
            )
            .unwrap();
            let prepared =
                PreparedConfigurationPublication::capture(&store, &identity, &inputs, "g1", now())
                    .await
                    .unwrap();
            let config = prepared.configuration().clone();
            assert_eq!(
                config.openlux_discovery_binding,
                inputs.discovery_binding(PaidProvider::Metered)
            );
            assert_eq!(
                config.openlux_binding,
                inputs.binding(PaidProvider::Metered)
            );
            configurations.push(config);
        }
        assert_eq!(
            configurations[0].openlux_binding,
            configurations[1].openlux_binding
        );
        assert_eq!(
            configurations[0].openlux_discovery_binding,
            configurations[2].openlux_discovery_binding
        );
        assert_ne!(
            configurations[0].openlux_discovery_binding,
            configurations[1].openlux_discovery_binding
        );
        assert_ne!(
            configurations[0].openlux_binding,
            configurations[2].openlux_binding
        );
        for config in &configurations[1..] {
            assert_ne!(
                configurations[0].configuration_fingerprint,
                config.configuration_fingerprint
            );
        }
        assert!(configurations[3].openlux_discovery_binding.is_none());
        assert!(configurations[3].openlux_binding.is_some());
        assert!(configurations[4].openlux_discovery_binding.is_some());
        assert!(configurations[4].openlux_binding.is_none());
        assert_eq!(
            configurations[0].openlux_binding,
            Some(configured_paid_binding(
                PaidProvider::Metered,
                &Secret::new("fixture-spend-a".into())
            ))
        );
        let same = inputs("fixture-surplus-key");
        assert_eq!(
            same.binding(PaidProvider::Metered),
            same.discovery_binding(PaidProvider::Metered)
        );
        for (discovery, spend) in [(Some(" "), Some("valid")), (Some("valid"), Some(""))] {
            assert!(
                ConfiguredPaidInputs::new(
                    None,
                    discovery.map(|key| Secret::new(key.into())),
                    spend.map(|key| Secret::new(key.into())),
                    json!({})
                )
                .is_err()
            );
        }
        let encoded = serde_json::to_string(&configurations).unwrap();
        for secret in [
            "fixture-discovery-a",
            "fixture-discovery-b",
            "fixture-spend-a",
            "fixture-spend-b",
        ] {
            assert!(!encoded.contains(secret));
        }
        let mut legacy = configurations[0].clone();
        legacy.v = 1;
        assert!(
            PreparedPublicationCommand::configuration_from_expected(
                legacy.clone(),
                "owner-r1".into(),
                None,
                "config-r1".into()
            )
            .is_err()
        );
        set(
            &store,
            keys::paid_control_config(),
            "legacy-config",
            serde_json::to_value(&legacy).unwrap(),
        );
        assert!(
            PreparedConfigurationPublication::capture(&store, &identity, &same, "g2", now())
                .await
                .is_err()
        );
        let mut missing = serde_json::to_value(&configurations[0]).unwrap();
        missing
            .as_object_mut()
            .unwrap()
            .remove("openlux_discovery_binding");
        set(&store, keys::paid_control_config(), "missing-role", missing);
        assert!(
            PreparedConfigurationPublication::capture(&store, &identity, &same, "g2", now())
                .await
                .is_err()
        );
    });
}

#[test]
fn discovery_only_change_invalidates_observations_and_old_authenticated_commands() {
    run(async {
        let store = Memory::default();
        let identity = publication_identity();
        bootstrap(&store, &identity, now()).await;
        let initial = inputs("fixture-surplus-key");
        let prepared =
            PreparedConfigurationPublication::capture(&store, &identity, &initial, "g1", now())
                .await
                .unwrap();
        let original = prepared.configuration().clone();
        let signed = proof(&identity, prepared.statement(), now()).await;
        prepared
            .publish(&store, &signed, now(), "cfg1")
            .await
            .unwrap();
        set(
            &store,
            keys::paid_control_observation(PaidProvider::Metered),
            "old-observation",
            json!({"obsolete":true}),
        );
        let next = ConfiguredPaidInputs::new(
            Some(Secret::new("fixture-surplus-key".into())),
            Some(Secret::new("fixture-next-discovery".into())),
            Some(Secret::new("fixture-openlux-key".into())),
            json!({"overage_enabled":true}),
        )
        .unwrap();
        let old_command =
            PreparedConfigurationPublication::capture(&store, &identity, &initial, "g2", now())
                .await
                .unwrap()
                .command("cfg2")
                .unwrap();
        let prepared =
            PreparedConfigurationPublication::capture(&store, &identity, &next, "g2", now())
                .await
                .unwrap();
        assert_eq!(
            prepared.configuration().openlux_binding,
            original.openlux_binding
        );
        assert_ne!(
            prepared.configuration().openlux_discovery_binding,
            original.openlux_discovery_binding
        );
        let receiver =
            PublicationReceiver::configured(identity.clone(), next, vec![], now).unwrap();
        let carrier = LocalCarrier {
            receiver: &receiver,
            store: &store,
            lose_response: std::cell::Cell::new(false),
            tamper_response: false,
        };
        let sender = NativePublicationSender::configured(&identity, &carrier);
        assert_eq!(
            sender
                .send(&old_command, [21; 32], now())
                .await
                .unwrap_err()
                .status,
            409
        );
        assert!(
            store
                .read(&keys::paid_control_observation(PaidProvider::Metered))
                .await
                .unwrap()
                .is_some()
        );
        sender
            .send(&prepared.command("cfg2").unwrap(), [22; 32], now())
            .await
            .unwrap();
        assert!(
            store
                .read(&keys::paid_control_observation(PaidProvider::Metered))
                .await
                .unwrap()
                .is_none()
        );
        let current = store
            .read(&keys::paid_control_config())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.revision, "cfg2");
    });
}

#[test]
fn stale_prepared_owner_config_and_source_revisions_are_fenced() {
    run(async {
        let store = Memory::default();
        let identity = make_identity(NativeCapability::ConfigurationPublish);
        let now = 1_792_339_000_000;
        bootstrap(&store, &identity, now).await;
        let inputs = inputs("first-secret");
        let stale =
            PreparedConfigurationPublication::capture(&store, &identity, &inputs, "old", now)
                .await
                .unwrap();
        let stale_proof = proof(&identity, stale.statement(), now).await;
        let current =
            PreparedConfigurationPublication::capture(&store, &identity, &inputs, "current", now)
                .await
                .unwrap();
        let signed = proof(&identity, current.statement(), now).await;
        current
            .publish(&store, &signed, now, "current-r1")
            .await
            .unwrap();
        assert_eq!(
            stale
                .publish(&store, &stale_proof, now, "stale-r1")
                .await
                .unwrap_err()
                .status,
            409
        );
        let stale_source =
            PreparedConfigurationPublication::capture(&store, &identity, &inputs, "new", now)
                .await
                .unwrap();
        let signed = proof(&identity, stale_source.statement(), now).await;
        set(
            &store,
            runtime_config_key(),
            "runtime-r2",
            json!({"overage_enabled":false}),
        );
        assert_eq!(
            stale_source
                .publish(&store, &signed, now, "unused")
                .await
                .unwrap_err()
                .status,
            409
        );
        let stale_owner =
            PreparedConfigurationPublication::capture(&store, &identity, &inputs, "next", now)
                .await
                .unwrap();
        let signed = proof(&identity, stale_owner.statement(), now).await;
        set(
            &store,
            keys::paid_control_owner(),
            "owner-r2",
            json!({"v":1,"owner_id":"fixture-owner","owner_epoch":"replacement","key_fingerprint":identity.key_fingerprint()}),
        );
        assert_eq!(
            stale_owner
                .publish(&store, &signed, now, "unused")
                .await
                .unwrap_err()
                .status,
            409
        );
        let row = store
            .read(&keys::paid_control_config())
            .await
            .unwrap()
            .unwrap();
        let config: PaidControlConfig = serde_json::from_value(row.value).unwrap();
        assert_eq!(config.generation, "current");
    });
}

#[test]
fn changed_bindings_delete_obsolete_observations_in_the_same_cas() {
    run(async {
        let store = Memory::default();
        let identity = make_identity(NativeCapability::ConfigurationPublish);
        let now = 1_792_339_000_000;
        bootstrap(&store, &identity, now).await;
        let first = inputs("old-secret");
        let prepared =
            PreparedConfigurationPublication::capture(&store, &identity, &first, "g1", now)
                .await
                .unwrap();
        let signed = proof(&identity, prepared.statement(), now).await;
        prepared
            .publish(&store, &signed, now, "cfg1")
            .await
            .unwrap();
        for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
            set(
                &store,
                keys::paid_control_observation(provider),
                "old-observation",
                json!({"obsolete":true}),
            );
        }
        let next = inputs("new-secret");
        let prepared =
            PreparedConfigurationPublication::capture(&store, &identity, &next, "g2", now)
                .await
                .unwrap();
        let signed = proof(&identity, prepared.statement(), now).await;
        prepared
            .publish(&store, &signed, now, "cfg2")
            .await
            .unwrap();
        for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
            assert!(
                store
                    .read(&keys::paid_control_observation(provider))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            PreparedConfigurationPublication::capture(&store, &identity, &first, "g2", now)
                .await
                .is_err()
        );
    });
}

#[test]
fn capability_payload_and_current_owner_custody_cannot_be_forged() {
    run(async {
        let store = Memory::default();
        let identity = make_identity(NativeCapability::ConfigurationPublish);
        let now = 1_792_339_000_000;
        bootstrap(&store, &identity, now).await;
        let input = inputs("first-secret");
        let prepared =
            PreparedConfigurationPublication::capture(&store, &identity, &input, "g1", now)
                .await
                .unwrap();
        let wrong_body = proof(&identity, b"{}", now).await;
        assert_eq!(
            prepared
                .publish(&store, &wrong_body, now, "unused")
                .await
                .unwrap_err()
                .status,
            403
        );
        assert!(
            store
                .read(&keys::paid_control_config())
                .await
                .unwrap()
                .is_none()
        );
        let read_only = make_identity(NativeCapability::SupervisorRead);
        let prepared =
            PreparedConfigurationPublication::capture(&store, &identity, &input, "g1", now)
                .await
                .unwrap();
        let signed = proof(&read_only, prepared.statement(), now).await;
        assert_eq!(
            prepared
                .publish(&store, &signed, now, "unused")
                .await
                .unwrap_err()
                .status,
            403
        );
        let forged = NativeTransportIdentity::new(
            "fixture-key".into(),
            "fixture-owner".into(),
            "fixture-epoch".into(),
            [12; 32],
            BTreeSet::from([NativeCapability::ConfigurationPublish]),
        )
        .unwrap();
        assert!(
            PreparedConfigurationPublication::capture(&store, &forged, &input, "g1", now)
                .await
                .is_err()
        );
        let owner: PaidControlOwner = store::decode(
            store
                .read(&keys::paid_control_owner())
                .await
                .unwrap()
                .as_ref(),
            now,
        )
        .unwrap()
        .unwrap();
        assert_eq!(owner.key_fingerprint, identity.key_fingerprint());
    });
}

#[test]
fn missing_live_owner_never_bootstraps_as_a_side_effect() {
    run(async {
        let store = Memory::default();
        let identity = NativeTransportIdentity::new(
            "live-key".into(),
            "live-owner".into(),
            "live-epoch".into(),
            [12; 32],
            BTreeSet::from([NativeCapability::ConfigurationPublish]),
        )
        .unwrap();
        let now = 1_792_339_000_000;
        let statement = fixture_owner_statement(&identity).unwrap();
        let signed = proof(&identity, &statement, now).await;
        assert!(
            bootstrap_fixture_owner(&store, &identity, &signed, now, "unused")
                .await
                .is_err()
        );
        assert!(
            PreparedConfigurationPublication::capture(
                &store,
                &identity,
                &inputs("first-secret"),
                "g1",
                now
            )
            .await
            .is_err()
        );
        assert!(store.0.lock().unwrap().is_empty());
    });
}

#[test]
fn access_only_read_publishes_raw_and_normalized_identity_atomically() {
    run(async {
        let store = Memory::default();
        let now = 1_792_339_000_000;
        bootstrap(
            &store,
            &make_identity(NativeCapability::ConfigurationPublish),
            now,
        )
        .await;
        let identity = make_identity(NativeCapability::AccessPublish);
        let old = access(1_792_341_000, "user");
        seed_access(&store, &old);
        let original = read_codex_source_pool(&store, now).await.unwrap().unwrap();
        let next = access(1_792_342_000, "user");
        let registered = RegisteredAccessOwner::configured(
            NativeOwnerId("registered-owner".into()),
            "/tmp/uos-native-fixture".into(),
        )
        .unwrap();
        let prepared = PreparedAccessPublication::capture(
            &store,
            &AccessRead(next.clone()),
            &identity,
            &registered,
            now,
            "raw-r2",
        )
        .await
        .unwrap();
        assert!(
            !String::from_utf8_lossy(prepared.statement()).contains(next.access_token.expose())
        );
        let signed = proof(&identity, prepared.statement(), now).await;
        let normalized = prepared.publish(&store, &signed, now).await.unwrap();
        let source = read_codex_source_pool(&store, now).await.unwrap().unwrap();
        assert_eq!(source.revision, "raw-r2");
        assert_eq!(normalized.pool_versionstamp.0, source.revision);
        assert_eq!(source.pool.accounts[0].access_token, next.access_token);
        assert_eq!(source.pool.accounts[1], original.pool.accounts[1]);
        assert_eq!(
            normalized.accounts[0].credential_version,
            source.pool.accounts[0].identity().credential_version
        );
        assert_eq!(
            normalized.accounts[1].admin_account_hash,
            source.pool.accounts[1]
                .identity()
                .administrative_account_hash
        );
    });
}

#[test]
fn same_identity_access_read_preserves_existing_pool_revision() {
    run(async {
        let store = Memory::default();
        let now = 1_792_339_000_000;
        bootstrap(
            &store,
            &make_identity(NativeCapability::ConfigurationPublish),
            now,
        )
        .await;
        let identity = make_identity(NativeCapability::AccessPublish);
        let old = access(1_792_341_000, "user");
        seed_access(&store, &old);
        let registered = RegisteredAccessOwner::configured(
            NativeOwnerId("registered-owner".into()),
            "/tmp/uos-native-fixture".into(),
        )
        .unwrap();
        let prepared = PreparedAccessPublication::capture(
            &store,
            &AccessRead(old),
            &identity,
            &registered,
            now,
            "unused",
        )
        .await
        .unwrap();
        let signed = proof(&identity, prepared.statement(), now).await;
        let pool = prepared.publish(&store, &signed, now).await.unwrap();
        assert_eq!(pool.pool_versionstamp.0, "raw-r1");
        assert_eq!(
            store
                .read(&codex_source_pool_key())
                .await
                .unwrap()
                .unwrap()
                .revision,
            "raw-r1"
        );
        assert_eq!(
            store.read(&keys::pool()).await.unwrap().unwrap().revision,
            "normalized-r1"
        );
    });
}

#[test]
fn access_publication_refuses_stale_source_wrong_home_and_workspace_identity() {
    run(async {
        let store = Memory::default();
        let now = 1_792_339_000_000;
        bootstrap(
            &store,
            &make_identity(NativeCapability::ConfigurationPublish),
            now,
        )
        .await;
        let identity = make_identity(NativeCapability::AccessPublish);
        let old = access(1_792_341_000, "user");
        seed_access(&store, &old);
        let registered = RegisteredAccessOwner::configured(
            NativeOwnerId("registered-owner".into()),
            "/tmp/uos-native-fixture".into(),
        )
        .unwrap();
        let next = AccessRead(access(1_792_342_000, "user"));
        let prepared = PreparedAccessPublication::capture(
            &store,
            &next,
            &identity,
            &registered,
            now,
            "raw-r2",
        )
        .await
        .unwrap();
        let signed = proof(&identity, prepared.statement(), now).await;
        let mut changed = store.read(&codex_source_pool_key()).await.unwrap().unwrap();
        changed.revision = "raced-source".into();
        set(
            &store,
            codex_source_pool_key(),
            "raced-source",
            changed.value,
        );
        assert_eq!(
            prepared
                .publish(&store, &signed, now)
                .await
                .unwrap_err()
                .status,
            409
        );
        seed_access(&store, &old);
        let wrong = RegisteredAccessOwner::configured(
            NativeOwnerId("registered-owner".into()),
            "/tmp/wrong-owner".into(),
        )
        .unwrap();
        assert!(
            PreparedAccessPublication::capture(&store, &next, &identity, &wrong, now, "unused")
                .await
                .is_err()
        );
        assert!(
            PreparedAccessPublication::capture(
                &store,
                &AccessRead(access(1_792_342_000, "other-user")),
                &identity,
                &registered,
                now,
                "unused"
            )
            .await
            .is_err()
        );
        assert_eq!(
            store
                .read(&codex_source_pool_key())
                .await
                .unwrap()
                .unwrap()
                .revision,
            "raw-r1"
        );
    });
}

fn now() -> i64 {
    1_792_339_000_000
}
fn publication_identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "fixture-key".into(),
        "fixture-owner".into(),
        "fixture-epoch".into(),
        [11; 32],
        BTreeSet::from([
            NativeCapability::ConfigurationPublish,
            NativeCapability::AccessPublish,
        ]),
    )
    .unwrap()
}
struct LocalCarrier<'a> {
    receiver: &'a PublicationReceiver,
    store: &'a Memory,
    lose_response: std::cell::Cell<bool>,
    tamper_response: bool,
}
impl PublicationCarrier for LocalCarrier<'_> {
    async fn send(&self, request: PublicationRequest) -> Result<PublicationResponse, GatewayError> {
        let mut response = self.receiver.handle(self.store, request).await;
        if self.lose_response.replace(false) {
            return Err(GatewayError::unavailable(
                "Fixture lost committed response",
                "native_publication_outcome_unknown",
            ));
        }
        if self.tamper_response {
            response.raw_body.push(b' ');
        }
        Ok(response)
    }
}
#[test]
fn signed_sender_receiver_configuration_receipt_and_lost_response_retry() {
    run(async {
        let store = Memory::default();
        let identity = publication_identity();
        bootstrap(&store, &identity, now()).await;
        let inputs = inputs("fixture-paid-key");
        let prepared =
            PreparedConfigurationPublication::capture(&store, &identity, &inputs, "g1", now())
                .await
                .unwrap();
        let command = prepared.command("config-r1").unwrap();
        let receiver =
            PublicationReceiver::configured(identity.clone(), inputs, vec![], now).unwrap();
        let carrier = LocalCarrier {
            receiver: &receiver,
            store: &store,
            lose_response: std::cell::Cell::new(true),
            tamper_response: false,
        };
        let sender = NativePublicationSender::configured(&identity, &carrier);
        assert_eq!(
            sender
                .send(&command, [1; 32], now())
                .await
                .unwrap_err()
                .envelope
                .error
                .code
                .as_deref(),
            Some("native_publication_outcome_unknown")
        );
        assert_eq!(
            store
                .read(&keys::paid_control_config())
                .await
                .unwrap()
                .unwrap()
                .revision,
            "config-r1"
        );
        let receipt = sender.send(&command, [2; 32], now()).await.unwrap();
        assert_eq!(receipt.disposition, PublicationDisposition::AlreadyCurrent);
        assert_eq!(receipt.configuration_revision.as_deref(), Some("config-r1"));
        assert_eq!(
            store
                .read(&keys::paid_control_config())
                .await
                .unwrap()
                .unwrap()
                .revision,
            "config-r1"
        );
        let replay = sender.send(&command, [2; 32], now()).await.unwrap_err();
        assert_eq!(
            replay.envelope.error.code.as_deref(),
            Some("native_publication_response_unverified")
        );
        let bad_carrier = LocalCarrier {
            receiver: &receiver,
            store: &store,
            lose_response: std::cell::Cell::new(false),
            tamper_response: true,
        };
        let sender = NativePublicationSender::configured(&identity, &bad_carrier);
        assert_eq!(
            sender
                .send(&command, [3; 32], now())
                .await
                .unwrap_err()
                .envelope
                .error
                .code
                .as_deref(),
            Some("native_publication_response_unverified")
        );
    });
}

#[test]
fn signed_access_transport_retry_preserves_source_pool_and_other_account() {
    run(async {
        let store = Memory::default();
        let identity = publication_identity();
        bootstrap(&store, &identity, now()).await;
        let old = access(1_792_341_000, "user");
        seed_access(&store, &old);
        let original = read_codex_source_pool(&store, now())
            .await
            .unwrap()
            .unwrap();
        let next = AccessRead(access(1_792_342_000, "user"));
        let registered = RegisteredAccessOwner::configured(
            NativeOwnerId("registered-owner".into()),
            "/tmp/uos-native-fixture".into(),
        )
        .unwrap();
        let prepared = PreparedAccessPublication::capture(
            &store,
            &next,
            &identity,
            &registered,
            now(),
            "raw-r2",
        )
        .await
        .unwrap();
        let command = prepared.command().unwrap();
        let receiver = PublicationReceiver::configured(
            identity.clone(),
            inputs("fixture-paid-key"),
            vec![registered],
            now,
        )
        .unwrap();
        let carrier = LocalCarrier {
            receiver: &receiver,
            store: &store,
            lose_response: std::cell::Cell::new(true),
            tamper_response: false,
        };
        let sender = NativePublicationSender::configured(&identity, &carrier);
        assert!(sender.send(&command, [4; 32], now()).await.is_err());
        let receipt = sender.send(&command, [5; 32], now()).await.unwrap();
        assert_eq!(receipt.disposition, PublicationDisposition::AlreadyCurrent);
        assert_eq!(receipt.source_revision.as_deref(), Some("raw-r2"));
        assert_eq!(receipt.pool_versionstamp, receipt.source_revision);
        let current = read_codex_source_pool(&store, now())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(current.pool.accounts[1], original.pool.accounts[1]);
        assert_eq!(current.revision, "raw-r2");
    });
}

#[test]
fn native_publication_headers_preserve_duplicate_and_missing_auth_rejection() {
    use gateway_publication::transport::OwnedNativeAuthHeaders;
    assert!(OwnedNativeAuthHeaders::from_pairs(Vec::new()).is_err());
    let values = vec![
        ("x-uos-native-version".into(), "1".into()),
        ("x-uos-native-key-id".into(), "fixture-key".into()),
        ("x-uos-native-time-ms".into(), now().to_string()),
        ("x-uos-native-nonce".into(), base64url(&[1; 32])),
        ("x-uos-native-mac".into(), base64url(&[2; 32])),
    ];
    assert!(OwnedNativeAuthHeaders::from_pairs(values.clone()).is_ok());
    let mut duplicated = values;
    duplicated.push(("X-UOS-NATIVE-MAC".into(), base64url(&[3; 32])));
    assert!(OwnedNativeAuthHeaders::from_pairs(duplicated).is_err());
}

#[test]
fn configuration_capture_retains_frozen_constructor_bytes_without_writes() {
    run(async {
        let store = Memory::default();
        let identity = make_identity(NativeCapability::ConfigurationPublish);
        bootstrap(&store, &identity, now()).await;
        set(
            &store,
            runtime_config_key(),
            "runtime-r1",
            json!({"model":"fixture-model","reasoning":"none"}),
        );
        let before = serde_json::to_vec(&*store.0.lock().unwrap()).unwrap();
        let inputs = inputs("fixture-surplus-key");
        let captured = PreparedConfigurationPublication::capture(
            &store,
            &identity,
            &inputs,
            "generation-1",
            now(),
        )
        .await
        .unwrap();
        // Frozen pre-factor constructor and statement field order, including
        // serde_json preserve_order, independent role bindings and source check.
        let expected = r##"{"operation":"configuration_publish","config":{"v":2,"owner_id":"fixture-owner","owner_epoch":"fixture-epoch","generation":"generation-1","configuration_fingerprint":"7e4f95cb2d3e6fc83456a70ee81483136e0a7df605d26c54e35ad2adbee4877a","surplus_binding":"73ca14b414d233bf44ab369bebeb5738a0b40225cf785b51bfc3598592da17f2","openlux_discovery_binding":"0659c996bc5d3905c397ebf64917f0676f4bd6256640548758cce1c3d57dc524","openlux_binding":"0659c996bc5d3905c397ebf64917f0676f4bd6256640548758cce1c3d57dc524","source_checks":[{"key":"tuple-v1:02756f735f6169000272756e74696d655f636f6e6669670002763200","expected_revision":"runtime-r1"}]},"owner_revision":"owner-r1","previous_config_revision":null}"##;
        assert_eq!(captured.statement(), expected.as_bytes());
        assert_eq!(
            serde_json::to_vec(&*store.0.lock().unwrap()).unwrap(),
            before
        );
        set(
            &store,
            keys::paid_control_config(),
            "config-r1",
            serde_json::to_value(captured.configuration()).unwrap(),
        );
        set(
            &store,
            runtime_config_key(),
            "runtime-r2",
            json!({"model":"fixture-model","reasoning":"none"}),
        );
        assert_eq!(
            PreparedConfigurationPublication::capture(
                &store,
                &identity,
                &inputs,
                "generation-1",
                now()
            )
            .await
            .err()
            .unwrap()
            .status,
            409
        );
        let next = PreparedConfigurationPublication::capture(
            &store,
            &identity,
            &inputs,
            "generation-2",
            now(),
        )
        .await
        .unwrap();
        assert_eq!(
            next.configuration().configuration_fingerprint,
            captured.configuration().configuration_fingerprint
        );
        assert_eq!(
            next.configuration().source_checks[0]
                .expected_revision
                .as_deref(),
            Some("runtime-r2")
        );
    });
}

#[test]
fn source_utf16_runtime_capture_and_signed_receiver_keep_the_actual_codec() {
    use gateway_core::{source_control::encode_source_control_record, source_json::SourceJson};
    run(async {
        let store = Memory::default();
        let identity = publication_identity();
        bootstrap(&store, &identity, now()).await;
        let runtime = encode_source_control_record(
            "runtime-profile-r1",
            &SourceJson::parse(r#"{"model":"\ud800","reasoning":"none"}"#).unwrap(),
            None,
        )
        .unwrap();
        store
            .0
            .lock()
            .unwrap()
            .insert(runtime_config_key().0.clone(), runtime.clone());
        let configured = inputs("fixture-paid-key");
        let prepared =
            PreparedConfigurationPublication::capture(&store, &identity, &configured, "g1", now())
                .await
                .unwrap();
        let expected = prepared.configuration().clone();
        assert_eq!(
            expected.source_checks[0].expected_revision.as_deref(),
            Some("runtime-profile-r1")
        );
        let command = prepared.command("profile-config-r1").unwrap();
        let receiver =
            PublicationReceiver::configured(identity.clone(), configured, vec![], now).unwrap();
        let carrier = LocalCarrier {
            receiver: &receiver,
            store: &store,
            lose_response: std::cell::Cell::new(false),
            tamper_response: false,
        };
        let sender = NativePublicationSender::configured(&identity, &carrier);
        let receipt = sender.send(&command, [71; 32], now()).await.unwrap();
        assert_eq!(receipt.disposition, PublicationDisposition::Applied);
        assert_eq!(
            receipt.configuration_fingerprint.as_deref(),
            Some(expected.configuration_fingerprint.as_str())
        );
        let replay = sender.send(&command, [72; 32], now()).await.unwrap();
        assert_eq!(replay.disposition, PublicationDisposition::AlreadyCurrent);
        assert_eq!(
            store
                .0
                .lock()
                .unwrap()
                .get(&runtime_config_key().0)
                .unwrap(),
            &runtime
        );
    });
}
