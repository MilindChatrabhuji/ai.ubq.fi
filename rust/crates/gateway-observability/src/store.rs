use crate::types::ObservabilityHost;
use gateway_auth::crypto::uuid_from_random;
use gateway_core::{
    GatewayError,
    query::{QueryEntry, QueryRequest, QuerySelector, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
        StoredRecord,
    },
    tuple_key::{DecodedKeyPart, TupleKey},
};
use serde_json::Value;
/// Source utils.isRecord deliberately includes arrays in the JSON domain.
pub(crate) fn is_record(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

pub(crate) const DAY: i64 = 86_400_000;
pub(crate) fn error(message: impl Into<String>) -> GatewayError {
    GatewayError::unavailable(message, "observability_state_invalid")
}
pub(crate) fn missing(name: &str) -> GatewayError {
    GatewayError::unavailable(
        format!("Required {name} capability is not configured"),
        "admin_capability_unavailable",
    )
}
pub(crate) fn invalid(message: impl Into<String>) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_request_error"))
}
pub(crate) fn key(parts: Value) -> RecordKey {
    TupleKey::from_json_parts(parts.as_array().expect("source tuple array"))
        .expect("source scalar tuple")
        .to_record_key()
}
pub(crate) fn parts(key: &RecordKey) -> Result<Vec<Value>, GatewayError> {
    TupleKey::from_record_key(key)?
        .decoded_parts()?
        .into_iter()
        .map(|p| match p {
            DecodedKeyPart::String(v) => String::from_utf8(v)
                .map(Value::String)
                .map_err(|_| error("Invalid source key text")),
            DecodedKeyPart::Number(v) => serde_json::Number::from_f64(v)
                .map(Value::Number)
                .ok_or_else(|| error("Invalid source key number")),
            DecodedKeyPart::Boolean(v) => Ok(Value::Bool(v)),
            _ => Err(error("Unexpected source key kind")),
        })
        .collect()
}
pub(crate) fn check(key: &RecordKey, row: Option<&StoredRecord>) -> RevisionCheck {
    RevisionCheck {
        key: key.clone(),
        expected_revision: row.map(|r| r.revision.clone()),
    }
}
pub(crate) fn value(row: Option<&StoredRecord>, now: i64) -> Result<Option<&Value>, GatewayError> {
    row.filter(|r| !r.expires_at_ms.is_some_and(|x| x <= now))
        .map(StoredRecord::json_value)
        .transpose()
}
pub(crate) fn now<H: ObservabilityHost>(host: &H) -> Result<i64, GatewayError> {
    let now = host.now_ms();
    if (0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&now) {
        Ok(now)
    } else {
        Err(error("Invalid observation clock"))
    }
}
pub(crate) fn uuid<H: ObservabilityHost>(host: &H) -> Result<String, GatewayError> {
    uuid_from_random(&host.random_bytes(16)?)
}
pub(crate) fn put<H: ObservabilityHost>(
    host: &H,
    key: RecordKey,
    value: Value,
    expires_at_ms: Option<i64>,
) -> Result<RecordMutation, GatewayError> {
    Ok(RecordMutation::Put {
        key,
        record: StoredRecord::json(uuid(host)?, value, expires_at_ms),
    })
}
pub(crate) async fn commit<S: AuthorityStore>(
    store: &S,
    checks: Vec<RevisionCheck>,
    mutations: Vec<RecordMutation>,
) -> Result<bool, GatewayError> {
    // Bun KV applies the last mutation for a key. The portable adapter accepts
    // unconditional writes; retain only the source's explicit check conjunction.
    let mut explicit = std::collections::BTreeMap::<String, RevisionCheck>::new();
    for check in checks {
        if let Some(previous) = explicit.get(&check.key.0)
            && previous.expected_revision != check.expected_revision
        {
            return Ok(false);
        }
        explicit.insert(check.key.0.clone(), check);
    }
    let mut final_writes = std::collections::BTreeMap::<String, RecordMutation>::new();
    for mutation in mutations {
        let key = match &mutation {
            RecordMutation::Put { key, .. } | RecordMutation::Delete { key } => key,
        };
        final_writes.insert(key.0.clone(), mutation);
    }
    // Errors can mean an unknown committed outcome. Never replay the mutation.
    Ok(store
        .commit(AtomicTransition {
            checks: explicit.into_values().collect(),
            mutations: final_writes.into_values().collect(),
        })
        .await?
        == CommitOutcome::Committed)
}
pub(crate) async fn scan<S: QueryStore>(
    store: &S,
    prefix: RecordKey,
    reverse: bool,
    at: i64,
    limit: usize,
) -> Result<Vec<QueryEntry>, GatewayError> {
    scan_selector(
        store,
        QuerySelector::Prefix {
            prefix,
            start: None,
            end: None,
        },
        reverse,
        at,
        limit,
    )
    .await
}
pub(crate) async fn scan_selector<S: QueryStore>(
    store: &S,
    selector: QuerySelector,
    reverse: bool,
    at: i64,
    limit: usize,
) -> Result<Vec<QueryEntry>, GatewayError> {
    let mut cursor = None;
    let mut rows = Vec::new();
    loop {
        let request = QueryRequest {
            selector: selector.clone(),
            reverse,
            limit: (limit.saturating_sub(rows.len())).clamp(1, 256) as u32,
            cursor: cursor.clone(),
            now_ms: at,
        };
        let page = store.query(request).await?;
        if page.next_cursor.is_some() && page.next_cursor == cursor {
            return Err(error("Observation scan cursor did not advance"));
        }
        rows.extend(page.entries);
        if rows.len() >= limit {
            rows.truncate(limit);
            break;
        }
        let Some(next) = page.next_cursor else { break };
        cursor = Some(next);
    }
    Ok(rows)
}
pub(crate) fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|' '|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(js_whitespace)
}
pub(crate) fn safe_i64(v: &Value) -> Option<i64> {
    v.as_f64()
        .filter(|n| {
            n.is_finite() && n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(n)
        })
        .map(|n| n as i64)
}
