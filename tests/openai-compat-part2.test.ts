import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 2 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_V4_FLASH_MODEL,
  DEFAULT_MODEL_KEY,
  DEFAULT_REASONING_EFFORT_KEY,
  DEFAULT_TEST_MODEL,
  TERRA_TEST_MODEL,
  TEST_CODEX_MODELS_KEY,
  baseSseChunks,
  fetchMeteredModels,
  fetchSurplusModels,
  getResponseTelemetry,
  handleChatCompletions,
  handleModelCapabilities,
  handleModels,
  handlePublicModelCatalog,
  handleResponses,
  keyToString,
  kvStore,
  neverSettlingPromise,
  projectDeepSeekRequest,
  resetMeteredModelsCacheForTest,
  resetRuntimeConfigCacheForTest,
  resetSurplusModelsCacheForTest,
  responsesRequest,
  setStreamFirstEventDeadlineMsForTest,
  sha256Hex,
  sseResponse,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";

test("openai: default model requires configured model or stored snapshot", async () => {
  const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
  const defaultModelKey = keyToString(DEFAULT_MODEL_KEY);
  const previousSnapshot = kvStore.get(snapshotKey);
  const previousDefault = kvStore.get(defaultModelKey);
  kvStore.delete(snapshotKey);
  kvStore.delete(defaultModelKey);

  try {
    const response = await withFetchMock(
      () => {
        throw new Error("no-model requests should not fetch upstream defaults");
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: "ping" }),
          })
        )
    );

    assert.equal(response.status, 503);
    const payload = (await response.json()) as { error?: { message?: string; code?: string } };
    assert.equal(payload.error?.code, "server_error");
    assert.match(payload.error.message ?? "", /no configured default model or Codex model snapshot/);
  } finally {
    if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
    else kvStore.set(snapshotKey, previousSnapshot);
    if (previousDefault === undefined) kvStore.delete(defaultModelKey);
    else kvStore.set(defaultModelKey, previousDefault);
  }
});

test("openai: configured default reasoning survives missing catalog metadata", async () => {
  const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
  const defaultModelKey = keyToString(DEFAULT_MODEL_KEY);
  const previousSnapshot = kvStore.get(snapshotKey);
  const previousDefault = kvStore.get(defaultModelKey);
  const modelWithoutReasoningMetadata = "gpt-5-no-reasoning-metadata";
  kvStore.set(snapshotKey, {
    source: "codex_cli",
    client_version: "0.126.0",
    updated_at_ms: Date.now(),
    models: [{ slug: modelWithoutReasoningMetadata, display_name: "No Reasoning Metadata" }],
  });
  kvStore.delete(defaultModelKey);

  let recordedBody: Record<string, unknown> | null = null;
  try {
    const response = await withFetchMock(
      (_url, bodyText) => {
        recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
        return sseResponse([
          `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_no_reasoning", created_at: 0 } })}\n\n`,
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "pong" })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              model: modelWithoutReasoningMetadata,
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          })}\n\n`,
        ]);
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: "ping" }),
          })
        )
    );

    assert.equal(response.status, 200);
    assert.ok(recordedBody);
    assert.equal((recordedBody as Record<string, unknown>).model, modelWithoutReasoningMetadata);
    assert.deepEqual((recordedBody as Record<string, unknown>).reasoning, { effort: "low" });
  } finally {
    if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
    else kvStore.set(snapshotKey, previousSnapshot);
    if (previousDefault === undefined) kvStore.delete(defaultModelKey);
    else kvStore.set(defaultModelKey, previousDefault);
  }
});

test("openai: default reasoning level is accepted when supported levels are absent", async () => {
  const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
  const previousSnapshot = kvStore.get(snapshotKey);
  const modelWithDefaultOnly = "gpt-5-default-reasoning-only";
  kvStore.set(snapshotKey, {
    source: "codex_cli",
    client_version: "0.126.0",
    updated_at_ms: Date.now(),
    models: [
      {
        slug: modelWithDefaultOnly,
        display_name: "Default Reasoning Only",
        default_reasoning_level: "medium",
      },
    ],
  });

  let recordedBody: Record<string, unknown> | null = null;
  try {
    const response = await withFetchMock(
      (_url, bodyText) => {
        recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
        return sseResponse([
          `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_default_only", created_at: 0 } })}\n\n`,
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "pong" })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              model: modelWithDefaultOnly,
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          })}\n\n`,
        ]);
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: modelWithDefaultOnly,
              input: "ping",
              reasoning: { effort: "medium" },
            }),
          })
        )
    );

    assert.equal(response.status, 200);
    assert.ok(recordedBody);
    assert.deepEqual((recordedBody as Record<string, unknown>).reasoning, { effort: "medium" });
  } finally {
    if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
    else kvStore.set(snapshotKey, previousSnapshot);
  }
});

test("openai: snapshot levels are advertised verbatim and an explicit none is still forwarded as none", async () => {
  const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
  const previousSnapshot = kvStore.get(snapshotKey);

  kvStore.set(snapshotKey, {
    source: "chatgpt_codex",
    updated_at_ms: Date.now(),
    models: [
      {
        slug: DEFAULT_TEST_MODEL,
        display_name: "GPT-5 Fixture Default",
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
      },
    ],
  });

  try {
    const capabilitiesResponse = await withFetchMock(
      () => {
        throw new Error("model capability reads should not fetch upstream");
      },
      () => handleModelCapabilities()
    );
    assert.equal(capabilitiesResponse.status, 200);
    const capabilitiesPayload = (await capabilitiesResponse.json()) as {
      data?: { supported_reasoning_levels?: string[] }[];
    };
    // No tier is invented: the upstream rejects an effort its catalog omits.
    assert.deepEqual(capabilitiesPayload.data?.[0]?.supported_reasoning_levels, ["low", "medium", "high", "xhigh"]);

    let recordedBody: Record<string, unknown> | null = null;
    const chatResponse = await withFetchMock(
      (_url, bodyText) => {
        recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
        return sseResponse(baseSseChunks());
      },
      () =>
        handleChatCompletions(
          new Request("https://ai.ubq.fi/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [{ role: "user", content: "ping" }],
              reasoning_effort: "none",
            }),
          })
        )
    );

    assert.equal(chatResponse.status, 200);
    assert.ok(recordedBody);
    assert.deepEqual((recordedBody as Record<string, unknown>).reasoning, { effort: "none" });
  } finally {
    if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
    else kvStore.set(snapshotKey, previousSnapshot);
  }
});

test("openai: hostile catalog wire maps cannot rewrite none reasoning", async () => {
  const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
  const defaultReasoningKey = keyToString(DEFAULT_REASONING_EFFORT_KEY);
  const previousSnapshot = kvStore.get(snapshotKey);
  const previousDefaultReasoning = kvStore.get(defaultReasoningKey);
  kvStore.set(defaultReasoningKey, "none");
  kvStore.set(snapshotKey, {
    source: "chatgpt_codex",
    updated_at_ms: Date.now(),
    models: [
      {
        slug: DEFAULT_TEST_MODEL,
        display_name: "Hostile wire-map fixture",
        default_reasoning_level: "none",
        supported_reasoning_levels: ["none", "max"],
        reasoning_effort_wire_map: { none: "max" },
      },
    ],
  });

  try {
    const recordedEfforts: unknown[] = [];
    await withFetchMock(
      (_url, bodyText) => {
        const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        recordedEfforts.push((body.reasoning as Record<string, unknown> | undefined)?.effort);
        return sseResponse(baseSseChunks());
      },
      async () => {
        const chat = await handleChatCompletions(
          new Request("https://ai.ubq.fi/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "user", content: "ping" }] }),
          })
        );
        const responses = await handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: "ping", reasoning: { effort: "none" } }),
          })
        );
        assert.equal(chat.status, 200);
        assert.equal(responses.status, 200);
      }
    );
    assert.deepEqual(recordedEfforts, ["none", "none"]);
  } finally {
    if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
    else kvStore.set(snapshotKey, previousSnapshot);
    if (previousDefaultReasoning === undefined) kvStore.delete(defaultReasoningKey);
    else kvStore.set(defaultReasoningKey, previousDefaultReasoning);
    resetRuntimeConfigCacheForTest();
  }
});

test("openai: models returns stored Codex snapshot without upstream fetch", async () => {
  const response = await withFetchMock(
    () => {
      throw new Error("handleModels should not fetch upstream models");
    },
    () => handleModels()
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { data?: (Record<string, unknown> & { id?: string })[] };
  assert.ok(Array.isArray(payload.data));
  const model = payload.data.find((entry) => entry.id === DEFAULT_TEST_MODEL);
  assert.ok(model);
  assert.deepEqual(
    Object.keys(model).sort((a, b) => a.localeCompare(b)),
    ["created", "id", "object", "owned_by"]
  );
  assert.equal(model.object, "model");
  assert.equal(typeof model.created, "number");
  assert.equal(Object.prototype.hasOwnProperty.call(model, "supported_reasoning_levels"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(model, "display_name"), false);
});

test("openai: models omits provider models without OpenAI inference endpoints", async () => {
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  const originalMeteredApiKey = process.env.METERED_API_KEY;
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  process.env.METERED_API_KEY = "metered-model-filter-test-key";
  Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
  try {
    await fetchMeteredModels({
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [
              {
                id: "openlux-responses-model",
                owned_by: "openlux",
                supported_endpoint_types: ["openai-response"],
              },
              {
                id: "openlux-chat-model",
                owned_by: "openlux",
                supported_endpoint_types: ["openai"],
              },
              {
                id: "gpt-image-2",
                model_type: "图像",
                owned_by: "openlux",
                supported_endpoint_types: ["image-generation"],
              },
            ],
          })
        ),
    });

    const response = await handleModels();
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      object?: unknown;
      data?: (Record<string, unknown> & { id?: string })[];
    };
    assert.deepEqual(
      Object.keys(payload).sort((a, b) => a.localeCompare(b)),
      ["data", "object"]
    );
    assert.equal(payload.object, "list");
    assert.ok(Array.isArray(payload.data));
    const modelIds = new Set(payload.data.map((model) => model.id));
    assert.equal(modelIds.has("openlux-responses-model"), true);
    assert.equal(modelIds.has("openlux-chat-model"), true);
    assert.equal(modelIds.has("gpt-image-2"), false);
    for (const model of payload.data) {
      assert.deepEqual(
        Object.keys(model).sort((a, b) => a.localeCompare(b)),
        ["created", "id", "object", "owned_by"]
      );
    }
  } finally {
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = originalMeteredApiKey;
    if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
  }
});

test("openai: public catalog hides OpenLux-only models", async () => {
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  const originalMeteredKey = process.env.METERED_API_KEY;
  const runtimeConfigKey = keyToString(["uos_ai", "runtime_config", "v2"]);
  const previousRuntimeConfig = kvStore.get(runtimeConfigKey);
  const snapshot = kvStore.get(keyToString(TEST_CODEX_MODELS_KEY));
  kvStore.set(runtimeConfigKey, {
    version: 2,
    default_model: DEFAULT_TEST_MODEL,
    default_reasoning_effort: "low",
    codex_models: snapshot,
    updated_at_ms: Date.now(),
  });
  resetRuntimeConfigCacheForTest();
  process.env.METERED_API_KEY = "metered-public-catalog-test-key";
  await fetchMeteredModels({
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: TERRA_TEST_MODEL,
              owned_by: "openlux",
              supported_endpoint_types: ["openai-response"],
            },
            {
              id: "openlux-surplus-shared-model",
              owned_by: "openlux",
              supported_endpoint_types: ["openai-response"],
            },
            {
              id: "openlux-only-model",
              owned_by: "openlux",
              supported_endpoint_types: ["openai-response"],
            },
          ],
        })
      ),
  });
  await fetchSurplusModels({
    apiKey: "surplus-public-catalog-test-key",
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [
            { id: "openlux-surplus-shared-model", provider: "surplus" },
            { id: "surplus-only-model", provider: "surplus" },
          ],
        })
      ),
  });

  try {
    const response = await handlePublicModelCatalog();
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      data?: { id?: string; providers?: { id?: string }[] }[];
      sources?: { openlux?: { count?: number } };
    };
    const byId = new Map((payload.data ?? []).map((model) => [model.id, model]));
    assert.deepEqual(
      byId.get(TERRA_TEST_MODEL)?.providers?.map((provider) => provider.id),
      ["codex", "openlux"]
    );
    assert.deepEqual(
      byId.get("openlux-surplus-shared-model")?.providers?.map((provider) => provider.id),
      ["openlux", "surplus"]
    );
    assert.deepEqual(
      byId.get("openlux-only-model")?.providers?.map((provider) => provider.id),
      ["openlux"],
      "a provider's own models are listed without another provider confirming them"
    );
    assert.deepEqual(
      byId.get("surplus-only-model")?.providers?.map((provider) => provider.id),
      ["surplus"]
    );
    assert.equal(payload.sources?.openlux?.count, 3);
  } finally {
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (previousRuntimeConfig === undefined) kvStore.delete(runtimeConfigKey);
    else kvStore.set(runtimeConfigKey, previousRuntimeConfig);
    resetRuntimeConfigCacheForTest();
    if (originalMeteredKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = originalMeteredKey;
  }
});

test("openai: models exposes API-supported hidden review models from the snapshot", async () => {
  const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
  const previousSnapshot = kvStore.get(snapshotKey);
  kvStore.set(snapshotKey, {
    source: "chatgpt_codex",
    client_version: "0.125.0",
    updated_at_ms: Date.now(),
    models: [
      { slug: DEFAULT_TEST_MODEL },
      {
        slug: "codex-auto-review",
        display_name: "Codex Auto Review",
        visibility: "hide",
        supported_in_api: true,
      },
    ],
  });

  try {
    const response = await withFetchMock(
      () => {
        throw new Error("handleModels should not fetch upstream models");
      },
      () => handleModels()
    );

    assert.equal(response.status, 200);
    const payload = (await response.json()) as { data?: { id?: string }[] };
    assert.ok(payload.data?.some((model) => model.id === "codex-auto-review"));
  } finally {
    if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
    else kvStore.set(snapshotKey, previousSnapshot);
    resetRuntimeConfigCacheForTest();
  }
});

test("openai: model capabilities are exposed outside /v1 model objects", async () => {
  const response = await withFetchMock(
    () => {
      throw new Error("handleModelCapabilities should not fetch upstream models");
    },
    () => handleModelCapabilities()
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    object?: string;
    data?: {
      id?: string;
      object?: string;
      upstream_provider?: string;
      supported_endpoints?: string[];
      supported_reasoning_levels?: string[];
      default_reasoning_effort?: string | null;
      reasoning_effort_wire_map?: Record<string, string>;
      context_window_tokens?: number | null;
      max_context_window_tokens?: number | null;
      auto_compact_token_limit_tokens?: number | null;
    }[];
  };
  assert.equal(payload.object, "list");
  assert.ok(Array.isArray(payload.data));
  const model = payload.data.find((entry) => entry.id === DEFAULT_TEST_MODEL);
  assert.ok(model);
  assert.equal(model.object, "uos.model_capabilities");
  assert.equal(model.upstream_provider, "codex_chatgpt");
  assert.deepEqual(model.supported_reasoning_levels, ["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(model.default_reasoning_effort, "medium");
  assert.deepEqual(model.reasoning_effort_wire_map, { ultra: "max" });
  assert.equal(model.context_window_tokens, 272000);
  assert.equal(model.max_context_window_tokens, 1000000);
  // The uploaded record carries no auto-compaction limit, so it is derived from
  // the window it published (85% or a 50k reserve, whichever is earlier).
  assert.equal(model.auto_compact_token_limit_tokens, 222000);
  assert.ok(model.supported_endpoints?.includes("/v1/chat/completions"));
  assert.ok(model.supported_endpoints?.includes("/v1/responses"));
});

test("openai: prompt-cache capability records are UOS-only and keep providers separate", async () => {
  const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
  const runtimeConfigKey = keyToString(["uos_ai", "runtime_config", "v2"]);
  const previousSnapshot = kvStore.get(snapshotKey);
  const previousRuntimeConfig = kvStore.get(runtimeConfigKey);
  const promptCache = {
    version: 1,
    providers: [
      {
        id: "codex_chatgpt",
        controls: {
          key: true,
          explicit_breakpoints: true,
          source: "catalog",
          verified_at_ms: 2_000,
        },
        scope: {
          probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
          account_slots: "shared",
          token_refresh: "preserved",
          conversation_id: "independent",
          reproducible_cycles: 3,
          source: "live_probe",
          verified_at_ms: 2_001,
        },
      },
      {
        id: "metered",
        controls: {
          key: false,
          source: "inferred",
          verified_at_ms: 2_002,
        },
      },
    ],
  };
  kvStore.set(snapshotKey, {
    source: "chatgpt_codex",
    client_version: "0.125.0",
    updated_at_ms: Date.now(),
    models: [
      {
        slug: DEFAULT_TEST_MODEL,
        supported_reasoning_levels: ["none", "medium"],
        prompt_cache: promptCache,
      },
    ],
  });

  try {
    const { capabilitiesResponse, modelsResponse } = await withFetchMock(
      () => {
        throw new Error("model metadata reads should not fetch upstream");
      },
      async () => ({
        capabilitiesResponse: await handleModelCapabilities(),
        modelsResponse: await handleModels(),
      })
    );
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = (await capabilitiesResponse.json()) as {
      data?: { id?: string; prompt_cache?: unknown }[];
    };
    assert.deepEqual(capabilities.data?.find((model) => model.id === DEFAULT_TEST_MODEL)?.prompt_cache, promptCache);

    const models = (await modelsResponse.json()) as { data?: (Record<string, unknown> & { id?: string })[] };
    const model = models.data?.find((entry) => entry.id === DEFAULT_TEST_MODEL);
    assert.ok(model);
    assert.equal(Object.prototype.hasOwnProperty.call(model, "prompt_cache"), false);
  } finally {
    if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
    else kvStore.set(snapshotKey, previousSnapshot);
    if (previousRuntimeConfig === undefined) kvStore.delete(runtimeConfigKey);
    else kvStore.set(runtimeConfigKey, previousRuntimeConfig);
    resetRuntimeConfigCacheForTest();
  }
});

test("openai: models returns an empty list when no snapshot is stored", async () => {
  const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
  const previousSnapshot = kvStore.get(snapshotKey);
  // Provider-backed entries are injected independently of the Codex snapshot,
  // so every optional provider credential must be absent for an empty list.
  const providerEnvKeys = ["CEREBRAS_API_KEY", "DEEPSEEK_API_KEY", "LITHOSAI_API_KEY", "OPENROUTER_API_KEY"] as const;
  const originalApiKeys = providerEnvKeys.map((key) => [key, process.env[key]] as const);
  kvStore.delete(snapshotKey);
  for (const key of providerEnvKeys) Reflect.deleteProperty(process.env, key);

  try {
    const response = await withFetchMock(
      () => {
        throw new Error("handleModels should not fetch upstream models");
      },
      () => handleModels()
    );

    assert.equal(response.status, 200);
    const payload = (await response.json()) as { object?: string; data?: unknown[] };
    assert.equal(payload.object, "list");
    assert.deepEqual(payload.data, []);
  } finally {
    if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
    else kvStore.set(snapshotKey, previousSnapshot);
    for (const [key, originalApiKey] of originalApiKeys) {
      if (originalApiKey === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = originalApiKey;
    }
  }
});

test("openai: configured Cerebras GPT-OSS is discoverable without altering the Codex catalog", async () => {
  const envKey = "CEREBRAS_API_KEY";
  const originalApiKey = process.env[envKey];
  process.env[envKey] = "cerebras-test-key";
  try {
    const models = await handleModels();
    assert.equal(models.status, 200);
    const modelList = (await models.json()) as { data?: Record<string, unknown>[] };
    const model = modelList.data?.find((entry) => entry.id === "gpt-oss-120b");
    assert.deepEqual(model, {
      id: "gpt-oss-120b",
      object: "model",
      created: 0,
      owned_by: "cerebras",
    });
    const qwenModel = modelList.data?.find((entry) => entry.id === "qwen-3.8-27b");
    assert.deepEqual(qwenModel, {
      id: "qwen-3.8-27b",
      object: "model",
      created: 0,
      owned_by: "cerebras",
    });

    const capabilities = await handleModelCapabilities();
    assert.equal(capabilities.status, 200);
    const capabilityList = (await capabilities.json()) as { data?: Record<string, unknown>[] };
    assert.deepEqual(
      capabilityList.data?.find((entry) => entry.id === "gpt-oss-120b"),
      {
        id: "gpt-oss-120b",
        object: "uos.model_capabilities",
        owned_by: "cerebras",
        display_name: "GPT-OSS 120B",
        upstream_provider: "cerebras",
        supported_endpoints: ["/v1/chat/completions"],
        supported_reasoning_levels: ["low", "medium", "high"],
        default_reasoning_effort: "medium",
        reasoning_effort_wire_map: {},
        context_window_tokens: 131_072,
        max_context_window_tokens: 131_072,
        auto_compact_token_limit_tokens: 81_072,
        effective_context_window_percent: 95,
        context_source: "provider_discovery",
      }
    );
    // The two Cerebras ids do not share a reasoning contract: qwen also accepts
    // `none` and defaults to `high`, so its row must not repeat the GPT-OSS tiers.
    assert.deepEqual(
      capabilityList.data.find((entry) => entry.id === "qwen-3.8-27b"),
      {
        id: "qwen-3.8-27b",
        object: "uos.model_capabilities",
        owned_by: "cerebras",
        display_name: "Qwen 3.8 27B",
        upstream_provider: "cerebras",
        supported_endpoints: ["/v1/chat/completions"],
        supported_reasoning_levels: ["none", "low", "medium", "high"],
        default_reasoning_effort: "high",
        reasoning_effort_wire_map: {},
        context_window_tokens: 131_072,
        max_context_window_tokens: 131_072,
        auto_compact_token_limit_tokens: 81_072,
        effective_context_window_percent: 95,
        context_source: "provider_discovery",
      }
    );
  } finally {
    if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
    else process.env[envKey] = originalApiKey;
  }
});

test("openai: configured DeepSeek official models are discoverable and replace a paid-fallback catalog row", async () => {
  const envKey = "DEEPSEEK_API_KEY";
  const originalApiKey = process.env[envKey];
  const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
  const previousSnapshot = kvStore.get(snapshotKey) as { models: unknown[] } | undefined;
  process.env[envKey] = "deepseek-test-key";
  // A paid-fallback discovery source may already advertise the legacy alias.
  // The official row must replace it rather than duplicate or defer to it.
  kvStore.set(snapshotKey, {
    ...(previousSnapshot as Record<string, unknown>),
    models: [...(previousSnapshot?.models ?? []), { slug: DEEPSEEK_V4_FLASH_MODEL, display_name: "DeepSeek V4 Flash" }],
  });
  try {
    const models = await handleModels();
    assert.equal(models.status, 200);
    const modelList = (await models.json()) as { data?: Record<string, unknown>[] };
    for (const id of [DEEPSEEK_FLASH_MODEL, DEEPSEEK_V4_FLASH_MODEL]) {
      assert.deepEqual(
        modelList.data?.filter((entry) => entry.id === id),
        [{ id, object: "model", created: 0, owned_by: "deepseek" }],
        id
      );
    }

    const capabilities = await handleModelCapabilities();
    assert.equal(capabilities.status, 200);
    const capabilityList = (await capabilities.json()) as { data?: Record<string, unknown>[] };
    for (const id of [DEEPSEEK_FLASH_MODEL, DEEPSEEK_V4_FLASH_MODEL]) {
      const entries = capabilityList.data?.filter((entry) => entry.id === id) ?? [];
      assert.equal(entries.length, 1, id);
      assert.deepEqual(entries[0], {
        id,
        object: "uos.model_capabilities",
        owned_by: "deepseek",
        display_name: id === DEEPSEEK_FLASH_MODEL ? "DeepSeek Flash" : "DeepSeek Flash (legacy id)",
        upstream_provider: "deepseek",
        supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
        supported_reasoning_levels: ["none", "low", "high", "max"],
        default_reasoning_effort: "high",
        reasoning_effort_wire_map: { ultra: "max" },
        context_window_tokens: 1_000_000,
        max_context_window_tokens: 1_000_000,
        auto_compact_token_limit_tokens: 850_000,
        effective_context_window_percent: 95,
        context_source: "provider_discovery",
      });
    }
  } finally {
    if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
    else kvStore.set(snapshotKey, previousSnapshot);
    if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
    else process.env[envKey] = originalApiKey;
  }
});

test("openai: DeepSeek official ids are hidden when no credential is configured", async () => {
  const envKey = "DEEPSEEK_API_KEY";
  const originalApiKey = process.env[envKey];
  Reflect.deleteProperty(process.env, envKey);
  try {
    const models = await handleModels();
    assert.equal(models.status, 200);
    const modelList = (await models.json()) as { data?: Record<string, unknown>[] };
    for (const id of [DEEPSEEK_FLASH_MODEL, DEEPSEEK_V4_FLASH_MODEL]) {
      assert.equal(
        modelList.data?.some((entry) => entry.id === id),
        false,
        id
      );
    }
  } finally {
    if (originalApiKey !== undefined) process.env[envKey] = originalApiKey;
  }
});

test("openai: DeepSeek request projection translates the documented wire contract", () => {
  assert.deepEqual(
    projectDeepSeekRequest(
      {
        model: DEEPSEEK_V4_FLASH_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 2048,
        reasoning_effort: "ultra",
        temperature: 0,
      },
      DEEPSEEK_V4_FLASH_MODEL
    ),
    {
      model: DEEPSEEK_FLASH_MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 2048,
      reasoning_effort: "max",
      temperature: 0,
    }
  );
  // Documented compatibility aliases pass through unchanged; the official API
  // performs their tier mapping.
  assert.equal(projectDeepSeekRequest({ model: DEEPSEEK_FLASH_MODEL, reasoning_effort: "medium" }, DEEPSEEK_FLASH_MODEL).reasoning_effort, "medium");
  // The provider's published pro model is served under its own canonical id.
  assert.equal(projectDeepSeekRequest({ model: DEEPSEEK_FLASH_MODEL }, "deepseek-v4-pro").model, "deepseek-v4-pro");
  assert.throws(() => projectDeepSeekRequest({ model: DEEPSEEK_FLASH_MODEL }, "deepseek-v4-nope"), /not configured/);
});

test("openai: DeepSeek Chat projection translates developer messages and preserves the caller's order and content", async () => {
  const envKey = "DEEPSEEK_API_KEY";
  const originalApiKey = process.env[envKey];
  const callerMessages = [
    { role: "developer", content: "Answer in one short sentence." },
    { role: "assistant", content: "Earlier reply." },
    { role: "user", content: "ping" },
  ];
  process.env[envKey] = "deepseek-test-key";
  // A captured call list rather than mutable locals: the checker does not track
  // an assignment made inside the fetch-mock closure, so a nullable local would
  // narrow to `never` at the assertions below.
  const upstreamCalls: { url: string; body: string | null }[] = [];
  try {
    const response = await withFetchMock(
      (url, bodyText) => {
        upstreamCalls.push({ url, body: bodyText });
        return Response.json({
          id: "deepseek-developer-role-1",
          object: "chat.completion",
          created: 1_780_000_000,
          model: DEEPSEEK_FLASH_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        });
      },
      () =>
        handleChatCompletions(
          new Request("https://ai.ubq.fi/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEEPSEEK_FLASH_MODEL, messages: callerMessages, stream: false }),
          })
        )
    );

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].url, DEEPSEEK_CHAT_COMPLETIONS_URL);
    const upstreamBody = upstreamCalls[0].body;
    assert.ok(upstreamBody);
    // DeepSeek's Chat contract defines no `developer` role: the outbound bytes
    // carry `system`, and no `developer` value reaches the provider.
    assert.ok(upstreamBody.includes('"role":"system"'));
    assert.equal(upstreamBody.includes("developer"), false);
    assert.deepEqual((JSON.parse(upstreamBody) as Record<string, unknown>).messages, [
      { role: "system", content: "Answer in one short sentence." },
      { role: "assistant", content: "Earlier reply." },
      { role: "user", content: "ping" },
    ]);
    // The caller's own request record is never rewritten in place.
    assert.deepEqual(callerMessages, [
      { role: "developer", content: "Answer in one short sentence." },
      { role: "assistant", content: "Earlier reply." },
      { role: "user", content: "ping" },
    ]);
    const payload = (await response.json()) as Record<string, unknown>;
    assert.equal(payload.object, "chat.completion");
    assert.deepEqual(payload.choices, [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }]);
  } finally {
    if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
    else process.env[envKey] = originalApiKey;
  }
});

test("openai: unsupported snapshot model is rejected before upstream fetch", async () => {
  const response = await withFetchMock(
    () => {
      throw new Error("unsupported model requests should not fetch upstream");
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5-chat-latest",
            messages: [{ role: "user", content: "ping" }],
          }),
        })
      )
  );

  assert.equal(response.status, 404);
  const payload = (await response.json()) as { error?: { message?: string; code?: string; param?: string | null } };
  assert.equal(payload.error?.code, "model_not_found");
  assert.equal(payload.error.param, "model");
  assert.match(payload.error.message ?? "", /Use \/v1\/models/);
});

test("openai: gpt-reserve is servable and reaches the Codex upstream under its own id", async () => {
  const codexUrls: string[] = [];
  let recordedBody: Record<string, unknown> | null = null;
  const response = await withFetchMock(
    (url, bodyText) => {
      if (url !== "https://chatgpt.com/backend-api/codex/responses") {
        // Paid catalog discovery for an id the Codex tier already serves; it is
        // not this test's subject and must not select a paid provider.
        return Response.json({ data: [] });
      }
      codexUrls.push(url);
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () => handleResponses(responsesRequest({ model: "gpt-reserve", input: "reserve ping" }))
  );

  // The owner-authorized id is served by the Codex subscription tier even
  // though the model snapshot does not list it yet, and it is never renamed on
  // the wire: the upstream sees `gpt-reserve` verbatim, so reserve stays
  // distinguishable from the standard luna id.
  assert.deepEqual(codexUrls, ["https://chatgpt.com/backend-api/codex/responses"]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
  assert.ok(recordedBody);
  assert.equal((recordedBody as Record<string, unknown>).model, "gpt-reserve");
  assert.match(await response.text(), /pong/);
});

test("openai: unlisted reasoning tiers pass through for upstream validation", async () => {
  let recordedBody: Record<string, unknown> | null = null;
  const response = await withFetchMock(
    (_url, bodyText) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: "ping" }],
            reasoning_effort: "minimal",
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  assert.deepEqual((recordedBody as Record<string, unknown>).reasoning, { effort: "minimal" });
});

test("openai: max reasoning is forwarded for models that support it", async () => {
  let recordedBody: Record<string, unknown> | null = null;
  const response = await withFetchMock(
    (_url, bodyText) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: "ping" }],
            reasoning_effort: "max",
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  assert.deepEqual((recordedBody as Record<string, unknown>).reasoning, { effort: "max" });
});

test("openai: catalog wire metadata maps Codex CLI ultra to upstream max", async () => {
  let recordedBody: Record<string, unknown> | null = null;
  let recordedUserAgent: string | null = null;
  const response = await withFetchMock(
    (_url, bodyText, init) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      recordedUserAgent = new Headers(init?.headers).get("user-agent");
      return sseResponse(baseSseChunks());
    },
    () =>
      handleChatCompletions(
        new Request("https://ai.ubq.fi/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: "ping" }],
            reasoning_effort: "ultra",
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  assert.deepEqual((recordedBody as Record<string, unknown>).reasoning, { effort: "max" });
  assert.equal(recordedUserAgent, "codex_cli_rs/0.125.0 (ai.ubq.fi)");
});

test("openai: ultra still dispatches as max when a stored catalog has no wire map", async () => {
  const snapshotKey = keyToString(TEST_CODEX_MODELS_KEY);
  const previousSnapshot = kvStore.get(snapshotKey);
  kvStore.set(snapshotKey, {
    source: "chatgpt_codex",
    updated_at_ms: Date.now(),
    models: [
      {
        slug: DEFAULT_TEST_MODEL,
        display_name: "No wire-map fixture",
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["none", "medium", "ultra"],
      },
    ],
  });
  try {
    let recordedBody: Record<string, unknown> | null = null;
    const response = await withFetchMock(
      (_url, bodyText) => {
        recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
        return sseResponse(baseSseChunks());
      },
      () =>
        handleChatCompletions(
          new Request("https://ai.ubq.fi/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              messages: [{ role: "user", content: "ping" }],
              reasoning_effort: "ultra",
            }),
          })
        )
    );
    assert.equal(response.status, 200);
    assert.ok(recordedBody);
    assert.deepEqual((recordedBody as Record<string, unknown>).reasoning, { effort: "max" });
  } finally {
    if (previousSnapshot === undefined) kvStore.delete(snapshotKey);
    else kvStore.set(snapshotKey, previousSnapshot);
    resetRuntimeConfigCacheForTest();
  }
});

test("openai: responses applies catalog reasoning wire metadata", async () => {
  let recordedBody: Record<string, unknown> | null = null;
  const response = await withFetchMock(
    (_url, bodyText) => {
      recordedBody = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
      return sseResponse(baseSseChunks());
    },
    () =>
      handleResponses(
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: "ping",
            reasoning: { effort: "ultra" },
          }),
        })
      )
  );

  assert.equal(response.status, 200);
  assert.ok(recordedBody);
  assert.deepEqual((recordedBody as Record<string, unknown>).reasoning, { effort: "max" });
});

test("openai: Codex HTTP errors use OpenAI envelopes without changing routing", async () =>
  runSequence(async (step) => {
    const cases = [
      {
        name: "chat completions parses a provider-root detail",
        route: "chat.completions",
        status: 400,
        statusText: "Codex Invalid Request",
        body: JSON.stringify({
          detail: "The requested model is not supported with a ChatGPT account.",
          opaque: { drop: true },
        }),
        retryAfter: "7",
        expectedError: {
          message: "The requested model is not supported with a ChatGPT account.",
          type: "invalid_request_error",
          code: "upstream_error",
        },
      },
      {
        name: "responses preserves an existing error envelope",
        route: "responses",
        status: 503,
        statusText: "Codex Unavailable",
        body: JSON.stringify({
          error: {
            message: "Codex is temporarily unavailable.",
            type: "server_error",
            code: "provider_unavailable",
            param: "model",
          },
          opaque: { drop: true },
        }),
        retryAfter: null,
        expectedError: {
          message: "Codex is temporarily unavailable.",
          type: "server_error",
          code: "provider_unavailable",
          param: "model",
        },
      },
      {
        name: "responses converts plain text",
        route: "responses",
        status: 422,
        statusText: "Codex Rejected",
        body: "Codex rejected the request body.",
        retryAfter: null,
        expectedError: {
          message: "Codex rejected the request body.",
          type: "invalid_request_error",
          code: "upstream_error",
        },
      },
      {
        name: "responses classifies an upstream 400 separately from stream reads",
        route: "responses",
        status: 400,
        statusText: "Codex Invalid Request",
        body: "Codex rejected the request body.",
        retryAfter: null,
        expectedError: {
          message: "Codex rejected the request body.",
          type: "invalid_request_error",
          code: "upstream_error",
        },
      },
    ] as const;

    for (const testCase of cases) {
      await step(testCase.name, async () => {
        let codexCalls = 0;
        const response = await withFetchMock(
          () => {
            codexCalls += 1;
            const headers = new Headers({
              "Content-Type": "application/problem+json",
              "X-Codex-Diagnostic": "drop-me",
            });
            if (testCase.retryAfter) headers.set("Retry-After", testCase.retryAfter);
            return new Response(testCase.body, {
              status: testCase.status,
              statusText: testCase.statusText,
              headers,
            });
          },
          () =>
            testCase.route === "chat.completions"
              ? handleChatCompletions(
                  new Request("https://ai.ubq.fi/v1/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      model: DEFAULT_TEST_MODEL,
                      messages: [{ role: "user", content: "ping" }],
                    }),
                  })
                )
              : handleResponses(
                  new Request("https://ai.ubq.fi/v1/responses", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
                  })
                )
        );

        assert.equal(response.status, testCase.status);
        assert.equal(response.statusText, "");
        assert.equal(response.headers.get("Content-Type"), "application/json");
        assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
        assert.equal(response.headers.get("Retry-After"), testCase.retryAfter);
        assert.equal(response.headers.get("X-Codex-Diagnostic"), null);
        assert.deepEqual(await response.json(), { error: testCase.expectedError });
        if (testCase.route === "responses") {
          const telemetry = getResponseTelemetry(response);
          assert.ok(telemetry);
          assert.equal(telemetry.failureKind, testCase.status >= 500 ? "upstream_http_5xx" : "upstream_http_4xx");
          assert.equal(telemetry.streamTerminalType, "error");
          assert.equal(telemetry.responseCreatedObserved, false);
          assert.equal(telemetry.fallbackReason, null);
        }
        assert.equal(codexCalls, 1);
      });
    }
  }));

test("openai: error normalization bounds oversized and stalled upstream bodies", async () =>
  runSequence(async (step) => {
    const expectedError = {
      error: {
        message: "Upstream returned an oversized or incomplete error response.",
        type: "invalid_request_error",
        code: "upstream_error",
      },
    };

    await step("oversized bodies are cancelled without exposing partial content", async () => {
      let cancellations = 0;
      const oversized = new Uint8Array(65 * 1024);
      oversized.fill("x".charCodeAt(0));
      const startedAt = performance.now();
      const response = await withFetchMock(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(oversized);
              },
              cancel() {
                cancellations += 1;
              },
            }),
            {
              status: 422,
              headers: {
                "Content-Type": "application/problem+json",
                "X-Codex-Diagnostic": "drop-me",
              },
            }
          ),
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
            })
          )
      );

      assert.ok(performance.now() - startedAt < 500, "oversized body must be rejected before the reader deadline");
      assert.equal(response.status, 422);
      assert.equal(response.headers.get("Content-Type"), "application/json");
      assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
      assert.equal(response.headers.get("X-Codex-Diagnostic"), null);
      assert.deepEqual(await response.json(), expectedError);
      assert.equal(cancellations, 1);
    });

    setStreamFirstEventDeadlineMsForTest(100);
    try {
      for (const route of ["responses", "chat.completions"] as const) {
        await step(`${route} keeps the request deadline while reading an error body`, async () => {
          let cancellations = 0;
          const startedAt = performance.now();
          const response = await withFetchMock(
            () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  pull: () => neverSettlingPromise(),
                  cancel() {
                    cancellations += 1;
                  },
                }),
                { status: 400, headers: { "Content-Type": "application/problem+json" } }
              ),
            () =>
              route === "responses"
                ? handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }),
                    })
                  )
                : handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        messages: [{ role: "user", content: "ping" }],
                        stream: true,
                      }),
                    })
                  )
          );

          assert.ok(performance.now() - startedAt < 500, route);
          assert.equal(response.status, 400);
          assert.deepEqual(await response.json(), expectedError);
          assert.equal(cancellations, 1);
        });
      }
    } finally {
      setStreamFirstEventDeadlineMsForTest(null);
    }
  }));

test("openai: a failed half-open 2xx stream releases its routing lease", async () => {
  let codexCalls = 0;
  await withFetchMock(
    () => {
      codexCalls += 1;
      if (codexCalls === 1) {
        return sseResponse([
          `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_probe_failed", created_at: 0 } })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.failed",
            response: {
              id: "resp_probe_failed",
              status: "failed",
              model: DEFAULT_TEST_MODEL,
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
            },
          })}\n\n`,
        ]);
      }
      return sseResponse(baseSseChunks());
    },
    async () => {
      const pool = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as {
        accounts: {
          access_token: string;
          refresh_token: string;
          account_id: string;
        }[];
      };
      const account = pool.accounts[0];
      const credentialVersion = await sha256Hex(`${account.account_id}\u0000${account.access_token}\u0000${account.refresh_token}`);
      kvStore.set(keyToString(["uos_ai", "codex_account_routing", "v2"]), {
        v: 2,
        updated_at_ms: Date.now(),
        slots: [
          {
            credential_version: credentialVersion,
            quota_blocked_until_ms: Date.now() - 1,
            quota_block_source: "header_retry_after",
            invalid_credential_version: null,
            primary_used_percent: null,
            secondary_used_percent: null,
            observed_reset_at_ms: Date.now() - 1,
            generation: 1,
            probe_lease: null,
          },
        ],
      });

      const request = () =>
        new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "probe release" }),
        });
      const failed = await handleResponses(request());
      assert.equal(failed.status, 200);
      assert.equal(((await failed.json()) as { status?: string }).status, "failed");

      const second = await handleResponses(request());
      assert.equal(second.status, 200);
      assert.equal(second.headers.get("x-uos-upstream"), "chatgpt_codex");
      assert.equal(codexCalls, 2);
    }
  );
});
