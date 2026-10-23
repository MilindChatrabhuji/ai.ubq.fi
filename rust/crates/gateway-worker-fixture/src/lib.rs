//! Test-only constructor composition. The actual application and coordination
//! authority are gateway-worker; no request handler, ledger or upstream is copied.
mod native_carrier;
mod native_import;
use gateway_auth::{
    GatewayError,
    native_auth::{NativeCapability, NativeTransportIdentity},
};
use gateway_publication::{
    control_publication::ConfiguredPaidInputs, transport::PublicationReceiver,
};
pub use gateway_worker::GatewayAuthority;
use gateway_worker_fixture_setup::{initialize, invalid};
use std::collections::BTreeSet;
use worker::{Context, Env, Request};

pub const SURPLUS_SECRET: &str = "fixture-matrix-surplus";
pub const OPENLUX_DISCOVERY_SECRET: &str = "fixture-matrix-openlux-discovery";
pub const OPENLUX_SPEND_SECRET: &str = "fixture-matrix-openlux-spend";

fn now() -> i64 {
    gateway_worker::storage::now_ms().unwrap_or(i64::MAX)
}
fn identity() -> Result<NativeTransportIdentity, GatewayError> {
    NativeTransportIdentity::new(
        "fixture-matrix-key".into(),
        "fixture-matrix-owner".into(),
        "fixture-matrix-epoch".into(),
        [31; 32],
        BTreeSet::from([NativeCapability::ConfigurationPublish]),
    )
}
fn inputs() -> Result<ConfiguredPaidInputs, GatewayError> {
    use gateway_auth::crypto::Secret;
    ConfiguredPaidInputs::new(
        Some(Secret::new(SURPLUS_SECRET.into())),
        Some(Secret::new(OPENLUX_DISCOVERY_SECRET.into())),
        Some(Secret::new(OPENLUX_SPEND_SECRET.into())),
        serde_json::json!({"fixture":"runtime-matrix-v1"}),
    )
}

/// Explicit test-only feature: build this crate alone, never with the production
/// entrypoint feature. Missing fixture binding fails closed before application use.
#[cfg_attr(feature = "entrypoint", worker::event(fetch))]
pub async fn fetch(
    request: Request,
    env: Env,
    context: Context,
) -> worker::Result<gateway_worker::GatewayResponse> {
    if env
        .var("UOS_MATRIX_SCENARIO")
        .ok()
        .is_some_and(|v| v.to_string() == "native-carrier")
    {
        return native_carrier::fetch(request, env, context).await;
    }
    if env
        .var("UOS_MATRIX_SCENARIO")
        .ok()
        .is_some_and(|v| v.to_string() == "native-import")
    {
        return native_import::fetch(request, env, context).await;
    }
    let result = async {
        let scenario = env
            .var("UOS_MATRIX_SCENARIO")
            .map_err(|_| invalid())?
            .to_string();
        if !["direct", "codex", "claude", "paid"].contains(&scenario.as_str()) {
            return Err(invalid());
        }
        let identity = identity()?;
        let inputs = inputs()?;
        let receiver =
            PublicationReceiver::configured(identity.clone(), inputs.clone(), Vec::new(), now)?;
        let store = gateway_worker::authority::RemoteAuthorityStore::from_env(&env)?;
        initialize(&store, &identity, &inputs, &receiver, &scenario).await?;
        Ok(receiver)
    }
    .await;
    let receiver = result.map_err(|error: GatewayError| {
        worker::Error::RustError(
            error
                .envelope
                .error
                .code
                .unwrap_or_else(|| "matrix_fixture_failed".into()),
        )
    })?;
    gateway_worker::fetch_with_bindings(
        request,
        env,
        context,
        Some(&receiver),
        gateway_worker::NativeBindings::default(),
    )
    .await
}

#[cfg(test)]
mod tests {
    #[test]
    fn configuration_fixture_does_not_require_an_access_owner() {
        assert!(
            super::PublicationReceiver::configured(
                super::identity().unwrap(),
                super::inputs().unwrap(),
                Vec::new(),
                || 0,
            )
            .is_ok()
        );
    }
}
