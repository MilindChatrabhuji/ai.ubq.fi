//! Private Worker-binding protocol for the single coordination authority.
//! The public router must never forward client requests to these store routes.

use std::rc::Rc;

use futures_util::StreamExt;
use gateway_core::GatewayError;
use gateway_core::query::{QueryEntry, QueryPage, QueryRequest, QuerySelector, QueryStore};
use gateway_core::state::{
    AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
    StoredRecord,
};
use serde::{Deserialize, Serialize};
use worker::js_sys::Uint8Array;
use worker::{
    DurableObject, Env, Headers, Method, Request, RequestInit, Response, State, Stub,
    durable_object,
};

use crate::storage::SqliteAuthorityStore;
use crate::transport::body::request_bytes;

const WIRE_VERSION_HEADER: &str = "x-uos-authority-wire-version";
const WIRE_VERSION: &str = "1";
const WIRE_URL: &str = "https://authority.internal/v1/store";
const WIRE_MAX_BYTES: usize = 32 * 1024 * 1024;
const AUTHORITY_OBJECT: &str = "gateway-authority-v1";

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum StoreRequest {
    ProfileMigration {
        request: ProfileMigration,
        request_id: String,
        now_ms: i64,
    },
    Read {
        key: String,
    },
    Commit {
        checks: Vec<WireCheck>,
        mutations: Vec<WireMutation>,
    },
    Query {
        selector: WireSelector,
        reverse: bool,
        limit: u32,
        cursor: Option<String>,
        now_ms: i64,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ProfileMigration {
    Import {
        ndjson: String,
        profile: ProfileKind,
        include_cache: bool,
        include_legacy: bool,
        overwrite: bool,
        dry_run: bool,
    },
    Validate,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ProfileKind {
    Local,
    Prod,
}
impl From<gateway_admin_runtime::capabilities::MigrationRequest> for ProfileMigration {
    fn from(request: gateway_admin_runtime::capabilities::MigrationRequest) -> Self {
        use gateway_admin_runtime::capabilities::{MigrationProfile, MigrationRequest};
        match request {
            MigrationRequest::Validate => Self::Validate,
            MigrationRequest::Import(value) => Self::Import {
                ndjson: value.ndjson,
                profile: match value.profile {
                    MigrationProfile::Local => ProfileKind::Local,
                    MigrationProfile::Prod => ProfileKind::Prod,
                },
                include_cache: value.include_cache,
                include_legacy: value.include_legacy,
                overwrite: value.overwrite,
                dry_run: value.dry_run,
            },
        }
    }
}
impl From<ProfileMigration> for gateway_admin_runtime::capabilities::MigrationRequest {
    fn from(request: ProfileMigration) -> Self {
        use gateway_admin_runtime::capabilities::{
            MigrationImport, MigrationProfile, MigrationRequest,
        };
        match request {
            ProfileMigration::Validate => MigrationRequest::Validate,
            ProfileMigration::Import {
                ndjson,
                profile,
                include_cache,
                include_legacy,
                overwrite,
                dry_run,
            } => MigrationRequest::Import(MigrationImport {
                ndjson,
                profile: match profile {
                    ProfileKind::Local => MigrationProfile::Local,
                    ProfileKind::Prod => MigrationProfile::Prod,
                },
                include_cache,
                include_legacy,
                overwrite,
                dry_run,
            }),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WireSelector {
    Prefix {
        prefix: String,
        start: Option<String>,
        end: Option<String>,
    },
    Range {
        start: String,
        end: String,
    },
}

impl From<QuerySelector> for WireSelector {
    fn from(value: QuerySelector) -> Self {
        match value {
            QuerySelector::Prefix { prefix, start, end } => Self::Prefix {
                prefix: prefix.0,
                start: start.map(|key| key.0),
                end: end.map(|key| key.0),
            },
            QuerySelector::Range { start, end } => Self::Range {
                start: start.0,
                end: end.0,
            },
        }
    }
}

impl From<WireSelector> for QuerySelector {
    fn from(value: WireSelector) -> Self {
        match value {
            WireSelector::Prefix { prefix, start, end } => Self::Prefix {
                prefix: RecordKey(prefix),
                start: start.map(RecordKey),
                end: end.map(RecordKey),
            },
            WireSelector::Range { start, end } => Self::Range {
                start: RecordKey(start),
                end: RecordKey(end),
            },
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireEntry {
    key: String,
    record: StoredRecord,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WireCheck {
    key: String,
    expected_revision: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum WireMutation {
    Put { key: String, record: StoredRecord },
    Delete { key: String },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum StoreResponse {
    ProfileMigration {
        status: u16,
        headers: std::collections::BTreeMap<String, String>,
        body: gateway_core::source_json::SourceJson,
    },
    Read {
        record: Option<StoredRecord>,
    },
    Commit {
        committed: bool,
    },
    Query {
        entries: Vec<WireEntry>,
        next_cursor: Option<String>,
    },
}

#[durable_object]
pub struct GatewayAuthority {
    state: State,
}

impl DurableObject for GatewayAuthority {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, mut request: Request) -> worker::Result<Response> {
        if request.path() != "/v1/store" {
            return Response::error("Not found", 404);
        }
        if request.method() != Method::Post {
            return Response::error("Method not allowed", 405);
        }
        if request.headers().get(WIRE_VERSION_HEADER)?.as_deref() != Some(WIRE_VERSION) {
            return error_response(&GatewayError::unavailable(
                "The authority protocol version is unsupported.",
                "authority_wire_version_unsupported",
            ));
        }
        let result = async {
            let bytes = request_bytes(&mut request, WIRE_MAX_BYTES).await?;
            let message: StoreRequest = serde_json::from_slice(&bytes)
                .map_err(|_| unavailable("authority_wire_invalid"))?;
            let store = SqliteAuthorityStore::open(self.state.storage()).await?;
            match message {
                StoreRequest::ProfileMigration {
                    request,
                    request_id,
                    now_ms,
                } => {
                    let result = crate::migration_host::execute_profile(
                        &store,
                        request.into(),
                        gateway_admin_runtime::capabilities::Context { request_id, now_ms },
                    )
                    .await?;
                    if result.stream.is_some() {
                        return Err(unavailable("authority_wire_invalid"));
                    }
                    Ok(StoreResponse::ProfileMigration {
                        status: result.status,
                        headers: result.headers,
                        body: gateway_core::source_json::SourceJson::parse_bytes(
                            &result.body.to_bytes()?,
                        )?,
                    })
                }
                StoreRequest::Read { key } => Ok(StoreResponse::Read {
                    record: store.read(&RecordKey(key)).await?,
                }),
                StoreRequest::Commit { checks, mutations } => {
                    let transition = AtomicTransition {
                        checks: checks
                            .into_iter()
                            .map(|check| RevisionCheck {
                                key: RecordKey(check.key),
                                expected_revision: check.expected_revision,
                            })
                            .collect(),
                        mutations: mutations
                            .into_iter()
                            .map(|mutation| match mutation {
                                WireMutation::Put { key, record } => RecordMutation::Put {
                                    key: RecordKey(key),
                                    record,
                                },
                                WireMutation::Delete { key } => RecordMutation::Delete {
                                    key: RecordKey(key),
                                },
                            })
                            .collect(),
                    };
                    Ok(StoreResponse::Commit {
                        committed: store.commit(transition).await? == CommitOutcome::Committed,
                    })
                }
                StoreRequest::Query {
                    selector,
                    reverse,
                    limit,
                    cursor,
                    now_ms,
                } => {
                    let page = store
                        .query(QueryRequest {
                            selector: selector.into(),
                            reverse,
                            limit,
                            cursor,
                            now_ms,
                        })
                        .await?;
                    Ok(StoreResponse::Query {
                        entries: page
                            .entries
                            .into_iter()
                            .map(|entry| WireEntry {
                                key: entry.key.0,
                                record: entry.record,
                            })
                            .collect(),
                        next_cursor: page.next_cursor,
                    })
                }
            }
        }
        .await;
        match result {
            Ok(message) => {
                let mut response = Response::from_json(&message)?;
                response.headers_mut().set("Cache-Control", "no-store")?;
                response
                    .headers_mut()
                    .set(WIRE_VERSION_HEADER, WIRE_VERSION)?;
                Ok(response)
            }
            Err(error) => error_response(&error),
        }
    }
}

#[derive(Clone)]
pub struct RemoteAuthorityStore {
    stub: Rc<Stub>,
}

impl RemoteAuthorityStore {
    pub fn from_env(env: &Env) -> Result<Self, GatewayError> {
        let namespace = env
            .durable_object("AUTHORITY")
            .map_err(|_| unavailable("authority_binding_unavailable"))?;
        let stub = namespace
            .id_from_name(AUTHORITY_OBJECT)
            .and_then(|id| id.get_stub())
            .map_err(|_| unavailable("authority_binding_unavailable"))?;
        Ok(Self {
            stub: Rc::new(stub),
        })
    }

    pub(crate) async fn profile_migration(
        &self,
        request: gateway_admin_runtime::capabilities::MigrationRequest,
        context: gateway_admin_runtime::capabilities::Context,
    ) -> Result<gateway_auth::AuthResponse, GatewayError> {
        match self
            .exchange(StoreRequest::ProfileMigration {
                request: request.into(),
                request_id: context.request_id,
                now_ms: context.now_ms,
            })
            .await?
        {
            StoreResponse::ProfileMigration {
                status,
                headers,
                body,
            } => {
                let mut response = gateway_auth::AuthResponse::source_json(status, body);
                response.headers = headers;
                Ok(response)
            }
            _ => Err(unavailable("authority_wire_invalid")),
        }
    }

    async fn exchange(&self, message: StoreRequest) -> Result<StoreResponse, GatewayError> {
        let bytes =
            serde_json::to_vec(&message).map_err(|_| unavailable("authority_wire_invalid"))?;
        if bytes.len() > WIRE_MAX_BYTES {
            return Err(unavailable("authority_wire_too_large"));
        }
        let headers = Headers::new();
        headers
            .set("Content-Type", "application/json")
            .map_err(|_| unavailable("authority_wire_invalid"))?;
        headers
            .set(WIRE_VERSION_HEADER, WIRE_VERSION)
            .map_err(|_| unavailable("authority_wire_invalid"))?;
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(Uint8Array::from(bytes.as_slice()).into()));
        let request = Request::new_with_init(WIRE_URL, &init)
            .map_err(|_| unavailable("authority_wire_invalid"))?;
        let mut response = self
            .stub
            .fetch_with_request(request)
            .await
            .map_err(|_| unavailable("authority_storage_unavailable"))?;
        if response.status_code() != 200
            || response
                .headers()
                .get(WIRE_VERSION_HEADER)
                .map_err(|_| unavailable("authority_wire_invalid"))?
                .as_deref()
                != Some(WIRE_VERSION)
        {
            return Err(unavailable("authority_storage_unavailable"));
        }
        let mut stream = response
            .stream()
            .map_err(|_| unavailable("authority_wire_invalid"))?;
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| unavailable("authority_storage_unavailable"))?;
            if bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|size| size > WIRE_MAX_BYTES)
            {
                return Err(unavailable("authority_wire_too_large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| unavailable("authority_wire_invalid"))
    }
}

impl AuthorityStore for RemoteAuthorityStore {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        match self
            .exchange(StoreRequest::Read { key: key.0.clone() })
            .await?
        {
            StoreResponse::Read { record } => {
                if let Some(record) = &record {
                    record.validate_version()?;
                }
                Ok(record)
            }
            _ => Err(unavailable("authority_wire_invalid")),
        }
    }

    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let checks = transition
            .checks
            .into_iter()
            .map(|check| WireCheck {
                key: check.key.0,
                expected_revision: check.expected_revision,
            })
            .collect();
        let mutations = transition
            .mutations
            .into_iter()
            .map(|mutation| match mutation {
                RecordMutation::Put { key, record } => WireMutation::Put { key: key.0, record },
                RecordMutation::Delete { key } => WireMutation::Delete { key: key.0 },
            })
            .collect();
        match self
            .exchange(StoreRequest::Commit { checks, mutations })
            .await?
        {
            StoreResponse::Commit { committed } => Ok(if committed {
                CommitOutcome::Committed
            } else {
                CommitOutcome::Conflict
            }),
            _ => Err(unavailable("authority_wire_invalid")),
        }
    }
}

impl QueryStore for RemoteAuthorityStore {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        let validated = request.validate()?;
        let QueryRequest {
            selector,
            reverse,
            limit,
            cursor,
            now_ms,
        } = request;
        match self
            .exchange(StoreRequest::Query {
                selector: selector.into(),
                reverse,
                limit,
                cursor,
                now_ms,
            })
            .await?
        {
            StoreResponse::Query {
                entries,
                next_cursor,
            } => {
                if entries.len() > limit as usize {
                    return Err(unavailable("authority_wire_invalid"));
                }
                let entries = entries
                    .into_iter()
                    .map(|entry| QueryEntry {
                        key: RecordKey(entry.key),
                        record: entry.record,
                    })
                    .collect::<Vec<_>>();
                let mut previous = None;
                for entry in &entries {
                    if !validated.accepts_record(&entry.key, &entry.record)? {
                        return Err(unavailable("authority_wire_invalid"));
                    }
                    let tuple = gateway_core::tuple_key::TupleKey::from_record_key(&entry.key)?;
                    if previous.as_ref().is_some_and(|old| {
                        if reverse {
                            tuple >= *old
                        } else {
                            tuple <= *old
                        }
                    }) {
                        return Err(unavailable("authority_wire_invalid"));
                    }
                    previous = Some(tuple);
                }
                if let Some(cursor) = &next_cursor {
                    let last = entries
                        .last()
                        .ok_or_else(|| unavailable("authority_wire_invalid"))?;
                    if validated.cursor_after(&last.key)? != *cursor {
                        return Err(unavailable("authority_wire_invalid"));
                    }
                }
                Ok(QueryPage {
                    entries,
                    next_cursor,
                })
            }
            _ => Err(unavailable("authority_wire_invalid")),
        }
    }
}

fn error_response(error: &GatewayError) -> worker::Result<Response> {
    Ok(Response::from_json(&error.envelope)?.with_status(error.status))
}

fn unavailable(code: &str) -> GatewayError {
    GatewayError::unavailable("The shared coordination authority is unavailable.", code)
}
