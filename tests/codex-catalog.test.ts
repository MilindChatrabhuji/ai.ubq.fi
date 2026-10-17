import { createFetchMock } from "./helpers/fetch-mock.ts";
import { setKvForTest } from "../src/kv.ts";
import { test } from "bun:test";
import { type Kv, type KvEntryMaybe, type KvKey, type KvListSelector } from "#kv";
import assert from "node:assert/strict";

// This suite asserts exact fetch and KV budgets, so the event-driven maintenance
// hooks must not run in the background while it measures them.
const { setProviderCapacitySampleTriggerForTest } = await import("../src/provider/capacity-events.ts");
const { setPaidFallbackTerminalSweepForTest } = await import("../src/paid-fallback/index.ts");
setProviderCapacitySampleTriggerForTest(() => {});
setPaidFallbackTerminalSweepForTest(() => {});

// The DeepSeek, LithosAI and OpenRouter routes append their models to the
// served catalog whenever their credential is configured. These tests assert
// exact catalog shapes from stored snapshots and discovery sources only, so the
// ambient credentials are cleared to keep them independent of the machine that
// runs them.
delete process.env.DEEPSEEK_API_KEY;
delete process.env.LITHOSAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const keyToString = (key: KvKey): string => JSON.stringify(key);
const kvStore = new Map<string, { value: unknown; versionstamp: string }>();
let versionCounter = 0;
type AtomicTestOp = { kind: "set" | "delete"; key: KvKey; value?: unknown };
let beforeAtomicCommit: ((ops: readonly AtomicTestOp[]) => void) | null = null;

const nextVersion = (): string => String(++versionCounter).padStart(20, "0");
const entryFor = (key: KvKey): KvEntryMaybe<unknown> => {
  const stored = kvStore.get(keyToString(key));
  return stored ? { key, value: stored.value, versionstamp: stored.versionstamp } : { key, value: null, versionstamp: null };
};
const matchesPrefix = (key: KvKey, prefix: KvKey): boolean => prefix.every((part, index) => key[index] === part);

/** URL text of a fetch input (the transports under test always pass a string URL). */
const fetchUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const kvStub = {
  get: (key: KvKey) => Promise.resolve(entryFor(key)),
  set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
    kvStore.set(keyToString(key), { value, versionstamp: nextVersion() });
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    kvStore.delete(keyToString(key));
    return Promise.resolve();
  },
  list: async function* (selector: KvListSelector) {
    const prefix = "prefix" in selector ? selector.prefix : [];
    // A real Deno.KV list suspends before its first entry; keep that
    // asynchronous boundary so no consumer can rely on synchronous iteration.
    await Promise.resolve();
    for (const [encodedKey, stored] of kvStore) {
      const key = JSON.parse(encodedKey) as KvKey;
      if (matchesPrefix(key, prefix)) yield { key, value: stored.value, versionstamp: stored.versionstamp };
    }
  },
  atomic: () => {
    const checks: KvEntryMaybe<unknown>[] = [];
    const ops: AtomicTestOp[] = [];
    const chain = {
      check: (entry: KvEntryMaybe<unknown>) => {
        checks.push(entry);
        return chain;
      },
      set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
        ops.push({ kind: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        ops.push({ kind: "delete", key });
        return chain;
      },
      commit: () => {
        beforeAtomicCommit?.(ops);
        const valid = checks.every((expected) => entryFor(expected.key).versionstamp === expected.versionstamp);
        if (!valid) return Promise.resolve({ ok: false } as const);
        for (const op of ops) {
          if (op.kind === "delete") kvStore.delete(keyToString(op.key));
          else kvStore.set(keyToString(op.key), { value: op.value, versionstamp: nextVersion() });
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

setKvForTest(kvStub);

const {
  CODEX_CATALOG_AUTH_GENERATION_KEY,
  CODEX_CATALOG_CHUNK_BYTES,
  CODEX_CATALOG_CHUNK_PREFIX,
  CODEX_CATALOG_FRESH_MS,
  CODEX_CATALOG_LEASE_PREFIX,
  CODEX_CATALOG_MAX_VERSIONS,
  CODEX_CATALOG_PREFIX,
  CODEX_CATALOG_RETENTION_MS,
} = await import("../src/catalog/types.ts");
const { getCodexCatalogMemoVersionsForTest, resetCodexCatalogMemoForTest, storeCodexCatalog } = await import("../src/catalog/store.ts");
const { handleCodexCatalogModels } = await import("../src/catalog/index.ts");
const { resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
const { handleModels } = await import("../src/models/catalog.ts");
const { config } = await import("../src/config.ts");
const { fetchMeteredModels, METERED_MODELS_CACHE_TTL_MS, resetMeteredModelsCacheForTest, setMeteredModelsFetchForTest } =
  await import("../src/provider/metered.ts");
const { fetchSurplusModels, resetSurplusModelsCacheForTest, SURPLUS_MODELS_CACHE_TTL_MS } = await import("../src/provider/surplus.ts");
const { fetchOpenRouterModels, resetOpenRouterModelsCacheForTest, setOpenRouterModelsFetchForTest } = await import("../src/models/openrouter-models.ts");
const { loadRuntimeConfig, resetRuntimeConfigCacheForTest, RUNTIME_CONFIG_V2_KEY } = await import("../src/runtime-config.ts");

// Public metadata is unauthenticated; every default warm uses this local fixture.
setOpenRouterModelsFetchForTest(() => Promise.resolve(Response.json({ data: [] })));

const AUTH_GENERATION = "auth-generation-test";
const AUTH_KEY = ["ubq_ai", "codex_auth"] as const;
const SNAPSHOT_KEY = ["ubq_ai", "codex_models"] as const;
const catalogKey = (version: string): KvKey => ["ubq_ai", "codex_catalog", version];

/** Code-unit ascending string order: exactly what an argument-less `Array.prototype.sort()` does. */
const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const seedBaseState = (snapshotVersion = "0.200.0"): void => {
  kvStore.clear();
  beforeAtomicCommit = null;
  resetCodexAuthCacheForTest();
  resetCodexCatalogMemoForTest();
  resetRuntimeConfigCacheForTest();
  resetOpenRouterModelsCacheForTest();
  kvStore.set(keyToString(CODEX_CATALOG_AUTH_GENERATION_KEY), {
    value: AUTH_GENERATION,
    versionstamp: nextVersion(),
  });
  kvStore.set(keyToString(AUTH_KEY), {
    value: {
      accounts: [
        {
          access_token: "server-access",
          refresh_token: "server-refresh",
          account_id: "server-account",
          updated_at_ms: Date.now(),
        },
      ],
      updated_at_ms: Date.now(),
    },
    versionstamp: nextVersion(),
  });
  const snapshot = {
    source: "chatgpt_codex",
    client_version: snapshotVersion,
    updated_at_ms: Date.now(),
    models: [
      { slug: `snapshot-${snapshotVersion}` },
      // The Codex endpoint's own window for an id the paid routes also serve.
      {
        slug: "gpt-6-astra",
        context_window: 272_000,
        max_context_window: 872_000,
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    ],
  };
  kvStore.set(keyToString(SNAPSHOT_KEY), {
    value: snapshot,
    versionstamp: nextVersion(),
  });
  kvStore.set(keyToString(RUNTIME_CONFIG_V2_KEY), {
    value: {
      version: 2,
      default_model: `snapshot-${snapshotVersion}`,
      default_reasoning_effort: "medium",
      codex_models: snapshot,
      updated_at_ms: Date.now(),
    },
    versionstamp: nextVersion(),
  });
};

const catalogBody = (version: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    models: [
      {
        slug: `gpt-${version}`,
        display_name: `Rich ${version}`,
        base_instructions: "must remain untouched",
        supported_reasoning_levels: [{ effort: "high", description: "deep" }],
      },
    ],
    ...extra,
  });

const request = (version: string, headers: HeadersInit = {}): Request => {
  const requestHeaders = new Headers({ Authorization: "Bearer gateway-client-token", Cookie: "incoming=secret" });
  for (const [name, value] of new Headers(headers)) requestHeaders.set(name, value);
  return new Request(`https://ai.ubq.fi/v1/models?client_version=${version}`, { headers: requestHeaders });
};

test("codex catalog: unversioned models retain the exact OpenAI list shape", async () => {
  seedBaseState();
  const response = await handleModels(new Request("https://ai.ubq.fi/v1/models"));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(compareStrings), ["data", "object"]);
  assert.equal(payload.object, "list");
});

test("codex catalog: exact versions preserve rich JSON, isolate caches, and derive client ETags", async () => {
  seedBaseState("0.100.0");
  const originalFetch = globalThis.fetch;
  const calls: { url: string; headers: Headers }[] = [];
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const upstream = new Request(input, init);
    calls.push({ url: upstream.url, headers: upstream.headers });
    const version = new URL(upstream.url).searchParams.get("client_version") ?? "missing";
    return Promise.resolve(
      new Response(catalogBody(version, { version_marker: version }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ETag: `"${version}"` },
      })
    );
  });

  try {
    const first = await handleCodexCatalogModels(request("0.144.3"), "0.144.3");
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag") ?? "";
    assert.match(etag, /^"uos-catalog-[a-f0-9]{32}"$/);
    assert.deepEqual(await first.json(), JSON.parse(catalogBody("0.144.3", { version_marker: "0.144.3" })));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/models?client_version=0.144.3");
    assert.equal(calls[0].headers.get("cookie"), null);
    assert.notEqual(calls[0].headers.get("authorization"), "Bearer gateway-client-token");
    assert.match(calls[0].headers.get("user-agent") ?? "", /codex_cli_rs\/0\.144\.3/);
    const hit = await handleCodexCatalogModels(request("0.144.3"), "0.144.3");
    assert.equal(hit.headers.get("x-uos-cache"), "hit");
    assert.equal(calls.length, 1);

    const secondVersion = await handleCodexCatalogModels(request("0.145.0"), "0.145.0");
    assert.equal(secondVersion.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(((await secondVersion.json()) as { version_marker?: string }).version_marker, "0.145.0");

    const notModified = await handleCodexCatalogModels(request("0.144.3", { "If-None-Match": etag }), "0.144.3");
    assert.equal(notModified.status, 304);
    assert.equal(await notModified.text(), "");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: malformed versions are rejected before upstream access", async () => {
  seedBaseState();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => {
    throw new Error("invalid versions must not fetch");
  });
  try {
    for (const version of ["0.144", "v0.144.3", "0.144.3.1", "0.144.x", ""]) {
      const response = await handleCodexCatalogModels(request(version), version);
      assert.equal(response.status, 400);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: stale catalogs survive refresh failures but expired catalogs do not", async () => {
  seedBaseState();
  const version = "0.150.0";
  const observedAtMs = Date.now();
  await storeCodexCatalog(kvStub, {
    clientVersion: version,
    authGeneration: AUTH_GENERATION,
    body: catalogBody(version),
    etag: '"stale"',
    fetchedAtMs: observedAtMs - CODEX_CATALOG_FRESH_MS - 1,
  });
  const originalFetch = globalThis.fetch;
  const degradationSignals: number[] = [];
  const dependencies = {
    now: () => observedAtMs,
    recordSentinelDegradation: (timestamp: number) => {
      degradationSignals.push(timestamp);
      return Promise.reject(new Error("sentinel unavailable"));
    },
  };
  globalThis.fetch = createFetchMock(() => Promise.resolve(new Response("temporary failure", { status: 503 })));
  try {
    const stale = await handleCodexCatalogModels(request(version), version, dependencies);
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("x-uos-cache"), "stale");
    assert.equal(((await stale.json()) as { models: { slug: string }[] }).models[0].slug, `gpt-${version}`);
    assert.deepEqual(degradationSignals, [observedAtMs]);

    const metadata = kvStore.get(keyToString(catalogKey(version)))?.value as { fetched_at_ms: number };
    metadata.fetched_at_ms = observedAtMs - CODEX_CATALOG_RETENTION_MS - 1;
    const expired = await handleCodexCatalogModels(request(version), version, dependencies);
    assert.equal(expired.status, 502);
    assert.deepEqual(degradationSignals, [observedAtMs, observedAtMs]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: stale catalogs signal masked upstream transport failures", async () => {
  seedBaseState();
  const version = "0.150.2";
  const observedAtMs = Date.now();
  await storeCodexCatalog(kvStub, {
    clientVersion: version,
    authGeneration: AUTH_GENERATION,
    body: catalogBody(version),
    fetchedAtMs: observedAtMs - CODEX_CATALOG_FRESH_MS - 1,
  });
  const originalFetch = globalThis.fetch;
  const degradationSignals: number[] = [];
  globalThis.fetch = createFetchMock(() => {
    throw new Error("connection reset");
  });
  try {
    const response = await handleCodexCatalogModels(request(version), version, {
      now: () => observedAtMs,
      recordSentinelDegradation: (timestamp: number) => {
        degradationSignals.push(timestamp);
        return Promise.resolve(true);
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-cache"), "stale");
    assert.deepEqual(degradationSignals, [observedAtMs]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: account fallback signals the masked transport failure once", async () => {
  seedBaseState();
  const version = "0.150.3";
  const observedAtMs = Date.now();
  const authPool = kvStore.get(keyToString(AUTH_KEY))?.value as {
    accounts: Record<string, unknown>[];
  };
  authPool.accounts.push({
    access_token: "fallback-access",
    refresh_token: "fallback-refresh",
    account_id: "fallback-account",
    updated_at_ms: observedAtMs,
  });
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  const degradationSignals: number[] = [];
  globalThis.fetch = createFetchMock(() => {
    upstreamCalls += 1;
    if (upstreamCalls === 1) throw new Error("first account connection reset");
    return Promise.resolve(new Response(catalogBody(version), { headers: { "Content-Type": "application/json" } }));
  });
  try {
    const response = await handleCodexCatalogModels(request(version), version, {
      now: () => observedAtMs,
      recordSentinelDegradation: (timestamp: number) => {
        degradationSignals.push(timestamp);
        return Promise.resolve(true);
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-cache"), "miss");
    assert.equal(upstreamCalls, 2);
    assert.deepEqual(degradationSignals, [observedAtMs]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: stale catalogs signal response body transport failures", async () => {
  seedBaseState();
  const version = "0.150.4";
  const observedAtMs = Date.now();
  await storeCodexCatalog(kvStub, {
    clientVersion: version,
    authGeneration: AUTH_GENERATION,
    body: catalogBody(version),
    fetchedAtMs: observedAtMs - CODEX_CATALOG_FRESH_MS - 1,
  });
  const originalFetch = globalThis.fetch;
  const degradationSignals: number[] = [];
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("body socket reset"));
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )
  );
  try {
    const response = await handleCodexCatalogModels(request(version), version, {
      now: () => observedAtMs,
      recordSentinelDegradation: (timestamp: number) => {
        degradationSignals.push(timestamp);
        return Promise.resolve(true);
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-cache"), "stale");
    assert.deepEqual(degradationSignals, [observedAtMs]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: stale upstream ETags revalidate upstream without validating client bytes", async () => {
  seedBaseState();
  const version = "0.150.1";
  await storeCodexCatalog(kvStub, {
    clientVersion: version,
    authGeneration: AUTH_GENERATION,
    body: catalogBody(version),
    etag: '"catalog-etag"',
    fetchedAtMs: Date.now() - CODEX_CATALOG_FRESH_MS - 1,
  });
  const originalFetch = globalThis.fetch;
  let upstreamIfNoneMatch: string | null = null;
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    upstreamIfNoneMatch = new Request(input, init).headers.get("If-None-Match");
    return Promise.resolve(new Response(null, { status: 304, headers: { ETag: '"catalog-etag"' } }));
  });
  try {
    const response = await handleCodexCatalogModels(request(version, { "If-None-Match": '"catalog-etag"' }), version);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-cache"), "revalidated");
    assert.equal(upstreamIfNoneMatch, '"catalog-etag"');
    assert.equal(await response.text(), catalogBody(version));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: refresh leases suppress duplicate upstream requests", async () => {
  seedBaseState();
  const version = "0.151.0";
  await storeCodexCatalog(kvStub, {
    clientVersion: version,
    authGeneration: AUTH_GENERATION,
    body: catalogBody(version),
    fetchedAtMs: Date.now() - CODEX_CATALOG_FRESH_MS - 1,
  });
  kvStore.set(keyToString([...CODEX_CATALOG_LEASE_PREFIX, version]), {
    value: { owner: "other-request", lease_until_ms: Date.now() + 10_000 },
    versionstamp: nextVersion(),
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let degradationSignals = 0;
  globalThis.fetch = createFetchMock(() => {
    calls += 1;
    return Promise.resolve(new Response(catalogBody(version), { headers: { "Content-Type": "application/json" } }));
  });
  try {
    const response = await handleCodexCatalogModels(request(version), version, {
      recordSentinelDegradation: () => {
        degradationSignals += 1;
        return Promise.resolve(true);
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-cache"), "stale");
    assert.equal(calls, 0);
    assert.equal(degradationSignals, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: concurrent cold misses share one upstream refresh", async () => {
  seedBaseState();
  const version = "0.151.1";
  const originalFetch = globalThis.fetch;
  let resolveFetch!: (response: Response) => void;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => (markFetchStarted = resolve));
  const deferredResponse = new Promise<Response>((resolve) => (resolveFetch = resolve));
  let calls = 0;
  globalThis.fetch = createFetchMock(() => {
    calls += 1;
    markFetchStarted();
    return deferredResponse;
  });

  try {
    const firstPromise = handleCodexCatalogModels(request(version), version);
    await fetchStarted;
    const secondPromise = handleCodexCatalogModels(request(version), version);
    resolveFetch(new Response(catalogBody(version), { headers: { "Content-Type": "application/json" } }));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-uos-cache"), "wait");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: auth rotation discards an in-flight old-generation refresh", async () => {
  seedBaseState("0.200.0");
  const version = "0.201.1";
  const replacementGeneration = "replacement-auth-generation";
  const replacementBody = catalogBody(version, { account: "replacement" });
  const originalFetch = globalThis.fetch;
  let resolveFetch!: (response: Response) => void;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => (markFetchStarted = resolve));
  const deferredResponse = new Promise<Response>((resolve) => (resolveFetch = resolve));
  globalThis.fetch = createFetchMock(() => {
    markFetchStarted();
    return deferredResponse;
  });

  try {
    const responsePromise = handleCodexCatalogModels(request(version), version);
    await fetchStarted;
    kvStore.set(keyToString(CODEX_CATALOG_AUTH_GENERATION_KEY), {
      value: replacementGeneration,
      versionstamp: nextVersion(),
    });
    kvStore.set(keyToString(SNAPSHOT_KEY), {
      value: {
        source: "chatgpt_codex",
        client_version: version,
        updated_at_ms: Date.now(),
        models: [{ slug: "replacement-snapshot" }],
      },
      versionstamp: nextVersion(),
    });
    assert.equal(
      await storeCodexCatalog(kvStub, {
        clientVersion: version,
        authGeneration: replacementGeneration,
        body: replacementBody,
      }),
      true
    );
    resolveFetch(
      new Response(catalogBody(version, { account: "old" }), {
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-cache"), "rotated");
    assert.equal(((await response.json()) as { account?: string }).account, "replacement");
    const metadata = kvStore.get(keyToString(catalogKey(version)))?.value as { auth_generation?: string };
    assert.equal(metadata.auth_generation, replacementGeneration);
    const snapshot = kvStore.get(keyToString(SNAPSHOT_KEY))?.value as { models?: { slug?: string }[] };
    assert.equal(snapshot.models?.[0]?.slug, "replacement-snapshot");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: slow refreshes renew their lease", async () => {
  seedBaseState();
  const version = "0.151.2";
  const leaseStorageKey = keyToString([...CODEX_CATALOG_LEASE_PREFIX, version]);
  const originalFetch = globalThis.fetch;
  let resolveFetch!: (response: Response) => void;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => (markFetchStarted = resolve));
  const deferredResponse = new Promise<Response>((resolve) => (resolveFetch = resolve));
  globalThis.fetch = createFetchMock(() => {
    markFetchStarted();
    return deferredResponse;
  });

  try {
    const responsePromise = handleCodexCatalogModels(request(version), version);
    await fetchStarted;
    const initialLease = kvStore.get(leaseStorageKey)?.value as { lease_until_ms: number };
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const renewedLease = kvStore.get(leaseStorageKey)?.value as { lease_until_ms: number };
    assert.ok(renewedLease.lease_until_ms > initialLease.lease_until_ms);
    resolveFetch(new Response(catalogBody(version), { headers: { "Content-Type": "application/json" } }));
    assert.equal((await responsePromise).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: gzip chunks are bounded and integrity failures force a refresh", async () => {
  seedBaseState();
  const version = "0.152.0";
  const noisyModels = Array.from({ length: 4_000 }, (_, index) => ({
    slug: `model-${index}-${crypto.randomUUID()}`,
    description: crypto.randomUUID(),
  }));
  const body = JSON.stringify({ models: noisyModels });
  assert.equal(
    await storeCodexCatalog(kvStub, {
      clientVersion: version,
      authGeneration: AUTH_GENERATION,
      body,
    }),
    true
  );
  const chunkEntries = [...kvStore.entries()].filter(([encoded]) => {
    const key = JSON.parse(encoded) as KvKey;
    return matchesPrefix(key, [...CODEX_CATALOG_CHUNK_PREFIX, version]);
  });
  assert.ok(chunkEntries.length > 1);
  for (const [, stored] of chunkEntries) {
    assert.ok((stored.value as Uint8Array).byteLength <= CODEX_CATALOG_CHUNK_BYTES);
  }
  const first = chunkEntries[0][1];
  const corrupted = (first.value as Uint8Array).slice();
  corrupted[0] ^= 0xff;
  first.value = corrupted;

  const originalFetch = globalThis.fetch;
  // The paid catalogs are a legitimate fallback here, but the Codex refresh
  // itself must happen exactly once. Count it separately from the recognized
  // paid catalog lookups instead of counting every fetch.
  const codexModelsUrl = `${config.codexBaseUrl}/models`;
  const recognizedPaidCatalogUrls = ["https://api.openlux.ai/v1/models", "https://api.surplusintelligence.ai/v1/models"];
  const fetchedUrls: string[] = [];
  let codexRefreshCalls = 0;
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const url = fetchUrl(input);
    fetchedUrls.push(url);
    if (url.startsWith(`${codexModelsUrl}?client_version=`)) {
      codexRefreshCalls += 1;
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    }
    if (recognizedPaidCatalogUrls.includes(url)) {
      return Promise.resolve(Response.json({ data: [] }));
    }
    // Unrecognized URLs and inference endpoints are rejected outright.
    return Promise.resolve(new Response(`unexpected fetch ${url}`, { status: 500 }));
  });
  try {
    const response = await handleCodexCatalogModels(request(version), version);
    assert.equal(response.status, 502);
    assert.equal(codexRefreshCalls, 1, "a corrupted cached body forces exactly one Codex catalog refresh");
    const unexpectedUrls = fetchedUrls.filter((url) => !url.startsWith(`${codexModelsUrl}?client_version=`) && !recognizedPaidCatalogUrls.includes(url));
    assert.deepEqual(unexpectedUrls, [], `unexpected fetches: ${fetchedUrls.join(", ")}`);
  } finally {
    globalThis.fetch = originalFetch;
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
  }
});

test("codex catalog: replacing metadata reclaims superseded chunks", async () => {
  seedBaseState();
  const version = "0.152.1";
  assert.equal(
    await storeCodexCatalog(kvStub, {
      clientVersion: version,
      authGeneration: AUTH_GENERATION,
      body: catalogBody(version, { generation: "first" }),
    }),
    true
  );
  const firstMetadata = kvStore.get(keyToString(catalogKey(version)))?.value as {
    body_generation: string;
    chunk_count: number;
  };
  const firstChunkKeys = Array.from({ length: firstMetadata.chunk_count }, (_, index) =>
    keyToString([...CODEX_CATALOG_CHUNK_PREFIX, version, firstMetadata.body_generation, index])
  );
  assert.ok(firstChunkKeys.every((key) => kvStore.has(key)));

  assert.equal(
    await storeCodexCatalog(kvStub, {
      clientVersion: version,
      authGeneration: AUTH_GENERATION,
      body: catalogBody(version, { generation: "second" }),
    }),
    true
  );
  const secondMetadata = kvStore.get(keyToString(catalogKey(version)))?.value as {
    body_generation: string;
    chunk_count: number;
  };
  assert.notEqual(secondMetadata.body_generation, firstMetadata.body_generation);
  assert.ok(firstChunkKeys.every((key) => !kvStore.has(key)));
  for (let index = 0; index < secondMetadata.chunk_count; index += 1) {
    assert.equal(kvStore.has(keyToString([...CODEX_CATALOG_CHUNK_PREFIX, version, secondMetadata.body_generation, index])), true);
  }
});

test("codex catalog: rejected old-generation writes reclaim their chunks", async () => {
  seedBaseState();
  const version = "0.152.2";
  assert.equal(
    await storeCodexCatalog(kvStub, {
      clientVersion: version,
      authGeneration: "superseded-generation",
      body: catalogBody(version),
    }),
    false
  );
  const orphanChunks = [...kvStore.keys()].filter((encoded) => {
    const key = JSON.parse(encoded) as KvKey;
    return matchesPrefix(key, [...CODEX_CATALOG_CHUNK_PREFIX, version]);
  });
  assert.equal(orphanChunks.length, 0);
  assert.equal(kvStore.has(keyToString(catalogKey(version))), false);
});

test("codex catalog: version cache evicts the oldest catalog beyond its bound", async () => {
  seedBaseState();
  const totalVersions = CODEX_CATALOG_MAX_VERSIONS + 3;
  for (let index = 0; index < totalVersions; index += 1) {
    const version = `1.0.${index}`;
    assert.equal(
      await storeCodexCatalog(kvStub, {
        clientVersion: version,
        authGeneration: AUTH_GENERATION,
        body: catalogBody(version),
        fetchedAtMs: Date.now() + index,
      }),
      true
    );
    const loaded = await handleCodexCatalogModels(request(version), version);
    assert.equal(loaded.status, 200);
    await loaded.body?.cancel();
  }

  const metadataEntries = [...kvStore.entries()].filter(([encoded, stored]) => {
    const key = JSON.parse(encoded) as KvKey;
    return (
      matchesPrefix(key, CODEX_CATALOG_PREFIX) &&
      key.length === CODEX_CATALOG_PREFIX.length + 1 &&
      typeof (stored.value as { body_generation?: unknown }).body_generation === "string"
    );
  });
  assert.equal(metadataEntries.length, CODEX_CATALOG_MAX_VERSIONS);
  for (let index = 0; index < totalVersions - CODEX_CATALOG_MAX_VERSIONS; index += 1) {
    const version = `1.0.${index}`;
    assert.equal(kvStore.has(keyToString(catalogKey(version))), false);
    const chunks = [...kvStore.keys()].filter((encoded) => {
      const key = JSON.parse(encoded) as KvKey;
      return matchesPrefix(key, [...CODEX_CATALOG_CHUNK_PREFIX, version]);
    });
    assert.equal(chunks.length, 0);
  }
  assert.equal(kvStore.has(keyToString(catalogKey(`1.0.${totalVersions - 1}`))), true);
  const memoVersions = getCodexCatalogMemoVersionsForTest();
  assert.equal(memoVersions.length, CODEX_CATALOG_MAX_VERSIONS);
  for (let index = 0; index < totalVersions - CODEX_CATALOG_MAX_VERSIONS; index += 1) {
    assert.equal(memoVersions.includes(`1.0.${index}`), false);
  }
  assert.equal(memoVersions.at(-1), `1.0.${totalVersions - 1}`);
});

test("codex catalog: only same-or-newer clients update the normalized snapshot", async () => {
  seedBaseState("0.200.0");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const version = new URL(input instanceof Request ? input.url : input.toString()).searchParams.get("client_version");
    assert.ok(version, "the client_version query parameter must be present");
    return Promise.resolve(
      new Response(
        catalogBody(version, {
          models: [
            {
              slug: `gpt-${version}`,
              display_name: `Rich ${version}`,
              supported_reasoning_levels: [{ effort: "high", description: "deep" }],
            },
            {
              slug: "codex-auto-review",
              display_name: "Codex Auto Review",
              visibility: "hide",
              supported_in_api: true,
            },
            {
              slug: "codex-internal-evals",
              visibility: "hide",
              supported_in_api: false,
            },
          ],
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      )
    );
  });
  try {
    assert.equal((await handleCodexCatalogModels(request("0.199.0"), "0.199.0")).status, 200);
    const olderSnapshot = kvStore.get(keyToString(SNAPSHOT_KEY))?.value as { client_version: string };
    assert.equal(olderSnapshot.client_version, "0.200.0");

    assert.equal((await handleCodexCatalogModels(request("0.201.0"), "0.201.0")).status, 200);
    const snapshot = kvStore.get(keyToString(SNAPSHOT_KEY))?.value as {
      client_version: string;
      models: { slug: string }[];
    };
    assert.equal(snapshot.client_version, "0.201.0");
    assert.deepEqual(
      snapshot.models.map((model) => model.slug),
      ["gpt-0.201.0", "codex-auto-review"]
    );
    const runtime = kvStore.get(keyToString(RUNTIME_CONFIG_V2_KEY))?.value as {
      default_model: string;
      default_reasoning_effort: string;
      codex_models: { client_version: string; models: { slug: string }[] };
    };
    assert.equal(runtime.default_model, "gpt-0.201.0");
    assert.equal(runtime.default_reasoning_effort, "medium");
    assert.equal(runtime.codex_models.client_version, "0.201.0");
    assert.deepEqual(
      runtime.codex_models.models.map((model) => model.slug),
      ["gpt-0.201.0", "codex-auto-review"]
    );

    // The catalog publisher must seed the isolate cache with exactly the
    // compact configuration committed in the same transaction.
    kvStore.set(keyToString(RUNTIME_CONFIG_V2_KEY), {
      value: { ...runtime, default_model: "stale-uncommitted-value" },
      versionstamp: nextVersion(),
    });
    assert.equal((await loadRuntimeConfig(kvStub))?.default_model, "gpt-0.201.0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: normalized snapshot retry preserves a concurrent admin default", async () => {
  seedBaseState("0.200.0");
  const currentSnapshot = {
    source: "chatgpt_codex",
    client_version: "0.200.0",
    updated_at_ms: Date.now(),
    models: [
      { slug: "shared-default", supported_reasoning_levels: ["medium"] },
      { slug: "admin-default", supported_reasoning_levels: ["high"] },
    ],
  };
  kvStore.set(keyToString(SNAPSHOT_KEY), { value: currentSnapshot, versionstamp: nextVersion() });
  kvStore.set(keyToString(RUNTIME_CONFIG_V2_KEY), {
    value: {
      version: 2,
      default_model: "shared-default",
      default_reasoning_effort: "medium",
      codex_models: currentSnapshot,
      updated_at_ms: Date.now(),
    },
    versionstamp: nextVersion(),
  });
  resetRuntimeConfigCacheForTest();

  const nextModels = [
    { slug: "shared-default", supported_reasoning_levels: ["medium"] },
    { slug: "admin-default", supported_reasoning_levels: ["high"] },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      new Response(catalogBody("0.201.0", { models: nextModels }), {
        headers: { "Content-Type": "application/json" },
      })
    )
  );

  beforeAtomicCommit = (ops) => {
    if (!ops.some((op) => keyToString(op.key) === keyToString(RUNTIME_CONFIG_V2_KEY))) return;
    beforeAtomicCommit = null;
    const currentEntry = kvStore.get(keyToString(RUNTIME_CONFIG_V2_KEY));
    assert.ok(currentEntry, "the runtime config must already be stored");
    const current = currentEntry.value as Record<string, unknown>;
    kvStore.set(keyToString(RUNTIME_CONFIG_V2_KEY), {
      value: {
        ...current,
        default_model: "admin-default",
        default_reasoning_effort: "high",
        updated_at_ms: Date.now(),
      },
      versionstamp: nextVersion(),
    });
  };

  try {
    assert.equal((await handleCodexCatalogModels(request("0.201.0"), "0.201.0")).status, 200);
    const snapshot = kvStore.get(keyToString(SNAPSHOT_KEY))?.value as { client_version: string };
    const runtime = kvStore.get(keyToString(RUNTIME_CONFIG_V2_KEY))?.value as {
      default_model: string;
      default_reasoning_effort: string;
      codex_models: { client_version: string };
    };
    assert.equal(snapshot.client_version, "0.201.0");
    assert.equal(runtime.codex_models.client_version, "0.201.0");
    assert.equal(runtime.default_model, "admin-default");
    assert.equal(runtime.default_reasoning_effort, "high");
  } finally {
    beforeAtomicCommit = null;
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: normalized refresh retries preserve same-slug prompt-cache probe evidence", async () => {
  seedBaseState("0.200.0");
  const promptCache = {
    version: 1,
    providers: [
      {
        id: "codex_chatgpt",
        scope: {
          probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
          account_slots: "unknown",
          token_refresh: "preserved",
          conversation_id: "independent",
          reproducible_cycles: 3,
          source: "live_probe",
          verified_at_ms: 2_000,
        },
      },
    ],
  };
  const existingSnapshot = {
    source: "chatgpt_codex",
    client_version: "0.200.0",
    updated_at_ms: Date.now(),
    models: [{ slug: "gpt-cache-probe", prompt_cache: promptCache }],
  };
  kvStore.set(keyToString(SNAPSHOT_KEY), { value: existingSnapshot, versionstamp: nextVersion() });
  kvStore.set(keyToString(RUNTIME_CONFIG_V2_KEY), {
    value: {
      version: 2,
      default_model: "gpt-cache-probe",
      default_reasoning_effort: "medium",
      codex_models: existingSnapshot,
      updated_at_ms: Date.now(),
    },
    versionstamp: nextVersion(),
  });
  resetRuntimeConfigCacheForTest();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      new Response(
        catalogBody("0.201.0", {
          models: [{ slug: "gpt-cache-probe", supported_reasoning_levels: ["medium"] }],
        }),
        { headers: { "Content-Type": "application/json" } }
      )
    )
  );

  beforeAtomicCommit = (ops) => {
    if (!ops.some((op) => keyToString(op.key) === keyToString(SNAPSHOT_KEY))) return;
    beforeAtomicCommit = null;
    kvStore.set(keyToString(SNAPSHOT_KEY), {
      value: { ...existingSnapshot, updated_at_ms: Date.now() + 1 },
      versionstamp: nextVersion(),
    });
  };

  try {
    assert.equal((await handleCodexCatalogModels(request("0.201.0"), "0.201.0")).status, 200);
    const snapshot = kvStore.get(keyToString(SNAPSHOT_KEY))?.value as {
      client_version?: string;
      models?: { slug?: string; prompt_cache?: unknown }[];
    };
    const runtime = kvStore.get(keyToString(RUNTIME_CONFIG_V2_KEY))?.value as {
      codex_models?: { models?: { slug?: string; prompt_cache?: unknown }[] };
    };
    assert.equal(snapshot.client_version, "0.201.0");
    assert.deepEqual(snapshot.models?.[0]?.prompt_cache, promptCache);
    assert.equal(runtime.codex_models?.models?.[0]?.prompt_cache, undefined);
  } finally {
    beforeAtomicCommit = null;
    globalThis.fetch = originalFetch;
  }
});

test("codex catalog: model picker receives the complete unique union of paid provider models", async () => {
  seedBaseState("0.200.0");
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  const originalFetch = globalThis.fetch;
  const originalMeteredKey = process.env.METERED_API_KEY;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  process.env.METERED_API_KEY = "metered-catalog-test-key";
  process.env.SURPLUS_API_KEY = "surplus-catalog-test-key";
  await fetchMeteredModels({
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "shared-paid-model",
              owned_by: "openlux",
              supported_endpoint_types: ["openai-response"],
              description: "OpenLux route",
            },
            {
              id: "openlux-only-model",
              owned_by: "openlux",
              supported_endpoint_types: ["openai-response"],
            },
            {
              id: "chat-only-model",
              owned_by: "openlux",
              supported_endpoint_types: ["openai"],
            },
          ],
        })
      ),
  });
  await fetchSurplusModels({
    apiKey: "surplus-catalog-test-key",
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [
            { id: "shared-paid-model", provider: "surplus" },
            { id: "surplus-only-model", provider: "surplus" },
            { id: "deepseek-v4-flash", provider: "surplus" },
            { id: "deepseek-v4-flash-0731", provider: "surplus" },
            { id: "deepseek-v4-flash:web", provider: "surplus" },
            { id: "minimax-m2.7", provider: "surplus" },
          ],
        })
      ),
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const version = new URL(fetchUrl(input)).searchParams.get("client_version") ?? "missing";
    return Promise.resolve(new Response(catalogBody(version), { headers: { "Content-Type": "application/json" } }));
  });

  try {
    const response = await handleCodexCatalogModels(request("0.148.0"), "0.148.0");
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models: Record<string, unknown>[] };
    const slugs = payload.models.map((model) => model.slug);
    assert.deepEqual(slugs, [
      "gpt-0.148.0",
      "shared-paid-model",
      "openlux-only-model",
      "surplus-only-model",
      "deepseek-v4-flash",
      "deepseek-v4-flash-0731",
      "deepseek-v4-flash:web",
      "minimax-m2.7",
      "ubiquity/deepseek-v4.1-flash",
    ]);
    assert.equal(new Set(slugs).size, slugs.length);
    assert.equal(payload.models.find((model) => model.slug === "shared-paid-model")?.visibility, "list");
    assert.deepEqual(payload.models.find((model) => model.slug === "surplus-only-model")?.supported_reasoning_levels, [
      { effort: "none", description: "No reasoning" },
    ]);
    // Discovery states an id, not its capabilities, and nothing enriches these
    // ids in this test: the records keep the no-reasoning default and publish no
    // context rather than inheriting a curated guess.
    for (const slug of ["deepseek-v4-flash", "deepseek-v4-flash-0731", "deepseek-v4-flash:web"]) {
      const model = payload.models.find((candidate) => candidate.slug === slug);
      assert.deepEqual(model?.supported_reasoning_levels, [{ effort: "none", description: "No reasoning" }]);
      assert.equal(model.default_reasoning_level, "none");
      assert.equal(model.context_window, undefined);
      assert.equal(model.max_context_window, undefined);
      assert.equal(model.auto_compact_token_limit, undefined);
    }
    const minimax = payload.models.find((model) => model.slug === "minimax-m2.7");
    assert.equal(minimax?.context_window, undefined);
    assert.equal(minimax?.auto_compact_token_limit, undefined);
    assert.equal(slugs.includes("chat-only-model"), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
  }
});

test("codex catalog: cold provider caches cannot publish the incomplete Codex-only catalog", async () => {
  seedBaseState("0.200.0");
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  const originalFetch = globalThis.fetch;
  const originalMeteredKey = process.env.METERED_API_KEY;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  process.env.METERED_API_KEY = "metered-cold-catalog-test-key";
  process.env.SURPLUS_API_KEY = "surplus-cold-catalog-test-key";
  setMeteredModelsFetchForTest(() =>
    Promise.resolve(
      Response.json({
        data: [{ id: "cold-openlux-model", owned_by: "openlux", supported_endpoint_types: ["openai-response"] }],
      })
    )
  );
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const url = fetchUrl(input);
    if (url === "https://api.surplusintelligence.ai/v1/models") {
      return Promise.resolve(Response.json({ data: [{ id: "deepseek-v4-flash", provider: "surplus" }] }));
    }
    const version = new URL(url).searchParams.get("client_version") ?? "missing";
    return Promise.resolve(new Response(catalogBody(version), { headers: { "Content-Type": "application/json" } }));
  });

  try {
    const response = await handleCodexCatalogModels(request("0.203.0"), "0.203.0");
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models: Record<string, unknown>[] };
    const slugs = payload.models.map((model) => model.slug);
    assert.equal(slugs.includes("cold-openlux-model"), true);
    const deepseek = payload.models.find((model) => model.slug === "deepseek-v4-flash");
    // No source describes this id here, so the row advertises no reasoning only.
    assert.deepEqual(
      (deepseek?.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort),
      ["none"]
    );
  } finally {
    globalThis.fetch = originalFetch;
    setMeteredModelsFetchForTest(null);
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
  }
});

test("paid-provider model caches ignore out-of-order Metered refreshes", async () => {
  resetMeteredModelsCacheForTest();
  const originalMeteredKey = process.env.METERED_API_KEY;
  process.env.METERED_API_KEY = "metered-cache-race-test-key";
  let calls = 0;
  let resolveOlder!: (response: Response) => void;
  let resolveNewer!: (response: Response) => void;
  const olderResponse = new Promise<Response>((resolve) => (resolveOlder = resolve));
  const newerResponse = new Promise<Response>((resolve) => (resolveNewer = resolve));
  const fetcher = () => {
    calls += 1;
    return calls === 1 ? olderResponse : newerResponse;
  };

  try {
    const older = fetchMeteredModels({ force: true, fetcher });
    const newer = fetchMeteredModels({ force: true, fetcher });
    assert.equal(calls, 2);
    resolveNewer(
      Response.json({
        data: [{ id: "new-metered-model", owned_by: "openlux", supported_endpoint_types: ["openai-response"] }],
      })
    );
    assert.deepEqual(
      (await newer)?.models.map((model) => model.id),
      ["new-metered-model"]
    );
    resolveOlder(
      Response.json({
        data: [{ id: "old-metered-model", owned_by: "openlux", supported_endpoint_types: ["openai-response"] }],
      })
    );
    await older;
    const cached = await fetchMeteredModels({ fetcher });
    assert.deepEqual(
      cached?.models.map((model) => model.id),
      ["new-metered-model"]
    );
    assert.equal(calls, 2);
  } finally {
    resetMeteredModelsCacheForTest();
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
  }
});

test("paid-provider model caches ignore out-of-order Surplus refreshes", async () => {
  resetSurplusModelsCacheForTest();
  let calls = 0;
  let resolveOlder!: (response: Response) => void;
  let resolveNewer!: (response: Response) => void;
  const olderResponse = new Promise<Response>((resolve) => (resolveOlder = resolve));
  const newerResponse = new Promise<Response>((resolve) => (resolveNewer = resolve));
  const fetcher = () => {
    calls += 1;
    return calls === 1 ? olderResponse : newerResponse;
  };

  try {
    const older = fetchSurplusModels({ apiKey: "surplus-cache-race-test-key", force: true, fetcher });
    const newer = fetchSurplusModels({ apiKey: "surplus-cache-race-test-key", force: true, fetcher });
    assert.equal(calls, 2);
    resolveNewer(Response.json({ data: [{ id: "new-surplus-model" }] }));
    assert.deepEqual(
      (await newer)?.models.map((model) => model.id),
      ["new-surplus-model"]
    );
    resolveOlder(Response.json({ data: [{ id: "old-surplus-model" }] }));
    await older;
    const cached = await fetchSurplusModels({ apiKey: "surplus-cache-race-test-key", fetcher });
    assert.deepEqual(
      cached?.models.map((model) => model.id),
      ["new-surplus-model"]
    );
    assert.equal(calls, 2);
  } finally {
    resetSurplusModelsCacheForTest();
  }
});

test("paid-provider model refresh failures use a cooldown", async () => {
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  const originalNow = Date.now;
  const originalMeteredKey = process.env.METERED_API_KEY;
  const baseNow = originalNow();
  process.env.METERED_API_KEY = "metered-cache-backoff-test-key";
  Date.now = () => baseNow;

  try {
    await fetchMeteredModels({
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [{ id: "stale-metered-model", owned_by: "openlux", supported_endpoint_types: ["openai-response"] }],
          })
        ),
    });
    await fetchSurplusModels({
      apiKey: "surplus-cache-backoff-test-key",
      force: true,
      fetcher: () => Promise.resolve(Response.json({ data: [{ id: "stale-surplus-model" }] })),
    });
    Date.now = () => baseNow + Math.max(METERED_MODELS_CACHE_TTL_MS, SURPLUS_MODELS_CACHE_TTL_MS) + 1;
    let meteredFailures = 0;
    let surplusFailures = 0;
    const failingMeteredFetcher = () => {
      meteredFailures += 1;
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    };
    const failingSurplusFetcher = () => {
      surplusFailures += 1;
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    };

    await fetchMeteredModels({ fetcher: failingMeteredFetcher });
    await fetchMeteredModels({ fetcher: failingMeteredFetcher });
    await fetchSurplusModels({ apiKey: "surplus-cache-backoff-test-key", fetcher: failingSurplusFetcher });
    await fetchSurplusModels({ apiKey: "surplus-cache-backoff-test-key", fetcher: failingSurplusFetcher });
    assert.equal(meteredFailures, 1);
    assert.equal(surplusFailures, 1);
  } finally {
    Date.now = originalNow;
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
  }
});

test("codex catalog: expired paid-provider caches schedule background refreshes", async () => {
  seedBaseState("0.200.0");
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalMeteredKey = process.env.METERED_API_KEY;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  const baseNow = originalNow();
  const staleNow = baseNow + Math.max(METERED_MODELS_CACHE_TTL_MS, SURPLUS_MODELS_CACHE_TTL_MS) + 1;
  let meteredRefreshes = 0;
  let surplusRefreshes = 0;
  let resolveMeteredRefresh!: (response: Response) => void;
  let resolveSurplusRefresh!: (response: Response) => void;
  const meteredRefreshResponse = new Promise<Response>((resolve) => (resolveMeteredRefresh = resolve));
  const surplusRefreshResponse = new Promise<Response>((resolve) => (resolveSurplusRefresh = resolve));
  process.env.METERED_API_KEY = "metered-catalog-stale-test-key";
  process.env.SURPLUS_API_KEY = "surplus-catalog-stale-test-key";
  Date.now = () => baseNow;
  await fetchMeteredModels({
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [{ id: "stale-openlux-model", owned_by: "openlux", supported_endpoint_types: ["openai-response"] }],
        })
      ),
  });
  await fetchSurplusModels({
    apiKey: "surplus-catalog-stale-test-key",
    force: true,
    fetcher: () => Promise.resolve(Response.json({ data: [{ id: "stale-surplus-model" }] })),
  });
  Date.now = () => staleNow;
  setMeteredModelsFetchForTest((input) => {
    if (fetchUrl(input) !== "https://api.openlux.ai/v1/models") {
      return Promise.resolve(new Response("unexpected Metered URL", { status: 500 }));
    }
    meteredRefreshes += 1;
    return meteredRefreshResponse;
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const url = fetchUrl(input);
    if (url === "https://api.openlux.ai/v1/models") {
      meteredRefreshes += 1;
      return Promise.resolve(
        Response.json({
          data: [{ id: "fresh-openlux-model", owned_by: "openlux", supported_endpoint_types: ["openai-response"] }],
        })
      );
    }
    if (url === "https://api.surplusintelligence.ai/v1/models") {
      surplusRefreshes += 1;
      return surplusRefreshResponse;
    }
    const version = new URL(url).searchParams.get("client_version") ?? "missing";
    return Promise.resolve(new Response(catalogBody(version), { headers: { "Content-Type": "application/json" } }));
  });

  try {
    const response = await handleCodexCatalogModels(request("0.202.0"), "0.202.0");
    assert.equal(response.status, 200);
    const concurrent = await handleCodexCatalogModels(request("0.202.0"), "0.202.0");
    assert.equal(concurrent.status, 200);
    assert.equal(meteredRefreshes, 1);
    assert.equal(surplusRefreshes, 1);

    resolveMeteredRefresh(
      Response.json({
        data: [{ id: "fresh-openlux-model", owned_by: "openlux", supported_endpoint_types: ["openai-response"] }],
      })
    );
    resolveSurplusRefresh(Response.json({ data: [{ id: "fresh-surplus-model" }] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const refreshed = await handleCodexCatalogModels(request("0.202.0"), "0.202.0");
    const payload = (await refreshed.json()) as { models: { slug?: string }[] };
    const slugs = payload.models.map((model) => model.slug);
    assert.equal(slugs.includes("fresh-openlux-model"), true);
    assert.equal(slugs.includes("fresh-surplus-model"), true);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    setMeteredModelsFetchForTest(null);
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
  }
});

test("codex catalog: third-party enrichment fills rows no first-party source describes", async () => {
  seedBaseState("0.200.0");
  resetSurplusModelsCacheForTest();
  resetOpenRouterModelsCacheForTest();
  const originalFetch = globalThis.fetch;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  process.env.SURPLUS_API_KEY = "surplus-catalog-test-key";
  await fetchSurplusModels({
    apiKey: "surplus-catalog-test-key",
    force: true,
    fetcher: () => Promise.resolve(Response.json({ data: [{ id: "deepseek-v4-flash", provider: "surplus" }] })),
  });
  await fetchOpenRouterModels({
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "deepseek/deepseek-v4-flash",
              context_length: 1_048_576,
              top_provider: { context_length: 1_048_576, max_completion_tokens: 384_000 },
              reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "high", mandatory: false },
            },
          ],
        })
      ),
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const version = new URL(fetchUrl(input)).searchParams.get("client_version") ?? "missing";
    return Promise.resolve(new Response(catalogBody(version), { headers: { "Content-Type": "application/json" } }));
  });

  try {
    const response = await handleCodexCatalogModels(request("0.148.0"), "0.148.0");
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models: Record<string, unknown>[] };
    const deepseek = payload.models.find((model) => model.slug === "deepseek-v4-flash");
    assert.ok(deepseek, "the discovery-only id is still advertised");
    assert.deepEqual(
      (deepseek.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort),
      ["low", "high", "max"],
      "external tiers retain their strings in ascending native picker order"
    );
    assert.equal(deepseek.default_reasoning_level, "high");
    assert.equal(deepseek.context_window, 1_048_576);
    assert.equal(deepseek.max_context_window, 1_048_576);
    assert.equal(deepseek.auto_compact_token_limit, 891_289, "the limit is derived from the resolved window");
    assert.equal(deepseek.effective_context_window_percent, 95);
    assert.equal(deepseek.model_class, undefined, "the curated model class is gone with the curated table");
  } finally {
    globalThis.fetch = originalFetch;
    resetSurplusModelsCacheForTest();
    resetOpenRouterModelsCacheForTest();
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
  }
});

test("codex catalog: a Codex-served id advertises the widest window a source states", async () => {
  seedBaseState("0.200.0");
  resetSurplusModelsCacheForTest();
  resetOpenRouterModelsCacheForTest();
  const originalFetch = globalThis.fetch;
  const originalSurplusKey = process.env.SURPLUS_API_KEY;
  process.env.SURPLUS_API_KEY = "surplus-catalog-test-key";
  // The endpoint's catalog says 272k/872k and understates what it accepts; the
  // gateway advertises the model's real window so a client can choose its budget.
  await fetchSurplusModels({
    apiKey: "surplus-catalog-test-key",
    force: true,
    fetcher: () => Promise.resolve(Response.json({ data: [{ id: "gpt-6-astra", provider: "surplus" }] })),
  });
  await fetchOpenRouterModels({
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "openai/gpt-6-astra",
              context_length: 1_050_000,
              top_provider: { context_length: 1_050_000 },
              reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "high", mandatory: false },
            },
          ],
        })
      ),
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const version = new URL(fetchUrl(input)).searchParams.get("client_version") ?? "missing";
    return Promise.resolve(new Response(catalogBody(version), { headers: { "Content-Type": "application/json" } }));
  });

  try {
    // A version with no stored catalog takes the paid-only path.
    const response = await handleCodexCatalogModels(request("0.155.0"), "0.155.0");
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models: Record<string, unknown>[] };
    const astra = payload.models.find((model) => model.slug === "gpt-6-astra");
    assert.ok(astra, "the paid route still advertises the Codex-served id");
    assert.equal(astra.context_window, 1_050_000, "the widest stated window is advertised");
    assert.equal(astra.max_context_window, 1_050_000);
    assert.equal(astra.auto_compact_token_limit, 892_500);
    assert.deepEqual(
      (astra.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort),
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      "the uploaded Codex tiers pass through verbatim"
    );
    // An id no source widens keeps the endpoint's own numbers.
    const untouched = payload.models.find((model) => model.slug === "gpt-reserve");
    if (untouched) {
      assert.equal(untouched.context_window, 272_000);
      assert.equal(untouched.max_context_window, 872_000);
    }
  } finally {
    globalThis.fetch = originalFetch;
    resetSurplusModelsCacheForTest();
    resetOpenRouterModelsCacheForTest();
    if (originalSurplusKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusKey;
  }
});
