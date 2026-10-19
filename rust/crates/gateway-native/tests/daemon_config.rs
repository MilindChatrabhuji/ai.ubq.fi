#![cfg(unix)]
use gateway_auth::{
    GatewayError,
    crypto::base64url,
    native::NATIVE_CONTROL_PATH,
    native_auth::{
        AuthenticatedNativeOwner, NativeAuthHeaders, NativeAuthenticator, NativeCapability,
        NativeNonceAuthority,
    },
};
use gateway_native::daemon_config::{NativeDaemonConfig, PreparedNativeDaemonConfig};
use serde_json::{Value, json};

fn config(version: u8) -> Value {
    json!({
        "v":version,"listen":"127.0.0.1:0",
        "identity":{"key_id":"fixture-key","owner_id":"fixture-owner","owner_epoch":"fixture-epoch","key_base64url":base64url(&[11;32])},
        "nonce_database":"/tmp/fixture-only/nonces.sqlite3","sources":[]
    })
}
fn renewal() -> Value {
    json!({"authority_origin":"https://authority.example.invalid","owners":[{"owner_id":"fixture-owner","codex_home":"/tmp/fixture-only/native-home"}]})
}
fn parse(value: &Value) -> Result<PreparedNativeDaemonConfig, GatewayError> {
    NativeDaemonConfig::read_stdin(value.to_string().as_bytes())
}
struct FreshNonce;
impl NativeNonceAuthority for FreshNonce {
    async fn consume_nonce(&self, _: &str, _: &str, _: i64, _: i64) -> Result<(), GatewayError> {
        Ok(())
    }
}
fn proof(config: &PreparedNativeDaemonConfig) -> AuthenticatedNativeOwner {
    let nonce = base64url(&[21; 32]);
    let body = b"{}";
    let mac = config
        .identity
        .sign(NATIVE_CONTROL_PATH, 1000, &nonce, body)
        .unwrap();
    futures_executor::block_on(
        NativeAuthenticator::new(&config.identity, &FreshNonce).authenticate(
            NATIVE_CONTROL_PATH,
            NativeAuthHeaders {
                version: "1",
                key_id: "fixture-key",
                time_ms: "1000",
                nonce: &nonce,
                mac: &mac,
            },
            body,
            1000,
        ),
    )
    .unwrap()
}

#[test]
fn v1_keeps_supervisor_only_and_rejects_even_null_new_authority_fields() {
    let value = config(1);
    let prepared = parse(&value).unwrap();
    assert!(prepared.owner_renewal.is_none());
    let proof = proof(&prepared);
    assert!(
        proof
            .require(NativeCapability::SupervisorRead, 1000)
            .is_ok()
    );
    assert!(proof.require(NativeCapability::OwnerRenewal, 1000).is_err());
    assert!(
        proof
            .require(NativeCapability::AccessPublish, 1000)
            .is_err()
    );
    for extra in [Value::Null, renewal()] {
        let mut injected = value.clone();
        injected["owner_renewal"] = extra;
        assert!(parse(&injected).is_err());
    }
}

#[test]
fn explicit_v2_renewal_derives_only_its_finite_capabilities() {
    let mut value = config(2);
    value["owner_renewal"] = renewal();
    let prepared = parse(&value).unwrap();
    let renewal = prepared.owner_renewal.as_ref().unwrap();
    assert_eq!(
        renewal.authority_origin(),
        "https://authority.example.invalid"
    );
    assert_eq!(renewal.owners()[0].owner_id(), "fixture-owner");
    let proof = proof(&prepared);
    for capability in [
        NativeCapability::SupervisorRead,
        NativeCapability::OwnerRenewal,
        NativeCapability::AccessPublish,
    ] {
        assert!(proof.require(capability, 1000).is_ok());
    }
    for capability in [
        NativeCapability::ConfigurationPublish,
        NativeCapability::LiveSideband,
    ] {
        assert!(proof.require(capability, 1000).is_err());
    }
    value["capabilities"] = json!(["configuration_publish", "live_sideband"]);
    assert!(parse(&value).is_err());
}

#[test]
fn v2_without_explicit_renewal_does_not_grant_owner_or_live_authority() {
    for absent in [true, false] {
        let mut value = config(2);
        if !absent {
            value["owner_renewal"] = Value::Null;
        }
        let prepared = parse(&value).unwrap();
        assert!(prepared.owner_renewal.is_none());
        let proof = proof(&prepared);
        assert!(proof.require(NativeCapability::OwnerRenewal, 1000).is_err());
        assert!(
            proof
                .require(NativeCapability::AccessPublish, 1000)
                .is_err()
        );
        assert!(proof.require(NativeCapability::LiveSideband, 1000).is_err());
    }
}

#[test]
fn v2_refuses_redirectable_origins_ambiguous_owners_and_caller_selected_operations() {
    let mut value = config(2);
    value["owner_renewal"] = renewal();
    for origin in [
        "http://authority.example.invalid",
        "https://user@authority.example.invalid",
        "https://authority.example.invalid/caller-path",
        "https://authority.example.invalid?query=x",
        "https://authority.example.invalid#fragment",
    ] {
        let mut invalid = value.clone();
        invalid["owner_renewal"]["authority_origin"] = json!(origin);
        assert!(parse(&invalid).is_err(), "accepted {origin}");
    }
    let owner = value["owner_renewal"]["owners"][0].clone();
    for owners in [
        json!([]),
        json!([owner.clone(), owner.clone()]),
        json!([owner.clone(),{"owner_id":"another-owner","codex_home":"/tmp/fixture-only/native-home"}]),
        json!([{"owner_id":"fixture-owner","codex_home":"relative-home"}]),
        json!([{"owner_id":"https://caller","codex_home":"/tmp/fixture-home"}]),
    ] {
        let mut invalid = value.clone();
        invalid["owner_renewal"]["owners"] = owners;
        assert!(parse(&invalid).is_err());
    }
    value["owner_renewal"]["command"] = json!("not-an-operation");
    assert!(parse(&value).is_err());
}
