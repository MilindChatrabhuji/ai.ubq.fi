//! Fixture-only authority initialization and configuration publication.
//! HTTP protocol composition stays in gateway-worker-fixture.

use gateway_auth::{
    GatewayError,
    crypto::{Secret, base64url},
    native::NATIVE_PUBLICATION_PATH,
    native_auth::{NativeAuthHeaders, NativeAuthenticator, NativeTransportIdentity},
    native_replay::StoreNonceAuthority,
    provider_credentials::{
        CodexSourceAccount, CodexSourcePool, codex_source_pool_key, parse_codex_source_pool,
    },
};
use gateway_authority::{
    keys,
    paid_control::{PAID_CONTROL_CONFIG_VERSION, PaidControlConfig, PaidControlOwner},
    routing::{PoolAccount, SubscriptionPool},
};
use gateway_core::{
    identity::PoolVersionstamp,
    provider::PaidProvider,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation, RevisionCheck,
        StoredRecord,
    },
};
use gateway_publication::{
    control_publication::{
        ConfiguredPaidInputs, PreparedConfigurationPublication, bootstrap_fixture_owner,
        fixture_owner_statement, runtime_config_key,
    },
    transport::{
        NativePublicationSender, PublicationCarrier, PublicationReceiver, PublicationRequest,
        PublicationResponse,
    },
};
use gateway_worker::authority::RemoteAuthorityStore;

fn nonce() -> Result<[u8; 32], GatewayError> {
    gateway_worker::transport::random::random_bytes(32)?
        .try_into()
        .map_err(|_| invalid())
}

pub async fn initialize(
    store: &RemoteAuthorityStore,
    identity: &NativeTransportIdentity,
    inputs: &ConfiguredPaidInputs,
    receiver: &PublicationReceiver,
    scenario: &str,
) -> Result<(), GatewayError> {
    if initialized(store, identity, inputs).await? {
        if scenario == "paid" {
            let now = gateway_worker::storage::now_ms()?;
            if let Some(prepared) = after_runtime_bootstrap(store, identity, inputs, now).await? {
                send_configuration(
                    store,
                    identity,
                    receiver,
                    prepared,
                    "fixture-matrix-config-publication-after-runtime-v2",
                    now,
                    nonce_bytes()?,
                )
                .await?;
            }
        }
        return Ok(());
    }
    if matches!(scenario, "codex" | "paid") {
        seed_pool(store).await?;
    }
    let now = gateway_worker::storage::now_ms()?;
    let body = fixture_owner_statement(identity)?;
    let nonce = base64url(&nonce()?);
    let time = now.to_string();
    let mac = identity.sign(NATIVE_PUBLICATION_PATH, now, &nonce, &body)?;
    let replay = StoreNonceAuthority::new(store);
    let proof = NativeAuthenticator::new(identity, &replay)
        .authenticate(
            NATIVE_PUBLICATION_PATH,
            NativeAuthHeaders {
                version: "1",
                key_id: identity.key_id(),
                time_ms: &time,
                nonce: &nonce,
                mac: &mac,
            },
            &body,
            now,
        )
        .await?;
    bootstrap_fixture_owner(store, identity, &proof, now, "fixture-matrix-owner-v1").await?;
    let prepared = PreparedConfigurationPublication::capture(
        store,
        identity,
        inputs,
        "fixture-matrix-config-v1",
        now,
    )
    .await?;
    send_configuration(
        store,
        identity,
        receiver,
        prepared,
        "fixture-matrix-config-publication-v1",
        now,
        nonce_bytes()?,
    )
    .await
}

async fn send_configuration<S: AuthorityStore>(
    store: &S,
    identity: &NativeTransportIdentity,
    receiver: &PublicationReceiver,
    prepared: PreparedConfigurationPublication,
    revision: &str,
    now: i64,
    nonce: [u8; 32],
) -> Result<(), GatewayError> {
    let command = prepared.command(revision)?;
    let carrier = Carrier { store, receiver };
    NativePublicationSender::configured(identity, &carrier)
        .send(&command, nonce, now)
        .await?;
    Ok(())
}

/// One controlled paid fixture transition, not application configuration refresh.
async fn after_runtime_bootstrap<S: AuthorityStore>(
    store: &S,
    identity: &NativeTransportIdentity,
    inputs: &ConfiguredPaidInputs,
    now: i64,
) -> Result<Option<PreparedConfigurationPublication>, GatewayError> {
    if !initialized(store, identity, inputs).await? {
        return Ok(None);
    }
    let config_row = store
        .read(&keys::paid_control_config())
        .await?
        .ok_or_else(invalid)?;
    let config: PaidControlConfig =
        serde_json::from_value(config_row.json_value()?.clone()).map_err(|_| invalid())?;
    let runtime_key = runtime_config_key();
    if config.generation != "fixture-matrix-config-v1"
        || config_row.revision != "fixture-matrix-config-publication-v1"
        || config.source_checks.len() != 1
        || config.source_checks[0].key != runtime_key.0
        || config.source_checks[0].expected_revision.is_some()
    {
        return Ok(None);
    }
    let Some(runtime) = store.read(&runtime_key).await? else {
        return Ok(None);
    };
    if !runtime
        .json_value()?
        .get("codex_models")
        .is_some_and(serde_json::Value::is_object)
    {
        return Ok(None);
    }
    let prepared = PreparedConfigurationPublication::capture(
        store,
        identity,
        inputs,
        "fixture-matrix-config-after-runtime-v2",
        now,
    )
    .await?;
    if prepared.configuration().source_checks.len() != 1
        || prepared.configuration().source_checks[0].key != runtime_key.0
        || prepared.configuration().source_checks[0]
            .expected_revision
            .as_ref()
            != Some(&runtime.revision)
        || store
            .read(&keys::paid_control_config())
            .await?
            .as_ref()
            .map(|row| &row.revision)
            != Some(&config_row.revision)
    {
        return Err(invalid());
    }
    Ok(Some(prepared))
}

async fn initialized<S: AuthorityStore>(
    store: &S,
    identity: &NativeTransportIdentity,
    inputs: &ConfiguredPaidInputs,
) -> Result<bool, GatewayError> {
    let Some(config) = store.read(&keys::paid_control_config()).await? else {
        return Ok(false);
    };
    let owner = store
        .read(&keys::paid_control_owner())
        .await?
        .ok_or_else(invalid)?;
    let owner: PaidControlOwner =
        serde_json::from_value(owner.json_value()?.clone()).map_err(|_| invalid())?;
    let config: PaidControlConfig =
        serde_json::from_value(config.json_value()?.clone()).map_err(|_| invalid())?;
    if owner.v != 1
        || owner.owner_id != identity.owner_id()
        || owner.owner_epoch != identity.owner_epoch()
        || owner.key_fingerprint != identity.key_fingerprint()
        || config.v != PAID_CONTROL_CONFIG_VERSION
        || config.owner_id != owner.owner_id
        || config.owner_epoch != owner.owner_epoch
        || config.surplus_binding != inputs.binding(PaidProvider::Surplus)
        || config.openlux_binding != inputs.binding(PaidProvider::Metered)
        || config.openlux_discovery_binding != inputs.discovery_binding(PaidProvider::Metered)
    {
        return Err(invalid());
    }
    // Never republish configuration or recreate a removed pool during a request.
    // Product routes, not setup, own current source-check and runtime fencing.
    Ok(true)
}

fn nonce_bytes() -> Result<[u8; 32], GatewayError> {
    nonce()
}
fn token(account: &str, now: i64) -> String {
    let head = base64url(br#"{"alg":"none","typ":"JWT"}"#);
    let claims = serde_json::json!({"iss":"uos-runtime-matrix","exp":now/1000+3600,"https://api.openai.com/auth":{"chatgpt_account_id":account,"chatgpt_user_id":"fixture-matrix-user","chatgpt_plan_type":"plus"}});
    format!(
        "{head}.{}.fixture",
        base64url(claims.to_string().as_bytes())
    )
}
fn fixture_pool(now: i64) -> CodexSourcePool {
    CodexSourcePool {
        accounts: ["fixture-matrix-a", "fixture-matrix-b"]
            .into_iter()
            .map(|account| CodexSourceAccount {
                account_id: account.into(),
                access_token: Secret::new(token(account, now)),
                refresh_token: Secret::new(format!("fixture-refresh-{account}")),
                updated_at_ms: now as f64,
                native_owner: None,
            })
            .collect(),
        updated_at_ms: now as f64,
    }
}

async fn seed_pool(store: &RemoteAuthorityStore) -> Result<(), GatewayError> {
    let source_key = codex_source_pool_key();
    let pool_key = keys::pool();
    let raw = store.read(&source_key).await?;
    let normalized = store.read(&pool_key).await?;
    if raw.is_some() || normalized.is_some() {
        if raw.is_none() || normalized.is_none() {
            return Err(invalid());
        }
        // Never overwrite, repair or reset a current quota/claim/configuration.
        let source = parse_codex_source_pool(raw.as_ref().ok_or_else(invalid)?.json_value()?)?
            .ok_or_else(invalid)?;
        if source.accounts.len() != 2
            || source
                .accounts
                .iter()
                .any(|account| !account.account_id.starts_with("fixture-matrix-"))
        {
            return Err(invalid());
        }
        return Ok(());
    }
    let now = gateway_worker::storage::now_ms()?;
    let pool = fixture_pool(now);
    let raw = pool.private_source_value();
    let parsed = parse_codex_source_pool(&raw)?.ok_or_else(invalid)?;
    let revision = "fixture-matrix-source-v1";
    let normalized = SubscriptionPool {
        v: 1,
        pool_versionstamp: PoolVersionstamp(revision.into()),
        accounts: parsed
            .accounts
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
    };
    let records = [
        (source_key, StoredRecord::json(revision, raw, None)),
        (
            pool_key,
            StoredRecord::json(
                "fixture-matrix-pool-v1",
                serde_json::to_value(normalized).map_err(|_| invalid())?,
                None,
            ),
        ),
    ];
    let transition = AtomicTransition {
        checks: records
            .iter()
            .map(|(key, _)| RevisionCheck {
                key: key.clone(),
                expected_revision: None,
            })
            .collect(),
        mutations: records
            .into_iter()
            .map(|(key, record)| RecordMutation::Put { key, record })
            .collect(),
    };
    if !matches!(store.commit(transition).await?, CommitOutcome::Committed) {
        return Err(invalid());
    }
    Ok(())
}

struct Carrier<'a, S> {
    store: &'a S,
    receiver: &'a PublicationReceiver,
}
impl<S: AuthorityStore> PublicationCarrier for Carrier<'_, S> {
    async fn send(&self, request: PublicationRequest) -> Result<PublicationResponse, GatewayError> {
        Ok(self.receiver.handle(self.store, request).await)
    }
}
pub fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Controlled Rust fixture setup failed",
        "matrix_fixture_setup_failed",
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn typed_fixture_pool_is_valid_without_native_ownership() {
        let now = 1_800_000_000_000;
        let pool = super::fixture_pool(now);
        let raw = pool.private_source_value();
        let parsed = super::parse_codex_source_pool(&raw).unwrap().unwrap();
        assert_eq!(parsed.accounts.len(), 2);
        for account in parsed.accounts {
            assert!(account.native_owner.is_none());
            assert_eq!(
                account.refresh_token.expose(),
                format!("fixture-refresh-{}", account.account_id)
            );
            assert_eq!(
                gateway_auth::provider_credentials::codex_access_expiry_ms(&account.access_token),
                Some((now + 3_600_000) as f64)
            );
        }
        let mut rejected = raw;
        rejected["accounts"][0]["refresh_token"] = serde_json::json!("");
        assert!(super::parse_codex_source_pool(&rejected).unwrap().is_none());
    }
    use gateway_auth::{
        GatewayError,
        crypto::base64url,
        native_auth::{NativeAuthHeaders, NativeAuthenticator},
        native_replay::StoreNonceAuthority,
    };
    use gateway_authority::{keys, paid_control::PaidControlConfig};
    use gateway_core::state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    };
    use gateway_publication::{
        control_publication::{
            PreparedConfigurationPublication, bootstrap_fixture_owner, fixture_owner_statement,
            runtime_config_key,
        },
        transport::PublicationReceiver,
    };
    use std::{
        cell::RefCell,
        collections::{BTreeMap, BTreeSet},
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
    };
    const NOW: i64 = 1_800_000_000_000;
    fn now() -> i64 {
        NOW
    }
    fn identity() -> Result<super::NativeTransportIdentity, GatewayError> {
        super::NativeTransportIdentity::new(
            "fixture-matrix-key".into(),
            "fixture-matrix-owner".into(),
            "fixture-matrix-epoch".into(),
            [31; 32],
            BTreeSet::from([gateway_auth::native_auth::NativeCapability::ConfigurationPublish]),
        )
    }
    fn inputs() -> Result<super::ConfiguredPaidInputs, GatewayError> {
        super::ConfiguredPaidInputs::new(
            Some(super::Secret::new("fixture-matrix-surplus".into())),
            Some(super::Secret::new(
                "fixture-matrix-openlux-discovery".into(),
            )),
            Some(super::Secret::new("fixture-matrix-openlux-spend".into())),
            serde_json::json!({"fixture":"runtime-matrix-v1"}),
        )
    }
    #[derive(Default)]
    struct Memory(RefCell<BTreeMap<String, StoredRecord>>);
    impl AuthorityStore for Memory {
        async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
            Ok(self
                .0
                .borrow()
                .get(&key.0)
                .filter(|row| row.expires_at_ms.is_none_or(|at| at > NOW))
                .cloned())
        }
        async fn commit(&self, tx: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
            let mut rows = self.0.borrow_mut();
            if tx.checks.iter().any(|check| {
                rows.get(&check.key.0)
                    .filter(|row| row.expires_at_ms.is_none_or(|at| at > NOW))
                    .map(|row| &row.revision)
                    != check.expected_revision.as_ref()
            }) {
                return Ok(CommitOutcome::Conflict);
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
            Ok(CommitOutcome::Committed)
        }
    }
    fn run<F: Future>(future: F) -> F::Output {
        let mut context = Context::from_waker(Waker::noop());
        let mut future = pin!(future);
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("in-memory publication must complete without I/O"),
        }
    }
    async fn owner(store: &Memory, identity: &gateway_auth::native_auth::NativeTransportIdentity) {
        let body = fixture_owner_statement(identity).unwrap();
        let nonce = base64url(&[1; 32]);
        let time = NOW.to_string();
        let mac = identity
            .sign(
                gateway_auth::native::NATIVE_PUBLICATION_PATH,
                NOW,
                &nonce,
                &body,
            )
            .unwrap();
        let replay = StoreNonceAuthority::new(store);
        let proof = NativeAuthenticator::new(identity, &replay)
            .authenticate(
                gateway_auth::native::NATIVE_PUBLICATION_PATH,
                NativeAuthHeaders {
                    version: "1",
                    key_id: identity.key_id(),
                    time_ms: &time,
                    nonce: &nonce,
                    mac: &mac,
                },
                &body,
                NOW,
            )
            .await
            .unwrap();
        bootstrap_fixture_owner(store, identity, &proof, NOW, "fixture-matrix-owner-v1")
            .await
            .unwrap();
    }
    async fn config(store: &Memory) -> PaidControlConfig {
        let row = store
            .read(&keys::paid_control_config())
            .await
            .unwrap()
            .unwrap();
        serde_json::from_value(row.json_value().unwrap().clone()).unwrap()
    }
    async fn current_sources(store: &Memory) -> bool {
        for check in config(store).await.source_checks {
            if store
                .read(&RecordKey(check.key))
                .await
                .unwrap()
                .as_ref()
                .map(|row| &row.revision)
                != check.expected_revision.as_ref()
            {
                return false;
            }
        }
        true
    }
    async fn runtime(store: &Memory, revision: &str) {
        let key = runtime_config_key();
        let before = store.read(&key).await.unwrap();
        let row = StoredRecord::json(
            revision,
            serde_json::json!({"version":2,"codex_models":{"models":[]},"default_model":"gpt-matrix-test","default_reasoning_effort":"medium","updated_at_ms":NOW}),
            None,
        );
        assert_eq!(
            store
                .commit(AtomicTransition {
                    checks: vec![gateway_core::state::RevisionCheck {
                        key: key.clone(),
                        expected_revision: before.map(|row| row.revision)
                    }],
                    mutations: vec![RecordMutation::Put { key, record: row }]
                })
                .await
                .unwrap(),
            CommitOutcome::Committed
        );
    }
    #[test]
    fn paid_bootstrap_republishes_once_through_real_authenticated_capture_and_cas() {
        run(async {
            let store = Memory::default();
            let identity = identity().unwrap();
            let inputs = inputs().unwrap();
            let receiver =
                PublicationReceiver::configured(identity.clone(), inputs.clone(), Vec::new(), now)
                    .unwrap();
            owner(&store, &identity).await;
            let prepared = PreparedConfigurationPublication::capture(
                &store,
                &identity,
                &inputs,
                "fixture-matrix-config-v1",
                NOW,
            )
            .await
            .unwrap();
            super::send_configuration(
                &store,
                &identity,
                &receiver,
                prepared,
                "fixture-matrix-config-publication-v1",
                NOW,
                [2; 32],
            )
            .await
            .unwrap();
            assert!(current_sources(&store).await);
            let before = config(&store).await;
            assert_eq!(before.source_checks[0].expected_revision, None);
            let stale = PreparedConfigurationPublication::capture(
                &store,
                &identity,
                &inputs,
                "fixture-matrix-config-v1",
                NOW,
            )
            .await
            .unwrap();
            assert!(
                super::after_runtime_bootstrap(&store, &identity, &inputs, NOW)
                    .await
                    .unwrap()
                    .is_none()
            );
            runtime(&store, "real-catalogue-runtime-1").await;
            assert!(
                !current_sources(&store).await,
                "same unchanged Worker source-revision condition must refuse before spend"
            );
            assert!(
                super::send_configuration(
                    &store,
                    &identity,
                    &receiver,
                    stale,
                    "fixture-matrix-config-publication-v1",
                    NOW,
                    [3; 32]
                )
                .await
                .is_err(),
                "old authenticated snapshot must not ignore the changed runtime source"
            );
            let prepared = super::after_runtime_bootstrap(&store, &identity, &inputs, NOW)
                .await
                .unwrap()
                .expect("actual completed bootstrap is the single allowed transition");
            assert_eq!(
                prepared.configuration().source_checks[0]
                    .expected_revision
                    .as_deref(),
                Some("real-catalogue-runtime-1")
            );
            super::send_configuration(
                &store,
                &identity,
                &receiver,
                prepared,
                "fixture-matrix-config-publication-after-runtime-v2",
                NOW,
                [4; 32],
            )
            .await
            .unwrap();
            assert!(current_sources(&store).await);
            let after = config(&store).await;
            assert_eq!(after.generation, "fixture-matrix-config-after-runtime-v2");
            assert_ne!(
                after.configuration_fingerprint,
                before.configuration_fingerprint
            );
            let stale = PreparedConfigurationPublication::capture(
                &store,
                &identity,
                &inputs,
                "fixture-matrix-config-after-runtime-v2",
                NOW,
            )
            .await
            .unwrap();
            runtime(&store, "later-runtime-change").await;
            assert!(
                super::after_runtime_bootstrap(&store, &identity, &inputs, NOW)
                    .await
                    .unwrap()
                    .is_none(),
                "v2 must never become a per-request refresh policy"
            );
            assert!(!current_sources(&store).await);
            assert!(
                super::send_configuration(
                    &store,
                    &identity,
                    &receiver,
                    stale,
                    "fixture-matrix-config-publication-after-runtime-v2",
                    NOW,
                    [5; 32]
                )
                .await
                .is_err()
            );
        });
    }
    #[test]
    fn one_shot_requires_the_exact_initial_absence_snapshot_and_real_owner() {
        run(async {
            let store = Memory::default();
            let identity = identity().unwrap();
            let inputs = inputs().unwrap();
            let receiver =
                PublicationReceiver::configured(identity.clone(), inputs.clone(), Vec::new(), now)
                    .unwrap();
            owner(&store, &identity).await;
            runtime(&store, "already-present-before-capture").await;
            let prepared = PreparedConfigurationPublication::capture(
                &store,
                &identity,
                &inputs,
                "fixture-matrix-config-v1",
                NOW,
            )
            .await
            .unwrap();
            super::send_configuration(
                &store,
                &identity,
                &receiver,
                prepared,
                "fixture-matrix-config-publication-v1",
                NOW,
                [2; 32],
            )
            .await
            .unwrap();
            runtime(&store, "later-change-not-absence-bootstrap").await;
            assert!(
                super::after_runtime_bootstrap(&store, &identity, &inputs, NOW)
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(!current_sources(&store).await);
            store.0.borrow_mut().remove(&keys::paid_control_owner().0);
            assert!(
                super::after_runtime_bootstrap(&store, &identity, &inputs, NOW)
                    .await
                    .is_err()
            );
        });
    }
}
