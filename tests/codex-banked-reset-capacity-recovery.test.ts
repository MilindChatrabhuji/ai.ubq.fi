// Regression coverage for the capacity-exhausted banked-reset recovery fix
// (merge fe8c8fa1, source 1ccfeb4e). A subscription whose quota exhaustion is
// known only from a capacity observation must stay half-open: routing admits a
// bounded probe, that probe is claimable without a class-block deadline, a
// successful claim clears the stuck reset ambiguity, and a fresh live stable
// 429 re-arms the reset fence while no stable observation is retained.

import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_CAPACITY_ROUTING_MAX_AGE_MS,
  CodexAuthPoolState,
  RoutingKv,
  claimCodexRoutingProbe,
  codexCredentialVersion,
  getCodexQuotaBlockFence,
  httpDateQuotaResponse,
  key,
  markCodexQuotaBlocked,
  markCodexSuccess,
  parseCodexAccountRoutingState,
  pool,
  recordCodexCapacityRoutingObservations,
  required,
  resetCodexAccountRoutingForTest,
  resetProviderSelectionCacheForTest,
  selectCodexRoutingAccounts,
  selectCodexRoutingAccountsStrong,
  setKvForTest,
  singlePool,
} from "./helpers/codex-account-routing-harness.ts";
import { loadOverageUsageSettings, overageUsageAllowedSync, resetOverageUsageCacheForTest, writeOverageUsage } from "../src/codex/overage-settings.ts";
import { sha256Hex } from "../src/utils.ts";

type RoutingAuth = CodexAuthPoolState["accounts"][number];

const DAY_MS = 24 * 60 * 60_000;
const LUNA = "gpt-5.6-luna";
/** The weekly primary window every capacity fixture describes. */
const WEEKLY_WINDOW_SECONDS = 604_800;

/** The exact opaque identity hash the routing layer assigns one account id. */
const routingAccountIdHash = async (accountId: string): Promise<string> => await sha256Hex(`uos_ai\u0000codex_routing_account\u0000${accountId}`);

const harnessAuth = (now: number): RoutingAuth => ({ ...singlePool.accounts[0], updated_at_ms: now });

/** A complete v2 slot for the harness account, with the fixture overrides applied. */
const routingSlot = async (auth: RoutingAuth, overrides: Record<string, unknown> = {}) => ({
  account_id_hash: await routingAccountIdHash(auth.account_id),
  credential_version: await codexCredentialVersion(auth),
  quota_blocked_until_ms: null,
  quota_block_source: null,
  quota_blocked_classes: [],
  quota_blocks_by_class: {},
  invalid_credential_version: null,
  primary_used_percent: null,
  secondary_used_percent: null,
  quota_signal_observed_at_ms: null,
  capacity_observed_at_ms: null,
  upstream_timeout_blocked_until_ms: null,
  observed_reset_at_ms: null,
  observed_reset_at_is_stable: false,
  banked_reset_generation_ambiguous: false,
  banked_reset_recovery_probe_pending: false,
  generation: 0,
  probe_lease: null,
  ...overrides,
});

const seedRoutingState = async (kv: RoutingKv, auth: RoutingAuth, now: number, slotOverrides: Record<string, unknown> = {}): Promise<void> => {
  await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
    v: 2 as const,
    updated_at_ms: now,
    slots: [await routingSlot(auth, slotOverrides)],
  });
};

const seedAuthPool = async (kv: RoutingKv, auth: RoutingAuth, now: number): Promise<CodexAuthPoolState> => {
  const authPool: CodexAuthPoolState = { accounts: [auth], updated_at_ms: now };
  await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
  return authPool;
};

/** Persist one capacity sample exactly as the dashboard sampler would. */
const seedCapacityObservation = async (fixture: { snapshotAtMs: number; resetAtMs: number | null; usedPercent: number }): Promise<void> => {
  await recordCodexCapacityRoutingObservations(
    [
      {
        slot: 0,
        account_id: "one",
        state: "available",
        source_observed_at_ms: fixture.snapshotAtMs,
        snapshot_at_ms: fixture.snapshotAtMs,
        windows: {
          primary: { limit_window_seconds: WEEKLY_WINDOW_SECONDS, used_percent: fixture.usedPercent, reset_at_ms: fixture.resetAtMs },
          secondary: null,
        },
        additional_rate_limits: [],
      },
    ],
    fixture.snapshotAtMs
  );
};

/**
 * The seed shared by cases A and B: a slot that capacity-only exhaustion left
 * with an expired stable observation and a stuck ambiguity flag, plus a fresh
 * capacity sample proving the weekly primary window empty.
 */
const seedCapacityExhaustedProbe = async (kv: RoutingKv, now: number): Promise<void> => {
  const auth = harnessAuth(now);
  await seedAuthPool(kv, auth, now);
  await seedRoutingState(kv, auth, now, {
    primary_used_percent: 100,
    observed_reset_at_ms: now - 7 * DAY_MS,
    observed_reset_at_is_stable: true,
    banked_reset_generation_ambiguous: true,
  });
  // No reset deadline: this is the deadline-less capacity exhaustion that
  // stays half-open and must remain probe-recoverable.
  await seedCapacityObservation({ snapshotAtMs: now + 1, resetAtMs: null, usedPercent: 100 });
};

/**
 * Seed one slot, select it through the ordinary path, then feed it a fresh
 * stable absolute 429. Returns the requested class block exactly as persisted.
 */
const markFreshStableQuotaBlock = async (kv: RoutingKv, now: number, slotOverrides: Record<string, unknown>) => {
  const auth = harnessAuth(now);
  await seedRoutingState(kv, auth, now, slotOverrides);
  const selection = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, LUNA);
  assert.equal(selection.kind, "eligible");
  const account = selection.accounts[0];
  const freshDeadline = now + 7 * DAY_MS;
  await markCodexQuotaBlocked(account, httpDateQuotaResponse(freshDeadline), now + 1);
  const state = required(parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY))), "routing state");
  const classBlock = required(state.slots[0]?.quota_blocks_by_class?.standard, "standard class block");
  return { account, freshDeadline, classBlock };
};

Deno.test("a capacity-exhausted subscription with no class circuit admits a bounded probe instead of a local dead end", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  try {
    const now = 1_700_000_000_000;
    await seedCapacityExhaustedProbe(kv, now);

    const selected = await selectCodexRoutingAccountsStrong(singlePool, singlePool.accounts, now + 2, LUNA);
    assert.equal(selected.kind, "eligible");
    const probeAccount = selected.accounts[0];
    assert.equal(probeAccount.probeRequired, true);
    assert.equal(probeAccount.probeCircuit, "quota");
    assert.equal(probeAccount.quotaHeadroom, 0);
    assert.equal(selected.blockedAccounts.length, 0);

    const claimed = await claimCodexRoutingProbe(singlePool, probeAccount, now + 3);
    assert.ok(claimed);
    assert.notEqual(claimed.probeGeneration, null);
    assert.ok(claimed.probeToken !== null);
    assert.equal(claimed.probeCircuit, "quota");

    // The same unclaimed routing account must not mint a second lease while
    // the first one is live.
    assert.equal(await claimCodexRoutingProbe(singlePool, probeAccount, now + 4), null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

Deno.test("a capacity exhaustion with a future reset deadline is the blocked cohort identity", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  try {
    const now = 1_700_000_000_000;
    const auth = harnessAuth(now);
    await seedAuthPool(kv, auth, now);
    await seedRoutingState(kv, auth, now, {
      primary_used_percent: 100,
      observed_reset_at_ms: now - 7 * DAY_MS,
      observed_reset_at_is_stable: true,
      banked_reset_generation_ambiguous: true,
    });
    const resetAtMs = now + 7 * DAY_MS;
    await seedCapacityObservation({ snapshotAtMs: now + 1, resetAtMs, usedPercent: 100 });

    const selected = await selectCodexRoutingAccountsStrong(singlePool, singlePool.accounts, now + 2, LUNA);
    assert.equal(selected.kind, "quota_blocked");
    assert.equal(selected.fullCohortExhausted, true);
    assert.equal(selected.blockedAccounts.length, 1);
    assert.equal(selected.blockedAccounts[0].quotaResetAtMs, resetAtMs);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

Deno.test("a successful claimed probe clears the stuck reset ambiguity", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  try {
    const now = 1_700_000_000_000;
    await seedCapacityExhaustedProbe(kv, now);

    const selected = await selectCodexRoutingAccountsStrong(singlePool, singlePool.accounts, now + 2, LUNA);
    assert.equal(selected.kind, "eligible");
    const claimed = await claimCodexRoutingProbe(singlePool, selected.accounts[0], now + 3);
    assert.ok(claimed);
    assert.notEqual(claimed.probeGeneration, null);
    assert.ok(claimed.probeToken !== null);

    await markCodexSuccess(claimed);

    const state = required(parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY))), "routing state");
    const slot = state.slots[0];
    assert.equal(slot.banked_reset_generation_ambiguous, false);
    assert.equal(slot.observed_reset_at_ms, null);
    assert.equal(slot.observed_reset_at_is_stable, false);
    assert.equal(slot.probe_lease, null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

Deno.test("a fresh stable 429 supersedes an absent observation so the reset fence can arm", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  try {
    const now = 1_700_000_000_000;
    // The carried ambiguity flag with no recorded identity is the residue a
    // capacity-only exhaustion leaves behind; there is no stable window to
    // protect, so a fresh live stable deadline must be allowed to establish one.
    const { account, freshDeadline, classBlock } = await markFreshStableQuotaBlock(kv, now, { banked_reset_generation_ambiguous: true });

    assert.equal(classBlock.banked_reset_generation_ambiguous, false);
    assert.equal(classBlock.blocked_until_ms, freshDeadline);
    assert.equal(classBlock.observed_reset_at_ms, freshDeadline);
    assert.equal(classBlock.observed_reset_at_is_stable, true);
    assert.equal(typeof (await getCodexQuotaBlockFence(account, freshDeadline)), "number");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

Deno.test("a fresh stable 429 supersedes an expired non-stable observation so the reset fence can arm", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  try {
    const now = 1_700_000_000_000;
    // An observation whose deadline has already passed cannot describe the
    // current window, so the fresh applied stable deadline supersedes it.
    const { account, freshDeadline, classBlock } = await markFreshStableQuotaBlock(kv, now, {
      observed_reset_at_ms: now - 7 * DAY_MS,
      observed_reset_at_is_stable: false,
      banked_reset_generation_ambiguous: true,
    });

    assert.equal(classBlock.banked_reset_generation_ambiguous, false);
    assert.equal(classBlock.blocked_until_ms, freshDeadline);
    assert.equal(classBlock.observed_reset_at_ms, freshDeadline);
    assert.equal(classBlock.observed_reset_at_is_stable, true);
    assert.equal(typeof (await getCodexQuotaBlockFence(account, freshDeadline)), "number");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

Deno.test("an unresolved prior observation keeps the reset fence conservative", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  try {
    const now = 1_700_000_000_000;
    const priorDeadline = now + 60_000;
    const { account, freshDeadline, classBlock } = await markFreshStableQuotaBlock(kv, now, {
      observed_reset_at_ms: priorDeadline,
      observed_reset_at_is_stable: true,
      banked_reset_generation_ambiguous: true,
    });

    assert.equal(classBlock.banked_reset_generation_ambiguous, true);
    assert.equal(classBlock.observed_reset_at_ms, priorDeadline);
    assert.equal(await getCodexQuotaBlockFence(account, freshDeadline), null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

Deno.test("an expired stable observation stays lookup-only instead of arming a new reset fence", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  try {
    const now = 1_700_000_000_000;
    const expiredDeadline = now - 7 * DAY_MS;
    // A retained stable observation outranks a changed deadline: a different
    // date cannot prove a new provider quota generation, so the block stays
    // lookup-only and only a successful half-open probe may clear it.
    const { account, freshDeadline, classBlock } = await markFreshStableQuotaBlock(kv, now, {
      observed_reset_at_ms: expiredDeadline,
      observed_reset_at_is_stable: true,
      banked_reset_generation_ambiguous: true,
    });

    assert.equal(classBlock.banked_reset_generation_ambiguous, true);
    assert.equal(classBlock.observed_reset_at_ms, expiredDeadline);
    assert.equal(await getCodexQuotaBlockFence(account, freshDeadline), null);
    assert.equal(await getCodexQuotaBlockFence(account, expiredDeadline), null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

Deno.test("a capacity observation that is not fresh never fabricates a probe identity", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  try {
    const now = 1_700_000_000_000;
    const auth = harnessAuth(now);
    await seedAuthPool(kv, auth, now);
    await seedRoutingState(kv, auth, now, { primary_used_percent: 100 });
    // Recorded while fresh, but selected after the max age elapsed: the stale
    // sample may not reopen the circuit or mint a probe.
    await seedCapacityObservation({ snapshotAtMs: now, resetAtMs: now + 7 * DAY_MS, usedPercent: 100 });

    const selected = await selectCodexRoutingAccountsStrong(singlePool, singlePool.accounts, now + CODEX_CAPACITY_ROUTING_MAX_AGE_MS + 1, LUNA);
    assert.equal(selected.kind, "eligible");
    const account = selected.accounts[0];
    assert.equal(account.probeRequired, false);
    assert.equal(account.probeCircuit, null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

Deno.test("an overage-allowed account routes the capacity exhaustion as a bounded probe without materializing a block", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  resetOverageUsageCacheForTest();
  try {
    const now = 1_700_000_000_000;
    const auth = harnessAuth(now);
    await seedAuthPool(kv, auth, now);
    await seedRoutingState(kv, auth, now, {
      primary_used_percent: 100,
      observed_reset_at_ms: now - 7 * DAY_MS,
      observed_reset_at_is_stable: true,
      banked_reset_generation_ambiguous: true,
    });
    const resetAtMs = now + 7 * DAY_MS;
    await seedCapacityObservation({ snapshotAtMs: now + 1, resetAtMs, usedPercent: 100 });

    // The operator explicitly allows overage for this subscription.
    await writeOverageUsage(kv as unknown as Deno.Kv, await sha256Hex(auth.account_id), true);
    resetOverageUsageCacheForTest();
    await loadOverageUsageSettings(singlePool, true);
    assert.equal(overageUsageAllowedSync(await routingAccountIdHash(auth.account_id)), true);

    const selected = await selectCodexRoutingAccountsStrong(singlePool, singlePool.accounts, now + 2, LUNA);
    assert.equal(selected.kind, "eligible");
    const probeAccount = selected.accounts[0];
    assert.equal(probeAccount.probeRequired, true);
    assert.equal(probeAccount.probeCircuit, "quota");
    assert.equal(probeAccount.quotaHeadroom, 0);
    // The capacity-100% evidence must neither materialize nor block a class.
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[0]?.quota_blocks_by_class?.standard, undefined);
    assert.equal(await getCodexQuotaBlockFence(probeAccount, resetAtMs), null);

    const claimed = await claimCodexRoutingProbe(singlePool, probeAccount, now + 5);
    assert.ok(claimed);
    assert.equal(claimed.probeCircuit, "quota");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
    resetOverageUsageCacheForTest();
  }
});

Deno.test("one subscription's overage allowance never changes its sibling's blocked identity", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  resetOverageUsageCacheForTest();
  try {
    const now = 1_700_000_000_000;
    const first = { ...pool.accounts[0], updated_at_ms: now };
    const second = { ...pool.accounts[1], updated_at_ms: now };
    const twoPool: CodexAuthPoolState = { accounts: [first, second], updated_at_ms: now };
    await kv.set(CODEX_AUTH_POOL_KV_KEY, twoPool);
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      v: 2 as const,
      updated_at_ms: now,
      slots: [
        await routingSlot(first, {
          primary_used_percent: 100,
          observed_reset_at_ms: now - 7 * DAY_MS,
          observed_reset_at_is_stable: true,
          banked_reset_generation_ambiguous: true,
        }),
        await routingSlot(second, {
          primary_used_percent: 100,
          observed_reset_at_ms: now - 7 * DAY_MS,
          observed_reset_at_is_stable: true,
          banked_reset_generation_ambiguous: true,
        }),
      ],
    });
    const resetAtMs = now + 7 * DAY_MS;
    await recordCodexCapacityRoutingObservations(
      [
        {
          slot: 0,
          account_id: "one",
          state: "available",
          source_observed_at_ms: now + 1,
          snapshot_at_ms: now + 1,
          windows: { primary: { limit_window_seconds: WEEKLY_WINDOW_SECONDS, used_percent: 100, reset_at_ms: resetAtMs }, secondary: null },
          additional_rate_limits: [],
        },
        {
          slot: 1,
          account_id: "two",
          state: "available",
          source_observed_at_ms: now + 1,
          snapshot_at_ms: now + 1,
          windows: { primary: { limit_window_seconds: WEEKLY_WINDOW_SECONDS, used_percent: 100, reset_at_ms: resetAtMs }, secondary: null },
          additional_rate_limits: [],
        },
      ],
      now + 1
    );
    await writeOverageUsage(kv as unknown as Deno.Kv, await sha256Hex("one"), true);
    resetOverageUsageCacheForTest();
    await loadOverageUsageSettings(twoPool, true);

    const selected = await selectCodexRoutingAccountsStrong(twoPool, twoPool.accounts, now + 2, LUNA);
    assert.equal(selected.kind, "eligible");
    assert.equal(selected.accounts.length, 1);
    assert.equal(selected.accounts[0].auth.account_id, "one");
    assert.equal(selected.accounts[0].probeRequired, true);
    assert.equal(selected.blockedAccounts.length, 1);
    assert.equal(selected.blockedAccounts[0].auth.account_id, "two");
    assert.equal(selected.blockedAccounts[0].quotaResetAtMs, resetAtMs);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
    resetOverageUsageCacheForTest();
  }
});
