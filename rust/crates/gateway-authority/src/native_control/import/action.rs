//! Explicit versioned action DATA readers. No optional/default v3 publication field.
use super::*;
use gateway_core::{source_json::SourceJson, source_serialization as source};

#[derive(Clone)]
pub(super) struct ImportActionRow {
    pub(super) v: u8,
    pub(super) kind: NativeImportKind,
    pub(super) metadata: NativeImportMetadata,
    pub(super) target: NativeImportTarget,
    pub(super) actor: StoredNativeActor,
    pub(super) context: gateway_core::identity::RequestContext,
    pub(super) created_at_ms: i64,
    pub(super) deadline_ms: i64,
    pub(super) facts: sources::ImportFacts,
    pub(super) publication: Option<ImportPublicationDataV1>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ActionV2 {
    v: u8,
    kind: NativeImportKind,
    metadata: NativeImportMetadata,
    target: NativeImportTarget,
    actor: StoredNativeActor,
    context: gateway_core::identity::RequestContext,
    created_at_ms: i64,
    deadline_ms: i64,
    facts: sources::ImportFacts,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ActionV3 {
    v: u8,
    kind: NativeImportKind,
    metadata: NativeImportMetadata,
    target: NativeImportTarget,
    actor: StoredNativeActor,
    context: gateway_core::identity::RequestContext,
    created_at_ms: i64,
    deadline_ms: i64,
    facts: sources::ImportFacts,
    #[serde(deserialize_with = "required_nullable")]
    publication: Option<ImportPublicationDataV1>,
}
impl ImportActionRow {
    pub(super) fn unfinished(&self) -> bool {
        matches!(self.v, 2 | 3) && self.publication.is_none()
    }
}
impl Serialize for ImportActionRow {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.v {
            2 if self.publication.is_none() => ActionV2 {
                v: self.v,
                kind: self.kind,
                metadata: self.metadata.clone(),
                target: self.target.clone(),
                actor: self.actor.clone(),
                context: self.context.clone(),
                created_at_ms: self.created_at_ms,
                deadline_ms: self.deadline_ms,
                facts: self.facts.clone(),
            }
            .serialize(serializer),
            3 => ActionV3 {
                v: self.v,
                kind: self.kind,
                metadata: self.metadata.clone(),
                target: self.target.clone(),
                actor: self.actor.clone(),
                context: self.context.clone(),
                created_at_ms: self.created_at_ms,
                deadline_ms: self.deadline_ms,
                facts: self.facts.clone(),
                publication: self.publication.clone(),
            }
            .serialize(serializer),
            _ => Err(serde::ser::Error::custom(
                "Unsupported import action schema",
            )),
        }
    }
}
impl<'de> Deserialize<'de> for ImportActionRow {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <SourceJson as Deserialize>::deserialize(deserializer)?;
        let version: u8 = source::member(&raw, "v")
            .ok_or_else(|| serde::de::Error::custom("Missing import action version"))?
            .deserialize()
            .map_err(|_| serde::de::Error::custom("Invalid import action data"))?;
        match version {
            2 => {
                let row: ActionV2 = raw
                    .deserialize()
                    .map_err(|_| serde::de::Error::custom("Invalid import action data"))?;
                Ok(Self {
                    v: row.v,
                    kind: row.kind,
                    metadata: row.metadata,
                    target: row.target,
                    actor: row.actor,
                    context: row.context,
                    created_at_ms: row.created_at_ms,
                    deadline_ms: row.deadline_ms,
                    facts: row.facts,
                    publication: None,
                })
            }
            3 => {
                let row: ActionV3 = raw
                    .deserialize()
                    .map_err(|_| serde::de::Error::custom("Invalid import action data"))?;
                if let Some(publication) = &row.publication {
                    publication
                        .validate()
                        .map_err(|_| serde::de::Error::custom("Invalid import publication data"))?;
                }
                Ok(Self {
                    v: row.v,
                    kind: row.kind,
                    metadata: row.metadata,
                    target: row.target,
                    actor: row.actor,
                    context: row.context,
                    created_at_ms: row.created_at_ms,
                    deadline_ms: row.deadline_ms,
                    facts: row.facts,
                    publication: row.publication,
                })
            }
            _ => Err(serde::de::Error::custom(
                "Unsupported import action version",
            )),
        }
    }
}
