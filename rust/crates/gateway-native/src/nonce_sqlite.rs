//! Native replay metadata only. The fixed marker and key prevent this adapter
//! from adopting a gateway KV, credential database or arbitrary record writer.
use gateway_auth::{GatewayError, native_replay::native_nonce_key};
use gateway_core::state::{
    AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use std::{fs, io::Read, os::unix::fs::OpenOptionsExt, path::Path, sync::Mutex, time::Duration};

const APPLICATION_ID: i64 = 0x554f534e;
pub struct SqliteNonceStore {
    connection: Mutex<Connection>,
}
impl SqliteNonceStore {
    pub fn open(path: &Path) -> Result<Self, GatewayError> {
        if !path.is_absolute() {
            return Err(unavailable());
        }
        let created = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(file) => {
                drop(file);
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(_) => return Err(unavailable()),
        };
        if fs::symlink_metadata(path)
            .map_err(|_| unavailable())?
            .file_type()
            .is_symlink()
        {
            return Err(unavailable());
        }
        if !created {
            let mut header = [0u8; 100];
            fs::File::open(path)
                .and_then(|mut file| file.read_exact(&mut header))
                .map_err(|_| unavailable())?;
            if &header[..16] != b"SQLite format 3\0"
                || u32::from_be_bytes(header[68..72].try_into().map_err(|_| unavailable())?)
                    != APPLICATION_ID as u32
                || u32::from_be_bytes(header[60..64].try_into().map_err(|_| unavailable())?) != 1
            {
                return Err(unavailable());
            }
        }
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|_| unavailable())?;
        connection
            .busy_timeout(Duration::from_secs(1))
            .map_err(|_| unavailable())?;
        if created {
            connection.execute_batch("PRAGMA application_id=1431262030; PRAGMA user_version=1; CREATE TABLE native_nonce_state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);").map_err(|_|unavailable())?;
        }
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;",
            )
            .map_err(|_| unavailable())?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
}
fn read(connection: &Connection) -> Result<Option<StoredRecord>, GatewayError> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT body FROM native_nonce_state WHERE id=1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| unavailable())?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|_| unavailable()))
        .transpose()
}
impl AuthorityStore for SqliteNonceStore {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        if key != &native_nonce_key() {
            return Err(unavailable());
        }
        let connection = self.connection.lock().map_err(|_| unavailable())?;
        read(&connection)
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let key = native_nonce_key();
        if transition.checks.len() != 1
            || transition.checks[0].key != key
            || transition.mutations.len() != 1
        {
            return Err(unavailable());
        }
        let RecordMutation::Put {
            key: mutation_key,
            record,
        } = &transition.mutations[0]
        else {
            return Err(unavailable());
        };
        if mutation_key != &key || record.expires_at_ms.is_some() {
            return Err(unavailable());
        }
        record.json_value()?;
        let mut connection = self.connection.lock().map_err(|_| unavailable())?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        if read(&transaction)?.as_ref().map(|row| &row.revision)
            != transition.checks[0].expected_revision.as_ref()
        {
            return Ok(CommitOutcome::Conflict);
        }
        let encoded = serde_json::to_string(record).map_err(|_| unavailable())?;
        transaction.execute("INSERT INTO native_nonce_state(id,body)VALUES(1,?1)ON CONFLICT(id)DO UPDATE SET body=excluded.body",[encoded]).map_err(|_|unavailable())?;
        transaction.commit().map_err(|_| unavailable())?;
        Ok(CommitOutcome::Committed)
    }
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Native replay database is unavailable or has the wrong marker",
        "native_nonce_store_unavailable",
    )
}
