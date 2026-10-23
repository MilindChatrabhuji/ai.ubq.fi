use crate::{seed::source_key, source_catalog::Collator, store::Store};
use gateway_auth::{AuthPrincipal, crypto::Secret};
use gateway_authority::{
    keys,
    paid::{PaidReservation, PaidUsage},
    routing::CohortProof,
};
use gateway_core::{GatewayError, state::AuthorityStore};
use gateway_providers::{AuthMaterial, PrepareOptions};
use gateway_routing_runtime::types::{
    ClaudeOutcome, ClaudeSelection, CodexRecovery, CredentialFence, CredentialRequest,
    PublishedCredential, RefreshOutcome, ResponseHead, RoutingHost, WaitOutcome, direct_credential,
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
#[derive(Clone)]
pub struct Host {
    pub claude_internal_error: bool,
    pub claude_effective: Arc<Mutex<Vec<Option<gateway_core::js_string::JsString16>>>>,
    pub store: Store,
    pub cancelled: Arc<AtomicBool>,
    pub cancel_wait_after_ms: Option<i64>,
    pub claude: Option<PublishedCredential>,
    pub claude_refused: Option<(
        u16,
        BTreeMap<String, String>,
        gateway_core::source_json::SourceJson,
    )>,
    pub claude_outcomes: Arc<Mutex<VecDeque<ClaudeOutcome>>>,
    pub claude_heads: Arc<AtomicU64>,
    pub consumed_heads: Arc<Mutex<BTreeSet<u64>>>,
    pub claude_evidence: Arc<Mutex<Vec<Option<Vec<u16>>>>>,
}
impl Host {
    pub fn new(store: &Store) -> Self {
        Self {
            claude_internal_error: false,
            claude_effective: Arc::new(Mutex::new(Vec::new())),
            store: store.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
            cancel_wait_after_ms: None,
            claude: None,
            claude_refused: None,
            claude_outcomes: Arc::new(Mutex::new(VecDeque::new())),
            claude_heads: Arc::new(AtomicU64::new(0)),
            consumed_heads: Arc::new(Mutex::new(BTreeSet::new())),
            claude_evidence: Arc::new(Mutex::new(Vec::new())),
        }
    }
}
impl RoutingHost for Host {
    type ClaudeHead = u64;
    fn source_string_collator(&self) -> Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        Arc::new(Collator::captured())
    }
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    fn cancellation_error(&self) -> GatewayError {
        GatewayError::new(499, "fixture cancelled", Some("fixture_cancelled"))
    }
    async fn wait(&self, milliseconds: i64) -> WaitOutcome {
        let elapsed_ms = self.cancel_wait_after_ms.unwrap_or(milliseconds);
        self.store.advance(elapsed_ms);
        let result = if self.cancel_wait_after_ms.is_some() {
            self.cancelled.store(true, Ordering::SeqCst);
            Err(self.cancellation_error())
        } else {
            Ok(())
        };
        WaitOutcome { elapsed_ms, result }
    }
    async fn credential(
        &self,
        input: CredentialRequest,
    ) -> Result<PublishedCredential, GatewayError> {
        if let Some(admission) = input.codex {
            let source = self.store.read(&source_key()).await?.unwrap();
            Ok(PublishedCredential::Scalar {
                material: AuthMaterial {
                    secret: "fixture-access-only".into(),
                    account_id: Some("fixture-account".into()),
                    ..Default::default()
                },
                fence: CredentialFence::Codex {
                    admission,
                    source_key: source_key(),
                    source_revision: source.revision,
                    native_generation: "fixture-generation".into(),
                },
                options: Box::new(PrepareOptions::default()),
            })
        } else if matches!(
            input.provider,
            gateway_core::provider::UpstreamProvider::Surplus
                | gateway_core::provider::UpstreamProvider::Metered
        ) {
            let config = self.store.value(keys::paid_control_config());
            let mut published =
                direct_credential(input.provider, &Secret::new("fixture-paid-secret".into()));
            let PublishedCredential::Scalar { fence, .. } = &mut published else {
                unreachable!()
            };
            *fence = CredentialFence::Paid {
                provider: input.provider,
                owner_id: config["owner_id"].as_str().unwrap_or_default().into(),
                owner_epoch: config["owner_epoch"].as_str().unwrap_or_default().into(),
                configuration_generation: config["generation"].as_str().unwrap_or_default().into(),
                credential_binding: config[if input.provider
                    == gateway_core::provider::UpstreamProvider::Surplus
                {
                    "surplus_binding"
                } else {
                    "openlux_binding"
                }]
                .as_str()
                .unwrap_or_default()
                .into(),
            };
            Ok(published)
        } else {
            Ok(direct_credential(
                input.provider,
                &Secret::new("fixture-secret".into()),
            ))
        }
    }
    async fn ensure_credential_current(
        &self,
        fence: &CredentialFence,
        _principal: &AuthPrincipal,
        _model: &gateway_core::model::ModelId,
    ) -> Result<(), GatewayError> {
        if let CredentialFence::Codex {
            source_key,
            source_revision,
            ..
        } = fence
            && self
                .store
                .read(source_key)
                .await?
                .as_ref()
                .map(|r| &r.revision)
                != Some(source_revision)
        {
            return Err(GatewayError::unavailable(
                "fixture publication changed",
                "fixture_generation_changed",
            ));
        }
        Ok(())
    }
    async fn refresh_codex(
        &self,
        _fence: &CredentialFence,
    ) -> Result<RefreshOutcome, GatewayError> {
        Ok(RefreshOutcome::Unavailable)
    }
    async fn select_claude(
        &self,
        _principal: &AuthPrincipal,
        _model: &gateway_core::model::ModelId,
        _raw: &gateway_core::source_json::SourceJson,
        effective_effort: Option<&gateway_core::js_string::JsString16>,
    ) -> Result<ClaudeSelection, GatewayError> {
        self.claude_effective
            .lock()
            .unwrap()
            .push(effective_effort.cloned());
        if self.claude_internal_error {
            return Ok(ClaudeSelection::InternalServerError);
        }
        if let Some((status, headers, body)) = &self.claude_refused {
            return Ok(ClaudeSelection::Refused {
                status: *status,
                headers: headers.clone(),
                body: body.clone(),
            });
        }
        Ok(self
            .claude
            .as_ref()
            .map(|value| ClaudeSelection::Eligible(Box::new(value.clone())))
            .unwrap_or(ClaudeSelection::NotApplicable))
    }
    async fn observe_claude_response(
        &self,
        _fence: &CredentialFence,
        _model: &gateway_core::model::ModelId,
        _response: ResponseHead,
    ) -> Result<Self::ClaudeHead, GatewayError> {
        Ok(self.claude_heads.fetch_add(1, Ordering::SeqCst))
    }
    async fn finish_claude_response(
        &self,
        head: Self::ClaudeHead,
        evidence: gateway_core::claude::ClaudeErrorEvidence,
    ) -> Result<ClaudeOutcome, GatewayError> {
        if !self.consumed_heads.lock().unwrap().insert(head) {
            return Err(GatewayError::unavailable(
                "Duplicate fixture head",
                "fixture_head_replayed",
            ));
        }
        self.claude_evidence
            .lock()
            .unwrap()
            .push(evidence.prefix().map(<[u16]>::to_vec));
        Ok(self
            .claude_outcomes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(ClaudeOutcome::Preserve))
    }
    async fn recover_codex(
        &self,
        _proof: &CohortProof,
        _model: &gateway_core::model::ModelId,
    ) -> Result<CodexRecovery, GatewayError> {
        Ok(CodexRecovery::Declined)
    }
    async fn lookup_paid(
        &self,
        _reservation: &PaidReservation,
    ) -> Result<Option<PaidUsage>, GatewayError> {
        Ok(None)
    }
}
