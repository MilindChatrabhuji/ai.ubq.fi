import { test } from "bun:test";
import { type Kv } from "#kv";
// Mock reproduction of the 2026-10-05 capacity-only banked-reset incident and
// its final shipped contract: 5e4f516b/219217a8 materialize a blocked cohort
// identity plus a durable class-block fence from a capacity-100% observation
// (with 1ccfeb4e keeping deadline-less exhaustion half-open), the runtime
// materializes that fence through the same persisted transition a live 429
// uses, a live episode arms before exactly one verified consume, and the
// redemption cap is one per ACCOUNT per UTC day at
// ["uos_ai", "codex_reset_redemption", "account_day", "v1", accountHash, day]
// (7c8f1402/1a3d3a5f). The retired global_day counter is retained for rollback
// but never read or enforced, so two accounts may each redeem once on the same
// day while one account's second distinct episode that day is refused with
// account_day_limit_reached without another consume or counter increment.

import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_AUTH_POOL_KV_KEY,
  type CodexAuthPoolState,
  RoutingKv,
  codexCredentialVersion,
  getCodexQuotaBlockFence,
  httpDateQuotaResponse,
  markCodexQuotaBlocked,
  recordCodexCapacityRoutingObservations,
  required,
  resetCodexAccountRoutingForTest,
  resetProviderSelectionCacheForTest,
  selectCodexRoutingAccountsStrong,
  setKvForTest,
  singlePool,
} from "./helpers/codex-account-routing-harness.ts";
import {
  FakeCodexUsageResetProvider,
  MemoryKv,
  TestClock,
  attemptCodexBankedReset,
  candidate,
  codexResetAccountDailyKey,
  codexResetGlobalDailyKey,
  codexResetRedemptionKey,
  config,
  dependencies,
  evaluateCodexBankedResetPool,
  inventory,
  parseCodexBankedResetConfig,
  provenContract,
  requiredHash,
  seedFences,
  testHash,
} from "./helpers/codex-banked-reset-harness.ts";
import { providerPolicyReason } from "../src/codex/banked-reset.ts";
import { sha256Hex } from "../src/utils.ts";

type RoutingAuth = CodexAuthPoolState["accounts"][number];

const DAY_MS = 24 * 60 * 60_000;
const LUNA = "gpt-5.6-luna";
/** The weekly primary window every capacity fixture describes. */
const WEEKLY_WINDOW_SECONDS = 604_800;

const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/** The per-account UTC-day submission budget the shipped cap enforces. */
const accountDayCount = async (kv: MemoryKv, accountId: string, day: string): Promise<number | null> =>
  (await kv.get<{ submission_count: number }>(codexResetAccountDailyKey(await testHash(accountId), day))).value?.submission_count ?? null;

const liveIncidentConfig = () => config({ mode: "live", maxPerAccountPerDay: 1, maxPerAccountPerWindow: 1 });

const harnessAuth = (now: number): RoutingAuth => ({ ...singlePool.accounts[0], updated_at_ms: now });

const routingAccountIdHash = async (accountId: string): Promise<string> => await sha256Hex(`uos_ai\u0000codex_routing_account\u0000${accountId}`);

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

test("a capacity-100% class yields a blocked cohort identity, and only materialization arms its fence", async () => {
  const kv = new RoutingKv();
  setKvForTest(kv as unknown as Kv);
  resetCodexAccountRoutingForTest();
  resetProviderSelectionCacheForTest();
  try {
    const now = 1_700_000_000_000;
    const auth = harnessAuth(now);
    await kv.set(CODEX_AUTH_POOL_KV_KEY, { accounts: [auth], updated_at_ms: now });
    // No class blocks, and the leftover identity is an expired ambiguous
    // observation. It carries no stable flag: a retained stable observation
    // deliberately stays lookup-only until a successful probe (pinned in
    // tests/codex-banked-reset-capacity-recovery.test.ts), while this expired
    // observation is superseded by the fresh applied deadline.
    await kv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, {
      v: 2 as const,
      updated_at_ms: now,
      slots: [
        await routingSlot(auth, {
          primary_used_percent: 100,
          observed_reset_at_ms: now - 7 * DAY_MS,
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
          source_observed_at_ms: now,
          snapshot_at_ms: now,
          windows: {
            primary: { limit_window_seconds: WEEKLY_WINDOW_SECONDS, used_percent: 100, reset_at_ms: resetAtMs },
            secondary: null,
          },
          additional_rate_limits: [],
        },
      ],
      now
    );

    // Step 1: the fully used class is authoritative exhaustion, so the
    // selection names the blocked cohort identity with the observed deadline.
    const selected = await selectCodexRoutingAccountsStrong(singlePool, singlePool.accounts, now + 2, LUNA);
    assert.equal(selected.kind, "quota_blocked");
    assert.equal(selected.fullCohortExhausted, true);
    const blocked = required(selected.blockedAccounts[0], "the blocked cohort identity");
    assert.equal(blocked.quotaResetAtMs, resetAtMs);
    // Step 2: the in-memory identity alone arms no claim.
    assert.equal(await getCodexQuotaBlockFence(blocked, resetAtMs), null);

    // Step 3: emulate the shipped materialization exactly, a fresh applied
    // stable deadline from the observation's reset instant.
    await markCodexQuotaBlocked(blocked, httpDateQuotaResponse(resetAtMs), now + 3);

    // Step 4: only now is the durable class-block fence current, and the
    // refreshed selection still reports the same blocked identity.
    assert.equal(typeof (await getCodexQuotaBlockFence(blocked, resetAtMs)), "number");
    const refreshed = await selectCodexRoutingAccountsStrong(singlePool, singlePool.accounts, now + 4, LUNA);
    assert.equal(refreshed.kind, "quota_blocked");
    assert.equal(refreshed.fullCohortExhausted, true);
    assert.equal(required(refreshed.blockedAccounts[0], "the materialized blocked identity").quotaResetAtMs, resetAtMs);
  } finally {
    setKvForTest(null);
    resetCodexAccountRoutingForTest();
  }
});

test("a capacity-blocked live episode arms without spending and then consumes exactly once", async () => {
  const kv = new MemoryKv();
  const clock = new TestClock();
  const reset = candidate({ accountId: "incident-account-a", routingGeneration: 7 });
  await seedFences(kv, reset);
  const provider = new FakeCodexUsageResetProvider();
  provider.inventory = inventory("incident-credit-a", clock.nowMs + 20_000);
  const pool = [{ slot: 0, candidate: reset, provider }] as const;
  const deps = dependencies(kv, provider, clock, liveIncidentConfig());

  const armed = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(armed.kind, "shadow");
  assert.equal(armed.reason, "live_armed");
  assert.equal(armed.reset, null);
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(await accountDayCount(kv, "incident-account-a", utcDay(clock.nowMs)), null);

  const consumed = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(consumed.kind, "verified");
  assert.equal(consumed.selected?.slot, 0);
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.redeemInputs[0]?.creditId, "incident-credit-a");
  assert.equal(provider.commitCount, 1);
  assert.equal(await accountDayCount(kv, "incident-account-a", utcDay(clock.nowMs)), 1);

  // The durable copy of the episode holds exactly one verified redemption.
  const redemption = kv.redemptionRecord(
    codexResetRedemptionKey(requiredHash(consumed.reset?.accountIdHash ?? null), requiredHash(consumed.reset?.quotaGeneration ?? null))
  );
  assert.equal(redemption?.state, "verified");

  // The same episode cannot spend a second credit on a later request.
  const repeated = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(repeated.kind, "verified");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
  assert.equal(await accountDayCount(kv, "incident-account-a", utcDay(clock.nowMs)), 1);
});

test("two accounts may each redeem once per UTC day, and one account's second episode is refused", async () => {
  const kv = new MemoryKv();
  const clock = new TestClock();
  const day = utcDay(clock.nowMs);
  const provider = new FakeCodexUsageResetProvider();
  const configured = liveIncidentConfig();
  const deps = dependencies(kv, provider, clock, configured);
  const accountFirst = candidate({ accountId: "incident-account-a" });
  const accountB = candidate({ accountId: "incident-account-b", requestId: "incident-account-b" });
  // A second, distinct quota window for account A later the same UTC day
  // (a new quota generation, so the window ledger alone would allow it).
  const accountSecond = candidate({ accountId: "incident-account-a", requestId: "incident-account-a-second", quotaResetAtMs: clock.nowMs + 120_000 });
  await seedFences(kv, accountFirst);
  await seedFences(kv, accountB);
  await seedFences(kv, accountSecond);

  const first = await attemptCodexBankedReset(accountFirst, deps);
  assert.equal(first.kind, "verified");
  assert.equal(await accountDayCount(kv, "incident-account-a", day), 1);

  // A different account keeps its own daily budget: the retired global cap
  // would have refused this redemption.
  const second = await attemptCodexBankedReset(accountB, deps);
  assert.equal(second.kind, "verified");
  assert.equal(await accountDayCount(kv, "incident-account-a", day), 1);
  assert.equal(await accountDayCount(kv, "incident-account-b", day), 1);

  const refused = await attemptCodexBankedReset(accountSecond, deps);
  assert.equal(refused.kind, "skipped");
  assert.equal(refused.reason, "account_day_limit_reached");
  assert.equal(await accountDayCount(kv, "incident-account-a", day), 1);
  assert.equal(provider.redeemInputs.filter((input) => input.accountId === "incident-account-a").length, 1);
  assert.equal(provider.redeemInputs.filter((input) => input.accountId === "incident-account-b").length, 1);
  assert.equal(provider.commitCount, 2);
  // The refused window never crosses the submission boundary: its ledger row
  // stays at the claim lease written before the durable budget read.
  const refusedRecord = kv.redemptionRecord(
    codexResetRedemptionKey(requiredHash(refused.accountIdHash ?? null), requiredHash(refused.quotaGeneration ?? null))
  );
  assert.equal(refusedRecord?.state, "claimed");
  // The retired global counter is retained but never written or enforced by
  // the per-account budget path.
  assert.equal((await kv.get(codexResetGlobalDailyKey(day))).value, null);
});

test("the live banked-reset policy requires an exact per-account daily cap of one for a terminal provider", async () => {
  // The parser fails closed: the retired global variable is not read, and an
  // absent new cap leaves live submissions disabled until an explicit 1.
  const declared = parseCodexBankedResetConfig((key) => (key === "CODEX_BANKED_RESET_MODE" ? "live" : undefined));
  assert.equal(declared.mode, "live");
  assert.equal(declared.maxPerAccountPerDay, 0);
  assert.equal("maxGlobalPerDay" in declared, false);

  const terminalProvider = new FakeCodexUsageResetProvider({ ...provenContract(), redeemOutcomeIsFinal: true });
  const explicit = { ...declared, maxPerAccountPerDay: 1 };
  assert.equal(providerPolicyReason(explicit, terminalProvider), null);
  assert.equal(providerPolicyReason({ ...explicit, maxPerAccountPerDay: 2 }, terminalProvider), "terminal_outcome_account_day_limit_must_be_one");

  const kv = new MemoryKv();
  const clock = new TestClock();
  const reset = candidate({ accountId: "incident-terminal-account" });
  await seedFences(kv, reset);
  const refused = await evaluateCodexBankedResetPool(
    [{ slot: 0, candidate: reset, provider: terminalProvider }],
    dependencies(kv, terminalProvider, clock, config({ mode: "live", maxPerAccountPerDay: 2 }))
  );
  assert.equal(refused.kind, "skipped");
  assert.equal(refused.reason, "terminal_outcome_account_day_limit_must_be_one");
  assert.equal(terminalProvider.callCount, 0);
});
