use super::{Facts, SourceCreditCollation, SourceResetCredit, SourceResetInventory, declined};
use gateway_core::{GatewayError, identity::MAX_SAFE_INTEGER, js_string::JsString16};
use std::{cmp::Ordering, collections::BTreeSet};

pub(super) struct Selected {
    pub member: usize,
    pub credit: SourceResetCredit,
    pub observed: i64,
}
pub(super) struct Selection {
    pub selected: Option<Selected>,
    pub reason: &'static str,
}
fn is(value: &JsString16, text: &str) -> bool {
    value.as_units().iter().copied().eq(text.encode_utf16())
}
fn nonblank(value: &JsString16) -> bool {
    value.as_units().iter().any(|unit| {
        !char::from_u32(u32::from(*unit)).is_some_and(gateway_schema::util::js_whitespace)
    })
}
pub(super) fn select<H: SourceCreditCollation>(
    facts: &Facts,
    inventories: &[SourceResetInventory],
    host: &H,
    now: i64,
) -> Result<Selection, GatewayError> {
    let expected: Vec<_> = facts
        .members
        .iter()
        .enumerate()
        .filter(|(_, member)| member.enabled)
        .collect();
    if inventories.len() != expected.len() {
        return Err(declined("inventory_unavailable"));
    }
    let mut selected: Option<Selected> = None;
    let mut reason = "no_eligible_credit";
    let mut slots = BTreeSet::new();
    for inventory in inventories {
        let (member_index, member) = expected
            .iter()
            .copied()
            .find(|(_, member)| member.candidate.binding == inventory.binding)
            .ok_or_else(|| declined("inventory_unavailable"))?;
        if !slots.insert(inventory.binding.slot)
            || !(0..=MAX_SAFE_INTEGER).contains(&inventory.available_count)
        {
            return Err(declined("inventory_unavailable"));
        }
        let mut ids = BTreeSet::new();
        let mut available = 0i64;
        for credit in &inventory.credits {
            if !nonblank(&credit.credit_id)
                || !nonblank(&credit.status)
                || !nonblank(&credit.reset_type)
                || !ids.insert(credit.credit_id.clone())
                || credit
                    .expires_at_ms
                    .is_some_and(|value| !(0..=MAX_SAFE_INTEGER).contains(&value))
            {
                return Err(declined("inventory_unavailable"));
            }
            if is(&credit.status, "available") {
                available += 1;
            }
        }
        if available != inventory.available_count {
            return Err(declined("inventory_unavailable"));
        }
        if inventory.observed_at_ms < 0
            || inventory.observed_at_ms > now
            || now - inventory.observed_at_ms > 30_000
            || inventory.credits.iter().any(|credit| {
                credit.credit_id.as_units().len() > 512
                    || credit.status.as_units().len() > 128
                    || credit.reset_type.as_units().len() > 128
            })
            || inventory.credits.iter().any(|credit| {
                is(&credit.status, "available")
                    && credit.expires_at_ms.is_some_and(|expiry| expiry <= now)
            })
        {
            return Ok(Selection {
                selected: None,
                reason: "inventory_response_invalid_or_expired",
            });
        }
        let mut eligible = false;
        for credit in &inventory.credits {
            if !is(&credit.status, "available") || !is(&credit.reset_type, "codex_rate_limits") {
                continue;
            }
            eligible = true;
            let better = match &selected {
                None => true,
                Some(current) => {
                    let order = credit
                        .expires_at_ms
                        .unwrap_or(i64::MAX)
                        .cmp(&current.credit.expires_at_ms.unwrap_or(i64::MAX))
                        .then_with(|| {
                            member
                                .candidate
                                .binding
                                .slot
                                .cmp(&facts.members[current.member].candidate.binding.slot)
                        });
                    (if order == Ordering::Equal {
                        host.compare_credit_ids(&credit.credit_id, &current.credit.credit_id)?
                    } else {
                        order
                    }) == Ordering::Less
                }
            };
            if better {
                selected = Some(Selected {
                    member: member_index,
                    credit: credit.clone(),
                    observed: inventory.observed_at_ms,
                });
            }
        }
        if !eligible && inventory.available_count > 0 {
            reason = "inventory_no_eligible_codex_credit";
        }
    }
    if selected.is_some() {
        reason = "selected";
    }
    Ok(Selection { selected, reason })
}
