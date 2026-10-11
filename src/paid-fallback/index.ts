import { apiKeyIdKey, MICROCREDITS_PER_CREDIT, PAID_FALLBACK_NO_LIMIT } from "../api-keys.ts";
import {
  admitPaidFallbackV3,
  type PaidFallbackAdmissionBlockedReason,
  releasePaidFallbackBeforeProviderFetchV3,
  updatePaidFallbackRequestV3,
} from "./ledger-admission.ts";
import { markPaidFallbackTerminalV3, reconcileDuePaidFallbacksV3 } from "./ledger-backfill.ts";
import { settlePaidFallbackUsageV3 } from "./ledger-settlement.ts";
import { loadFullCodexModelsSnapshot } from "../codex/index.ts";
import { getKv } from "../kv.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, PaidFallbackProvider } from "../types.ts";
import { getString, isRecord } from "../utils.ts";
import { initializeMeteredPricing, MeteredError, readMeteredApiKey } from "../provider/metered.ts";
import { readSurplusApiKey } from "../provider/surplus.ts";

export type PaidFallbackPolicyFields = Pick<
  ApiKeyRecord,
  | "paid_fallback_enabled"
  | "paid_fallback_limit_microcredits"
  | "paid_fallback_spent_microcredits"
  | "paid_fallback_reserved_microcredits"
  | "paid_fallback_reservation_request_id"
  | "paid_fallback_model_ids"
  | "paid_fallback_quota_per_credit"
  | "paid_fallback_max_exposure_microcredits"
  | "paid_fallback_pricing_checked_at_ms"
>;

export type PaidFallbackReservation = Readonly<{
  key_id: string;
  request_id: string;
  created_at_ms: number;
  reserved_microcredits: number;
  quota_per_credit: number;
  window_reset_at_ms: number;
  quota_used_percent: number | null;
}>;

export type PaidFallbackReservationDecision =
  | { kind: "reserved"; reservation: PaidFallbackReservation }
  | {
      kind: "skip";
      reason: "disabled" | "provider_unconfigured" | "model_not_priced";
    }
  | {
      kind: "blocked";
      reason: "limit_exceeded" | "reconciliation_pending" | "invalid_policy" | "concurrent_update";
      reset_at_ms: number | null;
    };

type PaidFallbackEligibility = { kind: "eligible"; unlimited: boolean } | Exclude<PaidFallbackReservationDecision, { kind: "reserved" }>;

const evaluatePaidFallbackEligibility = (record: ApiKeyRecord, model: string, allowUnrosteredModel = false): PaidFallbackEligibility => {
  if (!record.paid_fallback_enabled) return { kind: "skip", reason: "disabled" };
  const unlimited = record.paid_fallback_limit_microcredits === PAID_FALLBACK_NO_LIMIT;
  if (!record.paid_fallback_model_ids.includes(model)) {
    if (allowUnrosteredModel && unlimited && isPositiveSafeInteger(record.paid_fallback_quota_per_credit)) {
      return { kind: "eligible", unlimited: true };
    }
    return { kind: "skip", reason: "model_not_priced" };
  }
  const exposure = record.paid_fallback_max_exposure_microcredits?.[model] ?? null;
  if (
    (!unlimited && !isPositiveSafeInteger(record.paid_fallback_limit_microcredits)) ||
    !isPositiveSafeInteger(record.paid_fallback_quota_per_credit) ||
    (!unlimited && !isPositiveSafeInteger(exposure))
  ) {
    return { kind: "blocked", reason: "invalid_policy", reset_at_ms: record.usage_reset_at_ms };
  }
  return { kind: "eligible", unlimited };
};

export const defaultPaidFallbackPolicy = (): PaidFallbackPolicyFields => ({
  paid_fallback_enabled: false,
  paid_fallback_limit_microcredits: 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
  paid_fallback_model_ids: [],
  paid_fallback_quota_per_credit: 0,
  paid_fallback_max_exposure_microcredits: {},
  paid_fallback_pricing_checked_at_ms: null,
});

const isNonNegativeSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isNonNegativeFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

const isPositiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isPaidFallbackLimit = (value: unknown): value is number => value === PAID_FALLBACK_NO_LIMIT || isNonNegativeSafeInteger(value);

const isNullableString = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.trim().length > 0);

export const hasStrictPaidFallbackPolicy = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (typeof value.paid_fallback_enabled !== "boolean") return false;
  if (!isPaidFallbackLimit(value.paid_fallback_limit_microcredits)) return false;
  if (!isNonNegativeSafeInteger(value.paid_fallback_spent_microcredits)) return false;
  if (!isNonNegativeSafeInteger(value.paid_fallback_reserved_microcredits)) return false;
  if (!isNullableString(value.paid_fallback_reservation_request_id)) return false;

  const limit = value.paid_fallback_limit_microcredits;
  if (value.paid_fallback_enabled && limit !== PAID_FALLBACK_NO_LIMIT && !isPositiveSafeInteger(limit)) return false;
  return true;
};

export const hasStrictPaidFallbackKeyPolicy = (value: unknown): boolean => {
  if (!hasStrictPaidFallbackPolicy(value) || !isRecord(value)) return false;
  if (!Array.isArray(value.paid_fallback_model_ids) || value.paid_fallback_model_ids.some((model) => typeof model !== "string" || !model.trim())) {
    return false;
  }
  if (!isNonNegativeSafeInteger(value.paid_fallback_quota_per_credit)) return false;
  if (value.paid_fallback_pricing_checked_at_ms !== null && !isPositiveSafeInteger(value.paid_fallback_pricing_checked_at_ms)) {
    return false;
  }
  if (value.paid_fallback_enabled) {
    if (value.paid_fallback_model_ids.length === 0) return false;
    if (!isPositiveSafeInteger(value.paid_fallback_quota_per_credit)) return false;
    if (!isPositiveSafeInteger(value.paid_fallback_pricing_checked_at_ms)) return false;
  }
  return true;
};

export const paidFallbackHashFields = (
  record: ApiKeyRecord
): Pick<
  ApiKeyHashRecord,
  | "paid_fallback_enabled"
  | "paid_fallback_limit_microcredits"
  | "paid_fallback_spent_microcredits"
  | "paid_fallback_reserved_microcredits"
  | "paid_fallback_reservation_request_id"
> => ({
  paid_fallback_enabled: record.paid_fallback_enabled,
  paid_fallback_limit_microcredits: record.paid_fallback_limit_microcredits,
  paid_fallback_spent_microcredits: record.paid_fallback_spent_microcredits,
  paid_fallback_reserved_microcredits: record.paid_fallback_reserved_microcredits,
  paid_fallback_reservation_request_id: record.paid_fallback_reservation_request_id,
});

/**
 * Maximum gateway exposure for one priced model, or null when that model's
 * pricing inputs cannot produce a finite, positive credit bound.
 */
const maximumExposureForModel = (context: number | undefined, coefficient: number | undefined, quotaPerCredit: number): number | null => {
  if (!context || typeof coefficient !== "number" || !Number.isFinite(coefficient) || coefficient <= 0) return null;
  const exposure = Math.ceil((context * coefficient * MICROCREDITS_PER_CREDIT) / quotaPerCredit);
  return Number.isSafeInteger(exposure) && exposure > 0 ? exposure : null;
};

export const initializePaidFallbackPolicy = async (
  signal?: AbortSignal
): Promise<
  Pick<
    PaidFallbackPolicyFields,
    "paid_fallback_model_ids" | "paid_fallback_quota_per_credit" | "paid_fallback_pricing_checked_at_ms" | "paid_fallback_max_exposure_microcredits"
  >
> => {
  if (!readMeteredApiKey() && !readSurplusApiKey()) {
    throw new MeteredError("Metered paid fallback cannot be enabled because no paid provider API key is configured.", "metered_api_key_missing", 503);
  }

  // The compact runtime catalog intentionally omits context bounds to fit one
  // KV read unit. Paid-admission exposure must use the immutable full catalog.
  const snapshot = await loadFullCodexModelsSnapshot();
  const modelIds: string[] = [];
  const contextByModel = new Map<string, number>();
  const seen = new Set<string>();
  for (const model of snapshot?.models ?? []) {
    const id = getString(model.slug) ?? getString(model.id) ?? getString(model.model) ?? getString(model.name);
    const normalized = id?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    modelIds.push(normalized);
    const context = [model.context_window, model.max_context_window, model.auto_compact_token_limit].filter(
      (value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
    );
    if (context.length) contextByModel.set(normalized, Math.max(...context));
  }
  if (!modelIds.length) {
    throw new MeteredError("Metered paid fallback cannot be enabled before the Codex model catalog is initialized.", "metered_pricing_invalid", 503);
  }

  const pricing = await initializeMeteredPricing({ codexModelIds: modelIds, signal });
  if (!pricing.eligible_model_ids.length) {
    throw new MeteredError("Metered paid fallback found no priced models in the current Codex catalog.", "metered_pricing_invalid", 503);
  }
  const maximumExposure: Record<string, number> = {};
  for (const model of pricing.eligible_model_ids) {
    const exposure = maximumExposureForModel(contextByModel.get(model), pricing.model_quota_coefficients[model], pricing.quota_per_credit);
    if (exposure === null) continue;
    maximumExposure[model] = exposure;
  }
  const missingExposure = pricing.eligible_model_ids.some((model) => !isPositiveSafeInteger(maximumExposure[model]));
  if (missingExposure) {
    throw new MeteredError("Metered paid fallback cannot be enabled because a priced Codex model has no finite context bound.", "metered_pricing_invalid", 503);
  }
  return {
    paid_fallback_model_ids: [...pricing.eligible_model_ids],
    paid_fallback_quota_per_credit: pricing.quota_per_credit,
    paid_fallback_max_exposure_microcredits: maximumExposure,
    paid_fallback_pricing_checked_at_ms: pricing.checked_at_ms,
  };
};

type PaidFallbackPolicyEntry = Readonly<{
  record: ApiKeyRecord;
  check: Readonly<{ key: Deno.KvKey; versionstamp: string | null }>;
}>;

const loadStrictKeyRecord = async (kv: Deno.Kv, keyId: string): Promise<PaidFallbackPolicyEntry | null> => {
  const idEntry = await kv.get<ApiKeyRecord>(apiKeyIdKey(keyId), { consistency: "strong" });
  if (!idEntry.value || !hasStrictPaidFallbackKeyPolicy(idEntry.value)) return null;
  return {
    record: idEntry.value,
    check: { key: idEntry.key, versionstamp: idEntry.versionstamp },
  };
};

const advanceUsageWindow = (resetAtMs: number, windowMs: number, nowMs: number): number => {
  if (nowMs < resetAtMs) return resetAtMs;
  const initialStart = resetAtMs - windowMs;
  const elapsedWindows = Math.floor((nowMs - initialStart) / windowMs);
  return initialStart + (elapsedWindows + 1) * windowMs;
};

/**
 * Whether a blocked admission may be retried with another attempt. A due
 * pending settlement can free the reserved exposure that blocked this
 * admission, so it is reconciled here through the existing due gate instead of
 * leaving a deferred reservation stranded until another terminal event happens.
 * The caller's attempt cap keeps a genuinely unresolved window fail-closed.
 */
const retryBlockedPaidFallbackAdmission = async (reason: PaidFallbackAdmissionBlockedReason, attempt: number): Promise<boolean> => {
  if (attempt >= 2) return false;
  if (reason === "concurrent_update") return true;
  if (reason !== "limit_exceeded") return false;
  await reconcileDuePaidFallbacksV3(Date.now()).catch(() => {});
  return true;
};

export const reservePaidFallback = async (
  input: Readonly<{
    keyId: string;
    requestId: string;
    createdAtMs: number;
    model: string;
    route: string;
    path: string;
    stream: boolean;
    reasoning: string | null;
    allowUnrosteredModel?: boolean;
    reason: "primary_429" | "primary_quota_blocked" | "dynamic_paid_model";
  }>
): Promise<PaidFallbackReservationDecision> => {
  const kv = await getKv();
  if (!kv) return { kind: "blocked", reason: "invalid_policy", reset_at_ms: null };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // This strongly-read check is part of the admission CAS. A just-committed
    // disable or cap reduction therefore prevents new paid exposure even when
    // a request had already read the older policy snapshot.
    const policy = await loadStrictKeyRecord(kv, input.keyId);
    if (!policy) return { kind: "blocked", reason: "invalid_policy", reset_at_ms: null };
    const record = policy.record;
    const eligibility = evaluatePaidFallbackEligibility(record, input.model, input.allowUnrosteredModel);
    if (eligibility.kind !== "eligible") return eligibility;
    if (!readMeteredApiKey() && !readSurplusApiKey()) return { kind: "skip", reason: "provider_unconfigured" };
    const windowResetAtMs = advanceUsageWindow(record.usage_reset_at_ms, record.window_ms, input.createdAtMs);
    const policyVersion = `${record.window_ms}:${record.paid_fallback_pricing_checked_at_ms ?? 0}`;
    const admitted = await admitPaidFallbackV3({
      ...input,
      policyVersion,
      policyCheck: policy.check,
      limitMicrocredits: record.paid_fallback_limit_microcredits,
      maximumExposureMicrocredits: record.paid_fallback_max_exposure_microcredits?.[input.model] ?? null,
      initialSettledMicrocredits: 0,
      quotaPerCredit: record.paid_fallback_quota_per_credit,
      windowResetAtMs,
      // Persist the billable-ambiguity boundary in the admission transaction.
      // Provider fetch must never begin from a row that still looks safely
      // undispatched.
      dispatchIntent: true,
    });
    if (admitted.kind === "reserved") return { kind: "reserved", reservation: admitted.reservation };
    if (await retryBlockedPaidFallbackAdmission(admitted.reason, attempt)) continue;
    return { kind: "blocked", reason: admitted.reason, reset_at_ms: windowResetAtMs };
  }
  return { kind: "blocked", reason: "concurrent_update", reset_at_ms: null };
};

export const recordMeteredUpstreamResponse = async (
  reservation: PaidFallbackReservation,
  _response: Response,
  providerRequestId: string | null,
  provider: PaidFallbackProvider = "metered"
): Promise<void> => {
  await updatePaidFallbackRequestV3(reservation, {
    provider,
    provider_request_id: providerRequestId,
    dispatch_state: "dispatched",
  });
};

/**
 * Settlement gets one best-effort sweep because a request reached a terminal
 * state, not because a minute passed. A missing provider log is deliberately
 * left to the next authorized event; no autonomous retry is armed here. Tests
 * replace the sweep so a background provider-log read cannot race their KV
 * budgets; `null` restores the real one.
 */
const defaultPaidFallbackTerminalSweep = (): void => {
  void reconcileDuePaidFallbacksV3().catch(() => {});
};

let paidFallbackTerminalSweep = defaultPaidFallbackTerminalSweep;

export const setPaidFallbackTerminalSweepForTest = (sweep: (() => void) | null): void => {
  paidFallbackTerminalSweep = sweep ?? defaultPaidFallbackTerminalSweep;
};

export const recordMeteredAmbiguousFailure = async (
  reservation: PaidFallbackReservation,
  provider: PaidFallbackProvider = "metered",
  providerRequestId: string | null = null
): Promise<void> => {
  await updatePaidFallbackRequestV3(reservation, {
    provider,
    provider_request_id: providerRequestId,
    dispatch_state: "dispatched",
  });
  await markPaidFallbackTerminalV3(reservation, "ambiguous");
  // A terminal event makes pending marks due and starts one best-effort sweep.
  // Fire-and-forget so provider-log reads never delay the response; deferred
  // work remains durable for a later event instead of using a periodic timer.
  paidFallbackTerminalSweep();
};

export const recordMeteredUndispatchedCancellation = async (reservation: PaidFallbackReservation): Promise<void> => {
  await releasePaidFallbackBeforeProviderFetchV3(reservation);
};

export const recordMeteredPrefetchCancellation = async (reservation: PaidFallbackReservation): Promise<void> => {
  await releasePaidFallbackBeforeProviderFetchV3(reservation);
};

export const recordMeteredTerminal = async (
  reservation: PaidFallbackReservation,
  terminalState: "completed" | "failed" | "incomplete" | "cancelled" | "ambiguous",
  provider: PaidFallbackProvider = "metered"
): Promise<void> => {
  await markPaidFallbackTerminalV3(reservation, terminalState, provider);
  // Same event-driven settlement as the ambiguous path: the request is over, so
  // make one non-blocking attempt at what its terminal state made due. Deferred
  // provider-log work remains durable and waits for another authorized event.
  paidFallbackTerminalSweep();
};

export type SurplusBillingPricing = Readonly<{
  input_price_per_token: number;
  output_price_per_token: number;
  cache_read_price_per_token?: number;
  cache_write_price_per_token?: number;
  /** Native Messages billing requires the original exact provider charge. */
  require_provider_cost?: true;
}>;

export type SurplusUsage = Readonly<{
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  output_tokens: number | null;
  /** Provider-reported exact charge, when present in the original usage. */
  buyer_cost_micro?: number | null;
}>;

/**
 * Surplus returns usage in the terminal Responses event instead of exposing a
 * provider token-log query. Its catalog prices are per token; convert that
 * charge into the existing paid-fallback quota unit before the shared ledger
 * settles the exact gateway reservation. The settlement key is internal and
 * is not recorded as an upstream provider request ID.
 */
export const recordSurplusUsage = async (
  reservation: PaidFallbackReservation,
  settlementRequestId: string,
  model: string,
  usage: SurplusUsage,
  pricing: SurplusBillingPricing
): Promise<void> => {
  if (!settlementRequestId.trim() || !model.trim() || !isNonNegativeSafeInteger(usage.input_tokens) || !isNonNegativeSafeInteger(usage.output_tokens)) return;
  // Absent cache counters settle as zero; non-null counts keep their exact value.
  const cachedInputTokens = usage.cached_input_tokens ?? 0;
  const cacheWriteInputTokens = usage.cache_write_input_tokens ?? 0;
  if (
    !isNonNegativeSafeInteger(cachedInputTokens) ||
    cachedInputTokens > usage.input_tokens ||
    !isNonNegativeSafeInteger(cacheWriteInputTokens) ||
    cacheWriteInputTokens > usage.input_tokens
  )
    return;
  const uncachedInputTokens = usage.input_tokens - cachedInputTokens;
  let buyerCostMicro: number | undefined;
  let chargedCredits: number;
  if (Object.prototype.hasOwnProperty.call(usage, "buyer_cost_micro")) {
    // A present malformed charge cannot become a catalog-price estimate.
    if (!isNonNegativeSafeInteger(usage.buyer_cost_micro)) return;
    buyerCostMicro = usage.buyer_cost_micro;
    chargedCredits = buyerCostMicro / MICROCREDITS_PER_CREDIT;
  } else {
    if (pricing.require_provider_cost) return;
    if (!isNonNegativeFiniteNumber(pricing.input_price_per_token) || !isNonNegativeFiniteNumber(pricing.output_price_per_token)) return;
    const cacheReadPrice = pricing.cache_read_price_per_token ?? pricing.input_price_per_token;
    const cacheWritePrice = pricing.cache_write_price_per_token ?? pricing.input_price_per_token;
    if (!isNonNegativeFiniteNumber(cacheReadPrice) || !isNonNegativeFiniteNumber(cacheWritePrice)) return;
    chargedCredits =
      uncachedInputTokens * pricing.input_price_per_token +
      cachedInputTokens * cacheReadPrice +
      cacheWriteInputTokens * cacheWritePrice +
      usage.output_tokens * pricing.output_price_per_token;
  }
  const providerQuota = Math.round(chargedCredits * reservation.quota_per_credit);
  if (!Number.isSafeInteger(providerQuota) || providerQuota < 0) return;
  await settlePaidFallbackUsageV3(reservation, {
    settlement_request_id: settlementRequestId,
    provider_quota: providerQuota,
    input_tokens: usage.input_tokens,
    cached_input_tokens: buyerCostMicro === undefined ? cachedInputTokens : usage.cached_input_tokens,
    output_tokens: usage.output_tokens,
    model,
    created_at_ms: Date.now(),
    ...(buyerCostMicro === undefined ? {} : { buyer_cost_micro: buyerCostMicro }),
  });
};
