//! Trusted platform collation only; alias policy remains in the shared Rust resolver.
use std::{
    cmp::Ordering,
    sync::{Arc, OnceLock},
};

use gateway_core::{GatewayError, js_string::JsString16};
use gateway_schema::aliases::SourceStringCollator;
#[cfg(target_arch = "wasm32")]
use worker::{
    js_sys::{Array, Intl, JsString, Object},
    wasm_bindgen::JsValue,
};

pub(crate) struct PlatformSourceStringCollator;

pub(crate) fn shared() -> Arc<dyn SourceStringCollator> {
    static COLLATOR: OnceLock<Arc<dyn SourceStringCollator>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| Arc::new(PlatformSourceStringCollator))
        .clone()
}

#[cfg(target_arch = "wasm32")]
fn exact_string(value: &JsString16) -> JsString {
    let mut text = JsString::from("");
    for chunk in value.as_units().chunks(1024) {
        let part = JsString::from_char_code(chunk);
        text = text.concat(part.as_ref());
    }
    text
}

impl SourceStringCollator for PlatformSourceStringCollator {
    #[cfg(not(target_arch = "wasm32"))]
    fn compare(&self, left: &JsString16, right: &JsString16) -> Result<Ordering, GatewayError> {
        let _ = (left, right);
        Err(unavailable())
    }
    #[cfg(target_arch = "wasm32")]
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

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    #[test]
    fn shared_holder_is_identical_and_native_platform_absence_is_an_error() {
        let left = super::shared();
        let right = super::shared();
        assert!(std::sync::Arc::ptr_eq(&left, &right));
        assert!(
            left.compare(
                &gateway_core::js_string::JsString16::from_units(vec![0xd800]),
                &gateway_core::js_string::JsString16::from_utf8("other"),
            )
            .is_err()
        );
    }
}
