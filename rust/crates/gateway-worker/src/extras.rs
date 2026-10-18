//! Actual fixed embeddings/jobs/SystemOne routes; M15 owns their source behavior.
use crate::{
    authority::RemoteAuthorityStore,
    catalog::CatalogState,
    extras_host::Host,
    host::{PlatformClock, PlatformHost, PlatformTokens},
    inference::RequestResources,
    routing_host,
    storage::now_ms,
    transport::{
        body,
        stream::{FinishHook, ObservationHandle, ObservedStream},
    },
};
use gateway_auth::{AuthMethod, AuthPrincipal};
use gateway_authority::quota::KernelTerminal;
use gateway_core::{
    GatewayError,
    identity::{ApiKeyId, PrincipalId, RequestContext, RequestId},
};
use gateway_extras_runtime::{ExtrasRequest, ExtrasRoute, ExtrasRuntime, KernelDisposition};
use gateway_providers::ClientSurface;
use gateway_routing_runtime::{ExtrasFamily, RoutingInput, RoutingSession};
use serde_json::Value;
use std::rc::Rc;
use worker::{Method, Request, Response};

pub fn route(path: &str, method: Method) -> Result<Option<ExtrasRoute>, GatewayError> {
    let route = match path {
        "/uos/embeddings" => Some((Method::Post, ExtrasRoute::Embeddings)),
        "/uos/embedding-jobs" => Some((Method::Post, ExtrasRoute::JobCreate)),
        "/v1/systemone" => Some((Method::Post, ExtrasRoute::SystemOne)),
        _ => path
            .strip_prefix("/uos/embedding-jobs/")
            .map(|id| (Method::Get, ExtrasRoute::JobGet(id.into()))),
    };
    match route {
        Some((expected, _)) if expected != method => Err(GatewayError::new(
            405,
            "Method not allowed",
            Some("method_not_allowed"),
        )),
        Some((_, route)) => Ok(Some(route)),
        None => Ok(None),
    }
}

pub async fn run(
    mut request: Request,
    route: ExtrasRoute,
    resources: RequestResources,
    principal: &AuthPrincipal,
    store: RemoteAuthorityStore,
    catalog: CatalogState,
    platform: &PlatformHost,
    request_id: RequestId,
) -> Result<Response, GatewayError> {
    let RequestResources { context, permit } = resources;
    let bytes = if matches!(route, ExtrasRoute::JobGet(_)) {
        Vec::new()
    } else {
        body::request_bytes(
            &mut request,
            if route == ExtrasRoute::SystemOne {
                body::SYSTEM_ONE_BODY_MAX_BYTES
            } else {
                body::INFERENCE_JSON_MAX_BYTES
            },
        )
        .await?
    };
    let raw = if matches!(route, ExtrasRoute::JobGet(_)) {
        Value::Null
    } else {
        gateway_schema::request::parse_json_body(&bytes)?
    };
    let original = RequestContext {
        request_id,
        principal: PrincipalId(crate::lifecycle::principal_id(principal)),
        key_id: match &principal.method {
            AuthMethod::KvApiKey { key_id, .. } => Some(ApiKeyId(key_id.clone())),
            _ => None,
        },
        route: route.label().into(),
        started_at_ms: now_ms()?,
    };
    let family = match route {
        ExtrasRoute::Embeddings => ExtrasFamily::Embeddings,
        ExtrasRoute::JobCreate => ExtrasFamily::EmbeddingJobCreate,
        ExtrasRoute::JobGet(_) => ExtrasFamily::EmbeddingJobPoll,
        ExtrasRoute::SystemOne => ExtrasFamily::SystemOne,
        ExtrasRoute::Images(_) => return Err(invalid()),
    };
    let session = RoutingSession::begin_extras(
        RoutingInput {
            context: original.clone(),
            principal: principal.clone(),
            raw: raw.clone(),
            surface: ClientSurface::Responses,
            catalog: catalog.input,
            runtime: catalog.runtime,
            client_version: "0.100.0".into(),
            native_session_id: None,
            retry_prohibited: false,
        },
        store.clone(),
        routing_host::Host {
            store: store.clone(),
            env: platform.env.clone(),
            platform: platform.clone(),
        },
        PlatformClock,
        PlatformTokens,
        family,
    )
    .await
    .map_err(|error| *error.error)?;
    let host = Host::new(platform.clone(), session.admission_handle()).await?;
    let runtime = Rc::new(ExtrasRuntime::new(store, host));
    let result = runtime
        .handle(ExtrasRequest {
            route,
            body: raw,
            multipart: None,
            raw_body_bytes: bytes.len(),
            idempotency_key: request
                .headers()
                .get("idempotency-key")
                .map_err(|_| invalid())?,
            principal,
            context: &original,
        })
        .await;
    runtime.host().settle_child().await?;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            runtime
                .host()
                .admission
                .finish(
                    Default::default(),
                    KernelTerminal::Released,
                    "extras_gateway_failure",
                )
                .await
                .map_err(|error| *error.error)?;
            return Err(error);
        }
    };
    let (kernel, reason) = match result.kernel {
        KernelDisposition::Completed => (KernelTerminal::Committed, "extras_source_completed"),
        KernelDisposition::Incomplete(reason) => (KernelTerminal::Released, reason),
        KernelDisposition::FromAggregate => return Err(invalid()),
    };
    let observation = ObservationHandle::default();
    if let Some(terminal) = result.semantic_terminal {
        observation.semantic_terminal(terminal);
    }
    let finish: FinishHook = Box::new(move |observation| {
        Box::pin(async move {
            if let Err(error) = runtime
                .host()
                .admission
                .finish(observation, kernel, reason)
                .await
            {
                worker::console_error!(
                    "Durable extras settlement remains pending: {}",
                    error.error.envelope.error.message
                );
            }
            drop(permit);
        })
    });
    let bytes = serde_json::to_vec(&result.body).map_err(|_| invalid())?;
    let source = Box::pin(futures_util::stream::iter([Ok::<_, worker::Error>(bytes)]));
    let mut response = ObservedStream::new(
        source,
        observation,
        context,
        platform.cancellation.clone(),
        None,
        finish,
    )
    .into_response()
    .map_err(|_| invalid())?
    .with_status(result.status);
    for (name, value) in result.headers {
        response
            .headers_mut()
            .set(&name, &value)
            .map_err(|_| invalid())?;
    }
    Ok(response)
}

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "The source extras response could not be rendered.",
        "extras_response_unavailable",
    )
}
