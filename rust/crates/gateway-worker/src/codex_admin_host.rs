//! Named administrative Codex operations, always authenticated from the original request.
use gateway_admin_runtime::capabilities::{CodexRequest, Context};
use gateway_auth::{AuthConfig, AuthRequest, AuthResponse, AuthService};
use gateway_core::GatewayError;

mod manual;

pub async fn execute(
    store: &crate::authority::RemoteAuthorityStore,
    platform: &crate::host::PlatformHost,
    original: &AuthRequest,
    config: &AuthConfig,
    request: CodexRequest,
    context: Context,
    observations: &crate::observability_host::Runtime,
) -> Result<AuthResponse, GatewayError> {
    AuthService::new(store, platform, config)
        .authenticate_admin(original)
        .await?;
    match request {
        CodexRequest::ConsumeReset { account_id_hash } => {
            manual::consume(store, platform, original, config, &account_id_hash, context).await
        }
        CodexRequest::ImportCredentials { .. } => Err(GatewayError::unavailable(
            "The native credential import owner is not configured.",
            "codex_native_import_unavailable",
        )),
        request => {
            let mut response = observations.codex(request, context).await?;
            response
                .headers
                .insert("Cache-Control".into(), "no-store".into());
            Ok(response)
        }
    }
}
