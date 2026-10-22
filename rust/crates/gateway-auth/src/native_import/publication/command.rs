//! Finite sanitized publication DATA. Actual native authentication/current action
//! and the opaque fixed commit plan are separate mandatory authorization steps.
use super::{ImportCatalogDisposition, hash, required_nullable, text, unavailable};
use gateway_core::{GatewayError, source_json::SourceJson};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const ACCESS_MAX_BYTES: usize = 65_536;
pub const SNAPSHOT_MAX_BYTES: usize = 60_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportAccessDocument {
    pub account_id: String,
    pub access_token: String,
    pub updated_at_ms: f64,
    #[serde(deserialize_with = "required_nullable")]
    pub native_refreshed_at: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ImportCatalogData {
    Normalized {
        snapshot: SourceJson,
        client_version: String,
        upstream_status: u16,
    },
    AuthenticatedLimited {
        upstream_status: u16,
    },
}
// Internally tagged Deserialize buffers fields and cannot retain RawValue.
// Decode this finite variant directly from the original SourceJson tree instead.
impl<'de> Deserialize<'de> for ImportCatalogData {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Normalized {
            kind: String,
            snapshot: SourceJson,
            client_version: String,
            upstream_status: u16,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Limited {
            kind: String,
            upstream_status: u16,
        }
        let raw = <SourceJson as Deserialize>::deserialize(deserializer)?;
        let kind = gateway_core::source_serialization::member(&raw, "kind")
            .and_then(|value| value.deserialize::<String>().ok())
            .ok_or_else(|| serde::de::Error::custom("Missing import catalog kind"))?;
        match kind.as_str() {
            "normalized" => {
                let value: Normalized = raw
                    .deserialize()
                    .map_err(|_| serde::de::Error::custom("Invalid normalized import catalog"))?;
                if value.kind != kind {
                    return Err(serde::de::Error::custom("Import catalog kind mismatch"));
                }
                Ok(Self::Normalized {
                    snapshot: value.snapshot,
                    client_version: value.client_version,
                    upstream_status: value.upstream_status,
                })
            }
            "authenticated_limited" => {
                let value: Limited = raw
                    .deserialize()
                    .map_err(|_| serde::de::Error::custom("Invalid limited import catalog"))?;
                if value.kind != kind {
                    return Err(serde::de::Error::custom("Import catalog kind mismatch"));
                }
                Ok(Self::AuthenticatedLimited {
                    upstream_status: value.upstream_status,
                })
            }
            _ => Err(serde::de::Error::custom("Unsupported import catalog kind")),
        }
    }
}

impl ImportCatalogData {
    pub fn disposition(&self) -> ImportCatalogDisposition {
        match self {
            Self::Normalized {
                client_version,
                upstream_status,
                ..
            } => ImportCatalogDisposition::Normalized {
                client_version: client_version.clone(),
                upstream_status: *upstream_status,
            },
            Self::AuthenticatedLimited { upstream_status } => {
                ImportCatalogDisposition::AuthenticatedLimited {
                    upstream_status: *upstream_status,
                }
            }
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportPublicationCommandData {
    pub operation: String,
    pub v: u8,
    pub action_ref: String,
    pub operation_id: String,
    pub claim_ref: String,
    pub native_owner_id: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
    pub publication_revision: String,
    pub account_id_hash: String,
    pub previous_native_source_generation: String,
    pub native_source_generation: String,
    pub access_generation: String,
    pub native_receipt_ref: String,
    pub document: ImportAccessDocument,
    pub catalog: ImportCatalogData,
}
fn reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}
/// The exact metadata fields, existing UTF8 authority domain and serializer derive
/// this upper bound; no guessed envelope cap or unrelated limit is changed.
pub fn import_publication_max_bytes() -> usize {
    let text = "\u{1}".repeat(4096);
    let reference = "r".repeat(256);
    let hash = "a".repeat(64);
    let envelope = json!({
        "operation":"codex_auth_import_publish", "v":1,
        "action_ref":reference, "operation_id":reference, "claim_ref":reference,
        "native_owner_id":text, "owner_revision":text, "source_revision":text,
        "normalized_revision":text, "publication_revision":reference,
        "account_id_hash":hash, "previous_native_source_generation":hash,
        "native_source_generation":hash, "access_generation":hash,
        "native_receipt_ref":reference, "document":null,
        "catalog":{"kind":"normalized","snapshot":null,"client_version":null,"upstream_status":299}
    });
    serde_json::to_vec(&envelope)
        .expect("Finite fixed import metadata")
        .len()
        + SNAPSHOT_MAX_BYTES
        + ACCESS_MAX_BYTES
        + SNAPSHOT_MAX_BYTES
}
impl ImportPublicationCommandData {
    pub fn parse(body: &[u8]) -> Result<Self, GatewayError> {
        if body.len() > import_publication_max_bytes() {
            return Err(unavailable());
        }
        let row: Self = serde_json::from_slice(body).map_err(|_| unavailable())?;
        row.validate()?;
        Ok(row)
    }
    pub fn bytes(&self) -> Result<Vec<u8>, GatewayError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| unavailable())?;
        if bytes.len() > import_publication_max_bytes() {
            return Err(unavailable());
        }
        Ok(bytes)
    }
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.v != 1
            || self.operation != "codex_auth_import_publish"
            || [
                &self.action_ref,
                &self.operation_id,
                &self.claim_ref,
                &self.publication_revision,
                &self.native_receipt_ref,
            ]
            .iter()
            .any(|s| !reference(s))
        {
            return Err(unavailable());
        }
        for value in [
            &self.native_owner_id,
            &self.owner_revision,
            &self.source_revision,
            &self.normalized_revision,
        ] {
            text(value)?;
        }
        for value in [
            &self.action_ref,
            &self.account_id_hash,
            &self.previous_native_source_generation,
            &self.native_source_generation,
            &self.access_generation,
        ] {
            hash(value)?;
        }
        if !self.document.updated_at_ms.is_finite()
            || self.document.account_id.trim().is_empty()
            || self.document.access_token.trim().is_empty()
            || serde_json::to_vec(&self.document)
                .map_err(|_| unavailable())?
                .len()
                > ACCESS_MAX_BYTES
        {
            return Err(unavailable());
        }
        if let ImportCatalogData::Normalized {
            snapshot,
            client_version,
            ..
        } = &self.catalog
        {
            // The version appears in the bounded normalized snapshot AND once
            // separately on this wire. Count both, never cap their sum at 60K.
            if snapshot.as_str().len() > SNAPSHOT_MAX_BYTES
                || serde_json::to_vec(client_version)
                    .map_err(|_| unavailable())?
                    .len()
                    > SNAPSHOT_MAX_BYTES
            {
                return Err(unavailable());
            }
        }
        self.catalog.disposition().validate()
    }
}
