import type { Kv } from "#kv";
// Prompt cache analytics optional telemetry queue, split out of src/prompt_cache_analytics.ts.

import {
  createOptionalTelemetryQueue,
  measureJsonPayloadBytes,
  type OptionalTelemetryQueue,
  type OptionalTelemetryQueueSnapshot,
} from "../optional-telemetry-queue.ts";
import {
  alignedBucketStart,
  asFallback,
  asMode,
  asProvider,
  asRoute,
  commitCohortOutcome,
  COUNTERS,
  promptCacheAnalyticsTarget,
  recordResult,
  recordUsage,
  resolveCohort,
  resolveKv,
  safeCounter,
  safeNow,
} from "./prompt-analytics-core.ts";
import type {
  Counter,
  CounterDeltas,
  PromptCacheAnalyticsCohort,
  PromptCacheAnalyticsEvent,
  PromptCacheAnalyticsFallback,
  PromptCacheAnalyticsMode,
  PromptCacheAnalyticsOptions,
  PromptCacheAnalyticsProvider,
  PromptCacheAnalyticsRecordResult,
  PromptCacheAnalyticsRoute,
  PromptCacheAnalyticsUsage,
} from "./prompt-analytics-core.ts";

export type PromptCacheAnalyticsQueueEntry = Readonly<{
  bucket_start_at_ms: number;
  provider: PromptCacheAnalyticsProvider;
  model_hash: string;
  route: PromptCacheAnalyticsRoute;
  prompt_cache_key_present: boolean;
  mode: PromptCacheAnalyticsMode;
  fallback: PromptCacheAnalyticsFallback;
  usage_kind: PromptCacheAnalyticsUsage["kind"];
  /** Absent counters stay absent, so a missing cache count is never defaulted. */
  deltas: Readonly<Partial<Record<Counter, number>>>;
  /**
   * Process-level delivery reference only: an explicitly injected database
   * handle, or undefined in production so the sink resolves the environment KV
   * with `getKv()` at delivery time. Request, response and prompt data never
   * enter this field.
   */
  kv?: Kv | null;
}>;

const MODEL_HASH_PATTERN = /^(?:unknown|[a-f0-9]{64})$/;

const queueEntryDeltas = (deltas: CounterDeltas): Readonly<Partial<Record<Counter, number>>> => {
  const bounded: Partial<Record<Counter, number>> = {};
  for (const counter of COUNTERS) {
    const amount = deltas[counter];
    if (amount === undefined || amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    bounded[counter] = Number(amount);
  }
  return bounded;
};

const cohortFromQueueEntry = (entry: PromptCacheAnalyticsQueueEntry): PromptCacheAnalyticsCohort | null => {
  const provider = asProvider(entry.provider);
  const route = asRoute(entry.route);
  if (!provider || !route || typeof entry.model_hash !== "string" || !MODEL_HASH_PATTERN.test(entry.model_hash)) return null;
  return {
    provider,
    modelHash: entry.model_hash,
    route,
    promptCacheKeyPresent: entry.prompt_cache_key_present,
    mode: asMode(entry.mode),
    fallback: asFallback(entry.fallback),
  };
};

/** Rebuilds the bounded counter deltas; a malformed retained entry is dropped, never partially written. */
const usageFromQueueEntry = (entry: PromptCacheAnalyticsQueueEntry): PromptCacheAnalyticsUsage | null => {
  const deltas: CounterDeltas = {};
  for (const counter of COUNTERS) {
    const amount = entry.deltas[counter];
    if (amount === undefined) continue;
    if (!safeCounter(amount)) return null;
    deltas[counter] = BigInt(amount);
  }
  if (deltas.sample_count === undefined) return null;
  return { kind: entry.usage_kind, deltas };
};

/**
 * The durable sink for one queued entry. It applies exactly the counters a
 * direct write would have applied; it exists so the queued path cannot drift
 * from the direct path.
 */
export const writePromptCacheAnalyticsQueueEntry = async (entry: PromptCacheAnalyticsQueueEntry): Promise<boolean> => {
  const cohort = cohortFromQueueEntry(entry);
  const usage = usageFromQueueEntry(entry);
  if (!cohort || !usage || !safeCounter(entry.bucket_start_at_ms)) return false;
  const kv = entry.kv === undefined ? await resolveKv({}) : entry.kv;
  if (!kv) return false;
  try {
    const outcome = await commitCohortOutcome(kv, entry.bucket_start_at_ms, cohort, usage, entry.bucket_start_at_ms);
    return outcome.status === "recorded";
  } catch {
    return false;
  }
};

/**
 * Measures only the retained metadata, in the same UTF-8 byte accounting the
 * queue's default uses. A process-local KV delivery handle adds no payload
 * bytes, and an unserializable payload fails closed as `NaN`.
 */
const measureQueueEntry = (entry: PromptCacheAnalyticsQueueEntry): number => measureJsonPayloadBytes({ ...entry, kv: undefined });

let optionalPromptCacheAnalyticsQueue: OptionalTelemetryQueue<PromptCacheAnalyticsQueueEntry> | null = null;
/**
 * Terminal once close is requested. It is checked before the lazy queue is
 * created, so a close that arrives before the first eligible sample cannot be
 * undone by a later enqueue creating a fresh open queue.
 */
let optionalPromptCacheAnalyticsClosed = false;

const promptCacheAnalyticsTelemetryQueue = (): OptionalTelemetryQueue<PromptCacheAnalyticsQueueEntry> =>
  (optionalPromptCacheAnalyticsQueue ??= createOptionalTelemetryQueue({
    write: writePromptCacheAnalyticsQueueEntry,
    measure: measureQueueEntry,
  }));

export type PromptCacheAnalyticsEnqueueOptions = PromptCacheAnalyticsOptions &
  Readonly<{
    /**
     * Test and integration seam: the bounded queue instance that owns optional
     * writes. It stays caller-owned, so the module's terminal close does not
     * gate it.
     */
    queue?: OptionalTelemetryQueue<PromptCacheAnalyticsQueueEntry>;
  }>;

/**
 * Queues one completed inference outcome onto the bounded optional-telemetry
 * queue and returns before any durable write starts.
 *
 * This is the drop-in replacement for `recordPromptCacheAnalytics` on the
 * request path: it shares the same gate and the same counters, but a slow or
 * unavailable analytics sink can no longer extend client-visible latency. The
 * return value reports the queue outcome, and the queue snapshot reports
 * retained, delivered, failed, dropped and drain state.
 */
export const enqueuePromptCacheAnalytics = async (
  event: PromptCacheAnalyticsEvent,
  options: PromptCacheAnalyticsEnqueueOptions = {}
): Promise<PromptCacheAnalyticsRecordResult> => {
  const target = promptCacheAnalyticsTarget(event, options);
  if (!("provider" in target)) return target;

  const nowMs = safeNow(options.now ?? Date.now);
  const bucketStartAtMs = alignedBucketStart(nowMs);
  let cohort: PromptCacheAnalyticsCohort;
  try {
    cohort = await resolveCohort(target.provider, target.route, event);
  } catch {
    return recordResult("unavailable", "kv_unavailable", bucketStartAtMs);
  }

  const usage = recordUsage(event);
  // Terminal module close, checked where the queue would be created: once close
  // ran without a queue, an eligible sample must not create one, even if it was
  // already resolving its cohort when the close arrived. A queue that already
  // exists was closed by that same call and reports the refusal itself; an
  // explicitly injected queue stays caller-owned.
  if (options.queue === undefined && optionalPromptCacheAnalyticsClosed && optionalPromptCacheAnalyticsQueue === null) {
    return recordResult("dropped", "dropped_closed", bucketStartAtMs);
  }
  const outcome = (options.queue ?? promptCacheAnalyticsTelemetryQueue()).enqueue({
    bucket_start_at_ms: bucketStartAtMs,
    provider: cohort.provider,
    model_hash: cohort.modelHash,
    route: cohort.route,
    prompt_cache_key_present: cohort.promptCacheKeyPresent,
    mode: cohort.mode,
    fallback: cohort.fallback,
    usage_kind: usage.kind,
    deltas: queueEntryDeltas(usage.deltas),
    kv: options.kv,
  });
  if (outcome === "enqueued") return recordResult("queued", "queued", bucketStartAtMs);
  if (outcome === "dropped_capacity") return recordResult("dropped", "dropped_capacity", bucketStartAtMs);
  if (outcome === "dropped_bytes") return recordResult("dropped", "dropped_bytes", bucketStartAtMs);
  return recordResult("dropped", "dropped_closed", bucketStartAtMs);
};

/**
 * Drains every retained optional sample. Shutdown calls this before the process
 * exits. It always settles: a write that stops making progress bounds the wait,
 * and the snapshot then reports `drain_timeouts`/`dispatch_stalled` with the
 * retained and in-flight state instead of hanging the shutdown.
 */
export const flushOptionalPromptCacheAnalytics = (): Promise<void> => optionalPromptCacheAnalyticsQueue?.flush() ?? Promise.resolve();

/**
 * Stops accepting optional samples, then drains the retained ones under the same
 * bounded wait. Terminal before the lazy queue exists too: a close that arrives
 * first is remembered, so a later eligible sample is refused instead of creating
 * an open queue.
 */
export const closeOptionalPromptCacheAnalytics = async (): Promise<void> => {
  optionalPromptCacheAnalyticsClosed = true;
  await optionalPromptCacheAnalyticsQueue?.close();
};

/** Observable queue state: retained, delivered, failed, dropped, timeout and drain evidence. */
export const optionalPromptCacheAnalyticsSnapshot = (): OptionalTelemetryQueueSnapshot | null => optionalPromptCacheAnalyticsQueue?.snapshot() ?? null;

/** Test seam: clears the lazy queue and its terminal close state so a suite can re-exercise first use. */
export const resetOptionalPromptCacheAnalyticsForTest = (): void => {
  optionalPromptCacheAnalyticsClosed = false;
  optionalPromptCacheAnalyticsQueue = null;
};
