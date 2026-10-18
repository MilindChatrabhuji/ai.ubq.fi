use gateway_core::GatewayError;
use gateway_core::health::{DEPLOYMENT_ID_HEADER, GIT_SHA_HEADER, HealthResponse, ReleaseIdentity};
use std::rc::Rc;
#[cfg(feature = "entrypoint")]
use worker::event;
use worker::{Context, Env, Method, Request, Response, Result};

mod admin_host;
mod admission;
mod agent_messages;
mod assets;
pub mod authority;
mod catalog;
mod catalog_host;
mod cors;
mod host;
mod inference;
mod lifecycle;
mod routing_host;
mod runtime;
pub mod storage;
pub mod transport;

pub use authority::GatewayAuthority;

fn error_response(error: GatewayError) -> Result<Response> {
    let mut response = Response::from_json(&error.envelope)?.with_status(error.status);
    if error.envelope.error.code.as_deref()
        == Some(gateway_admission::LOCAL_INFERENCE_OVERLOAD_CODE)
    {
        response.headers_mut().set(
            "Retry-After",
            &gateway_admission::RETRY_AFTER_SECONDS.to_string(),
        )?;
    }
    Ok(response)
}

#[cfg_attr(feature = "entrypoint", event(fetch))]
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
    let cors = cors::Cors::from_request(&request, &env)?;
    let mut response = if request.method() == Method::Options {
        Response::empty()?.with_status(204)
    } else if request.path() == "/health" && matches!(request.method(), Method::Get | Method::Head)
    {
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
    cors.apply(&mut response)?;
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
