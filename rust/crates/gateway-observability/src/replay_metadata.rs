//! Source capture-status metadata admission/recount/pruning against the same ledger fence.
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{
    replay_model as model, replay_retention_schema as schema,
    replay_values::{SourceObject, read_json_record},
    store,
};
use gateway_core::{
    GatewayError,
    query::QueryStore,
    source_json::SourceJson,
    state::{RecordKey, RecordMutation, StoredRecord},
};
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub(crate) async fn replay_metadata_candidates(
        &self,
        at: i64,
    ) -> Result<Vec<(RecordKey, StoredRecord, f64, f64)>, GatewayError> {
        let mut out = Vec::new();
        for kind in ["request", "evicted"] {
            for entry in
                store::scan(self.store.as_ref(), model::key(kind), false, at, usize::MAX).await?
            {
                let value = read_json_record(&entry.record)?;
                let parts = store::parts(&entry.key)?;
                if parts.len() != 5 {
                    return Err(store::error("Replay metadata key is invalid"));
                }
                let time = if kind == "request" {
                    let status = model::StatusDocument::parse(&value)?;
                    if parts[4].as_str() != Some(status.data.request_id.as_str()) {
                        return Err(store::error("Replay request-status key mismatch"));
                    }
                    status.data.captured_at_ms
                } else {
                    let value = SourceObject::parse(&value)?;
                    let fingerprint = value
                        .get("fingerprint")
                        .and_then(|v| v.deserialize::<String>().ok());
                    let time = value
                        .get("evicted_at_ms")
                        .and_then(|v| v.deserialize::<f64>().ok())
                        .filter(|n| model::counter(*n));
                    if fingerprint.as_deref() != parts[4].as_str() {
                        return Err(store::error("Replay tombstone key mismatch"));
                    }
                    time.ok_or_else(|| store::error("Replay tombstone time is invalid"))?
                };
                out.push((
                    entry.key,
                    entry.record,
                    schema::metadata_charge(&value),
                    time,
                ));
            }
        }
        out.sort_by(|a, b| a.3.total_cmp(&b.3));
        Ok(out)
    }
    pub(crate) async fn recount_replay_metadata(
        &self,
        limits: schema::RetentionLimits,
        at: i64,
    ) -> Result<bool, GatewayError> {
        for _ in 0..schema::ATTEMPTS {
            let (mut ledger, previous) = schema::read_ledger(self.store.as_ref(), limits).await?;
            if !ledger.ready() {
                return Ok(false);
            }
            let rows = self.replay_metadata_candidates(at).await?;
            ledger.status_records = rows.len() as f64;
            ledger.metadata_bytes = rows.iter().fold(0.0, |sum, row| sum + row.2);
            let marker = model::key("metadata_reconciled");
            if store::commit(
                self.store.as_ref(),
                vec![store::check(&model::key("budget"), previous.as_ref())],
                vec![
                    schema::ledger_mutation(self.host.as_ref(), previous.as_ref(), &ledger)?,
                    store::put(
                        self.host.as_ref(),
                        marker,
                        serde_json::json!({"version":1,"reconciled_at_ms":at}),
                        None,
                    )?,
                ],
            )
            .await?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(crate) async fn prune_replay_metadata(
        &self,
        limits: schema::RetentionLimits,
        at: i64,
        extra_records: f64,
        extra_bytes: f64,
        max_deletes: usize,
    ) -> Result<usize, GatewayError> {
        let (ledger, _) = schema::read_ledger(self.store.as_ref(), limits).await?;
        if ledger.status_records + extra_records <= schema::MAX_RECORDS
            && ledger.metadata_bytes + extra_bytes <= limits.reserve()
        {
            return Ok(0);
        }
        if !self.recount_replay_metadata(limits, at).await? {
            return Ok(0);
        }
        let candidates = self.replay_metadata_candidates(at).await?;
        let mut deleted = 0;
        for (key, row, bytes, _) in candidates {
            if deleted >= max_deletes {
                break;
            }
            let (mut ledger, previous) = schema::read_ledger(self.store.as_ref(), limits).await?;
            if ledger.status_records + extra_records <= schema::MAX_RECORDS
                && ledger.metadata_bytes + extra_bytes <= limits.reserve()
            {
                break;
            }
            ledger.status_records = (ledger.status_records - 1.0).max(0.0);
            ledger.metadata_bytes = (ledger.metadata_bytes - bytes).max(0.0);
            ledger.status_pruned_records += 1.0;
            ledger.last_warning_at_ms = Some(at as f64);
            if store::commit(
                self.store.as_ref(),
                vec![
                    store::check(&model::key("budget"), previous.as_ref()),
                    store::check(&key, Some(&row)),
                ],
                vec![
                    schema::ledger_mutation(self.host.as_ref(), previous.as_ref(), &ledger)?,
                    RecordMutation::Delete { key },
                ],
            )
            .await?
            {
                deleted += 1
            }
        }
        Ok(deleted)
    }
    pub(crate) async fn admit_replay_status(
        &self,
        status: &model::Status,
        limits: schema::RetentionLimits,
    ) -> Result<bool, GatewayError> {
        if !status.valid_stored() {
            return Err(store::error("Replay capture status is invalid"));
        }
        let at = store::now(self.host.as_ref())?;
        let document = SourceJson::from_serializable(status)?;
        let bytes = schema::metadata_charge(&document);
        let key = model::request_key(&status.request_id);
        for _ in 0..schema::ATTEMPTS {
            if !self.bootstrap_replays(limits, at).await? {
                return Ok(false);
            }
            self.prune_replay_metadata(limits, at, 1.0, bytes, 1)
                .await?;
            let (mut ledger, previous) = schema::read_ledger(self.store.as_ref(), limits).await?;
            let raw = self.store.read(&key).await?;
            let old = raw
                .as_ref()
                .filter(|r| r.expires_at_ms.is_none_or(|t| t > at));
            let records = if old.is_none() { 1.0 } else { 0.0 };
            let delta = bytes - schema::row_metadata_charge(old)?;
            if ledger.status_records + records > schema::MAX_RECORDS
                || ledger.metadata_bytes + delta > limits.reserve()
            {
                return Ok(false);
            }
            ledger.status_records += records;
            ledger.metadata_bytes = (ledger.metadata_bytes + delta).max(0.0);
            if store::commit(
                self.store.as_ref(),
                vec![
                    store::check(&model::key("budget"), previous.as_ref()),
                    store::check(&key, raw.as_ref()),
                ],
                vec![
                    schema::ledger_mutation(self.host.as_ref(), previous.as_ref(), &ledger)?,
                    schema::mutation(
                        self.host.as_ref(),
                        key.clone(),
                        None,
                        status,
                        Some(at + model::STATUS_TTL),
                    )?,
                ],
            )
            .await?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
