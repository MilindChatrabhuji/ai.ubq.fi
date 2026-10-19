use gateway_admin_data::migration::audit::Audit;
use gateway_core::{GatewayError, js_string::JsString16, source_serialization as source};
use gateway_migration::MigrationError;
use std::collections::BTreeMap;

#[test]
fn source_inventory_error_retains_message_units_without_changing_envelope() {
    let errors = vec![
        JsString16::from_units(vec![0xd800]),
        JsString16::from_units(vec![0xdc00]),
    ];
    let error = MigrationError::SourceInventory(Audit {
        counts: BTreeMap::new(),
        errors,
    });
    assert_eq!(error.status(), 409);
    assert_eq!(error.code(), Some("migration_state_invalid"));
    assert_eq!(
        error.diagnostic(),
        "Complete source inventory validation failed"
    );
    let body = error.source_body().unwrap();
    let envelope = source::member(&body, "error").unwrap();
    assert_eq!(source::entries(&envelope).unwrap().len(), 3);
    let observed = source::member(&envelope, "message")
        .unwrap()
        .deserialize::<JsString16>()
        .unwrap();
    let mut expected = "Complete source inventory validation failed: "
        .encode_utf16()
        .collect::<Vec<_>>();
    expected.extend([0xd800, u16::from(b';'), u16::from(b' '), 0xdc00]);
    assert_eq!(observed.as_units(), expected);
}

#[test]
fn scalar_migration_error_envelope_bytes_remain_exact() {
    let error = MigrationError::SourceInventory(Audit {
        counts: BTreeMap::new(),
        errors: vec!["first".into(), "second".into()],
    });
    let prior = GatewayError::new(
        409,
        "Complete source inventory validation failed: first; second",
        Some("migration_state_invalid"),
    );
    assert_eq!(
        error.source_body().unwrap().as_bytes(),
        serde_json::to_vec(&prior.envelope).unwrap()
    );
    let state = MigrationError::State(prior.clone());
    assert_eq!(state.status(), prior.status);
    assert_eq!(
        state.source_body().unwrap().as_bytes(),
        serde_json::to_vec(&prior.envelope).unwrap()
    );
}
