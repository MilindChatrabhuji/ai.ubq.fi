use super::*;
use crate::{manual_reset::*, native_live::*, reset::*, routing::*};
use gateway_auth::{
    native_auth::{
        NativeAuthHeaders, NativeCapability, NativeNonceAuthority, NativeTransportIdentity,
    },
    native_live::NativeLiveAuthenticator,
    provider_credentials::{CodexSourceAccount, CodexSourcePool, codex_source_pool_key},
};
use gateway_core::{
    identity::{ActiveSelection, ActiveTransitionReason, PoolVersionstamp},
    tuple_key::{ScalarKeyPart, TupleKey},
};
use std::collections::BTreeSet;

struct UniqueTokens(AtomicUsize);
impl TokenSource for UniqueTokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok(format!(
            "live-manual-token-{}",
            self.0.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
fn test_authority(store: &Store) -> Authority<Store, UniqueTokens> {
    Authority::with_clock(
        store.clone(),
        UniqueTokens(AtomicUsize::new(1)),
        store.clone(),
    )
}
fn source(store: &Store, access: &str, revision: &str) -> SubscriptionPool {
    let account = CodexSourceAccount {
        account_id: "source-account".into(),
        access_token: Secret::new(access.to_owned()),
        refresh_token: Secret::new("SYNTHETIC_REFRESH".to_owned()),
        updated_at_ms: 1_000_000.0,
        native_owner: None,
    };
    let identity = account.identity();
    let pool = SubscriptionPool {
        v: 1,
        pool_versionstamp: PoolVersionstamp(revision.into()),
        accounts: vec![PoolAccount {
            account_id_hash: identity.routing_account_hash,
            admin_account_hash: identity.administrative_account_hash,
            credential_version: identity.credential_version,
            enabled: true,
        }],
    };
    store.seed(
        codex_source_pool_key(),
        revision,
        CodexSourcePool {
            accounts: vec![account],
            updated_at_ms: 1_000_000.0,
        }
        .private_source_value(),
    );
    store.seed(keys::pool(), &format!("normalized-{revision}"), &pool);
    pool
}
fn reset_policy(store: &Store, enabled: bool) {
    store.seed(
        keys::reset_config(),
        "reset-policy",
        ResetConfig {
            enabled,
            mode: ResetMode::Shadow,
            max_per_account_per_day: 1,
            max_per_account_per_window: 1,
            ..Default::default()
        },
    );
}
fn usage(pool: &SubscriptionPool, at: i64, used: f64) -> CapacityObservation {
    CapacityObservation {
        slot: 0,
        account_id_hash: pool.accounts[0].account_id_hash.clone(),
        state: CapacityState::Available,
        source_observed_at_ms: Some(at),
        snapshot_at_ms: at,
        windows: CapacityWindows {
            primary: Some(CapacityWindow {
                limit_window_seconds: Some(18000),
                used_percent: Some(used),
                reset_at_ms: Some(9_000_000),
            }),
            secondary: None,
        },
        additional_rate_limits: vec![],
    }
}
fn live_mapping(call: &str, pending: bool) -> RecordKey {
    let mut parts = vec![
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("codex_live_calls"),
        ScalarKeyPart::String("v1"),
    ];
    if pending {
        parts.push(ScalarKeyPart::String("pending_retirement"));
    }
    parts.push(ScalarKeyPart::String(call));
    TupleKey::from_scalar_parts(&parts).to_record_key()
}
fn live_identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "live-test".into(),
        "owner".into(),
        "epoch".into(),
        [7; 32],
        BTreeSet::from([NativeCapability::LiveSideband]),
    )
    .unwrap()
}
#[derive(Default)]
struct Nonces(Mutex<BTreeSet<String>>);
impl NativeNonceAuthority for Nonces {
    async fn consume_nonce(
        &self,
        _: &str,
        nonce: &str,
        _: i64,
        _: i64,
    ) -> Result<(), GatewayError> {
        if self.0.lock().unwrap().insert(nonce.into()) {
            Ok(())
        } else {
            Err(fail())
        }
    }
}
async fn proof(
    identity: &NativeTransportIdentity,
    body: &[u8],
    n: u8,
) -> gateway_auth::native_live::AuthenticatedNativeLive {
    let nonce = gateway_auth::crypto::base64url(&[n; 32]);
    let mac = identity
        .sign_live_authority_request(1_000_000, &nonce, body)
        .unwrap();
    NativeLiveAuthenticator::new(identity, &Nonces::default())
        .authenticate_authority(
            NativeAuthHeaders {
                version: "1",
                key_id: "live-test",
                time_ms: "1000000",
                nonce: &nonce,
                mac: &mac,
            },
            body,
            1_000_000,
        )
        .await
        .unwrap()
}

#[test]
fn manual_shadow_opt_out_uses_shared_budget_then_promotes_once() {
    run(async {
        let store = Store::default();
        let pool = source(&store, "SYNTHETIC_ACCESS", "source-one");
        reset_policy(&store, true);
        let hash = &pool.accounts[0].admin_account_hash.0;
        store.seed(
            keys::reset_usage(hash),
            "automatic-off",
            serde_json::json!({"enabled":false}),
        );
        let token = session_setup(&store, true, true);
        let auth = test_authority(&store);
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_admin_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let ManualResetPreparation::NeedsUsage(target) =
            auth.prepare_manual_reset(&actor, &cfg, hash).await.unwrap()
        else {
            panic!("needs fresh source usage")
        };
        let action = auth
            .begin_manual_reset(&target, &cfg, &usage(&pool, 1_000_000, 100.0))
            .await
            .unwrap();
        let ResetClaim::Submit { record, .. } =
            auth.claim_manual_reset(&action, &cfg).await.unwrap()
        else {
            panic!("manual shadow is submit capable")
        };
        let submitted = auth
            .prepare_manual_reset_submission(&action, &cfg, &record)
            .await
            .unwrap();
        let renewed = auth
            .renew_manual_reset_before_redeem(&action, &cfg, &submitted)
            .await
            .unwrap();
        let verified = auth
            .record_reset_outcome(
                &renewed,
                ResetState::Verified,
                Some("source-terminal"),
                None,
                1_000_000,
            )
            .await
            .unwrap();
        store.now.store(1_000_010, Ordering::SeqCst);
        let result = auth
            .promote_manual_reset(&action, &cfg, &verified, &usage(&pool, 1_000_010, 0.0))
            .await
            .unwrap();
        assert_eq!(result.active_account_id_hash, *hash);
        let active: ActiveSelection = serde_json::from_value(
            store
                .rows
                .lock()
                .unwrap()
                .get(&keys::active().0)
                .unwrap()
                .json_value()
                .unwrap()
                .clone(),
        )
        .unwrap();
        assert_eq!(
            active.transition_reason,
            Some(ActiveTransitionReason::ManualReset)
        );
        assert!(
            auth.promote_manual_reset(&action, &cfg, &verified, &usage(&pool, 1_000_010, 0.0))
                .await
                .is_err()
        );
        assert!(auth.prepare_manual_reset(&actor, &cfg, hash).await.is_err());
        let budget: AccountDayBudget = serde_json::from_value(
            store
                .rows
                .lock()
                .unwrap()
                .get(&keys::reset_day(hash, &utc_day(1_000_000).unwrap()).0)
                .unwrap()
                .json_value()
                .unwrap()
                .clone(),
        )
        .unwrap();
        assert_eq!(budget.submission_count, 1);
        assert_eq!(host.fetches.load(Ordering::SeqCst), 0);
    });
}
#[test]
fn manual_disabled_and_changed_credentials_never_cross_submission() {
    run(async {
        let store = Store::default();
        let pool = source(&store, "SYNTHETIC_ACCESS", "source-one");
        reset_policy(&store, false);
        let token = session_setup(&store, true, true);
        let auth = test_authority(&store);
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_admin_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let hash = &pool.accounts[0].admin_account_hash.0;
        assert!(auth.prepare_manual_reset(&actor, &cfg, hash).await.is_err());
        assert!(!store.rows.lock().unwrap().contains_key(&intent_key(hash).0));
        reset_policy(&store, true);
        let ManualResetPreparation::NeedsUsage(target) =
            auth.prepare_manual_reset(&actor, &cfg, hash).await.unwrap()
        else {
            panic!()
        };
        let action = auth
            .begin_manual_reset(&target, &cfg, &usage(&pool, 1_000_000, 100.0))
            .await
            .unwrap();
        source(&store, "REPLACED_ACCESS", "source-two");
        assert!(auth.claim_manual_reset(&action, &cfg).await.is_err());
        assert!(
            !store
                .rows
                .lock()
                .unwrap()
                .contains_key(&keys::reset_day(hash, &utc_day(1_000_000).unwrap()).0)
        );
    });
}
#[test]
fn uncertain_manual_consume_remains_non_replayable_after_restart_and_intent_age() {
    run(async {
        let store = Store::default();
        let pool = source(&store, "SYNTHETIC_ACCESS", "source-one");
        reset_policy(&store, true);
        let token = session_setup(&store, true, true);
        let auth = test_authority(&store);
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_admin_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let ManualResetPreparation::NeedsUsage(target) = auth
            .prepare_manual_reset(&actor, &cfg, &pool.accounts[0].admin_account_hash.0)
            .await
            .unwrap()
        else {
            panic!()
        };
        let action = auth
            .begin_manual_reset(&target, &cfg, &usage(&pool, 1_000_000, 100.0))
            .await
            .unwrap();
        let ResetClaim::Submit { record, .. } =
            auth.claim_manual_reset(&action, &cfg).await.unwrap()
        else {
            panic!()
        };
        let submitted = auth
            .prepare_manual_reset_submission(&action, &cfg, &record)
            .await
            .unwrap();
        auth.record_reset_outcome(
            &submitted,
            ResetState::Unknown,
            None,
            Some("transport_unknown"),
            1_000_000,
        )
        .await
        .unwrap();
        store.now.store(1_060_000, Ordering::SeqCst);
        let restarted = test_authority(&store);
        assert!(matches!(
            restarted.claim_manual_reset(&action, &cfg).await.unwrap(),
            ResetClaim::InProgress(_)
        ));
    });
}
#[test]
fn live_rechecks_current_external_access_and_reconciles_real_terminal_after_revocation() {
    run(async {
        let store = Store::default();
        source(&store, "SYNTHETIC_ACCESS", "source-one");
        let identity = live_identity();
        store.seed(
            keys::paid_control_owner(),
            "owner-one",
            crate::paid_control::PaidControlOwner {
                v: 1,
                owner_id: identity.owner_id().into(),
                owner_epoch: identity.owner_epoch().into(),
                key_fingerprint: identity.key_fingerprint().into(),
            },
        );
        let token = session_setup(&store, true, true);
        let auth = test_authority(&store);
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_client_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        store.seed(live_mapping("call/encoded",false),"map-one",serde_json::json!({"account_id":"source-account","principal_id":"passkey-user:user-fixture","created_at_ms":1_000_000}));
        let service = NativeLiveAuthority::configured(&auth, &identity, &cfg);
        let action = service
            .prepare_live_sideband(&actor, "call/encoded")
            .await
            .unwrap();
        let body = serde_json::to_vec(&NativeLiveAuthorityRequest::Authorize {
            v: 1,
            action_ref: action.action_ref().into(),
            connection_id: "connection-one".into(),
        })
        .unwrap();
        let NativeLiveAuthorityResponse::Authorize {
            authorization_ref,
            access,
            ..
        } = service
            .execute(&proof(&identity, &body, 1).await, &body)
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(access.expose(), "SYNTHETIC_ACCESS");
        assert!(!format!("{access:?}").contains("SYNTHETIC_ACCESS"));
        source(&store, "CURRENT_ACCESS", "source-two");
        let recheck = serde_json::to_vec(&NativeLiveAuthorityRequest::Recheck {
            v: 1,
            action_ref: action.action_ref().into(),
            connection_id: "connection-one".into(),
            authorization_ref: authorization_ref.clone(),
        })
        .unwrap();
        let NativeLiveAuthorityResponse::Recheck { access, .. } = service
            .execute(&proof(&identity, &recheck, 2).await, &recheck)
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(access.expose(), "CURRENT_ACCESS");
        store.rows.lock().unwrap().remove(
            &session_index::index_key(&session_index::digest(&token))
                .unwrap()
                .0,
        );
        assert!(
            service
                .execute(&proof(&identity, &recheck, 3).await, &recheck)
                .await
                .is_err()
        );
        store.seed(live_mapping("call/encoded",false),"newer-mapping",serde_json::json!({"account_id":"different-account","principal_id":"different-principal"}));
        let retire = serde_json::to_vec(&NativeLiveAuthorityRequest::Retire {
            v: 1,
            action_ref: action.action_ref().into(),
            connection_id: "connection-one".into(),
            authorization_ref,
            upstream_status: 410,
        })
        .unwrap();
        assert!(matches!(
            service
                .execute(&proof(&identity, &retire, 4).await, &retire)
                .await
                .unwrap(),
            NativeLiveAuthorityResponse::Retire {
                outcome: NativeLiveRetirement::Retired,
                ..
            }
        ));
        assert!(
            !store
                .rows
                .lock()
                .unwrap()
                .contains_key(&live_mapping("call/encoded", false).0)
        );
        for row in store.rows.lock().unwrap().values() {
            let encoded = serde_json::to_string(row.json_value().unwrap()).unwrap();
            if encoded.contains("action_ref") {
                assert!(!encoded.contains("CURRENT_ACCESS"));
                assert!(!encoded.contains("SYNTHETIC_REFRESH"));
            }
        }
    });
}
#[test]
fn private_wire_and_source_intent_refuse_forged_fields_or_malformed_rows() {
    assert!(NativeLiveAuthorityRequest::parse(br#"{"operation":"authorize","v":1,"action_ref":"a","connection_id":"b","original_auth_headers":{}}"#).is_err());
    assert!(NativeLiveAuthorityRequest::parse(br#"{"operation":"retire","v":1,"action_ref":"a","connection_id":"b","authorization_ref":"c","upstream_status":500}"#).is_err());
    let row = serde_json::json!({"v":1,"account_id_hash":"a".repeat(64),"credential_version":"b".repeat(64),"quota_reset_at_ms":10,"routing_generation":0,"created_at_ms":1,"promoted_at_ms":null,"quota_signal_at_ms":null});
    assert!(parse_manual_intent(&row).is_ok());
    let mut missing = row.clone();
    missing.as_object_mut().unwrap().remove("promoted_at_ms");
    assert!(parse_manual_intent(&missing).is_err());
}

#[test]
fn admin_recheck_writes_only_routing_and_retains_ambiguous_reset_identity() {
    run(async {
        let store = Store::default();
        let pool = source(&store, "SYNTHETIC_ACCESS", "source-one");
        let mut state = normalize_routing_state(&pool, None, 1_000_000).unwrap();
        let slot = &mut state.slots[0];
        slot.quota_blocked_until_ms = Some(9_000_000);
        slot.quota_blocked_classes = vec!["standard".into()];
        slot.retained_reset_at_ms = Some(9_000_000);
        slot.reset_identity_stable = true;
        slot.quota_blocks.insert(
            "standard".into(),
            QuotaBlock {
                blocked_until_ms: 9_000_000,
                source: QuotaBlockSource::BodyResetsAt,
                legacy_fallback: false,
                observed_at_ms: Some(900_000),
                reset_at_ms: Some(9_000_000),
                reset_is_stable: true,
                reset_ambiguous: false,
                recovery_pending: false,
            },
        );
        store.seed(keys::routing(), "routing-before", &state);
        let token = session_setup(&store, true, true);
        let auth = test_authority(&store);
        let cfg = config();
        let host = Host::new(&store);
        let actor = authenticate_admin_actor(
            &auth,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        assert!(auth.recheck_codex_slot(&actor, &cfg, 1).await.unwrap());
        let rows = store.rows.lock().unwrap();
        let next = parse_routing_state(rows.get(&keys::routing().0).unwrap().json_value().unwrap())
            .unwrap();
        let slot = &next.slots[0];
        assert_eq!(slot.quota_blocked_until_ms, Some(1_000_000));
        assert_eq!(slot.retained_reset_at_ms, Some(9_000_000));
        assert!(slot.reset_identity_ambiguous);
        assert!(slot.quota_blocks["standard"].reset_ambiguous);
        assert_eq!(slot.generation, state.slots[0].generation + 1);
        assert!(!rows.contains_key(&keys::active().0));
        assert_eq!(host.fetches.load(Ordering::SeqCst), 0);
    });
}
