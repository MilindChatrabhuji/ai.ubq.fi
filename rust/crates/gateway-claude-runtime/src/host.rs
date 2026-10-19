//! Fixed owner capabilities; none accepts a URL, caller proof, environment name or refresh token.
use crate::{
    quota::{QuotaObservation, QuotaState},
    response::Classification,
};
use gateway_admin_runtime::{
    claude::{AccountBinding, Bootstrap},
    claude_generation::{StateGeneration, StateSnapshot},
};
use gateway_auth::AuthHost;
use gateway_catalog_runtime::ProviderBinding;
use gateway_core::{
    GatewayError, js_string::JsString16, model::ModelId, source_json::SourceJson,
    source_serialization as source, state::RevisionCheck,
};
use gateway_providers::{Headers, PrepareOptions};
use gateway_schema::{catalog::ProviderCatalog, selection::ProviderSelection};
use serde::Serialize;
use std::{cmp::Ordering, future::Future};

#[derive(Clone, Debug, Default)]
pub struct PoolConfig {
    /// Existing explicitly injected bootstrap sources. No environment lookup occurs here.
    pub bootstrap: Bootstrap,
    pub allowed_key_ids: Vec<String>,
    pub generation: StateGeneration,
    /// Existing verified principal/native-session replay partition.
    pub replay_scope: String,
}

#[derive(Clone)]
pub struct SelectedAccount {
    pub(crate) binding: AccountBinding,
    pub(crate) checks: Vec<RevisionCheck>,
    pub(crate) catalog_identity: String,
    pub(crate) generation: StateSnapshot,
    pub(crate) options: PrepareOptions,
    pub(crate) replay_scope: String,
    pub(crate) key_id: String,
    pub(crate) model: ModelId,
    pub(crate) raw: SourceJson,
    pub(crate) disabled: bool,
    pub(crate) native_checks: Vec<RevisionCheck>,
    pub(crate) workspace_continuation: bool,
}
impl std::fmt::Debug for SelectedAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SelectedAccount")
            .field("account_id", &self.binding.account_id)
            .field("cohort_id", &self.binding.account_cohort_id)
            .field("catalog_identity", &self.catalog_identity)
            .finish_non_exhaustive()
    }
}
impl SelectedAccount {
    pub fn binding(&self) -> &AccountBinding {
        &self.binding
    }
    pub fn checks(&self) -> &[RevisionCheck] {
        &self.checks
    }
    pub fn catalog_identity(&self) -> &str {
        &self.catalog_identity
    }
    pub fn replay_scope(&self) -> &str {
        &self.replay_scope
    }
    /// Copy proven capabilities only. Actual auth must be derived by the host
    /// from this same immutable binding at its preparation/header boundary.
    /// This method grants no credential validity or transport authorization.
    pub fn prepare_options(&self, mut base: PrepareOptions) -> PrepareOptions {
        base.supports_native_effort = self.options.supports_native_effort;
        base.supports_disabled_thinking = self.options.supports_disabled_thinking;
        base.native_reasoning_efforts = self.options.native_reasoning_efforts.clone();
        base
    }
}

#[derive(Clone, Debug)]
pub enum PoolSelection {
    NotApplicable,
    Eligible(Box<SelectedAccount>),
    Unavailable,
    /// Source HTTP constructor rejection: fixed 500 text/plain UTF8 response,
    /// exact body "Internal Server Error". This carries no quota or paid meaning.
    InternalServerError,
    Refused {
        status: u16,
        headers: Headers,
        body: SourceJson,
    },
}

pub struct SelectionInput<'a> {
    pub key_id: &'a str,
    pub model: &'a ModelId,
    pub raw: &'a SourceJson,
    /// The same server-owned source selection used for validation and the m14 plan.
    pub selection: Option<&'a ProviderSelection>,
}

#[derive(Debug)]
pub struct ResponseObservation {
    pub status: u16,
    pub headers: Headers,
    pub provider_request_id: Option<String>,
    /// Capture at actual header receipt, BEFORE awaiting any clone/body work.
    pub observed_at_ms: i64,
}

/// An actual response head, not a client-constructible proof or a second refusal writer.
/// No Clone/Deserialize: finalization consumes it exactly once.
pub struct AcceptedHead {
    pub(crate) selected: SelectedAccount,
    pub(crate) model: ModelId,
    pub(crate) response: ResponseObservation,
    pub(crate) classification: Classification,
    pub(crate) observation: Option<QuotaObservation>,
    pub(crate) success_recorded: bool,
}

#[derive(Debug)]
pub enum OutcomeDecision {
    Preserve,
    Retry,
    Paid,
    /// Same original m14 admission/transport claim, with an owner-CAS-verified new workspace.
    WorkspaceContinuation(Box<SelectedAccount>),
}

#[derive(Clone, Debug, Serialize)]
pub struct AcceptedObservation {
    pub v: u32,
    pub observation_id: String,
    pub account_id: String,
    pub account_cohort_id: String,
    pub credential_kind: String,
    pub workspace_id: Option<JsString16>,
    pub source_observed_at_ms: Option<i64>,
    pub sampled_at_ms: i64,
    pub response_status: Option<u16>,
    pub state: String,
    pub observation: QuotaObservation,
}
impl AcceptedObservation {
    /// Source JSON number spelling also supports m19's integer timestamp DTO.
    pub fn source_value(&self) -> SourceJson {
        SourceJson::from_serializable(self)
            .and_then(|value| source::canonical(&value))
            .expect("finite source Claude observation")
    }
}

#[derive(Clone, Debug)]
pub struct HealthObservation {
    pub identity: String,
    pub event: String,
    pub status: Option<u16>,
    pub provider_request_id: Option<String>,
    pub checks: Vec<RevisionCheck>,
}

#[derive(Clone, Debug)]
pub struct WorkspaceResponse {
    pub status: u16,
    pub body: String,
}

pub trait ClaudePoolHost: AuthHost {
    /// The real source localeCompare primitive, not byte ordering.
    fn compare_principals(
        &self,
        left: &JsString16,
        right: &JsString16,
    ) -> Result<Ordering, GatewayError>;
    /// Source Date.parse for Retry-After's date form; invalid text returns None.
    fn parse_retry_after_date(&self, raw: &str) -> Option<i64>;
    /// Bind the existing source/native owner. Missing enforcement is explicit unavailability.
    fn credential_checks(
        &self,
        binding: &AccountBinding,
    ) -> impl Future<Output = Result<Vec<RevisionCheck>, GatewayError>>;
    /// Reuse m11's fixed Claude discovery with this exact m20 binding identity.
    fn catalog(
        &self,
        binding: &AccountBinding,
        identity: &ProviderBinding,
    ) -> impl Future<Output = Result<ProviderCatalog, GatewayError>>;
    /// Fixed GET https://api.anthropic.com/v1/organizations/workspaces, manual redirects,
    /// current account headers and cancellation. Parsing and owner update remain Rust below.
    fn workspace_list(
        &self,
        binding: &AccountBinding,
    ) -> impl Future<Output = Result<WorkspaceResponse, GatewayError>>;
    fn accepted_observation(
        &self,
        event: &AcceptedObservation,
    ) -> impl Future<Output = Result<(), GatewayError>>;
    fn health_observation(
        &self,
        event: &HealthObservation,
    ) -> impl Future<Output = Result<(), GatewayError>>;
}

pub(crate) struct CommittedOutcome {
    pub state: QuotaState,
}
