use gateway_authority::keys;
use gateway_authority::quota::{KernelPolicy, KernelWindow};
use gateway_core::{
    js_string::JsString16,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
};
use serde::Deserialize;
pub mod support;

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
    source_policy: SourceJson,
    source_window: SourceJson,
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

#[test]
fn named_normalizers_preserve_all_actual_source_documents_and_record_custody() {
    for case in fixture().cases {
        let policy = KernelPolicy::<JsString16, f64>::normalize_source_document(
            &case.source_policy,
            &case.owner,
            case.repo.as_ref(),
        )
        .unwrap();
        let window = KernelWindow::<JsString16>::normalize_source_document(
            &case.source_window,
            &case.owner,
            case.repo.as_ref(),
        )
        .unwrap();
        assert_eq!(
            source::canonical(&policy).unwrap(),
            source::canonical(&case.source_policy).unwrap()
        );
        assert_eq!(
            source::canonical(&window).unwrap(),
            source::canonical(&case.source_window).unwrap()
        );
        for document in [policy, window] {
            let record =
                encode_source_control_record("original-revision", &document, Some(1900000000000))
                    .unwrap();
            let before = record.clone();
            assert_eq!(
                source::canonical(&decode_source_control_record(&record).unwrap()).unwrap(),
                document
            );
            assert_eq!(record, before);
        }
    }
}

fn source_window(reserved: i64, index: &str) -> SourceJson {
    SourceJson::parse(&format!(r#"{{"v":2,"scope":"repo","owner":"owner","repo":"repo","usage_requests":0,"reserved_requests":{reserved},"created_at_ms":1000,"usage_reset_at_ms":2000,"applied_window_ms":1000,"updated_at_ms":1000{index}}}"#)).unwrap()
}

#[test]
fn zero_mapless_window_is_data_but_positive_mapless_window_never_binds_live_index() {
    let zero: KernelWindow<JsString16> = source_window(0, "").deserialize().unwrap();
    assert!(zero.reservations.is_empty());
    let positive = source_window(1, "");
    assert!(positive.deserialize::<KernelWindow<JsString16>>().is_err());
    let public = KernelWindow::<JsString16>::normalize_source_document(
        &positive,
        &"owner".into(),
        Some(&"repo".into()),
    )
    .unwrap();
    assert_eq!(
        source::member(&public, "reserved_requests")
            .unwrap()
            .as_str(),
        "1"
    );
    let indexed = source_window(1, r#", "reservations":{"original-request":1500}"#);
    let bound: KernelWindow<JsString16> = indexed.deserialize().unwrap();
    assert_eq!(bound.reservations["original-request"], 1500);
    let public = KernelWindow::<JsString16>::normalize_source_document(
        &indexed,
        &"owner".into(),
        Some(&"repo".into()),
    )
    .unwrap();
    assert!(source::member(&public, "reservations").is_none());
    assert!(
        source_window(0, r#", "reservations":null"#)
            .deserialize::<KernelWindow<JsString16>>()
            .is_err()
    );
}

#[test]
fn source_expiry_number_is_not_clamped_or_narrowed_to_scalar_integer() {
    #[derive(Deserialize)]
    struct ExpiryFixture {
        policies: Vec<ExpiryCase>,
    }
    #[derive(Deserialize)]
    struct ExpiryCase {
        input: String,
        normalized: SourceJson,
    }
    let actual: ExpiryFixture =
        SourceJson::parse(include_str!("fixtures/kernel-source-expiry.json"))
            .unwrap()
            .deserialize()
            .unwrap();
    for case in actual.policies {
        let raw = if case.input == "bad" {
            "\"bad\""
        } else {
            &case.input
        };
        let document = SourceJson::parse(&format!(r#"{{"v":2,"scope":"org","owner":"owner","usage_limit_requests":7,"window_ms":60000,"expires_at_ms":{raw},"created_at_ms":1000,"updated_at_ms":1000}}"#)).unwrap();
        let normalized = KernelPolicy::<JsString16, f64>::normalize_source_document(
            &document,
            &"owner".into(),
            None,
        )
        .unwrap();
        let policy: KernelPolicy<JsString16, f64> = normalized.deserialize().unwrap();
        assert_eq!(
            source::canonical(&normalized).unwrap(),
            source::canonical(&case.normalized).unwrap()
        );
        assert_eq!(
            source::number(&source::member(&normalized, "expires_at_ms").unwrap()),
            Some(policy.expires_at_ms)
        );
        assert!(source::member(&normalized, "repo").is_none());
    }
}

#[test]
fn live_named_policy_number_and_zero_index_decode_preserve_original_retention() {
    use gateway_core::identity::RequestId;
    use support::{MemoryStore, NOW, authority, run};
    for (expiry, admitted) in [("1e100", true), ("-1", true), ("0", false), ("900", false)] {
        let store = MemoryStore::default();
        let policy = SourceJson::parse(&format!(r#"{{"v":2,"scope":"repo","owner":"owner","repo":"repo","usage_limit_requests":7,"window_ms":60000,"expires_at_ms":{expiry},"created_at_ms":1000,"updated_at_ms":1000}}"#)).unwrap();
        store.seed_record(
            keys::kernel_policy("owner", Some("repo")),
            encode_source_control_record("source-policy", &policy, None).unwrap(),
        );
        let window = SourceJson::parse(&format!(r#"{{"v":2,"scope":"repo","owner":"owner","repo":"repo","usage_requests":0,"reserved_requests":0,"created_at_ms":{NOW},"usage_reset_at_ms":{},"applied_window_ms":60000,"updated_at_ms":{NOW}}}"#, NOW+60000)).unwrap();
        store.seed_record(
            keys::kernel_window("owner", Some("repo")),
            encode_source_control_record("source-window", &window, None).unwrap(),
        );
        let result = run(authority(&store).reserve_kernel(
            "owner",
            "repo",
            &RequestId("source-expiry".into()),
            "responses",
            NOW,
        ));
        assert_eq!(result.is_ok(), admitted, "expiry{expiry}");
        let after = store
            .row(&keys::kernel_window("owner", Some("repo")))
            .unwrap();
        if admitted {
            assert_eq!(
                after.expires_at_ms,
                Some(NOW + 60000 + gateway_authority::QUOTA_RETENTION_MS)
            );
            let window: KernelWindow = serde_json::from_value(after.value).unwrap();
            assert_eq!(window.reserved_requests, 1);
            assert!(window.reservations.contains_key("source-expiry"));
        } else {
            assert_eq!(after.revision, "source-window");
            assert_eq!(after.expires_at_ms, None);
        }
    }
}
