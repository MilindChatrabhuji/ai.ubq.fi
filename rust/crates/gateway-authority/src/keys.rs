//! Source key families encoded by the single shared tuple codec; no JSON identity fallback.
use gateway_core::state::RecordKey;
use gateway_core::tuple_key::ScalarKeyPart::{Number, String as Text};
use gateway_core::tuple_key::{ScalarKeyPart, TupleKey};

fn key(parts: &[ScalarKeyPart<'_>]) -> RecordKey {
    TupleKey::from_scalar_parts(parts).to_record_key()
}

pub fn pool() -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("authority"),
        Text("v1"),
        Text("codex_pool"),
    ])
}
pub fn active() -> RecordKey {
    key(&[Text("uos_ai"), Text("codex_active_account"), Text("v1")])
}
pub fn routing() -> RecordKey {
    key(&[Text("uos_ai"), Text("codex_account_routing"), Text("v2")])
}
pub fn capacity() -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("codex_capacity_routing"),
        Text("v1"),
        Text("observations"),
    ])
}
pub fn models() -> RecordKey {
    key(&[Text("uos_ai"), Text("codex_account_models"), Text("v1")])
}
pub fn overage(hash: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("codex_overage_usage"),
        Text("account"),
        Text("v1"),
        Text(hash),
    ])
}
pub fn reset_usage(hash: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("codex_reset_usage"),
        Text("account"),
        Text("v1"),
        Text(hash),
    ])
}
pub fn api_policy(id: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("authority"),
        Text("v1"),
        Text("api_policy"),
        Text(id),
    ])
}
pub fn api_window(id: &str, version: &str, start: i64) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("api_key_usage"),
        Text("v3"),
        Text("window"),
        Text(id),
        Text(version),
        Number(start),
    ])
}
pub fn api_request(id: &str, version: &str, start: i64, request: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("api_key_usage"),
        Text("v3"),
        Text("request"),
        Text(id),
        Text(version),
        Number(start),
        Text(request),
    ])
}
pub fn kernel_policy(owner: &str, repo: Option<&str>) -> RecordKey {
    match repo {
        Some(repo) => key(&[
            Text("uos_ai"),
            Text("kernel_quota"),
            Text("v2"),
            Text("repo_policy"),
            Text(owner),
            Text(repo),
        ]),
        None => key(&[
            Text("uos_ai"),
            Text("kernel_quota"),
            Text("v2"),
            Text("org_policy"),
            Text(owner),
        ]),
    }
}
pub fn kernel_defaults() -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("authority"),
        Text("v1"),
        Text("kernel_defaults"),
    ])
}
pub fn kernel_cutover() -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("kernel_quota"),
        Text("v2"),
        Text("default_window_cutover"),
    ])
}
pub fn kernel_window(owner: &str, repo: Option<&str>) -> RecordKey {
    match repo {
        Some(repo) => key(&[
            Text("uos_ai"),
            Text("kernel_quota"),
            Text("v2"),
            Text("repo_window"),
            Text(owner),
            Text(repo),
        ]),
        None => key(&[
            Text("uos_ai"),
            Text("kernel_quota"),
            Text("v2"),
            Text("org_window"),
            Text(owner),
        ]),
    }
}
pub fn kernel_request(owner: &str, repo: Option<&str>, created: i64, id: &str) -> RecordKey {
    match repo {
        Some(repo) => key(&[
            Text("uos_ai"),
            Text("kernel_quota"),
            Text("v2"),
            Text("repo_reservation"),
            Text(owner),
            Text(repo),
            Number(created),
            Text(id),
        ]),
        None => key(&[
            Text("uos_ai"),
            Text("kernel_quota"),
            Text("v2"),
            Text("org_reservation"),
            Text(owner),
            Number(created),
            Text(id),
        ]),
    }
}
pub fn paid_routing() -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("authority"),
        Text("v1"),
        Text("paid_routing"),
    ])
}
pub fn paid_window(id: &str, reset: i64) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("paid_fallback"),
        Text("v3"),
        Text("window"),
        Text(id),
        Number(reset),
    ])
}
pub fn paid_attempt(id: &str, request: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("paid_fallback"),
        Text("v3"),
        Text("request"),
        Text(id),
        Text(request),
    ])
}
pub fn paid_pending(id: &str, request: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("paid_fallback"),
        Text("v3"),
        Text("pending"),
        Text(id),
        Text(request),
    ])
}
pub fn paid_gate() -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("paid_fallback"),
        Text("v3"),
        Text("reconciliation_gate"),
    ])
}
pub fn paid_lease(id: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("paid_fallback"),
        Text("v3"),
        Text("reconciliation_lease"),
        Text(id),
    ])
}
pub fn paid_deletion(id: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("paid_fallback"),
        Text("v3"),
        Text("deletion_guard"),
        Text(id),
    ])
}
pub fn paid_rollup(bucket: i64, model: &str, provider: &str, shard: u8) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("paid_fallback"),
        Text("v3"),
        Text("usage_rollup"),
        Number(bucket),
        Text(model),
        Text(provider),
        Number(i64::from(shard)),
    ])
}
pub fn reset_redemption(hash: &str, generation: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("codex_reset_redemption"),
        Text("v1"),
        Text(hash),
        Text(generation),
    ])
}
pub fn reset_day(hash: &str, day: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("codex_reset_redemption"),
        Text("account_day"),
        Text("v1"),
        Text(hash),
        Text(day),
    ])
}
pub fn reset_config() -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("authority"),
        Text("v1"),
        Text("codex_reset_config"),
    ])
}
pub fn reset_shadow(episode: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("codex_reset_shadow_decision"),
        Text("v1"),
        Text(episode),
    ])
}
