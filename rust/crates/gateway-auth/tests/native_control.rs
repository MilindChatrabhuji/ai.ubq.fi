use gateway_auth::{
    crypto::base64url,
    native::*,
    native_auth::{NativeCapability, NativeTransportIdentity},
    native_control::*,
};
use std::collections::BTreeSet;

const REQUEST: &[u8] = br#"{"v":1,"operation_id":"operation-1","request":{"operation":"codex_renew_access","action_ref":"action-1"}}"#;

#[test]
fn native_control_has_one_strict_reference_operation() {
    let request = NativeControlEnvelope::parse(REQUEST).unwrap();
    assert_eq!(request.operation_id, "operation-1");
    for body in [
        r#"{"v":1,"operation_id":"op","request":{"operation":"codex_recover_quota","action_ref":"a"}}"#,
        r#"{"v":1,"operation_id":"op","request":{"operation":"codex_renew_access","action_ref":"a","refreshToken":true}}"#,
        r#"{"v":1,"operation_id":"op","request":{"operation":"codex_renew_access","action_ref":"a"},"authorized":true}"#,
        r#"{"v":1,"operation_id":"op","operation_id":"different","request":{"operation":"codex_renew_access","action_ref":"a"}}"#,
        r#"{"v":1,"operation_id":"op","request":{"operation":"codex_renew_access","action_ref":"a","action_ref":"b"}}"#,
        r#"{"v":2,"operation_id":"op","request":{"operation":"codex_renew_access","action_ref":"a"}}"#,
        r#"{"v":1,"operation_id":"op","request":{"operation":"codex_renew_access","action_ref":""}}"#,
        r#"{"v":1,"operation_id":"op","request":{"operation":"codex_renew_access","action_ref":"/tmp/auth.json"}}"#,
    ] {
        assert!(
            NativeControlEnvelope::parse(body.as_bytes()).is_err(),
            "{body}"
        );
    }
    assert!(NativeControlEnvelope::parse(&vec![b' '; NATIVE_CONTROL_MAX_BYTES + 1]).is_err());
}

#[test]
fn success_requires_matching_operation_and_durable_publication_revision() {
    let request = NativeControlEnvelope::parse(REQUEST).unwrap();
    let mut response = NativeControlResponse {
        v: 1,
        operation_id: request.operation_id.clone(),
        disposition: NativeControlDisposition::Published,
        publication_revision: Some("publication-1".into()),
        reason: None,
    };
    response.validate_for(&request).unwrap();
    response.publication_revision = None;
    assert!(response.validate_for(&request).is_err());
    response.disposition = NativeControlDisposition::Unknown;
    response.reason = Some(NativeControlReason::OutcomeUnknown);
    response.validate_for(&request).unwrap();
    response.operation_id = "operation-2".into();
    assert!(response.validate_for(&request).is_err());
}

fn identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "fixture-key".into(),
        "fixture-owner".into(),
        "fixture-epoch".into(),
        [11; 32],
        BTreeSet::from([NativeCapability::OwnerRenewal]),
    )
    .unwrap()
}

#[test]
fn control_response_mac_has_independent_exact_request_status_nonce_domain() {
    let identity = identity();
    let nonce = base64url(&[7; 32]);
    let reply = br#"{"v":1}"#;
    let signature = identity
        .sign_control_response(&nonce, b"{}", 200, reply)
        .unwrap();
    // Independent Python HMAC-SHA256 over the exact NUL-separated fields.
    assert_eq!(signature, "RglfiBjJIDSdUVJaW1iIb9q5ZmgFyEuv7c_xnpleG6A");
    identity
        .verify_control_response(&nonce, b"{}", 200, reply, &signature)
        .unwrap();
    for (request, status, response) in [
        (b"{ }".as_slice(), 200, reply.as_slice()),
        (b"{}".as_slice(), 409, reply.as_slice()),
        (b"{}".as_slice(), 200, b"{}".as_slice()),
    ] {
        assert!(
            identity
                .verify_control_response(&nonce, request, status, response, &signature)
                .is_err()
        );
    }
    assert!(
        identity
            .verify_control_response(&base64url(&[8; 32]), b"{}", 200, reply, &signature)
            .is_err()
    );
    assert!(
        identity
            .verify_publication_response(&nonce, b"{}", 200, reply, &signature)
            .is_err()
    );
    let publication = identity
        .sign_publication_response(&nonce, b"{}", 200, reply)
        .unwrap();
    assert!(
        identity
            .verify_control_response(&nonce, b"{}", 200, reply, &publication)
            .is_err()
    );
}

#[test]
fn control_frame_limits_are_smaller_without_changing_read_or_publication_limits() {
    let identity = identity();
    let nonce = base64url(&[7; 32]);
    let body = vec![b'x'; NATIVE_CONTROL_MAX_BYTES + 1];
    assert!(
        identity
            .sign(NATIVE_CONTROL_PATH, 1, &nonce, &body)
            .is_err()
    );
    identity.sign(NATIVE_RPC_PATH, 1, &nonce, &body).unwrap();
    identity
        .sign(NATIVE_PUBLICATION_PATH, 1, &nonce, &body)
        .unwrap();
    assert!(
        identity
            .sign_control_response(&nonce, b"{}", 200, &body)
            .is_err()
    );
    assert!(
        identity
            .sign_control_response(
                &nonce,
                b"{}",
                400,
                &vec![b'x'; NATIVE_CONTROL_ERROR_MAX_BYTES + 1]
            )
            .is_err()
    );
}

#[test]
fn reverse_authority_response_mac_isolated_from_forward_control_and_publication() {
    let identity = identity();
    let nonce = base64url(&[7; 32]);
    let reply = br#"{"v":1}"#;
    let signature = identity
        .sign_authority_response(&nonce, b"{}", 200, reply)
        .unwrap();
    // Independently computed Python HMAC-SHA256 over the exact reverse frame.
    assert_eq!(signature, "dWEc77PeP5zjOK0mSmI6ZAPQ_hcfCvpaRzNXUGKvoy4");
    identity
        .verify_authority_response(&nonce, b"{}", 200, reply, &signature)
        .unwrap();
    assert!(
        identity
            .verify_control_response(&nonce, b"{}", 200, reply, &signature)
            .is_err()
    );
    assert!(
        identity
            .verify_publication_response(&nonce, b"{}", 200, reply, &signature)
            .is_err()
    );
    assert!(
        identity
            .verify_authority_response(&nonce, b"{}", 409, reply, &signature)
            .is_err()
    );
    assert!(
        identity
            .verify_authority_response(&nonce, b"{ }", 200, reply, &signature)
            .is_err()
    );
    assert!(
        identity
            .verify_authority_response(&base64url(&[8; 32]), b"{}", 200, reply, &signature)
            .is_err()
    );
    let medium = vec![b'x'; NATIVE_CONTROL_MAX_BYTES + 1];
    identity
        .sign(NATIVE_RENEWAL_AUTHORITY_PATH, 1, &nonce, &medium)
        .unwrap();
    assert!(
        identity
            .sign(
                NATIVE_RENEWAL_AUTHORITY_PATH,
                1,
                &nonce,
                &vec![b'x'; NATIVE_AUTHORITY_MAX_BYTES + 1]
            )
            .is_err()
    );
}
