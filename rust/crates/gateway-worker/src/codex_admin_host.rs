//! Named administrative Codex operations, always authenticated from the original request.
use gateway_admin_runtime::capabilities::{CodexRequest, Context};
use gateway_auth::{AuthConfig, AuthRequest, AuthResponse, AuthService};
use gateway_authority::native_control::actor::NativeRenewalActor;
use gateway_core::GatewayError;

mod automatic;
mod manual;
mod source_inventory;
pub(crate) use automatic::check_client;
pub use automatic::recover_full_pool;

/// Request-owned authentication evidence, never decoded from an administrative command.
pub struct OriginalAdmin<'a> {
    pub request: &'a AuthRequest,
    pub config: &'a AuthConfig,
    pub actor: &'a NativeRenewalActor,
}

pub async fn execute(
    store: &crate::authority::RemoteAuthorityStore,
    platform: &crate::host::PlatformHost,
    owner: OriginalAdmin<'_>,
    request: CodexRequest,
    context: Context,
    observations: &crate::observability_host::Runtime,
) -> Result<AuthResponse, GatewayError> {
    let OriginalAdmin {
        request: original,
        config,
        actor,
    } = owner;
    AuthService::new(store, platform, config)
        .authenticate_admin(original)
        .await?;
    match request {
        CodexRequest::ConsumeReset { account_id_hash } => {
            manual::consume(store, platform, config, &account_id_hash, actor).await
        }
        CodexRequest::ImportCredentials { .. } => Err(GatewayError::unavailable(
            "The native credential import owner is not configured.",
            "codex_native_import_unavailable",
        )),
        CodexRequest::Recheck { slot } => {
            let authority = gateway_authority::Authority::with_clock(
                store.clone(),
                crate::host::PlatformTokens,
                crate::host::PlatformClock,
            );
            if !authority.recheck_codex_slot(actor, config, slot).await? {
                return Err(GatewayError::new(
                    404,
                    "Codex account slot is not configured",
                    Some("not_found"),
                ));
            }
            let mut response = AuthResponse::json(204, serde_json::Value::Null);
            response.headers.clear();
            Ok(response)
        }
        request => {
            let mut response = observations.codex(request, context).await?;
            response
                .headers
                .insert("Cache-Control".into(), "no-store".into());
            Ok(response)
        }
    }
}
