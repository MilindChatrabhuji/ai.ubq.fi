#[cfg(not(target_arch = "wasm32"))]
mod fixture;
#[cfg(not(target_arch = "wasm32"))]
mod sqlite_store;
#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use fixture::{Directory, run};
    use gateway_core::identity::{ApiKeyId, RequestId};
    use gateway_migration::*;
    use serde_json::json;
    use sqlite_store::SqliteStore;
    use std::sync::atomic::{AtomicU64, Ordering};
    if std::env::args_os().len() != 1 {
        return Err(
            "The fixture accepts no source database, credential or target path arguments".into(),
        );
    }
    struct Tokens(AtomicU64);
    impl gateway_authority::TokenSource for Tokens {
        fn next_token(&self) -> Result<String, gateway_core::GatewayError> {
            Ok(format!(
                "offline-fixture-{}",
                self.0.fetch_add(1, Ordering::SeqCst)
            ))
        }
    }
    struct Clock;
    impl gateway_authority::AuthorityClock for Clock {
        fn now_ms(&self) -> Result<i64, gateway_core::GatewayError> {
            Ok(2300)
        }
    }
    let source: PrivateCapture =
        serde_json::from_str(include_str!("../fixtures/offline-source.json"))?;
    let directory = Directory::new();
    let path = directory.file("forward.sqlite3");
    let store = SqliteStore::open(&path);
    let forward = run(adopt_empty(&store, &prepare(&source, &CanonicalDates)?))?;
    drop(store);
    let store = SqliteStore::open(&path);
    let token = format!("u_{}", "1".repeat(64));
    let authenticated = run(gateway_auth::api_keys::authenticate(&store, &token, 2300))?;
    let authority =
        gateway_authority::Authority::with_clock(store.clone(), Tokens(AtomicU64::new(1)), Clock);
    let reservation = run(authority.reserve_api_key(
        &ApiKeyId("offline-key".into()),
        &RequestId("post-restart-write".into()),
        "responses",
        2300,
    ))?;
    let latest = run(export_latest(&store, 2300))?;
    let inverse_store = SqliteStore::open(&directory.file("inverse-new.sqlite3"));
    let inverse = run(adopt_empty(
        &inverse_store,
        &prepare(&latest, &CanonicalDates)?,
    ))?;
    let reexported = run(export_latest(&inverse_store, 2300))?;
    if serde_json::to_value(&latest)? != serde_json::to_value(&reexported)? {
        return Err("Latest-state inverse differs".into());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"fixture_only":true,"source_database_opened":false,"provider_inference":false,"single_authority":true,"authenticated_key_id":authenticated.key_id,"post_restart_request_id":reservation.request_id.0,"forward":forward,"latest_source_capture":latest,"inverse":inverse,"latest_logical_roundtrip_equal":true})
        )?
    );
    Ok(())
}
#[cfg(target_arch = "wasm32")]
fn main() {}
