import type { Kv, KvKey } from "#kv";
// Provider capacity parsing and stored-snapshot decoding, split out of src/provider_capacity.ts.

import { config } from "../config.ts";
import { getString, isRecord } from "../utils.ts";
import {
  ADDITIONAL_WINDOW_UNANCHORED_TOLERANCE_MS,
  PROVIDER_CAPACITY_LAST_AVAILABLE_KEY_PREFIX,
  PROVIDER_CAPACITY_SNAPSHOT_KEY,
  PROVIDER_CAPACITY_SOURCE_STALE_MS,
  SHA256_HEX,
} from "./capacity-contract.ts";
import type {
  CapacityState,
  ProviderCapacityAdditionalRateLimit,
  ProviderCapacityCodexSource,
  ProviderCapacityFailureKind,
  ProviderCapacityHistoryPoint,
  ProviderCapacityMeteredSource,
  ProviderCapacitySnapshot,
  ProviderCapacityWindow,
} from "./capacity-contract.ts";

export const codexAccountLabel = (slot: number, email: string | null = null): string => {
  const trimmedEmail = email?.trim() ?? "";
  // A blank label would hide the account, so an empty or whitespace-only email
  // still falls back to the slot label.
  if (trimmedEmail) return trimmedEmail;
  return `Codex account ${slot}`;
};

const providerCapacityLastAvailableKey = (slot: 1 | 2): KvKey => [...PROVIDER_CAPACITY_LAST_AVAILABLE_KEY_PREFIX, slot];

const capacityState = (value: unknown): CapacityState | null => (value === "available" || value === "stale" || value === "unavailable" ? value : null);

const safeNow = (now: () => number): number => {
  const value = Math.trunc(now());
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
};

const isSafeTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const optionalStoredNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const optionalStoredTimestamp = (value: unknown): number | null => (isSafeTimestamp(value) ? value : null);

const optionalStoredBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const codexUsageUrl = (): string => new URL("/backend-api/wham/usage", config.codexBaseUrl).toString();

const parsePercent = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);

const parseWindowSeconds = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

const parseResetAtMs = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  const milliseconds = value * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
};

const parseCodexWindow = (value: unknown): ProviderCapacityWindow | null => {
  if (!isRecord(value)) return null;
  const limitWindowSeconds = parseWindowSeconds(value.limit_window_seconds);
  const usedPercent = parsePercent(value.used_percent);
  const resetAtMs = parseResetAtMs(value.reset_at);
  if (limitWindowSeconds === null && usedPercent === null && resetAtMs === null) return null;
  return {
    limit_window_seconds: limitWindowSeconds,
    used_percent: usedPercent,
    reset_at_ms: resetAtMs,
  };
};

const isUnanchoredAdditionalWindow = (window: ProviderCapacityWindow | null, snapshotAtMs: number): boolean => {
  if (window?.used_percent !== 0 || window.limit_window_seconds === null || window.reset_at_ms === null) return false;
  const fullWindowMs = window.limit_window_seconds * 1_000;
  if (!Number.isSafeInteger(fullWindowMs)) return false;
  const expectedResetAtMs = snapshotAtMs + fullWindowMs;
  return Number.isSafeInteger(expectedResetAtMs) && Math.abs(window.reset_at_ms - expectedResetAtMs) <= ADDITIONAL_WINDOW_UNANCHORED_TOLERANCE_MS;
};

const parseCodexAdditionalRateLimit = (value: unknown): ProviderCapacityAdditionalRateLimit | null => {
  if (!isRecord(value)) return null;
  const limitName = typeof value.limit_name === "string" ? value.limit_name.trim() : "";
  if (!limitName) return null;
  const meteredFeature = typeof value.metered_feature === "string" ? value.metered_feature.trim() || null : null;
  const rateLimit = isRecord(value.rate_limit) ? value.rate_limit : null;
  const parsedPrimary = parseCodexWindow(rateLimit?.primary_window);
  const parsedSecondary = parseCodexWindow(rateLimit?.secondary_window);
  if (!parsedPrimary && !parsedSecondary) return null;
  return {
    limit_name: limitName,
    metered_feature: meteredFeature,
    windows: {
      // Keep OpenAI's unused model window for the admin card. Routing filters
      // this unanchored value separately because its reset is not evidence of
      // a shared quota cycle.
      primary: parsedPrimary,
      secondary: parsedSecondary,
    },
  };
};

const additionalRateLimitsForRouting = (
  limits: readonly ProviderCapacityAdditionalRateLimit[],
  snapshotAtMs: number
): readonly ProviderCapacityAdditionalRateLimit[] =>
  limits.flatMap((limit) => {
    const primary = isUnanchoredAdditionalWindow(limit.windows.primary, snapshotAtMs) ? null : limit.windows.primary;
    const secondary = isUnanchoredAdditionalWindow(limit.windows.secondary, snapshotAtMs) ? null : limit.windows.secondary;
    if (!primary && !secondary) return [];
    return [
      {
        ...limit,
        windows: { primary, secondary },
      },
    ];
  });

/**
 * Admin diagnostics only: the upstream overage balance and limit flag exactly
 * as returned. The balance stays the upstream decimal string; a missing or
 * malformed pair means the sample is unavailable rather than zero.
 */
export type ProviderCapacityOverageUsage = Readonly<{ balance: string | null; overage_limit_reached: boolean | null }>;

const parseCodexOverageUsage = (value: unknown): ProviderCapacityOverageUsage | null => {
  if (!isRecord(value)) return null;
  // The live /backend-api/wham/usage payload nests both fields under `credits`.
  const credits = isRecord(value.credits) ? value.credits : null;
  if (!credits) return null;
  const balance = getString(credits.balance);
  const overageLimitReached = typeof credits.overage_limit_reached === "boolean" ? credits.overage_limit_reached : null;
  if (balance === null && overageLimitReached === null) return null;
  return { balance, overage_limit_reached: overageLimitReached };
};

const parseCodexUsage = (
  value: unknown
): Readonly<{
  primary: ProviderCapacityWindow | null;
  secondary: ProviderCapacityWindow | null;
  additional_rate_limits: readonly ProviderCapacityAdditionalRateLimit[];
}> | null => {
  if (!isRecord(value) || !isRecord(value.rate_limit)) return null;
  const additionalRateLimits = Array.isArray(value.additional_rate_limits)
    ? value.additional_rate_limits.flatMap((candidate) => {
        const parsed = parseCodexAdditionalRateLimit(candidate);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    primary: parseCodexWindow(value.rate_limit.primary_window),
    secondary: parseCodexWindow(value.rate_limit.secondary_window),
    additional_rate_limits: additionalRateLimits,
  };
};

const emptyWindows = (): Readonly<{
  primary: null;
  secondary: null;
}> => ({ primary: null, secondary: null });

const unavailableCodexSource = (
  slot: 1 | 2,
  snapshotAtMs: number,
  failureKind: ProviderCapacityFailureKind = "not_configured",
  failureStatus: number | null = null,
  observed = false,
  label = codexAccountLabel(slot),
  accountCohortId: string | null = null
): ProviderCapacityCodexSource => ({
  source: "codex",
  label,
  slot,
  account_cohort_id: accountCohortId,
  state: "unavailable",
  source_observed_at_ms: observed ? snapshotAtMs : null,
  snapshot_at_ms: snapshotAtMs,
  failure_kind: failureKind,
  failure_status: failureStatus,
  windows: emptyWindows(),
  additional_rate_limits: [],
});

const unavailableMeteredSource = (snapshotAtMs: number): ProviderCapacityMeteredSource => ({
  source: "metered",
  label: "Metered fallback",
  state: "unavailable",
  source_observed_at_ms: null,
  snapshot_at_ms: snapshotAtMs,
  wallet: {
    balance_credits: null,
    baseline_credits: null,
    refill_cycle_remaining_percent: null,
    refill_cycle_used_percent: null,
    unlimited_quota: null,
    total_available: null,
    total_granted: null,
    total_used: null,
    cycle_started_at_ms: null,
    last_credit_at_ms: null,
    confidence: null,
    cache_state: null,
    reset_at_ms: null,
  },
});

const isStoredWindow = (value: unknown): value is ProviderCapacityWindow => {
  if (!isRecord(value)) return false;
  return (
    (value.limit_window_seconds === null || parseWindowSeconds(value.limit_window_seconds) !== null) &&
    (value.used_percent === null || parsePercent(value.used_percent) !== null) &&
    (value.reset_at_ms === null || isSafeTimestamp(value.reset_at_ms))
  );
};

const readStoredWindow = (value: unknown): ProviderCapacityWindow | null =>
  isStoredWindow(value)
    ? {
        limit_window_seconds: value.limit_window_seconds,
        used_percent: value.used_percent,
        reset_at_ms: value.reset_at_ms,
      }
    : null;

const readStoredAdditionalRateLimit = (value: unknown): ProviderCapacityAdditionalRateLimit | null => {
  if (!isRecord(value) || typeof value.limit_name !== "string" || !value.limit_name.trim()) return null;
  const windows = isRecord(value.windows) ? value.windows : null;
  if (!windows) return null;
  const meteredFeature = value.metered_feature;
  if (meteredFeature !== null && typeof meteredFeature !== "string") return null;
  return {
    limit_name: value.limit_name.trim(),
    metered_feature: typeof meteredFeature === "string" ? meteredFeature.trim() || null : null,
    windows: {
      primary: readStoredWindow(windows.primary),
      secondary: readStoredWindow(windows.secondary),
    },
  };
};

const readStoredAdditionalRateLimits = (value: unknown): readonly ProviderCapacityAdditionalRateLimit[] =>
  Array.isArray(value)
    ? value.flatMap((candidate) => {
        const parsed = readStoredAdditionalRateLimit(candidate);
        return parsed ? [parsed] : [];
      })
    : [];

const isProviderCapacityFailureKind = (value: unknown): value is ProviderCapacityFailureKind =>
  value === "not_configured" || value === "http_error" || value === "upstream_error" || value === "unreachable" || value === "invalid_response";

const readStoredFailureStatus = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;

// A stored record may omit its failure fields. An unavailable source then means
// "not configured", while an available source must not claim any failure at all;
// a present-but-unknown kind invalidates the whole record.
const readStoredCodexFailure = (
  source: Record<string, unknown>,
  state: CapacityState
): Readonly<{ failure_kind: ProviderCapacityFailureKind | null; failure_status: number | null }> | null => {
  const storedKind = source.failure_kind;
  if (storedKind !== null && storedKind !== undefined && !isProviderCapacityFailureKind(storedKind)) return null;
  const defaultFailureKind: ProviderCapacityFailureKind | null = state === "unavailable" ? "not_configured" : null;
  const failureKind = isProviderCapacityFailureKind(storedKind) ? storedKind : defaultFailureKind;
  const failureStatus = readStoredFailureStatus(source.failure_status);
  if (state === "available" && (failureKind !== null || failureStatus !== null)) return null;
  return { failure_kind: failureKind, failure_status: failureStatus };
};

const readStoredCodexSource = (value: unknown, fallbackSnapshotAtMs: number): ProviderCapacityCodexSource | null => {
  if (!isRecord(value) || value.source !== "codex" || (value.slot !== 1 && value.slot !== 2)) return null;
  const state = capacityState(value.state);
  const observed = value.source_observed_at_ms;
  const snapshotAtMs = value.snapshot_at_ms === undefined ? fallbackSnapshotAtMs : value.snapshot_at_ms;
  if (!state || !(observed === null || isSafeTimestamp(observed)) || !isSafeTimestamp(snapshotAtMs)) return null;
  const failure = readStoredCodexFailure(value, state);
  if (!failure) return null;
  const windows = isRecord(value.windows) ? value.windows : null;
  if (!windows) return null;
  return {
    source: "codex",
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : codexAccountLabel(value.slot),
    slot: value.slot,
    account_cohort_id: typeof value.account_cohort_id === "string" && SHA256_HEX.test(value.account_cohort_id) ? value.account_cohort_id : null,
    state,
    source_observed_at_ms: observed,
    snapshot_at_ms: snapshotAtMs,
    failure_kind: state === "available" ? null : failure.failure_kind,
    failure_status: state === "available" ? null : failure.failure_status,
    windows: {
      primary: readStoredWindow(windows.primary),
      secondary: readStoredWindow(windows.secondary),
    },
    additional_rate_limits: readStoredAdditionalRateLimits(value.additional_rate_limits),
  };
};

const readStoredMeteredSource = (value: unknown, snapshotAtMs: number): ProviderCapacityMeteredSource | null => {
  if (!isRecord(value) || value.source !== "metered") return null;
  const state = capacityState(value.state);
  const observed = value.source_observed_at_ms;
  const wallet = isRecord(value.wallet) ? value.wallet : null;
  if (!state || !wallet || !(observed === null || isSafeTimestamp(observed))) return null;
  const confidence =
    wallet.confidence === null || wallet.confidence === "provisional" || wallet.confidence === "refill_observed" || wallet.confidence === "inferred_adjustment"
      ? wallet.confidence
      : null;
  const cacheState =
    wallet.cache_state === null ||
    wallet.cache_state === "fresh" ||
    wallet.cache_state === "refreshed" ||
    wallet.cache_state === "stale" ||
    wallet.cache_state === "wait"
      ? wallet.cache_state
      : null;
  return {
    source: "metered",
    label: "Metered fallback",
    state,
    source_observed_at_ms: observed,
    snapshot_at_ms: snapshotAtMs,
    wallet: {
      balance_credits: optionalStoredNumber(wallet.balance_credits),
      baseline_credits: optionalStoredNumber(wallet.baseline_credits),
      refill_cycle_remaining_percent: optionalStoredNumber(wallet.refill_cycle_remaining_percent),
      refill_cycle_used_percent: optionalStoredNumber(wallet.refill_cycle_used_percent),
      unlimited_quota: optionalStoredBoolean(wallet.unlimited_quota),
      total_available: optionalStoredNumber(wallet.total_available),
      total_granted: optionalStoredNumber(wallet.total_granted),
      total_used: optionalStoredNumber(wallet.total_used),
      cycle_started_at_ms: optionalStoredTimestamp(wallet.cycle_started_at_ms),
      last_credit_at_ms: optionalStoredTimestamp(wallet.last_credit_at_ms),
      confidence,
      cache_state: cacheState,
      reset_at_ms: null,
    },
  };
};

const readStoredSnapshot = (value: unknown): ProviderCapacitySnapshot | null => {
  if (!isRecord(value) || !isSafeTimestamp(value.snapshot_at_ms) || !Array.isArray(value.sources)) return null;
  const snapshotAtMs = value.snapshot_at_ms;
  const codexOne = value.sources.find((source) => isRecord(source) && source.source === "codex" && source.slot === 1);
  const codexTwo = value.sources.find((source) => isRecord(source) && source.source === "codex" && source.slot === 2);
  const metered = value.sources.find((source) => isRecord(source) && source.source === "metered");
  const sources = [
    readStoredCodexSource(codexOne, snapshotAtMs),
    readStoredCodexSource(codexTwo, snapshotAtMs),
    readStoredMeteredSource(metered, snapshotAtMs),
  ];
  if (!sources[0] || !sources[1] || !sources[2]) return null;
  return {
    snapshot_at_ms: snapshotAtMs,
    // Old records used a shorter value. All records now follow the sampler
    // freshness boundary so a missed 15-minute run is tolerated once.
    stale_after_ms: PROVIDER_CAPACITY_SOURCE_STALE_MS,
    sources: [sources[0], sources[1], sources[2]],
  };
};

const readCapacitySnapshot = async (kv: Kv): Promise<ProviderCapacitySnapshot | null> => {
  try {
    return readStoredSnapshot((await kv.get(PROVIDER_CAPACITY_SNAPSHOT_KEY)).value);
  } catch {
    return null;
  }
};

const readStoredHistoryPoint = (value: unknown): ProviderCapacityHistoryPoint | null => {
  if (!isRecord(value) || !isSafeTimestamp(value.bucket_start_at_ms) || !isSafeTimestamp(value.sampled_at_ms)) {
    return null;
  }
  if (!Array.isArray(value.sources)) return null;
  const sourceOne = value.sources.find((source) => isRecord(source) && source.source === "codex" && source.slot === 1);
  const sourceTwo = value.sources.find((source) => isRecord(source) && source.source === "codex" && source.slot === 2);
  const sourceMetered = value.sources.find((source) => isRecord(source) && source.source === "metered");
  const codexSourceOne = readStoredCodexSource(sourceOne, value.sampled_at_ms);
  const codexSourceTwo = readStoredCodexSource(sourceTwo, value.sampled_at_ms);
  if (!codexSourceOne || !codexSourceTwo) return null;
  const meteredSource = readStoredMeteredSource(sourceMetered, value.sampled_at_ms) ?? unavailableMeteredSource(value.sampled_at_ms);
  return {
    bucket_start_at_ms: value.bucket_start_at_ms,
    sampled_at_ms: value.sampled_at_ms,
    sources: [codexSourceOne, codexSourceTwo, meteredSource],
  };
};

export {
  additionalRateLimitsForRouting,
  codexUsageUrl,
  isSafeTimestamp,
  parseCodexOverageUsage,
  parseCodexUsage,
  providerCapacityLastAvailableKey,
  readCapacitySnapshot,
  readStoredCodexSource,
  readStoredHistoryPoint,
  readStoredSnapshot,
  safeNow,
  unavailableCodexSource,
  unavailableMeteredSource,
};
