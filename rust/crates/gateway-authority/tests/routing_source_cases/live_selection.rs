use crate::support::*;
use gateway_authority::routing::LiveRouteSelection;
use gateway_core::js_string::JsString16;

#[test]
fn optional_and_unpaired_source_models_remain_selection_only() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    for model in [
        None,
        Some(JsString16::from_units(vec![])),
        Some(JsString16::from_units(vec![0xd800])),
    ] {
        let LiveRouteSelection::Eligible(selected) =
            run(authority.select_live_account(model.as_ref(), NOW)).unwrap()
        else {
            panic!("eligible source account")
        };
        assert_eq!(selected.model, model);
        run(authority.ensure_live_account_current(&selected, NOW)).unwrap();
    }
}
#[test]
fn live_selection_cannot_revalidate_or_invalidate_replaced_credentials() {
    let store = MemoryStore::default();
    let mut configured = pool();
    seed_pool(&store, &configured);
    let authority = authority(&store);
    let LiveRouteSelection::Eligible(selected) =
        run(authority.select_live_account(None, NOW)).unwrap()
    else {
        panic!()
    };
    let replacement = source_account("a", true).identity();
    configured.accounts[0].credential_version = replacement.credential_version;
    configured.pool_versionstamp.0 = "new-pool".into();
    seed_pool(&store, &configured);
    assert!(run(authority.ensure_live_account_current(&selected, NOW)).is_err());
    assert!(!run(authority.mark_live_credential_invalid(&selected, NOW)).unwrap());
}
