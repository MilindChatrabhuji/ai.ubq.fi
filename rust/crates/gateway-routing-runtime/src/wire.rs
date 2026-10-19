use crate::{
    policy,
    types::{
        CredentialFence, PreparedWireRequest, PublishedCredential, RoutingInput, RoutingResult,
    },
};
use gateway_core::{
    js_string::JsString16, model::ModelId, provider::UpstreamProvider, source_json::SourceJson,
    source_serialization as source,
};
use gateway_providers::{
    ClientSurface, OrdinaryPreparationContext, PreparedClaudeBody, prepare_source_request,
};
use gateway_schema::source_request::SourceRequestError;
/// A derived per-hop object, never a mutation of the authoritative original request.
pub(crate) fn set(
    raw: &mut SourceJson,
    key: &str,
    value: SourceJson,
) -> Result<(), SourceRequestError> {
    let mut fields = source::entries(raw)
        .ok_or_else(|| SourceRequestError::invalid("Inference request must be an object.", None))?;
    if let Some((_, old)) = fields
        .iter_mut()
        .find(|(name, _)| name.as_units().iter().copied().eq(key.encode_utf16()))
    {
        *old = value;
    } else {
        fields.push((JsString16::from_utf8(key), value));
    }
    *raw = source::object_keys(fields).map_err(SourceRequestError::from_gateway)?;
    Ok(())
}
pub(crate) fn prepare(
    input: &RoutingInput,
    conversation_id: &str,
    now: i64,
    provider: UpstreamProvider,
    model: &ModelId,
    publication: &PublishedCredential,
    nonce: &str,
) -> RoutingResult<PreparedWireRequest> {
    let mut catalog = input.catalog.clone();
    catalog.snapshot = input.catalog.codex().cloned();
    let metadata = gateway_schema::catalog::request_model_metadata(
        &catalog,
        model,
        input.surface != ClientSurface::Chat,
        now,
    );
    // src/openai.ts getDefaultReasoningEffort: runtime default, otherwise the
    // existing source default `medium`, never a selected model's default tier.
    let default_effort = match input.runtime.as_ref() {
        None => JsString16::from_utf8("medium"),
        Some(runtime) => source::member(runtime, "default_reasoning_effort")
            .and_then(|value| source::string(&value))
            .filter(|value| !value.as_units().is_empty())
            .ok_or_else(|| {
                gateway_core::GatewayError::unavailable(
                    "The validated runtime default reasoning control is unavailable.",
                    "runtime_config_invalid",
                )
            })?,
    };
    let ordinary_preparation =
        OrdinaryPreparationContext::from_metadata(&metadata, &default_effort);
    let mut raw = input.raw.clone();
    set(&mut raw, "model", model.to_source_json()?)?;
    // Common-envelope validation belongs to planning. M35's one coordinator owns
    // ordinary input -> selected cache capability -> reasoning/instructions/effort.
    // No early effort parsing or duplicate content normalization is permitted here.
    match publication {
        PublishedCredential::Scalar {
            material,
            options,
            fence,
        } if provider != UpstreamProvider::ClaudeCode
            && !matches!(fence, CredentialFence::Claude { .. }) =>
        {
            let mut options = options.as_ref().clone();
            options.auth = material.clone();
            options.client_version = input.client_version.clone();
            options.native_session_id = input.native_session_id.clone();
            options.response_id = format!("resp_{}", nonce.replace('-', ""));
            options.conversation_id = Some(conversation_id.to_owned());
            options.created_at = now / 1000;
            options.allowed_models = policy::provider_ids(input, provider);
            options.ordinary_preparation = Some(ordinary_preparation);
            prepare_source_request(provider, input.surface, &raw, model, &options)
                .map(PreparedWireRequest::Ready)
                .map_err(Into::into)
        }
        PublishedCredential::Claude {
            fence: CredentialFence::Claude { .. },
            body_options,
        } if provider == UpstreamProvider::ClaudeCode => {
            let mut options = body_options.clone();
            options.response_id = format!("resp_{}", nonce.replace('-', ""));
            options.created_at = now / 1000;
            options.allowed_models = policy::provider_ids(input, provider);
            options.ordinary_preparation = Some(ordinary_preparation);
            PreparedClaudeBody::prepare(input.surface, &raw, model, &options)
                .map(PreparedWireRequest::Claude)
                .map_err(Into::into)
        }
        _ => Err(crate::journal::unavailable(
            "Credential publication does not match the admitted provider/account.",
        )
        .into()),
    }
}
