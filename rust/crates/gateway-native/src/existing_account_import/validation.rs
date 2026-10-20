//! Fixed native import validation. Candidates are DATA, never mutation or publication authority.
use gateway_auth::native_credentials::NativeCredentials;
use gateway_core::source_json::SourceJson;

pub(super) enum CatalogValidation {
    Normalized { snapshot: SourceJson, client_version: String, upstream_status: u16 },
    AuthenticatedLimited,
}
// Only the fixed models/OAuth producer below may create this; callers cannot deserialize it.
pub(super) struct ValidatedNativeImport {
    pub(super) document: SourceJson,
    pub(super) credentials: NativeCredentials,
    pub(super) catalog: CatalogValidation,
    pub(super) refreshed: bool,
}
