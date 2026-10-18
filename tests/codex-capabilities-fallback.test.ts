import { test } from "bun:test";
import { type KvEntryMaybe, type KvKey } from "#kv";
import assert from "node:assert/strict";
import { SentinelKvStub } from "./helpers/sentinel-kv-stub.ts";

const { setKvForTest } = await import("../src/kv.ts");
const { CODEX_AUTH_POOL_KV_KEY, CODEX_MODELS_KV_KEY, resetCodexAuthCacheForTest } = await import("../src/codex/auth.ts");
const { loadFullCodexModelsSnapshot, loadCodexModelsSnapshot } = await import("../src/models/codex-models-fetch.ts");
const { buildModelCatalogSnapshot, handleModelCapabilities } = await import("../src/models/catalog.ts");
const { RUNTIME_CONFIG_V2_KEY, resetRuntimeConfigCacheForTest } = await import("../src/runtime-config.ts");
const { storeProviderSelection, resetProviderSelectionCacheForTest } = await import("../src/provider/selection.ts");
const { CODEX_MODELS_WHITELIST_KV_KEY, storeCodexModelsWhitelist } = await import("../src/models/codex-models-whitelist.ts");

const ACCOUNT = "bounded-catalog-account";
const MODEL = "bounded-catalog-model";
const VERSION = "0.160.0";

test("handleModelCapabilities retains Codex capability rows and reasoning tiers when full snapshot read fails", async () => {
  const kv = new SentinelKvStub();
  setKvForTest(kv);
  resetCodexAuthCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetProviderSelectionCacheForTest();

  const updatedAtMs = Date.now();
  await kv.set(RUNTIME_CONFIG_V2_KEY, {
    version: 2,
    default_model: MODEL,
    default_reasoning_effort: "none",
    codex_models: {
      source: "chatgpt_codex",
      client_version: VERSION,
      updated_at_ms: updatedAtMs,
      models: [
        {
          slug: MODEL,
          supported_reasoning_levels: ["high", "medium", "low"],
          default_reasoning_level: "medium",
          reasoning_effort_wire_map: { ultra: "max" },
        },
      ],
    },
    updated_at_ms: updatedAtMs,
  });

  const nativeGet = kv.get.bind(kv);
  kv.get = <T = unknown>(key: KvKey): Promise<KvEntryMaybe<T>> =>
    JSON.stringify(key) === JSON.stringify(CODEX_MODELS_KV_KEY) ? Promise.reject(new Error("synthetic optional read failure")) : nativeGet<T>(key);

  assert.equal(await loadFullCodexModelsSnapshot(kv), null);
  assert.ok(await loadCodexModelsSnapshot(kv), "loadCodexModelsSnapshot remains readable with kvOverride");

  // 1. Verify buildModelCatalogSnapshot still works (public catalog fallback)
  const snapshot = await buildModelCatalogSnapshot();
  assert.ok(snapshot.models.some((model) => model.id === MODEL), "buildModelCatalogSnapshot serves runtime fallback");

  // 2. Verify handleModelCapabilities retains model capability row and reasoning tiers
  const res = await handleModelCapabilities();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-uos-upstream"), "chatgpt_codex");

  const body = (await res.json()) as {
    object: string;
    upstream_provider: string;
    source: string;
    client_version: string | null;
    updated_at_ms: number | null;
    data: Array<Record<string, unknown>>;
  };

  assert.equal(body.object, "list");
  assert.equal(body.upstream_provider, "codex_chatgpt");
  assert.equal(body.source, "chatgpt_codex");
  assert.equal(body.client_version, VERSION);
  assert.equal(body.updated_at_ms, updatedAtMs);

  const modelRow = body.data.find((m) => m.id === MODEL);
  assert.ok(modelRow, "Codex model capability row is retained");
  assert.equal(modelRow.upstream_provider, "codex_chatgpt");
  assert.deepEqual(modelRow.supported_reasoning_levels, ["high", "medium", "low"]);
  assert.equal(modelRow.default_reasoning_effort, "medium");
  assert.deepEqual(modelRow.reasoning_effort_wire_map, { ultra: "max" });
  assert.equal(modelRow.reasoning_source, "codex_upload");

  // 3. Verify provider enablement: when codex is disabled, codex capability rows are excluded
  await storeProviderSelection(kv, ["openrouter"]);
  resetProviderSelectionCacheForTest();
  const disabledRes = await handleModelCapabilities();
  const disabledBody = (await disabledRes.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(!disabledBody.data.some((m) => m.id === MODEL), "disabled provider omits codex capability rows");

  // Re-enable codex
  await storeProviderSelection(kv, ["codex"]);
  resetProviderSelectionCacheForTest();

  // 4. Verify whitelist filtering: when whitelist excludes MODEL, row is filtered out
  await storeCodexModelsWhitelist(kv, ["other-whitelisted-model"]);
  const whitelistedRes = await handleModelCapabilities();
  const whitelistedBody = (await whitelistedRes.json()) as { data: Array<Record<string, unknown>> };
  assert.ok(!whitelistedBody.data.some((m) => m.id === MODEL), "whitelist filtering is strictly preserved");
});
