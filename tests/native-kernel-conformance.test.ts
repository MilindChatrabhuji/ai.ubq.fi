import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AtomicOperation, Kv, KvKey } from "#kv";
import * as kernelV2 from "../src/authority/native-kernel.ts";
import type { KernelQuotaConstants, KernelQuotaIdentity, KernelQuotaRead, KernelQuotaPolicyV2 } from "../src/authority/native-kernel-contracts.ts";
import { API_KEY_NO_EXPIRATION_MS, API_KEY_NO_USAGE_LIMIT } from "../src/api-keys.ts";
import { DEFAULT_KERNEL_POLICY_LIMIT_KEY, DEFAULT_KERNEL_POLICY_WINDOW_KEY } from "../src/defaults.ts";
import { reserveEffectiveKernelUsageLimit, reserveKernelOrgUsageLimit } from "../src/kernel/quota-reserve.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

// BEGIN SHARED_KERNEL_VECTORS
/** Run this exact function against the source reducer in both pinned Bun and actual workerd. */
export const runKernelConformanceVectors = (constants: KernelQuotaConstants) => {
  const now = 10_000_000;
  const identity: KernelQuotaIdentity = { scope: "repo", owner: "synthetic", repo: "repo" };
  const row = (value: unknown, revision: string | null = "opaque.rev:0x1"): KernelQuotaRead => ({ value, revision, expiresAtMs: null });
  const empty = row(null, null);
  const defaults = { limit: 1, windowMs: 60_000 };
  const policy: KernelQuotaPolicyV2 = {
    v: 2,
    scope: "repo",
    owner: "synthetic",
    repo: "repo",
    usage_limit_requests: 1,
    window_ms: 60_000,
    expires_at_ms: constants.noExpirationMs,
    created_at_ms: 0,
    updated_at_ms: now,
  };
  const orgPolicy = { ...policy, scope: "org", repo: undefined };
  const effective = kernelV2.policyFor(row(policy), "repo", "synthetic", "repo", defaults, constants);
  const window = kernelV2.newWindow("repo", "synthetic", "repo", 60_000, now);
  const reserved = kernelV2.decideKernelQuotaReserve(identity, effective, window, empty, "request", "responses", constants.noUsageLimit, now);
  if (reserved.kind !== "reserve") throw new Error("Synthetic kernel reservation was not admitted");
  const request = { ...identity, windowCreatedAtMs: now, requestId: "request", route: "responses" };
  const before = JSON.stringify({ policy, window, reservation: reserved.reservation });
  const pending = kernelV2.decideKernelQuotaTerminalIntent(request, row(reserved.reservation), "committed", now + 1);
  if (pending.kind !== "intent") throw new Error("Synthetic kernel terminal intent was not persisted");
  const settled = kernelV2.decideKernelQuotaSettlement(
    pending.reservation,
    { window: reserved.window, windowPresent: true },
    "committed",
    "completed",
    now + 2
  );
  if (settled.kind !== "settle") throw new Error("Synthetic kernel settlement was not writable");
  const failure = (operation: () => unknown): string | null => {
    try {
      operation();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const eligibility = (value: unknown, extra = {}) =>
    kernelV2.decideKernelQuotaEligibility(identity, { policy: row(value), repoGuard: null, defaultCutover: empty, ...extra }, defaults, constants, now);
  const resetPolicy = kernelV2.makeKernelQuotaPolicy(
    identity,
    effective,
    7,
    { windowMs: 120_000, expiresAtMs: constants.noExpirationMs },
    constants.noUsageLimit,
    now + 4
  );
  const results = {
    keys: [
      kernelV2.kernelRepoPolicyKey("synthetic", "repo"),
      kernelV2.kernelOrgPolicyKey("synthetic"),
      kernelV2.kernelRepoWindowKey("synthetic", "repo"),
      kernelV2.kernelOrgWindowKey("synthetic"),
      kernelV2.kernelRepoReservationKey("synthetic", "repo", now, "request"),
      kernelV2.kernelOrgReservationKey("synthetic", now, "request"),
      kernelV2.KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY,
    ],
    scope: [
      kernelV2.decideKernelQuotaScope({ repoPolicy: empty, orgPolicy: empty }, "synthetic", "repo", constants),
      kernelV2.decideKernelQuotaScope({ repoPolicy: empty, orgPolicy: row(orgPolicy) }, "synthetic", "repo", constants),
      kernelV2.decideKernelQuotaScope({ repoPolicy: row(policy), orgPolicy: row(orgPolicy) }, "synthetic", "repo", constants),
    ],
    malformedPolicy: [
      failure(() => kernelV2.policyFor(row({}), "repo", "synthetic", "repo", defaults, constants)),
      failure(() => kernelV2.decideKernelQuotaScope({ repoPolicy: row(policy), orgPolicy: row({}) }, "synthetic", "repo", constants)),
    ],
    normalizedPolicy: kernelV2.normalizeKernelQuotaPolicyV2(
      { ...policy, window_ms: "60000.9", usage_limit_requests: "1.9", expires_at_ms: "bad" },
      "repo",
      "synthetic",
      "repo",
      constants
    ),
    legacyWindow: kernelV2.normalizeKernelQuotaWindowV2({ ...window, reserved_requests: undefined }, "repo", "synthetic", "repo"),
    malformedWindow: kernelV2.normalizeKernelQuotaWindowV2({ ...window, reserved_requests: -1 }, "repo", "synthetic", "repo"),
    replacement: [
      kernelV2.windowForEffectivePolicy(reserved.window, "repo", "synthetic", "repo", 60_000, now + 60_000),
      kernelV2.windowForEffectivePolicy(reserved.window, "repo", "synthetic", "repo", 120_000, now + 1),
    ],
    eligibility: [
      eligibility(null),
      eligibility(null, { expectedRepoPolicy: "present" }),
      eligibility(null, { expectedRepoPolicy: "absent", repoGuard: row(policy) }),
      eligibility(null, { defaultCutover: row({}) }),
      eligibility(policy, { defaultCutover: row({}) }),
      eligibility({ ...policy, expires_at_ms: now }),
      eligibility({ ...policy, usage_limit_requests: 0 }),
    ],
    reserved,
    duplicate: kernelV2.decideKernelQuotaReserve(
      identity,
      effective,
      reserved.window,
      row(reserved.reservation),
      "request",
      "responses",
      constants.noUsageLimit,
      now
    ),
    identityConflict: kernelV2.decideKernelQuotaReserve(
      identity,
      effective,
      reserved.window,
      row(reserved.reservation),
      "request",
      "chat.completions",
      constants.noUsageLimit,
      now
    ),
    full: kernelV2.decideKernelQuotaReserve(identity, effective, reserved.window, empty, "other", "responses", constants.noUsageLimit, now),
    unlimited: kernelV2.decideKernelQuotaReserve(
      identity,
      { ...effective, limit: constants.noUsageLimit },
      { ...reserved.window, usage_requests: 100 },
      empty,
      "other",
      "responses",
      constants.noUsageLimit,
      now
    ),
    pending,
    settle: settled,
    replay: kernelV2.decideKernelQuotaTerminalIntent(request, row(settled.reservation), "committed", now + 3),
    terminalMismatch: kernelV2.decideKernelQuotaTerminalIntent(request, row(pending.reservation), "released", now + 3),
    missing: kernelV2.decideKernelQuotaTerminalIntent(request, empty, "committed", now),
    malformed: kernelV2.decideKernelQuotaTerminalIntent(request, row({}), "committed", now),
    oldWindow: kernelV2.decideKernelQuotaSettlement(
      pending.reservation,
      { window: { ...window, created_at_ms: now + 1, usage_requests: 8 }, windowPresent: true },
      "committed",
      "completed",
      now + 4
    ),
    lostWindowReservation: kernelV2.decideKernelQuotaSettlement(pending.reservation, { window, windowPresent: true }, "committed", "completed", now + 4),
    invalidStoredWindow: kernelV2.decideKernelQuotaSettlement(pending.reservation, { window: null, windowPresent: true }, "committed", "completed", now + 4),
    released: kernelV2.decideKernelQuotaSettlement(reserved.reservation, { window: reserved.window, windowPresent: true }, "released", "", now + 4),
    longReleaseReason: kernelV2.settledKernelReservationRow(reserved.reservation, "released", "x".repeat(130), now + 4).release_reason,
    renewal: kernelV2.decideKernelQuotaRenewal(request, row(pending.reservation), now + 300_001),
    reclaim: [
      kernelV2.decideKernelQuotaReclaim(reserved.reservation, now + 299_999),
      kernelV2.decideKernelQuotaReclaim(reserved.reservation, now + 300_000),
      kernelV2.decideKernelQuotaReclaim(pending.reservation, pending.reservation.lease_expires_at_ms),
      kernelV2.decideKernelQuotaReclaim(settled.reservation, now + 900_000),
    ],
    cutover: [
      kernelV2.decideKernelDefaultWindowCutover(empty, "lease", now),
      kernelV2.decideKernelDefaultWindowCutover(row({}), "lease", now),
      kernelV2.decideKernelDefaultWindowCutover(row({ v: 2, id: "expired", created_at_ms: 1, expires_at_ms: 2 }), "lease", now),
    ],
    acquired: [
      kernelV2.kernelDefaultWindowCutoverAcquired(row({ v: 2, id: "lease", created_at_ms: now, expires_at_ms: now + 300_000 }), "lease"),
      kernelV2.kernelDefaultWindowCutoverAcquired(row({ v: 2, id: "lease", created_at_ms: now, expires_at_ms: now + 300_000 }, null), "lease"),
    ],
    policyGuard: [
      kernelV2.decideKernelPolicyWindowGuard(reserved.window, true, true, now),
      kernelV2.decideKernelPolicyWindowGuard(reserved.window, true, false, now),
      kernelV2.decideKernelPolicyWindowGuard(null, true, true, now),
      kernelV2.decideKernelPolicyWindowGuard(reserved.window, true, true, now + 60_000),
    ],
    deletePreconditions: [
      kernelV2.decideKernelQuotaPolicyDeletePrecondition({ policy: empty, defaultCutover: row({}) }),
      kernelV2.decideKernelQuotaPolicyDeletePrecondition({ policy: row(policy), defaultCutover: row({}) }),
      kernelV2.decideKernelQuotaPolicyDeletePrecondition({ policy: row(policy), defaultCutover: empty }),
    ],
    resetRequested: [
      kernelV2.kernelQuotaPolicyResetRequested({}, 60_000, 60_000),
      kernelV2.kernelQuotaPolicyResetRequested({ resetUsage: true }, 60_000, 60_000),
      kernelV2.kernelQuotaPolicyResetRequested({}, 60_000, 120_000),
    ],
    policyTiming: kernelV2.resolveKernelPolicyTiming({ windowMs: 0, expiresAtMs: -99 }, effective, constants.noExpirationMs),
    policyWrite: kernelV2.decideKernelQuotaPolicyWrite(identity, resetPolicy, reserved.window, true, now + 4),
    policyDelete: [
      kernelV2.decideKernelQuotaPolicyDeleteWindow(identity, effective, defaults, reserved.window, now + 4),
      kernelV2.decideKernelQuotaPolicyDeleteWindow(identity, effective, { ...defaults, windowMs: 120_000 }, reserved.window, now + 4),
    ],
    retention: [
      kernelV2.kernelReservationRetentionMs(window.usage_reset_at_ms, now),
      kernelV2.kernelReservationRetentionMs(window.usage_reset_at_ms, now + 1),
      kernelV2.kernelReservationRetentionMs(window.usage_reset_at_ms, now + 700_000_000),
    ],
    snapshotUnchanged: before === JSON.stringify({ policy, window, reservation: reserved.reservation }),
  };
  return results;
};
// END SHARED_KERNEL_VECTORS

const constants = { noUsageLimit: API_KEY_NO_USAGE_LIMIT, noExpirationMs: API_KEY_NO_EXPIRATION_MS };

test("native kernel pure scope and eligibility preserve explicit refusal, defaults and exact key identity", () => {
  const result = runKernelConformanceVectors(constants);
  assert.deepEqual(result.keys, [
    ["uos_ai", "kernel_quota", "v2", "repo_policy", "synthetic", "repo"],
    ["uos_ai", "kernel_quota", "v2", "org_policy", "synthetic"],
    ["uos_ai", "kernel_quota", "v2", "repo_window", "synthetic", "repo"],
    ["uos_ai", "kernel_quota", "v2", "org_window", "synthetic"],
    ["uos_ai", "kernel_quota", "v2", "repo_reservation", "synthetic", "repo", 10_000_000, "request"],
    ["uos_ai", "kernel_quota", "v2", "org_reservation", "synthetic", 10_000_000, "request"],
    ["uos_ai", "kernel_quota", "v2", "default_window_cutover"],
  ]);
  assert.deepEqual(result.scope, [
    { limit_scope: "org", has_policy: false },
    { limit_scope: "org", has_policy: true },
    { limit_scope: "repo", has_policy: true },
  ]);
  assert.deepEqual(result.malformedPolicy, ["kernel quota policy is malformed", "Kernel org quota policy is malformed"]);
  assert.equal(result.normalizedPolicy?.window_ms, 60_000);
  assert.equal(result.normalizedPolicy.usage_limit_requests, 1);
  assert.equal(result.normalizedPolicy.expires_at_ms, -1);
  assert.equal(result.legacyWindow?.reserved_requests, 0);
  assert.equal(result.malformedWindow, null);
  assert.deepEqual(
    result.eligibility.map((value) => (value.kind === "refused" ? value.status : value.kind)),
    ["eligible", 503, 503, 503, "eligible", 429, 429]
  );
});

test("native kernel pure lifecycle preserves duplicate refusal, committed intent, replay and original-window retention", () => {
  const result = runKernelConformanceVectors(constants);
  assert.equal(result.duplicate.kind, "refused");
  assert.equal(result.duplicate.message, "Kernel quota request already has a reservation");
  assert.equal(result.identityConflict.kind, "refused");
  assert.equal(result.full.kind, "full");
  assert.equal(result.unlimited.kind, "reserve");
  assert.equal(result.reserved.reservation.lease_expires_at_ms, 10_300_000);
  assert.equal(result.pending.reservation.terminal_intent, "committed");
  assert.equal(result.pending.leaseExpiresAtMs, 10_300_001);
  assert.equal(result.settle.window?.usage_requests, 1);
  assert.equal(result.settle.window.reserved_requests, 0);
  assert.deepEqual(result.replay, { kind: "unchanged", outcome: "settled" });
  assert.deepEqual(result.terminalMismatch, { kind: "unchanged", outcome: "terminal_mismatch" });
  assert.deepEqual(result.missing, { kind: "unchanged", outcome: "missing" });
  assert.deepEqual(result.malformed, { kind: "unchanged", outcome: "invalid" });
  assert.equal(result.oldWindow.kind, "settle");
  assert.equal(result.oldWindow.window, null);
  assert.deepEqual(result.lostWindowReservation, { kind: "unchanged", outcome: "invalid" });
  assert.deepEqual(result.invalidStoredWindow, { kind: "unchanged", outcome: "invalid" });
  if (result.released.kind === "settle") {
    assert.equal(result.released.window?.usage_requests, 0);
    assert.equal(result.released.reservation.release_reason, "request_incomplete");
  } else assert.fail("Release must write its terminal row");
  assert.equal(result.longReleaseReason?.length, 120);
  assert.deepEqual(result.reclaim, [null, "released", "committed", null]);
  assert.equal(result.renewal.reservation.terminal_intent, "committed");
  assert.equal(result.renewal.leaseExpiresAtMs, 10_600_001);
  assert.equal(result.renewal.expireIn + 10_300_001, 10_060_000 + 604_800_000);
  assert.deepEqual(result.retention, [604_860_000, 604_859_999, 1]);
  assert.equal(result.snapshotUnchanged, true);
});

test("native kernel pure cutover and policy writes keep live-work guards separate from natural replacement", () => {
  const result = runKernelConformanceVectors(constants);
  assert.deepEqual(
    result.cutover.map((value) => (value.kind === "refused" ? value.reason : value.expireIn)),
    [300_000, "unavailable", "concurrent_change"]
  );
  assert.deepEqual(result.acquired, [true, false]);
  assert.deepEqual(
    result.policyGuard.map((value) => value.kind),
    ["reclaim", "proceed", "abort", "proceed"]
  );
  assert.deepEqual(result.deletePreconditions, ["absent", "conflict", "proceed"]);
  assert.deepEqual(result.resetRequested, [false, true, true]);
  assert.deepEqual(result.policyTiming, { windowMs: 60_000, expiresAtMs: -1 });
  assert.equal(result.policyWrite.policy.created_at_ms, 0);
  assert.equal(result.policyWrite.window.reserved_requests, 0);
  assert.equal(result.policyWrite.window.applied_window_ms, 120_000);
  assert.equal(result.policyDelete[0].created_at_ms, 10_000_000);
  assert.equal(result.policyDelete[0].reserved_requests, 1);
  assert.equal(result.policyDelete[1].created_at_ms, 10_000_004);
  assert.equal(result.policyDelete[1].reserved_requests, 0);
  assert.ok(result.replacement.every((value) => value.needsWrite && value.window.reserved_requests === 0));
});

/** Forces real opaque-revision CAS loss without changing the existing fixture or harness. */
class KernelConflictKv extends CountingKv {
  conflicts = 0;
  changeDefault = false;
  readonly checkedKeys: KvKey[][] = [];
  override atomic(): AtomicOperation {
    const operation = super.atomic();
    const checks: KvKey[] = [];
    const check = operation.check.bind(operation);
    const commit = operation.commit.bind(operation);
    operation.check = (entry) => {
      checks.push(entry.key);
      return check(entry);
    };
    operation.commit = async () => {
      this.checkedKeys.push(checks);
      if (this.changeDefault) {
        this.changeDefault = false;
        this.seed(DEFAULT_KERNEL_POLICY_LIMIT_KEY, 0);
      }
      if (this.conflicts > 0) {
        this.conflicts -= 1;
        return { ok: false };
      }
      return await commit();
    };
    return operation;
  }
}

test("native kernel wrapper re-reads a racing default and checks the absent repo plus all default guards", async () => {
  const kv = new KernelConflictKv();
  kv.seed(DEFAULT_KERNEL_POLICY_LIMIT_KEY, 1);
  kv.seed(DEFAULT_KERNEL_POLICY_WINDOW_KEY, 60_000);
  kv.changeDefault = true;
  const decision = await reserveEffectiveKernelUsageLimit("synthetic", "repo", "request", "responses", { kv: kv as unknown as Kv });
  if (decision.ok) {
    await decision.reservation.release("test_cleanup");
    assert.fail("Racing zero default must refuse");
  }
  assert.equal(decision.response.status, 429);
  assert.deepEqual(
    kv.checkedKeys[0].map((key) => key.slice(3, 4)[0] ?? key[1]),
    ["org_policy", "org_window", "org_reservation", "repo_policy", "kernel_policy_limit_requests", "kernel_policy_window_ms", "default_window_cutover"]
  );
  assert.equal(kv.checkedKeys.length, 1);
  assert.equal(
    [...kv.entries.values()].some((entry) => entry.key.includes("org_reservation")),
    false
  );
});

test("native kernel wrapper retains three CAS attempts and leaves all rows absent after conflict exhaustion", async () => {
  const kv = new KernelConflictKv();
  kv.seed(DEFAULT_KERNEL_POLICY_LIMIT_KEY, 1);
  kv.seed(DEFAULT_KERNEL_POLICY_WINDOW_KEY, 60_000);
  kv.conflicts = 3;
  const decision = await reserveKernelOrgUsageLimit("synthetic", "request", "responses", { kv: kv as unknown as Kv });
  if (decision.ok) {
    await decision.reservation.release("test_cleanup");
    assert.fail("Exhausted CAS must refuse");
  }
  assert.equal(decision.response.status, 503);
  assert.equal(kv.checkedKeys.length, 3);
  assert.equal(kv.entries.size, 2);
});
