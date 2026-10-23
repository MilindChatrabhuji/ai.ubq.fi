//! Fixed native-only receiver and authenticated source-data boundary.
//! No socket, refresh, provider effect or publication implementation.
#[doc(hidden)]
pub mod import_body;
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
impl<'a> NativeImportContext<'a> {
    pub(crate) fn original_proof(&self) -> &'a AuthenticatedNativeImport {
        self.proof
    }
    pub(crate) fn original_body(&self) -> &[u8] {
        self.auth.body.raw_body()
    }
    pub(crate) fn deadline(&self) -> std::time::Instant {
        let now = std::time::Instant::now();
        let remaining = self
            .original
            .now_ms()
            .ok()
            .and_then(|ms| self.proof.deadline_ms().checked_sub(ms))
            .and_then(|ms| u64::try_from(ms).ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or_default();
        self.original
            .deadline()
            .min(now.checked_add(remaining).unwrap_or(now))
    }
    pub(crate) fn now_ms(&self) -> Result<i64, GatewayError> {
        self.original.now_ms()
    }
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
    let context = decode_context(proof, metadata, body, original)?;
    handler.import_document(proof, metadata, body, &context)
}
/// Both fixed local/remote receivers reach this one original-body decoder only
/// after their actual authority admission and finish-current exchange.
pub(crate) fn decode_context<'a>(
    proof: &'a AuthenticatedNativeImport,
    metadata: &NativeImportMetadata,
    body: &'a [u8],
    original: &'a NativeControlContext<'a>,
) -> Result<NativeImportContext<'a>, GatewayError> {
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
    Ok(context)
}

#[cfg(all(test, unix))]
mod tests;
