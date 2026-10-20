//! Optional catalog DATA only; a frame never creates import/store permission.
use super::{authority::ImportAuthorityStateData, publication::valid_client_version};
use crate::{GatewayError, native::NATIVE_MAX_BODY_BYTES};
use serde::{Deserialize, Serialize};

pub const IMPORT_CATALOG_SEED_OPERATION: &str = "codex_auth_import_catalog_seed";
fn invalid() -> GatewayError {
    GatewayError::new(
        400,
        "Invalid optional native catalog seed frame",
        Some("native_import_catalog_seed_invalid"),
    )
}
fn nullable<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCatalogSeedRequestData {
    pub operation: String,
    pub v: u8,
    pub state: ImportAuthorityStateData,
    pub claim_ref: String,
    pub publication_revision: String,
    pub native_receipt_ref: String,
    pub publication_request_digest: String,
    pub client_version: String,
    pub source_body: String,
    #[serde(deserialize_with = "nullable")]
    pub etag: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub content_type: Option<String>,
}
impl ImportCatalogSeedRequestData {
    pub fn validate(&self) -> Result<(), GatewayError> {
        self.state.validate()?;
        if self.operation != IMPORT_CATALOG_SEED_OPERATION
            || self.v != 1
            || !super::reference(&self.claim_ref)
            || !super::reference(&self.publication_revision)
            || !super::reference(&self.native_receipt_ref)
            || !super::digest(&self.publication_request_digest)
            || !valid_client_version(&self.client_version)
        {
            return Err(invalid());
        }
        Ok(())
    }
    /// No raw source-field cap: only the existing finite optional transport frame.
    pub fn bytes(&self) -> Result<Vec<u8>, GatewayError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| invalid())?;
        if bytes.len() > NATIVE_MAX_BODY_BYTES {
            return Err(invalid());
        }
        Ok(bytes)
    }
    pub fn parse(bytes: &[u8]) -> Result<Self, GatewayError> {
        if bytes.len() > NATIVE_MAX_BODY_BYTES {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if value.bytes()? != bytes {
            return Err(invalid());
        }
        Ok(value)
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCatalogSeedReplyData {
    pub operation: String,
    pub v: u8,
    pub seeded: bool,
}
impl ImportCatalogSeedReplyData {
    pub fn new(seeded: bool) -> Self {
        Self {
            operation: IMPORT_CATALOG_SEED_OPERATION.into(),
            v: 1,
            seeded,
        }
    }
    pub fn bytes(&self) -> Result<Vec<u8>, GatewayError> {
        if self.operation != IMPORT_CATALOG_SEED_OPERATION || self.v != 1 {
            return Err(invalid());
        }
        serde_json::to_vec(self).map_err(|_| invalid())
    }
    pub fn parse(bytes: &[u8]) -> Result<Self, GatewayError> {
        if bytes.len() > import_catalog_seed_reply_max_bytes() {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if value.bytes()? != bytes {
            return Err(invalid());
        }
        Ok(value)
    }
}
pub fn import_catalog_seed_reply_max_bytes() -> usize {
    // False is the longer of the exact two finite envelopes.
    ImportCatalogSeedReplyData::new(false)
        .bytes()
        .expect("finite seed reply")
        .len()
}
pub(crate) fn request_limit(bytes: &[u8]) -> Result<Option<usize>, GatewayError> {
    let marker: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if marker.get("operation").and_then(|v| v.as_str()) != Some(IMPORT_CATALOG_SEED_OPERATION) {
        return Ok(None);
    }
    ImportCatalogSeedRequestData::parse(bytes)?;
    Ok(Some(NATIVE_MAX_BODY_BYTES))
}
#[cfg(test)]
mod tests;
