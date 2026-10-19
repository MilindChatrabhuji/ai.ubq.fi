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
use gateway_schema::util::js_trim;
use worker::Env;
use worker::js_sys::{Function, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue};

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
    observations: crate::observability_host::Runtime,
    support: crate::admin_support_host::Binding,
    original: gateway_auth::AuthRequest,
    auth_config: gateway_auth::AuthConfig,
    actor: std::rc::Rc<gateway_authority::native_control::actor::NativeRenewalActor>,
}

impl Capabilities {
    pub fn new(
        request_id: &RequestId,
        original_body: &[u8],
        original_request: &gateway_auth::AuthRequest,
        store: crate::authority::RemoteAuthorityStore,
        platform: &crate::host::PlatformHost,
        context: std::rc::Rc<worker::Context>,
        actor: std::rc::Rc<gateway_authority::native_control::actor::NativeRenewalActor>,
    ) -> Result<Self, GatewayError> {
        let observations = crate::observability_host::bind_admin(
            request_id,
            original_body,
            store.clone(),
            platform,
            context.clone(),
            actor.clone(),
        )?;
        let catalog_host = crate::catalog_host::Host {
            store: store.clone(),
            env: platform.env.clone(),
            platform: platform.clone(),
            context,
        };
        let support =
            crate::admin_support_host::Binding::new(catalog_host.clone(), observations.clone());
        // AuthService consumes the exact original authentication metadata. Its
        // raw body stays in the separately measured request receipt, not a second copy.
        let original = gateway_auth::AuthRequest {
            method: original_request.method.clone(),
            url: original_request.url.clone(),
            headers: original_request.headers.clone(),
            body: Vec::new(),
            native_peer: original_request.native_peer.clone(),
        };
        Ok(Self {
            request_id: request_id.0.clone(),
            original_body_bytes: original_body.len(),
            catalog_service: crate::catalog::service(),
            catalog_host,
            observations,
            support,
            original,
            auth_config: crate::host::auth_config(&platform.env),
            actor,
        })
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
    async fn migration(
        &self,
        request: gateway_admin_runtime::capabilities::MigrationRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        self.measured_body_bytes(&context)?;
        self.catalog_host
            .store
            .profile_migration(request, context)
            .await
    }
    async fn capture(
        &self,
        request: gateway_admin_runtime::capabilities::CaptureRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        self.measured_body_bytes(&context)?;
        use gateway_admin_runtime::capabilities::CaptureRequest;
        match request {
            CaptureRequest::Request { request_id } => {
                self.observations.export_capture_request(&request_id).await
            }
            CaptureRequest::Interval {
                after_ms,
                before_ms,
                cursor,
            } => {
                self.observations
                    .export_capture_interval(after_ms, before_ms, cursor.as_deref())
                    .await
            }
            CaptureRequest::Incident {
                incident_id,
                cursor,
            } => {
                self.observations
                    .export_incident_captures(&incident_id, cursor.as_deref())
                    .await
            }
            CaptureRequest::Incidents {
                incident_id,
                cursor,
                limit,
            } => {
                self.observations
                    .list_incidents(incident_id.as_deref(), cursor.as_deref(), limit)
                    .await
            }
        }
    }
    async fn codex(
        &self,
        request: gateway_admin_runtime::capabilities::CodexRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        self.measured_body_bytes(&context)?;
        crate::codex_admin_host::execute(
            &self.catalog_host.store,
            &self.catalog_host.platform,
            crate::codex_admin_host::OriginalAdmin {
                request: &self.original,
                config: &self.auth_config,
                actor: &self.actor,
            },
            request,
            context,
            &self.observations,
        )
        .await
    }
    async fn provider_picker(&self, context: Context) -> Result<serde_json::Value, GatewayError> {
        self.measured_body_bytes(&context)?;
        self.support.provider_picker(context).await
    }
    async fn metered_diagnostics(&self) -> Result<serde_json::Value, GatewayError> {
        self.support.metered_diagnostics().await
    }
    async fn pricing(
        &self,
        models: &[gateway_core::model::ModelId],
    ) -> Result<gateway_admin_runtime::capabilities::PricingSnapshot, GatewayError> {
        self.support.pricing(models).await
    }
    async fn error_diagnostics(
        &self,
        context: Context,
    ) -> Result<gateway_admin_runtime::capabilities::ErrorDiagnostics, GatewayError> {
        self.measured_body_bytes(&context)?;
        self.support.error_diagnostics(context).await
    }
    async fn supervisor_brief(
        &self,
        target: gateway_admin_runtime::capabilities::SupervisorBriefTarget,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        self.measured_body_bytes(&context)?;
        self.support.supervisor_brief(target, context).await
    }
    async fn claude(
        &self,
        request: gateway_admin_runtime::capabilities::ClaudeRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        self.measured_body_bytes(&context)?;
        crate::claude_host::admin(
            &self.catalog_host.store,
            &self.catalog_host.platform,
            &self.observations,
            request,
            context,
        )
        .await
    }
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
        Ok(crate::catalog::into_auth_response(
            self.catalog_service
                .admin_catalog(&self.catalog_host.store, &self.catalog_host, operation)
                .await,
        ))
    }
    async fn provider(
        &self,
        request: ProviderRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        self.measured_body_bytes(&context)?;
        self.observations.provider(request, context).await
    }
    async fn analytics(
        &self,
        request: AnalyticsRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        self.measured_body_bytes(&context)?;
        self.observations.analytics(request, context).await
    }
    fn compare_admin_labels(
        &self,
        left: &gateway_core::js_string::JsString16,
        right: &gateway_core::js_string::JsString16,
    ) -> Result<Ordering, GatewayError> {
        crate::source_collator::shared().compare(left, right)
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
