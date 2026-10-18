use crate::{
    store::*,
    types::{ExtrasHost, ExtrasResponse},
};
use gateway_core::{
    GatewayError,
    query::QueryStore,
    state::{RecordKey, RecordMutation, StoredRecord},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
const DAY: i64 = 86_400_000;
const TTL: i64 = 7 * DAY;
const RESPONSE_TTL: i64 = 8 * DAY;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum State {
    Reserved,
    Dispatched,
    Succeeded,
    Indeterminate,
}
#[derive(Clone, Deserialize, Serialize)]
struct Ledger {
    v: u8,
    fingerprint: String,
    state: State,
    owner_request_id: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    lease_until_ms: Option<i64>,
    response_status: Option<u16>,
    response_content_type: Option<String>,
    response_generation: Option<String>,
    response_chunk_count: Option<usize>,
    response_sha256: Option<String>,
}
#[derive(Clone)]
pub(crate) struct Lease {
    key: RecordKey,
    response_prefix: Value,
    fingerprint: String,
    owner: String,
}
pub(crate) enum Acquired {
    Lease(Lease),
    Response(ExtrasResponse),
}
fn refusal(status: u16, message: &str, code: &str) -> ExtrasResponse {
    ExtrasResponse::error(
        GatewayError::new(status, message, Some(code))
            .with_type(if status == 503 {
                "server_error"
            } else {
                "idempotency_error"
            })
            .with_param(None),
    )
}
pub(crate) fn unavailable() -> ExtrasResponse {
    refusal(
        503,
        "Idempotent embeddings requests require durable KV storage.",
        "embedding_idempotency_unavailable",
    )
}
pub(crate) fn indeterminate() -> ExtrasResponse {
    refusal(
        409,
        "The embeddings request outcome is indeterminate and will not be dispatched again.",
        "embedding_idempotency_indeterminate",
    )
}
fn parse(row: Option<&StoredRecord>, at: i64) -> Result<Option<Ledger>, GatewayError> {
    let value: Option<Value> = decoded(row, at)?;
    let Some(v) = value else { return Ok(None) };
    for name in [
        "v",
        "fingerprint",
        "state",
        "owner_request_id",
        "created_at_ms",
        "updated_at_ms",
        "lease_until_ms",
        "response_status",
        "response_content_type",
        "response_generation",
        "response_chunk_count",
        "response_sha256",
    ] {
        if v.get(name).is_none() {
            return Ok(None);
        }
    }
    let Ok(record) = serde_json::from_value::<Ledger>(v) else {
        return Ok(None);
    };
    if record.v != 1
        || record
            .response_chunk_count
            .is_some_and(|n| n == 0 || n > 256)
    {
        return Ok(None);
    }
    Ok(Some(record))
}
fn chunk_key(lease: &Lease, generation: &str, index: usize) -> RecordKey {
    let mut p = lease
        .response_prefix
        .as_array()
        .expect("source prefix")
        .clone();
    p.push(json!(generation));
    p.push(json!(index));
    key(json!(p))
}
fn retired(mut r: Ledger, at: i64) -> Ledger {
    r.state = State::Indeterminate;
    r.owner_request_id = None;
    r.updated_at_ms = at;
    r.lease_until_ms = None;
    r.response_status = None;
    r.response_content_type = None;
    r.response_generation = None;
    r.response_chunk_count = None;
    r.response_sha256 = None;
    r
}
pub(crate) async fn acquire<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    principal: &str,
    id: &str,
    fingerprint: String,
    owner: String,
) -> Acquired {
    let principal_hash = hash(&format!("uos-embeddings-principal-v1:{principal}"));
    let key_hash = hash(&format!("uos-embeddings-key-v1:{id}"));
    let lease = Lease {
        key: key(json!([
            "embeddings",
            "idempotency",
            "v1",
            principal_hash,
            key_hash
        ])),
        response_prefix: json!([
            "embeddings",
            "idempotency",
            "v1",
            "response",
            principal_hash,
            key_hash
        ]),
        fingerprint,
        owner,
    };
    match acquire_inner(store, host, lease).await {
        Ok(value) => value,
        Err(_) => Acquired::Response(unavailable()),
    }
}
async fn acquire_inner<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    lease: Lease,
) -> Result<Acquired, GatewayError> {
    for _ in 0..8 {
        let at = now(host)?;
        let row = store.read(&lease.key).await?;
        let existing = parse(row.as_ref(), at)?;
        if row
            .as_ref()
            .is_some_and(|r| r.expires_at_ms.is_none_or(|e| e > at))
            && existing.is_none()
        {
            return Ok(Acquired::Response(indeterminate()));
        }
        let next = if let Some(mut r) = existing {
            if r.fingerprint != lease.fingerprint {
                return Ok(Acquired::Response(refusal(
                    409,
                    "Idempotency-Key was already used with a different embeddings request.",
                    "embedding_idempotency_conflict",
                )));
            }
            if r.state == State::Succeeded {
                if let Some(replay) = replay(store, host, &lease, &r).await? {
                    return Ok(Acquired::Response(replay));
                }
                let r = retired(r, at);
                if commit(
                    store,
                    vec![check(&lease.key, row.as_ref())],
                    vec![put(host, lease.key.clone(), &r, Some(at + TTL))?],
                )
                .await?
                {
                    return Ok(Acquired::Response(indeterminate()));
                }
                continue;
            }
            if r.state == State::Indeterminate {
                return Ok(Acquired::Response(indeterminate()));
            }
            if r.lease_until_ms.is_some_and(|e| e > at) {
                let mut r = refusal(
                    409,
                    "The embeddings request for this Idempotency-Key is still in progress.",
                    "embedding_idempotency_in_progress",
                );
                r.headers.insert("Retry-After".into(), "1".into());
                return Ok(Acquired::Response(r));
            }
            if r.state == State::Dispatched {
                let r = retired(r, at);
                if commit(
                    store,
                    vec![check(&lease.key, row.as_ref())],
                    vec![put(host, lease.key.clone(), &r, Some(at + TTL))?],
                )
                .await?
                {
                    return Ok(Acquired::Response(indeterminate()));
                }
                continue;
            }
            r.owner_request_id = Some(lease.owner.clone());
            r.updated_at_ms = at;
            r.lease_until_ms = Some(at + 60_000);
            r
        } else {
            Ledger {
                v: 1,
                fingerprint: lease.fingerprint.clone(),
                state: State::Reserved,
                owner_request_id: Some(lease.owner.clone()),
                created_at_ms: at,
                updated_at_ms: at,
                lease_until_ms: Some(at + 60_000),
                response_status: None,
                response_content_type: None,
                response_generation: None,
                response_chunk_count: None,
                response_sha256: None,
            }
        };
        if commit(
            store,
            vec![check(&lease.key, row.as_ref())],
            vec![put(host, lease.key.clone(), &next, Some(at + TTL))?],
        )
        .await?
        {
            return Ok(Acquired::Lease(lease));
        }
    }
    Ok(Acquired::Response(unavailable()))
}
async fn replay<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    lease: &Lease,
    r: &Ledger,
) -> Result<Option<ExtrasResponse>, GatewayError> {
    let (Some(200), Some(content_type), Some(generation), Some(count), Some(digest)) = (
        r.response_status,
        r.response_content_type.as_deref(),
        r.response_generation.as_deref(),
        r.response_chunk_count,
        r.response_sha256.as_deref(),
    ) else {
        return Ok(None);
    };
    if content_type.is_empty() || generation.is_empty() || digest.is_empty() {
        return Ok(None);
    }
    let mut body = String::new();
    for index in 0..count {
        let row = store.read(&chunk_key(lease, generation, index)).await?;
        let value: Option<Value> = decoded(row.as_ref(), now(host)?)?;
        let Some(value) = value.and_then(|v| v.as_str().map(str::to_owned)) else {
            return Ok(None);
        };
        body.push_str(&value);
    }
    if hash(&body) != digest {
        return Ok(None);
    }
    let Ok(value) = serde_json::from_str(&body) else {
        return Ok(None);
    };
    let mut response = ExtrasResponse::json(200, value);
    response
        .headers
        .insert("content-type".into(), content_type.into());
    response
        .headers
        .insert("x-uos-idempotency-replayed".into(), "true".into());
    Ok(Some(response))
}
pub(crate) async fn mark_dispatched<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    lease: &Lease,
) -> bool {
    let action = async {
        for _ in 0..4 {
            let at = now(host)?;
            let row = store.read(&lease.key).await?;
            let Some(mut r) = parse(row.as_ref(), at)? else {
                return Ok(false);
            };
            if r.fingerprint != lease.fingerprint
                || r.state != State::Reserved
                || r.owner_request_id.as_deref() != Some(lease.owner.as_str())
            {
                return Ok(false);
            }
            r.state = State::Dispatched;
            r.updated_at_ms = at;
            r.lease_until_ms = Some(at + 60_000);
            if commit(
                store,
                vec![check(&lease.key, row.as_ref())],
                vec![put(host, lease.key.clone(), &r, Some(at + TTL))?],
            )
            .await?
            {
                return Ok(true);
            }
        }
        Ok::<_, GatewayError>(false)
    };
    action.await.unwrap_or(false)
}
pub(crate) async fn release<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    lease: &Lease,
    allow_dispatched: bool,
) -> bool {
    let action = async {
        for _ in 0..4 {
            let row = store.read(&lease.key).await?;
            let Some(r) = parse(row.as_ref(), now(host)?)? else {
                return Ok(false);
            };
            if r.fingerprint != lease.fingerprint
                || r.owner_request_id.as_deref() != Some(lease.owner.as_str())
                || (r.state != State::Reserved
                    && !(allow_dispatched && r.state == State::Dispatched))
            {
                return Ok(false);
            }
            if commit(
                store,
                vec![check(&lease.key, row.as_ref())],
                vec![RecordMutation::Delete {
                    key: lease.key.clone(),
                }],
            )
            .await?
            {
                return Ok(true);
            }
        }
        Ok::<_, GatewayError>(false)
    };
    action.await.unwrap_or(false)
}
pub(crate) async fn mark_indeterminate<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    lease: &Lease,
) {
    let action = async {
        for _ in 0..4 {
            let at = now(host)?;
            let row = store.read(&lease.key).await?;
            let Some(r) = parse(row.as_ref(), at)? else {
                return Ok(());
            };
            if r.fingerprint != lease.fingerprint
                || matches!(r.state, State::Succeeded | State::Indeterminate)
            {
                return Ok(());
            }
            if commit(
                store,
                vec![check(&lease.key, row.as_ref())],
                vec![put(
                    host,
                    lease.key.clone(),
                    &retired(r, at),
                    Some(at + TTL),
                )?],
            )
            .await?
            {
                return Ok(());
            }
        }
        Ok::<_, GatewayError>(())
    };
    let _ = action.await;
}
pub(crate) async fn success<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    lease: &Lease,
    response: &ExtrasResponse,
) -> bool {
    let action = async {
        let body = serde_json::to_string(&response.body).map_err(|_| invalid_state())?;
        // Successful Voyage responses contain only fixed ASCII fields, numeric vectors or base64.
        let chunks: Vec<String> = body
            .as_bytes()
            .chunks(48_000)
            .map(|b| String::from_utf8(b.to_vec()).map_err(|_| invalid_state()))
            .collect::<Result<_, _>>()?;
        if chunks.is_empty() || chunks.len() > 256 {
            return Ok(false);
        }
        for (index, chunk) in chunks.iter().enumerate() {
            let at = now(host)?;
            if !commit(
                store,
                vec![],
                vec![put(
                    host,
                    chunk_key(lease, &lease.owner, index),
                    chunk,
                    Some(at + RESPONSE_TTL),
                )?],
            )
            .await?
            {
                return Ok(false);
            }
        }
        for _ in 0..4 {
            let at = now(host)?;
            let row = store.read(&lease.key).await?;
            let Some(mut r) = parse(row.as_ref(), at)? else {
                return Ok(false);
            };
            if r.fingerprint != lease.fingerprint
                || !matches!(r.state, State::Reserved | State::Dispatched)
                || r.owner_request_id.as_deref() != Some(lease.owner.as_str())
            {
                return Ok(false);
            }
            r.state = State::Succeeded;
            r.owner_request_id = None;
            r.updated_at_ms = at;
            r.lease_until_ms = None;
            r.response_status = Some(response.status);
            r.response_content_type = Some("application/json".into());
            r.response_generation = Some(lease.owner.clone());
            r.response_chunk_count = Some(chunks.len());
            r.response_sha256 = Some(hash(&body));
            if commit(
                store,
                vec![check(&lease.key, row.as_ref())],
                vec![put(host, lease.key.clone(), &r, Some(at + TTL))?],
            )
            .await?
            {
                return Ok(true);
            }
        }
        Ok::<_, GatewayError>(false)
    };
    action.await.unwrap_or(false)
}
