//! One fixed private native publication route. The HTTP adapter only carries
//! bytes; this receiver owns parsing, authentication, durable fences and CAS.
use crate::{
    access_publication::{
        AccessCredentialSource, PreparedAccessPublication, RegisteredAccessOwner,
    },
    control_publication::{ConfiguredPaidInputs, PreparedConfigurationPublication},
    wire::{
        PreparedPublicationCommand, PublicationDisposition, PublicationReceipt, WireCommand,
        invalid,
    },
};
use gateway_auth::{
    GatewayError,
    crypto::base64url,
    native::*,
    native_auth::{
        AuthenticatedNativeOwner, NativeAuthHeaders, NativeAuthenticator, NativeCapability,
        NativeTransportIdentity,
    },
    native_credentials::{NativeCredentials, NativeOwnerId},
    native_replay::StoreNonceAuthority,
};
use gateway_core::state::AuthorityStore;
use std::future::Future;

#[derive(Clone)]
pub struct OwnedNativeAuthHeaders {
    version: String,
    key_id: String,
    time_ms: String,
    nonce: String,
    mac: String,
}
impl OwnedNativeAuthHeaders {
    pub fn from_pairs(
        pairs: impl IntoIterator<Item = (String, String)>,
    ) -> Result<Self, GatewayError> {
        let pairs: Vec<_> = pairs.into_iter().collect();
        let one = |name: &str| -> Result<String, GatewayError> {
            let values: Vec<_> = pairs
                .iter()
                .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                .collect();
            if values.len() != 1 || values[0].1.len() > 256 {
                return Err(invalid());
            }
            Ok(values[0].1.clone())
        };
        Ok(Self {
            version: one(NATIVE_VERSION_HEADER)?,
            key_id: one(NATIVE_KEY_HEADER)?,
            time_ms: one(NATIVE_TIME_HEADER)?,
            nonce: one(NATIVE_NONCE_HEADER)?,
            mac: one(NATIVE_MAC_HEADER)?,
        })
    }
    pub fn pairs(&self) -> Vec<(String, String)> {
        vec![
            (NATIVE_VERSION_HEADER.into(), self.version.clone()),
            (NATIVE_KEY_HEADER.into(), self.key_id.clone()),
            (NATIVE_TIME_HEADER.into(), self.time_ms.clone()),
            (NATIVE_NONCE_HEADER.into(), self.nonce.clone()),
            (NATIVE_MAC_HEADER.into(), self.mac.clone()),
        ]
    }
    pub(crate) fn borrowed(&self) -> NativeAuthHeaders<'_> {
        NativeAuthHeaders {
            version: &self.version,
            key_id: &self.key_id,
            time_ms: &self.time_ms,
            nonce: &self.nonce,
            mac: &self.mac,
        }
    }
}

pub struct PublicationRequest {
    pub method: String,
    pub path: String,
    pub raw_body: Vec<u8>,
    pub headers: OwnedNativeAuthHeaders,
}
pub struct PublicationResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub raw_body: Vec<u8>,
}

pub struct PublicationReceiver {
    identity: NativeTransportIdentity,
    inputs: ConfiguredPaidInputs,
    registered: Vec<RegisteredAccessOwner>,
    clock: fn() -> i64,
}
impl PublicationReceiver {
    pub fn configured(
        identity: NativeTransportIdentity,
        inputs: ConfiguredPaidInputs,
        registered_access_owners: Vec<RegisteredAccessOwner>,
        clock: fn() -> i64,
    ) -> Result<Self, GatewayError> {
        let mut seen = std::collections::BTreeSet::new();
        if registered_access_owners.len() > 2
            || registered_access_owners
                .iter()
                .any(|owner| !seen.insert(owner.native_owner_id().0.clone()))
        {
            return Err(invalid());
        }
        Ok(Self {
            identity,
            inputs,
            registered: registered_access_owners,
            clock,
        })
    }
    pub(crate) fn import_identity(&self) -> &NativeTransportIdentity {
        &self.identity
    }
    pub(crate) fn import_inputs(&self) -> &ConfiguredPaidInputs {
        &self.inputs
    }
    pub async fn handle<S: AuthorityStore>(
        &self,
        store: &S,
        request: PublicationRequest,
    ) -> PublicationResponse {
        if request.method != "POST" || request.path != NATIVE_PUBLICATION_PATH {
            return error_response(GatewayError::new(
                404,
                "Unknown native publication route",
                Some("native_publication_route_invalid"),
            ));
        }
        if request.raw_body.len() > NATIVE_MAX_BODY_BYTES {
            return error_response(GatewayError::new(
                413,
                "Native publication body exceeds its limit",
                Some("native_publication_body_too_large"),
            ));
        }
        let replay = StoreNonceAuthority::new(store);
        let authenticator = NativeAuthenticator::new(&self.identity, &replay);
        let proof = match authenticator
            .authenticate(
                NATIVE_PUBLICATION_PATH,
                request.headers.borrowed(),
                &request.raw_body,
                (self.clock)(),
            )
            .await
        {
            Ok(proof) => proof,
            Err(error) => return error_response(error),
        };
        let result = self.apply(store, &proof, &request.raw_body).await;
        let mut response = match result {
            Ok(receipt) => match serde_json::to_vec(&receipt) {
                Ok(raw_body) => PublicationResponse {
                    status: 200,
                    headers: vec![
                        ("content-type".into(), "application/json".into()),
                        ("cache-control".into(), "no-store".into()),
                    ],
                    raw_body,
                },
                Err(_) => error_response(unverified()),
            },
            Err(error) => error_response(error),
        };
        match self.identity.sign_publication_response(
            &request.headers.nonce,
            &request.raw_body,
            response.status,
            &response.raw_body,
        ) {
            Ok(mac) => response
                .headers
                .push((NATIVE_RESPONSE_MAC_HEADER.into(), mac)),
            Err(error) => return error_response(error),
        }
        response
    }
    async fn apply<S: AuthorityStore>(
        &self,
        store: &S,
        proof: &AuthenticatedNativeOwner,
        body: &[u8],
    ) -> Result<PublicationReceipt, GatewayError> {
        match WireCommand::parse(body)? {
            WireCommand::ConfigPublish(w) => {
                proof.require(NativeCapability::ConfigurationPublish, (self.clock)())?;
                let prepared = PreparedConfigurationPublication::capture(
                    store,
                    &self.identity,
                    &self.inputs,
                    &w.config.generation,
                    (self.clock)(),
                )
                .await?;
                if prepared.config != w.config
                    || prepared.checks[0].expected_revision.as_deref() != Some(&w.owner_revision)
                    || prepared.changed
                        && prepared.checks[1].expected_revision != w.previous_config_revision
                {
                    return Err(crate::control_publication::conflict());
                }
                let disposition = if prepared.changed {
                    PublicationDisposition::Applied
                } else {
                    PublicationDisposition::AlreadyCurrent
                };
                let configuration_revision = if prepared.changed {
                    w.publication_revision.clone()
                } else {
                    prepared.checks[1]
                        .expected_revision
                        .clone()
                        .ok_or_else(invalid)?
                };
                let receipt = PublicationReceipt {
                    v: 1,
                    operation: "config_publish".into(),
                    disposition,
                    owner_id: prepared.owner.owner_id.clone(),
                    owner_epoch: prepared.owner.owner_epoch.clone(),
                    owner_revision: w.owner_revision,
                    publication_revision: w.publication_revision.clone(),
                    configuration_revision: Some(configuration_revision),
                    configuration_generation: Some(prepared.config.generation.clone()),
                    configuration_fingerprint: Some(
                        prepared.config.configuration_fingerprint.clone(),
                    ),
                    source_revision: None,
                    normalized_revision: None,
                    pool_versionstamp: None,
                    native_owner_id: None,
                    account_id_hash: None,
                    credential_version: None,
                    native_generation: None,
                };
                prepared
                    .publish_received(store, proof, (self.clock)(), &w.publication_revision, body)
                    .await?;
                Ok(receipt)
            }
            WireCommand::AccessPublish(w) => {
                proof.require(NativeCapability::AccessPublish, (self.clock)())?;
                let registered = self
                    .registered
                    .iter()
                    .find(|owner| owner.native_owner_id().0 == w.native_owner_id)
                    .ok_or_else(|| {
                        GatewayError::new(
                            403,
                            "Native access owner is not registered",
                            Some("native_access_owner_unavailable"),
                        )
                    })?;
                let observed = w.document.native()?;
                if observed.routing_account_hash() != w.account_id_hash
                    || observed.routing_credential_version() != w.credential_version
                    || observed.generation_hash() != w.native_generation
                {
                    return Err(invalid());
                }
                let source = ReceivedAccess {
                    owner_id: w.native_owner_id.clone(),
                    credentials: observed,
                };
                let prepared = PreparedAccessPublication::capture(
                    store,
                    &source,
                    &self.identity,
                    registered,
                    (self.clock)(),
                    &w.publication_revision,
                )
                .await?;
                if prepared.checks[0].expected_revision.as_deref() != Some(&w.owner_revision)
                    || !prepared.unchanged
                        && (prepared.checks[1].expected_revision.as_deref()
                            != Some(&w.source_revision)
                            || prepared.checks[2].expected_revision != w.normalized_revision)
                {
                    return Err(crate::control_publication::conflict());
                }
                let raw_revision = prepared.pool.pool_versionstamp.0.clone();
                let normalized_revision = if prepared.unchanged {
                    prepared.checks[2]
                        .expected_revision
                        .clone()
                        .unwrap_or_else(|| w.publication_revision.clone())
                } else {
                    w.publication_revision.clone()
                };
                let receipt = PublicationReceipt {
                    v: 1,
                    operation: "access_publish".into(),
                    disposition: if prepared.unchanged {
                        PublicationDisposition::AlreadyCurrent
                    } else {
                        PublicationDisposition::Applied
                    },
                    owner_id: prepared.owner.owner_id.clone(),
                    owner_epoch: prepared.owner.owner_epoch.clone(),
                    owner_revision: w.owner_revision,
                    publication_revision: w.publication_revision,
                    configuration_revision: None,
                    configuration_generation: None,
                    configuration_fingerprint: None,
                    source_revision: Some(raw_revision.clone()),
                    normalized_revision: Some(normalized_revision),
                    pool_versionstamp: Some(raw_revision),
                    native_owner_id: Some(w.native_owner_id),
                    account_id_hash: Some(w.account_id_hash),
                    credential_version: Some(w.credential_version),
                    native_generation: Some(w.native_generation),
                };
                prepared
                    .publish_received(store, proof, (self.clock)(), body)
                    .await?;
                Ok(receipt)
            }
        }
    }
}

struct ReceivedAccess {
    owner_id: String,
    credentials: NativeCredentials,
}
impl AccessCredentialSource for ReceivedAccess {
    async fn read_current_access(
        &self,
        owner: &NativeOwnerId,
    ) -> Result<NativeCredentials, GatewayError> {
        if owner.0 != self.owner_id {
            return Err(invalid());
        }
        Ok(self.credentials.clone())
    }
}
pub(crate) fn error_response(error: GatewayError) -> PublicationResponse {
    PublicationResponse {
        status: error.status,
        headers: vec![
            ("content-type".into(), "application/json".into()),
            ("cache-control".into(), "no-store".into()),
        ],
        raw_body: serde_json::to_vec(&error.envelope).expect("String-only typed error encoding"),
    }
}

/// The native adapter owns one exact constructor-selected Worker/TLS target.
/// No URL is supplied to this operation and no alternate target is attempted.
pub trait PublicationCarrier {
    fn send(
        &self,
        request: PublicationRequest,
    ) -> impl Future<Output = Result<PublicationResponse, GatewayError>>;
}
pub struct NativePublicationSender<'a, C> {
    pub(crate) identity: &'a NativeTransportIdentity,
    pub(crate) carrier: &'a C,
}
impl<'a, C: PublicationCarrier> NativePublicationSender<'a, C> {
    pub fn configured(identity: &'a NativeTransportIdentity, carrier: &'a C) -> Self {
        Self { identity, carrier }
    }
    pub async fn send(
        &self,
        command: &PreparedPublicationCommand,
        nonce_bytes: [u8; 32],
        now_ms: i64,
    ) -> Result<PublicationReceipt, GatewayError> {
        let body = command.0.bytes()?;
        let nonce = base64url(&nonce_bytes);
        let signature = self
            .identity
            .sign(NATIVE_PUBLICATION_PATH, now_ms, &nonce, &body)?;
        let headers = OwnedNativeAuthHeaders {
            version: "1".into(),
            key_id: self.identity.key_id().into(),
            time_ms: now_ms.to_string(),
            nonce: nonce.clone(),
            mac: signature,
        };
        let response = self
            .carrier
            .send(PublicationRequest {
                method: "POST".into(),
                path: NATIVE_PUBLICATION_PATH.into(),
                raw_body: body.clone(),
                headers,
            })
            .await?;
        let signatures: Vec<_> = response
            .headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case(NATIVE_RESPONSE_MAC_HEADER))
            .collect();
        if signatures.len() != 1
            || self
                .identity
                .verify_publication_response(
                    &nonce,
                    &body,
                    response.status,
                    &response.raw_body,
                    &signatures[0].1,
                )
                .is_err()
        {
            return Err(unverified());
        }
        if response.status != 200 {
            return Err(decode_response_error(response.status, &response.raw_body)?);
        }
        let receipt: PublicationReceipt =
            serde_json::from_slice(&response.raw_body).map_err(|_| unverified())?;
        if receipt.owner_id != self.identity.owner_id()
            || receipt.owner_epoch != self.identity.owner_epoch()
            || !receipt.matches(&command.0)
        {
            return Err(unverified());
        }
        Ok(receipt)
    }
}
pub(crate) fn unverified() -> GatewayError {
    GatewayError::unavailable(
        "Native publication response is not an authenticated matching receipt",
        "native_publication_response_unverified",
    )
}

pub(crate) fn decode_response_error(
    status: u16,
    body: &[u8],
) -> Result<GatewayError, GatewayError> {
    let value: serde_json::Value = serde_json::from_slice(body).map_err(|_| unverified())?;
    let error = value
        .get("error")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(unverified)?;
    let message = error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(unverified)?;
    let kind = error
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(unverified)?;
    let code = error.get("code").and_then(serde_json::Value::as_str);
    let mut result = GatewayError::new(status, message, code).with_type(kind);
    if let Some(param) = error.get("param") {
        if !param.is_null() && !param.is_string() {
            return Err(unverified());
        }
        result = result.with_param(param.as_str());
    }
    Ok(result)
}
