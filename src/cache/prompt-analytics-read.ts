import type { Kv, KvEntry, KvKey, KvU64 } from "#kv";
// Prompt cache analytics read model, split out of src/prompt_cache_analytics.ts.

import {
  aggregatePrefix,
  alignedBucketStart,
  asFallback,
  asMode,
  asProvider,
  asRoute,
  dimensionPrefix,
  isKnownCounter,
  overflowPrefix,
  PROMPT_CACHE_ANALYTICS_BUCKET_MS,
  PROMPT_CACHE_ANALYTICS_DIMENSIONS,
  PROMPT_CACHE_ANALYTICS_MAX_GROUP_BY,
  PROMPT_CACHE_ANALYTICS_MAX_RESPONSE_BUCKETS,
  PROMPT_CACHE_ANALYTICS_WINDOW_BUCKETS,
  PROMPT_CACHE_ANALYTICS_WINDOW_MS,
  PromptCacheAnalyticsQueryError,
  resolveKv,
  roundedPercentage,
  roundedRatio,
  safeCounter,
  safeNow,
  storedCounter,
} from "./prompt-analytics-core.ts";
import type {
  Counter,
  PromptCacheAnalyticsBucket,
  PromptCacheAnalyticsCohort,
  PromptCacheAnalyticsDimension,
  PromptCacheAnalyticsGroup,
  PromptCacheAnalyticsReadOptions,
  PromptCacheAnalyticsView,
  StoredCounters,
} from "./prompt-analytics-core.ts";

const normalizedGroupBy = (value: unknown): readonly PromptCacheAnalyticsDimension[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PROMPT_CACHE_ANALYTICS_MAX_GROUP_BY) return null;
  const groupBy: PromptCacheAnalyticsDimension[] = [];
  for (const dimension of value) {
    if (
      typeof dimension !== "string" ||
      !(PROMPT_CACHE_ANALYTICS_DIMENSIONS as readonly string[]).includes(dimension) ||
      groupBy.includes(dimension as PromptCacheAnalyticsDimension)
    )
      return null;
    groupBy.push(dimension as PromptCacheAnalyticsDimension);
  }
  return groupBy;
};

/** Used by the admin boundary before it reads KV. */
export const isValidPromptCacheAnalyticsGroupBy = (value: unknown): value is readonly PromptCacheAnalyticsDimension[] => normalizedGroupBy(value) !== null;

const parsedDimensionValues = (key: KvKey): PromptCacheAnalyticsCohort | null => {
  const offset = dimensionPrefix.length;
  if (key.length !== offset + 8) return null;
  const provider = asProvider(key[offset + 1]);
  const modelHash = key[offset + 2];
  const route = asRoute(key[offset + 3]);
  const keyState = key[offset + 4];
  const mode = asMode(key[offset + 5]);
  const fallback = asFallback(key[offset + 6]);
  const counter = key[offset + 7];
  if (
    !provider ||
    typeof modelHash !== "string" ||
    !/^(?:unknown|[a-f0-9]{64})$/.test(modelHash) ||
    !route ||
    (keyState !== "keyed" && keyState !== "unkeyed") ||
    !isKnownCounter(counter)
  )
    return null;
  return {
    provider,
    modelHash,
    route,
    promptCacheKeyPresent: keyState === "keyed",
    mode,
    fallback,
  };
};

const counterFromDimensionKey = (key: KvKey): Counter | null => {
  const counter = key[dimensionPrefix.length + 7];
  return isKnownCounter(counter) ? counter : null;
};

const groupForCohort = (cohort: PromptCacheAnalyticsCohort, groupBy: readonly PromptCacheAnalyticsDimension[]): PromptCacheAnalyticsGroup => {
  const group: Record<string, string | boolean> = {};
  for (const dimension of groupBy) {
    if (dimension === "provider") group.provider = cohort.provider;
    if (dimension === "model") group.model_hash = cohort.modelHash;
    if (dimension === "route") group.route = cohort.route;
    if (dimension === "key_presence") group.prompt_cache_key_present = cohort.promptCacheKeyPresent;
    if (dimension === "mode") group.mode = cohort.mode;
    if (dimension === "fallback") group.fallback = cohort.fallback;
  }
  return group as PromptCacheAnalyticsGroup;
};

const groupIdentity = (bucketStartAtMs: number, group: PromptCacheAnalyticsGroup): string =>
  JSON.stringify([
    bucketStartAtMs,
    group.provider,
    group.model_hash,
    group.route,
    group.prompt_cache_key_present,
    group.mode,
    group.fallback,
    group.cardinality_limited,
  ]);

const parsedAggregateCounter = (key: KvKey): Readonly<{ bucketStartAtMs: number; counter: Counter }> | null => {
  if (key.length !== aggregatePrefix.length + 2) return null;
  const bucketStartAtMs = key[aggregatePrefix.length];
  const counter = key[aggregatePrefix.length + 1];
  if (!safeCounter(bucketStartAtMs) || !isKnownCounter(counter)) return null;
  return { bucketStartAtMs, counter };
};

const parsedOverflowCounter = (key: KvKey): Readonly<{ bucketStartAtMs: number; counter: Counter }> | null => {
  if (key.length !== overflowPrefix.length + 2) return null;
  const bucketStartAtMs = key[overflowPrefix.length];
  const counter = key[overflowPrefix.length + 1];
  if (!safeCounter(bucketStartAtMs) || !isKnownCounter(counter)) return null;
  return { bucketStartAtMs, counter };
};

// Synthetic control-plane fixtures may use the aggregate helper directly.
// Both token counters are sufficient evidence of reported usage in that case.
const inferredUsageReportedSampleCount = (counters: StoredCounters, sampleCount: number, hasInputCounters: boolean): number =>
  hasInputCounters && safeCounter(counters.input_tokens) && safeCounter(counters.cached_input_tokens) ? sampleCount : 0;

type ProjectedTokenCounters = Readonly<{
  inputTokens: number | null;
  cachedInputTokens: number | null;
}>;

const projectedTokenCounters = (counters: StoredCounters, usageReportedSampleCount: number, hasInputCounters: boolean): ProjectedTokenCounters | null => {
  if (usageReportedSampleCount > 0) {
    if (!safeCounter(counters.input_tokens) || !safeCounter(counters.cached_input_tokens) || counters.cached_input_tokens > counters.input_tokens) return null;
    return { inputTokens: counters.input_tokens, cachedInputTokens: counters.cached_input_tokens };
  }
  if (hasInputCounters) return null;
  return { inputTokens: null, cachedInputTokens: null };
};

type ProjectedCacheWriteCounters = Readonly<{
  inputTokens: number | null;
  reportedSampleCount: number;
}>;

const projectedCacheWriteCounters = (counters: StoredCounters, usageReportedSampleCount: number): ProjectedCacheWriteCounters | null => {
  const cacheWriteInputTokens = counters.cache_write_input_tokens;
  const cacheWriteReportedSampleCount = counters.cache_write_reported_sample_count;
  if (cacheWriteInputTokens === undefined && cacheWriteReportedSampleCount === undefined) {
    return { inputTokens: null, reportedSampleCount: 0 };
  }
  if (
    !safeCounter(cacheWriteInputTokens) ||
    !safeCounter(cacheWriteReportedSampleCount) ||
    cacheWriteReportedSampleCount === 0 ||
    cacheWriteReportedSampleCount > usageReportedSampleCount
  )
    return null;
  return { inputTokens: cacheWriteInputTokens, reportedSampleCount: cacheWriteReportedSampleCount };
};

type ProjectedHitCounters = Readonly<{
  requestCacheHitSampleCount: number;
  cardinalityLimitedSampleCount: number;
}>;

const projectedHitCounters = (counters: StoredCounters, sampleCount: number, usageReportedSampleCount: number): ProjectedHitCounters | null => {
  const requestCacheHitSampleCount = counters.request_cache_hit_sample_count ?? 0;
  const cardinalityLimitedSampleCount = counters.dimension_cardinality_limited_sample_count ?? 0;
  if (
    !safeCounter(requestCacheHitSampleCount) ||
    requestCacheHitSampleCount > usageReportedSampleCount ||
    !safeCounter(cardinalityLimitedSampleCount) ||
    cardinalityLimitedSampleCount > sampleCount
  )
    return null;
  return { requestCacheHitSampleCount, cardinalityLimitedSampleCount };
};

const projectedBucket = (bucketStartAtMs: number, counters: StoredCounters, group: PromptCacheAnalyticsGroup | null): PromptCacheAnalyticsBucket | null => {
  const sampleCount = counters.sample_count;
  if (!safeCounter(sampleCount)) return null;

  const hasInputCounters = counters.input_tokens !== undefined || counters.cached_input_tokens !== undefined;
  const usageReportedSampleCount = counters.usage_reported_sample_count ?? inferredUsageReportedSampleCount(counters, sampleCount, hasInputCounters);
  const usageInvalidSampleCount = counters.usage_invalid_sample_count ?? 0;
  if (
    !safeCounter(usageReportedSampleCount) ||
    !safeCounter(usageInvalidSampleCount) ||
    usageReportedSampleCount > sampleCount ||
    usageInvalidSampleCount > sampleCount ||
    usageReportedSampleCount + usageInvalidSampleCount > sampleCount
  )
    return null;

  const tokens = projectedTokenCounters(counters, usageReportedSampleCount, hasInputCounters);
  if (!tokens) return null;
  const cacheWrite = projectedCacheWriteCounters(counters, usageReportedSampleCount);
  if (!cacheWrite) return null;
  const hitCounters = projectedHitCounters(counters, sampleCount, usageReportedSampleCount);
  if (!hitCounters) return null;

  const tokenHitPercentage =
    tokens.inputTokens === null || tokens.cachedInputTokens === null ? null : roundedPercentage(tokens.cachedInputTokens, tokens.inputTokens);
  const requestHitPercentage = roundedPercentage(hitCounters.requestCacheHitSampleCount, usageReportedSampleCount);
  const usageMissingSampleCount = sampleCount - usageReportedSampleCount - usageInvalidSampleCount;
  const compact: PromptCacheAnalyticsBucket = {
    bucket_start_at_ms: bucketStartAtMs,
    bucket_end_at_ms: bucketStartAtMs + PROMPT_CACHE_ANALYTICS_BUCKET_MS,
    input_tokens: tokens.inputTokens,
    cached_input_tokens: tokens.cachedInputTokens,
    cache_write_input_tokens: cacheWrite.inputTokens,
    cache_write_reported_sample_count: cacheWrite.reportedSampleCount,
    cached_percentage: tokenHitPercentage,
    sample_count: sampleCount,
  };
  if (group === null) return compact;
  return {
    ...compact,
    group,
    token_hit_percentage: tokenHitPercentage,
    request_cache_hit_sample_count: hitCounters.requestCacheHitSampleCount,
    request_hit_percentage: requestHitPercentage,
    cache_reads_per_write:
      tokens.inputTokens === null || tokens.cachedInputTokens === null || cacheWrite.inputTokens === null
        ? null
        : roundedRatio(tokens.cachedInputTokens, cacheWrite.inputTokens),
    usage_reported_sample_count: usageReportedSampleCount,
    usage_invalid_sample_count: usageInvalidSampleCount,
    usage_missing_sample_count: usageMissingSampleCount,
    usage_telemetry_coverage_percentage: roundedPercentage(usageReportedSampleCount, sampleCount),
    dimension_cardinality_limited_sample_count: hitCounters.cardinalityLimitedSampleCount,
  };
};

type PromptCacheAnalyticsWindow = Readonly<{
  currentBucketStartAtMs: number;
  windowStartAtMs: number;
  windowEndAtMs: number;
}>;

const viewWindow = (now: () => number): PromptCacheAnalyticsWindow => {
  const currentBucketStartAtMs = alignedBucketStart(safeNow(now));
  const windowEndAtMs = currentBucketStartAtMs + PROMPT_CACHE_ANALYTICS_BUCKET_MS;
  return {
    currentBucketStartAtMs,
    windowStartAtMs: windowEndAtMs - PROMPT_CACHE_ANALYTICS_WINDOW_MS,
    windowEndAtMs,
  };
};

const inWindow = (bucketStartAtMs: number, window: Readonly<{ currentBucketStartAtMs: number; windowStartAtMs: number }>): boolean =>
  bucketStartAtMs >= window.windowStartAtMs && bucketStartAtMs <= window.currentBucketStartAtMs;

type PromptCacheAnalyticsStoredBucket = Readonly<{
  bucketStartAtMs: number;
  group: PromptCacheAnalyticsGroup | null;
  counters: StoredCounters;
}>;

type PromptCacheAnalyticsStoredBuckets = Map<string, PromptCacheAnalyticsStoredBucket>;

/** Sums one stored counter into its bucket/group row; a saturated row is left as it was. */
const accumulateCounter = (
  storedBuckets: PromptCacheAnalyticsStoredBuckets,
  identity: string,
  bucketStartAtMs: number,
  group: PromptCacheAnalyticsGroup | null,
  counter: Counter,
  value: number
): void => {
  const existing = storedBuckets.get(identity) ?? { bucketStartAtMs, group, counters: {} };
  const previous = existing.counters[counter] ?? 0;
  if (previous > Number.MAX_SAFE_INTEGER - value) return;
  existing.counters[counter] = previous + value;
  storedBuckets.set(identity, existing);
};

const accumulateAggregateEntry = (storedBuckets: PromptCacheAnalyticsStoredBuckets, entry: KvEntry<KvU64>, window: PromptCacheAnalyticsWindow): void => {
  const parsed = parsedAggregateCounter(entry.key);
  if (!parsed || !inWindow(parsed.bucketStartAtMs, window)) return;
  const value = storedCounter(entry.value);
  if (value === null) return;
  accumulateCounter(storedBuckets, String(parsed.bucketStartAtMs), parsed.bucketStartAtMs, null, parsed.counter, value);
};

const accumulateDimensionEntry = (
  storedBuckets: PromptCacheAnalyticsStoredBuckets,
  entry: KvEntry<KvU64>,
  window: PromptCacheAnalyticsWindow,
  groupBy: readonly PromptCacheAnalyticsDimension[]
): void => {
  const bucketStartAtMs = entry.key[dimensionPrefix.length];
  if (!safeCounter(bucketStartAtMs) || !inWindow(bucketStartAtMs, window)) return;
  const cohort = parsedDimensionValues(entry.key);
  const counter = counterFromDimensionKey(entry.key);
  const value = storedCounter(entry.value);
  if (!cohort || !counter || value === null) return;
  const group = groupForCohort(cohort, groupBy);
  accumulateCounter(storedBuckets, groupIdentity(bucketStartAtMs, group), bucketStartAtMs, group, counter, value);
};

/** Returns true when the entry counts as cardinality-limited traffic for the view. */
const accumulateOverflowEntry = (storedBuckets: PromptCacheAnalyticsStoredBuckets, entry: KvEntry<KvU64>, window: PromptCacheAnalyticsWindow): boolean => {
  const parsed = parsedOverflowCounter(entry.key);
  if (!parsed || !inWindow(parsed.bucketStartAtMs, window)) return false;
  const value = storedCounter(entry.value);
  if (value === null) return false;
  const group: PromptCacheAnalyticsGroup = { cardinality_limited: true };
  accumulateCounter(storedBuckets, groupIdentity(parsed.bucketStartAtMs, group), parsed.bucketStartAtMs, group, parsed.counter, value);
  return true;
};

type PromptCacheAnalyticsStoredRead = Readonly<{
  storedBuckets: PromptCacheAnalyticsStoredBuckets;
  /** At least one in-window entry was recorded past the per-bucket cohort cap. */
  cardinalityLimited: boolean;
}>;

/**
 * Reads this window's counters into per-bucket rows. The compact aggregate view
 * lists only the aggregate prefix; a grouped view lists the dimension prefix
 * plus the overflow prefix that carries capped cohorts.
 */
const readStoredBuckets = async (
  kv: Kv,
  groupBy: readonly PromptCacheAnalyticsDimension[],
  window: PromptCacheAnalyticsWindow
): Promise<PromptCacheAnalyticsStoredRead> => {
  const storedBuckets: PromptCacheAnalyticsStoredBuckets = new Map();
  if (groupBy.length === 0) {
    for await (const entry of kv.list<KvU64>({ prefix: aggregatePrefix })) {
      accumulateAggregateEntry(storedBuckets, entry, window);
    }
    return { storedBuckets, cardinalityLimited: false };
  }
  let cardinalityLimited = false;
  for await (const entry of kv.list<KvU64>({ prefix: dimensionPrefix })) {
    accumulateDimensionEntry(storedBuckets, entry, window, groupBy);
  }
  for await (const entry of kv.list<KvU64>({ prefix: overflowPrefix })) {
    if (accumulateOverflowEntry(storedBuckets, entry, window)) cardinalityLimited = true;
  }
  return { storedBuckets, cardinalityLimited };
};

/**
 * Reads the compact aggregate used by capacity history or a bounded grouped
 * view for the admin API. Grouped responses retain the newest rows if the
 * response limit is reached and mark the truncation explicitly.
 */
export const readPromptCacheAnalytics = async (options: PromptCacheAnalyticsReadOptions = {}): Promise<PromptCacheAnalyticsView> => {
  const groupBy = normalizedGroupBy(options.groupBy);
  if (groupBy === null) {
    throw new PromptCacheAnalyticsQueryError("group_by must contain distinct approved dimensions only");
  }
  const window = viewWindow(options.now ?? Date.now);
  const maxBuckets = groupBy.length === 0 ? PROMPT_CACHE_ANALYTICS_WINDOW_BUCKETS : PROMPT_CACHE_ANALYTICS_MAX_RESPONSE_BUCKETS;
  const unavailable = (): PromptCacheAnalyticsView => ({
    status: "unavailable",
    bucket_ms: PROMPT_CACHE_ANALYTICS_BUCKET_MS,
    window_start_at_ms: window.windowStartAtMs,
    window_end_at_ms: window.windowEndAtMs,
    group_by: groupBy,
    max_buckets: maxBuckets,
    cardinality_limited: false,
    truncated: false,
    buckets: [],
  });
  const kv = await resolveKv(options);
  if (!kv) return unavailable();

  try {
    const { storedBuckets, cardinalityLimited } = await readStoredBuckets(kv, groupBy, window);

    const projected = [...storedBuckets.values()]
      .map(({ bucketStartAtMs, group, counters }) => projectedBucket(bucketStartAtMs, counters, group))
      .filter((bucket): bucket is PromptCacheAnalyticsBucket => bucket !== null)
      .sort(
        (left, right) => left.bucket_start_at_ms - right.bucket_start_at_ms || JSON.stringify(left.group ?? {}).localeCompare(JSON.stringify(right.group ?? {}))
      );
    const responseTruncated = projected.length > maxBuckets;
    const truncated = responseTruncated || cardinalityLimited;
    const buckets = responseTruncated ? projected.slice(-maxBuckets) : projected;
    return {
      status: "ready",
      bucket_ms: PROMPT_CACHE_ANALYTICS_BUCKET_MS,
      window_start_at_ms: window.windowStartAtMs,
      window_end_at_ms: window.windowEndAtMs,
      group_by: groupBy,
      max_buckets: maxBuckets,
      cardinality_limited: cardinalityLimited,
      truncated,
      buckets,
    };
  } catch {
    return unavailable();
  }
};
