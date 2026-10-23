//! Source incident-outbox.ts: durable safe classifications, never raw request data.
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{
    replay_model as model,
    replay_values::{SourceObject, read_json_record},
    store,
};
use gateway_admin_runtime::capabilities::{CaptureRequest, Context};
use gateway_auth::{AuthResponse, crypto::sha256_hex};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    query::{QueryRequest, QuerySelector, QueryStore},
    source_json::SourceJson,
    state::{RecordKey, StoredRecord},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

const MESSAGE: &str = "Gateway observed a provider failure for this incident group.";
const FIELDS: &[&str] = &[
    "version",
    "incident_id",
    "fingerprint",
    "severity",
    "first_seen_at_ms",
    "last_seen_at_ms",
    "count",
    "failing_revision",
    "error_type",
    "context",
    "provenance",
    "evidence_ref",
    "evidence_expires_at_ms",
    "latest",
];
fn prefix() -> RecordKey {
    store::key(json!(["uos_ai", "sentinel_incident", "v1", "index"]))
}
fn key(digest: &str) -> RecordKey {
    store::key(json!([
        "uos_ai",
        "sentinel_incident",
        "v1",
        "index",
        digest
    ]))
}
fn full_sha(s: &str) -> bool {
    s.len() == 40
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn positive(n: f64) -> bool {
    model::counter(n) && n > 0.0
}
fn slug(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
pub fn endpoint(s: &str) -> &str {
    match s.split('?').next().unwrap_or("") {
        "/v1/responses" => "/v1/responses",
        "/v1/chat/completions" => "/v1/chat/completions",
        _ => "other",
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Terminal {
    StreamFraming,
    HttpError,
    ResponseFailed,
    ResponseIncomplete,
    Error,
    Deadline,
    Eof,
    Unknown,
}
#[derive(Clone, Debug)]
pub struct IncidentObservation {
    pub endpoint: String,
    pub method: String,
    pub git_sha: String,
    pub observed_at_ms: i64,
    pub status: u16,
    pub stream: bool,
    pub completed: bool,
    pub framing_valid: bool,
    pub terminal_type: Option<String>,
    pub provider: Option<String>,
    pub model: Option<JsString16>,
    pub reasoning: Option<JsString16>,
    pub failure_kind: Option<String>,
}
impl IncidentObservation {
    pub fn terminal(&self) -> Terminal {
        if self.stream && !self.framing_valid {
            return Terminal::StreamFraming;
        }
        match self.terminal_type.as_deref() {
            Some("http.error") => Terminal::HttpError,
            Some("response.failed") => Terminal::ResponseFailed,
            Some("response.incomplete") => Terminal::ResponseIncomplete,
            Some("error") => Terminal::Error,
            Some("deadline") => Terminal::Deadline,
            Some("eof") => Terminal::Eof,
            _ => Terminal::Unknown,
        }
    }
    pub fn fingerprint(&self) -> Result<String, GatewayError> {
        #[derive(Serialize)]
        struct Classification<'a> {
            endpoint: &'a str,
            method: &'a str,
            status: u16,
            stream: bool,
            completed: bool,
            framing_valid: bool,
            terminal: Terminal,
        }
        if self.status > 599 {
            return Err(store::error(
                "Sentinel incident classification status is invalid",
            ));
        }
        let value = Classification {
            endpoint: endpoint(&self.endpoint),
            method: if self.method == "POST" {
                "POST"
            } else {
                "other"
            },
            status: self.status,
            stream: self.stream,
            completed: self.completed,
            framing_valid: self.framing_valid,
            terminal: self.terminal(),
        };
        Ok(sha256_hex(
            SourceJson::from_serializable(&value)?.as_bytes(),
        ))
    }
    fn latest(&self) -> Latest {
        let bounded = |v: &Option<String>, max| v.as_ref().filter(|s| slug(s, max)).cloned();
        let source_slug = |v: &Option<JsString16>, max| {
            v.as_ref()
                .and_then(|s| s.try_utf8().ok())
                .filter(|s| slug(s, max))
        };
        Latest {
            observed_at_ms: self.observed_at_ms as f64,
            revision: full_sha(&self.git_sha).then(|| self.git_sha.clone()),
            provider: bounded(&self.provider, 128),
            route: endpoint(&self.endpoint).into(),
            model: source_slug(&self.model, 128),
            reasoning: source_slug(&self.reasoning, 32),
            failure_kind: bounded(&self.failure_kind, 128),
            terminal: self.terminal(),
            status: f64::from(self.status),
            stream: self.stream,
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
struct Latest {
    observed_at_ms: f64,
    #[serde(deserialize_with = "model::nullable")]
    revision: Option<String>,
    #[serde(deserialize_with = "model::nullable")]
    provider: Option<String>,
    route: String,
    #[serde(deserialize_with = "model::nullable")]
    model: Option<String>,
    #[serde(deserialize_with = "model::nullable")]
    reasoning: Option<String>,
    #[serde(deserialize_with = "model::nullable")]
    failure_kind: Option<String>,
    terminal: Terminal,
    status: f64,
    stream: bool,
}
impl Latest {
    fn valid(&self) -> bool {
        positive(self.observed_at_ms)
            && self.revision.as_deref().is_none_or(full_sha)
            && self.provider.as_ref().is_none_or(|s| slug(s, 128))
            && matches!(
                self.route.as_str(),
                "/v1/responses" | "/v1/chat/completions" | "other"
            )
            && self.model.as_ref().is_none_or(|s| slug(s, 128))
            && self.reasoning.as_ref().is_none_or(|s| slug(s, 32))
            && self.failure_kind.as_ref().is_none_or(|s| slug(s, 128))
            && model::counter(self.status)
            && self.status <= 599.0
    }
}
#[derive(Clone, Deserialize, Serialize)]
struct ContextMessage {
    message: String,
    location: (),
    sample: Vec<SourceJson>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Provenance {
    endpoint: String,
    captured_at_ms: f64,
    captured_by: (),
}
#[derive(Clone, Deserialize, Serialize)]
pub struct EvidenceRef {
    pub r#ref: String,
    #[serde(deserialize_with = "model::nullable")]
    pub digest: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
struct IndexRow {
    version: f64,
    incident_id: String,
    fingerprint: String,
    severity: String,
    first_seen_at_ms: f64,
    last_seen_at_ms: f64,
    count: f64,
    #[serde(deserialize_with = "model::nullable")]
    failing_revision: Option<String>,
    error_type: Terminal,
    context: ContextMessage,
    provenance: Provenance,
    #[serde(deserialize_with = "model::nullable")]
    evidence_ref: Option<EvidenceRef>,
    #[serde(deserialize_with = "model::nullable")]
    evidence_expires_at_ms: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "model::optional_nonnull"
    )]
    latest: Option<Latest>,
}
impl IndexRow {
    fn parse(source: &SourceJson) -> Result<Self, GatewayError> {
        let row: Self = SourceObject::parse(source)?.select(FIELDS)?.deserialize()?;
        if !row.valid() {
            return Err(store::error("Sentinel incident index record is invalid"));
        }
        Ok(row)
    }
    fn valid(&self) -> bool {
        self.version == 1.0
            && crate::replay_read::valid_incident_id(&self.incident_id)
            && model::digest(&self.fingerprint)
            && self.severity == "P2"
            && positive(self.first_seen_at_ms)
            && positive(self.last_seen_at_ms)
            && self.last_seen_at_ms >= self.first_seen_at_ms
            && positive(self.count)
            && self.failing_revision.as_deref().is_none_or(full_sha)
            && self.context.message == MESSAGE
            && self.context.sample.is_empty()
            && matches!(
                self.provenance.endpoint.as_str(),
                "/v1/responses" | "/v1/chat/completions" | "other"
            )
            && positive(self.provenance.captured_at_ms)
            && self.evidence_ref.as_ref().is_none_or(|v| {
                v.r#ref
                    .strip_prefix("capture:")
                    .is_some_and(model::capture_id)
                    && v.digest.as_deref().is_none_or(model::digest)
            })
            && self.evidence_expires_at_ms.is_none_or(positive)
            && self.evidence_ref.is_some() == self.evidence_expires_at_ms.is_some()
            && self.latest.as_ref().is_none_or(Latest::valid)
    }
}
pub struct IncidentIndexReceipt {
    pub incident_id: String,
    pub fingerprint: String,
    pub key: RecordKey,
    pub record: StoredRecord,
}
pub struct IncidentEvidence<'a> {
    pub index_fingerprint: &'a str,
    pub reference_fingerprint: &'a str,
    pub manifest_key: &'a RecordKey,
    pub manifest_record: &'a StoredRecord,
    pub capture_id: &'a str,
    pub git_sha: Option<&'a str>,
    pub captured_at_ms: i64,
    pub expires_at_ms: i64,
    pub ciphertext_sha256: &'a str,
    pub observed_at_ms: i64,
}
pub(crate) struct IndexPublication {
    pub checks: Vec<gateway_core::state::RevisionCheck>,
    pub mutations: Vec<gateway_core::state::RecordMutation>,
}
pub(crate) struct NewCaptureIndex<'a> {
    pub fingerprint: &'a str,
    pub git_sha: &'a str,
    pub ciphertext_sha256: &'a str,
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub(crate) async fn new_capture_index_publication(
        &self,
        binding: &NewCaptureIndex<'_>,
        manifest: &crate::replay_model::Manifest,
        manifest_key: &RecordKey,
    ) -> Result<Option<IndexPublication>, GatewayError> {
        if !model::digest(binding.fingerprint) || !model::digest(binding.ciphertext_sha256) {
            return Err(store::error("New replay index binding is invalid"));
        }
        let key = key(binding.fingerprint);
        let Some(previous) = self.store.read(&key).await? else {
            return Ok(None);
        };
        let source = read_json_record(&previous)?;
        let row = IndexRow::parse(&source)?;
        let mut document = SourceObject::parse(&source)?;
        document.set(
            "failing_revision",
            &full_sha(binding.git_sha).then_some(binding.git_sha),
        )?;
        let mut provenance = SourceObject::parse(
            document
                .get("provenance")
                .ok_or_else(|| store::error("Incident provenance missing"))?,
        )?;
        provenance.set("captured_at_ms", &manifest.captured_at_ms)?;
        document.set("provenance", &provenance.source_json()?)?;
        document.set(
            "evidence_ref",
            &EvidenceRef {
                r#ref: format!("capture:{}", manifest.capture_id),
                digest: Some(binding.ciphertext_sha256.into()),
            },
        )?;
        document.set("evidence_expires_at_ms", &manifest.expires_at_ms)?;
        let document = document.source_json()?;
        IndexRow::parse(&document)?;
        let mut mutations = vec![crate::replay_values::put_json(
            self.host.as_ref(),
            key.clone(),
            &document,
            None,
        )?];
        if manifest.expires_at_ms > store::now(self.host.as_ref())? as f64 {
            mutations.push(store::put(
                self.host.as_ref(),
                store::key(json!([
                    "uos_ai",
                    "sentinel_incident",
                    "v1",
                    "capture_ref",
                    row.incident_id,
                    manifest.fingerprint
                ])),
                json!({"version":1,"manifest_key":store::parts(manifest_key)?}),
                Some(manifest.expires_at_ms as i64),
            )?)
        }
        Ok(Some(IndexPublication {
            checks: vec![store::check(&key, Some(&previous))],
            mutations,
        }))
    }
    pub async fn record_incident_index(
        &self,
        input: &IncidentObservation,
    ) -> Result<IncidentIndexReceipt, GatewayError> {
        if input.observed_at_ms <= 0
            || input.observed_at_ms > gateway_core::identity::MAX_SAFE_INTEGER
        {
            return Err(store::error("Sentinel incident timestamp is invalid"));
        }
        let fingerprint = input.fingerprint()?;
        let key = key(&fingerprint);
        let latest = input.latest();
        for _ in 0..8 {
            let previous = self.store.read(&key).await?;
            let (mut document, mut data) = if let Some(row) = previous.as_ref() {
                let source = read_json_record(row)?;
                (SourceObject::parse(&source)?, IndexRow::parse(&source)?)
            } else {
                let incident_id = format!("provider-{}", store::uuid(self.host.as_ref())?);
                let data = IndexRow {
                    version: 1.0,
                    incident_id,
                    fingerprint: fingerprint.clone(),
                    severity: "P2".into(),
                    first_seen_at_ms: input.observed_at_ms as f64,
                    last_seen_at_ms: input.observed_at_ms as f64,
                    count: 0.0,
                    failing_revision: full_sha(&input.git_sha).then(|| input.git_sha.clone()),
                    error_type: input.terminal(),
                    context: ContextMessage {
                        message: MESSAGE.into(),
                        location: (),
                        sample: Vec::new(),
                    },
                    provenance: Provenance {
                        endpoint: endpoint(&input.endpoint).into(),
                        captured_at_ms: input.observed_at_ms as f64,
                        captured_by: (),
                    },
                    evidence_ref: None,
                    evidence_expires_at_ms: None,
                    latest: Some(latest.clone()),
                };
                (
                    SourceObject::parse(&SourceJson::from_serializable(&data)?)?,
                    data,
                )
            };
            let newest = data.last_seen_at_ms <= input.observed_at_ms as f64;
            data.first_seen_at_ms = data.first_seen_at_ms.min(input.observed_at_ms as f64);
            data.last_seen_at_ms = data.last_seen_at_ms.max(input.observed_at_ms as f64);
            data.count += 1.0;
            if newest {
                data.latest = Some(latest.clone());
                document.set("latest", &data.latest)?;
            }
            if !data.valid() {
                return Err(store::error("Sentinel incident index record is invalid"));
            }
            for (name, value) in [
                ("first_seen_at_ms", data.first_seen_at_ms),
                ("last_seen_at_ms", data.last_seen_at_ms),
                ("count", data.count),
            ] {
                document.set(name, &value)?
            }
            let mutation = crate::replay_values::put_json(
                self.host.as_ref(),
                key.clone(),
                &document.source_json()?,
                None,
            )?;
            let gateway_core::state::RecordMutation::Put { record, .. } = mutation else {
                unreachable!()
            };
            if store::commit(
                self.store.as_ref(),
                vec![store::check(&key, previous.as_ref())],
                vec![gateway_core::state::RecordMutation::Put {
                    key: key.clone(),
                    record: record.clone(),
                }],
            )
            .await?
            {
                return Ok(IncidentIndexReceipt {
                    incident_id: data.incident_id,
                    fingerprint,
                    key,
                    record,
                });
            }
        }
        Err(store::error(
            "Sentinel incident index update conflicted repeatedly",
        ))
    }
    pub async fn list_incidents(
        &self,
        id: Option<&str>,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<AuthResponse, GatewayError> {
        if !(1..=100).contains(&limit) || cursor.is_some_and(|s| !model::cursor_shape(s)) {
            return Err(store::invalid(
                "Sentinel incident index pagination is invalid",
            ));
        }
        let result = async {
            let query = QueryRequest {
                selector: QuerySelector::Prefix {
                    prefix: prefix(),
                    start: None,
                    end: None,
                },
                reverse: false,
                limit,
                cursor: cursor.map(model::core_cursor).transpose()?,
                now_ms: store::now(self.host.as_ref())?,
            };
            let page = self.store.query(query).await?;
            let mut rows = Vec::new();
            for entry in page.entries {
                let source = read_json_record(&entry.record)?;
                let row = IndexRow::parse(&source)?;
                if key(&row.fingerprint) != entry.key {
                    return Err(store::error("Sentinel incident index key is invalid"));
                }
                if id.is_none_or(|id| row.incident_id == id) {
                    rows.push(source)
                }
            }
            #[derive(Serialize)]
            struct Page {
                data: Vec<SourceJson>,
                cursor: Option<String>,
            }
            Ok(AuthResponse::source_json(
                200,
                SourceJson::from_serializable(&Page {
                    data: rows,
                    cursor: page
                        .next_cursor
                        .as_deref()
                        .map(model::wire_cursor)
                        .transpose()?,
                })?,
            ))
        }
        .await;
        result.map_err(|_| {
            GatewayError::unavailable(
                "Sentinel incidents unavailable",
                "sentinel_incidents_unavailable",
            )
        })
    }
    pub async fn bind_incident_evidence(
        &self,
        input: &IncidentEvidence<'_>,
    ) -> Result<(), GatewayError> {
        if !model::digest(input.index_fingerprint)
            || !model::digest(input.reference_fingerprint)
            || !model::digest(input.ciphertext_sha256)
            || input.observed_at_ms <= 0
            || input.captured_at_ms <= 0
            || input.expires_at_ms <= 0
            || !model::capture_id(input.capture_id)
        {
            return Err(store::error(
                "Sentinel incident index evidence binding is invalid",
            ));
        }
        let key = key(input.index_fingerprint);
        for _ in 0..8 {
            let previous = self
                .store
                .read(&key)
                .await?
                .ok_or_else(|| store::error("Sentinel incident index record is missing"))?;
            let source = read_json_record(&previous)?;
            let row = IndexRow::parse(&source)?;
            let mut document = SourceObject::parse(&source)?;
            document.set("failing_revision", &input.git_sha.filter(|s| full_sha(s)))?;
            let mut provenance = SourceObject::parse(
                document
                    .get("provenance")
                    .ok_or_else(|| store::error("Incident provenance missing"))?,
            )?;
            provenance.set("captured_at_ms", &input.captured_at_ms)?;
            document.set("provenance", &provenance.source_json()?)?;
            document.set(
                "evidence_ref",
                &EvidenceRef {
                    r#ref: format!("capture:{}", input.capture_id),
                    digest: Some(input.ciphertext_sha256.into()),
                },
            )?;
            document.set("evidence_expires_at_ms", &input.expires_at_ms)?;
            let document = document.source_json()?;
            IndexRow::parse(&document)?;
            let mut mutations = vec![crate::replay_values::put_json(
                self.host.as_ref(),
                key.clone(),
                &document,
                None,
            )?];
            if input.expires_at_ms > input.observed_at_ms {
                let parts = store::parts(input.manifest_key)?;
                mutations.push(store::put(
                    self.host.as_ref(),
                    store::key(json!([
                        "uos_ai",
                        "sentinel_incident",
                        "v1",
                        "capture_ref",
                        row.incident_id,
                        input.reference_fingerprint
                    ])),
                    json!({"version":1,"manifest_key":parts}),
                    Some(input.expires_at_ms),
                )?)
            }
            if store::commit(
                self.store.as_ref(),
                vec![
                    store::check(&key, Some(&previous)),
                    store::check(input.manifest_key, Some(input.manifest_record)),
                ],
                mutations,
            )
            .await?
            {
                return Ok(());
            }
        }
        Err(store::error(
            "Sentinel incident index evidence binding conflicted repeatedly",
        ))
    }
    pub async fn capture(
        &self,
        request: CaptureRequest,
        _context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        match request {
            CaptureRequest::Request { request_id } => {
                self.export_capture_request(&request_id).await
            }
            CaptureRequest::Interval {
                after_ms,
                before_ms,
                cursor,
            } => {
                self.export_capture_interval(after_ms, before_ms, cursor.as_deref())
                    .await
            }
            CaptureRequest::Incident {
                incident_id,
                cursor,
            } => {
                self.export_incident_captures(&incident_id, cursor.as_deref())
                    .await
            }
            CaptureRequest::Incidents {
                incident_id,
                cursor,
                limit,
            } => {
                self.list_incidents(incident_id.as_deref(), cursor.as_deref(), limit)
                    .await
            }
        }
    }
}
