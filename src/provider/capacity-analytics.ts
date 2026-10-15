// Analytics-only capacity observations pushed by another gateway.
//
// These rows augment the admin chart history; routing and reset fences continue
// to read only the operational local history in capacity-history.ts. Keeping
// the namespace separate makes the chart union additive and never changes a
// local probe, lease, reset event, or routing decision.

import { PROVIDER_CAPACITY_HISTORY_BUCKET_MS, PROVIDER_CAPACITY_HISTORY_RETENTION_MS, type ProviderCapacityHistoryPoint } from "./capacity-contract.ts";
import { readStoredHistoryPoint } from "./capacity-parse.ts";

export const REMOTE_CAPACITY_OBSERVATION_PREFIX = ["uos_ai", "provider_capacity", "analytics", "remote"] as const;

/** Seven days of fifteen-minute points is at most 672 per host; this bound leaves headroom for a clock skew bucket. */
export const MAX_REMOTE_CAPACITY_OBSERVATIONS = 4096;

const remoteCapacityObservationKey = (host: string, bucketStartAtMs: number): Deno.KvKey => [...REMOTE_CAPACITY_OBSERVATION_PREFIX, host, bucketStartAtMs];

/** Host ids are bounded lowercase labels so a pushed row cannot widen the key space. */
export const isRemoteCapacityHostId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value);

/** Parses one pushed history batch or returns null when any row is malformed. */
export const parseRemoteCapacityObservations = (value: unknown): ProviderCapacityHistoryPoint[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REMOTE_CAPACITY_OBSERVATIONS) return null;
  const points: ProviderCapacityHistoryPoint[] = [];
  for (const candidate of value) {
    const point = readStoredHistoryPoint(candidate);
    if (!point) return null;
    points.push(point);
  }
  return points;
};

/** Writes only retention-eligible points and returns the accepted count. */
export const storeRemoteCapacityObservations = async (
  kv: Deno.Kv,
  host: string,
  points: readonly ProviderCapacityHistoryPoint[],
  nowMs: number
): Promise<number> => {
  const cutoffMs = Math.max(0, nowMs - PROVIDER_CAPACITY_HISTORY_RETENTION_MS);
  const newestBucketMs = nowMs + PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  let accepted = 0;
  for (const point of points) {
    if (point.bucket_start_at_ms < cutoffMs || point.bucket_start_at_ms > newestBucketMs) continue;
    await kv.set(remoteCapacityObservationKey(host, point.bucket_start_at_ms), point, { expireIn: PROVIDER_CAPACITY_HISTORY_RETENTION_MS });
    accepted += 1;
  }
  return accepted;
};

/** Reads every retained pushed point. A failed scan reports no remote rows. */
export const readRemoteCapacityObservations = async (kv: Deno.Kv, nowMs: number): Promise<ProviderCapacityHistoryPoint[]> => {
  const cutoffMs = Math.max(0, nowMs - PROVIDER_CAPACITY_HISTORY_RETENTION_MS);
  const newestBucketMs = nowMs + PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const points: ProviderCapacityHistoryPoint[] = [];
  try {
    for await (const entry of kv.list({ prefix: REMOTE_CAPACITY_OBSERVATION_PREFIX })) {
      const point = readStoredHistoryPoint(entry.value);
      if (!point || point.bucket_start_at_ms < cutoffMs || point.bucket_start_at_ms > newestBucketMs) continue;
      points.push(point);
    }
  } catch {
    return [];
  }
  return points.sort((left, right) => left.sampled_at_ms - right.sampled_at_ms || left.bucket_start_at_ms - right.bucket_start_at_ms);
};

/** Dedupe by sample identity; the local observation wins an exact collision. */
export const mergeCapacityHistory = (
  local: readonly ProviderCapacityHistoryPoint[],
  remote: readonly ProviderCapacityHistoryPoint[]
): ProviderCapacityHistoryPoint[] => {
  const bySample = new Map<string, ProviderCapacityHistoryPoint>();
  for (const point of remote) bySample.set(`${point.bucket_start_at_ms}:${point.sampled_at_ms}`, point);
  for (const point of local) bySample.set(`${point.bucket_start_at_ms}:${point.sampled_at_ms}`, point);
  return [...bySample.values()].sort((left, right) => left.sampled_at_ms - right.sampled_at_ms || left.bucket_start_at_ms - right.bucket_start_at_ms);
};
