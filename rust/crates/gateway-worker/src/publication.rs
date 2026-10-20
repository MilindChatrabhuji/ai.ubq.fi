//! Raw adapter for the fixed private route; all publication policy is shared.
use gateway_auth::native::NATIVE_MAX_BODY_BYTES;
use gateway_core::GatewayError;
use gateway_publication::transport::{
    OwnedNativeAuthHeaders, PublicationReceiver, PublicationRequest,
};
use worker::{Env, Request, Response};

use crate::{
    authority::RemoteAuthorityStore,
    transport::{HeaderLimits, body::request_bytes, bounded_headers},
};

pub async fn handle(
    mut request: Request,
    env: &Env,
    receiver: Option<&PublicationReceiver>,
    native: &crate::native_host::NativeBindings,
) -> Result<Response, GatewayError> {
    bounded_headers(
        &request,
        HeaderLimits {
            total_bytes: 16_384,
            value_bytes: 16_384,
            fields: 2000,
        },
    )?;
    let headers = OwnedNativeAuthHeaders::from_pairs(request.headers().entries())?;
    let method = request.method().to_string();
    let path = request.path();
    let raw_body = request_bytes(&mut request, NATIVE_MAX_BODY_BYTES).await?;
    let store = RemoteAuthorityStore::from_env(env)?;
    #[derive(serde::Deserialize)]
    struct Operation {
        operation: String,
    }
    if serde_json::from_slice::<Operation>(&raw_body)
        .ok()
        .is_some_and(|value| value.operation == "managed_access_publish")
    {
        return crate::native_authority::managed_publication(
            &request, env, native, &store, &raw_body,
        )
        .await;
    }
    if serde_json::from_slice::<Operation>(&raw_body)
        .ok()
        .is_some_and(|value| value.operation == "codex_auth_import_publish")
    {
        return crate::native_authority::import_publication(
            &request, env, native, &store, receiver, &raw_body,
        )
        .await;
    }
    let receiver = receiver.ok_or_else(|| {
        GatewayError::unavailable(
            "The native publication receiver is not configured.",
            "native_publication_unavailable",
        )
    })?;
    let response = receiver
        .handle(
            &store,
            PublicationRequest {
                method,
                path,
                raw_body,
                headers,
            },
        )
        .await;
    let mut wire = Response::from_bytes(response.raw_body)
        .map_err(|_| unavailable())?
        .with_status(response.status);
    for (name, value) in response.headers {
        wire.headers_mut()
            .set(&name, &value)
            .map_err(|_| unavailable())?;
    }
    Ok(wire)
}

fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Native publication transport failed.",
        "native_publication_transport_invalid",
    )
}
