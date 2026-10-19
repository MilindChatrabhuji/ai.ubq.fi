use crate::{
    policy,
    types::{PublishedCredential, RoutingInput, RoutingResult},
};
use gateway_core::{
    js_string::JsString16, provider::UpstreamProvider, source_json::SourceJson,
    source_serialization as source,
};
use gateway_providers::{ClientSurface, OrdinaryPreparationContext, prepare_source_request};
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
    model: &str,
    publication: &PublishedCredential,
    nonce: &str,
) -> RoutingResult<gateway_providers::PreparedRequest> {
    let mut options = publication.options.clone();
    options.auth = publication.material.clone();
    options.client_version = input.client_version.clone();
    options.native_session_id = input.native_session_id.clone();
    options.response_id = format!("resp_{}", nonce.replace('-', ""));
    options.conversation_id = Some(conversation_id.to_owned());
    options.created_at = now / 1000;
    options.allowed_models = policy::provider_ids(input, provider);
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
    let default_effort = input
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.get("default_reasoning_effort"))
        .and_then(serde_json::Value::as_str)
        .map(gateway_schema::util::js_trim)
        .filter(|effort| !effort.is_empty())
        .unwrap_or("medium");
    options.ordinary_preparation = Some(OrdinaryPreparationContext::from_metadata(
        &metadata,
        default_effort,
    ));
    let mut raw = input.raw.clone();
    set(
        &mut raw,
        "model",
        source::quoted(&JsString16::from_utf8(model))?,
    )?;
    // Common-envelope validation belongs to planning. M35's one coordinator owns
    // ordinary input -> selected cache capability -> reasoning/instructions/effort.
    // No early effort parsing or duplicate content normalization is permitted here.
    prepare_source_request(provider, input.surface, &raw, model, &options).map_err(Into::into)
}
