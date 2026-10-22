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
    js_string::JsString16,
    model::ModelId,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    state::{AuthorityStore, RecordKey, RecordMutation, RevisionCheck, StoredRecord},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{AdminHost, AdminOperation, PaidKeyFields, audit, source_input as input};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ApiKeyRecord {
    #[serde(flatten)]
    pub policy: ApiKeyHashRecord,
    pub name: JsString16,
    pub prefix: String,
    pub hash: String,
    pub created_at_ms: i64,
    pub paid_fallback_model_ids: Vec<ModelId>,
    pub paid_fallback_quota_per_credit: i64,
    #[serde(default, with = "gateway_authority::source_model_map")]
    pub paid_fallback_max_exposure_microcredits: std::collections::BTreeMap<ModelId, i64>,
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

/// Complete named DTO decode; callers retain their original key/expiry/currentness guards.
pub fn decode_record(record: &StoredRecord) -> Result<ApiKeyRecord, GatewayError> {
    let source = decode_source_control_record(record)?;
    if !gateway_admin_data::migration::audit::valid_source_key_policy(&source, true) {
        return Err(GatewayError::unavailable(
            "API key state is corrupt",
            "api_key_policy_invalid",
        ));
    }
    source.deserialize().map_err(|_| {
        GatewayError::unavailable("API key state is corrupt", "api_key_policy_invalid")
    })
}
/// Validate the complete named family and its original physical key before projection.
pub fn decode_id_record(
    key: &RecordKey,
    record: &StoredRecord,
) -> Result<ApiKeyRecord, GatewayError> {
    let value = decode_record(record)?;
    if key != &api_keys::id_key(&value.policy.id) {
        return Err(GatewayError::unavailable(
            "API key record identity is invalid",
            "api_key_policy_invalid",
        ));
    }
    Ok(value)
}
/// Retain absolute storage expiry/currentness, independently of policy expiry.
pub fn current_record(
    key: &RecordKey,
    row: Option<&StoredRecord>,
    now: i64,
) -> Result<Option<ApiKeyRecord>, GatewayError> {
    let Some(row) = row else { return Ok(None) };
    row.validate_version()?;
    if row.expires_at_ms.is_some_and(|at| at <= now) {
        return Ok(None);
    }
    decode_id_record(key, row).map(Some)
}
/// ID-record family only. Model-free auth hash and unrelated records keep their existing codecs.
pub fn record_mutation(
    key: RecordKey,
    record: &ApiKeyRecord,
    expiry: Option<i64>,
    revision: &str,
) -> Result<RecordMutation, GatewayError> {
    if key != api_keys::id_key(&record.policy.id) {
        return Err(GatewayError::unavailable(
            "API key record identity is invalid",
            "api_key_policy_invalid",
        ));
    }
    Ok(RecordMutation::Put {
        key,
        record: encode_source_control_record(
            revision,
            &SourceJson::from_serializable(record)?,
            expiry,
        )?,
    })
}
fn policy_mutation(
    record: &ApiKeyRecord,
    now: i64,
    revision: &str,
) -> Result<RecordMutation, GatewayError> {
    Ok(RecordMutation::Put {
        key: authority_policy_key(&record.policy.id),
        record: encode_source_control_record(
            revision,
            &SourceJson::from_serializable(&authority_policy(record, now))?,
            None,
        )?,
    })
}
pub fn public_record(record: &ApiKeyRecord) -> SourceJson {
    input::object(vec![
        ("id", input::json(&record.policy.id)),
        ("name", input::json(&record.name)),
        ("prefix", input::json(&record.prefix)),
        ("created_at_ms", input::json(&record.created_at_ms)),
        ("expires_at_ms", input::json(&record.policy.expires_at_ms)),
        ("revoked_at_ms", input::json(&record.policy.revoked_at_ms)),
        (
            "usage_limit_requests",
            input::json(&record.policy.usage_limit_requests),
        ),
        ("usage_requests", input::json(&record.policy.usage_requests)),
        (
            "usage_reset_at_ms",
            input::json(&record.policy.usage_reset_at_ms),
        ),
        ("window_ms", input::json(&record.policy.window_ms)),
        (
            "paid_fallback_enabled",
            input::json(&record.policy.paid_fallback_enabled),
        ),
        (
            "paid_fallback_limit_credits",
            input::json(&(record.policy.paid_fallback_limit_microcredits as f64 / 1_000_000.0)),
        ),
        (
            "paid_fallback_spent_credits",
            input::json(&(record.policy.paid_fallback_spent_microcredits as f64 / 1_000_000.0)),
        ),
        (
            "paid_fallback_reserved_credits",
            input::json(&(record.policy.paid_fallback_reserved_microcredits as f64 / 1_000_000.0)),
        ),
        (
            "paid_fallback_model_ids",
            input::json(&record.paid_fallback_model_ids),
        ),
    ])
}

fn safe_integer(value: &SourceJson) -> Option<i64> {
    let number = input::number(value)?.trunc();
    (number.is_finite() && number.abs() <= gateway_core::identity::MAX_SAFE_INTEGER as f64)
        .then_some(number as i64)
}
fn limit(raw: Option<&SourceJson>, default: i64) -> Result<i64, GatewayError> {
    let value = match raw {
        None => default,
        Some(value) if value.as_str() == "null" => 50,
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
fn name(raw: Option<&SourceJson>) -> Result<JsString16, GatewayError> {
    let name = raw
        .and_then(input::text)
        .map(|value| input::trim(&value))
        .filter(|value| {
            !value.as_units().is_empty()
                && value.as_units().len() <= 80
                && !value.as_units().iter().any(|unit| matches!(unit, 10 | 13))
        })
        .ok_or_else(|| invalid("name must be a non-empty string (<=80 chars)"))?;
    Ok(name)
}

fn expiry(raw: Option<&SourceJson>, default: i64, now: i64) -> Result<i64, GatewayError> {
    let expiry = match raw {
        None => default,
        Some(value) if value.as_str() == "null" => now + 7_776_000_000,
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
fn window(raw: Option<&SourceJson>, default: i64) -> Result<i64, GatewayError> {
    let normalized = raw
        .map(|value| {
            if let Some(text) = input::text(value) {
                // This field must become a finite Number. An unpaired unit cannot
                // form its numeric grammar; it gets the same window validation error.
                text.try_utf8().ok().and_then(|text| {
                    let n = gateway_admin_data::profile::js_number(&Value::String(text));
                    (n.is_finite() && n.abs() <= gateway_core::identity::MAX_SAFE_INTEGER as f64)
                        .then_some(n.trunc() as i64)
                })
            } else {
                safe_integer(value)
            }
        })
        .unwrap_or(Some(default));
    normalized
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid("window_ms must be a positive number"))
}

fn retired_reset(raw: &SourceJson) -> Result<(), GatewayError> {
    if input::member(raw, "banked_reset_enabled")
        .as_ref()
        .is_some()
        || input::member(raw, "codex_banked_reset_enabled")
            .as_ref()
            .is_some()
    {
        return Err(invalid(
            "Banked reset settings are account-owned; use provider controls",
        ));
    }
    Ok(())
}

async fn paid_fields<A: AdminHost>(
    host: &A,
    raw: &SourceJson,
    old: Option<&ApiKeyRecord>,
) -> Result<PaidKeyFields, GatewayError> {
    if input::member(raw, "paid_fallback_enabled")
        .as_ref()
        .is_some_and(|v| input::boolean(v).is_none())
    {
        return Err(invalid("paid_fallback_enabled must be a boolean"));
    }
    let enabled = input::member(raw, "paid_fallback_enabled")
        .as_ref()
        .and_then(input::boolean)
        .unwrap_or(old.is_some_and(|v| v.policy.paid_fallback_enabled));
    let limit = if let Some(value) = input::member(raw, "paid_fallback_limit_credits").as_ref() {
        let credit = input::number(value)
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
    input::set(&mut effective, "paid_fallback_enabled", input::json(&true));
    input::set(
        &mut effective,
        "paid_fallback_limit_credits",
        input::json(&if limit == -1 {
            -1.0
        } else {
            limit as f64 / 1_000_000.0
        }),
    );
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
        raw: &SourceJson,
        actor: &AuthPrincipal,
        request_id: &str,
    ) -> Result<AuthResponse, GatewayError> {
        retired_reset(raw)?;
        let name = name(input::member(raw, "name").as_ref())?;
        let token = match input::member(raw, "token") {
            None => api_keys::generate_token(&self.host.random_bytes(32)?)?,
            Some(value) if value.as_str() == "null" => {
                api_keys::generate_token(&self.host.random_bytes(32)?)?
            }
            Some(value) => {
                let units = input::text(&value).map(|value| input::trim(&value)).filter(|value| {
                    let u = value.as_units();
                    u.len() == 66 && u[..2] == [117, 95] && u[2..].iter().all(|u| (48..=57).contains(u) || (97..=102).contains(u))
                }).ok_or_else(|| invalid("token must use the u_ prefix followed by 64 lowercase hexadecimal characters"))?;
                // Proven closed ASCII token grammar above; no arbitrary string fallback.
                Secret::new(
                    String::from_utf16(units.as_units()).expect("validated ASCII API-key token"),
                )
            }
        };
        let now = self.host.now_ms();
        let expires = expiry(
            input::member(raw, "expires_at_ms").as_ref(),
            now + 7_776_000_000,
            now,
        )?;
        let usage = limit(input::member(raw, "usage_limit_requests").as_ref(), 50)?;
        let window = window(input::member(raw, "window_ms").as_ref(), WEEK_MS)?;
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
            record_mutation(ik, &record, None, &rev)?,
            store::put(hk, &record.policy, None, &rev)?,
            policy_mutation(&record, now, &rev)?,
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
        input::set(&mut result, "token", input::json(token.expose()));
        let mut response = AuthResponse::source_json(200, result);
        response
            .headers
            .insert("x-uos-upstream".into(), "chatgpt_codex".into());
        Ok(response)
    }
    pub async fn mutate(
        &self,
        operation: AdminOperation,
        raw: &SourceJson,
        actor: &AuthPrincipal,
        request_id: &str,
    ) -> Result<AuthResponse, GatewayError> {
        retired_reset(raw)?;
        let target_id = input::member(raw, "id")
            .as_ref()
            .and_then(input::text)
            .filter(|id| !id.as_units().is_empty())
            .ok_or_else(|| invalid("id is required"))?;
        // Source accepts any nonempty string selector, not just UUIDs/scalars.
        let ik = input::selected_key(&["ubq_ai", "api_keys", "id"], &target_id)?;
        let ir = self.store.read(&ik).await?;
        let mut record = current_record(&ik, ir.as_ref(), self.host.now_ms())?
            .ok_or_else(|| GatewayError::new(404, "Not found", Some("not_found")))?;
        if api_keys::id_key(&record.policy.id) != ik {
            return Err(GatewayError::unavailable(
                "API key record identity is invalid",
                "api_key_policy_invalid",
            ));
        }
        let stored_id = record.policy.id.clone();
        let id = stored_id.as_str();
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
                    return Ok(AuthResponse::source_json(
                        200,
                        input::object(vec![
                            ("id", input::json(&target_id)),
                            ("revoked_at_ms", input::json(&())),
                        ]),
                    ));
                }
                record.policy.revoked_at_ms = None;
                "unrevoke"
            }
            AdminOperation::ApiKeysUpdate => {
                if let Some(value) = input::member(raw, "name").as_ref() {
                    record.name = name(Some(value))?;
                }
                if let Some(value) = input::member(raw, "expires_at_ms").as_ref() {
                    record.policy.expires_at_ms =
                        expiry(Some(value), record.policy.expires_at_ms, now)?;
                }
                record.policy.usage_limit_requests = limit(
                    input::member(raw, "usage_limit_requests").as_ref(),
                    record.policy.usage_limit_requests,
                )?;
                let new_window = window(
                    input::member(raw, "window_ms").as_ref(),
                    record.policy.window_ms,
                )?;
                let reset = input::member(raw, "reset_usage");
                if reset.as_ref().is_some_and(|v| input::boolean(v).is_none()) {
                    return Err(invalid("reset_usage must be a boolean"));
                }
                if new_window != record.policy.window_ms
                    || reset.as_ref().and_then(input::boolean) == Some(true)
                {
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
                record_mutation(ik, &record, None, &rev)?,
                store::put(hk, &record.policy, None, &rev)?,
                policy_mutation(&record, now, &rev)?,
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
            AdminOperation::ApiKeysDelete => input::object(vec![("id", input::json(&target_id))]),
            AdminOperation::ApiKeysRevoke | AdminOperation::ApiKeysUnrevoke => input::object(vec![
                ("id", input::json(&target_id)),
                ("revoked_at_ms", input::json(&record.policy.revoked_at_ms)),
            ]),
            _ => public_record(&record),
        };
        let mut response = AuthResponse::source_json(200, body);
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
    raw: &SourceJson,
) -> SourceJson {
    if action == "delete" {
        return input::object(Vec::new());
    }
    let fields = |record: &ApiKeyRecord| {
        input::object(vec![
            ("name", input::json(&record.name)),
            ("expires_at_ms", input::json(&record.policy.expires_at_ms)),
            (
                "usage_limit_requests",
                input::json(&record.policy.usage_limit_requests),
            ),
            ("window_ms", input::json(&record.policy.window_ms)),
            (
                "paid_fallback_enabled",
                input::json(&record.policy.paid_fallback_enabled),
            ),
            (
                "paid_fallback_limit_credits",
                input::json(&if record.policy.paid_fallback_limit_microcredits == -1 {
                    -1.0
                } else {
                    record.policy.paid_fallback_limit_microcredits as f64 / 1_000_000.0
                }),
            ),
        ])
    };
    let all = fields(record);
    if action == "create" {
        return all;
    }
    if matches!(action, "revoke" | "unrevoke") {
        return input::object(vec![(
            "revoked_at_ms",
            input::json(&record.policy.revoked_at_ms),
        )]);
    }
    let Some(old) = old else { return all };
    let previous = fields(old);
    let mut changed = input::object(Vec::new());
    for (key, value) in
        gateway_core::source_serialization::entries(&all).expect("constructed audit fields")
    {
        // All names come from the closed source audit allowlist above.
        let key = key.try_utf8().expect("closed ASCII audit field name");
        if input::member(&previous, &key).as_ref() != Some(&value) {
            input::set(&mut changed, &key, value);
        }
    }
    if input::member(raw, "reset_usage")
        .as_ref()
        .and_then(input::boolean)
        == Some(true)
    {
        input::set(&mut changed, "reset_usage", input::json(&true));
    }
    changed
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
