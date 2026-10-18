//! Adapt the one raw source account-model record; never persist normalized hash-keyed hints there.
use crate::routing::{AccountCatalog, ModelAvailability, SubscriptionPool, UnsupportedModel};
use crate::store::Transaction;
use crate::{TokenSource, invalid, keys, unavailable};
use gateway_auth::provider_credentials::{codex_source_pool_key, parse_codex_source_pool};
use gateway_core::{GatewayError, state::AuthorityStore};
use gateway_schema::selection::AccountModelsStore;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(crate) struct SourceModels {
    pub models: ModelAvailability,
    pub raw: Value,
    pub ids: BTreeMap<String, String>,
}

pub(crate) async fn load<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    pool: &SubscriptionPool,
) -> Result<SourceModels, GatewayError> {
    let source_key = codex_source_pool_key();
    let source: Value = tx.read(&source_key).await?.ok_or_else(|| {
        unavailable(
            "codex_routing_unavailable",
            "Current raw Codex source pool is unavailable.",
        )
    })?;
    let source = parse_codex_source_pool(&source)?
        .ok_or_else(|| invalid("Current raw Codex source pool is malformed."))?;
    if tx.revision(&source_key).as_deref() != Some(pool.pool_versionstamp.0.as_str())
        || source.accounts.len() != pool.accounts.len()
    {
        return Err(unavailable(
            "codex_routing_unavailable",
            "Normalized Codex pool is not bound to the current source revision.",
        ));
    }
    let mut ids = BTreeMap::new();
    for (raw, normalized) in source.accounts.iter().zip(&pool.accounts) {
        let identity = raw.identity();
        if identity.routing_account_hash != normalized.account_id_hash
            || identity.credential_version != normalized.credential_version
            || identity.administrative_account_hash != normalized.admin_account_hash
        {
            return Err(unavailable(
                "codex_routing_unavailable",
                "Normalized Codex account identity differs from the current raw credential.",
            ));
        }
        ids.insert(normalized.account_id_hash.0.clone(), raw.account_id.clone());
    }
    let raw = tx
        .read::<Value>(&keys::models())
        .await?
        .unwrap_or_else(|| json!({"accounts":{},"unsupported":{}}));
    let source = AccountModelsStore::parse(&raw).unwrap_or_default();
    let mut models = ModelAvailability::default();
    for (hash, id) in &ids {
        if let Some(catalog) = source.accounts.get(id) {
            models.catalogs.insert(
                hash.clone(),
                AccountCatalog {
                    client_version: catalog.client_version.clone(),
                    models: catalog.slugs.clone(),
                },
            );
        }
        if let Some(unsupported) = source.unsupported.get(id) {
            models.unsupported.insert(hash.clone(),unsupported.iter().map(|(model,at)|(model.clone(),UnsupportedModel{
                observed_at_ms:*at,detail:format!("The '{model}' model is not supported when using Codex with a ChatGPT account."),
            })).collect());
        }
    }
    Ok(SourceModels { models, raw, ids })
}

pub(crate) fn learn(raw: &Value, id: &str, model: &str, now: i64) -> Result<Value, GatewayError> {
    let parsed = AccountModelsStore::parse(raw)
        .unwrap_or_default()
        .record_unsupported(id, model, now);
    let mut next = raw.clone();
    let object = next
        .as_object_mut()
        .ok_or_else(|| invalid("Cannot update a malformed source account-model record."))?;
    let unsupported = object
        .entry("unsupported")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| invalid("Source unsupported-model map is malformed."))?;
    let entries = parsed
        .unsupported
        .get(id)
        .ok_or_else(|| invalid("Source unsupported-model observation is missing."))?;
    unsupported.insert(
        id.to_owned(),
        serde_json::to_value(entries)
            .map_err(|_| invalid("Source unsupported-model observation cannot be encoded."))?,
    );
    Ok(next)
}
