import { test } from "bun:test";
import assert from "node:assert/strict";

import { meteredCodexModelRecord, openRouterCodexModels } from "../src/catalog/models.ts";
import { fetchOpenRouterModels, openRouterModelsSnapshot, resetOpenRouterModelsCacheForTest } from "../src/models/openrouter-models.ts";

const modelId = "~anthropic/claude-opus-latest";
const paidModel = { id: modelId, owned_by: "anthropic", supported_endpoint_types: ["openai-response"] };
const nativeEfforts = (model: Record<string, unknown>): string[] => (model.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort);

const withExternalReasoning = async (levels: readonly string[], defaultEffort: string, check: () => void): Promise<void> => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "catalog-reasoning-order-test-key";
  resetOpenRouterModelsCacheForTest();
  try {
    await fetchOpenRouterModels({
      force: true,
      fetcher: () =>
        Promise.resolve(Response.json({ data: [{ id: modelId, reasoning: { supported_efforts: levels, default_effort: defaultEffort, mandatory: false } }] })),
    });
    check();
    assert.deepEqual(openRouterModelsSnapshot()?.models[0].reasoning?.supported_efforts, levels, "native projection does not mutate the external snapshot");
  } finally {
    resetOpenRouterModelsCacheForTest();
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
};

test("codex native catalog: reversed external Claude efforts become ascending without adding tiers", async () => {
  await withExternalReasoning(["max", "xhigh", "high", "medium", "low"], "high", () => {
    const openRouterRow = openRouterCodexModels().find((model) => model.slug === modelId);
    assert.ok(openRouterRow);
    const paidOnlyRow = meteredCodexModelRecord(paidModel);
    for (const row of [openRouterRow, paidOnlyRow]) {
      assert.deepEqual(nativeEfforts(row), ["low", "medium", "high", "xhigh", "max"]);
      assert.equal(row.default_reasoning_level, "high");
    }
  });
});

test("codex native catalog: standard tiers sort while unknown tiers keep their strings and positions", async () => {
  const levels = ["ultra", "custom-v1", "max", "high", "CUSTOM", "xhigh", "medium", "minimal", "low", "none"];
  await withExternalReasoning(levels, "custom-v1", () => {
    for (const row of [...openRouterCodexModels(), meteredCodexModelRecord(paidModel)]) {
      assert.deepEqual(nativeEfforts(row), ["none", "custom-v1", "minimal", "low", "CUSTOM", "medium", "high", "xhigh", "max", "ultra"]);
      assert.equal(row.default_reasoning_level, "custom-v1");
    }
  });
});

test("codex native catalog: uploaded Codex effort order and default retain precedence over external metadata", async () => {
  await withExternalReasoning(["low", "medium", "high", "xhigh", "max"], "medium", () => {
    const uploadedLevels = ["max", "custom-v1", "xhigh", "high", "low"];
    const uploaded = { slug: modelId, supported_reasoning_levels: uploadedLevels, default_reasoning_level: "max" };
    const row = meteredCodexModelRecord(paidModel, uploaded);
    assert.deepEqual(nativeEfforts(row), uploadedLevels);
    assert.equal(row.default_reasoning_level, "max");
    assert.deepEqual(uploaded.supported_reasoning_levels, uploadedLevels);
  });
});
