import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import { type Kv, type KvEntryMaybe, type KvKey, type KvListSelector } from "#kv";
// Per-account Codex model availability: the per-account catalog union, the
// learned account+model rejections, and eligibility-aware routing. The suite
// uses a disposable in-memory KV and controlled fetch stubs only.

import assert from "node:assert/strict";

const keyToString = (key: KvKey): string => JSON.stringify(key);
const kvStore = new Map<string, { value: unknown; versionstamp: string }>();
let versionCounter = 0;
const nextVersion = (): string => String(++versionCounter).padStart(20, "0");
const entryFor = (key: KvKey): KvEntryMaybe<unknown> => {
  const stored = kvStore.get(keyToString(key));
  return stored ? { key, value: stored.value, versionstamp: stored.versionstamp } : { key, value: null, versionstamp: null };
};
const writeKv = (key: KvKey, value: unknown): string => {
  const versionstamp = nextVersion();
  kvStore.set(keyToString(key), { value, versionstamp });
  return versionstamp;
};
const readKv = (key: KvKey): unknown => kvStore.get(keyToString(key))?.value;

const kvStub = {
  get: (key: KvKey) => Promise.resolve(entryFor(key)),
  getMany: (keys: KvKey[]) => Promise.resolve(keys.map((key) => entryFor(key))),
  set: (key: KvKey, value: unknown) => {
    writeKv(key, value);
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    kvStore.delete(keyToString(key));
    return Promise.resolve();
  },
  list: async function* (selector: KvListSelector) {
    const prefix = "prefix" in selector ? selector.prefix : [];
    await Promise.resolve();
    for (const [encodedKey, stored] of kvStore) {
      const key = JSON.parse(encodedKey) as KvKey;
      if (prefix.every((part, index) => key[index] === part)) yield { key, value: stored.value, versionstamp: stored.versionstamp };
    }
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
          else writeKv(op.key, op.value);
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

const { setKvForTest } = await import("../src/kv.ts");
const { CODEX_AUTH_POOL_KV_KEY, resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
const { setCodexResponseAccountTelemetry, setCodexResponseActiveTelemetry } = await import("../src/codex/auth.ts");
const { fetchCodexModels } = await import("../src/models/codex-models-fetch.ts");
const { CODEX_ACCOUNT_ROUTING_KV_KEY, CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, parseCodexActiveAccountSelection } = await import("../src/codex/routing-state.ts");
const { routingAccountIdentity } = await import("../src/codex/capacity-routing.ts");
const { selectCodexRoutingAccountsStrong } = await import("../src/codex/account-routing.ts");
const {
  codexModelUnsupportedFromResponse,
  initialCodexSelectionResponse,
  learnCodexModelUnavailable,
  parseCodexModelUnsupportedDetail,
  runCodexSerialAdmissionLoop,
} = await import("../src/codex/dispatch.ts");
const {
  CODEX_ACCOUNT_MODELS_CACHE_TTL_MS,
  CODEX_ACCOUNT_MODELS_KV_KEY,
  CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_AGE_MS,
  CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_COUNT,
  awaitCodexAccountModelsRefreshForTest,
  codexModelUnavailableAccounts,
  emptyCodexAccountModelsStore,
  getCodexAccountModelsCacheForTest,
  mergeCodexAccountCatalogs,
  parseCodexAccountModelsStore,
  recordCodexAccountCatalogs,
  recordCodexModelUnsupported,
  resetCodexAccountModelsCacheForTest,
  setCodexAccountModelsStoreForTest,
  withCodexModelUnsupported,
} = await import("../src/models/codex-models-availability.ts");

type AuthState = Readonly<{ account_id: string; access_token: string; refresh_token: string; updated_at_ms: number }>;

const codexAccount = (accountId: string): AuthState => ({
  account_id: accountId,
  access_token: `${accountId}-access-token`,
  refresh_token: `${accountId}-refresh-token`,
  updated_at_ms: Date.now(),
});

const seedPool = (accounts: readonly AuthState[]): string => {
  const versionstamp = writeKv([...CODEX_AUTH_POOL_KV_KEY], { accounts, updated_at_ms: 1 });
  resetCodexAuthCacheForTest();
  return versionstamp;
};

const seedActiveRow = async (
  auth: AuthState,
  poolVersionstamp: string,
  slot: number,
  generation: number,
  transitionReason: string | null = null
): Promise<void> => {
  const identity = await routingAccountIdentity(auth);
  writeKv([...CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY], {
    v: 1,
    account_id_hash: identity.accountIdHash,
    credential_version: identity.credentialVersion,
    pool_versionstamp: poolVersionstamp,
    slot,
    routing_generation: 0,
    generation,
    transition_reason: transitionReason,
    updated_at_ms: 1,
  });
};

/** Drop the durable availability evidence so a case starts from a known empty store. */
const clearAvailabilityKv = (): void => {
  kvStore.delete(keyToString(CODEX_ACCOUNT_MODELS_KV_KEY));
  resetCodexAccountModelsCacheForTest();
};

const MODEL = "gpt-daybreak-blue-latest";
const UNSUPPORTED_DETAIL = `The '${MODEL}' model is not supported when using Codex with a ChatGPT account.`;

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

/** A fetch stub that answers each pool account with its own catalog. */
const catalogFetch = (byAccount: Readonly<Record<string, unknown>>, seen?: { ifNoneMatch: string | null; calls: number }): typeof fetch =>
  createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    if (seen) {
      seen.calls += 1;
      seen.ifNoneMatch = new Headers(init?.headers).get("If-None-Match");
    }
    const accountId = new Headers(init?.headers).get("ChatGPT-Account-ID") ?? "";
    const body = byAccount[accountId];
    if (body instanceof Response) return Promise.resolve(body);
    return Promise.resolve(jsonResponse(body ?? { models: [] }));
  });

setKvForTest(kvStub);
clearAvailabilityKv();
resetCodexAuthCacheForTest();

// ── B1: per-account catalog union ────────────────────────────────────────────

test("codex models: the pool catalog unions every account in pool order and records each catalog", async () => {
  seedPool([codexAccount("union-a"), codexAccount("union-b")]);
  clearAvailabilityKv();
  const daybreakRow = { slug: MODEL, context_window: 128_000 };
  const seen: { ifNoneMatch: string | null; calls: number } = { ifNoneMatch: "unset", calls: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(
    catalogFetch(
      {
        "union-a": { models: [daybreakRow, { slug: "shared-model" }], has_more: true },
        "union-b": { models: [{ slug: "shared-model" }, { slug: "sibling-only" }], has_more: false },
      },
      seen
    )
  );
  try {
    const response = await fetchCodexModels({ clientVersion: "0.160.0", ifNoneMatch: '"cached"' });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models: Record<string, unknown>[]; has_more: boolean };
    assert.deepEqual(
      payload.models.map((model) => model.slug),
      ["gpt-daybreak-blue-latest", "shared-model", "sibling-only"]
    );
    assert.deepEqual(payload.models[0], daybreakRow, "the first-in-pool-order row is kept verbatim");
    assert.equal(payload.has_more, true, "other top-level keys come from the first contributing body");
    assert.equal(seen.ifNoneMatch, null, "multi-account mode must not send If-None-Match");
    assert.equal(seen.calls, 2);
    const store = getCodexAccountModelsCacheForTest().store;
    assert.ok(store, "the union records its per-account catalogs");
    assert.deepEqual(store.accounts["union-a"].slugs, [MODEL, "shared-model"]);
    assert.deepEqual(store.accounts["union-b"].slugs, ["shared-model", "sibling-only"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex models: unusable account rows are dropped while valid rows and sibling eligibility survive", async () => {
  seedPool([codexAccount("rows-a"), codexAccount("rows-b")]);
  clearAvailabilityKv();
  const firstRow = {
    slug: "first-account-model",
    context_window: 128_000,
    supported_reasoning_levels: [{ effort: "ultra", description: "Source tier" }],
    source_metadata: { retained: true },
  };
  const siblingRow = {
    slug: MODEL,
    context_window: 256_000,
    supported_reasoning_levels: [{ effort: "low", description: "Sibling tier" }],
  };
  const originalFetch = globalThis.fetch;
  const seen: { ifNoneMatch: string | null; calls: number } = { ifNoneMatch: "unset", calls: 0 };
  globalThis.fetch = createFetchMock(
    catalogFetch(
      {
        "rows-a": { models: [null, {}, { slug: " " }, { slug: 7 }, "invalid", false, 42, [], firstRow], has_more: true },
        "rows-b": { models: [{ ...firstRow, context_window: 1 }, siblingRow], has_more: false },
      },
      seen
    )
  );
  try {
    const response = await fetchCodexModels({ clientVersion: "0.160.0", ifNoneMatch: '"cached"' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { models: [firstRow, siblingRow], has_more: true }, "valid native rows and their source tiers remain verbatim");
    assert.equal(seen.calls, 2, "both account catalogs are fetched");
    assert.equal(seen.ifNoneMatch, null, "the multi-account union remains unconditional");
    const store = getCodexAccountModelsCacheForTest().store;
    assert.ok(store, "each account's usable catalog identifiers are recorded");
    assert.deepEqual(store.accounts["rows-a"].slugs, [firstRow.slug]);
    assert.deepEqual(store.accounts["rows-b"].slugs, [firstRow.slug, MODEL]);
    assert.equal(codexModelUnavailableAccounts(MODEL, ["rows-a", "rows-b"]).has("rows-a"), true, "only the sibling advertises its model");
    assert.equal(codexModelUnavailableAccounts(MODEL, ["rows-a", "rows-b"]).has("rows-b"), false);
    assert.equal(
      codexModelUnavailableAccounts("unknown-model", ["rows-a", "rows-b"]).size,
      0,
      "unusable rows create no eligibility evidence for unknown models"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex models: one configured account keeps the upstream response and its conditional request", async () => {
  seedPool([codexAccount("single-account")]);
  clearAvailabilityKv();
  const seen: { ifNoneMatch: string | null; calls: number } = { ifNoneMatch: "unset", calls: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    seen.calls += 1;
    seen.ifNoneMatch = new Headers(init?.headers).get("If-None-Match");
    return Promise.resolve(new Response(null, { status: 304, headers: { ETag: '"catalog-1"' } }));
  });
  try {
    const response = await fetchCodexModels({ clientVersion: "0.160.0", ifNoneMatch: '"catalog-1"' });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("ETag"), '"catalog-1"');
    assert.equal(seen.ifNoneMatch, '"catalog-1"');
    assert.equal(seen.calls, 1);
    assert.equal(getCodexAccountModelsCacheForTest().store, null, "a 304 records no catalog");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex models: a fresh single-account catalog clears only its advertised model rejection", async () => {
  const accounts = [codexAccount("single-refresh")];
  const poolVersionstamp = seedPool(accounts);
  await seedActiveRow(accounts[0], poolVersionstamp, 0, 1);
  clearAvailabilityKv();
  await recordCodexAccountCatalogs([{ accountId: "sibling", clientVersion: "0.159.0", slugs: ["sibling-only"] }]);
  await recordCodexModelUnsupported(accounts[0].account_id, MODEL, { detail: UNSUPPORTED_DETAIL });
  await recordCodexModelUnsupported(accounts[0].account_id, "absent-model");
  await recordCodexModelUnsupported("sibling", MODEL);
  const before = getCodexAccountModelsCacheForTest().store;
  assert.ok(before);
  assert.equal((await selectCodexRoutingAccountsStrong({ accounts, updated_at_ms: 1 }, accounts, Date.now(), MODEL)).kind, "model_unavailable");
  const body = JSON.stringify({
    models: [
      null,
      { slug: " " },
      { slug: MODEL, supported_reasoning_levels: [{ effort: "ultra", description: "Native tier" }], default_reasoning_level: "ultra" },
      { id: "another-model" },
      { slug: MODEL },
    ],
    has_more: false,
  });
  const seen = { ifNoneMatch: "unset" as string | null, calls: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seen.calls += 1;
    const headers = new Headers(init?.headers);
    seen.ifNoneMatch = headers.get("If-None-Match");
    assert.equal(headers.get("ChatGPT-Account-ID"), accounts[0].account_id);
    return Promise.resolve(new Response(body, { headers: { "Content-Type": "application/json", ETag: '"fresh-catalog"' } }));
  });
  try {
    const response = await fetchCodexModels({ clientVersion: "0.160.0", ifNoneMatch: '"old-catalog"' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("ETag"), '"fresh-catalog"');
    assert.equal(await response.text(), body, "the native response and reasoning tiers remain byte-identical");
    assert.deepEqual(seen, { ifNoneMatch: '"old-catalog"', calls: 1 });
    const store = getCodexAccountModelsCacheForTest().store;
    assert.ok(store);
    assert.deepEqual(store.accounts[accounts[0].account_id].slugs, [MODEL, "another-model"]);
    assert.equal(store.accounts[accounts[0].account_id].client_version, "0.160.0");
    assert.deepEqual(store.accounts.sibling, before.accounts.sibling, "a single-account refresh leaves sibling catalogs untouched");
    assert.deepEqual(store.unsupported.sibling, before.unsupported.sibling, "a sibling's same-model rejection remains");
    assert.equal(codexModelUnavailableAccounts("absent-model", [accounts[0].account_id]).has(accounts[0].account_id), true);
    const selection = await selectCodexRoutingAccountsStrong({ accounts, updated_at_ms: 1 }, accounts, Date.now(), MODEL);
    assert.equal(selection.kind, "eligible", "fresh advertisement restores real routing eligibility before rejection expiry");
    assert.equal(selection.accounts[0].auth.account_id, accounts[0].account_id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex models: a single-account 304, absent model or unusable catalog never clears a learned rejection", async () => {
  seedPool([codexAccount("single-negative")]);
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, body] of [
      [304, null],
      [200, '{"models":[{"slug":"other-model"}]}'],
      [200, "not json"],
      [200, '{"data":[]}'],
      [500, `{"models":[{"slug":"${MODEL}"}]}`],
    ] as const) {
      clearAvailabilityKv();
      await recordCodexAccountCatalogs([{ accountId: "single-negative", clientVersion: "0.159.0", slugs: ["old-model"] }]);
      await recordCodexModelUnsupported("single-negative", MODEL, { detail: UNSUPPORTED_DETAIL });
      const before = getCodexAccountModelsCacheForTest().store;
      assert.ok(before);
      globalThis.fetch = createFetchMock(() => Promise.resolve(new Response(body, { status, headers: { ETag: '"unchanged"' } })));
      const response = await fetchCodexModels({ clientVersion: "0.160.0", ifNoneMatch: '"unchanged"' });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("ETag"), '"unchanged"');
      assert.equal(await response.text(), body ?? "");
      assert.equal(codexModelUnavailableAccounts(MODEL, ["single-negative"]).get("single-negative"), UNSUPPORTED_DETAIL);
      const after = getCodexAccountModelsCacheForTest().store;
      assert.ok(after);
      assert.deepEqual(after.unsupported, before.unsupported);
      if (body !== '{"models":[{"slug":"other-model"}]}') assert.deepEqual(after.accounts, before.accounts, "only fresh catalogs record evidence");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex models: a failing account keeps the sibling's rows, and every account failing returns the fallback", async () => {
  seedPool([codexAccount("union-a"), codexAccount("union-b")]);
  clearAvailabilityKv();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = createFetchMock(
      catalogFetch({
        "union-a": new Response("a-quota", { status: 429, headers: { "Content-Type": "application/json" } }),
        "union-b": { models: [{ slug: MODEL }] },
      })
    );
    const mixed = await fetchCodexModels({ clientVersion: "0.160.0" });
    assert.equal(mixed.status, 200);
    const mixedPayload = (await mixed.json()) as { models: { slug: string }[] };
    assert.deepEqual(
      mixedPayload.models.map((model) => model.slug),
      [MODEL],
      "the surviving account's rows are served"
    );

    globalThis.fetch = createFetchMock(
      catalogFetch({
        "union-a": new Response("a-quota", { status: 429, headers: { "Content-Type": "application/json" } }),
        "union-b": new Response("b-quota", { status: 429, headers: { "Content-Type": "application/json" } }),
      })
    );
    const failed = await fetchCodexModels({ clientVersion: "0.160.0" });
    assert.equal(failed.status, 429, "all-account failure keeps the existing fallback status");
    assert.equal(await failed.text(), "b-quota");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex models: a malformed account body does not poison the union", async () => {
  seedPool([codexAccount("union-a"), codexAccount("union-b")]);
  clearAvailabilityKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(
    catalogFetch({
      "union-a": new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }),
      "union-b": { models: [{ slug: MODEL }, { slug: "shared-model" }] },
    })
  );
  try {
    const response = await fetchCodexModels({ clientVersion: "0.160.0" });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models: { slug: string }[] };
    assert.deepEqual(
      payload.models.map((model) => model.slug),
      [MODEL, "shared-model"]
    );
    const store = getCodexAccountModelsCacheForTest().store;
    assert.ok(store, "the surviving account is recorded");
    assert.equal(store.accounts["union-a"], undefined, "a malformed body records nothing");
    assert.deepEqual(store.accounts["union-b"].slugs, [MODEL, "shared-model"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── B2: per-account availability store ───────────────────────────────────────

test("codex account models: the durable round-trip keeps only non-secret catalog fields", async () => {
  clearAvailabilityKv();
  await recordCodexAccountCatalogs([{ accountId: "store-a", clientVersion: "0.160.0", slugs: [MODEL, MODEL, "shared-model"] }]);
  const stored = readKv(CODEX_ACCOUNT_MODELS_KV_KEY) as {
    accounts: Record<string, { client_version: string; slugs: string[]; updated_at_ms: number }>;
    unsupported: Record<string, unknown>;
  };
  assert.deepEqual(stored.accounts["store-a"].slugs, [MODEL, "shared-model"]);
  assert.equal(stored.accounts["store-a"].client_version, "0.160.0");
  assert.equal(typeof stored.accounts["store-a"].updated_at_ms, "number");
  const serialized = JSON.stringify(stored);
  for (const forbidden of ["access_token", "refresh_token", "authorization", "secret"]) {
    assert.equal(serialized.includes(forbidden), false, `the stored value must not contain ${forbidden}`);
  }
  assert.deepEqual(parseCodexAccountModelsStore(stored), stored);
});

test("codex account models: malformed durable values are rejected or dropped", () => {
  assert.equal(parseCodexAccountModelsStore("nope"), null);
  assert.equal(parseCodexAccountModelsStore(42), null);
  assert.equal(parseCodexAccountModelsStore({ accounts: "x", unsupported: "y" }), null);
  const parsed = parseCodexAccountModelsStore({
    accounts: {
      good: { client_version: "0.160.0", slugs: ["a", "b"], updated_at_ms: 5 },
      bad: { client_version: 7, slugs: ["a"], updated_at_ms: 5 },
    },
    unsupported: { good: { model: 10, stale: "x" }, broken: "nope" },
  });
  assert.deepEqual(Object.keys(parsed?.accounts ?? {}), ["good"]);
  assert.deepEqual(parsed?.unsupported, { good: { model: 10 } });
});

test("codex account models: a fresh catalog clears a learned rejection and the unsupported map is bounded", async () => {
  clearAvailabilityKv();
  await recordCodexModelUnsupported("store-a", MODEL, { detail: UNSUPPORTED_DETAIL, nowMs: Date.now() });
  assert.equal(codexModelUnavailableAccounts(MODEL, ["store-a"]).get("store-a"), UNSUPPORTED_DETAIL);
  await recordCodexAccountCatalogs([{ accountId: "store-a", clientVersion: "0.160.0", slugs: [MODEL] }]);
  assert.equal(codexModelUnavailableAccounts(MODEL, ["store-a"]).has("store-a"), false, "a model now present clears its rejection");

  let store = emptyCodexAccountModelsStore();
  for (let index = 0; index < 40; index += 1) store = withCodexModelUnsupported(store, "store-a", `model-${index}`, 1_000 + index, 1_000 + index);
  const bounded = store.unsupported["store-a"];
  assert.equal(Object.keys(bounded).length, CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_COUNT);
  assert.notEqual(bounded["model-39"], undefined, "the newest observations survive");
  assert.equal(bounded["model-0"], undefined, "the oldest observations are pruned");
  const aged = withCodexModelUnsupported(
    emptyCodexAccountModelsStore(),
    "store-a",
    "model-old",
    1_000,
    1_000 + CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_AGE_MS + 1
  );
  assert.deepEqual(aged.unsupported["store-a"], {}, "an observation past the age bound is pruned");
});

test("codex account models: a stale cache keeps serving and refreshes in the background", async () => {
  clearAvailabilityKv();
  const staleStore = mergeCodexAccountCatalogs(emptyCodexAccountModelsStore(), [{ accountId: "cache-a", clientVersion: "0.160.0", slugs: ["other"] }], 1);
  setCodexAccountModelsStoreForTest(staleStore, Date.now());
  assert.equal(codexModelUnavailableAccounts(MODEL, ["cache-a"]).size, 0);
  assert.equal(getCodexAccountModelsCacheForTest().refreshing, false, "a fresh cache performs no KV read");

  writeKv(CODEX_ACCOUNT_MODELS_KV_KEY, {
    accounts: {
      "cache-a": { client_version: "0.160.0", slugs: ["other"], updated_at_ms: 1 },
      "cache-b": { client_version: "0.160.0", slugs: [MODEL], updated_at_ms: 1 },
    },
    unsupported: {},
  });
  setCodexAccountModelsStoreForTest(staleStore, Date.now() - CODEX_ACCOUNT_MODELS_CACHE_TTL_MS - 1);
  assert.equal(codexModelUnavailableAccounts(MODEL, ["cache-a"]).size, 0, "the stale snapshot serves the decision before the refresh lands");
  assert.equal(getCodexAccountModelsCacheForTest().refreshing, true, "an expired snapshot schedules one background read");
  await awaitCodexAccountModelsRefreshForTest();
  assert.equal(getCodexAccountModelsCacheForTest().refreshing, false);
  assert.equal(codexModelUnavailableAccounts(MODEL, ["cache-a", "cache-b"]).has("cache-a"), true, "the refreshed durable store replaces the stale snapshot");
});

test("codex account models: catalog absence counts only against a sibling's same client version", () => {
  clearAvailabilityKv();
  const differentVersion = {
    accounts: {
      "version-a": { client_version: "0.160.0", slugs: ["other"], updated_at_ms: 1 },
      "version-b": { client_version: "0.161.0", slugs: [MODEL], updated_at_ms: 1 },
    },
    unsupported: {},
  };
  setCodexAccountModelsStoreForTest(differentVersion, Date.now());
  assert.equal(
    codexModelUnavailableAccounts(MODEL, ["version-a", "version-b"]).size,
    0,
    "a version-specific absence is not authoritative against another version"
  );

  const sameVersion = {
    accounts: {
      "version-a": { client_version: "0.160.0", slugs: ["other"], updated_at_ms: 1 },
      "version-b": { client_version: "0.160.0", slugs: [MODEL], updated_at_ms: 1 },
    },
    unsupported: {},
  };
  setCodexAccountModelsStoreForTest(sameVersion, Date.now());
  assert.equal(codexModelUnavailableAccounts(MODEL, ["version-a", "version-b"]).get("version-a"), null);
  assert.equal(codexModelUnavailableAccounts(MODEL, ["version-a", "version-b"]).has("version-b"), false);
});

test("codex account models: a rejection older than the max age reads as unknown while a fresh one still skips", () => {
  clearAvailabilityKv();
  const nowMs = Date.now();
  // The aged account's catalog omits the model and no sibling lists it, so only
  // the learned rejection could ever skip it: expiry must age it back to unknown.
  // The fresh observation sits one second inside the bound, far more than the
  // read latency this synchronous assertion can accumulate.
  setCodexAccountModelsStoreForTest(
    {
      accounts: { "aged-a": { client_version: "0.160.0", slugs: ["other-model"], updated_at_ms: 1 } },
      unsupported: {
        "aged-a": { [MODEL]: nowMs - CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_AGE_MS - 1 },
        "fresh-b": { [MODEL]: nowMs - CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_AGE_MS + 1_000 },
      },
    },
    nowMs
  );
  const unavailable = codexModelUnavailableAccounts(MODEL, ["aged-a", "fresh-b"]);
  assert.equal(unavailable.has("aged-a"), false, "one millisecond past the max age is unknown availability again, never permanent");
  assert.equal(unavailable.get("fresh-b"), null, "one second inside the max age still skips");
});

test("codex account models: only current pool accounts are returned and only their catalogs are sibling evidence", async () => {
  clearAvailabilityKv();
  await recordCodexAccountCatalogs([
    { accountId: "pool-a", clientVersion: "0.160.0", slugs: ["other-model"] },
    { accountId: "removed-b", clientVersion: "0.160.0", slugs: [MODEL] },
  ]);
  assert.equal(
    codexModelUnavailableAccounts(MODEL, ["pool-a"]).has("pool-a"),
    false,
    "a removed account's catalog no longer turns a current account's omission into an exclusion"
  );
  assert.equal(codexModelUnavailableAccounts(MODEL, ["pool-a", "removed-b"]).get("pool-a"), null, "the same catalog still skips an in-pool sibling");

  await recordCodexModelUnsupported("removed-b", MODEL, { detail: UNSUPPORTED_DETAIL, nowMs: Date.now() });
  const currentPool = codexModelUnavailableAccounts(MODEL, ["pool-a"]);
  assert.equal(currentPool.size, 0, "an account outside the pool is never reported unavailable");
  assert.equal(codexModelUnavailableAccounts(MODEL, ["pool-a", "removed-b"]).get("removed-b"), UNSUPPORTED_DETAIL);
});

test("codex account models: a racing rejection write and catalog write both survive the versionstamp check", async () => {
  clearAvailabilityKv();
  const nowMs = Date.now();
  const raceCatalog = { client_version: "0.160.0", slugs: ["other-model"], updated_at_ms: 1 };
  await recordCodexAccountCatalogs([{ accountId: "race-a", clientVersion: "0.160.0", slugs: [MODEL] }]);
  // Another isolate commits its own merged catalog while this rejection write is
  // in flight: the read hands back the pre-race entry, so the first commit must
  // lose its versionstamp check before the writer retries against the fresh value.
  const raced = { reads: 0 };
  const raceKv = {
    ...(kvStub as unknown as Record<string, unknown>),
    get: (key: KvKey) => {
      const entry = entryFor(key);
      if (keyToString(key) === keyToString(CODEX_ACCOUNT_MODELS_KV_KEY)) {
        raced.reads += 1;
        if (raced.reads === 1) {
          writeKv([...CODEX_ACCOUNT_MODELS_KV_KEY], {
            accounts: {
              "race-a": { client_version: "0.160.0", slugs: [MODEL], updated_at_ms: 1 },
              "race-b": raceCatalog,
            },
            unsupported: {},
          });
        }
      }
      return Promise.resolve(entry);
    },
  } as unknown as Kv;

  await recordCodexModelUnsupported("race-c", MODEL, { detail: UNSUPPORTED_DETAIL, nowMs, kv: raceKv });
  assert.equal(raced.reads, 2, "the stale commit failed its versionstamp check and the writer retried");
  const stored = readKv(CODEX_ACCOUNT_MODELS_KV_KEY) as {
    accounts: Record<string, { client_version: string; slugs: string[]; updated_at_ms: number }>;
    unsupported: Record<string, Record<string, number>>;
  };
  assert.deepEqual(
    Object.keys(stored.accounts).sort((left, right) => left.localeCompare(right)),
    ["race-a", "race-b"],
    "no concurrent catalog row is discarded"
  );
  assert.deepEqual(stored.unsupported["race-c"], { [MODEL]: nowMs }, "the rejection survives the same merge");
  const cached = getCodexAccountModelsCacheForTest().store;
  assert.deepEqual(cached, stored, "the cache holds exactly the committed value");

  await recordCodexAccountCatalogs([{ accountId: "race-c", clientVersion: "0.160.0", slugs: [MODEL] }], raceKv);
  assert.equal(codexModelUnavailableAccounts(MODEL, ["race-a", "race-b", "race-c"]).has("race-c"), false, "a fresh catalog still clears the rejection");
  assert.equal((readKv(CODEX_ACCOUNT_MODELS_KV_KEY) as { unsupported: Record<string, unknown> }).unsupported["race-c"], undefined);
});

test("codex account models: a learned rejection merges on the fresh durable value, not a stale cache snapshot", async () => {
  clearAvailabilityKv();
  const nowMs = Date.now();
  setCodexAccountModelsStoreForTest(
    mergeCodexAccountCatalogs(emptyCodexAccountModelsStore(), [{ accountId: "stale-a", clientVersion: "0.160.0", slugs: ["other-model"] }], 1),
    nowMs
  );
  writeKv(CODEX_ACCOUNT_MODELS_KV_KEY, {
    accounts: { "durable-b": { client_version: "0.160.0", slugs: ["other-model"], updated_at_ms: 1 } },
    unsupported: {},
  });
  await recordCodexModelUnsupported("learn-c", MODEL, { detail: UNSUPPORTED_DETAIL, nowMs });

  const stored = readKv(CODEX_ACCOUNT_MODELS_KV_KEY) as {
    accounts: Record<string, unknown>;
    unsupported: Record<string, Record<string, number>>;
  };
  assert.deepEqual(Object.keys(stored.accounts), ["durable-b"], "the newer durable catalog is the merge base");
  assert.equal(stored.accounts["stale-a"], undefined, "the older cache snapshot is never written back");
  assert.deepEqual(stored.unsupported["learn-c"], { [MODEL]: nowMs });
  assert.deepEqual(Object.keys(getCodexAccountModelsCacheForTest().store?.accounts ?? {}), ["durable-b"], "the cache holds the committed value");
});

test("codex account models: an unavailable or unwritable KV keeps both writers best effort", async () => {
  clearAvailabilityKv();
  const nowMs = Date.now();
  await recordCodexModelUnsupported("nolocal-a", MODEL, { detail: UNSUPPORTED_DETAIL, nowMs, kv: null });
  assert.equal(codexModelUnavailableAccounts(MODEL, ["nolocal-a"]).get("nolocal-a"), UNSUPPORTED_DETAIL, "without KV the local hint still serves");
  assert.equal(readKv(CODEX_ACCOUNT_MODELS_KV_KEY), undefined, "no durable write without KV");

  const rejected = { check: () => rejected, set: () => rejected, commit: () => Promise.resolve({ ok: false } as const) };
  const rejectingKv = { ...(kvStub as unknown as Record<string, unknown>), atomic: () => rejected } as unknown as Kv;
  await recordCodexAccountCatalogs([{ accountId: "fail-a", clientVersion: "0.160.0", slugs: [MODEL] }], rejectingKv);
  await recordCodexModelUnsupported("fail-b", MODEL, { detail: UNSUPPORTED_DETAIL, nowMs, kv: rejectingKv });
  assert.equal(readKv(CODEX_ACCOUNT_MODELS_KV_KEY), undefined, "a commit that never succeeds writes nothing and throws nothing");
});

// ── B3: eligibility-aware routing ────────────────────────────────────────────

test("codex routing: an ineligible active account yields to an entitled sibling with reason model_unavailable", async () => {
  const accounts = [codexAccount("route-a"), codexAccount("route-b")];
  const poolVersionstamp = seedPool(accounts);
  await seedActiveRow(accounts[0], poolVersionstamp, 0, 1);
  clearAvailabilityKv();
  setCodexAccountModelsStoreForTest(
    {
      accounts: {
        "route-a": { client_version: "0.160.0", slugs: ["other-model"], updated_at_ms: 1 },
        "route-b": { client_version: "0.160.0", slugs: [MODEL], updated_at_ms: 1 },
      },
      unsupported: {},
    },
    Date.now()
  );

  const selection = await selectCodexRoutingAccountsStrong({ accounts, updated_at_ms: 1 }, accounts, Date.now(), MODEL);
  assert.equal(selection.kind, "eligible");
  assert.equal(selection.accounts[0].auth.account_id, "route-b", "the entitled sibling is selected");
  const active = parseCodexActiveAccountSelection(readKv(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY));
  assert.ok(active, "the election writes an active row");
  assert.equal(active.transition_reason, "model_unavailable");
  assert.equal(active.generation, 2, "an account change advances the active generation");
  assert.equal(active.account_id_hash, (await routingAccountIdentity(accounts[1])).accountIdHash);
});

test("codex routing: unknown availability never skips the active account", async () => {
  const accounts = [codexAccount("unknown-a"), codexAccount("unknown-b")];
  const poolVersionstamp = seedPool(accounts);
  await seedActiveRow(accounts[0], poolVersionstamp, 0, 1);
  clearAvailabilityKv();

  const selection = await selectCodexRoutingAccountsStrong({ accounts, updated_at_ms: 1 }, accounts, Date.now(), MODEL);
  assert.equal(selection.kind, "eligible");
  assert.equal(selection.accounts[0].auth.account_id, "unknown-a", "the durable active account stays");
  const active = parseCodexActiveAccountSelection(readKv(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY));
  assert.ok(active);
  assert.equal(active.transition_reason, null);
  assert.equal(active.generation, 1);
});

test("codex routing: no entitled account answers a graceful model_not_found without any fence", async () => {
  const accounts = [codexAccount("blocked-a"), codexAccount("blocked-b")];
  const poolVersionstamp = seedPool(accounts);
  await seedActiveRow(accounts[0], poolVersionstamp, 0, 1);
  clearAvailabilityKv();
  let store = emptyCodexAccountModelsStore();
  const nowMs = Date.now();
  store = withCodexModelUnsupported(store, "blocked-a", MODEL, nowMs);
  store = withCodexModelUnsupported(store, "blocked-b", MODEL, nowMs);
  setCodexAccountModelsStoreForTest(store, nowMs);

  const selection = await selectCodexRoutingAccountsStrong({ accounts, updated_at_ms: 1 }, accounts, Date.now(), MODEL);
  assert.equal(selection.kind, "model_unavailable");
  assert.equal(selection.model, MODEL);
  const response = initialCodexSelectionResponse(selection);
  assert.ok(response, "the selection is terminal");
  assert.equal(response.status, 404, "an unentitled model is never 429/503");
  const payload = (await response.json()) as { error: { code: string; message: string; type: string } };
  assert.equal(payload.error.code, "model_not_found");
  assert.equal(payload.error.type, "invalid_request_error");
  assert.equal(payload.error.message.includes(MODEL), true);
  const routing = readKv(CODEX_ACCOUNT_ROUTING_KV_KEY) as { slots: Record<string, unknown>[] } | undefined;
  for (const slot of routing?.slots ?? []) {
    assert.equal(slot.quota_blocked_until_ms, null, "no quota fence is written");
    assert.equal(slot.quota_block_source, null);
    assert.equal(slot.invalid_credential_version, null, "no credential is invalidated");
    assert.equal(slot.upstream_timeout_blocked_until_ms, null, "no upstream-timeout circuit is set");
  }
  const active = parseCodexActiveAccountSelection(readKv(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY));
  assert.equal(active?.generation, 1, "an account with no eligible sibling is not replaced");
});

// ── B4: learned fallback at dispatch ─────────────────────────────────────────

test("codex dispatch: only the exact model-not-supported detail is learned", async () => {
  assert.deepEqual(parseCodexModelUnsupportedDetail({ detail: UNSUPPORTED_DETAIL }), { model: MODEL, detail: UNSUPPORTED_DETAIL });
  assert.equal(parseCodexModelUnsupportedDetail({ detail: "Some other failure." }), null);
  assert.equal(parseCodexModelUnsupportedDetail({ detail: `${UNSUPPORTED_DETAIL} extra` }), null);
  assert.equal(parseCodexModelUnsupportedDetail({ detail: 7 }), null);
  assert.equal(parseCodexModelUnsupportedDetail("nope"), null);
  assert.equal(parseCodexModelUnsupportedDetail({ error: { detail: UNSUPPORTED_DETAIL } }), null);

  const matching = jsonResponse({ detail: UNSUPPORTED_DETAIL }, 400);
  assert.deepEqual(await codexModelUnsupportedFromResponse(matching), { model: MODEL, detail: UNSUPPORTED_DETAIL });
  assert.equal(await matching.text(), JSON.stringify({ detail: UNSUPPORTED_DETAIL }), "the caller's body is still readable");

  const other = jsonResponse({ detail: "Some other failure." }, 400);
  assert.equal(await codexModelUnsupportedFromResponse(other), null);
  assert.equal(await codexModelUnsupportedFromResponse(jsonResponse({ detail: UNSUPPORTED_DETAIL })), null, "a 200 is never learned");
  assert.equal(await codexModelUnsupportedFromResponse(new Response("not json", { status: 400 })), null);
});

test("codex dispatch: a learned rejection is attributed to the admitted account and writes no fence", async () => {
  const accounts = [codexAccount("learn-a"), codexAccount("learn-b")];
  const poolVersionstamp = seedPool(accounts);
  await seedActiveRow(accounts[0], poolVersionstamp, 0, 1);
  clearAvailabilityKv();
  kvStore.delete(keyToString([...CODEX_ACCOUNT_ROUTING_KV_KEY]));
  const identity = await routingAccountIdentity(accounts[0]);
  const response = jsonResponse({ detail: UNSUPPORTED_DETAIL }, 400);
  setCodexResponseAccountTelemetry(response, 1, accounts[0].account_id);
  setCodexResponseActiveTelemetry(response, {
    auth: accounts[0],
    slot: 0,
    accountIdHash: identity.accountIdHash,
    credentialVersion: identity.credentialVersion,
    quotaHeadroom: null,
    probeRequired: false,
    probeGeneration: null,
    probeToken: null,
    activeGeneration: 1,
  });

  const learned = await learnCodexModelUnavailable(response);
  assert.deepEqual(learned, { accountId: "learn-a", model: MODEL, detail: UNSUPPORTED_DETAIL });
  assert.equal(codexModelUnavailableAccounts(MODEL, ["learn-a", "learn-b"]).get("learn-a"), UNSUPPORTED_DETAIL);
  assert.equal(await response.text(), JSON.stringify({ detail: UNSUPPORTED_DETAIL }), "the original response is not consumed");
  assert.equal(readKv(CODEX_ACCOUNT_ROUTING_KV_KEY), undefined, "learning writes no routing fence");
  assert.equal(parseCodexActiveAccountSelection(readKv(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY))?.generation, 1, "learning does not move the election");
});

test("codex dispatch: the learned 400 retries exactly one sibling and returns its response", async () => {
  const unsupported = jsonResponse({ detail: UNSUPPORTED_DETAIL }, 400);
  const sibling = jsonResponse({ id: "served-by-sibling" });
  let dispatches = 0;
  let advances = 0;
  const response = await runCodexSerialAdmissionLoop({
    runPendingShortRetry: () => Promise.resolve(null),
    dispatchActive: () => {
      dispatches += 1;
      return Promise.resolve(dispatches === 1 ? unsupported : sibling);
    },
    terminalTransportResponse: () => Promise.resolve(null),
    hasQueuedRetry: () => false,
    reselectionRequested: () => false,
    advanceReselection: () => {
      advances += 1;
      return Promise.resolve(null);
    },
    exhaustedResponse: () => Promise.resolve(new Response("exhausted", { status: 503 })),
    classifyModelUnavailable: async (candidate) => {
      const parsed = await codexModelUnsupportedFromResponse(candidate);
      return parsed === null ? null : { accountId: "loop-a", model: parsed.model, detail: parsed.detail };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), JSON.stringify({ id: "served-by-sibling" }));
  assert.equal(dispatches, 2, "one sibling attempt, no more");
  assert.equal(advances, 1, "exactly one reselection");
});

test("codex dispatch: a generic 429 short retry classifies its unsupported 400 and retries one sibling", async () => {
  const unsupported = jsonResponse({ detail: UNSUPPORTED_DETAIL }, 400);
  const sibling = jsonResponse({ id: "served-by-sibling" });
  let dispatches = 0;
  let advances = 0;
  let pendingRetry = false;
  let retries = 0;
  const response = await runCodexSerialAdmissionLoop({
    runPendingShortRetry: () => {
      if (!pendingRetry) return Promise.resolve(null);
      pendingRetry = false;
      retries += 1;
      return Promise.resolve(unsupported);
    },
    dispatchActive: () => {
      dispatches += 1;
      if (dispatches === 1) {
        pendingRetry = true;
        return Promise.resolve(null);
      }
      return Promise.resolve(sibling);
    },
    terminalTransportResponse: () => Promise.resolve(null),
    hasQueuedRetry: () => pendingRetry,
    reselectionRequested: () => false,
    advanceReselection: () => {
      advances += 1;
      return Promise.resolve(null);
    },
    exhaustedResponse: () => Promise.resolve(new Response("exhausted", { status: 503 })),
    classifyModelUnavailable: async (candidate) => {
      const parsed = await codexModelUnsupportedFromResponse(candidate);
      return parsed === null ? null : { accountId: "loop-a", model: parsed.model, detail: parsed.detail };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), JSON.stringify({ id: "served-by-sibling" }));
  assert.equal(retries, 1, "the queued 429 retry runs once");
  assert.equal(dispatches, 2, "the initial 429 and one sibling attempt are bounded");
  assert.equal(advances, 1, "the unsupported retry response triggers one reselection");
});

test("codex dispatch: a failing sibling returns the graceful 404 with a bounded attempt count", async () => {
  const unsupported = jsonResponse({ detail: UNSUPPORTED_DETAIL }, 400);
  let dispatches = 0;
  let advances = 0;
  const response = await runCodexSerialAdmissionLoop({
    runPendingShortRetry: () => Promise.resolve(null),
    dispatchActive: () => {
      dispatches += 1;
      return Promise.resolve(unsupported);
    },
    terminalTransportResponse: () => Promise.resolve(null),
    hasQueuedRetry: () => false,
    reselectionRequested: () => false,
    advanceReselection: () => {
      advances += 1;
      return Promise.resolve(null);
    },
    exhaustedResponse: () => Promise.resolve(new Response("exhausted", { status: 503 })),
    classifyModelUnavailable: async (candidate) => {
      const parsed = await codexModelUnsupportedFromResponse(candidate);
      return parsed === null ? null : { accountId: "loop-a", model: parsed.model, detail: parsed.detail };
    },
  });
  assert.equal(response.status, 404);
  const payload = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, "model_not_found");
  assert.equal(payload.error.message.includes(MODEL), true, "the model is named");
  assert.equal(payload.error.message.includes(UNSUPPORTED_DETAIL), true, "the upstream detail is included");
  assert.equal(dispatches, 2, "the sibling attempt is bounded to exactly one");
  assert.equal(advances, 1);
});

test("codex dispatch: every other 400 passes through byte-for-byte with no state change", async () => {
  const other = jsonResponse({ detail: "A different upstream failure." }, 400);
  let dispatches = 0;
  let advances = 0;
  const response = await runCodexSerialAdmissionLoop({
    runPendingShortRetry: () => Promise.resolve(null),
    dispatchActive: () => {
      dispatches += 1;
      return Promise.resolve(other);
    },
    terminalTransportResponse: () => Promise.resolve(null),
    hasQueuedRetry: () => false,
    reselectionRequested: () => false,
    advanceReselection: () => {
      advances += 1;
      return Promise.resolve(null);
    },
    exhaustedResponse: () => Promise.resolve(new Response("exhausted", { status: 503 })),
    classifyModelUnavailable: async (candidate) => {
      const parsed = await codexModelUnsupportedFromResponse(candidate);
      return parsed === null ? null : { accountId: "loop-a", model: parsed.model, detail: parsed.detail };
    },
  });
  assert.equal(response, other, "the exact response object is returned");
  assert.equal(response.status, 400);
  assert.equal(await response.text(), JSON.stringify({ detail: "A different upstream failure." }));
  assert.equal(dispatches, 1);
  assert.equal(advances, 0, "no reselection and no state write");
});
