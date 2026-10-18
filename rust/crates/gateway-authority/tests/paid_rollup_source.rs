use gateway_authority::paid::PaidRollup;
use serde_json::json;

#[test]
fn imported_source_rollup_preserves_quota_sum_and_refuses_retired_rust_field() {
    // Frozen source 6d4d4790: native-paid-contracts.ts and mergePaidFallbackUsageRollup.
    let source = json!({
        "v":1,"bucket_start_at_ms":1000,"model":"gpt-test","provider":"metered",
        "request_count":2,"quota_sum":1.25,"input_tokens":3,"cached_input_tokens":1,
        "output_tokens":2,"spend_microcredits":5,"first_request_at_ms":1001,
        "last_request_at_ms":1002,"updated_at_ms":1003
    });
    let imported: PaidRollup = serde_json::from_value(source.clone()).unwrap();
    assert_eq!(imported.provider_quota, 1.25);
    let output = serde_json::to_value(imported).unwrap();
    assert_eq!(output, source);
    assert!(output.get("provider_quota").is_none());
    let mut retired = source;
    let quota = retired
        .as_object_mut()
        .unwrap()
        .remove("quota_sum")
        .unwrap();
    retired["provider_quota"] = quota;
    assert!(serde_json::from_value::<PaidRollup>(retired).is_err());
}
