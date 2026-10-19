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
pub fn claude_accounts() -> RecordKey {
    key(&[Text("uos_ai"), Text("claude_code_accounts"), Text("v1")])
}
pub fn claude_quota(account: &str, cohort: &str) -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("claude_code_quota"),
        Text("v1"),
        Text(account),
        Text(cohort),
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
pub fn provider_selection() -> RecordKey {
    key(&[Text("uos_ai"), Text("provider_selection"), Text("v1")])
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
/// Physical source policy identity only. Callers retain the exact logical labels;
/// a collided tuple key does not grant ownership of an existing policy/window.
pub fn kernel_policy_source(
    owner: &gateway_core::js_string::JsString16,
    repo: Option<&gateway_core::js_string::JsString16>,
) -> Result<RecordKey, gateway_core::GatewayError> {
    kernel_source_key(
        if repo.is_some() {
            "repo_policy"
        } else {
            "org_policy"
        },
        owner,
        repo,
    )
}

fn kernel_source_key(
    family: &str,
    owner: &gateway_core::js_string::JsString16,
    repo: Option<&gateway_core::js_string::JsString16>,
) -> Result<RecordKey, gateway_core::GatewayError> {
    use gateway_core::tuple_key::KeyPart;
    let mut parts = vec![
        KeyPart::String("uos_ai".into()),
        KeyPart::String("kernel_quota".into()),
        KeyPart::String("v2".into()),
        KeyPart::String(family.into()),
        KeyPart::source_string_utf16(owner.as_units()),
    ];
    if let Some(repo) = repo {
        parts.push(KeyPart::source_string_utf16(repo.as_units()));
    }
    Ok(TupleKey::from_parts(&parts)?.to_record_key())
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
/// Same pinned source tuple conversion as the policy overload, with no label
/// normalization or inference about logical policy/window ownership.
pub fn kernel_window_source(
    owner: &gateway_core::js_string::JsString16,
    repo: Option<&gateway_core::js_string::JsString16>,
) -> Result<RecordKey, gateway_core::GatewayError> {
    kernel_source_key(
        if repo.is_some() {
            "repo_window"
        } else {
            "org_window"
        },
        owner,
        repo,
    )
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
pub fn paid_control_owner() -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("authority"),
        Text("v1"),
        Text("paid_control_owner"),
    ])
}
pub fn paid_control_config() -> RecordKey {
    key(&[
        Text("uos_ai"),
        Text("authority"),
        Text("v1"),
        Text("paid_control_config"),
    ])
}
pub fn paid_control_observation(provider: gateway_core::provider::PaidProvider) -> RecordKey {
    let provider = match provider {
        gateway_core::provider::PaidProvider::Surplus => "surplus",
        gateway_core::provider::PaidProvider::Metered => "openlux",
    };
    key(&[
        Text("uos_ai"),
        Text("authority"),
        Text("v1"),
        Text("paid_control_observation"),
        Text(provider),
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
/// Source physical model component. Distinct logical UTF16 labels may intentionally
/// share the existing TextEncoder key bytes; callers retain each logical label.
pub fn paid_rollup_model(
    bucket: i64,
    model: &gateway_core::model::ModelId,
    provider: &str,
    shard: u8,
) -> RecordKey {
    paid_rollup_source(
        bucket as f64,
        model,
        &gateway_core::js_string::JsString16::from_utf8(provider),
        f64::from(shard),
    )
    .expect("Integer bucket/shard and source string parts are finite tuple inputs")
}
/// Pure source-key construction for the shared usage family. Provider labels
/// are source UTF16 data here, not a paid-provider enum or a live permission.
/// Callers retain the source value predicate and bucket/shard guards.
pub fn paid_rollup_source(
    bucket: f64,
    model: &gateway_core::model::ModelId,
    provider: &gateway_core::js_string::JsString16,
    shard: f64,
) -> Result<RecordKey, gateway_core::GatewayError> {
    use gateway_core::tuple_key::KeyPart;
    Ok(TupleKey::from_parts(&[
        KeyPart::String("uos_ai".into()),
        KeyPart::String("paid_fallback".into()),
        KeyPart::String("v3".into()),
        KeyPart::String("usage_rollup".into()),
        KeyPart::Number(bucket),
        KeyPart::source_string_utf16(model.as_js_string().as_units()),
        KeyPart::source_string_utf16(provider.as_units()),
        KeyPart::Number(shard),
    ])?
    .to_record_key())
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
