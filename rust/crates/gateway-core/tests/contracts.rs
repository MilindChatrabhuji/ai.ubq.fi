use gateway_core::GatewayError;
use gateway_core::health::{HealthResponse, ReleaseIdentity};
use gateway_core::identity::{MAX_SAFE_INTEGER, MicrocreditLimit, Microcredits};
use gateway_core::lifecycle::{
    BodyOutcome, DeliveryOutcome, ReaderTermination, TransportObservation,
};
use gateway_core::provider::{
    CodexQuotaClass, OveragePermission, PaidProvider, SelectableProviderId, UpstreamProvider,
};
use gateway_core::state::StoredRecord;
use serde_json::json;

#[test]
fn error_omission_and_explicit_null_match_source() {
    let error = GatewayError::new(400, "bad", Some("server_error"));
    assert_eq!(
        serde_json::to_value(&error.envelope).unwrap(),
        json!({"error":{"message":"bad","type":"invalid_request_error","code":"server_error"}})
    );
    let explicit_null = error.with_param(None);
    assert_eq!(
        serde_json::to_value(explicit_null.envelope).unwrap()["error"]["param"],
        json!(null)
    );
    let absent_code = GatewayError::new(400, "bad", None);
    assert!(
        !serde_json::to_value(absent_code.envelope).unwrap()["error"]
            .as_object()
            .unwrap()
            .contains_key("code")
    );
}

#[test]
fn provider_names_are_separate_wire_vocabularies() {
    assert_eq!(
        serde_json::to_value(SelectableProviderId::Openlux).unwrap(),
        json!("openlux")
    );
    assert_eq!(
        serde_json::to_value(PaidProvider::Metered).unwrap(),
        json!("metered")
    );
    assert_eq!(
        serde_json::to_value(UpstreamProvider::ChatgptCodex).unwrap(),
        json!("chatgpt_codex")
    );
    assert_eq!(
        serde_json::to_value(CodexQuotaClass::GptOss120b).unwrap(),
        json!("gpt_oss_120b")
    );
    assert!(serde_json::from_value::<UpstreamProvider>(json!("ubiquity")).is_err());
}

#[test]
fn missing_and_malformed_overage_permission_never_authorize_dispatch() {
    for record in [
        None,
        Some(json!({})),
        Some(json!({"allow":false})),
        Some(json!({"allow":"true"})),
        Some(json!(null)),
    ] {
        assert!(!OveragePermission::from_stored_record(record.as_ref()).allows_dispatch());
    }
    assert!(OveragePermission::from_stored_record(Some(&json!({"allow":true}))).allows_dispatch());
}

#[test]
fn drained_worker_body_never_manufactures_a_delivery_receipt() {
    let observation = TransportObservation {
        reader_termination: Some(ReaderTermination::Eof),
        body: Some(BodyOutcome::Drained),
        ..TransportObservation::default()
    };
    assert_eq!(observation.semantic_terminal, None);
    assert_eq!(observation.delivery, DeliveryOutcome::Unobserved);
    assert_eq!(
        serde_json::to_value(observation).unwrap()["delivery"],
        json!("unobserved")
    );
}

#[test]
fn portable_credit_values_preserve_safe_integer_and_unlimited_boundaries() {
    assert!(Microcredits::try_from(-1).is_err());
    assert!(Microcredits::try_from(MAX_SAFE_INTEGER + 1).is_err());
    assert!(Microcredits::try_from(MAX_SAFE_INTEGER).is_ok());
    assert_eq!(
        MicrocreditLimit::try_from(-1),
        Ok(MicrocreditLimit::Unlimited)
    );
    assert!(MicrocreditLimit::try_from(0).is_err());
    assert!(serde_json::from_value::<Microcredits>(json!(-1)).is_err());
}

#[test]
fn health_requires_full_build_identity_and_matches_source_envelope() {
    let sha = "e706343d4a5f11890e39ab3599bdc04e154b1fba";
    let deployment_id = format!("cloudflare-{sha}");
    let identity = ReleaseIdentity::cloudflare(sha, &deployment_id).unwrap();
    assert_eq!(
        serde_json::to_value(HealthResponse::available(&identity)).unwrap(),
        json!({"status":"available","release":{"git_sha":sha,"deployment_id":deployment_id}})
    );
    for (sha, id) in [("unknown", "unknown"), ("", ""), (sha, "cloudflare-other")] {
        assert_eq!(
            ReleaseIdentity::cloudflare(sha, id).unwrap_err().status,
            503
        );
    }
}

#[test]
fn unknown_state_version_fails_closed() {
    let record = StoredRecord {
        schema_version: 2,
        revision: "0".to_owned(),
        value: json!({}),
        expires_at_ms: None,
    };
    assert_eq!(record.validate_version().unwrap_err().status, 503);
}

#[test]
fn json_field_order_survives_source_compatible_parse_and_serialization() {
    let value: serde_json::Value = serde_json::from_str(r#"{"z":null,"a":1}"#).unwrap();
    assert_eq!(
        serde_json::to_string(&value).unwrap(),
        r#"{"z":null,"a":1}"#
    );
}
