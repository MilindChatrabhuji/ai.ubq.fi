#![cfg(all(unix, not(target_arch = "wasm32")))]
mod support {
    pub mod fixture;
}
use gateway_auth::{
    crypto::base64url,
    native_credentials::{NativeOwnerId, OwnerFence, parse_native_document},
};
use gateway_migration::{
    NativeCustody,
    native_operator::{ConfiguredNativeCustody, NativeCustodyRegistration},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use support::fixture::{Directory, run};

fn document(account: &str, serial: u32) -> Value {
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let token = format!(
        "e30.{}.synthetic",
        base64url(json!({"exp":expiry}).to_string().as_bytes())
    );
    json!({"auth_mode":"chatgpt","tokens":{"account_id":account,"access_token":token,"id_token":token,"refresh_token":format!("synthetic-native-{account}-{serial}-refresh")},"last_refresh":"2026-10-19T00:00:00.000000000Z"})
}
fn registration(home: PathBuf, account: &str, document: &Value) -> NativeCustodyRegistration {
    NativeCustodyRegistration::existing(
        home,
        OwnerFence {
            owner: NativeOwnerId(format!("operator-{account}")),
            account_id: account.into(),
            generation_hash: parse_native_document(document).unwrap().generation_hash(),
            authority_revision: "source-pool-current".into(),
        },
    )
    .unwrap()
}

#[test]
fn configured_custody_reads_only_bound_current_files_and_preserves_both_owners() {
    let directory = Directory::new();
    let mut registrations = Vec::new();
    let mut originals = Vec::new();
    for account in ["managed-a", "managed-b"] {
        let home = directory.file(account);
        std::fs::create_dir(&home).unwrap();
        let doc = document(account, 1);
        let bytes = serde_json::to_vec(&doc).unwrap();
        std::fs::write(home.join("auth.json"), &bytes).unwrap();
        registrations.push(registration(home.clone(), account, &doc));
        originals.push((home, bytes));
    }
    let custody = ConfiguredNativeCustody::new(registrations).unwrap();
    assert!(run(custody.observe("managed-a")).is_ok());
    assert!(run(custody.observe("managed-b")).is_ok());
    assert!(run(custody.observe("unregistered")).is_err());
    for (home, bytes) in &originals {
        assert_eq!(std::fs::read(home.join("auth.json")).unwrap(), *bytes);
    }
    std::fs::write(
        originals[0].0.join("auth.json"),
        serde_json::to_vec(&document("managed-a", 2)).unwrap(),
    )
    .unwrap();
    assert!(run(custody.observe("managed-a")).is_err());
    assert!(run(custody.observe("managed-b")).is_ok());
    assert_eq!(
        std::fs::read(originals[1].0.join("auth.json")).unwrap(),
        originals[1].1
    );
}

#[test]
fn configured_custody_refuses_missing_and_ambiguous_registrations() {
    assert!(ConfiguredNativeCustody::new(vec![]).is_err());
    let directory = Directory::new();
    let home = directory.file("duplicate");
    std::fs::create_dir(&home).unwrap();
    let doc = document("managed-a", 1);
    assert!(
        ConfiguredNativeCustody::new(vec![
            registration(home.clone(), "managed-a", &doc),
            registration(home, "managed-a", &doc)
        ])
        .is_err()
    );
}

#[test]
fn configured_custody_refuses_duplicate_owner_home_and_more_than_two_accounts() {
    let directory = Directory::new();
    let a = directory.file("a");
    let b = directory.file("b");
    let c = directory.file("c");
    let doc_a = document("managed-a", 1);
    let doc_b = document("managed-b", 1);
    let doc_c = document("managed-c", 1);
    assert!(
        ConfiguredNativeCustody::new(vec![
            registration(a.clone(), "managed-a", &doc_a),
            registration(a.clone(), "managed-b", &doc_b)
        ])
        .is_err()
    );
    let first = registration(a.clone(), "managed-a", &doc_a);
    let mut second = OwnerFence {
        owner: NativeOwnerId("operator-managed-a".into()),
        account_id: "managed-b".into(),
        generation_hash: parse_native_document(&doc_b).unwrap().generation_hash(),
        authority_revision: "source-pool-current".into(),
    };
    assert!(
        ConfiguredNativeCustody::new(vec![
            first,
            NativeCustodyRegistration::existing(b.clone(), second.clone()).unwrap()
        ])
        .is_err()
    );
    second.owner = NativeOwnerId("operator-managed-b".into());
    assert!(
        ConfiguredNativeCustody::new(vec![
            registration(a, "managed-a", &doc_a),
            NativeCustodyRegistration::existing(b, second).unwrap(),
            registration(c, "managed-c", &doc_c)
        ])
        .is_err()
    );
}

#[test]
fn configured_custody_rejects_wrong_account_expired_and_missing_files_without_writes() {
    let directory = Directory::new();
    let home = directory.file("managed-a");
    std::fs::create_dir(&home).unwrap();
    let doc = document("managed-a", 1);
    let custody =
        ConfiguredNativeCustody::new(vec![registration(home.clone(), "managed-a", &doc)]).unwrap();
    assert!(run(custody.observe("managed-a")).is_err());
    let wrong = serde_json::to_vec(&document("managed-b", 1)).unwrap();
    std::fs::write(home.join("auth.json"), &wrong).unwrap();
    assert!(run(custody.observe("managed-a")).is_err());
    assert_eq!(std::fs::read(home.join("auth.json")).unwrap(), wrong);
    let mut expired = doc;
    let token = format!("e30.{}.synthetic", base64url(br#"{"exp":1}"#));
    expired["tokens"]["access_token"] = json!(token);
    let bytes = serde_json::to_vec(&expired).unwrap();
    std::fs::write(home.join("auth.json"), &bytes).unwrap();
    let custody =
        ConfiguredNativeCustody::new(vec![registration(home.clone(), "managed-a", &expired)])
            .unwrap();
    assert!(run(custody.observe("managed-a")).is_err());
    assert_eq!(std::fs::read(home.join("auth.json")).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(home).unwrap().count(), 1);
}

#[test]
fn registrations_require_fixed_absolute_unambiguous_paths_and_account_fences() {
    let doc = document("managed-a", 1);
    for path in ["relative", "/tmp/../another-owner"] {
        let fence = OwnerFence {
            owner: NativeOwnerId("operator-managed-a".into()),
            account_id: "managed-a".into(),
            generation_hash: parse_native_document(&doc).unwrap().generation_hash(),
            authority_revision: "source-pool-current".into(),
        };
        assert!(NativeCustodyRegistration::existing(PathBuf::from(path), fence).is_err());
    }
}
