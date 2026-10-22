use gateway_core::GatewayError;
use worker::js_sys::{Function, Reflect, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};

pub fn random_bytes(length: usize) -> Result<Vec<u8>, GatewayError> {
    // getRandomValues has a platform-enforced 65,536-byte request limit.
    if length > 65_536 {
        return Err(unavailable());
    }
    let crypto = Reflect::get(&worker::js_sys::global(), &JsValue::from_str("crypto"))
        .map_err(|_| unavailable())?;
    let function = Reflect::get(&crypto, &JsValue::from_str("getRandomValues"))
        .map_err(|_| unavailable())?
        .dyn_into::<Function>()
        .map_err(|_| unavailable())?;
    let bytes = Uint8Array::new_with_length(length as u32);
    function.call1(&crypto, &bytes).map_err(|_| unavailable())?;
    Ok(bytes.to_vec())
}

/// Random opaque private state revisions/probe tokens, never account fingerprints.
pub fn opaque_token() -> Result<String, GatewayError> {
    let bytes = random_bytes(32)?;
    let mut token = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut token, "{byte:02x}").map_err(|_| unavailable())?;
    }
    Ok(token)
}

pub fn random_uuid() -> Result<String, GatewayError> {
    let crypto = Reflect::get(&worker::js_sys::global(), &JsValue::from_str("crypto"))
        .map_err(|_| unavailable())?;
    let function = Reflect::get(&crypto, &JsValue::from_str("randomUUID"))
        .map_err(|_| unavailable())?
        .dyn_into::<Function>()
        .map_err(|_| unavailable())?;
    function
        .call0(&crypto)
        .map_err(|_| unavailable())?
        .as_string()
        .ok_or_else(unavailable)
}

fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Secure randomness is unavailable.",
        "secure_random_unavailable",
    )
}
