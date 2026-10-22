//! Source administrative runtime over the common authority. External effects are finite injected capabilities.
pub mod brief;
pub mod capabilities;
pub mod claude;
pub mod claude_access;
pub mod claude_generation;
mod defaults;
mod errors;
mod kernel;
mod kernel_data;
mod paid;
pub mod parse;
mod state;
mod store;

use capabilities::*;
use gateway_admin::{
    AdminHost, AdminInput, AdminOperation, PaidKeyFields, source_input as source_body,
};
use gateway_auth::{AuthHost, AuthResponse, invalid};
use gateway_core::{GatewayError, query::QueryStore, state::RevisionCheck};
use serde_json::{Value, json};

#[derive(Clone, Debug, Default)]
pub struct RuntimeConfig {
    /// Explicit existing source configuration passed at bootstrap, never discovered by this crate.
    pub claude_allowed_key_ids: Vec<String>,
}

pub struct AdminRuntime<'a, S, H, C> {
    pub store: &'a S,
    pub host: &'a H,
    pub capabilities: &'a C,
    pub config: &'a RuntimeConfig,
}

impl<S: QueryStore, H: AuthHost, C: RuntimeCapabilities> AdminHost for AdminRuntime<'_, S, H, C> {
    async fn execute(
        &self,
        operation: AdminOperation,
        input: AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        // Defense in depth for callers outside AdminService. There is deliberately no super-admin tier.
        if !input.actor.is_admin {
            return Err(gateway_auth::unauthorized());
        }
        if !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&input.now_ms) {
            return Err(invalid("Admin request clock is invalid"));
        }
        let context = Context {
            request_id: input.request_id.clone(),
            now_ms: input.now_ms,
        };
        use AdminOperation::*;
        match operation {
            DefaultsGet | DefaultsSet => self.defaults(operation, &input).await,
            DebugGet | DebugSet | DebugDelete => self.debug(operation, &input).await,
            ProviderSelectionGet | ProviderSelectionSet => self.selection(operation, &input).await,
            ClaudeAccessGet | ClaudeAccessSet => self.claude_access(operation, &input).await,
            KernelUsageGet | KernelUsageSet | KernelUsageDelete | KernelQueue => {
                self.kernel(operation, &input).await
            }
            Errors => self.errors(&input).await,
            PromptsPurge => self.purge_prompts(input.now_ms).await,
            CodexModelsGet => {
                self.capabilities
                    .catalog(CatalogRequest::CodexModelsGet, context)
                    .await
            }
            CodexModelsSet => {
                self.capabilities
                    .catalog(
                        CatalogRequest::CodexModelsSet {
                            document: input.body,
                        },
                        context,
                    )
                    .await
            }
            ModelsWhitelistGet => {
                self.capabilities
                    .catalog(CatalogRequest::WhitelistGet, context)
                    .await
            }
            ModelsWhitelistSet => {
                self.capabilities
                    .catalog(
                        CatalogRequest::WhitelistSet {
                            document: input.body,
                        },
                        context,
                    )
                    .await
            }
            ModelsCatalog => {
                self.capabilities
                    .catalog(CatalogRequest::Catalog, context)
                    .await
            }
            ModelsRefresh => {
                self.capabilities
                    .catalog(CatalogRequest::Refresh, context)
                    .await
            }
            CodexAuthUpload => {
                self.capabilities
                    .codex(
                        CodexRequest::ImportCredentials {
                            document: input.body,
                        },
                        context,
                    )
                    .await
            }
            CodexResetGet => {
                self.capabilities
                    .codex(CodexRequest::ResetSettings, context)
                    .await
            }
            CodexResetConsume => {
                let fields = gateway_core::source_serialization::entries(&input.body)
                    .ok_or_else(|| invalid("Only account_id_hash is accepted."))?;
                let hash = source_body::member(&input.body, "account_id_hash")
                    .as_ref()
                    .and_then(source_body::text)
                    .filter(|hash| {
                        hash.as_units().len() == 64
                            && hash
                                .as_units()
                                .iter()
                                .all(|unit| (48..=57).contains(unit) || (97..=102).contains(unit))
                    })
                    .filter(|_| fields.len() == 1)
                    .ok_or_else(|| invalid("Only account_id_hash is accepted."))?;
                let account_id_hash = String::from_utf16(hash.as_units())
                    .expect("closed lowercase ASCII account hash");
                self.capabilities
                    .codex(CodexRequest::ConsumeReset { account_id_hash }, context)
                    .await
            }
            CodexResetUpdate | CodexOverageUpdate => {
                let name = if operation == CodexResetUpdate {
                    "enabled"
                } else {
                    "allow"
                };
                if source_body::member(&input.body, "account_id_hash")
                    .as_ref()
                    .and_then(source_body::text)
                    .is_none()
                    || source_body::member(&input.body, name)
                        .as_ref()
                        .and_then(source_body::boolean)
                        .is_none()
                {
                    return Err(invalid(&format!(
                        "account_id_hash and boolean {name} are required"
                    )));
                }
                let request = if operation == CodexResetUpdate {
                    CodexRequest::SetResetSettings {
                        document: input.body,
                    }
                } else {
                    CodexRequest::SetOverageSettings {
                        document: input.body,
                    }
                };
                self.capabilities.codex(request, context).await
            }
            CodexOverageGet => {
                self.capabilities
                    .codex(CodexRequest::OverageSettings, context)
                    .await
            }
            CodexResetShadowList => {
                self.capabilities
                    .codex(CodexRequest::ShadowDecisions, context)
                    .await
            }
            CodexRecheck => {
                let slot = input
                    .parameter
                    .as_deref()
                    .and_then(|s| s.parse::<u8>().ok())
                    .filter(|s| (1..=2).contains(s))
                    .ok_or_else(|| {
                        GatewayError::new(404, "Codex account slot not found", Some("not_found"))
                    })?;
                self.capabilities
                    .codex(CodexRequest::Recheck { slot }, context)
                    .await
            }
            CacheExperimentGet => {
                self.capabilities
                    .codex(CodexRequest::CacheExperimentBaseline, context)
                    .await
            }
            CacheExperimentSet => {
                let body: String = input.body.deserialize().map_err(|_| {
                    GatewayError::unavailable(
                        "Scope experiment requires its original raw body",
                        "admin_raw_body_unavailable",
                    )
                })?;
                if !body
                    .trim_matches(gateway_schema::util::js_whitespace)
                    .is_empty()
                {
                    return Err(invalid(
                        "Prompt-cache scope experiment does not accept request fields",
                    ));
                }
                self.capabilities
                    .codex(CodexRequest::RunCacheExperiment, context)
                    .await
            }
            Providers => {
                self.capabilities
                    .provider(ProviderRequest::Inventory, context)
                    .await
            }
            HealthProviders => {
                self.capabilities
                    .provider(ProviderRequest::PassiveHealth, context)
                    .await
            }
            HealthUpstream => {
                self.capabilities
                    .provider(ProviderRequest::UpstreamHealth, context)
                    .await
            }
            Capacity => {
                self.capabilities
                    .provider(
                        ProviderRequest::Capacity {
                            live: parse::first(&input.query, "refresh") == Some("live"),
                        },
                        context,
                    )
                    .await
            }
            CapacityObservations => {
                self.capabilities
                    .provider(
                        ProviderRequest::Observations {
                            document: input.body,
                        },
                        context,
                    )
                    .await
            }
            CapacityRollups => {
                self.capabilities
                    .provider(ProviderRequest::Rollups { query: input.query }, context)
                    .await
            }
            ClaudeAuthGet => {
                self.capabilities
                    .claude(ClaudeRequest::State, context)
                    .await
            }
            ClaudeAuthSet => {
                self.capabilities
                    .claude(
                        ClaudeRequest::SetCredential(parse::claude_source(&input.body)?),
                        context,
                    )
                    .await
            }
            ClaudeAuthDelete => {
                self.capabilities
                    .claude(
                        ClaudeRequest::DeleteAccount {
                            account_id: parse::first(&input.query, "account_id")
                                .map(gateway_core::js_string::JsString16::from_utf8),
                        },
                        context,
                    )
                    .await
            }
            ClaudeAccountSelect => {
                let id = source_body::member(&input.body, "account_id")
                    .as_ref()
                    .and_then(source_body::text)
                    .ok_or_else(|| invalid("account_id is required"))?;
                self.capabilities
                    .claude(ClaudeRequest::SelectAccount { account_id: id }, context)
                    .await
            }
            ClaudeQuotaClear => {
                let account_value = source_body::member(&input.body, "account_id");
                if account_value
                    .as_ref()
                    .is_some_and(|value| source_body::text(value).is_none())
                {
                    return Err(invalid("account_id must be a string"));
                }
                let account_id = account_value.as_ref().and_then(source_body::text);
                let cohort_id = source_body::member(&input.body, "account_cohort_id");
                // Account lookup and the targeted-cohort check belong to the
                // actual owner in this source order; no early UUID/scalar gate.
                self.capabilities
                    .claude(
                        ClaudeRequest::ClearQuota {
                            account_id,
                            cohort_id,
                        },
                        context,
                    )
                    .await
            }
            ReplayCaptures | SentinelIncidents => {
                self.capabilities
                    .capture(
                        parse::capture(&input, operation == SentinelIncidents)?,
                        context,
                    )
                    .await
            }
            KvMigrationImport => {
                self.capabilities
                    .migration(MigrationRequest::Import(parse::migration(&input)?), context)
                    .await
            }
            KvMigrationValidate => {
                self.capabilities
                    .migration(MigrationRequest::Validate, context)
                    .await
            }
            PromptCacheAnalytics => {
                self.capabilities
                    .analytics(
                        AnalyticsRequest::PromptCache {
                            group_by: parse::prompt_groups(&input)?,
                        },
                        context,
                    )
                    .await
            }
            QuotaProjection => {
                let window = parse_int_prefix(parse::first(&input.query, "window_days"))
                    .filter(|n| [7, 30, 90].contains(n))
                    .unwrap_or(30);
                let balance = parse::first(&input.query, "balance_window_days")
                    .and_then(|s| {
                        s.trim_matches(gateway_schema::util::js_whitespace)
                            .parse::<f64>()
                            .ok()
                    })
                    .filter(|n| [7.0, 30.0, 90.0, 365.0].contains(n))
                    .unwrap_or(7.0) as u32;
                self.capabilities
                    .analytics(
                        AnalyticsRequest::QuotaProjection {
                            window_days: window as u32,
                            balance_window_days: balance,
                        },
                        context,
                    )
                    .await
            }
            QuotaProjectionBackfill => {
                let limit = parse_int_prefix(parse::first(&input.query, "limit"))
                    .filter(|n| *n > 0)
                    .unwrap_or(5000)
                    .min(10000) as u32;
                self.capabilities
                    .analytics(AnalyticsRequest::QuotaProjectionBackfill { limit }, context)
                    .await
            }
            ApiKeyPaidFallbacks => {
                let id = input
                    .parameter
                    .as_deref()
                    .map(gateway_schema::util::js_trim)
                    .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 200)
                    .ok_or_else(|| invalid("Invalid API key id"))?;
                if store::read(
                    self.store,
                    &gateway_auth::api_keys::id_key(id),
                    input.now_ms,
                )
                .await?
                .is_none()
                {
                    return Err(GatewayError::new(404, "Not found", Some("not_found")));
                }
                let limit = parse::bounded_positive(parse::first(&input.query, "limit"), 20, 100)?;
                self.capabilities
                    .analytics(
                        AnalyticsRequest::PaidHistory {
                            key_id: id.into(),
                            limit,
                        },
                        context,
                    )
                    .await
            }
            SupervisorSessions => {
                self.native_response(NativeRequest::SupervisorSessions, context)
                    .await
            }
            SupervisorOutput | SupervisorBrief => {
                let (source_id, thread_id) = if operation == SupervisorOutput {
                    (
                        parse::first(&input.query, "source")
                            .unwrap_or("")
                            .trim_matches(gateway_schema::util::js_whitespace)
                            .to_owned(),
                        parse::first(&input.query, "id")
                            .unwrap_or("")
                            .trim_matches(gateway_schema::util::js_whitespace)
                            .to_owned(),
                    )
                } else {
                    (
                        source_body::member(&input.body, "source")
                            .as_ref()
                            .and_then(source_body::text)
                            .map(|value| source_body::trim(&value))
                            .and_then(|value| value.try_utf8().ok())
                            .unwrap_or_default(),
                        source_body::member(&input.body, "id")
                            .as_ref()
                            .and_then(source_body::text)
                            .map(|value| source_body::trim(&value))
                            .and_then(|value| value.try_utf8().ok())
                            .unwrap_or_default(),
                    )
                };
                if source_id.is_empty()
                    || source_id.len() > 32
                    || !source_id.as_bytes()[0].is_ascii_lowercase()
                        && !source_id.as_bytes()[0].is_ascii_digit()
                    || !source_id
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
                {
                    return Err(invalid("Invalid supervisor source id"));
                }
                if thread_id.is_empty()
                    || thread_id.len() > 200
                    || !thread_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
                {
                    return Err(invalid("Invalid thread id"));
                }
                if operation == SupervisorBrief {
                    return self
                        .supervisor_brief_response(
                            SupervisorBriefTarget {
                                source_id,
                                thread_id,
                            },
                            context,
                        )
                        .await;
                }
                let request = {
                    let cursor: String = parse::first(&input.query, "cursor")
                        .unwrap_or("")
                        .trim_matches(gateway_schema::util::js_whitespace)
                        .chars()
                        .take(240)
                        .collect();
                    NativeRequest::SupervisorOutput {
                        source_id,
                        thread_id,
                        cursor: (!cursor.is_empty()).then_some(cursor),
                    }
                };
                self.native_response(request, context).await
            }
            // AdminService owns these operations; never duplicate key/passkey/public-key writers.
            _ => Err(gateway_admin::missing_capability(operation)),
        }
    }
    async fn prepare_key_deletion(&self, key_id: &str) -> Result<Vec<RevisionCheck>, GatewayError> {
        self.prepare_deletion(key_id).await
    }
    async fn finish_key_deletion(
        &self,
        key_id: &str,
        prepared_checks: &[RevisionCheck],
    ) -> Result<(), GatewayError> {
        self.finish_deletion(key_id, prepared_checks).await
    }
    async fn abort_key_deletion(
        &self,
        key_id: &str,
        prepared_checks: &[RevisionCheck],
    ) -> Result<(), GatewayError> {
        self.abort_deletion(key_id, prepared_checks).await
    }
    async fn paid_key_policy(
        &self,
        body: &gateway_core::source_json::SourceJson,
    ) -> Result<PaidKeyFields, GatewayError> {
        self.paid_policy(body).await
    }
}

fn parse_int_prefix(value: Option<&str>) -> Option<i64> {
    let value = value?.trim_start_matches(gateway_schema::util::js_whitespace);
    let end = value
        .char_indices()
        .take_while(|(i, c)| c.is_ascii_digit() || *i == 0 && (*c == '-' || *c == '+'))
        .last()
        .map(|(i, c)| i + c.len_utf8())?;
    value[..end].parse().ok()
}

impl<S: QueryStore, H: AuthHost, C: RuntimeCapabilities> AdminRuntime<'_, S, H, C> {
    async fn supervisor_brief_response(
        &self,
        target: SupervisorBriefTarget,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        let response = self
            .capabilities
            .supervisor_brief(target.clone(), context)
            .await?;
        if response.status >= 400 && response.stream.is_none() {
            return Ok(response);
        }
        let body = response.body.as_json().ok_or_else(|| {
            GatewayError::unavailable(
                "Supervisor brief capability did not return the final public source response",
                "supervisor_brief_invalid_response",
            )
        })?;
        let fields = [
            "sourceId",
            "threadId",
            "machine",
            "about",
            "status",
            "model",
            "effort",
            "state",
            "sampledAtMs",
            "generatedAtMs",
            "transcript",
        ];
        let transcript_fields = ["turns", "bytes", "truncated", "redactions", "available"];
        let nullable = |name| body.get(name).is_some_and(|v| v.is_null() || v.is_string());
        let transcript = body.get("transcript");
        let valid = response.status == 200
            && response.stream.is_none()
            && body
                .as_object()
                .is_some_and(|v| v.keys().all(|key| fields.contains(&key.as_str())))
            && body.get("sourceId").and_then(Value::as_str) == Some(&target.source_id)
            && body.get("threadId").and_then(Value::as_str) == Some(&target.thread_id)
            && ["machine", "about", "status"].into_iter().all(|name| {
                body.get(name)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !gateway_schema::util::js_trim(s).is_empty())
            })
            && ["model", "effort", "state"].into_iter().all(nullable)
            && ["sampledAtMs", "generatedAtMs"].into_iter().all(|name| {
                body.get(name)
                    .and_then(Value::as_i64)
                    .is_some_and(|n| (0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&n))
            })
            && transcript.and_then(Value::as_object).is_some_and(|v| {
                v.keys()
                    .all(|key| transcript_fields.contains(&key.as_str()))
            })
            && ["turns", "bytes", "redactions"].into_iter().all(|name| {
                transcript
                    .and_then(|v| v.get(name))
                    .and_then(Value::as_u64)
                    .is_some()
            })
            && ["truncated", "available"].into_iter().all(|name| {
                transcript
                    .and_then(|v| v.get(name))
                    .is_some_and(Value::is_boolean)
            })
            && (transcript.and_then(|v| v.get("available")) != Some(&Value::Bool(false))
                || body["model"].is_null() && body["effort"].is_null());
        if !valid {
            return Err(GatewayError::unavailable(
                "Supervisor brief capability did not return the final public source response",
                "supervisor_brief_invalid_response",
            ));
        }
        Ok(response)
    }
    async fn native_response(
        &self,
        request: NativeRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        use gateway_auth::native::{NATIVE_WIRE_VERSION, NativeRpcEnvelope, NativeRpcResponse};
        let envelope = NativeRpcEnvelope {
            v: NATIVE_WIRE_VERSION,
            request: request.clone(),
        };
        let response = self.capabilities.native(request, context).await?;
        // The carrier validates its actual wire version. This shared validator also
        // prevents an internal capability from substituting JSON or another follow target.
        NativeRpcResponse {
            v: NATIVE_WIRE_VERSION,
            status: response.status,
            body: response.body.as_json().cloned().ok_or_else(|| {
                GatewayError::unavailable(
                    "Native protocol response is invalid",
                    "native_protocol_invalid",
                )
            })?,
            stream: response.stream.clone(),
        }
        .validate_for(&envelope)?;
        Ok(response)
    }
    async fn purge_prompts(&self, now: i64) -> Result<AuthResponse, GatewayError> {
        use gateway_auth::store::{check, commit};
        use gateway_core::state::RecordMutation;
        let key = store::key(json!(["uos_ai", "codex_instructions"]));
        let row = self.store.read(&key).await?;
        let mut deleted = 0;
        if store::value(row.as_ref(), now)?.is_some() {
            if !commit(
                self.store,
                vec![check(&key, row.as_ref())],
                vec![RecordMutation::Delete { key }],
            )
            .await?
            {
                return Err(gateway_auth::conflict(
                    "Prompt instructions changed concurrently; retry",
                ));
            }
            deleted += 1;
        }
        for entry in store::scan(
            self.store,
            store::key(json!(["uos_ai", "codex_instructions_chunk"])),
            false,
            now,
        )
        .await?
        {
            if !commit(
                self.store,
                vec![check(&entry.key, Some(&entry.record))],
                vec![RecordMutation::Delete { key: entry.key }],
            )
            .await?
            {
                return Err(gateway_auth::conflict(
                    "Prompt instructions changed concurrently; retry",
                ));
            }
            deleted += 1;
        }
        Ok(AuthResponse::json(200, json!({"deleted":deleted})))
    }
}
