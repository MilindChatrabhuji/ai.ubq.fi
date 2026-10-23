//! Model-key object serde opts into the shared source string/object grammar.
use gateway_core::{model::ModelId, source_json::SourceJson, source_serialization as source};
use serde::{Deserializer, Serialize, Serializer, de::DeserializeOwned};
use std::collections::BTreeMap;

pub fn serialize<S: Serializer, T: Serialize>(
    values: &BTreeMap<ModelId, T>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let fields = values
        .iter()
        .map(|(key, value)| {
            Ok((
                key.as_js_string().clone(),
                SourceJson::from_serializable(value)?,
            ))
        })
        .collect::<Result<Vec<_>, gateway_core::GatewayError>>()
        .map_err(serde::ser::Error::custom)?;
    let raw = source::object_keys(fields).map_err(serde::ser::Error::custom)?;
    let fields = source::entries(&raw)
        .ok_or_else(|| serde::ser::Error::custom("Invalid model-key object"))?;
    source::object_keys(fields)
        .map_err(serde::ser::Error::custom)?
        .serialize(serializer)
}
pub fn deserialize<'de, D: Deserializer<'de>, T: DeserializeOwned>(
    deserializer: D,
) -> Result<BTreeMap<ModelId, T>, D::Error> {
    let raw = <SourceJson as serde::Deserialize>::deserialize(deserializer)?;
    source::entries(&raw)
        .ok_or_else(|| serde::de::Error::custom("Invalid model-key object"))?
        .into_iter()
        .map(|(key, value)| {
            Ok((
                ModelId::from_source(key),
                value.deserialize().map_err(serde::de::Error::custom)?,
            ))
        })
        .collect()
}
