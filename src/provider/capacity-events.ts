import type { Kv, KvEntryMaybe, KvKey } from "#kv";
import {
  CODEX_RESET_REDEMPTION_KV_PREFIX,
  CODEX_RESET_SHADOW_DECISION_KV_PREFIX,
  parseCodexResetRedemptionRecord,
  parseCodexResetShadowDecisionRecord,
} from "../codex/banked-reset.ts";
import { getKv } from "../kv.ts";
import { PROVIDER_CAPACITY_HISTORY_BUCKET_MS } from "./capacity-contract.ts";
import { isRecord } from "../utils.ts";

/** Redacted, short-lived evidence used only to annotate the capacity chart. */
export const PROVIDER_CAPACITY_RESET_EVENT_KV_PREFIX = ["uos_ai", "provider_capacity", "v1", "reset_event"] as const;
export const PROVIDER_CAPACITY_RESET_EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const PROVIDER_CAPACITY_RATE_LIMIT_RESET_EVENT_KV_PREFIX = ["uos_ai", "provider_capacity", "v1", "rate_limit_reset_event"] as const;
export const PROVIDER_CAPACITY_DOWNTIME_EVENT_KV_PREFIX = ["uos_ai", "provider_capacity", "v1", "downtime_event"] as const;
export const PROVIDER_CAPACITY_DOWNTIME_EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type ProviderCapacityDowntimeFailureKind = "upstream_error" | "unreachable";

export type ProviderCapacityResetEvent = Readonly<{
  v: 1;
  event_id: string;
  slot: 1 | 2;
  observed_at_ms: number;
}>;

export type ProviderCapacityRateLimitResetEvent = Readonly<{
  v: 1;
  event_id: string;
  provider: "openai";
  slot: 1 | 2;
  window: "primary" | "secondary";
  observed_at_ms: number;
  previous_sampled_at_ms: number;
  previous_reset_at_ms: number;
  reset_at_ms: number;
  previous_used_percent: number;
  current_used_percent: number;
  capacity_gain_percentage_points: number;
}>;

export type ProviderCapacityDowntimeEvent = Readonly<{
  v: 1;
  event_id: string;
  provider: "openai";
  failure_kind: ProviderCapacityDowntimeFailureKind;
  status: number | null;
  observed_at_ms: number;
}>;

export const providerCapacityResetEventKey = (eventId: string): KvKey => [...PROVIDER_CAPACITY_RESET_EVENT_KV_PREFIX, eventId];

export const providerCapacityRateLimitResetEventKey = (eventId: string): KvKey => [...PROVIDER_CAPACITY_RATE_LIMIT_RESET_EVENT_KV_PREFIX, eventId];

export const providerCapacityDowntimeEventKey = (eventId: string): KvKey => [...PROVIDER_CAPACITY_DOWNTIME_EVENT_KV_PREFIX, eventId];

const isSafeTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isNonEmptyText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;

const isPercent = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

export const parseProviderCapacityResetEvent = (value: unknown): ProviderCapacityResetEvent | null => {
  if (!isRecord(value) || value.v !== 1 || !isNonEmptyText(value.event_id)) return null;
  if ((value.slot !== 1 && value.slot !== 2) || !isSafeTimestamp(value.observed_at_ms)) return null;
  return {
    v: 1,
    event_id: value.event_id,
    slot: value.slot,
    observed_at_ms: value.observed_at_ms,
  };
};

export const parseProviderCapacityRateLimitResetEvent = (value: unknown): ProviderCapacityRateLimitResetEvent | null => {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    !isNonEmptyText(value.event_id) ||
    value.provider !== "openai" ||
    (value.slot !== 1 && value.slot !== 2) ||
    (value.window !== "primary" && value.window !== "secondary") ||
    !isSafeTimestamp(value.observed_at_ms) ||
    !isSafeTimestamp(value.previous_sampled_at_ms) ||
    !isSafeTimestamp(value.previous_reset_at_ms) ||
    !isSafeTimestamp(value.reset_at_ms) ||
    !isPercent(value.previous_used_percent) ||
    !isPercent(value.current_used_percent) ||
    !isPercent(value.capacity_gain_percentage_points)
  )
    return null;
  if (
    value.previous_sampled_at_ms >= value.observed_at_ms ||
    value.previous_reset_at_ms >= value.reset_at_ms ||
    Math.abs(value.previous_used_percent - value.current_used_percent - value.capacity_gain_percentage_points) > 0.001
  )
    return null;
  return {
    v: 1,
    event_id: value.event_id,
    provider: "openai",
    slot: value.slot,
    window: value.window,
    observed_at_ms: value.observed_at_ms,
    previous_sampled_at_ms: value.previous_sampled_at_ms,
    previous_reset_at_ms: value.previous_reset_at_ms,
    reset_at_ms: value.reset_at_ms,
    previous_used_percent: value.previous_used_percent,
    current_used_percent: value.current_used_percent,
    capacity_gain_percentage_points: value.capacity_gain_percentage_points,
  };
};

export const parseProviderCapacityDowntimeEvent = (value: unknown): ProviderCapacityDowntimeEvent | null => {
  if (!isRecord(value) || value.v !== 1 || !isNonEmptyText(value.event_id) || value.provider !== "openai") return null;
  if (value.failure_kind !== "upstream_error" && value.failure_kind !== "unreachable") return null;
  if (!(value.status === null || (typeof value.status === "number" && Number.isSafeInteger(value.status) && value.status >= 500 && value.status <= 599)))
    return null;
  if (!isSafeTimestamp(value.observed_at_ms)) return null;
  return {
    v: 1,
    event_id: value.event_id,
    provider: "openai",
    failure_kind: value.failure_kind,
    status: value.status,
    observed_at_ms: value.observed_at_ms,
  };
};

const resolveKv = async (kvOverride: Kv | null | undefined): Promise<Kv | null> => {
  if (kvOverride !== undefined) return kvOverride;
  try {
    return await getKv();
  } catch {
    return null;
  }
};

const writeResetEvent = async (kv: Kv, event: ProviderCapacityResetEvent): Promise<boolean> => {
  const key = providerCapacityResetEventKey(event.event_id);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let entry: KvEntryMaybe<unknown>;
    try {
      entry = await kv.get(key, { consistency: "strong" });
    } catch {
      return false;
    }
    const existing = entry.value === null ? null : parseProviderCapacityResetEvent(entry.value);
    if (existing) return existing.slot === event.slot && existing.observed_at_ms === event.observed_at_ms;
    try {
      const committed = await kv.atomic().check(entry).set(key, event, { expireIn: PROVIDER_CAPACITY_RESET_EVENT_RETENTION_MS }).commit();
      if (committed.ok) return true;
    } catch {
      return false;
    }
  }
  return false;
};

export const recordProviderCapacityResetEvent = async (event: ProviderCapacityResetEvent, kvOverride?: Kv | null): Promise<boolean> => {
  const kv = await resolveKv(kvOverride);
  return kv ? await writeResetEvent(kv, event) : false;
};

export const listProviderCapacityRateLimitResetEvents = async (
  options: Readonly<{ kv?: Kv | null; now?: () => number }> = {}
): Promise<readonly ProviderCapacityRateLimitResetEvent[]> => {
  const kv = await resolveKv(options.kv);
  if (!kv) return [];
  const rawNow = Math.trunc(options.now?.() ?? Date.now());
  const nowMs = Number.isSafeInteger(rawNow) && rawNow >= 0 ? rawNow : Date.now();
  const cutoffMs = Math.max(0, nowMs - PROVIDER_CAPACITY_RESET_EVENT_RETENTION_MS);
  const events: ProviderCapacityRateLimitResetEvent[] = [];
  try {
    for await (const entry of kv.list({ prefix: PROVIDER_CAPACITY_RATE_LIMIT_RESET_EVENT_KV_PREFIX })) {
      const event = parseProviderCapacityRateLimitResetEvent(entry.value);
      if (event && event.observed_at_ms >= cutoffMs && event.observed_at_ms <= nowMs) events.push(event);
    }
  } catch {
    return [];
  }
  return events.sort((left, right) => left.observed_at_ms - right.observed_at_ms || left.event_id.localeCompare(right.event_id));
};

const writeDowntimeEvent = async (kv: Kv, event: ProviderCapacityDowntimeEvent): Promise<boolean> => {
  const key = providerCapacityDowntimeEventKey(event.event_id);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let entry: KvEntryMaybe<unknown>;
    try {
      entry = await kv.get(key, { consistency: "strong" });
    } catch {
      return false;
    }
    if (entry.value !== null) return parseProviderCapacityDowntimeEvent(entry.value) !== null;
    try {
      const committed = await kv.atomic().check(entry).set(key, event, { expireIn: PROVIDER_CAPACITY_DOWNTIME_EVENT_RETENTION_MS }).commit();
      if (committed.ok) return true;
    } catch {
      return false;
    }
  }
  return false;
};

const downtimeBucketStartAtMs = (observedAtMs: number): number => Math.floor(observedAtMs / (15 * 60_000)) * 15 * 60_000;

/**
 * Record one redacted OpenAI incident per 15-minute chart segment. The event
 * contains no request, account, URL, or provider body data.
 */
export const recordProviderCapacityDowntimeEvent = async (
  input: Readonly<{
    failure_kind: ProviderCapacityDowntimeFailureKind;
    status: number | null;
    observed_at_ms: number;
  }>,
  kvOverride?: Kv | null
): Promise<boolean> => {
  if (!isSafeTimestamp(input.observed_at_ms)) return false;
  if (input.status !== null && (!Number.isSafeInteger(input.status) || input.status < 500 || input.status > 599)) return false;
  const event: ProviderCapacityDowntimeEvent = {
    v: 1,
    event_id: `openai-${downtimeBucketStartAtMs(input.observed_at_ms)}`,
    provider: "openai",
    failure_kind: input.failure_kind,
    status: input.status,
    observed_at_ms: input.observed_at_ms,
  };
  const kv = await resolveKv(kvOverride);
  return kv ? await writeDowntimeEvent(kv, event) : false;
};

export const listProviderCapacityDowntimeEvents = async (
  options: Readonly<{ kv?: Kv | null; now?: () => number }> = {}
): Promise<readonly ProviderCapacityDowntimeEvent[]> => {
  const kv = await resolveKv(options.kv);
  if (!kv) return [];
  const rawNow = Math.trunc(options.now?.() ?? Date.now());
  const nowMs = Number.isSafeInteger(rawNow) && rawNow >= 0 ? rawNow : Date.now();
  const cutoffMs = Math.max(0, nowMs - PROVIDER_CAPACITY_DOWNTIME_EVENT_RETENTION_MS);
  const events: ProviderCapacityDowntimeEvent[] = [];
  try {
    for await (const entry of kv.list({ prefix: PROVIDER_CAPACITY_DOWNTIME_EVENT_KV_PREFIX })) {
      const event = parseProviderCapacityDowntimeEvent(entry.value);
      if (event && event.observed_at_ms >= cutoffMs && event.observed_at_ms <= nowMs) events.push(event);
    }
  } catch {
    return [];
  }
  return events.sort((left, right) => left.observed_at_ms - right.observed_at_ms || left.event_id.localeCompare(right.event_id));
};

type ResetShadowFence = Readonly<{
  slot: number;
  account_id_hash: string;
  quota_generation: string;
}>;

const readBackfillableEvents = async (kv: Kv, cutoffMs: number, nowMs: number): Promise<ProviderCapacityResetEvent[]> => {
  const decisions: ResetShadowFence[] = [];
  const redemptions: ProviderCapacityResetEvent[] = [];
  try {
    for await (const entry of kv.list({ prefix: CODEX_RESET_SHADOW_DECISION_KV_PREFIX })) {
      const decision = parseCodexResetShadowDecisionRecord(entry.value);
      if (!decision) continue;
      for (const fence of decision.fences) {
        if (fence.slot === 1 || fence.slot === 2) {
          decisions.push({
            slot: fence.slot,
            account_id_hash: fence.account_id_hash,
            quota_generation: fence.quota_generation,
          });
        }
      }
    }
    for await (const entry of kv.list({ prefix: CODEX_RESET_REDEMPTION_KV_PREFIX })) {
      const record = parseCodexResetRedemptionRecord(entry.value);
      if (record?.state !== "verified" || record.verified_at_ms === null || record.verified_at_ms < cutoffMs || record.verified_at_ms > nowMs) continue;
      const fence = decisions.find(
        (candidate) => candidate.account_id_hash === record.account_id_hash && candidate.quota_generation === record.quota_generation
      );
      if (!fence || (fence.slot !== 1 && fence.slot !== 2)) continue;
      redemptions.push({
        v: 1,
        event_id: record.idempotency_key_hash,
        slot: fence.slot,
        observed_at_ms: record.verified_at_ms,
      });
    }
  } catch {
    return [];
  }
  return redemptions;
};

/**
 * Read recent reset markers and derive any missing markers from verified
 * redemption records. The derivation is intentionally best effort: an
 * unverified or unmapped redemption must never become a chart assertion.
 */
export const listProviderCapacityResetEvents = async (
  options: Readonly<{ kv?: Kv | null; now?: () => number }> = {}
): Promise<readonly ProviderCapacityResetEvent[]> => {
  const kv = await resolveKv(options.kv);
  if (!kv) return [];
  const rawNow = Math.trunc(options.now?.() ?? Date.now());
  const nowMs = Number.isSafeInteger(rawNow) && rawNow >= 0 ? rawNow : Date.now();
  const cutoffMs = Math.max(0, nowMs - PROVIDER_CAPACITY_RESET_EVENT_RETENTION_MS);
  const events = new Map<string, ProviderCapacityResetEvent>();
  try {
    for await (const entry of kv.list({ prefix: PROVIDER_CAPACITY_RESET_EVENT_KV_PREFIX })) {
      const event = parseProviderCapacityResetEvent(entry.value);
      if (event && event.observed_at_ms >= cutoffMs && event.observed_at_ms <= nowMs) {
        events.set(event.event_id, event);
      }
    }
  } catch {
    return [];
  }

  for (const event of await readBackfillableEvents(kv, cutoffMs, nowMs)) {
    if (!events.has(event.event_id)) {
      await writeResetEvent(kv, event);
      events.set(event.event_id, event);
    }
  }

  return [...events.values()].sort((left, right) => left.observed_at_ms - right.observed_at_ms || left.event_id.localeCompare(right.event_id));
};

/**
 * One capacity probe per history bucket, driven by an observation rather than a
 * clock. This lives beside the event recorders and imports the sampler lazily so
 * the Codex request path can report an observation without importing the sampler
 * module, which imports the Codex module back.
 *
 * `PROVIDER_CAPACITY_HISTORY_BUCKET_MS` is the debounce: the first observation in
 * a bucket samples, later observations in the same bucket are no-ops. The sampler
 * keeps its own lease, so two processes cannot probe at once. Fire-and-forget:
 * telemetry never delays inference or an admin read.
 */
let lastSampledBucketStartAtMs = 0;

const defaultProviderCapacitySampleTrigger = (options: Readonly<{ now?: () => number }>): void => {
  const nowMs = (options.now ?? Date.now)();
  const bucketStartAtMs = Math.floor(nowMs / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  if (bucketStartAtMs <= lastSampledBucketStartAtMs) return;
  lastSampledBucketStartAtMs = bucketStartAtMs;
  void import("./capacity.ts").then((sampler) => sampler.sampleProviderCapacityOnEvent({ now: () => nowMs })).catch(() => {});
};

let providerCapacitySampleTrigger = defaultProviderCapacitySampleTrigger;

/**
 * Tests replace the trigger so a background probe cannot race their fetch and KV
 * expectations; `null` restores the real one.
 */
export const setProviderCapacitySampleTriggerForTest = (trigger: ((options: Readonly<{ now?: () => number }>) => void) | null): void => {
  providerCapacitySampleTrigger = trigger ?? defaultProviderCapacitySampleTrigger;
};

export const triggerProviderCapacitySample = (options: Readonly<{ now?: () => number }> = {}): void => {
  providerCapacitySampleTrigger(options);
};
