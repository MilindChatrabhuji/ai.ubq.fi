//! Platform boundary only. One authority commits related routing/quota/billing transitions.
//! Upstream I/O stays outside commit; dispatch must await its actual durable completion.

use std::future::Future;

use serde::{Deserialize, Serialize};

use crate::GatewayError;

pub const PORTABLE_STATE_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct StoredRecord {
    pub schema_version: u32,
    #[serde(default)]
    pub value_encoding: crate::value::ValueEncoding,
    pub revision: String,
    pub value: serde_json::Value,
    /// Absolute expiry, never a refreshed relative TTL. None means retained indefinitely.
    pub expires_at_ms: Option<crate::identity::UnixMillis>,
}

impl StoredRecord {
    pub fn json(
        revision: impl Into<String>,
        value: serde_json::Value,
        expires_at_ms: Option<crate::identity::UnixMillis>,
    ) -> Self {
        Self {
            schema_version: PORTABLE_STATE_VERSION,
            value_encoding: crate::value::ValueEncoding::Json,
            revision: revision.into(),
            value,
            expires_at_ms,
        }
    }
    pub fn profile(
        revision: impl Into<String>,
        value: crate::value::PortableValue,
        expires_at_ms: Option<crate::identity::UnixMillis>,
    ) -> Result<Self, GatewayError> {
        value.validate_for_storage()?;
        let value = serde_json::to_value(value).map_err(|_| {
            GatewayError::unavailable("Typed value encoding failed.", "portable_value_invalid")
        })?;
        Ok(Self {
            schema_version: PORTABLE_STATE_VERSION,
            value_encoding: crate::value::ValueEncoding::ProfileV1,
            revision: revision.into(),
            value,
            expires_at_ms,
        })
    }
    pub fn json_value(&self) -> Result<&serde_json::Value, GatewayError> {
        self.validate_version()?;
        if self.value_encoding != crate::value::ValueEncoding::Json {
            return Err(GatewayError::unavailable(
                "A JSON record was required.",
                "incompatible_value_encoding",
            ));
        }
        Ok(&self.value)
    }
    pub fn profile_v2(
        revision: impl Into<String>,
        value: crate::value::PortableValue,
        expires_at_ms: Option<crate::identity::UnixMillis>,
    ) -> Result<Self, GatewayError> {
        value.validate_for_storage_v2()?;
        let value = serde_json::to_value(value).map_err(|_| {
            GatewayError::unavailable("Typed value encoding failed.", "portable_value_invalid")
        })?;
        Ok(Self {
            schema_version: PORTABLE_STATE_VERSION,
            value_encoding: crate::value::ValueEncoding::ProfileV2,
            revision: revision.into(),
            value,
            expires_at_ms,
        })
    }
    pub fn profile_v2_value(&self) -> Result<crate::value::PortableValue, GatewayError> {
        self.validate_version()?;
        if self.value_encoding != crate::value::ValueEncoding::ProfileV2 {
            return Err(GatewayError::unavailable(
                "An explicit ProfileV2 record was required",
                "incompatible_value_encoding",
            ));
        }
        let value: crate::value::PortableValue = serde_json::from_value(self.value.clone())
            .map_err(|_| {
                GatewayError::unavailable("Typed value decoding failed.", "portable_value_invalid")
            })?;
        value.validate_for_storage_v2()?;
        Ok(value)
    }
    pub fn profile_v2_source_json(&self) -> Result<crate::source_json::SourceJson, GatewayError> {
        self.profile_v2_value()?.to_source_json()
    }
    pub fn source_graph(
        revision: impl Into<String>,
        graph: crate::source_graph::SourceGraph,
        expires_at_ms: Option<crate::identity::UnixMillis>,
    ) -> Result<Self, GatewayError> {
        graph.validate_for_storage()?;
        let value = serde_json::to_value(graph).map_err(|_| {
            GatewayError::unavailable(
                "Native source graph encoding failed.",
                "source_graph_invalid",
            )
        })?;
        Ok(Self {
            schema_version: PORTABLE_STATE_VERSION,
            value_encoding: crate::value::ValueEncoding::SourceGraphV1,
            revision: revision.into(),
            value,
            expires_at_ms,
        })
    }
    pub fn source_graph_value(&self) -> Result<crate::source_graph::SourceGraph, GatewayError> {
        self.validate_version()?;
        if self.value_encoding != crate::value::ValueEncoding::SourceGraphV1 {
            return Err(GatewayError::unavailable(
                "An explicit SourceGraphV1 record was required.",
                "incompatible_value_encoding",
            ));
        }
        self.decode_source_graph()
    }
    fn decode_source_graph(&self) -> Result<crate::source_graph::SourceGraph, GatewayError> {
        let graph: crate::source_graph::SourceGraph = serde_json::from_value(self.value.clone())
            .map_err(|_| {
                GatewayError::unavailable(
                    "Native source graph decoding failed.",
                    "source_graph_invalid",
                )
            })?;
        graph.validate_for_storage()?;
        Ok(graph)
    }
    pub fn portable_value(&self) -> Result<crate::value::PortableValue, GatewayError> {
        self.validate_version()?;
        match self.value_encoding {
            crate::value::ValueEncoding::Json => {
                Ok(crate::value::PortableValue::from_json(&self.value))
            }
            crate::value::ValueEncoding::ProfileV1 => {
                let decoded: crate::value::PortableValue =
                    serde_json::from_value(self.value.clone()).map_err(|_| {
                        GatewayError::unavailable(
                            "Typed value decoding failed.",
                            "portable_value_invalid",
                        )
                    })?;
                decoded.validate_for_storage()?;
                Ok(decoded)
            }
            crate::value::ValueEncoding::ProfileV2 => self.profile_v2_value(),
            crate::value::ValueEncoding::SourceGraphV1 => Err(GatewayError::unavailable(
                "A tree record was required.",
                "incompatible_value_encoding",
            )),
        }
    }
    pub fn validate_version(&self) -> Result<(), GatewayError> {
        if self.schema_version == PORTABLE_STATE_VERSION {
            if self.value_encoding == crate::value::ValueEncoding::SourceGraphV1 {
                self.decode_source_graph()?;
            }
            if matches!(
                self.value_encoding,
                crate::value::ValueEncoding::ProfileV1 | crate::value::ValueEncoding::ProfileV2
            ) {
                let decoded: crate::value::PortableValue =
                    serde_json::from_value(self.value.clone()).map_err(|_| {
                        GatewayError::unavailable(
                            "Typed value decoding failed.",
                            "portable_value_invalid",
                        )
                    })?;
                if self.value_encoding == crate::value::ValueEncoding::ProfileV2 {
                    decoded.validate_for_storage_v2()?;
                } else {
                    decoded.validate_for_storage()?;
                }
            }
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
