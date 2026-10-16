import type { AtomicCheck, Kv, KvCommitError, KvCommitResult, KvEntryMaybe, KvKey } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";

import { handleAdminProviderSelectionGet, handleAdminProviderSelectionSet } from "../src/admin/index.ts";
import { CODEX_AUTH_POOL_KV_KEY, CODEX_MODELS_KV_KEY, type CodexModelsSnapshot, resetCodexAuthCacheForTest } from "../src/codex/index.ts";
import { DEEPSEEK_OFFICIAL_MODEL_IDS } from "../src/deepseek/index.ts";
import { DEEPSEEK_WATERFALL_MODEL_ID, deepSeekWaterfallCatalogEnabled } from "../src/deepseek/waterfall.ts";
import { handleHealthProviders } from "../src/health.ts";
import { LITHOS_MODEL_IDS } from "../src/provider/lithos.ts";
import { readOpenRouterApiKey } from "../src/provider/openrouter.ts";
import { CODEX_MODELS_WHITELIST_KV_KEY } from "../src/models/codex-models-whitelist.ts";
import { resetOpenRouterModelsCacheForTest, setOpenRouterModelsFetchForTest } from "../src/models/openrouter-models.ts";
import handler from "../src/handler/index.ts";
import { setKvForTest } from "../src/kv.ts";
import { buildModelCatalogSnapshot, handleModels } from "../src/models/catalog.ts";
import { RECORD_PROVIDER_IDS } from "../src/provider/health.ts";
import {
  GATEWAY_PROVIDER_ID,
  GATEWAY_PROVIDER_PRESENTATION,
  PROVIDER_PRESENTATION,
  PROVIDER_TIERS,
  providerPresentation,
} from "../src/provider/presentation.ts";
import {
  codexAccountEligibility,
  codexSubscriptionHash,
  codexSubscriptionSelectionId,
  filterCatalogEntriesByProviderSelection,
  isCodexSubscriptionEnabled,
  isProviderEnabled,
  isProviderSelectionId,
  loadProviderSelection,
  loadProviderSelectionCached,
  normalizeProviderSelection,
  normalizeSelectedProviderIds,
  PROVIDER_SELECTION_CACHE_TTL_MS,
  PROVIDER_SELECTION_KV_KEY,
  providerSelectionIsActive,
  resetProviderSelectionCacheForTest,
  SELECTABLE_PROVIDER_IDS,
  storeProviderSelection,
  type SelectableProviderId,
} from "../src/provider/selection.ts";
import { resetRuntimeConfigCacheForTest, RUNTIME_CONFIG_V2_KEY } from "../src/runtime-config.ts";

// The model-listing path reads discovery credentials from the environment.
// Clearing them keeps these tests on the credential-gated providers they own,
// and keeps discovery from reaching a network the test task does not allow.
delete process.env.METERED_API_KEY;
delete process.env.SURPLUS_API_KEY;

const keyOf = (key: KvKey): string => JSON.stringify(key);

/** Versioned KV stand-in for selection and account-discovery bootstrap. */
class SelectionKv {
  readonly values = new Map<string, unknown>();
  private readonly _versions = new Map<string, string>();
  private _revision = 1;
  failReads = false;

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
    if (this.failReads) return Promise.reject(new Error("KV read failed"));
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

  storedSelection(): unknown {
    return this.values.get(keyOf([...PROVIDER_SELECTION_KV_KEY]));
  }

  seedSelection(providerIds: readonly string[], updatedAtMs = 1_700_000_000_000): void {
    this.values.set(keyOf([...PROVIDER_SELECTION_KV_KEY]), { provider_ids: [...providerIds], updated_at_ms: updatedAtMs });
  }
}

class DeferredSelectionKv extends SelectionKv {
  readonly readStarted = Promise.withResolvers<void>();
  readonly releaseRead = Promise.withResolvers<void>();

  override async get<T>(key: KvKey, options?: { consistency?: "strong" | "eventual" }): Promise<KvEntryMaybe<T>> {
    const entry = await super.get<T>(key, options);
    this.readStarted.resolve();
    await this.releaseRead.promise;
    return entry;
  }
}

const withKv = async (kv: SelectionKv | null, run: () => Promise<void>): Promise<void> => {
  resetProviderSelectionCacheForTest();
  setKvForTest(kv as unknown as Kv | null);
  try {
    await run();
  } finally {
    setKvForTest(null);
    resetProviderSelectionCacheForTest();
  }
};

const codexSnapshot = (modelIds: readonly string[]): CodexModelsSnapshot =>
  ({
    source: "codex_cli",
    client_version: "0.126.0",
    updated_at_ms: 1_700_000_000_000,
    models: modelIds.map((id) => ({ slug: id, supported_reasoning_levels: ["none", "low"] })),
  }) as unknown as CodexModelsSnapshot;

const seedCodexSnapshot = (kv: SelectionKv, modelIds: readonly string[]): void => {
  const snapshot = codexSnapshot(modelIds);
  kv.values.set(keyOf([...CODEX_MODELS_KV_KEY]), snapshot);
  kv.values.set(keyOf([...RUNTIME_CONFIG_V2_KEY]), {
    version: 2,
    default_model: modelIds[0] ?? "gpt-5-fixture",
    default_reasoning_effort: "low",
    codex_models: snapshot,
    updated_at_ms: 1_700_000_000_000,
  });
  resetRuntimeConfigCacheForTest();
};

const listModelIds = async (): Promise<string[]> => {
  const response = await handleModels();
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { data?: { id?: string }[] };
  return (payload.data ?? []).map((model) => model.id ?? "");
};

// ── Module contract ──────────────────────────────────────────────────────────

test("provider selection normalizes to the roster order without duplicates", () => {
  assert.deepEqual(normalizeSelectedProviderIds(["openlux", "codex", "openlux"]), ["codex", "openlux"]);
  assert.deepEqual(normalizeSelectedProviderIds([" codex "]), ["codex"]);
  assert.deepEqual(normalizeSelectedProviderIds(["unknown", "surplus"]), ["surplus"]);
  assert.deepEqual(normalizeSelectedProviderIds([1, null, {}]), []);
});

test("a stored provider selection keeps its known ids and drops retired ones", () => {
  assert.deepEqual(normalizeProviderSelection({ provider_ids: ["surplus", "retired"], updated_at_ms: 5 }), {
    provider_ids: ["surplus"],
    updated_at_ms: 5,
  });
  assert.equal(normalizeProviderSelection({ provider_ids: "codex", updated_at_ms: 5 }), null);
  assert.equal(normalizeProviderSelection({ provider_ids: [7], updated_at_ms: 5 }), null);
  assert.equal(normalizeProviderSelection({ provider_ids: [], updated_at_ms: 0 }), null);
  assert.equal(normalizeProviderSelection(null), null);
});

test("an empty or absent selection keeps every provider eligible", () => {
  for (const provider of SELECTABLE_PROVIDER_IDS) {
    assert.equal(isProviderEnabled(provider, null), true, `${provider}: absent selection is no filter`);
    assert.equal(isProviderEnabled(provider, { provider_ids: [], updated_at_ms: 1 }), true, `${provider}: empty selection is no filter`);
  }
  const narrowed = { provider_ids: ["surplus"] as SelectableProviderId[], updated_at_ms: 1 };
  assert.equal(isProviderEnabled("surplus", narrowed), true);
  assert.equal(isProviderEnabled("codex", narrowed), false);
  assert.equal(providerSelectionIsActive(narrowed), true);
  assert.equal(providerSelectionIsActive(null), false);
  assert.equal(providerSelectionIsActive({ provider_ids: [], updated_at_ms: 1 }), false);
});

test("a subscription selection narrows the Codex tier instead of switching it off", async () => {
  const first = codexSubscriptionSelectionId(await codexSubscriptionHash("account-one"));
  const second = codexSubscriptionSelectionId(await codexSubscriptionHash("account-two"));
  assert.notEqual(first, second);
  assert.equal(first, `codex:${await codexSubscriptionHash("account-one")}`, "the hash memoizes to one stable id");
  assert.equal(isProviderSelectionId(first), true);
  assert.equal(isProviderSelectionId("codex:not-a-hash"), false);
  assert.equal(isProviderSelectionId("codex:"), false);

  const onlySecond = { provider_ids: [second], updated_at_ms: 1 } as const;
  assert.equal(isProviderEnabled("codex", onlySecond), true, "one selected subscription is an enabled Codex tier");
  assert.equal(isProviderEnabled("surplus", onlySecond), false);
  assert.deepEqual(codexAccountEligibility(onlySecond), { kind: "only", hashes: [await codexSubscriptionHash("account-two")] });
  assert.equal(isCodexSubscriptionEnabled(await codexSubscriptionHash("account-two"), onlySecond), true);
  assert.equal(isCodexSubscriptionEnabled(await codexSubscriptionHash("account-one"), onlySecond), false);

  assert.deepEqual(codexAccountEligibility(null), { kind: "all" }, "no selection restricts nothing");
  assert.deepEqual(codexAccountEligibility({ provider_ids: [], updated_at_ms: 1 }), { kind: "all" });
  assert.deepEqual(codexAccountEligibility({ provider_ids: ["codex"], updated_at_ms: 1 }), { kind: "all" }, "the umbrella means every subscription");
  assert.deepEqual(codexAccountEligibility({ provider_ids: ["surplus"], updated_at_ms: 1 }), { kind: "none" }, "no Codex id at all switches the tier off");
  assert.equal(isProviderEnabled("codex", { provider_ids: ["surplus"], updated_at_ms: 1 }), false);
});

test("the codex umbrella absorbs subscription ids so storage stays unambiguous", () => {
  const subscription = codexSubscriptionSelectionId("a".repeat(64));
  const other = codexSubscriptionSelectionId("b".repeat(64));
  assert.deepEqual(normalizeSelectedProviderIds([other, "codex", subscription]), ["codex"]);
  assert.deepEqual(normalizeSelectedProviderIds([other, "surplus", subscription]), ["surplus", subscription, other]);
  assert.deepEqual(normalizeSelectedProviderIds(["codex:not-a-hash", "codex"]), ["codex"]);
  assert.deepEqual(normalizeSelectedProviderIds(["codex:not-a-hash"]), []);
  assert.deepEqual(normalizeProviderSelection({ provider_ids: [subscription, "codex"], updated_at_ms: 5 }), {
    provider_ids: ["codex"],
    updated_at_ms: 5,
  });
});

test("a catalog row keeps only the providers that are still active", () => {
  const entries = [
    { id: "codex-only", providers: [{ id: "codex" }] },
    { id: "shared", providers: [{ id: "codex" }, { id: "surplus" }] },
    { id: "openlux-only", providers: [{ id: "openlux" }] },
  ];
  assert.deepEqual(filterCatalogEntriesByProviderSelection(entries, null), entries, "no selection filters nothing");
  assert.deepEqual(
    filterCatalogEntriesByProviderSelection(entries, { provider_ids: ["surplus"], updated_at_ms: 1 }),
    [{ id: "shared", providers: [{ id: "surplus" }] }],
    "a switched-off provider is dropped from every row, and a row with no enabled provider disappears"
  );
  const subscriptionOnly = { provider_ids: [codexSubscriptionSelectionId("c".repeat(64))], updated_at_ms: 1 } as const;
  assert.deepEqual(
    filterCatalogEntriesByProviderSelection(entries, subscriptionOnly),
    [
      { id: "codex-only", providers: [{ id: "codex" }] },
      { id: "shared", providers: [{ id: "codex" }] },
    ],
    "a narrowed Codex tier still advertises every model Codex serves"
  );
});

test("the routing selection read is cached, primed by a save, and fails open", async () => {
  const kv = new SelectionKv();
  await withKv(kv, async () => {
    assert.equal(await loadProviderSelection(kv as unknown as Kv), null, "an absent selection reads as no filter");

    const stored = await storeProviderSelection(kv as unknown as Kv, ["openlux"]);
    assert.ok(stored, "a save must persist a selection");
    assert.deepEqual(stored.provider_ids, ["openlux"]);
    assert.deepEqual(kv.storedSelection(), { provider_ids: ["openlux"], updated_at_ms: stored.updated_at_ms });
    assert.deepEqual(await loadProviderSelectionCached(), { provider_ids: ["openlux"], updated_at_ms: stored.updated_at_ms }, "a save primes the cache");

    // A later external write stays invisible until the cache expires, and a
    // failed read keeps serving the last known value instead of erroring.
    kv.seedSelection([]);
    assert.deepEqual((await loadProviderSelectionCached())?.provider_ids, ["openlux"]);
    assert.deepEqual((await loadProviderSelectionCached(Date.now() + PROVIDER_SELECTION_CACHE_TTL_MS + 1))?.provider_ids, []);
    kv.failReads = true;
    assert.deepEqual((await loadProviderSelectionCached(Date.now() + 2 * PROVIDER_SELECTION_CACHE_TTL_MS))?.provider_ids, []);
  });

  const unavailable = new SelectionKv();
  unavailable.failReads = true;
  await withKv(unavailable, async () => {
    assert.equal(await loadProviderSelectionCached(), null, "with nothing cached a failed read is no filter, not an error");
  });
});

test("an in-flight selection read cannot replace a cache primed by an admin save", async () => {
  const kv = new DeferredSelectionKv();
  kv.seedSelection(["openlux"]);
  await withKv(kv, async () => {
    const inFlightRead = loadProviderSelectionCached();
    await kv.readStarted.promise;

    const saved = await handleAdminProviderSelectionSet(
      new Request("https://ai.ubq.fi/admin/providers/selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_ids: ["cerebras"] }),
      })
    );
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as { provider_ids: string[]; updated_at_ms: number };
    assert.deepEqual(savedBody.provider_ids, ["cerebras"]);
    assert.deepEqual(await loadProviderSelectionCached(), {
      provider_ids: ["cerebras"],
      updated_at_ms: savedBody.updated_at_ms,
    });

    kv.releaseRead.resolve();
    assert.deepEqual(await inFlightRead, { provider_ids: ["openlux"], updated_at_ms: 1_700_000_000_000 });
    assert.deepEqual(await loadProviderSelectionCached(), {
      provider_ids: ["cerebras"],
      updated_at_ms: savedBody.updated_at_ms,
    });
  });
});

// ── Admin API ────────────────────────────────────────────────────────────────

const catalogFixture = () => ({
  models: [
    { id: "gpt-5.6-sol", providers: [{ id: "codex" as const, owned_by: "openai", supported_endpoints: ["/v1/responses"] }] },
    { id: "gpt-5.6-sol", providers: [{ id: "surplus" as const, owned_by: "moonshot", supported_endpoints: ["/v1/responses"] }] },
    { id: "kimi-k2", providers: [{ id: "surplus" as const, owned_by: "moonshot", supported_endpoints: ["/v1/chat/completions"] }] },
    { id: "deepseek-flash", providers: [{ id: "deepseek" as const, owned_by: "deepseek", supported_endpoints: ["/v1/chat/completions", "/v1/responses"] }] },
  ],
  sources: {
    claude_code: { status: "unavailable" as const, count: 0, updated_at_ms: null, configured: false },
    codex: { status: "available" as const, count: 1, updated_at_ms: 1 },
    openlux: { status: "unavailable" as const, count: 0, updated_at_ms: null },
    surplus: { status: "available" as const, count: 2, updated_at_ms: 2 },
    deepseek: { status: "available" as const, count: 1, updated_at_ms: null, configured: true },
    cerebras: { status: "unavailable" as const, count: 0, updated_at_ms: null, configured: false },
    // The catalog source id union gained the LithosAI provider; this fixture is
    // typed as a whole snapshot, so it must name every source id.
    lithos: { status: "unavailable" as const, count: 0, updated_at_ms: null, configured: false },
    openrouter: { status: "available" as const, count: 2, updated_at_ms: 3 },
  },
});

test("admin provider picker reports the roster, catalog counts, and the saved selection", async () => {
  const kv = new SelectionKv();
  kv.seedSelection(["surplus"]);
  await withKv(kv, async () => {
    const response = await handleAdminProviderSelectionGet({ buildCatalog: () => Promise.resolve(catalogFixture()) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    const rows = [
      { id: "codex", model_count: 1, status: "available", configured: true, subscriptions: [] },
      { id: "claude_code", model_count: 0, status: "unavailable", configured: false },
      { id: "surplus", model_count: 2, status: "available", configured: true },
      { id: "openlux", model_count: 0, status: "unavailable", configured: false },
      { id: "deepseek", model_count: 1, status: "available", configured: true },
      { id: "cerebras", model_count: 0, status: "unavailable", configured: false },
      { id: "lithos", model_count: 0, status: "unavailable", configured: false },
      {
        id: "openrouter",
        model_count: 0,
        status: readOpenRouterApiKey() !== null ? "available" : "unavailable",
        configured: readOpenRouterApiKey() !== null,
      },
      {
        id: GATEWAY_PROVIDER_ID,
        // The injected fixture carries no ubiquity-provider row, so it counts 0.
        model_count: 0,
        status: deepSeekWaterfallCatalogEnabled(null) ? "available" : "unavailable",
        configured: deepSeekWaterfallCatalogEnabled(null),
      },
    ];
    assert.deepEqual(
      body.data.providers,
      rows.map((row) => {
        const presentation = row.id === GATEWAY_PROVIDER_ID ? GATEWAY_PROVIDER_PRESENTATION : providerPresentation(row.id);
        return {
          ...presentation,
          tier_label: PROVIDER_TIERS.find((tier) => tier.id === presentation.tier)?.label,
          ...row,
        };
      }),
      "the roster is fixed and every provider carries its catalog entry count and its presentation"
    );
    assert.deepEqual(
      body.data.tiers,
      PROVIDER_TIERS.map((tier) => ({ id: tier.id, label: tier.label })),
      "the tier filter arrives in waterfall order"
    );
    assert.deepEqual(body.data.selection.provider_ids, ["surplus"]);
    assert.equal(body.data.filter_active, true);
  });
});

test("every selectable provider carries a complete presentation and a health key the view reports", async () => {
  const previousDeepSeekKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "fixture-deepseek-key";
  try {
    await withKv(new SelectionKv(), async () => {
      const catalog = await buildModelCatalogSnapshot();
      const response = await handleAdminProviderSelectionGet({ buildCatalog: () => Promise.resolve(catalog) });
      const body = (await response.json()) as {
        data: {
          providers: {
            id: string;
            label?: string;
            tier?: string;
            tier_label?: string;
            detail?: string;
            endpoints?: string[];
            health_key?: string;
            selectable?: boolean;
          }[];
          tiers: { id: string; label: string }[];
        };
      };
      assert.deepEqual(
        body.data.providers.map((provider) => provider.id),
        [...SELECTABLE_PROVIDER_IDS],
        "the roster keeps the waterfall order, with the gateway identity last"
      );
      const gateway = body.data.providers.find((provider) => provider.id === GATEWAY_PROVIDER_ID);
      assert.ok(gateway, "the gateway identity must be on the roster");
      assert.notEqual(gateway.selectable, false, "the gateway identity is selectable like every provider");
      assert.deepEqual(
        body.data.tiers.map((tier) => tier.id),
        PROVIDER_TIERS.map((tier) => tier.id),
        "the tier filter is ordered"
      );

      // `/health/providers` is the provider-health view the panel reads, and it
      // publishes exactly one key per provider it can report.
      const healthKeys = new Set(Object.keys(await (await handleHealthProviders()).json()));
      for (const provider of body.data.providers) {
        const presentation = provider.id === GATEWAY_PROVIDER_ID ? GATEWAY_PROVIDER_PRESENTATION : PROVIDER_PRESENTATION[provider.id as SelectableProviderId];
        assert.ok(presentation, `${provider.id} must have a presentation entry`);
        assert.equal(provider.label, presentation.label, `${provider.id} label`);
        assert.equal(provider.tier, presentation.tier, `${provider.id} tier`);
        assert.equal(provider.tier_label, PROVIDER_TIERS.find((tier) => tier.id === presentation.tier)?.label, `${provider.id} tier label`);
        assert.equal(provider.detail, presentation.detail, `${provider.id} detail`);
        assert.ok(typeof provider.detail === "string" && provider.detail.length > 0, `${provider.id} detail must be copy`);
        assert.deepEqual(provider.endpoints, [...presentation.endpoints], `${provider.id} endpoints`);
        assert.equal(provider.health_key, presentation.health_key, `${provider.id} health key`);
        assert.equal(healthKeys.has(presentation.health_key), true, `${presentation.health_key} must be a published health key`);
        assert.equal(RECORD_PROVIDER_IDS.includes(presentation.health_key), true, `${presentation.health_key} must be reportable provider health`);
      }

      const deepseek = body.data.providers.find((provider) => provider.id === "deepseek");
      assert.ok(deepseek, "the roster must list deepseek");
      assert.deepEqual(deepseek.endpoints, ["/v1/chat/completions", "/v1/responses"]);
      assert.match(deepseek.detail ?? "", /Chat Completions upstream and Responses through the gateway's translation/);
      for (const id of DEEPSEEK_OFFICIAL_MODEL_IDS) {
        const provider = catalog.models.find((model) => model.id === id)?.providers.find((candidate) => candidate.id === "deepseek");
        assert.ok(provider, `${id} must have a DeepSeek catalog provider`);
        assert.deepEqual(deepseek.endpoints, provider.supported_endpoints, `${id} catalog and roster endpoints must agree`);
      }

      const lithos = body.data.providers.find((provider) => provider.id === "lithos");
      assert.ok(lithos, "the roster must list lithos");
      assert.equal(lithos.label, "LithosAI");
      assert.equal(lithos.health_key, "lithos");

      // A roster id with no copy yet still renders completely instead of dropping out.
      const fallback = providerPresentation("future-provider");
      assert.equal(fallback.label, "future-provider");
      assert.equal(fallback.tier, "direct");
      assert.match(fallback.detail, /no presentation entry yet/);
      assert.deepEqual([...fallback.endpoints], []);
      assert.equal(fallback.health_key, "future-provider");
    });
  } finally {
    if (previousDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeekKey;
  }
});

const stripBase64Padding = (base64: string): string => {
  let end = base64.length;
  while (end > 0 && base64[end - 1] === "=") end -= 1;
  return base64.slice(0, end);
};

const tokenWithPayload = (payload: unknown): string =>
  `${stripBase64Padding(btoa(JSON.stringify({ alg: "none" })))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}.${stripBase64Padding(btoa(JSON.stringify(payload)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}.signature`;

/** Two configured subscriptions: one with a profile email, one without. */
const seedCodexAuthPool = (kv: SelectionKv): void => {
  kv.values.set(keyOf([...CODEX_AUTH_POOL_KV_KEY]), {
    accounts: [
      {
        access_token: tokenWithPayload({ "https://api.openai.com/profile": { email: "first@example.com" } }),
        refresh_token: "refresh-one",
        account_id: "account-one",
        updated_at_ms: 1,
      },
      { access_token: "not-a-jwt", refresh_token: "refresh-two", account_id: "account-two", updated_at_ms: 1 },
    ],
    updated_at_ms: 1,
  });
  resetCodexAuthCacheForTest();
};

test("admin provider picker lists each configured Codex subscription under its opaque id", async () => {
  const kv = new SelectionKv();
  seedCodexAuthPool(kv);
  try {
    await withKv(kv, async () => {
      const response = await handleAdminProviderSelectionGet({ buildCatalog: () => Promise.resolve(catalogFixture()) });
      const body = await response.json();
      const codex = body.data.providers.find((provider: { id: string }) => provider.id === "codex");
      assert.deepEqual(codex.subscriptions, [
        { id: codexSubscriptionSelectionId(await codexSubscriptionHash("account-one")), label: "first@example.com", slot: 1 },
        { id: codexSubscriptionSelectionId(await codexSubscriptionHash("account-two")), label: "Codex account 2", slot: 2 },
      ]);
      assert.equal(
        body.data.providers.some((provider: { id: string; subscriptions?: unknown }) => provider.subscriptions !== undefined && provider.id !== "codex"),
        false,
        "only the Codex tier carries subscriptions"
      );
      for (const provider of body.data.providers) {
        assert.equal(JSON.stringify(provider).includes("account-one"), false, "a raw account id never crosses the response boundary");
      }

      // One subscription round-trips through the write path as an active Codex tier.
      const saved = await handleAdminProviderSelectionSet(
        new Request("https://ai.ubq.fi/admin/providers/selection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider_ids: [codex.subscriptions[1].id, "surplus"] }),
        })
      );
      assert.equal(saved.status, 200);
      assert.deepEqual((await saved.json()).provider_ids, ["surplus", codex.subscriptions[1].id]);
      const reloaded = await handleAdminProviderSelectionGet({ buildCatalog: () => Promise.resolve(catalogFixture()) });
      assert.equal((await reloaded.json()).data.filter_active, true);
    });
  } finally {
    resetCodexAuthCacheForTest();
  }
});

test("an empty saved provider selection is reported as no filter", async () => {
  await withKv(new SelectionKv(), async () => {
    const response = await handleAdminProviderSelectionGet({ buildCatalog: () => Promise.resolve(catalogFixture()) });
    const body = await response.json();
    assert.deepEqual(body.data.selection, { provider_ids: [], updated_at_ms: 0 });
    assert.equal(body.data.filter_active, false);
  });
});

test("the provider picker refuses to render without KV", async () => {
  await withKv(null, async () => {
    const response = await handleAdminProviderSelectionGet({
      buildCatalog: () => Promise.reject(new Error("the catalog must not be built without KV")),
    });
    assert.equal(response.status, 500);
  });
});

test("saving a provider selection canonicalizes it and rejects unknown ids", async () => {
  const kv = new SelectionKv();
  await withKv(kv, async () => {
    const response = await handleAdminProviderSelectionSet(
      new Request("https://ai.ubq.fi/admin/providers/selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_ids: ["cerebras", "codex", "cerebras"] }),
      })
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.provider_ids, ["codex", "cerebras"], "storage and the wire response share the roster order");
    assert.equal(body.stored, true);
    assert.deepEqual(kv.storedSelection(), { provider_ids: ["codex", "cerebras"], updated_at_ms: body.updated_at_ms });

    for (const payload of [{ provider_ids: ["codex", "nope"] }, { provider_ids: [42] }, { provider_ids: "codex" }, {}]) {
      const invalid = await handleAdminProviderSelectionSet(
        new Request("https://ai.ubq.fi/admin/providers/selection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      );
      assert.equal(invalid.status, 400, `${JSON.stringify(payload)} must be rejected`);
    }
    assert.deepEqual(kv.storedSelection(), { provider_ids: ["codex", "cerebras"], updated_at_ms: body.updated_at_ms }, "a rejected write stores nothing");

    const empty = await handleAdminProviderSelectionSet(
      new Request("https://ai.ubq.fi/admin/providers/selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_ids: [] }),
      })
    );
    assert.equal(empty.status, 200);
    assert.deepEqual(kv.storedSelection(), { provider_ids: [], updated_at_ms: (await empty.json()).updated_at_ms }, "an empty list clears the filter");
  });
});

test("the provider picker routes are registered and stay behind admin auth", async () => {
  const unauthenticated = await handler(new Request("https://ai.ubq.fi/admin/providers/selection"));
  assert.equal(unauthenticated.status, 401, "an unauthenticated selection read reaches the admin gate instead of 404");
  const unknown = await handler(new Request("https://ai.ubq.fi/admin/providers/selection-unknown"));
  assert.equal(unknown.status, 404);
});

// ── Model listing enforcement ────────────────────────────────────────────────

test("/v1/models hides the models of a switched-off provider", async () => {
  resetOpenRouterModelsCacheForTest();
  setOpenRouterModelsFetchForTest(() => Promise.resolve(Response.json({ data: [] })));
  process.env.DEEPSEEK_API_KEY = "fixture-deepseek-key";
  process.env.CEREBRAS_API_KEY = "fixture-cerebras-key";
  // This test owns every credential-gated provider, so it configures the
  // LithosAI key itself instead of leaving the row set to the ambient
  // environment.
  process.env.LITHOSAI_API_KEY = "fixture-lithos-key";
  // Same ownership for the OpenRouter upstream: this test configures its key
  // rather than inheriting the ambient environment
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "fixture-openrouter-key";
  const kv = new SelectionKv();
  seedCodexSnapshot(kv, ["gpt-5.6-sol"]);
  try {
    await withKv(kv, async () => {
      assert.deepEqual(
        await listModelIds(),
        [
          "gpt-5.6-sol",
          "gpt-oss-120b",
          "qwen-3.8-27b",
          ...DEEPSEEK_OFFICIAL_MODEL_IDS,
          ...LITHOS_MODEL_IDS,
          DEEPSEEK_WATERFALL_MODEL_ID,
          "typesafe/jev-latest",
        ],
        "no filter lists every provider"
      );

      kv.seedSelection(["deepseek", "cerebras"]);
      resetProviderSelectionCacheForTest();
      assert.deepEqual(
        await listModelIds(),
        ["gpt-oss-120b", "qwen-3.8-27b", ...DEEPSEEK_OFFICIAL_MODEL_IDS],
        "a switched-off Codex provider contributes no rows, and the unchecked gateway identity takes its route off"
      );

      kv.seedSelection(["deepseek", "cerebras", "ubiquity"]);
      resetProviderSelectionCacheForTest();
      assert.deepEqual(
        await listModelIds(),
        ["gpt-oss-120b", "qwen-3.8-27b", ...DEEPSEEK_OFFICIAL_MODEL_IDS, DEEPSEEK_WATERFALL_MODEL_ID],
        "checking the gateway identity admits its route while the other providers stay narrowed"
      );

      kv.seedSelection(["codex"]);
      resetProviderSelectionCacheForTest();
      assert.deepEqual(await listModelIds(), ["gpt-5.6-sol"], "switched-off credential-gated providers contribute no rows");
    });
  } finally {
    setOpenRouterModelsFetchForTest(null);
    resetOpenRouterModelsCacheForTest();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
    delete process.env.LITHOSAI_API_KEY;
    if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
    resetRuntimeConfigCacheForTest();
  }
});

test("/v1/models still applies the model whitelist on top of the provider selection", async () => {
  const kv = new SelectionKv();
  seedCodexSnapshot(kv, ["gpt-5.6-sol", "gpt-5.6-terra"]);
  kv.values.set(keyOf([...CODEX_MODELS_WHITELIST_KV_KEY]), { model_ids: ["gpt-5.6-terra"], updated_at_ms: 1_700_000_000_000 });
  try {
    await withKv(kv, async () => {
      kv.seedSelection(["codex"]);
      resetProviderSelectionCacheForTest();
      assert.deepEqual(await listModelIds(), ["gpt-5.6-terra"], "the operator whitelist still narrows the surviving rows");
    });
  } finally {
    resetRuntimeConfigCacheForTest();
  }
});

test("the gateway identity joins the selection like any provider", async () => {
  const kv = new SelectionKv();
  await withKv(kv, async () => {
    const response = await handleAdminProviderSelectionSet(
      new Request("https://ai.ubq.fi/admin/providers/selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_ids: ["ubiquity", "openrouter"] }),
      })
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.provider_ids, ["openrouter", "ubiquity"], "storage keeps the roster order");
    assert.deepEqual(kv.storedSelection(), { provider_ids: ["openrouter", "ubiquity"], updated_at_ms: body.updated_at_ms });
  });
});

test("an active selection without the gateway identity switches the waterfall route off", () => {
  const withGateway = { provider_ids: ["ubiquity", "openrouter"] as SelectableProviderId[], updated_at_ms: 1 };
  const withoutGateway = { provider_ids: ["openrouter"] as SelectableProviderId[], updated_at_ms: 1 };
  assert.equal(isProviderEnabled(GATEWAY_PROVIDER_ID, withGateway), true);
  assert.equal(isProviderEnabled(GATEWAY_PROVIDER_ID, withoutGateway), false);
  assert.equal(deepSeekWaterfallCatalogEnabled(withoutGateway), false, "the route leaves when its identity is unchecked");
});

test("the public catalog drops the gateway route while its identity is off", () => {
  const entries = [
    { id: "ubiquity/deepseek-v4.1-flash", providers: [{ id: "ubiquity" }, { id: "openrouter" }] },
    { id: "some-other", providers: [{ id: "openrouter" }] },
  ];
  assert.deepEqual(
    filterCatalogEntriesByProviderSelection(entries, { provider_ids: ["openrouter"], updated_at_ms: 1 }).map((entry) => entry.id),
    ["some-other"],
    "an enabled hop never keeps a switched-off gateway route on the page"
  );
  assert.deepEqual(
    filterCatalogEntriesByProviderSelection(entries, { provider_ids: ["ubiquity"], updated_at_ms: 1 }).map((entry) =>
      entry.providers.map((provider) => provider.id)
    ),
    [["ubiquity"]],
    "with the identity on, the row narrows to the enabled providers like any other entry"
  );
});
