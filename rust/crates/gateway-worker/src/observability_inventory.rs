//! Passive provider metadata over the same request-owned authority; never refreshes credentials.
use super::RequestHost;
use gateway_admin_runtime::capabilities::Context;
use gateway_admin_runtime::{claude, claude_access};
use gateway_auth::{
    crypto::sha256_hex,
    provider_credentials::{self as codex, CodexSourceAccount},
};
use gateway_core::{
    GatewayError,
    source_json::SourceJson,
    state::{AuthorityStore, RevisionCheck},
};
use gateway_observability::{
    host_types::*,
    types::{HealthProvider, HealthTarget},
};
use gateway_schema::selection::ProviderSelection;
use serde_json::json;
use std::collections::BTreeSet;

fn stamp(value: f64) -> Option<i64> {
    (value.is_finite() && value.abs() <= gateway_core::identity::MAX_SAFE_INTEGER as f64)
        .then(|| value.trunc() as i64)
}
pub(super) fn monitoring_key(env: &worker::Env) -> Option<String> {
    crate::host::provider_secret(env, "METERED_API_KEY")
        .filter(|s| !s.chars().any(gateway_schema::util::js_whitespace))
}
impl RequestHost {
    pub(super) async fn codex_accounts(
        &self,
    ) -> Result<(CodexAuthMetadata, Vec<CodexSourceAccount>), GatewayError> {
        let at = crate::storage::now_ms()?;
        let snapshot = codex::read_codex_source_pool(&self.store, at).await?;
        let (source, updated, accounts) = if let Some(snapshot) = snapshot {
            (
                CredentialSource::Kv,
                stamp(snapshot.pool.updated_at_ms),
                snapshot.pool.accounts,
            )
        } else if let Some(encoded) =
            crate::host::setting(&self.platform.env, "CODEX_AUTH_JSON_B64")
        {
            match codex::parse_codex_auth_binding(&encoded, at) {
                Ok(account) => (CredentialSource::Env, None, vec![account]),
                Err(_) => (CredentialSource::None, None, Vec::new()),
            }
        } else {
            (CredentialSource::None, None, Vec::new())
        };
        let metadata = accounts
            .iter()
            .enumerate()
            .map(|(index, account)| CodexAuthAccount {
                account_id: account.account_id.clone(),
                slot: (index + 1) as u8,
                updated_at_ms: if source == CredentialSource::Env {
                    None
                } else {
                    stamp(account.updated_at_ms)
                },
                access_token_exp_ms: codex::codex_access_expiry_ms(&account.access_token)
                    .and_then(stamp),
                refresh_sha256: Some(sha256_hex(account.refresh_token.expose().as_bytes())),
                native_owner_codex_home: account
                    .native_owner
                    .as_ref()
                    .map(|v| v.codex_home.clone()),
            })
            .collect::<Vec<_>>();
        Ok((
            CodexAuthMetadata {
                source,
                updated_at_ms: updated,
                access_token_exp_ms: metadata.iter().filter_map(|a| a.access_token_exp_ms).min(),
                accounts: metadata,
            },
            accounts,
        ))
    }
    pub(super) async fn inventory(
        &self,
        context: &Context,
    ) -> Result<ProviderInventory, GatewayError> {
        if context.request_id != self.request_id {
            return Err(super::unavailable(
                "Administrative provider context does not match this request.",
            ));
        }
        let at = crate::storage::now_ms()?;
        let (codex, _) = self.codex_accounts().await?;
        let mut configured = BTreeSet::new();
        for (provider, key) in [
            (HealthProvider::Cerebras, "CEREBRAS_API_KEY"),
            (HealthProvider::Deepseek, "DEEPSEEK_API_KEY"),
            (HealthProvider::Lithos, "LITHOSAI_API_KEY"),
            (HealthProvider::Openrouter, "OPENROUTER_API_KEY"),
            (HealthProvider::Surplus, "SURPLUS_API_KEY"),
        ] {
            if crate::host::provider_secret(&self.platform.env, key).is_some() {
                configured.insert(provider);
            }
        }
        if crate::host::provider_secret(&self.platform.env, "METERED_API_KEY")
            .or_else(|| crate::host::provider_secret(&self.platform.env, "OPENLUX_API_KEY"))
            .is_some()
        {
            configured.insert(HealthProvider::Metered);
        }
        let selection_key = gateway_auth::store::key(json!(["uos_ai", "provider_selection", "v1"]));
        let selection = self
            .store
            .read(&selection_key)
            .await
            .ok()
            .flatten()
            .filter(|r| r.expires_at_ms.is_none_or(|t| t > at))
            .and_then(|r| r.json_value().ok().and_then(ProviderSelection::normalize));
        let roster = claude::read_roster(&self.store, at).await?;
        let mut accounts = Vec::new();
        let mut active_id = None;
        let mut active_reason = None;
        if let Some(roster) = roster {
            active_id = roster.roster.active_account_id;
            active_reason = Some(roster.roster.active_reason);
            for account in roster.roster.accounts {
                let quota_key = gateway_claude_runtime::quota_key(&account);
                let quota_row = self.store.read(&quota_key).await?;
                let quota = quota_row
                    .as_ref()
                    .map(|row| gateway_claude_runtime::quota::parse_record(row, at))
                    .transpose()?
                    .flatten()
                    .map(|mut quota| {
                        quota.pool_proofs = None;
                        SourceJson::from_serializable(&quota)
                    })
                    .transpose()?;
                let credential = CredentialMetadata {
                    kind: match account.credential.kind {
                        claude::CredentialKind::ApiKey => CredentialKind::ApiKey,
                        claude::CredentialKind::Oauth => CredentialKind::Oauth,
                    },
                    source: account.credential.source.clone(),
                    hint: account.credential.hint.clone(),
                    label: account.credential.label.clone(),
                    updated_at_ms: account.credential.updated_at_ms,
                };
                let last_error = account
                    .workspace
                    .as_ref()
                    .and_then(|w| w.last_error.as_ref())
                    .map(gateway_core::js_string::JsString16::to_source_json)
                    .transpose()?;
                let workspace = account.workspace.as_ref().map(|w| WorkspaceMetadata {
                    id: w.id.clone(),
                    name: w.name.clone(),
                    source: Some(w.source.clone()),
                    pinned_by_env: w.source == "env",
                    discovered_at_ms: w.discovered_at_ms,
                    verified_at_ms: w.verified_at_ms,
                    last_error,
                });
                accounts.push(ClaudeAccountReadback {
                    target: HealthTarget {
                        provider: HealthProvider::ClaudeCode,
                        identity: format!(
                            "{}:{}:{}",
                            account.account_id,
                            account.account_cohort_id,
                            account.evidence_generation
                        ),
                        source_checks: vec![RevisionCheck {
                            key: claude::account_store_key(),
                            expected_revision: roster.revision.clone(),
                        }],
                    },
                    account_id: account.account_id,
                    account_cohort_id: account.account_cohort_id,
                    label: account.credential.label,
                    credential,
                    workspace,
                    quota,
                });
            }
        }
        let access = match self.store.read(&claude_access::policy_key()).await? {
            Some(row) if row.expires_at_ms.is_none_or(|t| t > at) => {
                claude_access::decode_policy_record(&row, at, &|a, b| {
                    crate::source_collator::shared().compare(a, b)
                })?
                .map(|policy| ClaudeAccessReadback {
                    source: match policy.source {
                        claude_access::PolicySource::Env => "env",
                        claude_access::PolicySource::Kv => "kv",
                    }
                    .into(),
                    allowed_key_ids: policy.allowed_key_ids,
                    updated_at_ms: Some(policy.updated_at_ms),
                })
            }
            _ => {
                let ids = crate::admin_host::config(&self.platform.env).claude_allowed_key_ids;
                if ids.is_empty() {
                    None
                } else {
                    Some(ClaudeAccessReadback {
                        source: "env".into(),
                        allowed_key_ids: ids
                            .into_iter()
                            .map(|id| gateway_core::js_string::JsString16::from_utf8(&id))
                            .collect(),
                        updated_at_ms: None,
                    })
                }
            }
        };
        let monitoring = monitoring_key(&self.platform.env).is_some();
        let metered = if monitoring {
            gateway_observability::metered::cached_snapshot(&self.store, at)
                .await
                .unwrap_or(None)
        } else {
            None
        };
        let any_hop = [
            "DEEPSEEK_API_KEY",
            "OPENROUTER_API_KEY",
            "LITHOSAI_API_KEY",
            "SURPLUS_API_KEY",
            "OPENLUX_API_KEY",
            "METERED_API_KEY",
        ]
        .iter()
        .any(|name| crate::host::provider_secret(&self.platform.env, name).is_some());
        Ok(ProviderInventory {
            codex,
            configured,
            claude: ClaudeRosterReadback {
                accounts,
                active_account_id: active_id,
                active_reason,
                access,
                enabled: ProviderSelection::enabled(selection.as_ref(), "claude_code"),
            },
            metered_quota: metered,
            quota_monitoring_configured: monitoring,
            ubiquity_configured: any_hop,
        })
    }
}
