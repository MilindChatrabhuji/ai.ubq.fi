//! Open-string reasoning syntax over original UTF16 values, independent of catalogs.
use super::{SourceRequestError, trim};
use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
pub fn parse_effort(
    value: Option<&SourceJson>,
    field: &str,
) -> Result<Option<JsString16>, SourceRequestError> {
    let Some(value) = value.filter(|v| v.as_str() != "null") else {
        return Ok(None);
    };
    let value = source::string(value).ok_or_else(|| {
        SourceRequestError::scalar(&format!("{field} must be a string"), Some(field))
    })?;
    let value = trim(&value);
    if value.as_units().is_empty() {
        return Err(SourceRequestError::scalar(
            &format!("{field} must be a non-empty string"),
            Some(field),
        ));
    }
    Ok(Some(value))
}
pub fn parse_reasoning(
    value: Option<&SourceJson>,
) -> Result<Option<SourceJson>, SourceRequestError> {
    let Some(value) = value.filter(|v| v.as_str() != "null") else {
        return Ok(None);
    };
    let mut entries = source::entries(value).ok_or_else(|| {
        SourceRequestError::scalar("reasoning must be an object", Some("reasoning"))
    })?;
    if let Some(index) = entries
        .iter()
        .position(|(key, _)| key.as_units().iter().copied().eq("effort".encode_utf16()))
    {
        match parse_effort(Some(&entries[index].1), "reasoning.effort").map_err(|error| {
            let message = source::member(error.body(), "error")
                .and_then(|value| source::member(&value, "message"))
                .and_then(|value| source::string(&value))
                .expect("Source error message");
            // Reuse the same exact message, but source attaches all reasoning syntax to its parent param.
            SourceRequestError::invalid(message, Some(JsString16::from_utf8("reasoning")))
        })? {
            Some(effort) => {
                entries[index].1 =
                    source::quoted(&effort).map_err(SourceRequestError::from_scalar)?
            }
            None => {
                entries.remove(index);
            }
        }
    }
    for field in ["summary", "generate_summary"] {
        if let Some(index) = entries
            .iter()
            .position(|(key, _)| key.as_units().iter().copied().eq(field.encode_utf16()))
        {
            if entries[index].1.as_str() == "null" {
                entries.remove(index);
            } else if source::string(&entries[index].1).is_none() {
                return Err(SourceRequestError::scalar(
                    &format!("reasoning.{field} must be a string"),
                    Some("reasoning"),
                ));
            }
        }
    }
    if entries.is_empty() {
        Ok(None)
    } else {
        source::object_keys(entries)
            .map(Some)
            .map_err(SourceRequestError::from_scalar)
    }
}
