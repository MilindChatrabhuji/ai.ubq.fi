//! Source-bearing event-to-Chat observation; upstream parsing remains in sse.rs.
use crate::{source as s, types::*};
use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, source_serialization as json,
};
use serde_json::Value;
use std::collections::BTreeMap;
#[derive(Clone, Default)]
struct Call {
    id: JsString16,
    name: JsString16,
    args: JsString16,
    index: usize,
}
#[derive(Clone)]
pub struct ChatCollector {
    plan: DecodePlan,
    started: bool,
    finished: bool,
    text: BTreeMap<String, JsString16>,
    refusal: BTreeMap<String, JsString16>,
    calls: BTreeMap<usize, Call>,
    pub usage: Option<Value>,
}
fn string(value: &SourceJson, message: &str) -> Result<JsString16, GatewayError> {
    s::string(value).ok_or_else(|| malformed(message))
}
fn suffix(full: &JsString16, old: &JsString16, message: &str) -> Result<JsString16, GatewayError> {
    full.as_units()
        .strip_prefix(old.as_units())
        .map(|units| JsString16::from_units(units.to_vec()))
        .ok_or_else(|| malformed(message))
}
fn number(value: &SourceJson) -> usize {
    json::number(value).unwrap_or(0.0) as usize
}
pub(crate) fn usage(value: &SourceJson) -> Option<Value> {
    (!s::is_null(value))
        .then(|| value.deserialize().ok())
        .flatten()
}
impl ChatCollector {
    pub fn new(plan: DecodePlan) -> Self {
        Self {
            plan,
            started: false,
            finished: false,
            text: BTreeMap::new(),
            refusal: BTreeMap::new(),
            calls: BTreeMap::new(),
            usage: None,
        }
    }
    fn chunk(&self, delta: SourceJson, finish: SourceJson) -> ProviderEvent {
        ProviderEvent::chat_source(s::object(vec![
            ("id", s::text(&self.plan.response_id)),
            ("object", s::text("chat.completion.chunk")),
            ("created", s::generated(&self.plan.created_at)),
            ("model", s::quoted(self.plan.model.as_js_string())),
            (
                "choices",
                s::array(&[s::object(vec![
                    ("index", s::generated(&0)),
                    ("delta", delta),
                    ("finish_reason", finish),
                ])]),
            ),
        ]))
    }
    fn text_chunk(&self, text: &JsString16, refusal: bool) -> ProviderEvent {
        self.chunk(
            s::object(vec![(
                if refusal { "refusal" } else { "content" },
                s::quoted(text),
            )]),
            s::null(),
        )
    }
    fn call_chunk(
        &self,
        index: usize,
        id: Option<&JsString16>,
        name: Option<&JsString16>,
        args: &JsString16,
    ) -> ProviderEvent {
        let mut function = s::object(vec![("arguments", s::quoted(args))]);
        if let Some(name) = name {
            s::set(&mut function, "name", s::quoted(name));
        }
        let mut call = s::object(vec![
            ("index", s::generated(&index)),
            ("function", function),
        ]);
        if let Some(id) = id {
            s::set(&mut call, "id", s::quoted(id));
            s::set(&mut call, "type", s::text("function"));
        }
        self.chunk(
            s::object(vec![("tool_calls", s::array(&[call]))]),
            s::null(),
        )
    }
    fn reconcile(
        &mut self,
        index: usize,
        item: &SourceJson,
    ) -> Result<Vec<ProviderEvent>, GatewayError> {
        let mut result = vec![];
        if s::is(&s::get(item, "type"), "message") {
            for (content_index, part) in json::array(&s::get(item, "content"))
                .unwrap_or_default()
                .iter()
                .enumerate()
            {
                let refusal = s::is(&s::get(part, "type"), "refusal");
                if !refusal && !s::is(&s::get(part, "type"), "output_text") {
                    continue;
                }
                let full = string(
                    &s::get(part, if refusal { "refusal" } else { "text" }),
                    "Completed output content is not string.",
                )?;
                let map = if refusal {
                    &mut self.refusal
                } else {
                    &mut self.text
                };
                let previous = map.entry(format!("{index}:{content_index}")).or_default();
                let delta = suffix(
                    &full,
                    previous,
                    "Completed output disagrees with streamed prefix.",
                )?;
                *previous = full;
                if !delta.as_units().is_empty() {
                    result.push(self.text_chunk(&delta, refusal));
                }
            }
        } else if s::is(&s::get(item, "type"), "function_call") {
            let id = s::nonempty(&s::get(item, "call_id"))
                .ok_or_else(|| malformed("Completed function call has no call_id."))?;
            let name = s::nonempty(&s::get(item, "name"))
                .ok_or_else(|| malformed("Completed function call has no name."))?;
            let args = string(
                &s::get(item, "arguments"),
                "Completed function arguments are not string.",
            )?;
            let next = self.calls.len();
            let added = !self.calls.contains_key(&index);
            let call = self.calls.entry(index).or_insert_with(|| Call {
                index: next,
                ..Default::default()
            });
            if (!call.id.as_units().is_empty() && call.id != id)
                || (!call.name.as_units().is_empty() && call.name != name)
            {
                return Err(malformed(
                    "Completed function identity disagrees with streamed metadata.",
                ));
            }
            let delta = suffix(
                &args,
                &call.args,
                "Completed function arguments disagree with streamed prefix.",
            )?;
            call.id = id.clone();
            call.name = name.clone();
            call.args = args.clone();
            let slot = call.index;
            if added {
                result.push(self.call_chunk(slot, Some(&id), Some(&name), &args));
            } else if !delta.as_units().is_empty() {
                result.push(self.call_chunk(slot, None, None, &delta));
            }
        }
        Ok(result)
    }
    pub fn push(&mut self, event: &SourceJson) -> Result<Vec<ProviderEvent>, GatewayError> {
        if self.finished {
            return Ok(vec![]);
        }
        let mut result = vec![];
        let kind = s::control(&s::get(event, "type")).unwrap_or_default();
        if kind == "response.created" {
            if let Some(id) = s::control(&s::path(event, &["response", "id"])) {
                self.plan.response_id = id;
            }
            if let Some(created) = json::number(&s::path(event, &["response", "created_at"])) {
                self.plan.created_at = created as i64;
            }
        }
        if !self.started {
            result.push(self.chunk(
                s::generated(&serde_json::json!({"role":"assistant","content":""})),
                s::null(),
            ));
            self.started = true;
        }
        let index = number(&s::get(event, "output_index"));
        let key = format!("{index}:{}", number(&s::get(event, "content_index")));
        match kind.as_str() {
            "response.output_text.delta" | "response.refusal.delta" => {
                let text = string(&s::get(event, "delta"), "Output delta is not string.")?;
                let refusal = kind == "response.refusal.delta";
                let map = if refusal {
                    &mut self.refusal
                } else {
                    &mut self.text
                };
                let previous = map.entry(key).or_default();
                *previous = s::concat(&[previous, &text]);
                if !text.as_units().is_empty() {
                    result.push(self.text_chunk(&text, refusal));
                }
            }
            "response.output_text.done" | "response.refusal.done" => {
                let refusal = kind == "response.refusal.done";
                let full = string(
                    &s::get(event, if refusal { "refusal" } else { "text" }),
                    "Completed output is not string.",
                )?;
                let map = if refusal {
                    &mut self.refusal
                } else {
                    &mut self.text
                };
                let previous = map.entry(key).or_default();
                let delta = suffix(
                    &full,
                    previous,
                    "Completed output disagrees with streamed prefix.",
                )?;
                *previous = full;
                if !delta.as_units().is_empty() {
                    result.push(self.text_chunk(&delta, refusal));
                }
            }
            "response.output_item.added" => {
                let item = s::get(event, "item");
                if s::is(&s::get(&item, "type"), "function_call") {
                    let call = Call {
                        id: s::string(&s::get(&item, "call_id")).unwrap_or_default(),
                        name: s::string(&s::get(&item, "name")).unwrap_or_default(),
                        args: s::string(&s::get(&item, "arguments")).unwrap_or_default(),
                        index: self.calls.len(),
                    };
                    result.push(self.call_chunk(
                        call.index,
                        Some(&call.id),
                        Some(&call.name),
                        &call.args,
                    ));
                    self.calls.insert(index, call);
                }
            }
            "response.function_call_arguments.delta" => {
                let delta = string(
                    &s::get(event, "delta"),
                    "Tool argument delta is not string.",
                )?;
                let next = self.calls.len();
                let call = self.calls.entry(index).or_insert_with(|| Call {
                    index: next,
                    ..Default::default()
                });
                call.args = s::concat(&[&call.args, &delta]);
                let slot = call.index;
                result.push(self.call_chunk(slot, None, None, &delta));
            }
            "response.function_call_arguments.done" => {
                let full = string(
                    &s::get(event, "arguments"),
                    "Tool arguments are not string.",
                )?;
                let next = self.calls.len();
                let call = self.calls.entry(index).or_insert_with(|| Call {
                    index: next,
                    ..Default::default()
                });
                let delta = suffix(
                    &full,
                    &call.args,
                    "Tool arguments disagree with streamed prefix.",
                )?;
                call.args = full;
                let slot = call.index;
                if !delta.as_units().is_empty() {
                    result.push(self.call_chunk(slot, None, None, &delta));
                }
            }
            "response.output_item.done" => {
                result.extend(self.reconcile(index, &s::get(event, "item"))?)
            }
            "response.output" => {
                for (index, item) in json::array(&s::get(event, "output"))
                    .unwrap_or_default()
                    .iter()
                    .enumerate()
                {
                    result.extend(self.reconcile(index, item)?);
                }
            }
            "response.completed" => {
                let response = s::get(event, "response");
                for (index, item) in json::array(&s::get(&response, "output"))
                    .unwrap_or_default()
                    .iter()
                    .enumerate()
                {
                    result.extend(self.reconcile(index, item)?);
                }
                if self.text.values().all(|text| text.as_units().is_empty())
                    && self.refusal.values().all(|text| text.as_units().is_empty())
                    && self.calls.is_empty()
                {
                    return Err(GatewayError::new(
                        502,
                        "Upstream response completed with no translated semantic output.",
                        Some("empty_upstream_completion"),
                    )
                    .with_type("server_error"));
                }
                self.usage = usage(&s::get(&response, "usage"));
                result.push(self.chunk(
                    s::object(vec![]),
                    s::text(if self.calls.is_empty() {
                        "stop"
                    } else {
                        "tool_calls"
                    }),
                ));
                if s::boolean(&s::path(
                    &self.plan.request,
                    &["stream_options", "include_usage"],
                )) == Some(true)
                {
                    let usage = self
                        .usage
                        .as_ref()
                        .and_then(crate::usage::responses_to_chat);
                    result.push(ProviderEvent::chat_source(s::object(vec![
                        ("id", s::text(&self.plan.response_id)),
                        ("object", s::text("chat.completion.chunk")),
                        ("created", s::generated(&self.plan.created_at)),
                        ("model", s::quoted(self.plan.model.as_js_string())),
                        ("choices", s::array(&[])),
                        ("usage", s::generated(&usage)),
                    ])));
                }
                result.push(ProviderEvent::chat(serde_json::json!("[DONE]")));
                self.finished = true;
            }
            "response.failed" | "response.incomplete" | "error" => {
                result.push(ProviderEvent::chat(serde_json::json!({"error":{"message":"Upstream stream ended without response.completed.","type":"server_error","code":"upstream_stream_error","param":null}})));
                self.finished = true;
            }
            _ => (),
        }
        Ok(result)
    }
}
