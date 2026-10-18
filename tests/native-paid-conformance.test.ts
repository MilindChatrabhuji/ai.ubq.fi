import { test } from "bun:test";
import assert from "node:assert/strict";
import * as paid from "../src/authority/native-paid.ts";
import type {
  NativePaidAdmissionInput,
  NativePaidRow,
  PaidFallbackRequestV3,
  PaidFallbackWindowV3,
  PaidFallbackPendingV3,
  PaidFallbackDeletionGuardV3,
  PaidFallbackReconciliationGateV3,
} from "../src/authority/native-paid-contracts.ts";

// BEGIN SHARED_PAID_VECTORS
/** This exact synthetic vector function executes against the same source in Bun and real workerd. */
export const runPaidConformanceVectors = () => {
  const now = 1_700_000_000_000;
  const row = <T>(value: T | null, versionstamp: string | null = "opaque-revision"): NativePaidRow<T> => ({ value, versionstamp });
  const input: NativePaidAdmissionInput = {
    keyId: "key",
    requestId: "request",
    createdAtMs: now,
    policyVersion: "policy-v3",
    limitMicrocredits: 100,
    maximumExposureMicrocredits: 80,
    initialSettledMicrocredits: 0,
    quotaPerCredit: 500_000,
    windowResetAtMs: now + 60_000,
    model: " model ",
    route: "responses",
    path: "/v1/responses",
    stream: false,
    reasoning: null,
  };
  const empty = {
    request: row<PaidFallbackRequestV3>(null, null),
    window: row<PaidFallbackWindowV3>(null, null),
    deletionGuard: row<PaidFallbackDeletionGuardV3>(null, null),
    policyFence: { versionstamp: "H:opaque" },
  };
  const policy = { unlimited: false, maximumExposure: 80 };
  const admitted = paid.planPaidFallbackAdmissionV3(input, empty, policy, now);
  if (admitted.kind !== "write" || !admitted.window) throw new Error("Synthetic paid admission failed");
  const snapshotBefore = JSON.stringify({ input, empty, admitted });
  const saturatedWindow = { ...admitted.window, settled_microcredits: 70, reserved_microcredits: 20 };
  const partial = paid.planPaidFallbackAdmissionV3({ ...input, requestId: "partial" }, { ...empty, window: row(saturatedWindow) }, policy, now);
  const exhausted = paid.planPaidFallbackAdmissionV3(
    { ...input, policyVersion: "edited", limitMicrocredits: 50 },
    { ...empty, window: row(saturatedWindow) },
    policy,
    now
  );
  const pending = row<PaidFallbackPendingV3>(admitted.pending);
  const gate = row<PaidFallbackReconciliationGateV3>({ next_due_at_ms: now + 100_000 });
  const request = row(admitted.request);
  const dispatched = paid.planPaidFallbackLifecycleV3(
    admitted.request,
    { dispatch_state: "dispatched", provider: "metered", provider_request_id: "provider-id" },
    now + 1
  );
  if (!dispatched) throw new Error("Synthetic paid dispatch failed");
  const metered = { ...dispatched.request, request_id: "client:metered" };
  const surplus = { ...dispatched.request, request_id: "client:surplus", provider: "surplus" as const, provider_request_id: null };
  const log = {
    request_id: "provider-id",
    quota: 400_000,
    prompt_tokens: 12,
    cached_prompt_tokens: 3,
    completion_tokens: 4,
    model: "model",
    created_at: now / 1000,
  };
  const metadata = { correlation: "provider_request_id" as const, microcreditsPerCredit: 1_000_000 };
  const meteredEvaluation = paid.evaluatePaidFallbackSettlementV3(metered, admitted.pending, log, metadata);
  if (meteredEvaluation.kind !== "settle") throw new Error("Synthetic Metered settlement failed");
  const rollup = paid.paidFallbackSettlementRollupV3(metered, log, meteredEvaluation.spend, "provider_request_id", null, now + 2);
  const settled = paid.planPaidFallbackSettlementRowsV3(
    { request: row(metered), pending, gate, window: row(admitted.window), rollup: row(null) },
    log,
    meteredEvaluation.spend,
    rollup.foldIntoRollup,
    now + 2
  );
  const cancelled = paid.planPaidFallbackReleaseV3({ request, window: row(admitted.window), gate }, false, now + 3);
  const intent = paid.planPaidFallbackAdmissionV3({ ...input, dispatchIntent: true }, empty, policy, now);
  if (intent.kind !== "write") throw new Error("Synthetic intent failed");
  const old = { ...admitted.request, created_at_ms: now - 24 * 60 * 60_000, reconciliation_attempts: 8 };
  const deferred = paid.planPaidFallbackDeferralV3(old, admitted.pending, now);
  const terminal = {
    model: " model ",
    provider: "chatgpt_codex",
    request_id: "terminal",
    request_created_at_ms: now,
    input_tokens: 12,
    cached_input_tokens: null,
    output_tokens: 4,
  };
  const terminalUsage = paid.paidFallbackTerminalUsageV3(terminal);
  if (!terminalUsage) throw new Error("Synthetic terminal usage failed");
  return {
    admitted,
    partial,
    exhausted,
    invalidPolicy: paid.isInvalidAdmissionPolicy({ ...input, limitMicrocredits: 0 }, false, 80),
    unlimited: paid.planPaidFallbackAdmissionV3({ ...input, limitMicrocredits: -1 }, empty, { unlimited: true, maximumExposure: null }, now),
    deletionGuard: paid.planPaidFallbackAdmissionV3(input, { ...empty, deletionGuard: row({ created_at_ms: now }) }, policy, now),
    reuse: paid.planPaidFallbackAdmissionV3(input, { ...empty, request }, policy, now),
    consumed: paid.planPaidFallbackAdmissionV3(input, { ...empty, request: row(settled.request) }, policy, now),
    dispatched,
    lifecycleReplay: paid.planPaidFallbackLifecycleV3(
      dispatched.request,
      { dispatch_state: "reserved", provider: "surplus", provider_request_id: "replacement" },
      now + 3
    ),
    cancelled,
    releaseIntentDefault: paid.planPaidFallbackReleaseV3({ request: row(intent.request), window: row(intent.window), gate }, false, now + 3),
    releaseIntentKnownNoFetch: paid.planPaidFallbackReleaseV3({ request: row(intent.request), window: row(intent.window), gate }, true, now + 3),
    releaseCorrelated: paid.planPaidFallbackReleaseV3({ request: row(metered), window: row(admitted.window), gate }, true, now + 3),
    releaseAfterSettlement: paid.planPaidFallbackReleaseV3({ request: row(settled.request), window: row(settled.window), gate }, true, now + 3),
    meteredEvaluation,
    rollup,
    settled,
    settlementReplay: paid.evaluatePaidFallbackSettlementV3(settled.request, admitted.pending, log, metadata),
    mismatchedMetered: paid.evaluatePaidFallbackSettlementV3(metered, admitted.pending, { ...log, request_id: "other" }, metadata),
    missingPending: paid.evaluatePaidFallbackSettlementV3(metered, null, log, metadata),
    surplusExact: paid.evaluatePaidFallbackSettlementV3(
      surplus,
      admitted.pending,
      { ...log, request_id: "gateway-reservation" },
      { correlation: "surplus_reservation", microcreditsPerCredit: 1_000_000, surplusBuyerCostMicro: 69 }
    ),
    surplusZero: paid.evaluatePaidFallbackSettlementV3(surplus, admitted.pending, log, {
      correlation: "surplus_reservation",
      microcreditsPerCredit: 1_000_000,
      surplusBuyerCostMicro: 0,
    }),
    surplusCannotSettleMetered: paid.evaluatePaidFallbackSettlementV3(metered, admitted.pending, log, {
      correlation: "surplus_reservation",
      microcreditsPerCredit: 1_000_000,
      surplusBuyerCostMicro: 69,
    }),
    invalidSpend: paid.evaluatePaidFallbackSettlementV3(metered, admitted.pending, { ...log, quota: Infinity }, metadata),
    deferred,
    deferralCleanup: paid.planPaidFallbackDeferralV3(settled.request, admitted.pending, now),
    deferralNoop: paid.planPaidFallbackDeferralV3(metered, null, now),
    originalExpiry: [
      paid.requestRowExpireIn(admitted.request, now),
      paid.requestRowExpireIn(admitted.request, now + 1),
      paid.windowExpireIn(admitted.window, now),
      paid.requestRowExpireIn(admitted.request, now + paid.PAID_FALLBACK_REQUEST_LOG_RETENTION_MS + 1),
    ],
    gateDue: [
      paid.paidFallbackReconciliationGateDueNow(gate, now),
      paid.paidFallbackReconciliationGateDueNow(row({ next_due_at_ms: now - 1 }), now),
      paid.paidFallbackGateAfterScanV3(null),
    ],
    guard: paid.planPaidFallbackDeletionGuardV3(null, now),
    guardReplay: paid.planPaidFallbackDeletionGuardV3({ created_at_ms: now - 1 }, now),
    deletion: paid.planPaidFallbackDeletionV3({ pending_requests: 0, unresolved_requests: 1, pending_markers: 1, has_outstanding: true }),
    leases: [
      paid.paidFallbackReconciliationLeaseV3("lease", now),
      paid.paidFallbackBackfillLeaseV3("backfill", now),
      paid.paidFallbackLeaseActiveV3({ token: "lease", expires_at_ms: now }, now),
      paid.paidFallbackLeaseOwnedV3({ token: "old", expires_at_ms: now }, "new"),
    ],
    backfill: paid.planPaidFallbackBackfillFoldV3({ ...settled.request, usage_rollup_at_ms: undefined }, null, now + 3),
    backfillPending: paid.planPaidFallbackBackfillFoldV3(admitted.request, null, now + 3),
    legacyMetered: paid.paidFallbackRequestRollupIdentity({ ...metered, provider: undefined }),
    terminalRollup: paid.paidFallbackTerminalRollupV3(terminal, terminalUsage, "terminal", now),
    terminalSkipped: [
      paid.paidFallbackTerminalUsageV3({ ...terminal, provider: "metered" }),
      paid.paidFallbackTerminalUsageV3({ ...terminal, provider: "surplus" }),
      paid.paidFallbackTerminalUsageV3({ ...terminal, input_tokens: null }),
    ],
    key: paid.paidFallbackRequestV3Key("key", "request"),
    rollupKey: paid.paidFallbackUsageRollupKey(0, "model", "metered", paid.paidFallbackUsageRollupShard("request")),
    backfillStates: [
      paid.paidFallbackRequestBackfillStateV3(null),
      paid.paidFallbackRequestBackfillStateV3(admitted.request),
      paid.paidFallbackRequestBackfillStateV3(settled.request),
    ],
    gateScan: paid.planPaidFallbackGateAfterScanV3({ value: { next_due_at_ms: now }, versionstamp: "opaque:not-a-counter" }, null),
    immutable: snapshotBefore === JSON.stringify({ input, empty, admitted }),
  };
};
// END SHARED_PAID_VECTORS

test("paid pure admission preserves bounded exposure, unlimited rows, H/deletion checks and policy transitions", () => {
  const v = runPaidConformanceVectors();
  assert.equal(v.admitted.kind, "write");
  assert.equal(v.partial.kind, "write");
  assert.equal(v.exhausted.kind, "exhausted_policy");
  if (v.unlimited.kind !== "write") throw new Error("Missing write vector");
  assert.equal(v.partial.request.reserved_microcredits, 10);
  assert.equal(v.unlimited.window, null);
  assert.equal(v.unlimited.request.reserved_microcredits, 0);
  assert.deepEqual(v.admitted.checks, ["request", "deletionGuard", "policy", "window"]);
  assert.equal(v.invalidPolicy, true);
  assert.deepEqual(v.deletionGuard, { kind: "blocked", reason: "invalid_policy" });
  assert.deepEqual(v.consumed, { kind: "blocked", reason: "invalid_policy" });
  assert.equal(v.reuse.kind, "reserved");
});
test("paid pure lifecycle keeps correlation sticky and refunds only definite no-fetch work", () => {
  const v = runPaidConformanceVectors();
  assert.ok(v.cancelled);
  assert.ok(v.cancelled.window);
  assert.ok(v.releaseIntentKnownNoFetch);
  assert.equal(v.lifecycleReplay, null);
  assert.equal(v.cancelled.request.billing_state, "not_billed");
  assert.equal(v.releaseIntentDefault, null);
  assert.equal(v.releaseIntentKnownNoFetch.request.billing_state, "not_billed");
  assert.equal(v.releaseCorrelated, null);
  assert.equal(v.releaseAfterSettlement, null);
  assert.deepEqual(v.cancelled.checks, ["request", "gate", "window"]);
  assert.equal(v.cancelled.window.reserved_microcredits, 0);
});
test("paid pure settlement keeps Metered and Surplus correlation, actual overspend and terminal independence", () => {
  const v = runPaidConformanceVectors();
  assert.ok(v.settled.window);
  assert.deepEqual(v.meteredEvaluation, { kind: "settle", spend: 800_000 });
  assert.deepEqual(v.surplusExact, { kind: "settle", spend: 69 });
  assert.deepEqual(v.surplusZero, { kind: "settle", spend: 0 });
  assert.deepEqual(v.mismatchedMetered, { kind: "noop" });
  assert.deepEqual(v.surplusCannotSettleMetered, { kind: "noop" });
  assert.deepEqual(v.missingPending, { kind: "noop" });
  assert.deepEqual(v.invalidSpend, { kind: "defer" });
  assert.equal(v.settled.request.terminal_state, "pending");
  assert.equal(v.settled.request.terminal_at_ms, null);
  assert.equal(v.settled.window.settled_microcredits, 800_000);
  assert.equal(v.settled.window.reserved_microcredits, 0);
  assert.deepEqual(v.settlementReplay, { kind: "cleanup" });
  assert.deepEqual(v.settled.checks, ["request", "pending", "rollup", "gate", "window"]);
  assert.equal(v.rollup.rollup.provider, "metered");
});
test("paid pure deferral retains unresolved exposure and preserves the original cleanup check set", () => {
  const v = runPaidConformanceVectors();
  if (v.deferred.kind !== "write") throw new Error("Missing deferral vector");
  assert.equal(v.deferred.request.billing_state, "unresolved");
  assert.equal(v.deferred.request.reserved_microcredits, 80);
  assert.equal(v.deferred.delay, 21_600_000);
  assert.equal(v.deferred.request.terminal_state, "pending");
  assert.deepEqual(v.deferralCleanup, { kind: "cleanup", checks: ["pending", "gate"] });
  assert.deepEqual(v.deferralNoop, { kind: "noop", checks: [] });
  assert.equal(v.deletion.kind, "blocked");
});
test("paid pure retention, permanent guards, leases and rollup facts retain native identities", () => {
  const v = runPaidConformanceVectors();
  assert.ok(v.guard);
  assert.ok(v.backfill.rollup);
  const year = paid.PAID_FALLBACK_REQUEST_LOG_RETENTION_MS;
  assert.deepEqual(v.originalExpiry, [year, year - 1, year + 60_000, 1]);
  assert.equal(v.guardReplay, null);
  assert.equal(v.guard.created_at_ms, 1_700_000_000_000);
  assert.equal(v.backfillPending.rollup, null);
  assert.equal(v.backfill.rollup.request_count, 1);
  assert.equal(v.backfill.rollup.spend_microcredits, 800_000);
  assert.equal(v.legacyMetered.provider, "metered");
  assert.deepEqual(v.terminalSkipped, [null, null, null]);
  assert.equal(v.terminalRollup.quota, 0);
  assert.equal(v.terminalRollup.cached_input_tokens, null);
  assert.deepEqual(v.backfillStates, ["missing", "fold", "retention"]);
  assert.deepEqual(v.gateScan, { gate: { next_due_at_ms: null }, checks: ["gate"], versionstamp: "opaque:not-a-counter" });
  assert.equal(v.immutable, true);
  assert.deepEqual(v.leases.slice(2), [false, false]);
  assert.deepEqual(v.key, ["uos_ai", "paid_fallback", "v3", "request", "key", "request"]);
});
