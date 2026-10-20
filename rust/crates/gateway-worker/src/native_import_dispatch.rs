//! Exact existing import operations on the canonical Worker/carrier path.
use super::*;
use gateway_auth::{
    AuthConfig,
    native_auth::AuthenticatedNativeOwner,
    native_import::{
        authority::{
            IMPORT_AUTHORITY_OPERATION, ImportAuthorityCommand, ImportAuthorityRequestData,
            ImportCustodyStartedWire,
        },
        catalog_seed::{IMPORT_CATALOG_SEED_OPERATION, ImportCatalogSeedRequestData},
    },
};
use gateway_publication::transport::PublicationReceiver;

#[derive(serde::Deserialize)]
struct Marker {
    operation: Option<String>,
    started_revision: Option<String>,
}
enum ImportRequest {
    Authority(ImportAuthorityRequestData),
    Started(ImportCustodyStartedWire),
    Seed(ImportCatalogSeedRequestData),
}
impl ImportRequest {
    fn parse(bytes: &[u8]) -> Result<Option<Self>, GatewayError> {
        let marker: Marker = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        match marker.operation.as_deref() {
            Some(IMPORT_AUTHORITY_OPERATION) => Ok(Some(Self::Authority(
                ImportAuthorityRequestData::parse(bytes)?,
            ))),
            Some(IMPORT_CATALOG_SEED_OPERATION) => Ok(Some(Self::Seed(
                ImportCatalogSeedRequestData::parse(bytes)?,
            ))),
            _ if marker.started_revision.is_some() => {
                Ok(Some(Self::Started(ImportCustodyStartedWire::parse(bytes)?)))
            }
            _ => Ok(None),
        }
    }
    fn action(&self) -> &str {
        match self {
            Self::Started(value) => &value.action_ref,
            Self::Seed(value) => &value.state.metadata.action_ref,
            Self::Authority(value) => match &value.command {
                ImportAuthorityCommand::Admit { metadata } => &metadata.action_ref,
                ImportAuthorityCommand::CustodyTerminal { started, .. } => &started.action_ref,
                ImportAuthorityCommand::FinishCurrent { state }
                | ImportAuthorityCommand::Claim { state }
                | ImportAuthorityCommand::Start { state, .. }
                | ImportAuthorityCommand::Current { state, .. }
                | ImportAuthorityCommand::Unknown { state, .. }
                | ImportAuthorityCommand::Terminal { state, .. } => &state.metadata.action_ref,
            },
        }
    }
}
pub(super) async fn authority<C: NativeRenewalCancellation>(
    authority: &Authority<RemoteAuthorityStore, PlatformTokens>,
    proof: &AuthenticatedNativeOwner,
    native: &NativeBindings,
    config: &AuthConfig,
    cancellation: &C,
    wire: (&str, &[u8]),
) -> Result<Option<Response>, GatewayError> {
    let (nonce, bytes) = wire;
    let identity = &native.transport()?.identity;
    let Some(request) = ImportRequest::parse(bytes)? else {
        return Ok(None);
    };
    proof.require_request(
        NativeCapability::CodexAuthImport,
        NATIVE_RENEWAL_AUTHORITY_PATH,
        bytes,
        now_ms()?,
    )?;
    let owner = native
        .renewal_owners()?
        .for_import_action(authority, request.action())
        .await?;
    let receiver =
        NativeRenewalAuthority::configured(authority, identity, owner, config, cancellation);
    let output = match request {
        ImportRequest::Authority(_) => receiver.handle_import_authority(proof, bytes).await,
        ImportRequest::Started(_) => receiver.handle_import_started(proof, bytes).await,
        ImportRequest::Seed(_) => receiver.handle_import_catalog_seed(proof, bytes).await,
    };
    let (status, output) = match output {
        Ok(bytes) => (200, bytes),
        Err(error) => (error.status, body(&error.envelope)?),
    };
    let mac = identity.sign_authority_response(nonce, bytes, status, &output)?;
    Ok(Some(response(status, output, mac)?))
}
pub async fn publication(
    request: &Request,
    env: &Env,
    native: &NativeBindings,
    store: &RemoteAuthorityStore,
    receiver: Option<&PublicationReceiver>,
    bytes: &[u8],
) -> Result<Response, GatewayError> {
    if request.method() != Method::Post || request.path() != NATIVE_PUBLICATION_PATH {
        return Err(invalid());
    }
    let command =
        gateway_authority::native_control::import::ImportPublicationCommandData::parse(bytes)?;
    let transport = native.transport()?;
    let headers = Headers::read(request)?;
    let incoming = Incoming(Cancellation::from_request(request)?);
    let replay = StoreNonceAuthority::new(store);
    let peer = NativeAuthenticator::new(&transport.identity, &replay)
        .authenticate(
            NATIVE_PUBLICATION_PATH,
            headers.borrowed(),
            bytes,
            now_ms()?,
        )
        .await?;
    peer.require_request(
        NativeCapability::CodexAuthImport,
        NATIVE_PUBLICATION_PATH,
        bytes,
        now_ms()?,
    )?;
    let authority = Authority::with_clock(store.clone(), PlatformTokens, PlatformClock);
    let config = crate::host::auth_config(env);
    let owner = native
        .renewal_owners()?
        .for_import_action(&authority, &command.action_ref)
        .await?;
    let control = NativeRenewalAuthority::configured(
        &authority,
        &transport.identity,
        owner,
        &config,
        &incoming,
    );
    let receiver = receiver.ok_or_else(invalid)?;
    let (status, output) = result(receiver.apply_import(&control, &peer, bytes).await)?;
    let mac =
        transport
            .identity
            .sign_publication_response(&headers.nonce, bytes, status, &output)?;
    response(status, output, mac)
}
