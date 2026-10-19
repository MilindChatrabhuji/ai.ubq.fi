use super::*;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImagePlan {
    pub responses: SourceJson,
    pub count: u64,
    pub request_ids: Vec<String>,
    pub codex_only: bool,
}
pub(super) fn prepare_image_view(
    raw: &Value,
    base_model: &ModelId,
    edit: bool,
    request_id: &str,
) -> Result<ImagePlan, SourceRequestError> {
    prepare_image_inner(raw, base_model, edit, request_id, false)
}
fn validate_image_scalars(
    raw: &Value,
    edit: bool,
    multipart: bool,
) -> Result<(Value, u64), SourceRequestError> {
    let mut body = raw.clone();
    let object = body
        .as_object()
        .ok_or_else(|| image_invalid("Image requests must use an object body.", ""))?;
    for (key, _) in object {
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
        let valid = shared.iter().any(|name| key_is(key, name))
            || if edit {
                ["images", "mask", "input_fidelity"]
                    .iter()
                    .any(|name| key_is(key, name))
                    || (!multipart && key_is(key, "moderation"))
                    || (multipart && key_is(key, "response_format"))
            } else {
                ["moderation", "response_format", "style"]
                    .iter()
                    .any(|name| key_is(key, name))
            };
        if !valid {
            return Err(keyed_error(
                &format!(
                    "Unsupported image {} field: ",
                    if edit { "edits" } else { "generations" }
                ),
                key,
                ".",
                true,
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
        if body.get(key).is_some_and(Value::is_null) {
            body.remove(key);
        }
    }
    if body.get("style").is_some() {
        return Err(image_invalid(
            "style is not supported because this gateway uses the Responses image-generation tool.",
            "style",
        ));
    }
    let prompt = body["prompt"]
        .as_text()
        .filter(|s| !s.trim_matches(js_whitespace).is_empty())
        .ok_or_else(|| image_invalid("Image requests must include a prompt.", "prompt"))?;
    if char::decode_utf16(prompt.core().as_units().iter().copied()).count() > 32_000 {
        return Err(image_invalid(
            "prompt must contain no more than 32000 characters.",
            "prompt",
        ));
    }
    if body.get("model").is_some_and(|v| {
        v.as_text()
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
        v.as_text()
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
    if body["stream"].as_bool() == Some(true) || body.get("partial_images").is_some() {
        return Err(image_invalid(
            "Streaming image responses are not supported by this gateway.",
            if body["stream"].as_bool() == Some(true) {
                "stream"
            } else {
                "partial_images"
            },
        ));
    }
    if body
        .get("response_format")
        .is_some_and(|v| v.as_str() != Some("b64_json"))
    {
        return Err(image_invalid(
            "response_format must be b64_json.",
            "response_format",
        ));
    }
    Ok((body, count))
}
fn validate_multipart_scalars(raw: &Value) -> Result<(), SourceRequestError> {
    validate_image_scalars(raw, true, true).map(|_| ())
}
fn parse_image_inner(
    raw: &Value,
    edit: bool,
    multipart: bool,
) -> Result<ParsedImageRequest, SourceRequestError> {
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
                .map(|v| normalize_image_reference_view(v, false))
                .collect::<Result<Vec<_>, _>>()?;
            body["images"] = json!(normalized);
            if let Some(mask) = body.get("mask") {
                body["mask"] = normalize_image_reference_view(mask, true)?;
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
pub(super) fn parse_image_view(
    raw: &Value,
    edit: bool,
) -> Result<ParsedImageRequest, SourceRequestError> {
    parse_image_inner(raw, edit, false)
}
fn prepare_image_inner(
    raw: &Value,
    base_model: &ModelId,
    edit: bool,
    request_id: &str,
    multipart: bool,
) -> Result<ImagePlan, SourceRequestError> {
    let parsed = parse_image_inner(raw, edit, multipart)?;
    Ok(prepare_parsed_image(&parsed, base_model, request_id))
}
pub fn prepare_parsed_image(
    parsed: &ParsedImageRequest,
    base_model: &ModelId,
    request_id: &str,
) -> ImagePlan {
    let edit = parsed.edit;
    let body = &parsed.body;
    let count = parsed.count;
    let prompt = body["prompt"].as_text().expect("validated image prompt");
    let mut tool = json!({"type":"image_generation","action":if edit{"edit"}else{"generate"}});
    if let Some(model) = body["model"].as_text() {
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
        json!([json!({"role":"user","content":content})])
    } else {
        json!(prompt)
    };
    let mut responses = json!({"model":base_model,"input":input,"tools":[tool],"tool_choice":json!({"type":"image_generation"})});
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
        responses: source::canonical(
            &responses
                .source()
                .expect("validated generated source image request"),
        )
        .expect("validated source serialization"),
        count,
        request_ids,
        codex_only: true,
    }
}
fn image_invalid(message: impl Into<String>, param: &str) -> SourceRequestError {
    SourceRequestError::from_gateway(
        GatewayError::new(400, message, Some("invalid_request_error"))
            .with_param((!param.is_empty()).then_some(param)),
    )
}

pub(super) fn normalize_image_reference_view(
    value: &Value,
    mask: bool,
) -> Result<Value, SourceRequestError> {
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
        .filter(|object| object.iter().all(|(key, _)| key_is(key, "image_url")))
        .ok_or_else(failure)?;
    let original = object
        .iter()
        .find(|(key, _)| key_is(key, "image_url"))
        .and_then(|(_, value)| value.as_text())
        .filter(|text| text.len() <= 20_971_520)
        .ok_or_else(failure)?;
    let url = original.trim_matches(js_whitespace);
    if url.is_empty() {
        return Err(failure());
    }
    // The existing URL constructor consumes USV text; the returned source URL remains original UTF16.
    let constructor_text = String::from_utf16_lossy(url.core().as_units());
    if constructor_text
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
    {
        let scalar = url.as_str().ok_or_else(failure)?;
        let (media, encoded) = scalar[5..].split_once(';').ok_or_else(failure)?;
        if media.contains(',')
            || !encoded
                .get(..7)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("base64,"))
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
            constructor_text
                .get(..scheme.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
        }) {
            return Err(failure());
        }
        let parsed = url::Url::parse(&constructor_text).map_err(|_| failure())?;
        if !["http", "https"].contains(&parsed.scheme()) || parsed.host_str().is_none() {
            return Err(failure());
        }
        Ok(json!({"image_url":url}))
    } else {
        Err(failure())
    }
}

pub fn multipart_image_references(
    files: &[MultipartFile],
) -> Result<(Vec<Value>, Option<Value>), SourceRequestError> {
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
            let text = v["image_url"]
                .as_text()
                .map(|text| String::from_utf16_lossy(text.core().as_units()))
                .unwrap_or_default();
            let url = text.as_str();
            if let Some((_, payload)) = url.split_once(";base64,") {
                payload.len() / 4 * 3 - payload.chars().rev().take_while(|c| *c == '=').count()
            } else {
                url.len()
            }
        })
        .sum()
}
pub(super) fn parse_multipart_image_view(
    raw: &Value,
    files: &[MultipartFile],
) -> Result<ParsedImageRequest, SourceRequestError> {
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
    let mut body = Value::object(raw.clone());
    for file in files {
        if !["image", "image[]", "mask"].contains(&file.name.as_str()) {
            return Err(image_invalid(
                format!("Unsupported image edit field: {}.", file.name),
                &file.name,
            ));
        }
    }
    for (source_key, value) in raw {
        let Some(key) = allowed
            .iter()
            .copied()
            .find(|name| key_is(source_key, name))
        else {
            return Err(keyed_error(
                "Unsupported image edit field: ",
                source_key,
                ".",
                true,
            ));
        };
        if let Some(text) = value.as_str() {
            let trimmed = text.trim_matches(js_whitespace);
            if ["n", "partial_images"].contains(&key) {
                if !trimmed.is_empty()
                    && trimmed.bytes().all(|v| v.is_ascii_digit())
                    && (trimmed == "0" || !trimmed.starts_with('0'))
                    && let Ok(value) = SourceJson::parse(trimmed).map(Value::from_source)
                {
                    body[key] = value;
                }
            } else if key == "output_compression" {
                if let Ok(value) = SourceJson::parse(trimmed).map(Value::from_source)
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
pub(super) fn prepare_multipart_image_view(
    raw: &Value,
    files: &[MultipartFile],
    base_model: &ModelId,
    request_id: &str,
) -> Result<ImagePlan, SourceRequestError> {
    let parsed = parse_multipart_image_view(raw, files)?;
    Ok(prepare_parsed_image(&parsed, base_model, request_id))
}
