import { test } from "bun:test";
import assert from "node:assert/strict";
import { normalizeAnthropicChatResponsesResponse, toAnthropicChatResponsesUsage } from "../src/provider/anthropic-chat-responses.ts";
import { restoreAnthropicChatReplay, restoreAnthropicReplay } from "../src/provider/anthropic-replay.ts";
import { extractUsageTokens } from "../src/openai-telemetry.ts";
import { readResponsesStream, ResponsesStreamError } from "../src/responses-stream.ts";

type JsonRecord = Record<string, unknown>;
const model = "claude-opus-5.5";
const signedReasoning = { type: "reasoning.text", text: "Use the requested tool.", signature: "opaque-chat-signature", format: "provider-format", index: 0 };
const usage = {
  prompt_tokens: 1043,
  prompt_tokens_details: { cached_tokens: 1028, cache_write_tokens: 0 },
  completion_tokens: 58,
  completion_tokens_details: { reasoning_tokens: 54 },
  total_tokens: 1101,
  buyer_cost_micro: 285,
  cost: 0,
  cost_details: { upstream_inference_cost: 0.0014256 },
};
const completion = (assistant: JsonRecord, finish = "stop", measured: JsonRecord = usage): JsonRecord => ({
  id: "chatcmpl-native-123",
  object: "chat.completion",
  created: 1_790_000_000,
  model,
  choices: [{ index: 0, message: assistant, finish_reason: finish }],
  usage: measured,
});
const chunk = (delta: JsonRecord, finish: string | null = null): JsonRecord => ({
  id: "chatcmpl-stream-native",
  object: "chat.completion.chunk",
  created: 1_790_000_000,
  model,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const sse = (chunks: JsonRecord[], done = true): Response =>
  new Response(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), {
    headers: { "content-type": "text/event-stream" },
  });
const collect = async (response: Response): Promise<JsonRecord[]> => {
  assert.ok(response.body);
  const result: JsonRecord[] = [];
  for await (const event of readResponsesStream(response.body)) result.push(event.value);
  return result;
};
const terminal = (events: JsonRecord[]): JsonRecord => events.at(-1)?.response as JsonRecord;

test("Claude Chat Responses usage stays gross and retains exact cache and buyer cost provenance", () => {
  const projected = toAnthropicChatResponsesUsage(usage);
  assert.deepEqual(projected, {
    input_tokens: 1043,
    input_tokens_details: { cached_tokens: 1028, cache_write_tokens: 0 },
    output_tokens: 58,
    output_tokens_details: { reasoning_tokens: 54 },
    total_tokens: 1101,
    buyer_cost_micro: 285,
    cost: 0,
    cost_details: { upstream_inference_cost: 0.0014256 },
  });
  const measured = extractUsageTokens(projected);
  assert.ok(measured);
  assert.equal(measured.inputTokens, 1043);
  assert.equal(measured.cachedInputTokens, 1028);
  assert.equal(measured.cacheWriteInputTokens, 0);
});

test("Claude Chat Responses usage does not create zero counters or launder invalid measurements", () => {
  assert.deepEqual(toAnthropicChatResponsesUsage({ prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 }), {
    input_tokens: 15,
    output_tokens: 4,
    total_tokens: 19,
  });
  const projected = toAnthropicChatResponsesUsage({
    prompt_tokens: 15.5,
    completion_tokens: 4,
    total_tokens: 19.5,
    buyer_cost_micro: "69",
    prompt_tokens_details: { cached_tokens: -1 },
  });
  assert.equal(extractUsageTokens(projected)?.status, "invalid");
  assert.equal(projected?.buyer_cost_micro, "69");
});

test("Claude Chat Responses JSON emits reasoning and text without duplicating signed detail text", async () => {
  const assistant = { role: "assistant", content: "OK", reasoning_content: signedReasoning.text, reasoning_details: [signedReasoning] };
  const upstream = new Response(JSON.stringify(completion(assistant)), {
    headers: { "content-type": "application/json", "content-length": "999", "x-cost-micro": "285" },
  });
  const response = await normalizeAnthropicChatResponsesResponse(upstream, { model });
  const payload = await response.json();
  assert.equal(payload.status, "completed");
  assert.deepEqual(
    payload.output.map((item: JsonRecord) => item.type),
    ["reasoning", "message"]
  );
  assert.deepEqual(payload.output[0].summary, [{ type: "summary_text", text: signedReasoning.text }]);
  assert.equal(payload.output[1].content[0].text, "OK");
  assert.equal(payload.usage.input_tokens, 1043);
  assert.equal(payload.usage.buyer_cost_micro, 285);
  assert.equal(response.headers.get("x-cost-micro"), "285");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(JSON.stringify(payload).includes("opaque-chat-signature"), false);
  assert.equal(JSON.stringify(payload).includes("encrypted_content"), false);
});

test("Claude Chat Responses JSON privately restores the original signed Chat message", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const assistant = {
    role: "assistant",
    content: null,
    reasoning_content: signedReasoning.text,
    reasoning_details: [signedReasoning],
    tool_calls: [{ id: "call_weather", type: "function", function: { name: "weather", arguments: '{"city":"Paris"}' } }],
  };
  const response = await normalizeAnthropicChatResponsesResponse(new Response(JSON.stringify(completion(assistant, "tool_calls"))), {
    model,
    provider: "surplus",
    reasoningReplayScope: scope,
  });
  const payload = await response.json();
  assert.deepEqual(restoreAnthropicChatReplay(payload.output, { scope, provider: "surplus", model }), [{ type: "native_chat_assistant", message: assistant }]);
  assert.equal(restoreAnthropicReplay(payload.output, { scope, provider: "surplus", model }), null);
  assert.equal(restoreAnthropicChatReplay(payload.output, { scope: "another-principal", provider: "surplus", model }), null);
});

test("Claude Chat Responses respects summary none without losing private signed tool continuation", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const assistant = {
    role: "assistant",
    content: null,
    reasoning_details: [signedReasoning],
    tool_calls: [{ id: "call_clock", type: "function", function: { name: "clock", arguments: "{}" } }],
  };
  const response = await normalizeAnthropicChatResponsesResponse(new Response(JSON.stringify(completion(assistant, "tool_calls"))), {
    model,
    provider: "surplus",
    reasoningReplayScope: scope,
    reasoningSummary: "none",
  });
  const payload = await response.json();
  assert.deepEqual(
    payload.output.map((item: JsonRecord) => item.type),
    ["function_call"]
  );
  assert.deepEqual(restoreAnthropicChatReplay(payload.output, { scope, provider: "surplus", model }), [{ type: "native_chat_assistant", message: assistant }]);
  assert.equal(JSON.stringify(payload).includes(signedReasoning.text), false);
});

test("Claude Chat Responses JSON supports namespaced and freeform tools with exact private provenance", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const assistant = {
    role: "assistant",
    content: null,
    reasoning_details: [signedReasoning],
    tool_calls: [
      { id: "call_namespaced", type: "function", function: { name: "weather_wrapper", arguments: '{"city":"Paris"}' } },
      { id: "call_custom", type: "function", function: { name: "patch_wrapper", arguments: '{"input":"patch text"}' } },
    ],
  };
  const response = await normalizeAnthropicChatResponsesResponse(new Response(JSON.stringify(completion(assistant, "tool_calls"))), {
    model,
    provider: "surplus",
    reasoningReplayScope: scope,
    toolNames: new Map([
      ["weather_wrapper", { name: "weather", namespace: "functions" }],
      ["patch_wrapper", { name: "apply_patch", namespace: null }],
    ]),
    customToolNames: new Set(["patch_wrapper"]),
  });
  const payload = await response.json();
  assert.equal(payload.output[1].name, "weather");
  assert.equal(payload.output[1].namespace, "functions");
  assert.equal(payload.output[2].type, "custom_tool_call");
  assert.equal(payload.output[2].name, "apply_patch");
  assert.equal(payload.output[2].input, "patch text");
  assert.deepEqual(restoreAnthropicChatReplay(payload.output, { scope, provider: "surplus", model }), [{ type: "native_chat_assistant", message: assistant }]);
});

test("Claude Chat Max reasoning-only length completion is incomplete and retains cache/cost usage", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const capped = { ...usage, completion_tokens: 128, completion_tokens_details: { reasoning_tokens: 128 }, total_tokens: 1171, buyer_cost_micro: 565 };
  const assistant = { role: "assistant", content: null, reasoning_content: signedReasoning.text, reasoning_details: [signedReasoning] };
  const response = await normalizeAnthropicChatResponsesResponse(new Response(JSON.stringify(completion(assistant, "length", capped))), {
    model,
    provider: "surplus",
    reasoningReplayScope: scope,
  });
  const payload = await response.json();
  assert.equal(payload.status, "incomplete");
  assert.deepEqual(payload.incomplete_details, { reason: "max_output_tokens" });
  assert.deepEqual(
    payload.output.map((item: JsonRecord) => item.type),
    ["reasoning"]
  );
  assert.equal(payload.usage.input_tokens, 1043);
  assert.equal(payload.usage.input_tokens_details.cached_tokens, 1028);
  assert.equal(payload.usage.buyer_cost_micro, 565);
  assert.equal(restoreAnthropicChatReplay(payload.output, { scope, provider: "surplus", model }), null);
});

test("Claude Chat SSE streams reasoning and text, then includes trailing cache and authoritative cost", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const chunks = [
    chunk({
      role: "assistant",
      reasoning_content: signedReasoning.text,
      reasoning_details: [{ type: "reasoning.text", text: signedReasoning.text, format: "provider-format", index: 0 }],
    }),
    chunk({ reasoning_details: [{ type: "reasoning.text", signature: "opaque-chat-signature", format: "provider-format", index: 0 }] }),
    chunk({ content: "O" }),
    chunk({ content: "K" }, "stop"),
    { choices: [], usage },
  ];
  const events = await collect(await normalizeAnthropicChatResponsesResponse(sse(chunks), { model, provider: "surplus", reasoningReplayScope: scope }));
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_, index) => index)
  );
  const payload = terminal(events);
  assert.equal(payload.status, "completed");
  assert.equal((payload.usage as JsonRecord).input_tokens, 1043);
  assert.equal((payload.usage as JsonRecord).buyer_cost_micro, 285);
  assert.equal(events.filter((event) => event.type === "response.reasoning_summary_text.delta").length, 1);
  assert.deepEqual(restoreAnthropicChatReplay(payload.output as JsonRecord[], { scope, provider: "surplus", model }), [
    {
      type: "native_chat_assistant",
      message: { role: "assistant", content: "OK", reasoning_content: signedReasoning.text, reasoning_details: [signedReasoning] },
    },
  ]);
  assert.equal(JSON.stringify(events).includes("opaque-chat-signature"), false);
});

test("Claude Chat SSE closes text before announcing complete fragmented tool calls", async () => {
  const chunks = [
    chunk({ content: "Checking." }),
    chunk({ tool_calls: [{ index: 0, id: "call_weather", type: "function", function: { name: "wea", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: "ther", arguments: '{"city":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, "tool_calls"),
    { choices: [], usage },
  ];
  const events = await collect(await normalizeAnthropicChatResponsesResponse(sse(chunks), { model }));
  const doneMessage = events.findIndex((event) => event.type === "response.output_item.done" && (event.item as JsonRecord).type === "message");
  const addedTool = events.findIndex((event) => event.type === "response.output_item.added" && (event.item as JsonRecord).type === "function_call");
  assert.ok(doneMessage < addedTool);
  const output = terminal(events).output as JsonRecord[];
  assert.equal(output[1].name, "weather");
  assert.equal(output[1].arguments, '{"city":"Paris"}');
  assert.equal(output[1].call_id, "call_weather");
});

test("Claude Chat proven Max SSE reasoning alias renders once with actual cache-write and buyer cost", async () => {
  const nativeUsage = {
    prompt_tokens: 1043,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1028 },
    completion_tokens: 128,
    completion_tokens_details: { reasoning_tokens: 128 },
    total_tokens: 1171,
    buyer_cost_micro: 1552,
  };
  const details = (fields: JsonRecord): JsonRecord => ({ type: "reasoning.text", format: "anthropic-claude-v1", index: 0, ...fields });
  const upstream = sse([
    chunk({ role: "assistant", reasoning: "Use ", reasoning_details: [details({ text: "Use " })] }),
    chunk({ reasoning: "tool.", reasoning_details: [details({ text: "tool." })] }),
    chunk({ reasoning_details: [details({ signature: "late-original-signature" })] }),
    chunk({}, "length"),
    { choices: [], usage: nativeUsage },
  ]);
  const response = await normalizeAnthropicChatResponsesResponse(upstream, { model });
  assert.equal(response.headers.get("x-cost-micro"), null);
  const events = await collect(response);
  assert.deepEqual(
    events.filter((event) => event.type === "response.reasoning_summary_text.delta").map((event) => event.delta),
    ["Use ", "tool."]
  );
  const payload = terminal(events);
  assert.equal(payload.status, "incomplete");
  assert.deepEqual(payload.incomplete_details, { reason: "max_output_tokens" });
  assert.deepEqual(payload.usage, toAnthropicChatResponsesUsage(nativeUsage));
  assert.equal(JSON.stringify(events).includes("late-original-signature"), false);
});

test("Claude Chat SSE privately retains original reasoning spelling and a late replacement for an empty signature", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const chunks = [
    chunk({
      role: "assistant",
      reasoning: "Use the requested tool.",
      reasoning_details: [{ ...signedReasoning, signature: "" }],
    }),
    chunk({ reasoning_details: [{ type: "reasoning.text", signature: signedReasoning.signature, format: signedReasoning.format, index: 0 }] }),
    chunk({ tool_calls: [{ index: 0, id: "call_weather", type: "function", function: { name: "weather", arguments: "{}" } }] }, "tool_calls"),
    { choices: [], usage },
  ];
  const events = await collect(await normalizeAnthropicChatResponsesResponse(sse(chunks), { model, provider: "surplus", reasoningReplayScope: scope }));
  assert.deepEqual(restoreAnthropicChatReplay(terminal(events).output as JsonRecord[], { scope, provider: "surplus", model }), [
    {
      type: "native_chat_assistant",
      message: {
        role: "assistant",
        content: null,
        reasoning: signedReasoning.text,
        reasoning_details: [signedReasoning],
        tool_calls: [{ id: "call_weather", type: "function", function: { name: "weather", arguments: "{}" } }],
      },
    },
  ]);
});

test("Claude Chat SSE length and malformed or missing terminals are not completed", async () => {
  const events = await collect(
    await normalizeAnthropicChatResponsesResponse(sse([chunk({ reasoning_content: "Partial." }, "length"), { choices: [], usage }]), { model })
  );
  assert.equal(events.at(-1)?.type, "response.incomplete");
  for (const body of [sse([chunk({ content: "partial" })], false), sse([chunk({ content: "partial" })])]) {
    await assert.rejects(
      collect(await normalizeAnthropicChatResponsesResponse(body, { model })),
      (error: unknown) => error instanceof ResponsesStreamError && error.kind === "premature_eof"
    );
  }
  const malformedBody = new Response("data: {\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  await assert.rejects(
    collect(await normalizeAnthropicChatResponsesResponse(malformedBody, { model })),
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "malformed_event"
  );
});

test("Claude Chat SSE ambiguous repeated signatures do not create a signed replay receipt", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const chunks = [
    chunk({ reasoning_details: [{ ...signedReasoning, signature: "first" }] }),
    chunk({ reasoning_details: [{ type: "reasoning.text", text: "More.", signature: "second", index: 0, format: "provider-format" }], content: "OK" }, "stop"),
    { choices: [], usage },
  ];
  const events = await collect(await normalizeAnthropicChatResponsesResponse(sse(chunks), { model, provider: "surplus", reasoningReplayScope: scope }));
  assert.equal(terminal(events).status, "completed");
  assert.equal(restoreAnthropicChatReplay(terminal(events).output as JsonRecord[], { scope, provider: "surplus", model }), null);
});

test("Claude Chat preserves HTTP errors and propagates downstream cancellation", async () => {
  const errorResponse = new Response('{"error":{"code":"insufficient_funds","message":"capacity"}}', { status: 429 });
  assert.equal(await normalizeAnthropicChatResponsesResponse(errorResponse, { model }), errorResponse);
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: "O" }))}\n\n`));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await normalizeAnthropicChatResponsesResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), { model });
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.read();
  await reader.cancel("client stopped");
  reader.releaseLock();
  assert.equal(cancelled, true);
});

test("Claude Chat observed usage survives a subsequent premature stream EOF", async () => {
  const upstream = sse([chunk({ content: "Partial." }), { choices: [], usage }], false);
  const response = await normalizeAnthropicChatResponsesResponse(upstream, { model });
  const body = response.body;
  assert.ok(body);
  const observed: JsonRecord[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of readResponsesStream(body)) observed.push(event.value);
    })(),
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "premature_eof"
  );
  const measured = observed.filter((event) => event.type === "response.in_progress" && (event.response as JsonRecord).usage !== null).at(-1);
  assert.ok(measured);
  assert.deepEqual((measured.response as JsonRecord).usage, toAnthropicChatResponsesUsage(usage));
  assert.equal(
    observed.some((event) => event.type === "response.completed"),
    false
  );
});
