//! Adapt the one raw source account-model record; never persist normalized hash-keyed hints there.
use crate::routing::{AccountCatalog, ModelAvailability, SubscriptionPool, UnsupportedModel};
use crate::store::Transaction;
use crate::{TokenSource, invalid, keys, unavailable};
use gateway_auth::provider_credentials::{codex_source_pool_key, parse_codex_source_pool};
use gateway_core::{GatewayError, model::ModelId, source_json::SourceJson, state::AuthorityStore};
use gateway_core::{js_string::JsString16, source_serialization as source};
use gateway_schema::selection::AccountModelsStore;
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) struct SourceModels {
    pub models: ModelAvailability,
    pub raw: SourceJson,
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
        .read_source_control::<SourceJson>(&keys::models())
        .await?
        .unwrap_or_else(|| {
            SourceJson::parse("{\"accounts\":{},\"unsupported\":{}}").expect("fixed source record")
        });
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
            models.unsupported.insert(
                hash.clone(),
                unsupported
                    .iter()
                    .map(|(model, at)| {
                        (
                            model.clone(),
                            UnsupportedModel {
                                observed_at_ms: *at,
                                detail: unsupported_detail(model),
                            },
                        )
                    })
                    .collect(),
            );
        }
    }
    Ok(SourceModels { models, raw, ids })
}

pub(crate) fn learn(
    raw: &SourceJson,
    id: &str,
    model: &ModelId,
    now: i64,
    collator: &dyn gateway_schema::aliases::SourceStringCollator,
) -> Result<SourceJson, GatewayError> {
    let parsed = AccountModelsStore::parse(raw)
        .unwrap_or_default()
        .record_unsupported(id, model, now, collator)?;
    let mut next = raw.clone();
    if source::entries(&next).is_none() {
        return Err(invalid(
            "Cannot update a malformed source account-model record.",
        ));
    }
    let mut unsupported = source::member(raw, "unsupported")
        .unwrap_or_else(|| SourceJson::parse("{}").expect("fixed empty source object"));
    if source::entries(&unsupported).is_none() {
        return Err(invalid("Source unsupported-model map is malformed."));
    }
    let entries = parsed
        .unsupported
        .get(id)
        .ok_or_else(|| invalid("Source unsupported-model observation is missing."))?;
    let row = source::object_keys(
        entries
            .iter()
            .map(|(model, at)| {
                Ok((
                    model.as_js_string().clone(),
                    SourceJson::from_serializable(at)?,
                ))
            })
            .collect::<Result<Vec<_>, GatewayError>>()?,
    )?;
    set_member(&mut unsupported, id, row)?;
    set_member(&mut next, "unsupported", unsupported)?;
    Ok(next)
}
fn set_member(value: &mut SourceJson, key: &str, next: SourceJson) -> Result<(), GatewayError> {
    let key = JsString16::from_utf8(key);
    let mut entries =
        source::entries(value).ok_or_else(|| invalid("Source model record is malformed."))?;
    if let Some((_, old)) = entries.iter_mut().find(|(name, _)| name == &key) {
        *old = next;
    } else {
        entries.push((key, next));
    }
    *value = source::object_keys(entries)?;
    Ok(())
}
pub(crate) fn unsupported_detail(model: &ModelId) -> JsString16 {
    let mut units = "The '".encode_utf16().collect::<Vec<_>>();
    units.extend_from_slice(model.as_js_string().as_units());
    units
        .extend("' model is not supported when using Codex with a ChatGPT account.".encode_utf16());
    JsString16::from_units(units)
}
