use crate::{store::*, types::ExtrasHost};
use chrono::{DateTime, SecondsFormat, Utc};
use gateway_core::js_string::JsString16;
use gateway_core::{
    GatewayError,
    query::{QueryRequest, QuerySelector, QueryStore},
    state::{RecordKey, RecordMutation},
    tuple_key::{DecodedKeyPart, TupleKey},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub const RPM: u64 = 3;
pub const TPM: u64 = 10_000;
pub const TIMEOUT_MS: i64 = 20_000;
pub fn cache_key(profile: &str, hash: &str) -> RecordKey {
    key(json!(["embeddings", "v2", "cache", profile, hash]))
}
fn pointer_key(profile: &str, hash: &str) -> RecordKey {
    key(json!([
        "embeddings",
        "v2",
        "cache_index_by_hash",
        profile,
        hash
    ]))
}
fn profile_index(profile: &str, at: f64, hash: &str) -> RecordKey {
    key(json!([
        "embeddings",
        "v2",
        "cache_index",
        profile,
        at,
        hash
    ]))
}
fn global_index(at: f64, profile: &str, hash: &str) -> RecordKey {
    key(json!([
        "embeddings",
        "v2",
        "cache_index_global",
        at,
        profile,
        hash
    ]))
}
pub(crate) fn vector(value: &Value, dimensions: u64) -> Option<Vec<f64>> {
    let a = value.as_array()?;
    if a.len() != dimensions as usize {
        return None;
    }
    a.iter()
        .map(|v| v.as_f64().filter(|x| x.is_finite()))
        .collect()
}
pub(crate) async fn cached<S: QueryStore>(
    store: &S,
    profile: &str,
    hash: &str,
    dimensions: u64,
    at: i64,
) -> Result<Option<Vec<f64>>, GatewayError> {
    let row = store.read(&cache_key(profile, hash)).await?;
    let value: Option<Value> = decoded(row.as_ref(), at)?;
    Ok(value
        .as_ref()
        .and_then(|v| vector(&v["embedding"], dimensions)))
}
fn iso(at: f64) -> Result<String, GatewayError> {
    Ok(DateTime::<Utc>::from_timestamp_millis(at as i64)
        .ok_or_else(invalid_state)?
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn timestamp(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(f64::trunc)
}
async fn write_entry<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    profile: &str,
    hash: &str,
    embedding: &[f64],
    created: i64,
) -> Result<(), GatewayError> {
    let pointer = pointer_key(profile, hash);
    for _ in 0..5 {
        let row = store.read(&pointer).await?;
        let value: Option<Value> = decoded(row.as_ref(), now(host)?)?;
        let existing = value.as_ref().and_then(timestamp);
        let at = existing.unwrap_or(created as f64);
        let mut writes = vec![
            put(
                host,
                cache_key(profile, hash),
                &json!({"embedding":embedding,"created_at":iso(at)?}),
                None,
            )?,
            put(host, profile_index(profile, at, hash), &1, None)?,
            put(host, global_index(at, profile, hash), &1, None)?,
        ];
        if existing.is_none() {
            writes.push(put(host, pointer.clone(), &at, None)?);
        }
        if commit(store, vec![check(&pointer, row.as_ref())], writes).await? {
            return Ok(());
        }
    }
    Ok(())
}
fn candidate(key: &RecordKey) -> Result<Option<(f64, String, String)>, GatewayError> {
    let p = TupleKey::from_record_key(key)?.decoded_parts()?;
    if p.len() < 3 {
        return Ok(None);
    }
    let [
        DecodedKeyPart::Number(at),
        DecodedKeyPart::String(profile),
        DecodedKeyPart::String(hash),
    ] = &p[p.len() - 3..]
    else {
        return Ok(None);
    };
    if !at.is_finite() {
        return Ok(None);
    }
    let (Ok(profile), Ok(hash)) = (
        String::from_utf8(profile.clone()),
        String::from_utf8(hash.clone()),
    ) else {
        return Ok(None);
    };
    if profile.is_empty() || hash.is_empty() {
        return Ok(None);
    }
    Ok(Some((at.trunc(), profile, hash)))
}
async fn evict<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    count: u32,
) -> Result<usize, GatewayError> {
    let page = store
        .query(QueryRequest {
            selector: QuerySelector::Prefix {
                prefix: key(json!(["embeddings", "v2", "cache_index_global"])),
                start: None,
                end: None,
            },
            reverse: false,
            limit: count,
            cursor: None,
            now_ms: now(host)?,
        })
        .await?;
    let mut removed = 0;
    for entry in page.entries {
        let Some((at, profile, hash)) = candidate(&entry.key)? else {
            continue;
        };
        let pointer = pointer_key(&profile, &hash);
        let ptr = store.read(&pointer).await?;
        let value: Option<Value> = decoded(ptr.as_ref(), now(host)?)?;
        let ptr_at = value.as_ref().and_then(timestamp);
        let mut writes = vec![
            RecordMutation::Delete { key: entry.key },
            RecordMutation::Delete {
                key: profile_index(&profile, at, &hash),
            },
        ];
        let remove_value = if let Some(point) = ptr_at {
            point == at
        } else {
            let row = store.read(&cache_key(&profile, &hash)).await?;
            let value: Option<Value> = decoded(row.as_ref(), now(host)?)?;
            value
                .as_ref()
                .and_then(|v| v["created_at"].as_str())
                .is_some_and(|v| iso(at).ok().as_deref() == Some(v))
        };
        if remove_value {
            writes.push(RecordMutation::Delete {
                key: cache_key(&profile, &hash),
            });
            if ptr_at == Some(at) {
                writes.push(RecordMutation::Delete {
                    key: pointer.clone(),
                });
            }
        }
        if commit(store, vec![check(&pointer, ptr.as_ref())], writes).await? {
            removed += 1;
        }
    }
    Ok(removed)
}
pub(crate) async fn cache_best_effort<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    profile: &str,
    hash: &str,
    embedding: &[f64],
    deadline: i64,
) {
    let created = host.now_ms();
    let mut batch = 512;
    for _ in 0..=4 {
        if host.now_ms() >= deadline {
            return;
        }
        match write_entry(store, host, profile, hash, embedding, created).await {
            Ok(()) => return,
            Err(e) => {
                let text = format!("{} {}", e.envelope.error.code.as_deref().unwrap_or(""), e)
                    .to_lowercase();
                let quota = text.contains("quota")
                    || text.contains("no space")
                    || text.contains("storage limit")
                    || (text.contains("storage")
                        && (text.contains("insufficient") || text.contains("exceeded")))
                    || (text.contains("space") && text.contains("insufficient"));
                if !quota {
                    return;
                }
                match evict(store, host, batch).await {
                    Ok(n) if n > 0 => {}
                    _ => return,
                }
                batch = (batch * 2).min(8192);
            }
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Budget {
    window_start_ms: f64,
    requests: f64,
    tokens: f64,
}
pub(crate) fn estimate(text: &JsString16) -> u64 {
    (crate::store::source_utf8(text).len() as u64).div_ceil(4)
}
pub(crate) fn chunks(items: &[(String, JsString16)]) -> Vec<Vec<(String, JsString16)>> {
    let mut out = Vec::new();
    let mut chunk = Vec::new();
    let mut tokens = 0;
    for item in items {
        let n = estimate(&item.1);
        if chunk.len() >= 128 || (!chunk.is_empty() && tokens + n > TPM) {
            out.push(std::mem::take(&mut chunk));
            tokens = 0;
        }
        chunk.push(item.clone());
        tokens += n;
    }
    if !chunk.is_empty() {
        out.push(chunk)
    }
    out
}
pub(crate) async fn reserve_once<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    tokens: u64,
) -> Result<Option<u64>, GatewayError> {
    let at = now(host)?;
    let k = key(json!(["embeddings", "v1", "rate", "voyage"]));
    let row = store.read(&k).await?;
    let value: Option<Value> = decoded(row.as_ref(), at)?;
    let current = value.and_then(|v| {
        let at = timestamp(&v["window_start_ms"])?;
        let requests = timestamp(&v["requests"])?;
        let tokens = timestamp(&v["tokens"])?;
        Some(Budget {
            window_start_ms: at,
            requests,
            tokens,
        })
    });
    let mut state = current
        .filter(|s| at as f64 - s.window_start_ms < 60_000.0)
        .unwrap_or(Budget {
            window_start_ms: at as f64,
            requests: 0.0,
            tokens: 0.0,
        });
    if state.requests + 1.0 > RPM as f64 || state.tokens + tokens as f64 > TPM as f64 {
        return Ok(Some(
            (60_000.0 - (at as f64 - state.window_start_ms)).max(0.0) as u64,
        ));
    }
    state.requests += 1.0;
    state.tokens += tokens as f64;
    if commit(
        store,
        vec![check(&k, row.as_ref())],
        vec![put(host, k, &state, None)?],
    )
    .await?
    {
        Ok(None)
    } else {
        Ok(Some(0))
    }
}
pub(crate) async fn reserve<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    tokens: u64,
    deadline: Option<i64>,
) -> Result<Option<u64>, GatewayError> {
    loop {
        let at = now(host)?;
        if deadline.is_some_and(|d| at >= d) {
            return Ok(Some(0));
        }
        let mut result = Some(0);
        for attempt in 0..6 {
            result = reserve_once(store, host, tokens).await?;
            if result != Some(0) {
                break;
            }
            host.sleep_ms(5 + attempt * 5).await?;
        }
        if result.is_none() {
            return Ok(None);
        }
        let wait = result.unwrap_or(0);
        let Some(deadline) = deadline else {
            return Ok(Some(if wait > 0 { wait } else { 1000 }));
        };
        if wait > 0 {
            if at.saturating_add(i64::try_from(wait).unwrap_or(i64::MAX)) > deadline {
                return Ok(Some(wait));
            }
            host.sleep_ms(wait).await?;
        } else {
            let pause = (deadline - now(host)?).clamp(0, 25) as u64;
            if pause > 0 {
                host.sleep_ms(pause).await?;
            }
        }
    }
}
