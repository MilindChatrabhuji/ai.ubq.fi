//! Source catalog runtime over one strong authority and credential-owner publication.
use std::{collections::BTreeMap, rc::Rc};

use gateway_catalog_runtime::{CatalogHost, CatalogRuntime};
use gateway_core::{
    GatewayError,
    state::RecordKey,
    tuple_key::{ScalarKeyPart, TupleKey},
};
use gateway_schema::{catalog::CatalogInput, catalog_cache::CatalogResponse};
use serde_json::Value;
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

pub fn key(parts: &[&str]) -> RecordKey {
    TupleKey::from_scalar_parts(
        &parts
            .iter()
            .map(|part| ScalarKeyPart::String(part))
            .collect::<Vec<_>>(),
    )
    .to_record_key()
}

thread_local! {
    static RUNTIME: CatalogRuntime = CatalogRuntime::new();
}

pub struct CatalogState {
    pub input: CatalogInput,
    pub runtime: Option<Value>,
    pub secrets: BTreeMap<String, String>,
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
        };
        let publication = host.publication().await?;
        let service = RUNTIME.with(Clone::clone);
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
            secrets: crate::catalog_host::secrets(env),
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
