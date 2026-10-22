use crate::crypto::{Secret, decode_base64url};
use gateway_core::GatewayError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct NativeOwnerId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OwnerFence {
    pub owner: NativeOwnerId,
    pub account_id: String,
    pub generation_hash: String,
    pub authority_revision: String,
}

#[derive(Clone, Debug)]
pub struct NativeCredentials {
    pub account_id: String,
    pub access_token: Secret,
    pub refresh_token: Secret,
    pub email: Option<String>,
    pub native_refreshed_at: Option<String>,
    pub external_user_id: Option<String>,
}

impl NativeCredentials {
    /// Source routing identity is salted and deliberately differs from the
    /// administrative SHA-256(account_id) and the native generation fingerprint.
    pub fn routing_account_hash(&self) -> String {
        crate::provider_credentials::codex_credential_identity(
            &self.account_id,
            &self.access_token,
            &self.refresh_token,
        )
        .routing_account_hash
        .0
    }
    pub fn administrative_account_hash(&self) -> String {
        crate::provider_credentials::codex_credential_identity(
            &self.account_id,
            &self.access_token,
            &self.refresh_token,
        )
        .administrative_account_hash
        .0
    }
    pub fn routing_credential_version(&self) -> String {
        crate::provider_credentials::codex_credential_identity(
            &self.account_id,
            &self.access_token,
            &self.refresh_token,
        )
        .credential_version
        .0
    }
    pub fn generation_hash(&self) -> String {
        crate::provider_credentials::codex_credential_identity(
            &self.account_id,
            &self.access_token,
            &self.refresh_token,
        )
        .native_generation_hash
    }
    pub fn same_credentials(&self, other: &Self) -> bool {
        self.access_token == other.access_token && self.refresh_token == other.refresh_token
    }
    pub fn access_expires_at_ms(&self) -> Option<i64> {
        jwt_payload(self.access_token.expose())?
            .get("exp")?
            .as_i64()?
            .checked_mul(1000)
    }
}

#[derive(Clone, Debug)]
pub struct NativeGeneration {
    pub fence: OwnerFence,
    pub credentials: NativeCredentials,
    pub observed_at_ms: i64,
}

pub fn jwt_payload(token: &str) -> Option<Value> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    serde_json::from_slice(&decode_base64url(parts[1]).ok()?).ok()
}

pub fn native_refresh_time_ns(value: Option<&str>) -> Option<i128> {
    OffsetDateTime::parse(value?, &Rfc3339)
        .ok()
        .map(|time| time.unix_timestamp_nanos())
}

fn nonempty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

/// The caller supplies bytes read from one registry-owned local home, never an uploaded path.
pub fn parse_native_document(raw: &Value) -> Result<NativeCredentials, GatewayError> {
    let object = raw.as_object().ok_or_else(owner_unavailable)?;
    let tokens = object
        .get("tokens")
        .and_then(Value::as_object)
        .ok_or_else(owner_unavailable)?;
    let access = nonempty(tokens.get("access_token")).ok_or_else(owner_unavailable)?;
    let account = nonempty(tokens.get("account_id")).ok_or_else(owner_unavailable)?;
    let refreshed = match object.get("last_refresh") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let timestamp = value.as_str().ok_or_else(owner_unavailable)?;
            if native_refresh_time_ns(Some(timestamp)).is_none() {
                return Err(owner_unavailable());
            }
            Some(timestamp.to_owned())
        }
    };
    let external = object.get("auth_mode").and_then(Value::as_str) == Some("chatgptAuthTokens");
    if external {
        if object.get("OPENAI_API_KEY") != Some(&Value::Null)
            || tokens.get("id_token").and_then(Value::as_str) != Some(&access)
            || tokens.get("refresh_token").and_then(Value::as_str) != Some("")
        {
            return Err(owner_unavailable());
        }
        let claims = jwt_payload(&access).ok_or_else(owner_unavailable)?;
        let identity = claims
            .get("https://api.openai.com/auth")
            .and_then(Value::as_object)
            .ok_or_else(owner_unavailable)?;
        let user = nonempty(identity.get("chatgpt_user_id")).ok_or_else(owner_unavailable)?;
        if identity.get("chatgpt_account_id").and_then(Value::as_str) != Some(&account) {
            return Err(owner_conflict());
        }
        return Ok(NativeCredentials {
            account_id: account,
            access_token: Secret::new(access),
            refresh_token: Secret::new(String::new()),
            email: nonempty(claims.get("email")),
            native_refreshed_at: refreshed,
            external_user_id: Some(user),
        });
    }
    if object
        .get("auth_mode")
        .is_some_and(|value| value.as_str() != Some("chatgpt"))
    {
        return Err(owner_unavailable());
    }
    let refresh = nonempty(tokens.get("refresh_token")).ok_or_else(owner_unavailable)?;
    let email = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(jwt_payload)
        .and_then(|v| nonempty(v.get("email")));
    Ok(NativeCredentials {
        account_id: account,
        access_token: Secret::new(access),
        refresh_token: Secret::new(refresh),
        email,
        native_refreshed_at: refreshed,
        external_user_id: None,
    })
}

/// Only exact credentials bootstrap an owner. A timestamp or file mtime is never proof.
pub fn verify_bootstrap(
    stored: &NativeCredentials,
    observed: &NativeCredentials,
) -> Result<(), GatewayError> {
    if stored.account_id != observed.account_id || !stored.same_credentials(observed) {
        return Err(owner_conflict());
    }
    Ok(())
}

pub fn verify_generation(
    previous: &NativeCredentials,
    next: &NativeCredentials,
    now_ms: i64,
    require_usable: bool,
) -> Result<(), GatewayError> {
    if previous.account_id != next.account_id {
        return Err(owner_conflict());
    }
    if let Some(user) = previous.external_user_id.as_ref()
        && next.external_user_id.as_ref() != Some(user)
    {
        return Err(owner_conflict());
    }
    if next.external_user_id.is_some() {
        let identity = jwt_payload(previous.access_token.expose())
            .and_then(|v| v.get("https://api.openai.com/auth").cloned())
            .ok_or_else(owner_conflict)?;
        if identity.get("chatgpt_user_id").and_then(Value::as_str)
            != next.external_user_id.as_deref()
            || identity.get("chatgpt_account_id").and_then(Value::as_str)
                != Some(&previous.account_id)
        {
            return Err(owner_conflict());
        }
    }
    let previous_expiry = previous.access_expires_at_ms();
    let expiry = next.access_expires_at_ms().ok_or_else(generation_failed)?;
    let advanced_time = matches!((native_refresh_time_ns(previous.native_refreshed_at.as_deref()),native_refresh_time_ns(next.native_refreshed_at.as_deref())),(Some(old),Some(new))if new>old);
    if (require_usable && expiry <= now_ms.saturating_add(120_000))
        || (!require_usable && previous_expiry.is_none() && !advanced_time)
        || previous_expiry.is_some_and(|old| expiry < old || (expiry == old && !advanced_time))
    {
        return Err(generation_failed());
    }
    Ok(())
}

pub fn verify_fence(fence: &OwnerFence, current: &OwnerFence) -> Result<(), GatewayError> {
    if fence != current {
        return Err(owner_conflict());
    }
    Ok(())
}

pub fn verify_daemon_account(
    reply: &Value,
    expected_email: &str,
    expected_account: &str,
    fixed_file_account: Option<&str>,
) -> Result<(), GatewayError> {
    let account = reply.get("account").and_then(Value::as_object);
    let Some(account) = account else {
        if reply.get("requiresOpenaiAuth") == Some(&Value::Bool(false))
            && fixed_file_account == Some(expected_account)
        {
            return Ok(());
        }
        return Err(owner_unavailable());
    };
    let routed = reply
        .get("workspaceRouting")
        .and_then(|value| value.get("chatgptAccountId"))
        .and_then(Value::as_str);
    if account.get("type").and_then(Value::as_str) != Some("chatgpt")
        || account.get("email").and_then(Value::as_str) != Some(expected_email)
        || routed != Some(expected_account)
    {
        return Err(owner_conflict());
    }
    Ok(())
}

pub fn owner_unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Native Codex credential owner is unavailable; direct refresh was refused.",
        "codex_auth_owner_unavailable",
    )
}
pub fn owner_conflict() -> GatewayError {
    GatewayError::new(
        409,
        "Native Codex account or credential ownership changed; nothing was adopted.",
        Some("codex_auth_owner_conflict"),
    )
}
pub fn generation_failed() -> GatewayError {
    GatewayError::unavailable(
        "Native Codex credential generation did not advance; no stale credentials were adopted.",
        "codex_auth_refresh_failed",
    )
}
