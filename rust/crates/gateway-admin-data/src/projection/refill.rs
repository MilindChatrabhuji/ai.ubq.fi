use super::HOUR_MS;
use crate::{json_number, number, positive, text};
use serde_json::{Value, json};

pub(super) fn empty() -> Value {
    json!({"status":"unknown","time":null,"exhausted":null,"amount":null,"cadence":null,"rate":null,"next":null})
}
fn nonnegative(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && *v >= 0.0)
}
fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let m = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[m - 1] + values[m]) / 2.0
    } else {
        values[m]
    })
}

pub(super) fn project(
    quota: &Value,
    balance: Option<f64>,
    burn: Option<f64>,
    history: Option<&[Value]>,
    now: f64,
) -> Value {
    if number(quota, "balance_quota").is_none() {
        return empty();
    }
    let mut ordered: Vec<&Value> = history
        .unwrap_or(&[])
        .iter()
        .filter(|s| {
            nonnegative(number(s, "observed_at_ms")).is_some_and(|t| t <= now)
                && nonnegative(number(s, "balance_quota")).is_some()
        })
        .collect();
    ordered.sort_by(|a, b| {
        number(a, "observed_at_ms")
            .unwrap_or(0.0)
            .total_cmp(&number(b, "observed_at_ms").unwrap_or(0.0))
            .then_with(|| {
                number(a, "bucket_start_at_ms")
                    .unwrap_or(0.0)
                    .total_cmp(&number(b, "bucket_start_at_ms").unwrap_or(0.0))
            })
    });
    let mut events: Vec<f64> = ordered
        .windows(2)
        .filter_map(|pair| {
            let delta = number(pair[1], "balance_quota").unwrap_or(0.0)
                - number(pair[0], "balance_quota").unwrap_or(0.0);
            let baseline = nonnegative(number(pair[1], "baseline_quota"))
                .zip(nonnegative(number(pair[0], "baseline_quota")))
                .map(|(b, a)| b - a)
                .unwrap_or(0.0);
            (delta.max(baseline) > 0.0).then(|| number(pair[1], "observed_at_ms").unwrap_or(0.0))
        })
        .collect();
    let inferred = text(quota, "confidence") == Some("inferred_adjustment");
    let observed_complete = number(quota, "latest_refill_completed_at_ms");
    let cycle_refill = observed_complete.is_some()
        || positive(number(quota, "latest_refill_amount_credits")).is_some()
        || matches!(
            text(quota, "confidence"),
            Some("refill_observed" | "inferred_adjustment")
        );
    for time in [
        if cycle_refill {
            number(quota, "cycle_started_at_ms")
        } else {
            None
        },
        if inferred {
            number(quota, "last_credit_at_ms")
        } else {
            None
        },
        observed_complete,
    ]
    .into_iter()
    .flatten()
    .filter(|t| t.is_finite() && *t >= 0.0 && *t <= now)
    {
        events.retain(|v| (*v - time).abs() > HOUR_MS);
        events.push(time);
    }
    events.sort_by(f64::total_cmp);
    let inferred_latest = inferred
        && (observed_complete.is_none()
            || number(quota, "last_credit_at_ms")
                .zip(observed_complete)
                .is_some_and(|(credit, refill)| credit > refill));
    let qpc = positive(number(quota, "quota_per_credit"));
    let observed_amount = positive(number(quota, "latest_refill_amount_credits"))
        .zip(qpc)
        .and_then(|(a, q)| positive(Some(a * q)));
    let amount = if inferred_latest {
        positive(number(quota, "last_inferred_credit_quota"))
    } else {
        observed_amount
    };
    let amount_credits = amount.zip(qpc).map(|(a, q)| a / q);
    let cadence = median(
        events
            .windows(2)
            .map(|w| w[1] - w[0])
            .filter(|v| v.is_finite() && *v > 0.0)
            .collect(),
    );
    let rate = positive(amount.zip(cadence).map(|(a, c)| a / (c / HOUR_MS)));
    let mut unknown = empty();
    unknown["amount"] = json_number(amount_credits);
    unknown["cadence"] = json_number(cadence);
    unknown["rate"] = json_number(rate);
    let Some((balance, burn)) = balance.zip(positive(burn)) else {
        return unknown;
    };
    let time = (balance / burn * HOUR_MS).trunc();
    let mut no_refill = unknown.clone();
    no_refill["status"] = json!("exhausts_without_refill");
    no_refill["time"] = json_number(Some(time));
    no_refill["exhausted"] = json_number(Some((now + time).trunc()));
    if !events.is_empty() && amount.is_none() {
        return unknown;
    }
    let Some(((cadence, amount), rate)) = cadence.zip(amount).zip(rate) else {
        return if history.is_none() {
            unknown
        } else {
            no_refill
        };
    };
    let Some(latest) = events.last() else {
        return if history.is_none() {
            unknown
        } else {
            no_refill
        };
    };
    let periods = if *latest < now {
        ((now - latest) / cadence).ceil()
    } else if *latest == now {
        1.0
    } else {
        0.0
    };
    let next = latest + periods * cadence;
    let at_next = balance - burn * ((next - now) / HOUR_MS).max(0.0);
    no_refill["next"] = json_number(Some(next));
    if at_next < 0.0 {
        return no_refill;
    }
    if rate >= burn {
        let mut sustainable = unknown;
        sustainable["status"] = json!("sustainable");
        sustainable["next"] = json_number(Some(next));
        return sustainable;
    }
    let cycle_burn = burn * (cadence / HOUR_MS);
    let after = at_next + amount;
    let loss = cycle_burn - amount;
    let cycles = if after < cycle_burn {
        0.0
    } else {
        ((after - cycle_burn) / loss).floor() + 1.0
    };
    let exhaustion = (next + cycles * cadence + (after - cycles * loss) / burn * HOUR_MS).trunc();
    let mut forecast = unknown;
    forecast["status"] = json!("exhausts_with_refill");
    forecast["time"] = json_number(Some((exhaustion - now).max(0.0)));
    forecast["exhausted"] = json_number(Some(exhaustion));
    forecast["next"] = json_number(Some(next));
    forecast
}
