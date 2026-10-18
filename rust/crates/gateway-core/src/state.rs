//! Platform boundary only. One authority commits related routing/quota/billing transitions.
//! Upstream I/O stays outside commit; dispatch must await its actual durable completion.

use std::future::Future;

use serde::{Deserialize, Serialize};

use crate::GatewayError;

pub const PORTABLE_STATE_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct StoredRecord {
    pub schema_version: u32,
    pub revision: String,
    pub value: serde_json::Value,
    /// Absolute expiry, never a refreshed relative TTL. None means retained indefinitely.
    pub expires_at_ms: Option<crate::identity::UnixMillis>,
}

impl StoredRecord {
    pub fn validate_version(&self) -> Result<(), GatewayError> {
        if self.schema_version == PORTABLE_STATE_VERSION {
            Ok(())
        } else {
            Err(GatewayError::unavailable(
                "The authority state version is unsupported.",
                "authority_state_version_unsupported",
            ))
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitOutcome {
    Committed,
    Conflict,
}

/// Key encoding is owned by the versioned portable-state adapter, not a legacy KV codec.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordKey(pub String);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevisionCheck {
    pub key: RecordKey,
    /// None requires the record to be absent, rather than skipping its fence.
    pub expected_revision: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RecordMutation {
    Put {
        key: RecordKey,
        record: StoredRecord,
    },
    Delete {
        key: RecordKey,
    },
}

/// Checks and mutations commit together; retained histories need not fit in a hot-state blob.
#[derive(Clone, Debug, PartialEq)]
pub struct AtomicTransition {
    pub checks: Vec<RevisionCheck>,
    pub mutations: Vec<RecordMutation>,
}

/// An adapter must refuse corruption/unavailability, never replace it with empty state.
/// A successful commit is atomic and durable before returning, including its platform sync.
/// Reads are strong. All records participating in one transition share the same authority.
/// Retention belongs to each record's source contract; missing expiry never implies eviction.
pub trait AuthorityStore {
    fn read(
        &self,
        key: &RecordKey,
    ) -> impl Future<Output = Result<Option<StoredRecord>, GatewayError>>;

    fn commit(
        &self,
        transition: AtomicTransition,
    ) -> impl Future<Output = Result<CommitOutcome, GatewayError>>;
}
