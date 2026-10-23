//! Source analytics.ts and admin/error-log.ts. This is the existing request ledger.
use crate::{ObservabilityRuntime, store, types::ObservabilityHost};
use gateway_core::{
    GatewayError, js_string::JsString16, lifecycle::DeliveryOutcome, query::QueryStore,
    source_json::SourceJson, source_serialization as source,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod terminal_rollup;

pub const REQUEST_RETENTION_MS: i64 = 365 * store::DAY;
pub const ERROR_RETENTION_MS: i64 = 7 * store::DAY;
fn integer(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map(f64::trunc)
        .unwrap_or(fallback)
}
/// Explicit typed normalization. Surrogate-bearing leaves never pass through Value.
pub fn normalize_request_record(
    input: &gateway_core::source_json::SourceJson,
    key_id: &str,
    request_id: &str,
    created_at_ms: f64,
) -> Result<Option<crate::records::RequestLogRecord>, GatewayError> {
    crate::records::RequestLogRecord::normalize(
        input,
        key_id,
        &gateway_core::js_string::JsString16::from_utf8(request_id),
        created_at_ms,
    )
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ErrorObservation {
    pub request_id: String,
    pub route: String,
    pub status: u16,
    pub provider: String,
    pub model: Option<JsString16>,
    pub reasoning: Option<JsString16>,
    pub stream: Option<bool>,
    pub terminal_type: Option<String>,
    pub failure_kind: Option<String>,
    pub delivery_outcome: DeliveryOutcome,
    pub created_at_ms: i64,
    pub latency_ms: i64,
    pub git_sha: Option<String>,
    pub deno_revision: Option<String>,
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub async fn record_request_log(
        &self,
        key_id: &str,
        input: &Value,
    ) -> Result<(), GatewayError> {
        self.record_request_log_source(key_id, &SourceJson::from_serializable(input)?)
            .await
    }
    pub async fn record_request_log_source(
        &self,
        key_id: &str,
        input: &SourceJson,
    ) -> Result<(), GatewayError> {
        if store::trim(key_id).is_empty() {
            return Ok(());
        }
        let at = store::now(self.host.as_ref())?;
        let raw_id = source::member(input, "id").and_then(|v| v.deserialize::<JsString16>().ok());
        let id = crate::records::bounded_text(
            raw_id.as_ref(),
            120,
            &gateway_core::js_string::JsString16::from_utf8(&store::uuid(self.host.as_ref())?),
        );
        let created =
            crate::records::number(source::member(input, "created_at_ms").as_ref(), at as f64);
        self.mutate_request_log(key_id, created, &id, input, false)
            .await
    }
    pub async fn update_request_log(
        &self,
        key_id: &str,
        created_at_ms: i64,
        request_id: &str,
        patch: &Value,
    ) -> Result<(), GatewayError> {
        self.update_request_log_source(
            key_id,
            created_at_ms,
            request_id,
            &SourceJson::from_serializable(patch)?,
        )
        .await
    }
    pub async fn update_request_log_source(
        &self,
        key_id: &str,
        created_at_ms: i64,
        request_id: &str,
        patch: &SourceJson,
    ) -> Result<(), GatewayError> {
        self.mutate_request_log(
            key_id,
            created_at_ms as f64,
            &gateway_core::js_string::JsString16::from_utf8(request_id),
            patch,
            true,
        )
        .await
    }
    async fn mutate_request_log(
        &self,
        key_id: &str,
        created: f64,
        request_id: &gateway_core::js_string::JsString16,
        patch: &SourceJson,
        only_existing: bool,
    ) -> Result<(), GatewayError> {
        if store::trim(key_id).is_empty() {
            return Ok(());
        }
        let key = gateway_core::tuple_key::TupleKey::from_parts(&[
            gateway_core::tuple_key::KeyPart::String("uos_ai".into()),
            gateway_core::tuple_key::KeyPart::String("paid_fallback".into()),
            gateway_core::tuple_key::KeyPart::String("ledger".into()),
            gateway_core::tuple_key::KeyPart::String(key_id.into()),
            gateway_core::tuple_key::KeyPart::Number(created),
            gateway_core::tuple_key::KeyPart::source_string_utf16(request_id.as_units()),
        ])?
        .to_record_key();
        for _ in 0..3 {
            let row = self.store.read(&key).await?;
            let at = store::now(self.host.as_ref())?;
            let existing = match row
                .as_ref()
                .filter(|r| r.expires_at_ms.is_none_or(|t| t > at))
            {
                Some(row) => crate::records::RequestLogRecord::normalize(
                    &crate::records::record_source_json(row)?,
                    key_id,
                    request_id,
                    created,
                )?,
                None => None,
            };
            if only_existing && existing.is_none() {
                return Ok(());
            }
            let record = crate::records::merge_request_fields_source(
                existing.as_ref(),
                patch,
                key_id,
                request_id,
                created,
            )?;
            let expiry = (created + REQUEST_RETENTION_MS as f64).max((at + 1) as f64);
            if !expiry.is_finite() || expiry > gateway_core::identity::MAX_SAFE_INTEGER as f64 {
                return Err(store::error("Request retention overflow"));
            }
            let expiry = expiry as i64;
            if store::commit(
                self.store.as_ref(),
                vec![store::check(&key, row.as_ref())],
                vec![crate::records::put_record(
                    self.host.as_ref(),
                    key.clone(),
                    &record.source_json()?,
                    expiry,
                )?],
            )
            .await?
            {
                return Ok(());
            }
        }
        Err(store::error(format!(
            "paid fallback ledger changed concurrently: {request_id:?}"
        )))
    }
    pub async fn request_logs(
        &self,
        key_id: &str,
        limit: u32,
    ) -> Result<Vec<gateway_core::source_json::SourceJson>, GatewayError> {
        if store::trim(key_id).is_empty() {
            return Ok(Vec::new());
        }
        let at = store::now(self.host.as_ref())?;
        let entries = store::scan(
            self.store.as_ref(),
            store::key(json!(["uos_ai", "paid_fallback", "ledger", key_id])),
            true,
            at,
            limit.clamp(1, 100) as usize,
        )
        .await?;
        let mut out = Vec::new();
        for entry in entries {
            let parts = store::parts(&entry.key)?;
            let id = parts.last().and_then(Value::as_str).unwrap_or("request");
            let created = integer(parts.get(parts.len().saturating_sub(2)), at as f64);
            if let Some(record) = normalize_request_record(
                &crate::records::record_source_json(&entry.record)?,
                key_id,
                id,
                created,
            )? {
                out.push(record.source_json()?)
            }
        }
        Ok(out)
    }
    /// Gateway auth401 returns before any KV read/write, preserving the source zero-KV path.
    pub async fn record_admin_error(&self, input: &ErrorObservation) -> Result<bool, GatewayError> {
        if input.status == 401 && input.provider == "gateway" {
            return Ok(false);
        }
        let terminal = input.terminal_type.as_deref();
        let failed = input.status >= 400
            || matches!(
                terminal,
                Some("error" | "eof" | "deadline" | "response.failed" | "response.incomplete")
            )
            || input.failure_kind.is_some();
        if !failed {
            return Ok(false);
        }
        let document = crate::records::error_document(input)?;
        let key = store::key(json!([
            "uos_ai",
            "admin_error_log",
            "v1",
            input.created_at_ms,
            input.request_id
        ]));
        let expiry = store::now(self.host.as_ref())?
            .checked_add(ERROR_RETENTION_MS)
            .ok_or_else(|| store::error("Error retention overflow"))?;
        store::commit(
            self.store.as_ref(),
            Vec::new(),
            vec![crate::records::put_record(
                self.host.as_ref(),
                key,
                &document,
                expiry,
            )?],
        )
        .await
    }
}
