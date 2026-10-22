//! Authority-only fixtures: actual original admin/action/claim/Start and one CAS.
//! Config DATA here is synthetic; trusted receiver derivation is separately gated.
use super::*;
use crate::native_control::import::{
    ImportAccessDocument, ImportCatalogData, ImportPublicationCommandData,
    NativeImportPublicationDisposition, PreparedNativeImportPublication,
};
use gateway_auth::native::NATIVE_PUBLICATION_PATH;
use gateway_core::{
    provider::PaidProvider, source_control::encode_source_control_record, source_json::SourceJson,
};
use gateway_schema::catalog_store;

fn catalog() -> SourceJson {
    SourceJson::parse(r#"{"models":[{"slug":"model-a","supported_reasoning_levels":[{"effort":"none","description":"none"}]}]}"#).unwrap()
}
impl Fixture {
    pub(super) fn catalog_seed(&self) {
        let source = catalog();
        let (snapshot, runtime) = catalog_store::normalized_snapshot_plan(
            &source,
            "1.0.0",
            None,
            &SourceJson::parse("null").unwrap(),
            1_000_000,
        )
        .unwrap();
        for (key, document) in [
            (
                catalog_store::codex_snapshot_key(),
                SourceJson::from_serializable(&snapshot).unwrap(),
            ),
            (catalog_store::runtime_config_key(), runtime),
        ] {
            self.store.rows.lock().unwrap().insert(
                key.0,
                encode_source_control_record("catalog-before", &document, None).unwrap(),
            );
        }
        self.store.seed(
            catalog_store::auth_generation_key(),
            "auth-before",
            "auth-generation-before",
        );
        let mut rows = self.store.rows.lock().unwrap();
        let config = rows.get_mut(&keys::paid_control_config().0).unwrap();
        config.value["source_checks"][0]["expected_revision"] = json!("catalog-before");
        config.value["configuration_fingerprint"] = json!(sha256_hex(b"synthetic-trusted-config"));
        drop(rows);
        for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
            self.store.seed(
                keys::paid_control_observation(provider),
                "observation-before",
                json!({"fixture":"unchanged-until-config-update"}),
            );
        }
    }
    pub(super) fn publication_wire(
        &self,
        started: &ImportCustodyStartedRequest,
        limited: bool,
    ) -> ImportPublicationCommandData {
        let identity = gateway_auth::provider_credentials::codex_credential_identity(
            "synthetic-account",
            &Secret::new("NEW_SYNTHETIC_ACCESS".into()),
            &Secret::new(String::new()),
        );
        ImportPublicationCommandData {
            operation: "codex_auth_import_publish".into(),
            v: 1,
            action_ref: started.action_ref.clone(),
            operation_id: started.operation_id.clone(),
            claim_ref: started.claim_ref.clone(),
            native_owner_id: started.native_owner_id.clone(),
            owner_revision: started.owner_revision.clone(),
            source_revision: started.source_revision.clone(),
            normalized_revision: started.normalized_revision.clone(),
            publication_revision: "publication-one".into(),
            account_id_hash: started.account_id_hash.clone(),
            previous_native_source_generation: started.source_native_generation.clone(),
            native_source_generation: sha256_hex(b"new-physical-generation"),
            access_generation: identity.native_generation_hash,
            native_receipt_ref: "native-receipt-one".into(),
            document: ImportAccessDocument {
                account_id: "synthetic-account".into(),
                access_token: "NEW_SYNTHETIC_ACCESS".into(),
                updated_at_ms: 1_000_000.0,
                native_refreshed_at: None,
            },
            catalog: if limited {
                ImportCatalogData::AuthenticatedLimited {
                    upstream_status: 429,
                }
            } else {
                ImportCatalogData::Normalized {
                    snapshot: catalog(),
                    client_version: "1.1.0".into(),
                    upstream_status: 200,
                }
            },
        }
    }
    pub(super) async fn publication_peer(&self, body: &[u8], salt: u8) -> AuthenticatedNativeOwner {
        let now = self.store.now.load(Ordering::SeqCst);
        let nonce = base64url(&[salt; 32]);
        let time = now.to_string();
        let mac = self
            .id
            .sign(NATIVE_PUBLICATION_PATH, now, &nonce, body)
            .unwrap();
        NativeAuthenticator::new(&self.id, &self.replay)
            .authenticate(
                NATIVE_PUBLICATION_PATH,
                NativeAuthHeaders {
                    version: "1",
                    key_id: self.id.key_id(),
                    time_ms: &time,
                    nonce: &nonce,
                    mac: &mac,
                },
                body,
                now,
            )
            .await
            .unwrap()
    }
}
pub(super) fn synthetic_config<S, I, C>(
    plan: &PreparedNativeImportPublication<'_, '_, S, I, C>,
) -> Option<PaidControlConfig>
where
    S: AuthorityStore,
    I: TokenSource,
    C: NativeRenewalCancellation,
{
    if !plan.needs_configuration() {
        return None;
    }
    let mut config = plan.previous_configuration().clone();
    config.generation = plan.configuration_generation().into();
    config.configuration_fingerprint = sha256_hex(b"synthetic-candidate-runtime");
    config.source_checks[0].expected_revision =
        plan.planned_runtime().map(|row| row.revision.clone());
    Some(config)
}
#[test]
fn normalized_publication_is_one_fixed_group_and_lost_reply_reconciles_without_start() {
    run(async {
        let f = Fixture::new();
        f.catalog_seed();
        let (_, _, started) = f.prepare_version(true, true).await;
        let wire = f.publication_wire(&started, false);
        let body = wire.bytes().unwrap();
        let peer = f.publication_peer(&body, 61).await;
        let control = f.control();
        let before = f.snapshot();
        let plan = control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap();
        assert_eq!(before, f.snapshot(), "preparation is read-only");
        let config = synthetic_config(&plan);
        let applied = plan.commit(config).await.unwrap();
        assert_eq!(
            applied.disposition,
            NativeImportPublicationDisposition::Applied
        );
        assert_eq!(
            applied.publication.publication_request_digest,
            sha256_hex(&body)
        );
        {
            let rows = f.store.rows.lock().unwrap();
            let changed = rows
                .iter()
                .filter(|(key, row)| before.get(*key) != Some(&serde_json::to_value(row).unwrap()))
                .map(|(key, row)| {
                    assert_eq!(row.revision, "publication-one");
                    key.clone()
                })
                .collect::<BTreeSet<_>>();
            assert_eq!(changed.len(), 9);
            for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
                assert!(!rows.contains_key(&keys::paid_control_observation(provider).0));
            }
            let source = &rows.get(&codex_source_pool_key().0).unwrap().value;
            assert!(
                source["accounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|account| account["refresh_token"] == ""),
                "access projection contains no refresh credential"
            );
        }
        let after = f.snapshot();
        let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
        let replay = control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap();
        let config = synthetic_config(&replay);
        let observed = replay.commit(config).await.unwrap();
        assert_eq!(
            observed.disposition,
            NativeImportPublicationDisposition::AlreadyCurrent
        );
        assert_eq!(observed.publication, applied.publication);
        assert_eq!(f.snapshot(), after);
        assert_eq!(tokens, f.authority.tokens.0.load(Ordering::SeqCst));
        let mut foreign = f
            .store
            .rows
            .lock()
            .unwrap()
            .get(&keys::paid_control_config().0)
            .unwrap()
            .clone();
        foreign.revision = "foreign-same-bytes".into();
        f.store
            .rows
            .lock()
            .unwrap()
            .insert(keys::paid_control_config().0, foreign);
        let replay = control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap();
        let config = synthetic_config(&replay);
        assert!(replay.commit(config).await.is_err());
    });
}
#[test]
fn limited_429_retains_checked_catalog_runtime_auth_config_and_observations() {
    run(async {
        let f = Fixture::new();
        f.catalog_seed();
        let (_, _, started) = f.prepare_version(true, true).await;
        let body = f.publication_wire(&started, true).bytes().unwrap();
        let peer = f.publication_peer(&body, 62).await;
        let before = f.snapshot();
        let control = f.control();
        let plan = control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap();
        assert!(!plan.needs_configuration());
        let result = plan.commit(None).await.unwrap();
        assert_eq!(
            result.publication.catalog_revision.as_deref(),
            Some("catalog-before")
        );
        let after = f.snapshot();
        for key in [
            catalog_store::codex_snapshot_key(),
            catalog_store::runtime_config_key(),
            catalog_store::auth_generation_key(),
            keys::paid_control_config(),
            keys::paid_control_observation(PaidProvider::Surplus),
            keys::paid_control_observation(PaidProvider::Metered),
        ] {
            assert_eq!(before.get(&key.0), after.get(&key.0));
        }
        let replay = control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap();
        assert_eq!(
            replay.commit(None).await.unwrap().disposition,
            NativeImportPublicationDisposition::AlreadyCurrent
        );
    });
}
#[test]
fn limited_without_existing_catalog_fails_409_before_group_mutation() {
    run(async {
        let f = Fixture::new();
        let (_, _, started) = f.prepare_version(true, true).await;
        let body = f.publication_wire(&started, true).bytes().unwrap();
        let peer = f.publication_peer(&body, 63).await;
        let before = f.snapshot();
        let control = f.control();
        let error = control
            .prepare_import_publication(&peer, &body)
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, 409);
        assert_eq!(
            error.envelope.error.code.as_deref(),
            Some("codex_catalog_required")
        );
        assert_eq!(before, f.snapshot());
    });
}
#[test]
fn concurrent_config_replacement_and_admin_revocation_never_partially_publish() {
    run(async {
        for revoke in [false, true] {
            let f = Fixture::new();
            f.catalog_seed();
            let (_, _, started) = f.prepare_version(true, true).await;
            let body = f.publication_wire(&started, false).bytes().unwrap();
            let peer = f.publication_peer(&body, 64).await;
            let control = f.control();
            let plan = control
                .prepare_import_publication(&peer, &body)
                .await
                .unwrap();
            let config = synthetic_config(&plan);
            if revoke {
                f.store
                    .rows
                    .lock()
                    .unwrap()
                    .remove(&gateway_auth::passkeys::key("users", "user-fixture").0);
            } else {
                f.store
                    .rows
                    .lock()
                    .unwrap()
                    .get_mut(&keys::paid_control_config().0)
                    .unwrap()
                    .revision = "foreign-config".into();
            }
            let before = f.snapshot();
            assert!(plan.commit(config).await.is_err());
            assert_eq!(before, f.snapshot());
        }
    });
}
#[test]
fn mismatched_terminal_pair_and_forged_receipt_replay_refuse_without_mutation() {
    run(async {
        let f = Fixture::new();
        f.catalog_seed();
        let (_, _, started) = f.prepare_version(true, true).await;
        let mut wire = f.publication_wire(&started, false);
        let body = wire.bytes().unwrap();
        let peer = f.publication_peer(&body, 65).await;
        let control = f.control();
        let plan = control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap();
        let config = synthetic_config(&plan);
        plan.commit(config).await.unwrap();
        wire.native_receipt_ref = "wrong-receipt".into();
        let forged = wire.bytes().unwrap();
        let bad_peer = f.publication_peer(&forged, 66).await;
        let before = f.snapshot();
        assert!(
            control
                .prepare_import_publication(&bad_peer, &forged)
                .await
                .is_err()
        );
        assert_eq!(before, f.snapshot());
        let key = crate::native_control::rows::key("operation", &started.operation_id);
        f.store.rows.lock().unwrap().get_mut(&key.0).unwrap().value["terminal"]["access_generation"] =
            json!(sha256_hex(b"wrong"));
        let before = f.snapshot();
        let plan = control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap();
        let config = synthetic_config(&plan);
        assert!(plan.commit(config).await.is_err());
        assert_eq!(before, f.snapshot());
    });
}
#[test]
fn historical_v2_and_unstarted_normal_v3_never_gain_publication_permission() {
    run(async {
        for (start, v3) in [(true, false), (false, true)] {
            let f = Fixture::new();
            f.catalog_seed();
            let (_, _, data) = f.prepare_version(start, v3).await;
            let body = f.publication_wire(&data, false).bytes().unwrap();
            let peer = f.publication_peer(&body, 67).await;
            let before = f.snapshot();
            assert!(
                f.control()
                    .prepare_import_publication(&peer, &body)
                    .await
                    .is_err()
            );
            assert_eq!(before, f.snapshot());
        }
    });
}
