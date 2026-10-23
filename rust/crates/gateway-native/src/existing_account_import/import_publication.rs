//! Native receipt-bound sanitized command. Neither DATA nor HTTP200 is completion.
use super::{
    DurableNativeImport, ExistingAccountImportStore, LiveImportCustody, durability,
    validation::{CatalogValidation, ValidatedNativeImport},
};
use crate::{import_custody_protocol::unavailable, native_import::NativeImportContext};
use gateway_auth::{
    crypto::{Secret, sha256_hex},
    provider_credentials::codex_credential_identity,
};
use gateway_authority::native_control::import::{
    AuthenticatedImportTerminal, AuthenticatedNativeImport, ImportAccessDocument,
    ImportCatalogData, ImportPublicationCommandData, NativeImportPublication,
};
use gateway_core::GatewayError;

/// Native-only producer; no JSON/receipt-DATA/Boolean constructor.
pub(super) struct PreparedImportPublication<'a> {
    original: &'a AuthenticatedNativeImport,
    command: ImportPublicationCommandData,
    body: Vec<u8>,
}
impl<'a> PreparedImportPublication<'a> {
    pub(super) fn from_durable(
        store: &ExistingAccountImportStore,
        custody: &mut LiveImportCustody<'_>,
        context: &NativeImportContext<'a>,
        candidate: &ValidatedNativeImport<'_>,
        receipt: &DurableNativeImport,
    ) -> Result<Self, GatewayError> {
        let proof = context.original_proof();
        let original_body = context.original_body();
        context.check_document(proof, proof.metadata(), original_body)?;
        if !std::ptr::eq(candidate.original, proof)
            || receipt.binding() != custody.binding()
            || !receipt
                .credentials()
                .same_credentials(&candidate.credentials)
        {
            return Err(unavailable());
        }
        custody.check_live(store, proof, original_body, context)?;
        durability::recheck(store, receipt)?;
        let binding = receipt.binding();
        let credentials = receipt.credentials();
        let access = codex_credential_identity(
            &credentials.account_id,
            &credentials.access_token,
            &Secret::new(String::new()),
        );
        let catalog = match &candidate.catalog {
            CatalogValidation::Normalized {
                snapshot,
                client_version,
                upstream_status,
            } => ImportCatalogData::Normalized {
                snapshot: snapshot.clone(),
                client_version: client_version.clone(),
                upstream_status: *upstream_status,
            },
            CatalogValidation::AuthenticatedLimited => ImportCatalogData::AuthenticatedLimited {
                upstream_status: 429,
            },
        };
        let command = ImportPublicationCommandData {
            operation: "codex_auth_import_publish".into(),
            v: 1,
            action_ref: binding.action_ref.clone(),
            operation_id: binding.operation_id.clone(),
            claim_ref: binding.claim_ref.clone(),
            native_owner_id: binding.native_owner_id.clone(),
            owner_revision: binding.owner_revision.clone(),
            source_revision: binding.source_revision.clone(),
            normalized_revision: binding.normalized_revision.clone(),
            publication_revision: custody.publication_reference()?,
            account_id_hash: binding.account_id_hash.clone(),
            previous_native_source_generation: binding.source_native_generation.clone(),
            native_source_generation: receipt.native_generation().into(),
            access_generation: access.native_generation_hash,
            native_receipt_ref: receipt.receipt_ref(),
            document: ImportAccessDocument {
                account_id: credentials.account_id.clone(),
                access_token: credentials.access_token.expose().into(),
                updated_at_ms: candidate.updated_at_ms,
                native_refreshed_at: credentials.native_refreshed_at.clone(),
            },
            catalog,
        };
        let body = command.bytes()?;
        custody.bind_publication(&sha256_hex(&body))?;
        custody.check_live(store, proof, original_body, context)?;
        durability::recheck(store, receipt)?;
        Ok(Self {
            original: proof,
            command,
            body,
        })
    }
    pub(super) fn require_terminal(
        &self,
        terminal: &AuthenticatedImportTerminal,
        receipt: &DurableNativeImport,
        reply: Option<&AuthenticatedImportPublicationReply>,
    ) -> Result<(), GatewayError> {
        let current = terminal.terminal();
        let identity = codex_credential_identity(
            &receipt.credentials().account_id,
            &receipt.credentials().access_token,
            &Secret::new(String::new()),
        );
        if terminal.binding() != receipt.binding()
            || current.publication_revision != self.command.publication_revision
            || current.native_receipt_ref != self.command.native_receipt_ref
            || current.publication_request_digest != self.request_digest()
            || current.native_source_generation != receipt.native_generation()
            || current.access_generation != self.command.access_generation
            || current.credential_version != identity.credential_version.0
            || current.source_revision != self.command.publication_revision
            || current.normalized_revision != self.command.publication_revision
        {
            return Err(unavailable());
        }
        if let Some(reply) = reply {
            let p = &reply.publication().publication;
            if reply.request_digest() != self.request_digest()
                || p.publication_revision != current.publication_revision
                || p.native_receipt_ref != current.native_receipt_ref
                || p.native_source_generation != current.native_source_generation
                || p.access_generation != current.access_generation
                || p.credential_version != current.credential_version
                || p.source_revision != current.source_revision
                || p.normalized_revision != current.normalized_revision
                || p.catalog_revision != current.catalog_revision
                || p.runtime_revision != current.runtime_revision
                || p.auth_generation_revision != current.auth_generation_revision
                || p.paid_control_config_revision != current.paid_control_config_revision
            {
                return Err(unavailable());
            }
        }
        Ok(())
    }
    pub(super) fn command(&self) -> &ImportPublicationCommandData {
        &self.command
    }
    pub(super) fn body(&self) -> &[u8] {
        &self.body
    }
    pub(super) fn request_digest(&self) -> String {
        sha256_hex(&self.body)
    }
}
/// Actual matching signed network reply only; not a native durability or final completion proof.
pub(super) struct AuthenticatedImportPublicationReply {
    publication: NativeImportPublication,
    request_digest: String,
}
impl AuthenticatedImportPublicationReply {
    pub(super) fn publication(&self) -> &NativeImportPublication {
        &self.publication
    }
    pub(super) fn request_digest(&self) -> &str {
        &self.request_digest
    }
}

use crate::private_https::PrivateHttps;
use gateway_auth::{crypto::base64url, native::*, native_auth::NativeTransportIdentity};
use std::{net::TcpStream, time::Instant};
/// One actual constructor-selected TLS transport; no raw-response/callback issuer.
pub(super) struct ImportPublicationHttp {
    identity: NativeTransportIdentity,
    transport: PrivateHttps,
}
impl ImportPublicationHttp {
    #[cfg(not(feature = "native-import-fixture"))]
    pub(super) fn from_connected(
        target: &str,
        socket: TcpStream,
        identity: NativeTransportIdentity,
    ) -> Result<Self, GatewayError> {
        Ok(Self {
            identity,
            transport: PrivateHttps::from_connected(
                target,
                NATIVE_PUBLICATION_PATH,
                socket,
                ureq::tls::RootCerts::WebPki,
            )?,
        })
    }
    #[cfg(feature = "native-import-fixture")]
    pub(super) fn from_fixture_connected(
        socket: TcpStream,
        identity: NativeTransportIdentity,
    ) -> Result<Self, GatewayError> {
        if !socket
            .local_addr()
            .map_err(|_| unavailable())?
            .ip()
            .is_loopback()
            || !socket
                .peer_addr()
                .map_err(|_| unavailable())?
                .ip()
                .is_loopback()
        {
            return Err(unavailable());
        }
        Ok(Self {
            identity,
            transport: PrivateHttps::from_connected(
                "https://localhost/uos/native/publication",
                NATIVE_PUBLICATION_PATH,
                socket,
                super::import_endpoints::validation_roots(),
            )?,
        })
    }
    #[cfg(test)]
    fn fixture(
        target: &str,
        socket: TcpStream,
        identity: NativeTransportIdentity,
        ca: &[u8],
    ) -> Result<Self, GatewayError> {
        Ok(Self {
            identity,
            transport: PrivateHttps::from_connected(
                target,
                NATIVE_PUBLICATION_PATH,
                socket,
                ureq::tls::RootCerts::new_with_certs(&[
                    ureq::tls::Certificate::from_der(ca).to_owned()
                ]),
            )?,
        })
    }
    pub(super) fn publish(
        &self,
        prepared: &PreparedImportPublication<'_>,
        store: &ExistingAccountImportStore,
        custody: &mut LiveImportCustody<'_>,
        context: &NativeImportContext<'_>,
        receipt: &DurableNativeImport,
    ) -> Result<AuthenticatedImportPublicationReply, GatewayError> {
        let proof = context.original_proof();
        context.check_document(proof, proof.metadata(), context.original_body())?;
        if !std::ptr::eq(prepared.original, proof)
            || receipt.binding() != custody.binding()
            || receipt.receipt_ref() != prepared.command.native_receipt_ref
            || prepared.command.action_ref != proof.metadata().action_ref
            || prepared.command.operation_id != proof.metadata().operation_id
        {
            return Err(unavailable());
        }
        custody.check_live(store, proof, context.original_body(), context)?;
        durability::recheck(store, receipt)?;
        if prepared.command.bytes()? != prepared.body() {
            return Err(unavailable());
        }
        let reply = self.exchange_data(prepared.command(), context.deadline())?;
        context.check_document(proof, proof.metadata(), context.original_body())?;
        durability::recheck(store, receipt)?;
        // Current authoritative terminal and original private claim are additionally
        // required by the final completion producer. This reply alone is not it.
        Ok(reply)
    }
    fn exchange_data(
        &self,
        command: &ImportPublicationCommandData,
        deadline: Instant,
    ) -> Result<AuthenticatedImportPublicationReply, GatewayError> {
        let body = command.bytes()?;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| unavailable())?;
        let nonce = base64url(&random);
        let now = crate::http_server::now_ms()?;
        let mac = self
            .identity
            .sign(NATIVE_PUBLICATION_PATH, now, &nonce, &body)?;
        let headers = vec![
            (NATIVE_VERSION_HEADER.into(), "1".into()),
            (NATIVE_KEY_HEADER.into(), self.identity.key_id().into()),
            (NATIVE_TIME_HEADER.into(), now.to_string()),
            (NATIVE_NONCE_HEADER.into(), nonce.clone()),
            (NATIVE_MAC_HEADER.into(), mac),
        ];
        let response = self
            .transport
            .send_import_publication(&headers, &body, deadline)?;
        let signatures: Vec<_> = response
            .headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(NATIVE_RESPONSE_MAC_HEADER))
            .collect();
        if signatures.len() != 1 {
            return Err(unavailable());
        }
        self.identity
            .verify_publication_response(
                &nonce,
                &body,
                response.status,
                &response.body,
                &signatures[0].1,
            )
            .map_err(|_| unavailable())?;
        if response.status != 200 {
            return Err(unavailable());
        }
        let publication = NativeImportPublication::parse_for(&response.body, &body)?;
        Ok(AuthenticatedImportPublicationReply {
            publication,
            request_digest: sha256_hex(&body),
        })
    }
}

#[cfg(test)]
mod tests;
