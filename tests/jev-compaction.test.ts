import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildCompactionResponse,
  CompactionUnavailable,
  handleJevResponsesCompaction,
  isJevCompactionRequest,
  setJevCompactionAskerForTest,
  SUMMARY_CHAR_CAP,
} from "../src/jev_compaction/compaction.ts";
import { parseCodexInput, renderSummary, SUMMARY_MARKER } from "../lib/jev_compaction/codex_items.ts";
import { collectToolCalls, estimateTokens, fitState } from "../lib/jev_compaction/state.ts";
import { compact } from "../lib/jev_compaction/compact.ts";
import type { JevAsker, JevQuestions, JevResponse, Message } from "../lib/jev_compaction/types.ts";
import { getResponseTelemetry } from "../src/openai-telemetry.ts";

/**
 * Focused regression coverage for the gateway Jev compaction slice: the
 * header-only predicate, the verbatim renderer, and every fail-closed path.
 * No network, no credential: every asker is injected.
 */

const COMPACTION_METADATA = JSON.stringify({ request_kind: "compaction", compaction: { implementation: "responses" } });
const COMPACTION_PROMPT = "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM.";
const KEPT_MARKER = "KEEP_MARKER_release_notes_artifact";

const text = (role: string, value: string) => ({ type: "message", role, content: [{ type: "input_text", text: value }] });
const call = (callId: string, command: string) => ({ type: "function_call", call_id: callId, name: "shell", arguments: JSON.stringify({ command }) });
const output = (callId: string, value: string) => ({ type: "function_call_output", call_id: callId, output: value });

/** Three obsolete unpinned call/result pairs, a pinned keep marker and the injected prompt. */
const transcript = (): unknown[] => [
  text("user", `Goal: finish the release notes and keep ${KEPT_MARKER} verbatim.`),
  text("assistant", "Starting with the old build logs."),
  call("old_a", "tail -n 400 /tmp/old/build.log"),
  output("old_a", `RESULT_A obsolete build log line. `.repeat(60)),
  call("old_b", "grep -c deprecated /tmp/old/metrics.csv"),
  output("old_b", `RESULT_B obsolete metric line. `.repeat(60)),
  call("old_c", "ls -la /tmp/old/cache"),
  output("old_c", `RESULT_C obsolete cache line. `.repeat(60)),
  text("assistant", "The old investigation is finished; those logs are obsolete."),
  text("user", "Recent follow-up one: draft the release notes outline."),
  text("assistant", "Drafted the outline."),
  text("user", "Recent follow-up two: check the artifact wording."),
  text("assistant", "Checked."),
  text("user", `Final goal: ${KEPT_MARKER} stays verbatim.`),
  text("user", COMPACTION_PROMPT),
];

const body = (input: unknown[], stream = true): Record<string, unknown> => ({ model: "deepseek-flash", stream, input });

type CallVerdict = Readonly<{ keepCall: number; keepResult: number }>;

/** Answers every `call_/result_` question from the verdict map. */
const decisionAsker = (verdicts: Readonly<Record<string, CallVerdict | undefined>>, options: Readonly<{ partial?: boolean }> = {}): JevAsker => ({
  ask(_state, questions: JevQuestions): Promise<JevResponse> {
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) {
      if (options.partial && name.startsWith("result_")) continue;
      const match = /^(?<kind>call|result)_(?<id>t\d+)$/.exec(name) as { groups: { kind: string; id: string } } | null;
      if (!match) continue;
      const { id, kind } = match.groups;
      const lookup = verdicts[id];
      const verdict = lookup ?? { keepCall: 1, keepResult: 1 };
      answers[name] = { noul: kind === "call" ? verdict.keepCall : verdict.keepResult };
    }
    return Promise.resolve({ answers });
  },
});

const throwAsker = (message: string): JevAsker => ({
  ask(): Promise<JevResponse> {
    return Promise.reject(new Error(message));
  },
});

const compactionRequest = (input: unknown[], stream = true, extraHeaders: Record<string, string> = {}): Request =>
  new Request("http://127.0.0.1:7999/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-turn-metadata": COMPACTION_METADATA, ...extraHeaders },
    body: JSON.stringify(body(input, stream)),
  });

test("jev compaction predicate is header-only and exact", async () => {
  const unmarked = new Request("http://127.0.0.1:7999/v1/responses", { method: "POST", body: JSON.stringify(body(transcript())) });
  assert.equal(isJevCompactionRequest(unmarked), false);
  assert.equal(await unmarked.text(), JSON.stringify(body(transcript())), "an unmarked request body must stay unread");

  const malformed = compactionRequest(transcript(), true, { "x-codex-turn-metadata": "{not json" });
  assert.equal(isJevCompactionRequest(malformed), false);

  const v2 = compactionRequest(transcript(), true, {
    "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { implementation: "responses_compaction_v2" } }),
  });
  assert.equal(isJevCompactionRequest(v2), false);

  const ordinaryTurn = compactionRequest(transcript(), true, {
    "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", compaction: { implementation: "responses" } }),
  });
  assert.equal(isJevCompactionRequest(ordinaryTurn), false);

  const marked = compactionRequest(transcript());
  assert.equal(isJevCompactionRequest(marked), true);
  assert.equal(await marked.text(), JSON.stringify(body(transcript())), "the predicate must not consume the body");
});

test("renderer applies Jev decisions verbatim and degrades dropped content to bounded provenance", async () => {
  const verdicts = {
    t1: { keepCall: 0.1, keepResult: 0.1 },
    t2: { keepCall: 0.9, keepResult: 0.1 },
    t3: { keepCall: 0.9, keepResult: 0.9 },
  };
  const outcome = await buildCompactionResponse(body(transcript()), decisionAsker(verdicts), { stream: true });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.contentType, "text/event-stream");
  assert.match(outcome.headers["x-jev-compaction"] ?? "", /calls_dropped=1/);
  assert.match(outcome.headers["x-jev-compaction"] ?? "", /results_dropped=1/);

  const summary = outcome.body;
  assert.ok(summary.includes(SUMMARY_MARKER), "the summary marker must be present");
  assert.ok(summary.includes(KEPT_MARKER), "pinned text must be kept verbatim");
  assert.ok(summary.includes("[tool result old_c — kept verbatim]"), "kept results must be labelled verbatim");
  assert.ok(summary.includes("[tool result old_b — truncated, original was"), "dropped results must be truncated, not removed");
  assert.ok(summary.includes("[tool call old_a]"), "a dropped call's provenance line must survive");
  assert.ok(summary.includes("[tool result old_a — truncated (call dropped), original was"), "a dropped call's result must keep a bounded head");
  assert.ok(summary.includes("RESULT_A"), "the bounded head must carry the result's opening bytes");
  assert.ok(summary.includes("fast-jev-compaction truncated"), "the truncated result must carry the truncation note");
  assert.ok(!summary.includes("RESULT_A obsolete build log line. ".repeat(20)), "the dropped call's payload must be bounded, not full");
  assert.ok(summary.includes("event: response.completed"), "a streamed compaction must terminate with response.completed");
  assert.ok(!summary.includes(COMPACTION_PROMPT.split(" ")[0] + " " + "are performing"), "the injected prompt must be excluded from the state");

  const buffered = await buildCompactionResponse(body(transcript()), decisionAsker(verdicts), { stream: false });
  assert.equal(buffered.contentType, "application/json");
  const parsed = JSON.parse(buffered.body) as { status?: string; output?: { content?: { text?: string }[] }[] };
  assert.equal(parsed.status, "completed");
  assert.ok((parsed.output?.[0]?.content?.[0]?.text ?? "").includes(KEPT_MARKER));
});

test("renderer marks kept calls and never rewrites kept text", () => {
  const parsed = parseCodexInput(transcript());
  assert.ok(parsed, "the synthetic transcript must parse");
  const calls = collectToolCalls(parsed.messages, 6);
  const decisions = calls.map((entry) => ({ id: entry.id, tool: entry.tool, keepCall: 1, keepResult: 1, action: "keep" as const, reason: "pinned" as const }));
  const summary = renderSummary(parsed, { decisions, callIds: new Map(calls.map((entry) => [entry.id, entry.tool_use_id])), headChars: 300 });
  assert.ok(!summary.includes("no decision (kept)"));
  assert.ok(summary.includes(KEPT_MARKER));
  assert.ok(summary.includes("[tool call old_c] shell — keep"));
});

/** Mixed text whose token estimate stays near four characters per token. */
const largeText = (chars: number): string => {
  const base =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu ";
  return base.repeat(Math.ceil(chars / base.length)).slice(0, chars);
};

/** A request at the intended validation scale whose floor exceeds the fit target. */
const largeTranscript = (textChars: number, resultChars: number): unknown[] => {
  const input: unknown[] = [text("user", "Goal: finish the large-session check."), call("big", "cat /tmp/big.log"), output("big", largeText(resultChars))];
  const chunks = 8;
  for (let index = 0; index < chunks; index += 1) input.push(text("user", largeText(Math.floor(textChars / chunks))));
  input.push(text("user", "Final goal: keep the exact state."));
  input.push(text("user", COMPACTION_PROMPT));
  return input;
};

test("floor-bound summary ships for a roughly 1.5-million-token input that cannot shrink further", async () => {
  const verdicts = { t1: { keepCall: 0.1, keepResult: 0.1 } };
  const input = largeTranscript(5_100_000, 3_000_000);
  const requestTokens = estimateTokens(JSON.stringify(input));
  assert.ok(requestTokens > 1_500_000, `the fixture must be a ~1.5M-token request (got ${requestTokens})`);
  const outcome = await buildCompactionResponse(body(input), decisionAsker(verdicts), { stream: false });
  assert.equal(outcome.status, 200);
  assert.ok(outcome.body.includes(SUMMARY_MARKER));
  assert.ok(outcome.body.length > SUMMARY_CHAR_CAP, `the accepted floor must exceed the fit target (got ${outcome.body.length})`);
  assert.ok(outcome.body.length < JSON.stringify(input).length, "the floor must be smaller than the input it replaces");
  assert.match(outcome.headers["x-jev-compaction"] ?? "", /floor=1/);
  assert.match(outcome.headers["x-jev-compaction"] ?? "", /calls_dropped=1/);
});

test("a floor that is not measurably smaller than its input still fails closed", async () => {
  const verdicts = { t1: { keepCall: 0.1, keepResult: 0.1 } };
  const input = largeTranscript(3_900_000, 250_000);
  await assert.rejects(
    () => buildCompactionResponse(body(input), decisionAsker(verdicts), { stream: false }),
    (error: unknown) => error instanceof CompactionUnavailable && error.kind === "summary-too-large"
  );
});

test("compaction fails closed on malformed input, no candidates and no reduction", async () => {
  await assert.rejects(
    () => buildCompactionResponse({ model: "deepseek-flash" }, decisionAsker({}), { stream: true }),
    (error: unknown) => error instanceof CompactionUnavailable && error.kind === "missing-input"
  );
  await assert.rejects(
    () => buildCompactionResponse(body([text("user", "hello"), text("assistant", "hi")]), decisionAsker({}), { stream: true }),
    (error: unknown) => error instanceof CompactionUnavailable && error.kind === "no-candidates"
  );
  const keepEverything = decisionAsker({ t1: { keepCall: 1, keepResult: 1 }, t2: { keepCall: 1, keepResult: 1 }, t3: { keepCall: 1, keepResult: 1 } });
  await assert.rejects(
    () => buildCompactionResponse(body(transcript()), keepEverything, { stream: true }),
    (error: unknown) => error instanceof CompactionUnavailable && error.kind === "no-reduction"
  );
});

test("compaction fails closed on Jev error or a partial decision set", async () => {
  await assert.rejects(
    () => buildCompactionResponse(body(transcript()), throwAsker("Jev request failed (500): upstream"), { stream: true }),
    (error: unknown) => error instanceof CompactionUnavailable && error.kind === "jev-failed"
  );
  await assert.rejects(
    () => buildCompactionResponse(body(transcript()), decisionAsker({ t1: { keepCall: 0.1, keepResult: 0.1 } }, { partial: true }), { stream: true }),
    (error: unknown) => error instanceof CompactionUnavailable && error.kind === "jev-failed"
  );
});

test("compaction fails closed on an oversized summary", async () => {
  const oversized = [
    text("user", `Goal: ${"x".repeat(SUMMARY_CHAR_CAP + 1_000)}`),
    call("old", "echo old"),
    output("old", `RESULT_OBSOLETE `.repeat(40)),
    text("user", "recent one"),
    text("assistant", "recent two"),
    text("user", "recent three"),
    text("assistant", "recent four"),
    text("user", "recent five"),
    text("assistant", "recent six"),
    text("user", COMPACTION_PROMPT),
  ];
  await assert.rejects(
    () => buildCompactionResponse(body(oversized), decisionAsker({ t1: { keepCall: 0.1, keepResult: 0.1 } }), { stream: true }),
    (error: unknown) => error instanceof CompactionUnavailable && error.kind === "summary-too-large"
  );
});

test("compaction fits kept results under the cap by dropping the lowest relevance first", async () => {
  const chunk = 360_000;
  const fitting = [
    text("user", "Goal: keep the release evidence."),
    call("old_a", "cat /tmp/a"),
    output("old_a", "A".repeat(chunk)),
    call("old_b", "cat /tmp/b"),
    output("old_b", "B".repeat(chunk)),
    call("old_c", "cat /tmp/c"),
    output("old_c", "C".repeat(chunk)),
    call("old_d", "cat /tmp/d"),
    output("old_d", "D".repeat(chunk)),
    call("old_e", "cat /tmp/e"),
    output("old_e", "E".repeat(chunk)),
    text("user", COMPACTION_PROMPT),
  ];
  const verdicts = {
    t1: { keepCall: 0.9, keepResult: 0.6 },
    t2: { keepCall: 0.9, keepResult: 0.7 },
    t3: { keepCall: 0.9, keepResult: 0.8 },
    t4: { keepCall: 0.9, keepResult: 0.9 },
    t5: { keepCall: 0.9, keepResult: 0.95 },
  };
  const outcome = await buildCompactionResponse(body(fitting), decisionAsker(verdicts), { stream: false });
  assert.equal(outcome.status, 200);
  assert.match(outcome.headers["x-jev-compaction"] ?? "", /fitted=[1-9]/);
  const parsed = JSON.parse(outcome.body) as { output?: { content?: { text?: string }[] }[] };
  const summary = parsed.output?.[0]?.content?.[0]?.text ?? "";
  assert.ok(summary.length <= SUMMARY_CHAR_CAP, "the fitted summary must respect the cap");
  assert.ok(summary.includes("[tool result old_e — kept verbatim]"), "the highest-relevance result must stay verbatim");
  assert.ok(summary.includes("[tool result old_a — truncated"), "the lowest-relevance result must be fitted away");
});

test("windowed decisions keep local state when a long transcript degrades the global fit", async () => {
  const messages: Message[] = [];
  for (let index = 0; index < 400; index += 1) {
    messages.push({ role: "assistant", text: "", toolUses: [{ tool_use_id: `call_${index}`, tool: "exec_command", input: { cmd: `command ${index}` } }] });
    messages.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: `call_${index}`, text: `result ${index} `.repeat(50) }] });
  }
  messages.push({ role: "user", text: "Final goal.", toolUses: [] });
  const states: string[] = [];
  const asker: JevAsker = {
    ask(state: unknown, questions: JevQuestions): Promise<JevResponse> {
      states.push(JSON.stringify(state));
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(questions)) answers[name] = { noul: 0.1 };
      return Promise.resolve({ answers });
    },
  };
  const result = await compact(messages, asker, { preserveRecentMessages: 2, maxStateTokens: 800, maxRequestTokens: 4_000, keepThreshold: 0.5 });
  assert.ok(result.stats.stateStage.startsWith("windowed"), `expected windowed stage, got ${result.stats.stateStage}`);
  assert.ok(result.stats.windows > 1, "a long transcript must use more than one window");
  assert.equal(result.decisions.length, 400, "every call must still be decided");
  for (const state of states) {
    assert.ok(estimateTokens(state) <= 1_200, `each window state must stay local, got ~${estimateTokens(state)} tokens`);
  }
});

test("short transcripts keep the single global state path", async () => {
  const messages: Message[] = [
    { role: "user", text: "Goal.", toolUses: [] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "call_a", tool: "exec_command", input: { cmd: "one" } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "call_a", text: "first result" }] },
    { role: "assistant", text: "", toolUses: [{ tool_use_id: "call_b", tool: "exec_command", input: { cmd: "two" } }] },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "call_b", text: "second result" }] },
    { role: "user", text: "Final goal.", toolUses: [] },
  ];
  const asker: JevAsker = {
    ask(_state: unknown, questions: JevQuestions): Promise<JevResponse> {
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(questions)) answers[name] = { noul: 0.1 };
      return Promise.resolve({ answers });
    },
  };
  const result = await compact(messages, asker, { preserveRecentMessages: 1, keepThreshold: 0.5 });
  assert.equal(result.stats.windows, 0);
  assert.equal(result.stats.stateStage, "full");
});

test("fitState drops the oldest merged call runs instead of failing on very long sessions", () => {
  const messages: Message[] = [{ role: "user", text: "Goal: keep the current state.", toolUses: [] }];
  for (let index = 0; index < 400; index += 1) {
    messages.push({ role: "assistant", text: "", toolUses: [{ tool_use_id: `call_${index}`, tool: "exec_command", input: { cmd: `command ${index}` } }] });
    messages.push({ role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: `call_${index}`, text: `result ${index}` }] });
  }
  messages.push({ role: "user", text: "Final goal: keep the current state.", toolUses: [] });
  const calls = collectToolCalls(messages, 2);
  const fitted = fitState(messages, calls, { maxStateTokens: 800, preserveRecentMessages: 2, goal: "" });
  assert.ok(fitted.tokens <= 800, `the state must fit the cap, got ${fitted.tokens}`);
  assert.equal(fitted.stage, "old call runs left out");
});

test("gateway handler fails closed without a credential and on caller cancellation", async () => {
  const missingKey = await handleJevResponsesCompaction(compactionRequest(transcript()), { apiKey: null });
  assert.equal(missingKey.status, 503);
  const failure = (await missingKey.json()) as { error: { code?: string; message?: string } };
  assert.equal(failure.error.code, "jev_compaction_unavailable");
  assert.match(failure.error.message ?? "", /missing-key/);

  const cancelled = await handleJevResponsesCompaction(compactionRequest(transcript()), { signal: AbortSignal.abort(), asker: decisionAsker({}) });
  assert.equal(cancelled.status, 499);
  const cancelledBody = (await cancelled.json()) as { error?: { code?: string } };
  assert.equal(cancelledBody.error?.code, "request_cancelled");
});

test("gateway handler answers a marked request through the injected asker", async () => {
  const verdicts = { t1: { keepCall: 0.1, keepResult: 0.1 }, t2: { keepCall: 0.1, keepResult: 0.1 }, t3: { keepCall: 0.1, keepResult: 0.1 } };
  const response = await handleJevResponsesCompaction(compactionRequest(transcript()), { apiKey: "test-key", asker: decisionAsker(verdicts) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.ok(response.headers.get("x-jev-compaction"));
  const textBody = await response.text();
  assert.ok(textBody.includes(SUMMARY_MARKER));
  assert.ok(textBody.includes(KEPT_MARKER));
});

test("completion telemetry marks a local success without inventing usage", async () => {
  const verdicts = { t1: { keepCall: 0.1, keepResult: 0.1 } };
  const response = await handleJevResponsesCompaction(compactionRequest(transcript()), { apiKey: "test-key", asker: decisionAsker(verdicts) });
  assert.equal(response.status, 200);
  const telemetry = getResponseTelemetry(response);
  assert.ok(telemetry, "a local success must carry completion telemetry for the terminal wrapper");
  assert.equal(telemetry.completed, true);
  assert.equal(telemetry.semanticOutputObserved, true);
  assert.equal(telemetry.stream, true);
  assert.equal(telemetry.streamTerminalType, "response.completed");
  assert.equal(telemetry.provider, "gateway");
  assert.equal(telemetry.failureKind, null);
  assert.equal(telemetry.usageObserved, false);
  assert.equal(telemetry.inputTokens, null);
  assert.equal(telemetry.outputTokens, null);
  assert.equal(telemetry.totalTokens, null);

  const refused = await handleJevResponsesCompaction(compactionRequest([text("user", "short"), text("assistant", "short answer")]), {
    apiKey: "test-key",
    asker: decisionAsker({}),
  });
  assert.ok(refused.status >= 400);
  assert.equal(getResponseTelemetry(refused), null, "a failed compaction must not claim completion");
});

test("test asker seam routes a handler compaction through the injected asker", async () => {
  const verdicts = {
    t1: { keepCall: 0.1, keepResult: 0.1 },
    t2: { keepCall: 0.1, keepResult: 0.1 },
    t3: { keepCall: 0.1, keepResult: 0.1 },
  };
  setJevCompactionAskerForTest(decisionAsker(verdicts));
  try {
    const response = await handleJevResponsesCompaction(compactionRequest(transcript()), { apiKey: "test-seam" });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(SUMMARY_MARKER));
  } finally {
    setJevCompactionAskerForTest(null);
  }
});
