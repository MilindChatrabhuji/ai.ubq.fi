use std::collections::BTreeSet;

use gateway_auth::crypto::{Secret, base64url};
use gateway_native::*;
use serde_json::json;

fn token(expiry: i64, user: &str, account: &str) -> String {
    format!("e30.{}.fixture",base64url(json!({"exp":expiry,"email":"fixture@example.invalid","https://api.openai.com/auth":{"chatgpt_user_id":user,"chatgpt_account_id":account}}).to_string().as_bytes()))
}
fn credentials(expiry: i64, refresh: &str, time: &str) -> NativeCredentials {
    NativeCredentials {
        account_id: "workspace".into(),
        access_token: Secret::new(token(expiry, "user", "workspace")),
        refresh_token: Secret::new(refresh.into()),
        email: Some("fixture@example.invalid".into()),
        native_refreshed_at: Some(time.into()),
        external_user_id: None,
    }
}

#[test]
fn source_account_identities_keep_their_distinct_hash_contracts() {
    let auth = NativeCredentials {
        account_id: "account-fixture".into(),
        access_token: Secret::new("access-fixture".into()),
        refresh_token: Secret::new("refresh-fixture".into()),
        email: None,
        native_refreshed_at: None,
        external_user_id: None,
    };
    // Fixed vectors from the source's UTF-8 SHA-256 inputs, independently computed
    // with Python hashlib; swapping these domains must break conformance.
    assert_eq!(
        auth.routing_account_hash(),
        "484a1343b26c959daf682d78764d851fff7201648d4c18104f45f490570141be"
    );
    assert_eq!(
        auth.administrative_account_hash(),
        "f705fb57e2c0ddd862af3f17acf9a3dc64aebd260f44888899898ca2abb88e19"
    );
    assert_eq!(
        auth.routing_credential_version(),
        "a54556bde850d41f3791d5cb7f8740e62be0e8da6845803f48d4318a41557ed5"
    );
    assert_eq!(
        auth.generation_hash(),
        "ed4213412e76b59cdbf9c764a316e4028e86bb8fe85caf3a1246b94e10ad96d5"
    );
}

#[test]
fn ownership_bootstrap_needs_exact_credentials() {
    let old = credentials(2000, "refresh-a", "2026-10-18T12:00:00Z");
    let changed = credentials(2000, "refresh-b", "2026-10-18T12:00:00Z");
    assert!(verify_bootstrap(&old, &old).is_ok());
    assert_eq!(verify_bootstrap(&old, &changed).unwrap_err().status, 409);
    assert_ne!(old.generation_hash(), changed.generation_hash());
    assert!(!format!("{old:?}").contains("refresh-a"));
}

#[test]
fn persisted_native_time_orders_equal_expiry_below_milliseconds() {
    let old = credentials(2000, "refresh-a", "2026-10-18T12:00:00.000000001Z");
    let next = credentials(2000, "refresh-b", "2026-10-18T12:00:00.000000002Z");
    assert!(verify_generation(&old, &next, 1_000_000, true).is_ok());
    assert!(verify_generation(&next, &old, 1_000_000, true).is_err());
    let mut regressing = next.clone();
    regressing.access_token = Secret::new(token(1999, "user", "workspace"));
    assert!(verify_generation(&old, &regressing, 1_000_000, true).is_err());
    assert!(
        native_refresh_time_ns(old.native_refreshed_at.as_deref())
            < native_refresh_time_ns(next.native_refreshed_at.as_deref())
    );
}

#[test]
fn access_expiry_margin_and_account_binding_fail_closed() {
    let old = credentials(1000, "a", "2026-10-18T12:00:00Z");
    let next = credentials(1120, "b", "2026-10-18T12:01:00Z");
    assert!(verify_generation(&old, &next, 1_000_000, true).is_err());
    assert!(verify_generation(&old, &next, 1_000_000, false).is_ok());
    let mut changed = next;
    changed.account_id = "other".into();
    assert_eq!(
        verify_generation(&old, &changed, 1_000_000, true)
            .unwrap_err()
            .status,
        409
    );
}

#[test]
fn native_account_null_fallback_is_exact_and_fixed_home_bound() {
    let exact = json!({"account":null,"requiresOpenaiAuth":false});
    assert!(
        verify_daemon_account(
            &exact,
            "fixture@example.invalid",
            "workspace",
            Some("workspace")
        )
        .is_ok()
    );
    assert!(
        verify_daemon_account(
            &exact,
            "fixture@example.invalid",
            "workspace",
            Some("other")
        )
        .is_err()
    );
    assert!(
        verify_daemon_account(
            &json!({"account":null,"requiresOpenaiAuth":true}),
            "fixture@example.invalid",
            "workspace",
            Some("workspace")
        )
        .is_err()
    );
    let named = json!({"account":{"type":"chatgpt","email":"fixture@example.invalid"},"workspaceRouting":{"chatgptAccountId":"workspace"}});
    assert!(verify_daemon_account(&named, "fixture@example.invalid", "workspace", None).is_ok());
    assert!(verify_daemon_account(&named, "other@example.invalid", "workspace", None).is_err());
}

#[test]
fn external_leaf_never_carries_refresh_material() {
    let access = token(2000, "user", "workspace");
    let raw = json!({"auth_mode":"chatgptAuthTokens","OPENAI_API_KEY":null,"tokens":{"access_token":access,"id_token":access,"refresh_token":"","account_id":"workspace"},"last_refresh":"2026-10-18T12:00:00Z"});
    let parsed = parse_native_document(&raw).unwrap();
    assert_eq!(parsed.external_user_id.as_deref(), Some("user"));
    assert!(parsed.refresh_token.expose().is_empty());
    let mut wrong = raw.clone();
    wrong["tokens"]["refresh_token"] = json!("a-rotating-token");
    assert!(parse_native_document(&wrong).is_err());
    wrong = raw;
    wrong["tokens"]["account_id"] = json!("other");
    assert!(parse_native_document(&wrong).is_err());
}

#[test]
fn supervisor_allowlist_cannot_reach_mutation_or_renewal() {
    for method in [
        "initialize",
        "thread/list",
        "thread/loaded/list",
        "thread/read",
        "thread/turns/list",
        "account/rateLimits/read",
    ] {
        assert_eq!(SupervisorMethod::parse(method).unwrap().as_str(), method);
    }
    for method in [
        "turn/start",
        "turn/steer",
        "account/read",
        "exec",
        "file/read",
        "thread/resume",
    ] {
        assert_eq!(SupervisorMethod::parse(method).unwrap_err().status, 403);
    }
    assert_eq!(
        RenewalStep::IdentityRead.wire(),
        ("account/read", json!({"refreshToken":false}))
    );
    assert_eq!(
        RenewalStep::RefreshRead.wire(),
        ("account/read", json!({"refreshToken":true}))
    );
}

#[test]
fn inventory_fences_unknown_threads_and_live_state_is_authoritative() {
    let scope = InventoryScope {
        generation: "g1".into(),
        source: SourceId::parse("local").unwrap(),
        available: true,
        thread_ids: BTreeSet::from(["known".into()]),
    };
    assert_eq!(scope.select("unknown").unwrap_err().status, 409);
    assert!(scope.select("../known").is_err());
    assert_eq!(scope.select("known").unwrap().inventory_generation(), "g1");
    assert_eq!(
        classify_state(Some("active"), Some("completed"), false),
        SupervisorState::Active
    );
    assert_eq!(classify_state(None, None, true), SupervisorState::Unknown);
    assert_eq!(
        classify_state(Some("notLoaded"), Some("running"), false),
        SupervisorState::Stale
    );
}

#[test]
fn follow_keeps_visible_items_and_source_utf16_revisions() {
    let entries = extract_follow(
        "turn",
        &json!([{"type":"reasoning","text":"private"},{"type":"userMessage","text":"private"},{"type":"agentMessage","id":"a","text":"visible😀","phase":"final"},{"type":"commandExecution","id":"c","command":"cargo check","aggregatedOutput":"building","status":"inProgress"}]),
    );
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].key, "turn:a");
    assert!(entries[0].revision.starts_with("9:"));
    assert!(entries.iter().all(|entry| !entry.text.contains("private")));
    assert!(
        resolve_rollout_path("/fixed", "known", "/fixed/sessions/rollout-known.jsonl").is_some()
    );
    assert!(resolve_rollout_path("/fixed", "known", "/fixed/sessions/../auth.json").is_none());
    assert!(
        resolve_rollout_path("/fixed", "known", "/other/sessions/rollout-known.jsonl").is_none()
    );
}

#[test]
fn closed_secrets_cross_records_but_unclosed_values_do_not() {
    let parts = vec![
        "password: \"first-secret".into(),
        "second-secret\" done".into(),
    ];
    let masked = gateway_native::redaction::redact_parts(&parts);
    assert!(masked.iter().all(|part| !part.text.contains("secret")));
    assert!(masked[1].text.ends_with(" done"));
    let parts = vec!["password: \"private".into(), "Working on refresh".into()];
    let masked = gateway_native::redaction::redact_parts(&parts);
    assert_eq!(masked[1].text, "Working on refresh");
}

#[test]
fn capped_follow_entries_remain_eligible_until_their_revision_is_emitted() {
    let items: Vec<_> = (0..121).map(|index| json!({"type":"agentMessage","id":index.to_string(),"text":format!("visible {index}")})).collect();
    let items = serde_json::Value::Array(items);
    let mut revisions = std::collections::BTreeMap::new();
    let first = select_follow_updates(extract_follow("turn", &items), -1, &mut revisions);
    assert_eq!(first.len(), 120);
    assert!(!revisions.contains_key("turn:0"));
    let next = select_follow_updates(extract_follow("turn", &items), 120, &mut revisions);
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].key, "turn:0");
    let blank = json!([{"type":"agentMessage","id":"0","text":""}]);
    let previous = revisions["turn:0"].clone();
    assert!(select_follow_updates(extract_follow("turn", &blank), 120, &mut revisions).is_empty());
    assert_eq!(revisions["turn:0"], previous);
}

#[cfg(unix)]
struct FollowFixture {
    replies: std::collections::VecDeque<Result<serde_json::Value, gateway_auth::GatewayError>>,
    closed: bool,
}
#[cfg(unix)]
impl SupervisorTransport for FollowFixture {
    async fn call(
        &mut self,
        method: SupervisorMethod,
        _: serde_json::Value,
    ) -> Result<serde_json::Value, gateway_auth::GatewayError> {
        assert_eq!(method, SupervisorMethod::ThreadTurnsList);
        self.replies.pop_front().unwrap()
    }
    async fn close(&mut self) -> Result<(), gateway_auth::GatewayError> {
        self.closed = true;
        Ok(())
    }
}
#[cfg(unix)]
fn follow_thread() -> KnownThread {
    InventoryScope {
        generation: "fixture-generation".into(),
        source: SourceId::parse("fixture").unwrap(),
        available: true,
        thread_ids: BTreeSet::from(["thread".into()]),
    }
    .select("thread")
    .unwrap()
}

#[cfg(unix)]
#[test]
fn follow_masks_full_fields_before_clipping_and_retains_the_raw_source_revision() {
    let text = format!("{}password=\"fixture-hidden-value\"", "x".repeat(3990));
    let items = json!([{"type":"commandExecution","id":"command","command":"password=\"fixture-cross-left","aggregatedOutput":"fixture-cross-right\" done"},{"type":"agentMessage","id":"message","text":text}]);
    let raw_revisions: std::collections::BTreeMap<_, _> = extract_follow("turn", &items)
        .into_iter()
        .map(|entry| (entry.key, entry.revision))
        .collect();
    let mut transport = FollowFixture {
        replies: std::collections::VecDeque::from([Ok(
            json!({"data":[{"id":"turn","status":"inProgress","items":items}]}),
        )]),
        closed: false,
    };
    let update = futures_executor::block_on(follow_update(
        &mut transport,
        &follow_thread(),
        "",
        &mut std::collections::BTreeMap::new(),
    ))
    .unwrap();
    assert!(transport.closed);
    assert_eq!(update.entries.len(), 2);
    for entry in &update.entries {
        assert_eq!(entry.revision, raw_revisions[&entry.key]);
        assert!(!entry.text.contains("fixture-hidden"));
        assert!(!entry.text.contains("fixture-cross"));
        assert!(
            entry
                .command
                .as_ref()
                .is_none_or(|command| !command.contains("fixture-cross"))
        );
    }
}

#[cfg(unix)]
#[test]
fn failed_full_follow_read_keeps_the_cursor_of_the_last_recorded_summary_item() {
    let summary = json!({"data":[{"id":"turn","items":[{"type":"agentMessage","id":"visible","text":"visible"},{"type":"agentMessage","id":"blank","text":""}]}]});
    let mut transport = FollowFixture {
        replies: std::collections::VecDeque::from([
            Ok(summary),
            Err(gateway_auth::GatewayError::unavailable(
                "Fixture full view unavailable",
                "fixture_unavailable",
            )),
        ]),
        closed: false,
    };
    let mut revisions = std::collections::BTreeMap::new();
    let update = futures_executor::block_on(follow_update(
        &mut transport,
        &follow_thread(),
        "",
        &mut revisions,
    ))
    .unwrap();
    assert!(transport.closed);
    assert_eq!(update.cursor, "turn:1");
    assert_eq!(update.entries.len(), 1);
    assert!(!revisions.contains_key("turn:blank"));
}
