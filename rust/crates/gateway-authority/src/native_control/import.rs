//! One actual admin/source-bound import preparation. No body/digest is persisted.
use super::{
    NativeRenewalAuthority, NativeRenewalCancellation, OWNER_RENEWAL_MAX_MS,
    actor::{self, NativeActorScope, NativeRenewalActor, StoredNativeActor},
    rows,
};
use crate::TokenSource;
use gateway_auth::native_import::{
    NativeImportAdmission, NativeImportKind, NativeImportMetadata, NativeImportTarget,
    VerifiedNativeImportBody,
};
use gateway_core::{GatewayError, state::AuthorityStore};
use serde::{Deserialize, Serialize};
mod action;
mod owner_selection;
use action::ImportActionRow;
pub(super) use owner_selection::read as owner_selection;
mod publication;
pub use publication::{
    NativeImportPublication, NativeImportPublicationDisposition, PreparedNativeImportPublication,
};
mod publication_current;
mod publication_source;
pub(in crate::native_control) use publication_current::VerifiedImportActorRevisions;
mod publication_data;
pub use publication_data::{ImportCatalogDisposition, ImportPublicationDataV1};
mod publication_wire;
pub use publication_wire::{
    ImportAccessDocument, ImportCatalogData, ImportPublicationCommandData,
    import_publication_max_bytes, prepare_import_catalog,
};
mod custody;
mod custody_session;
pub use custody_session::{ImportCustodyStartedRequest, VerifiedCurrentImportStarted};
mod effects;
mod remote_state;
mod sources;
use remote_state::ImportActionState;
mod catalog_seed;
#[cfg(all(unix, feature = "native-import-fixture"))]
mod fixture;
#[cfg(unix)]
mod remote;
mod remote_server;
#[cfg(unix)]
mod remote_tls;
pub use effects::{NativeImportBinding, NativeImportClaim, NativeImportMode, NativeImportStart};
#[cfg(unix)]
pub use remote::VerifiedCurrentImportTerminal;
#[cfg(unix)]
pub use remote::{
    AuthenticatedImportCatalogObservation, AuthenticatedImportTerminal, RemoteAdmittedImport,
    RemoteImportAuthority,
};
pub struct PreparedNativeImport {
    row: ImportActionRow,
}
impl PreparedNativeImport {
    pub fn metadata(&self) -> &NativeImportMetadata {
        &self.row.metadata
    }
    pub fn target(&self) -> &NativeImportTarget {
        &self.row.target
    }
    pub fn deadline_ms(&self) -> i64 {
        self.row.deadline_ms
    }
}
pub struct AdmittedNativeImport {
    admission: NativeImportAdmission,
    row: ImportActionRow,
}
/// An observed-current original action plus exact authenticated native document.
/// ```compile_fail
/// use gateway_authority::native_control::import::AuthenticatedNativeImport;
/// let forged:AuthenticatedNativeImport=serde_json::from_str("{}").unwrap();
/// ```
pub struct AuthenticatedNativeImport {
    body: VerifiedNativeImportBody,
    state: ImportActionState,
}
impl AuthenticatedNativeImport {
    pub fn metadata(&self) -> &NativeImportMetadata {
        self.state.metadata()
    }
    pub fn target(&self) -> &NativeImportTarget {
        self.state.target()
    }
    pub fn deadline_ms(&self) -> i64 {
        self.state.deadline_ms()
    }
    pub fn require_body(&self, body: &[u8], now: i64) -> Result<(), GatewayError> {
        if now >= self.deadline_ms() {
            return Err(unavailable());
        }
        self.body.require_body(body, now)
    }
}

impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'_, S, I, C>
{
    pub async fn prepare_import(
        &self,
        actor: &NativeRenewalActor,
        target: NativeImportTarget,
    ) -> Result<PreparedNativeImport, GatewayError> {
        self.prepare_import_version(actor, target, 3).await
    }
    /// Explicit historical v2 constructor for legacy effect/custody regressions.
    /// Production creates only new v3 rows and never rewrites historical rows.
    #[cfg(test)]
    pub(in crate::native_control) async fn prepare_import_legacy_v2_fixture(
        &self,
        actor: &NativeRenewalActor,
        target: NativeImportTarget,
    ) -> Result<PreparedNativeImport, GatewayError> {
        self.prepare_import_version(actor, target, 2).await
    }
    async fn prepare_import_version(
        &self,
        actor: &NativeRenewalActor,
        target: NativeImportTarget,
        version: u8,
    ) -> Result<PreparedNativeImport, GatewayError> {
        target.validate()?;
        if actor.scope() != NativeActorScope::Admin {
            return Err(unavailable());
        }
        for _ in 0..5 {
            let now = self.time(0)?;
            let mut tx = self.authority.transaction(now)?;
            let current = sources::read(self, &mut tx, actor.stored(), &target).await?;
            let reference = super::facts::digest(&(
                if version == 2 {
                    "uos-native-import-action-v2"
                } else {
                    "uos-native-import-action-v3"
                },
                actor.context(),
                actor.policy_digest(),
                &target,
                &current,
            ))?;
            let key = rows::key("action", &reference);
            let prior: Option<ImportActionRow> = tx.read_source_control(&key).await?;
            let row = if let Some(row) = prior {
                if row.v != version
                    || !row.unfinished()
                    || row.actor != *actor.stored()
                    || row.context != *actor.context()
                    || row.target != target
                    || row.facts != current
                {
                    return Err(unavailable());
                }
                row
            } else {
                let metadata = NativeImportMetadata {
                    v: 1,
                    operation_id: self.authority.tokens.next_token()?,
                    action_ref: reference.clone(),
                };
                metadata.validate()?;
                let row = ImportActionRow {
                    v: version,
                    publication: None,
                    kind: target.kind(),
                    metadata,
                    target: target.clone(),
                    actor: actor.stored().clone(),
                    context: actor.context().clone(),
                    created_at_ms: now,
                    deadline_ms: crate::add(now, OWNER_RENEWAL_MAX_MS)?,
                    facts: current,
                };
                tx.put_source_control(&key, &row, None)?;
                row
            };
            row.metadata.validate()?;
            if row.metadata.action_ref != reference
                || now < row.created_at_ms
                || row.deadline_ms != crate::add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
            {
                return Err(unavailable());
            }
            actor.bind_preparation(&mut tx).await?;
            tx.now = self.time(tx.now)?;
            actor::validate_current_time(&row.actor, tx.now)?;
            if tx.now >= row.deadline_ms {
                return Err(unavailable());
            }
            if tx.commit().await? {
                let now = self.time(now)?;
                actor::validate_current_time(&row.actor, now)?;
                if now >= row.deadline_ms {
                    return Err(unavailable());
                }
                return Ok(PreparedNativeImport { row });
            }
        }
        Err(unavailable())
    }
    async fn current_import(
        &self,
        metadata: &NativeImportMetadata,
        expected: Option<&ImportActionRow>,
    ) -> Result<ImportActionRow, GatewayError> {
        metadata.validate()?;
        for _ in 0..5 {
            let now = self.time(0)?;
            let mut tx = self.authority.transaction(now)?;
            let row: ImportActionRow = tx
                .read_source_control(&rows::key("action", &metadata.action_ref))
                .await?
                .ok_or_else(unavailable)?;
            if !row.unfinished()
                || row.kind != NativeImportKind::CodexAuth
                || row.kind != row.target.kind()
                || row.metadata != *metadata
                || now < row.created_at_ms
                || now >= row.deadline_ms
                || row.deadline_ms != crate::add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
                || expected.is_some_and(|old| {
                    old.created_at_ms != row.created_at_ms
                        || old.deadline_ms != row.deadline_ms
                        || old.metadata != row.metadata
                        || old.target != row.target
                        || old.context != row.context
                        || old.actor != row.actor
                        || old.facts != row.facts
                })
            {
                return Err(unavailable());
            }
            let current = sources::read(self, &mut tx, &row.actor, &row.target).await?;
            if current != row.facts {
                return Err(unavailable());
            }
            tx.now = self.time(tx.now)?;
            actor::validate_current_time(&row.actor, tx.now)?;
            if tx.now >= row.deadline_ms {
                return Err(unavailable());
            }
            if tx.commit().await? {
                let now = self.time(now)?;
                actor::validate_current_time(&row.actor, now)?;
                if now >= row.deadline_ms {
                    return Err(unavailable());
                }
                return Ok(row);
            }
        }
        Err(unavailable())
    }
    pub async fn admit_import(
        &self,
        admission: NativeImportAdmission,
    ) -> Result<AdmittedNativeImport, GatewayError> {
        admission.require_owner(self.identity, self.time(0)?)?;
        let row = self.current_import(admission.metadata(), None).await?;
        if admission.kind() != row.target.kind() {
            return Err(unavailable());
        }
        admission.require_owner(self.identity, self.time(0)?)?;
        Ok(AdmittedNativeImport { admission, row })
    }
    pub async fn finish_import(
        &self,
        admitted: AdmittedNativeImport,
        original_body: &[u8],
    ) -> Result<AuthenticatedNativeImport, GatewayError> {
        let body = admitted
            .admission
            .verify_body(original_body, self.time(0)?)?;
        let row = self
            .current_import(body.metadata(), Some(&admitted.row))
            .await?;
        body.require_owner(self.identity, self.time(0)?)?;
        body.require_body(original_body, self.time(0)?)?;
        Ok(AuthenticatedNativeImport {
            body,
            state: ImportActionState::Local(Box::new(row)),
        })
    }
    pub async fn recheck_import(
        &self,
        proof: &AuthenticatedNativeImport,
    ) -> Result<(), GatewayError> {
        proof.body.require_owner(self.identity, self.time(0)?)?;
        self.current_import(proof.metadata(), Some(proof.state.local()?))
            .await?;
        proof.body.require_owner(self.identity, self.time(0)?)
    }
}
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
pub(super) use custody::validate_custody;
