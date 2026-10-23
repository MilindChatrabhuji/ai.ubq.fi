//! Source replay eviction/expiry claims retain their charge until all chunks are gone.
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{
    replay_model as model, replay_retention_schema as schema,
    replay_values::{SourceObject, read_json_record},
    store,
};
use gateway_core::{
    GatewayError,
    query::QueryStore,
    state::{RecordKey, RecordMutation},
};
use serde_json::json;
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    async fn claim_replay_victim(
        &self,
        key: &RecordKey,
        candidate: &schema::Accounting,
        kind: schema::ClaimKind,
        limits: schema::RetentionLimits,
    ) -> Result<bool, GatewayError> {
        let previous = self.store.read(key).await?;
        let Some(previous) = previous else {
            return Ok(false);
        };
        let mut row = schema::accounting(&previous, key)?;
        if row.state != schema::AccountingState::Stored
            || row.fence != candidate.fence
            || row.bytes != candidate.bytes
        {
            return Ok(false);
        }
        let (ledger, ledger_row) = schema::read_ledger(self.store.as_ref(), limits).await?;
        if !ledger.ready() {
            return Ok(false);
        }
        row.state = schema::AccountingState::Evicting;
        row.fence += 1.0;
        row.claim_kind = Some(kind);
        store::commit(
            self.store.as_ref(),
            vec![
                store::check(key, Some(&previous)),
                store::check(&model::key("budget"), ledger_row.as_ref()),
            ],
            vec![
                schema::ledger_mutation(self.host.as_ref(), ledger_row.as_ref(), &ledger)?,
                schema::mutation(self.host.as_ref(), key.clone(), Some(&previous), &row, None)?,
            ],
        )
        .await
    }
    async fn remove_claimed_replay_payload(
        &self,
        row: &schema::Accounting,
    ) -> Result<(), GatewayError> {
        let key = model::manifest_key(row.created_at_ms, &row.fingerprint, &row.capture_id)?;
        if let Some(previous) = self.store.read(&key).await? {
            let manifest = model::Manifest::from_source(&read_json_record(&previous)?)?;
            if !manifest.matches_key(&key)? || manifest.fingerprint != row.fingerprint {
                return Err(store::error("Claimed replay manifest identity changed"));
            }
            if !store::commit(
                self.store.as_ref(),
                vec![store::check(&key, Some(&previous))],
                vec![RecordMutation::Delete { key: key.clone() }],
            )
            .await?
            {
                return Err(store::error("Claimed replay manifest changed concurrently"));
            }
        }
        let dedupe = schema::dedupe_key(&row.fingerprint);
        if let Some(previous) = self.store.read(&dedupe).await? {
            let value = SourceObject::parse(&read_json_record(&previous)?)?;
            if let Some(parts) = value
                .get("manifest_key")
                .map(|v| v.array_items())
                .transpose()?
                && parts.len() == 7
                && model::tuple_from_source(&parts)? == key
            {
                let _ = store::commit(
                    self.store.as_ref(),
                    vec![store::check(&dedupe, Some(&previous))],
                    vec![RecordMutation::Delete { key: dedupe }],
                )
                .await?;
            }
        }
        Ok(())
    }
    pub(crate) async fn finalize_replay_victim(
        &self,
        key: &RecordKey,
        at: i64,
        limits: schema::RetentionLimits,
        max_deletes: usize,
    ) -> Result<bool, GatewayError> {
        let Some(previous) = self.store.read(key).await? else {
            return Ok(false);
        };
        let row = schema::accounting(&previous, key)?;
        if row.state != schema::AccountingState::Evicting {
            return Ok(false);
        }
        let Some(kind) = row.claim_kind else {
            return Ok(false);
        };
        if self
            .delete_replay_chunks(&row.capture_id, max_deletes)
            .await?
            .1
        {
            return Ok(false);
        }
        self.remove_claimed_replay_payload(&row).await?;
        let reason = match kind {
            schema::ClaimKind::Evicted => "storage_budget",
            schema::ClaimKind::Expired => "payload_expired",
        };
        let status = model::Status {
            version: 1.0,
            request_id: row.request_id.clone(),
            status: match kind {
                schema::ClaimKind::Evicted => model::CaptureState::Evicted,
                schema::ClaimKind::Expired => model::CaptureState::Expired,
            },
            reason: Some(reason.into()),
            captured_at_ms: row.created_at_ms,
            manifest_key: None,
            fingerprint: None,
            expires_at_ms: None,
        };
        let tombstone = json!({"version":1,"fingerprint":row.fingerprint,"request_id":row.request_id,"evicted_at_ms":at,"reason":reason});
        let has_owner = !row.request_id.is_empty();
        let count = if has_owner { 2.0 } else { 1.0 };
        let bytes = schema::metadata_charge(
            &gateway_core::source_json::SourceJson::from_serializable(&tombstone)?,
        ) + if has_owner {
            schema::metadata_charge(&gateway_core::source_json::SourceJson::from_serializable(
                &status,
            )?)
        } else {
            0.0
        };
        self.prune_replay_metadata(limits, at, count, bytes, 16)
            .await?;
        for _ in 0..schema::ATTEMPTS {
            let (mut ledger, ledger_row) = schema::read_ledger(self.store.as_ref(), limits).await?;
            if !ledger.ready() {
                return Ok(false);
            }
            let previous = self.store.read(key).await?;
            let Some(previous) = previous else {
                return Ok(false);
            };
            let current = schema::accounting(&previous, key)?;
            if current.state != schema::AccountingState::Evicting || current.fence != row.fence {
                return Ok(false);
            }
            let status_key = model::request_key(&row.request_id);
            let old_status = if has_owner {
                self.store.read(&status_key).await?
            } else {
                None
            };
            let tombstone_key = model::tombstone_key(&row.fingerprint);
            let old_tombstone = self.store.read(&tombstone_key).await?;
            let visible_status = old_status
                .as_ref()
                .filter(|r| r.expires_at_ms.is_none_or(|t| t > at));
            let visible_tombstone = old_tombstone
                .as_ref()
                .filter(|r| r.expires_at_ms.is_none_or(|t| t > at));
            let old_count = f64::from(
                u8::from(visible_status.is_some()) + u8::from(visible_tombstone.is_some()),
            );
            let old_bytes = schema::row_metadata_charge(visible_status)?
                + schema::row_metadata_charge(visible_tombstone)?;
            let fits = ledger.status_records + count - old_count <= schema::MAX_RECORDS
                && ledger.metadata_bytes + bytes - old_bytes <= limits.reserve();
            let after_count = if fits {
                count
            } else {
                f64::from(u8::from(visible_tombstone.is_some()))
            };
            let after_bytes = if fits {
                bytes
            } else {
                schema::row_metadata_charge(visible_tombstone)?
            };
            ledger.stored_bytes = (ledger.stored_bytes - row.bytes).max(0.0);
            ledger.records = (ledger.records - 1.0).max(0.0);
            ledger.status_records = (ledger.status_records + after_count - old_count).max(0.0);
            ledger.metadata_bytes = (ledger.metadata_bytes + after_bytes - old_bytes).max(0.0);
            match kind {
                schema::ClaimKind::Evicted => {
                    ledger.evicted_bytes += row.bytes;
                    ledger.evicted_records += 1.0;
                    ledger.last_eviction_at_ms = Some(at as f64)
                }
                schema::ClaimKind::Expired => {
                    ledger.expired_bytes += row.bytes;
                    ledger.expired_records += 1.0
                }
            }
            ledger.over_budget = ledger.stored_bytes > limits.payload();
            let mut checks = vec![
                store::check(&model::key("budget"), ledger_row.as_ref()),
                store::check(key, Some(&previous)),
                store::check(&tombstone_key, old_tombstone.as_ref()),
            ];
            let mut mutations = vec![
                schema::ledger_mutation(self.host.as_ref(), ledger_row.as_ref(), &ledger)?,
                RecordMutation::Delete { key: key.clone() },
            ];
            if has_owner {
                checks.push(store::check(&status_key, old_status.as_ref()));
                mutations.push(RecordMutation::Delete {
                    key: status_key.clone(),
                });
            }
            if fits {
                mutations.push(store::put(
                    self.host.as_ref(),
                    tombstone_key,
                    tombstone.clone(),
                    Some(at + model::STATUS_TTL),
                )?);
                if has_owner {
                    mutations.push(schema::mutation(
                        self.host.as_ref(),
                        status_key,
                        None,
                        &status,
                        Some(at + model::STATUS_TTL),
                    )?)
                }
            }
            if store::commit(self.store.as_ref(), checks, mutations).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(crate) async fn reclaim_expired_replays(
        &self,
        at: i64,
        limits: schema::RetentionLimits,
    ) -> Result<usize, GatewayError> {
        let rows = store::scan(
            self.store.as_ref(),
            model::key("accounting"),
            false,
            at,
            usize::MAX,
        )
        .await?;
        let mut count = 0;
        for entry in rows
            .into_iter()
            .filter(|e| {
                schema::accounting(&e.record, &e.key).is_ok_and(|r| {
                    r.state == schema::AccountingState::Stored && r.expires_at_ms <= at as f64
                })
            })
            .take(16)
        {
            let row = schema::accounting(&entry.record, &entry.key)?;
            if self
                .claim_replay_victim(&entry.key, &row, schema::ClaimKind::Expired, limits)
                .await?
                && self
                    .finalize_replay_victim(&entry.key, at, limits, 512)
                    .await?
            {
                count += 1
            }
        }
        Ok(count)
    }
    pub(crate) async fn evict_replays(
        &self,
        at: i64,
        limits: schema::RetentionLimits,
        target: f64,
        target_records: Option<f64>,
    ) -> Result<usize, GatewayError> {
        let mut count = self.reclaim_expired_replays(at, limits).await?;
        let rows = store::scan(
            self.store.as_ref(),
            model::key("accounting"),
            false,
            at,
            usize::MAX,
        )
        .await?;
        let mut chunks_left = 512;
        for entry in rows
            .into_iter()
            .filter(|e| {
                schema::accounting(&e.record, &e.key).is_ok_and(|r| {
                    r.state == schema::AccountingState::Stored && r.expires_at_ms > at as f64
                })
            })
            .take(16)
        {
            let (ledger, _) = schema::read_ledger(self.store.as_ref(), limits).await?;
            if ledger.stored_bytes <= target && target_records.is_none_or(|n| ledger.records <= n) {
                break;
            }
            if chunks_left == 0 {
                break;
            }
            let row = schema::accounting(&entry.record, &entry.key)?;
            if !self
                .claim_replay_victim(&entry.key, &row, schema::ClaimKind::Evicted, limits)
                .await?
            {
                continue;
            }
            let (deleted, remaining) = self
                .delete_replay_chunks(&row.capture_id, chunks_left)
                .await?;
            chunks_left = chunks_left.saturating_sub(deleted);
            if !remaining
                && self
                    .finalize_replay_victim(&entry.key, at, limits, 0)
                    .await?
            {
                count += 1
            }
        }
        Ok(count)
    }
}
