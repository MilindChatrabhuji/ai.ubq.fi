// Analytics-only capacity observations pushed by another gateway.
//
// These rows augment the admin chart history; routing and reset fences continue
// to read only the operational local history in capacity-history.ts. Keeping
// the namespace separate makes the chart additive and never changes a local
// probe, lease, reset event, or routing decision.
//
// The receiving gateway's own history stays canonical. A pushed sample only
// fills a fifteen-minute bucket the receiver did not observe, and only when the
// sample shows every configured Codex account available under the same slot
// accounts as a neighbouring local sample. The pusher's own 401 or unreachable
// samples, and samples taken against other slot accounts, never enter the chart.

import type { Kv, KvKey } from "#kv";
import {
  PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
  PROVIDER_CAPACITY_HISTORY_RETENTION_MS,
  type ProviderCapacityCodexSource,
  type ProviderCapacityHistoryPoint,
} from "./capacity-contract.ts";
import { readStoredHistoryPoint } from "./capacity-parse.ts";

export const REMOTE_CAPACITY_OBSERVATION_PREFIX = ["uos_ai", "provider_capacity", "analytics", "remote"] as const;

/**
 * Rows in one ingest request. This is below a full week of fifteen-minute
 * buckets (672): the pushing gateway sends only samples newer than the last
 * acknowledged one, oldest first, one batch per poll.
 */
export const MAX_REMOTE_CAPACITY_OBSERVATIONS = 512;

/** A stored point is about 1.4 KB; one row may not approach the KV value limit. */
const MAX_REMOTE_CAPACITY_OBSERVATION_BYTES = 16 * 1024;

/** Rows per KV transaction: one commit per batch instead of one write per row, far inside the KV mutation limits. */
const REMOTE_CAPACITY_WRITE_BATCH = 64;

export type RemoteCapacityObservation = Readonly<{ host: string; point: ProviderCapacityHistoryPoint }>;

// Same-bucket transition points (exhausted, then refilled) differ only by sample time.
const remoteCapacityObservationKey = (host: string, point: ProviderCapacityHistoryPoint): KvKey => [
  ...REMOTE_CAPACITY_OBSERVATION_PREFIX,
  host,
  point.bucket_start_at_ms,
  point.sampled_at_ms,
];

/** Host ids are bounded lowercase labels so a pushed row cannot widen the key space. */
export const isRemoteCapacityHostId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value);

/** A point whose bucket starts on a fifteen-minute boundary and whose sample falls inside that bucket. */
const isBucketedSample = (point: ProviderCapacityHistoryPoint): boolean =>
  point.bucket_start_at_ms % PROVIDER_CAPACITY_HISTORY_BUCKET_MS === 0 &&
  point.sampled_at_ms >= point.bucket_start_at_ms &&
  point.sampled_at_ms < point.bucket_start_at_ms + PROVIDER_CAPACITY_HISTORY_BUCKET_MS;

const encoder = new TextEncoder();

/** Parses one pushed history batch or returns null when the batch or any row is out of bounds or malformed. */
export const parseRemoteCapacityObservations = (value: unknown): ProviderCapacityHistoryPoint[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REMOTE_CAPACITY_OBSERVATIONS) return null;
  const points: ProviderCapacityHistoryPoint[] = [];
  for (const candidate of value) {
    const point = readStoredHistoryPoint(candidate);
    if (!point || !isBucketedSample(point) || encoder.encode(JSON.stringify(point)).byteLength > MAX_REMOTE_CAPACITY_OBSERVATION_BYTES) return null;
    points.push(point);
  }
  return points;
};

const retentionWindow = (nowMs: number): Readonly<{ cutoffMs: number; newestBucketMs: number }> => ({
  cutoffMs: Math.max(0, nowMs - PROVIDER_CAPACITY_HISTORY_RETENTION_MS),
  newestBucketMs: nowMs + PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
});

/**
 * Writes the retention-eligible points in bounded atomic batches and returns
 * the accepted count. A batch that fails to commit throws, so the caller never
 * acknowledges rows that were not stored.
 */
export const storeRemoteCapacityObservations = async (
  kv: Kv,
  host: string,
  points: readonly ProviderCapacityHistoryPoint[],
  nowMs: number
): Promise<number> => {
  const { cutoffMs, newestBucketMs } = retentionWindow(nowMs);
  const rows = new Map<string, ProviderCapacityHistoryPoint>();
  for (const point of points) {
    if (point.bucket_start_at_ms < cutoffMs || point.bucket_start_at_ms > newestBucketMs) continue;
    rows.set(`${point.bucket_start_at_ms}:${point.sampled_at_ms}`, point);
  }
  const accepted = [...rows.values()];
  for (let start = 0; start < accepted.length; start += REMOTE_CAPACITY_WRITE_BATCH) {
    let operation = kv.atomic();
    for (const point of accepted.slice(start, start + REMOTE_CAPACITY_WRITE_BATCH)) {
      operation = operation.set(remoteCapacityObservationKey(host, point), point, { expireIn: PROVIDER_CAPACITY_HISTORY_RETENTION_MS });
    }
    const committed = await operation.commit();
    if (!committed.ok) throw new Error("Remote capacity observation batch was not committed");
  }
  return accepted.length;
};

const bySample = (left: ProviderCapacityHistoryPoint, right: ProviderCapacityHistoryPoint): number =>
  left.sampled_at_ms - right.sampled_at_ms || left.bucket_start_at_ms - right.bucket_start_at_ms;

/** Reads every retained pushed point with its host. A failed scan reports no remote rows. */
export const readRemoteCapacityObservations = async (kv: Kv, nowMs: number): Promise<RemoteCapacityObservation[]> => {
  const { cutoffMs, newestBucketMs } = retentionWindow(nowMs);
  const observations: RemoteCapacityObservation[] = [];
  try {
    for await (const entry of kv.list({ prefix: REMOTE_CAPACITY_OBSERVATION_PREFIX })) {
      // Rows written before the sample time joined the key end at the bucket; both shapes start with the host.
      const host = entry.key[REMOTE_CAPACITY_OBSERVATION_PREFIX.length];
      const point = readStoredHistoryPoint(entry.value);
      if (!isRemoteCapacityHostId(host) || !point || !isBucketedSample(point)) continue;
      if (point.bucket_start_at_ms < cutoffMs || point.bucket_start_at_ms > newestBucketMs) continue;
      observations.push({ host, point });
    }
  } catch {
    return [];
  }
  return observations.sort((left, right) => bySample(left.point, right.point) || left.host.localeCompare(right.host));
};

const codexSlot = (point: ProviderCapacityHistoryPoint, slot: 1 | 2): ProviderCapacityCodexSource | undefined =>
  point.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === slot);

const NOT_CONFIGURED_SLOT = "not_configured";

/** The account a slot reports: its credential cohort, the unconfigured marker, or null when unknown. */
const slotAccount = (source: ProviderCapacityCodexSource | undefined): string | null => {
  if (!source) return null;
  return source.failure_kind === "not_configured" ? NOT_CONFIGURED_SLOT : source.account_cohort_id;
};

/** Every configured Codex slot is available with a known cohort, and at least one slot is configured. */
const isAvailableSample = (point: ProviderCapacityHistoryPoint): boolean => {
  let configured = 0;
  for (const slot of [1, 2] as const) {
    const source = codexSlot(point, slot);
    if (!source) return false;
    if (source.failure_kind === "not_configured") continue;
    if (source.state !== "available" || source.account_cohort_id === null) return false;
    configured += 1;
  }
  return configured > 0;
};

const sameSlotAccounts = (left: ProviderCapacityHistoryPoint, right: ProviderCapacityHistoryPoint): boolean =>
  ([1, 2] as const).every((slot) => {
    const account = slotAccount(codexSlot(left, slot));
    return account !== null && account === slotAccount(codexSlot(right, slot));
  });

/** True when the closest local sample before or after `point` reports the same slot accounts. */
const matchesLocalNeighbour = (ordered: readonly ProviderCapacityHistoryPoint[], point: ProviderCapacityHistoryPoint): boolean => {
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ordered[middle].sampled_at_ms < point.sampled_at_ms) low = middle + 1;
    else high = middle;
  }
  const before = low > 0 ? ordered[low - 1] : undefined;
  const after = low < ordered.length ? ordered[low] : undefined;
  return (before !== undefined && sameSlotAccounts(before, point)) || (after !== undefined && sameSlotAccounts(after, point));
};

/**
 * Returns the local history plus the pushed samples that fill buckets the
 * local gateway never observed. A pushed sample qualifies only when it is
 * available and reports the same slot accounts as the closest local sample on
 * either side; a gap bucket is filled from one pushing host only. A gateway
 * with no local samples takes none, because there is nothing to match against.
 */
export const mergeCapacityHistory = (
  local: readonly ProviderCapacityHistoryPoint[],
  remote: readonly RemoteCapacityObservation[]
): ProviderCapacityHistoryPoint[] => {
  const ordered = [...local].sort(bySample);
  const localBuckets = new Set(ordered.map((point) => point.bucket_start_at_ms));
  const gapFills = new Map<number, Map<string, Map<number, ProviderCapacityHistoryPoint>>>();
  for (const { host, point } of remote) {
    if (localBuckets.has(point.bucket_start_at_ms) || !isAvailableSample(point) || !matchesLocalNeighbour(ordered, point)) continue;
    const hosts = gapFills.get(point.bucket_start_at_ms) ?? new Map<string, Map<number, ProviderCapacityHistoryPoint>>();
    const samples = hosts.get(host) ?? new Map<number, ProviderCapacityHistoryPoint>();
    samples.set(point.sampled_at_ms, point);
    hosts.set(host, samples);
    gapFills.set(point.bucket_start_at_ms, hosts);
  }
  const merged = [...ordered];
  for (const hosts of gapFills.values()) {
    const host = [...hosts.keys()].sort((left, right) => left.localeCompare(right))[0];
    merged.push(...(hosts.get(host)?.values() ?? []));
  }
  return merged.sort(bySample);
};
