import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test, beforeEach, afterEach } from "bun:test";
import { type Kv } from "#kv";
// codex-auth-cache suite, part 4 of 4: tests moved out of tests/codex-auth-cache.test.ts.

import assert from "node:assert/strict";
import {
  installHarness,
  cleanupHarness,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_BANKED_RESET_LEASE_MS,
  CODEX_HALF_OPEN_LEASE_MS,
  CODEX_QUOTA_BLOCKED_ERROR_CODE,
  type CodexBankedResetConfig,
  type CodexUsageResetProvider,
  auth,
  bankedResetRequestOptions,
  config,
  fetchCodexResponses,
  fixedStartMs,
  getCodexRoutingError,
  getCodexRoutingProbe,
  kv,
  liveBankedResetConfig,
  markCodexResponseCompleted,
  parseCodexAccountRoutingState,
  parseCodexActiveAccountSelection,
  pool,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  scriptedResetProvider,
  seedStableBankedResetBlock,
  selectCodexRoutingAccountsStrong,
  stableBankedResetRetryAfter,
} from "./helpers/codex-auth-cache-harness.ts";

test("a failed banked-reset probe gets a bounded retry and eventually reopens the account", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const reset = scriptedResetProvider();
  const inferenceAccounts: string[] = [];
  const delayedPropagationRetryAfter = new Date(fixedStartMs + 7 * 24 * 60 * 60_000).toUTCString();
  const delayedPropagationResetAtMs = fixedStartMs + 7 * 24 * 60 * 60_000;
  let now = fixedStartMs;
  Date.now = () => now;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const accountId = request.headers.get("chatgpt-account-id") ?? "";
    inferenceAccounts.push(accountId);
    if (inferenceAccounts.length > 5) {
      return Promise.resolve(new Response(JSON.stringify({ id: "recovered-after-propagation" }), { status: 200 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": delayedPropagationRetryAfter },
      })
    );
  });

  const bankedReset = {
    config: liveBankedResetConfig(),
    provider: reset.provider,
    kv: kv as unknown as Kv,
    now: () => now,
    newOwnerToken: () => "owner-failed-probe",
  };
  try {
    const first = await fetchCodexResponses({ input: "banked-reset-probe-fails" }, { bankedReset });
    assert.equal(first.status, 429);
    assert.deepEqual(inferenceAccounts, ["account-one", "account-two", "account-one"]);
    assert.equal(reset.calls.filter((call) => call === "redeem").length, 1);
    assert.equal(reset.calls.filter((call) => call === "verify").length, 1);

    // While the recovery lease is held, the request reports the retryable quota
    // classification and neither dispatches nor spends another reset.
    const inferenceCountAfterFirst = inferenceAccounts.length;
    const resetCallsAfterFirst = [...reset.calls];
    const held = await fetchCodexResponses({ input: "after-failed-bank-reset-probe" }, { bankedReset });
    assert.equal(held.status, 429);
    assert.equal(inferenceAccounts.length, inferenceCountAfterFirst);
    assert.deepEqual(reset.calls, resetCallsAfterFirst);
    await held.arrayBuffer();

    // Each expired lease grants one bounded probe; the ledger is never spent
    // again, and the account eventually reopens on a successful probe.
    let recovered: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      now += CODEX_HALF_OPEN_LEASE_MS + 1;
      const response = await fetchCodexResponses({ input: `during-reset-propagation-${attempt}` }, { bankedReset });
      if (response.status === 200) {
        recovered = response;
        break;
      }
      assert.equal(response.status, 429);
      assert.equal(inferenceAccounts.at(-1), "account-one");
      assert.deepEqual(reset.calls, resetCallsAfterFirst);
      const routingAfterProbe = parseCodexAccountRoutingState((await kv.get(CODEX_ACCOUNT_ROUTING_KV_KEY, { consistency: "strong" })).value);
      assert.equal(routingAfterProbe?.slots[0]?.quota_blocked_until_ms, now + CODEX_HALF_OPEN_LEASE_MS);
      assert.equal(routingAfterProbe.slots[0]?.banked_reset_generation_ambiguous, true);
      await response.arrayBuffer();
    }
    assert.ok(recovered, "the bounded probe retry eventually reopens the account");
    assert.deepEqual(reset.calls, resetCallsAfterFirst);
    await markCodexResponseCompleted(recovered);
    const routing = parseCodexAccountRoutingState((await kv.get(CODEX_ACCOUNT_ROUTING_KV_KEY, { consistency: "strong" })).value);
    assert.equal(routing?.slots[0]?.quota_blocked_until_ms, null);
    assert.equal(routing.slots[0]?.banked_reset_generation_ambiguous, false);
    assert.equal(routing.slots[1]?.quota_blocked_until_ms, delayedPropagationResetAtMs);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a stale verified reset recovers the existing account without another reset", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const reset = scriptedResetProvider();
  const delayedResetAtMs = fixedStartMs + 7 * 24 * 60 * 60_000;
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
      inferenceCalls <= 2
        ? new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
          })
        : new Response(JSON.stringify({ id: "recovered-stale-reset" }), { status: 200 })
    );
  });

  const bankedReset = {
    config: liveBankedResetConfig(),
    provider: reset.provider,
    kv: kv as unknown as Kv,
    now: () => fixedStartMs,
    newOwnerToken: () => "owner-stale-verified-reset",
  };
  try {
    const first = await fetchCodexResponses({ input: "seed-stale-verified-reset" }, { bankedReset });
    assert.equal(first.status, 429);
    assert.equal(inferenceCalls, 2);
    assert.deepEqual(reset.calls, ["inventory", "redeem", "verify"]);

    const routingKey = JSON.stringify(CODEX_ACCOUNT_ROUTING_KV_KEY);
    const current = parseCodexAccountRoutingState(kv.extra.get(routingKey)?.value);
    if (current === null) throw new Error("expected durable routing state");
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      ...current,
      slots: [
        {
          ...current.slots[0],
          quota_blocked_until_ms: delayedResetAtMs,
          generation: current.slots[0].generation + 1,
          probe_lease: null,
          banked_reset_generation_ambiguous: true,
        },
      ],
    });
    resetCodexAccountRoutingForTest();

    const recovered = await fetchCodexResponses({ input: "recover-stale-verified-reset" }, { bankedReset });
    assert.equal(recovered.status, 200);
    assert.equal(inferenceCalls, 3);
    assert.deepEqual(reset.calls, ["inventory", "redeem", "verify"]);
    await markCodexResponseCompleted(recovered);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("all-blocked routing recovers an unknown reset while new submissions are disabled", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const reset = scriptedResetProvider({ redeemKind: "unknown" });
  let now = fixedStartMs;
  let live = true;
  let inferenceCalls = 0;
  Date.now = () => now;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock(() => {
    inferenceCalls += 1;
    return Promise.resolve(
      inferenceCalls === 1
        ? new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
          })
        : new Response(JSON.stringify({ id: "recovered-after-unknown" }), { status: 200 })
    );
  });

  const liveConfig = liveBankedResetConfig();
  const disabledConfig: CodexBankedResetConfig = { ...liveConfig, enabled: false, mode: "disabled" };
  const bankedReset = {
    config: liveConfig,
    reloadConfig: () => (live ? liveConfig : disabledConfig),
    provider: reset.provider,
    kv: kv as unknown as Kv,
    now: () => now,
    newOwnerToken: () => "owner-recovery",
  };
  try {
    const first = await fetchCodexResponses({ input: "unknown-reset" }, { bankedReset });
    assert.equal(first.status, 429);
    assert.deepEqual(reset.calls, ["inventory", "redeem"]);

    // Let the durable unknown record's lease expire while retaining its
    // original 60-second routing fence, then simulate an operator rollback.
    now += CODEX_BANKED_RESET_LEASE_MS + 1;
    live = false;
    const recovered = await fetchCodexResponses({ input: "recover-reset" }, { bankedReset });
    assert.equal(recovered.status, 200);
    assert.equal(inferenceCalls, 2);
    assert.deepEqual(reset.calls, ["inventory", "redeem", "lookup", "verify"]);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("an all-blocked cohort with credit only on the inactive sibling elects it after the reset", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const originalCodexBaseUrl = config.codexBaseUrl;
  const consumeAccountIds: string[] = [];
  const inferenceAccountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean; codexBaseUrl: string }).isDeploy = true;
  (config as { isDeploy: boolean; codexBaseUrl: string }).codexBaseUrl = "https://upstream-reset.test/backend-api/codex";
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();

  try {
    // Block the first configured account, then let the strong selector admit the
    // second as the durable active account before it is exhausted too.
    await seedStableBankedResetBlock("account-one");
    const bootstrapped = await selectCodexRoutingAccountsStrong(kv.auth, kv.auth.accounts, fixedStartMs);
    assert.equal(bootstrapped.kind, "eligible");
    assert.equal(bootstrapped.accounts[0]?.auth.account_id, "account-two");
    await seedStableBankedResetBlock("account-two");

    globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      const accountId = request.headers.get("chatgpt-account-id") ?? "";
      if (request.url.endsWith("/backend-api/codex/responses")) {
        inferenceAccountIds.push(accountId);
        return Promise.resolve(Response.json({ id: `response-${accountId}` }));
      }
      if (request.url.endsWith("/backend-api/wham/rate-limit-reset-credits")) {
        return Promise.resolve(
          Response.json({
            available_count: accountId === "account-one" ? 1 : 0,
            credits: accountId === "account-one" ? [{ id: "credit-account-one", status: "available", reset_type: "codex_rate_limits", expires_at: null }] : [],
          })
        );
      }
      if (request.url.endsWith("/backend-api/wham/rate-limit-reset-credits/consume")) {
        consumeAccountIds.push(accountId);
        return Promise.resolve(Response.json({ code: "reset", windows_reset: 1 }));
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    });

    const armed = await fetchCodexResponses({ input: "inactive-sibling-credit-arm" }, bankedResetRequestOptions("inactive-sibling-credit-arm"));
    assert.equal(armed.status, 429);
    assert.equal((await armed.json()).error.code, "codex_quota_blocked");

    const consumed = await fetchCodexResponses({ input: "inactive-sibling-credit-consume" }, bankedResetRequestOptions("inactive-sibling-credit-consume"));
    assert.equal(consumed.status, 200);
    assert.ok(getCodexRoutingProbe(consumed));
    assert.deepEqual(consumeAccountIds, ["account-one"]);
    assert.deepEqual(inferenceAccountIds, ["account-one"]);

    const active = parseCodexActiveAccountSelection(kv.extra.get(JSON.stringify(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY))?.value);
    assert.equal(active?.slot, 0);
    assert.equal(active.generation, 2);
    await markCodexResponseCompleted(consumed);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean; codexBaseUrl: string }).isDeploy = originalDeployFlag;
    (config as { isDeploy: boolean; codexBaseUrl: string }).codexBaseUrl = originalCodexBaseUrl;
  }
});

test("a concurrent active switch during a verified reset prevents stale recovery inference", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const baseReset = scriptedResetProvider();
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
  const provider: CodexUsageResetProvider = {
    ...baseReset.provider,
    verifyApplied: async () => {
      baseReset.calls.push("verify");
      const active = parseCodexActiveAccountSelection(kv.extra.get(JSON.stringify(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY))?.value);
      if (!active) throw new Error("expected a durable active selection");
      await kv.set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, { ...active, generation: active.generation + 1, updated_at_ms: fixedStartMs });
      return true;
    },
  };

  try {
    const response = await fetchCodexResponses(
      { input: "concurrent-active-switch" },
      {
        requestId: "concurrent-active-switch",
        bankedReset: {
          config: liveBankedResetConfig(),
          provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-concurrent-active-switch",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.equal(getCodexRoutingError(response), CODEX_QUOTA_BLOCKED_ERROR_CODE);
    assert.equal(inferenceCalls, 1, "a superseded reset must not start a recovery inference");
    assert.equal(getCodexRoutingProbe(response), null);
    assert.deepEqual(baseReset.calls, ["inventory", "redeem", "verify"]);
    await response.arrayBuffer();
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
