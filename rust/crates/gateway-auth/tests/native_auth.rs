use gateway_auth::{
    GatewayError,
    crypto::{base64url, sha256_hex},
    native::*,
    native_auth::*,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};

fn run<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}

// Unit fixture only. The actual executable must provide a persistent owned
// nonce authority and prove its behavior under process restart and OS isolation.
#[derive(Default)]
struct Nonces(Mutex<BTreeMap<String, i64>>);
impl NativeNonceAuthority for Nonces {
    async fn consume_nonce(
        &self,
        key: &str,
        nonce: &str,
        until: i64,
        now: i64,
    ) -> Result<(), GatewayError> {
        let mut rows = self.0.lock().unwrap();
        rows.retain(|_, expiry| *expiry >= now);
        let id = format!("{key}:{nonce}");
        if rows.contains_key(&id) {
            return Err(GatewayError::new(
                409,
                "Replay",
                Some("native_nonce_replayed"),
            ));
        }
        if rows.len() >= NATIVE_NONCE_CAP {
            return Err(GatewayError::unavailable(
                "Nonce capacity",
                "native_nonce_capacity",
            ));
        }
        rows.insert(id, until);
        Ok(())
    }
}
fn identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "fixture-key".into(),
        "fixture-owner".into(),
        "fixture-epoch".into(),
        [11; 32],
        BTreeSet::from([NativeCapability::ConfigurationPublish]),
    )
    .unwrap()
}

#[test]
fn real_hmac_authentication_mints_only_fresh_scoped_owner_proof() {
    run(async {
        let identity = identity();
        let nonces = Nonces::default();
        let auth = NativeAuthenticator::new(&identity, &nonces);
        let nonce = base64url(&[7; 32]);
        let timestamp = "1792339000000";
        let now = 1_792_339_000_000;
        let signature = identity.sign(NATIVE_RPC_PATH, now, &nonce, b"{}").unwrap();
        // Independently generated with Python hmac.new(key, exact NUL frame, sha256).
        assert_eq!(signature, "1Bn4FuUI4XpZJ42MfHnss_ACFrSNofnfWRMVb8d4ttI");
        let proof = auth
            .authenticate(
                NATIVE_RPC_PATH,
                NativeAuthHeaders {
                    version: "1",
                    key_id: "fixture-key",
                    time_ms: timestamp,
                    nonce: &nonce,
                    mac: &signature,
                },
                b"{}",
                now,
            )
            .await
            .unwrap();
        assert_eq!(proof.owner_id(), "fixture-owner");
        assert_eq!(proof.owner_epoch(), "fixture-epoch");
        assert_eq!(proof.transport_key_fingerprint(), sha256_hex(&[11; 32]));
        proof
            .require(NativeCapability::ConfigurationPublish, now + 1)
            .unwrap();
        proof
            .require_body(NativeCapability::ConfigurationPublish, b"{}", now)
            .unwrap();
        proof
            .require_request(
                NativeCapability::ConfigurationPublish,
                NATIVE_RPC_PATH,
                b"{}",
                now,
            )
            .unwrap();
        assert_eq!(
            proof
                .require_request(
                    NativeCapability::ConfigurationPublish,
                    NATIVE_CONTROL_PATH,
                    b"{}",
                    now
                )
                .unwrap_err()
                .status,
            403
        );
        assert_eq!(
            proof
                .require_request(NativeCapability::OwnerRenewal, NATIVE_RPC_PATH, b"{}", now)
                .unwrap_err()
                .status,
            403
        );
        assert_eq!(
            proof
                .require_body(NativeCapability::ConfigurationPublish, b"{ }", now)
                .unwrap_err()
                .status,
            403
        );
        assert_eq!(
            proof
                .require(NativeCapability::SupervisorRead, now)
                .unwrap_err()
                .status,
            403
        );
        assert_eq!(
            proof
                .require(
                    NativeCapability::ConfigurationPublish,
                    now + NATIVE_AUTH_WINDOW_MS + 1
                )
                .unwrap_err()
                .status,
            403
        );
        let replay = auth
            .authenticate(
                NATIVE_RPC_PATH,
                NativeAuthHeaders {
                    version: "1",
                    key_id: "fixture-key",
                    time_ms: timestamp,
                    nonce: &nonce,
                    mac: &signature,
                },
                b"{}",
                now + 1,
            )
            .await
            .unwrap_err();
        assert_eq!(
            replay.envelope.error.code.as_deref(),
            Some("native_nonce_replayed")
        );
        assert!(!format!("{identity:?}").contains("11, 11"));
    });
}

#[test]
fn invalid_authentication_never_spends_nonce_and_destination_or_body_changes_refuse() {
    run(async {
        let identity = identity();
        let nonces = Nonces::default();
        let auth = NativeAuthenticator::new(&identity, &nonces);
        let nonce = base64url(&[7; 32]);
        let now = 1_792_339_000_000;
        let timestamp = now.to_string();
        let mac = identity.sign(NATIVE_RPC_PATH, now, &nonce, b"{}").unwrap();
        for (path, key, time, body) in [
            (
                NATIVE_FOLLOW_PATH,
                "fixture-key",
                timestamp.as_str(),
                b"{}".as_slice(),
            ),
            (
                NATIVE_RPC_PATH,
                "other-key",
                timestamp.as_str(),
                b"{}".as_slice(),
            ),
            (
                NATIVE_RPC_PATH,
                "fixture-key",
                "01792339000000",
                b"{}".as_slice(),
            ),
            (
                NATIVE_RPC_PATH,
                "fixture-key",
                timestamp.as_str(),
                b"{ }".as_slice(),
            ),
        ] {
            assert_eq!(
                auth.authenticate(
                    path,
                    NativeAuthHeaders {
                        version: "1",
                        key_id: key,
                        time_ms: time,
                        nonce: &nonce,
                        mac: &mac
                    },
                    body,
                    now
                )
                .await
                .unwrap_err()
                .status,
                401
            );
            assert!(nonces.0.lock().unwrap().is_empty());
        }
        assert_eq!(
            auth.authenticate(
                NATIVE_RPC_PATH,
                NativeAuthHeaders {
                    version: "1",
                    key_id: "fixture-key",
                    time_ms: &timestamp,
                    nonce: &nonce,
                    mac: &mac
                },
                b"{}",
                now + NATIVE_AUTH_WINDOW_MS + 1
            )
            .await
            .unwrap_err()
            .status,
            401
        );
        assert!(nonces.0.lock().unwrap().is_empty());
    });
}

#[test]
fn live_nonce_capacity_fails_closed_without_evicting_a_replay_fence() {
    run(async {
        let identity = identity();
        let nonces = Nonces::default();
        let auth = NativeAuthenticator::new(&identity, &nonces);
        let now = 1_792_339_000_000;
        let timestamp = now.to_string();
        for index in 0..NATIVE_NONCE_CAP {
            let mut bytes = [0u8; 32];
            bytes[..8].copy_from_slice(&(index as u64).to_be_bytes());
            let nonce = base64url(&bytes);
            let mac = identity.sign(NATIVE_RPC_PATH, now, &nonce, b"{}").unwrap();
            auth.authenticate(
                NATIVE_RPC_PATH,
                NativeAuthHeaders {
                    version: "1",
                    key_id: "fixture-key",
                    time_ms: &timestamp,
                    nonce: &nonce,
                    mac: &mac,
                },
                b"{}",
                now,
            )
            .await
            .unwrap();
        }
        let nonce = base64url(&[255; 32]);
        let mac = identity.sign(NATIVE_RPC_PATH, now, &nonce, b"{}").unwrap();
        assert_eq!(
            auth.authenticate(
                NATIVE_RPC_PATH,
                NativeAuthHeaders {
                    version: "1",
                    key_id: "fixture-key",
                    time_ms: &timestamp,
                    nonce: &nonce,
                    mac: &mac
                },
                b"{}",
                now
            )
            .await
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
            Some("native_nonce_capacity")
        );
        assert_eq!(nonces.0.lock().unwrap().len(), NATIVE_NONCE_CAP);
        let nonce = base64url(&[0; 32]);
        let mac = identity.sign(NATIVE_RPC_PATH, now, &nonce, b"{}").unwrap();
        assert_eq!(
            auth.authenticate(
                NATIVE_RPC_PATH,
                NativeAuthHeaders {
                    version: "1",
                    key_id: "fixture-key",
                    time_ms: &timestamp,
                    nonce: &nonce,
                    mac: &mac
                },
                b"{}",
                now + NATIVE_AUTH_WINDOW_MS
            )
            .await
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
            Some("native_nonce_replayed")
        );
        let later = now + NATIVE_AUTH_WINDOW_MS + 1;
        let timestamp = later.to_string();
        let mac = identity
            .sign(NATIVE_RPC_PATH, later, &nonce, b"{}")
            .unwrap();
        auth.authenticate(
            NATIVE_RPC_PATH,
            NativeAuthHeaders {
                version: "1",
                key_id: "fixture-key",
                time_ms: &timestamp,
                nonce: &nonce,
                mac: &mac,
            },
            b"{}",
            later,
        )
        .await
        .unwrap();
        assert_eq!(nonces.0.lock().unwrap().len(), 1);
    });
}

#[test]
fn publication_response_hmac_has_independent_domain_and_exact_receipt_binding() {
    let identity = identity();
    let nonce = base64url(&[7; 32]);
    let response = b"{\"v\":1}";
    let signature = identity
        .sign_publication_response(&nonce, b"{}", 200, response)
        .unwrap();
    // Python hmac.new([11]*32, independently NUL-framed UTF8 fields, sha256).
    assert_eq!(signature, "T2lg-6ITeJtN3PddZXx1-DWOCK1900Msj_KtaMYB9Fo");
    identity
        .verify_publication_response(&nonce, b"{}", 200, response, &signature)
        .unwrap();
    for (request, status, body) in [
        (b"{ }".as_slice(), 200, response.as_slice()),
        (b"{}".as_slice(), 409, response.as_slice()),
        (b"{}".as_slice(), 200, b"{\"v\":2}".as_slice()),
    ] {
        assert!(
            identity
                .verify_publication_response(&nonce, request, status, body, &signature)
                .is_err()
        );
    }
    assert!(
        identity
            .verify_publication_response(&base64url(&[8; 32]), b"{}", 200, response, &signature)
            .is_err()
    );
    assert_ne!(
        identity
            .sign(
                gateway_auth::native::NATIVE_PUBLICATION_PATH,
                1_792_339_000_000,
                &nonce,
                response
            )
            .unwrap(),
        signature
    );
}
