use auth::{AuthConfig, AuthHost, AuthService, session_index::*};
use gateway_auth as auth;
use serde_json::json;
#[path = "session_index_cases/support.rs"]
mod support;
use support::*;

#[test]
fn digest_and_fixed_key_do_not_contain_bearers_or_alias_noncanonical_digests() {
    let token = "uos_ai_session_SYNTHETIC_INDEX_TOKEN";
    let value = digest(token);
    assert_eq!(value.len(), 64);
    assert_eq!(
        value,
        "802402ebdf1f920d74e324319356b4bc68ce160f64f4a694cf924e360330c173"
    );
    assert_ne!(value, auth::crypto::sha256_hex(token.as_bytes()));
    assert_ne!(value, digest(&format!(" {token}")));
    assert_ne!(value, digest(&format!("{token} ")));
    let key = index_key(&value).unwrap();
    assert!(!key.0.contains(token));
    for invalid in ["", "abcd", &value.to_uppercase(), &format!(" {value}")] {
        assert!(index_key(invalid).is_err());
    }
}

#[test]
fn controlled_constructor_preserves_source_revision_and_minimum_absolute_expiry_without_token_data()
{
    run(async {
        let store = Store::default();
        let value = session("uos_ai_session_SYNTHETIC_INDEX_TOKEN", 500);
        let row = record_for_session(&value, "source-rev", Some(300)).unwrap();
        assert_eq!(row.expires_at_ms, Some(300));
        assert_eq!(row.revision, "source-rev");
        let encoded = serde_json::to_string(&row).unwrap();
        assert!(!encoded.contains(&value.token));
        assert!(!encoded.contains(&auth::passkeys::key("sessions", &value.token).0));
        let key = index_key(&digest(&value.token)).unwrap();
        store.rows.borrow_mut().insert(key.0, row);
        let snapshot = read_current(&store, &digest(&value.token), 299)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.fence.expires_at_ms, 300);
        assert_eq!(snapshot.fence.session_revision, "source-rev");
        assert!(
            read_current(&store, &digest(&value.token), 300)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            record_for_session(&value, "source-rev", Some(900))
                .unwrap()
                .expires_at_ms,
            Some(500)
        );
        assert_eq!(
            record_for_session(&value, "source-rev", None)
                .unwrap()
                .expires_at_ms,
            Some(500)
        );
    });
}

#[test]
fn missing_legacy_index_never_becomes_implicit_native_session_proof() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let config = AuthConfig::default();
        user(&store, true, "policy");
        let value = session("uos_ai_session_legacy_fixture", host.now_ms() + 1000);
        install(&store, &value, "legacy-source", None, false);
        let auth = AuthService::new(&store, &host, &config);
        assert!(
            auth.authenticate_admin(&request(&value.token))
                .await
                .unwrap()
                .is_admin
        );
        assert!(
            read_current(&store, &digest(&value.token), host.now_ms())
                .await
                .unwrap()
                .is_none()
        );
        assert!(store.history.borrow().is_empty());
    });
}

#[test]
fn malformed_version_identity_revision_ttl_and_secret_fields_refuse_current_reads() {
    run(async {
        let store = Store::default();
        let value = session("uos_ai_session_malformed_fixture", 1000);
        let id = digest(&value.token);
        let key = index_key(&id).unwrap();
        let base = record_for_session(&value, "source-rev", None).unwrap();
        let mut bad = Vec::new();
        for (field, replacement) in [
            ("v", json!(2)),
            ("session_digest", json!(digest("other"))),
            ("user_id", json!("")),
            ("session_revision", json!("different")),
            ("token", json!("must-not-be-accepted")),
        ] {
            let mut row = base.clone();
            row.value[field] = replacement;
            bad.push(row);
        }
        let mut row = base.clone();
        row.expires_at_ms = None;
        bad.push(row);
        let mut row = base.clone();
        row.expires_at_ms = Some(999);
        bad.push(row);
        let mut row = base.clone();
        row.revision = "replacement".into();
        bad.push(row);
        let mut row = base;
        row.schema_version = 99;
        bad.push(row);
        for row in bad {
            store.rows.borrow_mut().insert(key.0.clone(), row);
            assert!(read_current(&store, &id, 1).await.is_err());
        }
        assert!(serde_json::from_value::<SessionRevisionFence>(json!({"v":1,"session_digest":id,"user_id":"u","session_revision":"r","expires_at_ms":100,"source_session_key":"forbidden"})).is_err());
    });
}
