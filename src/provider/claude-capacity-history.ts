import type { Kv, KvEntry, KvKey } from "#kv";
import { isRecord, sha256Hex } from "../utils.ts";
import type { ClaudeCodeAcceptedObservation } from "./claude-code-quota.ts";
import type { ClaudeCapacityHistoryPoint, ClaudeCapacityHistoryView, ProviderCapacityClaudeWindow } from "./capacity-contract.ts";
import { PROVIDER_CAPACITY_HISTORY_BUCKET_MS, PROVIDER_CAPACITY_HISTORY_RETENTION_MS, PROVIDER_CAPACITY_SOURCE_STALE_MS } from "./capacity-contract.ts";
import {
  CLAUDE_CAPACITY_READ_LIMIT,
  claudeCapacityIdentity,
  claudeCapacityOptionalTimestamp,
  claudeCapacityPercent,
  claudeCapacityTimestamp,
  claudeCapacityRollupKey,
  mergeClaudeCapacityRollup,
  readClaudeCapacityRollup,
  type ClaudeCapacityWindowId,
} from "./claude-capacity-rollups.ts";

export const CLAUDE_CAPACITY_HISTORY_PREFIX = ["uos_ai", "provider_capacity", "claude", "v1", "history"] as const;
const CLAUDE_CAPACITY_MAX_BUCKET_POINTS = 6;
const WINDOWS = ["five_hour", "seven_day"] as const;
type SamplingFlags = { normal: number; unavailable: boolean; recovery: boolean; five_hour: boolean; seven_day: boolean };
type StoredBucket = {
  v: 1;
  bucket_start_at_ms: number;
  account_id: string;
  account_cohort_id: string;
  points: ClaudeCapacityHistoryPoint[];
  flags: SamplingFlags;
};

export const claudeCapacityUsedPercent = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) || value < 0 ? null : Math.min(100, value * 100);

const readWindow = (value: unknown): ProviderCapacityClaudeWindow | null => {
  if (!isRecord(value) || (value.status !== null && typeof value.status !== "string")) return null;
  if (
    !claudeCapacityPercent(value.used_percent) ||
    !claudeCapacityOptionalTimestamp(value.reset_at_ms) ||
    !claudeCapacityOptionalTimestamp(value.observed_at_ms)
  )
    return null;
  return { status: value.status, used_percent: value.used_percent, reset_at_ms: value.reset_at_ms, observed_at_ms: value.observed_at_ms };
};

const validPointIdentity = (value: Record<string, unknown>): boolean =>
  claudeCapacityIdentity(value.point_id) &&
  claudeCapacityIdentity(value.account_id) &&
  claudeCapacityIdentity(value.account_cohort_id) &&
  (value.credential_kind === "oauth" || value.credential_kind === "api_key") &&
  (value.workspace_id === null || claudeCapacityIdentity(value.workspace_id)) &&
  (value.state === "available" || value.state === "unavailable");

const validPointTimes = (value: Record<string, unknown>): boolean => {
  if (
    !claudeCapacityTimestamp(value.bucket_start_at_ms) ||
    !claudeCapacityTimestamp(value.sampled_at_ms) ||
    !claudeCapacityOptionalTimestamp(value.source_observed_at_ms)
  )
    return false;
  if (value.source_observed_at_ms !== null && value.source_observed_at_ms > value.sampled_at_ms) return false;
  const at = value.source_observed_at_ms ?? value.sampled_at_ms;
  return Math.floor(at / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS === value.bucket_start_at_ms;
};
const validStandard = (value: unknown, sampledAtMs: number): boolean => {
  if (!isRecord(value) || typeof value.family !== "string" || !["requests", "input-tokens", "output-tokens"].includes(value.family)) return false;
  if (![value.limit, value.remaining].every((item) => item === null || (typeof item === "number" && Number.isFinite(item) && item >= 0))) return false;
  if (!claudeCapacityOptionalTimestamp(value.reset_at_ms) || !claudeCapacityOptionalTimestamp(value.observed_at_ms)) return false;
  return value.observed_at_ms === null || value.observed_at_ms <= sampledAtMs;
};
const validPointWindows = (value: Record<string, unknown>): boolean => {
  if (!isRecord(value.windows) || !Array.isArray(value.standard) || value.standard.length > 3 || !claudeCapacityTimestamp(value.sampled_at_ms)) return false;
  const sampledAtMs = value.sampled_at_ms;
  for (const name of WINDOWS) {
    if (value.windows[name] === null) continue;
    const window = readWindow(value.windows[name]);
    if (!window || (window.observed_at_ms !== null && window.observed_at_ms > sampledAtMs)) return false;
  }
  return value.standard.every((standard) => validStandard(standard, sampledAtMs));
};

export const readClaudeCapacityHistoryPoint = (value: unknown): ClaudeCapacityHistoryPoint | null => {
  if (!isRecord(value) || value.v !== 1 || !validPointIdentity(value) || !validPointTimes(value) || !validPointWindows(value)) return null;
  if (
    value.response_status !== null &&
    (typeof value.response_status !== "number" || !Number.isInteger(value.response_status) || value.response_status < 100 || value.response_status > 599)
  )
    return null;
  return value as ClaudeCapacityHistoryPoint;
};

const historyKey = (point: Pick<ClaudeCapacityHistoryPoint, "bucket_start_at_ms" | "account_id" | "account_cohort_id">): KvKey => [
  ...CLAUDE_CAPACITY_HISTORY_PREFIX,
  point.bucket_start_at_ms,
  point.account_id,
  point.account_cohort_id,
];

const readBucket = (value: unknown): StoredBucket | null => {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.points) || value.points.length > CLAUDE_CAPACITY_MAX_BUCKET_POINTS || !isRecord(value.flags))
    return null;
  const points = value.points.map(readClaudeCapacityHistoryPoint).filter((point): point is ClaudeCapacityHistoryPoint => point !== null);
  if (points.length !== value.points.length) return null;
  if (!claudeCapacityTimestamp(value.bucket_start_at_ms) || !claudeCapacityIdentity(value.account_id) || !claudeCapacityIdentity(value.account_cohort_id))
    return null;
  if (
    points.some(
      (point) =>
        point.bucket_start_at_ms !== value.bucket_start_at_ms || point.account_id !== value.account_id || point.account_cohort_id !== value.account_cohort_id
    )
  )
    return null;
  if (new Set(points.map((point) => point.point_id)).size !== points.length) return null;
  const flags = value.flags;
  if (typeof flags.normal !== "number" || ![0, 1, 2].includes(flags.normal)) return null;
  if (!["unavailable", "recovery", ...WINDOWS].every((key) => typeof flags[key] === "boolean")) return null;
  return value as StoredBucket;
};

const pointForObservation = async (event: ClaudeCodeAcceptedObservation): Promise<ClaudeCapacityHistoryPoint | null> => {
  if (!Object.keys(event.observation.windows).length && !Object.keys(event.observation.standard).length) return null;
  const window = (name: "5h" | "7d"): ProviderCapacityClaudeWindow | null => {
    const input = event.observation.windows[name];
    return input
      ? {
          status: input.status,
          used_percent: claudeCapacityUsedPercent(input.utilization),
          reset_at_ms: input.reset_at_ms,
          observed_at_ms: claudeCapacityTimestamp(input.observed_at_ms) ? input.observed_at_ms : null,
        }
      : null;
  };
  const sourceTime = claudeCapacityOptionalTimestamp(event.source_observed_at_ms) ? event.source_observed_at_ms : null;
  const point: ClaudeCapacityHistoryPoint = {
    v: 1,
    // Only the safe event enters this digest, never a credential or its internal fingerprint.
    point_id: await sha256Hex(
      JSON.stringify({
        account: event.account_id,
        cohort: event.account_cohort_id,
        kind: event.credential_kind,
        workspace: event.workspace_id,
        state: event.state,
        response_status: event.response_status,
        observation: event.observation,
      })
    ),
    bucket_start_at_ms: Math.floor((sourceTime ?? event.sampled_at_ms) / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
    sampled_at_ms: event.sampled_at_ms,
    source_observed_at_ms: sourceTime,
    account_id: event.account_id,
    account_cohort_id: event.account_cohort_id,
    credential_kind: event.credential_kind,
    workspace_id: event.workspace_id,
    state: event.state,
    response_status: event.response_status,
    windows: { five_hour: window("5h"), seven_day: window("7d") },
    standard: Object.entries(event.observation.standard).map(([family, item]) => ({ family, ...item })),
  };
  return readClaudeCapacityHistoryPoint(point);
};

const retainPoint = (previous: StoredBucket | null, point: ClaudeCapacityHistoryPoint): StoredBucket | null => {
  if (previous?.points.some((entry) => entry.point_id === point.point_id) || (previous?.points.length ?? 0) >= CLAUDE_CAPACITY_MAX_BUCKET_POINTS) return null;
  const flags: SamplingFlags = { ...(previous?.flags ?? { normal: 0, unavailable: false, recovery: false, five_hour: false, seven_day: false }) };
  const latest = previous?.points.at(-1);
  let retain = flags.normal < 2;
  if (retain) flags.normal += 1;
  if (latest && latest.state !== point.state) {
    const flag = point.state === "unavailable" ? "unavailable" : "recovery";
    if (!flags[flag]) {
      flags[flag] = true;
      retain = true;
    }
  }
  for (const name of WINDOWS) {
    const before = previous?.points.findLast((entry) => entry.windows[name] !== null)?.windows[name];
    const after = point.windows[name];
    if (after && before?.reset_at_ms !== after.reset_at_ms && !flags[name] && !retain) {
      flags[name] = true;
      retain = true;
    }
  }
  if (!retain) return null;
  const points = [...(previous?.points ?? []), point].sort(
    (a, b) => (a.source_observed_at_ms ?? a.sampled_at_ms) - (b.source_observed_at_ms ?? b.sampled_at_ms) || a.sampled_at_ms - b.sampled_at_ms
  );
  return { v: 1, bucket_start_at_ms: point.bucket_start_at_ms, account_id: point.account_id, account_cohort_id: point.account_cohort_id, points, flags };
};

/** Post-acceptance telemetry only. Never writes quota, credentials or routing state. */
export const recordClaudeCapacityObservation = async (kv: Kv, event: ClaudeCodeAcceptedObservation): Promise<void> => {
  const point = await pointForObservation(event);
  if (!point) return;
  const key = historyKey(point);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const entry = await kv.get(key, { consistency: "strong" });
    const previous = readBucket(entry.value);
    // Corrupt evidence is not silently replaced with an apparently complete bucket.
    if (entry.value !== null && (previous === null || JSON.stringify(historyKey(previous)) !== JSON.stringify(key)))
      throw new Error("Claude history bucket is invalid");
    const next = retainPoint(previous, point);
    if (!next) return;
    const rollupWindows = WINDOWS.filter((window) => point.windows[window] !== null);
    const rollups = await Promise.all(
      rollupWindows.map(async (window: ClaudeCapacityWindowId) => ({
        window,
        entry: await kv.get(claudeCapacityRollupKey(point, window), { consistency: "strong" }),
      }))
    );
    let operation = kv
      .atomic()
      .check(entry)
      .set(key, next, {
        expireIn: Math.max(1, point.bucket_start_at_ms + PROVIDER_CAPACITY_HISTORY_BUCKET_MS + PROVIDER_CAPACITY_HISTORY_RETENTION_MS - Date.now()),
      });
    for (const rollup of rollups) {
      const stored = readClaudeCapacityRollup(rollup.entry.value);
      if (rollup.entry.value !== null && stored === null) throw new Error("Claude rollup is invalid");
      operation = operation.check(rollup.entry).set(rollup.entry.key, mergeClaudeCapacityRollup(stored, point, rollup.window));
    }
    if ((await operation.commit()).ok) return;
  }
  throw new Error("Claude history contention exceeded four attempts");
};

const bucketForEntry = (entry: KvEntry<unknown>, first: number, end: number): StoredBucket | null => {
  if (!CLAUDE_CAPACITY_HISTORY_PREFIX.every((part, index) => entry.key[index] === part)) return null;
  const keyBucket = entry.key[CLAUDE_CAPACITY_HISTORY_PREFIX.length];
  if (typeof keyBucket !== "number" || keyBucket < first || keyBucket >= end) return null;
  const bucket = readBucket(entry.value);
  if (!bucket || JSON.stringify(entry.key) !== JSON.stringify(historyKey(bucket))) throw new Error("Claude history evidence is corrupt");
  return bucket;
};

export const readClaudeCapacityHistory = async (kv: Kv | null, nowMs: number): Promise<ClaudeCapacityHistoryView> => {
  const base = {
    v: 1 as const,
    bucket_ms: PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
    retention_ms: PROVIDER_CAPACITY_HISTORY_RETENTION_MS,
    stale_after_ms: PROVIDER_CAPACITY_SOURCE_STALE_MS,
  };
  if (!kv) return { ...base, scan: "unavailable", truncated: false, points: [] };
  const points: ClaudeCapacityHistoryPoint[] = [];
  let scanned = 0;
  let truncated = false;
  const cutoff = Math.max(0, nowMs - PROVIDER_CAPACITY_HISTORY_RETENTION_MS);
  const first = Math.floor(cutoff / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const end = Math.floor(nowMs / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS + PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  try {
    for await (const entry of kv.list(
      { start: [...CLAUDE_CAPACITY_HISTORY_PREFIX, first], end: [...CLAUDE_CAPACITY_HISTORY_PREFIX, end] },
      { limit: CLAUDE_CAPACITY_READ_LIMIT + 1, reverse: true }
    )) {
      if (++scanned > CLAUDE_CAPACITY_READ_LIMIT) {
        truncated = true;
        break;
      }
      const bucket = bucketForEntry(entry, first, end);
      if (!bucket) continue;
      const recent = bucket.points
        .toReversed()
        .filter((point) => point.sampled_at_ms <= nowMs && (point.source_observed_at_ms ?? point.sampled_at_ms) >= cutoff);
      for (const point of recent) {
        if (points.length >= CLAUDE_CAPACITY_READ_LIMIT) {
          truncated = true;
          break;
        }
        points.push(point);
      }
      if (truncated) break;
    }
    return {
      ...base,
      scan: "ok",
      truncated,
      points: points.toSorted((a, b) => (a.source_observed_at_ms ?? a.sampled_at_ms) - (b.source_observed_at_ms ?? b.sampled_at_ms)),
    };
  } catch {
    return { ...base, scan: "unavailable", truncated: false, points: [] };
  }
};
