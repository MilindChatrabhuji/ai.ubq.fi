//! Source Claude roster and current-generation fences. Secret-bearing records never form admin JSON.
use crate::{parse, store};
use gateway_auth::{
    AuthHost,
    crypto::{Secret, sha256_hex},
    store::{check, commit, put},
};
use gateway_core::{
    GatewayError,
    state::{AuthorityStore, RecordKey, RevisionCheck},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    ApiKey,
    Oauth,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct Credential {
    pub kind: CredentialKind,
    #[serde(with = "secret_serde")]
    pub secret: Secret,
    pub hint: String,
    pub label: Option<String>,
    pub source: String,
    pub updated_at_ms: Option<i64>,
}
impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("kind", &self.kind)
            .field("source", &self.source)
            .field("secret", &"[redacted]")
            .finish()
    }
}
mod secret_serde {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        secret: &Secret,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(secret.expose())
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Secret, D::Error> {
        String::deserialize(deserializer).map(Secret::new)
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Workspace {
    pub id: String,
    pub name: Option<String>,
    pub source: String,
    pub discovered_at_ms: Option<i64>,
    pub verified_at_ms: Option<i64>,
    pub last_error: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AccountBinding {
    pub account_id: String,
    pub account_cohort_id: String,
    pub credential_fingerprint: String,
    pub evidence_generation: String,
    pub credential: Credential,
    pub workspace: Option<Workspace>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AccountStore {
    pub v: u32,
    pub accounts: Vec<AccountBinding>,
    pub active_account_id: Option<String>,
    pub active_reason: String,
    pub updated_at_ms: i64,
}
#[derive(Clone, Debug)]
pub struct RosterRead {
    pub roster: AccountStore,
    pub revision: Option<String>,
}
#[derive(Clone, Debug, Default)]
pub struct Bootstrap {
    pub credential: Option<Credential>,
    pub workspace: Option<Workspace>,
}

pub fn account_store_key() -> RecordKey {
    store::key(json!(["uos_ai", "claude_code_accounts", "v1"]))
}
fn legacy_credential_key() -> RecordKey {
    store::key(json!(["ubq_ai", "claude_code_auth"]))
}
fn legacy_workspace_key() -> RecordKey {
    store::key(json!(["ubq_ai", "claude_code_workspace"]))
}
fn opaque(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn fingerprint(credential: &Credential, workspace: Option<&Workspace>) -> String {
    let kind = match credential.kind {
        CredentialKind::ApiKey => "api_key",
        CredentialKind::Oauth => "oauth",
    };
    sha256_hex(
        serde_json::to_string(&json!([
            kind,
            credential.secret.expose(),
            workspace.map(|w| w.id.as_str())
        ]))
        .expect("source JSON tuple")
        .as_bytes(),
    )
}
pub fn same_binding(left: &AccountBinding, right: &AccountBinding) -> bool {
    left.account_id == right.account_id
        && left.account_cohort_id == right.account_cohort_id
        && left.evidence_generation == right.evidence_generation
        && left.credential_fingerprint == right.credential_fingerprint
}
fn hint(secret: &str) -> String {
    if secret.encode_utf16().count() <= 18 {
        "configured".into()
    } else {
        let prefix: String = secret.chars().take(14).collect();
        let suffix: String = secret
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{prefix}...{suffix}")
    }
}
fn finite_positive(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|n| n.trunc() as i64)
}
pub fn parse_credential(value: &Value, source: &str) -> Option<Credential> {
    let secret = parse::text(value.get("secret"))?;
    if secret.encode_utf16().count() > 512 {
        return None;
    }
    let kind = match value.get("kind").and_then(Value::as_str) {
        Some("api_key") => CredentialKind::ApiKey,
        Some("oauth") => CredentialKind::Oauth,
        _ => {
            let lower = secret.to_lowercase();
            if lower.starts_with("sk-ant-oat") || lower.starts_with("sk-ant-ort") {
                CredentialKind::Oauth
            } else {
                CredentialKind::ApiKey
            }
        }
    };
    let time = finite_positive(value.get("updated_at_ms"))?;
    Some(Credential {
        kind,
        hint: parse::text(value.get("hint")).unwrap_or_else(|| hint(&secret)),
        secret: Secret::new(secret),
        label: parse::text(value.get("label")),
        source: source.into(),
        updated_at_ms: Some(time),
    })
}
pub fn parse_workspace(value: &Value) -> Option<Workspace> {
    let id = parse::text(value.get("id"))?;
    if id.encode_utf16().count() > 256 {
        return None;
    }
    let source = value
        .get("source")
        .and_then(Value::as_str)
        .filter(|s| ["kv", "env", "discovered"].contains(s))
        .unwrap_or("kv");
    Some(Workspace {
        id,
        name: parse::text(value.get("name")),
        source: source.into(),
        discovered_at_ms: finite_positive(value.get("discovered_at_ms")),
        verified_at_ms: finite_positive(value.get("verified_at_ms")),
        last_error: parse::text(value.get("last_error")),
    })
}
pub fn parse_roster(value: &Value) -> Result<AccountStore, GatewayError> {
    let invalid = || store::corrupt("Claude account roster is invalid; refusing legacy fallback");
    if value.get("v") != Some(&json!(1)) {
        return Err(invalid());
    }
    let rows = value
        .get("accounts")
        .and_then(Value::as_array)
        .filter(|v| v.len() <= 32)
        .ok_or_else(invalid)?;
    let mut accounts = Vec::new();
    let mut ids = BTreeSet::new();
    for row in rows {
        let id = row
            .get("account_id")
            .and_then(Value::as_str)
            .filter(|s| opaque(s))
            .ok_or_else(invalid)?;
        let cohort = row
            .get("account_cohort_id")
            .and_then(Value::as_str)
            .filter(|s| opaque(s))
            .ok_or_else(invalid)?;
        let generation = row
            .get("evidence_generation")
            .and_then(Value::as_str)
            .filter(|s| opaque(s))
            .ok_or_else(invalid)?;
        let fingerprint = row
            .get("credential_fingerprint")
            .and_then(Value::as_str)
            .filter(|s| digest(s))
            .ok_or_else(invalid)?;
        if !ids.insert(id) {
            return Err(invalid());
        }
        let raw = row
            .get("credential")
            .filter(|v| v.is_object())
            .ok_or_else(invalid)?;
        let source = raw
            .get("source")
            .and_then(Value::as_str)
            .filter(|s| ["kv", "CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].contains(s))
            .ok_or_else(invalid)?;
        let mut normalized = raw.clone();
        if normalized.get("updated_at_ms").is_none_or(Value::is_null) {
            normalized["updated_at_ms"] = json!(1)
        }
        let mut credential = parse_credential(&normalized, source).ok_or_else(invalid)?;
        if raw.get("updated_at_ms") == Some(&Value::Null) {
            credential.updated_at_ms = None
        }
        let workspace = if row.get("workspace") == Some(&Value::Null) {
            None
        } else {
            Some(parse_workspace(row.get("workspace").ok_or_else(invalid)?).ok_or_else(invalid)?)
        };
        accounts.push(AccountBinding {
            account_id: id.into(),
            account_cohort_id: cohort.into(),
            credential_fingerprint: fingerprint.into(),
            evidence_generation: generation.into(),
            credential,
            workspace,
        });
    }
    let active = match value.get("active_account_id") {
        Some(Value::Null) => None,
        Some(Value::String(id)) if accounts.iter().any(|a| a.account_id == *id) => Some(id.clone()),
        _ => return Err(invalid()),
    };
    let reason = value
        .get("active_reason")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let time = value
        .get("updated_at_ms")
        .and_then(Value::as_i64)
        .filter(|n| *n > 0 && *n <= gateway_core::identity::MAX_SAFE_INTEGER)
        .ok_or_else(invalid)?;
    Ok(AccountStore {
        v: 1,
        accounts,
        active_account_id: active,
        active_reason: reason.into(),
        updated_at_ms: time,
    })
}
pub async fn read_roster<S: AuthorityStore>(
    store: &S,
    now: i64,
) -> Result<Option<RosterRead>, GatewayError> {
    let row = store.read(&account_store_key()).await?;
    store::value(row.as_ref(), now)?
        .map(|value| {
            Ok(RosterRead {
                roster: parse_roster(&value)?,
                revision: row.map(|r| r.revision),
            })
        })
        .transpose()
}
fn empty(now: i64) -> AccountStore {
    AccountStore {
        v: 1,
        accounts: Vec::new(),
        active_account_id: None,
        active_reason: "unconfigured".into(),
        updated_at_ms: now,
    }
}
fn make_account<H: AuthHost>(
    host: &H,
    credential: Credential,
    workspace: Option<Workspace>,
    previous: Option<&AccountBinding>,
) -> Result<AccountBinding, GatewayError> {
    let fingerprint = fingerprint(&credential, workspace.as_ref());
    let same = previous.is_some_and(|p| p.credential_fingerprint == fingerprint);
    Ok(AccountBinding {
        account_id: previous
            .map(|p| p.account_id.clone())
            .map(Ok)
            .unwrap_or_else(|| store::revision(host))?,
        account_cohort_id: if same {
            previous.expect("same account").account_cohort_id.clone()
        } else {
            store::revision(host)?
        },
        evidence_generation: if same {
            previous.expect("same account").evidence_generation.clone()
        } else {
            store::revision(host)?
        },
        credential_fingerprint: fingerprint,
        credential,
        workspace,
    })
}
/// Bootstrap only absent state. A present empty roster prevents legacy/environment resurrection.
pub async fn load_roster<S: AuthorityStore, H: AuthHost>(
    store: &S,
    host: &H,
    seed: &Bootstrap,
) -> Result<RosterRead, GatewayError> {
    for _ in 0..12 {
        let key = account_store_key();
        let row = store.read(&key).await?;
        if let Some(value) = store::value(row.as_ref(), host.now_ms())? {
            return Ok(RosterRead {
                roster: parse_roster(&value)?,
                revision: row.map(|r| r.revision),
            });
        }
        let ck = legacy_credential_key();
        let cr = store.read(&ck).await?;
        let wk = legacy_workspace_key();
        let wr = store.read(&wk).await?;
        let credential = store::value(cr.as_ref(), host.now_ms())?
            .and_then(|v| parse_credential(&v, "kv"))
            .or_else(|| seed.credential.clone());
        let Some(credential) = credential else {
            return Ok(RosterRead {
                roster: empty(host.now_ms()),
                revision: None,
            });
        };
        let workspace = store::value(wr.as_ref(), host.now_ms())?
            .and_then(|v| parse_workspace(&v))
            .or_else(|| seed.workspace.clone());
        let account = make_account(host, credential, workspace, None)?;
        let roster = AccountStore {
            v: 1,
            active_account_id: Some(account.account_id.clone()),
            accounts: vec![account],
            active_reason: "singleton_bootstrap".into(),
            updated_at_ms: host.now_ms(),
        };
        let revision = store::revision(host)?;
        if commit(
            store,
            vec![
                check(&key, row.as_ref()),
                check(&ck, cr.as_ref()),
                check(&wk, wr.as_ref()),
            ],
            vec![put(key, &roster, None, &revision)?],
        )
        .await?
        {
            return Ok(RosterRead {
                roster,
                revision: Some(revision),
            });
        }
    }
    Err(gateway_auth::conflict(
        "Claude account bootstrap changed repeatedly",
    ))
}
/// The returned exact roster revision joins the caller's authority/dispatch transaction.
pub async fn current_binding<S: AuthorityStore>(
    store: &S,
    binding: &AccountBinding,
    now: i64,
) -> Result<Option<RevisionCheck>, GatewayError> {
    let Some(current) = read_roster(store, now).await? else {
        return Ok(None);
    };
    if !current
        .roster
        .accounts
        .iter()
        .any(|account| same_binding(account, binding))
    {
        return Ok(None);
    }
    Ok(Some(RevisionCheck {
        key: account_store_key(),
        expected_revision: current.revision,
    }))
}
pub fn active_binding(roster: &AccountStore) -> Option<&AccountBinding> {
    roster
        .accounts
        .iter()
        .find(|a| Some(&a.account_id) == roster.active_account_id.as_ref())
}

pub struct AccountUpdate {
    pub account_id: Option<String>,
    pub create_new: bool,
    pub credential: Option<Credential>,
    pub workspace: Option<Option<Workspace>>,
    pub activate: bool,
    pub expected: Option<AccountBinding>,
}
pub async fn update_account<S: AuthorityStore, H: AuthHost>(
    store: &S,
    host: &H,
    seed: &Bootstrap,
    input: &AccountUpdate,
) -> Result<AccountBinding, GatewayError> {
    load_roster(store, host, seed).await?;
    for _ in 0..12 {
        let key = account_store_key();
        let row = store.read(&key).await?;
        let mut roster = store::value(row.as_ref(), host.now_ms())?
            .map(|v| parse_roster(&v))
            .transpose()?
            .unwrap_or_else(|| empty(host.now_ms()));
        let previous = if input.create_new {
            None
        } else {
            roster.accounts.iter().find(|a| {
                Some(&a.account_id)
                    == input
                        .account_id
                        .as_ref()
                        .or(roster.active_account_id.as_ref())
            })
        };
        if input.account_id.is_some() && previous.is_none() {
            return Err(gateway_auth::conflict("Claude account was not found"));
        }
        if input
            .expected
            .as_ref()
            .is_some_and(|e| previous.is_none_or(|p| !same_binding(p, e)))
        {
            return Err(gateway_auth::conflict(
                "Claude account changed before update",
            ));
        }
        let credential = input
            .credential
            .clone()
            .or_else(|| previous.map(|p| p.credential.clone()))
            .ok_or_else(|| gateway_auth::invalid("Claude credential is required"))?;
        if previous.is_none() && roster.accounts.len() >= 32 {
            return Err(gateway_auth::conflict(
                "Claude account storage limit reached",
            ));
        }
        let workspace = input
            .workspace
            .clone()
            .unwrap_or_else(|| previous.and_then(|p| p.workspace.clone()));
        let account = make_account(host, credential, workspace, previous)?;
        if previous.is_none()
            && roster
                .accounts
                .iter()
                .any(|a| a.credential_fingerprint == account.credential_fingerprint)
        {
            return Err(gateway_auth::conflict(
                "This credential/workspace binding is already configured",
            ));
        }
        if let Some(index) = roster
            .accounts
            .iter()
            .position(|a| a.account_id == account.account_id)
        {
            roster.accounts[index] = account.clone();
        } else {
            roster.accounts.push(account.clone());
        }
        if input.activate || roster.active_account_id.is_none() {
            roster.active_account_id = Some(account.account_id.clone());
            roster.active_reason = if input.activate {
                "admin_selection"
            } else {
                "first_configured"
            }
            .into();
        }
        roster.updated_at_ms = host.now_ms();
        if commit(
            store,
            vec![check(&key, row.as_ref())],
            vec![put(key, &roster, None, &store::revision(host)?)?],
        )
        .await?
        {
            return Ok(account);
        }
    }
    Err(gateway_auth::conflict(
        "Claude account update changed repeatedly",
    ))
}
pub async fn select_account<S: AuthorityStore, H: AuthHost>(
    store: &S,
    host: &H,
    id: &str,
    expected: Option<&AccountBinding>,
) -> Result<bool, GatewayError> {
    for _ in 0..12 {
        let key = account_store_key();
        let row = store.read(&key).await?;
        let Some(value) = store::value(row.as_ref(), host.now_ms())? else {
            return Ok(false);
        };
        let mut roster = parse_roster(&value)?;
        if !roster.accounts.iter().any(|a| a.account_id == id) {
            return Ok(false);
        }
        if let Some(expected) = expected
            && (roster.active_account_id.as_deref() != Some(&expected.account_id)
                || !roster.accounts.iter().any(|a| same_binding(a, expected)))
        {
            return Ok(false);
        }
        if roster.active_account_id.as_deref() == Some(id) {
            return Ok(true);
        }
        roster.active_account_id = Some(id.into());
        roster.active_reason = "admin_selection".into();
        roster.updated_at_ms = host.now_ms();
        if commit(
            store,
            vec![check(&key, row.as_ref())],
            vec![put(key, &roster, None, &store::revision(host)?)?],
        )
        .await?
        {
            return Ok(true);
        }
    }
    Ok(false)
}
pub async fn remove_account<S: AuthorityStore, H: AuthHost>(
    store: &S,
    host: &H,
    seed: &Bootstrap,
    id: Option<&str>,
) -> Result<bool, GatewayError> {
    if id.is_none() {
        load_roster(store, host, seed).await?;
    }
    for _ in 0..12 {
        let key = account_store_key();
        let row = store.read(&key).await?;
        let mut roster = store::value(row.as_ref(), host.now_ms())?
            .map(|v| parse_roster(&v))
            .transpose()?
            .unwrap_or_else(|| empty(host.now_ms()));
        if id.is_some_and(|id| !roster.accounts.iter().any(|a| a.account_id == id)) {
            return Ok(false);
        }
        let target = id.map(str::to_owned).or(roster.active_account_id.clone());
        let previous = roster.accounts.len();
        roster
            .accounts
            .retain(|a| Some(&a.account_id) != target.as_ref());
        if target == roster.active_account_id {
            roster.active_account_id = roster.accounts.first().map(|a| a.account_id.clone());
            roster.active_reason = "account_removed".into();
        }
        roster.updated_at_ms = host.now_ms();
        if commit(
            store,
            vec![check(&key, row.as_ref())],
            vec![put(key, &roster, None, &store::revision(host)?)?],
        )
        .await?
        {
            return Ok(previous != roster.accounts.len());
        }
    }
    Ok(false)
}
