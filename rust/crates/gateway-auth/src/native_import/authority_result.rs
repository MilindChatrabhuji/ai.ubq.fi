//! One field declaration generates serialization and direct per-variant decode.
//! No tagged Content/Value buffer can lose the completion's source UTF16.
use super::*;
use gateway_core::source_json::SourceJson;
macro_rules! results {
    ($( $variant:ident $phase:literal { $( $(#[$attr:meta])* $field:ident : $ty:ty, )* } ),* $(,)?) => {
        #[derive(Clone, Serialize)]
        #[serde(tag = "phase", rename_all = "snake_case", deny_unknown_fields)]
        pub enum ImportAuthorityResult { $( $variant { $( $(#[$attr])* $field: $ty, )* }, )* }
        impl<'de> Deserialize<'de> for ImportAuthorityResult {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer:D)->Result<Self,D::Error> {
                let raw=<SourceJson as Deserialize>::deserialize(deserializer)?;
                let phase=gateway_core::source_serialization::member(&raw,"phase").and_then(|v|v.deserialize::<String>().ok()).ok_or_else(||serde::de::Error::custom("Missing import reply phase"))?;
                match phase.as_str() {
                    $( $phase => {
                        #[derive(Deserialize)] #[serde(deny_unknown_fields)]
                        struct Wire { phase:String, $( $(#[$attr])* $field: $ty, )* }
                        let wire:Wire=raw.deserialize().map_err(|_|serde::de::Error::custom("Invalid closed import reply"))?;
                        if wire.phase!=$phase { return Err(serde::de::Error::custom("Import reply phase mismatch")); }
                        Ok(Self::$variant { $( $field:wire.$field, )* })
                    }, )*
                    _=>Err(serde::de::Error::custom("Unknown import reply phase")),
                }
            }
        }
    }
}
results! {
    CustodyTerminal "custody_terminal" { started:ImportCustodyStartedWire, publication_revision:String, terminal:Box<ImportAuthorityTerminalData>, },
    Admit "admit" { state:ImportAuthorityStateData, },
    FinishCurrent "finish_current" { state:ImportAuthorityStateData, },
    Claim "claim" { state:ImportAuthorityStateData, claim_ref:String, mode:ImportAuthorityClaimMode, #[serde(deserialize_with="nullable")] start_permit:Option<String>, },
    Start "start" { state:ImportAuthorityStateData, claim_ref:String, #[serde(deserialize_with="nullable")] started_revision:Option<String>, },
    Current "current" { state:ImportAuthorityStateData, #[serde(deserialize_with="nullable")] claim_ref:Option<String>, #[serde(deserialize_with="nullable")] catalog_revision:Option<String>, },
    Unknown "unknown" { state:ImportAuthorityStateData, claim_ref:String, },
    Terminal "terminal" { state:ImportAuthorityStateData, terminal:Box<ImportAuthorityTerminalData>, completion:ImportCompletionData, },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportAuthorityReplyData {
    pub operation: String,
    pub v: u8,
    pub result: ImportAuthorityResult,
}
impl ImportAuthorityReplyData {
    pub fn new(result: ImportAuthorityResult) -> Self {
        Self {
            operation: IMPORT_AUTHORITY_OPERATION.into(),
            v: 1,
            result,
        }
    }
    pub fn validate_for(&self, request: &ImportAuthorityRequestData) -> Result<(), GatewayError> {
        request.validate()?;
        if self.operation != IMPORT_AUTHORITY_OPERATION || self.v != 1 {
            return Err(invalid());
        }
        let valid = match (&request.command, &self.result) {
            (
                ImportAuthorityCommand::CustodyTerminal {
                    started: a,
                    publication_revision: x,
                },
                ImportAuthorityResult::CustodyTerminal {
                    started: b,
                    publication_revision: y,
                    terminal,
                },
            ) => {
                terminal.validate()?;
                a == b
                    && x == y
                    && &terminal.publication_revision == x
                    && &terminal.source_revision == x
                    && &terminal.normalized_revision == x
            }
            (
                ImportAuthorityCommand::Admit { metadata },
                ImportAuthorityResult::Admit { state },
            ) => {
                state.validate()?;
                &state.metadata == metadata
            }
            (
                ImportAuthorityCommand::FinishCurrent { state: a },
                ImportAuthorityResult::FinishCurrent { state: b },
            ) => a == b,
            (
                ImportAuthorityCommand::Claim { state: a },
                ImportAuthorityResult::Claim {
                    state: b,
                    claim_ref,
                    mode,
                    start_permit,
                },
            ) => {
                reference(claim_ref)?;
                if let Some(value) = start_permit {
                    text(value)?;
                }
                a == b && (*mode == ImportAuthorityClaimMode::ImportOnce) == start_permit.is_some()
            }
            (
                ImportAuthorityCommand::Start {
                    state: a,
                    claim_ref: x,
                    ..
                },
                ImportAuthorityResult::Start {
                    state: b,
                    claim_ref: y,
                    started_revision,
                },
            ) => {
                if let Some(value) = started_revision {
                    text(value)?;
                }
                a == b && x == y
            }
            (
                ImportAuthorityCommand::Current {
                    state: a,
                    claim_ref: x,
                },
                ImportAuthorityResult::Current {
                    state: b,
                    claim_ref: y,
                    catalog_revision,
                },
            ) => {
                if let Some(value) = catalog_revision {
                    text(value)?;
                }
                a == b && x == y
            }
            (
                ImportAuthorityCommand::Unknown {
                    state: a,
                    claim_ref: x,
                },
                ImportAuthorityResult::Unknown {
                    state: b,
                    claim_ref: y,
                },
            ) => a == b && x == y,
            (
                ImportAuthorityCommand::Terminal {
                    state: a,
                    publication_revision,
                    native_receipt_ref,
                    publication_request_digest,
                    ..
                },
                ImportAuthorityResult::Terminal {
                    state: b,
                    terminal,
                    completion,
                },
            ) => {
                b.validate()?;
                terminal.validate()?;
                completion.validate()?;
                let mut expected = a.clone();
                expected.action_revision = publication_revision.clone();
                expected == *b
                    && &terminal.publication_revision == publication_revision
                    && &terminal.native_receipt_ref == native_receipt_ref
                    && &terminal.publication_request_digest == publication_request_digest
            }
            _ => false,
        };
        if valid { Ok(()) } else { Err(invalid()) }
    }
    pub fn parse_for(
        body: &[u8],
        request: &ImportAuthorityRequestData,
    ) -> Result<Self, GatewayError> {
        if body.len() > import_authority_reply_max_bytes_for(request)? {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(body).map_err(|_| invalid())?;
        value.validate_for(request)?;
        if serde_json::to_vec(&value).map_err(|_| invalid())? != body {
            return Err(invalid());
        }
        Ok(value)
    }
}
