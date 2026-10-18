use gateway_core::{GatewayError, provider::UpstreamProvider};
use gateway_providers::{ClientSurface,prepare_request};
use gateway_schema::reasoning::{ModelReasoning,effort_for_codex};
use serde_json::{Value,json};
use crate::{policy,types::{RoutingInput,PublishedCredential}};
pub(crate) fn prepare(input:&RoutingInput,conversation_id:&str,now:i64,provider:UpstreamProvider,model:&str,publication:&PublishedCredential,nonce:&str)->Result<gateway_providers::PreparedRequest,GatewayError>{
        let mut options = publication.options.clone();
        options.auth = publication.material.clone();
        options.client_version = input.client_version.clone();
        options.native_session_id = input.native_session_id.clone();
        options.response_id = format!("resp_{}", nonce.replace('-', ""));
        options.conversation_id = Some(conversation_id.to_owned());
        options.created_at = now / 1000;
        options.allowed_models = policy::provider_ids(&input, provider);
        let mut raw = input.raw.clone();
        if !raw.is_object() { return Err(GatewayError::new(400,"Inference request must be an object.",Some("invalid_request_error"))); }
        raw["model"] = json!(model);
        gateway_schema::request::validate_request_fields(&raw,if input.surface==ClientSurface::Chat{gateway_schema::request::RequestSurface::ChatCompletions}else{gateway_schema::request::RequestSurface::Responses},&gateway_schema::request::RequestExtensions{deepseek_thinking:provider==UpstreamProvider::Deepseek,openrouter_cache_control:provider==UpstreamProvider::Openrouter})?;
        if provider == UpstreamProvider::ChatgptCodex {
            let meta =
                ModelReasoning::from_record(input.catalog.codex().and_then(|s| s.find(model)));
            let raw_effort = if input.surface == ClientSurface::Chat {
                raw.get("reasoning_effort")
            } else {
                raw.get("reasoning").and_then(|v| v.get("effort"))
            };
            let effort = gateway_schema::reasoning::parse_effort(
                raw_effort,
                if input.surface == ClientSurface::Chat {
                    "reasoning_effort"
                } else {
                    "reasoning.effort"
                },
            )?;
            if let Some(effort)=effort { let effort = effort_for_codex(&effort, &meta);
            if input.surface == ClientSurface::Chat {
                raw["reasoning_effort"] = json!(effort);
            } else {
                if raw.get("reasoning").is_none_or(Value::is_null) {
                    raw["reasoning"] = json!({});
                }
                raw["reasoning"]["effort"] = json!(effort);
            }
            }
        }
        prepare_request(provider, input.surface, &raw, &options)
}
