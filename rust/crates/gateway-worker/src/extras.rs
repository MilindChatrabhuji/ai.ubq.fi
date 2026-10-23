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
    model::ModelId,
    source_json::SourceJson,
    source_serialization as source,
};
use gateway_extras_runtime::{
    ExtrasRequest, ExtrasRoute, ExtrasRuntime, ImageKind, KernelDisposition,
};
use gateway_providers::ClientSurface;
use gateway_routing_runtime::{extras::ExtrasFamily, session::RoutingSession, types::RoutingInput};
use std::rc::Rc;
use worker::{Method, Request, Response};

pub fn route(path: &str, method: Method) -> Result<Option<ExtrasRoute>, GatewayError> {
    let route = match path {
        "/uos/embeddings" => Some((Method::Post, ExtrasRoute::Embeddings)),
        "/uos/embedding-jobs" => Some((Method::Post, ExtrasRoute::JobCreate)),
        "/v1/systemone" => Some((Method::Post, ExtrasRoute::SystemOne)),
        "/v1/images/generations" => {
            Some((Method::Post, ExtrasRoute::Images(ImageKind::Generations)))
        }
        "/v1/images/edits" => Some((Method::Post, ExtrasRoute::Images(ImageKind::Edits))),
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

pub struct Target {
    pub route: ExtrasRoute,
    pub request_id: RequestId,
}

pub async fn run(
    mut request: Request,
    target: Target,
    resources: RequestResources,
    principal: &AuthPrincipal,
    store: RemoteAuthorityStore,
    catalog: CatalogState,
    platform: &PlatformHost,
) -> Result<Response, GatewayError> {
    let Target { route, request_id } = target;
    let RequestResources { context, permit } = resources;
    let image = matches!(route, ExtrasRoute::Images(_));
    let edit = route == ExtrasRoute::Images(ImageKind::Edits);
    let multipart = image
        && request
            .headers()
            .get("content-type")
            .map_err(|_| invalid())?
            .is_some_and(|value| {
                value
                    .to_ascii_lowercase()
                    .starts_with("multipart/form-data")
            });
    if multipart && !edit {
        return Err(GatewayError::new(
            400,
            "Image generation requests must use a JSON object body.",
            Some("invalid_request_error"),
        ));
    }
    let bytes = if matches!(route, ExtrasRoute::JobGet(_)) {
        Vec::new()
    } else {
        body::request_bytes(
            &mut request,
            if multipart {
                crate::multipart::MULTIPART_BYTES
            } else if edit {
                crate::multipart::IMAGE_JSON_BYTES
            } else if route == ExtrasRoute::SystemOne {
                body::SYSTEM_ONE_BODY_MAX_BYTES
            } else {
                body::INFERENCE_JSON_MAX_BYTES
            },
        )
        .await?
    };
    let (raw, multipart) = if multipart {
        let (raw, files) = crate::multipart::parse(&request, &bytes).await?;
        (raw, Some(files))
    } else if matches!(route, ExtrasRoute::JobGet(_)) {
        (
            SourceJson::parse("null").expect("null is source JSON"),
            None,
        )
    } else if edit {
        (crate::multipart::image_json(&bytes)?, None)
    } else {
        let raw = match gateway_schema::source_request::parse_http_body(&bytes) {
            Ok(raw) => raw,
            Err(error) => {
                return crate::runtime::auth_response(gateway_auth::AuthResponse::source_json(
                    error.status,
                    error.body().clone(),
                ));
            }
        };
        (raw, None)
    };
    let raw_body_bytes = bytes.len();
    drop(bytes);
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
        ExtrasRoute::Images(ImageKind::Generations) => ExtrasFamily::ImageGenerations,
        ExtrasRoute::Images(ImageKind::Edits) => ExtrasFamily::ImageEdits,
    };
    let default_model = catalog
        .runtime
        .as_ref()
        .and_then(runtime_default_model)
        .or_else(|| {
            catalog
                .input
                .codex()
                .and_then(|snapshot| snapshot.default_model())
        });
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
        routing_host::Host::new(
            store.clone(),
            platform.clone(),
            context.clone(),
            original.clone(),
        ),
        PlatformClock,
        PlatformTokens,
        family,
    )
    .await
    .map_err(|error| *error.error)?;
    let host = Host::new(
        platform.clone(),
        session.admission_handle(),
        image,
        default_model,
    )
    .await?;
    let runtime = Rc::new(ExtrasRuntime::new(store, host));
    let result = runtime
        .handle(ExtrasRequest {
            route,
            body: raw,
            multipart,
            raw_body_bytes,
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
        KernelDisposition::FromAggregate
            if result.semantic_terminal
                == Some(gateway_core::lifecycle::SemanticTerminal::Completed) =>
        {
            (KernelTerminal::Committed, "images_source_completed")
        }
        KernelDisposition::FromAggregate => (KernelTerminal::Released, "images_source_incomplete"),
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
    let bytes = result.body.as_bytes().to_vec();
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

fn runtime_default_model(runtime: &SourceJson) -> Option<ModelId> {
    source::member(runtime, "default_model")
        .as_ref()
        .and_then(source::string)
        .map(ModelId::from_source)
}

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "The source extras response could not be rendered.",
        "extras_response_unavailable",
    )
}

#[cfg(test)]
mod source_tests {
    #[test]
    fn original_catalog_default_model_keeps_source_units_without_scalar_fallback() {
        let runtime =
            gateway_core::source_json::SourceJson::parse(r#"{"default_model":"model\ud800"}"#)
                .unwrap();
        let model = super::runtime_default_model(&runtime).unwrap();
        assert!(model.as_js_string().as_units().contains(&0xd800));
    }
}
