use gateway_core::GatewayError;
use gateway_core::health::{DEPLOYMENT_ID_HEADER, GIT_SHA_HEADER, HealthResponse, ReleaseIdentity};
use worker::{Context, Env, Method, Request, Response, Result, event};

fn error_response(error: GatewayError) -> Result<Response> {
    Ok(Response::from_json(&error.envelope)?.with_status(error.status))
}

/// Real workers-rs fetch export. Only release liveness is implemented in this milestone.
#[event(fetch)]
pub async fn fetch(request: Request, _env: Env, _context: Context) -> Result<Response> {
    let identity = match ReleaseIdentity::cloudflare(
        env!("UOS_RUST_BUILD_GIT_SHA"),
        env!("UOS_RUST_BUILD_DEPLOYMENT_ID"),
    ) {
        Ok(identity) => identity,
        Err(error) => return error_response(error),
    };
    let mut response = if request.path() == "/health" && request.method() == Method::Get {
        Response::from_json(&HealthResponse::available(&identity))?
    } else {
        error_response(GatewayError::unavailable(
            "This route is not implemented in the Rust foundation milestone.",
            "rust_port_route_unavailable",
        ))?
    };
    response.headers_mut().set("Cache-Control", "no-store")?;
    response
        .headers_mut()
        .set(GIT_SHA_HEADER, identity.git_sha())?;
    response
        .headers_mut()
        .set(DEPLOYMENT_ID_HEADER, identity.deployment_id())?;
    Ok(response)
}
