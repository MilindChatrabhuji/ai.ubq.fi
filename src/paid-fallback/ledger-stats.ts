import type { Kv, KvKey } from "#kv";
import { isRecord } from "../utils.ts";

/**
 * Daily, best-effort growth instrumentation for the paid-fallback raw-row
 * store and its hourly rollups.
 *
 * The retention design (docs/log-retention-and-quota-runway-2026-08-25.md) was
 * sized on estimates: ~800 B per settled raw row, ~25 KB of rollup per model
 * per day, and window-bounded admin projection reads with unknown cost. These
 * counters record the measured values as one small row per UTC day so the
 * 365-day horizon, the rollup shape and the storage budget can be tuned with
 * evidence instead of guesses:
 *
 * - `settled_rows` / `settled_row_bytes`: settled raw rows written and their
 *   JSON-serialized size. Summed over the retention window this is the
 *   estimated retained raw-row store, compared against
 *   PAID_FALLBACK_RAW_STORE_BUDGET_BYTES to raise the storage alert.
 * - `rollup_writes` / `rollup_bytes`: merged hourly rollup records written and
 *   their serialized size. This is rollup write volume, not retained size.
 * - `projection_*`: admin quota-projection views and the KV read units they
 *   consumed, split by the requested 7/30/90-day window, so the real cost of an
 *   admin view is measurable.
 *
 * Writes are best-effort CAS merges: a lost sample must never fail a
 * settlement or an admin view. The alert is therefore a lower-bound estimate,
 * which the growth view documents.
 *
 * `estimatePaidFallbackRecordBytes` measures the JSON-serialized logical
 * record, which is the unit the raw-row store and rollups are counted in. It is
 * deliberately not the physical SQLite/WAL footprint of the shared KV database
 * and not total host storage: those include page overhead, indexes, WAL,
 * checkpoints and every other key family.
 */

export const PAID_FALLBACK_LEDGER_STATS_PREFIX = ["uos_ai", "paid_fallback", "v3", "ledger_stats"] as const;
export const PAID_FALLBACK_LEDGER_STATS_DAY_MS = 24 * 60 * 60 * 1_000;
/** Operational 5 GiB budget for the estimated retained raw-row store: its 80% mark is the storage-growth warning threshold. */
export const PAID_FALLBACK_RAW_STORE_BUDGET_BYTES = 5 * 1024 * 1024 * 1024;
/** Alert once the estimated retained raw store reaches this share of the budget. */
export const PAID_FALLBACK_RAW_STORE_ALERT_RATIO = 0.8;
/** Bounded daily leaderboard returned by the growth view. */
export const PAID_FALLBACK_LEDGER_STATS_LEADERBOARD_DAYS = 30;
/** CAS attempts for one best-effort counter merge before dropping the sample. */
export const PAID_FALLBACK_LEDGER_STATS_MAX_WRITE_ATTEMPTS = 8;

export type PaidFallbackLedgerProjectionWindowDays = 7 | 30 | 90;
export type PaidFallbackLedgerProjectionCounters = Readonly<{
  views: number;
  read_units: number;
  rollup_rows: number;
}>;

export type PaidFallbackLedgerDailyStats = Readonly<{
  v: 1;
  day_start_at_ms: number;
  settled_rows: number;
  settled_row_bytes: number;
  rollup_writes: number;
  rollup_bytes: number;
  projection_7d: PaidFallbackLedgerProjectionCounters;
  projection_30d: PaidFallbackLedgerProjectionCounters;
  projection_90d: PaidFallbackLedgerProjectionCounters;
  updated_at_ms: number;
}>;

const zeroProjectionCounters = (): PaidFallbackLedgerProjectionCounters => ({ views: 0, read_units: 0, rollup_rows: 0 });

export const emptyPaidFallbackLedgerDailyStats = (dayStartAtMs: number): PaidFallbackLedgerDailyStats => ({
  v: 1,
  day_start_at_ms: dayStartAtMs,
  settled_rows: 0,
  settled_row_bytes: 0,
  rollup_writes: 0,
  rollup_bytes: 0,
  projection_7d: zeroProjectionCounters(),
  projection_30d: zeroProjectionCounters(),
  projection_90d: zeroProjectionCounters(),
  updated_at_ms: 0,
});

/** UTC day bucket start, matching the hourly rollups' bucket-precision style. */
export const paidFallbackLedgerStatsDayStart = (ms: number): number =>
  Math.floor(Math.max(0, Math.trunc(ms)) / PAID_FALLBACK_LEDGER_STATS_DAY_MS) * PAID_FALLBACK_LEDGER_STATS_DAY_MS;

export const paidFallbackLedgerStatsDayKey = (dayStartAtMs: number): KvKey => [...PAID_FALLBACK_LEDGER_STATS_PREFIX, dayStartAtMs];

const isNonNegativeSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isProjectionCounters = (value: unknown): value is PaidFallbackLedgerProjectionCounters =>
  isRecord(value) && isNonNegativeSafeInteger(value.views) && isNonNegativeSafeInteger(value.read_units) && isNonNegativeSafeInteger(value.rollup_rows);

export const isPaidFallbackLedgerDailyStats = (value: unknown): value is PaidFallbackLedgerDailyStats => {
  if (!isRecord(value)) return false;
  return (
    value.v === 1 &&
    isNonNegativeSafeInteger(value.day_start_at_ms) &&
    isNonNegativeSafeInteger(value.settled_rows) &&
    isNonNegativeSafeInteger(value.settled_row_bytes) &&
    isNonNegativeSafeInteger(value.rollup_writes) &&
    isNonNegativeSafeInteger(value.rollup_bytes) &&
    isProjectionCounters(value.projection_7d) &&
    isProjectionCounters(value.projection_30d) &&
    isProjectionCounters(value.projection_90d) &&
    isNonNegativeSafeInteger(value.updated_at_ms)
  );
};

/**
 * JSON-serialized byte size of one KV value. Deno KV's own encoding is not
 * JSON, so this is the same bounded estimate the admin payload size checks
 * use: it measures the row, not the physical page, and never throws.
 */
export const estimatePaidFallbackRecordBytes = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
};

const projectionCountersKey = (windowDays: PaidFallbackLedgerProjectionWindowDays): "projection_7d" | "projection_30d" | "projection_90d" => {
  if (windowDays === 7) return "projection_7d";
  if (windowDays === 30) return "projection_30d";
  return "projection_90d";
};

/** One CAS retry loop; drops the sample instead of delaying settlement or the admin view. */
const mergePaidFallbackLedgerDailyStats = async (
  kv: Kv,
  dayStartAtMs: number,
  nowMs: number,
  merge: (existing: PaidFallbackLedgerDailyStats) => PaidFallbackLedgerDailyStats
): Promise<void> => {
  const key = paidFallbackLedgerStatsDayKey(dayStartAtMs);
  for (let attempt = 0; attempt < PAID_FALLBACK_LEDGER_STATS_MAX_WRITE_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<PaidFallbackLedgerDailyStats>(key, { consistency: "strong" });
    const existing = isPaidFallbackLedgerDailyStats(entry.value) ? entry.value : emptyPaidFallbackLedgerDailyStats(dayStartAtMs);
    const next = { ...merge(existing), v: 1 as const, day_start_at_ms: dayStartAtMs, updated_at_ms: nowMs };
    const committed = await kv.atomic().check(entry).set(key, next).commit();
    if (committed.ok) return;
  }
};

/**
 * Records one settled raw row (and the rollup it folded into, when any). The
 * caller measures the records; this function only merges the daily counters
 * and swallows every failure so measurement can never break settlement.
 */
export const recordPaidFallbackLedgerSettlementStats = async (
  kv: Kv | null,
  input: Readonly<{
    settledRowBytes: number;
    /** Serialized merged rollup record, or null when no rollup was written. */
    rollupBytes: number | null;
    nowMs?: number;
  }>
): Promise<boolean> => {
  if (!kv) return false;
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return false;
  const settledRowBytes = Math.max(0, Math.trunc(input.settledRowBytes));
  const rollupBytes = input.rollupBytes === null ? null : Math.max(0, Math.trunc(input.rollupBytes));
  try {
    await mergePaidFallbackLedgerDailyStats(kv, paidFallbackLedgerStatsDayStart(nowMs), nowMs, (stats) => ({
      ...stats,
      settled_rows: stats.settled_rows + 1,
      settled_row_bytes: stats.settled_row_bytes + settledRowBytes,
      rollup_writes: stats.rollup_writes + (rollupBytes === null ? 0 : 1),
      rollup_bytes: stats.rollup_bytes + (rollupBytes ?? 0),
    }));
    return true;
  } catch {
    return false;
  }
};

/**
 * Records one admin quota-projection view with the KV read units it consumed
 * (one per KV operation plus one per returned entry) for its requested window.
 */
export const recordPaidFallbackLedgerProjectionStats = async (
  kv: Kv | null,
  input: Readonly<{
    windowDays: PaidFallbackLedgerProjectionWindowDays;
    readUnits: number;
    rollupRows: number;
    nowMs?: number;
  }>
): Promise<boolean> => {
  if (!kv) return false;
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return false;
  const readUnits = Math.max(0, Math.trunc(input.readUnits));
  const rollupRows = Math.max(0, Math.trunc(input.rollupRows));
  const countersKey = projectionCountersKey(input.windowDays);
  try {
    await mergePaidFallbackLedgerDailyStats(kv, paidFallbackLedgerStatsDayStart(nowMs), nowMs, (stats) => {
      const counters = stats[countersKey];
      return {
        ...stats,
        [countersKey]: {
          views: counters.views + 1,
          read_units: counters.read_units + readUnits,
          rollup_rows: counters.rollup_rows + rollupRows,
        },
      };
    });
    return true;
  } catch {
    return false;
  }
};

/** One bounded daily leaderboard entry, newest last. */
export type PaidFallbackLedgerGrowthDay = Readonly<{
  day_start_at_ms: number;
  settled_rows: number;
  settled_row_bytes: number;
  rollup_writes: number;
  rollup_bytes: number;
  projection_views: number;
  projection_read_units: number;
  projection_rollup_rows: number;
}>;

export type PaidFallbackLedgerProjectionSummary = Readonly<{
  window_days: PaidFallbackLedgerProjectionWindowDays;
  views: number;
  read_units: number;
  rollup_rows: number;
  avg_read_units_per_view: number | null;
  avg_rollup_rows_per_view: number | null;
}>;

export type PaidFallbackLedgerGrowthView = Readonly<{
  as_of_ms: number;
  scan: "ok" | "unavailable";
  /** KV read units this scan consumed: one per list call plus one per returned daily key. */
  read_units: number;
  retention_days: number;
  leaderboard_days: number;
  leaderboard: readonly PaidFallbackLedgerGrowthDay[];
  settled_rows: number;
  settled_row_bytes: number;
  rollup_writes: number;
  rollup_bytes: number;
  active_days: number;
  avg_row_bytes: number | null;
  avg_settled_rows_per_active_day: number | null;
  /** Sum of settled rows written inside the retention window (lower bound on retained rows). */
  estimated_retained_rows: number;
  /** Sum of settled-row bytes written inside the retention window. */
  estimated_retained_raw_bytes: number;
  budget_bytes: number;
  alert_ratio: number;
  alert_threshold_bytes: number;
  alert: boolean;
  projections: readonly PaidFallbackLedgerProjectionSummary[];
}>;

const emptyGrowthView = (
  nowMs: number,
  retentionDays: number,
  leaderboardDays: number,
  scan: "ok" | "unavailable",
  readUnits: number
): PaidFallbackLedgerGrowthView => ({
  as_of_ms: nowMs,
  scan,
  read_units: readUnits,
  retention_days: retentionDays,
  leaderboard_days: leaderboardDays,
  leaderboard: [],
  settled_rows: 0,
  settled_row_bytes: 0,
  rollup_writes: 0,
  rollup_bytes: 0,
  active_days: 0,
  avg_row_bytes: null,
  avg_settled_rows_per_active_day: null,
  estimated_retained_rows: 0,
  estimated_retained_raw_bytes: 0,
  budget_bytes: PAID_FALLBACK_RAW_STORE_BUDGET_BYTES,
  alert_ratio: PAID_FALLBACK_RAW_STORE_ALERT_RATIO,
  alert_threshold_bytes: Math.floor(PAID_FALLBACK_RAW_STORE_BUDGET_BYTES * PAID_FALLBACK_RAW_STORE_ALERT_RATIO),
  alert: false,
  projections: ([7, 30, 90] as const).map((windowDays) => ({
    window_days: windowDays,
    views: 0,
    read_units: 0,
    rollup_rows: 0,
    avg_read_units_per_view: null,
    avg_rollup_rows_per_view: null,
  })),
});

const roundToTenths = (value: number): number => Math.round(value * 10) / 10;

const summarizeWindow = (
  windowDays: PaidFallbackLedgerProjectionWindowDays,
  countersKey: "projection_7d" | "projection_30d" | "projection_90d",
  rows: readonly PaidFallbackLedgerDailyStats[]
): PaidFallbackLedgerProjectionSummary => {
  let views = 0;
  let readUnits = 0;
  let rollupRows = 0;
  for (const row of rows) {
    const counters = row[countersKey];
    views += counters.views;
    readUnits += counters.read_units;
    rollupRows += counters.rollup_rows;
  }
  return {
    window_days: windowDays,
    views,
    read_units: readUnits,
    rollup_rows: rollupRows,
    avg_read_units_per_view: views > 0 ? roundToTenths(readUnits / views) : null,
    avg_rollup_rows_per_view: views > 0 ? roundToTenths(rollupRows / views) : null,
  };
};

/**
 * Reads the daily counters inside the retention window and derives the
 * measured growth view. A failed scan reports `scan: "unavailable"` instead of
 * fabricating zeros, so an operator can tell "nothing settled" from "history
 * could not be read". The retained-byte estimate includes every row written in
 * the window and is therefore an upper bound, while dropped best-effort
 * samples make it a lower bound on actual writes.
 */
export const readPaidFallbackLedgerGrowth = async (
  kv: Kv | null,
  options: Readonly<{ nowMs: number; retentionMs: number; leaderboardDays?: number }>
): Promise<PaidFallbackLedgerGrowthView> => {
  const nowMs = Math.max(0, Math.trunc(options.nowMs));
  const retentionMs = Math.max(PAID_FALLBACK_LEDGER_STATS_DAY_MS, Math.trunc(options.retentionMs));
  const retentionDays = Math.max(1, Math.round(retentionMs / PAID_FALLBACK_LEDGER_STATS_DAY_MS));
  const leaderboardDays = Math.max(1, Math.trunc(options.leaderboardDays ?? PAID_FALLBACK_LEDGER_STATS_LEADERBOARD_DAYS));
  if (!kv) return emptyGrowthView(nowMs, retentionDays, leaderboardDays, "unavailable", 0);
  const start: KvKey = [...PAID_FALLBACK_LEDGER_STATS_PREFIX, paidFallbackLedgerStatsDayStart(nowMs - retentionMs)];
  const end: KvKey = [...PAID_FALLBACK_LEDGER_STATS_PREFIX, nowMs + PAID_FALLBACK_LEDGER_STATS_DAY_MS];
  const rows: PaidFallbackLedgerDailyStats[] = [];
  try {
    for await (const entry of kv.list<PaidFallbackLedgerDailyStats>({ start, end })) {
      if (isPaidFallbackLedgerDailyStats(entry.value)) rows.push(entry.value);
    }
  } catch {
    return emptyGrowthView(nowMs, retentionDays, leaderboardDays, "unavailable", 0);
  }

  const leaderboardStartMs = paidFallbackLedgerStatsDayStart(nowMs - leaderboardDays * PAID_FALLBACK_LEDGER_STATS_DAY_MS);
  const leaderboard = rows
    .filter((row) => row.day_start_at_ms >= leaderboardStartMs)
    .slice(-leaderboardDays)
    .map((row) => ({
      day_start_at_ms: row.day_start_at_ms,
      settled_rows: row.settled_rows,
      settled_row_bytes: row.settled_row_bytes,
      rollup_writes: row.rollup_writes,
      rollup_bytes: row.rollup_bytes,
      projection_views: row.projection_7d.views + row.projection_30d.views + row.projection_90d.views,
      projection_read_units: row.projection_7d.read_units + row.projection_30d.read_units + row.projection_90d.read_units,
      projection_rollup_rows: row.projection_7d.rollup_rows + row.projection_30d.rollup_rows + row.projection_90d.rollup_rows,
    }));

  let settledRows = 0;
  let settledRowBytes = 0;
  let rollupWrites = 0;
  let rollupBytes = 0;
  let activeDays = 0;
  for (const row of rows) {
    settledRows += row.settled_rows;
    settledRowBytes += row.settled_row_bytes;
    rollupWrites += row.rollup_writes;
    rollupBytes += row.rollup_bytes;
    if (row.settled_rows > 0) activeDays += 1;
  }
  const alertThresholdBytes = Math.floor(PAID_FALLBACK_RAW_STORE_BUDGET_BYTES * PAID_FALLBACK_RAW_STORE_ALERT_RATIO);
  return {
    as_of_ms: nowMs,
    scan: "ok",
    read_units: rows.length + 1,
    retention_days: retentionDays,
    leaderboard_days: leaderboardDays,
    leaderboard,
    settled_rows: settledRows,
    settled_row_bytes: settledRowBytes,
    rollup_writes: rollupWrites,
    rollup_bytes: rollupBytes,
    active_days: activeDays,
    avg_row_bytes: settledRows > 0 ? Math.round(settledRowBytes / settledRows) : null,
    avg_settled_rows_per_active_day: activeDays > 0 ? roundToTenths(settledRows / activeDays) : null,
    estimated_retained_rows: settledRows,
    estimated_retained_raw_bytes: settledRowBytes,
    budget_bytes: PAID_FALLBACK_RAW_STORE_BUDGET_BYTES,
    alert_ratio: PAID_FALLBACK_RAW_STORE_ALERT_RATIO,
    alert_threshold_bytes: alertThresholdBytes,
    alert: settledRowBytes >= alertThresholdBytes,
    projections: [summarizeWindow(7, "projection_7d", rows), summarizeWindow(30, "projection_30d", rows), summarizeWindow(90, "projection_90d", rows)],
  };
};
