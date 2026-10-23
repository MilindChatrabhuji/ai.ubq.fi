//! Managed-source publication is separate from external access_publish v1.
//! Only an access projection is encoded; physical refresh material stays native.
use crate::{
    transport::{
        NativePublicationSender, OwnedNativeAuthHeaders, PublicationCarrier, PublicationRequest,
    },
    wire::{PreparedPublicationCommand, PublicationDisposition, invalid},
};
use gateway_auth::{
    GatewayError,
    crypto::{Secret, base64url},
    managed_access::ManagedAccessProjection,
    native::*,
    native_auth::NativeTransportIdentity,
    native_credentials::native_refresh_time_ns,
    provider_credentials::{codex_credential_identity, valid_native_generation},
};
use serde::{Deserialize, Serialize};

pub const MANAGED_PUBLICATION_MAX_BYTES: usize = 65_536;

pub struct ExpectedManagedAccessPublication {
    pub action_ref: String,
    pub operation_id: String,
    pub native_owner_id: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
    pub publication_revision: String,
    pub account_id_hash: String,
    pub previous_native_source_generation: String,
}

fn required_nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManagedDocument {
    pub account_id: String,
    pub access_token: String,
    #[serde(deserialize_with = "required_nullable")]
    pub native_refreshed_at: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManagedAccessWire {
    pub v: u8,
    pub action_ref: String,
    pub operation_id: String,
    pub native_owner_id: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
    pub publication_revision: String,
    pub account_id_hash: String,
    pub previous_native_source_generation: String,
    pub native_source_generation: String,
    pub access_generation: String,
    pub document: ManagedDocument,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum ManagedCommandWire {
    ManagedAccessPublish(ManagedAccessWire),
}

/// No Debug or generic serialization: the fixed sender alone exposes these private access bytes.
pub struct PreparedManagedAccessCommand(pub(crate) ManagedAccessWire);
impl PreparedManagedAccessCommand {
    pub(crate) fn bytes(&self) -> Result<Vec<u8>, GatewayError> {
        serde_json::to_vec(&ManagedCommandWire::ManagedAccessPublish(self.0.clone()))
            .map_err(|_| invalid())
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':' | b'.'))
}
fn validate(w: &ManagedAccessWire) -> Result<(), GatewayError> {
    let identifiers = [
        &w.action_ref,
        &w.operation_id,
        &w.native_owner_id,
        &w.owner_revision,
        &w.source_revision,
        &w.normalized_revision,
        &w.publication_revision,
    ];
    if w.v != 2
        || identifiers.iter().any(|v| !identifier(v))
        || [
            &w.account_id_hash,
            &w.previous_native_source_generation,
            &w.native_source_generation,
            &w.access_generation,
        ]
        .iter()
        .any(|v| !valid_native_generation(v))
        || w.document.account_id.is_empty()
        || w.document.access_token.is_empty()
        || w.document
            .native_refreshed_at
            .as_deref()
            .is_some_and(|v| native_refresh_time_ns(Some(v)).is_none())
    {
        return Err(invalid());
    }
    let identity = codex_credential_identity(
        &w.document.account_id,
        &Secret::new(w.document.access_token.clone()),
        &Secret::new(String::new()),
    );
    if identity.routing_account_hash.0 != w.account_id_hash
        || identity.native_generation_hash != w.access_generation
    {
        return Err(invalid());
    }
    Ok(())
}

impl PreparedPublicationCommand {
    pub fn managed_access_from_registered(
        expected: ExpectedManagedAccessPublication,
        projection: &ManagedAccessProjection,
    ) -> Result<PreparedManagedAccessCommand, GatewayError> {
        let command = PreparedManagedAccessCommand(ManagedAccessWire {
            v: 2,
            action_ref: expected.action_ref,
            operation_id: expected.operation_id,
            native_owner_id: expected.native_owner_id,
            owner_revision: expected.owner_revision,
            source_revision: expected.source_revision,
            normalized_revision: expected.normalized_revision,
            publication_revision: expected.publication_revision,
            account_id_hash: expected.account_id_hash,
            previous_native_source_generation: expected.previous_native_source_generation,
            native_source_generation: projection.native_source_generation().into(),
            access_generation: projection.access_generation().into(),
            document: ManagedDocument {
                account_id: projection.account_id().into(),
                access_token: projection.access_token().expose().into(),
                native_refreshed_at: projection.native_refreshed_at().map(str::to_owned),
            },
        });
        validate(&command.0)?;
        if command.bytes()?.len() > MANAGED_PUBLICATION_MAX_BYTES {
            return Err(invalid());
        }
        Ok(command)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedPublicationReceipt {
    pub v: u8,
    pub operation: String,
    pub disposition: PublicationDisposition,
    pub owner_id: String,
    pub owner_epoch: String,
    pub action_ref: String,
    pub operation_id: String,
    pub native_owner_id: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
    pub publication_revision: String,
    pub current_source_revision: String,
    pub current_normalized_revision: String,
    pub previous_native_source_generation: String,
    pub native_source_generation: String,
    pub access_generation: String,
}
impl ManagedPublicationReceipt {
    fn matches(&self, w: &ManagedAccessWire, identity: &NativeTransportIdentity) -> bool {
        let current = match self.disposition {
            PublicationDisposition::Applied => {
                self.current_source_revision == w.publication_revision
                    && self.current_normalized_revision == w.publication_revision
            }
            PublicationDisposition::AlreadyCurrent => {
                self.current_source_revision == w.publication_revision
                    && (self.current_normalized_revision == w.publication_revision
                        || self.current_normalized_revision == w.normalized_revision)
            }
        };
        current
            && self.v == 2
            && self.operation == "managed_access_publish"
            && self.owner_id == identity.owner_id()
            && self.owner_epoch == identity.owner_epoch()
            && self.action_ref == w.action_ref
            && self.operation_id == w.operation_id
            && self.native_owner_id == w.native_owner_id
            && self.owner_revision == w.owner_revision
            && self.source_revision == w.source_revision
            && self.normalized_revision == w.normalized_revision
            && self.publication_revision == w.publication_revision
            && self.previous_native_source_generation == w.previous_native_source_generation
            && self.native_source_generation == w.native_source_generation
            && self.access_generation == w.access_generation
    }
}

pub(crate) async fn send_managed<C: PublicationCarrier>(
    identity: &NativeTransportIdentity,
    carrier: &C,
    command: &PreparedManagedAccessCommand,
    nonce_bytes: [u8; 32],
    now_ms: i64,
) -> Result<ManagedPublicationReceipt, GatewayError> {
    let body = command.bytes()?;
    let nonce = base64url(&nonce_bytes);
    let headers = OwnedNativeAuthHeaders::from_pairs(vec![
        (NATIVE_VERSION_HEADER.into(), "1".into()),
        (NATIVE_KEY_HEADER.into(), identity.key_id().into()),
        (NATIVE_TIME_HEADER.into(), now_ms.to_string()),
        (NATIVE_NONCE_HEADER.into(), nonce.clone()),
        (
            NATIVE_MAC_HEADER.into(),
            identity.sign(NATIVE_PUBLICATION_PATH, now_ms, &nonce, &body)?,
        ),
    ])?;
    let response = carrier
        .send(PublicationRequest {
            method: "POST".into(),
            path: NATIVE_PUBLICATION_PATH.into(),
            raw_body: body.clone(),
            headers,
        })
        .await?;
    let macs: Vec<_> = response
        .headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case(NATIVE_RESPONSE_MAC_HEADER))
        .collect();
    if response.raw_body.len() > MANAGED_PUBLICATION_MAX_BYTES
        || macs.len() != 1
        || identity
            .verify_publication_response(
                &nonce,
                &body,
                response.status,
                &response.raw_body,
                &macs[0].1,
            )
            .is_err()
    {
        return Err(crate::transport::unverified());
    }
    if response.status != 200 {
        if response.raw_body.len() > 4096 {
            return Err(crate::transport::unverified());
        }
        return Err(crate::transport::decode_response_error(
            response.status,
            &response.raw_body,
        )?);
    }
    let receipt: ManagedPublicationReceipt =
        serde_json::from_slice(&response.raw_body).map_err(|_| crate::transport::unverified())?;
    if !receipt.matches(&command.0, identity) {
        return Err(crate::transport::unverified());
    }
    Ok(receipt)
}

impl<C: PublicationCarrier> NativePublicationSender<'_, C> {
    pub async fn send_managed(
        &self,
        command: &PreparedManagedAccessCommand,
        nonce_bytes: [u8; 32],
        now_ms: i64,
    ) -> Result<ManagedPublicationReceipt, GatewayError> {
        send_managed(self.identity, self.carrier, command, nonce_bytes, now_ms).await
    }
}
