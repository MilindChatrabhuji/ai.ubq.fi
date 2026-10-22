//! Bounded operational-core selection for the Workers Free migration lane.
//!
//! This is a local, offline policy over one complete stopped-source capture. It
//! does not open a database, target, credential, service, or public route.
use crate::native_spool::Spool;
use crate::*;
use gateway_core::{js_string::JsString16, value::PortableValue};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Workers Free rejects the next Durable Object row write at this boundary.
pub const CORE_STATE_DO_ROW_WRITE_LIMIT: u64 = 100_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CoreStateRuleCount {
    pub rule: String,
    pub rows: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CoreStateManifest {
    pub v: u32,
    pub source_git_sha: String,
    pub captured_at_ms: i64,
    pub source_rows: usize,
    pub selected_rows: usize,
    pub excluded_rows: usize,
    pub included: Vec<CoreStateRuleCount>,
    pub excluded: Vec<CoreStateRuleCount>,
    pub derived_rows: usize,
    pub manifest_rows: usize,
    pub do_row_writes: u64,
    pub do_row_write_limit: u64,
    pub within_free_limit: bool,
    pub current_api_windows: usize,
    pub current_paid_requests: usize,
    pub current_paid_unresolved: usize,
    pub current_paid_pending: usize,
}

impl CoreStateManifest {
    fn validate(&self) -> Result<(), MigrationError> {
        let included = self.included.iter().map(|entry| entry.rows).sum::<usize>();
        let excluded = self.excluded.iter().map(|entry| entry.rows).sum::<usize>();
        if included != self.selected_rows
            || excluded != self.excluded_rows
            || self.selected_rows + self.excluded_rows != self.source_rows
            || self.manifest_rows != 1
            || self.derived_rows > self.selected_rows
            || self.do_row_writes
                != (self.selected_rows as u64)
                    .checked_mul(2)
                    .and_then(|value| value.checked_add(self.derived_rows as u64))
                    .and_then(|value| value.checked_add(1))
                    .ok_or_else(|| invalid("Core-state write count overflows"))?
        {
            return Err(invalid("Core-state manifest accounting is inconsistent").into());
        }
        if !self.within_free_limit || self.do_row_writes >= self.do_row_write_limit {
            return Err(unavailable(format!(
                "Core-state adoption requires {} Durable Object row writes, at or above the Workers Free daily limit {}",
                self.do_row_writes, self.do_row_write_limit
            ))
            .into());
        }
        if self.current_api_windows == 0 {
            return Err(invalid(
                "Current API-key quota window is absent; reduced adoption would reset live counters",
            )
            .into());
        }
        if self.current_paid_pending != self.current_paid_unresolved {
            return Err(invalid(
                "Current paid-fallback unresolved requests and pending markers differ",
            )
            .into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct CoreStateCapture {
    pub capture: NativeCapture,
    pub manifest: CoreStateManifest,
}

#[derive(Clone, Copy)]
enum Decision {
    Include(&'static str),
    Exclude(&'static str),
}

fn rule_counts(counts: BTreeMap<&'static str, usize>) -> Vec<CoreStateRuleCount> {
    counts
        .into_iter()
        .map(|(rule, rows)| CoreStateRuleCount {
            rule: rule.into(),
            rows,
        })
        .collect()
}

fn key_parts(entry: &NativeEntry) -> Result<Vec<Value>, GatewayError> {
    let key = TupleKey::from_sort_bytes(entry.raw_key.clone())?.to_record_key();
    parts(&key)
}

fn request_id(parts: &[Value]) -> Result<&str, GatewayError> {
    parts
        .get(5)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Paid-fallback request tuple is malformed"))
}

fn paid_reference(parts: &[Value]) -> Result<(String, String), GatewayError> {
    let key = parts
        .get(4)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Paid-fallback request key is malformed"))?;
    Ok((key.to_owned(), request_id(parts)?.to_owned()))
}

fn object_fields(entry: &NativeEntry) -> Result<BTreeMap<String, Value>, GatewayError> {
    let NativeValue::SourceGraphV1(source) = &entry.value else {
        return Err(invalid("Core-state source value is not a source graph"));
    };
    let graph = crate::graph_transport::from_source_graph(source)?;
    let tree = graph
        .try_identity_free_tree()?
        .ok_or_else(|| invalid("Core-state source graph has shared identity"))?;
    let fields = match tree {
        PortableValue::ObjectUtf16(fields) => fields,
        PortableValue::Object(fields) => fields
            .into_iter()
            .map(|(key, value)| (JsString16::from_utf8(&key), value))
            .collect(),
        _ => return Err(invalid("Core-state source value is not an object")),
    };
    let mut out = BTreeMap::new();
    for (key, value) in fields {
        let key = key.try_utf8()?;
        let value = value
            .to_json_lossless()
            .ok_or_else(|| invalid("Core-state source field cannot be projected"))?;
        if out.insert(key.clone(), value).is_some() {
            return Err(invalid(format!(
                "Core-state source field is duplicated: {key}"
            )));
        }
    }
    Ok(out)
}

fn integer_field(fields: &BTreeMap<String, Value>, name: &str) -> Result<i64, GatewayError> {
    fields.get(name).and_then(Value::as_i64).ok_or_else(|| {
        invalid(format!(
            "Core-state source field is missing or invalid: {name}"
        ))
    })
}

fn window_reset(entry: &NativeEntry) -> Result<i64, GatewayError> {
    integer_field(&object_fields(entry)?, "window_reset_at_ms")
}

fn paid_unresolved(entry: &NativeEntry) -> Result<bool, GatewayError> {
    Ok(matches!(
        object_fields(entry)?
            .get("billing_state")
            .and_then(Value::as_str),
        Some("pending" | "unresolved")
    ))
}

fn classify(
    entry: &NativeEntry,
    captured_at_ms: i64,
    current_paid_requests: &BTreeSet<(String, String)>,
) -> Result<Decision, MigrationError> {
    let p = key_parts(entry)?;
    if starts(&p, &["default"]) {
        return Ok(Decision::Include("default_operational_settings"));
    }
    if starts(&p, &["ubq_ai"]) {
        if starts(&p, &["ubq_ai", "api_keys"])
            || starts(&p, &["ubq_ai", "claude_code_auth"])
            || starts(&p, &["ubq_ai", "claude_code_quota"])
            || starts(&p, &["ubq_ai", "claude_code_workspace"])
            || starts(&p, &["ubq_ai", "codex_auth"])
            || starts(&p, &["ubq_ai", "codex_catalog"])
            || starts(&p, &["ubq_ai", "codex_catalog_auth_generation"])
            || starts(&p, &["ubq_ai", "codex_catalog_chunk"])
            || starts(&p, &["ubq_ai", "codex_catalog_refresh_lease"])
            || starts(&p, &["ubq_ai", "codex_catalog_source_chunk"])
            || starts(&p, &["ubq_ai", "codex_models"])
            || starts(&p, &["ubq_ai", "kernel_auth"])
        {
            return Ok(Decision::Include("ubq_ai_operational_state"));
        }
        return Err(invalid("Core-state selection found an unsupported ubq_ai family").into());
    }
    if starts(&p, &["agent_messages"]) || starts(&p, &["embeddings"]) || starts(&p, &["key"]) {
        return Ok(Decision::Exclude("non_operational_history"));
    }
    if !starts(&p, &["uos_ai"]) {
        return Err(invalid("Core-state selection found an unknown namespace").into());
    }
    if starts(&p, &["uos_ai", "auth"]) {
        return Ok(Decision::Include("auth_identity_state"));
    }
    if starts(&p, &["uos_ai", "claude_code_access"])
        || starts(&p, &["uos_ai", "claude_code_accounts"])
        || starts(&p, &["uos_ai", "claude_code_quota"])
    {
        return Ok(Decision::Include("claude_account_state"));
    }
    if p.get(1)
        .and_then(Value::as_str)
        .is_some_and(|family| family.starts_with("codex_"))
    {
        return Ok(Decision::Include("codex_account_control_state"));
    }
    if starts(&p, &["uos_ai", "kernel_policy_queue"])
        || starts(&p, &["uos_ai", "kernel_pubkeys"])
        || starts(&p, &["uos_ai", "kernel_quota"])
    {
        return Ok(Decision::Include("kernel_control_state"));
    }
    if starts(&p, &["uos_ai", "metered_quota", "v1", "state"]) {
        return Ok(Decision::Include("metered_quota_current_state"));
    }
    if starts(&p, &["uos_ai", "metered_quota"]) {
        return Ok(Decision::Exclude("historical_metered_balance"));
    }
    if starts(&p, &["uos_ai", "provider_capacity", "v1", "snapshot"])
        || starts(&p, &["uos_ai", "provider_capacity", "v1", "last_available"])
        || starts(&p, &["uos_ai", "provider_capacity", "claude"])
    {
        return Ok(Decision::Include("provider_capacity_current_state"));
    }
    if starts(&p, &["uos_ai", "provider_capacity"]) {
        return Ok(Decision::Exclude("historical_provider_capacity"));
    }
    if starts(&p, &["uos_ai", "provider_health"]) {
        return Ok(Decision::Include("provider_health_current_state"));
    }
    if starts(&p, &["uos_ai", "provider_selection"])
        || starts(&p, &["uos_ai", "runtime_config"])
        || starts(&p, &["uos_ai", "migrations"])
    {
        return Ok(Decision::Include("runtime_control_state"));
    }
    if starts(&p, &["uos_ai", "api_key_usage", "v3", "window"]) {
        if window_reset(entry)? > captured_at_ms {
            return Ok(Decision::Include("current_api_key_window"));
        }
        return Ok(Decision::Exclude("historical_api_key_window"));
    }
    if starts(&p, &["uos_ai", "api_key_usage"]) {
        return Ok(Decision::Exclude("historical_api_key_usage_requests"));
    }
    if starts(&p, &["uos_ai", "paid_fallback", "v3", "request"]) {
        if window_reset(entry)? > captured_at_ms {
            return Ok(Decision::Include("current_paid_fallback_requests"));
        }
        return Ok(Decision::Exclude("historical_paid_fallback"));
    }
    if starts(&p, &["uos_ai", "paid_fallback", "v3", "pending"]) {
        if current_paid_requests.contains(&paid_reference(&p)?) {
            return Ok(Decision::Include("current_paid_fallback_pending"));
        }
        return Ok(Decision::Exclude("historical_paid_fallback"));
    }
    if starts(
        &p,
        &["uos_ai", "paid_fallback", "v3", "reconciliation_gate"],
    ) {
        // Source versions disagree on the gate document. Derive it from the
        // retained current pending set inside the same adoption transaction.
        return Ok(Decision::Exclude("recomputed_paid_fallback_gate"));
    }
    if starts(&p, &["uos_ai", "paid_fallback"]) {
        return Ok(Decision::Exclude("historical_paid_fallback"));
    }
    if starts(&p, &["uos_ai", "api_keys"]) {
        return Ok(Decision::Exclude("historical_api_key_audit"));
    }
    if starts(&p, &["uos_ai", "admin_error_log"]) {
        return Ok(Decision::Exclude("historical_error_log"));
    }
    if starts(&p, &["uos_ai", "sentinel_replay"])
        || starts(&p, &["uos_ai", "sentinel_incident"])
        || starts(&p, &["uos_ai", "prompt_cache_analytics"])
        || starts(&p, &["uos_ai", "prompt_cache_telemetry_gate"])
        || starts(&p, &["uos_ai", "prompt_cache_scope_experiment"])
    {
        return Ok(Decision::Exclude("historical_observability"));
    }
    Err(invalid("Core-state selection found an unsupported uos_ai family").into())
}

fn derived_rows(capture: &NativeCapture) -> Result<usize, MigrationError> {
    let mut kernel_defaults = false;
    let mut codex_pool = false;
    let mut api_policies = 0usize;
    let mut session_indexes = 0usize;
    let mut paid_gate = false;
    let mut paid_pending = 0usize;
    let mut current_paid_windows = BTreeSet::new();
    let mut source_paid_windows = BTreeSet::new();
    for entry in &capture.entries {
        if entry.expiration_ms != -1 && entry.expiration_ms <= capture.captured_at_ms {
            continue;
        }
        let p = key_parts(entry)?;
        if p.len() == 2
            && (p[0].as_str() == Some("default"))
            && matches!(
                p[1].as_str(),
                Some("kernel_policy_limit_requests" | "kernel_policy_window_ms")
            )
        {
            kernel_defaults = true;
        } else if starts(&p, &["ubq_ai", "codex_auth"]) && p.len() == 2 {
            codex_pool = true;
        } else if starts(&p, &["ubq_ai", "api_keys", "id"]) && p.len() == 4 {
            api_policies += 1;
        } else if starts(&p, &["uos_ai", "auth", "sessions"]) && p.len() == 3 {
            session_indexes += 1;
        } else if starts(
            &p,
            &["uos_ai", "paid_fallback", "v3", "reconciliation_gate"],
        ) {
            paid_gate = true;
        } else if starts(&p, &["uos_ai", "paid_fallback", "v3", "pending"]) {
            paid_pending += 1;
        } else if starts(&p, &["uos_ai", "paid_fallback", "v3", "request"])
            && window_reset(entry)? > capture.captured_at_ms
        {
            current_paid_windows.insert((
                p[4].as_str()
                    .ok_or_else(|| invalid("Paid request key is malformed"))?
                    .to_owned(),
                window_reset(entry)?,
            ));
        } else if starts(&p, &["uos_ai", "paid_fallback", "v3", "window"])
            && let (Some(key), Some(reset)) = (p[4].as_str(), p[5].as_f64())
        {
            source_paid_windows.insert((key.to_owned(), reset as i64));
        }
    }
    let mut derived =
        usize::from(kernel_defaults) + usize::from(codex_pool) + api_policies + session_indexes;
    if !paid_gate && paid_pending > 0 {
        derived += 1;
    }
    derived += current_paid_windows
        .difference(&source_paid_windows)
        .count();
    Ok(derived)
}

pub(crate) fn select_spool(
    header: &NativeCapture,
    entries: &Spool<NativeEntry>,
) -> Result<CoreStateCapture, MigrationError> {
    header.validate_header()?;
    let source_rows = entries.len();
    let mut current_paid_requests = BTreeSet::new();
    let mut current_paid_unresolved = 0usize;
    let mut current_api_windows = 0usize;
    let mut reader = entries.reader()?;
    while let Some(entry) = reader.next()? {
        let p = key_parts(&entry)?;
        if starts(&p, &["uos_ai", "api_key_usage", "v3", "window"])
            && window_reset(&entry)? > header.captured_at_ms
        {
            current_api_windows += 1;
        } else if starts(&p, &["uos_ai", "paid_fallback", "v3", "request"])
            && window_reset(&entry)? > header.captured_at_ms
        {
            current_paid_requests.insert(paid_reference(&p)?);
            current_paid_unresolved += usize::from(paid_unresolved(&entry)?);
        }
    }
    reader.verify_end()?;
    let mut included = BTreeMap::<&'static str, usize>::new();
    let mut excluded = BTreeMap::<&'static str, usize>::new();
    let mut selected = Vec::new();
    let mut current_paid_pending = 0usize;
    let mut reader = entries.reader()?;
    while let Some(entry) = reader.next()? {
        match classify(&entry, header.captured_at_ms, &current_paid_requests)? {
            Decision::Include(rule) => {
                *included.entry(rule).or_default() += 1;
                if rule == "current_paid_fallback_pending" {
                    current_paid_pending += 1;
                }
                selected.push(entry);
            }
            Decision::Exclude(rule) => {
                *excluded.entry(rule).or_default() += 1;
            }
        }
    }
    reader.verify_end()?;
    let mut capture = header.clone();
    capture.entries = selected;
    let derived_rows = derived_rows(&capture)?;
    let manifest_rows = 1usize;
    let do_row_writes = (capture.entries.len() as u64)
        .checked_mul(2)
        .and_then(|value| value.checked_add(derived_rows as u64))
        .and_then(|value| value.checked_add(manifest_rows as u64))
        .ok_or_else(|| invalid("Core-state write count overflows"))?;
    let manifest = CoreStateManifest {
        v: 1,
        source_git_sha: capture.source_git_sha.clone(),
        captured_at_ms: capture.captured_at_ms,
        source_rows,
        selected_rows: capture.entries.len(),
        excluded_rows: source_rows - capture.entries.len(),
        included: rule_counts(included),
        excluded: rule_counts(excluded),
        derived_rows,
        manifest_rows,
        do_row_writes,
        do_row_write_limit: CORE_STATE_DO_ROW_WRITE_LIMIT,
        within_free_limit: do_row_writes < CORE_STATE_DO_ROW_WRITE_LIMIT,
        current_api_windows,
        current_paid_requests: current_paid_requests.len(),
        current_paid_unresolved,
        current_paid_pending,
    };
    manifest.validate()?;
    Ok(CoreStateCapture { capture, manifest })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_manifest() -> CoreStateManifest {
        CoreStateManifest {
            v: 1,
            source_git_sha: "a".repeat(40),
            captured_at_ms: 1,
            source_rows: 1,
            selected_rows: 1,
            excluded_rows: 0,
            included: vec![CoreStateRuleCount {
                rule: "fixture".into(),
                rows: 1,
            }],
            excluded: vec![],
            derived_rows: 0,
            manifest_rows: 1,
            do_row_writes: 3,
            do_row_write_limit: CORE_STATE_DO_ROW_WRITE_LIMIT,
            within_free_limit: true,
            current_api_windows: 1,
            current_paid_requests: 0,
            current_paid_unresolved: 0,
            current_paid_pending: 0,
        }
    }

    #[test]
    fn missing_current_quota_or_pending_evidence_is_refused() {
        let mut missing_window = valid_manifest();
        missing_window.current_api_windows = 0;
        assert!(missing_window.validate().is_err());

        let mut missing_pending = valid_manifest();
        missing_pending.current_paid_unresolved = 1;
        assert!(missing_pending.validate().is_err());
    }

    #[test]
    fn write_budget_never_accepts_the_free_tier_boundary() {
        let mut manifest = valid_manifest();
        manifest.source_rows = 50_000;
        manifest.selected_rows = 50_000;
        manifest.included[0].rows = 50_000;
        manifest.do_row_writes = 100_001;
        manifest.within_free_limit = false;
        assert!(manifest.validate().is_err());
    }
}
