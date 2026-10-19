use super::*;
use std::{
    collections::BTreeSet,
    future::Future,
    pin::pin,
    sync::Mutex,
    task::{Context, Poll, Waker},
};

fn run<T>(future: impl Future<Output = T>) -> T {
    let mut future = pin!(future);
    let waker = Waker::noop();
    match future.as_mut().poll(&mut Context::from_waker(waker)) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("fixture unexpectedly suspended"),
    }
}
#[derive(Default)]
struct Nonces(Mutex<BTreeSet<String>>);
impl NativeNonceAuthority for Nonces {
    async fn consume_nonce(
        &self,
        _: &str,
        nonce: &str,
        _: i64,
        _: i64,
    ) -> Result<(), GatewayError> {
        if self.0.lock().unwrap().insert(nonce.into()) {
            Ok(())
        } else {
            Err(invalid())
        }
    }
}
fn identity_for(capability: NativeCapability) -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "live-fixture".into(),
        "owner".into(),
        "epoch".into(),
        [37; 32],
        BTreeSet::from([capability]),
    )
    .unwrap()
}
fn headers<'a>(nonce: &'a str, mac: &'a str) -> NativeAuthHeaders<'a> {
    NativeAuthHeaders {
        version: "1",
        key_id: "live-fixture",
        time_ms: "1000",
        nonce,
        mac,
    }
}

#[test]
fn fixed_get_frame_has_no_post_cross_purpose_or_opaque_reference_ambiguity() {
    let nonce = base64url(&[1; 32]);
    let frame = request_signature_input("live-fixture", 1000, &nonce, "action-ref").unwrap();
    assert!(frame.starts_with(b"uos-native-live-upgrade-v1\0GET\0/v1/native/live\0"));
    assert_ne!(
        frame,
        authority_signature_input("live-fixture", 1000, &nonce, b"action-ref").unwrap()
    );
    for reference in ["", "https://caller", "a/b", "a\0b", "a?account=x"] {
        assert!(request_signature_input("live-fixture", 1000, &nonce, reference).is_err());
    }
    assert!(request_signature_input("live-fixture", 1000, "noncanonical", "action-ref").is_err());
}

#[test]
fn upgrade_proof_requires_live_capability_current_time_exact_action_and_persistent_replay_owner() {
    let identity = identity_for(NativeCapability::LiveSideband);
    let nonces = Nonces::default();
    let auth = NativeLiveAuthenticator::new(&identity, &nonces);
    let nonce = base64url(&[2; 32]);
    let mac = identity
        .sign_live_request(1000, &nonce, "action-ref")
        .unwrap();
    assert!(run(auth.authenticate_upgrade(headers(&nonce, &mac), "different-ref", 1000)).is_err());
    assert!(nonces.0.lock().unwrap().is_empty());
    let proof = run(auth.authenticate_upgrade(headers(&nonce, &mac), "action-ref", 1000)).unwrap();
    assert_eq!(proof.owner_id(), "owner");
    assert_eq!(proof.owner_epoch(), "epoch");
    assert!(proof.require_upgrade("action-ref", 1000).is_ok());
    assert!(proof.require_upgrade("action-ref", 31_001).is_err());
    assert!(proof.require_upgrade("other", 1000).is_err());
    assert!(
        proof
            .require_authority_request(b"action-ref", 1000)
            .is_err()
    );
    assert!(run(auth.authenticate_upgrade(headers(&nonce, &mac), "action-ref", 1000)).is_err());
    assert!(
        identity_for(NativeCapability::SupervisorRead)
            .sign_live_request(1000, &nonce, "action-ref")
            .is_err()
    );
}

#[test]
fn reverse_request_and_response_mac_bind_all_exact_bytes_and_cannot_cross_domains() {
    let identity = identity_for(NativeCapability::LiveSideband);
    let nonces = Nonces::default();
    let auth = NativeLiveAuthenticator::new(&identity, &nonces);
    let nonce = base64url(&[3; 32]);
    let body = br#"{"operation":"authorize","v":1,"action_ref":"a","connection_id":"c"}"#;
    let mac = identity
        .sign_live_authority_request(1000, &nonce, body)
        .unwrap();
    let proof = run(auth.authenticate_authority(headers(&nonce, &mac), body, 1000)).unwrap();
    assert!(proof.require_authority_request(body, 1000).is_ok());
    assert!(proof.require_authority_request(b"{}", 1000).is_err());
    assert!(proof.require_upgrade("a", 1000).is_err());
    let response = br#"{"operation":"authorize","v":1}"#;
    let response_mac = identity
        .sign_live_authority_response(&nonce, body, 200, response)
        .unwrap();
    assert!(
        identity
            .verify_live_authority_response(&nonce, body, 200, response, &response_mac)
            .is_ok()
    );
    assert!(
        identity
            .verify_live_authority_response(&nonce, body, 201, response, &response_mac)
            .is_err()
    );
    assert!(
        identity
            .verify_live_authority_response(&nonce, b"{}", 200, response, &response_mac)
            .is_err()
    );
    assert!(
        identity
            .verify_live_authority_response(&nonce, body, 200, b"{}", &response_mac)
            .is_err()
    );
    let control = identity
        .sign_control_response(&nonce, body, 200, response)
        .unwrap();
    assert!(
        identity
            .verify_live_authority_response(&nonce, body, 200, response, &control)
            .is_err()
    );
    assert!(authority_signature_input("live-fixture", 1000, &nonce, &vec![0; 65_537]).is_err());
}
