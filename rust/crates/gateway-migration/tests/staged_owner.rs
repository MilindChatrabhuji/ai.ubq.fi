#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_core::{
    GatewayError, js_string::JsString16, query::*, source_graph::*, state::*, tuple_key::TupleKey,
};
use gateway_migration::{staged::*, *};
use serde_json::{Value, json};
use std::cell::Cell;
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

fn fixture() -> NativeCapture {
    let identity = gateway_auth::provider_credentials::codex_credential_identity(
        "initial-account",
        &gateway_auth::crypto::Secret::new("synthetic-access".into()),
        &gateway_auth::crypto::Secret::new(String::new()),
    );
    let mut capture: NativeCapture =
        serde_json::from_str(include_str!("fixtures/native-source.json")).unwrap();
    let pool = json!({"accounts":[{"account_id":"initial-account","access_token":"synthetic-access","refresh_token":"","updated_at_ms":2200,"native_owner":{"codex_home":"/synthetic/initial-owner","generation_hash":identity.native_generation_hash,"native_refreshed_at":"2026-10-19T00:00:00.000000000Z","managed_source":{"v":2,"generation_hash":"8".repeat(64)}}}],"updated_at_ms":2200});
    capture.entries.push(NativeEntry {
        raw_key: TupleKey::from_record_key(
            &gateway_auth::provider_credentials::codex_source_pool_key(),
        )
        .unwrap()
        .sort_bytes()
        .to_vec(),
        value: NativeValue::SourceGraphV1(graph_transport::to_source_graph(&graph(&pool)).unwrap()),
        revision: capture.data_revision.clone(),
        expiration_ms: -1,
    });
    capture
}

fn manifest_key() -> gateway_core::state::RecordKey {
    gateway_auth::store::key(json!(["uos_ai", "migration", "v3", "manifest"]))
}

struct Target {
    store: SqliteStore,
    binding: StageOwnerBinding,
}

fn sealed(directory: &Directory, name: &str) -> Target {
    let capture = fixture();
    let mut plan = StagePlan::from_prepared(prepare_native(&capture).unwrap()).unwrap();
    let store = SqliteStore::open(&directory.file(name));
    run(execute_staged(&store, plan.begin())).unwrap();
    while let Some(batch) = plan.next_batch().unwrap() {
        run(execute_staged(&store, batch)).unwrap();
    }
    let receipt = run(execute_staged(&store, plan.seal())).unwrap();
    assert!(receipt.sealed && !receipt.owner_bound && !receipt.activation_authorized);
    let manifest = run(store.read(&manifest_key())).unwrap().unwrap();
    let value = manifest.json_value().unwrap();
    let capture_id = value["capture_id"].as_str().unwrap().to_owned();
    let source_git_sha = value["source_git_sha"].as_str().unwrap().to_owned();
    let native = &value["native_revision"];
    let captured_at_ms = value["captured_at_ms"].as_i64().unwrap();
    let source = run(store.read(&gateway_auth::provider_credentials::codex_source_pool_key()))
        .unwrap()
        .unwrap();
    let normalized = run(store.read(&gateway_authority::keys::pool()))
        .unwrap()
        .unwrap();
    let pool =
        gateway_auth::provider_credentials::parse_codex_source_pool(source.json_value().unwrap())
            .unwrap()
            .unwrap();
    let accounts = pool
        .accounts
        .iter()
        .map(|account| {
            let identity = account.identity();
            StageOwnerAccount {
                account_id_hash: identity.routing_account_hash.0,
                access_generation: identity.native_generation_hash,
            }
        })
        .collect();
    let binding = StageOwnerBinding {
        capture_id,
        source_git_sha,
        source_captured_at_ms: captured_at_ms,
        source_native_version: native["version"].as_str().unwrap().into(),
        source_native_sequence: native["sequence"].as_str().unwrap().into(),
        source_pool_revision: source.revision,
        normalized_pool_revision: normalized.revision,
        accounts,
        custody_observed_at_ms: captured_at_ms,
        valid_through_ms: captured_at_ms + 10_000,
        bound_at_ms: captured_at_ms + 1,
        owner_id: "stage-owner".into(),
        owner_epoch: "stage-epoch".into(),
        key_fingerprint: "f".repeat(64),
        owner_revision: "stage-owner-r1".into(),
    };
    Target { store, binding }
}

fn owner(store: &SqliteStore) -> Option<StoredRecord> {
    run(store.read(&gateway_authority::keys::paid_control_owner())).unwrap()
}

#[test]
fn post_seal_owner_binding_is_one_cas_and_exact_retry_reconciles() {
    let directory = Directory::new();
    let target = sealed(&directory, "bound.sqlite3");
    let manifest_before = run(target.store.read(&manifest_key())).unwrap().unwrap();
    let receipt = run(execute_staged(
        &target.store,
        StageRequest::BindOwner(target.binding.clone()),
    ))
    .unwrap();
    assert!(receipt.owner_bound && receipt.sealed && !receipt.activation_authorized);
    let row = owner(&target.store).expect("owner row");
    assert_eq!(row.revision, target.binding.owner_revision);
    assert_eq!(row.expires_at_ms, None);
    assert_eq!(
        row.json_value().unwrap(),
        &json!({
            "v":1,
            "owner_id":"stage-owner",
            "owner_epoch":"stage-epoch",
            "key_fingerprint":"f".repeat(64)
        })
    );
    assert_eq!(
        run(target.store.read(&manifest_key())).unwrap().unwrap(),
        manifest_before
    );
    let retry = run(execute_staged(
        &target.store,
        StageRequest::BindOwner(target.binding.clone()),
    ))
    .unwrap();
    assert!(retry.owner_bound && !retry.activation_authorized);
    assert_eq!(owner(&target.store).unwrap(), row);
}

#[test]
fn owner_binding_refuses_unsealed_wrong_facts_stale_revision_and_duplicate_owner() {
    let directory = Directory::new();
    let target = sealed(&directory, "wrong.sqlite3");
    let empty = SqliteStore::open(&directory.file("unsealed.sqlite3"));
    assert!(
        run(execute_staged(
            &empty,
            StageRequest::BindOwner(target.binding.clone())
        ))
        .is_err()
    );
    assert!(owner(&empty).is_none());
    assert!(owner(&target.store).is_none());
    for mutate in [
        |b: &mut StageOwnerBinding| b.capture_id = "0".repeat(64),
        |b: &mut StageOwnerBinding| b.source_git_sha = "0".repeat(40),
        |b: &mut StageOwnerBinding| b.source_captured_at_ms += 1,
        |b: &mut StageOwnerBinding| b.source_native_sequence = "9".into(),
        |b: &mut StageOwnerBinding| b.source_pool_revision = "stale".into(),
        |b: &mut StageOwnerBinding| b.normalized_pool_revision = "stale".into(),
        |b: &mut StageOwnerBinding| b.accounts[0].account_id_hash = "0".repeat(64),
        |b: &mut StageOwnerBinding| b.accounts[0].access_generation = "0".repeat(64),
        |b: &mut StageOwnerBinding| b.bound_at_ms = 0,
        |b: &mut StageOwnerBinding| b.accounts.push(b.accounts[0].clone()),
    ] {
        let mut binding = target.binding.clone();
        mutate(&mut binding);
        assert!(
            run(execute_staged(
                &target.store,
                StageRequest::BindOwner(binding)
            ))
            .is_err(),
            "invalid owner binding accepted"
        );
        assert!(owner(&target.store).is_none());
    }
    // A different owner row already present is refused without rewriting it.
    let other = StoredRecord::json(
        "other-owner-r1",
        json!({"v":1,"owner_id":"other","owner_epoch":"other","key_fingerprint":"0".repeat(64)}),
        None,
    );
    target
        .store
        .put(gateway_authority::keys::paid_control_owner(), other.clone());
    assert!(
        run(execute_staged(
            &target.store,
            StageRequest::BindOwner(target.binding.clone())
        ))
        .is_err()
    );
    assert_eq!(owner(&target.store).unwrap(), other);
}

struct FaultStore {
    inner: SqliteStore,
    mode: u8,
    commits: Cell<usize>,
}
impl FaultStore {
    fn new(directory: &Directory, name: &str, mode: u8) -> Self {
        Self {
            inner: SqliteStore::open(&directory.file(name)),
            mode,
            commits: Cell::new(0),
        }
    }
}
impl AuthorityStore for FaultStore {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.inner.read(key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let owner_key = gateway_authority::keys::paid_control_owner();
        let owner_commit = transition.mutations.iter().any(
            |mutation| matches!(mutation, RecordMutation::Put { key, .. } if key == &owner_key),
        );
        if owner_commit {
            self.commits.set(self.commits.get() + 1);
            if self.mode == 1 {
                return Err(GatewayError::unavailable(
                    "injected before owner commit",
                    "fixture",
                ));
            }
        }
        let result = self.inner.commit(transition).await?;
        if owner_commit && self.mode == 2 && self.commits.get() == 1 {
            return Err(GatewayError::unavailable(
                "injected lost owner commit response",
                "fixture",
            ));
        }
        Ok(result)
    }
}
impl QueryStore for FaultStore {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        self.inner.query(request).await
    }
}

#[test]
fn owner_binding_rolls_back_on_commit_failure_and_reconciles_a_lost_response() {
    let directory = Directory::new();
    let target = sealed(&directory, "fault.sqlite3");
    let failed = FaultStore::new(&directory, "failed.sqlite3", 1);
    let capture = fixture();
    let mut plan = StagePlan::from_prepared(prepare_native(&capture).unwrap()).unwrap();
    run(execute_staged(&failed, plan.begin())).unwrap();
    while let Some(batch) = plan.next_batch().unwrap() {
        run(execute_staged(&failed, batch)).unwrap();
    }
    run(execute_staged(&failed, plan.seal())).unwrap();
    assert!(
        run(execute_staged(
            &failed,
            StageRequest::BindOwner(target.binding.clone())
        ))
        .is_err()
    );
    assert!(
        run(failed.read(&gateway_authority::keys::paid_control_owner()))
            .unwrap()
            .is_none()
    );

    let lost = FaultStore::new(&directory, "lost.sqlite3", 2);
    let mut plan = StagePlan::from_prepared(prepare_native(&fixture()).unwrap()).unwrap();
    run(execute_staged(&lost, plan.begin())).unwrap();
    while let Some(batch) = plan.next_batch().unwrap() {
        run(execute_staged(&lost, batch)).unwrap();
    }
    run(execute_staged(&lost, plan.seal())).unwrap();
    assert!(
        run(execute_staged(
            &lost,
            StageRequest::BindOwner(target.binding.clone())
        ))
        .is_err()
    );
    let bound = run(lost.read(&gateway_authority::keys::paid_control_owner()))
        .unwrap()
        .unwrap();
    assert_eq!(bound.revision, target.binding.owner_revision);
    let retry = run(execute_staged(
        &lost,
        StageRequest::BindOwner(target.binding.clone()),
    ))
    .unwrap();
    assert!(retry.owner_bound);
    assert_eq!(
        run(lost.read(&gateway_authority::keys::paid_control_owner()))
            .unwrap()
            .unwrap(),
        bound
    );
}

#[test]
fn owner_binding_never_claims_activation_and_preserves_exact_source_inventory() {
    let directory = Directory::new();
    let target = sealed(&directory, "same.sqlite3");
    let before = run(target.store.query(QueryRequest {
        selector: QuerySelector::Prefix {
            prefix: TupleKey::from_parts(&[]).unwrap().to_record_key(),
            start: None,
            end: None,
        },
        reverse: false,
        limit: 10_000,
        cursor: None,
        now_ms: 0,
    }))
    .unwrap();
    let receipt = run(execute_staged(
        &target.store,
        StageRequest::BindOwner(target.binding.clone()),
    ))
    .unwrap();
    assert!(!receipt.activation_authorized);
    assert_eq!(
        serde_json::to_value(&receipt)
            .unwrap()
            .get("atomic_committed"),
        None
    );
    let after = run(target.store.query(QueryRequest {
        selector: QuerySelector::Prefix {
            prefix: TupleKey::from_parts(&[]).unwrap().to_record_key(),
            start: None,
            end: None,
        },
        reverse: false,
        limit: 10_000,
        cursor: None,
        now_ms: 0,
    }))
    .unwrap();
    assert_eq!(after.entries.len(), before.entries.len() + 1);
    let owner_key = gateway_authority::keys::paid_control_owner();
    let mut old = before
        .entries
        .into_iter()
        .map(|entry| (entry.key, entry.record));
    for entry in after.entries {
        if entry.key == owner_key {
            continue;
        }
        let expected = old
            .by_ref()
            .find(|(key, _)| *key == entry.key)
            .expect("original row");
        assert_eq!(expected.1, entry.record);
    }
    assert!(old.next().is_none());
}
