use std::collections::BTreeMap;

use gateway_auth::AuthConfig;

#[test]
fn source_bootstrap_keeps_token_roles_and_nullish_hosting_precedence() {
    let values = BTreeMap::from([
        (
            "UOS_AI_TOKEN".into(),
            " client-a ,client-b\nclient-a\n ".into(),
        ),
        ("DENO_DEPLOY_TOKEN".into(), " admin-a\nadmin-b ".into()),
        ("DENO_TIMELINE".into(), "production".into()),
        ("DENO_DEPLOY".into(), String::new()),
        ("DENO_DEPLOYMENT_ID".into(), " deployment-id ".into()),
        ("DENO_DEPLOY_APP_SLUG".into(), " app ".into()),
        ("DENO_DEPLOY_ORG_SLUG".into(), " org ".into()),
    ]);
    let config = AuthConfig::from_source_values(&values, true);
    assert_eq!(
        config
            .auth_tokens
            .iter()
            .map(|value| value.expose())
            .collect::<Vec<_>>(),
        ["client-a", "client-b"]
    );
    assert_eq!(
        config
            .admin_tokens
            .iter()
            .map(|value| value.expose())
            .collect::<Vec<_>>(),
        ["admin-a", "admin-b"]
    );
    assert!(config.production);
    assert!(!config.hosted);
    assert!(config.git_sha_known);
    assert!(!config.candidate_passkeys);
    assert!(config.extra_relay_origins.is_empty());
    assert_eq!(config.deno_app_slug.as_deref(), Some("app"));
    assert_eq!(config.deno_org_slug.as_deref(), Some("org"));
    assert_eq!(config.deno_deployment_id.as_deref(), Some("deployment-id"));
    let mut next = values;
    next.remove("DENO_DEPLOY");
    assert!(AuthConfig::from_source_values(&next, true).hosted);
}

#[test]
fn source_bootstrap_extracts_public_key_blocks_and_preserves_source_escape_rules() {
    let first = "-----BEGIN PUBLIC KEY-----\nfirst\n-----END PUBLIC KEY-----";
    let second = "-----BEGIN PUBLIC KEY-----\nsecond\n-----END PUBLIC KEY-----";
    let values = BTreeMap::from([(
        "UOS_AI_KERNEL_PUBLIC_KEY".into(),
        format!("prefix{first}\n{second}suffix"),
    )]);
    let config = AuthConfig::from_source_values(&values, false);
    assert_eq!(config.kernel_public_keys_pem, [first, second]);
    for (input, expected) in [
        ("unframed\\nvalue", "unframed\nvalue"),
        ("unframed\\\\nvalue", "unframed\\\nvalue"),
    ] {
        let escaped = BTreeMap::from([("UOS_AI_KERNEL_PUBLIC_KEY".into(), input.into())]);
        assert_eq!(
            AuthConfig::from_source_values(&escaped, false).kernel_public_keys_pem,
            [expected]
        );
    }
}
