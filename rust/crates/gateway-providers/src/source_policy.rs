//! Finite semantic observations over the same authoritative event, not a transcript conversion.
use crate::source as s;
use gateway_core::{source_json::SourceJson, source_serialization as json};
fn nonempty(value: &SourceJson) -> bool {
    s::string(value).is_some_and(|text| !text.as_units().is_empty())
}
pub(crate) fn response_has_answer(value: &SourceJson) -> bool {
    json::array(&s::get(value, "output")).is_some_and(|items| items.iter().any(item_has_answer))
}
pub(crate) fn item_has_answer(item: &SourceJson) -> bool {
    match s::control(&s::get(item, "type")).as_deref().unwrap_or("") {
        "reasoning" => false,
        "function_call" | "custom_tool_call" => {
            nonempty(&s::get(item, "call_id"))
                && nonempty(&s::get(item, "name"))
                && (s::string(&s::get(item, "arguments")).is_some()
                    || s::string(&s::get(item, "input")).is_some())
        }
        "code_interpreter_call"
        | "computer_call"
        | "file_search_call"
        | "image_generation_call"
        | "mcp_call"
        | "web_search_call" => matches!(
            s::control(&s::get(item, "status")).as_deref(),
            Some("in_progress" | "completed" | "failed")
        ),
        _ => json::array(&s::get(item, "content")).is_some_and(|parts| {
            parts
                .iter()
                .any(|part| nonempty(&s::get(part, "text")) || nonempty(&s::get(part, "refusal")))
        }),
    }
}
pub(crate) fn semantic_event(event: &SourceJson) -> bool {
    let kind = s::control(&s::get(event, "type")).unwrap_or_default();
    if [
        "response.output_text.delta",
        "response.output_text.done",
        "response.refusal.delta",
        "response.refusal.done",
    ]
    .contains(&kind.as_str())
    {
        return nonempty(&s::get(event, "delta"))
            || nonempty(&s::get(event, "text"))
            || nonempty(&s::get(event, "refusal"));
    }
    if kind == "response.image_generation_call.partial_image" {
        return nonempty(&s::get(event, "partial_image_b64"));
    }
    if ["response.output_item.added", "response.output_item.done"].contains(&kind.as_str()) {
        return item_has_answer(&s::get(event, "item"));
    }
    if kind == "response.completed" || kind == "response.output" {
        return response_has_answer(&s::get(event, "response")) || response_has_answer(event);
    }
    [
        "code_interpreter_call",
        "computer_call",
        "file_search_call",
        "image_generation_call",
        "mcp_call",
        "web_search_call",
    ]
    .iter()
    .any(|tool| {
        ["completed", "in_progress", "failed"]
            .iter()
            .any(|status| kind == format!("response.{tool}.{status}"))
    })
}
pub(crate) fn reasoning_progress(event: &SourceJson) -> bool {
    s::control(&s::get(event, "type")).is_some_and(|kind| kind.starts_with("response.reasoning"))
        && (nonempty(&s::get(event, "delta"))
            || nonempty(&s::get(event, "text"))
            || nonempty(&s::path(event, &["part", "text"])))
}
