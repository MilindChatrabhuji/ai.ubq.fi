//! Real same-store finite phase handler; no private proof is decoded from DATA.
use super::*;
use crate::native_control::import::NativeImportPublicationDisposition;
use gateway_auth::native_import::authority::{
    ImportAuthorityClaimMode, ImportAuthorityCommand as Command, ImportAuthorityReplyData as Reply,
    ImportAuthorityRequestData as Request, ImportAuthorityResult as ResultData,
    ImportAuthorityStateData as State,
};

impl Fixture {
    async fn phase_preparation(&self) -> NativeImportMetadata {
        let token = session_setup(&self.store, true, true);
        let actor = actor::authenticate_admin_actor(
            &self.authority,
            &Host::new(&self.store),
            &self.cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        self.control()
            .prepare_import(
                &actor,
                NativeImportTarget::ExistingAccount {
                    account_id_hash: self.hash.clone(),
                },
            )
            .await
            .unwrap()
            .metadata()
            .clone()
    }
    async fn phase_peer(&self, body: &[u8], salt: u8) -> AuthenticatedNativeOwner {
        let now = self.store.now.load(Ordering::SeqCst);
        let nonce = base64url(&[salt; 32]);
        let time = now.to_string();
        let mac = self
            .id
            .sign(NATIVE_RENEWAL_AUTHORITY_PATH, now, &nonce, body)
            .unwrap();
        NativeAuthenticator::new(&self.id, &self.replay)
            .authenticate(
                NATIVE_RENEWAL_AUTHORITY_PATH,
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
    async fn phase(&self, command: Command, salt: u8) -> ResultData {
        let request = Request::new(command).unwrap();
        let body = request.bytes().unwrap();
        let peer = self.phase_peer(&body, salt).await;
        let bytes = self
            .control()
            .handle_import_authority(&peer, &body)
            .await
            .unwrap();
        Reply::parse_for(&bytes, &request).unwrap().result
    }
    async fn admitted_phase(&self) -> State {
        let metadata = self.phase_preparation().await;
        let ResultData::Admit { state } = self.phase(Command::Admit { metadata }, 80).await else {
            panic!("wrong phase")
        };
        state
    }
}
#[test]
fn real_finite_claim_start_and_bare_b1_preserve_one_original_lifetime() {
    run(async {
        let f = Fixture::new();
        let state = f.admitted_phase().await;
        let before = f.snapshot();
        f.phase(
            Command::FinishCurrent {
                state: state.clone(),
            },
            81,
        )
        .await;
        assert_eq!(before, f.snapshot());
        let ResultData::Claim {
            mode,
            claim_ref,
            start_permit,
            ..
        } = f
            .phase(
                Command::Claim {
                    state: state.clone(),
                },
                82,
            )
            .await
        else {
            panic!("wrong phase")
        };
        assert_eq!(mode, ImportAuthorityClaimMode::ImportOnce);
        let permit = start_permit.unwrap();
        let ResultData::Start {
            started_revision, ..
        } = f
            .phase(
                Command::Start {
                    state: state.clone(),
                    claim_ref: claim_ref.clone(),
                    start_permit: permit.clone(),
                },
                83,
            )
            .await
        else {
            panic!("wrong phase")
        };
        let started = ImportCustodyStartedRequest {
            v: 1,
            operation_id: state.metadata.operation_id.clone(),
            action_ref: state.metadata.action_ref.clone(),
            claim_ref: claim_ref.clone(),
            native_owner_id: state.native_owner_id.clone(),
            account_id_hash: state.account_id_hash.clone(),
            source_native_generation: state.source_native_generation.clone(),
            owner_revision: state.owner_revision.clone(),
            source_revision: state.source_revision.clone(),
            normalized_revision: state.normalized_revision.clone(),
            started_revision: started_revision.unwrap(),
            deadline_ms: state.deadline_ms,
        };
        let body = started.canonical_bytes().unwrap();
        let peer = f.phase_peer(&body, 84).await;
        let before = f.snapshot();
        let reply = f
            .control()
            .handle_import_started(&peer, &body)
            .await
            .unwrap();
        let wire =
            gateway_auth::native_import::authority::ImportCustodyStartedWire::parse(&body).unwrap();
        gateway_auth::native_import::authority::ImportCustodyStartedReplyData::parse_for(
            &reply, &wire,
        )
        .unwrap();
        assert_eq!(before, f.snapshot());
        let ResultData::Start {
            started_revision, ..
        } = f
            .phase(
                Command::Start {
                    state: state.clone(),
                    claim_ref: claim_ref.clone(),
                    start_permit: permit,
                },
                85,
            )
            .await
        else {
            panic!("wrong phase")
        };
        assert!(
            started_revision.is_none(),
            "replayed permit cannot start again"
        );
        f.phase(
            Command::Unknown {
                state: state.clone(),
                claim_ref: claim_ref.clone(),
            },
            86,
        )
        .await;
        let ResultData::Claim {
            mode,
            start_permit,
            claim_ref: retained,
            ..
        } = f.phase(Command::Claim { state }, 87).await
        else {
            panic!("wrong phase")
        };
        assert_eq!(mode, ImportAuthorityClaimMode::ReconcileOnly);
        assert!(start_permit.is_none());
        assert_eq!(retained, claim_ref);
    });
}
#[test]
fn phase_peer_body_replacement_revocation_and_expiry_cannot_create_effects() {
    run(async {
        for failure in [0, 1, 2, 3] {
            let f = Fixture::new();
            let mut state = f.admitted_phase().await;
            let original = Request::new(Command::Claim {
                state: state.clone(),
            })
            .unwrap()
            .bytes()
            .unwrap();
            let peer = f.phase_peer(&original, 88).await;
            let body = if failure == 0 {
                Request::new(Command::Current {
                    state: state.clone(),
                    claim_ref: None,
                })
                .unwrap()
                .bytes()
                .unwrap()
            } else {
                original.clone()
            };
            if failure == 1 {
                f.store
                    .rows
                    .lock()
                    .unwrap()
                    .remove(&gateway_auth::passkeys::key("users", "user-fixture").0);
            }
            if failure == 2 {
                f.store.now.store(state.deadline_ms, Ordering::SeqCst);
            }
            if failure == 3 {
                state.action_revision = "foreign-action".into();
            }
            let before = f.snapshot();
            if failure == 3 {
                let request = Request::new(Command::Claim { state })
                    .unwrap()
                    .bytes()
                    .unwrap();
                let peer = f.phase_peer(&request, 89).await;
                assert!(
                    f.control()
                        .handle_import_authority(&peer, &request)
                        .await
                        .is_err()
                );
            } else {
                assert!(
                    f.control()
                        .handle_import_authority(&peer, &body)
                        .await
                        .is_err()
                );
            }
            assert_eq!(before, f.snapshot());
        }
    });
}
#[test]
fn catalog_presence_is_a_fresh_strong_observation_not_cached_truth() {
    run(async {
        let f = Fixture::new();
        f.catalog_seed();
        let state = f.admitted_phase().await;
        let key = gateway_schema::catalog_store::codex_snapshot_key();
        f.store.race(key, None);
        let ResultData::Current {
            catalog_revision, ..
        } = f
            .phase(
                Command::Current {
                    state,
                    claim_ref: None,
                },
                90,
            )
            .await
        else {
            panic!("wrong phase")
        };
        assert!(
            catalog_revision.is_none(),
            "the changed catalog must be reread after failed coherent CAS"
        );
    });
}
#[test]
fn terminal_query_requires_exact_matching_guarded_group_and_rejects_foreign_replacement() {
    run(async {
        let f = Fixture::new();
        f.catalog_seed();
        let state = f.admitted_phase().await;
        let (_, _, started) = f.prepare_version(true, true).await;
        assert_eq!(state.metadata.action_ref, started.action_ref);
        let wire = f.publication_wire(&started, false);
        let body = wire.bytes().unwrap();
        let peer = f.publication_peer(&body, 91).await;
        let control = f.control();
        let plan = control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap();
        let config = super::publication::synthetic_config(&plan);
        let applied = plan.commit(config).await.unwrap();
        assert_eq!(
            applied.disposition,
            NativeImportPublicationDisposition::Applied
        );
        let command = Command::Terminal {
            state: state.clone(),
            claim_ref: started.claim_ref.clone(),
            publication_revision: wire.publication_revision.clone(),
            native_receipt_ref: wire.native_receipt_ref.clone(),
            publication_request_digest: sha256_hex(&body),
        };
        let before = f.snapshot();
        let ResultData::Terminal {
            terminal,
            completion,
            ..
        } = f.phase(command.clone(), 92).await
        else {
            panic!("wrong phase")
        };
        assert_eq!(
            terminal.native_source_generation,
            wire.native_source_generation
        );
        assert_eq!(completion.account_count, 1);
        assert_eq!(completion.account_ids, ["synthetic-account"]);
        assert_eq!(completion.models.count, 1);
        assert_eq!(completion.models.client_version.as_deref(), Some("1.1.0"));
        assert_eq!(before, f.snapshot());
        let key = gateway_schema::catalog_store::runtime_config_key();
        f.store
            .rows
            .lock()
            .unwrap()
            .get_mut(&key.0)
            .unwrap()
            .revision = "foreign-runtime".into();
        let request = Request::new(command).unwrap().bytes().unwrap();
        let peer = f.phase_peer(&request, 93).await;
        let before = f.snapshot();
        assert!(
            control
                .handle_import_authority(&peer, &request)
                .await
                .is_err()
        );
        assert_eq!(before, f.snapshot());
    });
}

#[cfg(unix)]
mod actual_tls;

mod custody_terminal;

mod completion_wire;

mod catalog_seed;

mod auth_timestamp;

mod owner_selection;
