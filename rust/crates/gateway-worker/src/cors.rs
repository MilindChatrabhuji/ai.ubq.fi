//! Existing source CORS policy, including trusted credential origins and Vary merging.
use crate::response::GatewayResponse;
use gateway_auth::origin::trusted_relay_origin;
use worker::{Env, Request};

use crate::host::{auth_config, setting};

const ALLOWED_HEADERS: &str = "Authorization,Content-Type,Idempotency-Key,If-None-Match,OpenAI-Beta,OpenAI-Organization,OpenAI-Project,X-GitHub-Owner,X-GitHub-Repo,X-GitHub-Installation-Id,X-Ubiquity-Kernel-Token";
const EXPOSED_HEADERS: &str = "x-uos-warning,x-uos-request-id,x-uos-provider-request-id,x-uos-upstream,x-uos-attempted-providers,x-uos-router-revision,x-uos-git-sha,x-uos-deployment-id,x-uos-cache,ETag,Retry-After,RateLimit,RateLimit-Policy,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset,x-ratelimit-limit-requests-minute,x-ratelimit-remaining-requests-minute,x-ratelimit-reset-requests-minute,x-ratelimit-limit-tokens-minute,x-ratelimit-remaining-tokens-minute,x-ratelimit-reset-tokens-minute,x-ratelimit-limit-requests-day,x-ratelimit-remaining-requests-day,x-ratelimit-reset-requests-day,x-ratelimit-limit-tokens-day,x-ratelimit-remaining-tokens-day,x-ratelimit-reset-tokens-day,x-codex-limit-name,x-codex-primary-used-percent";

pub struct Cors {
    origin: String,
    credentials: bool,
    admin: bool,
}

impl Cors {
    pub fn from_request(request: &Request, env: &Env) -> worker::Result<Self> {
        let config = auth_config(env);
        let url = request.url()?;
        let raw_origin = match request.headers().get("origin")? {
            Some(value) => Some(value),
            None => url
                .query_pairs()
                .find_map(|(key, value)| (key == "cors_origin").then(|| value.into_owned())),
        };
        let origin = raw_origin.and_then(|value| trusted_relay_origin(&value, &config));
        let configured = setting(env, "CORS_ALLOW_ORIGIN")
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "*".into());
        let credentials = origin
            .as_ref()
            .is_some_and(|origin| configured == "*" || *origin == configured);
        Ok(Self {
            origin: if credentials {
                origin.expect("A credential origin was validated")
            } else {
                configured
            },
            credentials,
            admin: url.path() == "/admin" || url.path().starts_with("/admin/"),
        })
    }

    pub fn apply(&self, response: &mut GatewayResponse) -> worker::Result<()> {
        if self.admin {
            response.headers_mut().set("Cache-Control", "no-store")?;
        }
        for (name, value) in [
            ("Access-Control-Allow-Origin", self.origin.as_str()),
            (
                "Access-Control-Allow-Methods",
                "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
            ),
            ("Access-Control-Allow-Headers", ALLOWED_HEADERS),
            ("Access-Control-Expose-Headers", EXPOSED_HEADERS),
            ("Access-Control-Max-Age", "86400"),
        ] {
            response.headers_mut().set(name, value)?;
        }
        if self.credentials {
            response
                .headers_mut()
                .set("Access-Control-Allow-Credentials", "true")?;
            let mut vary = response
                .headers()
                .get("Vary")?
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if let Some(existing) = vary
                .iter_mut()
                .find(|value| value.eq_ignore_ascii_case("origin"))
            {
                *existing = "Origin".into();
            } else {
                vary.push("Origin".into());
            }
            let value = if vary.iter().any(|value| value == "*") {
                "*".to_owned()
            } else {
                vary.join(", ")
            };
            response.headers_mut().set("Vary", &value)?;
        }
        Ok(())
    }
}
