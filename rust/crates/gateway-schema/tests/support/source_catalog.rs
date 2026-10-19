use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};
use gateway_schema::aliases::SourceStringCollator;
use serde::{Deserialize, Serialize};

pub fn json<T: Serialize + ?Sized>(value: &T) -> SourceJson {
    SourceJson::from_serializable(value).unwrap()
}
#[derive(Deserialize)]
struct Matrix {
    ids: Vec<Vec<u16>>,
    signs: Vec<Vec<i32>>,
}
/// Explicit finite source oracle, not a native collation implementation.
/// Every operand must occur in the captured pinned-Bun matrix.
pub struct Collator(Matrix);
impl Collator {
    pub fn captured() -> Self {
        Self(serde_json::from_str(include_str!("../fixtures/source-catalog-sort-v1.json")).unwrap())
    }
}
impl SourceStringCollator for Collator {
    fn compare(
        &self,
        left: &JsString16,
        right: &JsString16,
    ) -> Result<std::cmp::Ordering, GatewayError> {
        let lookup = |value: &JsString16| self.0.ids.iter().position(|id| id == value.as_units());
        let (Some(left), Some(right)) = (lookup(left), lookup(right)) else {
            return Err(GatewayError::unavailable(
                "Unknown finite catalog oracle operand.",
                "source_catalog_oracle_unknown_pair",
            ));
        };
        Ok(self.0.signs[left][right].cmp(&0))
    }
}
