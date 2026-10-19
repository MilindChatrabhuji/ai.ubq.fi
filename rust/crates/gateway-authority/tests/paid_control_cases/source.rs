use super::*;
use gateway_authority::paid::{PaidAttempt, PaidReservation};
use gateway_core::{
    js_string::JsString16, model::ModelId, source_control::decode_source_control_record,
    source_json::SourceJson, source_serialization as source, value::ValueEncoding,
};

fn logical(units: &[u16]) -> ModelId {
    ModelId::from_source(JsString16::from_units(units.to_vec()))
}
fn row<T: serde::de::DeserializeOwned>(store: &MemoryStore, key: &RecordKey) -> T {
    decode_source_control_record(&store.row(key).unwrap())
        .unwrap()
        .deserialize()
        .unwrap()
}
fn setup(model: ModelId) -> (MemoryStore, TestAuthority, PaidRequest) {
    let store = MemoryStore::default();
    paid_setup(&store);
    let mut input = paid_request("source-control", PaidProvider::Surplus);
    input.model = model.clone();
    input.reasoning = Some(JsString16::from_units(vec![0xdc00]));
    let mut key_policy = policy();
    key_policy.paid_fallback_models = vec![model.clone()];
    key_policy.paid_fallback_max_exposure_microcredits =
        [(model.clone(), 777)].into_iter().collect();
    seed_source(&store, keys::api_policy("key-a"), &key_policy);
    let key = keys::paid_control_observation(PaidProvider::Surplus);
    let mut observation: PaidProviderObservation = row(&store, &key);
    observation.models = vec![
        source::object(vec![
            ("id", model.to_source_json().unwrap()),
            (
                "supported_endpoint_types",
                SourceJson::from_serializable(&vec!["openai-response"]).unwrap(),
            ),
            ("supports_tools", SourceJson::parse("true").unwrap()),
            ("input_price_per_token", SourceJson::parse("0.001").unwrap()),
            (
                "output_price_per_token",
                SourceJson::parse("0.002").unwrap(),
            ),
        ])
        .unwrap(),
    ];
    seed_source(&store, key, &observation);
    let mut projection: PaidRoutingProjection = row(&store, &keys::paid_routing());
    projection.policy.codex_models.clear();
    projection.policy.models = [(model, vec![PaidProvider::Surplus])].into_iter().collect();
    seed_source(&store, keys::paid_routing(), &projection);
    republish(&store);
    let authority = authority(&store);
    (store, authority, input)
}

#[test]
fn source_policy_keys_and_reasoning_round_trip_without_logical_model_conflation() {
    let models = [
        logical(&[0xd800]),
        logical(&[0xdc00]),
        logical(&[0xfffd]),
        logical(&[0xd83d, 0xde00]),
        ModelId::from_scalar(r"\ud800"),
    ];
    let store = MemoryStore::default();
    let mut expected = policy();
    expected.paid_fallback_models = models.to_vec();
    expected.paid_fallback_max_exposure_microcredits = models
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, m)| (m, i as i64 + 1))
        .collect();
    seed_source(&store, keys::api_policy("key-a"), &expected);
    let stored = store.row(&keys::api_policy("key-a")).unwrap();
    assert_eq!(stored.value_encoding, ValueEncoding::ProfileV2);
    let actual: gateway_authority::quota::ApiKeyPolicy = row(&store, &keys::api_policy("key-a"));
    assert_eq!(actual, expected);
    assert_eq!(actual.paid_fallback_max_exposure_microcredits.len(), 5);
    assert_eq!(
        actual
            .paid_fallback_max_exposure_microcredits
            .get(&models[0]),
        Some(&1)
    );
    assert_eq!(
        actual
            .paid_fallback_max_exposure_microcredits
            .get(&models[2]),
        Some(&3)
    );
    run(authority(&store).reserve_api_key(
        &ApiKeyId("key-a".into()),
        &RequestId("source-policy".into()),
        "responses",
        NOW,
    ))
    .unwrap();
    println!(
        "M19_SOURCE_POLICY_FIXTURE {}",
        serde_json::to_string(
            &serde_json::json!({"key":keys::api_policy("key-a").0,"record":stored})
        )
        .unwrap()
    );
}

#[test]
fn source_paid_attempt_writes_exact_model_effort_and_not_transient_prompt() {
    for model in [
        logical(&[0xd800]),
        logical(&[0xdc00]),
        logical(&[0xfffd]),
        logical(&[0xd83d, 0xde00]),
        ModelId::from_scalar(r"\ud800"),
    ] {
        let (store, authority, input) = setup(model.clone());
        let mut context = context(&input);
        let mut fields = source::entries(&context.body).unwrap();
        fields.push(("input".into(), SourceJson::parse(r#""\ud800""#).unwrap()));
        context.body = source::object_keys(fields).unwrap();
        let receipt = run(super::super::paid_original::authorize(
            &authority, &input, &context, NOW,
        ))
        .unwrap();
        let reservation = match run(authority.reserve_paid(
            &input,
            &PaidAuthorization::DirectPaidModel,
            &receipt,
            NOW,
        ))
        .unwrap()
        {
            PaidAdmission::Reserved(value) => value,
            _ => panic!("new source request"),
        };
        assert_eq!(reservation.reserved_microcredits, 777);
        let key = keys::paid_attempt("key-a", &input.attempt_id.0);
        let actual: PaidAttempt = row(&store, &key);
        assert_eq!(actual.model, model);
        assert_eq!(actual.reasoning, input.reasoning);
        let raw = decode_source_control_record(&store.row(&key).unwrap()).unwrap();
        for name in ["body", "input", "context", "prompt"] {
            assert!(source::member(&raw, name).is_none());
        }
        assert_eq!(
            store.row(&key).unwrap().expires_at_ms,
            Some(input.created_at_ms + gateway_authority::PAID_RETENTION_MS)
        );
        let mut changed = input.clone();
        changed.model = logical(&[0xfffd]);
        if changed.model == input.model {
            changed.model = logical(&[0xd800]);
        }
        assert!(
            run(authority.reserve_paid(
                &changed,
                &PaidAuthorization::DirectPaidModel,
                &receipt,
                NOW
            ))
            .is_err()
        );
    }
}

#[test]
fn ordinary_source_v3_guard_keeps_exact_active_paid_binding_and_missing_history_refusal() {
    let (store, authority, input) = setup(logical(&[0xd800]));
    let context = context(&input);
    let receipt = run(super::super::paid_original::authorize(
        &authority, &input, &context, NOW,
    ))
    .unwrap();
    let reservation: PaidReservation = match run(authority.reserve_paid(
        &input,
        &PaidAuthorization::DirectPaidModel,
        &receipt,
        NOW,
    ))
    .unwrap()
    {
        PaidAdmission::Reserved(value) => value,
        _ => panic!("new source request"),
    };
    let key = super::super::paid_original::journal_key(&input.request_id.0);
    let mut journal = decode_source_control_record(&store.row(&key).unwrap()).unwrap();
    let original: gateway_core::identity::RequestContext = source::member(&journal, "context")
        .unwrap()
        .deserialize()
        .unwrap();
    let attempt = source::object(vec![
        (
            "id",
            SourceJson::from_serializable(&input.attempt_id.0).unwrap(),
        ),
        ("paid", SourceJson::from_serializable(&reservation).unwrap()),
        ("model", input.model.to_source_json().unwrap()),
    ])
    .unwrap();
    let mut fields = source::entries(&journal).unwrap();
    for (name, next) in [
        ("v", SourceJson::parse("3").unwrap()),
        (
            "active",
            SourceJson::from_serializable(&input.attempt_id.0).unwrap(),
        ),
        ("attempts", source::json_array(&[attempt]).unwrap()),
    ] {
        *fields
            .iter_mut()
            .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
            .unwrap() = (name.into(), next);
    }
    journal = source::object_keys(fields).unwrap();
    seed_source(&store, key, &journal);
    let route = run(authority.authorize_paid_route(&input, &context, NOW)).unwrap();
    assert!(run(authority.bind_paid_original_request(&route, &original, NOW)).is_err());
    let bound =
        run(authority.bind_paid_original_dispatch(&route, &original, &reservation, NOW)).unwrap();
    assert!(matches!(
        run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &bound, NOW))
            .unwrap(),
        PaidAdmission::Existing(_)
    ));
    remove(&store, keys::paid_attempt("key-a", &input.attempt_id.0));
    assert!(
        run(authority.bind_paid_original_dispatch(&route, &original, &reservation, NOW)).is_err()
    );
    assert!(
        run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &bound, NOW))
            .is_err()
    );
    assert!(
        store
            .row(&keys::paid_attempt("key-a", &input.attempt_id.0))
            .is_none()
    );
}

#[derive(serde::Deserialize)]
struct CapturedCollation {
    fixture_only: bool,
    ids: Vec<Vec<u16>>,
    orders: Vec<Vec<i32>>,
}
struct FixtureOnlyCollator {
    data: CapturedCollation,
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl gateway_schema::aliases::SourceStringCollator for FixtureOnlyCollator {
    fn compare(
        &self,
        left: &JsString16,
        right: &JsString16,
    ) -> Result<std::cmp::Ordering, gateway_core::GatewayError> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let find = |value: &JsString16| {
            self.data
                .ids
                .iter()
                .position(|units| units == value.as_units())
        };
        let (Some(left), Some(right)) = (find(left), find(right)) else {
            return Err(gateway_core::GatewayError::unavailable(
                "Fixture-only collation pair was not captured.",
                "fixture_collation_unknown",
            ));
        };
        Ok(self.data.orders[left][right].cmp(&0))
    }
}

#[test]
fn paid_alias_tie_uses_one_constructor_collator_and_missing_or_unknown_pairs_fail_closed() {
    // Captured pinned Bun source localeCompare, fixture-only four exact pairs.
    // No general native comparator/lexical fallback is inferred from this test.
    let data: CapturedCollation = serde_json::from_str(include_str!(
        "../fixtures/source-string-collation-paid.json"
    ))
    .unwrap();
    assert!(data.fixture_only);
    let store = MemoryStore::default();
    paid_setup(&store);
    let key = keys::paid_control_observation(PaidProvider::Metered);
    let mut observation: PaidProviderObservation = row(&store, &key);
    observation.models = data
        .ids
        .iter()
        .map(|units| {
            source::object(vec![
                (
                    "id",
                    JsString16::from_units(units.clone())
                        .to_source_json()
                        .unwrap(),
                ),
                (
                    "supported_endpoint_types",
                    SourceJson::from_serializable(&vec!["openai-response", "openai"]).unwrap(),
                ),
            ])
            .unwrap()
        })
        .collect();
    seed_source(&store, key, &observation);
    republish(&store);
    let winner = if data.orders[0][1] <= 0 { 0 } else { 1 };
    let mut input = paid_request("source-alias-tie", PaidProvider::Metered);
    input.model = logical(&data.ids[winner]);
    let mut context = context(&input);
    context.original_model = gateway_schema::aliases::SYNTHETIC_MODEL.into();
    context.body = source::object(vec![(
        "model",
        context.original_model.to_source_json().unwrap(),
    )])
    .unwrap();
    context.synthetic_hop = Some(PaidSyntheticHop::Openlux);
    let missing_collator =
        gateway_authority::Authority::with_clock(store.clone(), Tokens::default(), store.clone());
    let absent = match run(missing_collator.authorize_paid_route(&input, &context, NOW)) {
        Err(error) => error,
        Ok(_) => panic!("missing demanded collator"),
    };
    assert_eq!(
        absent.envelope.error.code.as_deref(),
        Some("source_string_collation_unavailable")
    );
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let collator = std::sync::Arc::new(FixtureOnlyCollator {
        data,
        calls: calls.clone(),
    });
    assert!(
        gateway_schema::aliases::SourceStringCollator::compare(
            &*collator,
            &JsString16::from_utf8("unknown"),
            &JsString16::from_utf8("unknown")
        )
        .is_err()
    );
    let authority = authority(&store).with_source_string_collator(collator);
    run(authority.authorize_paid_route(&input, &context, NOW)).unwrap();
    assert!(calls.load(std::sync::atomic::Ordering::SeqCst) > 1);
}
