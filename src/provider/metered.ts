import { STREAM_FIRST_EVENT_DEADLINE_MS } from "../inference-deadline.ts";
import { type ApiKeyProviderDispatch, ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import type { SentinelUpstreamRecorder } from "../sentinel/upstream-capture.ts";
import type { PromptCacheMode } from "../openai-telemetry.ts";
import { buildSurplusClaudeRequest, isSurplusClaudeModel } from "./surplus-claude-request.ts";
import { normalizeAnthropicResponsesResponse } from "./anthropic-responses.ts";

export const METERED_BASE_URL = "https://api.openlux.ai";

const METERED_API_KEY_ENV = "METERED_API_KEY";
const OPENLUX_API_KEY_ENV = "OPENLUX_API_KEY";
const METERED_MODELS_URL = `${METERED_BASE_URL}/v1/models`;
const METERED_RATIO_CONFIG_URL = `${METERED_BASE_URL}/api/ratio_config`;
const METERED_STATUS_URL = `${METERED_BASE_URL}/api/status`;
const METERED_RESPONSES_URL = `${METERED_BASE_URL}/v1/responses`;
const METERED_MESSAGES_URL = `${METERED_BASE_URL}/v1/messages`;
const METERED_TOKEN_LOGS_URL = `${METERED_BASE_URL}/api/log/token`;
// Billing reconciliation runs after the client response and must not hold a
// queue delivery indefinitely when the provider stalls.
export const METERED_FETCH_TIMEOUT_MS = 10_000;
export const METERED_MODELS_CACHE_TTL_MS = 5 * 60_000;
const METERED_MODELS_FAILURE_BACKOFF_MS = 30_000;

export type MeteredModel = Readonly<{
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  supported_endpoint_types: readonly string[];
  model_type?: string;
  description?: string;
  tags?: string;
  max_output_tokens?: number;
}>;

export type MeteredModelsSnapshot = Readonly<{
  models: readonly MeteredModel[];
  updated_at_ms: number;
}>;

let meteredModelsCache: MeteredModelsSnapshot | null = null;
let meteredModelsFetchInFlight: Promise<MeteredModelsSnapshot | null> | null = null;
let meteredModelsFetchGeneration = 0;
let meteredModelsCacheGeneration = 0;
let meteredModelsRetryAfterMs = 0;
let meteredModelsFetchForTest: MeteredFetch | null = null;
const defaultMeteredFetch: MeteredFetch = globalThis.fetch;

const readModelDiscoveryApiKey = (): string | null => {
  let openLuxApiKey: string | null = null;
  let meteredApiKey: string | null = null;
  try {
    openLuxApiKey = nonEmptyString(process.env[OPENLUX_API_KEY_ENV]);
  } catch {
    // The deployment may grant only the legacy Metered key permission.
  }
  try {
    meteredApiKey = nonEmptyString(process.env[METERED_API_KEY_ENV]);
  } catch {
    // Keep discovery unavailable only when neither credential is readable.
  }
  return openLuxApiKey ?? meteredApiKey;
};

const boundedModelDiscoverySignal = (signal: AbortSignal | undefined): AbortSignal => {
  const timeout = AbortSignal.timeout(METERED_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

const markMeteredModelsFetchFailure = (requestGeneration: number): void => {
  if (requestGeneration < meteredModelsCacheGeneration) return;
  meteredModelsRetryAfterMs = Date.now() + METERED_MODELS_FAILURE_BACKOFF_MS;
};

const meteredModelFromUpstream = (value: unknown): MeteredModel | null => {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  if (!id) return null;
  const endpoints = Array.isArray(value.supported_endpoint_types)
    ? value.supported_endpoint_types.filter((entry): entry is string => typeof entry === "string")
    : [];
  const created = isNonNegativeSafeInteger(value.created) ? value.created : 0;
  const ownedBy = nonEmptyString(value.owned_by) ?? "openlux";
  const modelType = nonEmptyString(value.model_type);
  const description = nonEmptyString(value.description);
  const tags = nonEmptyString(value.tags);
  const topProvider = isRecord(value.top_provider) ? value.top_provider : null;
  const maxOutputTokens = value.max_completion_tokens ?? value.max_output_tokens ?? topProvider?.max_completion_tokens;
  return {
    id,
    object: "model",
    created,
    owned_by: ownedBy,
    supported_endpoint_types: endpoints,
    ...(modelType ? { model_type: modelType } : {}),
    ...(description ? { description } : {}),
    ...(tags ? { tags } : {}),
    ...(isNonNegativeSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? { max_output_tokens: maxOutputTokens } : {}),
  };
};

const listedMeteredModels = (data: readonly unknown[]): MeteredModel[] => {
  const models: MeteredModel[] = [];
  const seen = new Set<string>();
  for (const value of data) {
    const model = meteredModelFromUpstream(value);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
};

const publishMeteredModelsSnapshot = (requestGeneration: number, models: MeteredModel[]): MeteredModelsSnapshot | null => {
  const snapshot = { models, updated_at_ms: Date.now() } satisfies MeteredModelsSnapshot;
  if (requestGeneration > meteredModelsCacheGeneration) {
    meteredModelsCacheGeneration = requestGeneration;
    meteredModelsCache = snapshot;
    meteredModelsRetryAfterMs = 0;
  }
  return meteredModelsCache;
};

export const fetchMeteredModels = async (
  options: Readonly<{ fetcher?: MeteredFetch; signal?: AbortSignal; force?: boolean; cachedOnly?: boolean }> = {}
): Promise<MeteredModelsSnapshot | null> => {
  if (!options.force && meteredModelsCache && Date.now() - meteredModelsCache.updated_at_ms < METERED_MODELS_CACHE_TTL_MS) {
    return meteredModelsCache;
  }
  if (!options.force && Date.now() < meteredModelsRetryAfterMs) return meteredModelsCache;
  const apiKey = readModelDiscoveryApiKey();
  if (!apiKey) return meteredModelsCache;
  if (options.cachedOnly) return meteredModelsCache;
  const fetcher = options.fetcher ?? meteredModelsFetchForTest ?? (globalThis.fetch === defaultMeteredFetch ? defaultMeteredFetch : null);
  if (!fetcher) return meteredModelsCache;
  // Only the ordinary discovery path shares an upstream request. Callers that
  // supply a signal, fetcher, or force a refresh retain their own request
  // semantics and do not join a request owned by another caller. `cachedOnly`
  // callers have already returned above, so it is not repeated here.
  const shouldCoalesce = !options.force && options.fetcher === undefined && options.signal === undefined;
  if (shouldCoalesce && meteredModelsFetchInFlight) return await meteredModelsFetchInFlight;

  const requestGeneration = ++meteredModelsFetchGeneration;
  const request = (async (): Promise<MeteredModelsSnapshot | null> => {
    const signal = boundedModelDiscoverySignal(options.signal);
    try {
      const response = await awaitWithAbort(
        fetcher(METERED_MODELS_URL, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          signal,
        }),
        signal
      );
      if (!response.ok) {
        markMeteredModelsFetchFailure(requestGeneration);
        return meteredModelsCache;
      }
      const payload = (await awaitWithAbort(response.json(), signal)) as unknown;
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        markMeteredModelsFetchFailure(requestGeneration);
        return meteredModelsCache;
      }
      return publishMeteredModelsSnapshot(requestGeneration, listedMeteredModels(payload.data));
    } catch {
      if (!(signal.aborted && options.signal?.aborted)) markMeteredModelsFetchFailure(requestGeneration);
      return meteredModelsCache;
    }
  })();
  if (!shouldCoalesce) return await request;
  meteredModelsFetchInFlight = request;
  try {
    return await request;
  } finally {
    if (meteredModelsFetchInFlight === request) meteredModelsFetchInFlight = null;
  }
};

export const resetMeteredModelsCacheForTest = (): void => {
  meteredModelsFetchInFlight = null;
  meteredModelsFetchGeneration += 1;
  meteredModelsCacheGeneration = meteredModelsFetchGeneration;
  meteredModelsRetryAfterMs = 0;
  meteredModelsCache = null;
};

export const setMeteredModelsFetchForTest = (fetcher: MeteredFetch | null): void => {
  meteredModelsFetchForTest = fetcher;
};

export type MeteredFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type MeteredErrorCode =
  | "metered_api_key_missing"
  | "metered_pricing_unavailable"
  | "metered_pricing_invalid"
  | "metered_status_unavailable"
  | "metered_status_invalid"
  | "metered_request_invalid"
  | "metered_upstream_unreachable"
  | "metered_logs_unavailable"
  | "metered_logs_invalid";

export class MeteredError extends Error {
  readonly code: MeteredErrorCode;
  readonly status: number;
  readonly upstream_status: number | null;

  constructor(message: string, code: MeteredErrorCode, status: number, upstreamStatus: number | null = null) {
    super(message);
    this.name = "MeteredError";
    this.code = code;
    this.status = status;
    this.upstream_status = upstreamStatus;
  }
}

export type MeteredPricingSnapshot = Readonly<{
  eligible_model_ids: readonly string[];
  quota_per_credit: number;
  model_quota_coefficients: Readonly<Record<string, number>>;
  checked_at_ms: number;
}>;

export type InitializeMeteredPricingOptions = Readonly<{
  codexModelIds: readonly string[];
  fetcher?: MeteredFetch;
  now?: () => number;
  signal?: AbortSignal;
}>;

export type MeteredAuthenticatedFetchOptions = Readonly<{
  apiKey?: string | null;
  fetcher?: MeteredFetch;
  signal?: AbortSignal;
  /** Private authenticated identity for signed native reasoning replay; never sent upstream. */
  reasoningReplayScope?: string;
  /**
   * Quota hook. Producers fulfil with `undefined` when no dispatch result is
   * available; `Promise.resolve(undefined)` at the call sites keeps that
   * explicit, which is why this is not spelled `void`-in-a-union.
   */
  beforeDispatch?: () => Promise<ApiKeyProviderDispatch | undefined>;
  onDispatch?: () => void;
  /** Request-owned passive recorder; best effort, never required. */
  sentinelUpstreamRecorder?: SentinelUpstreamRecorder;
}>;

export type MeteredTokenLogFetchOptions = MeteredAuthenticatedFetchOptions &
  Readonly<{
    requestIds?: readonly string[];
    startAtMs?: number;
    endAtMs?: number;
  }>;

export type MeteredResponsesResult = Readonly<{
  response: Response;
  request_id: string | null;
  prompt_cache_mode?: PromptCacheMode;
  explicit_breakpoint_count?: number;
}>;

const METERED_REASONING_SUFFIX_MODELS = new Set(["gpt-5.6-sol"]);

// OpenLux omits output limits from its catalog. The same exact Opus 5.5
// weights publish 128000 at the primary marketplace model endpoint:
// https://api.surplusintelligence.ai/v1/models/claude-opus-5.5 (2026-10-11).
// Use the model maximum, not an invented smaller generation budget.
const METERED_NATIVE_MAX_OUTPUT_TOKENS: Readonly<Partial<Record<string, number>>> = { "claude-opus-5-5": 128_000 };

const toMeteredResponsesBody = (body: JsonRecord): JsonRecord => {
  const model = nonEmptyString(body.model);
  const reasoning = isRecord(body.reasoning) ? nonEmptyString(body.reasoning.effort) : null;
  if (!model || !reasoning || !METERED_REASONING_SUFFIX_MODELS.has(model)) return body;

  let suffix = reasoning;
  if (reasoning === "none" || reasoning === "minimal") {
    suffix = "low";
  } else if (reasoning === "ultra") {
    suffix = "max";
  }
  if (!["low", "medium", "high", "xhigh", "max"].includes(suffix)) return body;

  const result: JsonRecord = { ...body, model: `${model}-${suffix}` };
  delete result.reasoning;
  return result;
};

export type MeteredTokenLogEntry = Readonly<{
  request_id: string;
  quota: number;
  prompt_tokens: number;
  cached_prompt_tokens?: number;
  cache_write_prompt_tokens?: number;
  completion_tokens: number;
  model: string;
  created_at: number;
}>;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);

const isPositiveFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

const isNonNegativeSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const rethrowCancellation = (error: unknown, signal: AbortSignal | undefined): void => {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
};

const boundedTokenLogSignal = (signal: AbortSignal | undefined): AbortSignal => {
  const timeout = AbortSignal.timeout(METERED_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

/**
 * Rejection reasons must be `Error` instances. Deno's `DOMException` already is
 * one, so abort and timeout reasons (including `AbortSignal.timeout`'s
 * `TimeoutError`) pass through unchanged; anything else is carried as `cause`
 * so no information is lost.
 */
const asRejectionReason = (value: unknown): Error => (value instanceof Error ? value : new Error("Metered request failed", { cause: value }));

const awaitWithAbort = <T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(asRejectionReason(signal.reason ?? new DOMException("Aborted", "AbortError")));
      });
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(asRejectionReason(error));
        });
      }
    );
  });

export const readMeteredApiKey = (): string | null => {
  try {
    return nonEmptyString(process.env[METERED_API_KEY_ENV]) ?? nonEmptyString(process.env[OPENLUX_API_KEY_ENV]);
  } catch {
    return null;
  }
};

const requireMeteredApiKey = (supplied: string | null | undefined): string => {
  const apiKey = supplied === undefined ? readMeteredApiKey() : nonEmptyString(supplied);
  if (apiKey) return apiKey;
  throw new MeteredError("Metered paid fallback is unavailable because METERED_API_KEY or OPENLUX_API_KEY is not configured.", "metered_api_key_missing", 503);
};

const metadataHeaders = (): Headers => {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  return headers;
};

const authenticatedHeaders = (apiKey: string, accept: string): Headers => {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("Accept", accept);
  return headers;
};

const fetchMetadataJson = async (
  url: string,
  fetcher: MeteredFetch,
  signal: AbortSignal | undefined,
  unavailableCode: "metered_pricing_unavailable" | "metered_status_unavailable",
  invalidCode: "metered_pricing_invalid" | "metered_status_invalid"
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: metadataHeaders(),
      redirect: "manual",
      signal,
    });
  } catch (error) {
    rethrowCancellation(error, signal);
    throw new MeteredError("Metered pricing initialization could not reach the metadata service.", unavailableCode, 502);
  }

  if (!response.ok) {
    throw new MeteredError("Metered pricing initialization received an unsuccessful metadata response.", unavailableCode, 502, response.status);
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new MeteredError("Metered pricing initialization received invalid metadata.", invalidCode, 502, response.status);
  }
};

const unwrapSuccessfulEnvelope = (value: unknown, code: "metered_pricing_invalid" | "metered_status_invalid"): JsonRecord => {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) {
    throw new MeteredError("Metered pricing initialization received an invalid metadata envelope.", code, 502);
  }
  return value.data;
};

const pricedModelIds = (pricing: JsonRecord): Set<string> => {
  const ratioMap = pricing.model_ratio;
  const fixedPriceMap = pricing.model_price;
  if (!isRecord(ratioMap) || !isRecord(fixedPriceMap)) {
    throw new MeteredError("Metered pricing initialization received an invalid pricing configuration.", "metered_pricing_invalid", 502);
  }

  const result = new Set<string>();
  for (const pricingMap of [ratioMap, fixedPriceMap]) {
    for (const [modelId, value] of Object.entries(pricingMap)) {
      if (nonEmptyString(modelId) && isPositiveFiniteNumber(value)) result.add(modelId);
    }
  }
  return result;
};

const modelQuotaCoefficients = (pricing: JsonRecord): Record<string, number> => {
  const ratios = pricing.model_ratio;
  const fixedPrices = pricing.model_price;
  const completionRatios = pricing.completion_ratio;
  if (!isRecord(ratios) || !isRecord(fixedPrices)) {
    throw new MeteredError("Metered pricing initialization received an invalid pricing configuration.", "metered_pricing_invalid", 502);
  }
  const result: Record<string, number> = {};
  for (const [model, ratio] of Object.entries(ratios)) {
    if (!isPositiveFiniteNumber(ratio)) continue;
    const completion = isRecord(completionRatios) && isPositiveFiniteNumber(completionRatios[model]) ? completionRatios[model] : 1;
    const coefficient = ratio * (1 + completion);
    if (Number.isFinite(coefficient) && coefficient > 0) result[model] = coefficient;
  }
  for (const [model, price] of Object.entries(fixedPrices)) {
    if (isPositiveFiniteNumber(price)) result[model] = price;
  }
  return result;
};

const normalizeCodexModelIds = (value: readonly string[]): string[] => {
  if (!Array.isArray(value)) {
    throw new MeteredError("Metered pricing initialization requires the current Codex model catalog.", "metered_pricing_invalid", 502);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawModelId of value) {
    const modelId = nonEmptyString(rawModelId);
    if (!modelId) {
      throw new MeteredError("Metered pricing initialization received an invalid Codex model identifier.", "metered_pricing_invalid", 502);
    }
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    result.push(modelId);
  }
  return result;
};

export const initializeMeteredPricing = async (options: InitializeMeteredPricingOptions): Promise<MeteredPricingSnapshot> => {
  const fetcher = options.fetcher ?? fetch;
  const [pricingEnvelope, statusEnvelope] = await Promise.all([
    fetchMetadataJson(METERED_RATIO_CONFIG_URL, fetcher, options.signal, "metered_pricing_unavailable", "metered_pricing_invalid"),
    fetchMetadataJson(METERED_STATUS_URL, fetcher, options.signal, "metered_status_unavailable", "metered_status_invalid"),
  ]);

  const pricing = unwrapSuccessfulEnvelope(pricingEnvelope, "metered_pricing_invalid");
  const status = unwrapSuccessfulEnvelope(statusEnvelope, "metered_status_invalid");
  if (status.setup !== true || !isPositiveFiniteNumber(status.quota_per_unit) || !Number.isSafeInteger(status.quota_per_unit)) {
    throw new MeteredError("Metered pricing initialization received an invalid quota conversion.", "metered_status_invalid", 502);
  }

  const availableModelIds = pricedModelIds(pricing);
  const coefficients = modelQuotaCoefficients(pricing);
  const eligibleModelIds = normalizeCodexModelIds(options.codexModelIds).filter((modelId) => availableModelIds.has(modelId));
  const checkedAtMs = Math.trunc((options.now ?? Date.now)());
  if (!Number.isSafeInteger(checkedAtMs) || checkedAtMs < 0) {
    throw new MeteredError("Metered pricing initialization received an invalid clock value.", "metered_status_invalid", 502);
  }

  return {
    eligible_model_ids: eligibleModelIds,
    quota_per_credit: status.quota_per_unit,
    model_quota_coefficients: Object.fromEntries(eligibleModelIds.flatMap((model) => (coefficients[model] ? [[model, coefficients[model]]] : []))),
    checked_at_ms: checkedAtMs,
  };
};

const meteredClaudeRequest = (body: JsonRecord, options: MeteredAuthenticatedFetchOptions): ReturnType<typeof buildSurplusClaudeRequest> => {
  if (!isSurplusClaudeModel(body.model)) return null;
  const catalogModel = meteredModelsCache?.models.find((model) => model.id === body.model);
  const trustedCap = METERED_NATIVE_MAX_OUTPUT_TOKENS[body.model];
  if (trustedCap === undefined && !catalogModel?.supported_endpoint_types.includes("anthropic")) return null;
  return buildSurplusClaudeRequest(body, catalogModel?.max_output_tokens ?? trustedCap, {
    provider: "metered",
    reasoningReplayScope: options.reasoningReplayScope,
    // Native adaptive thinking is observed, but the route's explicit effort
    // contract needs separate proof before it can replace Responses requests.
    supportsNativeReasoningEffort: false,
  });
};

const deliverMeteredResponse = async (
  body: JsonRecord,
  response: Response,
  requestId: string | null,
  options: MeteredAuthenticatedFetchOptions,
  native: ReturnType<typeof buildSurplusClaudeRequest>
): Promise<Response> => {
  if (native) {
    return await normalizeAnthropicResponsesResponse(response, {
      model: String(body.model),
      requestId: requestId ?? undefined,
      signal: options.signal,
      reasoningSummary: isRecord(body.reasoning) ? (nonEmptyString(body.reasoning.summary) ?? undefined) : undefined,
      reasoningReplayScope: options.reasoningReplayScope,
      provider: "metered",
    });
  }
  if (!isSurplusClaudeModel(body.model)) return response;
  const warnings = new Headers(response.headers);
  const previous = warnings.get("x-uos-warning");
  const warning = "openlux_claude_native_prompt_cache_unavailable";
  warnings.set("x-uos-warning", previous ? `${previous}, ${warning}` : warning);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: warnings });
};

const encodeMeteredResponseBody = (body: JsonRecord): string => {
  let encodedBody: string;
  try {
    encodedBody = JSON.stringify(body);
  } catch {
    throw new MeteredError("Metered Responses requests must use a JSON-serializable body.", "metered_request_invalid", 400);
  }
  if (typeof encodedBody !== "string") {
    throw new MeteredError("Metered Responses requests must use a JSON-serializable body.", "metered_request_invalid", 400);
  }
  return encodedBody;
};

const meteredResponsesHeaders = (apiKey: string, native: ReturnType<typeof buildSurplusClaudeRequest>): Headers => {
  const headers = authenticatedHeaders(apiKey, native && native.body.stream !== true ? "application/json" : "text/event-stream");
  headers.set("Content-Type", "application/json");
  if (native) headers.set("anthropic-version", "2023-06-01");
  return headers;
};

export const fetchMeteredResponses = async (body: unknown, options: MeteredAuthenticatedFetchOptions = {}): Promise<MeteredResponsesResult> => {
  if (!isRecord(body)) {
    throw new MeteredError("Metered Responses requests must use a canonical JSON object body.", "metered_request_invalid", 400);
  }

  const native = meteredClaudeRequest(body, options);
  const encodedBody = encodeMeteredResponseBody(native?.body ?? toMeteredResponsesBody(body));
  const headers = meteredResponsesHeaders(requireMeteredApiKey(options.apiKey), native);

  let response: Response;
  let upstreamAttempt: ReturnType<SentinelUpstreamRecorder["startAttempt"]> | null = null;
  const headersDeadline = new AbortController();
  const headersTimer = setTimeout(() => {
    headersDeadline.abort(new DOMException("Metered response headers timed out.", "TimeoutError"));
  }, STREAM_FIRST_EVENT_DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, headersDeadline.signal]) : headersDeadline.signal;
  try {
    // Dispatch-based quota accounting must settle immediately before this
    // real provider transport, after all local validation has succeeded.
    // Do not `await undefined`: that would insert a microtask boundary before
    // a normal fetch and let an immediately aborted caller race past a custom
    // transport's abort listener. When a quota hook exists it remains the
    // final awaited operation before transport.
    const dispatch = options.beforeDispatch ? await options.beforeDispatch() : undefined;
    if (signal.aborted) {
      await dispatch?.cancelBeforeTransport();
      throw signal.reason ?? new DOMException("The request was aborted.", "AbortError");
    }
    dispatch?.markTransportStarted();
    options.onDispatch?.();
    upstreamAttempt = options.sentinelUpstreamRecorder?.startAttempt("metered") ?? null;
    response = await (options.fetcher ?? fetch)(native ? METERED_MESSAGES_URL : METERED_RESPONSES_URL, {
      method: "POST",
      headers,
      body: encodedBody,
      redirect: "manual",
      signal,
    });
  } catch (error) {
    upstreamAttempt?.recordFetchError();
    if (error instanceof ApiKeyQuotaDispatchError) throw error;
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (headersDeadline.signal.aborted) throw headersDeadline.signal.reason ?? error;
    rethrowCancellation(error, signal);
    throw new MeteredError("Metered Responses request could not reach the upstream service.", "metered_upstream_unreachable", 502);
  } finally {
    // The deadline covers only request dispatch and response headers. Once a
    // streaming body exists, the shared SSE reader owns renewable inactivity.
    clearTimeout(headersTimer);
  }

  const requestId =
    nonEmptyString(response.headers.get("X-Api-Request-Id")) ??
    nonEmptyString(response.headers.get("X-Oneapi-Request-Id")) ??
    nonEmptyString(response.headers.get("X-Request-Id"));
  const recorded = upstreamAttempt ? upstreamAttempt.wrap(response) : response;
  const delivered = await deliverMeteredResponse(body, recorded, requestId, options, native);
  return {
    response: delivered,
    request_id: requestId,
    ...(native ? { prompt_cache_mode: native.promptCacheMode, explicit_breakpoint_count: native.explicitBreakpointCount } : {}),
  };
};

const tokenLogMetadata = (value: unknown): JsonRecord | null => {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // Ignore malformed provider metadata, retaining authoritative quota.
    return null;
  }
};

const tokenLogCacheCounts = (
  model: string,
  promptTokens: number,
  cachedPromptTokens: unknown,
  other: JsonRecord | null
): Pick<MeteredTokenLogEntry, "prompt_tokens" | "cached_prompt_tokens" | "cache_write_prompt_tokens"> => {
  const fallback = { prompt_tokens: promptTokens, ...(isNonNegativeSafeInteger(cachedPromptTokens) ? { cached_prompt_tokens: cachedPromptTokens } : {}) };
  // OpenLux's native Claude logs report uncached input in prompt_tokens, with
  // cache reads/writes separately in `other`. The actual Messages receipts
  // and settled rows agree on this contract. Never apply it to a model or row
  // whose native Claude flag/counters are absent or invalid.
  if (!isSurplusClaudeModel(model) || other?.claude !== true || !isNonNegativeSafeInteger(other.cache_tokens)) return fallback;
  const write = other.cache_creation_tokens === undefined ? 0 : other.cache_creation_tokens;
  if (!isNonNegativeSafeInteger(write)) return fallback;
  const gross = promptTokens + other.cache_tokens + write;
  if (!isNonNegativeSafeInteger(gross)) return fallback;
  return {
    prompt_tokens: gross,
    cached_prompt_tokens: other.cache_tokens,
    ...(other.cache_creation_tokens === undefined ? {} : { cache_write_prompt_tokens: write }),
  };
};

const normalizeTokenLogEntry = (value: unknown): MeteredTokenLogEntry | null => {
  if (!isRecord(value)) return null;
  const other = tokenLogMetadata(value.other);
  const requestId = nonEmptyString(value.request_id) ?? (other ? nonEmptyString(other.request_id) : null);
  const model = nonEmptyString(value.model_name);
  if (
    !requestId ||
    !model ||
    !isNonNegativeSafeInteger(value.quota) ||
    !isNonNegativeSafeInteger(value.prompt_tokens) ||
    !isNonNegativeSafeInteger(value.completion_tokens) ||
    !isNonNegativeSafeInteger(value.created_at)
  ) {
    return null;
  }

  return {
    request_id: requestId,
    quota: value.quota,
    ...tokenLogCacheCounts(model, value.prompt_tokens, value.cached_prompt_tokens, other),
    completion_tokens: value.completion_tokens,
    model,
    created_at: value.created_at,
  };
};

const meteredTokenLogPageUrl = (apiKey: string, page: number, pageSize: number, startAtMs: number | undefined, endAtMs: number | undefined): URL => {
  const url = new URL(METERED_TOKEN_LOGS_URL);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(pageSize));
  if (typeof startAtMs === "number" && Number.isFinite(startAtMs)) {
    url.searchParams.set("start_timestamp", String(Math.max(0, Math.floor(startAtMs / 1_000))));
  }
  if (typeof endAtMs === "number" && Number.isFinite(endAtMs)) {
    url.searchParams.set("end_timestamp", String(Math.max(0, Math.ceil(endAtMs / 1_000))));
  }
  return url;
};

const envelopeItems = (data: unknown): readonly unknown[] | null => {
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.items)) return data.items;
  return null;
};

type MeteredTokenLogPage = Readonly<{ items: readonly unknown[]; total: number }>;

const fetchMeteredTokenLogPage = async (
  apiKey: string,
  page: number,
  pageSize: number,
  options: MeteredTokenLogFetchOptions,
  signal: AbortSignal
): Promise<MeteredTokenLogPage> => {
  const url = meteredTokenLogPageUrl(apiKey, page, pageSize, options.startAtMs, options.endAtMs);
  let response: Response;
  try {
    const responsePromise = (options.fetcher ?? fetch)(url, {
      method: "GET",
      headers: metadataHeaders(),
      redirect: "manual",
      signal,
    });
    response = await awaitWithAbort(responsePromise, signal);
  } catch (error) {
    rethrowCancellation(error, signal);
    throw new MeteredError("Metered billing logs could not be reached.", "metered_logs_unavailable", 502);
  }

  if (!response.ok) {
    throw new MeteredError("Metered billing logs returned an unsuccessful response.", "metered_logs_unavailable", 502, response.status);
  }

  let envelope: unknown;
  try {
    envelope = (await awaitWithAbort(response.json(), signal)) as unknown;
  } catch (error) {
    rethrowCancellation(error, signal);
    throw new MeteredError("Metered billing logs returned invalid JSON.", "metered_logs_invalid", 502, response.status);
  }
  if (!isRecord(envelope) || envelope.success !== true) {
    throw new MeteredError("Metered billing logs returned an invalid response envelope.", "metered_logs_invalid", 502, response.status);
  }
  const data = envelope.data;
  const items = envelopeItems(data);
  if (!items) {
    throw new MeteredError("Metered billing logs returned an invalid response envelope.", "metered_logs_invalid", 502, response.status);
  }
  return { items, total: isRecord(data) && isNonNegativeSafeInteger(data.total) ? data.total : items.length };
};

export const fetchMeteredTokenLogs = async (options: MeteredTokenLogFetchOptions = {}): Promise<readonly MeteredTokenLogEntry[]> => {
  const apiKey = requireMeteredApiKey(options.apiKey);
  const signal = boundedTokenLogSignal(options.signal);
  const requestedIds = new Set(options.requestIds?.map((id) => id.trim()).filter(Boolean) ?? []);
  const foundIds = new Set<string>();
  const logs: MeteredTokenLogEntry[] = [];
  const pageSize = 100;

  for (let page = 1; page <= 100; page += 1) {
    const { items, total } = await fetchMeteredTokenLogPage(apiKey, page, pageSize, options, signal);
    for (const item of items) {
      const log = normalizeTokenLogEntry(item);
      if (!log) continue;
      logs.push(log);
      if (requestedIds.has(log.request_id)) foundIds.add(log.request_id);
    }
    if (requestedIds.size > 0 && foundIds.size === requestedIds.size) break;
    if (page * pageSize >= total || items.length === 0) break;
  }
  return logs;
};
