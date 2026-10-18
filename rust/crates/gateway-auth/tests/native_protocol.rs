use gateway_auth::{AuthResponse, crypto::base64url, native::*};
use serde_json::{Value, json};

#[test]
fn private_wire_rejects_open_commands_paths_and_extra_fields() {
    for request in [
        json!({"operation":"supervisor_sessions"}),
        json!({"operation":"supervisor_output","source_id":"fixture","thread_id":"thread","cursor":null}),
        json!({"operation":"supervisor_brief","source_id":"fixture","thread_id":"thread"}),
    ] {
        let value = json!({"v":1,"request":request});
        serde_json::from_value::<NativeRpcEnvelope>(value)
            .unwrap()
            .validate()
            .unwrap();
    }
    for value in [
        json!({"v":1,"request":{"operation":"turn_start","thread_id":"thread"}}),
        json!({"v":1,"request":{"operation":"supervisor_sessions","url":"https://caller.example"}}),
        json!({"v":1,"request":{"operation":"supervisor_output","source_id":"fixture","thread_id":"thread","cursor":null,"path":"/private"}}),
        json!({"v":1,"request":{"operation":"supervisor_sessions"},"refresh_token":"forbidden"}),
    ] {
        assert!(serde_json::from_value::<NativeRpcEnvelope>(value).is_err());
    }
    assert!(
        serde_json::from_value::<NativeRpcEnvelope>(
            json!({"v":2,"request":{"operation":"supervisor_sessions"}})
        )
        .unwrap()
        .validate()
        .is_err()
    );
}

#[test]
fn authentication_frame_binds_destination_identity_time_nonce_and_exact_body_bytes() {
    let nonce = base64url(&[0; 32]);
    let input = signature_input(NATIVE_RPC_PATH, "fixture", 1234, &nonce, b"{}").unwrap();
    let expected = format!(
        "uos-native-http-v1\0POST\0/v1/native/rpc\0fixture\01234\0{nonce}\044136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
    assert_eq!(input, expected.into_bytes());
    for changed in [
        signature_input(NATIVE_FOLLOW_PATH, "fixture", 1234, &nonce, b"{}").unwrap(),
        signature_input(NATIVE_RPC_PATH, "other", 1234, &nonce, b"{}").unwrap(),
        signature_input(NATIVE_RPC_PATH, "fixture", 1235, &nonce, b"{}").unwrap(),
        signature_input(
            NATIVE_RPC_PATH,
            "fixture",
            1234,
            &base64url(&[1; 32]),
            b"{}",
        )
        .unwrap(),
        signature_input(NATIVE_RPC_PATH, "fixture", 1234, &nonce, b"{ }").unwrap(),
    ] {
        assert_ne!(input, changed);
    }
    for (path, key, time, nonce) in [
        ("https://caller.example", "fixture", 1234, nonce.as_str()),
        (NATIVE_RPC_PATH, "bad\0key", 1234, nonce.as_str()),
        (NATIVE_RPC_PATH, "fixture", -1, nonce.as_str()),
        (NATIVE_RPC_PATH, "fixture", 1234, "not-a-nonce"),
    ] {
        assert!(signature_input(path, key, time, nonce, b"{}").is_err());
    }
    assert!(
        signature_input(
            NATIVE_RPC_PATH,
            "fixture",
            1234,
            &nonce,
            &vec![0; NATIVE_MAX_BODY_BYTES + 1]
        )
        .is_err()
    );
}

#[test]
fn follow_descriptor_cannot_be_substituted_or_replaced_by_json_success() {
    let request = NativeRpcEnvelope {
        v: 1,
        request: NativeReadRequest::SupervisorOutput {
            source_id: "fixture".into(),
            thread_id: "thread".into(),
            cursor: None,
        },
    };
    let stream = AuthStream::SupervisorFollow {
        source_id: "fixture".into(),
        thread_id: "thread".into(),
        cursor: None,
    };
    let mut response = NativeRpcResponse {
        v: 1,
        status: 200,
        body: Value::Null,
        stream: Some(stream.clone()),
    };
    response.validate_for(&request).unwrap();
    response.stream = None;
    assert!(response.validate_for(&request).is_err());
    response.status = 409;
    response.validate_for(&request).unwrap();
    response.status = 200;
    response.stream = Some(AuthStream::SupervisorFollow {
        source_id: "other".into(),
        thread_id: "thread".into(),
        cursor: None,
    });
    assert!(response.validate_for(&request).is_err());
    let json = AuthResponse::json(200, json!({"value":"same JSON API"}));
    assert_eq!(json.stream, None);
    assert_eq!(json.body, json!({"value":"same JSON API"}));
    assert_eq!(json.with_stream(stream.clone()).stream, Some(stream));
}
