use gateway_native::{
    redaction, supervisor, supervisor_brief as brief, supervisor_data,
    supervisor_inventory as inventory, supervisor_metadata as metadata,
    supervisor_rollout as rollout,
};
use serde_json::{Value, json};
fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/supervisor-source-golden.json")).unwrap()
}
#[test]
fn source_redaction_golden_preserves_text_counts_and_split_records() {
    let data = corpus();
    let mut failures = Vec::new();
    for case in data["redaction"].as_array().unwrap() {
        let actual = redaction::redact(case["input"].as_str().unwrap());
        let actual = json!({"text":actual.text,"redactions":actual.redactions});
        if actual != case["expected"] {
            failures.push(format!(
                "input={:?} expected={} actual={actual}",
                case["input"], case["expected"]
            ));
        }
    }
    for case in data["parts"].as_array().unwrap() {
        let parts = serde_json::from_value::<Vec<String>>(case["input"].clone()).unwrap();
        let actual = redaction::redact_parts(&parts)
            .into_iter()
            .map(|v| json!({"text":v.text,"redactions":v.redactions}))
            .collect::<Vec<_>>();
        if json!(actual) != case["expected"] {
            failures.push(format!(
                "parts={:?} expected={} actual={}",
                parts,
                case["expected"],
                json!(actual)
            ));
        }
    }
    let repeated = &data["redactionRepeated"];
    let entry = repeated["entry"].as_str().unwrap();
    let count = repeated["count"].as_u64().unwrap() as usize;
    let input = format!("configure({}); done", entry.repeat(count));
    let actual = redaction::redact(&input);
    let actual = json!({"text":actual.text,"redactions":actual.redactions});
    if actual != repeated["expected"] {
        failures.push(format!(
            "bounded repeated source redaction mismatch: expected={} actual={actual}",
            repeated["expected"]
        ));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[test]
fn source_state_quota_metadata_and_configuration_goldens() {
    let data = corpus();
    for case in data["states"].as_array().unwrap() {
        let i = &case["input"];
        assert_eq!(
            json!(supervisor::classify_state(
                i["runtimeStatus"].as_str(),
                i["turnStatus"].as_str(),
                i["loaded"].as_bool().unwrap()
            )),
            case["expected"]
        );
    }
    for case in data["quotas"].as_array().unwrap() {
        assert_eq!(
            json!(inventory::quota_from_rate_limits(&case["input"])),
            case["expected"]
        );
    }
    for case in data["metadata"].as_array().unwrap() {
        assert_eq!(
            json!(metadata::metadata_from_row(&case["input"])),
            case["expected"]
        );
    }
    for case in data["configs"].as_array().unwrap() {
        let (sources, notes) = supervisor_data::parse_config(&case["input"]);
        assert_eq!(
            json!({"sources":sources.iter().map(|v|v.to_source_value()).collect::<Vec<_>>(),"notes":notes}),
            case["expected"]
        );
    }
}
#[test]
fn source_session_precedence_and_visibility_goldens() {
    let data = corpus();
    for case in data["sessions"].as_array().unwrap() {
        let i = &case["input"];
        let m = serde_json::from_value::<Option<metadata::ThreadMetadata>>(i["metadata"].clone())
            .unwrap();
        let listed =
            serde_json::from_value::<Option<inventory::ListedThread>>(i["listed"].clone()).unwrap();
        let probe =
            serde_json::from_value::<Option<inventory::ThreadProbe>>(i["probe"].clone()).unwrap();
        let actual = inventory::session_from_parts(inventory::SessionParts {
            id: i["id"].as_str().unwrap(),
            source_id: i["source"]["id"].as_str().unwrap(),
            machine: i["source"]["name"].as_str().unwrap(),
            metadata: m.as_ref(),
            listed: listed.as_ref(),
            probe: probe.as_ref(),
            loaded: i["loaded"].as_bool().unwrap(),
            sampled_at_ms: i["sampledAtMs"].as_i64().unwrap(),
            child_ids: serde_json::from_value(i["childIds"].clone()).unwrap(),
            unavailable: serde_json::from_value(i["unavailable"].clone()).unwrap(),
        });
        assert_eq!(actual, case["expected"]);
    }
    for case in data["rollout"].as_array().unwrap() {
        assert_eq!(
            json!(rollout::parse_rollout_tail(case["input"].as_str().unwrap())),
            case["expected"]
        );
    }
    for case in data["turns"].as_array().unwrap() {
        assert_eq!(
            json!(brief::brief_turn(
                &case["input"],
                case["head"].as_bool().unwrap()
            )),
            case["expected"]
        );
    }
}
#[test]
fn source_brief_budget_redaction_and_metadata_prompt_equivalence() {
    let data = corpus();
    for case in data["assembly"].as_array().unwrap() {
        let turns =
            serde_json::from_value::<Vec<brief::BriefTranscriptTurn>>(case["input"].clone())
                .unwrap();
        assert_eq!(
            json!(brief::assemble_brief_context(&turns)),
            case["expected"]
        );
    }
    let mut context =
        serde_json::from_value::<brief::SupervisorBriefContext>(data["prompt"]["context"].clone())
            .unwrap();
    let original_count = context.redactions;
    brief::sanitize_context_metadata(&mut context);
    assert_eq!(json!(context), data["prompt"]["sanitized"]);
    assert_eq!(context.redactions, original_count);
    assert_eq!(
        data["prompt"]["expected"],
        data["prompt"]["sanitizedExpected"]
    );
}
