//! Usage provenance: unreported or invalid optional counters never become measured zero.
use crate::types::ChatProfile;
use serde_json::{Value, json};
fn count(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|v| *v <= 9_007_199_254_740_991)
}
pub fn chat_to_responses(value: &Value, profile: ChatProfile) -> Option<Value> {
    if profile == ChatProfile::Claude {
        if !value.is_object() {
            return None;
        }
        let mut result = json!({});
        for (source, target) in [
            ("prompt_tokens", "input_tokens"),
            ("prompt_tokens_details", "input_tokens_details"),
            ("completion_tokens", "output_tokens"),
            ("completion_tokens_details", "output_tokens_details"),
            ("total_tokens", "total_tokens"),
            ("buyer_cost_micro", "buyer_cost_micro"),
            ("cost", "cost"),
            ("cost_details", "cost_details"),
        ] {
            if let Some(value) = value.get(source) {
                result[target] = value.clone();
            }
        }
        return Some(result);
    }
    let input = count(value.get("prompt_tokens"))?;
    let output = count(value.get("completion_tokens"))?;
    let total = count(value.get("total_tokens")).unwrap_or(input.saturating_add(output));
    let cached = if profile == ChatProfile::Deepseek {
        count(value.get("prompt_cache_hit_tokens"))
            .or_else(|| count(value["prompt_tokens_details"].get("cached_tokens")))
    } else {
        count(value["prompt_tokens_details"].get("cached_tokens"))
    }
    .filter(|v| *v <= input);
    let reasoning =
        count(value["completion_tokens_details"].get("reasoning_tokens")).filter(|v| *v <= output);
    let mut result = json!({"input_tokens":input,"output_tokens":output,"total_tokens":total});
    if let Some(cached) = cached {
        result["input_tokens_details"] = json!({"cached_tokens":cached});
    }
    if let Some(reasoning) = reasoning {
        result["output_tokens_details"] = json!({"reasoning_tokens":reasoning});
    }
    for key in ["buyer_cost_micro", "cost"] {
        if let Some(value) = value.get(key) {
            result[key] = value.clone();
        }
    }
    Some(result)
}
pub fn anthropic_to_responses(value: &Value) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    let net = count(value.get("input_tokens"));
    let output = count(value.get("output_tokens"));
    let read = count(value.get("cache_read_input_tokens"));
    let write = count(value.get("cache_creation_input_tokens"));
    let invalid = (value.get("cache_read_input_tokens").is_some() && read.is_none())
        || (value.get("cache_creation_input_tokens").is_some() && write.is_none());
    let gross = if invalid {
        None
    } else {
        net.and_then(|n| n.checked_add(read.unwrap_or(0)))
            .and_then(|n| n.checked_add(write.unwrap_or(0)))
            .filter(|v| *v <= 9_007_199_254_740_991)
    };
    let mut result = json!({"input_tokens":gross,"output_tokens":output,"total_tokens":gross.zip(output).and_then(|(a,b)|a.checked_add(b))});
    let mut details = json!({});
    if value.get("cache_read_input_tokens").is_some() {
        details["cached_tokens"] = json!(read);
    }
    if value.get("cache_creation_input_tokens").is_some() {
        details["cache_write_tokens"] = json!(write);
    }
    if details.as_object().is_some_and(|o| !o.is_empty()) {
        result["input_tokens_details"] = details;
    }
    if value["output_tokens_details"]
        .get("thinking_tokens")
        .is_some()
    {
        let reasoning = count(value["output_tokens_details"].get("thinking_tokens"))
            .filter(|r| output.is_none_or(|o| *r <= o));
        result["output_tokens_details"] = json!({"reasoning_tokens":reasoning});
    }
    if let Some(cost) = value.get("buyer_cost_micro") {
        result["buyer_cost_micro"] = cost.clone();
    }
    Some(result)
}
pub fn responses_to_chat(value: &Value) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    let mut usage = json!({"prompt_tokens":value["input_tokens"],"completion_tokens":value["output_tokens"],"total_tokens":value["total_tokens"]});
    if let Some(details) = value.get("input_tokens_details") {
        usage["prompt_tokens_details"] = details.clone();
    }
    if let Some(details) = value.get("output_tokens_details") {
        usage["completion_tokens_details"] = details.clone();
    }
    for key in ["buyer_cost_micro", "cost"] {
        if let Some(cost) = value.get(key) {
            usage[key] = cost.clone();
        }
    }
    Some(usage)
}
