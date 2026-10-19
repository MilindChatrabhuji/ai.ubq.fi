//! Fixed native-only receiver and authenticated source-data boundary.
//! No socket, refresh, provider effect or publication implementation.
#[path = "import_body.rs"]
pub(crate) mod import_body;
use crate::owner_control::NativeControlContext;
pub use gateway_auth::native_import::{NativeImportKind, NativeImportMetadata, NativeImportTarget};
pub use gateway_authority::native_control::import::AuthenticatedNativeImport;
use gateway_authority::{
    TokenSource,
    native_control::{NativeRenewalAuthority, NativeRenewalCancellation},
};
use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, state::AuthorityStore,
};
use std::collections::BTreeMap;

/// Read-only native credential DATA, not proof, effect authority or CF completion.
/// Constructed only by dispatch from the one original-body decoder after binding.
/// Deliberately no Clone/Debug/Serialize/Deserialize or public constructor.
pub struct NativeAuthImportData<'a> {
    body: import_body::AuthBody<'a>,
}
impl NativeAuthImportData<'_> {
    pub fn auth(&self) -> &SourceJson {
        self.body.auth()
    }
    pub fn client_version(&self) -> Option<&JsString16> {
        self.body.client_version()
    }
}

/// Source-faithful AUTH read/transport/decoder error mapping shared with ingress.
pub(crate) fn auth_body_error() -> GatewayError {
    let error = import_body::BodyError::AuthBody;
    GatewayError::new(error.status(), error.message(), Some(error.code()))
}
fn binding_error() -> GatewayError {
    GatewayError::new(
        403,
        "Native import context does not match the original proof",
        Some("native_capability_forbidden"),
    )
}
fn check_original_document(
    proof: &AuthenticatedNativeImport,
    metadata: &NativeImportMetadata,
    body: &[u8],
    original: &NativeControlContext<'_>,
) -> Result<(), GatewayError> {
    original.check()?;
    if proof.metadata() != metadata {
        return Err(binding_error());
    }
    proof.require_body(body, original.now_ms()?)
}

pub struct NativeImportContext<'a> {
    original: &'a NativeControlContext<'a>,
    proof: &'a AuthenticatedNativeImport,
    auth: NativeAuthImportData<'a>,
}
impl NativeImportContext<'_> {
    pub fn auth_data(&self) -> &NativeAuthImportData<'_> {
        &self.auth
    }
    pub fn check(&self) -> Result<(), GatewayError> {
        self.original.check()
    }
    pub fn check_document(
        &self,
        proof: &AuthenticatedNativeImport,
        metadata: &NativeImportMetadata,
        body: &[u8],
    ) -> Result<(), GatewayError> {
        self.check()?;
        if !std::ptr::eq(self.proof, proof) || proof.metadata() != metadata {
            return Err(binding_error());
        }
        check_original_document(proof, metadata, body, self.original)?;
        proof.require_body(self.auth.body.raw_body(), self.original.now_ms()?)
    }
    pub async fn check_current<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>(
        &self,
        authority: &NativeRenewalAuthority<'_, S, I, C>,
    ) -> Result<(), GatewayError> {
        self.check()?;
        authority.recheck_import(self.proof).await?;
        self.check()
    }
}
/// Native-only source result data, not a durable publication proof or CF completion grant.
pub struct NativeImportResult {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: SourceJson,
    pub completion: NativeImportCompletion,
}
pub enum NativeImportCompletion {
    Published {
        publication_revision: String,
        native_receipt_ref: String,
    },
    AlreadyCurrent {
        publication_revision: String,
        native_receipt_ref: String,
    },
    PendingUnknown,
    Conflict,
    Unavailable,
    Refused,
}
pub trait NativeImportHandler: Send + Sync {
    fn import_document(
        &self,
        proof: &AuthenticatedNativeImport,
        metadata: &NativeImportMetadata,
        original_body: &[u8],
        context: &NativeImportContext<'_>,
    ) -> Result<NativeImportResult, GatewayError>;
}
/// The only context-construction path binds the actual original cancellation and current proof.
pub async fn dispatch_import<
    S: AuthorityStore,
    I: TokenSource,
    C: NativeRenewalCancellation,
    H: NativeImportHandler,
>(
    handler: &H,
    authority: &NativeRenewalAuthority<'_, S, I, C>,
    proof: &AuthenticatedNativeImport,
    metadata: &NativeImportMetadata,
    body: &[u8],
    original: &NativeControlContext<'_>,
) -> Result<NativeImportResult, GatewayError> {
    check_original_document(proof, metadata, body, original)?;
    authority.recheck_import(proof).await?;
    check_original_document(proof, metadata, body, original)?;
    if proof.target().kind() != NativeImportKind::CodexAuth {
        return Err(GatewayError::unavailable(
            "Native profile import is unavailable",
            "native_import_unavailable",
        ));
    }
    let auth = NativeAuthImportData {
        body: import_body::decode_auth(body, None).map_err(|_| auth_body_error())?,
    };
    let context = NativeImportContext {
        original,
        proof,
        auth,
    };
    context.check_document(proof, metadata, body)?;
    handler.import_document(proof, metadata, body, &context)
}

#[cfg(all(test, unix))]
#[path = "../tests/cases/import_body_source_cases.rs"]
mod source_cases;
#[cfg(all(test, unix))]
#[path = "native_import_tests.rs"]
mod tests;
