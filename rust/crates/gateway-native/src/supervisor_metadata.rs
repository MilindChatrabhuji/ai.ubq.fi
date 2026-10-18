//! Fixed-schema, read-only metadata. No general SQL or request-selected path API.
use crate::supervisor_inventory::{epoch_ms, finite, text};
use rusqlite::{Connection, OpenFlags, params_from_iter, types::ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
const COLUMNS: [&str; 14] = [
    "id",
    "title",
    "name",
    "preview",
    "cwd",
    "model",
    "reasoning_effort",
    "tokens_used",
    "git_branch",
    "updated_at",
    "updated_at_ms",
    "archived",
    "thread_source",
    "source",
];
// rollout_path is intentionally not selected by source metadata. Rollout authority
// comes from the selected thread/read result, never a caller or unrelated row.
const SELECTED: &[&str] = &COLUMNS;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMetadata {
    pub title: Option<String>,
    pub preview: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub tokens_used: Option<Value>,
    pub git_branch: Option<String>,
    pub updated_at_ms: Option<i64>,
    pub archived: Option<bool>,
    pub thread_source: Option<String>,
    pub parent_thread_id: Option<String>,
    pub agent_nickname: Option<String>,
}
#[derive(Clone, Debug)]
pub struct MetadataRead {
    pub database: Option<PathBuf>,
    pub rows: BTreeMap<String, ThreadMetadata>,
    pub reason: Option<String>,
}
impl MetadataRead {
    fn empty(database: Option<PathBuf>, reason: Option<&str>) -> Self {
        Self {
            database,
            rows: BTreeMap::new(),
            reason: reason.map(str::to_owned),
        }
    }
}
pub fn metadata_from_row(row: &Value) -> ThreadMetadata {
    let source = text(row.get("source"))
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.is_object());
    let sub = source
        .as_ref()
        .and_then(|v| v.get("subagent"))
        .filter(|v| v.is_object());
    ThreadMetadata {
        title: text(row.get("name")).or_else(|| text(row.get("title"))),
        preview: text(row.get("preview")),
        cwd: text(row.get("cwd")),
        model: text(row.get("model")),
        effort: text(row.get("reasoning_effort")),
        tokens_used: finite(row.get("tokens_used")),
        git_branch: text(row.get("git_branch")),
        updated_at_ms: epoch_ms(row.get("updated_at_ms"))
            .or_else(|| epoch_ms(row.get("updated_at"))),
        archived: row.get("archived").and_then(Value::as_bool),
        thread_source: text(row.get("thread_source")),
        parent_thread_id: text(source.as_ref().and_then(|v| v.get("parent_thread_id")))
            .or_else(|| text(sub.and_then(|v| v.get("parent_thread_id")))),
        agent_nickname: text(source.as_ref().and_then(|v| v.get("agent_nickname")))
            .or_else(|| text(sub.and_then(|v| v.get("agent_nickname")))),
    }
}
pub fn find_state_database(home: &Path) -> Option<PathBuf> {
    let mut best = None;
    let mut version = 0u64;
    for entry in fs::read_dir(home).ok()?.flatten() {
        if !entry.file_type().ok()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(number) = name
            .strip_prefix("state_")
            .and_then(|s| s.strip_suffix(".sqlite"))
        else {
            continue;
        };
        if number.is_empty() || !number.bytes().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(n) = number.parse::<u64>() else {
            continue;
        };
        if n > 9_007_199_254_740_991 {
            continue;
        }
        if best.is_none() || n > version {
            version = n;
            best = Some(entry.path());
        }
    }
    best
}
fn open_read_only(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(Duration::ZERO)?;
    Ok(db)
}
fn json_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => serde_json::json!(n),
        ValueRef::Real(n) => serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(v) => std::str::from_utf8(v)
            .map(|s| Value::String(s.into()))
            .unwrap_or(Value::Null),
        ValueRef::Blob(_) => Value::Null,
    }
}
pub fn read_metadata(home: &Path, ids: Option<&[String]>) -> MetadataRead {
    if ids.is_some_and(|ids| ids.is_empty()) {
        return MetadataRead::empty(None, None);
    }
    let Some(path) = find_state_database(home) else {
        return MetadataRead::empty(None, Some("state database not found"));
    };
    let Ok(db) = open_read_only(&path) else {
        return MetadataRead::empty(
            Some(path),
            Some("state database could not be opened read-only"),
        );
    };
    let result = (|| -> rusqlite::Result<BTreeMap<String, ThreadMetadata>> {
        let supported = db
            .prepare("PRAGMA table_info(threads)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !SELECTED
            .iter()
            .all(|column| supported.iter().any(|name| name == column))
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let mut rows = BTreeMap::new();
        let columns = SELECTED.join(", ");
        let (sql, parameters) = if let Some(ids) = ids {
            if ids.len() > 68 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            (
                format!(
                    "SELECT {columns} FROM threads WHERE id IN ({})",
                    vec!["?"; ids.len()].join(",")
                ),
                ids.iter()
                    .cloned()
                    .map(rusqlite::types::Value::Text)
                    .collect::<Vec<_>>(),
            )
        } else {
            (
                format!("SELECT {columns} FROM threads ORDER BY updated_at DESC LIMIT ?"),
                vec![rusqlite::types::Value::Integer(60)],
            )
        };
        let mut statement = db.prepare(&sql)?;
        let mut result = statement.query(params_from_iter(parameters))?;
        while let Some(row) = result.next()? {
            let mut value = serde_json::Map::new();
            for (index, name) in SELECTED.iter().enumerate() {
                value.insert((*name).into(), json_value(row.get_ref(index)?));
            }
            let value = Value::Object(value);
            if let Some(id) = text(value.get("id")) {
                rows.insert(id, metadata_from_row(&value));
            }
        }
        Ok(rows)
    })();
    match result {
        Ok(rows) => MetadataRead {
            database: Some(path),
            rows,
            reason: None,
        },
        Err(_) => MetadataRead::empty(Some(path), Some("state database query failed")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_sqlite_open_is_read_only_and_extensions_are_disabled() {
        let path = std::env::temp_dir().join(format!(
            "uos-supervisor-readonly-{}.sqlite",
            std::process::id()
        ));
        let writable = Connection::open(&path).unwrap();
        writable
            .execute_batch("CREATE TABLE proof(value TEXT)")
            .unwrap();
        drop(writable);
        let read = open_read_only(&path).unwrap();
        assert!(read.is_readonly(rusqlite::MAIN_DB).unwrap());
        assert!(
            read.execute("INSERT INTO proof VALUES ('synthetic')", [])
                .is_err()
        );
        assert!(
            read.query_row(
                "SELECT load_extension('synthetic-not-a-library')",
                [],
                |_| Ok(())
            )
            .is_err()
        );
        drop(read);
        fs::remove_file(path).unwrap();
    }
}
