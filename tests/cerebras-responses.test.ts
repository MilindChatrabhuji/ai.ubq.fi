import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { Kv, KvEntryMaybe, KvKey, KvKeyPart, KvListSelector } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";

import { setKvForTest } from "../src/kv.ts";
import { handleResponses } from "../src/responses-handler.ts";
import { handleCodexCatalogModels } from "../src/catalog/index.ts";
import { getResponseTelemetry } from "../src/openai-telemetry.ts";
import { resetOpenRouterModelsCacheForTest } from "../src/models/openrouter-models.ts";
import { PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";
import { CODEX_CATALOG_AUTH_GENERATION_KEY } from "../src/catalog/types.ts";
import { CODEX_MODELS_KV_KEY } from "../src/codex/index.ts";
import { RUNTIME_CONFIG_V2_KEY } from "../src/runtime-config.ts";
import { CEREBRAS_CHAT_COMPLETIONS_URL, CEREBRAS_GPT_OSS_120B_MODEL, CEREBRAS_QWEN_3_8_27B_MODEL } from "../src/provider/cerebras.ts";
import { CEREBRAS_RESPONSES_PROFILE } from "../src/deepseek/responses.ts";
import { toDeepSeekResponsesChatBody } from "../src/deepseek/chat-projection.ts";
import { getCerebrasProviderHealth, PROVIDER_HEALTH_KEY_PREFIX, resetProviderHealthThrottleForTest } from "../src/provider/health.ts";

/**
 * Cerebras ids on the Codex Responses surface (module m01-cerebras-responses).
 *
 * Every fixture below is a recorded-shaped Cerebras Chat Completions payload
 * driven through the gateway's own handler with a recorded fetch; no test makes
 * a network call or touches the vendor. The credential-gated catalog rows are
 * asserted by switching the provider's own selection on and off.
 */

const GPT_OSS = CEREBRAS_GPT_OSS_120B_MODEL;
const QWEN = CEREBRAS_QWEN_3_8_27B_MODEL;
const CEREBRAS_API_KEY_ENV = "CEREBRAS_API_KEY";
const CEREBRAS_API_KEY = "cerebras_test_key";
const CODEX_AUTH_KEY = ["ubq_ai", "codex_auth"] as const;

// The catalog builder reads discovery credentials from the environment.
// Clearing them keeps this suite on the Cerebras provider it owns and keeps
// every other provider's discovery from reaching a network.
Reflect.deleteProperty(process.env, CEREBRAS_API_KEY_ENV);
delete process.env.METERED_API_KEY;
delete process.env.SURPLUS_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.LITHOSAI_API_KEY;

const keyOf = (key: KvKey): string => JSON.stringify(key);
const kvStore = new Map<string, unknown>();
const cerebrasHealthWrites: unknown[] = [];
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
      keys.map((key) => ({ key, value: kvStore.get(keyOf(key)) ?? null, versionstamp: kvStore.has(keyOf(key)) ? "1" : null }) as KvEntryMaybe<unknown>)
    ),
  set: (key: KvKey, value: unknown) => {
    kvStore.set(keyOf(key), value);
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    kvStore.delete(keyOf(key));
    return Promise.resolve();
  },
  list: async function* (selector: KvListSelector) {
    const prefix = "prefix" in selector ? selector.prefix : [];
    await Promise.resolve();
    for (const [encoded, value] of kvStore) {
      const key = JSON.parse(encoded) as KvKey;
      if (!prefix.every((part: KvKeyPart, index: number) => key[index] === part)) continue;
      yield { key, value, versionstamp: "00000000000000000001" };
    }
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
          if (op.type === "set") {
            kvStore.set(keyOf(op.key), op.value);
            if (keyOf(op.key) === keyOf([...PROVIDER_HEALTH_KEY_PREFIX, "cerebras", "default", "current"])) cerebrasHealthWrites.push(op.value);
          } else kvStore.delete(keyOf(op.key));
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

setKvForTest(kvStub);

type UpstreamCall = Readonly<{ url: string; body: Record<string, unknown> }>;
type UpstreamResult<T> = Readonly<{ result: T; calls: UpstreamCall[] }>;

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

/** Runs `run` with a recorded fetch; nothing in this suite can reach a real network. */
const withUpstream = async <T>(
  handler: (call: UpstreamCall, calls: readonly UpstreamCall[]) => Response | Promise<Response>,
  run: () => Promise<T>
): Promise<UpstreamResult<T>> => {
  const calls: UpstreamCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const call: UpstreamCall = {
      url: requestUrl(input),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
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

const responsesRequest = (body: Record<string, unknown>): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** One recorded buffered Chat completion, shaped like the vendor's wire. */
const chatCompletion = (model: string, message: Record<string, unknown>, finishReason = "stop", headers: Record<string, string> = {}): Response =>
  Response.json(
    {
      id: "chatcmpl-cerebras-1",
      object: "chat.completion",
      created: 1_790_100_000,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: 21,
        completion_tokens: 13,
        total_tokens: 34,
        prompt_tokens_details: { cached_tokens: 8 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    },
    { headers: { "x-request-id": "cerebras-req-1", ...headers } }
  );

const RESPONSES_USAGE = {
  input_tokens: 21,
  input_tokens_details: { cached_tokens: 8 },
  output_tokens: 13,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 34,
};

/** Runs `run` with the provider credential configured, restoring the ambient value after. */
const withCerebrasKey = async (run: () => Promise<void>): Promise<void> => {
  const previous = process.env[CEREBRAS_API_KEY_ENV];
  process.env[CEREBRAS_API_KEY_ENV] = CEREBRAS_API_KEY;
  try {
    await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, CEREBRAS_API_KEY_ENV);
    else process.env[CEREBRAS_API_KEY_ENV] = previous;
  }
};

test("cerebras responses: a qwen-3.8-27b round trip translates the body and returns a Responses object", async () => {
  await withCerebrasKey(async () => {
    const { result, calls } = await withUpstream(
      () => chatCompletion(QWEN, { role: "assistant", content: "pong", reasoning: "The request asked for one word." }),
      () => handleResponses(responsesRequest({ model: QWEN, input: "Say pong.", reasoning: { effort: "none" }, max_output_tokens: 512 }))
    );

    assert.equal(result.status, 200);
    assert.equal(result.headers.get("x-uos-upstream"), "cerebras");
    const payload = (await result.json()) as Record<string, unknown>;
    assert.equal(payload.object, "response");
    assert.equal(payload.status, "completed");
    assert.equal(payload.model, QWEN);
    assert.equal(payload.incomplete_details, null);
    assert.deepEqual(payload.output, [
      {
        id: "rs_resp_cerebrasreq1_0",
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "The request asked for one word." }],
      },
      {
        id: "msg_resp_cerebrasreq1_0",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "pong", annotations: [] }],
      },
    ]);
    assert.deepEqual(payload.usage, RESPONSES_USAGE);

    // The translated Chat body: the canonical id, the client's explicit
    // no-reasoning tier verbatim, and never an upstream stream request.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CEREBRAS_CHAT_COMPLETIONS_URL);
    assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "Say pong." }]);
    assert.equal(calls[0].body.model, QWEN);
    assert.equal(calls[0].body.reasoning_effort, "none");
    assert.equal(calls[0].body.max_tokens, 512);
    assert.equal(calls[0].body.stream, false);
    assert.equal("stream_options" in calls[0].body, false);
  });
});

/**
 * Qwen's chat template accepts exactly one `system` message and requires it
 * first, while the shared translation emits one for `instructions` and one for
 * each `developer` input item. A Codex client sends both, which used to reach
 * the provider as two `system` messages and fail the whole turn with
 * `wrong_api_format`; the body dispatched after the collapse is recorded here.
 */
test("cerebras responses: instructions and a leading developer item collapse into one leading system message", async () => {
  await withCerebrasKey(async () => {
    const { result, calls } = await withUpstream(
      () => chatCompletion(QWEN, { role: "assistant", content: "pong" }),
      () =>
        handleResponses(
          responsesRequest({
            model: QWEN,
            instructions: "Follow the house style.",
            input: [
              { type: "message", role: "developer", content: "Answer in one word." },
              { type: "message", role: "user", content: "Say pong." },
            ],
            reasoning: { effort: "none" },
          })
        )
    );

    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.messages, [
      { role: "system", content: "Follow the house style.\n\nAnswer in one word." },
      { role: "user", content: "Say pong." },
    ]);
  });
});

test("cerebras responses: rejects non-text developer content instead of dropping it", async () => {
  await withCerebrasKey(async () => {
    const { result, calls } = await withUpstream(
      () => {
        throw new Error("unsupported content must not reach Cerebras");
      },
      () =>
        handleResponses(
          responsesRequest({
            model: QWEN,
            instructions: "Follow the house style.",
            input: [
              {
                type: "message",
                role: "developer",
                content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
              },
              { type: "message", role: "user", content: "Say pong." },
            ],
            reasoning: { effort: "none" },
          })
        )
    );

    assert.equal(result.status, 400);
    assert.equal(calls.length, 0);
    const payload = (await result.json()) as { error?: { code?: string; type?: string; message?: string } };
    assert.equal(payload.error?.code, "cerebras_request_invalid");
    assert.equal(payload.error.type, "invalid_request_error");
    assert.match(payload.error.message ?? "", /only text content/);
  });
});

test("cerebras responses: a mid-list developer item collapses into one leading system message", async () => {
  await withCerebrasKey(async () => {
    const { result, calls } = await withUpstream(
      () => chatCompletion(QWEN, { role: "assistant", content: "pong" }),
      () =>
        handleResponses(
          responsesRequest({
            model: QWEN,
            input: [
              { type: "message", role: "user", content: "First." },
              { type: "message", role: "developer", content: "Be brief." },
              { type: "message", role: "user", content: "Second." },
            ],
            reasoning: { effort: "none" },
          })
        )
    );

    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    // The developer item's text leads the turn as the only `system` message and
    // the user turns keep their order.
    assert.deepEqual(calls[0].body.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "First." },
      { role: "user", content: "Second." },
    ]);
  });
});

test("cerebras responses: gpt-oss-120b is served on /v1/responses instead of being refused", async () => {
  await withCerebrasKey(async () => {
    const { result, calls } = await withUpstream(
      () => chatCompletion(GPT_OSS, { role: "assistant", content: "pong" }),
      () => handleResponses(responsesRequest({ model: GPT_OSS, input: "Say pong.", reasoning: { effort: "medium" } }))
    );

    assert.equal(result.status, 200);
    const payload = (await result.json()) as Record<string, unknown>;
    assert.equal(payload.status, "completed");
    assert.equal(payload.model, GPT_OSS);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CEREBRAS_CHAT_COMPLETIONS_URL);
    assert.equal(calls[0].body.model, GPT_OSS);
  });
});

test("cerebras responses: advertised tiers pass through and an unadvertised tier fails closed", async () => {
  // `none` is advertised by qwen-3.8-27b alone, so the route's union admits it
  // and the per-id transport enforcement rejects it for gpt-oss-120b.
  const qwen = toDeepSeekResponsesChatBody({ input: "hi", reasoning: { effort: "none" } }, QWEN, false, CEREBRAS_RESPONSES_PROFILE);
  assert.equal(qwen.ok, true);
  assert.equal(qwen.value.body.reasoning_effort, "none");
  for (const id of [QWEN, GPT_OSS]) {
    // `ultra` is a client preset this route refuses; it is never mapped to `max`.
    const ultra = toDeepSeekResponsesChatBody({ input: "hi", reasoning: { effort: "ultra" } }, id, false, CEREBRAS_RESPONSES_PROFILE);
    assert.deepEqual(ultra, { ok: false, param: "reasoning.effort", message: "reasoning.effort 'ultra' is not supported by Cerebras" });
  }

  await withCerebrasKey(async () => {
    const ultra = await withUpstream(
      () => {
        throw new Error("an unadvertised tier must not dispatch");
      },
      () => handleResponses(responsesRequest({ model: GPT_OSS, input: "hi", reasoning: { effort: "ultra" } }))
    );
    assert.equal(ultra.result.status, 400);
    assert.equal(((await ultra.result.json()) as { error?: { param?: string } }).error?.param, "reasoning.effort");
    assert.equal(ultra.calls.length, 0);

    const noneOnGptOss = await withUpstream(
      () => {
        throw new Error("an unsupported tier must not dispatch");
      },
      () => handleResponses(responsesRequest({ model: GPT_OSS, input: "hi", reasoning: { effort: "none" } }))
    );
    assert.equal(noneOnGptOss.result.status, 400);
    const refusal = (await noneOnGptOss.result.json()) as { error: { param?: string; message?: string } };
    assert.equal(refusal.error.param, "reasoning_effort");
    assert.match(refusal.error.message ?? "", /reasoning_effort 'none' is not supported for gpt-oss-120b\. Use low, medium, high\./);
    assert.equal(noneOnGptOss.calls.length, 0);
  });
});

test("cerebras responses: a streamed request replays the buffered completion as the Responses event sequence", async () => {
  await withCerebrasKey(async () => {
    const { result, calls } = await withUpstream(
      () => chatCompletion(QWEN, { role: "assistant", content: "pong", reasoning: "The request asked for one word." }),
      () => handleResponses(responsesRequest({ model: QWEN, input: "Say pong.", stream: true }))
    );

    assert.equal(result.status, 200);
    assert.equal(result.headers.get("content-type"), "text/event-stream");
    const frames = (await result.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("event: "))
      .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + "data: ".length)) as Record<string, unknown>);

    const types = frames.map((frame) => String(frame.type));
    for (const expected of [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
    ]) {
      assert.ok(types.includes(expected), `${expected} must be part of the replayed sequence`);
    }
    assert.equal(types.at(-1), "response.completed");
    // The official Responses events carry a monotonic per-response sequence number.
    assert.deepEqual(
      frames.map((frame) => frame.sequence_number),
      frames.map((_, index) => index)
    );

    const terminal = frames.at(-1)?.response as Record<string, unknown>;
    assert.equal(terminal.status, "completed");
    assert.deepEqual(terminal.output, [
      {
        id: "rs_resp_cerebrasreq1_0",
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "The request asked for one word." }],
      },
      {
        id: "msg_resp_cerebrasreq1_0",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "pong", annotations: [] }],
      },
    ]);
    assert.deepEqual(terminal.usage, RESPONSES_USAGE);

    // The replayed burst came from one buffered upstream call, never a stream.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.stream, false);
    assert.equal("stream_options" in calls[0].body, false);
  });
});

test("cerebras responses: translated tool schemas reach the upstream through the Cerebras projection", async () => {
  await withCerebrasKey(async () => {
    const { result, calls } = await withUpstream(
      () => chatCompletion(GPT_OSS, { role: "assistant", content: "done" }),
      () =>
        handleResponses(
          responsesRequest({
            model: GPT_OSS,
            input: "Use the lookup tool.",
            reasoning: { effort: "medium" },
            tools: [
              {
                type: "function",
                name: "lookup",
                description: "Looks one value up.",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  properties: { query: { type: "string", minLength: 1, pattern: "^[a-z]+$", format: "email" } },
                  required: ["query"],
                },
              },
            ],
          })
        )
    );

    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    const tools = calls[0].body.tools as { function: { name: string; parameters: Record<string, unknown> } }[];
    assert.equal(tools.length, 1);
    assert.equal(tools[0].function.name, "lookup");
    // The provider rejects those keywords at schema positions, so they are
    // projected away before dispatch while the schema itself survives.
    assert.deepEqual(tools[0].function.parameters, {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });
});

test("cerebras responses: a reasoning-only truncation fails closed instead of returning an empty answer", async () => {
  await withCerebrasKey(async () => {
    for (const stream of [false, true]) {
      const { result } = await withUpstream(
        // Recorded shape: the provider spent the whole budget on reasoning, so
        // the answer carries `content: null` and `finish_reason: "length"`.
        () => chatCompletion(GPT_OSS, { role: "assistant", content: null, reasoning: "Budget spent mid-thought." }, "length"),
        () => handleResponses(responsesRequest({ model: GPT_OSS, input: "Explain everything.", max_output_tokens: 16, stream }))
      );

      assert.equal(result.status, 502, `stream=${stream}`);
      const payload = (await result.json()) as { error?: { code?: string } };
      assert.equal(payload.error?.code, "cerebras_upstream_invalid_response");
      assert.equal(getResponseTelemetry(result)?.failureKind, "invalid_completion_schema");
    }
  });
});

for (const stream of [false, true]) {
  for (const [finishReason, status, failureKind] of [
    ["length", "incomplete", "incomplete_response"],
    ["insufficient_system_resource", "failed", "upstream_error"],
    ["stop", "completed", null],
  ] as const) {
    test(`cerebras responses: ${finishReason} terminal health stream=${stream}`, async () => {
      await withCerebrasKey(async () => {
        const originalNow = Date.now;
        let nowMs = 1_000_000;
        Date.now = () => nowMs;
        try {
          // Drain the optional health writes before resetting the isolated fixture.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          kvStore.clear();
          resetProviderHealthThrottleForTest();
          cerebrasHealthWrites.length = 0;
          nowMs = 1_000_000;
          const successAtMs = nowMs;
          const seeded = await withUpstream(
            () => chatCompletion(GPT_OSS, { role: "assistant", content: "prior answer" }),
            () => handleResponses(responsesRequest({ model: GPT_OSS, input: "Seed a success." }))
          );
          assert.equal(seeded.result.status, 200);
          assert.equal(((await seeded.result.json()) as Record<string, unknown>).status, "completed");
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          assert.equal((await getCerebrasProviderHealth()).last_success_at_ms, successAtMs);
          cerebrasHealthWrites.length = 0;
          // Separate observations beyond the heartbeat window so an erroneous
          // success cannot hide behind throttling or equal timestamps.
          nowMs += 61_000;
          const { result, calls } = await withUpstream(
            () => chatCompletion(GPT_OSS, { role: "assistant", content: "partial answer" }, finishReason),
            () => handleResponses(responsesRequest({ model: GPT_OSS, input: "Answer.", stream }))
          );
          assert.equal(result.status, 200);
          const terminalType = `response.${status}`;
          let payload: Record<string, unknown>;
          if (stream) {
            assert.equal(result.headers.get("content-type"), "text/event-stream");
            const frames = (await result.text())
              .split("\n\n")
              .filter((frame) => frame.startsWith("event: "))
              .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + "data: ".length)) as Record<string, unknown>);
            const terminals = frames.filter((frame) => ["response.completed", "response.incomplete", "response.failed"].includes(String(frame.type)));
            assert.equal(terminals.length, 1);
            assert.equal(frames.at(-1)?.type, terminalType);
            payload = terminals[0].response as Record<string, unknown>;
          } else {
            payload = (await result.json()) as Record<string, unknown>;
          }
          assert.equal(payload.status, status);
          assert.ok(JSON.stringify(payload.output).includes("partial answer"));
          if (status === "incomplete") assert.deepEqual(payload.incomplete_details, { reason: "max_output_tokens" });
          assert.equal(getResponseTelemetry(result)?.streamTerminalType, terminalType);
          assert.equal(getResponseTelemetry(result)?.failureKind, failureKind);
          // Both client transports still use one buffered provider dispatch.
          assert.equal(calls.length, 1);
          assert.equal(calls[0].body.stream, false);
          assert.equal("stream_options" in calls[0].body, false);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          const event = status === "failed" ? "upstream_error" : "success";
          assert.deepEqual(cerebrasHealthWrites, [{ event, status: 200, observed_at_ms: nowMs, provider_request_id: "cerebras-req-1" }]);
          const health = await getCerebrasProviderHealth();
          assert.equal(health.state, event === "success" ? "healthy" : "degraded");
          assert.equal(health.last_event, event);
          assert.equal(health.last_status, 200);
          assert.equal(health.last_success_at_ms, event === "success" ? nowMs : successAtMs);
          assert.equal(health.last_error_at_ms, event === "success" ? null : nowMs);
          assert.deepEqual(kvStore.get(keyOf([...PROVIDER_HEALTH_KEY_PREFIX, "cerebras", "default", event])), cerebrasHealthWrites[0]);
        } finally {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          Date.now = originalNow;
          resetProviderHealthThrottleForTest();
          kvStore.clear();
          cerebrasHealthWrites.length = 0;
        }
      });
    });
  }
}

const seedCatalogKv = (): void => {
  kvStore.clear();
  resetProviderSelectionCacheForTest();
  resetOpenRouterModelsCacheForTest();
  kvStore.set(keyOf(CODEX_CATALOG_AUTH_GENERATION_KEY), "catalog-generation-fixture");
  kvStore.set(keyOf(CODEX_AUTH_KEY), {
    accounts: [{ access_token: "access", refresh_token: "refresh", account_id: "account", updated_at_ms: Date.now() }],
    updated_at_ms: Date.now(),
  });
  const snapshot = { source: "chatgpt_codex", client_version: "0.150.0", updated_at_ms: Date.now(), models: [{ slug: "gpt-5.6-fixture" }] };
  kvStore.set(keyOf(CODEX_MODELS_KV_KEY), snapshot);
  kvStore.set(keyOf(RUNTIME_CONFIG_V2_KEY), {
    version: 2,
    default_model: "gpt-5.6-fixture",
    default_reasoning_effort: "medium",
    codex_models: snapshot,
    updated_at_ms: Date.now(),
  });
};

const catalogRequest = (version: string): Request => new Request(`https://ai.ubq.fi/v1/models?client_version=${version}`);

const versionedCatalog = async (version: string): Promise<{ models: Record<string, unknown>[] }> => {
  const { result } = await withUpstream(
    () =>
      new Response(JSON.stringify({ models: [{ slug: "gpt-5.6-fixture", supported_reasoning_levels: [{ effort: "medium", description: "medium" }] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: `"${version}"` },
      }),
    () => handleCodexCatalogModels(catalogRequest(version), version)
  );
  assert.equal(result.status, 200);
  return (await result.json()) as { models: Record<string, unknown>[] };
};

test("cerebras responses: the versioned Codex catalog advertises both ids only while the provider is enabled", async () => {
  seedCatalogKv();
  const gptOssRow = {
    slug: GPT_OSS,
    display_name: "GPT-OSS 120B",
    owned_by: "cerebras",
    supported_endpoint_types: ["openai-response", "openai-chat"],
    supported_reasoning_levels: [
      { effort: "low", description: "Reasoning effort: low" },
      { effort: "medium", description: "Reasoning effort: medium" },
      { effort: "high", description: "Reasoning effort: high" },
    ],
    default_reasoning_level: "medium",
    context_window: 131_072,
    max_context_window: 131_072,
    visibility: "list",
  };

  await withCerebrasKey(async () => {
    const payload = await versionedCatalog("0.150.0");
    const cerebrasRows = payload.models.filter((model) => model.owned_by === "cerebras");
    assert.deepEqual(
      cerebrasRows.map((model) => model.slug),
      [GPT_OSS, QWEN]
    );
    const gptOss = payload.models.find((model) => model.slug === GPT_OSS);
    assert.ok(gptOss, "gpt-oss-120b must be advertised");
    for (const [key, value] of Object.entries(gptOssRow)) assert.deepEqual(gptOss[key], value, key);
    const qwen = payload.models.find((model) => model.slug === QWEN);
    assert.ok(qwen, "qwen-3.8-27b must be advertised");
    assert.deepEqual(qwen.supported_reasoning_levels, [
      { effort: "none", description: "No reasoning" },
      { effort: "low", description: "Reasoning effort: low" },
      { effort: "medium", description: "Reasoning effort: medium" },
      { effort: "high", description: "Reasoning effort: high" },
    ]);
    assert.equal(qwen.default_reasoning_level, "high");
    assert.equal(qwen.context_window, 131_072);
    assert.equal(qwen.max_context_window, 131_072);
    assert.deepEqual(qwen.supported_endpoint_types, ["openai-response", "openai-chat"]);
    // The stored Codex row is untouched beside them.
    assert.ok(payload.models.some((model) => model.slug === "gpt-5.6-fixture"));
  });

  // A switched-off provider contributes no rows even with its credential set.
  kvStore.set(keyOf(PROVIDER_SELECTION_KV_KEY), { provider_ids: ["codex"], updated_at_ms: Date.now() });
  resetProviderSelectionCacheForTest();
  await withCerebrasKey(async () => {
    const payload = await versionedCatalog("0.151.0");
    assert.equal(
      payload.models.some((model) => model.slug === GPT_OSS || model.slug === QWEN),
      false
    );
  });

  // Without the credential the provider has nothing configured to advertise.
  kvStore.delete(keyOf(PROVIDER_SELECTION_KV_KEY));
  resetProviderSelectionCacheForTest();
  const payload = await versionedCatalog("0.152.0");
  assert.equal(
    payload.models.some((model) => model.slug === GPT_OSS || model.slug === QWEN),
    false
  );
  resetProviderSelectionCacheForTest();
});
