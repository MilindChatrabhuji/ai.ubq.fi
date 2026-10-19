//! Source OpenLux pricing projection. Metadata never authorizes inference.
use gateway_admin_runtime::capabilities::PricingSnapshot;
use gateway_core::{GatewayError, identity::MAX_SAFE_INTEGER};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn invalid(code: &str) -> GatewayError {
    GatewayError::new(
        502,
        "Metered pricing initialization received invalid metadata.",
        Some(code),
    )
}
fn positive(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|number| number.is_finite() && *number > 0.0)
}
pub(super) fn project(
    models: &[String],
    pricing: &Value,
    status: &Value,
    at: i64,
) -> Result<PricingSnapshot, GatewayError> {
    let envelope = |value: &Value, code: &str| {
        if value["success"] != true || !value["data"].is_object() {
            return Err(invalid(code));
        }
        Ok(value["data"].clone())
    };
    let pricing = envelope(pricing, "metered_pricing_invalid")?;
    let status = envelope(status, "metered_status_invalid")?;
    let quota = status["quota_per_unit"]
        .as_i64()
        .filter(|n| *n > 0 && *n <= MAX_SAFE_INTEGER);
    let Some(quota) =
        quota.filter(|_| status["setup"] == true && (0..=MAX_SAFE_INTEGER).contains(&at))
    else {
        return Err(invalid("metered_status_invalid"));
    };
    let ratios = pricing["model_ratio"]
        .as_object()
        .ok_or_else(|| invalid("metered_pricing_invalid"))?;
    let fixed = pricing["model_price"]
        .as_object()
        .ok_or_else(|| invalid("metered_pricing_invalid"))?;
    let mut priced = BTreeSet::new();
    let mut coefficients = BTreeMap::new();
    for (model, value) in ratios {
        if let Some(ratio) = positive(value) {
            if !gateway_schema::util::js_trim(model).is_empty() {
                priced.insert(model.clone());
            }
            let completion = positive(&pricing["completion_ratio"][model]).unwrap_or(1.0);
            let coefficient = ratio * (1.0 + completion);
            if coefficient.is_finite() && coefficient > 0.0 {
                coefficients.insert(model.clone(), coefficient);
            }
        }
    }
    for (model, value) in fixed {
        if let Some(price) = positive(value) {
            if !gateway_schema::util::js_trim(model).is_empty() {
                priced.insert(model.clone());
            }
            coefficients.insert(model.clone(), price);
        }
    }
    let mut seen = BTreeSet::new();
    let mut eligible = Vec::new();
    for model in models {
        let model = gateway_schema::util::js_trim(model);
        if model.is_empty() {
            return Err(invalid("metered_pricing_invalid"));
        }
        if seen.insert(model.to_owned()) && priced.contains(model) {
            eligible.push(model.to_owned());
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
    use serde_json::json;
    #[test]
    fn source_fixed_prices_override_ratios_without_advertising_unknown_models() {
        let snapshot = project(&["a".into(), "a".into(), "absent".into()], &json!({"success":true,"data":{"model_ratio":{"a":2},"model_price":{"a":7,"other":1},"completion_ratio":{"a":3}}}), &json!({"success":true,"data":{"setup":true,"quota_per_unit":500000}}), 10).unwrap();
        assert_eq!(snapshot.eligible_model_ids, ["a"]);
        assert_eq!(snapshot.model_quota_coefficients["a"], 7.0);
    }
    #[test]
    fn invalid_quota_and_metadata_fail_before_any_key_policy_write() {
        assert!(project(&[], &json!({"success":false}), &Value::Null, 1).is_err());
        assert!(
            project(
                &[],
                &json!({"success":true,"data":{}}),
                &json!({"success":true,"data":{"setup":true,"quota_per_unit":0}}),
                1
            )
            .is_err()
        );
    }
}
