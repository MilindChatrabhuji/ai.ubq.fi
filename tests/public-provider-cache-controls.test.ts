import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { Kv } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";

import { handleChatCompletions } from "../src/chat/envelope.ts";
import { setKvForTest } from "../src/kv.ts";
import { fetchOpenRouterModels, resetOpenRouterModelsCacheForTest, setOpenRouterModelsFetchForTest } from "../src/models/openrouter-models.ts";
import { CHAT_COMPLETIONS_REQUEST_KEYS, RESPONSES_REQUEST_KEYS } from "../src/openai-schema.ts";
import { OPENROUTER_CHAT_COMPLETIONS_URL, OPENROUTER_RESPONSES_URL } from "../src/provider/openrouter.ts";
import { CEREBRAS_CHAT_COMPLETIONS_URL, CEREBRAS_QWEN_3_8_27B_MODEL } from "../src/provider/cerebras.ts";
import { resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import { PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";
import { handleResponses } from "../src/responses-handler.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const requestUrl = (value: RequestInfo | URL): string => {
  if (typeof value === "string") return value;
  return value instanceof URL ? value.href : value.url;
};
const requestBody = (init: RequestInit | undefined): Record<string, unknown> => {
  if (typeof init?.body !== "string") throw new Error("Expected a serialized upstream JSON request.");
  return JSON.parse(init.body) as Record<string, unknown>;
};

const CLAUDE_MODEL = "~anthropic/claude-opus-latest";
const routes = [
  { path: "/v1/responses", endpoint: OPENROUTER_RESPONSES_URL, input: { input: "Stable prefix" }, handler: handleResponses },
  {
    path: "/v1/chat/completions",
    endpoint: OPENROUTER_CHAT_COMPLETIONS_URL,
    input: { messages: [{ role: "user", content: "Stable prefix" }] },
    handler: handleChatCompletions,
  },
] as const;

const withCatalogue = async (run: (kv: CountingKv) => Promise<void>): Promise<void> => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const kv = new CountingKv();
  setKvForTest(kv as unknown as Kv);
  resetProviderSelectionCacheForTest();
  resetProviderHealthThrottleForTest();
  resetOpenRouterModelsCacheForTest();
  process.env.OPENROUTER_API_KEY = "fixture-key";
  setOpenRouterModelsFetchForTest(createFetchMock(() => Promise.resolve(Response.json({ data: [{ id: CLAUDE_MODEL }, { id: "vendor/alpha" }] }))));
  try {
    await fetchOpenRouterModels();
    await run(kv);
  } finally {
    setKvForTest(null);
    resetProviderSelectionCacheForTest();
    resetProviderHealthThrottleForTest();
    setOpenRouterModelsFetchForTest(null);
    resetOpenRouterModelsCacheForTest();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
};

const requestFor = (path: string, body: Record<string, unknown>): Request =>
  new Request(`https://ai.ubq.fi${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("public Claude OpenRouter routes preserve an explicit native cache policy through validation", async () => {
  await withCatalogue(async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const route of routes) {
        const policy = { type: "ephemeral", ttl: "1h" };
        let calls = 0;
        globalThis.fetch = createFetchMock((url: RequestInfo | URL, init?: RequestInit) => {
          calls += 1;
          assert.equal(requestUrl(url), route.endpoint);
          const body = requestBody(init);
          assert.deepEqual(body.cache_control, policy);
          assert.equal(body.model, CLAUDE_MODEL);
          assert.equal(body.prompt_cache_key, "caller-key");
          return Promise.resolve(
            Response.json(
              route.path === "/v1/responses"
                ? {
                    id: "resp_fixture",
                    object: "response",
                    status: "completed",
                    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
                    usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101, input_tokens_details: { cached_tokens: 90 } },
                  }
                : {
                    id: "chat_fixture",
                    object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: 90 } },
                  }
            )
          );
        });
        const response = await route.handler(
          requestFor(route.path, { model: CLAUDE_MODEL, ...route.input, cache_control: policy, prompt_cache_key: "caller-key" })
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-upstream"), "openrouter");
        assert.equal(calls, 1);
        await response.text();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Claude's native cache extension never widens official schemas or other provider routes", async () => {
  assert.equal(new Set<string>(CHAT_COMPLETIONS_REQUEST_KEYS).has("cache_control"), false);
  assert.equal(new Set<string>(RESPONSES_REQUEST_KEYS).has("cache_control"), false);
  await withCatalogue(async (kv) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = createFetchMock(() => {
      calls += 1;
      throw new Error("invalid provider extensions must never dispatch");
    });
    try {
      for (const route of routes) {
        for (const model of ["vendor/alpha", "gpt-5-fixture", "claude-opus-5.5", "~anthropic/claude-unlisted"]) {
          const response = await route.handler(requestFor(route.path, { model, ...route.input, cache_control: { type: "ephemeral" } }));
          assert.equal(response.status, 400);
          assert.match((await response.json()).error.message, /Unrecognized request argument supplied: cache_control/);
        }
      }
      kv.seed(PROVIDER_SELECTION_KV_KEY, { provider_ids: ["codex"], updated_at_ms: Date.now() });
      resetProviderSelectionCacheForTest();
      for (const route of routes) {
        const response = await route.handler(requestFor(route.path, { model: CLAUDE_MODEL, ...route.input, cache_control: { type: "ephemeral" } }));
        assert.equal(response.status, 400);
        await response.text();
      }
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("public Claude cache policies reject malformed native controls before transport", async () => {
  await withCatalogue(async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = createFetchMock(() => {
      calls += 1;
      throw new Error("malformed cache policies must never dispatch");
    });
    try {
      for (const route of routes) {
        for (const [control, param] of [
          [null, "cache_control"],
          [{ type: "permanent" }, "cache_control.type"],
          [{ type: "ephemeral", ttl: "24h" }, "cache_control.ttl"],
          [{ type: "ephemeral", unknown: true }, "cache_control.unknown"],
        ] as const) {
          const response = await route.handler(requestFor(route.path, { model: CLAUDE_MODEL, ...route.input, cache_control: control }));
          assert.equal(response.status, 400);
          assert.equal((await response.json()).error.param, param);
        }
      }
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("public Cerebras Responses retains its documented cache-routing key at the actual Chat transport", async () => {
  await withCatalogue(async () => {
    const originalFetch = globalThis.fetch;
    const previousKey = process.env.CEREBRAS_API_KEY;
    process.env.CEREBRAS_API_KEY = "fixture-cerebras-key";
    let calls = 0;
    globalThis.fetch = createFetchMock((url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      assert.equal(requestUrl(url), CEREBRAS_CHAT_COMPLETIONS_URL);
      const body = requestBody(init);
      assert.equal(body.prompt_cache_key, "caller-cerebras-key");
      return Promise.resolve(
        Response.json({
          id: "cerebras_fixture",
          object: "chat.completion",
          created: 1,
          model: CEREBRAS_QWEN_3_8_27B_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101, prompt_tokens_details: { cached_tokens: 90 } },
        })
      );
    });
    try {
      const response = await handleResponses(
        requestFor("/v1/responses", {
          model: CEREBRAS_QWEN_3_8_27B_MODEL,
          input: "Stable prefix",
          reasoning: { effort: "none" },
          prompt_cache_key: "caller-cerebras-key",
        })
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
      const payload = await response.json();
      assert.equal(payload.usage.input_tokens_details.cached_tokens, 90);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.CEREBRAS_API_KEY;
      else process.env.CEREBRAS_API_KEY = previousKey;
    }
  });
});
