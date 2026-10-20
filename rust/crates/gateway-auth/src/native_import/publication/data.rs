//! Closed retained terminal DATA; decoding never reconstructs an import capability.
use super::{hash, required_nullable, text, unavailable, valid_client_version};
use gateway_core::GatewayError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ImportCatalogDisposition {
    Normalized {
        client_version: String,
        upstream_status: u16,
    },
    AuthenticatedLimited {
        upstream_status: u16,
    },
}
impl ImportCatalogDisposition {
    pub fn validate(&self) -> Result<(), GatewayError> {
        match self {
            Self::Normalized {
                client_version,
                upstream_status,
            } if valid_client_version(client_version) && (200..300).contains(upstream_status) => {
                Ok(())
            }
            Self::AuthenticatedLimited {
                upstream_status: 429,
            } => Ok(()),
            _ => Err(unavailable()),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportPublicationDataV1 {
    pub v: u8,
    pub operation_id: String,
    pub claim_ref: String,
    pub publication_revision: String,
    pub native_receipt_ref: String,
    pub native_source_generation: String,
    pub access_generation: String,
    pub credential_version: String,
    pub source_revision: String,
    pub normalized_revision: String,
    #[serde(deserialize_with = "required_nullable")]
    pub catalog_revision: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub runtime_revision: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub auth_generation_revision: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub paid_control_config_revision: Option<String>,
    pub publication_request_digest: String,
    pub catalog_disposition: ImportCatalogDisposition,
}
impl ImportPublicationDataV1 {
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.v != 1 {
            return Err(unavailable());
        }
        self.catalog_disposition.validate()?;
        for value in [
            &self.native_source_generation,
            &self.access_generation,
            &self.credential_version,
            &self.publication_request_digest,
        ] {
            hash(value)?;
        }
        for value in [
            &self.operation_id,
            &self.claim_ref,
            &self.publication_revision,
            &self.native_receipt_ref,
            &self.source_revision,
            &self.normalized_revision,
        ]
        .into_iter()
        .chain(self.catalog_revision.iter())
        .chain(self.runtime_revision.iter())
        .chain(self.auth_generation_revision.iter())
        .chain(self.paid_control_config_revision.iter())
        {
            text(value)?;
        }
        Ok(())
    }
}
