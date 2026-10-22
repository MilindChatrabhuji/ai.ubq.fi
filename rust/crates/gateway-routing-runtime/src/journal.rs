//! Recoverable request intent only. Counters, pool state and billing remain m03-owned.
use crate::types::{CredentialFence, RevisionCheckWire};
use gateway_authority::TokenSource;
use gateway_authority::{
    paid::{PaidCorrelation, PaidReservation, PaidUsage},
    quota::{ApiReservation, KernelReservation},
};
use gateway_core::local_work::{LocalWorkRecord, journal_local_work};
use gateway_core::provider::UpstreamProvider;
use gateway_core::{
    GatewayError,
    identity::{PaidAttemptId, RequestContext},
    lifecycle::TransportObservation,
    model::ModelId,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
        StoredRecord,
    },
    tuple_key::{ScalarKeyPart, TupleKey},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Phase {
    Prepared,
    Intent,
    Started,
    Terminal,
    Refused,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct BillingUsage {
    pub quota: f64,
    pub input: i64,
    pub cached: Option<i64>,
    pub output: i64,
    pub provider_request_id: Option<String>,
    pub surplus: Option<(PaidAttemptId, Option<i64>)>,
}
impl BillingUsage {
    pub fn from_usage(usage: &PaidUsage) -> Self {
        let (provider_request_id, surplus) = match &usage.correlation {
            PaidCorrelation::ProviderRequestId(id) => (Some(id.clone()), None),
            PaidCorrelation::SurplusReservation {
                attempt_id,
                buyer_cost_micro,
            } => (None, Some((attempt_id.clone(), *buyer_cost_micro))),
        };
        Self {
            quota: usage.provider_quota,
            input: usage.input_tokens,
            cached: usage.cached_input_tokens,
            output: usage.output_tokens,
            provider_request_id,
            surplus,
        }
    }
    pub fn to_usage(&self) -> Result<PaidUsage, GatewayError> {
        let correlation = match (&self.provider_request_id, &self.surplus) {
            (Some(id), None) => PaidCorrelation::ProviderRequestId(id.clone()),
            (None, Some((attempt_id, buyer_cost_micro))) => PaidCorrelation::SurplusReservation {
                attempt_id: attempt_id.clone(),
                buyer_cost_micro: *buyer_cost_micro,
            },
            _ => return Err(unavailable("Invalid billing correlation.")),
        };
        Ok(PaidUsage {
            provider_quota: self.quota,
            input_tokens: self.input,
            cached_input_tokens: self.cached,
            output_tokens: self.output,
            correlation,
        })
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AttemptRecord {
    pub id: String,
    pub provider: UpstreamProvider,
    pub model: ModelId,
    pub cursor: usize,
    pub fence: CredentialFence,
    pub paid: Option<PaidReservation>,
    pub phase: Phase,
    pub transport_started: bool,
    #[serde(default)]
    pub response_nonce: Option<String>,
    #[serde(default)]
    pub response_count: u8,
    #[serde(default)]
    pub workspace_nonce: Option<String>,
    #[serde(default)]
    pub workspace_continuations: u8,
    pub known_not_started: bool,
    pub observation: Option<TransportObservation>,
    pub provider_request_id: Option<String>,
    pub billing: Option<BillingUsage>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Journal {
    pub v: u32,
    pub context: RequestContext,
    pub input_digest: String,
    pub api: Option<ApiReservation>,
    pub kernel: Option<KernelReservation>,
    pub cursor: usize,
    pub attempts: Vec<AttemptRecord>,
    pub active: Option<String>,
    pub model_sibling_retries: u8,
    pub refreshed_versions: Vec<String>,
    pub recovery_attempted: bool,
    pub claude_unavailable: bool,
    pub semantic_committed: bool,
    pub terminal_intent: Option<TransportObservation>,
    pub finished: bool,
    pub recovering: bool,
    pub lease_expires_at_ms: i64,
    pub updated_at_ms: i64,
    pub extras_family: Option<crate::extras::ExtrasFamily>,
    pub extras_child_count: Option<u32>,
    pub extras_dispatch: Option<crate::extras::ExtraDispatch>,
    pub children: Vec<crate::extras::ChildRecord>,
    pub kernel_override: Option<crate::extras::KernelIntent>,
    /// Legacy v1 omits this field exactly; a v2 local row must carry it completely.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_work: Option<LocalWorkRecord>,
}
impl Journal {
    pub(crate) fn decode(value: &SourceJson) -> Result<Self, GatewayError> {
        let local = journal_local_work(value)?;
        let row: Self = value
            .deserialize()
            .map_err(|_| unavailable("Routing session is corrupt."))?;
        let encoded = SourceJson::from_serializable(&row)
            .map_err(|_| unavailable("Routing session encoding failed."))?;
        if row.local_work != local || !same_source_value(&encoded, value) {
            return Err(unavailable(
                "Routing session has an incomplete or unknown shape.",
            ));
        }
        Ok(row)
    }
}
/// Match the old JSON object equality without scalarizing opaque fields. Array
/// order and scalar number spellings remain significant; object key order does not.
pub(crate) fn same_source_value(left: &SourceJson, right: &SourceJson) -> bool {
    match (
        left.as_str().as_bytes().first(),
        right.as_str().as_bytes().first(),
    ) {
        (Some(b'{'), Some(b'{')) => {
            let (Some(left), Some(right)) = (source::entries(left), source::entries(right)) else {
                return false;
            };
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right
                        .iter()
                        .find(|(name, _)| name == key)
                        .is_some_and(|(_, other)| same_source_value(value, other))
                })
        }
        (Some(b'['), Some(b'[')) => {
            let (Some(left), Some(right)) = (source::array(left), source::array(right)) else {
                return false;
            };
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right.iter())
                    .all(|(left, right)| same_source_value(left, right))
        }
        (Some(b'"'), Some(b'"')) => source::string(left) == source::string(right),
        _ => left.as_str() == right.as_str(),
    }
}

pub fn key(id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("session"),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}
pub fn pending_prefix() -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("pending"),
    ])
    .to_record_key()
}
pub fn pending_key(id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("pending"),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}
pub fn unavailable(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "routing_session_unavailable")
}
pub async fn load<S: AuthorityStore>(
    store: &S,
    id: &str,
) -> Result<(StoredRecord, Journal), GatewayError> {
    let row = store
        .read(&key(id))
        .await?
        .ok_or_else(|| unavailable("Routing session is missing."))?;
    let value = Journal::decode(&decode_source_control_record(&row)?)?;
    if value.context.request_id.0 != id {
        return Err(unavailable("Routing session identity mismatch."));
    }
    Ok((row, value))
}
fn mutations<I: TokenSource>(
    journal: &Journal,
    tokens: &I,
) -> Result<Vec<RecordMutation>, GatewayError> {
    let revision = tokens.next_token()?;
    let expires = if journal.finished {
        Some(
            journal
                .context
                .started_at_ms
                .checked_add(gateway_authority::PAID_RETENTION_MS)
                .ok_or_else(|| unavailable("Routing retention overflow."))?,
        )
    } else {
        None
    };
    let value = SourceJson::from_serializable(journal)
        .map_err(|_| unavailable("Routing journal encoding failed."))?;
    Journal::decode(&value)?;
    let mut rows = vec![RecordMutation::Put {
        key: key(&journal.context.request_id.0),
        record: encode_source_control_record(&revision, &value, expires)?,
    }];
    if journal.finished {
        rows.push(RecordMutation::Delete {
            key: pending_key(&journal.context.request_id.0),
        });
    } else {
        rows.push(RecordMutation::Put {
            key: pending_key(&journal.context.request_id.0),
            record: StoredRecord::json(
                format!("{revision}:pending"),
                serde_json::json!({"request_id":journal.context.request_id.0}),
                None,
            ),
        });
    }
    Ok(rows)
}
pub async fn create<S: AuthorityStore, I: TokenSource>(
    store: &S,
    tokens: &I,
    journal: &Journal,
) -> Result<(), GatewayError> {
    let outcome = store
        .commit(AtomicTransition {
            checks: vec![
                RevisionCheck {
                    key: key(&journal.context.request_id.0),
                    expected_revision: None,
                },
                RevisionCheck {
                    key: pending_key(&journal.context.request_id.0),
                    expected_revision: None,
                },
            ],
            mutations: mutations(journal, tokens)?,
        })
        .await?;
    if outcome != CommitOutcome::Committed {
        return Err(GatewayError::new(
            409,
            "The request identity is already admitted.",
            Some("request_id_consumed"),
        ));
    }
    Ok(())
}
pub async fn change<
    S: AuthorityStore,
    I: TokenSource,
    F: Fn(&mut Journal) -> Result<(), GatewayError>,
>(
    store: &S,
    tokens: &I,
    id: &str,
    now: i64,
    extra: &[RevisionCheckWire],
    update: F,
) -> Result<Journal, GatewayError> {
    for _ in 0..5 {
        let (old, mut journal) = load(store, id).await?;
        update(&mut journal)?;
        journal.updated_at_ms = now;
        let mut checks = vec![RevisionCheck {
            key: key(id),
            expected_revision: Some(old.revision),
        }];
        for extra in extra {
            if let Some(check) = checks.iter().find(|c| c.key == extra.key) {
                if check.expected_revision != extra.expected_revision {
                    return Err(unavailable("The observed source revision changed."));
                }
            } else {
                checks.push(RevisionCheck {
                    key: extra.key.clone(),
                    expected_revision: extra.expected_revision.clone(),
                });
            }
        }
        if store
            .commit(AtomicTransition {
                checks,
                mutations: mutations(&journal, tokens)?,
            })
            .await?
            == CommitOutcome::Committed
        {
            return Ok(journal);
        }
    }
    Err(unavailable("Routing journal changed concurrently."))
}

#[cfg(test)]
mod source_shape_tests {
    use super::*;
    #[test]
    fn source_shape_ignores_object_order_not_array_order_or_opaque_identity() {
        let a =
            SourceJson::parse(r#"{"model":"\ud800","items":[1,2],"nested":{"first":1,"last":2}}"#)
                .unwrap();
        let reordered =
            SourceJson::parse(r#"{"nested":{"last":2,"first":1},"items":[1,2],"model":"\ud800"}"#)
                .unwrap();
        assert!(same_source_value(&a, &reordered));
        let array =
            SourceJson::parse(r#"{"model":"\ud800","items":[2,1],"nested":{"first":1,"last":2}}"#)
                .unwrap();
        assert!(!same_source_value(&a, &array));
        let other =
            SourceJson::parse(r#"{"model":"�","items":[1,2],"nested":{"first":1,"last":2}}"#)
                .unwrap();
        assert!(!same_source_value(&a, &other));
    }
}
