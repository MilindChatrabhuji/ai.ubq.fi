use super::*;
use gateway_auth::{
    native::NATIVE_RPC_PATH,
    native_auth::{NativeAuthHeaders, NativeAuthenticator, NativeNonceAuthority},
};
use serde_json::{Value, json};
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};

fn native_value() -> Value {
    json!({
        "v":1,"role":"readonly_live","origin":"https://native.invalid",
        "key_id":"candidate-key","owner_id":"candidate-owner","owner_epoch":"candidate-epoch",
        "key_base64url":base64url(&[17;32])
    })
}

fn parse(value: &Value) -> Result<CandidateNativeConfiguration, GatewayError> {
    CandidateNativeConfiguration::parse(&value.to_string())
}

#[test]
fn exact_native_key_role_and_carrier_configuration_are_required() {
    let config = parse(&native_value()).unwrap();
    assert_eq!(config.identity.owner_id(), "candidate-owner");
    assert!(config.bindings().is_ok());
    for (field, replacement) in [
        ("v", json!(2)),
        ("role", json!("owner_renewal")),
        ("origin", json!("http://native.invalid")),
        ("origin", json!("https://native.invalid/path")),
        ("origin", json!("https://user@native.invalid")),
        ("key_base64url", json!(base64url(&[17; 31]))),
        ("key_base64url", json!(format!("{}=", base64url(&[17; 32])))),
    ] {
        let mut value = native_value();
        value[field] = replacement;
        assert!(parse(&value).is_err());
    }
    let mut value = native_value();
    value["capabilities"] = json!(["ConfigurationPublish"]);
    assert!(parse(&value).is_err());
    assert!(CandidateNativeConfiguration::parse(&" ".repeat(CONFIG_MAX_BYTES + 1)).is_err());
}

// This fixture is used only to inspect the configured identity's purpose set;
// actual runtime replay/restart behavior retains the existing persistent store.
struct IsolatedPurposeFixture;
impl NativeNonceAuthority for IsolatedPurposeFixture {
    async fn consume_nonce(
        &self,
        _key_id: &str,
        _nonce: &str,
        _valid_through_ms: i64,
        _now_ms: i64,
    ) -> Result<(), GatewayError> {
        Ok(())
    }
}

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

#[test]
fn readonly_role_never_grants_publication_renewal_or_import() {
    let config = parse(&native_value()).unwrap();
    let now = 1000;
    let nonce = base64url(&[21; 32]);
    let mac = config
        .identity
        .sign(NATIVE_RPC_PATH, now, &nonce, b"{}")
        .unwrap();
    let proof = run(
        NativeAuthenticator::new(&config.identity, &IsolatedPurposeFixture).authenticate(
            NATIVE_RPC_PATH,
            NativeAuthHeaders {
                version: "1",
                key_id: "candidate-key",
                time_ms: "1000",
                nonce: &nonce,
                mac: &mac,
            },
            b"{}",
            now,
        ),
    )
    .unwrap();
    for allowed in [
        NativeCapability::SupervisorRead,
        NativeCapability::LiveSideband,
    ] {
        assert!(proof.require(allowed, now).is_ok());
    }
    for forbidden in [
        NativeCapability::ConfigurationPublish,
        NativeCapability::AccessPublish,
        NativeCapability::OwnerRenewal,
        NativeCapability::CodexAuthImport,
        NativeCapability::NativeProfileImport,
    ] {
        assert!(proof.require(forbidden, now).is_err());
    }
}

fn seal(identity: &NativeTransportIdentity) -> Value {
    json!({
        "v":1,"payload_sha256":gateway_auth::crypto::sha256_hex(b"approved-private-payload"),
        "expected_readonly_owner":{
            "owner_id":identity.owner_id(),"owner_epoch":identity.owner_epoch(),
            "key_fingerprint":identity.key_fingerprint()
        },
        "adoption":{
            "worker_git_sha":"a".repeat(40),"worker_git_tree":"b".repeat(40),
            "authority_namespace_id":"c".repeat(32),"authority_object_id":"d".repeat(64),
            "capture_id":"e".repeat(64),"source_git_sha":"f".repeat(40),
            "source_native_version":"7","source_native_sequence":"2",
            "source_pool_revision":"source-r1","normalized_pool_revision":"pool-r1",
            "custody":[{"account_id_hash":"1".repeat(64),"native_source_generation":"2".repeat(64),"access_generation":"3".repeat(64)}],
            "custody_observed_at_ms":1000,"valid_through_ms":2000,"owner_revision":"fresh-owner-r1"
        }
    })
}

#[test]
fn seal_cannot_follow_a_changed_native_owner_key_or_epoch() {
    let config = parse(&native_value()).unwrap();
    let value = seal(&config.identity);
    assert!(parse_seal(&value.to_string(), &config.identity).is_ok());
    for field in ["owner_id", "owner_epoch", "key_fingerprint"] {
        let mut changed = value.clone();
        changed["expected_readonly_owner"][field] = json!("changed");
        assert!(parse_seal(&changed.to_string(), &config.identity).is_err());
    }
    let mut changed = value;
    changed["adoption"]["configuration_publish"] = json!(true);
    assert!(parse_seal(&changed.to_string(), &config.identity).is_err());
    assert!(parse_seal(&" ".repeat(CONFIG_MAX_BYTES + 1), &config.identity).is_err());
}

#[test]
fn trusted_seal_still_requires_exact_payload_and_current_custody() {
    let config = parse(&native_value()).unwrap();
    let deployment = parse_seal(&seal(&config.identity).to_string(), &config.identity).unwrap();
    let prepared = deployment
        .prepare(
            b"approved-private-payload",
            &"a".repeat(40),
            &"b".repeat(40),
            &"d".repeat(64),
            1500,
        )
        .unwrap();
    assert!(
        deployment
            .prepare(
                b"another-payload",
                &"a".repeat(40),
                &"b".repeat(40),
                &"d".repeat(64),
                1500
            )
            .is_err()
    );
    assert!(
        deployment
            .prepare(
                b"approved-private-payload",
                &"a".repeat(40),
                &"b".repeat(40),
                &"d".repeat(64),
                2001
            )
            .is_err()
    );
    let receipt = serde_json::to_string(&prepared.receipt()).unwrap();
    assert!(!receipt.contains(&base64url(&[17; 32])));
    assert!(!receipt.contains("approved-private-payload"));
}
