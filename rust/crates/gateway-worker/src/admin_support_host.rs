//! Fixed administrator read/summary operations over the current request's hosts.
use gateway_admin_runtime::{
    brief,
    capabilities::{Context, ErrorDiagnostics, PricingSnapshot, SupervisorBriefTarget},
};
use gateway_auth::{AuthResponse, native::NativeReadRequest};
use gateway_catalog_runtime::admin::AdminCatalogOperation;
use gateway_core::GatewayError;
use serde_json::Value;
use std::collections::BTreeMap;
use worker::Method;

mod picker;
mod pricing;

pub struct Binding {
    catalog: crate::catalog_host::Host,
    observations: crate::observability_host::Runtime,
}
impl Binding {
    pub fn new(
        catalog: crate::catalog_host::Host,
        observations: crate::observability_host::Runtime,
    ) -> Self {
        Self {
            catalog,
            observations,
        }
    }
    pub async fn provider_picker(&self, _: Context) -> Result<Value, GatewayError> {
        let response = crate::catalog::service()
            .admin_catalog(
                &self.catalog.store,
                &self.catalog,
                AdminCatalogOperation::Catalog,
            )
            .await
            .map_err(catalogue_error)?;
        let subscriptions = picker::subscriptions(&self.catalog.store).await;
        picker::project(
            &gateway_core::source_serialization::member(&response.body, "data").unwrap_or_else(
                || {
                    gateway_core::source_json::SourceJson::parse("null")
                        .expect("null is source JSON")
                },
            ),
            subscriptions,
            &crate::catalog_host::secrets(&self.catalog.env),
        )
    }
    pub async fn metered_diagnostics(&self) -> Result<Value, GatewayError> {
        crate::observability_host::metered_diagnostics(&self.observations).await
    }
    pub async fn pricing(
        &self,
        models: &[gateway_core::model::ModelId],
    ) -> Result<PricingSnapshot, GatewayError> {
        let ratios = pricing::fetch(self, pricing::Metadata::Ratios).await?;
        let status = pricing::fetch(self, pricing::Metadata::Status).await?;
        pricing::project(models, &ratios, &status, crate::storage::now_ms()?)
    }
    pub async fn error_diagnostics(
        &self,
        context: Context,
    ) -> Result<ErrorDiagnostics, GatewayError> {
        crate::observability_host::error_diagnostics(&self.observations, &context).await
    }
    pub async fn supervisor_brief(
        &self,
        target: SupervisorBriefTarget,
        _: Context,
    ) -> Result<AuthResponse, GatewayError> {
        let sampled = crate::storage::now_ms()?;
        let response = self
            .catalog
            .platform
            .native
            .rpc(
                NativeReadRequest::SupervisorBrief {
                    source_id: target.source_id.clone(),
                    thread_id: target.thread_id.clone(),
                },
                &self.catalog.platform,
            )
            .await?;
        if response.status >= 400 {
            return Ok(response);
        }
        let context = brief::BriefContext::from_native(
            response
                .body
                .as_json()
                .ok_or_else(|| unavailable("Native brief context is malformed."))?,
            &target,
        )?;
        match brief::plan(&context, sampled, crate::storage::now_ms()?) {
            brief::BriefPlan::Unavailable(body) => Ok(AuthResponse::json(200, body)),
            brief::BriefPlan::Generate { body, deadline_ms } => {
                let key = crate::host::provider_secret(&self.catalog.env, "CEREBRAS_API_KEY")
                    .ok_or_else(|| unavailable("Cerebras summarizer is not configured."))?;
                let headers = BTreeMap::from([
                    ("Authorization".into(), format!("Bearer {key}")),
                    ("Content-Type".into(), "application/json".into()),
                ]);
                let body = serde_json::to_vec(&body)
                    .map_err(|_| unavailable("Brief request is invalid."))?;
                let reply = self
                    .fixed_json(
                        "https://api.cerebras.ai/v1/chat/completions",
                        Method::Post,
                        &headers,
                        &body,
                        Some(deadline_ms),
                    )
                    .await?;
                Ok(AuthResponse::json(
                    200,
                    brief::completed(&context, &reply, sampled, crate::storage::now_ms()?)?,
                ))
            }
        }
    }
    async fn fixed_json(
        &self,
        url: &str,
        method: Method,
        headers: &BTreeMap<String, String>,
        body: &[u8],
        deadline_ms: Option<u32>,
    ) -> Result<Value, GatewayError> {
        let target = crate::transport::outbound::PinnedDestination::new(url)?;
        let cancellation = self.catalog.platform.cancellation.child()?;
        let _deadline = deadline_ms
            .map(|ms| cancellation.set_timeout_ms(ms as i32))
            .transpose()?;
        let mut response = crate::transport::outbound::send_http(
            &target,
            method,
            headers,
            body,
            &cancellation,
            || async { Ok(()) },
        )
        .await
        .map_err(|failure| failure.error)?;
        if !(200..300).contains(&response.status_code()) {
            crate::transport::body::discard_response(&mut response);
            return Err(unavailable(
                "Administrator metadata or summarizer request failed.",
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| unavailable("Administrator response could not be read."))?;
        let text = String::from_utf8_lossy(&bytes);
        serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text))
            .map_err(|_| unavailable("Administrator response is invalid JSON."))
    }
}
fn unavailable(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "admin_support_unavailable")
}

// Only AdminCatalogOperation::Catalog reaches this helper. Its exact two errors
// are admin.rs213/216 map_err(lift), lift73 = SourceRequestError::from_gateway.
// Clone therefore preserves the actual original error body/status, not a fallback diagnostic.
fn catalogue_error(error: gateway_schema::source_request::SourceRequestError) -> GatewayError {
    error.diagnostic().clone()
}

#[cfg(test)]
mod catalogue_tests {
    #[test]
    fn catalogue_lift_preserves_the_exact_original_gateway_error() {
        let original =
            gateway_core::GatewayError::new(409, "original catalog error", Some("catalog_fixture"))
                .with_type("server_error")
                .with_param(None);
        let source =
            gateway_schema::source_request::SourceRequestError::from_gateway(original.clone());
        let expected = source.body().as_bytes().to_vec();
        let actual = super::catalogue_error(source);
        assert_eq!(actual, original);
        assert_eq!(
            gateway_core::source_json::SourceJson::from_serializable(&actual.envelope)
                .unwrap()
                .as_bytes(),
            expected
        );
    }
}
