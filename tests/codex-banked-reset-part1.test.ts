import { test } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
// codex-banked-reset suite part: tests moved out of tests/codex-banked-reset.test.ts.

import assert from "node:assert/strict";
import {
  CODEX_BANKED_RESET_LEASE_MS,
  type CodexBankedResetConfig,
  type CodexBankedResetTelemetryFields,
  type CodexResetRedemptionRecord,
  type CodexUsageResetProviderContract,
  Deferred,
  FakeCodexUsageResetProvider,
  MemoryKv,
  TestClock,
  attemptCodexBankedReset,
  candidate,
  codexResetAccountDailyKey,
  codexResetRedemptionKey,
  codexResetUsageKey,
  config,
  credentialFenceKey,
  dependencies,
  encodeKey,
  evaluateCodexBankedResetPool,
  hasKey,
  parseCodexResetShadowDecisionRecord,
  provenContract,
  reconcileCodexBankedReset,
  requiredHash,
  routingFenceKey,
  seedFences,
  testHash,
} from "./helpers/codex-banked-reset-harness.ts";

test("banked reset disabled, shadow, and invalid limits make zero provider calls", async () => {
  const clock = new TestClock();
  const cases: Readonly<{
    name: string;
    configured: CodexBankedResetConfig;
    reason: string;
    expectShadowEvent?: boolean;
  }>[] = [
    {
      name: "feature disabled",
      configured: config({ enabled: false }),
      reason: "feature_disabled",
    },
    {
      name: "shadow ignores the disabled day cap",
      configured: config({ mode: "shadow", maxPerAccountPerDay: 0 }),
      reason: "shadow",
      expectShadowEvent: true,
    },
    {
      name: "shadow",
      configured: config({ mode: "shadow", maxPerAccountPerDay: 0 }),
      reason: "shadow",
      expectShadowEvent: true,
    },
    {
      name: "account day cap disabled",
      configured: config({ maxPerAccountPerDay: 0 }),
      reason: "per_account_day_limit_invalid",
    },
    {
      name: "per-account cap invalid",
      configured: config({ maxPerAccountPerWindow: 2 }),
      reason: "per_account_window_limit_invalid",
    },
  ];

  for (const testCase of cases) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const events: string[] = [];
    const result = await attemptCodexBankedReset(candidate(), dependencies(kv, provider, clock, testCase.configured, { event: (event) => events.push(event) }));

    assert.equal(result.kind, "skipped", testCase.name);
    assert.equal(result.reason, testCase.reason, testCase.name);
    assert.equal(provider.callCount, 0, testCase.name);
    assert.equal(provider.commitCount, 0, testCase.name);
    assert.equal(events.includes("codex_reset_shadow_candidate"), testCase.expectShadowEvent ?? false, testCase.name);
  }
});

test("banked reset accepts any account ID or stable account hash", async () => {
  const clock = new TestClock();
  const reset = candidate();
  const accountIdHash = await testHash(reset.accountId);

  const allowedKv = new MemoryKv();
  const allowedProvider = new FakeCodexUsageResetProvider();
  await seedFences(allowedKv, reset);
  const allowed = await attemptCodexBankedReset(reset, dependencies(allowedKv, allowedProvider, clock, config({})));
  assert.equal(allowed.kind, "verified");
  assert.equal(allowed.accountIdHash, accountIdHash);
  assert.equal(allowedProvider.commitCount, 1);
});

test("banked reset live happy path commits exactly once with a stable durable identity", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const deps = dependencies(kv, provider, clock);
  const reset = candidate();
  await seedFences(kv, reset);
  const first = await attemptCodexBankedReset(reset, deps);

  assert.equal(first.kind, "verified");
  assert.equal(first.reason, "verified");
  assert.equal(provider.commitCount, 1);
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.verificationInputs.length, 1);
  assert.ok(first.accountIdHash);
  assert.ok(first.quotaGeneration);
  assert.ok(first.idempotencyKeyHash);
  assert.equal(first.record?.state, "verified");
  assert.equal(first.record.idempotency_key_hash, first.idempotencyKeyHash);
  assert.equal(provider.redeemInputs[0]?.accountId, "test-account-a");
  assert.match(provider.redeemInputs[0]?.idempotencyKey ?? "", /^uos_ai_codex_reset_v1_/);

  const redemptionKey = codexResetRedemptionKey(first.accountIdHash, first.quotaGeneration);
  const durable = await kv.get<CodexResetRedemptionRecord>(redemptionKey);
  assert.equal(durable.value?.state, "verified");
  assert.equal(durable.value.provider_receipt_id, "receipt-completed");
  assert.equal(durable.value.idempotency_key_hash, first.idempotencyKeyHash);

  const day = new Date(clock.nowMs).toISOString().slice(0, 10);
  const daily = await kv.get<{ submission_count: number }>(codexResetAccountDailyKey(requiredHash(first.accountIdHash), day));
  assert.equal(daily.value?.submission_count, 1);

  const duplicate = await attemptCodexBankedReset(candidate({ requestId: "same-window-later-request" }), deps);
  assert.equal(duplicate.kind, "verified");
  assert.equal(duplicate.reason, "previously_verified");
  assert.equal(duplicate.idempotencyKeyHash, first.idempotencyKeyHash);
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
});

test("a verified reset from an older routing generation is not reusable", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const firstCandidate = candidate();
  await seedFences(kv, firstCandidate);
  const first = await attemptCodexBankedReset(firstCandidate, dependencies(kv, provider, clock));
  assert.equal(first.kind, "verified");

  const laterCandidate = candidate({
    routingGeneration: firstCandidate.routingGeneration + 1,
  });
  await kv.set(routingFenceKey(laterCandidate.accountId), {
    kind: "routing",
    routing_generation: laterCandidate.routingGeneration,
  });
  const later = await attemptCodexBankedReset(laterCandidate, dependencies(kv, provider, clock));

  assert.equal(later.kind, "skipped");
  assert.equal(later.reason, "verified_routing_generation_stale");
  assert.ok(later.record);
  assert.equal(later.record.routing_generation, firstCandidate.routingGeneration);
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
});

test("banked reset production owner token generator is called with its Crypto receiver", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  // The injected owner-token generator is deliberately dropped so the
  // production generator runs.
  const deps = dependencies(kv, provider, clock);
  Reflect.deleteProperty(deps, "newOwnerToken");
  await seedFences(kv, reset);

  const result = await attemptCodexBankedReset(reset, deps);

  assert.equal(result.kind, "verified");
  assert.match(result.record?.owner_token ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(provider.commitCount, 1);
});

test("unknown provider outcome is recovered through lookup with the same key and no second redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  provider.redeemResult = { kind: "unknown", providerReceiptId: null };
  provider.commitOnRedeem = true;
  const deps = dependencies(kv, provider, clock);
  const reset = candidate();
  await seedFences(kv, reset);

  const first = await attemptCodexBankedReset(reset, deps);
  assert.equal(first.kind, "pending");
  assert.equal(first.reason, "provider_commit_unknown");
  assert.equal(first.record?.state, "unknown");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
  const stableKey = provider.redeemInputs[0]?.idempotencyKey;
  assert.ok(stableKey);

  provider.lookupResult = { kind: "already_redeemed", providerReceiptId: "receipt-recovered" };
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  const recovered = await attemptCodexBankedReset(candidate({ requestId: "recovery-request" }), deps);

  assert.equal(recovered.kind, "verified");
  assert.equal(recovered.reason, "verified");
  assert.equal(recovered.record?.state, "verified");
  assert.equal(recovered.record.fence, 3);
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
  assert.equal(provider.lookupInputs.length, 1);
  assert.equal(provider.lookupInputs[0]?.idempotencyKey, stableKey);
  assert.equal(provider.lookupInputs[0]?.providerReceiptId, null);
  assert.equal(recovered.idempotencyKeyHash, first.idempotencyKeyHash);
});

test("concurrent claims for one generation permit one provider submission and prevent the duplicate", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const gate = new Deferred<void>();
  const entered = new Deferred<void>();
  provider.redeemGate = gate.promise;
  provider.redeemEntered = entered;
  const deps = dependencies(kv, provider, clock);
  const reset = candidate();
  await seedFences(kv, reset);

  const firstPromise = attemptCodexBankedReset(reset, deps);
  await entered.promise;
  const duplicate = await attemptCodexBankedReset(candidate({ requestId: "concurrent-request" }), deps);

  assert.equal(duplicate.kind, "pending");
  assert.equal(duplicate.reason, "transaction_in_progress");
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 0);

  gate.resolve(undefined);
  const first = await firstPromise;
  assert.equal(first.kind, "verified");
  assert.equal(provider.commitCount, 1);
  assert.equal(provider.redeemInputs.length, 1);
});

test("an expired recovery lookup rejection stays unknown while the original redemption may be in flight", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  const redeemGate = new Deferred<void>();
  const redeemEntered = new Deferred<void>();
  provider.redeemGate = redeemGate.promise;
  provider.redeemEntered = redeemEntered;
  const deps = dependencies(kv, provider, clock);

  const original = attemptCodexBankedReset(reset, deps);
  await redeemEntered.promise;
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  provider.lookupResult = { kind: "rejected", reason: "not yet visible" };
  provider.verifyResult = false;
  const recovery = await reconcileCodexBankedReset(candidate({ requestId: "in-flight-negative-lookup" }), deps);

  assert.equal(recovery.kind, "pending");
  assert.equal(recovery.reason, "verification_not_applied");
  assert.equal(recovery.record?.state, "unknown");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.lookupInputs.length, 1);

  redeemGate.resolve(undefined);
  const originalOutcome = await original;
  assert.equal(originalOutcome.kind, "pending");
  assert.equal(originalOutcome.reason, "receipt_cas_failed");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(kv.redemptionRecord(codexResetRedemptionKey(requiredHash(recovery.accountIdHash), requiredHash(recovery.quotaGeneration)))?.state, "unknown");
});

test("live claims require seeded current fences and CAS-check both routing and credential records", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const deps = dependencies(kv, provider, clock);

  const missing = await attemptCodexBankedReset(candidate({ fences: [] }), deps);
  assert.equal(missing.kind, "skipped");
  assert.equal(missing.reason, "routing_fence_missing");
  assert.equal(provider.callCount, 0);

  const reset = candidate();
  const stale = await attemptCodexBankedReset(reset, deps);
  assert.equal(stale.kind, "skipped");
  assert.equal(stale.reason, "routing_fence_stale");
  assert.equal(provider.callCount, 0);

  await seedFences(kv, reset);
  const verified = await attemptCodexBankedReset(reset, deps);
  assert.equal(verified.kind, "verified");
  assert.equal(provider.commitCount, 1);
  assert.equal(
    kv.atomicCheckBatches.filter((batch) => hasKey(batch, routingFenceKey(reset.accountId)) && hasKey(batch, credentialFenceKey(reset.accountId))).length,
    3
  );
});

test("a malformed truthy verification result remains unknown and cannot authorize a reset", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  provider.verifyResult = { applied: true };

  const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
  assert.equal(result.kind, "pending");
  assert.equal(result.reason, "verification_response_invalid");
  assert.equal(result.record?.state, "unknown");
  assert.equal(result.record.last_error_code, "verification_response_invalid");
  assert.equal(provider.commitCount, 1);
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.verificationInputs.length, 1);
});

test("a reloadable kill switch changed during inventory leaves the claim durable and makes no redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  const inventoryGate = new Deferred<void>();
  const inventoryEntered = new Deferred<void>();
  provider.inventoryGate = inventoryGate.promise;
  provider.inventoryEntered = inventoryEntered;
  let currentConfig = config();
  const deps = dependencies(kv, provider, clock, currentConfig, {}, () => currentConfig);

  const pending = attemptCodexBankedReset(reset, deps);
  await inventoryEntered.promise;
  currentConfig = config({ enabled: false });
  inventoryGate.resolve(undefined);
  const result = await pending;

  assert.equal(result.kind, "pending");
  assert.equal(result.reason, "new_submission_feature_disabled");
  assert.equal(result.record?.state, "claimed");
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
});

test("inventory that returns after the quota deadline cannot cross the submission boundary", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate({ quotaResetAtMs: clock.nowMs + 1 });
  await seedFences(kv, reset);
  const inventoryGate = new Deferred<void>();
  const inventoryEntered = new Deferred<void>();
  provider.inventoryGate = inventoryGate.promise;
  provider.inventoryEntered = inventoryEntered;

  const pending = attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
  await inventoryEntered.promise;
  clock.advance(1);
  provider.inventory = { ...provider.inventory, observedAtMs: clock.nowMs };
  inventoryGate.resolve(undefined);
  const result = await pending;

  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "quota_window_expired");
  assert.equal(result.record?.state, "rejected");
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(
    kv.atomicCheckBatches.filter((batch) => hasKey(batch, routingFenceKey(reset.accountId)) && hasKey(batch, credentialFenceKey(reset.accountId))).length,
    1
  );
});

test("an already-expired quota window is never claimed or charged against the daily cap", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate({ quotaResetAtMs: clock.nowMs });
  await seedFences(kv, reset);

  const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));

  assert.equal(result.kind, "skipped");
  assert.equal(result.reason, "quota_window_expired");
  assert.equal(provider.callCount, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(kv.atomicCommitCount, 0);
  const day = new Date(clock.nowMs).toISOString().slice(0, 10);
  assert.equal((await kv.get(codexResetAccountDailyKey(await testHash(reset.accountId), day))).value, null);
});

test("a quota deadline crossing during submission preparation cannot reserve daily capacity", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate({ quotaResetAtMs: clock.nowMs + 1 });
  await seedFences(kv, reset);
  const day = new Date(clock.nowMs).toISOString().slice(0, 10);
  const dailyKey = codexResetAccountDailyKey(await testHash(reset.accountId), day);
  kv.beforeGet = (key) => {
    if (encodeKey(key) === encodeKey(dailyKey)) {
      kv.beforeGet = null;
      clock.advance(1);
    }
  };

  const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));

  assert.equal(result.kind, "pending");
  assert.equal(result.reason, "quota_window_expired");
  assert.equal(result.record?.state, "claimed");
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(kv.atomicCommitCount, 1);
  assert.equal((await kv.get(dailyKey)).value, null);
});

test("a quota deadline crossing during the final renewal cannot reach redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate({ quotaResetAtMs: clock.nowMs + 1 });
  await seedFences(kv, reset);

  // Claim and `claimed -> submitted` are commits one and two. Make the
  // window expire while the final submitted-owner/fence CAS commits: its
  // post-CAS timestamp was still valid, so the immediate pre-call guard is
  // the only safe place to stop this external spend.
  kv.beforeAtomicCommit = (commitNumber) => {
    if (commitNumber !== 3) return;
    kv.beforeAtomicCommit = null;
    clock.advance(1);
  };

  const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));

  assert.equal(result.kind, "pending");
  assert.equal(result.reason, "quota_window_expired");
  assert.equal(result.record?.state, "submitted");
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(kv.atomicCommitCount, 3);
});

test("a kill switch landing after the durable boundary still blocks provider redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  let currentConfig = config();
  const deps = dependencies(kv, provider, clock, currentConfig, {}, () => currentConfig);

  // The first atomic commit creates `claimed`; the second changes it to
  // `submitted`. Flip the operator configuration in that exact final window
  // before the fake provider could observe a redeem call.
  kv.beforeAtomicCommit = (commitNumber) => {
    if (commitNumber !== 2) return;
    kv.beforeAtomicCommit = null;
    currentConfig = config({ enabled: false, mode: "disabled" });
  };

  const result = await attemptCodexBankedReset(reset, deps);
  assert.equal(result.kind, "pending");
  assert.equal(result.reason, "new_submission_feature_disabled");
  assert.equal(result.record?.state, "submitted");
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
});

test("a kill switch landing during the final renewal still blocks provider redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  let currentConfig = config();
  const deps = dependencies(kv, provider, clock, currentConfig, {}, () => currentConfig);

  // Claim is commit 1 and `claimed -> submitted` is commit 2. Flip the
  // operator configuration immediately before the final submitted-lease
  // renewal commits. The post-renewal synchronous read must win before the
  // provider can observe a redeem call.
  kv.beforeAtomicCommit = (commitNumber) => {
    if (commitNumber !== 3) return;
    kv.beforeAtomicCommit = null;
    currentConfig = config({ enabled: false, mode: "disabled" });
  };

  const result = await attemptCodexBankedReset(reset, deps);
  assert.equal(result.kind, "pending");
  assert.equal(result.reason, "new_submission_feature_disabled");
  assert.equal(result.record?.state, "submitted");
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
});

test("the persistent usage toggle blocks resets and re-enabling preserves normal redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  for (const disabled of [false, "true"]) {
    await kv.set(codexResetUsageKey(await testHash(reset.accountId)), {
      id: "key-a",
      revoked_at_ms: null,
      expires_at_ms: -1,
      enabled: disabled,
    });
    const result = await attemptCodexBankedReset(reset, { ...dependencies(kv, provider, clock) });
    assert.equal(result.kind, "skipped");
    assert.equal(provider.inventoryInputs.length, 0);
    assert.equal(provider.redeemInputs.length, 0);
  }
  await kv.set(codexResetUsageKey(await testHash(reset.accountId)), {
    id: "key-a",
    revoked_at_ms: null,
    expires_at_ms: -1,
    enabled: true,
  });
  const result = await attemptCodexBankedReset(reset, { ...dependencies(kv, provider, clock) });
  assert.equal(result.kind, "verified");
  assert.equal(provider.redeemInputs.length, 1);
});

test("a saved disable races with either submission transaction without spending a credit", async () => {
  for (const boundary of [2, 3]) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate();
    await seedFences(kv, reset);
    await kv.set(codexResetUsageKey(await testHash(reset.accountId)), {
      id: "key-a",
      revoked_at_ms: null,
      expires_at_ms: -1,
      enabled: true,
    });
    const settingsKey = codexResetUsageKey(await testHash(reset.accountId));
    kv.beforeAtomicCommit = (commitNumber) => {
      if (commitNumber !== boundary) return;
      kv.beforeAtomicCommit = null;
      void kv.set(settingsKey, {
        id: "key-a",
        revoked_at_ms: null,
        expires_at_ms: -1,
        enabled: false,
      });
    };
    const result = await attemptCodexBankedReset(reset, { ...dependencies(kv, provider, clock) });
    assert.equal(result.reason, "usage_disabled");
    assert.equal(provider.redeemInputs.length, 0);
    assert.equal(provider.commitCount, 0);
  }
});

test("a disabled subscription does not block another subscription", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const otherProvider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  const other = candidate({ accountId: "other-account" });
  await seedFences(kv, reset);
  await seedFences(kv, other);
  await kv.set(codexResetUsageKey(await testHash(reset.accountId)), { enabled: false });
  const pool = [
    { slot: 0, candidate: reset, provider },
    { slot: 1, candidate: other, provider: otherProvider },
  ];
  const deps = dependencies(kv, provider, clock, config({ mode: "shadow", maxPerAccountPerDay: 1 }));
  const allowed = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(allowed.reason, "shadow_selected");
  assert.equal(provider.inventoryInputs.length, 0);
  assert.equal(otherProvider.inventoryInputs.length, 1);
  assert.equal(otherProvider.redeemInputs.length, 0);
  await kv.set(codexResetUsageKey(await testHash(other.accountId)), { enabled: false });
  const blocked = await evaluateCodexBankedResetPool(pool, deps);
  assert.equal(blocked.reason, "usage_disabled");
});

test("disabling a subscription during inventory prevents a late shadow or live-arm decision", async () => {
  for (const mode of ["shadow", "live"] as const) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    const reset = candidate();
    await seedFences(kv, reset);
    const key = { id: "key-a", revoked_at_ms: null, expires_at_ms: -1, enabled: true };
    await kv.set(codexResetUsageKey(await testHash(reset.accountId)), key);
    const gate = new Deferred<void>();
    const entered = new Deferred<void>();
    provider.inventoryGate = gate.promise;
    provider.inventoryEntered = entered;
    const pending = evaluateCodexBankedResetPool([{ slot: 0, candidate: reset, provider }], {
      ...dependencies(kv, provider, clock, config({ mode, maxPerAccountPerDay: 1 })),
    });
    await entered.promise;
    await kv.set(codexResetUsageKey(await testHash(reset.accountId)), { ...key, enabled: false });
    gate.resolve(undefined);
    const result = await pending;
    assert.equal(result.kind, "skipped");
    assert.equal(
      [...kv.entries.values()].some((entry) => parseCodexResetShadowDecisionRecord(entry.value)),
      false
    );
    assert.equal(provider.redeemInputs.length, 0);
  }
});

test("an unapproved provider receipt stays out of the durable record and telemetry", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider({
    ...provenContract(),
    receiptIdsSafeToPersistAndLog: false,
  });
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  const submittedFields: CodexBankedResetTelemetryFields[] = [];
  const result = await attemptCodexBankedReset(
    reset,
    dependencies(kv, provider, clock, config(), {
      event: (event, fields) => {
        if (event === "codex_reset_submitted") submittedFields.push(fields);
      },
    })
  );

  assert.equal(result.kind, "verified");
  assert.equal(result.record?.provider_receipt_id, null);
  assert.equal(
    kv.redemptionRecord(codexResetRedemptionKey(requiredHash(result.accountIdHash), requiredHash(result.quotaGeneration)))?.provider_receipt_id,
    null
  );
  assert.deepEqual(
    submittedFields.map((fields) => fields.provider_receipt_id),
    [null]
  );
});

test("documented terminal outcomes enable one-shot redemption and retain the exact safe result", () =>
  runSequence(async (step) => {
    for (const testCase of [
      { providerKind: "completed", telemetryKind: "reset" },
      { providerKind: "already_redeemed", telemetryKind: "already_redeemed" },
    ] as const) {
      await step(testCase.telemetryKind, async () => {
        const kv = new MemoryKv();
        const provider = new FakeCodexUsageResetProvider({
          ...provenContract(),
          idempotency: { callerSupplied: true, retentionMs: null },
          lookup: { byIdempotencyKey: false, byProviderReceiptId: false },
          verification: { independentlyVerifiable: false },
          redeemOutcomeIsFinal: true,
          receiptIdsSafeToPersistAndLog: false,
        });
        const clock = new TestClock();
        const reset = candidate({ requestId: `terminal-${testCase.telemetryKind}` });
        await seedFences(kv, reset);
        provider.redeemResult = {
          kind: testCase.providerKind,
          providerReceiptId: "must-not-persist",
        };
        provider.verifyResult = false;
        const verified: CodexBankedResetTelemetryFields[] = [];

        const result = await attemptCodexBankedReset(
          reset,
          dependencies(kv, provider, clock, config({ maxPerAccountPerDay: 1 }), {
            event: (event, fields) => {
              if (event === "codex_reset_verified") verified.push(fields);
            },
          })
        );

        assert.equal(result.kind, "verified");
        assert.equal(result.reason, `redeem_outcome_${testCase.telemetryKind}`);
        assert.equal(result.record?.state, "verified");
        assert.equal(result.record.provider_receipt_id, null);
        assert.deepEqual(
          verified.map((fields) => fields.redeem_outcome),
          [testCase.telemetryKind]
        );
        assert.equal(provider.redeemInputs.length, 1);
        assert.equal(provider.verificationInputs.length, 0);
        assert.equal(provider.lookupInputs.length, 0);
      });
    }
  }));

test("a terminal-only provider requires an exact per-account daily cap of one", async () => {
  for (const maxPerAccountPerDay of [0, 2]) {
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider({
      ...provenContract(),
      idempotency: { callerSupplied: true, retentionMs: null },
      lookup: { byIdempotencyKey: false, byProviderReceiptId: false },
      verification: { independentlyVerifiable: false },
      redeemOutcomeIsFinal: true,
      receiptIdsSafeToPersistAndLog: false,
    });
    const reset = candidate({ requestId: `terminal-cap-${maxPerAccountPerDay}` });
    await seedFences(kv, reset);

    const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, new TestClock(), config({ maxPerAccountPerDay })));

    assert.equal(result.kind, "skipped");
    assert.equal(result.reason, maxPerAccountPerDay === 0 ? "per_account_day_limit_invalid" : "terminal_outcome_account_day_limit_must_be_one");
    assert.equal(provider.callCount, 0);
  }
});

test("an ambiguous one-shot outcome stays unknown and never submits again", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider({
    ...provenContract(),
    idempotency: { callerSupplied: true, retentionMs: null },
    lookup: { byIdempotencyKey: false, byProviderReceiptId: false },
    verification: { independentlyVerifiable: false },
    redeemOutcomeIsFinal: true,
    receiptIdsSafeToPersistAndLog: false,
  });
  const clock = new TestClock();
  const reset = candidate({ requestId: "one-shot-ambiguous" });
  await seedFences(kv, reset);
  provider.redeemResult = { kind: "unknown", providerReceiptId: null };
  provider.lookupResult = { kind: "unknown", providerReceiptId: null };
  provider.verifyResult = false;

  const oneShotConfig = config({ maxPerAccountPerDay: 1 });
  const first = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock, oneShotConfig));
  assert.equal(first.kind, "pending");
  assert.equal(first.reason, "provider_commit_unknown");
  assert.equal(first.record?.state, "unknown");
  assert.equal(provider.redeemInputs.length, 1);

  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  const reconciled = await reconcileCodexBankedReset(
    candidate({ ...reset, requestId: "one-shot-ambiguous-reconcile" }),
    dependencies(kv, provider, clock, oneShotConfig)
  );
  assert.equal(reconciled.kind, "pending");
  assert.equal(reconciled.reason, "terminal_outcome_ambiguous");
  assert.equal(reconciled.record?.state, "unknown");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.lookupInputs.length, 0);
  assert.equal(provider.verificationInputs.length, 0);
});

test("a malformed terminal reconciliation capability fails closed without provider calls", async () => {
  let lookupReads = 0;
  const terminalContract = {
    idempotency: { callerSupplied: true, retentionMs: null },
    verification: { independentlyVerifiable: false },
    redeemOutcomeIsFinal: true,
    receiptIdsSafeToPersistAndLog: false,
    supportedResetTypes: ["codex_rate_limits"],
  } as unknown as CodexUsageResetProviderContract;
  Object.defineProperty(terminalContract, "lookup", {
    enumerable: true,
    get: () => {
      lookupReads += 1;
      if (lookupReads === 2) throw new Error("malformed lookup capability");
      return { byIdempotencyKey: false, byProviderReceiptId: false };
    },
  });

  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider(terminalContract);
  const clock = new TestClock();
  const reset = candidate({ requestId: "malformed-terminal-reconciliation" });
  const oneShotConfig = config({ maxPerAccountPerDay: 1 });
  await seedFences(kv, reset);
  provider.redeemResult = { kind: "unknown", providerReceiptId: null };

  const first = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock, oneShotConfig));
  assert.equal(first.reason, "provider_commit_unknown");
  assert.equal(provider.redeemInputs.length, 1);

  lookupReads = 0;
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  const reconciled = await reconcileCodexBankedReset(
    candidate({ ...reset, requestId: "malformed-terminal-reconciliation-retry" }),
    dependencies(kv, provider, clock, oneShotConfig)
  );
  assert.equal(reconciled.kind, "pending");
  assert.equal(reconciled.reason, "provider_contract_unproven");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.lookupInputs.length, 0);
  assert.equal(provider.verificationInputs.length, 0);
});

test("banked-reset telemetry retains only safe correlation fields", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider({
    ...provenContract(),
    receiptIdsSafeToPersistAndLog: false,
  });
  const clock = new TestClock();
  const reset = candidate({
    accountId: "raw-account-id-must-not-leak",
    credentialVersion: "raw-credential-version-must-not-leak",
    requestId: "safe-request-id",
  });
  await seedFences(kv, reset);
  provider.redeemResult = { kind: "completed", providerReceiptId: "unapproved-provider-receipt" };
  const events: Readonly<{ event: string; fields: CodexBankedResetTelemetryFields }>[] = [];
  const metrics: CodexBankedResetTelemetryFields[] = [];

  const result = await attemptCodexBankedReset(
    reset,
    dependencies(kv, provider, clock, config({}), {
      event: (event, fields) => events.push({ event, fields }),
      metric: (_metric, _value, fields) => metrics.push(fields),
    })
  );

  assert.equal(result.kind, "verified");
  assert.ok(provider.redeemInputs[0]?.idempotencyKey);
  assert.ok(events.some(({ event }) => event === "codex_reset_eligible"));
  assert.ok(events.some(({ event }) => event === "codex_reset_claimed"));
  assert.ok(events.some(({ event }) => event === "codex_reset_submitted"));
  assert.ok(events.some(({ event }) => event === "codex_reset_verified"));
  assert.ok(events.every(({ fields }) => typeof fields.account_id_hash === "string"));

  const firstRedeemInput = provider.redeemInputs.at(0);
  assert.ok(firstRedeemInput, "expected one provider redemption");
  const rawValues = [reset.accountId, reset.credentialVersion, firstRedeemInput.idempotencyKey, "unapproved-provider-receipt"];
  for (const fields of [...events.map(({ fields }) => fields), ...metrics]) {
    const serialized = JSON.stringify(fields);
    for (const raw of rawValues) assert.equal(serialized.includes(raw), false, `telemetry leaked ${raw}`);
  }
});

test("a lease-expired replacement takes over while the stale owner is blocked before redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  const inventoryGate = new Deferred<void>();
  const inventoryEntered = new Deferred<void>();
  provider.inventoryGate = inventoryGate.promise;
  provider.inventoryEntered = inventoryEntered;
  const deps = dependencies(kv, provider, clock);

  const staleOwner = attemptCodexBankedReset(reset, deps);
  await inventoryEntered.promise;
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  provider.inventory = { ...provider.inventory, observedAtMs: clock.nowMs };
  const replacement = await attemptCodexBankedReset(candidate({ requestId: "lease-takeover" }), deps);
  assert.equal(replacement.kind, "verified");
  assert.equal(replacement.record?.fence, 3);
  assert.equal(provider.redeemInputs.length, 1);

  inventoryGate.resolve(undefined);
  const staleOutcome = await staleOwner;
  assert.equal(staleOutcome.kind, "pending");
  assert.equal(staleOutcome.reason, "stale_owner");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.commitCount, 1);
});

test("an expired claimed record cannot be taken over after its quota deadline", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate({ quotaResetAtMs: clock.nowMs + 1 });
  await seedFences(kv, reset);
  const inventoryGate = new Deferred<void>();
  const inventoryEntered = new Deferred<void>();
  provider.inventoryGate = inventoryGate.promise;
  provider.inventoryEntered = inventoryEntered;
  const deps = dependencies(kv, provider, clock);

  const original = attemptCodexBankedReset(reset, deps);
  await inventoryEntered.promise;
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);

  const takeover = await attemptCodexBankedReset(candidate({ ...reset, requestId: "expired-claim-takeover" }), deps);
  assert.equal(takeover.kind, "skipped");
  assert.equal(takeover.reason, "quota_window_expired");
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  const day = new Date(clock.nowMs).toISOString().slice(0, 10);
  assert.equal((await kv.get(codexResetAccountDailyKey(await testHash(reset.accountId), day))).value, null);

  inventoryGate.resolve(undefined);
  const originalResult = await original;
  assert.equal(originalResult.kind, "rejected");
  assert.equal(originalResult.reason, "quota_window_expired");
  assert.equal(provider.redeemInputs.length, 0);
});

test("a quota deadline crossing during claimed-takeover fence reads leaves the claim untouched", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate({ quotaResetAtMs: clock.nowMs + CODEX_BANKED_RESET_LEASE_MS + 2 });
  await seedFences(kv, reset);
  const inventoryGate = new Deferred<void>();
  const inventoryEntered = new Deferred<void>();
  provider.inventoryGate = inventoryGate.promise;
  provider.inventoryEntered = inventoryEntered;
  const deps = dependencies(kv, provider, clock);

  const original = attemptCodexBankedReset(reset, deps);
  await inventoryEntered.promise;
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  kv.beforeGet = (key) => {
    if (encodeKey(key) === encodeKey(credentialFenceKey(reset.accountId))) {
      kv.beforeGet = null;
      clock.advance(1);
    }
  };

  const takeover = await attemptCodexBankedReset(candidate({ ...reset, requestId: "claim-takeover-deadline" }), deps);
  assert.equal(takeover.kind, "skipped");
  assert.equal(takeover.reason, "quota_window_expired");
  assert.equal(kv.atomicCommitCount, 1);
  assert.equal(provider.inventoryInputs.length, 1);
  assert.equal(provider.redeemInputs.length, 0);

  inventoryGate.resolve(undefined);
  const originalResult = await original;
  assert.equal(originalResult.kind, "rejected");
  assert.equal(originalResult.reason, "quota_window_expired");
  assert.equal(provider.redeemInputs.length, 0);
});

test("a post-submission lease takeover fences the paused owner before provider redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  const renewalGate = new Deferred<void>();
  const renewalEntered = new Deferred<void>();
  kv.beforeGet = () => {
    // Claim and `claimed -> submitted` are the first two commits. The next
    // redemption-record read is the final owner/fence/lease renewal.
    if (kv.atomicCommitCount !== 2) return null;
    kv.beforeGet = null;
    renewalEntered.resolve(undefined);
    return renewalGate.promise;
  };
  const deps = dependencies(kv, provider, clock);

  const pausedOwner = attemptCodexBankedReset(reset, deps);
  await renewalEntered.promise;
  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  provider.lookupResult = { kind: "unknown", providerReceiptId: null };
  provider.verifyResult = false;
  const takeover = await reconcileCodexBankedReset(candidate({ requestId: "post-submission-takeover" }), deps);

  assert.equal(takeover.kind, "pending");
  assert.equal(takeover.reason, "verification_not_applied");
  assert.equal(takeover.record?.state, "unknown");
  assert.equal(takeover.record.fence, 2);
  assert.equal(provider.redeemInputs.length, 0);

  renewalGate.resolve(undefined);
  const staleOutcome = await pausedOwner;
  assert.equal(staleOutcome.kind, "pending");
  assert.equal(staleOutcome.reason, "stale_owner");
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
});

test("a routing-fence change between the strong read and durable submission CAS prevents redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  kv.beforeAtomicCommit = (commitNumber) => {
    if (commitNumber !== 2) return;
    kv.beforeAtomicCommit = null;
    void kv.set(routingFenceKey(reset.accountId), {
      kind: "routing",
      routing_generation: reset.routingGeneration + 1,
    });
  };

  const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
  assert.equal(result.kind, "pending");
  assert.equal(result.reason, "routing_fence_stale");
  assert.equal(result.record?.state, "claimed");
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(kv.atomicCommitCount, 2);
  assert.equal(hasKey(kv.atomicCheckBatches[1] ?? [], routingFenceKey(reset.accountId)), true);
});

test("a routing-fence change after submission is caught by the final renewal CAS", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  kv.beforeAtomicCommit = (commitNumber) => {
    if (commitNumber !== 3) return;
    kv.beforeAtomicCommit = null;
    void kv.set(routingFenceKey(reset.accountId), {
      kind: "routing",
      routing_generation: reset.routingGeneration + 1,
    });
  };

  const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
  assert.equal(result.kind, "pending");
  assert.equal(result.reason, "routing_fence_stale");
  assert.equal(result.record?.state, "submitted");
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(hasKey(kv.atomicCheckBatches[2] ?? [], routingFenceKey(reset.accountId)), true);
  assert.equal(hasKey(kv.atomicCheckBatches[2] ?? [], credentialFenceKey(reset.accountId)), true);
});

test("an auth fence change after submission is caught by the final renewal CAS", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  kv.beforeAtomicCommit = (commitNumber) => {
    if (commitNumber !== 3) return;
    kv.beforeAtomicCommit = null;
    void kv.set(credentialFenceKey(reset.accountId), {
      kind: "credential",
      credential_version: "test-credential-v2-rotated",
    });
  };

  const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
  assert.equal(result.kind, "pending");
  assert.equal(result.reason, "routing_fence_stale");
  assert.equal(result.record?.state, "submitted");
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(hasKey(kv.atomicCheckBatches[2] ?? [], routingFenceKey(reset.accountId)), true);
  assert.equal(hasKey(kv.atomicCheckBatches[2] ?? [], credentialFenceKey(reset.accountId)), true);
});

test("a credential-rotation-style fence change before durable submission prevents redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  kv.beforeAtomicCommit = (commitNumber) => {
    if (commitNumber !== 2) return;
    kv.beforeAtomicCommit = null;
    void kv.set(credentialFenceKey(reset.accountId), {
      kind: "credential",
      credential_version: "test-credential-v2-rotated",
    });
  };

  const result = await attemptCodexBankedReset(reset, dependencies(kv, provider, clock));
  assert.equal(result.kind, "pending");
  assert.equal(result.reason, "routing_fence_stale");
  assert.equal(result.record?.state, "claimed");
  assert.equal(provider.redeemInputs.length, 0);
  assert.equal(provider.commitCount, 0);
  assert.equal(hasKey(kv.atomicCheckBatches[1] ?? [], credentialFenceKey(reset.accountId)), true);
});

test("a durable unknown reset is reconciled while live configuration is disabled without a second redemption", async () => {
  const kv = new MemoryKv();
  const provider = new FakeCodexUsageResetProvider();
  const clock = new TestClock();
  const reset = candidate();
  await seedFences(kv, reset);
  provider.redeemResult = { kind: "unknown", providerReceiptId: null };
  provider.commitOnRedeem = true;
  const liveDeps = dependencies(kv, provider, clock);

  const first = await attemptCodexBankedReset(reset, liveDeps);
  assert.equal(first.kind, "pending");
  assert.equal(first.record?.state, "unknown");
  assert.equal(provider.redeemInputs.length, 1);

  clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
  provider.lookupResult = { kind: "completed", providerReceiptId: "receipt-recovered-while-disabled" };
  const disabledConfig = config({ enabled: false });
  const recovered = await reconcileCodexBankedReset(
    candidate({ requestId: "disabled-recovery" }),
    dependencies(kv, provider, clock, disabledConfig, {}, () => disabledConfig)
  );

  assert.equal(recovered.kind, "verified");
  assert.equal(recovered.record?.state, "verified");
  assert.equal(provider.redeemInputs.length, 1);
  assert.equal(provider.lookupInputs.length, 1);
  assert.equal(provider.commitCount, 1);
});

test("seeded state-machine invariant: one account/window never reaches more than one fake provider commit", async () => {
  let seed = 0x5eed_c0de;
  const next = (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };

  for (let index = 0; index < 24; index += 1) {
    const caseSeed = next();
    const accountId = `property-account-${index}`;
    const reset = candidate({
      accountId,
      credentialVersion: `property-credential-${caseSeed}`,
      quotaResetAtMs: 1_700_000_060_000 + index,
      routingGeneration: caseSeed % 1_000,
      requestId: `property-${caseSeed}`,
    });
    const kv = new MemoryKv();
    const provider = new FakeCodexUsageResetProvider();
    const clock = new TestClock();
    await seedFences(kv, reset);
    const deps = dependencies(kv, provider, clock, config({}));
    const scenario = caseSeed % 3;

    if (scenario === 1) {
      provider.redeemResult = { kind: "unknown", providerReceiptId: null };
      provider.commitOnRedeem = true;
      const first = await attemptCodexBankedReset(reset, deps);
      assert.equal(first.kind, "pending", `seed ${caseSeed}`);
      clock.advance(CODEX_BANKED_RESET_LEASE_MS + 1);
      provider.lookupResult = { kind: "completed", providerReceiptId: `receipt-${caseSeed}` };
      await reconcileCodexBankedReset(candidate({ ...reset, requestId: `recovery-${caseSeed}` }), deps);
    } else if (scenario === 2) {
      provider.redeemResult = { kind: "rejected", reason: `rejected-${caseSeed}` };
      await attemptCodexBankedReset(reset, deps);
      await attemptCodexBankedReset(candidate({ ...reset, requestId: `duplicate-${caseSeed}` }), deps);
    } else {
      await attemptCodexBankedReset(reset, deps);
      await attemptCodexBankedReset(candidate({ ...reset, requestId: `duplicate-${caseSeed}` }), deps);
    }

    const idempotencyKeys = new Set(provider.redeemInputs.map((input) => input.idempotencyKey));
    assert.ok(provider.commitCount <= 1, `seed ${caseSeed} committed more than once`);
    assert.ok(provider.redeemInputs.length <= 1, `seed ${caseSeed} submitted more than once`);
    assert.ok(idempotencyKeys.size <= 1, `seed ${caseSeed} generated multiple idempotency keys`);
  }
});

/** Mutable state carried across one generated event sequence. */

/** Applies one generated event to the scenario. */

/** Asserts the durable invariants that must hold after every generated event. */
