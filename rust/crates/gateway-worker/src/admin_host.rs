//! Finite administrative host bindings. Missing external owners remain explicit.
use std::cmp::Ordering;

use gateway_admin_runtime::{
    RuntimeConfig,
    capabilities::{
        AnalyticsRequest, CatalogRequest, Context, ProviderRequest, RuntimeCapabilities,
    },
};
use gateway_auth::AuthResponse;
use gateway_core::{GatewayError, identity::RequestId};
use gateway_observability::{ObservabilityRuntime, ObservabilityState};
use gateway_schema::util::js_trim;
use worker::Env;
use worker::js_sys::{Function, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue};

thread_local! {
    static OBSERVABILITY_STATE: ObservabilityState = ObservabilityState::default();
}

pub fn config(env: &Env) -> RuntimeConfig {
    let raw = crate::host::setting(env, "CLAUDE_CODE_ALLOWED_KEY_IDS").unwrap_or_default();
    let mut ids = Vec::new();
    for value in
        raw.split(|character: char| character == ',' || js_trim(&character.to_string()).is_empty())
    {
        let value = js_trim(value);
        if !value.is_empty() && !ids.iter().any(|old| old == value) {
            ids.push(value.to_owned());
        }
    }
    RuntimeConfig {
        claude_allowed_key_ids: ids,
    }
}

pub struct Capabilities {
    request_id: String,
    original_body_bytes: usize,
    catalog_service: gateway_catalog_runtime::CatalogRuntime,
    catalog_host: crate::catalog_host::Host,
    observations: ObservabilityRuntime<
        crate::authority::RemoteAuthorityStore,
        crate::observability_host::Host,
    >,
}

impl Capabilities {
    pub fn new(
        request_id: &RequestId,
        original_body: &[u8],
        store: crate::authority::RemoteAuthorityStore,
        platform: &crate::host::PlatformHost,
        context: std::rc::Rc<worker::Context>,
    ) -> Self {
        Self {
            request_id: request_id.0.clone(),
            original_body_bytes: original_body.len(),
            catalog_service: crate::catalog::service(),
            catalog_host: crate::catalog_host::Host {
                store: store.clone(),
                env: platform.env.clone(),
                platform: platform.clone(),
                context,
            },
            observations: ObservabilityRuntime::with_state(
                store,
                crate::observability_host::Host,
                OBSERVABILITY_STATE.with(Clone::clone),
            ),
        }
    }
    fn measured_body_bytes(&self, context: &Context) -> Result<usize, GatewayError> {
        if context.request_id != self.request_id {
            return Err(GatewayError::unavailable(
                "The administrative body receipt does not match this request.",
                "admin_body_receipt_mismatch",
            ));
        }
        Ok(self.original_body_bytes)
    }
}

impl RuntimeCapabilities for Capabilities {
    async fn native(
        &self,
        request: gateway_admin_runtime::capabilities::NativeRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        self.measured_body_bytes(&context)?;
        let platform = &self.catalog_host.platform;
        platform.native.rpc(request, platform).await
    }
    async fn catalog(
        &self,
        request: CatalogRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        self.measured_body_bytes(&context)?;
        use gateway_catalog_runtime::admin::AdminCatalogOperation as Operation;
        let operation = match request {
            CatalogRequest::CodexModelsGet => Operation::CodexModelsGet,
            CatalogRequest::CodexModelsSet { document } => Operation::CodexModelsSet { document },
            CatalogRequest::WhitelistGet => Operation::WhitelistGet,
            CatalogRequest::WhitelistSet { document } => Operation::WhitelistSet { document },
            CatalogRequest::Catalog => Operation::Catalog,
            CatalogRequest::Refresh => Operation::Refresh,
        };
        let response = self
            .catalog_service
            .admin_catalog(&self.catalog_host.store, &self.catalog_host, operation)
            .await?;
        let mut wire = AuthResponse::json(response.status, response.body);
        wire.headers.extend(response.headers);
        Ok(wire)
    }
    async fn provider(
        &self,
        request: ProviderRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        let original_body_bytes = self.measured_body_bytes(&context)?;
        match request {
            ProviderRequest::Observations { document } => {
                self.observations
                    .capacity_observation_response(&document, original_body_bytes, context)
                    .await
            }
            _ => Err(unavailable("provider_capacity")),
        }
    }
    async fn analytics(
        &self,
        request: AnalyticsRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        self.measured_body_bytes(&context)?;
        match request {
            AnalyticsRequest::PromptCache { group_by } => Ok(AuthResponse::json(
                200,
                self.observations.prompt_analytics(&group_by).await?,
            )),
            _ => Err(unavailable("analytics")),
        }
    }
    fn compare_admin_labels(&self, left: &str, right: &str) -> Result<Ordering, GatewayError> {
        compare_labels(left, right)
    }
}

pub fn compare_labels(left: &str, right: &str) -> Result<Ordering, GatewayError> {
    let unavailable = || {
        GatewayError::unavailable(
            "Administrative label collation is unavailable.",
            "admin_label_collation_unavailable",
        )
    };
    let string = Reflect::get(&worker::js_sys::global(), &JsValue::from_str("String"))
        .map_err(|_| unavailable())?;
    let prototype =
        Reflect::get(&string, &JsValue::from_str("prototype")).map_err(|_| unavailable())?;
    let compare = Reflect::get(&prototype, &JsValue::from_str("localeCompare"))
        .map_err(|_| unavailable())?
        .dyn_into::<Function>()
        .map_err(|_| unavailable())?;
    compare
        .call1(&JsValue::from_str(left), &JsValue::from_str(right))
        .map_err(|_| unavailable())?
        .as_f64()
        .and_then(|value| value.partial_cmp(&0.0))
        .ok_or_else(unavailable)
}

fn unavailable(capability: &str) -> GatewayError {
    GatewayError::unavailable(
        format!("Required {capability} capability is not configured"),
        "admin_capability_unavailable",
    )
}
