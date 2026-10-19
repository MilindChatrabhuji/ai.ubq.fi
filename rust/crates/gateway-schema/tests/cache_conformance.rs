use gateway_core::{
    GatewayError,
    query::*,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    state::*,
    tuple_key::TupleKey,
};
use gateway_schema::{
    catalog::CatalogInput, catalog_cache::*, catalog_store::*, metadata::MetadataHint,
    selection::ProviderSelection,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    future::Future,
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
};
struct WakeThread(std::thread::Thread);
impl Wake for WakeThread {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}
fn run<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(WakeThread(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => std::thread::park(),
        }
    }
}
#[derive(Default)]
struct Store {
    records: RefCell<BTreeMap<String, StoredRecord>>,
}
impl Store {
    fn seed_generation(&self, generation: &str) {
        self.records.borrow_mut().insert(
            auth_generation_key().0,
            StoredRecord::json(generation, json!(generation), None),
        );
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.records.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let mut records = self.records.borrow_mut();
        if transition.checks.iter().any(|check| {
            records.get(&check.key.0).map(|r| &r.revision) != check.expected_revision.as_ref()
        }) {
            return Ok(CommitOutcome::Conflict);
        }
        for mutation in transition.mutations {
            match mutation {
                RecordMutation::Put { key, record } => {
                    records.insert(key.0, record);
                }
                RecordMutation::Delete { key } => {
                    records.remove(&key.0);
                }
            }
        }
        Ok(CommitOutcome::Committed)
    }
}
fn prepared(generation: &str, body_generation: &str, now: i64) -> PreparedCatalog {
    prepare_catalog("0.163.0",generation,body_generation,r#"{ "future": 1, "models": [{"slug":"a","context_window":272000,"max_context_window":872000}] }"#,Some("upstream-tag"),Some("application/json"),now,&BTreeMap::new()).unwrap()
}
#[test]
fn actual_gzip_round_trip_retains_source_and_served_integrity() {
    let mut enrichment = BTreeMap::new();
    enrichment.insert(
        "a".into(),
        MetadataHint {
            context_window_tokens: Some(1050000),
            ..MetadataHint::default()
        },
    );
    let prepared = prepare_catalog(
        "0.163.0",
        "auth",
        "body",
        r#"{ "models": [{"slug":"a","context_window":272000}] }"#,
        Some("upstream"),
        None,
        1000,
        &enrichment,
    )
    .unwrap();
    assert!(prepared.chunks.iter().all(|c| c.len() <= CHUNK_BYTES));
    let body = decode_chunks(
        &prepared.chunks,
        prepared.metadata.compressed_bytes,
        prepared.metadata.body_bytes,
        &prepared.metadata.sha256,
    )
    .unwrap();
    let source = decode_chunks(
        &prepared.source_chunks,
        prepared.metadata.source_compressed_bytes.unwrap(),
        prepared.metadata.source_body_bytes.unwrap(),
        prepared.metadata.source_sha256.as_deref().unwrap(),
    )
    .unwrap();
    assert_ne!(body, source);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["models"][0]["context_window"],
        1050000
    );
    let mut corrupt = prepared.chunks.clone();
    corrupt[0][0] ^= 1;
    assert!(
        decode_chunks(
            &corrupt,
            prepared.metadata.compressed_bytes,
            prepared.metadata.body_bytes,
            &prepared.metadata.sha256
        )
        .is_none()
    );
}
#[test]
fn durable_publication_is_fenced_and_reclaims_superseded_chunks() {
    let store = Store::default();
    store.seed_generation("auth");
    let one = prepared("auth", "one", 1000);
    assert!(run(publish_catalog(&store, &one)).unwrap());
    let loaded = run(load_catalog(&store, "0.163.0", "auth", 1001))
        .unwrap()
        .unwrap();
    assert!(loaded.source_body.is_some());
    assert!(
        run(load_catalog(&store, "0.163.0", "different", 1001))
            .unwrap()
            .is_none()
    );
    assert!(
        run(load_catalog(&store, "0.163.0", "auth", 1000 + RETENTION_MS))
            .unwrap()
            .is_none()
    );
    let two = prepared("auth", "two", 2000);
    assert!(run(publish_catalog(&store, &two)).unwrap());
    assert!(
        !store
            .records
            .borrow()
            .contains_key(&chunk_key("0.163.0", "one", 0, false).0)
    );
    store.seed_generation("rotated");
    let stale = prepared("auth", "stale", 3000);
    assert!(!run(publish_catalog(&store, &stale)).unwrap());
    assert!(
        !store
            .records
            .borrow()
            .contains_key(&chunk_key("0.163.0", "stale", 0, false).0)
    );
    let metadata = store
        .records
        .borrow()
        .get(&metadata_key("0.163.0").0)
        .unwrap()
        .value
        .clone();
    assert_eq!(metadata["body_generation"], "two");
}
#[test]
fn lease_ownership_prevents_duplicate_refresh_and_foreign_release() {
    let store = Store::default();
    assert!(run(acquire_refresh_lease(&store, "0.163.0", "one", 1)).unwrap());
    assert!(!run(acquire_refresh_lease(&store, "0.163.0", "two", 2)).unwrap());
    assert!(!run(release_refresh_lease(&store, "0.163.0", "two")).unwrap());
    assert!(run(renew_refresh_lease(&store, "0.163.0", "one", 3)).unwrap());
    assert!(
        run(acquire_refresh_lease(
            &store,
            "0.163.0",
            "two",
            4 + REFRESH_LEASE_MS
        ))
        .unwrap()
    );
    assert!(
        !run(renew_refresh_lease(
            &store,
            "0.163.0",
            "one",
            5 + REFRESH_LEASE_MS
        ))
        .unwrap()
    );
}
#[test]
fn client_conditionals_bind_served_bytes_including_enrichment() {
    let store = Store::default();
    store.seed_generation("auth");
    assert!(run(publish_catalog(&store, &prepared("auth", "one", 1000))).unwrap());
    let loaded = run(load_catalog(&store, "0.163.0", "auth", 1001))
        .unwrap()
        .unwrap();
    let input = CatalogInput {
        selection: Some(ProviderSelection {
            provider_ids: vec!["codex".into()],
            updated_at_ms: 1,
        }),
        ..CatalogInput::default()
    };
    let response = catalog_response(&loaded, None, CacheState::Hit, &input);
    assert_eq!(response.body.as_deref(), Some(loaded.body.as_str()));
    let etag = response.headers.get("ETag").unwrap();
    assert_ne!(etag, "upstream-tag");
    let conditional = catalog_response(&loaded, Some(etag), CacheState::Hit, &input);
    assert_eq!(conditional.status, 304);
    assert!(conditional.body.is_none());
    assert!(!conditional_matches(Some("W/\"wrong\""), etag));
    assert!(conditional_matches(
        Some(&format!("\"other\", {etag}")),
        etag
    ));
}
#[test]
fn cache_decisions_never_revalidate_enriched_legacy_as_source() {
    let store = Store::default();
    store.seed_generation("auth");
    run(publish_catalog(&store, &prepared("auth", "one", 1000))).unwrap();
    let mut loaded = run(load_catalog(&store, "0.163.0", "auth", 1001))
        .unwrap()
        .unwrap();
    assert_eq!(
        initial_action(Some(&loaded), 1001),
        CatalogAction::Serve(CacheState::Hit)
    );
    assert_eq!(
        lease_action(Some(&loaded), false, 1001),
        CatalogAction::Serve(CacheState::Stale)
    );
    assert_eq!(
        upstream_action(304, true, Some(&loaded), true, true),
        CatalogAction::RevalidateSource
    );
    loaded.source_body = None;
    assert_eq!(
        lease_action(Some(&loaded), true, 1001),
        CatalogAction::Fetch {
            if_none_match: None
        }
    );
    assert_eq!(
        upstream_action(304, true, Some(&loaded), true, true),
        CatalogAction::Serve(CacheState::Stale)
    );
    assert_eq!(
        upstream_action(200, true, Some(&loaded), false, true),
        CatalogAction::UseCurrentGeneration
    );
    assert!(matches!(
        lease_action(None, false, 1000),
        CatalogAction::WaitCold { until_ms: 6000 }
    ));
}
#[test]
fn exact_query_and_version_bound_keep_caches_separate() {
    assert_eq!(requested_client_version(&[]), None);
    assert_eq!(requested_client_version(&["0.163.0", "0.163.0"]), Some(""));
    assert!(validate_client_version("").is_err());
    let mut metadata = Vec::new();
    for i in 0..34 {
        let mut entry = prepared("auth", &i.to_string(), i).metadata;
        entry.client_version = format!("0.{i}.0");
        metadata.push(entry);
    }
    let removed = prune_versions(&metadata, "0.0.0");
    assert_eq!(removed.len(), 2);
    assert!(removed.iter().all(|m| m.client_version != "0.0.0"));
}

#[test]
fn normalized_publication_never_downgrades_version_or_replaces_operator_defaults() {
    let store = Store::default();
    store.seed_generation("auth");
    let source =
        SourceJson::from_serializable(&json!({"models":[{"slug":"a","supported_reasoning_levels":["low","custom"]},{"slug":"b"}]})).unwrap();
    let first = run(publish_normalized_snapshot(
        &store, &source, "0.2.0", "auth", "r1", 1000,
    ))
    .unwrap()
    .unwrap();
    assert_eq!(first.deserialize::<Value>().unwrap()["default_model"], "a");
    let mut runtime = store
        .records
        .borrow()
        .get(&runtime_config_key().0)
        .unwrap()
        .clone();
    runtime.value["default_model"] = json!("b");
    runtime.value["default_reasoning_effort"] = json!("custom");
    runtime.revision = "operator".into();
    store
        .records
        .borrow_mut()
        .insert(runtime_config_key().0, runtime);
    let next = run(publish_normalized_snapshot(
        &store, &source, "0.3.0", "auth", "r2", 2000,
    ))
    .unwrap()
    .unwrap();
    assert_eq!(next.deserialize::<Value>().unwrap()["default_model"], "b");
    assert_eq!(
        next.deserialize::<Value>().unwrap()["default_reasoning_effort"],
        "custom"
    );
    assert!(
        run(publish_normalized_snapshot(
            &store, &source, "0.1.0", "auth", "old", 3000
        ))
        .unwrap()
        .is_none()
    );
    assert_eq!(
        store
            .records
            .borrow()
            .get(&codex_snapshot_key().0)
            .unwrap()
            .value["client_version"],
        "0.3.0"
    );
    store.seed_generation("rotated");
    assert!(
        run(publish_normalized_snapshot(
            &store, &source, "0.4.0", "auth", "stale", 4000
        ))
        .unwrap()
        .is_none()
    );
}

impl QueryStore for Store {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        let validated = request.validate()?;
        let mut entries = Vec::new();
        for (key, record) in self.records.borrow().iter() {
            let key = RecordKey(key.clone());
            if validated.accepts_record(&key, record)? {
                entries.push(QueryEntry {
                    key,
                    record: record.clone(),
                });
            }
        }
        entries
            .sort_by_key(|entry| TupleKey::from_record_key(&entry.key).expect("validated tuple"));
        if request.reverse {
            entries.reverse();
        }
        let limit = (request.limit as usize).min(2);
        let more = entries.len() > limit;
        entries.truncate(limit);
        let next_cursor = if more {
            entries
                .last()
                .map(|e| validated.cursor_after(&e.key))
                .transpose()?
        } else {
            None
        };
        Ok(QueryPage {
            entries,
            next_cursor,
        })
    }
}
#[test]
fn typed_catalog_keys_and_paginated_pruning_use_shared_tuple_contract() {
    for key in [
        auth_generation_key(),
        metadata_key("0.163.0"),
        chunk_key("0.163.0", "generation", 10, false),
        lease_key("0.163.0"),
        codex_snapshot_key(),
        runtime_config_key(),
    ] {
        assert!(key.0.starts_with("tuple-v1:"));
        TupleKey::from_record_key(&key)
            .unwrap()
            .validate_stored_key()
            .unwrap();
    }
    let store = Store::default();
    store.seed_generation("auth");
    for index in 0..35 {
        let mut prepared = prepared("auth", &format!("g{index}"), 1000 + index);
        prepared.metadata.client_version = format!("0.{index}.0");
        assert!(run(publish_catalog(&store, &prepared)).unwrap());
    }
    run(prune_stored_catalog_versions(&store, "0.0.0", 2000)).unwrap();
    let count = store
        .records
        .borrow()
        .values()
        .filter(|record| record.value.get("client_version").is_some())
        .count();
    assert_eq!(count, 32);
    assert!(
        store
            .records
            .borrow()
            .contains_key(&metadata_key("0.0.0").0)
    );
    assert!(
        !store
            .records
            .borrow()
            .contains_key(&metadata_key("0.1.0").0)
    );
    assert!(
        !store
            .records
            .borrow()
            .contains_key(&chunk_key("0.1.0", "g1", 0, false).0)
    );
}

#[test]
fn catalog_json_reads_reject_valid_typed_profile_records_instead_of_treating_them_as_missing() {
    let store = Store::default();
    let typed = gateway_core::value::PortableValue::from_json(&json!({"models":[]}));
    let record = StoredRecord::profile("typed", typed, None).unwrap();
    store
        .records
        .borrow_mut()
        .insert(metadata_key("0.163.0").0, record);
    let error = run(load_catalog(&store, "0.163.0", "auth", 1000)).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("incompatible_value_encoding")
    );
}

#[test]
fn normalized_source_publication_retains_model_effort_codecs_and_generation_fences() {
    let store = Store::default();
    store.seed_generation("auth");
    let input=SourceJson::parse(r#"{"models":[{"slug":"\ud800","default_reasoning_level":"\udc00","supported_reasoning_levels":["\udc00"]}]}"#).unwrap();
    let original = input.clone();
    let first = run(publish_normalized_snapshot(
        &store,
        &input,
        "0.2.0",
        "auth",
        "source-r1",
        1000,
    ))
    .unwrap()
    .unwrap();
    let model = source::member(&first, "default_model").unwrap();
    assert_eq!(source::string(&model).unwrap().as_units(), &[0xd800]);
    for key in [codex_snapshot_key(), runtime_config_key()] {
        let record = store.records.borrow().get(&key.0).unwrap().clone();
        assert_eq!(record.revision, "source-r1");
        assert_eq!(record.expires_at_ms, None);
        assert_eq!(
            record.value_encoding,
            gateway_core::value::ValueEncoding::ProfileV2
        );
        assert!(
            decode_source_control_record(&record)
                .unwrap()
                .as_str()
                .contains(r"\ud800")
        );
    }
    let mut fields = source::entries(&first).unwrap();
    for (key, value) in &mut fields {
        if key
            .as_units()
            .iter()
            .copied()
            .eq("default_reasoning_effort".encode_utf16())
        {
            *value = SourceJson::parse(r#""\udc00""#).unwrap();
        }
    }
    let operator = source::object_keys(fields).unwrap();
    store.records.borrow_mut().insert(
        runtime_config_key().0,
        encode_source_control_record("operator", &operator, None).unwrap(),
    );
    let next = run(publish_normalized_snapshot(
        &store,
        &input,
        "0.3.0",
        "auth",
        "source-r2",
        2000,
    ))
    .unwrap()
    .unwrap();
    assert_eq!(source::member(&next, "default_model"), Some(model));
    assert_eq!(
        source::member(&next, "default_reasoning_effort"),
        Some(SourceJson::parse(r#""\udc00""#).unwrap())
    );
    let before = store.records.borrow().clone();
    store.seed_generation("changed");
    let generation = store
        .records
        .borrow()
        .get(&auth_generation_key().0)
        .unwrap()
        .clone();
    assert!(
        run(publish_normalized_snapshot(
            &store, &input, "0.4.0", "auth", "stale", 3000
        ))
        .unwrap()
        .is_none()
    );
    let mut expected = before;
    expected.insert(auth_generation_key().0, generation);
    assert_eq!(*store.records.borrow(), expected);
    assert_eq!(input, original);
    println!(
        "M42_NORMALIZED_WRITER_FIXTURE={}",
        serde_json::to_string(
            &store
                .records
                .borrow()
                .iter()
                .filter(
                    |(key, _)| **key == codex_snapshot_key().0 || **key == runtime_config_key().0
                )
                .collect::<Vec<_>>()
        )
        .unwrap()
    );
}
