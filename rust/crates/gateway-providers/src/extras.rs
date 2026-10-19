//! First-class image, Voyage and System One protocol adapters; persistence remains external.
use crate::types::*;
use gateway_core::{GatewayError, provider::UpstreamProvider};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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
    let model = body["model"].as_str().unwrap_or("").to_owned();
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
        body: crate::source::generated(&body),
        decode: DecodePlan {
            provider,
            surface,
            decode,
            model: raw["model"].as_str().unwrap_or(&model).into(),
            upstream_model: model,
            response_id: options.response_id.clone(),
            created_at: options.created_at,
            stream: false,
            request: crate::source::generated(raw),
            tool_names: ToolMap::new(),
            reasoning_summary: None,
        },
        warnings: vec![],
    }
}
pub fn prepare_systemone(
    raw: &Value,
    options: &PrepareOptions,
) -> Result<PreparedRequest, GatewayError> {
    let object = raw.as_object().ok_or_else(|| {
        GatewayError::new(400, "Invalid JSON body", Some("invalid_request_error"))
    })?;
    if let Some(key) = object
        .keys()
        .find(|k| !["state", "questions", "model"].contains(&k.as_str()))
    {
        return Err(GatewayError::new(
            400,
            format!("Unsupported key: {key}"),
            Some("invalid_request_error"),
        ));
    }
    if !raw["state"].is_object() {
        return Err(GatewayError::new(
            400,
            "state must be an object",
            Some("invalid_request_error"),
        ));
    }
    let questions = raw["questions"].as_object().ok_or_else(|| {
        GatewayError::new(
            400,
            "questions must be an object",
            Some("invalid_request_error"),
        )
    })?;
    if questions.is_empty() || questions.len() > 24 {
        return Err(GatewayError::new(
            400,
            "questions must hold between 1 and 24 questions",
            Some("invalid_request_error"),
        ));
    }
    if questions.iter().any(|(name, q)| {
        name.trim_matches(js_whitespace).is_empty()
            || name.encode_utf16().count() > 120
            || !q.is_object()
            || !matches!(q["type"].as_str(), Some("noul" | "choice" | "score"))
    }) {
        return Err(GatewayError::new(
            400,
            "questions must be typed noul, choice, or score objects",
            Some("invalid_request_error"),
        ));
    }
    let model = raw
        .get("model")
        .map_or(Some("~typesafe/jev-latest"), Value::as_str)
        .ok_or_else(|| {
            GatewayError::new(400, "model must be a string", Some("invalid_request_error"))
        })?;
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
        return Err(GatewayError::new(
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
pub fn decode_systemone(value: &Value) -> Result<Value, GatewayError> {
    if !value["answers"].is_object() {
        return Err(GatewayError::new(
            502,
            "System One upstream invalid response",
            Some("openrouter_upstream_invalid_response"),
        ));
    }
    Ok(value.clone())
}
pub fn systemone_usage(value: &Value) -> Option<Value> {
    let input = value["input_tokens"].as_f64()?;
    let output = value["output_tokens"].as_f64()?;
    let mut usage = json!({"input_tokens":input,"output_tokens":output,"total_tokens":input+output,"input_tokens_details":{"cached_tokens":0}});
    if value["cost"].is_number() {
        usage["cost"] = value["cost"].clone();
    }
    Some(usage)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EmbeddingsProfile {
    pub model: String,
    pub inputs: Vec<String>,
    pub input_type: String,
    pub dimensions: u64,
    pub encoding_format: String,
    pub truncation: bool,
    pub cache_profile_key: String,
    pub total_chars: usize,
}
pub fn parse_embeddings(raw: &Value, job: bool) -> Result<EmbeddingsProfile, GatewayError> {
    let object = raw.as_object().ok_or_else(|| {
        GatewayError::new(400, "Invalid JSON body", Some("invalid_request_error"))
    })?;
    for key in object.keys() {
        if ![
            "dimensions",
            "encoding_format",
            "input",
            "input_type",
            "model",
            "truncation",
        ]
        .contains(&key.as_str())
            && (key != "user" || job)
        {
            return Err(GatewayError::new(
                400,
                format!("Unrecognized request argument supplied: {key}"),
                Some("invalid_request_error"),
            ));
        }
    }
    let model = raw
        .get("model")
        .and_then(Value::as_str)
        .filter(|s| !s.trim_matches(js_whitespace).is_empty())
        .ok_or_else(|| invalid("model is required and must be a non-empty string", "model"))?;
    if model != "voyage-4-large" {
        return Err(GatewayError::new(
            400,
            format!("Unsupported embedding model: {model}"),
            Some("model_not_found"),
        )
        .with_param(Some("model")));
    }
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
        Some(value) => value
            .as_str()
            .ok_or_else(|| invalid("encoding_format must be a string", "encoding_format"))?,
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
    let inputs = if let Some(input) = raw["input"].as_str() {
        vec![input.to_owned()]
    } else {
        raw["input"]
            .as_array()
            .ok_or_else(input_error)?
            .iter()
            .map(|v| v.as_str().map(str::to_owned).ok_or_else(input_error))
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
        let len = input.encode_utf16().count();
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
        if input.len().div_ceil(4) > 10_000 {
            return Err(invalid(
                format!(
                    "Input too large for embeddings provider: ~{} tokens (max 10000).",
                    input.len().div_ceil(4)
                ),
                "input",
            ));
        }
    }
    let cache_profile_key = json!([
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
pub fn prepare_embeddings(
    raw: &Value,
    options: &PrepareOptions,
) -> Result<PreparedRequest, GatewayError> {
    let profile = parse_embeddings(raw, false)?;
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
pub fn decode_embeddings(value: &Value, plan: &DecodePlan) -> Result<Value, GatewayError> {
    // Preparation validated this named profile; decode needs only these finite controls.
    let input=crate::source::get(&plan.request,"input");
    let count=gateway_core::source_serialization::array(&input).map_or(1,|rows|rows.len());
    let dimensions=gateway_core::source_serialization::number(&crate::source::get(&plan.request,"dimensions")).unwrap_or(1024.0) as u64;
    let encoding_format=crate::source::control(&crate::source::get(&plan.request,"encoding_format")).unwrap_or_else(||"float".into());
    let rows = value["data"]
        .as_array()
        .ok_or_else(|| malformed("Voyage embeddings returned invalid JSON."))?;
    if rows.len() != count {
        return Err(malformed(
            "Voyage embeddings returned a different vector count.",
        ));
    }
    let mut data = vec![];
    for (index, row) in rows.iter().enumerate() {
        let vector = row["embedding"]
            .as_array()
            .filter(|v| v.len() == dimensions as usize && v.iter().all(Value::is_number))
            .ok_or_else(|| malformed("Voyage embedding dimensions or values are invalid."))?;
        let embedding = if encoding_format == "base64" {
            let mut bytes = vec![];
            for value in vector {
                bytes.extend_from_slice(&(value.as_f64().unwrap_or(0.0) as f32).to_le_bytes());
            }
            json!(base64_encode(&bytes))
        } else {
            json!(vector)
        };
        data.push(json!({"object":"embedding","index":index,"embedding":embedding}));
    }
    let total = value["usage"]["total_tokens"]
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|v| v.max(0.0).trunc());
    Ok(
        json!({"object":"list","model":plan.model,"data":data,"usage":{"prompt_tokens":total,"total_tokens":total}}),
    )
}
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
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImagePlan {
    pub responses: Value,
    pub count: u64,
    pub request_ids: Vec<String>,
    pub codex_only: bool,
}
pub fn prepare_image(
    raw: &Value,
    base_model: &str,
    edit: bool,
    request_id: &str,
) -> Result<ImagePlan, GatewayError> {
    prepare_image_inner(raw, base_model, edit, request_id, false)
}
fn validate_image_scalars(
    raw: &Value,
    edit: bool,
    multipart: bool,
) -> Result<(Value, u64), GatewayError> {
    let mut body = raw.clone();
    let object = body
        .as_object_mut()
        .ok_or_else(|| image_invalid("Image requests must use an object body.", ""))?;
    for key in object.keys() {
        let shared = [
            "model",
            "prompt",
            "n",
            "size",
            "quality",
            "background",
            "output_format",
            "output_compression",
            "stream",
            "partial_images",
            "user",
        ];
        let valid = shared.contains(&key.as_str())
            || if edit {
                ["images", "mask", "input_fidelity"].contains(&key.as_str())
                    || (!multipart && key == "moderation")
                    || (multipart && key == "response_format")
            } else {
                ["moderation", "response_format", "style"].contains(&key.as_str())
            };
        if !valid {
            return Err(image_invalid(
                format!(
                    "Unsupported image {} field: {key}.",
                    if edit { "edits" } else { "generations" }
                ),
                key,
            ));
        }
    }
    for key in [
        "model",
        "n",
        "size",
        "quality",
        "background",
        "output_format",
        "output_compression",
        "input_fidelity",
        "moderation",
        "response_format",
        "stream",
        "partial_images",
        "style",
    ] {
        if object.get(key).is_some_and(Value::is_null) {
            object.remove(key);
        }
    }
    if body.get("style").is_some() {
        return Err(image_invalid(
            "style is not supported because this gateway uses the Responses image-generation tool.",
            "style",
        ));
    }
    let prompt = body["prompt"]
        .as_str()
        .filter(|s| !s.trim_matches(js_whitespace).is_empty())
        .ok_or_else(|| image_invalid("Image requests must include a prompt.", "prompt"))?;
    if prompt.chars().count() > 32_000 {
        return Err(image_invalid(
            "prompt must contain no more than 32000 characters.",
            "prompt",
        ));
    }
    if body.get("model").is_some_and(|v| {
        v.as_str()
            .is_none_or(|s| s.trim_matches(js_whitespace).is_empty())
    }) {
        return Err(image_invalid("model must be a non-empty string.", "model"));
    }
    if body.get("user").is_some_and(|v| !v.is_string()) {
        return Err(image_invalid("user must be a string.", "user"));
    }
    let count = body
        .get("n")
        .map_or(Some(1.0), Value::as_f64)
        .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= 10.0)
        .map(|n| n as u64)
        .ok_or_else(|| image_invalid("n must be an integer from 1 to 10.", "n"))?;
    if body.get("output_compression").is_some_and(|v| {
        !v.as_f64()
            .is_some_and(|n| n.fract() == 0.0 && (0.0..=100.0).contains(&n))
    }) {
        return Err(image_invalid(
            "output_compression must be an integer from 0 to 100.",
            "output_compression",
        ));
    }
    if body.get("size").is_some_and(|v| {
        v.as_str()
            .is_none_or(|s| s.trim_matches(js_whitespace).is_empty())
    }) {
        return Err(image_invalid("size must be a non-empty string.", "size"));
    }
    for (key, allowed) in [
        ("quality", ["low", "medium", "high", "auto"].as_slice()),
        ("background", ["transparent", "opaque", "auto"].as_slice()),
        ("output_format", ["png", "jpeg", "webp"].as_slice()),
        ("moderation", ["low", "auto"].as_slice()),
        ("input_fidelity", ["low", "high"].as_slice()),
    ] {
        if body
            .get(key)
            .is_some_and(|v| v.as_str().is_none_or(|v| !allowed.contains(&v)))
        {
            return Err(image_invalid(
                match key {
                    "quality" => format!(
                        "quality must be low, medium, high, or auto{}.",
                        if edit { " for image edits" } else { "" }
                    ),
                    "background" => "background must be transparent, opaque, or auto.".into(),
                    "output_format" => "output_format must be png, jpeg, or webp.".into(),
                    "moderation" => "moderation must be low or auto.".into(),
                    _ => "input_fidelity must be low or high.".into(),
                },
                key,
            ));
        }
    }
    if body.get("stream").is_some_and(|v| !v.is_boolean()) {
        return Err(image_invalid("stream must be a boolean.", "stream"));
    }
    if body["stream"] == true || body.get("partial_images").is_some() {
        return Err(image_invalid(
            "Streaming image responses are not supported by this gateway.",
            if body["stream"] == true {
                "stream"
            } else {
                "partial_images"
            },
        ));
    }
    if body.get("response_format").is_some_and(|v| v != "b64_json") {
        return Err(image_invalid(
            "response_format must be b64_json.",
            "response_format",
        ));
    }
    Ok((body, count))
}
fn validate_multipart_scalars(raw: &Value) -> Result<(), GatewayError> {
    validate_image_scalars(raw, true, true).map(|_| ())
}
fn parse_image_inner(
    raw: &Value,
    edit: bool,
    multipart: bool,
) -> Result<ParsedImageRequest, GatewayError> {
    let (mut body, count) = validate_image_scalars(raw, edit, multipart)?;
    if edit {
        let images = body["images"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 16)
            .ok_or_else(|| {
                image_invalid(
                    "images must contain from 1 to 16 image references.",
                    "images",
                )
            })?;
        if !multipart {
            let normalized = images
                .iter()
                .map(|v| normalize_image_reference(v, false))
                .collect::<Result<Vec<_>, _>>()?;
            body["images"] = json!(normalized);
            if let Some(mask) = body.get("mask") {
                body["mask"] = normalize_image_reference(mask, true)?;
            }
        }
    }
    let input_bytes = image_input_bytes(&body);
    if input_bytes > 50 * 1024 * 1024 / count as usize {
        return Err(image_invalid(
            if multipart {
                "n and multipart image inputs exceed the 50 MiB request work limit."
            } else {
                "n and inline image inputs exceed the 50 MiB request work limit."
            },
            "n",
        ));
    }
    Ok(ParsedImageRequest {
        body,
        count,
        input_bytes,
        edit,
    })
}

/// Opaque validated image input; a host model is selected only after parsing.
#[derive(Clone, Debug)]
pub struct ParsedImageRequest {
    body: Value,
    count: u64,
    input_bytes: usize,
    edit: bool,
}
impl ParsedImageRequest {
    pub fn count(&self) -> u64 {
        self.count
    }
    pub fn input_bytes(&self) -> usize {
        self.input_bytes
    }
}
pub fn parse_image(raw: &Value, edit: bool) -> Result<ParsedImageRequest, GatewayError> {
    parse_image_inner(raw, edit, false)
}
fn prepare_image_inner(
    raw: &Value,
    base_model: &str,
    edit: bool,
    request_id: &str,
    multipart: bool,
) -> Result<ImagePlan, GatewayError> {
    let parsed = parse_image_inner(raw, edit, multipart)?;
    Ok(prepare_parsed_image(&parsed, base_model, request_id))
}
pub fn prepare_parsed_image(
    parsed: &ParsedImageRequest,
    base_model: &str,
    request_id: &str,
) -> ImagePlan {
    let edit = parsed.edit;
    let body = &parsed.body;
    let count = parsed.count;
    let prompt = body["prompt"].as_str().expect("validated image prompt");
    let mut tool = json!({"type":"image_generation","action":if edit{"edit"}else{"generate"}});
    if let Some(model) = body["model"].as_str() {
        tool["model"] = json!(model.trim_matches(js_whitespace));
    } else if edit {
        tool["model"] = json!("gpt-image-1.5");
    }
    for key in [
        "size",
        "quality",
        "background",
        "output_format",
        "output_compression",
        "moderation",
    ] {
        if let Some(value) = body.get(key) {
            tool[key] = value.clone();
        }
    }
    let input = if edit {
        let mut content = vec![json!({"type":"input_text","text":prompt})];
        for image in body["images"].as_array().expect("validated image inputs") {
            content.push(json!({"type":"input_image","image_url":image["image_url"]}));
        }
        if let Some(mask) = body.get("mask") {
            tool["input_image_mask"] = mask.clone();
        }
        if let Some(value) = body.get("input_fidelity") {
            tool["input_fidelity"] = value.clone();
        }
        json!([{"role":"user","content":content}])
    } else {
        json!(prompt)
    };
    let mut responses = json!({"model":base_model,"input":input,"tools":[tool],"tool_choice":{"type":"image_generation"}});
    if let Some(user) = body.get("user") {
        responses["user"] = user.clone();
    }
    let kind = if edit { "edits" } else { "generations" };
    let request_ids = (0..count)
        .map(|i| {
            if i == 0 {
                request_id.into()
            } else {
                format!("{request_id}:image:{kind}:{}", i + 1)
            }
        })
        .collect();
    ImagePlan {
        responses,
        count,
        request_ids,
        codex_only: true,
    }
}
fn image_invalid(message: impl Into<String>, param: &str) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_request_error"))
        .with_param((!param.is_empty()).then_some(param))
}

pub fn normalize_image_reference(value: &Value, mask: bool) -> Result<Value, GatewayError> {
    let failure = || {
        image_invalid(
            if mask {
                "mask.image_url must be a supported base64 PNG data URL; remote URLs and file_id are unsupported by this gateway."
            } else {
                "Each image must contain one image_url with a fully qualified HTTP(S) URL or supported base64 data URL; file_id is unsupported by this gateway."
            },
            if mask { "mask" } else { "images" },
        )
    };
    let object = value
        .as_object()
        .filter(|o| o.keys().all(|k| k == "image_url"))
        .ok_or_else(failure)?;
    let original = object
        .get("image_url")
        .and_then(Value::as_str)
        .filter(|s| s.encode_utf16().count() <= 20_971_520)
        .ok_or_else(failure)?;
    let url = original.trim_matches(js_whitespace);
    if url.is_empty() {
        return Err(failure());
    }
    if url
        .get(..5)
        .is_some_and(|v| v.eq_ignore_ascii_case("data:"))
    {
        let (media, encoded) = url[5..].split_once(';').ok_or_else(failure)?;
        if media.contains(',')
            || !encoded
                .get(..7)
                .is_some_and(|s| s.eq_ignore_ascii_case("base64,"))
        {
            return Err(failure());
        }
        let payload = &encoded[7..];
        let media = match media
            .trim_matches(js_whitespace)
            .to_ascii_lowercase()
            .as_str()
        {
            "image/png" | "image/x-png" => "image/png",
            "image/jpeg" | "image/jpg" => "image/jpeg",
            "image/webp" => "image/webp",
            _ => return Err(failure()),
        };
        let content = payload.trim_end_matches('=');
        let padding = payload.len() - content.len();
        if payload.is_empty()
            || payload.len() % 4 != 0
            || padding > 2
            || !content
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/'))
        {
            return Err(failure());
        }
        let bytes = payload.len() / 4 * 3 - padding;
        if bytes == 0 || bytes >= 50 * 1024 * 1024 || (mask && media != "image/png") {
            return Err(failure());
        }
        Ok(json!({"image_url":format!("data:{media};base64,{payload}")}))
    } else if !mask {
        if !["http://", "https://"].iter().any(|scheme| {
            url.get(..scheme.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
        }) {
            return Err(failure());
        }
        let parsed = url::Url::parse(url).map_err(|_| failure())?;
        if !["http", "https"].contains(&parsed.scheme()) || parsed.host_str().is_none() {
            return Err(failure());
        }
        Ok(json!({"image_url":url}))
    } else {
        Err(failure())
    }
}
pub fn extract_images(payload: &Value) -> Vec<Value> {
    payload["output"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["type"] == "image_generation_call")
        .filter_map(|v| {
            v["result"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|result| {
                    let mut image = json!({"b64_json":result});
                    if let Some(prompt) = v["revised_prompt"].as_str() {
                        image["revised_prompt"] = json!(prompt);
                    }
                    image
                })
        })
        .collect()
}
#[derive(Clone, Debug)]
pub struct MultipartFile {
    pub name: String,
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}
pub fn multipart_image_references(
    files: &[MultipartFile],
) -> Result<(Vec<Value>, Option<Value>), GatewayError> {
    let mut images = vec![];
    let mut mask = None;
    let mut total = 0;
    for file in files {
        total += file.bytes.len();
        if file.bytes.is_empty() || file.bytes.len() >= 50 * 1024 * 1024 || total > 50 * 1024 * 1024
        {
            return Err(image_invalid(
                "Image files exceed the 50 MiB input limit",
                "image",
            ));
        }
        let declared = file
            .content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim_matches(js_whitespace)
            .to_lowercase();
        let declared = if declared.is_empty() || declared == "application/octet-stream" {
            let filename = file.filename.trim_matches(js_whitespace).to_lowercase();
            if filename.ends_with(".png") {
                "image/png".into()
            } else if filename.ends_with(".jpg") || filename.ends_with(".jpeg") {
                "image/jpeg".into()
            } else if filename.ends_with(".webp") {
                "image/webp".into()
            } else {
                declared
            }
        } else {
            declared
        };
        let media = match declared
            .split(';')
            .next()
            .unwrap_or("")
            .trim_matches(js_whitespace)
            .to_lowercase()
            .as_str()
        {
            "image/png" | "image/x-png" => "image/png",
            "image/jpeg" | "image/jpg" => "image/jpeg",
            "image/webp" => "image/webp",
            _ => return Err(image_invalid("Unsupported image media type", "image")),
        };
        let reference =
            json!({"image_url":format!("data:{media};base64,{}",base64_encode(&file.bytes))});
        match file.name.as_str() {
            "image" | "image[]" => images.push(reference),
            "mask" if mask.is_none() && media == "image/png" => mask = Some(reference),
            _ => return Err(image_invalid("Invalid multipart image field", "image")),
        }
    }
    if images.is_empty() || images.len() > 16 {
        return Err(image_invalid(
            "image must contain from 1 to 16 files.",
            "image",
        ));
    }
    Ok((images, mask))
}

fn image_input_bytes(body: &Value) -> usize {
    body["images"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(body.get("mask"))
        .map(|v| {
            let url = v["image_url"].as_str().unwrap_or("");
            if let Some((_, payload)) = url.split_once(";base64,") {
                payload.len() / 4 * 3 - payload.chars().rev().take_while(|c| *c == '=').count()
            } else {
                url.len()
            }
        })
        .sum()
}
pub fn parse_multipart_image(
    raw: &Value,
    files: &[MultipartFile],
) -> Result<ParsedImageRequest, GatewayError> {
    let raw = raw
        .as_object()
        .ok_or_else(|| image_invalid("Image edits must include valid multipart form data.", ""))?;
    let allowed = [
        "model",
        "prompt",
        "n",
        "size",
        "quality",
        "background",
        "output_format",
        "output_compression",
        "stream",
        "partial_images",
        "user",
        "input_fidelity",
        "response_format",
    ];
    let mut body = Value::Object(raw.clone());
    for file in files {
        if !["image", "image[]", "mask"].contains(&file.name.as_str()) {
            return Err(image_invalid(
                format!("Unsupported image edit field: {}.", file.name),
                &file.name,
            ));
        }
    }
    for (key, value) in raw {
        if !allowed.contains(&key.as_str()) {
            return Err(image_invalid(
                format!("Unsupported image edit field: {key}."),
                key,
            ));
        }
        if let Some(text) = value.as_str() {
            let trimmed = text.trim_matches(js_whitespace);
            if ["n", "partial_images"].contains(&key.as_str()) {
                if !trimmed.is_empty()
                    && trimmed.bytes().all(|v| v.is_ascii_digit())
                    && (trimmed == "0" || !trimmed.starts_with('0'))
                    && let Ok(value) = serde_json::from_str::<Value>(trimmed)
                {
                    body[key] = value;
                }
            } else if key == "output_compression" {
                if let Ok(value) = serde_json::from_str::<Value>(trimmed)
                    && value.is_number()
                {
                    body[key] = value;
                }
            } else if key == "stream" && ["true", "false"].contains(&trimmed) {
                body[key] = json!(trimmed == "true");
            }
        }
    }
    // Scalar validation precedes file selection in the source. Images are not
    // required until after scalar validation, so use the same private front end.
    validate_multipart_scalars(&body)?;
    let (images, mask) = multipart_image_references(files)?;
    body["images"] = json!(images);
    if let Some(mask) = mask {
        body["mask"] = mask;
    }
    parse_image_inner(&body, true, true)
}
pub fn prepare_multipart_image(
    raw: &Value,
    files: &[MultipartFile],
    base_model: &str,
    request_id: &str,
) -> Result<ImagePlan, GatewayError> {
    let parsed = parse_multipart_image(raw, files)?;
    Ok(prepare_parsed_image(&parsed, base_model, request_id))
}
