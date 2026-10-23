//! Explicit source records: only these declared text fields may use ProfileV2 strings.
use crate::{ledger::ErrorObservation, store, types::ObservabilityHost};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_control::{
        decode_source_control_record, encode_source_control_record, source_json_tree,
    },
    source_json::SourceJson,
    state::{RecordKey, RecordMutation, StoredRecord},
};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) fn trim(value: &JsString16) -> JsString16 {
    let whitespace = |v: &u16| char::from_u32(u32::from(*v)).is_some_and(store::js_whitespace);
    let units = value.as_units();
    let start = units
        .iter()
        .position(|v| !whitespace(v))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|v| !whitespace(v))
        .map_or(start, |i| i + 1);
    JsString16::from_units(units[start..end].to_vec())
}
pub fn bounded_text(
    value: Option<&JsString16>,
    maximum: usize,
    fallback: &JsString16,
) -> JsString16 {
    let value = value
        .map(trim)
        .filter(|v| !v.as_units().is_empty())
        .unwrap_or_else(|| fallback.clone());
    value.prefix_units(maximum)
}
fn uppercase(value: JsString16) -> JsString16 {
    let mut out = Vec::new();
    for ch in char::decode_utf16(value.as_units().iter().copied()) {
        match ch {
            Ok(ch) => {
                for upper in ch.to_uppercase() {
                    let mut buffer = [0; 2];
                    out.extend_from_slice(upper.encode_utf16(&mut buffer));
                }
            }
            Err(error) => out.push(error.unpaired_surrogate()),
        }
    }
    JsString16::from_units(out)
}
fn fields(value: &SourceJson) -> Result<Option<BTreeMap<String, SourceJson>>, GatewayError> {
    let value = SourceJson::parse(
        value
            .as_str()
            .trim_matches(|c| matches!(c, ' ' | '\t' | '\r' | '\n')),
    )?;
    if value.as_str().starts_with('[') {
        return Ok(Some(BTreeMap::new()));
    }
    if !value.as_str().starts_with('{') {
        return Ok(None);
    }
    let mut fields = BTreeMap::new();
    for (key, value) in value.object_entries()? {
        if let Ok(key) = key.try_utf8() {
            fields.insert(key, value);
        }
    }
    Ok(Some(fields))
}
pub(crate) fn number(value: Option<&SourceJson>, fallback: f64) -> f64 {
    value
        .and_then(|v| v.deserialize::<f64>().ok())
        .filter(|n| n.is_finite())
        .map_or(fallback, f64::trunc)
}
fn optional_number(value: Option<&SourceJson>) -> Option<f64> {
    let n = number(value, -1.0);
    (n >= 0.0).then_some(n)
}
fn text(
    values: &BTreeMap<String, SourceJson>,
    name: &str,
    max: usize,
    fallback: &str,
) -> JsString16 {
    let value = values
        .get(name)
        .and_then(|v| v.deserialize::<JsString16>().ok());
    bounded_text(value.as_ref(), max, &JsString16::from_utf8(fallback))
}
fn optional_text(values: &BTreeMap<String, SourceJson>, name: &str) -> Option<JsString16> {
    let v = text(values, name, 120, "");
    (!v.as_units().is_empty()).then_some(v)
}

#[derive(Clone, Debug, Serialize)]
pub struct RequestLogRecord {
    pub id: JsString16,
    pub key_id: JsString16,
    pub route: JsString16,
    pub path: JsString16,
    pub method: JsString16,
    pub status_code: f64,
    pub stream: bool,
    pub model: Option<JsString16>,
    pub reasoning: Option<JsString16>,
    pub created_at_ms: f64,
    pub provider: String,
    pub fallback_reason: Option<JsString16>,
    pub provider_request_id: Option<JsString16>,
    pub billing_status: String,
    pub completed_at_ms: Option<f64>,
    pub latency_ms: Option<f64>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub provider_quota: Option<f64>,
    pub quota_per_credit: Option<f64>,
    pub spend_microcredits: Option<f64>,
    pub paid_fallback_window_reset_at_ms: Option<f64>,
}
impl RequestLogRecord {
    pub fn normalize(
        value: &SourceJson,
        key_id: &str,
        request_id: &JsString16,
        created: f64,
    ) -> Result<Option<Self>, GatewayError> {
        let Some(v) = fields(value)? else {
            return Ok(None);
        };
        let provider = v
            .get("provider")
            .and_then(|v| v.deserialize::<String>().ok())
            .filter(|v| {
                matches!(
                    v.as_str(),
                    "cerebras"
                        | "deepseek"
                        | "lithos"
                        | "openrouter"
                        | "voyage"
                        | "surplus"
                        | "metered"
                )
            })
            .unwrap_or_else(|| "chatgpt_codex".into());
        let billing = v
            .get("billing_status")
            .and_then(|v| v.deserialize::<String>().ok())
            .filter(|v| {
                matches!(
                    v.as_str(),
                    "pending" | "reconciled" | "not_billed" | "unresolved"
                )
            })
            .unwrap_or_else(|| "not_applicable".into());
        Ok(Some(Self {
            id: {
                let id = v.get("id").and_then(|v| v.deserialize::<JsString16>().ok());
                bounded_text(id.as_ref(), 120, request_id)
            },
            key_id: text(&v, "key_id", 200, key_id),
            route: text(&v, "route", 120, "unknown"),
            path: text(&v, "path", 1024, ""),
            method: uppercase(text(&v, "method", 16, "UNKNOWN")),
            status_code: {
                let n = number(v.get("status_code"), 0.0);
                if n <= 0.0 { 0.0 } else { n.min(599.0) }
            },
            stream: v.get("stream").and_then(|v| v.deserialize::<bool>().ok()) == Some(true),
            model: optional_text(&v, "model"),
            reasoning: optional_text(&v, "reasoning"),
            created_at_ms: number(v.get("created_at_ms"), created),
            provider,
            fallback_reason: optional_text(&v, "fallback_reason"),
            provider_request_id: optional_text(&v, "provider_request_id"),
            billing_status: billing,
            completed_at_ms: optional_number(v.get("completed_at_ms")),
            latency_ms: optional_number(v.get("latency_ms")),
            input_tokens: optional_number(v.get("input_tokens")),
            output_tokens: optional_number(v.get("output_tokens")),
            provider_quota: optional_number(v.get("provider_quota")),
            quota_per_credit: optional_number(v.get("quota_per_credit")),
            spend_microcredits: optional_number(v.get("spend_microcredits")),
            paid_fallback_window_reset_at_ms: optional_number(
                v.get("paid_fallback_window_reset_at_ms"),
            ),
        }))
    }
    pub fn source_json(&self) -> Result<SourceJson, GatewayError> {
        SourceJson::from_serializable(self)
    }
}
/// This accessor belongs only to the request/error record schema, never arbitrary history or quota.
pub fn record_source_json(row: &StoredRecord) -> Result<SourceJson, GatewayError> {
    decode_source_control_record(row)
}

pub fn merge_request_fields(
    existing: Option<&RequestLogRecord>,
    patch: &Value,
    key_id: &str,
    request_id: &JsString16,
    created: f64,
) -> Result<RequestLogRecord, GatewayError> {
    merge_request_fields_source(
        existing,
        &SourceJson::from_serializable(patch)?,
        key_id,
        request_id,
        created,
    )
}
pub fn merge_request_fields_source(
    existing: Option<&RequestLogRecord>,
    patch: &SourceJson,
    key_id: &str,
    request_id: &JsString16,
    created: f64,
) -> Result<RequestLogRecord, GatewayError> {
    let mut values = match existing {
        Some(v) => fields(&v.source_json()?)?.expect("typed request object"),
        None => BTreeMap::new(),
    };
    if let Some(patch) = fields(patch)? {
        values.extend(patch);
    }
    values.insert("id".into(), SourceJson::from_serializable(request_id)?);
    values.insert("key_id".into(), SourceJson::from_serializable(key_id)?);
    values.insert(
        "created_at_ms".into(),
        SourceJson::from_serializable(&created)?,
    );
    RequestLogRecord::normalize(
        &SourceJson::from_serializable(&values)?,
        key_id,
        request_id,
        created,
    )?
    .ok_or_else(|| store::error("Invalid typed request record"))
}
pub fn put_record<H: ObservabilityHost>(
    host: &H,
    key: RecordKey,
    document: &SourceJson,
    expiry: i64,
) -> Result<RecordMutation, GatewayError> {
    // Preserve the existing request/error family's lossless scalar-number shape.
    // This is the retained observation row, never a request transcript shadow.
    let document = source_json_tree(document)?
        .to_json_lossless()
        .map(|value| SourceJson::from_serializable(&value))
        .transpose()?
        .unwrap_or_else(|| document.clone());
    let record = encode_source_control_record(store::uuid(host)?, &document, Some(expiry))?;
    Ok(RecordMutation::Put { key, record })
}

pub fn error_document(input: &ErrorObservation) -> Result<SourceJson, GatewayError> {
    #[derive(Serialize)]
    struct ErrorRecord<'a> {
        request_id: &'a str,
        route: &'a str,
        status: u16,
        provider: &'a str,
        model: &'a Option<JsString16>,
        reasoning: &'a Option<JsString16>,
        stream: Option<bool>,
        terminal_type: JsString16,
        failure_kind: JsString16,
        delivery_outcome: gateway_core::lifecycle::DeliveryOutcome,
        created_at_ms: i64,
        latency_ms: i64,
        git_sha: &'a Option<String>,
        deno_revision: &'a Option<String>,
        version: u8,
    }
    let terminal = input.terminal_type.as_deref().map(JsString16::from_utf8);
    let terminal = bounded_text(
        terminal.as_ref(),
        160,
        &JsString16::from_utf8(if input.status >= 400 {
            "http.error"
        } else {
            "error"
        }),
    );
    let fallback = if input.status >= 400 {
        JsString16::from_utf8(&format!("http_{}", input.status))
    } else {
        terminal.clone()
    };
    let failure = input.failure_kind.as_deref().map(JsString16::from_utf8);
    let failure = bounded_text(failure.as_ref(), 160, &fallback);
    SourceJson::from_serializable(&ErrorRecord {
        request_id: &input.request_id,
        route: &input.route,
        status: input.status,
        provider: &input.provider,
        model: &input.model,
        reasoning: &input.reasoning,
        stream: input.stream,
        terminal_type: terminal,
        failure_kind: failure,
        delivery_outcome: input.delivery_outcome,
        created_at_ms: input.created_at_ms,
        latency_ms: input.latency_ms,
        git_sha: &input.git_sha,
        deno_revision: &input.deno_revision,
        version: 1,
    })
}

/// Complete source v1 error-log shape validation; preserve original extra fields.
/// This named reader grants neither key custody nor a live operation.
pub fn admin_error_record_source(row: &StoredRecord) -> Result<SourceJson, GatewayError> {
    let document = record_source_json(row)?;
    let object = crate::replay_values::SourceObject::parse(&document)?;
    let field = |name: &str| {
        object
            .get(name)
            .ok_or_else(|| store::error("Incomplete admin error record"))
    };
    if field("version")?.deserialize::<f64>()? != 1.0 {
        return Err(store::error("Invalid admin error version"));
    }
    for name in [
        "request_id",
        "route",
        "provider",
        "terminal_type",
        "failure_kind",
    ] {
        field(name)?.deserialize::<JsString16>()?;
    }
    for name in ["model", "reasoning", "git_sha", "deno_revision"] {
        field(name)?.deserialize::<Option<JsString16>>()?;
    }
    for name in ["status", "created_at_ms", "latency_ms"] {
        field(name)?.deserialize::<f64>()?;
    }
    field("stream")?.deserialize::<Option<bool>>()?;
    field("delivery_outcome")?.deserialize::<gateway_core::lifecycle::DeliveryOutcome>()?;
    Ok(document)
}

/// Exact source isPaidFallbackUsageRollup predicate over real UTF16 strings.
/// Data validation only; model/provider membership and accounting authority are external.
pub fn valid_usage_rollup_source(document: &SourceJson) -> bool {
    let field = |name| gateway_core::source_serialization::member(document, name);
    let number = |name| field(name).and_then(|value| value.deserialize::<f64>().ok());
    number("v") == Some(1.0)
        && ["model", "provider"].iter().all(|name| {
            field(name)
                .and_then(|value| value.deserialize::<JsString16>().ok())
                .is_some_and(|value| !value.as_units().is_empty())
        })
        && [
            "bucket_start_at_ms",
            "request_count",
            "input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "first_request_at_ms",
            "last_request_at_ms",
            "updated_at_ms",
        ]
        .iter()
        .all(|name| {
            number(name).is_some_and(|value| {
                value.is_finite()
                    && value.fract() == 0.0
                    && value >= 0.0
                    && value <= gateway_core::identity::MAX_SAFE_INTEGER as f64
            })
        })
        && ["quota_sum", "spend_microcredits"]
            .iter()
            .all(|name| number(name).is_some_and(|value| value.is_finite() && value >= 0.0))
}
/// Named rollup family reader; no mutation, expiry renewal or permission is inferred.
pub fn usage_rollup_record_source(row: &StoredRecord) -> Result<SourceJson, GatewayError> {
    let document = decode_source_control_record(row)?;
    if !valid_usage_rollup_source(&document) {
        return Err(store::error("Invalid source usage rollup"));
    }
    Ok(document)
}
