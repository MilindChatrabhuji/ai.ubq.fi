import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  LITHOS_MODEL_IDS,
  LithosError,
  lithosUpstreamModelFor,
  normalizeLithosChatCompletion,
  normalizeLithosChatCompletionChunk,
  requireLithosApiKey,
} from "../src/provider/lithos.ts";

const REQUESTED_MODEL = "moonshotai/Kimi-K3";

/** Shaped like the real buffered success probed on 2026-09-23, nulls included. */
const completion = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-lithos-1",
  object: "chat.completion",
  created: 1_790_160_326,
  model: REQUESTED_MODEL,
  choices: [{ index: 0, message: { role: "assistant", content: "OK", reasoning_content: null, tool_calls: null }, logprobs: null, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 15,
    total_tokens: 17,
    completion_tokens: 2,
    prompt_tokens_details: null,
    completion_tokens_details: { reasoning_tokens: 0 },
  },
  ...overrides,
});

/** Shaped like the real streaming frames probed on 2026-09-23. */
const chunk = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-lithos-2",
  object: "chat.completion.chunk",
  created: 1_790_160_303,
  model: REQUESTED_MODEL,
  choices: [{ index: 0, delta: { reasoning_content: "The" }, logprobs: null, finish_reason: null }],
  ...overrides,
});

test("lithos: relays the measured prompt, completion, total, cache and reasoning counters", () => {
  const result = normalizeLithosChatCompletion(
    completion({
      usage: {
        prompt_tokens: 91,
        total_tokens: 204,
        completion_tokens: 113,
        prompt_tokens_details: { cached_tokens: 64 },
        completion_tokens_details: { reasoning_tokens: 99 },
      },
    }),
    REQUESTED_MODEL
  );
  if (!result.ok) throw new Error(result.message);
  assert.deepEqual(result.value.usage, {
    prompt_tokens: 91,
    completion_tokens: 113,
    total_tokens: 204,
    prompt_tokens_details: { cached_tokens: 64 },
    completion_tokens_details: { reasoning_tokens: 99 },
  });
  // The client-facing id is echoed rather than the upstream spelling.
  assert.equal(result.value.model, REQUESTED_MODEL);
});

test("lithos: an explicit null details object stays absent instead of becoming a measured zero", () => {
  const result = normalizeLithosChatCompletion(
    completion({
      usage: {
        prompt_tokens: 91,
        total_tokens: 204,
        completion_tokens: 113,
        prompt_tokens_details: null,
        completion_tokens_details: { reasoning_tokens: 99 },
      },
    }),
    REQUESTED_MODEL
  );
  if (!result.ok) throw new Error(result.message);
  // The real wire shape: `prompt_tokens_details` is present and null, which is
  // no cache measurement at all, while the reasoning count is a real integer.
  assert.deepEqual(result.value.usage, {
    prompt_tokens: 91,
    completion_tokens: 113,
    total_tokens: 204,
    completion_tokens_details: { reasoning_tokens: 99 },
  });

  // An explicit provider zero is a measurement, so it is relayed as one.
  const zeroed = normalizeLithosChatCompletion(
    completion({ usage: { prompt_tokens: 15, total_tokens: 17, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } }),
    REQUESTED_MODEL
  );
  if (!zeroed.ok) throw new Error(zeroed.message);
  assert.deepEqual(zeroed.value.usage, {
    prompt_tokens: 15,
    completion_tokens: 2,
    total_tokens: 17,
    prompt_tokens_details: { cached_tokens: 0 },
  });
});

test("lithos: present-and-null message fields stay absent while a tool call keeps its opaque id", () => {
  const plain = normalizeLithosChatCompletion(completion(), REQUESTED_MODEL);
  if (!plain.ok) throw new Error(plain.message);
  // `reasoning_content: null` and `tool_calls: null` are how this provider
  // reports "none"; neither may travel as an empty or null payload.
  assert.deepEqual(plain.value.choices, [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }]);

  const called = normalizeLithosChatCompletion(
    completion({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            reasoning_content: null,
            tool_calls: [{ id: "get_weather:0", index: 0, type: "function", function: { name: "get_weather", arguments: '{"city": "Paris"}' } }],
          },
          logprobs: null,
          finish_reason: "tool_calls",
        },
      ],
    }),
    REQUESTED_MODEL
  );
  if (!called.ok) throw new Error(called.message);
  assert.deepEqual(called.value.choices, [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "get_weather:0", type: "function", function: { name: "get_weather", arguments: '{"city": "Paris"}' } }],
      },
      finish_reason: "tool_calls",
    },
  ]);
});

test("lithos: the chunk normalizer accepts the empty-choices totals frame and relays its usage", () => {
  // The authoritative totals arrive on a trailing chunk whose `choices` is an
  // EMPTY ARRAY. Rejecting this frame loses every streamed token measurement,
  // so it is accepted explicitly and its usage is relayed ungated.
  const totals = normalizeLithosChatCompletionChunk(
    chunk({
      created: 1_790_160_304,
      choices: [],
      usage: {
        prompt_tokens: 91,
        total_tokens: 204,
        completion_tokens: 113,
        prompt_tokens_details: null,
        completion_tokens_details: { reasoning_tokens: 99 },
      },
    }),
    REQUESTED_MODEL
  );
  if (!totals.ok) throw new Error(totals.message);
  assert.deepEqual(totals.value.choices, []);
  assert.equal(totals.value.model, REQUESTED_MODEL);
  assert.deepEqual(totals.value.usage, {
    prompt_tokens: 91,
    completion_tokens: 113,
    total_tokens: 204,
    completion_tokens_details: { reasoning_tokens: 99 },
  });

  // A content frame carries usage too, with no `stream_options` involved.
  const content = normalizeLithosChatCompletionChunk(
    chunk({
      usage: {
        prompt_tokens: 91,
        total_tokens: 92,
        completion_tokens: 1,
        prompt_tokens_details: null,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    REQUESTED_MODEL
  );
  if (!content.ok) throw new Error(content.message);
  assert.deepEqual(content.value.choices, [{ index: 0, delta: { reasoning_content: "The" }, finish_reason: null }]);
  assert.deepEqual(content.value.usage, {
    prompt_tokens: 91,
    completion_tokens: 1,
    total_tokens: 92,
    completion_tokens_details: { reasoning_tokens: 0 },
  });

  // The opening role frame is all nulls and no usage, and the terminal frame
  // carries only a finish reason.
  const opening = normalizeLithosChatCompletionChunk(
    chunk({ choices: [{ index: 0, delta: { reasoning_content: null, role: "assistant", content: "" }, logprobs: null, finish_reason: null }] }),
    REQUESTED_MODEL
  );
  if (!opening.ok) throw new Error(opening.message);
  assert.deepEqual(opening.value.choices, [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);

  const terminal = normalizeLithosChatCompletionChunk(
    chunk({ created: 1_790_160_304, choices: [{ index: 0, delta: { reasoning_content: null }, logprobs: null, finish_reason: "stop" }] }),
    REQUESTED_MODEL
  );
  if (!terminal.ok) throw new Error(terminal.message);
  assert.deepEqual(terminal.value.choices, [{ index: 0, delta: {}, finish_reason: "stop" }]);
});

test("lithos: a malformed payload is refused with a message instead of throwing", () => {
  const malformedCompletions: readonly unknown[] = [
    null,
    "not a chat completion",
    {},
    completion({ id: "" }),
    completion({ created: -1 }),
    completion({ created: "1790160326" }),
    completion({ object: "chat.completion.chunk" }),
    completion({ choices: [] }),
    completion({ choices: [{ index: 0, message: { role: "user", content: "hi" } }] }),
    completion({ choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: 7 }] }),
    completion({ usage: { prompt_tokens: 15 } }),
  ];
  for (const payload of malformedCompletions) {
    const result = normalizeLithosChatCompletion(payload, REQUESTED_MODEL);
    if (result.ok) throw new Error("expected a refused buffered payload");
    assert.equal(result.ok, false);
    assert.ok(result.message.length > 0);
  }

  const malformedChunks: readonly unknown[] = [null, {}, chunk({ choices: "none" }), chunk({ id: "" }), chunk({ choices: [{ index: 0, delta: "text" }] })];
  for (const payload of malformedChunks) {
    const result = normalizeLithosChatCompletionChunk(payload, REQUESTED_MODEL);
    if (result.ok) throw new Error("expected a refused chunk payload");
    assert.equal(result.ok, false);
    assert.ok(result.message.length > 0);
  }
});

test("lithos: model resolution is case-insensitive and returns the canonical id", () => {
  assert.equal(LITHOS_MODEL_IDS.length, 8);
  for (const id of LITHOS_MODEL_IDS) assert.equal(lithosUpstreamModelFor(id), id);
  assert.equal(lithosUpstreamModelFor("moonshotai/kimi-k3-ultra-chat"), "moonshotai/Kimi-K3-ultra-chat");
  assert.equal(lithosUpstreamModelFor("  DEEPSEEK-AI/DEEPSEEK-V4.1-FLASH  "), "deepseek-ai/DeepSeek-V4.1-Flash");
  assert.equal(lithosUpstreamModelFor("nope/nope"), null);
  assert.equal(lithosUpstreamModelFor(""), null);
  assert.equal(lithosUpstreamModelFor("constructor"), null);
});

test("lithos: a supplied key wins and a missing key fails closed", () => {
  assert.equal(requireLithosApiKey("lith_sk_fixture"), "lith_sk_fixture");
  assert.throws(
    () => requireLithosApiKey("   "),
    (error: unknown) => error instanceof LithosError && error.code === "lithos_api_key_missing" && error.status === 503
  );
});

test("lithos: the ultra-chat tier's normalized /models/ echo is accepted and the requested id is echoed back", () => {
  // Probed live on 2026-09-23: every completion for this tier came back with
  // the engine's own base slug, while GET /v1/models/<full id> still reported
  // the full id. An exact-equality check would refuse every real response.
  const ultraChat = "deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat";
  const normalizedEcho = "/models/DeepSeek-V4.1-Flash";

  const buffered = normalizeLithosChatCompletion(completion({ model: normalizedEcho }), ultraChat);
  if (!buffered.ok) throw new Error(buffered.message);
  // The client-facing id is echoed rather than the upstream spelling.
  assert.equal(buffered.value.model, ultraChat);

  const streamed = normalizeLithosChatCompletionChunk(
    chunk({
      model: normalizedEcho,
      created: 1_790_160_304,
      choices: [],
      usage: {
        prompt_tokens: 15,
        total_tokens: 17,
        completion_tokens: 2,
        prompt_tokens_details: null,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }),
    ultraChat
  );
  if (!streamed.ok) throw new Error(streamed.message);
  assert.equal(streamed.value.model, ultraChat);
});

test("lithos: an absent, matching or slug-normalized model echo is accepted while a different model is refused", () => {
  // Rule 1: an absent echo claims nothing about the model, so it is no mismatch.
  for (const model of [null, undefined]) {
    const result = normalizeLithosChatCompletion(completion({ model }), REQUESTED_MODEL);
    if (!result.ok) throw new Error(result.message);
    assert.equal(result.value.model, REQUESTED_MODEL);
  }

  // Rule 2: the ordinary verbatim echo, matched case-insensitively.
  const matching = normalizeLithosChatCompletion(completion({ model: "MOONSHOTAI/KIMI-K3" }), REQUESTED_MODEL);
  if (!matching.ok) throw new Error(matching.message);
  assert.equal(matching.value.model, REQUESTED_MODEL);

  // Rule 3: a normalized echo naming only the requested trailing path segment.
  const slug = normalizeLithosChatCompletion(completion({ model: "/models/Kimi-K3" }), REQUESTED_MODEL);
  if (!slug.ok) throw new Error(slug.message);
  assert.equal(slug.value.model, REQUESTED_MODEL);

  // A genuinely different model is still refused, buffered and streamed alike,
  // with the message the malformed-payload test relies on staying intact.
  for (const model of ["deepseek-ai/DeepSeek-V4.1-Flash", "gpt-4"]) {
    const buffered = normalizeLithosChatCompletion(completion({ model }), REQUESTED_MODEL);
    if (buffered.ok) throw new Error(`expected the ${model} echo to be refused`);
    assert.equal(buffered.message, "Upstream returned a different model than requested.");
    const streamed = normalizeLithosChatCompletionChunk(chunk({ model }), REQUESTED_MODEL);
    if (streamed.ok) throw new Error(`expected the ${model} chunk echo to be refused`);
    assert.equal(streamed.message, "Upstream returned a different model than requested.");
  }
});
