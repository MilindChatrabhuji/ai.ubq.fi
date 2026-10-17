import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test, beforeEach, afterEach } from "bun:test";
import { type Kv } from "#kv";
import { runSequence } from "./helpers/sequence.ts";
// codex-auth-cache suite, part 3 of 4: tests moved out of tests/codex-auth-cache.test.ts.

import assert from "node:assert/strict";
import {
  installHarness,
  cleanupHarness,
  AUTH_KEY,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
  accessToken,
  auth,
  claimCodexRoutingProbe,
  config,
  fetchCodexResponses,
  fixedStartMs,
  kv,
  liveBankedResetConfig,
  markCodexQuotaBlocked,
  parseCodexAccountRoutingState,
  parseCodexActiveAccountSelection,
  pool,
  probeErrorType,
  recordCodexCapacityRoutingObservations,
  requestUrl,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  scriptedResetProvider,
  seedStableBankedResetBlock,
  selectCodexRoutingAccounts,
  stableBankedResetRetryAfter,
} from "./helpers/codex-auth-cache-harness.ts";

test("a global active-account transition inside the final dispatch hook fences off a post-reset retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let inferenceCalls = 0;
  let beforeDispatchCalls = 0;
  const startedDispatchGenerations: number[] = [];
  const cancelledDispatchGenerations: number[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  const reset = scriptedResetProvider();
  globalThis.fetch = createFetchMock(() => {
    inferenceCalls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
      })
    );
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-active-account-fence" },
      {
        beforeDispatch: async () => {
          beforeDispatchCalls += 1;
          const dispatchGeneration = beforeDispatchCalls;
          if (beforeDispatchCalls === 2) {
            // Another request advances the global active selection while the
            // post-reset retry is paused in providerDispatch.claim().
            const active = parseCodexActiveAccountSelection(kv.extra.get(JSON.stringify(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY))?.value);
            if (!active) throw new Error("expected a durable active selection");
            await kv.set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, { ...active, generation: active.generation + 1, updated_at_ms: fixedStartMs });
          }
          return Promise.resolve({
            markTransportStarted: () => {
              startedDispatchGenerations.push(dispatchGeneration);
            },
            cancelBeforeTransport: () => {
              cancelledDispatchGenerations.push(dispatchGeneration);
              return Promise.resolve();
            },
          });
        },
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-active-fence",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.equal(beforeDispatchCalls, 2);
    assert.equal(inferenceCalls, 1, "the stale active selection on the second attempt must not reach upstream transport");
    assert.deepEqual(startedDispatchGenerations, [1]);
    assert.deepEqual(cancelledDispatchGenerations, [2]);
    assert.deepEqual(reset.calls, ["inventory", "redeem", "verify"]);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("an auth-pool slot reorder during a claimed reset fences submission before redemption", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const stableRetryAfter = new Date(fixedStartMs + 60_000).toUTCString();
  const upstreamAccounts: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  const reset = scriptedResetProvider({
    onInventory: () => {
      // Both accounts are quota-blocked. The second account is the reset
      // candidate, then an operator reorders the pool while it is claimed.
      kv.auth = pool(auth("two"), auth("one"));
      kv.authVersion += 1;
    },
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    upstreamAccounts.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": stableRetryAfter },
      })
    );
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-slot-reorder" },
      {
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-slot-reorder",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.deepEqual(upstreamAccounts, ["account-one", "account-two"]);
    // The all-blocked evaluator must inspect both account-bound inventories
    // before it can rule out a live spend after the routing reorder.
    assert.deepEqual(reset.calls, ["inventory", "inventory"]);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("the request that first discovers a healthy fallback does not spend before a fresh cohort read", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const reset = scriptedResetProvider();
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(
      accountIds.length === 1
        ? new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
          })
        : new Response(JSON.stringify({ id: "fallback-success" }), { status: 200 })
    );
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-fallback" },
      {
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-fallback",
        },
      }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(accountIds, ["account-one", "account-two"]);
    assert.deepEqual(reset.calls, []);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a sibling re-blocked during reset inventory cannot be dispatched from the stale snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  await seedStableBankedResetBlock();
  await seedStableBankedResetBlock("account-two");
  const reset = scriptedResetProvider({
    onInventory: () => {
      // Simulate a different isolate writing the durable record directly. The
      // local routing module's five-second cache intentionally remains stale.
      const routingKey = JSON.stringify(CODEX_ACCOUNT_ROUTING_KV_KEY);
      const entry = kv.extra.get(routingKey);
      assert.ok(entry);
      const state = structuredClone(parseCodexAccountRoutingState(entry.value));
      assert.ok(state);

      const sibling = state.slots[1];
      assert.ok(sibling);
      const retryAtMs = Date.parse(stableBankedResetRetryAfter);
      const slots = [...state.slots];
      slots[1] = {
        ...sibling,
        quota_blocked_until_ms: retryAtMs,
        quota_block_source: "header_retry_after",
        observed_reset_at_ms: retryAtMs,
        observed_reset_at_is_stable: true,
        banked_reset_generation_ambiguous: false,
        generation: sibling.generation + 1,
        probe_lease: null,
      };
      kv.extra.set(routingKey, {
        value: { ...state, updated_at_ms: fixedStartMs, slots },
        version: entry.version + 1,
      });
    },
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(new Response(JSON.stringify({ id: "stale-sibling-fallback" }), { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "partial-preflight-sibling-blocked" },
      {
        requestId: "partial-preflight-sibling-blocked",
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-partial-preflight-sibling-blocked",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, "codex_quota_blocked");
    assert.deepEqual(
      [...reset.inventoryAccountIds].sort((left, right) => left.localeCompare(right)),
      ["account-one", "account-two"]
    );
    assert.deepEqual(reset.redeemAccountIds, []);
    assert.equal(reset.calls.filter((call) => call === "inventory").length, 2);
    assert.equal(reset.calls.includes("redeem"), false);
    assert.deepEqual(accountIds, []);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a legacy timeout mutation during reset inventory cannot open a stale fallback", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  await seedStableBankedResetBlock();
  await seedStableBankedResetBlock("account-two");
  const reset = scriptedResetProvider({
    onInventory: () => {
      const routingKey = JSON.stringify(CODEX_ACCOUNT_ROUTING_KV_KEY);
      const entry = kv.extra.get(routingKey);
      assert.ok(entry);
      const state = structuredClone(parseCodexAccountRoutingState(entry.value));
      assert.ok(state);

      const sibling = state.slots[1];
      assert.ok(sibling);
      const slots = [...state.slots];
      slots[1] = {
        ...sibling,
        upstream_timeout_blocked_until_ms: fixedStartMs + CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
        generation: sibling.generation + 1,
        probe_lease: null,
      };
      kv.extra.set(routingKey, {
        value: { ...state, updated_at_ms: fixedStartMs, slots },
        version: entry.version + 1,
      });
    },
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(new Response(JSON.stringify({ id: "stale-timeout-fallback" }), { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "partial-preflight-sibling-timeout" },
      {
        requestId: "partial-preflight-sibling-timeout",
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-partial-preflight-sibling-timeout",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, "codex_quota_blocked");
    assert.deepEqual(reset.redeemAccountIds, []);
    assert.equal(reset.calls.includes("redeem"), false);
    assert.deepEqual(accountIds, []);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a routing KV outage during reset inventory never dispatches a stale fallback", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  await seedStableBankedResetBlock();
  await seedStableBankedResetBlock("account-two");
  const reset = scriptedResetProvider({
    onInventory: () => {
      kv.onRoutingRead = () => {
        throw new Error("routing KV unavailable");
      };
    },
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(new Response(JSON.stringify({ id: "cached-sibling-fallback" }), { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "reset-inventory-routing-unavailable" },
      {
        requestId: "reset-inventory-routing-unavailable",
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-reset-inventory-routing-unavailable",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, "codex_capacity_unavailable");
    assert.deepEqual(reset.redeemAccountIds, []);
    assert.equal(reset.calls.includes("redeem"), false);
    assert.deepEqual(accountIds, []);
  } finally {
    kv.onRoutingRead = null;
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a sibling credential rotation during reset inventory fences the consume and serves on the next admission", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const authorizations: string[] = [];
  const rotated = {
    ...auth("two"),
    access_token: accessToken("two-rotated"),
    refresh_token: "refresh-two-rotated",
  };
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  await seedStableBankedResetBlock();
  await seedStableBankedResetBlock("account-two");
  const reset = scriptedResetProvider({
    onInventory: async () => {
      await kv.set(AUTH_KEY, pool(auth("one"), rotated));
    },
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    authorizations.push(request.headers.get("authorization") ?? "");
    return Promise.resolve(new Response(JSON.stringify({ id: "rotated-sibling" }), { status: 200 }));
  });

  try {
    const fenced = await fetchCodexResponses(
      { input: "reset-inventory-sibling-rotated" },
      {
        requestId: "reset-inventory-sibling-rotated",
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-reset-inventory-sibling-rotated",
        },
      }
    );
    assert.equal(fenced.status, 429);
    assert.equal((await fenced.json()).error.code, "codex_capacity_unavailable");
    assert.deepEqual(reset.redeemAccountIds, []);
    assert.deepEqual(accountIds, []);

    // The rotated credential is a newly eligible ordinary account, so the next
    // admission serves it without inheriting the failed reset state.
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    const served = await fetchCodexResponses({ input: "rotated-sibling-after-fence" });
    assert.equal(served.status, 200);
    assert.deepEqual(accountIds, ["account-two"]);
    assert.deepEqual(authorizations, [`Bearer ${rotated.access_token}`]);
    await served.arrayBuffer();
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a positive capacity observation during reset inventory fences the consume", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  // Account one's quota signal predates the fresh positive capacity sample
  // taken during inventory, so that sample proves the account recovered.
  await seedStableBankedResetBlock("account-one", fixedStartMs - 60_000);
  await seedStableBankedResetBlock("account-two");
  const reset = scriptedResetProvider({
    onInventory: async () => {
      // A fresh positive capacity sample arrives after preflight. It clears the
      // account's class circuit, so the stored capacity snapshot and routing
      // fence the consume was bound to are both stale.
      await recordCodexCapacityRoutingObservations(
        [
          {
            slot: 0,
            account_id: "account-one",
            state: "available",
            source_observed_at_ms: fixedStartMs,
            snapshot_at_ms: fixedStartMs,
            windows: {
              primary: { limit_window_seconds: 10_800, used_percent: 10, reset_at_ms: fixedStartMs + 10_800_000 },
              secondary: null,
            },
            additional_rate_limits: [],
          },
        ],
        fixedStartMs
      );
    },
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(new Response(JSON.stringify({ id: "capacity-recovered" }), { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "reset-inventory-positive-capacity" },
      {
        requestId: "reset-inventory-positive-capacity",
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-reset-inventory-positive-capacity",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, "codex_capacity_unavailable");
    assert.deepEqual(reset.redeemAccountIds, []);
    assert.equal(reset.calls.includes("redeem"), false);
    assert.deepEqual(accountIds, [], "the stale reset must not dispatch a recovery inference");

    // The newly eligible account is served by a fresh admission instead.
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    const served = await fetchCodexResponses({ input: "capacity-recovered-next-admission" });
    assert.equal(served.status, 200);
    const lastServedAccountId = accountIds[accountIds.length - 1];
    assert.equal(lastServedAccountId, "account-one");
    await served.arrayBuffer();
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a whole-pool reorder during reset inventory fences the consume", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  await seedStableBankedResetBlock();
  await seedStableBankedResetBlock("account-two");
  const reset = scriptedResetProvider({
    onInventory: async () => {
      await kv.set(AUTH_KEY, pool(auth("two"), auth("one")));
    },
  });
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(new Response(JSON.stringify({ id: "reordered-sibling-fallback" }), { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "reset-inventory-pool-reordered" },
      {
        requestId: "reset-inventory-pool-reordered",
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-reset-inventory-pool-reordered",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, "codex_quota_blocked");
    assert.deepEqual(reset.redeemAccountIds, []);
    assert.equal(reset.calls.includes("redeem"), false);
    assert.deepEqual(accountIds, []);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("definitive post-reset probe failures are returned directly without sibling replay", () =>
  runSequence(async (step) => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const originalDeployFlag = config.isDeploy;
    Date.now = () => fixedStartMs;
    (config as { isDeploy: boolean }).isDeploy = true;

    try {
      for (const status of [401, 403, 429]) {
        await step(String(status), async () => {
          const accountIds: string[] = [];
          const reset = scriptedResetProvider();
          kv.auth = pool(auth("one"), auth("two"));
          kv.extra.clear();
          resetCodexAuthCacheForTest();
          resetCodexAccountRoutingForTest();
          await seedStableBankedResetBlock();
          await seedStableBankedResetBlock("account-two");
          globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const request = new Request(input, init);
            const accountId = request.headers.get("chatgpt-account-id") ?? "";
            accountIds.push(accountId);
            const headers = new Headers({ "Content-Type": "application/json" });
            if (status === 429) headers.set("Retry-After", stableBankedResetRetryAfter);
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  error: {
                    type: probeErrorType(status),
                  },
                }),
                { status, headers }
              )
            );
          });

          const response = await fetchCodexResponses(
            { input: `complete-probe-${status}` },
            {
              requestId: `complete-probe-${status}`,
              bankedReset: {
                config: liveBankedResetConfig(),
                provider: reset.provider,
                kv: kv as unknown as Kv,
                now: () => fixedStartMs,
                newOwnerToken: () => `owner-complete-probe-${status}`,
              },
            }
          );

          // Every account is exhausted, so the definitive probe answer is the
          // final response: exactly one recovery inference, no sibling replay.
          assert.equal(response.status, status);
          assert.equal(accountIds.length, 1);
          assert.deepEqual(reset.redeemAccountIds, accountIds);
          assert.equal(reset.calls.filter((call) => call === "redeem").length, 1);
          await response.arrayBuffer();
        });
      }
    } finally {
      resetCodexAuthCacheForTest();
      resetCodexAccountRoutingForTest();
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    }
  }));

test("an ambiguous post-reset transport outcome never replays on a sibling", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const reset = scriptedResetProvider();
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  await seedStableBankedResetBlock();
  await seedStableBankedResetBlock("account-two");
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.reject(new DOMException("post-reset deadline elapsed", "TimeoutError"));
  });

  try {
    await assert.rejects(() =>
      fetchCodexResponses(
        { input: "complete-probe-transport-ambiguous" },
        {
          requestId: "complete-probe-transport-ambiguous",
          bankedReset: {
            config: liveBankedResetConfig(),
            provider: reset.provider,
            kv: kv as unknown as Kv,
            now: () => fixedStartMs,
            newOwnerToken: () => "owner-complete-probe-transport-ambiguous",
          },
        }
      )
    );
    assert.equal(accountIds.length, 1);
    assert.deepEqual(reset.redeemAccountIds, accountIds);
    assert.equal(reset.calls.filter((call) => call === "redeem").length, 1);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("simultaneous all-exhausted requests share one consume and never replay it", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let signalRedeemEntered!: () => void;
  let releaseRedeem!: () => void;
  const redeemEntered = new Promise<void>((resolve) => {
    signalRedeemEntered = resolve;
  });
  const redeemGate = new Promise<void>((resolve) => {
    releaseRedeem = resolve;
  });
  const reset = scriptedResetProvider({ onRedeem: signalRedeemEntered, redeemGate });
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  await seedStableBankedResetBlock();
  await seedStableBankedResetBlock("account-two");
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const accountId = request.headers.get("chatgpt-account-id") ?? "";
    accountIds.push(accountId);
    return Promise.resolve(new Response(JSON.stringify({ id: `response-${accountId}` }), { status: 200 }));
  });
  const bankedReset = {
    config: liveBankedResetConfig(),
    provider: reset.provider,
    kv: kv as unknown as Kv,
    now: () => fixedStartMs,
    newOwnerToken: () => "owner-all-exhausted-concurrent",
  };

  try {
    const first = fetchCodexResponses({ input: "all-exhausted-concurrent-first" }, { requestId: "all-exhausted-concurrent-first", bankedReset });
    await redeemEntered;

    // The contender cannot start a second consume while the first submission
    // owns the durable record; it reports the exhausted cohort instead.
    const second = await fetchCodexResponses({ input: "all-exhausted-concurrent-second" }, { requestId: "all-exhausted-concurrent-second", bankedReset });
    assert.equal(second.status, 429);
    assert.equal(reset.idempotencyKeys.length, 1);
    assert.deepEqual(accountIds, []);

    releaseRedeem();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    assert.equal(accountIds.length, 1);
    assert.equal(reset.idempotencyKeys.length, 1);
    assert.deepEqual(reset.redeemAccountIds, accountIds);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a skipped half-open probe prevents a sibling banked-reset redemption", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const reset = scriptedResetProvider();
  let now = fixedStartMs;
  Date.now = () => now;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  kv.onRoutingRead = null;
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();

  try {
    const initial = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, now);
    assert.equal(initial.kind, "eligible");

    const second = initial.accounts.find((account) => account.auth.account_id === "account-two");
    assert.ok(second);

    const expiredAtMs = now + 1_000;
    await markCodexQuotaBlocked(
      second,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(expiredAtMs).toUTCString() },
      }),
      now
    );
    now = expiredAtMs + 1;

    resetCodexAccountRoutingForTest();
    const halfOpen = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, now);
    assert.equal(halfOpen.kind, "eligible");

    const foreignProbeCandidate = halfOpen.accounts.find((account) => account.auth.account_id === "account-two");
    assert.ok(foreignProbeCandidate?.probeRequired);

    // Another isolate owns the half-open lease, so this request must not reset
    // or dispatch it. Block the first account too so the pool has no ordinary
    // capacity while the foreign lease remains held.
    assert.ok(await claimCodexRoutingProbe(kv.auth, foreignProbeCandidate, now));
    const first = initial.accounts.find((account) => account.auth.account_id === "account-one");
    assert.ok(first);
    await markCodexQuotaBlocked(
      first,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
      }),
      now
    );
    resetCodexAccountRoutingForTest();
    globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
      return Promise.resolve(new Response(JSON.stringify({ id: "unexpected-dispatch" }), { status: 200 }));
    });

    const response = await fetchCodexResponses(
      { input: "banked-reset-probe-unavailable" },
      {
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => now,
          newOwnerToken: () => "owner-probe-unavailable",
        },
      }
    );

    // A held recovery lease is retryable, never quota proof for redemption.
    assert.equal(response.status, 429);
    assert.deepEqual(reset.calls, []);
    assert.deepEqual(accountIds, []);
    await response.arrayBuffer();
  } finally {
    kv.onRoutingRead = null;
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a 403 sibling blocks a full-pool banked reset", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const reset = scriptedResetProvider();
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const accountId = request.headers.get("chatgpt-account-id") ?? "";
    accountIds.push(accountId);
    if (accountIds.length === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
        })
      );
    }
    if (accountIds.length === 2) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "forbidden" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "response-after-reset" }), { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-after-403" },
      {
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-after-403",
        },
      }
    );

    assert.equal(response.status, 403);
    assert.deepEqual(accountIds, ["account-one", "account-two"]);
    assert.deepEqual(reset.calls, []);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("an earlier allowlisted exhausted account is redeemed after a later sibling also exhausts quota", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const reset = scriptedResetProvider();
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    if (accountIds.length <= 2) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
        })
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "response-after-earlier-reset" }), { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-earlier-allowlisted" },
      {
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-earlier-allowlisted",
        },
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(accountIds, ["account-one", "account-two", "account-one"]);
    assert.deepEqual(reset.redeemAccountIds, ["account-one"]);
    assert.deepEqual(reset.calls, ["inventory", "inventory", "redeem", "verify"]);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a non-expired raw 403 during the bounded retry never quarantines credentials", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const reset = scriptedResetProvider();
  const shortStableRetryAfter = new Date(fixedStartMs + 2_000).toUTCString();
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const accountId = request.headers.get("chatgpt-account-id") ?? "";
    accountIds.push(accountId);
    if (accountIds.length <= 2) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": shortStableRetryAfter },
        })
      );
    }
    if (accountIds.length === 3) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "forbidden" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    throw new Error("a raw 403 is terminal and must not dispatch a fourth attempt");
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-bounded-retry-403" },
      {
        retrySleep: () => Promise.resolve(),
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-bounded-retry-403",
        },
      }
    );

    // The first 429 moves the active account to the sibling; the second 429
    // captures the one bounded retry, which lands back on the active account and
    // returns a raw 403. A raw 403 with a valid bearer does not quarantine
    // credentials, and it removes the complete-cohort quota proof, so it can
    // neither authorize the banked reset nor a speculative sibling fallback.
    assert.equal(response.status, 403);
    assert.deepEqual(accountIds, ["account-one", "account-two", "account-two"]);
    assert.deepEqual(reset.redeemAccountIds, []);
    assert.equal(reset.calls.includes("redeem"), false);
    const state = parseCodexAccountRoutingState(kv.extra.get(JSON.stringify(CODEX_ACCOUNT_ROUTING_KV_KEY))?.value);
    assert.equal(state?.slots[0]?.invalid_credential_version, null);
    assert.equal(state.slots[1]?.invalid_credential_version, null);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a successful ordinary bounded retry never spends a banked reset", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const reset = scriptedResetProvider();
  const shortStableRetryAfter = new Date(fixedStartMs + 2_000).toUTCString();
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock(() => {
    inferenceCalls += 1;
    if (inferenceCalls === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": shortStableRetryAfter },
        })
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "ordinary-retry-success" }), { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "ordinary-retry-success" },
      {
        retrySleep: () => Promise.resolve(),
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-ordinary-retry-success",
        },
      }
    );

    assert.equal(response.status, 200);
    assert.equal(inferenceCalls, 2, "the ordinary retry is the only successful inference request");
    assert.deepEqual(reset.calls, [], "a served request must not read inventory or submit a reset");
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("only a complete stable usage-limit response can reach the banked-reset provider", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const stableRetryAfter = new Date(fixedStartMs + 60_000).toUTCString();
  const cases: Readonly<{
    name: string;
    status: number;
    body: string;
    retryAfter?: string;
    expectedStatus: number;
  }>[] = [
    {
      name: "generic rate limit",
      status: 429,
      body: JSON.stringify({ error: { type: "rate_limit_error" } }),
      retryAfter: stableRetryAfter,
      expectedStatus: 429,
    },
    {
      name: "burst throttling",
      status: 429,
      body: JSON.stringify({ error: { type: "requests_per_minute" } }),
      retryAfter: stableRetryAfter,
      expectedStatus: 429,
    },
    {
      name: "overload",
      status: 429,
      body: JSON.stringify({ error: { type: "server_error" } }),
      retryAfter: stableRetryAfter,
      expectedStatus: 429,
    },
    {
      name: "policy error",
      status: 429,
      body: JSON.stringify({ error: { type: "policy_error" } }),
      retryAfter: stableRetryAfter,
      expectedStatus: 429,
    },
    {
      name: "invalid request",
      status: 429,
      body: JSON.stringify({ error: { type: "invalid_request_error" } }),
      retryAfter: stableRetryAfter,
      expectedStatus: 429,
    },
    {
      name: "unknown future error type",
      status: 429,
      body: JSON.stringify({ error: { type: "future_quota_signal" } }),
      retryAfter: stableRetryAfter,
      expectedStatus: 429,
    },
    {
      name: "malformed body",
      status: 429,
      body: "{not JSON",
      retryAfter: stableRetryAfter,
      expectedStatus: 429,
    },
    {
      name: "relative retry-after cannot name a reset window",
      status: 429,
      body: JSON.stringify({ error: { type: "usage_limit_reached" } }),
      retryAfter: "60",
      expectedStatus: 429,
    },
    {
      name: "invalid decimal retry-after",
      status: 429,
      body: JSON.stringify({ error: { type: "usage_limit_reached" } }),
      retryAfter: "0.5",
      expectedStatus: 429,
    },
    {
      name: "expired retry-after",
      status: 429,
      body: JSON.stringify({ error: { type: "usage_limit_reached" } }),
      retryAfter: new Date(fixedStartMs - 1_000).toUTCString(),
      expectedStatus: 429,
    },
    {
      name: "overflowing retry-after",
      status: 429,
      body: JSON.stringify({ error: { type: "usage_limit_reached" } }),
      retryAfter: "999999999999999999999999999999999999",
      expectedStatus: 429,
    },
    {
      name: "401",
      status: 401,
      body: JSON.stringify({ error: { type: "invalid_auth" } }),
      expectedStatus: 401,
    },
    {
      name: "403",
      status: 403,
      body: JSON.stringify({ error: { type: "forbidden" } }),
      expectedStatus: 403,
    },
  ];

  try {
    Date.now = () => fixedStartMs;
    (config as { isDeploy: boolean }).isDeploy = true;
    for (const testCase of cases) {
      kv.auth = pool(auth("one"));
      kv.extra.clear();
      resetCodexAuthCacheForTest();
      resetCodexAccountRoutingForTest();
      const reset = scriptedResetProvider();
      globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
        const url = requestUrl(input);
        if (url.includes("oauth/token")) {
          return Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }));
        }
        const headers = new Headers({ "Content-Type": "application/json" });
        if (testCase.retryAfter) headers.set("Retry-After", testCase.retryAfter);
        return Promise.resolve(new Response(testCase.body, { status: testCase.status, headers }));
      });

      const response = await fetchCodexResponses(
        { input: `nonqualifying-${testCase.name}` },
        {
          retrySleep: async () => {},
          bankedReset: {
            config: liveBankedResetConfig(),
            provider: reset.provider,
            kv: kv as unknown as Kv,
            now: () => fixedStartMs,
            newOwnerToken: () => `owner-nonqualifying-${testCase.name}`,
          },
        }
      );
      assert.equal(response.status, testCase.expectedStatus, testCase.name);
      assert.deepEqual(reset.calls, [], testCase.name);
    }
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a later non-qualifying 429 clears an earlier banked-reset candidate", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const reset = scriptedResetProvider();
  const stableRetryAfter = new Date(fixedStartMs + 60_000).toUTCString();
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const accountId = request.headers.get("chatgpt-account-id") ?? "";
    accountIds.push(accountId);
    const errorType = accountIds.length === 1 ? "usage_limit_reached" : "rate_limit_error";
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: errorType } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": stableRetryAfter },
      })
    );
  });

  try {
    const response = await fetchCodexResponses(
      { input: "later-nonqualifying-429" },
      {
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-later-nonqualifying-429",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.deepEqual(accountIds, ["account-one", "account-two"]);
    assert.deepEqual(reset.calls, []);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("post-reset inference may return one normal 429 but never triggers a second redemption", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const reset = scriptedResetProvider();
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock(() => {
    inferenceCalls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
      })
    );
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-second-429" },
      {
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-second-429",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.equal(inferenceCalls, 2);
    assert.deepEqual(reset.calls, ["inventory", "redeem", "verify"]);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

beforeEach(installHarness);
afterEach(cleanupHarness);
