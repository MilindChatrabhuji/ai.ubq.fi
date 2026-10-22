use super::{
    Audit, AuditInventory, SliceInventory, api_id, reference, safe, under, valid_api_request,
    valid_api_window, valid_kernel_policy,
};
use crate::integer;
use crate::migration::{ObservedRow, kernel};
use gateway_core::GatewayError;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn inspect_api_usage(
    rows: &[ObservedRow],
    known: &BTreeSet<String>,
) -> Result<Audit, GatewayError> {
    inspect_api_inventory(&SliceInventory(rows), known)
}
pub fn inspect_api_inventory(
    rows: &dyn AuditInventory,
    known: &BTreeSet<String>,
) -> Result<Audit, GatewayError> {
    let mut state = ApiAudit::new();
    rows.visit(&mut |row| {
        state.accept(row);
        Ok(())
    })?;
    state.finish(known)
}
pub(super) struct ApiAudit {
    orphans: Vec<Vec<(usize, String, gateway_core::js_string::JsString16)>>,
    groups: Vec<(Audit, Option<GatewayError>)>,
    windows: BTreeMap<String, Option<i64>>,
    reserved: BTreeMap<String, i64>,
    requests: BTreeSet<String>,
}
impl ApiAudit {
    pub(super) fn new() -> Self {
        Self {
            orphans: (0..2).map(|_| Vec::new()).collect(),
            groups: (0..2).map(|_| (Audit::default(), None)).collect(),
            windows: BTreeMap::new(),
            reserved: BTreeMap::new(),
            requests: BTreeSet::new(),
        }
    }
    pub(super) fn accept(&mut self, row: &ObservedRow) {
        if under(&row.parts, &["uos_ai", "api_key_usage", "v3", "window"])
            && self.groups[0].1.is_none()
        {
            let a = &mut self.groups[0].0;
            let result = (|| -> Result<(), GatewayError> {
                a.count("api_key_usage_v3_windows");
                let p = &row.parts;
                let v = row.value()?;
                if p.len() != 7
                    || !api_id(p.get(4))
                    || !p[5].as_str().is_some_and(|s| !s.is_empty())
                    || !safe(p.get(6))
                    || !valid_api_window(v)
                    || v["key_id"] != p[4]
                    || v["policy_version"] != p[5]
                    || v["window_start_ms"] != p[6]
                {
                    a.errors.push(
                        format!("API key usage V3 window is malformed: {}", reference(p))
                            .as_str()
                            .into(),
                    );
                    return Ok(());
                }
                self.orphans[0].push((
                    a.errors.len(),
                    p[4].as_str().unwrap_or("").to_owned(),
                    format!(
                        "API key usage V3 window is orphaned: {}",
                        p[4].as_str().unwrap_or("")
                    )
                    .as_str()
                    .into(),
                ));
                self.windows
                    .insert(reference(&p[4..]), integer(v, "reserved_requests"));
                Ok(())
            })();
            self.groups[0].1 = result.err();
        }
        if under(&row.parts, &["uos_ai", "api_key_usage", "v3", "request"])
            && self.groups[1].1.is_none()
        {
            let a = &mut self.groups[1].0;
            let result = (|| -> Result<(), GatewayError> {
                a.count("api_key_usage_v3_requests");
                let p = &row.parts;
                let v = row.value()?;
                if p.len() != 8
                    || !api_id(p.get(4))
                    || !p[5].as_str().is_some_and(|s| !s.is_empty())
                    || !safe(p.get(6))
                    || !api_id(p.get(7))
                    || !valid_api_request(v)
                    || v["key_id"] != p[4]
                    || v["request_id"] != p[7]
                {
                    a.errors.push(
                        format!("API key usage V3 request is malformed: {}", reference(p))
                            .as_str()
                            .into(),
                    );
                    return Ok(());
                }
                let id = p[4].as_str().unwrap_or("");
                let request = p[7].as_str().unwrap_or("");
                self.orphans[1].push((
                    a.errors.len(),
                    id.to_owned(),
                    format!("API key usage V3 request is orphaned: {id}/{request}")
                        .as_str()
                        .into(),
                ));
                let r = reference(&p[4..7]);
                self.requests.insert(r.clone());
                if v["state"] == "reserved" {
                    *self.reserved.entry(r).or_default() += 1;
                }
                Ok(())
            })();
            self.groups[1].1 = result.err();
        }
    }
    pub(super) fn finish(mut self, known: &BTreeSet<String>) -> Result<Audit, GatewayError> {
        for (index, candidates) in self.orphans.into_iter().enumerate() {
            let mut offset = 0;
            for (position, id, message) in candidates {
                if !known.contains(&id) {
                    self.groups[index]
                        .0
                        .errors
                        .insert(position + offset, message);
                    offset += 1;
                }
            }
        }
        let mut a = Audit::default();
        for (audit, error) in self.groups {
            if let Some(e) = error {
                return Err(e);
            }
            a.merge(audit);
        }
        for (r, w) in &self.windows {
            if *w != Some(*self.reserved.get(r).unwrap_or(&0)) {
                a.errors.push(
                    format!("API key usage V3 reserved aggregate is inconsistent: {r}")
                        .as_str()
                        .into(),
                );
            }
        }
        for r in self.requests {
            if !self.windows.contains_key(&r) {
                a.errors.push(
                    format!("API key usage V3 request has no window: {r}")
                        .as_str()
                        .into(),
                );
            }
        }
        Ok(a)
    }
}
pub fn inspect_kernel(rows: &[ObservedRow]) -> Result<Audit, GatewayError> {
    inspect_kernel_inventory(&SliceInventory(rows))
}
pub fn inspect_kernel_inventory(rows: &dyn AuditInventory) -> Result<Audit, GatewayError> {
    let mut state = KernelAudit::new();
    rows.visit(&mut |row| {
        state.accept(row);
        Ok(())
    })?;
    state.finish()
}
pub(super) struct KernelAudit {
    groups: Vec<(Audit, Option<GatewayError>)>,
    windows: BTreeMap<String, (Value, bool)>,
    reserved: BTreeMap<String, i64>,
    resets: BTreeMap<String, Value>,
}
impl KernelAudit {
    pub(super) fn new() -> Self {
        Self {
            groups: (0..6).map(|_| (Audit::default(), None)).collect(),
            windows: BTreeMap::new(),
            reserved: BTreeMap::new(),
            resets: BTreeMap::new(),
        }
    }
    pub(super) fn accept(&mut self, row: &ObservedRow) {
        for (scope_i, scope) in ["repo", "org"].into_iter().enumerate() {
            for (kind_i, kind) in ["policy", "window", "reservation"].into_iter().enumerate() {
                let index = scope_i * 3 + kind_i;
                let segment = format!("{scope}_{kind}");
                let count_name = format!("kernel_v2_{scope}_{kind}s");
                if !under(&row.parts, &["uos_ai", "kernel_quota", "v2", &segment])
                    || self.groups[index].1.is_some()
                {
                    continue;
                }
                let a = &mut self.groups[index].0;
                let result = (|| -> Result<(), GatewayError> {
                    a.count(&count_name);
                    let p = &row.parts;
                    let value = row.value()?;
                    let Some((_, owner, repo)) = kernel::identity(p, kind) else {
                        a.errors.push(
                            format!("kernel quota V2 {kind} is malformed: {}", reference(p))
                                .as_str()
                                .into(),
                        );
                        return Ok(());
                    };
                    if kind == "policy" {
                        if !valid_kernel_policy(value, scope, &owner, repo.as_deref()) {
                            a.errors.push(
                                format!("kernel quota V2 policy is malformed: {}", reference(p))
                                    .as_str()
                                    .into(),
                            );
                        }
                        return Ok(());
                    }
                    let mut reference_parts = vec![json!(scope), json!(owner)];
                    if let Some(repo) = &repo {
                        reference_parts.push(json!(repo));
                    }
                    if kind == "window" {
                        let Some(window) =
                            kernel::normalize_window(value, scope, &owner, repo.as_deref())
                        else {
                            a.errors.push(
                                format!("kernel quota V2 window is malformed: {}", reference(p))
                                    .as_str()
                                    .into(),
                            );
                            return Ok(());
                        };
                        reference_parts.push(window["created_at_ms"].clone());
                        self.windows.insert(
                        reference(&reference_parts),
                        (json!({"usage_reset_at_ms":window["usage_reset_at_ms"],"reserved_requests":window["reserved_requests"]}), value.get("reserved_requests").is_some()),
                    );
                        return Ok(());
                    }
                    let offset = if scope == "repo" { 6 } else { 5 };
                    let valid_key = p.len() == offset + 2
                        && safe(p.get(offset))
                        && p.get(offset + 1)
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.is_empty());
                    let reservation =
                        kernel::normalize_reservation(value, scope, &owner, repo.as_deref());
                    if !valid_key
                        || reservation.as_ref().is_none_or(|v| {
                            v["window_created_at_ms"] != p[offset]
                                || v["request_id"] != p[offset + 1]
                        })
                    {
                        a.errors.push(
                            format!("kernel quota V2 reservation is malformed: {}", reference(p))
                                .as_str()
                                .into(),
                        );
                        return Ok(());
                    }
                    let reservation = reservation.unwrap_or(Value::Null);
                    reference_parts.push(reservation["window_created_at_ms"].clone());
                    let r = reference(&reference_parts);
                    let reset = reservation["window_reset_at_ms"].clone();
                    if self.resets.get(&r).is_some_and(|known| *known != reset) {
                        a.errors.push(
                            format!(
                                "kernel quota V2 reservation window identity is inconsistent: {r}"
                            )
                            .as_str()
                            .into(),
                        );
                    } else {
                        self.resets.insert(r.clone(), reset);
                    }
                    if reservation["state"] == "reserved" {
                        *self.reserved.entry(r).or_default() += 1;
                    }
                    Ok(())
                })();
                self.groups[index].1 = result.err();
            }
        }
    }
    pub(super) fn finish(self) -> Result<Audit, GatewayError> {
        let mut a = Audit::default();
        for (audit, error) in self.groups {
            if let Some(e) = error {
                return Err(e);
            }
            a.merge(audit);
        }
        for (r, (window, has_aggregate)) in &self.windows {
            if self
                .resets
                .get(r)
                .is_some_and(|reset| *reset != window["usage_reset_at_ms"])
            {
                a.errors.push(
                    format!("kernel quota V2 reservation window reset is inconsistent: {r}")
                        .as_str()
                        .into(),
                );
            }
            if *has_aggregate
                && integer(window, "reserved_requests") != Some(*self.reserved.get(r).unwrap_or(&0))
            {
                a.errors.push(
                    format!("kernel quota V2 reserved aggregate is inconsistent: {r}")
                        .as_str()
                        .into(),
                );
            }
        }
        for r in self.reserved.keys() {
            if !self.windows.contains_key(r) {
                a.errors.push(
                    format!("kernel quota V2 active reservation has no window: {r}")
                        .as_str()
                        .into(),
                );
            }
        }
        Ok(a)
    }
}
