import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import { type Kv } from "#kv";
// codex-account-routing suite, part 1 of 3: tests moved out of tests/codex-account-routing.test.ts.

import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_HALF_OPEN_LEASE_MS,
  CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
  type CodexAuthPoolState,
  CodexError,
  RoutingKv,
  claimCodexRoutingProbe,
  codexCredentialVersion,
  fetchCodexResponses,
  getCodexQuotaBlockFence,
  httpDateQuotaResponse,
  key,
  markCodexQuotaBlocked,
  markCodexRecoveryProbeQuotaBlocked,
  markCodexSuccess,
  markCodexUpstreamTimeout,
  parseCodexAccountRoutingState,
  pool,
  recheckCodexRoutingSlot,
  reconcileCodexQuotaAfterStaleVerifiedReset,
  reconcileCodexQuotaAfterVerifiedReset,
  recordCodexCapacityRoutingObservations,
  requestUrl,
  required,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  selectCodexRoutingAccounts,
  setKvForTest,
  singlePool,
  syntheticLegacyBlock,
} from "./helpers/codex-account-routing-harness.ts";

test("v2 routing ignores the v1 key and rejects v1 payloads", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const credentialVersion = await codexCredentialVersion(singlePool.accounts[0]);
    const v1State = {
      v: 1,
      updated_at_ms: now,
      slots: [
        {
          credential_version: credentialVersion,
          quota_blocked_until_ms: now + 60_000,
          quota_block_source: "cooldown",
          invalid_credential_version: credentialVersion,
          primary_used_percent: null,
          secondary_used_percent: null,
          observed_reset_at_ms: null,
          generation: 1,
          probe_lease: null,
        },
      ],
    };
    await kv.set(["uos_ai", "codex_account_routing", "v1"], v1State);

    assert.equal(parseCodexAccountRoutingState(v1State), null);
    const selected = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(selected.kind, "eligible");
    assert.equal(kv.values.has(key(CODEX_ACCOUNT_ROUTING_KV_KEY)), false);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("quota circuits isolate Spark, GPT-OSS, and standard model pools", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const sparkDeadline = now + 7 * 24 * 60 * 60_000;
    const standardDeadline = now + 60 * 60_000;

    const spark = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.3-codex-spark");
    assert.equal(spark.kind, "eligible");

    await markCodexQuotaBlocked(spark.accounts[0], httpDateQuotaResponse(sparkDeadline), now);

    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1, "gpt-5.3-codex-spark")).kind, "quota_blocked");
    const luna = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1, "gpt-5.6-luna");
    assert.equal(luna.kind, "eligible");

    await markCodexQuotaBlocked(luna.accounts[0], httpDateQuotaResponse(standardDeadline), now + 1);
    assert.equal(typeof (await getCodexQuotaBlockFence(spark.accounts[0], sparkDeadline)), "number");
    assert.equal(typeof (await getCodexQuotaBlockFence(luna.accounts[0], standardDeadline)), "number");

    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 2, "gpt-5.6-terra")).kind, "quota_blocked");
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 2, "gpt-oss-120b")).kind, "eligible");
    const afterStandardReset = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, standardDeadline + 1, "gpt-5.6-luna");
    assert.equal(afterStandardReset.kind, "eligible");
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, standardDeadline + 1, "gpt-5.3-codex-spark")).kind, "quota_blocked");

    await recordCodexCapacityRoutingObservations(
      [
        {
          slot: 0,
          account_id: "one",
          state: "available",
          source_observed_at_ms: now + 2,
          snapshot_at_ms: now + 2,
          windows: {
            primary: { limit_window_seconds: 604_800, used_percent: 50, reset_at_ms: standardDeadline },
            secondary: null,
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              metered_feature: "codex_bengalfox",
              windows: {
                primary: { limit_window_seconds: 604_800, used_percent: 100, reset_at_ms: sparkDeadline },
                secondary: null,
              },
            },
          ],
        },
      ],
      now + 2
    );
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 3, "gpt-5.6-luna")).kind, "eligible");
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 3, "gpt-5.3-codex-spark")).kind, "quota_blocked");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("reserve-class quota circuits do not fence the standard class on the same account", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const standardDeadline = now + 60_000;
    const reserveDeadline = standardDeadline + 60_000;

    const standard = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.6-luna");
    assert.equal(standard.kind, "eligible");
    await markCodexQuotaBlocked(standard.accounts[0], httpDateQuotaResponse(standardDeadline), now);

    // The standard bucket exhaustion of luna fences no reserve-class model.
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1, "gpt-reserve")).kind, "eligible");
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1, "gpt-5.6-terra")).kind, "quota_blocked");

    // Once standard recovers, exhausting reserve fences only the reserve class.
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, standardDeadline + 1, "gpt-5.6-luna")).kind, "eligible");
    const reserve = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, standardDeadline + 1, "gpt-reserve");
    assert.equal(reserve.kind, "eligible");
    await markCodexQuotaBlocked(reserve.accounts[0], httpDateQuotaResponse(reserveDeadline), standardDeadline + 1);

    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, standardDeadline + 2, "gpt-reserve")).kind, "quota_blocked");
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, standardDeadline + 2, "gpt-5.6-luna")).kind, "eligible");
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, standardDeadline + 2, "gpt-5.6-terra")).kind, "eligible");

    // Both buckets persist independently through the KV round trip.
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[0]?.quota_blocks_by_class?.standard?.blocked_until_ms, standardDeadline);
    assert.ok(state);
    assert.equal(state.slots[0]?.quota_blocks_by_class?.reserve?.blocked_until_ms, reserveDeadline);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("an unrelated class 429 is recorded while another class owns a probe lease", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const sparkDeadline = now + 60_000;
    const standardDeadline = sparkDeadline + 60_000;
    const usageLimitResponse = (deadline: number) =>
      new Response(JSON.stringify({ error: { type: "usage_limit_reached", resets_at: Math.floor(deadline / 1_000) } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    const spark = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.3-codex-spark");
    assert.equal(spark.kind, "eligible");

    await markCodexQuotaBlocked(spark.accounts[0], usageLimitResponse(sparkDeadline), now);

    const expiredSpark = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, sparkDeadline + 1, "gpt-5.3-codex-spark");
    assert.equal(expiredSpark.kind, "eligible");

    const claimed = await claimCodexRoutingProbe(singlePool, expiredSpark.accounts[0], sparkDeadline + 1);
    assert.ok(claimed);

    const standard = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, sparkDeadline + 2, "gpt-5.6-luna");
    assert.equal(standard.kind, "eligible");

    await markCodexQuotaBlocked(standard.accounts[0], usageLimitResponse(standardDeadline), sparkDeadline + 2);

    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[0]?.quota_blocks_by_class?.standard?.blocked_until_ms, standardDeadline);
    assert.equal(state.slots[0]?.probe_lease?.quota_class, "spark");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("legacy named class blocks remain enforced until migrated", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const deadline = now + 60_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.6-luna");
    assert.equal(initial.kind, "eligible");

    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      v: 2,
      updated_at_ms: now,
      banked_reset_legacy_identity_unresolved: false,
      slots: [
        {
          account_id_hash: initial.accounts[0].accountIdHash,
          credential_version: initial.accounts[0].credentialVersion,
          quota_blocked_until_ms: deadline,
          quota_block_source: "header_retry_after",
          quota_blocked_classes: ["standard"],
          invalid_credential_version: null,
          primary_used_percent: null,
          secondary_used_percent: null,
          quota_signal_observed_at_ms: now,
          capacity_observed_at_ms: null,
          upstream_timeout_blocked_until_ms: null,
          observed_reset_at_ms: null,
          observed_reset_at_is_stable: false,
          banked_reset_generation_ambiguous: false,
          banked_reset_recovery_probe_pending: false,
          generation: 1,
          probe_lease: null,
        },
      ],
    });
    resetCodexAccountRoutingForTest();
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1, "gpt-5.6-luna")).kind, "quota_blocked");
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1, "gpt-5.3-codex-spark")).kind, "eligible");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a legacy class block survives migration when another class is exhausted", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const standardDeadline = now + 60_000;
    const sparkDeadline = now + 120_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.6-luna");
    assert.equal(initial.kind, "eligible");

    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      v: 2,
      updated_at_ms: now,
      banked_reset_legacy_identity_unresolved: false,
      slots: [
        {
          account_id_hash: initial.accounts[0].accountIdHash,
          credential_version: initial.accounts[0].credentialVersion,
          quota_blocked_until_ms: standardDeadline,
          quota_block_source: "header_retry_after",
          quota_blocked_classes: ["standard"],
          quota_blocks_by_class: {},
          invalid_credential_version: null,
          primary_used_percent: null,
          secondary_used_percent: null,
          quota_signal_observed_at_ms: now,
          capacity_observed_at_ms: null,
          upstream_timeout_blocked_until_ms: null,
          observed_reset_at_ms: null,
          observed_reset_at_is_stable: false,
          banked_reset_generation_ambiguous: false,
          banked_reset_recovery_probe_pending: false,
          generation: 1,
          probe_lease: null,
        },
      ],
    });
    resetCodexAccountRoutingForTest();
    const spark = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1, "gpt-5.3-codex-spark");
    assert.equal(spark.kind, "eligible");

    await markCodexQuotaBlocked(
      spark.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(sparkDeadline).toUTCString() },
      }),
      now + 1
    );
    const migrated = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(migrated?.slots[0]?.quota_blocks_by_class?.standard?.blocked_until_ms, standardDeadline);
    assert.equal(migrated.slots[0]?.quota_blocks_by_class?.spark?.blocked_until_ms, sparkDeadline);
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 2, "gpt-5.6-luna")).kind, "quota_blocked");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("an unclassified legacy block stays on other classes after capacity clears one", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const legacyDeadline = now + 60_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.6-luna");
    assert.equal(initial.kind, "eligible");

    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      v: 2,
      updated_at_ms: now,
      banked_reset_legacy_identity_unresolved: false,
      slots: [
        {
          account_id_hash: initial.accounts[0].accountIdHash,
          credential_version: initial.accounts[0].credentialVersion,
          quota_blocked_until_ms: legacyDeadline,
          quota_block_source: "header_retry_after",
          quota_blocked_classes: [],
          quota_blocks_by_class: {},
          invalid_credential_version: null,
          primary_used_percent: null,
          secondary_used_percent: null,
          quota_signal_observed_at_ms: now,
          capacity_observed_at_ms: null,
          upstream_timeout_blocked_until_ms: null,
          observed_reset_at_ms: null,
          observed_reset_at_is_stable: false,
          banked_reset_generation_ambiguous: false,
          banked_reset_recovery_probe_pending: false,
          generation: 1,
          probe_lease: null,
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
            primary: { limit_window_seconds: 604_800, used_percent: 100, reset_at_ms: legacyDeadline },
            secondary: null,
          },
          additional_rate_limits: [
            {
              limit_name: "gpt-5.3-codex-spark",
              metered_feature: "codex_bengalfox",
              windows: {
                primary: { limit_window_seconds: 604_800, used_percent: 50, reset_at_ms: legacyDeadline },
                secondary: null,
              },
            },
          ],
        },
      ],
      now + 1
    );
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 2, "gpt-5.3-codex-spark")).kind, "eligible");
    const migrated = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(migrated?.slots[0]?.quota_blocks_by_class?.spark, undefined);
    assert.equal(migrated?.slots[0]?.quota_blocks_by_class?.unknown, undefined);
    assert.equal(migrated?.slots[0]?.quota_blocks_by_class?.standard?.blocked_until_ms, legacyDeadline);
    assert.equal(migrated.slots[0]?.quota_blocks_by_class?.gpt_oss_120b?.blocked_until_ms, legacyDeadline);
    assert.equal((await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 2, "gpt-5.6-luna")).kind, "quota_blocked");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("migrates an unmarked synthetic unknown block from the prior class release", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const legacyDeadline = now + 120_000;
    const standardDeadline = now + 180_000;
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

    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      ...state,
      slots: [
        {
          ...state.slots[0],
          quota_blocked_until_ms: standardDeadline,
          quota_block_source: "header_retry_after",
          quota_blocked_classes: ["spark", "gpt_oss_120b", "standard", "unknown"],
          quota_blocks_by_class: {
            spark: syntheticLegacyBlock(legacyDeadline, now),
            gpt_oss_120b: syntheticLegacyBlock(legacyDeadline, now),
            standard: syntheticLegacyBlock(legacyDeadline, now),
            unknown: syntheticLegacyBlock(legacyDeadline, now),
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
    assert.equal(migrated?.slots[0]?.quota_blocks_by_class?.unknown, undefined);
    assert.equal(migrated?.slots[0]?.quota_blocks_by_class?.spark?.blocked_until_ms, legacyDeadline);
    assert.equal(migrated.slots[0]?.quota_blocks_by_class?.gpt_oss_120b?.blocked_until_ms, legacyDeadline);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("does not mark a coincidentally matching unknown block as synthetic", () => {
  const now = 1_700_000_000_000;
  const matchingDeadline = now + 60_000;
  const parsed = parseCodexAccountRoutingState({
    v: 2,
    updated_at_ms: now,
    slots: [
      {
        credential_version: "credential",
        quota_block_source: null,
        probe_lease: null,
        quota_blocks_by_class: {
          spark: syntheticLegacyBlock(matchingDeadline, now),
          gpt_oss_120b: syntheticLegacyBlock(matchingDeadline + 1, now),
          standard: syntheticLegacyBlock(matchingDeadline + 2, now),
          unknown: syntheticLegacyBlock(matchingDeadline, now),
        },
      },
    ],
  });
  assert.equal(parsed?.slots[0]?.quota_blocks_by_class?.unknown?.legacy_fallback, false);
});

test("an administrative recheck marks every class reset fence ambiguous", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const resetAtMs = now + 60_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.3-codex-spark");
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(
        JSON.stringify({
          error: { type: "usage_limit_reached", resets_at: Math.floor(resetAtMs / 1_000) },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      ),
      now
    );
    const before = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(before?.slots[0]?.quota_blocks_by_class?.spark?.banked_reset_generation_ambiguous, false);
    assert.equal(await recheckCodexRoutingSlot(1), true);
    const after = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(after?.slots[0]?.quota_blocks_by_class?.spark?.banked_reset_generation_ambiguous, true);
    assert.equal(await getCodexQuotaBlockFence(initial.accounts[0], resetAtMs), null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a successful class probe does not leave recovery pending on another class", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const sparkDeadline = now + 60_000;
    const standardDeadline = now + 120_000;
    const spark = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.3-codex-spark");
    assert.equal(spark.kind, "eligible");

    await markCodexQuotaBlocked(spark.accounts[0], httpDateQuotaResponse(sparkDeadline), now);
    const standard = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1, "gpt-5.6-luna");
    assert.equal(standard.kind, "eligible");

    await markCodexQuotaBlocked(standard.accounts[0], httpDateQuotaResponse(standardDeadline), now + 1);
    const routingGeneration = await getCodexQuotaBlockFence(spark.accounts[0], sparkDeadline);
    assert.equal(typeof routingGeneration, "number");
    if (routingGeneration === null) return;
    const recovery = await reconcileCodexQuotaAfterVerifiedReset(spark.accounts[0], {
      quotaResetAtMs: sparkDeadline,
      routingGeneration,
    });
    assert.ok(recovery);

    await markCodexSuccess(recovery);
    const afterSuccess = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(afterSuccess?.slots[0]?.banked_reset_recovery_probe_pending, false);
    const nextDeadline = standardDeadline + 60_000;
    const standardProbe = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, standardDeadline + 1, "gpt-5.6-luna");
    assert.equal(standardProbe.kind, "eligible");

    const claimed = await claimCodexRoutingProbe(singlePool, standardProbe.accounts[0], standardDeadline + 1);
    assert.ok(claimed);

    await markCodexQuotaBlocked(claimed, httpDateQuotaResponse(nextDeadline), standardDeadline + 1);
    assert.equal(
      parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)))?.slots[0]?.quota_blocks_by_class?.standard?.blocked_until_ms,
      nextDeadline
    );
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("legacy response-header timeout fences are ignored by live routing", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await markCodexUpstreamTimeout(initial.accounts[0], now);
    const blocked = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(blocked?.slots[0]?.upstream_timeout_blocked_until_ms, now + CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS);

    resetCodexAccountRoutingForTest();
    const sibling = await selectCodexRoutingAccounts(pool, pool.accounts, now + 1);
    assert.equal(sibling.kind, "eligible");

    assert.deepEqual(
      sibling.accounts.map((account) => account.slot),
      [0, 1]
    );
    assert.deepEqual(sibling.skippedSlots, []);

    await markCodexUpstreamTimeout(sibling.accounts[1], now + 1);
    resetCodexAccountRoutingForTest();
    const stillEligible = await selectCodexRoutingAccounts(pool, pool.accounts, now + 2);
    assert.equal(stillEligible.kind, "eligible");

    assert.deepEqual(
      stillEligible.accounts.map((account) => account.slot),
      [0, 1]
    );
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a held legacy timeout probe is discarded before live routing", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const account = initial.accounts[0];
    await markCodexUpstreamTimeout(account, now - CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS - 1);
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.ok(state);

    const probeExpiresAtMs = now + 1_000;
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      ...state,
      updated_at_ms: now,
      slots: state.slots.map((slot, index) =>
        index === account.slot
          ? {
              ...slot,
              quota_blocked_until_ms: now - 1,
              quota_block_source: "header_retry_after",
              upstream_timeout_blocked_until_ms: now - 1,
              probe_lease: {
                token: "held-timeout-probe",
                expires_at_ms: probeExpiresAtMs,
                generation: slot.generation,
                circuit: "upstream_timeout",
              },
            }
          : slot
      ),
    });
    resetCodexAccountRoutingForTest();

    const selected = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(selected.kind, "eligible");

    assert.equal(selected.accounts[0]?.probeRequired, true);
    assert.equal(selected.accounts[0]?.probeCircuit, "quota");
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a held quota probe does not misclassify a stale timeout as upstream blocked", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const account = initial.accounts[0];
    await markCodexUpstreamTimeout(account, now - CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS - 1);
    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.ok(state);

    const probeExpiresAtMs = now + 1_000;
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      ...state,
      updated_at_ms: now,
      slots: state.slots.map((slot, index) =>
        index === account.slot
          ? {
              ...slot,
              quota_blocked_until_ms: now - 1,
              quota_block_source: "header_retry_after",
              upstream_timeout_blocked_until_ms: now - 1,
              probe_lease: {
                token: "held-quota-probe",
                expires_at_ms: probeExpiresAtMs,
                generation: slot.generation,
                circuit: "quota",
              },
            }
          : slot
      ),
    });
    resetCodexAccountRoutingForTest();

    const selected = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(selected.kind, "quota_blocked");

    assert.equal(selected.retryAtMs, probeExpiresAtMs);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a legacy timeout fence cannot hide a quota-blocked sibling", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const initial = await selectCodexRoutingAccounts(pool, pool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      required(
        initial.accounts.find((account) => account.auth.account_id === "one"),
        "account one"
      ),
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }),
      now
    );
    await markCodexUpstreamTimeout(
      required(
        initial.accounts.find((account) => account.auth.account_id === "two"),
        "account two"
      ),
      now
    );

    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(pool, pool.accounts, now + 1);
    assert.equal(selected.kind, "eligible");

    assert.deepEqual(
      selected.accounts.map((account) => account.slot),
      [1]
    );
    assert.deepEqual(selected.skippedSlots, [1]);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("fetchCodexResponses does not gate the next request after a timeout", async () => {
  const kv = new RoutingKv();
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const authPool: CodexAuthPoolState = {
    accounts: pool.accounts.map((account) => ({ ...account, updated_at_ms: now })),
    updated_at_ms: now,
  };
  const calls: string[] = [];
  let dispatches = 0;
  const timeoutController = new AbortController();
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
  try {
    globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.endsWith("/responses")) throw new Error(`Unexpected Codex URL: ${url}`);
      const accountId = new Headers(init?.headers).get("ChatGPT-Account-ID");
      calls.push(accountId ?? "");
      if (calls.length === 1) {
        timeoutController.abort(new DOMException("Codex fixture timeout", "TimeoutError"));
        const reason: unknown = timeoutController.signal.reason;
        return Promise.reject(reason instanceof Error ? reason : new Error("Codex fixture timeout", { cause: reason }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    await assert.rejects(
      fetchCodexResponses(
        { model: "gpt-5-routing", input: "timeout" },
        {
          signal: timeoutController.signal,
          beforeDispatch: () => {
            dispatches += 1;
            return Promise.resolve();
          },
        }
      ),
      (error: unknown) => error instanceof CodexError && error.code === "gateway_timeout" && error.status === 504
    );
    assert.equal(dispatches, 1, "an expired request deadline must not dispatch or record a sibling attempt");
    resetCodexAccountRoutingForTest();

    const response = await fetchCodexResponses({ model: "gpt-5-routing", input: "next request" });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["one", "one"]);
    await response.arrayBuffer();
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
  }
});

test("fetchCodexResponses preserves a JSON 429 without Retry-After when no retry time is known", async () => {
  const kv = new RoutingKv();
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const authPool: CodexAuthPoolState = {
    accounts: [{ ...pool.accounts[0], updated_at_ms: now }],
    updated_at_ms: now,
  };
  let calls = 0;
  setKvForTest(kv as unknown as Kv);
  resetCodexAuthCacheForTest();
  await kv.set(CODEX_AUTH_POOL_KV_KEY, authPool);
  try {
    globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]): Promise<Response> => {
      const url = requestUrl(input);
      if (!url.endsWith("/responses")) throw new Error(`Unexpected Codex URL: ${url}`);
      calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              message: "Codex is temporarily rate limited.",
              type: "rate_limit_error",
              code: "codex_rate_limited",
              param: null,
            },
          }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        )
      );
    });

    const response = await fetchCodexResponses({ model: "gpt-5-routing", input: "rate-limit" }, { retrySleep: async () => {} });

    assert.equal(calls, 2);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("Retry-After"), null);
    assert.deepEqual(await response.json(), {
      error: {
        message: "Codex is temporarily rate limited.",
        type: "rate_limit_error",
        code: "codex_rate_limited",
        param: null,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    setKvForTest(null);
    resetCodexAuthCacheForTest();
  }
});

test("ordinary and incomplete 429 variants never persist a quota block", async () => {
  const now = 1_700_000_000_000;
  const futureResetSeconds = Math.floor(now / 1_000) + 120;
  const cases = [
    {
      name: "bare",
      response: () => new Response(null, { status: 429 }),
      usageLimitReached: false,
      retryAtMs: null,
    },
    {
      name: "generic with valid Retry-After",
      response: () =>
        new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        }),
      usageLimitReached: false,
      retryAtMs: now + 60_000,
    },
    {
      name: "usage limit with string body reset",
      response: () =>
        new Response(JSON.stringify({ error: { type: "usage_limit_reached", resets_at: String(futureResetSeconds) } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      usageLimitReached: true,
      retryAtMs: null,
    },
    {
      name: "usage limit with fractional body reset",
      response: () =>
        new Response(JSON.stringify({ error: { type: "usage_limit_reached", resets_at: futureResetSeconds + 0.5 } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      usageLimitReached: true,
      retryAtMs: null,
    },
    {
      name: "usage limit with expired body reset",
      response: () =>
        new Response(JSON.stringify({ error: { type: "usage_limit_reached", resets_at: Math.floor(now / 1_000) - 1 } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      usageLimitReached: true,
      retryAtMs: null,
    },
    {
      name: "usage limit with overflowing body reset",
      response: () =>
        new Response(JSON.stringify({ error: { type: "usage_limit_reached", resets_at: Number.MAX_SAFE_INTEGER } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      usageLimitReached: true,
      retryAtMs: null,
    },
    {
      name: "usage limit without Retry-After",
      response: () =>
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      usageLimitReached: true,
      retryAtMs: null,
    },
    {
      name: "usage limit with invalid decimal Retry-After",
      response: () =>
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "1.5" },
        }),
      usageLimitReached: true,
      retryAtMs: null,
    },
    {
      name: "truncated usage limit with valid Retry-After",
      response: () =>
        new Response(JSON.stringify({ error: { type: "usage_limit_reached", detail: "x".repeat(70 * 1_024) } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        }),
      usageLimitReached: false,
      retryAtMs: now + 60_000,
    },
  ] as const;

  for (const testCase of cases) {
    const kv = new RoutingKv();
    setKvForTest(kv as unknown as Kv);
    resetCodexAccountRoutingForTest();
    try {
      const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
      assert.equal(initial.kind, "eligible", testCase.name);

      const classified = await markCodexQuotaBlocked(initial.accounts[0], testCase.response(), now);
      assert.equal(classified.response.status, 429, testCase.name);
      assert.equal(classified.usageLimitReached, testCase.usageLimitReached, testCase.name);
      assert.equal(classified.retryAtMs, testCase.retryAtMs, testCase.name);
      assert.equal(kv.values.has(key(CODEX_ACCOUNT_ROUTING_KV_KEY)), false, testCase.name);

      resetCodexAccountRoutingForTest();
      const selected = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1);
      assert.equal(selected.kind, "eligible", testCase.name);
    } finally {
      setKvForTest(null);
      resetCodexAccountRoutingForTest();
    }
  }
});

test("exact future body resets_at durably identifies the Codex quota window", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const resetAtSeconds = Math.floor(now / 1_000) + 120;
    const resetAtMs = resetAtSeconds * 1_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const classified = await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(
        JSON.stringify({
          error: {
            type: "usage_limit_reached",
            resets_at: resetAtSeconds,
            resets_in_seconds: 120,
          },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "x-codex-primary-reset-at": String(resetAtSeconds),
          },
        }
      ),
      now
    );
    assert.equal(classified.usageLimitReached, true);
    assert.equal(classified.retryAtMs, resetAtMs);
    assert.equal(classified.quotaBlockSource, "body_resets_at");
    assert.equal(classified.resetDeadlineIsStable, true);
    assert.equal(classified.resetDeadlineConflict, false);

    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[0]?.quota_blocked_until_ms, resetAtMs);
    assert.equal(state.slots[0]?.quota_block_source, "body_resets_at");
    assert.equal(state.slots[0]?.observed_reset_at_ms, resetAtMs);
    assert.equal(state.slots[0]?.observed_reset_at_is_stable, true);
    assert.equal(state.slots[0]?.banked_reset_generation_ambiguous, false);

    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1);
    assert.equal(selected.kind, "quota_blocked");

    assert.deepEqual(
      selected.blockedAccounts.map(({ quotaResetAtMs, routingGeneration }) => ({
        quotaResetAtMs,
        routingGeneration,
      })),
      [{ quotaResetAtMs: resetAtMs, routingGeneration: required(state, "persisted routing state").slots[0].generation }]
    );
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("an ordinary ambiguous deadline does not use the bounded recovery-probe lease", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const firstResetAtMs = now + 60_000;
    const conflictingResetAtMs = now + 120_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(
        JSON.stringify({
          error: { type: "usage_limit_reached", resets_at: Math.floor(firstResetAtMs / 1_000) },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": new Date(conflictingResetAtMs).toUTCString(),
          },
        }
      ),
      now
    );
    const conflicted = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(conflicted?.slots[0]?.banked_reset_generation_ambiguous, true);
    assert.equal(conflicted.slots[0]?.banked_reset_recovery_probe_pending, false);

    const halfOpen = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, conflictingResetAtMs + 1);
    assert.equal(halfOpen.kind, "eligible");

    const claimed = await claimCodexRoutingProbe(singlePool, halfOpen.accounts[0], conflictingResetAtMs + 1);
    assert.ok(claimed);

    const longResetAtMs = conflictingResetAtMs + 120_000;
    await markCodexQuotaBlocked(
      claimed,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(longResetAtMs).toUTCString() },
      }),
      conflictingResetAtMs + 1
    );
    const afterProbe = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(afterProbe?.slots[0]?.quota_blocked_until_ms, longResetAtMs);
    assert.equal(afterProbe.slots[0]?.banked_reset_recovery_probe_pending, false);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a failed verified-reset probe uses a bounded retry instead of the old quota deadline", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const resetAtMs = now + 60_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.3-codex-spark");
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(resetAtMs).toUTCString() },
      }),
      now
    );
    const beforeReset = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    const routingGeneration = beforeReset?.slots[0]?.generation;
    assert.equal(typeof routingGeneration, "number");

    const recovery = await reconcileCodexQuotaAfterVerifiedReset(initial.accounts[0], {
      quotaResetAtMs: resetAtMs,
      routingGeneration: required(routingGeneration, "routing generation"),
    });
    assert.ok(recovery);
    assert.equal(recovery.probeCircuit, "quota");
    assert.equal(parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)))?.slots[0]?.probe_lease?.quota_class, "spark");

    const failedProbe = await markCodexRecoveryProbeQuotaBlocked(
      recovery,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(resetAtMs).toUTCString() },
      }),
      now
    );
    assert.equal(failedProbe.retryAtMs, resetAtMs);
    const afterProbe = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(afterProbe?.slots[0]?.quota_blocked_until_ms, now + CODEX_HALF_OPEN_LEASE_MS);
    assert.equal(afterProbe.slots[0]?.banked_reset_generation_ambiguous, true);
    assert.equal(afterProbe.slots[0]?.banked_reset_recovery_probe_pending, true);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a non-quota verified-reset probe clears recovery-pending evidence", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const resetAtMs = now + 60_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now, "gpt-5.3-codex-spark");
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(resetAtMs).toUTCString() },
      }),
      now
    );
    const beforeReset = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    const routingGeneration = beforeReset?.slots[0]?.generation;
    assert.equal(typeof routingGeneration, "number");

    const recovery = await reconcileCodexQuotaAfterVerifiedReset(initial.accounts[0], {
      quotaResetAtMs: resetAtMs,
      routingGeneration: required(routingGeneration, "routing generation"),
    });
    assert.ok(recovery);

    const released = await markCodexRecoveryProbeQuotaBlocked(
      recovery,
      new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
      now
    );
    assert.equal(released.usageLimitReached, false);
    const afterProbe = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(afterProbe?.slots[0]?.quota_blocked_until_ms, null);
    assert.equal(afterProbe.slots[0]?.banked_reset_recovery_probe_pending, false);
    assert.equal(afterProbe.slots[0]?.probe_lease, null);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a stale verified reset opens a fenced probe without spending another reset", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const resetAtMs = now + 60_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(resetAtMs).toUTCString() },
      }),
      now
    );
    const beforeStaleRecovery = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.ok(beforeStaleRecovery);
    const staleGeneration = beforeStaleRecovery.slots[0].generation + 1;
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      ...beforeStaleRecovery,
      slots: [
        {
          ...beforeStaleRecovery.slots[0],
          generation: staleGeneration,
          banked_reset_generation_ambiguous: true,
        },
      ],
    });
    resetCodexAccountRoutingForTest();

    const recovery = await reconcileCodexQuotaAfterStaleVerifiedReset(initial.accounts[0], {
      quotaResetAtMs: resetAtMs,
      routingGeneration: staleGeneration,
    });
    assert.ok(recovery);
    assert.equal(recovery.probeGeneration, staleGeneration + 1);
    const afterRecovery = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(afterRecovery?.slots[0]?.quota_blocked_until_ms, null);
    assert.equal(afterRecovery.slots[0]?.banked_reset_generation_ambiguous, true);
    assert.ok(afterRecovery.slots[0]?.probe_lease);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("legacy neutral v2 state permits its first canonical body resets_at fence", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const resetAtSeconds = Math.floor(now / 1_000) + 120;
    const resetAtMs = resetAtSeconds * 1_000;
    const credentialVersion = await codexCredentialVersion(singlePool.accounts[0]);
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      v: 2,
      updated_at_ms: now,
      slots: [
        {
          credential_version: credentialVersion,
          quota_blocked_until_ms: null,
          quota_block_source: null,
          invalid_credential_version: null,
          primary_used_percent: null,
          secondary_used_percent: null,
          observed_reset_at_ms: null,
          generation: 0,
          probe_lease: null,
        },
      ],
    });

    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    await markCodexQuotaBlocked(
      initial.accounts[0],
      new Response(JSON.stringify({ error: { type: "usage_limit_reached", resets_at: resetAtSeconds } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
      now
    );

    const state = parseCodexAccountRoutingState(kv.values.get(key(CODEX_ACCOUNT_ROUTING_KV_KEY)));
    assert.equal(state?.slots[0]?.generation, 1);
    assert.equal(state.slots[0]?.quota_block_source, "body_resets_at");
    assert.equal(state.slots[0]?.observed_reset_at_ms, resetAtMs);
    assert.equal(state.slots[0]?.observed_reset_at_is_stable, true);
    assert.equal(state.slots[0]?.banked_reset_generation_ambiguous, false);
    assert.equal(await getCodexQuotaBlockFence(initial.accounts[0], resetAtMs), 1);

    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now + 1);
    assert.equal(selected.kind, "quota_blocked");

    assert.deepEqual(
      selected.blockedAccounts.map(({ quotaResetAtMs, routingGeneration }) => ({
        quotaResetAtMs,
        routingGeneration,
      })),
      [{ quotaResetAtMs: resetAtMs, routingGeneration: 1 }]
    );
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("only the exact contaminated first body fence repairs legacy ambiguity", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  try {
    const now = 1_700_000_000_000;
    const resetAtMs = now + 120_000;
    const initial = await selectCodexRoutingAccounts(singlePool, singlePool.accounts, now);
    assert.equal(initial.kind, "eligible");

    const account = initial.accounts[0];
    const contaminatedSlot = {
      account_id_hash: account.accountIdHash,
      credential_version: account.credentialVersion,
      quota_blocked_until_ms: resetAtMs,
      quota_block_source: "body_resets_at",
      invalid_credential_version: null,
      primary_used_percent: 100,
      secondary_used_percent: 0,
      observed_reset_at_ms: resetAtMs,
      observed_reset_at_is_stable: true,
      banked_reset_generation_ambiguous: true,
      generation: 1,
      probe_lease: null,
    };
    const state = (slot: Record<string, unknown>, legacyIdentityUnresolved = false) => ({
      v: 2,
      updated_at_ms: now,
      banked_reset_legacy_identity_unresolved: legacyIdentityUnresolved,
      slots: [slot],
    });

    const repaired = parseCodexAccountRoutingState(state(contaminatedSlot));
    assert.equal(repaired?.slots[0]?.banked_reset_generation_ambiguous, false);
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, state(contaminatedSlot));
    assert.equal(await getCodexQuotaBlockFence(account, resetAtMs), 1);

    const missingInvalidCredential: Record<string, unknown> = { ...contaminatedSlot };
    delete missingInvalidCredential.invalid_credential_version;
    const nearMisses = [
      { name: "later generation", slot: { ...contaminatedSlot, generation: 2 } },
      { name: "header source", slot: { ...contaminatedSlot, quota_block_source: "header_retry_after" } },
      {
        name: "deadline mismatch",
        slot: { ...contaminatedSlot, quota_blocked_until_ms: resetAtMs + 1 },
      },
      {
        name: "unstable observation",
        slot: { ...contaminatedSlot, observed_reset_at_is_stable: false },
      },
      {
        name: "active probe",
        slot: {
          ...contaminatedSlot,
          probe_lease: { token: "probe", expires_at_ms: now + 30_000, generation: 1 },
        },
      },
      {
        name: "invalid credential",
        slot: { ...contaminatedSlot, invalid_credential_version: account.credentialVersion },
      },
      { name: "missing invalid credential field", slot: missingInvalidCredential },
      { name: "malformed invalid credential field", slot: { ...contaminatedSlot, invalid_credential_version: 1 } },
      { name: "missing account identity", slot: { ...contaminatedSlot, account_id_hash: null } },
    ];
    for (const testCase of nearMisses) {
      const parsed = parseCodexAccountRoutingState(state(testCase.slot));
      assert.equal(parsed?.slots[0]?.banked_reset_generation_ambiguous, true, testCase.name);
    }
    const globallyUnresolved = parseCodexAccountRoutingState(state(contaminatedSlot, true));
    assert.equal(globallyUnresolved?.slots[0]?.banked_reset_generation_ambiguous, true);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});
