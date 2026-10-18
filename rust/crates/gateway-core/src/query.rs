//! Source selectors and bounded pages, separate from the atomic write authority.

use std::future::Future;

use serde::{Deserialize, Serialize};

use crate::{
    GatewayError,
    identity::{MAX_SAFE_INTEGER, UnixMillis},
    state::{AuthorityStore, RecordKey, StoredRecord},
    tuple_key::{TupleKey, decode_hex, encode_hex},
};

const CURSOR_PREFIX: &str = "query-v1:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QuerySelector {
    Prefix {
        prefix: RecordKey,
        start: Option<RecordKey>,
        end: Option<RecordKey>,
    },
    /// Source start is inclusive and end exclusive; both are required.
    Range { start: RecordKey, end: RecordKey },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueryRequest {
    pub selector: QuerySelector,
    pub reverse: bool,
    pub limit: u32,
    pub cursor: Option<String>,
    pub now_ms: UnixMillis,
}

#[derive(Clone, Debug, PartialEq)]
pub struct QueryEntry {
    pub key: RecordKey,
    pub record: StoredRecord,
}

#[derive(Clone, Debug, PartialEq)]
pub struct QueryPage {
    pub entries: Vec<QueryEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct CursorSelector {
    prefix: Option<String>,
    start: Option<String>,
    end: Option<String>,
}

impl From<&QuerySelector> for CursorSelector {
    fn from(selector: &QuerySelector) -> Self {
        match selector {
            QuerySelector::Prefix { prefix, start, end } => Self {
                prefix: Some(prefix.0.clone()),
                start: start.as_ref().map(|key| key.0.clone()),
                end: end.as_ref().map(|key| key.0.clone()),
            },
            QuerySelector::Range { start, end } => Self {
                prefix: None,
                start: Some(start.0.clone()),
                end: Some(end.0.clone()),
            },
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    selector: CursorSelector,
    reverse: bool,
    last_key: String,
}

/// Byte bounds are directly usable by a SQL BLOB index; no JSON/text comparator is involved.
#[derive(Clone, Debug)]
pub struct ValidatedQuery {
    pub lower_inclusive: Vec<u8>,
    pub upper_exclusive: Vec<u8>,
    pub reverse: bool,
    pub limit: u32,
    pub now_ms: UnixMillis,
    prefix: Option<TupleKey>,
    resume_after: Option<TupleKey>,
    binding: CursorSelector,
}

impl QueryRequest {
    pub fn validate(&self) -> Result<ValidatedQuery, GatewayError> {
        if self.limit == 0 || !(0..=MAX_SAFE_INTEGER).contains(&self.now_ms) {
            return Err(invalid_query(
                "The query requires a positive page limit and a safe absolute clock.",
            ));
        }
        let (lower_inclusive, upper_exclusive, prefix) = match &self.selector {
            QuerySelector::Prefix { prefix, start, end } => {
                if start.is_some() && end.is_some() {
                    return Err(invalid_query(
                        "A prefix cannot have both start and end bounds.",
                    ));
                }
                let prefix = TupleKey::from_record_key(prefix)?;
                let bound = |key: &RecordKey| -> Result<Vec<u8>, GatewayError> {
                    let key = TupleKey::from_record_key(key)?;
                    if !key.is_strict_descendant_of(&prefix) {
                        return Err(invalid_query(
                            "A prefix bound must be a strict descendant of its prefix.",
                        ));
                    }
                    Ok(key.sort_bytes().to_vec())
                };
                let lower = if let Some(start) = start {
                    bound(start)?
                } else {
                    // Empty bytes are the smallest legal extension, as in native-kv.ts checkedList.
                    let mut lower = prefix.sort_bytes().to_vec();
                    lower.extend_from_slice(&[0x01, 0]);
                    lower
                };
                let upper = if let Some(end) = end {
                    bound(end)?
                } else {
                    let mut upper = prefix.sort_bytes().to_vec();
                    upper.push(0xff);
                    upper
                };
                (lower, upper, Some(prefix))
            }
            QuerySelector::Range { start, end } => {
                let start = TupleKey::from_record_key(start)?;
                let end = TupleKey::from_record_key(end)?;
                if start > end {
                    return Err(invalid_query(
                        "A range start cannot be greater than its end.",
                    ));
                }
                (start.sort_bytes().to_vec(), end.sort_bytes().to_vec(), None)
            }
        };
        let binding = CursorSelector::from(&self.selector);
        let mut validated = ValidatedQuery {
            lower_inclusive,
            upper_exclusive,
            reverse: self.reverse,
            limit: self.limit,
            now_ms: self.now_ms,
            prefix,
            resume_after: None,
            binding,
        };
        if let Some(token) = &self.cursor {
            let encoded = token
                .strip_prefix(CURSOR_PREFIX)
                .ok_or_else(invalid_cursor)?;
            let bytes = decode_hex(encoded).map_err(|()| invalid_cursor())?;
            let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| invalid_cursor())?;
            if cursor.version != 1
                || cursor.reverse != self.reverse
                || cursor.selector != validated.binding
            {
                return Err(invalid_cursor());
            }
            let key = RecordKey(cursor.last_key);
            if !validated.accepts_key(&key)? {
                return Err(invalid_cursor());
            }
            validated.resume_after = Some(TupleKey::from_record_key(&key)?);
        }
        Ok(validated)
    }
}

impl ValidatedQuery {
    /// Seek exclusively after this key (before it for reverse scans); limit may change on resume.
    pub fn resume_key(&self) -> Option<&[u8]> {
        self.resume_after.as_ref().map(TupleKey::sort_bytes)
    }

    pub fn accepts_key(&self, key: &RecordKey) -> Result<bool, GatewayError> {
        let key = TupleKey::from_record_key(key)?;
        key.validate_stored_key()?;
        let bytes = key.sort_bytes();
        if bytes < self.lower_inclusive.as_slice() || bytes >= self.upper_exclusive.as_slice() {
            return Ok(false);
        }
        if self
            .prefix
            .as_ref()
            .is_some_and(|prefix| !key.is_strict_descendant_of(prefix))
        {
            return Ok(false);
        }
        if let Some(previous) = &self.resume_after
            && ((!self.reverse && key <= *previous) || (self.reverse && key >= *previous))
        {
            return Ok(false);
        }
        Ok(true)
    }

    /// Apply expiry before counting returned entries. Reads never refresh expiry or delete rows.
    pub fn accepts_record(
        &self,
        key: &RecordKey,
        record: &StoredRecord,
    ) -> Result<bool, GatewayError> {
        if record
            .expires_at_ms
            .is_some_and(|expiry| expiry <= self.now_ms)
        {
            return Ok(false);
        }
        record.validate_version()?;
        self.accepts_key(key)
    }

    pub fn cursor_after(&self, key: &RecordKey) -> Result<String, GatewayError> {
        if !self.accepts_key(key)? {
            return Err(invalid_cursor());
        }
        let cursor = Cursor {
            version: 1,
            selector: self.binding.clone(),
            reverse: self.reverse,
            last_key: key.0.clone(),
        };
        let bytes = serde_json::to_vec(&cursor).map_err(|_| invalid_cursor())?;
        Ok(format!("{CURSOR_PREFIX}{}", encode_hex(&bytes)))
    }
}

/// Implementations use the same tuple bytes as read/commit and apply absolute expiry before LIMIT.
/// Calls are bounded pages, not implicit complete-prefix scans or cross-page snapshots.
/// Unsupported/corrupt state, invalid/cross-query cursors and unavailability fail closed.
pub trait QueryStore: AuthorityStore {
    fn query(&self, request: QueryRequest)
    -> impl Future<Output = Result<QueryPage, GatewayError>>;
}

fn invalid_query(message: &str) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_query_selector"))
}

fn invalid_cursor() -> GatewayError {
    GatewayError::new(
        400,
        "The query cursor is invalid for this selector and order.",
        Some("invalid_query_cursor"),
    )
}
