//! First-class image, Voyage and System One protocol adapters; persistence remains external.
use crate::types::*;
use gateway_core::{
    GatewayError, js_string::JsString16, model::ModelId, provider::UpstreamProvider,
    source_json::SourceJson, source_serialization as source,
};
use gateway_schema::source_request::{SourceRequestError, source_value::Value};
use serde::{Deserialize, Serialize};
use serde_json::Value as ScalarValue;
macro_rules! json { ({$($key:literal:$value:expr),*$(,)?})=>{Value::object(vec![$((JsString16::from_utf8($key),Value::from_serializable(&$value).expect("generated source field"))),*])}; ($value:expr)=>{Value::from_serializable(&$value).expect("generated source value")}; }

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn prepared(
    provider: UpstreamProvider,
    url: &str,
    surface: ClientSurface,
    raw: &Value,
    body: Value,
    options: &PrepareOptions,
    decode: ResponseDecode,
) -> PreparedRequest {
    let model = ModelId::from_source(body["model"].as_text().expect("validated model").core());
    PreparedRequest {
        provider,
        url: url.into(),
        method: "POST".into(),
        headers: Headers::from([
            (
                "Authorization".into(),
                format!("Bearer {}", options.auth.secret),
            ),
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "application/json".into()),
        ]),
        body: source::canonical(&body.source().expect("prepared source body"))
            .expect("prepared source serialization"),
        decode: DecodePlan {
            provider,
            surface,
            decode,
            model: raw["model"]
                .as_text()
                .map(|text| ModelId::from_source(text.core()))
                .unwrap_or_else(|| model.clone()),
            upstream_model: model,
            response_id: options.response_id.clone(),
            created_at: options.created_at,
            stream: false,
            request: raw.source().expect("original source request"),
            tool_names: ToolMap::new(),
            reasoning_summary: None,
        },
        warnings: vec![],
    }
}
fn systemone_view(
    raw: &Value,
    options: &PrepareOptions,
) -> Result<PreparedRequest, SourceRequestError> {
    let object = raw
        .as_object()
        .ok_or_else(|| scalar_error(400, "Invalid JSON body", Some("invalid_request_error")))?;
    if let Some((key, _)) = object.iter().find(|(key, _)| {
        !["state", "questions", "model"]
            .iter()
            .any(|name| key_is(key, name))
    }) {
        return Err(keyed_error("Unsupported key: ", key, "", false));
    }
    if !raw["state"].is_object() {
        return Err(scalar_error(
            400,
            "state must be an object",
            Some("invalid_request_error"),
        ));
    }
    let questions = raw["questions"].as_object().ok_or_else(|| {
        scalar_error(
            400,
            "questions must be an object",
            Some("invalid_request_error"),
        )
    })?;
    if questions.is_empty() || questions.len() > 24 {
        return Err(scalar_error(
            400,
            "questions must hold between 1 and 24 questions",
            Some("invalid_request_error"),
        ));
    }
    if questions.iter().any(|(name, q)| {
        gateway_schema::reasoning::js_trim_source(name)
            .as_units()
            .is_empty()
            || name.as_units().len() > 120
            || !q.is_object()
            || !matches!(q["type"].as_str(), Some("noul" | "choice" | "score"))
    }) {
        return Err(scalar_error(
            400,
            "questions must be typed noul, choice, or score objects",
            Some("invalid_request_error"),
        ));
    }
    let model_value = raw.get("model");
    if model_value.is_some_and(|value| !value.is_string()) {
        return Err(scalar_error(
            400,
            "model must be a string",
            Some("invalid_request_error"),
        ));
    }
    let model = model_value
        .map(Value::as_str)
        .unwrap_or(Some("~typesafe/jev-latest"));
    let Some(model) = model else {
        return Err(scalar_error(
            400,
            "model must be a typesafe model id",
            Some("invalid_request_error"),
        ));
    };
    let base = model.strip_prefix('~').unwrap_or(model);
    let suffix = base.strip_prefix("typesafe/").unwrap_or("");
    if model.len() > 80
        || suffix.is_empty()
        || suffix.len() > 64
        || !suffix
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        || !suffix
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err(scalar_error(
            400,
            "model must be a typesafe model id",
            Some("invalid_request_error"),
        ));
    }
    let upstream = if model.starts_with('~') {
        model.to_owned()
    } else {
        format!("~{model}")
    };
    Ok(prepared(
        UpstreamProvider::Openrouter,
        "https://openrouter.ai/api/v1/systemone",
        ClientSurface::SystemOne,
        raw,
        json!({"model":upstream,"state":raw["state"],"questions":raw["questions"]}),
        options,
        ResponseDecode::SystemOne,
    ))
}
pub fn decode_systemone(value: &ScalarValue) -> Result<ScalarValue, GatewayError> {
    if !value["answers"].is_object() {
        return Err(GatewayError::new(
            502,
            "System One upstream invalid response",
            Some("openrouter_upstream_invalid_response"),
        ));
    }
    Ok(value.clone())
}
pub fn systemone_usage(value: &ScalarValue) -> Option<ScalarValue> {
    let input = value["input_tokens"].as_f64()?;
    let output = value["output_tokens"].as_f64()?;
    let mut usage = serde_json::json!({"input_tokens":input,"output_tokens":output,"total_tokens":input+output,"input_tokens_details":{"cached_tokens":0}});
    if value["cost"].is_number() {
        usage["cost"] = value["cost"].clone();
    }
    Some(usage)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EmbeddingsProfile {
    pub model: String,
    pub inputs: Vec<JsString16>,
    pub input_type: String,
    pub dimensions: u64,
    pub encoding_format: String,
    pub truncation: bool,
    pub cache_profile_key: String,
    pub total_chars: usize,
}
fn embeddings_view(raw: &Value, job: bool) -> Result<EmbeddingsProfile, SourceRequestError> {
    let object = raw
        .as_object()
        .ok_or_else(|| scalar_error(400, "Invalid JSON body", Some("invalid_request_error")))?;
    for (key, _) in object {
        if ![
            "dimensions",
            "encoding_format",
            "input",
            "input_type",
            "model",
            "truncation",
        ]
        .iter()
        .any(|name| key_is(key, name))
            && (!key_is(key, "user") || job)
        {
            return Err(keyed_error(
                "Unrecognized request argument supplied: ",
                key,
                "",
                false,
            ));
        }
    }
    let model = raw
        .get("model")
        .and_then(Value::as_text)
        .filter(|s| !s.trim_matches(js_whitespace).is_empty())
        .ok_or_else(|| invalid("model is required and must be a non-empty string", "model"))?;
    if model.core() != JsString16::from_utf8("voyage-4-large") {
        return Err(SourceRequestError::new(
            400,
            crate::source::concat(&[
                &JsString16::from_utf8("Unsupported embedding model: "),
                &model.core(),
            ]),
            "invalid_request_error",
            Some("model_not_found"),
            Some(Some("model".into())),
        ));
    }
    let model = "voyage-4-large";
    let dimensions = match raw.get("dimensions") {
        None => 1024,
        Some(value) => {
            let value = value
                .as_f64()
                .filter(|v| v.is_finite() && v.fract() == 0.0)
                .ok_or_else(|| invalid("dimensions must be an integer", "dimensions"))?;
            if ![256.0, 512.0, 1024.0, 2048.0].contains(&value) {
                return Err(invalid(
                    "dimensions must be one of: 256, 512, 1024, 2048",
                    "dimensions",
                ));
            }
            value as u64
        }
    };
    let encoding = match raw.get("encoding_format") {
        None => "float",
        Some(value) => {
            if !value.is_string() {
                return Err(invalid(
                    "encoding_format must be a string",
                    "encoding_format",
                ));
            }
            let Some(text) = value.as_str() else {
                return Err(invalid(
                    "encoding_format must be one of: \"float\", \"base64\"",
                    "encoding_format",
                ));
            };
            text
        }
    };
    if !["float", "base64"].contains(&encoding) {
        return Err(invalid(
            "encoding_format must be one of: \"float\", \"base64\"",
            "encoding_format",
        ));
    }
    if job && encoding != "float" {
        return Err(invalid(
            "encoding_format must be \"float\" for embeddings jobs",
            "encoding_format",
        ));
    }
    let input_type = match raw.get("input_type") {
        None if job => {
            return Err(invalid(
                "input_type is required and must be one of: \"query\", \"document\"",
                "input_type",
            ));
        }
        None => "document",
        Some(value) => value
            .as_str()
            .filter(|v| ["query", "document"].contains(v))
            .ok_or_else(|| {
                invalid(
                    "input_type must be one of: \"query\", \"document\"",
                    "input_type",
                )
            })?,
    };
    let truncation = raw
        .get("truncation")
        .map_or(Some(true), Value::as_bool)
        .ok_or_else(|| invalid("truncation must be a boolean", "truncation"))?;
    if raw
        .get("user")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(invalid("user must be a string", "user"));
    }
    let input_error = || invalid("input must be a string or an array of strings", "input");
    let inputs = if let Some(input) = raw["input"].as_text() {
        vec![input.core()]
    } else {
        raw["input"]
            .as_array()
            .ok_or_else(input_error)?
            .iter()
            .map(|v| v.as_text().map(|text| text.core()).ok_or_else(input_error))
            .collect::<Result<Vec<_>, _>>()?
    };
    if inputs.is_empty() {
        return Err(invalid(
            "input must be a non-empty string or a non-empty array",
            "input",
        ));
    }
    if inputs.len() > 128 {
        return Err(invalid(
            format!("Too many inputs: {} (max 128)", inputs.len()),
            "input",
        ));
    }
    let mut total = 0;
    for input in &inputs {
        let len = input.as_units().len();
        if len > 20_000 {
            return Err(invalid(
                format!("Input too large: {len} chars (max 20000)"),
                "input",
            ));
        }
        total += len;
        if total > 100_000 {
            return Err(invalid(
                format!("Request too large: {total} chars total (max 100000)"),
                "input",
            ));
        }
        if String::from_utf16_lossy(input.as_units()).len().div_ceil(4) > 10_000 {
            return Err(invalid(
                format!(
                    "Input too large for embeddings provider: ~{} tokens (max 10000).",
                    String::from_utf16_lossy(input.as_units()).len().div_ceil(4)
                ),
                "input",
            ));
        }
    }
    let cache_profile_key = serde_json::json!([
        "voyage-profile-v2",
        model,
        input_type,
        dimensions,
        "float",
        encoding,
        truncation
    ])
    .to_string();
    Ok(EmbeddingsProfile {
        model: model.into(),
        inputs,
        input_type: input_type.into(),
        dimensions,
        encoding_format: encoding.into(),
        truncation,
        cache_profile_key,
        total_chars: total,
    })
}
fn prepare_embeddings_view(
    raw: &Value,
    options: &PrepareOptions,
) -> Result<PreparedRequest, SourceRequestError> {
    let profile = embeddings_view(raw, false)?;
    let input = if profile.inputs.len() == 1 {
        json!(profile.inputs[0])
    } else {
        json!(profile.inputs)
    };
    let body = json!({"model":profile.model,"input":input,"input_type":profile.input_type,"output_dimension":profile.dimensions,"output_dtype":"float","truncation":profile.truncation});
    Ok(prepared(
        UpstreamProvider::Voyage,
        "https://api.voyageai.com/v1/embeddings",
        ClientSurface::Embeddings,
        raw,
        body,
        options,
        ResponseDecode::Voyage,
    ))
}
pub use crate::source_embeddings::decode_embeddings;
pub fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as usize;
        let b = chunk.get(1).copied().unwrap_or(0) as usize;
        let c = chunk.get(2).copied().unwrap_or(0) as usize;
        result.push(CHARS[a >> 2] as char);
        result.push(CHARS[((a & 3) << 4) | (b >> 4)] as char);
        result.push(if chunk.len() > 1 {
            CHARS[((b & 15) << 2) | (c >> 6)] as char
        } else {
            '='
        });
        result.push(if chunk.len() > 2 {
            CHARS[c & 63] as char
        } else {
            '='
        });
    }
    result
}
#[derive(Clone, Debug)]
pub struct MultipartFile {
    pub name: String,
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[path = "extras_image.rs"]
mod image;
pub use image::{ImagePlan, ParsedImageRequest, prepare_parsed_image};
fn key_is(key: &JsString16, name: &str) -> bool {
    key.as_units().iter().copied().eq(name.encode_utf16())
}
fn scalar_error(status: u16, message: impl Into<String>, code: Option<&str>) -> SourceRequestError {
    SourceRequestError::from_gateway(GatewayError::new(status, message, code))
}
fn invalid(message: impl Into<String>, param: &str) -> SourceRequestError {
    SourceRequestError::from_gateway(
        GatewayError::new(400, message, Some("invalid_request_error")).with_param(Some(param)),
    )
}
fn keyed_error(prefix: &str, key: &JsString16, suffix: &str, param: bool) -> SourceRequestError {
    let message = crate::source::concat(&[
        &JsString16::from_utf8(prefix),
        key,
        &JsString16::from_utf8(suffix),
    ]);
    SourceRequestError::new(
        400,
        message,
        "invalid_request_error",
        Some("invalid_request_error"),
        param.then(|| Some(key.clone())),
    )
}
fn lift(raw: &ScalarValue) -> SourceJson {
    SourceJson::from_serializable(raw).expect("actual scalar input")
}
pub fn prepare_source_systemone(
    raw: &SourceJson,
    options: &PrepareOptions,
) -> Result<PreparedRequest, SourceRequestError> {
    systemone_view(&Value::from_source(raw.clone()), options)
}
pub fn parse_source_embeddings(
    raw: &SourceJson,
    job: bool,
) -> Result<EmbeddingsProfile, SourceRequestError> {
    embeddings_view(&Value::from_source(raw.clone()), job)
}
pub fn prepare_source_embeddings(
    raw: &SourceJson,
    options: &PrepareOptions,
) -> Result<PreparedRequest, SourceRequestError> {
    prepare_embeddings_view(&Value::from_source(raw.clone()), options)
}
pub fn parse_source_image(
    raw: &SourceJson,
    edit: bool,
) -> Result<ParsedImageRequest, SourceRequestError> {
    image::parse_image_view(&Value::from_source(raw.clone()), edit)
}
pub fn parse_source_multipart_image(
    raw: &SourceJson,
    files: &[MultipartFile],
) -> Result<ParsedImageRequest, SourceRequestError> {
    image::parse_multipart_image_view(&Value::from_source(raw.clone()), files)
}
pub fn prepare_systemone(
    raw: &ScalarValue,
    options: &PrepareOptions,
) -> Result<PreparedRequest, GatewayError> {
    prepare_source_systemone(&lift(raw), options).map_err(crate::source::scalar_error)
}
pub fn parse_embeddings(raw: &ScalarValue, job: bool) -> Result<EmbeddingsProfile, GatewayError> {
    parse_source_embeddings(&lift(raw), job).map_err(crate::source::scalar_error)
}
pub fn prepare_embeddings(
    raw: &ScalarValue,
    options: &PrepareOptions,
) -> Result<PreparedRequest, GatewayError> {
    prepare_source_embeddings(&lift(raw), options).map_err(crate::source::scalar_error)
}
pub fn parse_image(raw: &ScalarValue, edit: bool) -> Result<ParsedImageRequest, GatewayError> {
    parse_source_image(&lift(raw), edit).map_err(crate::source::scalar_error)
}
pub fn parse_multipart_image(
    raw: &ScalarValue,
    files: &[MultipartFile],
) -> Result<ParsedImageRequest, GatewayError> {
    parse_source_multipart_image(&lift(raw), files).map_err(crate::source::scalar_error)
}
pub fn prepare_image(
    raw: &ScalarValue,
    model: &str,
    edit: bool,
    id: &str,
) -> Result<ImagePlan, GatewayError> {
    image::prepare_image_view(&Value::from_source(lift(raw)), &model.into(), edit, id)
        .map_err(crate::source::scalar_error)
}
pub fn prepare_multipart_image(
    raw: &ScalarValue,
    files: &[MultipartFile],
    model: &str,
    id: &str,
) -> Result<ImagePlan, GatewayError> {
    image::prepare_multipart_image_view(&Value::from_source(lift(raw)), files, &model.into(), id)
        .map_err(crate::source::scalar_error)
}
pub fn normalize_image_reference(
    raw: &ScalarValue,
    mask: bool,
) -> Result<ScalarValue, GatewayError> {
    let value = image::normalize_image_reference_view(&Value::from_source(lift(raw)), mask)
        .map_err(crate::source::scalar_error)?;
    value
        .source()
        .and_then(|raw| raw.deserialize())
        .map_err(|_| {
            GatewayError::new(
                400,
                "Invalid scalar image reference",
                Some("invalid_request_error"),
            )
        })
}
pub fn multipart_image_references(
    files: &[MultipartFile],
) -> Result<(Vec<ScalarValue>, Option<ScalarValue>), GatewayError> {
    let (images, mask) =
        image::multipart_image_references(files).map_err(crate::source::scalar_error)?;
    Ok((
        images
            .iter()
            .map(|image| image.source().unwrap().deserialize().unwrap())
            .collect(),
        mask.map(|mask| mask.source().unwrap().deserialize().unwrap()),
    ))
}
pub fn extract_source_images(raw: &SourceJson) -> Vec<SourceJson> {
    let payload = Value::from_source(raw.clone());
    payload["output"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|value| value["type"].as_str() == Some("image_generation_call"))
        .filter_map(|value| {
            value["result"]
                .as_text()
                .filter(|text| !text.is_empty())
                .map(|result| {
                    let mut image = json!({"b64_json":result});
                    if let Some(prompt) = value["revised_prompt"].as_text() {
                        image["revised_prompt"] = json!(prompt)
                    }
                    image.source().expect("source generated image")
                })
        })
        .collect()
}
pub fn extract_images(payload: &ScalarValue) -> Vec<ScalarValue> {
    extract_source_images(&lift(payload))
        .into_iter()
        .map(|image| image.deserialize().expect("actual scalar image response"))
        .collect()
}
pub fn decode_source_systemone(raw: &SourceJson) -> Result<SourceJson, GatewayError> {
    let value = Value::from_source(raw.clone());
    if !value["answers"].is_object() {
        return Err(GatewayError::new(
            502,
            "System One upstream invalid response",
            Some("openrouter_upstream_invalid_response"),
        ));
    }
    Ok(raw.clone())
}
pub fn source_systemone_usage(raw: &SourceJson) -> Option<ScalarValue> {
    let value = Value::from_source(raw.clone());
    let input = value["input_tokens"].as_f64()?;
    let output = value["output_tokens"].as_f64()?;
    let mut usage = serde_json::json!({"input_tokens":input,"output_tokens":output,"total_tokens":input+output,"input_tokens_details":{"cached_tokens":0}});
    if let Some(cost) = value["cost"].as_f64() {
        usage["cost"] = serde_json::json!(cost)
    }
    Some(usage)
}
