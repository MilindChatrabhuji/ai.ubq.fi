//! Current source Claude roster and quota evidence, never a caller-supplied authorization.
use std::collections::BTreeSet;

use gateway_core::state::{AuthorityStore, RevisionCheck};
use gateway_core::value::PortableValue;
use gateway_core::{
    GatewayError, js_string::JsString16, model::ModelId, source_json::SourceJson,
    source_serialization as source,
};
use sha2::{Digest, Sha256};

use crate::store::Transaction;
use crate::{Authority, TokenSource, invalid, keys, positive, unavailable};

#[derive(Clone, Debug, Eq, PartialEq)]
struct Binding {
    account_id: String,
    account_cohort_id: String,
    credential_fingerprint: String,
    evidence_generation: String,
    credential_kind: String,
    workspace_id: Option<JsString16>,
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
    model: ModelId,
    active_account_id: String,
    bindings: Vec<Binding>,
}

impl ClaudeCohortProof {
    pub fn model(&self) -> &ModelId {
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
fn member(value: &SourceJson, name: &str) -> Option<SourceJson> {
    source::member(value, name)
}
fn scalar(value: &SourceJson, name: &str) -> Option<String> {
    source::string(&member(value, name)?).and_then(|v| v.try_utf8().ok())
}
fn opaque(value: String) -> Option<String> {
    (value.len() == 36
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b'-'))
    .then_some(value)
}
fn fingerprint(
    kind: &str,
    secret: &JsString16,
    workspace: Option<&JsString16>,
) -> Result<String, GatewayError> {
    let input = source::json_array(&[
        SourceJson::from_serializable(kind)?,
        secret.to_source_json()?,
        SourceJson::from_serializable(&workspace)?,
    ])?;
    let input = source::canonical(&input)?;
    let mut output = String::with_capacity(64);
    for byte in Sha256::digest(input.as_bytes()) {
        output.push(char::from(b"0123456789abcdef"[usize::from(byte >> 4)]));
        output.push(char::from(b"0123456789abcdef"[usize::from(byte & 15)]));
    }
    Ok(output)
}
fn safe_integer(value: &SourceJson) -> Option<i64> {
    let number = source::number(value)?;
    (number.is_finite()
        && number.fract() == 0.0
        && number.abs() <= gateway_core::identity::MAX_SAFE_INTEGER as f64)
        .then_some(number as i64)
}
fn parse_binding(value: &SourceJson) -> Result<Binding, GatewayError> {
    let fail = || invalid("Claude account roster binding is malformed.");
    let account_id = scalar(value, "account_id")
        .and_then(opaque)
        .ok_or_else(fail)?;
    let account_cohort_id = scalar(value, "account_cohort_id")
        .and_then(opaque)
        .ok_or_else(fail)?;
    let evidence_generation = scalar(value, "evidence_generation")
        .and_then(opaque)
        .ok_or_else(fail)?;
    let expected = scalar(value, "credential_fingerprint").ok_or_else(fail)?;
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(fail());
    }
    let credential = member(value, "credential")
        .filter(|v| source::entries(v).is_some())
        .ok_or_else(fail)?;
    let secret = source_trim(
        member(&credential, "secret")
            .as_ref()
            .and_then(source::string)
            .ok_or_else(fail)?,
    );
    if secret.as_units().is_empty() || secret.as_units().len() > 512 {
        return Err(fail());
    }
    let kind = match scalar(&credential, "kind").as_deref() {
        Some("api_key") => "api_key",
        Some("oauth") => "oauth",
        _ => {
            let prefix = secret.prefix_units(10).try_utf8().ok();
            if prefix.as_deref().is_some_and(|s| {
                s.eq_ignore_ascii_case("sk-ant-oat") || s.eq_ignore_ascii_case("sk-ant-ort")
            }) {
                "oauth"
            } else {
                "api_key"
            }
        }
    };
    if !matches!(
        scalar(&credential, "source").as_deref(),
        Some("kv" | "CLAUDE_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN")
    ) {
        return Err(fail());
    }
    if let Some(updated) = member(&credential, "updated_at_ms").filter(|v| v.as_str() != "null")
        && !source::number(&updated).is_some_and(|v| v.is_finite() && v > 0.0)
    {
        return Err(fail());
    }
    let workspace = member(value, "workspace").ok_or_else(fail)?;
    let workspace_id = if workspace.as_str() == "null" {
        None
    } else {
        if source::entries(&workspace).is_none() {
            return Err(fail());
        }
        let id = source_trim(
            member(&workspace, "id")
                .as_ref()
                .and_then(source::string)
                .ok_or_else(fail)?,
        );
        if id.as_units().is_empty() || id.as_units().len() > 256 {
            return Err(fail());
        }
        Some(id)
    };
    if expected != fingerprint(kind, &secret, workspace_id.as_ref())? {
        return Err(invalid(
            "Claude credential fingerprint does not match its current binding.",
        ));
    }
    Ok(Binding {
        account_id,
        account_cohort_id,
        credential_fingerprint: expected,
        evidence_generation,
        credential_kind: kind.into(),
        workspace_id,
    })
}
fn roster(value: &SourceJson) -> Result<Option<View>, GatewayError> {
    let fail = || invalid("Claude account roster is malformed.");
    if value.as_str() == "null" {
        return Ok(None);
    }
    if member(value, "v").as_ref().and_then(safe_integer) != Some(1)
        || member(value, "active_reason")
            .as_ref()
            .and_then(source::string)
            .is_none()
        || member(value, "updated_at_ms")
            .as_ref()
            .and_then(safe_integer)
            .and_then(|v| positive(v).ok())
            .is_none()
    {
        return Err(fail());
    }
    let rows = member(value, "accounts")
        .as_ref()
        .and_then(source::array)
        .filter(|v| v.len() <= 32)
        .ok_or_else(fail)?;
    let bindings = rows
        .iter()
        .map(parse_binding)
        .collect::<Result<Vec<_>, _>>()?;
    let mut ids = BTreeSet::new();
    if bindings.iter().any(|b| !ids.insert(b.account_id.clone())) {
        return Err(fail());
    }
    let active = member(value, "active_account_id").ok_or_else(fail)?;
    if active.as_str() == "null" {
        return Ok(None);
    }
    let active = source::string(&active)
        .and_then(|v| v.try_utf8().ok())
        .filter(|v| ids.contains(v))
        .ok_or_else(fail)?;
    Ok(Some(View {
        active_account_id: active,
        bindings,
        proven: false,
    }))
}

fn applicable(value: &SourceJson, binding: &Binding, model: &ModelId, now: i64) -> bool {
    let get = |value: &SourceJson, name: &str| source::member(value, name);
    let positive_time = |value: &SourceJson| {
        source::number(value)
            .filter(|number| {
                number.is_finite()
                    && number.fract() == 0.0
                    && *number > 0.0
                    && *number <= gateway_core::identity::MAX_SAFE_INTEGER as f64
            })
            .map(|n| n as i64)
    };
    if !get(value, "updated_at_ms")
        .as_ref()
        .and_then(source::number)
        .is_some_and(|n| n.is_finite() && n > 0.0)
    {
        return false;
    }
    get(value, "pool_proofs")
        .as_ref()
        .and_then(source::entries)
        .is_some_and(|proofs| {
            proofs.iter().any(|(_, proof)| {
                let Some(observed) = get(proof, "observed_at_ms")
                    .as_ref()
                    .and_then(positive_time)
                else {
                    return false;
                };
                let Some(expires) = get(proof, "expires_at_ms").as_ref().and_then(positive_time)
                else {
                    return false;
                };
                observed <= now
                    && expires > now
                    && expires > observed
                    && get(proof, "evidence_generation")
                        .as_ref()
                        .and_then(source::string)
                        .is_some_and(|s| {
                            s.as_units()
                                .iter()
                                .copied()
                                .eq(binding.evidence_generation.encode_utf16())
                        })
                    && match get(proof, "kind")
                        .as_ref()
                        .and_then(source::string)
                        .and_then(|s| s.try_utf8().ok())
                        .as_deref()
                    {
                        Some("auth_invalid") => {
                            get(proof, "model_id").is_some_and(|v| v.as_str() == "null")
                        }
                        Some("quota_exhausted") => get(proof, "model_id")
                            .as_ref()
                            .and_then(source::string)
                            .is_some_and(|id| {
                                !id.as_units().is_empty() && &ModelId::from_source(id) == model
                            }),
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

fn proof_fields(value: &PortableValue, names: &[&str]) -> SourceJson {
    source::object(
        names
            .iter()
            .filter_map(|&name| {
                let scalar = match property(value, name)? {
                    PortableValue::Null => SourceJson::parse("null").ok()?,
                    PortableValue::String(value) => SourceJson::from_serializable(value).ok()?,
                    PortableValue::StringUtf16(value) => value.to_source_json().ok()?,
                    value @ PortableValue::NumberBits(_) => {
                        SourceJson::from_serializable(&value.number_value()?).ok()?
                    }
                    _ => return None,
                };
                Some((name, scalar))
            })
            .collect(),
    )
    .expect("finite proof metadata")
}
/// Project the existing finite proof inputs only, preserving source model units.
/// Unrelated native extras and Object.values keys remain outside proof inputs.
pub(crate) fn quota_proof_metadata(value: &PortableValue) -> SourceJson {
    let row = proof_fields(value, &["updated_at_ms"]);
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
            .map(|(_, value)| proof_fields(value, &fields))
            .collect(),
        Some(PortableValue::ObjectUtf16(items)) => items
            .iter()
            .map(|(_, value)| proof_fields(value, &fields))
            .collect(),
        _ => return row,
    };
    let proofs = source::object_keys(
        values
            .into_iter()
            .enumerate()
            .map(|(i, value)| (JsString16::from_utf8(&i.to_string()), value))
            .collect(),
    )
    .expect("finite proof inputs");
    source::object(vec![
        (
            "updated_at_ms",
            source::member(&row, "updated_at_ms")
                .unwrap_or_else(|| SourceJson::parse("null").expect("null")),
        ),
        ("pool_proofs", proofs),
    ])
    .expect("finite proof metadata")
}

async fn read_view<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    model: &ModelId,
) -> Result<Option<View>, GatewayError> {
    let Some(raw) = tx
        .read_source_control::<SourceJson>(&keys::claude_accounts())
        .await?
    else {
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
        model: &ModelId,
        now: i64,
    ) -> Result<Option<ClaudeCohortProof>, GatewayError> {
        if gateway_schema::reasoning::js_trim_source(model.as_js_string())
            .as_units()
            .is_empty()
        {
            return Err(invalid("Missing authority model."));
        }
        for _ in 0..128 {
            let mut tx = self.transaction(self.fresh_time(now)?)?;
            let _ = read_view(&mut tx, model).await?;
            tx.now = self.fresh_time(tx.now)?;
            let Some(view) = read_view(&mut tx, model).await?.filter(|view| view.proven) else {
                return Ok(None);
            };
            let proof = ClaudeCohortProof {
                checks: tx.checks(),
                model: model.clone(),
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
        model: &ModelId,
        now: i64,
    ) -> Result<(), GatewayError> {
        let fail = || {
            unavailable(
                "claude_code_upstream_unreachable",
                "Claude full-pool proof is stale, expired, or not applicable.",
            )
        };
        if &proof.model != model || proof.bindings.is_empty() {
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

#[cfg(test)]
mod source_binding_tests;
