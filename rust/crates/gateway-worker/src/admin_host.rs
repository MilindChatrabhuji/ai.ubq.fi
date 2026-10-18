//! Finite administrative host bindings. Missing external owners remain explicit.
use std::cmp::Ordering;

use gateway_admin_runtime::{RuntimeConfig, capabilities::RuntimeCapabilities};
use gateway_core::GatewayError;
use gateway_schema::util::js_trim;
use worker::Env;
use worker::js_sys::{Function, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue};

pub fn config(env: &Env) -> RuntimeConfig {
    let raw = crate::host::setting(env, "CLAUDE_CODE_ALLOWED_KEY_IDS").unwrap_or_default();
    let mut ids = Vec::new();
    for value in
        raw.split(|character: char| character == ',' || js_trim(&character.to_string()).is_empty())
    {
        let value = js_trim(value);
        if !value.is_empty() && !ids.iter().any(|old| old == value) {
            ids.push(value.to_owned());
        }
    }
    RuntimeConfig {
        claude_allowed_key_ids: ids,
    }
}

pub struct Capabilities;

impl RuntimeCapabilities for Capabilities {
    fn compare_admin_labels(&self, left: &str, right: &str) -> Result<Ordering, GatewayError> {
        let unavailable = || {
            GatewayError::unavailable(
                "Administrative label collation is unavailable.",
                "admin_label_collation_unavailable",
            )
        };
        let string = Reflect::get(&worker::js_sys::global(), &JsValue::from_str("String"))
            .map_err(|_| unavailable())?;
        let prototype =
            Reflect::get(&string, &JsValue::from_str("prototype")).map_err(|_| unavailable())?;
        let compare = Reflect::get(&prototype, &JsValue::from_str("localeCompare"))
            .map_err(|_| unavailable())?
            .dyn_into::<Function>()
            .map_err(|_| unavailable())?;
        compare
            .call1(&JsValue::from_str(left), &JsValue::from_str(right))
            .map_err(|_| unavailable())?
            .as_f64()
            .and_then(|value| value.partial_cmp(&0.0))
            .ok_or_else(unavailable)
    }
}
