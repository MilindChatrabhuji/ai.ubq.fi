//! Source Claude principal policy. Parsing data never mints a routing/cohort capability.
use crate::store;
use gateway_auth::{
    AuthHost, conflict, invalid,
    store::{check, commit},
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    state::{AuthorityStore, RecordKey, RevisionCheck, StoredRecord},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{cmp::Ordering, collections::BTreeSet};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicySource {
    Env,
    Kv,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ClaudeAccessPolicy {
    pub v: u32,
    pub source: PolicySource,
    pub allowed_key_ids: Vec<JsString16>,
    pub updated_at_ms: i64,
}
impl ClaudeAccessPolicy {
    /// Compare existing authenticated scalar IDs without widening their domain.
    /// Source-only units cannot be replaced or turned into a different principal.
    pub fn allows_scalar(&self, key: &str) -> bool {
        !key.is_empty()
            && self
                .allowed_key_ids
                .iter()
                .any(|id| id.as_units().iter().copied().eq(key.encode_utf16()))
    }
}
#[derive(Clone, Debug)]
pub struct AccessRead {
    pub policy: ClaudeAccessPolicy,
    pub check: RevisionCheck,
}
pub fn policy_key() -> RecordKey {
    store::key(json!(["uos_ai", "claude_code_access", "v1"]))
}
fn unique_source_ids(value: &SourceJson) -> Result<Vec<JsString16>, GatewayError> {
    let values = source::array(value)
        .filter(|values| values.len() <= 1000)
        .ok_or_else(|| invalid("allowed_key_ids must be an explicit array of principal IDs"))?;
    let mut seen = BTreeSet::new();
    let mut ids = Vec::new();
    for value in values {
        let id = source::string(&value)
            .filter(|id| {
                !gateway_admin::source_input::trim(id).as_units().is_empty()
                    && id.as_units().len() <= 256
                    && !id.as_units().iter().any(|&unit| {
                        gateway_admin::source_input::whitespace(unit)
                            || unit == 44
                            || unit < 32
                            || unit == 127
                    })
            })
            .ok_or_else(|| invalid("allowed_key_ids must be an explicit array of principal IDs"))?;
        if seen.insert(id.clone()) {
            ids.push(id);
        }
    }
    Ok(ids)
}
fn sort_ids(
    ids: Vec<JsString16>,
    compare: &impl Fn(&JsString16, &JsString16) -> Result<Ordering, GatewayError>,
) -> Result<Vec<JsString16>, GatewayError> {
    gateway_schema::aliases::sort_source(ids, compare)
}
pub fn parse_source_ids(
    value: &SourceJson,
    compare: &impl Fn(&JsString16, &JsString16) -> Result<Ordering, GatewayError>,
) -> Result<Vec<JsString16>, GatewayError> {
    sort_ids(unique_source_ids(value)?, compare)
}
/// Actual scalar compatibility input only; authoritative source rows use the source entrypoint.
pub fn parse_ids(
    value: &Value,
    compare: &impl Fn(&JsString16, &JsString16) -> Result<Ordering, GatewayError>,
) -> Result<Vec<JsString16>, GatewayError> {
    parse_source_ids(&SourceJson::from_serializable(value)?, compare)
}
pub fn parse_source_policy(
    value: &SourceJson,
    compare: &impl Fn(&JsString16, &JsString16) -> Result<Ordering, GatewayError>,
) -> Result<ClaudeAccessPolicy, GatewayError> {
    let malformed =
        || store::corrupt("Claude principal policy is invalid; refusing environment fallback");
    if source::member(value, "v").as_ref().and_then(source::number) != Some(1.0) {
        return Err(malformed());
    }
    let origin = source::member(value, "source")
        .as_ref()
        .and_then(source::string)
        .ok_or_else(malformed)?;
    let origin = if origin.as_units().iter().copied().eq("env".encode_utf16()) {
        PolicySource::Env
    } else if origin.as_units().iter().copied().eq("kv".encode_utf16()) {
        PolicySource::Kv
    } else {
        return Err(malformed());
    };
    let updated_at_ms = source::member(value, "updated_at_ms")
        .as_ref()
        .and_then(source::number)
        .filter(|n| {
            n.is_finite()
                && n.fract() == 0.0
                && *n > 0.0
                && *n <= gateway_core::identity::MAX_SAFE_INTEGER as f64
        })
        .ok_or_else(malformed)? as i64;
    let ids = source::member(value, "allowed_key_ids")
        .as_ref()
        .map(unique_source_ids)
        .transpose()
        .map_err(|_| malformed())?
        .ok_or_else(malformed)?;
    Ok(ClaudeAccessPolicy {
        v: 1,
        source: origin,
        allowed_key_ids: sort_ids(ids, compare)?,
        updated_at_ms,
    })
}
pub fn parse_policy(
    value: &Value,
    compare: &impl Fn(&JsString16, &JsString16) -> Result<Ordering, GatewayError>,
) -> Result<ClaudeAccessPolicy, GatewayError> {
    parse_source_policy(&SourceJson::from_serializable(value)?, compare)
}
/// Data-only named singleton codec; currentness and revision fences remain explicit.
pub fn decode_policy_record(
    row: &StoredRecord,
    now: i64,
    compare: &impl Fn(&JsString16, &JsString16) -> Result<Ordering, GatewayError>,
) -> Result<Option<ClaudeAccessPolicy>, GatewayError> {
    row.validate_version()?;
    if row.expires_at_ms.is_some_and(|expiry| expiry <= now) {
        return Ok(None);
    }
    parse_source_policy(&decode_source_control_record(row)?, compare).map(Some)
}
pub fn encode_policy_record(
    revision: &str,
    policy: &ClaudeAccessPolicy,
    expiry: Option<i64>,
) -> Result<StoredRecord, GatewayError> {
    encode_source_control_record(revision, &SourceJson::from_serializable(policy)?, expiry)
}
/// `seed_ids` remains the trusted scalar environment list, never request input.
/// The returned exact revision still joins the caller's current admission transaction.
pub async fn load_policy<S: AuthorityStore, H: AuthHost>(
    store: &S,
    host: &H,
    seed_ids: &[String],
    compare: &impl Fn(&JsString16, &JsString16) -> Result<Ordering, GatewayError>,
) -> Result<AccessRead, GatewayError> {
    let key = policy_key();
    for _ in 0..8 {
        let row = store.read(&key).await?;
        if let Some(policy) = row
            .as_ref()
            .map(|row| decode_policy_record(row, host.now_ms(), compare))
            .transpose()?
            .flatten()
        {
            return Ok(AccessRead {
                policy,
                check: check(&key, row.as_ref()),
            });
        }
        let now = host.now_ms();
        if !(1..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&now) {
            return Err(invalid("Claude policy clock is invalid"));
        }
        let policy = ClaudeAccessPolicy {
            v: 1,
            source: PolicySource::Env,
            allowed_key_ids: parse_ids(&json!(seed_ids), compare)?,
            updated_at_ms: now,
        };
        let revision = store::revision(host)?;
        if commit(
            store,
            vec![check(&key, row.as_ref())],
            vec![gateway_core::state::RecordMutation::Put {
                key: key.clone(),
                record: encode_policy_record(&revision, &policy, None)?,
            }],
        )
        .await?
        {
            return Ok(AccessRead {
                policy,
                check: RevisionCheck {
                    key: key.clone(),
                    expected_revision: Some(revision),
                },
            });
        }
    }
    Err(conflict("Claude principal policy changed repeatedly"))
}
