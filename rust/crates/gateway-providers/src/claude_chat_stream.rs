//! Preserve original signed Claude Chat deltas while exposing one readable reasoning source.
use crate::types::malformed;
use gateway_core::GatewayError;
use serde_json::{Value, json};
use std::collections::BTreeMap;
#[derive(Clone, Debug)]
pub(crate) struct ClaudeChatState {
    pub assistant: Value,
    pub finish: Option<String>,
    pub replayable: bool,
    details: BTreeMap<u64, Value>,
    tools: BTreeMap<u64, Value>,
    reason_source: Option<bool>,
}
impl Default for ClaudeChatState {
    fn default() -> Self {
        Self {
            assistant: json!({"role":"assistant"}),
            finish: None,
            replayable: true,
            details: BTreeMap::new(),
            tools: BTreeMap::new(),
            reason_source: None,
        }
    }
}
pub(crate) fn readable_reasoning(value: &Value) -> String {
    value["reasoning_content"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| value["reasoning"].as_str().filter(|s| !s.is_empty()))
        .map(str::to_owned)
        .unwrap_or_else(|| detail_text(&value["reasoning_details"]))
}
fn detail_text(value: &Value) -> String {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["type"] == "reasoning.text")
        .filter_map(|v| v["text"].as_str())
        .collect()
}
impl ClaudeChatState {
    pub fn push(&mut self, chunk: &Value) -> Result<Value, GatewayError> {
        let choices = chunk["choices"]
            .as_array()
            .filter(|a| a.len() <= 1)
            .ok_or_else(|| {
                malformed("Claude Chat emitted an invalid single-choice stream chunk.")
            })?;
        if choices.is_empty() {
            return Ok(chunk.clone());
        }
        let choice = &choices[0];
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish = Some(reason.into())
        }
        let delta = choice
            .get("delta")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or(json!({}));
        for field in ["content", "reasoning_content", "reasoning", "refusal"] {
            if let Some(text) = delta[field].as_str() {
                let previous = self.assistant[field].as_str().unwrap_or("");
                self.assistant[field] = json!(format!("{previous}{text}"));
            }
        }
        if let Some(details) = delta.get("reasoning_details").filter(|v| !v.is_null()) {
            for (position, detail) in details
                .as_array()
                .ok_or_else(|| malformed("Claude reasoning_details delta must be array."))?
                .iter()
                .enumerate()
            {
                let index = detail["index"].as_u64().unwrap_or(position as u64);
                if !detail.is_object() {
                    return Err(malformed("Claude reasoning detail must be object."));
                }
                if let Some(prior) = self.details.get_mut(&index) {
                    for (key, value) in detail.as_object().expect("checked object") {
                        if key == "text" {
                            let old = prior[key].as_str().unwrap_or("");
                            if let Some(text) = value.as_str() {
                                prior[key] = json!(format!("{old}{text}"));
                            } else {
                                self.replayable = false;
                            }
                        } else if prior.get(key).is_none() {
                            prior[key] = value.clone();
                        } else if prior[key] != *value || key == "signature" {
                            self.replayable = false;
                        }
                    }
                } else {
                    self.details.insert(index, detail.clone());
                }
            }
        }
        if let Some(tools) = delta.get("tool_calls").filter(|v| !v.is_null()) {
            for (position, call) in tools
                .as_array()
                .ok_or_else(|| malformed("Claude tool_calls delta must be array."))?
                .iter()
                .enumerate()
            {
                if !call["function"].is_object() {
                    return Err(malformed("Claude tool call delta must have a function."));
                }
                let index = call["index"].as_u64().unwrap_or(position as u64);
                let row = self.tools.entry(index).or_insert(
                    json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                );
                if let Some(id) = call["id"].as_str() {
                    row["id"] = json!(id)
                }
                for field in ["name", "arguments"] {
                    if let Some(text) = call["function"][field].as_str() {
                        let old = row["function"][field].as_str().unwrap_or("");
                        row["function"][field] = json!(format!("{old}{text}"));
                    }
                }
            }
        }
        let from_content = delta["reasoning_content"]
            .as_str()
            .or_else(|| delta["reasoning"].as_str())
            .unwrap_or("");
        let from_details = detail_text(&delta["reasoning_details"]);
        if self.reason_source.is_none() && (!from_content.is_empty() || !from_details.is_empty()) {
            self.reason_source = Some(!from_content.is_empty());
        }
        let reasoning = if self.reason_source == Some(true) {
            from_content.to_owned()
        } else {
            from_details
        };
        let mut projected = delta;
        for key in [
            "reasoning_content",
            "reasoning",
            "reasoning_details",
            "tool_calls",
        ] {
            projected.as_object_mut().expect("object").remove(key);
        }
        if !reasoning.is_empty() {
            projected["reasoning_content"] = json!(reasoning)
        }
        let mut result = chunk.clone();
        result["choices"] = json!([{"index":choice["index"].as_u64().unwrap_or(0),"delta":projected,"finish_reason":choice["finish_reason"]}]);
        Ok(result)
    }
    pub fn finish_message(&mut self) -> Value {
        if !self.details.is_empty() {
            self.assistant["reasoning_details"] =
                json!(self.details.values().cloned().collect::<Vec<_>>());
        }
        if !self.tools.is_empty() {
            self.assistant["tool_calls"] = json!(self.tools.values().cloned().collect::<Vec<_>>());
        }
        self.assistant.clone()
    }
}
