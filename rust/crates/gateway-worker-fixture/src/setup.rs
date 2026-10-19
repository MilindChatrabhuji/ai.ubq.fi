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
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
        StoredRecord,
    },
};
use gateway_publication::{
    ConfiguredPaidInputs, PreparedConfigurationPublication,
    control_publication::{bootstrap_fixture_owner, fixture_owner_statement},
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
    let command = prepared.command("fixture-matrix-config-publication-v1")?;
    let carrier = Carrier { store, receiver };
    NativePublicationSender::configured(identity, &carrier)
        .send(&command, nonce_bytes()?, now)
        .await?;
    Ok(())
}

async fn initialized(
    store: &RemoteAuthorityStore,
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
    for check in config.source_checks {
        let row = store.read(&RecordKey(check.key)).await?;
        if row.map(|row| row.revision) != check.expected_revision {
            return Err(invalid());
        }
    }
    // Never republish configuration or recreate a removed pool during a request.
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
    let pool = CodexSourcePool {
        accounts: ["fixture-matrix-a", "fixture-matrix-b"]
            .into_iter()
            .map(|account| CodexSourceAccount {
                account_id: account.into(),
                access_token: Secret::new(token(account, now)),
                refresh_token: Secret::new(String::new()),
                updated_at_ms: now as f64,
                native_owner: None,
            })
            .collect(),
        updated_at_ms: now as f64,
    };
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

struct Carrier<'a> {
    store: &'a RemoteAuthorityStore,
    receiver: &'a PublicationReceiver,
}
impl PublicationCarrier for Carrier<'_> {
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
