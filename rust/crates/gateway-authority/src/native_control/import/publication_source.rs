//! Fixed source/normalized/catalog mutations for one verified original import.
use super::*;
use crate::{
    keys,
    routing::{PoolAccount, SubscriptionPool},
    store::Transaction,
};
use gateway_auth::{
    crypto::Secret,
    provider_credentials::{
        CodexNativeOwner, CodexSourceAccount, MANAGED_NATIVE_SOURCE_VERSION, ManagedNativeSource,
        codex_source_pool_key, parse_codex_source_pool,
    },
};
use gateway_core::{
    identity::PoolVersionstamp,
    source_control::encode_source_control_record,
    source_json::SourceJson,
    state::{RecordMutation, StoredRecord},
};
use gateway_schema::{catalog_store, snapshot::ModelSnapshot};
use serde_json::{Value, json};

pub(super) struct SourcePlan {
    pub mutations: Vec<RecordMutation>,
    pub runtime: Option<StoredRecord>,
    pub catalog_revision: Option<String>,
    pub runtime_revision: Option<String>,
    pub auth_generation_revision: Option<String>,
}
pub(super) async fn prepare<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>(
    control: &NativeRenewalAuthority<'_, S, I, C>,
    tx: &mut Transaction<'_, S, I>,
    row: &ImportActionRow,
    wire: &ImportPublicationCommandData,
) -> Result<SourcePlan, GatewayError> {
    let source_key = codex_source_pool_key();
    let raw: Value = tx.read(&source_key).await?.ok_or_else(unavailable)?;
    let mut source = parse_codex_source_pool(&raw)?.ok_or_else(unavailable)?;
    let normalized: SubscriptionPool = tx.read(&keys::pool()).await?.ok_or_else(unavailable)?;
    let slot = usize::try_from(row.facts.slot).map_err(|_| unavailable())?;
    let previous = source.accounts.get(slot).ok_or_else(unavailable)?;
    if previous.account_id != wire.document.account_id
        || normalized.accounts.len() != source.accounts.len()
    {
        return Err(unavailable());
    }
    let access = Secret::new(wire.document.access_token.clone());
    let identity = gateway_auth::provider_credentials::codex_credential_identity(
        &wire.document.account_id,
        &access,
        &Secret::new(String::new()),
    );
    if identity.routing_account_hash.0 != wire.account_id_hash
        || identity.native_generation_hash != wire.access_generation
    {
        return Err(unavailable());
    }
    source.accounts[slot] = CodexSourceAccount {
        account_id: wire.document.account_id.clone(),
        access_token: access,
        refresh_token: Secret::new(String::new()),
        updated_at_ms: wire.document.updated_at_ms,
        native_owner: Some(CodexNativeOwner {
            codex_home: control.registered.home.clone(),
            generation_hash: wire.access_generation.clone(),
            native_refreshed_at: wire.document.native_refreshed_at.clone(),
            external_user_id: None,
            managed_source: Some(ManagedNativeSource {
                v: MANAGED_NATIVE_SOURCE_VERSION,
                generation_hash: wire.native_source_generation.clone(),
            }),
        }),
    };
    source.updated_at_ms = tx.now as f64;
    let accounts = source
        .accounts
        .iter()
        .zip(&normalized.accounts)
        .map(|(account, old)| {
            let id = account.identity();
            PoolAccount {
                account_id_hash: id.routing_account_hash,
                admin_account_hash: id.administrative_account_hash,
                credential_version: id.credential_version,
                enabled: old.enabled,
            }
        })
        .collect();
    let projected = SubscriptionPool {
        v: 1,
        pool_versionstamp: PoolVersionstamp(wire.publication_revision.clone()),
        accounts,
    };
    let mut mutations = vec![
        RecordMutation::Put {
            key: source_key,
            record: StoredRecord::json(
                &wire.publication_revision,
                source.private_source_value(),
                None,
            ),
        },
        RecordMutation::Put {
            key: keys::pool(),
            record: StoredRecord::json(
                &wire.publication_revision,
                serde_json::to_value(projected).map_err(|_| unavailable())?,
                None,
            ),
        },
    ];
    let catalog_key = catalog_store::codex_snapshot_key();
    let runtime_key = catalog_store::runtime_config_key();
    let generation_key = catalog_store::auth_generation_key();
    let current: Option<ModelSnapshot> = tx.read_source_control(&catalog_key).await?;
    let runtime_source: Option<SourceJson> = tx.read_source_control(&runtime_key).await?;
    let _: Option<Value> = tx.read(&generation_key).await?;
    match &wire.catalog {
        ImportCatalogData::AuthenticatedLimited {
            upstream_status: 429,
        } => {
            if current.is_none() {
                return Err(missing_catalog());
            }
            Ok(SourcePlan {
                mutations,
                runtime: None,
                catalog_revision: tx.revision(&catalog_key),
                runtime_revision: tx.revision(&runtime_key),
                auth_generation_revision: tx.revision(&generation_key),
            })
        }
        ImportCatalogData::Normalized {
            snapshot,
            client_version,
            ..
        } => {
            let empty = SourceJson::parse("null")?;
            let (catalog, runtime) = catalog_store::normalized_snapshot_plan(
                snapshot,
                client_version,
                current.as_ref(),
                runtime_source.as_ref().unwrap_or(&empty),
                tx.now,
            )
            .ok_or_else(super::publication::conflict)?;
            let runtime = encode_source_control_record(&wire.publication_revision, &runtime, None)?;
            let generation = control.authority.tokens.next_token()?;
            crate::text(&generation)?;
            mutations.push(RecordMutation::Put {
                key: catalog_key,
                record: encode_source_control_record(
                    &wire.publication_revision,
                    &SourceJson::from_serializable(&catalog)?,
                    None,
                )?,
            });
            mutations.push(RecordMutation::Put {
                key: runtime_key,
                record: runtime.clone(),
            });
            mutations.push(RecordMutation::Put {
                key: generation_key,
                record: StoredRecord::json(&wire.publication_revision, json!(generation), None),
            });
            Ok(SourcePlan {
                mutations,
                runtime: Some(runtime),
                catalog_revision: Some(wire.publication_revision.clone()),
                runtime_revision: Some(wire.publication_revision.clone()),
                auth_generation_revision: Some(wire.publication_revision.clone()),
            })
        }
        _ => Err(unavailable()),
    }
}
pub(super) fn missing_catalog() -> GatewayError {
    GatewayError::new(
        409,
        "An existing Codex model catalog is required for authenticated limited import.",
        Some("codex_catalog_required"),
    )
}
