import { test } from "bun:test";
import assert from "node:assert/strict";

import type { HarmonyTransport } from "../src/harmony/adapter.ts";
import { argsJsonValid, createProbeContext, type ProbeTurnRun, user, WEATHER_TOOL } from "../src/harmony/probes.ts";
import { HarmonyAdapterError } from "../src/harmony/types.ts";

type Reply = Readonly<{ payload: string; status?: number; contentType?: string }> | Readonly<{ reject: string }>;

/** Deterministic transport: one scripted reply per call, in order. */
const scriptedTransport = (replies: readonly Reply[]): Readonly<{ transport: HarmonyTransport; bodies: Record<string, unknown>[] }> => {
  const bodies: Record<string, unknown>[] = [];
  const queue = [...replies];
  const transport: HarmonyTransport = (body) => {
    bodies.push(body);
    const reply = queue.shift();
    if (!reply) return Promise.reject(new Error("scripted transport exhausted"));
    if ("reject" in reply) return Promise.reject(new Error(reply.reject));
    return Promise.resolve(
      new Response(reply.payload, {
        status: reply.status ?? 200,
        headers: { "Content-Type": reply.contentType ?? "application/json" },
      })
    );
  };
  return { transport, bodies };
};

const completion = (message: Record<string, unknown>, finishReason = "stop"): string =>
  JSON.stringify({
    id: "cmpl-coverage",
    object: "chat.completion",
    created: 1,
    model: "gpt-oss-120b",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });

const errorBody = (code: string, message: string): string => JSON.stringify({ code, message });

const contextOf = (replies: readonly Reply[]): Readonly<{ ctx: ReturnType<typeof createProbeContext>; bodies: Record<string, unknown>[] }> => {
  const { transport, bodies } = scriptedTransport(replies);
  return { ctx: createProbeContext(transport, () => new Date(0)), bodies };
};

const classifierOptions = {
  observation: {
    runId: "probe-run-42",
    generation: 3,
    phase: "verify",
    milestone: "m01",
    failureFingerprint: null,
    gitSha: null,
    ledgerVersion: null,
    retryState: null,
    verificationEvidence: null,
  },
  decisionDefinition: "Answer true when the run has advanced.",
  reasoningEffort: "low",
} as const;

test("argsJsonValid reports malformed tool arguments instead of throwing", () => {
  assert.equal(argsJsonValid('{"location":"San Francisco"}'), true);
  assert.equal(argsJsonValid("4"), true);
  assert.equal(argsJsonValid(""), false);
  assert.equal(argsJsonValid('{"location":'), false);
  assert.equal(argsJsonValid("undefined"), false);
});

test("a raw probe summarizes a malformed wire body without leaking unknown shapes", async () => {
  const body: Record<string, unknown> = {
    model: 7,
    messages: [
      null,
      "not-a-message",
      { role: 42 },
      { role: null },
      {},
      { role: { kind: "assistant" } },
      { role: "user", content: "hello", tool_calls: [] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_a" }] },
      { role: "tool", content: "result" },
    ],
    tools: ["not-a-tool", {}, { function: "not-a-function" }, { function: { name: "get_weather", strict: true } }, { function: { strict: 1 } }],
    reasoning_effort: 9,
    response_format: { type: "json_object" },
    parallel_tool_calls: true,
    max_completion_tokens: 256,
  };
  const { ctx, bodies } = contextOf([{ payload: completion({ content: "done" }) }]);
  const run = await ctx.runRaw(body);

  assert.deepEqual(bodies, [body]);
  assert.equal(run.record.outcome, "ok");
  assert.equal(run.record.status, 200);
  assert.equal(run.record.durationMs, 0);
  const request = run.record.request;
  assert.ok(request);
  assert.equal(request.style, "generic");
  assert.equal(request.model, "?");
  assert.deepEqual(request.roles, ["?", "?", "42", "?", "?", '{"kind":"assistant"}', "user", "assistant", "tool"]);
  assert.deepEqual(request.tools, [
    { name: "get_weather", strict: true },
    { name: "?", strict: null },
  ]);
  assert.deepEqual(request.toolStrictnessValues, [true, false]);
  assert.equal(request.reasoningEffortTopLevel, null);
  assert.equal(request.reasoningInSystem, false);
  assert.equal(request.responseFormat, "json_object");
  assert.equal(request.parallelToolCalls, true);
  assert.equal(request.maxCompletionTokens, 256);
  assert.equal(request.analysisInWire, true);
  assert.equal(request.assistantToolTurns, 2);
  assert.equal(request.toolResultTurns, 1);
  assert.equal(run.record.adapterError, null);
  assert.equal(run.normalized?.content, "done");
});

test("a raw probe with no usable tools or messages summarizes an empty request", async () => {
  const body: Record<string, unknown> = { model: "gpt-oss-120b", messages: "nope", tools: [], parallel_tool_calls: "yes" };
  const { ctx } = contextOf([{ payload: completion({ content: "ok" }) }]);
  const run = await ctx.runRaw(body);

  assert.equal(run.record.outcome, "ok");
  const request = run.record.request;
  assert.ok(request);
  assert.deepEqual(request.roles, []);
  assert.equal(request.tools, null);
  assert.deepEqual(request.toolStrictnessValues, []);
  assert.equal(request.parallelToolCalls, null);
  assert.equal(request.maxCompletionTokens, null);
  assert.equal(request.responseFormat, "none");
  assert.equal(request.analysisInWire, false);
  assert.equal(request.assistantToolTurns, 0);
  assert.equal(request.toolResultTurns, 0);
});

test("a raw probe reads every structured-output wrapper as probe vocabulary", async () => {
  const replies: Reply[] = [
    { payload: completion({ content: "a" }) },
    { payload: completion({ content: "b" }) },
    { payload: completion({ content: "c" }) },
    { payload: completion({ content: "d" }) },
  ];
  const { ctx } = contextOf(replies);
  const formats: (string | undefined)[] = [];
  for (const responseFormat of [{ type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } }, "json_object", null, { type: "text" }]) {
    const run = await ctx.runRaw({ model: "gpt-oss-120b", response_format: responseFormat });
    formats.push(run.record.request?.responseFormat);
  }
  assert.deepEqual(formats, ["json_schema", "none", "none", "none"]);
});

test("a raw probe records a non-JSON success as a failed turn", async () => {
  const { ctx } = contextOf([{ payload: "<html>gateway</html>", contentType: "text/html" }]);
  const run = await ctx.runRaw({ model: "gpt-oss-120b" });

  assert.equal(run.record.outcome, "failed");
  assert.equal(run.record.status, 200);
  assert.equal(run.record.response, null);
  assert.equal(run.record.upstreamError, null);
  assert.deepEqual(run.record.adapterError, { code: "non_json", message: "upstream reply is not JSON" });
  assert.equal(run.normalized, null);
  assert.equal(run.verdict, null);
});

test("a raw probe reports an unnormalizable completion with the adapter error", async () => {
  const { ctx } = contextOf([{ payload: JSON.stringify({ id: "cmpl-coverage", created: 1, model: "gpt-oss-120b", choices: [] }) }]);
  const run = await ctx.runRaw({ model: "gpt-oss-120b" });

  assert.equal(run.record.outcome, "failed");
  assert.equal(run.record.status, 200);
  const adapterError = run.record.adapterError;
  assert.ok(adapterError);
  assert.equal(adapterError.code, "normalization_error");
  assert.equal(adapterError.message, "upstream reply has no choices");
  assert.equal(run.record.response, null);
  assert.equal(run.normalized, null);
});

test("a raw probe summary counts content, reasoning, refusal and tool-call validity", async () => {
  const longContent = "x".repeat(200);
  const { ctx } = contextOf([
    {
      payload: completion(
        {
          content: longContent,
          reasoning_content: "Because.",
          refusal: "cannot help",
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"location":"San Francisco"}' } },
            { id: "call_b", type: "function", function: { name: "get_weather", arguments: '{"location":' } },
          ],
        },
        "tool_calls"
      ),
    },
  ]);
  const run = await ctx.runRaw({ model: "gpt-oss-120b" });
  const response = run.record.response;

  assert.equal(run.record.outcome, "ok");
  assert.ok(response);
  assert.equal(response.contentPresent, true);
  assert.equal(response.contentChars, 200);
  assert.equal(response.contentPreview, "x".repeat(120));
  assert.equal(response.reasoningPresent, true);
  assert.equal(response.reasoningChars, 8);
  assert.equal(response.refusal, true);
  assert.equal(response.finishReason, "tool_calls");
  assert.deepEqual(response.toolCalls, [
    { id: "call_a", name: "get_weather", argumentsChars: 28, argumentsJsonValid: true },
    { id: "call_b", name: "get_weather", argumentsChars: 12, argumentsJsonValid: false },
  ]);
  assert.equal(run.record.state, null);
});

test("a raw probe reports an upstream rejection with its sanitized error", async () => {
  const { ctx } = contextOf([{ payload: errorBody("invalid_request_error", "unsupported tools"), status: 400 }]);
  const run = await ctx.runRaw({ model: "gpt-oss-120b" });

  assert.equal(run.record.outcome, "upstream_rejected");
  assert.equal(run.record.status, 400);
  assert.deepEqual(run.record.upstreamError, { code: "invalid_request_error", message: "unsupported tools" });
  assert.equal(run.record.response, null);
  assert.equal(run.normalized, null);
});

test("a raw probe reports an upstream server error and a non-JSON error body", async () => {
  const { ctx } = contextOf([
    { payload: errorBody("overloaded", "try later"), status: 503 },
    { payload: "gateway timeout", status: 504, contentType: "text/plain" },
  ]);

  const unavailable = await ctx.runRaw({ model: "gpt-oss-120b" });
  assert.equal(unavailable.record.outcome, "upstream_error");
  assert.equal(unavailable.record.status, 503);
  assert.deepEqual(unavailable.record.upstreamError, { code: "overloaded", message: "try later" });

  const noBody = await ctx.runRaw({ model: "gpt-oss-120b" });
  assert.equal(noBody.record.outcome, "upstream_error");
  assert.equal(noBody.record.status, 504);
  assert.deepEqual(noBody.record.upstreamError, { code: null, message: null });
});

test("a raw probe records a transport failure with the request summary intact", async () => {
  const { ctx } = contextOf([{ reject: "socket hang up" }]);
  const run = await ctx.runRaw({ model: "gpt-oss-120b", messages: [{ role: "user", content: "hi" }] });

  assert.equal(run.record.outcome, "failed");
  assert.equal(run.record.status, null);
  assert.equal(run.record.request?.model, "gpt-oss-120b");
  assert.equal(run.record.response, null);
  assert.deepEqual(run.record.adapterError, { code: "probe_error", message: "Error: socket hang up" });
  assert.equal(run.normalized, null);
});

test("a normalized turn of a scripted conversation reports ok with its state snapshot", async () => {
  const { ctx, bodies } = contextOf([
    {
      payload: completion(
        {
          content: null,
          reasoning_content: "Call the tool.",
          tool_calls: [{ id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"location":"Tokyo"}' } }],
        },
        "tool_calls"
      ),
    },
  ]);
  const run = await ctx.runTurn(user("What is the weather?"), { style: "generic", tools: [WEATHER_TOOL] });

  assert.equal(run.record.outcome, "ok");
  assert.equal(run.record.status, 200);
  const request = run.record.request;
  assert.ok(request);
  assert.equal(request.style, "generic");
  assert.deepEqual(request.tools, [{ name: "get_weather", strict: false }]);
  assert.deepEqual(run.record.state, { analysisLines: 0, analysisAfterDrop: 0, pendingToolCalls: 0, completedFinal: false });
  assert.equal(run.normalized?.toolCalls[0]?.name, "get_weather");
  assert.equal(run.record.response?.toolCalls[0]?.argumentsJsonValid, true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.model, "gpt-oss-120b");
});

test("a turn whose upstream reply is not JSON fails with a normalization error", async () => {
  const { ctx } = contextOf([{ payload: "not json", contentType: "text/plain" }]);
  const run = await ctx.runTurn(user("hello"), { style: "generic" });

  assert.equal(run.record.outcome, "failed");
  assert.equal(run.record.status, 200);
  assert.equal(run.record.request?.model, "gpt-oss-120b");
  assert.deepEqual(run.record.adapterError, { code: "normalization_error", message: "upstream reply is not JSON" });
  assert.equal(run.normalized, null);
  assert.equal(run.record.response, null);
  assert.deepEqual(run.record.state, { analysisLines: 0, analysisAfterDrop: 0, pendingToolCalls: 0, completedFinal: false });
});

test("a turn records every upstream rejection and an unexplained failure", async () => {
  const { ctx } = contextOf([
    { payload: errorBody("invalid_request_error", "unsupported"), status: 400 },
    { payload: errorBody("overloaded", "later"), status: 503 },
    { payload: "gateway said no", status: 502, contentType: "text/html" },
  ]);

  const rejected = await ctx.runTurn(user("hello"), { style: "generic" });
  assert.equal(rejected.record.outcome, "upstream_rejected");
  assert.equal(rejected.record.status, 400);
  assert.deepEqual(rejected.record.upstreamError, { code: "invalid_request_error", message: "unsupported" });
  assert.equal(rejected.record.adapterError, null);
  assert.equal(rejected.record.response, null);

  const unavailable = await ctx.runTurn(user("hello"), { style: "generic" });
  assert.equal(unavailable.record.outcome, "upstream_error");
  assert.equal(unavailable.record.status, 503);
  assert.deepEqual(unavailable.record.upstreamError, { code: "overloaded", message: "later" });

  const unexplained = await ctx.runTurn(user("hello"), { style: "generic" });
  assert.equal(unexplained.record.outcome, "failed");
  assert.equal(unexplained.record.status, 502);
  assert.equal(unexplained.record.upstreamError, null);
  assert.deepEqual(unexplained.record.adapterError, { code: "normalization_error", message: "unknown" });
  assert.equal(unexplained.normalized, null);
});

test("a raw probe reads a top-level reasoning effort and defaults its clock", async () => {
  const { transport } = scriptedTransport([{ payload: completion({ content: "ok" }) }]);
  const ctx = createProbeContext(transport);

  assert.ok(ctx.now() instanceof Date);
  assert.ok(Math.abs(ctx.now().getTime() - Date.now()) < 60_000);
  const run = await ctx.runRaw({ model: "gpt-oss-120b", reasoning_effort: "high" });
  assert.equal(run.record.request?.reasoningEffortTopLevel, "high");
  assert.equal(run.record.outcome, "ok");
});

test("a request the adapter refuses is recorded as an adapter error turn", async () => {
  const { ctx, bodies } = contextOf([{ payload: completion({ content: "unused" }) }]);
  const run = await ctx.runTurn(user("hello"), { style: "generic", tools: [WEATHER_TOOL], responseFormat: { type: "json_object" } });

  assert.equal(run.record.outcome, "adapter_error");
  assert.equal(run.record.status, null);
  assert.equal(run.record.request, null);
  const adapterError = run.record.adapterError;
  assert.deepEqual(adapterError, {
    code: "unproven-combination",
    message: "Combining tools with a structured response format is not proven for gpt-oss-120b; use combinationPolicy 'probe' only for protocol evidence.",
  });
  assert.equal(run.normalized, null);
  assert.equal(bodies.length, 0);
  assert.deepEqual(run.record.state, { analysisLines: 0, analysisAfterDrop: 0, pendingToolCalls: 0, completedFinal: false });
});

test("a turn whose transport rejects fails without an adapter code", async () => {
  const { ctx } = contextOf([{ reject: "connection reset" }]);
  const run = await ctx.runTurn(user("hello"), { style: "generic" });

  assert.equal(run.record.outcome, "failed");
  assert.equal(run.record.status, null);
  assert.equal(run.record.request, null);
  assert.deepEqual(run.record.adapterError, { code: "probe_error", message: "Error: connection reset" });
  assert.equal(run.normalized, null);
  assert.equal(run.verdict, null);
});

test("a classifier rejection yields an unknown verdict and no normalized response", async () => {
  const { ctx, bodies } = contextOf([{ payload: errorBody("invalid_request_error", "unknown model"), status: 400 }]);
  const run = await ctx.runClassifier(classifierOptions);

  assert.equal(run.record.outcome, "upstream_rejected");
  assert.equal(run.record.status, 400);
  assert.deepEqual(run.record.upstreamError, { code: "invalid_request_error", message: "unknown model" });
  const request = run.record.request;
  assert.ok(request);
  assert.equal(request.style, "classifier");
  assert.equal(request.model, "gpt-oss-120b");
  assert.equal(request.maxCompletionTokens, 128);
  assert.deepEqual(run.record.notes, ["verdict=unknown"]);
  assert.deepEqual(run.verdict, { verdict: "unknown", raw: null, reason: "classifier request rejected with status 400" });
  assert.equal(run.record.verdict, run.verdict);
  assert.equal(run.normalized, null);
  assert.equal(run.record.state, null);
  assert.equal(bodies.length, 1);
});

test("a classifier upstream failure is an upstream error outcome", async () => {
  const { ctx } = contextOf([{ payload: errorBody("internal_error", "boom"), status: 500 }]);
  const run = await ctx.runClassifier(classifierOptions);

  assert.equal(run.record.outcome, "upstream_error");
  assert.equal(run.record.status, 500);
  assert.equal(run.verdict?.verdict, "unknown");
});

test("a classifier reply that is not JSON fails closed with an unknown verdict", async () => {
  const { ctx } = contextOf([{ payload: "<html>", contentType: "text/html" }]);
  const run = await ctx.runClassifier(classifierOptions);

  assert.equal(run.record.outcome, "failed");
  assert.equal(run.record.status, 200);
  assert.deepEqual(run.record.adapterError, { code: "non_json", message: "upstream reply is not JSON" });
  assert.deepEqual(run.verdict, { verdict: "unknown", raw: null, reason: "classifier reply is not JSON" });
  assert.deepEqual(run.record.notes, ["verdict=unknown"]);
  assert.equal(run.normalized, null);
  assert.equal(run.record.state, null);
});

test("an invalid classifier completion fails closed with the normalization reason", async () => {
  const { ctx } = contextOf([{ payload: JSON.stringify({ id: "cmpl", created: 1, model: "gpt-oss-120b", choices: [] }) }]);
  const run = await ctx.runClassifier(classifierOptions);

  assert.equal(run.record.outcome, "failed");
  assert.deepEqual(run.record.adapterError, { code: "normalization_error", message: "upstream reply has no choices" });
  assert.deepEqual(run.verdict, { verdict: "unknown", raw: null, reason: "classifier reply is invalid: upstream reply has no choices" });
  assert.deepEqual(run.record.notes, ["verdict=unknown"]);
  assert.equal(run.normalized, null);
});

test("a classifier transport failure fails closed with a probe error", async () => {
  const { ctx } = contextOf([{ reject: "dns lookup failed" }]);
  const run = await ctx.runClassifier(classifierOptions);

  assert.equal(run.record.outcome, "failed");
  assert.equal(run.record.status, null);
  assert.deepEqual(run.record.adapterError, { code: "probe_error", message: "Error: dns lookup failed" });
  assert.deepEqual(run.verdict, { verdict: "unknown", raw: null, reason: "classifier transport failed: Error: dns lookup failed" });
  assert.deepEqual(run.record.notes, ["verdict=unknown"]);
  const request = run.record.request;
  assert.ok(request);
  assert.equal(request.assistantToolTurns, 0);
  assert.equal(request.toolResultTurns, 0);
  assert.equal(request.analysisInWire, false);
});

test("a classifier answer is parsed into a literal verdict", async () => {
  const { ctx } = contextOf([
    { payload: completion({ content: "true", reasoning_content: "Decided yes." }) },
    { payload: completion({ content: " FALSE " }) },
    { payload: completion({ content: "maybe" }) },
    { payload: completion({ content: null, refusal: "no" }) },
    {
      payload: completion(
        { content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
        "tool_calls"
      ),
    },
    { payload: completion({ content: null, reasoning_content: "Only reasoning." }) },
  ]);

  const affirmed = await ctx.runClassifier(classifierOptions);
  assert.equal(affirmed.record.outcome, "ok");
  assert.deepEqual(affirmed.verdict, { verdict: "true", raw: "true" });
  assert.deepEqual(affirmed.record.notes, ["verdict=true"]);
  assert.equal(affirmed.normalized?.content, "true");
  assert.equal(affirmed.record.response?.reasoningPresent, true);

  const denied = await ctx.runClassifier(classifierOptions);
  assert.deepEqual(denied.verdict, { verdict: "false", raw: "FALSE" });
  assert.deepEqual(denied.record.notes, ["verdict=false"]);

  const ambiguous = await ctx.runClassifier(classifierOptions);
  assert.deepEqual(ambiguous.verdict, { verdict: "unknown", raw: "maybe", reason: "classifier final content is not exactly 'true' or 'false'" });

  const refused = await ctx.runClassifier(classifierOptions);
  assert.deepEqual(refused.verdict, { verdict: "unknown", raw: null, reason: "classifier request was refused" });

  const called = await ctx.runClassifier(classifierOptions);
  assert.deepEqual(called.verdict, { verdict: "unknown", raw: null, reason: "classifier emitted a tool call" });

  const reasoningOnly = await ctx.runClassifier(classifierOptions);
  assert.deepEqual(reasoningOnly.verdict, {
    verdict: "unknown",
    raw: null,
    reason: "classifier produced only reasoning and no final content",
  });
});

test("a probe context exposes the injected transport and clock", async () => {
  const { transport, bodies } = scriptedTransport([{ payload: completion({ content: "ok" }) }]);
  const now = (): Date => new Date(1_700_000_000_000);
  const ctx = createProbeContext(transport, now);

  assert.equal(ctx.transport, transport);
  assert.equal(ctx.now().getTime(), 1_700_000_000_000);
  const run: ProbeTurnRun = await ctx.runRaw({ model: "gpt-oss-120b" });
  assert.equal(run.record.outcome, "ok");
  assert.equal(bodies.length, 1);
});

test("a raw probe reports an adapter refusal thrown by the transport as a probe error", async () => {
  const failing: HarmonyTransport = () => {
    throw new HarmonyAdapterError("simulated adapter refusal", "invalid-request");
  };
  const ctx = createProbeContext(failing, () => new Date(0));
  const run: ProbeTurnRun = await ctx.runRaw({ model: "gpt-oss-120b" });

  assert.equal(run.record.outcome, "failed");
  assert.equal(run.record.status, null);
  assert.deepEqual(run.record.adapterError, { code: "probe_error", message: "HarmonyAdapterError: simulated adapter refusal" });
  assert.equal(run.normalized, null);
});
