use super::*;
fn binding() -> SourceJson {
    SourceJson::parse(r#"{"account_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","account_cohort_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","evidence_generation":"cccccccc-cccc-cccc-cccc-cccccccccccc","credential_fingerprint":"PLACEHOLDER","credential":{"secret":"sk-ant-\ud800","kind":"api_key","source":"kv","updated_at_ms":100},"workspace":{"id":"wrkspc_\udc00"}}"#.replace("PLACEHOLDER",&fingerprint("api_key",&JsString16::from_units(vec![115,107,45,97,110,116,45,0xd800]),Some(&JsString16::from_units(vec![119,114,107,115,112,99,95,0xdc00]))).unwrap()).as_str()).unwrap()
}
#[test]
fn named_binding_accepts_original_secret_and_workspace_units() {
    let value = binding();
    let parsed = parse_binding(&value).unwrap();
    assert_eq!(
        parsed.workspace_id,
        Some(JsString16::from_units(vec![
            119, 114, 107, 115, 112, 99, 95, 0xdc00
        ]))
    );
    let changed =
        SourceJson::parse(&value.as_str().replace(r"sk-ant-\ud800", r"sk-ant-\ufffd")).unwrap();
    assert!(parse_binding(&changed).is_err());
}
#[test]
fn binding_generation_ids_keep_the_original_finite_domain() {
    let value = binding();
    let changed = SourceJson::parse(
        &value
            .as_str()
            .replace("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", r"\ud800"),
    )
    .unwrap();
    assert!(parse_binding(&changed).is_err());
}
