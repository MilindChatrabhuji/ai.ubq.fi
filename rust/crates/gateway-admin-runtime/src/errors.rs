use crate::{
    AdminRuntime,
    capabilities::{Context, RuntimeCapabilities},
    parse, store,
};
use gateway_admin::AdminInput;
use gateway_auth::{AuthHost, AuthResponse, invalid};
use gateway_core::{
    GatewayError,
    query::QueryStore,
    state::StoredRecord,
    value::{PortableValue, ValueEncoding},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const LEGACY_INTERRUPTED: [&str; 15] = [
    "4d2928f47f3ba3ad66b8c15e6323bcccd0a39390",
    "0d795e28e42be63bbd7f0d4ce44d8ea0f6ab9d4a",
    "149ef399a52373ba09d75cfd00d5e5139564dcdf",
    "8532ec7ee1fc5a6a9bb44fe2a3703527b8d78952",
    "35fb0782c01309a85ea08f5a6a48f8de62a1f29f",
    "c18a4e091c09c7a9e04588a8fe745c696deaf6d2",
    "214957fe322c8cff6ad20ddea55dcf9576273107",
    "50c06cd8e93fe3b34a9699d31f1f8998f632fbe6",
    "64f4ba5a21e476386f95c8474bd76b037e6afc4f",
    "7fb508a076e9edf04c6e4087a19ad6e25452dc6b",
    "c9bcf7d5937cf137bc34d8656187d3f20e9f8b4d",
    "9d3b7d0eb8a1c57079d298b17d50d25f74dd39d9",
    "542df9ef4560ca9c090925a5a1b24a141a584867",
    "ce37210d58746a2ed3aec34c38b370f7060639e1",
    "f9dec6c3b6270813be7b4a957221f7130c37a52b",
];
fn member<'a>(value: &'a PortableValue, name: &str) -> Option<&'a PortableValue> {
    match value {
        PortableValue::Object(fields) => fields
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value),
        PortableValue::ObjectUtf16(fields) => fields
            .iter()
            .rev()
            .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
            .map(|(_, value)| value),
        _ => None,
    }
}
fn text(value: Option<&PortableValue>) -> bool {
    matches!(
        value,
        Some(PortableValue::String(_) | PortableValue::StringUtf16(_))
    )
}
fn text_is(value: Option<&PortableValue>, expected: &str) -> bool {
    match value {
        Some(PortableValue::String(value)) => value == expected,
        Some(PortableValue::StringUtf16(value)) => {
            value.as_units().iter().copied().eq(expected.encode_utf16())
        }
        _ => false,
    }
}
fn number(value: Option<&PortableValue>) -> Option<f64> {
    value?.number_value()
}
fn nullable_string(value: Option<&PortableValue>) -> bool {
    matches!(value, Some(PortableValue::Null)) || text(value)
}
fn valid(value: &PortableValue) -> bool {
    number(member(value, "version")) == Some(1.0)
        && [
            "request_id",
            "route",
            "provider",
            "terminal_type",
            "failure_kind",
        ]
        .into_iter()
        .all(|name| text(member(value, name)))
        && ["status", "created_at_ms", "latency_ms"]
            .into_iter()
            .all(|name| number(member(value, name)).is_some())
        && ["model", "reasoning", "git_sha", "deno_revision"]
            .into_iter()
            .all(|name| nullable_string(member(value, name)))
        && matches!(
            member(value, "stream"),
            Some(PortableValue::Null | PortableValue::Boolean(_))
        )
        && ["delivered", "interrupted", "unobserved"]
            .into_iter()
            .any(|outcome| text_is(member(value, "delivery_outcome"), outcome))
}
fn suppress(value: &PortableValue) -> bool {
    number(member(value, "status")) == Some(200.0)
        && member(value, "stream") == Some(&PortableValue::Boolean(true))
        && text_is(member(value, "terminal_type"), "error")
        && text_is(member(value, "failure_kind"), "missing_sse_terminal")
        && text_is(member(value, "delivery_outcome"), "interrupted")
        && LEGACY_INTERRUPTED
            .iter()
            .any(|sha| text_is(member(value, "git_sha"), sha))
}
fn error_row(record: &StoredRecord) -> Result<PortableValue, GatewayError> {
    record.validate_version()?;
    match record.value_encoding {
        ValueEncoding::Json => Ok(PortableValue::from_json(record.json_value()?)),
        ValueEncoding::ProfileV2 => record.profile_v2_value(),
        ValueEncoding::ProfileV1 | ValueEncoding::SourceGraphV1 => Err(GatewayError::unavailable(
            "Error history requires JSON or explicit ProfileV2",
            "incompatible_value_encoding",
        )),
    }
}
// This is the fixed error-log JSON wire projection only. JSON.stringify maps
// nonfinite numbers to null and signed zero to zero; UTF16 strings stay strings.
// Other typed payloads never acquire a generic JSON interpretation here.
fn wire_value(value: &PortableValue) -> Result<PortableValue, GatewayError> {
    Ok(match value {
        PortableValue::Null
        | PortableValue::Boolean(_)
        | PortableValue::String(_)
        | PortableValue::StringUtf16(_) => value.clone(),
        PortableValue::NumberBits(_) => match value.number_value() {
            Some(value) if value.is_finite() => {
                PortableValue::number(if value == 0.0 { 0.0 } else { value })
            }
            _ => PortableValue::Null,
        },
        PortableValue::Array(values) => {
            PortableValue::Array(values.iter().map(wire_value).collect::<Result<_, _>>()?)
        }
        PortableValue::Object(values) => PortableValue::Object(
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), wire_value(value)?)))
                .collect::<Result<_, GatewayError>>()?,
        ),
        PortableValue::ObjectUtf16(values) => PortableValue::ObjectUtf16(
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), wire_value(value)?)))
                .collect::<Result<_, GatewayError>>()?,
        ),
        _ => {
            return Err(GatewayError::unavailable(
                "Error history ProfileV2 contains a non-JSON field",
                "incompatible_value_encoding",
            ));
        }
    })
}
impl<S: QueryStore, H: AuthHost, C: RuntimeCapabilities> AdminRuntime<'_, S, H, C> {
    pub(crate) async fn errors(&self, input: &AdminInput) -> Result<AuthResponse, GatewayError> {
        let limit = match parse::first(&input.query, "limit") {
            None => 100,
            Some(s) => {
                let n = gateway_admin_data::profile::js_number(&Value::String(s.into()));
                if !n.is_finite() || n.fract() != 0.0 || !(1.0..=500.0).contains(&n) {
                    return Err(invalid("limit must be an integer from 1 to 500"));
                }
                n as usize
            }
        };
        let mut data = Vec::new();
        let mut buckets = BTreeMap::<i64, u64>::new();
        store::visit(
            self.store,
            store::key(json!(["uos_ai", "admin_error_log", "v1"])),
            true,
            input.now_ms,
            |entry| {
                let row = error_row(&entry.record)?;
                if !valid(&row) {
                    return Ok(());
                }
                if number(member(&row, "status")).is_some_and(|s| (500.0..=599.0).contains(&s)) {
                    let time = number(member(&row, "created_at_ms"))
                        .ok_or_else(|| store::corrupt("Error history timestamp is missing"))?;
                    if !time.is_finite() {
                        return Err(store::corrupt(
                            "Error history timestamp cannot be represented",
                        ));
                    }
                    let bucket = ((time / 900000.0).floor() as i64)
                        .checked_mul(900000)
                        .ok_or_else(|| {
                            store::corrupt("Error history timestamp cannot be represented")
                        })?;
                    *buckets.entry(bucket).or_default() += 1;
                }
                if data.len() < limit && !suppress(&row) {
                    data.push(wire_value(&row)?)
                }
                Ok(())
            },
        )
        .await?;
        let diagnostics = self
            .capabilities
            .error_diagnostics(Context {
                request_id: input.request_id.clone(),
                now_ms: input.now_ms,
            })
            .await?;
        let buckets: Vec<Value> = buckets
            .into_iter()
            .map(|(time, count)| json!({"bucket_start_at_ms":time,"count":count}))
            .collect();
        let body = PortableValue::Object(vec![
            ("object".into(), PortableValue::String("list".into())),
            ("data".into(), PortableValue::Array(data)),
            (
                "five_xx_buckets".into(),
                PortableValue::from_json(&json!(buckets)),
            ),
            (
                "retention".into(),
                PortableValue::from_json(&diagnostics.retention),
            ),
            (
                "log_files".into(),
                PortableValue::from_json(&diagnostics.log_files),
            ),
        ]);
        Ok(AuthResponse::source_json(200, body.to_source_json()?))
    }
}
