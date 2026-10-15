import type { Kv, KvKey } from "#kv";
import { isRecord } from "../utils.ts";

/**
 * Compact per-hour capacity rollups for the two Codex subscription slots.
 *
 * The admin chart reads fifteen-minute ProviderCapacityHistoryPoints that are
 * retained for seven days because that read feeds the admin view payload
 * directly. Long-run research reads these hourly aggregates instead: per hour,
 * and per slot inside the record, the min/max/last window usage observed. Every
 * persisted capacity sample folds its slot summaries into the same atomic that
 * writes the fifteen-minute history point, so a retained sample cannot miss its
 * rollup, and rollups are written without a TTL.
 */
export const PROVIDER_CAPACITY_ROLLUP_PREFIX = ["uos_ai", "provider_capacity", "v1", "rollup"] as const;

/** One hour, matching the Metered balance history and paid-fallback rollups. */
export const PROVIDER_CAPACITY_ROLLUP_BUCKET_MS = 60 * 60 * 1_000;

/** Bounds one research scan: 365 days is at most 8,760 hourly points. */
export const PROVIDER_CAPACITY_ROLLUP_READ_LIMIT = 20_000;

export type ProviderCapacityRollupState = "available" | "stale" | "unavailable";

export type ProviderCapacityRollupWindow = Readonly<{
  samples: number;
  limit_window_seconds: number | null;
  min_used_percent: number | null;
  max_used_percent: number | null;
  last_used_percent: number | null;
  last_reset_at_ms: number | null;
}>;

export type ProviderCapacityRollupSlot = Readonly<{
  slot: 1 | 2;
  available_sample_count: number;
  last_state: ProviderCapacityRollupState;
  primary: ProviderCapacityRollupWindow;
  secondary: ProviderCapacityRollupWindow;
}>;

export type ProviderCapacityRollupPoint = Readonly<{
  v: 1;
  bucket_start_at_ms: number;
  sample_count: number;
  first_sampled_at_ms: number;
  last_sampled_at_ms: number;
  slots: readonly [ProviderCapacityRollupSlot, ProviderCapacityRollupSlot];
}>;

export type ProviderCapacityRollupWindowInput = Readonly<{
  limit_window_seconds: number | null;
  used_percent: number | null;
  reset_at_ms: number | null;
}>;

export type ProviderCapacityRollupSlotInput = Readonly<{
  slot: 1 | 2;
  state: ProviderCapacityRollupState;
  primary: ProviderCapacityRollupWindowInput | null;
  secondary: ProviderCapacityRollupWindowInput | null;
}>;

export type ProviderCapacityRollupInput = Readonly<{
  bucket_start_at_ms: number;
  sampled_at_ms: number;
  slots: readonly [ProviderCapacityRollupSlotInput, ProviderCapacityRollupSlotInput];
}>;

const isSafeTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isSampleCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isUsedPercent = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const isOptionalPercent = (value: unknown): boolean => value === null || isUsedPercent(value);
const isOptionalTimestamp = (value: unknown): boolean => value === null || isSafeTimestamp(value);
const isOptionalWindowSeconds = (value: unknown): boolean => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

const capacityState = (value: unknown): ProviderCapacityRollupState | null =>
  value === "available" || value === "stale" || value === "unavailable" ? value : null;

const isRollupWindow = (value: unknown): value is ProviderCapacityRollupWindow => {
  if (!isRecord(value)) return false;
  return (
    isSampleCount(value.samples) &&
    isOptionalWindowSeconds(value.limit_window_seconds) &&
    isOptionalPercent(value.min_used_percent) &&
    isOptionalPercent(value.max_used_percent) &&
    isOptionalPercent(value.last_used_percent) &&
    isOptionalTimestamp(value.last_reset_at_ms)
  );
};

const isRollupSlot = (value: unknown): value is ProviderCapacityRollupSlot => {
  if (!isRecord(value) || (value.slot !== 1 && value.slot !== 2) || capacityState(value.last_state) === null) return false;
  return isSampleCount(value.available_sample_count) && isRollupWindow(value.primary) && isRollupWindow(value.secondary);
};

export const isProviderCapacityRollupPoint = (value: unknown): value is ProviderCapacityRollupPoint => {
  if (!isRecord(value) || value.v !== 1) return false;
  if (!isSafeTimestamp(value.bucket_start_at_ms) || value.bucket_start_at_ms % PROVIDER_CAPACITY_ROLLUP_BUCKET_MS !== 0) return false;
  if (!isSampleCount(value.sample_count) || !isSafeTimestamp(value.first_sampled_at_ms) || !isSafeTimestamp(value.last_sampled_at_ms)) return false;
  if (value.first_sampled_at_ms > value.last_sampled_at_ms) return false;
  const slots = Array.isArray(value.slots) ? value.slots : null;
  if (slots?.length !== 2) return false;
  const slotOne = isRollupSlot(slots[0]) ? slots[0] : null;
  const slotTwo = isRollupSlot(slots[1]) ? slots[1] : null;
  if (!slotOne || !slotTwo || slotOne.slot !== 1 || slotTwo.slot !== 2) return false;
  return slotOne.available_sample_count <= value.sample_count && slotTwo.available_sample_count <= value.sample_count;
};

export const providerCapacityRollupBucketStartAtMs = (observedAtMs: number): number =>
  Math.floor(Math.max(0, observedAtMs) / PROVIDER_CAPACITY_ROLLUP_BUCKET_MS) * PROVIDER_CAPACITY_ROLLUP_BUCKET_MS;

export const providerCapacityRollupKey = (bucketStartAtMs: number): KvKey => [...PROVIDER_CAPACITY_ROLLUP_PREFIX, bucketStartAtMs];

const emptyWindowSummary = (): ProviderCapacityRollupWindow => ({
  samples: 0,
  limit_window_seconds: null,
  min_used_percent: null,
  max_used_percent: null,
  last_used_percent: null,
  last_reset_at_ms: null,
});

const minObservedPercent = (existing: number | null, next: number | null): number | null => {
  if (next === null) return existing;
  if (existing === null) return next;
  return Math.min(existing, next);
};

const maxObservedPercent = (existing: number | null, next: number | null): number | null => {
  if (next === null) return existing;
  if (existing === null) return next;
  return Math.max(existing, next);
};

const mergeRollupWindow = (existing: ProviderCapacityRollupWindow, input: ProviderCapacityRollupWindowInput | null): ProviderCapacityRollupWindow => {
  if (!input) return existing;
  return {
    samples: existing.samples + 1,
    limit_window_seconds: input.limit_window_seconds ?? existing.limit_window_seconds,
    min_used_percent: minObservedPercent(existing.min_used_percent, input.used_percent),
    max_used_percent: maxObservedPercent(existing.max_used_percent, input.used_percent),
    last_used_percent: input.used_percent ?? existing.last_used_percent,
    last_reset_at_ms: input.reset_at_ms ?? existing.last_reset_at_ms,
  };
};

const emptyRollupSlot = (slot: 1 | 2): ProviderCapacityRollupSlot => ({
  slot,
  available_sample_count: 0,
  last_state: "unavailable",
  primary: emptyWindowSummary(),
  secondary: emptyWindowSummary(),
});

const mergeRollupSlot = (existing: ProviderCapacityRollupSlot, input: ProviderCapacityRollupSlotInput): ProviderCapacityRollupSlot => ({
  slot: input.slot,
  available_sample_count: existing.available_sample_count + (input.state === "available" ? 1 : 0),
  last_state: input.state,
  primary: mergeRollupWindow(existing.primary, input.primary),
  secondary: mergeRollupWindow(existing.secondary, input.secondary),
});

/** Pure merge of one capacity observation into its hour bucket. */
export const mergeProviderCapacityRollup = (existing: ProviderCapacityRollupPoint | null, input: ProviderCapacityRollupInput): ProviderCapacityRollupPoint => {
  const current = existing?.bucket_start_at_ms === input.bucket_start_at_ms ? existing : null;
  const mergeSlot = (inputSlot: ProviderCapacityRollupSlotInput): ProviderCapacityRollupSlot => {
    const existingSlot = current?.slots.find((candidate) => candidate.slot === inputSlot.slot) ?? emptyRollupSlot(inputSlot.slot);
    return mergeRollupSlot(existingSlot, inputSlot);
  };
  return {
    v: 1,
    bucket_start_at_ms: input.bucket_start_at_ms,
    sample_count: (current?.sample_count ?? 0) + 1,
    first_sampled_at_ms: current ? Math.min(current.first_sampled_at_ms, input.sampled_at_ms) : input.sampled_at_ms,
    last_sampled_at_ms: current ? Math.max(current.last_sampled_at_ms, input.sampled_at_ms) : input.sampled_at_ms,
    slots: [mergeSlot(input.slots[0]), mergeSlot(input.slots[1])],
  };
};

/**
 * Reads the hourly rollups intersecting `[sinceMs, nowMs]`. The complete
 * requested range is returned in bucket order; `limit` bounds each range scan
 * so a research query can never enumerate the whole retained history.
 */
export const listProviderCapacityRollups = async (
  kv: Kv,
  options: Readonly<{ sinceMs: number; nowMs: number; limit?: number }>
): Promise<ProviderCapacityRollupPoint[]> => {
  const limit = Math.max(1, Math.min(PROVIDER_CAPACITY_ROLLUP_READ_LIMIT, Math.trunc(options.limit ?? PROVIDER_CAPACITY_ROLLUP_READ_LIMIT)));
  const sinceMs = Math.max(0, Math.trunc(options.sinceMs));
  const nowMs = Math.max(sinceMs, Math.trunc(options.nowMs));
  const firstBucketStartAtMs = providerCapacityRollupBucketStartAtMs(sinceMs);
  const lastBucketStartAtMs = providerCapacityRollupBucketStartAtMs(nowMs);
  const start: KvKey = [...PROVIDER_CAPACITY_ROLLUP_PREFIX, firstBucketStartAtMs];
  const end: KvKey = [...PROVIDER_CAPACITY_ROLLUP_PREFIX, lastBucketStartAtMs + PROVIDER_CAPACITY_ROLLUP_BUCKET_MS];
  const points: ProviderCapacityRollupPoint[] = [];
  // Deno KV rejects selectors that combine a prefix with both range bounds.
  for await (const entry of kv.list({ start, end }, { limit })) {
    const rollup = isProviderCapacityRollupPoint(entry.value) ? entry.value : null;
    if (!rollup || rollup.bucket_start_at_ms < firstBucketStartAtMs || rollup.bucket_start_at_ms > lastBucketStartAtMs) continue;
    points.push(rollup);
  }
  return points.sort((left, right) => left.bucket_start_at_ms - right.bucket_start_at_ms);
};
