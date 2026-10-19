mod live_selection;
use super::support::*;
use gateway_authority::routing::*;
use gateway_core::identity::{
    CredentialVersion, PoolVersionstamp, RoutingAccountHash, SubscriptionSelectionHash,
};
use serde_json::{Value, json};
fn packet() -> Value {
    serde_json::from_str(include_str!("../fixtures/codex-capacity-source-v1.json")).unwrap()
}
fn equivalent(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| equivalent(a, b)))
        }
        _ => actual == expected,
    }
}
fn equal(actual: Value, expected: &Value, label: &str) {
    assert!(
        equivalent(&actual, expected),
        "source case {label}: actual={actual} expected={expected}"
    )
}
#[test]
fn source_row_normalizers_preserve_legacy_fields_and_refuse_unknown_circuits() {
    for (i, case) in packet()["parseCases"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let actual = parse_routing_state(&case["raw"])
            .ok()
            .map(|v| serde_json::to_value(v).unwrap())
            .unwrap_or(Value::Null);
        equal(actual, &case["expected"], &format!("parse-{i}"));
    }
    for (i, case) in packet()["windows"].as_array().unwrap().iter().enumerate() {
        equal(
            serde_json::to_value(normalize_capacity_window(&case["raw"])).unwrap(),
            &case["expected"],
            &format!("window-{i}"),
        );
    }
}
#[test]
fn source_pool_reorder_refresh_timeout_retirement_and_legacy_reset_fences_match() {
    for (i, case) in packet()["normCases"].as_array().unwrap().iter().enumerate() {
        let accounts = case["identities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| PoolAccount {
                account_id_hash: RoutingAccountHash(id["accountIdHash"].as_str().unwrap().into()),
                admin_account_hash: SubscriptionSelectionHash("irrelevant-admin-hash".into()),
                credential_version: CredentialVersion(
                    id["credentialVersion"].as_str().unwrap().into(),
                ),
                enabled: true,
            })
            .collect();
        let pool = SubscriptionPool {
            v: 1,
            pool_versionstamp: PoolVersionstamp("source-pool".into()),
            accounts,
        };
        let actual = normalize_routing_state(
            &pool,
            Some(parse_routing_state(&case["raw"]).unwrap()),
            case["now"].as_i64().unwrap(),
        )
        .unwrap();
        equal(
            serde_json::to_value(actual).unwrap(),
            &case["expected"],
            &format!("normalize-{i}"),
        );
    }
}
#[test]
fn named_limit_applicability_and_ordered_capacity_reconciliation_match_source() {
    for (i, case) in packet()["headroomCases"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let row: CapacityObservation = serde_json::from_value(case["observation"].clone()).unwrap();
        equal(
            serde_json::to_value(capacity_headroom_for_observation(
                &row,
                case["model"]
                    .as_str()
                    .map(gateway_core::model::ModelId::from_scalar)
                    .as_ref(),
            ))
            .unwrap(),
            &case["expected"],
            &format!("headroom-{i}"),
        );
    }
    for (i, case) in packet()["applies"].as_array().unwrap().iter().enumerate() {
        let state = parse_routing_state(&case["state"]).unwrap();
        let row: CapacityObservation = serde_json::from_value(case["observation"].clone()).unwrap();
        let actual = apply_capacity_observation(
            &state,
            &row,
            case["now"].as_i64().unwrap(),
            case["model"]
                .as_str()
                .map(gateway_core::model::ModelId::from_scalar)
                .as_ref(),
            case["updated_at_ms"].as_i64().unwrap(),
        )
        .unwrap();
        equal(
            serde_json::to_value(actual).unwrap(),
            &case["expected"],
            &format!("apply-{i}"),
        );
    }
}
#[test]
fn source_c_only_plan_uses_current_revision_and_preserves_exact_merge_body() {
    for case in packet()["storeCases"].as_array().unwrap() {
        let current = CapacityStore {
            v: 1,
            updated_at_ms: 0,
            observations: serde_json::from_value(case["current"].clone()).unwrap(),
        };
        let inputs: Vec<CapacityObservation> =
            serde_json::from_value(case["inputs"].clone()).unwrap();
        let plan = plan_capacity_observation_store(
            case["revision"].as_str().map(str::to_owned),
            &current,
            &inputs,
            case["now"].as_i64().unwrap(),
        );
        equal(
            json!({"kind":"capacity_observations","checks":{"capacity":plan.capacity_revision},"writes":{"capacity":plan.capacity}}),
            &case["expected"],
            "C-write-set",
        );
    }
}
#[test]
fn hot_selection_uses_check_only_identity_and_never_balances_to_sibling() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let first = admitted(&authority);
    let r = store
        .row(&gateway_authority::keys::routing())
        .unwrap()
        .revision;
    let a = store
        .row(&gateway_authority::keys::active())
        .unwrap()
        .revision;
    let RouteSelection::Eligible(second) = run(authority.select_account(
        &"gpt-test".into(),
        gateway_core::provider::CodexQuotaClass::Standard,
        NOW + 1,
    ))
    .unwrap() else {
        panic!("hot selection failed")
    };
    assert_eq!(first.binding, second.binding);
    assert_eq!(
        store
            .row(&gateway_authority::keys::routing())
            .unwrap()
            .revision,
        r
    );
    assert_eq!(
        store
            .row(&gateway_authority::keys::active())
            .unwrap()
            .revision,
        a
    );
}
