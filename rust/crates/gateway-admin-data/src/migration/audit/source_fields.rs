//! Finite observations used only by the named source control audits.
//! The complete SourceJson document remains authoritative; no model/map is
//! replaced by a scalar view and ObservedRow's general interpretation is unchanged.
use gateway_core::{source_json::SourceJson, source_serialization as source};
use serde_json::Value;

pub(super) fn member(value: &SourceJson, field: &str) -> Option<SourceJson> {
    source::member(value, field)
}
pub(super) fn finite(value: &SourceJson, field: &str) -> Option<Value> {
    member(value, field)?.deserialize().ok()
}
pub(super) fn text(value: &SourceJson, field: &str) -> Option<String> {
    member(value, field)?.deserialize().ok()
}
pub(super) fn same(left: &SourceJson, right: &SourceJson, field: &str) -> bool {
    match (member(left, field), member(right, field)) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            match (left.deserialize::<Value>(), right.deserialize::<Value>()) {
                (Ok(left), Ok(right)) => left == right,
                _ => source::string(&left)
                    .zip(source::string(&right))
                    .is_some_and(|(left, right)| left == right),
            }
        }
        _ => false,
    }
}
pub(super) fn equals(value: &SourceJson, field: &str, expected: &Value) -> bool {
    finite(value, field).as_ref() == Some(expected)
}
pub(super) fn safe(value: &SourceJson, field: &str) -> bool {
    super::safe(finite(value, field).as_ref())
}
pub(super) fn positive(value: &SourceJson, field: &str) -> bool {
    super::positive(finite(value, field).as_ref())
}
pub(super) fn nullable_safe(value: &SourceJson, field: &str, positive_only: bool) -> bool {
    super::nullable_safe(finite(value, field).as_ref(), positive_only)
}
pub(super) fn nullable_string(value: &SourceJson, field: &str, nonempty: bool) -> bool {
    member(value, field).is_some_and(|value| {
        value.as_str() == "null"
            || source::string(&value).is_some_and(|text| !nonempty || !text.as_units().is_empty())
    })
}
