//! Private bounded applier: ordered sealed frames to one actual Store RPC port.
//! It is not a public route, fixture acceptance, activation or target owner grant.
#![cfg(all(unix, not(target_arch = "wasm32")))]
use gateway_core::{GatewayError, query::*, state::*};
use gateway_migration::staged::{
    STAGED_BATCH_MAX_BYTES, StageReceipt, StageRequest, decode_stage_request, execute_staged,
};
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::MetadataExt,
    path::Path,
};

fn failure(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "m20_stage_apply_invalid")
}
#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum OutMutation {
    Put { key: String, record: StoredRecord },
    Delete { key: String },
}
#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum OutRequest {
    Read {
        key: String,
    },
    Commit {
        checks: Vec<OutCheck>,
        mutations: Vec<OutMutation>,
    },
    Query {
        selector: OutSelector,
        reverse: bool,
        limit: u32,
        cursor: Option<String>,
        now_ms: i64,
    },
}
#[derive(Serialize)]
struct OutCheck {
    key: String,
    expected_revision: Option<String>,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum OutSelector {
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InEntry {
    key: String,
    record: StoredRecord,
}
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum InResponse {
    Read {
        record: Option<StoredRecord>,
    },
    Commit {
        committed: bool,
    },
    Query {
        entries: Vec<InEntry>,
        next_cursor: Option<String>,
    },
}
#[derive(Serialize)]
struct Outgoing {
    operation: &'static str,
    id: u64,
    request: OutRequest,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Incoming {
    operation: String,
    id: u64,
    response: InResponse,
}
#[derive(Default)]
struct Store {
    next_id: Cell<u64>,
}
impl Store {
    fn exchange(&self, request: OutRequest) -> Result<InResponse, GatewayError> {
        let id = self
            .next_id
            .get()
            .checked_add(1)
            .ok_or_else(|| failure("Private store request identity overflows"))?;
        self.next_id.set(id);
        let outgoing = serde_json::to_vec(&Outgoing {
            operation: "store_request",
            id,
            request,
        })
        .map_err(|_| failure("Private store request cannot be encoded"))?;
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(&outgoing)
            .and_then(|()| stdout.write_all(b"\n"))
            .and_then(|()| stdout.flush())
            .map_err(|_| failure("Private store port closed"))?;
        drop(stdout);
        let mut line = Vec::new();
        std::io::stdin()
            .lock()
            .take(STAGED_BATCH_MAX_BYTES as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| failure("Private store port cannot be read"))?;
        if line.last() != Some(&b'\n') {
            return Err(failure("Private store response is incomplete"));
        }
        let incoming: Incoming = serde_json::from_slice(&line)
            .map_err(|_| failure("Private store response is invalid"))?;
        if incoming.operation != "store_response" || incoming.id != id {
            return Err(failure("Private store response identity differs"));
        }
        Ok(incoming.response)
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        match self.exchange(OutRequest::Read { key: key.0.clone() })? {
            InResponse::Read { record } => {
                if let Some(record) = &record {
                    record.validate_version()?;
                }
                Ok(record)
            }
            _ => Err(failure("Private store read response differs")),
        }
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let checks = transition
            .checks
            .into_iter()
            .map(|check| OutCheck {
                key: check.key.0,
                expected_revision: check.expected_revision,
            })
            .collect();
        let mutations = transition
            .mutations
            .into_iter()
            .map(|mutation| match mutation {
                RecordMutation::Put { key, record } => OutMutation::Put { key: key.0, record },
                RecordMutation::Delete { key } => OutMutation::Delete { key: key.0 },
            })
            .collect();
        match self.exchange(OutRequest::Commit { checks, mutations })? {
            InResponse::Commit { committed } => Ok(if committed {
                CommitOutcome::Committed
            } else {
                CommitOutcome::Conflict
            }),
            _ => Err(failure("Private store commit response differs")),
        }
    }
}
impl QueryStore for Store {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        let validated = request.validate()?;
        let selector = match &request.selector {
            QuerySelector::Prefix { prefix, start, end } => OutSelector::Prefix {
                prefix: prefix.0.clone(),
                start: start.as_ref().map(|key| key.0.clone()),
                end: end.as_ref().map(|key| key.0.clone()),
            },
            QuerySelector::Range { start, end } => OutSelector::Range {
                start: start.0.clone(),
                end: end.0.clone(),
            },
        };
        let response = self.exchange(OutRequest::Query {
            selector,
            reverse: request.reverse,
            limit: request.limit,
            cursor: request.cursor.clone(),
            now_ms: request.now_ms,
        })?;
        let InResponse::Query {
            entries,
            next_cursor,
        } = response
        else {
            return Err(failure("Private store query response differs"));
        };
        if entries.len() > request.limit as usize {
            return Err(failure("Private store query exceeded its page bound"));
        }
        let mut result = Vec::new();
        for entry in entries {
            let key = RecordKey(entry.key);
            if !validated.accepts_record(&key, &entry.record)? {
                return Err(failure("Private store query returned an unrelated row"));
            }
            result.push(QueryEntry {
                key,
                record: entry.record,
            });
        }
        if let Some(cursor) = &next_cursor {
            let last = result
                .last()
                .ok_or_else(|| failure("Private store query has an empty continuation"))?;
            if validated.cursor_after(&last.key)? != *cursor {
                return Err(failure("Private store query continuation differs"));
            }
        }
        Ok(QueryPage {
            entries: result,
            next_cursor,
        })
    }
}
fn run<F: std::future::Future>(future: F) -> F::Output {
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let std::task::Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}
fn private_frames(path: &Path) -> Result<BufReader<File>, GatewayError> {
    let before =
        std::fs::symlink_metadata(path).map_err(|_| failure("Private frames are unavailable"))?;
    if !path.is_absolute() || !before.is_file() || before.mode() & 0o077 != 0 {
        return Err(failure(
            "Private frames must be an absolute owner-only regular file",
        ));
    }
    let file = File::open(path).map_err(|_| failure("Private frames cannot be opened"))?;
    let after = file
        .metadata()
        .map_err(|_| failure("Private frames cannot be verified"))?;
    if before.dev() != after.dev() || before.ino() != after.ino() || before.len() != after.len() {
        return Err(failure("Private frames changed before reading"));
    }
    Ok(BufReader::new(file))
}
#[derive(Serialize)]
struct StageLine<'a> {
    operation: &'static str,
    stage: &'static str,
    receipt: &'a StageReceipt,
}
fn stage(request: &StageRequest) -> &'static str {
    match request {
        StageRequest::Begin(_) => "begin",
        StageRequest::Append(_) => "append",
        StageRequest::Seal { .. } => "seal",
        StageRequest::BindOwner(_) => "bind_owner",
    }
}
fn main() -> Result<(), GatewayError> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 2 {
        return Err(failure("Usage: native-stage-apply <private-frames>"));
    }
    let store = Store::default();
    let mut frames = private_frames(Path::new(&args[1]))?;
    let mut line = Vec::new();
    let mut sequence = 0usize;
    let mut appends = 0usize;
    let mut sealed = false;
    let mut owner_bound = false;
    let mut maximum = 0usize;
    loop {
        line.clear();
        let read = frames
            .read_until(b'\n', &mut line)
            .map_err(|_| failure("Private frames cannot be read"))?;
        if read == 0 {
            break;
        }
        if line.last() != Some(&b'\n') || line.len() > STAGED_BATCH_MAX_BYTES + 1 {
            return Err(failure("Private frame line is incomplete or oversized"));
        }
        line.pop();
        maximum = maximum.max(line.len());
        let request = decode_stage_request(&line)?;
        let name = stage(&request);
        let expected = match (sequence, name) {
            (0, "begin") => true,
            (_, "append") => !sealed && sequence > 0,
            (_, "seal") => !sealed && sequence > 0,
            (_, "bind_owner") => sealed && !owner_bound && appends > 0,
            _ => false,
        };
        if !expected {
            return Err(failure("Private frame order is invalid"));
        }
        let receipt = run(execute_staged(&store, request))?;
        if receipt.activation_authorized {
            return Err(failure("Private stage claimed activation authority"));
        }
        match name {
            "append" => appends += 1,
            "seal" => sealed = receipt.sealed,
            "bind_owner" => owner_bound = receipt.owner_bound,
            _ => {}
        }
        let output = serde_json::to_vec(&StageLine {
            operation: "stage_receipt",
            stage: name,
            receipt: &receipt,
        })
        .map_err(|_| failure("Private stage receipt cannot be encoded"))?;
        let mut stdout = std::io::stdout().lock();
        stdout
            .write_all(&output)
            .and_then(|()| stdout.write_all(b"\n"))
            .and_then(|()| stdout.flush())
            .map_err(|_| failure("Private stage receipt port closed"))?;
        sequence += 1;
    }
    if !sealed || sequence < 2 {
        return Err(failure("Private stage frames did not seal one target"));
    }
    let output = serde_json::to_vec(&serde_json::json!({
        "operation":"stage_applied",
        "v":1,
        "frames":sequence,
        "append_frames":appends,
        "max_stage_frame_bytes":maximum,
        "sealed":sealed,
        "owner_bound":owner_bound,
        "activation_authorized":false
    }))
    .map_err(|_| failure("Private stage summary cannot be encoded"))?;
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(&output)
        .and_then(|()| stdout.write_all(b"\n"))
        .and_then(|()| stdout.flush())
        .map_err(|_| failure("Private stage summary port closed"))?;
    Ok(())
}
