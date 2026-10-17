import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  fetchOpenRouterModels,
  matchOpenRouterModel,
  openRouterMetadataFor,
  openRouterModelsFromPayload,
  resetOpenRouterModelsCacheForTest,
  setOpenRouterModelsFetchForTest,
  type OpenRouterFetch,
} from "../src/models/openrouter-models.ts";

const payload = (models: readonly unknown[]) => ({ data: models });

const solEntry = {
  id: "openai/gpt-5.6-sol",
  context_length: 1_050_000,
  top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 },
  reasoning: { supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"], default_effort: "medium", mandatory: false },
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const withCleanCache = async (fn: () => Promise<void> | void) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.reject(new Error("External network is not available in this catalog fixture")));
  resetOpenRouterModelsCacheForTest();
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    setOpenRouterModelsFetchForTest(null);
    resetOpenRouterModelsCacheForTest();
  }
};

test("the upstream payload keeps context, provider context, and reasoning efforts", () => {
  const models = openRouterModelsFromPayload(
    payload([
      solEntry,
      {
        id: "z-ai/glm-5.3",
        context_length: 1_310_720,
        top_provider: { context_length: 1_400_000 },
        reasoning: { supported_efforts: ["max", "high"], default_effort: "max", mandatory: true },
      },
      { id: "", context_length: 10 },
      { id: "no-metadata/model" },
      "not-an-object",
      solEntry,
    ])
  );
  assert.equal(models.length, 3);
  assert.deepEqual(models[0], {
    id: "openai/gpt-5.6-sol",
    context_window_tokens: 1_050_000,
    max_context_window_tokens: 1_050_000,
    reasoning: { supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"], default_effort: "medium", mandatory: false },
  });
  assert.equal(models[1].max_context_window_tokens, 1_400_000);
  assert.deepEqual(models[1].reasoning, { supported_efforts: ["max", "high"], default_effort: "max", mandatory: true });
  assert.deepEqual(models[2], { id: "no-metadata/model", context_window_tokens: null, max_context_window_tokens: null, reasoning: null });
});

test("a reasoning block without efforts or a default is not metadata", () => {
  const models = openRouterModelsFromPayload(payload([{ id: "a/b", reasoning: { mandatory: true } }]));
  assert.equal(models[0].reasoning, null);
});

test("ids join through ordered tiers, and an ambiguous key resolves to nothing", () => {
  const models = openRouterModelsFromPayload(
    payload([
      solEntry,
      { id: "nvidia/nemotron-3-ultra-550b-a55b", context_length: 262_144, top_provider: { context_length: 262_144 } },
      { id: "xiaomi/mimo-v2.5", context_length: 1_048_576, top_provider: { context_length: 1_048_576 } },
      { id: "tencent/hy3", context_length: 262_144, top_provider: { context_length: 262_144 } },
      { id: "tencent/hy3:free", context_length: 131_072, top_provider: { context_length: 131_072 } },
      { id: "~deepseek/deepseek-flash-latest", context_length: 1_048_576, top_provider: { context_length: 1_048_576 } },
    ])
  );

  // Exact slug.
  assert.equal(matchOpenRouterModel(models, "gpt-5.6-sol")?.id, "openai/gpt-5.6-sol");
  // Exact upstream id, and a provider-prefixed gateway id through the same slug tier.
  assert.equal(matchOpenRouterModel(models, "openai/gpt-5.6-sol")?.id, "openai/gpt-5.6-sol");
  assert.equal(matchOpenRouterModel(models, "openlux/gpt-5.6-sol")?.id, "openai/gpt-5.6-sol");
  // Vendor prefix and punctuation differences.
  assert.equal(matchOpenRouterModel(models, "nvidia-nemotron-3-ultra-550b-a55b")?.id, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(matchOpenRouterModel(models, "xiaomi-mimo-v2-5")?.id, "xiaomi/mimo-v2.5");
  // A `-free` suffix resolves to the `:free` variant, not to the base model.
  assert.equal(matchOpenRouterModel(models, "hy3-free")?.id, "tencent/hy3:free");
  assert.equal(matchOpenRouterModel(models, "hy3")?.id, "tencent/hy3");
  // Without a `:free` row upstream, the billing marker falls back to the base
  // model of the same name rather than leaving the id unknown.
  const baseOnly = openRouterModelsFromPayload(payload([{ id: "tencent/hy3", context_length: 262_144, top_provider: { context_length: 262_144 } }]));
  assert.equal(matchOpenRouterModel(baseOnly, "hy3-free")?.id, "tencent/hy3");
  const batchOnly = openRouterModelsFromPayload(
    payload([{ id: "openai/gpt-oss-120b:batch", context_length: 131_072, top_provider: { context_length: 131_072 } }])
  );
  assert.equal(matchOpenRouterModel(batchOnly, "gpt-oss-120b")?.id, "openai/gpt-oss-120b:batch");
  // A preview or dated suffix names a different snapshot and must not be folded in.
  const previewOnly = openRouterModelsFromPayload(payload([{ id: "tencent/hy3-preview", context_length: 262_144, top_provider: { context_length: 262_144 } }]));
  assert.equal(matchOpenRouterModel(previewOnly, "hy3-preview")?.id, "tencent/hy3-preview");
  assert.equal(matchOpenRouterModel(previewOnly, "hy3"), null);
  // A rolling alias still answers an id that exists nowhere else.
  assert.equal(matchOpenRouterModel(models, "deepseek-flash")?.id, "~deepseek/deepseek-flash-latest");
  // Internal ids have no upstream row and must stay unknown.
  assert.equal(matchOpenRouterModel(models, "codex-auto-review"), null);
  assert.equal(matchOpenRouterModel(models, "gpt-reserve"), null);
  assert.equal(matchOpenRouterModel(models, ""), null);

  // Two upstream models claiming one key cannot identify either of them.
  const ambiguous = openRouterModelsFromPayload(
    payload([
      { id: "alpha/shared-model", context_length: 100, top_provider: { context_length: 100 } },
      { id: "beta/shared-model", context_length: 200, top_provider: { context_length: 200 } },
    ])
  );
  assert.equal(matchOpenRouterModel(ambiguous, "shared-model"), null);
  assert.equal(matchOpenRouterModel(ambiguous, "alpha/shared-model")?.id, "alpha/shared-model");
});

test("a snapshot is cached, coalesced, and survives a failed refresh", async () => {
  await withCleanCache(async () => {
    let calls = 0;
    let mode: "ok" | "fail" | "empty" = "ok";
    const fetcher: OpenRouterFetch = () => {
      calls += 1;
      if (mode === "fail") return Promise.reject(new Error("upstream down"));
      if (mode === "empty") return Promise.resolve(jsonResponse(payload([])));
      return Promise.resolve(jsonResponse(payload([solEntry])));
    };
    setOpenRouterModelsFetchForTest(fetcher);

    assert.equal(openRouterMetadataFor("gpt-5.6-sol"), null);
    const first = await fetchOpenRouterModels();
    assert.equal(calls, 1);
    assert.equal(first?.models.length, 1);
    assert.equal(openRouterMetadataFor("gpt-5.6-sol")?.id, "openai/gpt-5.6-sol");
    assert.equal(openRouterMetadataFor("gpt-reserve"), null);

    // Within the TTL the cache answers without another request.
    await fetchOpenRouterModels();
    assert.equal(calls, 1);

    // A failed forced refresh keeps the last good snapshot and backs off.
    mode = "fail";
    const afterFailure = await fetchOpenRouterModels({ force: true });
    assert.equal(calls, 2);
    assert.equal(afterFailure?.models.length, 1);
    assert.equal(openRouterMetadataFor("gpt-5.6-sol")?.id, "openai/gpt-5.6-sol");
    await fetchOpenRouterModels();
    assert.equal(calls, 2, "the backoff window suppresses an immediate retry");

    // An empty catalog is a failed refresh, not an empty world.
    mode = "empty";
    const afterEmpty = await fetchOpenRouterModels({ force: true });
    assert.equal(calls, 3);
    assert.equal(afterEmpty?.models.length, 1);

    // A non-OK status is also a failure rather than a silent empty catalog.
    const rejecting: OpenRouterFetch = () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ error: "nope" }, 429));
    };
    setOpenRouterModelsFetchForTest(rejecting);
    const afterHttpFailure = await fetchOpenRouterModels({ force: true });
    assert.equal(calls, 4);
    assert.equal(afterHttpFailure?.models.length, 1);
  });
});

test("no fetcher means no request and no metadata", async () => {
  await withCleanCache(async () => {
    const snapshot = await fetchOpenRouterModels();
    assert.equal(snapshot, null);
    assert.equal(openRouterMetadataFor("gpt-5.6-sol"), null);
  });
});
