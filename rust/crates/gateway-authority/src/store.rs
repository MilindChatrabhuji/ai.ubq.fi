use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use gateway_core::GatewayError;
use gateway_core::source_control::{decode_source_control_record, encode_source_control_record};
use gateway_core::source_json::SourceJson;
use gateway_core::state::{
    AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
    StoredRecord,
};
use gateway_schema::aliases::SourceStringCollator;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::{invalid, text, validate_time};

/// Platform-supplied cryptographically unique opaque tokens. Revisions are never parsed.
/// A reset owner or probe token must remain unpredictable to other callers.
pub trait TokenSource {
    fn next_token(&self) -> Result<String, GatewayError>;
}

/// Time-sensitive authority actions recheck time after awaited reads and before spending.
pub trait AuthorityClock: Send + Sync {
    fn now_ms(&self) -> Result<i64, GatewayError>;
}

pub struct Authority<S, I> {
    pub(crate) store: S,
    pub(crate) tokens: I,
    clock: Option<Box<dyn AuthorityClock>>,
    source_string_collator: Option<Arc<dyn SourceStringCollator>>,
}

struct MissingSourceStringCollator;
static MISSING_SOURCE_STRING_COLLATOR: MissingSourceStringCollator = MissingSourceStringCollator;
impl SourceStringCollator for MissingSourceStringCollator {
    fn compare(
        &self,
        _left: &gateway_core::js_string::JsString16,
        _right: &gateway_core::js_string::JsString16,
    ) -> Result<std::cmp::Ordering, GatewayError> {
        Err(GatewayError::unavailable(
            "Source string comparison requires the trusted runtime capability.",
            "source_string_collation_unavailable",
        ))
    }
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub fn new(store: S, tokens: I) -> Self {
        Self {
            store,
            tokens,
            clock: None,
            source_string_collator: None,
        }
    }

    pub fn with_clock(store: S, tokens: I, clock: impl AuthorityClock + 'static) -> Self {
        Self {
            store,
            tokens,
            clock: Some(Box::new(clock)),
            source_string_collator: None,
        }
    }

    /// Trusted source-runtime comparison capability, never a request/token field.
    pub fn with_source_string_collator(mut self, collator: Arc<dyn SourceStringCollator>) -> Self {
        self.source_string_collator = Some(collator);
        self
    }

    pub(crate) fn source_string_collator(&self) -> &dyn SourceStringCollator {
        self.source_string_collator
            .as_deref()
            .unwrap_or(&MISSING_SOURCE_STRING_COLLATOR)
    }

    pub(crate) fn fresh_time(&self, started_at: i64) -> Result<i64, GatewayError> {
        let now = self
            .clock
            .as_ref()
            .ok_or_else(|| {
                crate::unavailable(
                    "authority_clock_unavailable",
                    "Time-sensitive authority actions require a trusted current clock.",
                )
            })?
            .now_ms()?;
        validate_time(now)?;
        if now < started_at {
            return Err(crate::unavailable(
                "invalid_clock",
                "Authority clock moved backwards.",
            ));
        }
        Ok(now)
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub(crate) fn transaction(&self, now: i64) -> Result<Transaction<'_, S, I>, GatewayError> {
        validate_time(now)?;
        Ok(Transaction {
            store: &self.store,
            tokens: &self.tokens,
            now,
            reads: BTreeMap::new(),
            writes: BTreeMap::new(),
        })
    }
}

/// Only the named local release adapter observes this private read origin.
pub(crate) enum ApiReleaseReadError {
    Backend(GatewayError),
    Record(GatewayError),
}
impl ApiReleaseReadError {
    fn into_error(self) -> GatewayError {
        match self {
            Self::Backend(error) | Self::Record(error) => error,
        }
    }
}
fn decode_json_record<T: DeserializeOwned>(row: &StoredRecord) -> Result<T, GatewayError> {
    serde_json::from_value(row.json_value()?.clone())
        .map_err(|_| invalid("Malformed authority record."))
}

pub(crate) struct Transaction<'a, S, I> {
    store: &'a S,
    tokens: &'a I,
    pub now: i64,
    reads: BTreeMap<String, Option<StoredRecord>>,
    writes: BTreeMap<String, RecordMutation>,
}

impl<S: AuthorityStore, I: TokenSource> Transaction<'_, S, I> {
    async fn cached_record(
        &mut self,
        key: &RecordKey,
    ) -> Result<Option<&StoredRecord>, GatewayError> {
        self.cached_record_classified(key)
            .await
            .map_err(ApiReleaseReadError::into_error)
    }
    async fn cached_record_classified(
        &mut self,
        key: &RecordKey,
    ) -> Result<Option<&StoredRecord>, ApiReleaseReadError> {
        if !self.reads.contains_key(&key.0) {
            let record = self
                .store
                .read(key)
                .await
                .map_err(ApiReleaseReadError::Backend)?;
            if let Some(value) = &record {
                value
                    .validate_version()
                    .map_err(ApiReleaseReadError::Record)?;
                text(&value.revision).map_err(ApiReleaseReadError::Record)?;
                if let Some(expiry) = value.expires_at_ms {
                    validate_time(expiry).map_err(ApiReleaseReadError::Record)?;
                }
            }
            self.reads.insert(key.0.clone(), record);
        }
        let raw = self.reads.get(&key.0).and_then(Option::as_ref);
        if raw.is_some_and(|row| row.expires_at_ms.is_some_and(|expiry| expiry <= self.now)) {
            return Ok(None);
        }
        Ok(raw)
    }
    /// Same read/cache/revision operation as read; only origin is retained for
    /// the finite local-release error adapter. It exposes no mutation or I/O grant.
    pub(crate) async fn read_api_release<T: DeserializeOwned>(
        &mut self,
        key: &RecordKey,
    ) -> Result<Option<T>, ApiReleaseReadError> {
        self.cached_record_classified(key)
            .await?
            .map(|row| decode_json_record(row).map_err(ApiReleaseReadError::Record))
            .transpose()
    }

    /// Establish only the existing cached metadata/revision precondition. This
    /// observes no payload and cannot replace a named family's validation.
    pub(crate) async fn observe_revision(&mut self, key: &RecordKey) -> Result<(), GatewayError> {
        self.cached_record(key).await?;
        Ok(())
    }

    pub async fn read<T: DeserializeOwned>(
        &mut self,
        key: &RecordKey,
    ) -> Result<Option<T>, GatewayError> {
        self.cached_record(key)
            .await?
            .map(decode_json_record)
            .transpose()
    }

    /// Explicit lossless opt-in for named control families. The caller still owns
    /// the exact key, DTO/version and currentness checks; data grants no authority.
    pub(crate) async fn read_source_control<T: DeserializeOwned>(
        &mut self,
        key: &RecordKey,
    ) -> Result<Option<T>, GatewayError> {
        self.cached_record(key)
            .await?
            .map(|row| {
                decode_source_control_record(row)?
                    .deserialize()
                    .map_err(|_| invalid("Malformed authority record."))
            })
            .transpose()
    }

    pub async fn read_claude_quota(
        &mut self,
        account_id: &str,
        cohort_id: &str,
    ) -> Result<Option<SourceJson>, GatewayError> {
        let key = crate::keys::claude_quota(account_id, cohort_id);
        self.cached_record(&key)
            .await?
            .map(|row| match row.value_encoding {
                gateway_core::value::ValueEncoding::ProfileV2 => Ok(
                    crate::claude::quota_proof_metadata(&row.profile_v2_value()?),
                ),
                _ => SourceJson::from_serializable(row.json_value()?),
            })
            .transpose()
    }

    /// Preserve the full source value and custody for this one audit family.
    pub(crate) async fn read_full_pool_reset_audit(
        &mut self,
        episode_hash: &str,
    ) -> Result<Option<StoredRecord>, GatewayError> {
        let key = crate::keys::reset_shadow(episode_hash);
        Ok(self.cached_record(&key).await?.cloned())
    }

    pub fn revision(&self, key: &RecordKey) -> Option<String> {
        self.reads
            .get(&key.0)
            .and_then(Option::as_ref)
            .map(|row| row.revision.clone())
    }

    pub fn expiry(&self, key: &RecordKey) -> Option<i64> {
        self.reads
            .get(&key.0)
            .and_then(Option::as_ref)
            .and_then(|row| row.expires_at_ms)
    }

    pub fn expect(&self, key: &RecordKey, revision: &Option<String>) -> bool {
        self.reads.contains_key(&key.0) && &self.revision(key) == revision
    }

    pub fn checks(&self) -> Vec<RevisionCheck> {
        self.reads
            .iter()
            .map(|(key, record)| RevisionCheck {
                key: RecordKey(key.clone()),
                expected_revision: record.as_ref().map(|row| row.revision.clone()),
            })
            .collect()
    }

    pub fn post_checks(&self) -> Vec<RevisionCheck> {
        self.checks()
            .into_iter()
            .map(|mut check| {
                if let Some(mutation) = self.writes.get(&check.key.0) {
                    check.expected_revision = match mutation {
                        RecordMutation::Put { record, .. } => Some(record.revision.clone()),
                        RecordMutation::Delete { .. } => None,
                    };
                }
                check
            })
            .collect()
    }

    pub fn put<T: Serialize>(
        &mut self,
        key: &RecordKey,
        value: &T,
        expiry: Option<i64>,
    ) -> Result<(), GatewayError> {
        if !self.reads.contains_key(&key.0) {
            return Err(invalid(
                "A mutation is missing its strong-read precondition.",
            ));
        }
        if let Some(expiry) = expiry {
            validate_time(expiry)?;
        }
        let revision = self.tokens.next_token()?;
        text(&revision)?;
        if self
            .reads
            .values()
            .flatten()
            .any(|row| row.revision == revision)
        {
            return Err(invalid("Token source reused an existing revision."));
        }
        let record = StoredRecord::json(
            revision,
            serde_json::to_value(value).map_err(|_| invalid("Authority serialization failed."))?,
            expiry,
        );
        self.writes.insert(
            key.0.clone(),
            RecordMutation::Put {
                key: key.clone(),
                record,
            },
        );
        Ok(())
    }

    /// Same strong-read, revision and expiry contract as `put`, but only explicit
    /// named-family callers choose the finite Json/ProfileV2 source tree codec.
    pub(crate) fn put_source_control<T: Serialize + ?Sized>(
        &mut self,
        key: &RecordKey,
        value: &T,
        expiry: Option<i64>,
    ) -> Result<(), GatewayError> {
        if !self.reads.contains_key(&key.0) {
            return Err(invalid(
                "A mutation is missing its strong-read precondition.",
            ));
        }
        if let Some(expiry) = expiry {
            validate_time(expiry)?;
        }
        let revision = self.tokens.next_token()?;
        text(&revision)?;
        if self
            .reads
            .values()
            .flatten()
            .any(|row| row.revision == revision)
        {
            return Err(invalid("Token source reused an existing revision."));
        }
        let document = SourceJson::from_serializable(value)?;
        let record = encode_source_control_record(revision, &document, expiry)?;
        self.writes.insert(
            key.0.clone(),
            RecordMutation::Put {
                key: key.clone(),
                record,
            },
        );
        Ok(())
    }

    /// The one finite routing-local completion writer. Its data plan fixes both
    /// keys, the only allowed patch, None retention and the :pending revision.
    pub(crate) fn put_local_completed_journal(
        &mut self,
        plan: &gateway_core::local_completion::LocalCompletedJournalPlan,
        now: i64,
    ) -> Result<(), GatewayError> {
        use gateway_core::local_completion::LocalCompletedJournalState;
        let journal_key = plan.journal_key();
        let pending_key = plan.pending_key();
        let journal = self
            .reads
            .get(&journal_key.0)
            .and_then(Option::as_ref)
            .ok_or_else(|| invalid("Local journal has no strong-read precondition."))?;
        let pending = self
            .reads
            .get(&pending_key.0)
            .and_then(Option::as_ref)
            .ok_or_else(|| invalid("Local pending marker has no strong-read precondition."))?;
        if now != self.now
            || journal.revision != plan.expected_revision()
            || journal.expires_at_ms.is_some()
            || pending.expires_at_ms.is_some()
            || pending.revision != format!("{}:pending", journal.revision)
            || *pending.json_value()?
                != serde_json::json!({"request_id":plan.context().request_id.0})
            || plan.classify(&decode_source_control_record(journal)?)?
                != LocalCompletedJournalState::Prepared
            || self.writes.contains_key(&journal_key.0)
            || self.writes.contains_key(&pending_key.0)
        {
            return Err(invalid("Local completion journal custody conflicts."));
        }
        let document = plan.completed_document(now)?;
        self.put_source_control(&journal_key, &document, None)?;
        let Some(RecordMutation::Put { record, .. }) = self.writes.get(&journal_key.0) else {
            return Err(invalid("Local completion journal write is missing."));
        };
        let pending_revision = format!("{}:pending", record.revision);
        text(&pending_revision)?;
        if self
            .reads
            .values()
            .flatten()
            .any(|row| row.revision == pending_revision)
            || self.writes.values().any(|mutation| {
                matches!(mutation,
                RecordMutation::Put { record, .. } if record.revision == pending_revision)
            })
        {
            return Err(invalid("Local completion reused an existing revision."));
        }
        self.writes.insert(
            pending_key.0.clone(),
            RecordMutation::Put {
                key: pending_key,
                record: StoredRecord::json(
                    pending_revision,
                    serde_json::json!({"request_id":plan.context().request_id.0}),
                    None,
                ),
            },
        );
        Ok(())
    }

    pub fn delete(&mut self, key: &RecordKey) -> Result<(), GatewayError> {
        if !self.reads.contains_key(&key.0) {
            return Err(invalid(
                "A deletion is missing its strong-read precondition.",
            ));
        }
        self.writes
            .insert(key.0.clone(), RecordMutation::Delete { key: key.clone() });
        Ok(())
    }

    pub async fn commit(self) -> Result<bool, GatewayError> {
        let checks = self.checks();
        let mut revisions = BTreeSet::new();
        for mutation in self.writes.values() {
            if let RecordMutation::Put { record, .. } = mutation
                && !revisions.insert(record.revision.clone())
            {
                return Err(invalid("Token source duplicated a mutation revision."));
            }
        }
        Ok(self
            .store
            .commit(AtomicTransition {
                checks,
                mutations: self.writes.into_values().collect(),
            })
            .await?
            == CommitOutcome::Committed)
    }
}

#[cfg(test)]
mod source_control_tests;
