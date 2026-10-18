use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use gateway_observability::replay_crypto::*;
use serde_json::Value;
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/crypto-source.json")).unwrap()
}
#[test]
fn actual_bun_hkdf_fingerprints_and_encrypted_gzip_decode_in_rust() {
    let f = fixture();
    assert_eq!(f["runtime"], "1.4.0");
    let key = ReplayKey::decode(f["key_base64"].as_str().unwrap()).unwrap();
    let body = STANDARD.decode(f["body_base64"].as_str().unwrap()).unwrap();
    let input = FingerprintInput {
        method: "POST",
        endpoint: "/v1/responses",
        headers: f["header_text"].as_str().unwrap(),
        body: &body,
        failure_signature: f["failure_signature"].as_str().unwrap(),
        canonical_upstream: f["canonical_upstream"].as_str().unwrap(),
    };
    assert_eq!(
        key.fingerprint(&input).unwrap(),
        f["fingerprint"].as_str().unwrap()
    );
    assert_eq!(
        key.case_group(&input).unwrap(),
        f["case_group_digest"].as_str().unwrap()
    );
    let iv: [u8; 12] = URL_SAFE_NO_PAD
        .decode(f["iv_base64"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let encrypted = STANDARD
        .decode(f["ciphertext_base64"].as_str().unwrap())
        .unwrap();
    let expected = STANDARD
        .decode(f["encoded_base64"].as_str().unwrap())
        .unwrap();
    let fingerprint = f["fingerprint"].as_str().unwrap();
    assert_eq!(
        key.decrypt(&iv, fingerprint, &encrypted)
            .unwrap()
            .as_slice(),
        expected
    );
    let ours = key.encrypt(&iv, fingerprint, &expected).unwrap();
    assert_eq!(
        key.decrypt(&iv, fingerprint, &ours).unwrap().as_slice(),
        expected
    );
    assert!(key.decrypt(&iv, &"b".repeat(64), &encrypted).is_err());
    let mut altered = encrypted.clone();
    let last = altered.len() - 1;
    altered[last] ^= 1;
    assert!(key.decrypt(&iv, fingerprint, &altered).is_err());
}
#[test]
fn source_key_accepts_its_permitted_noncanonical_trailing_bits_but_no_extra_text() {
    let f = fixture();
    let raw = f["key_base64"].as_str().unwrap();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut equivalent = raw.as_bytes().to_vec();
    let index = alphabet.iter().position(|b| *b == equivalent[42]).unwrap();
    equivalent[42] = alphabet[index + 1];
    let equivalent = String::from_utf8(equivalent).unwrap();
    let key = ReplayKey::decode(&equivalent).unwrap();
    let iv: [u8; 12] = URL_SAFE_NO_PAD
        .decode(f["iv_base64"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let encrypted = STANDARD
        .decode(f["ciphertext_base64"].as_str().unwrap())
        .unwrap();
    assert!(
        key.decrypt(&iv, f["fingerprint"].as_str().unwrap(), &encrypted)
            .is_ok()
    );
    assert!(ReplayKey::decode(&format!(" {raw}")).is_err());
    assert!(ReplayKey::decode(&format!("{raw}x")).is_err());
}
#[test]
fn replay_crypto_refuses_oversized_plaintext_before_compression() {
    let f = fixture();
    let key = ReplayKey::decode(f["key_base64"].as_str().unwrap()).unwrap();
    let encoded = vec![0; MAX_PLAINTEXT_BYTES + 1];
    assert!(
        key.encrypt(&[0; 12], f["fingerprint"].as_str().unwrap(), &encoded)
            .is_err()
    );
}
