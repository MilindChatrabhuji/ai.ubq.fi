//! Same-host import preparation and signed request construction only.
//! No sockets, document readers, Worker relay, refresh, response or completion.
use gateway_auth::{
    AuthConfig,
    crypto::sha256_hex,
    native::*,
    native_auth::NativeTransportIdentity,
    native_import::{
        NATIVE_IMPORT_ACTION_HEADER, NATIVE_IMPORT_BODY_HEADER, NATIVE_IMPORT_OPERATION_HEADER,
        NativeImportMetadata, NativeImportTarget,
    },
};
use gateway_authority::{
    Authority, TokenSource,
    native_control::{
        NativeRenewalAuthority, NativeRenewalCancellation, RegisteredRenewalOwner,
        actor::NativeRenewalActor, import::PreparedNativeImport,
    },
};
use gateway_core::{GatewayError, state::AuthorityStore};
use std::{collections::BTreeMap, net::SocketAddr, sync::Arc};

/// Local construction/preparation errors, not an HTTP/provider status policy.
#[derive(Debug)]
pub enum ClientError {
    InvalidEndpoint,
    Cancelled,
    Expired,
    ForeignPrepared,
    Native(GatewayError),
}

/// Explicit trusted constructor configuration, with no endpoint/identity default.
pub struct NativeImportClient<'a, S, I, C> {
    control: NativeRenewalAuthority<'a, S, I, C>,
    identity: &'a NativeTransportIdentity,
    cancellation: &'a C,
    endpoint: SocketAddr,
    marker: Arc<()>,
}
impl<'a, S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeImportClient<'a, S, I, C>
{
    pub fn configured(
        endpoint: SocketAddr,
        authority: &'a Authority<S, I>,
        identity: &'a NativeTransportIdentity,
        owner: &'a RegisteredRenewalOwner,
        config: &'a AuthConfig,
        cancellation: &'a C,
    ) -> Result<Self, ClientError> {
        if !endpoint.ip().is_loopback() || endpoint.port() == 0 {
            return Err(ClientError::InvalidEndpoint);
        }
        Ok(Self {
            control: NativeRenewalAuthority::configured(
                authority,
                identity,
                owner,
                config,
                cancellation,
            ),
            identity,
            cancellation,
            endpoint,
            marker: Arc::new(()),
        })
    }
    /// Only finite target data enters actual preparation; no document or digest.
    pub async fn prepare(
        &self,
        actor: &NativeRenewalActor,
        target: NativeImportTarget,
    ) -> Result<ClientPreparedImport, ClientError> {
        if self.cancellation.cancelled() {
            return Err(ClientError::Cancelled);
        }
        let prepared = self
            .control
            .prepare_import(actor, target)
            .await
            .map_err(ClientError::Native)?;
        if self.cancellation.cancelled() {
            return Err(ClientError::Cancelled);
        }
        Ok(ClientPreparedImport {
            prepared,
            marker: Arc::clone(&self.marker),
        })
    }
    /// Consumes this client's actual prepared object; there is no retry/send API.
    pub fn request<'b>(
        &self,
        prepared: ClientPreparedImport,
        original_body: &'b [u8],
        now_ms: i64,
        nonce: &str,
    ) -> Result<NativeUploadRequest<'b>, ClientError> {
        if !Arc::ptr_eq(&self.marker, &prepared.marker) {
            return Err(ClientError::ForeignPrepared);
        }
        if self.cancellation.cancelled() {
            return Err(ClientError::Cancelled);
        }
        if now_ms >= prepared.prepared.deadline_ms() {
            return Err(ClientError::Expired);
        }
        let metadata = prepared.prepared.metadata();
        let kind = prepared.prepared.target().kind();
        let body_sha256 = sha256_hex(original_body);
        let mac = self
            .identity
            .sign_import(kind, metadata, &body_sha256, now_ms, nonce)
            .map_err(ClientError::Native)?;
        let headers = BTreeMap::from([
            (
                NATIVE_VERSION_HEADER.into(),
                NATIVE_WIRE_VERSION.to_string(),
            ),
            (NATIVE_KEY_HEADER.into(), self.identity.key_id().into()),
            (NATIVE_TIME_HEADER.into(), now_ms.to_string()),
            (NATIVE_NONCE_HEADER.into(), nonce.into()),
            (NATIVE_MAC_HEADER.into(), mac),
            (
                NATIVE_IMPORT_OPERATION_HEADER.into(),
                metadata.operation_id.clone(),
            ),
            (
                NATIVE_IMPORT_ACTION_HEADER.into(),
                metadata.action_ref.clone(),
            ),
            (NATIVE_IMPORT_BODY_HEADER.into(), body_sha256),
        ]);
        if self.cancellation.cancelled() {
            return Err(ClientError::Cancelled);
        }
        Ok(NativeUploadRequest {
            prepared,
            endpoint: self.endpoint,
            headers,
            body: original_body,
        })
    }
}

/// No public constructor, Deserialize, Clone, Debug or Serialize. The original
/// actual authority-prepared object remains inside this client's private handle.
pub struct ClientPreparedImport {
    prepared: PreparedNativeImport,
    marker: Arc<()>,
}
impl ClientPreparedImport {
    pub fn metadata(&self) -> &NativeImportMetadata {
        self.prepared.metadata()
    }
    pub fn target(&self) -> &NativeImportTarget {
        self.prepared.target()
    }
    pub fn deadline_ms(&self) -> i64 {
        self.prepared.deadline_ms()
    }
}

/// Native-only sensitive request DATA, not dispatch permission or a receipt.
/// Deliberately no Debug, Serialize, Clone, response parser or completion method.
pub struct NativeUploadRequest<'a> {
    prepared: ClientPreparedImport,
    endpoint: SocketAddr,
    headers: BTreeMap<String, String>,
    body: &'a [u8],
}
impl NativeUploadRequest<'_> {
    pub fn endpoint(&self) -> SocketAddr {
        self.endpoint
    }
    pub fn method(&self) -> &'static str {
        "POST"
    }
    pub fn path(&self) -> &'static str {
        self.prepared.target().kind().path()
    }
    pub fn metadata(&self) -> &NativeImportMetadata {
        self.prepared.metadata()
    }
    pub fn headers(&self) -> &BTreeMap<String, String> {
        &self.headers
    }
    pub fn body(&self) -> &[u8] {
        self.body
    }
}
