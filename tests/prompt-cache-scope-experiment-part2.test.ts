import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { Kv } from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/prompt-cache-scope-experiment-harness.ts";
// Suite part: tests moved out of the original file.

import assert from "node:assert/strict";
import {
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_MODELS_KV_KEY,
  MODEL,
  RUNTIME_CONFIG_V2_KEY,
  authPoolVersionstamp,
  cacheControls,
  encodeKey,
  fetchInputUrl,
  kv,
  leaseKey,
  makeAuth,
  promoteCodexPromptCacheScope,
  promotionBinding,
  resetCodexAuthCacheForTest,
  resetRuntimeConfigCacheForTest,
  runExperiment,
  seed,
  sseCompleted,
} from "./helpers/prompt-cache-scope-experiment-harness.ts";

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("a catalog client-version drift stops before the next paid sample", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  const snapshot = kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)) as {
    source: string;
    client_version: string;
    updated_at_ms: number;
    models: Record<string, unknown>[];
  };
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = fetchInputUrl(input);
    if (url === "https://auth.openai.com/oauth/token") {
      throw new Error("client-version drift must stop before credential refresh");
    }
    inferenceCalls += 1;
    if (inferenceCalls === 1) {
      kv.put(CODEX_MODELS_KV_KEY, { ...snapshot, client_version: "0.202.0", updated_at_ms: Date.now() });
    }
    return Promise.resolve(sseCompleted(0, 2_560));
  });

  try {
    const result = await runExperiment();
    assert.equal(result.status, "inconclusive");
    assert.equal(result.inconclusive_reason, "target_catalog_drift");
    assert.equal(inferenceCalls, 1);
    assert.equal(JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY))).includes('"scope"'), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("scope promotion rejects unknown dimensions and a renamed target model without mutating the catalog", async () => {
  seed();
  const lease = {
    key: leaseKey(MODEL),
    owner: "test-owner",
  };
  kv.put(lease.key, { owner: lease.owner, lease_until_ms: Date.now() + 60_000 });
  const common = {
    probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5" as const,
    effective_model: MODEL,
    reproducible_cycles: 3,
    source: "live_probe" as const,
    verified_at_ms: Date.now(),
  };
  const unknown = await promoteCodexPromptCacheScope(kv as unknown as Kv, {
    model: MODEL,
    lease,
    authPoolVersionstamp: await authPoolVersionstamp(),
    ...(await promotionBinding()),
    scope: {
      ...common,
      account_slots: "unknown",
      token_refresh: "preserved",
      conversation_id: "independent",
    },
  });
  assert.deepEqual(unknown, { status: "inconclusive", reason: "invalid_scope" });

  const snapshot = kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)) as {
    source: string;
    client_version: string;
    updated_at_ms: number;
  };
  kv.put(CODEX_MODELS_KV_KEY, { ...snapshot, models: [{ slug: `${MODEL}-renamed` }] });
  const renamed = await promoteCodexPromptCacheScope(kv as unknown as Kv, {
    model: MODEL,
    lease,
    authPoolVersionstamp: await authPoolVersionstamp(),
    ...(await promotionBinding()),
    scope: {
      ...common,
      account_slots: "account_scoped",
      token_refresh: "preserved",
      conversation_id: "independent",
    },
  });
  assert.deepEqual(renamed, { status: "inconclusive", reason: "model_drift" });
  assert.equal(JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY))).includes('"scope"'), false);
});

test("scope promotion publishes a non-default target and preserves the runtime default", async () => {
  seed();
  const alternateModel = `${MODEL}-alternate`;
  const initialSnapshot = kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)) as {
    source: string;
    client_version: string;
    updated_at_ms: number;
    models: {
      slug: string;
      supported_reasoning_levels: string[];
      prompt_cache?: unknown;
    }[];
  };
  const snapshotWithAlternate = {
    ...initialSnapshot,
    models: [
      ...initialSnapshot.models,
      {
        slug: alternateModel,
        supported_reasoning_levels: ["none"],
        prompt_cache: { version: 1, providers: [{ id: "codex_chatgpt", controls: cacheControls }] },
      },
    ],
  };
  kv.put(CODEX_MODELS_KV_KEY, snapshotWithAlternate);

  const initialRuntime = kv.values.get(encodeKey(RUNTIME_CONFIG_V2_KEY)) as {
    version: number;
    default_model: string;
    default_reasoning_effort: string;
    codex_models: unknown;
    updated_at_ms: number;
  };
  const runtimeBeforeSwitch = {
    ...initialRuntime,
    codex_models: snapshotWithAlternate,
    updated_at_ms: Date.now(),
  };
  kv.put(RUNTIME_CONFIG_V2_KEY, runtimeBeforeSwitch);
  const runtimeAfterSwitch = {
    ...runtimeBeforeSwitch,
    default_model: alternateModel,
    updated_at_ms: Date.now(),
  };
  kv.put(RUNTIME_CONFIG_V2_KEY, runtimeAfterSwitch);

  const lease = { key: leaseKey(MODEL), owner: "runtime-switch-owner" };
  kv.put(lease.key, { owner: lease.owner, lease_until_ms: Date.now() + 60_000 });
  const snapshotBeforePromotion = JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)));
  const runtimeBeforePromotion = JSON.stringify(kv.values.get(encodeKey(RUNTIME_CONFIG_V2_KEY)));

  const result = await promoteCodexPromptCacheScope(kv as unknown as Kv, {
    model: MODEL,
    lease,
    authPoolVersionstamp: await authPoolVersionstamp(),
    ...(await promotionBinding()),
    scope: {
      probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
      account_slots: "account_scoped",
      token_refresh: "preserved",
      conversation_id: "independent",
      effective_model: MODEL,
      reproducible_cycles: 3,
      source: "live_probe",
      verified_at_ms: Date.now(),
    },
  });

  assert.deepEqual(result, { status: "promoted" });
  const publishedSnapshot = kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)) as {
    models?: {
      slug?: unknown;
      prompt_cache?: { providers?: { id?: unknown; scope?: unknown }[] };
    }[];
  };
  const publishedProvider = publishedSnapshot.models
    ?.find((model) => model.slug === MODEL)
    ?.prompt_cache?.providers?.find((provider) => provider.id === "codex_chatgpt");
  assert.ok(publishedProvider?.scope);
  const publishedRuntime = kv.values.get(encodeKey(RUNTIME_CONFIG_V2_KEY)) as { default_model?: unknown };
  assert.equal(publishedRuntime.default_model, alternateModel);
  assert.notEqual(JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY))), snapshotBeforePromotion);
  assert.notEqual(JSON.stringify(kv.values.get(encodeKey(RUNTIME_CONFIG_V2_KEY))), runtimeBeforePromotion);
  assert.equal(snapshotBeforePromotion.includes('"scope"'), false);
});

test("successful scope promotion atomically extends its same-owner lease", async () => {
  seed();
  const lease = { key: leaseKey(MODEL), owner: "promotion-handoff-owner" };
  const beforePromotionMs = Date.now();
  const nearExpiryMs = beforePromotionMs + 1_000;
  kv.put(lease.key, { owner: lease.owner, lease_until_ms: nearExpiryMs });

  const result = await promoteCodexPromptCacheScope(kv as unknown as Kv, {
    model: MODEL,
    lease,
    authPoolVersionstamp: await authPoolVersionstamp(),
    ...(await promotionBinding()),
    scope: {
      probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
      account_slots: "account_scoped",
      token_refresh: "preserved",
      conversation_id: "independent",
      effective_model: MODEL,
      reproducible_cycles: 3,
      source: "live_probe",
      verified_at_ms: Date.now(),
    },
  });

  assert.deepEqual(result, { status: "promoted" });
  const renewedLease = kv.values.get(encodeKey(lease.key)) as
    | {
        owner?: unknown;
        lease_until_ms?: unknown;
      }
    | undefined;
  assert.equal(renewedLease?.owner, lease.owner);
  const renewedUntilMs = renewedLease.lease_until_ms;
  if (typeof renewedUntilMs !== "number") throw new Error("successful promotion did not retain its lease");
  assert.equal(renewedUntilMs >= beforePromotionMs + 90_000, true);
  assert.equal(renewedUntilMs > nearExpiryMs, true);
});

test("scope promotion fences auth-pool drift before catalog publication", async () => {
  seed();
  const expectedAuthPoolVersionstamp = await authPoolVersionstamp();
  const lease = { key: leaseKey(MODEL), owner: "auth-pool-fence-owner" };
  kv.put(lease.key, { owner: lease.owner, lease_until_ms: Date.now() + 60_000 });
  const snapshotBeforePromotion = JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)));
  const runtimeBeforePromotion = JSON.stringify(kv.values.get(encodeKey(RUNTIME_CONFIG_V2_KEY)));
  const pool = kv.values.get(encodeKey(CODEX_AUTH_POOL_KV_KEY)) as
    | {
        accounts: ReturnType<typeof makeAuth>[];
        updated_at_ms: number;
      }
    | undefined;
  const first = pool?.accounts[0];
  const second = pool?.accounts[1];
  if (!pool || !first || !second) throw new Error("missing seeded Codex auth pool");
  kv.put(CODEX_AUTH_POOL_KV_KEY, {
    ...pool,
    accounts: [
      {
        ...first,
        access_token: "rotated-before-promotion-access",
        refresh_token: "rotated-before-promotion-refresh",
        updated_at_ms: Date.now(),
      },
      second,
    ],
    updated_at_ms: Date.now(),
  });

  const result = await promoteCodexPromptCacheScope(kv as unknown as Kv, {
    model: MODEL,
    lease,
    authPoolVersionstamp: expectedAuthPoolVersionstamp,
    ...(await promotionBinding()),
    scope: {
      probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
      account_slots: "account_scoped",
      token_refresh: "preserved",
      conversation_id: "independent",
      effective_model: MODEL,
      reproducible_cycles: 3,
      source: "live_probe",
      verified_at_ms: Date.now(),
    },
  });

  assert.deepEqual(result, { status: "inconclusive", reason: "auth_pool_drift" });
  assert.equal(JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY))), snapshotBeforePromotion);
  assert.equal(JSON.stringify(kv.values.get(encodeKey(RUNTIME_CONFIG_V2_KEY))), runtimeBeforePromotion);
});
