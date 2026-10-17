import type { Kv } from "#kv";
/**
 * Shared provider-capacity storage keys. Keeping the key outside the sampler
 * avoids a routing-to-sampler import cycle while allowing routing to reconcile
 * snapshots written by an earlier sampler run.
 */
export const PROVIDER_CAPACITY_SNAPSHOT_KEY = ["uos_ai", "provider_capacity", "v1", "snapshot"] as const;

/**
 * Width of one capacity-history bucket: also the debounce for event-driven
 * sampling, so the first observation in a bucket samples and later ones do not.
 */
export const PROVIDER_CAPACITY_HISTORY_BUCKET_MS = 15 * 60_000;

import { type MeteredQuotaSnapshot } from "../metered-quota.ts";
import { type ProviderCapacityDowntimeEvent, type ProviderCapacityRateLimitResetEvent, type ProviderCapacityResetEvent } from "./capacity-events.ts";

export const PROVIDER_CAPACITY_LEASE_KEY = ["uos_ai", "provider_capacity", "v1", "lease"] as const;
export const PROVIDER_CAPACITY_HISTORY_KEY_PREFIX = ["uos_ai", "provider_capacity", "v1", "history"] as const;
export const PROVIDER_CAPACITY_LAST_AVAILABLE_KEY_PREFIX = ["uos_ai", "provider_capacity", "v1", "last_available"] as const;
export const PROVIDER_CAPACITY_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;
// Keep this name for callers that used the old snapshot retention constant.
export const PROVIDER_CAPACITY_LEASE_MS = 10_000;
export const PROVIDER_CAPACITY_COLD_WAIT_MS = 2_000;
export const PROVIDER_CAPACITY_SOURCE_STALE_MS = 30 * 60_000;
export const PROVIDER_CAPACITY_CODEX_TIMEOUT_MS = 8_000;
export const PROVIDER_CAPACITY_RATE_LIMIT_RESET_MIN_GAIN_PERCENTAGE_POINTS = 25;

export const ADDITIONAL_WINDOW_UNANCHORED_TOLERANCE_MS = 60_000;
export const SHA256_HEX = /^[a-f0-9]{64}$/;

export type CapacityState = "available" | "stale" | "unavailable";
export type ProviderCapacityViewState = "live" | "persisted" | "stale" | "unavailable";
export type ProviderCapacityFailureKind = "not_configured" | "http_error" | "upstream_error" | "unreachable" | "invalid_response";

export type ProviderCapacityWindow = Readonly<{
  limit_window_seconds: number | null;
  used_percent: number | null;
  reset_at_ms: number | null;
}>;

export type ProviderCapacityAdditionalRateLimit = Readonly<{
  limit_name: string;
  metered_feature: string | null;
  windows: Readonly<{
    primary: ProviderCapacityWindow | null;
    secondary: ProviderCapacityWindow | null;
  }>;
}>;

export type ProviderCapacitySource =
  | Readonly<{
      source: "codex";
      label: string;
      slot: 1 | 2;
      account_cohort_id: string | null;
      state: CapacityState;
      source_observed_at_ms: number | null;
      snapshot_at_ms: number;
      failure_kind: ProviderCapacityFailureKind | null;
      failure_status: number | null;
      windows: Readonly<{
        primary: ProviderCapacityWindow | null;
        secondary: ProviderCapacityWindow | null;
      }>;
      additional_rate_limits: readonly ProviderCapacityAdditionalRateLimit[];
    }>
  | Readonly<{
      source: "metered";
      label: "Metered fallback";
      state: CapacityState;
      source_observed_at_ms: number | null;
      snapshot_at_ms: number;
      wallet: Readonly<{
        balance_credits: number | null;
        baseline_credits: number | null;
        refill_cycle_remaining_percent: number | null;
        refill_cycle_used_percent: number | null;
        unlimited_quota: boolean | null;
        total_available: number | null;
        total_granted: number | null;
        total_used: number | null;
        cycle_started_at_ms: number | null;
        last_credit_at_ms: number | null;
        confidence: MeteredQuotaSnapshot["state"]["confidence"] | null;
        cache_state: MeteredQuotaSnapshot["cache_state"] | null;
        reset_at_ms: null;
      }>;
    }>;

/**
 * The Claude subscription analytics row. It is computed live for the admin
 * read from the tier's own credential, workspace, guard, and quota state, so
 * it never depends on the stored Codex/metered snapshot record.
 */
export type ProviderCapacityClaudeWindow = Readonly<{
  status: string | null;
  /** Percentage of the window consumed, normalized from the upstream fraction. */
  used_percent: number | null;
  reset_at_ms: number | null;
  observed_at_ms: number | null;
}>;

export type ProviderCapacityClaudeStandardLimit = Readonly<{
  family: string;
  limit: number | null;
  remaining: number | null;
  reset_at_ms: number | null;
}>;

export type ProviderCapacityClaudeError = Readonly<{
  kind: string;
  status: number | null;
  message: string | null;
  at_ms: number;
}>;

export type ProviderCapacityClaudeSource = Readonly<{
  source: "claude_code";
  label: "Claude subscription";
  account_id?: string | null;
  account_cohort_id?: string | null;
  state: CapacityState;
  source_observed_at_ms: number | null;
  snapshot_at_ms: number;
  failure_kind: ProviderCapacityFailureKind | null;
  failure_status: number | null;
  /** Resolved credential direction, never the secret itself. */
  credential_kind: "api_key" | "oauth" | null;
  /** The workspace the tier would name, from KV, environment, or discovery. */
  workspace_id: string | null;
  windows: Readonly<{
    five_hour: ProviderCapacityClaudeWindow | null;
    seven_day: ProviderCapacityClaudeWindow | null;
  }>;
  standard: readonly ProviderCapacityClaudeStandardLimit[];
  blocked_until_ms: number | null;
  cooldown_until_ms: number | null;
  last_error: ProviderCapacityClaudeError | null;
}>;

export type ProviderCapacityCodexSource = Extract<ProviderCapacitySource, { source: "codex" }>;
export type ProviderCapacityMeteredSource = Extract<ProviderCapacitySource, { source: "metered" }>;

export type ProviderCapacitySnapshot = Readonly<{
  snapshot_at_ms: number;
  stale_after_ms: number;
  sources: readonly [ProviderCapacitySource, ProviderCapacitySource, ProviderCapacitySource];
}>;

export type ProviderCapacityHistoryPoint = Readonly<{
  bucket_start_at_ms: number;
  sampled_at_ms: number;
  sources: readonly [ProviderCapacityCodexSource, ProviderCapacityCodexSource, ProviderCapacityMeteredSource];
}>;

export type ProviderCapacityView = Readonly<
  ProviderCapacitySnapshot & {
    /**
     * Claude subscription analytics row. Present on admin reads; absent from
     * internal callers that only need the Codex/metered snapshot.
     */
    claude?: ProviderCapacityClaudeSource | null;
    /** Validated configured roster; `claude` remains the exact active projection. */
    claude_accounts?: readonly ProviderCapacityClaudeSource[];
    claude_history?: ClaudeCapacityHistoryView;
    cache_state: ProviderCapacityViewState;
    history: readonly ProviderCapacityHistoryPoint[];
    reset_events: readonly ProviderCapacityResetEvent[];
    rate_limit_reset_events: readonly ProviderCapacityRateLimitResetEvent[];
    downtime_events: readonly ProviderCapacityDowntimeEvent[];
  }
>;

/** Additive Claude evidence; never widen the persisted Codex/metered tuple. */
export type ClaudeCapacityHistoryPoint = Readonly<{
  v: 1;
  point_id: string;
  bucket_start_at_ms: number;
  sampled_at_ms: number;
  source_observed_at_ms: number | null;
  account_id: string;
  account_cohort_id: string;
  credential_kind: "oauth" | "api_key";
  workspace_id: string | null;
  state: "available" | "unavailable";
  response_status: number | null;
  windows: Readonly<{ five_hour: ProviderCapacityClaudeWindow | null; seven_day: ProviderCapacityClaudeWindow | null }>;
  standard: readonly Readonly<ProviderCapacityClaudeStandardLimit & { observed_at_ms: number | null }>[];
}>;

export type ClaudeCapacityHistoryView = Readonly<{
  v: 1;
  scan: "ok" | "unavailable";
  truncated: boolean;
  bucket_ms: number;
  retention_ms: number;
  stale_after_ms: number;
  points: readonly ClaudeCapacityHistoryPoint[];
}>;

export type ProviderCapacityFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ProviderCapacitySnapshotOptions = Readonly<{
  kv?: Kv | null;
  fetcher?: ProviderCapacityFetch;
  now?: () => number;
  signal?: AbortSignal;
  createLeaseOwner?: () => string;
}>;

export type CapacityLease = Readonly<{
  owner: string;
  lease_until_ms: number;
}>;

export type StoredRateLimitObservation = Readonly<{
  sampled_at_ms: number;
  source: ProviderCapacityCodexSource;
}>;
