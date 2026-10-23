//! Synthetic constructors only. All HTTP protocol handlers stay in gateway-worker.
use super::*;
use gateway_auth::{
    AuthConfig, AuthHost, AuthRequest,
    crypto::{Secret, sha256_hex},
    passkeys::{self, PasskeySession, PasskeyUser},
    provider_credentials::{
        CodexNativeOwner, CodexSourceAccount, CodexSourcePool, codex_credential_identity,
        codex_source_pool_key,
    },
    session_index,
    upstream::{AuthUpstreamRequest, AuthUpstreamResponse},
    webauthn::{CosePublicKey, SignatureInput, WebAuthnCrypto},
};
use gateway_authority::{
    Authority, AuthorityClock, TokenSource, keys,
    native_control::{
        NativeRenewalAuthority, NativeRenewalCancellation, RegisteredRenewalOwner,
        RegisteredRenewalOwners, actor::authenticate_admin_actor,
    },
    routing::{PoolAccount, SubscriptionPool},
};
use gateway_core::{
    identity::{PoolVersionstamp, PrincipalId, RequestContext, RequestId},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation, RevisionCheck,
        StoredRecord,
    },
};
use gateway_worker::authority::RemoteAuthorityStore;
use gateway_worker_fixture_setup::invalid;
use std::collections::BTreeMap;
const HOME: &str = "/tmp/worker-import-synthetic-owner";
const OWNER: &str = "fixture-import-native-owner";
const USER: &str = "fixture-import-user";
const SESSION: &str = "uos_ai_session_SYNTHETIC_WORKER_IMPORT_TOKEN";
struct Clock;
impl AuthorityClock for Clock {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        gateway_worker::storage::now_ms()
    }
}
struct Tokens;
impl TokenSource for Tokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        gateway_worker::transport::random::random_uuid()
    }
}
struct Host;
impl WebAuthnCrypto for Host {
    async fn validate_key(&self, _: &CosePublicKey) -> Result<(), GatewayError> {
        Err(invalid())
    }
    async fn verify_signature(&self, _: SignatureInput) -> Result<bool, GatewayError> {
        Err(invalid())
    }
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        now()
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        gateway_worker::transport::random::random_bytes(len)
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        Err(invalid())
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        Err(invalid())
    }
}
struct Cancel;
impl NativeRenewalCancellation for Cancel {
    fn cancelled(&self) -> bool {
        false
    }
}
fn config(env: &Env) -> AuthConfig {
    let names = [
        "UOS_AI_TOKEN",
        "DENO_DEPLOY_TOKEN",
        "DENO_TIMELINE",
        "DENO_DEPLOY",
        "DENO_DEPLOYMENT_ID",
        "DENO_REGION",
        "UOS_AI_KERNEL_PUBLIC_KEY",
        "DENO_DEPLOY_APP_SLUG",
        "DENO_DEPLOY_ORG_SLUG",
    ];
    let values = names
        .into_iter()
        .filter_map(|name| {
            env.secret(name)
                .map(|v| v.to_string())
                .or_else(|_| env.var(name).map(|v| v.to_string()))
                .ok()
                .map(|v| (name.to_owned(), v))
        })
        .collect();
    AuthConfig::from_source_values(&values, true)
}
pub(super) fn identity() -> Result<NativeTransportIdentity, GatewayError> {
    NativeTransportIdentity::new(
        "fixture-matrix-key".into(),
        "fixture-matrix-owner".into(),
        "fixture-matrix-epoch".into(),
        [31; 32],
        BTreeSet::from([
            NativeCapability::ConfigurationPublish,
            NativeCapability::CodexAuthImport,
        ]),
    )
}
pub(super) fn owners() -> Result<RegisteredRenewalOwners, GatewayError> {
    RegisteredRenewalOwners::configured(vec![RegisteredRenewalOwner::configured(
        OWNER.into(),
        HOME.into(),
    )?])
}
/// Existing health response carries safe synthetic metadata only in this fixture;
/// there is no new product route or caller-controlled permission constructor.
pub(super) async fn initialize(
    env: &Env,
    receiver: &PublicationReceiver,
    id: &NativeTransportIdentity,
    inputs: &ConfiguredPaidInputs,
) -> Result<Option<String>, GatewayError> {
    let store = RemoteAuthorityStore::from_env(env)?;
    let user_key = passkeys::key("users", USER);
    if store.read(&user_key).await?.is_some() {
        return Ok(None);
    }
    gateway_worker_fixture_setup::initialize(&store, id, inputs, receiver, "direct").await?;
    let time = now();
    let source_key = codex_source_pool_key();
    let source_rev = "fixture-import-source-v1";
    let account_id = "fixture-import-account";
    let mut account = CodexSourceAccount {
        account_id: account_id.into(),
        access_token: Secret::new("fixture-import-old-access".into()),
        refresh_token: Secret::new(String::new()),
        updated_at_ms: time as f64,
        native_owner: Some(CodexNativeOwner {
            codex_home: HOME.into(),
            generation_hash: sha256_hex(b"physical-before-import"),
            native_refreshed_at: None,
            external_user_id: None,
            managed_source: Some(gateway_auth::provider_credentials::ManagedNativeSource {
                v: gateway_auth::provider_credentials::MANAGED_NATIVE_SOURCE_VERSION,
                generation_hash: sha256_hex(b"physical-before-import"),
            }),
        }),
    };
    let credential = account.identity();
    account
        .native_owner
        .as_mut()
        .ok_or_else(invalid)?
        .generation_hash = credential.native_generation_hash.clone();
    let pool = CodexSourcePool {
        accounts: vec![account],
        updated_at_ms: time as f64,
    };
    let normalized = SubscriptionPool {
        v: 1,
        pool_versionstamp: PoolVersionstamp(source_rev.into()),
        accounts: vec![PoolAccount {
            account_id_hash: credential.routing_account_hash.clone(),
            admin_account_hash: credential.administrative_account_hash,
            credential_version: credential.credential_version,
            enabled: true,
        }],
    };
    let session = PasskeySession {
        token: SESSION.into(),
        user_id: USER.into(),
        created_at_ms: time,
        expires_at_ms: time + 120_000,
        audience_origin: None,
    };
    let records = vec![
        (
            source_key,
            StoredRecord::json(source_rev, pool.private_source_value(), None),
        ),
        (
            keys::pool(),
            StoredRecord::json(
                "fixture-import-pool-v1",
                serde_json::to_value(normalized).map_err(|_| invalid())?,
                None,
            ),
        ),
        (
            user_key,
            StoredRecord::json(
                "fixture-import-user-v1",
                serde_json::to_value(PasskeyUser {
                    id: USER.into(),
                    handle: "operator".into(),
                    is_admin: true,
                    credential_ids: vec!["credential".into()],
                    created_at_ms: time,
                    updated_at_ms: time,
                })
                .map_err(|_| invalid())?,
                None,
            ),
        ),
        (
            passkeys::key("sessions", SESSION),
            StoredRecord::json(
                "fixture-import-session-v1",
                serde_json::to_value(&session).map_err(|_| invalid())?,
                None,
            ),
        ),
        (
            session_index::index_key(&session_index::digest(SESSION))?,
            session_index::record_for_session(&session, "fixture-import-session-v1", None)?,
        ),
    ];
    if store
        .commit(AtomicTransition {
            checks: records
                .iter()
                .map(|(k, _)| RevisionCheck {
                    key: k.clone(),
                    expected_revision: None,
                })
                .collect(),
            mutations: records
                .into_iter()
                .map(|(key, record)| RecordMutation::Put { key, record })
                .collect(),
        })
        .await?
        != CommitOutcome::Committed
    {
        return Err(invalid());
    }
    let authority = Authority::with_clock(store.clone(), Tokens, Clock);
    let cfg = config(env);
    worker::console_error!(
        "M52 fixture config production={} hosted={} std_absolute={}",
        cfg.production,
        cfg.hosted,
        std::path::Path::new(HOME).is_absolute()
    );
    let context = RequestContext {
        request_id: RequestId("fixture-import-original-request".into()),
        principal: PrincipalId(format!("passkey-user:{USER}")),
        key_id: None,
        route: "responses".into(),
        started_at_ms: time,
    };
    let auth = AuthRequest {
        method: "POST".into(),
        url: "https://ai.ubq.fi/v1/responses".into(),
        headers: BTreeMap::from([("authorization".into(), format!("Bearer {SESSION}"))]),
        ..Default::default()
    };
    let actor = authenticate_admin_actor(&authority, &Host, &cfg, &auth, &context)
        .await
        .inspect_err(|error| {
            worker::console_error!(
                "M52 fixture actor error {}",
                error.envelope.error.code.as_deref().unwrap_or("none")
            );
        })?;
    let owner =
        RegisteredRenewalOwner::configured(OWNER.into(), HOME.into()).inspect_err(|error| {
            worker::console_error!(
                "M52 fixture owner error {}",
                error.envelope.error.code.as_deref().unwrap_or("none")
            );
        })?;
    let control = NativeRenewalAuthority::configured(&authority, id, &owner, &cfg, &Cancel);
    let prepared = control
        .prepare_import(
            &actor,
            gateway_auth::native_import::NativeImportTarget::ExistingAccount {
                account_id_hash: credential.routing_account_hash.0,
            },
        )
        .await?;
    let next = codex_credential_identity(
        account_id,
        &Secret::new("fixture-import-new-access".into()),
        &Secret::new(String::new()),
    );
    let path_controls = serde_json::json!({
        "absolute": RegisteredRenewalOwner::configured("absolute-control".into(), HOME.into()).is_ok(),
        "relative_refused": RegisteredRenewalOwner::configured("relative-control".into(), "relative-profile".into()).is_err(),
        "parent_refused": RegisteredRenewalOwner::configured("parent-control".into(), "../profile".into()).is_err()
    });
    let meta = serde_json::json!({"path_controls":path_controls,"metadata":prepared.metadata(),"account_id":account_id,"access_token":"fixture-import-new-access","access_generation":next.native_generation_hash,"native_source_generation":sha256_hex(b"physical-after-import"),"updated_at_ms":time});
    Ok(Some(gateway_auth::crypto::base64url(
        &serde_json::to_vec(&meta).map_err(|_| invalid())?,
    )))
}
pub(super) async fn fetch(
    request: Request,
    env: Env,
    context: Context,
) -> worker::Result<gateway_worker::GatewayResponse> {
    let id = identity()
        .map_err(|e| worker::Error::RustError(e.envelope.error.code.unwrap_or_default()))?;
    let inputs = inputs()
        .map_err(|e| worker::Error::RustError(e.envelope.error.code.unwrap_or_default()))?;
    let receiver = PublicationReceiver::configured(id.clone(), inputs.clone(), vec![], now)
        .map_err(|e| worker::Error::RustError(e.envelope.error.code.unwrap_or_default()))?;
    let metadata = initialize(&env, &receiver, &id, &inputs)
        .await
        .map_err(|e| worker::Error::RustError(e.envelope.error.code.unwrap_or_default()))?;
    let bindings = gateway_worker::NativeBindings::configured(env.service("ASSETS")?, id)
        .with_renewal_owners(
            owners()
                .map_err(|e| worker::Error::RustError(e.envelope.error.code.unwrap_or_default()))?,
        );
    let mut response =
        gateway_worker::fetch_with_bindings(request, env, context, Some(&receiver), bindings)
            .await?;
    if let Some(metadata) = metadata {
        response
            .headers_mut()
            .set("x-uos-fixture-import-metadata", &metadata)?;
    }
    Ok(response)
}
