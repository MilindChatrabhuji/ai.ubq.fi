//! Pure request data shared by planner-only and stateful integration fixtures.
use super::{RoutingInput, fixture_json};
use gateway_auth::{AuthMethod, AuthPrincipal};
use gateway_core::identity::{ApiKeyId, PrincipalId, RequestContext, RequestId};
use gateway_providers::ClientSurface;
use gateway_schema::{
    catalog::{CatalogInput, ProviderCatalog},
    snapshot::ModelSnapshot,
};
use serde_json::json;

pub const NOW: i64 = 1_800_000_000_000;
pub fn input(id: &str, model: &str, providers: &[&str]) -> RoutingInput {
    let principal = AuthPrincipal {
        token: None,
        method: AuthMethod::KvApiKey {
            key_id: "key-a".into(),
            policy: gateway_auth::api_keys::ApiKeyPolicy {
                token_hash: "fixture".into(),
                key_id: "key-a".into(),
                expires_at_ms: -1,
                usage_limit_requests: 10,
                window_ms: gateway_authority::DAY_MS,
                window_start_ms: NOW,
                usage_reset_at_ms: NOW + gateway_authority::DAY_MS,
                policy_version: format!("v3:{}", gateway_authority::DAY_MS),
                paid_fallback_enabled: true,
                paid_fallback_limit_microcredits: 10000,
                paid_fallback_spent_microcredits: 0,
                paid_fallback_reserved_microcredits: 0,
                paid_fallback_reservation_request_id: None,
            },
        },
        is_admin: false,
        is_super_admin: false,
    };
    let mut catalog = CatalogInput::default();
    for provider in providers {
        catalog.providers.insert(
            (*provider).into(),
            ProviderCatalog {
                configured: true,
                available: true,
                ..Default::default()
            },
        );
    }
    catalog.full_snapshot = Some(ModelSnapshot {
        models: vec![fixture_json(
            &json!({"slug":"gpt-test","supported_reasoning_levels":[{"effort":"none"},{"effort":"high"},{"effort":"ultra"}],"default_reasoning_level":"none"}),
        )],
        source: "fixture".into(),
        updated_at_ms: NOW,
        client_version: Some("0.163.0".into()),
    });
    RoutingInput {
        context: RequestContext {
            request_id: RequestId(id.into()),
            principal: PrincipalId("fixture-principal".into()),
            key_id: Some(ApiKeyId("key-a".into())),
            route: "responses".into(),
            started_at_ms: NOW,
        },
        principal,
        raw: gateway_core::source_json::SourceJson::from_serializable(
            &json!({"model":model,"input":"source fixture","reasoning":{"effort":"none"}}),
        )
        .unwrap(),
        surface: ClientSurface::Responses,
        catalog,
        runtime: None,
        client_version: "0.163.0".into(),
        native_session_id: None,
        retry_prohibited: false,
    }
}
