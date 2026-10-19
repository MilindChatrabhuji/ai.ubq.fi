//! Fixed live HTTP/stream adapter. Account and owner capabilities are request-owned.
mod body;
mod account;
mod health;

pub use body::{Body, into_response};
pub use account::CurrentLiveAccount;

use std::rc::Rc;
use gateway_auth::{AuthConfig, AuthMethod, AuthPrincipal, AuthRequest};
use gateway_authority::{Authority, native_control::actor::{NativeRenewalActor, authenticate_client_actor}};
use gateway_core::{GatewayError, identity::{ApiKeyId, PrincipalId, RequestContext, RequestId}};
use worker::Context;

use crate::{host::{PlatformHost, PlatformClock, PlatformTokens}, storage::now_ms};

/// Captures the actual authenticated request, not an actor reconstructed from request ID/time.
pub struct WorkerLiveHost {
    platform: PlatformHost,
    context: Rc<Context>,
    original: AuthRequest,
    config: AuthConfig,
    principal: AuthPrincipal,
    actor: Rc<NativeRenewalActor>,
}

impl WorkerLiveHost {
    pub async fn bind(
        platform: PlatformHost,
        context: Rc<Context>,
        original: AuthRequest,
        config: AuthConfig,
        principal: AuthPrincipal,
        request_id: RequestId,
    ) -> Result<Self, GatewayError> {
        let url = worker::Url::parse(&original.url).map_err(|_| account::missing())?;
        let route = gateway_live_runtime::live_route(&original.method, url.path()).ok_or_else(account::missing)?;
        let request = RequestContext {
            request_id,
            principal: PrincipalId(gateway_live_runtime::principal_id(&principal)),
            key_id: match &principal.method { AuthMethod::KvApiKey { key_id, .. } => Some(ApiKeyId(key_id.clone())), _ => None },
            route: match route { gateway_live_runtime::LiveRoute::Create => "live.create", gateway_live_runtime::LiveRoute::Sideband(_) => "live.sideband" }.into(),
            started_at_ms: now_ms()?,
        };
        let authority = Authority::with_clock(platform.store.clone(), PlatformTokens, PlatformClock);
        let actor = authenticate_client_actor(&authority, &platform, &config, &original, &request).await?;
        if actor.principal() != gateway_live_runtime::principal_id(&principal) { return Err(account::missing()); }
        Ok(Self { platform, context, original, config, principal, actor: Rc::new(actor) })
    }
}
