//! Source read-only reset-credit and overage displays. These GETs never authorize a redemption.
use super::{RequestHost, unavailable};
use gateway_auth::provider_credentials::CodexSourceAccount;
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};
use gateway_observability::host_types::{CapacityAccountRef, ResetCreditDiagnostic};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
fn field(value: &SourceJson, name: &str) -> Option<SourceJson> {
    value
        .object_entries()
        .ok()?
        .into_iter()
        .rev()
        .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
        .map(|(_, v)| v)
}
fn counter(value: &SourceJson) -> Option<i64> {
    value
        .deserialize::<f64>()
        .ok()
        .filter(|n| {
            n.is_finite()
                && n.fract() == 0.0
                && (0.0..=gateway_core::identity::MAX_SAFE_INTEGER as f64).contains(n)
        })
        .map(|n| n as i64)
}
fn nonblank(value: &JsString16) -> bool {
    value
        .as_units()
        .iter()
        .any(|u| !char::from_u32(u32::from(*u)).is_some_and(gateway_schema::util::js_whitespace))
}
fn inventory_url(base: &str) -> Result<worker::Url, GatewayError> {
    let mut url = worker::Url::parse(base.trim_matches(gateway_schema::util::js_whitespace))
        .map_err(|_| unavailable("Reset-credit base URL is invalid."))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(unavailable(
            "Reset-credit base URL must be HTTPS without credentials, query or fragment.",
        ));
    }
    let path = match url.path().trim_end_matches('/') {
        "/backend-api" | "/backend-api/codex" => "/backend-api/wham/rate-limit-reset-credits",
        "" | "/api/codex" => "/api/codex/rate-limit-reset-credits",
        _ => {
            return Err(unavailable(
                "Reset-credit base URL has no supported Codex layout.",
            ));
        }
    };
    url.set_path(path);
    Ok(url)
}
impl RequestHost {
    async fn diagnostic_account(
        &self,
        reference: &CapacityAccountRef,
    ) -> Result<Option<CodexSourceAccount>, GatewayError> {
        let (_, accounts) = self.codex_accounts().await?;
        Ok(accounts
            .into_iter()
            .enumerate()
            .find(|(index, account)| {
                *index + 1 == usize::from(reference.slot)
                    && account.account_id == reference.account_id
            })
            .map(|(_, account)| account))
    }
    async fn diagnostic_document(
        &self,
        url: &str,
        headers: &BTreeMap<String, String>,
        deadline: i64,
    ) -> Result<Option<SourceJson>, GatewayError> {
        let mut reply = self.fixed_get(url, headers, deadline).await?;
        if !(200..300).contains(&reply.response.status_code()) {
            return Ok(None);
        }
        let bytes = reply
            .response
            .bytes()
            .await
            .map_err(|_| unavailable("Codex diagnostics response could not be read."))?;
        let decoded = String::from_utf8_lossy(&bytes);
        SourceJson::parse(decoded.strip_prefix('\u{feff}').unwrap_or(&decoded)).map(Some)
    }
    async fn reset_inventory(
        &self,
        reference: &CapacityAccountRef,
        deadline: i64,
    ) -> Result<Option<SourceJson>, GatewayError> {
        let Some(account) = self.diagnostic_account(reference).await? else {
            return Ok(None);
        };
        let base = crate::host::setting(&self.platform.env, "CODEX_BASE_URL")
            .unwrap_or_else(|| "https://chatgpt.com/backend-api/codex".into());
        let url = inventory_url(&base)?;
        let headers = BTreeMap::from([
            (
                "Authorization".into(),
                format!("Bearer {}", account.access_token.expose()),
            ),
            ("ChatGPT-Account-ID".into(), account.account_id),
            (
                "User-Agent".into(),
                "codex_cli_rs/0.100.0 (ai.ubq.fi)".into(),
            ),
        ]);
        self.diagnostic_document(url.as_str(), &headers, deadline)
            .await
    }
    pub(super) async fn reset_count(
        &self,
        reference: &CapacityAccountRef,
        deadline: i64,
    ) -> Result<Option<i64>, GatewayError> {
        let Some(value) = self.reset_inventory(reference, deadline).await? else {
            return Ok(None);
        };
        Ok(field(&value, "available_count").as_ref().and_then(counter))
    }
    pub(super) async fn reset_credits(
        &self,
        reference: &CapacityAccountRef,
        deadline: i64,
    ) -> Result<Option<Vec<ResetCreditDiagnostic>>, GatewayError> {
        let Some(value) = self.reset_inventory(reference, deadline).await? else {
            return Ok(None);
        };
        let Some(available) = field(&value, "available_count").as_ref().and_then(counter) else {
            return Ok(None);
        };
        let Some(items) = field(&value, "credits").and_then(|v| v.array_items().ok()) else {
            return Ok(None);
        };
        let mut ids = BTreeSet::new();
        let mut result = Vec::new();
        for item in items {
            let Some(id) = field(&item, "id")
                .and_then(|v| v.deserialize::<JsString16>().ok())
                .filter(nonblank)
            else {
                return Ok(None);
            };
            let Some(status) = field(&item, "status")
                .and_then(|v| v.deserialize::<JsString16>().ok())
                .filter(nonblank)
            else {
                return Ok(None);
            };
            if field(&item, "reset_type")
                .and_then(|v| v.deserialize::<JsString16>().ok())
                .filter(nonblank)
                .is_none()
                || !ids.insert(id)
            {
                return Ok(None);
            }
            let Some(expiry) = field(&item, "expires_at") else {
                return Ok(None);
            };
            let expiry = if expiry.as_str() == "null" {
                None
            } else {
                let Some(text) = expiry.deserialize::<String>().ok().filter(|s| {
                    !s.trim_matches(gateway_schema::util::js_whitespace)
                        .is_empty()
                }) else {
                    return Ok(None);
                };
                let parsed = worker::js_sys::Date::parse(&text);
                if !parsed.is_finite()
                    || parsed.fract() != 0.0
                    || !(0.0..=gateway_core::identity::MAX_SAFE_INTEGER as f64).contains(&parsed)
                {
                    return Ok(None);
                }
                Some(parsed as i64)
            };
            if status
                .as_units()
                .iter()
                .copied()
                .eq("available".encode_utf16())
            {
                result.push(ResetCreditDiagnostic {
                    status: "available".into(),
                    expires_at_ms: expiry,
                });
            }
        }
        if result.len() as i64 != available {
            return Ok(None);
        }
        result.sort_by_key(|credit| credit.expires_at_ms.unwrap_or(i64::MAX));
        Ok(Some(result))
    }
    pub(super) async fn overage(
        &self,
        reference: &CapacityAccountRef,
        deadline: i64,
    ) -> Result<Option<Value>, GatewayError> {
        let Some(account) = self.diagnostic_account(reference).await? else {
            return Ok(None);
        };
        let base = crate::host::setting(&self.platform.env, "CODEX_BASE_URL")
            .unwrap_or_else(|| "https://chatgpt.com/backend-api/codex".into());
        let url = worker::Url::parse(&base)
            .and_then(|u| u.join("/backend-api/wham/usage"))
            .map_err(|_| unavailable("Codex diagnostics base URL is invalid."))?;
        let headers = BTreeMap::from([
            ("Accept".into(), "application/json".into()),
            (
                "Authorization".into(),
                format!("Bearer {}", account.access_token.expose()),
            ),
            ("ChatGPT-Account-ID".into(), account.account_id),
            (
                "User-Agent".into(),
                "codex_cli_rs/0.100.0 (ai.ubq.fi)".into(),
            ),
        ]);
        let Some(document) = self
            .diagnostic_document(url.as_str(), &headers, deadline)
            .await?
        else {
            return Ok(None);
        };
        let value = document.deserialize::<Value>()?;
        Ok(gateway_observability::capacity_shapes::parse_codex_overage(
            &value,
        ))
    }
}
