//! Source-bearing buffered output composition; scalar upstream fragments are not reparsed.
use crate::{source as s, types::*};
use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, source_serialization as json,
};
use std::collections::BTreeMap;
pub(crate) fn to_chat(payload: &SourceJson, plan: &DecodePlan) -> Result<SourceJson, GatewayError> {
    if !s::is(&s::get(payload, "status"), "completed") {
        return Err(malformed(
            "Upstream stream ended without response.completed.",
        ));
    }
    let mut texts = vec![];
    let mut refusals = vec![];
    let mut calls = vec![];
    for item in json::array(&s::get(payload, "output")).unwrap_or_default() {
        if s::is(&s::get(&item, "type"), "message") {
            for part in json::array(&s::get(&item, "content")).unwrap_or_default() {
                if let Some(value) = s::string(&s::get(&part, "text")) {
                    texts.push(value);
                }
                if let Some(value) = s::string(&s::get(&part, "refusal")) {
                    refusals.push(value);
                }
            }
        } else if s::is(&s::get(&item, "type"), "function_call") {
            let id = s::get(&item, "call_id");
            s::string(&id).ok_or_else(|| malformed("Upstream function call has no call_id."))?;
            let name = s::get(&item, "name");
            s::nonempty(&name).ok_or_else(|| malformed("Upstream function call has no name."))?;
            let arguments = s::get(&item, "arguments");
            s::string(&arguments)
                .ok_or_else(|| malformed("Upstream function call arguments are invalid."))?;
            calls.push(s::object(vec![
                ("id", id),
                ("type", s::text("function")),
                (
                    "function",
                    s::object(vec![("name", name), ("arguments", arguments)]),
                ),
            ]));
        }
    }
    let text = s::join(&texts, "");
    let refusal = s::join(&refusals, "");
    if text.as_units().is_empty() && refusal.as_units().is_empty() && calls.is_empty() {
        return Err(GatewayError::new(
            502,
            "Upstream response completed with no translated semantic output.",
            Some("empty_upstream_completion"),
        )
        .with_type("server_error"));
    }
    let mut result = completion(plan, text, refusal, calls);
    if let Some(id) = s::present(payload, "id") {
        s::set(&mut result, "id", id);
    }
    if let Some(created) = s::present(payload, "created_at") {
        s::set(&mut result, "created", created);
    }
    if let Some(usage) = crate::source_collector::usage(&s::get(payload, "usage"))
        .as_ref()
        .and_then(crate::usage::responses_to_chat)
    {
        s::set(&mut result, "usage", s::generated(&usage));
    }
    Ok(result)
}
fn completion(
    plan: &DecodePlan,
    text: JsString16,
    refusal: JsString16,
    calls: Vec<SourceJson>,
) -> SourceJson {
    let mut message = s::object(vec![
        ("role", s::text("assistant")),
        (
            "content",
            if text.as_units().is_empty() && (!calls.is_empty() || !refusal.as_units().is_empty()) {
                s::null()
            } else {
                s::quoted(&text)
            },
        ),
    ]);
    if !refusal.as_units().is_empty() {
        s::set(&mut message, "refusal", s::quoted(&refusal));
    }
    let finish = if calls.is_empty() {
        "stop"
    } else {
        "tool_calls"
    };
    if !calls.is_empty() {
        s::set(&mut message, "tool_calls", s::array(&calls));
    }
    s::object(vec![
        ("id", s::text(&plan.response_id)),
        ("object", s::text("chat.completion")),
        ("created", s::generated(&plan.created_at)),
        ("model", s::quoted(plan.model.as_js_string())),
        (
            "choices",
            s::array(&[s::object(vec![
                ("index", s::generated(&0)),
                ("message", message),
                ("finish_reason", s::text(finish)),
            ])]),
        ),
    ])
}
pub(crate) fn collect(
    events: &[ProviderEvent],
    plan: &DecodePlan,
) -> Result<SourceJson, GatewayError> {
    let mut texts = vec![];
    let mut refusals = vec![];
    let mut calls: BTreeMap<usize, SourceJson> = BTreeMap::new();
    let mut usage = None;
    let mut complete = false;
    for event in events {
        if event.is_done() {
            complete = true;
            continue;
        }
        if event.field("error").is_some() {
            return Err(malformed(
                "Upstream stream ended without response.completed.",
            ));
        }
        if let Some(value) = event.field("usage") {
            usage = Some(value);
        }
        for choice in json::array(&s::get(&event.data, "choices")).unwrap_or_default() {
            let delta = s::get(&choice, "delta");
            if let Some(text) = s::string(&s::get(&delta, "content")) {
                texts.push(text);
            }
            if let Some(text) = s::string(&s::get(&delta, "refusal")) {
                refusals.push(text);
            }
            for call in json::array(&s::get(&delta, "tool_calls")).unwrap_or_default() {
                let index = json::number(&s::get(&call, "index")).unwrap_or(0.0) as usize;
                let row=calls.entry(index).or_insert_with(||s::generated(&serde_json::json!({"id":"","type":"function","function":{"name":"","arguments":""}})));
                if let Some(id) = s::present(&call, "id") {
                    s::set(row, "id", id);
                }
                let mut function = s::get(row, "function");
                let source = s::get(&call, "function");
                if let Some(name) = s::present(&source, "name") {
                    s::set(&mut function, "name", name);
                }
                if let Some(args) = s::string(&s::get(&source, "arguments")) {
                    let previous = s::string(&s::get(&function, "arguments")).unwrap_or_default();
                    s::set(
                        &mut function,
                        "arguments",
                        s::quoted(&s::concat(&[&previous, &args])),
                    );
                }
                s::set(row, "function", function);
            }
        }
    }
    if !complete {
        return Err(malformed("Upstream Chat stream ended without sentinel."));
    }
    let mut result = completion(
        plan,
        s::join(&texts, ""),
        s::join(&refusals, ""),
        calls.into_values().collect(),
    );
    if let Some(usage) = usage {
        s::set(&mut result, "usage", usage);
    }
    Ok(result)
}
