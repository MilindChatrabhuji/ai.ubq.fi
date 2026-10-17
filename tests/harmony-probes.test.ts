import { test } from "bun:test";
import assert from "node:assert/strict";

import { createCerebrasTransport, type HarmonyTransport } from "../src/harmony/adapter.ts";
import { createProbeContext, user } from "../src/harmony/probes.ts";
import { PROBE_SCENARIOS } from "../src/harmony/probe-scenarios.ts";

type WireMessage = Record<string, unknown> & { role: string; content?: unknown };

const scriptedCompletion = (message: Record<string, unknown>, finishReason = "stop"): string =>
  JSON.stringify({
    id: "cmpl-scripted",
    object: "chat.completion",
    created: 1,
    model: "gpt-oss-120b",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  });

const errorResponse = (code: string, message: string): string => JSON.stringify({ error: { code, message } });

const scriptedPayloadOf = (body: Record<string, unknown>, messages: readonly WireMessage[]): string => {
  if (String(body.max_completion_tokens) === "128") return scriptedCompletion({ content: "true", reasoning_content: "The ledger advanced." });
  if (messages.some((message) => message.role === "assistant" && "reasoning_content" in message)) {
    return errorResponse("invalid_request_error", "messages.1.assistant.reasoning_content is unsupported");
  }
  if (mixedStrictnessOf(body)) return errorResponse("invalid_request_error", "Tools with mixed values for 'strict' are not allowed");
  if (toolsWithFormatOf(body)) return errorResponse("invalid_request_error", "Unsupported: tools with response_format");
  if (hasToolResult(messages)) return scriptedCompletion({ content: "San Francisco is sunny today.", reasoning_content: "Summarize the weather." });
  if (!toolsOf(body)) {
    return responseFormatsOf(body)
      ? scriptedCompletion({ content: '{"answer": 4}' })
      : scriptedCompletion({ content: "4", reasoning_content: "Simple arithmetic." });
  }
  const toolCallCount = promptOf(messages).includes("twice") ? 2 : 1;
  const calls =
    toolCallCount === 2
      ? [
          { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"location":"San Francisco"}' } },
          { id: "call_b", type: "function", function: { name: "get_weather", arguments: '{"location":"Tokyo"}' } },
        ]
      : [{ id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"location":"San Francisco"}' } }];
  return scriptedCompletion(
    { content: null, reasoning_content: toolCallCount === 2 ? undefined : "Private chain of thought.", tool_calls: calls },
    "tool_calls"
  );
};

const scriptedTransport = (): { transport: HarmonyTransport; bodies: Record<string, unknown>[] } => {
  const bodies: Record<string, unknown>[] = [];
  const transport: HarmonyTransport = (body) => {
    bodies.push(body);
    const messages = Array.isArray(body.messages) ? (body.messages as WireMessage[]) : [];
    const payload = scriptedPayloadOf(body, messages);
    const status = payload.startsWith('{"error"') ? 400 : 200;
    return Promise.resolve(
      new Response(payload, {
        status,
        headers: { "Content-Type": "application/json" },
      })
    );
  };
  return { transport, bodies };
};

const promptOf = (messages: readonly WireMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index].content;
    if (messages[index].role === "user" && typeof content === "string") return content;
  }
  return "";
};

const mixedStrictnessOf = (body: Record<string, unknown>): boolean => {
  if (!Array.isArray(body.tools)) return false;
  const values = body.tools.map((tool) => {
    const fn = tool && typeof tool === "object" ? (tool as Record<string, unknown>).function : undefined;
    return fn && typeof fn === "object" ? (fn as Record<string, unknown>).strict : undefined;
  });
  return new Set(values).size > 1;
};

const toolsWithFormatOf = (body: Record<string, unknown>): boolean => Array.isArray(body.tools) && body.response_format !== undefined;

const toolsOf = (body: Record<string, unknown>): boolean => {
  if (Array.isArray(body.tools)) return true;
  const messages = Array.isArray(body.messages) ? (body.messages as WireMessage[]) : [];
  return messages.some((message) => message.role === "developer" && typeof message.content === "string" && message.content.includes("namespace functions"));
};

const hasToolResult = (messages: readonly WireMessage[]): boolean =>
  messages.some((message) => message.role === "tool") ||
  messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("Tool result from"));

const responseFormatsOf = (body: Record<string, unknown>): boolean => {
  if (body.response_format !== undefined) return true;
  const messages = Array.isArray(body.messages) ? (body.messages as WireMessage[]) : [];
  return messages.some((message) => message.role === "developer" && typeof message.content === "string" && message.content.includes("# Response Formats"));
};

test("the manifest covers every required protocol question exactly once", () => {
  const ids = PROBE_SCENARIOS.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    [...new Set(PROBE_SCENARIOS.map((scenario) => scenario.group))].sort((left, right) => left.localeCompare(right)),
    ["classifier", "parallel", "reasoning", "replay", "strictness", "structured", "tools"]
  );
  const byId = new Map(PROBE_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  for (const requiredId of [
    "reasoning.effort.low",
    "reasoning.effort.medium",
    "reasoning.effort.high",
    "reasoning.replay.after-final",
    "reasoning.replay.echo",
    "tools.generic.sequence",
    "tools.native.sequence",
    "tools.native.user-result",
    "tools.generic.consecutive",
    "strictness.mixed",
    "strictness.all-false",
    "strictness.all-true",
    "structured.json-object",
    "structured.json-schema",
    "structured.native-formats",
    "structured.with-tools",
    "parallel.native",
    "parallel.generic-flag",
    "classifier.low",
    "classifier.medium",
  ]) {
    assert.ok(byId.has(requiredId), `missing scenario ${requiredId}`);
  }
  assert.ok(byId.get("classifier.low")?.style === "classifier");
  assert.ok(byId.get("tools.native.sequence")?.style === "native");
  assert.ok(byId.get("tools.generic.sequence")?.style === "generic");
});

test("reasoning effort probe runs deterministically through the fake transport", async () => {
  const { transport } = scriptedTransport();
  const ctx = createProbeContext(transport, () => new Date(0));
  const scenario = PROBE_SCENARIOS.find((candidate) => candidate.id === "reasoning.effort.low");
  assert.ok(scenario);
  const result = await scenario.run(ctx);
  assert.equal(result.outcome, "ok");
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].response?.reasoningPresent, true);
  assert.equal(result.turns[0].response.reasoningChars, 18); // "Simple arithmetic."
  assert.equal(result.turns[0].response.contentPreview, "4");
  assert.deepEqual(result.turns[0].request?.roles, ["user"]);
  assert.equal(result.durationMs, 0);
});

test("native probe records the projected Cerebras message roles", async () => {
  let wireRoles: unknown[] = [];
  const transport = createCerebrasTransport({
    apiKey: "test-key",
    fetcher: (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (Array.isArray(body.messages)) {
        wireRoles = body.messages.map((message) => (message as Record<string, unknown>).role);
      }
      const payload = scriptedCompletion({ content: "done" });
      const response = new Response(payload, { status: 200, headers: { "Content-Type": "application/json" } });
      return Promise.resolve(response);
    },
  });
  const ctx = createProbeContext(transport, () => new Date(0));
  const result = await ctx.runTurn(user("hello"), { style: "native" });

  assert.equal(result.record.outcome, "ok");
  assert.deepEqual(wireRoles, ["system", "user"]);
  assert.deepEqual(result.record.request?.roles, ["system", "user"]);
});

test("generic tool sequence reproduces call/result shape and replays the result", async () => {
  const { transport, bodies } = scriptedTransport();
  const ctx = createProbeContext(transport, () => new Date(0));
  const scenario = PROBE_SCENARIOS.find((candidate) => candidate.id === "tools.generic.sequence");
  assert.ok(scenario);
  const result = await scenario.run(ctx);
  assert.equal(result.outcome, "ok");
  const [first, second] = result.turns;
  assert.equal(first.response?.toolCalls.length, 1);
  assert.equal(first.response.toolCalls[0].name, "get_weather");
  assert.equal(first.response.toolCalls[0].argumentsJsonValid, true);
  assert.equal(second.response?.contentPresent, true);
  // The second request replays assistant tool_calls plus a tool result, never reasoning.
  const secondMessages = bodies[1].messages as Record<string, unknown>[];
  assert.deepEqual(
    secondMessages.map((message) => message.role),
    ["user", "assistant", "tool"]
  );
  assert.deepEqual(secondMessages[1].tool_calls, [
    { id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"location":"San Francisco"}' } },
  ]);
  assert.ok(!JSON.stringify(bodies[1]).includes("Private chain of thought"));
});

test("mixed strictness probe records the upstream rejection and matches its expectation", async () => {
  const { transport } = scriptedTransport();
  const ctx = createProbeContext(transport, () => new Date(0));
  const scenario = PROBE_SCENARIOS.find((candidate) => candidate.id === "strictness.mixed");
  assert.ok(scenario);
  const result = await scenario.run(ctx);
  assert.equal(result.outcome, "upstream_rejected");
  assert.equal(result.outcome, result.expectedOutcome);
  assert.equal(result.turns[0].status, 400);
  assert.match(result.turns[0].upstreamError?.message ?? "", /mixed values/);
});

test("structured output with tools is recorded without being normalized away", async () => {
  const { transport } = scriptedTransport();
  const ctx = createProbeContext(transport, () => new Date(0));
  const scenario = PROBE_SCENARIOS.find((candidate) => candidate.id === "structured.with-tools");
  assert.ok(scenario);
  const result = await scenario.run(ctx);
  assert.equal(result.outcome, "upstream_rejected");
  assert.equal(result.turns[0].request?.responseFormat, "json_schema");
});

test("classifier probe returns a literal true verdict", async () => {
  const { transport } = scriptedTransport();
  const ctx = createProbeContext(transport, () => new Date(0));
  const scenario = PROBE_SCENARIOS.find((candidate) => candidate.id === "classifier.low");
  assert.ok(scenario);
  const result = await scenario.run(ctx);
  assert.equal(result.outcome, "ok");
  assert.deepEqual(result.verdict, { verdict: "true", raw: "true" });
});

test("the native tool result replay is sent as a user message in the user-role variant", async () => {
  const { transport, bodies } = scriptedTransport();
  const ctx = createProbeContext(transport, () => new Date(0));
  const scenario = PROBE_SCENARIOS.find((candidate) => candidate.id === "tools.native.user-result");
  assert.ok(scenario);
  const result = await scenario.run(ctx);
  assert.equal(result.outcome, "ok");
  const secondMessages = bodies[1].messages as Record<string, unknown>[];
  // [system, developer, user prompt, assistant tool call, user-rendered result]
  assert.deepEqual(
    secondMessages.map((message) => message.role),
    ["system", "developer", "user", "assistant", "user"]
  );
  assert.match(String(secondMessages[4].content), /^Tool result from get_weather:\n/);
});

test("probe results are sanitized: no prompts, reasoning, keys or observation data", async () => {
  const { transport } = scriptedTransport();
  const ctx = createProbeContext(transport, () => new Date(0));
  const results = [];
  for (const scenario of PROBE_SCENARIOS) {
    results.push(await scenario.run(ctx));
  }
  const serialized = JSON.stringify(results);
  for (const forbidden of [
    "Private chain of thought",
    "The ledger advanced.",
    "What is 2 + 2?",
    "Call get_weather with location San Francisco",
    "probe-run-42",
    "secret-api-key",
    '"location":"San Francisco"',
  ]) {
    assert.ok(!serialized.includes(forbidden), `probe output leaked ${forbidden}`);
  }
  for (const result of results) {
    for (const turn of result.turns) {
      assert.ok((turn.response?.contentPreview?.length ?? 0) <= 120);
      assert.equal(turn.request?.model, "gpt-oss-120b");
      if (turn.request.style === "classifier") {
        assert.equal(turn.request.tools, null);
        assert.equal(turn.request.responseFormat, "none");
        assert.equal(turn.request.maxCompletionTokens, 128);
      }
    }
  }
});

test("the full manifest completes under the scripted transport with no harness failures", async () => {
  const { transport } = scriptedTransport();
  const ctx = createProbeContext(transport, () => new Date(0));
  for (const scenario of PROBE_SCENARIOS) {
    const result = await scenario.run(ctx);
    assert.ok(result.outcome !== "failed", `scenario ${scenario.id} failed: ${result.failure}`);
    assert.ok(result.failure === null, `scenario ${scenario.id} reported a failure`);
  }
});
