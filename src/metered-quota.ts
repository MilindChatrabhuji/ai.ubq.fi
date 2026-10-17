import type { Kv, KvEntryMaybe, KvKey } from "#kv";
import { getKv } from "./kv.ts";
import { isRecord, sha256Hex } from "./utils.ts";
import { METERED_BASE_URL, type MeteredFetch } from "./provider/metered.ts";

export const METERED_QUOTA_FRESH_MS = 5 * 60_000;
export const METERED_QUOTA_RETENTION_MS = 24 * 60 * 60_000;
export const METERED_QUOTA_REFRESH_LEASE_MS = 15_000;
export const METERED_QUOTA_COLD_WAIT_MS = 2_000;
export const METERED_QUOTA_FETCH_TIMEOUT_MS = 10_000;

export const METERED_API_KEY_ENV = "METERED_API_KEY";

export const METERED_QUOTA_STATE_KEY = ["uos_ai", "metered_quota", "v1", "state"] as const;
export const METERED_QUOTA_REFRESH_LEASE_KEY = ["uos_ai", "metered_quota", "v1", "refresh_lease"] as const;
export const METERED_QUOTA_INVALIDATION_KEY = ["uos_ai", "metered_quota", "v1", "invalidation"] as const;
export const METERED_QUOTA_BALANCE_HISTORY_PREFIX = ["uos_ai", "metered_quota", "v1", "balance_history"] as const;
export const METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS = 60 * 60 * 1_000;
export const METERED_QUOTA_BALANCE_HISTORY_DAILY_BUCKET_MS = 24 * METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS;
export const METERED_QUOTA_BALANCE_WINDOW_DAYS = [7, 30, 90, 365] as const;
export type MeteredQuotaBalanceWindowDays = (typeof METERED_QUOTA_BALANCE_WINDOW_DAYS)[number];

export const normalizeMeteredQuotaBalanceWindowDays = (value: string | null): MeteredQuotaBalanceWindowDays => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && METERED_QUOTA_BALANCE_WINDOW_DAYS.some((days) => days === parsed) ? (parsed as MeteredQuotaBalanceWindowDays) : 7;
};

const METERED_TOKEN_USAGE_URL = `${METERED_BASE_URL}/api/usage/token/`;

export type MeteredAccountCredentials = Readonly<{
  apiKey: string;
}>;

export type MeteredRefillObservation = Readonly<{
  id: string;
  amount_credits: number;
  completed_at_ms: number;
}>;

export type MeteredQuotaObservation = Readonly<{
  balance_quota: number | null;
  used_quota: number | null;
  quota_per_credit: number | null;
  observed_at_ms: number;
  latest_refill: MeteredRefillObservation | null;
  unlimited_quota?: boolean;
  total_available?: number;
  total_granted?: number;
  total_used?: number;
}>;

export type MeteredQuotaConfidence = "provisional" | "refill_observed" | "inferred_adjustment";

export type MeteredQuotaState = Readonly<{
  current_balance_quota: number;
  post_refill_baseline_quota: number;
  last_observed_used_quota: number;
  quota_per_credit: number;
  observed_at_ms: number;
  cycle_started_at_ms: number;
  confidence: MeteredQuotaConfidence;
  last_known_debits_quota: number;
  last_inferred_credit_quota: number;
  last_credit_at_ms: number | null;
  latest_refill_id: string | null;
  latest_refill_amount_credits: number | null;
  latest_refill_completed_at_ms: number | null;
  unlimited_quota?: boolean;
  total_available?: number | null;
  total_granted?: number | null;
  total_used?: number | null;
}>;

export type MeteredQuotaCacheState = "fresh" | "refreshed" | "stale" | "wait";

/**
 * One hourly snapshot of the Metered quota balance. Unlike the single state
 * key (24h retention) this remains available for the admin quota-runway view
 * long enough to draw the balance run-down curve at a tiny byte cost.
 */
export type MeteredQuotaBalanceSample = Readonly<{
  v: 1;
  bucket_start_at_ms: number;
  observed_at_ms: number;
  balance_quota: number;
  baseline_quota: number;
  quota_per_credit: number;
  remaining_percent: number | null;
  unlimited_quota?: boolean;
  total_available?: number | null;
  total_granted?: number | null;
  total_used?: number | null;
}>;

export type MeteredQuotaSnapshot = Readonly<{
  state: MeteredQuotaState;
  cache_state: MeteredQuotaCacheState;
  balance_credits: number | null;
  baseline_credits: number | null;
  last_inferred_credit_credits: number | null;
  remaining_percent: number | null;
  used_percent: number | null;
  unlimited_quota: boolean;
  total_available: number | null;
  total_granted: number | null;
  total_used: number | null;
}>;

export type MeteredQuotaDiagnostics = Readonly<{
  configured: boolean;
  available: boolean;
  cache_state: MeteredQuotaCacheState | null;
  confidence: MeteredQuotaConfidence | null;
  balance_credits: number | null;
  baseline_credits: number | null;
  remaining_percent: number | null;
  used_percent: number | null;
  observed_at_ms: number | null;
  cycle_started_at_ms: number | null;
  last_known_debits_credits: number | null;
  last_inferred_credit_credits: number | null;
  last_credit_at_ms: number | null;
  latest_refill_id: string | null;
  latest_refill_amount_credits: number | null;
  latest_refill_completed_at_ms: number | null;
  unlimited_quota?: boolean | null;
  total_available?: number | null;
  total_granted?: number | null;
  total_used?: number | null;
}>;

export type GetMeteredQuotaSnapshotOptions = Readonly<{
  kv?: Kv | null;
  fetcher?: MeteredFetch;
  now?: () => number;
  signal?: AbortSignal;
  forceRefresh?: boolean;
  createLeaseOwner?: () => string;
}>;

type RefreshLease = Readonly<{
  owner: string;
  lease_until_ms: number;
}>;

type QuotaInvalidation = Readonly<{
  invalidated_at_ms: number;
}>;

type JsonRecord = Record<string, unknown>;

const isSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

const isNonNegativeSafeInteger = (value: unknown): value is number => isSafeInteger(value) && value >= 0;

const isPositiveSafeInteger = (value: unknown): value is number => isSafeInteger(value) && value > 0;

const isNonNegativeFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

const isConfidence = (value: unknown): value is MeteredQuotaConfidence =>
  value === "provisional" || value === "refill_observed" || value === "inferred_adjustment";

const isQuotaInvalidation = (value: unknown): value is QuotaInvalidation => isRecord(value) && isNonNegativeSafeInteger(value.invalidated_at_ms);

const parseCredentials = (credentials: MeteredAccountCredentials): MeteredAccountCredentials | null => {
  const apiKey = credentials.apiKey.trim();
  if (!apiKey || /\s/.test(apiKey)) return null;
  return { apiKey };
};

const getEnv = (key: string): string | undefined => {
  try {
    return process.env[key];
  } catch {
    return undefined;
  }
};

export const readMeteredAccountCredentials = (): MeteredAccountCredentials | null =>
  parseCredentials({
    apiKey: getEnv(METERED_API_KEY_ENV) ?? "",
  });

/**
 * Non-secret fingerprint of the configured OpenLux account. The balance
 * history is namespaced by it so switching METERED_API_KEY starts a fresh
 * curve per account instead of corrupting the retained run-down history.
 */
export const meterQuotaAccountFingerprint = async (credentials: MeteredAccountCredentials | null): Promise<string | null> => {
  const parsed = parseCredentials(credentials ?? { apiKey: "" });
  if (!parsed) return null;
  try {
    return (await sha256Hex(parsed.apiKey)).slice(0, 16);
  } catch {
    return null;
  }
};

const authenticatedHeaders = (credentials: MeteredAccountCredentials): Headers => {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${credentials.apiKey}`,
  });
  return headers;
};

const successfulEnvelopeData = (value: unknown): JsonRecord | null => {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  return value.data;
};

const fetchJson = async (url: string, fetcher: MeteredFetch, headers: Headers, signal: AbortSignal): Promise<unknown> => {
  const response = await fetcher(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal,
  });
  if (!response.ok) throw new Error(`Metered account API returned HTTP ${response.status}`);
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) throw new Error("Metered account API returned non-JSON data");
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("Metered account API returned invalid JSON");
  }
};

const combinedSignal = (signal: AbortSignal | undefined): AbortSignal => {
  const timeout = AbortSignal.timeout(METERED_QUOTA_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

export const fetchMeteredQuotaObservation = async (
  credentialsInput: MeteredAccountCredentials,
  options: Readonly<{
    fetcher?: MeteredFetch;
    now?: () => number;
    signal?: AbortSignal;
  }> = {}
): Promise<MeteredQuotaObservation> => {
  const credentials = parseCredentials(credentialsInput);
  if (!credentials) throw new Error("Metered account credentials are invalid");
  const fetcher = options.fetcher ?? fetch;
  const signal = combinedSignal(options.signal);
  const usageEnvelope = await fetchJson(METERED_TOKEN_USAGE_URL, fetcher, authenticatedHeaders(credentials), signal);
  const usage = successfulEnvelopeData(usageEnvelope);
  if (!usage) throw new Error("Metered account API returned an invalid envelope");
  if (
    typeof usage.unlimited_quota !== "boolean" ||
    !isSafeInteger(usage.total_available) ||
    !isSafeInteger(usage.total_granted) ||
    !isSafeInteger(usage.total_used)
  )
    throw new Error("Metered account API returned invalid token usage data");
  const observedAtMs = Math.trunc((options.now ?? Date.now)());
  if (!isNonNegativeSafeInteger(observedAtMs)) throw new Error("Metered quota observation clock is invalid");
  return {
    balance_quota: null,
    used_quota: null,
    quota_per_credit: null,
    observed_at_ms: observedAtMs,
    latest_refill: null,
    unlimited_quota: usage.unlimited_quota,
    total_available: usage.total_available,
    total_granted: usage.total_granted,
    total_used: usage.total_used,
  };
};

const hasTokenUsageObservation = (observation: MeteredQuotaObservation): boolean =>
  observation.unlimited_quota !== undefined ||
  observation.total_available !== undefined ||
  observation.total_granted !== undefined ||
  observation.total_used !== undefined;

const tokenUsageQuotaState = (observation: MeteredQuotaObservation): MeteredQuotaState => {
  if (
    typeof observation.unlimited_quota !== "boolean" ||
    !isSafeInteger(observation.total_available) ||
    !isSafeInteger(observation.total_granted) ||
    !isSafeInteger(observation.total_used)
  )
    throw new Error("Metered token usage observation is incomplete");
  return {
    // Token usage is not a wallet refill cycle. Keep the legacy numeric
    // fields neutral so signed totals cannot become spendable credits.
    current_balance_quota: 0,
    post_refill_baseline_quota: 0,
    last_observed_used_quota: 0,
    quota_per_credit: 1,
    observed_at_ms: observation.observed_at_ms,
    cycle_started_at_ms: observation.observed_at_ms,
    confidence: "provisional",
    last_known_debits_quota: 0,
    last_inferred_credit_quota: 0,
    last_credit_at_ms: null,
    latest_refill_id: null,
    latest_refill_amount_credits: null,
    latest_refill_completed_at_ms: null,
    unlimited_quota: observation.unlimited_quota,
    total_available: observation.total_available,
    total_granted: observation.total_granted,
    total_used: observation.total_used,
  };
};

/** A wallet observation whose nullable credit fields have been proven present. */
type MeteredWalletObservation = Readonly<{
  balance_quota: number;
  used_quota: number;
  quota_per_credit: number;
  observed_at_ms: number;
  latest_refill: MeteredRefillObservation | null;
}>;

const meteredWalletObservation = (observation: MeteredQuotaObservation): MeteredWalletObservation => {
  if (observation.balance_quota === null || observation.used_quota === null || observation.quota_per_credit === null)
    throw new Error("Metered wallet observation is incomplete");
  return {
    balance_quota: observation.balance_quota,
    used_quota: observation.used_quota,
    quota_per_credit: observation.quota_per_credit,
    observed_at_ms: observation.observed_at_ms,
    latest_refill: observation.latest_refill,
  };
};

const initialWalletQuotaState = (wallet: MeteredWalletObservation): MeteredQuotaState => {
  const refillBaselineQuota = wallet.latest_refill ? Math.round(wallet.latest_refill.amount_credits * wallet.quota_per_credit) : 0;
  const postRefillBaselineQuota =
    Number.isSafeInteger(refillBaselineQuota) && refillBaselineQuota > 0 ? Math.max(wallet.balance_quota, refillBaselineQuota) : wallet.balance_quota;
  return {
    current_balance_quota: wallet.balance_quota,
    post_refill_baseline_quota: postRefillBaselineQuota,
    last_observed_used_quota: wallet.used_quota,
    quota_per_credit: wallet.quota_per_credit,
    observed_at_ms: wallet.observed_at_ms,
    cycle_started_at_ms: wallet.latest_refill?.completed_at_ms ?? wallet.observed_at_ms,
    confidence: "provisional",
    last_known_debits_quota: 0,
    last_inferred_credit_quota: 0,
    last_credit_at_ms: null,
    latest_refill_id: wallet.latest_refill?.id ?? null,
    latest_refill_amount_credits: wallet.latest_refill?.amount_credits ?? null,
    latest_refill_completed_at_ms: wallet.latest_refill?.completed_at_ms ?? null,
  };
};

const advancedWalletQuotaState = (previous: MeteredQuotaState, wallet: MeteredWalletObservation): MeteredQuotaState => {
  const usedCounterAdvanced = wallet.used_quota >= previous.last_observed_used_quota;
  const knownDebits = usedCounterAdvanced ? wallet.used_quota - previous.last_observed_used_quota : 0;
  const expectedBalance = previous.current_balance_quota - knownDebits;
  const inferredCredit = usedCounterAdvanced
    ? Math.max(0, wallet.balance_quota - expectedBalance)
    : Math.max(0, wallet.balance_quota - previous.current_balance_quota);
  const newRefillObserved = Boolean(wallet.latest_refill && wallet.latest_refill.id !== previous.latest_refill_id);
  const creditObserved = inferredCredit > 0 || newRefillObserved;
  const refillBaselineQuota = newRefillObserved && wallet.latest_refill ? Math.round(wallet.latest_refill.amount_credits * wallet.quota_per_credit) : 0;
  const balancePlusKnownDebits = wallet.balance_quota + knownDebits;
  const reconstructedRefillCapacityQuota =
    newRefillObserved && knownDebits > 0 && Number.isSafeInteger(balancePlusKnownDebits) ? balancePlusKnownDebits : wallet.balance_quota;
  const refillBaselineFloor = Number.isSafeInteger(refillBaselineQuota) && refillBaselineQuota > 0 ? refillBaselineQuota : 0;
  const postRefillBaselineQuota = creditObserved ? Math.max(reconstructedRefillCapacityQuota, refillBaselineFloor) : previous.post_refill_baseline_quota;
  const observedConfidence: MeteredQuotaConfidence = newRefillObserved ? "refill_observed" : "inferred_adjustment";
  return {
    current_balance_quota: wallet.balance_quota,
    post_refill_baseline_quota: postRefillBaselineQuota,
    last_observed_used_quota: wallet.used_quota,
    quota_per_credit: wallet.quota_per_credit,
    observed_at_ms: wallet.observed_at_ms,
    cycle_started_at_ms: creditObserved ? (wallet.latest_refill?.completed_at_ms ?? wallet.observed_at_ms) : previous.cycle_started_at_ms,
    confidence: creditObserved ? observedConfidence : previous.confidence,
    last_known_debits_quota: knownDebits,
    last_inferred_credit_quota: creditObserved ? inferredCredit : 0,
    last_credit_at_ms: creditObserved ? wallet.observed_at_ms : previous.last_credit_at_ms,
    latest_refill_id: wallet.latest_refill?.id ?? previous.latest_refill_id,
    latest_refill_amount_credits: wallet.latest_refill?.amount_credits ?? previous.latest_refill_amount_credits,
    latest_refill_completed_at_ms: wallet.latest_refill?.completed_at_ms ?? previous.latest_refill_completed_at_ms,
  };
};

export const updateMeteredQuotaState = (previous: MeteredQuotaState | null, observation: MeteredQuotaObservation): MeteredQuotaState => {
  if (hasTokenUsageObservation(observation)) return tokenUsageQuotaState(observation);
  const wallet = meteredWalletObservation(observation);
  if (!previous) return initialWalletQuotaState(wallet);
  return advancedWalletQuotaState(previous, wallet);
};

export const isMeteredQuotaState = (value: unknown): value is MeteredQuotaState => {
  if (!isRecord(value)) return false;
  return (
    isSafeInteger(value.current_balance_quota) &&
    isSafeInteger(value.post_refill_baseline_quota) &&
    isNonNegativeSafeInteger(value.last_observed_used_quota) &&
    isPositiveSafeInteger(value.quota_per_credit) &&
    isNonNegativeSafeInteger(value.observed_at_ms) &&
    isNonNegativeSafeInteger(value.cycle_started_at_ms) &&
    isConfidence(value.confidence) &&
    isNonNegativeSafeInteger(value.last_known_debits_quota) &&
    isNonNegativeSafeInteger(value.last_inferred_credit_quota) &&
    (value.last_credit_at_ms === null || isNonNegativeSafeInteger(value.last_credit_at_ms)) &&
    (value.latest_refill_id === null || typeof value.latest_refill_id === "string") &&
    (value.latest_refill_amount_credits === null || isNonNegativeFiniteNumber(value.latest_refill_amount_credits)) &&
    (value.latest_refill_completed_at_ms === null || isNonNegativeSafeInteger(value.latest_refill_completed_at_ms)) &&
    (value.unlimited_quota === undefined || typeof value.unlimited_quota === "boolean") &&
    (value.total_available === undefined || value.total_available === null || isSafeInteger(value.total_available)) &&
    (value.total_granted === undefined || value.total_granted === null || isSafeInteger(value.total_granted)) &&
    (value.total_used === undefined || value.total_used === null || isSafeInteger(value.total_used))
  );
};

/** Remaining percentage of the post-refill baseline, null when unusable. */
const remainingPercentOfBaseline = (currentBalanceQuota: number, postRefillBaselineQuota: number): number | null => {
  if (postRefillBaselineQuota <= 0) return null;
  return Math.min(100, Math.max(0, (currentBalanceQuota / postRefillBaselineQuota) * 100));
};

const toSnapshot = (state: MeteredQuotaState, cacheState: MeteredQuotaCacheState): MeteredQuotaSnapshot => {
  const tokenUsage =
    state.unlimited_quota !== undefined || state.total_available !== undefined || state.total_granted !== undefined || state.total_used !== undefined;
  const balanceCredits = tokenUsage ? null : state.current_balance_quota / state.quota_per_credit;
  const baselineCredits = tokenUsage ? null : state.post_refill_baseline_quota / state.quota_per_credit;
  const remainingPercent = tokenUsage ? null : remainingPercentOfBaseline(state.current_balance_quota, state.post_refill_baseline_quota);
  return {
    state,
    cache_state: cacheState,
    balance_credits: balanceCredits,
    baseline_credits: baselineCredits,
    last_inferred_credit_credits: tokenUsage ? null : state.last_inferred_credit_quota / state.quota_per_credit,
    remaining_percent: remainingPercent,
    used_percent: remainingPercent === null ? null : 100 - remainingPercent,
    unlimited_quota: tokenUsage ? state.unlimited_quota === true : false,
    total_available: tokenUsage && typeof state.total_available === "number" ? state.total_available : null,
    total_granted: tokenUsage && typeof state.total_granted === "number" ? state.total_granted : null,
    total_used: tokenUsage && typeof state.total_used === "number" ? state.total_used : null,
  };
};

const loadRetainedState = async (kv: Kv, nowMs: number): Promise<KvEntryMaybe<MeteredQuotaState> | null> => {
  const entry = await kv.get<MeteredQuotaState>(METERED_QUOTA_STATE_KEY);
  if (!isMeteredQuotaState(entry.value)) return null;
  if (nowMs - entry.value.observed_at_ms >= METERED_QUOTA_RETENTION_MS) return null;
  return entry;
};

const loadInvalidation = (kv: Kv): Promise<KvEntryMaybe<unknown>> => Promise.resolve(kv.get(METERED_QUOTA_INVALIDATION_KEY));

const quotaInvalidationValue = (value: unknown): QuotaInvalidation | null => (isQuotaInvalidation(value) ? value : null);

const isInvalidated = (state: MeteredQuotaState, invalidation: QuotaInvalidation | null): boolean =>
  Boolean(invalidation && invalidation.invalidated_at_ms >= state.observed_at_ms);

const acquireRefreshLease = async (kv: Kv, owner: string, nowMs: number): Promise<boolean> => {
  const entry = await kv.get<RefreshLease>(METERED_QUOTA_REFRESH_LEASE_KEY);
  if (entry.value && entry.value.lease_until_ms > nowMs) return false;
  const lease: RefreshLease = { owner, lease_until_ms: nowMs + METERED_QUOTA_REFRESH_LEASE_MS };
  return (
    await kv
      .atomic()
      .check(entry)
      .set(METERED_QUOTA_REFRESH_LEASE_KEY, lease, { expireIn: METERED_QUOTA_REFRESH_LEASE_MS * 2 })
      .commit()
  ).ok;
};

const releaseRefreshLease = async (kv: Kv, owner: string): Promise<void> => {
  try {
    const entry = await kv.get<RefreshLease>(METERED_QUOTA_REFRESH_LEASE_KEY);
    if (entry.value?.owner === owner) {
      await kv.atomic().check(entry).delete(METERED_QUOTA_REFRESH_LEASE_KEY).commit();
    }
  } catch (error) {
    console.warn("[ai.ubq.fi] Metered quota refresh lease release failed:", error);
  }
};

const waitForColdState = async (kv: Kv): Promise<MeteredQuotaState | null> => {
  const deadline = Date.now() + METERED_QUOTA_COLD_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const entry = await loadRetainedState(kv, Date.now());
    if (entry?.value) return entry.value;
  }
  return null;
};

/** Stale snapshot from the newest retained state, falling back to the cache. */
const staleSnapshotOrNull = (replacement: MeteredQuotaState | null, cached: MeteredQuotaState | null): MeteredQuotaSnapshot | null => {
  if (replacement) return toSnapshot(replacement, "stale");
  if (cached) return toSnapshot(cached, "stale");
  return null;
};

const replacementStaleSnapshot = async (kv: Kv, cached: MeteredQuotaState | null): Promise<MeteredQuotaSnapshot | null> => {
  const replacement = await loadRetainedState(kv, Date.now()).catch(() => null);
  return staleSnapshotOrNull(replacement?.value ?? null, cached);
};

const readCachedQuotaState = async (kv: Kv, nowMs: number): Promise<Readonly<{ cached: MeteredQuotaState | null; cachedInvalidated: boolean }>> => {
  const [cachedEntry, cachedInvalidationEntry] = await Promise.all([
    loadRetainedState(kv, nowMs).catch((error: unknown) => {
      console.warn("[ai.ubq.fi] Metered quota cache read failed:", error);
      return null;
    }),
    loadInvalidation(kv).catch((error: unknown) => {
      console.warn("[ai.ubq.fi] Metered quota invalidation read failed:", error);
      return null;
    }),
  ]);
  const cached = cachedEntry?.value ?? null;
  return { cached, cachedInvalidated: cached ? isInvalidated(cached, quotaInvalidationValue(cachedInvalidationEntry?.value)) : false };
};

/**
 * Refresh under a held lease. Returns null when the lease was lost, which the
 * caller reports through the same stale snapshot used for a failed commit.
 */
const refreshMeteredQuotaSnapshot = async (
  kv: Kv,
  credentials: MeteredAccountCredentials,
  options: GetMeteredQuotaSnapshotOptions,
  cached: MeteredQuotaState | null,
  owner: string,
  now: () => number
): Promise<MeteredQuotaSnapshot | null> => {
  const [stateEntry, refreshInvalidationEntry] = await Promise.all([kv.get<MeteredQuotaState>(METERED_QUOTA_STATE_KEY), loadInvalidation(kv)]);
  const observation = await fetchMeteredQuotaObservation(credentials, {
    fetcher: options.fetcher,
    now,
    signal: options.signal,
  });
  const leaseEntry = await kv.get<RefreshLease>(METERED_QUOTA_REFRESH_LEASE_KEY);
  if (leaseEntry.value?.owner !== owner || leaseEntry.value.lease_until_ms <= observation.observed_at_ms) {
    return await replacementStaleSnapshot(kv, cached);
  }
  const previous = isMeteredQuotaState(stateEntry.value) ? stateEntry.value : null;
  const state = updateMeteredQuotaState(previous, observation);
  const committed = await kv
    .atomic()
    .check(stateEntry)
    .check(refreshInvalidationEntry)
    .check(leaseEntry)
    .set(METERED_QUOTA_STATE_KEY, state, { expireIn: METERED_QUOTA_RETENTION_MS })
    .delete(METERED_QUOTA_INVALIDATION_KEY)
    .delete(METERED_QUOTA_REFRESH_LEASE_KEY)
    .commit();
  if (committed.ok) {
    const accountFingerprint = await meterQuotaAccountFingerprint(credentials).catch(() => null);
    await writeMeteredQuotaBalanceSample(kv, state, observation.observed_at_ms, accountFingerprint).catch((error: unknown) => {
      console.warn("[ai.ubq.fi] Metered quota balance history write failed:", error);
    });
    return toSnapshot(state, "refreshed");
  }
  return await replacementStaleSnapshot(kv, cached);
};

/** Without the lease we serve whatever retained state appears, or nothing. */
const coldWaitSnapshot = async (kv: Kv, cached: MeteredQuotaState | null): Promise<MeteredQuotaSnapshot | null> => {
  if (cached) return toSnapshot(cached, "stale");
  const waited = await waitForColdState(kv).catch(() => null);
  return waited ? toSnapshot(waited, "wait") : null;
};

export const getMeteredQuotaSnapshot = async (
  credentials: MeteredAccountCredentials,
  options: GetMeteredQuotaSnapshotOptions = {}
): Promise<MeteredQuotaSnapshot | null> => {
  const kv = options.kv === undefined ? await getKv() : options.kv;
  if (!kv || !parseCredentials(credentials)) return null;
  const now = options.now ?? Date.now;
  const nowMs = Math.trunc(now());
  const { cached, cachedInvalidated } = await readCachedQuotaState(kv, nowMs);
  if (cached && !options.forceRefresh && !cachedInvalidated && nowMs - cached.observed_at_ms < METERED_QUOTA_FRESH_MS) {
    return toSnapshot(cached, "fresh");
  }

  const owner = (options.createLeaseOwner ?? (() => crypto.randomUUID()))();
  const acquired = await acquireRefreshLease(kv, owner, nowMs).catch((error: unknown) => {
    console.warn("[ai.ubq.fi] Metered quota refresh lease acquisition failed:", error);
    return false;
  });
  if (!acquired) return await coldWaitSnapshot(kv, cached);

  try {
    return await refreshMeteredQuotaSnapshot(kv, credentials, options, cached, owner, now);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    console.warn("[ai.ubq.fi] Metered quota refresh failed:", error instanceof Error ? error.message : String(error));
    return cached ? toSnapshot(cached, "stale") : null;
  } finally {
    await releaseRefreshLease(kv, owner);
  }
};

export const getCachedMeteredQuotaSnapshot = async (options: Pick<GetMeteredQuotaSnapshotOptions, "kv" | "now"> = {}): Promise<MeteredQuotaSnapshot | null> => {
  const kv = options.kv === undefined ? await getKv() : options.kv;
  if (!kv) return null;
  const nowMs = Math.trunc((options.now ?? Date.now)());
  try {
    const [stateEntry, invalidationEntry] = await Promise.all([loadRetainedState(kv, nowMs), loadInvalidation(kv)]);
    const state = stateEntry?.value ?? null;
    if (!state) return null;
    const fresh = !isInvalidated(state, quotaInvalidationValue(invalidationEntry.value)) && nowMs - state.observed_at_ms < METERED_QUOTA_FRESH_MS;
    return toSnapshot(state, fresh ? "fresh" : "stale");
  } catch (error) {
    console.warn("[ai.ubq.fi] Metered quota cache peek failed:", error);
    return null;
  }
};

export const invalidateMeteredQuotaSnapshot = async (options: Pick<GetMeteredQuotaSnapshotOptions, "kv" | "now"> = {}): Promise<void> => {
  const kv = options.kv === undefined ? await getKv() : options.kv;
  if (!kv) return;
  const invalidatedAtMs = Math.trunc((options.now ?? Date.now)());
  if (!isNonNegativeSafeInteger(invalidatedAtMs)) throw new Error("Metered quota invalidation clock is invalid");
  const committed = await kv
    .atomic()
    .set(METERED_QUOTA_INVALIDATION_KEY, { invalidated_at_ms: invalidatedAtMs } satisfies QuotaInvalidation, { expireIn: METERED_QUOTA_RETENTION_MS })
    .commit();
  if (!committed.ok) throw new Error("Deno KV could not invalidate the Metered quota snapshot");
};

const isMeteredQuotaBalanceSample = (value: unknown): value is MeteredQuotaBalanceSample => {
  if (!isRecord(value)) return false;
  return (
    value.v === 1 &&
    isNonNegativeSafeInteger(value.bucket_start_at_ms) &&
    isNonNegativeSafeInteger(value.observed_at_ms) &&
    isSafeInteger(value.balance_quota) &&
    isSafeInteger(value.baseline_quota) &&
    isPositiveSafeInteger(value.quota_per_credit) &&
    (value.remaining_percent === null || isNonNegativeFiniteNumber(value.remaining_percent)) &&
    (value.unlimited_quota === undefined || typeof value.unlimited_quota === "boolean") &&
    (value.total_available === undefined || value.total_available === null || isSafeInteger(value.total_available)) &&
    (value.total_granted === undefined || value.total_granted === null || isSafeInteger(value.total_granted)) &&
    (value.total_used === undefined || value.total_used === null || isSafeInteger(value.total_used))
  );
};

const balanceSampleFromState = (state: MeteredQuotaState, observedAtMs: number): MeteredQuotaBalanceSample | null => {
  if (!isNonNegativeSafeInteger(observedAtMs)) return null;
  const tokenUsage =
    state.unlimited_quota !== undefined || state.total_available !== undefined || state.total_granted !== undefined || state.total_used !== undefined;
  const remainingPercent = tokenUsage ? null : remainingPercentOfBaseline(state.current_balance_quota, state.post_refill_baseline_quota);
  return {
    v: 1,
    bucket_start_at_ms: Math.floor(observedAtMs / METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS) * METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS,
    observed_at_ms: observedAtMs,
    balance_quota: state.current_balance_quota,
    baseline_quota: state.post_refill_baseline_quota,
    quota_per_credit: state.quota_per_credit,
    remaining_percent: remainingPercent,
    ...(tokenUsage
      ? {
          unlimited_quota: state.unlimited_quota === true,
          total_available: state.total_available ?? null,
          total_granted: state.total_granted ?? null,
          total_used: state.total_used ?? null,
        }
      : {}),
  };
};

/**
 * Upserts one hourly balance sample. Best-effort: a failure must never fail
 * a quota refresh. Keeps the newest observation in each hour bucket so a
 * later refresh never leaves the hour's oldest balance on the run-down curve.
 * Reader is readMeteredQuotaBalanceHistory.
 */
export const writeMeteredQuotaBalanceSample = async (
  kv: Kv,
  state: MeteredQuotaState,
  observedAtMs: number,
  accountFingerprint: string | null
): Promise<void> => {
  const sample = balanceSampleFromState(state, observedAtMs);
  if (!sample || !accountFingerprint) return;
  const key = [...METERED_QUOTA_BALANCE_HISTORY_PREFIX, accountFingerprint, sample.bucket_start_at_ms] as const;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await kv.get<MeteredQuotaBalanceSample>(key, { consistency: "strong" });
    const existing = isMeteredQuotaBalanceSample(entry.value) ? entry.value : null;
    if (existing && existing.observed_at_ms >= sample.observed_at_ms) return;
    const committed = await kv.atomic().check(entry).set(key, sample).commit();
    if (committed.ok) return;
  }
  throw new Error("Metered quota balance history changed concurrently.");
};

export const readMeteredQuotaBalanceHistory = async (
  kv: Kv | null,
  options: Readonly<{ sinceMs: number; nowMs: number; accountFingerprint: string | null; limit?: number }>
): Promise<MeteredQuotaBalanceSample[]> => {
  if (!kv || !options.accountFingerprint) return [];
  const limit = Math.max(1, Math.min(10_000, Math.trunc(options.limit ?? 10_000)));
  const samples: MeteredQuotaBalanceSample[] = [];
  const sinceMs = Math.max(0, Math.trunc(options.sinceMs));
  const nowMs = Math.max(sinceMs, Math.trunc(options.nowMs));
  const prefix: KvKey = [...METERED_QUOTA_BALANCE_HISTORY_PREFIX, options.accountFingerprint];
  const start: KvKey = [...prefix, Math.floor(sinceMs / METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS) * METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS];
  const end: KvKey = [
    ...prefix,
    Math.floor(nowMs / METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS) * METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS + METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS,
  ];
  // Deno KV rejects selectors that combine a prefix with both range bounds.
  // These bounds already include the complete account-specific namespace.
  for await (const entry of kv.list<MeteredQuotaBalanceSample>(
    { start, end },
    {
      limit,
    }
  )) {
    const sample = isMeteredQuotaBalanceSample(entry.value) ? entry.value : null;
    if (sample && sample.observed_at_ms >= sinceMs && sample.observed_at_ms <= nowMs) samples.push(sample);
  }
  return samples.sort((left, right) => left.bucket_start_at_ms - right.bucket_start_at_ms);
};

/**
 * Deterministically keeps the newest observation in each UTC bucket. The
 * returned bucket timestamp describes the resampled series rather than the
 * source hour, while observed_at_ms retains the exact observation time.
 */
export const resampleMeteredQuotaBalanceHistory = (
  samples: readonly MeteredQuotaBalanceSample[],
  bucketMs: number,
  limit: number
): MeteredQuotaBalanceSample[] => {
  if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0 || !Number.isSafeInteger(limit) || limit <= 0) return [];
  const buckets = new Map<number, MeteredQuotaBalanceSample>();
  for (const sample of samples) {
    const bucketStartAtMs = Math.floor(sample.observed_at_ms / bucketMs) * bucketMs;
    const existing = buckets.get(bucketStartAtMs);
    if (
      !existing ||
      sample.observed_at_ms > existing.observed_at_ms ||
      (sample.observed_at_ms === existing.observed_at_ms && sample.bucket_start_at_ms > existing.bucket_start_at_ms)
    ) {
      buckets.set(bucketStartAtMs, { ...sample, bucket_start_at_ms: bucketStartAtMs });
    }
  }
  return [...buckets.values()].sort((left, right) => left.bucket_start_at_ms - right.bucket_start_at_ms).slice(-limit);
};

export const getConfiguredMeteredQuotaSnapshot = async (options: GetMeteredQuotaSnapshotOptions = {}): Promise<MeteredQuotaSnapshot | null> => {
  const credentials = readMeteredAccountCredentials();
  return credentials ? await getMeteredQuotaSnapshot(credentials, options) : null;
};

export const getCachedConfiguredMeteredQuotaSnapshot = async (
  options: Pick<GetMeteredQuotaSnapshotOptions, "kv" | "now"> = {}
): Promise<MeteredQuotaSnapshot | null> => (readMeteredAccountCredentials() ? await getCachedMeteredQuotaSnapshot(options) : null);

const unavailableDiagnostics = (configured: boolean): MeteredQuotaDiagnostics => ({
  configured,
  available: false,
  cache_state: null,
  confidence: null,
  balance_credits: null,
  baseline_credits: null,
  remaining_percent: null,
  used_percent: null,
  observed_at_ms: null,
  cycle_started_at_ms: null,
  last_known_debits_credits: null,
  last_inferred_credit_credits: null,
  last_credit_at_ms: null,
  latest_refill_id: null,
  latest_refill_amount_credits: null,
  latest_refill_completed_at_ms: null,
  unlimited_quota: null,
  total_available: null,
  total_granted: null,
  total_used: null,
});

export const getMeteredQuotaDiagnostics = async (options: GetMeteredQuotaSnapshotOptions = {}): Promise<MeteredQuotaDiagnostics> => {
  const credentials = readMeteredAccountCredentials();
  if (!credentials) return unavailableDiagnostics(false);
  const snapshot = await getMeteredQuotaSnapshot(credentials, options);
  if (!snapshot) return unavailableDiagnostics(true);
  const tokenUsage = snapshot.unlimited_quota || snapshot.total_available !== null || snapshot.total_used !== null;
  return {
    configured: true,
    available: true,
    cache_state: snapshot.cache_state,
    confidence: tokenUsage ? null : snapshot.state.confidence,
    balance_credits: snapshot.balance_credits,
    baseline_credits: snapshot.baseline_credits,
    remaining_percent: snapshot.remaining_percent,
    used_percent: snapshot.used_percent,
    observed_at_ms: snapshot.state.observed_at_ms,
    cycle_started_at_ms: tokenUsage ? null : snapshot.state.cycle_started_at_ms,
    last_known_debits_credits: tokenUsage ? null : snapshot.state.last_known_debits_quota / snapshot.state.quota_per_credit,
    last_inferred_credit_credits: snapshot.last_inferred_credit_credits,
    last_credit_at_ms: tokenUsage ? null : snapshot.state.last_credit_at_ms,
    latest_refill_id: snapshot.state.latest_refill_id,
    latest_refill_amount_credits: snapshot.state.latest_refill_amount_credits,
    latest_refill_completed_at_ms: snapshot.state.latest_refill_completed_at_ms,
    unlimited_quota: snapshot.unlimited_quota,
    total_available: snapshot.total_available,
    total_granted: snapshot.total_granted,
    total_used: snapshot.total_used,
  };
};
