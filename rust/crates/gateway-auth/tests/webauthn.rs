use ciborium::value::Value as Cbor;
use gateway_auth::{
    GatewayError,
    crypto::{base64url, decode_base64url},
    passkeys::{AssertionVerification, PasskeyCredential, RegistrationVerification},
    webauthn::*,
};
use p256::ecdsa::{
    Signature, SigningKey, VerifyingKey,
    signature::{Signer, Verifier},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    future::Future,
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
fn signing() -> SigningKey {
    SigningKey::from_bytes((&[7u8; 32]).into()).unwrap()
}
fn cbor(value: &Cbor) -> Vec<u8> {
    let mut output = Vec::new();
    ciborium::into_writer(value, &mut output).unwrap();
    output
}
fn integer(value: i64) -> Cbor {
    Cbor::Integer(value.into())
}
fn public_key() -> Vec<u8> {
    let key = signing().verifying_key().to_encoded_point(false);
    cbor(&Cbor::Map(vec![
        (integer(1), integer(2)),
        (integer(3), integer(-7)),
        (integer(-1), integer(1)),
        (integer(-2), Cbor::Bytes(key.x().unwrap().to_vec())),
        (integer(-3), Cbor::Bytes(key.y().unwrap().to_vec())),
    ]))
}

struct RealP256;
impl WebAuthnCrypto for RealP256 {
    async fn validate_key(&self, key: &CosePublicKey) -> Result<(), GatewayError> {
        let mut point = vec![4];
        point.extend(decode_base64url(key.jwk["x"].as_str().unwrap())?);
        point.extend(decode_base64url(key.jwk["y"].as_str().unwrap())?);
        p256::PublicKey::from_sec1_bytes(&point)
            .map_err(|_| gateway_auth::invalid("Invalid curve point"))?;
        Ok(())
    }
    async fn verify_signature(&self, input: SignatureInput) -> Result<bool, GatewayError> {
        let mut point = vec![4];
        point.extend(decode_base64url(input.key.jwk["x"].as_str().unwrap())?);
        point.extend(decode_base64url(input.key.jwk["y"].as_str().unwrap())?);
        let key = VerifyingKey::from_sec1_bytes(&point)
            .map_err(|_| gateway_auth::invalid("Invalid curve point"))?;
        let signature = Signature::from_slice(&input.signature)
            .map_err(|_| gateway_auth::invalid("Invalid signature"))?;
        Ok(key.verify(&input.data, &signature).is_ok())
    }
}

fn assertion(flags: u8, counter: u32) -> AssertionVerification {
    let client =
        json!({"type":"webauthn.get","challenge":"issued-challenge","origin":"https://ai.ubq.fi"})
            .to_string()
            .into_bytes();
    let mut auth = Sha256::digest(b"ai.ubq.fi").to_vec();
    auth.push(flags);
    auth.extend(counter.to_be_bytes());
    let mut signed = auth.clone();
    signed.extend(Sha256::digest(&client));
    let signature: Signature = signing().sign(&signed);
    let response = json!({"id":"Y3JlZGVudGlhbA","rawId":"Y3JlZGVudGlhbA","type":"public-key","response":{"clientDataJSON":base64url(&client),"authenticatorData":base64url(&auth),"signature":base64url(signature.to_der().as_bytes())}});
    AssertionVerification {
        response,
        challenge: "issued-challenge".into(),
        origin: "https://ai.ubq.fi".into(),
        rp_id: "ai.ubq.fi".into(),
        require_user_verification: true,
        credential: PasskeyCredential {
            credential_id: "Y3JlZGVudGlhbA".into(),
            user_id: "user".into(),
            public_key: base64url(&public_key()),
            sign_count: 1,
            transports: vec![],
            created_at_ms: 0,
        },
    }
}

#[test]
fn actual_p256_signature_verifies_and_wire_tampering_fails() {
    run(async {
        assert_eq!(
            verify_assertion(&RealP256, assertion(5, 2)).await.unwrap(),
            2
        );
        let mut input = assertion(5, 2);
        let mut auth = decode_base64url(
            input.response["response"]["authenticatorData"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        auth[36] = 3;
        input.response["response"]["authenticatorData"] = json!(base64url(&auth));
        assert!(verify_assertion(&RealP256, input).await.is_err());
    });
}

#[test]
fn assertion_requires_exact_challenge_origin_rp_and_current_uv() {
    run(async {
        for field in ["challenge", "origin", "rp_id"] {
            let mut input = assertion(5, 2);
            match field {
                "challenge" => input.challenge = "other".into(),
                "origin" => input.origin = "https://evil.example".into(),
                _ => input.rp_id = "evil.example".into(),
            };
            assert!(verify_assertion(&RealP256, input).await.is_err(), "{field}");
        }
        assert!(verify_assertion(&RealP256, assertion(1, 2)).await.is_err());
        let mut non_admin = assertion(1, 2);
        non_admin.require_user_verification = false;
        assert!(verify_assertion(&RealP256, non_admin).await.is_ok());
        assert!(verify_assertion(&RealP256, assertion(4, 2)).await.is_err());
        assert!(verify_assertion(&RealP256, assertion(21, 2)).await.is_err());
    });
}

#[test]
fn counter_replay_and_malformed_algorithm_or_key_are_refused() {
    run(async {
        assert!(verify_assertion(&RealP256, assertion(5, 1)).await.is_err());
        let mut zero = assertion(5, 0);
        zero.credential.sign_count = 0;
        assert!(verify_assertion(&RealP256, zero).await.is_ok());
        let mut cose: Cbor = ciborium::from_reader(public_key().as_slice()).unwrap();
        if let Cbor::Map(entries) = &mut cose {
            entries
                .iter_mut()
                .find(|(key, _)| *key == integer(3))
                .unwrap()
                .1 = integer(-8);
        }
        assert!(parse_cose_key(&cbor(&cose)).is_err());
        assert!(parse_cose_key(&[0xa1, 1, 2]).is_err());
        assert!(SignatureAlgorithm::parse(-999).is_err());
    });
}

fn registration(format: &str) -> RegistrationVerification {
    let client =
        json!({"type":"webauthn.create","challenge":"issued","origin":"https://ai.ubq.fi"})
            .to_string()
            .into_bytes();
    let mut auth = Sha256::digest(b"ai.ubq.fi").to_vec();
    auth.push(69);
    auth.extend(0u32.to_be_bytes());
    auth.extend([0u8; 16]);
    let id = b"credential";
    auth.extend((id.len() as u16).to_be_bytes());
    auth.extend(id);
    auth.extend(public_key());
    let object = cbor(&Cbor::Map(vec![
        (Cbor::Text("fmt".into()), Cbor::Text(format.into())),
        (Cbor::Text("attStmt".into()), Cbor::Map(vec![])),
        (Cbor::Text("authData".into()), Cbor::Bytes(auth)),
    ]));
    RegistrationVerification {
        response: json!({"id":base64url(id),"rawId":base64url(id),"type":"public-key","response":{"clientDataJSON":base64url(&client),"attestationObject":base64url(&object),"transports":["internal"]}}),
        challenge: "issued".into(),
        origin: "https://ai.ubq.fi".into(),
        rp_id: "ai.ubq.fi".into(),
        require_user_verification: true,
    }
}

#[test]
fn none_registration_validates_real_key_and_retains_exact_cose() {
    run(async {
        let verified = verify_registration(&RealP256, registration("none"), 1_792_336_000_000)
            .await
            .unwrap();
        assert_eq!(verified.public_key, public_key());
        assert_eq!(verified.credential_id, base64url(b"credential"));
        assert_eq!(verified.transports, vec!["internal"]);
        let mut wrong = registration("none");
        wrong.rp_id = "other.example".into();
        assert!(
            verify_registration(&RealP256, wrong, 1_792_336_000_000)
                .await
                .is_err()
        );
    });
}

#[test]
fn malformed_attestations_fail_closed_after_maintained_verification() {
    run(async {
        for format in [
            "packed",
            "fido-u2f",
            "tpm",
            "android-key",
            "android-safetynet",
            "apple",
        ] {
            let error = verify_registration(&RealP256, registration(format), 1_792_336_000_000)
                .await
                .unwrap_err();
            assert_eq!(error.status, 400, "{format}");
        }
        assert_eq!(
            verify_registration(&RealP256, registration("invented"), 1_792_336_000_000)
                .await
                .unwrap_err()
                .status,
            400
        );
    });
}

#[test]
fn real_algorithm_matrix_preserves_source_acceptance_and_webcrypto_parameters() {
    for id in [-8, -7, -36, -37, -38, -39, -257, -258, -259, -65535] {
        assert_eq!(SignatureAlgorithm::parse(id).unwrap().cose_id(), id);
    }
    assert_eq!(SignatureAlgorithm::RsaPssSha256.pss_salt_length(), Some(32));
    assert_eq!(SignatureAlgorithm::RsaPssSha512.pss_salt_length(), Some(64));
    assert_eq!(SignatureAlgorithm::RsaPkcs1Sha1.hash_name(), Some("SHA-1"));
    assert_eq!(SignatureAlgorithm::Ed25519.hash_name(), None);
}
