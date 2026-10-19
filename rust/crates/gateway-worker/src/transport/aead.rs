//! Actual Worker WebCrypto AES-GCM for the source embeddings job envelope.
use gateway_core::GatewayError;
use worker::js_sys::{Array, ArrayBuffer, Function, Object, Promise, Reflect, Uint8Array};
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::wasm_bindgen_futures::JsFuture;

pub async fn encrypt(
    key: &[u8; 32],
    iv: &[u8; 12],
    plaintext: &[u8],
) -> Result<Vec<u8>, GatewayError> {
    transform("encrypt", key, iv, plaintext).await
}

pub async fn decrypt(
    key: &[u8; 32],
    iv: &[u8],
    ciphertext_and_tag: &[u8],
) -> Result<Vec<u8>, GatewayError> {
    transform("decrypt", key, iv, ciphertext_and_tag).await
}

async fn transform(
    operation: &str,
    raw_key: &[u8; 32],
    iv: &[u8],
    data: &[u8],
) -> Result<Vec<u8>, GatewayError> {
    let crypto = Reflect::get(&worker::js_sys::global(), &JsValue::from_str("crypto"))
        .map_err(|_| unavailable())?;
    let subtle = Reflect::get(&crypto, &JsValue::from_str("subtle")).map_err(|_| unavailable())?;
    let usages = Array::new();
    usages.push(&JsValue::from_str(operation));
    let import = Array::new();
    import.push(&JsValue::from_str("raw"));
    import.push(&Uint8Array::from(raw_key.as_slice()));
    import.push(&JsValue::from_str("AES-GCM"));
    import.push(&JsValue::FALSE);
    import.push(&usages);
    let key = call(&subtle, "importKey", &import).await?;
    let algorithm = Object::new();
    Reflect::set(
        &algorithm,
        &JsValue::from_str("name"),
        &JsValue::from_str("AES-GCM"),
    )
    .map_err(|_| unavailable())?;
    Reflect::set(&algorithm, &JsValue::from_str("iv"), &Uint8Array::from(iv))
        .map_err(|_| unavailable())?;
    Reflect::set(
        &algorithm,
        &JsValue::from_str("tagLength"),
        &JsValue::from(128),
    )
    .map_err(|_| unavailable())?;
    let arguments = Array::new();
    arguments.push(&algorithm);
    arguments.push(&key);
    arguments.push(&Uint8Array::from(data));
    let bytes = call(&subtle, operation, &arguments)
        .await?
        .dyn_into::<ArrayBuffer>()
        .map_err(|_| unavailable())?;
    Ok(Uint8Array::new(&bytes).to_vec())
}

async fn call(
    receiver: &JsValue,
    method: &str,
    arguments: &Array,
) -> Result<JsValue, GatewayError> {
    let function = Reflect::get(receiver, &JsValue::from_str(method))
        .map_err(|_| unavailable())?
        .dyn_into::<Function>()
        .map_err(|_| unavailable())?;
    let promise = Reflect::apply(&function, receiver, arguments)
        .map_err(|_| unavailable())?
        .dyn_into::<Promise>()
        .map_err(|_| unavailable())?;
    JsFuture::from(promise).await.map_err(|_| unavailable())
}

fn unavailable() -> GatewayError {
    GatewayError::new(
        500,
        "Embeddings authenticated encryption is unavailable or invalid.",
        Some("embeddings_crypto_unavailable"),
    )
    .with_type("server_error")
}
