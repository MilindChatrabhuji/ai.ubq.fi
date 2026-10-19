use super::*;
use crate::{
    engine, hybrid,
    model::*,
    state,
    text::{self, Text, text},
    transcript,
};
use gateway_core::{GatewayError, source_json::SourceJson};
use serde::Deserialize;
use std::{
    cell::{Cell, RefCell},
    future::Future,
    task::{Context, Poll, Waker},
};
fn run<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}
fn fixture() -> SourceJson {
    SourceJson::parse(include_str!("../tests/fixtures/source-v1.json")).unwrap()
}
fn cases(name: &str) -> Vec<SourceJson> {
    text::member(&fixture(), name)
        .unwrap()
        .array_items()
        .unwrap()
}
fn decode<T: serde::de::DeserializeOwned>(value: &SourceJson) -> T {
    value.deserialize().unwrap()
}
fn equal(actual: &SourceJson, expected: &SourceJson) {
    let a = text::canonical(actual).unwrap();
    let b = text::canonical(expected).unwrap();
    if a == b {
        return;
    }
    let i = a
        .as_bytes()
        .iter()
        .zip(b.as_bytes())
        .position(|(a, b)| a != b)
        .unwrap_or(a.as_bytes().len().min(b.as_bytes().len()));
    let snippet = |s: &str| {
        let mut lo = i.saturating_sub(80).min(s.len());
        while !s.is_char_boundary(lo) {
            lo -= 1;
        }
        let mut hi = (i + 200).min(s.len());
        while !s.is_char_boundary(hi) {
            hi -= 1;
        }
        s[lo..hi].to_owned()
    };
    panic!(
        "source JSON mismatch at byte {i}; actual={} expected={}",
        snippet(a.as_str()),
        snippet(b.as_str())
    );
}
fn field(value: &SourceJson, name: &str) -> SourceJson {
    text::member(value, name).unwrap()
}
fn string(value: &SourceJson) -> String {
    text::string(value).unwrap().try_utf8().unwrap()
}
#[derive(Deserialize)]
struct Recipe {
    count: usize,
    text: usize,
    input: usize,
    #[serde(default)]
    notes: bool,
}
fn recipe(r: &Recipe) -> Vec<Message> {
    let mut out = vec![Message {
        role: Role::User,
        text: "Goal: preserve current state.".into(),
        tool_uses: Vec::new(),
        tool_results: None,
    }];
    for i in 0..r.count {
        let input = text::object(vec![(
            "cmd",
            text::quoted(&Text::from(format!(
                "command {i} {}",
                "script ".repeat(r.input)
            )))
            .unwrap(),
        )])
        .unwrap();
        out.push(Message {
            role: Role::Assistant,
            text: if r.text == 0 {
                Text::default()
            } else {
                format!("older alpha bravo {i} ").repeat(r.text).into()
            },
            tool_uses: vec![ToolUse {
                tool_use_id: text!("call_", i),
                tool: "exec_command".into(),
                input: std::rc::Rc::new(input),
                text: None,
                is_error: None,
            }],
            tool_results: None,
        });
        out.push(Message {
            role: Role::User,
            text: Text::default(),
            tool_uses: Vec::new(),
            tool_results: Some(vec![ToolResult {
                tool_use_id: text!("call_", i),
                text: format!("result {i} ").repeat(50).into(),
                is_error: None,
            }]),
        });
    }
    if r.notes {
        out.insert(
            out.len() - 2,
            Message {
                role: Role::User,
                text: text!("Older plain note ", r.count),
                tool_uses: Vec::new(),
                tool_results: None,
            },
        );
    }
    out.push(Message {
        role: Role::User,
        text: "Final goal.".into(),
        tool_uses: Vec::new(),
        tool_results: None,
    });
    out
}
struct Host {
    mode: String,
    residue: String,
    asks: RefCell<Vec<SourceJson>>,
    residue_calls: RefCell<Vec<SourceJson>>,
    oversized: usize,
    cancel: Cell<bool>,
    cancel_after_ask: bool,
}
impl Host {
    fn new(mode: &str) -> Self {
        Self {
            mode: mode.into(),
            residue: "failure".into(),
            asks: RefCell::new(Vec::new()),
            residue_calls: RefCell::new(Vec::new()),
            oversized: 0,
            cancel: Cell::new(false),
            cancel_after_ask: false,
        }
    }
}
impl CompactionHost for Host {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(1_700_000_000_000)
    }
    fn random_uuid(&self) -> Result<String, GatewayError> {
        Ok("00000000-0000-4000-8000-000000000001".into())
    }
    fn cancelled(&self) -> bool {
        self.cancel.get()
    }
    async fn ask_jev(
        &self,
        state: &SourceJson,
        questions: &SourceJson,
        timeout: u32,
    ) -> Result<SourceJson, GatewayError> {
        assert_eq!(timeout, 30_000);
        self.asks.borrow_mut().push(
            text::object(vec![
                ("state", state.clone()),
                ("questions", questions.clone()),
            ])
            .unwrap(),
        );
        if self.cancel_after_ask {
            self.cancel.set(true);
        }
        if self.mode == "throw" {
            return Err(GatewayError::new(
                500,
                "private provider text",
                Some("controlled"),
            ));
        }
        let mut answers = Vec::new();
        for (name, _) in text::entries(questions).unwrap() {
            let name_text = name.try_utf8().unwrap();
            if self.mode == "partial" && name_text.starts_with("result_") {
                continue;
            }
            let id = name_text
                .split("_t")
                .nth(1)
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let mut value = 0.1;
            if self.mode == "mixed" {
                value = if id == 3 || id == 2 && name_text.starts_with("call_") {
                    0.9
                } else {
                    0.1
                };
            }
            if self.mode == "keep" {
                value = 1.0;
            }
            if self.mode == "outside" {
                value = if id == 1 {
                    if name_text.starts_with("call_") {
                        2.0
                    } else {
                        -1.0
                    }
                } else if id == 2 {
                    2.0
                } else {
                    -1.0
                };
            }
            let number = if self.mode == "nonfinite" && name_text == "result_t1" {
                text::raw("\"0.1\"").unwrap()
            } else {
                state::json(&value).unwrap()
            };
            answers.push((name, text::object(vec![("noul", number)]).unwrap()));
        }
        Ok(text::object(vec![("answers", text::object_keys(answers).unwrap())]).unwrap())
    }
    async fn rewrite_residue(
        &self,
        body: &SourceJson,
        timeout: u32,
    ) -> Result<SourceJson, GatewayError> {
        assert!(timeout == 20_000 || timeout == 1000);
        self.residue_calls.borrow_mut().push(body.clone());
        let n = self.residue_calls.borrow().len();
        if self.residue == "failure"
            || self.residue == "fail"
            || (self.residue == "partial" && n == 2)
        {
            return Err(GatewayError::new(
                500,
                "controlled residue failure",
                Some("controlled"),
            ));
        }
        let content = if self.residue == "empty" {
            "  ".into()
        } else if self.residue == "oversized" {
            "x".repeat(self.oversized)
        } else {
            "SLIM_MODEL_MARKER compact text.".into()
        };
        Ok(SourceJson::from_serializable(
            &serde_json::json!({"choices":[{"message":{"content":content}}]}),
        )
        .unwrap())
    }
}
#[test]
fn exact_header_predicate_matches_source() {
    for case in cases("metadata") {
        let raw: Option<String> = decode(&field(&case, "raw"));
        assert_eq!(
            is_responses_compaction(raw.as_deref()),
            decode::<bool>(&field(&case, "expected"))
        );
    }
}
#[test]
fn source_json_stringify_retains_utf16_numbers_last_members_and_integer_property_order() {
    for case in cases("canonical") {
        let raw: Text = decode(&field(&case, "raw"));
        let expected: Text = decode(&field(&case, "expected"));
        let actual = text::parse_text(&raw).unwrap();
        assert_eq!(Text::from(actual.as_str()), expected);
    }
}
#[test]
fn source_codex_items_and_opaque_redaction_are_exact() {
    for case in cases("parser") {
        let raw: Text = decode(&field(&case, "raw"));
        let input = text::parse_text(&raw).unwrap();
        let actual = transcript::parse_input(&input).unwrap();
        equal(&state::json(&actual).unwrap(), &field(&case, "expected"));
    }
}
#[test]
fn source_utf16_estimator_and_bounded_heads_match_including_split_surrogates() {
    for case in cases("tokens") {
        let text: Text = decode(&field(&case, "text"));
        assert_eq!(
            state::estimate_tokens(&text),
            decode::<usize>(&field(&case, "expected"))
        );
    }
    for case in cases("truncation") {
        let value: Text = decode(&field(&case, "text"));
        let expected: Text = decode(&field(&case, "expected"));
        assert_eq!(
            engine::truncated_result(
                &value,
                decode(&field(&case, "error")),
                decode(&field(&case, "head"))
            ),
            expected
        );
    }
}
#[test]
fn source_local_response_and_all_candidate_failures_match_without_usage_or_partial_output() {
    for case in cases("bodies") {
        let raw: Text = decode(&field(&case, "raw"));
        let body = text::parse_text(&raw).unwrap();
        let original = body.as_str().to_owned();
        let mut host = Host::new(&string(&field(&case, "mode")));
        host.residue = string(&field(&case, "residue"));
        let stream = decode(&field(&case, "stream"));
        let hybrid = decode(&field(&case, "hybrid"));
        let expected = field(&case, "expected");
        let result = run(build_compaction_response(
            &body,
            &host,
            ResponseOptions { stream, hybrid },
        ));
        if string(&field(&expected, "kind")) == "failure" {
            assert_eq!(
                result.unwrap_err().kind.label(),
                string(&field(&expected, "failure"))
            );
        } else {
            let result = result.unwrap();
            let actual=SourceJson::from_serializable(&serde_json::json!({"status":result.status,"contentType":result.content_type,"headers":result.headers,"body":String::from_utf8(result.body).unwrap()})).unwrap();
            equal(&actual, &field(&expected, "outcome"));
        }
        assert_eq!(body.as_str(), original);
        equal(
            &state::json(&*host.asks.borrow()).unwrap(),
            &field(&case, "asks"),
        );
    }
}
#[test]
fn source_state_fitting_ladder_preserves_exact_stages_and_budget_counts() {
    for case in cases("states") {
        let r: Recipe = decode(&field(&case, "recipe"));
        let messages = recipe(&r);
        let calls = state::collect_calls(&messages, 2);
        let opts = Options {
            max_state_tokens: Some(decode::<f64>(&field(&case, "budget"))),
            preserve_recent_messages: Some(2.0),
            ..Options::default()
        }
        .resolve();
        let expected = field(&case, "expected");
        let result = state::fit_state(&messages, &calls, &opts);
        if string(&field(&expected, "kind")) == "failure" {
            assert!(result.is_err());
        } else {
            equal(
                &state::json(&result.unwrap()).unwrap(),
                &field(&expected, "fitted"),
            );
        }
    }
}
#[test]
fn source_windows_batching_pin_rules_and_projected_transcript_match() {
    for case in cases("engines") {
        let r: Recipe = decode(&field(&case, "recipe"));
        let messages = recipe(&r);
        let options: Options = decode(&field(&case, "options"));
        let host = Host::new("drop");
        let result = run(engine::compact(&messages, &host, &options)).unwrap();
        equal(&state::json(&result).unwrap(), &field(&case, "result"));
        let calls = state::collect_calls(&messages, 2);
        let windows = engine::plan_windows(&messages, &calls, 80_000)
            .into_iter()
            .map(|(start, end)| serde_json::json!({"start":start,"end":end}))
            .collect::<Vec<_>>();
        equal(&state::json(&windows).unwrap(), &field(&case, "windows"));
    }
}
#[test]
fn source_identifier_order_counts_latest_tail_and_block_chunks_match() {
    for case in cases("ledgers") {
        let value: Text = decode(&field(&case, "text"));
        equal(
            &state::json(&hybrid::harvest(&value, 300)).unwrap(),
            &field(&case, "expected"),
        );
        let composed: Text = decode(&field(&case, "composed"));
        assert_eq!(
            hybrid::compose(&Text::from("short memory"), &value),
            composed
        );
        let chunks: Vec<Text> = decode(&field(&case, "chunks"));
        assert_eq!(hybrid::chunks(&value, 30), chunks);
    }
}
#[test]
fn source_residue_full_partial_empty_and_all_failure_paths_keep_the_right_chunks() {
    for case in cases("residues") {
        let pure: Text = decode(&field(&case, "pure"));
        let mut host = Host::new("drop");
        host.residue = string(&field(&case, "mode"));
        host.oversized = pure.len() + 1000;
        let result = run(hybrid::run(&pure, &host, 400, 1000));
        let expected: Option<Text> = decode(&field(&case, "expected"));
        assert_eq!(result, expected);
        equal(
            &state::json(&*host.residue_calls.borrow()).unwrap(),
            &field(&case, "requests"),
        );
    }
}
#[test]
fn cancellation_cannot_return_success_or_hide_in_hybrid_fallback() {
    let case = cases("bodies").remove(0);
    let body = text::parse_text(&decode::<Text>(&field(&case, "raw"))).unwrap();
    let host = Host::new("drop");
    host.cancel.set(true);
    assert_eq!(
        run(build_compaction_response(
            &body,
            &host,
            ResponseOptions {
                stream: false,
                hybrid: false
            }
        ))
        .unwrap_err()
        .kind,
        FailureKind::Cancelled
    );
    assert!(host.asks.borrow().is_empty());
    let mut host = Host::new("drop");
    host.cancel_after_ask = true;
    assert_eq!(
        run(build_compaction_response(
            &body,
            &host,
            ResponseOptions {
                stream: false,
                hybrid: false
            }
        ))
        .unwrap_err()
        .kind,
        FailureKind::Cancelled
    );
    assert_eq!(host.asks.borrow().len(), 1);
}
