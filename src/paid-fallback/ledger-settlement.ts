import type { AtomicOperation, Kv, KvEntryMaybe, KvKey } from "#kv";
// Paid-fallback ledger v3: settlement layer, split out of src/paid_fallback_ledger.ts.

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
  RETRY_DELAYS_MS,
  UNRESOLVED_AFTER_MS,
  paidFallbackPendingV3Key,
  paidFallbackReconciliationGateDueNow,
  paidFallbackReconciliationGateNeedsArm,
  paidFallbackReconciliationGateV3Key,
  paidFallbackReconciliationLeaseV3Key,
  paidFallbackRequestV3Key,
  paidFallbackWindowV3Key,
  requestRowExpireIn,
  windowExpireIn,
} from "./ledger-state.ts";
import {
  PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS,
  type PaidFallbackUsageRollup,
  isPaidFallbackUsageRollup,
  mergePaidFallbackUsageRollup,
  paidFallbackUsageRollupKey,
  paidFallbackUsageRollupShard,
} from "./rollups.ts";
import { estimatePaidFallbackRecordBytes, recordPaidFallbackLedgerSettlementStats } from "./ledger-stats.ts";
import { type PaidFallbackRequestV3, type PaidFallbackWindowV3 } from "../types.ts";

const acquireReconciliationLease = async (kv: Kv, keyId: string, now: number): Promise<PaidFallbackReconciliationLeaseV3 | null> => {
  const key = paidFallbackReconciliationLeaseV3Key(keyId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<PaidFallbackReconciliationLeaseV3>(key, { consistency: "strong" });
    if (entry.value && entry.value.expires_at_ms > now) return null;
    const lease = {
      token: crypto.randomUUID(),
      expires_at_ms: now + RECONCILIATION_LEASE_MS,
    } satisfies PaidFallbackReconciliationLeaseV3;
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
  if (entry.value?.token !== lease.token) return;
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
    if (!pendingEntry.value) return null;
    const request = requestEntry.value;
    if (!request || request.billing_state === "settled" || request.billing_state === "not_billed") {
      const gateKey = paidFallbackReconciliationGateV3Key();
      const gateEntry = await kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" });
      let cleanup = kv.atomic().check(pendingEntry).delete(pendingKey);
      cleanup = cleanup.check(gateEntry);
      cleanup = cleanup.set(gateKey, paidFallbackReconciliationGateDueNow(gateEntry, now));
      const cleanupResult = await cleanup.commit();
      if (cleanupResult.ok) return null;
      continue;
    }
    const attempts = request.reconciliation_attempts + 1;
    const unresolved = now - request.created_at_ms >= UNRESOLVED_AFTER_MS;
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    const atomic = kv
      .atomic()
      .check(requestEntry)
      .check(pendingEntry)
      .set(
        requestKey,
        {
          ...request,
          reconciliation_attempts: attempts,
          last_reconciliation_at_ms: now,
          billing_state: unresolved ? "unresolved" : request.billing_state,
          updated_at_ms: now,
        },
        { expireIn: requestRowExpireIn(request, now) }
      )
      .set(pendingKey, {
        ...pendingEntry.value,
        next_reconciliation_at_ms: now + delay,
      } satisfies PaidFallbackPendingV3);
    if ((await atomic.commit()).ok) return delay;
  }
  throw new Error("Paid fallback reconciliation deferral changed concurrently.");
};

/**
 * True when this provider log belongs to the request being settled. Surplus
 * usage is delivered synchronously for its own gateway reservation, so it
 * matches on the provider field instead of a fabricated upstream request ID.
 */
const correlationMatchesV3 = (
  request: PaidFallbackRequestV3,
  providerLog: MeteredTokenLogEntry,
  correlation: "provider_request_id" | "surplus_reservation"
): boolean => (correlation === "surplus_reservation" ? request.provider === "surplus" : request.provider_request_id === providerLog.request_id);

/** True when the row still needs settlement; a settled or unbilled row does not. */
const isBillableRequestV3 = (request: PaidFallbackRequestV3 | null): request is PaidFallbackRequestV3 =>
  request !== null && request.billing_state !== "settled" && request.billing_state !== "not_billed";

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

/** The settled request row written by one settlement. */
const buildSettledRequestRowV3 = (
  request: PaidFallbackRequestV3,
  providerLog: MeteredTokenLogEntry,
  spend: number,
  dispatchedAtMs: number,
  foldIntoRollup: boolean,
  now: number
): PaidFallbackRequestV3 => ({
  ...request,
  provider_quota: providerLog.quota,
  input_tokens: providerLog.prompt_tokens,
  cached_input_tokens: providerLog.cached_prompt_tokens ?? null,
  output_tokens: providerLog.completion_tokens,
  dispatch_state: request.dispatch_state === "reserved" ? "dispatched" : request.dispatch_state,
  dispatched_at_ms: dispatchedAtMs,
  spend_microcredits: spend,
  billing_state: "settled",
  // The terminal lifecycle update records the attempt that triggered this
  // lookup. Settlement itself must be replay-idempotent and not inflate
  // the attempt count when a queue delivery is duplicated.
  reconciliation_attempts: request.reconciliation_attempts,
  last_reconciliation_at_ms: now,
  settled_at_ms: request.settled_at_ms ?? now,
  updated_at_ms: now,
  // The settlement write just folded this usage into the hourly rollup;
  // mark it so a later backfill run cannot double-count it.
  ...(foldIntoRollup ? { usage_rollup_at_ms: now } : {}),
});

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
  const model = request.model.trim();
  // Typed as a plain string on purpose: the request row field is a literal
  // union, but the rollup identity below still guards against an empty label
  // so a legacy or hand-written row can never key a rollup on "".
  const provider: string = request.provider ?? (correlation === "surplus_reservation" ? "surplus" : "metered");
  const bucketStartAtMs = Math.floor(request.created_at_ms / PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS) * PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS;
  const rollupKey = paidFallbackUsageRollupKey(bucketStartAtMs, model, provider, paidFallbackUsageRollupShard(request.request_id));
  const rollupEntry = await kv.get<PaidFallbackUsageRollup>(rollupKey, { consistency: "strong" });
  const existingRollup = isPaidFallbackUsageRollup(rollupEntry.value) ? rollupEntry.value : null;
  const nextRollup = mergePaidFallbackUsageRollup(existingRollup, {
    bucket_start_at_ms: bucketStartAtMs,
    request_id: request.request_id,
    model,
    provider,
    quota: providerLog.quota,
    input_tokens: providerLog.prompt_tokens,
    cached_input_tokens: providerLog.cached_prompt_tokens ?? null,
    output_tokens: providerLog.completion_tokens,
    spend_microcredits: spend,
    request_created_at_ms: request.created_at_ms,
    updated_at_ms: now,
  });
  return { rollupKey, rollupEntry, nextRollup, foldIntoRollup: model !== "" && provider !== "" };
};

/** Applies a settlement to the window row when the window row exists. */
const applySettlementWindowUpdateV3 = (
  atomic: AtomicOperation,
  windowEntry: KvEntryMaybe<PaidFallbackWindowV3>,
  windowKey: KvKey,
  request: PaidFallbackRequestV3,
  spend: number,
  now: number
): AtomicOperation => {
  const window = windowEntry.value;
  if (!window) return atomic;
  return atomic.check(windowEntry).set(
    windowKey,
    {
      ...window,
      settled_microcredits: window.settled_microcredits + spend,
      reserved_microcredits: Math.max(0, window.reserved_microcredits - request.reserved_microcredits),
      pending_count: Math.max(0, window.pending_count - 1),
      updated_at_ms: now,
    },
    { expireIn: windowExpireIn(window, now) }
  );
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

const settlementSpendMicrocredits = (
  providerQuota: number,
  quotaPerCredit: number,
  correlation: "provider_request_id" | "surplus_reservation",
  surplusBuyerCostMicro?: number
): number => {
  if (correlation === "surplus_reservation" && surplusBuyerCostMicro !== undefined) return surplusBuyerCostMicro;
  return Math.round((providerQuota * MICROCREDITS_PER_CREDIT) / quotaPerCredit);
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
    if (!isBillableRequestV3(request)) {
      const cleared = await clearStalePendingMarkerV3(kv, pendingKey, pendingEntry, gateKey, gateEntry, now);
      if (!cleared) continue;
      return { settled: false, retry_delay_ms: null };
    }
    // Surplus usage is delivered synchronously for this exact gateway
    // reservation. It does not need a fabricated upstream request ID; the
    // provider field prevents this direct path from settling a Metered row.
    if (!pendingEntry.value || !correlationMatchesV3(request, providerLog, correlation)) {
      return { settled: false, retry_delay_ms: null };
    }
    const calculatedSpend = settlementSpendMicrocredits(providerLog.quota, request.quota_per_credit, correlation, surplusBuyerCostMicro);
    if (!Number.isSafeInteger(calculatedSpend) || calculatedSpend < 0) {
      return {
        settled: false,
        retry_delay_ms: await deferPaidFallbackReconciliationV3(kv, keyId, requestId, now),
      };
    }
    // A provider can report more usage than the exposure admitted for this
    // request. Preserve the actual provider spend so the window cannot
    // under-report billed usage; the admission exposure only bounds the
    // amount we risk before the provider responds.
    const spend = calculatedSpend;
    const windowKey = paidFallbackWindowV3Key(keyId, request.window_reset_at_ms);
    const windowEntry = await kv.get<PaidFallbackWindowV3>(windowKey, { consistency: "strong" });
    const dispatchedAtMs = request.dispatched_at_ms ?? Math.max(request.created_at_ms, providerLog.created_at * 1_000);
    const rollup = await prepareSettlementRollupV3(kv, request, providerLog, spend, correlation, now);
    const settledRow = buildSettledRequestRowV3(request, providerLog, spend, dispatchedAtMs, rollup.foldIntoRollup, now);
    let atomic = kv
      .atomic()
      .check(requestEntry)
      .check(pendingEntry)
      .set(requestKey, settledRow, {
        expireIn: requestRowExpireIn(request, now),
      })
      .delete(pendingKey);
    if (rollup.foldIntoRollup) {
      atomic = atomic.check(rollup.rollupEntry).set(rollup.rollupKey, rollup.nextRollup);
    }
    atomic = atomic.check(gateEntry);
    // Settlement removes billable work. Keep the gate due and version it so a
    // concurrent recompute cannot resurrect this marker's stale future time.
    atomic = atomic.set(gateKey, paidFallbackReconciliationGateDueNow(gateEntry, now));
    atomic = applySettlementWindowUpdateV3(atomic, windowEntry, windowKey, request, spend, now);
    if ((await atomic.commit()).ok) {
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
  isBillableRequestV3,
  releaseReconciliationLease,
  settlePaidFallbackRequestV3,
};
