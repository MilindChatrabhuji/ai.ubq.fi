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
    pub(crate) effective_effort: Option<JsString16>,
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
    pub fn effective_effort(&self) -> Option<&JsString16> {
        self.effective_effort.as_ref()
    }
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
    /// Original request inputs and canonical model are needed by the external
    /// replay seam; they grant no credential or transport authority.
    pub fn raw_request(&self) -> &SourceJson {
        &self.raw
    }
    pub fn requested_model(&self) -> &ModelId {
        &self.model
    }
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
    pub effective_effort: Option<JsString16>,
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
        let mut fields = source::entries(
            &SourceJson::from_serializable(self).expect("finite source Claude observation"),
        )
        .expect("Claude observation is an object");
        let observation = fields
            .iter_mut()
            .find(|(name, _)| name == &JsString16::from_utf8("observation"))
            .expect("Claude observation field");
        let mut observation_fields =
            source::entries(&observation.1).expect("quota observation is an object");
        let standard = observation_fields
            .iter_mut()
            .find(|(name, _)| name == &JsString16::from_utf8("standard"))
            .expect("standard observation field");
        let mut remaining =
            source::entries(&standard.1).expect("standard observation is an object");
        let mut ordered = Vec::new();
        // Actual observeClaudeCodeQuota producer order, not arbitrary consumer input order.
        for family in crate::quota::STANDARD_FAMILIES {
            if let Some(index) = remaining
                .iter()
                .position(|(name, _)| name == &JsString16::from_utf8(family))
            {
                ordered.push(remaining.remove(index));
            }
        }
        ordered.extend(remaining);
        standard.1 = source::object_keys(ordered).expect("finite standard observation");
        observation.1 = source::object_keys(observation_fields).expect("finite quota observation");
        source::object_keys(fields)
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

#[cfg(test)]
mod producer_order_tests {
    use super::*;
    #[test]
    fn accepted_standard_families_follow_actual_source_producer_order() {
        let mut quota = QuotaObservation::empty(1_800_000_000_000);
        for (index, family) in crate::quota::STANDARD_FAMILIES.into_iter().enumerate() {
            quota.standard.insert(
                family.into(),
                crate::quota::StandardWindow {
                    limit: Some((index + 1) as f64),
                    remaining: None,
                    reset_at_ms: None,
                    observed_at_ms: quota.observed_at_ms,
                },
            );
        }
        let event = AcceptedObservation {
            v: 1,
            observation_id: "fixture-observation".into(),
            account_id: "fixture-account".into(),
            account_cohort_id: "fixture-cohort".into(),
            credential_kind: "api_key".into(),
            workspace_id: Some(JsString16::from_units(vec![119, 0xd800])),
            source_observed_at_ms: Some(1_800_000_000_000),
            sampled_at_ms: 1_800_000_000_000,
            response_status: Some(200),
            state: "available".into(),
            observation: quota,
        };
        let document = event.source_value();
        let observation = source::member(&document, "observation").unwrap();
        let standard = source::member(&observation, "standard").unwrap();
        let fields = source::entries(&standard).unwrap();
        assert_eq!(
            fields
                .iter()
                .map(|(name, _)| name.try_utf8().unwrap())
                .collect::<Vec<_>>(),
            crate::quota::STANDARD_FAMILIES
        );
        for (index, (_, value)) in fields.iter().enumerate() {
            assert_eq!(
                source::number(&source::member(value, "limit").unwrap()),
                Some((index + 1) as f64)
            );
        }
        assert_eq!(
            source::string(&source::member(&document, "workspace_id").unwrap()),
            event.workspace_id
        );
        // Serialization must not mutate the in-memory map or any consumer's source JSON.
        assert_eq!(
            event
                .observation
                .standard
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["input-tokens", "output-tokens", "requests"]
        );
    }
}
