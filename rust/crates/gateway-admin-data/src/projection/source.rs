//! Source labels never enter a scalar Value. Only explicit numeric rollup fields
//! feed the same summary/runway engine used by the existing scalar frontend.
use super::{
    json_number, metered_quota_runway_view, model_projection_numbers, number, public_quota_view,
    summarize_windows,
};
use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use gateway_schema::aliases::SourceStringCollator;
use serde_json::Value;
use std::collections::HashMap;

struct Series {
    model: JsString16,
    provider: JsString16,
    buckets: Vec<Value>,
}
fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Projection requires named source usage rows.",
        "source_projection_invalid",
    )
}
fn matches(value: &JsString16, scalar: &str) -> bool {
    value.as_units().iter().copied().eq(scalar.encode_utf16())
}
fn label(row: &SourceJson, name: &str) -> Result<JsString16, GatewayError> {
    source::member(row, name)
        .as_ref()
        .and_then(source::string)
        .ok_or_else(invalid)
}
fn numeric_bucket(row: &SourceJson) -> Value {
    let mut out = serde_json::Map::new();
    for name in [
        "bucket_start_at_ms",
        "request_count",
        "quota_sum",
        "spend_microcredits",
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "first_request_at_ms",
        "last_request_at_ms",
        "updated_at_ms",
    ] {
        let value = source::member(row, name)
            .and_then(|value| value.deserialize::<serde_json::Number>().ok())
            .map(Value::Number)
            .unwrap_or(Value::Null);
        out.insert(name.into(), value);
    }
    Value::Object(out)
}
fn group(
    rows: &[SourceJson],
    collator: &dyn SourceStringCollator,
) -> Result<Vec<Series>, GatewayError> {
    let mut indexes: HashMap<JsString16, usize> = HashMap::new();
    let mut groups: Vec<Series> = Vec::new();
    for row in rows {
        let model = label(row, "model")?;
        let provider = label(row, "provider")?;
        let identity = JsString16::from_units(
            model
                .as_units()
                .iter()
                .copied()
                .chain(std::iter::once(0))
                .chain(provider.as_units().iter().copied())
                .collect(),
        );
        if let Some(index) = indexes.get(&identity) {
            groups[*index].buckets.push(numeric_bucket(row));
        } else {
            // Exact source concat/split, including a source model/provider containing NUL.
            let mut fields = identity.as_units().split(|unit| *unit == 0);
            let model = JsString16::from_units(fields.next().unwrap_or(&[]).to_vec());
            let provider = JsString16::from_units(fields.next().unwrap_or(&[]).to_vec());
            indexes.insert(identity, groups.len());
            groups.push(Series {
                model,
                provider,
                buckets: vec![numeric_bucket(row)],
            });
        }
    }
    for group in &mut groups {
        group.buckets.sort_by(|a, b| {
            number(a, "bucket_start_at_ms")
                .unwrap_or(f64::NAN)
                .total_cmp(&number(b, "bucket_start_at_ms").unwrap_or(f64::NAN))
        });
    }
    let mut failure = None;
    groups.sort_by(|a, b| {
        match collator.compare(&a.model, &b.model).and_then(|order| {
            if order.is_eq() {
                collator.compare(&a.provider, &b.provider)
            } else {
                Ok(order)
            }
        }) {
            Ok(order) => order,
            Err(error) => {
                failure = Some(error);
                std::cmp::Ordering::Equal
            }
        }
    });
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(groups)
}
/// Pure frontend for already named/validated usage rows. It does not read storage
/// or replace the family validator; model/provider identity stays source UTF16.
pub fn project_quota_source(
    rollups: Option<&[SourceJson]>,
    snapshot: Option<&Value>,
    history: Option<&[Value]>,
    now_ms: f64,
    window_days: u32,
    collator: &dyn SourceStringCollator,
) -> Result<SourceJson, GatewayError> {
    let quota = metered_quota_runway_view(snapshot);
    let mut models = Vec::new();
    for series in group(rollups.unwrap_or(&[]), collator)? {
        let windows = summarize_windows(&series.buckets, now_ms);
        let metered = matches(&series.provider, "metered");
        let numeric = model_projection_numbers(
            metered,
            metered || matches(&series.provider, "surplus"),
            &windows,
            &quota,
            now_ms,
            history,
            window_days,
        );
        let mut fields = vec![
            ("model".into(), series.model.to_source_json()?),
            ("provider".into(), series.provider.to_source_json()?),
        ];
        fields.extend(
            source::entries(&SourceJson::from_serializable(&numeric)?).ok_or_else(invalid)?,
        );
        models.push(source::object_keys(fields)?);
    }
    source::object(vec![
        (
            "snapshot_at_ms",
            SourceJson::from_serializable(&json_number(Some(now_ms)))?,
        ),
        ("window_days", SourceJson::from_serializable(&window_days)?),
        (
            "quota",
            SourceJson::from_serializable(&public_quota_view(&quota))?,
        ),
        ("models", source::json_array(&models)?),
        (
            "rollup_scan",
            SourceJson::from_serializable(&if rollups.is_some() {
                "ok"
            } else {
                "unavailable"
            })?,
        ),
        (
            "balance_history_scan",
            SourceJson::from_serializable(&if history.is_some() {
                "ok"
            } else {
                "unavailable"
            })?,
        ),
    ])
}
