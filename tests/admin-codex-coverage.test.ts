import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { Kv } from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/admin-auth-harness.ts";
// Coverage suite for the admin Codex handlers: routing diagnostics, catalog, whitelist,
// provider selection, Codex auth upload validation, and their KV-unavailable paths.

import assert from "node:assert/strict";
import {
  authPayload,
  handleAdminCodexAuth,
  handleAdminCodexModelsGet,
  handleAdminCodexModelsSet,
  keyToString,
  kvStore,
  kvStub,
  resetCodexAuthCacheForTest,
  setAtomicCommitsToFail,
  urlOf,
} from "./helpers/admin-auth-harness.ts";
import {
  handleAdminCodexBankedResetShadowDecisions,
  handleAdminCodexCacheScopeExperiment,
  handleAdminCodexCacheScopeExperimentTelemetryBaseline,
  handleAdminCodexModelsWhitelistGet,
  handleAdminCodexModelsWhitelistSet,
  handleAdminCodexPromptsPurge,
  handleAdminCodexRecheck,
  handleAdminDebugRouting,
  handleAdminModelsCatalogGet,
  handleAdminModelsRefresh,
  handleAdminProviderSelectionGet,
  handleAdminProviderSelectionSet,
  handleAdminPromptCacheAnalytics,
} from "../src/admin/codex.ts";
import { resetDebugRoutingCacheForTest } from "../src/debug-routing.ts";
import { setKvForTest } from "../src/kv.ts";
import type { PromptCacheAnalyticsView } from "../src/cache/prompt-analytics.ts";
import { fetchSurplusModels, resetSurplusModelsCacheForTest } from "../src/provider/surplus.ts";

type ErrorFields = Readonly<{ message?: string; code?: string; type?: string; param?: string | null }>;
type Json = Record<string, unknown>;

/** The error envelope of a failed response; missing fields stay undefined so assertions stay strict. */
const payloadOf = async (response: Response): Promise<ErrorFields> => {
  const payload = (await response.json()) as { error?: ErrorFields };
  return payload.error ?? {};
};
const bodyOf = async (response: Response): Promise<Json> => (await response.json()) as Json;

const postJson = (path: string, body: string | Json, method = "POST"): Request =>
  new Request(`https://ai.ubq.fi${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const baseKv = kvStub as unknown as Record<string, unknown>;
const delegateKv = (overrides: Json): Kv => ({ ...baseKv, ...overrides }) as unknown as Kv;

const throwingSetKv = (message: string): Kv =>
  delegateKv({
    set: () => {
      throw new Error(message);
    },
  });

const refusingSetKv = (): Kv => delegateKv({ set: () => Promise.resolve({ ok: false }) });

const throwingCommitKv = (message: string): Kv =>
  delegateKv({
    atomic: () => {
      const chain = {
        check: () => chain,
        set: () => chain,
        delete: () => chain,
        commit: () => {
          throw new Error(message);
        },
      };
      return chain;
    },
  });

const throwingListKv = (message: string): Kv =>
  delegateKv({
    list: () => {
      throw new Error(message);
    },
  });

const withKv = async <T>(kv: Kv, fn: () => Promise<T>): Promise<T> => {
  setKvForTest(kv);
  try {
    return await fn();
  } finally {
    setKvForTest(kvStub);
  }
};

/** An explicit unavailable fixture prevents getKv() from opening a disk database. */
const withDeniedKv = async <T>(fn: () => Promise<T>): Promise<T> => {
  setKvForTest(null);
  try {
    return await fn();
  } finally {
    setKvForTest(kvStub);
  }
};

const withFetch = async <T>(responder: (url: string) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => Promise.resolve(responder(urlOf(input))));
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const catalogFixture = (): { models: Json[]; sources: Json } => ({
  models: [
    { id: "gpt-5.6-sol", providers: [{ id: "codex", owned_by: "openai", supported_endpoints: ["/v1/responses"] }] },
    { id: "kimi-k2", providers: [{ id: "surplus", owned_by: "moonshot", supported_endpoints: ["/v1/chat/completions"] }] },
  ],
  sources: {
    codex: { status: "available", count: 1, updated_at_ms: 1 },
    surplus: { status: "available", count: 1, updated_at_ms: 2, configured: true },
    openlux: { status: "unavailable", count: 0, updated_at_ms: null },
  },
});

const analyticsView = (groupBy: PromptCacheAnalyticsView["group_by"]): PromptCacheAnalyticsView => ({
  status: "ready",
  bucket_ms: 60_000,
  window_start_at_ms: 0,
  window_end_at_ms: 60_000,
  group_by: groupBy,
  max_buckets: 10,
  cardinality_limited: false,
  truncated: false,
  buckets: [],
});

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("admin debug routing reads, clears and validates the scenario override", async () => {
  kvStore.clear();
  resetDebugRoutingCacheForTest();

  const initial = await handleAdminDebugRouting(new Request("https://ai.ubq.fi/admin/debug/routing"));
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.equal(((await bodyOf(initial)).routing as Json).scenario, "normal");

  const invalidJson = await handleAdminDebugRouting(postJson("/admin/debug/routing", "{"));
  assert.equal(invalidJson.status, 400);
  assert.equal((await payloadOf(invalidJson)).message, "Invalid JSON body");

  const missingScenario = await handleAdminDebugRouting(postJson("/admin/debug/routing", {}));
  assert.equal(missingScenario.status, 400);
  assert.equal((await payloadOf(missingScenario)).param, "scenario");

  for (const duration of [1.5, 3_600_001, -1]) {
    const response = await handleAdminDebugRouting(postJson("/admin/debug/routing", { scenario: "codex_429", duration_ms: duration }));
    assert.equal(response.status, 400);
    const payload = await payloadOf(response);
    assert.equal(payload.message, "duration_ms must be between 0 and 3600000");
    assert.equal(payload.param, "duration_ms");
  }

  const applied = await handleAdminDebugRouting(postJson("/admin/debug/routing", { scenario: "codex_429", duration_ms: 60_000 }));
  assert.equal(applied.status, 200);
  assert.equal(((await bodyOf(applied)).routing as Json).scenario, "codex_429");

  const unknown = await handleAdminDebugRouting(postJson("/admin/debug/routing", { scenario: "made_up" }));
  assert.equal(unknown.status, 400);
  assert.equal((await payloadOf(unknown)).message, "Unknown debug routing scenario");

  const cleared = await handleAdminDebugRouting(new Request("https://ai.ubq.fi/admin/debug/routing", { method: "DELETE" }));
  assert.equal(cleared.status, 200);
  assert.equal(((await bodyOf(cleared)).routing as Json).scenario, "normal");
  resetDebugRoutingCacheForTest();
});

test("admin codex recheck rejects unknown and unconfigured account slots", async () => {
  kvStore.clear();
  for (const slot of [0, 3, -1, 1.5]) {
    const response = await handleAdminCodexRecheck(slot);
    assert.equal(response.status, 404);
    assert.equal((await payloadOf(response)).message, "Codex account slot not found");
  }

  const unconfigured = await handleAdminCodexRecheck(1);
  assert.equal(unconfigured.status, 404);
  assert.equal((await payloadOf(unconfigured)).message, "Codex account slot is not configured");
});

test("admin banked-reset shadow decisions serve the ledger and fail closed", async () => {
  kvStore.clear();
  const empty = await handleAdminCodexBankedResetShadowDecisions();
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("cache-control"), "no-store");
  assert.deepEqual(await empty.json(), { decisions: [] });

  const failing = await withKv(throwingListKv("shadow ledger unavailable"), () => handleAdminCodexBankedResetShadowDecisions());
  assert.equal(failing.status, 503);
  assert.equal(failing.headers.get("cache-control"), "no-store");
  const payload = await payloadOf(failing);
  assert.equal(payload.code, "codex_banked_reset_shadow_unavailable");
  assert.equal(payload.type, "server_error");
});

test("admin prompt-cache scope experiment rejects request fields", async () => {
  const withFields = await handleAdminCodexCacheScopeExperiment(postJson("/admin/codex/prompt-cache-scope-experiment", { model: "gpt-5.6" }));
  assert.equal(withFields.status, 400);
  assert.equal((await payloadOf(withFields)).message, "Prompt-cache scope experiment does not accept request fields");
});

test("admin prompt-cache telemetry baseline projects the reader result and fails closed", async () => {
  const response = await handleAdminCodexCacheScopeExperimentTelemetryBaseline(() =>
    Promise.resolve({
      status: "ready",
      reason: null,
      release: "release-1",
      provider: "codex",
      aggregate: { sample_count: 3 },
      routes: [{ route: "/v1/responses" }],
    } as unknown as Awaited<ReturnType<typeof import("../src/cache/scope-experiment.ts").readPromptCacheScopeExperimentTelemetryBaseline>>)
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "ready",
    reason: null,
    release: "release-1",
    provider: "codex",
    aggregate: { sample_count: 3 },
    routes: [{ route: "/v1/responses" }],
  });

  const failing = await handleAdminCodexCacheScopeExperimentTelemetryBaseline(() => Promise.reject(new Error("kv unavailable")));
  assert.equal(failing.status, 503);
  assert.equal(failing.headers.get("cache-control"), "no-store");
  const payload = await payloadOf(failing);
  assert.equal(payload.code, "prompt_cache_scope_experiment_unavailable");
  assert.equal(payload.message, "Prompt-cache Stage 0 telemetry baseline could not be read.");

  const unavailableKv = await withDeniedKv(() => handleAdminCodexCacheScopeExperimentTelemetryBaseline());
  assert.equal(unavailableKv.status, 503);
  assert.equal((await payloadOf(unavailableKv)).code, "prompt_cache_scope_experiment_unavailable");
});

test("admin prompt-cache analytics validates group_by and reports reader failures", async () => {
  const cases: readonly (readonly [string, string])[] = [
    ["https://ai.ubq.fi/admin/prompt-cache/analytics?model=gpt-5.6", "Only group_by is supported for prompt-cache analytics"],
    ["https://ai.ubq.fi/admin/prompt-cache/analytics?group_by=provider&group_by=model", "group_by may appear only once"],
    [
      "https://ai.ubq.fi/admin/prompt-cache/analytics?group_by=provider,provider",
      "group_by must contain up to two distinct values from provider, model, route, key_presence, mode, or fallback",
    ],
    [
      "https://ai.ubq.fi/admin/prompt-cache/analytics?group_by=secret",
      "group_by must contain up to two distinct values from provider, model, route, key_presence, mode, or fallback",
    ],
  ];
  for (const [url, message] of cases) {
    const response = await handleAdminPromptCacheAnalytics(new Request(url));
    assert.equal(response.status, 400, url);
    assert.equal((await payloadOf(response)).message, message);
  }

  const seen: Json[] = [];
  const ready = await handleAdminPromptCacheAnalytics(new Request("https://ai.ubq.fi/admin/prompt-cache/analytics?group_by=provider,model"), (options) => {
    seen.push(options as unknown as Json);
    return Promise.resolve(analyticsView(options.groupBy ?? []));
  });
  assert.equal(ready.status, 200);
  assert.equal(ready.headers.get("cache-control"), "no-store");
  assert.deepEqual(seen, [{ groupBy: ["provider", "model"] }]);
  assert.deepEqual((await bodyOf(ready)).group_by, ["provider", "model"]);

  const failing = await handleAdminPromptCacheAnalytics(new Request("https://ai.ubq.fi/admin/prompt-cache/analytics"), () =>
    Promise.reject(new Error("analytics unavailable"))
  );
  assert.equal(failing.status, 503);
  assert.equal((await payloadOf(failing)).code, "prompt_cache_analytics_unavailable");
});

test("admin codex auth rejects bodies that are not an auth.json and an unavailable KV", async () => {
  kvStore.clear();
  const notAuthJson = await handleAdminCodexAuth(postJson("/admin/codex/auth", {}));
  assert.equal(notAuthJson.status, 400);
  assert.equal((await payloadOf(notAuthJson)).message, "Body does not look like a Codex auth.json");

  const noKv = await withDeniedKv(() => handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload })));
  assert.equal(noKv.status, 500);
  assert.equal((await payloadOf(noKv)).message, "Deno KV is not available; cannot persist Codex auth");
});

test("admin codex auth maps upstream rejection and unreachable upstreams onto errors", async () => {
  kvStore.clear();
  const rejected = await withFetch(
    () => new Response('{"statusCode":401,"description":"Unauthorized"}', { status: 401, headers: { "Content-Type": "application/json" } }),
    () => handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload }))
  );
  assert.equal(rejected.status, 401);
  const rejectedPayload = await payloadOf(rejected);
  assert.equal(rejectedPayload.code, "invalid_api_key");
  assert.match(rejectedPayload.message ?? "", /Invalid Codex auth\.json \(upstream 401\)/);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), false);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.reject(new Error("upstream is unreachable")));
  try {
    const unreachable = await handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload }));
    assert.equal(unreachable.status, 502);
    const unreachablePayload = await payloadOf(unreachable);
    assert.equal(unreachablePayload.code, "codex_upstream_unreachable");
    assert.equal(unreachablePayload.type, "invalid_request_error");
    assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin codex auth requires an existing catalog for a rate-limited upload", async () => {
  kvStore.clear();
  const response = await withFetch(
    () => new Response('{"statusCode":429,"description":"Too Many Requests"}', { status: 429, headers: { "Content-Type": "application/json" } }),
    () => handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload }))
  );
  assert.equal(response.status, 409);
  const payload = await payloadOf(response);
  assert.equal(payload.code, "codex_catalog_required");
  assert.match(payload.message ?? "", /without an existing model catalog/);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), false);
});

test("admin codex auth keeps the stored catalog for a rate-limited upload", async () => {
  kvStore.clear();
  kvStore.set(keyToString(["ubq_ai", "codex_models"]), {
    source: "chatgpt_codex",
    updated_at_ms: 777,
    models: [{ slug: "gpt-5.6", display_name: "GPT-5.6" }],
  });
  const response = await withFetch(
    () => new Response('{"statusCode":429,"description":"Too Many Requests"}', { status: 429, headers: { "Content-Type": "application/json" } }),
    () => handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload }))
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
  const payload = (await response.json()) as Json;
  assert.equal(payload.upstream_status, 429);
  assert.equal(payload.normalized_snapshot_updated, false);
  assert.equal(payload.catalog_seeded, false);
  const models = payload.models as Json;
  assert.equal(models.count, 1);
  assert.equal(models.client_version, null);
  assert.equal(payload.account_count, 1);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), true);
});

test("admin codex auth rejects an empty and an oversized upstream catalog", async () => {
  kvStore.clear();
  const empty = await withFetch(
    () => new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    () => handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload, models: { client_version: "0.126.0" } }))
  );
  assert.equal(empty.status, 502);
  assert.equal((await payloadOf(empty)).message, "Codex upstream models response did not include a non-empty model catalog");
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), false);

  const oversizedModels = Array.from({ length: 600 }, (_, index) => ({
    slug: `gpt-5-oversized-${String(index).padStart(4, "0")}`,
    display_name: `GPT-5 Oversized ${index}`,
    description: "x".repeat(400),
  }));
  const oversized = await withFetch(
    () => new Response(JSON.stringify({ models: oversizedModels }), { status: 200, headers: { "Content-Type": "application/json" } }),
    () => handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload, models: { client_version: "0.126.0" } }))
  );
  assert.equal(oversized.status, 413);
  assert.match((await payloadOf(oversized)).message ?? "", /^models snapshot too large \(\d+ bytes; max 65536\)\.$/);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), false);
});

test("admin codex auth stores the upstream catalog and reports catalog seeding", async () => {
  kvStore.clear();
  const response = await withFetch(
    () =>
      new Response(JSON.stringify({ models: [{ slug: "gpt-5.3-codex-spark", display_name: "Spark" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: "etag-1" },
      }),
    () => handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload, models: { client_version: "0.126.0" } }))
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Json;
  assert.equal(payload.stored, true);
  assert.equal(payload.refreshed, false);
  assert.equal(payload.normalized_snapshot_updated, true);
  assert.equal(payload.catalog_seeded, true);
  assert.equal(payload.upstream_content_type, "application/json");
  assert.equal(payload.models !== null, true);
  assert.equal((payload.models as Json).client_version, "0.126.0");
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_models"])), true);
  const accountIds = payload.account_ids as string[];
  assert.deepEqual(accountIds, ["acct"]);
});

test("admin codex auth reports a catalog seed failure without failing the upload", async () => {
  kvStore.clear();
  const response = await withKv(throwingSetKv("catalog store is unavailable"), () =>
    withFetch(
      () =>
        new Response(JSON.stringify({ models: [{ slug: "gpt-5.3-codex-spark", display_name: "Spark" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      () => handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload, models: { client_version: "0.126.0" } }))
    )
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Json;
  assert.equal(payload.catalog_seeded, false);
  assert.equal(payload.normalized_snapshot_updated, true);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), true);
});

test("admin codex models set validates, stores and reports persistence failures", async () => {
  kvStore.clear();
  const invalidJson = await handleAdminCodexModelsSet(postJson("/admin/codex/models", "{"));
  assert.equal(invalidJson.status, 400);
  assert.equal((await payloadOf(invalidJson)).message, "Invalid JSON body");

  const emptyCatalog = await handleAdminCodexModelsSet(postJson("/admin/codex/models", { models: [] }));
  assert.equal(emptyCatalog.status, 400);
  assert.equal((await payloadOf(emptyCatalog)).message, "models must include a non-empty models array");

  const stored = await handleAdminCodexModelsSet(
    postJson("/admin/codex/models", {
      source: "chatgpt_codex",
      client_version: "0.126.0",
      models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", supported_reasoning_levels: ["low", "high"] }],
    })
  );
  assert.equal(stored.status, 200);
  const storedPayload = await bodyOf(stored);
  assert.equal(storedPayload.ok, true);
  assert.equal(storedPayload.count, 1);
  assert.equal(storedPayload.source, "chatgpt_codex");
  assert.equal(storedPayload.client_version, "0.126.0");
  assert.equal(typeof storedPayload.updated_at_ms, "number");
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_models"])), true);

  const noKv = await withDeniedKv(() =>
    handleAdminCodexModelsSet(postJson("/admin/codex/models", { source: "chatgpt_codex", models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" }] }))
  );
  assert.equal(noKv.status, 500);
  assert.equal((await payloadOf(noKv)).message, "Deno KV is not available; cannot persist Codex models");

  await withKv(throwingCommitKv("models commit exploded"), async () => {
    await assert.rejects(
      handleAdminCodexModelsSet(postJson("/admin/codex/models", { source: "chatgpt_codex", models: [{ slug: "gpt-5.6-luna", display_name: "Luna" }] })),
      /models commit exploded/
    );
  });
});

test("admin codex models get serves the stored snapshot or a null payload", async () => {
  kvStore.clear();
  const empty = await handleAdminCodexModelsGet();
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { ok: true, data: null });

  kvStore.set(keyToString(["ubq_ai", "codex_models"]), {
    source: "chatgpt_codex",
    client_version: "0.126.0",
    updated_at_ms: 5,
    models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" }],
  });
  const stored = await handleAdminCodexModelsGet();
  assert.equal(stored.status, 200);
  const payload = (await stored.json()) as Json;
  const data = payload.data as Json;
  assert.equal(data.client_version, "0.126.0");
  assert.equal((data.models as Json[]).length, 1);
});

test("admin codex prompts purge deletes stored prompts and chunks", async () => {
  kvStore.clear();
  kvStore.set(keyToString(["uos_ai", "codex_instructions"]), { instructions: "top level" });
  kvStore.set(keyToString(["uos_ai", "codex_instructions_chunk", 0]), { chunk: "first" });
  kvStore.set(keyToString(["uos_ai", "codex_instructions_chunk", 1]), { chunk: "second" });

  const purged = await handleAdminCodexPromptsPurge();
  assert.equal(purged.status, 200);
  assert.deepEqual(await purged.json(), { deleted: 3 });
  assert.equal(kvStore.has(keyToString(["uos_ai", "codex_instructions"])), false);
  assert.equal(kvStore.has(keyToString(["uos_ai", "codex_instructions_chunk", 0])), false);
  assert.equal(kvStore.has(keyToString(["uos_ai", "codex_instructions_chunk", 1])), false);

  const again = await handleAdminCodexPromptsPurge();
  assert.deepEqual(await again.json(), { deleted: 0 });

  const noKv = await withDeniedKv(() => handleAdminCodexPromptsPurge());
  assert.equal(noKv.status, 500);
  assert.equal((await payloadOf(noKv)).message, "Deno KV is not available; cannot purge Codex prompts");
});

test("admin codex model whitelist reads, stores and reports KV outages", async () => {
  kvStore.clear();
  const empty = await handleAdminCodexModelsWhitelistGet();
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { ok: true, data: { model_ids: [], updated_at_ms: 0 } });

  const invalidJson = await handleAdminCodexModelsWhitelistSet(postJson("/admin/codex/models/whitelist", "{"));
  assert.equal(invalidJson.status, 400);
  assert.equal((await payloadOf(invalidJson)).message, "Invalid JSON body");

  const notArray = await handleAdminCodexModelsWhitelistSet(postJson("/admin/codex/models/whitelist", { model_ids: "gpt-5.6-sol" }));
  assert.equal(notArray.status, 400);
  assert.equal((await payloadOf(notArray)).message, "model_ids must be an array");

  const notStrings = await handleAdminCodexModelsWhitelistSet(postJson("/admin/codex/models/whitelist", { model_ids: [7] }));
  assert.equal(notStrings.status, 400);
  assert.equal((await payloadOf(notStrings)).message, "model_ids must contain only strings");

  const saved = await handleAdminCodexModelsWhitelistSet(
    postJson("/admin/codex/models/whitelist", { model_ids: ["gpt-5.6-sol", " gpt-5.6-luna ", "gpt-5.6-sol"] })
  );
  assert.equal(saved.status, 200);
  const savedPayload = await bodyOf(saved);
  assert.equal(savedPayload.stored, true);
  assert.deepEqual(savedPayload.model_ids, ["gpt-5.6-sol", "gpt-5.6-luna"]);
  assert.equal(typeof savedPayload.updated_at_ms, "number");

  const loaded = await handleAdminCodexModelsWhitelistGet();
  const loadedData = (await bodyOf(loaded)).data as Json;
  assert.deepEqual(loadedData.model_ids, ["gpt-5.6-sol", "gpt-5.6-luna"]);

  const [whitelistRead, whitelistWrite] = await withDeniedKv(
    async () =>
      [
        await handleAdminCodexModelsWhitelistGet(),
        await handleAdminCodexModelsWhitelistSet(postJson("/admin/codex/models/whitelist", { model_ids: [] })),
      ] as const
  );
  assert.equal(whitelistRead.status, 500);
  assert.equal((await payloadOf(whitelistRead)).message, "Deno KV is not available; cannot read model whitelist");
  assert.equal(whitelistWrite.status, 500);
  assert.equal((await payloadOf(whitelistWrite)).message, "Deno KV is not available; cannot store model whitelist");

  const refused = await withKv(refusingSetKv(), () =>
    handleAdminCodexModelsWhitelistSet(postJson("/admin/codex/models/whitelist", { model_ids: ["gpt-5.6-sol"] }))
  );
  assert.equal(refused.status, 500);
  assert.equal((await payloadOf(refused)).message, "Deno KV is not available; cannot persist model whitelist");
});

test("admin models catalog serves the picker view and reports KV outages", async () => {
  kvStore.clear();
  const unfiltered = await handleAdminModelsCatalogGet({ buildCatalog: () => Promise.resolve(catalogFixture() as never) });
  assert.equal(unfiltered.status, 200);
  assert.equal(unfiltered.headers.get("cache-control"), "no-store");
  const unfilteredPayload = (await bodyOf(unfiltered)).data as Json;
  assert.equal((unfilteredPayload.models as Json[]).length, 2);
  assert.equal(unfilteredPayload.filter_active, false);
  assert.deepEqual(unfilteredPayload.whitelist, { model_ids: [], updated_at_ms: 0 });

  kvStore.set(keyToString(["uos_ai", "codex_models_whitelist"]), { model_ids: ["gpt-5.6-sol"], updated_at_ms: 42 });
  const filtered = await handleAdminModelsCatalogGet({ buildCatalog: () => Promise.resolve(catalogFixture() as never) });
  const filteredPayload = (await bodyOf(filtered)).data as Json;
  assert.equal(filteredPayload.filter_active, true);
  assert.deepEqual(filteredPayload.whitelist, { model_ids: ["gpt-5.6-sol"], updated_at_ms: 42 });

  const noKv = await withDeniedKv(() => handleAdminModelsCatalogGet({ buildCatalog: () => Promise.resolve(catalogFixture() as never) }));
  assert.equal(noKv.status, 500);
  assert.equal((await payloadOf(noKv)).message, "Deno KV is not available; cannot read the model catalog");
});

test("admin models refresh reports every upstream refresh result", async () => {
  const failed = await handleAdminModelsRefresh({
    refreshEnrichment: () => Promise.resolve(null),
    refreshOpenlux: () => Promise.resolve({ models: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-luna" }], updated_at_ms: 9 } as never),
    refreshSurplus: () => Promise.resolve(null),
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  const failedPayload = (await bodyOf(failed)).data as Json;
  assert.deepEqual(failedPayload.openrouter, { upstream_models: 0, updated_at_ms: null, refreshed: false });
  assert.deepEqual(failedPayload.openlux, { models: 2, updated_at_ms: 9 });
  assert.deepEqual(failedPayload.surplus, { models: 0, updated_at_ms: null });

  const refreshed = await handleAdminModelsRefresh({
    refreshEnrichment: () => Promise.resolve({ models: [{ id: "a" }], updated_at_ms: 11 } as never),
    refreshOpenlux: () => Promise.resolve(null),
    refreshSurplus: () => Promise.resolve({ models: [{ id: "b" }], updated_at_ms: 12 } as never),
  });
  const refreshedPayload = (await bodyOf(refreshed)).data as Json;
  assert.deepEqual(refreshedPayload.openrouter, { upstream_models: 1, updated_at_ms: 11, refreshed: true });
  assert.deepEqual(refreshedPayload.surplus, { models: 1, updated_at_ms: 12 });
});

test("admin models refresh performs keyless Surplus discovery", async () => {
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
  resetSurplusModelsCacheForTest();
  let fetchCalls = 0;
  try {
    const response = await handleAdminModelsRefresh({
      refreshEnrichment: () => Promise.resolve(null),
      refreshOpenlux: () => Promise.resolve(null),
      refreshSurplus: (options) =>
        fetchSurplusModels({
          ...options,
          fetcher: () => {
            fetchCalls += 1;
            return Promise.resolve(Response.json({ data: [{ id: "surplus-test-model" }] }));
          },
        }),
      refreshClaude: () => Promise.resolve(null),
    });
    assert.equal(response.status, 200);
    assert.equal(fetchCalls, 1);
    const data = (await bodyOf(response)).data as Json;
    assert.equal((data.surplus as Json).models, 1);
  } finally {
    resetSurplusModelsCacheForTest();
    if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
  }
});

test("admin provider selection get serves the roster and reports an unavailable KV", async () => {
  kvStore.clear();
  const response = await handleAdminProviderSelectionGet({ buildCatalog: () => Promise.resolve(catalogFixture() as never) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = (await bodyOf(response)).data as Json;
  const providers = data.providers as Json[];
  const providerById = (id: string): Json => {
    const found = providers.find((provider) => provider.id === id);
    assert.ok(found, `provider ${id} missing from the roster`);
    return found;
  };
  assert.equal(providerById("codex").model_count, 1);
  assert.equal(providerById("surplus").model_count, 1);
  assert.equal(providerById("surplus").configured, true);
  assert.equal(providerById("openlux").status, "unavailable");
  assert.equal(providerById("openlux").configured, false);
  assert.equal(Array.isArray(providerById("codex").subscriptions), true);
  assert.equal("subscriptions" in providerById("surplus"), false);
  assert.equal(data.filter_active, false);
  assert.equal((data.tiers as Json[]).length > 0, true);

  const noKv = await withDeniedKv(() => handleAdminProviderSelectionGet({ buildCatalog: () => Promise.resolve(catalogFixture() as never) }));
  assert.equal(noKv.status, 500);
  assert.equal((await payloadOf(noKv)).message, "Deno KV is not available; cannot read the provider selection");
});

test("admin provider selection set validates input and reports storage outages", async () => {
  kvStore.clear();
  const noKv = await withDeniedKv(() => handleAdminProviderSelectionSet(postJson("/admin/provider-selection", { provider_ids: ["surplus"] })));
  assert.equal(noKv.status, 500);
  assert.equal((await payloadOf(noKv)).message, "Deno KV is not available; cannot store the provider selection");

  const invalidJson = await handleAdminProviderSelectionSet(postJson("/admin/provider-selection", "{"));
  assert.equal(invalidJson.status, 400);
  assert.equal((await payloadOf(invalidJson)).message, "Invalid JSON body");

  const notArray = await handleAdminProviderSelectionSet(postJson("/admin/provider-selection", { provider_ids: "surplus" }));
  assert.equal(notArray.status, 400);
  assert.equal((await payloadOf(notArray)).message, "provider_ids must be an array");

  const notStrings = await handleAdminProviderSelectionSet(postJson("/admin/provider-selection", { provider_ids: [1] }));
  assert.equal(notStrings.status, 400);
  assert.equal((await payloadOf(notStrings)).message, "provider_ids must contain only strings");

  const unknown = await handleAdminProviderSelectionSet(postJson("/admin/provider-selection", { provider_ids: ["surplus", "not-a-provider"] }));
  assert.equal(unknown.status, 400);
  const unknownPayload = await payloadOf(unknown);
  assert.match(unknownPayload.message ?? "", /unknown provider ids: not-a-provider/);
  assert.equal(unknownPayload.param, "provider_ids");

  const saved = await handleAdminProviderSelectionSet(postJson("/admin/provider-selection", { provider_ids: ["surplus", " deepseek "] }));
  assert.equal(saved.status, 200);
  const savedPayload = await bodyOf(saved);
  assert.equal(savedPayload.stored, true);
  assert.deepEqual(savedPayload.provider_ids, ["surplus", "deepseek"]);

  const failed = await withKv(throwingSetKv("selection store is unavailable"), () =>
    handleAdminProviderSelectionSet(postJson("/admin/provider-selection", { provider_ids: ["surplus"] }))
  );
  assert.equal(failed.status, 500);
  assert.equal((await payloadOf(failed)).message, "Deno KV is not available; cannot persist the provider selection");
});

test("admin codex auth rejects a third account in a full auth pool", async () => {
  kvStore.clear();
  const upload = (accountId: string) =>
    withFetch(
      () =>
        new Response(JSON.stringify({ models: [{ slug: `gpt-5-${accountId}`, display_name: "Roster model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      () =>
        handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: { tokens: { access_token: "access", refresh_token: "refresh", account_id: accountId } } }))
    );

  assert.equal((await upload("acct-a")).status, 200);
  assert.equal((await upload("acct-b")).status, 200);
  const full = await upload("acct-c");
  assert.equal(full.status, 409);
  assert.equal((await payloadOf(full)).code, "codex_auth_pool_full");
  const pool = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as { accounts?: { account_id?: string }[] };
  assert.deepEqual(
    pool.accounts?.map((account) => account.account_id),
    ["acct-a", "acct-b"]
  );
});

test("admin codex auth reports a KV pool commit that never settles", async () => {
  kvStore.clear();
  setAtomicCommitsToFail(3);
  try {
    const response = await withFetch(
      () =>
        new Response(JSON.stringify({ models: [{ slug: "gpt-5-retry", display_name: "Retry model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      () => handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload, models: { client_version: "0.126.0" } }))
    );
    assert.equal(response.status, 500);
    assert.equal((await payloadOf(response)).message, "Deno KV could not persist Codex auth and models");
    assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), false);
  } finally {
    setAtomicCommitsToFail(0);
  }
});

test("admin codex models set reports oversized payloads and an oversized runtime config", async () => {
  kvStore.clear();
  const oversizedModels = Array.from({ length: 600 }, (_, index) => ({
    slug: `gpt-5-set-oversized-${String(index).padStart(4, "0")}`,
    display_name: `Set Oversized ${index}`,
    description: "y".repeat(400),
  }));
  const tooLarge = await handleAdminCodexModelsSet(postJson("/admin/codex/models", { source: "chatgpt_codex", models: oversizedModels }));
  assert.equal(tooLarge.status, 413);
  assert.match((await payloadOf(tooLarge)).message ?? "", /^models snapshot too large \(\d+ bytes; max 65536\)\.$/);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_models"])), false);

  // A catalog that fits in KV can still produce a compact runtime record over the 4 KiB ceiling.
  const compactOverflow = await handleAdminCodexModelsSet(
    postJson("/admin/codex/models", {
      source: "chatgpt_codex",
      client_version: "0.126.0",
      models: Array.from({ length: 200 }, (_, index) => ({
        slug: `gpt-admin-runtime-${String(index).padStart(3, "0")}`,
        supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "ultra"],
      })),
    })
  );
  assert.equal(compactOverflow.status, 413);
  assert.equal((await payloadOf(compactOverflow)).code, "runtime_config_invalid");
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_models"])), false);

  const unstamped = await handleAdminCodexModelsSet(
    postJson("/admin/codex/models", { source: "chatgpt_codex", models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol" }] })
  );
  assert.equal(unstamped.status, 200);
  assert.equal((await bodyOf(unstamped)).client_version, null);
});

test("admin codex model whitelist rejects a payload over the KV byte ceiling", async () => {
  kvStore.clear();
  const tooLarge = await handleAdminCodexModelsWhitelistSet(
    postJson("/admin/codex/models/whitelist", {
      model_ids: Array.from({ length: 2_000 }, (_, index) => `gpt-${index}-${"z".repeat(48)}`),
    })
  );
  assert.equal(tooLarge.status, 413);
  assert.equal((await payloadOf(tooLarge)).message, "model_ids payload too large (max 65536 bytes).");
  assert.equal(kvStore.has(keyToString(["uos_ai", "codex_models_whitelist"])), false);
});

test("admin provider selection get lists configured Codex subscriptions", async () => {
  kvStore.clear();
  resetCodexAuthCacheForTest();
  kvStore.set(keyToString(["ubq_ai", "codex_auth"]), {
    accounts: [{ access_token: "not-a-jwt", refresh_token: "refresh", account_id: "acct-roster", updated_at_ms: Date.now() }],
    updated_at_ms: Date.now(),
  });

  const response = await handleAdminProviderSelectionGet({ buildCatalog: () => Promise.resolve(catalogFixture() as never) });
  assert.equal(response.status, 200);
  const data = (await bodyOf(response)).data as Json;
  const providers = data.providers as Json[];
  const codex = providers.find((provider) => provider.id === "codex");
  assert.ok(codex);
  const subscriptions = codex.subscriptions as Json[];
  assert.equal(subscriptions.length, 1);
  assert.equal(typeof subscriptions[0]?.id, "string");
  assert.equal(subscriptions[0]?.slot, 1);
  assert.equal(typeof subscriptions[0]?.label, "string");
});

test("admin codex auth reports a catalog too large for the compact runtime config", async () => {
  kvStore.clear();
  const models = Array.from({ length: 200 }, (_, index) => ({
    slug: `gpt-auth-runtime-${String(index).padStart(3, "0")}`,
    supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "ultra"],
  }));
  const response = await withFetch(
    () => new Response(JSON.stringify({ models }), { status: 200, headers: { "Content-Type": "application/json" } }),
    () => handleAdminCodexAuth(postJson("/admin/codex/auth", { auth: authPayload, models: { client_version: "0.126.0" } }))
  );
  assert.equal(response.status, 413);
  assert.equal((await payloadOf(response)).code, "runtime_config_invalid");
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), false);
});

test("admin models refresh keeps the last good snapshots when every upstream fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.reject(new Error("upstream metadata is unreachable")));
  try {
    const response = await handleAdminModelsRefresh();
    assert.equal(response.status, 200);
    const data = (await bodyOf(response)).data as Json;
    assert.equal((data.openrouter as Json).upstream_models, 0);
    assert.equal((data.openrouter as Json).updated_at_ms, null);
    assert.equal((data.openlux as Json).models, 0);
    assert.equal((data.surplus as Json).models, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
