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

#[derive(Default)]
struct FrameBoundary {
    openings: Vec<u8>,
    started: bool,
    quoted: bool,
    escaped: bool,
    complete: bool,
}
impl FrameBoundary {
    fn terminates(&self, byte: u8) -> bool {
        self.complete && byte == b'\n'
    }
    fn accept(&mut self, byte: u8) -> Result<bool, GatewayError> {
        if self.complete {
            return if matches!(byte, b' ' | b'\t' | b'\r' | b'\n') {
                Ok(byte == b'\n')
            } else {
                Err(error("Fixture message has data after its root object"))
            };
        }
        if !self.started {
            if matches!(byte, b' ' | b'\t' | b'\r') {
                return Ok(false);
            }
            if byte != b'{' {
                return Err(error("Fixture message must contain one root JSON object"));
            }
            self.started = true;
            self.openings.push(byte);
            return Ok(false);
        }
        if self.quoted {
            if self.escaped {
                self.escaped = false;
            } else if byte == b'\\' {
                self.escaped = true;
            } else if byte == b'"' {
                self.quoted = false;
            }
        } else {
            match byte {
                b'"' => self.quoted = true,
                b'{' | b'[' => self.openings.push(byte),
                b'}' | b']' => {
                    let expected = if byte == b'}' { b'{' } else { b'[' };
                    if self.openings.pop() != Some(expected) {
                        return Err(error("Fixture JSON delimiters differ"));
                    }
                    self.complete = self.openings.is_empty();
                }
                _ => {}
            }
        }
        Ok(false)
    }
}
pub fn read<T: serde::de::DeserializeOwned>() -> Result<T, GatewayError> {
    read_frame(&mut std::io::stdin().lock())
}
fn read_frame<T: serde::de::DeserializeOwned, R: BufRead>(
    input: &mut R,
) -> Result<T, GatewayError> {
    let mut bytes = Vec::new();
    let mut boundary = FrameBoundary::default();
    loop {
        let available = input.fill_buf().map_err(error)?;
        if available.is_empty() {
            return Err(error("Fixture controller closed its port"));
        }
        let mut count = 0;
        let mut complete = false;
        for &byte in available {
            // Count the WHOLE original frame, reserving its required separator,
            // before allocating retained payload or lexical nesting state.
            if bytes.len() >= MAX_BYTES - 1 && !boundary.terminates(byte) {
                return Err(error(
                    "Fixture controller message exceeded the private wire bound",
                ));
            }
            complete = boundary.accept(byte)?;
            bytes.push(byte);
            count += 1;
            if complete {
                break;
            }
        }
        input.consume(count);
        if complete {
            return serde_json::from_slice(&bytes).map_err(error);
        }
    }
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

#[cfg(test)]
mod frame_tests {
    use super::*;
    use gateway_core::source_json::SourceJson;
    use std::io::{BufReader, Cursor};
    fn raw(bytes: &[u8], capacity: usize) -> Result<SourceJson, GatewayError> {
        read_frame(&mut BufReader::with_capacity(capacity, Cursor::new(bytes)))
    }
    #[test]
    fn actual_multiline_native_capture_retains_all_original_source_bytes() {
        let capture = include_str!("../../fixtures/native-source.json");
        let document = format!("{{\"operation\":\"candidate\",\"capture\":{capture}}}");
        let framed = format!("{document}\n");
        for capacity in [1, 7, framed.len()] {
            let value = raw(framed.as_bytes(), capacity).unwrap();
            assert!(
                value.as_str() == document,
                "Raw SourceJson must not be normalized"
            );
            #[derive(Deserialize)]
            struct Envelope {
                operation: String,
                capture: gateway_migration::NativeCapture,
            }
            let parsed: Envelope = value.deserialize().unwrap();
            assert_eq!(parsed.operation, "candidate");
            assert_eq!(parsed.capture.v, 2);
        }
    }
    #[test]
    fn strings_numbers_utf8_nested_and_two_coalesced_frames_keep_the_original_bytes() {
        let document = r#" {"numbers":[1e3,-0,9007199254740993],
"strings":["\ud800","\" \\ {} []","escaped\nnot-a-frame"],"α":{"array":[{},[]]}} "#;
        let wire = format!("{document}\n{{\"second\":true}}\n");
        let mut cursor = BufReader::with_capacity(1, Cursor::new(wire.as_bytes()));
        let first: SourceJson = read_frame(&mut cursor).unwrap();
        // SourceJson's existing typed decoder excludes only outer whitespace.
        assert!(
            first.as_str() == document.trim(),
            "Original native string/number source tokens changed"
        );
        let second: SourceJson = read_frame(&mut cursor).unwrap();
        assert_eq!(second.as_str(), "{\"second\":true}");
    }
    #[test]
    fn malformed_partial_mismatched_trailing_and_non_utf8_messages_refuse() {
        for bytes in [
            b"{".as_slice(),
            b"{}",
            b"{\"x\":\"unfinished",
            b"{\"x\":[}]}\n",
            b"{}{}\n",
            b"{}x\n",
            b"\n",
            b"[]\n",
            b"{\"x\":}\n",
            b"{\"x\":\"\\q\"}\n",
            b"{\"s\":\"\xff\"}\n",
        ] {
            assert!(
                raw(bytes, 1).is_err(),
                "Malformed private frame must refuse"
            );
        }
    }
    #[test]
    fn whole_frame_cap_counts_structural_newlines_before_retained_allocation() {
        let mut bytes = vec![b' '; MAX_BYTES + 1];
        bytes[0] = b'{';
        for at in (1024..bytes.len()).step_by(1024) {
            bytes[at] = b'\n';
        }
        let Err(error) = raw(&bytes, 4096) else {
            panic!("Oversized cumulative native frame accepted")
        };
        assert!(
            error
                .envelope
                .error
                .message
                .contains("exceeded the private wire bound")
        );
        let mut exact = vec![b' '; MAX_BYTES];
        exact[MAX_BYTES - 3] = b'{';
        exact[MAX_BYTES - 2] = b'}';
        exact[MAX_BYTES - 1] = b'\n';
        assert_eq!(raw(&exact, 4096).unwrap().as_str(), "{}");
    }
    #[test]
    fn fixed_typed_store_response_ids_and_closed_schema_still_apply_after_multiline_framing() {
        let incoming:Incoming=read_frame(&mut Cursor::new(b"{\n\"operation\":\"store_response\",\n\"id\":7,\"response\":{\"operation\":\"read\",\"record\":null}}\n")).unwrap();
        assert_eq!(incoming.operation, "store_response");
        assert_eq!(incoming.id, 7);
        assert!(matches!(incoming.response, Response::Read { record: None }));
        for bytes in [b"{\"operation\":\"store_response\",\"id\":7,\"response\":{\"operation\":\"sql\"}}\n".as_slice(),b"{\"operation\":\"store_response\",\"id\":7,\"id\":7,\"response\":{\"operation\":\"read\",\"record\":null}}\n"]{
            assert!(read_frame::<Incoming,_>(&mut Cursor::new(bytes)).is_err());
        }
    }
}
