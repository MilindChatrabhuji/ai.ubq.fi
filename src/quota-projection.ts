import type { MeteredQuotaBalanceSample, MeteredQuotaSnapshot } from "./metered-quota.ts";
import type { PaidFallbackUsageRollup } from "./paid-fallback/rollups.ts";

/**
 * Pure projection math for the admin "quota runway" view. No KV access here:
 * callers feed settled-usage rollups and a Metered quota snapshot and receive
 * per-model consumption statistics plus exhaustion estimates. Keeping this
 * module free of I/O lets the whole projection be unit-tested deterministically.
 */

export const QUOTA_PROJECTION_WINDOW_DAYS = [7, 30, 90] as const;
export type QuotaProjectionWindowDays = (typeof QUOTA_PROJECTION_WINDOW_DAYS)[number];

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

export type MeteredQuotaRunwayView = Readonly<{
  configured: boolean;
  available: boolean;
  cache_state: string | null;
  confidence: MeteredQuotaSnapshot["state"]["confidence"] | null;
  unlimited_quota: boolean;
  // Wallet mode fields. Token-usage mode keeps these neutral (zero) per the
  // Metered contract and reports totals instead.
  balance_quota: number | null;
  baseline_quota: number | null;
  quota_per_credit: number | null;
  balance_credits: number | null;
  baseline_credits: number | null;
  remaining_percent: number | null;
  used_percent: number | null;
  // Token-usage mode fields.
  total_available: number | null;
  total_granted: number | null;
  total_used: number | null;
  observed_at_ms: number | null;
  cycle_started_at_ms: number | null;
  last_credit_at_ms: number | null;
  latest_refill_amount_credits: number | null;
  latest_refill_completed_at_ms: number | null;
}>;

export const meteredQuotaRunwayView = (snapshot: MeteredQuotaSnapshot | null): MeteredQuotaRunwayView => {
  if (!snapshot) {
    return {
      configured: false,
      available: false,
      cache_state: null,
      confidence: null,
      unlimited_quota: false,
      balance_quota: null,
      baseline_quota: null,
      quota_per_credit: null,
      balance_credits: null,
      baseline_credits: null,
      remaining_percent: null,
      used_percent: null,
      total_available: null,
      total_granted: null,
      total_used: null,
      observed_at_ms: null,
      cycle_started_at_ms: null,
      last_credit_at_ms: null,
      latest_refill_amount_credits: null,
      latest_refill_completed_at_ms: null,
    };
  }
  const state = snapshot.state;
  const tokenUsage = snapshot.unlimited_quota || snapshot.total_available !== null || snapshot.total_used !== null;
  return {
    configured: true,
    available: true,
    cache_state: snapshot.cache_state,
    confidence: tokenUsage ? null : state.confidence,
    unlimited_quota: tokenUsage ? snapshot.unlimited_quota : false,
    balance_quota: tokenUsage ? null : state.current_balance_quota,
    baseline_quota: tokenUsage ? null : state.post_refill_baseline_quota,
    quota_per_credit: state.quota_per_credit,
    balance_credits: snapshot.balance_credits,
    baseline_credits: snapshot.baseline_credits,
    remaining_percent: snapshot.remaining_percent,
    used_percent: snapshot.used_percent,
    total_available: tokenUsage ? snapshot.total_available : null,
    total_granted: tokenUsage ? snapshot.total_granted : null,
    total_used: tokenUsage ? snapshot.total_used : null,
    observed_at_ms: state.observed_at_ms,
    cycle_started_at_ms: tokenUsage ? null : state.cycle_started_at_ms,
    last_credit_at_ms: tokenUsage ? null : state.last_credit_at_ms,
    latest_refill_amount_credits: state.latest_refill_amount_credits,
    latest_refill_completed_at_ms: state.latest_refill_completed_at_ms,
  };
};

export type PaidFallbackModelSeries = Readonly<{
  model: string;
  provider: string;
  buckets: readonly PaidFallbackUsageRollup[];
}>;

export const groupPaidFallbackUsageRollups = (rollups: readonly PaidFallbackUsageRollup[]): PaidFallbackModelSeries[] => {
  const byModelProvider = new Map<string, PaidFallbackUsageRollup[]>();
  for (const rollup of rollups) {
    const identity = `${rollup.model}\u0000${rollup.provider}`;
    const existing = byModelProvider.get(identity);
    if (existing) existing.push(rollup);
    else byModelProvider.set(identity, [rollup]);
  }
  return [...byModelProvider.entries()]
    .map(([identity, buckets]) => {
      // The identity was built in this function from the two rollup fields, so
      // the split always yields both parts; the defaults are type-level only.
      const [model = "", provider = ""] = identity.split("\u0000");
      // `buckets` is the array this call created above, so sorting it in place
      // stays local: the caller only ever sees the returned series.
      buckets.sort((left, right) => left.bucket_start_at_ms - right.bucket_start_at_ms);
      return {
        model,
        provider,
        buckets,
      } satisfies PaidFallbackModelSeries;
    })
    .sort((left, right) => left.model.localeCompare(right.model) || left.provider.localeCompare(right.provider));
};

export type PaidFallbackModelUsageWindow = Readonly<{
  window_days: QuotaProjectionWindowDays;
  bucket_count: number;
  request_count: number;
  quota_sum: number;
  spend_microcredits: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  avg_quota_per_request: number | null;
  quota_per_hour: number | null;
  first_bucket_start_at_ms: number | null;
  last_bucket_start_at_ms: number | null;
}>;

const summarizeWindow = (buckets: readonly PaidFallbackUsageRollup[], windowDays: QuotaProjectionWindowDays, nowMs: number): PaidFallbackModelUsageWindow => {
  // Floor to the hour boundary so the window includes the bucket that
  // contains its start (hourly bucket-level precision is documented).
  const windowStartMs = Math.floor((nowMs - windowDays * DAY_MS) / HOUR_MS) * HOUR_MS;
  const inWindow = buckets.filter((bucket) => bucket.bucket_start_at_ms >= windowStartMs);
  const requestCount = inWindow.reduce((sum, bucket) => sum + bucket.request_count, 0);
  const quotaSum = inWindow.reduce((sum, bucket) => sum + bucket.quota_sum, 0);
  const firstBucket = inWindow.length ? (inWindow[0]?.bucket_start_at_ms ?? null) : null;
  const lastBucket = inWindow.length ? (inWindow[inWindow.length - 1]?.bucket_start_at_ms ?? null) : null;
  // The rate covers the entire selected window, idle hours included: a model
  // used once in the final day of a 30-day window is one request per 30 days,
  // not a daily rate. Labeling it otherwise would overstate the runway.
  const windowHours = windowDays * 24;
  return {
    window_days: windowDays,
    // Shards of the same hour count once.
    bucket_count: new Set(inWindow.map((bucket) => bucket.bucket_start_at_ms)).size,
    request_count: requestCount,
    quota_sum: quotaSum,
    spend_microcredits: inWindow.reduce((sum, bucket) => sum + bucket.spend_microcredits, 0),
    input_tokens: inWindow.reduce((sum, bucket) => sum + bucket.input_tokens, 0),
    cached_input_tokens: inWindow.reduce((sum, bucket) => sum + bucket.cached_input_tokens, 0),
    output_tokens: inWindow.reduce((sum, bucket) => sum + bucket.output_tokens, 0),
    avg_quota_per_request: requestCount > 0 ? quotaSum / requestCount : null,
    quota_per_hour: windowHours > 0 ? quotaSum / windowHours : null,
    first_bucket_start_at_ms: firstBucket,
    last_bucket_start_at_ms: lastBucket,
  };
};

export type PaidFallbackModelUsage = Readonly<{
  model: string;
  provider: string;
  windows: readonly [PaidFallbackModelUsageWindow, PaidFallbackModelUsageWindow, PaidFallbackModelUsageWindow];
}>;

export const summarizePaidFallbackUsage = (series: readonly PaidFallbackModelSeries[], nowMs: number): PaidFallbackModelUsage[] =>
  series.map((entry) => ({
    model: entry.model,
    provider: entry.provider,
    windows: QUOTA_PROJECTION_WINDOW_DAYS.map((windowDays) =>
      summarizeWindow(entry.buckets, windowDays, nowMs)
    ) as unknown as PaidFallbackModelUsage["windows"],
  }));

export type PaidFallbackRunwayEstimate = Readonly<{
  window_days: QuotaProjectionWindowDays;
  unlimited: boolean;
  /** True when the balance snapshot is older than the freshness window. */
  stale_balance: boolean;
  requests_remaining: number | null;
  time_remaining_ms: number | null;
  /** The refill-aware result; `exhausted_at_ms` remains the no-refill contrast. */
  refill_aware_status: "unknown" | "sustainable" | "exhausts_without_refill" | "exhausts_with_refill";
  refill_aware_time_remaining_ms: number | null;
  refill_aware_exhausted_at_ms: number | null;
  refill_amount_credits: number | null;
  refill_cadence_ms: number | null;
  refill_rate_quota_per_hour: number | null;
  next_refill_at_ms: number | null;
  exhausted_at_ms: number | null;
  percent_per_request_vs_balance: number | null;
  percent_per_request_vs_baseline: number | null;
}>;

const positiveFinite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Balance the projection is drawn against. Wallet mode uses the live wallet
 * balance. Token-usage mode reports `total_available` as the remaining
 * inventory ("Available tokens"), so it is used directly — subtracting
 * `total_used` would double-count consumption. Otherwise there is no
 * authoritative balance and estimates are unknown rather than fabricated.
 */
const runwayBalance = (quota: MeteredQuotaRunwayView): number | null => {
  if (quota.unlimited_quota) return null;
  if (quota.balance_quota !== null) return Math.max(0, quota.balance_quota);
  if (quota.total_available !== null) return Math.max(0, quota.total_available);
  return null;
};

const runwayBaseline = (quota: MeteredQuotaRunwayView): number | null => {
  if (quota.unlimited_quota) return null;
  if (quota.baseline_quota !== null) return Math.max(0, quota.baseline_quota);
  return quota.total_granted !== null && quota.total_granted > 0 ? quota.total_granted : null;
};

type RefillProjection = Readonly<{
  status: PaidFallbackRunwayEstimate["refill_aware_status"];
  timeRemainingMs: number | null;
  exhaustedAtMs: number | null;
  amountCredits: number | null;
  cadenceMs: number | null;
  rateQuotaPerHour: number | null;
  nextRefillAtMs: number | null;
}>;

type RefillEvent = Readonly<{
  atMs: number;
  amountQuota: number | null;
}>;

const nonNegativeFinite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * Positive balance changes are the only refill signal retained in hourly
 * history. The latest refill observation supplies the authoritative amount
 * and event time when available; history supplies the repeated event times
 * needed to estimate a cadence.
 */
const refillEventsFromHistory = (samples: readonly MeteredQuotaBalanceSample[], nowMs: number): RefillEvent[] => {
  const ordered = samples
    .filter((sample) => nonNegativeFinite(sample.observed_at_ms) && sample.observed_at_ms <= nowMs && nonNegativeFinite(sample.balance_quota))
    .sort((left, right) => left.observed_at_ms - right.observed_at_ms || left.bucket_start_at_ms - right.bucket_start_at_ms);
  const events: RefillEvent[] = [];
  let previous: MeteredQuotaBalanceSample | null = null;
  for (const sample of ordered) {
    if (previous) {
      const balanceIncrease = sample.balance_quota - previous.balance_quota;
      const baselineIncrease =
        nonNegativeFinite(sample.baseline_quota) && nonNegativeFinite(previous.baseline_quota) ? sample.baseline_quota - previous.baseline_quota : 0;
      const amountQuota = Math.max(balanceIncrease, baselineIncrease);
      if (amountQuota > 0) events.push({ atMs: sample.observed_at_ms, amountQuota });
    }
    previous = sample;
  }
  return events;
};

const mergeObservedRefillEvent = (events: RefillEvent[], observedRefillAtMs: number): void => {
  // The history sample containing a refill can be a little later than the
  // provider's completion timestamp. Replace that sample event rather than
  // treating one refill as two closely-spaced refills.
  let eventAmountQuota: number | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (Math.abs((events[index]?.atMs ?? 0) - observedRefillAtMs) <= HOUR_MS) {
      eventAmountQuota = events[index]?.amountQuota ?? eventAmountQuota;
      events.splice(index, 1);
    }
  }
  events.push({ atMs: observedRefillAtMs, amountQuota: eventAmountQuota });
};

const refillEvents = (quota: MeteredQuotaRunwayView, history: readonly MeteredQuotaBalanceSample[] | null, nowMs: number): RefillEvent[] => {
  const events: RefillEvent[] = history === null ? [] : refillEventsFromHistory(history, nowMs);
  const cycleStartIsRefill =
    quota.latest_refill_completed_at_ms !== null ||
    positiveFinite(quota.latest_refill_amount_credits) ||
    quota.confidence === "refill_observed" ||
    quota.confidence === "inferred_adjustment";
  const observedRefillTimes = [cycleStartIsRefill ? quota.cycle_started_at_ms : null, quota.latest_refill_completed_at_ms].filter(
    (atMs): atMs is number => nonNegativeFinite(atMs) && atMs <= nowMs
  );
  for (const observedRefillAtMs of observedRefillTimes) mergeObservedRefillEvent(events, observedRefillAtMs);
  events.sort((left, right) => left.atMs - right.atMs);
  return events;
};

const refillProjection = (
  quota: MeteredQuotaRunwayView,
  balanceQuota: number | null,
  burnQuotaPerHour: number | null,
  history: readonly MeteredQuotaBalanceSample[] | null,
  nowMs: number
): RefillProjection => {
  const events = refillEvents(quota, history, nowMs);

  const observedAmountQuota =
    positiveFinite(quota.latest_refill_amount_credits) && positiveFinite(quota.quota_per_credit)
      ? quota.latest_refill_amount_credits * quota.quota_per_credit
      : null;
  const amountFromObservation = positiveFinite(observedAmountQuota) ? observedAmountQuota : null;
  const inferredAmountQuota = median(events.map((event) => event.amountQuota).filter((amount): amount is number => positiveFinite(amount)));
  const amountQuota = amountFromObservation ?? inferredAmountQuota;
  const amountCreditsFromObservation = positiveFinite(quota.latest_refill_amount_credits) ? quota.latest_refill_amount_credits : null;
  const amountCreditsFromHistory = amountQuota !== null && positiveFinite(quota.quota_per_credit) ? amountQuota / quota.quota_per_credit : null;
  const amountCredits = amountCreditsFromObservation ?? amountCreditsFromHistory;
  const intervals = events
    .slice(1)
    .map((event, index) => event.atMs - (events[index]?.atMs ?? event.atMs))
    .filter((interval) => positiveFinite(interval));
  const cadenceMs = median(intervals);
  const calculatedRateQuotaPerHour = amountQuota !== null && cadenceMs !== null ? amountQuota / (cadenceMs / HOUR_MS) : null;
  const rateQuotaPerHour = positiveFinite(calculatedRateQuotaPerHour) ? calculatedRateQuotaPerHour : null;
  const unknown: RefillProjection = {
    status: "unknown",
    timeRemainingMs: null,
    exhaustedAtMs: null,
    amountCredits,
    cadenceMs,
    rateQuotaPerHour,
    nextRefillAtMs: null,
  };
  if (balanceQuota === null || !positiveFinite(burnQuotaPerHour)) return unknown;
  const noRefillTimeRemainingMs = Math.trunc((balanceQuota / burnQuotaPerHour) * HOUR_MS);
  const noRefill: RefillProjection = {
    ...unknown,
    status: "exhausts_without_refill",
    timeRemainingMs: noRefillTimeRemainingMs,
    exhaustedAtMs: Math.trunc(nowMs + noRefillTimeRemainingMs),
  };
  if (cadenceMs === null || amountQuota === null || !positiveFinite(rateQuotaPerHour)) {
    return history === null ? unknown : noRefill;
  }

  const latestEventAtMs = events.at(-1)?.atMs ?? null;
  if (latestEventAtMs === null) return history === null ? unknown : noRefill;
  let periodsUntilNext = 0;
  if (latestEventAtMs < nowMs) periodsUntilNext = Math.ceil((nowMs - latestEventAtMs) / cadenceMs);
  else if (latestEventAtMs === nowMs) periodsUntilNext = 1;
  const nextRefillAtMs = latestEventAtMs + periodsUntilNext * cadenceMs;
  const hoursUntilNextRefill = Math.max(0, (nextRefillAtMs - nowMs) / HOUR_MS);
  const balanceAtNextRefill = balanceQuota - burnQuotaPerHour * hoursUntilNextRefill;
  if (balanceAtNextRefill < 0) {
    return {
      ...noRefill,
      amountCredits,
      cadenceMs,
      rateQuotaPerHour,
      nextRefillAtMs,
    };
  }

  const cycleBurnQuota = burnQuotaPerHour * (cadenceMs / HOUR_MS);
  if (rateQuotaPerHour >= burnQuotaPerHour) {
    return {
      status: "sustainable",
      timeRemainingMs: null,
      exhaustedAtMs: null,
      amountCredits,
      cadenceMs,
      rateQuotaPerHour,
      nextRefillAtMs,
    };
  }

  const balanceAfterFirstRefill = balanceAtNextRefill + amountQuota;
  const cycleLossQuota = cycleBurnQuota - amountQuota;
  const cyclesUntilExhaustion =
    balanceAfterFirstRefill < cycleBurnQuota ? 0 : Math.floor((balanceAfterFirstRefill - cycleBurnQuota) / cycleLossQuota) + 1;
  const balanceBeforeExhaustion = balanceAfterFirstRefill - cyclesUntilExhaustion * cycleLossQuota;
  const exhaustedAtMs = Math.trunc(nextRefillAtMs + cyclesUntilExhaustion * cadenceMs + (balanceBeforeExhaustion / burnQuotaPerHour) * HOUR_MS);
  const timeRemainingMs = Math.max(0, exhaustedAtMs - nowMs);
  return {
    status: "exhausts_with_refill",
    timeRemainingMs,
    exhaustedAtMs,
    amountCredits,
    cadenceMs,
    rateQuotaPerHour,
    nextRefillAtMs,
  };
};

/**
 * Projections are only meaningful for the provider whose balance is being
 * monitored. `METERED_API_KEY` monitors the OpenLux account, which serves
 * `provider: "metered"` rows; Surplus Intelligence has its own billing with
 * no quota snapshot in this gateway. Returning no estimate for other
 * providers avoids reporting Surplus history against the OpenLux balance.
 */
export const projectPaidFallbackRunway = (
  usage: PaidFallbackModelUsage,
  quota: MeteredQuotaRunwayView,
  nowMs: number,
  /** Null distinguishes an unavailable history scan from an empty retained history. */
  balanceHistory: readonly MeteredQuotaBalanceSample[] | null = []
): PaidFallbackRunwayEstimate[] => {
  if (usage.provider !== "metered") return [];
  const balanceQuota = runwayBalance(quota);
  const baselineQuota = runwayBaseline(quota);
  const unlimited = quota.unlimited_quota;
  const staleBalance = quota.cache_state === "stale";
  return usage.windows.map((window) => {
    if (unlimited) {
      return {
        window_days: window.window_days,
        unlimited: true,
        stale_balance: staleBalance,
        requests_remaining: null,
        time_remaining_ms: null,
        refill_aware_status: "unknown",
        refill_aware_time_remaining_ms: null,
        refill_aware_exhausted_at_ms: null,
        refill_amount_credits: null,
        refill_cadence_ms: null,
        refill_rate_quota_per_hour: null,
        next_refill_at_ms: null,
        exhausted_at_ms: null,
        percent_per_request_vs_balance: null,
        percent_per_request_vs_baseline: null,
      };
    }
    const avgQuota = window.avg_quota_per_request;
    const quotaPerHour = window.quota_per_hour;
    const requestsRemaining = balanceQuota !== null && positiveFinite(avgQuota) ? Math.floor(balanceQuota / avgQuota) : null;
    const timeRemainingMs = balanceQuota !== null && positiveFinite(quotaPerHour) ? Math.trunc((balanceQuota / quotaPerHour) * HOUR_MS) : null;
    const refill = refillProjection(quota, balanceQuota, quotaPerHour, balanceHistory, nowMs);
    return {
      window_days: window.window_days,
      unlimited: false,
      stale_balance: staleBalance,
      requests_remaining: requestsRemaining,
      time_remaining_ms: timeRemainingMs,
      refill_aware_status: refill.status,
      refill_aware_time_remaining_ms: refill.timeRemainingMs,
      refill_aware_exhausted_at_ms: refill.exhaustedAtMs,
      refill_amount_credits: refill.amountCredits,
      refill_cadence_ms: refill.cadenceMs,
      refill_rate_quota_per_hour: refill.rateQuotaPerHour,
      next_refill_at_ms: refill.nextRefillAtMs,
      exhausted_at_ms: timeRemainingMs !== null ? nowMs + timeRemainingMs : null,
      percent_per_request_vs_balance: balanceQuota !== null && positiveFinite(avgQuota) && balanceQuota > 0 ? (avgQuota / balanceQuota) * 100 : null,
      percent_per_request_vs_baseline: baselineQuota !== null && positiveFinite(avgQuota) && baselineQuota > 0 ? (avgQuota / baselineQuota) * 100 : null,
    };
  });
};
