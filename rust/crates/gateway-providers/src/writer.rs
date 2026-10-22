//! Ordered Responses item lifecycles shared by Chat and native Messages decoders.
use crate::{source as s, tools, types::*};
use gateway_core::lifecycle::SemanticTerminal;
use gateway_core::source_json::SourceJson;
use serde_json::{Value, json};
use std::collections::BTreeMap;
#[derive(Clone, Debug)]
struct Active {
    kind: &'static str,
    id: String,
    index: usize,
    text: String,
    refusal: String,
    text_part: Option<usize>,
    refusal_part: Option<usize>,
}
#[derive(Clone, Debug, Default)]
struct Call {
    id: String,
    name: String,
    args: String,
    index: Option<usize>,
    item_id: String,
}
#[derive(Clone, Debug)]
pub struct ResponseWriter {
    pub plan: DecodePlan,
    pub output: Vec<SourceJson>,
    active: Option<Active>,
    pending_reasoning: String,
    calls: BTreeMap<usize, Call>,
    started: bool,
    finished: bool,
    pub usage: Option<Value>,
    pub finish_reason: Option<String>,
    pub terminal: Option<SemanticTerminal>,
}
pub fn envelope(plan: &DecodePlan, status: &str) -> SourceJson {
    crate::source_echo::envelope(plan, status)
}
pub fn finish_disposition(
    reason: Option<&str>,
) -> (SemanticTerminal, Option<&'static str>, Option<String>) {
    match reason.unwrap_or("").trim() {
        "" | "stop" | "tool_calls" => (SemanticTerminal::Completed, None, None),
        "length" => (
            SemanticTerminal::Incomplete,
            Some("max_output_tokens"),
            None,
        ),
        "content_filter" => (SemanticTerminal::Incomplete, Some("content_filter"), None),
        "insufficient_system_resource" | "aborted" => {
            (SemanticTerminal::Failed, None, reason.map(str::to_owned))
        }
        other => (
            SemanticTerminal::Failed,
            None,
            Some(format!("unrecognized_finish_reason:{other}")),
        ),
    }
}
impl ResponseWriter {
    pub fn new(plan: DecodePlan) -> Self {
        Self {
            plan,
            output: vec![],
            active: None,
            pending_reasoning: String::new(),
            calls: BTreeMap::new(),
            started: false,
            finished: false,
            usage: None,
            finish_reason: None,
            terminal: None,
        }
    }
    pub fn start(&mut self) -> Vec<ProviderEvent> {
        if self.started || self.finished {
            return vec![];
        }
        self.started = true;
        vec![
            crate::source_echo::response_event(
                "response.created",
                envelope(&self.plan, "in_progress"),
            ),
            crate::source_echo::response_event(
                "response.in_progress",
                envelope(&self.plan, "in_progress"),
            ),
        ]
    }

    fn allocate(&mut self, kind: &'static str) -> Active {
        let index = self.output.len();
        let prefix = if kind == "reasoning" { "rs" } else { "msg" };
        let id = format!("{prefix}_{}_{}", self.plan.response_id, index);
        let mut item = if kind == "reasoning" {
            json!({"id":id,"type":"reasoning","status":"in_progress","summary":[]})
        } else {
            json!({"id":id,"type":"message","status":"in_progress","role":"assistant","content":[]})
        };
        item["status"] = json!("in_progress");
        self.output.push(s::generated(&item));
        Active {
            kind,
            id,
            index,
            text: String::new(),
            refusal: String::new(),
            text_part: None,
            refusal_part: None,
        }
    }
    fn added(&self, active: &Active) -> ProviderEvent {
        crate::source_echo::item_event(
            "response.output_item.added",
            active.index,
            s::generated(&self.output[active.index]),
        )
    }
    pub fn close(&mut self) -> Vec<ProviderEvent> {
        let Some(active) = self.active.take() else {
            return vec![];
        };
        let mut events = vec![];
        let common = json!({"item_id":active.id,"output_index":active.index});
        let item = if active.kind == "reasoning" {
            let part = json!({"type":"summary_text","text":active.text});
            events.push(ProviderEvent::responses(json!({"type":"response.reasoning_summary_text.done","item_id":common["item_id"],"output_index":active.index,"summary_index":0,"text":active.text})));
            events.push(ProviderEvent::responses(json!({"type":"response.reasoning_summary_part.done","item_id":common["item_id"],"output_index":active.index,"summary_index":0,"part":part})));
            json!({"id":active.id,"type":"reasoning","status":"completed","summary":[part]})
        } else {
            let mut parts = vec![];
            if let Some(index) = active.text_part {
                let part = json!({"type":"output_text","text":active.text,"annotations":[]});
                events.push(ProviderEvent::responses(json!({"type":"response.output_text.done","item_id":active.id,"output_index":active.index,"content_index":index,"text":active.text,"logprobs":[]})));
                events.push(ProviderEvent::responses(json!({"type":"response.content_part.done","item_id":active.id,"output_index":active.index,"content_index":index,"part":part})));
                parts.push((index, part));
            }
            if let Some(index) = active.refusal_part {
                let part = json!({"type":"refusal","refusal":active.refusal});
                events.push(ProviderEvent::responses(json!({"type":"response.refusal.done","item_id":active.id,"output_index":active.index,"content_index":index,"refusal":active.refusal})));
                events.push(ProviderEvent::responses(json!({"type":"response.content_part.done","item_id":active.id,"output_index":active.index,"content_index":index,"part":part})));
                parts.push((index, part));
            }
            parts.sort_by_key(|(i, _)| *i);
            json!({"id":active.id,"type":"message","status":"completed","role":"assistant","content":parts.into_iter().map(|(_,v)|v).collect::<Vec<_>>()})
        };
        self.output[active.index] = s::generated(&item);
        events.push(crate::source_echo::item_event(
            "response.output_item.done",
            active.index,
            s::generated(&item),
        ));
        events
    }
    pub fn reasoning(&mut self, text: &str) -> Vec<ProviderEvent> {
        if self.finished
            || text.is_empty()
            || self
                .plan
                .reasoning_summary
                .as_ref()
                .is_some_and(|value| value.as_units().iter().copied().eq("none".encode_utf16()))
        {
            return vec![];
        }
        let mut events = self.start();
        if self.active.as_ref().is_some_and(|a| a.kind != "reasoning") {
            self.pending_reasoning.push_str(text);
            return events;
        }
        if self.active.is_none() {
            let active = self.allocate("reasoning");
            events.push(self.added(&active));
            events.push(ProviderEvent::responses(json!({"type":"response.reasoning_summary_part.added","item_id":active.id,"output_index":active.index,"summary_index":0,"part":{"type":"summary_text","text":""}})));
            self.active = Some(active);
        }
        if let Some(active) = self.active.as_mut() {
            active.text.push_str(text);
            events.push(ProviderEvent::responses(json!({"type":"response.reasoning_summary_text.delta","item_id":active.id,"output_index":active.index,"summary_index":0,"delta":text})));
        }
        events
    }
    pub fn text(&mut self, text: &str, refusal: bool) -> Vec<ProviderEvent> {
        if self.finished || text.is_empty() {
            return vec![];
        }
        let mut events = self.start();
        if self.active.as_ref().is_some_and(|a| a.kind == "reasoning") {
            events.extend(self.close());
        }
        if self.active.is_none() {
            let active = self.allocate("message");
            events.push(self.added(&active));
            self.active = Some(active);
        }
        let Some(active) = self.active.as_mut() else {
            return events;
        };
        let part_slot = if refusal {
            &mut active.refusal_part
        } else {
            &mut active.text_part
        };
        if part_slot.is_none() {
            let index = usize::from(active.text_part.is_some())
                + usize::from(active.refusal_part.is_some());
            if refusal {
                active.refusal_part = Some(index);
            } else {
                active.text_part = Some(index);
            }
            let part = if refusal {
                json!({"type":"refusal","refusal":""})
            } else {
                json!({"type":"output_text","text":"","annotations":[]})
            };
            events.push(ProviderEvent::responses(json!({"type":"response.content_part.added","item_id":active.id,"output_index":active.index,"content_index":index,"part":part})));
        }
        let index = if refusal {
            active.refusal_part.unwrap_or(0)
        } else {
            active.text_part.unwrap_or(0)
        };
        if refusal {
            active.refusal.push_str(text)
        } else {
            active.text.push_str(text)
        }
        let mut event = json!({"type":if refusal{"response.refusal.delta"}else{"response.output_text.delta"},"item_id":active.id,"output_index":active.index,"content_index":index,"delta":text});
        if !refusal {
            event["logprobs"] = json!([])
        }
        events.push(ProviderEvent::responses(event));
        events
    }
    fn flush_pending(&mut self) -> Vec<ProviderEvent> {
        if self.pending_reasoning.is_empty() {
            return vec![];
        }
        let pending = std::mem::take(&mut self.pending_reasoning);
        let mut events = self.reasoning(&pending);
        events.extend(self.close());
        events
    }
    pub fn tool_delta(
        &mut self,
        key: usize,
        id: Option<&str>,
        name: Option<&str>,
        args: &str,
    ) -> Vec<ProviderEvent> {
        if self.finished {
            return vec![];
        }
        let mut events = self.start();
        events.extend(self.close());
        events.extend(self.flush_pending());
        let call = self.calls.entry(key).or_default();
        if let Some(id) = id {
            call.id = id.into()
        }
        if let Some(name) = name {
            call.name = name.into()
        }
        call.args.push_str(args);
        if call.id.is_empty() {
            call.id = format!("{}_call_{key}", self.plan.response_id)
        }
        let identity = tools::original(&call.name, &self.plan.tool_names);
        if !call.name.is_empty() && call.index.is_none() && !identity.custom {
            let index = self.output.len();
            let item_id = format!("fc_{}_{index}", self.plan.response_id);
            call.index = Some(index);
            call.item_id = item_id.clone();
            let item = tools::function_item(
                &item_id,
                &call.id,
                &call.name,
                "",
                &self.plan.tool_names,
                "in_progress",
            );
            self.output.push(item.clone());
            events.push(crate::source_echo::item_event(
                "response.output_item.added",
                index,
                s::generated(&item),
            ));
            if !call.args.is_empty() {
                events.push(ProviderEvent::responses(json!({"type":"response.function_call_arguments.delta","item_id":item_id,"output_index":index,"delta":call.args})));
            }
        } else if let Some(index) = call.index
            && !args.is_empty()
        {
            events.push(ProviderEvent::responses(json!({"type":"response.function_call_arguments.delta","item_id":call.item_id,"output_index":index,"delta":args})));
        }
        events
    }
    pub fn chat_chunk(&mut self, chunk: &Value, profile: ChatProfile) -> Vec<ProviderEvent> {
        let mut events = self.start();
        if let Some(usage) = chunk.get("usage").filter(|v| !v.is_null()) {
            self.usage = crate::usage::chat_to_responses(usage, profile);
        }
        for choice in chunk["choices"].as_array().into_iter().flatten() {
            if let Some(reason) = choice["finish_reason"].as_str() {
                self.finish_reason = Some(reason.into())
            }
            let delta = &choice["delta"];
            if let Some(reason) = delta["reasoning_content"]
                .as_str()
                .or_else(|| delta["reasoning"].as_str())
            {
                events.extend(self.reasoning(reason));
            }
            if let Some(text) = delta["content"].as_str() {
                events.extend(self.text(text, false));
            }
            if let Some(refusal) = delta["refusal"].as_str() {
                events.extend(self.text(refusal, true));
            }
            for (position, call) in delta["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                events.extend(
                    self.tool_delta(
                        call["index"]
                            .as_u64()
                            .map(|v| v as usize)
                            .unwrap_or(position),
                        call["id"].as_str(),
                        call["function"]["name"].as_str(),
                        call["function"]["arguments"].as_str().unwrap_or(""),
                    ),
                );
            }
        }
        events
    }
    pub fn finish(&mut self) -> Vec<ProviderEvent> {
        if self.finished {
            return vec![];
        }
        let mut events = self.start();
        events.extend(self.close());
        events.extend(self.flush_pending());
        let (terminal, incomplete, error) = finish_disposition(self.finish_reason.as_deref());
        let status = match terminal {
            SemanticTerminal::Completed => "completed",
            SemanticTerminal::Incomplete => "incomplete",
            _ => "failed",
        };
        for call in self.calls.values_mut() {
            if call.name.is_empty() {
                continue;
            }
            let identity = tools::original(&call.name, &self.plan.tool_names);
            let index = if let Some(index) = call.index {
                index
            } else {
                let index = self.output.len();
                let id = format!(
                    "{}_{}_{index}",
                    if identity.custom { "ctc" } else { "fc" },
                    self.plan.response_id
                );
                call.item_id = id.clone();
                call.index = Some(index);
                let item = tools::function_item(
                    &id,
                    &call.id,
                    &call.name,
                    "",
                    &self.plan.tool_names,
                    "in_progress",
                );
                self.output.push(item.clone());
                events.push(crate::source_echo::item_event(
                    "response.output_item.added",
                    index,
                    s::generated(&item),
                ));
                index
            };
            if identity.custom {
                events.push(ProviderEvent::responses_source(s::object(vec![
                    ("type", s::text("response.custom_tool_call_input.delta")),
                    ("item_id", s::text(&call.item_id)),
                    ("output_index", s::generated(&index)),
                    ("call_id", s::text(&call.id)),
                    ("delta", s::quoted(&tools::custom_input(&call.args))),
                ])));
            } else {
                events.push(ProviderEvent::responses(json!({"type":"response.function_call_arguments.done","item_id":call.item_id,"output_index":index,"arguments":call.args})));
            }
            let item = tools::function_item(
                &call.item_id,
                &call.id,
                &call.name,
                &call.args,
                &self.plan.tool_names,
                status,
            );
            self.output[index] = item.clone();
            events.push(crate::source_echo::item_event(
                "response.output_item.done",
                index,
                s::generated(&item),
            ));
        }
        let mut response = envelope(&self.plan, status);
        s::set(&mut response, "output", s::array(&self.output));
        s::set(&mut response, "usage", s::generated(&self.usage));
        if let Some(reason) = incomplete {
            s::set(
                &mut response,
                "incomplete_details",
                s::generated(&json!({"reason":reason})),
            );
        }
        if let Some(error) = error {
            s::set(
                &mut response,
                "error",
                s::generated(
                    &json!({"code":error,"message":format!("Upstream stopped generating: {error}")}),
                ),
            );
        }
        let empty = terminal == SemanticTerminal::Completed
            && !crate::source_policy::response_has_answer(&response);
        let terminal = if empty {
            s::set(&mut response, "status", s::text("failed"));
            s::set(
                &mut response,
                "error",
                s::generated(
                    &json!({"code":"empty_upstream_completion","message":"Upstream response completed with no translated semantic output."}),
                ),
            );
            SemanticTerminal::Failed
        } else {
            terminal
        };
        let kind = match terminal {
            SemanticTerminal::Completed => "response.completed",
            SemanticTerminal::Incomplete => "response.incomplete",
            _ => "response.failed",
        };
        events.push(crate::source_echo::response_event(kind, response));
        self.terminal = Some(terminal);
        self.finished = true;
        events
    }
}

pub(crate) fn anthropic_reason(reason: &str) -> String {
    match reason {
        "end_turn" | "stop_sequence" => "stop",
        "tool_use" => "tool_calls",
        "max_tokens" => "length",
        other => other,
    }
    .into()
}
