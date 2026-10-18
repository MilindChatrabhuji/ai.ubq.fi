//! Public routing. Private authority protocol paths are never forwarded here.
use std::rc::Rc;

use gateway_admin::{AdminHost, AdminInput, AdminOperation, AdminService, PaidKeyFields};
use gateway_auth::{AuthPrincipal, AuthRequest, AuthResponse, AuthService};
use gateway_core::{GatewayError, identity::RequestId, state::RevisionCheck};
use gateway_schema::{catalog, catalog_cache::CatalogResponse};
use serde_json::Value;
use worker::{Context, Env, Method, Request, Response};

use crate::{
    authority::RemoteAuthorityStore,
    catalog::CatalogState,
    host::{PlatformHost, auth_config},
    inference,
    storage::now_ms,
    transport::{HeaderLimits, body, bounded_headers, outbound::Cancellation, random},
};

pub async fn route(
    mut request: Request,
    env: Env,
    context: Rc<Context>,
    release: &str,
    request_id: RequestId,
) -> Result<Response, GatewayError> {
    now_ms()?;
    let path = request.path();
    let store = RemoteAuthorityStore::from_env(&env)?;
    let cancellation = Rc::new(Cancellation::from_request(&request)?);
    let host = PlatformHost { cancellation };
    let config = auth_config(&env);
    let mut auth_request = AuthRequest {
        method: request.method().to_string(),
        url: request.url().map_err(|_| invalid_url())?.to_string(),
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
    let auth = AuthService::new(&store, &host, &config);
    if path.starts_with("/api/auth/") || path == "/uos/auth" {
        if request.method() == Method::Post {
            auth_request.body =
                body::request_bytes(&mut request, body::PASSKEY_BODY_MAX_BYTES).await?;
        }
        if let Some(response) = auth.handle_auth_route(&auth_request).await? {
            return auth_response(response);
        }
    }
    if path.starts_with("/admin/") {
        if !matches!(request.method(), Method::Get | Method::Head) {
            auth_request.body = body::inference_bytes(&mut request).await?;
        }
        let capabilities = PlatformAdmin;
        let admin = AdminService {
            store: &store,
            host: &host,
            capabilities: &capabilities,
            config: &config,
            release,
        };
        if let Some(response) = admin.handle_route(&auth_request, &request_id.0).await? {
            return auth_response(response);
        }
        auth.authenticate_admin(&auth_request).await?;
        return Err(GatewayError::new(
            404,
            "Administrative route not found.",
            Some("not_found"),
        ));
    }
    if path == "/uos/models/catalog" && request.method() == Method::Get {
        let state = CatalogState::load(&store, &env, now_ms()?).await?;
        return json_response(catalog::public_catalog(&state.input));
    }
    if path == "/health/providers" || path == "/health/upstream" {
        auth.authenticate_admin(&auth_request).await?;
        return Err(GatewayError::unavailable(
            "Provider health observations are not yet integrated.",
            "provider_health_unavailable",
        ));
    }
    let principal = if path.starts_with("/v1/")
        || path == "/uos/models/capabilities"
        || path.starts_with("/uos/embedding")
    {
        Some(auth.authenticate_client(&auth_request).await?)
    } else {
        None
    };
    if path == "/v1/models" && request.method() == Method::Get {
        let state = CatalogState::load(&store, &env, now_ms()?).await?;
        let url = request.url().map_err(|_| invalid_url())?;
        let versions = url
            .query_pairs()
            .filter(|(key, _)| key == "client_version")
            .map(|(_, value)| value.into_owned())
            .collect::<Vec<_>>();
        return if versions.is_empty() {
            json_response(catalog::ordinary_models(&state.input))
        } else {
            let version = if versions.len() == 1 {
                versions[0].as_str()
            } else {
                ""
            };
            catalog_response(
                state
                    .native_models(&store, &request, version, now_ms()?)
                    .await?,
            )
        };
    }
    if path == "/uos/models/capabilities" && request.method() == Method::Get {
        let state = CatalogState::load(&store, &env, now_ms()?).await?;
        return json_response(catalog::capabilities(&state.input));
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
        let state = CatalogState::load(&store, &env, now_ms()?).await?;
        let mut response = inference::run(
            request, context, &principal, store, state, &host, request_id,
        )
        .await?;
        decorate_api_policy(&mut response, &principal)?;
        return Ok(response);
    }
    if path.starts_with("/v1/") || path.starts_with("/uos/embedding") {
        return Err(GatewayError::unavailable(
            "This source route operation is not yet integrated.",
            "rust_port_route_unavailable",
        ));
    }
    Err(GatewayError::new(
        404,
        "Public resource not found. Read /openapi.json for API endpoints or /llms.txt for agent guidance.",
        Some("not_found"),
    ))
}

pub fn auth_response(response: AuthResponse) -> Result<Response, GatewayError> {
    let mut wire = json_response(response.body)?.with_status(response.status);
    for (name, value) in response.headers {
        wire.headers_mut()
            .set(&name, &value)
            .map_err(|_| invalid_url())?;
    }
    Ok(wire)
}

fn json_response(value: Value) -> Result<Response, GatewayError> {
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

struct PlatformAdmin;
impl AdminHost for PlatformAdmin {
    async fn execute(
        &self,
        operation: AdminOperation,
        _input: AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        Err(gateway_admin::missing_capability(operation))
    }
    async fn prepare_key_deletion(
        &self,
        _key_id: &str,
    ) -> Result<Vec<RevisionCheck>, GatewayError> {
        Err(GatewayError::unavailable(
            "The source paid deletion fence is not integrated.",
            "paid_deletion_guard_unavailable",
        ))
    }
    async fn paid_key_policy(&self, body: &Value) -> Result<PaidKeyFields, GatewayError> {
        if body.get("paid_fallback_enabled").and_then(Value::as_bool) == Some(true) {
            return Err(GatewayError::unavailable(
                "Source paid model pricing is not integrated.",
                "paid_fallback_pricing_unavailable",
            ));
        }
        Ok(PaidKeyFields::disabled())
    }
}

fn invalid_url() -> GatewayError {
    GatewayError::new(
        400,
        "Invalid request URL or headers",
        Some("invalid_request_error"),
    )
}
