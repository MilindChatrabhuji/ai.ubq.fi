import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import type { Kv, KvEntry, KvEntryMaybe, KvKey } from "#kv";
// Codex-catalog wiring for the OpenRouter upstream: its served catalogue
// contributes rows to the versioned catalog before the operator whitelist, so
// an id the operator enabled keeps the upstream's snapshot metadata while a row
// the operator did not enable stays out of the catalog Codex selects. An empty
// whitelist is no filter at all, so those rows then list on the upstream TTL.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/** URL text of a fetch input (the transports under test always pass a string URL). */
const fetchUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const keyToString = (key: KvKey): string => JSON.stringify(key);
const kvStore = new Map<string, { value: unknown; versionstamp: string }>();
let versionCounter = 0;
const nextVersion = (): string => String(++versionCounter).padStart(20, "0");
const entryFor = (key: KvKey): KvEntryMaybe<unknown> => {
  const stored = kvStore.get(keyToString(key));
  return stored ? { key, value: stored.value, versionstamp: stored.versionstamp } : { key, value: null, versionstamp: null };
};

/** Minimal Deno.Kv stand-in: the catalog paths read, write and checkpoint keys. */
const kvStub = {
  get: (key: KvKey) => Promise.resolve(entryFor(key)),
  set: (key: KvKey, value: unknown) => {
    kvStore.set(keyToString(key), { value, versionstamp: nextVersion() });
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    kvStore.delete(keyToString(key));
    return Promise.resolve();
  },
  list: async function* () {
    // The catalog paths never list KV in this test; the empty iteration keeps
    // the stub's async-iterator shape without inventing entries.
    await Promise.resolve();
    for (const entry of [] as KvEntry<unknown>[]) yield entry;
  },
  atomic: () => {
    const checks: KvEntryMaybe<unknown>[] = [];
    const ops: { key: KvKey; value?: unknown; remove?: boolean }[] = [];
    const chain = {
      check: (entry: KvEntryMaybe<unknown>) => {
        checks.push(entry);
        return chain;
      },
      set: (key: KvKey, value: unknown) => {
        ops.push({ key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        ops.push({ key, remove: true });
        return chain;
      },
      commit: () => {
        const valid = checks.every((expected) => entryFor(expected.key).versionstamp === expected.versionstamp);
        if (!valid) return Promise.resolve({ ok: false } as const);
        for (const op of ops) {
          if (op.remove) kvStore.delete(keyToString(op.key));
          else kvStore.set(keyToString(op.key), { value: op.value, versionstamp: nextVersion() });
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

const { handleCodexCatalogModels } = await import("../src/catalog/index.ts");
const { buildDeepSeekWaterfallCodexRecord } = await import("../src/catalog/models.ts");
const { handleModels } = await import("../src/models/catalog.ts");
const { DEEPSEEK_WATERFALL_MODEL_ID } = await import("../src/deepseek/waterfall.ts");
const { storeCodexCatalog } = await import("../src/catalog/store.ts");
const { CODEX_CATALOG_AUTH_GENERATION_KEY, CODEX_CATALOG_FRESH_MS } = await import("../src/catalog/types.ts");
const { CODEX_AUTH_POOL_KV_KEY, resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
const { setKvForTest } = await import("../src/kv.ts");
const { CODEX_MODELS_WHITELIST_KV_KEY } = await import("../src/models/codex-models-whitelist.ts");
const { fetchOpenRouterModels, resetOpenRouterModelsCacheForTest } = await import("../src/models/openrouter-models.ts");
const { PROVIDER_SELECTION_KV_KEY, resetProviderSelectionCacheForTest } = await import("../src/provider/selection.ts");
const { resetRuntimeConfigCacheForTest } = await import("../src/runtime-config.ts");

const AUTH_GENERATION = "auth-generation-openrouter-catalog";

const seedKv = (whitelistModelIds: readonly string[]): void => {
  kvStore.clear();
  kvStore.set(keyToString(CODEX_CATALOG_AUTH_GENERATION_KEY), { value: AUTH_GENERATION, versionstamp: nextVersion() });
  kvStore.set(keyToString([...CODEX_AUTH_POOL_KV_KEY]), {
    value: {
      accounts: [{ access_token: "server-access", refresh_token: "server-refresh", account_id: "server-account", updated_at_ms: Date.now() }],
      updated_at_ms: Date.now(),
    },
    versionstamp: nextVersion(),
  });
  kvStore.set(keyToString([...CODEX_MODELS_WHITELIST_KV_KEY]), {
    value: { model_ids: whitelistModelIds, updated_at_ms: 1 },
    versionstamp: nextVersion(),
  });
  setKvForTest(kvStub);
  resetCodexAuthCacheForTest();
  resetProviderSelectionCacheForTest();
  resetRuntimeConfigCacheForTest();
};

/** Credentials that append rows this suite does not assert. */
const PROVIDER_KEY_ENVS = ["DEEPSEEK_API_KEY", "LITHOSAI_API_KEY", "CEREBRAS_API_KEY", "METERED_API_KEY", "SURPLUS_API_KEY"] as const;

/** Run with every ambient provider credential cleared, then restore it. */
const withoutProviderKeys = async (run: () => Promise<void>): Promise<void> => {
  const saved = PROVIDER_KEY_ENVS.map((name) => [name, process.env[name]] as const);
  for (const [name] of saved) Reflect.deleteProperty(process.env, name);
  try {
    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
};

/** The served OpenRouter catalogue: one id with metadata and one bare id. */
const servedCatalogue = async (): Promise<void> => {
  await fetchOpenRouterModels({
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [
            { id: "vendor/alpha" },
            {
              id: "vendor/beta",
              context_length: 32_000,
              top_provider: { context_length: 32_000 },
              reasoning: { supported_efforts: ["high"], default_effort: "high" },
            },
          ],
        })
      ),
  });
};

/** The upstream Codex catalog for a version: one id the operator could enable and one hidden id. */
const upstreamCodexCatalogFetch = (): typeof fetch =>
  createFetchMock((input: RequestInfo | URL): Promise<Response> => {
    const version = new URL(fetchUrl(input)).searchParams.get("client_version") ?? "missing";
    return Promise.resolve(
      Response.json({ models: [{ slug: `gpt-${version}` }, { slug: `hidden-${version}` }] }, { headers: { "Content-Type": "application/json" } })
    );
  });

/** Seed KV, the served catalogue and the OpenRouter credential, then run one case. */
const withFixture = async (whitelistModelIds: readonly string[], run: () => Promise<void>): Promise<void> => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "fixture-openrouter-key";
  resetOpenRouterModelsCacheForTest();
  try {
    await withoutProviderKeys(async () => {
      seedKv(whitelistModelIds);
      await servedCatalogue();
      await run();
    });
  } finally {
    setKvForTest(null);
    resetOpenRouterModelsCacheForTest();
    resetProviderSelectionCacheForTest();
    resetRuntimeConfigCacheForTest();
    if (originalKey === undefined) Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
};

const codexCatalogRequest = (): Request =>
  new Request("https://ai.ubq.fi/v1/models?client_version=0.100.0", { headers: { Authorization: "Bearer gateway-client-token" } });

/** Two pooled accounts whose catalogs differ only by the daybreak row. */
const pooledAccounts = [
  { access_token: "pool-a-access", refresh_token: "pool-a-refresh", account_id: "pool-account-a", updated_at_ms: Date.now() },
  { access_token: "pool-b-access", refresh_token: "pool-b-refresh", account_id: "pool-account-b", updated_at_ms: Date.now() },
];

const seedPooledAccounts = (): void => {
  kvStore.set(keyToString([...CODEX_AUTH_POOL_KV_KEY]), {
    value: { accounts: pooledAccounts, updated_at_ms: Date.now() },
    versionstamp: nextVersion(),
  });
  resetCodexAuthCacheForTest();
};

/** The pooled upstream: only account A advertises the daybreak id. */
const pooledCodexCatalogFetch = (): typeof fetch =>
  createFetchMock((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const accountId = new Headers(init?.headers).get("ChatGPT-Account-ID");
    const models = accountId === "pool-account-a" ? [{ slug: "gpt-daybreak-blue-latest" }, { slug: "pooled-shared" }] : [{ slug: "pooled-shared" }];
    return Promise.resolve(Response.json({ models }, { headers: { "Content-Type": "application/json" } }));
  });

test("codex catalog: the versioned catalog advertises the pooled union narrowed by the operator whitelist", async () => {
  await withFixture(["pooled-shared"], async () => {
    seedPooledAccounts();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = pooledCodexCatalogFetch();
    try {
      const hidden = await handleCodexCatalogModels(codexCatalogRequest(), "0.100.0");
      assert.equal(hidden.status, 200);
      const hiddenSlugs = ((await hidden.json()) as { models: { slug: string }[] }).models.map((model) => model.slug);
      assert.equal(hiddenSlugs.includes("pooled-shared"), true, "the pooled row both accounts serve is advertised");
      assert.equal(hiddenSlugs.includes("gpt-daybreak-blue-latest"), false, "a daybreak id the operator did not enable stays out");

      kvStore.set(keyToString([...CODEX_MODELS_WHITELIST_KV_KEY]), {
        value: { model_ids: ["pooled-shared", "gpt-daybreak-blue-latest"], updated_at_ms: 2 },
        versionstamp: nextVersion(),
      });
      const enabled = await handleCodexCatalogModels(codexCatalogRequest(), "0.100.0");
      assert.equal(enabled.status, 200);
      const enabledSlugs = ((await enabled.json()) as { models: { slug: string }[] }).models.map((model) => model.slug);
      assert.equal(enabledSlugs.includes("gpt-daybreak-blue-latest"), true, "enabling the id advertises the pooled union row");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("codex catalog: OpenRouter rows follow the operator whitelist and keep their snapshot metadata", async () => {
  await withFixture(["gpt-0.100.0", "vendor/beta"], async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = upstreamCodexCatalogFetch();
    try {
      const response = await handleCodexCatalogModels(codexCatalogRequest(), "0.100.0");
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { models: Record<string, unknown>[] };
      const slugs = payload.models.map((model) => model.slug);
      assert.equal(slugs.includes("gpt-0.100.0"), true, "a whitelisted stored row survives");
      assert.equal(slugs.includes("hidden-0.100.0"), false, "the whitelist still hides stored rows");
      assert.equal(slugs.includes("vendor/alpha"), false, "an OpenRouter id the operator did not enable stays out of the catalog Codex selects");
      const beta = payload.models.find((model) => model.slug === "vendor/beta");
      assert.ok(beta, "a whitelisted OpenRouter id is advertised");
      assert.deepEqual(beta.supported_endpoint_types, ["openai-response", "openai-chat"]);
      assert.deepEqual(
        (beta.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort),
        ["high"]
      );
      assert.equal(beta.default_reasoning_level, "high");
      assert.equal(beta.context_window, 32_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("codex catalog: an empty whitelist is no filter and OpenRouter rows still list", async () => {
  await withFixture([], async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = upstreamCodexCatalogFetch();
    try {
      const response = await handleCodexCatalogModels(codexCatalogRequest(), "0.100.0");
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { models: Record<string, unknown>[] };
      assert.deepEqual(
        payload.models.map((model) => model.slug),
        ["gpt-0.100.0", "hidden-0.100.0", DEEPSEEK_WATERFALL_MODEL_ID, "vendor/alpha", "vendor/beta"]
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("codex catalog: an active whitelist filters a fresh stored-catalog hit instead of short-circuiting", async () => {
  await withFixture(["gpt-0.100.0"], async () => {
    kvStore.set(keyToString([...PROVIDER_SELECTION_KV_KEY]), { value: { provider_ids: ["codex"], updated_at_ms: 1 }, versionstamp: nextVersion() });
    resetProviderSelectionCacheForTest();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock(() => Promise.reject(new Error("a fresh stored-catalog hit must not reach upstream")));
    try {
      const stored = await storeCodexCatalog(kvStub, {
        clientVersion: "0.100.0",
        authGeneration: AUTH_GENERATION,
        body: JSON.stringify({ models: [{ slug: "gpt-0.100.0" }, { slug: "hidden-0.100.0" }] }),
        contentType: "application/json",
        fetchedAtMs: Date.now(),
      });
      assert.equal(stored, true, "the stored catalog seeds the fresh-cache hit path");
      const response = await handleCodexCatalogModels(codexCatalogRequest(), "0.100.0");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-uos-cache"), "hit");
      const payload = (await response.json()) as { models: Record<string, unknown>[] };
      assert.deepEqual(
        payload.models.map((model) => model.slug),
        ["gpt-0.100.0"],
        "the enabled-model policy narrows the stored body"
      );
      assert.match(response.headers.get("ETag") ?? "", /^"uos-catalog-/, "the unfiltered upstream body's tag is not forwarded");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("codex catalog: served-byte ETags change when OpenRouter enriches an unchanged upstream catalog", async () => {
  await withFixture([], async () => {
    // The gateway identity is checked so the synthetic route stays assembled;
    // this test owns the OpenRouter enrichment behavior, not the route gate.
    kvStore.set(keyToString([...PROVIDER_SELECTION_KV_KEY]), {
      value: { provider_ids: ["codex", "openrouter", "ubiquity"], updated_at_ms: 1 },
      versionstamp: nextVersion(),
    });
    resetProviderSelectionCacheForTest();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock(() => Promise.reject(new Error("a fresh catalog must not reach upstream")));
    try {
      const body = JSON.stringify({ models: [{ slug: "gpt-stored" }] });
      resetOpenRouterModelsCacheForTest();
      await fetchOpenRouterModels({ force: true, fetcher: () => Promise.resolve(Response.json({ data: [] })) });
      const stored = await storeCodexCatalog(kvStub, {
        clientVersion: "0.100.0",
        authGeneration: AUTH_GENERATION,
        body,
        etag: '"upstream-only"',
        fetchedAtMs: Date.now(),
      });
      assert.equal(stored, true, "the unchanged upstream catalog is cached");
      const expectedInitialBody = JSON.stringify({ models: [{ slug: "gpt-stored" }, buildDeepSeekWaterfallCodexRecord()] });
      const first = await handleModels(codexCatalogRequest());
      assert.equal(first.status, 200);
      assert.equal(await first.text(), expectedInitialBody, "the assembled path serves the upstream bytes plus the always-on waterfall row");
      const oldTag = first.headers.get("ETag") ?? "";
      assert.equal(oldTag, `"uos-catalog-${createHash("sha256").update(expectedInitialBody).digest("hex").slice(0, 32)}"`);
      await fetchOpenRouterModels({
        force: true,
        fetcher: () => Promise.resolve(Response.json({ data: [{ id: "vendor/beta", context_length: 128_000 }] })),
      });
      const changedRequest = new Request(codexCatalogRequest(), { headers: { "If-None-Match": oldTag } });
      const changed = await handleModels(changedRequest);
      assert.equal(changed.status, 200, "an old body validator cannot hide newly widened metadata");
      const changedBody = await changed.text();
      assert.notEqual(changedBody, body);
      const changedTag = changed.headers.get("ETag") ?? "";
      assert.equal(changedTag, `"uos-catalog-${createHash("sha256").update(changedBody).digest("hex").slice(0, 32)}"`);
      assert.notEqual(changedTag, oldTag);
      assert.equal((JSON.parse(changedBody) as { models: { context_window: number }[] }).models[2].context_window, 128_000);
      const current = await handleModels(new Request(codexCatalogRequest(), { headers: { "If-None-Match": changedTag } }));
      assert.equal(current.status, 304);
      assert.equal(current.headers.get("ETag"), changedTag);
      assert.equal(await current.text(), "");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("codex catalog: revalidation reapplies narrower OpenRouter windows to the source body", async () => {
  await withFixture(["gpt-6-astra"], async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      resetOpenRouterModelsCacheForTest();
      await fetchOpenRouterModels({
        force: true,
        fetcher: () => Promise.resolve(Response.json({ data: [{ id: "openai/gpt-6-astra", context_length: 1_050_000 }] })),
      });
      const sourceBody = JSON.stringify({ models: [{ slug: "gpt-6-astra", context_window: 272_000, max_context_window: 872_000 }] });
      assert.equal(
        await storeCodexCatalog(kvStub, {
          clientVersion: "0.100.0",
          authGeneration: AUTH_GENERATION,
          body: sourceBody,
          etag: '"catalog-etag"',
          fetchedAtMs: now - CODEX_CATALOG_FRESH_MS - 1,
        }),
        true
      );
      let upstreamIfNoneMatch: string | null = null;
      globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        upstreamIfNoneMatch = new Request(input, init).headers.get("If-None-Match");
        return Promise.resolve(new Response(null, { status: 304, headers: { ETag: '"catalog-etag"' } }));
      };
      const first = await handleCodexCatalogModels(codexCatalogRequest(), "0.100.0");
      const firstModel = ((await first.json()) as { models: { context_window: number; max_context_window: number }[] }).models[0];
      assert.deepEqual([firstModel.context_window, firstModel.max_context_window], [1_050_000, 1_050_000]);
      assert.equal(upstreamIfNoneMatch, '"catalog-etag"');

      await fetchOpenRouterModels({
        force: true,
        fetcher: () => Promise.resolve(Response.json({ data: [{ id: "openai/gpt-6-astra", context_length: 128_000 }] })),
      });
      now += CODEX_CATALOG_FRESH_MS + 1;
      const second = await handleCodexCatalogModels(codexCatalogRequest(), "0.100.0");
      const secondModel = ((await second.json()) as { models: { context_window: number; max_context_window: number }[] }).models[0];
      assert.deepEqual([secondModel.context_window, secondModel.max_context_window], [872_000, 872_000]);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });
});
