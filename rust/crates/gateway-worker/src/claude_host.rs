//! Request-owned Claude selection and actual response receipts over the source runtime.
mod admin;
mod catalog;
mod platform;
pub use admin::admin;

use crate::{authority::RemoteAuthorityStore, host::PlatformHost};
use gateway_admin_runtime::claude_generation::StateGeneration;
use gateway_auth::{AuthMethod, AuthPrincipal};
use gateway_claude_runtime::{
    ClaudePoolSession, OutcomeDecision, PoolConfig, PoolSelection, SelectedAccount, SelectionInput,
};
use gateway_core::{
    GatewayError, claude::ClaudeErrorEvidence, model::ModelId, source_json::SourceJson,
};
use gateway_providers::replay::{ReplayContext, ReplayStore, ReplayTransport};
use gateway_routing_runtime::types::{
    ClaudeOutcome, ClaudeSelection, CredentialFence, PreparedAttempt, PreparedWireRequest,
    PublishedCredential, ResponseHead,
};
use gateway_schema::selection::ProviderSelection;
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};

thread_local! {
    static GENERATION: StateGeneration = StateGeneration::default();
    /// One process-local authenticated replay store shared by Claude request lifetimes.
    static CLAUDE_REPLAY: RefCell<ReplayStore> = RefCell::new(ReplayStore::default());
}

/// Share this data-only counter with successful credential/workspace admin writes.
pub fn generation() -> StateGeneration {
    GENERATION.with(Clone::clone)
}

struct RequestState {
    principal: String,
    key_id: String,
    model: ModelId,
    raw: SourceJson,
    effective_effort: Option<gateway_core::js_string::JsString16>,
    session: ClaudePoolSession,
    selected: RefCell<Option<SelectedAccount>>,
}

#[derive(Clone)]
pub struct Binding {
    store: RemoteAuthorityStore,
    host: platform::Host,
    state: Rc<RefCell<Option<Rc<RequestState>>>>,
    owner: Rc<()>,
}

/// Private, non-Clone and non-Deserialize; a foreign request cannot finish it.
pub struct Head {
    owner: Rc<()>,
    accepted: gateway_claude_runtime::AcceptedHead,
}

impl Binding {
    pub fn new(
        store: RemoteAuthorityStore,
        platform: PlatformHost,
        context: Rc<worker::Context>,
    ) -> Self {
        Self {
            store: store.clone(),
            host: platform::Host::new(store, platform, context),
            state: Rc::default(),
            owner: Rc::new(()),
        }
    }
    fn request(&self) -> Result<Rc<RequestState>, GatewayError> {
        self.state
            .borrow()
            .clone()
            .ok_or_else(|| invalid("Claude selection has not begun for this request."))
    }
    fn selected(
        &self,
        fence: &CredentialFence,
        model: &ModelId,
    ) -> Result<(Rc<RequestState>, SelectedAccount), GatewayError> {
        let request = self.request()?;
        if &request.model != model {
            return Err(invalid("Claude model changed within the request."));
        }
        let selected = request
            .selected
            .borrow()
            .clone()
            .ok_or_else(|| invalid("The request has no selected Claude account."))?;
        if &credential_fence(&selected) != fence
            || selected.effective_effort() != request.effective_effort.as_ref()
        {
            return Err(invalid(
                "Claude credential fence belongs to another attempt.",
            ));
        }
        Ok((request, selected))
    }
    pub async fn select(
        &self,
        principal: &AuthPrincipal,
        model: &ModelId,
        raw: &SourceJson,
        effective_effort: Option<&gateway_core::js_string::JsString16>,
    ) -> Result<ClaudeSelection, GatewayError> {
        let AuthMethod::KvApiKey { key_id, .. } = &principal.method else {
            return Ok(ClaudeSelection::NotApplicable);
        };
        if !gateway_providers::anthropic::is_claude_model(model) {
            return Ok(ClaudeSelection::NotApplicable);
        }
        let selection = gateway_catalog_runtime::state::read_json(
            &self.store,
            &gateway_catalog_runtime::state::selection_key(),
        )
        .await?
        .as_ref()
        .and_then(|row| ProviderSelection::normalize(&row.value));
        if !ProviderSelection::enabled(selection.as_ref(), "claude_code") {
            return Ok(ClaudeSelection::NotApplicable);
        }
        let allowed_key_ids =
            crate::admin_host::config(&self.host.platform.env).claude_allowed_key_ids;
        let access = gateway_admin_runtime::claude_access::load_policy(
            &self.store,
            &self.host.platform,
            &allowed_key_ids,
            &|left, right| crate::source_collator::shared().compare(left, right),
        )
        .await?;
        if !access.policy.allows_scalar(key_id) {
            return Ok(ClaudeSelection::NotApplicable);
        }
        let principal_id = crate::lifecycle::principal_id(principal);
        let existing = self.state.borrow().clone();
        let request = match existing {
            Some(request) => {
                if request.principal != principal_id
                    || request.key_id != *key_id
                    || &request.model != model
                    || &request.raw != raw
                    || request.effective_effort.as_ref() != effective_effort
                {
                    return Err(invalid(
                        "Claude selection inputs changed within the request.",
                    ));
                }
                request
            }
            None => {
                let config = PoolConfig {
                    bootstrap: platform::bootstrap_for_source(&self.store, &self.host.platform)
                        .await?,
                    allowed_key_ids,
                    generation: generation(),
                    replay_scope: principal_id.clone(),
                };
                let request = Rc::new(RequestState {
                    principal: principal_id.clone(),
                    key_id: key_id.clone(),
                    model: model.clone(),
                    raw: raw.clone(),
                    effective_effort: effective_effort.cloned(),
                    session: ClaudePoolSession::new(config),
                    selected: RefCell::default(),
                });
                // Bootstrap can await; another callback must not replace a session
                // already established by this request while that read was pending.
                let chosen = self.state.borrow_mut().get_or_insert(request).clone();
                if chosen.principal != principal_id
                    || chosen.key_id != *key_id
                    || &chosen.model != model
                    || &chosen.raw != raw
                    || chosen.effective_effort.as_ref() != effective_effort
                {
                    return Err(invalid("Concurrent Claude selection inputs changed."));
                }
                chosen
            }
        };
        match request
            .session
            .select(
                &self.store,
                &self.host,
                SelectionInput {
                    key_id: &request.key_id,
                    model,
                    raw: &request.raw,
                    effective_effort: request.effective_effort.clone(),
                    selection: selection.as_ref(),
                },
            )
            .await?
        {
            PoolSelection::NotApplicable => Ok(ClaudeSelection::NotApplicable),
            PoolSelection::Unavailable => Ok(ClaudeSelection::Unavailable),
            PoolSelection::InternalServerError => Ok(ClaudeSelection::InternalServerError),
            PoolSelection::Refused {
                status,
                headers,
                body,
            } => Ok(ClaudeSelection::Refused {
                status,
                headers,
                body,
            }),
            PoolSelection::Eligible(selected) => {
                let published = credential(&selected);
                *request.selected.borrow_mut() = Some(*selected);
                Ok(ClaudeSelection::Eligible(Box::new(published)))
            }
        }
    }
    /// Physical material stays inside this same request-owned selected snapshot.
    pub(crate) fn physical_request(
        &self,
        fence: &CredentialFence,
        model: &ModelId,
        body: &gateway_providers::PreparedClaudeBody,
    ) -> Result<
        crate::transport::outbound::ConstructedRequest,
        gateway_routing_runtime::types::RoutingError,
    > {
        let (_request, selected) = self.selected(fence, model)?;
        platform::physical_request(selected.binding(), body)
            .map_err(|_| crate::inference_local_lifecycle::wrapper_error())
    }

    pub async fn ensure_current(
        &self,
        fence: &CredentialFence,
        principal: &AuthPrincipal,
        model: &ModelId,
    ) -> Result<(), GatewayError> {
        let (request, selected) = self.selected(fence, model)?;
        let AuthMethod::KvApiKey { key_id, .. } = &principal.method else {
            return Err(invalid("Claude principal changed before dispatch."));
        };
        if request.principal != crate::lifecycle::principal_id(principal)
            || request.key_id != *key_id
        {
            return Err(invalid("Claude principal changed before dispatch."));
        }
        request
            .session
            .ensure_current(
                &self.store,
                &self.host,
                &selected,
                key_id,
                model,
                &request.raw,
            )
            .await
    }
    pub async fn observe(
        &self,
        fence: &CredentialFence,
        model: &ModelId,
        response: ResponseHead,
    ) -> Result<Head, GatewayError> {
        let (request, selected) = self.selected(fence, model)?;
        let accepted = request
            .session
            .observe_response(
                &self.store,
                &self.host,
                &selected,
                gateway_claude_runtime::ResponseObservation {
                    status: response.status,
                    headers: response.headers,
                    provider_request_id: response.provider_request_id,
                    observed_at_ms: response.observed_at_ms,
                },
            )
            .await?;
        Ok(Head {
            owner: self.owner.clone(),
            accepted,
        })
    }
    pub async fn finish(
        &self,
        head: Head,
        evidence: ClaudeErrorEvidence,
    ) -> Result<ClaudeOutcome, GatewayError> {
        if !Rc::ptr_eq(&self.owner, &head.owner) {
            return Err(invalid(
                "Claude response receipt belongs to another request.",
            ));
        }
        let request = self.request()?;
        match request
            .session
            .after_outcome(&self.store, &self.host, head.accepted, evidence)
            .await?
        {
            OutcomeDecision::Preserve => Ok(ClaudeOutcome::Preserve),
            OutcomeDecision::Retry => {
                request.selected.borrow_mut().take();
                Ok(ClaudeOutcome::Retry)
            }
            OutcomeDecision::Paid => Ok(ClaudeOutcome::Paid),
            OutcomeDecision::WorkspaceContinuation(selected) => {
                let published = credential(&selected);
                *request.selected.borrow_mut() = Some(*selected);
                Ok(ClaudeOutcome::WorkspaceContinuation(Box::new(published)))
            }
        }
    }
}

fn credential_fence(selected: &SelectedAccount) -> CredentialFence {
    let account = selected.binding();
    CredentialFence::Claude {
        account_id: account.account_id.clone(),
        cohort_id: account.account_cohort_id.clone(),
        credential_fingerprint: account.credential_fingerprint.clone(),
        evidence_generation: account.evidence_generation.clone(),
        workspace_id: account
            .workspace
            .as_ref()
            .map(|workspace| workspace.id.clone()),
        checks: selected.checks().iter().map(Into::into).collect(),
    }
}
fn replay_context(selected: &SelectedAccount) -> Option<ReplayContext> {
    Some(ReplayContext {
        scope: selected.replay_scope().into(),
        provider: "claude_code".into(),
        model: selected.requested_model().as_js_string().try_utf8().ok()?,
    })
}

fn credential(selected: &SelectedAccount) -> PublishedCredential {
    let kind = platform::credential_kind(&selected.binding().credential);
    let mut options = selected.prepare_options(Default::default());
    if let Some(context) = replay_context(selected) {
        let now = crate::storage::now_ms().unwrap_or(i64::MAX);
        CLAUDE_REPLAY.with(|store| {
            store.borrow_mut().restore_prepare_options(
                &context,
                selected.raw_request(),
                &mut options,
                ReplayTransport::Messages,
                now,
            );
        });
    }
    PublishedCredential::Claude {
        fence: credential_fence(selected),
        body_options: gateway_providers::ClaudeBodyOptions {
            native_reasoning_efforts: options.native_reasoning_efforts,
            supports_disabled_thinking: options.supports_disabled_thinking,
            restored_native_messages: options.restored_native_messages,
            ..gateway_providers::ClaudeBodyOptions::new(kind)
        },
    }
}

/// Publish a completed Claude native response for the next turn in the same
/// authenticated principal/account/cohort scope. Failure remains closed.
pub(crate) fn remember_native(
    principal: &AuthPrincipal,
    attempt: &PreparedAttempt,
    output: &[Value],
    native: &Value,
    now_ms: i64,
) -> bool {
    let PreparedWireRequest::Claude(body) = &attempt.request else {
        return false;
    };
    let CredentialFence::Claude {
        account_id,
        cohort_id,
        ..
    } = &attempt.credential
    else {
        return false;
    };
    let Ok(model) = body.decode().model.as_js_string().try_utf8() else {
        return false;
    };
    let context = ReplayContext {
        scope: format!(
            "{}:{}:{}",
            crate::lifecycle::principal_id(principal),
            account_id,
            cohort_id
        ),
        provider: "claude_code".into(),
        model,
    };
    let Ok(output) = output
        .iter()
        .map(SourceJson::from_serializable)
        .collect::<Result<Vec<_>, _>>()
    else {
        return false;
    };
    let Ok(native) = SourceJson::from_serializable(native) else {
        return false;
    };
    CLAUDE_REPLAY.with(|store| {
        store.borrow_mut().remember_decoded_native(
            context,
            &output,
            native,
            ReplayTransport::Messages,
            &body.decode().tool_names,
            now_ms,
        )
    })
}
fn invalid(message: &str) -> GatewayError {
    GatewayError::new(400, message, Some("claude_code_request_invalid"))
}

/// Closed observational models target using the exact caller's read binding.
pub(crate) fn models_probe_request(
    account: &gateway_admin_runtime::claude::AccountBinding,
) -> Result<crate::transport::outbound::ConstructedRequest, GatewayError> {
    let headers = platform::headers(account, true)
        .map_err(|_| *crate::inference_local_lifecycle::wrapper_error().error)?;
    let target =
        crate::transport::outbound::PinnedDestination::new("https://api.anthropic.com/v1/models")?;
    crate::transport::outbound::construct_request(&target, worker::Method::Get, headers, &[])
        .map_err(|_| *crate::inference_local_lifecycle::wrapper_error().error)
}

pub use catalog::{fetch_catalog, publication};
