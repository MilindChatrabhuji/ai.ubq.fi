//! Fixed controlled HTTPS composition of the shipping native transport. The
//! runner maps this origin to a local TLS endpoint with the synthetic native CA.
use std::collections::BTreeSet;

use gateway_auth::{
    GatewayError,
    native_auth::{NativeCapability, NativeTransportIdentity},
};
use gateway_publication::transport::PublicationReceiver;
use gateway_worker_fixture_setup::initialize;
use worker::{Context, Env, Request};

pub(super) async fn fetch(
    request: Request,
    env: Env,
    context: Context,
) -> worker::Result<gateway_worker::GatewayResponse> {
    let result = async {
        let identity = NativeTransportIdentity::new(
            "fixture-matrix-key".into(),
            "fixture-matrix-owner".into(),
            "fixture-matrix-epoch".into(),
            [31; 32],
            BTreeSet::from([
                NativeCapability::ConfigurationPublish,
                NativeCapability::SupervisorRead,
                NativeCapability::LiveSideband,
            ]),
        )?;
        let inputs = super::inputs()?;
        let receiver = PublicationReceiver::configured(
            identity.clone(),
            inputs.clone(),
            Vec::new(),
            super::now,
        )?;
        let store = gateway_worker::authority::RemoteAuthorityStore::from_env(&env)?;
        initialize(&store, &identity, &inputs, &receiver, "codex").await?;
        let bindings =
            gateway_worker::NativeBindings::configured_https("https://localhost", identity)?;
        Ok((receiver, bindings))
    }
    .await;
    let (receiver, bindings) = result.map_err(|error: GatewayError| {
        worker::Error::RustError(error.envelope.error.code.unwrap_or_default())
    })?;
    gateway_worker::fetch_with_bindings(request, env, context, Some(&receiver), bindings).await
}
