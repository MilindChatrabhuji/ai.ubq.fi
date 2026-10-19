//! Named administrative Codex operations, always authenticated from the original request.
use gateway_admin_runtime::capabilities::{CodexRequest, Context};
use gateway_auth::{AuthConfig, AuthRequest, AuthResponse, AuthService};
use gateway_core::{
    GatewayError,
    identity::{PrincipalId, RequestContext, RequestId},
};

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
    let principal = AuthService::new(store, platform, config)
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
        CodexRequest::Recheck { slot } => {
            use gateway_authority::native_control::actor::{
                authenticate_admin_actor, principal_id,
            };
            let authority = gateway_authority::Authority::with_clock(
                store.clone(),
                crate::host::PlatformTokens,
                crate::host::PlatformClock,
            );
            let request = RequestContext {
                request_id: RequestId(context.request_id),
                principal: PrincipalId(principal_id(&principal)),
                key_id: None,
                route: format!("/admin/providers/codex/{slot}/recheck"),
                started_at_ms: context.now_ms,
            };
            let actor =
                authenticate_admin_actor(&authority, platform, config, original, &request).await?;
            if !authority.recheck_codex_slot(&actor, config, slot).await? {
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
