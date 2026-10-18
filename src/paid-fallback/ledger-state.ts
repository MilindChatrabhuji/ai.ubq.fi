import type { Kv, KvEntry, KvKey } from "#kv";
import { getKv } from "../kv.ts";
import type { PaidFallbackProvider, PaidFallbackProviderUsageV3, PaidFallbackRequestV3, PaidFallbackWindowV3 } from "../types.ts";
import {
  MAX_CAS_ATTEMPTS,
  PAID_FALLBACK_AUTOMATIC_BACKFILL_LIMIT,
  PAID_FALLBACK_BACKFILL_LEASE_MS,
  RECONCILIATION_LEASE_MS,
  RETRY_DELAYS_MS,
  UNRESOLVED_AFTER_MS,
  PAID_FALLBACK_REQUEST_LOG_RETENTION_MS,
  requestRowExpireIn,
  windowExpireIn,
  isPositiveSafeInteger,
  isPaidFallbackWindowV3,
  paidFallbackWindowV3Key,
  paidFallbackRequestV3Key,
  paidFallbackPendingV3Key,
  paidFallbackWindowV3Prefix,
  paidFallbackRequestV3Prefix,
  paidFallbackRequestV3GlobalPrefix,
  paidFallbackWindowV3GlobalPrefix,
  paidFallbackPendingV3Prefix,
  paidFallbackPendingV3GlobalPrefix,
  paidFallbackReconciliationGateV3Key,
  paidFallbackReconciliationLeaseV3Key,
  paidFallbackBackfillCursorV3Key,
  paidFallbackBackfillWindowCursorV3Key,
  paidFallbackBackfillLeaseV3Key,
  paidFallbackBackfillStateV3Key,
  paidFallbackDeletionGuardV3Key,
  isPaidFallbackReconciliationGate,
  paidFallbackReconciliationGateDueNow,
  paidFallbackReconciliationGateNeedsArm,
  planPaidFallbackGateAfterScanV3,
} from "../authority/native-paid.ts";
import type {
  NativePaidAdmissionInput,
  PaidFallbackAdmissionV3,
  PaidFallbackWindowProjectionV3,
  PaidFallbackOutstandingV3,
  PaidFallbackPendingV3,
  PaidFallbackReconciliationGateV3,
  PaidFallbackReconciliationLeaseV3,
  PaidFallbackBackfillLeaseV3,
  PaidFallbackBackfillStateV3,
  PaidFallbackDeletionGuardV3,
} from "../authority/native-paid-contracts.ts";
export {
  PAID_FALLBACK_REQUEST_LOG_RETENTION_MS,
  requestRowExpireIn,
  isPaidFallbackWindowV3,
  paidFallbackWindowV3Key,
  paidFallbackRequestV3Key,
  paidFallbackPendingV3Key,
  paidFallbackRequestV3GlobalPrefix,
  paidFallbackReconciliationGateV3Key,
  paidFallbackReconciliationLeaseV3Key,
  paidFallbackBackfillCursorV3Key,
  paidFallbackBackfillWindowCursorV3Key,
  paidFallbackBackfillLeaseV3Key,
  paidFallbackBackfillStateV3Key,
  paidFallbackDeletionGuardV3Key,
};
export type { PaidFallbackAdmissionV3, PaidFallbackWindowProjectionV3, PaidFallbackOutstandingV3, PaidFallbackReconciliationGateV3 };
type PaidFallbackReconciliationJobV3 = Readonly<{ key_id: string }>;
type AdmissionInput = NativePaidAdmissionInput &
  Readonly<{
    // Native routing owns the immutable authenticated H-row key and revision.
    policyCheck?: Readonly<{ key: KvKey; versionstamp: string | null }>;
  }>;
const resolveKv = async (kvOverride: Kv | null | undefined): Promise<Kv | null> => (kvOverride === undefined ? await getKv() : kvOverride);

type PendingMarkerScan = Readonly<{
  entries: readonly KvEntry<PaidFallbackPendingV3>[];
  earliest_due_at_ms: number | null;
}>;

const scanPaidFallbackPendingMarkers = async (kv: Kv): Promise<PendingMarkerScan> => {
  const entries: KvEntry<PaidFallbackPendingV3>[] = [];
  let earliestDueAtMs: number | null = null;
  for await (const entry of kv.list<PaidFallbackPendingV3>({ prefix: paidFallbackPendingV3GlobalPrefix }, { consistency: "strong" })) {
    entries.push(entry);
    const dueAtMs = entry.value.next_reconciliation_at_ms;
    if (!Number.isSafeInteger(dueAtMs) || dueAtMs < 0) continue;
    if (earliestDueAtMs === null || dueAtMs < earliestDueAtMs) earliestDueAtMs = dueAtMs;
  }
  return { entries, earliest_due_at_ms: earliestDueAtMs };
};

export const recomputePaidFallbackReconciliationGateV3 = async (kv: Kv): Promise<number | null> => {
  const gateKey = paidFallbackReconciliationGateV3Key();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const gateEntry = await kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" });
    const scan = await scanPaidFallbackPendingMarkers(kv);
    const plan = planPaidFallbackGateAfterScanV3(gateEntry, scan.earliest_due_at_ms);
    const commit = await kv.atomic().check(gateEntry).set(gateKey, plan.gate).commit();
    if (commit.ok) return scan.earliest_due_at_ms;
  }
  throw new Error("Paid fallback reconciliation gate changed concurrently.");
};

const queueOptions = {
  delay: 0,
  backoffSchedule: [5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000],
} as const;

const enqueuePaidFallbackReconciliationJob = async (kv: Kv, keyId: string, delay = 0): Promise<boolean> => {
  const enqueue = (
    kv as unknown as {
      enqueue?: (message: PaidFallbackReconciliationJobV3, options?: unknown) => Promise<unknown>;
    }
  ).enqueue;
  if (typeof enqueue !== "function") return false;
  try {
    await enqueue.call(kv, { key_id: keyId }, { ...queueOptions, delay });
    return true;
  } catch {
    // The pending marker and its backoff are durable. Cron can enqueue the key
    // again when a transient queue outage has recovered.
    return false;
  }
};

export const listPaidFallbackRequestsV3 = async (keyId: string, limit = 100, kvOverride?: Kv | null): Promise<readonly PaidFallbackRequestV3[]> => {
  const kv = await resolveKv(kvOverride);
  if (!kv || !Number.isFinite(limit) || limit <= 0) return [];
  const requests: PaidFallbackRequestV3[] = [];
  for await (const entry of kv.list<PaidFallbackRequestV3>({ prefix: paidFallbackRequestV3Prefix(keyId) }, { consistency: "strong" })) {
    requests.push(entry.value);
  }
  requests.sort((left, right) => right.created_at_ms - left.created_at_ms || right.request_id.localeCompare(left.request_id));
  return requests.slice(0, Math.min(1_000, Math.trunc(limit)));
};

const emptyPaidFallbackProviderUsage = (): PaidFallbackProviderUsageV3 => ({
  request_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  spend_microcredits: 0,
});

/**
 * Returns current-window usage split by the actual paid provider. The shared
 * admission window remains provider-neutral; this projection is only an
 * operator view and does not affect quota decisions.
 */
export const getPaidFallbackProviderUsageV3 = async (
  keyId: string,
  windowResetAtMs: number,
  kvOverride?: Kv | null
): Promise<Readonly<Record<PaidFallbackProvider, PaidFallbackProviderUsageV3>>> => {
  const kv = await resolveKv(kvOverride);
  const usage: Record<PaidFallbackProvider, PaidFallbackProviderUsageV3> = {
    metered: emptyPaidFallbackProviderUsage(),
    surplus: emptyPaidFallbackProviderUsage(),
  };
  if (!kv) return usage;
  // Request keys do not include the window reset, so scan the complete key
  // history and filter by the requested window instead of truncating at the
  // newest 1,000 rows.
  for await (const entry of kv.list<PaidFallbackRequestV3>({ prefix: paidFallbackRequestV3Prefix(keyId) }, { consistency: "strong" })) {
    const request = entry.value;
    if (request.window_reset_at_ms !== windowResetAtMs) continue;
    const provider: PaidFallbackProvider = request.provider === "surplus" ? "surplus" : "metered";
    const current = usage[provider];
    const inputTokens = request.input_tokens ?? 0;
    const outputTokens = request.output_tokens ?? 0;
    usage[provider] = {
      request_count: current.request_count + 1,
      input_tokens: current.input_tokens + inputTokens,
      output_tokens: current.output_tokens + outputTokens,
      total_tokens: current.total_tokens + inputTokens + outputTokens,
      spend_microcredits: current.spend_microcredits + (request.billing_state === "settled" ? (request.spend_microcredits ?? 0) : 0),
    };
  }
  return usage;
};

export const getPaidFallbackWindowProjectionV3 = async (
  keyId: string,
  windowResetAtMs: number,
  limitMicrocredits: number,
  kvOverride?: Kv | null
): Promise<PaidFallbackWindowProjectionV3 | null> => {
  const kv = await resolveKv(kvOverride);
  if (!kv) return null;
  const window = await kv.get<PaidFallbackWindowV3>(paidFallbackWindowV3Key(keyId, windowResetAtMs), { consistency: "strong" });
  if (window.value) {
    return {
      key_id: keyId,
      policy_version: window.value.policy_version,
      window_reset_at_ms: windowResetAtMs,
      limit_microcredits: limitMicrocredits,
      settled_microcredits: window.value.settled_microcredits,
      reserved_microcredits: window.value.reserved_microcredits,
      pending_count: window.value.pending_count,
      updated_at_ms: window.value.updated_at_ms,
    };
  }

  let policyVersion: string | null = null;
  let settledMicrocredits = 0;
  let reservedMicrocredits = 0;
  let pendingCount = 0;
  let updatedAtMs: number | null = null;
  for await (const entry of kv.list<PaidFallbackRequestV3>({ prefix: paidFallbackRequestV3Prefix(keyId) }, { consistency: "strong" })) {
    const request = entry.value;
    if (request.window_reset_at_ms !== windowResetAtMs) continue;
    if (request.billing_state === "settled") {
      settledMicrocredits += request.spend_microcredits ?? 0;
    } else if (request.billing_state === "pending" || request.billing_state === "unresolved") {
      reservedMicrocredits += request.reserved_microcredits;
      pendingCount += 1;
    }
    if (updatedAtMs === null || request.updated_at_ms > updatedAtMs) {
      updatedAtMs = request.updated_at_ms;
      policyVersion = request.policy_version;
    }
  }
  return {
    key_id: keyId,
    policy_version: policyVersion,
    window_reset_at_ms: windowResetAtMs,
    limit_microcredits: limitMicrocredits,
    settled_microcredits: settledMicrocredits,
    reserved_microcredits: reservedMicrocredits,
    pending_count: pendingCount,
    updated_at_ms: updatedAtMs,
  };
};

export const getPaidFallbackOutstandingV3 = async (keyId: string, kvOverride?: Kv | null): Promise<PaidFallbackOutstandingV3 | null> => {
  const kv = await resolveKv(kvOverride);
  if (!kv) return null;
  let pendingRequests = 0;
  let unresolvedRequests = 0;
  for await (const entry of kv.list<PaidFallbackRequestV3>({ prefix: paidFallbackRequestV3Prefix(keyId) }, { consistency: "strong" })) {
    if (entry.value.billing_state === "pending") pendingRequests += 1;
    if (entry.value.billing_state === "unresolved") unresolvedRequests += 1;
  }
  const pendingMarkerKeys: KvKey[] = [];
  for await (const entry of kv.list<PaidFallbackPendingV3>({ prefix: paidFallbackPendingV3Prefix(keyId) }, { consistency: "strong" })) {
    pendingMarkerKeys.push(entry.key);
  }
  const pendingMarkers = pendingMarkerKeys.length;
  return {
    pending_requests: pendingRequests,
    unresolved_requests: unresolvedRequests,
    pending_markers: pendingMarkers,
    has_outstanding: pendingRequests > 0 || unresolvedRequests > 0 || pendingMarkers > 0,
  };
};

export {
  MAX_CAS_ATTEMPTS,
  PAID_FALLBACK_AUTOMATIC_BACKFILL_LIMIT,
  PAID_FALLBACK_BACKFILL_LEASE_MS,
  RECONCILIATION_LEASE_MS,
  RETRY_DELAYS_MS,
  UNRESOLVED_AFTER_MS,
  enqueuePaidFallbackReconciliationJob,
  isPaidFallbackReconciliationGate,
  isPositiveSafeInteger,
  paidFallbackPendingV3GlobalPrefix,
  paidFallbackPendingV3Prefix,
  paidFallbackReconciliationGateDueNow,
  paidFallbackReconciliationGateNeedsArm,
  paidFallbackRequestV3Prefix,
  paidFallbackWindowV3GlobalPrefix,
  paidFallbackWindowV3Prefix,
  resolveKv,
  scanPaidFallbackPendingMarkers,
  windowExpireIn,
};
export type {
  AdmissionInput,
  PaidFallbackBackfillLeaseV3,
  PaidFallbackBackfillStateV3,
  PaidFallbackDeletionGuardV3,
  PaidFallbackPendingV3,
  PaidFallbackReconciliationLeaseV3,
  PendingMarkerScan,
};
