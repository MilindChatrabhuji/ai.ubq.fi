//! 131 cases executed against frozen source with pinned Bun1.4, no dotenv/install and OS network denial.
use gateway_observability::{api, capacity_shapes, health, types::HealthProvider};
use serde_json::{Value, json};
// Bun JSON has one Number kind; serde_json distinguishes integral and float encodings.
// Compare numeric values, while retaining every key, array position, and nonnumeric type.
fn source_json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            matches!((left.as_f64(), right.as_f64()), (Some(a), Some(b)) if a == b)
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left.iter().zip(right).all(|(a, b)| source_json_equal(a, b))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right
                        .get(key)
                        .is_some_and(|other| source_json_equal(value, other))
                })
        }
        _ => left == right,
    }
}
#[test]
fn source_number_comparison_does_not_relax_structure_or_values() {
    assert!(source_json_equal(
        &json!({"value":[200.0]}),
        &json!({"value":[200]})
    ));
    for different in [
        json!({"value":[201]}),
        json!({"value":["200"]}),
        json!({"value":[200,200]}),
        json!({"value":[200],"extra":null}),
    ] {
        assert!(!source_json_equal(&json!({"value":[200.0]}), &different));
    }
}
#[test]
fn frozen_typescript_source_parser_and_projection_goldens() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/source-golden.json")).unwrap();
    assert_eq!(
        fixture["source"]["source_sha"],
        "6d4d4790a7c06514b92938ff677dbfd52764461d"
    );
    assert_eq!(fixture["runtime"], "1.4.0");
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 131);
    for (index, case) in cases.iter().enumerate() {
        let input = &case["input"];
        let expected = &case["expected"];
        let actual = match case["op"].as_str().unwrap() {
            "capacity_usage" => capacity_shapes::parse_codex_usage(input).unwrap_or(Value::Null),
            "capacity_overage" => {
                capacity_shapes::parse_codex_overage(input).unwrap_or(Value::Null)
            }
            "health_parse" => {
                let mut value = serde_json::to_value(health::parse_observation(input)).unwrap();
                // The source returns the accepted input; omitted optional fields remain absent.
                if expected.is_object() && expected.get("provider_request_id").is_none() {
                    value.as_object_mut().unwrap().remove("provider_request_id");
                }
                value
            }
            "health_projection" => {
                let observations: Vec<_> = input["observations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| health::parse_observation(v).unwrap())
                    .collect();
                health::project_health(&observations, input["at"].as_i64().unwrap())
            }
            "paid_health" => serde_json::to_value(health::paid_health(
                if input["provider"] == "surplus" {
                    HealthProvider::Surplus
                } else {
                    HealthProvider::Metered
                },
                input["status"].as_u64().map(|n| n as u16),
                input["body"].as_str().unwrap().as_bytes(),
                input["complete"].as_bool().unwrap(),
            ))
            .unwrap(),
            "balance_valid" => json!(api::valid_balance_sample(input)),
            "balance_resample" => json!(api::resample_balance(
                input["samples"].as_array().unwrap(),
                input["bucket"].as_i64().unwrap(),
                input["limit"].as_u64().unwrap() as usize
            )),
            op => panic!("Unexpected source operation {op}"),
        };
        assert!(
            source_json_equal(&actual, expected),
            "source case {index} {}: actual {actual:?}, expected {expected:?}",
            case["op"],
        );
    }
}
