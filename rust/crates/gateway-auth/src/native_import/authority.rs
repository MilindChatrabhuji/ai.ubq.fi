//! Closed import-authority DATA only. Private body/start/currentness proofs live
//! above this crate and cannot be reconstructed by deserializing these frames.
use super::{NativeImportMetadata, NativeImportTarget};
use crate::{
    GatewayError,
    native_control::{NATIVE_CONTROL_ERROR_MAX_BYTES, NATIVE_RENEWAL_MAX_MS},
};
use gateway_core::identity::MAX_SAFE_INTEGER;
use serde::{Deserialize, Serialize};

pub const IMPORT_AUTHORITY_OPERATION: &str = "codex_auth_import_authority";
pub const IMPORT_STARTED_OPERATION: &str = "codex_auth_import_started";
fn invalid() -> GatewayError {
    GatewayError::new(
        400,
        "Invalid fixed native import authority frame",
        Some("native_import_authority_wire_invalid"),
    )
}
fn nullable<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
fn text(value: &str) -> Result<(), GatewayError> {
    if !value.trim().is_empty() && value.len() <= 4096 {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn reference(value: &str) -> Result<(), GatewayError> {
    if super::reference(value) {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn hash(value: &str) -> Result<(), GatewayError> {
    if super::digest(value) {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn time(value: i64) -> Result<(), GatewayError> {
    if (0..=MAX_SAFE_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn encoded<T: Serialize>(value: &T) -> usize {
    serde_json::to_vec(value)
        .expect("Finite fixed import DATA")
        .len()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportAuthorityStateData {
    pub action_version: u8,
    pub metadata: NativeImportMetadata,
    pub target: NativeImportTarget,
    pub action_revision: String,
    pub native_owner_id: String,
    pub account_id_hash: String,
    pub source_native_generation: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
    pub created_at_ms: i64,
    pub deadline_ms: i64,
}
impl ImportAuthorityStateData {
    pub fn validate(&self) -> Result<(), GatewayError> {
        self.metadata.validate()?;
        self.target.validate()?;
        if !matches!(self.action_version, 2 | 3)
            || self.created_at_ms.checked_add(NATIVE_RENEWAL_MAX_MS) != Some(self.deadline_ms)
            || !matches!(&self.target, NativeImportTarget::ExistingAccount { account_id_hash } if account_id_hash == &self.account_id_hash)
        {
            return Err(invalid());
        }
        for value in [
            &self.metadata.action_ref,
            &self.account_id_hash,
            &self.source_native_generation,
        ] {
            hash(value)?;
        }
        for value in [
            &self.action_revision,
            &self.native_owner_id,
            &self.owner_revision,
            &self.source_revision,
            &self.normalized_revision,
        ] {
            text(value)?;
        }
        time(self.created_at_ms)?;
        time(self.deadline_ms)
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportAuthorityClaimMode {
    ImportOnce,
    ReconcileOnly,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case", deny_unknown_fields)]
pub enum ImportAuthorityCommand {
    CustodyTerminal {
        started: ImportCustodyStartedWire,
        publication_revision: String,
    },
    Admit {
        metadata: NativeImportMetadata,
    },
    FinishCurrent {
        state: ImportAuthorityStateData,
    },
    Claim {
        state: ImportAuthorityStateData,
    },
    Start {
        state: ImportAuthorityStateData,
        claim_ref: String,
        start_permit: String,
    },
    Current {
        state: ImportAuthorityStateData,
        #[serde(deserialize_with = "nullable")]
        claim_ref: Option<String>,
    },
    Unknown {
        state: ImportAuthorityStateData,
        claim_ref: String,
    },
    Terminal {
        state: ImportAuthorityStateData,
        claim_ref: String,
        publication_revision: String,
        native_receipt_ref: String,
        publication_request_digest: String,
    },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportAuthorityRequestData {
    pub operation: String,
    pub v: u8,
    pub command: ImportAuthorityCommand,
}
impl ImportAuthorityRequestData {
    pub fn new(command: ImportAuthorityCommand) -> Result<Self, GatewayError> {
        let value = Self {
            operation: IMPORT_AUTHORITY_OPERATION.into(),
            v: 1,
            command,
        };
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.operation != IMPORT_AUTHORITY_OPERATION || self.v != 1 {
            return Err(invalid());
        }
        match &self.command {
            ImportAuthorityCommand::CustodyTerminal {
                started,
                publication_revision,
            } => {
                started.validate()?;
                reference(publication_revision)?;
            }
            ImportAuthorityCommand::Admit { metadata } => {
                metadata.validate()?;
                hash(&metadata.action_ref)?;
            }
            ImportAuthorityCommand::FinishCurrent { state }
            | ImportAuthorityCommand::Claim { state } => state.validate()?,
            ImportAuthorityCommand::Start {
                state,
                claim_ref,
                start_permit,
            } => {
                state.validate()?;
                reference(claim_ref)?;
                text(start_permit)?;
            }
            ImportAuthorityCommand::Current { state, claim_ref } => {
                state.validate()?;
                if let Some(value) = claim_ref {
                    reference(value)?;
                }
            }
            ImportAuthorityCommand::Unknown { state, claim_ref } => {
                state.validate()?;
                reference(claim_ref)?;
            }
            ImportAuthorityCommand::Terminal {
                state,
                claim_ref,
                publication_revision,
                native_receipt_ref,
                publication_request_digest,
            } => {
                state.validate()?;
                reference(claim_ref)?;
                reference(publication_revision)?;
                reference(native_receipt_ref)?;
                hash(publication_request_digest)?;
            }
        }
        Ok(())
    }
    pub fn bytes(&self) -> Result<Vec<u8>, GatewayError> {
        self.validate()?;
        serde_json::to_vec(self).map_err(|_| invalid())
    }
    pub fn parse(body: &[u8]) -> Result<Self, GatewayError> {
        if body.len() > import_authority_request_max_bytes() {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(body).map_err(|_| invalid())?;
        value.validate()?;
        if value.bytes()? != body {
            return Err(invalid());
        }
        Ok(value)
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportAuthorityTerminalData {
    pub publication_revision: String,
    pub native_receipt_ref: String,
    pub publication_request_digest: String,
    pub native_source_generation: String,
    pub access_generation: String,
    pub credential_version: String,
    pub source_revision: String,
    pub normalized_revision: String,
    #[serde(deserialize_with = "nullable")]
    pub catalog_revision: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub runtime_revision: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub auth_generation_revision: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub paid_control_config_revision: Option<String>,
}
impl ImportAuthorityTerminalData {
    fn validate(&self) -> Result<(), GatewayError> {
        reference(&self.publication_revision)?;
        reference(&self.native_receipt_ref)?;
        for value in [
            &self.publication_request_digest,
            &self.native_source_generation,
            &self.access_generation,
            &self.credential_version,
        ] {
            hash(value)?;
        }
        for value in [&self.source_revision, &self.normalized_revision]
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
#[path = "authority_completion.rs"]
mod completion;
pub use completion::{ImportCompletionData, ImportCompletionModelsData};
#[path = "authority_result.rs"]
mod result;
pub use result::{ImportAuthorityReplyData, ImportAuthorityResult};

/// Exact existing B1 canonical12-field DATA. This duplicate wire shape selects
/// authentication bounds only; it never constructs the authority's private proof.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCustodyStartedWire {
    pub v: u8,
    pub operation_id: String,
    pub action_ref: String,
    pub claim_ref: String,
    pub native_owner_id: String,
    pub account_id_hash: String,
    pub source_native_generation: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
    pub started_revision: String,
    pub deadline_ms: i64,
}
impl ImportCustodyStartedWire {
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.v != 1 {
            return Err(invalid());
        }
        for value in [&self.operation_id, &self.claim_ref] {
            reference(value)?;
        }
        for value in [
            &self.action_ref,
            &self.account_id_hash,
            &self.source_native_generation,
        ] {
            hash(value)?;
        }
        for value in [
            &self.native_owner_id,
            &self.owner_revision,
            &self.source_revision,
            &self.normalized_revision,
            &self.started_revision,
        ] {
            text(value)?;
        }
        time(self.deadline_ms)
    }
    pub fn bytes(&self) -> Result<Vec<u8>, GatewayError> {
        self.validate()?;
        serde_json::to_vec(self).map_err(|_| invalid())
    }
    pub fn parse(body: &[u8]) -> Result<Self, GatewayError> {
        if body.len() > import_custody_request_max_bytes() {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(body).map_err(|_| invalid())?;
        value.validate()?;
        if value.bytes()? != body {
            return Err(invalid());
        }
        Ok(value)
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCustodyStartedReplyData {
    pub operation: String,
    pub v: u8,
    pub request: ImportCustodyStartedWire,
    pub verified_at_ms: i64,
}
impl ImportCustodyStartedReplyData {
    pub fn parse_for(
        body: &[u8],
        request: &ImportCustodyStartedWire,
    ) -> Result<Self, GatewayError> {
        if body.len() > import_custody_reply_max_bytes() {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(body).map_err(|_| invalid())?;
        time(value.verified_at_ms)?;
        if value.v != 1
            || value.operation != IMPORT_STARTED_OPERATION
            || &value.request != request
            || value.verified_at_ms >= request.deadline_ms
            || serde_json::to_vec(&value).map_err(|_| invalid())? != body
        {
            return Err(invalid());
        }
        Ok(value)
    }
}
fn max_state() -> ImportAuthorityStateData {
    let long = "\u{1}".repeat(4096);
    let hash = "a".repeat(64);
    ImportAuthorityStateData {
        action_version: 3,
        metadata: NativeImportMetadata {
            v: 1,
            operation_id: "r".repeat(256),
            action_ref: hash.clone(),
        },
        target: NativeImportTarget::ExistingAccount {
            account_id_hash: hash.clone(),
        },
        action_revision: long.clone(),
        native_owner_id: long.clone(),
        account_id_hash: hash.clone(),
        source_native_generation: hash,
        owner_revision: long.clone(),
        source_revision: long.clone(),
        normalized_revision: long,
        created_at_ms: MAX_SAFE_INTEGER - NATIVE_RENEWAL_MAX_MS,
        deadline_ms: MAX_SAFE_INTEGER,
    }
}
fn max_terminal() -> ImportAuthorityTerminalData {
    let long = Some("\u{1}".repeat(4096));
    let hash = "a".repeat(64);
    let reference = "r".repeat(256);
    ImportAuthorityTerminalData {
        publication_revision: reference.clone(),
        native_receipt_ref: reference,
        publication_request_digest: hash.clone(),
        native_source_generation: hash.clone(),
        access_generation: hash.clone(),
        credential_version: hash,
        source_revision: long.clone().expect("max text"),
        normalized_revision: long.clone().expect("max text"),
        catalog_revision: long.clone(),
        runtime_revision: long.clone(),
        auth_generation_revision: long.clone(),
        paid_control_config_revision: long,
    }
}
fn max_custody() -> ImportCustodyStartedWire {
    let state = max_state();
    ImportCustodyStartedWire {
        v: 1,
        operation_id: state.metadata.operation_id,
        action_ref: state.metadata.action_ref,
        claim_ref: "r".repeat(256),
        native_owner_id: state.native_owner_id,
        account_id_hash: state.account_id_hash,
        source_native_generation: state.source_native_generation,
        owner_revision: state.owner_revision,
        source_revision: state.source_revision,
        normalized_revision: state.normalized_revision,
        started_revision: "\u{1}".repeat(4096),
        deadline_ms: MAX_SAFE_INTEGER,
    }
}
pub fn import_authority_request_max_bytes() -> usize {
    let s = max_state();
    let r = "r".repeat(256);
    let commands = [
        ImportAuthorityCommand::CustodyTerminal {
            started: max_custody(),
            publication_revision: r.clone(),
        },
        ImportAuthorityCommand::Admit {
            metadata: s.metadata.clone(),
        },
        ImportAuthorityCommand::FinishCurrent { state: s.clone() },
        ImportAuthorityCommand::Claim { state: s.clone() },
        ImportAuthorityCommand::Start {
            state: s.clone(),
            claim_ref: r.clone(),
            start_permit: "\u{1}".repeat(4096),
        },
        ImportAuthorityCommand::Current {
            state: s.clone(),
            claim_ref: Some(r.clone()),
        },
        ImportAuthorityCommand::Unknown {
            state: s.clone(),
            claim_ref: r.clone(),
        },
        ImportAuthorityCommand::Terminal {
            state: s,
            claim_ref: r.clone(),
            publication_revision: r.clone(),
            native_receipt_ref: r,
            publication_request_digest: "a".repeat(64),
        },
    ];
    commands
        .into_iter()
        .map(|command| {
            encoded(&ImportAuthorityRequestData {
                operation: IMPORT_AUTHORITY_OPERATION.into(),
                v: 1,
                command,
            })
        })
        .max()
        .expect("finite phases")
}
pub fn import_authority_reply_max_bytes() -> usize {
    let s = max_state();
    let r = "r".repeat(256);
    let results = [
        ImportAuthorityResult::CustodyTerminal {
            started: max_custody(),
            publication_revision: r.clone(),
            terminal: Box::new({
                let mut terminal = max_terminal();
                terminal.source_revision = r.clone();
                terminal.normalized_revision = r.clone();
                terminal
            }),
        },
        ImportAuthorityResult::Admit { state: s.clone() },
        ImportAuthorityResult::FinishCurrent { state: s.clone() },
        ImportAuthorityResult::Claim {
            state: s.clone(),
            claim_ref: r.clone(),
            mode: ImportAuthorityClaimMode::ImportOnce,
            start_permit: Some("\u{1}".repeat(4096)),
        },
        ImportAuthorityResult::Start {
            state: s.clone(),
            claim_ref: r.clone(),
            started_revision: Some("\u{1}".repeat(4096)),
        },
        ImportAuthorityResult::Current {
            state: s.clone(),
            claim_ref: Some(r.clone()),
            catalog_revision: Some("\u{1}".repeat(4096)),
        },
        ImportAuthorityResult::Unknown {
            state: s.clone(),
            claim_ref: r,
        },
    ];
    results
        .into_iter()
        .map(|result| encoded(&ImportAuthorityReplyData::new(result)))
        .max()
        .expect("finite phases")
        .max(original_terminal_reply_max_bytes())
}
fn original_terminal_reply_max_bytes() -> usize {
    #[derive(Serialize)]
    struct LegacyTerminal {
        phase: &'static str,
        state: ImportAuthorityStateData,
        terminal: ImportAuthorityTerminalData,
    }
    let mut state = max_state();
    state.action_revision = "r".repeat(256);
    let value = serde_json::json!({"operation":IMPORT_AUTHORITY_OPERATION,"v":1,"result":LegacyTerminal {phase:"terminal",state,terminal:max_terminal()}});
    encoded(&value)
}
pub fn import_authority_reply_max_bytes_for(
    request: &ImportAuthorityRequestData,
) -> Result<usize, GatewayError> {
    request.validate()?;
    Ok(
        if matches!(request.command, ImportAuthorityCommand::Terminal { .. }) {
            import_authority_reply_max_bytes()
                + ",\"completion\":".len()
                + completion::completion_envelope_max_bytes()
        } else {
            import_authority_reply_max_bytes()
        },
    )
}
pub fn import_custody_request_max_bytes() -> usize {
    encoded(&max_custody())
}
pub fn import_custody_reply_max_bytes() -> usize {
    encoded(&ImportCustodyStartedReplyData {
        operation: IMPORT_STARTED_OPERATION.into(),
        v: 1,
        request: max_custody(),
        verified_at_ms: MAX_SAFE_INTEGER - 1,
    })
}
/// None preserves the old operation's original cap. A marker is used only to
/// refuse malformed new input; larger selection requires the COMPLETE typed body.
pub(crate) fn new_request_limit(body: &[u8]) -> Result<Option<usize>, GatewayError> {
    if let Some(limit) = super::catalog_seed::request_limit(body)? {
        return Ok(Some(limit));
    }
    let value: serde_json::Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if value.get("operation").and_then(|v| v.as_str()) == Some(IMPORT_AUTHORITY_OPERATION) {
        ImportAuthorityRequestData::parse(body)?;
        return Ok(Some(import_authority_request_max_bytes()));
    }
    if value.get("started_revision").is_some() {
        ImportCustodyStartedWire::parse(body)?;
        return Ok(Some(import_custody_request_max_bytes()));
    }
    Ok(None)
}
pub(crate) fn new_response_limit(
    request: &[u8],
    status: u16,
    response: &[u8],
) -> Result<Option<usize>, GatewayError> {
    if super::catalog_seed::request_limit(request)?.is_some() {
        if status >= 400 {
            return Ok(Some(NATIVE_CONTROL_ERROR_MAX_BYTES));
        }
        if status != 200 {
            return Err(invalid());
        }
        super::catalog_seed::ImportCatalogSeedReplyData::parse(response)?;
        return Ok(Some(
            super::catalog_seed::import_catalog_seed_reply_max_bytes(),
        ));
    }
    if new_request_limit(request)?.is_none() {
        return Ok(None);
    }
    if status >= 400 {
        return Ok(Some(NATIVE_CONTROL_ERROR_MAX_BYTES));
    }
    if status != 200 {
        return Err(invalid());
    }
    if let Ok(request) = ImportAuthorityRequestData::parse(request) {
        ImportAuthorityReplyData::parse_for(response, &request)?;
        return Ok(Some(import_authority_reply_max_bytes_for(&request)?));
    }
    let request = ImportCustodyStartedWire::parse(request)?;
    ImportCustodyStartedReplyData::parse_for(response, &request)?;
    Ok(Some(import_custody_reply_max_bytes()))
}

#[cfg(test)]
#[path = "authority_tests.rs"]
mod tests;
