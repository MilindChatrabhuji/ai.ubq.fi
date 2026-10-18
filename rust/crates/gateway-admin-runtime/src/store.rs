use gateway_auth::{AuthHost, crypto::uuid_from_random};
use gateway_core::{
    GatewayError,
    query::{QueryEntry, QueryRequest, QuerySelector, QueryStore},
    state::{AuthorityStore, RecordKey, StoredRecord},
};
use serde_json::Value;
use std::collections::BTreeSet;

pub fn key(parts: Value) -> RecordKey {
    gateway_auth::store::key(parts)
}
pub fn revision<H: AuthHost>(host: &H) -> Result<String, GatewayError> {
    uuid_from_random(&host.random_bytes(16)?)
}
pub fn corrupt(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "admin_state_corrupt")
}

pub fn value(row: Option<&StoredRecord>, now: i64) -> Result<Option<Value>, GatewayError> {
    let Some(row) = row else { return Ok(None) };
    row.validate_version()?;
    if row.expires_at_ms.is_some_and(|at| at <= now) {
        return Ok(None);
    }
    Ok(Some(row.json_value()?.clone()))
}
pub async fn read<S: AuthorityStore>(
    store: &S,
    key: &RecordKey,
    now: i64,
) -> Result<Option<Value>, GatewayError> {
    value(store.read(key).await?.as_ref(), now)
}
/// Every page is bounded and bound to the core tuple selector; repeated cursors fail closed.
pub async fn scan<S: QueryStore>(
    store: &S,
    prefix: RecordKey,
    reverse: bool,
    now: i64,
) -> Result<Vec<QueryEntry>, GatewayError> {
    let mut rows = Vec::new();
    visit(store, prefix, reverse, now, |entry| {
        rows.push(entry);
        Ok(())
    })
    .await?;
    Ok(rows)
}

/// Consumers such as error history retain aggregates and the display limit, not every stored row.
pub async fn visit<S: QueryStore, F: FnMut(QueryEntry) -> Result<(), GatewayError>>(
    store: &S,
    prefix: RecordKey,
    reverse: bool,
    now: i64,
    mut visitor: F,
) -> Result<(), GatewayError> {
    let mut cursor = None;
    let mut seen = BTreeSet::new();
    loop {
        let request = QueryRequest {
            selector: QuerySelector::Prefix {
                prefix: prefix.clone(),
                start: None,
                end: None,
            },
            reverse,
            limit: 200,
            cursor: cursor.clone(),
            now_ms: now,
        };
        let validated = request.validate()?;
        let page = store.query(request).await?;
        if page.entries.len() > validated.limit as usize {
            return Err(corrupt("Admin query exceeded its bounded page limit"));
        }
        for entry in page.entries {
            if !validated.accepts_record(&entry.key, &entry.record)? {
                return Err(corrupt("Admin query returned a row outside its selector"));
            }
            visitor(entry)?;
        }
        match page.next_cursor {
            Some(next) if seen.insert(next.clone()) => cursor = Some(next),
            Some(_) => return Err(corrupt("Admin query repeated a continuation")),
            None => return Ok(()),
        }
    }
}
