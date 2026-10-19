//! The provider's JSON strings remain UTF-16 through selection and consumption.
use gateway_authority::full_pool_reset::{
    SourceCreditCollation, SourceResetCredit, SourceResetInventory,
};
use gateway_core::{
    GatewayError,
    identity::{AccountBinding, MAX_SAFE_INTEGER},
    js_string::JsString16,
    source_json::SourceJson,
};
use std::{cmp::Ordering, collections::BTreeSet};
use wasm_bindgen::{JsCast, JsValue};
use worker::js_sys::{self, Function, JsString, Reflect};

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Reset-credit inventory is invalid.",
        "inventory_unavailable",
    )
}
fn host_unavailable() -> GatewayError {
    GatewayError::unavailable(
        "The source date/collation capability is unavailable.",
        "codex_reset_source_runtime_unavailable",
    )
}
fn field(value: &SourceJson, name: &str) -> Result<SourceJson, GatewayError> {
    value
        .object_entries()?
        .into_iter()
        .rev()
        .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
        .map(|(_, value)| value)
        .ok_or_else(invalid)
}
fn nonblank(value: &JsString16) -> bool {
    value.as_units().iter().any(|unit| {
        !char::from_u32(u32::from(*unit)).is_some_and(gateway_schema::util::js_whitespace)
    })
}
fn text(value: &SourceJson, name: &str) -> Result<JsString16, GatewayError> {
    let value: JsString16 = field(value, name)?.deserialize()?;
    if !nonblank(&value) {
        return Err(invalid());
    }
    Ok(value)
}
fn safe_integer(value: f64) -> Result<i64, GatewayError> {
    if value.is_finite() && value.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER as f64).contains(&value)
    {
        Ok(value as i64)
    } else {
        Err(invalid())
    }
}

pub(super) fn parse_inventory(
    document: &SourceJson,
    binding: &AccountBinding,
    observed_at_ms: i64,
    parse_date: impl Fn(&JsString16) -> Result<i64, GatewayError>,
) -> Result<SourceResetInventory, GatewayError> {
    if !(0..=MAX_SAFE_INTEGER).contains(&observed_at_ms) {
        return Err(invalid());
    }
    let available_count = safe_integer(field(document, "available_count")?.deserialize()?)?;
    let mut ids = BTreeSet::new();
    let mut available = 0i64;
    let mut credits = Vec::new();
    for item in field(document, "credits")?.array_items()? {
        let credit_id = text(&item, "id")?;
        let status = text(&item, "status")?;
        let reset_type = text(&item, "reset_type")?;
        if !ids.insert(credit_id.clone()) {
            return Err(invalid());
        }
        let expiry: Option<JsString16> = field(&item, "expires_at")?.deserialize()?;
        let expires_at_ms = match expiry {
            None => None,
            Some(value) if nonblank(&value) => {
                let at = parse_date(&value)?;
                if !(0..=MAX_SAFE_INTEGER).contains(&at) {
                    return Err(invalid());
                }
                Some(at)
            }
            Some(_) => return Err(invalid()),
        };
        if status
            .as_units()
            .iter()
            .copied()
            .eq("available".encode_utf16())
        {
            available += 1;
        }
        credits.push(SourceResetCredit {
            credit_id,
            status,
            reset_type,
            expires_at_ms,
        });
    }
    if available != available_count {
        return Err(invalid());
    }
    Ok(SourceResetInventory {
        binding: binding.clone(),
        observed_at_ms,
        available_count,
        credits,
    })
}

pub(super) fn select_credit(
    inventory: &SourceResetInventory,
    host: &impl SourceCreditCollation,
    now: i64,
) -> Result<Option<JsString16>, GatewayError> {
    if inventory.observed_at_ms > now
        || now - inventory.observed_at_ms > 30_000
        || inventory.credits.iter().any(|credit| {
            credit.credit_id.as_units().len() > 512
                || credit.status.as_units().len() > 128
                || credit.reset_type.as_units().len() > 128
        })
    {
        return Err(invalid());
    }
    let mut selected: Option<&SourceResetCredit> = None;
    for credit in &inventory.credits {
        if !credit
            .status
            .as_units()
            .iter()
            .copied()
            .eq("available".encode_utf16())
            || !credit
                .reset_type
                .as_units()
                .iter()
                .copied()
                .eq("codex_rate_limits".encode_utf16())
            || credit.expires_at_ms.is_some_and(|expiry| expiry <= now)
        {
            continue;
        }
        let better = match selected {
            None => true,
            Some(current) => match credit
                .expires_at_ms
                .unwrap_or(i64::MAX)
                .cmp(&current.expires_at_ms.unwrap_or(i64::MAX))
            {
                Ordering::Less => true,
                Ordering::Equal => {
                    host.compare_credit_ids(&credit.credit_id, &current.credit_id)?
                        == Ordering::Less
                }
                Ordering::Greater => false,
            },
        };
        if better {
            selected = Some(credit);
        }
    }
    Ok(selected.map(|credit| credit.credit_id.clone()))
}

pub(super) fn consume_body(
    redeem_request_id: &str,
    credit_id: &JsString16,
) -> Result<SourceJson, GatewayError> {
    #[derive(serde::Serialize)]
    struct Body<'a> {
        redeem_request_id: &'a str,
        credit_id: &'a JsString16,
    }
    SourceJson::from_serializable(&Body {
        redeem_request_id,
        credit_id,
    })
}

fn js_string(value: &JsString16) -> JsString {
    // Avoid a spread-argument limit without converting through scalar Rust text.
    let pieces = js_sys::Array::new();
    for chunk in value.as_units().chunks(8192) {
        pieces.push(&JsString::from_char_code(chunk));
    }
    pieces.join("")
}
fn function(receiver: &JsValue, name: &str) -> Result<Function, GatewayError> {
    Reflect::get(receiver, &JsValue::from_str(name))
        .map_err(|_| host_unavailable())?
        .dyn_into::<Function>()
        .map_err(|_| host_unavailable())
}

pub(super) struct SourceRuntime;
impl SourceRuntime {
    pub(super) fn date(&self, value: &JsString16) -> Result<i64, GatewayError> {
        let date = Reflect::get(&js_sys::global(), &JsValue::from_str("Date"))
            .map_err(|_| host_unavailable())?;
        let parsed = function(&date, "parse")?
            .call1(&date, &js_string(value))
            .map_err(|_| host_unavailable())?
            .as_f64()
            .ok_or_else(host_unavailable)?;
        safe_integer(parsed)
    }
}
impl SourceCreditCollation for SourceRuntime {
    fn compare_credit_ids(
        &self,
        left: &JsString16,
        right: &JsString16,
    ) -> Result<Ordering, GatewayError> {
        let string = Reflect::get(&js_sys::global(), &JsValue::from_str("String"))
            .map_err(|_| host_unavailable())?;
        let prototype = Reflect::get(&string, &JsValue::from_str("prototype"))
            .map_err(|_| host_unavailable())?;
        let comparison = function(&prototype, "localeCompare")?
            .call1(&js_string(left), &js_string(right))
            .map_err(|_| host_unavailable())?
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(host_unavailable)?;
        Ok(if comparison < 0.0 {
            Ordering::Less
        } else if comparison > 0.0 {
            Ordering::Greater
        } else {
            Ordering::Equal
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gateway_core::identity::{CredentialVersion, PoolVersionstamp, RoutingAccountHash};
    fn binding() -> AccountBinding {
        AccountBinding {
            slot: 0,
            account_id_hash: RoutingAccountHash("fixture".into()),
            credential_version: CredentialVersion("version".into()),
            pool_versionstamp: PoolVersionstamp("pool-v1".into()),
            routing_generation: 1,
        }
    }
    #[test]
    fn complete_inventory_preserves_raw_ids_and_last_duplicate_fields() {
        let raw = SourceJson::parse(r#"{"available_count":99,"available_count":2.0,"credits":[{"id":"\ud800","status":"available","reset_type":"codex_rate_limits","expires_at":null},{"id":"😀","status":"available","reset_type":"codex_rate_limits","expires_at":"source-date"}],"operator":"\udfff"}"#).unwrap();
        let parsed = parse_inventory(&raw, &binding(), 10, |value| {
            assert_eq!(value.try_utf8().unwrap(), "source-date");
            Ok(25)
        })
        .unwrap();
        assert_eq!(parsed.credits[0].credit_id.as_units(), &[0xd800]);
        assert_eq!(parsed.credits[1].credit_id.as_units(), &[0xd83d, 0xde00]);
        assert_eq!(parsed.credits[1].expires_at_ms, Some(25));
        assert_eq!(parsed.available_count, 2);
    }
    #[test]
    fn summary_truncation_duplicate_or_invalid_expiry_fails_closed() {
        for raw in [
            r#"{"available_count":1,"credits":[]}"#,
            r#"{"available_count":2,"credits":[{"id":"a","status":"available","reset_type":"codex_rate_limits","expires_at":null},{"id":"a","status":"available","reset_type":"codex_rate_limits","expires_at":null}]}"#,
            r#"{"available_count":1,"credits":[{"id":"a","status":"available","reset_type":"codex_rate_limits","expires_at":false}]}"#,
            r#"{"available_count":1,"credits":[{"id":"\ufeff","status":"available","reset_type":"codex_rate_limits","expires_at":null}]}"#,
        ] {
            assert!(
                parse_inventory(&SourceJson::parse(raw).unwrap(), &binding(), 10, |_| Ok(25))
                    .is_err()
            );
        }
    }
    #[test]
    fn parser_matches_actual_source_provider_golden_cases() {
        let fixture = SourceJson::parse(include_str!(
            "../../../gateway-authority/tests/fixtures/full-pool-source-v1.json"
        ))
        .unwrap();
        let cases = field(&fixture, "inventory_cases")
            .unwrap()
            .array_items()
            .unwrap();
        assert_eq!(cases.len(), 10);
        for case in cases {
            let name: String = field(&case, "name").unwrap().deserialize().unwrap();
            let expected: bool = field(&case, "accepted").unwrap().deserialize().unwrap();
            let payload = field(&case, "payload").unwrap();
            let parsed =
                parse_inventory(&payload, &binding(), 1_792_329_600_000, |date| {
                    match date.try_utf8().ok().as_deref() {
                        Some("2026-10-19T01:00:00-04:00" | "Mon, 19 Oct 2026 05:00:00 GMT") => {
                            Ok(1_792_386_000_000)
                        }
                        _ => Err(invalid()),
                    }
                });
            assert_eq!(parsed.is_ok(), expected, "{name}");
            if let Ok(parsed) = parsed {
                let golden = field(&case, "credits").unwrap().array_items().unwrap();
                assert_eq!(parsed.credits.len(), golden.len(), "{name}");
                for (actual, expected) in parsed.credits.iter().zip(golden) {
                    let id: JsString16 = field(&expected, "id").unwrap().deserialize().unwrap();
                    let expiry: Option<i64> = field(&expected, "expiresAtMs")
                        .unwrap()
                        .deserialize()
                        .unwrap();
                    assert_eq!(actual.credit_id, id, "{name}");
                    assert_eq!(actual.expires_at_ms, expiry, "{name}");
                }
            }
        }
    }
    #[test]
    fn consume_wire_is_the_actual_source_json_string_not_a_utf16_array() {
        let fixture = SourceJson::parse(include_str!(
            "../../../gateway-authority/tests/fixtures/full-pool-source-v1.json"
        ))
        .unwrap();
        let cases = field(&fixture, "consume_cases")
            .unwrap()
            .array_items()
            .unwrap();
        let body = consume_body("fixture-redeem", &JsString16::from_units(vec![0xd800])).unwrap();
        assert_eq!(cases.len(), 5);
        for case in cases {
            let source_wire: String = field(&case, "wire").unwrap().deserialize().unwrap();
            assert_eq!(body.as_str(), source_wire);
        }
    }
}
