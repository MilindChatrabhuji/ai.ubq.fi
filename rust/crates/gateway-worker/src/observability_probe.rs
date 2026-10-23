//! Fixed free provider GETs with one actual request cancellation and absolute deadline.
use super::{RequestHost, unavailable};
use crate::transport::outbound::{
    Cancellation, Deadline, PinnedDestination, send_constructed, send_http,
};
use gateway_admin_runtime::claude;
use gateway_auth::provider_credentials::{self as codex, CodexSourceAccount};
use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use gateway_observability::{
    host_types::*,
    types::{HealthEvent, HealthTarget},
};
use std::collections::BTreeMap;
use worker::{Method, Response};

pub(super) struct Reply {
    pub response: Response,
    cancellation: Cancellation,
    _deadline: Deadline,
}
impl Drop for Reply {
    fn drop(&mut self) {
        self.cancellation.abort()
    }
}
fn probe(
    provider: ProbeProvider,
    status: u16,
    content_type: Option<String>,
    error: Option<&str>,
) -> ActiveProbe {
    ActiveProbe {
        provider,
        status,
        content_type,
        error: error.map(JsString16::from_utf8),
    }
}
fn timeout(host: &RequestHost, deadline: i64) -> bool {
    crate::storage::now_ms().map_or(true, |at| at >= deadline)
        || host.platform.cancellation.signal().aborted()
}
fn codex_headers(account: &CodexSourceAccount) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("Accept".into(), "application/json".into()),
        (
            "Authorization".into(),
            format!("Bearer {}", account.access_token.expose()),
        ),
        ("ChatGPT-Account-ID".into(), account.account_id.clone()),
        ("originator".into(), "codex_cli_rs".into()),
        (
            "User-Agent".into(),
            "codex_cli_rs/0.100.0 (ai.ubq.fi)".into(),
        ),
    ])
}
impl RequestHost {
    pub(super) async fn fixed_get(
        &self,
        url: &str,
        headers: &BTreeMap<String, String>,
        deadline: i64,
    ) -> Result<Reply, GatewayError> {
        let remaining = deadline.saturating_sub(crate::storage::now_ms()?);
        if remaining <= 0 {
            return Err(unavailable("Observational GET deadline expired."));
        }
        if self.platform.cancellation.signal().aborted() {
            return Err(GatewayError::unavailable(
                "Observational request cancelled.",
                "observability_request_cancelled",
            ));
        }
        let cancellation = self.platform.cancellation.child()?;
        let guard = cancellation.set_timeout_ms(
            i32::try_from(remaining)
                .map_err(|_| unavailable("Observational GET deadline is invalid."))?,
        )?;
        let target = PinnedDestination::new(url)?;
        let response = send_http(
            &target,
            Method::Get,
            headers,
            &[],
            &cancellation,
            || async { Ok(()) },
        )
        .await
        .map_err(|failure| {
            if self.platform.cancellation.signal().aborted() {
                GatewayError::unavailable(
                    "Observational request cancelled.",
                    "observability_request_cancelled",
                )
            } else {
                failure.error
            }
        })?;
        Ok(Reply {
            response,
            cancellation,
            _deadline: guard,
        })
    }
    async fn fixed_claude_get(
        &self,
        account: &claude::AccountBinding,
        deadline: i64,
    ) -> Result<Reply, GatewayError> {
        // Same bounded observational phase as fixed_get; no account/credential refetch.
        let remaining = deadline.saturating_sub(crate::storage::now_ms()?);
        if remaining <= 0 {
            return Err(unavailable("Observational GET deadline expired."));
        }
        if self.platform.cancellation.signal().aborted() {
            return Err(GatewayError::unavailable(
                "Observational request cancelled.",
                "observability_request_cancelled",
            ));
        }
        let cancellation = self.platform.cancellation.child()?;
        let guard = cancellation.set_timeout_ms(
            i32::try_from(remaining)
                .map_err(|_| unavailable("Observational GET deadline is invalid."))?,
        )?;
        let request = crate::claude_host::models_probe_request(account)?;
        let response = send_constructed(request, &cancellation, || async { Ok(()) })
            .await
            .map_err(|failure| {
                if self.platform.cancellation.signal().aborted() {
                    GatewayError::unavailable(
                        "Observational request cancelled.",
                        "observability_request_cancelled",
                    )
                } else {
                    failure.error
                }
            })?;
        Ok(Reply {
            response,
            cancellation,
            _deadline: guard,
        })
    }

    pub(super) async fn monitoring_get(
        &self,
        deadline: i64,
    ) -> Result<serde_json::Value, GatewayError> {
        let credential = super::inventory::monitoring_key(&self.platform.env)
            .ok_or_else(|| unavailable("Metered monitoring credentials are not configured."))?;
        let headers = BTreeMap::from([
            ("Accept".into(), "application/json".into()),
            ("Authorization".into(), format!("Bearer {credential}")),
        ]);
        let mut reply = self
            .fixed_get(
                "https://api.openlux.ai/api/usage/token/",
                &headers,
                deadline,
            )
            .await?;
        if !(200..300).contains(&reply.response.status_code())
            || !reply
                .response
                .headers()
                .get("content-type")
                .ok()
                .flatten()
                .is_some_and(|t| t.to_ascii_lowercase().contains("application/json"))
        {
            return Err(unavailable(
                "Metered account API returned an unsuccessful or non-JSON response.",
            ));
        }
        // The source adds no application byte limit. The actual Worker memory/deadline remain in force.
        let bytes = reply
            .response
            .bytes()
            .await
            .map_err(|_| unavailable("Metered account API returned an unreadable body."))?;
        let value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("Metered account API returned invalid JSON."))?;
        gateway_observability::metered::token_usage_state(&value, crate::storage::now_ms()?)?;
        Ok(value)
    }
    async fn codex_probe(&self, accounts: &[CodexSourceAccount], deadline: i64) -> ActiveProbe {
        if accounts.is_empty() {
            return probe(
                ProbeProvider::ChatgptCodex,
                503,
                None,
                Some("No Codex auth configured (CODEX_AUTH_JSON_B64 or KV entry missing)."),
            );
        }
        let mut last = None;
        let mut contributed = false;
        for account in accounts {
            let base = crate::host::setting(&self.platform.env, "CODEX_BASE_URL")
                .unwrap_or_else(|| "https://chatgpt.com/backend-api/codex".into());
            let base = base.trim().trim_end_matches('/');
            let target = worker::Url::parse(&format!("{base}/models"));
            let Ok(mut target) = target else {
                return probe(
                    ProbeProvider::ChatgptCodex,
                    503,
                    None,
                    Some("Codex models probe failed."),
                );
            };
            if base.ends_with("/codex") {
                target
                    .query_pairs_mut()
                    .append_pair("client_version", "0.100.0");
            }
            let result = self
                .fixed_get(target.as_str(), &codex_headers(account), deadline)
                .await;
            let mut reply = match result {
                Ok(reply) => reply,
                Err(_) => {
                    last = Some(probe(
                        ProbeProvider::ChatgptCodex,
                        503,
                        None,
                        Some(if timeout(self, deadline) {
                            "Codex models probe timed out."
                        } else {
                            "Codex models probe failed."
                        }),
                    ));
                    continue;
                }
            };
            let status = reply.response.status_code();
            let content_type = reply.response.headers().get("content-type").ok().flatten();
            let runtime = gateway_observability::ObservabilityRuntime::with_state(
                self.store.clone(),
                super::Host,
                super::shared_state(),
            );
            let event = if status == 401
                || (status == 403
                    && codex::codex_access_expiry_ms(&account.access_token).is_some_and(|expiry| {
                        crate::storage::now_ms().is_ok_and(|at| expiry <= at as f64)
                    })) {
                HealthEvent::AuthInvalid
            } else if status == 429 {
                HealthEvent::QuotaExhausted
            } else if status >= 500 {
                HealthEvent::UpstreamError
            } else {
                HealthEvent::Reachable
            };
            let _ = runtime
                .observe_provider(
                    HealthTarget::codex(&account.account_id),
                    event,
                    Some(status),
                    None,
                )
                .await;
            if accounts.len() == 1 {
                return probe(
                    ProbeProvider::ChatgptCodex,
                    if (200..300).contains(&status) {
                        200
                    } else if status == 401 {
                        401
                    } else {
                        503
                    },
                    content_type,
                    (!(200..300).contains(&status))
                        .then_some("Codex models probe returned an error status."),
                );
            }
            if (200..300).contains(&status) {
                let bytes = reply.response.bytes().await.ok();
                if bytes.as_deref().is_some_and(has_models_array) {
                    contributed = true;
                }
            }
            last = Some(probe(
                ProbeProvider::ChatgptCodex,
                if (200..300).contains(&status) {
                    200
                } else if status == 401 {
                    401
                } else {
                    503
                },
                content_type,
                (!(200..300).contains(&status))
                    .then_some("Codex models probe returned an error status."),
            ));
        }
        if timeout(self, deadline) {
            probe(
                ProbeProvider::ChatgptCodex,
                503,
                None,
                Some("Codex models probe timed out."),
            )
        } else if contributed {
            probe(
                ProbeProvider::ChatgptCodex,
                200,
                Some("application/json".into()),
                None,
            )
        } else {
            last.unwrap_or_else(|| {
                probe(
                    ProbeProvider::ChatgptCodex,
                    503,
                    None,
                    Some("Codex models probe failed."),
                )
            })
        }
    }
    async fn metered_probe(&self, deadline: i64) -> Option<ActiveProbe> {
        super::inventory::monitoring_key(&self.platform.env)?;
        Some(match self.monitoring_get(deadline).await {
            Ok(_) => probe(
                ProbeProvider::MeteredQuota,
                200,
                Some("application/json".into()),
                None,
            ),
            Err(_) => probe(
                ProbeProvider::MeteredQuota,
                503,
                None,
                Some(if timeout(self, deadline) {
                    "Metered quota probe timed out."
                } else {
                    "Metered quota probe failed."
                }),
            ),
        })
    }
    async fn claude_probe(
        &self,
        deadline: i64,
    ) -> Result<(Option<ActiveProbe>, Option<SourceJson>), GatewayError> {
        let at = crate::storage::now_ms()?;
        let Some(roster) = claude::read_roster(&self.store, at).await? else {
            return Ok((None, None));
        };
        let Some(account) = claude::active_binding(&roster.roster).cloned() else {
            return Ok((None, None));
        };
        #[derive(serde::Serialize)]
        struct Workspace<'a> {
            id: Option<&'a JsString16>,
            name: Option<&'a JsString16>,
            source: Option<&'a str>,
            pinned_by_env: bool,
            account_id: &'a str,
            account_cohort_id: &'a str,
        }
        let workspace = Some(SourceJson::from_serializable(&Workspace {
            id: account.workspace.as_ref().map(|w| &w.id),
            name: account.workspace.as_ref().and_then(|w| w.name.as_ref()),
            source: account.workspace.as_ref().map(|w| w.source.as_str()),
            pinned_by_env: crate::host::provider_secret(
                &self.platform.env,
                "CLAUDE_CODE_WORKSPACE_ID",
            )
            .is_some(),
            account_id: &account.account_id,
            account_cohort_id: &account.account_cohort_id,
        })?);
        let result = async {
            let mut reply = self.fixed_claude_get(&account, deadline).await?;
            let status = reply.response.status_code();
            let content_type = reply.response.headers().get("content-type").ok().flatten();
            if (200..300).contains(&status) {
                return Ok(probe(
                    ProbeProvider::ClaudeSubscription,
                    200,
                    content_type,
                    None,
                ));
            }
            let bytes = reply.response.bytes().await.unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes);
            let trimmed = text.trim_matches(gateway_schema::util::js_whitespace);
            let error = if trimmed.is_empty() {
                JsString16::from_utf8("Claude models probe returned an error status.")
            } else {
                JsString16::from_units(trimmed.encode_utf16().take(240).collect())
            };
            Ok::<_, GatewayError>(ActiveProbe {
                provider: ProbeProvider::ClaudeSubscription,
                status: if status == 401 { 401 } else { 503 },
                content_type,
                error: Some(error),
            })
        }
        .await;
        let observed = result.unwrap_or_else(|_| {
            probe(
                ProbeProvider::ClaudeSubscription,
                503,
                None,
                Some(if timeout(self, deadline) {
                    "Claude models probe timed out."
                } else {
                    "Claude models probe failed."
                }),
            )
        });
        if claude::current_binding(&self.store, &account, crate::storage::now_ms()?)
            .await?
            .is_none()
        {
            return Ok((
                Some(probe(
                    ProbeProvider::ClaudeSubscription,
                    503,
                    None,
                    Some("Claude account changed during the models probe."),
                )),
                None,
            ));
        }
        Ok((Some(observed), workspace))
    }
    pub(super) async fn upstream_health(
        &self,
        deadline: i64,
    ) -> Result<UpstreamHealthEvidence, GatewayError> {
        let (auth, accounts) = match self.codex_accounts().await {
            Ok(value) => value,
            Err(_) => {
                return Ok(UpstreamHealthEvidence {
                    auth: None,
                    codex: probe(
                        ProbeProvider::ChatgptCodex,
                        503,
                        None,
                        Some("Codex auth metadata could not be read."),
                    ),
                    metered_quota: None,
                    claude_subscription: None,
                    claude_workspace: None,
                });
            }
        };
        let (codex, (metered, claude)) = futures_util::future::join(
            self.codex_probe(&accounts, deadline),
            futures_util::future::join(self.metered_probe(deadline), self.claude_probe(deadline)),
        )
        .await;
        let (claude_subscription, claude_workspace) = claude.unwrap_or((None, None));
        Ok(UpstreamHealthEvidence {
            auth: Some(auth),
            codex,
            metered_quota: metered,
            claude_subscription,
            claude_workspace,
        })
    }
    pub(super) async fn capacity_accounts(&self) -> Result<Vec<CapacityAccountRef>, GatewayError> {
        let (_, accounts) = self.codex_accounts().await?;
        Ok(accounts
            .into_iter()
            .enumerate()
            .take(2)
            .map(|(i, a)| {
                let payload = a
                    .access_token
                    .expose()
                    .split('.')
                    .nth(1)
                    .and_then(|p| {
                        codex::decode_source_base64(&p.replace('-', "+").replace('_', "/"))
                    })
                    .and_then(|p| serde_json::from_slice::<serde_json::Value>(&p).ok());
                let normalize = |v: Option<&serde_json::Value>| {
                    v.and_then(serde_json::Value::as_str)
                        .map(|v| v.trim_matches(gateway_schema::util::js_whitespace))
                        .filter(|v| {
                            !v.is_empty()
                                && v.encode_utf16().count() <= 320
                                && v.contains('@')
                                && !v.chars().any(|c| c < ' ' || c == '\u{7f}')
                        })
                        .map(str::to_owned)
                };
                let label = payload.as_ref().and_then(|p| {
                    normalize(p["https://api.openai.com/profile"].get("email"))
                        .or_else(|| normalize(p.get("email")))
                });
                CapacityAccountRef {
                    slot: (i + 1) as u8,
                    account_id: a.account_id,
                    label,
                }
            })
            .collect())
    }
    pub(super) async fn capacity_probe(
        &self,
        account: &CapacityAccountRef,
        fence: &gateway_authority::capacity::CodexCapacityObservationFence,
        deadline: i64,
    ) -> Result<CapacityProbe, GatewayError> {
        let expected = fence
            .fetch_bindings()
            .find(|b| b.source_slot() == account.slot && b.account_id() == account.account_id)
            .ok_or_else(|| unavailable("Capacity GET is outside its original source fence."))?;
        let current = codex::read_codex_source_pool(&self.store, crate::storage::now_ms()?)
            .await?
            .ok_or_else(|| unavailable("Capacity source pool is unavailable."))?;
        let current = current
            .pool
            .accounts
            .get(usize::from(account.slot - 1))
            .ok_or_else(|| unavailable("Capacity source slot changed."))?;
        let identity = current.identity();
        if current.account_id != expected.account_id()
            || identity.credential_version != *expected.credential_version()
            || identity.native_generation_hash != expected.native_generation_hash()
            || current.native_owner.as_ref() != expected.native_owner()
        {
            return Err(unavailable(
                "Capacity GET no longer matches its credential owner.",
            ));
        }
        let base = crate::host::setting(&self.platform.env, "CODEX_BASE_URL")
            .unwrap_or_else(|| "https://chatgpt.com/backend-api/codex".into());
        let url = worker::Url::parse(&base)
            .and_then(|u| u.join("/backend-api/wham/usage"))
            .map_err(|_| unavailable("Capacity source URL is invalid."))?;
        let mut headers = codex_headers(current);
        headers.remove("originator");
        let mut reply = match self.fixed_get(url.as_str(), &headers, deadline).await {
            Ok(reply) => reply,
            Err(error)
                if error.envelope.error.code.as_deref()
                    == Some("observability_request_cancelled") =>
            {
                return Err(error);
            }
            Err(_) => return Ok(CapacityProbe::Unreachable),
        };
        let status = reply.response.status_code();
        let json = if (200..300).contains(&status) {
            reply
                .response
                .bytes()
                .await
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        } else {
            None
        };
        Ok(CapacityProbe::Http { status, json })
    }
}

fn has_models_array(bytes: &[u8]) -> bool {
    SourceJson::parse_bytes(bytes)
        .ok()
        .and_then(|document| source::member(&document, "models"))
        .and_then(|models| source::array(&models))
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::has_models_array;

    #[test]
    fn models_probe_retains_source_units_and_original_shape_predicate() {
        assert!(has_models_array(br#"{"models":[{"id":"model-\ud800"}]}"#));
        assert!(has_models_array(br#"{"models":null,"models":[]}"#));
        assert!(!has_models_array(br#"{"models":[],"models":null}"#));
        assert!(!has_models_array(br#"{"models":{}}"#));
        assert!(!has_models_array(b"not JSON"));
        assert!(!has_models_array(b"{\"models\":[\"\xff\"]}"));
    }
}
