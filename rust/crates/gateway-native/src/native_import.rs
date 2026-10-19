//! Fixed native-only receiver interface. No socket, parser, refresh, or publication implementation.
use crate::owner_control::NativeControlContext;
pub use gateway_auth::native_import::{NativeImportKind, NativeImportMetadata, NativeImportTarget};
pub use gateway_authority::native_control::import::AuthenticatedNativeImport;
use gateway_authority::{
    TokenSource,
    native_control::{NativeRenewalAuthority, NativeRenewalCancellation},
};
use gateway_core::{GatewayError, source_json::SourceJson, state::AuthorityStore};
use std::collections::BTreeMap;

pub struct NativeImportContext<'a> {
    original: &'a NativeControlContext<'a>,
    proof: &'a AuthenticatedNativeImport,
}
impl NativeImportContext<'_> {
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
            return Err(GatewayError::new(
                403,
                "Native import context does not match the original proof",
                Some("native_capability_forbidden"),
            ));
        }
        proof.require_body(body, self.original.now_ms()?)
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
    let context = NativeImportContext { original, proof };
    context.check_document(proof, metadata, body)?;
    context.check_current(authority).await?;
    context.check_document(proof, metadata, body)?;
    handler.import_document(proof, metadata, body, &context)
}
