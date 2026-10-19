//! Data-only local-origin custody. No row or imported nonce mints a live handle.
use crate::{
    GatewayError,
    lifecycle::{BodyOutcome, DeliveryOutcome, ReaderTermination},
};
use crate::{source_json::SourceJson, source_serialization as source};
use serde::{Deserialize, Serialize};

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
    pub fn parse(value: &SourceJson) -> Result<Self, GatewayError> {
        // A version's stored integer representation is not silently reinterpreted.
        if source::member(value, "binding_version").and_then(|value| value.deserialize::<u8>().ok())
            != Some(SOURCE_REQUEST_BINDING_VERSION)
        {
            return Err(invalid());
        }
        let canonical = source::canonical(value).map_err(|_| invalid())?;
        let row: Self = canonical.deserialize().map_err(|_| invalid())?;
        // Option fields must be present, but object insertion order is not a shape rule.
        // The closed DTO rejects unknown fields; the old Value equality ignored key order.
        let terminal = source::member(value, "terminal").ok_or_else(invalid)?;
        if terminal.as_str() != "null" {
            for key in ["semantic", "reader_termination", "body", "delivery"] {
                if source::member(&terminal, key).is_none() {
                    return Err(invalid());
                }
            }
        }
        if row.binding_version != SOURCE_REQUEST_BINDING_VERSION
            || row.owner_nonce.trim().is_empty()
            || row.owner_nonce.len() > 512
            || matches!(
                row.phase,
                LocalWorkPhase::TerminalPending | LocalWorkPhase::Terminal
            ) != row.terminal.is_some()
        {
            return Err(invalid());
        }
        Ok(row)
    }
}

/// Shared phase parser for the actual runtime/custody and paid original guard.
/// It validates only this extension; each owner still validates its complete
/// original journal/context/quota/currentness contract. It is not authorization.
pub fn journal_local_work(value: &SourceJson) -> Result<Option<LocalWorkRecord>, GatewayError> {
    let version = source::member(value, "v").and_then(|value| value.deserialize::<u64>().ok());
    match version {
        Some(1) if source::member(value, "local_work").is_none() => Ok(None),
        Some(3) if source::member(value, "local_work").is_none() => {
            ordinary_fields(value)?;
            Ok(None)
        }
        Some(2) => {
            let row =
                LocalWorkRecord::parse(&source::member(value, "local_work").ok_or_else(invalid)?)?;
            ordinary_fields(value)?;
            if row.phase != LocalWorkPhase::ProviderPlanned
                && (!empty_array(value, "attempts")
                    || !is(value, "active", "null")
                    || !is(value, "semantic_committed", "false")
                    || !is(value, "terminal_intent", "null"))
            {
                return Err(invalid());
            }
            let finished = match source::member(value, "finished")
                .as_ref()
                .map(SourceJson::as_str)
            {
                Some("true") => true,
                Some("false") => false,
                _ => return Err(invalid()),
            };
            if row.phase == LocalWorkPhase::Terminal && !finished
                || finished
                    && !matches!(
                        row.phase,
                        LocalWorkPhase::Terminal | LocalWorkPhase::ProviderPlanned
                    )
            {
                return Err(invalid());
            }
            Ok(Some(row))
        }
        _ => Err(invalid()),
    }
}
fn is(value: &SourceJson, key: &str, expected: &str) -> bool {
    source::member(value, key).is_some_and(|value| value.as_str() == expected)
}
fn empty_array(value: &SourceJson, key: &str) -> bool {
    source::member(value, key)
        .and_then(|value| source::array(&value))
        .is_some_and(|array| array.is_empty())
}
fn ordinary_fields(value: &SourceJson) -> Result<(), GatewayError> {
    for key in [
        "extras_family",
        "extras_child_count",
        "extras_dispatch",
        "kernel_override",
    ] {
        if !is(value, key, "null") {
            return Err(invalid());
        }
    }
    if !empty_array(value, "children") {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn check(value: &Value) -> Result<Option<LocalWorkRecord>, GatewayError> {
        journal_local_work(&SourceJson::from_serializable(value)?)
    }
    fn row() -> Value {
        json!({"v":2,"local_work":{"kind":"codex_responses_compaction","owner_nonce":"source-owner","binding_version":2,"phase":"running","terminal":null},"attempts":[],"active":null,"semantic_committed":false,"terminal_intent":null,"finished":false,"extras_family":null,"extras_child_count":null,"extras_dispatch":null,"children":[],"kernel_override":null})
    }

    #[test]
    fn local_extension_is_complete_strict_and_never_a_legacy_default() {
        let original = row();
        assert_eq!(
            check(&original).unwrap().unwrap().phase,
            LocalWorkPhase::Running
        );
        for field in [
            "terminal",
            "owner_nonce",
            "binding_version",
            "kind",
            "phase",
        ] {
            let mut missing = original.clone();
            missing["local_work"].as_object_mut().unwrap().remove(field);
            assert!(check(&missing).is_err(), "{field}");
        }
        let mut extra = original;
        extra["local_work"]["foreign"] = json!(true);
        assert!(check(&extra).is_err());
        assert!(check(&json!({"v":1})).unwrap().is_none());
        assert!(check(&json!({"v":1,"local_work":null})).is_err());
        assert!(check(&json!({"v":2})).is_err());
    }

    #[test]
    fn local_phase_cannot_invent_provider_extras_or_finished_permission() {
        for (field, value) in [
            ("attempts", json!([{}])),
            ("active", json!("fake")),
            ("semantic_committed", json!(true)),
            ("terminal_intent", json!({})),
            ("extras_family", json!("images")),
            ("children", json!([{}])),
            ("finished", json!(true)),
        ] {
            let mut bad = row();
            bad[field] = value;
            assert!(check(&bad).is_err(), "{field}");
        }
        let mut pending = row();
        pending["local_work"]["phase"] = json!("terminal_pending");
        assert!(check(&pending).is_err());
        pending["local_work"]["terminal"] = json!({"semantic":"completed","reader_termination":"eof","body":"drained","delivery":"unobserved"});
        let observation = check(&pending).unwrap().unwrap().terminal.unwrap();
        assert_eq!(observation.delivery, DeliveryOutcome::Unobserved);
    }
    #[test]
    fn ordinary_v3_is_explicit_no_local_no_extras_and_unknown_versions_refuse() {
        let mut value = row();
        value["v"] = json!(3);
        value.as_object_mut().unwrap().remove("local_work");
        assert!(check(&value).unwrap().is_none());
        for (key, bad) in [
            ("local_work", json!(null)),
            ("extras_family", json!("images")),
            ("children", json!([{}])),
        ] {
            let mut bad_row = value.clone();
            bad_row[key] = bad;
            assert!(check(&bad_row).is_err(), "{key}");
        }
        for version in [0, 4, 99] {
            let mut bad = value.clone();
            bad["v"] = json!(version);
            assert!(check(&bad).is_err());
        }
        let source = SourceJson::parse(r#"{"v":1.0}"#).unwrap();
        assert!(journal_local_work(&source).is_err());
    }
    #[test]
    fn source_phase_inspection_never_scalarizes_opaque_attempt_models() {
        let value=SourceJson::parse(r#"{"v":3,"attempts":[{"model":"\ud800","reasoning":"\udfff"}],"active":"attempt","semantic_committed":false,"terminal_intent":null,"finished":false,"extras_family":null,"extras_child_count":null,"extras_dispatch":null,"children":[],"kernel_override":null}"#).unwrap();
        assert!(journal_local_work(&value).unwrap().is_none());
        let value=SourceJson::parse(r#"{"v":2,"local_work":{"kind":"codex_responses_compaction","owner_nonce":"owner","binding_version":2,"phase":"provider_planned","terminal":null},"attempts":[{"model":"\ud800"}],"active":"attempt","semantic_committed":false,"terminal_intent":null,"finished":false,"extras_family":null,"extras_child_count":null,"extras_dispatch":null,"children":[],"kernel_override":null}"#).unwrap();
        assert_eq!(
            journal_local_work(&value).unwrap().unwrap().phase,
            LocalWorkPhase::ProviderPlanned
        );
    }
    #[test]
    fn source_local_shape_retains_missing_null_and_closed_phase_fences() {
        let good = SourceJson::from_serializable(&row()).unwrap();
        let local = source::member(&good, "local_work").unwrap();
        assert!(LocalWorkRecord::parse(&local).is_ok());
        for text in [
            r#"{"kind":"codex_responses_compaction","owner_nonce":"owner","binding_version":2,"phase":"running"}"#,
            r#"{"kind":"codex_responses_compaction","owner_nonce":"owner","binding_version":2.0,"phase":"running","terminal":null}"#,
            r#"{"kind":"codex_responses_compaction","owner_nonce":"owner","binding_version":2,"phase":"future","terminal":null}"#,
        ] {
            assert!(LocalWorkRecord::parse(&SourceJson::parse(text).unwrap()).is_err());
        }
    }
    #[test]
    fn local_object_field_reordering_is_not_a_new_custody_restriction() {
        let value=SourceJson::parse(r#"{"terminal":null,"phase":"running","binding_version":2,"owner_nonce":"source-owner","kind":"codex_responses_compaction"}"#).unwrap();
        assert_eq!(
            LocalWorkRecord::parse(&value).unwrap().phase,
            LocalWorkPhase::Running
        );
        let value=SourceJson::parse(r#"{"terminal":{"delivery":"unobserved","body":"drained","semantic":"completed","reader_termination":"eof"},"phase":"terminal_pending","binding_version":2,"owner_nonce":"source-owner","kind":"codex_responses_compaction"}"#).unwrap();
        assert_eq!(
            LocalWorkRecord::parse(&value).unwrap().phase,
            LocalWorkPhase::TerminalPending
        );
        let missing=SourceJson::parse(r#"{"terminal":{"delivery":"unobserved","semantic":"completed","reader_termination":"eof"},"phase":"terminal_pending","binding_version":2,"owner_nonce":"source-owner","kind":"codex_responses_compaction"}"#).unwrap();
        assert!(LocalWorkRecord::parse(&missing).is_err());
    }
}
