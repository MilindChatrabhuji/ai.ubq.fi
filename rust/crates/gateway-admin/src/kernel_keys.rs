//! Source kernel public-key administration; these are verification keys, never private credentials.
use crate::source_input as input;
use gateway_auth::{AuthHost, AuthResponse, conflict, crypto::uuid_from_random, invalid, store};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    state::{AuthorityStore, RecordKey, RecordMutation, StoredRecord},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct KernelPublicKey {
    pub app_id: f64,
    pub pem: JsString16,
    pub owner: JsString16,
    pub added_at_ms: i64,
}

pub fn key() -> RecordKey {
    gateway_auth::upstream::kernel_public_keys_key()
}

/// The one existing kernel public-key family, decoded as a complete named DTO.
pub fn decode_records(row: &StoredRecord) -> Result<Vec<KernelPublicKey>, GatewayError> {
    decode_source_control_record(row)?
        .deserialize()
        .map_err(|_| {
            GatewayError::unavailable("Kernel public key state is corrupt", "auth_state_corrupt")
        })
}
pub fn records_mutation(
    records: &[KernelPublicKey],
    expiry: Option<i64>,
    revision: &str,
) -> Result<RecordMutation, GatewayError> {
    Ok(RecordMutation::Put {
        key: key(),
        record: encode_source_control_record(
            revision,
            &SourceJson::from_serializable(records)?,
            expiry,
        )?,
    })
}
fn current_records(
    row: Option<&StoredRecord>,
    now: i64,
) -> Result<Vec<KernelPublicKey>, GatewayError> {
    let Some(row) = row else {
        return Ok(Vec::new());
    };
    row.validate_version()?;
    if row.expires_at_ms.is_some_and(|expiry| expiry <= now) {
        return Ok(Vec::new());
    }
    decode_records(row)
}

pub async fn list<S: AuthorityStore>(store: &S, now: i64) -> Result<AuthResponse, GatewayError> {
    let rows = current_records(store.read(&key()).await?.as_ref(), now)?;
    Ok(AuthResponse::source_json(
        200,
        input::object(vec![("data", input::json(&rows))]),
    ))
}

pub async fn create<S: AuthorityStore, H: AuthHost>(
    store: &S,
    host: &H,
    body: &SourceJson,
) -> Result<AuthResponse, GatewayError> {
    let app_id = input::member(body, "app_id")
        .as_ref()
        .and_then(input::number)
        .filter(|id| id.is_finite())
        .ok_or_else(|| invalid("app_id is required and must be a number"))?;
    let pem = input::member(body, "pem")
        .as_ref()
        .and_then(input::text)
        .map(|value| input::trim(&value))
        .filter(|value| {
            value.as_units().starts_with(
                &"-----BEGIN PUBLIC KEY-----"
                    .encode_utf16()
                    .collect::<Vec<_>>(),
            ) && value.as_units().ends_with(
                &"-----END PUBLIC KEY-----"
                    .encode_utf16()
                    .collect::<Vec<_>>(),
            )
        })
        .ok_or_else(|| invalid("pem must be a valid RS256 public PEM"))?;
    let owner = input::member(body, "owner")
        .as_ref()
        .and_then(input::text)
        .unwrap_or_else(|| JsString16::from_utf8("unknown"));
    let k = key();
    let row = store.read(&k).await?;
    let mut rows = current_records(row.as_ref(), host.now_ms())?;
    if rows.iter().any(|row| row.app_id == app_id) {
        return Err(conflict(&format!(
            "Public key for App ID {app_id} already exists"
        )));
    }
    let record = KernelPublicKey {
        app_id,
        pem,
        owner,
        added_at_ms: host.now_ms(),
    };
    rows.push(record.clone());
    let revision = uuid_from_random(&host.random_bytes(16)?)?;
    if !store::commit(
        store,
        vec![store::check(&k, row.as_ref())],
        vec![records_mutation(&rows, None, &revision)?],
    )
    .await?
    {
        return Err(conflict("Concurrent modification; retry"));
    }
    Ok(AuthResponse::source_json(
        200,
        input::object(vec![
            ("ok", input::json(&true)),
            ("data", input::json(&record)),
        ]),
    ))
}

fn parse_source_integer(value: &str) -> Option<f64> {
    let text = value.trim_start();
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        if (index == 0 && matches!(ch, '+' | '-')) || ch.is_ascii_digit() {
            end = index + ch.len_utf8();
        } else {
            break;
        }
    }
    if end == 0 {
        return None;
    }
    text[..end]
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

pub async fn delete<S: AuthorityStore, H: AuthHost>(
    store: &S,
    host: &H,
    query: &std::collections::BTreeMap<String, Vec<String>>,
) -> Result<AuthResponse, GatewayError> {
    let app_id = query
        .get("app_id")
        .and_then(|values| values.first())
        .and_then(|value| parse_source_integer(value))
        .ok_or_else(|| invalid("app_id query parameter is required and must be a number"))?;
    let k = key();
    let row = store.read(&k).await?;
    let mut rows = current_records(row.as_ref(), host.now_ms())?;
    let old_count = rows.len();
    rows.retain(|record| record.app_id != app_id);
    if rows.len() == old_count {
        return Err(GatewayError::new(404, "Not found", Some("not_found")));
    }
    let revision = uuid_from_random(&host.random_bytes(16)?)?;
    if !store::commit(
        store,
        vec![store::check(&k, row.as_ref())],
        vec![records_mutation(&rows, None, &revision)?],
    )
    .await?
    {
        return Err(conflict("Concurrent modification; retry"));
    }
    Ok(AuthResponse::json(
        200,
        json!({"ok":true,"deleted_app_id":app_id}),
    ))
}

/// Preserve configured environment keys and add current durable keys. Called only for kernel verification.
pub async fn public_pems<S: AuthorityStore>(
    store: &S,
    now: i64,
) -> Result<Vec<String>, GatewayError> {
    let rows = current_records(store.read(&key()).await?.as_ref(), now)?;
    // Source attestation.ts58-88 imports each PEM independently and skips atob/
    // SPKI failures. A lone unit cannot be base64 and is rejected only at this
    // cryptographic projection; stored/public source values remain unchanged.
    Ok(rows
        .into_iter()
        .filter_map(|row| row.pem.try_utf8().ok())
        .collect())
}
