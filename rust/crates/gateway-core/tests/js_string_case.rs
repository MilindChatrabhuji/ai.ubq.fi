use gateway_core::{js_string::JsString16, js_string_case::lowercase_source};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Case {
    name: String,
    input: Vec<u16>,
    output: Vec<u16>,
}
#[derive(Deserialize)]
struct Source {
    bun: String,
    unicode: String,
    scalars: u32,
    changed_mappings: usize,
    cases: Vec<Case>,
}
fn source() -> Source {
    serde_json::from_str(include_str!("fixtures/js-string-lowercase-source-v1.json")).unwrap()
}
#[test]
fn actual_source_contextual_lowercase_keeps_exact_utf16_and_phase() {
    let source = source();
    assert_eq!(source.bun, "1.4.0");
    for case in source.cases {
        let original = JsString16::from_units(case.input.clone());
        assert_eq!(
            lowercase_source(&original).as_units(),
            case.output,
            "{}",
            case.name
        );
        assert_eq!(
            original.as_units(),
            case.input,
            "input mutated: {}",
            case.name
        );
    }
}
#[test]
fn all_pinned_source_single_scalar_mappings_match_standard_unicode() {
    let source = source();
    assert_eq!(
        format!("{}.{}", char::UNICODE_VERSION.0, char::UNICODE_VERSION.1),
        source.unicode
    );
    let mappings: BTreeMap<u32, Vec<u16>> =
        include_str!("fixtures/js-string-lowercase-mappings-v1.txt")
            .lines()
            .map(|line| {
                let (scalar, units) = line.split_once(':').unwrap();
                (
                    scalar.parse().unwrap(),
                    units.split(',').map(|unit| unit.parse().unwrap()).collect(),
                )
            })
            .collect();
    assert_eq!(mappings.len(), source.changed_mappings);
    let mut scalars = 0;
    for scalar in 0..=0x10ffff {
        let Some(value) = char::from_u32(scalar) else {
            continue;
        };
        scalars += 1;
        let units: Vec<u16> = value.to_string().encode_utf16().collect();
        let expected = mappings.get(&scalar).unwrap_or(&units);
        assert_eq!(
            lowercase_source(&JsString16::from_units(units.clone())).as_units(),
            expected,
            "U+{scalar:04X}"
        );
    }
    assert_eq!(scalars, source.scalars);
}
#[test]
fn every_lone_surrogate_is_retained_and_breaks_context_without_a_substitute() {
    for unit in 0xd800..=0xdfff {
        for (input, expected) in [
            (vec![unit], vec![unit]),
            (vec![65, 0x03a3, unit, 65], vec![97, 0x03c2, unit, 97]),
            (vec![65, unit, 0x03a3], vec![97, unit, 0x03c3]),
        ] {
            assert_eq!(
                lowercase_source(&JsString16::from_units(input)).as_units(),
                expected
            );
        }
    }
    let high = lowercase_source(&JsString16::from_units(vec![0xd800]));
    let low = lowercase_source(&JsString16::from_units(vec![0xdc00]));
    let replacement = lowercase_source(&JsString16::from_units(vec![0xfffd]));
    let literal = lowercase_source(&JsString16::from_utf8(r"\uD800"));
    assert_ne!(high, low);
    assert_ne!(high, replacement);
    assert_ne!(high, literal);
    assert_eq!(
        literal.as_units(),
        r"\ud800".encode_utf16().collect::<Vec<_>>()
    );
}
