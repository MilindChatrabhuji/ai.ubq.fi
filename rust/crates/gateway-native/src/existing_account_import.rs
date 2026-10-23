//! Native-private import custody. Independent native writer exclusion is not yet available.
//! The production mutation boundary fails closed; a recovered durability receipt is not publication.
use gateway_auth::crypto::sha256_hex;
use gateway_authority::{
    TokenSource,
    native_control::{
        NativeRenewalAuthority, NativeRenewalCancellation,
        import::{AuthenticatedNativeImport, NativeImportBinding, NativeImportClaim},
    },
};
use gateway_core::{GatewayError, state::AuthorityStore};
use std::{fs::File, path::Path};
mod acl_inspector;
mod actor_channel;
mod completion;
mod custodian_runtime;
mod custodian_service;
mod durability;
mod exclusive_owner;
mod import_documents;
mod import_endpoints;
pub(crate) mod import_process;
mod import_publication;
mod live_custody;
mod owner_runtime;
mod prepare_flow;
mod validation;
pub use custodian_runtime::CustodianRuntime;
pub use exclusive_owner::ExclusiveManagedOwner;
pub use live_custody::LiveImportCustody;
pub use owner_runtime::{ExclusiveOwnerLease, OwnedRuntime};
/// Fixed helper-only entry; it accepts no path, command, environment or arbitrary descriptor selector.
pub fn owner_inspector_entry() -> Result<(), GatewayError> {
    acl_inspector::entry()
}

pub use durability::DurableNativeImport;

/// Explicit registry construction, never an uploaded home or environment default.
pub struct ExistingAccountImportStore {
    directory: File,
    home: std::path::PathBuf,
    native_owner_id: String,
    account_id_hash: String,
}
impl ExistingAccountImportStore {
    pub fn configured(
        registered: &gateway_authority::native_control::RegisteredRenewalOwner,
        account_id_hash: String,
    ) -> Result<Self, GatewayError> {
        let native_owner_id = registered.native_owner_id().to_owned();
        let home = Path::new(registered.registered_home());
        if native_owner_id.is_empty()
            || !gateway_auth::provider_credentials::valid_native_generation(&account_id_hash)
        {
            return Err(unavailable());
        }
        Ok(Self {
            directory: durability::open_home(home)?,
            home: home.into(),
            native_owner_id,
            account_id_hash,
        })
    }
    /// Verify trusted bootstrap DATA against actual kernel custody; this does not grant mutation.
    pub fn prepare_exclusive_owner(
        &self,
        registered: &gateway_authority::native_control::RegisteredRenewalOwner,
        writer_uid: u32,
        native_client_uids: &[u32],
        inspector: &Path,
        inspector_sha256: &str,
        deadline: std::time::Instant,
    ) -> Result<ExclusiveManagedOwner, GatewayError> {
        exclusive_owner::ExclusiveManagedOwner::prepare(
            self,
            registered,
            writer_uid,
            native_client_uids,
            inspector,
            inspector_sha256,
            deadline,
        )
    }
    /// CF's generation marker does not exclude the independent native daemon.
    /// No advisory lock or caller assertion is accepted as that missing ownership proof.
    pub fn require_mutation_owner(&self) -> Result<(), GatewayError> {
        Err(GatewayError::unavailable(
            "Native import cannot replace credentials without proven exclusive native writer ownership.",
            "native_import_owner_exclusion_unavailable",
        ))
    }
    fn require_binding(&self, binding: &NativeImportBinding) -> Result<(), GatewayError> {
        if binding.native_owner_id != self.native_owner_id
            || binding.account_id_hash != self.account_id_hash
        {
            return Err(unavailable());
        }
        Ok(())
    }
    /// Read-only restart reconciliation. It never writes, refreshes, starts, or marks Published.
    /// A caller-created NativeGeneration or receipt JSON cannot enter this API as proof.
    pub async fn reconcile<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>(
        &self,
        authority: &NativeRenewalAuthority<'_, S, I, C>,
        claim: &NativeImportClaim,
        proof: &AuthenticatedNativeImport,
        original_body: &[u8],
    ) -> Result<DurableNativeImport, GatewayError> {
        self.require_binding(claim.binding())?;
        if proof.metadata().action_ref != claim.binding().action_ref
            || proof.metadata().operation_id != claim.binding().operation_id
        {
            return Err(unavailable());
        }
        authority.recheck_import(proof).await?;
        authority.recheck_import_claim(claim).await?;
        proof.require_body(original_body, authority.now_ms()?)?;
        let receipt = durability::reconcile(self, claim.binding(), &sha256_hex(original_body))?;
        authority.recheck_import_claim(claim).await?;
        authority.recheck_import(proof).await?;
        proof.require_body(original_body, authority.now_ms()?)?;
        durability::recheck(self, &receipt)?;
        Ok(receipt)
    }
    #[cfg(test)]
    pub(super) fn issue_fixture(
        &self,
        start: gateway_authority::native_control::import::NativeImportStart<'_>,
        proof: &AuthenticatedNativeImport,
        original_body: &[u8],
        context: &crate::native_import::NativeImportContext<'_>,
        now_ms: i64,
    ) -> Result<DurableNativeImport, GatewayError> {
        durability::issue_fixture(self, start, proof, original_body, context, now_ms)
    }
    /// A recovered proof still requires an exact current native reread before publication.
    pub async fn recheck_receipt<
        S: AuthorityStore,
        I: TokenSource,
        C: NativeRenewalCancellation,
    >(
        &self,
        authority: &NativeRenewalAuthority<'_, S, I, C>,
        claim: &NativeImportClaim,
        proof: &AuthenticatedNativeImport,
        original_body: &[u8],
        receipt: &DurableNativeImport,
    ) -> Result<(), GatewayError> {
        self.require_binding(receipt.binding())?;
        let current = self
            .reconcile(authority, claim, proof, original_body)
            .await?;
        if current.binding() != receipt.binding() || current.receipt_ref() != receipt.receipt_ref()
        {
            return Err(unavailable());
        }
        durability::recheck(self, receipt)
    }
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Native import durability is absent, changed, or mismatched.",
        "native_import_durability_unavailable",
    )
}

#[cfg(test)]
mod foundation_tests;

#[cfg(all(test, target_os = "macos", feature = "native-import-fixture"))]
mod flow_tests;
