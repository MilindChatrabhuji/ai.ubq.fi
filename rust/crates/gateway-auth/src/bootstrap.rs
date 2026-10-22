//! Source configuration translation. The caller supplies its actual configured bindings;
//! this module never discovers dotenv, reads a home, or guesses an account identity.
use std::collections::BTreeMap;

use crate::{AuthConfig, crypto::Secret};

fn tokens(raw: Option<&str>) -> Vec<Secret> {
    let mut result = Vec::new();
    for token in raw.unwrap_or_default().split([',', '\n']).map(str::trim) {
        if !token.is_empty()
            && !result
                .iter()
                .any(|existing: &Secret| existing.expose() == token)
        {
            result.push(Secret::new(token.to_owned()));
        }
    }
    result
}

fn nonempty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn kernel_pems(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = nonempty(raw) else {
        return Vec::new();
    };
    // Source-golden UTF-16 vectors: [92,110] -> [10], and [92,92,110] -> [92,10].
    let normalized = raw.replace("\\n", "\n");
    let begin = "-----BEGIN PUBLIC KEY-----";
    let end = "-----END PUBLIC KEY-----";
    let mut blocks = Vec::new();
    let mut remaining = normalized.as_str();
    while let Some(start) = remaining.find(begin) {
        let Some(finish) = remaining[start..]
            .find(end)
            .map(|offset| start + offset + end.len())
        else {
            break;
        };
        blocks.push(remaining[start..finish].trim().to_owned());
        remaining = &remaining[finish..];
    }
    if blocks.is_empty() {
        vec![normalized]
    } else {
        blocks
    }
}

impl AuthConfig {
    /// Translate only existing source setting names. `git_sha_known` must come from
    /// the runtime's validated release identity, never an environment fingerprint.
    /// Candidate-origin and relay additions remain separately explicit policy choices.
    pub fn from_source_values(values: &BTreeMap<String, String>, git_sha_known: bool) -> Self {
        let get = |name: &str| values.get(name).map(String::as_str);
        Self {
            auth_tokens: tokens(get("UOS_AI_TOKEN")),
            admin_tokens: tokens(get("DENO_DEPLOY_TOKEN")),
            production: get("DENO_TIMELINE") == Some("production"),
            // Preserve JS nullish precedence: an explicitly empty first binding stops fallback.
            hosted: get("DENO_DEPLOY")
                .or_else(|| get("DENO_DEPLOYMENT_ID"))
                .or_else(|| get("DENO_REGION"))
                .is_some_and(|value| !value.is_empty()),
            git_sha_known,
            kernel_public_keys_pem: kernel_pems(get("UOS_AI_KERNEL_PUBLIC_KEY")),
            deno_app_slug: nonempty(get("DENO_DEPLOY_APP_SLUG")),
            deno_org_slug: nonempty(get("DENO_DEPLOY_ORG_SLUG")),
            deno_deployment_id: nonempty(get("DENO_DEPLOYMENT_ID")),
            passport: crate::passport::PassportConfig::from_values(values),
            ..Default::default()
        }
    }
}
