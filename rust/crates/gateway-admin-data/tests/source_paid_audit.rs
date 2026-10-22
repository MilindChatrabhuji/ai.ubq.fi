use gateway_admin_data::migration::{ObservedRow, audit};
use gateway_core::{
    js_string::JsString16,
    source_control::{
        decode_source_control_record, encode_source_control_record, source_json_tree,
    },
    source_json::SourceJson,
    source_serialization as source,
    state::StoredRecord,
    value::{PortableValue, ValueEncoding},
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn request(model: &str, effort: &str) -> SourceJson {
    let finite = json!({"v":3,"key_id":"fixture-key","request_id":"fixture-attempt","policy_version":"v3:1000","route":"/v1/responses","path":"/v1/responses","stream":false,"window_reset_at_ms":10000,"reserved_microcredits":5,"quota_per_credit":1,"provider":"surplus","provider_request_id":null,"provider_quota":null,"input_tokens":null,"output_tokens":null,"spend_microcredits":null,"dispatch_state":"reserved","terminal_state":"pending","billing_state":"pending","reconciliation_attempts":0,"last_reconciliation_at_ms":null,"dispatched_at_ms":null,"terminal_at_ms":null,"settled_at_ms":null,"created_at_ms":100,"updated_at_ms":100});
    let mut fields = SourceJson::from_serializable(&finite)
        .unwrap()
        .object_entries()
        .unwrap();
    fields.push((
        JsString16::from_utf8("model"),
        SourceJson::parse(model).unwrap(),
    ));
    fields.push((
        JsString16::from_utf8("reasoning"),
        SourceJson::parse(effort).unwrap(),
    ));
    source::object_keys(fields).unwrap()
}
fn row(parts: Value, document: &SourceJson) -> ObservedRow {
    ObservedRow::json(
        parts.as_array().unwrap().clone(),
        encode_source_control_record("source-paid", document, None).unwrap(),
    )
    .unwrap()
}
fn inventory(request: &SourceJson) -> Vec<ObservedRow> {
    vec![
        row(json!(["uos_ai","paid_fallback","v3","window","fixture-key",10000]), &SourceJson::from_serializable(&json!({"v":3,"key_id":"fixture-key","policy_version":"v3:1000","window_reset_at_ms":10000,"limit_microcredits":100,"settled_microcredits":0,"reserved_microcredits":5,"pending_count":1,"updated_at_ms":100})).unwrap()),
        row(json!(["uos_ai","paid_fallback","v3","request","fixture-key","fixture-attempt"]), request),
        row(json!(["uos_ai","paid_fallback","v3","pending","fixture-key","fixture-attempt"]), &SourceJson::parse(r#"{"created_at_ms":100,"next_reconciliation_at_ms":200}"#).unwrap()),
    ]
}
fn inspect(rows: &[ObservedRow]) -> audit::Audit {
    inspect_paid(
        rows,
        &BTreeSet::from(["fixture-key".into()]),
        &BTreeSet::new(),
        100,
    )
    .unwrap()
}

#[test]
fn named_paid_source_audit_retains_utf16_model_effort_and_exact_counter_inventory() {
    for (model, effort) in [
        (r#""\ud800""#, r#""\udc00""#),
        (r#""\ufffd""#, r#""arbitrary-effort""#),
        (r#""\ud83d\ude00""#, r#""\\ud800""#),
    ] {
        let document = request(model, effort);
        assert!(audit::valid_source_paid_request(&document));
        let rows = inventory(&document);
        let original = rows
            .iter()
            .map(|row| row.record.clone())
            .collect::<Vec<_>>();
        let findings = inspect(&rows);
        assert!(findings.errors.is_empty());
        assert_eq!(findings.counts["paid_fallback_v3_requests"], 1);
        assert_eq!(findings.counts["paid_fallback_v3_windows"], 1);
        assert_eq!(findings.counts["paid_fallback_v3_pending"], 1);
        let current = decode_source_control_record(&rows[1].record).unwrap();
        for field in ["model", "reasoning"] {
            assert_eq!(
                source_json_tree(&source::member(&current, field).unwrap()).unwrap(),
                source_json_tree(&source::member(&document, field).unwrap()).unwrap()
            );
        }
        assert_eq!(
            rows.iter()
                .map(|row| row.record.clone())
                .collect::<Vec<_>>(),
            original
        );
    }
}

#[test]
fn source_paid_audit_keeps_pending_aggregate_and_malformed_control_refusals() {
    let document = request(r#""\ud800""#, r#""none""#);
    let mut rows = inventory(&document);
    rows.pop();
    assert!(inspect(&rows).errors.iter().any(|error| {
        error
            .try_utf8()
            .is_ok_and(|text| text.contains("missing its pending marker"))
    }));
    rows = inventory(&document);
    rows[0].record.value["reserved_microcredits"] = json!(4);
    assert!(inspect(&rows).errors.iter().any(|error| {
        error
            .try_utf8()
            .is_ok_and(|text| text.contains("window aggregate is inconsistent"))
    }));
    for (model, effort) in [
        ("null", r#""none""#),
        (r#""""#, "null"),
        (r#""scalar""#, r#""""#),
        ("123", r#""none""#),
    ] {
        let malformed = request(model, effort);
        assert!(!audit::valid_source_paid_request(&malformed));
        assert!(inspect(&inventory(&malformed)).errors.iter().any(|error| {
            error
                .try_utf8()
                .is_ok_and(|text| text.contains("request is malformed"))
        }));
    }
    let mut missing = document.object_entries().unwrap();
    missing.retain(|(key, _)| {
        key.as_units()
            .iter()
            .copied()
            .ne("reasoning".encode_utf16())
    });
    assert!(!audit::valid_source_paid_request(
        &source::object_keys(missing).unwrap()
    ));
}

#[test]
fn scalar_paid_source_stays_json_and_wrong_physical_codec_is_not_reinterpreted() {
    let document = request(r#""scalar-model""#, "null");
    let mut rows = inventory(&document);
    assert_eq!(rows[1].record.value_encoding, ValueEncoding::Json);
    assert_eq!(
        rows[1].record.value,
        document.deserialize::<Value>().unwrap()
    );
    assert!(inspect(&rows).errors.is_empty());
    rows[1].record = StoredRecord::profile(
        "incompatible",
        PortableValue::String("not-json".into()),
        None,
    )
    .unwrap();
    assert!(
        inspect_paid(
            &rows,
            &BTreeSet::from(["fixture-key".into()]),
            &BTreeSet::new(),
            100
        )
        .is_err()
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
fn inspect_paid(
    rows: &[ObservedRow],
    known: &BTreeSet<String>,
    unlimited: &BTreeSet<String>,
    now: i64,
) -> Result<audit::Audit, gateway_core::GatewayError> {
    let result = audit::inspect_paid(rows, known, unlimited, now);
    let replay = audit::inspect_paid_inventory(&Replay(rows), known, unlimited, now);
    assert_eq!(format!("{result:?}"), format!("{replay:?}"));
    result
}
