use gateway_admin_data::profile::{
    CanonicalDates, SourceDateHost, from_source_profile, from_source_profile_with_host, to_profile,
    to_source_profile,
};
use gateway_core::{GatewayError, source_json::SourceJson, value::PortableValue};
use serde_json::{Value, json};

struct OracleDate;
impl SourceDateHost for OracleDate {
    fn date_value(&self, input: Option<&Value>) -> Result<Option<i64>, GatewayError> {
        CanonicalDates.date_value(input)
    }
    fn source_date_value(&self, input: Option<&SourceJson>) -> Result<Option<i64>, GatewayError> {
        if input.is_some_and(|value| value.as_str() == r#""2024-01-02\ud83d""#) {
            return Ok(None);
        }
        let value = input.map(SourceJson::deserialize::<Value>).transpose()?;
        self.date_value(value.as_ref())
    }
}
#[test]
fn raw_profile_matches_seventeen_frozen_bun_utf16_source_cases() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/profile-utf16-source.json")).unwrap();
    assert_eq!(fixture["runtime"], "bun@1.4.0");
    assert_eq!(
        fixture["sourceGitSha"],
        "6d4d4790a7c06514b92938ff677dbfd52764461d"
    );
    for case in fixture["cases"].as_array().unwrap() {
        let input = SourceJson::parse(case["input"].as_str().unwrap()).unwrap();
        let value = from_source_profile_with_host(&input, &OracleDate).unwrap();
        let encoded = to_source_profile(&value).unwrap();
        if case["name"] == "date-string-surrogate" {
            assert_eq!(value, PortableValue::Date { epoch_ms: None });
            assert_eq!(
                serde_json::to_string(&to_profile(&value).unwrap()).unwrap(),
                case["expected"].as_str().unwrap()
            );
            // Ordinary profile emission loses invalid Date. Full captures retain it as
            // the source-accepted omitted value (new Date(undefined)), never epoch zero.
            assert_eq!(encoded.as_str(), r#"{"type":"Date"}"#);
        } else {
            assert_eq!(
                encoded.as_str(),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
        assert_eq!(
            from_source_profile_with_host(&encoded, &OracleDate).unwrap(),
            value,
            "{}",
            case["name"]
        );
    }
}
#[test]
fn private_capture_writer_retains_negative_zero_and_invalid_date() {
    let value = PortableValue::Array(vec![
        PortableValue::number(-0.0),
        PortableValue::Date { epoch_ms: None },
    ]);
    let raw = to_source_profile(&value).unwrap();
    let decoded = from_source_profile(&raw).unwrap();
    assert_eq!(decoded, value);
    assert!(raw.as_str().contains(r#""value":"-0""#));
    assert_eq!(
        from_source_profile(&SourceJson::parse(r#"{"type":"Date","value":null}"#).unwrap())
            .unwrap(),
        PortableValue::Date { epoch_ms: Some(0) }
    );
}
#[test]
fn raw_date_host_absence_is_named_and_v1_never_guesses_v2() {
    let date = SourceJson::parse(r#"{"type":"Date","value":"2024-01-02\ud83d"}"#).unwrap();
    assert_eq!(
        from_source_profile(&date)
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("source_date_host_missing")
    );
    let raw=SourceJson::parse(r#"{"type":"object","value":{"type":{"type":"string","value":"string_utf16"},"value":{"type":"Array","value":[{"type":"number","value":55357}]}}}"#).unwrap();
    assert_eq!(
        from_source_profile(&raw).unwrap().to_json_lossless(),
        Some(json!({"type":"string_utf16","value":[55357]}))
    );
    let string =
        from_source_profile(&SourceJson::parse(r#"{"type":"string","value":"\ud83d"}"#).unwrap())
            .unwrap();
    assert!(string.validate_for_storage().is_err());
    assert!(string.validate_for_storage_v2().is_ok());
}
