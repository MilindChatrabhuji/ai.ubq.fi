#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdminOperation {
    PasskeyUsersList,
    PasskeyUsersUpdate,
    CodexAuthUpload,
    CodexResetGet,
    CodexResetUpdate,
    CodexResetConsume,
    CodexOverageGet,
    CodexOverageUpdate,
    CodexResetShadowList,
    CacheExperimentGet,
    CacheExperimentSet,
    CodexModelsGet,
    CodexModelsSet,
    ModelsWhitelistGet,
    ModelsWhitelistSet,
    ModelsCatalog,
    ModelsRefresh,
    PromptsPurge,
    KvMigrationImport,
    KvMigrationValidate,
    ReplayCaptures,
    SentinelIncidents,
    SupervisorSessions,
    SupervisorOutput,
    SupervisorBrief,
    Errors,
    DefaultsGet,
    DefaultsSet,
    DebugGet,
    DebugSet,
    DebugDelete,
    Providers,
    ProviderSelectionGet,
    ProviderSelectionSet,
    Capacity,
    CapacityObservations,
    CapacityRollups,
    ClaudeAccessGet,
    ClaudeAccessSet,
    ClaudeAccountSelect,
    ClaudeAuthGet,
    ClaudeAuthSet,
    ClaudeAuthDelete,
    ClaudeQuotaClear,
    QuotaProjection,
    QuotaProjectionBackfill,
    PromptCacheAnalytics,
    ApiKeysCreate,
    ApiKeysList,
    ApiKeyChanges,
    ApiKeysUpdate,
    ApiKeysRevoke,
    ApiKeysUnrevoke,
    ApiKeysDelete,
    ApiKeyPaidFallbacks,
    CodexRecheck,
    KernelUsageGet,
    KernelUsageSet,
    KernelUsageDelete,
    KernelQueue,
    KernelPublicKeysGet,
    KernelPublicKeysCreate,
    KernelPublicKeysDelete,
    HealthProviders,
    HealthUpstream,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminRoute {
    pub operation: AdminOperation,
    pub parameter: Option<String>,
}

pub fn match_route(method: &str, path: &str) -> Option<AdminRoute> {
    use AdminOperation::*;
    let operation = match (method, path) {
        ("GET", "/admin/passkey-users") => PasskeyUsersList,
        ("PATCH", "/admin/passkey-users") => PasskeyUsersUpdate,
        ("POST", "/admin/codex/auth") => CodexAuthUpload,
        ("GET", "/admin/providers/codex/banked-resets") => CodexResetGet,
        ("PATCH", "/admin/providers/codex/banked-resets") => CodexResetUpdate,
        ("POST", "/admin/providers/codex/banked-resets/consume") => CodexResetConsume,
        ("GET", "/admin/providers/codex/overage-usage") => CodexOverageGet,
        ("PATCH", "/admin/providers/codex/overage-usage") => CodexOverageUpdate,
        ("GET", "/admin/providers/codex/banked-resets/shadow-decisions") => CodexResetShadowList,
        ("GET", "/admin/providers/codex/cache-scope-experiment") => CacheExperimentGet,
        ("POST", "/admin/providers/codex/cache-scope-experiment") => CacheExperimentSet,
        ("GET", "/admin/codex/models") => CodexModelsGet,
        ("POST", "/admin/codex/models") => CodexModelsSet,
        ("GET", "/admin/models/whitelist") => ModelsWhitelistGet,
        ("POST", "/admin/models/whitelist") => ModelsWhitelistSet,
        ("GET", "/admin/models/catalog") => ModelsCatalog,
        ("POST", "/admin/models/refresh") => ModelsRefresh,
        ("POST", "/admin/codex/prompts/purge") => PromptsPurge,
        ("POST", "/admin/kv-migration/import") => KvMigrationImport,
        ("GET", "/admin/kv-migration/validate") => KvMigrationValidate,
        ("GET", "/admin/sentinel/replay-captures") => ReplayCaptures,
        ("GET", "/admin/sentinel/incidents") => SentinelIncidents,
        ("GET", "/admin/codex/supervisor/sessions") => SupervisorSessions,
        ("GET", "/admin/codex/supervisor/output") => SupervisorOutput,
        ("POST", "/admin/codex/supervisor/brief") => SupervisorBrief,
        ("GET", "/admin/errors") => Errors,
        ("GET", "/admin/defaults") => DefaultsGet,
        ("POST", "/admin/defaults") => DefaultsSet,
        ("GET", "/admin/debug/routing") => DebugGet,
        ("POST", "/admin/debug/routing") => DebugSet,
        ("DELETE", "/admin/debug/routing") => DebugDelete,
        ("GET", "/admin/providers") => Providers,
        ("GET", "/admin/providers/selection") => ProviderSelectionGet,
        ("POST", "/admin/providers/selection") => ProviderSelectionSet,
        ("GET", "/admin/providers/capacity") => Capacity,
        ("POST", "/admin/providers/capacity/observations") => CapacityObservations,
        ("GET", "/admin/providers/capacity/rollups") => CapacityRollups,
        ("GET", "/admin/providers/claude-code/access") => ClaudeAccessGet,
        ("POST", "/admin/providers/claude-code/access") => ClaudeAccessSet,
        ("POST", "/admin/providers/claude-code/accounts/active") => ClaudeAccountSelect,
        ("GET", "/admin/providers/claude-code/auth") => ClaudeAuthGet,
        ("POST", "/admin/providers/claude-code/auth") => ClaudeAuthSet,
        ("DELETE", "/admin/providers/claude-code/auth") => ClaudeAuthDelete,
        ("POST", "/admin/providers/claude-code/quota/clear") => ClaudeQuotaClear,
        ("GET", "/admin/providers/quota-projection") => QuotaProjection,
        ("POST", "/admin/providers/quota-projection/backfill") => QuotaProjectionBackfill,
        ("GET", "/admin/prompt-cache-analytics") => PromptCacheAnalytics,
        ("POST", "/admin/api-keys") => ApiKeysCreate,
        ("GET", "/admin/api-keys") => ApiKeysList,
        ("GET", "/admin/api-keys/changes") => ApiKeyChanges,
        ("PATCH", "/admin/api-keys") => ApiKeysUpdate,
        ("POST", "/admin/api-keys/revoke") => ApiKeysRevoke,
        ("POST", "/admin/api-keys/unrevoke") => ApiKeysUnrevoke,
        ("DELETE", "/admin/api-keys") => ApiKeysDelete,
        ("GET", "/admin/kernel-usage") => KernelUsageGet,
        ("POST", "/admin/kernel-usage") => KernelUsageSet,
        ("DELETE", "/admin/kernel-usage") => KernelUsageDelete,
        ("GET", "/admin/kernel-policy-queue") => KernelQueue,
        ("GET", "/admin/kernel-pubkeys") => KernelPublicKeysGet,
        ("POST", "/admin/kernel-pubkeys") => KernelPublicKeysCreate,
        ("DELETE", "/admin/kernel-pubkeys") => KernelPublicKeysDelete,
        ("GET", "/health/providers") => HealthProviders,
        ("GET", "/health/upstream") => HealthUpstream,
        _ => {
            if method == "POST"
                && let Some(slot) = path
                    .strip_prefix("/admin/providers/codex/")
                    .and_then(|rest| rest.strip_suffix("/recheck"))
                && !slot.is_empty()
                && slot.bytes().all(|b| b.is_ascii_digit())
            {
                return Some(AdminRoute {
                    operation: CodexRecheck,
                    parameter: Some(slot.into()),
                });
            }
            if method == "GET"
                && let Some(id) = path
                    .strip_prefix("/admin/api-keys/")
                    .and_then(|rest| rest.strip_suffix("/paid-fallbacks"))
                && !id.is_empty()
                && !id.contains('/')
            {
                return Some(AdminRoute {
                    operation: ApiKeyPaidFallbacks,
                    parameter: Some(id.into()),
                });
            }
            return None;
        }
    };
    Some(AdminRoute {
        operation,
        parameter: None,
    })
}

impl AdminOperation {
    pub fn capability(self) -> &'static str {
        use AdminOperation::*;
        match self {
            CodexAuthUpload => "codex_credential_import",
            CodexResetGet | CodexResetUpdate | CodexResetConsume | CodexOverageGet
            | CodexOverageUpdate | CodexResetShadowList | CodexRecheck => {
                "codex_capacity_authority"
            }
            CacheExperimentGet | CacheExperimentSet | CodexModelsGet | CodexModelsSet
            | ModelsWhitelistGet | ModelsWhitelistSet | ModelsCatalog | ModelsRefresh
            | ProviderSelectionGet | ProviderSelectionSet => "model_catalog",
            ClaudeAccessGet | ClaudeAccessSet | ClaudeAccountSelect | ClaudeAuthGet
            | ClaudeAuthSet | ClaudeAuthDelete | ClaudeQuotaClear => "claude_account_authority",
            SupervisorSessions | SupervisorOutput | SupervisorBrief => "native_supervisor",
            KvMigrationImport | KvMigrationValidate => "portable_state_migration",
            ReplayCaptures | SentinelIncidents => "encrypted_failure_capture",
            Capacity
            | CapacityObservations
            | CapacityRollups
            | Providers
            | QuotaProjection
            | QuotaProjectionBackfill
            | HealthProviders
            | HealthUpstream => "provider_capacity",
            PromptCacheAnalytics | PromptsPurge => "prompt_analytics",
            ApiKeyPaidFallbacks => "paid_ledger",
            KernelUsageGet
            | KernelUsageSet
            | KernelUsageDelete
            | KernelQueue
            | KernelPublicKeysGet
            | KernelPublicKeysCreate
            | KernelPublicKeysDelete => "kernel_authority",
            _ => "admin_state",
        }
    }
}
