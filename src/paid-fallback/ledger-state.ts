import type { Kv, KvEntry, KvEntryMaybe, KvKey } from "#kv";
// Paid-fallback ledger v3: state layer, split out of src/paid_fallback_ledger.ts.

import { getKv } from "../kv.ts";
import { type PaidFallbackProvider, type PaidFallbackProviderUsageV3, type PaidFallbackRequestV3, type PaidFallbackWindowV3 } from "../types.ts";
import { isRecord } from "../utils.ts";

const PREFIX = ["uos_ai", "paid_fallback", "v3"] as const;
const MAX_CAS_ATTEMPTS = 128;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
const UNRESOLVED_AFTER_MS = 24 * 60 * 60_000;
const RECONCILIATION_LEASE_MS = 60_000;
const PAID_FALLBACK_BACKFILL_LEASE_MS = 5 * 60_000;
const PAID_FALLBACK_AUTOMATIC_BACKFILL_LIMIT = 5_000;

/**
 * Raw paid-fallback request rows are retained for one year from request
 * creation, then expire. Research that needs older data reads the compact
 * per-hour usage rollups (paid_fallback_rollups.ts), which never expire.
 */
export const PAID_FALLBACK_REQUEST_LOG_RETENTION_MS = 365 * 24 * 60 * 60_000;

export const requestRowExpireIn = (row: PaidFallbackRequestV3, nowMs: number): number =>
  Math.max(1, row.created_at_ms + PAID_FALLBACK_REQUEST_LOG_RETENTION_MS - nowMs);

const isSafeUsageCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isApiKeyId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

/**
 * Window rows expire one year after their reset so they never outlive the
 * request rows that validate them; the per-request detail is gone by then.
 */
const windowExpireIn = (window: PaidFallbackWindowV3, nowMs: number): number =>
  Math.max(1, window.window_reset_at_ms + PAID_FALLBACK_REQUEST_LOG_RETENTION_MS - nowMs);

export const isPaidFallbackWindowV3 = (value: unknown): value is PaidFallbackWindowV3 => {
  if (!isRecord(value)) return false;
  return (
    value.v === 3 &&
    isApiKeyId(value.key_id) &&
    typeof value.policy_version === "string" &&
    value.policy_version.length > 0 &&
    isPositiveSafeInteger(value.window_reset_at_ms) &&
    (value.limit_microcredits === -1 || isPositiveSafeInteger(value.limit_microcredits)) &&
    isSafeUsageCount(value.settled_microcredits) &&
    isSafeUsageCount(value.reserved_microcredits) &&
    isSafeUsageCount(value.pending_count) &&
    isPositiveSafeInteger(value.updated_at_ms)
  );
};

export const paidFallbackWindowV3Key = (keyId: string, resetAtMs: number): KvKey => [...PREFIX, "window", keyId, resetAtMs];
export const paidFallbackRequestV3Key = (keyId: string, requestId: string): KvKey => [...PREFIX, "request", keyId, requestId];
export const paidFallbackPendingV3Key = (keyId: string, requestId: string): KvKey => [...PREFIX, "pending", keyId, requestId];
const paidFallbackWindowV3Prefix = (keyId: string): KvKey => [...PREFIX, "window", keyId];
const paidFallbackRequestV3Prefix = (keyId: string): KvKey => [...PREFIX, "request", keyId];
export const paidFallbackRequestV3GlobalPrefix: KvKey = [...PREFIX, "request"];
const paidFallbackWindowV3GlobalPrefix: KvKey = [...PREFIX, "window"];
const paidFallbackPendingV3Prefix = (keyId: string): KvKey => [...PREFIX, "pending", keyId];
const paidFallbackPendingV3GlobalPrefix: KvKey = [...PREFIX, "pending"];
export const paidFallbackReconciliationGateV3Key = (): KvKey => [...PREFIX, "reconciliation_gate"];
export const paidFallbackReconciliationLeaseV3Key = (keyId: string): KvKey => [...PREFIX, "reconciliation_lease", keyId];
export const paidFallbackBackfillCursorV3Key = (): KvKey => [...PREFIX, "rollup_backfill_cursor"];
export const paidFallbackBackfillWindowCursorV3Key = (): KvKey => [...PREFIX, "rollup_backfill_window_cursor"];
export const paidFallbackBackfillLeaseV3Key = (): KvKey => [...PREFIX, "rollup_backfill_lease"];
export const paidFallbackBackfillStateV3Key = (): KvKey => [...PREFIX, "rollup_backfill_state"];
export const paidFallbackDeletionGuardV3Key = (keyId: string): KvKey => [...PREFIX, "deletion_guard", keyId];

type PaidFallbackPendingV3 = Readonly<{
  created_at_ms: number;
  next_reconciliation_at_ms: number;
}>;

export type PaidFallbackReconciliationGateV3 = Readonly<{
  next_due_at_ms: number | null;
}>;

type PaidFallbackReconciliationJobV3 = Readonly<{
  key_id: string;
}>;

type PaidFallbackReconciliationLeaseV3 = Readonly<{
  token: string;
  expires_at_ms: number;
}>;

type PaidFallbackBackfillLeaseV3 = Readonly<{
  token: string;
  expires_at_ms: number;
}>;

type PaidFallbackBackfillStateV3 = Readonly<{
  v: 1;
  completed_at_ms: number;
}>;

type PaidFallbackDeletionGuardV3 = Readonly<{
  created_at_ms: number;
}>;

export type PaidFallbackAdmissionV3 = Readonly<{
  key_id: string;
  request_id: string;
  created_at_ms: number;
  reserved_microcredits: number;
  quota_per_credit: number;
  window_reset_at_ms: number;
  quota_used_percent: number | null;
}>;

export type PaidFallbackWindowProjectionV3 = Readonly<{
  key_id: string;
  policy_version: string | null;
  window_reset_at_ms: number;
  limit_microcredits: number;
  settled_microcredits: number;
  reserved_microcredits: number;
  pending_count: number;
  updated_at_ms: number | null;
}>;

export type PaidFallbackOutstandingV3 = Readonly<{
  pending_requests: number;
  unresolved_requests: number;
  pending_markers: number;
  has_outstanding: boolean;
}>;

type AdmissionInput = Readonly<{
  keyId: string;
  requestId: string;
  createdAtMs: number;
  policyVersion: string;
  limitMicrocredits: number;
  maximumExposureMicrocredits: number | null;
  initialSettledMicrocredits: number;
  quotaPerCredit: number;
  windowResetAtMs: number;
  model: string;
  route: string;
  path: string;
  stream: boolean;
  reasoning: string | null;
  dispatchIntent?: boolean;
  // Present for real gateway admissions. It fences the immutable API-key
  // policy snapshot that authorized paid exposure; direct ledger tests may
  // omit it because they do not represent an API-key admission path.
  policyCheck?: Readonly<{ key: KvKey; versionstamp: string | null }>;
}>;

const resolveKv = async (kvOverride: Kv | null | undefined): Promise<Kv | null> => (kvOverride === undefined ? await getKv() : kvOverride);

const isPaidFallbackReconciliationGate = (value: unknown): value is PaidFallbackReconciliationGateV3 =>
  value !== null &&
  typeof value === "object" &&
  "next_due_at_ms" in value &&
  (value.next_due_at_ms === null || (typeof value.next_due_at_ms === "number" && Number.isSafeInteger(value.next_due_at_ms) && value.next_due_at_ms >= 0));

const paidFallbackReconciliationGateDueNow = (entry: KvEntryMaybe<PaidFallbackReconciliationGateV3>, now: number): PaidFallbackReconciliationGateV3 => {
  const current = isPaidFallbackReconciliationGate(entry.value) ? entry.value.next_due_at_ms : null;
  return { next_due_at_ms: current === null ? now : Math.min(current, now) };
};

const paidFallbackReconciliationGateNeedsArm = (entry: KvEntryMaybe<PaidFallbackReconciliationGateV3>, now: number): boolean => {
  if (!isPaidFallbackReconciliationGate(entry.value)) return true;
  return entry.value.next_due_at_ms === null || entry.value.next_due_at_ms > now;
};

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
    const commit = await kv
      .atomic()
      .check(gateEntry)
      .set(gateKey, { next_due_at_ms: scan.earliest_due_at_ms } satisfies PaidFallbackReconciliationGateV3)
      .commit();
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
