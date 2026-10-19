//! One source-aware selected-model cache capability policy; payloads never enter scalar Value.
use super::{SourceRequestError, value::Value as View};
use crate::prompt_cache::CODEX_PROVIDER;
use gateway_core::{js_string::JsString16, source_json::SourceJson};
fn refusal(model: &JsString16, prefix: &str, param: &str) -> SourceRequestError {
    let mut units = prefix.encode_utf16().collect::<Vec<_>>();
    units.extend_from_slice(model.as_units());
    units.extend("'.".encode_utf16());
    SourceRequestError::invalid(
        JsString16::from_units(units),
        Some(JsString16::from_utf8(param)),
    )
}
fn breakpoints(raw: &View, input_key: &str) -> Vec<(String, Option<JsString16>)> {
    let mut found = Vec::new();
    let Some(items) = raw.get(input_key).and_then(View::as_array) else {
        return found;
    };
    fn collect(value: &View, param: String, found: &mut Vec<(String, Option<JsString16>)>) {
        if value
            .pointer("/prompt_cache_breakpoint/mode")
            .and_then(View::as_str)
            == Some("explicit")
        {
            found.push((
                param,
                value
                    .get("type")
                    .and_then(View::as_text)
                    .map(|text| text.core()),
            ));
        }
    }
    for (i, item) in items.iter().enumerate() {
        let param = format!("{input_key}[{i}]");
        if input_key == "input" {
            collect(item, format!("{param}.prompt_cache_breakpoint"), &mut found);
        }
        for key in ["content", "output"] {
            if key == "output"
                && (input_key != "input"
                    || item.get("type").and_then(View::as_str) != Some("function_call_output"))
            {
                continue;
            }
            if let Some(parts) = item.get(key).and_then(View::as_array) {
                for (j, part) in parts.iter().enumerate() {
                    collect(
                        part,
                        format!("{param}.{key}[{j}].prompt_cache_breakpoint"),
                        &mut found,
                    );
                }
            }
        }
    }
    found
}
fn contains_breakpoint(value: &View) -> bool {
    let content = value.get("content").and_then(View::as_array);
    let output = if value.get("type").and_then(View::as_str) == Some("function_call_output") {
        value.get("output").and_then(View::as_array)
    } else {
        None
    };
    content.into_iter().chain(output).flatten().any(|v| {
        v.pointer("/prompt_cache_breakpoint/mode")
            .and_then(View::as_str)
            == Some("explicit")
    })
}
pub fn validate_known_unsupported_prompt_cache(
    model: &JsString16,
    prompt_cache: Option<&SourceJson>,
    raw: &SourceJson,
    normalized_input: &[SourceJson],
    input_key: &str,
) -> Result<(), SourceRequestError> {
    let prompt_cache = prompt_cache.map(|value| View::from_source(value.clone()));
    let body = View::from_source(raw.clone());
    let input = normalized_input
        .iter()
        .cloned()
        .map(View::from_source)
        .collect::<Vec<_>>();
    let markers = if input.iter().any(contains_breakpoint) {
        breakpoints(&body, input_key)
    } else {
        Vec::new()
    };
    let unsupported = |param: &str| {
        refusal(
            model,
            &format!("Prompt cache control '{param}' is not supported for model '"),
            param,
        )
    };
    if prompt_cache.as_ref() == Some(&View::Bool(false)) {
        let param = [
            "prompt_cache_key",
            "prompt_cache_options",
            "prompt_cache_retention",
        ]
        .iter()
        .find(|k| body.get(k).is_some())
        .map(|s| (*s).to_owned())
        .or_else(|| markers.first().map(|(p, _)| p.clone()));
        if let Some(param) = param {
            return Err(refusal(
                model,
                "Prompt caching is not supported for model '",
                &param,
            ));
        }
        return Ok(());
    }
    let capabilities = super::cache_metadata::normalize_capabilities(prompt_cache.as_ref());
    let Some(controls) = capabilities
        .as_ref()
        .and_then(|v| v.get("providers"))
        .and_then(View::as_array)
        .and_then(|ps| {
            ps.iter()
                .find(|p| p.get("id").and_then(View::as_str) == Some(CODEX_PROVIDER))
        })
        .and_then(|p| p.get("controls"))
    else {
        return Ok(());
    };
    let mode_unsupported = |mode: &str| {
        controls
            .get("modes")
            .and_then(View::as_array)
            .is_some_and(|m| !m.iter().any(|v| v.as_str() == Some(mode)))
    };
    if body.get("prompt_cache_key").is_some() && controls.get("key") == Some(&View::Bool(false)) {
        return Err(unsupported("prompt_cache_key"));
    }
    let options = body.get("prompt_cache_options").filter(|v| v.is_object());
    let requested = options.map(|o| {
        if o.get("mode").and_then(View::as_str) == Some("explicit") {
            ("explicit", "prompt_cache_options.mode")
        } else {
            (
                "implicit",
                if o.get("mode").is_some() {
                    "prompt_cache_options.mode"
                } else {
                    "prompt_cache_options"
                },
            )
        }
    });
    if let Some(("implicit", param)) = requested
        && (controls.get("implicit") == Some(&View::Bool(false)) || mode_unsupported("implicit"))
    {
        return Err(unsupported(param));
    }
    for (raw, allowed, param) in [
        (
            options.and_then(|o| o.get("ttl")),
            controls.get("ttls"),
            "prompt_cache_options.ttl",
        ),
        (
            body.get("prompt_cache_retention"),
            controls.get("legacy_retentions"),
            "prompt_cache_retention",
        ),
    ] {
        if let (Some(value), Some(allowed)) = (
            raw.and_then(View::as_text),
            allowed.and_then(View::as_array),
        ) && !allowed.iter().any(|v| {
            v.as_str().is_some_and(|text| {
                value
                    .core()
                    .as_units()
                    .iter()
                    .copied()
                    .eq(text.encode_utf16())
            })
        }) {
            return Err(unsupported(param));
        }
    }
    for (param, kind) in markers {
        if controls.get("explicit_breakpoints") == Some(&View::Bool(false))
            || mode_unsupported("explicit")
        {
            return Err(unsupported(&param));
        }
        let endpoint = if input_key == "input" {
            "responses"
        } else {
            "chat_completions"
        };
        if let Some(allowed) = controls
            .get("breakpoint_block_types")
            .and_then(|v| v.get(endpoint))
            .and_then(View::as_array)
            && !kind.is_some_and(|k| {
                allowed.iter().any(|v| {
                    v.as_str()
                        .is_some_and(|text| k.as_units().iter().copied().eq(text.encode_utf16()))
                })
            })
        {
            return Err(unsupported(&param));
        }
    }
    if let Some(("explicit", param)) = requested
        && (controls.get("explicit_breakpoints") == Some(&View::Bool(false))
            || mode_unsupported("explicit"))
    {
        return Err(unsupported(param));
    }
    Ok(())
}
