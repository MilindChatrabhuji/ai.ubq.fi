//! Exact shared import publication DATA and its operation-specific reply bound.
//! No body/start/currentness/durability capability is constructed in this crate.
use crate::{
    GatewayError,
    crypto::{Secret, sha256_hex},
    provider_credentials::codex_credential_identity,
};
use gateway_core::source_json::SourceJson;
use serde::{Deserialize, Serialize};
mod command;
pub use command::{
    ACCESS_MAX_BYTES, ImportAccessDocument, ImportCatalogData, ImportPublicationCommandData,
    SNAPSHOT_MAX_BYTES, import_publication_max_bytes,
};
mod data;
pub use data::{ImportCatalogDisposition, ImportPublicationDataV1};
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Native import preparation is unavailable, changed, expired, or unsupported.",
        "native_import_authority_unavailable",
    )
}
fn required_nullable<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
fn text(value: &str) -> Result<(), GatewayError> {
    if !value.trim().is_empty() && value.len() <= 4096 {
        Ok(())
    } else {
        Err(GatewayError::unavailable(
            "Missing or oversized authority identity.",
            "authority_state_invalid",
        ))
    }
}
fn hash(value: &str) -> Result<(), GatewayError> {
    if super::digest(value) {
        Ok(())
    } else {
        Err(GatewayError::unavailable(
            "Native renewal authority is missing, stale, or unavailable.",
            "native_renewal_authority_unavailable",
        ))
    }
}
// Exact existing schema parser's Number/trim domain, now co-located with this
// pure wire DTO. The schema-dependent normalizer remains in gateway-schema.
pub(super) fn valid_client_version(raw: &str) -> bool {
    let whitespace = |c: char| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}');
    let parts = raw.trim_matches(whitespace).split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && part
                    .parse::<u64>()
                    .ok()
                    .is_some_and(|n| n <= 9_007_199_254_740_991)
        })
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeImportPublicationDisposition {
    Applied,
    AlreadyCurrent,
}
/// Sanitized authoritative DATA, not native physical durability/completion proof.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeImportPublication {
    pub v: u8,
    pub operation_id: String,
    pub action_ref: String,
    pub disposition: NativeImportPublicationDisposition,
    pub publication: ImportPublicationDataV1,
}
impl NativeImportPublication {
    pub fn validate_for(
        &self,
        request: &ImportPublicationCommandData,
        actual_request_bytes: &[u8],
    ) -> Result<(), GatewayError> {
        request.validate()?;
        self.publication.validate()?;
        let p = &self.publication;
        let identity = codex_credential_identity(
            &request.document.account_id,
            &Secret::new(request.document.access_token.clone()),
            &Secret::new(String::new()),
        );
        if self.v != 1
            || self.operation_id != request.operation_id
            || self.action_ref != request.action_ref
            || p.operation_id != request.operation_id
            || p.claim_ref != request.claim_ref
            || p.publication_revision != request.publication_revision
            || p.native_receipt_ref != request.native_receipt_ref
            || p.native_source_generation != request.native_source_generation
            || p.access_generation != request.access_generation
            || p.credential_version != identity.credential_version.0
            || identity.routing_account_hash.0 != request.account_id_hash
            || identity.native_generation_hash != request.access_generation
            || p.source_revision != request.publication_revision
            || p.normalized_revision != request.publication_revision
            || p.publication_request_digest != sha256_hex(actual_request_bytes)
            || p.catalog_disposition != request.catalog.disposition()
        {
            return Err(unavailable());
        }
        if matches!(
            p.catalog_disposition,
            ImportCatalogDisposition::Normalized { .. }
        ) {
            if [
                &p.catalog_revision,
                &p.runtime_revision,
                &p.auth_generation_revision,
                &p.paid_control_config_revision,
            ]
            .into_iter()
            .any(|r| r.as_deref() != Some(request.publication_revision.as_str()))
            {
                return Err(unavailable());
            }
        } else if p.catalog_revision.is_none() {
            return Err(unavailable());
        }
        Ok(())
    }
    pub fn parse_for(body: &[u8], request_bytes: &[u8]) -> Result<Self, GatewayError> {
        if body.len() > import_publication_reply_max_bytes() {
            return Err(unavailable());
        }
        let request = ImportPublicationCommandData::parse(request_bytes)?;
        let response: Self = serde_json::from_slice(body).map_err(|_| unavailable())?;
        response.validate_for(&request, request_bytes)?;
        Ok(response)
    }
}
/// Derived from the two exact finite success shapes, not an enlarged old cap.
pub fn import_publication_reply_max_bytes() -> usize {
    let reference = "r".repeat(256);
    let long = "\u{1}".repeat(4096);
    let hash = "a".repeat(64);
    let maximal = |normalized: bool| NativeImportPublication {
        v: 1,
        operation_id: reference.clone(),
        action_ref: hash.clone(),
        disposition: NativeImportPublicationDisposition::AlreadyCurrent,
        publication: ImportPublicationDataV1 {
            v: 1,
            operation_id: reference.clone(),
            claim_ref: reference.clone(),
            publication_revision: reference.clone(),
            native_receipt_ref: reference.clone(),
            native_source_generation: hash.clone(),
            access_generation: hash.clone(),
            credential_version: hash.clone(),
            source_revision: reference.clone(),
            normalized_revision: reference.clone(),
            catalog_revision: Some(if normalized {
                reference.clone()
            } else {
                long.clone()
            }),
            runtime_revision: Some(if normalized {
                reference.clone()
            } else {
                long.clone()
            }),
            auth_generation_revision: Some(if normalized {
                reference.clone()
            } else {
                long.clone()
            }),
            paid_control_config_revision: Some(if normalized {
                reference.clone()
            } else {
                long.clone()
            }),
            publication_request_digest: hash.clone(),
            catalog_disposition: if normalized {
                ImportCatalogDisposition::Normalized {
                    client_version: "0".repeat(SNAPSHOT_MAX_BYTES - 6) + ".0.0",
                    upstream_status: 299,
                }
            } else {
                ImportCatalogDisposition::AuthenticatedLimited {
                    upstream_status: 429,
                }
            },
        },
    };
    [false, true]
        .into_iter()
        .map(|normalized| {
            serde_json::to_vec(&maximal(normalized))
                .expect("Finite fixed publication reply")
                .len()
        })
        .max()
        .expect("Two finite import reply branches")
}
/// Larger success responses qualify only through this exact new operation and
/// complete request/reply binding. Errors retain the old publication cap.
pub(crate) fn new_reply_limit(
    request: &[u8],
    status: u16,
    response: &[u8],
) -> Result<Option<usize>, GatewayError> {
    let source = match SourceJson::parse_bytes(request) {
        Ok(source) => source,
        Err(_) => return Ok(None),
    };
    let operation = gateway_core::source_serialization::member(&source, "operation")
        .and_then(|v| v.deserialize::<String>().ok());
    if operation.as_deref() != Some("codex_auth_import_publish") {
        return Ok(None);
    }
    ImportPublicationCommandData::parse(request)?;
    if status != 200 {
        return if status >= 400 {
            Ok(None)
        } else {
            Err(unavailable())
        };
    }
    NativeImportPublication::parse_for(response, request)?;
    Ok(Some(import_publication_reply_max_bytes()))
}

#[cfg(test)]
#[path = "publication/tests.rs"]
mod tests;
