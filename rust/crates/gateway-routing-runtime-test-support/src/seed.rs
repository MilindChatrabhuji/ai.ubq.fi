use crate::{input::NOW, store::Store};
use gateway_auth::crypto::Secret;
use gateway_authority::{
    keys,
    routing::{PoolAccount, SubscriptionPool},
};
use gateway_core::{
    identity::{ApiKeyId, PoolVersionstamp},
    state::{RecordKey, StoredRecord},
};
use serde_json::Value;
use std::collections::BTreeMap;
pub fn seed_key(store: &Store) {
    store.seed(
        keys::api_policy("key-a"),
        gateway_authority::quota::ApiKeyPolicy {
            v: 3,
            key_id: ApiKeyId("key-a".into()),
            expires_at_ms: -1,
            usage_limit_requests: 10,
            window_ms: gateway_authority::DAY_MS,
            usage_reset_at_ms: NOW + gateway_authority::DAY_MS,
            paid_fallback_enabled: true,
            paid_fallback_limit_microcredits: 10000,
            paid_fallback_quota_per_credit: 1000000,
            paid_fallback_pricing_checked_at_ms: NOW,
            paid_fallback_models: vec![
                "gpt-test".into(),
                "paid-model".into(),
                "deepseek-v4.1-flash".into(),
            ],
            paid_fallback_max_exposure_microcredits: BTreeMap::from([
                ("gpt-test".into(), 1000),
                ("paid-model".into(), 1000),
                ("deepseek-v4.1-flash".into(), 1000),
            ]),
        },
    );
}
pub fn source_account(id: &str) -> gateway_auth::provider_credentials::CodexSourceAccount {
    gateway_auth::provider_credentials::CodexSourceAccount {
        access_token: Secret::new(format!("fixture-access-{id}")),
        refresh_token: Secret::new(format!("fixture-refresh-{id}")),
        account_id: id.into(),
        updated_at_ms: NOW as f64,
        native_owner: None,
    }
}
pub fn seed_pool(store: &Store) {
    let accounts = ["a", "b"].map(source_account).to_vec();
    let source = gateway_auth::provider_credentials::CodexSourcePool {
        accounts: accounts.clone(),
        updated_at_ms: NOW as f64,
    };
    let revision = "pool-original";
    store.rows.lock().unwrap().insert(
        source_key().0,
        StoredRecord::json(revision, source.private_source_value(), None),
    );
    store.seed(
        keys::pool(),
        SubscriptionPool {
            v: 1,
            pool_versionstamp: PoolVersionstamp(revision.into()),
            accounts: accounts
                .iter()
                .map(|account| {
                    let identity = account.identity();
                    PoolAccount {
                        account_id_hash: identity.routing_account_hash,
                        admin_account_hash: identity.administrative_account_hash,
                        credential_version: identity.credential_version,
                        enabled: true,
                    }
                })
                .collect(),
        },
    );
}
pub fn source_key() -> RecordKey {
    gateway_auth::provider_credentials::codex_source_pool_key()
}
pub fn window(store: &Store) -> Value {
    store.value(keys::api_window(
        "key-a",
        &format!("v3:{}", gateway_authority::DAY_MS),
        NOW,
    ))
}
