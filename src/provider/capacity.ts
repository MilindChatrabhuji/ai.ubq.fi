import type { Kv, KvEntryMaybe } from "#kv";
import { type CodexCapacityAccount, getCodexCapacityAccounts } from "../codex/index.ts";
import { json } from "../http.ts";
import { getKv } from "../kv.ts";
import { loadClaudeCodeAccountStore, resolveClaudeCodeAccount, type ClaudeCodeAccountBinding } from "./claude-code-accounts.ts";
import type { ClaudeCodeEnvLookup } from "./claude-code.ts";
import { loadClaudeCodeQuotaState, registerClaudeCodeObservationRecorder, type ClaudeCodeQuotaState } from "./claude-code-quota.ts";
import { claudeCapacityUsedPercent, readClaudeCapacityHistory, recordClaudeCapacityObservation } from "./claude-capacity-history.ts";
import { listClaudeCapacityRollups } from "./claude-capacity-rollups.ts";
import { getClaudeCodeProviderHealth } from "./health.ts";
import { type CodexCapacityRoutingObservationInput, recordCodexCapacityRoutingObservations } from "../codex/account-routing.ts";
import {
  listProviderCapacityDowntimeEvents,
  listProviderCapacityRateLimitResetEvents,
  listProviderCapacityResetEvents,
  PROVIDER_CAPACITY_RESET_EVENT_RETENTION_MS,
  type ProviderCapacityDowntimeEvent,
  type ProviderCapacityRateLimitResetEvent,
  providerCapacityRateLimitResetEventKey,
  type ProviderCapacityResetEvent,
} from "./capacity-events.ts";
import {
  isProviderCapacityRollupPoint,
  listProviderCapacityRollups,
  mergeProviderCapacityRollup,
  PROVIDER_CAPACITY_ROLLUP_BUCKET_MS,
  providerCapacityRollupBucketStartAtMs,
  providerCapacityRollupKey,
  type ProviderCapacityRollupInput,
  type ProviderCapacityRollupSlotInput,
} from "./capacity-rollups.ts";
import { readPromptCacheAnalytics } from "../cache/prompt-analytics.ts";
import { mergeCapacityHistory, readRemoteCapacityObservations } from "./capacity-analytics.ts";
import { getConfiguredMeteredQuotaSnapshot, METERED_QUOTA_FRESH_MS, type MeteredQuotaSnapshot } from "../metered-quota.ts";
import { PAID_FALLBACK_REQUEST_LOG_RETENTION_MS } from "../paid-fallback/ledger-state.ts";
import { readPaidFallbackLedgerGrowth } from "../paid-fallback/ledger-stats.ts";
import { sha256Hex } from "../utils.ts";
import {
  PROVIDER_CAPACITY_CODEX_TIMEOUT_MS,
  PROVIDER_CAPACITY_COLD_WAIT_MS,
  PROVIDER_CAPACITY_HISTORY_RETENTION_MS,
  PROVIDER_CAPACITY_LEASE_KEY,
  PROVIDER_CAPACITY_LEASE_MS,
  PROVIDER_CAPACITY_SNAPSHOT_KEY,
  PROVIDER_CAPACITY_SOURCE_STALE_MS,
} from "./capacity-contract.ts";
import type {
  CapacityLease,
  ProviderCapacityFailureKind,
  ProviderCapacityClaudeSource,
  ProviderCapacityClaudeStandardLimit,
  ProviderCapacityClaudeWindow,
  ProviderCapacityCodexSource,
  ProviderCapacityFetch,
  ProviderCapacityHistoryPoint,
  ProviderCapacitySnapshot,
  ProviderCapacitySnapshotOptions,
  ProviderCapacitySource,
  ProviderCapacityView,
  ProviderCapacityViewState,
} from "./capacity-contract.ts";
import {
  additionalRateLimitsForRouting,
  codexAccountLabel,
  codexUsageUrl,
  parseCodexUsage,
  providerCapacityLastAvailableKey,
  readCapacitySnapshot,
  readStoredHistoryPoint,
  readStoredSnapshot,
  safeNow,
  unavailableCodexSource,
  unavailableMeteredSource,
} from "./capacity-parse.ts";
import {
  codexAvailabilityTransitionObserved,
  codexResetTransitionObserved,
  historyPointForSnapshot,
  lastAvailableCapacityEntries,
  mergeHistoricalRateLimitResetEvents,
  mergeHistoryPoints,
  observedRateLimitResetEvents,
  providerCapacityHistoryKey,
  providerCapacityHistoryTransitionKey,
  readCapacityHistory,
  readStoredRateLimitObservation,
  recoverRateLimitObservations,
  recoverySlotsForSnapshot,
} from "./capacity-history.ts";

// Handler startup imports this module before inference; no admin visit is needed.
registerClaudeCodeObservationRecorder(recordClaudeCapacityObservation);

export const PROVIDER_CAPACITY_SNAPSHOT_RETENTION_MS = PROVIDER_CAPACITY_HISTORY_RETENTION_MS;

/**
 * How long a persisted capacity snapshot satisfies a normal admin read before
 * the read revalidates it. This matches the Analytics client's visible poll, and
 * is deliberately shorter than the fifteen-minute history bucket: refreshing a
 * value overwrites that bucket's point instead of adding one.
 */
export const PROVIDER_CAPACITY_READ_FRESH_MS = 30_000;

// The admin chart keeps its seven-day raw history; long-run research reads
// the separate hourly rollup store through a bounded query window instead.
export const PROVIDER_CAPACITY_RESEARCH_DEFAULT_WINDOW_DAYS = 90;
export const PROVIDER_CAPACITY_RESEARCH_MAX_WINDOW_DAYS = 365;

export {
  PROVIDER_CAPACITY_CODEX_TIMEOUT_MS,
  PROVIDER_CAPACITY_COLD_WAIT_MS,
  PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
  PROVIDER_CAPACITY_HISTORY_KEY_PREFIX,
  PROVIDER_CAPACITY_HISTORY_RETENTION_MS,
  PROVIDER_CAPACITY_LEASE_KEY,
  PROVIDER_CAPACITY_LEASE_MS,
  PROVIDER_CAPACITY_RATE_LIMIT_RESET_MIN_GAIN_PERCENTAGE_POINTS,
  PROVIDER_CAPACITY_SNAPSHOT_KEY,
  PROVIDER_CAPACITY_SOURCE_STALE_MS,
} from "./capacity-contract.ts";
export { PROVIDER_CAPACITY_ROLLUP_BUCKET_MS } from "./capacity-rollups.ts";
export type {
  ProviderCapacityAdditionalRateLimit,
  ProviderCapacityCodexSource,
  ProviderCapacityFailureKind,
  ProviderCapacityFetch,
  ProviderCapacityHistoryPoint,
  ProviderCapacityMeteredSource,
  ProviderCapacitySnapshot,
  ProviderCapacitySnapshotOptions,
  ProviderCapacitySource,
  ProviderCapacityView,
  ProviderCapacityViewState,
  ProviderCapacityWindow,
} from "./capacity-contract.ts";
export { codexAccountLabel } from "./capacity-parse.ts";
export { providerCapacityHistoryKey } from "./capacity-history.ts";

const cancelResponseBody = (response: Response): void => {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void Promise.resolve(cancellation).catch(() => {});
  } catch {
    // The capacity response is already classified as unavailable.
  }
};

const fetchCodexCapacitySource = async (
  account: CodexCapacityAccount,
  accountCohortId: string,
  snapshotAtMs: number,
  fetcher: ProviderCapacityFetch,
  signal: AbortSignal
): Promise<ProviderCapacityCodexSource> => {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: "Bearer " + account.access_token,
    "ChatGPT-Account-ID": account.account_id,
    "User-Agent": "codex_cli_rs/0.100.0 (ai.ubq.fi)",
  });
  try {
    const response = await fetcher(codexUsageUrl(), {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      cancelResponseBody(response);
      return unavailableCodexSource(
        account.slot as 1 | 2,
        snapshotAtMs,
        response.status >= 500 ? "upstream_error" : "http_error",
        response.status,
        true,
        codexAccountLabel(account.slot, account.email),
        accountCohortId
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return unavailableCodexSource(
        account.slot as 1 | 2,
        snapshotAtMs,
        "invalid_response",
        response.status,
        true,
        codexAccountLabel(account.slot, account.email),
        accountCohortId
      );
    }
    const windows = parseCodexUsage(payload);
    if (!windows) {
      return unavailableCodexSource(
        account.slot as 1 | 2,
        snapshotAtMs,
        "invalid_response",
        response.status,
        true,
        codexAccountLabel(account.slot, account.email),
        accountCohortId
      );
    }
    return {
      source: "codex",
      label: codexAccountLabel(account.slot, account.email),
      slot: account.slot as 1 | 2,
      account_cohort_id: accountCohortId,
      state: "available",
      source_observed_at_ms: snapshotAtMs,
      snapshot_at_ms: snapshotAtMs,
      failure_kind: null,
      failure_status: null,
      windows: {
        primary: windows.primary,
        secondary: windows.secondary,
      },
      additional_rate_limits: windows.additional_rate_limits,
    };
  } catch {
    return unavailableCodexSource(
      account.slot as 1 | 2,
      snapshotAtMs,
      "unreachable",
      null,
      true,
      codexAccountLabel(account.slot, account.email),
      accountCohortId
    );
  }
};

const meteredCapacitySource = (snapshot: MeteredQuotaSnapshot | null, snapshotAtMs: number): ProviderCapacitySource => {
  if (!snapshot) return unavailableMeteredSource(snapshotAtMs);
  const sourceObservedAtMs = snapshot.state.observed_at_ms;
  const stale = snapshot.cache_state === "stale" || snapshotAtMs - sourceObservedAtMs >= METERED_QUOTA_FRESH_MS;
  const tokenUsage = snapshot.unlimited_quota || snapshot.total_available !== null || snapshot.total_used !== null;
  return {
    source: "metered",
    label: "Metered fallback",
    state: stale ? "stale" : "available",
    source_observed_at_ms: sourceObservedAtMs,
    snapshot_at_ms: snapshotAtMs,
    wallet: {
      balance_credits: snapshot.balance_credits,
      baseline_credits: snapshot.baseline_credits,
      refill_cycle_remaining_percent: snapshot.remaining_percent,
      refill_cycle_used_percent: snapshot.used_percent,
      unlimited_quota: snapshot.unlimited_quota,
      total_available: snapshot.total_available,
      total_granted: snapshot.total_granted,
      total_used: snapshot.total_used,
      cycle_started_at_ms: tokenUsage ? null : snapshot.state.cycle_started_at_ms,
      last_credit_at_ms: tokenUsage ? null : snapshot.state.last_credit_at_ms,
      confidence: tokenUsage ? null : snapshot.state.confidence,
      cache_state: snapshot.cache_state,
      // Metered exposes a refill cycle, not a scheduled reset window.
      reset_at_ms: null,
    },
  };
};

/** Unified headers report a fraction; normalize and clamp without guessing percent units. */
const claudeCapacityWindow = (
  window: Readonly<{ status: string | null; utilization: number | null; reset_at_ms: number | null; observed_at_ms: number }> | undefined
): ProviderCapacityClaudeWindow | null =>
  window
    ? {
        status: window.status,
        used_percent: claudeCapacityUsedPercent(window.utilization),
        reset_at_ms: window.reset_at_ms,
        observed_at_ms: window.observed_at_ms,
      }
    : null;

const claudeStandardLimits = (quota: ClaudeCodeQuotaState | null): ProviderCapacityClaudeStandardLimit[] => {
  if (!quota) return [];
  return Object.entries(quota.standard).map(([family, window]) => ({
    family,
    limit: window.limit,
    remaining: window.remaining,
    reset_at_ms: window.reset_at_ms,
  }));
};

const claudeLatestObservationMs = (quota: ClaudeCodeQuotaState | null): number | null => {
  const candidates: number[] = [];
  const push = (value: number | null | undefined): void => {
    if (typeof value === "number" && Number.isFinite(value)) candidates.push(value);
  };
  for (const window of Object.values(quota?.windows ?? {})) push(window.observed_at_ms);
  for (const window of Object.values(quota?.standard ?? {})) push(window.observed_at_ms);
  return candidates.length ? Math.max(...candidates) : null;
};

/** The Claude subscription row for a caller that has no tier state to read. */
export const unavailableClaudeCapacitySource = (snapshotAtMs: number): ProviderCapacityClaudeSource => ({
  source: "claude_code",
  label: "Claude subscription",
  state: "unavailable",
  source_observed_at_ms: null,
  snapshot_at_ms: snapshotAtMs,
  failure_kind: "not_configured",
  failure_status: null,
  credential_kind: null,
  workspace_id: null,
  windows: { five_hour: null, seven_day: null },
  standard: [],
  blocked_until_ms: null,
  cooldown_until_ms: null,
  last_error: null,
});

/**
 * The live Claude subscription analytics row: the resolved credential
 * direction and workspace, the last observed unified or standard quota
 * windows, the recorded configuration guard, and the last upstream outcome. A
 * missing credential is `not_configured`; an active quota block, cooldown, or
 * recorded configuration error is `unavailable` with its status, because the
 * tier genuinely cannot serve until that guard clears. A never-observed but
 * eligible tier stays `available` (there is nothing to be stale yet).
 */
const capacitySourceForClaudeAccount = async (
  kv: Kv | null,
  snapshotAtMs: number,
  binding: ClaudeCodeAccountBinding | null
): Promise<ProviderCapacityClaudeSource> => {
  const credential = binding?.credential ?? null;
  const workspace = binding?.workspace ?? null;
  const [quota, health] = binding
    ? await Promise.all([loadClaudeCodeQuotaState(kv, binding).catch(() => null), getClaudeCodeProviderHealth(() => snapshotAtMs, binding).catch(() => null)])
    : [null, null];
  const blockedUntilMs = quota?.blocked_until_ms ?? null;
  const cooldownUntilMs = quota?.cooldown_until_ms ?? null;
  const blocked = blockedUntilMs !== null && blockedUntilMs > snapshotAtMs;
  const cooling = cooldownUntilMs !== null && cooldownUntilMs > snapshotAtMs;
  const lastError = quota?.last_error ?? null;
  // A healthy response without quota headers cannot refresh old quota evidence.
  const observedAtMs = claudeLatestObservationMs(quota);
  const failing = blocked || cooling || lastError !== null;
  let state: ProviderCapacityClaudeSource["state"] = "available";
  if (!credential || failing) state = "unavailable";
  else if (observedAtMs !== null && snapshotAtMs - observedAtMs > PROVIDER_CAPACITY_SOURCE_STALE_MS) state = "stale";
  let failureKind: ProviderCapacityFailureKind | null = null;
  if (!credential) failureKind = "not_configured";
  else if (failing) failureKind = "upstream_error";
  let failureStatus = lastError?.status ?? null;
  if (failureStatus === null && blocked) failureStatus = 429;
  if (failureStatus === null && cooling) failureStatus = health?.last_status ?? null;
  return {
    source: "claude_code",
    label: "Claude subscription",
    account_id: binding?.account_id ?? null,
    account_cohort_id: binding?.account_cohort_id ?? null,
    state,
    source_observed_at_ms: observedAtMs,
    snapshot_at_ms: snapshotAtMs,
    failure_kind: failureKind,
    failure_status: failureStatus,
    credential_kind: credential?.kind ?? null,
    workspace_id: workspace?.id ?? null,
    windows: {
      five_hour: claudeCapacityWindow(quota?.windows["5h"]),
      seven_day: claudeCapacityWindow(quota?.windows["7d"]),
    },
    standard: claudeStandardLimits(quota),
    blocked_until_ms: blockedUntilMs,
    cooldown_until_ms: cooldownUntilMs,
    last_error: lastError
      ? {
          kind: lastError.kind,
          status: lastError.status,
          message: lastError.message,
          at_ms: lastError.at_ms,
        }
      : null,
  };
};

export const claudeCapacitySource = async (kv: Kv | null, snapshotAtMs: number, env?: ClaudeCodeEnvLookup): Promise<ProviderCapacityClaudeSource> =>
  await capacitySourceForClaudeAccount(kv, snapshotAtMs, await resolveClaudeCodeAccount(kv, env).catch(() => null));

const claudeCapacityRoster = async (kv: Kv | null, snapshotAtMs: number) => {
  if (!kv) return { claude: unavailableClaudeCapacitySource(snapshotAtMs), claude_accounts: [] };
  // The foundation validates the bounded roster before any per-account read.
  // Resolve once so old clients see exactly the active row from this same roster.
  const store = await loadClaudeCodeAccountStore(kv);
  const accounts = await Promise.all(store.accounts.map((binding) => capacitySourceForClaudeAccount(kv, snapshotAtMs, binding)));
  return {
    claude: accounts.find((source) => source.account_id === store.active_account_id) ?? unavailableClaudeCapacitySource(snapshotAtMs),
    claude_accounts: accounts,
  };
};

const captureProviderCapacitySnapshot = async (
  options: ProviderCapacitySnapshotOptions,
  snapshotAtMs: number,
  kv: Kv | null,
  forceMeteredRefresh = true
): Promise<ProviderCapacitySnapshot> => {
  let accounts: readonly CodexCapacityAccount[] = [];
  try {
    accounts = await getCodexCapacityAccounts();
  } catch {
    // Missing or malformed auth is represented by redacted unavailable slots.
  }

  const fetcher = options.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const timeout = AbortSignal.timeout(PROVIDER_CAPACITY_CODEX_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const codexPromise = Promise.all(
    ([1, 2] as const).map(async (slot) => {
      const account = accounts.find((candidate) => candidate.slot === slot);
      if (!account) return unavailableCodexSource(slot, snapshotAtMs);
      try {
        return await fetchCodexCapacitySource(
          account,
          await sha256Hex(`uos-prompt-cache-account-cohort-v1\u0000${account.account_id}`),
          snapshotAtMs,
          fetcher,
          signal
        );
      } catch {
        return unavailableCodexSource(slot, snapshotAtMs, "unreachable", null, true, codexAccountLabel(account.slot, account.email));
      }
    })
  );
  const meteredPromise = getConfiguredMeteredQuotaSnapshot({
    kv,
    fetcher,
    now: () => snapshotAtMs,
    signal,
    forceRefresh: forceMeteredRefresh,
    createLeaseOwner: options.createLeaseOwner,
  }).catch(() => null);
  const [codexSources, meteredSnapshot] = await Promise.all([codexPromise, meteredPromise]);

  const routingObservations: CodexCapacityRoutingObservationInput[] = [];
  for (const account of accounts) {
    const source = codexSources.find((candidate) => candidate.slot === account.slot);
    if (!source) continue;
    routingObservations.push({
      slot: account.slot - 1,
      account_id: account.account_id,
      state: source.state,
      source_observed_at_ms: source.source_observed_at_ms,
      snapshot_at_ms: source.snapshot_at_ms,
      windows: source.windows,
      additional_rate_limits: additionalRateLimitsForRouting(source.additional_rate_limits, snapshotAtMs),
    });
  }
  await recordCodexCapacityRoutingObservations(routingObservations, snapshotAtMs);

  return {
    snapshot_at_ms: snapshotAtMs,
    stale_after_ms: PROVIDER_CAPACITY_SOURCE_STALE_MS,
    sources: [codexSources[0], codexSources[1], meteredCapacitySource(meteredSnapshot, snapshotAtMs)],
  };
};

const staleProviderCapacitySource = (source: ProviderCapacitySource, snapshot: ProviderCapacitySnapshot, nowMs: number): ProviderCapacitySource => {
  if (source.state !== "available") return source;
  if (source.source === "codex") {
    return nowMs >= source.snapshot_at_ms + snapshot.stale_after_ms ? { ...source, state: "stale" as const } : source;
  }
  const meteredStale =
    source.wallet.cache_state === "stale" || source.source_observed_at_ms === null || nowMs - source.source_observed_at_ms >= METERED_QUOTA_FRESH_MS;
  return meteredStale ? { ...source, state: "stale" as const } : source;
};

const staleProviderSnapshot = (snapshot: ProviderCapacitySnapshot, nowMs: number): ProviderCapacitySnapshot => {
  return {
    ...snapshot,
    sources: snapshot.sources.map((source) => staleProviderCapacitySource(source, snapshot, nowMs)) as [
      ProviderCapacitySource,
      ProviderCapacitySource,
      ProviderCapacitySource,
    ],
  };
};

const toCapacityView = (
  snapshot: ProviderCapacitySnapshot,
  requestedState: Exclude<ProviderCapacityViewState, "unavailable">,
  history: readonly ProviderCapacityHistoryPoint[],
  resetEvents: readonly ProviderCapacityResetEvent[],
  rateLimitResetEvents: readonly ProviderCapacityRateLimitResetEvent[],
  downtimeEvents: readonly ProviderCapacityDowntimeEvent[],
  nowMs: number
): ProviderCapacityView => {
  const current = staleProviderSnapshot(snapshot, nowMs);
  const stale = current.sources.some((source) => source.state === "stale");
  return {
    ...current,
    cache_state: stale ? "stale" : requestedState,
    history,
    reset_events: resetEvents,
    rate_limit_reset_events: rateLimitResetEvents,
    downtime_events: downtimeEvents,
  };
};

const unavailableSnapshot = (snapshotAtMs: number): ProviderCapacitySnapshot => ({
  snapshot_at_ms: snapshotAtMs,
  stale_after_ms: PROVIDER_CAPACITY_SOURCE_STALE_MS,
  sources: [unavailableCodexSource(1, snapshotAtMs), unavailableCodexSource(2, snapshotAtMs), unavailableMeteredSource(snapshotAtMs)],
});

const unavailableView = (
  snapshotAtMs: number,
  history: readonly ProviderCapacityHistoryPoint[],
  resetEvents: readonly ProviderCapacityResetEvent[],
  rateLimitResetEvents: readonly ProviderCapacityRateLimitResetEvent[],
  downtimeEvents: readonly ProviderCapacityDowntimeEvent[]
): ProviderCapacityView => ({
  ...unavailableSnapshot(snapshotAtMs),
  cache_state: "unavailable",
  history,
  reset_events: resetEvents,
  rate_limit_reset_events: rateLimitResetEvents,
  downtime_events: downtimeEvents,
});

const acquireCapacityLease = async (kv: Kv, owner: string, nowMs: number): Promise<{ acquired: boolean; entry: KvEntryMaybe<CapacityLease> }> => {
  const entry = await kv.get<CapacityLease>(PROVIDER_CAPACITY_LEASE_KEY);
  if (entry.value && entry.value.lease_until_ms > nowMs) return { acquired: false, entry };
  const lease: CapacityLease = { owner, lease_until_ms: nowMs + PROVIDER_CAPACITY_LEASE_MS };
  const committed = await kv
    .atomic()
    .check(entry)
    .set(PROVIDER_CAPACITY_LEASE_KEY, lease, { expireIn: PROVIDER_CAPACITY_LEASE_MS * 2 })
    .commit();
  if (!committed.ok) return { acquired: false, entry };
  const acquiredEntry = await kv.get<CapacityLease>(PROVIDER_CAPACITY_LEASE_KEY);
  return acquiredEntry.value?.owner === owner
    ? { acquired: true, entry: acquiredEntry }
    : {
        acquired: false,
        entry: acquiredEntry,
      };
};

const releaseCapacityLease = async (kv: Kv, owner: string): Promise<void> => {
  try {
    const entry = await kv.get<CapacityLease>(PROVIDER_CAPACITY_LEASE_KEY);
    if (entry.value?.owner !== owner) return;
    await kv.atomic().check(entry).delete(PROVIDER_CAPACITY_LEASE_KEY).commit();
  } catch {
    // A short-lived lease can expire without affecting the redacted snapshot.
  }
};

const capacityRollupInputForHistoryPoint = (history: ProviderCapacityHistoryPoint): ProviderCapacityRollupInput => {
  const slotInput = (slot: 1 | 2): ProviderCapacityRollupSlotInput => {
    const source = history.sources.find((candidate): candidate is ProviderCapacityCodexSource => candidate.source === "codex" && candidate.slot === slot);
    return {
      slot,
      state: source?.state ?? "unavailable",
      primary: source?.windows.primary ?? null,
      secondary: source?.windows.secondary ?? null,
    };
  };
  return {
    bucket_start_at_ms: providerCapacityRollupBucketStartAtMs(history.bucket_start_at_ms),
    sampled_at_ms: history.sampled_at_ms,
    slots: [slotInput(1), slotInput(2)],
  };
};

const persistCapacitySnapshot = async (kv: Kv, leaseEntry: KvEntryMaybe<CapacityLease>, snapshot: ProviderCapacitySnapshot): Promise<boolean> => {
  const history = historyPointForSnapshot(snapshot);
  const rollupInput = capacityRollupInputForHistoryPoint(history);
  const rollupKey = providerCapacityRollupKey(rollupInput.bucket_start_at_ms);
  const comparisonReads = await Promise.allSettled([
    kv.get(PROVIDER_CAPACITY_SNAPSHOT_KEY, { consistency: "strong" }),
    kv.get(providerCapacityHistoryKey(history.bucket_start_at_ms), { consistency: "strong" }),
    ...([1, 2] as const).map((slot) => kv.get(providerCapacityLastAvailableKey(slot), { consistency: "strong" })),
    kv.get(rollupKey, { consistency: "strong" }),
  ]);
  const storedEntries: KvEntryMaybe<unknown>[] = [];
  for (const result of comparisonReads.slice(0, 4)) {
    if (result.status === "rejected") return false;
    storedEntries.push(result.value);
  }
  // The rollup is long-run research telemetry: a failed rollup read must not
  // block the operational snapshot and history write.
  const rollupRead = comparisonReads[4];
  // comparisonReads is the five-element array literal above, so index 4 exists.
  const rollupEntry = rollupRead.status === "fulfilled" ? rollupRead.value : undefined;
  const previousSnapshot = readStoredSnapshot(storedEntries[0]?.value);
  const previousHistory = readStoredHistoryPoint(storedEntries[1]?.value);
  const lastAvailableObservations = storedEntries.slice(2, 4).flatMap((entry) => {
    const observation = readStoredRateLimitObservation(entry.value);
    return observation ? [observation] : [];
  });
  const recoverySlots = recoverySlotsForSnapshot(snapshot, previousSnapshot, lastAvailableObservations);
  const recoveredObservations = await recoverRateLimitObservations(kv, snapshot, recoverySlots);
  const rateLimitResetEvents = observedRateLimitResetEvents(previousSnapshot, snapshot, [...lastAvailableObservations, ...recoveredObservations]);
  const preserveTransition =
    rateLimitResetEvents.length > 0 || codexResetTransitionObserved(previousHistory, history) || codexAvailabilityTransitionObserved(previousHistory, history);
  let operation = kv.atomic().check(leaseEntry).set(PROVIDER_CAPACITY_SNAPSHOT_KEY, snapshot, { expireIn: PROVIDER_CAPACITY_SNAPSHOT_RETENTION_MS });
  for (const event of rateLimitResetEvents) {
    operation = operation.set(providerCapacityRateLimitResetEventKey(event.event_id), event, {
      expireIn: PROVIDER_CAPACITY_RESET_EVENT_RETENTION_MS,
    });
  }
  for (const entry of lastAvailableCapacityEntries(snapshot)) {
    operation = operation.set(providerCapacityLastAvailableKey(entry.slot), entry.value, { expireIn: PROVIDER_CAPACITY_RESET_EVENT_RETENTION_MS });
  }
  if (rollupEntry !== undefined) {
    const existingRollup = isProviderCapacityRollupPoint(rollupEntry.value) ? rollupEntry.value : null;
    operation = operation.check(rollupEntry).set(rollupKey, mergeProviderCapacityRollup(existingRollup, rollupInput));
  }
  if (preserveTransition && previousHistory) {
    operation = operation.set(providerCapacityHistoryTransitionKey(history.bucket_start_at_ms, previousHistory.sampled_at_ms), previousHistory, {
      expireIn: PROVIDER_CAPACITY_HISTORY_RETENTION_MS,
    });
  }
  const committed = await operation
    .set(providerCapacityHistoryKey(history.bucket_start_at_ms), history, {
      expireIn: PROVIDER_CAPACITY_HISTORY_RETENTION_MS,
    })
    .delete(PROVIDER_CAPACITY_LEASE_KEY)
    .commit();
  return committed.ok;
};

const waitForCapacitySnapshot = async (kv: Kv, previousSnapshotAtMs: number | null): Promise<ProviderCapacitySnapshot | null> => {
  const deadline = Date.now() + PROVIDER_CAPACITY_COLD_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Read the lease before the snapshot. The durable commit that writes a new
    // snapshot deletes the lease in the same atomic operation, so once a
    // released lease is observed the following snapshot read already includes
    // that commit. Reading both concurrently could pair the old snapshot with
    // the released lease and return stale data while fresh data is durable.
    const lease = await kv.get<CapacityLease>(PROVIDER_CAPACITY_LEASE_KEY).catch(() => null);
    const snapshot = await readCapacitySnapshot(kv);
    if (snapshot && (previousSnapshotAtMs === null || snapshot.snapshot_at_ms !== previousSnapshotAtMs)) return snapshot;
    if (!lease?.value) return snapshot;
  }
  return null;
};

export const getPersistedProviderCapacityView = async (options: Pick<ProviderCapacitySnapshotOptions, "kv" | "now"> = {}): Promise<ProviderCapacityView> => {
  const nowMs = safeNow(options.now ?? Date.now);
  const kv = options.kv === undefined ? await getKv() : options.kv;
  if (!kv) return unavailableView(nowMs, [], [], [], []);
  const [snapshot, history, resetEvents, rateLimitResetEvents, downtimeEvents] = await Promise.all([
    readCapacitySnapshot(kv),
    readCapacityHistory(kv, nowMs),
    listProviderCapacityResetEvents({ kv, now: () => nowMs }),
    listProviderCapacityRateLimitResetEvents({ kv, now: () => nowMs }),
    listProviderCapacityDowntimeEvents({ kv, now: () => nowMs }),
  ]);
  const mergedRateLimitResetEvents = await mergeHistoricalRateLimitResetEvents(kv, history, rateLimitResetEvents);
  return snapshot
    ? toCapacityView(snapshot, "persisted", history, resetEvents, mergedRateLimitResetEvents, downtimeEvents, nowMs)
    : unavailableView(nowMs, history, resetEvents, mergedRateLimitResetEvents, downtimeEvents);
};

const refreshProviderCapacityInternal = async (options: ProviderCapacitySnapshotOptions = {}, forceMeteredRefresh = true): Promise<ProviderCapacityView> => {
  const nowMs = safeNow(options.now ?? Date.now);
  const kv = options.kv === undefined ? await getKv() : options.kv;
  if (!kv) {
    const snapshot = await captureProviderCapacitySnapshot(options, nowMs, null, forceMeteredRefresh);
    return toCapacityView(snapshot, "live", [historyPointForSnapshot(snapshot)], [], [], [], nowMs);
  }

  const [cached, historyBefore, resetEventsBefore, rateLimitResetEventsBefore, downtimeEventsBefore] = await Promise.all([
    readCapacitySnapshot(kv),
    readCapacityHistory(kv, nowMs),
    listProviderCapacityResetEvents({ kv, now: () => nowMs }),
    listProviderCapacityRateLimitResetEvents({ kv, now: () => nowMs }),
    listProviderCapacityDowntimeEvents({ kv, now: () => nowMs }),
  ]);
  const owner = (options.createLeaseOwner ?? (() => crypto.randomUUID()))();
  const lease = await acquireCapacityLease(kv, owner, nowMs).catch(
    () =>
      ({
        acquired: false,
        entry: { key: PROVIDER_CAPACITY_LEASE_KEY, value: null, versionstamp: null },
      }) as { acquired: boolean; entry: KvEntryMaybe<CapacityLease> }
  );
  if (!lease.acquired) {
    const coalesced = await waitForCapacitySnapshot(kv, cached?.snapshot_at_ms ?? null).catch(() => null);
    const snapshot = coalesced ?? cached;
    const history = await readCapacityHistory(kv, nowMs).catch(() => historyBefore);
    const resetEvents = await listProviderCapacityResetEvents({ kv, now: () => nowMs }).catch(() => resetEventsBefore);
    const rateLimitResetEvents = await listProviderCapacityRateLimitResetEvents({ kv, now: () => nowMs }).catch(() => rateLimitResetEventsBefore);
    const downtimeEvents = await listProviderCapacityDowntimeEvents({ kv, now: () => nowMs }).catch(() => downtimeEventsBefore);
    const mergedRateLimitResetEvents = await mergeHistoricalRateLimitResetEvents(kv, history, rateLimitResetEvents);
    return snapshot
      ? toCapacityView(snapshot, "persisted", history, resetEvents, mergedRateLimitResetEvents, downtimeEvents, nowMs)
      : unavailableView(nowMs, history, resetEvents, mergedRateLimitResetEvents, downtimeEvents);
  }

  try {
    const snapshot = await captureProviderCapacitySnapshot(options, nowMs, kv, forceMeteredRefresh);
    const persisted = await persistCapacitySnapshot(kv, lease.entry, snapshot).catch(() => false);
    const history = await readCapacityHistory(kv, nowMs).catch(() => historyBefore);
    const resetEvents = await listProviderCapacityResetEvents({ kv, now: () => nowMs }).catch(() => resetEventsBefore);
    const rateLimitResetEvents = await listProviderCapacityRateLimitResetEvents({ kv, now: () => nowMs }).catch(() => rateLimitResetEventsBefore);
    const downtimeEvents = await listProviderCapacityDowntimeEvents({ kv, now: () => nowMs }).catch(() => downtimeEventsBefore);
    const mergedRateLimitResetEvents = await mergeHistoricalRateLimitResetEvents(kv, history, rateLimitResetEvents);
    return toCapacityView(
      snapshot,
      "live",
      persisted ? history : mergeHistoryPoints(history, historyPointForSnapshot(snapshot)),
      resetEvents,
      mergedRateLimitResetEvents,
      downtimeEvents,
      nowMs
    );
  } finally {
    await releaseCapacityLease(kv, owner);
  }
};

export const refreshProviderCapacity = (options: ProviderCapacitySnapshotOptions = {}): Promise<ProviderCapacityView> =>
  refreshProviderCapacityInternal(options, true);

/**
 * Persist one capacity sample for an observed event, without building the admin
 * projection.
 *
 * Replaces the retired fifteen-minute deploy cron. The trigger is a capacity observation
 * - a Codex rate-limit reset, an upstream downtime - or an operator opening the
 * capacity view; `triggerProviderCapacitySample` is the fire-and-forget entry
 * point and debounces to one probe per history bucket. Nothing here runs because
 * time passed.
 *
 * The caller does not consume a ProviderCapacityView, so scanning the seven-day
 * history and reset-event ledgers before and after every sample only pays to
 * construct a discarded response. Keep the capture, routing observations, lease,
 * snapshot/history write, and same-bucket reset transition exactly on the
 * durable sampler path. Admin callers continue to use refreshProviderCapacity()
 * when they need the full projection.
 */
export const sampleProviderCapacityOnEvent = async (options: ProviderCapacitySnapshotOptions = {}): Promise<void> => {
  const nowMs = safeNow(options.now ?? Date.now);
  const kv = options.kv === undefined ? await getKv() : options.kv;
  // A scheduled sample without durable storage would only create provider
  // traffic while leaving routing and history state stale.
  if (!kv) return;

  const owner = (options.createLeaseOwner ?? (() => crypto.randomUUID()))();
  const lease = await acquireCapacityLease(kv, owner, nowMs).catch(
    () =>
      ({
        acquired: false,
        entry: { key: PROVIDER_CAPACITY_LEASE_KEY, value: null, versionstamp: null },
      }) as { acquired: boolean; entry: KvEntryMaybe<CapacityLease> }
  );
  // The event caller has no view to return. A competing live refresh owns the
  // only probe, so avoid both a duplicate probe and the old coalesced-view
  // polling loop.
  if (!lease.acquired) return;

  let persisted = false;
  try {
    const snapshot = await captureProviderCapacitySnapshot(options, nowMs, kv);
    persisted = await persistCapacitySnapshot(kv, lease.entry, snapshot).catch(() => false);
  } finally {
    // A successful atomic persist deletes the checked lease. Only failed or
    // interrupted persistence needs the conservative owner-checked release.
    if (!persisted) await releaseCapacityLease(kv, owner);
  }
};

const capacityViewIsFresh = (view: ProviderCapacityView, nowMs: number): boolean =>
  view.cache_state !== "unavailable" && nowMs - view.snapshot_at_ms < PROVIDER_CAPACITY_READ_FRESH_MS;

const providerCapacityResearchWindowDays = (raw: string | null): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 1) return PROVIDER_CAPACITY_RESEARCH_DEFAULT_WINDOW_DAYS;
  return Math.min(parsed, PROVIDER_CAPACITY_RESEARCH_MAX_WINDOW_DAYS);
};

/**
 * Long-run research read over the forever-kept hourly capacity rollups. This is
 * deliberately separate from the operational capacity view: the chart keeps its
 * bounded seven-day raw history, while `window_days` (default 90, capped at
 * 365) bounds only this rollup query.
 */
export const handleProviderCapacityRollups = async (
  request: Request = new Request("https://ai.ubq.fi/admin/providers/capacity/rollups"),
  options: Pick<ProviderCapacitySnapshotOptions, "kv" | "now"> = {}
): Promise<Response> => {
  const nowMs = safeNow(options.now ?? Date.now);
  const kv = options.kv === undefined ? await getKv() : options.kv;
  const windowDays = providerCapacityResearchWindowDays(new URL(request.url).searchParams.get("window_days"));
  const windowMs = windowDays * 24 * 60 * 60_000;
  const rollups = kv ? await listProviderCapacityRollups(kv, { sinceMs: Math.max(0, nowMs - windowMs), nowMs }).catch(() => null) : null;
  const claudeRollups = await listClaudeCapacityRollups(kv, Math.max(0, nowMs - windowMs), nowMs);
  return json(
    200,
    {
      snapshot_at_ms: nowMs,
      window_days: windowDays,
      retention: {
        rollup_bucket_ms: PROVIDER_CAPACITY_ROLLUP_BUCKET_MS,
        rollup_window_ms: windowMs,
      },
      // A failed scan must not masquerade as an empty curve.
      rollup_scan: rollups === null ? "unavailable" : "ok",
      rollups: rollups ?? [],
      claude_rollup_scan: claudeRollups.scan,
      claude_rollup_truncated: claudeRollups.truncated,
      claude_rollups: claudeRollups.points,
    },
    { "Cache-Control": "no-store" }
  );
};

export const handleProviderCapacity = async (
  request: Request = new Request("https://ai.ubq.fi/admin/providers/capacity"),
  options: ProviderCapacitySnapshotOptions = {}
): Promise<Response> => {
  const promptCache = readPromptCacheAnalytics({ kv: options.kv, now: options.now });
  // The admin Provider analytics card is the current operator surface for the
  // paid-fallback ledger growth estimate. This is a bounded daily-counter scan
  // (retention rows only) and never touches the capacity rollups.
  const nowMs = safeNow(options.now ?? Date.now);
  const kv = options.kv === undefined ? await getKv() : options.kv;
  const claudeHistory = readClaudeCapacityHistory(kv, nowMs);
  const ledgerGrowth = await readPaidFallbackLedgerGrowth(kv, { nowMs, retentionMs: PAID_FALLBACK_REQUEST_LOG_RETENTION_MS });
  const remoteHistory = kv ? await readRemoteCapacityObservations(kv, nowMs).catch(() => []) : [];
  const withAnalyticsHistory = (view: ProviderCapacityView): ProviderCapacityView =>
    remoteHistory.length ? { ...view, history: mergeCapacityHistory(view.history, remoteHistory) } : view;
  try {
    const live = new URL(request.url).searchParams.get("refresh") === "live";
    // `?refresh=live` keeps forcing an operator probe. A normal read serves the
    // persisted snapshot while it is inside the read freshness window and
    // otherwise revalidates through the same lease-guarded refresh, so the
    // thirty-second admin poll sees current quota without stacking duplicate
    // upstream calls: concurrent stale reads coalesce on the shared lease and
    // its bounded cold wait. A refresh that throws keeps the last known
    // snapshot; a refresh that reaches upstream but fails leaves the affected
    // source unavailable rather than fabricating a percentage.
    const claudeRoster = await claudeCapacityRoster(kv, nowMs).catch(() => ({ claude: unavailableClaudeCapacitySource(nowMs), claude_accounts: [] }));
    const cached = await getPersistedProviderCapacityView(options).catch(() => null);
    if (!live && cached && capacityViewIsFresh(cached, safeNow(options.now ?? Date.now))) {
      return json(
        200,
        { ...withAnalyticsHistory(cached), ...claudeRoster, claude_history: await claudeHistory, prompt_cache: await promptCache, ledger_growth: ledgerGrowth },
        { "Cache-Control": "no-store" }
      );
    }
    const refreshed = await refreshProviderCapacityInternal(options, live).catch(() => null);
    const view = refreshed ?? cached ?? unavailableView(Date.now(), [], [], [], []);
    return json(
      200,
      { ...withAnalyticsHistory(view), ...claudeRoster, claude_history: await claudeHistory, prompt_cache: await promptCache, ledger_growth: ledgerGrowth },
      { "Cache-Control": "no-store" }
    );
  } catch {
    return json(
      200,
      {
        ...withAnalyticsHistory(unavailableView(Date.now(), [], [], [], [])),
        claude_history: await claudeHistory,
        prompt_cache: await promptCache,
        ledger_growth: ledgerGrowth,
      },
      { "Cache-Control": "no-store" }
    );
  }
};
