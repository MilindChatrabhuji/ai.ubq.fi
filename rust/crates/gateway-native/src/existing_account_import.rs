//! Native-private import custody. Independent native writer exclusion is not yet available.
//! The production mutation boundary fails closed; a recovered durability receipt is not publication.
use gateway_auth::crypto::sha256_hex;
use gateway_authority::native_control::import::{
    AuthenticatedNativeImport, NativeImportBinding, NativeImportClaim,
};
use gateway_core::GatewayError;
use std::{fs::File, path::Path};
#[path = "import_durability.rs"]
mod durability;
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
    pub fn reconcile(
        &self,
        claim: &NativeImportClaim,
        proof: &AuthenticatedNativeImport,
        original_body: &[u8],
        now_ms: i64,
    ) -> Result<DurableNativeImport, GatewayError> {
        self.require_binding(claim.binding())?;
        if proof.metadata().action_ref != claim.binding().action_ref
            || proof.metadata().operation_id != claim.binding().operation_id
        {
            return Err(unavailable());
        }
        proof.require_body(original_body, now_ms)?;
        durability::reconcile(self, claim.binding(), &sha256_hex(original_body))
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
    pub fn recheck_receipt(&self, receipt: &DurableNativeImport) -> Result<(), GatewayError> {
        self.require_binding(receipt.binding())?;
        durability::recheck(self, receipt)
    }
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Native import durability is absent, changed, or mismatched.",
        "native_import_durability_unavailable",
    )
}
