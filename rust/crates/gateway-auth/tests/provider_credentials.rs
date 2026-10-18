use base64::{Engine, engine::general_purpose::STANDARD};
use gateway_auth::provider_credentials::*;
use serde_json::{Value, json};

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/codex-credentials-source.json")).unwrap()
}

// JS has one JSON number type. Compare exact f64 values while retaining every
// field, string, array position and null distinction from executed source output.
fn source_numbers(value: Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64().unwrap()),
        Value::Array(values) => Value::Array(values.into_iter().map(source_numbers).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, source_numbers(value)))
                .collect(),
        ),
        value => value,
    }
}

#[test]
fn pool_parser_matches_executed_source_shape_ownership_and_external_identity_cases() {
    let golden = golden();
    let cases = golden["pool_cases"].as_array().unwrap();
    assert_eq!(cases.len(), 17);
    for case in cases {
        let actual = parse_codex_source_pool(&case["input"]);
        match case["expected"]["kind"].as_str().unwrap() {
            "error" => {
                let error = actual.unwrap_err();
                assert_eq!(
                    Some(error.status as u64),
                    case["expected"]["status"].as_u64(),
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    error.envelope.error.code.as_deref(),
                    case["expected"]["code"].as_str(),
                    "{}",
                    case["name"]
                );
            }
            "invalid" => assert!(actual.unwrap().is_none(), "{}", case["name"]),
            "value" => {
                let pool = actual.unwrap().unwrap();
                assert_eq!(
                    source_numbers(pool.private_source_value()),
                    source_numbers(case["expected"]["value"].clone()),
                    "{}",
                    case["name"]
                );
                let debug = format!("{pool:?}");
                assert!(!debug.contains("access-fixture") && !debug.contains("refresh-fixture"));
            }
            _ => panic!("Unknown source-golden outcome"),
        }
    }
}

#[test]
fn configured_documents_preserve_source_nonexternal_route_without_native_owner_claims() {
    let golden = golden();
    let cases = golden["document_cases"].as_array().unwrap();
    assert_eq!(cases.len(), 5);
    for case in cases {
        let now = case["now_ms"].as_i64().unwrap();
        let actual = parse_codex_auth_document(&case["input"], now);
        assert_eq!(
            source_numbers(
                actual
                    .as_ref()
                    .map_or(Value::Null, CodexSourceAccount::private_source_value)
            ),
            source_numbers(case["expected"].clone()),
            "{}",
            case["name"]
        );
        let encoded = STANDARD.encode(case["input"].to_string().as_bytes());
        if case["expected"].is_null() {
            assert_eq!(
                parse_codex_auth_binding(&encoded, now)
                    .unwrap_err()
                    .envelope
                    .error
                    .code
                    .as_deref(),
                Some("codex_auth_invalid")
            );
        } else {
            assert_eq!(
                source_numbers(
                    parse_codex_auth_binding(&encoded, now)
                        .unwrap()
                        .private_source_value()
                ),
                source_numbers(case["expected"].clone())
            );
        }
    }
    assert_eq!(
        parse_codex_auth_binding("\u{feff}\n ", 1234)
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("codex_auth_missing")
    );
}

#[test]
fn forgiving_base64_and_four_identity_domains_match_executed_source_vectors() {
    let golden = golden();
    for case in golden["base64_cases"].as_array().unwrap() {
        let actual = decode_source_base64(case["input"].as_str().unwrap());
        let expected = case["expected"].as_array().map(|bytes| {
            bytes
                .iter()
                .map(|byte| byte.as_u64().unwrap() as u8)
                .collect::<Vec<_>>()
        });
        assert_eq!(actual, expected, "{}", case["input"]);
    }
    let account =
        parse_codex_auth_document(&json!({"tokens":golden["identity"]["input"]}), 1234).unwrap();
    let identity = account.identity();
    let expected = &golden["identity"]["expected"];
    assert_eq!(identity.routing_account_hash.0, expected["accountIdHash"]);
    assert_eq!(identity.credential_version.0, expected["credentialVersion"]);
    assert_eq!(
        identity.administrative_account_hash.0,
        expected["administrative_account_hash"]
    );
    assert_eq!(
        identity.native_generation_hash,
        expected["native_generation_hash"]
    );
}
