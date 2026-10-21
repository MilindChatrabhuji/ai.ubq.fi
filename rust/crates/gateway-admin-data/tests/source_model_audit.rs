use gateway_admin_data::migration::{
    ObservedRow,
    audit::{self, Audit},
};
use gateway_core::{
    js_string::JsString16, source_control::encode_source_control_record, source_json::SourceJson,
    source_serialization as source,
};
use serde_json::json;
use std::collections::BTreeMap;

fn rows(default: &str, model: &str) -> Vec<ObservedRow> {
    let snapshot = source::object(vec![(
        "models",
        source::json_array(&[
            source::object(vec![("slug", SourceJson::parse(model).unwrap())]).unwrap(),
        ])
        .unwrap(),
    )])
    .unwrap();
    [
        (
            json!(["default", "model"]),
            SourceJson::parse(default).unwrap(),
        ),
        (json!(["ubq_ai", "codex_models"]), snapshot),
    ]
    .into_iter()
    .map(|(parts, value)| {
        ObservedRow::json(
            parts.as_array().unwrap().clone(),
            encode_source_control_record("source-model", &value, None).unwrap(),
        )
        .unwrap()
    })
    .collect()
}

#[test]
fn source_model_snapshot_matches_actual_units_not_literal_escape_text() {
    for model in [
        r#""\ud800""#,
        r#""\udc00""#,
        r#""\ufffd""#,
        r#""\ud83d\ude00""#,
    ] {
        assert!(
            inspect_model_snapshot(&rows(model, model))
                .unwrap()
                .is_empty()
        );
    }
    let errors = inspect_model_snapshot(&rows(r#""\ud800""#, r#""\\ud800""#)).unwrap();
    let mut expected = "default model is not present in codex model snapshot: "
        .encode_utf16()
        .collect::<Vec<_>>();
    expected.push(0xd800);
    assert_eq!(errors, vec![JsString16::from_units(expected)]);
}

#[test]
fn audit_wire_is_the_original_string_array_with_lossless_model_mismatch() {
    let errors = inspect_model_snapshot(&rows(r#""\ud800""#, r#""different""#)).unwrap();
    let audit = Audit {
        counts: BTreeMap::new(),
        errors: errors.clone(),
    };
    let body = audit.source_json().unwrap();
    let observed = source::member(&body, "errors")
        .unwrap()
        .array_items()
        .unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].deserialize::<JsString16>().unwrap(), errors[0]);
    assert!(observed[0].as_str().starts_with('"'));
    assert_eq!(source::entries(&body).unwrap().len(), 2);
}

#[test]
fn scalar_model_audit_wording_order_and_serialized_bytes_are_unchanged() {
    let errors = inspect_model_snapshot(&rows(r#""missing""#, r#""other""#)).unwrap();
    assert_eq!(
        errors,
        vec![JsString16::from_utf8(
            "default model is not present in codex model snapshot: missing"
        )]
    );
    let audit = Audit {
        counts: BTreeMap::new(),
        errors,
    };
    assert_eq!(audit.source_json().unwrap().as_bytes(), serde_json::to_vec(&json!({"counts":{},"errors":["default model is not present in codex model snapshot: missing"]})).unwrap());
    assert_eq!(
        audit.error_message("prefix: ").try_utf8().unwrap(),
        "prefix: default model is not present in codex model snapshot: missing"
    );
}

// Independent decoded row lifetimes model the replayable native spool contract.
struct Replay<'a>(&'a [ObservedRow]);
impl audit::AuditInventory for Replay<'_> {
    fn visit(
        &self,
        callback: &mut dyn FnMut(&ObservedRow) -> Result<(), gateway_core::GatewayError>,
    ) -> Result<(), gateway_core::GatewayError> {
        for row in self.0 {
            let decoded = row.clone();
            callback(&decoded)?;
        }
        Ok(())
    }
}
fn inspect_model_snapshot(
    rows: &[ObservedRow],
) -> Result<Vec<JsString16>, gateway_core::GatewayError> {
    let result = audit::inspect_model_snapshot(rows);
    let replay = audit::inspect_model_inventory(&Replay(rows));
    assert_eq!(format!("{result:?}"), format!("{replay:?}"));
    result
}
