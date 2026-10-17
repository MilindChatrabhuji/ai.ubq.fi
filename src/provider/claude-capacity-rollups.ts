import type { Kv, KvEntry, KvKey } from "#kv";
import { isRecord } from "../utils.ts";
import type { ClaudeCapacityHistoryPoint } from "./capacity-contract.ts";

export const CLAUDE_CAPACITY_ROLLUP_PREFIX = ["uos_ai", "provider_capacity", "claude", "v1", "rollup"] as const;
const CLAUDE_CAPACITY_ROLLUP_BUCKET_MS = 60 * 60_000;
export const CLAUDE_CAPACITY_READ_LIMIT = 20_000;
export type ClaudeCapacityWindowId = "five_hour" | "seven_day";

export type ClaudeCapacityRollupPoint = Readonly<{
  v: 1;
  bucket_start_at_ms: number;
  account_id: string;
  account_cohort_id: string;
  credential_kind: "oauth" | "api_key";
  workspace_id: string | null;
  window: ClaudeCapacityWindowId;
  reset_at_ms: number | null;
  samples: number;
  available_sample_count: number;
  unavailable_sample_count: number;
  first_source_observed_at_ms: number | null;
  last_source_observed_at_ms: number | null;
  first_sampled_at_ms: number;
  last_sampled_at_ms: number;
  min_used_percent: number | null;
  max_used_percent: number | null;
  last_used_percent: number | null;
  last_status: string | null;
}>;

export const claudeCapacityTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const claudeCapacityOptionalTimestamp = (value: unknown): value is number | null => value === null || claudeCapacityTimestamp(value);
export const claudeCapacityPercent = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
export const claudeCapacityIdentity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

const validRollupIdentity = (value: Record<string, unknown>): boolean =>
  claudeCapacityIdentity(value.account_id) &&
  claudeCapacityIdentity(value.account_cohort_id) &&
  (value.credential_kind === "oauth" || value.credential_kind === "api_key") &&
  (value.workspace_id === null || claudeCapacityIdentity(value.workspace_id)) &&
  (value.window === "five_hour" || value.window === "seven_day");

const validRollupOrder = (value: ClaudeCapacityRollupPoint): boolean => {
  const first = value.first_source_observed_at_ms;
  const last = value.last_source_observed_at_ms;
  if ((first === null) !== (last === null)) return false;
  if (first !== null && last !== null && (first > last || last > value.last_sampled_at_ms)) return false;
  if (first !== null && first < value.bucket_start_at_ms) return false;
  if (last !== null && last >= value.bucket_start_at_ms + CLAUDE_CAPACITY_ROLLUP_BUCKET_MS) return false;
  const min = value.min_used_percent;
  const max = value.max_used_percent;
  if ((min === null) !== (max === null)) return false;
  if (min !== null && max !== null && min > max) return false;
  return value.last_used_percent === null || (min !== null && max !== null && value.last_used_percent >= min && value.last_used_percent <= max);
};

export const readClaudeCapacityRollup = (value: unknown): ClaudeCapacityRollupPoint | null => {
  if (!isRecord(value) || value.v !== 1) return null;
  if (!claudeCapacityTimestamp(value.bucket_start_at_ms) || value.bucket_start_at_ms % CLAUDE_CAPACITY_ROLLUP_BUCKET_MS !== 0) return null;
  if (!validRollupIdentity(value)) return null;
  if (!claudeCapacityOptionalTimestamp(value.reset_at_ms)) return null;
  const counts = [value.samples, value.available_sample_count, value.unavailable_sample_count];
  if (!counts.every(claudeCapacityTimestamp) || value.samples === 0) return null;
  if (Number(value.available_sample_count) + Number(value.unavailable_sample_count) !== value.samples) return null;
  if (!claudeCapacityTimestamp(value.first_sampled_at_ms) || !claudeCapacityTimestamp(value.last_sampled_at_ms)) return null;
  if (value.first_sampled_at_ms > value.last_sampled_at_ms) return null;
  if (!claudeCapacityOptionalTimestamp(value.first_source_observed_at_ms) || !claudeCapacityOptionalTimestamp(value.last_source_observed_at_ms)) return null;
  if (![value.min_used_percent, value.max_used_percent, value.last_used_percent].every(claudeCapacityPercent)) return null;
  if (value.last_status !== null && typeof value.last_status !== "string") return null;
  const point = value as ClaudeCapacityRollupPoint;
  return validRollupOrder(point) ? point : null;
};

export const claudeCapacityRollupKey = (point: ClaudeCapacityHistoryPoint, window: ClaudeCapacityWindowId): KvKey => [
  ...CLAUDE_CAPACITY_ROLLUP_PREFIX,
  Math.floor((point.windows[window]?.observed_at_ms ?? point.source_observed_at_ms ?? point.sampled_at_ms) / CLAUDE_CAPACITY_ROLLUP_BUCKET_MS) *
    CLAUDE_CAPACITY_ROLLUP_BUCKET_MS,
  point.account_id,
  point.account_cohort_id,
  window,
  point.windows[window]?.reset_at_ms ?? "unknown",
];

/** Counts retained observations, not requests or inferred subscription entitlement. */
export const mergeClaudeCapacityRollup = (
  previous: ClaudeCapacityRollupPoint | null,
  point: ClaudeCapacityHistoryPoint,
  window: ClaudeCapacityWindowId
): ClaudeCapacityRollupPoint => {
  const observed = point.windows[window];
  const bucket = Number(claudeCapacityRollupKey(point, window)[CLAUDE_CAPACITY_ROLLUP_PREFIX.length]);
  if (
    previous &&
    (previous.bucket_start_at_ms !== bucket ||
      previous.account_id !== point.account_id ||
      previous.account_cohort_id !== point.account_cohort_id ||
      previous.credential_kind !== point.credential_kind ||
      previous.workspace_id !== point.workspace_id ||
      previous.window !== window ||
      previous.reset_at_ms !== (observed?.reset_at_ms ?? null))
  )
    throw new Error("Claude rollup binding mismatch");
  const sourceAt = observed?.observed_at_ms ?? point.source_observed_at_ms;
  const used = observed?.used_percent ?? null;
  const newer = !previous || (sourceAt ?? point.sampled_at_ms) >= (previous.last_source_observed_at_ms ?? previous.last_sampled_at_ms);
  const values = [previous?.min_used_percent, previous?.max_used_percent, used].filter((value): value is number => typeof value === "number");
  const sourceTimes = [previous?.first_source_observed_at_ms, previous?.last_source_observed_at_ms, sourceAt].filter(
    (value): value is number => typeof value === "number"
  );
  return {
    v: 1,
    bucket_start_at_ms: bucket,
    account_id: point.account_id,
    account_cohort_id: point.account_cohort_id,
    credential_kind: point.credential_kind,
    workspace_id: point.workspace_id,
    window,
    reset_at_ms: observed?.reset_at_ms ?? null,
    samples: (previous?.samples ?? 0) + 1,
    available_sample_count: (previous?.available_sample_count ?? 0) + (point.state === "available" ? 1 : 0),
    unavailable_sample_count: (previous?.unavailable_sample_count ?? 0) + (point.state === "unavailable" ? 1 : 0),
    first_source_observed_at_ms: sourceTimes.length ? Math.min(...sourceTimes) : null,
    last_source_observed_at_ms: sourceTimes.length ? Math.max(...sourceTimes) : null,
    first_sampled_at_ms: Math.min(previous?.first_sampled_at_ms ?? point.sampled_at_ms, point.sampled_at_ms),
    last_sampled_at_ms: Math.max(previous?.last_sampled_at_ms ?? point.sampled_at_ms, point.sampled_at_ms),
    min_used_percent: values.length ? Math.min(...values) : null,
    max_used_percent: values.length ? Math.max(...values) : null,
    last_used_percent: newer ? used : previous.last_used_percent,
    last_status: newer ? (observed?.status ?? null) : previous.last_status,
  };
};

const rollupForEntry = (entry: KvEntry<unknown>, first: number, last: number, nowMs: number): ClaudeCapacityRollupPoint | null => {
  if (!CLAUDE_CAPACITY_ROLLUP_PREFIX.every((part, index) => entry.key[index] === part)) return null;
  const keyBucket = entry.key[CLAUDE_CAPACITY_ROLLUP_PREFIX.length];
  if (typeof keyBucket !== "number" || keyBucket < first || keyBucket > last) return null;
  const point = readClaudeCapacityRollup(entry.value);
  if (!point || point.last_sampled_at_ms > nowMs) throw new Error("Claude rollup evidence is corrupt");
  if (
    JSON.stringify(entry.key) !==
    JSON.stringify([
      ...CLAUDE_CAPACITY_ROLLUP_PREFIX,
      point.bucket_start_at_ms,
      point.account_id,
      point.account_cohort_id,
      point.window,
      point.reset_at_ms ?? "unknown",
    ])
  )
    throw new Error("Claude rollup key is corrupt");
  return point;
};

export const listClaudeCapacityRollups = async (
  kv: Kv | null,
  sinceMs: number,
  nowMs: number
): Promise<Readonly<{ scan: "ok" | "unavailable"; truncated: boolean; points: readonly ClaudeCapacityRollupPoint[] }>> => {
  if (!kv) return { scan: "unavailable", truncated: false, points: [] };
  const points: ClaudeCapacityRollupPoint[] = [];
  try {
    const firstHour = Math.floor(sinceMs / CLAUDE_CAPACITY_ROLLUP_BUCKET_MS) * CLAUDE_CAPACITY_ROLLUP_BUCKET_MS;
    const lastHour = Math.floor(nowMs / CLAUDE_CAPACITY_ROLLUP_BUCKET_MS) * CLAUDE_CAPACITY_ROLLUP_BUCKET_MS;
    let scanned = 0;
    let truncated = false;
    for await (const entry of kv.list(
      { start: [...CLAUDE_CAPACITY_ROLLUP_PREFIX, firstHour], end: [...CLAUDE_CAPACITY_ROLLUP_PREFIX, lastHour + CLAUDE_CAPACITY_ROLLUP_BUCKET_MS] },
      { limit: CLAUDE_CAPACITY_READ_LIMIT + 1, reverse: true }
    )) {
      if (++scanned > CLAUDE_CAPACITY_READ_LIMIT) {
        truncated = true;
        break;
      }
      const point = rollupForEntry(entry, firstHour, lastHour, nowMs);
      if (point) points.push(point);
    }
    return { scan: "ok", truncated, points: points.toSorted((a, b) => a.bucket_start_at_ms - b.bucket_start_at_ms) };
  } catch {
    return { scan: "unavailable", truncated: false, points: [] };
  }
};
