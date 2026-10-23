//! Raw terminal fields share the core source parser; unrelated UTF16 remains untouched.
use gateway_authority::cache_experiment::{
    ReadSample, Sample, Usage,
    model::{Reason, STEPS},
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_json::SourceJson,
    source_usage::{UsageStatus, extract_source_usage_tokens},
};
pub(super) fn member(value: &SourceJson, name: &str) -> Result<Option<SourceJson>, GatewayError> {
    let mut found = None;
    for (key, value) in value.object_entries()? {
        if key.as_units().iter().copied().eq(name.encode_utf16()) {
            found = Some(value);
        }
    }
    Ok(found)
}
pub(super) fn string(value: &SourceJson) -> Option<String> {
    JsString16::from_json_token(value.as_raw())
        .ok()?
        .try_utf8()
        .ok()
}
/// Unknown event names may contain unpaired UTF16. The source ignores those
/// events; failure to convert an unrelated name is not a malformed stream.
pub(super) fn event_type(event: &SourceJson) -> Result<Option<String>, GatewayError> {
    let kind = member(event, "type")?
        .as_ref()
        .and_then(|value| JsString16::from_json_token(value.as_raw()).ok())
        .filter(|value| {
            value.as_units().iter().any(|&unit| {
                char::from_u32(u32::from(unit))
                    .is_none_or(|character| !gateway_schema::util::js_whitespace(character))
            })
        })
        .ok_or_else(|| gateway_authority::cache_experiment::model::failed(
            "Prompt-cache scope experiment stream failed: Upstream emitted a Responses SSE event without a type."
        ))?;
    Ok(kind
        .try_utf8()
        .ok()
        .map(|value| gateway_schema::util::js_trim(&value).to_owned()))
}
pub(super) fn completed(
    response: &SourceJson,
    slot: u8,
    model: &str,
    index: usize,
    elapsed: u64,
) -> Result<ReadSample, GatewayError> {
    let inconclusive = |reason| ReadSample {
        value: Err(reason),
        completed: true,
    };
    let actual = member(response, "model")?.as_ref().and_then(string);
    if actual.as_deref().map(gateway_schema::util::js_trim) != Some(model) {
        return Ok(inconclusive(Reason::EffectiveModelDrift));
    }
    let raw = member(response, "usage")?;
    let Some(tokens) = extract_source_usage_tokens(raw.as_ref())? else {
        return Ok(inconclusive(Reason::IncompleteTelemetry));
    };
    if tokens.status != UsageStatus::Reported || !tokens.cache_write_tokens_present() {
        return Ok(inconclusive(Reason::IncompleteTelemetry));
    }
    let (
        Some(input_tokens),
        Some(cached_tokens),
        Some(cache_write_tokens),
        Some(output_tokens),
        Some(total_tokens),
    ) = (
        tokens.input_tokens,
        tokens.cached_input_tokens,
        tokens.cache_write_input_tokens,
        tokens.output_tokens,
        tokens.total_tokens,
    )
    else {
        return Ok(inconclusive(Reason::IncompleteTelemetry));
    };
    // The shared engine retains the five measured source numbers verbatim. Its
    // reported result proves the raw/normalized tuple equality, without defaults.
    let usage = Usage {
        input_tokens,
        cached_tokens,
        cache_write_tokens,
        output_tokens,
        total_tokens,
    };
    if !(2_000..=4_000).contains(&input_tokens) {
        return Ok(inconclusive(Reason::InvalidInputSize));
    }
    if usage.signal().is_none() {
        return Ok(inconclusive(Reason::InvalidCacheSignal));
    }
    let step = STEPS.get(index).ok_or_else(|| {
        GatewayError::unavailable(
            "Prompt-cache scope experiment sample index is invalid.",
            "prompt_cache_scope_experiment_failed",
        )
    })?;
    Ok(ReadSample {
        value: Ok(Sample {
            step: (*step).into(),
            slot,
            raw_usage: usage.clone(),
            usage,
            elapsed_ms: elapsed,
        }),
        completed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use gateway_authority::cache_experiment::model::Signal;
    use serde_json::{Value, json};

    #[test]
    fn terminal_samples_match_the_actual_source_reader_without_counter_defaults() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../gateway-worker/src/cache_experiment_host/terminal-source-v1.json"
        ))
        .unwrap();
        for case in fixture["terminal_cases"].as_array().unwrap() {
            let source = SourceJson::parse(case["response"].as_str().unwrap()).unwrap();
            let result = completed(&source, 1, "fixture-model", 0, 0).unwrap();
            assert!(result.completed, "{}", case["name"]);
            let actual = match result.value {
                Ok(sample) => json!({
                    "status": "sample",
                    "signal": match sample.usage.signal().unwrap() { Signal::Read => "read", Signal::Write => "write" },
                    "sample": { "slot": sample.slot, "raw_usage": sample.raw_usage, "usage": sample.usage }
                }),
                Err(reason) => json!({ "status": "inconclusive", "reason": reason }),
            };
            assert_eq!(actual, case["expected"], "{}", case["name"]);
        }
    }

    #[test]
    fn unknown_utf16_event_names_follow_the_actual_source_stream_parser() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../gateway-worker/src/cache_experiment_host/event-types-source-v1.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let event = SourceJson::parse(case["raw"].as_str().unwrap()).unwrap();
            let actual = match event_type(&event) {
                Ok(kind) => json!({
                    "status": "parsed",
                    "kind": match kind.as_deref() {
                        Some("response.completed") => "completed",
                        Some("error" | "response.failed" | "response.incomplete") => "terminal",
                        _ => "other",
                    }
                }),
                Err(_) => json!({"status": "error"}),
            };
            assert_eq!(actual, case["expected"], "{}", case["name"]);
        }
    }
}
