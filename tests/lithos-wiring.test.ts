import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import type { Kv, KvEntryMaybe, KvKey } from "#kv";
import { runSequence } from "./helpers/sequence.ts";
import assert from "node:assert/strict";

import { LITHOS_CHAT_COMPLETIONS_URL, LITHOS_MODEL_IDS, LITHOS_RATE_LIMIT_HEADERS } from "../src/provider/lithos.ts";
import {
  clearLithosFailoverWindows,
  lithosFailoverTargetAt,
  lithosOpenFailoverWindow,
  lithosRateLimitSnapshot,
  lithosRateLimitWait,
  waitForLithosRetry,
} from "../src/provider/lithos-rate-limits.ts";
import { setKvForTest } from "../src/kv.ts";
import { handleResponses } from "../src/responses-handler.ts";
import { handleChatCompletions } from "../src/chat/envelope.ts";
import { buildModelCatalogSnapshot, handleModelCapabilities, handleModels } from "../src/models/catalog.ts";
import { getResponseTelemetry } from "../src/openai-telemetry.ts";
import { DEEPSEEK_WATERFALL_MODEL_ID } from "../src/deepseek/waterfall.ts";

// The catalog builder reads discovery credentials from the environment. Clearing
// them keeps this suite on the credential-gated providers it owns, and keeps the
// discovery fetches from reaching a network the test task does not allow.
Reflect.deleteProperty(process.env, "METERED_API_KEY");
Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");

const LITHOS_API_KEY_ENV = "LITHOSAI_API_KEY";
const LITHOS_API_KEY = "lith_sk_fixture";
const LITHOS_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-ultra";
const KIMI_MODEL = "moonshotai/Kimi-K3";
/** A tier with no configured sibling, so failover never changes its fixtures. */
const LITHOS_BASE_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
/** The Ultra tier's sibling: same weights, its own rate-limit bucket, and the long-context-safe target. */
const LITHOS_SIBLING_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-fast";
const LITHOS_MIXED_CASE_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-ULTRA";

const keyOf = (key: KvKey): string => JSON.stringify(key);

/**
 * Minimal Deno.Kv stand-in. Every path these handlers read (the provider
 * selection, the model snapshot, the whitelist, provider health) only reads and
 * writes single keys, so an in-memory map is enough and no local KV file is
 * opened.
 */
const kvStore = new Map<string, unknown>();
type KvOp = { type: "set" | "delete"; key: KvKey; value?: unknown };
const kvStub = {
  get: (key: KvKey) =>
    Promise.resolve({
      key,
      value: kvStore.get(keyOf(key)) ?? null,
      versionstamp: kvStore.has(keyOf(key)) ? "00000000000000000001" : null,
    } as KvEntryMaybe<unknown>),
  getMany: (keys: readonly KvKey[]) =>
    Promise.resolve(
      keys.map((key) => ({
        key,
        value: kvStore.get(keyOf(key)) ?? null,
        versionstamp: kvStore.has(keyOf(key)) ? "00000000000000000001" : null,
      }))
    ),
  set: (key: KvKey, value: unknown) => {
    kvStore.set(keyOf(key), value);
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    kvStore.delete(keyOf(key));
    return Promise.resolve();
  },
  list: function* () {
    // Every path these handlers read uses single-key reads and writes; no
    // fixture in this suite lists the store.
  },
  atomic: () => {
    const ops: KvOp[] = [];
    const chain = {
      check: () => chain,
      set: (key: KvKey, value: unknown) => {
        ops.push({ type: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        ops.push({ type: "delete", key });
        return chain;
      },
      commit: () => {
        for (const op of ops) {
          if (op.type === "set") kvStore.set(keyOf(op.key), op.value);
          else kvStore.delete(keyOf(op.key));
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

setKvForTest(kvStub);

type UpstreamCall = Readonly<{ url: string; body: Record<string, unknown>; headers: Headers }>;
type UpstreamResult<T> = Readonly<{ result: T; calls: UpstreamCall[] }>;

/** The URL a recorded fetch was addressed to, whichever form the caller used. */
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

/**
 * Runs `run` with a recorded fetch. Any URL this suite does not explicitly
 * answer (paid discovery, enrichment) gets a refusal, so no fixture can reach a
 * real network.
 */
const withUpstream = async <T>(
  handler: (call: UpstreamCall, calls: readonly UpstreamCall[]) => Response | Promise<Response>,
  run: () => Promise<T>
): Promise<UpstreamResult<T>> => {
  const calls: UpstreamCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const call: UpstreamCall = {
      url,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls));
  });
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const chatRequest = (body: Record<string, unknown>): Request =>
  new Request("https://ai.ubq.fi/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const responsesRequest = (body: Record<string, unknown>): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Encodes recorded Chat chunks the way the vendor's SSE wire carries them. */
const sseBody = (frames: readonly unknown[]): string => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");

const usageContext = (requestId: string) => ({
  keyId: null,
  kernelRepo: null,
  kernelOrg: null,
  requestId,
  startedAtMs: Date.now(),
  startedAtMonotonicMs: performance.now(),
});

/** The vendor's own refusal shape for a saturated budget, with its retry hint. */
const lithosRateLimitRefusal = (retryAfterMs: string): Response =>
  Response.json(
    { error: { message: "Rate limit exceeded for input_tokens.", type: "input_tokens", code: "rate_limit_exceeded" } },
    { status: 429, headers: { "Content-Type": "application/json", "retry-after-ms": retryAfterMs } }
  );

/** One recorded streamed Chat completion body, shaped like the vendor's wire. */
const lithosStreamBody = (content: string, model: string = LITHOS_MODEL): string => {
  const frames = [
    {
      id: "chatcmpl-lithos-absorb",
      object: "chat.completion.chunk",
      created: 1_790_160_331,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    },
    {
      id: "chatcmpl-lithos-absorb",
      object: "chat.completion.chunk",
      created: 1_790_160_331,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      id: "chatcmpl-lithos-absorb",
      object: "chat.completion.chunk",
      created: 1_790_160_331,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      id: "chatcmpl-lithos-absorb",
      object: "chat.completion.chunk",
      created: 1_790_160_332,
      model,
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: null, completion_tokens_details: { reasoning_tokens: 5 } },
    },
  ];
  return `${sseBody(frames)}data: [DONE]\n\n`;
};

/** One recorded buffered Chat completion, shaped like the vendor's wire. */
const lithosCompletion = (message: Record<string, unknown>, model: string = LITHOS_MODEL): Record<string, unknown> => ({
  id: "chatcmpl-lithos-1",
  object: "chat.completion",
  created: 1_790_160_326,
  model,
  choices: [{ index: 0, message, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 91,
    completion_tokens: 113,
    total_tokens: 204,
    prompt_tokens_details: { cached_tokens: 64 },
    completion_tokens_details: { reasoning_tokens: 99 },
  },
  // Provider-only diagnostics must never reach the client.
  system_fingerprint: "fp_lithos_provider_only",
});

const withLithosKey = async (run: () => Promise<void>): Promise<void> => {
  const previous = process.env[LITHOS_API_KEY_ENV];
  process.env[LITHOS_API_KEY_ENV] = LITHOS_API_KEY;
  try {
    await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, LITHOS_API_KEY_ENV);
    else process.env[LITHOS_API_KEY_ENV] = previous;
  }
};

const withoutLithosKey = async (run: () => Promise<void>): Promise<void> => {
  const previous = process.env[LITHOS_API_KEY_ENV];
  Reflect.deleteProperty(process.env, LITHOS_API_KEY_ENV);
  try {
    await run();
  } finally {
    if (previous !== undefined) process.env[LITHOS_API_KEY_ENV] = previous;
  }
};

test("lithos wiring: dispatches Chat Completions to the vendor with the bearer key and a verbatim reasoning_effort", async () => {
  await withLithosKey(async () => {
    const messages = [{ role: "user", content: "Say OK." }];
    const { result: response, calls } = await withUpstream(
      () =>
        Response.json(lithosCompletion({ role: "assistant", content: "OK", reasoning_content: "Considered the request.", tool_calls: null }), {
          headers: { "Content-Type": "application/json", "x-request-id": "lithos-middlebox-injected" },
        }),
      () =>
        handleChatCompletions(
          chatRequest({
            model: LITHOS_MODEL,
            messages,
            reasoning_effort: "xhigh",
            max_completion_tokens: 512,
            stream: false,
          }),
          usageContext("lithos-chat-buffered")
        )
    );

    assert.equal(calls.length, 1, "a direct provider dispatch must not fan out");
    assert.equal(calls[0].url, LITHOS_CHAT_COMPLETIONS_URL);
    assert.equal(calls[0].headers.get("authorization"), `Bearer ${LITHOS_API_KEY}`);
    assert.equal(calls[0].headers.get("content-type"), "application/json");
    // The tier is forwarded verbatim and the OpenAI output cap becomes the
    // field this vendor documents (`max_tokens`).
    assert.deepEqual(calls[0].body, { model: LITHOS_MODEL, messages, reasoning_effort: "xhigh", max_tokens: 512, stream: false });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-upstream"), "lithos");
    // This vendor sends no request-id header at all, so the gateway claims no
    // correlation id even when a middlebox injects one.
    assert.equal(response.headers.get("x-uos-provider-request-id"), null);
    const payload = (await response.json()) as Record<string, unknown>;
    assert.equal(payload.model, LITHOS_MODEL);
    assert.deepEqual(payload.usage, {
      prompt_tokens: 91,
      completion_tokens: 113,
      total_tokens: 204,
      prompt_tokens_details: { cached_tokens: 64 },
      completion_tokens_details: { reasoning_tokens: 99 },
    });
    assert.doesNotMatch(JSON.stringify(payload), /fp_lithos_provider_only/);

    const telemetry = getResponseTelemetry(response);
    assert.equal(telemetry?.provider, "lithos");
    assert.equal(telemetry.reasoning, "xhigh");
    assert.deepEqual(telemetry.attemptedProviders, ["lithos"]);
    assert.equal(telemetry.completed, true);
  });
});

test("lithos wiring: relays the vendor's Chat stream frames and its unconditional usage", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    const chunk = (delta: Record<string, unknown>, choices?: Record<string, unknown>[]) => ({
      id: "chatcmpl-lithos-stream",
      object: "chat.completion.chunk",
      created: 1_790_160_327,
      model: KIMI_MODEL,
      choices: choices ?? [{ index: 0, delta, finish_reason: null }],
    });
    const frames = [
      chunk({ role: "assistant", content: "" }),
      chunk({ reasoning_content: "Let me think" }),
      chunk({ content: "Paris" }),
      chunk({}, [{ index: 0, delta: {}, finish_reason: "stop" }]),
      // The authoritative totals ride a chunk with an EMPTY choices array and
      // are relayed without any `stream_options.include_usage` request flag.
      {
        id: "chatcmpl-lithos-stream",
        object: "chat.completion.chunk",
        created: 1_790_160_328,
        model: KIMI_MODEL,
        choices: [],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          prompt_tokens_details: null,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      },
    ];
    const body = `${sseBody(frames)}data: [DONE]\n\n`;
    const { result: response, calls } = await withUpstream(
      () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      () =>
        handleChatCompletions(chatRequest({ model: KIMI_MODEL, messages: [{ role: "user", content: "hi" }], stream: true }), usageContext("lithos-chat-stream"))
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.equal(response.headers.get("x-uos-upstream"), "lithos");
    // Nothing injects DeepSeek's usage flag on this wire.
    assert.deepEqual(calls[0].body, { model: KIMI_MODEL, messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium", stream: true });

    const text = await response.text();
    const dataFrames = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => frame.slice(6));
    assert.equal(dataFrames.at(-1), "[DONE]");
    const relayed = dataFrames.slice(0, -1).map((frame) => JSON.parse(frame) as Record<string, unknown>);
    assert.equal(relayed.length, frames.length);
    assert.deepEqual(relayed[1]?.choices, [{ index: 0, delta: { reasoning_content: "Let me think" }, finish_reason: null }]);
    assert.deepEqual(relayed[4]?.choices, []);
    assert.deepEqual(relayed[4]?.usage, {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      completion_tokens_details: { reasoning_tokens: 5 },
    });

    const telemetry = getResponseTelemetry(response);
    assert.equal(telemetry?.provider, "lithos");
    assert.equal(telemetry.stream, true);
    assert.equal(telemetry.streamTerminalType, "response.completed");
    assert.equal(telemetry.inputTokens, 11);
    assert.equal(telemetry.outputTokens, 7);
    assert.equal(telemetry.completed, true);
  });
});

test("lithos wiring: streams the translated Responses event sequence", async () => {
  await withLithosKey(async () => {
    const frames = [
      {
        id: "chatcmpl-lithos-stream",
        object: "chat.completion.chunk",
        created: 1_790_160_329,
        model: LITHOS_MODEL,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-lithos-stream",
        object: "chat.completion.chunk",
        created: 1_790_160_329,
        model: LITHOS_MODEL,
        choices: [{ index: 0, delta: { reasoning_content: "Thinking" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-lithos-stream",
        object: "chat.completion.chunk",
        created: 1_790_160_329,
        model: LITHOS_MODEL,
        choices: [{ index: 0, delta: { content: "Paris" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-lithos-stream",
        object: "chat.completion.chunk",
        created: 1_790_160_329,
        model: LITHOS_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "chatcmpl-lithos-stream",
        object: "chat.completion.chunk",
        created: 1_790_160_330,
        model: LITHOS_MODEL,
        choices: [],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
          prompt_tokens_details: null,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      },
    ];
    const body = `${sseBody(frames)}data: [DONE]\n\n`;
    const { result: response, calls } = await withUpstream(
      () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      () => handleResponses(responsesRequest({ model: LITHOS_MODEL, input: "Capital of France?", stream: true }), usageContext("lithos-responses-stream"))
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.equal(response.headers.get("x-uos-upstream"), "lithos");
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].body.reasoning_effort, "medium");
    assert.equal(Object.hasOwn(calls[0].body, "stream_options"), false, "this provider's usage is unconditional");

    const events = (await response.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("event: "))
      .map((frame) => JSON.parse(frame.split("\ndata: ")[1]) as Record<string, unknown>);
    const types = events.map((event) => event.type);
    assert.equal(types[0], "response.created");
    assert.ok(types.includes("response.output_item.added"));
    assert.ok(types.includes("response.reasoning_summary_text.delta"));
    assert.ok(types.includes("response.output_text.delta"));
    // Official Responses events carry a monotonic per-response sequence number.
    assert.deepEqual(
      events.map((event) => event.sequence_number),
      events.map((_, index) => index)
    );

    const terminal = events.find((event) => event.type === "response.completed");
    assert.ok(terminal, "a stopped stream must end with a completed terminal");
    const terminalResponse = terminal.response as Record<string, unknown>;
    assert.equal(terminalResponse.status, "completed");
    assert.equal(terminalResponse.model, LITHOS_MODEL);
    const output = terminalResponse.output as Record<string, unknown>[];
    assert.equal(output[0]?.type, "reasoning");
    assert.deepEqual(output[1]?.content, [{ type: "output_text", text: "Paris", annotations: [] }]);
    assert.deepEqual(terminalResponse.usage, {
      input_tokens: 11,
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 18,
    });

    const telemetry = getResponseTelemetry(response);
    assert.equal(telemetry?.provider, "lithos");
    assert.equal(telemetry.streamTerminalType, "response.completed");
    assert.equal(telemetry.completed, true);
  });
});

test("lithos wiring: serves /v1/responses through the shared profile translation", async () => {
  await withLithosKey(async () => {
    const { result: response, calls } = await withUpstream(
      () => Response.json(lithosCompletion({ role: "assistant", content: "Paris", reasoning_content: "Considered it.", tool_calls: null })),
      () =>
        handleResponses(
          responsesRequest({
            model: LITHOS_MODEL,
            input: "Capital of France?",
            reasoning: { effort: "high" },
            max_output_tokens: 256,
            stream: false,
          }),
          usageContext("lithos-responses-buffered")
        )
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, LITHOS_CHAT_COMPLETIONS_URL);
    // The translated body is a Chat Completions body, and this provider is not
    // sent `stream_options` because it reports usage unconditionally.
    assert.deepEqual(calls[0].body, {
      model: LITHOS_MODEL,
      messages: [{ role: "user", content: "Capital of France?" }],
      stream: false,
      max_tokens: 256,
      reasoning_effort: "high",
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-upstream"), "lithos");
    const payload = (await response.json()) as Record<string, unknown>;
    assert.equal(payload.object, "response");
    assert.equal(payload.status, "completed");
    assert.equal(payload.model, LITHOS_MODEL);
    const output = payload.output as Record<string, unknown>[];
    assert.equal(output[0]?.type, "reasoning");
    assert.deepEqual(output[1]?.content, [{ type: "output_text", text: "Paris", annotations: [] }]);
    // The vendor's own counters land on the Responses detail fields.
    assert.deepEqual(payload.usage, {
      input_tokens: 91,
      input_tokens_details: { cached_tokens: 64 },
      output_tokens: 113,
      output_tokens_details: { reasoning_tokens: 99 },
      total_tokens: 204,
    });

    const telemetry = getResponseTelemetry(response);
    assert.equal(telemetry?.provider, "lithos");
    assert.equal(telemetry.reasoning, "high");
    assert.equal(telemetry.outputTokenAllowance, 256);

    // A tier this vendor refuses fails closed at the boundary: the Codex `ultra`
    // preset has no mapping on this wire, so no upstream dispatch happens.
    const rejected = await withUpstream(
      () => {
        throw new Error("a refused tier must never reach the vendor");
      },
      () =>
        handleResponses(
          responsesRequest({ model: LITHOS_MODEL, input: "hi", reasoning: { effort: "ultra" }, stream: false }),
          usageContext("lithos-responses-ultra")
        )
    );
    assert.equal(rejected.calls.length, 0);
    assert.equal(rejected.result.status, 400);
    const rejectedBody = (await rejected.result.json()) as { error?: { message?: string; type?: string; param?: string } };
    assert.equal(rejectedBody.error?.type, "invalid_request_error");
    assert.equal(rejectedBody.error.param, "reasoning.effort");
    assert.match(rejectedBody.error.message ?? "", /not supported by LithosAI/);
  });
});

test("lithos wiring: maps the vendor's refusal semantics distinctly", async () => {
  await withLithosKey(async () => {
    const message = [{ role: "user", content: "hi" }];

    // 402 out of credit: terminal, its own type and code, and explicitly
    // non-retryable. It must not be reported as a transient rate limit.
    const insufficientQuota = await withUpstream(
      () =>
        Response.json(
          { error: { message: "Your organization has no credit remaining.", type: "insufficient_quota", code: "insufficient_quota" } },
          { status: 402, headers: { "Content-Type": "application/json", "x-should-retry": "false" } }
        ),
      () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-402"))
    );
    assert.equal(insufficientQuota.result.status, 402);
    assert.equal(insufficientQuota.result.headers.get("x-uos-upstream"), "lithos");
    assert.equal(insufficientQuota.result.headers.get("x-should-retry"), "false");
    const quotaBody = (await insufficientQuota.result.json()) as { error?: { message?: string; type?: string; code?: string } };
    assert.equal(quotaBody.error?.type, "insufficient_quota");
    assert.equal(quotaBody.error.code, "insufficient_quota");
    assert.equal(quotaBody.error.message, "Your organization has no credit remaining.");
    assert.equal(getResponseTelemetry(insufficientQuota.result)?.failureKind, "upstream_http_error");

    // 429 budget refusal whose window is beyond the wait budget: a rate limit,
    // with the provider's capacity headers and both retry hints forwarded
    // unchanged and exactly one dispatch. The base tier has no sibling, so this
    // stays a pure relay case; the Ultra tier's sibling failover and its
    // wait-retry path each have their own tests below.
    const budgetRefusal = await withUpstream(
      () =>
        Response.json(
          { error: { message: "Rate limit exceeded for input_tokens.", type: "input_tokens", code: "rate_limit_exceeded" } },
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "x-ratelimit-limit-requests": "600",
              "x-ratelimit-remaining-requests": "0",
              "x-ratelimit-reset-requests": "12s",
              "x-ratelimit-limit-tokens": "200000",
              "x-ratelimit-remaining-tokens": "0",
              "x-ratelimit-reset-tokens": "45s",
              "retry-after-ms": "120000",
              "Retry-After": "17",
              "x-uos-provider-only": "must-not-be-relayed",
            },
          }
        ),
      () => handleChatCompletions(chatRequest({ model: LITHOS_BASE_MODEL, messages: message, stream: false }), usageContext("lithos-429-budget"))
    );
    assert.equal(budgetRefusal.result.status, 429);
    assert.equal(budgetRefusal.calls.length, 1, "a window beyond the wait budget is never waited out");
    assert.equal(budgetRefusal.result.headers.get("x-should-retry"), null, "a per-minute budget refusal stays retryable");
    for (const header of LITHOS_RATE_LIMIT_HEADERS) assert.notEqual(budgetRefusal.result.headers.get(header), null, `${header} must be forwarded`);
    assert.equal(budgetRefusal.result.headers.get("Retry-After"), "17");
    assert.equal(budgetRefusal.result.headers.get("retry-after-ms"), "120000");
    assert.equal(budgetRefusal.result.headers.get("x-uos-provider-only"), null);
    const budgetBody = (await budgetRefusal.result.json()) as { error?: { type?: string; code?: string } };
    assert.equal(budgetBody.error?.type, "rate_limit_error");
    assert.equal(budgetBody.error.code, "rate_limit_exceeded");

    // 429 model at capacity: still a 429, but its own code so the two causes are
    // never collapsed into one.
    const overloaded = await withUpstream(
      () => Response.json({ error: { message: "The model is at capacity.", type: "provider_overloaded", code: "provider_overloaded" } }, { status: 429 }),
      () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-429-overloaded"))
    );
    assert.equal(overloaded.result.status, 429);
    const overloadedBody = (await overloaded.result.json()) as { error?: { code?: string } };
    assert.equal(overloadedBody.error?.code, "provider_overloaded");

    // 404 unknown model: terminal model failure, not a gateway fault.
    const unknownModel = await withUpstream(
      () => Response.json({ error: { message: "The model does not exist.", type: "invalid_request_error", code: "model_not_found" } }, { status: 404 }),
      () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-404"))
    );
    assert.equal(unknownModel.result.status, 404);
    assert.equal(unknownModel.result.headers.get("x-should-retry"), "false");
    assert.equal(((await unknownModel.result.json()) as { error?: { code?: string } }).error?.code, "model_not_found");

    // The engine-parameter envelope carries an INTEGER code and no `error`
    // object; both envelopes are accepted, and neither throws.
    const engineViolation = await withUpstream(
      () =>
        Response.json(
          { object: "error", message: "Invalid value for 'n': must be 1", type: "BadRequestError", code: 400 },
          { status: 400, headers: { "Content-Type": "application/json" } }
        ),
      () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-400-engine"))
    );
    assert.equal(engineViolation.result.status, 400);
    assert.equal(engineViolation.result.headers.get("x-should-retry"), "false");
    const engineBody = (await engineViolation.result.json()) as { error?: { message?: string; type?: string; code?: string } };
    assert.equal(engineBody.error?.message, "Invalid value for 'n': must be 1");
    assert.equal(engineBody.error.type, "invalid_request_error");
    assert.equal(engineBody.error.code, "400");

    // A non-JSON body is tolerated: the gateway answers with its own bounded
    // message instead of throwing while rendering the failure.
    const nonJson = await withUpstream(
      () => new Response("<html>provider-only-body</html>", { status: 500, headers: { "Content-Type": "text/html" } }),
      () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-500"))
    );
    assert.equal(nonJson.result.status, 500);
    const nonJsonBody = (await nonJson.result.json()) as { error?: { message?: string; type?: string; code?: string } };
    assert.equal(nonJsonBody.error?.message, "LithosAI upstream returned an error.");
    assert.equal(nonJsonBody.error.type, "server_error");
    assert.equal(nonJsonBody.error.code, "lithos_upstream_error");
    assert.doesNotMatch(JSON.stringify(nonJsonBody), /provider-only-body/);
  });
});

test("lithos wiring: the catalog advertises eight addressable ids only while the key is configured", async () => {
  await withLithosKey(async () => {
    const snapshot = await withUpstream(
      () => new Response("{}", { status: 503 }),
      () => buildModelCatalogSnapshot()
    );
    // The gateway waterfall model also carries a lithos hop row; it is covered
    // by the admin-catalog suite, so this test owns the vendor ids themselves.
    const rows = snapshot.result.models.filter(
      (model) => model.id !== DEEPSEEK_WATERFALL_MODEL_ID && model.providers.some((provider) => provider.id === "lithos")
    );
    assert.equal(rows.length, LITHOS_MODEL_IDS.length);
    assert.deepEqual(
      rows.map((model) => model.id).sort((a, b) => a.localeCompare(b)),
      [...LITHOS_MODEL_IDS].sort((a, b) => a.localeCompare(b))
    );
    for (const row of rows) {
      // Every speed tier carries the same window and the route's endpoints:
      // `/v1/responses` is served by the gateway's translation.
      assert.equal(row.context_window_tokens, 1_048_576, `${row.id} context window`);
      assert.equal(row.max_context_window_tokens, 1_048_576, `${row.id} max context window`);
      assert.equal(row.effective_context_window_percent, 100, `${row.id} effective percent`);
      assert.deepEqual(row.providers[0]?.supported_endpoints, ["/v1/chat/completions", "/v1/responses"]);
      assert.deepEqual(row.supported_reasoning_levels, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
      assert.equal(row.default_reasoning_effort, "medium");
    }
    assert.deepEqual(snapshot.result.sources.lithos, { status: "available", count: 8, updated_at_ms: null, configured: true });

    // `/v1/models` and `/uos/model_capabilities` expose the same eight ids.
    const list = await withUpstream(
      () => new Response("{}", { status: 503 }),
      () => handleModels()
    );
    const listed = (await list.result.json()) as { data: { id: string }[] };
    for (const id of LITHOS_MODEL_IDS)
      assert.ok(
        listed.data.some((model) => model.id === id),
        `${id} must be listed`
      );

    const capabilities = await withUpstream(
      () => new Response("{}", { status: 503 }),
      () => handleModelCapabilities()
    );
    const capabilityBody = (await capabilities.result.json()) as { data: Record<string, unknown>[] };
    const lithosCapabilities = capabilityBody.data.filter((model) => model.upstream_provider === "lithos");
    assert.equal(lithosCapabilities.length, LITHOS_MODEL_IDS.length);
    for (const model of lithosCapabilities) {
      // All seven tiers are accepted verbatim, so no Codex preset is translated.
      assert.deepEqual(model.reasoning_effort_wire_map, {});
      assert.equal(model.default_reasoning_effort, "medium");
      assert.deepEqual(model.supported_endpoints, ["/v1/chat/completions", "/v1/responses"]);
      assert.equal(model.context_window_tokens, 1_048_576);
    }
  });

  await withoutLithosKey(async () => {
    const snapshot = await withUpstream(
      () => new Response("{}", { status: 503 }),
      () => buildModelCatalogSnapshot()
    );
    assert.equal(snapshot.result.models.filter((model) => model.providers.some((provider) => provider.id === "lithos")).length, 0);
    assert.deepEqual(snapshot.result.sources.lithos, { status: "unavailable", count: 0, updated_at_ms: null, configured: false });

    const list = await withUpstream(
      () => new Response("{}", { status: 503 }),
      () => handleModels()
    );
    const listed = (await list.result.json()) as { data: { id: string }[] };
    for (const id of LITHOS_MODEL_IDS)
      assert.equal(
        listed.data.some((model) => model.id === id),
        false,
        `${id} must not be advertised without a key`
      );
  });
});

test("lithos rate-limit waits follow the vendor's own header precedence", () => {
  const wait = (headers: Record<string, string>, nowMs = 1_000) => lithosRateLimitWait(new Headers(headers), nowMs);
  // `retry-after-ms` wins over every other hint, then `retry-after`, then the
  // later of the two per-minute refill deltas.
  assert.deepEqual(wait({ "retry-after-ms": "250", "Retry-After": "9", "x-ratelimit-reset-tokens": "30s" }), { waitMs: 250, source: "retry-after-ms" });
  assert.deepEqual(wait({ "Retry-After": "9" }), { waitMs: 9_000, source: "retry-after" });
  assert.deepEqual(wait({ "Retry-After": new Date(5_000).toUTCString() }), { waitMs: 4_000, source: "retry-after" });
  assert.deepEqual(wait({ "x-ratelimit-reset-tokens": "3.23s", "x-ratelimit-reset-requests": "12s" }), {
    waitMs: 12_000,
    source: "x-ratelimit-reset-requests",
  });
  assert.deepEqual(wait({ "x-ratelimit-reset-tokens": "1m30s" }), { waitMs: 90_000, source: "x-ratelimit-reset-tokens" });
  assert.deepEqual(wait({ "x-ratelimit-reset-requests": "750ms" }), { waitMs: 750, source: "x-ratelimit-reset-requests" });
  // The vendor's own instruction wins, and a refusal naming no window is never
  // given an invented one.
  assert.equal(wait({ "retry-after-ms": "5", "x-should-retry": "false" }), null);
  assert.equal(wait({}), null);
});

test("lithos rate-limit numeric headers reject nonfinite waits and retain finite precedence", () => {
  const oversizedDigits = "9".repeat(309);
  const overflowSeconds = "9".repeat(308);
  const wait = (headers: Record<string, string>) => lithosRateLimitWait(new Headers(headers), 1_000);
  assert.equal(Number.isFinite(Number(oversizedDigits)), false);
  assert.equal(Number.isFinite(Number(overflowSeconds)), true);
  assert.equal(wait({ "retry-after-ms": oversizedDigits }), null);
  assert.equal(wait({ "retry-after": oversizedDigits }), null);
  assert.equal(wait({ "retry-after": overflowSeconds }), null);
  assert.equal(wait({ "x-ratelimit-reset-tokens": `${oversizedDigits}s` }), null);
  assert.deepEqual(wait({ "retry-after-ms": oversizedDigits, "retry-after": "9", "x-ratelimit-reset-tokens": "30s" }), {
    waitMs: 9_000,
    source: "retry-after",
  });
  assert.deepEqual(wait({ "retry-after": overflowSeconds, "x-ratelimit-reset-tokens": "1.25s", "x-ratelimit-reset-requests": "750ms" }), {
    waitMs: 1_250,
    source: "x-ratelimit-reset-tokens",
  });
  assert.deepEqual(wait({ "retry-after-ms": overflowSeconds }), { waitMs: Number(overflowSeconds), source: "retry-after-ms" });
  assert.deepEqual(wait({ "retry-after-ms": "90000", "retry-after": "120" }), { waitMs: 90_000, source: "retry-after-ms" });
});

test("lithos rate-limit numeric windows reject nonfinite deadlines and keep finite expiry", () => {
  clearLithosFailoverWindows();
  try {
    for (const waitMs of [Infinity, -Infinity, NaN]) {
      lithosOpenFailoverWindow(LITHOS_MODEL, 1_000, waitMs, LITHOS_SIBLING_MODEL);
      assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 1_000), null);
    }
    lithosOpenFailoverWindow(LITHOS_MODEL, Number.MAX_VALUE, Number.MAX_VALUE, LITHOS_SIBLING_MODEL);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, Number.MAX_VALUE), null);

    // Sticky routing follows a finite vendor window even beyond the inline wait cap.
    lithosOpenFailoverWindow(LITHOS_MODEL, 1_000, 90_000, LITHOS_SIBLING_MODEL);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 1_000), LITHOS_SIBLING_MODEL);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 90_999), LITHOS_SIBLING_MODEL);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 91_000), null);
  } finally {
    clearLithosFailoverWindows();
  }
});

test("lithos refusal windows select the highest recovered rung at its own deadline", () => {
  clearLithosFailoverWindows();
  try {
    lithosOpenFailoverWindow(LITHOS_MODEL, 1_000, 60_000, LITHOS_SIBLING_MODEL);
    lithosOpenFailoverWindow(LITHOS_MODEL, 2_000, 1_000, LITHOS_BASE_MODEL);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 3_001), LITHOS_SIBLING_MODEL);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 60_999), LITHOS_SIBLING_MODEL);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 61_000), null);

    // An expired window does not extend a fresh short refusal.
    lithosOpenFailoverWindow(LITHOS_MODEL, 61_000, 1_000, LITHOS_SIBLING_MODEL);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 61_999), LITHOS_SIBLING_MODEL);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 62_000), null);

    lithosOpenFailoverWindow(LITHOS_MODEL, 100_000, 60_000, LITHOS_SIBLING_MODEL);
    lithosOpenFailoverWindow(LITHOS_MODEL, 101_000, 120_000, LITHOS_BASE_MODEL);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 160_000), null);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 220_999), null);
    assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, 221_000), null);
  } finally {
    clearLithosFailoverWindows();
  }
});

test("lithos refusal windows preserve each rung's own reset in handler routing", async () =>
  runSequence(async (step) => {
    await withLithosKey(async () => {
      const originalNow = Date.now;
      try {
        for (const waitMs of [1_000, 120_000]) {
          await step(`60s then ${waitMs}ms refusal`, async () => {
            clearLithosFailoverWindows();
            const initialNowMs = originalNow();
            let nowMs = initialNowMs;
            Date.now = () => nowMs;
            const message = [{ role: "user", content: "hi" }];
            const first = await withUpstream(
              (_call, calls) => {
                if (calls.length === 1) return lithosRateLimitRefusal("60000");
                if (calls.length === 2) {
                  nowMs = initialNowMs + 1_000;
                  return lithosRateLimitRefusal(String(waitMs));
                }
                return Response.json(lithosCompletion({ role: "assistant", content: "base-served" }, LITHOS_BASE_MODEL));
              },
              () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-window-overlap"))
            );
            assert.deepEqual(
              first.calls.map((call) => call.body.model),
              [LITHOS_MODEL, LITHOS_SIBLING_MODEL, LITHOS_BASE_MODEL]
            );
            assert.equal(first.result.status, 200);
            await first.result.json();

            nowMs = initialNowMs + 2_001;
            const second = await withUpstream(
              (call) => Response.json(lithosCompletion({ role: "assistant", content: "served" }, String(call.body.model))),
              () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-window-retained"))
            );
            assert.deepEqual(
              second.calls.map((call) => call.body.model),
              [waitMs === 1_000 ? LITHOS_SIBLING_MODEL : LITHOS_BASE_MODEL],
              "the highest recovered rung is selected"
            );
            assert.equal(second.result.status, 200);
            await second.result.json();

            const resetAtMs = initialNowMs + 60_000;
            assert.equal(lithosFailoverTargetAt(LITHOS_MODEL, resetAtMs - 1), second.calls[0].body.model);
            nowMs = resetAtMs;
            const third = await withUpstream(
              () => Response.json(lithosCompletion({ role: "assistant", content: "ultra-after-reset" })),
              () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-window-expired"))
            );
            assert.deepEqual(
              third.calls.map((call) => call.body.model),
              [LITHOS_MODEL],
              "the requested tier resumes at its own reset"
            );
            assert.equal(third.result.status, 200);
            await third.result.json();
          });
        }
      } finally {
        Date.now = originalNow;
        clearLithosFailoverWindows();
      }
    });
  }));

test("lithos rate-limit snapshots capture the vendor's own budgets, bounded", () => {
  const snapshot = lithosRateLimitSnapshot(
    new Headers({
      "x-ratelimit-limit-tokens": "4000000",
      "x-ratelimit-remaining-tokens": "607980",
      "x-ratelimit-reset-tokens": "50.88s",
      "retry-after": "51",
      "x-ratelimit-remaining-requests": "299",
      "x-should-retry": "false",
    })
  );
  assert.equal(snapshot.limit_tokens, 4_000_000);
  assert.equal(snapshot.remaining_tokens, 607_980);
  assert.equal(snapshot.reset_tokens, "50.88s");
  assert.equal(snapshot.retry_after, "51");
  assert.equal(snapshot.remaining_requests, 299);
  assert.equal(snapshot.should_retry, "false");
  // `x-should-retry: false` means no wait window is derived, and the snapshot stays bounded.
  assert.equal(snapshot.window_ms, null);
  assert.equal(snapshot.window_source, null);
  const bare = lithosRateLimitSnapshot(new Headers());
  assert.equal(bare.window_ms, null);
  assert.equal(bare.limit_tokens, null);
  assert.equal(bare.retry_after, null);
});

test("lithos wiring: an Ultra refusal fails over once to the sibling tier's own bucket", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    const message = [{ role: "user", content: "hi" }];
    const chat = await withUpstream(
      (_call, calls) =>
        calls.length === 1
          ? Response.json(
              { error: { message: "Rate limit exceeded for input_tokens.", type: "input_tokens", code: "rate_limit_exceeded" } },
              { status: 429, headers: { "Content-Type": "application/json", "retry-after-ms": "5000" } }
            )
          : Response.json(lithosCompletion({ role: "assistant", content: "sibling-served" }, LITHOS_SIBLING_MODEL)),
      () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-failover-chat"))
    );

    // The sibling is tried immediately instead of waiting the refused window
    // out, and the request it carries is otherwise unchanged.
    assert.equal(chat.calls.length, 2, "one failover attempt, no wait");
    assert.equal(chat.calls[0].body.model, LITHOS_MODEL);
    assert.equal(chat.calls[1].body.model, LITHOS_SIBLING_MODEL);
    assert.deepEqual(chat.calls[1].body.messages, message);
    assert.equal(chat.result.status, 200);
    const body = (await chat.result.json()) as { choices?: { message?: { content?: string } }[] };
    assert.equal(body.choices?.[0]?.message?.content, "sibling-served");
    const telemetry = getResponseTelemetry(chat.result);
    if (telemetry === null) throw new Error("the chat terminal carries no telemetry");
    assert.equal(telemetry.rateLimitFailoverModel, LITHOS_SIBLING_MODEL);
    assert.equal(telemetry.rateLimitWaitMs, null, "the failover itself needs no wait");
  });
});

test("lithos wiring: a refusal on both tiers is relayed without waiting", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    const message = [{ role: "user", content: "hi" }];
    const refusal = () =>
      Response.json(
        { error: { message: "Rate limit exceeded for input_tokens.", type: "input_tokens", code: "rate_limit_exceeded" } },
        // The vendor's own "do not retry" instruction: nothing may be waited out.
        {
          status: 429,
          headers: { "Content-Type": "application/json", "retry-after-ms": "5000", "x-ratelimit-reset-tokens": "0.02s", "x-should-retry": "false" },
        }
      );
    const chat = await withUpstream(refusal, () =>
      handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-429-relay"))
    );

    // The whole ladder - requested tier, fast, then the family's normal tier -
    // is tried with no wait, and the vendor's own refusal reaches the buffered
    // client unchanged once the bottom refuses too.
    assert.equal(chat.calls.length, 3, "every ladder tier is tried and no wait is taken");
    assert.equal(chat.calls[0].body.model, LITHOS_MODEL);
    assert.equal(chat.calls[1].body.model, LITHOS_SIBLING_MODEL);
    assert.equal(chat.calls[2].body.model, LITHOS_BASE_MODEL);
    assert.equal(chat.result.status, 429);
    const body = (await chat.result.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "rate_limit_exceeded");
    const telemetry = getResponseTelemetry(chat.result);
    if (telemetry === null) throw new Error("the chat terminal carries no telemetry");
    assert.equal(telemetry.rateLimitFailoverModel, LITHOS_BASE_MODEL);
    assert.equal(telemetry.rateLimitWaitMs, null, "no wait is taken by default");
    assert.equal(telemetry.streamTerminalType, "response.failed");
  });
});

test("lithos wiring: a refusal on both tiers is absorbed by the vendor's own window, then the requested tier answers", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    try {
      const message = [{ role: "user", content: "hi" }];
      const refusal = (waitMs: number) =>
        Response.json(
          { error: { message: "rate limit exceeded", type: "input_tokens", code: "rate_limit_exceeded" } },
          { status: 429, headers: { "Content-Type": "application/json", "retry-after-ms": String(waitMs) } }
        );
      const chat = await withUpstream(
        (_call, calls) => (calls.length <= 3 ? refusal(120) : Response.json(lithosCompletion({ role: "assistant", content: "after-window" }))),
        () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-429-absorb-chat"))
      );
      assert.equal(chat.calls.length, 4, "the whole ladder, then the requested tier again after the window");
      assert.equal(chat.calls[0].body.model, LITHOS_MODEL);
      assert.equal(chat.calls[1].body.model, LITHOS_SIBLING_MODEL);
      assert.equal(chat.calls[2].body.model, LITHOS_BASE_MODEL);
      assert.equal(chat.calls[3].body.model, LITHOS_MODEL, "the requested tier is retried after the window");
      assert.equal(chat.result.status, 200);
      const telemetry = getResponseTelemetry(chat.result);
      if (telemetry === null) throw new Error("the chat terminal carries no telemetry");
      assert.equal(telemetry.rateLimitWaitMs, 120, "the absorbed window is reported");
      assert.equal(telemetry.rateLimitFailoverModel, null, "the requested tier served after the absorbed window");
    } finally {
      clearLithosFailoverWindows();
    }
  });
});

test("lithos wiring: retry waits preserve deadline and caller cancellation without dispatching again", async () =>
  runSequence(async (step) => {
    await withLithosKey(async () => {
      for (const route of ["chat", "responses"]) {
        for (const timing of ["already", "during"]) {
          for (const kind of ["deadline", "cancellation"]) {
            await step(`${route} ${timing} ${kind}`, async () => {
              const controller = new AbortController();
              const reason = new DOMException("Retry wait fixture", kind === "deadline" ? "TimeoutError" : "AbortError");
              const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
              const abort = () => {
                controller.abort(reason);
              };
              // Inject the gateway deadline independently of the caller's signal.
              if (kind === "deadline") AbortSignal.timeout = () => controller.signal;
              try {
                const request = new Request(
                  route === "chat"
                    ? chatRequest({ model: LITHOS_BASE_MODEL, messages: [{ role: "user", content: "hi" }], stream: false })
                    : responsesRequest({ model: LITHOS_BASE_MODEL, input: "hi", stream: false }),
                  { signal: kind === "cancellation" ? controller.signal : null }
                );
                const { result, calls } = await withUpstream(
                  () => {
                    if (timing === "already") abort();
                    else setTimeout(abort, 0);
                    return lithosRateLimitRefusal("10000");
                  },
                  () =>
                    route === "chat"
                      ? handleChatCompletions(request, usageContext(`lithos-wait-${route}-${timing}-${kind}`))
                      : handleResponses(request, usageContext(`lithos-wait-${route}-${timing}-${kind}`))
                );
                assert.equal(result.status, kind === "deadline" ? 504 : 499);
                const body = (await result.json()) as { error?: { code?: string } };
                assert.equal(body.error?.code, kind === "deadline" ? "gateway_timeout" : "request_cancelled");
                assert.equal(calls.length, 1, "the refused request is never retried after abort");
                assert.equal(calls[0].url, LITHOS_CHAT_COMPLETIONS_URL);
                const telemetry = getResponseTelemetry(result);
                if (telemetry === null) throw new Error("The retry-wait terminal carries no telemetry.");
                assert.equal(telemetry.failureKind, kind);
                assert.equal(telemetry.streamTerminalType, kind === "deadline" ? "deadline" : "cancelled");
                assert.equal(telemetry.rateLimitWaitMs, 10_000, "the handler reached the vendor retry wait");
                await assert.rejects(waitForLithosRetry(10_000, controller.signal), (error) => error === reason);
              } finally {
                if (originalTimeout !== undefined) Object.defineProperty(AbortSignal, "timeout", originalTimeout);
              }
            });
          }
        }
      }
    });
  }));

test("lithos wiring: a window beyond the wait cap is relayed instead of absorbed", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    try {
      const message = [{ role: "user", content: "hi" }];
      const refusal = () =>
        Response.json(
          { error: { message: "rate limit exceeded", type: "input_tokens", code: "rate_limit_exceeded" } },
          { status: 429, headers: { "Content-Type": "application/json", "retry-after-ms": "120000" } }
        );
      const chat = await withUpstream(
        () => refusal(),
        () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-429-cap-chat"))
      );
      assert.equal(chat.calls.length, 3, "every ladder tier is tried, then the refusal is relayed");
      assert.equal(chat.result.status, 429);
      const body = (await chat.result.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "rate_limit_exceeded");
    } finally {
      clearLithosFailoverWindows();
    }
  });
});

test("lithos wiring: a streamed absorb spends the wider stream budget beyond two waits", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    try {
      // The vendor's window keeps naming a fresh 60 ms instant (the live shape
      // is ~51 s), and the streamed route spends THREE of them - past the
      // buffered route's two-wait / 120 s cap - because its stream is already
      // open and held by keepalives. Each window is preceded by a full ladder
      // descent (requested tier -> fast -> normal); the requested tier answers
      // on the tenth dispatch.
      const streamed = await withUpstream(
        (_call, calls) =>
          calls.length <= 9
            ? lithosRateLimitRefusal("60")
            : new Response(lithosStreamBody("after-many-windows"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
        async () => {
          const response = await handleResponses(
            responsesRequest({ model: LITHOS_MODEL, input: "hi", stream: true }),
            usageContext("lithos-429-stream-budget")
          );
          return { status: response.status, text: await response.text(), telemetry: getResponseTelemetry(response) };
        }
      );

      assert.equal(streamed.calls.length, 10, "three full ladder descents, then the requested tier after the third window");
      assert.deepEqual(
        streamed.calls.map((call) => call.body.model),
        [
          LITHOS_MODEL,
          LITHOS_SIBLING_MODEL,
          LITHOS_BASE_MODEL,
          LITHOS_MODEL,
          LITHOS_SIBLING_MODEL,
          LITHOS_BASE_MODEL,
          LITHOS_MODEL,
          LITHOS_SIBLING_MODEL,
          LITHOS_BASE_MODEL,
          LITHOS_MODEL,
        ]
      );
      assert.equal(streamed.result.status, 200);
      assert.match(streamed.result.text, /event: response\.completed/);
      const telemetry = streamed.result.telemetry;
      if (telemetry === null) throw new Error("the streamed terminal carries no telemetry");
      assert.equal(telemetry.rateLimitWaitMs, 180, "three vendor windows are absorbed behind the open stream");
      assert.equal(telemetry.streamTerminalType, "response.completed");
    } finally {
      clearLithosFailoverWindows();
    }
  });
});

test("lithos wiring: a streamed absorb that outlives the stream budget reports the refusal in-band", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    try {
      // Five windows (the streamed cap) are spent, then the vendor's refusal
      // travels as the stream's own terminal: response headers were long since
      // sent, so a 429 status can no longer be returned.
      const streamed = await withUpstream(
        () => lithosRateLimitRefusal("60"),
        async () => {
          const response = await handleResponses(
            responsesRequest({ model: LITHOS_MODEL, input: "hi", stream: true }),
            usageContext("lithos-429-stream-exhausted")
          );
          return { status: response.status, text: await response.text(), telemetry: getResponseTelemetry(response) };
        }
      );

      assert.equal(streamed.calls.length, 18, "three ladder tiers per cycle for five windows, plus the terminal pass");
      assert.equal(streamed.result.status, 200);
      assert.match(streamed.result.text, /"type":"response\.failed"/);
      assert.match(streamed.result.text, /rate_limit_exceeded/);
      assert.doesNotMatch(streamed.result.text, /event: response\.completed/);
      const telemetry = streamed.result.telemetry;
      if (telemetry === null) throw new Error("the streamed terminal carries no telemetry");
      assert.equal(telemetry.rateLimitWaitMs, 300, "the full streamed budget is reported");
      assert.equal(telemetry.streamTerminalType, "response.failed");
    } finally {
      clearLithosFailoverWindows();
    }
  });
});

test("lithos wiring: a streamed Chat absorb spends the wider stream budget beyond two waits", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    try {
      // The Chat Completions wire carries the agent workers; the same deferred
      // absorb must cover it, or their streamed requests keep surfacing 429s
      // after the buffered cap (the Mac log held 128 such client-visible 429s).
      const streamed = await withUpstream(
        (_call, calls) =>
          calls.length <= 9
            ? lithosRateLimitRefusal("60")
            : new Response(lithosStreamBody("after-many-windows"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
        async () => {
          const response = await handleChatCompletions(
            chatRequest({ model: LITHOS_MODEL, messages: [{ role: "user", content: "hi" }], stream: true }),
            usageContext("lithos-429-chat-stream-budget")
          );
          return { status: response.status, text: await response.text(), telemetry: getResponseTelemetry(response) };
        }
      );

      assert.equal(streamed.calls.length, 10, "three full ladder descents, then the requested tier after the third window");
      assert.deepEqual(
        streamed.calls.map((call) => call.body.model),
        [
          LITHOS_MODEL,
          LITHOS_SIBLING_MODEL,
          LITHOS_BASE_MODEL,
          LITHOS_MODEL,
          LITHOS_SIBLING_MODEL,
          LITHOS_BASE_MODEL,
          LITHOS_MODEL,
          LITHOS_SIBLING_MODEL,
          LITHOS_BASE_MODEL,
          LITHOS_MODEL,
        ]
      );
      assert.equal(streamed.result.status, 200);
      assert.match(streamed.result.text, /\[DONE\]/);
      const telemetry = streamed.result.telemetry;
      if (telemetry === null) throw new Error("the streamed terminal carries no telemetry");
      assert.equal(telemetry.rateLimitWaitMs, 180, "three vendor windows are absorbed behind the open stream");
      assert.equal(telemetry.streamTerminalType, "response.completed");
    } finally {
      clearLithosFailoverWindows();
    }
  });
});

test("lithos wiring: a streamed Chat absorb that outlives the stream budget reports the refusal in-band", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    try {
      const streamed = await withUpstream(
        () => lithosRateLimitRefusal("60"),
        async () => {
          const response = await handleChatCompletions(
            chatRequest({ model: LITHOS_MODEL, messages: [{ role: "user", content: "hi" }], stream: true }),
            usageContext("lithos-429-chat-stream-exhausted")
          );
          return { status: response.status, text: await response.text(), telemetry: getResponseTelemetry(response) };
        }
      );

      assert.equal(streamed.calls.length, 18, "three ladder tiers per cycle for five windows, plus the terminal pass");
      assert.equal(streamed.result.status, 200);
      assert.match(streamed.result.text, /rate_limit_exceeded/);
      assert.doesNotMatch(streamed.result.text, /\[DONE\]/);
      const telemetry = streamed.result.telemetry;
      if (telemetry === null) throw new Error("the streamed terminal carries no telemetry");
      assert.equal(telemetry.rateLimitWaitMs, 300, "the full streamed budget is reported");
      assert.equal(telemetry.streamTerminalType, "response.failed");
    } finally {
      clearLithosFailoverWindows();
    }
  });
});

test("lithos wiring: an Ultra refusal walks the whole ladder to the family's normal tier", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    try {
      const streamed = await withUpstream(
        (_call, calls) =>
          calls.length <= 2
            ? lithosRateLimitRefusal("60")
            : new Response(lithosStreamBody("base-served", LITHOS_BASE_MODEL), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
        async () => {
          const response = await handleResponses(responsesRequest({ model: LITHOS_MODEL, input: "hi", stream: true }), usageContext("lithos-ladder"));
          return { status: response.status, text: await response.text(), telemetry: getResponseTelemetry(response) };
        }
      );

      // ultra refused -> fast refused -> the family's normal tier answered, all
      // inside one request and without a wait: every rung is its own bucket.
      assert.deepEqual(
        streamed.calls.map((call) => call.body.model),
        [LITHOS_MODEL, LITHOS_SIBLING_MODEL, LITHOS_BASE_MODEL]
      );
      assert.equal(streamed.result.status, 200);
      assert.match(streamed.result.text, /event: response\.completed/);
      const telemetry = streamed.result.telemetry;
      if (telemetry === null) throw new Error("the streamed terminal carries no telemetry");
      assert.equal(telemetry.rateLimitFailoverModel, LITHOS_BASE_MODEL);
      assert.equal(telemetry.streamTerminalType, "response.completed");
    } finally {
      clearLithosFailoverWindows();
    }
  });
});

test("lithos wiring: a fast refusal deepens the open window to the normal tier for later requests", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    try {
      const message = [{ role: "user", content: "hi" }];
      const first = await withUpstream(
        (_call, calls) =>
          calls.length <= 2
            ? lithosRateLimitRefusal("60000")
            : Response.json(lithosCompletion({ role: "assistant", content: "base-served" }, LITHOS_BASE_MODEL)),
        () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-ladder-sticky-1"))
      );
      assert.deepEqual(
        first.calls.map((call) => call.body.model),
        [LITHOS_MODEL, LITHOS_SIBLING_MODEL, LITHOS_BASE_MODEL]
      );

      // The fast refusal re-pointed the (still open) window at the normal tier,
      // so the next request goes straight there instead of back to a saturated
      // ultra or fast.
      const second = await withUpstream(
        () => Response.json(lithosCompletion({ role: "assistant", content: "base-again" }, LITHOS_BASE_MODEL)),
        () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-ladder-sticky-2"))
      );
      assert.equal(second.calls.length, 1, "the sticky window serves without asking ultra or fast again");
      assert.equal(second.calls[0].body.model, LITHOS_BASE_MODEL);
      assert.equal(second.result.status, 200);
    } finally {
      clearLithosFailoverWindows();
    }
  });
});

test("lithos wiring: a streamed refusal reports in-band instead of an HTTP 429 status", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    const refusal = () =>
      Response.json(
        { error: { message: "Rate limit exceeded for input_tokens.", type: "input_tokens", code: "rate_limit_exceeded" } },
        // Unwaitable by the vendor's own instruction: no window is invented, and
        // the refusal still travels in-band - a streamed request never receives
        // an HTTP 429 from this route, which is what makes the client's
        // "retry-exhausted 429" banner unreachable here.
        { status: 429, headers: { "Content-Type": "application/json", "retry-after-ms": "5000", "x-should-retry": "false" } }
      );
    const streamed = await withUpstream(refusal, async () => {
      const response = await handleResponses(responsesRequest({ model: LITHOS_MODEL, input: "hi", stream: true }), usageContext("lithos-429-stream-relay"));
      return { status: response.status, text: await response.text(), telemetry: getResponseTelemetry(response) };
    });

    assert.equal(streamed.calls.length, 3, "every ladder tier is tried before the terminal replaces the status");
    assert.equal(streamed.result.status, 200);
    assert.match(streamed.result.text, /"type":"response\.failed"/);
    assert.match(streamed.result.text, /rate_limit_exceeded/);
    const telemetry = streamed.result.telemetry;
    if (telemetry === null) throw new Error("the streamed terminal carries no telemetry");
    assert.equal(telemetry.streamTerminalType, "response.failed");
  });
});

test("lithos wiring: a streamed refusal on both tiers is absorbed by the vendor's own window, then the requested tier streams", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    try {
      // The live incident shape: the client streams, both tiers refuse with the
      // vendor's own short window, and the retry after that window must be the
      // requested tier answering on the opened stream - never a 429 surfaced to
      // the client. The wait is the vendor's own 60 ms hint so the test stays
      // instantaneous.
      const frames = [
        {
          id: "chatcmpl-lithos-absorb",
          object: "chat.completion.chunk",
          created: 1_790_160_331,
          model: LITHOS_MODEL,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        },
        {
          id: "chatcmpl-lithos-absorb",
          object: "chat.completion.chunk",
          created: 1_790_160_331,
          model: LITHOS_MODEL,
          choices: [{ index: 0, delta: { content: "after-window" }, finish_reason: null }],
        },
        {
          id: "chatcmpl-lithos-absorb",
          object: "chat.completion.chunk",
          created: 1_790_160_331,
          model: LITHOS_MODEL,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
        {
          id: "chatcmpl-lithos-absorb",
          object: "chat.completion.chunk",
          created: 1_790_160_332,
          model: LITHOS_MODEL,
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: null, completion_tokens_details: { reasoning_tokens: 5 } },
        },
      ];
      const success = () => new Response(`${sseBody(frames)}data: [DONE]\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      const streamed = await withUpstream(
        (_call, calls) => (calls.length <= 3 ? lithosRateLimitRefusal("60") : success()),
        async () => {
          const response = await handleResponses(
            responsesRequest({ model: LITHOS_MODEL, input: "hi", stream: true }),
            usageContext("lithos-429-stream-absorb")
          );
          return { status: response.status, text: await response.text(), telemetry: getResponseTelemetry(response) };
        }
      );

      assert.equal(streamed.calls.length, 4, "the whole ladder, then the requested tier again after the window");
      assert.equal(streamed.calls[0].body.model, LITHOS_MODEL);
      assert.equal(streamed.calls[1].body.model, LITHOS_SIBLING_MODEL);
      assert.equal(streamed.calls[2].body.model, LITHOS_BASE_MODEL);
      assert.equal(streamed.calls[3].body.model, LITHOS_MODEL, "the requested tier is retried after the window");
      assert.equal(streamed.result.status, 200);
      assert.match(streamed.result.text, /event: response\.completed/);
      const telemetry = streamed.result.telemetry;
      if (telemetry === null) throw new Error("the streamed terminal carries no telemetry");
      assert.equal(telemetry.rateLimitWaitMs, 60, "the absorbed window is reported on the streamed terminal");
      assert.equal(telemetry.rateLimitFailoverModel, null, "the requested tier served after the absorbed window");
      assert.equal(telemetry.streamTerminalType, "response.completed");
    } finally {
      clearLithosFailoverWindows();
    }
  });
});

test("lithos wiring: only the mapped sibling may answer an Ultra request with a different model", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    const message = [{ role: "user", content: "hi" }];
    // No refusal happened, so nothing may explain a response naming another tier.
    const chat = await withUpstream(
      () => Response.json(lithosCompletion({ role: "assistant", content: "impostor" }, LITHOS_SIBLING_MODEL)),
      () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-echo-guard"))
    );
    assert.equal(chat.calls.length, 1, "no failover dispatched here");
    assert.equal(chat.calls[0].body.model, LITHOS_MODEL);
    assert.equal(chat.result.status, 502);
    const body = (await chat.result.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "lithos_upstream_invalid_response");
  });
});

test("lithos wiring: a differently-cased refused Ultra id serves from the sibling until reset", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    try {
      const message = [{ role: "user", content: "hi" }];
      const refusal = () =>
        Response.json(
          { error: { message: "Rate limit exceeded for input_tokens.", type: "input_tokens", code: "rate_limit_exceeded" } },
          { status: 429, headers: { "Content-Type": "application/json", "retry-after-ms": "400" } }
        );

      // The refusal opens the window and the sibling serves this request.
      const first = await withUpstream(
        (_call, calls) =>
          calls.length === 1 ? refusal() : Response.json(lithosCompletion({ role: "assistant", content: "sibling-served" }, LITHOS_SIBLING_MODEL)),
        () => handleChatCompletions(chatRequest({ model: LITHOS_MIXED_CASE_MODEL, messages: message, stream: false }), usageContext("lithos-window-first"))
      );
      assert.equal(first.calls.length, 2);
      assert.equal(first.calls[0].body.model, LITHOS_MODEL);
      assert.equal(first.calls[1].body.model, LITHOS_SIBLING_MODEL);

      // While the window is open the sibling answers directly: ultra is not asked again.
      const second = await withUpstream(
        () => Response.json(lithosCompletion({ role: "assistant", content: "sibling-direct" }, LITHOS_SIBLING_MODEL)),
        () => handleChatCompletions(chatRequest({ model: LITHOS_MIXED_CASE_MODEL, messages: message, stream: false }), usageContext("lithos-window-second"))
      );
      assert.equal(second.calls.length, 1, "one dispatch, straight to the sibling");
      assert.equal(second.calls[0].body.model, LITHOS_SIBLING_MODEL);
      const secondTelemetry = getResponseTelemetry(second.result);
      if (secondTelemetry === null) throw new Error("the chat terminal carries no telemetry");
      assert.equal(secondTelemetry.rateLimitFailoverModel, LITHOS_SIBLING_MODEL);
      assert.equal(secondTelemetry.rateLimitWaitMs, null, "the window never waits");
      assert.equal(second.result.status, 200);

      // After the vendor's own reset instant, ultra is asked first again.
      await new Promise((resolve) => setTimeout(resolve, 420));
      const third = await withUpstream(
        () => Response.json(lithosCompletion({ role: "assistant", content: "ultra-again" })),
        () => handleChatCompletions(chatRequest({ model: LITHOS_MIXED_CASE_MODEL, messages: message, stream: false }), usageContext("lithos-window-third"))
      );
      assert.equal(third.calls.length, 1);
      assert.equal(third.calls[0].body.model, LITHOS_MODEL, "the window closed and ultra is asked again");
      const thirdTelemetry = getResponseTelemetry(third.result);
      if (thirdTelemetry === null) throw new Error("the chat terminal carries no telemetry");
      assert.equal(thirdTelemetry.rateLimitFailoverModel, null, "the canonical requested tier served after reset");
    } finally {
      clearLithosFailoverWindows();
    }
  });
});

test("lithos wiring: a refusal on a tier with no configured sibling opens no window", async () => {
  await withLithosKey(async () => {
    clearLithosFailoverWindows();
    const message = [{ role: "user", content: "hi" }];
    // The base tier has no sibling, and a window beyond the cap is never absorbed,
    // so its refusal is relayed and nothing is remembered.
    const base = await withUpstream(
      () => lithosRateLimitRefusal("120000"),
      () => handleChatCompletions(chatRequest({ model: LITHOS_BASE_MODEL, messages: message, stream: false }), usageContext("lithos-scope-base"))
    );
    assert.equal(base.calls.length, 1);
    assert.equal(base.result.status, 429);

    const ultra = await withUpstream(
      () => Response.json(lithosCompletion({ role: "assistant", content: "ultra-first" })),
      () => handleChatCompletions(chatRequest({ model: LITHOS_MODEL, messages: message, stream: false }), usageContext("lithos-scope-ultra"))
    );
    assert.equal(ultra.calls[0].body.model, LITHOS_MODEL, "no window leaked onto the Ultra tier");
  });
});
