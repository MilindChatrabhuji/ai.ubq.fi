//! Source-profile data plans only. Business-state publication needs a separate schema/index binding.
pub mod audit;
pub mod counter;
pub mod kernel;
mod prefixes;
pub mod retention;

use crate::error;
use gateway_core::{
    GatewayError,
    state::{AtomicTransition, RecordKey, RecordMutation, RevisionCheck, StoredRecord},
    tuple_key::TupleKey,
    value::PortableValue,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Local,
    Prod,
}
#[derive(Clone, Debug)]
pub struct ImportOptions {
    pub profile: Profile,
    pub include_cache: bool,
    pub include_legacy: bool,
    pub overwrite: bool,
    pub dry_run: bool,
}
impl ImportOptions {
    pub fn for_profile(profile: Profile) -> Self {
        Self {
            profile,
            include_cache: false,
            include_legacy: profile == Profile::Local,
            overwrite: false,
            dry_run: true,
        }
    }
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Decision {
    pub action: String,
    pub group: String,
    pub reason: String,
}
pub fn starts(parts: &[Value], prefix: &[&str]) -> bool {
    parts.len() >= prefix.len()
        && parts
            .iter()
            .zip(prefix)
            .all(|(a, b)| a.as_str() == Some(*b))
}
pub fn classify_key(parts: &[Value], options: &ImportOptions) -> Decision {
    let find = |rules: &[(&str, &[&str])]| {
        rules
            .iter()
            .find(|(_, prefix)| starts(parts, prefix))
            .map(|(group, _)| (*group).to_owned())
    };
    let decision = |action: &str, group: String, reason: &str| Decision {
        action: action.into(),
        group,
        reason: reason.into(),
    };
    if let Some(group) = find(prefixes::TRANSIENT_PREFIXES) {
        return decision("skip", group, "transient_runtime_state");
    }
    if let Some(group) = find(prefixes::CODEX_BOOTSTRAP_PREFIXES) {
        return if options.profile == Profile::Local {
            decision("import", group, "local_replay")
        } else {
            decision("skip", group, "refreshed_by_deploy_bootstrap")
        };
    }
    if let Some(group) = find(prefixes::DURABLE_PREFIXES) {
        return decision("import", group, "durable");
    }
    if let Some(group) = find(prefixes::LEGACY_DURABLE_PREFIXES) {
        return if options.include_legacy {
            decision("import", group, "legacy_durable")
        } else {
            decision("skip", group, "legacy_skipped")
        };
    }
    if let Some(group) = find(prefixes::EMBEDDINGS_CACHE_PREFIXES) {
        return if options.include_cache {
            decision("import", group, "cache_requested")
        } else {
            decision("optional", group, "cache_skipped_by_default")
        };
    }
    decision("skip", "unknown".into(), "unknown_prefix")
}

#[derive(Clone, Debug)]
pub struct ObservedRow {
    pub key: RecordKey,
    pub parts: Vec<Value>,
    pub record: StoredRecord,
}
impl ObservedRow {
    pub fn json(parts: Vec<Value>, record: StoredRecord) -> Result<Self, GatewayError> {
        let tuple = TupleKey::from_json_parts(&parts)?;
        tuple.validate_stored_key()?;
        Ok(Self {
            key: tuple.to_record_key(),
            parts,
            record,
        })
    }
    pub fn value(&self) -> Result<&Value, GatewayError> {
        self.record.json_value()
    }
}

#[derive(Clone, Debug)]
pub struct NormalizedEntry {
    pub key: RecordKey,
    pub parts: Vec<Value>,
    pub value: PortableValue,
    pub raw: Value,
}
#[derive(Clone, Debug)]
pub struct ImportPlan {
    pub decision: Decision,
    pub outcome: String,
    pub transition: Option<AtomicTransition>,
    /// A source-compatible record is not proof of the Rust business schema or its indexes.
    pub requires_schema_binding: bool,
}

pub fn plan_import(
    entry: &NormalizedEntry,
    existing: Option<&StoredRecord>,
    options: &ImportOptions,
    now: i64,
    new_revision: &str,
) -> Result<ImportPlan, GatewayError> {
    let decision = classify_key(&entry.parts, options);
    let empty = |outcome: &str| ImportPlan {
        decision: decision.clone(),
        outcome: outcome.into(),
        transition: None,
        requires_schema_binding: true,
    };
    if decision.action != "import" {
        return Ok(empty(if decision.action == "optional" {
            "optional"
        } else {
            "skipped"
        }));
    }
    let logical = logical_fields(&entry.value);
    let expiry = retention::migration_expiry(&entry.parts, &logical, now);
    let expires = match expiry {
        retention::Expiry::Skip => return Ok(empty("skipped")),
        retention::Expiry::Durable => None,
        retention::Expiry::At(v) => Some(v),
    };
    let existing_value = existing.map(StoredRecord::portable_value).transpose()?;
    if !options.overwrite && existing_value.is_some_and(|r| r != PortableValue::Null) {
        return Ok(empty("skipped"));
    }
    if options.dry_run {
        return Ok(empty("imported"));
    }
    if new_revision.is_empty() {
        return Err(error(
            "A trusted new revision is required for migration writes.",
        ));
    }
    let record = if let Some(json) = entry.value.to_json_lossless() {
        StoredRecord::json(new_revision, json, expires)
    } else {
        StoredRecord::profile(new_revision, entry.value.clone(), expires)?
    };
    let checks = if options.overwrite {
        vec![]
    } else {
        vec![RevisionCheck {
            key: entry.key.clone(),
            expected_revision: existing.map(|row| row.revision.clone()),
        }]
    };
    Ok(ImportPlan {
        decision,
        outcome: "imported".into(),
        transition: Some(AtomicTransition {
            checks,
            mutations: vec![RecordMutation::Put {
                key: entry.key.clone(),
                record,
            }],
        }),
        requires_schema_binding: true,
    })
}

/// Expose only ordinary field data for source validators, without coercing typed values.
pub fn logical_fields(value: &PortableValue) -> Value {
    if let PortableValue::Object(fields) = value {
        Value::Object(
            fields
                .iter()
                .map(|(name, value)| {
                    (
                        name.clone(),
                        value.to_json_lossless().unwrap_or(Value::Null),
                    )
                })
                .collect(),
        )
    } else {
        value.to_json_lossless().unwrap_or(Value::Null)
    }
}
pub(crate) fn check(row: &ObservedRow) -> RevisionCheck {
    RevisionCheck {
        key: row.key.clone(),
        expected_revision: Some(row.record.revision.clone()),
    }
}
pub(crate) fn put(
    key: RecordKey,
    value: Value,
    expiry: Option<i64>,
    revision: &str,
) -> RecordMutation {
    RecordMutation::Put {
        key,
        record: StoredRecord::json(revision, value, expiry),
    }
}
pub(crate) fn key(parts: &[Value]) -> Result<RecordKey, GatewayError> {
    let key = TupleKey::from_json_parts(parts)?;
    key.validate_stored_key()?;
    Ok(key.to_record_key())
}
