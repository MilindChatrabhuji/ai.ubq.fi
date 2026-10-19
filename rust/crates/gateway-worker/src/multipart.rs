//! Source image-edit parsing using bounded original bytes and real FormData.
use gateway_core::GatewayError;
use gateway_providers::extras::MultipartFile;
use serde_json::{Map, Value};
use worker::js_sys::{Array, Reflect, Uint8Array, try_iter};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{FormData, Method, Request, RequestInit};

pub const IMAGE_JSON_BYTES: usize = (50_usize * 1024 * 1024).div_ceil(3) * 4 + 1024 * 1024;
pub const MULTIPART_BYTES: usize = 64 * 1024 * 1024;
const STRINGS: &[&str] = &[
    "model",
    "prompt",
    "size",
    "quality",
    "background",
    "output_format",
    "input_fidelity",
    "response_format",
    "user",
];
const OTHER: &[&str] = &["stream", "n", "partial_images", "output_compression"];

pub fn image_json(bytes: &[u8]) -> Result<Value, GatewayError> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text).map_err(|_| {
        invalid(
            "Image edits must use a JSON object or multipart form-data body.",
            None,
        )
    })
}

pub async fn parse(
    request: &Request,
    bytes: &[u8],
) -> Result<(Value, Vec<MultipartFile>), GatewayError> {
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(request.headers().clone())
        .with_body(Some(Uint8Array::from(bytes).into()));
    let mut recreated =
        Request::new_with_init(request.url().map_err(|_| invalid_form())?.as_str(), &init)
            .map_err(|_| invalid_form())?;
    let form: FormData = recreated.form_data().await.map_err(|_| invalid_form())?;
    let form: JsValue = form.into();
    let iterator = try_iter(&form)
        .map_err(|_| invalid_form())?
        .ok_or_else(invalid_form)?;
    let mut entries = Vec::new();
    for item in iterator {
        let pair = Array::from(&item.map_err(|_| invalid_form())?);
        let name = pair.get(0).as_string().ok_or_else(invalid_form)?;
        let value = pair.get(1);
        if !STRINGS.contains(&name.as_str())
            && !OTHER.contains(&name.as_str())
            && !["image", "image[]", "mask"].contains(&name.as_str())
        {
            return Err(invalid(
                &format!("Unsupported image edit field: {name}."),
                Some(&name),
            ));
        }
        entries.push((name, value));
    }
    let mut body = Map::new();
    for name in STRINGS {
        if let Some((_, value)) = entries.iter().find(|(key, _)| key == name) {
            let value = value
                .as_string()
                .ok_or_else(|| invalid(&format!("{name} must be a string."), Some(name)))?;
            body.insert((*name).into(), Value::String(value));
        }
    }
    for name in OTHER {
        if let Some((_, value)) = entries.iter().find(|(key, _)| key == name) {
            body.insert(
                (*name).into(),
                value.as_string().map(Value::String).unwrap_or(Value::Null),
            );
        }
    }
    let count = entries
        .iter()
        .filter(|(name, _)| ["image", "image[]"].contains(&name.as_str()))
        .count();
    if !(1..=16).contains(&count) {
        return Err(invalid(
            "image must contain from 1 to 16 files.",
            Some("image"),
        ));
    }
    let masks = entries.iter().filter(|(name, _)| name == "mask").count();
    if masks > 1 {
        return Err(invalid("mask must be one image file.", Some("mask")));
    }
    let mut files = Vec::new();
    for (name, value) in entries
        .into_iter()
        .filter(|(name, _)| ["image", "image[]", "mask"].contains(&name.as_str()))
    {
        let file = value
            .clone()
            .dyn_into::<worker::web_sys::File>()
            .map_err(|_| {
                invalid(
                    if name == "mask" {
                        "mask must be one image file."
                    } else {
                        "Each multipart image entry must be a file."
                    },
                    Some(if name == "mask" { "mask" } else { "image" }),
                )
            })?;
        let filename = Reflect::get(&value, &JsValue::from_str("name"))
            .map_err(|_| invalid_form())?
            .as_string()
            .ok_or_else(invalid_form)?;
        let content_type = Reflect::get(&value, &JsValue::from_str("type"))
            .map_err(|_| invalid_form())?
            .as_string()
            .ok_or_else(invalid_form)?;
        let bytes = worker::File::from(file)
            .bytes()
            .await
            .map_err(|_| invalid_form())?;
        files.push(MultipartFile {
            name,
            filename,
            content_type,
            bytes,
        });
    }
    Ok((Value::Object(body), files))
}
fn invalid_form() -> GatewayError {
    invalid("Image edits must include valid multipart form data.", None)
}
fn invalid(message: &str, param: Option<&str>) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_request_error")).with_param(param)
}
