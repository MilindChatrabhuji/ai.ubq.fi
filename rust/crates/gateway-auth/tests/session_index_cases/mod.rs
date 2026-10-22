use super::PasskeyService;
use crate as auth;
mod support;
use auth::{AuthConfig, AuthHost, AuthService, session_index};
use gateway_core::state::*;
use support::*;

#[test]
fn actual_session_creation_and_logout_publish_and_delete_one_atomic_pair() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let config = AuthConfig::default();
        user(&store, true, "policy-1");
        let service = PasskeyService {
            store: &store,
            host: &host,
            config: &config,
        };
        let first = service
            .create_session("fixture-user".into(), None)
            .await
            .unwrap();
        let second = service
            .create_session("fixture-user".into(), None)
            .await
            .unwrap();
        let first_digest = session_index::digest(&first.token);
        let second_digest = session_index::digest(&second.token);
        assert_ne!(first_digest, second_digest);
        let index = session_index::read_current(&store, &first_digest, host.now_ms())
            .await
            .unwrap()
            .unwrap();
        let source = store
            .read(&auth::passkeys::key("sessions", &first.token))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(index.fence.session_revision, source.revision);
        assert_eq!(index.fence.user_id, "fixture-user");
        let create = store.history.borrow()[0].clone();
        assert_eq!(create.checks.len(), 2);
        assert_eq!(create.mutations.len(), 2);
        let auth = AuthService::new(&store, &host, &config);
        assert!(
            auth.authenticate_admin(&request(&first.token))
                .await
                .unwrap()
                .is_admin
        );
        let result = service.logout(&request(&first.token), None).await.unwrap();
        assert_eq!(result.status, 204);
        assert_eq!(
            service
                .logout(&request(&first.token), None)
                .await
                .unwrap()
                .status,
            204
        );
        assert!(
            store
                .read(&auth::passkeys::key("sessions", &first.token))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            session_index::read_current(&store, &first_digest, host.now_ms())
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            session_index::read_current(&store, &second_digest, host.now_ms())
                .await
                .unwrap()
                .is_some()
        );
        let delete = store.history.borrow().last().unwrap().clone();
        assert_eq!(delete.checks.len(), 2);
        assert_eq!(delete.mutations.len(), 2);
    });
}

#[test]
fn creation_conflicts_and_unknown_writes_never_detach_a_valid_index() {
    run(async {
        for fault in [0, 1, 2] {
            let store = Store::default();
            let host = Host::default();
            let config = AuthConfig::default();
            match fault {
                0 => store.conflict.set(true),
                1 => store.unknown_before.set(true),
                _ => store.unknown_after.set(true),
            }
            let service = PasskeyService {
                store: &store,
                host: &host,
                config: &config,
            };
            assert!(
                service
                    .create_session("fixture-user".into(), None)
                    .await
                    .is_err()
            );
            let tx = store.history.borrow()[0].clone();
            assert_eq!(tx.checks.len(), 2);
            assert_eq!(tx.mutations.len(), 2);
            let rows = store.rows.borrow();
            assert!(rows.is_empty() || rows.len() == 2);
            for mutation in tx.mutations {
                let RecordMutation::Put { key, record } = mutation else {
                    panic!("create was not a put");
                };
                assert_eq!(
                    rows.get(&key.0),
                    if fault == 2 { Some(&record) } else { None }
                );
            }
        }
    });
}

#[test]
fn logout_cannot_report_success_on_conflict_or_unknown_write() {
    run(async {
        for fault in [0, 1, 2] {
            let store = Store::default();
            let host = Host::default();
            let config = AuthConfig::default();
            user(&store, true, "policy");
            let service = PasskeyService {
                store: &store,
                host: &host,
                config: &config,
            };
            let value = service
                .create_session("fixture-user".into(), None)
                .await
                .unwrap();
            match fault {
                0 => store.conflict.set(true),
                1 => store.unknown_before.set(true),
                _ => store.unknown_after.set(true),
            }
            assert!(service.logout(&request(&value.token), None).await.is_err());
            let source = store
                .read(&auth::passkeys::key("sessions", &value.token))
                .await
                .unwrap();
            let index = session_index::read_current(
                &store,
                &session_index::digest(&value.token),
                host.now_ms(),
            )
            .await
            .unwrap();
            assert_eq!(source.is_some(), index.is_some());
            assert_eq!(source.is_none(), fault == 2);
        }
    });
}

#[test]
fn expiry_cleanup_deletes_both_and_source_ttl_bounds_the_metadata_lifetime() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let config = AuthConfig::default();
        user(&store, true, "policy");
        let value = session("uos_ai_session_expired_fixture", host.now_ms() + 1);
        install(&store, &value, "source-1", None, true);
        host.now.set(value.expires_at_ms);
        let service = PasskeyService {
            store: &store,
            host: &host,
            config: &config,
        };
        assert!(
            service
                .session(&request(&value.token), None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .read(&auth::passkeys::key("sessions", &value.token))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .read(&session_index::index_key(&session_index::digest(&value.token)).unwrap())
                .await
                .unwrap()
                .is_none()
        );
        let future = session("uos_ai_session_short_ttl_fixture", host.now_ms() + 100);
        install(&store, &future, "source-2", Some(host.now_ms() + 10), true);
        host.now.set(host.now_ms() + 10);
        assert!(
            service
                .session(&request(&future.token), None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            session_index::read_current(
                &store,
                &session_index::digest(&future.token),
                host.now_ms()
            )
            .await
            .unwrap()
            .is_none()
        );
    });
}

#[test]
fn replacement_and_current_user_revision_fence_prepared_actions() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let config = AuthConfig::default();
        user(&store, true, "policy-1");
        let service = PasskeyService {
            store: &store,
            host: &host,
            config: &config,
        };
        let value = service
            .create_session("fixture-user".into(), None)
            .await
            .unwrap();
        let digest = session_index::digest(&value.token);
        let index_key = session_index::index_key(&digest).unwrap();
        let old = session_index::read_current(&store, &digest, host.now_ms())
            .await
            .unwrap()
            .unwrap();
        let user_key = auth::passkeys::key("users", "fixture-user");
        user(&store, false, "policy-2");
        let auth = AuthService::new(&store, &host, &config);
        assert_eq!(
            auth.authenticate_admin(&request(&value.token))
                .await
                .unwrap_err()
                .status,
            403
        );
        let stale_user = AtomicTransition {
            checks: vec![
                RevisionCheck {
                    key: index_key.clone(),
                    expected_revision: Some(old.revision.clone()),
                },
                RevisionCheck {
                    key: user_key,
                    expected_revision: Some("policy-1".into()),
                },
            ],
            mutations: vec![],
        };
        assert_eq!(
            store.commit(stale_user).await.unwrap(),
            CommitOutcome::Conflict
        );
        let source_key = auth::passkeys::key("sessions", &value.token);
        let replacement_revision = "replacement-session-revision";
        let replacement = AtomicTransition {
            checks: vec![
                RevisionCheck {
                    key: source_key.clone(),
                    expected_revision: Some(old.fence.session_revision.clone()),
                },
                RevisionCheck {
                    key: index_key.clone(),
                    expected_revision: Some(old.revision.clone()),
                },
            ],
            mutations: vec![
                RecordMutation::Put {
                    key: source_key,
                    record: StoredRecord::json(
                        replacement_revision,
                        serde_json::to_value(&value).unwrap(),
                        Some(value.expires_at_ms),
                    ),
                },
                RecordMutation::Put {
                    key: index_key.clone(),
                    record: session_index::record_for_session(
                        &value,
                        replacement_revision,
                        Some(value.expires_at_ms),
                    )
                    .unwrap(),
                },
            ],
        };
        assert_eq!(
            store.commit(replacement).await.unwrap(),
            CommitOutcome::Committed
        );
        assert_eq!(
            store
                .commit(AtomicTransition {
                    checks: vec![RevisionCheck {
                        key: index_key,
                        expected_revision: Some(old.revision)
                    }],
                    mutations: vec![]
                })
                .await
                .unwrap(),
            CommitOutcome::Conflict
        );
        assert_ne!(
            session_index::read_current(&store, &digest, host.now_ms())
                .await
                .unwrap()
                .unwrap()
                .fence
                .session_revision,
            old.fence.session_revision
        );
    });
}
