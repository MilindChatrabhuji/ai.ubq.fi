#![cfg(not(target_arch = "wasm32"))]
mod oracle;
mod support;
use gateway_admin_runtime::claude::{self, AccountUpdate};
use gateway_claude_runtime::*;
use gateway_providers::Headers;
use serde_json::{Value, json};
use support::*;

#[test]
fn authoritative_refusal_rotates_durable_active_and_all_current_accounts_prove_paid() {
    let store = Store::new();
    let a = account(1);
    let b = account(2);
    let config = seed(&store, vec![a.clone(), b.clone()]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config.clone());
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    assert_eq!(first.binding().account_id, a.account_id);
    assert!(matches!(
        apply(&session, &store, &host, &first, 429, exhausted(NOW), NOW),
        OutcomeDecision::Retry
    ));
    assert_eq!(store.roster().active_account_id, Some(b.account_id.clone()));
    assert_eq!(
        store.roster().active_reason,
        "authoritative_unavailability".into()
    );
    let next = selected(&session, &store, &host, &raw);
    assert_eq!(next.binding().account_id, b.account_id);
    assert!(matches!(
        apply(&session, &store, &host, &next, 429, exhausted(NOW), NOW),
        OutcomeDecision::Paid
    ));
    let restarted = ClaudePoolSession::new(config);
    assert!(matches!(
        run(restarted.select(
            &store,
            &host,
            SelectionInput {
                key_id: KEY,
                model: &MODEL.into(),
                raw: &raw,
                effective_effort: fixture_effort(&raw),
                selection: None
            }
        ))
        .unwrap(),
        PoolSelection::Unavailable
    ));
}
#[test]
fn transient_and_transport_failure_keep_active_and_do_not_invent_proof() {
    let store = Store::new();
    let a = account(1);
    let config = seed(&store, vec![a.clone(), account(2)]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    assert!(matches!(
        apply(&session, &store, &host, &first, 503, Headers::new(), NOW),
        OutcomeDecision::Preserve
    ));
    run(session.observe_transport_failure(&store, &host, &first)).unwrap();
    assert!(store.quota(&a).is_none());
    assert_eq!(store.roster().active_account_id, Some(a.account_id));
    assert!(host.accepted.borrow().is_empty());
}
#[test]
fn generic_429_cools_down_but_never_rotates_and_no_reset_limit_has_no_proof() {
    for headers in [
        Headers::new(),
        Headers::from([(
            "anthropic-ratelimit-unified-5h-status".into(),
            "limited".into(),
        )]),
    ] {
        let store = Store::new();
        let a = account(1);
        let config = seed(&store, vec![a.clone(), account(2)]);
        let host = Host::new(&store);
        let session = ClaudePoolSession::new(config.clone());
        let raw = raw();
        let first = selected(&session, &store, &host, &raw);
        assert!(matches!(
            apply(&session, &store, &host, &first, 429, headers, NOW),
            OutcomeDecision::Preserve
        ));
        assert!(
            quota::applicable_proof(store.quota(&a).as_ref(), &a, &MODEL.into(), NOW).is_none()
        );
        assert_eq!(store.roster().active_account_id, Some(a.account_id));
        if quota::cooling_down(store.quota(first.binding()).as_ref(), NOW) {
            let next = ClaudePoolSession::new(config);
            let refused = run(next.select(
                &store,
                &host,
                SelectionInput {
                    key_id: KEY,
                    model: &MODEL.into(),
                    raw: &raw,
                    effective_effort: fixture_effort(&raw),
                    selection: None,
                },
            ))
            .unwrap();
            assert!(matches!(
                refused,
                PoolSelection::Refused { status: 429, .. }
            ));
        }
    }
}
#[test]
fn a_success_is_recorded_at_head_receipt_before_any_clone_and_clears_older_proof_only() {
    let store = Store::new();
    let a = account(1);
    let config = seed(&store, vec![a.clone()]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    let denied =
        run(session.observe_response(&store, &host, &first, head(401, Headers::new(), NOW)))
            .unwrap();
    assert!(matches!(
        run(session.after_outcome(&store, &host, denied, error_evidence(None, false))).unwrap(),
        OutcomeDecision::Paid
    ));
    let older =
        run(session.observe_response(&store, &host, &first, head(200, Headers::new(), NOW - 1)))
            .unwrap();
    assert!(quota::applicable_proof(store.quota(&a).as_ref(), &a, &MODEL.into(), NOW).is_some());
    drop(older);
    let newer =
        run(session.observe_response(&store, &host, &first, head(200, Headers::new(), NOW + 1)))
            .unwrap();
    assert!(
        quota::applicable_proof(store.quota(&a).as_ref(), &a, &MODEL.into(), NOW + 1).is_none()
    );
    drop(newer);
}
#[test]
fn principal_revocation_and_current_catalog_generation_change_refuse_before_dispatch() {
    let store = Store::new();
    let config = seed(&store, vec![account(1)]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config.clone());
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    store.allow(json!([]));
    assert_eq!(
        run(session.ensure_current(&store, &host, &first, KEY, &MODEL.into(), &raw))
            .unwrap_err()
            .status,
        403
    );
    store.allow(json!([KEY]));
    config
        .generation
        .record_success(gateway_admin_runtime::claude_generation::StateChange::CredentialStored);
    assert_eq!(
        run(session.ensure_current(&store, &host, &first, KEY, &MODEL.into(), &raw))
            .unwrap_err()
            .status,
        400
    );
}
#[test]
fn a_persisted_empty_deny_and_roster_tombstone_cannot_bootstrap_an_account() {
    let store = Store::new();
    let config = seed(&store, vec![]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let raw = raw();
    assert!(matches!(
        run(session.select(
            &store,
            &host,
            SelectionInput {
                key_id: KEY,
                model: &MODEL.into(),
                raw: &raw,
                effective_effort: fixture_effort(&raw),
                selection: None
            }
        ))
        .unwrap(),
        PoolSelection::NotApplicable
    ));
    store.allow(json!([]));
    let raw_before = store.get(&claude::account_store_key()).unwrap();
    assert!(matches!(
        run(session.select(
            &store,
            &host,
            SelectionInput {
                key_id: KEY,
                model: &MODEL.into(),
                raw: &raw,
                effective_effort: fixture_effort(&raw),
                selection: None
            }
        ))
        .unwrap(),
        PoolSelection::NotApplicable
    ));
    assert_eq!(store.get(&claude::account_store_key()).unwrap(), raw_before);
}
#[test]
fn guard_clear_rotates_evidence_and_rejects_late_headers_in_real_quota_cas() {
    let store = Store::new();
    let a = account(1);
    let config = seed(&store, vec![a.clone()]);
    let host = std::rc::Rc::new(Host::new(&store));
    let session = std::rc::Rc::new(ClaudePoolSession::new(config));
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    let s = store.clone();
    let h = host.clone();
    let old = a.clone();
    *store.before_commit.borrow_mut() = Some(Box::new(move || {
        run(clear_guards(&s, &*h, &old)).unwrap().unwrap();
    }));
    let _ = apply(&session, &store, &host, &first, 401, Headers::new(), NOW);
    let current = store.roster().accounts[0].clone();
    assert_ne!(current.evidence_generation, a.evidence_generation);
    assert!(
        store
            .quota(&current)
            .unwrap()
            .pool_proofs
            .unwrap()
            .is_empty()
    );
    assert!(host.accepted.borrow().is_empty());
    assert!(host.health.borrow().is_empty());
}
#[test]
fn credential_replacement_rejects_old_quota_and_health_without_touching_other_account() {
    let store = Store::new();
    let a = account(1);
    let b = account(2);
    let config = seed(&store, vec![a.clone(), b.clone()]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    let mut credential = a.credential.clone();
    credential.secret = std::sync::Arc::new(claude::ClaudeSourceSecret::from_source(
        "fixture-new-secret".into(),
    ));
    run(claude::update_account(
        &store,
        &host,
        &Default::default(),
        &AccountUpdate {
            account_id: Some(a.account_id.clone()),
            create_new: false,
            credential: Some(credential),
            workspace: None,
            activate: false,
            expected: Some(a.clone()),
        },
    ))
    .unwrap();
    let _ = apply(&session, &store, &host, &first, 401, exhausted(NOW), NOW);
    assert!(store.quota(&a).is_none());
    assert!(host.accepted.borrow().is_empty());
    assert!(host.health.borrow().is_empty());
    assert_eq!(store.roster().accounts[1], b);
}
#[test]
fn optional_history_and_health_failure_do_not_undo_accepted_quota_or_proof() {
    let store = Store::new();
    let a = account(1);
    let config = seed(&store, vec![a.clone()]);
    let host = Host::new(&store);
    host.fail_telemetry.set(true);
    let session = ClaudePoolSession::new(config);
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    assert!(matches!(
        apply(&session, &store, &host, &first, 429, exhausted(NOW), NOW),
        OutcomeDecision::Paid
    ));
    assert!(quota::applicable_proof(store.quota(&a).as_ref(), &a, &MODEL.into(), NOW).is_some());
    assert_eq!(host.accepted.borrow().len(), 1);
}
#[test]
fn independent_header_families_merge_after_a_real_concurrent_sqlite_cas() {
    let store = Store::new();
    let a = account(1);
    let config = seed(&store, vec![a.clone()]);
    let host = std::rc::Rc::new(Host::new(&store));
    let primary = ClaudePoolSession::new(config.clone());
    let rival = std::rc::Rc::new(ClaudePoolSession::new(config));
    let raw = raw();
    let one = selected(&primary, &store, &host, &raw);
    let two = selected(&rival, &store, &host, &raw);
    let s = store.clone();
    let h = host.clone();
    let r = rival.clone();
    *store.after_read.borrow_mut() = Some((
        quota_key(&a),
        Box::new(move || {
            let _ = run(r.observe_response(
                &s,
                &*h,
                &two,
                head(
                    200,
                    Headers::from([(
                        "anthropic-ratelimit-unified-7d-utilization".into(),
                        "0.3".into(),
                    )]),
                    NOW,
                ),
            ));
        }),
    ));
    let _ = run(primary.observe_response(
        &store,
        &*host,
        &one,
        head(
            200,
            Headers::from([(
                "anthropic-ratelimit-unified-5h-utilization".into(),
                "0.2".into(),
            )]),
            NOW,
        ),
    ))
    .unwrap();
    let quota = store.quota(&a).unwrap();
    assert_eq!(quota.windows.len(), 2);
    assert_eq!(host.accepted.borrow().len(), 2);
}
#[test]
fn workspace_retry_selects_default_rotates_cohort_and_does_not_refetch_effort_catalog() {
    let store = Store::new();
    let a = account(1);
    let config = seed(&store, vec![a.clone()]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let raw = gateway_core::source_json::SourceJson::from_serializable(
        &json!({"model":MODEL,"input":"fixture","reasoning":{"effort":"high"}}),
    )
    .unwrap();
    let first = selected(&session, &store, &host, &raw);
    assert_eq!(host.catalog_calls.get(), 1);
    let observed =
        run(session.observe_response(&store, &host, &first, head(400, Headers::new(), NOW)))
            .unwrap();
    let decision = run(session.after_outcome(
        &store,
        &host,
        observed,
        error_evidence(
            Some("not scoped to a workspace".encode_utf16().collect()),
            true,
        ),
    ))
    .unwrap();
    let OutcomeDecision::WorkspaceContinuation(next) = decision else {
        panic!("expected workspace continuation")
    };
    assert_eq!(
        next.binding().workspace.as_ref().unwrap().id,
        "wrkspc_default".into()
    );
    assert_ne!(next.binding().account_cohort_id, a.account_cohort_id);
    assert_eq!(host.catalog_calls.get(), 1);
    assert!(store.quota(&a).is_none());
    assert_ne!(first.replay_scope(), next.replay_scope());
    run(session.ensure_current(&store, &host, &next, KEY, &MODEL.into(), &raw)).unwrap();
    assert_eq!(host.catalog_calls.get(), 1);
}
#[test]
fn disabled_thinking_refusal_never_discovers_workspace_or_transfers_permission() {
    let store = Store::new();
    let config = seed(&store, vec![account(1)]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let raw = gateway_core::source_json::SourceJson::from_serializable(
        &json!({"model":MODEL,"input":"fixture","reasoning":{"effort":"none"}}),
    )
    .unwrap();
    let first = selected(&session, &store, &host, &raw);
    let observed =
        run(session.observe_response(&store, &host, &first, head(400, Headers::new(), NOW)))
            .unwrap();
    assert!(matches!(
        run(session.after_outcome(
            &store,
            &host,
            observed,
            error_evidence(
                Some("not scoped to a workspace".encode_utf16().collect()),
                true
            )
        ))
        .unwrap(),
        OutcomeDecision::Preserve
    ));
    assert_eq!(host.workspace_calls.get(), 0);
}
#[test]
fn revocation_during_workspace_fetch_refuses_retry_before_owner_update() {
    let store = Store::new();
    let a = account(1);
    let config = seed(&store, vec![a.clone()]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    let s = store.clone();
    *host.workspace_action.borrow_mut() = Some(Box::new(move || s.allow(json!([]))));
    let observed =
        run(session.observe_response(&store, &host, &first, head(400, Headers::new(), NOW)))
            .unwrap();
    let error = run(session.after_outcome(
        &store,
        &host,
        observed,
        error_evidence(
            Some("not scoped to a workspace".encode_utf16().collect()),
            true,
        ),
    ))
    .unwrap_err();
    assert_eq!(error.status, 403);
    assert_eq!(store.roster().accounts[0], a);
}
#[test]
fn split_surrogate_detail_survives_quota_storage_and_the_next_cooldown_response() {
    let store = Store::new();
    let account = account(1);
    let config = seed(&store, vec![account.clone()]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config.clone());
    let raw = raw();
    let selected = selected(&session, &store, &host, &raw);
    let body = format!(
        "{{\"error\":{{\"message\":\"credit balance {}😀\"}}}}",
        "x".repeat(224)
    );
    let received =
        run(session.observe_response(&store, &host, &selected, head(403, Headers::new(), NOW)))
            .unwrap();
    assert!(matches!(
        run(session.after_outcome(
            &store,
            &host,
            received,
            error_evidence(Some(body.encode_utf16().collect()), true)
        ))
        .unwrap(),
        OutcomeDecision::Preserve
    ));
    let state = store.quota(&account).unwrap();
    let message = state.last_error.unwrap().message.unwrap();
    assert_eq!(message.as_units().len(), 240);
    assert_eq!(message.as_units().last(), Some(&0xd83d));
    assert!(state.pool_proofs.unwrap().is_empty());
    let stored = store.get(&quota_key(&account)).unwrap();
    assert_eq!(
        stored.value_encoding,
        gateway_core::value::ValueEncoding::ProfileV2
    );
    assert!(
        stored
            .profile_v2_source_json()
            .unwrap()
            .as_str()
            .contains("\\ud83d")
    );
    let next = ClaudePoolSession::new(config);
    let refused = run(next.select(
        &store,
        &host,
        SelectionInput {
            key_id: KEY,
            model: &MODEL.into(),
            raw: &raw,
            effective_effort: fixture_effort(&raw),
            selection: None,
        },
    ))
    .unwrap();
    let PoolSelection::Refused {
        status,
        headers,
        body,
    } = refused
    else {
        panic!("expected the retained cooldown refusal");
    };
    assert_eq!(status, 403);
    assert_eq!(
        headers.get("Content-Type").map(String::as_str),
        Some("application/json")
    );
    #[derive(serde::Deserialize)]
    struct Error {
        message: gateway_core::js_string::JsString16,
        r#type: String,
        code: String,
    }
    #[derive(serde::Deserialize)]
    struct Envelope {
        error: Error,
    }
    let parsed: Envelope = body.deserialize().unwrap();
    assert_eq!(parsed.error.message, message);
    assert_eq!(parsed.error.r#type, "invalid_request_error");
    assert_eq!(parsed.error.code, "claude_code_cooling_down");
}
#[test]
fn imported_cooldown_statuses_match_pinned_bun_constructor_and_never_authorize_paid() {
    let oracle: Value =
        serde_json::from_str(include_str!("fixtures/cooldown-status.json")).unwrap();
    assert_eq!(oracle["runtime"], "1.4.0");
    let cases = oracle["observations"].as_array().unwrap();
    assert_eq!(cases.len(), 10);
    for case in cases {
        let store = Store::new();
        let account = account(1);
        let config = seed(&store, vec![account.clone()]);
        let host = Host::new(&store);
        store.put(&quota_key(&account), "imported-source", json!({
            "updated_at_ms":NOW,"cooldown_until_ms":NOW+1000,
            "last_error":{"kind":"forbidden","status":case["input"],"message":"source cooldown","at_ms":NOW}
        }));
        let before = store.get(&quota_key(&account)).unwrap();
        let result = run(ClaudePoolSession::new(config).select(
            &store,
            &host,
            SelectionInput {
                key_id: KEY,
                model: &MODEL.into(),
                raw: &raw(),
                effective_effort: fixture_effort(&raw()),
                selection: None,
            },
        ))
        .unwrap();
        if let Some(expected) = case["status"].as_u64() {
            let PoolSelection::Refused { status, body, .. } = result else {
                panic!("expected the source JSON cooldown");
            };
            assert_eq!(u64::from(status), expected);
            assert_eq!(
                body.deserialize::<Value>().unwrap()["error"]["code"],
                "claude_code_cooling_down"
            );
        } else {
            assert_eq!(case["error"], "RangeError");
            assert!(matches!(result, PoolSelection::InternalServerError));
        }
        assert_eq!(store.get(&quota_key(&account)).unwrap(), before);
        assert!(
            quota::applicable_proof(store.quota(&account).as_ref(), &account, &MODEL.into(), NOW)
                .is_none()
        );
        assert!(host.accepted.borrow().is_empty());
        assert!(host.health.borrow().is_empty());
    }
}
#[test]
fn valid_source_negative_zero_does_not_disable_quota_or_full_pool_proof() {
    let store = Store::new();
    let account = account(1);
    let config = seed(&store, vec![account.clone()]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let selected = selected(&session, &store, &host, &raw());
    let headers = Headers::from([(
        "anthropic-ratelimit-unified-5h-utilization".into(),
        "-0".into(),
    )]);
    assert!(matches!(
        apply(&session, &store, &host, &selected, 401, headers, NOW),
        OutcomeDecision::Paid
    ));
    let quota = store.quota(&account).unwrap();
    assert_eq!(
        quota.windows["5h"].utilization.unwrap().to_bits(),
        (-0.0f64).to_bits()
    );
    assert!(quota::applicable_proof(Some(&quota), &account, &MODEL.into(), NOW).is_some());
}
#[test]
fn quota_codec_selection_is_explicit_and_profile_v1_is_not_reinterpreted() {
    let value = json!({"updated_at_ms":NOW});
    let json_record = gateway_core::state::StoredRecord::json("old", value.clone(), None);
    assert!(quota::parse_record(&json_record, NOW).unwrap().is_some());
    let portable = gateway_core::value::PortableValue::from_json(&value);
    let legacy =
        gateway_core::state::StoredRecord::profile("legacy", portable.clone(), None).unwrap();
    assert_eq!(
        quota::parse_record(&legacy, NOW)
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("incompatible_value_encoding")
    );
    let explicit =
        gateway_core::state::StoredRecord::profile_v2("current", portable, None).unwrap();
    assert_eq!(
        quota::parse_record(&explicit, NOW).unwrap(),
        quota::parse_record(&json_record, NOW).unwrap()
    );
    let tagged_json = gateway_core::state::StoredRecord::json("tagged", explicit.value, None);
    assert!(quota::parse_record(&tagged_json, NOW).unwrap().is_none());
}
#[test]
fn real_sqlite_close_reopen_retains_global_active_and_quota() {
    let path = std::env::temp_dir().join(format!("m21-restart-{}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let a = account(1);
    let b = account(2);
    {
        let store = Store::open(&path);
        let config = seed(&store, vec![a.clone(), b.clone()]);
        let host = Host::new(&store);
        let session = ClaudePoolSession::new(config);
        let raw = raw();
        let first = selected(&session, &store, &host, &raw);
        assert!(matches!(
            apply(&session, &store, &host, &first, 429, exhausted(NOW), NOW),
            OutcomeDecision::Retry
        ));
    }
    {
        let reopened = Store::open(&path);
        assert_eq!(reopened.roster().active_account_id, Some(b.account_id));
        assert!(
            quota::applicable_proof(reopened.quota(&a).as_ref(), &a, &MODEL.into(), NOW).is_some()
        );
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn real_claude_selection_and_quota_cas_retain_opaque_model_units() {
    use gateway_core::{js_string::JsString16, model::ModelId, source_json::SourceJson};
    let store = Store::new();
    let account = account(1);
    let config = seed(&store, vec![account.clone()]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let model = ModelId::from_source(JsString16::from_units(
        "claude-".encode_utf16().chain([0xd800]).collect(),
    ));
    let raw = SourceJson::parse(r#"{"model":"claude-\ud800","input":"fixture"}"#).unwrap();
    let PoolSelection::Eligible(selected) = run(session.select(
        &store,
        &host,
        SelectionInput {
            key_id: KEY,
            model: &model,
            raw: &raw,
            effective_effort: fixture_effort(&raw),
            selection: None,
        },
    ))
    .unwrap() else {
        panic!("source model remains eligible");
    };
    run(session.ensure_current(&store, &host, &selected, KEY, &model, &raw)).unwrap();
    let received =
        run(session.observe_response(&store, &host, &selected, head(429, exhausted(NOW), NOW)))
            .unwrap();
    assert!(matches!(
        run(session.after_outcome(&store, &host, received, error_evidence(None, false))).unwrap(),
        OutcomeDecision::Paid
    ));
    let state = store.quota(&account).unwrap();
    assert_eq!(
        quota::applicable_proof(Some(&state), &account, &model, NOW)
            .unwrap()
            .model_id
            .as_ref(),
        Some(&model)
    );
    assert!(
        quota::applicable_proof(Some(&state), &account, &r"claude-\ud800".into(), NOW).is_none()
    );
    let stored = store.get(&quota_key(&account)).unwrap();
    assert_eq!(
        stored.value_encoding,
        gateway_core::value::ValueEncoding::ProfileV2
    );
    println!(
        "M35_CLAUDE_ROW_FIXTURE={}",
        serde_json::to_string(&(quota_key(&account).0, stored)).unwrap()
    );
}

#[test]
fn source_binding_snapshot_named_rotation_and_clear_preserve_units_without_scalar_grant() {
    use gateway_core::{
        js_string::JsString16, source_serialization as source, value::ValueEncoding,
    };
    use std::sync::Arc;
    let store = Store::new();
    let mut a = account(1);
    a.credential.secret = Arc::new(claude::ClaudeSourceSecret::from_source(
        JsString16::from_units(vec![115, 0xd800, 107]),
    ));
    a.credential.hint = JsString16::from_units(vec![104, 0xdc00]);
    a.credential.label = Some(JsString16::from_units(vec![108, 0xd801]));
    let mut workspace_id = "wrkspc_".encode_utf16().collect::<Vec<_>>();
    workspace_id.push(0xdc01);
    a.workspace = Some(claude::Workspace {
        id: JsString16::from_units(workspace_id),
        name: Some(JsString16::from_units(vec![110, 0xd802])),
        source: "kv".into(),
        discovered_at_ms: None,
        verified_at_ms: Some(NOW),
        last_error: None,
    });
    a.credential_fingerprint = claude::fingerprint(&a.credential, a.workspace.as_ref());
    let b = account(2);
    let config = seed(&store, vec![a.clone(), b.clone()]);
    let original = store.get(&claude::account_store_key()).unwrap();
    assert_eq!(original.value_encoding, ValueEncoding::ProfileV2);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    assert_eq!(first.binding(), &a);
    assert!(
        first
            .binding()
            .credential
            .secret
            .try_scalar_secret()
            .is_err()
    );
    assert!(Arc::ptr_eq(
        &first.binding().credential.secret,
        &first.clone().binding().credential.secret
    ));
    assert!(store.quota(&a).is_none());
    assert_eq!(store.get(&claude::account_store_key()).unwrap(), original);
    assert!(matches!(
        apply(&session, &store, &host, &first, 429, exhausted(NOW), NOW),
        OutcomeDecision::Retry
    ));
    let rotated = store.roster();
    assert_eq!(rotated.active_account_id, Some(b.account_id));
    assert_eq!(rotated.accounts[0], a);
    let events = host.accepted.borrow();
    let event = events.first().unwrap();
    let document = event.source_value();
    assert_eq!(
        source::string(&source::member(&document, "workspace_id").unwrap()),
        a.workspace.as_ref().map(|workspace| workspace.id.clone())
    );
    drop(events);
    let cleared = run(clear_guards(&store, &host, &a)).unwrap().unwrap();
    assert!(cleared.pool_proofs.unwrap().is_empty());
    let current = store.roster();
    assert_eq!(current.accounts[0].credential, a.credential);
    assert_eq!(current.accounts[0].workspace, a.workspace);
    assert_ne!(
        current.accounts[0].evidence_generation,
        a.evidence_generation
    );
    assert_eq!(
        store
            .get(&claude::account_store_key())
            .unwrap()
            .value_encoding,
        ValueEncoding::ProfileV2
    );
}

#[test]
fn source_workspace_discovery_retains_raw_json_units_and_default_selection() {
    use gateway_core::js_string::JsString16;
    let store = Store::new();
    let a = account(1);
    let config = seed(&store, vec![a.clone()]);
    let host = Host::new(&store);
    host.workspace.borrow_mut().body = r#"{"data":[{"id":"wrkspc_archived","name":"Default","archived_at":1},{"id":"wrkspc_\ud800","name":" Other\udc00 "},{"id":" wrkspc_\ud801 ","name":" DEFAULT ","archived_at":null}]}"#.into();
    let session = ClaudePoolSession::new(config);
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    let observed =
        run(session.observe_response(&store, &host, &first, head(400, Headers::new(), NOW)))
            .unwrap();
    let outcome = run(session.after_outcome(
        &store,
        &host,
        observed,
        error_evidence(
            Some("not scoped to a workspace".encode_utf16().collect()),
            true,
        ),
    ))
    .unwrap();
    let OutcomeDecision::WorkspaceContinuation(next) = outcome else {
        panic!("expected same-admission workspace continuation")
    };
    let mut id = "wrkspc_".encode_utf16().collect::<Vec<_>>();
    id.push(0xd801);
    let workspace = next.binding().workspace.as_ref().unwrap();
    assert_eq!(workspace.id, JsString16::from_units(id));
    assert_eq!(workspace.name, Some("DEFAULT".into()));
    assert_eq!(next.binding().credential, a.credential);
    assert_ne!(next.binding().account_cohort_id, a.account_cohort_id);
    assert_eq!(
        store.roster().accounts[0].workspace.as_ref(),
        Some(workspace)
    );
    assert_eq!(host.workspace_calls.get(), 1);
    assert!(store.quota(&a).is_none());
    run(session.ensure_current(&store, &host, &next, KEY, &MODEL.into(), &raw)).unwrap();
}

#[test]
fn source_capability_options_preserve_actual_same_binding_scalar_auth() {
    let store = Store::new();
    let a = account(1);
    let config = seed(&store, vec![a]);
    let host = Host::new(&store);
    let session = ClaudePoolSession::new(config);
    let raw = raw();
    let first = selected(&session, &store, &host, &raw);
    let binding = first.binding();
    let secret = binding.credential.secret.try_scalar_secret().unwrap();
    let base = gateway_providers::PrepareOptions {
        auth: gateway_providers::AuthMaterial {
            secret: secret.expose().into(),
            api_key: binding.credential.kind == claude::CredentialKind::ApiKey,
            account_id: Some(binding.account_id.clone()),
            workspace_id: binding
                .workspace
                .as_ref()
                .map(|workspace| workspace.id.try_utf8().unwrap()),
        },
        ..Default::default()
    };
    let prepared = first.prepare_options(base);
    assert_eq!(prepared.auth.secret, secret.expose());
    assert_eq!(
        prepared.auth.account_id.as_deref(),
        Some(binding.account_id.as_str())
    );
    assert_eq!(prepared.auth.workspace_id, None);
    assert!(!prepared.supports_native_effort);
}

#[test]
fn captured_effective_default_drives_actual_lookup_currentness_and_workspace_proof() {
    let store = Store::new();
    let binding = account(1);
    let config = seed(&store, vec![binding]);
    let host = Host::new(&store);
    host.catalog.borrow_mut().models = vec![gateway_core::source_json::SourceJson::from_serializable(&json!({"id":MODEL,"supports_disabled_thinking":true,"supported_reasoning_levels":["medium","high"]})).unwrap()];
    let session = ClaudePoolSession::new(config);
    let raw = raw();
    let PoolSelection::Eligible(selected) = run(session.select(
        &store,
        &host,
        SelectionInput {
            key_id: KEY,
            model: &MODEL.into(),
            raw: &raw,
            effective_effort: Some("medium".into()),
            selection: None,
        },
    ))
    .unwrap() else {
        panic!("honest medium proof");
    };
    assert_eq!(host.catalog_calls.get(), 1);
    assert_eq!(selected.effective_effort(), Some(&"medium".into()));
    run(session.ensure_current(&store, &host, &selected, KEY, &MODEL.into(), &raw)).unwrap();
    assert_eq!(host.catalog_calls.get(), 2);
    let wrong =
        gateway_core::source_json::SourceJson::parse(r#"{"model":"other","input":"fixture"}"#)
            .unwrap();
    assert!(
        run(session.ensure_current(&store, &host, &selected, KEY, &MODEL.into(), &wrong)).is_err()
    );
    host.catalog.borrow_mut().models = vec![gateway_core::source_json::SourceJson::from_serializable(&json!({"id":MODEL,"supports_disabled_thinking":true,"supported_reasoning_levels":["high"]})).unwrap()];
    assert!(
        run(session.ensure_current(&store, &host, &selected, KEY, &MODEL.into(), &raw)).is_err()
    );
    host.catalog.borrow_mut().models = vec![gateway_core::source_json::SourceJson::from_serializable(&json!({"id":MODEL,"supports_disabled_thinking":true,"supported_reasoning_levels":["medium","high"]})).unwrap()];
    let observed =
        run(session.observe_response(&store, &host, &selected, head(400, Headers::new(), NOW)))
            .unwrap();
    let next = run(session.after_outcome(
        &store,
        &host,
        observed,
        error_evidence(
            Some("not scoped to a workspace".encode_utf16().collect()),
            true,
        ),
    ))
    .unwrap();
    let OutcomeDecision::WorkspaceContinuation(next) = next else {
        panic!("actual workspace continuation required");
    };
    assert_eq!(next.effective_effort(), selected.effective_effort());
    let calls = host.catalog_calls.get();
    run(session.ensure_current(&store, &host, &next, KEY, &MODEL.into(), &raw)).unwrap();
    assert_eq!(host.catalog_calls.get(), calls);
}
