//! Public routing. Private authority protocol paths are never forwarded here.
use std::rc::Rc;

use gateway_admin::AdminService;
use gateway_auth::{AuthPrincipal, AuthRequest, AuthResponse, AuthService};
use gateway_core::{
    GatewayError, identity::RequestId, source_json::SourceJson, state::AuthorityStore,
};
use gateway_live_runtime::{
    mapping::LiveRuntime,
    protocol::{LiveRoute, live_route},
};
use gateway_schema::{
    catalog,
    catalog_cache::{CacheState, CatalogResponse, LoadedCatalog},
    catalog_store,
};
use worker::{Context, Env, Method, Request, Response};

use crate::{
    authority::RemoteAuthorityStore,
    catalog::CatalogState,
    host::{PlatformHost, auth_config},
    inference,
    storage::now_ms,
    transport::{HeaderLimits, body, bounded_headers, outbound::Cancellation},
};

pub async fn route(
    mut request: Request,
    env: Env,
    context: Rc<Context>,
    release: &str,
    request_id: RequestId,
    native: crate::native_host::NativeBindings,
) -> Result<crate::GatewayResponse, GatewayError> {
    let started_at_ms = now_ms()?;
    let path = crate::normalized_path(&request.path()).to_owned();
    if let Some(response) = crate::assets::handle(&request, &env, &path).await? {
        return Ok(response.into());
    }
    if path == "/uos/agent-messages" && !matches!(request.method(), Method::Get | Method::Post) {
        return Err(GatewayError::new(
            405,
            "Method not allowed",
            Some("method_not_allowed"),
        ));
    }
    let store = RemoteAuthorityStore::from_env(&env)?;
    let cancellation = Rc::new(Cancellation::from_request(&request)?);
    let config = auth_config(&env);
    let mut auth_url = request.url().map_err(|_| invalid_url())?;
    auth_url.set_path(&path);
    let mut auth_request = AuthRequest {
        method: request.method().to_string(),
        url: auth_url.to_string(),
        headers: bounded_headers(
            &request,
            HeaderLimits {
                total_bytes: 16_384,
                value_bytes: 16_384,
                fields: 2000,
            },
        )?,
        body: Vec::new(),
        native_peer: None,
    };
    let host = PlatformHost {
        cancellation,
        store: store.clone(),
        env: env.clone(),
        native,
        original: auth_request.clone(),
        request_id: request_id.clone(),
    };
    let auth = AuthService::new(&store, &host, &config);
    if path.starts_with("/api/auth/") || path.starts_with("/auth/") || path == "/uos/auth" {
        if request.method() == Method::Post {
            // Source authenticates this admin before the registration handler
            // reads its body. Keep the handler's own check intact below.
            if path == "/api/auth/register/start" {
                auth.authenticate_admin(&auth_request).await?;
            }
            auth_request.body =
                body::request_bytes(&mut request, body::PASSKEY_BODY_MAX_BYTES).await?;
        }
        if let Some(response) = auth.handle_auth_route(&auth_request).await? {
            return auth_response(response).map(Into::into);
        }
    }
    if path.starts_with("/admin/") {
        // Source authenticates an administrative route before its handler can
        // read a body. Resolve the route first so unmatched or wrong-method
        // paths, including the source paid-fallbacks 405, stay body-free.
        let admin_route = gateway_admin::match_route(request.method().as_ref(), &path);
        if admin_route.is_some() && !matches!(request.method(), Method::Get | Method::Head) {
            auth.authenticate_admin(&auth_request).await?;
            auth_request.body = body::inference_bytes(&mut request).await?;
        }
        // Custody is minted at the original authenticated boundary, never from
        // the administrative module's normalized Context or a later timestamp.
        let principal = auth.authenticate_admin(&auth_request).await?;
        let original_context = gateway_core::identity::RequestContext {
            request_id: request_id.clone(),
            principal: gateway_core::identity::PrincipalId(
                gateway_authority::native_control::actor::principal_id(&principal),
            ),
            key_id: match &principal.method {
                gateway_auth::AuthMethod::KvApiKey { key_id, .. } => {
                    Some(gateway_core::identity::ApiKeyId(key_id.clone()))
                }
                _ => None,
            },
            route: path.clone(),
            started_at_ms,
        };
        let authority = gateway_authority::Authority::with_clock(
            store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        );
        let actor = Rc::new(
            gateway_authority::native_control::actor::authenticate_admin_actor(
                &authority,
                &host,
                &config,
                &auth_request,
                &original_context,
            )
            .await?,
        );
        // Retain a measured receipt from this exact raw request before the
        // administrative service parses JSON into its finite operation DTO.
        let bindings = crate::admin_host::Capabilities::new(
            &request_id,
            &auth_request.body,
            &auth_request,
            store.clone(),
            &host,
            context.clone(),
            actor,
        )?;
        let runtime_config = crate::admin_host::config(&env);
        let capabilities = gateway_admin_runtime::AdminRuntime {
            store: &store,
            host: &host,
            capabilities: &bindings,
            config: &runtime_config,
        };
        let admin = AdminService {
            store: &store,
            host: &host,
            capabilities: &capabilities,
            config: &config,
            release,
        };
        if let Some(response) = admin.handle_route(&auth_request, &request_id.0).await? {
            return auth_response_with_native(response, &host, context.clone())
                .await
                .map(Into::into);
        }
        auth.authenticate_admin(&auth_request).await?;
        return Err(GatewayError::new(
            404,
            "Administrative route not found.",
            Some("not_found"),
        ));
    }
    if path == "/uos/models/catalog" && request.method() == Method::Get {
        return auth_response(
            crate::catalog::public_response(&store, &env, &host, context.clone()).await?,
        )
        .map(Into::into);
    }
    if path == "/health/providers" || path == "/health/upstream" {
        if request.method() != Method::Get {
            return Err(public_not_found());
        }
        auth.authenticate_admin(&auth_request).await?;
        let observations = crate::observability_host::bind(
            &request_id,
            &[],
            store.clone(),
            &host,
            context.clone(),
        );
        let operation = if path == "/health/providers" {
            gateway_admin_runtime::capabilities::ProviderRequest::PassiveHealth
        } else {
            gateway_admin_runtime::capabilities::ProviderRequest::UpstreamHealth
        };
        return auth_response(
            observations
                .provider(
                    operation,
                    gateway_admin_runtime::capabilities::Context {
                        request_id: request_id.0.clone(),
                        now_ms: now_ms()?,
                    },
                )
                .await?,
        )
        .map(Into::into);
    }
    let principal = if is_terminal_inference_path(&path)
        || path == "/uos/models/capabilities"
        || path == "/uos/agent-messages"
    {
        Some(auth.authenticate_client(&auth_request).await?)
    } else {
        None
    };
    if let Some(route) = live_route(&auth_request.method, &path) {
        let principal = principal.ok_or_else(gateway_auth::unauthorized)?;
        let live = crate::live_host::WorkerLiveHost::bind(
            host.clone(),
            context.clone(),
            auth_request,
            config.clone(),
            principal.clone(),
            request_id,
        )
        .await?;
        let runtime = LiveRuntime::new(
            Rc::new(store),
            Rc::new(crate::transport::random::opaque_token),
        );
        return match route {
            LiveRoute::Create => {
                let headers = request
                    .headers()
                    .entries()
                    .map(|(name, value)| (name.to_ascii_lowercase(), value))
                    .collect();
                let input =
                    crate::live_http::parse_create(&mut request, &host.cancellation, headers)
                        .await?;
                let response = runtime
                    .create_call(&principal, input, &live, host.cancellation.as_ref())
                    .await;
                crate::live_host::into_response(response, context)
            }
            LiveRoute::Sideband(call_id) => {
                let upgrade = request
                    .headers()
                    .get("upgrade")
                    .map_err(|_| invalid_url())?
                    .unwrap_or_default();
                match runtime
                    .prepare_sideband(&principal, &call_id, &upgrade, &live)
                    .await
                {
                    Ok(prepared) => live.upgrade(prepared).await,
                    Err(response) => crate::live_host::into_response(response, context),
                }
            }
        };
    }
    if path == "/v1/models" && request.method() == Method::Get {
        let url = request.url().map_err(|_| invalid_url())?;
        let versions = url
            .query_pairs()
            .filter(|(key, _)| key == "client_version")
            .map(|(_, value)| value.into_owned())
            .collect::<Vec<_>>();
        let version_refs = versions.iter().map(String::as_str).collect::<Vec<_>>();
        let requested = gateway_schema::catalog_cache::requested_client_version(&version_refs);
        if let Some(raw_version) = requested {
            let version = gateway_schema::catalog_cache::validate_client_version(raw_version)?;
            let version = version.as_str();
            let now = now_ms()?;
            let conditional = request.headers().get("if-none-match").map_err(|_| {
                GatewayError::new(
                    400,
                    "Invalid conditional catalog header.",
                    Some("invalid_request_error"),
                )
            })?;
            // Read the durable exact catalog before any provider discovery.
            // A retained answer is always assembled by the normal catalog
            // stack from hydrated durable observations, never a cached body.
            if let Some(cached) = durable_catalog(&store, version, now).await? {
                let state = CatalogState::load(&store, &env, &host, context.clone()).await?;
                if !cached.metadata.fresh(now) {
                    crate::catalog::schedule_warm(&store, &env, &host, context.clone(), version);
                }
                let cache_state = if cached.metadata.fresh(now) {
                    CacheState::Hit
                } else {
                    CacheState::Stale
                };
                let response = gateway_schema::catalog_cache::catalog_response(
                    &cached,
                    conditional.as_deref(),
                    cache_state,
                    &state.input,
                );
                return catalog_response(response).map(Into::into);
            }
            let state = CatalogState::load(&store, &env, &host, context.clone()).await?;
            let response = state.native_models(&store, &request, version, now).await?;
            return catalog_response(response).map(Into::into);
        }
        let state = CatalogState::load(&store, &env, &host, context.clone()).await?;
        return json_response(catalog::ordinary_models(&state.input)).map(Into::into);
    }
    if path == "/uos/models/capabilities" && request.method() == Method::Get {
        let state = CatalogState::load(&store, &env, &host, context.clone()).await?;
        return json_response(catalog::capabilities(&state.input)).map(Into::into);
    }
    if path == "/uos/agent-messages" {
        return crate::agent_messages::handle(
            request,
            &principal.ok_or_else(gateway_auth::unauthorized)?,
            &store,
        )
        .await
        .map(Into::into);
    }
    if let Some(route) = crate::extras::route(&path, request.method())? {
        let principal = principal.ok_or_else(gateway_auth::unauthorized)?;
        let permit = crate::admission::acquire(
            &principal,
            &request_id.0,
            route.label(),
            host.cancellation.clone(),
        )
        .await?;
        let catalog = CatalogState::load(&store, &env, &host, context.clone()).await?;
        let mut response = crate::extras::run(
            request,
            crate::extras::Target { route, request_id },
            inference::RequestResources { context, permit },
            &principal,
            store,
            catalog,
            &host,
        )
        .await?;
        decorate_api_policy(&mut response, &principal)?;
        return Ok(response.into());
    }
    if ["/v1/responses", "/v1/chat/completions"].contains(&path.as_str()) {
        if request.method() != Method::Post {
            return Err(GatewayError::new(
                405,
                "Method not allowed",
                Some("method_not_allowed"),
            ));
        }
        let principal = principal.ok_or_else(gateway_auth::unauthorized)?;
        let permit = crate::admission::acquire(
            &principal,
            &request_id.0,
            if path == "/v1/responses" {
                "responses"
            } else {
                "chat.completions"
            },
            host.cancellation.clone(),
        )
        .await?;
        let state = CatalogState::load(&store, &env, &host, context.clone()).await?;
        let mut response = inference::run(
            request,
            inference::RequestResources { context, permit },
            &principal,
            store,
            state,
            &host,
            request_id,
        )
        .await?;
        decorate_api_policy(&mut response, &principal)?;
        return Ok(response.into());
    }
    if is_terminal_inference_path(&path) {
        // Terminal inference dispatch answers an authenticated unknown route
        // with the source's plain error envelope, not a migration 503.
        return Err(inference_not_found());
    }
    Err(public_not_found())
}

pub fn auth_response(response: AuthResponse) -> Result<Response, GatewayError> {
    if response.stream.is_some() {
        return Err(GatewayError::unavailable(
            "The native stream carrier is not configured.",
            "native_stream_unavailable",
        ));
    }
    let mut wire = Response::from_bytes(response.body.to_bytes()?)
        .map_err(|_| invalid_url())?
        .with_status(response.status);
    for (name, value) in response.headers {
        wire.headers_mut()
            .set(&name, &value)
            .map_err(|_| invalid_url())?;
    }
    for cookie in response.set_cookies {
        wire.headers_mut()
            .append("set-cookie", &cookie)
            .map_err(|_| invalid_url())?;
    }
    Ok(wire)
}

async fn auth_response_with_native(
    mut response: AuthResponse,
    platform: &PlatformHost,
    context: Rc<Context>,
) -> Result<Response, GatewayError> {
    if let Some(descriptor) = response.stream.take() {
        let mut stream = platform
            .native
            .follow(descriptor, platform, context)
            .await?;
        for (name, value) in response.headers {
            stream
                .headers_mut()
                .set(&name, &value)
                .map_err(|_| invalid_url())?;
        }
        for cookie in response.set_cookies {
            stream
                .headers_mut()
                .append("set-cookie", &cookie)
                .map_err(|_| invalid_url())?;
        }
        Ok(stream)
    } else {
        auth_response(response)
    }
}

async fn durable_catalog(
    store: &RemoteAuthorityStore,
    version: &str,
    now: i64,
) -> Result<Option<LoadedCatalog>, GatewayError> {
    let Some(record) = store.read(&catalog_store::auth_generation_key()).await? else {
        return Ok(None);
    };
    record.validate_version()?;
    let Some(generation) = record
        .json_value()?
        .as_str()
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    catalog_store::load_catalog(store, version, generation, now).await
}

fn json_response(value: SourceJson) -> Result<Response, GatewayError> {
    Response::from_json(&value).map_err(|_| invalid_url())
}
fn catalog_response(response: CatalogResponse) -> Result<Response, GatewayError> {
    let mut wire = match response.body {
        Some(body) => Response::ok(body),
        None => Response::empty(),
    }
    .map_err(|_| invalid_url())?
    .with_status(response.status);
    for (name, value) in response.headers {
        wire.headers_mut()
            .set(&name, &value)
            .map_err(|_| invalid_url())?;
    }
    Ok(wire)
}

fn decorate_api_policy(
    response: &mut Response,
    principal: &AuthPrincipal,
) -> Result<(), GatewayError> {
    if let gateway_auth::AuthMethod::KvApiKey { policy, .. } = &principal.method
        && policy.usage_limit_requests != -1
    {
        response
            .headers_mut()
            .set(
                "RateLimit-Policy",
                &format!(
                    "\"api-key\";q={};w={}",
                    policy.usage_limit_requests,
                    ((policy.window_ms + 999) / 1000).max(1)
                ),
            )
            .map_err(|_| invalid_url())?;
    }
    Ok(())
}

fn invalid_url() -> GatewayError {
    GatewayError::new(
        400,
        "Invalid request URL or headers",
        Some("invalid_request_error"),
    )
}

fn inference_not_found() -> GatewayError {
    GatewayError::new(404, "Not found", Some("not_found"))
}

fn public_not_found() -> GatewayError {
    GatewayError::new(
        404,
        "Public resource not found. Read /openapi.json for API endpoints or /llms.txt for agent guidance.",
        Some("not_found"),
    )
    .with_type("not_found")
}

fn is_terminal_inference_path(path: &str) -> bool {
    path.starts_with("/v1/")
        || path == "/uos/embeddings"
        || path == "/uos/embedding-jobs"
        || path.starts_with("/uos/embedding-jobs/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_and_public_not_found_envelopes_stay_distinct() {
        let terminal = inference_not_found();
        assert_eq!(terminal.status, 404);
        assert_eq!(terminal.envelope.error.message, "Not found");
        assert_eq!(terminal.envelope.error.error_type, "invalid_request_error");
        assert_eq!(terminal.envelope.error.code.as_deref(), Some("not_found"));
        assert!(terminal.envelope.error.param.is_none());

        let public = public_not_found();
        assert_eq!(public.status, 404);
        assert_eq!(
            public.envelope.error.message,
            "Public resource not found. Read /openapi.json for API endpoints or /llms.txt for agent guidance."
        );
        assert_eq!(public.envelope.error.error_type, "not_found");
        assert_eq!(public.envelope.error.code.as_deref(), Some("not_found"));
        assert!(public.envelope.error.param.is_none());
    }

    #[test]
    fn terminal_paths_match_the_source_dispatch_surface() {
        for path in [
            "/v1/models",
            "/v1/unknown",
            "/uos/embeddings",
            "/uos/embedding-jobs",
            "/uos/embedding-jobs/job-1",
        ] {
            assert!(is_terminal_inference_path(path), "{path}");
        }
        for path in [
            "/v1",
            "/uos/embedding",
            "/uos/embeddings/extra",
            "/uos/embedding-jobs-extra",
            "/health/providers",
        ] {
            assert!(!is_terminal_inference_path(path), "{path}");
        }
    }
}
