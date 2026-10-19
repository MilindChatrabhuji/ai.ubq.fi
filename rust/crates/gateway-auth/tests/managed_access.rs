use gateway_auth::{
    crypto::base64url,
    managed_access::ManagedAccessProjection,
    native_credentials::{NativeGeneration, NativeOwnerId, OwnerFence, parse_native_document},
    provider_credentials::*,
};
use serde_json::{Value, json};

fn managed_generation() -> NativeGeneration {
    let token = format!(
        "e30.{}.synthetic",
        base64url(
            json!({"exp":2000,"email":"fixture@example.invalid"})
                .to_string()
                .as_bytes()
        )
    );
    let document = json!({"auth_mode":"chatgpt","tokens":{"access_token":token,"id_token":token,"refresh_token":"synthetic-native-refresh-never-export","account_id":"workspace-a"},"last_refresh":"2026-10-18T12:00:00.000000002Z"});
    let credentials = parse_native_document(&document).unwrap();
    NativeGeneration {
        fence: OwnerFence {
            owner: NativeOwnerId("fixture-owner".into()),
            account_id: credentials.account_id.clone(),
            generation_hash: credentials.generation_hash(),
            authority_revision: "fixture-authority".into(),
        },
        credentials,
        observed_at_ms: 1000,
    }
}

fn projected_source(projection: &ManagedAccessProjection) -> Value {
    json!({"accounts":[{
        "account_id":projection.account_id(),"access_token":projection.access_token().expose(),"refresh_token":"","updated_at_ms":1000,
        "native_owner":{"codex_home":"/tmp/synthetic-native-owner","generation_hash":projection.access_generation(),"native_refreshed_at":projection.native_refreshed_at(),"managed_source":{"v":2,"generation_hash":projection.native_source_generation()}}
    },{"account_id":"sibling","access_token":"synthetic-sibling-access","refresh_token":"synthetic-sibling-refresh","updated_at_ms":5.0}],"updated_at_ms":1000})
}

#[test]
fn explicit_managed_projection_round_trips_without_refresh_export_or_external_relabeling() {
    let generation = managed_generation();
    let projection = ManagedAccessProjection::from_native(&generation).unwrap();
    assert_eq!(
        projection.native_source_generation(),
        generation.credentials.generation_hash()
    );
    assert_ne!(
        projection.native_source_generation(),
        projection.access_generation()
    );
    assert_eq!(projection.access_expiry_ms(), 2_000_000);
    let raw = projected_source(&projection);
    let source = parse_codex_source_pool(&raw).unwrap().unwrap();
    let projected = &source.accounts[0];
    let owner = projected.native_owner.as_ref().unwrap();
    assert_eq!(
        owner.generation_hash,
        projected.identity().native_generation_hash
    );
    assert_eq!(
        owner.managed_source.as_ref().unwrap().generation_hash,
        projection.native_source_generation()
    );
    assert!(owner.external_user_id.is_none());
    assert_eq!(projected.refresh_token.expose(), "");
    let encoded = source.private_source_value();
    assert_eq!(encoded["accounts"][1], raw["accounts"][1]);
    assert_eq!(
        encoded["accounts"][0]["native_owner"],
        raw["accounts"][0]["native_owner"]
    );
    assert!(
        !encoded
            .to_string()
            .contains("synthetic-native-refresh-never-export")
    );
    assert!(!encoded.to_string().contains("chatgptAuthTokens"));
    assert_eq!(parse_codex_source_pool(&encoded).unwrap().unwrap(), source);
}

#[test]
fn managed_source_marker_is_versioned_strict_and_cannot_mix_external_or_refresh_material() {
    let projection = ManagedAccessProjection::from_native(&managed_generation()).unwrap();
    let original = projected_source(&projection);
    for marker in [
        json!({"v":1,"generation_hash":projection.native_source_generation()}),
        json!({"v":2,"generation_hash":"not-a-generation"}),
        json!({"v":2,"generation_hash":projection.native_source_generation(),"authorized":true}),
        Value::Null,
    ] {
        let mut raw = original.clone();
        raw["accounts"][0]["native_owner"]["managed_source"] = marker;
        assert!(parse_codex_source_pool(&raw).is_err());
    }
    let mut mixed = original.clone();
    mixed["accounts"][0]["native_owner"]["auth_mode"] = json!("chatgptAuthTokens");
    mixed["accounts"][0]["native_owner"]["chatgpt_user_id"] = json!("synthetic-user");
    assert!(parse_codex_source_pool(&mixed).is_err());
    let mut refresh = original.clone();
    refresh["accounts"][0]["refresh_token"] = json!("must-not-be-projected");
    assert!(parse_codex_source_pool(&refresh).unwrap().is_none());
    let mut no_marker = original;
    no_marker["accounts"][0]["native_owner"]
        .as_object_mut()
        .unwrap()
        .remove("managed_source");
    assert!(parse_codex_source_pool(&no_marker).unwrap().is_none());
}

#[test]
fn projection_requires_managed_local_custody_fixed_account_and_usable_access() {
    let mut generation = managed_generation();
    generation.credentials.external_user_id = Some("synthetic-user".into());
    assert!(ManagedAccessProjection::from_native(&generation).is_err());
    let mut generation = managed_generation();
    generation.credentials.refresh_token = gateway_auth::crypto::Secret::new(String::new());
    assert!(ManagedAccessProjection::from_native(&generation).is_err());
    let mut generation = managed_generation();
    generation.fence.account_id = "different-workspace".into();
    assert!(ManagedAccessProjection::from_native(&generation).is_err());
    let mut generation = managed_generation();
    generation.observed_at_ms = 2_000_000;
    assert!(ManagedAccessProjection::from_native(&generation).is_err());
}
