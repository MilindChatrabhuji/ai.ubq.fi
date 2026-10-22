use gateway_auth::{AuthPrincipal, crypto::Secret};
use gateway_authority::{
    paid::{PaidReservation, PaidUsage},
    routing::{AdmittedAccount, CohortProof},
};
use gateway_core::{
    GatewayError,
    identity::RequestContext,
    js_string::JsString16,
    lifecycle::TransportObservation,
    model::ModelId,
    provider::UpstreamProvider,
    state::{RecordKey, RevisionCheck},
};
use gateway_providers::{
    AuthMaterial, ClaudeBodyOptions, ClientSurface, DecodePlan, Headers, PrepareOptions,
    PreparedClaudeBody, PreparedRequest,
};
use gateway_schema::catalog::CatalogInput;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, future::Future};

#[derive(Clone, Debug)]
pub struct RoutingInput {
    pub context: RequestContext,
    pub principal: AuthPrincipal,
    pub raw: gateway_core::source_json::SourceJson,
    pub surface: ClientSurface,
    pub catalog: CatalogInput,
    pub runtime: Option<gateway_core::source_json::SourceJson>,
    pub client_version: String,
    pub native_session_id: Option<String>,
    /// Existing server-side request retry policy; never read from client JSON.
    pub retry_prohibited: bool,
}

impl RoutingInput {
    /// Neutral data construction only; validation remains in source-defined planning phases.
    pub fn from_source_request(
        metadata: crate::local_work::LocalRequestMetadata,
        request: gateway_schema::source_request::OrdinarySourceRequest,
    ) -> Self {
        Self {
            context: metadata.context,
            principal: metadata.principal,
            raw: request.original_source().clone(),
            surface: match request.surface() {
                gateway_schema::request::RequestSurface::Responses => ClientSurface::Responses,
                gateway_schema::request::RequestSurface::ChatCompletions => ClientSurface::Chat,
            },
            catalog: metadata.catalog,
            runtime: metadata.runtime,
            client_version: metadata.client_version,
            native_session_id: metadata.native_session_id,
            retry_prohibited: metadata.retry_prohibited,
        }
    }
    pub fn original_source(&self) -> &gateway_core::source_json::SourceJson {
        &self.raw
    }
    pub fn source_member(&self, name: &str) -> Option<gateway_core::source_json::SourceJson> {
        gateway_core::source_serialization::member(&self.raw, name)
    }
    pub fn streamed(&self) -> bool {
        self.source_member("stream")
            .is_some_and(|value| value.as_str() == "true")
    }
    pub fn requested_reasoning(&self) -> Option<gateway_core::js_string::JsString16> {
        self.source_member("reasoning")
            .and_then(|value| gateway_core::source_serialization::member(&value, "effort"))
            .and_then(|value| gateway_core::source_serialization::string(&value))
            .or_else(|| {
                self.source_member("reasoning_effort")
                    .and_then(|value| gateway_core::source_serialization::string(&value))
            })
    }
}

#[derive(Clone, Debug)]
pub struct RoutingError {
    pub error: Box<GatewayError>,
    pub headers: Headers,
    pub source_body: Option<SourceRefusalBody>,
}

#[derive(Clone, Debug)]
pub enum SourceRefusalBody {
    Json(gateway_core::source_json::SourceJson),
    /// Exact source HTTP-constructor failure; never a quota or paid proof.
    InternalServerError,
}
impl SourceRefusalBody {
    pub fn as_bytes(&self) -> &[u8] {
        match self {
            Self::Json(body) => body.as_bytes(),
            Self::InternalServerError => b"Internal Server Error",
        }
    }
}
impl RoutingError {
    /// Cleanup is an internal diagnostic; the original wire status/body remain authoritative.
    pub(crate) fn with_cleanup_diagnostic(mut self, cleanup: &RoutingError) -> Self {
        if self.source_body.is_none() {
            self.source_body = Some(SourceRefusalBody::Json(
                gateway_core::source_json::SourceJson::from_serializable(&self.error.envelope)
                    .expect("A scalar error envelope is valid source JSON"),
            ));
        }
        let code = cleanup
            .error
            .envelope
            .error
            .code
            .as_deref()
            .unwrap_or("unknown")
            .chars()
            .take(48)
            .collect::<String>();
        self.error.envelope.error.message = format!(
            "Original request failure; original-lifetime cleanup also failed (status {}, code {}).",
            cleanup.error.status, code,
        );
        self
    }
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
impl From<gateway_schema::source_request::SourceRequestError> for RoutingError {
    fn from(error: gateway_schema::source_request::SourceRequestError) -> Self {
        Self {
            error: Box::new(error.diagnostic().clone()),
            headers: BTreeMap::new(),
            source_body: Some(SourceRefusalBody::Json(error.body().clone())),
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
        workspace_id: Option<JsString16>,
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
pub enum PublishedCredential {
    Scalar {
        material: AuthMaterial,
        fence: CredentialFence,
        options: Box<PrepareOptions>,
    },
    Claude {
        fence: CredentialFence,
        body_options: ClaudeBodyOptions,
    },
}
impl PublishedCredential {
    pub fn fence(&self) -> &CredentialFence {
        match self {
            Self::Scalar { fence, .. } | Self::Claude { fence, .. } => fence,
        }
    }
    pub fn into_fence(self) -> CredentialFence {
        match self {
            Self::Scalar { fence, .. } | Self::Claude { fence, .. } => fence,
        }
    }
}
impl std::fmt::Debug for PublishedCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct(match self {
            Self::Scalar { .. } => "ScalarCredential",
            Self::Claude { .. } => "ClaudeCredential",
        })
        .field("fence", self.fence())
        .finish_non_exhaustive()
    }
}
/// Prepared data only; the Claude stage has no headers or credential material.
#[derive(Clone)]
pub enum PreparedWireRequest {
    Ready(PreparedRequest),
    Claude(PreparedClaudeBody),
}
impl PreparedWireRequest {
    pub fn provider(&self) -> UpstreamProvider {
        match self {
            Self::Ready(request) => request.provider,
            Self::Claude(_) => UpstreamProvider::ClaudeCode,
        }
    }
    pub fn url(&self) -> &str {
        match self {
            Self::Ready(request) => &request.url,
            Self::Claude(body) => body.url(),
        }
    }
    pub fn method(&self) -> &str {
        match self {
            Self::Ready(request) => &request.method,
            Self::Claude(body) => body.method(),
        }
    }
    pub fn body(&self) -> &gateway_core::source_json::SourceJson {
        match self {
            Self::Ready(request) => &request.body,
            Self::Claude(body) => body.body(),
        }
    }
    pub fn decode(&self) -> &DecodePlan {
        match self {
            Self::Ready(request) => &request.decode,
            Self::Claude(body) => body.decode(),
        }
    }
    pub fn stream(&self) -> bool {
        self.decode().stream
    }
    pub fn warnings(&self) -> &[String] {
        match self {
            Self::Ready(request) => &request.warnings,
            Self::Claude(body) => body.warnings(),
        }
    }
}
impl std::fmt::Debug for PreparedWireRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ready(request) => std::fmt::Debug::fmt(request, f),
            Self::Claude(body) => f
                .debug_struct("PreparedClaudeBody")
                .field("url", &body.url())
                .field("method", &body.method())
                .field("kind", &body.kind())
                .field("body", &"[request body omitted]")
                .field("decode", &body.decode().decode)
                .finish_non_exhaustive(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct CredentialRequest {
    pub provider: UpstreamProvider,
    pub model: ModelId,
    pub codex: Option<AdmittedAccount>,
}

#[derive(Clone, Debug)]
pub enum ClaudeSelection {
    NotApplicable,
    Eligible(Box<PublishedCredential>),
    Unavailable,
    InternalServerError,
    Refused {
        status: u16,
        headers: Headers,
        body: gateway_core::source_json::SourceJson,
    },
}
#[derive(Clone, Debug)]
pub enum CodexRecovery {
    /// Exact authority-elected recovery generation and existing quota probe.
    Recovered(AdmittedAccount),
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
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator>;
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
        model: &ModelId,
    ) -> impl Future<Output = Result<(), GatewayError>>;
    fn refresh_codex(
        &self,
        fence: &CredentialFence,
    ) -> impl Future<Output = Result<RefreshOutcome, GatewayError>>;
    fn select_claude(
        &self,
        principal: &AuthPrincipal,
        model: &ModelId,
        raw: &gateway_core::source_json::SourceJson,
        effective_effort: Option<&gateway_core::js_string::JsString16>,
    ) -> impl Future<Output = Result<ClaudeSelection, GatewayError>>;
    fn observe_claude_response(
        &self,
        fence: &CredentialFence,
        model: &ModelId,
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
        model: &ModelId,
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
    /// Actual fetch was invoked but its durable started marker is unavailable.
    /// This cannot prove no spend, cancel a claim or mint provider quota proof.
    Unknown,
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
    pub request: PreparedWireRequest,
    pub credential: CredentialFence,
    pub paid: Option<PaidReservation>,
    pub original_request_id: String,
}

/// A fixed host may retain only a secret wrapper, never serialized diagnostics.
pub fn direct_credential(provider: UpstreamProvider, secret: &Secret) -> PublishedCredential {
    PublishedCredential::Scalar {
        material: AuthMaterial {
            secret: secret.expose().to_owned(),
            ..Default::default()
        },
        fence: CredentialFence::Direct { provider },
        options: Box::new(PrepareOptions::default()),
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

#[cfg(test)]
mod source_cleanup_tests {
    use super::*;
    use gateway_core::{js_string::JsString16, source_json::SourceJson};
    #[test]
    fn cleanup_diagnostic_never_overwrites_original_source_wire_truth() {
        let source = gateway_schema::source_request::SourceRequestError::new(
            400,
            JsString16::from_units(vec![0xd800]),
            "invalid_request_error",
            Some("source_invalid"),
            Some(Some(JsString16::from_units(vec![0xdfff]))),
        );
        let body = source.body().clone();
        let error = RoutingError::from(source).with_cleanup_diagnostic(
            &GatewayError::unavailable("cleanup detail", "cleanup_failed").into(),
        );
        assert_eq!(error.error.status, 400);
        assert_eq!(error.source_body.unwrap().as_bytes(), body.as_bytes());
        assert!(
            error
                .error
                .envelope
                .error
                .message
                .contains("cleanup also failed")
        );
        assert!(error.error.envelope.error.message.len() < 160);
    }
    #[test]
    fn scalar_original_error_gets_exact_body_before_internal_cleanup_diagnostic() {
        let source =
            GatewayError::new(409, "original conflict", Some("original_conflict")).with_param(None);
        let body = SourceJson::from_serializable(&source.envelope).unwrap();
        let error = RoutingError::from(source).with_cleanup_diagnostic(
            &GatewayError::unavailable("cleanup detail", "cleanup_failed").into(),
        );
        assert_eq!(error.error.status, 409);
        assert_eq!(error.source_body.unwrap().as_bytes(), body.as_bytes());
    }
}
