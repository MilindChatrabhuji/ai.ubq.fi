import assert from "node:assert/strict";
import { normalizeAnthropicResponsesResponse, toAnthropicResponsesUsage } from "../src/provider/anthropic-responses.ts";
import { extractUsageTokens } from "../src/openai-telemetry.ts";
import { readResponsesStream, ResponsesStreamError } from "../src/responses-stream.ts";
import { buildCodexRequest } from "../src/models/codex-models-fetch.ts";
import type { ResponseInputItem } from "../src/types.ts";
import { restoreAnthropicReplay } from "../src/provider/anthropic-replay.ts";

type JsonRecord = Record<string, unknown>;
const model = "claude-opus-5.5";
const message = (content: JsonRecord[], usage: JsonRecord, stopReason = "end_turn"): JsonRecord => ({
  id: "msg_native-123",
  type: "message",
  role: "assistant",
  model,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage,
});

const sse = (events: JsonRecord[], separator = "\n\n"): string =>
  events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}${separator}`).join("");
const streamResponse = (events: JsonRecord[], extraHeaders: HeadersInit = {}): Response => {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "text/event-stream");
  return new Response(sse(events), { headers });
};
const start = (usage: JsonRecord = { input_tokens: 15, output_tokens: 0, cache_read_input_tokens: 1028 }): JsonRecord => ({
  type: "message_start",
  message: message([], usage),
});
const textEvents = (): JsonRecord[] => [
  start(),
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "O" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "K" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4, buyer_cost_micro: 69 } },
  { type: "message_stop" },
];
const collect = async (response: Response): Promise<JsonRecord[]> => {
  assert.ok(response.body);
  const events: JsonRecord[] = [];
  for await (const event of readResponsesStream(response.body)) events.push(event.value);
  return events;
};
const terminalResponse = (events: JsonRecord[]): JsonRecord => events.at(-1)?.response as JsonRecord;

Deno.test("Anthropic Responses usage counts native cache-fill input once and preserves unknown reads", () => {
  const usage = toAnthropicResponsesUsage({ input_tokens: 15, output_tokens: 4, cache_creation_input_tokens: 1028, buyer_cost_micro: 1056 });
  assert.deepEqual(usage, {
    input_tokens: 1043,
    input_tokens_details: { cache_write_tokens: 1028 },
    output_tokens: 4,
    total_tokens: 1047,
    buyer_cost_micro: 1056,
  });
  const parsed = extractUsageTokens(usage);
  assert.ok(parsed);
  assert.equal(parsed.inputTokens, 1043);
  assert.equal(parsed.cacheWriteInputTokens, 1028);
  assert.equal(parsed.cachedInputTokens, null);
});

Deno.test("Anthropic Responses usage preserves measured reads and original buyer micro-cost", () => {
  const usage = toAnthropicResponsesUsage({ input_tokens: 15, output_tokens: 4, cache_read_input_tokens: 1028, buyer_cost_micro: 69 });
  assert.deepEqual(usage, {
    input_tokens: 1043,
    input_tokens_details: { cached_tokens: 1028 },
    output_tokens: 4,
    total_tokens: 1047,
    buyer_cost_micro: 69,
  });
  assert.equal(extractUsageTokens(usage)?.cacheWriteInputTokens, null);
});

Deno.test("Anthropic Responses usage adds mixed reads and writes without double counting", () => {
  assert.deepEqual(toAnthropicResponsesUsage({ input_tokens: 15, output_tokens: 4, cache_read_input_tokens: 1000, cache_creation_input_tokens: 28 }), {
    input_tokens: 1043,
    input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 28 },
    output_tokens: 4,
    total_tokens: 1047,
  });
});

Deno.test("Anthropic Responses usage does not invent absent cache counters or zero invalid counts", () => {
  assert.deepEqual(toAnthropicResponsesUsage({ input_tokens: 15, output_tokens: 4 }), { input_tokens: 15, output_tokens: 4, total_tokens: 19 });
  for (const invalid of [-1, 0.5, "1028", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const converted = toAnthropicResponsesUsage({ input_tokens: 15, output_tokens: 4, cache_read_input_tokens: invalid });
    assert.ok(converted);
    assert.equal(converted.input_tokens, null);
    assert.equal(converted.total_tokens, null);
    assert.deepEqual(converted.input_tokens_details, { cached_tokens: null });
  }
  assert.equal(toAnthropicResponsesUsage({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 4, cache_read_input_tokens: 1 })?.input_tokens, null);
  assert.equal(toAnthropicResponsesUsage({ input_tokens: 15, output_tokens: -1 })?.output_tokens, null);
  assert.equal(toAnthropicResponsesUsage({ input_tokens: "15", output_tokens: 4 })?.input_tokens, null);
  assert.equal(toAnthropicResponsesUsage(null), null);
});

Deno.test("Anthropic Responses usage preserves malformed authoritative costs for fail-closed settlement", () => {
  for (const cost of [null, -1, "69", 0.5, { amount: 69 }]) {
    assert.deepEqual(toAnthropicResponsesUsage({ input_tokens: 15, output_tokens: 4, buyer_cost_micro: cost })?.buyer_cost_micro, cost);
  }
});

Deno.test("Anthropic Responses maps native thinking tokens to canonical reasoning usage", () => {
  assert.deepEqual(
    toAnthropicResponsesUsage({
      input_tokens: 15,
      cache_read_input_tokens: 1028,
      output_tokens: 64,
      output_tokens_details: { thinking_tokens: 60 },
    }),
    {
      input_tokens: 1043,
      input_tokens_details: { cached_tokens: 1028 },
      output_tokens: 64,
      output_tokens_details: { reasoning_tokens: 60 },
      total_tokens: 1107,
    }
  );
  for (const thinking of [-1, 0.5, "60", 65]) {
    assert.deepEqual(
      toAnthropicResponsesUsage({ input_tokens: 15, output_tokens: 64, output_tokens_details: { thinking_tokens: thinking } })?.output_tokens_details,
      { reasoning_tokens: null }
    );
  }
});

Deno.test("Anthropic Responses JSON maps text, cache read and cost provenance", async () => {
  const upstream = new Response(
    JSON.stringify(message([{ type: "text", text: "OK" }], { input_tokens: 15, output_tokens: 4, cache_read_input_tokens: 1028, buyer_cost_micro: 69 })),
    {
      headers: { "content-type": "application/json", "content-length": "999", "x-cost-micro": "69", "x-request-id": "native-request" },
    }
  );
  const response = await normalizeAnthropicResponsesResponse(upstream, { model });
  const payload = await response.json();
  assert.equal(payload.object, "response");
  assert.equal(payload.model, model);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output[0].content[0].text, "OK");
  assert.equal(payload.usage.input_tokens, 1043);
  assert.equal(payload.usage.input_tokens_details.cached_tokens, 1028);
  assert.equal(payload.usage.buyer_cost_micro, 69);
  assert.equal(response.headers.get("x-cost-micro"), "69");
  assert.equal(response.headers.get("x-request-id"), "native-request");
  assert.equal(response.headers.get("content-length"), null);
});

Deno.test("Anthropic Responses JSON preserves tool IDs and arguments without exposing thinking signatures", async () => {
  const native = message(
    [
      { type: "thinking", thinking: "Use the requested tool.", signature: "provider-private-signature" },
      { type: "tool_use", id: "toolu_123", name: "weather", input: { city: "Paris" } },
    ],
    { input_tokens: 5, output_tokens: 10 },
    "tool_use"
  );
  const response = await normalizeAnthropicResponsesResponse(new Response(JSON.stringify(native)), { model });
  const payload = await response.json();
  assert.deepEqual(
    payload.output.map((item: JsonRecord) => item.type),
    ["reasoning", "function_call"]
  );
  assert.deepEqual(payload.output[0].summary, [{ type: "summary_text", text: "Use the requested tool." }]);
  assert.equal(payload.output[1].call_id, "toolu_123");
  assert.equal(payload.output[1].name, "weather");
  assert.equal(payload.output[1].arguments, '{"city":"Paris"}');
  assert.equal(JSON.stringify(payload).includes("provider-private-signature"), false);
  assert.equal(JSON.stringify(payload).includes("encrypted_content"), false);
  assert.match(payload.output[0].id, /^rs_resp_[A-Za-z0-9]{1,40}_\d+$/);
  const replay = buildCodexRequest(model, payload.output as ResponseInputItem[]);
  assert.deepEqual(replay.input, [{ type: "function_call", status: "completed", call_id: "toolu_123", name: "weather", arguments: '{"city":"Paris"}' }]);
});

Deno.test("Anthropic Responses redacted thinking stays opaque rather than being forged into an OpenAI replay payload", async () => {
  const native = message(
    [
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "OK" },
    ],
    { input_tokens: 5, output_tokens: 4 }
  );
  const response = await normalizeAnthropicResponsesResponse(new Response(JSON.stringify(native)), { model });
  const payload = await response.json();
  assert.equal(payload.output.length, 1);
  assert.equal(payload.output[0].type, "message");
  assert.equal(JSON.stringify(payload).includes("opaque"), false);
});

Deno.test("Anthropic Responses respects an explicit reasoning summary none", async () => {
  const native = message(
    [
      { type: "thinking", thinking: "Do not expose this.", signature: "private" },
      { type: "text", text: "OK" },
    ],
    { input_tokens: 5, output_tokens: 4 }
  );
  const response = await normalizeAnthropicResponsesResponse(new Response(JSON.stringify(native)), { model, reasoningSummary: "none" });
  const payload = await response.json();
  assert.deepEqual(
    payload.output.map((item: JsonRecord) => item.type),
    ["message"]
  );
  assert.equal(JSON.stringify(payload).includes("Do not expose this."), false);
});

Deno.test("Anthropic Responses JSON max_tokens is incomplete and unknown stops are failed", async () => {
  for (const [reason, status] of [
    ["max_tokens", "incomplete"],
    ["pause_turn", "failed"],
    ["unexpected", "failed"],
  ]) {
    const upstream = new Response(JSON.stringify(message([{ type: "text", text: "partial" }], { input_tokens: 5, output_tokens: 4 }, reason)));
    const response = await normalizeAnthropicResponsesResponse(upstream, { model });
    const payload = await response.json();
    assert.equal(payload.status, status);
    if (status === "incomplete") assert.deepEqual(payload.incomplete_details, { reason: "max_output_tokens" });
    else assert.equal(payload.error.code, "anthropic_unrecognized_stop_reason");
  }
});

Deno.test("Anthropic Responses SSE emits full text lifecycle and gross terminal usage", async () => {
  const response = await normalizeAnthropicResponsesResponse(streamResponse(textEvents()), { model });
  const events = await collect(response);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.in_progress",
      "response.completed",
    ]
  );
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_, index) => index)
  );
  assert.equal(terminalResponse(events).status, "completed");
  assert.deepEqual(terminalResponse(events).usage, {
    input_tokens: 1043,
    input_tokens_details: { cached_tokens: 1028 },
    output_tokens: 4,
    total_tokens: 1047,
    buyer_cost_micro: 69,
  });
});

Deno.test("Anthropic Responses SSE closes signed thinking before tool calls and preserves fragmented arguments", async () => {
  const native = [
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Use a tool." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "private" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "weather", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ];
  const events = await collect(await normalizeAnthropicResponsesResponse(streamResponse(native), { model }));
  const doneReasoning = events.findIndex((event) => event.type === "response.output_item.done" && (event.item as JsonRecord).type === "reasoning");
  const addedTool = events.findIndex((event) => event.type === "response.output_item.added" && (event.item as JsonRecord).type === "function_call");
  assert.ok(doneReasoning < addedTool);
  const payload = terminalResponse(events);
  const output = payload.output as JsonRecord[];
  assert.deepEqual(
    output.map((item) => item.type),
    ["reasoning", "function_call"]
  );
  assert.equal(output[1].arguments, '{"city":"Paris"}');
  assert.equal(output[1].call_id, "toolu_1");
  assert.equal(events.filter((event) => event.type === "response.function_call_arguments.delta").length, 2);
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.equal(JSON.stringify(events).includes("encrypted_content"), false);
});

Deno.test("Anthropic Responses SSE handles initial text, multiple text blocks and zero-argument tools", async () => {
  const native = [
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "First." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "Second." } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_empty", name: "clock", input: {} } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  const events = await collect(await normalizeAnthropicResponsesResponse(streamResponse(native), { model }));
  const output = terminalResponse(events).output as JsonRecord[];
  assert.deepEqual(
    output.map((item) => item.type),
    ["message", "message", "function_call"]
  );
  assert.equal(output[2].arguments, "{}");
  assert.deepEqual(
    events.filter((event) => event.type === "response.output_item.added").map((event) => event.output_index),
    [0, 1, 2]
  );
});

Deno.test("Anthropic Responses SSE handles fragmented UTF-8, CRLF, ping and trailing message_stop", async () => {
  const native = textEvents();
  native[2] = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "🌤" } };
  native.splice(1, 0, { type: "ping" });
  const encoded = new TextEncoder().encode(sse(native, "\r\n\r\n").trimEnd());
  let position = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === encoded.length) controller.close();
      else controller.enqueue(encoded.slice(position, ++position));
    },
  });
  const response = await normalizeAnthropicResponsesResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), { model });
  const events = await collect(response);
  const output = terminalResponse(events).output as JsonRecord[];
  assert.equal((output[0].content as JsonRecord[])[0].text, "🌤K");
});

Deno.test("Anthropic Responses SSE max_tokens emits incomplete, not completed", async () => {
  const native = textEvents();
  native[5] = { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4 } };
  const events = await collect(await normalizeAnthropicResponsesResponse(streamResponse(native), { model }));
  assert.equal(events.at(-1)?.type, "response.incomplete");
  assert.deepEqual(terminalResponse(events).incomplete_details, { reason: "max_output_tokens" });
});

Deno.test("Anthropic Responses preserves HTTP error status and translates native SSE errors", async () => {
  const errorResponse = new Response('{"type":"error","error":{"type":"overloaded_error","message":"capacity"}}', { status: 529 });
  const normalized = await normalizeAnthropicResponsesResponse(errorResponse, { model });
  assert.equal(normalized.status, 529);
  assert.deepEqual(await normalized.json(), { error: { type: "overloaded_error", message: "capacity", code: "overloaded_error" } });
  const events = await collect(
    await normalizeAnthropicResponsesResponse(streamResponse([{ type: "error", error: { type: "overloaded_error", message: "capacity" } }]), { model })
  );
  assert.deepEqual(events, [{ type: "error", code: "overloaded_error", message: "capacity", param: null, sequence_number: 0 }]);
});

Deno.test("Anthropic Responses HTTP error normalization retains provider codes and retry/cost provenance", async () => {
  const upstream = new Response('{"type":"error","error":{"type":"quota_error","code":"insufficient_funds","message":"capacity","param":null}}', {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "60", "x-cost-micro": "0", "x-request-id": "native-error" },
  });
  const normalized = await normalizeAnthropicResponsesResponse(upstream, { model });
  assert.equal(normalized.status, 429);
  assert.equal(normalized.headers.get("retry-after"), "60");
  assert.equal(normalized.headers.get("x-cost-micro"), "0");
  assert.equal(normalized.headers.get("x-request-id"), "native-error");
  assert.deepEqual(await normalized.json(), { error: { type: "quota_error", code: "insufficient_funds", message: "capacity", param: null } });
  const unrecognized = new Response("unrecognized upstream body", { status: 502 });
  assert.equal(await normalizeAnthropicResponsesResponse(unrecognized, { model }), unrecognized);
  assert.equal(await unrecognized.text(), "unrecognized upstream body");
});

Deno.test("Anthropic Responses fails closed on malformed JSON, unknown blocks and invalid message lifecycles", async () => {
  for (const body of [
    "{",
    JSON.stringify({ type: "message", role: "assistant", content: [{ type: "unknown", data: "x" }] }),
    JSON.stringify({ type: "message", role: "user", content: [] }),
  ]) {
    await assert.rejects(
      normalizeAnthropicResponsesResponse(new Response(body), { model }),
      (error: unknown) => error instanceof ResponsesStreamError && error.kind === "malformed_event"
    );
  }
  for (const native of [
    [start(), { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }],
    [start(), { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "message_stop" }],
    [start(), { type: "content_block_start", index: -1, content_block: { type: "text", text: "" } }],
  ]) {
    await assert.rejects(
      collect(await normalizeAnthropicResponsesResponse(streamResponse(native), { model })),
      (error: unknown) => error instanceof ResponsesStreamError && error.kind === "malformed_event"
    );
  }
});

Deno.test("Anthropic Responses detects premature EOF instead of manufacturing completed usage", async () => {
  const native = textEvents().slice(0, -1);
  await assert.rejects(
    collect(await normalizeAnthropicResponsesResponse(streamResponse(native), { model })),
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "premature_eof"
  );
});

Deno.test("Anthropic Responses propagates client cancellation to the upstream reader", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse([start()])));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await normalizeAnthropicResponsesResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), { model });
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.read();
  await reader.cancel("client stopped");
  assert.equal(cancelled, true);
  reader.releaseLock();
});

Deno.test("Anthropic Responses preserves an external abort while a native stream stalls", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const cancellation = new AbortController();
  const response = await normalizeAnthropicResponsesResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), {
    model,
    signal: cancellation.signal,
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  const pending = reader.read();
  cancellation.abort(new DOMException("requested stop", "AbortError"));
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError" && error.message === "requested stop");
  assert.equal(cancelled, true);
  reader.releaseLock();
});

Deno.test("Anthropic Responses cancellation before its first pull still cancels the upstream", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const response = await normalizeAnthropicResponsesResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), { model });
  assert.ok(response.body);
  await response.body.cancel("stop immediately");
  assert.equal(cancelled, true);
});

Deno.test("Anthropic Responses JSON privately preserves signed assistant blocks for scoped replay", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const content = [
    { type: "thinking", thinking: "Use the requested tool.", signature: "opaque-signature" },
    { type: "text", text: "Checking the weather." },
    { type: "tool_use", id: "toolu_replay", name: "weather", input: { city: "Paris" } },
  ];
  const normalized = await normalizeAnthropicResponsesResponse(
    new Response(JSON.stringify(message(content, { input_tokens: 5, output_tokens: 20 }, "tool_use"))),
    {
      model,
      provider: "surplus",
      reasoningReplayScope: scope,
    }
  );
  const payload = await normalized.json();
  const restored = restoreAnthropicReplay(payload.output, { scope, provider: "surplus", model });
  assert.deepEqual(restored, [{ type: "native_assistant", blocks: content }]);
  assert.equal(JSON.stringify(payload).includes("opaque-signature"), false);
  assert.equal(JSON.stringify(payload).includes("encrypted_content"), false);
  assert.equal(restoreAnthropicReplay(payload.output, { scope: "another-principal", provider: "surplus", model }), null);
  assert.equal(restoreAnthropicReplay(payload.output, { scope, provider: "metered", model }), null);
});

Deno.test("Anthropic Responses SSE privately reconstructs fragmented thinking signatures and tool arguments", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const native = [
    start(),
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Initial. ", signature: "prefix-" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Use a tool." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "nature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_signed", name: "weather", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ];
  const events = await collect(await normalizeAnthropicResponsesResponse(streamResponse(native), { model, provider: "surplus", reasoningReplayScope: scope }));
  const output = terminalResponse(events).output as JsonRecord[];
  assert.deepEqual(restoreAnthropicReplay(output, { scope, provider: "surplus", model }), [
    {
      type: "native_assistant",
      blocks: [
        { type: "thinking", thinking: "Initial. Use a tool.", signature: "prefix-signature" },
        { type: "tool_use", id: "toolu_signed", name: "weather", input: { city: "Paris" } },
      ],
    },
  ]);
  assert.equal(JSON.stringify(events).includes("prefix-signature"), false);
});

Deno.test("Anthropic Responses summary none retains private signed and redacted blocks for native tool continuation", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const content = [
    { type: "redacted_thinking", data: "opaque-redacted" },
    { type: "thinking", thinking: "Hidden summary.", signature: "private-signature" },
    { type: "tool_use", id: "toolu_hidden", name: "clock", input: {} },
  ];
  const normalized = await normalizeAnthropicResponsesResponse(
    new Response(JSON.stringify(message(content, { input_tokens: 5, output_tokens: 20 }, "tool_use"))),
    {
      model,
      provider: "metered",
      reasoningReplayScope: scope,
      reasoningSummary: "none",
    }
  );
  const payload = await normalized.json();
  assert.deepEqual(
    payload.output.map((item: JsonRecord) => item.type),
    ["function_call"]
  );
  assert.deepEqual(restoreAnthropicReplay(payload.output, { scope, provider: "metered", model }), [{ type: "native_assistant", blocks: content }]);
  assert.equal(JSON.stringify(payload).includes("private-signature"), false);
  assert.equal(JSON.stringify(payload).includes("opaque-redacted"), false);
  assert.equal(JSON.stringify(payload).includes("Hidden summary."), false);
});

Deno.test("Anthropic Responses does not retain incomplete signed turns as native replay receipts", async () => {
  const scope = `principal_${crypto.randomUUID()}`;
  const content = [
    { type: "thinking", thinking: "Partial.", signature: "incomplete-signature" },
    { type: "tool_use", id: "toolu_partial", name: "clock", input: {} },
  ];
  const normalized = await normalizeAnthropicResponsesResponse(
    new Response(JSON.stringify(message(content, { input_tokens: 5, output_tokens: 20 }, "max_tokens"))),
    {
      model,
      provider: "surplus",
      reasoningReplayScope: scope,
    }
  );
  const payload = await normalized.json();
  assert.equal(payload.status, "incomplete");
  assert.equal(restoreAnthropicReplay(payload.output, { scope, provider: "surplus", model }), null);
});

Deno.test("Anthropic Messages observed usage survives a subsequent premature stream EOF", async () => {
  const response = await normalizeAnthropicResponsesResponse(streamResponse(textEvents().slice(0, -1)), { model });
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
  assert.deepEqual((measured.response as JsonRecord).usage, {
    input_tokens: 1043,
    input_tokens_details: { cached_tokens: 1028 },
    output_tokens: 4,
    total_tokens: 1047,
    buyer_cost_micro: 69,
  });
  assert.equal(
    observed.some((event) => event.type === "response.completed"),
    false
  );
});
