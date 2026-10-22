//! Thin WebCrypto primitives. Rust authentication code owns every ceremony,
//! key/algorithm policy, challenge, RP, origin, flags and counter decision.

use gateway_core::GatewayError;
use serde_json::Value;
use worker::js_sys::{Array, Function, JSON, Promise, Reflect, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;

pub async fn validate_verification_key(
    jwk: &Value,
    import_algorithm: &Value,
) -> Result<(), GatewayError> {
    import_key(jwk, import_algorithm).await.map(|_| ())
}

pub async fn verify_signature(
    jwk: &Value,
    import_algorithm: &Value,
    verify_algorithm: &Value,
    signature: &[u8],
    data: &[u8],
) -> Result<bool, GatewayError> {
    let (subtle, key) = import_key(jwk, import_algorithm).await?;
    let arguments = Array::new();
    arguments.push(&json_value(verify_algorithm)?);
    arguments.push(&key);
    arguments.push(&Uint8Array::from(signature));
    arguments.push(&Uint8Array::from(data));
    let result = call_promise(&subtle, "verify", &arguments).await?;
    result.as_bool().ok_or_else(crypto_unavailable)
}

async fn import_key(jwk: &Value, algorithm: &Value) -> Result<(JsValue, JsValue), GatewayError> {
    let crypto = Reflect::get(&worker::js_sys::global(), &JsValue::from_str("crypto"))
        .map_err(|_| crypto_unavailable())?;
    let subtle =
        Reflect::get(&crypto, &JsValue::from_str("subtle")).map_err(|_| crypto_unavailable())?;
    let object = jwk.as_object().ok_or_else(invalid_key)?;
    if ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]
        .iter()
        .any(|field| object.contains_key(*field))
    {
        return Err(invalid_key());
    }
    let arguments = Array::new();
    arguments.push(&JsValue::from_str("jwk"));
    arguments.push(&json_value(jwk)?);
    arguments.push(&json_value(algorithm)?);
    arguments.push(&JsValue::FALSE);
    let usages = Array::new();
    usages.push(&JsValue::from_str("verify"));
    arguments.push(&usages);
    let key = call_promise(&subtle, "importKey", &arguments).await?;
    Ok((subtle, key))
}

async fn call_promise(
    receiver: &JsValue,
    method: &str,
    arguments: &Array,
) -> Result<JsValue, GatewayError> {
    let function = Reflect::get(receiver, &JsValue::from_str(method))
        .map_err(|_| crypto_unavailable())?
        .dyn_into::<Function>()
        .map_err(|_| crypto_unavailable())?;
    let promise = Reflect::apply(&function, receiver, arguments)
        .map_err(|_| crypto_unavailable())?
        .dyn_into::<Promise>()
        .map_err(|_| crypto_unavailable())?;
    JsFuture::from(promise).await.map_err(|_| invalid_key())
}

fn json_value(value: &Value) -> Result<JsValue, GatewayError> {
    let json = serde_json::to_string(value).map_err(|_| invalid_key())?;
    JSON::parse(&json).map_err(|_| invalid_key())
}

fn invalid_key() -> GatewayError {
    GatewayError::new(
        400,
        "The credential public key or cryptographic operation is invalid.",
        Some("invalid_webauthn_key"),
    )
}

fn crypto_unavailable() -> GatewayError {
    GatewayError::unavailable(
        "The required WebCrypto primitive is unavailable.",
        "webauthn_crypto_unavailable",
    )
}
