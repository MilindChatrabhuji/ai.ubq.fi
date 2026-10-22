use super::*;
use gateway_core::{
    js_string::JsString16,
    model::ModelId,
    value::{PortableValue, ValueEncoding},
};
use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    future::Future,
    rc::Rc,
    task::{Context, Poll, Waker},
};

#[derive(Clone, Default)]
struct Store {
    rows: Rc<RefCell<BTreeMap<String, StoredRecord>>>,
    sequence: Rc<Cell<u64>>,
    reads: Rc<Cell<usize>>,
}
impl TokenSource for Store {
    fn next_token(&self) -> Result<String, GatewayError> {
        let next = self.sequence.get() + 1;
        self.sequence.set(next);
        Ok(format!("new-{next}"))
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.reads.set(self.reads.get() + 1);
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let mut rows = self.rows.borrow_mut();
        if transition.checks.iter().any(|check| {
            rows.get(&check.key.0).map(|row| &row.revision) != check.expected_revision.as_ref()
        }) {
            return Ok(CommitOutcome::Conflict);
        }
        for mutation in transition.mutations {
            match mutation {
                RecordMutation::Put { key, record } => {
                    rows.insert(key.0, record);
                }
                RecordMutation::Delete { key } => {
                    rows.remove(&key.0);
                }
            }
        }
        Ok(CommitOutcome::Committed)
    }
}
fn run<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Control {
    v: u8,
    model: ModelId,
    reasoning: Option<JsString16>,
}
fn control(units: &[u16]) -> Control {
    Control {
        v: 1,
        model: ModelId::from_source(JsString16::from_units(units.to_vec())),
        reasoning: Some(JsString16::from_units(units.to_vec())),
    }
}
fn key() -> RecordKey {
    crate::keys::models()
}
fn authority(store: &Store) -> Authority<Store, Store> {
    Authority::new(store.clone(), store.clone())
}

#[test]
fn scalar_source_control_keeps_json_and_default_read_contract() {
    let store = Store::default();
    let authority = authority(&store);
    let mut tx = authority.transaction(100).unwrap();
    assert!(
        run(tx.read_source_control::<Control>(&key()))
            .unwrap()
            .is_none()
    );
    let expected = control(&[97]);
    tx.put_source_control(&key(), &expected, None).unwrap();
    assert!(run(tx.commit()).unwrap());
    assert_eq!(
        store.rows.borrow().get(&key().0).unwrap().value_encoding,
        ValueEncoding::Json
    );
    let mut restarted = authority.transaction(101).unwrap();
    assert_eq!(
        run(restarted.read::<Control>(&key())).unwrap(),
        Some(expected)
    );
    assert_eq!(restarted.expiry(&key()), None);
}

#[test]
fn nested_source_control_keeps_original_units_and_anchored_expiry_on_restart() {
    for units in [
        &[0xd800][..],
        &[0xdc00],
        &[0xfffd],
        &[0xd83d, 0xde00],
        &[92, 117, 100, 56, 48, 48],
    ] {
        let store = Store::default();
        let authority = authority(&store);
        let mut tx = authority.transaction(100).unwrap();
        assert!(
            run(tx.read_source_control::<Control>(&key()))
                .unwrap()
                .is_none()
        );
        let expected = control(units);
        tx.put_source_control(&key(), &expected, Some(500)).unwrap();
        assert!(run(tx.commit()).unwrap());
        let raw = store.rows.borrow().get(&key().0).unwrap().clone();
        assert_eq!(raw.expires_at_ms, Some(500));
        if units == [0xd800] || units == [0xdc00] {
            assert_eq!(raw.value_encoding, ValueEncoding::ProfileV2);
        }
        let mut restarted = authority.transaction(101).unwrap();
        assert_eq!(
            run(restarted.read_source_control::<Control>(&key())).unwrap(),
            Some(expected)
        );
        assert_eq!(restarted.revision(&key()), Some(raw.revision));
        assert_eq!(restarted.expiry(&key()), Some(500));
        if raw.value_encoding == ValueEncoding::ProfileV2 {
            assert!(run(restarted.read::<Control>(&key())).is_err());
        }
    }
}

#[test]
fn source_control_read_caches_once_and_keeps_expired_row_revision_for_cas() {
    let store = Store::default();
    let row = encode_source_control_record(
        "seed",
        &SourceJson::from_serializable(&control(&[0xd800])).unwrap(),
        Some(100),
    )
    .unwrap();
    store.rows.borrow_mut().insert(key().0, row);
    let authority = authority(&store);
    let mut tx = authority.transaction(100).unwrap();
    assert!(
        run(tx.read_source_control::<SourceJson>(&key()))
            .unwrap()
            .is_none()
    );
    assert!(
        run(tx.read_source_control::<Control>(&key()))
            .unwrap()
            .is_none()
    );
    assert_eq!(store.reads.get(), 1);
    assert_eq!(tx.revision(&key()).as_deref(), Some("seed"));
    assert_eq!(tx.expiry(&key()), Some(100));
    tx.put_source_control(&key(), &control(&[0xdc00]), None)
        .unwrap();
    assert!(run(tx.commit()).unwrap());
    assert_eq!(
        store.rows.borrow().get(&key().0).unwrap().expires_at_ms,
        None
    );
}

#[test]
fn source_control_mutation_needs_strong_read_and_rejects_racing_revision() {
    let store = Store::default();
    let authority = authority(&store);
    let mut tx = authority.transaction(100).unwrap();
    assert!(
        tx.put_source_control(&key(), &control(&[97]), None)
            .is_err()
    );
    assert!(
        run(tx.read_source_control::<Control>(&key()))
            .unwrap()
            .is_none()
    );
    tx.put_source_control(&key(), &control(&[0xd800]), Some(500))
        .unwrap();
    let foreign = encode_source_control_record(
        "foreign",
        &SourceJson::from_serializable(&control(&[98])).unwrap(),
        None,
    )
    .unwrap();
    store.rows.borrow_mut().insert(key().0, foreign.clone());
    assert!(!run(tx.commit()).unwrap());
    assert_eq!(store.rows.borrow().get(&key().0), Some(&foreign));
}

#[test]
fn source_control_rejects_unsupported_encoding_non_json_tree_and_wrong_dto() {
    let store = Store::default();
    let authority = authority(&store);
    let rows = [
        StoredRecord::profile("seed", PortableValue::Null, None).unwrap(),
        StoredRecord::profile_v2("seed", PortableValue::Set(vec![]), None).unwrap(),
        StoredRecord::json(
            "seed",
            serde_json::json!({"v":1,"model":"x","reasoning":null,"unexpected":true}),
            None,
        ),
    ];
    for row in rows {
        store.rows.borrow_mut().insert(key().0, row);
        let mut tx = authority.transaction(100).unwrap();
        assert!(run(tx.read_source_control::<Control>(&key())).is_err());
    }
}

#[test]
fn source_control_preserves_authority_metadata_guards() {
    let store = Store::default();
    let authority = authority(&store);
    store.rows.borrow_mut().insert(
        key().0,
        StoredRecord::json(" ", serde_json::json!(null), None),
    );
    assert!(
        run(authority
            .transaction(100)
            .unwrap()
            .read_source_control::<Control>(&key()))
        .is_err()
    );
    store.rows.borrow_mut().clear();
    let mut tx = authority.transaction(100).unwrap();
    run(tx.read_source_control::<Control>(&key())).unwrap();
    assert!(
        tx.put_source_control(&key(), &control(&[97]), Some(-1))
            .is_err()
    );
    store.rows.borrow_mut().insert(
        key().0,
        StoredRecord::json("new-1", serde_json::json!(null), None),
    );
    let mut tx = authority.transaction(100).unwrap();
    run(tx.read_source_control::<SourceJson>(&key())).unwrap();
    assert!(
        tx.put_source_control(&key(), &control(&[97]), None)
            .is_err()
    );
}

#[test]
fn revision_observation_never_reinterprets_payload_or_drops_expired_cas() {
    let store = Store::default();
    let authority = authority(&store);
    let row = StoredRecord::profile_v2("seed", PortableValue::Set(vec![]), Some(100)).unwrap();
    store.rows.borrow_mut().insert(key().0, row);
    let mut tx = authority.transaction(100).unwrap();
    run(tx.observe_revision(&key())).unwrap();
    assert_eq!(tx.revision(&key()).as_deref(), Some("seed"));
    assert_eq!(tx.expiry(&key()), Some(100));
    assert_eq!(tx.checks()[0].expected_revision.as_deref(), Some("seed"));
    let other = crate::keys::paid_routing();
    run(tx.observe_revision(&other)).unwrap();
    assert!(tx.expect(&other, &None));
    tx.put_source_control(&other, &control(&[0xd800]), None)
        .unwrap();
    assert!(run(tx.commit()).unwrap());
    let mut tx = authority.transaction(99).unwrap();
    assert!(run(tx.read_source_control::<SourceJson>(&key())).is_err());
}
