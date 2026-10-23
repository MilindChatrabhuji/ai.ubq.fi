use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

use gateway_core::{
    GatewayError,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
        StoredRecord,
    },
    tuple_key::{ScalarKeyPart, TupleKey},
};
use serde_json::json;

use crate::types::LIVE_CALL_ACCOUNT_TTL_MS;

pub(crate) struct State<S> {
    pub store: Rc<S>,
    next_revision: Rc<dyn Fn() -> Result<String, GatewayError>>,
    pending: RefCell<BTreeMap<String, Pending>>,
}

pub struct LiveRuntime<S> {
    pub(crate) state: Rc<State<S>>,
}
impl<S> Clone for LiveRuntime<S> {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
        }
    }
}

#[derive(Clone)]
struct Pending {
    status: u16,
    created_at_ms: i64,
}

pub(crate) struct Mapping {
    pub account_id: String,
    pub principal_id: Option<String>,
}

pub fn mapping_key(call_id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("codex_live_calls"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String(call_id),
    ])
    .to_record_key()
}

/// Private control custody, retained until known mapping deletion. M20 must preserve this marker.
pub fn retirement_key(call_id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("codex_live_calls"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("pending_retirement"),
        ScalarKeyPart::String(call_id),
    ])
    .to_record_key()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetirementOutcome {
    NotTerminal,
    Retired,
    /// Marker persists; originating operation retries at250ms only while actually alive.
    Pending,
    /// Storage cannot establish the effect. Never label this retired or clear the local guard.
    Unknown,
}

/// Minted ONLY with a prepared authorized sideband. No public constructor or serde implementation.
pub struct Retirement<S> {
    pub(crate) runtime: LiveRuntime<S>,
    pub(crate) call_id: String,
}

impl<S: AuthorityStore> Retirement<S> {
    /// The trusted physical bridge calls this only for its ACTUAL upstream handshake response.
    pub async fn on_handshake_rejection(&self, status: u16, now_ms: i64) -> RetirementOutcome {
        if status != 404 && status != 410 {
            return RetirementOutcome::NotTerminal;
        }
        self.runtime
            .state
            .pending
            .borrow_mut()
            .entry(self.call_id.clone())
            .or_insert(Pending {
                status,
                created_at_ms: now_ms,
            });
        self.runtime.retire_once(&self.call_id).await
    }

    pub async fn retry_once(&self) -> RetirementOutcome {
        self.runtime.retire_once(&self.call_id).await
    }
}

impl<S: AuthorityStore> LiveRuntime<S> {
    fn revision(&self) -> Result<String, GatewayError> {
        let revision = (self.state.next_revision)()?;
        if revision.is_empty() {
            return Err(GatewayError::unavailable(
                "Live state revision is unavailable.",
                "live_revision_unavailable",
            ));
        }
        Ok(revision)
    }

    /// The injected store is the SAME existing authority, never a new live ledger.
    pub fn new(store: Rc<S>, next_revision: Rc<dyn Fn() -> Result<String, GatewayError>>) -> Self {
        Self {
            state: Rc::new(State {
                store,
                next_revision,
                pending: RefCell::new(BTreeMap::new()),
            }),
        }
    }

    pub(crate) async fn write_mapping(
        &self,
        call_id: &str,
        account: &str,
        principal: &str,
        now: i64,
    ) {
        // Deliberately best-effort and unconditional. Never clears a pending-retirement marker.
        let Ok(revision) = self.revision() else {
            return;
        };
        let record = StoredRecord::json(
            revision,
            json!({"account_id":account,"principal_id":principal,"created_at_ms":now}),
            Some(now.saturating_add(LIVE_CALL_ACCOUNT_TTL_MS)),
        );
        let _ = self
            .state
            .store
            .commit(AtomicTransition {
                checks: vec![],
                mutations: vec![RecordMutation::Put {
                    key: mapping_key(call_id),
                    record,
                }],
            })
            .await;
    }

    pub(crate) async fn read_mapping(&self, call_id: &str, now: i64) -> Option<Mapping> {
        let marker = self.state.store.read(&retirement_key(call_id)).await.ok()?;
        if marker.is_some() || self.state.pending.borrow().contains_key(call_id) {
            // Related authenticated request event resumes ONE step; no background scheduler.
            self.retire_once(call_id).await;
            return None;
        }
        let record = self.state.store.read(&mapping_key(call_id)).await.ok()??;
        // Suppress a retirement started while the mapping read was awaiting, also after restart.
        if self.state.pending.borrow().contains_key(call_id)
            || self
                .state
                .store
                .read(&retirement_key(call_id))
                .await
                .ok()?
                .is_some()
        {
            return None;
        }
        if record.expires_at_ms.is_some_and(|expiry| expiry <= now) {
            return None;
        }
        let value = record.json_value().ok()?;
        Some(Mapping {
            account_id: value.get("account_id")?.as_str()?.into(),
            principal_id: value
                .get("principal_id")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
        })
    }

    async fn retire_once(&self, call_id: &str) -> RetirementOutcome {
        let key = retirement_key(call_id);
        let mut marker = match self.state.store.read(&key).await {
            Ok(value) => value,
            Err(_) => return RetirementOutcome::Unknown,
        };
        if let Some(record) = marker.as_ref() {
            let Some(pending) = parse_marker(record, call_id) else {
                return RetirementOutcome::Unknown;
            };
            self.state
                .pending
                .borrow_mut()
                .insert(call_id.into(), pending);
        } else {
            let Some(pending) = self.state.pending.borrow().get(call_id).cloned() else {
                return RetirementOutcome::NotTerminal;
            };
            let Ok(revision) = self.revision() else {
                return RetirementOutcome::Unknown;
            };
            let record = StoredRecord::json(
                revision,
                json!({"schema_version":1,"call_id":call_id,"upstream_status":pending.status,"created_at_ms":pending.created_at_ms}),
                None,
            );
            match self
                .state
                .store
                .commit(AtomicTransition {
                    checks: vec![],
                    mutations: vec![RecordMutation::Put {
                        key: key.clone(),
                        record,
                    }],
                })
                .await
            {
                Ok(CommitOutcome::Committed) => {}
                Ok(CommitOutcome::Conflict) => return RetirementOutcome::Pending,
                Err(_) => return RetirementOutcome::Unknown,
            }
            marker = match self.state.store.read(&key).await {
                Ok(Some(record)) => Some(record),
                _ => return RetirementOutcome::Unknown,
            };
        }
        // Source deletion remains unconditional, not a join claim or a mapping revision lease.
        match self
            .state
            .store
            .commit(AtomicTransition {
                checks: vec![],
                mutations: vec![RecordMutation::Delete {
                    key: mapping_key(call_id),
                }],
            })
            .await
        {
            Ok(CommitOutcome::Committed) => {}
            Ok(CommitOutcome::Conflict) => return RetirementOutcome::Pending,
            Err(_) => return RetirementOutcome::Unknown,
        }
        // Clear only after known successful deletion. A concurrent reused ID or newer terminal
        // marker retains suppression instead of clearing another operation's control record.
        let marker = marker.expect("marker was read after a successful write or existed");
        match self
            .state
            .store
            .commit(AtomicTransition {
                checks: vec![
                    RevisionCheck {
                        key: mapping_key(call_id),
                        expected_revision: None,
                    },
                    RevisionCheck {
                        key: key.clone(),
                        expected_revision: Some(marker.revision),
                    },
                ],
                mutations: vec![RecordMutation::Delete { key }],
            })
            .await
        {
            Ok(CommitOutcome::Committed) => {
                self.state.pending.borrow_mut().remove(call_id);
                RetirementOutcome::Retired
            }
            Ok(CommitOutcome::Conflict) => RetirementOutcome::Pending,
            Err(_) => RetirementOutcome::Unknown,
        }
    }
}

fn parse_marker(record: &StoredRecord, call_id: &str) -> Option<Pending> {
    let value = record.json_value().ok()?;
    if value.get("schema_version")?.as_u64()? != 1 || value.get("call_id")?.as_str()? != call_id {
        return None;
    }
    let status = u16::try_from(value.get("upstream_status")?.as_u64()?).ok()?;
    matches!(status, 404 | 410).then_some(Pending {
        status,
        created_at_ms: value.get("created_at_ms")?.as_i64()?,
    })
}

pub(crate) fn mapping_missing() -> GatewayError {
    crate::types::invalid(404, "Unknown realtime call.")
}
