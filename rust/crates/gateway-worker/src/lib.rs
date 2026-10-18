use gateway_core::GatewayError;
use gateway_core::health::{DEPLOYMENT_ID_HEADER, GIT_SHA_HEADER, HealthResponse, ReleaseIdentity};
use std::rc::Rc;
use worker::{Context, Env, Method, Request, Response, Result, event};

mod agent_messages;
mod assets;
pub mod authority;
mod catalog;
mod host;
mod inference;
mod lifecycle;
mod runtime;
pub mod storage;
pub mod transport;

pub use authority::GatewayAuthority;

fn error_response(error: GatewayError) -> Result<Response> {
    Ok(Response::from_json(&error.envelope)?.with_status(error.status))
}

#[event(fetch)]
pub async fn fetch(request: Request, env: Env, context: Context) -> Result<Response> {
    let identity = match ReleaseIdentity::cloudflare(
        env!("UOS_RUST_BUILD_GIT_SHA"),
        env!("UOS_RUST_BUILD_DEPLOYMENT_ID"),
    ) {
        Ok(identity) => identity,
        Err(error) => return error_response(error),
    };
    let request_id = match transport::random::random_uuid() {
        Ok(id) => id,
        Err(error) => return error_response(error),
    };
    let mut response =
        if request.path() == "/health" && matches!(request.method(), Method::Get | Method::Head) {
            if request.method() == Method::Head {
                Response::empty()?
            } else {
                Response::from_json(&HealthResponse::available(&identity))?
            }
        } else {
            match runtime::route(
                request,
                env,
                Rc::new(context),
                identity.git_sha(),
                gateway_core::identity::RequestId(request_id.clone()),
            )
            .await
            {
                Ok(response) => response,
                Err(error) => error_response(error)?,
            }
        };
    if response.headers().get("Cache-Control")?.is_none() {
        response.headers_mut().set("Cache-Control", "no-store")?;
    }
    response
        .headers_mut()
        .set("x-uos-request-id", &request_id)?;
    response
        .headers_mut()
        .set(GIT_SHA_HEADER, identity.git_sha())?;
    response
        .headers_mut()
        .set(DEPLOYMENT_ID_HEADER, identity.deployment_id())?;
    Ok(response)
}
