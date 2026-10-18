//! Pure source inventory projection and finite read-only sampling.
use crate::supervisor::classify_state;
use crate::supervisor_metadata::ThreadMetadata;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|s| s.trim_matches(crate::redaction::source_whitespace))
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}
pub fn finite(value: Option<&Value>) -> Option<Value> {
    value
        .filter(|v| v.as_f64().is_some_and(f64::is_finite))
        .cloned()
}
pub fn epoch_ms(value: Option<&Value>) -> Option<i64> {
    let n = value?.as_f64()?;
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    let n = if n < 1_000_000_000_000.0 {
        (n * 1000.0).round()
    } else {
        n.round()
    };
    (n <= i64::MAX as f64).then_some(n as i64)
}
pub fn valid_thread(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-'))
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedThread {
    pub id: String,
    pub name: Option<String>,
    pub preview: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub source_kind: Option<String>,
    pub parent_thread_id: Option<String>,
    pub updated_at_ms: Option<i64>,
    pub model_provider: Option<String>,
}
pub fn listed_thread(value: &Value) -> Option<ListedThread> {
    let id = text(value.get("id"))?;
    if !valid_thread(&id) {
        return None;
    }
    Some(ListedThread {
        id,
        name: text(value.get("name")),
        preview: text(value.get("preview")),
        cwd: text(value.get("cwd")),
        model: text(value.get("model")),
        effort: text(value.get("reasoningEffort")),
        source_kind: text(value.get("source")),
        parent_thread_id: text(value.get("parentThreadId")),
        updated_at_ms: epoch_ms(value.get("updatedAt")),
        model_provider: text(value.get("modelProvider")),
    })
}
pub fn merge_live(
    listed: Option<&ListedThread>,
    probed: Option<&ListedThread>,
) -> Option<ListedThread> {
    match (listed, probed) {
        (None, None) => None,
        (Some(v), None) | (None, Some(v)) => Some(v.clone()),
        (Some(a), Some(b)) => Some(ListedThread {
            id: a.id.clone(),
            name: a.name.clone().or_else(|| b.name.clone()),
            preview: a.preview.clone().or_else(|| b.preview.clone()),
            cwd: a.cwd.clone().or_else(|| b.cwd.clone()),
            model: a.model.clone().or_else(|| b.model.clone()),
            effort: a.effort.clone().or_else(|| b.effort.clone()),
            source_kind: a.source_kind.clone().or_else(|| b.source_kind.clone()),
            parent_thread_id: a
                .parent_thread_id
                .clone()
                .or_else(|| b.parent_thread_id.clone()),
            updated_at_ms: a.updated_at_ms.or(b.updated_at_ms),
            model_provider: a
                .model_provider
                .clone()
                .or_else(|| b.model_provider.clone()),
        }),
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadProbe {
    pub runtime_status: Option<String>,
    pub active_flags: Vec<String>,
    pub turn_status: Option<String>,
    pub thread: Option<ListedThread>,
    pub sampled: bool,
}
fn gap_contains(value: &str, left: &str, right: &str) -> bool {
    let units = value.encode_utf16().collect::<Vec<_>>();
    let left = left.encode_utf16().collect::<Vec<_>>();
    let right = right.encode_utf16().collect::<Vec<_>>();
    for at in 0..units.len() {
        if units.get(at..at + left.len()) != Some(left.as_slice()) {
            continue;
        }
        let end = at + left.len();
        if units.get(end..end + right.len()) == Some(right.as_slice()) {
            return true;
        }
        if units
            .get(end)
            .is_some_and(|c| ![10, 13, 0x2028, 0x2029].contains(c))
            && units.get(end + 1..end + 1 + right.len()) == Some(right.as_slice())
        {
            return true;
        }
    }
    false
}
pub fn waits(flags: &[String]) -> (bool, bool) {
    (
        flags
            .iter()
            .any(|f| f.to_ascii_lowercase().contains("approval")),
        flags.iter().any(|f| {
            let f = f.to_ascii_lowercase();
            f.contains("needsinput")
                || gap_contains(&f, "user", "input")
                || gap_contains(&f, "input", "request")
        }),
    )
}
#[derive(Clone, Debug)]
pub struct SessionParts<'a> {
    pub id: &'a str,
    pub source_id: &'a str,
    pub machine: &'a str,
    pub metadata: Option<&'a ThreadMetadata>,
    pub listed: Option<&'a ListedThread>,
    pub probe: Option<&'a ThreadProbe>,
    pub loaded: bool,
    pub sampled_at_ms: i64,
    pub child_ids: Option<Vec<String>>,
    pub unavailable: Vec<String>,
}
pub fn session_from_parts(input: SessionParts<'_>) -> Value {
    let live = merge_live(input.listed, input.probe.and_then(|p| p.thread.as_ref()));
    let m = input.metadata;
    let l = live.as_ref();
    let live_title = l.and_then(|v| v.name.clone().or_else(|| v.preview.clone()));
    let metadata_title = m.and_then(|v| v.title.clone().or_else(|| v.preview.clone()));
    let title_source = if live_title.is_some() {
        Some("thread")
    } else if metadata_title.is_some() {
        Some("metadata")
    } else {
        None
    };
    let flags = input
        .probe
        .map(|v| v.active_flags.clone())
        .unwrap_or_default();
    let (approval, user) = waits(&flags);
    let state = input
        .probe
        .map(|p| {
            classify_state(
                p.runtime_status.as_deref(),
                p.turn_status.as_deref(),
                input.loaded,
            )
        })
        .unwrap_or(crate::supervisor::SupervisorState::Unknown);
    let tokens = m.and_then(|v| v.tokens_used.clone());
    json!({"id":input.id,"sourceId":input.source_id,"machine":input.machine,"title":live_title.or(metadata_title),"titleSource":title_source,"cwd":l.and_then(|v|v.cwd.clone()).or_else(||m.and_then(|v|v.cwd.clone())),"branch":m.and_then(|v|v.git_branch.clone()),"model":l.and_then(|v|v.model.clone()).or_else(||m.and_then(|v|v.model.clone())),"effort":l.and_then(|v|v.effort.clone()).or_else(||m.and_then(|v|v.effort.clone())),"provider":l.and_then(|v|v.model_provider.clone()),"sourceKind":l.and_then(|v|v.source_kind.clone()).or_else(||m.and_then(|v|v.thread_source.clone())),"parentThreadId":l.and_then(|v|v.parent_thread_id.clone()).or_else(||m.and_then(|v|v.parent_thread_id.clone())),"lastActivityAtMs":l.and_then(|v|v.updated_at_ms).or_else(||m.and_then(|v|v.updated_at_ms)),"tokensUsed":tokens,"usageSource":tokens.as_ref().map(|_|"state_db"),"state":state,"activeFlags":flags,"loaded":input.loaded,"waitingOnApproval":approval,"waitingOnUserInput":user,"childIds":input.child_ids,"lastSampledAtMs":input.sampled_at_ms,"sampled":input.probe.is_some_and(|p|p.sampled),"unavailable":input.unavailable})
}
pub fn quota_from_rate_limits(result: &Value) -> Option<Value> {
    let root = result.get("rateLimits")?.as_object()?;
    let mut buckets = Vec::new();
    if let Some(values) = result.get("rateLimitsByLimitId").and_then(Value::as_object) {
        for (key, value) in values {
            if let Some(bucket) = quota_bucket(value, key) {
                buckets.push(bucket);
            }
        }
    }
    if buckets.is_empty() {
        buckets.push(quota_bucket(&Value::Object(root.clone()), "codex")?);
    }
    Some(
        json!({"accountScope":"shared_codex_account","buckets":buckets,"resetCreditsAvailable":finite(result.get("rateLimitResetCredits").and_then(|v|v.get("availableCount")))}),
    )
}
fn quota_bucket(value: &Value, id: &str) -> Option<Value> {
    value.as_object()?;
    let primary = value.get("primary").filter(|v| v.is_object());
    Some(
        json!({"limitId":text(value.get("limitId")).unwrap_or_else(||id.into()),"limitName":text(value.get("limitName")),"usedPercent":finite(value.get("usedPercent")).or_else(||finite(primary.and_then(|p|p.get("usedPercent")))),"windowDurationMins":finite(value.get("windowDurationMins")).or_else(||finite(primary.and_then(|p|p.get("windowDurationMins")))),"resetsAtMs":epoch_ms(value.get("resetsAt")).or_else(||epoch_ms(primary.and_then(|p|p.get("resetsAt")))),"planType":text(value.get("planType")),"reachedType":text(value.get("rateLimitReachedType"))}),
    )
}
pub fn probe_ids(listed: &[String], loaded: &[String]) -> Vec<String> {
    let listed_set = listed.iter().collect::<BTreeSet<_>>();
    let mut out = listed.iter().take(24).cloned().collect::<Vec<_>>();
    out.extend(
        loaded
            .iter()
            .filter(|id| !listed_set.contains(id))
            .take(8)
            .cloned(),
    );
    let mut seen = BTreeSet::new();
    out.retain(|id| seen.insert(id.clone()));
    out
}
pub fn children_by_parent(
    ids: &[String],
    live: &BTreeMap<String, ListedThread>,
    metadata: &BTreeMap<String, ThreadMetadata>,
) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in ids {
        let parent = live
            .get(id)
            .and_then(|v| v.parent_thread_id.clone())
            .or_else(|| metadata.get(id).and_then(|v| v.parent_thread_id.clone()));
        if let Some(parent) = parent {
            out.entry(parent).or_default().push(id.clone());
        }
    }
    out
}
pub const SOURCE_KINDS: [&str; 10] = [
    "cli",
    "vscode",
    "exec",
    "appServer",
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
    "unknown",
];
pub fn list_params(cursor: Option<&str>) -> Value {
    let mut value = json!({"limit":50,"useStateDbOnly":true,"sourceKinds":SOURCE_KINDS,"sortKey":"updated_at","sortDirection":"desc"});
    if let Some(cursor) = cursor {
        value["cursor"] = json!(cursor);
    }
    value
}
pub fn snapshot_from_samples(
    sampled_at_ms: i64,
    sources: Vec<Value>,
    mut sessions: Vec<Value>,
    mut notes: Vec<String>,
) -> Value {
    let order = |value: &Value| match value.get("state").and_then(Value::as_str) {
        Some("active") => 0,
        Some("stale") => 1,
        Some("idle") => 2,
        Some("unknown") => 3,
        _ => 4,
    };
    sessions.sort_by(|a, b| {
        order(a).cmp(&order(b)).then_with(|| {
            b.get("lastActivityAtMs")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .cmp(
                    &a.get("lastActivityAtMs")
                        .and_then(Value::as_i64)
                        .unwrap_or(0),
                )
        })
    });
    let count = |state: &str| sessions.iter().filter(|v| v["state"] == state).count();
    let waiting = sessions
        .iter()
        .filter(|v| v["waitingOnApproval"] == true || v["waitingOnUserInput"] == true)
        .count();
    let listed = sources
        .iter()
        .filter_map(|v| v["inventory"]["listed"].as_u64())
        .sum::<u64>();
    let sampled = sources
        .iter()
        .filter_map(|v| v["inventory"]["sampled"].as_u64())
        .sum::<u64>();
    let truncated = sources.iter().any(|v| v["inventory"]["truncated"] == true);
    let unavailable = sources
        .iter()
        .filter(|v| v["state"] == "unavailable")
        .filter_map(|v| v["id"].as_str())
        .collect::<Vec<_>>();
    if !unavailable.is_empty() {
        notes.push(format!(
            "{} of {} sources unavailable: {}",
            unavailable.len(),
            sources.len(),
            unavailable.join(", ")
        ));
    }
    if truncated {
        notes.push(
            "inventory was truncated; the panel lists the most recently updated threads per source"
                .into(),
        );
    }
    json!({"sampledAtMs":sampled_at_ms,"view":"codex_app_server_read_only","sources":sources,"counts":{"total":sessions.len(),"active":count("active"),"waiting":waiting,"idle":count("idle"),"stale":count("stale"),"unknown":count("unknown"),"systemError":count("system_error")},"sessions":sessions,"coverage":{"listed":listed,"sampled":sampled,"truncated":truncated,"notes":notes}})
}
