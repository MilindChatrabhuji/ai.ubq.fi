//! Finite sanitized publication DATA. Actual native authentication/current action
//! and the opaque fixed commit plan are separate mandatory authorization steps.
use super::{ImportCatalogDisposition, required_nullable, unavailable};
use gateway_core::{GatewayError, source_json::SourceJson};
use serde::{Deserialize, Serialize};
use serde_json::json;

const ACCESS_MAX_BYTES: usize = 65_536;
const SNAPSHOT_MAX_BYTES: usize = 60_000;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportAccessDocument {
    pub account_id: String,
    pub access_token: String,
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

/// DATA-only safe normalization for the fixed native publication component.
/// Actual current-cache merge/default/config planning remains authority-owned.
pub fn prepare_import_catalog(
    snapshot: &SourceJson,
    client_version: &str,
    upstream_status: u16,
    observed_at_ms: i64,
) -> Result<ImportCatalogData, GatewayError> {
    ImportCatalogDisposition::Normalized {
        client_version: client_version.into(),
        upstream_status,
    }
    .validate()?;
    crate::validate_time(observed_at_ms)?;
    let snapshot = gateway_schema::snapshot::normalize_snapshot(
        snapshot,
        &gateway_schema::snapshot::SnapshotOverrides {
            source: Some("chatgpt_codex".into()),
            client_version: Some(client_version.into()),
            updated_at_ms: Some(observed_at_ms),
        },
        observed_at_ms,
    )
    .ok_or_else(unavailable)?;
    let snapshot =
        gateway_core::source_serialization::canonical(&SourceJson::from_serializable(&snapshot)?)?;
    if snapshot.as_str().len() > SNAPSHOT_MAX_BYTES {
        return Err(GatewayError::new(
            413,
            format!(
                "models snapshot too large ({} bytes; max 65536).",
                snapshot.as_str().len()
            ),
            Some("invalid_request_error"),
        ));
    }
    Ok(ImportCatalogData::Normalized {
        snapshot,
        client_version: client_version.into(),
        upstream_status,
    })
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
        for text in [
            &self.native_owner_id,
            &self.owner_revision,
            &self.source_revision,
            &self.normalized_revision,
        ] {
            crate::text(text)?;
        }
        for hash in [
            &self.action_ref,
            &self.account_id_hash,
            &self.previous_native_source_generation,
            &self.native_source_generation,
            &self.access_generation,
        ] {
            super::super::custody::hash(hash)?;
        }
        if self.document.account_id.trim().is_empty()
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

#[cfg(test)]
mod tests {
    use super::*;
    fn command() -> ImportPublicationCommandData {
        ImportPublicationCommandData {
            operation: "codex_auth_import_publish".into(),
            v: 1,
            action_ref: "a".repeat(64),
            operation_id: "operation".into(),
            claim_ref: "claim".into(),
            native_owner_id: "owner".into(),
            owner_revision: "owner-r1".into(),
            source_revision: "source-r1".into(),
            normalized_revision: "pool-r1".into(),
            publication_revision: "publication-r1".into(),
            account_id_hash: "b".repeat(64),
            previous_native_source_generation: "c".repeat(64),
            native_source_generation: "d".repeat(64),
            access_generation: "e".repeat(64),
            native_receipt_ref: "receipt-r1".into(),
            document: ImportAccessDocument {
                account_id: "account".into(),
                access_token: "SYNTHETIC".into(),
                native_refreshed_at: None,
            },
            catalog: ImportCatalogData::Normalized {
                snapshot: SourceJson::parse(r#"{"models":[{"slug":"model"}]}"#).unwrap(),
                client_version: "0.163.0".into(),
                upstream_status: 200,
            },
        }
    }
    #[test]
    fn pure_safe_catalog_helper_retains_source_utf16_without_native_dependency() {
        let raw = SourceJson::parse(r#"{"models":[{"slug":"\ud800"}]}"#).unwrap();
        let catalog = prepare_import_catalog(&raw, "0.163.0", 200, 1_000_000).unwrap();
        let ImportCatalogData::Normalized { snapshot, .. } = &catalog else {
            panic!("normalized")
        };
        assert!(snapshot.as_str().contains("\\ud800"));
        let mut row = command();
        row.catalog = catalog;
        ImportPublicationCommandData::parse(&row.bytes().unwrap()).unwrap();
    }
    #[test]
    fn exact_frame_and_component_boundaries_preserve_existing_thresholds() {
        let mut row = command();
        let initial = serde_json::to_vec(&row.document).unwrap().len();
        row.document
            .access_token
            .push_str(&"x".repeat(ACCESS_MAX_BYTES - initial));
        assert_eq!(
            serde_json::to_vec(&row.document).unwrap().len(),
            ACCESS_MAX_BYTES
        );
        let mut bytes = row.bytes().unwrap();
        bytes.resize(import_publication_max_bytes(), b' ');
        ImportPublicationCommandData::parse(&bytes).unwrap();
        bytes.push(b' ');
        assert!(ImportPublicationCommandData::parse(&bytes).is_err());
        row.document.access_token.push('x');
        assert!(row.bytes().is_err());
        assert!(import_publication_max_bytes() < gateway_auth::native::NATIVE_MAX_BODY_BYTES);
    }
    #[test]
    fn duplicated_version_and_escaped_authority_text_fit_computed_envelope() {
        let mut row = command();
        let maximum = "\u{1}".repeat(4096);
        row.native_owner_id = maximum.clone();
        row.owner_revision = maximum.clone();
        row.source_revision = maximum.clone();
        row.normalized_revision = maximum;
        let version = format!("{}.1.0", "0".repeat(30_000));
        let snapshot = SourceJson::from_serializable(
            &json!({"models":[{"slug":"model"}],"client_version":version}),
        )
        .unwrap();
        assert!(snapshot.as_str().len() <= SNAPSHOT_MAX_BYTES);
        row.catalog = ImportCatalogData::Normalized {
            snapshot,
            client_version: version,
            upstream_status: 200,
        };
        assert!(serde_json::to_vec(&row.catalog).unwrap().len() > SNAPSHOT_MAX_BYTES);
        let bytes = row.bytes().unwrap();
        assert!(bytes.len() < import_publication_max_bytes());
        let parsed = ImportPublicationCommandData::parse(&bytes).unwrap();
        assert_eq!(parsed.owner_revision.len(), 4096);
        row.owner_revision.push('x');
        assert!(row.bytes().is_err());
    }
    #[test]
    fn closed_status_nullability_and_secret_free_metadata_refuse_forgery() {
        let row = command();
        let bytes = row.bytes().unwrap();
        for field in [
            "refresh_token",
            "body_digest",
            "configuration_fingerprint",
            "mutations",
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            value[field] = json!("forbidden");
            assert!(
                ImportPublicationCommandData::parse(&serde_json::to_vec(&value).unwrap()).is_err()
            );
        }
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["document"]
            .as_object_mut()
            .unwrap()
            .remove("native_refreshed_at");
        assert!(ImportPublicationCommandData::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut limited = command();
        limited.catalog = ImportCatalogData::AuthenticatedLimited {
            upstream_status: 429,
        };
        limited.bytes().unwrap();
        limited.catalog = ImportCatalogData::AuthenticatedLimited {
            upstream_status: 200,
        };
        assert!(limited.bytes().is_err());
    }
}
