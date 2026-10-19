//! Finite data-only local-completion patch. This never constructs a live runtime handle.
use crate::{
    GatewayError,
    identity::{MAX_SAFE_INTEGER, RequestContext},
    js_string::JsString16,
    lifecycle::DeliveryOutcome,
    local_work::{
        LocalSemanticOutcome, LocalTerminalObservation, LocalWorkPhase, journal_local_work,
    },
    source_control::decode_source_control_record,
    source_json::SourceJson,
    source_serialization as source,
    state::{RecordKey, StoredRecord},
    tuple_key::{ScalarKeyPart, TupleKey},
};

/// Prepared only after the runtime's complete Journal decoder and genuine owned
/// success boundary. Validating this data does not establish either of those facts.
pub struct LocalCompletedJournalPlan {
    context: RequestContext,
    revision: String,
    before: SourceJson,
    completed: SourceJson,
    chosen_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalCompletedJournalState {
    Prepared,
    Applied,
    Conflict,
}

impl LocalCompletedJournalPlan {
    pub fn prepare(
        record: &StoredRecord,
        context: &RequestContext,
        input_digest: &str,
        owner_nonce: &str,
        chosen_at_ms: i64,
    ) -> Result<Self, GatewayError> {
        let before = decode_source_control_record(record)?;
        let mut local = journal_local_work(&before)?.ok_or_else(invalid)?;
        if record.revision.trim().is_empty()
            || record.expires_at_ms.is_some()
            || !valid_time(chosen_at_ms)
            || chosen_at_ms < context.started_at_ms
            || context.request_id.0.trim().is_empty()
            || source::member(&before, "context")
                .and_then(|value| value.deserialize::<RequestContext>().ok())
                .as_ref()
                != Some(context)
            || source::member(&before, "input_digest").and_then(|value| source::string(&value))
                != Some(JsString16::from_utf8(input_digest))
            || local.owner_nonce != owner_nonce
            || !is(&before, "finished", "false")
            || !is(&before, "recovering", "false")
            || !matches!(
                local.phase,
                LocalWorkPhase::Running | LocalWorkPhase::ResponsePending
            )
            || local.terminal.is_some()
        {
            return Err(invalid());
        }
        local.phase = LocalWorkPhase::TerminalPending;
        local.terminal = Some(LocalTerminalObservation {
            semantic: LocalSemanticOutcome::Completed,
            reader_termination: None,
            body: None,
            delivery: DeliveryOutcome::Unobserved,
        });
        let completed = replace(
            &before,
            "local_work",
            SourceJson::from_serializable(&local)?,
        )?;
        journal_local_work(&completed)?;
        Ok(Self {
            context: context.clone(),
            revision: record.revision.clone(),
            before,
            completed,
            chosen_at_ms,
        })
    }

    pub fn context(&self) -> &RequestContext {
        &self.context
    }
    pub fn expected_revision(&self) -> &str {
        &self.revision
    }
    pub fn original_document(&self) -> &SourceJson {
        &self.before
    }
    pub fn journal_key(&self) -> RecordKey {
        family_key("session", &self.context.request_id.0)
    }
    pub fn pending_key(&self) -> RecordKey {
        family_key("pending", &self.context.request_id.0)
    }

    /// Only the fixed completion patch and existing update timestamp are writable.
    pub fn completed_document(&self, now: i64) -> Result<SourceJson, GatewayError> {
        if !valid_time(now) || now < self.chosen_at_ms {
            return Err(invalid());
        }
        replace(
            &self.completed,
            "updated_at_ms",
            SourceJson::from_serializable(&now)?,
        )
    }

    /// Reconciliation compares every original field. Only the operation's own
    /// timestamp may differ; a later unrelated journal mutation is a conflict.
    pub fn classify(
        &self,
        current: &SourceJson,
    ) -> Result<LocalCompletedJournalState, GatewayError> {
        journal_local_work(current)?;
        if same_value(&self.before, current) {
            return Ok(LocalCompletedJournalState::Prepared);
        }
        let Some(at) = source::member(current, "updated_at_ms")
            .and_then(|value| value.deserialize::<i64>().ok())
        else {
            return Ok(LocalCompletedJournalState::Conflict);
        };
        if valid_time(at)
            && at >= self.chosen_at_ms
            && same_value(&self.completed_document(at)?, current)
        {
            Ok(LocalCompletedJournalState::Applied)
        } else {
            Ok(LocalCompletedJournalState::Conflict)
        }
    }
}

fn family_key(family: &str, request_id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String(family),
        ScalarKeyPart::String(request_id),
    ])
    .to_record_key()
}
fn valid_time(at: i64) -> bool {
    (0..=MAX_SAFE_INTEGER).contains(&at)
}
fn is(value: &SourceJson, key: &str, expected: &str) -> bool {
    source::member(value, key).is_some_and(|value| value.as_str() == expected)
}
fn replace(
    value: &SourceJson,
    name: &str,
    replacement: SourceJson,
) -> Result<SourceJson, GatewayError> {
    let name = JsString16::from_utf8(name);
    let mut fields = value.object_entries()?;
    let mut found = false;
    for (key, value) in &mut fields {
        if key == &name {
            *value = replacement.clone();
            found = true;
        }
    }
    if !found {
        return Err(invalid());
    }
    source::object_keys(fields)
}
fn same_value(left: &SourceJson, right: &SourceJson) -> bool {
    match (left.as_bytes().first(), right.as_bytes().first()) {
        (Some(b'{'), Some(b'{')) => {
            let (Some(left), Some(right)) = (source::entries(left), source::entries(right)) else {
                return false;
            };
            left.len() == right.len()
                && left.iter().all(|(name, value)| {
                    right
                        .iter()
                        .find(|(key, _)| key == name)
                        .is_some_and(|(_, other)| same_value(value, other))
                })
        }
        (Some(b'['), Some(b'[')) => {
            let (Some(left), Some(right)) = (source::array(left), source::array(right)) else {
                return false;
            };
            left.len() == right.len() && left.iter().zip(&right).all(|(a, b)| same_value(a, b))
        }
        (Some(b'"'), Some(b'"')) => source::string(left) == source::string(right),
        _ => left == right,
    }
}
fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Local completion plan is invalid.",
        "local_completion_plan_invalid",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity::{PrincipalId, RequestId},
        source_control::encode_source_control_record,
        value::ValueEncoding,
    };

    // Data-factory fixtures are deliberately not evidence of a live runtime handle.
    fn fixture() -> (RequestContext, SourceJson) {
        let context = RequestContext {
            request_id: RequestId("original".into()),
            principal: PrincipalId("principal".into()),
            key_id: None,
            route: "responses".into(),
            started_at_ms: 10,
        };
        let document = SourceJson::from_serializable(&serde_json::json!({
            "v":2,"context":context,"input_digest":"digest","api":null,"kernel":null,
            "attempts":[],"active":null,"semantic_committed":false,"terminal_intent":null,
            "finished":false,"recovering":false,"updated_at_ms":20,
            "extras_family":null,"extras_child_count":null,"extras_dispatch":null,"kernel_override":null,"children":[],
            "local_work":{"kind":"codex_responses_compaction","owner_nonce":"owner","binding_version":2,"phase":"running","terminal":null}
        })).unwrap();
        (context, document)
    }
    fn prepare(
        context: &RequestContext,
        document: &SourceJson,
    ) -> Result<LocalCompletedJournalPlan, GatewayError> {
        LocalCompletedJournalPlan::prepare(
            &encode_source_control_record("old", document, None)?,
            context,
            "digest",
            "owner",
            30,
        )
    }
    #[test]
    fn finite_patch_preserves_source_fields_and_existing_scalar_codec() {
        let (context, before) = fixture();
        let plan = prepare(&context, &before).unwrap();
        assert_eq!(
            plan.classify(&before).unwrap(),
            LocalCompletedJournalState::Prepared
        );
        let after = plan.completed_document(50).unwrap();
        assert_eq!(
            plan.classify(&after).unwrap(),
            LocalCompletedJournalState::Applied
        );
        let local = journal_local_work(&after).unwrap().unwrap();
        assert_eq!(local.phase, LocalWorkPhase::TerminalPending);
        assert_eq!(
            local.terminal.unwrap(),
            LocalTerminalObservation {
                semantic: LocalSemanticOutcome::Completed,
                reader_termination: None,
                body: None,
                delivery: DeliveryOutcome::Unobserved
            }
        );
        let raw = encode_source_control_record("next", &after, None).unwrap();
        assert_eq!(raw.value_encoding, ValueEncoding::Json);
        assert_eq!(
            plan.classify(&decode_source_control_record(&raw).unwrap())
                .unwrap(),
            LocalCompletedJournalState::Applied
        );
        for (key, value) in before.object_entries().unwrap() {
            let name = key.try_utf8().unwrap();
            if !matches!(name.as_str(), "local_work" | "updated_at_ms") {
                assert!(same_value(&value, &source::member(&after, &name).unwrap()));
            }
        }
    }
    #[test]
    fn finite_data_codec_never_scalarizes_unrelated_lone_units() {
        let (context, before) = fixture();
        let text = before
            .as_str()
            .replacen('{', r#"{"opaque":{"\ud800":"\udc00"},"#, 1);
        let source = SourceJson::parse(&text).unwrap();
        let plan = prepare(&context, &source).unwrap();
        let after = plan.completed_document(50).unwrap();
        let raw = encode_source_control_record("next", &after, None).unwrap();
        assert_eq!(raw.value_encoding, ValueEncoding::ProfileV2);
        let actual = decode_source_control_record(&raw).unwrap();
        assert!(same_value(
            &source::member(&source, "opaque").unwrap(),
            &source::member(&actual, "opaque").unwrap()
        ));
        assert_eq!(
            plan.classify(&actual).unwrap(),
            LocalCompletedJournalState::Applied
        );
    }
    #[test]
    fn changed_original_phase_or_recovery_never_mints_a_patch() {
        let (context, before) = fixture();
        for (field, value) in [
            ("recovering", "true"),
            ("finished", "true"),
            ("input_digest", r#""foreign""#),
            ("context", "null"),
        ] {
            assert!(
                prepare(
                    &context,
                    &replace(&before, field, SourceJson::parse(value).unwrap()).unwrap()
                )
                .is_err(),
                "{field}"
            );
        }
        let mut wrong = context.clone();
        wrong.request_id = RequestId("other".into());
        assert!(prepare(&wrong, &before).is_err());
        let plan = prepare(&context, &before).unwrap();
        let changed = replace(
            &plan.completed_document(50).unwrap(),
            "recovering",
            SourceJson::parse("true").unwrap(),
        )
        .unwrap();
        assert_eq!(
            plan.classify(&changed).unwrap(),
            LocalCompletedJournalState::Conflict
        );
        assert!(plan.completed_document(29).is_err());
    }
}
