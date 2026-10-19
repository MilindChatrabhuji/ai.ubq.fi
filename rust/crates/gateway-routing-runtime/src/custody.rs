//! Data-only custody of the actual private routing journal. Never mints a runtime capability.
use crate::{
    journal::{self, Journal},
    types::CredentialFence,
};
use gateway_core::{
    GatewayError,
    identity::MAX_SAFE_INTEGER,
    model::ModelId,
    provider::{PaidProvider, UpstreamProvider},
    source_control::decode_source_control_record,
    state::{RecordKey, StoredRecord},
    tuple_key::{DecodedKeyPart, TupleKey},
};
use std::collections::{BTreeMap, BTreeSet};

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Private routing journal custody is invalid.",
        "routing_journal_custody_invalid",
    )
}
fn text(value: &str) -> Result<(), GatewayError> {
    if value.trim().is_empty() {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn model_text(value: &ModelId) -> Result<(), GatewayError> {
    if value.as_js_string().as_units().iter().any(|unit| {
        char::from_u32(u32::from(*unit))
            .is_none_or(|character| !gateway_schema::util::js_whitespace(character))
    }) {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn time(value: i64) -> Result<(), GatewayError> {
    if (0..=MAX_SAFE_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn hash(value: &str) -> Result<(), GatewayError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(invalid())
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct PendingJournal {
    request_id: String,
}

fn pending_identity(key: &RecordKey, record: &StoredRecord) -> Result<String, GatewayError> {
    let value = record.json_value()?;
    let row: PendingJournal = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    text(&row.request_id)?;
    text(&record.revision)?;
    if serde_json::to_value(&row).map_err(|_| invalid())? != *value
        || journal::pending_key(&row.request_id) != *key
        || record.expires_at_ms.is_some()
    {
        return Err(invalid());
    }
    Ok(row.request_id)
}

/// Validate the existing writer's pending marker against its actual complete
/// session. A marker alone is neither valid custody nor runtime permission.
pub fn validate_pending_journal_row(
    pending_key: &RecordKey,
    pending: &StoredRecord,
    session_key: &RecordKey,
    session: &StoredRecord,
) -> Result<(), GatewayError> {
    let id = pending_identity(pending_key, pending)?;
    validate_journal_row(session_key, session)?;
    let row = Journal::decode(&decode_source_control_record(session)?).map_err(|_| invalid())?;
    if row.finished
        || row.context.request_id.0 != id
        || session_key != &journal::key(&id)
        || pending.revision != format!("{}:pending", session.revision)
    {
        return Err(invalid());
    }
    Ok(())
}

/// Validate the COMPLETE frozen routing-runtime prefix, including both session
/// and pending rows. Empty pre-runtime captures are valid; missing, duplicate,
/// orphaned, unknown and malformed rows fail closed. No time or lease is renewed.
pub fn validate_journal_rows<'a>(
    rows: impl IntoIterator<Item = (&'a RecordKey, &'a StoredRecord)>,
) -> Result<(), GatewayError> {
    let mut sessions = BTreeMap::new();
    let mut pending = BTreeMap::new();
    for (key, record) in rows {
        let tuple = TupleKey::from_record_key(key)?;
        tuple.validate_stored_key()?;
        let parts = tuple.decoded_parts()?;
        let [
            DecodedKeyPart::String(namespace),
            DecodedKeyPart::String(runtime),
            DecodedKeyPart::String(version),
            DecodedKeyPart::String(kind),
            DecodedKeyPart::String(id),
        ] = parts.as_slice()
        else {
            return Err(invalid());
        };
        if namespace.as_slice() != b"uos_ai"
            || runtime.as_slice() != b"routing_runtime"
            || version.as_slice() != b"v1"
        {
            return Err(invalid());
        }
        let id = std::str::from_utf8(id).map_err(|_| invalid())?.to_owned();
        text(&id)?;
        let previous = match kind.as_slice() {
            b"session" => {
                validate_journal_row(key, record)?;
                sessions.insert(id, (key, record))
            }
            b"pending" => {
                if pending_identity(key, record)? != id {
                    return Err(invalid());
                }
                pending.insert(id, (key, record))
            }
            _ => return Err(invalid()),
        };
        if previous.is_some() {
            return Err(invalid());
        }
    }
    for (id, (key, record)) in sessions {
        let row = Journal::decode(&decode_source_control_record(record)?).map_err(|_| invalid())?;
        match (row.finished, pending.remove(&id)) {
            (true, None) => {}
            (false, Some((pending_key, pending))) => {
                validate_pending_journal_row(pending_key, pending, key, record)?;
            }
            _ => return Err(invalid()),
        }
    }
    if !pending.is_empty() {
        return Err(invalid());
    }
    Ok(())
}

/// Validate the complete current stored schema without returning a Journal,
/// admission or proof. Absolute expiry is checked, not renewed or interpreted as live.
pub fn validate_journal_row(key: &RecordKey, record: &StoredRecord) -> Result<(), GatewayError> {
    let value = decode_source_control_record(record)?;
    text(&record.revision)?;
    TupleKey::from_record_key(key)?.validate_stored_key()?;
    let row = Journal::decode(&value).map_err(|_| invalid())?;
    // Option/default fields and unknown nested members may not be silently lost
    // during private rollback. This is the current writer's full exact shape.
    // Journal::decode owns complete shape equality and the ONE shared phase/version parser.
    if journal::key(&row.context.request_id.0) != *key {
        return Err(invalid());
    }
    text(&row.context.request_id.0)?;
    text(&row.context.principal.0)?;
    text(&row.context.route)?;
    if let Some(key) = &row.context.key_id {
        text(&key.0)?;
    }
    hash(&row.input_digest)?;
    for value in [
        row.context.started_at_ms,
        row.updated_at_ms,
        row.lease_expires_at_ms,
    ] {
        time(value)?;
    }
    if row.updated_at_ms < row.context.started_at_ms
        || row.lease_expires_at_ms < row.context.started_at_ms
    {
        return Err(invalid());
    }
    let expected_expiry = if row.finished {
        Some(
            row.context
                .started_at_ms
                .checked_add(gateway_authority::PAID_RETENTION_MS)
                .ok_or_else(invalid)?,
        )
    } else {
        None
    };
    if record.expires_at_ms != expected_expiry {
        return Err(invalid());
    }
    if let Some(expiry) = expected_expiry {
        time(expiry)?;
    }
    if let Some(api) = &row.api {
        if row.context.key_id.as_ref() != Some(&api.key_id)
            || api.request_id != row.context.request_id
            || api.route != row.context.route
        {
            return Err(invalid());
        }
        text(&api.policy_version)?;
        time(api.window_start_ms)?;
        time(api.window_reset_at_ms)?;
    }
    if let Some(kernel) = &row.kernel {
        kernel.validate()?;
        if kernel.request_id != row.context.request_id || kernel.route != row.context.route {
            return Err(invalid());
        }
        text(&kernel.owner)?;
        for value in [
            kernel.window_created_at_ms,
            kernel.window_reset_at_ms,
            kernel.reserved_at_ms,
            kernel.lease_expires_at_ms,
        ] {
            time(value)?;
        }
        if let Some(value) = kernel.terminal_at_ms {
            time(value)?;
        }
    }
    let mut attempts = BTreeSet::new();
    for attempt in &row.attempts {
        text(&attempt.id)?;
        model_text(&attempt.model)?;
        if !attempts.insert(&attempt.id) || (attempt.known_not_started && attempt.transport_started)
        {
            return Err(invalid());
        }
        match &attempt.fence {
            CredentialFence::Direct { provider } if *provider != attempt.provider => {
                return Err(invalid());
            }
            CredentialFence::Direct { .. } => {}
            CredentialFence::Paid {
                provider,
                owner_id,
                owner_epoch,
                configuration_generation,
                credential_binding,
            } => {
                if *provider != attempt.provider
                    || !matches!(
                        provider,
                        UpstreamProvider::Surplus | UpstreamProvider::Metered
                    )
                {
                    return Err(invalid());
                }
                for value in [
                    owner_id,
                    owner_epoch,
                    configuration_generation,
                    credential_binding,
                ] {
                    text(value)?;
                }
            }
            CredentialFence::Codex {
                admission,
                source_key,
                source_revision,
                native_generation,
            } => {
                if attempt.provider != UpstreamProvider::ChatgptCodex
                    || admission.requested_model != attempt.model
                {
                    return Err(invalid());
                }
                TupleKey::from_record_key(source_key)?.validate_stored_key()?;
                if *source_key != gateway_auth::provider_credentials::codex_source_pool_key()
                    || admission.binding.pool_versionstamp.0 != *source_revision
                {
                    return Err(invalid());
                }
                for value in [
                    admission.binding.slot,
                    admission.binding.routing_generation,
                    admission.active_generation,
                ] {
                    time(i64::try_from(value).map_err(|_| invalid())?)?;
                }
                hash(&admission.binding.account_id_hash.0)?;
                hash(&admission.binding.credential_version.0)?;
                text(&admission.binding.pool_versionstamp.0)?;
                text(source_revision)?;
                hash(native_generation)?;
                if let Some(probe) = &admission.probe {
                    text(&probe.token)?;
                    time(probe.generation)?;
                    time(probe.expires_at_ms)?;
                }
            }
            CredentialFence::Claude {
                account_id,
                cohort_id,
                credential_fingerprint,
                evidence_generation,
                workspace_id,
                checks,
            } => {
                if attempt.provider != UpstreamProvider::ClaudeCode {
                    return Err(invalid());
                }
                for value in [
                    account_id,
                    cohort_id,
                    credential_fingerprint,
                    evidence_generation,
                ] {
                    text(value)?;
                }
                if let Some(value) = workspace_id
                    && !char::decode_utf16(value.as_units().iter().copied()).any(|unit| {
                        unit.is_err() || unit.is_ok_and(|character| !character.is_whitespace())
                    })
                {
                    return Err(invalid());
                }
                for check in checks {
                    TupleKey::from_record_key(&check.key)?.validate_stored_key()?;
                    if let Some(value) = &check.expected_revision {
                        text(value)?;
                    }
                }
            }
        }
        if let Some(paid) = &attempt.paid {
            let provider = match paid.provider {
                PaidProvider::Surplus => UpstreamProvider::Surplus,
                PaidProvider::Metered => UpstreamProvider::Metered,
            };
            if provider != attempt.provider || row.context.key_id.as_ref() != Some(&paid.key_id) {
                return Err(invalid());
            }
            text(&paid.request_id.0)?;
            text(&paid.attempt_id.0)?;
            for value in [
                paid.window_reset_at_ms,
                paid.created_at_ms,
                paid.reserved_microcredits,
            ] {
                time(value)?;
            }
        }
        if let Some(billing) = &attempt.billing {
            billing.to_usage()?;
            if !billing.quota.is_finite() || billing.quota < 0.0 {
                return Err(invalid());
            }
            time(billing.input)?;
            time(billing.output)?;
            if let Some(value) = billing.cached {
                time(value)?;
            }
            if let Some(value) = &billing.provider_request_id {
                text(value)?;
            }
            if let Some((attempt, cost)) = &billing.surplus {
                text(&attempt.0)?;
                if let Some(cost) = cost {
                    time(*cost)?;
                }
            }
        }
    }
    if row.active.as_ref().is_some_and(|id| !attempts.contains(id)) {
        return Err(invalid());
    }
    let mut nonces = BTreeSet::new();
    for child in &row.children {
        text(&child.nonce)?;
        text(&child.request_id)?;
        if !nonces.insert(&child.nonce) || (child.known_not_started && child.transport_started) {
            return Err(invalid());
        }
    }
    if let Some(dispatch) = &row.extras_dispatch {
        text(&dispatch.nonce)?;
    }
    for version in &row.refreshed_versions {
        text(version)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gateway_authority::TokenSource;
    use gateway_core::{
        identity::{PrincipalId, RequestContext, RequestId},
        local_work::{
            LocalSemanticOutcome, LocalTerminalObservation, LocalWorkKind, LocalWorkPhase,
            LocalWorkRecord, SOURCE_REQUEST_BINDING_VERSION,
        },
        state::{AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation},
    };
    use serde_json::json;
    use std::{
        cell::{Cell, RefCell},
        future::Future,
        task::{Context, Poll, Waker},
    };

    #[derive(Default)]
    struct Writer {
        rows: RefCell<BTreeMap<String, StoredRecord>>,
        sequence: Cell<u64>,
    }
    impl TokenSource for Writer {
        fn next_token(&self) -> Result<String, GatewayError> {
            self.sequence.set(self.sequence.get() + 1);
            Ok(format!("actual-writer-{}", self.sequence.get()))
        }
    }
    impl AuthorityStore for Writer {
        async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
            Ok(self.rows.borrow().get(&key.0).cloned())
        }
        async fn commit(
            &self,
            transition: AtomicTransition,
        ) -> Result<CommitOutcome, GatewayError> {
            let mut rows = self.rows.borrow_mut();
            for check in transition.checks {
                if rows.get(&check.key.0).map(|row| &row.revision)
                    != check.expected_revision.as_ref()
                {
                    return Ok(CommitOutcome::Conflict);
                }
            }
            for mutation in transition.mutations {
                match mutation {
                    RecordMutation::Put { key, record } => {
                        rows.insert(key.0, record);
                    }
                    RecordMutation::Delete { key } => {
                        rows.remove(&key.0);
                    }
                }
            }
            Ok(CommitOutcome::Committed)
        }
    }
    fn run<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(result) => result,
            Poll::Pending => panic!("in-memory journal writer unexpectedly suspended"),
        }
    }

    fn writer_rows(version: u32) -> (Writer, Vec<(RecordKey, StoredRecord)>) {
        let writer = Writer::default();
        let (_, record) = row(false);
        let mut model = Journal::decode(
            &gateway_core::source_json::SourceJson::from_serializable(&record.value).unwrap(),
        )
        .unwrap();
        model.v = version;
        if version == 2 {
            model.local_work = Some(LocalWorkRecord {
                kind: LocalWorkKind::CodexResponsesCompaction,
                owner_nonce: "fixture-local-owner".into(),
                binding_version: SOURCE_REQUEST_BINDING_VERSION,
                phase: LocalWorkPhase::Running,
                terminal: None,
            });
        }
        run(journal::create(&writer, &writer, &model)).unwrap();
        let records = writer
            .rows
            .borrow()
            .iter()
            .map(|(key, value)| (RecordKey(key.clone()), value.clone()))
            .collect();
        (writer, records)
    }

    fn row(finished: bool) -> (RecordKey, StoredRecord) {
        let journal = Journal {
            v: 1,
            context: RequestContext {
                request_id: RequestId("custody-request".into()),
                principal: PrincipalId("fixture-principal".into()),
                key_id: None,
                route: "responses".into(),
                started_at_ms: 1_800_000_000_000,
            },
            input_digest: gateway_auth::crypto::sha256_hex(b"{}"),
            api: None,
            kernel: None,
            cursor: 0,
            attempts: vec![],
            active: None,
            model_sibling_retries: 0,
            refreshed_versions: vec![],
            recovery_attempted: false,
            claude_unavailable: false,
            semantic_committed: false,
            terminal_intent: finished.then(Default::default),
            finished,
            recovering: false,
            lease_expires_at_ms: 1_800_000_060_000,
            updated_at_ms: 1_800_000_000_000,
            extras_family: None,
            extras_child_count: None,
            extras_dispatch: None,
            children: vec![],
            kernel_override: None,
            local_work: None,
        };
        let expiry = finished
            .then_some(journal.context.started_at_ms + gateway_authority::PAID_RETENTION_MS);
        (
            journal::key(&journal.context.request_id.0),
            StoredRecord::json(
                "fixture-revision",
                serde_json::to_value(journal).unwrap(),
                expiry,
            ),
        )
    }

    #[test]
    fn exact_current_writer_shape_and_absolute_retention_roundtrip() {
        for finished in [false, true] {
            let (key, record) = row(finished);
            let original = record.clone();
            validate_journal_row(&key, &record).unwrap();
            assert_eq!(record, original);
        }
    }

    #[test]
    fn partial_unknown_or_mismatched_journal_is_not_silently_rewritten() {
        let (key, record) = row(false);
        for mutation in ["missing", "unknown", "nested", "digest", "identity"] {
            let mut bad = record.clone();
            match mutation {
                "missing" => {
                    bad.value.as_object_mut().unwrap().remove("api");
                }
                "unknown" => {
                    bad.value["caller_permission"] = json!(true);
                }
                "nested" => {
                    bad.value["context"]["caller_permission"] = json!(true);
                }
                "digest" => {
                    bad.value["input_digest"] = json!("partial");
                }
                _ => {
                    bad.value["context"]["request_id"] = json!("other");
                }
            }
            assert!(validate_journal_row(&key, &bad).is_err(), "{mutation}");
        }
        assert!(validate_journal_row(&journal::key("other"), &record).is_err());
    }

    #[test]
    fn custody_never_refreshes_or_accepts_wrong_finished_expiry() {
        for finished in [false, true] {
            let (key, mut record) = row(finished);
            record.expires_at_ms = if finished {
                record.expires_at_ms.map(|at| at + 1)
            } else {
                Some(1_800_000_060_000)
            };
            assert!(validate_journal_row(&key, &record).is_err());
        }
    }

    #[test]
    fn actual_writer_emits_coupled_pending_pairs_and_deletes_them_at_finish() {
        assert!(validate_journal_rows(std::iter::empty()).is_ok());
        for version in [1, 2] {
            let (writer, records) = writer_rows(version);
            assert_eq!(records.len(), 2);
            validate_journal_rows(records.iter().map(|(key, record)| (key, record))).unwrap();
            println!(
                "ROUTING_WRITER_CUSTODY_FIXTURE={}",
                json!({"v": version, "rows": records.iter().map(|(key, record)| json!({"key":key.0,"record":record})).collect::<Vec<_>>()})
            );
            run(journal::change(
                &writer,
                &writer,
                "custody-request",
                1_800_000_000_001,
                &[],
                |row| {
                    row.finished = true;
                    if let Some(local) = &mut row.local_work {
                        local.phase = LocalWorkPhase::Terminal;
                        local.terminal = Some(LocalTerminalObservation {
                            semantic: LocalSemanticOutcome::Incomplete,
                            reader_termination: None,
                            body: None,
                            delivery: gateway_core::lifecycle::DeliveryOutcome::Unobserved,
                        });
                    } else {
                        row.terminal_intent = Some(Default::default());
                    }
                    Ok(())
                },
            ))
            .unwrap();
            let finished = writer.rows.borrow();
            assert_eq!(finished.len(), 1);
            println!(
                "ROUTING_WRITER_CUSTODY_FIXTURE={}",
                json!({"v": version, "phase": "finished", "rows": finished.iter().map(|(key, record)| json!({"key":key,"record":record})).collect::<Vec<_>>()})
            );
            let session = finished.get(&journal::key("custody-request").0).unwrap();
            assert_eq!(
                session.expires_at_ms,
                Some(1_800_000_000_000 + gateway_authority::PAID_RETENTION_MS)
            );
            validate_journal_rows(
                finished
                    .iter()
                    .map(|(key, record)| (RecordKey(key.clone()), record.clone()))
                    .collect::<Vec<_>>()
                    .iter()
                    .map(|(key, record)| (key, record)),
            )
            .unwrap();
        }
    }

    #[test]
    fn full_set_custody_refuses_malformed_missing_duplicate_and_orphan_pending() {
        for version in [1, 2] {
            let (_, records) = writer_rows(version);
            let session = records
                .iter()
                .find(|(key, _)| *key == journal::key("custody-request"))
                .unwrap()
                .clone();
            let pending = records
                .iter()
                .find(|(key, _)| *key == journal::pending_key("custody-request"))
                .unwrap()
                .clone();
            for mutation in [
                "revision",
                "ttl",
                "unknown",
                "missing_id",
                "wrong_id",
                "wrong_key",
                "wrong_encoding",
                "wrong_schema",
                "finished",
            ] {
                let mut a = session.clone();
                let mut b = pending.clone();
                match mutation {
                    "revision" => b.1.revision.push_str("-stale"),
                    "ttl" => b.1.expires_at_ms = Some(1_800_000_060_000),
                    "unknown" => b.1.value["permission"] = json!(true),
                    "missing_id" => {
                        b.1.value.as_object_mut().unwrap().remove("request_id");
                    }
                    "wrong_id" => b.1.value["request_id"] = json!("other"),
                    "wrong_key" => b.0 = journal::pending_key("other"),
                    "wrong_encoding" => {
                        b.1.value_encoding = gateway_core::value::ValueEncoding::ProfileV2
                    }
                    "wrong_schema" => b.1.schema_version += 1,
                    _ => {
                        let (key, record) = row(true);
                        a = (key, record);
                    }
                }
                assert!(
                    validate_pending_journal_row(&b.0, &b.1, &a.0, &a.1).is_err(),
                    "{mutation}"
                );
                assert!(
                    validate_journal_rows([(&a.0, &a.1), (&b.0, &b.1)]).is_err(),
                    "{mutation}"
                );
            }
            for bad in [
                vec![session.clone()],
                vec![pending.clone()],
                vec![session.clone(), pending.clone(), pending.clone()],
                vec![session.clone(), session.clone(), pending.clone()],
            ] {
                assert!(
                    validate_journal_rows(bad.iter().map(|(key, record)| (key, record))).is_err()
                );
            }
            let unknown = TupleKey::from_scalar_parts(&[
                gateway_core::tuple_key::ScalarKeyPart::String("uos_ai"),
                gateway_core::tuple_key::ScalarKeyPart::String("routing_runtime"),
            ])
            .to_record_key();
            assert!(validate_journal_rows([(&unknown, &pending.1)]).is_err());
        }
    }
}
