use gateway_authority::keys;
use gateway_core::{js_string::JsString16, source_json::SourceJson};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    owner: JsString16,
    repo: Option<JsString16>,
    policy_hex: String,
    window_hex: String,
}

fn fixture() -> Fixture {
    SourceJson::parse(include_str!("fixtures/kernel-source-data.json"))
        .unwrap()
        .deserialize()
        .unwrap()
}

#[test]
fn policy_window_source_keys_match_all_twelve_actual_bun_families() {
    let fixture = fixture();
    assert_eq!(fixture.cases.len(), 12);
    for case in fixture.cases {
        let policy = keys::kernel_policy_source(&case.owner, case.repo.as_ref()).unwrap();
        let window = keys::kernel_window_source(&case.owner, case.repo.as_ref()).unwrap();
        assert_eq!(
            policy.0,
            format!("tuple-v1:{}", case.policy_hex),
            "{}",
            case.id
        );
        assert_eq!(
            window.0,
            format!("tuple-v1:{}", case.window_hex),
            "{}",
            case.id
        );
        if let Ok(owner) = case.owner.try_utf8() {
            let repo = case.repo.as_ref().map(JsString16::try_utf8).transpose();
            if let Ok(repo) = repo {
                assert_eq!(policy, keys::kernel_policy(&owner, repo.as_deref()));
                assert_eq!(window, keys::kernel_window(&owner, repo.as_deref()));
            }
        }
    }
}

#[test]
fn source_key_collisions_do_not_make_logical_labels_equal() {
    let labels: Vec<_> = [0xd800, 0xdc00, 0xfffd]
        .into_iter()
        .map(|unit| JsString16::from_units(vec![111, 114, 103, unit]))
        .collect();
    assert_ne!(labels[0], labels[1]);
    assert_ne!(labels[0], labels[2]);
    for repo in [None, Some(JsString16::from_utf8("repo"))] {
        let policies: Vec<_> = labels
            .iter()
            .map(|owner| keys::kernel_policy_source(owner, repo.as_ref()).unwrap())
            .collect();
        let windows: Vec<_> = labels
            .iter()
            .map(|owner| keys::kernel_window_source(owner, repo.as_ref()).unwrap())
            .collect();
        assert!(policies.windows(2).all(|pair| pair[0] == pair[1]));
        assert!(windows.windows(2).all(|pair| pair[0] == pair[1]));
    }
}

#[test]
fn source_key_overloads_do_not_apply_admin_or_queue_selector_filters() {
    let owner = "  owner/with space  ";
    let repo = "x".repeat(101);
    assert_eq!(
        keys::kernel_policy_source(&owner.into(), Some(&JsString16::from_utf8(&repo))).unwrap(),
        keys::kernel_policy(owner, Some(&repo))
    );
    assert_eq!(
        keys::kernel_window_source(&owner.into(), Some(&JsString16::from_utf8(&repo))).unwrap(),
        keys::kernel_window(owner, Some(&repo))
    );
}
