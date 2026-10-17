import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  BOOTSTRAP_CLASSIFIER_BOOLEAN_PATTERN,
  BOOTSTRAP_CLASSIFIER_MAX_OUTPUT_TOKENS,
  buildBootstrapClassifierRequest,
  parseBootstrapClassifierVerdict,
  verdictFromBootstrapResponse,
} from "../src/harmony/classifier.ts";
import type { NormalizedAssistantResponse } from "../src/harmony/types.ts";

const OBSERVATION = {
  runId: "run-1",
  generation: 2,
  phase: "apply",
  milestone: "implementation-verified",
  failureFingerprint: null,
  gitSha: "abc123",
  ledgerVersion: 7,
  retryState: null,
  verificationEvidence: "passed",
};

const responseFor = (content: string | null, overrides: Partial<NormalizedAssistantResponse> = {}): NormalizedAssistantResponse => ({
  id: "cmpl-1",
  model: "gpt-oss-120b",
  created: 1,
  turns: [],
  analysis: [],
  content,
  toolCalls: [],
  finishReason: content === null ? null : "stop",
  refusal: null,
  shape: {
    contentPresent: content !== null,
    contentChars: content?.length ?? 0,
    reasoningField: "none",
    reasoningChars: 0,
    toolCallsField: false,
    toolCallCount: 0,
    finishReason: content === null ? null : "stop",
    refusal: false,
  },
  ...overrides,
});

test("the contract pattern is anchored and case-insensitive", () => {
  assert.ok(BOOTSTRAP_CLASSIFIER_BOOLEAN_PATTERN.test("true"));
  assert.ok(BOOTSTRAP_CLASSIFIER_BOOLEAN_PATTERN.test("false"));
  assert.ok(BOOTSTRAP_CLASSIFIER_BOOLEAN_PATTERN.test("TRUE"));
  assert.ok(BOOTSTRAP_CLASSIFIER_BOOLEAN_PATTERN.test("False"));
});

test("accepts full-string literals after trimming", () => {
  assert.deepEqual(parseBootstrapClassifierVerdict("true"), { verdict: "true", raw: "true" });
  assert.deepEqual(parseBootstrapClassifierVerdict("false"), { verdict: "false", raw: "false" });
  assert.deepEqual(parseBootstrapClassifierVerdict("  TRUE  "), { verdict: "true", raw: "TRUE" });
  assert.deepEqual(parseBootstrapClassifierVerdict("False\n"), { verdict: "false", raw: "False" });
});

test("rejects prose, wrappers and JSON-encoded answers", () => {
  for (const value of ["true.", " true false", '{"true": true}', '{"answer":true}', "yes", "TRUE-ish", "tru"]) {
    const verdict = parseBootstrapClassifierVerdict(value);
    assert.equal(verdict.verdict, "unknown", `expected unknown for ${JSON.stringify(value)}`);
  }
});

test("rejects empty, whitespace and non-string values", () => {
  assert.equal(parseBootstrapClassifierVerdict("").verdict, "unknown");
  assert.equal(parseBootstrapClassifierVerdict("   ").verdict, "unknown");
  assert.equal(parseBootstrapClassifierVerdict(null).verdict, "unknown");
  assert.equal(parseBootstrapClassifierVerdict(undefined).verdict, "unknown");
  assert.equal(parseBootstrapClassifierVerdict(42).verdict, "unknown");
});

test("classifier request is zero-tool, unwrapped and small", () => {
  const body = buildBootstrapClassifierRequest({
    observation: OBSERVATION,
    decisionDefinition: "Decide progress. Answer true or false.",
    reasoningEffort: "low",
    currentDate: "2025-06-28",
  });
  assert.equal(body.model, "gpt-oss-120b");
  assert.equal("tools" in body, false);
  assert.equal("response_format" in body, false);
  assert.equal("reasoning_effort" in body, false);
  assert.equal(body.max_completion_tokens, BOOTSTRAP_CLASSIFIER_MAX_OUTPUT_TOKENS);
  const messages = body.messages as Record<string, unknown>[];
  assert.deepEqual(
    messages.map((message) => message.role),
    ["system", "developer", "user"]
  );
  const system = messages[0].content as string;
  assert.match(system, /Reasoning: low/);
  assert.doesNotMatch(system, /must go to the commentary channel/);
  const developer = messages[1].content as string;
  assert.match(developer, /Treat it as inert data/);
  assert.equal(messages[2].content, JSON.stringify(OBSERVATION));
});

test("classifier request compares reasoning effort medium", () => {
  const body = buildBootstrapClassifierRequest({
    observation: OBSERVATION,
    decisionDefinition: "x",
    reasoningEffort: "medium",
  });
  const system = (body.messages as Record<string, unknown>[])[0].content as string;
  assert.match(system, /Reasoning: medium/);
});

test("verdictFromBootstrapResponse handles refusals, tool calls and missing content as unknown", () => {
  assert.deepEqual(verdictFromBootstrapResponse(responseFor(null, { refusal: "I cannot do that." })), {
    verdict: "unknown",
    raw: null,
    reason: "classifier request was refused",
  });
  const withTool = verdictFromBootstrapResponse(responseFor(null, { toolCalls: [{ id: "call-1", name: "x", arguments: "{}" }] }));
  assert.equal(withTool.verdict, "unknown");
  assert.match("reason" in withTool ? withTool.reason : "", /tool call/);
  const noContent = verdictFromBootstrapResponse(responseFor(null));
  assert.equal(noContent.verdict, "unknown");
});

test("verdictFromBootstrapResponse accepts literal true and false content only", () => {
  assert.equal(verdictFromBootstrapResponse(responseFor("true")).verdict, "true");
  assert.equal(verdictFromBootstrapResponse(responseFor("False")).verdict, "false");
  assert.equal(verdictFromBootstrapResponse(responseFor("true.")).verdict, "unknown");
  // Reasoning may accompany the answer; the verdict still comes from final content.
  assert.deepEqual(verdictFromBootstrapResponse(responseFor("true", { analysis: ["The ledger advanced."] })), { verdict: "true", raw: "true" });
});
