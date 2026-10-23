#![cfg(all(not(target_arch = "wasm32"), unix))]
mod support;
use gateway_auth::{
    crypto::{Secret, base64url},
    managed_access::ManagedAccessProjection,
    native_credentials::{NativeGeneration, NativeOwnerId, OwnerFence, parse_native_document},
    provider_credentials::*,
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_graph::{GraphAtom, GraphNode, SourceGraph},
    state::*,
    tuple_key::TupleKey,
};
use gateway_migration::*;
use gateway_native::{
    NativeOwnerTransport,
    unix::{NativeOwnerLocation, UnixOwnerTransport},
};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeMap, path::PathBuf};
use support::{fixture::*, sqlite_store::*};

fn graph(value: &Value) -> SourceGraph {
    fn atom(value: &Value, nodes: &mut Vec<GraphNode>) -> GraphAtom {
        match value {
            Value::Null => GraphAtom::Null,
            Value::Bool(v) => GraphAtom::Boolean(*v),
            Value::Number(v) => GraphAtom::number(v.as_f64().unwrap()),
            Value::String(v) => GraphAtom::String(JsString16::from_utf8(v)),
            Value::Array(values) => {
                let id = nodes.len() as u32;
                nodes.push(GraphNode::Object { entries: vec![] });
                let entries = values
                    .iter()
                    .enumerate()
                    .map(|(i, v)| (JsString16::from_utf8(&i.to_string()), atom(v, nodes)))
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
                    .map(|(k, v)| (JsString16::from_utf8(k), atom(v, nodes)))
                    .collect();
                nodes[id as usize] = GraphNode::Object { entries };
                GraphAtom::Ref(id)
            }
        }
    }
    let mut nodes = vec![];
    let root = atom(value, &mut nodes);
    SourceGraph { root, nodes }
}
fn wire(value: &Value) -> NativeValue {
    NativeValue::SourceGraphV1(graph_transport::to_source_graph(&graph(value)).unwrap())
}
fn document(account: &str, serial: u32) -> Value {
    let access = format!(
        "e30.{}.synthetic",
        base64url(
            json!({"exp":2000+serial,"serial":serial})
                .to_string()
                .as_bytes()
        )
    );
    json!({"auth_mode":"chatgpt","tokens":{"account_id":account,"access_token":access,"id_token":access,"refresh_token":format!("synthetic-native-{account}-{serial}-refresh")},"last_refresh":format!("2026-10-18T12:00:00.{serial:09}Z")})
}
fn context() -> ArtifactContext {
    ArtifactContext {
        rust_git_sha: "a".repeat(40),
        rust_git_tree: "b".repeat(40),
        wasm_sha256: "c".repeat(64),
        native_sha256: "d".repeat(64),
        native_nonce_capture_sha256: None,
    }
}
struct FixedLocal {
    transport: UnixOwnerTransport,
    bindings: RefCell<BTreeMap<String, (PathBuf, OwnerFence)>>,
}
impl FixedLocal {
    fn fixture(directory: &Directory) -> Self {
        let mut locations = vec![];
        let mut bindings = BTreeMap::new();
        for account in ["managed-a", "managed-b"] {
            let home = directory.file(account);
            std::fs::create_dir(&home).unwrap();
            let document = document(account, 1);
            std::fs::write(
                home.join("auth.json"),
                serde_json::to_vec(&document).unwrap(),
            )
            .unwrap();
            let credentials = parse_native_document(&document).unwrap();
            let owner = NativeOwnerId(format!("fixed-{account}"));
            let fence = OwnerFence {
                owner: owner.clone(),
                account_id: account.into(),
                generation_hash: credentials.generation_hash(),
                authority_revision: "native-v1:14:0".into(),
            };
            locations.push(NativeOwnerLocation::configured(owner, home.clone()).unwrap());
            bindings.insert(account.into(), (home, fence));
        }
        Self {
            transport: UnixOwnerTransport::new(locations).unwrap(),
            bindings: RefCell::new(bindings),
        }
    }
    fn generation(&self, account: &str) -> NativeGeneration {
        let (_, fence) = self.bindings.borrow().get(account).unwrap().clone();
        NativeGeneration {
            credentials: run(self.transport.read_credentials(&fence.owner)).unwrap(),
            fence,
            observed_at_ms: 2300,
        }
    }
}
impl NativeCustody for FixedLocal {
    async fn observe(&self, account: &str) -> Result<OwnedNativeSnapshot, GatewayError> {
        let (home, fence) = self
            .bindings
            .borrow()
            .get(account)
            .cloned()
            .ok_or_else(|| {
                GatewayError::unavailable("Unregistered fixture owner", "fixture_owner_unknown")
            })?;
        let credentials = self.transport.read_credentials(&fence.owner).await?;
        OwnedNativeSnapshot::verify(
            home.to_str().unwrap(),
            &fence,
            NativeGeneration {
                fence: fence.clone(),
                credentials,
                observed_at_ms: 2300,
            },
        )
    }
}

#[test]
fn full_local_source_sanitizes_then_restarts_and_inverts_only_under_current_native_custody() {
    let directory = Directory::new();
    let host = FixedLocal::fixture(&directory);
    let accounts=["managed-a","managed-b"].into_iter().map(|id|{
        let generation=host.generation(id);let home=host.bindings.borrow().get(id).unwrap().0.clone();
        json!({"account_id":id,"access_token":generation.credentials.access_token.expose(),"refresh_token":generation.credentials.refresh_token.expose(),"updated_at_ms":2200,"native_owner":{"codex_home":home.to_str().unwrap(),"generation_hash":generation.credentials.generation_hash(),"native_refreshed_at":generation.credentials.native_refreshed_at}})
    }).collect::<Vec<_>>();
    let mut source: NativeCapture =
        serde_json::from_str(include_str!("fixtures/native-source.json")).unwrap();
    let pool_key = codex_source_pool_key();
    source.entries.push(NativeEntry {
        raw_key: TupleKey::from_record_key(&pool_key)
            .unwrap()
            .sort_bytes()
            .to_vec(),
        value: wire(&json!({"accounts":accounts,"updated_at_ms":2200})),
        revision: NativeRevision {
            version: "14".into(),
            sequence: "0".into(),
        },
        expiration_ms: -1,
    });
    assert!(prepare_native(&source).is_err());
    let candidate = run(sanitize_native_capture(&source, &host)).unwrap();
    let encoded = serde_json::to_string(&candidate).unwrap();
    assert!(!encoded.contains("synthetic-native-managed-a-1-refresh"));
    assert!(!encoded.contains("synthetic-native-managed-b-1-refresh"));
    let path = directory.file("common-sanitized.sqlite3");
    let store = SqliteStore::open(&path);
    run(adopt_empty(&store, &prepare_native(&candidate).unwrap())).unwrap();
    drop(store);
    let store = SqliteStore::open(&path);
    let snapshot = run(read_codex_source_pool(&store, 2300)).unwrap().unwrap();
    assert_eq!(snapshot.pool.accounts.len(), 2);
    let before_sibling = snapshot.pool.accounts[1].clone();
    assert!(
        snapshot
            .pool
            .accounts
            .iter()
            .all(|a| a.refresh_token.expose().is_empty())
    );
    let token = format!("u_{}", "1".repeat(64));
    assert_eq!(
        run(gateway_auth::api_keys::authenticate(&store, &token, 2300))
            .unwrap()
            .key_id,
        "offline-key"
    );
    let local_a = host.bindings.borrow().get("managed-a").unwrap().0.clone();
    let mut rotated = document("managed-a", 2);
    let previous = document("managed-a", 1);
    rotated["tokens"]["access_token"] = previous["tokens"]["access_token"].clone();
    rotated["tokens"]["id_token"] = previous["tokens"]["id_token"].clone();
    std::fs::write(
        local_a.join("auth.json"),
        serde_json::to_vec(&rotated).unwrap(),
    )
    .unwrap();
    assert_eq!(
        run(export_native_rollback_with_custody(
            &store,
            2300,
            &host,
            context()
        ))
        .err()
        .unwrap()
        .code(),
        Some("migration_native_custody_required")
    );
    // Controlled current publication changes only this account, with a new source revision.
    let mut local = host.generation("managed-a");
    local.fence.generation_hash = local.credentials.generation_hash();
    local.fence.authority_revision = "current-pool-publication".into();
    let projection = ManagedAccessProjection::from_native(&local).unwrap();
    let mut pool = snapshot.pool;
    assert_eq!(
        projection.access_generation(),
        pool.accounts[0].identity().native_generation_hash
    );
    assert_ne!(
        projection.native_source_generation(),
        pool.accounts[0]
            .native_owner
            .as_ref()
            .unwrap()
            .managed_source
            .as_ref()
            .unwrap()
            .generation_hash
    );
    let account = &mut pool.accounts[0];
    account.access_token = projection.access_token().clone();
    account.refresh_token = Secret::new(String::new());
    let owner = account.native_owner.as_mut().unwrap();
    owner.generation_hash = projection.access_generation().into();
    owner.native_refreshed_at = projection.native_refreshed_at().map(str::to_owned);
    owner.managed_source = Some(ManagedNativeSource {
        v: 2,
        generation_hash: projection.native_source_generation().into(),
    });
    assert_eq!(pool.accounts[1], before_sibling);
    run(store.commit(AtomicTransition {
        checks: vec![RevisionCheck {
            key: pool_key.clone(),
            expected_revision: Some(snapshot.revision),
        }],
        mutations: vec![RecordMutation::Put {
            key: pool_key.clone(),
            record: StoredRecord::json(
                "current-pool-publication",
                pool.private_source_value(),
                None,
            ),
        }],
    }))
    .unwrap();
    for (_, fence) in host.bindings.borrow_mut().values_mut() {
        fence.authority_revision = "current-pool-publication".into();
        if fence.account_id == "managed-a" {
            fence.generation_hash = local.credentials.generation_hash();
        }
    }
    drop(store);
    let store = SqliteStore::open(&path);
    assert_eq!(
        run(export_native_with_custody(&store, 2400, &host))
            .err()
            .unwrap()
            .code(),
        Some("migration_control_custody_required")
    );
    let normalized_key = gateway_authority::keys::pool();
    let normalized = run(store.read(&normalized_key)).unwrap().unwrap();
    let (inverse, controls, artifacts) = run(export_native_rollback_with_custody(
        &store,
        2400,
        &host,
        context(),
    ))
    .unwrap()
    .into_private_parts();
    assert!(
        controls
            .iter()
            .any(|row| row.key == normalized_key.0 && row.record == normalized)
    );
    assert_eq!(
        serde_json::to_value(&artifacts).unwrap(),
        serde_json::to_value(context()).unwrap()
    );
    assert!(
        controls
            .iter()
            .any(|control| control.key == gateway_authority::keys::pool().0)
    );
    for control in &controls {
        assert_eq!(
            run(store.read(&RecordKey(control.key.clone())))
                .unwrap()
                .as_ref(),
            Some(&control.record)
        );
    }
    assert!(prepare_native(&inverse).is_err());
    let restored = inverse
        .entries
        .iter()
        .find(|e| e.raw_key == TupleKey::from_record_key(&pool_key).unwrap().sort_bytes())
        .unwrap();
    let NativeValue::SourceGraphV1(value) = &restored.value else {
        panic!("pool graph missing")
    };
    let pool = graph_transport::from_source_graph(value)
        .unwrap()
        .try_identity_free_tree()
        .unwrap()
        .unwrap()
        .to_json_lossless()
        .unwrap();
    let pool = parse_codex_source_pool(&pool).unwrap().unwrap();
    assert_eq!(
        pool.accounts[0].refresh_token,
        local.credentials.refresh_token
    );
    assert_eq!(
        pool.accounts[1].refresh_token,
        host.generation("managed-b").credentials.refresh_token
    );
    assert!(
        pool.accounts
            .iter()
            .all(|a| a.native_owner.as_ref().unwrap().managed_source.is_none())
    );
    let resanitized = run(sanitize_native_capture(&inverse, &host));
    assert!(
        resanitized.is_err(),
        "native inverse revisions require a new stopped-source owner binding"
    );
    let native_revision = format!(
        "native-v1:{}:{}",
        restored.revision.version, restored.revision.sequence
    );
    for (_, fence) in host.bindings.borrow_mut().values_mut() {
        fence.authority_revision = native_revision.clone();
    }
    let next_candidate = run(sanitize_native_capture(&inverse, &host)).unwrap();
    let inverse_path = directory.file("new-custody-bound-inverse.sqlite3");
    let inverse_store = SqliteStore::open(&inverse_path);
    run(adopt_empty(
        &inverse_store,
        &prepare_native(&next_candidate).unwrap(),
    ))
    .unwrap();
    drop(inverse_store);
    let inverse_store = SqliteStore::open(&inverse_path);
    let current = run(read_codex_source_pool(&inverse_store, 2400))
        .unwrap()
        .unwrap();
    assert!(
        current
            .pool
            .accounts
            .iter()
            .all(|a| a.refresh_token.expose().is_empty())
    );
    assert_eq!(current.pool.accounts[1], before_sibling);
    assert_eq!(
        current.pool.accounts[0]
            .native_owner
            .as_ref()
            .unwrap()
            .managed_source
            .as_ref()
            .unwrap()
            .generation_hash,
        local.credentials.generation_hash()
    );
    let mut corrupt = run(store.read(&pool_key)).unwrap().unwrap();
    corrupt.value["accounts"][0]["native_owner"]["managed_source"]["generation_hash"] =
        json!("f".repeat(64));
    store.put(pool_key, corrupt);
    assert_eq!(
        run(export_native_rollback_with_custody(
            &store,
            2400,
            &host,
            context()
        ))
        .err()
        .unwrap()
        .code(),
        Some("migration_native_custody_required")
    );
}

#[test]
fn configured_operator_composes_access_only_request_and_empty_store_adoption() {
    use gateway_migration::native_operator::{NativeCustodyRegistration, prepare_local_bootstrap};
    use gateway_migration::operational::{NativeMigrationRequest, NativeOperation, execute_native};
    use std::time::{SystemTime, UNIX_EPOCH};
    let directory = Directory::new();
    let home = directory.file("actual-configured-operator");
    std::fs::create_dir(&home).unwrap();
    let mut doc = document("managed-operator", 1);
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let access = format!(
        "e30.{}.synthetic",
        base64url(json!({"exp":expiry}).to_string().as_bytes())
    );
    doc["tokens"]["access_token"] = json!(access);
    doc["tokens"]["id_token"] = doc["tokens"]["access_token"].clone();
    let original = serde_json::to_vec(&doc).unwrap();
    std::fs::write(home.join("auth.json"), &original).unwrap();
    let credentials = parse_native_document(&doc).unwrap();
    let registration = NativeCustodyRegistration::existing(
        home.clone(),
        OwnerFence {
            owner: NativeOwnerId("existing-synthetic-operator".into()),
            account_id: credentials.account_id.clone(),
            generation_hash: credentials.generation_hash(),
            authority_revision: "native-v1:14:0".into(),
        },
    )
    .unwrap();
    let mut capture: NativeCapture =
        serde_json::from_str(include_str!("fixtures/native-source.json")).unwrap();
    capture.entries.push(NativeEntry {
        raw_key: TupleKey::from_record_key(&codex_source_pool_key()).unwrap().sort_bytes().to_vec(),
        value: wire(&json!({"accounts":[{"account_id":credentials.account_id,"access_token":credentials.access_token.expose(),"refresh_token":credentials.refresh_token.expose(),"updated_at_ms":2200,"native_owner":{"codex_home":home.to_str().unwrap(),"generation_hash":credentials.generation_hash(),"native_refreshed_at":credentials.native_refreshed_at}}],"updated_at_ms":2200})),
        revision: NativeRevision {version:"14".into(),sequence:"0".into()},
        expiration_ms:-1,
    });
    assert!(prepare_native(&capture).is_err());
    assert!(run(prepare_local_bootstrap(&capture, vec![])).is_err());
    let candidate = run(prepare_local_bootstrap(&capture, vec![registration])).unwrap();
    let bytes = serde_json::to_vec(&candidate).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains(credentials.refresh_token.expose()));
    assert!(String::from_utf8_lossy(&bytes).contains(credentials.access_token.expose()));
    let store = SqliteStore::open(&directory.file("operator-common.sqlite3"));
    let decode = || NativeMigrationRequest {
        v: 1,
        request: NativeOperation::AdoptNative {
            capture: serde_json::from_slice::<NativeCapture>(&bytes).unwrap(),
        },
    };
    assert_eq!(
        serde_json::from_slice::<NativeCapture>(&bytes).unwrap().v,
        2
    );
    let adopted = run(execute_native(&store, decode())).unwrap();
    assert!(
        serde_json::to_string(&adopted)
            .unwrap()
            .contains("atomic_committed\":true")
    );
    assert!(run(execute_native(&store, decode())).is_err());
    let snapshot = run(read_codex_source_pool(&store, 2300)).unwrap().unwrap();
    assert_eq!(snapshot.pool.accounts[0].account_id, credentials.account_id);
    assert!(snapshot.pool.accounts[0].refresh_token.expose().is_empty());
    assert_eq!(std::fs::read(home.join("auth.json")).unwrap(), original);
    let expected = snapshot.pool.accounts[0].identity();
    let normalized = run(store.read(&gateway_authority::keys::pool()))
        .unwrap()
        .unwrap();
    let normalized: gateway_authority::routing::SubscriptionPool =
        serde_json::from_value(normalized.value).unwrap();
    assert_eq!(normalized.pool_versionstamp.0, snapshot.revision);
    assert_eq!(normalized.accounts.len(), 1);
    assert_eq!(
        normalized.accounts[0].account_id_hash,
        expected.routing_account_hash
    );
    assert_eq!(
        normalized.accounts[0].credential_version,
        expected.credential_version
    );
    struct Tokens(std::sync::atomic::AtomicU64);
    impl gateway_authority::TokenSource for Tokens {
        fn next_token(&self) -> Result<String, GatewayError> {
            Ok(format!(
                "operator-route-{}",
                self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ))
        }
    }
    struct Clock;
    impl gateway_authority::AuthorityClock for Clock {
        fn now_ms(&self) -> Result<i64, GatewayError> {
            Ok(2300)
        }
    }
    let authority = gateway_authority::Authority::with_clock(
        store,
        Tokens(std::sync::atomic::AtomicU64::new(1)),
        Clock,
    );
    let model = gateway_core::model::ModelId::from_scalar("gpt-6.1-sol");
    let selected = run(authority.select_account(
        &model,
        gateway_authority::routing::model_quota_class(&model),
        2300,
    ))
    .unwrap();
    let gateway_authority::routing::RouteSelection::Eligible(selected) = selected else {
        panic!("The adopted real routing projection did not select the source account");
    };
    assert_eq!(
        selected.binding.account_id_hash,
        expected.routing_account_hash
    );
    assert_eq!(
        selected.binding.credential_version,
        expected.credential_version
    );
    assert_eq!(selected.binding.pool_versionstamp.0, snapshot.revision);
}

#[test]
fn configured_operator_observes_existing_external_access_and_refuses_stale_input() {
    use gateway_migration::native_operator::{NativeCustodyRegistration, prepare_local_bootstrap};
    use std::time::{SystemTime, UNIX_EPOCH};
    let directory = Directory::new();
    let home = directory.file("external-operator");
    std::fs::create_dir(&home).unwrap();
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let token = format!("e30.{}.synthetic",base64url(json!({"exp":expiry,"https://api.openai.com/auth":{"chatgpt_user_id":"external-user","chatgpt_account_id":"external-account"}}).to_string().as_bytes()));
    let doc = json!({"auth_mode":"chatgptAuthTokens","OPENAI_API_KEY":null,"tokens":{"account_id":"external-account","access_token":token,"id_token":token,"refresh_token":""}});
    let bytes = serde_json::to_vec(&doc).unwrap();
    std::fs::write(home.join("auth.json"), &bytes).unwrap();
    let native = parse_native_document(&doc).unwrap();
    let fence = OwnerFence {
        owner: NativeOwnerId("existing-external-reader".into()),
        account_id: native.account_id.clone(),
        generation_hash: native.generation_hash(),
        authority_revision: "native-v1:14:0".into(),
    };
    let mut capture: NativeCapture =
        serde_json::from_str(include_str!("fixtures/native-source.json")).unwrap();
    capture.entries.push(NativeEntry {raw_key:TupleKey::from_record_key(&codex_source_pool_key()).unwrap().sort_bytes().to_vec(),value:wire(&json!({"accounts":[{"account_id":native.account_id,"access_token":native.access_token.expose(),"refresh_token":"","updated_at_ms":2200,"native_owner":{"codex_home":home.to_str().unwrap(),"generation_hash":native.generation_hash(),"auth_mode":"chatgptAuthTokens","chatgpt_user_id":"external-user"}}],"updated_at_ms":2200})),revision:NativeRevision{version:"14".into(),sequence:"0".into()},expiration_ms:-1});
    let registration =
        |f: OwnerFence| vec![NativeCustodyRegistration::existing(home.clone(), f).unwrap()];
    assert!(
        run(prepare_local_bootstrap(
            &capture,
            registration(fence.clone())
        ))
        .is_ok()
    );
    let mut stale = fence.clone();
    stale.authority_revision = "native-v1:13:0".into();
    assert!(run(prepare_local_bootstrap(&capture, registration(stale))).is_err());
    let mut stale = fence.clone();
    stale.generation_hash = "0".repeat(64);
    assert!(run(prepare_local_bootstrap(&capture, registration(stale))).is_err());
    let mut stale = fence.clone();
    stale.account_id = "different-account".into();
    assert!(run(prepare_local_bootstrap(&capture, registration(stale))).is_err());
    let mut changed = doc.clone();
    changed["tokens"]["access_token"] = json!("different-access");
    changed["tokens"]["id_token"] = json!("different-access");
    std::fs::write(
        home.join("auth.json"),
        serde_json::to_vec(&changed).unwrap(),
    )
    .unwrap();
    assert!(run(prepare_local_bootstrap(&capture, registration(fence))).is_err());
    std::fs::write(home.join("auth.json"), &bytes).unwrap();
    assert_eq!(std::fs::read(home.join("auth.json")).unwrap(), bytes);
}
