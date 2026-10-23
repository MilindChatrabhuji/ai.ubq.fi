//! KV U64 values retain their explicit portable-value encoding.
use crate::{store, types::ObservabilityHost};
use gateway_core::{
    GatewayError,
    state::{AuthorityStore, RecordKey, RecordMutation, RevisionCheck, StoredRecord},
    value::PortableValue,
};

pub(crate) fn read(row: Option<&StoredRecord>, at: i64) -> Result<Option<u64>, GatewayError> {
    let Some(row) = row.filter(|r| !r.expires_at_ms.is_some_and(|e| e <= at)) else {
        return Ok(None);
    };
    match row.portable_value()? {
        PortableValue::KvU64(v) => v
            .parse()
            .map(Some)
            .map_err(|_| store::error("Counter is invalid")),
        _ => Err(store::error("Counter must be a source KV U64")),
    }
}
pub(crate) async fn add<S: AuthorityStore, H: ObservabilityHost>(
    store: &S,
    host: &H,
    at: i64,
    deltas: &[(RecordKey, u64)],
    mut checks: Vec<RevisionCheck>,
    mut mutations: Vec<RecordMutation>,
) -> Result<bool, GatewayError> {
    for (key, delta) in deltas {
        let row = store.read(key).await?;
        let next = read(row.as_ref(), at)?.unwrap_or(0).wrapping_add(*delta);
        checks.push(store::check(key, row.as_ref()));
        mutations.push(RecordMutation::Put {
            key: key.clone(),
            record: StoredRecord::profile(
                store::uuid(host)?,
                PortableValue::KvU64(next.to_string()),
                row.as_ref()
                    .and_then(|r| r.expires_at_ms)
                    .filter(|e| *e > at),
            )?,
        });
    }
    store::commit(store, checks, mutations).await
}
