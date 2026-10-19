use gateway_auth::{
    AuthHost, AuthPrincipal, AuthResponse,
    api_keys::{self, ApiKeyHashRecord, WEEK_MS},
    conflict,
    crypto::{Secret, sha256_base64url, uuid_from_random},
    invalid, store,
};
use gateway_authority::quota::{ApiKeyPolicy as AuthorityKeyPolicy, ApiUsageWindow};
use gateway_core::identity::ApiKeyId;
use gateway_core::{
    GatewayError,
    state::{AuthorityStore, RecordKey, RecordMutation, RevisionCheck},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{AdminHost, AdminOperation, PaidKeyFields, audit};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ApiKeyRecord {
    #[serde(flatten)]
    pub policy: ApiKeyHashRecord,
    pub name: String,
    pub prefix: String,
    pub hash: String,
    pub created_at_ms: i64,
    pub paid_fallback_model_ids: Vec<String>,
    pub paid_fallback_quota_per_credit: i64,
    #[serde(default)]
    pub paid_fallback_max_exposure_microcredits: std::collections::BTreeMap<String, i64>,
    pub paid_fallback_pricing_checked_at_ms: Option<i64>,
}

pub fn authority_policy_key(id: &str) -> RecordKey {
    gateway_authority::keys::api_policy(id)
}
pub fn deletion_key(id: &str) -> RecordKey {
    gateway_authority::keys::paid_deletion(id)
}
pub fn authority_policy(record: &ApiKeyRecord, now: i64) -> AuthorityKeyPolicy {
    AuthorityKeyPolicy {
        v: 3,
        key_id: ApiKeyId(record.policy.id.clone()),
        expires_at_ms: if record.policy.revoked_at_ms.is_some() {
            now
        } else {
            record.policy.expires_at_ms
        },
        usage_limit_requests: record.policy.usage_limit_requests,
        window_ms: record.policy.window_ms,
        usage_reset_at_ms: record.policy.usage_reset_at_ms,
        paid_fallback_enabled: record.policy.paid_fallback_enabled,
        paid_fallback_limit_microcredits: record.policy.paid_fallback_limit_microcredits,
        paid_fallback_quota_per_credit: record.paid_fallback_quota_per_credit,
        paid_fallback_pricing_checked_at_ms: record
            .paid_fallback_pricing_checked_at_ms
            .unwrap_or(0),
        paid_fallback_models: record.paid_fallback_model_ids.clone(),
        paid_fallback_max_exposure_microcredits: record
            .paid_fallback_max_exposure_microcredits
            .clone(),
    }
}

fn usage_window(id: &str, window: i64, now: i64) -> ApiUsageWindow {
    ApiUsageWindow {
        v: 3,
        key_id: ApiKeyId(id.into()),
        policy_version: format!("v3:{window}"),
        window_start_ms: now,
        window_reset_at_ms: now + window,
        committed_requests: 0,
        reserved_requests: 0,
        updated_at_ms: now,
        reservations: std::collections::BTreeMap::new(),
    }
}

pub fn public_record(record: &ApiKeyRecord) -> Value {
    json!({"id":record.policy.id,"name":record.name,"prefix":record.prefix,"created_at_ms":record.created_at_ms,"expires_at_ms":record.policy.expires_at_ms,"revoked_at_ms":record.policy.revoked_at_ms,"usage_limit_requests":record.policy.usage_limit_requests,"usage_requests":record.policy.usage_requests,"usage_reset_at_ms":record.policy.usage_reset_at_ms,"window_ms":record.policy.window_ms,"paid_fallback_enabled":record.policy.paid_fallback_enabled,"paid_fallback_limit_credits":record.policy.paid_fallback_limit_microcredits as f64/1_000_000.0,"paid_fallback_spent_credits":record.policy.paid_fallback_spent_microcredits as f64/1_000_000.0,"paid_fallback_reserved_credits":record.policy.paid_fallback_reserved_microcredits as f64/1_000_000.0,"paid_fallback_model_ids":record.paid_fallback_model_ids})
}

fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?.trunc();
    (number.is_finite() && number.abs() <= gateway_core::identity::MAX_SAFE_INTEGER as f64)
        .then_some(number as i64)
}
fn limit(raw: Option<&Value>, default: i64) -> Result<i64, GatewayError> {
    let value = match raw {
        None => default,
        Some(Value::Null) => 50,
        Some(value) => safe_integer(value).ok_or_else(|| {
            invalid("usage_limit_requests must be a non-negative number or -1 for unlimited")
        })?,
    };
    if value < -1 {
        return Err(invalid(
            "usage_limit_requests must be a non-negative number or -1 for unlimited",
        ));
    }
    Ok(value)
}
fn name(raw: Option<&Value>) -> Result<String, GatewayError> {
    let name = raw
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 80 && !s.contains(['\r', '\n']))
        .ok_or_else(|| invalid("name must be a non-empty string (<=80 chars)"))?;
    Ok(name.into())
}
fn expiry(raw: Option<&Value>, default: i64, now: i64) -> Result<i64, GatewayError> {
    let expiry = match raw {
        None => default,
        Some(Value::Null) => now + 7_776_000_000,
        Some(value) => safe_integer(value).ok_or_else(|| {
            invalid("expires_at_ms must be a Unix epoch ms timestamp in the future, or -1")
        })?,
    };
    if expiry != -1 && expiry <= now {
        return Err(invalid(
            "expires_at_ms must be a Unix epoch ms timestamp in the future, or -1",
        ));
    }
    Ok(expiry)
}
fn window(raw: Option<&Value>, default: i64) -> Result<i64, GatewayError> {
    let normalized = raw
        .map(|value| {
            if let Some(text) = value.as_str() {
                text.trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|n| {
                        n.is_finite() && n.abs() <= gateway_core::identity::MAX_SAFE_INTEGER as f64
                    })
                    .map(|n| n.trunc() as i64)
            } else {
                safe_integer(value)
            }
        })
        .unwrap_or(Some(default));
    let window = normalized
        .filter(|v| *v > 0)
        .ok_or_else(|| invalid("window_ms must be a positive number"))?;
    Ok(window)
}
fn retired_reset(raw: &Value) -> Result<(), GatewayError> {
    if raw.get("banked_reset_enabled").is_some() || raw.get("codex_banked_reset_enabled").is_some()
    {
        return Err(invalid(
            "Banked reset settings are account-owned; use provider controls",
        ));
    }
    Ok(())
}

async fn paid_fields<A: AdminHost>(
    host: &A,
    raw: &Value,
    old: Option<&ApiKeyRecord>,
) -> Result<PaidKeyFields, GatewayError> {
    if raw
        .get("paid_fallback_enabled")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(invalid("paid_fallback_enabled must be a boolean"));
    }
    let enabled = raw
        .get("paid_fallback_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(old.is_some_and(|v| v.policy.paid_fallback_enabled));
    let limit = if let Some(value) = raw.get("paid_fallback_limit_credits") {
        let credit = value
            .as_f64()
            .filter(|n| n.is_finite() && (*n >= 0.0 || *n == -1.0))
            .ok_or_else(|| {
                invalid("paid_fallback_limit_credits must be a non-negative number or -1")
            })?;
        if credit == -1.0 {
            -1
        } else {
            let micro = (credit * 1_000_000.0).round();
            if micro > gateway_core::identity::MAX_SAFE_INTEGER as f64 {
                return Err(invalid(
                    "paid_fallback_limit_credits must be a non-negative number or -1",
                ));
            }
            micro as i64
        }
    } else {
        old.map(|v| v.policy.paid_fallback_limit_microcredits)
            .unwrap_or(0)
    };
    if enabled && limit == 0 {
        return Err(invalid(
            "paid_fallback_limit_credits must be positive or -1 when paid fallback is enabled",
        ));
    }
    if let Some(old) = old.filter(|old| old.policy.paid_fallback_enabled || !enabled) {
        return Ok(PaidKeyFields {
            enabled,
            limit_microcredits: limit,
            model_ids: old.paid_fallback_model_ids.clone(),
            quota_per_credit: old.paid_fallback_quota_per_credit,
            max_exposure_microcredits: old.paid_fallback_max_exposure_microcredits.clone(),
            pricing_checked_at_ms: old.paid_fallback_pricing_checked_at_ms,
        });
    }
    if !enabled {
        let mut fields = PaidKeyFields::disabled();
        fields.limit_microcredits = limit;
        return Ok(fields);
    }
    let mut effective = raw.clone();
    effective["paid_fallback_enabled"] = Value::Bool(true);
    effective["paid_fallback_limit_credits"] = json!(if limit == -1 {
        -1.0
    } else {
        limit as f64 / 1_000_000.0
    });
    let fields = host.paid_key_policy(&effective).await?;
    if !fields.enabled
        || fields.limit_microcredits != limit
        || fields.quota_per_credit <= 0
        || fields.model_ids.is_empty()
        || fields.pricing_checked_at_ms.is_none()
    {
        return Err(GatewayError::unavailable(
            "Paid fallback pricing is unavailable",
            "paid_fallback_pricing_unavailable",
        ));
    }
    Ok(fields)
}

pub struct KeyService<'a, S, H, A> {
    pub store: &'a S,
    pub host: &'a H,
    pub capabilities: &'a A,
    pub release: &'a str,
}
impl<'a, S: AuthorityStore, H: AuthHost, A: AdminHost> KeyService<'a, S, H, A> {
    fn revision(&self) -> Result<String, GatewayError> {
        uuid_from_random(&self.host.random_bytes(16)?)
    }
    pub async fn create(
        &self,
        raw: &Value,
        actor: &AuthPrincipal,
        request_id: &str,
    ) -> Result<AuthResponse, GatewayError> {
        retired_reset(raw)?;
        let name = name(raw.get("name"))?;
        let token = match raw.get("token") {
            None | Some(Value::Null) => api_keys::generate_token(&self.host.random_bytes(32)?)?,
            Some(value) => {
                let value=value.as_str().map(str::trim).filter(|s|api_keys::api_key_shape(s)).ok_or_else(||invalid("token must use the u_ prefix followed by 64 lowercase hexadecimal characters"))?;
                Secret::new(value.into())
            }
        };
        let now = self.host.now_ms();
        let expires = expiry(raw.get("expires_at_ms"), now + 7_776_000_000, now)?;
        let usage = limit(raw.get("usage_limit_requests"), 50)?;
        let window = window(raw.get("window_ms"), WEEK_MS)?;
        let paid = paid_fields(self.capabilities, raw, None).await?;
        let hash = sha256_base64url(token.expose().as_bytes());
        let hk = api_keys::hash_key(&hash);
        let hr = self.store.read(&hk).await?;
        if hr.is_some() {
            return Err(conflict("API key already exists"));
        }
        let id = self.revision()?;
        let record = ApiKeyRecord {
            policy: ApiKeyHashRecord {
                id: id.clone(),
                expires_at_ms: expires,
                revoked_at_ms: None,
                usage_limit_requests: usage,
                usage_requests: 0,
                usage_reset_at_ms: now + window,
                window_ms: window,
                usage_quota_version: 3,
                paid_fallback_enabled: paid.enabled,
                paid_fallback_limit_microcredits: paid.limit_microcredits,
                paid_fallback_spent_microcredits: 0,
                paid_fallback_reserved_microcredits: 0,
                paid_fallback_reservation_request_id: None,
            },
            name,
            prefix: token.expose()[..12].into(),
            hash,
            created_at_ms: now,
            paid_fallback_model_ids: paid.model_ids,
            paid_fallback_quota_per_credit: paid.quota_per_credit,
            paid_fallback_max_exposure_microcredits: paid.max_exposure_microcredits,
            paid_fallback_pricing_checked_at_ms: paid.pricing_checked_at_ms,
        };
        let ik = api_keys::id_key(&id);
        let pk = authority_policy_key(&id);
        let pr = self.store.read(&pk).await?;
        let ir = self.store.read(&ik).await?;
        let wk = gateway_authority::keys::api_window(&id, &format!("v3:{window}"), now);
        let wr = self.store.read(&wk).await?;
        let mut checks = vec![
            store::check(&hk, hr.as_ref()),
            store::check(&ik, ir.as_ref()),
            store::check(&pk, pr.as_ref()),
            store::check(&wk, wr.as_ref()),
        ];
        let rev = self.revision()?;
        let mut writes = vec![
            store::put(ik, &record, None, &rev)?,
            store::put(hk, &record.policy, None, &rev)?,
            store::put(pk, &authority_policy(&record, now), None, &rev)?,
            store::put(
                wk,
                &usage_window(&id, window, now),
                Some(now + window + 604_800_000),
                &rev,
            )?,
        ];
        let changed = change_fields(None, &record, "create", raw);
        append_audit(
            self.host,
            audit::ChangeInput {
                principal: actor,
                request_id,
                release: self.release,
                action: "create",
                id: &record.policy.id,
                name: Some(&record.name),
                changed: &changed,
            },
            &mut checks,
            &mut writes,
        )?;
        if !store::commit(self.store, checks, writes).await? {
            return Err(conflict("API key was modified concurrently; retry"));
        }
        let mut result = public_record(&record);
        result["token"] = json!(token.expose());
        let mut response = AuthResponse::json(200, result);
        response
            .headers
            .insert("x-uos-upstream".into(), "chatgpt_codex".into());
        Ok(response)
    }
    pub async fn mutate(
        &self,
        operation: AdminOperation,
        raw: &Value,
        actor: &AuthPrincipal,
        request_id: &str,
    ) -> Result<AuthResponse, GatewayError> {
        retired_reset(raw)?;
        let id = raw
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| invalid("id is required"))?;
        let ik = api_keys::id_key(id);
        let ir = self.store.read(&ik).await?;
        let mut record: ApiKeyRecord = store::decode(ir.as_ref(), self.host.now_ms())?
            .ok_or_else(|| GatewayError::new(404, "Not found", Some("not_found")))?;
        let original = record.clone();
        if record.policy.usage_quota_version != 3 {
            return Err(GatewayError::unavailable(
                "API key quota migration is incomplete",
                "server_error",
            ));
        }
        let now = self.host.now_ms();
        let hk = api_keys::hash_key(&record.hash);
        let hr = self.store.read(&hk).await?;
        let pk = authority_policy_key(id);
        let pr = self.store.read(&pk).await?;
        let dk = deletion_key(id);
        let dr = self.store.read(&dk).await?;
        let mut checks = vec![
            store::check(&ik, ir.as_ref()),
            store::check(&hk, hr.as_ref()),
            store::check(&pk, pr.as_ref()),
        ];
        if operation != AdminOperation::ApiKeysDelete {
            checks.push(store::check(&dk, dr.as_ref()));
        }
        let mut writes = Vec::new();
        let mut deletion_checks = None;
        let action = match operation {
            AdminOperation::ApiKeysDelete => {
                if record.policy.revoked_at_ms.is_none() {
                    return Err(invalid("Only revoked keys can be deleted"));
                }
                let prepared = self.capabilities.prepare_key_deletion(id).await?;
                if !prepared.iter().any(|check| {
                    check.key == dk
                        && check
                            .expected_revision
                            .as_ref()
                            .is_some_and(|revision| !revision.is_empty())
                }) {
                    return Err(GatewayError::unavailable(
                        "API key deletion requires its claimed paid-ledger guard",
                        "paid_fallback_billing_unavailable",
                    ));
                }
                deletion_checks = Some(prepared.clone());
                checks.extend(prepared);
                writes.extend([
                    RecordMutation::Delete { key: ik.clone() },
                    RecordMutation::Delete { key: hk.clone() },
                    RecordMutation::Delete { key: pk.clone() },
                    RecordMutation::Delete {
                        key: store::key(json!(["ubq_ai", "api_keys", "usage", id])),
                    },
                    RecordMutation::Delete {
                        key: store::key(json!(["ubq_ai", "api_keys", "usage_daily", id])),
                    },
                ]);
                "delete"
            }
            AdminOperation::ApiKeysRevoke => {
                record.policy.revoked_at_ms = Some(record.policy.revoked_at_ms.unwrap_or(now));
                "revoke"
            }
            AdminOperation::ApiKeysUnrevoke => {
                if dr.is_some() {
                    return Err(GatewayError::new(
                        409,
                        "API key deletion is in progress and cannot be reversed",
                        Some("paid_fallback_deletion_in_progress"),
                    ));
                }
                if record.policy.revoked_at_ms.is_none() {
                    return Ok(AuthResponse::json(
                        200,
                        json!({"id":id,"revoked_at_ms":null}),
                    ));
                }
                record.policy.revoked_at_ms = None;
                "unrevoke"
            }
            AdminOperation::ApiKeysUpdate => {
                if let Some(value) = raw.get("name") {
                    record.name = name(Some(value))?;
                }
                if let Some(value) = raw.get("expires_at_ms") {
                    record.policy.expires_at_ms =
                        expiry(Some(value), record.policy.expires_at_ms, now)?;
                }
                record.policy.usage_limit_requests = limit(
                    raw.get("usage_limit_requests"),
                    record.policy.usage_limit_requests,
                )?;
                let new_window = window(raw.get("window_ms"), record.policy.window_ms)?;
                let reset = raw.get("reset_usage");
                if reset.is_some_and(|v| !v.is_boolean()) {
                    return Err(invalid("reset_usage must be a boolean"));
                }
                if new_window != record.policy.window_ms || reset == Some(&Value::Bool(true)) {
                    record.policy.window_ms = new_window;
                    record.policy.usage_reset_at_ms = now + new_window;
                    record.policy.usage_requests = 0;
                    let wk =
                        gateway_authority::keys::api_window(id, &format!("v3:{new_window}"), now);
                    let wr = self.store.read(&wk).await?;
                    // Never overwrite a live reservation when a reset shares its exact clock/window identity.
                    if wr
                        .as_ref()
                        .map(|row| row.json_value())
                        .transpose()?
                        .and_then(|row| row.get("reserved_requests"))
                        .and_then(Value::as_u64)
                        .is_some_and(|n| n > 0)
                    {
                        return Err(conflict("API key has in-flight quota reservations"));
                    }
                    checks.push(store::check(&wk, wr.as_ref()));
                    writes.push(store::put(
                        wk,
                        &usage_window(id, new_window, now),
                        Some(now + new_window + 604_800_000),
                        &self.revision()?,
                    )?);
                }
                let paid = paid_fields(self.capabilities, raw, Some(&record)).await?;
                record.policy.paid_fallback_enabled = paid.enabled;
                record.policy.paid_fallback_limit_microcredits = paid.limit_microcredits;
                record.paid_fallback_model_ids = paid.model_ids;
                record.paid_fallback_quota_per_credit = paid.quota_per_credit;
                record.paid_fallback_max_exposure_microcredits = paid.max_exposure_microcredits;
                record.paid_fallback_pricing_checked_at_ms = paid.pricing_checked_at_ms;
                "update"
            }
            _ => return Err(invalid("Invalid API key operation")),
        };
        if operation != AdminOperation::ApiKeysDelete {
            let rev = self.revision()?;
            writes.extend([
                store::put(ik, &record, None, &rev)?,
                store::put(hk, &record.policy, None, &rev)?,
                store::put(pk, &authority_policy(&record, now), None, &rev)?,
            ]);
        }
        let changed = change_fields(Some(&original), &record, action, raw);
        append_audit(
            self.host,
            audit::ChangeInput {
                principal: actor,
                request_id,
                release: self.release,
                action,
                id: &record.policy.id,
                name: Some(&record.name),
                changed: &changed,
            },
            &mut checks,
            &mut writes,
        )?;
        if !store::commit(self.store, checks, writes).await? {
            if let Some(prepared) = &deletion_checks {
                let _ = self.capabilities.abort_key_deletion(id, prepared).await;
            }
            return Err(conflict("API key was modified concurrently; retry"));
        }
        if let Some(prepared) = &deletion_checks {
            self.capabilities.finish_key_deletion(id, prepared).await?;
        }
        let body = match operation {
            AdminOperation::ApiKeysDelete => json!({"id":id}),
            AdminOperation::ApiKeysRevoke | AdminOperation::ApiKeysUnrevoke => {
                json!({"id":id,"revoked_at_ms":record.policy.revoked_at_ms})
            }
            _ => public_record(&record),
        };
        let mut response = AuthResponse::json(200, body);
        response
            .headers
            .insert("x-uos-upstream".into(), "chatgpt_codex".into());
        Ok(response)
    }
}

fn change_fields(
    old: Option<&ApiKeyRecord>,
    record: &ApiKeyRecord,
    action: &str,
    raw: &Value,
) -> Value {
    if action == "delete" {
        return json!({});
    }
    let credits = |value: i64| {
        if value == -1 {
            -1.0
        } else {
            value as f64 / 1_000_000.0
        }
    };
    let all = json!({"name":record.name,"expires_at_ms":record.policy.expires_at_ms,"usage_limit_requests":record.policy.usage_limit_requests,"window_ms":record.policy.window_ms,"paid_fallback_enabled":record.policy.paid_fallback_enabled,"paid_fallback_limit_credits":credits(record.policy.paid_fallback_limit_microcredits)});
    if action == "create" {
        return all;
    }
    if matches!(action, "revoke" | "unrevoke") {
        return json!({"revoked_at_ms":record.policy.revoked_at_ms});
    }
    let Some(old) = old else {
        return all;
    };
    let previous = json!({"name":old.name,"expires_at_ms":old.policy.expires_at_ms,"usage_limit_requests":old.policy.usage_limit_requests,"window_ms":old.policy.window_ms,"paid_fallback_enabled":old.policy.paid_fallback_enabled,"paid_fallback_limit_credits":credits(old.policy.paid_fallback_limit_microcredits)});
    let mut changed = serde_json::Map::new();
    for (key, value) in all.as_object().into_iter().flatten() {
        if previous.get(key) != Some(value) {
            changed.insert(key.clone(), value.clone());
        }
    }
    if raw.get("reset_usage") == Some(&Value::Bool(true)) {
        changed.insert("reset_usage".into(), Value::Bool(true));
    }
    Value::Object(changed)
}

fn append_audit<H: AuthHost>(
    host: &H,
    input: audit::ChangeInput<'_>,
    checks: &mut Vec<RevisionCheck>,
    writes: &mut Vec<RecordMutation>,
) -> Result<(), GatewayError> {
    let mutation = audit::mutation(host, input)?;
    if let RecordMutation::Put { key, .. } = &mutation {
        checks.push(store::check(key, None));
    }
    writes.push(mutation);
    Ok(())
}
