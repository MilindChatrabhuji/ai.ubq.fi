//! Source catalog runtime over one strong authority and credential-owner publication.
use std::rc::Rc;

use gateway_catalog_runtime::{CatalogHost, CatalogRuntime, admin::AdminCatalogResponse};
use gateway_core::GatewayError;
use gateway_core::source_json::SourceJson;
use gateway_schema::{
    catalog::CatalogInput, catalog_cache::CatalogResponse, source_request::SourceRequestError,
};
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
    Ok(into_auth_response(
        service().public_catalog(store, &host).await,
    ))
}

pub(crate) fn into_auth_response(
    response: Result<AdminCatalogResponse, SourceRequestError>,
) -> gateway_auth::AuthResponse {
    match response {
        Ok(response) => {
            let mut wire = gateway_auth::AuthResponse::source_json(response.status, response.body);
            wire.headers.extend(response.headers);
            wire
        }
        Err(error) => gateway_auth::AuthResponse::source_json(error.status, error.body().clone()),
    }
}

/// The existing versioned refresh path, scheduled after a stale response on a
/// background cancellation. It creates no cron, alarm, or detached timer.
pub fn schedule_warm(
    store: &RemoteAuthorityStore,
    env: &Env,
    platform: &PlatformHost,
    context: Rc<Context>,
    version: &str,
) {
    let mut host = Host {
        store: store.clone(),
        env: env.clone(),
        platform: platform.clone(),
        context: context.clone(),
    };
    let service = service();
    let store = store.clone();
    let version = version.to_owned();
    context.wait_until(async move {
        let cancellation = match crate::transport::outbound::Cancellation::background() {
            Ok(cancellation) => cancellation,
            Err(error) => {
                worker::console_error!(
                    "Catalog background refresh remains unavailable: {}",
                    error.envelope.error.message
                );
                return;
            }
        };
        host.platform.cancellation = Rc::new(cancellation);
        if let Err(error) = service
            .versioned_models(&store, &host, &version, None)
            .await
        {
            worker::console_error!(
                "Catalog background refresh remains pending: {}",
                error.envelope.error.message
            );
        }
    });
}

#[derive(Clone)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use gateway_core::js_string::JsString16;
    use std::collections::BTreeMap;

    #[test]
    fn public_catalog_rendering_retains_raw_models_and_source_error_fields() {
        let body = SourceJson::parse(r#"{"models":[{"id":"model-\ud800"}]}"#).unwrap();
        let response = into_auth_response(Ok(AdminCatalogResponse {
            status: 200,
            body: body.clone(),
            headers: BTreeMap::from([("x-fixture".into(), "source".into())]),
        }));
        assert_eq!(response.status, 200);
        assert_eq!(response.body.to_bytes().unwrap(), body.as_bytes());
        assert_eq!(response.headers["x-fixture"], "source");
        assert_eq!(response.headers["cache-control"], "no-store");
        let error = SourceRequestError::new(
            400,
            JsString16::from_units(vec![0xdc00]),
            "invalid_request_error",
            Some("invalid_request_error"),
            Some(Some(JsString16::from_units(vec![0xd800]))),
        );
        let expected = error.body().as_bytes().to_vec();
        let response = into_auth_response(Err(error));
        assert_eq!(response.status, 400);
        assert_eq!(response.body.to_bytes().unwrap(), expected);
        assert_eq!(response.headers["content-type"], "application/json");
    }
}
