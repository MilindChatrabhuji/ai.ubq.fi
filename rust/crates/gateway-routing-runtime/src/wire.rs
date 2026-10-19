use crate::{
    policy,
    types::{PublishedCredential, RoutingInput, RoutingResult},
};
use gateway_core::{
    js_string::JsString16, provider::UpstreamProvider, source_json::SourceJson,
    source_serialization as source,
};
use gateway_providers::{ClientSurface, prepare_source_request};
use gateway_schema::{
    reasoning::ModelReasoning,
    source_request::{self, SourceRequestError},
};
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
fn effort_for_codex(effort: JsString16, model: &ModelReasoning) -> JsString16 {
    if effort.as_units().iter().copied().eq("none".encode_utf16()) {
        return effort;
    }
    if effort.as_units().iter().copied().eq("ultra".encode_utf16()) {
        return JsString16::from_utf8("max");
    }
    model
        .wire_efforts
        .iter()
        .find(|(name, _)| effort.as_units().iter().copied().eq(name.encode_utf16()))
        .and_then(|(_, value)| value.as_str())
        .map(JsString16::from_utf8)
        .unwrap_or(effort)
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
    let mut raw = input.raw.clone();
    set(
        &mut raw,
        "model",
        source::quoted(&JsString16::from_utf8(model))?,
    )?;
    // Common-envelope validation belongs to planning, not this pure per-provider adapter.
    if provider == UpstreamProvider::ChatgptCodex {
        let metadata =
            ModelReasoning::from_record(input.catalog.codex().and_then(|s| s.find(model)));
        let field = if input.surface == ClientSurface::Chat {
            "reasoning_effort"
        } else {
            "reasoning.effort"
        };
        let raw_effort = if input.surface == ClientSurface::Chat {
            source::member(&raw, "reasoning_effort")
        } else {
            source::member(&raw, "reasoning").and_then(|value| source::member(&value, "effort"))
        };
        if let Some(effort) = source_request::parse_effort(raw_effort.as_ref(), field)? {
            let effort = source::quoted(&effort_for_codex(effort, &metadata))?;
            if input.surface == ClientSurface::Chat {
                set(&mut raw, "reasoning_effort", effort)?;
            } else {
                let mut reasoning = source::member(&raw, "reasoning")
                    .filter(|value| value.as_str() != "null")
                    .unwrap_or(SourceJson::parse("{}")?);
                set(&mut reasoning, "effort", effort)?;
                set(&mut raw, "reasoning", reasoning)?;
            }
        }
    }
    prepare_source_request(provider, input.surface, &raw, model, &options).map_err(Into::into)
}
