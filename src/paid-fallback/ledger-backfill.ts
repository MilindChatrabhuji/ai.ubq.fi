import type { Kv, KvEntry, KvEntryMaybe, KvKey, KvListSelector } from "#kv";
// Paid-fallback ledger v3: backfill layer, split out of src/paid_fallback_ledger.ts.

import { type MeteredTokenLogEntry, fetchMeteredTokenLogs } from "../provider/metered.ts";
import { updatePaidFallbackRequestV3 } from "./ledger-admission.ts";
import {
  _expeditePaidFallbackReconciliationV3,
  acquireReconciliationLease,
  deferPaidFallbackReconciliationV3,
  releaseReconciliationLease,
  settlePaidFallbackRequestV3,
} from "./ledger-settlement.ts";
import {
  MAX_CAS_ATTEMPTS,
  PAID_FALLBACK_AUTOMATIC_BACKFILL_LIMIT,
  PAID_FALLBACK_BACKFILL_LEASE_MS,
  type PaidFallbackAdmissionV3,
  type PaidFallbackBackfillLeaseV3,
  type PaidFallbackBackfillStateV3,
  type PaidFallbackPendingV3,
  type PaidFallbackReconciliationGateV3,
  type PendingMarkerScan,
  enqueuePaidFallbackReconciliationJob,
  isPaidFallbackReconciliationGate,
  isPaidFallbackWindowV3,
  paidFallbackBackfillCursorV3Key,
  paidFallbackBackfillLeaseV3Key,
  paidFallbackBackfillStateV3Key,
  paidFallbackBackfillWindowCursorV3Key,
  paidFallbackPendingV3GlobalPrefix,
  paidFallbackPendingV3Prefix,
  paidFallbackReconciliationGateDueNow,
  paidFallbackReconciliationGateV3Key,
  paidFallbackRequestV3GlobalPrefix,
  paidFallbackRequestV3Key,
  paidFallbackWindowV3GlobalPrefix,
  recomputePaidFallbackReconciliationGateV3,
  requestRowExpireIn,
  resolveKv,
  scanPaidFallbackPendingMarkers,
  windowExpireIn,
} from "./ledger-state.ts";
import {
  PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS,
  PAID_FALLBACK_USAGE_ROLLUP_PREFIX,
  type PaidFallbackUsageRollup,
  isPaidFallbackUsageRollup,
  mergePaidFallbackUsageRollup,
  paidFallbackUsageRollupKey,
  paidFallbackUsageRollupShard,
} from "./rollups.ts";
import { type PaidFallbackProvider, type PaidFallbackRequestV3, type PaidFallbackWindowV3 } from "../types.ts";
import { isRecord } from "../utils.ts";

export type PaidFallbackRollupBackfillResult = Readonly<{
  scanned: number;
  /** Rows this run applied (TTL rewrite and/or rollup merge) successfully. */
  processed: number;
  rollups_written: number;
  /**
   * Rows whose CAS commit failed (for example a live settlement updated the
   * same shard in between). The cursor is kept before them so a re-run
   * retries instead of losing the history.
   */
  failed: number;
  /** True when the scan stopped at `limit` rows and a further run is needed. */
  truncated: boolean;
}>;

/**
 * One-time backfill that folds already-settled V3 rows into usage rollups and
 * applies the one-year raw-row TTL to pre-existing rows.
 *
 * Rollups are new with this feature: rows settled before deployment never
 * passed through the settlement hook, so without this pass the admin
 * projection would silently start from an empty history. It also fixes rows
 * that predate the TTL, because every request-row write now re-applies an
 * anchored expiry and these rows will not be rewritten by normal traffic.
 *
 * Idempotency: rows carry `usage_rollup_at_ms` set by the settlement write for
 * new traffic and by this backfill for historical rows, so a run can never
 * double-count usage already folded into a rollup. Run with a `limit` and
 * re-run until `truncated` is false; a persisted cursor resumes the next run
 * at the last committed row (the list `start` is inclusive) so repeated
 * batches stay O(remaining) rather than re-walking every already-processed
 * row. The walk itself is also scan-bounded so an invocation cannot exceed
 * its deadline without persisting forward progress.
 */
/** Persists the last committed row so the next run resumes before the stalled one. */
const persistResumeBeforeRowV3 = async (kv: Kv, cursorKey: KvKey, lastVisitedKey: KvKey | null, resumeKey: KvKey | null): Promise<void> => {
  const cursorKeyValue = lastVisitedKey ?? resumeKey;
  if (cursorKeyValue !== null) await persistBackfillCursorV3(kv, cursorKey, cursorKeyValue);
};

/** Re-applies the anchored retention TTL to a row that was already folded. */
const rewriteMarkedRequestRowTtlV3 = async (
  kv: Kv,
  requestKey: KvKey,
  requestEntry: KvEntryMaybe<PaidFallbackRequestV3>,
  request: PaidFallbackRequestV3,
  nowMs: number
): Promise<boolean> => {
  try {
    const committed = await kv
      .atomic()
      .check(requestEntry)
      .set(requestKey, request, { expireIn: requestRowExpireIn(request, nowMs) })
      .commit();
    return committed.ok;
  } catch {
    return false;
  }
};

/** Outcome of folding one request row into its usage rollup. */
type RollupFoldOutcome = "processed" | "rollup_written" | "failed";

/**
 * Marks one request row as backfilled and, when it is a settled billable row,
 * folds its usage into the matching hourly rollup.
 */
const foldRequestRowIntoRollupV3 = async (
  kv: Kv,
  requestKey: KvKey,
  requestEntry: KvEntryMaybe<PaidFallbackRequestV3>,
  request: PaidFallbackRequestV3,
  nowMs: number
): Promise<RollupFoldOutcome> => {
  const settled = request.billing_state === "settled" && request.provider_quota !== null && request.spend_microcredits !== null;
  const model = request.model.trim();
  const provider = request.provider ?? "metered";
  const bucketStartAtMs = Math.floor(request.created_at_ms / PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS) * PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS;
  const rollupKey = paidFallbackUsageRollupKey(bucketStartAtMs, model, provider, paidFallbackUsageRollupShard(request.request_id));
  const rollupEntry = settled && model ? await kv.get<PaidFallbackUsageRollup>(rollupKey, { consistency: "strong" }) : null;
  const existingRollup = isPaidFallbackUsageRollup(rollupEntry?.value) ? rollupEntry.value : null;
  const nextRollup =
    settled && model
      ? mergePaidFallbackUsageRollup(existingRollup, {
          bucket_start_at_ms: bucketStartAtMs,
          request_id: request.request_id,
          model,
          provider,
          quota: request.provider_quota,
          input_tokens: request.input_tokens ?? 0,
          cached_input_tokens: request.cached_input_tokens ?? null,
          output_tokens: request.output_tokens ?? 0,
          spend_microcredits: request.spend_microcredits,
          request_created_at_ms: request.created_at_ms,
          updated_at_ms: nowMs,
        })
      : null;
  // Every processed row is marked, including non-billable rows, so a bounded
  // run always advances past them instead of consuming its budget on the same
  // rows forever. This is safe for pending/unresolved rows: the live
  // settlement path unconditionally folds and re-marks a row whenever it
  // actually settles, so marking one early can never suppress a rollup.
  const nextRow = { ...request, updated_at_ms: nowMs, usage_rollup_at_ms: nowMs };
  let atomic = kv
    .atomic()
    .check(requestEntry)
    .set(requestKey, nextRow, {
      expireIn: requestRowExpireIn(request, nowMs),
    });
  if (nextRollup && rollupEntry) {
    atomic = atomic.check(rollupEntry).set(rollupKey, nextRollup);
  }
  if (!(await atomic.commit()).ok) {
    // A concurrent writer touched this row or its rollup shard. Stop the
    // sweep immediately so the persisted cursor stays before this row: a
    // later success must never let the cursor skip a missing rollup.
    return "failed";
  }
  return nextRollup ? "rollup_written" : "processed";
};

/** Where the sweep stopped, and which cursor fallback that stop needs. */
type RollupBackfillTruncation = "scan_budget" | "write_budget" | null;

type RollupBackfillSweep = Readonly<{
  scanned: number;
  processed: number;
  rollupsWritten: number;
  failed: number;
  lastVisitedKey: KvKey | null;
  truncatedWith: RollupBackfillTruncation;
}>;

/** Mutable counters for one bounded sweep. */
type BackfillProgress = {
  scanned: number;
  processed: number;
  rollupsWritten: number;
  failed: number;
  budget: number;
  scanRemaining: number;
  lastVisitedKey: KvKey | null;
};

/**
 * Applies one row of the sweep to the progress counters. Returns where the
 * sweep must stop, or `"continue"` when the walk may go on.
 */
const advanceBackfillSweepV3 = async (kv: Kv, requestKey: KvKey, progress: BackfillProgress, nowMs: number): Promise<"continue" | RollupBackfillTruncation> => {
  const requestEntry = await kv.get<PaidFallbackRequestV3>(requestKey, { consistency: "strong" });
  const request = requestEntry.value;
  if (!request) return "continue";
  if (typeof request.usage_rollup_at_ms === "number") {
    // A previously processed row can lose its TTL (for example after a KV
    // export/import restores values without expiry). Re-apply the anchored
    // retention without touching the rollup or the row value; marked rows
    // never consume the run budget.
    const rewritten = await rewriteMarkedRequestRowTtlV3(kv, requestKey, requestEntry, request, nowMs);
    if (!rewritten) {
      progress.failed += 1;
      return "write_budget";
    }
    progress.lastVisitedKey = requestKey;
    return "continue";
  }
  if (progress.budget <= 0) return "write_budget";
  progress.budget -= 1;
  const outcome = await foldRequestRowIntoRollupV3(kv, requestKey, requestEntry, request, nowMs);
  if (outcome === "failed") {
    progress.failed += 1;
    return "write_budget";
  }
  progress.lastVisitedKey = requestKey;
  progress.processed += 1;
  if (outcome === "rollup_written") progress.rollupsWritten += 1;
  return "continue";
};

/** One bounded sweep of the request-row prefix. */
const sweepPaidFallbackUsageRollupsV3 = async (
  kv: Kv,
  resumeKey: KvKey | null,
  limit: number,
  scanBudget: number,
  nowMs: number
): Promise<RollupBackfillSweep> => {
  const progress: BackfillProgress = { scanned: 0, processed: 0, rollupsWritten: 0, failed: 0, budget: limit, scanRemaining: scanBudget, lastVisitedKey: null };
  const selector: KvListSelector =
    resumeKey === null ? { prefix: paidFallbackRequestV3GlobalPrefix } : { prefix: paidFallbackRequestV3GlobalPrefix, start: resumeKey };
  for await (const entry of kv.list<PaidFallbackRequestV3>(selector)) {
    progress.scanned += 1;
    if (progress.scanRemaining <= 0) return toRollupBackfillSweepV3(progress, "scan_budget");
    progress.scanRemaining -= 1;
    const step = await advanceBackfillSweepV3(kv, entry.key, progress, nowMs);
    if (step === "continue") continue;
    return toRollupBackfillSweepV3(progress, step);
  }
  return toRollupBackfillSweepV3(progress, progress.failed > 0 ? "write_budget" : null);
};

/** Freezes the sweep counters into a result. */
const toRollupBackfillSweepV3 = (progress: BackfillProgress, truncatedWith: RollupBackfillTruncation): RollupBackfillSweep => ({
  scanned: progress.scanned,
  processed: progress.processed,
  rollupsWritten: progress.rollupsWritten,
  failed: progress.failed,
  lastVisitedKey: progress.lastVisitedKey,
  truncatedWith,
});

/**
 * One-time backfill that folds already-settled V3 rows into usage rollups and
 * applies the one-year raw-row TTL to pre-existing rows.
 *
 * Rollups are new with this feature: rows settled before deployment never
 * passed through the settlement hook, so without this pass the admin
 * projection would silently start from an empty history. It also fixes rows
 * that predate the TTL, because every request-row write now re-applies an
 * anchored expiry and these rows will not be rewritten by normal traffic.
 *
 * Idempotency: rows carry `usage_rollup_at_ms` set by the settlement write for
 * new traffic and by this backfill for historical rows, so a run can never
 * double-count usage already folded into a rollup. Run with a `limit` and
 * re-run until `truncated` is false; a persisted cursor resumes the next run
 * at the last committed row (the list `start` is inclusive) so repeated
 * batches stay O(remaining) rather than re-walking every already-processed
 * row. The walk itself is also scan-bounded so an invocation cannot exceed
 * its deadline without persisting forward progress.
 */
export const backfillPaidFallbackUsageRollups = async (
  kv: Kv,
  options: Readonly<{ limit?: number; nowMs?: number }> = {}
): Promise<PaidFallbackRollupBackfillResult> => {
  const limit = Math.max(1, Math.min(10_000, Math.trunc(options.limit ?? 5_000)));
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Paid fallback backfill clock is invalid");
  // The budget bounds mutating work; the scan budget bounds the walk itself
  // (marked rows skip the write budget but still cost a get and a TTL rewrite)
  // so a resumed run cannot exceed its deadline without advancing the cursor.
  const cursorKey = paidFallbackBackfillCursorV3Key();
  const resumeKey = await loadBackfillCursorV3(kv, cursorKey);
  const sweep = await sweepPaidFallbackUsageRollupsV3(kv, resumeKey, limit, limit * 10, nowMs);
  const result: PaidFallbackRollupBackfillResult = {
    scanned: sweep.scanned,
    processed: sweep.processed,
    rollups_written: sweep.rollupsWritten,
    failed: sweep.failed,
    truncated: sweep.truncatedWith !== null,
  };
  if (sweep.truncatedWith === null) {
    // Full sweep complete: drop the resume cursor.
    await kv
      .atomic()
      .delete(cursorKey)
      .commit()
      .catch(() => {});
    return result;
  }
  if (sweep.truncatedWith === "scan_budget") {
    // Persist the resume cursor: `start` is inclusive, so the next run
    // restarts at this row instead of re-walking the whole prefix.
    if (sweep.lastVisitedKey !== null) await persistBackfillCursorV3(kv, cursorKey, sweep.lastVisitedKey);
    return result;
  }
  // Budget exhaustion or a failed row: keep the cursor at the last committed
  // row so the next run resumes before the row that still needs work.
  await persistResumeBeforeRowV3(kv, cursorKey, sweep.lastVisitedKey, resumeKey);
  return result;
};

export type PaidFallbackWindowTtlBackfillResult = Readonly<{
  scanned: number;
  rewritten: number;
  truncated: boolean;
}>;

/** True when both KV keys hold the same parts, in order. */
const isSameKvKey = (left: KvKey, right: KvKey): boolean => left.length === right.length && left.every((part, index) => part === right[index]);

/** Reads a persisted resume cursor; `null` when absent or malformed. */
const loadBackfillCursorV3 = async (kv: Kv, cursorKey: KvKey): Promise<KvKey | null> => {
  const cursorEntry = await kv.get<{ request_key: unknown }>(cursorKey).catch(() => null);
  const requestKey = cursorEntry?.value?.request_key;
  return Array.isArray(requestKey) ? (requestKey as KvKey) : null;
};

/** Persists a resume cursor; a KV outage just leaves the sweep to restart. */
const persistBackfillCursorV3 = async (kv: Kv, cursorKey: KvKey, requestKey: KvKey): Promise<void> => {
  await kv
    .atomic()
    .set(cursorKey, { request_key: requestKey })
    .commit()
    .catch(() => {});
};

/** Outcome of rewriting one window row's TTL. */
type WindowTtlRewrite = "skipped" | "rewritten" | "failed";

/** Rewrites one window row with its anchored TTL. */
const rewriteWindowTtlV3 = async (kv: Kv, key: KvKey, nowMs: number): Promise<WindowTtlRewrite> => {
  const windowEntry = await kv.get<PaidFallbackWindowV3>(key, { consistency: "strong" });
  if (!isPaidFallbackWindowV3(windowEntry.value)) return "skipped";
  try {
    const committed = await kv
      .atomic()
      .check(windowEntry)
      .set(key, windowEntry.value, { expireIn: windowExpireIn(windowEntry.value, nowMs) })
      .commit();
    return committed.ok ? "rewritten" : "failed";
  } catch {
    return "failed";
  }
};

/** Reads at most one entry matching a selector; `null` when nothing matches. */
const readFirstKvEntry = async <TValue>(kv: Kv, selector: KvListSelector): Promise<KvEntry<TValue> | null> => {
  for await (const entry of kv.list<TValue>(selector, { consistency: "strong" })) {
    return entry;
  }
  return null;
};

/** True when the window prefix still holds rows after `startKey` itself. */
const hasWindowRowsAfterV3 = async (kv: Kv, startKey: KvKey): Promise<boolean> => {
  const seenKeys: KvKey[] = [];
  for await (const entry of kv.list({ prefix: paidFallbackWindowV3GlobalPrefix, start: startKey })) {
    seenKeys.push(entry.key);
    if (seenKeys.length > 1) return true;
  }
  return false;
};

type WindowTtlSweep = Readonly<{
  scanned: number;
  rewritten: number;
  lastRewrittenKey: KvKey | null;
  /** A row lost its CAS or threw; the caller keeps the cursor before it. */
  failed: boolean;
  /** The batch limit was reached and more rows remain; the cursor is persisted. */
  truncated: boolean;
}>;

/** One bounded window-TTL sweep. */
const sweepWindowTtlsV3 = async (kv: Kv, cursorKey: KvKey, resumeKey: KvKey | null, limit: number, nowMs: number): Promise<WindowTtlSweep> => {
  let scanned = 0;
  let rewritten = 0;
  let lastRewrittenKey: KvKey | null = null;
  const selector: KvListSelector =
    resumeKey === null ? { prefix: paidFallbackWindowV3GlobalPrefix } : { prefix: paidFallbackWindowV3GlobalPrefix, start: resumeKey };
  let skippingResumeRow = resumeKey !== null;
  for await (const entry of kv.list<PaidFallbackWindowV3>(selector)) {
    scanned += 1;
    // `start` is inclusive; skip the cursor row itself so a resumed run is
    // not forced to rewrite it and then trip the batch limit again.
    const resumeCursor = resumeKey;
    if (skippingResumeRow && resumeCursor !== null && isSameKvKey(entry.key, resumeCursor)) {
      skippingResumeRow = false;
      continue;
    }
    const outcome = await rewriteWindowTtlV3(kv, entry.key, nowMs);
    if (outcome === "skipped") continue;
    if (outcome === "failed") return { scanned, rewritten, lastRewrittenKey, failed: true, truncated: false };
    lastRewrittenKey = entry.key;
    rewritten += 1;
    if (rewritten < limit) continue;
    // Probe for rows beyond this batch before reporting truncation, so the
    // final batch is never reported as incomplete.
    const hasMore = await hasWindowRowsAfterV3(kv, entry.key);
    if (!hasMore) break;
    await persistBackfillCursorV3(kv, cursorKey, entry.key);
    return { scanned, rewritten, lastRewrittenKey, failed: false, truncated: true };
  }
  return { scanned, rewritten, lastRewrittenKey, failed: false, truncated: false };
};

/**
 * Resumable sweep that applies the anchored one-year window TTL to existing
 * window rows. Window writes in live paths already carry the expiry; rows
 * written before this feature or restored by KV import do not, so they must
 * be rewritten in place. The rewrite is idempotent and each run bounds the
 * work, persisting its own cursor so repeated invocations complete the whole
 * prefix.
 */
export const backfillPaidFallbackWindowTtls = async (
  kv: Kv,
  options: Readonly<{ limit?: number; nowMs?: number }> = {}
): Promise<PaidFallbackWindowTtlBackfillResult> => {
  const limit = Math.max(1, Math.min(10_000, Math.trunc(options.limit ?? 5_000)));
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Paid fallback window TTL clock is invalid");
  const cursorKey = paidFallbackBackfillWindowCursorV3Key();
  const resumeKey = await loadBackfillCursorV3(kv, cursorKey);
  const sweep = await sweepWindowTtlsV3(kv, cursorKey, resumeKey, limit, nowMs);
  if (sweep.failed) {
    // Keep the cursor at the last successful rewrite so the next run retries
    // the row that lost its CAS instead of advancing past its missing TTL.
    const cursorKeyValue = sweep.lastRewrittenKey ?? resumeKey;
    if (cursorKeyValue !== null) await persistBackfillCursorV3(kv, cursorKey, cursorKeyValue);
    return { scanned: sweep.scanned, rewritten: sweep.rewritten, truncated: true };
  }
  if (sweep.truncated) {
    // The sweep already persisted the resume cursor for this batch.
    return { scanned: sweep.scanned, rewritten: sweep.rewritten, truncated: true };
  }
  await kv
    .atomic()
    .delete(cursorKey)
    .commit()
    .catch(() => {});
  return { scanned: sweep.scanned, rewritten: sweep.rewritten, truncated: false };
};

export type PaidFallbackAutomaticBackfillResult = Readonly<{
  kind: "completed" | "in_progress" | "skipped" | "busy";
  requests: PaidFallbackRollupBackfillResult | null;
  windows: PaidFallbackWindowTtlBackfillResult | null;
}>;

const isPaidFallbackBackfillState = (value: unknown): value is PaidFallbackBackfillStateV3 =>
  isRecord(value) && value.v === 1 && typeof value.completed_at_ms === "number" && Number.isSafeInteger(value.completed_at_ms) && value.completed_at_ms >= 0;

const isBackfillableSettledPaidFallbackRequest = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    value.billing_state === "settled" &&
    typeof value.model === "string" &&
    value.model.trim().length > 0 &&
    typeof value.provider_quota === "number" &&
    Number.isFinite(value.provider_quota) &&
    value.provider_quota >= 0 &&
    typeof value.spend_microcredits === "number" &&
    Number.isFinite(value.spend_microcredits) &&
    value.spend_microcredits >= 0
  );
};

const hasPaidFallbackUsageRollups = async (kv: Kv): Promise<boolean> => {
  const firstRollup = await readFirstKvEntry(kv, { prefix: PAID_FALLBACK_USAGE_ROLLUP_PREFIX });
  return firstRollup !== null;
};

const hasBackfillableSettledPaidFallbackRequest = async (kv: Kv): Promise<boolean> => {
  for await (const entry of kv.list<PaidFallbackRequestV3>({ prefix: paidFallbackRequestV3GlobalPrefix }, { consistency: "strong" })) {
    if (isBackfillableSettledPaidFallbackRequest(entry.value)) return true;
  }
  return false;
};

const paidFallbackBackfillNeedsRun = async (kv: Kv): Promise<boolean> => {
  const [stateEntry, requestCursorEntry, windowCursorEntry] = await Promise.all([
    kv.get<PaidFallbackBackfillStateV3>(paidFallbackBackfillStateV3Key(), { consistency: "strong" }),
    kv.get(paidFallbackBackfillCursorV3Key(), { consistency: "strong" }),
    kv.get(paidFallbackBackfillWindowCursorV3Key(), { consistency: "strong" }),
  ]);
  if (!isPaidFallbackBackfillState(stateEntry.value) || requestCursorEntry.value !== null || windowCursorEntry.value !== null) {
    return true;
  }
  if (await hasPaidFallbackUsageRollups(kv)) return false;
  return await hasBackfillableSettledPaidFallbackRequest(kv);
};

const acquirePaidFallbackBackfillLease = async (kv: Kv, nowMs: number): Promise<PaidFallbackBackfillLeaseV3 | null> => {
  const leaseKey = paidFallbackBackfillLeaseV3Key();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<PaidFallbackBackfillLeaseV3>(leaseKey, { consistency: "strong" });
    if (entry.value && entry.value.expires_at_ms > nowMs) return null;
    const lease = {
      token: crypto.randomUUID(),
      expires_at_ms: nowMs + PAID_FALLBACK_BACKFILL_LEASE_MS,
    } satisfies PaidFallbackBackfillLeaseV3;
    const commit = await kv
      .atomic()
      .check(entry)
      .set(leaseKey, lease, {
        expireIn: PAID_FALLBACK_BACKFILL_LEASE_MS,
      })
      .commit();
    if (commit.ok) return lease;
  }
  return null;
};

const releasePaidFallbackBackfillLease = async (kv: Kv, lease: PaidFallbackBackfillLeaseV3): Promise<void> => {
  try {
    const entry = await kv.get<PaidFallbackBackfillLeaseV3>(paidFallbackBackfillLeaseV3Key(), { consistency: "strong" });
    if (entry.value?.token !== lease.token) return;
    await kv
      .atomic()
      .check(entry)
      .delete(paidFallbackBackfillLeaseV3Key())
      .commit()
      .catch(() => {});
  } catch {
    // Lease expiry is the recovery path when a release races a KV outage.
  }
};

/**
 * Executes the request-row and window-TTL sweeps under one durable lease.
 * Cursor keys let a bootstrap pass resume on a later request or revision,
 * while the completion marker avoids paying the scan cost on every request.
 */
/**
 * Surfaces a failed state write. A bare `set` has no CAS precondition, so
 * `KvCommitResult.ok` is typed as the literal `true`; the check is kept
 * because the completion marker must be durable before it is reported.
 */
const throwIfCommitFailed = (result: { readonly ok: boolean }, message: string): void => {
  if (!result.ok) throw new Error(message);
};

export const runPaidFallbackBackfillV3 = async (
  kv: Kv,
  options: Readonly<{ force?: boolean; limit?: number; nowMs?: number }> = {}
): Promise<PaidFallbackAutomaticBackfillResult> => {
  const requestedLimit = Math.trunc(options.limit ?? PAID_FALLBACK_AUTOMATIC_BACKFILL_LIMIT);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(10_000, requestedLimit)) : PAID_FALLBACK_AUTOMATIC_BACKFILL_LIMIT;
  const nowMs = Math.trunc(options.nowMs ?? Date.now());
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Paid fallback automatic backfill clock is invalid");
  }
  if (options.force !== true && !(await paidFallbackBackfillNeedsRun(kv))) {
    return { kind: "skipped", requests: null, windows: null };
  }
  const lease = await acquirePaidFallbackBackfillLease(kv, nowMs);
  if (!lease) return { kind: "busy", requests: null, windows: null };
  try {
    const requests = await backfillPaidFallbackUsageRollups(kv, { limit, nowMs });
    const windows = await backfillPaidFallbackWindowTtls(kv, { limit, nowMs });
    const complete = !requests.truncated && !windows.truncated;
    if (complete) {
      throwIfCommitFailed(
        await kv.set(paidFallbackBackfillStateV3Key(), {
          v: 1,
          completed_at_ms: nowMs,
        } satisfies PaidFallbackBackfillStateV3),
        "Paid fallback automatic backfill state changed concurrently."
      );
    }
    return {
      kind: complete ? "completed" : "in_progress",
      requests,
      windows,
    };
  } finally {
    await releasePaidFallbackBackfillLease(kv, lease);
  }
};

let scheduledPaidFallbackBackfill: Promise<void> | null = null;
let paidFallbackBackfillAttempted = false;
let paidFallbackBackfillRetryPending = false;

const schedulePaidFallbackBackfill = (kvOverride?: Kv): void => {
  if (scheduledPaidFallbackBackfill) return;
  paidFallbackBackfillAttempted = true;
  scheduledPaidFallbackBackfill = (kvOverride ? Promise.resolve(kvOverride) : resolveKv(undefined))
    .then(async (kv) => {
      if (!kv) {
        paidFallbackBackfillRetryPending = true;
        return;
      }
      const result = await runPaidFallbackBackfillV3(kv);
      paidFallbackBackfillRetryPending = result.kind === "in_progress" || result.kind === "busy";
    })
    .catch(() => {
      paidFallbackBackfillRetryPending = true;
    })
    .finally(() => {
      scheduledPaidFallbackBackfill = null;
    });
};

/** Clears due pending markers whose request row is gone or no longer billable. */
const collectReconcileCandidatesV3 = async (
  kv: Kv,
  keyId: string,
  due: readonly KvEntry<PaidFallbackPendingV3>[],
  now: number
): Promise<KvEntry<PaidFallbackRequestV3>[]> => {
  const candidates: KvEntry<PaidFallbackRequestV3>[] = [];
  for (const pending of due) {
    const requestId = String(pending.key.at(-1));
    const requestKey = paidFallbackRequestV3Key(keyId, requestId);
    const requestEntry = await kv.get<PaidFallbackRequestV3>(requestKey, { consistency: "strong" });
    const request = requestEntry.value;
    if (!request || request.billing_state === "settled" || request.billing_state === "not_billed") {
      const gateKey = paidFallbackReconciliationGateV3Key();
      const gateEntry = await kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" });
      await kv.atomic().check(pending).check(gateEntry).delete(pending.key).set(gateKey, paidFallbackReconciliationGateDueNow(gateEntry, now)).commit();
      continue;
    }
    candidates.push(requestEntry as KvEntry<PaidFallbackRequestV3>);
  }
  return candidates;
};

/** Fetches the Metered token log for these candidates; `null` when the fetch failed. */
const loadMeteredLogsForCandidatesV3 = async (
  candidates: readonly KvEntry<PaidFallbackRequestV3>[],
  now: number
): Promise<readonly MeteredTokenLogEntry[] | null> => {
  const providerRequestIds = candidates
    .map((requestEntry) => requestEntry.value.provider_request_id)
    .filter((requestId): requestId is string => requestId !== null);
  if (providerRequestIds.length === 0) return [];
  try {
    return await fetchMeteredTokenLogs({
      requestIds: providerRequestIds,
      startAtMs: Math.min(...candidates.map((requestEntry) => requestEntry.value.created_at_ms)) - 60_000,
      endAtMs: now + 60_000,
    });
  } catch {
    return null;
  }
};

/** Settles every candidate that has an authoritative Metered log entry. */
const settleMeteredCandidatesV3 = async (
  kv: Kv,
  keyId: string,
  candidates: readonly KvEntry<PaidFallbackRequestV3>[],
  byId: ReadonlyMap<string, MeteredTokenLogEntry>,
  now: number
): Promise<number> => {
  let settled = 0;
  for (const requestEntry of candidates) {
    const request = requestEntry.value;
    const providerLog = request.provider_request_id ? byId.get(request.provider_request_id) : null;
    if (!providerLog) {
      await deferPaidFallbackReconciliationV3(kv, keyId, request.request_id, now);
      continue;
    }
    const result = await settlePaidFallbackRequestV3(kv, keyId, request.request_id, providerLog, now);
    if (result.settled) settled += 1;
  }
  return settled;
};

export const reconcilePaidFallbackV3 = async (
  keyId: string,
  now = Date.now(),
  kvOverride?: Kv | null,
  options?: Readonly<{ skipGateRecompute?: boolean }>
): Promise<number> => {
  const kv = await resolveKv(kvOverride);
  if (!kv) return 0;
  const lease = await acquireReconciliationLease(kv, keyId, now);
  if (!lease) return 0;
  try {
    const due: KvEntry<PaidFallbackPendingV3>[] = [];
    for await (const pending of kv.list<PaidFallbackPendingV3>({ prefix: paidFallbackPendingV3Prefix(keyId) })) {
      if (pending.value.next_reconciliation_at_ms <= now) due.push(pending);
    }
    if (!due.length) return 0;

    const candidates = await collectReconcileCandidatesV3(kv, keyId, due, now);
    if (!candidates.length) return 0;
    // Surplus has no Metered token-log endpoint. Its terminal usage is settled
    // synchronously by recordSurplusUsage; a missing or partial observation
    // must remain pending and fail closed rather than being looked up or
    // falsely settled through Metered logs.
    const surplusCandidates = candidates.filter((requestEntry) => requestEntry.value.provider === "surplus");
    await Promise.all(surplusCandidates.map((requestEntry) => deferPaidFallbackReconciliationV3(kv, keyId, requestEntry.value.request_id, now)));
    const meteredCandidates = candidates.filter((requestEntry) => requestEntry.value.provider !== "surplus");
    if (!meteredCandidates.length) return 0;
    const logs = await loadMeteredLogsForCandidatesV3(meteredCandidates, now);
    if (logs === null) {
      await Promise.all(meteredCandidates.map((requestEntry) => deferPaidFallbackReconciliationV3(kv, keyId, requestEntry.value.request_id, now)));
      // The durable marker carries the retry timestamp, but it is not a
      // delivery schedule. The event-driven policy intentionally leaves this
      // work pending on an idle Mac until a later authorized event.
      return 0;
    }
    return await settleMeteredCandidatesV3(kv, keyId, meteredCandidates, new Map(logs.map((log) => [log.request_id, log])), now);
  } finally {
    await releaseReconciliationLease(kv, keyId, lease);
    if (!options?.skipGateRecompute) await recomputePaidFallbackReconciliationGateV3(kv);
  }
};

export const reconcileDuePaidFallbacksV3 = async (now = Date.now(), kvOverride?: Kv | null): Promise<number> => {
  const kv = await resolveKv(kvOverride);
  if (!kv) return 0;
  const gateKey = paidFallbackReconciliationGateV3Key();
  let gateEntry: KvEntryMaybe<PaidFallbackReconciliationGateV3> | null = null;
  let bootstrapScan: PendingMarkerScan | null = null;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    gateEntry = await kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" });
    if (isPaidFallbackReconciliationGate(gateEntry.value)) break;
    bootstrapScan = await scanPaidFallbackPendingMarkers(kv);
    const commit = await kv
      .atomic()
      .check(gateEntry)
      .set(gateKey, { next_due_at_ms: bootstrapScan.earliest_due_at_ms } satisfies PaidFallbackReconciliationGateV3)
      .commit();
    if (commit.ok) {
      gateEntry = {
        key: gateKey,
        value: { next_due_at_ms: bootstrapScan.earliest_due_at_ms },
        versionstamp: commit.versionstamp,
      };
      break;
    }
    bootstrapScan = null;
  }
  if (!gateEntry || !isPaidFallbackReconciliationGate(gateEntry.value)) {
    throw new Error("Paid fallback reconciliation gate changed concurrently.");
  }
  const nextDueAtMs = gateEntry.value.next_due_at_ms;
  if (nextDueAtMs === null || nextDueAtMs > now) return 0;

  const pendingScan = bootstrapScan ?? (await scanPaidFallbackPendingMarkers(kv));
  const keyIds = new Set<string>();
  for (const pending of pendingScan.entries) {
    if (pending.value.next_reconciliation_at_ms > now) continue;
    const keyId = pending.key.at(-2);
    if (typeof keyId === "string") keyIds.add(keyId);
  }
  let settled = 0;
  try {
    for (const keyId of keyIds) {
      settled += await reconcilePaidFallbackV3(keyId, now, kv, { skipGateRecompute: true });
    }
    return settled;
  } finally {
    await recomputePaidFallbackReconciliationGateV3(kv);
  }
};

export const markPaidFallbackTerminalV3 = async (
  reservation: PaidFallbackAdmissionV3,
  terminalState: PaidFallbackRequestV3["terminal_state"],
  provider?: PaidFallbackProvider
): Promise<number> => {
  await updatePaidFallbackRequestV3(reservation, {
    ...(provider === undefined ? {} : { provider }),
    terminal_state: terminalState,
    increment_reconciliation_attempts: true,
  });
  // A terminal event can arrive while the pending marker is still scheduled
  // for a later retry. Move that marker to "due" before the event's
  // best-effort sweep so it never burns this event on a no-op reconciliation.
  await _expeditePaidFallbackReconciliationV3(reservation, Date.now());
  // The event owns the best-effort provider-log read; never fetch provider
  // logs from the inference request itself. A failed or late read remains
  // durably pending for the next authorized event.
  return 0;
};

export const recordPaidFallbackTerminalV3 = async (
  reservation: PaidFallbackAdmissionV3,
  terminalState: PaidFallbackRequestV3["terminal_state"],
  provider?: PaidFallbackProvider
): Promise<number> => {
  await markPaidFallbackTerminalV3(reservation, terminalState, provider);
  // Legacy direct callers are retained only for deterministic local migration
  // tests; production inference calls markPaidFallbackTerminalV3 instead.
  return await reconcilePaidFallbackV3(reservation.key_id, Date.now());
};

export const handlePaidFallbackReconciliationJobV3 = async (message: unknown, kvOverride?: Kv | null): Promise<number> => {
  if (!message || typeof message !== "object") return 0;
  const keyId = "key_id" in message && typeof message.key_id === "string" ? message.key_id : null;
  if (!keyId) return 0;
  const kv = await resolveKv(kvOverride);
  if (!kv) return 0;
  return await reconcilePaidFallbackV3(keyId, Date.now(), kv);
};

export const enqueueDuePaidFallbackReconciliationJobsV3 = async (now = Date.now(), kvOverride?: Kv | null): Promise<number> => {
  const kv = await resolveKv(kvOverride);
  if (!kv) return 0;
  const keyIds = new Set<string>();
  for await (const pending of kv.list<PaidFallbackPendingV3>({ prefix: paidFallbackPendingV3GlobalPrefix })) {
    if (pending.value.next_reconciliation_at_ms > now) continue;
    const keyId = pending.key.at(-2);
    if (typeof keyId === "string") keyIds.add(keyId);
  }
  let queued = 0;
  for (const keyId of keyIds) {
    if (await enqueuePaidFallbackReconciliationJob(kv, keyId)) queued += 1;
  }
  return queued;
};

export { paidFallbackBackfillAttempted, paidFallbackBackfillRetryPending, schedulePaidFallbackBackfill };
