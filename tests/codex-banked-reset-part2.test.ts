import { test } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
// codex-banked-reset suite part: tests moved out of tests/codex-banked-reset.test.ts.

import assert from "node:assert/strict";
import {
  BANKED_RESET_GENERATED_EVENTS,
  CODEX_BANKED_RESET_INVENTORY_MAX_AGE_MS,
  CODEX_BANKED_RESET_INVENTORY_TIMEOUT_MS,
  CODEX_BANKED_RESET_LEASE_MS,
  type CodexBankedResetConfig,
  Deferred,
  FakeCodexUsageResetProvider,
  type FakeProviderCall,
  type GeneratedResetScenario,
  MemoryKv,
  type RedeemResetResult,
  type ResetInventory,
  TestClock,
  applyBankedResetEvent,
  assertBankedResetInvariants,
  attemptCodexBankedReset,
  candidate,
  clone,
  codexResetAccountDailyKey,
  codexResetRedemptionKey,
  codexResetUsageKey,
  config,
  dependencies,
  encodeKey,
  evaluateCodexBankedResetPool,
  fullPool,
  inventory,
  isRecord,
  reconcileCodexBankedReset,
  requiredHash,
  routingFenceKey,
  sanitizedProviderFixtures,
  seedFences,
  shadowDecisionFrom,
  testHash,
} from "./helpers/codex-banked-reset-harness.ts";

test("generated banked-reset event sequences retain the durable state-machine invariants", async () => {
  const sequenceCount = 48;
  let seed = 0x41c6_0de5;
  const next = (): number => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return seed;
  };

  for (let sequenceIndex = 0; sequenceIndex < sequenceCount; sequenceIndex += 1) {
    const sequenceSeed = next();
    let random = sequenceSeed;
    const choose = (): number => {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      return random;
    };
    // Each reproducible sequence includes the full model alphabet before a
    // deterministic shuffle/repetition, so a failing seed identifies the
    // exact interleaving without relying on a flaky random test runner.
    const sequence = [...BANKED_RESET_GENERATED_EVENTS];
    for (let index = sequence.length - 1; index > 0; index -= 1) {
      const swap = choose() % (index + 1);
      [sequence[index], sequence[swap]] = [sequence[swap], sequence[index]];
    }
    for (let index = 0; index < 11; index += 1) sequence.push(BANKED_RESET_GENERATED_EVENTS[choose() % BANKED_RESET_GENERATED_EVENTS.length]);

    const accountId = `generated-account-${sequenceIndex}`;
    const reset = candidate({
      accountId,
      credentialVersion: `generated-credential-${sequenceSeed}`,
      quotaResetAtMs: 1_700_000_060_000 + sequenceIndex,
      routingGeneration: sequenceSeed % 1000,
      requestId: `generated-${sequenceSeed}`,
    });
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const modes: readonly CodexBankedResetConfig["mode"][] = ["live", "shadow", "disabled"];
    const mode = modes[sequenceSeed % modes.length];
    const configured = config({
      mode,
      enabled: mode === "live" || mode === "shadow",
    });
    const deps = dependencies(kv, provider, clock, configured);
    await seedFences(kv, reset);
    provider.redeemResult = clone(sanitizedProviderFixtures.rate_limit);
    provider.commitOnRedeem = true;

    const scenario: GeneratedResetScenario = {
      reset,
      deps,
      provider,
      kv,
      clock,
      sequenceSeed,
      qualifyingObservationIsCurrent: false,
      lastOutcome: null,
      postResetInferenceRetries: 0,
      credentialWasRotated: false,
    };

    for (const event of sequence) {
      const label = `seed ${sequenceSeed} event ${event}`;
      const submissionsBefore = provider.redeemInputs.length;
      await applyBankedResetEvent(scenario, event, label);
      assertBankedResetInvariants(scenario, label, submissionsBefore, mode);
    }
  }
});

test("two different accounts can each redeem once in the same UTC day", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const configured = config({ maxPerAccountPerDay: 1 });
  const deps = dependencies(kv, provider, clock, configured);
  const firstCandidate = candidate();
  const secondCandidate = candidate({ accountId: "test-account-b", requestId: "second-account" });
  await seedFences(kv, firstCandidate);
  await seedFences(kv, secondCandidate);
  const first = await attemptCodexBankedReset(firstCandidate, deps);
  const second = await attemptCodexBankedReset(secondCandidate, deps);

  assert.equal(first.kind, "verified");
  assert.equal(second.kind, "verified");
  assert.equal(provider.redeemInputs.length, 2);
  assert.equal(provider.commitCount, 2);
  const day = new Date(clock.nowMs).toISOString().slice(0, 10);
  assert.equal(
    (await kv.get<{ submission_count: number }>(codexResetAccountDailyKey(await testHash(firstCandidate.accountId), day))).value?.submission_count,
    1
  );
  assert.equal(
    (await kv.get<{ submission_count: number }>(codexResetAccountDailyKey(await testHash(secondCandidate.accountId), day))).value?.submission_count,
    1
  );
});

test("an inventory failure leaves the account's daily submission budget available", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const configured = config({ maxPerAccountPerDay: 1 });
  const firstCandidate = candidate();
  const secondCandidate = candidate({ accountId: "test-account-b", requestId: "after-inventory-failure" });
  await seedFences(kv, firstCandidate);
  await seedFences(kv, secondCandidate);
  provider.inventoryFailure = new Error("inventory unavailable");

  const first = await attemptCodexBankedReset(firstCandidate, dependencies(kv, provider, clock, configured));
  assert.equal(first.kind, "rejected");
  assert.equal(first.reason, "inventory_unavailable");
  const day = new Date(clock.nowMs).toISOString().slice(0, 10);
  assert.equal((await kv.get(codexResetAccountDailyKey(await testHash(firstCandidate.accountId), day))).value, null);

  provider.inventoryFailure = null;
  const second = await attemptCodexBankedReset(secondCandidate, dependencies(kv, provider, clock, configured));
  assert.equal(second.kind, "verified");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(
    (await kv.get<{ submission_count: number }>(codexResetAccountDailyKey(await testHash(secondCandidate.accountId), day))).value?.submission_count,
    1
  );
});

test("a claim held across UTC midnight cannot bypass the next day's per-account redemption cap", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const dayMs = 24 * 60 * 60 * 1_000;
  const firstCandidate = candidate({ quotaResetAtMs: clock.nowMs + 2 * dayMs });
  const secondCandidate = candidate({
    accountId: "test-account-a",
    requestId: "next-day-account",
    quotaResetAtMs: clock.nowMs + dayMs + 60_000,
  });
  await seedFences(kv, firstCandidate);
  await seedFences(kv, secondCandidate);
  const deps = dependencies(kv, provider, clock, config({ maxPerAccountPerDay: 1 }));
  const inventoryGate = new Deferred<void>();
  const inventoryEntered = new Deferred<void>();
  provider.inventoryGate = inventoryGate.promise;
  provider.inventoryEntered = inventoryEntered;

  const heldClaim = attemptCodexBankedReset(firstCandidate, deps);
  await inventoryEntered.promise;
  clock.advance(dayMs);
  provider.inventory = { ...provider.inventory, observedAtMs: clock.nowMs };
  inventoryGate.resolve(undefined);

  const first = await heldClaim;
  assert.equal(first.kind, "rejected");
  assert.equal(first.reason, "claim_day_elapsed");
  assert.equal(provider.redeemInputs.length, 0);

  const second = await attemptCodexBankedReset(secondCandidate, deps);
  assert.equal(second.kind, "verified");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
  const currentDay = new Date(clock.nowMs).toISOString().slice(0, 10);
  assert.equal(
    (await kv.get<{ submission_count: number }>(codexResetAccountDailyKey(await testHash(secondCandidate.accountId), currentDay))).value?.submission_count,
    1
  );
});

test("empty or unsupported inventory and provider rejection become durable terminal rejections", async () => {
  const scenarios: Readonly<{
    name: string;
    configure: (provider: FakeCodexUsageResetProvider) => void;
    reason: string;
    redeemCalls: number;
  }>[] = [
    {
      name: "empty inventory",
      configure: (provider) => {
        provider.inventory = {
          availableCount: 0,
          observedAtMs: 1_700_000_000_000,
          credits: [],
        };
      },
      reason: "inventory_empty",
      redeemCalls: 0,
    },
    {
      name: "unsupported inventory type",
      configure: (provider) => {
        provider.inventory = {
          availableCount: 1,
          observedAtMs: 1_700_000_000_000,
          credits: [{ id: "unreviewed-credit", status: "available", resetType: "unreviewed_reset", expiresAtMs: null }],
        };
      },
      reason: "inventory_no_eligible_codex_credit",
      redeemCalls: 0,
    },
    {
      name: "provider rejection",
      configure: (provider) => {
        provider.redeemResult = { kind: "rejected", reason: "provider validation rejected the request" };
      },
      reason: "provider_rejected",
      redeemCalls: 1,
    },
  ];

  for (const scenario of scenarios) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    scenario.configure(provider);
    const deps = dependencies(kv, provider, clock);
    const reset = candidate();
    await seedFences(kv, reset);
    const first = await attemptCodexBankedReset(reset, deps);
    const repeat = await attemptCodexBankedReset(candidate({ requestId: "repeat-rejection" }), deps);

    assert.equal(first.kind, "rejected", scenario.name);
    assert.equal(first.reason, scenario.reason, scenario.name);
    assert.equal(first.record?.state, "rejected", scenario.name);
    assert.equal(repeat.kind, "rejected", scenario.name);
    assert.equal(provider.redeemInputs.length, scenario.redeemCalls, scenario.name);
    assert.equal(provider.commitCount, 0, scenario.name);
  }
});

test("stale or future inventory cannot authorize a redemption", async () => {
  const cases: Readonly<{ name: string; observedAtDeltaMs: number }>[] = [
    { name: "stale", observedAtDeltaMs: -(CODEX_BANKED_RESET_INVENTORY_MAX_AGE_MS + 1) },
    { name: "future", observedAtDeltaMs: 1 },
  ];
  for (const testCase of cases) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate({ requestId: `inventory-${testCase.name}` });
    await seedFences(kv, reset);
    provider.inventory = {
      ...provider.inventory,
      observedAtMs: clock.nowMs + testCase.observedAtDeltaMs,
    };

    const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
    assert.equal(result.kind, "rejected", testCase.name);
    assert.equal(result.reason, "inventory_response_invalid_or_unsupported", testCase.name);
    assert.equal(provider.inventoryInputs.length, 1, testCase.name);
    assert.equal(provider.redeemInputs.length, 0, testCase.name);
    assert.equal(provider.commitCount, 0, testCase.name);
  }
});

test("KV outage and claim CAS exhaustion fail closed before any provider interaction", async () => {
  const clock = new TestClock();

  const unavailableKv = new MemoryKv();
  const unavailableCandidate = candidate();
  await seedFences(unavailableKv, unavailableCandidate);
  unavailableKv.getFailure = new Error("in-memory KV unavailable");
  const unavailableProvider = new FakeCodexUsageResetProvider();
  const unavailable = await attemptCodexBankedReset(unavailableCandidate, dependencies(unavailableKv, unavailableProvider, clock));
  assert.equal(unavailable.kind, "skipped");
  assert.equal(unavailable.reason, "kv_unavailable");
  assert.equal(unavailableProvider.callCount, 0);
  assert.equal(unavailableProvider.commitCount, 0);

  const casKv = new MemoryKv();
  casKv.failCommitNumbers.add(1);
  casKv.failCommitNumbers.add(2);
  casKv.failCommitNumbers.add(3);
  casKv.failCommitNumbers.add(4);
  const casProvider = new FakeCodexUsageResetProvider();
  const casCandidate = candidate();
  await seedFences(casKv, casCandidate);
  const exhausted = await attemptCodexBankedReset(casCandidate, dependencies(casKv, casProvider, clock));
  assert.equal(exhausted.kind, "skipped");
  assert.equal(exhausted.reason, "kv_cas_exhausted");
  assert.equal(casKv.atomicCommitCount, 4);
  assert.equal(casProvider.callCount, 0);
  assert.equal(casProvider.commitCount, 0);
});

test("a transient CAS conflict at every happy-path transition retains one logical redemption", async () => {
  // A normal successful path has five durable writes: claim, submitted,
  // final renewal, receipt persistence, and verification. Each operation
  // retries its own CAS conflict without issuing another provider mutation or
  // changing the deterministic idempotency key.
  for (const failedCommit of [1, 2, 3, 4, 5]) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate({ requestId: `transient-cas-${failedCommit}` });
    await seedFences(kv, reset);
    kv.failCommitNumbers.add(failedCommit);

    const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
    assert.equal(result.kind, "verified", `failed durable commit ${failedCommit}`);
    assert.equal(provider.commitCount, 1, `failed durable commit ${failedCommit}`);
    assert.equal(provider.redeemInputs.length, 1, `failed durable commit ${failedCommit}`);
    assert.equal(new Set(provider.redeemInputs.map((input) => input.idempotencyKey)).size, 1, `failed durable commit ${failedCommit}`);
  }
});

test("KV unavailability after claim, after submission, and during verification never opens a second spend path", async () => {
  {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate({ requestId: "kv-after-claim" });
    await seedFences(kv, reset);
    const entered = new Deferred<void>();
    const gate = new Deferred<void>();
    provider.inventoryEntered = entered;
    provider.inventoryGate = gate.promise;
    const pending = attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
    await entered.promise;
    kv.getFailure = new Error("KV failed after claim");
    gate.resolve(undefined);
    const outcome = await pending;

    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "kv_unavailable");
    assert.equal(outcome.record?.state, "claimed");
    assert.equal(provider.redeemInputs.length, 0);
  }

  {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate({ requestId: "kv-after-submission" });
    await seedFences(kv, reset);
    kv.beforeAtomicCommit = (commitNumber) => {
      if (commitNumber === 2) kv.getFailure = new Error("KV failed after submitted transition");
    };
    const outcome = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));

    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "kv_unavailable");
    assert.equal(outcome.record?.state, "submitted");
    assert.equal(provider.redeemInputs.length, 0);
  }

  {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate({ requestId: "kv-during-verification" });
    await seedFences(kv, reset);
    const entered = new Deferred<void>();
    const gate = new Deferred<void>();
    provider.verifyEntered = entered;
    provider.verifyGate = gate.promise;
    const pending = attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
    await entered.promise;
    kv.getFailure = new Error("KV failed while finalizing verification");
    gate.resolve(undefined);
    const outcome = await pending;

    assert.equal(outcome.kind, "pending");
    assert.equal(outcome.reason, "verification_cas_failed");
    assert.equal(outcome.record?.state, "submitted");
    assert.equal(provider.redeemInputs.length, 1);
    assert.equal(provider.commitCount, 1);
  }
});

test("a stale owner cannot finalize verified after a lease-takeover reconciliation", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate({ requestId: "stale-owner-verify" });
  await seedFences(kv, reset);
  const verifyEntered = new Deferred<void>();
  const verifyGate = new Deferred<void>();
  provider.verifyEntered = verifyEntered;
  provider.verifyGate = verifyGate.promise;
  const deps = dependencies(kv, provider, clock);
  const original = attemptCodexBankedReset(reset, deps);
  await verifyEntered.promise;

  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  provider.lookupResult = clone(sanitizedProviderFixtures.lookup_pending);
  provider.verifyResult = false;
  const takeover = await reconcileCodexBankedReset(candidate({ requestId: "stale-owner-verify-takeover" }), deps);
  assert.equal(takeover.kind, "pending");
  assert.equal(takeover.record?.state, "unknown");
  assert.equal(takeover.record.fence, 3);

  provider.verifyResult = true;
  verifyGate.resolve(undefined);
  const stale = await original;
  assert.equal(stale.kind, "pending");
  assert.equal(stale.reason, "verification_cas_failed");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(kv.redemptionRecord(codexResetRedemptionKey(requiredHash(takeover.accountIdHash), requiredHash(takeover.quotaGeneration)))?.state, "unknown");
});

test("receipt CAS loss leaves the transaction pending and recovery uses lookup instead of resubmission", async () => {
  const kv = new MemoryKv();
  // Claim, submitted state, and the final pre-redeem lease renewal are commits
  // 1 through 3. Exhaust every receipt-persist CAS retry.
  for (const commit of [4, 5, 6, 7]) kv.failCommitNumbers.add(commit);
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const deps = dependencies(kv, provider, clock);
  const reset = candidate();
  await seedFences(kv, reset);
  const first = await attemptCodexBankedReset(reset, deps);

  assert.equal(first.kind, "pending");
  assert.equal(first.reason, "receipt_cas_failed");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
  assert.equal(provider.verificationInputs.length, 0);

  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  provider.lookupResult = { kind: "completed", providerReceiptId: "receipt-after-cas-recovery" };
  const recovered = await attemptCodexBankedReset(candidate({ requestId: "cas-recovery" }), deps);
  assert.equal(recovered.kind, "verified");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.lookupInputs.length, 1);
  assert.equal(provider.commitCount, 1);
});

test("sanitized provider fixtures accept only complete known boundary results", async () => {
  const successfulFixtures: Readonly<{
    name: string;
    result: RedeemResetResult;
    expectedCommitCount: number;
    expectedReceipt: string;
  }>[] = [
    {
      name: "completed",
      result: sanitizedProviderFixtures.redemption_completed,
      expectedCommitCount: 1,
      expectedReceipt: "fixture-completed",
    },
    {
      name: "accepted",
      result: sanitizedProviderFixtures.redemption_accepted,
      expectedCommitCount: 1,
      expectedReceipt: "fixture-accepted",
    },
    {
      name: "idempotent replay",
      result: sanitizedProviderFixtures.redemption_already_redeemed,
      expectedCommitCount: 0,
      expectedReceipt: "fixture-replay",
    },
  ];

  for (const fixture of successfulFixtures) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate({ requestId: `fixture-${fixture.name}` });
    await seedFences(kv, reset);
    provider.inventory = clone(sanitizedProviderFixtures.inventory_available);
    provider.redeemResult = clone(fixture.result);
    const outcome = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));

    assert.equal(outcome.kind, "verified", fixture.name);
    assert.equal(outcome.record?.provider_receipt_id, fixture.expectedReceipt, fixture.name);
    assert.equal(provider.commitCount, fixture.expectedCommitCount, fixture.name);
    assert.equal(provider.redeemInputs.length, 1, fixture.name);
  }

  for (const fixture of [sanitizedProviderFixtures.malformed_success, sanitizedProviderFixtures.schema_drift]) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate({ requestId: `fixture-malformed-${fixture.kind}` });
    await seedFences(kv, reset);
    provider.redeemResult = fixture as unknown as RedeemResetResult;
    const outcome = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));

    assert.equal(outcome.kind, "pending", fixture.kind);
    assert.equal(outcome.reason, "submit_response_invalid", fixture.kind);
    assert.equal(outcome.record?.state, "unknown", fixture.kind);
    assert.equal(provider.verificationInputs.length, 0, fixture.kind);
  }

  for (const lookupFixture of [
    sanitizedProviderFixtures.lookup_pending,
    sanitizedProviderFixtures.lookup_rejected,
    sanitizedProviderFixtures.lookup_not_found,
  ]) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate({ requestId: `fixture-lookup-${lookupFixture.kind}` });
    await seedFences(kv, reset);
    provider.redeemResult = clone(sanitizedProviderFixtures.rate_limit);
    provider.commitOnRedeem = true;
    const first = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
    assert.equal(first.kind, "pending", lookupFixture.kind);
    const stableKey = provider.redeemInputs[0]?.idempotencyKey;
    clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
    provider.lookupResult = clone(lookupFixture);
    provider.verifyResult = false;
    const recovered = await reconcileCodexBankedReset(
      candidate({ requestId: `fixture-lookup-recovery-${lookupFixture.kind}` }),
      dependencies(kv, provider, clock)
    );

    assert.equal(recovered.kind, "pending", lookupFixture.kind);
    assert.equal(recovered.record?.state, "unknown", lookupFixture.kind);
    assert.equal(provider.redeemInputs.length, 1, lookupFixture.kind);
    assert.equal(provider.lookupInputs[0]?.idempotencyKey, stableKey, lookupFixture.kind);
  }
});

test("provider rejection matrix keeps definitive failures terminal and ambiguous failures unknown", async () => {
  const cases: Readonly<{
    name: string;
    configure: (provider: FakeCodexUsageResetProvider) => void;
    expectedKind: "pending" | "rejected";
    expectedState: "unknown" | "rejected";
    expectedReason: string;
  }>[] = [
    {
      name: "reset allowance exhausted",
      configure: (provider) => {
        provider.inventory = clone(sanitizedProviderFixtures.inventory_empty);
      },
      expectedKind: "rejected",
      expectedState: "rejected",
      expectedReason: "inventory_empty",
    },
    {
      name: "provider authentication failure",
      configure: (provider) => {
        provider.redeemResult = clone(sanitizedProviderFixtures.authentication_error);
      },
      expectedKind: "rejected",
      expectedState: "rejected",
      expectedReason: "provider_rejected",
    },
    {
      name: "provider validation failure",
      configure: (provider) => {
        provider.redeemResult = {
          kind: "rejected",
          reason: "fixture-provider-validation-failure",
        };
      },
      expectedKind: "rejected",
      expectedState: "rejected",
      expectedReason: "provider_rejected",
    },
    {
      name: "provider rate limit with unknown commit status",
      configure: (provider) => {
        provider.redeemResult = clone(sanitizedProviderFixtures.rate_limit);
        provider.commitOnRedeem = true;
      },
      expectedKind: "pending",
      expectedState: "unknown",
      expectedReason: "provider_commit_unknown",
    },
    {
      name: "provider server failure with unknown commit status",
      configure: (provider) => {
        provider.redeemResult = clone(sanitizedProviderFixtures.server_error);
        provider.commitOnRedeem = true;
      },
      expectedKind: "pending",
      expectedState: "unknown",
      expectedReason: "provider_commit_unknown",
    },
  ];

  for (const testCase of cases) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate({ requestId: `rejection-${testCase.name}` });
    await seedFences(kv, reset);
    testCase.configure(provider);
    const deps = dependencies(kv, provider, clock);
    const first = await attemptCodexBankedReset(reset, deps);
    const repeat = await attemptCodexBankedReset(candidate({ requestId: `rejection-repeat-${testCase.name}` }), deps);

    assert.equal(first.kind, testCase.expectedKind, testCase.name);
    assert.equal(first.reason, testCase.expectedReason, testCase.name);
    assert.equal(first.record?.state, testCase.expectedState, testCase.name);
    assert.equal(provider.redeemInputs.length, testCase.name === "reset allowance exhausted" ? 0 : 1, testCase.name);
    assert.notEqual(repeat.kind, "verified", testCase.name);
    assert.equal(provider.redeemInputs.length, testCase.name === "reset allowance exhausted" ? 0 : 1, testCase.name);
  }
});

test("timeout and crash matrix never creates a second logical redemption", async () => {
  const timeoutCases: Readonly<{
    name: string;
    configure: (provider: FakeCodexUsageResetProvider) => void;
    expectedTimeoutStage: FakeProviderCall["timeoutStage"];
    expectedReason: string;
    expectedCommitCount: number;
  }>[] = [
    {
      name: "timeout before provider receives a commit",
      configure: (provider) => {
        provider.redeemFailure = new DOMException("timeout before provider commit", "TimeoutError");
      },
      expectedTimeoutStage: "before_provider_commit",
      expectedReason: "submit_transport_unknown",
      expectedCommitCount: 0,
    },
    {
      name: "provider commits and its response is lost",
      configure: (provider) => {
        provider.redeemFailureAfterCommit = new DOMException("response lost", "TimeoutError");
      },
      expectedTimeoutStage: "after_provider_commit",
      expectedReason: "submit_transport_unknown",
      expectedCommitCount: 1,
    },
    {
      name: "verification times out after a confirmed submission",
      configure: (provider) => {
        provider.verifyFailure = new DOMException("verification timeout", "TimeoutError");
      },
      expectedTimeoutStage: null,
      expectedReason: "verification_unavailable",
      expectedCommitCount: 1,
    },
  ];

  for (const testCase of timeoutCases) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate({ requestId: `timeout-${testCase.name}` });
    await seedFences(kv, reset);
    testCase.configure(provider);
    const deps = dependencies(kv, provider, clock);
    const first = await attemptCodexBankedReset(reset, deps);

    assert.equal(first.kind, "pending", testCase.name);
    assert.equal(first.reason, testCase.expectedReason, testCase.name);
    assert.equal(first.record?.state, "unknown", testCase.name);
    assert.equal(provider.commitCount, testCase.expectedCommitCount, testCase.name);
    assert.equal(provider.redeemInputs.length, 1, testCase.name);
    const stableKey = provider.redeemInputs[0]?.idempotencyKey;
    const submission = provider.calls.find((call) => call.method === "redeem");
    assert.equal(submission?.timeoutStage, testCase.expectedTimeoutStage, testCase.name);

    provider.redeemFailure = null;
    provider.redeemFailureAfterCommit = null;
    provider.verifyFailure = null;
    provider.lookupResult = clone(sanitizedProviderFixtures.lookup_completed);
    provider.verifyResult = true;
    clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
    const recovered = await reconcileCodexBankedReset(candidate({ requestId: `timeout-recovery-${testCase.name}` }), deps);

    assert.equal(recovered.kind, "verified", testCase.name);
    assert.equal(provider.redeemInputs.length, 1, testCase.name);
    assert.equal(provider.lookupInputs.at(-1)?.idempotencyKey, stableKey, testCase.name);
    assert.equal(provider.commitCount, testCase.expectedCommitCount, testCase.name);
  }

  // Pause after receipt persistence, as if the isolate died before it could
  // report verification. A later worker may reconcile, but never resubmit.
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate({ requestId: "receipt-persisted-then-crash" });
  await seedFences(kv, reset);
  const verifyGate = new Deferred<void>();
  const verifyEntered = new Deferred<void>();
  provider.verifyGate = verifyGate.promise;
  provider.verifyEntered = verifyEntered;
  const deps = dependencies(kv, provider, clock);
  const original = attemptCodexBankedReset(reset, deps);
  await verifyEntered.promise;
  const persisted = [...kv.entries.values()].map((entry) => entry.value).find((value) => isRecord(value) && value.state === "submitted");
  assert.equal((persisted as { provider_receipt_id?: unknown } | undefined)?.provider_receipt_id, "receipt-completed");
  assert.equal(provider.commitCount, 1);
  assert.equal(provider.redeemInputs.length, 1);
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  provider.lookupResult = clone(sanitizedProviderFixtures.lookup_completed);
  provider.verifyResult = false;
  const recovery = await reconcileCodexBankedReset(candidate({ requestId: "receipt-persisted-recovery" }), deps);
  assert.equal(recovery.kind, "pending");
  assert.equal(provider.redeemInputs.length, 1);
  provider.verifyResult = true;
  verifyGate.resolve(undefined);
  const stale = await original;
  assert.equal(stale.kind, "pending");
  assert.equal(stale.reason, "verification_cas_failed");
  assert.equal(provider.redeemInputs.length, 1);
});

test("client aborts before submission and after a possible commit fail closed without resubmission", async () => {
  const beforeKv = new MemoryKv();
  const beforeProvider = new FakeCodexUsageResetProvider();
  const beforeClock = new TestClock();
  const beforeReset = candidate({ requestId: "abort-before-submission" });
  await seedFences(beforeKv, beforeReset);
  const beforeController = new AbortController();
  beforeController.abort(new DOMException("client cancelled", "AbortError"));
  const before = await attemptCodexBankedReset(
    candidate({ ...beforeReset, signal: beforeController.signal }),
    dependencies(beforeKv, beforeProvider, beforeClock)
  );
  assert.equal(before.kind, "rejected");
  assert.equal(before.reason, "client_aborted_before_submission");
  assert.equal(beforeProvider.redeemInputs.length, 0);

  const afterKv = new MemoryKv();
  const afterProvider = new FakeCodexUsageResetProvider();
  const afterClock = new TestClock();
  const afterReset = candidate({ requestId: "abort-after-possible-commit" });
  await seedFences(afterKv, afterReset);
  const afterController = new AbortController();
  const entered = new Deferred<void>();
  const gate = new Deferred<void>();
  afterProvider.redeemEntered = entered;
  afterProvider.redeemGate = gate.promise;
  const afterDeps = dependencies(afterKv, afterProvider, afterClock);
  const original = attemptCodexBankedReset(candidate({ ...afterReset, signal: afterController.signal }), afterDeps);
  await entered.promise;
  afterController.abort(new DOMException("client cancelled after submit", "AbortError"));
  gate.resolve(undefined);
  const after = await original;
  assert.equal(after.kind, "pending");
  assert.equal(after.record?.state, "submitted");
  assert.equal(afterProvider.redeemInputs.length, 1);

  afterClock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  afterProvider.lookupResult = clone(sanitizedProviderFixtures.lookup_completed);
  const recovered = await reconcileCodexBankedReset(candidate({ requestId: "abort-after-recovery" }), afterDeps);
  assert.equal(recovered.kind, "verified");
  assert.equal(afterProvider.redeemInputs.length, 1);
});

test("a stalled blocked-cohort inventory is bounded before healthy routing resumes", async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeoutController = new AbortController();
  let observedSignal: AbortSignal | null = null;
  (
    AbortSignal as typeof AbortSignal & {
      timeout: (milliseconds: number) => AbortSignal;
    }
  ).timeout = (milliseconds: number) => {
    assert.equal(milliseconds, CODEX_BANKED_RESET_INVENTORY_TIMEOUT_MS);
    return timeoutController.signal;
  };
  const clock = new TestClock();
  const kv = new MemoryKv();
  const reset = candidate();
  await seedFences(kv, reset);
  const provider = new FakeCodexUsageResetProvider();
  const inventoryEntered = new Deferred<void>();
  provider.readInventory = (_input, signal) => {
    observedSignal = signal;
    inventoryEntered.resolve(undefined);
    return new Promise<ResetInventory>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          const abortReason: Error = signal.reason instanceof Error ? signal.reason : new DOMException("Inventory timed out", "TimeoutError");
          reject(abortReason);
        },
        { once: true }
      );
    });
  };

  try {
    const pending = evaluateCodexBankedResetPool(
      [{ slot: 0, candidate: reset, provider }],
      dependencies(kv, provider, clock, config({ mode: "shadow", maxPerAccountPerDay: 1 }))
    );
    await inventoryEntered.promise;
    assert.equal(observedSignal, timeoutController.signal);
    timeoutController.abort(new DOMException("Inventory timed out", "TimeoutError"));
    const result = await pending;
    assert.equal(result.kind, "skipped");
    assert.equal(result.reason, "inventory_unavailable");
    assert.equal(provider.redeemInputs.length, 0);
  } finally {
    (
      AbortSignal as typeof AbortSignal & {
        timeout: (milliseconds: number) => AbortSignal;
      }
    ).timeout = originalTimeout;
  }
});

test("full-pool shadow reads each account inventory, selects the earliest exact credit, and persists one redacted decision", async () => {
  const clock = new TestClock();
  const kv = new MemoryKv();
  const first = candidate({ accountId: "test-account-a", routingGeneration: 7 });
  const second = candidate({ accountId: "test-account-b", routingGeneration: 8 });
  await seedFences(kv, first);
  await seedFences(kv, second);
  const firstProvider = new FakeCodexUsageResetProvider();
  const secondProvider = new FakeCodexUsageResetProvider();
  firstProvider.inventory = inventory("credit-a-later", clock.nowMs + 40_000);
  secondProvider.inventory = inventory("credit-b-earlier", clock.nowMs + 20_000);
  const events: string[] = [];
  const shadow = config({
    mode: "shadow",
    maxPerAccountPerDay: 1,
  });

  const result = await evaluateCodexBankedResetPool(
    fullPool(first, firstProvider, second, secondProvider),
    dependencies(kv, firstProvider, clock, shadow, { event: (event) => events.push(event) })
  );
  assert.equal(result.kind, "shadow");
  assert.equal(result.reason, "shadow_selected");
  assert.equal(result.selected?.slot, 1);
  assert.equal(firstProvider.inventoryInputs.length, 1);
  assert.equal(secondProvider.inventoryInputs.length, 1);
  assert.equal(firstProvider.redeemInputs.length, 0);
  assert.equal(secondProvider.redeemInputs.length, 0);
  assert.ok(events.includes("codex_reset_shadow_candidate"));

  const decision = shadowDecisionFrom(kv);
  assert.equal(decision.decision_reason, "selected");
  assert.equal(decision.selected_account_id_hash, await testHash("test-account-b"));
  assert.notEqual(decision.selected_credit_id_hash, "credit-b-earlier");
  assert.equal(decision.selected_credit_expires_at_ms, clock.nowMs + 20_000);
  assert.equal(JSON.stringify(decision).includes("test-account-a"), false);
  assert.equal(JSON.stringify(decision).includes("credit-b-earlier"), false);
});

test("a new persistent-live episode auto-arms without spending, then consumes exactly once", async () => {
  const clock = new TestClock();
  const kv = new MemoryKv();
  const reset = candidate({ accountId: "test-account-a", routingGeneration: 7 });
  await seedFences(kv, reset);
  const provider = new FakeCodexUsageResetProvider();
  provider.inventory = inventory("expiring-credit", clock.nowMs + 20_000);
  const pool = [{ slot: 0, candidate: reset, provider }] as const;
  const events: string[] = [];
  const live = config({
    mode: "live",
    maxPerAccountPerDay: 1,
  });
  const deps = dependencies(kv, provider, clock, live, {
    event: (event) => events.push(event),
  });

  const armed = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(armed.kind, "shadow");
  assert.equal(armed.reason, "live_armed");
  assert.equal(armed.selected?.slot, 0);
  assert.equal(armed.reset, null);
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.ok(events.includes("codex_reset_eligible"));
  assert.ok(events.includes("codex_reset_shadow_candidate"));
  assert.equal(shadowDecisionFrom(kv).decision_reason, "selected");
  assert.equal(kv.entries.size, 3);

  const day = new Date(clock.nowMs).toISOString().slice(0, 10);
  assert.equal((await kv.get(codexResetAccountDailyKey(await testHash(reset.accountId), day))).value, null);

  const consumed = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(consumed.kind, "verified");
  assert.equal(consumed.selected?.slot, 0);
  assert.equal(provider.inventoryInputs.length, 2);
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.redeemInputs[0]?.creditId, "expiring-credit");
  assert.equal(provider.commitCount, 1);
  assert.equal((await kv.get<{ submission_count: number }>(codexResetAccountDailyKey(await testHash(reset.accountId), day))).value?.submission_count, 1);

  const repeated = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(repeated.kind, "verified");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
});

test("concurrent initial persistent-live evaluations only arm before a later single consume", async () => {
  const clock = new TestClock();
  const kv = new MemoryKv();
  const reset = candidate({ accountId: "test-account-a", routingGeneration: 7 });
  await seedFences(kv, reset);
  const provider = new FakeCodexUsageResetProvider();
  provider.inventory = inventory("expiring-credit", clock.nowMs + 20_000);
  const originalReadInventory = provider.readInventory.bind(provider);
  const bothInventoriesEntered = new Deferred<void>();
  const inventoryGate = new Deferred<void>();
  let inventoryEntrances = 0;
  provider.readInventory = async (input, signal) => {
    inventoryEntrances += 1;
    if (inventoryEntrances === 2) bothInventoriesEntered.resolve(undefined);
    await inventoryGate.promise;
    return await originalReadInventory(input, signal);
  };
  const pool = [{ slot: 0, candidate: reset, provider }] as const;
  const live = config({
    mode: "live",
    maxPerAccountPerDay: 1,
  });
  const deps = dependencies(kv, provider, clock, live);

  const first = evaluateCodexBankedResetPool(pool, deps);
  const second = evaluateCodexBankedResetPool(pool, deps);
  await bothInventoriesEntered.promise;
  assert.equal(provider.redeemInputs.length, 0);
  inventoryGate.resolve(undefined);
  const initial = await Promise.all([first, second]);

  assert.deepEqual(
    initial.map(({ kind }) => kind),
    ["shadow", "shadow"]
  );
  assert.deepEqual(
    initial.map(({ reason }) => reason),
    ["live_armed", "live_armed"]
  );
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(shadowDecisionFrom(kv).decision_reason, "selected");
  assert.equal(kv.entries.size, 3);
  const day = new Date(clock.nowMs).toISOString().slice(0, 10);
  assert.equal((await kv.get(codexResetAccountDailyKey(await testHash(reset.accountId), day))).value, null);

  const consumed = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(consumed.kind, "verified");
  assert.equal(provider.inventoryInputs.length, 3);
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.redeemInputs[0]?.creditId, "expiring-credit");
  assert.equal(provider.commitCount, 1);
  assert.equal((await kv.get<{ submission_count: number }>(codexResetAccountDailyKey(await testHash(reset.accountId), day))).value?.submission_count, 1);
});

test("invalid or ineligible live inventory cannot arm or consume", () =>
  runSequence(async (step) => {
    for (const scenario of [
      {
        name: "invalid",
        inventory: {
          availableCount: 2,
          observedAtMs: 1_700_000_000_000,
          credits: [
            {
              id: "incomplete-credit",
              status: "available",
              resetType: "codex_rate_limits",
              expiresAtMs: null,
            },
          ],
        },
        reason: "inventory_response_invalid_or_expired",
      },
      {
        name: "ineligible",
        inventory: {
          availableCount: 1,
          observedAtMs: 1_700_000_000_000,
          credits: [
            {
              id: "unsupported-credit",
              status: "available",
              resetType: "unsupported_reset",
              expiresAtMs: null,
            },
          ],
        },
        reason: "inventory_no_eligible_codex_credit",
      },
    ] satisfies readonly {
      name: string;
      inventory: ResetInventory;
      reason: string;
    }[]) {
      await step(scenario.name, async () => {
        const clock = new TestClock();
        const kv = new MemoryKv();
        const reset = candidate({ accountId: "test-account-a", routingGeneration: 7 });
        await seedFences(kv, reset);
        const provider = new FakeCodexUsageResetProvider();
        provider.inventory = scenario.inventory;
        const events: string[] = [];
        const live = config({
          mode: "live",
          maxPerAccountPerDay: 1,
        });

        const result = await evaluateCodexBankedResetPool(
          [{ slot: 0, candidate: reset, provider }],
          dependencies(kv, provider, clock, live, { event: (event) => events.push(event) })
        );

        assert.equal(result.kind, "skipped");
        assert.equal(result.reason, scenario.reason);
        assert.equal(provider.inventoryInputs.length, 1);
        assert.equal(provider.redeemInputs.length, 0);
        assert.equal(provider.commitCount, 0);
        assert.equal(events.includes("codex_reset_shadow_candidate"), false);
        assert.equal(kv.entries.size, 2);
      });
    }
  }));

test("sequential shadow duplicates skip inventory only after current strong fences pass", async () => {
  const clock = new TestClock();
  const kv = new MemoryKv();
  const first = candidate({ accountId: "test-account-a", routingGeneration: 7 });
  const second = candidate({ accountId: "test-account-b", routingGeneration: 8 });
  await seedFences(kv, first);
  await seedFences(kv, second);
  const firstProvider = new FakeCodexUsageResetProvider();
  const secondProvider = new FakeCodexUsageResetProvider();
  firstProvider.inventory = inventory("credit-a", clock.nowMs + 40_000);
  secondProvider.inventory = inventory("credit-b", clock.nowMs + 20_000);
  const shadow = config({
    mode: "shadow",
    maxPerAccountPerDay: 1,
  });
  const pool = fullPool(first, firstProvider, second, secondProvider);
  const deps = dependencies(kv, firstProvider, clock, shadow);

  const initial = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(initial.reason, "shadow_selected");
  assert.equal(firstProvider.inventoryInputs.length, 1);
  assert.equal(secondProvider.inventoryInputs.length, 1);

  const duplicate = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(duplicate.reason, "already_would_spend_once");
  assert.equal(firstProvider.inventoryInputs.length, 1);
  assert.equal(secondProvider.inventoryInputs.length, 1);

  await kv.set(routingFenceKey(second.accountId), {
    kind: "routing",
    routing_generation: second.routingGeneration + 1,
  });
  const stale = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(stale.kind, "skipped");
  assert.equal(stale.reason, "routing_fence_stale");
  assert.equal(firstProvider.inventoryInputs.length, 1);
  assert.equal(secondProvider.inventoryInputs.length, 1);
});

test("an unreadable settings record on the shadow duplicate path returns configuration_unavailable", async () => {
  const clock = new TestClock();
  const kv = new MemoryKv();
  const reset = candidate({ accountId: "test-account-a", routingGeneration: 7 });
  await seedFences(kv, reset);
  const provider = new FakeCodexUsageResetProvider();
  provider.inventory = inventory("credit-a", clock.nowMs + 40_000);
  const shadow = config({ mode: "shadow", maxPerAccountPerDay: 1 });
  const pool = [{ slot: 0, candidate: reset, provider }];
  const deps = dependencies(kv, provider, clock, shadow);

  const initial = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(initial.reason, "shadow_selected");
  assert.equal(provider.inventoryInputs.length, 1);

  // Fail only the duplicate path's settings read: the episode preparation read
  // that precedes it in the same evaluation still succeeds.
  const settingsKey = encodeKey(codexResetUsageKey(await testHash(reset.accountId)));
  let settingsReads = 0;
  kv.beforeGet = (key) => {
    if (encodeKey(key) !== settingsKey) return null;
    settingsReads += 1;
    if (settingsReads > 1) throw new Error("settings read failed");
    return null;
  };

  const duplicate = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(duplicate.kind, "skipped");
  assert.equal(duplicate.reason, "configuration_unavailable");
  assert.equal(duplicate.selected, null);
  assert.equal(duplicate.reset, null);
  assert.equal(settingsReads, 2);
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  // The persisted decision and its fences survive the failed read untouched.
  assert.equal(shadowDecisionFrom(kv).selected_account_id_hash, await testHash(reset.accountId));
});

test("a subscription disabled after its shadow decision stays fenced on the duplicate path", async () => {
  const clock = new TestClock();
  const kv = new MemoryKv();
  const reset = candidate({ accountId: "test-account-a", routingGeneration: 7 });
  await seedFences(kv, reset);
  const provider = new FakeCodexUsageResetProvider();
  provider.inventory = inventory("credit-a", clock.nowMs + 40_000);
  const shadow = config({ mode: "shadow", maxPerAccountPerDay: 1 });
  const pool = [{ slot: 0, candidate: reset, provider }];
  const deps = dependencies(kv, provider, clock, shadow);

  const initial = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(initial.reason, "shadow_selected");
  assert.equal(provider.inventoryInputs.length, 1);

  // Disable the subscription between this episode's own settings read and the
  // duplicate decision's fence read, so only the duplicate path observes it.
  const settingsKey = codexResetUsageKey(await testHash(reset.accountId));
  const encodedSettingsKey = encodeKey(settingsKey);
  let settingsReads = 0;
  kv.beforeGet = async (key) => {
    if (encodeKey(key) !== encodedSettingsKey) return;
    settingsReads += 1;
    if (settingsReads > 1) await kv.set(settingsKey, { enabled: false });
  };

  const duplicate = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(duplicate.kind, "skipped");
  assert.equal(duplicate.reason, "usage_disabled");
  assert.equal(duplicate.selected, null);
  assert.equal(duplicate.reset, null);
  assert.equal(settingsReads, 2);
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(shadowDecisionFrom(kv).selected_account_id_hash, await testHash(reset.accountId));
});

test("concurrent shadow observations deduplicate one episode, and live consumes only the matching audited account credit", async () => {
  const clock = new TestClock();
  const kv = new MemoryKv();
  const first = candidate({ accountId: "test-account-a", routingGeneration: 7 });
  const second = candidate({ accountId: "test-account-b", routingGeneration: 8 });
  await seedFences(kv, first);
  await seedFences(kv, second);
  const firstProvider = new FakeCodexUsageResetProvider();
  const secondProvider = new FakeCodexUsageResetProvider();
  firstProvider.inventory = inventory("credit-a", clock.nowMs + 40_000);
  secondProvider.inventory = inventory("credit-b", clock.nowMs + 20_000);
  const telemetry: string[] = [];
  const shadow = config({
    mode: "shadow",
    maxPerAccountPerDay: 1,
  });
  const pool = fullPool(first, firstProvider, second, secondProvider);
  const shadowDependencies = dependencies(kv, firstProvider, clock, shadow, {
    event: (event) => telemetry.push(event),
  });
  const [one, two] = await Promise.all([evaluateCodexBankedResetPool(pool, shadowDependencies), evaluateCodexBankedResetPool(pool, shadowDependencies)]);
  assert.deepEqual([one.kind, two.kind], ["shadow", "shadow"]);
  assert.equal([one.reason, two.reason].includes("already_would_spend_once"), true);
  assert.equal(telemetry.includes("codex_reset_duplicate_prevented"), true);
  assert.equal(firstProvider.redeemInputs.length + secondProvider.redeemInputs.length, 0);
  const decision = shadowDecisionFrom(kv);

  const live = config({
    mode: "live",
    maxPerAccountPerDay: 1,
  });
  const liveResult = await evaluateCodexBankedResetPool(pool, dependencies(kv, firstProvider, clock, live));
  assert.equal(liveResult.kind, "verified");
  assert.equal(liveResult.selected?.slot, 1);
  assert.equal(firstProvider.redeemInputs.length, 0);
  assert.equal(secondProvider.redeemInputs.length, 1);
  assert.equal(secondProvider.redeemInputs[0]?.creditId, "credit-b");
  assert.equal(secondProvider.commitCount, 1);
  assert.equal(shadowDecisionFrom(kv).episode_hash, decision.episode_hash);

  const repeat = await evaluateCodexBankedResetPool(pool, dependencies(kv, firstProvider, clock, live));
  assert.equal(repeat.kind, "verified");
  assert.equal(secondProvider.redeemInputs.length, 1);
});

test("one blocked candidate promotes from shadow to one concurrent live redemption and one daily-cap increment", async () => {
  const clock = new TestClock();
  const kv = new MemoryKv();
  const reset = candidate({ accountId: "test-account-a", routingGeneration: 7 });
  await seedFences(kv, reset);
  const provider = new FakeCodexUsageResetProvider();
  provider.inventory = inventory("expiring-credit", clock.nowMs + 20_000);
  const pool = [{ slot: 0, candidate: reset, provider }] as const;
  const shadow = config({
    mode: "shadow",
    maxPerAccountPerDay: 1,
  });

  const audited = await evaluateCodexBankedResetPool(pool, dependencies(kv, provider, clock, shadow));
  assert.equal(audited.kind, "shadow");
  assert.equal(audited.reason, "shadow_selected");
  assert.equal(audited.selected?.slot, 0);

  const live = config({
    mode: "live",
    maxPerAccountPerDay: 1,
  });
  const redeemEntered = new Deferred<void>();
  const redeemGate = new Deferred<void>();
  provider.redeemEntered = redeemEntered;
  provider.redeemGate = redeemGate.promise;
  const liveDependencies = dependencies(kv, provider, clock, live);
  const firstLive = evaluateCodexBankedResetPool(pool, liveDependencies);
  await redeemEntered.promise;
  const duplicateLive = await evaluateCodexBankedResetPool(pool, liveDependencies);
  assert.equal(duplicateLive.kind, "pending");
  assert.equal(duplicateLive.reason, "transaction_in_progress");
  assert.equal(provider.redeemInputs.length, 1);

  redeemGate.resolve(undefined);
  const completed = await firstLive;
  assert.equal(completed.kind, "verified");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
  const day = new Date(clock.nowMs).toISOString().slice(0, 10);
  assert.equal((await kv.get<{ submission_count: number }>(codexResetAccountDailyKey(await testHash(reset.accountId), day))).value?.submission_count, 1);
});

test("incomplete, duplicate, expired, and changed inventories never select or consume a shadow-audited credit", () =>
  runSequence(async (step) => {
    for (const scenario of ["incomplete", "duplicate", "expired", "changed"] as const) {
      await step(scenario, async () => {
        const clock = new TestClock();
        const kv = new MemoryKv();
        const first = candidate({ accountId: "test-account-a", routingGeneration: 7 });
        const second = candidate({ accountId: "test-account-b", routingGeneration: 8 });
        await seedFences(kv, first);
        await seedFences(kv, second);
        const firstProvider = new FakeCodexUsageResetProvider();
        const secondProvider = new FakeCodexUsageResetProvider();
        firstProvider.inventory = inventory("credit-a", clock.nowMs + 40_000);
        secondProvider.inventory = inventory("credit-b", clock.nowMs + 20_000);
        const shadow = config({
          mode: "shadow",
          maxPerAccountPerDay: 1,
        });
        const pool = fullPool(first, firstProvider, second, secondProvider);
        if (scenario === "incomplete" || scenario === "duplicate") {
          secondProvider.inventory = {
            availableCount: scenario === "incomplete" ? 2 : 1,
            observedAtMs: clock.nowMs,
            credits:
              scenario === "incomplete"
                ? [{ id: "credit-b", status: "available", resetType: "codex_rate_limits", expiresAtMs: null }]
                : [
                    { id: "credit-b", status: "available", resetType: "codex_rate_limits", expiresAtMs: null },
                    { id: "credit-b", status: "unavailable", resetType: "codex_rate_limits", expiresAtMs: null },
                  ],
          };
          const result = await evaluateCodexBankedResetPool(pool, dependencies(kv, firstProvider, clock, shadow));
          assert.equal(result.kind, "shadow");
          assert.equal(result.selected, null);
          assert.equal(shadowDecisionFrom(kv).decision_reason, "inventory_response_invalid_or_expired");
          const firstInventoryCount = firstProvider.inventoryInputs.length;
          const secondInventoryCount = secondProvider.inventoryInputs.length;
          const repeat = await evaluateCodexBankedResetPool(pool, dependencies(kv, firstProvider, clock, shadow));
          assert.equal(repeat.kind, "shadow");
          assert.equal(repeat.reason, "inventory_response_invalid_or_expired");
          assert.equal(repeat.selected, null);
          assert.equal(firstProvider.inventoryInputs.length, firstInventoryCount);
          assert.equal(secondProvider.inventoryInputs.length, secondInventoryCount);
        } else {
          const shadowResult = await evaluateCodexBankedResetPool(pool, dependencies(kv, firstProvider, clock, shadow));
          assert.equal(shadowResult.kind, "shadow");
          if (scenario === "expired") {
            secondProvider.inventory = inventory("credit-b", clock.nowMs - 1);
          } else {
            secondProvider.inventory = inventory("credit-b-changed", clock.nowMs + 20_000);
          }
          const live = config({
            mode: "live",
            maxPerAccountPerDay: 1,
          });
          const result = await evaluateCodexBankedResetPool(pool, dependencies(kv, firstProvider, clock, live));
          assert.equal(result.kind, "skipped");
          assert.match(result.reason, /shadow_decision_drift|inventory_response_invalid_or_expired/);
        }
        assert.equal(firstProvider.redeemInputs.length + secondProvider.redeemInputs.length, 0);
      });
    }
  }));
