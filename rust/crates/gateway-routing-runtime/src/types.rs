use gateway_auth::{AuthPrincipal, crypto::Secret};
use gateway_authority::{
    paid::{PaidReservation, PaidUsage},
    routing::{AdmittedAccount, CohortProof},
};
use gateway_core::{
    GatewayError,
    identity::RequestContext,
    lifecycle::TransportObservation,
    provider::UpstreamProvider,
    state::{RecordKey, RevisionCheck},
};
use gateway_providers::{AuthMaterial, ClientSurface, Headers, PrepareOptions, PreparedRequest};
use gateway_schema::catalog::CatalogInput;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, future::Future};

#[derive(Clone, Debug)]
pub struct RoutingInput {
    pub context: RequestContext,
    pub principal: AuthPrincipal,
    pub raw: Value,
    pub surface: ClientSurface,
    pub catalog: CatalogInput,
    pub runtime: Option<Value>,
    pub client_version: String,
    pub native_session_id: Option<String>,
    /// Existing server-side request retry policy; never read from client JSON.
    pub retry_prohibited: bool,
}

#[derive(Clone, Debug)]
pub struct RoutingError {
    pub error: Box<GatewayError>,
    pub headers: Headers,
    pub source_body: Option<gateway_core::source_json::SourceJson>,
}
impl From<GatewayError> for RoutingError {
    fn from(error: GatewayError) -> Self {
        Self {
            error: Box::new(error),
            headers: BTreeMap::new(),
            source_body: None,
        }
    }
}
pub type RoutingResult<T> = Result<T, RoutingError>;

/// No credentials or request bodies are serialized in the recoverable journal.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub enum CredentialFence {
    Direct {
        provider: UpstreamProvider,
    },
    Paid {
        provider: UpstreamProvider,
        owner_id: String,
        owner_epoch: String,
        configuration_generation: String,
        credential_binding: String,
    },
    Codex {
        admission: AdmittedAccount,
        #[serde(with = "record_key")]
        source_key: RecordKey,
        source_revision: String,
        native_generation: String,
    },
    Claude {
        account_id: String,
        cohort_id: String,
        credential_fingerprint: String,
        evidence_generation: String,
        workspace_id: Option<String>,
        checks: Vec<RevisionCheckWire>,
    },
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RevisionCheckWire {
    #[serde(with = "record_key")]
    pub key: RecordKey,
    pub expected_revision: Option<String>,
}
impl From<&RevisionCheck> for RevisionCheckWire {
    fn from(check: &RevisionCheck) -> Self {
        Self {
            key: check.key.clone(),
            expected_revision: check.expected_revision.clone(),
        }
    }
}

#[derive(Clone)]
pub struct PublishedCredential {
    pub material: AuthMaterial,
    pub fence: CredentialFence,
    pub options: PrepareOptions,
}
impl std::fmt::Debug for PublishedCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PublishedCredential")
            .field("fence", &self.fence)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Debug)]
pub struct CredentialRequest {
    pub provider: UpstreamProvider,
    pub model: String,
    pub codex: Option<AdmittedAccount>,
}

#[derive(Clone, Debug)]
pub enum ClaudeSelection {
    NotApplicable,
    Eligible(Box<PublishedCredential>),
    Unavailable,
    Refused {
        status: u16,
        headers: Headers,
        body: gateway_core::source_json::SourceJson,
    },
}
#[derive(Clone, Debug)]
pub enum CodexRecovery {
    Reselect,
    Declined,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RefreshOutcome {
    Published,
    Unavailable,
}

#[derive(Clone)]
pub struct ResponseHead {
    pub status: u16,
    pub headers: Headers,
    pub provider_request_id: Option<String>,
    pub observed_at_ms: i64,
}

pub enum ClaudeOutcome {
    Preserve,
    Retry,
    Paid,
    WorkspaceContinuation(Box<PublishedCredential>),
}

/// Minted only for a current actual transport header receipt; never client data.
pub struct ObservedResponse<T> {
    pub(crate) original_request_id: String,
    pub(crate) attempt_id: String,
    pub(crate) nonce: String,
    pub(crate) response: ResponseHead,
    pub(crate) head: Option<T>,
}

pub enum ResponseDecision {
    Return,
    Continue,
    WorkspaceContinuation(Box<WorkspaceContinuation>),
}

/// A single owner-verified workspace retry within the original dispatch claim.
pub struct WorkspaceContinuation {
    pub(crate) attempt: PreparedAttempt,
    pub(crate) nonce: String,
}
impl WorkspaceContinuation {
    pub fn attempt(&self) -> &PreparedAttempt {
        &self.attempt
    }
}

/// Server-owned capabilities. Implementations must not accept arbitrary URLs,
/// paths, JSON-RPC methods, uploaded proofs or refresh credentials.
pub trait RoutingHost {
    type ClaudeHead;
    fn cancelled(&self) -> bool;
    fn cancellation_error(&self) -> GatewayError;
    fn wait(&self, milliseconds: i64) -> impl Future<Output = WaitOutcome>;
    fn credential(
        &self,
        input: CredentialRequest,
    ) -> impl Future<Output = Result<PublishedCredential, GatewayError>>;
    fn ensure_credential_current(
        &self,
        fence: &CredentialFence,
        principal: &AuthPrincipal,
        model: &str,
    ) -> impl Future<Output = Result<(), GatewayError>>;
    fn refresh_codex(
        &self,
        fence: &CredentialFence,
    ) -> impl Future<Output = Result<RefreshOutcome, GatewayError>>;
    fn select_claude(
        &self,
        principal: &AuthPrincipal,
        model: &str,
        raw: &Value,
    ) -> impl Future<Output = Result<ClaudeSelection, GatewayError>>;
    fn observe_claude_response(
        &self,
        fence: &CredentialFence,
        model: &str,
        response: ResponseHead,
    ) -> impl Future<Output = Result<Self::ClaudeHead, GatewayError>>;
    fn finish_claude_response(
        &self,
        head: Self::ClaudeHead,
        evidence: gateway_core::claude::ClaudeErrorEvidence,
    ) -> impl Future<Output = Result<ClaudeOutcome, GatewayError>>;
    fn recover_codex(
        &self,
        proof: &CohortProof,
        model: &str,
    ) -> impl Future<Output = Result<CodexRecovery, GatewayError>>;
    fn lookup_paid(
        &self,
        reservation: &PaidReservation,
    ) -> impl Future<Output = Result<Option<PaidUsage>, GatewayError>>;
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum TransportState {
    NotStarted,
    Started,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureOrigin {
    Provider,
    Gateway,
    Transport,
    GatewayDeadline,
}
#[derive(Clone, Debug)]
pub struct WaitOutcome {
    pub elapsed_ms: i64,
    pub result: Result<(), GatewayError>,
}
#[derive(Clone, Debug)]
pub struct AttemptFailure {
    /// Captured before awaiting the bounded refusal body; never inferred from status alone.
    pub origin: FailureOrigin,
    pub status: Option<u16>,
    pub headers: Headers,
    pub body: Vec<u8>,
    pub body_complete: bool,
    pub failure: gateway_providers::policy::HopFailure,
    pub transport: TransportState,
    pub semantic_committed: bool,
    pub cancelled: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RefusalDecision {
    Continue,
    Return,
    Abort,
}
#[derive(Clone, Debug, Default)]
pub struct AttemptUsage {
    pub usage: Option<Value>,
    pub provider_request_id: Option<String>,
    pub paid: Option<PaidUsage>,
    pub status: Option<u16>,
}
#[derive(Clone, Debug)]
pub struct PreparedAttempt {
    pub id: String,
    pub request: PreparedRequest,
    pub credential: CredentialFence,
    pub paid: Option<PaidReservation>,
    pub original_request_id: String,
}

/// A fixed host may retain only a secret wrapper, never serialized diagnostics.
pub fn direct_credential(provider: UpstreamProvider, secret: &Secret) -> PublishedCredential {
    PublishedCredential {
        material: AuthMaterial {
            secret: secret.expose().to_owned(),
            ..Default::default()
        },
        fence: CredentialFence::Direct { provider },
        options: PrepareOptions::default(),
    }
}

#[derive(Clone, Debug)]
pub struct RecoveredSession {
    pub request_id: String,
    pub observation: TransportObservation,
    pub settled: bool,
}

mod record_key {
    use gateway_core::{state::RecordKey, tuple_key::TupleKey};
    use serde::{Deserialize, Deserializer, Serializer, de::Error as _, ser::Error as _};
    pub fn serialize<S: Serializer>(key: &RecordKey, serializer: S) -> Result<S::Ok, S::Error> {
        TupleKey::from_record_key(key)
            .and_then(|key| key.validate_stored_key())
            .map_err(|_| S::Error::custom("Invalid source tuple key"))?;
        serializer.serialize_str(&key.0)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(decoder: D) -> Result<RecordKey, D::Error> {
        let key = RecordKey(String::deserialize(decoder)?);
        TupleKey::from_record_key(&key)
            .and_then(|key| key.validate_stored_key())
            .map_err(|_| D::Error::custom("Invalid source tuple key"))?;
        Ok(key)
    }
}
