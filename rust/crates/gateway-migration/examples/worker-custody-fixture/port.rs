//! Fixture-only synchronous port to the existing private authority wire.
//! The controller forwards requests to the actual common DO, never a local mirror.
use gateway_core::{GatewayError, query::*, state::*};
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    io::{BufRead, Write},
};

const MAX_BYTES: usize = gateway_migration::operational::PRIVATE_WIRE_MAX_BYTES;

pub fn error(message: impl std::fmt::Display) -> GatewayError {
    GatewayError::unavailable(message.to_string(), "migration_fixture_port_invalid")
}

pub fn read<T: serde::de::DeserializeOwned>() -> Result<T, GatewayError> {
    let mut bytes = Vec::new();
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    loop {
        let available = input.fill_buf().map_err(error)?;
        if available.is_empty() {
            return Err(error("Fixture controller closed its port"));
        }
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |n| n + 1);
        if bytes.len().checked_add(count).is_none_or(|n| n > MAX_BYTES) {
            return Err(error(
                "Fixture controller message exceeded the private wire bound",
            ));
        }
        bytes.extend_from_slice(&available[..count]);
        input.consume(count);
        if bytes.last() == Some(&b'\n') {
            break;
        }
    }
    serde_json::from_slice(&bytes).map_err(error)
}

pub fn write(value: &impl Serialize) -> Result<(), GatewayError> {
    let mut bytes = serde_json::to_vec(value).map_err(error)?;
    if bytes.len() >= MAX_BYTES {
        return Err(error("Fixture response exceeded the private wire bound"));
    }
    bytes.push(b'\n');
    let mut output = std::io::stdout().lock();
    output.write_all(&bytes).map_err(error)?;
    output.flush().map_err(error)
}

#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum Request {
    Read {
        key: String,
    },
    Commit {
        checks: Vec<Check>,
        mutations: Vec<Mutation>,
    },
    Query {
        selector: Selector,
        reverse: bool,
        limit: u32,
        cursor: Option<String>,
        now_ms: i64,
    },
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Selector {
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
#[derive(Serialize)]
struct Check {
    key: String,
    expected_revision: Option<String>,
}
#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum Mutation {
    Put { key: String, record: StoredRecord },
    Delete { key: String },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    key: String,
    record: StoredRecord,
}
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Response {
    Read {
        record: Option<StoredRecord>,
    },
    Commit {
        committed: bool,
    },
    Query {
        entries: Vec<Entry>,
        next_cursor: Option<String>,
    },
}
#[derive(Serialize)]
struct Outgoing {
    operation: &'static str,
    id: u64,
    request: Request,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Incoming {
    operation: String,
    id: u64,
    response: Response,
}

#[derive(Default)]
pub struct Store {
    next_id: Cell<u64>,
}
impl Store {
    fn exchange(&self, request: Request) -> Result<Response, GatewayError> {
        let id = self
            .next_id
            .get()
            .checked_add(1)
            .ok_or_else(|| error("Fixture port identity overflow"))?;
        self.next_id.set(id);
        write(&Outgoing {
            operation: "store_request",
            id,
            request,
        })?;
        let incoming: Incoming = read()?;
        if incoming.operation != "store_response" || incoming.id != id {
            return Err(error("Fixture authority response identity differs"));
        }
        Ok(incoming.response)
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        match self.exchange(Request::Read { key: key.0.clone() })? {
            Response::Read { record } => {
                if let Some(record) = &record {
                    record.validate_version()?;
                }
                Ok(record)
            }
            _ => Err(error("Fixture read response differs")),
        }
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let checks = transition
            .checks
            .into_iter()
            .map(|c| Check {
                key: c.key.0,
                expected_revision: c.expected_revision,
            })
            .collect();
        let mutations = transition
            .mutations
            .into_iter()
            .map(|m| match m {
                RecordMutation::Put { key, record } => Mutation::Put { key: key.0, record },
                RecordMutation::Delete { key } => Mutation::Delete { key: key.0 },
            })
            .collect();
        match self.exchange(Request::Commit { checks, mutations })? {
            Response::Commit { committed } => Ok(if committed {
                CommitOutcome::Committed
            } else {
                CommitOutcome::Conflict
            }),
            _ => Err(error("Fixture commit response differs")),
        }
    }
}
impl QueryStore for Store {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        let validated = request.validate()?;
        let selector = match request.selector {
            QuerySelector::Prefix { prefix, start, end } => Selector::Prefix {
                prefix: prefix.0,
                start: start.map(|k| k.0),
                end: end.map(|k| k.0),
            },
            QuerySelector::Range { start, end } => Selector::Range {
                start: start.0,
                end: end.0,
            },
        };
        let response = self.exchange(Request::Query {
            selector,
            reverse: request.reverse,
            limit: request.limit,
            cursor: request.cursor,
            now_ms: request.now_ms,
        })?;
        let Response::Query {
            entries,
            next_cursor,
        } = response
        else {
            return Err(error("Fixture query response differs"));
        };
        if entries.len() > request.limit as usize {
            return Err(error("Fixture query exceeded its page bound"));
        }
        let mut result: Vec<QueryEntry> = Vec::new();
        for entry in entries {
            let key = RecordKey(entry.key);
            if !validated.accepts_record(&key, &entry.record)? {
                return Err(error("Fixture query returned an unrelated row"));
            }
            result.push(QueryEntry {
                key,
                record: entry.record,
            });
        }
        if let Some(cursor) = &next_cursor {
            let last = result
                .last()
                .ok_or_else(|| error("Fixture query has an empty continuation"))?;
            if validated.cursor_after(&last.key)? != *cursor {
                return Err(error("Fixture query continuation differs"));
            }
        }
        Ok(QueryPage {
            entries: result,
            next_cursor,
        })
    }
}
