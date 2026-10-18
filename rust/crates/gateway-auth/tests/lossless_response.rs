use gateway_auth::AuthResponse;
use gateway_core::{js_string::JsString16, source_json::SourceJson};
use serde::Serialize;
use serde_json::json;

#[derive(Serialize)]
struct OperatorError {
    message: JsString16,
}

#[test]
fn source_response_body_emits_real_json_string_without_private_tags_or_double_escaping() {
    let raw = SourceJson::from_serializable(&OperatorError {
        message: JsString16::from_units(vec![0xd83d]),
    })
    .unwrap();
    let response = AuthResponse::source_json(200, raw);
    assert_eq!(response.status, 200);
    assert_eq!(response.headers["content-type"], "application/json");
    assert!(response.body.as_json().is_none());
    let bytes = response.body.to_bytes().unwrap();
    assert_eq!(bytes, br#"{"message":"\ud83d"}"#);
    assert!(serde_json::from_slice::<serde_json::Value>(&bytes).is_err());
    let members = SourceJson::parse_bytes(&bytes)
        .unwrap()
        .object_entries()
        .unwrap();
    assert_eq!(
        members[0].1.deserialize::<JsString16>().unwrap().as_units(),
        &[0xd83d]
    );
    assert!(serde_json::to_value(&response.body).is_err());
}

#[test]
fn ordinary_json_response_bytes_headers_and_inspection_remain_unchanged() {
    let value = json!({"message":"ordinary 😀","value":7});
    let response = AuthResponse::json(201, value.clone());
    assert_eq!(response.body, value);
    assert_eq!(response.body.as_json().unwrap()["value"], 7);
    assert_eq!(
        response.body.as_json().unwrap().get("message").unwrap(),
        "ordinary 😀"
    );
    assert_eq!(
        response.body.to_bytes().unwrap(),
        serde_json::to_vec(&value).unwrap()
    );
    assert_eq!(serde_json::to_value(&response.body).unwrap(), value);
    assert_eq!(response.headers["cache-control"], "no-store");
}
