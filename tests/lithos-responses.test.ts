import { test } from "bun:test";
import assert from "node:assert/strict";

import { DEEPSEEK_RESPONSES_PROFILE, LITHOS_RESPONSES_PROFILE } from "../src/deepseek/responses.ts";
import { type DeepSeekResponsesEcho, toDeepSeekResponsesPayload, toResponsesUsage } from "../src/deepseek/responses-payload.ts";
import { createDeepSeekResponsesStreamTranslator } from "../src/deepseek/responses-stream.ts";
import { toDeepSeekResponsesChatBody } from "../src/deepseek/chat-projection.ts";
import { normalizeLithosChatCompletion, normalizeLithosChatCompletionChunk } from "../src/provider/lithos.ts";

/**
 * LithosAI profile of the shared Chat Completions -> Responses adapter (module
 * m02-adapter).
 *
 * Every fixture below is a recorded-shaped LithosAI payload: the model ids and
 * wire fields are the ones the 2026-09-23 handoff
 * (`docs/handoff/lithosai-gateway-integration-2026-09-23.md`) records for this
 * vendor. The raw payloads are driven through the provider's own normalizers
 * and then through the profile-parameterized adapter, which is the path the
 * route takes. No test makes a network call or touches the vendor.
 */

const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
const KIMI = "moonshotai/Kimi-K3";
const echo: DeepSeekResponsesEcho = { tools: undefined, tool_choice: undefined, parallel_tool_calls: true, instructions: null };

const USAGE: Record<string, unknown> = Object.freeze({
  prompt_tokens: 12,
  completion_tokens: 9,
  total_tokens: 21,
  prompt_tokens_details: { cached_tokens: 4 },
  completion_tokens_details: { reasoning_tokens: 6 },
});

const rawCompletion = (message: Record<string, unknown>, finishReason: string, usage: Record<string, unknown> = USAGE): Record<string, unknown> => ({
  id: "chatcmpl-lithos-1",
  object: "chat.completion",
  created: 1_780_000_000,
  model: MODEL,
  choices: [{ index: 0, message, finish_reason: finishReason }],
  usage,
});

const rawChunk = (choices: readonly unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-lithos-stream",
  object: "chat.completion.chunk",
  created: 1_780_000_001,
  model: MODEL,
  choices,
  ...extra,
});

/** Drives one raw payload through the provider normalizer, failing loudly on a shape error. */
const normalizedCompletion = (value: Record<string, unknown>): Record<string, unknown> => {
  const result = normalizeLithosChatCompletion(value, MODEL);
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

const normalizedChunk = (value: Record<string, unknown>): Record<string, unknown> => {
  const result = normalizeLithosChatCompletionChunk(value, MODEL);
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

const eventTypes = (events: readonly Record<string, unknown>[]): string[] => events.map((event) => String(event.type));

const terminalOf = (events: readonly Record<string, unknown>[]): { type: string; response: Record<string, unknown> } => {
  const last = events.at(-1);
  if (!last) throw new Error("the translator emitted no terminal event");
  return last as { type: string; response: Record<string, unknown> };
};

test("lithos responses: a buffered completion maps reasoning_content and the answer", () => {
  const completion = normalizedCompletion(
    rawCompletion({ role: "assistant", content: "pong", reasoning_content: "The request asked for one word.", refusal: null, tool_calls: null }, "stop")
  );
  const payload = toDeepSeekResponsesPayload(completion, MODEL, "resp_lithos_buffered", echo, new Map(), new Set(), LITHOS_RESPONSES_PROFILE);

  assert.equal(payload.status, "completed");
  assert.equal(payload.model, MODEL);
  assert.equal(payload.incomplete_details, null);
  assert.deepEqual(payload.output, [
    {
      id: "rs_resp_lithos_buffered_0",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "The request asked for one word." }],
    },
    {
      id: "msg_resp_lithos_buffered_0",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "pong", annotations: [] }],
    },
  ]);
  assert.deepEqual(payload.usage, {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens: 9,
    output_tokens_details: { reasoning_tokens: 6 },
    total_tokens: 21,
  });
});

test("lithos responses: streaming accepts the empty-choices totals frame and reports its usage", () => {
  const translator = createDeepSeekResponsesStreamTranslator(MODEL, "resp_lithos_stream", echo, 1_780_000_000, new Map(), new Set(), LITHOS_RESPONSES_PROFILE);
  const events: Record<string, unknown>[] = [];
  events.push(
    ...translator.push(normalizedChunk(rawChunk([{ index: 0, delta: { role: "assistant", reasoning_content: "Thinking first." }, finish_reason: null }])))
  );
  // Most chunks carry usage on this wire; the first role delta does not.
  events.push(
    ...translator.push(
      normalizedChunk(
        rawChunk([{ index: 0, delta: { content: "pong" }, finish_reason: null }], {
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, prompt_tokens_details: null, completion_tokens_details: { reasoning_tokens: 1 } },
        })
      )
    )
  );
  // The chunk carrying `finish_reason` omits usage.
  events.push(...translator.push(normalizedChunk(rawChunk([{ index: 0, delta: {}, finish_reason: "stop" }]))));
  // The authoritative totals ride a trailing chunk whose `choices` is an EMPTY
  // ARRAY. That frame is valid, contributes no content events, and needs no
  // `stream_options.include_usage` on the request.
  const totalsEvents = translator.push(
    normalizedChunk(
      rawChunk([], {
        usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21, prompt_tokens_details: null, completion_tokens_details: { reasoning_tokens: 6 } },
      })
    )
  );
  assert.deepEqual(totalsEvents, []);
  assert.deepEqual(translator.answerBearingOutput(), { text: "pong", refusal: "", toolCallCount: 0 });
  assert.equal(translator.terminalKind(), "completed");
  events.push(...translator.finish());

  const types = eventTypes(events);
  assert.ok(types.includes("response.reasoning_summary_text.delta"));
  assert.ok(types.includes("response.output_text.delta"));
  const terminal = terminalOf(events);
  assert.equal(terminal.type, "response.completed");
  assert.equal(terminal.response.status, "completed");
  assert.deepEqual(terminal.response.usage, {
    input_tokens: 12,
    output_tokens: 9,
    output_tokens_details: { reasoning_tokens: 6 },
    total_tokens: 21,
  });
  assert.deepEqual(terminal.response.output, [
    {
      id: "rs_resp_lithos_stream_0",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "Thinking first." }],
    },
    {
      id: "msg_resp_lithos_stream_0",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "pong", annotations: [] }],
    },
  ]);
});

test("lithos responses: length truncation maps to response.incomplete with max_output_tokens", () => {
  // Recorded live: a small `max_tokens` request returned `content: ""`, a filled
  // `reasoning_content` and `finish_reason: "length"`.
  const truncated = normalizedCompletion(
    rawCompletion({ role: "assistant", content: "", reasoning_content: "Budget spent mid-thought.", refusal: null, tool_calls: null }, "length")
  );
  const payload = toDeepSeekResponsesPayload(truncated, MODEL, "resp_lithos_length", echo, new Map(), new Set(), LITHOS_RESPONSES_PROFILE);
  assert.equal(payload.status, "incomplete");
  assert.deepEqual(payload.incomplete_details, { reason: "max_output_tokens" });

  const translator = createDeepSeekResponsesStreamTranslator(
    MODEL,
    "resp_lithos_stream_length",
    echo,
    1_780_000_000,
    new Map(),
    new Set(),
    LITHOS_RESPONSES_PROFILE
  );
  translator.push(normalizedChunk(rawChunk([{ index: 0, delta: { role: "assistant", reasoning_content: "Budget spent mid-thought." }, finish_reason: null }])));
  translator.push(normalizedChunk(rawChunk([{ index: 0, delta: {}, finish_reason: "length" }], { usage: USAGE })));
  assert.equal(translator.terminalKind(), "incomplete");
  const terminal = terminalOf(translator.finish());
  assert.equal(terminal.type, "response.incomplete");
  assert.equal(terminal.response.status, "incomplete");
  assert.deepEqual(terminal.response.incomplete_details, { reason: "max_output_tokens" });
});

test("lithos responses: tool calls map to function_call items on both transports", () => {
  const call = { id: "get_weather:0", type: "function", function: { name: "get_weather", arguments: '{"city":"x"}' } };
  const buffered = normalizedCompletion(
    rawCompletion({ role: "assistant", content: null, reasoning_content: "Calling the tool.", refusal: null, tool_calls: [call] }, "tool_calls")
  );
  const payload = toDeepSeekResponsesPayload(buffered, MODEL, "resp_lithos_tools", echo, new Map(), new Set(), LITHOS_RESPONSES_PROFILE);
  assert.equal(payload.status, "completed");
  assert.deepEqual(payload.output, [
    {
      id: "rs_resp_lithos_tools_0",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "Calling the tool." }],
    },
    {
      id: "fc_resp_lithos_tools_0_0",
      type: "function_call",
      status: "completed",
      call_id: "get_weather:0",
      name: "get_weather",
      arguments: '{"city":"x"}',
    },
  ]);

  const translator = createDeepSeekResponsesStreamTranslator(
    MODEL,
    "resp_lithos_stream_tools",
    echo,
    1_780_000_000,
    new Map(),
    new Set(),
    LITHOS_RESPONSES_PROFILE
  );
  translator.push(
    normalizedChunk(
      rawChunk([
        {
          index: 0,
          delta: { role: "assistant", tool_calls: [{ index: 0, id: "get_weather:0", type: "function", function: { name: "get_weather", arguments: "" } }] },
          finish_reason: null,
        },
      ])
    )
  );
  translator.push(
    normalizedChunk(rawChunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"x"}' } }] }, finish_reason: null }]))
  );
  translator.push(normalizedChunk(rawChunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }])));
  assert.deepEqual(translator.answerBearingOutput(), { text: "", refusal: "", toolCallCount: 1 });
  const terminal = terminalOf(translator.finish());
  assert.equal(terminal.type, "response.completed");
  assert.deepEqual(terminal.response.output, [
    {
      id: "fc_resp_lithos_stream_tools_0",
      type: "function_call",
      status: "completed",
      call_id: "get_weather:0",
      name: "get_weather",
      arguments: '{"city":"x"}',
    },
  ]);
});

test("lithos responses: forwards every accepted reasoning tier verbatim", () => {
  // The seven tiers the provider accepted on 2026-09-23, 1:1 with the wire.
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const result = toDeepSeekResponsesChatBody({ input: "hi", reasoning: { effort } }, MODEL, false, LITHOS_RESPONSES_PROFILE);
    assert.equal(result.ok, true);
    assert.equal(result.value.body.reasoning_effort, effort);
  }

  // There is no advanced-preset map on this profile: `ultra` is refused by the
  // provider, so it is never translated to `max` the way DeepSeek's profile
  // translates it, and DeepSeek keeps its own mapping unchanged.
  const deepSeek = toDeepSeekResponsesChatBody({ input: "hi", reasoning: { effort: "ultra" } }, "deepseek-flash", false, DEEPSEEK_RESPONSES_PROFILE);
  assert.equal(deepSeek.ok, true);
  assert.equal(deepSeek.value.body.reasoning_effort, "max");
  const lithos = toDeepSeekResponsesChatBody({ input: "hi", reasoning: { effort: "ultra" } }, MODEL, false, LITHOS_RESPONSES_PROFILE);
  assert.equal(lithos.ok, false);
  assert.equal(lithos.param, "reasoning.effort");
  assert.match(lithos.message, /'ultra' is not supported by LithosAI/);
});

test("lithos responses: refuses an effort outside the seven accepted tiers", () => {
  for (const effort of ["ultra", "summary", "bogus", "x-high"]) {
    const result = toDeepSeekResponsesChatBody({ input: "hi", reasoning: { effort } }, MODEL, false, LITHOS_RESPONSES_PROFILE);
    assert.equal(result.ok, false);
    assert.equal(result.param, "reasoning.effort");
    assert.match(result.message, /is not supported by LithosAI/);
  }
});

test("lithos responses: does not request the DeepSeek stream usage option", () => {
  const result = toDeepSeekResponsesChatBody({ input: "hi", reasoning: { effort: "medium" } }, MODEL, true, LITHOS_RESPONSES_PROFILE);
  assert.equal(result.ok, true);
  assert.equal(result.value.body.stream, true);
  assert.equal("stream_options" in result.value.body, false);

  // The DeepSeek profile keeps asking for usage explicitly.
  const deepSeekStream = toDeepSeekResponsesChatBody({ input: "hi" }, "deepseek-flash", true, DEEPSEEK_RESPONSES_PROFILE);
  assert.equal(deepSeekStream.ok, true);
  assert.deepEqual(deepSeekStream.value.body.stream_options, { include_usage: true });
});

test("lithos responses: adds no Kimi K3 sampling constraints of its own", () => {
  const result = toDeepSeekResponsesChatBody({ input: "hi", reasoning: { effort: "high" } }, KIMI, false, LITHOS_RESPONSES_PROFILE);
  assert.equal(result.ok, true);
  assert.equal(result.value.body.model, KIMI);
  // The vendor requires `n: 1`, `presence_penalty: 0.0` and
  // `frequency_penalty: 0.0`; the adapter must not invent them while
  // translating, and it does not rewrite the caller's body into new fields.
  for (const field of ["n", "presence_penalty", "frequency_penalty"]) {
    assert.equal(field in result.value.body, false);
  }
});

test("lithos responses: resolves the vendor's eight ids and refuses other models", () => {
  const ids = [
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "deepseek-ai/DeepSeek-V4.1-Flash-fast",
    "deepseek-ai/DeepSeek-V4.1-Flash-ultra",
    "deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat",
    "moonshotai/Kimi-K3",
    "moonshotai/Kimi-K3-fast",
    "moonshotai/Kimi-K3-ultra",
    "moonshotai/Kimi-K3-ultra-chat",
  ];
  for (const id of ids) {
    const result = toDeepSeekResponsesChatBody({ input: "hi", reasoning: { effort: "medium" } }, id, false, LITHOS_RESPONSES_PROFILE);
    assert.equal(result.ok, true);
    assert.equal(result.value.body.model, id);
  }

  const wrong = toDeepSeekResponsesChatBody({ input: "hi" }, "deepseek-flash", false, LITHOS_RESPONSES_PROFILE);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.param, "model");
  assert.match(wrong.message, /model 'deepseek-flash' is not a LithosAI official model/);
});

test("lithos responses: maps the provider's usage counters onto the Responses shape", () => {
  assert.deepEqual(
    toResponsesUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 96 },
        completion_tokens_details: { reasoning_tokens: 4 },
      },
      LITHOS_RESPONSES_PROFILE
    ),
    {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 96 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 4 },
      total_tokens: 105,
    }
  );

  // The provider reports `prompt_tokens_details` as an explicit `null` when it
  // measured nothing; that is absence, not a measured zero.
  assert.deepEqual(
    toResponsesUsage(
      { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: null, completion_tokens_details: { reasoning_tokens: 2 } },
      LITHOS_RESPONSES_PROFILE
    ),
    { input_tokens: 4, output_tokens: 2, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 6 }
  );

  // A counter above the total it is a subset of is dropped rather than published.
  assert.deepEqual(
    toResponsesUsage(
      {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
        prompt_tokens_details: { cached_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
      LITHOS_RESPONSES_PROFILE
    ),
    { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
  );

  assert.equal(toResponsesUsage(null, LITHOS_RESPONSES_PROFILE), null);
});

test("lithos responses: the profile reuses the shared finish vocabulary without laundering", () => {
  assert.equal(LITHOS_RESPONSES_PROFILE.id, "lithos");
  assert.equal(LITHOS_RESPONSES_PROFILE.label, "LithosAI");
  assert.deepEqual(LITHOS_RESPONSES_PROFILE.finishDisposition("stop"), { kind: "completed" });
  assert.deepEqual(LITHOS_RESPONSES_PROFILE.finishDisposition("tool_calls"), { kind: "completed" });
  assert.deepEqual(LITHOS_RESPONSES_PROFILE.finishDisposition("length"), { kind: "incomplete", reason: "max_output_tokens" });
  assert.deepEqual(LITHOS_RESPONSES_PROFILE.finishDisposition("something_new"), { kind: "unknown", value: "something_new" });
});
