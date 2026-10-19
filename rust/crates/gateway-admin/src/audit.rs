use gateway_auth::{AuthHost, AuthMethod, AuthPrincipal, crypto::uuid_from_random, store};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_json::SourceJson,
    state::{RecordKey, RecordMutation, StoredRecord},
    value::PortableValue,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const RETENTION_MS: i64 = 7_776_000_000;
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ChangeActor {
    pub kind: String,
    pub principal_id: Option<String>,
    pub principal_label: Option<String>,
    pub is_super_admin: bool,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct KeyChange {
    pub id: String,
    pub at_ms: i64,
    pub action: String,
    pub actor: ChangeActor,
    pub target_key_id: String,
    pub target_key_name: Option<JsString16>,
    pub changed: SourceJson,
    pub request_id: String,
    pub release: String,
}

pub fn actor(principal: &AuthPrincipal) -> ChangeActor {
    let (kind, id, label) = match &principal.method {
        AuthMethod::PasskeySession {
            user_id, handle, ..
        } => ("passkey_user", Some(user_id.clone()), Some(handle.clone())),
        AuthMethod::Disabled => ("local_admin", None, None),
        _ => ("shared_admin_credential", None, None),
    };
    ChangeActor {
        kind: kind.into(),
        principal_id: id,
        principal_label: label,
        is_super_admin: principal.is_super_admin,
    }
}
pub fn safe_changed(value: &Value) -> Result<SourceJson, GatewayError> {
    safe_changed_source(&SourceJson::from_serializable(value)?)
}

pub fn safe_changed_source(value: &SourceJson) -> Result<SourceJson, GatewayError> {
    let allowed = [
        "name",
        "expires_at_ms",
        "usage_limit_requests",
        "window_ms",
        "paid_fallback_enabled",
        "paid_fallback_limit_credits",
        "reset_usage",
        "revoked_at_ms",
    ];
    let fields = if value.as_str().trim_start().starts_with('{') {
        value.object_entries()?
    } else {
        Vec::new()
    };
    let mut result = Vec::new();
    for name in allowed {
        let key = JsString16::from_utf8(name);
        let Some((_, value)) = fields.iter().rev().find(|(field, _)| field == &key) else {
            continue;
        };
        let raw = value.as_str().trim();
        let safe = if raw.starts_with('"') {
            value
                .deserialize::<JsString16>()?
                .prefix_units(200)
                .to_source_json()?
        } else if matches!(raw, "null" | "true" | "false")
            || value.deserialize::<f64>().is_ok_and(f64::is_finite)
        {
            value.clone()
        } else {
            continue;
        };
        result.push(format!(
            "{}:{}",
            key.to_source_json()?.as_str(),
            safe.as_str()
        ));
    }
    SourceJson::parse(&format!("{{{}}}", result.join(",")))
}
pub fn event_key(event: &KeyChange) -> RecordKey {
    store::key(json!([
        "uos_ai",
        "api_keys",
        "change",
        gateway_core::identity::MAX_SAFE_INTEGER - event.at_ms,
        event.id
    ]))
}
pub struct ChangeInput<'a> {
    pub principal: &'a AuthPrincipal,
    pub request_id: &'a str,
    pub release: &'a str,
    pub action: &'a str,
    pub id: &'a str,
    pub name: Option<&'a JsString16>,
    pub changed: &'a SourceJson,
}

pub struct SourceChangeInput<'a> {
    pub principal: Option<&'a AuthPrincipal>,
    pub request_id: &'a str,
    pub action: &'a str,
    pub id: &'a str,
    pub name: Option<&'a JsString16>,
    pub changed: &'a SourceJson,
    pub now_ms: Option<i64>,
}

/// The source evaluates UUID, trimmed request ID, optional clock, sanitizer, then release.
pub fn build_event(
    input: SourceChangeInput<'_>,
    uuid: impl FnOnce() -> Result<String, GatewayError>,
    now: impl FnOnce() -> Result<i64, GatewayError>,
    release: impl FnOnce() -> Result<String, GatewayError>,
) -> Result<KeyChange, GatewayError> {
    let id = uuid()?;
    let request_id = input.request_id.trim_matches(js_whitespace);
    let at_ms = match input.now_ms {
        Some(value) => value,
        None => now()?,
    };
    let actor = input.principal.map(actor).unwrap_or(ChangeActor {
        kind: "unknown".into(),
        principal_id: None,
        principal_label: None,
        is_super_admin: false,
    });
    let target_key_name = input
        .name
        .filter(|name| !name.as_units().is_empty())
        .map(|name| name.prefix_units(200));
    let changed = safe_changed_source(input.changed)?;
    Ok(KeyChange {
        request_id: if request_id.is_empty() {
            id.clone()
        } else {
            request_id.into()
        },
        id,
        at_ms,
        action: input.action.into(),
        actor,
        target_key_id: input.id.into(),
        target_key_name,
        changed,
        release: release()?,
    })
}

pub fn mutation<H: AuthHost>(
    host: &H,
    input: ChangeInput<'_>,
) -> Result<RecordMutation, GatewayError> {
    let event = build_event(
        SourceChangeInput {
            principal: Some(input.principal),
            request_id: input.request_id,
            action: input.action,
            id: input.id,
            name: input.name,
            changed: input.changed,
            now_ms: None,
        },
        || uuid_from_random(&host.random_bytes(16)?),
        || Ok(host.now_ms()),
        || Ok(input.release.into()),
    )?;
    event_mutation(&event, &uuid_from_random(&host.random_bytes(16)?)?)
}

/// Ordinary audit rows stay JSON. Only non-scalar UTF16 needs the existing typed codec.
pub fn event_mutation(event: &KeyChange, revision: &str) -> Result<RecordMutation, GatewayError> {
    let source = SourceJson::from_serializable(event)?;
    let expiry = Some(event.at_ms + RETENTION_MS);
    let record = match source.deserialize::<Value>() {
        Ok(value) => StoredRecord::json(revision, value, expiry),
        Err(_) => StoredRecord::profile_v2(revision, portable_audit(&source)?, expiry)?,
    };
    Ok(RecordMutation::Put {
        key: event_key(event),
        record,
    })
}

fn portable_audit(value: &SourceJson) -> Result<PortableValue, GatewayError> {
    match value.as_str().trim_start().as_bytes().first() {
        Some(b'"') => {
            let text = value.deserialize::<JsString16>()?;
            Ok(match text.try_utf8() {
                Ok(text) => PortableValue::String(text),
                Err(_) => PortableValue::StringUtf16(text),
            })
        }
        Some(b'{') => Ok(PortableValue::Object(
            value
                .object_entries()?
                .into_iter()
                .map(|(key, value)| Ok((key.try_utf8()?, portable_audit(&value)?)))
                .collect::<Result<_, GatewayError>>()?,
        )),
        _ => Ok(PortableValue::from_json(&value.deserialize::<Value>()?)),
    }
}

// JSON.stringify renders non-finite values as null and either signed zero as 0.
// This is only the audit HTTP projection; durable typed number bits are unchanged.
fn wire_numbers(value: &mut PortableValue) {
    match value {
        PortableValue::NumberBits(_) => {
            if let Some(number) = value.number_value() {
                if !number.is_finite() {
                    *value = PortableValue::Null;
                } else if number == 0.0 {
                    *value = PortableValue::number(0.0);
                }
            }
        }
        PortableValue::Object(fields) => {
            for (_, value) in fields {
                wire_numbers(value);
            }
        }
        PortableValue::ObjectUtf16(fields) => {
            for (_, value) in fields {
                wire_numbers(value);
            }
        }
        PortableValue::Array(values) => {
            for value in values {
                wire_numbers(value);
            }
        }
        _ => {}
    }
}
fn wire_record(record: &StoredRecord) -> Result<SourceJson, GatewayError> {
    let mut value = record.portable_value()?;
    wire_numbers(&mut value);
    value.to_source_json()
}
pub fn decode_event(record: &StoredRecord) -> Result<KeyChange, GatewayError> {
    wire_record(record)?.deserialize()
}

/// Visibility is based on the source timestamp alone, not complete event decoding.
pub fn retained_event(
    record: &StoredRecord,
    oldest: i64,
) -> Result<Option<SourceJson>, GatewayError> {
    let value = record.portable_value()?;
    let timestamp = match &value {
        PortableValue::Object(fields) => fields
            .iter()
            .rev()
            .find(|(key, _)| key == "at_ms")
            .and_then(|(_, value)| value.number_value()),
        PortableValue::ObjectUtf16(fields) => fields
            .iter()
            .rev()
            .find(|(key, _)| key == &JsString16::from_utf8("at_ms"))
            .and_then(|(_, value)| value.number_value()),
        _ => None,
    };
    if timestamp.is_some_and(|at| at >= oldest as f64) {
        wire_record(record).map(Some)
    } else {
        Ok(None)
    }
}

pub fn page(events: &[SourceJson], next_cursor: Option<&str>) -> Result<SourceJson, GatewayError> {
    #[derive(Serialize)]
    struct Page<'a> {
        object: &'static str,
        data: &'a [SourceJson],
        next_cursor: Option<&'a str>,
        retention_days: u8,
    }
    SourceJson::from_serializable(&Page {
        object: "list",
        data: events,
        next_cursor,
        retention_days: 90,
    })
}
fn js_whitespace(value: char) -> bool {
    matches!(value, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
