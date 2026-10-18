//! Constructor-owned read-only source registry, snapshot cache and selection capabilities.
use crate::{
    redaction::redact,
    supervisor::{InventoryScope, KnownThread, SourceId},
    supervisor_brief::{self, SupervisorBriefContext},
    supervisor_inventory::{self as inventory, SessionParts, ThreadProbe, text},
    supervisor_metadata::{self, MetadataRead},
    transport::{SupervisorMethod, SupervisorTransport},
    unix::UnixSupervisor,
};
use gateway_core::GatewayError;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{
        Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
#[derive(Clone, Debug)]
pub struct SupervisorSourceConfig {
    pub(crate) id: SourceId,
    pub(crate) name: String,
    pub(crate) socket: PathBuf,
    pub(crate) home: Option<PathBuf>,
}
impl SupervisorSourceConfig {
    pub fn configured(
        id: SourceId,
        name: String,
        socket: PathBuf,
        codex_home: Option<PathBuf>,
    ) -> Result<Self, GatewayError> {
        let name = name
            .trim_matches(crate::redaction::source_whitespace)
            .to_owned();
        if name.is_empty()
            || name.encode_utf16().count() > 64
            || !socket.is_absolute()
            || socket.to_str().is_none()
            || codex_home
                .as_ref()
                .is_some_and(|v| !v.is_absolute() || v.to_str().is_none())
        {
            return Err(invalid("Invalid configured supervisor source"));
        }
        Ok(Self {
            id,
            name,
            socket,
            home: codex_home,
        })
    }
    pub fn source_id(&self) -> &SourceId {
        &self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn to_source_value(&self) -> Value {
        json!({"id":self.id,"name":self.name,"socketPath":self.socket,"codexHome":self.home})
    }
}
#[derive(Clone, Debug)]
pub struct SelectedSupervisor {
    thread: KnownThread,
    socket: PathBuf,
    home: Option<PathBuf>,
    machine: String,
    sampled_at_ms: i64,
}
impl SelectedSupervisor {
    pub fn known_thread(&self) -> &KnownThread {
        &self.thread
    }
    pub fn configured_socket(&self) -> &Path {
        &self.socket
    }
    pub fn machine(&self) -> &str {
        &self.machine
    }
    pub fn sampled_at_ms(&self) -> i64 {
        self.sampled_at_ms
    }
}
struct Cache {
    at: i64,
    snapshot: Option<Value>,
    generation: u64,
    in_flight: bool,
}
pub struct SupervisorData {
    sources: Vec<SupervisorSourceConfig>,
    notes: Vec<String>,
    hostname: Option<String>,
    cache: Mutex<Cache>,
    wake: Condvar,
}
fn invalid(message: &str) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_request_error"))
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Supervisor snapshot unavailable",
        "native_owner_unavailable",
    )
}
impl SupervisorData {
    pub fn configured(sources: Vec<SupervisorSourceConfig>) -> Result<Self, GatewayError> {
        if sources.len() > 8 {
            return Err(invalid("Too many supervisor sources"));
        }
        let mut ids = BTreeSet::new();
        if sources
            .iter()
            .any(|s| !ids.insert(s.id.as_str().to_owned()))
        {
            return Err(invalid("Duplicate supervisor source id"));
        }
        Ok(Self {
            sources,
            notes: Vec::new(),
            hostname: None,
            cache: Mutex::new(Cache {
                at: 0,
                snapshot: None,
                generation: 0,
                in_flight: false,
            }),
            wake: Condvar::new(),
        })
    }
    /// Local constructor metadata only; never populated from a request.
    pub fn with_metadata(mut self, hostname: Option<String>, notes: Vec<String>) -> Self {
        self.hostname = hostname;
        self.notes = notes;
        self
    }
    pub fn snapshot(&self, now_ms: i64) -> Result<Value, GatewayError> {
        let mut cache = self.cache.lock().map_err(|_| unavailable())?;
        loop {
            if let Some(value) = &cache.snapshot
                && now_ms.saturating_sub(cache.at) < 4000
            {
                return Ok(value.clone());
            }
            if !cache.in_flight {
                break;
            }
            cache = self.wake.wait(cache).map_err(|_| unavailable())?;
        }
        cache.in_flight = true;
        drop(cache);
        let start = Instant::now();
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.collect(now_ms, start)))
                .map_err(|_| unavailable());
        let mut cache = self.cache.lock().map_err(|_| unavailable())?;
        cache.in_flight = false;
        if let Ok(value) = &result {
            cache.at = now_ms.saturating_add(start.elapsed().as_millis() as i64);
            cache.generation = cache.generation.saturating_add(1);
            cache.snapshot = Some(value.clone());
        }
        self.wake.notify_all();
        result
    }
    pub fn select(
        &self,
        source_id: &str,
        thread_id: &str,
        now_ms: i64,
    ) -> Result<SelectedSupervisor, GatewayError> {
        if !inventory::valid_thread(thread_id) {
            return Err(invalid("Invalid thread id"));
        }
        let parsed = SourceId::parse(source_id)?;
        let source = self
            .sources
            .iter()
            .find(|s| s.id == parsed)
            .ok_or_else(|| invalid("Unknown supervisor source"))?;
        let snapshot = self.snapshot(now_ms)?;
        let view = snapshot["sources"]
            .as_array()
            .and_then(|s| s.iter().find(|s| s["id"] == source_id));
        let available = view.is_some_and(|v| v["state"] == "ok");
        let ids = snapshot["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|s| s["sourceId"] == source_id)
            .filter_map(|s| s["id"].as_str().map(str::to_owned))
            .collect();
        let sampled = snapshot["sampledAtMs"].as_i64().ok_or_else(unavailable)?;
        let scope = InventoryScope {
            generation: format!("{sampled}"),
            source: parsed,
            available,
            thread_ids: ids,
        };
        let thread = scope.select(thread_id)?;
        Ok(SelectedSupervisor {
            thread,
            socket: source.socket.clone(),
            home: source.home.clone(),
            machine: redact(&source.name).text,
            sampled_at_ms: sampled,
        })
    }
    pub fn brief_context(
        &self,
        selected: &SelectedSupervisor,
        now_ms: i64,
    ) -> Result<SupervisorBriefContext, GatewayError> {
        let source = self
            .sources
            .iter()
            .find(|s| {
                s.id == *selected.thread.source()
                    && s.socket == selected.socket
                    && s.home == selected.home
            })
            .ok_or_else(unavailable)?;
        supervisor_brief::collect_context(
            &source.socket,
            source.home.as_deref(),
            &selected.thread,
            &source.name,
            now_ms,
        )
    }
    fn collect(&self, now_ms: i64, start: Instant) -> Value {
        let next = AtomicUsize::new(0);
        let deadline = start + Duration::from_secs(9);
        let mut samples = std::thread::scope(|scope| {
            let mut workers = Vec::new();
            for _ in 0..self.sources.len().min(2) {
                let next = &next;
                workers.push(scope.spawn(move || {
                    let mut values = Vec::new();
                    loop {
                        let at = next.fetch_add(1, Ordering::Relaxed);
                        let Some(source) = self.sources.get(at) else {
                            break;
                        };
                        values.push((
                            at,
                            sample_source(
                                source,
                                now_ms.saturating_add(start.elapsed().as_millis() as i64),
                                deadline,
                                self.hostname.as_deref(),
                            ),
                        ));
                    }
                    values
                }));
            }
            workers
                .into_iter()
                .flat_map(|w| {
                    w.join()
                        .unwrap_or_else(|error| std::panic::resume_unwind(error))
                })
                .collect::<Vec<_>>()
        });
        samples.sort_by_key(|(at, _)| *at);
        let mut views = Vec::new();
        let mut sessions = Vec::new();
        for (_, sample) in samples {
            views.push(sample.view);
            sessions.extend(sample.sessions);
        }
        let mut value = inventory::snapshot_from_samples(
            now_ms.saturating_add(start.elapsed().as_millis() as i64),
            views,
            sessions,
            self.notes.clone(),
        );
        sanitize_snapshot_metadata(&mut value);
        value
    }
}
fn sanitize_snapshot_metadata(value: &mut Value) {
    for session in value
        .get_mut("sessions")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        for key in [
            "machine",
            "title",
            "cwd",
            "branch",
            "model",
            "effort",
            "provider",
            "sourceKind",
        ] {
            if let Some(raw) = session.get(key).and_then(Value::as_str) {
                session[key] = json!(redact(raw).text);
            }
        }
        if let Some(flags) = session.get_mut("activeFlags").and_then(Value::as_array_mut) {
            for flag in flags {
                if let Some(text) = flag.as_str() {
                    *flag = json!(redact(text).text);
                }
            }
        }
    }
}
struct SourceSample {
    view: Value,
    sessions: Vec<Value>,
}
fn call(
    socket: &mut UnixSupervisor,
    method: SupervisorMethod,
    params: Value,
) -> Result<Value, GatewayError> {
    futures_executor::block_on(socket.call(method, params))
}
fn close(socket: &mut UnixSupervisor) {
    let _ = futures_executor::block_on(socket.close());
}
fn error_message(error: &GatewayError) -> String {
    error.envelope.error.message.clone()
}
fn metadata(source: &SupervisorSourceConfig, ids: Option<&[String]>) -> MetadataRead {
    source
        .home
        .as_ref()
        .map(|home| supervisor_metadata::read_metadata(home, ids))
        .unwrap_or(MetadataRead {
            database: None,
            rows: BTreeMap::new(),
            reason: Some("remote source has no local metadata database".into()),
        })
}
struct ViewState {
    available: bool,
    reason: Option<String>,
    counts: (usize, usize, usize, bool),
    lineage: bool,
    quota: Option<Value>,
}
fn source_view(
    source: &SupervisorSourceConfig,
    now: i64,
    duration: usize,
    meta: &MetadataRead,
    hostname: Option<&str>,
    state: ViewState,
) -> Value {
    let ViewState {
        available,
        reason,
        counts,
        lineage,
        quota,
    } = state;
    json!({"id":source.id,"name":redact(&source.name).text,"kind":if source.home.is_some(){"local"}else{"remote"},"hostname":if source.home.is_some(){hostname}else{None},"state":if available{"ok"}else{"unavailable"},"reason":reason,"metadata":{"available":meta.reason.is_none(),"database":meta.database,"reason":meta.reason},"inventory":{"listed":counts.0,"sampled":counts.1,"returned":counts.2,"truncated":counts.3},"lineage":if lineage{"available"}else{"unavailable"},"quota":quota,"quotaReason":if available{"account quota read unavailable"}else{"source unavailable"},"durationMs":duration,"sampledAtMs":now})
}
fn sample_source(
    source: &SupervisorSourceConfig,
    now: i64,
    deadline: Instant,
    hostname: Option<&str>,
) -> SourceSample {
    let start = Instant::now();
    let result = (|| -> Result<SourceSample, GatewayError> {
        let mut socket = UnixSupervisor::configured_socket_until(&source.socket, deadline)?;
        let collected = (|| {
            let loaded = call(&mut socket, SupervisorMethod::ThreadLoadedList, json!({}))?
                .get("data")
                .and_then(Value::as_array)
                .map(|v| {
                    v.iter()
                        .filter_map(Value::as_str)
                        .filter(|id| inventory::valid_thread(id))
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let loaded_set = loaded.iter().collect::<BTreeSet<_>>();
            let mut listed = Vec::new();
            let mut cursor = None;
            let mut truncated = false;
            for _ in 0..2 {
                let reply = call(
                    &mut socket,
                    SupervisorMethod::ThreadList,
                    inventory::list_params(cursor.as_deref()),
                )?;
                listed.extend(
                    reply
                        .get("data")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(inventory::listed_thread),
                );
                cursor = text(reply.get("nextCursor"));
                if cursor.is_none() || listed.len() >= 60 {
                    break;
                }
            }
            if cursor.is_some() {
                truncated = true;
            }
            if listed.len() > 60 {
                listed.truncate(60);
                truncated = true;
            }
            let listed_ids = listed.iter().map(|v| v.id.clone()).collect::<Vec<_>>();
            let mut metadata_ids = listed_ids.clone();
            metadata_ids.extend(loaded.iter().take(8).cloned());
            let mut seen = BTreeSet::new();
            metadata_ids.retain(|id| seen.insert(id.clone()));
            let meta = metadata(source, Some(&metadata_ids));
            let ids = inventory::probe_ids(&listed_ids, &loaded);
            let next = AtomicUsize::new(0);
            let probes = std::thread::scope(|scope| {
                let mut workers = Vec::new();
                for _ in 0..ids.len().min(4) {
                    let ids = &ids;
                    let next = &next;
                    workers.push(scope.spawn(move || {
                        let mut values = Vec::new();
                        loop {
                            let at = next.fetch_add(1, Ordering::Relaxed);
                            let Some(id) = ids.get(at) else {
                                break;
                            };
                            values.push((id.clone(), probe(source, id, deadline)));
                        }
                        values
                    }));
                }
                workers
                    .into_iter()
                    .flat_map(|w| {
                        w.join()
                            .unwrap_or_else(|error| std::panic::resume_unwind(error))
                    })
                    .collect::<BTreeMap<_, _>>()
            });
            let listed_map = listed
                .into_iter()
                .map(|v| (v.id.clone(), v))
                .collect::<BTreeMap<_, _>>();
            let mut row_ids = listed_ids.clone();
            row_ids.extend(ids.iter().cloned());
            let mut seen = BTreeSet::new();
            row_ids.retain(|id| seen.insert(id.clone()));
            let live = row_ids
                .iter()
                .filter_map(|id| {
                    inventory::merge_live(
                        listed_map.get(id),
                        probes.get(id).and_then(|p| p.thread.as_ref()),
                    )
                    .map(|v| (id.clone(), v))
                })
                .collect::<BTreeMap<_, _>>();
            let children = inventory::children_by_parent(&row_ids, &live, &meta.rows);
            let lineage = !listed_map.is_empty()
                || probes.values().any(|p| p.thread.is_some())
                || (source.home.is_some() && meta.reason.is_none());
            let mut sessions = Vec::new();
            for id in &row_ids {
                let p = probes.get(id);
                let mut notes = Vec::new();
                if p.is_none() {
                    notes.push("live status not sampled in this pass".into());
                }
                if source.home.is_none() {
                    notes.push("token usage is not reported by the source".into());
                } else if let Some(reason) = &meta.reason {
                    notes.push(format!("metadata unavailable: {reason}"));
                }
                sessions.push(inventory::session_from_parts(SessionParts {
                    id,
                    source_id: source.id.as_str(),
                    machine: &source.name,
                    metadata: meta.rows.get(id),
                    listed: listed_map.get(id),
                    probe: p,
                    loaded: loaded_set.contains(id),
                    sampled_at_ms: now,
                    child_ids: lineage.then(|| children.get(id).cloned().unwrap_or_default()),
                    unavailable: notes,
                }));
            }
            let quota = call(
                &mut socket,
                SupervisorMethod::AccountRateLimitsRead,
                json!({}),
            )
            .ok()
            .and_then(|v| inventory::quota_from_rate_limits(&v));
            let mut view = source_view(
                source,
                now,
                start.elapsed().as_millis() as usize,
                &meta,
                hostname,
                ViewState {
                    available: true,
                    reason: None,
                    counts: (
                        listed_ids.len(),
                        ids.len(),
                        sessions.len(),
                        truncated || ids.len() < row_ids.len(),
                    ),
                    lineage,
                    quota: quota.clone(),
                },
            );
            if quota.is_some() {
                view["quotaReason"] = Value::Null;
            }
            Ok(SourceSample { view, sessions })
        })();
        close(&mut socket);
        collected
    })();
    result.unwrap_or_else(|error| {
        let reason = error_message(&error);
        let meta = metadata(source, None);
        let sessions = meta
            .rows
            .iter()
            .map(|(id, row)| {
                inventory::session_from_parts(SessionParts {
                    id,
                    source_id: source.id.as_str(),
                    machine: &source.name,
                    metadata: Some(row),
                    listed: None,
                    probe: None,
                    loaded: false,
                    sampled_at_ms: now,
                    child_ids: None,
                    unavailable: vec![
                        format!("live status unavailable: {reason}"),
                        "persisted metadata shown; it may be stale".into(),
                    ],
                })
            })
            .collect::<Vec<_>>();
        let view = source_view(
            source,
            now,
            start.elapsed().as_millis() as usize,
            &meta,
            hostname,
            ViewState {
                available: false,
                reason: Some(reason),
                counts: (meta.rows.len(), 0, sessions.len(), meta.rows.len() >= 60),
                lineage: source.home.is_some() && meta.reason.is_none(),
                quota: None,
            },
        );
        SourceSample { view, sessions }
    })
}
fn probe(source: &SupervisorSourceConfig, id: &str, deadline: Instant) -> ThreadProbe {
    let Ok(mut socket) = UnixSupervisor::configured_socket_until(&source.socket, deadline) else {
        return ThreadProbe::default();
    };
    let mut out = ThreadProbe {
        sampled: true,
        ..ThreadProbe::default()
    };
    match call(
        &mut socket,
        SupervisorMethod::ThreadRead,
        json!({"threadId":id,"includeTurns":false}),
    ) {
        Ok(reply) => {
            let thread = reply.get("thread");
            out.thread = thread.and_then(inventory::listed_thread);
            out.runtime_status = thread
                .and_then(|t| t.get("status"))
                .and_then(|s| s.get("type"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            out.active_flags = thread
                .and_then(|t| t.get("status"))
                .and_then(|s| s.get("activeFlags"))
                .and_then(Value::as_array)
                .map(|v| {
                    v.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
        }
        Err(_) => out.sampled = false,
    }
    match call(
        &mut socket,
        SupervisorMethod::ThreadTurnsList,
        json!({"threadId":id,"limit":1,"sortDirection":"desc","itemsView":"notLoaded"}),
    ) {
        Ok(reply) => {
            out.turn_status = reply
                .get("data")
                .and_then(Value::as_array)
                .and_then(|v| v.first())
                .and_then(|t| text(t.get("status")))
        }
        Err(_) => out.sampled = false,
    }
    close(&mut socket);
    out
}

/// Pure trusted-configuration parsing; never reads HOME, files, or requests.
pub fn parse_config(raw: &Value) -> (Vec<SupervisorSourceConfig>, Vec<String>) {
    if !raw.is_object() {
        return (vec![], vec!["configuration must be a JSON object".into()]);
    }
    let entries = raw
        .get("sources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if entries.is_empty() {
        return (vec![], vec!["configuration lists no sources".into()]);
    }
    let mut out = Vec::new();
    let mut notes = Vec::new();
    let mut seen = BTreeSet::new();
    for entry in entries.iter().take(8) {
        if !entry.is_object() {
            notes.push("ignored a source that is not an object".into());
            continue;
        }
        let id = text(entry.get("id"));
        let parsed = id.as_ref().and_then(|id| SourceId::parse(id).ok());
        let Some(parsed) = parsed else {
            notes.push("ignored a source whose id must match /^[a-z0-9][a-z0-9_-]{0,31}$/".into());
            continue;
        };
        let id = parsed.as_str();
        if seen.contains(id) {
            notes.push(format!("ignored duplicate source id {id}"));
            continue;
        }
        let name = text(entry.get("name"));
        if name.as_ref().is_none_or(|n| n.encode_utf16().count() > 64) {
            notes.push(format!("ignored source {id}: name must be 1-64 characters"));
            continue;
        }
        let socket = text(entry.get("socketPath"));
        if socket.as_ref().is_none_or(|n| !n.starts_with('/')) {
            notes.push(format!(
                "ignored source {id}: socketPath must be an absolute path"
            ));
            continue;
        }
        let home = text(entry.get("codexHome"));
        if home.as_ref().is_some_and(|n| !n.starts_with('/')) {
            notes.push(format!(
                "ignored source {id}: codexHome must be an absolute path"
            ));
            continue;
        }
        seen.insert(id.to_owned());
        if let (Some(name), Some(socket)) = (name, socket)
            && let Ok(source) = SupervisorSourceConfig::configured(
                parsed,
                name,
                PathBuf::from(socket),
                home.map(PathBuf::from),
            )
        {
            out.push(source);
        }
    }
    if entries.len() > 8 {
        notes.push("only the first 8 sources are used".into());
    }
    (out, notes)
}
