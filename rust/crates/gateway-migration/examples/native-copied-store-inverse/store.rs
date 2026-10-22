//! Read-only adapter for the actual gateway-worker SQLite schema.
use gateway_core::{
    GatewayError,
    identity::MAX_SAFE_INTEGER,
    query::{QueryEntry, QueryPage, QueryRequest, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, PORTABLE_STATE_VERSION, RecordKey,
        StoredRecord,
    },
    tuple_key::TupleKey,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, types::Value};
use std::path::Path;

const COLUMNS: &str =
    "record_key, sort_key, schema_version, value_encoding, revision, payload, expires_at_ms";
const MAX_ROW_BYTES: usize = 2_000_000;
const PAGE_BYTES: usize = 8 * 1024 * 1024;

pub struct ReadonlyStore {
    connection: Connection,
    now_ms: i64,
}

impl ReadonlyStore {
    pub fn open(path: &Path, now_ms: i64) -> Result<Self, GatewayError> {
        if !(0..=MAX_SAFE_INTEGER).contains(&now_ms) {
            return Err(refused());
        }
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| refused())?;
        let table_count: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('uos_authority_metadata', 'uos_authority_records')",
                [],
                |row| row.get(0),
            )
            .map_err(|_| refused())?;
        let versions: Vec<(u32, String, String)> = connection
            .prepare("SELECT schema_version, key_codec, value_codec FROM uos_authority_metadata WHERE singleton = 1")
            .map_err(|_| refused())?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|_| refused())?
            .collect::<Result<_, _>>()
            .map_err(|_| refused())?;
        if table_count != 2
            || versions
                != [(
                    PORTABLE_STATE_VERSION,
                    "tuple-v1".into(),
                    "explicit-value-v1".into(),
                )]
        {
            return Err(refused());
        }
        connection
            .prepare(&format!(
                "SELECT {COLUMNS} FROM uos_authority_records LIMIT 0"
            ))
            .map_err(|_| refused())?;
        Ok(Self { connection, now_ms })
    }
}

impl AuthorityStore for ReadonlyStore {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        validate_key(key)?;
        let entry = self
            .connection
            .query_row(
                &format!("SELECT {COLUMNS} FROM uos_authority_records WHERE record_key = ?"),
                [&key.0],
                sql_row,
            )
            .optional()
            .map_err(|_| refused())?
            .map(decode)
            .transpose()?;
        let Some((entry, _)) = entry else {
            return Ok(None);
        };
        if entry.key != *key {
            return Err(refused());
        }
        Ok((!entry.record.expires_at_ms.is_some_and(|t| t <= self.now_ms)).then_some(entry.record))
    }

    async fn commit(&self, _: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        Err(refused())
    }
}

impl QueryStore for ReadonlyStore {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        let query = request.validate()?;
        if query.now_ms != self.now_ms {
            return Err(refused());
        }
        let mut values = vec![
            Value::Blob(query.lower_inclusive.clone()),
            Value::Blob(query.upper_exclusive.clone()),
            Value::Integer(query.now_ms),
        ];
        let seek = if let Some(resume) = query.resume_key() {
            values.push(Value::Blob(resume.to_vec()));
            if query.reverse {
                " AND sort_key < ?"
            } else {
                " AND sort_key > ?"
            }
        } else {
            ""
        };
        values.push(Value::Integer(i64::from(query.limit) + 1));
        let order = if query.reverse { "DESC" } else { "ASC" };
        let sql = format!(
            "SELECT {COLUMNS} FROM uos_authority_records WHERE sort_key >= ? AND sort_key < ? AND (expires_at_ms IS NULL OR expires_at_ms > ?){seek} ORDER BY sort_key {order} LIMIT ?"
        );
        let mut statement = self.connection.prepare(&sql).map_err(|_| refused())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), sql_row)
            .map_err(|_| refused())?;
        let mut entries = Vec::new();
        let mut bytes = 0_usize;
        let mut more = false;
        for row in rows {
            let (entry, size) = decode(row.map_err(|_| refused())?)?;
            if !query.accepts_record(&entry.key, &entry.record)? {
                return Err(refused());
            }
            if entries.len() >= query.limit as usize
                || (!entries.is_empty() && bytes.saturating_add(size) > PAGE_BYTES)
            {
                more = true;
                break;
            }
            bytes = bytes.saturating_add(size);
            entries.push(entry);
        }
        let next_cursor = if more {
            Some(query.cursor_after(&entries.last().ok_or_else(refused)?.key)?)
        } else {
            None
        };
        Ok(QueryPage {
            entries,
            next_cursor,
        })
    }
}

struct Row {
    key: String,
    sort: Vec<u8>,
    version: u32,
    encoding: String,
    revision: String,
    payload: String,
    expiry: Option<i64>,
}

fn sql_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        key: row.get(0)?,
        sort: row.get(1)?,
        version: row.get(2)?,
        encoding: row.get(3)?,
        revision: row.get(4)?,
        payload: row.get(5)?,
        expiry: row.get(6)?,
    })
}

fn validate_key(key: &RecordKey) -> Result<(), GatewayError> {
    TupleKey::from_record_key(key)?.validate_stored_key()?;
    if key.0.len() > MAX_ROW_BYTES {
        return Err(refused());
    }
    Ok(())
}

fn decode(row: Row) -> Result<(QueryEntry, usize), GatewayError> {
    let key = RecordKey(row.key);
    validate_key(&key)?;
    if TupleKey::from_record_key(&key)?.sort_bytes() != row.sort
        || row.revision.is_empty()
        || row.revision.len() > 4096
        || row
            .expiry
            .is_some_and(|t| !(0..=MAX_SAFE_INTEGER).contains(&t))
    {
        return Err(refused());
    }
    let size = key
        .0
        .len()
        .saturating_add(row.revision.len())
        .saturating_add(row.payload.len())
        .saturating_add(row.encoding.len())
        .saturating_add(128);
    let record = StoredRecord {
        schema_version: row.version,
        value_encoding: serde_json::from_value(serde_json::Value::String(row.encoding))
            .map_err(|_| refused())?,
        revision: row.revision,
        value: serde_json::from_str(&row.payload).map_err(|_| refused())?,
        expires_at_ms: row.expiry,
    };
    record.validate_version()?;
    Ok((QueryEntry { key, record }, size))
}

fn refused() -> GatewayError {
    GatewayError::unavailable(
        "Private copied authority storage refused",
        "copied_authority_storage_refused",
    )
}
