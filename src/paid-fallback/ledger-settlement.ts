import type { Kv, KvEntryMaybe, KvKey } from "#kv";
// Paid-fallback ledger v3: settlement layer, split out of src/paid_fallback_ledger.ts.

import {
  evaluatePaidFallbackSettlementV3,
  planPaidFallbackSettlementRowsV3,
  planPaidFallbackDeferralV3,
  paidFallbackRequestRollupIdentity,
  paidFallbackSettlementRollupV3,
  paidFallbackLeaseActiveV3,
  paidFallbackReconciliationLeaseV3,
  paidFallbackLeaseOwnedV3,
} from "../authority/native-paid.ts";
import type { NativePaidSettlementPlan } from "../authority/native-paid-contracts.ts";
import { MICROCREDITS_PER_CREDIT } from "../api-keys.ts";
import { getKv } from "../kv.ts";
import { type MeteredTokenLogEntry } from "../provider/metered.ts";
import {
  MAX_CAS_ATTEMPTS,
  type PaidFallbackAdmissionV3,
  type PaidFallbackPendingV3,
  type PaidFallbackReconciliationGateV3,
  type PaidFallbackReconciliationLeaseV3,
  RECONCILIATION_LEASE_MS,
  paidFallbackPendingV3Key,
  paidFallbackReconciliationGateDueNow,
  paidFallbackReconciliationGateNeedsArm,
  paidFallbackReconciliationGateV3Key,
  paidFallbackReconciliationLeaseV3Key,
  paidFallbackRequestV3Key,
  paidFallbackWindowV3Key,
  windowExpireIn,
} from "./ledger-state.ts";
import { type PaidFallbackUsageRollup, isPaidFallbackUsageRollup, paidFallbackUsageRollupKey } from "./rollups.ts";
import { estimatePaidFallbackRecordBytes, recordPaidFallbackLedgerSettlementStats } from "./ledger-stats.ts";
import { type PaidFallbackRequestV3, type PaidFallbackWindowV3 } from "../types.ts";

const acquireReconciliationLease = async (kv: Kv, keyId: string, now: number): Promise<PaidFallbackReconciliationLeaseV3 | null> => {
  const key = paidFallbackReconciliationLeaseV3Key(keyId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<PaidFallbackReconciliationLeaseV3>(key, { consistency: "strong" });
    if (paidFallbackLeaseActiveV3(entry.value, now)) return null;
    const lease = paidFallbackReconciliationLeaseV3(crypto.randomUUID(), now);
    const commit = await kv
      .atomic()
      .check(entry)
      .set(key, lease, {
        expireIn: RECONCILIATION_LEASE_MS,
      })
      .commit();
    if (commit.ok) return lease;
  }
  return null;
};

const releaseReconciliationLease = async (kv: Kv, keyId: string, lease: PaidFallbackReconciliationLeaseV3): Promise<void> => {
  const key = paidFallbackReconciliationLeaseV3Key(keyId);
  const entry = await kv.get<PaidFallbackReconciliationLeaseV3>(key, { consistency: "strong" });
  if (!paidFallbackLeaseOwnedV3(entry.value, lease.token)) return;
  await kv.atomic().check(entry).delete(key).commit();
};

const _expeditePaidFallbackReconciliationV3 = async (reservation: PaidFallbackAdmissionV3, now: number): Promise<void> => {
  const kv = await getKv();
  if (!kv) return;
  const pendingKey = paidFallbackPendingV3Key(reservation.key_id, reservation.request_id);
  const gateKey = paidFallbackReconciliationGateV3Key();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const [pending, gateEntry] = await Promise.all([
      kv.get<PaidFallbackPendingV3>(pendingKey, { consistency: "strong" }),
      kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" }),
    ]);
    if (!pending.value) return;
    const markerNeedsExpedite = pending.value.next_reconciliation_at_ms > now;
    const gateNeedsArm = paidFallbackReconciliationGateNeedsArm(gateEntry, now);
    if (!markerNeedsExpedite && !gateNeedsArm) return;
    let atomic = kv.atomic().check(pending).check(gateEntry);
    if (markerNeedsExpedite) {
      atomic = atomic.set(pendingKey, {
        ...pending.value,
        next_reconciliation_at_ms: now,
      } satisfies PaidFallbackPendingV3);
    }
    // A real expedite must version-bump the gate even when it is already due;
    // otherwise an overlapping recompute can overwrite the new marker with a
    // stale future timestamp.
    atomic = atomic.set(gateKey, paidFallbackReconciliationGateDueNow(gateEntry, now));
    if ((await atomic.commit()).ok) {
      return;
    }
  }
  throw new Error("Paid fallback reconciliation scheduling changed concurrently.");
};

/**
 * Records bounded backoff after a provider log is unavailable or invalid.
 * This writes durable state only: the event-driven policy does not arm a timer
 * or otherwise deliver a future reconciliation to an idle Mac.
 */
const deferPaidFallbackReconciliationV3 = async (kv: Kv, keyId: string, requestId: string, now: number): Promise<number | null> => {
  const requestKey = paidFallbackRequestV3Key(keyId, requestId);
  const pendingKey = paidFallbackPendingV3Key(keyId, requestId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const [requestEntry, pendingEntry] = await Promise.all([
      kv.get<PaidFallbackRequestV3>(requestKey, { consistency: "strong" }),
      kv.get<PaidFallbackPendingV3>(pendingKey, { consistency: "strong" }),
    ]);
    const plan = planPaidFallbackDeferralV3(requestEntry.value, pendingEntry.value, now);
    if (plan.kind === "noop") return null;
    if (plan.kind === "cleanup") {
      const gateKey = paidFallbackReconciliationGateV3Key();
      const gateEntry = await kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" });
      let cleanup = kv.atomic().check(pendingEntry).delete(pendingKey);
      cleanup = cleanup.check(gateEntry);
      cleanup = cleanup.set(gateKey, paidFallbackReconciliationGateDueNow(gateEntry, now));
      const cleanupResult = await cleanup.commit();
      if (cleanupResult.ok) return null;
      continue;
    }
    const atomic = kv
      .atomic()
      .check(requestEntry)
      .check(pendingEntry)
      .set(requestKey, plan.request, { expireIn: plan.requestExpireIn })
      .set(pendingKey, plan.pending);
    if ((await atomic.commit()).ok) return plan.delay;
  }
  throw new Error("Paid fallback reconciliation deferral changed concurrently.");
};

/** Clears a stale pending marker for a row that can no longer be billed. */
const clearStalePendingMarkerV3 = async (
  kv: Kv,
  pendingKey: KvKey,
  pendingEntry: KvEntryMaybe<PaidFallbackPendingV3>,
  gateKey: KvKey,
  gateEntry: KvEntryMaybe<PaidFallbackReconciliationGateV3>,
  now: number
): Promise<boolean> => {
  if (!pendingEntry.value) return true;
  let cleanup = kv.atomic().check(pendingEntry).delete(pendingKey);
  cleanup = cleanup.check(gateEntry);
  cleanup = cleanup.set(gateKey, paidFallbackReconciliationGateDueNow(gateEntry, now));
  return (await cleanup.commit()).ok;
};

/** The usage rollup one settlement folds into. */
type SettlementRollupV3 = Readonly<{
  rollupKey: KvKey;
  rollupEntry: KvEntryMaybe<PaidFallbackUsageRollup>;
  nextRollup: PaidFallbackUsageRollup;
  /** False when the model or provider label is empty, so no rollup is written. */
  foldIntoRollup: boolean;
}>;

/** Reads and merges the usage rollup this settlement belongs to. */
const prepareSettlementRollupV3 = async (
  kv: Kv,
  request: PaidFallbackRequestV3,
  providerLog: MeteredTokenLogEntry,
  spend: number,
  correlation: "provider_request_id" | "surplus_reservation",
  now: number
): Promise<SettlementRollupV3> => {
  const { model, provider, bucketStartAtMs, shard } = paidFallbackRequestRollupIdentity(request, correlation);
  const rollupKey = paidFallbackUsageRollupKey(bucketStartAtMs, model, provider, shard);
  const rollupEntry = await kv.get<PaidFallbackUsageRollup>(rollupKey, { consistency: "strong" });
  const existingRollup = isPaidFallbackUsageRollup(rollupEntry.value) ? rollupEntry.value : null;
  const plan = paidFallbackSettlementRollupV3(request, providerLog, spend, correlation, existingRollup, now);
  return { rollupKey, rollupEntry, nextRollup: plan.rollup, foldIntoRollup: plan.foldIntoRollup };
};

/**
 * Best-effort daily growth sample for one committed settlement. The recorder
 * swallows its own failures, so this only measures the two records: a lost
 * sample must never fail a settlement that already committed.
 */
const recordSettlementGrowthV3 = async (kv: Kv, settledRow: PaidFallbackRequestV3, rollup: SettlementRollupV3, now: number): Promise<void> => {
  await recordPaidFallbackLedgerSettlementStats(kv, {
    settledRowBytes: estimatePaidFallbackRecordBytes(settledRow),
    rollupBytes: rollup.foldIntoRollup ? estimatePaidFallbackRecordBytes(rollup.nextRollup) : null,
    nowMs: now,
  });
};

type SettlementCommitV3 = Readonly<{
  requestKey: KvKey;
  pendingKey: KvKey;
  windowKey: KvKey;
  requestEntry: KvEntryMaybe<PaidFallbackRequestV3>;
  pendingEntry: KvEntryMaybe<PaidFallbackPendingV3>;
  gateEntry: KvEntryMaybe<PaidFallbackReconciliationGateV3>;
  windowEntry: KvEntryMaybe<PaidFallbackWindowV3>;
  plan: NativePaidSettlementPlan;
  rollup: SettlementRollupV3;
  now: number;
}>;
const commitPaidFallbackSettlementV3 = async (kv: Kv, input: SettlementCommitV3): Promise<boolean> => {
  const { requestKey, pendingKey, windowKey, requestEntry, pendingEntry, gateEntry, windowEntry, plan, rollup, now } = input;
  const gateKey = paidFallbackReconciliationGateV3Key();
  const settledRow = plan.request;
  let atomic = kv
    .atomic()
    .check(requestEntry)
    .check(pendingEntry)
    .set(requestKey, settledRow, {
      expireIn: plan.requestExpireIn,
    })
    .delete(pendingKey);
  if (rollup.foldIntoRollup) {
    atomic = atomic.check(rollup.rollupEntry).set(rollup.rollupKey, rollup.nextRollup);
  }
  atomic = atomic.check(gateEntry);
  // Settlement removes billable work. Keep the gate due and version it so a
  // concurrent recompute cannot resurrect this marker's stale future time.
  atomic = atomic.set(gateKey, plan.gate);
  if (plan.window) atomic = atomic.check(windowEntry).set(windowKey, plan.window, { expireIn: windowExpireIn(plan.window, now) });
  return (await atomic.commit()).ok;
};

const settlePaidFallbackRequestV3 = async (
  kv: Kv,
  keyId: string,
  requestId: string,
  providerLog: MeteredTokenLogEntry,
  now: number,
  correlation: "provider_request_id" | "surplus_reservation" = "provider_request_id",
  surplusBuyerCostMicro?: number
): Promise<Readonly<{ settled: boolean; retry_delay_ms: number | null }>> => {
  const requestKey = paidFallbackRequestV3Key(keyId, requestId);
  const pendingKey = paidFallbackPendingV3Key(keyId, requestId);
  const gateKey = paidFallbackReconciliationGateV3Key();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const [requestEntry, pendingEntry, gateEntry] = await Promise.all([
      kv.get<PaidFallbackRequestV3>(requestKey, { consistency: "strong" }),
      kv.get<PaidFallbackPendingV3>(pendingKey, { consistency: "strong" }),
      kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" }),
    ]);
    const request = requestEntry.value;
    const evaluation = evaluatePaidFallbackSettlementV3(request, pendingEntry.value, providerLog, {
      correlation,
      microcreditsPerCredit: MICROCREDITS_PER_CREDIT,
      ...(surplusBuyerCostMicro === undefined ? {} : { surplusBuyerCostMicro }),
    });
    if (evaluation.kind === "cleanup") {
      const cleared = await clearStalePendingMarkerV3(kv, pendingKey, pendingEntry, gateKey, gateEntry, now);
      if (!cleared) continue;
      return { settled: false, retry_delay_ms: null };
    }
    if (evaluation.kind === "noop" || !request) return { settled: false, retry_delay_ms: null };
    if (evaluation.kind === "defer") return { settled: false, retry_delay_ms: await deferPaidFallbackReconciliationV3(kv, keyId, requestId, now) };
    const spend = evaluation.spend;
    const windowKey = paidFallbackWindowV3Key(keyId, request.window_reset_at_ms);
    const windowEntry = await kv.get<PaidFallbackWindowV3>(windowKey, { consistency: "strong" });
    const rollup = await prepareSettlementRollupV3(kv, request, providerLog, spend, correlation, now);
    const plan = planPaidFallbackSettlementRowsV3(
      { request: requestEntry, pending: pendingEntry, gate: gateEntry, window: windowEntry, rollup: rollup.rollupEntry },
      providerLog,
      spend,
      rollup.foldIntoRollup,
      now
    );
    const settledRow = plan.request;
    if (
      await commitPaidFallbackSettlementV3(kv, { requestKey, pendingKey, windowKey, requestEntry, pendingEntry, gateEntry, windowEntry, plan, rollup, now })
    ) {
      // Best-effort growth instrumentation: the daily counters must never fail
      // a settlement that already committed.
      await recordSettlementGrowthV3(kv, settledRow, rollup, now);
      return { settled: true, retry_delay_ms: null };
    }
  }
  throw new Error("Paid fallback settlement changed concurrently.");
};

export type PaidFallbackUsageSettlementV3 = Readonly<{
  /** Internal direct-settlement key; never exposed as an upstream request ID. */
  settlement_request_id: string;
  provider_quota: number;
  input_tokens: number;
  cached_input_tokens?: number | null;
  output_tokens: number;
  model: string;
  created_at_ms: number;
  /** Surplus-only exact provider amount; quota conversion can round odd microcredits. */
  buyer_cost_micro?: number;
}>;

/**
 * Settles a provider whose response contains authoritative usage instead of
 * exposing the OpenLux token-log endpoint. The same CAS path is used as the
 * asynchronous OpenLux reconciliation, so duplicate terminal observations
 * remain idempotent.
 */
export const settlePaidFallbackUsageV3 = async (reservation: PaidFallbackAdmissionV3, usage: PaidFallbackUsageSettlementV3): Promise<boolean> => {
  const kv = await getKv();
  if (!kv) return false;
  const result = await settlePaidFallbackRequestV3(
    kv,
    reservation.key_id,
    reservation.request_id,
    {
      request_id: usage.settlement_request_id,
      quota: usage.provider_quota,
      prompt_tokens: usage.input_tokens,
      ...(usage.cached_input_tokens === null || usage.cached_input_tokens === undefined ? {} : { cached_prompt_tokens: usage.cached_input_tokens }),
      completion_tokens: usage.output_tokens,
      model: usage.model,
      created_at: Math.max(0, Math.trunc(usage.created_at_ms / 1_000)),
    },
    Date.now(),
    "surplus_reservation",
    usage.buyer_cost_micro
  );
  return result.settled;
};

export {
  _expeditePaidFallbackReconciliationV3,
  acquireReconciliationLease,
  deferPaidFallbackReconciliationV3,
  releaseReconciliationLease,
  settlePaidFallbackRequestV3,
};
