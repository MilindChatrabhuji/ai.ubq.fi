//! Internal source-string semantics; these do not claim ordinary JSON ingress supports lone surrogates.
use super::*;

fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/forwarding-unicode-source-v1.json"
    ))
    .unwrap()
}

#[test]
fn source_lone_units_are_not_replaced_when_already_in_budget() {
    let units = golden()["inBudgetLoneUnits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|unit| unit.as_u64().unwrap() as u16)
        .collect();
    let input = JsString16::from_units(units);
    let mut elisions = vec![];
    let actual = bound_source(&input, "input", None, "message", false, &mut elisions).unwrap();
    assert_eq!(actual, input);
    assert!(elisions.is_empty());
    assert!(actual.try_utf8().is_err());
    let roundtrip: JsString16 =
        serde_json::from_str(actual.to_source_json().unwrap().as_str()).unwrap();
    assert_eq!(roundtrip, input);
}

#[test]
fn source_lone_units_count_as_textencoder_replacements_without_changing_kept_units() {
    let golden = golden();
    for (index, first) in [0xd800, 0xdc00].into_iter().enumerate() {
        let mut units = vec![first];
        units.extend(std::iter::repeat_n(97, FORWARD_LIMIT + 1024));
        let input = JsString16::from_units(units);
        let case = &golden["lone"][index];
        let mut expected =
            input.as_units()[..case["headUnits"].as_u64().unwrap() as usize].to_vec();
        expected.extend(case["marker"].as_str().unwrap().encode_utf16());
        let mut elisions = vec![];
        let actual = bound_source(
            &input,
            "input[1].output",
            Some(&JsString16::from_utf8("call_unicode")),
            "tool_output",
            false,
            &mut elisions,
        )
        .unwrap();
        assert_eq!(actual.as_units(), expected);
        assert_eq!(actual.as_units()[0], first);
        assert_eq!(
            elisions[0].original_bytes,
            case["elision"]["originalBytes"].as_u64().unwrap() as usize
        );
        assert_eq!(
            elisions[0].forwarded_bytes,
            case["elision"]["forwardedBytes"].as_u64().unwrap() as usize
        );
        assert_eq!(
            elisions[0].omitted_bytes,
            case["elision"]["omittedBytes"].as_u64().unwrap() as usize
        );
    }
}
