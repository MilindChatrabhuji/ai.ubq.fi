//! One optional original-import cache adapter; never a new effect/start lifetime.
use super::*;
use gateway_auth::{
    native_auth::AuthenticatedNativeOwner,
    native_import::catalog_seed::{
        ImportCatalogSeedReplyData as Reply, ImportCatalogSeedRequestData as Request,
    },
};
use gateway_core::{
    query::QueryStore,
    state::{AtomicTransition, CommitOutcome, RecordKey, RevisionCheck, StoredRecord},
};
use gateway_schema::{catalog_cache, catalog_store};
use std::collections::BTreeMap;

/// Private to this fixed existing publisher. No caller can supply checks/store
/// mutations or use it as a generic authority or refresh-lease bypass.
struct GuardedSeedStore<'a, 'c, 's, S, I, C> {
    control: &'a NativeRenewalAuthority<'c, S, I, C>,
    peer: &'s AuthenticatedNativeOwner,
    body: &'s [u8],
    checks: Vec<RevisionCheck>,
    created_at_ms: i64,
    deadline_ms: i64,
}
impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation> AuthorityStore
    for GuardedSeedStore<'_, '_, '_, S, I, C>
{
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.control.authority.store.read(key).await
    }
    async fn commit(
        &self,
        mut transition: AtomicTransition,
    ) -> Result<CommitOutcome, GatewayError> {
        self.control
            .require_import_phase_peer(self.peer, self.body)?;
        if self.control.time(self.created_at_ms)? >= self.deadline_ms {
            return Err(unavailable());
        }
        // The schema publisher already fences auth-generation. Preserve one
        // identical fence; never replace an original check with a newer view.
        for captured in &self.checks {
            if let Some(existing) = transition
                .checks
                .iter()
                .find(|check| check.key == captured.key)
            {
                if existing.expected_revision != captured.expected_revision {
                    return Err(unavailable());
                }
            } else {
                transition.checks.push(captured.clone());
            }
        }
        self.control.authority.store.commit(transition).await
    }
}
impl<S: QueryStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'_, S, I, C>
{
    /// Dedicated authenticated adapter; old phase handlers keep their old bounds.
    pub async fn handle_import_catalog_seed(
        &self,
        peer: &AuthenticatedNativeOwner,
        body: &[u8],
    ) -> Result<Vec<u8>, GatewayError> {
        self.require_import_phase_peer(peer, body)?;
        let request = Request::parse(body)?;
        let mut tx = self
            .authority
            .transaction(self.time(request.state.created_at_ms)?)?;
        let key = rows::key("action", &request.state.metadata.action_ref);
        let row: ImportActionRow = tx
            .read_source_control(&key)
            .await?
            .ok_or_else(unavailable)?;
        let mut original =
            remote_state::state_data(&row, tx.revision(&key).ok_or_else(unavailable)?);
        original.action_revision = request.state.action_revision.clone();
        let publication = row.publication.as_ref().ok_or_else(unavailable)?;
        if original != request.state
            || publication.claim_ref != request.claim_ref
            || publication.publication_revision != request.publication_revision
            || publication.native_receipt_ref != request.native_receipt_ref
            || publication.publication_request_digest != request.publication_request_digest
        {
            return Err(unavailable());
        }
        publication_current::verify(self, &mut tx, &row, publication).await?;
        let version = match &publication.catalog_disposition {
            ImportCatalogDisposition::Normalized { client_version, .. }
                if client_version == &request.client_version =>
            {
                Some(client_version)
            }
            ImportCatalogDisposition::AuthenticatedLimited {
                upstream_status: 429,
            } => None,
            _ => return Err(unavailable()),
        };
        let generation: Option<String> = tx.read(&catalog_store::auth_generation_key()).await?;
        let checks = tx.checks();
        if !tx.commit().await? {
            return Err(unavailable());
        }
        self.require_import_phase_peer(peer, body)?;
        let Some(version) = version else {
            return Reply::new(false).bytes();
        };
        let generation = generation
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(unavailable)?;
        let seeded = if let Ok(body_generation) = self.authority.tokens.next_token() {
            if body_generation.trim().is_empty() {
                false
            } else {
                let prepared = catalog_cache::prepare_catalog(
                    version,
                    &generation,
                    &body_generation,
                    &request.source_body,
                    request.etag.as_deref(),
                    request.content_type.as_deref(),
                    self.time(row.created_at_ms)?,
                    &BTreeMap::new(),
                );
                match prepared {
                    Err(_) => false,
                    Ok(prepared) => {
                        let store = GuardedSeedStore {
                            control: self,
                            peer,
                            body,
                            checks,
                            created_at_ms: row.created_at_ms,
                            deadline_ms: row.deadline_ms,
                        };
                        let published = catalog_store::publish_catalog(&store, &prepared)
                            .await
                            .unwrap_or(false);
                        if published {
                            let _ = catalog_store::prune_stored_catalog_versions(
                                &self.authority.store,
                                version,
                                self.time(row.created_at_ms)?,
                            )
                            .await;
                        }
                        published
                    }
                }
            }
        } else {
            false
        };
        self.require_import_phase_peer(peer, body)?;
        Reply::new(seeded).bytes()
    }
}
