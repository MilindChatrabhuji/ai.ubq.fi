//! Source OpenLux pricing projection. Metadata never authorizes inference.
use super::{Binding, unavailable};
use gateway_admin_runtime::capabilities::PricingSnapshot;
use gateway_core::{
    GatewayError, identity::MAX_SAFE_INTEGER, js_string::JsString16, model::ModelId,
    source_json::SourceJson, source_serialization as source,
};
use std::collections::{BTreeMap, BTreeSet};

pub(super) enum Metadata {
    Ratios,
    Status,
}
impl Metadata {
    fn url(&self) -> &'static str {
        match self {
            Self::Ratios => "https://api.openlux.ai/api/ratio_config",
            Self::Status => "https://api.openlux.ai/api/status",
        }
    }
}
pub(super) async fn fetch(host: &Binding, endpoint: Metadata) -> Result<SourceJson, GatewayError> {
    let target = crate::transport::outbound::PinnedDestination::new(endpoint.url())?;
    let cancellation = host.catalog.platform.cancellation.child()?;
    let headers = BTreeMap::from([("Accept".into(), "application/json".into())]);
    let mut response = crate::transport::outbound::send_http(
        &target,
        worker::Method::Get,
        &headers,
        &[],
        &cancellation,
        || async { Ok(()) },
    )
    .await
    .map_err(|failure| failure.error)?;
    if !(200..300).contains(&response.status_code()) {
        crate::transport::body::discard_response(&mut response);
        return Err(unavailable(
            "Administrator metadata or summarizer request failed.",
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| unavailable("Administrator response could not be read."))?;
    parse_metadata(&bytes)
}
fn parse_metadata(bytes: &[u8]) -> Result<SourceJson, GatewayError> {
    let text = String::from_utf8_lossy(bytes);
    SourceJson::parse(text.strip_prefix('\u{feff}').unwrap_or(&text))
        .map_err(|_| unavailable("Administrator response is invalid JSON."))
}
fn invalid(code: &str) -> GatewayError {
    GatewayError::new(
        502,
        "Metered pricing initialization received invalid metadata.",
        Some(code),
    )
}
fn positive(value: &SourceJson) -> Option<f64> {
    source::number(value).filter(|number| number.is_finite() && *number > 0.0)
}
fn envelope(value: &SourceJson, code: &str) -> Result<SourceJson, GatewayError> {
    let success = source::member(value, "success").and_then(|v| v.deserialize::<bool>().ok());
    let data = source::member(value, "data").filter(|v| v.object_entries().is_ok());
    if success != Some(true) {
        return Err(invalid(code));
    }
    data.ok_or_else(|| invalid(code))
}
fn entries(value: &SourceJson, field: &str) -> Option<Vec<(JsString16, SourceJson)>> {
    source::member(value, field).and_then(|value| source::entries(&value))
}
fn keyed(value: Option<&SourceJson>, key: &JsString16) -> Option<SourceJson> {
    value
        .and_then(source::entries)?
        .into_iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}
fn trim(value: &JsString16) -> JsString16 {
    let units = value.as_units();
    let whitespace = |unit: &&u16| {
        char::from_u32(u32::from(**unit)).is_some_and(gateway_schema::util::js_whitespace)
    };
    let start = units.iter().take_while(whitespace).count();
    let end = units.len() - units[start..].iter().rev().take_while(whitespace).count();
    JsString16::from_units(units[start..end].to_vec())
}
pub(super) fn project(
    models: &[ModelId],
    pricing: &SourceJson,
    status: &SourceJson,
    at: i64,
) -> Result<PricingSnapshot, GatewayError> {
    let pricing = envelope(pricing, "metered_pricing_invalid")?;
    let status = envelope(status, "metered_status_invalid")?;
    let quota = source::member(&status, "quota_per_unit")
        .as_ref()
        .and_then(source::number)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= MAX_SAFE_INTEGER as f64)
        .map(|n| n as i64);
    let setup =
        source::member(&status, "setup").and_then(|v| v.deserialize::<bool>().ok()) == Some(true);
    let Some(quota) = quota.filter(|_| setup && (0..=MAX_SAFE_INTEGER).contains(&at)) else {
        return Err(invalid("metered_status_invalid"));
    };
    let ratios =
        entries(&pricing, "model_ratio").ok_or_else(|| invalid("metered_pricing_invalid"))?;
    let fixed =
        entries(&pricing, "model_price").ok_or_else(|| invalid("metered_pricing_invalid"))?;
    let completion_ratios = source::member(&pricing, "completion_ratio");
    let mut priced = BTreeSet::new();
    let mut coefficients = BTreeMap::new();
    for (model, value) in ratios {
        if let Some(ratio) = positive(&value) {
            if !trim(&model).as_units().is_empty() {
                priced.insert(ModelId::from_source(model.clone()));
            }
            let completion = keyed(completion_ratios.as_ref(), &model)
                .as_ref()
                .and_then(positive)
                .unwrap_or(1.0);
            let coefficient = ratio * (1.0 + completion);
            if coefficient.is_finite() && coefficient > 0.0 {
                coefficients.insert(ModelId::from_source(model), coefficient);
            }
        }
    }
    for (model, value) in fixed {
        if let Some(price) = positive(&value) {
            if !trim(&model).as_units().is_empty() {
                priced.insert(ModelId::from_source(model.clone()));
            }
            coefficients.insert(ModelId::from_source(model), price);
        }
    }
    let mut seen = BTreeSet::new();
    let mut eligible = Vec::new();
    for model in models {
        let model = ModelId::from_source(trim(model.as_js_string()));
        if model.as_js_string().as_units().is_empty() {
            return Err(invalid("metered_pricing_invalid"));
        }
        if seen.insert(model.clone()) && priced.contains(&model) {
            eligible.push(model);
        }
    }
    coefficients.retain(|model, _| eligible.contains(model));
    Ok(PricingSnapshot {
        eligible_model_ids: eligible,
        quota_per_credit: quota,
        model_quota_coefficients: coefficients,
        checked_at_ms: at,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn json(text: &str) -> SourceJson {
        SourceJson::parse(text).unwrap()
    }
    #[test]
    fn source_fixed_prices_override_ratios_without_advertising_unknown_models() {
        let snapshot = project(&["a".into(), "a".into(), "absent".into()], &json(r#"{"success":true,"data":{"model_ratio":{"a":2},"model_price":{"a":7,"other":1},"completion_ratio":{"a":3}}}"#), &json(r#"{"success":true,"data":{"setup":true,"quota_per_unit":500000}}"#), 10).unwrap();
        assert_eq!(snapshot.eligible_model_ids, vec![ModelId::from_scalar("a")]);
        assert_eq!(
            snapshot.model_quota_coefficients[&ModelId::from_scalar("a")],
            7.0
        );
    }
    #[test]
    fn invalid_quota_and_metadata_fail_before_any_key_policy_write() {
        assert!(project(&[], &json(r#"{"success":false}"#), &json("null"), 1).is_err());
        assert!(
            project(
                &[],
                &json(r#"{"success":true,"data":{}}"#),
                &json(r#"{"success":true,"data":{"setup":true,"quota_per_unit":0}}"#),
                1
            )
            .is_err()
        );
    }
    #[test]
    fn source_number_integer_accepts_decimal_json_notation() {
        let snapshot = project(
            &[],
            &json(r#"{"success":true,"data":{"model_ratio":{},"model_price":{}}}"#),
            &json(r#"{"success":true,"data":{"setup":true,"quota_per_unit":500000.0}}"#),
            10,
        )
        .unwrap();
        assert_eq!(snapshot.quota_per_credit, 500000);
    }
    #[test]
    fn metadata_and_projection_retain_exact_units_and_duplicate_key_last_value() {
        let mut bytes = b"\xef\xbb\xbf".to_vec();
        bytes.extend_from_slice(br#"{"success":true,"data":{"model_ratio":{"m-\ud800":2,"m-\udc00":3,"m-\ufffd":5,"duplicate":2,"duplicate":0},"model_price":{"m-\ud800":7},"completion_ratio":{"m-\udc00":2}}}"#);
        let pricing = parse_metadata(&bytes).unwrap();
        let high = ModelId::from_source(JsString16::from_units(vec![109, 45, 0xd800]));
        let low = ModelId::from_source(JsString16::from_units(vec![109, 45, 0xdc00]));
        let replacement = ModelId::from_scalar("m-\u{fffd}");
        let snapshot = project(
            &[
                ModelId::from_source(JsString16::from_units(vec![0xfeff, 109, 45, 0xd800, 0x20])),
                high.clone(),
                low.clone(),
                replacement.clone(),
                "duplicate".into(),
            ],
            &pricing,
            &json(r#"{"success":true,"data":{"setup":true,"quota_per_unit":500000}}"#),
            10,
        )
        .unwrap();
        assert_eq!(
            snapshot.eligible_model_ids,
            vec![high.clone(), low.clone(), replacement.clone()]
        );
        assert_eq!(snapshot.model_quota_coefficients[&high], 7.0);
        assert_eq!(snapshot.model_quota_coefficients[&low], 9.0);
        assert_eq!(snapshot.model_quota_coefficients[&replacement], 10.0);
        assert_eq!(snapshot.model_quota_coefficients.len(), 3);
    }
}
