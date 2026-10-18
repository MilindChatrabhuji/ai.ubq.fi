//! 131 cases executed against frozen source with pinned Bun1.4, no dotenv/install and OS network denial.
use gateway_observability::{HealthProvider, api, capacity_shapes, health};
use serde_json::{Value, json};
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
        assert_eq!(actual, *expected, "source case {index} {}", case["op"]);
    }
}
