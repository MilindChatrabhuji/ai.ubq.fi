// Paid-fallback admission, attempts and delivery, extracted from src/openai.ts.

import {
  CODEX_AUTH_REAUTH_WARNING,
  CODEX_QUOTA_BLOCKED_ERROR_CODE,
  CODEX_SUBSCRIPTIONS_UNAVAILABLE_ERROR_CODE,
  CODEX_UPSTREAM_DEGRADED_ERROR_CODE,
  CodexError,
  fetchCodexResponses,
  getCodexResponseAccountCohortId,
  getCodexResponseActiveTelemetry,
  getCodexResponseSlot,
  getCodexRoutingError,
} from "../codex/index.ts";
import { isProviderEnabled, loadProviderSelectionCached, type ProviderSelection } from "../provider/selection.ts";
import { ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { openaiError } from "../http.ts";
import { createPaidProviderAttemptDeadline } from "../inference-deadline.ts";
import {
  type PaidFallbackReservation,
  recordMeteredAmbiguousFailure,
  recordMeteredPrefetchCancellation,
  recordMeteredUndispatchedCancellation,
  recordMeteredUpstreamResponse,
  reservePaidFallback,
  type SurplusBillingPricing,
} from "./index.ts";
import { fetchMeteredModels, fetchMeteredResponses, METERED_MODELS_CACHE_TTL_MS, MeteredError } from "../provider/metered.ts";
import { fetchSurplusModels, fetchSurplusResponses, SURPLUS_MODELS_CACHE_TTL_MS, SurplusError } from "../provider/surplus.ts";
import { loadDebugRoutingConfig } from "../debug-routing.ts";
import {
  type InferenceFallbackReason,
  type PaidProviderHealthClassification,
  type ResponseTelemetryState,
  type RoutedResponsesUpstream,
  type UsageContext,
  recordAttemptedProvider,
  recordFirstCodexDispatch,
  recordFirstCodexHeaders,
  recordFirstProviderDispatch,
  recordFirstProviderHeaders,
} from "../openai-telemetry.ts";
import { cancelResponseBody, normalizeProviderRequestId, providerRequestIdFromResponse } from "../upstream-wire.ts";
import { isTemporaryFreeSurplusModel, responseWarnings } from "../request-policy.ts";
import { attemptClaudeCodeSubscription } from "./claude-code-route.ts";
import {
  bestEffortPaidFallbackBookkeeping,
  codexCacheScopeForUsageContext,
  fetchTemporaryFreeSurplusRoutedResponses,
  forcedDebugCodexStatus,
  isIntermediatePaidProviderAttempt,
  loadPaidResponsesCatalogs,
  logPaidProviderSelected,
  meteredForbiddenIndicatesQuotaExhaustion,
  surplus402IndicatesQuotaExhaustion,
  paidCatalogNeedsRefresh,
  paidFallbackAbortReason,
  paidProviderErrorStatus,
  paidProviderHealthClassification,
  recordPaidProviderResponseHealth,
  refreshPaidCatalogs,
  refreshStalePaidCatalogsInBackground,
  rejectDisabledCodexProvider,
  rejectPaidAdmission,
  rejectUnroutablePaidModel,
  resolvePaidRoutingState,
  warnPaidFallbackBookkeepingFailure,
} from "./health.ts";
import { codexBankedResetOptionsForTest } from "../openai.ts";

const dispatchCodexPrimaryResponse = async (
  body: Record<string, unknown>,
  options: Readonly<{ model: string; usageContext?: UsageContext; clientVersion?: string | null; signal?: AbortSignal }>,
  directPaidPrimary: Response | null
): Promise<Response> => {
  const debugScenario = (await loadDebugRoutingConfig()).scenario;
  const forcedStatus = forcedDebugCodexStatus(debugScenario);
  if (directPaidPrimary) return directPaidPrimary;
  if (forcedStatus !== null) {
    return openaiError(forcedStatus, `Debug routing scenario forced Codex ${forcedStatus}.`, forcedStatus === 429 ? "rate_limit_error" : "debug_forced_codex", {
      headers: { "x-uos-upstream": "chatgpt_codex", "x-uos-debug-scenario": debugScenario },
    });
  }
  try {
    return await fetchCodexResponses(body, {
      clientVersion: options.clientVersion,
      cacheScope: codexCacheScopeForUsageContext(options.usageContext),
      signal: options.signal,
      requestId: options.usageContext?.requestId,
      // Keep terminal telemetry bounded: only the first real Codex transport
      // attempt contributes dispatch/header timings, even when routing retries.
      timing: {
        onDispatch: () => {
          recordFirstCodexDispatch(options.usageContext);
        },
        onHeaders: () => {
          recordFirstCodexHeaders(options.usageContext);
        },
      },
      beforeDispatch: () => options.usageContext?.beforeProviderDispatch?.("chatgpt_codex") ?? Promise.resolve(undefined),
      bankedReset: codexBankedResetOptionsForTest ?? undefined,
      sentinelUpstreamRecorder: options.usageContext?.sentinelUpstreamRecorder,
    });
  } catch (error) {
    if (!(error instanceof CodexError) || error.status !== 401) throw error;
    return openaiError(error.status, error.message, error.code);
  }
};

const recordCodexPrimaryTelemetry = async (primary: Response, telemetry: ResponseTelemetryState | undefined): Promise<void> => {
  if (!telemetry) return;
  telemetry.accountSlot = getCodexResponseSlot(primary);
  telemetry.accountCohortId = await getCodexResponseAccountCohortId(primary);
  const active = getCodexResponseActiveTelemetry(primary);
  telemetry.activeGeneration = active.activeGeneration;
  telemetry.activeTransitionReason = active.activeTransitionReason;
  telemetry.providerRequestId = providerRequestIdFromResponse(primary);
};

/**
 * The paid provider a request dispatches to as its primary. A model outside the
 * Codex roster has always taken that path; a disabled Codex provider takes it
 * because there is no subscription attempt left to make first.
 */
const directPaidProviderFor = (
  routing: Readonly<{ meteredOnly: boolean; codexEnabled: boolean; paidProviders: readonly ("metered" | "surplus")[] }>
): "metered" | "surplus" | null => (routing.meteredOnly || !routing.codexEnabled ? (routing.paidProviders[0] ?? null) : null);

const resolveDirectPaidPrimary = (
  routing: Readonly<{ meteredOnly: boolean; codexEnabled: boolean; paidProviders: readonly ("metered" | "surplus")[] }>,
  telemetry: ResponseTelemetryState | undefined,
  usageContext: UsageContext | undefined
) => {
  const directPaidProvider = directPaidProviderFor(routing);
  const directPaidPrimary = directPaidProvider
    ? openaiError(503, "Paid-provider routing did not reach the selected upstream.", "paid_provider_not_dispatched", { type: "server_error" })
    : null;
  if (telemetry) telemetry.provider = directPaidProvider ?? "chatgpt_codex";
  if (!directPaidProvider) recordAttemptedProvider(usageContext, "chatgpt_codex");
  return { directPaidProvider, directPaidPrimary };
};

const paidFallbackReasonFor = (
  directPaidProvider: "metered" | "surplus" | null,
  primaryStatus: number,
  routingError: string | null
): InferenceFallbackReason | null => {
  if (directPaidProvider) return "dynamic_paid_model";
  if (primaryStatus === 429 && routingError === CODEX_QUOTA_BLOCKED_ERROR_CODE) return "primary_quota_blocked";
  if ((primaryStatus === 401 || primaryStatus === 503) && routingError === CODEX_SUBSCRIPTIONS_UNAVAILABLE_ERROR_CODE)
    return "primary_subscriptions_unavailable";
  return null;
};

const isGatewaySubscriptionsUnavailable = (status: number, routingError: string | null): boolean =>
  routingError === CODEX_SUBSCRIPTIONS_UNAVAILABLE_ERROR_CODE && status !== 401;

const resolvePaidFallbackAdmission = (
  routing: Readonly<{ meteredOnly: boolean; codexEnabled: boolean; paidProviders: readonly ("metered" | "surplus")[] }>,
  primary: Response,
  primaryStatus: number,
  routingError: string | null,
  usageContext: UsageContext | undefined,
  telemetry: ResponseTelemetryState | undefined,
  gatewayResponse: boolean,
  model: string
):
  | Readonly<{ kind: "rejected"; routed: RoutedResponsesUpstream }>
  | Readonly<{
      kind: "admitted";
      fallbackReason: InferenceFallbackReason;
      keyId: string;
      requestId: string;
      createdAtMs: number;
      rejectAdmission: (errorReason: string, logReason?: string) => RoutedResponsesUpstream;
    }> => {
  const directPaidProvider = directPaidProviderFor(routing);
  const keyId = usageContext?.keyId;
  const requestId = usageContext?.requestId;
  const createdAtMs = usageContext?.startedAtMs;
  // Only a complete, authoritative Codex pool classification may admit paid
  // fallback. Generic 429s and transient failures remain request-local.
  const fallbackReason = paidFallbackReasonFor(directPaidProvider, primaryStatus, routingError);
  if (telemetry) telemetry.fallbackReason = fallbackReason;
  if (directPaidProvider && usageContext?.paidFallbackEnabled === false) {
    return { kind: "rejected", routed: rejectPaidAdmission(directPaidProvider, "disabled", telemetry, usageContext, model) };
  }
  if (!fallbackReason || usageContext?.paidFallbackEnabled === false || !keyId || !requestId || createdAtMs === undefined) {
    if (directPaidProvider) {
      return { kind: "rejected", routed: rejectPaidAdmission(directPaidProvider, "invalid_policy", telemetry, usageContext, model, "invalid_context") };
    }
    return {
      kind: "rejected",
      routed: { response: primary, provider: "chatgpt_codex", paidFallback: null, gatewayResponse, fallbackReason },
    };
  }
  const rejectAdmission = (errorReason: string, logReason = errorReason): RoutedResponsesUpstream =>
    directPaidProvider
      ? rejectPaidAdmission(directPaidProvider, errorReason, telemetry, usageContext, model, logReason)
      : { response: primary, provider: "chatgpt_codex", paidFallback: null, gatewayResponse, fallbackReason };
  return { kind: "admitted", fallbackReason, keyId, requestId, createdAtMs, rejectAdmission };
};

const replenishPaidFallbackCatalogs = async (
  meteredCatalog: Awaited<ReturnType<typeof fetchMeteredModels>>,
  surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>,
  routing: Readonly<{
    surplusBilling: SurplusBillingPricing | null;
    paidProviders: readonly ("metered" | "surplus")[];
    paidModelKnown: boolean;
    meteredOnly: boolean;
    codexEnabled: boolean;
  }>,
  routingInput: Readonly<{
    codexModelKnown: boolean;
    endpointType: string;
    requestUsesTools: boolean;
    model: string;
    selection: ProviderSelection | null;
    allowedPaidProviders?: readonly ("metered" | "surplus")[] | null;
    deepSeekWaterfallPaidHop?: "surplus" | "openlux" | null;
  }>,
  fallbackSignal: AbortSignal | undefined
): Promise<
  Readonly<{
    meteredCatalog: Awaited<ReturnType<typeof fetchMeteredModels>>;
    surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>;
    routing: Readonly<{
      surplusBilling: SurplusBillingPricing | null;
      paidProviders: readonly ("metered" | "surplus")[];
      paidModelKnown: boolean;
      meteredOnly: boolean;
      codexEnabled: boolean;
    }>;
  }>
> => {
  // A stale snapshot remains usable when it already selects a paid provider.
  // Missing catalogs must still be discovered before trusting that historical
  // provider path; otherwise Surplus-preferred models can bypass discovery.
  // When no provider is selectable, also re-discover expired catalogs so a
  // newly published model can still recover this request.
  if (
    meteredCatalog !== null &&
    surplusCatalog !== null &&
    (routing.paidProviders.length > 0 ||
      (!paidCatalogNeedsRefresh(meteredCatalog, METERED_MODELS_CACHE_TTL_MS) && !paidCatalogNeedsRefresh(surplusCatalog, SURPLUS_MODELS_CACHE_TTL_MS)))
  ) {
    if (routing.paidProviders.length) refreshStalePaidCatalogsInBackground(meteredCatalog, surplusCatalog);
    return { meteredCatalog, surplusCatalog, routing };
  }
  const [nextMeteredCatalog, nextSurplusCatalog] = await refreshPaidCatalogs(meteredCatalog, surplusCatalog, fallbackSignal);
  const nextRouting = resolvePaidRoutingState({
    meteredCatalog: nextMeteredCatalog,
    surplusCatalog: nextSurplusCatalog,
    codexModelKnown: routingInput.codexModelKnown,
    endpointType: routingInput.endpointType,
    requestUsesTools: routingInput.requestUsesTools,
    model: routingInput.model,
    selection: routingInput.selection,
    allowedPaidProviders: routingInput.allowedPaidProviders ?? null,
    deepSeekWaterfallPaidHop: routingInput.deepSeekWaterfallPaidHop ?? null,
  });
  if (nextRouting.paidProviders.length) refreshStalePaidCatalogsInBackground(nextMeteredCatalog, nextSurplusCatalog);
  return { meteredCatalog: nextMeteredCatalog, surplusCatalog: nextSurplusCatalog, routing: nextRouting };
};

const cancelPaidFallbackPrefetchBeforeTransport = async (
  fallbackSignal: AbortSignal | undefined,
  primary: Response,
  reservation: PaidFallbackReservation
): Promise<void> => {
  if (fallbackSignal?.aborted) {
    cancelResponseBody(primary);
    await bestEffortPaidFallbackBookkeeping("prefetch cancellation recording", () => recordMeteredPrefetchCancellation(reservation));
    throw paidFallbackAbortReason(fallbackSignal);
  }
  cancelResponseBody(primary);
  if (fallbackSignal?.aborted) {
    await bestEffortPaidFallbackBookkeeping("prefetch cancellation recording", () => recordMeteredPrefetchCancellation(reservation));
    throw paidFallbackAbortReason(fallbackSignal);
  }
};

const reservePaidFallbackForRequest = async (
  reservationInput: Parameters<typeof reservePaidFallback>[0],
  rejectAdmission: (errorReason: string, logReason?: string) => RoutedResponsesUpstream
): Promise<Readonly<{ kind: "reserved"; reservation: PaidFallbackReservation }> | Readonly<{ kind: "final"; routed: RoutedResponsesUpstream }>> => {
  let decision: Awaited<ReturnType<typeof reservePaidFallback>>;
  try {
    decision = await reservePaidFallback(reservationInput);
  } catch (error) {
    warnPaidFallbackBookkeepingFailure("admission", error);
    return { kind: "final", routed: rejectAdmission("invalid_policy", "admission_error") };
  }
  if (decision.kind === "skip" || decision.kind === "blocked") {
    return { kind: "final", routed: rejectAdmission(decision.reason) };
  }
  return { kind: "reserved", reservation: decision.reservation };
};

const recordPaidFallbackProviderTransition = async (
  reservation: PaidFallbackReservation,
  responding: Readonly<{ provider: "metered" | "surplus"; requestId: string | null }> | null,
  recordUndispatched: (reservation: PaidFallbackReservation) => Promise<void>,
  labels: Readonly<{ undispatched: string; ambiguous: string }>
): Promise<void> => {
  if (responding === null) {
    await bestEffortPaidFallbackBookkeeping(labels.undispatched, () => recordUndispatched(reservation));
    return;
  }
  await bestEffortPaidFallbackBookkeeping(labels.ambiguous, () => recordMeteredAmbiguousFailure(reservation, responding.provider, responding.requestId));
};

const retainRespondingProviderTelemetry = (
  telemetry: ResponseTelemetryState | undefined,
  responding: Readonly<{ provider: "metered" | "surplus"; requestId: string | null }> | null
): void => {
  if (!telemetry || responding === null) return;
  telemetry.provider = responding.provider;
  telemetry.providerRequestId = responding.requestId;
};

const abortInterProviderAttempts = async (
  fallbackSignal: AbortSignal,
  reservation: PaidFallbackReservation,
  responding: Readonly<{ provider: "metered" | "surplus"; requestId: string | null }> | null,
  telemetry: ResponseTelemetryState | undefined
): Promise<never> => {
  retainRespondingProviderTelemetry(telemetry, responding);
  await recordPaidFallbackProviderTransition(reservation, responding, recordMeteredPrefetchCancellation, {
    undispatched: "prefetch cancellation recording",
    ambiguous: "inter-provider cancellation ambiguity recording",
  });
  throw paidFallbackAbortReason(fallbackSignal);
};

const resolvePaidProviderAttemptFailure = async (
  error: unknown,
  provider: "metered" | "surplus",
  providerIndex: number,
  paidProviders: readonly ("metered" | "surplus")[],
  dispatchState: { transportStarted: boolean },
  responding: Readonly<{ provider: "metered" | "surplus"; requestId: string | null }> | null,
  reservation: PaidFallbackReservation,
  fallbackSignal: AbortSignal | undefined,
  telemetry: ResponseTelemetryState | undefined
): Promise<
  Readonly<{
    retry: boolean;
    providerError: unknown;
    responding: Readonly<{ provider: "metered" | "surplus"; requestId: string | null }> | null;
  }>
> => {
  if (error instanceof ApiKeyQuotaDispatchError) {
    // Paid fallback writes a durable dispatch intent before provider
    // transport. A quota CAS rejection proves this provider was not
    // started, but an earlier provider in the same reservation may have
    // been contacted already.
    retainRespondingProviderTelemetry(telemetry, responding);
    await recordPaidFallbackProviderTransition(reservation, responding, recordMeteredUndispatchedCancellation, {
      undispatched: "pre-dispatch quota cancellation recording",
      ambiguous: "prior-provider quota rejection ambiguity recording",
    });
    throw error;
  }
  if (fallbackSignal?.aborted) {
    // The explicit dispatch callback distinguishes cancellation before
    // this transport from an abort that may have reached the provider.
    // Keep any contacted provider for reconciliation and never retry.
    const ambiguous = dispatchState.transportStarted ? { provider, requestId: null } : responding;
    retainRespondingProviderTelemetry(telemetry, ambiguous);
    await recordPaidFallbackProviderTransition(reservation, ambiguous, recordMeteredUndispatchedCancellation, {
      undispatched: "pre-transport cancellation recording",
      ambiguous: "aborted transport ambiguity recording",
    });
    throw paidFallbackAbortReason(fallbackSignal);
  }
  const status = paidProviderErrorStatus(error);
  await recordPaidProviderResponseHealth(provider, status);
  // A failed attempt never settles the shared reservation on its own: the
  // ledger keeps exactly one terminal provider/request-id pair, written for the
  // delivered provider (or for the last responder when every tier fails). An
  // attempt that already reached transport may still be billable, so it is
  // retained as the responder instead of being marked terminal here; a failure
  // before transport keeps the previously retained responder.
  const attempted = dispatchState.transportStarted ? ({ provider, requestId: null } as const) : null;
  // An attempt that reached transport is an ambiguous, potentially billable
  // exposure. Retrying after it would let a later tier's success settle the
  // shared reservation and release this exposure's spend cap, so only a
  // provably undispatched attempt may fall through, and the classification
  // admits only an authoritative upstream capacity signal.
  return {
    retry: attempted === null && isIntermediatePaidProviderAttempt(providerIndex, paidProviders.length, status),
    providerError: error,
    responding: attempted ?? responding,
  };
};

const failedPaidProviderAttempts = async (
  providerError: unknown,
  selectedProvider: "metered" | "surplus",
  reservation: PaidFallbackReservation,
  responding: Readonly<{ provider: "metered" | "surplus"; requestId: string | null }> | null
): Promise<Readonly<{ kind: "failed"; providerError: unknown; selectedProvider: "metered" | "surplus" }>> => {
  if (providerError instanceof ApiKeyQuotaDispatchError) {
    throw providerError;
  }
  await recordPaidFallbackProviderTransition(reservation, responding, recordMeteredUndispatchedCancellation, {
    undispatched: "undispatched failure recording",
    ambiguous: "ambiguous failure recording",
  });
  return { kind: "failed", providerError, selectedProvider };
};

const fetchPaidProviderResponses = async (
  body: Record<string, unknown>,
  options: Readonly<{ model: string; usageContext?: UsageContext }>,
  fallbackSignal: AbortSignal | undefined,
  provider: "metered" | "surplus",
  surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>,
  dispatchState: { transportStarted: boolean }
): Promise<Awaited<ReturnType<typeof fetchMeteredResponses>> | Awaited<ReturnType<typeof fetchSurplusResponses>>> => {
  if (provider === "surplus") {
    return await fetchSurplusResponses(body, {
      signal: fallbackSignal,
      reasoningReplayScope: codexCacheScopeForUsageContext(options.usageContext),
      supportsParallelToolCalls: surplusCatalog?.models.find((entry) => entry.id === options.model)?.supports_parallel_tool_calls === true,
      beforeDispatch: () => options.usageContext?.beforeProviderDispatch?.("surplus") ?? Promise.resolve(undefined),
      onDispatch: () => {
        dispatchState.transportStarted = true;
        recordFirstProviderDispatch(options.usageContext);
      },
      sentinelUpstreamRecorder: options.usageContext?.sentinelUpstreamRecorder,
    });
  }
  return await fetchMeteredResponses(body, {
    signal: fallbackSignal,
    reasoningReplayScope: codexCacheScopeForUsageContext(options.usageContext),
    beforeDispatch: () => options.usageContext?.beforeProviderDispatch?.("metered") ?? Promise.resolve(undefined),
    onDispatch: () => {
      dispatchState.transportStarted = true;
      recordFirstProviderDispatch(options.usageContext);
    },
    sentinelUpstreamRecorder: options.usageContext?.sentinelUpstreamRecorder,
  });
};

type PaidProviderAttemptResult = Readonly<{
  candidate: Awaited<ReturnType<typeof fetchMeteredResponses>> | Awaited<ReturnType<typeof fetchSurplusResponses>>;
  classification: PaidProviderHealthClassification | null;
}>;

/**
 * Runs one paid-tier transport under its own bounded first-headers deadline and
 * classifies the outcome. The deadline fails a stalled tier closed at a bounded
 * first-headers budget instead of holding the shared 30-minute stream deadline;
 * it never turns a stall into a signal that advances the waterfall. Its timer is
 * cleared as soon as transport returns headers, before awaited bookkeeping, so
 * a delivered response body is never tied to it.
 */
const runSinglePaidProviderAttempt = async (
  body: Record<string, unknown>,
  options: Readonly<{ model: string; usageContext?: UsageContext }>,
  fallbackSignal: AbortSignal | undefined,
  provider: "metered" | "surplus",
  surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>,
  dispatchState: { transportStarted: boolean }
): Promise<PaidProviderAttemptResult> => {
  const attemptDeadline = createPaidProviderAttemptDeadline(fallbackSignal);
  try {
    const candidate = await fetchPaidProviderResponses(body, options, attemptDeadline.signal, provider, surplusCatalog, dispatchState);
    attemptDeadline.clear();
    recordFirstProviderHeaders(options.usageContext);
    const meteredQuotaExhausted = provider === "metered" ? await meteredForbiddenIndicatesQuotaExhaustion(candidate.response, fallbackSignal) : false;
    const surplusQuotaExhausted = provider === "surplus" ? await surplus402IndicatesQuotaExhaustion(candidate.response, fallbackSignal) : false;
    const classification = paidProviderHealthClassification(provider, candidate.response.status, meteredQuotaExhausted, surplusQuotaExhausted);
    await recordPaidProviderResponseHealth(provider, candidate.response.status, candidate.request_id, meteredQuotaExhausted, surplusQuotaExhausted);
    return { candidate, classification };
  } finally {
    attemptDeadline.clear();
  }
};

/**
 * Preserves a delivered provider-specific error signal (quota exhaustion, auth
 * invalidity, upstream fault) across the terminal transport record. A bare
 * "reachable" classification stays out of it: a failed request must not be
 * reported as a reachability observation.
 */
const deliveredPaidProviderErrorHealth = (
  candidate: PaidProviderAttemptResult["candidate"],
  classification: PaidProviderHealthClassification | null
): PaidProviderHealthClassification | null => {
  if (candidate.response.ok || !classification) return null;
  return classification.event === "reachable" ? null : classification;
};

const selectPaidProviderAttemptTelemetry = (
  provider: "metered" | "surplus",
  telemetry: ResponseTelemetryState | undefined,
  usageContext: UsageContext | undefined
): void => {
  if (telemetry) {
    telemetry.provider = provider;
    telemetry.providerRequestId = null;
  }
  recordAttemptedProvider(usageContext, provider);
};

const runPaidProviderAttempts = async (
  body: Record<string, unknown>,
  options: Readonly<{ model: string; usageContext?: UsageContext }>,
  fallbackSignal: AbortSignal | undefined,
  telemetry: ResponseTelemetryState | undefined,
  reservation: PaidFallbackReservation,
  paidProviders: readonly ("metered" | "surplus")[],
  surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>
): Promise<
  | Readonly<{
      kind: "delivered";
      result: Awaited<ReturnType<typeof fetchMeteredResponses>> | Awaited<ReturnType<typeof fetchSurplusResponses>>;
      selectedProvider: "metered" | "surplus";
      errorHealth: PaidProviderHealthClassification | null;
    }>
  | Readonly<{ kind: "failed"; providerError: unknown; selectedProvider: "metered" | "surplus" }>
> => {
  let result: Awaited<ReturnType<typeof fetchMeteredResponses>> | Awaited<ReturnType<typeof fetchSurplusResponses>> | null = null;
  let selectedProvider: "metered" | "surplus" = paidProviders[0];
  let providerError: unknown = null;
  let responding: Readonly<{ provider: "metered" | "surplus"; requestId: string | null }> | null = null;
  let deliveredErrorHealth: PaidProviderHealthClassification | null = null;
  for (const [providerIndex, provider] of paidProviders.entries()) {
    if (fallbackSignal?.aborted) {
      await abortInterProviderAttempts(fallbackSignal, reservation, responding, telemetry);
    }
    selectedProvider = provider;
    selectPaidProviderAttemptTelemetry(provider, telemetry, options.usageContext);
    const dispatchState = { transportStarted: false };
    try {
      const attempt = await runSinglePaidProviderAttempt(body, options, fallbackSignal, provider, surplusCatalog, dispatchState);
      if (isIntermediatePaidProviderAttempt(providerIndex, paidProviders.length, attempt.candidate.response.status)) {
        // Keep the reservation uncommitted until the provider that will be
        // delivered to the client is known. The paid-fallback ledger has one
        // terminal provider/request-id pair; recording this intermediate
        // attempt would pin reconciliation to the failed provider and leave a
        // later successful provider unbillable. An authoritative capacity
        // refusal is still retained as the responder so a request that ends in
        // failure settles as exactly one terminal provider pair.
        responding = { provider, requestId: normalizeProviderRequestId(attempt.candidate.request_id) };
        cancelResponseBody(attempt.candidate.response);
        continue;
      }
      result = attempt.candidate;
      deliveredErrorHealth = deliveredPaidProviderErrorHealth(attempt.candidate, attempt.classification);
      break;
    } catch (error) {
      const failure = await resolvePaidProviderAttemptFailure(
        error,
        provider,
        providerIndex,
        paidProviders,
        dispatchState,
        responding,
        reservation,
        fallbackSignal,
        telemetry
      );
      providerError = failure.providerError;
      responding = failure.responding;
      if (!failure.retry) break;
    }
  }
  if (!result) return await failedPaidProviderAttempts(providerError, selectedProvider, reservation, responding);
  return { kind: "delivered", result, selectedProvider, errorHealth: deliveredErrorHealth };
};

const paidProviderFailureResponse = (
  attempts: Readonly<{ providerError: unknown; selectedProvider: "metered" | "surplus" }>,
  reservation: PaidFallbackReservation,
  fallbackSignal: AbortSignal | undefined,
  fallbackReason: InferenceFallbackReason
): RoutedResponsesUpstream => {
  const error = attempts.providerError;
  const selectedProviderLabel = attempts.selectedProvider === "surplus" ? "Surplus" : "Metered";
  const abortReason = fallbackSignal?.reason;
  if (
    (fallbackSignal?.aborted && abortReason instanceof Error && abortReason.name === "TimeoutError") ||
    (error instanceof Error && error.name === "TimeoutError")
  ) {
    return {
      response: openaiError(504, `${selectedProviderLabel} upstream exceeded the gateway deadline before response headers were received.`, "gateway_timeout", {
        type: "server_error",
        headers: { "x-uos-upstream": attempts.selectedProvider },
      }),
      provider: attempts.selectedProvider,
      paidFallback: reservation,
      gatewayResponse: true,
      fallbackReason,
    };
  }
  if (error instanceof MeteredError || error instanceof SurplusError) {
    return {
      response: openaiError(error.status, error.message, error.code, {
        type: "server_error",
        headers: { "x-uos-upstream": attempts.selectedProvider },
      }),
      provider: attempts.selectedProvider,
      paidFallback: reservation,
      gatewayResponse: true,
      fallbackReason,
    };
  }
  return {
    response: openaiError(502, `${selectedProviderLabel} upstream request failed before response headers were received.`, "upstream_error", {
      type: "server_error",
      headers: { "x-uos-upstream": attempts.selectedProvider },
    }),
    provider: attempts.selectedProvider,
    paidFallback: reservation,
    gatewayResponse: true,
    fallbackReason,
  };
};

const deliverPaidProviderResponse = async (
  attempts: Readonly<{
    result: Awaited<ReturnType<typeof fetchMeteredResponses>> | Awaited<ReturnType<typeof fetchSurplusResponses>>;
    selectedProvider: "metered" | "surplus";
    errorHealth: PaidProviderHealthClassification | null;
  }>,
  reservation: PaidFallbackReservation,
  telemetry: ResponseTelemetryState | undefined,
  surplusBilling: SurplusBillingPricing | null,
  fallbackReason: InferenceFallbackReason
): Promise<RoutedResponsesUpstream> => {
  const providerRequestId = normalizeProviderRequestId(attempts.result.request_id);
  if (telemetry) {
    telemetry.providerRequestId = providerRequestId;
    if ("prompt_cache_mode" in attempts.result && attempts.result.prompt_cache_mode !== undefined) {
      telemetry.promptCacheMode = attempts.result.prompt_cache_mode;
    }
    if ("explicit_breakpoint_count" in attempts.result && attempts.result.explicit_breakpoint_count !== undefined) {
      telemetry.explicitBreakpointCount = attempts.result.explicit_breakpoint_count;
    }
  }
  await bestEffortPaidFallbackBookkeeping("upstream response recording", () =>
    recordMeteredUpstreamResponse(reservation, attempts.result.response, providerRequestId, attempts.selectedProvider)
  );
  let paidFallbackBilling = attempts.selectedProvider === "surplus" ? surplusBilling : null;
  if (paidFallbackBilling && "prompt_cache_mode" in attempts.result) {
    // Claude's cache-aware adapters require the exact provider charge rather
    // than projecting native cache accounting through legacy Responses prices.
    paidFallbackBilling = { ...paidFallbackBilling, require_provider_cost: true };
  }
  return {
    response: attempts.result.response,
    provider: attempts.selectedProvider,
    paidFallback: reservation,
    paidFallbackBilling,
    paidFallbackProviderRequestId: providerRequestId,
    ...(attempts.errorHealth ? { paidFallbackErrorHealth: attempts.errorHealth } : {}),
    gatewayResponse: false,
    fallbackReason,
  };
};

export const fetchResponsesWithPaidFallback = async (
  body: Record<string, unknown>,
  options: Readonly<{
    model: string;
    route: "chat.completions" | "responses";
    stream: boolean;
    reasoning: string | null;
    usageContext?: UsageContext;
    clientVersion?: string | null;
    signal?: AbortSignal;
    fallbackSignal?: AbortSignal;
    /**
     * Request-scoped narrowing for the DeepSeek waterfall's Surplus hop: only
     * the named paid tiers may be selected, preserving admission, reservation
     * and ledger settlement. Null or absent keeps the fixed cost order.
     */
    allowedPaidProviders?: readonly ("metered" | "surplus")[] | null;
    deepSeekWaterfallPaidHop?: "surplus" | "openlux" | null;
  }>
): Promise<RoutedResponsesUpstream> => {
  const fallbackSignal = options.fallbackSignal ?? options.signal;
  const telemetry = options.usageContext?.responseTelemetry;
  // The operator's provider selection is read once per request and reused by
  // every routing decision below, including the paid catalog resolution.
  const selection = await loadProviderSelectionCached();
  // The temporary free model is a Surplus route, so switching Surplus off takes
  // it out of that route and leaves the ordinary waterfall to decide.
  if (isTemporaryFreeSurplusModel(options.model) && isProviderEnabled("surplus", selection)) {
    return fetchTemporaryFreeSurplusRoutedResponses(body, options);
  }
  // The owner-gated Claude Code subscription hop runs before the paid route
  // for Claude models. A null result means "not eligible" or "failed"; the
  // request then continues through the unchanged paid waterfall below.
  const subscription = await attemptClaudeCodeSubscription(body, { model: options.model, signal: options.signal, usageContext: options.usageContext });
  if (subscription) return subscription;
  const catalogs = await loadPaidResponsesCatalogs(body, options, selection);
  const { codexModelKnown, endpointType, requestUsesTools } = catalogs;
  const meteredCatalog = catalogs.meteredCatalog;
  let surplusCatalog = catalogs.surplusCatalog;
  let routing = catalogs.routing;
  const unroutableModel = rejectUnroutablePaidModel(
    codexModelKnown,
    routing,
    surplusCatalog,
    endpointType,
    requestUsesTools,
    options.usageContext,
    options.model,
    telemetry
  );
  if (unroutableModel) return unroutableModel;
  const { directPaidProvider, directPaidPrimary } = resolveDirectPaidPrimary(routing, telemetry, options.usageContext);
  // A disabled Codex provider with no enabled paid provider must never fall back
  // to Codex itself, so this is a terminal gateway error rather than a dispatch.
  if (!routing.codexEnabled && !directPaidProvider) return rejectDisabledCodexProvider(options.model, telemetry, options.usageContext);
  let primary = await dispatchCodexPrimaryResponse(body, options, directPaidPrimary);
  const primaryStatus = primary.status;
  const authReauthenticationPrimary = primaryStatus === 401 && responseWarnings(primary).includes(CODEX_AUTH_REAUTH_WARNING);
  await recordCodexPrimaryTelemetry(primary, telemetry);
  const routingError = getCodexRoutingError(primary);
  const gatewayResponse =
    directPaidProvider !== null ||
    routingError === CODEX_QUOTA_BLOCKED_ERROR_CODE ||
    isGatewaySubscriptionsUnavailable(primaryStatus, routingError) ||
    routingError === CODEX_UPSTREAM_DEGRADED_ERROR_CODE;
  if (authReauthenticationPrimary) {
    primary = new Response(primary.body, {
      status: 503,
      statusText: primary.statusText,
      headers: primary.headers,
    });
  }
  const admission = resolvePaidFallbackAdmission(
    routing,
    primary,
    primaryStatus,
    routingError,
    options.usageContext,
    telemetry,
    gatewayResponse,
    options.model
  );
  if (admission.kind === "rejected") return admission.routed;
  const { fallbackReason, keyId, requestId, createdAtMs } = admission;
  if (fallbackSignal?.aborted) {
    cancelResponseBody(primary);
    throw paidFallbackAbortReason(fallbackSignal);
  }
  const replenished = await replenishPaidFallbackCatalogs(
    meteredCatalog,
    surplusCatalog,
    routing,
    {
      codexModelKnown,
      endpointType,
      requestUsesTools,
      model: options.model,
      selection: catalogs.selection,
      allowedPaidProviders: options.allowedPaidProviders ?? null,
      deepSeekWaterfallPaidHop: options.deepSeekWaterfallPaidHop ?? null,
    },
    fallbackSignal
  );
  surplusCatalog = replenished.surplusCatalog;
  routing = replenished.routing;
  if (!routing.paidProviders.length) {
    return {
      response: primary,
      provider: "chatgpt_codex",
      paidFallback: null,
      gatewayResponse,
      fallbackReason,
    };
  }

  const reservationInput = {
    keyId,
    requestId: options.usageContext?.paidFallbackRequestId ?? requestId,
    createdAtMs,
    model: options.model,
    route: options.route,
    path: options.route === "responses" ? "/v1/responses" : "/v1/chat/completions",
    stream: options.stream,
    reasoning: options.reasoning,
    allowUnrosteredModel: routing.meteredOnly,
    reason: fallbackReason,
  } as const;
  const reserved = await reservePaidFallbackForRequest(reservationInput, admission.rejectAdmission);
  if (reserved.kind === "final") return reserved.routed;
  const reservation = reserved.reservation;

  await cancelPaidFallbackPrefetchBeforeTransport(fallbackSignal, primary, reservation);
  if (telemetry) {
    telemetry.provider = routing.paidProviders[0];
    telemetry.accountSlot = null;
    telemetry.accountCohortId = null;
    telemetry.activeGeneration = null;
    telemetry.activeTransitionReason = null;
    telemetry.providerRequestId = null;
    telemetry.quotaUsedPercent = reservation.quota_used_percent;
  }
  logPaidProviderSelected(requestId, fallbackReason, routing.paidProviders[0]);
  const attempts = await runPaidProviderAttempts(body, options, fallbackSignal, telemetry, reservation, routing.paidProviders, surplusCatalog);
  if (attempts.kind === "failed") return paidProviderFailureResponse(attempts, reservation, fallbackSignal, fallbackReason);
  return deliverPaidProviderResponse(attempts, reservation, telemetry, routing.surplusBilling, fallbackReason);
};
