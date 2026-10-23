//! Access-only publication from one constructor-registered native owner. This
//! invokes no OAuth refresh and writes secrets only in the existing raw auth row.
use crate::control_publication::{conflict, unavailable, verify_owner};
use gateway_auth::{
    crypto::Secret,
    native_auth::{AuthenticatedNativeOwner, NativeCapability, NativeTransportIdentity},
    native_credentials::{NativeCredentials, NativeOwnerId, generation_failed, verify_generation},
    provider_credentials::{
        CodexNativeOwner, CodexSourceAccount, codex_source_pool_key, read_codex_source_pool,
    },
    store,
};
use gateway_authority::{
    keys,
    paid_control::PaidControlOwner,
    routing::{PoolAccount, SubscriptionPool},
};
use gateway_core::{
    GatewayError,
    identity::PoolVersionstamp,
    state::{AuthorityStore, RecordMutation, RevisionCheck},
};
use serde_json::json;

/// Not deserializable from a request. A transport resolves this ID through its
/// fixed local registry, and the stored source owner must match its exact home.
pub struct RegisteredAccessOwner {
    id: NativeOwnerId,
    home: String,
}
impl RegisteredAccessOwner {
    pub fn native_owner_id(&self) -> &NativeOwnerId {
        &self.id
    }
    pub fn configured(id: NativeOwnerId, home: String) -> Result<Self, GatewayError> {
        // This declares the native Unix home; it is not a path on the Worker host.
        if id.0.trim().is_empty() || !home.starts_with('/') {
            return Err(unavailable(
                "Native access owner configuration is invalid",
                "native_access_owner_unavailable",
            ));
        }
        Ok(Self { id, home })
    }
}

#[cfg(test)]
mod registration_tests;

pub trait AccessCredentialSource {
    fn read_current_access(
        &self,
        owner: &NativeOwnerId,
    ) -> impl std::future::Future<Output = Result<NativeCredentials, GatewayError>>;
}

pub struct PreparedAccessPublication {
    pub(crate) owner: PaidControlOwner,
    pub(crate) checks: Vec<RevisionCheck>,
    mutations: Vec<RecordMutation>,
    statement: Vec<u8>,
    pub(crate) pool: SubscriptionPool,
    pub(crate) observed: NativeCredentials,
    pub(crate) native_owner_id: String,
    pub(crate) publication_revision: String,
    pub(crate) unchanged: bool,
}
impl PreparedAccessPublication {
    pub async fn capture<S: AuthorityStore, T: AccessCredentialSource>(
        store: &S,
        transport: &T,
        identity: &NativeTransportIdentity,
        registered: &RegisteredAccessOwner,
        now_ms: i64,
        revision: &str,
    ) -> Result<Self, GatewayError> {
        if revision.trim().is_empty() {
            return Err(unavailable(
                "Publication revision is missing",
                "native_access_publication_invalid",
            ));
        }
        let owner_key = keys::paid_control_owner();
        let owner_row = store.read(&owner_key).await?;
        let owner =
            store::decode::<PaidControlOwner>(owner_row.as_ref(), now_ms)?.ok_or_else(|| {
                unavailable(
                    "Native publication owner is not installed",
                    "paid_control_owner_unavailable",
                )
            })?;
        if owner.v != 1
            || owner.owner_id != identity.owner_id()
            || owner.owner_epoch != identity.owner_epoch()
            || owner.key_fingerprint != identity.key_fingerprint()
        {
            return Err(unavailable(
                "Native publication owner changed",
                "paid_control_owner_mismatch",
            ));
        }
        let snapshot = read_codex_source_pool(store, now_ms)
            .await?
            .ok_or_else(|| {
                unavailable(
                    "Existing source credentials are required",
                    "codex_auth_missing",
                )
            })?;
        let normalized_key = keys::pool();
        let normalized_row = store.read(&normalized_key).await?;
        let old_normalized = store::decode::<SubscriptionPool>(normalized_row.as_ref(), now_ms)?;
        if old_normalized
            .as_ref()
            .is_some_and(|pool| pool.v != 1 || pool.pool_versionstamp.0 != snapshot.revision)
        {
            return Err(unavailable(
                "Source and normalized pool revisions differ",
                "native_pool_publication_stale",
            ));
        }
        if old_normalized.as_ref().is_some_and(|pool| {
            pool.accounts.len() != snapshot.pool.accounts.len()
                || pool
                    .accounts
                    .iter()
                    .zip(&snapshot.pool.accounts)
                    .any(|(normalized, source)| {
                        let id = source.identity();
                        normalized.account_id_hash != id.routing_account_hash
                            || normalized.admin_account_hash != id.administrative_account_hash
                            || normalized.credential_version != id.credential_version
                    })
        }) {
            return Err(unavailable(
                "Normalized identities do not match current source order",
                "native_pool_publication_stale",
            ));
        }
        // The read is an existing fixed capability. It cannot accept a request path,
        // replace the selected account, rotate tokens or invoke account/read refresh.
        let observed = transport.read_current_access(&registered.id).await?;
        if observed.external_user_id.is_none() || !observed.refresh_token.expose().is_empty() {
            return Err(unavailable(
                "Only the registered access-only owner may publish here",
                "native_access_owner_unavailable",
            ));
        }
        let mut raw = snapshot.pool;
        let selected = raw
            .accounts
            .iter()
            .position(|account| account.account_id == observed.account_id)
            .ok_or_else(conflict)?;
        let previous = &raw.accounts[selected];
        let native = previous.native_owner.as_ref().ok_or_else(conflict)?;
        if native.codex_home != registered.home
            || native.external_user_id != observed.external_user_id
            || native.generation_hash != previous.identity().native_generation_hash
        {
            return Err(conflict());
        }
        let old = NativeCredentials {
            account_id: previous.account_id.clone(),
            access_token: previous.access_token.clone(),
            refresh_token: previous.refresh_token.clone(),
            email: None,
            native_refreshed_at: native.native_refreshed_at.clone(),
            external_user_id: native.external_user_id.clone(),
        };
        let unchanged = old.same_credentials(&observed);
        if !unchanged
            && (snapshot.revision == revision
                || normalized_row
                    .as_ref()
                    .is_some_and(|row| row.revision == revision))
        {
            return Err(conflict());
        }
        if unchanged {
            if observed
                .access_expires_at_ms()
                .is_none_or(|expiry| expiry <= now_ms.saturating_add(120_000))
            {
                return Err(generation_failed());
            }
        } else {
            verify_generation(&old, &observed, now_ms, true)?;
            raw.accounts[selected] = CodexSourceAccount {
                account_id: observed.account_id.clone(),
                access_token: observed.access_token.clone(),
                refresh_token: Secret::new(String::new()),
                updated_at_ms: now_ms as f64,
                native_owner: Some(CodexNativeOwner {
                    codex_home: registered.home.clone(),
                    generation_hash: observed.generation_hash(),
                    native_refreshed_at: observed.native_refreshed_at.clone(),
                    external_user_id: observed.external_user_id.clone(),
                    managed_source: None,
                }),
            };
            raw.updated_at_ms = now_ms as f64;
        }
        let accounts = raw
            .accounts
            .iter()
            .map(|account| {
                let identity = account.identity();
                let enabled = old_normalized
                    .as_ref()
                    .and_then(|pool| {
                        pool.accounts
                            .iter()
                            .find(|old| old.account_id_hash == identity.routing_account_hash)
                    })
                    .is_none_or(|old| old.enabled);
                PoolAccount {
                    account_id_hash: identity.routing_account_hash,
                    admin_account_hash: identity.administrative_account_hash,
                    credential_version: identity.credential_version,
                    enabled,
                }
            })
            .collect();
        let pool = SubscriptionPool {
            v: 1,
            pool_versionstamp: PoolVersionstamp(if unchanged {
                snapshot.revision.clone()
            } else {
                revision.into()
            }),
            accounts,
        };
        let raw_key = codex_source_pool_key();
        let checks = vec![
            store::check(&owner_key, owner_row.as_ref()),
            RevisionCheck {
                key: raw_key.clone(),
                expected_revision: Some(snapshot.revision.clone()),
            },
            store::check(&normalized_key, normalized_row.as_ref()),
        ];
        let mut mutations = Vec::new();
        if !unchanged {
            mutations.push(store::put(
                raw_key,
                &raw.private_source_value(),
                None,
                revision,
            )?);
        }
        if !unchanged || old_normalized.is_none() {
            mutations.push(store::put(normalized_key, &pool, None, revision)?);
        }
        // Proof material contains no access/refresh token and cannot authorize a
        // different account/workspace/generation or a stale source row.
        let statement=serde_json::to_vec(&json!({"operation":"native_access_publish","owner_id":registered.id.0,"source_revision":snapshot.revision,"publication_revision":revision,"account_id_hash":observed.routing_account_hash(),"credential_version":observed.routing_credential_version(),"native_generation":observed.generation_hash()})).map_err(|_|unavailable("Access publication encoding failed","native_access_publication_invalid"))?;
        Ok(Self {
            owner,
            checks,
            mutations,
            statement,
            pool,
            observed,
            native_owner_id: registered.id.0.clone(),
            publication_revision: revision.into(),
            unchanged,
        })
    }
    pub fn statement(&self) -> &[u8] {
        &self.statement
    }
    pub async fn publish<S: AuthorityStore>(
        self,
        store: &S,
        proof: &AuthenticatedNativeOwner,
        now_ms: i64,
    ) -> Result<SubscriptionPool, GatewayError> {
        let body = self.statement.clone();
        self.publish_received(store, proof, now_ms, &body).await
    }
    pub(crate) async fn publish_received<S: AuthorityStore>(
        self,
        store: &S,
        proof: &AuthenticatedNativeOwner,
        now_ms: i64,
        authenticated_body: &[u8],
    ) -> Result<SubscriptionPool, GatewayError> {
        verify_owner(proof, &self.owner, now_ms, NativeCapability::AccessPublish)?;
        proof.require_body(NativeCapability::AccessPublish, authenticated_body, now_ms)?;
        if !store::commit(store, self.checks, self.mutations).await? {
            return Err(conflict());
        }
        Ok(self.pool)
    }
}
