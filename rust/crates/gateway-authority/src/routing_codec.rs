//! Source v2 row normalization; absent legacy fields follow native-codex-contracts.ts.
use crate::routing::{
    ProbeCircuit, ProbeLease, QuotaBlock, QuotaBlockSource, RoutingSlot, RoutingState,
    SubscriptionPool,
};
use crate::{invalid, next_generation};
use gateway_core::{
    GatewayError,
    identity::{CredentialVersion, MAX_SAFE_INTEGER, RoutingAccountHash},
    provider::CodexQuotaClass,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const CLASSES: [&str; 5] = ["spark", "gpt_oss_120b", "reserve", "standard", "unknown"];
pub(crate) fn safe_integer(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64).then_some(n as i64)
}
pub(crate) fn safe_ms(value: &Value) -> Option<i64> {
    safe_integer(value).filter(|n| *n >= 0)
}
fn time(value: &Value, name: &str) -> Option<i64> {
    value.get(name).and_then(safe_ms)
}
fn finite(value: &Value, name: &str) -> Option<f64> {
    value
        .get(name)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
}
fn string(value: &Value, name: &str) -> Option<String> {
    value.get(name).and_then(Value::as_str).map(str::to_owned)
}
fn source(value: &Value) -> Option<QuotaBlockSource> {
    match value.as_str()? {
        "body_resets_at" => Some(QuotaBlockSource::BodyResetsAt),
        "header_retry_after" => Some(QuotaBlockSource::HeaderRetryAfter),
        _ => None,
    }
}
pub(crate) fn parse_class(value: &Value) -> Option<CodexQuotaClass> {
    match value.as_str()? {
        "spark" => Some(CodexQuotaClass::Spark),
        "gpt_oss_120b" => Some(CodexQuotaClass::GptOss120b),
        "reserve" => Some(CodexQuotaClass::Reserve),
        "standard" => Some(CodexQuotaClass::Standard),
        "unknown" => Some(CodexQuotaClass::Unknown),
        _ => None,
    }
}
fn yes(value: &Value, name: &str) -> bool {
    value.get(name).and_then(Value::as_bool) == Some(true)
}
fn same(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        _ => left == right,
    }
}
fn synthetic_unknown(raw: &Value) -> bool {
    let Some(unknown) = raw
        .get("unknown")
        .filter(|v| v.is_object() && v.get("legacy_fallback").is_none())
    else {
        return false;
    };
    ["spark", "gpt_oss_120b", "standard"].iter().all(|class| {
        raw.get(class).is_some_and(|candidate| {
            candidate.is_object()
                && candidate.get("legacy_fallback").is_none()
                && [
                    "blocked_until_ms",
                    "source",
                    "quota_signal_observed_at_ms",
                    "observed_reset_at_ms",
                    "observed_reset_at_is_stable",
                    "banked_reset_generation_ambiguous",
                    "banked_reset_recovery_probe_pending",
                ]
                .iter()
                .all(|name| same(candidate.get(name), unknown.get(name)))
        })
    })
}
fn parse_probe(value: &Value) -> Result<Option<ProbeLease>, GatewayError> {
    if value.is_null() {
        return Ok(None);
    }
    let token = string(value, "token").ok_or_else(|| invalid("Malformed source probe token."))?;
    let generation = value
        .get("generation")
        .and_then(safe_integer)
        .ok_or_else(|| invalid("Malformed source probe generation."))?;
    let expires_at_ms =
        time(value, "expires_at_ms").ok_or_else(|| invalid("Malformed source probe expiry."))?;
    let circuit = match value.get("circuit").and_then(Value::as_str) {
        None if value.get("circuit").is_none() => ProbeCircuit::Quota,
        Some("quota") => ProbeCircuit::Quota,
        Some("upstream_timeout") => ProbeCircuit::UpstreamTimeout,
        _ => return Err(invalid("Unknown source probe circuit.")),
    };
    Ok(Some(ProbeLease {
        token,
        generation,
        expires_at_ms,
        circuit,
        quota_class: value.get("quota_class").and_then(parse_class),
    }))
}
fn parse_block(value: &Value, slot: &RoutingSlot, fallback: bool) -> Option<QuotaBlock> {
    let blocked_until_ms = time(value, "blocked_until_ms")?;
    let source = value.get("source").and_then(source)?;
    let shares = slot.retained_reset_at_ms == Some(blocked_until_ms);
    Some(QuotaBlock {
        blocked_until_ms,
        source,
        legacy_fallback: yes(value, "legacy_fallback") || fallback,
        observed_at_ms: time(value, "quota_signal_observed_at_ms"),
        reset_at_ms: time(value, "observed_reset_at_ms").or(
            if shares && slot.reset_identity_stable {
                slot.retained_reset_at_ms
            } else {
                None
            },
        ),
        reset_is_stable: yes(value, "observed_reset_at_is_stable")
            || shares && slot.reset_identity_stable,
        reset_ambiguous: yes(value, "banked_reset_generation_ambiguous")
            || shares && slot.reset_identity_ambiguous,
        recovery_pending: yes(value, "banked_reset_recovery_probe_pending")
            || shares && slot.recovery_pending,
    })
}
impl RoutingSlot {
    pub fn neutral(
        account_id_hash: Option<RoutingAccountHash>,
        credential_version: CredentialVersion,
    ) -> Self {
        Self {
            account_id_hash,
            credential_version,
            quota_blocked_until_ms: None,
            quota_block_source: None,
            quota_blocked_classes: Vec::new(),
            generation: 0,
            invalid_credential_version: None,
            quota_blocks: BTreeMap::new(),
            probe_lease: None,
            primary_used_percent: None,
            secondary_used_percent: None,
            quota_signal_observed_at_ms: None,
            capacity_observed_at_ms: None,
            upstream_timeout_blocked_until_ms: None,
            retained_reset_at_ms: None,
            reset_identity_stable: false,
            reset_identity_ambiguous: false,
            recovery_pending: false,
        }
    }
}
fn parse_slot(raw: &Value, allow_repair: bool) -> Result<RoutingSlot, GatewayError> {
    if !raw.is_object() {
        return Err(invalid("Malformed source routing slot."));
    }
    let version = string(raw, "credential_version")
        .ok_or_else(|| invalid("Missing source credential version."))?;
    let block_source = match raw.get("quota_block_source") {
        Some(Value::Null) => None,
        Some(value) => Some(source(value).ok_or_else(|| invalid("Unknown source quota circuit."))?),
        None => return Err(invalid("Missing source quota circuit.")),
    };
    let probe = parse_probe(
        raw.get("probe_lease")
            .ok_or_else(|| invalid("Missing source probe lease."))?,
    )?;
    let hash = string(raw, "account_id_hash")
        .filter(|v| !v.is_empty())
        .map(RoutingAccountHash);
    let mut slot = RoutingSlot::neutral(hash, CredentialVersion(version));
    slot.quota_block_source = block_source;
    slot.quota_blocked_until_ms = time(raw, "quota_blocked_until_ms");
    slot.generation = raw.get("generation").and_then(safe_ms).unwrap_or(0) as u64;
    slot.invalid_credential_version =
        string(raw, "invalid_credential_version").map(CredentialVersion);
    slot.primary_used_percent = finite(raw, "primary_used_percent");
    slot.secondary_used_percent = finite(raw, "secondary_used_percent");
    slot.quota_signal_observed_at_ms = time(raw, "quota_signal_observed_at_ms");
    slot.capacity_observed_at_ms = time(raw, "capacity_observed_at_ms");
    slot.upstream_timeout_blocked_until_ms = time(raw, "upstream_timeout_blocked_until_ms");
    slot.retained_reset_at_ms = time(raw, "observed_reset_at_ms");
    slot.reset_identity_stable = yes(raw, "observed_reset_at_is_stable");
    slot.recovery_pending = yes(raw, "banked_reset_recovery_probe_pending");
    slot.probe_lease = probe;
    let neutral_legacy = raw.get("account_id_hash").is_none()
        && raw.get("observed_reset_at_is_stable").is_none()
        && raw.get("banked_reset_generation_ambiguous").is_none()
        && raw.get("generation").and_then(safe_integer) == Some(0)
        && [
            "quota_blocked_until_ms",
            "invalid_credential_version",
            "primary_used_percent",
            "secondary_used_percent",
            "observed_reset_at_ms",
            "probe_lease",
        ]
        .iter()
        .all(|n| raw.get(n) == Some(&Value::Null))
        && block_source.is_none();
    let first_body = yes(raw, "banked_reset_generation_ambiguous")
        && slot.generation == 1
        && slot.account_id_hash.is_some()
        && block_source == Some(QuotaBlockSource::BodyResetsAt)
        && slot.quota_blocked_until_ms.is_some()
        && slot.retained_reset_at_ms == slot.quota_blocked_until_ms
        && slot.reset_identity_stable
        && slot.probe_lease.is_none()
        && raw.get("invalid_credential_version") == Some(&Value::Null);
    slot.reset_identity_ambiguous = !(allow_repair && (neutral_legacy || first_body))
        && raw
            .get("banked_reset_generation_ambiguous")
            .and_then(Value::as_bool)
            != Some(false);
    if let Some(classes) = raw
        .get("quota_blocked_classes")
        .and_then(Value::as_array)
        .filter(|v| v.iter().all(Value::is_string))
    {
        for class in classes.iter().filter_map(Value::as_str) {
            if !slot.quota_blocked_classes.iter().any(|s| s == class) {
                slot.quota_blocked_classes.push(class.into());
            }
        }
    }
    let blocks = raw.get("quota_blocks_by_class").unwrap_or(&Value::Null);
    let synthetic = synthetic_unknown(blocks);
    for class in CLASSES {
        if let Some(block) = blocks
            .get(class)
            .and_then(|v| parse_block(v, &slot, class == "unknown" && synthetic))
        {
            slot.quota_blocks.insert(class.into(), block);
        }
    }
    Ok(slot)
}
pub fn parse_routing_state(raw: &Value) -> Result<RoutingState, GatewayError> {
    if raw.get("v").and_then(safe_integer) != Some(2) {
        return Err(invalid("Unsupported source routing state."));
    }
    let updated_at_ms =
        time(raw, "updated_at_ms").ok_or_else(|| invalid("Malformed source routing time."))?;
    let unresolved = yes(raw, "banked_reset_legacy_identity_unresolved");
    let raw_slots = raw
        .get("slots")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("Malformed source routing slots."))?;
    let slots = raw_slots
        .iter()
        .map(|slot| parse_slot(slot, !unresolved))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RoutingState {
        v: 2,
        updated_at_ms,
        legacy_identity_unresolved: unresolved,
        slots,
    })
}
fn retire_timeout(slot: &mut RoutingSlot) -> Result<(), GatewayError> {
    let timeout_lease = slot
        .probe_lease
        .as_ref()
        .is_some_and(|lease| lease.circuit == ProbeCircuit::UpstreamTimeout);
    if slot
        .upstream_timeout_blocked_until_ms
        .is_some_and(|n| n > 0)
        || timeout_lease
    {
        slot.upstream_timeout_blocked_until_ms = None;
        if timeout_lease {
            slot.probe_lease = None;
        }
        slot.generation = next_generation(slot.generation)?;
    }
    Ok(())
}
fn stable(slot: &RoutingSlot) -> bool {
    slot.reset_identity_ambiguous
        || slot.retained_reset_at_ms.is_some() && slot.reset_identity_stable
}
fn rotate(
    slot: &mut RoutingSlot,
    hash: &RoutingAccountHash,
    version: &CredentialVersion,
) -> Result<(), GatewayError> {
    let fallback = slot.quota_block_source.and_then(|source| {
        slot.retained_reset_at_ms.map(|reset| QuotaBlock {
            blocked_until_ms: slot.quota_blocked_until_ms.unwrap_or(reset),
            source,
            legacy_fallback: true,
            observed_at_ms: slot.quota_signal_observed_at_ms,
            reset_at_ms: Some(reset),
            reset_is_stable: slot.reset_identity_stable,
            reset_ambiguous: slot.reset_identity_ambiguous,
            recovery_pending: slot.recovery_pending,
        })
    });
    let preserved = fallback
        .into_iter()
        .chain(
            CLASSES
                .iter()
                .filter_map(|class| slot.quota_blocks.get(*class).cloned()),
        )
        .reduce(|a, b| {
            if b.blocked_until_ms > a.blocked_until_ms {
                b
            } else {
                a
            }
        });
    let generation = next_generation(slot.generation)?;
    let old_stable = stable(slot);
    let recovery = slot.recovery_pending;
    let lease = slot.probe_lease.clone().map(|mut lease| {
        lease.generation = generation as i64;
        lease
    });
    *slot = RoutingSlot::neutral(Some(hash.clone()), version.clone());
    slot.generation = generation;
    slot.probe_lease = lease;
    if let Some(block) = preserved {
        slot.retained_reset_at_ms = block.reset_at_ms;
        slot.reset_identity_stable = block.reset_is_stable;
        slot.reset_identity_ambiguous = old_stable || block.reset_ambiguous;
        slot.recovery_pending = recovery || block.recovery_pending;
    } else {
        slot.reset_identity_ambiguous = old_stable;
        slot.recovery_pending = recovery;
    }
    Ok(())
}
pub fn normalize(
    pool: &SubscriptionPool,
    prior: Option<RoutingState>,
    now: i64,
) -> Result<RoutingState, GatewayError> {
    let prior = prior.unwrap_or(RoutingState {
        v: 2,
        updated_at_ms: now,
        legacy_identity_unresolved: false,
        slots: Vec::new(),
    });
    if prior.v != 2 {
        return Err(invalid("Unsupported routing state."));
    }
    let mut used = BTreeSet::new();
    let mut slots = Vec::new();
    for (index, account) in pool.accounts.iter().enumerate() {
        let direct = prior
            .slots
            .get(index)
            .filter(|slot| {
                !used.contains(&index)
                    && (slot.account_id_hash.as_ref() == Some(&account.account_id_hash)
                        || slot.account_id_hash.is_none()
                            && slot.credential_version == account.credential_version)
            })
            .map(|_| index);
        let found = direct
            .or_else(|| {
                prior
                    .slots
                    .iter()
                    .enumerate()
                    .find(|(i, s)| {
                        !used.contains(i)
                            && s.account_id_hash.as_ref() == Some(&account.account_id_hash)
                    })
                    .map(|(i, _)| i)
            })
            .or_else(|| {
                prior
                    .slots
                    .iter()
                    .enumerate()
                    .find(|(i, s)| {
                        !used.contains(i)
                            && s.account_id_hash.is_none()
                            && s.credential_version == account.credential_version
                    })
                    .map(|(i, _)| i)
            });
        let Some(found) = found else {
            slots.push(RoutingSlot::neutral(
                Some(account.account_id_hash.clone()),
                account.credential_version.clone(),
            ));
            continue;
        };
        used.insert(found);
        let mut slot = prior.slots[found].clone();
        retire_timeout(&mut slot)?;
        if slot.credential_version != account.credential_version {
            rotate(
                &mut slot,
                &account.account_id_hash,
                &account.credential_version,
            )?;
        } else if slot.account_id_hash.as_ref() != Some(&account.account_id_hash) {
            slot.account_id_hash = Some(account.account_id_hash.clone());
            slot.reset_identity_ambiguous = stable(&slot);
        }
        retire_timeout(&mut slot)?;
        slots.push(slot);
    }
    let unresolved = prior.legacy_identity_unresolved
        || prior.slots.iter().enumerate().any(|(i, s)| {
            !used.contains(&i)
                && s.account_id_hash.is_none()
                && s.retained_reset_at_ms.is_some()
                && s.reset_identity_stable
        });
    Ok(RoutingState {
        v: 2,
        updated_at_ms: now,
        legacy_identity_unresolved: unresolved,
        slots,
    })
}
