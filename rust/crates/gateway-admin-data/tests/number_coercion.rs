use gateway_admin_data::profile::js_number;
use serde_json::Value;

#[test]
fn number_coercion_matches_pinned_source_whitespace_vectors() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/js-number-whitespace-golden.json"))
            .expect("source oracle JSON");
    assert_eq!(fixture["runtime"], "Bun 1.4.0");
    for case in fixture["cases"].as_array().expect("source cases") {
        let actual = js_number(&case["input"]);
        let name = case["name"].as_str().expect("case name");
        match case["expected"]["kind"].as_str().expect("number kind") {
            "nan" => assert!(actual.is_nan(), "{name}: {actual}"),
            "finite" => assert_eq!(
                actual,
                case["expected"]["value"].as_f64().expect("source number"),
                "{name}"
            ),
            other => panic!("Unknown oracle number kind: {other}"),
        }
    }
}
