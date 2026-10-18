//! Executed SimpleWebAuthn 13.2.2 goldens. Fixture clocks are historical test
//! inputs; the product service supplies only its actual AuthHost clock.
use ciborium::value::Value as Cbor;
use gateway_auth::{
    GatewayError,
    crypto::{base64url, decode_base64url},
    passkeys::{AssertionVerification, PasskeyCredential, RegistrationVerification},
    webauthn::*,
};
use serde_json::Value;
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};
fn run<F: Future>(future: F) -> F::Output {
    let mut cx = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        std::thread::yield_now();
    }
}
fn integer(n: i64) -> Cbor {
    Cbor::Integer(n.into())
}
fn cose(key: &CosePublicKey) -> Vec<u8> {
    let value =
        |name: &str| Cbor::Bytes(decode_base64url(key.jwk[name].as_str().unwrap()).unwrap());
    let fields = match key.jwk["kty"].as_str().unwrap() {
        "EC" => vec![
            (integer(1), integer(2)),
            (integer(3), integer(key.algorithm.cose_id())),
            (
                integer(-1),
                integer(match key.jwk["crv"].as_str().unwrap() {
                    "P-256" => 1,
                    "P-384" => 2,
                    _ => 3,
                }),
            ),
            (integer(-2), value("x")),
            (integer(-3), value("y")),
        ],
        "RSA" => vec![
            (integer(1), integer(3)),
            (integer(3), integer(key.algorithm.cose_id())),
            (integer(-1), value("n")),
            (integer(-2), value("e")),
        ],
        _ => vec![
            (integer(1), integer(1)),
            (integer(3), integer(-8)),
            (integer(-1), integer(6)),
            (integer(-2), value("x")),
        ],
    };
    let mut bytes = vec![];
    ciborium::into_writer(&Cbor::Map(fields), &mut bytes).unwrap();
    bytes
}
struct MaintainedCrypto;
impl WebAuthnCrypto for MaintainedCrypto {
    async fn validate_key(&self, key: &CosePublicKey) -> Result<(), GatewayError> {
        webauthn_rs_core::source_compat::validate_public_key(&cose(key))
            .map_err(|_| gateway_auth::invalid("Invalid real COSE key"))
    }
    async fn verify_signature(&self, input: SignatureInput) -> Result<bool, GatewayError> {
        let signature = match (input.key.jwk["kty"].as_str(), input.key.jwk["crv"].as_str()) {
            (Some("EC"), Some("P-256")) => p256::ecdsa::Signature::from_slice(&input.signature)
                .unwrap()
                .to_der()
                .as_bytes()
                .to_vec(),
            (Some("EC"), Some("P-384")) => p384::ecdsa::Signature::from_slice(&input.signature)
                .unwrap()
                .to_der()
                .as_bytes()
                .to_vec(),
            (Some("EC"), Some("P-521")) => p521::ecdsa::Signature::from_slice(&input.signature)
                .unwrap()
                .to_der()
                .as_bytes()
                .to_vec(),
            _ => input.signature,
        };
        webauthn_rs_core::source_compat::verify_public_key_signature(
            &cose(&input.key),
            &signature,
            &input.data,
        )
        .map_err(|_| gateway_auth::invalid("Invalid real signature"))
    }
}
#[test]
fn source_golden_registration_formats_and_exact_storage_bytes() {
    let data: Value =
        serde_json::from_str(include_str!("fixtures/webauthn-source-golden.json")).unwrap();
    let mut failures = Vec::new();
    for case in data["cases"].as_array().unwrap() {
        let input = RegistrationVerification {
            response: case["response"].clone(),
            challenge: case["challenge"].as_str().unwrap().into(),
            origin: case["origin"].as_str().unwrap().into(),
            rp_id: case["rp_id"].as_str().unwrap().into(),
            require_user_verification: case["require_user_verification"].as_bool().unwrap(),
        };
        let result = run(verify_registration(
            &MaintainedCrypto,
            input,
            case["now_ms"].as_i64().unwrap(),
        ));
        if result.is_ok() != case["expected_success"].as_bool().unwrap() {
            failures.push(format!("{}: {result:?}", case["name"]));
        }
        if let Ok(result) = result
            && let Some(expected_key) = case["public_key"].as_str()
        {
            assert_eq!(
                base64url(&result.public_key),
                expected_key,
                "{}",
                case["name"]
            );
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn source_generated_algorithm_ceremonies_and_current_role_metadata() {
    let data: Value =
        serde_json::from_str(include_str!("fixtures/webauthn-algorithm-golden.json")).unwrap();
    for case in data["cases"].as_array().unwrap() {
        if case["kind"] == "registration" {
            let input = RegistrationVerification {
                response: case["response"].clone(),
                challenge: case["challenge"].as_str().unwrap().into(),
                origin: case["origin"].as_str().unwrap().into(),
                rp_id: case["rp_id"].as_str().unwrap().into(),
                require_user_verification: case["require_user_verification"].as_bool().unwrap(),
            };
            let result = run(verify_registration(
                &MaintainedCrypto,
                input,
                case["now_ms"].as_i64().unwrap(),
            ));
            assert_eq!(
                result.is_ok(),
                case["expected_success"].as_bool().unwrap(),
                "{}: {result:?}",
                case["name"]
            );
            if let Ok(result) = result {
                assert_eq!(
                    base64url(&result.public_key),
                    case["public_key"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
            }
        } else {
            let input = AssertionVerification {
                response: case["response"].clone(),
                challenge: case["challenge"].as_str().unwrap().into(),
                origin: case["origin"].as_str().unwrap().into(),
                rp_id: case["rp_id"].as_str().unwrap().into(),
                require_user_verification: case["require_user_verification"].as_bool().unwrap(),
                credential: PasskeyCredential {
                    credential_id: case["credential_id"].as_str().unwrap().into(),
                    user_id: "legacy-no-UV-or-backup-metadata".into(),
                    public_key: case["public_key"].as_str().unwrap().into(),
                    sign_count: case["sign_count"].as_u64().unwrap() as u32,
                    transports: vec![],
                    created_at_ms: 0,
                },
            };
            let result = run(verify_assertion(&MaintainedCrypto, input.clone()));
            assert_eq!(
                result.is_ok(),
                case["expected_success"].as_bool().unwrap(),
                "{}: {result:?}",
                case["name"]
            );
            if result.is_ok() {
                let mut bad = input;
                let mut signature =
                    decode_base64url(bad.response["response"]["signature"].as_str().unwrap())
                        .unwrap();
                let last = signature.len() - 1;
                signature[last] ^= 1;
                bad.response["response"]["signature"] = Value::String(base64url(&signature));
                assert!(
                    run(verify_assertion(&MaintainedCrypto, bad)).is_err(),
                    "{} invalid signature",
                    case["name"]
                );
            }
        }
    }
}

struct CrlCrypto(&'static [u8]);
impl WebAuthnCrypto for CrlCrypto {
    async fn fetch_certificate_revocation_list(&self, _: &str) -> Result<Vec<u8>, GatewayError> {
        Ok(self.0.to_vec())
    }
    async fn validate_key(&self, key: &CosePublicKey) -> Result<(), GatewayError> {
        MaintainedCrypto.validate_key(key).await
    }
    async fn verify_signature(&self, input: SignatureInput) -> Result<bool, GatewayError> {
        MaintainedCrypto.verify_signature(input).await
    }
}
#[test]
fn downloaded_der_revocation_and_source_best_effort_failure_semantics() {
    let data: Value =
        serde_json::from_str(include_str!("fixtures/webauthn-source-golden.json")).unwrap();
    let case = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "safetyNetUsingGSR1RootCert")
        .unwrap();
    let input = RegistrationVerification {
        response: case["response"].clone(),
        challenge: case["challenge"].as_str().unwrap().into(),
        origin: case["origin"].as_str().unwrap().into(),
        rp_id: case["rp_id"].as_str().unwrap().into(),
        require_user_verification: false,
    };
    let now = case["now_ms"].as_i64().unwrap();
    assert!(
        run(verify_registration(
            &CrlCrypto(b"invalid DER"),
            input.clone(),
            now
        ))
        .is_ok()
    );
    let error = run(verify_registration(
        &CrlCrypto(include_bytes!("fixtures/webauthn-revoked-safetynet.crl")),
        input,
        now,
    ))
    .unwrap_err();
    assert!(error.envelope.error.message.contains("Revoked passkey"));
}
#[test]
fn host_clock_rejects_negative_and_unsafe_integer_time() {
    let data: Value =
        serde_json::from_str(include_str!("fixtures/webauthn-algorithm-golden.json")).unwrap();
    let case = &data["cases"][0];
    for now in [-1, 9_007_199_254_740_992] {
        let input = RegistrationVerification {
            response: case["response"].clone(),
            challenge: case["challenge"].as_str().unwrap().into(),
            origin: case["origin"].as_str().unwrap().into(),
            rp_id: case["rp_id"].as_str().unwrap().into(),
            require_user_verification: true,
        };
        assert_eq!(
            run(verify_registration(&MaintainedCrypto, input, now))
                .unwrap_err()
                .envelope
                .error
                .code
                .as_deref(),
            Some("auth_clock_unavailable")
        );
    }
}
