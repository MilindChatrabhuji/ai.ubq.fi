//! Data-only local-origin custody. No row or imported nonce mints a live handle.
use crate::{
    GatewayError,
    lifecycle::{BodyOutcome, DeliveryOutcome, ReaderTermination},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SOURCE_REQUEST_BINDING_VERSION: u8 = 2;
pub const SOURCE_REQUEST_BINDING_DOMAIN: &[u8] = b"uos-routing-source-request/v2\0";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalWorkKind {
    CodexResponsesCompaction,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalWorkPhase {
    Admitting,
    Running,
    Planning,
    ProviderPlanned,
    ResponsePending,
    TerminalPending,
    Terminal,
}

/// Actual local output semantics, never an invented provider terminal or token receipt.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalSemanticOutcome {
    Completed,
    Incomplete,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LocalTerminalObservation {
    pub semantic: LocalSemanticOutcome,
    pub reader_termination: Option<ReaderTermination>,
    pub body: Option<BodyOutcome>,
    pub delivery: DeliveryOutcome,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LocalWorkRecord {
    pub kind: LocalWorkKind,
    pub owner_nonce: String,
    /// The journal input_digest binds the immutable ORIGINAL canonical SourceJson.
    pub binding_version: u8,
    pub phase: LocalWorkPhase,
    pub terminal: Option<LocalTerminalObservation>,
}

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Local-origin journal custody is invalid.",
        "local_work_custody_invalid",
    )
}

impl LocalWorkRecord {
    pub fn parse(value: &Value) -> Result<Self, GatewayError> {
        let row: Self = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
        if serde_json::to_value(&row).map_err(|_| invalid())? != *value
            || row.binding_version != SOURCE_REQUEST_BINDING_VERSION
            || row.owner_nonce.trim().is_empty()
            || row.owner_nonce.len() > 512
            || matches!(row.phase, LocalWorkPhase::TerminalPending | LocalWorkPhase::Terminal)
                != row.terminal.is_some()
        {
            return Err(invalid());
        }
        Ok(row)
    }
}

/// Shared phase parser for the actual runtime/custody and paid original guard.
/// It validates only this extension; each owner still validates its complete
/// original journal/context/quota/currentness contract. It is not authorization.
pub fn journal_local_work(value: &Value) -> Result<Option<LocalWorkRecord>, GatewayError> {
    match value.get("v").and_then(Value::as_u64) {
        Some(1) if value.get("local_work").is_none() => Ok(None),
        Some(2) => {
            let row = LocalWorkRecord::parse(value.get("local_work").ok_or_else(invalid)?)?;
            for key in ["extras_family", "extras_child_count", "extras_dispatch", "kernel_override"] {
                if value.get(key) != Some(&Value::Null) {
                    return Err(invalid());
                }
            }
            if value.get("children").and_then(Value::as_array).is_none_or(|v| !v.is_empty()) {
                return Err(invalid());
            }
            if row.phase != LocalWorkPhase::ProviderPlanned
                && (value.get("attempts").and_then(Value::as_array).is_none_or(|v| !v.is_empty())
                    || value.get("active") != Some(&Value::Null)
                    || value.get("semantic_committed") != Some(&Value::Bool(false))
                    || value.get("terminal_intent") != Some(&Value::Null))
            {
                return Err(invalid());
            }
            let finished = value.get("finished").and_then(Value::as_bool).ok_or_else(invalid)?;
            if row.phase == LocalWorkPhase::Terminal && !finished
                || finished && !matches!(row.phase, LocalWorkPhase::Terminal | LocalWorkPhase::ProviderPlanned)
            {
                return Err(invalid());
            }
            Ok(Some(row))
        }
        _ => Err(invalid()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row() -> Value {
        json!({"v":2,"local_work":{"kind":"codex_responses_compaction","owner_nonce":"source-owner","binding_version":2,"phase":"running","terminal":null},"attempts":[],"active":null,"semantic_committed":false,"terminal_intent":null,"finished":false,"extras_family":null,"extras_child_count":null,"extras_dispatch":null,"children":[],"kernel_override":null})
    }

    #[test]
    fn local_extension_is_complete_strict_and_never_a_legacy_default() {
        let original = row();
        assert_eq!(journal_local_work(&original).unwrap().unwrap().phase, LocalWorkPhase::Running);
        for field in ["terminal", "owner_nonce", "binding_version", "kind", "phase"] {
            let mut missing = original.clone();
            missing["local_work"].as_object_mut().unwrap().remove(field);
            assert!(journal_local_work(&missing).is_err(), "{field}");
        }
        let mut extra = original;
        extra["local_work"]["foreign"] = json!(true);
        assert!(journal_local_work(&extra).is_err());
        assert!(journal_local_work(&json!({"v":1})).unwrap().is_none());
        assert!(journal_local_work(&json!({"v":1,"local_work":null})).is_err());
        assert!(journal_local_work(&json!({"v":2})).is_err());
    }

    #[test]
    fn local_phase_cannot_invent_provider_extras_or_finished_permission() {
        for (field, value) in [("attempts",json!([{}])),("active",json!("fake")),("semantic_committed",json!(true)),("terminal_intent",json!({})),("extras_family",json!("images")),("children",json!([{}])),("finished",json!(true))] {
            let mut bad = row();
            bad[field] = value;
            assert!(journal_local_work(&bad).is_err(), "{field}");
        }
        let mut pending = row();
        pending["local_work"]["phase"] = json!("terminal_pending");
        assert!(journal_local_work(&pending).is_err());
        pending["local_work"]["terminal"] = json!({"semantic":"completed","reader_termination":"eof","body":"drained","delivery":"unobserved"});
        let observation = journal_local_work(&pending).unwrap().unwrap().terminal.unwrap();
        assert_eq!(observation.delivery,DeliveryOutcome::Unobserved);
    }
}
