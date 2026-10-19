//! Trusted platform collation only; alias policy remains in the shared Rust resolver.
use std::cmp::Ordering;

use gateway_core::{GatewayError, js_string::JsString16};
use gateway_schema::aliases::SourceStringCollator;
use worker::{
    js_sys::{Array, Intl, JsString, Object},
    wasm_bindgen::JsValue,
};

pub(crate) struct PlatformSourceStringCollator;

fn exact_string(value: &JsString16) -> JsString {
    let mut text = JsString::from("");
    for chunk in value.as_units().chunks(1024) {
        let part = JsString::from_char_code(chunk);
        text = text.concat(part.as_ref());
    }
    text
}

impl SourceStringCollator for PlatformSourceStringCollator {
    fn compare(&self, left: &JsString16, right: &JsString16) -> Result<Ordering, GatewayError> {
        let collator = Intl::Collator::new(&Array::new(), &Object::new());
        let left = exact_string(left);
        let right = exact_string(right);
        let result = collator
            .compare()
            .call2(&JsValue::UNDEFINED, left.as_ref(), right.as_ref())
            .map_err(|_| unavailable())?;
        let value = result
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(unavailable)?;
        Ok(if value < 0.0 {
            Ordering::Less
        } else if value > 0.0 {
            Ordering::Greater
        } else {
            Ordering::Equal
        })
    }
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Platform model collation is unavailable.",
        "model_collation_unavailable",
    )
}
