//! Source-bearing envelope composition; scalar upstream fragments are lifted, not request text.
use crate::{source as s, types::DecodePlan};
use gateway_core::{source_json::SourceJson, source_serialization as json};

pub(crate) fn envelope(plan: &DecodePlan, status: &str) -> SourceJson {
    let instructions = s::get(&plan.request, "instructions");
    let choice = s::present(&plan.request, "tool_choice").unwrap_or_else(|| s::text("auto"));
    let tools = s::present(&plan.request, "tools")
        .filter(|value| json::array(value).is_some())
        .unwrap_or_else(|| s::array(&[]));
    let parallel = s::boolean(&s::get(&plan.request, "parallel_tool_calls")).unwrap_or(true);
    s::object(vec![
        ("id", s::text(&plan.response_id)),
        ("object", s::text("response")),
        ("created_at", s::generated(&plan.created_at)),
        ("status", s::text(status)),
        ("model", s::quoted(plan.model.as_js_string())),
        ("output", s::array(&[])),
        ("error", s::null()),
        ("incomplete_details", s::null()),
        ("instructions", instructions),
        ("metadata", s::object(vec![])),
        ("parallel_tool_calls", s::generated(&parallel)),
        ("tool_choice", choice),
        ("tools", tools),
        ("temperature", s::null()),
        ("top_p", s::null()),
        ("max_output_tokens", s::null()),
        ("previous_response_id", s::null()),
        ("reasoning", s::null()),
        ("store", s::generated(&false)),
        ("truncation", s::text("disabled")),
        ("usage", s::null()),
    ])
}

pub(crate) fn response_event(kind: &str, response: SourceJson) -> crate::types::ProviderEvent {
    crate::types::ProviderEvent::responses_source(s::object(vec![
        ("type", s::text(kind)),
        ("response", response),
    ]))
}

pub(crate) fn item_event(
    kind: &str,
    index: usize,
    item: SourceJson,
) -> crate::types::ProviderEvent {
    crate::types::ProviderEvent::responses_source(s::object(vec![
        ("type", s::text(kind)),
        ("output_index", s::generated(&index)),
        ("item", item),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ClientSurface, ResponseDecode, ToolMap};
    use gateway_core::{js_string::JsString16, provider::UpstreamProvider};

    #[test]
    fn instructions_tools_and_choice_never_cross_a_scalar_envelope() {
        let request = SourceJson::parse(r#"{"instructions":"\ud800","tools":[{"type":"function","name":"f\udc00","parameters":{"\ud800":{"type":"string"}}}],"tool_choice":{"type":"function","name":"\udc00"}}"#).unwrap();
        let plan = DecodePlan {
            provider: UpstreamProvider::Lithos,
            surface: ClientSurface::Responses,
            decode: ResponseDecode::ChatToResponses(crate::ChatProfile::Lithos),
            model: "test".into(),
            upstream_model: "test".into(),
            response_id: "resp_test".into(),
            created_at: 1,
            stream: true,
            request: request.clone(),
            tool_names: ToolMap::new(),
            reasoning_summary: None,
        };
        let body = envelope(&plan, "completed");
        assert_eq!(
            json::string(&s::get(&body, "instructions")).unwrap(),
            JsString16::from_units(vec![0xd800])
        );
        assert_eq!(s::get(&body, "tools"), s::get(&request, "tools"));
        assert_eq!(
            s::get(&body, "tool_choice"),
            s::get(&request, "tool_choice")
        );
        assert!(body.deserialize::<serde_json::Value>().is_err());
        let event = response_event("response.completed", body.clone());
        assert_eq!(event.field("response"), Some(body));
        assert!(event.encode_sse().contains("\\ud800"));
        assert_eq!(plan.request, request);
    }
}
