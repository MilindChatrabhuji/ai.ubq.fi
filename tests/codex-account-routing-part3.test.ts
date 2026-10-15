import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import { type Kv } from "#kv";
// codex-account-routing suite, part 3 of 3: tests moved out of tests/codex-account-routing.test.ts.

import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_CAPACITY_ROUTING_MAX_AGE_MS,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  type CodexAuthPoolState,
  PROVIDER_CAPACITY_SNAPSHOT_KEY,
  PROVIDER_SELECTION_KV_KEY,
  RoutingKv,
  claimCodexRoutingProbe,
  fetchCodexResponses,
  getCodexQuotaBlockFence,
  getCodexRoutingError,
  httpDateQuotaResponse,
  key,
  markCodexCredentialInvalid,
  markCodexQuotaBlocked,
  parseCodexAccountRoutingState,
  parseCodexActiveAccountSelection,
  pool,
  reconcileCodexQuotaAfterVerifiedReset,
  reconcileCodexRoutingAccount,
  recordCodexCapacityRoutingObservations,
  refreshCodexActiveAccountAdmission,
  requestUrl,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  resetProviderSelectionCacheForTest,
  seedSubscriptionSelection,
  selectCodexRoutingAccounts,
  selectCodexRoutingAccountsStrong,
  setKvForTest,
  singlePool,
} from "./helpers/codex-account-routing-harness.ts";

// Counts only upstream attempts that carry this test's own request body.
//
// The process-wide fetch stub otherwise also observes unrelated background
// work: the paid-fallback quota refreshes schedule their own requests on timers
// that outlive the test which armed them (src/provider/metered.ts,
// src/provider/surplus.ts). A full-suite run intermittently counted two of
// those inside a zero-dispatch window and failed the assertion below even
// though the request under test never reached any upstream. Attributing the
// count to this test's own body keeps the assertion about the routing decision
// while ignoring bookkeeping traffic that no test owns.
const countingUpstreamFetch = (marker: string, onDispatch: () => void): typeof globalThis.fetch =>
  createFetchMock(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = await request
      .clone()
      .text()
      .catch(() => "");
    if (body.includes(marker)) onDispatch();
    return new Response(null, { status: 200 });
  });

test("clearing a class preserves an independent unknown quota fence", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const standardDeadline = now + 60_000;
    const unknownDeadline = now + 120_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.6-luna");
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(standardDeadline).toUTCString() },
      }),
      now
    );
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.ok(state);

    const block = (blockedUntilMs: number) => ({
      blocked_until_ms: blockedUntilMs,
      source: "header_retry_after" as const,
      legacy_fallback: false,
      quota_signal_observed_at_ms: now,
      observed_reset_at_ms: null,
      observed_reset_at_is_stable: false,
      banked_reset_generation_ambiguous: false,
      banked_reset_recovery_probe_pending: false,
    });
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      ...state,
      slots: [
        {
          ...state.slots[0],
          quota_blocked_until_ms: unknownDeadline,
          quota_block_source: "header_retry_after",
          quota_blocked_classes: ["standard", "unknown"],
          quota_blocks_by_class: {
            standard: block(standardDeadline),
            unknown: block(unknownDeadline),
          },
          quota_signal_observed_at_ms: now,
        },
      ],
    });
    resetCodexAccountRoutingForTest();
    await recordCodexCapacityRoutingObservations(
      [
        {
          slot: 0,
          account_id: "one",
          state: "available",
          source_observed_at_ms: now + 1,
          snapshot_at_ms: now + 1,
          windows: {
            primary: { limit_window_seconds: 604_800, used_percent: 50, reset_at_ms: standardDeadline },
            secondary: null,
          },
          additional_rate_limits: [],
        },
      ],
      now + 1
    );
    await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 2, "gpt-5.6-luna");

    const migrated = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(migrated?.slots[0]?.quota_blocks_by_class?.standard, undefined);
    assert.equal(migrated?.slots[0]?.quota_blocks_by_class?.unknown?.blocked_until_ms, unknownDeadline);
    assert.equal(migrated.slots[0]?.quota_blocks_by_class?.unknown?.legacy_fallback, false);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a newer inference 429 remains authoritative over an older positive capacity sample", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await recordCodexCapacityRoutingObservations(
      [
        {
          slot: 1,
          account_id: "two",
          state: "available",
          source_observed_at_ms: now + 1,
          snapshot_at_ms: now + 1,
          windows: {
            primary: { limit_window_seconds: 10_800, used_percent: 50, reset_at_ms: now + 10_800_000 },
            secondary: { limit_window_seconds: 86_400, used_percent: 50, reset_at_ms: now + 86_400_000 },
          },
          additional_rate_limits: [],
        },
      ],
      now + 1
    );
    const positive = await selectCodexRoutingAccounts(pool, pool.accounts, now + 2);
    assert.equal(positive.kind, "eligible");

    const accountTwo = positive.accounts.find((account) => account.auth.account_id === "two");
    assert.ok(accountTwo);
    const blockedUntil = now + 60_000;
    await markCodexQuotaBlocked(
      accountTwo,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(blockedUntil).toUTCString() },
      }),
      now + 2
    );

    const selected = await selectCodexRoutingAccounts(pool, pool.accounts, now + 3);
    assert.equal(selected.kind, "eligible");

    assert.equal(
      selected.accounts.some((account) => account.auth.account_id === "two"),
      false
    );
    assert.equal(
      selected.blockedAccounts.some((account) => account.auth.account_id === "two"),
      true
    );
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[1]?.quota_blocked_until_ms, blockedUntil);
    assert.equal(state.slots[1]?.quota_signal_observed_at_ms, now + 2);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("stale positive capacity cannot reopen a quota circuit", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const deadline = now + 60_000;
    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(deadline).toUTCString() },
      }),
      now
    );
    await recordCodexCapacityRoutingObservations(
      [
        {
          slot: 0,
          account_id: "one",
          state: "available",
          source_observed_at_ms: now - CODEX_CAPACITY_ROUTING_MAX_AGE_MS - 1,
          snapshot_at_ms: now - CODEX_CAPACITY_ROUTING_MAX_AGE_MS - 1,
          windows: {
            primary: { limit_window_seconds: 10_800, used_percent: 50, reset_at_ms: now + 10_800_000 },
            secondary: null,
          },
          additional_rate_limits: [],
        },
      ],
      now
    );
    const selected = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1);
    assert.equal(selected.kind, "quota_blocked");
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[0]?.quota_blocked_until_ms, deadline);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("the persisted analytics snapshot reopens the matching account for its model", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now, "gpt-5.3-codex-spark");
    assert.equal(initial.kind, "eligible");

    const accountTwo = initial.accounts.find((account) => account.auth.account_id === "two");
    assert.ok(accountTwo);
    const deadline = now + 60_000;
    await markCodexQuotaBlocked(
      accountTwo,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(deadline).toUTCString() },
      }),
      now
    );
    await kv.set(PROVIDER_CAPACITY_SNAPSHOT_KEY, {
      snapshot_at_ms: now + 1,
      sources: [
        {
          source: "codex",
          slot: 2,
          state: "available",
          source_observed_at_ms: now + 1,
          snapshot_at_ms: now + 1,
          windows: {
            primary: { limit_window_seconds: 604_800, used_percent: 100, reset_at_ms: now + 604_800_000 },
            secondary: null,
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              metered_feature: "codex_bengalfox",
              windows: {
                primary: { limit_window_seconds: 18_000, used_percent: 50, reset_at_ms: now + 18_000_000 },
                secondary: null,
              },
            },
          ],
        },
      ],
    });
    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(pool, pool.accounts, now + 2, "gpt-5.3-codex-spark");
    assert.equal(selected.kind, "eligible");

    assert.equal(selected.accounts[0]?.auth.account_id, "one");
    const reopened = selected.accounts.find((account) => account.auth.account_id === "two");
    assert.equal(reopened?.quotaHeadroom, 50);
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[1]?.quota_blocked_until_ms, null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a legacy slot-only dashboard snapshot cannot attach to a replacement account", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const replacement = {
      access_token: "replacement-access",
      refresh_token: "replacement-refresh",
      account_id: "replacement",
      updated_at_ms: now + 1,
    };
    const replacementPool: CodexAuthPoolState = { accounts: [replacement], updated_at_ms: now + 1 };
    const initial = await selectCodexRoutingAccounts(replacementPool, replacementPool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const deadline = now + 60_000;
    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(deadline).toUTCString() },
      }),
      now + 1
    );
    await kv.set(PROVIDER_CAPACITY_SNAPSHOT_KEY, {
      snapshot_at_ms: now,
      sources: [
        {
          source: "codex",
          slot: 1,
          state: "available",
          source_observed_at_ms: now,
          snapshot_at_ms: now,
          windows: {
            primary: { limit_window_seconds: 10_800, used_percent: 50, reset_at_ms: now + 10_800_000 },
            secondary: null,
          },
          additional_rate_limits: [],
        },
      ],
    });
    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(replacementPool, replacementPool.accounts, now + 2);
    assert.equal(selected.kind, "quota_blocked");
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[0]?.quota_blocked_until_ms, deadline);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("capacity reconciliation uses the requested model instead of any additional headroom", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const accountTwo = initial.accounts.find((account) => account.auth.account_id === "two");
    assert.ok(accountTwo);
    const blockedUntil = now + 60_000;
    await markCodexQuotaBlocked(
      accountTwo,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(blockedUntil).toUTCString() },
      }),
      now
    );

    await recordCodexCapacityRoutingObservations(
      [
        {
          slot: 1,
          account_id: "two",
          state: "available",
          source_observed_at_ms: now + 1,
          snapshot_at_ms: now + 1,
          windows: {
            primary: { limit_window_seconds: 10_800, used_percent: 100, reset_at_ms: now + 10_800_000 },
            secondary: null,
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              metered_feature: "codex_bengalfox",
              windows: {
                primary: { limit_window_seconds: 18_000, used_percent: 50, reset_at_ms: now + 18_000_000 },
                secondary: null,
              },
            },
          ],
        },
      ],
      now + 1
    );

    const nonSpark = await selectCodexRoutingAccounts(pool, pool.accounts, now + 2, "gpt-5.2-codex");
    assert.equal(nonSpark.kind, "eligible");

    assert.equal(
      nonSpark.accounts.some((account) => account.auth.account_id === "two"),
      false
    );
    assert.equal(
      nonSpark.blockedAccounts.some((account) => account.auth.account_id === "two"),
      true
    );

    const spark = await selectCodexRoutingAccounts(pool, pool.accounts, now + 2, "gpt-5.3-codex-spark");
    assert.equal(spark.kind, "eligible");

    assert.equal(spark.accounts[0]?.auth.account_id, "one");
    const sparkTwo = spark.accounts.find((account) => account.auth.account_id === "two");
    assert.equal(sparkTwo?.quotaHeadroom, 50);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("capacity reconciliation preserves reset ambiguity and an active recovery probe", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const account = initial.accounts[0];
    const resetAtMs = now + 60_000;
    await markCodexQuotaBlocked(
      account,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(resetAtMs).toUTCString() },
      }),
      now
    );
    const routingGeneration = await getCodexQuotaBlockFence(account, resetAtMs);
    assert.equal(typeof routingGeneration, "number");
    if (routingGeneration === null) return;
    const recoveryProbe = await reconcileCodexQuotaAfterVerifiedReset(account, {
      quotaResetAtMs: resetAtMs,
      routingGeneration,
    });
    assert.ok(recoveryProbe);

    const before = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(before?.slots[0]?.banked_reset_generation_ambiguous, true);
    assert.equal(before.slots[0]?.banked_reset_recovery_probe_pending, true);
    assert.equal(before.slots[0]?.probe_lease?.token, recoveryProbe.probeToken);

    await recordCodexCapacityRoutingObservations(
      [
        {
          slot: 0,
          account_id: "one",
          state: "available",
          source_observed_at_ms: now + 1,
          snapshot_at_ms: now + 1,
          windows: {
            primary: { limit_window_seconds: 10_800, used_percent: 50, reset_at_ms: now + 10_800_000 },
            secondary: null,
          },
          additional_rate_limits: [],
        },
      ],
      now + 1
    );

    const after = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(after?.slots[0]?.banked_reset_generation_ambiguous, true);
    assert.equal(after.slots[0]?.banked_reset_recovery_probe_pending, true);
    assert.equal(after.slots[0]?.observed_reset_at_ms, resetAtMs);
    assert.equal(after.slots[0]?.probe_lease?.token, recoveryProbe.probeToken);
    assert.equal(after.slots[0]?.generation, before.slots[0]?.generation);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("capacity observations expire old account identities from durable routing state", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const firstAtMs = 1_700_000_000_000;
    const secondAtMs = firstAtMs + CODEX_CAPACITY_ROUTING_MAX_AGE_MS + 1;
    const observation = (accountId: string, snapshotAtMs: number, usedPercent: number) => ({
      slot: 0,
      account_id: accountId,
      state: "available" as const,
      source_observed_at_ms: snapshotAtMs,
      snapshot_at_ms: snapshotAtMs,
      windows: {
        primary: { limit_window_seconds: 10_800, used_percent: usedPercent, reset_at_ms: snapshotAtMs + 10_800_000 },
        secondary: null,
      },
      additional_rate_limits: [],
    });

    await recordCodexCapacityRoutingObservations([observation("replaced-account", firstAtMs, 20)], firstAtMs);
    await recordCodexCapacityRoutingObservations([observation("current-account", secondAtMs, 40)], secondAtMs);

    const stored = kv.values.get(key(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY)) as
      | {
          observations?: readonly { snapshot_at_ms?: number; windows?: { primary?: { used_percent?: number } } }[];
        }
      | undefined;
    assert.equal(stored?.observations?.length, 1);
    assert.equal(stored.observations[0]?.snapshot_at_ms, secondAtMs);
    assert.equal(stored.observations[0]?.windows?.primary?.used_percent, 40);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a relative Retry-After quota answer moves the active account to the sibling", async () => {
  const kv = new RoutingKv();
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
  const calls: string[] = [];
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
  try {
    globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.endsWith("/responses")) throw new Error(`Unexpected Codex URL: ${url}`);
      calls.push(new Headers(init?.headers).get("ChatGPT-Account-ID") ?? "");
      if (calls.length === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "3600" },
          })
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ id: "served-by-sibling" }), { status: 200 }));
    });

    const response = await fetchCodexResponses({ model: "gpt-5-routing", input: "relative-quota" }, { retrySleep: async () => {} });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["one", "two"]);
    assert.equal(((await response.json()) as { id?: string }).id, "served-by-sibling");
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
  }
});

test("a generic 429 retries the same account and never switches siblings", async () => {
  const kv = new RoutingKv();
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
  const calls: string[] = [];
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
  try {
    globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.endsWith("/responses")) throw new Error(`Unexpected Codex URL: ${url}`);
      calls.push(new Headers(init?.headers).get("ChatGPT-Account-ID") ?? "");
      if (calls.length === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { type: "rate_limit_error", code: "codex_rate_limited" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "1" },
          })
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ id: "same-account-retry" }), { status: 200 }));
    });

    const response = await fetchCodexResponses({ model: "gpt-5-routing", input: "generic-429" }, { retrySleep: async () => {} });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["one", "one"]);
    await response.arrayBuffer();
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
  }
});

test("a mixed quota and current-invalid-credential cohort authorizes paid fallback", async () => {
  const kv = new RoutingKv();
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
  let dispatches = 0;
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
  try {
    globalThis.fetch = countingUpstreamFetch("mixed-cohort", () => {
      dispatches += 1;
    });
    const initial = await selectCodexRoutingAccounts(authPool, authPool.accounts, now, "gpt-5-routing");
    assert.equal(initial.kind, "eligible");
    await markCodexQuotaBlocked(initial.accounts[0], httpDateQuotaResponse(now + 60_000), now);
    await markCodexCredentialInvalid(initial.accounts[1]);
    resetCodexAccountRoutingForTest();

    const selected = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, Date.now(), "gpt-5-routing");
    assert.equal(selected.kind, "quota_blocked");
    assert.equal(selected.fullCohortUnavailable, true);
    assert.equal(selected.fullCohortExhausted, false);

    const response = await fetchCodexResponses({ model: "gpt-5-routing", input: "mixed-cohort" }, { retrySleep: async () => {} });
    assert.equal(response.status, 503);
    assert.equal(getCodexRoutingError(response), "codex_subscriptions_unavailable");
    assert.equal(response.headers.get("retry-after"), null);
    assert.equal(dispatches, 0);
    await response.arrayBuffer();
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
  }
});

test("a genuinely all-exhausted relative cohort preserves paid fallback eligibility", async () => {
  const kv = new RoutingKv();
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
  let dispatches = 0;
  const relativeQuotaResponse = (): Response =>
    new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "3600" },
    });
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
  try {
    globalThis.fetch = createFetchMock(
      countingUpstreamFetch("relative-exhausted", () => {
        dispatches += 1;
      })
    );
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(initial.kind, "eligible");
    await markCodexQuotaBlocked(initial.accounts[0], relativeQuotaResponse(), now);
    await markCodexQuotaBlocked(initial.accounts[1], relativeQuotaResponse(), now);
    resetCodexAccountRoutingForTest();

    const response = await fetchCodexResponses({ model: "gpt-5-routing", input: "relative-exhausted" }, { retrySleep: async () => {} });
    assert.equal(response.status, 429);
    assert.equal(getCodexRoutingError(response), "codex_quota_blocked");
    assert.equal(dispatches, 0);
    await response.arrayBuffer();
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
  }
});

test("a held recovery lease alone cannot open paid fallback", async () => {
  const kv = new RoutingKv();
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
  let dispatches = 0;
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
  try {
    globalThis.fetch = createFetchMock(
      countingUpstreamFetch("lease-only", () => {
        dispatches += 1;
      })
    );
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(initial.kind, "eligible");
    await markCodexQuotaBlocked(initial.accounts[0], httpDateQuotaResponse(now + 60_000), now);
    await markCodexQuotaBlocked(initial.accounts[1], httpDateQuotaResponse(now - 1_000), now - 10_000);
    resetCodexAccountRoutingForTest();
    const expired = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(expired.kind, "eligible");
    const probeAccount = expired.accounts.find((account) => account.auth.account_id === "two");
    assert.ok(probeAccount);
    assert.equal(probeAccount.probeRequired, true);
    assert.ok(await claimCodexRoutingProbe(pool, probeAccount));
    resetCodexAccountRoutingForTest();

    const response = await fetchCodexResponses({ model: "gpt-5-routing", input: "lease-only" }, { retrySleep: async () => {} });
    assert.equal(response.status, 429);
    assert.equal(getCodexRoutingError(response), null);
    assert.equal(dispatches, 0);
    await response.arrayBuffer();
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
  }
});

test("a claimed expired-circuit probe refreshes its own admission fence exactly once", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const authPool: CodexAuthPoolState = { accounts: [{ ...singlePool.accounts[0], updated_at_ms: now }], updated_at_ms: now };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
    const initial = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(initial.kind, "eligible");
    await markCodexQuotaBlocked(initial.accounts[0], httpDateQuotaResponse(now - 1_000), now - 10_000);
    resetCodexAccountRoutingForTest();

    const expired = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(expired.kind, "eligible");
    const probeRequired = expired.accounts[0];
    assert.equal(probeRequired.probeRequired, true);
    const claimed = await claimCodexRoutingProbe(authPool, probeRequired);
    assert.ok(claimed);
    assert.equal(await refreshCodexActiveAccountAdmission(claimed), true);

    const active = parseCodexActiveAccountSelection(kv.values.get(key(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)));
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.ok(state);
    assert.equal(active?.generation, probeRequired.activeGeneration);
    assert.equal(active?.routing_generation, state.slots[0]?.generation);
    assert.ok(state.slots[0]?.probe_lease);

    resetCodexAccountRoutingForTest();
    const held = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(held.kind, "routing_unavailable");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("same-account credential rotation refreshes admission without changing the active generation", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const authPool: CodexAuthPoolState = { accounts: [{ ...singlePool.accounts[0], updated_at_ms: now }], updated_at_ms: now };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
    const initial = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(initial.kind, "eligible");
    const routed = initial.accounts[0];
    const rotated = { ...routed.auth, access_token: "rotated-access-token", updated_at_ms: now + 1 };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, { accounts: [rotated], updated_at_ms: now + 1 });
    const reconciled = await reconcileCodexRoutingAccount(routed, rotated);
    assert.equal(await refreshCodexActiveAccountAdmission(reconciled), true);

    const active = parseCodexActiveAccountSelection(kv.values.get(key(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)));
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(active?.generation, routed.activeGeneration);
    assert.equal(active?.credential_version, reconciled.credentialVersion);
    assert.equal(active.routing_generation, state?.slots[0]?.generation);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a stale admission cannot dispatch after a concurrent active switch", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
    const initial = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(initial.kind, "eligible");
    const admitted = initial.accounts[0];
    assert.equal(admitted.auth.account_id, "one");

    await markCodexQuotaBlocked(admitted, httpDateQuotaResponse(now + 60_000), now);
    const switched = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(switched.kind, "eligible");
    assert.equal(switched.accounts[0]?.auth.account_id, "two");
    assert.notEqual(switched.accounts[0]?.activeGeneration, admitted.activeGeneration);

    assert.equal(await refreshCodexActiveAccountAdmission(admitted), false);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a stale admission cannot dispatch after concurrent credential invalidation", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
    const initial = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(initial.kind, "eligible");
    const admitted = initial.accounts[0];
    assert.equal(admitted.auth.account_id, "one");

    // Another concurrent request marks this credential invalid before the
    // admitted request reaches its final pre-transport fence.
    await markCodexCredentialInvalid(admitted);

    // The final admission must reject the quarantined credential instead of
    // refreshing that generation as fresh.
    assert.equal(await refreshCodexActiveAccountAdmission(admitted), false);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("concurrent cold admission converges on one durable active generation", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
    const selections = await Promise.all(Array.from({ length: 6 }, () => selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now)));
    const eligible = selections.filter((selection) => selection.kind === "eligible");
    assert.ok(eligible.length > 0);
    assert.deepEqual([...new Set(eligible.map((selection) => selection.accounts[0]?.auth.account_id))], ["one"]);
    const active = parseCodexActiveAccountSelection(kv.values.get(key(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)));
    assert.equal(active?.generation, 1);
    assert.equal(active.slot, 0);

    // Simultaneous authoritative exhaustion of the bootstrapped account
    // converges on exactly one transition to the next configured account.
    const admitted = eligible[0]?.accounts[0];
    assert.ok(admitted);
    await markCodexQuotaBlocked(admitted, httpDateQuotaResponse(now + 60_000), now);
    const transitions = await Promise.all(Array.from({ length: 6 }, () => selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now)));
    const transitioned = transitions.filter((selection) => selection.kind === "eligible");
    assert.ok(transitioned.length > 0);
    const transitionedAccountIds = transitioned.map((selection) => selection.accounts[0]?.auth.account_id);
    assert.deepEqual([...new Set(transitionedAccountIds)], ["two"]);
    const moved = parseCodexActiveAccountSelection(kv.values.get(key(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)));
    assert.equal(moved?.generation, 2, "concurrent exhaustion must not mint a second transition");
    assert.equal(moved.slot, 1);
    assert.equal(moved.transition_reason, "quota_exhausted");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("the durable active account follows authoritative transitions without late rollback", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
    const activeRow = (): ReturnType<typeof parseCodexActiveAccountSelection> =>
      parseCodexActiveAccountSelection(kv.values.get(key(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)));
    const strong = (at: number) => selectCodexRoutingAccountsStrong(authPool, authPool.accounts, at);

    const first = await strong(now);
    assert.equal(first.kind, "eligible");
    assert.equal(first.accounts[0]?.auth.account_id, "one");
    assert.equal(activeRow()?.generation, 1);

    // Authoritative exhaustion of A advances to B once.
    await markCodexQuotaBlocked(first.accounts[0], httpDateQuotaResponse(now + 1_000), now);
    const movedToB = await strong(now + 1);
    assert.equal(movedToB.kind, "eligible");
    assert.equal(movedToB.accounts[0]?.auth.account_id, "two");
    assert.equal(activeRow()?.generation, 2);
    const generationB = activeRow()?.generation ?? 0;

    // A's window elapses, but its recovery cannot steal the active account.
    const stillB = await strong(now + 2_000);
    assert.equal(stillB.kind, "eligible");
    assert.equal(stillB.accounts[0]?.auth.account_id, "two");
    assert.equal(activeRow()?.generation, generationB);

    // B exhaustion then selects the recovered A with a new generation. A's own
    // window has already elapsed, so the authoritative B block is the only
    // transition trigger.
    await markCodexQuotaBlocked(movedToB.accounts[0], httpDateQuotaResponse(now + 10_000), now + 2_000);
    const backToA = await strong(now + 3_001);
    assert.equal(backToA.kind, "eligible");
    assert.equal(backToA.accounts[0]?.auth.account_id, "one");
    assert.equal(activeRow()?.generation, generationB + 1);

    // A late completion admitted under B's generation can never be re-admitted.
    assert.equal(await refreshCodexActiveAccountAdmission({ ...movedToB.accounts[0], activeGeneration: generationB }), false);

    // A pool reorder keeps the active opaque identity and refreshes its slot.
    await kv.set(CODEX_AUTH_POOL_KV_KEY, { accounts: [authPool.accounts[1], authPool.accounts[0]], updated_at_ms: now + 4_000 });
    const reordered = await strong(now + 4_000);
    assert.equal(reordered.kind, "eligible");
    assert.equal(reordered.accounts[0]?.auth.account_id, "one");
    assert.equal(activeRow()?.slot, 1);
    assert.equal(activeRow()?.generation, generationB + 1);

    // Replacing the active account switches identity instead of inheriting it.
    const hashBeforeReplacement = activeRow()?.account_id_hash;
    const replacement = { ...authPool.accounts[0], account_id: "account-three", access_token: "access-three", refresh_token: "refresh-three" };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, { accounts: [replacement, authPool.accounts[1]], updated_at_ms: now + 5_000 });
    const replaced = await strong(now + 5_000);
    assert.equal(replaced.kind, "eligible");
    assert.equal(replaced.accounts[0]?.auth.account_id, "account-three");
    assert.equal(activeRow()?.generation, generationB + 2);
    assert.equal(activeRow()?.slot, 0);
    assert.notEqual(activeRow()?.account_id_hash, hashBeforeReplacement);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("malformed durable active state fails retryably and preserves the record", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
    const bootstrapped = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(bootstrapped.kind, "eligible");

    const malformed = { v: 1, account_id_hash: "not-an-opaque-hash" };
    await kv.set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, malformed);
    const failed = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(failed.kind, "routing_unavailable");
    assert.deepEqual(kv.values.get(key(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)), malformed, "a malformed record is never deleted");

    // A validly missing row is the one bootstrap case.
    kv.values.delete(key(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY));
    resetCodexAccountRoutingForTest();
    const rebootstrapped = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(rebootstrapped.kind, "eligible");
    const active = parseCodexActiveAccountSelection(kv.values.get(key(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY)));
    assert.equal(active?.generation, 1);
    assert.equal(active.slot, 0);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

// ── Operator subscription selection ──────────────────────────────────────────

/** Seed the operator selection and drop the routing selection cache. */

test("a selected Codex subscription restricts which account may serve inference", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);

    await seedSubscriptionSelection(kv, ["two"]);
    const restricted = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(restricted.kind, "eligible");
    assert.deepEqual(
      restricted.accounts.map((account) => account.auth.account_id),
      ["two"],
      "only the selected subscription is eligible"
    );

    // The active subscription follows the operator: excluding the account that
    // currently serves is an authoritative pool change, not a transient signal.
    await seedSubscriptionSelection(kv, ["one"]);
    const moved = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.equal(moved.kind, "eligible");
    assert.deepEqual(
      moved.accounts.map((account) => account.auth.account_id),
      ["one"]
    );

    // The umbrella and an absent selection both restore the whole cohort.
    for (const providerIds of [["codex"], []]) {
      await kv.set(PROVIDER_SELECTION_KV_KEY, { provider_ids: providerIds, updated_at_ms: Date.now() });
      resetProviderSelectionCacheForTest();
      const unrestricted = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
      assert.equal(unrestricted.kind, "eligible");
      assert.equal(unrestricted.accounts[0].auth.account_id, "one", `${providerIds.length ? "the umbrella" : "no selection"} keeps every subscription`);
    }
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
    resetProviderSelectionCacheForTest();
  }
});

test("a selection that names no configured subscription leaves no eligible Codex account", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = Date.now();
    const authPool: CodexAuthPoolState = { accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })), updated_at_ms: now };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
    await seedSubscriptionSelection(kv, ["retired-account"]);
    const selected = await selectCodexRoutingAccountsStrong(authPool, authPool.accounts, now);
    assert.notEqual(selected.kind, "eligible", "an unknown subscription hash never falls back to an unselected account");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
    resetProviderSelectionCacheForTest();
  }
});
