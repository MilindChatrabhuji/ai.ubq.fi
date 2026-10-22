//! Fixed, bounded durable replay fences. Expiry cleanup belongs to the request;
//! capacity never evicts a nonce that can still authenticate a replay.
use crate::{
    GatewayError,
    crypto::{base64url, decode_base64url, sha256_hex},
    native::NATIVE_NONCE_CAP,
    native_auth::NativeNonceAuthority,
    store,
};
use gateway_core::state::AuthorityStore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

pub fn native_nonce_key() -> gateway_core::state::RecordKey {
    store::key(json!(["uos_ai", "native_nonce_registry", "v1"]))
}

#[derive(Deserialize, Serialize)]
struct NonceRegistry {
    v: u32,
    nonces: BTreeMap<String, i64>,
}

pub struct StoreNonceAuthority<'a, S> {
    store: &'a S,
}
impl<'a, S: AuthorityStore> StoreNonceAuthority<'a, S> {
    pub fn new(store: &'a S) -> Self {
        Self { store }
    }
}

impl<S: AuthorityStore> NativeNonceAuthority for StoreNonceAuthority<'_, S> {
    async fn consume_nonce(
        &self,
        key_id: &str,
        nonce: &str,
        valid_through_ms: i64,
        now_ms: i64,
    ) -> Result<(), GatewayError> {
        let decoded = decode_base64url(nonce)?;
        if key_id.is_empty()
            || key_id.len() > 64
            || !key_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            || decoded.len() != 32
            || base64url(&decoded) != nonce
            || now_ms < 0
            || valid_through_ms < now_ms
        {
            return Err(unavailable());
        }
        let key = native_nonce_key();
        let id = format!("{key_id}:{nonce}");
        for _ in 0..3 {
            let row = self.store.read(&key).await?;
            if row.as_ref().is_some_and(|row| row.expires_at_ms.is_some()) {
                return Err(unavailable());
            }
            let mut state =
                store::decode::<NonceRegistry>(row.as_ref(), now_ms)?.unwrap_or(NonceRegistry {
                    v: 1,
                    nonces: BTreeMap::new(),
                });
            if state.v != 1
                || state.nonces.len() > NATIVE_NONCE_CAP
                || state
                    .nonces
                    .iter()
                    .any(|(id, expiry)| id.len() > 108 || !id.contains(':') || *expiry < 0)
            {
                return Err(unavailable());
            }
            state.nonces.retain(|_, expiry| *expiry >= now_ms);
            if state.nonces.contains_key(&id) {
                return Err(GatewayError::new(
                    409,
                    "Native authentication nonce was already consumed",
                    Some("native_nonce_replayed"),
                ));
            }
            if state.nonces.len() >= NATIVE_NONCE_CAP {
                return Err(GatewayError::unavailable(
                    "Native authentication nonce capacity is full",
                    "native_nonce_capacity",
                ));
            }
            state.nonces.insert(id.clone(), valid_through_ms);
            let revision = sha256_hex(
                format!(
                    "native-nonce-registry-v1\0{}\0{id}\0{valid_through_ms}",
                    row.as_ref().map(|r| r.revision.as_str()).unwrap_or("")
                )
                .as_bytes(),
            );
            if store::commit(
                self.store,
                vec![store::check(&key, row.as_ref())],
                vec![store::put(key.clone(), &state, None, &revision)?],
            )
            .await?
            {
                return Ok(());
            }
        }
        Err(GatewayError::unavailable(
            "Native authentication nonce registry changed concurrently",
            "native_nonce_conflict",
        ))
    }
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Native authentication nonce registry is invalid",
        "native_nonce_state_invalid",
    )
}
