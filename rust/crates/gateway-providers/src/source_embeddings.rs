//! Finite validated embeddings decode controls; ordinary request text is never scalarized.
use crate::{extras::base64_encode, types::*};
use gateway_core::{GatewayError, source_json::SourceJson};
use serde_json::{Value, json};
pub fn decode_embeddings(value: &Value, plan: &DecodePlan) -> Result<SourceJson, GatewayError> {
    // Preparation validated this named profile; decode needs only these finite controls.
    let input = crate::source::get(&plan.request, "input");
    let count = gateway_core::source_serialization::array(&input).map_or(1, |rows| rows.len());
    let dimensions = gateway_core::source_serialization::number(&crate::source::get(
        &plan.request,
        "dimensions",
    ))
    .unwrap_or(1024.0) as u64;
    let encoding_format =
        crate::source::control(&crate::source::get(&plan.request, "encoding_format"))
            .unwrap_or_else(|| "float".into());
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
    let mut body = crate::source::generated(
        &json!({"object":"list","data":data,"usage":{"prompt_tokens":total,"total_tokens":total}}),
    );
    crate::source::set(
        &mut body,
        "model",
        crate::source::quoted(plan.model.as_js_string()),
    );
    Ok(body)
}
