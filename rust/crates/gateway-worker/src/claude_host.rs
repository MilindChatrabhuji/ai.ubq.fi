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
use gateway_core::{GatewayError, claude::ClaudeErrorEvidence};
use gateway_routing_runtime::{
    ClaudeOutcome, ClaudeSelection, CredentialFence, PublishedCredential, ResponseHead,
};
use gateway_schema::selection::ProviderSelection;
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};

thread_local! {
    static GENERATION: StateGeneration = StateGeneration::default();
}

/// Share this data-only counter with successful credential/workspace admin writes.
pub fn generation() -> StateGeneration {
    GENERATION.with(Clone::clone)
}

struct RequestState {
    principal: String,
    key_id: String,
    model: String,
    raw: Value,
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
        model: &str,
    ) -> Result<(Rc<RequestState>, SelectedAccount), GatewayError> {
        let request = self.request()?;
        if request.model != model {
            return Err(invalid("Claude model changed within the request."));
        }
        let selected = request
            .selected
            .borrow()
            .clone()
            .ok_or_else(|| invalid("The request has no selected Claude account."))?;
        if &credential(&selected).fence != fence {
            return Err(invalid(
                "Claude credential fence belongs to another attempt.",
            ));
        }
        Ok((request, selected))
    }
    pub async fn select(
        &self,
        principal: &AuthPrincipal,
        model: &str,
        raw: &Value,
    ) -> Result<ClaudeSelection, GatewayError> {
        let AuthMethod::KvApiKey { key_id, .. } = &principal.method else {
            return Ok(ClaudeSelection::NotApplicable);
        };
        if !gateway_providers::anthropic::is_claude(model) {
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
            &crate::admin_host::compare_labels,
        )
        .await?;
        if !access
            .policy
            .allowed_key_ids
            .iter()
            .any(|allowed| allowed == key_id)
        {
            return Ok(ClaudeSelection::NotApplicable);
        }
        let principal_id = crate::lifecycle::principal_id(principal);
        let existing = self.state.borrow().clone();
        let request = match existing {
            Some(request) => {
                if request.principal != principal_id
                    || request.key_id != *key_id
                    || request.model != model
                    || &request.raw != raw
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
                    model: model.into(),
                    raw: raw.clone(),
                    session: ClaudePoolSession::new(config),
                    selected: RefCell::default(),
                });
                // Bootstrap can await; another callback must not replace a session
                // already established by this request while that read was pending.
                let chosen = self.state.borrow_mut().get_or_insert(request).clone();
                if chosen.principal != principal_id
                    || chosen.key_id != *key_id
                    || chosen.model != model
                    || &chosen.raw != raw
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
    pub async fn ensure_current(
        &self,
        fence: &CredentialFence,
        principal: &AuthPrincipal,
        model: &str,
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
        model: &str,
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

fn credential(selected: &SelectedAccount) -> PublishedCredential {
    let account = selected.binding();
    PublishedCredential {
        material: selected.auth_material(),
        options: selected.prepare_options(Default::default()),
        fence: CredentialFence::Claude {
            account_id: account.account_id.clone(),
            cohort_id: account.account_cohort_id.clone(),
            credential_fingerprint: account.credential_fingerprint.clone(),
            evidence_generation: account.evidence_generation.clone(),
            workspace_id: account
                .workspace
                .as_ref()
                .map(|workspace| workspace.id.clone()),
            checks: selected.checks().iter().map(Into::into).collect(),
        },
    }
}
fn invalid(message: &str) -> GatewayError {
    GatewayError::new(400, message, Some("claude_code_request_invalid"))
}

pub use catalog::{Publication, fetch_catalog, publication};
