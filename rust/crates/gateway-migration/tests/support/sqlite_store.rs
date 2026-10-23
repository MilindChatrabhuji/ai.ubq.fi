use gateway_core::{GatewayError, query::*, state::*, tuple_key::TupleKey};
use rusqlite::{Connection, OptionalExtension};
use std::{cell::RefCell, path::Path, rc::Rc};
fn err(e: impl std::fmt::Display) -> GatewayError {
    GatewayError::unavailable(e.to_string(), "fixture_sqlite_error")
}
#[derive(Clone)]
pub struct SqliteStore {
    connection: Rc<RefCell<Connection>>,
    pub before_commit: Rc<RefCell<Option<(RecordKey, StoredRecord)>>>,
}
impl SqliteStore {
    pub fn open(path: &Path) -> Self {
        let connection = Connection::open(path).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (sort_key BLOB PRIMARY KEY NOT NULL, key TEXT UNIQUE NOT NULL, record TEXT NOT NULL);").unwrap();
        Self {
            connection: Rc::new(RefCell::new(connection)),
            before_commit: Rc::new(RefCell::new(None)),
        }
    }
    pub fn put(&self, key: RecordKey, record: StoredRecord) {
        let sort = TupleKey::from_record_key(&key)
            .unwrap()
            .sort_bytes()
            .to_vec();
        self.connection
            .borrow()
            .execute(
                "INSERT OR REPLACE INTO records(sort_key,key,record) VALUES(?1,?2,?3)",
                rusqlite::params![sort, key.0, serde_json::to_string(&record).unwrap()],
            )
            .unwrap();
    }
}
impl AuthorityStore for SqliteStore {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        let value: Option<String> = self
            .connection
            .borrow()
            .query_row("SELECT record FROM records WHERE key=?1", [&key.0], |r| {
                r.get(0)
            })
            .optional()
            .map_err(err)?;
        value
            .map(|v| serde_json::from_str(&v).map_err(err))
            .transpose()
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let injected = self.before_commit.borrow_mut().take();
        if let Some((key, record)) = injected {
            self.put(key, record);
        }
        let mut connection = self.connection.borrow_mut();
        let transaction = connection.transaction().map_err(err)?;
        for check in transition.checks {
            let value: Option<String> = transaction
                .query_row(
                    "SELECT record FROM records WHERE key=?1",
                    [&check.key.0],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?;
            let value: Option<StoredRecord> = value
                .map(|v| serde_json::from_str(&v).map_err(err))
                .transpose()?;
            if value.map(|r| r.revision) != check.expected_revision {
                return Ok(CommitOutcome::Conflict);
            }
        }
        for mutation in transition.mutations {
            match mutation {
                RecordMutation::Put { key, record } => {
                    record.validate_version()?;
                    let sort = TupleKey::from_record_key(&key)?.sort_bytes().to_vec();
                    transaction
                        .execute(
                            "INSERT OR REPLACE INTO records(sort_key,key,record) VALUES(?1,?2,?3)",
                            rusqlite::params![
                                sort,
                                key.0,
                                serde_json::to_string(&record).map_err(err)?
                            ],
                        )
                        .map_err(err)?;
                }
                RecordMutation::Delete { key } => {
                    transaction
                        .execute("DELETE FROM records WHERE key=?1", [key.0])
                        .map_err(err)?;
                }
            }
        }
        transaction.commit().map_err(err)?;
        Ok(CommitOutcome::Committed)
    }
}
impl QueryStore for SqliteStore {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        let validated = request.validate()?;
        let connection = self.connection.borrow();
        let sql = if request.reverse {
            "SELECT key,record FROM records ORDER BY sort_key DESC"
        } else {
            "SELECT key,record FROM records ORDER BY sort_key ASC"
        };
        let mut statement = connection.prepare(sql).map_err(err)?;
        let values = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?;
        let mut entries = Vec::new();
        let mut more = false;
        for value in values {
            let (key, record) = value.map_err(err)?;
            let key = RecordKey(key);
            let record: StoredRecord = serde_json::from_str(&record).map_err(err)?;
            if validated.accepts_record(&key, &record)? {
                if entries.len() == request.limit as usize {
                    more = true;
                    break;
                }
                entries.push(QueryEntry { key, record });
            }
        }
        let next_cursor = if more {
            entries
                .last()
                .map(|e| validated.cursor_after(&e.key))
                .transpose()?
        } else {
            None
        };
        Ok(QueryPage {
            entries,
            next_cursor,
        })
    }
}
