//! Fixed native import validation. Candidates are DATA, never mutation or publication authority.
use gateway_auth::native_credentials::NativeCredentials;
use gateway_core::source_json::SourceJson;

pub(super) enum CatalogValidation {
    Normalized {
        snapshot: SourceJson,
        client_version: String,
        upstream_status: u16,
    },
    AuthenticatedLimited,
}
// Only the fixed models/OAuth producer below may create this; callers cannot deserialize it.
pub(super) struct ValidatedNativeImport {
    pub(super) document: SourceJson,
    pub(super) credentials: NativeCredentials,
    pub(super) catalog: CatalogValidation,
    pub(super) refreshed: bool,
}

use super::{ExistingAccountImportStore, LiveImportCustody, import_documents as document};
use crate::{native_import::NativeImportContext, private_https::{PrivateHttps, PrivateResponse}};
use gateway_authority::native_control::import::AuthenticatedNativeImport;
use gateway_core::{GatewayError, js_string::JsString16};
use std::{net::TcpStream, time::{Duration, Instant}};
use crate::import_custody_protocol::unavailable;

/// Constructor-preconnected fixed TLS origins, never a caller URL or a ProviderLive connector.
pub(super) struct ImportValidation {
    models: PrivateHttps,
    oauth: Option<PrivateHttps>,
    client_version: String,
}
pub(super) struct NeedsRefresh401 {
    document: SourceJson,
    credentials: NativeCredentials,
    original_error: GatewayError,
}
pub(super) enum ValidationOutcome {
    Valid(ValidatedNativeImport),
    Original401(NeedsRefresh401),
}
impl ImportValidation {
    pub(super) fn from_connected(models: TcpStream, oauth: Option<TcpStream>, version: Option<&JsString16>, roots: ureq::tls::RootCerts) -> Result<Self, GatewayError> {
        let client_version = selected_version(version);
        let models = PrivateHttps::models_connected(models, roots.clone(), &client_version)?;
        let oauth = oauth.map(|socket| PrivateHttps::from_connected("https://auth.openai.com/oauth/token", "/oauth/token", socket, roots)).transpose()?;
        Ok(Self { models, oauth, client_version })
    }
    pub(super) fn probe(&self, context: &NativeImportContext<'_>) -> Result<ValidationOutcome, GatewayError> {
        context.check()?;
        let source = context.auth_data().auth().clone();
        let credentials = document::credentials(&source)?;
        if credentials.external_user_id.is_some() { return Err(unavailable()); }
        let response = self.models(&credentials, context)?;
        if response.status == 401 {
            return Ok(ValidationOutcome::Original401(NeedsRefresh401 {
                original_error: model_error(&response, &credentials), document: source, credentials,
            }));
        }
        self.finish(source, credentials, response, false, context).map(ValidationOutcome::Valid)
    }
    fn models(&self, credentials: &NativeCredentials, context: &NativeImportContext<'_>) -> Result<PrivateResponse, GatewayError> {
        context.check()?;
        let headers = vec![("Authorization".into(), format!("Bearer {}", credentials.access_token.expose())),
            ("ChatGPT-Account-ID".into(), credentials.account_id.clone()), ("originator".into(), "codex_cli_rs".into()),
            ("user-agent".into(), format!("codex_cli_rs/{} (ai.ubq.fi)", self.client_version))];
        let result = self.models.get_models(&headers, context.deadline()).map_err(|_| GatewayError::new(502,
            "Upstream validation request failed: Codex upstream request failed: upstream unreachable.", Some("codex_upstream_unreachable")))?;
        context.check()?; Ok(result)
    }
    fn finish(&self, source: SourceJson, credentials: NativeCredentials, response: PrivateResponse,
        refreshed: bool, context: &NativeImportContext<'_>) -> Result<ValidatedNativeImport, GatewayError> {
        context.check()?;
        let catalog = if response.status == 429 { CatalogValidation::AuthenticatedLimited }
        else if (200..300).contains(&response.status) {
            let is_json = response.headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("content-type") && value.contains("application/json"));
            if !is_json { return Err(invalid_catalog()); }
            let body = SourceJson::parse_bytes(&response.body).map_err(|_| invalid_catalog())?;
            // M22's narrow helper reuses the original normalizer; DATA serialization is not proof.
            let prepared = gateway_publication::prepare_import_catalog(&body, &self.client_version, response.status, context.now_ms()?)?;
            let value = SourceJson::from_serializable(&prepared)?;
            let snapshot = document::member(&value, "snapshot")?.ok_or_else(invalid_catalog)?;
            CatalogValidation::Normalized { snapshot, client_version: self.client_version.clone(), upstream_status: response.status }
        } else { return Err(model_error(&response, &credentials)); };
        Ok(ValidatedNativeImport { document: source, credentials, catalog, refreshed })
    }
    /// A genuine original401 plus consumed original Start/live custody is required before the one dispatch.
    pub(super) fn refresh_once(&mut self, pending: NeedsRefresh401, custody: &mut LiveImportCustody<'_>, store: &ExistingAccountImportStore,
        proof: &AuthenticatedNativeImport, body: &[u8], context: &NativeImportContext<'_>) -> Result<ValidatedNativeImport, GatewayError> {
        custody.check_live(store, proof, body, context)?;
        let transport = self.oauth.take().ok_or_else(unavailable)?;
        let request = serde_json::to_vec(&serde_json::json!({"client_id":"app_EMoamEEZ73f0CkXaXp7hrann", "grant_type":"refresh_token",
            "refresh_token":pending.credentials.refresh_token.expose(), "scope":"openid profile email"})).map_err(|_| unavailable())?;
        // Taking the unique transport before sending prevents retry after any ambiguous result.
        let response = transport.send(&[], &request, context.deadline().min(Instant::now() + Duration::from_secs(10)), usize::MAX);
        custody.check_live(store, proof, body, context)?;
        let response = response.map_err(|_| pending.original_error.clone())?;
        if !(200..300).contains(&response.status) { return Err(pending.original_error); }
        let rotated = SourceJson::parse_bytes(&response.body).map_err(|_| pending.original_error.clone())?;
        let tokens = document::member(&pending.document, "tokens")?.ok_or_else(unavailable)?;
        let mut fields = pending.document.object_entries()?;
        fields.retain(|(k, _)| !["tokens", "last_refresh"].iter().any(|n| *k == JsString16::from_utf8(n)));
        fields.push((JsString16::from_utf8("tokens"), document::object(tokens_replaced(&tokens, &rotated, &pending.credentials).map_err(|_| pending.original_error.clone())?)?));
        let timestamp = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(context.now_ms()?) * 1_000_000)
            .map_err(|_| unavailable())?.format(&time::format_description::well_known::Rfc3339).map_err(|_| unavailable())?;
        fields.push((JsString16::from_utf8("last_refresh"), SourceJson::from_serializable(&timestamp)?));
        let source = document::object(fields)?;
        let credentials = document::credentials(&source)?;
        // Rotated material is durable native-private before a later catalog retry can fail.
        super::durability::retain_rotated(store, custody, proof, body, context, &source)?;
        let result = self.models(&credentials, context).map_err(|_| pending.original_error.clone())?;
        custody.check_live(store, proof, body, context)?;
        self.finish(source, credentials, result, true, context)
    }
}
fn tokens_replaced(tokens: &SourceJson, rotated: &SourceJson, previous: &NativeCredentials) -> Result<Vec<(JsString16, SourceJson)>, GatewayError> {
    let mut fields = tokens.object_entries()?;
    fields.retain(|(k, _)| !["access_token", "refresh_token"].iter().any(|n| *k == JsString16::from_utf8(n)));
    let access = document::member(rotated, "access_token")?.filter(|v| nonempty_string(v).is_some()).ok_or_else(unavailable)?;
    let refresh = document::member(rotated, "refresh_token")?.filter(|v| nonempty_string(v).is_some())
        .unwrap_or(SourceJson::from_serializable(previous.refresh_token.expose())?);
    fields.push((JsString16::from_utf8("access_token"), access)); fields.push((JsString16::from_utf8("refresh_token"), refresh));
    Ok(fields)
}
fn nonempty_string(value: &SourceJson) -> Option<String> {
    let text: String = value.deserialize().ok()?;
    (!text.trim().is_empty()).then_some(text)
}
fn selected_version(version: Option<&JsString16>) -> String {
    let supplied = version.and_then(|v| v.try_utf8().ok()).map(|v| v.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').to_owned());
    let valid = supplied.as_deref().is_some_and(|v| {
        let parts: Vec<_> = v.split('.').collect();
        parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())
            && { let digits = p.trim_start_matches('0'); digits.is_empty() || (digits.len() <= 16 && digits.parse::<u64>().is_ok_and(|n| n <= gateway_core::identity::MAX_SAFE_INTEGER as u64)) })
    });
    if valid { supplied.unwrap_or_else(|| "0.100.0".into()) } else { "0.100.0".into() }
}
fn invalid_catalog() -> GatewayError {
    GatewayError::new(502, "Codex upstream models response did not include a non-empty model catalog", Some("codex_upstream_unreachable"))
}
fn model_error(response: &PrivateResponse, credentials: &NativeCredentials) -> GatewayError {
    let mut text = String::from_utf8_lossy(&response.body).into_owned();
    for secret in [credentials.access_token.expose(), credentials.refresh_token.expose()] {
        if !secret.is_empty() { text = text.replace(secret, "[redacted]"); }
    }
    let text = JsString16::from_utf8(&text).prefix_units(8000).try_utf8().unwrap_or_default();
    GatewayError::new(401, format!("Invalid Codex auth.json (upstream {}): {text}", response.status), Some("invalid_api_key"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_client_version_precedence_grammar_and_safe_integer_domain_are_not_narrowed() {
        assert_eq!(selected_version(None), "0.100.0");
        for invalid in ["", "1.2", "-1.2.3", "1.2.3-beta", "9007199254740992.0.0", "NaN.0.0"] {
            assert_eq!(selected_version(Some(&JsString16::from_utf8(invalid))), "0.100.0");
        }
        for valid in ["1.2.3", "01.002.0003", "9007199254740991.0.0"] {
            assert_eq!(selected_version(Some(&JsString16::from_utf8(valid))), valid);
        }
        let zeros = format!("{}.0.0", "0".repeat(3000));
        assert_eq!(selected_version(Some(&JsString16::from_utf8(&zeros))), zeros);
        assert_eq!(selected_version(Some(&JsString16::from_utf8("\u{feff} 1.2.3 \u{feff}"))), "1.2.3");
        assert_eq!(selected_version(Some(&JsString16::from_units(vec![0xd800]))), "0.100.0");
    }
}
