import assert from "node:assert/strict";
import { test } from "bun:test";

import { handleCodexCatalogModels } from "../src/catalog/index.ts";
import { setKvForTest } from "../src/kv.ts";
import { resetOpenRouterModelsCacheForTest, setOpenRouterModelsFetchForTest } from "../src/models/openrouter-models.ts";
import { resetMeteredModelsCacheForTest, setMeteredModelsFetchForTest } from "../src/provider/metered.ts";

test("metered-only Codex catalog fallback starts OpenRouter enrichment", async () => {
  const originalMeteredKey = process.env.METERED_API_KEY;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  let openRouterFetches = 0;
  process.env.METERED_API_KEY = "metered-catalog-enrichment-test-key";
  delete process.env.SURPLUS_API_KEY;
  setKvForTest(null);
  resetMeteredModelsCacheForTest();
  resetOpenRouterModelsCacheForTest();
  setMeteredModelsFetchForTest(() =>
    Promise.resolve(Response.json({ data: [{ id: "metered-only-model", owned_by: "openlux", supported_endpoint_types: ["openai-response"] }] }))
  );
  setOpenRouterModelsFetchForTest(() => {
    openRouterFetches += 1;
    return Promise.resolve(Response.json({ data: [] }));
  });

  try {
    const response = await handleCodexCatalogModels(new Request("https://ai.ubq.fi/v1/models?client_version=0.250.0"), "0.250.0");
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models: { slug: string }[] };
    assert.ok(payload.models.some((model) => model.slug === "metered-only-model"));
    assert.equal(openRouterFetches, 1, "the paid-only fallback starts an OpenRouter metadata refresh");
  } finally {
    setMeteredModelsFetchForTest(null);
    setOpenRouterModelsFetchForTest(null);
    resetMeteredModelsCacheForTest();
    resetOpenRouterModelsCacheForTest();
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
  }
});
