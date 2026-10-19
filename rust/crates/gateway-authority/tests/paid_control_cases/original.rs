//! Original request fixture uses the actual public admission and existing full journal format.
use super::{MemoryStore, TestAuthority};
use gateway_authority::{
    REQUEST_LEASE_MS,
    paid::PaidRequest,
    paid_control::{PaidRequestContext, PaidRoutingReceipt},
};
use gateway_core::{
    GatewayError,
    identity::{PrincipalId, RequestContext},
    tuple_key::{ScalarKeyPart, TupleKey},
};
use serde_json::json;

pub fn journal_key(id: &str) -> gateway_core::state::RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("session"),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}
pub async fn bind(
    authority: &TestAuthority,
    input: &PaidRequest,
    receipt: &PaidRoutingReceipt,
    now: i64,
) -> Result<PaidRoutingReceipt, GatewayError> {
    let store: &MemoryStore = authority.store();
    let key = journal_key(&input.request_id.0);
    if store.row(&key).is_none() {
        let original = RequestContext {
            request_id: input.request_id.clone(),
            principal: PrincipalId("fixture-original-principal".into()),
            key_id: Some(input.key_id.clone()),
            route: input.route.clone(),
            started_at_ms: input.created_at_ms,
        };
        let api = authority
            .reserve_api_key(&input.key_id, &input.request_id, &input.route, now)
            .await?;
        store.seed(key.clone(), &json!({
            "v":1,"context":original,"input_digest":gateway_auth::crypto::sha256_hex(b"fixture-original-input"),
            "api":api,"kernel":null,"cursor":0,"attempts":[],"active":null,
            "model_sibling_retries":0,"refreshed_versions":[],"recovery_attempted":false,"claude_unavailable":false,
            "semantic_committed":false,"terminal_intent":null,"finished":false,"recovering":false,
            "lease_expires_at_ms":now+REQUEST_LEASE_MS,"updated_at_ms":now,"extras_family":null,
            "extras_child_count":null,"extras_dispatch":null,"children":[],"kernel_override":null,
        }));
    }
    let row = store.row(&key).unwrap();
    let raw = gateway_core::source_control::decode_source_control_record(&row).unwrap();
    let original: RequestContext = gateway_core::source_serialization::member(&raw, "context")
        .unwrap()
        .deserialize()
        .unwrap();
    authority
        .bind_paid_original_request(receipt, &original, now)
        .await
}
pub async fn authorize(
    authority: &TestAuthority,
    input: &PaidRequest,
    context: &PaidRequestContext,
    now: i64,
) -> Result<PaidRoutingReceipt, GatewayError> {
    let route = authority.authorize_paid_route(input, context, now).await?;
    bind(authority, input, &route, now).await
}
