// Per-account daily redemption cap coverage (hard cutover from the retired
// global daily cap, fix for the 2026-10-05 two-expiring-credits incident).
// Each account owns its own UTC-day submission budget at
// ["uos_ai", "codex_reset_redemption", "account_day", "v1", account_id_hash,
// day], charged atomically at the durable `submitted` boundary. Legacy
// global_day records are retained for rollback and never enforced.

import assert from "node:assert/strict";
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
  parseCodexBankedResetConfig,
  provenContract,
  requiredHash,
  seedFences,
  testHash,
} from "./helpers/codex-banked-reset-harness.ts";

const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

const accountDayCount = async (kv: MemoryKv, accountId: string, day: string): Promise<number | null> =>
  (await kv.get<{ submission_count: number }>(codexResetAccountDailyKey(await testHash(accountId), day))).value?.submission_count ?? null;

Deno.test("two different accounts can each redeem once in the same UTC day", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const first = candidate({ accountId: "day-account-a" });
  const second = candidate({ accountId: "day-account-b", requestId: "day-account-b" });
  await seedFences(kv, first);
  await seedFences(kv, second);
  const deps = dependencies(kv, provider, clock, config({ maxPerAccountPerDay: 1 }));

  const firstReset = await attemptCodexBankedReset(first, deps);
  const secondReset = await attemptCodexBankedReset(second, deps);

  assert.equal(firstReset.kind, "verified");
  assert.equal(secondReset.kind, "verified");
  assert.equal(provider.redeemInputs.length, 2);
  assert.equal(provider.commitCount, 2);
  const day = utcDay(clock.nowMs);
  assert.equal(await accountDayCount(kv, "day-account-a", day), 1);
  assert.equal(await accountDayCount(kv, "day-account-b", day), 1);
});

Deno.test("an account's second redemption in the same UTC day is refused with zero consume calls", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  // Two distinct quota windows for one account: the window ledger permits the
  // second window, and only the per-account daily budget refuses it.
  const firstWindow = candidate({ accountId: "day-account-a" });
  const secondWindow = candidate({ accountId: "day-account-a", requestId: "second-window", quotaResetAtMs: 1_700_000_120_000 });
  await seedFences(kv, firstWindow);
  await seedFences(kv, secondWindow);
  const deps = dependencies(kv, provider, clock, config({ maxPerAccountPerDay: 1 }));

  const first = await attemptCodexBankedReset(firstWindow, deps);
  assert.equal(first.kind, "verified");
  const refused = await attemptCodexBankedReset(secondWindow, deps);

  assert.equal(refused.kind, "skipped");
  assert.equal(refused.reason, "account_day_limit_reached");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
  const day = utcDay(clock.nowMs);
  assert.equal(await accountDayCount(kv, "day-account-a", day), 1);
  // The refused window never crosses the submission boundary: its ledger row
  // stays at the claim lease written before the durable budget read.
  const refusedRecord = kv.redemptionRecord(
    codexResetRedemptionKey(requiredHash(refused.accountIdHash ?? null), requiredHash(refused.quotaGeneration ?? null))
  );
  assert.equal(refusedRecord?.state, "claimed");
});

Deno.test("per-window exact-once still prevents a re-spend of the same window", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate({ accountId: "day-account-a" });
  await seedFences(kv, reset);
  const deps = dependencies(kv, provider, clock, config({ maxPerAccountPerDay: 1 }));

  const first = await attemptCodexBankedReset(reset, deps);
  assert.equal(first.kind, "verified");
  const repeat = await attemptCodexBankedReset(candidate({ ...reset, requestId: "same-window-later-request" }), deps);

  assert.equal(repeat.kind, "verified");
  assert.equal(repeat.reason, "previously_verified");
  assert.equal(repeat.idempotencyKeyHash, first.idempotencyKeyHash);
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
  assert.equal(await accountDayCount(kv, "day-account-a", utcDay(clock.nowMs)), 1);
});

Deno.test("live mode requires an exact per-account daily cap of one and shadow never spends", async () => {
  // The parser reads only the new environment variable; the retired global
  // variable is not read at all.
  const declared = parseCodexBankedResetConfig((key) => {
    if (key === "CODEX_BANKED_RESET_MODE") return "live";
    if (key === "CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_DAY") return "2";
    return undefined;
  });
  assert.equal(declared.mode, "live");
  assert.equal(declared.maxPerAccountPerDay, 2);
  const retired = parseCodexBankedResetConfig((key) => (key === "CODEX_BANKED_RESET_MAX_GLOBAL_PER_DAY" ? "0" : undefined));
  // Fail closed: the retired global variable is ignored and an absent new cap stays disabled.
  assert.equal(retired.maxPerAccountPerDay, 0);
  assert.equal("maxGlobalPerDay" in retired, false);

  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate({ accountId: "day-account-a" });
  await seedFences(kv, reset);

  // A live configuration above one fails closed through the policy gate.
  const refused = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock, config({ maxPerAccountPerDay: 2 })));
  assert.equal(refused.kind, "skipped");
  assert.equal(refused.reason, "per_account_day_limit_invalid");
  assert.equal(provider.callCount, 0);

  // A terminal-outcome provider keeps its dedicated reason for the same rule.
  const terminalProvider = new FakeCodexUsageResetProvider({ ...provenContract(), redeemOutcomeIsFinal: true });
  const refusedTerminal = await attemptCodexBankedReset(reset, dependencies(kv, terminalProvider, clock, config({ maxPerAccountPerDay: 2 })));
  assert.equal(refusedTerminal.kind, "skipped");
  assert.equal(refusedTerminal.reason, "terminal_outcome_account_day_limit_must_be_one");
  assert.equal(terminalProvider.callCount, 0);

  const zeroCap = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock, config({ maxPerAccountPerDay: 0 })));
  assert.equal(zeroCap.kind, "skipped");
  assert.equal(zeroCap.reason, "per_account_day_limit_invalid");

  // Shadow mode never charges or spends, even with a large declared cap.
  const shadow = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock, config({ mode: "shadow", maxPerAccountPerDay: 2 })));
  assert.equal(shadow.kind, "skipped");
  assert.equal(shadow.reason, "shadow");
  assert.equal(provider.callCount, 0);
  assert.equal((await kv.get(codexResetAccountDailyKey(await testHash(reset.accountId), utcDay(clock.nowMs)))).value, null);
});

Deno.test("a pre-existing nonzero legacy global_day record no longer blocks another account", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const day = utcDay(clock.nowMs);
  const legacyRecord = { v: 1, day, submission_count: 4, updated_at_ms: clock.nowMs };
  await kv.set(codexResetGlobalDailyKey(day), legacyRecord);
  const reset = candidate({ accountId: "day-account-a" });
  await seedFences(kv, reset);

  const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock, config({ maxPerAccountPerDay: 1 })));

  assert.equal(result.kind, "verified");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(await accountDayCount(kv, "day-account-a", day), 1);
  // The legacy row is retained untouched for rollback, but never enforced.
  assert.deepEqual((await kv.get(codexResetGlobalDailyKey(day))).value, legacyRecord);
});
