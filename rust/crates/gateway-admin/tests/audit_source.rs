use gateway_admin::{
    audit::{self, KeyChange, SourceChangeInput},
    reads,
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    query::{QueryEntry, QueryPage, QueryRequest, QueryStore},
    source_json::SourceJson,
    state::{RecordMutation, StoredRecord},
    value::ValueEncoding,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    future::Future,
    task::{Context, Poll, Waker},
};

const NOW: i64 = 1_800_000_000_000;
const ID: &str = "00000000-0000-4000-8000-000000000001";
fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/audit-source-golden.json")).unwrap()
}
fn event(name: Option<&JsString16>, changed: &SourceJson, now_ms: Option<i64>) -> KeyChange {
    audit::build_event(
        SourceChangeInput {
            principal: None,
            request_id: " \trequest\u{feff}",
            action: "create",
            id: "key",
            name,
            changed,
            now_ms,
        },
        || Ok(ID.into()),
        || Ok(NOW),
        || Ok("synthetic-release".into()),
    )
    .unwrap()
}
fn raw_field(value: &SourceJson, field: &str) -> SourceJson {
    value
        .object_entries()
        .unwrap()
        .into_iter()
        .find(|(key, _)| key == &JsString16::from_utf8(field))
        .unwrap()
        .1
}
fn run<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(result) = future.as_mut().poll(&mut context) {
            return result;
        }
        std::thread::yield_now();
    }
}
struct Rows(Vec<QueryEntry>);
impl gateway_core::state::AuthorityStore for Rows {
    async fn read(
        &self,
        key: &gateway_core::state::RecordKey,
    ) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self
            .0
            .iter()
            .find(|entry| &entry.key == key)
            .map(|entry| entry.record.clone()))
    }
    async fn commit(
        &self,
        _: gateway_core::state::AtomicTransition,
    ) -> Result<gateway_core::state::CommitOutcome, GatewayError> {
        Err(GatewayError::unavailable(
            "Audit read fixture refuses writes",
            "fixture_write_denied",
        ))
    }
}
impl QueryStore for Rows {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        assert_eq!(request.limit, 20);
        Ok(QueryPage {
            entries: self.0.clone(),
            next_cursor: Some("source-next".into()),
        })
    }
}

#[test]
fn source_audit_sanitization_uses_own_allowlist_order_and_exact_scalar_values() {
    let fixture = golden();
    assert_eq!(
        fixture["source_sha"],
        "b6e25555179ad2b195b0bab93e946be834ecda6c"
    );
    for row in fixture["fields"].as_array().unwrap() {
        let actual =
            audit::safe_changed_source(&SourceJson::parse(row["input"].as_str().unwrap()).unwrap())
                .unwrap();
        assert_eq!(
            actual.as_str(),
            row["expected"].as_str().unwrap(),
            "{}",
            row["name"]
        );
    }
}

#[test]
fn source_audit_utf16_caps_persist_and_read_lone_surrogates_without_replacement() {
    for row in golden()["names"].as_array().unwrap() {
        let name: JsString16 = SourceJson::parse(row["input"].as_str().unwrap())
            .unwrap()
            .deserialize()
            .unwrap();
        let changed =
            SourceJson::parse(&format!("{{\"name\":{}}}", row["input"].as_str().unwrap())).unwrap();
        let event = event(Some(&name), &changed, None);
        assert_eq!(
            SourceJson::from_serializable(&event.target_key_name)
                .unwrap()
                .as_str(),
            row["expected_name"].as_str().unwrap()
        );
        assert_eq!(
            event.changed.as_str(),
            row["expected_changed"].as_str().unwrap()
        );
        assert_eq!(event.request_id, "request");
        let RecordMutation::Put { key, record } =
            audit::event_mutation(&event, "revision").unwrap()
        else {
            panic!("expected Put")
        };
        let has_lone = event
            .target_key_name
            .as_ref()
            .is_some_and(|value| value.try_utf8().is_err())
            || event.changed.deserialize::<Value>().is_err();
        assert_eq!(
            record.value_encoding,
            if has_lone {
                ValueEncoding::ProfileV2
            } else {
                ValueEncoding::Json
            }
        );
        assert_eq!(record.expires_at_ms, Some(NOW + audit::RETENTION_MS));
        assert_eq!(
            key,
            gateway_auth::store::key(json!([
                "uos_ai",
                "api_keys",
                "change",
                gateway_core::identity::MAX_SAFE_INTEGER - NOW,
                ID
            ]))
        );
        let restored: StoredRecord =
            serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        let decoded = audit::decode_event(&restored).unwrap();
        assert_eq!(decoded.target_key_name, event.target_key_name);
        assert_eq!(decoded.changed, event.changed);
        let response = run(reads::key_changes(
            &Rows(vec![QueryEntry {
                key,
                record: restored,
            }]),
            &BTreeMap::new(),
            NOW,
        ))
        .unwrap();
        let wire = SourceJson::parse_bytes(&response.body.to_bytes().unwrap()).unwrap();
        let data = raw_field(&wire, "data").array_items().unwrap();
        let listed: KeyChange = data[0].deserialize().unwrap();
        assert_eq!(listed.target_key_name, event.target_key_name);
        assert_eq!(listed.changed, event.changed);
        assert_eq!(
            raw_field(&wire, "next_cursor")
                .deserialize::<String>()
                .unwrap(),
            "source-next"
        );
    }
}

#[test]
fn source_audit_visibility_is_timestamp_only_including_exact_cutoff() {
    let fixture = golden();
    let cutoff = fixture["cutoff"].as_i64().unwrap();
    let mut entries = Vec::new();
    let mut expected = 0;
    for (index, row) in fixture["retention"].as_array().unwrap().iter().enumerate() {
        let value = serde_json::from_str(row["input"].as_str().unwrap()).unwrap();
        let record = StoredRecord::json("revision", value, None);
        let retained = audit::retained_event(&record, cutoff).unwrap().is_some();
        assert_eq!(retained, row["expected"].as_bool().unwrap());
        expected += usize::from(retained);
        entries.push(QueryEntry {
            key: gateway_auth::store::key(json!(["uos_ai", "api_keys", "change", index])),
            record,
        });
    }
    let response = run(reads::key_changes(&Rows(entries), &BTreeMap::new(), NOW)).unwrap();
    let body = SourceJson::parse_bytes(&response.body.to_bytes().unwrap()).unwrap();
    assert_eq!(
        raw_field(&body, "data").array_items().unwrap().len(),
        expected
    );
}

#[test]
fn source_audit_uuid_clock_release_order_and_refusal_are_lazy() {
    let changed = SourceJson::parse("{\"reset_usage\":true}").unwrap();
    for failure in ["", "uuid", "clock", "release"] {
        let trace = RefCell::new(Vec::new());
        let source = |name: &'static str| {
            trace.borrow_mut().push(name);
            if failure == name {
                Err(GatewayError::unavailable(
                    "synthetic refusal",
                    "fixture_refusal",
                ))
            } else {
                Ok(())
            }
        };
        let result = audit::build_event(
            SourceChangeInput {
                principal: None,
                request_id: " \u{feff}",
                action: "create",
                id: "key",
                name: None,
                changed: &changed,
                now_ms: None,
            },
            || {
                source("uuid")?;
                Ok(ID.into())
            },
            || {
                source("clock")?;
                Ok(NOW)
            },
            || {
                source("release")?;
                Ok("release".into())
            },
        );
        assert_eq!(result.is_err(), !failure.is_empty());
        let expected = match failure {
            "uuid" => vec!["uuid"],
            "clock" => vec!["uuid", "clock"],
            _ => vec!["uuid", "clock", "release"],
        };
        assert_eq!(*trace.borrow(), expected);
        if let Ok(event) = result {
            assert_eq!(event.request_id, ID);
        }
    }
    let result = audit::build_event(
        SourceChangeInput {
            principal: None,
            request_id: "request",
            action: "create",
            id: "key",
            name: None,
            changed: &changed,
            now_ms: Some(0),
        },
        || Ok(ID.into()),
        || panic!("explicit time must not call clock"),
        || Ok("release".into()),
    )
    .unwrap();
    assert_eq!(result.at_ms, 0);
}
