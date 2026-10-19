//! JavaScript default lowercase over exact source UTF16 data, without trimming,
//! normalization, model selection or authority. The pinned standard Unicode
//! implementation is checked against the pinned source runtime's mappings.
use crate::js_string::JsString16;

/// Lowercase complete well-formed spans so contextual mappings (notably final
/// Sigma) see their surrounding cased/case-ignorable characters. A lone
/// surrogate is retained verbatim and separates those Unicode contexts; it is
/// never replaced with U+FFFD or escaped-text identity.
pub fn lowercase_source(value: &JsString16) -> JsString16 {
    let mut output = Vec::with_capacity(value.as_units().len());
    let mut span = String::new();
    for value in char::decode_utf16(value.as_units().iter().copied()) {
        match value {
            Ok(value) => span.push(value),
            Err(value) => {
                output.extend(span.to_lowercase().encode_utf16());
                span.clear();
                output.push(value.unpaired_surrogate());
            }
        }
    }
    output.extend(span.to_lowercase().encode_utf16());
    JsString16::from_units(output)
}
