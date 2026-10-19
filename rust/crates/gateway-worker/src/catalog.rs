//! Source catalog runtime over one strong authority and credential-owner publication.
use std::rc::Rc;

use gateway_catalog_runtime::{CatalogHost, CatalogRuntime};
use gateway_core::GatewayError;
use gateway_core::source_json::SourceJson;
use gateway_schema::{catalog::CatalogInput, catalog_cache::CatalogResponse};
use worker::{Context, Env, Request};

use crate::{
    authority::RemoteAuthorityStore, catalog_host::Host, host::PlatformHost, storage::now_ms,
};

pub const DIRECT_PROVIDERS: &[(&str, &str)] = &[
    ("deepseek", "DEEPSEEK_API_KEY"),
    ("cerebras", "CEREBRAS_API_KEY"),
    ("lithos", "LITHOSAI_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("surplus", "SURPLUS_API_KEY"),
    ("openlux", "OPENLUX_API_KEY"),
];

thread_local! {
    static RUNTIME: CatalogRuntime = CatalogRuntime::new();
}

pub fn service() -> CatalogRuntime {
    RUNTIME.with(Clone::clone)
}

pub async fn public_response(
    store: &RemoteAuthorityStore,
    env: &Env,
    platform: &PlatformHost,
    context: Rc<Context>,
) -> Result<gateway_auth::AuthResponse, GatewayError> {
    let host = Host {
        store: store.clone(),
        env: env.clone(),
        platform: platform.clone(),
        context,
    };
    let response = service().public_catalog(store, &host).await?;
    let mut wire = gateway_auth::AuthResponse::json(response.status, response.body);
    wire.headers.extend(response.headers);
    Ok(wire)
}

pub struct CatalogState {
    pub input: CatalogInput,
    pub runtime: Option<SourceJson>,
    service: CatalogRuntime,
    host: Host,
}

impl CatalogState {
    pub async fn load(
        store: &RemoteAuthorityStore,
        env: &Env,
        platform: &PlatformHost,
        context: Rc<Context>,
    ) -> Result<Self, GatewayError> {
        let host = Host {
            store: store.clone(),
            env: env.clone(),
            platform: platform.clone(),
            context: context.clone(),
        };
        let publication = host.publication().await?;
        let service = service();
        let state = service.load_state(store, &publication, now_ms()?).await?;
        for provider in state.refresh_due {
            let service = service.clone();
            let host = host.clone();
            let store = store.clone();
            context.wait_until(async move {
                if let Err(error) = service
                    .refresh_provider(&store, &host, provider, false)
                    .await
                {
                    worker::console_error!(
                        "Catalog refresh remains unavailable: {}",
                        error.envelope.error.message
                    );
                }
            });
        }
        Ok(Self {
            input: state.input,
            runtime: state.runtime,
            service,
            host,
        })
    }

    pub async fn native_models(
        &self,
        store: &RemoteAuthorityStore,
        request: &Request,
        version: &str,
        _now: i64,
    ) -> Result<CatalogResponse, GatewayError> {
        let conditional = request.headers().get("if-none-match").map_err(|_| {
            GatewayError::new(
                400,
                "Invalid conditional catalog header.",
                Some("invalid_request_error"),
            )
        })?;
        self.service
            .versioned_models(store, &self.host, version, conditional.as_deref())
            .await
    }
}
