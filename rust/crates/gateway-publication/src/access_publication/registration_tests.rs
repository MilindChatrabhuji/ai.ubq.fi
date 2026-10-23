use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
struct Cases {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    owner: String,
    home: String,
    accepted: bool,
}
fn cases() -> Vec<Case> {
    serde_json::from_str::<Cases>(include_str!(
        "../../tests/fixtures/access-owner-home-v1.json"
    ))
    .unwrap()
    .cases
}

#[test]
fn registered_access_owner_matches_declared_posix_and_unchanged_owner_guard() {
    for case in cases() {
        let actual =
            RegisteredAccessOwner::configured(NativeOwnerId(case.owner.clone()), case.home.clone());
        assert_eq!(
            actual.is_ok(),
            case.accepted,
            "owner={:?} home={:?}",
            case.owner,
            case.home
        );
        match actual {
            Ok(owner) => {
                assert_eq!(owner.native_owner_id().0, case.owner);
                assert_eq!(owner.home, case.home);
            }
            Err(error) => {
                assert_eq!(error.status, 503);
                assert_eq!(
                    error.envelope.error.code.as_deref(),
                    Some("native_access_owner_unavailable")
                );
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn registered_access_owner_preserves_existing_native_unix_guard_results() {
    for case in cases() {
        let old_native_result =
            !case.owner.trim().is_empty() && std::path::Path::new(&case.home).is_absolute();
        let actual =
            RegisteredAccessOwner::configured(NativeOwnerId(case.owner), case.home).is_ok();
        assert_eq!(actual, old_native_result);
    }
}

#[test]
fn registered_access_owner_keeps_exact_non_normalized_home_identity() {
    let raw = "/fixture/../owner// ";
    let registered =
        RegisteredAccessOwner::configured(NativeOwnerId(" owner ".into()), raw.into()).unwrap();
    assert_eq!(registered.home, raw);
    assert_ne!(registered.home, "/owner");
    assert_ne!(registered.home, registered.home.trim());
    assert_eq!(registered.id.0, " owner ");
}
