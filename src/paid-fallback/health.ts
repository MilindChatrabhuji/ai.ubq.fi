// Paid-fallback health, catalogs and routing state, extracted from src/openai.ts.

import { loadCodexModelsSnapshot } from "../codex/index.ts";
import { isProviderEnabled, type ProviderSelection } from "../provider/selection.ts";
import { ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { openaiError } from "../http.ts";
import { type PaidFallbackReservation, recordMeteredAmbiguousFailure, recordMeteredTerminal, recordSurplusUsage, type SurplusBillingPricing } from "./index.ts";
import { recordMeteredProviderHealth, recordSurplusProviderHealth } from "../provider/health.ts";
import { getString, isRecord } from "../utils.ts";
import { fetchMeteredModels, METERED_MODELS_CACHE_TTL_MS, MeteredError, readMeteredApiKey } from "../provider/metered.ts";
import { fetchSurplusModels, fetchSurplusResponses, readSurplusApiKey, SURPLUS_MODELS_CACHE_TTL_MS, SurplusError } from "../provider/surplus.ts";
import {
  type InferenceFallbackReason,
  type PaidProviderHealthClassification,
  type PaidProviderHealthEvent,
  type ResponseTelemetryState,
  type RoutedResponsesUpstream,
  type UpstreamProvider,
  type UsageContext,
  type UsageTokens,
  isTimeoutFailure,
  recordAttemptedProvider,
  recordFirstProviderDispatch,
  recordFirstProviderHeaders,
  type MeteredTransportLifecycle,
} from "../openai-telemetry.ts";
import { normalizeProviderRequestId } from "../upstream-wire.ts";
import { isAdditionalTrustedCodexModel } from "../request-policy.ts";
import { DEEPSEEK_WATERFALL_PAID_MODEL_ID } from "../deepseek/waterfall.ts";

export const warnPaidFallbackBookkeepingFailure = (operation: string, error: unknown): void => {
  console.warn(`[ai.ubq.fi] Paid fallback ${operation} failed; leaving the reservation pending:`, error instanceof Error ? error.message : String(error));
};

export const logPaidProviderSelected = (requestId: string, reason: InferenceFallbackReason, provider: "metered" | "surplus"): void => {
  try {
    if (provider === "metered") {
      // Keep the established Metered event shape for existing log consumers.
      console.info("[ai.ubq.fi] metered_selected", JSON.stringify({ request_id: requestId, reason }));
    } else {
      console.info("[ai.ubq.fi] paid_provider_selected", JSON.stringify({ request_id: requestId, reason, provider }));
    }
  } catch {
    // Routing telemetry must never alter provider selection.
  }
};

const logPaidProviderAdmissionRejected = (requestId: string, model: string, reason: string): void => {
  try {
    console.warn("[ai.ubq.fi] paid_provider_admission_rejected", JSON.stringify({ request_id: requestId, model, reason }));
  } catch {
    // Routing telemetry must never alter provider selection.
  }
};

const paidProviderAdmissionError = (reason: string): Response => {
  switch (reason) {
    case "disabled":
      return openaiError(403, "Paid-provider routing is disabled for this API key.", "paid_fallback_disabled");
    case "limit_exceeded":
      return openaiError(429, "The API key's paid-provider limit is exhausted.", "paid_fallback_limit_exceeded");
    case "provider_unconfigured":
      return openaiError(503, "No paid provider is configured for this model.", "paid_provider_unconfigured", { type: "server_error" });
    case "model_not_priced":
      return openaiError(403, "This model is not admitted by the API key's paid-provider policy.", "paid_model_not_admitted");
    case "reconciliation_pending":
      return openaiError(503, "Paid-provider billing reconciliation is pending.", "paid_fallback_reconciliation_pending", { type: "server_error" });
    case "concurrent_update":
      return openaiError(503, "Paid-provider admission changed concurrently; retry the request.", "paid_fallback_concurrent_update", { type: "server_error" });
    default:
      return openaiError(503, "Paid-provider admission is unavailable.", "paid_fallback_invalid_policy", { type: "server_error" });
  }
};

export const canAttemptPaidFallback = (context: UsageContext | undefined, selection: ProviderSelection | null): boolean =>
  context?.paidFallbackEnabled === true &&
  Boolean(context.keyId && context.requestId && context.startedAtMs !== undefined) &&
  ((isProviderEnabled("surplus", selection) && Boolean(readSurplusApiKey())) || (isProviderEnabled("openlux", selection) && Boolean(readMeteredApiKey())));

export const bestEffortPaidFallbackBookkeeping = async (operation: string, run: () => Promise<unknown>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    warnPaidFallbackBookkeepingFailure(operation, error);
  }
};

export const paidProviderErrorStatus = (error: unknown): number | null =>
  error instanceof MeteredError || error instanceof SurplusError ? error.status : null;

/**
 * Provider-specific health classification for the paid tiers. Both providers
 * misuse status codes, so the recorded event must not be derived from the raw
 * status alone:
 * - OpenLux reports an exhausted wallet as 403 with `local:insufficient_quota`
 *   in the body, which is quota exhaustion and not an auth fault.
 * - Surplus rejects transiently saturated requests with a fast 402 that is not
 *   a balance signal, so it is recorded as an upstream error. Its
 *   `insufficient_credit` response is the balance-signal exception.
 * This is local to the paid-provider path; Codex account health is untouched.
 */
const paidProviderHealthEvent = (
  provider: "metered" | "surplus",
  status: number | null,
  meteredQuotaExhausted: boolean,
  surplusQuotaExhausted = false
): PaidProviderHealthEvent | null => {
  if (status === 401 || status === 403) return provider === "metered" && meteredQuotaExhausted ? "quota_exhausted" : "auth_invalid";
  if (status === 402 || status === 429) return provider === "surplus" && status === 402 && !surplusQuotaExhausted ? "upstream_error" : "quota_exhausted";
  if (status === null || status >= 500) return "upstream_error";
  if (status >= 100) return "reachable";
  return null;
};

export const paidProviderHealthClassification = (
  provider: "metered" | "surplus",
  status: number | null,
  meteredQuotaExhausted: boolean,
  surplusQuotaExhausted = false
): PaidProviderHealthClassification | null => {
  const event = paidProviderHealthEvent(provider, status, meteredQuotaExhausted, surplusQuotaExhausted);
  return event ? { event, status } : null;
};

/**
 * OpenLux hides a real balance exhaustion behind HTTP 403, and its inference
 * response body is the only discriminator. A clone keeps the delivered bytes
 * intact while the shared bounded reader caps the inspection.
 */
export const meteredForbiddenIndicatesQuotaExhaustion = async (response: Response, signal: AbortSignal | undefined): Promise<boolean> => {
  if (response.status !== 403) return false;
  const { bytes, complete } = await readBoundedResponseBody(response.clone(), { signal, cancellationReason: "Metered 403 classification read" });
  if (!complete) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!isRecord(payload)) return false;
    const error = isRecord(payload.error) ? payload.error : null;
    const code = typeof error?.code === "string" ? error.code.trim().toLowerCase() : "";
    const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
    return code === "local:insufficient_quota" || message.includes("quota is not enough");
  } catch {
    return false;
  }
};

/**
 * Surplus uses HTTP 402 for both transient saturation and an exhausted credit
 * balance. Inspect only a clone so the provider response remains deliverable.
 */
export const surplus402IndicatesQuotaExhaustion = async (response: Response, signal: AbortSignal | undefined): Promise<boolean> => {
  if (response.status !== 402) return false;
  const { bytes, complete } = await readBoundedResponseBody(response.clone(), { signal, cancellationReason: "Surplus 402 classification read" });
  if (!complete) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!isRecord(payload)) return false;
    const error = isRecord(payload.error) ? payload.error : payload;
    const code = typeof error?.code === "string" ? error.code.trim().toLowerCase() : "";
    const type = typeof error?.type === "string" ? error.type.trim().toLowerCase() : "";
    return code === "insufficient_credit" || type === "insufficient_credit";
  } catch {
    return false;
  }
};

export const recordPaidProviderResponseHealth = async (
  provider: "metered" | "surplus",
  status: number | null,
  providerRequestId: string | null = null,
  meteredQuotaExhausted = false,
  surplusQuotaExhausted = false
): Promise<void> => {
  try {
    const classification = paidProviderHealthClassification(provider, status, meteredQuotaExhausted, surplusQuotaExhausted);
    if (!classification) return;
    const record = provider === "surplus" ? recordSurplusProviderHealth : recordMeteredProviderHealth;
    await record(classification.event, status, Date.now, providerRequestId);
  } catch {
    // Provider-health persistence must not change routing or response delivery.
  }
};

const meteredTransportTerminalState = (eventType: string): "completed" | "failed" | "incomplete" | null => {
  if (eventType === "response.completed") return "completed";
  if (eventType === "response.failed" || eventType === "error") return "failed";
  if (eventType === "response.incomplete") return "incomplete";
  return null;
};

const paidLedgerProviderLabel = (provider: UpstreamProvider): "metered" | "surplus" => (provider === "surplus" ? "surplus" : "metered");

const recordProviderHealthForProvider = (
  provider: UpstreamProvider,
  event: PaidProviderHealthEvent | "success",
  status: number | null,
  providerRequestId: string | null
): Promise<void> =>
  provider === "surplus"
    ? recordSurplusProviderHealth(event, status, Date.now, providerRequestId)
    : recordMeteredProviderHealth(event, status, Date.now, providerRequestId);

const reconcileMeteredTransportTerminal = async (
  reservation: PaidFallbackReservation,
  terminalState: "completed" | "failed" | "incomplete",
  provider: UpstreamProvider,
  providerRequestId: string | null,
  surplusBilling: SurplusBillingPricing | null,
  model: string | null,
  usage: UsageTokens | null,
  deliveredHealth: PaidProviderHealthClassification | null
): Promise<void> => {
  const terminal = recordMeteredTerminal(reservation, terminalState, paidLedgerProviderLabel(provider));
  const surplusSettlement =
    provider === "surplus" && surplusBilling && model && usage
      ? async (): Promise<void> => {
          await terminal;
          await recordSurplusUsage(
            reservation,
            providerRequestId ?? `surplus:${reservation.request_id}`,
            model,
            {
              input_tokens: usage.inputTokens,
              cached_input_tokens: usage.cachedInputTokens,
              cache_write_input_tokens: usage.cacheWriteInputTokens,
              output_tokens: usage.outputTokens,
              ...(Object.prototype.hasOwnProperty.call(usage, "buyerCostMicro") ? { buyer_cost_micro: usage.buyerCostMicro } : {}),
            },
            surplusBilling
          );
        }
      : () => terminal;
  // A delivered non-2xx paid response already carries a provider-specific
  // classification (for example OpenLux's body-proven quota exhaustion). Keep
  // that signal instead of downgrading it to a generic upstream error.
  const healthEvent = terminalState === "completed" ? "success" : (deliveredHealth?.event ?? "upstream_error");
  const healthStatus = terminalState === "completed" ? 200 : (deliveredHealth?.status ?? null);
  await Promise.all([surplusSettlement(), recordProviderHealthForProvider(provider, healthEvent, healthStatus, providerRequestId)]);
};

const recordMeteredTransportAmbiguity = async (
  reservation: PaidFallbackReservation,
  provider: UpstreamProvider,
  providerRequestId: string | null,
  deliveredHealth: PaidProviderHealthClassification | null = null
): Promise<void> => {
  await Promise.all([
    recordMeteredAmbiguousFailure(reservation, paidLedgerProviderLabel(provider), providerRequestId),
    recordProviderHealthForProvider(provider, deliveredHealth?.event ?? "upstream_error", deliveredHealth?.status ?? null, providerRequestId),
  ]);
};

export const createMeteredTransportLifecycle = (
  reservation: PaidFallbackReservation | null,
  provider: UpstreamProvider = "metered",
  providerRequestId: string | null = null,
  surplusBilling: SurplusBillingPricing | null = null,
  model: string | null = null,
  providerHealthOnly = false,
  deliveredHealth: PaidProviderHealthClassification | null = null
): MeteredTransportLifecycle => {
  let recorded = false;
  const schedule = (operation: string, run: (reservation: PaidFallbackReservation) => Promise<void>): void => {
    if (!reservation || recorded) return;
    recorded = true;
    void bestEffortPaidFallbackBookkeeping(operation, () => run(reservation));
  };
  const scheduleProviderHealthOnly = (event: "success" | "upstream_error", status: number | null): void => {
    if (reservation || !providerHealthOnly || recorded) return;
    if (provider !== "metered" && provider !== "surplus") return;
    recorded = true;
    void bestEffortPaidFallbackBookkeeping("unreserved provider health recording", () =>
      recordProviderHealthForProvider(provider, event, status, providerRequestId)
    );
  };
  return {
    terminal: (eventType, usage = null) => {
      const terminalState = meteredTransportTerminalState(eventType);
      if (!terminalState) return;
      if (!reservation) {
        const completed = terminalState === "completed";
        scheduleProviderHealthOnly(completed ? "success" : "upstream_error", completed ? 200 : null);
        return;
      }
      schedule("terminal reconciliation", (activeReservation) =>
        reconcileMeteredTransportTerminal(activeReservation, terminalState, provider, providerRequestId, surplusBilling, model, usage, deliveredHealth)
      );
    },
    ambiguous: () => {
      if (!reservation) {
        scheduleProviderHealthOnly("upstream_error", null);
        return;
      }
      schedule("ambiguous failure recording", (activeReservation) =>
        recordMeteredTransportAmbiguity(activeReservation, provider, providerRequestId, deliveredHealth)
      );
    },
    cancelled: () => {
      if (!reservation && providerHealthOnly) {
        // A client cancellation is not provider degradation. Finalize this
        // lifecycle so a later stream race cannot replace the header result.
        recorded = true;
        return;
      }
      schedule("dispatched cancellation recording", (activeReservation) =>
        recordMeteredTerminal(activeReservation, "cancelled", paidLedgerProviderLabel(provider))
      );
    },
  };
};

export const paidCatalogNeedsRefresh = (catalog: Readonly<{ updated_at_ms: number }> | null, ttlMs: number): boolean =>
  catalog === null || Date.now() - catalog.updated_at_ms >= ttlMs;

export const refreshPaidCatalogs = async (
  meteredCatalog: Awaited<ReturnType<typeof fetchMeteredModels>>,
  surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>,
  signal?: AbortSignal
): Promise<readonly [Awaited<ReturnType<typeof fetchMeteredModels>>, Awaited<ReturnType<typeof fetchSurplusModels>>]> =>
  await Promise.all([
    paidCatalogNeedsRefresh(meteredCatalog, METERED_MODELS_CACHE_TTL_MS) ? fetchMeteredModels({ signal }) : Promise.resolve(meteredCatalog),
    paidCatalogNeedsRefresh(surplusCatalog, SURPLUS_MODELS_CACHE_TTL_MS) ? fetchSurplusModels({ signal }) : Promise.resolve(surplusCatalog),
  ]);

export const refreshStalePaidCatalogsInBackground = (
  meteredCatalog: Awaited<ReturnType<typeof fetchMeteredModels>>,
  surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>
): void => {
  if (meteredCatalog !== null && paidCatalogNeedsRefresh(meteredCatalog, METERED_MODELS_CACHE_TTL_MS)) {
    void fetchMeteredModels().catch(() => {});
  }
  if (surplusCatalog !== null && paidCatalogNeedsRefresh(surplusCatalog, SURPLUS_MODELS_CACHE_TTL_MS)) {
    void fetchSurplusModels().catch(() => {});
  }
};

export const resolvePaidRoutingState = (
  input: Readonly<{
    meteredCatalog: Awaited<ReturnType<typeof fetchMeteredModels>>;
    surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>;
    codexModelKnown: boolean;
    endpointType: string;
    requestUsesTools: boolean;
    model: string;
    selection: ProviderSelection | null;
    /**
     * Request-scoped narrowing for callers that need one paid tier on its own
     * (the DeepSeek waterfall's Surplus hop). Null or absent keeps the fixed
     * Surplus -> Metered cost order untouched.
     */
    allowedPaidProviders?: readonly ("metered" | "surplus")[] | null;
    /** Server-owned synthetic-hop context; never read from the request body. */
    deepSeekWaterfallPaidHop?: "surplus" | "openlux" | null;
  }>
): Readonly<{
  surplusBilling: SurplusBillingPricing | null;
  paidProviders: readonly ("metered" | "surplus")[];
  paidModelKnown: boolean;
  meteredOnly: boolean;
  codexEnabled: boolean;
}> => {
  const waterfallPinnedProvider = input.deepSeekWaterfallPaidHop === "openlux" ? "metered" : "surplus";
  const waterfallPaidHop =
    input.model === DEEPSEEK_WATERFALL_PAID_MODEL_ID &&
    input.endpointType === "openai-response" &&
    isProviderEnabled("ubiquity", input.selection) &&
    input.allowedPaidProviders?.length === 1 &&
    input.allowedPaidProviders[0] === waterfallPinnedProvider
      ? (input.deepSeekWaterfallPaidHop ?? null)
      : null;
  // OpenLux served this exact native Responses hop on 2026-10-10 despite its
  // catalog advertising only Chat/Anthropic endpoints. Retain the exact row
  // and Chat capability as evidence; ordinary callers keep the catalog gate.
  const verifiedOpenLuxResponses =
    waterfallPaidHop === "openlux" &&
    input.meteredCatalog?.models.some((entry) => entry.id === input.model && entry.supported_endpoint_types.includes("openai")) === true;
  const meteredModelSupportsRoute =
    verifiedOpenLuxResponses ||
    input.meteredCatalog?.models.some((entry) => entry.id === input.model && entry.supported_endpoint_types.includes(input.endpointType)) === true;
  const surplusModelSupportsRoute =
    input.surplusCatalog?.models.some((entry) => entry.id === input.model && entry.supported_endpoint_types.includes(input.endpointType)) === true;
  const surplusModel = input.surplusCatalog?.models.find((entry) => entry.id === input.model) ?? null;
  const surplusInputPrice = surplusModel?.input_price_per_token;
  const surplusOutputPrice = surplusModel?.output_price_per_token;
  const surplusBilling: SurplusBillingPricing | null =
    surplusInputPrice !== undefined &&
    Number.isFinite(surplusInputPrice) &&
    surplusInputPrice >= 0 &&
    surplusOutputPrice !== undefined &&
    Number.isFinite(surplusOutputPrice) &&
    surplusOutputPrice >= 0
      ? {
          input_price_per_token: surplusInputPrice,
          output_price_per_token: surplusOutputPrice,
          ...(surplusModel?.cache_read_price_per_token === undefined ? {} : { cache_read_price_per_token: surplusModel.cache_read_price_per_token }),
          ...(surplusModel?.cache_write_price_per_token === undefined ? {} : { cache_write_price_per_token: surplusModel.cache_write_price_per_token }),
        }
      : null;
  // The operator can switch a provider off. An empty or absent selection is no
  // filter at all, so `isProviderEnabled` keeps every provider eligible by
  // default and only a saved selection narrows the waterfall.
  const codexEnabled = isProviderEnabled("codex", input.selection);
  // A known Codex model retains the historical OpenLux roster path even when
  // its discovery request is temporarily unavailable. Surplus is selected
  // only when its own catalog proves that the exact model is routable.
  const meteredCanServe =
    (isProviderEnabled("openlux", input.selection) || waterfallPaidHop === "openlux") &&
    Boolean(readMeteredApiKey()) &&
    (input.meteredCatalog === null ? input.codexModelKnown : meteredModelSupportsRoute);
  // Tool-bearing work needs explicit capability evidence from the exact
  // Surplus model record. Missing or partial metadata remains fail-closed.
  const surplusCanServe =
    (isProviderEnabled("surplus", input.selection) || waterfallPaidHop === "surplus") &&
    (!input.requestUsesTools || surplusModel?.supports_tools === true) &&
    Boolean(readSurplusApiKey()) &&
    surplusModelSupportsRoute &&
    surplusBilling !== null;
  // The paid tiers have a fixed cost order for every model. Provider
  // availability may remove a tier, but it must never reverse the order.
  const preferredPaidProviders: readonly ("metered" | "surplus")[] = ["surplus", "metered"];
  const allowedPaidProviders = input.allowedPaidProviders ?? null;
  const paidProviders = preferredPaidProviders.filter(
    (provider) => (provider === "surplus" ? surplusCanServe : meteredCanServe) && (allowedPaidProviders === null || allowedPaidProviders.includes(provider))
  );
  return {
    surplusBilling,
    paidProviders,
    paidModelKnown: meteredModelSupportsRoute || surplusModelSupportsRoute,
    meteredOnly: paidProviders.length > 0 && !input.codexModelKnown,
    codexEnabled,
  };
};

const isAuthoritativeCapacityStatus = (status: number | null): boolean => status === 402 || status === 429;

/**
 * The provider fallback chain is ordered by cost and may advance only after an
 * authoritative upstream quota or capacity signal, so 402 and 429 are the only
 * statuses that hand the request to the next enabled paid tier. A missing
 * status (transport failure or this attempt's own first-headers deadline), a
 * network or read error, and any 5xx are transient faults, not quota
 * exhaustion: they stay on the tier that failed instead of spending a later
 * tier. A local API-key quota rejection never reaches this classification; it
 * is an admission/dispatch guard, not an upstream capacity signal. Every other
 * status, including a definitive 400, is the provider's answer and stays
 * delivered as the final response.
 */
export const isIntermediatePaidProviderAttempt = (providerIndex: number, providerCount: number, status: number | null): boolean =>
  providerIndex < providerCount - 1 && isAuthoritativeCapacityStatus(status);

export const paidFallbackAbortReason = (fallbackSignal: AbortSignal | undefined): Error =>
  fallbackSignal?.reason instanceof Error ? fallbackSignal.reason : new DOMException("The request was aborted.", "AbortError");

const surplusPreHeaderFailureResponse = (error: unknown, timedOut: boolean): Response => {
  if (timedOut) {
    return openaiError(504, "Surplus upstream exceeded the gateway deadline before response headers were received.", "gateway_timeout", {
      type: "server_error",
      headers: { "x-uos-upstream": "surplus" },
    });
  }
  if (error instanceof SurplusError) {
    return openaiError(error.status, error.message, error.code, {
      type: "server_error",
      headers: { "x-uos-upstream": "surplus" },
    });
  }
  return openaiError(502, "Surplus upstream request failed before response headers were received.", "upstream_error", {
    type: "server_error",
    headers: { "x-uos-upstream": "surplus" },
  });
};

const recordTemporarySurplusMetadata = (
  telemetry: ResponseTelemetryState | undefined,
  result: Awaited<ReturnType<typeof fetchSurplusResponses>>,
  providerRequestId: string | null
): void => {
  if (!telemetry) return;
  telemetry.providerRequestId = providerRequestId;
  if (result.prompt_cache_mode !== undefined) telemetry.promptCacheMode = result.prompt_cache_mode;
  if (result.explicit_breakpoint_count !== undefined) telemetry.explicitBreakpointCount = result.explicit_breakpoint_count;
};

export const fetchTemporaryFreeSurplusRoutedResponses = async (
  body: Record<string, unknown>,
  options: Readonly<{ model: string; usageContext?: UsageContext; signal?: AbortSignal }>
): Promise<RoutedResponsesUpstream> => {
  const telemetry = options.usageContext?.responseTelemetry;
  if (telemetry) {
    telemetry.provider = "surplus";
    telemetry.fallbackReason = null;
    telemetry.accountSlot = null;
    telemetry.accountCohortId = null;
    telemetry.activeGeneration = null;
    telemetry.activeTransitionReason = null;
    telemetry.providerRequestId = null;
    telemetry.quotaUsedPercent = null;
  }
  recordAttemptedProvider(options.usageContext, "surplus");
  const dispatchState = { transportStarted: false };
  try {
    const result = await fetchSurplusResponses(body, {
      signal: options.signal,
      reasoningReplayScope: codexCacheScopeForUsageContext(options.usageContext),
      beforeDispatch: () => options.usageContext?.beforeProviderDispatch?.("surplus") ?? Promise.resolve(undefined),
      onDispatch: () => {
        dispatchState.transportStarted = true;
        recordFirstProviderDispatch(options.usageContext);
      },
      sentinelUpstreamRecorder: options.usageContext?.sentinelUpstreamRecorder,
    });
    recordFirstProviderHeaders(options.usageContext);
    const providerRequestId = normalizeProviderRequestId(result.request_id);
    recordTemporarySurplusMetadata(telemetry, result, providerRequestId);
    const surplusQuotaExhausted = await surplus402IndicatesQuotaExhaustion(result.response, options.signal);
    await recordPaidProviderResponseHealth("surplus", result.response.status, providerRequestId, false, surplusQuotaExhausted);
    return {
      response: result.response,
      provider: "surplus",
      paidFallback: null,
      paidFallbackProviderRequestId: providerRequestId,
      gatewayResponse: false,
      fallbackReason: null,
      providerHealthOnly: result.response.ok,
    };
  } catch (error) {
    if (error instanceof ApiKeyQuotaDispatchError) throw error;
    const timedOut = isTimeoutFailure(error, options.signal?.reason);
    if (options.signal?.aborted && !timedOut) throw error;
    const status = paidProviderErrorStatus(error);
    if (dispatchState.transportStarted) await recordPaidProviderResponseHealth("surplus", status);
    if (options.signal?.aborted) throw error;
    return {
      response: surplusPreHeaderFailureResponse(error, timedOut),
      provider: "surplus",
      paidFallback: null,
      gatewayResponse: true,
      fallbackReason: null,
    };
  }
};

export const loadPaidResponsesCatalogs = async (
  body: Record<string, unknown>,
  options: Readonly<{
    model: string;
    route: "chat.completions" | "responses";
    signal?: AbortSignal;
    allowedPaidProviders?: readonly ("metered" | "surplus")[] | null;
    deepSeekWaterfallPaidHop?: "surplus" | "openlux" | null;
  }>,
  selection: ProviderSelection | null
): Promise<
  Readonly<{
    codexModelKnown: boolean;
    endpointType: string;
    requestUsesTools: boolean;
    meteredCatalog: Awaited<ReturnType<typeof fetchMeteredModels>>;
    surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>;
    selection: ProviderSelection | null;
    routing: Readonly<{
      surplusBilling: SurplusBillingPricing | null;
      paidProviders: readonly ("metered" | "surplus")[];
      paidModelKnown: boolean;
      meteredOnly: boolean;
      codexEnabled: boolean;
    }>;
  }>
> => {
  const codexCatalog = await loadCodexModelsSnapshot();
  const codexModelKnown =
    isAdditionalTrustedCodexModel(options.model) ||
    codexCatalog?.models.some((model) => {
      const record = model as Record<string, unknown>;
      return (getString(record.slug) ?? getString(record.id) ?? getString(record.model) ?? getString(record.name)) === options.model;
    }) === true;
  const endpointType = options.route === "responses" ? "openai-response" : "openai";
  const requestUsesTools = Array.isArray(body.tools) && body.tools.length > 0;
  // Cached discovery must not delay the primary Codex transport. A cold
  // discovery is only needed before dispatch when the model is not in the
  // Codex roster; known Codex models can use the historical Metered path and
  // refresh paid catalogs after a fallback-triggering primary response.
  const codexEnabled = isProviderEnabled("codex", selection);
  let [meteredCatalog, surplusCatalog] = await Promise.all([fetchMeteredModels({ cachedOnly: true }), fetchSurplusModels({ cachedOnly: true })]);
  if (
    !codexModelKnown &&
    (paidCatalogNeedsRefresh(meteredCatalog, METERED_MODELS_CACHE_TTL_MS) || paidCatalogNeedsRefresh(surplusCatalog, SURPLUS_MODELS_CACHE_TTL_MS))
  ) {
    [meteredCatalog, surplusCatalog] = await refreshPaidCatalogs(meteredCatalog, surplusCatalog, options.signal);
  }
  const resolveRouting = () =>
    resolvePaidRoutingState({
      meteredCatalog,
      surplusCatalog,
      codexModelKnown,
      endpointType,
      requestUsesTools,
      model: options.model,
      selection,
      allowedPaidProviders: options.allowedPaidProviders ?? null,
      deepSeekWaterfallPaidHop: options.deepSeekWaterfallPaidHop ?? null,
    });
  let routing = resolveRouting();
  // With the Codex tier switched off, the enabled paid catalogs are the only
  // routing evidence left, so a cold enabled catalog must be discovered before
  // this request can be rejected as provider_disabled: the cold snapshot cannot
  // prove that the enabled provider is unable to serve a Codex-known model.
  // Only enabled providers are discovered, a switched-off tier is never probed,
  // and an already-routable paid provider keeps the cached-first path.
  if (codexModelKnown && !codexEnabled && !routing.paidProviders.length) {
    [meteredCatalog, surplusCatalog] = await Promise.all([
      paidCatalogNeedsRefresh(meteredCatalog, METERED_MODELS_CACHE_TTL_MS) && isProviderEnabled("openlux", selection)
        ? fetchMeteredModels({ signal: options.signal })
        : Promise.resolve(meteredCatalog),
      paidCatalogNeedsRefresh(surplusCatalog, SURPLUS_MODELS_CACHE_TTL_MS) && isProviderEnabled("surplus", selection)
        ? fetchSurplusModels({ signal: options.signal })
        : Promise.resolve(surplusCatalog),
    ]);
    routing = resolveRouting();
  }
  if (routing.paidProviders.length) refreshStalePaidCatalogsInBackground(meteredCatalog, surplusCatalog);
  return { codexModelKnown, endpointType, requestUsesTools, meteredCatalog, surplusCatalog, selection, routing };
};

export const rejectPaidAdmission = (
  provider: "metered" | "surplus",
  errorReason: string,
  telemetry: ResponseTelemetryState | undefined,
  usageContext: UsageContext | undefined,
  model: string,
  logReason = errorReason
): RoutedResponsesUpstream => {
  if (telemetry) {
    telemetry.provider = "gateway";
    telemetry.fallbackReason = "dynamic_paid_model";
  }
  logPaidProviderAdmissionRejected(usageContext?.requestId ?? "unknown", model, logReason);
  return {
    response: paidProviderAdmissionError(errorReason),
    provider,
    paidFallback: null,
    gatewayResponse: true,
    fallbackReason: "dynamic_paid_model",
    allowRemovedProviderRecovery: false,
  };
};

/**
 * The operator switched the Codex subscription provider off and no enabled paid
 * provider can serve this request. Fail closed with an explicit gateway error
 * instead of quietly dispatching to the provider that was switched off.
 */
export const rejectDisabledCodexProvider = (
  model: string,
  telemetry: ResponseTelemetryState | undefined,
  usageContext: UsageContext | undefined
): RoutedResponsesUpstream => {
  if (telemetry) {
    telemetry.provider = "gateway";
    telemetry.fallbackReason = null;
  }
  logPaidProviderAdmissionRejected(usageContext?.requestId ?? "unknown", model, "codex_provider_disabled");
  return {
    response: openaiError(503, "The Codex provider is switched off and no enabled paid provider serves this model.", "provider_disabled", {
      type: "server_error",
    }),
    provider: "chatgpt_codex",
    paidFallback: null,
    gatewayResponse: true,
    fallbackReason: null,
    allowRemovedProviderRecovery: false,
  };
};

const surplusModelLacksToolProof = (surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>, model: string): boolean =>
  surplusCatalog?.models.some((entry) => entry.id === model && entry.supports_tools !== true) === true;

const rejectToolUnverifiedSurplusModel = (
  surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>,
  surplusBilling: SurplusBillingPricing | null,
  requestUsesTools: boolean,
  endpointType: string,
  model: string,
  usageContext: UsageContext | undefined,
  telemetry: ResponseTelemetryState | undefined
): RoutedResponsesUpstream | null => {
  const surplusModelSupportsRoute =
    surplusCatalog?.models.some((entry) => entry.id === model && entry.supported_endpoint_types.includes(endpointType)) === true;
  const surplusModelWithoutToolProof =
    requestUsesTools &&
    surplusModelSupportsRoute &&
    Boolean(readSurplusApiKey()) &&
    surplusBilling !== null &&
    surplusModelLacksToolProof(surplusCatalog, model);
  if (!surplusModelWithoutToolProof) return null;
  if (telemetry) {
    telemetry.provider = "gateway";
    telemetry.fallbackReason = "dynamic_paid_model";
  }
  logPaidProviderAdmissionRejected(usageContext?.requestId ?? "unknown", model, "tool_capability_unverified");
  return {
    response: openaiError(400, `Model '${model}' does not support tool calling through the configured providers.`, "model_tool_calling_unsupported", {
      param: "tools",
    }),
    provider: "surplus",
    paidFallback: null,
    gatewayResponse: true,
    fallbackReason: "dynamic_paid_model",
    allowRemovedProviderRecovery: false,
  };
};

export const rejectUnroutablePaidModel = (
  codexModelKnown: boolean,
  routing: Readonly<{ paidModelKnown: boolean; paidProviders: readonly ("metered" | "surplus")[]; surplusBilling: SurplusBillingPricing | null }>,
  surplusCatalog: Awaited<ReturnType<typeof fetchSurplusModels>>,
  endpointType: string,
  requestUsesTools: boolean,
  usageContext: UsageContext | undefined,
  model: string,
  telemetry: ResponseTelemetryState | undefined
): RoutedResponsesUpstream | null => {
  if (codexModelKnown || !routing.paidModelKnown || routing.paidProviders.length > 0) return null;
  const surplusModelSupportsRoute =
    surplusCatalog?.models.some((entry) => entry.id === model && entry.supported_endpoint_types.includes(endpointType)) === true;
  const catalogPaidProvider: "metered" | "surplus" = surplusModelSupportsRoute ? "surplus" : "metered";
  if (usageContext?.paidFallbackEnabled === false) {
    return rejectPaidAdmission(catalogPaidProvider, "disabled", telemetry, usageContext, model);
  }
  const toolUnverified = rejectToolUnverifiedSurplusModel(
    surplusCatalog,
    routing.surplusBilling,
    requestUsesTools,
    endpointType,
    model,
    usageContext,
    telemetry
  );
  if (toolUnverified) return toolUnverified;
  return rejectPaidAdmission(catalogPaidProvider, "provider_unconfigured", telemetry, usageContext, model);
};

export const forcedDebugCodexStatus = (debugScenario: string): number | null => {
  if (debugScenario === "metered_first" || debugScenario === "codex_429") return 429;
  if (debugScenario === "codex_403") return 403;
  if (debugScenario === "codex_401") return 401;
  if (debugScenario === "codex_503") return 503;
  return null;
};

export const codexCacheScopeForUsageContext = (usageContext: UsageContext | undefined): string | undefined => {
  const principal = usageContext?.idempotencyPrincipal;
  if (principal) return principal;
  const keyId = usageContext?.keyId;
  if (keyId) return keyId;
  return undefined;
};
