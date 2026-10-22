//! One fixed source/normalized/claim publication in the existing authority CAS.
use super::{
    NativeRenewalAuthority, NativeRenewalCancellation, NativeRenewalFence, facts,
    rows::{
        self, ActionRow, GenerationEffect, OperationRow, Phase, TerminalPublication, conflict, fail,
    },
};
use crate::{
    TokenSource, keys,
    routing::{PoolAccount, SubscriptionPool},
    store::Transaction,
    text,
};
use gateway_auth::{
    crypto::{Secret, sha256_hex},
    native::NATIVE_PUBLICATION_PATH,
    native_auth::{AuthenticatedNativeOwner, NativeCapability},
    native_credentials::native_refresh_time_ns,
    provider_credentials::{
        CodexNativeOwner, CodexSourceAccount, MANAGED_NATIVE_SOURCE_VERSION, ManagedNativeSource,
        codex_access_expiry_ms, codex_credential_identity, codex_source_pool_key,
        parse_codex_source_pool, valid_native_generation,
    },
};
use gateway_core::{
    GatewayError,
    identity::PoolVersionstamp,
    state::{AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation, StoredRecord},
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    account_id: String,
    access_token: String,
    #[serde(deserialize_with = "required_nullable")]
    native_refreshed_at: Option<String>,
}
fn required_nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}

/// This parser lives below the publication crate to keep its independent effect guard cycle-free.
/// The publication sender/receiver round-trip fixtures bind this exact private v2 contract.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    operation: String,
    v: u8,
    action_ref: String,
    operation_id: String,
    native_owner_id: String,
    owner_revision: String,
    source_revision: String,
    normalized_revision: String,
    publication_revision: String,
    account_id_hash: String,
    previous_native_source_generation: String,
    native_source_generation: String,
    access_generation: String,
    document: Document,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeManagedPublicationDisposition {
    Applied,
    AlreadyCurrent,
}
pub struct NativeManagedPublication {
    pub disposition: NativeManagedPublicationDisposition,
    pub owner_id: String,
    pub owner_epoch: String,
    pub action_ref: String,
    pub operation_id: String,
    pub native_owner_id: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
    pub publication_revision: String,
    pub current_source_revision: String,
    pub current_normalized_revision: String,
    pub previous_native_source_generation: String,
    pub native_source_generation: String,
    pub access_generation: String,
}

impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'_, S, I, C>
{
    pub fn now_ms(&self) -> Result<i64, GatewayError> {
        self.time(0)
    }

    pub(super) async fn verify_terminal(
        &self,
        tx: &mut Transaction<'_, S, I>,
        action: &ActionRow,
        terminal: &TerminalPublication,
    ) -> Result<NativeRenewalFence, GatewayError> {
        tx.now = self.time(action.created_at_ms)?;
        if tx.now >= action.deadline_ms {
            return Err(fail());
        }
        let control_digest = self.context_control_digest(tx, action).await?;
        if control_digest != action.control_checks_digest {
            return Err(fail());
        }
        let source_key = codex_source_pool_key();
        let source: Value = tx.read(&source_key).await?.ok_or_else(fail)?;
        let pool = parse_codex_source_pool(&source)?.ok_or_else(fail)?;
        let normalized: SubscriptionPool = tx.read(&keys::pool()).await?.ok_or_else(fail)?;
        let slot = pool
            .accounts
            .iter()
            .position(|a| a.identity().routing_account_hash.0 == action.fence.account_id_hash)
            .ok_or_else(fail)?;
        if tx.revision(&source_key).as_deref() != Some(&terminal.source_revision)
            || tx.revision(&keys::pool()).as_deref() != Some(&terminal.normalized_revision)
            || normalized.pool_versionstamp.0 != terminal.source_revision
            || pool.accounts.len() != action.account_digests.len()
            || normalized.accounts.len() != pool.accounts.len()
        {
            return Err(fail());
        }
        for (index, account) in pool.accounts.iter().enumerate() {
            let id = account.identity();
            let projected = &normalized.accounts[index];
            if id.routing_account_hash != projected.account_id_hash
                || id.credential_version != projected.credential_version
                || id.administrative_account_hash != projected.admin_account_hash
            {
                return Err(fail());
            }
            if index != slot
                && facts::digest(&account.private_source_value())? != action.account_digests[index]
            {
                return Err(fail());
            }
        }
        let account = pool.accounts.get(slot).ok_or_else(fail)?;
        let native = account.native_owner.as_ref().ok_or_else(fail)?;
        let physical = native
            .managed_source
            .as_ref()
            .filter(|v| v.v == MANAGED_NATIVE_SOURCE_VERSION)
            .ok_or_else(fail)?;
        let id = account.identity();
        let expiry = codex_access_expiry_ms(&account.access_token).ok_or_else(fail)?;
        tx.now = self.time(tx.now)?;
        super::actor::validate_current_time(&action.actor, tx.now)?;
        if tx.now >= action.deadline_ms
            || expiry <= tx.now.saturating_add(120_000) as f64
            || native.codex_home != self.registered.home
            || native.external_user_id.is_some()
            || !account.refresh_token.expose().is_empty()
            || id.routing_account_hash.0 != action.fence.account_id_hash
            || id.credential_version.0 != terminal.credential_version
            || id.native_generation_hash != terminal.access_generation
            || native.generation_hash != terminal.access_generation
            || physical.generation_hash != terminal.native_source_generation
        {
            return Err(fail());
        }
        let mut fence = action.fence.clone();
        fence.source_revision = terminal.source_revision.clone();
        fence.normalized_revision = terminal.normalized_revision.clone();
        fence.source_native_generation = terminal.native_source_generation.clone();
        fence.access_generation = terminal.access_generation.clone();
        fence.credential_version = terminal.credential_version.clone();
        fence.native_refreshed_at = native.native_refreshed_at.clone();
        fence.access_expires_at_ms = Some(expiry as i64);
        Ok(fence)
    }

    /// Body authentication grants no write by itself: the original actor/action and fixed rows
    /// are independently revalidated and share the atomic source/normalized/terminal mutation.
    pub async fn publish_managed(
        &self,
        proof: &AuthenticatedNativeOwner,
        body: &[u8],
    ) -> Result<NativeManagedPublication, GatewayError> {
        let now = self.time(0)?;
        proof.require_request(
            NativeCapability::AccessPublish,
            NATIVE_PUBLICATION_PATH,
            body,
            now,
        )?;
        if body.len() > 65_536
            || proof.owner_id() != self.identity.owner_id()
            || proof.owner_epoch() != self.identity.owner_epoch()
            || proof.transport_key_fingerprint() != self.identity.key_fingerprint()
        {
            return Err(fail());
        }
        let w: Wire = serde_json::from_slice(body).map_err(|_| fail())?;
        if w.operation != "managed_access_publish"
            || w.v != 2
            || [
                &w.account_id_hash,
                &w.previous_native_source_generation,
                &w.native_source_generation,
                &w.access_generation,
            ]
            .iter()
            .any(|v| !valid_native_generation(v))
        {
            return Err(fail());
        }
        text(&w.publication_revision)?;
        let request_digest = sha256_hex(body);
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(now)?)?;
            let action = self.action(&mut tx, &w.action_ref).await?;
            let mut operation: OperationRow = tx
                .read(&rows::key("operation", &w.operation_id))
                .await?
                .ok_or_else(fail)?;
            if operation.v != 1
                || operation.action_ref != w.action_ref
                || operation.operation_id != w.operation_id
                || action.operation_id.as_deref() != Some(&w.operation_id)
                || w.native_owner_id != action.fence.native_owner_id
                || w.native_owner_id != self.registered.native_owner_id()
                || w.owner_revision != action.fence.owner_revision
                || w.source_revision != action.fence.source_revision
                || w.normalized_revision != action.fence.normalized_revision
                || w.account_id_hash != action.fence.account_id_hash
                || w.previous_native_source_generation != action.fence.source_native_generation
            {
                return Err(conflict());
            }
            if let Some(terminal) = &operation.terminal {
                if terminal.publication_revision != w.publication_revision
                    || terminal.publication_request_digest.as_deref() != Some(&request_digest)
                {
                    return Err(conflict());
                }
                self.verify_terminal(&mut tx, &action, terminal).await?;
                if tx.commit().await? {
                    return Ok(outcome(
                        &w,
                        terminal,
                        self.identity.owner_id(),
                        self.identity.owner_epoch(),
                        NativeManagedPublicationDisposition::AlreadyCurrent,
                    ));
                }
                continue;
            }
            self.current(&mut tx, &action).await?;
            let generation_key = rows::generation_key(&action.fence)?;
            let mut generation: GenerationEffect =
                tx.read(&generation_key).await?.ok_or_else(fail)?;
            if generation.v != 1 || generation.terminal.is_some() {
                return Err(conflict());
            }
            let source_key = codex_source_pool_key();
            let raw: Value = tx.read(&source_key).await?.ok_or_else(fail)?;
            let mut source = parse_codex_source_pool(&raw)?.ok_or_else(fail)?;
            let old_normalized: SubscriptionPool =
                tx.read(&keys::pool()).await?.ok_or_else(fail)?;
            let slot = source
                .accounts
                .iter()
                .position(|a| a.identity().routing_account_hash.0 == action.fence.account_id_hash)
                .ok_or_else(fail)?;
            let previous = source.accounts.get(slot).ok_or_else(fail)?;
            let native = previous.native_owner.as_ref().ok_or_else(fail)?;
            let previous_physical = native
                .managed_source
                .as_ref()
                .filter(|m| m.v == MANAGED_NATIVE_SOURCE_VERSION)
                .ok_or_else(fail)?;
            // Full managed credentials are normalized only under separately approved offline native custody.
            if !previous.refresh_token.expose().is_empty()
                || native.external_user_id.is_some()
                || native.codex_home != self.registered.home
                || previous_physical.generation_hash != w.previous_native_source_generation
                || previous.account_id != w.document.account_id
            {
                return Err(fail());
            }
            let access = Secret::new(w.document.access_token.clone());
            let id = codex_credential_identity(
                &w.document.account_id,
                &access,
                &Secret::new(String::new()),
            );
            let expiry = codex_access_expiry_ms(&access)
                .filter(|n| n.is_finite() && n.fract() == 0.0 && *n <= 9_007_199_254_740_991.0)
                .ok_or_else(fail)?;
            let old_expiry = action.fence.access_expires_at_ms;
            let changed = w.native_source_generation != w.previous_native_source_generation;
            if id.routing_account_hash.0 != w.account_id_hash
                || id.native_generation_hash != w.access_generation
                || expiry <= self.time(tx.now)?.saturating_add(120_000) as f64
                || old_expiry.is_some_and(|old| expiry < old as f64)
            {
                return Err(fail());
            }
            let old_time = native_refresh_time_ns(native.native_refreshed_at.as_deref());
            let new_time = native_refresh_time_ns(w.document.native_refreshed_at.as_deref());
            if w.document
                .native_refreshed_at
                .as_ref()
                .is_some_and(|_| new_time.is_none())
                || (!changed && w.access_generation != native.generation_hash)
                || (changed
                    && (old_expiry.is_some_and(|old| expiry == old as f64)
                        || w.access_generation == native.generation_hash)
                    && !matches!((old_time,new_time),(Some(old),Some(new))if new>old))
            {
                return Err(fail());
            }
            let unchanged = !changed
                && w.access_generation == native.generation_hash
                && w.document.native_refreshed_at == native.native_refreshed_at;
            if unchanged && w.publication_revision != w.source_revision {
                return Err(conflict());
            }
            if !unchanged
                && tx
                    .checks()
                    .iter()
                    .any(|c| c.expected_revision.as_ref() == Some(&w.publication_revision))
            {
                return Err(conflict());
            }
            let terminal = TerminalPublication {
                publication_revision: w.publication_revision.clone(),
                source_revision: if unchanged {
                    w.source_revision.clone()
                } else {
                    w.publication_revision.clone()
                },
                normalized_revision: if unchanged {
                    w.normalized_revision.clone()
                } else {
                    w.publication_revision.clone()
                },
                native_source_generation: w.native_source_generation.clone(),
                access_generation: w.access_generation.clone(),
                credential_version: id.credential_version.0.clone(),
                publication_request_digest: Some(request_digest.clone()),
            };
            let mut mutations = Vec::new();
            if !unchanged {
                source.accounts[slot] = CodexSourceAccount {
                    account_id: w.document.account_id.clone(),
                    access_token: access,
                    refresh_token: Secret::new(String::new()),
                    updated_at_ms: tx.now as f64,
                    native_owner: Some(CodexNativeOwner {
                        codex_home: self.registered.home.clone(),
                        generation_hash: w.access_generation.clone(),
                        native_refreshed_at: w.document.native_refreshed_at.clone(),
                        external_user_id: None,
                        managed_source: Some(ManagedNativeSource {
                            v: MANAGED_NATIVE_SOURCE_VERSION,
                            generation_hash: w.native_source_generation.clone(),
                        }),
                    }),
                };
                source.updated_at_ms = tx.now as f64;
                let accounts = source
                    .accounts
                    .iter()
                    .zip(&old_normalized.accounts)
                    .map(|(a, old)| {
                        let i = a.identity();
                        PoolAccount {
                            account_id_hash: i.routing_account_hash,
                            admin_account_hash: i.administrative_account_hash,
                            credential_version: i.credential_version,
                            enabled: old.enabled,
                        }
                    })
                    .collect();
                let normalized = SubscriptionPool {
                    v: 1,
                    pool_versionstamp: PoolVersionstamp(w.publication_revision.clone()),
                    accounts,
                };
                mutations.push(RecordMutation::Put {
                    key: source_key,
                    record: StoredRecord::json(
                        &w.publication_revision,
                        source.private_source_value(),
                        None,
                    ),
                });
                mutations.push(RecordMutation::Put {
                    key: keys::pool(),
                    record: StoredRecord::json(
                        &w.publication_revision,
                        serde_json::to_value(normalized).map_err(|_| fail())?,
                        None,
                    ),
                });
            }
            operation.phase = Phase::Published;
            operation.publication_revision = Some(w.publication_revision.clone());
            operation.native_source_generation = Some(w.native_source_generation.clone());
            operation.access_generation = Some(w.access_generation.clone());
            operation.terminal = Some(terminal.clone());
            generation.publication_revision = Some(w.publication_revision.clone());
            generation.terminal = Some(terminal.clone());
            for (key, value) in [
                (
                    rows::key("operation", &w.operation_id),
                    serde_json::to_value(operation).map_err(|_| fail())?,
                ),
                (
                    generation_key,
                    serde_json::to_value(generation).map_err(|_| fail())?,
                ),
            ] {
                let revision = self.authority.tokens.next_token()?;
                text(&revision)?;
                if revision == w.publication_revision
                    || tx
                        .checks()
                        .iter()
                        .any(|c| c.expected_revision.as_ref() == Some(&revision))
                {
                    return Err(conflict());
                }
                mutations.push(RecordMutation::Put {
                    key,
                    record: StoredRecord::json(revision, value, None),
                });
            }
            self.current(&mut tx, &action).await?;
            let result = self
                .authority
                .store
                .commit(AtomicTransition {
                    checks: tx.checks(),
                    mutations,
                })
                .await?;
            if result == CommitOutcome::Committed {
                return Ok(outcome(
                    &w,
                    &terminal,
                    self.identity.owner_id(),
                    self.identity.owner_epoch(),
                    if unchanged {
                        NativeManagedPublicationDisposition::AlreadyCurrent
                    } else {
                        NativeManagedPublicationDisposition::Applied
                    },
                ));
            }
        }
        Err(conflict())
    }
}

fn outcome(
    w: &Wire,
    t: &TerminalPublication,
    owner: &str,
    epoch: &str,
    disposition: NativeManagedPublicationDisposition,
) -> NativeManagedPublication {
    NativeManagedPublication {
        disposition,
        owner_id: owner.into(),
        owner_epoch: epoch.into(),
        action_ref: w.action_ref.clone(),
        operation_id: w.operation_id.clone(),
        native_owner_id: w.native_owner_id.clone(),
        owner_revision: w.owner_revision.clone(),
        source_revision: w.source_revision.clone(),
        normalized_revision: w.normalized_revision.clone(),
        publication_revision: t.publication_revision.clone(),
        current_source_revision: t.source_revision.clone(),
        current_normalized_revision: t.normalized_revision.clone(),
        previous_native_source_generation: w.previous_native_source_generation.clone(),
        native_source_generation: t.native_source_generation.clone(),
        access_generation: t.access_generation.clone(),
    }
}
