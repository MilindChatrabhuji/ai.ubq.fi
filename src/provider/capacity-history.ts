import type { Kv, KvKey } from "#kv";
// Provider capacity history, transition detection and rate-limit recovery, split out of src/provider_capacity.ts.

import {
  PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
  PROVIDER_CAPACITY_HISTORY_KEY_PREFIX,
  PROVIDER_CAPACITY_HISTORY_RETENTION_MS,
  PROVIDER_CAPACITY_RATE_LIMIT_RESET_MIN_GAIN_PERCENTAGE_POINTS,
} from "./capacity-contract.ts";
import type {
  ProviderCapacityCodexSource,
  ProviderCapacityHistoryPoint,
  ProviderCapacityMeteredSource,
  ProviderCapacitySnapshot,
  ProviderCapacityWindow,
  StoredRateLimitObservation,
} from "./capacity-contract.ts";
import {
  PROVIDER_CAPACITY_RESET_EVENT_RETENTION_MS,
  providerCapacityRateLimitResetEventKey,
  type ProviderCapacityRateLimitResetEvent,
} from "./capacity-events.ts";
import { isRecord } from "../utils.ts";
import { isSafeTimestamp, readStoredCodexSource, readStoredHistoryPoint, unavailableCodexSource, unavailableMeteredSource } from "./capacity-parse.ts";

export const providerCapacityHistoryKey = (bucketStartAtMs: number): KvKey => [...PROVIDER_CAPACITY_HISTORY_KEY_PREFIX, bucketStartAtMs];

// A live refresh can observe a banked reset inside the same 15-minute bucket
// as the exhausted sample. Keep that earlier point under a sibling key so the
// chart can show the zero-to-refill transition without turning every refresh
// into an unbounded history stream.
const providerCapacityHistoryTransitionKey = (bucketStartAtMs: number, previousSampledAtMs: number): KvKey => [
  ...PROVIDER_CAPACITY_HISTORY_KEY_PREFIX,
  bucketStartAtMs,
  "transition",
  previousSampledAtMs,
];

const readCapacityHistory = async (kv: Kv, nowMs: number): Promise<ProviderCapacityHistoryPoint[]> => {
  const cutoffMs = Math.max(0, nowMs - PROVIDER_CAPACITY_HISTORY_RETENTION_MS);
  const newestBucketMs = Math.floor(nowMs / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const points: ProviderCapacityHistoryPoint[] = [];
  try {
    for await (const entry of kv.list({ prefix: PROVIDER_CAPACITY_HISTORY_KEY_PREFIX })) {
      const keyBucket = entry.key[PROVIDER_CAPACITY_HISTORY_KEY_PREFIX.length];
      if (typeof keyBucket !== "number" || keyBucket < cutoffMs || keyBucket > newestBucketMs) continue;
      const point = readStoredHistoryPoint(entry.value);
      if (point?.bucket_start_at_ms !== keyBucket) continue;
      points.push(point);
    }
  } catch {
    return [];
  }
  return points.sort((left, right) => left.bucket_start_at_ms - right.bucket_start_at_ms || left.sampled_at_ms - right.sampled_at_ms);
};

const historyBucketStartAtMs = (snapshotAtMs: number): number =>
  Math.floor(snapshotAtMs / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;

const historyPointForSnapshot = (snapshot: ProviderCapacitySnapshot): ProviderCapacityHistoryPoint => {
  const sourceForSlot = (slot: 1 | 2): ProviderCapacityCodexSource => {
    const source = snapshot.sources.find((candidate) => candidate.source === "codex" && candidate.slot === slot);
    return source?.source === "codex" ? source : unavailableCodexSource(slot, snapshot.snapshot_at_ms);
  };
  const sourceForMetered = (): ProviderCapacityMeteredSource => {
    const source = snapshot.sources.find((candidate) => candidate.source === "metered");
    return source?.source === "metered" ? source : unavailableMeteredSource(snapshot.snapshot_at_ms);
  };
  return {
    bucket_start_at_ms: historyBucketStartAtMs(snapshot.snapshot_at_ms),
    sampled_at_ms: snapshot.snapshot_at_ms,
    sources: [sourceForSlot(1), sourceForSlot(2), sourceForMetered()],
  };
};

const mergeHistoryPoints = (points: readonly ProviderCapacityHistoryPoint[], addition: ProviderCapacityHistoryPoint): ProviderCapacityHistoryPoint[] => {
  const bySample = new Map<string, ProviderCapacityHistoryPoint>();
  for (const point of points) bySample.set(`${point.bucket_start_at_ms}:${point.sampled_at_ms}`, point);
  bySample.set(`${addition.bucket_start_at_ms}:${addition.sampled_at_ms}`, addition);
  return [...bySample.values()].sort((left, right) => left.bucket_start_at_ms - right.bucket_start_at_ms || left.sampled_at_ms - right.sampled_at_ms);
};

const sameCodexAccountCohort = (left: ProviderCapacityCodexSource, right: ProviderCapacityCodexSource): boolean =>
  left.account_cohort_id !== null && left.account_cohort_id === right.account_cohort_id;

const codexResetTransitionObserved = (previous: ProviderCapacityHistoryPoint | null, current: ProviderCapacityHistoryPoint): boolean => {
  if (!previous || previous.sampled_at_ms >= current.sampled_at_ms) return false;
  for (const slot of [1, 2] as const) {
    const previousSource = previous.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === slot);
    const currentSource = current.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === slot);
    if (
      !previousSource ||
      !currentSource ||
      previousSource.state === "unavailable" ||
      currentSource.state === "unavailable" ||
      !sameCodexAccountCohort(previousSource, currentSource)
    ) {
      continue;
    }
    for (const windowKey of ["primary", "secondary"] as const) {
      const previousWindow = previousSource.windows[windowKey];
      const currentWindow = currentSource.windows[windowKey];
      if (
        previousWindow?.used_percent !== null &&
        currentWindow?.used_percent !== null &&
        typeof previousWindow?.used_percent === "number" &&
        typeof currentWindow?.used_percent === "number" &&
        previousWindow.used_percent >= 90 &&
        currentWindow.used_percent <= 20 &&
        previousWindow.reset_at_ms === currentWindow.reset_at_ms
      )
        return true;
    }
  }
  return false;
};

const codexAvailabilityTransitionObserved = (previous: ProviderCapacityHistoryPoint | null, current: ProviderCapacityHistoryPoint): boolean => {
  if (!previous || previous.sampled_at_ms >= current.sampled_at_ms) return false;
  for (const slot of [1, 2] as const) {
    const previousSource = previous.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === slot);
    const currentSource = current.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === slot);
    if (
      previousSource &&
      currentSource &&
      sameCodexAccountCohort(previousSource, currentSource) &&
      (previousSource.state === "unavailable") !== (currentSource.state === "unavailable")
    )
      return true;
  }
  return false;
};

const readStoredRateLimitObservation = (value: unknown): StoredRateLimitObservation | null => {
  if (!isRecord(value) || !isSafeTimestamp(value.sampled_at_ms)) return null;
  const source = readStoredCodexSource(value.source, value.sampled_at_ms);
  return source?.state === "available" ? { sampled_at_ms: value.sampled_at_ms, source } : null;
};

const latestAvailableRateLimitObservation = (
  history: readonly ProviderCapacityHistoryPoint[],
  slot: 1 | 2,
  accountCohortId: string,
  beforeSampledAtMs: number
): StoredRateLimitObservation | null => {
  const observations = history.flatMap((point) => {
    if (point.sampled_at_ms >= beforeSampledAtMs) return [];
    const source = point.sources.find(
      (candidate): candidate is ProviderCapacityCodexSource =>
        candidate.source === "codex" && candidate.slot === slot && candidate.state !== "unavailable" && candidate.account_cohort_id === accountCohortId
    );
    return source ? [{ sampled_at_ms: point.sampled_at_ms, source }] : [];
  });
  observations.sort((left, right) => right.sampled_at_ms - left.sampled_at_ms);
  return observations[0] ?? null;
};

/**
 * Build one OpenAI rate-limit reset event for a single window. A reset only
 * counts when both samples carry the window fields and a later reset boundary
 * comes with a real capacity gain.
 */
const rateLimitResetEventForWindow = (input: {
  slot: 1 | 2;
  window: "primary" | "secondary";
  previousSampledAtMs: number;
  previousWindow: ProviderCapacityWindow | null;
  currentSampledAtMs: number;
  currentWindow: ProviderCapacityWindow | null;
}): ProviderCapacityRateLimitResetEvent | null => {
  const { previousWindow, currentWindow } = input;
  if (
    typeof previousWindow?.used_percent !== "number" ||
    typeof currentWindow?.used_percent !== "number" ||
    typeof previousWindow.reset_at_ms !== "number" ||
    typeof currentWindow.reset_at_ms !== "number" ||
    currentWindow.reset_at_ms <= previousWindow.reset_at_ms
  )
    return null;
  const capacityGain = previousWindow.used_percent - currentWindow.used_percent;
  if (capacityGain < PROVIDER_CAPACITY_RATE_LIMIT_RESET_MIN_GAIN_PERCENTAGE_POINTS) return null;
  return {
    v: 1,
    event_id: `openai-${input.slot}-${input.window}-${input.previousSampledAtMs}-${input.currentSampledAtMs}`,
    provider: "openai",
    slot: input.slot,
    window: input.window,
    observed_at_ms: input.currentSampledAtMs,
    previous_sampled_at_ms: input.previousSampledAtMs,
    previous_reset_at_ms: previousWindow.reset_at_ms,
    reset_at_ms: currentWindow.reset_at_ms,
    previous_used_percent: previousWindow.used_percent,
    current_used_percent: currentWindow.used_percent,
    capacity_gain_percentage_points: capacityGain,
  };
};

const observedRateLimitResetEvents = (
  previous: ProviderCapacitySnapshot | null,
  current: ProviderCapacitySnapshot,
  lastAvailableObservations: readonly StoredRateLimitObservation[] = []
): ProviderCapacityRateLimitResetEvent[] => {
  if (previous && previous.snapshot_at_ms >= current.snapshot_at_ms) return [];
  const events: ProviderCapacityRateLimitResetEvent[] = [];
  for (const slot of [1, 2] as const) {
    const currentSource = current.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === slot);
    if (!currentSource || currentSource.state === "unavailable") continue;
    const previousSource = previous?.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === slot);
    const previousObservation =
      previous && previousSource && previousSource.state !== "unavailable" && sameCodexAccountCohort(previousSource, currentSource)
        ? { sampled_at_ms: previous.snapshot_at_ms, source: previousSource }
        : (lastAvailableObservations.find(
            (observation) =>
              observation.source.slot === slot &&
              observation.sampled_at_ms < current.snapshot_at_ms &&
              sameCodexAccountCohort(observation.source, currentSource)
          ) ?? null);
    if (!previousObservation) continue;
    for (const window of ["primary", "secondary"] as const) {
      const event = rateLimitResetEventForWindow({
        slot,
        window,
        previousSampledAtMs: previousObservation.sampled_at_ms,
        previousWindow: previousObservation.source.windows[window],
        currentSampledAtMs: current.snapshot_at_ms,
        currentWindow: currentSource.windows[window],
      });
      if (event) events.push(event);
    }
  }
  return events;
};

// An unavailable sample either keeps tracking an outage for the same account
// cohort, or clears the tracked window.
const trackHistoricalOutage = (
  previousAvailable: StoredRateLimitObservation | null,
  source: ProviderCapacityCodexSource | undefined
): Readonly<{ previousAvailable: StoredRateLimitObservation | null; outageObserved: boolean }> =>
  previousAvailable && source && sameCodexAccountCohort(previousAvailable.source, source)
    ? { previousAvailable, outageObserved: true }
    : { previousAvailable: null, outageObserved: false };

const pushHistoricalRateLimitResetEvents = (
  slot: 1 | 2,
  point: ProviderCapacityHistoryPoint,
  previousAvailable: StoredRateLimitObservation,
  source: ProviderCapacityCodexSource,
  events: ProviderCapacityRateLimitResetEvent[]
): void => {
  for (const window of ["primary", "secondary"] as const) {
    const event = rateLimitResetEventForWindow({
      slot,
      window,
      previousSampledAtMs: previousAvailable.sampled_at_ms,
      previousWindow: previousAvailable.source.windows[window],
      currentSampledAtMs: point.sampled_at_ms,
      currentWindow: source.windows[window],
    });
    if (event) events.push(event);
  }
};

const observeHistoricalSlotRateLimitResets = (
  slot: 1 | 2,
  sortedHistory: readonly ProviderCapacityHistoryPoint[],
  events: ProviderCapacityRateLimitResetEvent[]
): void => {
  let previousAvailable: StoredRateLimitObservation | null = null;
  let outageObserved = false;
  for (const point of sortedHistory) {
    const source = point.sources.find((candidate): candidate is ProviderCapacityCodexSource => candidate.source === "codex" && candidate.slot === slot);
    if (!source || source.state === "unavailable") {
      const outage = trackHistoricalOutage(previousAvailable, source);
      previousAvailable = outage.previousAvailable;
      outageObserved = outage.outageObserved;
      continue;
    }
    if (previousAvailable && outageObserved && sameCodexAccountCohort(previousAvailable.source, source)) {
      pushHistoricalRateLimitResetEvents(slot, point, previousAvailable, source, events);
    }
    previousAvailable = source.state === "available" ? { sampled_at_ms: point.sampled_at_ms, source } : previousAvailable;
    outageObserved = false;
  }
};

const observedHistoricalRateLimitResetEvents = (history: readonly ProviderCapacityHistoryPoint[]): ProviderCapacityRateLimitResetEvent[] => {
  const events: ProviderCapacityRateLimitResetEvent[] = [];
  const sortedHistory = [...history].sort((left, right) => left.sampled_at_ms - right.sampled_at_ms);
  for (const slot of [1, 2] as const) observeHistoricalSlotRateLimitResets(slot, sortedHistory, events);
  return events;
};

const mergeHistoricalRateLimitResetEvents = async (
  kv: Kv,
  history: readonly ProviderCapacityHistoryPoint[],
  events: readonly ProviderCapacityRateLimitResetEvent[]
): Promise<readonly ProviderCapacityRateLimitResetEvent[]> => {
  const merged = new Map(events.map((event) => [event.event_id, event]));
  for (const event of observedHistoricalRateLimitResetEvents(history)) {
    if (merged.has(event.event_id)) continue;
    try {
      await kv.set(providerCapacityRateLimitResetEventKey(event.event_id), event, {
        expireIn: PROVIDER_CAPACITY_RESET_EVENT_RETENTION_MS,
      });
    } catch {
      // The view can still show a validated inference if a best-effort marker write fails.
    }
    merged.set(event.event_id, event);
  }
  return [...merged.values()].sort((left, right) => left.observed_at_ms - right.observed_at_ms || left.event_id.localeCompare(right.event_id));
};

// A codex source that comes back after an outage is a recovery candidate when the
// account cohort matches and no last-available observation covers it yet.
const recoverySlotsForSnapshot = (
  snapshot: ProviderCapacitySnapshot,
  previousSnapshot: ProviderCapacitySnapshot | null,
  lastAvailableObservations: readonly StoredRateLimitObservation[]
): (1 | 2)[] =>
  snapshot.sources.flatMap((source) => {
    if (source.source !== "codex" || source.state === "unavailable") return [];
    const previousSource = previousSnapshot?.sources.find(
      (candidate): candidate is ProviderCapacityCodexSource => candidate.source === "codex" && candidate.slot === source.slot
    );
    return previousSource?.state === "unavailable" &&
      sameCodexAccountCohort(previousSource, source) &&
      !lastAvailableObservations.some((observation) => observation.source.slot === source.slot && sameCodexAccountCohort(observation.source, source))
      ? [source.slot]
      : [];
  });

const recoverRateLimitObservations = async (
  kv: Kv,
  snapshot: ProviderCapacitySnapshot,
  recoverySlots: readonly (1 | 2)[]
): Promise<StoredRateLimitObservation[]> => {
  if (recoverySlots.length === 0) return [];
  const retainedHistory = await readCapacityHistory(kv, snapshot.snapshot_at_ms).catch(() => []);
  const recovered: StoredRateLimitObservation[] = [];
  for (const slot of recoverySlots) {
    const source = snapshot.sources.find((candidate): candidate is ProviderCapacityCodexSource => candidate.source === "codex" && candidate.slot === slot);
    if (!source?.account_cohort_id) continue;
    const observation = latestAvailableRateLimitObservation(retainedHistory, slot, source.account_cohort_id, snapshot.snapshot_at_ms);
    if (observation) recovered.push(observation);
  }
  return recovered;
};

const lastAvailableCapacityEntries = (snapshot: ProviderCapacitySnapshot): readonly Readonly<{ slot: 1 | 2; value: StoredRateLimitObservation }>[] =>
  snapshot.sources.flatMap((source) =>
    source.source === "codex" && source.state === "available" ? [{ slot: source.slot, value: { sampled_at_ms: snapshot.snapshot_at_ms, source } }] : []
  );

export {
  codexAvailabilityTransitionObserved,
  codexResetTransitionObserved,
  historyPointForSnapshot,
  lastAvailableCapacityEntries,
  mergeHistoricalRateLimitResetEvents,
  mergeHistoryPoints,
  observedRateLimitResetEvents,
  providerCapacityHistoryTransitionKey,
  readCapacityHistory,
  readStoredRateLimitObservation,
  recoverRateLimitObservations,
  recoverySlotsForSnapshot,
  sameCodexAccountCohort,
};
