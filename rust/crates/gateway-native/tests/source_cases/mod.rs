use gateway_auth::crypto::sha256_hex;
use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use gateway_native::native_import::import_body::{
    AUTH_MAX_BYTES, AuthReadFailure, BodyError, PROFILE_MAX_BYTES, decode_auth,
    profile::profile_plan, read_auth_json,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Inputs {
    cases: Vec<Input>,
}
#[derive(Deserialize)]
struct Input {
    id: String,
    surface: String,
    body: Value,
    query: Option<String>,
    headers: Option<std::collections::BTreeMap<String, String>>,
    kv: Option<String>,
}
#[derive(Deserialize)]
struct Observations {
    outcomes: Vec<Observed>,
}
#[derive(Deserialize)]
struct Observed {
    id: String,
    raw_body_bytes: usize,
    raw_body_sha256: String,
    parser: Option<SourceJson>,
    status: u16,
    body: SourceJson,
    text_calls: usize,
}
fn inputs() -> Vec<Input> {
    serde_json::from_str::<Inputs>(include_str!(
        "../fixtures/native-import-source/vectors.json"
    ))
    .expect("committed synthetic input descriptors")
    .cases
}
fn observations() -> Vec<Observed> {
    serde_json::from_str::<Observations>(include_str!(
        "../fixtures/native-import-source/expected.json"
    ))
    .expect("committed original-source observations")
    .outcomes
}
fn member(value: &SourceJson, name: &str) -> SourceJson {
    source::member(value, name).expect("captured source member")
}
fn string(value: &SourceJson) -> JsString16 {
    source::string(value).expect("captured source string")
}
fn boolean(value: &SourceJson, name: &str) -> bool {
    member(value, name).deserialize().expect("captured boolean")
}
fn body(input: &Input) -> Vec<u8> {
    let value = &input.body;
    match value["kind"].as_str().expect("body descriptor kind") {
        "text" => value["text"]
            .as_str()
            .expect("synthetic text")
            .as_bytes()
            .to_vec(),
        "hex" => {
            let hex = value["hex"].as_str().expect("synthetic hex");
            assert_eq!(hex.len() % 2, 0);
            (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("synthetic byte"))
                .collect()
        }
        "padded" => {
            let mut bytes = vec![b' '; value["length"].as_u64().expect("length") as usize];
            let prefix = value["prefix"].as_str().expect("prefix").as_bytes();
            bytes[..prefix.len()].copy_from_slice(prefix);
            bytes
        }
        "repeat-byte" => vec![
            value["byte"].as_u64().expect("byte") as u8;
            value["length"].as_u64().expect("length") as usize
        ],
        "fixture-line" => {
            // Exact tests/helpers/admin-auth-harness.ts stringEntryLine plus its
            // existing keyToJSON string-part fixture. Hash checked below against
            // captured actual raw input; this is data, not an imported row/effect.
            let line = r#"{"key":[{"type":"string","value":"default"},{"type":"string","value":"model"}],"value":{"type":"string","value":"gpt-5.5"},"versionstamp":"00000000000000000000"}"#;
            format!("{line}{}", value["suffix"].as_str().unwrap_or("")).into_bytes()
        }
        _ => panic!("unknown committed descriptor"),
    }
}
fn length(input: &Input) -> Option<&str> {
    input
        .headers
        .as_ref()
        .and_then(|h| h.get("content-length"))
        .map(String::as_str)
}
fn error_matches(error: BodyError, observed: &Observed) {
    let expected = member(&observed.body, "error");
    assert_eq!(error.status(), observed.status, "source refusal status");
    assert_eq!(
        JsString16::from_utf8(error.message()),
        string(&member(&expected, "message")),
        "source refusal message"
    );
    assert_eq!(
        JsString16::from_utf8(error.code()),
        string(&member(&expected, "code")),
        "source refusal code"
    );
    assert_eq!(
        string(&member(&expected, "type")),
        JsString16::from_utf8("invalid_request_error")
    );
}
fn raw_matches(raw: &[u8], observed: &Observed) {
    assert_eq!(
        raw.len(),
        observed.raw_body_bytes,
        "actual-source input length"
    );
    assert_eq!(
        sha256_hex(raw),
        observed.raw_body_sha256,
        "actual-source input hash"
    );
}
#[test]
fn original_auth_30_parser_shape_and_selected_source_field_projections() {
    let observed = observations();
    let mut count = 0;
    let mut deferred = 0;
    for input in inputs().into_iter().filter(|input| input.surface == "auth") {
        let expected = observed
            .iter()
            .find(|r| r.id == input.id)
            .expect("source outcome");
        let mut raw = body(&input);
        raw_matches(&raw, expected);
        let parser = expected.parser.as_ref().expect("actual auth parser result");
        let parsed = read_auth_json(&raw, length(&input));
        if boolean(parser, "ok") {
            let parsed = parsed.expect("source JSON parser accepted");
            assert_eq!(
                source::canonical(&parsed).unwrap(),
                source::canonical(&member(parser, "value")).unwrap(),
                "source JSON projection"
            );
        } else {
            let kind = parsed.expect_err("source JSON parser refused");
            let expected_kind = match kind {
                AuthReadFailure::Empty => "empty",
                AuthReadFailure::Invalid => "invalid",
                AuthReadFailure::TooLarge => "too_large",
            };
            assert_eq!(
                JsString16::from_utf8(expected_kind),
                string(&member(parser, "kind"))
            );
        }
        match decode_auth(&raw, length(&input)) {
            Ok(decoded) => {
                // Match only parse/field data, not the fixture's provider200,
                // catalog rows, generations or persistence outcome.
                assert_eq!(decoded.raw_body().as_ptr(), raw.as_ptr());
                assert_eq!(decoded.raw_body().len(), raw.len());
                let parsed = read_auth_json(&raw, length(&input)).unwrap();
                let selected = source::member(&parsed, "auth").unwrap_or_else(|| parsed.clone());
                assert_eq!(
                    source::canonical(decoded.auth()).unwrap(),
                    source::canonical(&selected).unwrap()
                );
                let expected_tokens = if source::member(&parsed, "auth").is_some() {
                    member(parser, "wrapped_token_data")
                } else {
                    member(parser, "bare_token_data")
                };
                let tokens = member(decoded.auth(), "tokens");
                for field in ["access_token", "refresh_token", "account_id"] {
                    assert_eq!(
                        member(&tokens, field),
                        member(&expected_tokens, field),
                        "source token field"
                    );
                }
                let expected_version = source::member(&parsed, "models").and_then(|m| {
                    source::member(&m, "client_version")
                        .as_ref()
                        .and_then(source::string)
                        .or_else(|| {
                            source::member(&m, "clientVersion")
                                .as_ref()
                                .and_then(source::string)
                        })
                });
                assert_eq!(decoded.client_version(), expected_version.as_ref());
                deferred += 1;
            }
            Err(error) => {
                if input.kv.as_deref() == Some("unavailable") {
                    // Source KV availability wins BEFORE this body helper.
                    // Its captured independent parser is proved above; no fake
                    // store/effect is added to reproduce endpoint500 here.
                    assert_eq!(expected.status, 500);
                    assert_eq!(error, BodyError::AuthBody);
                } else {
                    error_matches(error, expected);
                }
            }
        }
        raw.fill(0);
        count += 1;
    }
    assert_eq!(count, 30);
    assert_eq!(deferred, 9);
    println!(
        "AUTH_SOURCE_DATA_PROJECTIONS={count};VALID_DATA_DEFERRED_TO_PROVIDER_AND_EFFECTS={deferred}"
    );
}
#[test]
fn original_profile_18_guard_options_and_text_read_phase_projections_not_effects() {
    let observed = observations();
    let mut compared = 0;
    let mut future_store = 0;
    let mut future_effects = 0;
    for input in inputs()
        .into_iter()
        .filter(|input| input.surface == "profile")
    {
        let expected = observed
            .iter()
            .find(|r| r.id == input.id)
            .expect("source outcome");
        if input.kv.as_deref() == Some("unavailable") {
            assert_eq!(expected.status, 500);
            assert_eq!(expected.text_calls, 0);
            future_store += 1;
            continue;
        }
        let mut raw = body(&input);
        raw_matches(&raw, expected);
        let mut text_calls = 0;
        match profile_plan(input.query.as_deref().unwrap_or(""), length(&input)) {
            Err(error) => error_matches(error, expected),
            Ok(plan) => {
                assert!(["local", "prod"].contains(&plan.profile()));
                text_calls += 1;
                match plan.decode(&raw) {
                    Err(error) => error_matches(error, expected),
                    Ok(decoded) => {
                        assert_eq!(decoded.raw_body().as_ptr(), raw.as_ptr());
                        assert_eq!(decoded.raw_body().len(), raw.len());
                        assert!(
                            decoded.text().as_bytes() == raw.as_slice(),
                            "original native profile text"
                        );
                        let options = decoded.options();
                        assert_eq!(
                            JsString16::from_utf8(options.profile),
                            string(&member(&expected.body, "profile"))
                        );
                        for (name, actual) in [
                            ("include_cache", options.include_cache),
                            ("include_legacy", options.include_legacy),
                            ("overwrite", options.overwrite),
                            ("dry_run", options.dry_run),
                        ] {
                            assert_eq!(
                                actual,
                                boolean(&expected.body, name),
                                "source option {name}"
                            );
                        }
                        // No interpretation/write of NDJSON:200/422/row counters
                        // belong to future M20 integration, even for empty rows.
                        future_effects += 1;
                    }
                }
            }
        }
        assert_eq!(text_calls, expected.text_calls, "source read phase");
        raw.fill(0);
        compared += 1;
    }
    assert_eq!(compared, 18);
    assert_eq!(future_store, 1);
    assert_eq!(future_effects, 10);
    println!(
        "PROFILE_SOURCE_DATA_PROJECTIONS={compared};STORE_ORDER_UNPROVED={future_store};ROW_EFFECTS_DEFERRED={future_effects}"
    );
}
#[test]
fn raw_utf16_auth_values_and_client_version_remain_source_data_without_scalar_shadow() {
    let raw=br#" {"tokens":{"access_token":"synthetic-\ud800","refresh_token":"synthetic-\udc00","account_id":"synthetic-\ufffd"},"models":{"client_version":"\ud800","clientVersion":"0.126.0"},"ignored":{"\udc00":"x"}} "#;
    let decoded = decode_auth(raw, None).expect("source nonempty strings are data");
    let tokens = member(decoded.auth(), "tokens");
    assert_eq!(
        string(&member(&tokens, "access_token")).as_units().last(),
        Some(&0xd800)
    );
    assert_eq!(
        string(&member(&tokens, "refresh_token")).as_units().last(),
        Some(&0xdc00)
    );
    assert_eq!(
        string(&member(&tokens, "account_id")).as_units().last(),
        Some(&0xfffd)
    );
    assert_eq!(decoded.client_version().unwrap().as_units(), [0xd800]);
    assert!(decoded.raw_body() == raw, "original raw body custody");
}
#[test]
fn field_phase_limits_and_source_query_number_grammar_do_not_invent_generic_guards() {
    assert_eq!(AUTH_MAX_BYTES, 33_554_432);
    assert_eq!(PROFILE_MAX_BYTES, 5_242_880);
    assert_eq!(
        profile_plan("?profile=invalid&write=true&dry_run=true", Some("6e6")).err(),
        Some(BodyError::ProfileSelector)
    );
    assert_eq!(
        profile_plan("?profile=prod&write=true&dry_run=true", Some("0x600000")).err(),
        Some(BodyError::ProfileTooLarge)
    );
    let plan = profile_plan(
        "?profile=local&profile=invalid&write=on&dry_run=off",
        Some("Infinity"),
    )
    .expect("nonfinite Number is not an early rejection");
    let raw = [0xef, 0xbb, 0xbf, b' ', 0xff];
    let decoded = plan.decode(&raw).expect("source text decode");
    assert_eq!(decoded.text(), " �");
    assert!(decoded.raw_body() == raw, "original raw body custody");
    assert_eq!(decoded.options().profile, "local");
    assert!(decoded.options().include_legacy);
    assert!(!decoded.options().dry_run);
    let plan = profile_plan("?profile=prod&write=on&dry_run=true", None).unwrap();
    let raw = vec![b' '; PROFILE_MAX_BYTES + 1];
    assert_eq!(plan.decode(&raw).err(), Some(BodyError::ProfileTooLarge));
    assert_eq!(
        profile_plan("?write=on&dry_run=true", None)
            .unwrap()
            .decode(b"")
            .err(),
        Some(BodyError::ProfileWriteConflict)
    );
}
