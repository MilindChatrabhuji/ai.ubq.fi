//! Real original import/publication and the existing versioned catalog writer.
use super::*;
use crate::native_control::rows;
use gateway_auth::native_import::catalog_seed::{
    IMPORT_CATALOG_SEED_OPERATION, ImportCatalogSeedReplyData as SeedReply,
    ImportCatalogSeedRequestData as SeedRequest,
};
use gateway_core::query::{QueryPage, QueryRequest, QueryStore};
use gateway_schema::catalog_cache::CatalogMetadata;
use gateway_schema::catalog_store;
#[derive(Clone)]
struct SeedStore {
    inner: Store,
    fail_write: Arc<AtomicBool>,
    fail_prune: Arc<AtomicBool>,
    race_generation: Arc<AtomicBool>,
    race_admin: Arc<AtomicBool>,
    race_same_generation_revision: Arc<AtomicBool>,
    writes: Arc<AtomicUsize>,
    queries: Arc<AtomicUsize>,
}
impl SeedStore {
    fn new(store: &Store) -> Self {
        Self {
            inner: store.clone(),
            fail_write: Arc::default(),
            fail_prune: Arc::default(),
            race_generation: Arc::default(),
            race_admin: Arc::default(),
            race_same_generation_revision: Arc::default(),
            writes: Arc::default(),
            queries: Arc::default(),
        }
    }
}
impl AuthorityStore for SeedStore {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        if *key == catalog_store::auth_generation_key()
            && self.writes.load(Ordering::SeqCst) > 0
            && self
                .race_same_generation_revision
                .swap(false, Ordering::SeqCst)
        {
            self.inner
                .rows
                .lock()
                .unwrap()
                .get_mut(&key.0)
                .unwrap()
                .revision = "same-value-new-revision".into();
        }
        self.inner.read(key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        // Match the existing real Worker canonical transition contract.
        let mut checked = BTreeSet::new();
        if transition
            .checks
            .iter()
            .any(|check| !checked.insert(check.key.0.clone()))
        {
            return Err(fail());
        }
        if !transition.mutations.is_empty() {
            self.writes.fetch_add(1, Ordering::SeqCst);
            if self.fail_write.load(Ordering::SeqCst) {
                return Err(fail());
            }
            if self.race_generation.swap(false, Ordering::SeqCst) {
                self.inner.seed(
                    catalog_store::auth_generation_key(),
                    "race-generation",
                    json!("other-generation"),
                );
            }
            if self.race_admin.swap(false, Ordering::SeqCst) {
                self.inner
                    .rows
                    .lock()
                    .unwrap()
                    .remove(&gateway_auth::passkeys::key("users", "user-fixture").0);
            }
        }
        self.inner.commit(transition).await
    }
}
impl QueryStore for SeedStore {
    async fn query(&self, _: QueryRequest) -> Result<QueryPage, GatewayError> {
        self.queries.fetch_add(1, Ordering::SeqCst);
        if self.fail_prune.load(Ordering::SeqCst) {
            Err(fail())
        } else {
            Ok(QueryPage {
                entries: vec![],
                next_cursor: None,
            })
        }
    }
}
const RAW: &str = r#"{"models":[{"slug":"model-a","supported_reasoning_levels":[{"effort":"none","description":"none"}],"context_window":1024,"future_metadata":"original only"}]}"#;
impl Fixture {
    async fn seed_request(&self, limited: bool) -> SeedRequest {
        self.catalog_seed();
        let (proof, _, started) = self.prepare_version(true, true).await;
        let wire = self.publication_wire(&started, limited);
        let body = wire.bytes().unwrap();
        let peer = self.publication_peer(&body, 51).await;
        let control = self.control();
        let plan = control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap();
        let config = super::super::publication::synthetic_config(&plan);
        plan.commit(config).await.unwrap();
        SeedRequest {
            operation: IMPORT_CATALOG_SEED_OPERATION.into(),
            v: 1,
            state: State {
                action_version: 3,
                metadata: proof.metadata().clone(),
                target: proof.target().clone(),
                action_revision: "prior-action".into(),
                native_owner_id: started.native_owner_id,
                account_id_hash: started.account_id_hash,
                source_native_generation: started.source_native_generation,
                owner_revision: started.owner_revision,
                source_revision: started.source_revision,
                normalized_revision: started.normalized_revision,
                created_at_ms: started.deadline_ms - 45_000,
                deadline_ms: started.deadline_ms,
            },
            claim_ref: started.claim_ref,
            publication_revision: wire.publication_revision,
            native_receipt_ref: wire.native_receipt_ref,
            publication_request_digest: sha256_hex(&body),
            client_version: if limited {
                "1.0.0".into()
            } else {
                "1.1.0".into()
            },
            source_body: RAW.into(),
            etag: Some("  upstream-etag  ".into()),
            content_type: Some(" application/json; charset=utf-8 ".into()),
        }
    }
    async fn seed_attempt(
        &self,
        store: &SeedStore,
        request: &SeedRequest,
    ) -> Result<bool, GatewayError> {
        let authority =
            Authority::with_clock(store.clone(), UniqueTokens::default(), self.store.clone());
        let control = NativeRenewalAuthority::configured(
            &authority,
            &self.id,
            &self.registered,
            &self.cfg,
            &self.cancel,
        );
        let body = request.bytes()?;
        let peer = self.phase_peer(&body, 60).await;
        let reply = control.handle_import_catalog_seed(&peer, &body).await?;
        Ok(SeedReply::parse(&reply)?.seeded)
    }
}
#[test]
fn actual_source_seed_has_unique_fences_generation_value_and_prune_failure_stays_true() {
    run(async {
        for fail_prune in [false, true] {
            let f = Fixture::new();
            let request = f.seed_request(false).await;
            let store = SeedStore::new(&f.store);
            store.fail_prune.store(fail_prune, Ordering::SeqCst);
            let primary = f
                .store
                .rows
                .lock()
                .unwrap()
                .get(&codex_source_pool_key().0)
                .unwrap()
                .clone();
            assert!(f.seed_attempt(&store, &request).await.unwrap());
            let generation = f
                .store
                .read(&catalog_store::auth_generation_key())
                .await
                .unwrap()
                .unwrap()
                .value
                .as_str()
                .unwrap()
                .to_owned();
            assert_ne!(generation, request.publication_revision);
            let metadata = f
                .store
                .read(&catalog_store::metadata_key("1.1.0"))
                .await
                .unwrap()
                .unwrap();
            let metadata: CatalogMetadata = serde_json::from_value(metadata.value).unwrap();
            assert_eq!(metadata.auth_generation, generation);
            assert_eq!(metadata.etag.as_deref(), Some("upstream-etag"));
            assert_eq!(metadata.content_type, "application/json; charset=utf-8");
            assert_eq!(
                metadata.source_sha256.as_deref(),
                Some(sha256_hex(RAW.as_bytes()).as_str())
            );
            let loaded = catalog_store::load_catalog(&f.store, "1.1.0", &generation, 1_000_000)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(loaded.source_body.as_deref(), Some(RAW));
            assert_eq!(store.queries.load(Ordering::SeqCst), 1);
            assert_eq!(
                serde_json::to_value(
                    f.store
                        .read(&codex_source_pool_key())
                        .await
                        .unwrap()
                        .unwrap()
                )
                .unwrap(),
                serde_json::to_value(primary).unwrap()
            );
        }
    });
}
#[test]
fn retained429_is_inapplicable_without_seed_write_or_prune() {
    run(async {
        let f = Fixture::new();
        let request = f.seed_request(true).await;
        let store = SeedStore::new(&f.store);
        let before = f.snapshot();
        let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
        assert!(!f.seed_attempt(&store, &request).await.unwrap());
        assert_eq!(f.snapshot(), before);
        assert_eq!(store.writes.load(Ordering::SeqCst), 0);
        assert_eq!(store.queries.load(Ordering::SeqCst), 0);
        assert_eq!(tokens, f.authority.tokens.0.load(Ordering::SeqCst));
    });
}
#[test]
fn genuine_optional_store_or_prepare_failure_preserves_successful_primary_import() {
    run(async {
        for bad_body in [false, true] {
            let f = Fixture::new();
            let mut request = f.seed_request(false).await;
            let store = SeedStore::new(&f.store);
            store.fail_write.store(!bad_body, Ordering::SeqCst);
            if bad_body {
                request.source_body = "not a catalog".into();
            }
            let before = f.snapshot();
            assert!(!f.seed_attempt(&store, &request).await.unwrap());
            assert_eq!(before, f.snapshot());
            assert_eq!(store.queries.load(Ordering::SeqCst), 0);
        }
    });
}
#[test]
fn generation_and_admin_cas_races_never_publish_seed_metadata() {
    run(async {
        for admin in [false, true] {
            let f = Fixture::new();
            let request = f.seed_request(false).await;
            let store = SeedStore::new(&f.store);
            if admin {
                store.race_admin.store(true, Ordering::SeqCst);
            } else {
                store.race_generation.store(true, Ordering::SeqCst);
            }
            assert!(!f.seed_attempt(&store, &request).await.unwrap());
            assert!(
                f.store
                    .read(&catalog_store::metadata_key("1.1.0"))
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(
                f.store
                    .read(&rows::key(
                        "operation",
                        &request.state.metadata.operation_id
                    ))
                    .await
                    .unwrap()
                    .is_some()
            );
        }
    });
}
#[test]
fn foreign_claim_publication_config_and_revocation_refuse_before_optional_writes() {
    run(async {
        for kind in 0..4 {
            let f = Fixture::new();
            let mut request = f.seed_request(false).await;
            let store = SeedStore::new(&f.store);
            match kind {
                0 => request.claim_ref = "foreign".into(),
                1 => request.publication_revision = "foreign".into(),
                2 => {
                    let mut rows = f.store.rows.lock().unwrap();
                    rows.get_mut(&keys::paid_control_config().0)
                        .unwrap()
                        .revision = "foreign".into();
                }
                _ => {
                    f.store
                        .rows
                        .lock()
                        .unwrap()
                        .remove(&gateway_auth::passkeys::key("users", "user-fixture").0);
                }
            }
            assert!(f.seed_attempt(&store, &request).await.is_err());
            assert_eq!(store.writes.load(Ordering::SeqCst), 0);
        }
    });
}

#[test]
fn same_generation_value_at_foreign_revision_cannot_replace_original_seed_fence() {
    run(async {
        let f = Fixture::new();
        let request = f.seed_request(false).await;
        let store = SeedStore::new(&f.store);
        store
            .race_same_generation_revision
            .store(true, Ordering::SeqCst);
        assert!(!f.seed_attempt(&store, &request).await.unwrap());
        assert!(
            f.store
                .read(&catalog_store::metadata_key("1.1.0"))
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            f.store
                .read(&catalog_store::auth_generation_key())
                .await
                .unwrap()
                .unwrap()
                .revision,
            "same-value-new-revision"
        );
    });
}
