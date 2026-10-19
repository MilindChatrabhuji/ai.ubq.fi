//! Current source Claude roster and quota evidence, never a caller-supplied authorization.
use std::collections::BTreeSet;

use gateway_core::GatewayError;
use gateway_core::state::{AuthorityStore, RevisionCheck};
use gateway_core::value::PortableValue;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::store::Transaction;
use crate::{Authority, TokenSource, invalid, keys, positive, text, unavailable};

#[derive(Clone, Debug, Eq, PartialEq)]
struct Binding {
    account_id: String,
    account_cohort_id: String,
    credential_fingerprint: String,
    evidence_generation: String,
    credential_kind: String,
    workspace_id: Option<String>,
}

/// Only a successful strong-read/check-only CAS can construct this secretless proof.
/// It deliberately has neither a public constructor nor serialization implementations.
/// ```compile_fail
/// use gateway_authority::claude::ClaudeCohortProof;
/// let forged: ClaudeCohortProof = serde_json::from_str("{}").unwrap();
/// ```
#[derive(Clone, Debug)]
pub struct ClaudeCohortProof {
    checks: Vec<RevisionCheck>,
    model: String,
    active_account_id: String,
    bindings: Vec<Binding>,
}

impl ClaudeCohortProof {
    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn selected_count(&self) -> usize {
        self.bindings.len()
    }
}

struct View {
    active_account_id: String,
    bindings: Vec<Binding>,
    proven: bool,
}

fn source_trim(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(c,
        '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

fn opaque(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        value.len() == 36
            && value
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b'-')
    })
}

fn fingerprint(kind: &str, secret: &str, workspace: Option<&str>) -> Result<String, GatewayError> {
    let input = serde_json::to_vec(&(kind, secret, workspace))
        .map_err(|_| invalid("Claude credential binding could not be encoded."))?;
    let mut output = String::with_capacity(64);
    for byte in Sha256::digest(input) {
        output.push(char::from(b"0123456789abcdef"[usize::from(byte >> 4)]));
        output.push(char::from(b"0123456789abcdef"[usize::from(byte & 15)]));
    }
    Ok(output)
}

fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite()
        && number.fract() == 0.0
        && number.abs() <= gateway_core::identity::MAX_SAFE_INTEGER as f64)
        .then_some(number as i64)
}

fn parse_binding(value: &Value) -> Result<Binding, GatewayError> {
    let fail = || invalid("Claude account roster binding is malformed.");
    let account_id = opaque(&value["account_id"]).ok_or_else(fail)?;
    let account_cohort_id = opaque(&value["account_cohort_id"]).ok_or_else(fail)?;
    let evidence_generation = opaque(&value["evidence_generation"]).ok_or_else(fail)?;
    let expected = value["credential_fingerprint"].as_str().ok_or_else(fail)?;
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(fail());
    }
    let credential = value
        .get("credential")
        .filter(|value| value.is_object())
        .ok_or_else(fail)?;
    let secret = source_trim(credential["secret"].as_str().ok_or_else(fail)?);
    if secret.is_empty() || secret.encode_utf16().count() > 512 {
        return Err(fail());
    }
    let kind = match credential["kind"].as_str() {
        Some("api_key") => "api_key",
        Some("oauth") => "oauth",
        _ => {
            let prefix = secret.to_ascii_lowercase();
            if prefix.starts_with("sk-ant-oat") || prefix.starts_with("sk-ant-ort") {
                "oauth"
            } else {
                "api_key"
            }
        }
    };
    if !matches!(
        credential["source"].as_str(),
        Some("kv" | "CLAUDE_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN")
    ) {
        return Err(fail());
    }
    if let Some(updated) = credential
        .get("updated_at_ms")
        .filter(|value| !value.is_null())
        && !updated
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0)
    {
        return Err(fail());
    }
    let workspace_id = match value.get("workspace") {
        Some(Value::Null) => None,
        Some(workspace) if workspace.is_object() => {
            let id = source_trim(workspace["id"].as_str().ok_or_else(fail)?);
            if id.is_empty() || id.encode_utf16().count() > 256 {
                return Err(fail());
            }
            Some(id.to_owned())
        }
        _ => return Err(fail()),
    };
    if expected != fingerprint(kind, secret, workspace_id.as_deref())? {
        return Err(invalid(
            "Claude credential fingerprint does not match its current binding.",
        ));
    }
    Ok(Binding {
        account_id: account_id.to_owned(),
        account_cohort_id: account_cohort_id.to_owned(),
        credential_fingerprint: expected.to_owned(),
        evidence_generation: evidence_generation.to_owned(),
        credential_kind: kind.to_owned(),
        workspace_id,
    })
}

fn roster(value: &Value) -> Result<Option<View>, GatewayError> {
    let fail = || invalid("Claude account roster is malformed.");
    if value.is_null() {
        return Ok(None);
    }
    if safe_integer(&value["v"]) != Some(1)
        || !value["active_reason"].is_string()
        || safe_integer(&value["updated_at_ms"])
            .and_then(|value| positive(value).ok())
            .is_none()
    {
        return Err(fail());
    }
    let rows = value["accounts"]
        .as_array()
        .filter(|rows| rows.len() <= 32)
        .ok_or_else(fail)?;
    let bindings = rows
        .iter()
        .map(parse_binding)
        .collect::<Result<Vec<_>, _>>()?;
    let mut ids = BTreeSet::new();
    if bindings
        .iter()
        .any(|binding| !ids.insert(binding.account_id.clone()))
    {
        return Err(fail());
    }
    let active = value.get("active_account_id").ok_or_else(fail)?;
    if active.is_null() {
        return Ok(None);
    }
    let active = active
        .as_str()
        .filter(|active| ids.contains(*active))
        .ok_or_else(fail)?;
    Ok(Some(View {
        active_account_id: active.to_owned(),
        bindings,
        proven: false,
    }))
}

fn applicable(value: &Value, binding: &Binding, model: &str, now: i64) -> bool {
    if !value["updated_at_ms"]
        .as_f64()
        .is_some_and(|value| value.is_finite() && value > 0.0)
    {
        return false;
    }
    value["pool_proofs"].as_object().is_some_and(|proofs| {
        proofs.values().any(|proof| {
            let Some(observed) =
                safe_integer(&proof["observed_at_ms"]).filter(|value| positive(*value).is_ok())
            else {
                return false;
            };
            let Some(expires) =
                safe_integer(&proof["expires_at_ms"]).filter(|value| positive(*value).is_ok())
            else {
                return false;
            };
            observed <= now
                && expires > now
                && expires > observed
                && proof["evidence_generation"].as_str()
                    == Some(binding.evidence_generation.as_str())
                && match proof["kind"].as_str() {
                    Some("auth_invalid") => proof.get("model_id") == Some(&Value::Null),
                    Some("quota_exhausted") => proof["model_id"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty() && id == model),
                    _ => false,
                }
        })
    })
}

fn property<'a>(value: &'a PortableValue, name: &str) -> Option<&'a PortableValue> {
    match value {
        PortableValue::Object(items) => items
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value),
        PortableValue::ObjectUtf16(items) => items
            .iter()
            .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
            .map(|(_, value)| value),
        _ => None,
    }
}

fn proof_fields(value: &PortableValue, names: &[&str]) -> serde_json::Map<String, Value> {
    names
        .iter()
        .filter_map(|&name| {
            let scalar = match property(value, name)? {
                PortableValue::Null => Value::Null,
                PortableValue::String(value) => Value::String(value.clone()),
                PortableValue::StringUtf16(value) => Value::String(value.try_utf8().ok()?),
                value @ PortableValue::NumberBits(_) => {
                    Value::Number(serde_json::Number::from_f64(value.number_value()?)?)
                }
                _ => return None,
            };
            Some((name.to_owned(), scalar))
        })
        .collect()
}

/// Project proof inputs only. Operator values and Object.values keys are not JSON inputs.
pub(crate) fn quota_proof_metadata(value: &PortableValue) -> Value {
    let mut row = proof_fields(value, &["updated_at_ms"]);
    let fields = [
        "kind",
        "model_id",
        "observed_at_ms",
        "expires_at_ms",
        "evidence_generation",
    ];
    let values: Vec<_> = match property(value, "pool_proofs") {
        Some(PortableValue::Object(items)) => items
            .iter()
            .map(|(_, value)| Value::Object(proof_fields(value, &fields)))
            .collect(),
        Some(PortableValue::ObjectUtf16(items)) => items
            .iter()
            .map(|(_, value)| Value::Object(proof_fields(value, &fields)))
            .collect(),
        _ => return Value::Object(row),
    };
    row.insert(
        "pool_proofs".to_owned(),
        Value::Object(
            values
                .into_iter()
                .enumerate()
                .map(|(index, value)| (index.to_string(), value))
                .collect(),
        ),
    );
    Value::Object(row)
}

async fn read_view<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    model: &str,
) -> Result<Option<View>, GatewayError> {
    let Some(raw) = tx.read::<Value>(&keys::claude_accounts()).await? else {
        return Ok(None);
    };
    let Some(mut view) = roster(&raw)? else {
        return Ok(None);
    };
    let mut proven = !view.bindings.is_empty();
    for binding in &view.bindings {
        let raw = tx
            .read_claude_quota(&binding.account_id, &binding.account_cohort_id)
            .await?;
        proven &= raw
            .as_ref()
            .is_some_and(|raw| applicable(raw, binding, model, tx.now));
    }
    view.proven = proven;
    Ok(Some(view))
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    /// Missing, empty, no-active, or incompletely proven pools are never exhaustion proof.
    pub async fn prove_claude_unavailable(
        &self,
        model: &str,
        now: i64,
    ) -> Result<Option<ClaudeCohortProof>, GatewayError> {
        text(model)?;
        for _ in 0..128 {
            let mut tx = self.transaction(self.fresh_time(now)?)?;
            let _ = read_view(&mut tx, model).await?;
            tx.now = self.fresh_time(tx.now)?;
            let Some(view) = read_view(&mut tx, model).await?.filter(|view| view.proven) else {
                return Ok(None);
            };
            let proof = ClaudeCohortProof {
                checks: tx.checks(),
                model: model.to_owned(),
                active_account_id: view.active_account_id,
                bindings: view.bindings,
            };
            if tx.commit().await? {
                return Ok(Some(proof));
            }
        }
        Err(unavailable(
            "claude_code_upstream_unreachable",
            "Claude account evidence changed repeatedly.",
        ))
    }

    pub(crate) async fn require_claude_proof(
        &self,
        tx: &mut Transaction<'_, S, I>,
        proof: &ClaudeCohortProof,
        model: &str,
        now: i64,
    ) -> Result<(), GatewayError> {
        let fail = || {
            unavailable(
                "claude_code_upstream_unreachable",
                "Claude full-pool proof is stale, expired, or not applicable.",
            )
        };
        if proof.model != model || proof.bindings.is_empty() {
            return Err(fail());
        }
        tx.now = self.fresh_time(tx.now.max(now))?;
        let _ = read_view(tx, model).await?;
        for check in &proof.checks {
            if !tx.expect(&check.key, &check.expected_revision) {
                return Err(fail());
            }
        }
        tx.now = self.fresh_time(tx.now)?;
        let Some(view) = read_view(tx, model).await? else {
            return Err(fail());
        };
        if !view.proven
            || view.active_account_id != proof.active_account_id
            || view.bindings != proof.bindings
        {
            return Err(fail());
        }
        Ok(())
    }
}
