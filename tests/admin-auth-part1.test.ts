import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { KvU64 } from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/admin-auth-harness.ts";
// admin-auth suite part: tests moved out of tests/admin-auth.test.ts.

import assert from "node:assert/strict";
import {
  DISABLED_FALLBACK_TOKEN,
  ENABLED_FALLBACK_TOKEN,
  FAILED_FALLBACK_TOKEN,
  authPayload,
  getKernelUsageLimitSnapshot,
  handleAdminApiKeysCreate,
  handleAdminApiKeysList,
  handleAdminApiKeysUpdate,
  handleAdminCodexAuth,
  handleAdminCodexModelsGet,
  handleAdminCodexModelsSet,
  handleAdminDefaults,
  handleAdminKernelUsageDelete,
  handleAdminKernelUsageSet,
  handleAdminKvMigrationImport,
  kernelRepoPolicyKey,
  kernelRepoWindowKey,
  keyToString,
  kvStore,
  makeRequest,
  meteredMetadataResponse,
  seedCodexSnapshot,
  setAtomicCommitsToFail,
  stringEntryLine,
  urlOf,
} from "./helpers/admin-auth-harness.ts";

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("subscription reset settings require admin authentication", async () => {
  const { default: handler } = await import("../src/handler/index.ts");
  for (const method of ["GET", "PATCH"]) {
    const response = await handler(new Request("http://localhost/admin/providers/codex/banked-resets", { method }));
    assert.equal(response.status, 401);
    await response.body?.cancel();
  }
});

test("API key list reports committed V3 usage and ignores legacy counters", async () => {
  kvStore.clear();
  const id = "v2-usage-list";
  const windowMs = 60_000;
  const windowStartMs = Date.now();
  const usageResetAtMs = windowStartMs + windowMs;
  kvStore.set(keyToString(["ubq_ai", "api_keys", "id", id]), {
    id,
    name: "V3 usage list",
    prefix: "u_1234567890",
    hash: "hash-v2-usage-list",
    created_at_ms: windowStartMs,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 10,
    usage_requests: 17,
    usage_reset_at_ms: usageResetAtMs,
    window_ms: windowMs,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_pricing_checked_at_ms: null,
  });
  kvStore.set(keyToString(["uos_ai", "api_key_usage", "v2", id, String(windowMs), windowStartMs]), { value: 3n } as KvU64);
  kvStore.set(keyToString(["uos_ai", "api_key_usage", "v3", "window", id, `v3:${windowMs}`, windowStartMs]), {
    v: 3,
    key_id: id,
    policy_version: `v3:${windowMs}`,
    window_start_ms: windowStartMs,
    window_reset_at_ms: usageResetAtMs,
    committed_requests: 4,
    reserved_requests: 1,
    updated_at_ms: windowStartMs,
  });

  const withoutUsage = await handleAdminApiKeysList(new Request("https://ai.ubq.fi/admin/api-keys"));
  assert.equal(withoutUsage.status, 200);
  const withoutPayload = (await withoutUsage.json()) as { data?: Record<string, unknown>[] };
  assert.equal(Object.prototype.hasOwnProperty.call(withoutPayload.data?.[0] ?? {}, "usage_requests"), false);

  const withUsage = await handleAdminApiKeysList(new Request("https://ai.ubq.fi/admin/api-keys?include_usage=1"));
  assert.equal(withUsage.status, 200);
  const withPayload = (await withUsage.json()) as {
    data?: { usage_requests?: number; usage?: { request_count?: number } }[];
  };
  assert.equal(withPayload.data?.[0]?.usage_requests, 4);
  assert.equal(withPayload.data[0]?.usage?.request_count, 4);
});

test("API key list projects current paid fallback totals from V3 only", async () => {
  kvStore.clear();
  const id = "paid-fallback-v3-projection";
  const now = Date.now();
  const resetAtMs = now + 60_000;
  kvStore.set(keyToString(["ubq_ai", "api_keys", "id", id]), {
    id,
    name: "V3 projection",
    prefix: "u_1234567890",
    hash: "hash-paid-fallback-v3-projection",
    created_at_ms: now - 1_000,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: -1,
    usage_requests: 0,
    usage_reset_at_ms: resetAtMs,
    window_ms: 60_000,
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: 2_000_000,
    paid_fallback_spent_microcredits: 1_000_000,
    paid_fallback_reserved_microcredits: 500_000,
    paid_fallback_reservation_request_id: "legacy-stale-reservation",
    paid_fallback_model_ids: ["gpt-5.6-sol"],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_pricing_checked_at_ms: now,
  });
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "window", id, resetAtMs]), {
    v: 3,
    key_id: id,
    policy_version: "60000",
    window_reset_at_ms: resetAtMs,
    limit_microcredits: 2_000_000,
    settled_microcredits: 28_992,
    reserved_microcredits: 125_000,
    pending_count: 1,
    updated_at_ms: now,
  });
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "request", id, "metered-request"]), {
    request_id: "metered-request",
    provider: "metered",
    window_reset_at_ms: resetAtMs,
    input_tokens: 3,
    output_tokens: 4,
    billing_state: "settled",
    spend_microcredits: 500,
    created_at_ms: now - 2,
  });
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "request", id, "surplus-request"]), {
    request_id: "surplus-request",
    provider: "surplus",
    window_reset_at_ms: resetAtMs,
    input_tokens: 11,
    output_tokens: 7,
    billing_state: "settled",
    spend_microcredits: 700,
    created_at_ms: now - 1,
  });

  const response = await handleAdminApiKeysList(new Request("https://ai.ubq.fi/admin/api-keys"));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    data?: {
      paid_fallback_limit_credits?: number;
      paid_fallback_spent_credits?: number;
      paid_fallback_reserved_credits?: number;
      paid_fallback_pending_count?: number;
      paid_fallback_provider_usage?: {
        metered?: { request_count?: number; total_tokens?: number; spend_microcredits?: number };
        surplus?: { request_count?: number; total_tokens?: number; spend_microcredits?: number };
      };
    }[];
  };
  assert.equal(payload.data?.[0]?.paid_fallback_limit_credits, 2);
  assert.equal(payload.data[0]?.paid_fallback_spent_credits, 0.028992);
  assert.equal(payload.data[0]?.paid_fallback_reserved_credits, 0.125);
  assert.equal(payload.data[0]?.paid_fallback_pending_count, 1);
  assert.equal(payload.data[0]?.paid_fallback_provider_usage?.metered?.request_count, 1);
  assert.equal(payload.data[0]?.paid_fallback_provider_usage?.metered?.total_tokens, 7);
  assert.equal(payload.data[0]?.paid_fallback_provider_usage?.metered?.spend_microcredits, 500);
  assert.equal(payload.data[0]?.paid_fallback_provider_usage?.surplus?.request_count, 1);
  assert.equal(payload.data[0]?.paid_fallback_provider_usage?.surplus?.total_tokens, 18);
  assert.equal(payload.data[0]?.paid_fallback_provider_usage?.surplus?.spend_microcredits, 700);
});

test("API key limit edits retain V3 usage while resets create a fresh aggregate and reject live leases", async () => {
  kvStore.clear();
  const token = `u_${"d".repeat(64)}`;
  const createdResponse = await handleAdminApiKeysCreate(
    new Request("https://ai.ubq.fi/admin/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "V3 reset", token, usage_limit_requests: 8, window_ms: 60_000 }),
    })
  );
  assert.equal(createdResponse.status, 200);
  const created = (await createdResponse.json()) as { id: string };
  const stored = kvStore.get(keyToString(["ubq_ai", "api_keys", "id", created.id])) as {
    hash: string;
    window_ms: number;
    usage_reset_at_ms: number;
  };
  const oldStart = stored.usage_reset_at_ms - stored.window_ms;
  const oldWindowKey = ["uos_ai", "api_key_usage", "v3", "window", created.id, `v3:${stored.window_ms}`, oldStart] as const;
  const oldWindow = kvStore.get(keyToString(oldWindowKey)) as Record<string, unknown>;
  kvStore.set(keyToString(oldWindowKey), { ...oldWindow, committed_requests: 2 });

  const limitOnly = await handleAdminApiKeysUpdate(
    new Request("https://ai.ubq.fi/admin/api-keys", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: created.id, usage_limit_requests: 5 }),
    })
  );
  assert.equal(limitOnly.status, 200);
  const limitPayload = (await limitOnly.json()) as { usage_requests?: number };
  assert.equal(limitPayload.usage_requests, 2);
  assert.equal((kvStore.get(keyToString(oldWindowKey)) as { committed_requests?: number }).committed_requests, 2);

  const reset = await handleAdminApiKeysUpdate(
    new Request("https://ai.ubq.fi/admin/api-keys", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: created.id, reset_usage: true }),
    })
  );
  assert.equal(reset.status, 200);
  const resetPayload = (await reset.json()) as { usage_requests?: number; usage_reset_at_ms?: number };
  assert.equal(resetPayload.usage_requests, 0);
  assert.notEqual(resetPayload.usage_reset_at_ms, stored.usage_reset_at_ms);

  const resetRecord = kvStore.get(keyToString(["ubq_ai", "api_keys", "id", created.id])) as {
    window_ms: number;
    usage_reset_at_ms: number;
  };
  const resetStart = resetRecord.usage_reset_at_ms - resetRecord.window_ms;
  const resetWindowKey = ["uos_ai", "api_key_usage", "v3", "window", created.id, `v3:${resetRecord.window_ms}`, resetStart] as const;
  const resetWindow = kvStore.get(keyToString(resetWindowKey)) as Record<string, unknown>;
  kvStore.set(keyToString(resetWindowKey), { ...resetWindow, reserved_requests: 1 });
  kvStore.set(keyToString(["uos_ai", "api_key_usage", "v3", "request", created.id, `v3:${resetRecord.window_ms}`, resetStart, "live-reset-lease"]), {
    v: 3,
    key_id: created.id,
    request_id: "live-reset-lease",
    route: "responses",
    state: "reserved",
    reserved_at_ms: Date.now(),
    lease_expires_at_ms: Date.now() + 60_000,
    provider: null,
    dispatched_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  });
  const blocked = await handleAdminApiKeysUpdate(
    new Request("https://ai.ubq.fi/admin/api-keys", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: created.id, reset_usage: true }),
    })
  );
  assert.equal(blocked.status, 409);
});

test("admin Codex model GET returns the full catalog rather than the compact runtime record", async () => {
  kvStore.clear();
  seedCodexSnapshot({
    models: [
      {
        slug: "gpt-admin-full-catalog",
        display_name: "GPT Admin Full Catalog",
        description: "full catalog description",
        context_window: 272_000,
        supported_reasoning_levels: ["none", "high"],
      },
    ],
    source: "chatgpt_codex",
    client_version: "0.201.0",
    updated_at_ms: Date.now(),
  });

  const response = await handleAdminCodexModelsGet();
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    data?: { models?: { description?: string; context_window?: number }[] };
  };
  assert.equal(payload.data?.models?.[0]?.description, "full catalog description");
  assert.equal(payload.data.models[0]?.context_window, 272_000);
});

test("admin Codex model update rejects a catalog whose compact runtime record exceeds 4 KiB", async () => {
  kvStore.clear();
  const response = await handleAdminCodexModelsSet(
    makeRequest({
      source: "chatgpt_codex",
      client_version: "0.201.0",
      models: Array.from({ length: 200 }, (_, index) => ({
        slug: `gpt-admin-runtime-${String(index).padStart(3, "0")}`,
        supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "ultra"],
      })),
    })
  );

  assert.equal(response.status, 413);
  const payload = (await response.json()) as { error?: { code?: string; message?: string } };
  assert.equal(payload.error?.code, "runtime_config_invalid");
  assert.match(payload.error.message ?? "", /runtime config is too large/);
  assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_models"])), false);
  assert.equal(kvStore.has(keyToString(["uos_ai", "runtime_config", "v2"])), false);
});

test("admin defaults includes serializable Metered quota diagnostics without credentials", async () => {
  kvStore.clear();
  const response = await handleAdminDefaults(new Request("https://ai.ubq.fi/admin/defaults"), {
    getMeteredQuotaDiagnostics: () =>
      Promise.resolve({
        configured: true,
        available: true,
        cache_state: "fresh",
        confidence: "refill_observed",
        balance_credits: 75,
        baseline_credits: 100,
        remaining_percent: 75,
        used_percent: 25,
        observed_at_ms: 2_000_000,
        cycle_started_at_ms: 1_000_000,
        last_known_debits_credits: 1,
        last_inferred_credit_credits: 50,
        last_credit_at_ms: 1_500_000,
        latest_refill_id: "refill-2",
        latest_refill_amount_credits: 50,
        latest_refill_completed_at_ms: 1_400_000,
      }),
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown> & {
    metered_quota?: Record<string, unknown>;
  };
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "ok"), false);
  assert.equal(payload.metered_quota?.remaining_percent, 75);
  assert.equal(payload.metered_quota.latest_refill_id, "refill-2");
  assert.equal(Object.prototype.hasOwnProperty.call(payload.metered_quota ?? {}, "system_token"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.metered_quota ?? {}, "user_id"), false);
});

test("admin defaults permits kernel-only updates without runtime configuration", async () => {
  kvStore.clear();

  const response = await handleAdminDefaults(
    new Request("https://ai.ubq.fi/admin/defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kernel_policy_limit_requests: 17,
        kernel_policy_window_ms: 60_000,
      }),
    })
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    defaults?: {
      model?: string;
      reasoning_effort?: string;
      kernel_policy_limit_requests?: number;
      kernel_policy_window_ms?: number;
    };
  };
  assert.deepEqual(payload.defaults, {
    model: "",
    reasoning_effort: "medium",
    kernel_policy_limit_requests: 17,
    kernel_policy_window_ms: 60_000,
  });
  assert.equal(kvStore.get(keyToString(["default", "kernel_policy_limit_requests"])), 17);
  assert.equal(kvStore.get(keyToString(["default", "kernel_policy_window_ms"])), 60_000);
  assert.equal(kvStore.has(keyToString(["uos_ai", "runtime_config", "v2"])), false);

  for (const body of [{ model: "gpt-5.5" }, { reasoning_effort: "none" }]) {
    const guardedResponse = await handleAdminDefaults(
      new Request("https://ai.ubq.fi/admin/defaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    assert.equal(guardedResponse.status, 503);
  }
});

test("admin defaults rejects late invalid fields without partial writes", async () => {
  kvStore.clear();
  seedCodexSnapshot({
    source: "codex_cli",
    updated_at_ms: 123,
    models: [
      {
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["none", "medium"],
      },
    ],
  });
  const before = JSON.stringify([...kvStore.entries()]);

  const response = await handleAdminDefaults(
    new Request("https://ai.ubq.fi/admin/defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", kernel_policy_window_ms: 0 }),
    })
  );

  assert.equal(response.status, 400);
  assert.equal(JSON.stringify([...kvStore.entries()]), before);
});

test("admin kernel quota policies preserve usage until an explicit reset and return to default source", async () => {
  kvStore.clear();
  const owner = "kernel-owner";
  const repo = "kernel-repo";
  const policyKey = kernelRepoPolicyKey(owner, repo);
  const windowKey = kernelRepoWindowKey(owner, repo);
  kvStore.set(keyToString(["default", "kernel_policy_limit_requests"]), 9);
  kvStore.set(keyToString(["default", "kernel_policy_window_ms"]), 60_000);

  const set = await handleAdminKernelUsageSet(
    new Request("https://ai.ubq.fi/admin/kernel-usage", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo, usage_limit_requests: 5, window_ms: 60_000 }),
    })
  );
  assert.equal(set.status, 200);
  const initialWindow = kvStore.get(keyToString(windowKey)) as Record<string, unknown>;
  kvStore.set(keyToString(windowKey), { ...initialWindow, usage_requests: 4 });

  const limitOnly = await handleAdminKernelUsageSet(
    new Request("https://ai.ubq.fi/admin/kernel-usage", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo, usage_limit_requests: 3, reset_usage: false }),
    })
  );
  assert.equal(limitOnly.status, 200);
  assert.equal((kvStore.get(keyToString(policyKey)) as { usage_limit_requests?: number }).usage_limit_requests, 3);
  assert.equal((kvStore.get(keyToString(windowKey)) as { usage_requests?: number }).usage_requests, 4);

  const invalidReset = await handleAdminKernelUsageSet(
    new Request("https://ai.ubq.fi/admin/kernel-usage", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo, usage_limit_requests: 3, reset_usage: "false" }),
    })
  );
  assert.equal(invalidReset.status, 400);
  assert.equal((kvStore.get(keyToString(windowKey)) as { usage_requests?: number }).usage_requests, 4);

  const reset = await handleAdminKernelUsageSet(
    new Request("https://ai.ubq.fi/admin/kernel-usage", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo, usage_limit_requests: 3, reset_usage: true }),
    })
  );
  assert.equal(reset.status, 200);
  assert.equal((kvStore.get(keyToString(windowKey)) as { usage_requests?: number }).usage_requests, 0);

  const preservedWindow = kvStore.get(keyToString(windowKey)) as Record<string, unknown>;
  kvStore.set(keyToString(windowKey), { ...preservedWindow, usage_requests: 2 });
  const deleted = await handleAdminKernelUsageDelete(
    new Request("https://ai.ubq.fi/admin/kernel-usage", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo }),
    })
  );
  assert.equal(deleted.status, 200);
  assert.equal(kvStore.has(keyToString(policyKey)), false);
  assert.equal((kvStore.get(keyToString(windowKey)) as { usage_requests?: number }).usage_requests, 2);
  const snapshot = await getKernelUsageLimitSnapshot(owner, repo);
  assert.equal(snapshot?.source, "default");
  assert.equal(snapshot.record.usage_requests, 2);
  assert.equal(snapshot.record.usage_limit_requests, 9);
});

test("admin codex auth stores live upstream model catalog as source of truth", async () => {
  kvStore.clear();
  const originalFetch = globalThis.fetch;
  const fetchUrls: string[] = [];

  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = urlOf(input);
    fetchUrls.push(url);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.3-codex-spark",
              display_name: "GPT-5.3-Codex-Spark",
              visibility: "list",
              supported_in_api: false,
              default_reasoning_level: "high",
              supported_reasoning_levels: [
                { effort: "low", description: "Fast responses" },
                { effort: "medium", description: "Balanced reasoning" },
                { effort: "high", description: "Greater reasoning depth" },
                { effort: "xhigh", description: "Extra high reasoning depth" },
                { effort: "max", description: "Maximum reasoning depth" },
                { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
              ],
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
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
  });

  try {
    const response = await handleAdminCodexAuth(
      makeRequest({
        auth: authPayload,
        models: {
          source: "codex_cli",
          client_version: "0.126.0",
          updated_at_ms: 123,
          models: [
            {
              slug: "stale-local-model",
              display_name: "Stale Local Model",
              context_window: 272000,
              max_context_window: 1000000,
              auto_compact_token_limit: null,
              supported_reasoning_levels: [{ effort: null }, "low", "medium", "high", "xhigh"],
            },
            {
              slug: "codex-auto-review",
              display_name: "Codex Auto Review",
              visibility: "hide",
              supported_in_api: true,
            },
          ],
        },
      })
    );

    assert.equal(response.status, 200);
    const payload = (await response.json()) as { models?: { count?: number; source?: string } };
    assert.equal(payload.models?.count, 2);
    assert.equal(payload.models.source, "chatgpt_codex");
    assert.equal(fetchUrls.length, 1);

    const stored = kvStore.get(keyToString(["ubq_ai", "codex_models"])) as
      | {
          source?: string;
          client_version?: string;
          models?: {
            slug?: string;
            context_window?: number;
            max_context_window?: number;
            auto_compact_token_limit?: number | null;
            supported_in_api?: boolean;
            visibility?: string;
            default_reasoning_level?: string;
            supported_reasoning_levels?: string[];
            reasoning_effort_wire_map?: Record<string, string>;
          }[];
        }
      | undefined;
    assert.equal(stored?.source, "chatgpt_codex");
    assert.equal(stored.client_version, "0.126.0");
    assert.deepEqual(
      stored.models?.map((model) => model.slug),
      ["gpt-5.3-codex-spark", "codex-auto-review"]
    );
    assert.equal(stored.models[0]?.supported_in_api, false);
    assert.equal(stored.models[0]?.default_reasoning_level, "high");
    // The live upstream list is stored verbatim: no tier is invented for it.
    assert.deepEqual(stored.models[0]?.supported_reasoning_levels, ["low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.deepEqual(stored.models[0]?.reasoning_effort_wire_map, { ultra: "max" });
    assert.equal(stored.models[1]?.visibility, "hide");
    assert.equal(stored.models[1]?.supported_in_api, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin codex auth stores live model catalog without caller model snapshot", async () => {
  kvStore.clear();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ models: [{ slug: "gpt-5.3-codex-spark", visibility: "list" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  );

  try {
    const response = await handleAdminCodexAuth(makeRequest({ auth: authPayload }));
    assert.equal(response.status, 200);
    const stored = kvStore.get(keyToString(["ubq_ai", "codex_models"])) as { models?: { slug?: string }[] };
    assert.deepEqual(
      stored.models?.map((model) => model.slug),
      ["gpt-5.3-codex-spark"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin Codex auth accepts authenticated 429 and preserves the last known-good catalog", async () => {
  kvStore.clear();
  const snapshot = {
    source: "chatgpt_codex" as const,
    client_version: "0.200.0",
    updated_at_ms: 123,
    models: [{ slug: "gpt-5.6", display_name: "GPT-5.6" }],
  };
  seedCodexSnapshot(snapshot);
  kvStore.set(keyToString(["ubq_ai", "codex_catalog_auth_generation"]), "existing-generation");
  kvStore.set(keyToString(["ubq_ai", "codex_auth"]), {
    accounts: [
      {
        access_token: "limited-access",
        refresh_token: "limited-refresh",
        account_id: "limited-account",
        updated_at_ms: 100,
      },
    ],
    updated_at_ms: 100,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      new Response('{"statusCode":429,"description":"Too Many Requests"}', {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })
    )
  );

  try {
    const response = await handleAdminCodexAuth(makeRequest({ auth: authPayload }));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      account_count?: number;
      upstream_status?: number;
      catalog_seeded?: boolean;
      normalized_snapshot_updated?: boolean;
    };
    assert.equal(payload.account_count, 2);
    assert.equal(payload.upstream_status, 429);
    assert.equal(payload.catalog_seeded, false);
    assert.equal(payload.normalized_snapshot_updated, false);
    assert.deepEqual(kvStore.get(keyToString(["ubq_ai", "codex_models"])), snapshot);
    assert.equal(kvStore.get(keyToString(["ubq_ai", "codex_catalog_auth_generation"])), "existing-generation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin Codex auth adds, rotates, and caps the two-account pool", async () => {
  kvStore.clear();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ models: [{ slug: "gpt-5.5" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
  const upload = (accountId: string, accessToken: string) =>
    handleAdminCodexAuth(
      makeRequest({
        auth: {
          tokens: {
            access_token: accessToken,
            refresh_token: `refresh-${accountId}`,
            account_id: accountId,
          },
        },
      })
    );

  try {
    assert.equal((await upload("account-one", "access-one")).status, 200);
    const second = await upload("account-two", "access-two");
    assert.equal(second.status, 200);
    const secondPayload = (await second.json()) as { account_count?: number; account_ids?: string[] };
    assert.equal(secondPayload.account_count, 2);
    assert.deepEqual(secondPayload.account_ids, ["account-one", "account-two"]);

    assert.equal((await upload("account-one", "access-one-rotated")).status, 200);
    const poolAfterRotation = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as {
      accounts?: { account_id?: string; access_token?: string }[];
    };
    assert.deepEqual(
      poolAfterRotation.accounts?.map((account) => account.account_id),
      ["account-one", "account-two"]
    );
    assert.equal(poolAfterRotation.accounts[0]?.access_token, "access-one-rotated");
    assert.equal(poolAfterRotation.accounts[1]?.access_token, "access-two");

    const third = await upload("account-three", "access-three");
    assert.equal(third.status, 409);
    const thirdPayload = (await third.json()) as { error?: { code?: string } };
    assert.equal(thirdPayload.error?.code, "codex_auth_pool_full");
    const poolAfterThird = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as {
      accounts?: { account_id?: string }[];
    };
    assert.deepEqual(
      poolAfterThird.accounts?.map((account) => account.account_id),
      ["account-one", "account-two"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin codex auth rotation replaces a prior account snapshot even at an older version", async () => {
  kvStore.clear();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = urlOf(input);
    const version = new URL(url).searchParams.get("client_version") ?? "missing";
    return Promise.resolve(
      new Response(JSON.stringify({ models: [{ slug: `gpt-${version}`, rich_field: { preserved: true } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: `"${version}"` },
      })
    );
  });

  try {
    const newer = await handleAdminCodexAuth(
      makeRequest({
        auth: authPayload,
        models: { client_version: "0.201.0" },
      })
    );
    assert.equal(newer.status, 200);
    const firstGeneration = kvStore.get(keyToString(["ubq_ai", "codex_catalog_auth_generation"]));
    assert.equal(typeof firstGeneration, "string");

    const older = await handleAdminCodexAuth(
      makeRequest({
        auth: authPayload,
        models: { client_version: "0.200.0" },
      })
    );
    assert.equal(older.status, 200);
    const olderPayload = (await older.json()) as { normalized_snapshot_updated?: boolean; ok?: boolean };
    assert.equal(olderPayload.normalized_snapshot_updated, true);
    assert.equal(Object.prototype.hasOwnProperty.call(olderPayload, "ok"), false);

    const secondGeneration = kvStore.get(keyToString(["ubq_ai", "codex_catalog_auth_generation"]));
    assert.equal(typeof secondGeneration, "string");
    assert.notEqual(secondGeneration, firstGeneration);
    const snapshot = kvStore.get(keyToString(["ubq_ai", "codex_models"])) as {
      client_version?: string;
      models?: { slug?: string }[];
    };
    assert.equal(snapshot.client_version, "0.200.0");
    assert.equal(snapshot.models?.[0]?.slug, "gpt-0.200.0");

    const seededMetadata = kvStore.get(keyToString(["ubq_ai", "codex_catalog", "0.200.0"])) as {
      auth_generation?: string;
      etag?: string;
    };
    assert.equal(seededMetadata.auth_generation, secondGeneration);
    assert.equal(seededMetadata.etag, '"0.200.0"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin codex auth retries transient snapshot contention", async () => {
  kvStore.clear();
  setAtomicCommitsToFail(1);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ models: [{ slug: "gpt-5.5" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  );

  try {
    const response = await handleAdminCodexAuth(
      makeRequest({
        auth: authPayload,
        models: {
          source: "codex_cli",
          client_version: "0.126.0",
          updated_at_ms: 123,
          models: [{ slug: "gpt-5.5", display_name: "GPT-5.5" }],
        },
      })
    );

    assert.equal(response.status, 200);
    assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), true);
    assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_models"])), true);
  } finally {
    globalThis.fetch = originalFetch;
    setAtomicCommitsToFail(0);
  }
});

test("admin codex auth fails atomically after snapshot contention retries are exhausted", async () => {
  kvStore.clear();
  setAtomicCommitsToFail(3);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ models: [{ slug: "gpt-5.5" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  );

  try {
    const response = await handleAdminCodexAuth(
      makeRequest({
        auth: authPayload,
        models: { client_version: "0.126.0" },
      })
    );

    assert.equal(response.status, 500);
    assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_auth"])), false);
    assert.equal(kvStore.has(keyToString(["ubq_ai", "codex_models"])), false);
  } finally {
    globalThis.fetch = originalFetch;
    setAtomicCommitsToFail(0);
  }
});

test("admin KV migration import stays dry-run unless write is explicit", async () => {
  kvStore.clear();

  const response = await handleAdminKvMigrationImport(
    new Request("https://ai.ubq.fi/admin/kv-migration/import?profile=prod&dry_run=false&overwrite=true", {
      method: "POST",
      body: stringEntryLine(["default", "model"], "gpt-5.5"),
    })
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { dry_run?: boolean; imported?: number };
  assert.equal(payload.dry_run, true);
  assert.equal(payload.imported, 1);
  assert.equal(kvStore.has(keyToString(["default", "model"])), false);
});

test("admin KV migration import reports partial writes with HTTP 422", async () => {
  kvStore.clear();
  const response = await handleAdminKvMigrationImport(
    new Request("https://ai.ubq.fi/admin/kv-migration/import?profile=prod&write=1&overwrite=true", {
      method: "POST",
      body: `${stringEntryLine(["default", "model"], "gpt-5.5")}\n{not-json}`,
    })
  );

  assert.equal(response.status, 422);
  const payload = (await response.json()) as { imported?: number; errors?: number };
  assert.equal(payload.imported, 1);
  assert.equal(payload.errors, 1);
  assert.equal(kvStore.get(keyToString(["default", "model"])), "gpt-5.5");
});

test("admin defaults accepts none when the model supports none", async () => {
  kvStore.clear();
  seedCodexSnapshot({
    source: "codex_cli",
    updated_at_ms: 123,
    models: [
      {
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh"],
      },
    ],
  });

  const response = await handleAdminDefaults(
    new Request("https://ai.ubq.fi/admin/defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        reasoning_effort: "none",
      }),
    })
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { defaults?: { reasoning_effort?: string } };
  assert.equal(payload.defaults?.reasoning_effort, "none");
  assert.equal((kvStore.get(keyToString(["uos_ai", "runtime_config", "v2"])) as { default_reasoning_effort?: string }).default_reasoning_effort, "none");
});

test("admin defaults accepts a tier advertised by the Codex CLI catalog", async () => {
  kvStore.clear();
  seedCodexSnapshot({
    source: "codex_cli",
    updated_at_ms: 123,
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    ],
  });

  const response = await handleAdminDefaults(
    new Request("https://ai.ubq.fi/admin/defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        reasoning_effort: "ultra",
      }),
    })
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { defaults?: { reasoning_effort?: string } };
  assert.equal(payload.defaults?.reasoning_effort, "ultra");
  assert.equal((kvStore.get(keyToString(["uos_ai", "runtime_config", "v2"])) as { default_reasoning_effort?: string }).default_reasoning_effort, "ultra");
});

test("admin defaults does not reject an unlisted reasoning tier", async () => {
  kvStore.clear();
  seedCodexSnapshot({
    source: "codex_cli",
    updated_at_ms: 123,
    models: [
      {
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
      },
    ],
  });

  const response = await handleAdminDefaults(
    new Request("https://ai.ubq.fi/admin/defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        reasoning_effort: "future-tier",
      }),
    })
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { defaults?: { reasoning_effort?: string } };
  assert.equal(payload.defaults?.reasoning_effort, "future-tier");
  assert.equal((kvStore.get(keyToString(["uos_ai", "runtime_config", "v2"])) as { default_reasoning_effort?: string }).default_reasoning_effort, "future-tier");
});

test("admin defaults rejects null reasoning effort", async () => {
  kvStore.clear();
  seedCodexSnapshot({
    source: "codex_cli",
    updated_at_ms: 123,
    models: [
      {
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh"],
      },
    ],
  });

  const response = await handleAdminDefaults(
    new Request("https://ai.ubq.fi/admin/defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        reasoning_effort: null,
      }),
    })
  );

  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error?: { message?: string } };
  assert.match(payload.error?.message ?? "", /reasoning_effort must be a non-empty string/);
  assert.equal(kvStore.has(keyToString(["default", "reasoning_effort"])), false);
});

test("paid fallback pricing initializes only when a key becomes enabled", async () => {
  kvStore.clear();
  seedCodexSnapshot({
    source: "chatgpt_codex",
    updated_at_ms: Date.now(),
    models: [{ slug: "gpt-5.6-sol", context_window: 272_000 }, { slug: "codex-only-model" }],
  });

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.METERED_API_KEY;
  const metadataUrls: string[] = [];
  process.env.METERED_API_KEY = "metered-test-key";
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = urlOf(input);
    metadataUrls.push(url);
    return Promise.resolve(meteredMetadataResponse(url));
  });

  try {
    const createResponse = await handleAdminApiKeysCreate(
      new Request("https://ai.ubq.fi/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Overflow disabled",
          token: DISABLED_FALLBACK_TOKEN,
          paid_fallback_enabled: false,
          paid_fallback_limit_credits: 2,
        }),
      })
    );
    assert.equal(createResponse.status, 200);
    assert.equal(metadataUrls.length, 0);
    const created = (await createResponse.json()) as {
      id: string;
      paid_fallback_enabled: boolean;
      paid_fallback_limit_credits: number;
      paid_fallback_pricing_checked_at_ms: number | null;
    };
    assert.equal(created.paid_fallback_enabled, false);
    assert.equal(created.paid_fallback_limit_credits, 2);
    assert.equal(created.paid_fallback_pricing_checked_at_ms, null);

    const enableResponse = await handleAdminApiKeysUpdate(
      new Request("https://ai.ubq.fi/admin/api-keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: created.id, paid_fallback_enabled: true }),
      })
    );
    assert.equal(enableResponse.status, 200);
    assert.deepEqual(
      metadataUrls.toSorted((left, right) => left.localeCompare(right)),
      ["https://api.openlux.ai/api/ratio_config", "https://api.openlux.ai/api/status"]
    );
    const enabled = (await enableResponse.json()) as {
      paid_fallback_enabled: boolean;
      paid_fallback_model_ids: string[];
      paid_fallback_pricing_checked_at_ms: number | null;
    };
    assert.equal(enabled.paid_fallback_enabled, true);
    assert.deepEqual(enabled.paid_fallback_model_ids, ["gpt-5.6-sol"]);
    assert.equal(typeof enabled.paid_fallback_pricing_checked_at_ms, "number");

    metadataUrls.length = 0;
    const capResponse = await handleAdminApiKeysUpdate(
      new Request("https://ai.ubq.fi/admin/api-keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: created.id, paid_fallback_limit_credits: -1 }),
      })
    );
    assert.equal(capResponse.status, 200);
    assert.equal(metadataUrls.length, 0);
    const unlimited = (await capResponse.json()) as { paid_fallback_limit_credits: number };
    assert.equal(unlimited.paid_fallback_limit_credits, -1);
    const storedUnlimitedId = kvStore.get(keyToString(["ubq_ai", "api_keys", "id", created.id])) as {
      hash: string;
      paid_fallback_limit_microcredits: number;
    };
    const storedUnlimitedHash = kvStore.get(keyToString(["ubq_ai", "api_keys", "hash", storedUnlimitedId.hash])) as {
      paid_fallback_limit_microcredits: number;
    };
    assert.equal(storedUnlimitedId.paid_fallback_limit_microcredits, -1);
    assert.equal(storedUnlimitedHash.paid_fallback_limit_microcredits, -1);

    const disableResponse = await handleAdminApiKeysUpdate(
      new Request("https://ai.ubq.fi/admin/api-keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: created.id, paid_fallback_enabled: false }),
      })
    );
    assert.equal(disableResponse.status, 200);
    assert.equal(metadataUrls.length, 0);

    const reenableResponse = await handleAdminApiKeysUpdate(
      new Request("https://ai.ubq.fi/admin/api-keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: created.id, paid_fallback_enabled: true }),
      })
    );
    assert.equal(reenableResponse.status, 200);
    assert.deepEqual(
      metadataUrls.toSorted((left, right) => left.localeCompare(right)),
      ["https://api.openlux.ai/api/ratio_config", "https://api.openlux.ai/api/status"]
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalApiKey;
  }
});

test("API key creation rejects custom tokens outside the v2 routable shape", async () => {
  kvStore.clear();
  const response = await handleAdminApiKeysCreate(
    new Request("https://ai.ubq.fi/admin/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Legacy custom token",
        token: "legacy_custom_token_that_was_previously_accepted",
      }),
    })
  );
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error?: { message?: string } };
  assert.match(payload.error?.message ?? "", /u_ prefix followed by 64 lowercase hexadecimal/);
  assert.equal(
    [...kvStore.keys()].some((key) => key.includes('"api_keys"')),
    false
  );
});

test("API key creation generates a v2 token when token is null", async () => {
  kvStore.clear();
  const response = await handleAdminApiKeysCreate(
    new Request("https://ai.ubq.fi/admin/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Generated token",
        token: null,
      }),
    })
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { token?: string; prefix?: string };
  assert.match(payload.token ?? "", /^u_[0-9a-f]{64}$/);
  assert.equal(payload.prefix, payload.token?.slice(0, 12));
});

test("enabled key creation initializes once and failed enable leaves the key disabled", async () => {
  kvStore.clear();
  seedCodexSnapshot({
    source: "chatgpt_codex",
    updated_at_ms: Date.now(),
    models: [{ slug: "gpt-5.6-sol", context_window: 272_000 }],
  });

  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.METERED_API_KEY;
  process.env.METERED_API_KEY = "metered-test-key";
  let metadataCalls = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = urlOf(input);
    metadataCalls += 1;
    return Promise.resolve(meteredMetadataResponse(url));
  });

  try {
    const enabledCreate = await handleAdminApiKeysCreate(
      new Request("https://ai.ubq.fi/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Overflow enabled",
          token: ENABLED_FALLBACK_TOKEN,
          paid_fallback_enabled: true,
          paid_fallback_limit_credits: 1,
        }),
      })
    );
    assert.equal(enabledCreate.status, 200);
    assert.equal(metadataCalls, 2);
    const enabledPayload = (await enabledCreate.json()) as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(enabledPayload, "ok"), false);
    assert.deepEqual(enabledPayload.paid_fallback_model_ids, ["gpt-5.6-sol"]);

    metadataCalls = 0;
    const duplicateCreate = await handleAdminApiKeysCreate(
      new Request("https://ai.ubq.fi/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Duplicate overflow key",
          token: ENABLED_FALLBACK_TOKEN,
          paid_fallback_enabled: true,
          paid_fallback_limit_credits: 1,
        }),
      })
    );
    assert.equal(duplicateCreate.status, 409);
    assert.equal(metadataCalls, 0);

    const disabledCreate = await handleAdminApiKeysCreate(
      new Request("https://ai.ubq.fi/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Enable failure",
          token: FAILED_FALLBACK_TOKEN,
          paid_fallback_enabled: false,
          paid_fallback_limit_credits: 1,
        }),
      })
    );
    const disabledPayload = (await disabledCreate.json()) as { id: string };

    globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith("/api/status")) {
        return Promise.resolve(new Response("upstream unavailable", { status: 503 }));
      }
      return Promise.resolve(meteredMetadataResponse(url));
    });
    const failedEnable = await handleAdminApiKeysUpdate(
      new Request("https://ai.ubq.fi/admin/api-keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: disabledPayload.id, paid_fallback_enabled: true }),
      })
    );
    assert.equal(failedEnable.status, 502);
    const stored = kvStore.get(keyToString(["ubq_ai", "api_keys", "id", disabledPayload.id])) as {
      paid_fallback_enabled?: boolean;
      paid_fallback_pricing_checked_at_ms?: number | null;
    };
    assert.equal(stored.paid_fallback_enabled, false);
    assert.equal(stored.paid_fallback_pricing_checked_at_ms, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalApiKey;
  }
});
