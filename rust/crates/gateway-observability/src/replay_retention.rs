//! Source replay-retention.ts: fenced reservations, staging and exactly-once charge release.
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{
    replay_model as model,
    replay_retention_schema::{self as schema, RetentionLimits},
    store,
};
use gateway_core::{
    GatewayError,
    query::QueryStore,
    state::{RecordMutation, StoredRecord},
    value::PortableValue,
};
use serde_json::{Value, json};
pub(crate) struct Reservation {
    pub row: schema::Accounting,
    pub key: gateway_core::state::RecordKey,
}
pub(crate) enum Admission {
    Reserved(Reservation),
    Refused(&'static str),
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub(crate) async fn replay_skip(
        &self,
        limits: RetentionLimits,
        reason: &str,
        at: i64,
    ) -> Result<(), GatewayError> {
        for _ in 0..schema::ATTEMPTS {
            let (mut ledger, previous) = schema::read_ledger(self.store.as_ref(), limits).await?;
            ledger.last_skip_reason = Some(reason.into());
            if reason == "storage_full" {
                ledger.last_full_at_ms = Some(at as f64)
            }
            if store::commit(
                self.store.as_ref(),
                vec![store::check(&model::key("budget"), previous.as_ref())],
                vec![schema::ledger_mutation(
                    self.host.as_ref(),
                    previous.as_ref(),
                    &ledger,
                )?],
            )
            .await?
            {
                break;
            }
        }
        Ok(())
    }
    pub(crate) async fn reserve_replay(
        &self,
        capture_id: &str,
        request_id: &str,
        fingerprint: &str,
        sizes: (usize, usize),
        at: i64,
        limits: RetentionLimits,
    ) -> Result<Admission, GatewayError> {
        let (plaintext, metadata) = sizes;
        let charge = schema::reservation_charge(plaintext, metadata);
        for _ in 0..4 {
            if !self.bootstrap_replays(limits, at).await? {
                self.replay_skip(limits, "storage_accounting_in_progress", at)
                    .await?;
                return Ok(Admission::Refused("storage_accounting_in_progress"));
            }
            self.reap_replay_reservations(at, limits).await?;
            let (mut ledger, previous) = schema::read_ledger(self.store.as_ref(), limits).await?;
            if ledger.stored_bytes + ledger.reserved_bytes + charge > limits.payload()
                || ledger.records + 1.0 > schema::MAX_RECORDS
            {
                let target = (limits.payload() * 0.9)
                    .floor()
                    .min((limits.payload() - charge).max(0.0));
                if self
                    .evict_replays(at, limits, target, Some(schema::MAX_RECORDS - 1.0))
                    .await?
                    == 0
                {
                    self.replay_skip(limits, "storage_full", at).await?;
                    return Ok(Admission::Refused("storage_full"));
                }
                continue;
            }
            let row = schema::Accounting {
                version: 1.0,
                capture_id: capture_id.into(),
                request_id: request_id.into(),
                fingerprint: fingerprint.into(),
                bytes: charge,
                state: schema::AccountingState::Reserved,
                fence: 1.0,
                created_at_ms: at as f64,
                expires_at_ms: (at + schema::RESERVATION_MS) as f64,
                status_expires_at_ms: (at + model::STATUS_TTL) as f64,
                stage: 0.0,
                claim_kind: None,
            };
            let key = schema::accounting_key(at as f64, capture_id);
            ledger.reserved_bytes += charge;
            ledger.last_skip_reason = None;
            if store::commit(
                self.store.as_ref(),
                vec![
                    store::check(&model::key("budget"), previous.as_ref()),
                    store::check(&key, None),
                ],
                vec![
                    schema::ledger_mutation(self.host.as_ref(), previous.as_ref(), &ledger)?,
                    schema::mutation(self.host.as_ref(), key.clone(), None, &row, None)?,
                ],
            )
            .await?
            {
                return Ok(Admission::Reserved(Reservation { row, key }));
            }
        }
        self.replay_skip(limits, "storage_full", at).await?;
        Ok(Admission::Refused("storage_full"))
    }
    pub(crate) async fn stage_replay(
        &self,
        reservation: &Reservation,
        ciphertext: &[u8],
        limits: RetentionLimits,
    ) -> Result<bool, GatewayError> {
        for (batch_index, batch) in ciphertext
            .chunks(crate::replay_crypto::CHUNK_BYTES * 12)
            .enumerate()
        {
            let mut staged = None;
            for _ in 0..schema::ATTEMPTS {
                let at = store::now(self.host.as_ref())?;
                let previous = self.store.read(&reservation.key).await?;
                let Some(previous) = previous else {
                    return Ok(false);
                };
                let mut row = schema::accounting(&previous, &reservation.key)?;
                if row.state != schema::AccountingState::Reserved
                    || row.fence != reservation.row.fence
                    || row.expires_at_ms <= at as f64
                {
                    return Ok(false);
                }
                let (ledger, ledger_row) = schema::read_ledger(self.store.as_ref(), limits).await?;
                if !ledger.ready() {
                    return Ok(false);
                }
                row.stage += 1.0;
                let mutation = schema::mutation(
                    self.host.as_ref(),
                    reservation.key.clone(),
                    Some(&previous),
                    &row,
                    None,
                )?;
                let RecordMutation::Put { record, .. } = &mutation else {
                    unreachable!()
                };
                let next = record.clone();
                if store::commit(
                    self.store.as_ref(),
                    vec![
                        store::check(&reservation.key, Some(&previous)),
                        store::check(&model::key("budget"), ledger_row.as_ref()),
                    ],
                    vec![mutation],
                )
                .await?
                {
                    staged = Some(next);
                    break;
                }
            }
            let Some(staged) = staged else {
                return Ok(false);
            };
            let expiry = store::now(self.host.as_ref())? + model::PAYLOAD_TTL;
            let mut chunks = Vec::new();
            for (index, bytes) in batch.chunks(crate::replay_crypto::CHUNK_BYTES).enumerate() {
                chunks.push(RecordMutation::Put {
                    key: model::chunk_key(&reservation.row.capture_id, batch_index * 12 + index),
                    record: StoredRecord::profile_v2(
                        store::uuid(self.host.as_ref())?,
                        PortableValue::Binary {
                            kind: "Uint8Array".into(),
                            bytes: bytes.to_vec(),
                            byte_offset: 0,
                            byte_length: bytes.len() as u64,
                        },
                        Some(expiry),
                    )?,
                });
            }
            if !store::commit(
                self.store.as_ref(),
                vec![store::check(&reservation.key, Some(&staged))],
                chunks,
            )
            .await?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
    pub(crate) async fn publish_replay(
        &self,
        reservation: &Reservation,
        manifest: &model::Manifest,
        status: &model::Status,
        limits: RetentionLimits,
        index: Option<&crate::incidents::NewCaptureIndex<'_>>,
    ) -> Result<bool, GatewayError> {
        let actual = manifest
            .stored_bytes
            .ok_or_else(|| store::error("Replay stored charge is missing"))?;
        let document = gateway_core::source_json::SourceJson::from_serializable(status)?;
        let bytes = schema::metadata_charge(&document);
        let at = manifest.captured_at_ms as i64;
        self.prune_replay_metadata(limits, at, 1.0, bytes, 16)
            .await?;
        let manifest_key = model::manifest_key(
            manifest.captured_at_ms,
            &manifest.fingerprint,
            &manifest.capture_id,
        )?;
        let dk = schema::dedupe_key(&manifest.fingerprint);
        let status_key = model::request_key(&status.request_id);
        for _ in 0..8 {
            let now = store::now(self.host.as_ref())?;
            let previous = self.store.read(&reservation.key).await?;
            let Some(previous) = previous else {
                return Ok(false);
            };
            let mut row = schema::accounting(&previous, &reservation.key)?;
            let (mut ledger, ledger_row) = schema::read_ledger(self.store.as_ref(), limits).await?;
            let status_row = self.store.read(&status_key).await?;
            let visible = status_row
                .as_ref()
                .filter(|r| r.expires_at_ms.is_none_or(|t| t > now));
            let records = if visible.is_none() { 1.0 } else { 0.0 };
            let delta = bytes - schema::row_metadata_charge(visible)?;
            if !ledger.ready()
                || row.state != schema::AccountingState::Reserved
                || row.fence != reservation.row.fence
                || row.created_at_ms != reservation.row.created_at_ms
                || row.expires_at_ms <= now as f64
                || actual > row.bytes
                || actual <= 0.0
                || ledger.reserved_bytes < row.bytes
                || ledger.records + 1.0 > schema::MAX_RECORDS
                || ledger.stored_bytes + ledger.reserved_bytes - row.bytes + actual
                    > limits.payload()
                || ledger.status_records + records > schema::MAX_RECORDS
                || ledger.metadata_bytes + delta > limits.reserve()
            {
                return Ok(false);
            }
            ledger.reserved_bytes = (ledger.reserved_bytes - row.bytes).max(0.0);
            ledger.stored_bytes += actual;
            ledger.records += 1.0;
            ledger.status_records += records;
            ledger.metadata_bytes = (ledger.metadata_bytes + delta).max(0.0);
            ledger.over_budget = ledger.stored_bytes > limits.payload();
            if ledger.over_budget {
                ledger.last_warning_at_ms = Some(at as f64)
            }
            row.state = schema::AccountingState::Stored;
            row.bytes = actual;
            row.expires_at_ms = manifest.expires_at_ms;
            row.status_expires_at_ms = (at + model::STATUS_TTL) as f64;
            let manifest_parts = store::parts(&manifest_key)?;
            let mut checks = vec![
                store::check(&model::key("budget"), ledger_row.as_ref()),
                store::check(&reservation.key, Some(&previous)),
                store::check(&status_key, status_row.as_ref()),
                store::check(&dk, None),
            ];
            let mut mutations = vec![
                schema::ledger_mutation(self.host.as_ref(), ledger_row.as_ref(), &ledger)?,
                schema::mutation(
                    self.host.as_ref(),
                    reservation.key.clone(),
                    Some(&previous),
                    &row,
                    None,
                )?,
                schema::mutation(
                    self.host.as_ref(),
                    manifest_key.clone(),
                    None,
                    manifest,
                    Some(now + model::PAYLOAD_TTL),
                )?,
                store::put(
                    self.host.as_ref(),
                    dk.clone(),
                    json!({"manifest_key":manifest_parts,"captured_at_ms":manifest.captured_at_ms,"expires_at_ms":manifest.expires_at_ms}),
                    Some(now + model::PAYLOAD_TTL),
                )?,
                schema::mutation(
                    self.host.as_ref(),
                    status_key.clone(),
                    None,
                    status,
                    Some(now + model::STATUS_TTL),
                )?,
            ];
            if let Some(binding) = index
                && let Some(publication) = self
                    .new_capture_index_publication(binding, manifest, &manifest_key)
                    .await?
            {
                checks.extend(publication.checks);
                mutations.extend(publication.mutations);
            }
            if store::commit(self.store.as_ref(), checks, mutations).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(crate) async fn delete_replay_chunks(
        &self,
        id: &str,
        max: usize,
    ) -> Result<(usize, bool), GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let prefix = store::key(json!(["uos_ai", "sentinel_replay", "v1", "chunk", id]));
        let rows = store::scan(self.store.as_ref(), prefix.clone(), false, at, max + 1).await?;
        let mut deleted = 0;
        for entry in rows.into_iter().take(max) {
            if store::commit(
                self.store.as_ref(),
                vec![store::check(&entry.key, Some(&entry.record))],
                vec![RecordMutation::Delete { key: entry.key }],
            )
            .await?
            {
                deleted += 1
            }
        }
        let remaining = !store::scan(self.store.as_ref(), prefix, false, at, 1)
            .await?
            .is_empty();
        Ok((deleted, remaining))
    }
    pub(crate) async fn abandon_replay(
        &self,
        reservation: &Reservation,
        limits: RetentionLimits,
    ) -> Result<bool, GatewayError> {
        let mut fence = None;
        for _ in 0..schema::ATTEMPTS {
            let previous = self.store.read(&reservation.key).await?;
            let Some(previous) = previous else {
                return Ok(false);
            };
            let mut row = schema::accounting(&previous, &reservation.key)?;
            if row.state == schema::AccountingState::Revoked {
                fence = Some(row.fence);
                break;
            }
            if row.state != schema::AccountingState::Reserved || row.fence != reservation.row.fence
            {
                return Ok(false);
            }
            row.state = schema::AccountingState::Revoked;
            row.fence += 1.0;
            if store::commit(
                self.store.as_ref(),
                vec![store::check(&reservation.key, Some(&previous))],
                vec![schema::mutation(
                    self.host.as_ref(),
                    reservation.key.clone(),
                    Some(&previous),
                    &row,
                    None,
                )?],
            )
            .await?
            {
                fence = Some(row.fence);
                break;
            }
        }
        let Some(fence) = fence else { return Ok(false) };
        if self
            .delete_replay_chunks(&reservation.row.capture_id, 512)
            .await?
            .1
        {
            return Ok(false);
        }
        for _ in 0..schema::ATTEMPTS {
            let previous = self.store.read(&reservation.key).await?;
            let Some(previous) = previous else {
                return Ok(false);
            };
            let row = schema::accounting(&previous, &reservation.key)?;
            if row.state != schema::AccountingState::Revoked || row.fence != fence {
                return Ok(false);
            }
            let (mut ledger, ledger_row) = schema::read_ledger(self.store.as_ref(), limits).await?;
            if !ledger.ready() {
                return Ok(false);
            }
            ledger.reserved_bytes = (ledger.reserved_bytes - row.bytes).max(0.0);
            if store::commit(
                self.store.as_ref(),
                vec![
                    store::check(&reservation.key, Some(&previous)),
                    store::check(&model::key("budget"), ledger_row.as_ref()),
                ],
                vec![
                    schema::ledger_mutation(self.host.as_ref(), ledger_row.as_ref(), &ledger)?,
                    RecordMutation::Delete {
                        key: reservation.key.clone(),
                    },
                ],
            )
            .await?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(crate) async fn reap_replay_reservations(
        &self,
        at: i64,
        limits: RetentionLimits,
    ) -> Result<usize, GatewayError> {
        use gateway_core::query::{QueryRequest, QuerySelector};
        let cursor_key = model::key("reap_cursor");
        let previous = self.store.read(&cursor_key).await?;
        let cursor = previous
            .as_ref()
            .and_then(|r| r.json_value().ok())
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned);
        let query = QueryRequest {
            selector: QuerySelector::Prefix {
                prefix: model::key("accounting"),
                start: None,
                end: None,
            },
            reverse: false,
            limit: 32,
            cursor,
            now_ms: at,
        };
        let validated = query.validate()?;
        let page = self.store.query(query).await?;
        let mut candidates = Vec::new();
        let mut processed = 0;
        let mut next = None;
        for entry in &page.entries {
            processed += 1;
            next = Some(validated.cursor_after(&entry.key)?);
            if let Ok(row) = schema::accounting(&entry.record, &entry.key)
                && (row.state == schema::AccountingState::Revoked
                    || (row.state == schema::AccountingState::Reserved
                        && row.expires_at_ms <= at as f64))
            {
                candidates.push(Reservation {
                    row,
                    key: entry.key.clone(),
                });
                if candidates.len() >= 8 {
                    break;
                }
            }
        }
        if processed == page.entries.len() {
            next = page.next_cursor
        }
        let mutation = if let Some(cursor) = next {
            store::put(self.host.as_ref(), cursor_key.clone(), json!(cursor), None)?
        } else {
            RecordMutation::Delete {
                key: cursor_key.clone(),
            }
        };
        let _ = store::commit(
            self.store.as_ref(),
            vec![store::check(&cursor_key, previous.as_ref())],
            vec![mutation],
        )
        .await?;
        let mut count = 0;
        for reservation in candidates {
            if self.abandon_replay(&reservation, limits).await? {
                count += 1
            }
        }
        let rows = store::scan(
            self.store.as_ref(),
            model::key("accounting"),
            false,
            at,
            usize::MAX,
        )
        .await?;
        for entry in rows
            .into_iter()
            .filter(|entry| {
                schema::accounting(&entry.record, &entry.key)
                    .is_ok_and(|r| r.state == schema::AccountingState::Evicting)
            })
            .take(8)
        {
            if self
                .finalize_replay_victim(&entry.key, at, limits, 512)
                .await?
            {
                count += 1
            }
        }
        Ok(count)
    }
    pub async fn replay_retention_status(&self, limits: RetentionLimits) -> Value {
        match schema::read_ledger(self.store.as_ref(), limits).await {
            Ok((ledger, _)) => {
                let used = ledger.stored_bytes + ledger.reserved_bytes;
                json!({"state":"ok","scope":"capture_owned_kv_payload","budget_bytes":limits.budget,"stored_bytes":ledger.stored_bytes,"reserved_bytes":ledger.reserved_bytes,"records":ledger.records,"metadata_bytes":ledger.metadata_bytes,"status_records":ledger.status_records,"evicted_records":ledger.evicted_records,"evicted_bytes":ledger.evicted_bytes,"expired_records":ledger.expired_records,"last_eviction_at_ms":ledger.last_eviction_at_ms,"last_warning_at_ms":ledger.last_warning_at_ms,"over_budget":used>limits.payload(),"near_capacity":used>=(limits.payload()*0.9).floor(),"accounting_complete":ledger.ready(),"accounting_error":ledger.accounting_error,"skipped_reason":ledger.last_skip_reason})
            }
            Err(error) => {
                json!({"state":if error.envelope.error.code.as_deref()==Some("observability_state_invalid"){"ok"}else{"unavailable"},"scope":"capture_owned_kv_payload","budget_bytes":limits.budget,"stored_bytes":null,"reserved_bytes":null,"records":null,"metadata_bytes":null,"status_records":null,"evicted_records":null,"evicted_bytes":null,"expired_records":null,"last_eviction_at_ms":null,"last_warning_at_ms":null,"over_budget":false,"near_capacity":false,"accounting_complete":false,"accounting_error":"ledger_corrupt","skipped_reason":"storage_accounting_in_progress"})
            }
        }
    }
    pub async fn maintain_replays(&self, limits: RetentionLimits) -> Result<Value, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        if !self.bootstrap_replays(limits, at).await? {
            return Ok(self.replay_retention_status(limits).await);
        }
        self.reap_replay_reservations(at, limits).await?;
        self.reclaim_expired_replays(at, limits).await?;
        let (ledger, _) = schema::read_ledger(self.store.as_ref(), limits).await?;
        if ledger.stored_bytes + ledger.reserved_bytes > limits.payload() {
            self.evict_replays(at, limits, (limits.payload() * 0.9).floor(), None)
                .await?;
        }
        let marker = self.store.read(&model::key("metadata_reconciled")).await?;
        let due = store::value(marker.as_ref(), at)?
            .and_then(|v| v["reconciled_at_ms"].as_f64())
            .is_none_or(|t| at as f64 - t >= 900_000.0);
        if due {
            self.recount_replay_metadata(limits, at).await?;
        }
        Ok(self.replay_retention_status(limits).await)
    }
}
