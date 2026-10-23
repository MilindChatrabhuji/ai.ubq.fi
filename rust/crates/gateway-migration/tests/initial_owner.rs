#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_auth::{
    crypto::{Secret, sha256_hex},
    native_auth::{NativeCapability, NativeTransportIdentity},
};
use gateway_authority::initial_control_owner::*;
use gateway_core::{
    GatewayError, js_string::JsString16, query::*, source_graph::*, state::*, tuple_key::TupleKey,
};
use gateway_migration::*;
use serde_json::{Value, json};
use std::{cell::Cell, collections::BTreeSet};
use support::{fixture::*, sqlite_store::*};

fn graph(value: &Value) -> SourceGraph {
    fn atom(value: &Value, nodes: &mut Vec<GraphNode>) -> GraphAtom {
        match value {
            Value::Null => GraphAtom::Null,
            Value::Bool(value) => GraphAtom::Boolean(*value),
            Value::Number(value) => GraphAtom::number(value.as_f64().unwrap()),
            Value::String(value) => GraphAtom::String(JsString16::from_utf8(value)),
            Value::Array(values) => {
                let id = nodes.len() as u32;
                nodes.push(GraphNode::Object { entries: vec![] });
                let entries = values
                    .iter()
                    .enumerate()
                    .map(|(i, value)| (JsString16::from_utf8(&i.to_string()), atom(value, nodes)))
                    .collect();
                nodes[id as usize] = GraphNode::Array {
                    length: values.len() as u32,
                    entries,
                };
                GraphAtom::Ref(id)
            }
            Value::Object(values) => {
                let id = nodes.len() as u32;
                nodes.push(GraphNode::Object { entries: vec![] });
                let entries = values
                    .iter()
                    .map(|(key, value)| (JsString16::from_utf8(key), atom(value, nodes)))
                    .collect();
                nodes[id as usize] = GraphNode::Object { entries };
                GraphAtom::Ref(id)
            }
        }
    }
    let mut nodes = Vec::new();
    let root = atom(value, &mut nodes);
    SourceGraph { root, nodes }
}

struct Fixture {
    prepared: PreparedAdoption,
    payload: Vec<u8>,
    binding: InitialAdoptionBinding,
}
impl Fixture {
    fn new(access: &str, bad_projection: bool) -> Self {
        let identity = gateway_auth::provider_credentials::codex_credential_identity(
            "initial-account",
            &Secret::new(access.into()),
            &Secret::new(String::new()),
        );
        let generation = identity.native_generation_hash;
        let marker = if bad_projection {
            "9".repeat(64)
        } else {
            generation.clone()
        };
        let mut capture: NativeCapture =
            serde_json::from_str(include_str!("fixtures/native-source.json")).unwrap();
        let pool = json!({"accounts":[{"account_id":"initial-account","access_token":access,"refresh_token":"","updated_at_ms":2200,"native_owner":{"codex_home":"/synthetic/initial-owner","generation_hash":marker,"native_refreshed_at":"2026-10-19T00:00:00.000000000Z","managed_source":{"v":2,"generation_hash":"8".repeat(64)}}}],"updated_at_ms":2200});
        capture.entries.push(NativeEntry {
            raw_key: TupleKey::from_record_key(
                &gateway_auth::provider_credentials::codex_source_pool_key(),
            )
            .unwrap()
            .sort_bytes()
            .to_vec(),
            value: NativeValue::SourceGraphV1(
                graph_transport::to_source_graph(&graph(&pool)).unwrap(),
            ),
            revision: capture.data_revision.clone(),
            expiration_ms: -1,
        });
        let payload = serde_json::to_vec(&capture).unwrap();
        let capture_id = sha256_hex(&payload);
        let binding = InitialAdoptionBinding {
            worker_git_sha: "a".repeat(40),
            worker_git_tree: "b".repeat(40),
            authority_namespace_id: "c".repeat(32),
            authority_object_id: "d".repeat(64),
            capture_id: capture_id.clone(),
            source_git_sha: capture.source_git_sha.clone(),
            source_native_version: capture.data_revision.version.clone(),
            source_native_sequence: capture.data_revision.sequence.clone(),
            source_pool_revision: format!(
                "native-v1:{}:{}",
                capture.data_revision.version, capture.data_revision.sequence
            ),
            normalized_pool_revision: format!("capture:{capture_id}"),
            custody: vec![InitialNativeCustodyBinding {
                account_id_hash: identity.routing_account_hash.0,
                native_source_generation: "8".repeat(64),
                access_generation: generation,
            }],
            custody_observed_at_ms: 2200,
            valid_through_ms: 3000,
            owner_revision: "initial-owner-r1".into(),
        };
        Self {
            prepared: prepare_native(&capture).unwrap(),
            payload,
            binding,
        }
    }
    fn ready(
        &self,
        change: impl FnOnce(&mut InitialAdoptionBinding),
        label: &str,
    ) -> PreparedInitialControlOwner {
        let mut binding = self.binding.clone();
        change(&mut binding);
        let identity = NativeTransportIdentity::new(
            format!("key-{label}"),
            format!("owner-{label}"),
            "epoch".into(),
            [71; 32],
            BTreeSet::from([NativeCapability::SupervisorRead]),
        )
        .unwrap();
        InitialControlOwnerDeployment::configured(&identity, binding, sha256_hex(&self.payload))
            .unwrap()
            .prepare(
                &self.payload,
                &"a".repeat(40),
                &"b".repeat(40),
                &"d".repeat(64),
                2300,
            )
            .unwrap()
    }
}

struct Store {
    inner: SqliteStore,
    commits: Cell<usize>,
    mode: u8,
}
impl Store {
    fn new(directory: &Directory, mode: u8) -> Self {
        Self {
            inner: SqliteStore::open(&directory.file("initial.sqlite3")),
            commits: Cell::new(0),
            mode,
        }
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.inner.read(key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        self.commits.set(self.commits.get() + 1);
        if self.mode == 1 {
            return Err(GatewayError::unavailable(
                "injected before atomic commit",
                "fixture",
            ));
        }
        let result = self.inner.commit(transition).await?;
        if self.mode == 2 && self.commits.get() == 1 {
            return Err(GatewayError::unavailable(
                "injected lost commit response",
                "fixture",
            ));
        }
        Ok(result)
    }
}
impl QueryStore for Store {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        self.inner.query(request).await
    }
}

#[test]
fn installation_is_one_complete_atomic_commit_and_exact_retry_does_not_rewrite() {
    let directory = Directory::new();
    let store = Store::new(&directory, 0);
    let fixture = Fixture::new("synthetic-access", false);
    let owner = fixture.ready(|_| {}, "one");
    let result = run(adopt_empty_with_initial_control_owner(
        &store,
        &fixture.prepared,
        &owner,
        2300,
    ))
    .unwrap();
    assert!(matches!(
        result,
        InitialControlOwnerAdoptionReceipt::Installed { .. }
    ));
    assert_eq!(store.commits.get(), 1);
    assert!(
        owner.matches_current_owner(
            run(store.read(&gateway_authority::keys::paid_control_owner()))
                .unwrap()
                .as_ref()
        )
    );
    let result = run(adopt_empty_with_initial_control_owner(
        &store,
        &fixture.prepared,
        &owner,
        2301,
    ))
    .unwrap();
    assert!(matches!(
        result,
        InitialControlOwnerAdoptionReceipt::Reconciled { .. }
    ));
    assert_eq!(store.commits.get(), 1);
    let different = fixture.ready(|_| {}, "different");
    assert!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &fixture.prepared,
            &different,
            2301
        ))
        .is_err()
    );
    let key = gateway_auth::provider_credentials::codex_source_pool_key();
    let mut current = run(store.read(&key)).unwrap().unwrap();
    current.revision = "new-live-source".into();
    store.inner.put(key.clone(), current.clone());
    assert!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &fixture.prepared,
            &owner,
            2301
        ))
        .is_err()
    );
    assert_eq!(run(store.read(&key)).unwrap(), Some(current));
    assert_eq!(store.commits.get(), 1);
}

#[test]
fn wrong_capture_pool_generation_projection_and_expiry_have_no_effect() {
    let fixture = Fixture::new("synthetic-access", false);
    for case in 0..6 {
        let directory = Directory::new();
        let store = Store::new(&directory, 0);
        let owner = fixture.ready(
            |binding| match case {
                0 => binding.capture_id = "0".repeat(64),
                1 => binding.source_pool_revision = "wrong-source".into(),
                2 => binding.normalized_pool_revision = "wrong-pool".into(),
                3 => binding.custody[0].access_generation = "0".repeat(64),
                4 => binding.source_native_sequence = "999".into(),
                _ => {}
            },
            "one",
        );
        let now = if case == 5 { 3001 } else { 2300 };
        assert!(
            run(adopt_empty_with_initial_control_owner(
                &store,
                &fixture.prepared,
                &owner,
                now
            ))
            .is_err()
        );
        assert_eq!(store.commits.get(), 0);
        assert!(
            run(store.read(&gateway_authority::keys::paid_control_owner()))
                .unwrap()
                .is_none()
        );
    }
    let wrong = Fixture::new("synthetic-access", true);
    let owner = wrong.ready(|_| {}, "one");
    let directory = Directory::new();
    let store = Store::new(&directory, 0);
    assert!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &wrong.prepared,
            &owner,
            2300
        ))
        .is_err()
    );
    let changed_body = Fixture::new("different-access", false);
    let original = fixture.ready(|_| {}, "one");
    assert!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &changed_body.prepared,
            &original,
            2300
        ))
        .is_err()
    );
    assert_eq!(store.commits.get(), 0);
}

#[test]
fn capture_after_custody_observation_is_refused_before_effects() {
    let fixture = Fixture::new("synthetic-access", false);
    let owner = fixture.ready(
        |binding| binding.custody_observed_at_ms = 2199,
        "future-capture",
    );
    let directory = Directory::new();
    let store = Store::new(&directory, 0);
    assert!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &fixture.prepared,
            &owner,
            2300
        ))
        .is_err()
    );
    assert_eq!(store.commits.get(), 0);
    assert!(
        run(store.read(&gateway_authority::keys::paid_control_owner()))
            .unwrap()
            .is_none()
    );
}

#[test]
fn occupied_conflicting_and_failed_targets_never_gain_partial_adoption() {
    let fixture = Fixture::new("synthetic-access", false);
    let owner = fixture.ready(|_| {}, "one");
    let directory = Directory::new();
    let store = Store::new(&directory, 1);
    assert!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &fixture.prepared,
            &owner,
            2300
        ))
        .is_err()
    );
    assert!(
        run(store.read(&gateway_authority::keys::paid_control_owner()))
            .unwrap()
            .is_none()
    );
    assert!(
        run(store.read(&gateway_auth::api_keys::id_key("offline-key")))
            .unwrap()
            .is_none()
    );
    let directory = Directory::new();
    let store = Store::new(&directory, 0);
    let key = gateway_authority::keys::paid_control_owner();
    let existing = StoredRecord::json("foreign", json!({"v":1}), None);
    store.inner.put(key.clone(), existing.clone());
    assert!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &fixture.prepared,
            &owner,
            2300
        ))
        .is_err()
    );
    assert_eq!(run(store.read(&key)).unwrap(), Some(existing));
    assert_eq!(store.commits.get(), 0);
    let directory = Directory::new();
    let store = Store::new(&directory, 0);
    *store.inner.before_commit.borrow_mut() = Some((
        key.clone(),
        StoredRecord::json("winning-owner", json!({"v":1}), None),
    ));
    assert!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &fixture.prepared,
            &owner,
            2300
        ))
        .is_err()
    );
    assert_eq!(store.commits.get(), 1);
    assert!(
        run(store.read(&gateway_auth::api_keys::id_key("offline-key")))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        run(store.read(&key)).unwrap().unwrap().revision,
        "winning-owner"
    );
}

#[test]
fn lost_response_reconciles_without_commit_and_ordinary_adoption_stays_owner_free() {
    let fixture = Fixture::new("synthetic-access", false);
    let owner = fixture.ready(|_| {}, "one");
    let directory = Directory::new();
    let store = Store::new(&directory, 2);
    assert!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &fixture.prepared,
            &owner,
            2300
        ))
        .is_err()
    );
    assert!(matches!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &fixture.prepared,
            &owner,
            2301
        ))
        .unwrap(),
        InitialControlOwnerAdoptionReceipt::Reconciled { .. }
    ));
    assert_eq!(store.commits.get(), 1);
    let directory = Directory::new();
    let store = Store::new(&directory, 0);
    run(adopt_empty(&store, &fixture.prepared)).unwrap();
    assert!(
        run(store.read(&gateway_authority::keys::paid_control_owner()))
            .unwrap()
            .is_none()
    );
    assert!(
        run(adopt_empty_with_initial_control_owner(
            &store,
            &fixture.prepared,
            &owner,
            2300
        ))
        .is_err()
    );
    assert_eq!(store.commits.get(), 1);
}
