// Source-derived exact prefix tables from dc6be2c3 src/cache/kv-migration-base.ts.
pub(super) const DURABLE_PREFIXES: &[(&str, &[&str])] = &[
    ("api_keys_id", &["ubq_ai", "api_keys", "id"]),
    ("api_keys_hash", &["ubq_ai", "api_keys", "hash"]),
    ("api_keys_usage", &["ubq_ai", "api_keys", "usage"]),
    (
        "api_keys_usage_daily",
        &["ubq_ai", "api_keys", "usage_daily"],
    ),
    (
        "api_keys_request_log",
        &["ubq_ai", "api_keys", "request_log"],
    ),
    ("api_key_usage_v2", &["uos_ai", "api_key_usage", "v2"]),
    (
        "api_key_usage_v3_windows",
        &["uos_ai", "api_key_usage", "v3", "window"],
    ),
    (
        "api_key_usage_v3_requests",
        &["uos_ai", "api_key_usage", "v3", "request"],
    ),
    (
        "paid_fallback_ledger",
        &["uos_ai", "paid_fallback", "ledger"],
    ),
    (
        "paid_fallback_v3_windows",
        &["uos_ai", "paid_fallback", "v3", "window"],
    ),
    (
        "paid_fallback_v3_requests",
        &["uos_ai", "paid_fallback", "v3", "request"],
    ),
    (
        "paid_fallback_v3_usage_rollups",
        &["uos_ai", "paid_fallback", "v3", "usage_rollup"],
    ),
    (
        "paid_fallback_v3_ledger_stats",
        &["uos_ai", "paid_fallback", "v3", "ledger_stats"],
    ),
    (
        "metered_quota_balance_history",
        &["uos_ai", "metered_quota", "v1", "balance_history"],
    ),
    (
        "provider_capacity_rollups",
        &["uos_ai", "provider_capacity", "v1", "rollup"],
    ),
    (
        "paid_fallback_v3_pending",
        &["uos_ai", "paid_fallback", "v3", "pending"],
    ),
    (
        "paid_fallback_v3_reconciliation_leases",
        &["uos_ai", "paid_fallback", "v3", "reconciliation_lease"],
    ),
    (
        "paid_fallback_v3_deletion_guards",
        &["uos_ai", "paid_fallback", "v3", "deletion_guard"],
    ),
    ("runtime_config_v2", &["uos_ai", "runtime_config", "v2"]),
    ("kernel_usage", &["ubq_ai", "kernel_auth", "usage"]),
    (
        "kernel_usage_daily",
        &["ubq_ai", "kernel_auth", "usage_daily"],
    ),
    (
        "kernel_quota_v2_repo_policy",
        &["uos_ai", "kernel_quota", "v2", "repo_policy"],
    ),
    (
        "kernel_quota_v2_org_policy",
        &["uos_ai", "kernel_quota", "v2", "org_policy"],
    ),
    (
        "kernel_quota_v2_repo_window",
        &["uos_ai", "kernel_quota", "v2", "repo_window"],
    ),
    (
        "kernel_quota_v2_org_window",
        &["uos_ai", "kernel_quota", "v2", "org_window"],
    ),
    (
        "kernel_quota_v2_repo_reservation",
        &["uos_ai", "kernel_quota", "v2", "repo_reservation"],
    ),
    (
        "kernel_quota_v2_org_reservation",
        &["uos_ai", "kernel_quota", "v2", "org_reservation"],
    ),
    ("kernel_limits_legacy", &["ubq_ai", "kernel_auth", "limits"]),
    ("kernel_org_usage", &["ubq_ai", "kernel_auth", "org_usage"]),
    (
        "kernel_org_usage_daily",
        &["ubq_ai", "kernel_auth", "org_usage_daily"],
    ),
    (
        "kernel_org_limits_legacy",
        &["ubq_ai", "kernel_auth", "org_limits"],
    ),
    ("defaults", &["default"]),
    ("kernel_pubkeys", &["uos_ai", "kernel_pubkeys"]),
    ("voyage_api_key", &["uos_ai", "voyage_api_key"]),
    ("codex_prompts", &["uos_ai", "codex_instructions"]),
    (
        "codex_prompts_chunks",
        &["uos_ai", "codex_instructions_chunk"],
    ),
    ("codex_reset_usage", &["uos_ai", "codex_reset_usage"]),
    ("kernel_policy_queue", &["uos_ai", "kernel_policy_queue"]),
    ("migrations", &["uos_ai", "migrations"]),
    (
        "embeddings_idempotency_responses",
        &["embeddings", "idempotency", "v1", "response"],
    ),
    (
        "embeddings_idempotency",
        &["embeddings", "idempotency", "v1"],
    ),
    ("passkey_users", &["uos_ai", "auth", "users"]),
    ("passkey_handles", &["uos_ai", "auth", "handles"]),
    ("passkey_credentials", &["uos_ai", "auth", "credentials"]),
    ("agent_messages", &["agent_messages"]),
];

pub(super) const CODEX_BOOTSTRAP_PREFIXES: &[(&str, &[&str])] = &[
    ("codex_auth", &["ubq_ai", "codex_auth"]),
    ("codex_models", &["ubq_ai", "codex_models"]),
];

pub(super) const LEGACY_DURABLE_PREFIXES: &[(&str, &[&str])] = &[
    ("legacy_model_key_config", &["key", "config"]),
    ("legacy_model_key_health", &["key", "health"]),
];

pub(super) const TRANSIENT_PREFIXES: &[(&str, &[&str])] = &[
    ("passkey_challenges", &["uos_ai", "auth", "challenges"]),
    ("passkey_sessions", &["uos_ai", "auth", "sessions"]),
    ("embeddings_rate", &["embeddings", "v1", "rate"]),
    ("embeddings_jobs", &["embeddings", "jobs"]),
    (
        "paid_fallback_v3_backfill_cursor",
        &["uos_ai", "paid_fallback", "v3", "rollup_backfill_cursor"],
    ),
    (
        "paid_fallback_v3_backfill_window_cursor",
        &[
            "uos_ai",
            "paid_fallback",
            "v3",
            "rollup_backfill_window_cursor",
        ],
    ),
];

pub(super) const EMBEDDINGS_CACHE_PREFIXES: &[(&str, &[&str])] = &[
    (
        "embeddings_cache_index",
        &["embeddings", "v2", "cache_index"],
    ),
    (
        "embeddings_cache_index_by_hash",
        &["embeddings", "v2", "cache_index_by_hash"],
    ),
    ("embeddings_cache_values", &["embeddings", "v2"]),
];
