use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use gateway_schema::aliases::SourceStringCollator;
use std::collections::BTreeMap;

pub fn fixture() -> SourceJson {
    SourceJson::parse(include_str!("../fixtures/projection-source-controls.json")).unwrap()
}
pub struct CapturedCollator {
    labels: Vec<Vec<u16>>,
    orders: Vec<Vec<i32>>,
}
impl CapturedCollator {
    pub fn new() -> Self {
        let raw = fixture();
        assert_eq!(
            source::member(&raw, "fixture_only").unwrap().as_str(),
            "true"
        );
        Self {
            labels: source::member(&raw, "labels")
                .unwrap()
                .deserialize()
                .unwrap(),
            orders: source::member(&raw, "orders")
                .unwrap()
                .deserialize()
                .unwrap(),
        }
    }
}
impl SourceStringCollator for CapturedCollator {
    fn compare(
        &self,
        left: &JsString16,
        right: &JsString16,
    ) -> Result<std::cmp::Ordering, GatewayError> {
        let index = |value: &JsString16| {
            self.labels
                .iter()
                .position(|units| units == value.as_units())
        };
        let (Some(a), Some(b)) = (index(left), index(right)) else {
            return Err(GatewayError::unavailable(
                "Fixture-only source comparison was not captured.",
                "fixture_collation_unknown",
            ));
        };
        Ok(self.orders[a][b].cmp(&0))
    }
}
pub fn assert_source_eq(actual: &SourceJson, expected: &SourceJson) {
    if let (Some(a), Some(b)) = (source::string(actual), source::string(expected)) {
        assert_eq!(a, b);
        return;
    }
    if let (Some(a), Some(b)) = (source::number(actual), source::number(expected)) {
        assert_eq!(a, b);
        return;
    }
    if let (Some(a), Some(b)) = (source::array(actual), source::array(expected)) {
        assert_eq!(a.len(), b.len());
        for (a, b) in a.iter().zip(&b) {
            assert_source_eq(a, b);
        }
        return;
    }
    if let (Some(a), Some(b)) = (source::entries(actual), source::entries(expected)) {
        let a: BTreeMap<_, _> = a.into_iter().collect();
        let b: BTreeMap<_, _> = b.into_iter().collect();
        assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>());
        for (k, v) in a {
            assert_source_eq(&v, &b[&k]);
        }
        return;
    }
    assert_eq!(actual.as_str(), expected.as_str());
}
