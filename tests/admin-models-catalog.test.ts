import { createFetchMock } from "./helpers/fetch-mock.ts";
import { readFileSync } from "node:fs";
import type { AtomicCheck, Kv, KvCommitError, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

const adminHtml = readFileSync(new URL("../static/admin.html", import.meta.url), "utf8");
const adminScript = readFileSync(new URL("../static/admin.js", import.meta.url), "utf8");
const modelsScript = readFileSync(new URL("../static/models.js", import.meta.url), "utf8");
const adminCodexSource = readFileSync(new URL("../src/admin/codex.ts", import.meta.url), "utf8");
import {
  handleAdminCodexModelsWhitelistGet,
  handleAdminCodexModelsWhitelistSet,
  handleAdminModelsCatalogGet,
  handleAdminModelsRefresh,
} from "../src/admin/index.ts";
import {
  CODEX_MODELS_WHITELIST_KV_KEY,
  filterWhitelistedCatalogModels,
  filterWhitelistedModelList,
  filterWhitelistedModelMap,
  normalizeWhitelistModelIds,
  type CodexModelsWhitelist,
} from "../src/models/codex-models-whitelist.ts";
import handler from "../src/handler/index.ts";
const handlerSource = readFileSync(new URL("../src/handler/index.ts", import.meta.url), "utf8");
import { resetOpenRouterModelsCacheForTest, type OpenRouterModelsSnapshot } from "../src/models/openrouter-models.ts";
import { setKvForTest } from "../src/kv.ts";
import { buildModelCatalogSnapshot, handleModels, handlePublicModelCatalog } from "../src/models/catalog.ts";
const openaiSource = readFileSync(new URL("../src/models/catalog.ts", import.meta.url), "utf8");
import { CODEX_MODELS_KV_KEY, loadFullCodexModelsSnapshot } from "../src/codex/index.ts";
import { buildRuntimeConfig, resetRuntimeConfigCacheForTest, RUNTIME_CONFIG_V2_KEY } from "../src/runtime-config.ts";
import { loadProviderSelection, PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } from "../src/provider/selection.ts";
import { CODEX_CATALOG_AUTH_GENERATION_KEY } from "../src/catalog/types.ts";
import { resetMeteredModelsCacheForTest, setMeteredModelsFetchForTest } from "../src/provider/metered.ts";
import { resetSurplusModelsCacheForTest } from "../src/provider/surplus.ts";
import { DEEPSEEK_WATERFALL_MODEL_ID } from "../src/deepseek/waterfall.ts";

// The catalog builder reads discovery credentials from the environment. Clearing
// them keeps these tests on the credential-gated providers they own, and keeps
// the discovery fetches from reaching a network the test task does not allow.
delete process.env.METERED_API_KEY;
delete process.env.SURPLUS_API_KEY;

const WHITELIST_URL = "https://ai.ubq.fi/admin/models/whitelist";

const keyOf = (key: KvKey): string => JSON.stringify(key);

/** Minimal Kv stand-in: the whitelist paths only read and write one key. */
class WhitelistKv {
  readonly values = new Map<string, unknown>();
  private readonly _versions = new Map<string, string>();
  private _revision = 1;

  private _version(key: KvKey): string | null {
    return this.values.has(keyOf(key)) ? (this._versions.get(keyOf(key)) ?? "00000000000000000001") : null;
  }

  atomic() {
    const checks: AtomicCheck[] = [];
    const writes: (() => void)[] = [];
    const operation = {
      check: (...entries: AtomicCheck[]) => {
        checks.push(...entries);
        return operation;
      },
      set: (key: KvKey, value: unknown) => {
        writes.push(() => {
          this.values.set(keyOf(key), value);
          this._versions.set(keyOf(key), String(this._revision).padStart(20, "0"));
        });
        return operation;
      },
      delete: (key: KvKey) => {
        writes.push(() => {
          this.values.delete(keyOf(key));
          this._versions.delete(keyOf(key));
        });
        return operation;
      },
      commit: (): Promise<KvCommitResult | KvCommitError> => {
        if (checks.some((entry) => entry.versionstamp !== this._version(entry.key))) return Promise.resolve({ ok: false });
        this._revision++;
        for (const write of writes) write();
        return Promise.resolve({ ok: true, versionstamp: String(this._revision).padStart(20, "0") });
      },
    };
    return operation;
  }

  get<T>(key: KvKey, _options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    const stored = this.values.get(keyOf(key));
    return Promise.resolve({
      key,
      value: (stored ?? null) as T | null,
      versionstamp: this._version(key),
    } as KvEntryMaybe<T>);
  }

  set(key: KvKey, value: unknown): Promise<KvCommitResult> {
    this.values.set(keyOf(key), value);
    this._revision++;
    const versionstamp = String(this._revision).padStart(20, "0");
    this._versions.set(keyOf(key), versionstamp);
    return Promise.resolve({ ok: true, versionstamp });
  }

  storedWhitelist(): CodexModelsWhitelist | null {
    return (this.values.get(keyOf([...CODEX_MODELS_WHITELIST_KV_KEY])) ?? null) as CodexModelsWhitelist | null;
  }
}

/** Reject selected reads asynchronously, leaving the independent runtime/control keys readable. */
class RejectingReadKv extends WhitelistKv {
  readonly rejectedKeys = new Set<string>();
  readonly reads: { key: string; consistency?: "strong" | "eventual" }[] = [];

  override get<T>(key: KvKey, options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    const encodedKey = keyOf(key);
    this.reads.push({ key: encodedKey, consistency: options?.consistency });
    if (this.rejectedKeys.has(encodedKey)) return Promise.reject(new Error("fixture KV read unavailable"));
    return super.get<T>(key, options);
  }
}

const catalogFixture = () => ({
  models: [
    { id: "gpt-5.6-sol", providers: [{ id: "codex" as const, owned_by: "openai", supported_endpoints: ["/v1/responses"] }], created: 1_800_000_000 },
    { id: "gpt-5.6-terra", providers: [{ id: "codex" as const, owned_by: "openai", supported_endpoints: ["/v1/responses"] }], created: 1_700_000_000 },
    {
      id: "kimi-k2",
      providers: [{ id: "surplus" as const, owned_by: "moonshot", supported_endpoints: ["/v1/chat/completions"] }],
    },
    {
      id: "deepseek-v4-flash",
      providers: [{ id: "deepseek" as const, owned_by: "deepseek", supported_endpoints: ["/v1/chat/completions", "/v1/responses"] }],
    },
  ],
  sources: {
    claude_code: { status: "unavailable" as const, count: 0, updated_at_ms: null, configured: false },
    codex: { status: "available" as const, count: 2, updated_at_ms: 1 },
    openlux: { status: "unavailable" as const, count: 0, updated_at_ms: null },
    surplus: { status: "available" as const, count: 1, updated_at_ms: 2 },
    deepseek: { status: "available" as const, count: 1, updated_at_ms: null, configured: true },
    cerebras: { status: "unavailable" as const, count: 0, updated_at_ms: null, configured: false },
    // The catalog source id union gained the LithosAI provider; this fixture is
    // typed as a whole snapshot, so it must name every source id.
    lithos: { status: "unavailable" as const, count: 0, updated_at_ms: null, configured: false },
    openrouter: { status: "unavailable" as const, count: 0, updated_at_ms: null },
  },
});

const withKv = async (kv: WhitelistKv | null, run: () => Promise<void>): Promise<void> => {
  setKvForTest(kv as unknown as Kv | null);
  try {
    await run();
  } finally {
    setKvForTest(null);
  }
};

let fixtureFetch = globalThis.fetch;
beforeEach(() => {
  fixtureFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.reject(new Error("Provider discovery requires an explicit local fixture")));
  resetOpenRouterModelsCacheForTest();
  resetSurplusModelsCacheForTest();
});
afterEach(() => {
  globalThis.fetch = fixtureFetch;
  resetOpenRouterModelsCacheForTest();
  resetSurplusModelsCacheForTest();
});

test("admin model picker lists every discovered model alongside the saved selection", async () => {
  const kv = new WhitelistKv();
  kv.values.set(keyOf([...CODEX_MODELS_WHITELIST_KV_KEY]), { model_ids: ["gpt-5.6-sol"], updated_at_ms: 1_700_000_000_000 });
  await withKv(kv, async () => {
    let builds = 0;
    const response = await handleAdminModelsCatalogGet({
      buildCatalog: () => {
        builds += 1;
        return Promise.resolve(catalogFixture());
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(builds, 1);
    const body = await response.json();
    assert.deepEqual(
      body.data.models.map((model: { id: string }) => model.id),
      ["gpt-5.6-sol", "gpt-5.6-terra", "kimi-k2", "deepseek-v4-flash"],
      "an unfiltered catalog keeps the hidden models selectable"
    );
    assert.deepEqual(body.data.whitelist.model_ids, ["gpt-5.6-sol"]);
    assert.equal(body.data.whitelist.updated_at_ms, 1_700_000_000_000);
    assert.equal(body.data.filter_active, true);
    assert.deepEqual(body.data.sources, catalogFixture().sources, "per-source availability reaches the operator");
  });
});

test("an empty stored whitelist is reported as no filter, not as nothing selected", async () => {
  const kv = new WhitelistKv();
  await withKv(kv, async () => {
    const empty = await handleAdminModelsCatalogGet({ buildCatalog: () => Promise.resolve(catalogFixture()) });
    const emptyBody = await empty.json();
    assert.deepEqual(emptyBody.data.whitelist, { model_ids: [], updated_at_ms: 0 });
    assert.equal(emptyBody.data.filter_active, false);

    kv.values.set(keyOf([...CODEX_MODELS_WHITELIST_KV_KEY]), { model_ids: [], updated_at_ms: 1_700_000_000_000 });
    const stored = await handleAdminModelsCatalogGet({ buildCatalog: () => Promise.resolve(catalogFixture()) });
    const storedBody = await stored.json();
    assert.equal(storedBody.data.filter_active, false, "an empty saved list lists every model");
  });
});

test("the official DeepSeek ids are cataloged as their own provider category", async () => {
  resetSurplusModelsCacheForTest();
  resetOpenRouterModelsCacheForTest();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.reject(new Error("Provider discovery is unavailable in this fixture")));
  delete process.env.CEREBRAS_API_KEY;
  process.env.DEEPSEEK_API_KEY = "fixture-deepseek-key";
  try {
    const catalog = await buildModelCatalogSnapshot();
    // The gateway waterfall model also carries a deepseek hop row and is
    // asserted separately; this test owns the official ids themselves.
    const rows = catalog.models.filter((model) => model.id !== DEEPSEEK_WATERFALL_MODEL_ID && model.providers.some((provider) => provider.id === "deepseek"));
    assert.deepEqual(
      rows.map((model) => model.id),
      ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"],
      "every model the provider publishes is selectable in the picker"
    );
    for (const row of rows) {
      assert.deepEqual(
        row.providers.map((provider) => provider.id),
        ["deepseek"],
        "the provider's own models are listed without another provider confirming them"
      );
      assert.deepEqual(row.providers[0].supported_endpoints, ["/v1/chat/completions", "/v1/responses"]);
      assert.equal(row.context_source, "provider_discovery");
      assert.equal(row.context_window_tokens, 1_000_000);
    }
    assert.deepEqual(catalog.sources.deepseek, { status: "available", count: 3, updated_at_ms: null, configured: true });
    assert.deepEqual(catalog.sources.cerebras, { status: "unavailable", count: 0, updated_at_ms: null, configured: false });
  } finally {
    globalThis.fetch = originalFetch;
    resetSurplusModelsCacheForTest();
    resetOpenRouterModelsCacheForTest();
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("the gateway waterfall model is cataloged with one provider row per usable hop in cost-first order", async () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.LITHOSAI_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  process.env.OPENROUTER_API_KEY = "fixture-openrouter-key";
  process.env.DEEPSEEK_API_KEY = "fixture-deepseek-key";
  try {
    const catalog = await buildModelCatalogSnapshot();
    const row = catalog.models.find((model) => model.id === DEEPSEEK_WATERFALL_MODEL_ID);
    assert.ok(row, "a configured hop makes the waterfall model selectable");
    assert.deepEqual(
      row.providers.map((provider) => provider.id),
      ["ubiquity", "deepseek", "openrouter"],
      "the gateway identity leads, with one row per usable hop behind it in cost-first order"
    );
    assert.deepEqual(row.providers[0].supported_endpoints, ["/v1/responses"]);
    assert.equal(row.providers[0].owned_by, "ubiquity");
    assert.equal(row.context_window_tokens, 1_048_576);
    assert.equal(row.context_source, "provider_discovery");
    assert.deepEqual(row.supported_reasoning_levels, ["low", "high", "max"]);
    assert.equal(row.default_reasoning_effort, "high");
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("the gateway waterfall model lists the paid hops, OpenLux last, when their credentials are configured", async () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.LITHOSAI_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  process.env.SURPLUS_API_KEY = "fixture-surplus-key";
  process.env.METERED_API_KEY = "fixture-metered-key";
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  try {
    const catalog = await buildModelCatalogSnapshot();
    const row = catalog.models.find((model) => model.id === DEEPSEEK_WATERFALL_MODEL_ID);
    assert.ok(row, "a paid credential alone makes the waterfall model selectable");
    assert.deepEqual(
      row.providers.map((provider) => provider.id),
      ["ubiquity", "surplus", "openlux"],
      "the paid hops keep the fixed cost order and the OpenLux row joins last"
    );
    for (const provider of row.providers.slice(1)) {
      assert.equal(provider.owned_by, "ubiquity");
      assert.deepEqual(provider.supported_endpoints, ["/v1/responses"]);
    }
    assert.equal(row.context_window_tokens, 1_048_576);
    assert.deepEqual(row.supported_reasoning_levels, ["low", "high", "max"]);
    assert.equal(row.default_reasoning_effort, "high");
  } finally {
    delete process.env.SURPLUS_API_KEY;
    delete process.env.METERED_API_KEY;
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
  }
});

test("a credential-gated provider with no key is absent instead of unavailable", async () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.CEREBRAS_API_KEY;
  try {
    const catalog = await buildModelCatalogSnapshot();
    assert.equal(
      catalog.models.some((model) => model.providers.some((provider) => provider.id === "deepseek")),
      false
    );
    assert.equal(
      catalog.models.some((model) => model.providers.some((provider) => provider.id === "cerebras")),
      false
    );
    assert.equal(catalog.sources.deepseek.configured, false);
    assert.equal(catalog.sources.deepseek.status, "unavailable");
    assert.equal(catalog.sources.cerebras.configured, false);
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
  }
});

test("Cerebras claims its id unless the Codex snapshot already owns it", async () => {
  delete process.env.DEEPSEEK_API_KEY;
  process.env.CEREBRAS_API_KEY = "fixture-cerebras-key";
  try {
    const catalog = await buildModelCatalogSnapshot();
    const row = catalog.models.find((model) => model.id === "gpt-oss-120b");
    assert.ok(row, "the configured Cerebras model is cataloged");
    assert.deepEqual(
      row.providers.map((provider) => provider.id),
      ["cerebras"]
    );
    assert.deepEqual(row.providers[0].supported_endpoints, ["/v1/chat/completions"]);
    const qwenRow = catalog.models.find((model) => model.id === "qwen-3.8-27b");
    assert.ok(qwenRow, "the second configured Cerebras model is cataloged");
    assert.deepEqual(
      qwenRow.providers.map((provider) => provider.id),
      ["cerebras"]
    );
    assert.deepEqual(catalog.sources.cerebras, { status: "available", count: 2, updated_at_ms: null, configured: true });
  } finally {
    delete process.env.CEREBRAS_API_KEY;
  }
});

test("the model picker refuses to render without KV", async () => {
  await withKv(null, async () => {
    const response = await handleAdminModelsCatalogGet({
      buildCatalog: () => Promise.reject(new Error("the catalog must not be built without KV")),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.type, "server_error");
  });
});

test("catalog builder and public/admin handlers retain runtime ids and tiers when the optional full snapshot rejects", async () => {
  const kv = new RejectingReadKv();
  kv.rejectedKeys.add(keyOf(CODEX_MODELS_KV_KEY));
  const runtime = buildRuntimeConfig({
    source: "runtime-fallback-fixture",
    updated_at_ms: 1_800_000_000_000,
    models: [
      { slug: "runtime-fallback", supported_reasoning_levels: ["low", "ultra"], default_reasoning_level: "ultra" },
      { slug: "runtime-hidden", supported_reasoning_levels: ["none"], default_reasoning_level: "none" },
    ],
  });
  kv.values.set(keyOf(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(keyOf(CODEX_MODELS_WHITELIST_KV_KEY), { model_ids: ["runtime-fallback"], updated_at_ms: 1_800_000_000_001 });
  kv.values.set(keyOf(PROVIDER_SELECTION_KV_KEY), { provider_ids: ["codex"], updated_at_ms: 1_800_000_000_002 });
  resetRuntimeConfigCacheForTest();
  resetProviderSelectionCacheForTest();
  try {
    await withKv(kv, async () => {
      const catalog = await buildModelCatalogSnapshot();
      const codexRows = catalog.models.filter((model) => model.providers.some((provider) => provider.id === "codex"));
      assert.deepEqual(
        codexRows.map((model) => model.id),
        ["runtime-fallback", "runtime-hidden"]
      );
      assert.deepEqual(codexRows[0].supported_reasoning_levels, ["low", "ultra"]);
      assert.equal(codexRows[0].default_reasoning_effort, "ultra");
      assert.deepEqual(catalog.sources.codex, { status: "available", count: 2, updated_at_ms: runtime.codex_models.updated_at_ms });

      const publicResponse = await handlePublicModelCatalog();
      assert.equal(publicResponse.status, 200);
      const publicBody = await publicResponse.json();
      assert.equal(publicBody.object, "uos.model_catalog");
      assert.deepEqual(
        publicBody.data.map((model: { id: string }) => model.id),
        ["runtime-fallback"]
      );
      assert.deepEqual(publicBody.data[0].supported_reasoning_levels, ["low", "ultra"]);
      assert.equal(publicBody.data[0].default_reasoning_effort, "ultra");

      const adminResponse = await handleAdminModelsCatalogGet();
      assert.equal(adminResponse.status, 200);
      const adminBody = await adminResponse.json();
      assert.deepEqual(
        adminBody.data.models
          .filter((model: { providers: { id: string }[] }) => model.providers.some((provider) => provider.id === "codex"))
          .map((model: { id: string }) => model.id),
        ["runtime-fallback", "runtime-hidden"]
      );
      const adminRow = adminBody.data.models.find((model: { id: string }) => model.id === "runtime-fallback");
      assert.deepEqual(adminRow.supported_reasoning_levels, ["low", "ultra"]);
      assert.equal(adminRow.default_reasoning_effort, "ultra");
      assert.deepEqual(adminBody.data.whitelist.model_ids, ["runtime-fallback"]);
      assert.equal(adminBody.data.filter_active, true);
      assert.equal(kv.reads.filter((read) => read.key === keyOf(CODEX_MODELS_KV_KEY) && read.consistency === "strong").length, 3);
      assert.ok(kv.reads.some((read) => read.key === keyOf(RUNTIME_CONFIG_V2_KEY) && read.consistency === "strong"));
    });
  } finally {
    resetRuntimeConfigCacheForTest();
    resetProviderSelectionCacheForTest();
  }
});

test("optional snapshot failure containment preserves snapshot shape checks and critical control read failures", async () => {
  const kv = new RejectingReadKv();
  const validSnapshot = { models: [{ slug: "valid-model" }], source: "fixture", updated_at_ms: 1 };
  await withKv(kv, async () => {
    kv.values.set(keyOf(CODEX_MODELS_KV_KEY), validSnapshot);
    assert.deepEqual(await loadFullCodexModelsSnapshot(), validSnapshot);
    for (const invalidSnapshot of [
      { ...validSnapshot, models: [] },
      { ...validSnapshot, models: [null] },
      { ...validSnapshot, source: " " },
      { ...validSnapshot, updated_at_ms: 0 },
      { ...validSnapshot, updated_at_ms: 1.5 },
    ]) {
      kv.values.set(keyOf(CODEX_MODELS_KV_KEY), invalidSnapshot);
      assert.equal(await loadFullCodexModelsSnapshot(), null);
    }
    kv.rejectedKeys.add(keyOf(CODEX_MODELS_KV_KEY));
    kv.rejectedKeys.add(keyOf(CODEX_MODELS_WHITELIST_KV_KEY));
    kv.rejectedKeys.add(keyOf(PROVIDER_SELECTION_KV_KEY));
    assert.equal(await loadFullCodexModelsSnapshot(), null);
    await assert.rejects(() => handleAdminModelsCatalogGet(), /fixture KV read unavailable/);
    await assert.rejects(() => loadProviderSelection(kv as unknown as Kv), /fixture KV read unavailable/);
    const unauthenticated = await handler(new Request("https://ai.ubq.fi/admin/models/catalog"));
    assert.equal(unauthenticated.status, 401);
  });
});

test("versioned rich paid catalog survives rejected optional snapshots without invented enrichment or relaxed controls", async () => {
  const kv = new RejectingReadKv();
  // A cold, unreadable catalog generation takes the real paid recovery branch.
  kv.rejectedKeys.add(keyOf(CODEX_CATALOG_AUTH_GENERATION_KEY));
  kv.rejectedKeys.add(keyOf(CODEX_MODELS_KV_KEY));
  kv.values.set(keyOf(PROVIDER_SELECTION_KV_KEY), { provider_ids: ["openlux"], updated_at_ms: 1_800_000_000_000 });
  kv.values.set(keyOf(CODEX_MODELS_WHITELIST_KV_KEY), { model_ids: ["paid-fallback-fixture"], updated_at_ms: 1_800_000_000_001 });
  const originalFetch = globalThis.fetch;
  const originalMeteredKey = process.env.METERED_API_KEY;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  let paidFetches = 0;
  let unexpectedFetches = 0;
  process.env.METERED_API_KEY = "fixture-paid-catalog-key";
  process.env.SURPLUS_API_KEY = "fixture-disabled-surplus-key";
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  resetOpenRouterModelsCacheForTest();
  resetProviderSelectionCacheForTest();
  setMeteredModelsFetchForTest((input) => {
    assert.equal(input instanceof Request ? input.url : input.toString(), "https://api.openlux.ai/v1/models");
    paidFetches += 1;
    return Promise.resolve(
      Response.json({
        data: [
          { id: "paid-fallback-fixture", description: "Synthetic paid discovery", owned_by: "fixture", supported_endpoint_types: ["openai-response"] },
          { id: "paid-not-whitelisted", owned_by: "fixture", supported_endpoint_types: ["openai-response"] },
          { id: "paid-chat-only", owned_by: "fixture", supported_endpoint_types: ["openai"] },
        ],
      })
    );
  });
  globalThis.fetch = createFetchMock(() => {
    unexpectedFetches += 1;
    return Promise.reject(new Error("unexpected provider fetch"));
  });
  const request = () => new Request("https://ai.ubq.fi/v1/models?client_version=0.203.0");
  try {
    await withKv(kv, async () => {
      // Preserve the original rejected strong-read trigger independently of the handler's recovery.
      await assert.rejects(() => kv.get(CODEX_MODELS_KV_KEY, { consistency: "strong" }), /fixture KV read unavailable/);
      for (const rejected of [true, false]) {
        if (!rejected) {
          kv.rejectedKeys.delete(keyOf(CODEX_MODELS_KV_KEY));
          kv.values.set(keyOf(CODEX_MODELS_KV_KEY), {
            source: " ",
            updated_at_ms: 1_800_000_000_000,
            models: [{ slug: "paid-fallback-fixture", context_window: 999_999, supported_reasoning_levels: ["high"] }],
          });
        }
        const response = await handleModels(request());
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-upstream"), "metered");
        assert.match(response.headers.get("content-type") ?? "", /application\/json/);
        const body = await response.json();
        assert.equal(body.data, undefined, "the versioned response stays a rich Codex catalog");
        assert.deepEqual(
          body.models.map((model: { slug: string }) => model.slug),
          ["paid-fallback-fixture"]
        );
        const row = body.models[0];
        assert.equal(row.description, "Synthetic paid discovery");
        assert.deepEqual(row.supported_endpoint_types, ["openai-response"]);
        assert.deepEqual(row.supported_reasoning_levels, [{ effort: "none", description: "No reasoning" }]);
        assert.equal(row.default_reasoning_level, "none");
        assert.equal(row.context_window, undefined);
        assert.equal(row.max_context_window, undefined);
        assert.equal(row.auto_compact_token_limit, undefined);
        assert.equal(row.visibility, "list");
        assert.equal(row.supported_in_api, true);
      }
      assert.equal(paidFetches, 2);
      const readsBeforeInvalidVersion = kv.reads.length;
      const invalidVersion = await handleModels(new Request("https://ai.ubq.fi/v1/models?client_version=invalid"));
      assert.equal(invalidVersion.status, 400);
      assert.equal((await invalidVersion.json()).error.code, "invalid_client_version");
      assert.equal(kv.reads.length, readsBeforeInvalidVersion);
      assert.equal(paidFetches, 2);
      kv.rejectedKeys.add(keyOf(CODEX_MODELS_KV_KEY));
      kv.rejectedKeys.add(keyOf(CODEX_MODELS_WHITELIST_KV_KEY));
      await assert.rejects(() => handleModels(request()), /fixture KV read unavailable/);
      assert.equal(unexpectedFetches, 0, "disabled Surplus and other providers make no requests");
      assert.ok(kv.reads.filter((read) => read.key === keyOf(CODEX_MODELS_KV_KEY)).every((read) => read.consistency === "strong"));
    });
  } finally {
    globalThis.fetch = originalFetch;
    setMeteredModelsFetchForTest(null);
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    resetOpenRouterModelsCacheForTest();
    resetProviderSelectionCacheForTest();
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
  }
});

test("saving a selection trims, de-duplicates, and preserves the operator's order", async () => {
  const kv = new WhitelistKv();
  await withKv(kv, async () => {
    const saved = await handleAdminCodexModelsWhitelistSet(
      new Request(WHITELIST_URL, {
        method: "POST",
        body: JSON.stringify({ model_ids: [" gpt-5.6-sol ", "gpt-5.6-sol", "", "  ", "gpt-5.6-terra"] }),
      })
    );
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.deepEqual(savedBody.model_ids, ["gpt-5.6-sol", "gpt-5.6-terra"]);
    assert.equal(savedBody.stored, true);
    assert.deepEqual(kv.storedWhitelist()?.model_ids, ["gpt-5.6-sol", "gpt-5.6-terra"], "KV stores the canonical order");

    const read = await handleAdminCodexModelsWhitelistGet();
    assert.deepEqual((await read.json()).data.model_ids, ["gpt-5.6-sol", "gpt-5.6-terra"]);

    const cleared = await handleAdminCodexModelsWhitelistSet(new Request(WHITELIST_URL, { method: "POST", body: JSON.stringify({ model_ids: [] }) }));
    assert.equal(cleared.status, 200);
    assert.deepEqual(kv.storedWhitelist()?.model_ids, [], "an empty selection clears the filter");
  });
});

test("the model picker rejects a selection it cannot store faithfully", async () => {
  const kv = new WhitelistKv();
  await withKv(kv, async () => {
    for (const body of ['{"model_ids":"gpt-5.6-sol"}', '{"model_ids":[42]}', "not json", "{}"]) {
      const response = await handleAdminCodexModelsWhitelistSet(new Request(WHITELIST_URL, { method: "POST", body }));
      assert.equal(response.status, 400, body);
      assert.equal((await response.json()).error.type, "invalid_request_error");
    }
    assert.equal(kv.storedWhitelist(), null, "a rejected selection must not be persisted");

    const oversized = await handleAdminCodexModelsWhitelistSet(
      new Request(WHITELIST_URL, {
        method: "POST",
        body: JSON.stringify({ model_ids: Array.from({ length: 4_000 }, (_, index) => `model-${index}-${"x".repeat(40)}`) }),
      })
    );
    assert.equal(oversized.status, 413);
    assert.equal(kv.storedWhitelist(), null);
  });
});

test("normalizeWhitelistModelIds keeps the first spelling of every identifier", () => {
  assert.deepEqual(normalizeWhitelistModelIds([" a ", "b", "a", "", "   ", 7, null, "c"]), ["a", "b", "c"]);
  assert.deepEqual(normalizeWhitelistModelIds([]), []);
});

test("whitelist filters hide unlisted models on every model surface, and an empty list hides none", () => {
  const listModels = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const catalogModels = [{ slug: "a" }, { id: "b" }, { name: "c" }];
  const entries = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const saved = (modelIds: readonly string[]): CodexModelsWhitelist => ({ model_ids: modelIds, updated_at_ms: 1 });

  assert.deepEqual(
    filterWhitelistedModelList(listModels, null).map((model) => model.id),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    filterWhitelistedModelList(listModels, saved([])).map((model) => model.id),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    filterWhitelistedModelList(listModels, saved(["b", "gone"])).map((model) => model.id),
    ["b"]
  );

  assert.deepEqual(filterWhitelistedCatalogModels(catalogModels, null).length, 3);
  assert.deepEqual(filterWhitelistedCatalogModels(catalogModels, saved([])).length, 3);
  assert.deepEqual(
    filterWhitelistedCatalogModels(catalogModels, saved(["a", "c"])).map((model) => model.slug ?? model.id ?? model.name),
    ["a", "c"]
  );

  assert.deepEqual(filterWhitelistedModelMap(entries, saved([])).length, 3);
  assert.deepEqual(
    filterWhitelistedModelMap(entries, saved(["c"])).map((entry) => entry.id),
    ["c"]
  );
});

test("the model picker route is registered and stays behind admin auth", async () => {
  const unauthenticated = await handler(new Request("https://ai.ubq.fi/admin/models/catalog"));
  assert.equal(unauthenticated.status, 401, "an unauthenticated catalog read reaches the admin gate instead of 404");
  const unknown = await handler(new Request("https://ai.ubq.fi/admin/models/catalog-unknown"));
  assert.equal(unknown.status, 404);
});

test("the public and admin catalogs are built by one shared unfiltered snapshot", () => {
  // Drift guard: the admin picker must list models the whitelist hides, and the
  // public catalog must apply the whitelist to the very same snapshot with no
  // row, OpenRouter's dynamic entries included, bypassing it afterwards.
  const publicHandler = /export const handlePublicModelCatalog = async \(\): Promise<Response> => \{([\s\S]*?)\n\};/.exec(openaiSource)?.[1] ?? "";
  assert.notEqual(publicHandler, "", "handlePublicModelCatalog must stay declared");
  assert.match(publicHandler, /const \[catalog, selection\] = await Promise\.all\(\[buildModelCatalogSnapshot\(\), loadProviderSelectionCached\(\)\]\);/);
  assert.match(publicHandler, /const selected = filterCatalogEntriesByProviderSelection\(catalog\.models, selection\);/);
  assert.match(publicHandler, /filterWhitelistedModelMap\(\s*selected,\s*catalogWhitelist\s*\)/s);
  assert.doesNotMatch(publicHandler, /openRouterEntries|openRouterIds/, "no public row may skip the operator whitelist");
  assert.match(publicHandler, /sources: selectedCatalogSources\(catalog\.sources, selection\)/);

  const adminHandler = /export const handleAdminModelsCatalogGet = async \(([\s\S]*?)\n\};/.exec(adminCodexSource)?.[1] ?? "";
  assert.notEqual(adminHandler, "", "handleAdminModelsCatalogGet must stay declared");
  assert.match(adminHandler, /const buildCatalog = dependencies\.buildCatalog \?\? buildModelCatalogSnapshot;/);
  assert.match(adminHandler, /models: catalog\.models/);
  assert.doesNotMatch(adminHandler, /filterWhitelisted/, "the picker must not hide the models it can re-enable");
  assert.doesNotMatch(adminHandler, /filterCatalogEntriesByProviderSelection/, "a switched-off provider's models must stay pickable");
});

test("the Models tab renders checkbox tools instead of a free-text whitelist", () => {
  assert.match(adminHtml, /id="models-whitelist-list" data-model-picker/);
  assert.doesNotMatch(adminHtml, /models-whitelist-input/);
  assert.doesNotMatch(adminScript, /modelsWhitelistInput/);
  for (const id of [
    "models-whitelist-search",
    "models-whitelist-sort",
    "models-whitelist-only-selected",
    "models-whitelist-check-all",
    "models-whitelist-uncheck-all",
    "models-whitelist-invert",
    "models-whitelist-drop-missing",
    "models-whitelist-discard",
    "models-whitelist-reload",
    "models-metadata-refresh",
    "models-whitelist-save",
    "models-whitelist-badge",
    "models-whitelist-summary",
    "models-whitelist-warning",
  ]) {
    assert.match(adminHtml, new RegExp(`id="${id}"`), `${id} must be rendered`);
    assert.match(adminScript, new RegExp(`mustGet\\("${id}"\\)`), `${id} must be wired`);
  }
  // The chips are rendered from the roster the API returns, so the markup holds
  // the container only and the panel keeps no provider list of its own.
  assert.match(adminHtml, /<div data-model-filters role="group" aria-label="Filter by provider"><\/div>/);
  assert.doesNotMatch(adminHtml, /data-model-provider=/);
  assert.doesNotMatch(adminScript, /MODEL_PROVIDER_(LABELS|IDS)/);
  assert.match(adminScript, /const renderModelProviderFilters = \(\) => \{/);
  assert.match(adminScript, /modelsProviderFilters\.addEventListener\("click"/);
  assert.match(adminScript, /providerLabelFor\(provider\.id\)/);

  assert.match(adminScript, /checkbox\.type = "checkbox"/);
  assert.match(adminScript, /dataset\.modelToggle/);
  assert.match(adminScript, /fetch\(apiUrl\("\/admin\/models\/catalog"\), \{/);
  assert.match(adminScript, /fetch\(apiUrl\("\/admin\/models\/whitelist"\), \{/);
  assert.match(adminScript, /if \(modelsHasUnsavedChanges\(\) && options\.force !== true\)/);

  // Bulk tools have to say whether they act on the whole catalog or the filtered view.
  assert.match(
    adminScript,
    /modelsCheckAllBtn\.textContent = scoped[\s\S]{0,80}`Check \$\{formatNumber\(visibleCount\)\} shown`[\s\S]{0,60}`Check all \$\{formatNumber\(visibleCount\)\}`/
  );
  assert.match(
    adminScript,
    /modelsUncheckAllBtn\.textContent = scoped[\s\S]{0,80}`Uncheck \$\{formatNumber\(visibleCount\)\} shown`[\s\S]{0,60}`Uncheck all \$\{formatNumber\(visibleCount\)\}`/
  );
  // Identifiers the catalog dropped must be removable instead of pinning the filter on.
  assert.match(adminScript, /const modelsMissingIds = \(\) => \{/);
  assert.match(adminScript, /modelsMissingWarning\(\)/);

  // The legacy rule has to stay visible: an empty selection is a cleared filter.
  assert.match(adminHtml, /Saving an empty selection removes the filter/);
  assert.match(adminScript, /No models checked: the filter is off/);

  // A credential-gated provider with no key is absent on purpose, not broken.
  assert.match(adminScript, /source\.configured !== false/);
  assert.match(modelsScript, /source\?\.configured !== false/);
  assert.match(modelsScript, /deepseek: "DeepSeek"/);
  assert.match(modelsScript, /cerebras: "Cerebras"/);
});

test("a target switch fences a whitelist save that is still in flight", async () => {
  const saveSource = /(const saveModelsWhitelist = async \(\) => \{[\s\S]*?\n\};)\n\nconst discardModelsChanges/.exec(adminScript)?.[1] ?? "";
  const invalidateSource = /const invalidateAdminModels = \(message\) => \{[\s\S]*?\n\};/.exec(adminScript)?.[0] ?? "";
  assert.notEqual(saveSource, "", "the whitelist save callback must stay discoverable");
  assert.notEqual(invalidateSource, "", "the model invalidation callback must stay discoverable");

  const deferred = Promise.withResolvers<Response>();
  const context = {
    fetch: () => deferred.promise,
    apiUrl: (path: string) => path,
    getAdminToken: () => "token",
    hasAdminCredential: () => false,
    setModelsWhitelistBadge: () => {},
    renderModelsMessage: () => {},
    updateModelsStatus: () => {},
    modelsHasUnsavedChanges: () => true,
    modelsSelectedIds: () => ["old-model"],
    modelsSelectionFromIds: (ids: unknown) =>
      new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id) : []),
    renderModelsPicker: () => {},
    formatNumber: String,
    toast: { error: () => {}, success: () => {} },
    console,
  };
  runInNewContext(
    [
      "let modelsLoadId = 0;",
      "let modelsSaving = false;",
      'let modelsSaveError = "";',
      "let modelsCatalog = [];",
      "let modelsCatalogSources = {};",
      'let modelsSelection = new Set(["old-model"]);',
      'let modelsSavedSelection = new Set(["old-model"]);',
      "let modelsVisibleIds = new Set();",
      "let modelsLoadedAt = 1;",
      invalidateSource,
      saveSource,
      "globalThis.startSave = () => saveModelsWhitelist();",
      "globalThis.switchTarget = () => invalidateAdminModels(\"Target changed\");",
      'globalThis.readState = () => ({ saved: [...modelsSavedSelection], selection: [...modelsSelection], saving: modelsSaving });',
    ].join("\n"),
    context
  );
  const harness = context as typeof context & {
    startSave: () => Promise<void>;
    switchTarget: () => void;
    readState: () => { saved: string[]; selection: string[]; saving: boolean };
  };

  const save = harness.startSave();
  harness.switchTarget();
  deferred.resolve(Response.json({ model_ids: ["foreign-model"] }));
  await save;
  assert.deepEqual(harness.readState(), { saved: [], selection: [], saving: false });
});

test("provider roster completion rerenders Models after normalizing its filter", () => {
  const completion = /const loadProviderSelection = async \(options = \{\}\) => \{([\s\S]*?)\n\};\n\nconst saveProviderSelection/.exec(adminScript)?.[1] ?? "";
  assert.notEqual(completion, "", "the provider-selection loader must stay discoverable");
  const filterReset = completion.indexOf('modelsProviderFilter = "all";');
  const modelsRender = completion.indexOf("renderModelsPicker();");
  assert.ok(filterReset >= 0, "roster completion must normalize a stale model provider filter");
  assert.ok(modelsRender > filterReset, "the Models picker must rerender after the filter reset");
});

test("the Providers tab renders a provider picker next to the Analytics tab", () => {
  assert.match(adminHtml, /id="providers-selection-list" data-provider-picker/);
  assert.match(adminHtml, /id="view-analytics"[\s\S]*?id="provider-capacity-chart"/, "the analytics view keeps the capacity chart");
  assert.match(adminHtml, /id="view-providers"[\s\S]*?id="providers-selection-list"/, "the providers view owns the picker");
  assert.match(adminHtml, /id="view-tab-analytics"/);
  assert.match(adminScript, /analytics: viewTabAnalytics/);
  assert.match(adminScript, /analytics: viewAnalytics/);

  for (const id of [
    "providers-selection-drop-missing",
    "providers-selection-search",
    "providers-selection-sort",
    "providers-selection-only-active",
    "providers-selection-check-all",
    "providers-selection-uncheck-all",
    "providers-selection-invert",
    "providers-selection-discard",
    "providers-selection-reload",
    "providers-selection-save",
    "providers-selection-badge",
    "providers-selection-summary",
    "providers-selection-warning",
  ]) {
    assert.match(adminHtml, new RegExp(`id="${id}"`), `${id} must be rendered`);
    assert.match(adminScript, new RegExp(`mustGet\\("${id}"\\)`), `${id} must be wired`);
  }
  // Tier chips and provider rows come from the payload: the panel adds no tier
  // or provider of its own, and health is read through the row's health key.
  assert.match(adminHtml, /<div data-provider-filters role="group" aria-label="Filter by tier"><\/div>/);
  assert.doesNotMatch(adminHtml, /data-provider-tier=/);
  assert.doesNotMatch(adminScript, /PROVIDER_(ROSTER|TIER_IDS|TIER_LABELS|HEALTH_KEYS|ALL_IDS)/);
  assert.match(adminScript, /const renderProviderTierFilters = \(\) => \{/);
  assert.match(adminScript, /providersTierFilters\.addEventListener\("click"/);
  assert.match(adminScript, /providerHealthFor\(entry\)/);

  assert.match(adminScript, /fetch\(apiUrl\("\/admin\/providers\/selection"\), \{/);
  assert.match(adminScript, /method: "POST"/);
  assert.match(adminScript, /dataset\.providerToggle/);
  assert.match(adminScript, /if \(providersHasUnsavedChanges\(\) && options\.force !== true\)/);

  // The routing contract the panel has to explain: nothing checked is a removed
  // filter, not a gateway with every provider switched off.
  assert.match(adminHtml, /Saving an empty selection removes the filter/);
  assert.match(adminScript, /providersSelectionSave\.disabled = saving \|\| !unsaved \|\| providersSelectionIsEmpty\(\)/);
  assert.match(adminScript, /providersEmptyWarning/);
  // The waterfall order is fixed, so the picker must never claim to reorder it.
  assert.match(adminHtml, /The waterfall order itself never changes/);
});

test("each Codex subscription is selectable under the Codex provider", () => {
  assert.match(adminHtml, /Each configured Codex subscription is selectable on its own/);
  assert.match(adminScript, /list\.dataset\.providerSubscriptions = ""/);
  assert.match(adminScript, /dataset\.providerSubscriptionToggle = subscription\.id/);
  assert.match(adminScript, /dataset\.providerSubscriptionMeta/);

  // The umbrella and the individual subscription ids must never coexist, or the
  // saved selection would be ambiguous about whether it means one account or all.
  assert.match(adminScript, /const setSubscriptionChecked = \(subscriptionId, checked\) => \{/);
  assert.match(adminScript, /providerSelection\.delete\("codex"\)/);
  assert.match(adminScript, /providerSelection\.add\("codex"\)/);
  assert.match(adminScript, /checkbox\.indeterminate = partial/);
  assert.match(adminScript, /providersMissingSelectionIds/);
  assert.match(adminScript, /fetch\(apiUrl\("\/admin\/providers\/selection"\), \{/);
  assert.match(adminScript, /subscriptions\.every\(\(subscription\) => providerSelection\.has\(subscription\.id\)\)/);
});

test("admin metadata refresh forces every upstream and reports what is cached", async () => {
  const calls: string[] = [];
  const enrichment: OpenRouterModelsSnapshot = {
    models: [
      { id: "openai/gpt-5.6-sol", context_window_tokens: 1_050_000, max_context_window_tokens: 1_050_000, reasoning: null },
      { id: "z-ai/glm-5.3", context_window_tokens: 1_310_720, max_context_window_tokens: 1_310_720, reasoning: null },
    ],
    updated_at_ms: 1_789_000_000_000,
  };
  const response = await handleAdminModelsRefresh({
    refreshClaude: (options) => {
      calls.push(`claude:${options?.force === true ? "force" : "plain"}`);
      return Promise.resolve({ models: [{ id: "claude-observed", created: 0 }], updated_at_ms: 3 });
    },
    refreshEnrichment: () => {
      calls.push("openrouter");
      return Promise.resolve(enrichment);
    },
    refreshOpenlux: (options) => {
      calls.push(`openlux:${options?.force === true ? "force" : "plain"}`);
      return Promise.resolve({
        models: [{ id: "gpt-5.6-sol", object: "model", created: 0, owned_by: "openlux", supported_endpoint_types: ["openai-response"] }],
        updated_at_ms: 1,
      });
    },
    refreshSurplus: (options) => {
      calls.push(`surplus:${options?.force === true ? "force" : "plain"}`);
      return Promise.resolve({
        models: [
          { id: "gpt-5.6-sol", object: "model", created: 0, owned_by: "OpenAI", supported_endpoint_types: ["openai-response"] },
          { id: "hy3", object: "model", created: 0, owned_by: "Tencent", supported_endpoint_types: ["openai-response"] },
        ],
        updated_at_ms: 2,
      });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(
    [...calls].sort((left, right) => left.localeCompare(right)),
    ["claude:force", "openlux:force", "openrouter", "surplus:force"],
    "every upstream is force-refreshed"
  );
  assert.deepEqual(body.data, {
    openrouter: { upstream_models: 2, updated_at_ms: 1_789_000_000_000, refreshed: true },
    openlux: { models: 1, updated_at_ms: 1 },
    surplus: { models: 2, updated_at_ms: 2 },
    claude_code: { models: 1, updated_at_ms: 3, status: "available", stale: false },
  });
});

test("admin metadata refresh is registered as an operator POST route", () => {
  assert.match(handlerSource, /\{ methods: \["POST"\], path: "\/admin\/models\/refresh", run: \(\) => handleAdminModelsRefresh\(\) \}/);
});
