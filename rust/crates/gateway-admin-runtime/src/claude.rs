//! Source Claude roster and current-generation fences. Secret-bearing records never form admin JSON.
use crate::store;
use gateway_auth::{
    AuthHost,
    crypto::sha256_hex,
    store::{check, commit},
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    state::{AuthorityStore, RecordKey, RecordMutation, RevisionCheck, StoredRecord},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
#[path = "claude_source_secret.rs"]
mod source_secret;
pub use source_secret::ClaudeSourceSecret;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    ApiKey,
    Oauth,
}
#[derive(Clone, Eq, PartialEq)]
pub struct Credential {
    pub kind: CredentialKind,
    pub secret: Arc<ClaudeSourceSecret>,
    pub hint: JsString16,
    pub label: Option<JsString16>,
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
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Workspace {
    pub id: JsString16,
    pub name: Option<JsString16>,
    pub source: String,
    pub discovered_at_ms: Option<i64>,
    pub verified_at_ms: Option<i64>,
    pub last_error: Option<JsString16>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountBinding {
    pub account_id: String,
    pub account_cohort_id: String,
    pub credential_fingerprint: String,
    pub evidence_generation: String,
    pub credential: Credential,
    pub workspace: Option<Workspace>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountStore {
    pub v: u32,
    pub accounts: Vec<AccountBinding>,
    pub active_account_id: Option<String>,
    pub active_reason: JsString16,
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
fn raw<T: Serialize + ?Sized>(value: &T) -> SourceJson {
    SourceJson::from_serializable(value).expect("finite source data")
}
fn member(value: &SourceJson, name: &str) -> Option<SourceJson> {
    source::member(value, name)
}
fn scalar(value: &SourceJson, name: &str) -> Option<String> {
    source::string(&member(value, name)?).and_then(|v| v.try_utf8().ok())
}
fn source_trim(value: JsString16) -> JsString16 {
    let units = value.as_units();
    let whitespace =
        |u: &u16| char::from_u32(u32::from(*u)).is_some_and(gateway_schema::util::js_whitespace);
    let start = units
        .iter()
        .position(|u| !whitespace(u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !whitespace(u))
        .map_or(start, |i| i + 1);
    JsString16::from_units(units[start..end].to_vec())
}
fn text(value: &SourceJson, name: &str) -> Option<JsString16> {
    let s = source_trim(source::string(&member(value, name)?)?);
    (!s.as_units().is_empty()).then_some(s)
}
fn finite_positive(value: Option<SourceJson>) -> Option<i64> {
    value
        .as_ref()
        .and_then(source::number)
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| v.trunc() as i64)
}
fn with_field(value: &SourceJson, name: &str, new: SourceJson) -> Option<SourceJson> {
    let mut entries = source::entries(value)?;
    let key = JsString16::from_utf8(name);
    entries.retain(|(k, _)| k != &key);
    entries.push((key, new));
    source::object_keys(entries).ok()
}
pub fn fingerprint(credential: &Credential, workspace: Option<&Workspace>) -> String {
    let tuple = source::json_array(&[
        raw(&credential.kind),
        credential.secret.source_json(),
        raw(&workspace.map(|w| &w.id)),
    ])
    .expect("source tuple");
    sha256_hex(
        source::canonical(&tuple)
            .expect("source stringify")
            .as_bytes(),
    )
}
pub fn same_binding(left: &AccountBinding, right: &AccountBinding) -> bool {
    left.account_id == right.account_id
        && left.account_cohort_id == right.account_cohort_id
        && left.evidence_generation == right.evidence_generation
        && left.credential_fingerprint == right.credential_fingerprint
}
pub fn parse_source_credential(value: &SourceJson, origin: &str) -> Option<Credential> {
    let secret = text(value, "secret")?;
    if secret.as_units().len() > 512 {
        return None;
    }
    let kind = match scalar(value, "kind").as_deref() {
        Some("api_key") => CredentialKind::ApiKey,
        Some("oauth") => CredentialKind::Oauth,
        _ => {
            let prefix = secret.prefix_units(10).try_utf8().ok();
            if prefix.as_deref().is_some_and(|s| {
                s.eq_ignore_ascii_case("sk-ant-oat") || s.eq_ignore_ascii_case("sk-ant-ort")
            }) {
                CredentialKind::Oauth
            } else {
                CredentialKind::ApiKey
            }
        }
    };
    let time = finite_positive(member(value, "updated_at_ms"))?;
    let secret = Arc::new(ClaudeSourceSecret::from_source(secret));
    Some(Credential {
        kind,
        hint: text(value, "hint").unwrap_or_else(|| secret.hint()),
        secret,
        label: text(value, "label"),
        source: origin.into(),
        updated_at_ms: Some(time),
    })
}
/// Builds only the existing submitted credential data; actual validation remains host-owned.
pub fn submitted_credential(
    secret: Arc<ClaudeSourceSecret>,
    label: Option<JsString16>,
    updated_at_ms: i64,
) -> Option<Credential> {
    let document = source::object(vec![
        ("secret", secret.source_json()),
        ("label", raw(&label)),
        ("updated_at_ms", raw(&updated_at_ms)),
    ])
    .ok()?;
    let mut credential = parse_source_credential(&document, "kv")?;
    // Submission parsing already owns trim/length policy. Source writes retain
    // an explicit empty label; the stored-record reader later normalizes it.
    credential.label = label;
    Some(credential)
}
pub fn parse_source_workspace(value: &SourceJson) -> Option<Workspace> {
    let id = text(value, "id")?;
    if id.as_units().len() > 256 {
        return None;
    }
    let origin = scalar(value, "source")
        .filter(|v| ["kv", "env", "discovered"].contains(&v.as_str()))
        .unwrap_or_else(|| "kv".into());
    Some(Workspace {
        id,
        name: text(value, "name"),
        source: origin,
        discovered_at_ms: finite_positive(member(value, "discovered_at_ms")),
        verified_at_ms: finite_positive(member(value, "verified_at_ms")),
        last_error: text(value, "last_error"),
    })
}
/// Scalar callers only. Authoritative source bodies/records must use the source parser directly.
pub fn parse_credential(value: &Value, origin: &str) -> Option<Credential> {
    parse_source_credential(&SourceJson::from_serializable(value).ok()?, origin)
}
pub fn parse_workspace(value: &Value) -> Option<Workspace> {
    parse_source_workspace(&SourceJson::from_serializable(value).ok()?)
}
pub fn parse_roster(value: &Value) -> Result<AccountStore, GatewayError> {
    parse_source_roster(&SourceJson::from_serializable(value)?)
}
pub fn parse_source_roster(value: &SourceJson) -> Result<AccountStore, GatewayError> {
    let invalid = || store::corrupt("Claude account roster is invalid; refusing legacy fallback");
    if member(value, "v").and_then(|v| v.deserialize::<Value>().ok()) != Some(json!(1)) {
        return Err(invalid());
    }
    let rows = source::array(&member(value, "accounts").ok_or_else(invalid)?)
        .filter(|v| v.len() <= 32)
        .ok_or_else(invalid)?;
    let mut accounts = Vec::new();
    let mut ids = BTreeSet::new();
    for row in rows {
        let id = scalar(&row, "account_id")
            .filter(|v| opaque(v))
            .ok_or_else(invalid)?;
        let cohort = scalar(&row, "account_cohort_id")
            .filter(|v| opaque(v))
            .ok_or_else(invalid)?;
        let generation = scalar(&row, "evidence_generation")
            .filter(|v| opaque(v))
            .ok_or_else(invalid)?;
        let fingerprint = scalar(&row, "credential_fingerprint")
            .filter(|v| digest(v))
            .ok_or_else(invalid)?;
        if !ids.insert(id.clone()) {
            return Err(invalid());
        }
        let credential = member(&row, "credential")
            .filter(|v| source::entries(v).is_some())
            .ok_or_else(invalid)?;
        let origin = scalar(&credential, "source")
            .filter(|v| ["kv", "CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].contains(&v.as_str()))
            .ok_or_else(invalid)?;
        let original_time = member(&credential, "updated_at_ms");
        let normalized = if original_time.as_ref().is_none_or(|v| v.as_str() == "null") {
            with_field(&credential, "updated_at_ms", raw(&1)).ok_or_else(invalid)?
        } else {
            credential.clone()
        };
        let mut credential = parse_source_credential(&normalized, &origin).ok_or_else(invalid)?;
        if original_time.as_ref().is_some_and(|v| v.as_str() == "null") {
            credential.updated_at_ms = None;
        }
        let workspace = member(&row, "workspace").ok_or_else(invalid)?;
        let workspace = if workspace.as_str() == "null" {
            None
        } else {
            Some(parse_source_workspace(&workspace).ok_or_else(invalid)?)
        };
        accounts.push(AccountBinding {
            account_id: id,
            account_cohort_id: cohort,
            credential_fingerprint: fingerprint,
            evidence_generation: generation,
            credential,
            workspace,
        });
    }
    let active = member(value, "active_account_id").ok_or_else(invalid)?;
    let active = if active.as_str() == "null" {
        None
    } else {
        Some(
            source::string(&active)
                .and_then(|v| v.try_utf8().ok())
                .filter(|id| accounts.iter().any(|a| a.account_id == *id))
                .ok_or_else(invalid)?,
        )
    };
    let reason = member(value, "active_reason")
        .as_ref()
        .and_then(source::string)
        .ok_or_else(invalid)?;
    let time = member(value, "updated_at_ms")
        .and_then(|v| v.deserialize::<i64>().ok())
        .filter(|v| *v > 0 && *v <= gateway_core::identity::MAX_SAFE_INTEGER)
        .ok_or_else(invalid)?;
    Ok(AccountStore {
        v: 1,
        accounts,
        active_account_id: active,
        active_reason: reason,
        updated_at_ms: time,
    })
}
fn credential_source(value: &Credential) -> SourceJson {
    source::object(vec![
        ("kind", raw(&value.kind)),
        ("secret", value.secret.source_json()),
        ("hint", raw(&value.hint)),
        ("label", raw(&value.label)),
        ("source", raw(&value.source)),
        ("updated_at_ms", raw(&value.updated_at_ms)),
    ])
    .expect("named credential source")
}
fn roster_source(value: &AccountStore) -> SourceJson {
    let accounts = value
        .accounts
        .iter()
        .map(|a| {
            source::object(vec![
                ("account_id", raw(&a.account_id)),
                ("account_cohort_id", raw(&a.account_cohort_id)),
                ("credential_fingerprint", raw(&a.credential_fingerprint)),
                ("evidence_generation", raw(&a.evidence_generation)),
                ("credential", credential_source(&a.credential)),
                ("workspace", raw(&a.workspace)),
            ])
            .expect("named account source")
        })
        .collect::<Vec<_>>();
    source::object(vec![
        ("v", raw(&value.v)),
        (
            "accounts",
            source::json_array(&accounts).expect("named account array"),
        ),
        ("active_account_id", raw(&value.active_account_id)),
        ("active_reason", raw(&value.active_reason)),
        ("updated_at_ms", raw(&value.updated_at_ms)),
    ])
    .expect("named roster source")
}
fn source_value(row: Option<&StoredRecord>, now: i64) -> Result<Option<SourceJson>, GatewayError> {
    let Some(row) = row else { return Ok(None) };
    row.validate_version()?;
    if row.expires_at_ms.is_some_and(|at| at <= now) {
        return Ok(None);
    }
    decode_source_control_record(row).map(Some)
}
pub fn encode_credential_record(
    revision: &str,
    value: &Credential,
    expiry: Option<i64>,
) -> Result<StoredRecord, GatewayError> {
    encode_source_control_record(revision, &credential_source(value), expiry)
}
pub fn encode_workspace_record(
    revision: &str,
    value: &Workspace,
    expiry: Option<i64>,
) -> Result<StoredRecord, GatewayError> {
    encode_source_control_record(revision, &raw(value), expiry)
}
pub fn encode_roster_record(
    revision: &str,
    value: &AccountStore,
    expiry: Option<i64>,
) -> Result<StoredRecord, GatewayError> {
    encode_source_control_record(revision, &roster_source(value), expiry)
}
pub fn decode_credential_record(
    row: &StoredRecord,
    now: i64,
) -> Result<Option<Credential>, GatewayError> {
    Ok(source_value(Some(row), now)?.and_then(|v| parse_source_credential(&v, "kv")))
}
pub fn decode_workspace_record(
    row: &StoredRecord,
    now: i64,
) -> Result<Option<Workspace>, GatewayError> {
    Ok(source_value(Some(row), now)?.and_then(|v| parse_source_workspace(&v)))
}
pub fn decode_roster_record(
    row: &StoredRecord,
    now: i64,
) -> Result<Option<AccountStore>, GatewayError> {
    source_value(Some(row), now)?
        .map(|v| parse_source_roster(&v))
        .transpose()
}
fn put_roster(roster: &AccountStore, revision: &str) -> Result<RecordMutation, GatewayError> {
    Ok(RecordMutation::Put {
        key: account_store_key(),
        record: encode_roster_record(revision, roster, None)?,
    })
}
pub async fn read_roster<S: AuthorityStore>(
    store: &S,
    now: i64,
) -> Result<Option<RosterRead>, GatewayError> {
    let row = store.read(&account_store_key()).await?;
    source_value(row.as_ref(), now)?
        .map(|value| {
            Ok(RosterRead {
                roster: parse_source_roster(&value)?,
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
        active_reason: JsString16::from_utf8("unconfigured"),
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
        if let Some(value) = source_value(row.as_ref(), host.now_ms())? {
            return Ok(RosterRead {
                roster: parse_source_roster(&value)?,
                revision: row.map(|r| r.revision),
            });
        }
        let ck = legacy_credential_key();
        let cr = store.read(&ck).await?;
        let wk = legacy_workspace_key();
        let wr = store.read(&wk).await?;
        let credential = source_value(cr.as_ref(), host.now_ms())?
            .and_then(|v| parse_source_credential(&v, "kv"))
            .or_else(|| seed.credential.clone());
        let Some(credential) = credential else {
            return Ok(RosterRead {
                roster: empty(host.now_ms()),
                revision: None,
            });
        };
        let workspace = source_value(wr.as_ref(), host.now_ms())?
            .and_then(|v| parse_source_workspace(&v))
            .or_else(|| seed.workspace.clone());
        let account = make_account(host, credential, workspace, None)?;
        let roster = AccountStore {
            v: 1,
            active_account_id: Some(account.account_id.clone()),
            accounts: vec![account],
            active_reason: JsString16::from_utf8("singleton_bootstrap"),
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
            vec![put_roster(&roster, &revision)?],
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
        let mut roster = source_value(row.as_ref(), host.now_ms())?
            .map(|v| parse_source_roster(&v))
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
            let reason = if input.activate {
                "admin_selection"
            } else {
                "first_configured"
            };
            roster.active_reason = JsString16::from_utf8(reason);
        }
        roster.updated_at_ms = host.now_ms();
        if commit(
            store,
            vec![check(&key, row.as_ref())],
            vec![put_roster(&roster, &store::revision(host)?)?],
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
        let Some(value) = source_value(row.as_ref(), host.now_ms())? else {
            return Ok(false);
        };
        let mut roster = parse_source_roster(&value)?;
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
        roster.active_reason = JsString16::from_utf8("admin_selection");
        roster.updated_at_ms = host.now_ms();
        if commit(
            store,
            vec![check(&key, row.as_ref())],
            vec![put_roster(&roster, &store::revision(host)?)?],
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
        let mut roster = source_value(row.as_ref(), host.now_ms())?
            .map(|v| parse_source_roster(&v))
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
            roster.active_reason = JsString16::from_utf8("account_removed");
        }
        roster.updated_at_ms = host.now_ms();
        if commit(
            store,
            vec![check(&key, row.as_ref())],
            vec![put_roster(&roster, &store::revision(host)?)?],
        )
        .await?
        {
            return Ok(previous != roster.accounts.len());
        }
    }
    Ok(false)
}

#[cfg(test)]
#[path = "claude_source_tests.rs"]
mod source_tests;
