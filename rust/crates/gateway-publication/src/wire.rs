use crate::{
    access_publication::PreparedAccessPublication,
    control_publication::PreparedConfigurationPublication,
};
use gateway_auth::{
    GatewayError,
    native_credentials::{NativeCredentials, parse_native_document},
};
use gateway_authority::paid_control::{PAID_CONTROL_CONFIG_VERSION, PaidControlConfig};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Constructed from a prepared fixed publication, never deserialized as an
/// authority capability. Debug and generic secret-bearing serialization omitted.
pub struct PreparedPublicationCommand(pub(crate) WireCommand);

/// Nonsecret expected revisions supplied by the separately reviewed current
/// state adoption or a prior authenticated receipt. No authority read endpoint
/// or second native ledger is created to obtain them.
pub struct ExpectedAccessPublication {
    pub native_owner_id: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: Option<String>,
    pub account_id_hash: String,
    pub user_id: String,
    pub publication_revision: String,
}
impl PreparedPublicationCommand {
    pub fn configuration_from_expected(
        config: PaidControlConfig,
        owner_revision: String,
        previous_config_revision: Option<String>,
        publication_revision: String,
    ) -> Result<Self, GatewayError> {
        let command = WireCommand::ConfigPublish(ConfigWire {
            v: 1,
            config,
            owner_revision,
            previous_config_revision,
            publication_revision,
        });
        WireCommand::parse(&command.bytes()?)?;
        Ok(Self(command))
    }
    pub fn access_from_registered(
        expected: ExpectedAccessPublication,
        observed: &NativeCredentials,
    ) -> Result<Self, GatewayError> {
        if observed.external_user_id.as_deref() != Some(&expected.user_id)
            || observed.routing_account_hash() != expected.account_id_hash
            || !observed.refresh_token.expose().is_empty()
        {
            return Err(invalid());
        }
        let command = WireCommand::AccessPublish(AccessWire {
            v: 1,
            native_owner_id: expected.native_owner_id,
            owner_revision: expected.owner_revision,
            source_revision: expected.source_revision,
            normalized_revision: expected.normalized_revision,
            publication_revision: expected.publication_revision,
            account_id_hash: observed.routing_account_hash(),
            credential_version: observed.routing_credential_version(),
            native_generation: observed.generation_hash(),
            document: AccessDocument::from_native(observed)?,
        });
        WireCommand::parse(&command.bytes()?)?;
        Ok(Self(command))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub(crate) enum WireCommand {
    ConfigPublish(ConfigWire),
    AccessPublish(AccessWire),
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConfigWire {
    pub v: u8,
    pub config: PaidControlConfig,
    pub owner_revision: String,
    pub previous_config_revision: Option<String>,
    pub publication_revision: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AccessWire {
    pub v: u8,
    pub native_owner_id: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: Option<String>,
    pub publication_revision: String,
    pub account_id_hash: String,
    pub credential_version: String,
    pub native_generation: String,
    pub document: AccessDocument,
}
/// Access material is confined to the authenticated private transport and the
/// existing raw credential row. This type intentionally has no Debug impl.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AccessDocument {
    account_id: String,
    access_token: String,
    user_id: String,
    native_refreshed_at: Option<String>,
}
impl AccessDocument {
    pub(crate) fn from_native(value: &NativeCredentials) -> Result<Self, GatewayError> {
        Ok(Self {
            account_id: value.account_id.clone(),
            access_token: value.access_token.expose().into(),
            user_id: value.external_user_id.clone().ok_or_else(invalid)?,
            native_refreshed_at: value.native_refreshed_at.clone(),
        })
    }
    pub(crate) fn native(&self) -> Result<NativeCredentials, GatewayError> {
        let raw = json!({"auth_mode":"chatgptAuthTokens","OPENAI_API_KEY":null,"tokens":{"access_token":self.access_token,"id_token":self.access_token,"refresh_token":"","account_id":self.account_id},"last_refresh":self.native_refreshed_at});
        let parsed = parse_native_document(&raw)?;
        if parsed.external_user_id.as_deref() != Some(&self.user_id) {
            return Err(invalid());
        }
        Ok(parsed)
    }
}
impl WireCommand {
    pub(crate) fn bytes(&self) -> Result<Vec<u8>, GatewayError> {
        serde_json::to_vec(self).map_err(|_| invalid())
    }
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, GatewayError> {
        let raw: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        let command: Self = serde_json::from_value(raw.clone()).map_err(|_| invalid())?;
        if serde_json::to_value(&command).map_err(|_| invalid())? != raw {
            return Err(invalid());
        }
        let (version, revision) = match &command {
            Self::ConfigPublish(w) => {
                if w.config.v != PAID_CONTROL_CONFIG_VERSION {
                    return Err(invalid());
                }
                (w.v, &w.publication_revision)
            }
            Self::AccessPublish(w) => (w.v, &w.publication_revision),
        };
        if version != 1 || !valid_revision(revision) {
            return Err(invalid());
        }
        Ok(command)
    }
}
pub(crate) fn valid_revision(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

impl PreparedConfigurationPublication {
    pub fn command(
        &self,
        publication_revision: &str,
    ) -> Result<PreparedPublicationCommand, GatewayError> {
        if !valid_revision(publication_revision) {
            return Err(invalid());
        }
        Ok(PreparedPublicationCommand(WireCommand::ConfigPublish(
            ConfigWire {
                v: 1,
                config: self.config.clone(),
                owner_revision: self.checks[0]
                    .expected_revision
                    .clone()
                    .ok_or_else(invalid)?,
                previous_config_revision: self.checks[1].expected_revision.clone(),
                publication_revision: publication_revision.into(),
            },
        )))
    }
}
impl PreparedAccessPublication {
    pub fn command(&self) -> Result<PreparedPublicationCommand, GatewayError> {
        Ok(PreparedPublicationCommand(WireCommand::AccessPublish(
            AccessWire {
                v: 1,
                native_owner_id: self.native_owner_id.clone(),
                owner_revision: self.checks[0]
                    .expected_revision
                    .clone()
                    .ok_or_else(invalid)?,
                source_revision: self.checks[1]
                    .expected_revision
                    .clone()
                    .ok_or_else(invalid)?,
                normalized_revision: self.checks[2].expected_revision.clone(),
                publication_revision: self.publication_revision.clone(),
                account_id_hash: self.observed.routing_account_hash(),
                credential_version: self.observed.routing_credential_version(),
                native_generation: self.observed.generation_hash(),
                document: AccessDocument::from_native(&self.observed)?,
            },
        )))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicationDisposition {
    Applied,
    AlreadyCurrent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationReceipt {
    pub v: u8,
    pub operation: String,
    pub disposition: PublicationDisposition,
    pub owner_id: String,
    pub owner_epoch: String,
    pub owner_revision: String,
    pub publication_revision: String,
    pub configuration_revision: Option<String>,
    pub configuration_generation: Option<String>,
    pub configuration_fingerprint: Option<String>,
    pub source_revision: Option<String>,
    pub normalized_revision: Option<String>,
    pub pool_versionstamp: Option<String>,
    pub native_owner_id: Option<String>,
    pub account_id_hash: Option<String>,
    pub credential_version: Option<String>,
    pub native_generation: Option<String>,
}
impl PublicationReceipt {
    pub(crate) fn matches(&self, command: &WireCommand) -> bool {
        if self.v != 1
            || self.owner_id.is_empty()
            || self.owner_epoch.is_empty()
            || !valid_revision(&self.owner_revision)
        {
            return false;
        }
        match command {
            WireCommand::ConfigPublish(w) => {
                self.operation == "config_publish"
                    && self.publication_revision == w.publication_revision
                    && self.owner_id == w.config.owner_id
                    && self.owner_epoch == w.config.owner_epoch
                    && self.configuration_generation.as_ref() == Some(&w.config.generation)
                    && self.configuration_fingerprint.as_ref()
                        == Some(&w.config.configuration_fingerprint)
                    && self
                        .configuration_revision
                        .as_ref()
                        .is_some_and(|r| valid_revision(r))
            }
            WireCommand::AccessPublish(w) => {
                self.operation == "access_publish"
                    && self.publication_revision == w.publication_revision
                    && self.native_owner_id.as_ref() == Some(&w.native_owner_id)
                    && self.account_id_hash.as_ref() == Some(&w.account_id_hash)
                    && self.credential_version.as_ref() == Some(&w.credential_version)
                    && self.native_generation.as_ref() == Some(&w.native_generation)
                    && self
                        .source_revision
                        .as_ref()
                        .is_some_and(|r| valid_revision(r))
                    && self.pool_versionstamp == self.source_revision
                    && self
                        .normalized_revision
                        .as_ref()
                        .is_some_and(|r| valid_revision(r))
            }
        }
    }
}
pub(crate) fn invalid() -> GatewayError {
    GatewayError::new(
        400,
        "Invalid fixed native publication payload",
        Some("native_publication_invalid"),
    )
}
