//! Source display facts only, not OAuth/renewal eligibility or a proof issuer.
use gateway_core::{
    source_json::SourceJson,
    source_serialization::{member, number},
};
fn whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub(super) fn expiry_display_ms(token: &str) -> Option<f64> {
    let parts = token
        .trim_matches(whitespace)
        .split('.')
        .collect::<Vec<_>>();
    if parts.len() != 3 || parts[1].is_empty() {
        return None;
    }
    // Source replaces base64url and pads BEFORE its TextDecoder helper removes JS whitespace.
    let mut encoded = parts[1]
        .chars()
        .map(|c| match c {
            '+' | '-' => '-',
            '/' | '_' => '_',
            _ => c,
        })
        .collect::<String>();
    encoded.extend(std::iter::repeat_n(
        '=',
        (4 - parts[1].encode_utf16().count() % 4) % 4,
    ));
    encoded.retain(|c| !whitespace(c));
    let bare = encoded.trim_end_matches('=');
    let padding = encoded.len() - bare.len();
    if padding > 2 || bare.contains('=') || padding > 0 && encoded.len() % 4 != 0 {
        return None;
    }
    let mut bare = bare.as_bytes().to_vec();
    // atob accepts unused trailing bits; normalize those bits for the pinned strict decoder.
    if let Some(last) = bare.last_mut() {
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let index = alphabet.iter().position(|b| b == last)?;
        let mask = match encoded.trim_end_matches('=').len() % 4 {
            2 => 0b110000,
            3 => 0b111100,
            _ => 0b111111,
        };
        *last = alphabet[index & mask];
    }
    let decoded = gateway_auth::crypto::decode_base64url(std::str::from_utf8(&bare).ok()?).ok()?;
    let decoded = decoded
        .strip_prefix(&[0xef, 0xbb, 0xbf])
        .unwrap_or(&decoded);
    let body = SourceJson::parse(&String::from_utf8_lossy(decoded)).ok()?;
    let exp = number(&member(&body, "exp")?)?;
    if !exp.is_finite() || exp == 0.0 {
        return None;
    }
    let result = exp * 1000.0;
    result.is_finite().then_some(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_expiry_display_retains_fraction_zero_null_and_unrelated_utf16() {
        for (payload, expected) in [
            (r#"{"exp":1.25}"#, Some(1250.0)),
            (r#"{"exp":0}"#, None),
            (r#"{"exp":-2.5}"#, Some(-2500.0)),
            (r#"{"exp":1,"other":"\ud800"}"#, Some(1000.0)),
            (r#"{"exp":"1"}"#, None),
            (r#"[1,2]"#, None),
            (r#"{"exp":1e309}"#, None),
        ] {
            let token = format!(
                "\u{feff} head.{}.signature \u{feff}",
                gateway_auth::crypto::base64url(payload.as_bytes())
            );
            assert_eq!(expiry_display_ms(&token), expected);
        }
        assert_eq!(expiry_display_ms("a..b"), None);
        assert_eq!(expiry_display_ms("a.b"), None);
    }
}

use super::{prepare_flow::VerifiedImportPublication, validation::CatalogValidation};
use crate::native_import::{NativeImportCompletion, NativeImportContext, NativeImportResult};
use gateway_auth::native_import::authority::ImportCompletionModelsData;
use gateway_authority::native_control::{NativeRenewalCancellation, import::RemoteImportAuthority};
use gateway_core::GatewayError;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize)]
struct SourceCompletion<'a> {
    stored: bool,
    refreshed: bool,
    account_id: &'a str,
    account_count: u64,
    account_ids: &'a [String],
    access_token_expires_at_ms: Option<f64>,
    updated_at_ms: f64,
    upstream_status: u16,
    upstream_content_type: Option<&'a str>,
    models: &'a ImportCompletionModelsData,
    catalog_seeded: bool,
    normalized_snapshot_updated: bool,
}
impl VerifiedImportPublication<'_> {
    pub(super) fn source_result<C: NativeRenewalCancellation>(
        &self,
        authority: &RemoteImportAuthority<'_, C>,
        context: &NativeImportContext<'_>,
    ) -> Result<NativeImportResult, GatewayError> {
        context.check()?;
        let candidate = self.candidate();
        let metadata = self.terminal.completion();
        if metadata
            .account_ids
            .iter()
            .filter(|id| **id == candidate.credentials.account_id)
            .count()
            != 1
        {
            return Err(super::unavailable());
        }
        let normalized = matches!(candidate.catalog, CatalogValidation::Normalized { .. });
        // The genuine guarded publication is already complete. An actual optional
        // seed error, including frame overflow, cannot undo that primary result.
        let catalog_seeded = if normalized {
            candidate
                .raw_models_body
                .as_deref()
                .map(|raw| {
                    authority
                        .seed_catalog(
                            &self.prepared.claim,
                            &self.terminal,
                            raw,
                            candidate.etag.as_deref(),
                            candidate.content_type.as_deref(),
                        )
                        .unwrap_or(false)
                })
                .unwrap_or(false)
        } else {
            false
        };
        context.check()?;
        let upstream_status = match candidate.catalog {
            CatalogValidation::Normalized {
                upstream_status, ..
            } => upstream_status,
            CatalogValidation::AuthenticatedLimited => 429,
        };
        let body = SourceJson::from_serializable(&SourceCompletion {
            stored: true,
            refreshed: normalized && candidate.refreshed,
            account_id: &candidate.credentials.account_id,
            account_count: metadata.account_count,
            account_ids: &metadata.account_ids,
            access_token_expires_at_ms: expiry_display_ms(
                candidate.credentials.access_token.expose(),
            ),
            // This is the exact persisted producer projection, not a fabricated
            // native response clock or a claimed earlier validated-auth timestamp.
            updated_at_ms: metadata.updated_at_ms,
            upstream_status,
            upstream_content_type: normalized
                .then_some(candidate.content_type.as_deref())
                .flatten(),
            models: &metadata.models,
            catalog_seeded,
            normalized_snapshot_updated: normalized,
        })?;
        let publication_revision = self.publication_revision().to_owned();
        let native_receipt_ref = self.native_receipt_ref().to_owned();
        let completion = match self.disposition() {
            gateway_authority::native_control::import::NativeImportPublicationDisposition::Applied => NativeImportCompletion::Published { publication_revision, native_receipt_ref },
            gateway_authority::native_control::import::NativeImportPublicationDisposition::AlreadyCurrent => NativeImportCompletion::AlreadyCurrent { publication_revision, native_receipt_ref },
        };
        Ok(NativeImportResult {
            status: 200,
            headers: BTreeMap::from([("x-uos-upstream".into(), "chatgpt_codex".into())]),
            body,
            completion,
        })
    }
}
