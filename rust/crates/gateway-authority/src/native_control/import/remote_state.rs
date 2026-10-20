//! Private local/actual-remote state. DATA and a matching client are both required;
//! no fake local action or deserialized body/start capability exists.
use super::*;
use gateway_auth::native_import::authority::ImportAuthorityStateData;
#[cfg(unix)]
use std::sync::Arc;

pub(super) enum ImportActionState {
    Local(Box<ImportActionRow>),
    #[cfg(unix)]
    Remote(Box<RemoteImportState>),
}
#[cfg(unix)]
pub(super) struct RemoteImportState {
    pub state: ImportAuthorityStateData,
    pub client: Arc<()>,
}
impl ImportActionState {
    pub fn local(&self) -> Result<&ImportActionRow, GatewayError> {
        match self {
            Self::Local(row) => Ok(row),
            #[cfg(unix)]
            Self::Remote(_) => Err(unavailable()),
        }
    }
    pub fn metadata(&self) -> &NativeImportMetadata {
        match self {
            Self::Local(row) => &row.metadata,
            #[cfg(unix)]
            Self::Remote(remote) => &remote.state.metadata,
        }
    }
    pub fn target(&self) -> &NativeImportTarget {
        match self {
            Self::Local(row) => &row.target,
            #[cfg(unix)]
            Self::Remote(remote) => &remote.state.target,
        }
    }
    pub fn deadline_ms(&self) -> i64 {
        match self {
            Self::Local(row) => row.deadline_ms,
            #[cfg(unix)]
            Self::Remote(remote) => remote.state.deadline_ms,
        }
    }
}
pub(super) fn state_data(row: &ImportActionRow, revision: String) -> ImportAuthorityStateData {
    ImportAuthorityStateData {
        action_version: row.v,
        metadata: row.metadata.clone(),
        target: row.target.clone(),
        action_revision: revision,
        native_owner_id: row.facts.native_owner_id.clone(),
        account_id_hash: row.facts.account_id_hash.clone(),
        source_native_generation: row.facts.source_native_generation.clone(),
        owner_revision: row.facts.owner_revision.clone(),
        source_revision: row.facts.source_revision.clone(),
        normalized_revision: row.facts.normalized_revision.clone(),
        created_at_ms: row.created_at_ms,
        deadline_ms: row.deadline_ms,
    }
}
pub(super) fn phase_binding(
    state: &ImportAuthorityStateData,
    claim_ref: String,
) -> NativeImportBinding {
    NativeImportBinding {
        action_ref: state.metadata.action_ref.clone(),
        operation_id: state.metadata.operation_id.clone(),
        claim_ref,
        native_owner_id: state.native_owner_id.clone(),
        account_id_hash: state.account_id_hash.clone(),
        source_native_generation: state.source_native_generation.clone(),
        owner_revision: state.owner_revision.clone(),
        source_revision: state.source_revision.clone(),
        normalized_revision: state.normalized_revision.clone(),
    }
}
