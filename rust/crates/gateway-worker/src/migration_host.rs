//! Bounded migration bindings; full native capture is private, never a public admin body.
pub mod wire;

use gateway_core::{GatewayError, query::QueryStore};
pub use gateway_migration::MigrationError;
pub use gateway_migration::operational::{NativeMigrationRequest, NativeMigrationResponse};
#[cfg(target_arch = "wasm32")]
use worker::js_sys;

pub async fn execute_profile<S: QueryStore>(
    store: &S,
    request: gateway_admin_runtime::capabilities::MigrationRequest,
    context: gateway_admin_runtime::capabilities::Context,
) -> Result<gateway_auth::AuthResponse, GatewayError> {
    gateway_migration::profile_runtime::execute_profile(store, &ProfileHost, request, context).await
}

struct ProfileHost;
impl gateway_migration::SourceDateHost for ProfileHost {
    fn date_value(&self, input: Option<&serde_json::Value>) -> Result<Option<i64>, GatewayError> {
        let raw = input
            .map(gateway_core::source_json::SourceJson::from_serializable)
            .transpose()?;
        self.source_date_value(raw.as_ref())
    }
    fn source_date_value(
        &self,
        input: Option<&gateway_core::source_json::SourceJson>,
    ) -> Result<Option<i64>, GatewayError> {
        use worker::wasm_bindgen::JsCast;
        let value = input
            .map(|v| worker::js_sys::JSON::parse(v.as_str()))
            .transpose()
            .map_err(|_| {
                GatewayError::unavailable(
                    "Source Date input is invalid",
                    "source_date_host_invalid",
                )
            })?
            .unwrap_or(worker::wasm_bindgen::JsValue::UNDEFINED);
        // A throwing source Date coercion is an error for this line, not the request.
        let invalid =
            || GatewayError::unavailable("Source Date coercion failed", "source_date_host_invalid");
        let constructor = worker::js_sys::Reflect::get(
            &worker::js_sys::global(),
            &worker::wasm_bindgen::JsValue::from_str("Date"),
        )
        .map_err(|_| invalid())?
        .dyn_into::<worker::js_sys::Function>()
        .map_err(|_| invalid())?;
        let arguments = worker::js_sys::Array::new();
        arguments.push(&value);
        let date = worker::js_sys::Reflect::construct(&constructor, &arguments)
            .map_err(|_| invalid())?
            .dyn_into::<worker::js_sys::Date>()
            .map_err(|_| invalid())?;
        let time = date.get_time();
        Ok(time.is_finite().then_some(time as i64))
    }
}
impl gateway_migration::profile_runtime::ProfileHost for ProfileHost {
    fn next_revision(&self) -> Result<String, GatewayError> {
        crate::transport::random::opaque_token()
    }
}

pub async fn execute_native<S: QueryStore>(
    store: &S,
    request: NativeMigrationRequest,
) -> Result<NativeMigrationResponse, MigrationError> {
    gateway_migration::operational::execute_native(store, request).await
}

/// Private host startup export, NOT an HTTP route. The trusted local operator
/// owns the AUTHORITY namespace capability and withholds public traffic until
/// this empty-target adoption settles. Ordinary fetch never calls this export.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn local_operator_adopt(env: worker::Env, input: js_sys::Uint8Array) -> js_sys::Promise {
    worker::wasm_bindgen_futures::future_to_promise(async move {
        local_operator_adoption(env, input)
            .await
            .map(worker::wasm_bindgen::JsValue::from)
    })
}

#[cfg(target_arch = "wasm32")]
async fn local_operator_adoption(
    env: worker::Env,
    input: js_sys::Uint8Array,
) -> Result<js_sys::Uint8Array, worker::wasm_bindgen::JsValue> {
    use gateway_migration::operational::{
        NativeMigrationRequest, NativeOperation, encode_native_response,
    };
    use worker::{js_sys::Uint8Array, wasm_bindgen::JsValue};
    let refused = || JsValue::from_str("private_local_bootstrap_refused");
    if input.length() as usize > gateway_migration::operational::PRIVATE_WIRE_MAX_BYTES {
        return Err(refused());
    }
    // Decode original NativeCapture v2 bytes directly: the shared public
    // request decoder remains unchanged and cannot mint this private setup.
    let capture: gateway_migration::NativeCapture =
        serde_json::from_slice(&input.to_vec()).map_err(|_| refused())?;
    if capture.v != 2 {
        return Err(refused());
    }
    let request = NativeMigrationRequest {
        v: 1,
        request: NativeOperation::AdoptNative { capture },
    };
    let store = crate::authority::RemoteAuthorityStore::from_env(&env).map_err(|_| refused())?;
    let result = execute_native(&store, request)
        .await
        .map_err(|_| refused())?;
    let receipt = encode_native_response(&result).map_err(|_| refused())?;
    Ok(Uint8Array::from(receipt.as_slice()))
}

/// PRIVATE trusted local setup only. No ordinary/public fetch dispatches here.
/// The operator keeps this common target unpublished throughout begin/append/seal.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn local_operator_stage(env: worker::Env, input: js_sys::Uint8Array) -> js_sys::Promise {
    worker::wasm_bindgen_futures::future_to_promise(async move {
        use worker::{js_sys::Uint8Array, wasm_bindgen::JsValue};
        let refused = || JsValue::from_str("private_local_staged_refused");
        if input.length() as usize > gateway_migration::staged::STAGED_BATCH_MAX_BYTES {
            return Err(refused());
        }
        let request = gateway_migration::staged::decode_stage_request(&input.to_vec())
            .map_err(|_| refused())?;
        let store =
            crate::authority::RemoteAuthorityStore::from_env(&env).map_err(|_| refused())?;
        let result = gateway_migration::staged::execute_staged(&store, request)
            .await
            .map_err(|_| refused())?;
        let bytes = serde_json::to_vec(&result).map_err(|_| refused())?;
        Ok(Uint8Array::from(bytes.as_slice()).into())
    })
}
