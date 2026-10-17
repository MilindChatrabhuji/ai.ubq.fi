import type { AtomicOperation, Kv, KvKey } from "#kv";
// Prompt cache analytics core: counters, keys and the recording path, split out of src/prompt_cache_analytics.ts.

import { getKv } from "../kv.ts";

import { PROMPT_CACHE_TELEMETRY_PROVIDERS, PROMPT_CACHE_TELEMETRY_ROUTES } from "./telemetry-gate.ts";
import { RELEASE_GIT_SHA } from "../release.ts";
import { sha256Hex } from "../utils.ts";

/**
 * V2 is a hard namespace cutover. V1 remains outside this prefix and expires
 * according to its existing retention policy; readers never combine it with V2.
 */
export const PROMPT_CACHE_ANALYTICS_KV_PREFIX = ["uos_ai", "prompt_cache_analytics", "v2"] as const;
const LEGACY_PROMPT_CACHE_ANALYTICS_V1_KV_PREFIX = ["uos_ai", "prompt_cache_analytics", "v1"] as const;
export const PROMPT_CACHE_ANALYTICS_BUCKET_MS = 15 * 60_000;
export const PROMPT_CACHE_ANALYTICS_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const PROMPT_CACHE_ANALYTICS_WINDOW_BUCKETS = PROMPT_CACHE_ANALYTICS_WINDOW_MS / PROMPT_CACHE_ANALYTICS_BUCKET_MS;
export const PROMPT_CACHE_ANALYTICS_RETENTION_MS = 8 * 24 * 60 * 60_000;
export const PROMPT_CACHE_ANALYTICS_MAX_COHORTS_PER_BUCKET = 32;
export const PROMPT_CACHE_ANALYTICS_MAX_GROUP_BY = 2;
export const PROMPT_CACHE_ANALYTICS_MAX_RESPONSE_BUCKETS = 512;

export const PROMPT_CACHE_ANALYTICS_DIMENSIONS = ["provider", "model", "route", "key_presence", "mode", "fallback"] as const;
export const PROMPT_CACHE_ANALYTICS_MODES = ["implicit", "explicit", "legacy_retention", "unspecified"] as const;
export const PROMPT_CACHE_ANALYTICS_FALLBACKS = ["none", "primary_429", "primary_quota_blocked", "other"] as const;

const RELEASE_SHA = /^[a-f0-9]{7,64}$/i;
const MAX_MODEL_CHARS = 256;
const COUNTERS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "cache_write_reported_sample_count",
  "sample_count",
  "request_cache_hit_sample_count",
  "usage_reported_sample_count",
  "usage_invalid_sample_count",
  "dimension_cardinality_limited_sample_count",
] as const;

type Counter = (typeof COUNTERS)[number];
type PromptCacheAnalyticsProvider = (typeof PROMPT_CACHE_TELEMETRY_PROVIDERS)[number];
type PromptCacheAnalyticsRoute = (typeof PROMPT_CACHE_TELEMETRY_ROUTES)[number];
export type PromptCacheAnalyticsDimension = (typeof PROMPT_CACHE_ANALYTICS_DIMENSIONS)[number];
type PromptCacheAnalyticsMode = (typeof PROMPT_CACHE_ANALYTICS_MODES)[number];
type PromptCacheAnalyticsFallback = (typeof PROMPT_CACHE_ANALYTICS_FALLBACKS)[number];

type PromptCacheAnalyticsCohort = Readonly<{
  provider: PromptCacheAnalyticsProvider;
  modelHash: string;
  route: PromptCacheAnalyticsRoute;
  promptCacheKeyPresent: boolean;
  mode: PromptCacheAnalyticsMode;
  fallback: PromptCacheAnalyticsFallback;
}>;

type StoredCounters = Partial<Record<Counter, number>>;
type CounterDeltas = Partial<Record<Counter, bigint>>;

/** Usage evidence carried by one recorded outcome. */
type PromptCacheAnalyticsUsage = Readonly<{
  kind: "reported" | "missing" | "invalid";
  deltas: CounterDeltas;
}>;

export type PromptCacheAnalyticsEvent = Readonly<{
  provider: string | null;
  /** Raw model text is accepted only long enough to derive an opaque cohort hash. */
  model?: string | null;
  route: string;
  status: number;
  completed: boolean;
  usageTelemetryStatus: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  promptCacheKeyPresent?: boolean;
  promptCacheMode?: string | null;
  fallbackReason?: string | null;
}>;

export type PromptCacheAnalyticsOptions = Readonly<{
  kv?: Kv | null;
  release?: string;
  now?: () => number;
}>;

export type PromptCacheAnalyticsReadOptions = Pick<PromptCacheAnalyticsOptions, "kv" | "now"> &
  Readonly<{
    /** Only these bounded, public-safe dimensions may be selected. */
    groupBy?: readonly PromptCacheAnalyticsDimension[];
  }>;

export type PromptCacheAnalyticsRecordResult = Readonly<{
  status: "recorded" | "ignored" | "unavailable" | "queued" | "dropped";
  reason:
    | "recorded"
    | "recorded_without_usage"
    | "recorded_invalid_usage"
    | "recorded_cardinality_capped"
    | "unknown_release"
    | "not_completed_2xx"
    | "unsupported_provider"
    | "unsupported_route"
    | "kv_unavailable"
    | "queued"
    | "dropped_capacity"
    | "dropped_bytes"
    | "dropped_closed";
  bucket_start_at_ms: number | null;
}>;

export type PromptCacheAnalyticsGroup = Readonly<{
  provider?: PromptCacheAnalyticsProvider;
  /** Domain-separated digest or the bounded literal `unknown`; never raw model text. */
  model_hash?: string;
  route?: PromptCacheAnalyticsRoute;
  prompt_cache_key_present?: boolean;
  mode?: PromptCacheAnalyticsMode;
  fallback?: PromptCacheAnalyticsFallback;
  /** Fixed synthetic group for events beyond the per-bucket cohort cap. */
  cardinality_limited?: true;
}>;

export type PromptCacheAnalyticsBucket = Readonly<{
  bucket_start_at_ms: number;
  bucket_end_at_ms: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  cache_write_reported_sample_count: number;
  /** Kept for the existing capacity view. This is token_hit_percentage when available. */
  cached_percentage: number | null;
  sample_count: number;
  /** Present for the v2 grouped admin API and absent from the compact capacity projection. */
  group?: PromptCacheAnalyticsGroup;
  token_hit_percentage?: number | null;
  request_cache_hit_sample_count?: number;
  request_hit_percentage?: number | null;
  cache_reads_per_write?: number | null;
  usage_reported_sample_count?: number;
  usage_invalid_sample_count?: number;
  usage_missing_sample_count?: number;
  usage_telemetry_coverage_percentage?: number | null;
  dimension_cardinality_limited_sample_count?: number;
}>;

export type PromptCacheAnalyticsView = Readonly<{
  status: "ready" | "unavailable";
  bucket_ms: number;
  window_start_at_ms: number;
  window_end_at_ms: number;
  group_by: readonly PromptCacheAnalyticsDimension[];
  max_buckets: number;
  /** At least one group is a fixed synthetic cohort after the detail cap. */
  cardinality_limited: boolean;
  /** Response or cohort-detail truncation means the grouped view is incomplete. */
  truncated: boolean;
  buckets: readonly PromptCacheAnalyticsBucket[];
}>;

export type PromptCacheAnalyticsPruneResult = Readonly<{
  status: "pruned" | "unavailable";
  deleted: number;
}>;

export class PromptCacheAnalyticsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptCacheAnalyticsQueryError";
  }
}

const safeNow = (now: () => number): number => {
  const value = Math.trunc(now());
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
};

const alignedBucketStart = (timestamp: number): number => Math.floor(timestamp / PROMPT_CACHE_ANALYTICS_BUCKET_MS) * PROMPT_CACHE_ANALYTICS_BUCKET_MS;

const knownRelease = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const release = value.trim();
  return release.toLowerCase() !== "unknown" && RELEASE_SHA.test(release);
};

const safeCounter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const storedCounter = (value: unknown): number | null => {
  if (typeof value !== "object" || value === null || !("value" in value)) return null;
  const counter = (value as { value?: unknown }).value;
  if (typeof counter !== "bigint" || counter < 0n || counter > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(counter);
};

const storedCardinality = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= PROMPT_CACHE_ANALYTICS_MAX_COHORTS_PER_BUCKET ? value : null;

const roundedPercentage = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : Math.round((numerator / denominator) * 1_000_000) / 10_000;

const roundedRatio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;

const hasAsciiControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const normalizedModel = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_CHARS || hasAsciiControlCharacter(model)) return null;
  return model;
};

const asProvider = (value: unknown): PromptCacheAnalyticsProvider | null =>
  typeof value === "string" && (PROMPT_CACHE_TELEMETRY_PROVIDERS as readonly string[]).includes(value) ? (value as PromptCacheAnalyticsProvider) : null;

const asRoute = (value: unknown): PromptCacheAnalyticsRoute | null =>
  typeof value === "string" && (PROMPT_CACHE_TELEMETRY_ROUTES as readonly string[]).includes(value) ? (value as PromptCacheAnalyticsRoute) : null;

const asMode = (value: unknown): PromptCacheAnalyticsMode =>
  typeof value === "string" && (PROMPT_CACHE_ANALYTICS_MODES as readonly string[]).includes(value) ? (value as PromptCacheAnalyticsMode) : "unspecified";

const asFallback = (value: unknown): PromptCacheAnalyticsFallback => {
  if (typeof value !== "string" || !value.trim()) return "none";
  return (PROMPT_CACHE_ANALYTICS_FALLBACKS as readonly string[]).includes(value) ? (value as PromptCacheAnalyticsFallback) : "other";
};

const recordResult = (
  status: PromptCacheAnalyticsRecordResult["status"],
  reason: PromptCacheAnalyticsRecordResult["reason"],
  bucketStartAtMs: number | null = null
): PromptCacheAnalyticsRecordResult => ({ status, reason, bucket_start_at_ms: bucketStartAtMs });

/** The reason string that reports which kind of usage evidence was recorded. */
const recordedReason = (usage: PromptCacheAnalyticsUsage): PromptCacheAnalyticsRecordResult["reason"] => {
  if (usage.kind === "reported") return "recorded";
  if (usage.kind === "invalid") return "recorded_invalid_usage";
  return "recorded_without_usage";
};

const recordedResult = (bucketStartAtMs: number, usage: PromptCacheAnalyticsUsage): PromptCacheAnalyticsRecordResult =>
  recordResult("recorded", recordedReason(usage), bucketStartAtMs);

const resolveKv = async (options: PromptCacheAnalyticsOptions): Promise<Kv | null> => {
  try {
    return options.kv === undefined ? await getKv() : options.kv;
  } catch {
    return null;
  }
};

const aggregatePrefix = [...PROMPT_CACHE_ANALYTICS_KV_PREFIX, "all"] as const;
const dimensionPrefix = [...PROMPT_CACHE_ANALYTICS_KV_PREFIX, "dimension"] as const;
const overflowPrefix = [...PROMPT_CACHE_ANALYTICS_KV_PREFIX, "overflow"] as const;
const metaPrefix = [...PROMPT_CACHE_ANALYTICS_KV_PREFIX, "meta"] as const;

export const promptCacheAnalyticsBucketKey = (bucketStartAtMs: number): KvKey => [...aggregatePrefix, bucketStartAtMs];

/**
 * This is the aggregate counter helper kept for capacity callers and focused
 * fixtures. Dimension counters remain private to this module.
 */
export const promptCacheAnalyticsCounterKey = (bucketStartAtMs: number, counter: Counter): KvKey => [
  ...promptCacheAnalyticsBucketKey(bucketStartAtMs),
  counter,
];

const dimensionValues = (
  cohort: PromptCacheAnalyticsCohort
): readonly [PromptCacheAnalyticsProvider, string, PromptCacheAnalyticsRoute, "keyed" | "unkeyed", PromptCacheAnalyticsMode, PromptCacheAnalyticsFallback] => [
  cohort.provider,
  cohort.modelHash,
  cohort.route,
  cohort.promptCacheKeyPresent ? "keyed" : "unkeyed",
  cohort.mode,
  cohort.fallback,
];

const dimensionCounterKey = (bucketStartAtMs: number, cohort: PromptCacheAnalyticsCohort, counter: Counter): KvKey => [
  ...dimensionPrefix,
  bucketStartAtMs,
  ...dimensionValues(cohort),
  counter,
];

const dimensionMarkerKey = (bucketStartAtMs: number, cohort: PromptCacheAnalyticsCohort): KvKey => [
  ...dimensionPrefix,
  bucketStartAtMs,
  ...dimensionValues(cohort),
  "marker",
];

const overflowCounterKey = (bucketStartAtMs: number, counter: Counter): KvKey => [...overflowPrefix, bucketStartAtMs, counter];

const cardinalityKey = (bucketStartAtMs: number): KvKey => [...metaPrefix, bucketStartAtMs, "cardinality"];

const isKnownCounter = (value: unknown): value is Counter => typeof value === "string" && (COUNTERS as readonly string[]).includes(value);

const incrementCounters = (operation: AtomicOperation, keys: (counter: Counter) => KvKey, deltas: CounterDeltas): AtomicOperation => {
  let next = operation;
  for (const counter of COUNTERS) {
    const amount = deltas[counter];
    // A valid upstream zero is presence evidence. In particular, a zero cache
    // read or cache write must not become indistinguishable from a missing
    // field during a later grouped read.
    if (amount === undefined) continue;
    next = next.sum(keys(counter), amount);
  }
  return next;
};

const recordUsage = (event: PromptCacheAnalyticsEvent): PromptCacheAnalyticsUsage => {
  const base: CounterDeltas = { sample_count: 1n };
  if (event.usageTelemetryStatus === "reported") {
    if (
      safeCounter(event.inputTokens) &&
      safeCounter(event.cachedInputTokens) &&
      event.cachedInputTokens <= event.inputTokens &&
      (event.cacheWriteInputTokens === null || safeCounter(event.cacheWriteInputTokens))
    ) {
      const deltas: CounterDeltas = {
        ...base,
        input_tokens: BigInt(event.inputTokens),
        cached_input_tokens: BigInt(event.cachedInputTokens),
        usage_reported_sample_count: 1n,
      };
      if (event.cachedInputTokens > 0) deltas.request_cache_hit_sample_count = 1n;
      if (event.cacheWriteInputTokens !== null) {
        deltas.cache_write_input_tokens = BigInt(event.cacheWriteInputTokens);
        deltas.cache_write_reported_sample_count = 1n;
      }
      return { kind: "reported", deltas };
    }
    return { kind: "invalid", deltas: { ...base, usage_invalid_sample_count: 1n } };
  }
  if (event.usageTelemetryStatus === "invalid") {
    return { kind: "invalid", deltas: { ...base, usage_invalid_sample_count: 1n } };
  }
  return { kind: "missing", deltas: base };
};

/**
 * Builds the bounded cohort for an event whose provider and route were already
 * validated by the caller, so this cannot fail to produce a cohort.
 */
const resolveCohort = async (
  provider: PromptCacheAnalyticsProvider,
  route: PromptCacheAnalyticsRoute,
  event: PromptCacheAnalyticsEvent
): Promise<PromptCacheAnalyticsCohort> => {
  const model = normalizedModel(event.model);
  let modelHash = "unknown";
  if (model) modelHash = await sha256Hex(`uos-prompt-cache-analytics-model-v2\u0000${model}`);
  return {
    provider,
    modelHash,
    route,
    promptCacheKeyPresent: event.promptCacheKeyPresent === true,
    mode: asMode(event.promptCacheMode),
    fallback: asFallback(event.fallbackReason),
  };
};

const commitAggregateAndOverflow = async (kv: Kv, bucketStartAtMs: number, deltas: CounterDeltas): Promise<boolean> => {
  try {
    let operation = incrementCounters(kv.atomic(), (counter) => overflowCounterKey(bucketStartAtMs, counter), deltas);
    operation = incrementCounters(operation, (counter) => promptCacheAnalyticsCounterKey(bucketStartAtMs, counter), deltas);
    return (await operation.commit()).ok;
  } catch {
    return false;
  }
};

/** Adds this cohort's dimension counters and the shared aggregate counters. */
const addCohortCounters = (operation: AtomicOperation, bucketStartAtMs: number, cohort: PromptCacheAnalyticsCohort, deltas: CounterDeltas): AtomicOperation => {
  let next = incrementCounters(operation, (counter) => dimensionCounterKey(bucketStartAtMs, cohort, counter), deltas);
  next = incrementCounters(next, (counter) => promptCacheAnalyticsCounterKey(bucketStartAtMs, counter), deltas);
  return next;
};

const commitCohortCounters = async (kv: Kv, bucketStartAtMs: number, cohort: PromptCacheAnalyticsCohort, deltas: CounterDeltas): Promise<boolean> => {
  const operation = addCohortCounters(kv.atomic(), bucketStartAtMs, cohort, deltas);
  return (await operation.commit()).ok;
};

/** Records a cohort that arrived after the per-bucket cohort cap was reached. */
const commitCappedCohort = async (kv: Kv, bucketStartAtMs: number, deltas: CounterDeltas): Promise<PromptCacheAnalyticsRecordResult> => {
  const cappedDeltas: CounterDeltas = {
    ...deltas,
    dimension_cardinality_limited_sample_count: 1n,
  };
  if (!(await commitAggregateAndOverflow(kv, bucketStartAtMs, cappedDeltas))) {
    return recordResult("unavailable", "kv_unavailable", bucketStartAtMs);
  }
  return recordResult("recorded", "recorded_cardinality_capped", bucketStartAtMs);
};

type CohortAdmission = Readonly<{
  kv: Kv;
  bucketStartAtMs: number;
  cohort: PromptCacheAnalyticsCohort;
  usage: PromptCacheAnalyticsUsage;
  markerKey: KvKey;
  bucketCardinalityKey: KvKey;
}>;

/**
 * One bounded admission attempt for a cohort inside the current bucket. Returns
 * the recorded outcome, or `null` when the caller must retry with fresh state.
 */
const admitCohort = async (admission: CohortAdmission): Promise<PromptCacheAnalyticsRecordResult | null> => {
  const { kv, bucketStartAtMs, cohort, usage, markerKey, bucketCardinalityKey } = admission;
  const [marker, cardinality] = await kv.getMany<[boolean, number]>([markerKey, bucketCardinalityKey]);
  if (marker.value === true) {
    if (!(await commitCohortCounters(kv, bucketStartAtMs, cohort, usage.deltas))) return null;
    return recordedResult(bucketStartAtMs, usage);
  }

  const cardinalityValue = cardinality.value === null ? 0 : storedCardinality(cardinality.value);
  if (cardinalityValue === null) return recordResult("unavailable", "kv_unavailable", bucketStartAtMs);
  if (cardinalityValue >= PROMPT_CACHE_ANALYTICS_MAX_COHORTS_PER_BUCKET) return commitCappedCohort(kv, bucketStartAtMs, usage.deltas);

  const retentionMs = PROMPT_CACHE_ANALYTICS_RETENTION_MS;
  let operation = kv
    .atomic()
    .check(marker)
    .check(cardinality)
    .set(markerKey, true, { expireIn: retentionMs })
    .set(bucketCardinalityKey, cardinalityValue + 1, { expireIn: retentionMs });
  operation = addCohortCounters(operation, bucketStartAtMs, cohort, usage.deltas);
  if (!(await operation.commit()).ok) return null;
  return recordedResult(bucketStartAtMs, usage);
};

/** The optional-write gate shared by the direct and the queued entry points. */
const promptCacheAnalyticsTarget = (
  event: PromptCacheAnalyticsEvent,
  options: PromptCacheAnalyticsOptions
): Readonly<{ provider: PromptCacheAnalyticsProvider; route: PromptCacheAnalyticsRoute }> | PromptCacheAnalyticsRecordResult => {
  const release = options.release ?? RELEASE_GIT_SHA;
  if (!knownRelease(release)) return recordResult("ignored", "unknown_release");
  if (!event.completed || !Number.isInteger(event.status) || event.status < 200 || event.status >= 300) return recordResult("ignored", "not_completed_2xx");
  const provider = asProvider(event.provider);
  if (!provider) return recordResult("ignored", "unsupported_provider");
  const route = asRoute(event.route);
  if (!route) return recordResult("ignored", "unsupported_route");
  return { provider, route };
};

/**
 * One bounded admission sequence for an already-validated cohort.
 *
 * Each failed admission CAS means this cohort was admitted concurrently or
 * another cohort advanced the shared cardinality row. One extra read after the
 * maximum number of conflicts must therefore observe this marker or cap.
 */
const commitCohortOutcome = async (
  kv: Kv,
  bucketStartAtMs: number,
  cohort: PromptCacheAnalyticsCohort,
  usage: PromptCacheAnalyticsUsage,
  nowMs: number
): Promise<PromptCacheAnalyticsRecordResult> => {
  const admission: CohortAdmission = {
    kv,
    bucketStartAtMs,
    cohort,
    usage,
    markerKey: dimensionMarkerKey(bucketStartAtMs, cohort),
    bucketCardinalityKey: cardinalityKey(bucketStartAtMs),
  };
  try {
    for (let attempt = 0; attempt <= PROMPT_CACHE_ANALYTICS_MAX_COHORTS_PER_BUCKET; attempt += 1) {
      const outcome = await admitCohort(admission);
      if (outcome !== null) {
        pruneRetentionOnEvent(kv, bucketStartAtMs, nowMs);
        return outcome;
      }
    }
  } catch {
    return recordResult("unavailable", "kv_unavailable", bucketStartAtMs);
  }
  return recordResult("unavailable", "kv_unavailable", bucketStartAtMs);
};

/**
 * Adds one completed inference outcome to aggregate and bounded cohort
 * counters. The model is hashed before it reaches a durable KV key. A full
 * bucket never admits more than the fixed number of cohort combinations.
 */
export const recordPromptCacheAnalytics = async (
  event: PromptCacheAnalyticsEvent,
  options: PromptCacheAnalyticsOptions = {}
): Promise<PromptCacheAnalyticsRecordResult> => {
  const target = promptCacheAnalyticsTarget(event, options);
  if (!("provider" in target)) return target;

  const nowMs = safeNow(options.now ?? Date.now);
  const bucketStartAtMs = alignedBucketStart(nowMs);
  const kv = await resolveKv(options);
  if (!kv) return recordResult("unavailable", "kv_unavailable", bucketStartAtMs);

  let cohort: PromptCacheAnalyticsCohort;
  try {
    cohort = await resolveCohort(target.provider, target.route, event);
  } catch {
    return recordResult("unavailable", "kv_unavailable", bucketStartAtMs);
  }
  return await commitCohortOutcome(kv, bucketStartAtMs, cohort, recordUsage(event), nowMs);
};

/**
 * The bounded, sanitized record retained by the optional telemetry queue. It
 * carries an opaque model digest instead of model text, the fixed public
 * dimensions, aggregate counter deltas and a delivery handle. Prompts,
 * messages, request bodies, credentials and raw usage strings never enter it.
 */

const storageBucketStart = (key: KvKey): number | null => {
  const namespace = key[PROMPT_CACHE_ANALYTICS_KV_PREFIX.length];
  const bucketStartAtMs = key[PROMPT_CACHE_ANALYTICS_KV_PREFIX.length + 1];
  if ((namespace !== "all" && namespace !== "dimension" && namespace !== "overflow" && namespace !== "meta") || !safeCounter(bucketStartAtMs)) {
    return null;
  }
  return bucketStartAtMs;
};

const legacyStorageBucketStart = (key: KvKey): number | null => {
  const bucketStartAtMs = key[LEGACY_PROMPT_CACHE_ANALYTICS_V1_KV_PREFIX.length];
  return safeCounter(bucketStartAtMs) ? bucketStartAtMs : null;
};

/**
 * One prune per analytics bucket, driven by a write instead of the retired
 * hourly cron. Retention still removes everything past its cutoff: the first
 * write in a new bucket prunes, later writes in the same bucket are a no-op, so
 * pruning costs one scan per bucket no matter how much traffic arrives.
 */
let lastPrunedBucketStartAtMs = 0;

const pruneRetentionOnEvent = (kv: Kv, bucketStartAtMs: number, nowMs: number): void => {
  if (bucketStartAtMs <= lastPrunedBucketStartAtMs) return;
  lastPrunedBucketStartAtMs = bucketStartAtMs;
  void prunePromptCacheAnalytics({ kv, now: () => nowMs }).catch(() => {});
};

/** Removes V2 and legacy V1 entries at the eight-day boundary without scanning fresh buckets. */
export const prunePromptCacheAnalytics = async (options: Pick<PromptCacheAnalyticsOptions, "kv" | "now"> = {}): Promise<PromptCacheAnalyticsPruneResult> => {
  const nowMs = safeNow(options.now ?? Date.now);
  const cutoffBucketStartAtMs = alignedBucketStart(Math.max(0, nowMs - PROMPT_CACHE_ANALYTICS_RETENTION_MS));
  const kv = await resolveKv(options);
  if (!kv) return { status: "unavailable", deleted: 0 };

  let deleted = 0;
  let batch: KvKey[] = [];
  const deleteBatch = async (): Promise<void> => {
    const current = batch;
    batch = [];
    await Promise.all(current.map((key) => kv.delete(key)));
    deleted += current.length;
  };
  try {
    const endAtExclusive = cutoffBucketStartAtMs + 1;
    for (const [prefix, bucketStart] of [
      [aggregatePrefix, storageBucketStart],
      [dimensionPrefix, storageBucketStart],
      [overflowPrefix, storageBucketStart],
      [metaPrefix, storageBucketStart],
      [LEGACY_PROMPT_CACHE_ANALYTICS_V1_KV_PREFIX, legacyStorageBucketStart],
    ] as const) {
      for await (const entry of kv.list({ prefix, end: [...prefix, endAtExclusive] })) {
        const bucketStartAtMs = bucketStart(entry.key);
        if (bucketStartAtMs === null || bucketStartAtMs > cutoffBucketStartAtMs) continue;
        batch.push(entry.key);
        if (batch.length === 64) await deleteBatch();
      }
    }
    if (batch.length) await deleteBatch();
    return { status: "pruned", deleted };
  } catch {
    return { status: "unavailable", deleted };
  }
};

export type {
  Counter,
  CounterDeltas,
  PromptCacheAnalyticsCohort,
  PromptCacheAnalyticsFallback,
  PromptCacheAnalyticsMode,
  PromptCacheAnalyticsProvider,
  PromptCacheAnalyticsRoute,
  PromptCacheAnalyticsUsage,
  StoredCounters,
};

export {
  COUNTERS,
  aggregatePrefix,
  alignedBucketStart,
  asFallback,
  asMode,
  asProvider,
  asRoute,
  commitCohortOutcome,
  dimensionPrefix,
  isKnownCounter,
  overflowPrefix,
  promptCacheAnalyticsTarget,
  recordResult,
  recordUsage,
  resolveCohort,
  resolveKv,
  roundedPercentage,
  roundedRatio,
  safeCounter,
  safeNow,
  storedCounter,
};
