//! One source-unit tool identity map and provider-owned reversible projection.
use crate::{source as s, types::ToolIdentity};
use gateway_core::{js_string::JsString16, source_json::SourceJson, source_serialization as json};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Index,
};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolMap {
    entries: Vec<(JsString16, ToolIdentity)>,
    positions: BTreeMap<JsString16, usize>,
}
impl ToolMap {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn get(&self, wire: &str) -> Option<&ToolIdentity> {
        self.get_source(&JsString16::from_utf8(wire))
    }
    pub fn get_source(&self, wire: &JsString16) -> Option<&ToolIdentity> {
        self.positions
            .get(wire)
            .map(|&position| &self.entries[position].1)
    }
    pub fn insert(&mut self, wire: String, identity: ToolIdentity) -> Option<ToolIdentity> {
        self.insert_source(JsString16::from_utf8(&wire), identity)
    }
    pub fn insert_source(
        &mut self,
        wire: JsString16,
        identity: ToolIdentity,
    ) -> Option<ToolIdentity> {
        if let Some(&position) = self.positions.get(&wire) {
            Some(std::mem::replace(&mut self.entries[position].1, identity))
        } else {
            self.positions.insert(wire.clone(), self.entries.len());
            self.entries.push((wire, identity));
            None
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = (&JsString16, &ToolIdentity)> {
        self.entries.iter().map(|(wire, identity)| (wire, identity))
    }
}
impl Index<&str> for ToolMap {
    type Output = ToolIdentity;
    fn index(&self, wire: &str) -> &Self::Output {
        self.get(wire).expect("Known projected tool")
    }
}
impl Serialize for ToolMap {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let fields = self
            .entries
            .iter()
            .map(|(wire, identity)| {
                SourceJson::from_serializable(identity).map(|identity| (wire.clone(), identity))
            })
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(serde::ser::Error::custom)?;
        json::object_keys(fields)
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for ToolMap {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let raw = <SourceJson as Deserialize>::deserialize(deserializer)?;
        let fields = json::entries(&raw)
            .ok_or_else(|| serde::de::Error::custom("Expected source tool map"))?;
        let mut map = Self::new();
        for (wire, identity) in fields {
            map.insert_source(
                wire,
                identity.deserialize().map_err(serde::de::Error::custom)?,
            );
        }
        Ok(map)
    }
}

pub(crate) fn flatten(
    value: Option<&SourceJson>,
    limit: usize,
) -> s::Result<(Vec<SourceJson>, ToolMap)> {
    let mut tools = vec![];
    let mut names = ToolMap::new();
    let mut used = BTreeSet::new();
    let Some(value) = value else {
        return Ok((tools, names));
    };
    let values = json::array(value)
        .ok_or_else(|| s::invalid(JsString16::from_utf8("tools must be an array"), "tools"))?;
    for tool in values {
        if json::entries(&tool).is_none() {
            return Err(s::invalid(
                JsString16::from_utf8("tools must contain objects"),
                "tools",
            ));
        }
        if s::is(&s::get(&tool, "type"), "namespace") {
            let nested = json::array(&s::get(&tool, "tools")).ok_or_else(|| {
                s::invalid(
                    JsString16::from_utf8("namespace tools must nest a tools array"),
                    "tools.tools",
                )
            })?;
            let namespace = s::string(&s::get(&tool, "name"));
            for entry in nested {
                if json::entries(&entry).is_none() {
                    return Err(s::invalid(
                        JsString16::from_utf8("namespace tools must contain objects"),
                        "tools.tools",
                    ));
                }
                if s::is(&s::get(&entry, "type"), "function") {
                    collect(
                        &entry,
                        namespace.as_ref(),
                        limit,
                        &mut tools,
                        &mut names,
                        &mut used,
                    )?;
                }
            }
        } else {
            collect(&tool, None, limit, &mut tools, &mut names, &mut used)?;
        }
    }
    Ok((tools, names))
}

fn collect(
    tool: &SourceJson,
    namespace: Option<&JsString16>,
    limit: usize,
    tools: &mut Vec<SourceJson>,
    names: &mut ToolMap,
    used: &mut BTreeSet<JsString16>,
) -> s::Result<()> {
    let custom = s::is(&s::get(tool, "type"), "custom");
    let nested = s::get(tool, "function");
    let function = if !custom && json::entries(&nested).is_some() {
        &nested
    } else {
        tool
    };
    if !custom && json::entries(&nested).is_none() && !s::is(&s::get(tool, "type"), "function") {
        return Ok(());
    }
    let name = s::string(&s::get(function, "name"))
        .filter(|value| !value.as_units().is_empty())
        .ok_or_else(|| {
            s::invalid(
                JsString16::from_utf8(if custom {
                    "custom tools require a name"
                } else {
                    "function tools require a name"
                }),
                "tools.name",
            )
        })?;
    let preferred = if used.contains(&name) {
        namespace
            .map(|namespace| s::concat(&[namespace, &JsString16::from_utf8("_"), &name]))
            .unwrap_or_else(|| name.clone())
    } else {
        name.clone()
    };
    let mut projected = preferred.prefix_units(limit);
    let mut suffix = 2usize;
    while used.contains(&projected) {
        let ending = JsString16::from_utf8(&format!("_{suffix}"));
        projected = s::concat(&[
            &preferred.prefix_units(limit.saturating_sub(ending.as_units().len())),
            &ending,
        ]);
        suffix += 1;
    }
    used.insert(projected.clone());
    names.insert_source(
        projected.clone(),
        ToolIdentity {
            name,
            namespace: namespace.cloned(),
            custom,
        },
    );
    let mut body = s::object(vec![("name", s::quoted(&projected))]);
    if let Some(description) =
        s::present(function, "description").filter(|value| s::string(value).is_some())
    {
        s::set(&mut body, "description", description);
    }
    if custom {
        s::set(
            &mut body,
            "parameters",
            s::generated(
                &serde_json::json!({"type":"object","properties":{"input":{"type":"string","description":"Freeform input for the tool."}},"required":["input"],"additionalProperties":false}),
            ),
        );
    } else {
        if let Some(parameters) = s::present(function, "parameters") {
            s::set(&mut body, "parameters", parameters);
        }
        if let Some(strict) =
            s::present(function, "strict").filter(|value| s::boolean(value).is_some())
        {
            s::set(&mut body, "strict", strict);
        }
    }
    tools.push(s::object(vec![
        ("type", s::text("function")),
        ("function", body),
    ]));
    Ok(())
}

pub(crate) fn choice(value: Option<&SourceJson>, names: &ToolMap) -> s::Result<Option<SourceJson>> {
    let Some(value) = value.filter(|value| !s::is_null(value)) else {
        return Ok(None);
    };
    if let Some(choice) = s::string(value) {
        return if ["none", "auto", "required"]
            .iter()
            .any(|v| choice.as_units().iter().copied().eq(v.encode_utf16()))
        {
            Ok(Some(value.clone()))
        } else {
            Err(s::invalid(
                s::concat(&[
                    &JsString16::from_utf8("tool_choice '"),
                    &choice,
                    &JsString16::from_utf8("' is not supported"),
                ]),
                "tool_choice",
            ))
        };
    }
    if json::entries(value).is_none() {
        return Err(s::invalid(
            JsString16::from_utf8("tool_choice must be a string or an object"),
            "tool_choice",
        ));
    }
    let function = s::get(value, "function");
    let name = s::string(&s::get(value, "name"))
        .or_else(|| s::string(&s::get(&function, "name")))
        .filter(|value| !value.as_units().is_empty())
        .ok_or_else(|| {
            s::invalid(
                JsString16::from_utf8("a named tool_choice requires a name"),
                "tool_choice.name",
            )
        })?;
    let namespace = s::present(value, "namespace")
        .or_else(|| s::present(&function, "namespace"))
        .and_then(|v| s::string(&v));
    let projected = names
        .iter()
        .find(|(_, identity)| identity.name == name && identity.namespace == namespace)
        .map(|(wire, _)| wire.clone())
        .unwrap_or_else(|| {
            if namespace.is_none() {
                names
                    .get_source(&name)
                    .map(|identity| identity.name.clone())
                    .unwrap_or(name)
            } else {
                name
            }
        });
    Ok(Some(s::object(vec![
        ("type", s::text("function")),
        ("function", s::object(vec![("name", s::quoted(&projected))])),
    ])))
}
