//! Portable source credential parsing. Parsing establishes shape and identity
//! preconditions, never upstream authorization or permission to refresh credentials.
use std::collections::BTreeSet;

use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use gateway_core::{
    identity::{CredentialVersion, RoutingAccountHash, SubscriptionSelectionHash},
    state::{AuthorityStore, RecordKey},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    GatewayError,
    crypto::{Secret, sha256_hex},
    store,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexNativeOwner {
    pub codex_home: String,
    pub generation_hash: String,
    pub native_refreshed_at: Option<String>,
    pub external_user_id: Option<String>,
    pub managed_source: Option<ManagedNativeSource>,
}

pub const MANAGED_NATIVE_SOURCE_VERSION: u8 = 2;

/// Physical managed credentials remain native. This records only their
/// authenticated generation; the containing row holds an access projection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedNativeSource {
    pub v: u8,
    pub generation_hash: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexSourceAccount {
    pub access_token: Secret,
    pub refresh_token: Secret,
    pub account_id: String,
    pub updated_at_ms: f64,
    pub native_owner: Option<CodexNativeOwner>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexSourcePool {
    pub accounts: Vec<CodexSourceAccount>,
    pub updated_at_ms: f64,
}

impl CodexSourcePool {
    pub fn private_source_value(&self) -> Value {
        json!({"accounts":self.accounts.iter().map(CodexSourceAccount::private_source_value).collect::<Vec<_>>(),"updated_at_ms":self.updated_at_ms})
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexCredentialIdentity {
    pub routing_account_hash: RoutingAccountHash,
    pub administrative_account_hash: SubscriptionSelectionHash,
    pub credential_version: CredentialVersion,
    pub native_generation_hash: String,
}

pub fn codex_credential_identity(
    account_id: &str,
    access_token: &Secret,
    refresh_token: &Secret,
) -> CodexCredentialIdentity {
    CodexCredentialIdentity {
        routing_account_hash: RoutingAccountHash(sha256_hex(
            format!("uos_ai\0codex_routing_account\0{account_id}").as_bytes(),
        )),
        administrative_account_hash: SubscriptionSelectionHash(sha256_hex(account_id.as_bytes())),
        credential_version: CredentialVersion(sha256_hex(
            format!(
                "{account_id}\0{}\0{}",
                access_token.expose(),
                refresh_token.expose()
            )
            .as_bytes(),
        )),
        native_generation_hash: sha256_hex(
            json!([account_id, access_token.expose(), refresh_token.expose()])
                .to_string()
                .as_bytes(),
        ),
    }
}

impl CodexSourceAccount {
    pub fn identity(&self) -> CodexCredentialIdentity {
        codex_credential_identity(&self.account_id, &self.access_token, &self.refresh_token)
    }
    /// Explicit private-storage encoding. This type intentionally has no Serialize
    /// implementation that could expose credentials through ordinary diagnostics.
    pub fn private_source_value(&self) -> Value {
        let mut value = json!({"account_id":self.account_id,"access_token":self.access_token.expose(),"refresh_token":self.refresh_token.expose(),"updated_at_ms":self.updated_at_ms});
        if let Some(owner) = &self.native_owner {
            let mut native =
                json!({"codex_home":owner.codex_home,"generation_hash":owner.generation_hash});
            if let Some(refreshed) = &owner.native_refreshed_at {
                native["native_refreshed_at"] = json!(refreshed);
            }
            if let Some(user) = &owner.external_user_id {
                native["auth_mode"] = json!("chatgptAuthTokens");
                native["chatgpt_user_id"] = json!(user);
            }
            if let Some(managed) = &owner.managed_source {
                native["managed_source"] = json!(managed);
            }
            value["native_owner"] = native;
        }
        value
    }
}

fn string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn source_whitespace(value: char) -> bool {
    matches!(value, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// WHATWG forgiving-base64 after the source's JavaScript whitespace removal.
/// Preserve atob's unpadded/trailing-bit behavior without accepting partial padding.
pub fn decode_source_base64(raw: &str) -> Option<Vec<u8>> {
    let mut clean: String = raw
        .chars()
        .filter(|value| !source_whitespace(*value))
        .collect();
    if clean.len().is_multiple_of(4) {
        for _ in 0..2 {
            if clean.ends_with('=') {
                clean.pop();
            }
        }
    }
    if clean.len() % 4 == 1
        || !clean
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'+' | b'/'))
    {
        return None;
    }
    GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::RequireNone)
            .with_decode_allow_trailing_bits(true),
    )
    .decode(clean)
    .ok()
}

fn jwt_payload(token: &str) -> Option<Value> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = parts[1].replace('-', "+").replace('_', "/");
    let bytes = decode_source_base64(&payload)?;
    serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()
}

pub fn codex_access_expiry_ms(token: &Secret) -> Option<f64> {
    let payload = jwt_payload(token.expose().trim_matches(source_whitespace))?;
    let exp = payload
        .get("exp")?
        .as_f64()
        .filter(|value| value.is_finite() && *value != 0.0)?;
    Some(exp * 1000.0)
}

fn external_identity(token: &str) -> Option<(String, String)> {
    let payload = jwt_payload(token)?;
    let claims = payload.get("https://api.openai.com/auth")?;
    Some((
        string(claims.get("chatgpt_user_id"))?.to_owned(),
        string(claims.get("chatgpt_account_id"))?.to_owned(),
    ))
}

fn owner_error() -> GatewayError {
    GatewayError::unavailable(
        "Codex native credential ownership is malformed; nothing was replaced.",
        "codex_auth_owner_unavailable",
    )
}

fn parse_owner(value: Option<&Value>) -> Result<Option<CodexNativeOwner>, GatewayError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let home = string(value.get("codex_home"))
        .filter(|value| value.starts_with('/'))
        .ok_or_else(owner_error)?;
    let generation = string(value.get("generation_hash"))
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
        .ok_or_else(owner_error)?;
    let external_user_id = match value.get("auth_mode") {
        None => None,
        Some(Value::String(mode)) if mode == "chatgptAuthTokens" => Some(
            string(value.get("chatgpt_user_id"))
                .ok_or_else(owner_error)?
                .to_owned(),
        ),
        Some(_) => return Err(owner_error()),
    };
    let managed_source = value
        .get("managed_source")
        .map(|value| {
            serde_json::from_value::<ManagedNativeSource>(value.clone()).map_err(|_| owner_error())
        })
        .transpose()?;
    if managed_source.as_ref().is_some_and(|managed| {
        managed.v != MANAGED_NATIVE_SOURCE_VERSION
            || !valid_native_generation(&managed.generation_hash)
            || external_user_id.is_some()
    }) {
        return Err(owner_error());
    }
    Ok(Some(CodexNativeOwner {
        codex_home: home.to_owned(),
        generation_hash: generation.to_owned(),
        native_refreshed_at: string(value.get("native_refreshed_at")).map(str::to_owned),
        external_user_id,
        managed_source,
    }))
}

fn parse_account(value: &Value) -> Result<Option<CodexSourceAccount>, GatewayError> {
    if !value.is_object() {
        return Ok(None);
    }
    let owner = parse_owner(value.get("native_owner"))?;
    let Some(access) = string(value.get("access_token")) else {
        return Ok(None);
    };
    let Some(account) = string(value.get("account_id")) else {
        return Ok(None);
    };
    let Some(updated) = value
        .get("updated_at_ms")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
    else {
        return Ok(None);
    };
    let refresh = if owner
        .as_ref()
        .is_some_and(|owner| owner.managed_source.is_some())
    {
        if value.get("refresh_token").and_then(Value::as_str) != Some("") {
            return Ok(None);
        }
        ""
    } else if let Some(user) = owner
        .as_ref()
        .and_then(|owner| owner.external_user_id.as_ref())
    {
        if value.get("refresh_token").and_then(Value::as_str) != Some("")
            || external_identity(access).as_ref() != Some(&(user.to_owned(), account.to_owned()))
        {
            return Ok(None);
        }
        ""
    } else {
        let Some(refresh) = string(value.get("refresh_token")) else {
            return Ok(None);
        };
        refresh
    };
    Ok(Some(CodexSourceAccount {
        access_token: Secret::new(access.to_owned()),
        refresh_token: Secret::new(refresh.to_owned()),
        account_id: account.to_owned(),
        updated_at_ms: updated,
        native_owner: owner,
    }))
}

pub fn valid_native_generation(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// Matches parseCodexAuthPool: malformed ownership is an error; other invalid
/// pool shapes return None. Duplicate account IDs and pools above two are refused.
pub fn parse_codex_source_pool(value: &Value) -> Result<Option<CodexSourcePool>, GatewayError> {
    let Some(rows) = value
        .get("accounts")
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty() && rows.len() <= 2)
    else {
        return Ok(None);
    };
    let Some(updated) = value
        .get("updated_at_ms")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
    else {
        return Ok(None);
    };
    let mut accounts = Vec::new();
    let mut ids = BTreeSet::new();
    for row in rows {
        let Some(account) = parse_account(row)? else {
            return Ok(None);
        };
        if !ids.insert(account.account_id.clone()) {
            return Ok(None);
        }
        accounts.push(account);
    }
    Ok(Some(CodexSourcePool {
        accounts,
        updated_at_ms: updated,
    }))
}

/// Uploaded/configured auth.json is the source's nonexternal credential route.
/// Access-only documents require the separate trusted native-owner capability.
pub fn parse_codex_auth_document(value: &Value, now_ms: i64) -> Option<CodexSourceAccount> {
    if value.get("auth_mode").and_then(Value::as_str) == Some("chatgptAuthTokens") {
        return None;
    }
    let tokens = value.get("tokens")?;
    Some(CodexSourceAccount {
        access_token: Secret::new(string(tokens.get("access_token"))?.to_owned()),
        refresh_token: Secret::new(string(tokens.get("refresh_token"))?.to_owned()),
        account_id: string(tokens.get("account_id"))?.to_owned(),
        updated_at_ms: now_ms as f64,
        native_owner: None,
    })
}

pub fn parse_codex_auth_binding(
    encoded: &str,
    now_ms: i64,
) -> Result<CodexSourceAccount, GatewayError> {
    if encoded.trim_matches(source_whitespace).is_empty() {
        return Err(GatewayError::unavailable(
            "Codex auth is missing",
            "codex_auth_missing",
        ));
    }
    let bytes = decode_source_base64(encoded).ok_or_else(|| {
        GatewayError::unavailable("Codex auth is not valid base64", "codex_auth_invalid")
    })?;
    let value: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(|_| {
        GatewayError::unavailable("Codex auth is not valid JSON", "codex_auth_invalid")
    })?;
    parse_codex_auth_document(&value, now_ms).ok_or_else(|| {
        GatewayError::unavailable(
            "Codex auth does not match source auth.json",
            "codex_auth_invalid",
        )
    })
}

pub fn codex_source_pool_key() -> RecordKey {
    store::key(json!(["ubq_ai", "codex_auth"]))
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexSourceSnapshot {
    pub pool: CodexSourcePool,
    pub revision: String,
}

/// Read-only common-authority snapshot. Publication must atomically fence this
/// exact revision and reconcile the authority's distinct routing projection.
pub async fn read_codex_source_pool<S: AuthorityStore>(
    store: &S,
    now_ms: i64,
) -> Result<Option<CodexSourceSnapshot>, GatewayError> {
    let row = store.read(&codex_source_pool_key()).await?;
    let value: Option<Value> = store::decode(row.as_ref(), now_ms)?;
    let Some(value) = value else {
        return Ok(None);
    };
    let pool = parse_codex_source_pool(&value)?.ok_or_else(|| {
        GatewayError::unavailable("Codex auth pool is invalid", "codex_auth_invalid")
    })?;
    Ok(Some(CodexSourceSnapshot {
        pool,
        revision: row.expect("decoded row exists").revision,
    }))
}
