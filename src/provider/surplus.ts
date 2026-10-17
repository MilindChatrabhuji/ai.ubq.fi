import { STREAM_FIRST_EVENT_DEADLINE_MS } from "../inference-deadline.ts";
import { type ApiKeyProviderDispatch, ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { readResponsesStream, type ResponsesStreamEvent } from "../responses-stream.ts";
import type { SentinelUpstreamRecorder } from "../sentinel/upstream-capture.ts";
import { isSurplusClaudeModel } from "./surplus-claude-request.ts";
import { buildSurplusClaudeChatRequest, type SurplusClaudeChatRequest } from "./surplus-claude-chat-request.ts";
import { normalizeAnthropicChatResponsesResponse } from "./anthropic-chat-responses.ts";
import type { PromptCacheMode } from "../openai-telemetry.ts";

export const SURPLUS_BASE_URL = "https://api.surplusintelligence.ai";
export const SURPLUS_API_KEY_ENV = "SURPLUS_API_KEY";
const SURPLUS_MODELS_URL = `${SURPLUS_BASE_URL}/v1/models`;
const SURPLUS_RESPONSES_URL = `${SURPLUS_BASE_URL}/v1/responses`;
const SURPLUS_CHAT_URL = `${SURPLUS_BASE_URL}/v1/chat/completions`;
export const SURPLUS_FETCH_TIMEOUT_MS = 10_000;
export const SURPLUS_MODELS_CACHE_TTL_MS = 5 * 60_000;
const SURPLUS_MODELS_FAILURE_BACKOFF_MS = 30_000;

export type SurplusModel = Readonly<{
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  supported_endpoint_types: readonly string[];
  supports_tools?: true;
  supports_parallel_tool_calls?: true;
  description?: string;
  input_price_per_token?: number;
  output_price_per_token?: number;
  cache_read_price_per_token?: number;
  cache_write_price_per_token?: number;
  max_output_tokens?: number;
}>;

export type SurplusModelsSnapshot = Readonly<{
  models: readonly SurplusModel[];
  updated_at_ms: number;
}>;

export type SurplusFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type SurplusErrorCode = "surplus_api_key_missing" | "surplus_request_invalid" | "surplus_upstream_unreachable";

export class SurplusError extends Error {
  readonly code: SurplusErrorCode;
  readonly status: number;
  readonly upstream_status: number | null;

  constructor(message: string, code: SurplusErrorCode, status: number, upstreamStatus: number | null = null) {
    super(message);
    this.name = "SurplusError";
    this.code = code;
    this.status = status;
    this.upstream_status = upstreamStatus;
  }
}

export type SurplusAuthenticatedFetchOptions = Readonly<{
  apiKey?: string | null;
  fetcher?: SurplusFetch;
  signal?: AbortSignal;
  supportsParallelToolCalls?: boolean;
  /** Authenticated caller scope; never forwarded to an upstream provider. */
  reasoningReplayScope?: string;
  /**
   * Optional pre-transport hook. It either resolves to a dispatch handle that can
   * still cancel the admitted reservation, or resolves with no value at all, so
   * the return type stays a plain `void` arm instead of a `void` union member.
   */
  beforeDispatch?: (() => Promise<ApiKeyProviderDispatch>) | (() => void);
  onDispatch?: () => void;
  /** Request-owned passive recorder; best effort, never required. */
  sentinelUpstreamRecorder?: SentinelUpstreamRecorder;
}>;

export type SurplusResponsesResult = Readonly<{
  response: Response;
  request_id: string | null;
  prompt_cache_mode?: PromptCacheMode;
  explicit_breakpoint_count?: number;
}>;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const isNonNegativeSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const nonNegativeNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const readStringSet = (value: unknown): ReadonlySet<string> =>
  new Set(
    Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : []
  );

const readModelCapabilities = (value: JsonRecord): Readonly<{ supports_tools?: true; supports_parallel_tool_calls?: true }> => {
  const parameters = readStringSet(value.supported_parameters);
  const features = readStringSet(value.supported_features);
  return {
    ...(parameters.has("tools") && parameters.has("tool_choice") && features.has("tools") ? { supports_tools: true as const } : {}),
    ...(parameters.has("parallel_tool_calls") ? { supports_parallel_tool_calls: true as const } : {}),
  };
};

const readTextModalities = (
  value: unknown
): {
  inputKnown: boolean;
  outputKnown: boolean;
  inputText: boolean;
  outputText: boolean;
} => {
  if (!isRecord(value)) return { inputKnown: false, outputKnown: false, inputText: false, outputText: false };
  let inputKnown = false;
  let outputKnown = false;
  let inputText = false;
  let outputText = false;
  const inputModalities = Array.isArray(value.input_modalities) ? value.input_modalities.filter((entry): entry is string => typeof entry === "string") : [];
  if (inputModalities.length) {
    inputKnown = true;
    inputText = inputModalities.includes("text");
  }
  const outputModalities = Array.isArray(value.output_modalities) ? value.output_modalities.filter((entry): entry is string => typeof entry === "string") : [];
  if (outputModalities.length) {
    outputKnown = true;
    outputText = outputModalities.includes("text");
  }
  const modality = nonEmptyString(value.modality);
  if (modality) {
    const hasTextModality = (part: string): boolean =>
      part
        .split(/[+,]/)
        .map((entry) => entry.trim())
        .includes("text");
    const arrow = modality.lastIndexOf("->");
    if (arrow >= 0) {
      inputKnown = true;
      outputKnown = true;
      inputText = hasTextModality(modality.slice(0, arrow));
      outputText = hasTextModality(modality.slice(arrow + 2));
    } else {
      inputKnown = true;
      outputKnown = true;
      inputText = outputText = hasTextModality(modality);
    }
  }
  return { inputKnown, outputKnown, inputText, outputText };
};

const modelSupportsTextOutput = (value: JsonRecord): boolean => {
  const architecture = value.architecture;
  if (!isRecord(architecture)) return true;
  const modalities = readTextModalities(architecture);
  return !modalities.outputKnown || modalities.outputText;
};

const modelSupportsTextInput = (value: JsonRecord): boolean => {
  const architecture = value.architecture;
  if (!isRecord(architecture)) return true;
  const modalities = readTextModalities(architecture);
  return !modalities.inputKnown || modalities.inputText;
};

const readPricing = (
  value: JsonRecord
): Readonly<{
  input_price_per_token?: number;
  output_price_per_token?: number;
  cache_read_price_per_token?: number;
  cache_write_price_per_token?: number;
}> => {
  if (!isRecord(value.pricing)) return {};
  const input = nonNegativeNumber(value.pricing.prompt ?? value.pricing.input);
  const output = nonNegativeNumber(value.pricing.completion ?? value.pricing.output);
  const cacheRead = nonNegativeNumber(value.pricing.input_cache_read ?? value.pricing.cache_read ?? value.pricing.cache_read_input);
  const cacheWrite = nonNegativeNumber(value.pricing.input_cache_write ?? value.pricing.cache_write ?? value.pricing.cache_write_input);
  return {
    ...(input === null ? {} : { input_price_per_token: input }),
    ...(output === null ? {} : { output_price_per_token: output }),
    ...(cacheRead === null ? {} : { cache_read_price_per_token: cacheRead }),
    ...(cacheWrite === null ? {} : { cache_write_price_per_token: cacheWrite }),
  };
};

const readSurplusModel = (value: unknown): SurplusModel | null => {
  if (!isRecord(value) || !modelSupportsTextInput(value) || !modelSupportsTextOutput(value)) return null;
  const id = nonEmptyString(value.id);
  if (!id) return null;
  const created = isNonNegativeSafeInteger(value.created) ? value.created : 0;
  const ownedBy = nonEmptyString(value.provider) ?? nonEmptyString(value.owned_by) ?? "surplus";
  const description = nonEmptyString(value.description);
  const topProvider = isRecord(value.top_provider) ? value.top_provider : null;
  const maxOutputTokens = topProvider?.max_completion_tokens;
  return {
    id,
    object: "model",
    created,
    owned_by: ownedBy,
    supported_endpoint_types: ["openai", "openai-response"],
    ...readModelCapabilities(value),
    ...(description ? { description } : {}),
    ...(isNonNegativeSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? { max_output_tokens: maxOutputTokens } : {}),
    ...readPricing(value),
  };
};

let surplusModelsCache: SurplusModelsSnapshot | null = null;
let surplusModelsFetchInFlight: Promise<SurplusModelsSnapshot | null> | null = null;
let surplusModelsFetchGeneration = 0;
let surplusModelsCacheGeneration = 0;
let surplusModelsRetryAfterMs = 0;

export const readSurplusApiKey = (): string | null => {
  try {
    return nonEmptyString(process.env[SURPLUS_API_KEY_ENV]);
  } catch {
    return null;
  }
};

const boundedModelsSignal = (signal: AbortSignal | undefined): AbortSignal => {
  const timeout = AbortSignal.timeout(SURPLUS_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

const markSurplusModelsFetchFailure = (requestGeneration: number): void => {
  if (requestGeneration < surplusModelsCacheGeneration) return;
  surplusModelsRetryAfterMs = Date.now() + SURPLUS_MODELS_FAILURE_BACKOFF_MS;
};

export const fetchSurplusModels = async (
  options: Readonly<{
    apiKey?: string | null;
    fetcher?: SurplusFetch;
    signal?: AbortSignal;
    force?: boolean;
    cachedOnly?: boolean;
    requireApiKey?: boolean;
  }> = {}
): Promise<SurplusModelsSnapshot | null> => {
  const apiKey = options.apiKey === undefined ? readSurplusApiKey() : nonEmptyString(options.apiKey);
  if ((options.requireApiKey ?? true) && !apiKey) return null;
  if (!options.force && surplusModelsCache && Date.now() - surplusModelsCache.updated_at_ms < SURPLUS_MODELS_CACHE_TTL_MS) return surplusModelsCache;
  if (!options.force && Date.now() < surplusModelsRetryAfterMs) return surplusModelsCache;
  if (options.cachedOnly) return surplusModelsCache;
  // Only the ordinary discovery path shares an upstream request. Callers that
  // supply a signal, fetcher, API key, or force a refresh retain their own
  // request semantics and do not join another caller's request. `cachedOnly` is
  // already excluded by the early return above.
  const shouldCoalesce =
    !options.force && options.apiKey === undefined && options.fetcher === undefined && options.signal === undefined && options.requireApiKey === undefined;
  if (shouldCoalesce && surplusModelsFetchInFlight) return await surplusModelsFetchInFlight;

  const requestGeneration = ++surplusModelsFetchGeneration;
  const request = (async (): Promise<SurplusModelsSnapshot | null> => {
    const signal = boundedModelsSignal(options.signal);
    try {
      const response = await (options.fetcher ?? fetch)(SURPLUS_MODELS_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal,
      });
      if (!response.ok) {
        markSurplusModelsFetchFailure(requestGeneration);
        return surplusModelsCache;
      }
      const payload = (await response.json()) as unknown;
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        markSurplusModelsFetchFailure(requestGeneration);
        return surplusModelsCache;
      }
      const models: SurplusModel[] = [];
      const seen = new Set<string>();
      for (const value of payload.data) {
        const model = readSurplusModel(value);
        if (!model || seen.has(model.id)) continue;
        models.push(model);
        seen.add(model.id);
      }
      const snapshot = { models, updated_at_ms: Date.now() } satisfies SurplusModelsSnapshot;
      if (requestGeneration > surplusModelsCacheGeneration) {
        surplusModelsCacheGeneration = requestGeneration;
        surplusModelsCache = snapshot;
        surplusModelsRetryAfterMs = 0;
      }
      return surplusModelsCache;
    } catch (error) {
      if (signal.aborted && options.signal?.aborted) throw error;
      markSurplusModelsFetchFailure(requestGeneration);
      return surplusModelsCache;
    }
  })();
  if (!shouldCoalesce) return await request;
  surplusModelsFetchInFlight = request;
  try {
    return await request;
  } finally {
    if (surplusModelsFetchInFlight === request) surplusModelsFetchInFlight = null;
  }
};

export const resetSurplusModelsCacheForTest = (): void => {
  surplusModelsFetchInFlight = null;
  surplusModelsFetchGeneration += 1;
  surplusModelsCacheGeneration = surplusModelsFetchGeneration;
  surplusModelsRetryAfterMs = 0;
  surplusModelsCache = null;
};

const requireSurplusApiKey = (supplied: string | null | undefined): string => {
  const apiKey = supplied === undefined ? readSurplusApiKey() : nonEmptyString(supplied);
  if (apiKey) return apiKey;
  throw new SurplusError("Surplus paid fallback is unavailable because SURPLUS_API_KEY is not configured.", "surplus_api_key_missing", 503);
};

// Rejection reasons must be Errors. Deno's DOMException is an Error, so a real
// abort reason is always passed through unchanged; only a missing or exotic
// reason becomes the canonical AbortError the call sites already expect.
const abortRejectionReason = (reason: unknown): Error => (reason instanceof Error ? reason : new DOMException("Aborted", "AbortError"));

// A failed upstream operation keeps its original Error so callers can still
// match on it; anything else is wrapped, which leaves the failure classification
// in fetchSurplusResponses unchanged.
const requestFailureReason = (reason: unknown): Error => (reason instanceof Error ? reason : new Error("Surplus Responses request failed.", { cause: reason }));

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
        reject(abortRejectionReason(signal.reason));
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
          reject(requestFailureReason(error));
        });
      }
    );
  });

const authenticatedHeaders = (apiKey: string): Headers => {
  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  return headers;
};

const responseRequestId = (response: Response): string | null =>
  nonEmptyString(response.headers.get("X-Request-Id") ?? response.headers.get("X-Api-Request-Id") ?? response.headers.get("X-Oneapi-Request-Id"));

const encodeResponsesEvent = (value: JsonRecord): Uint8Array => new TextEncoder().encode(`event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`);

// Indices arrive as JSON primitives. Render only those explicitly: `String()` on
// an object would silently produce "[object Object]" as a part key.
const responsesPartIndex = (value: unknown): string => (typeof value === "number" || typeof value === "string" ? String(value) : "0");

const responsesPartKey = (value: JsonRecord): string => `${responsesPartIndex(value.output_index)}:${responsesPartIndex(value.content_index)}`;

type SurplusTextPartState = {
  textParts: Map<string, string>;
  doneTextParts: Set<string>;
  sawMessageDone: boolean;
};

const applyResponsesTextEvent = (state: SurplusTextPartState, event: ResponsesStreamEvent): void => {
  const value = event.value;
  if (event.type === "response.output_text.delta") {
    const key = responsesPartKey(value);
    state.textParts.set(key, `${state.textParts.get(key) ?? ""}${typeof value.delta === "string" ? value.delta : ""}`);
    return;
  }
  if (event.type === "response.output_text.done") {
    state.doneTextParts.add(responsesPartKey(value));
    return;
  }
  if (event.type === "response.output_item.done" && isRecord(value.item) && value.item.type === "message") {
    state.sawMessageDone = true;
  }
};

// Canonical events emitted for the terminal `response.completed` event: the
// buffered text parts as `response.output_text.done`, then the item and the
// completed event itself.
const completedResponsesEvents = (state: SurplusTextPartState, value: JsonRecord): Uint8Array[] => {
  const chunks: Uint8Array[] = [];
  const orderedParts = [...state.textParts.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [key, text] of orderedParts) {
    if (state.doneTextParts.has(key)) continue;
    const [outputIndex, contentIndex] = key.split(":").map(Number);
    chunks.push(
      encodeResponsesEvent({
        type: "response.output_text.done",
        output_index: outputIndex,
        content_index: contentIndex,
        text,
      })
    );
  }
  const text = orderedParts.map(([, part]) => part).join("");
  const message = {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  if (text && !state.sawMessageDone) {
    chunks.push(encodeResponsesEvent({ type: "response.output_item.done", output_index: 0, item: message }));
  }
  const completed = isRecord(value.response) ? { ...value, response: { ...value.response, ...(text ? { output: [message] } : {}) } } : value;
  chunks.push(encodeResponsesEvent(completed));
  return chunks;
};

const normalizeSurplusResponsesStream = (response: Response): Response => {
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    return response;
  }
  const consumerAbort = new AbortController();
  const source = readResponsesStream(response.body, consumerAbort.signal);
  const state: SurplusTextPartState = { textParts: new Map<string, string>(), doneTextParts: new Set<string>(), sawMessageDone: false };
  const iterator = (async function* () {
    for await (const event of source) {
      applyResponsesTextEvent(state, event);

      if (event.type !== "response.completed") {
        yield encodeResponsesEvent(event.value);
        continue;
      }

      for (const chunk of completedResponsesEvents(state, event.value)) yield chunk;
    }
  })();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel(reason) {
        consumerAbort.abort(reason);
        await iterator.return(reason).catch(() => {});
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers }
  );
};

const toSurplusResponsesBody = (body: JsonRecord, supportsParallelToolCalls: boolean | undefined): JsonRecord => {
  let forwardedBody = body;
  if (Array.isArray(body.input)) {
    const originalInput = body.input;
    const input = originalInput.map((item) => (isRecord(item) && item.type === "message" && item.role === "developer" ? { ...item, role: "system" } : item));
    if (input.some((item, index) => item !== originalInput[index])) {
      forwardedBody = { ...body, input };
    }
  }
  if (supportsParallelToolCalls === false && "parallel_tool_calls" in body) {
    if (forwardedBody === body) forwardedBody = { ...body };
    delete forwardedBody.parallel_tool_calls;
  }
  if (!isRecord(forwardedBody.reasoning) || forwardedBody.reasoning.effort !== "ultra") {
    return forwardedBody;
  }
  return {
    ...forwardedBody,
    reasoning: { ...forwardedBody.reasoning, effort: "max" },
  };
};

// Classify a failed transport attempt: preserve the errors callers already
// handle, rethrow an abort reason when a signal caused it, and otherwise report
// the upstream as unreachable.
const surplusTransportFailure = (error: unknown, signal: AbortSignal | undefined, headersDeadline: AbortController): unknown => {
  if (error instanceof ApiKeyQuotaDispatchError) return error;
  if (signal?.aborted) return signal.reason ?? error;
  if (headersDeadline.signal.aborted) return headersDeadline.signal.reason ?? error;
  if (error instanceof Error && error.name === "AbortError") return error;
  return new SurplusError("Surplus Responses request could not reach the upstream service.", "surplus_upstream_unreachable", 502);
};

const surplusRequestUrl = (native: SurplusClaudeChatRequest | null): string => (native ? SURPLUS_CHAT_URL : SURPLUS_RESPONSES_URL);

const nativeCacheMetadata = (native: SurplusClaudeChatRequest | null): Pick<SurplusResponsesResult, "prompt_cache_mode" | "explicit_breakpoint_count"> =>
  native ? { prompt_cache_mode: native.promptCacheMode, explicit_breakpoint_count: native.explicitBreakpointCount } : {};

const deliverSurplusResponse = async (
  response: Response,
  body: JsonRecord,
  options: SurplusAuthenticatedFetchOptions,
  native: SurplusClaudeChatRequest | null,
  requestId: string | null
): Promise<Response> => {
  if (native) {
    return await normalizeAnthropicChatResponsesResponse(response, {
      model: String(body.model),
      requestId: requestId ?? undefined,
      signal: options.signal,
      reasoningSummary: isRecord(body.reasoning) && typeof body.reasoning.summary === "string" ? body.reasoning.summary : undefined,
      reasoningReplayScope: options.reasoningReplayScope,
      provider: "surplus",
      toolNames: native.toolNames,
      customToolNames: native.customToolNames,
    });
  }
  const delivered = normalizeSurplusResponsesStream(response);
  if (!isSurplusClaudeModel(body.model)) return delivered;
  const warnings = new Headers(delivered.headers);
  const previous = warnings.get("x-uos-warning");
  const warning = "surplus_claude_native_prompt_cache_unavailable";
  warnings.set("x-uos-warning", previous ? `${previous}, ${warning}` : warning);
  return new Response(delivered.body, { status: delivered.status, statusText: delivered.statusText, headers: warnings });
};

export const fetchSurplusResponses = async (body: unknown, options: SurplusAuthenticatedFetchOptions = {}): Promise<SurplusResponsesResult> => {
  if (!isRecord(body)) {
    throw new SurplusError("Surplus Responses requests must use a canonical JSON object body.", "surplus_request_invalid", 400);
  }

  const native = buildSurplusClaudeChatRequest(body, surplusModelsCache?.models.find((model) => model.id === body.model)?.max_output_tokens, {
    provider: "surplus",
    reasoningReplayScope: options.reasoningReplayScope,
  });
  let encodedBody: string;
  try {
    encodedBody = JSON.stringify(native?.body ?? toSurplusResponsesBody(body, options.supportsParallelToolCalls));
  } catch {
    throw new SurplusError("Surplus Responses requests must use a JSON-serializable body.", "surplus_request_invalid", 400);
  }
  if (typeof encodedBody !== "string") {
    throw new SurplusError("Surplus Responses requests must use a JSON-serializable body.", "surplus_request_invalid", 400);
  }

  const apiKey = requireSurplusApiKey(options.apiKey);
  const headers = authenticatedHeaders(apiKey);
  const headersDeadline = new AbortController();
  const headersTimer = setTimeout(() => {
    headersDeadline.abort(new DOMException("Surplus response headers timed out.", "TimeoutError"));
  }, STREAM_FIRST_EVENT_DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, headersDeadline.signal]) : headersDeadline.signal;
  let response: Response;
  let upstreamAttempt: ReturnType<SentinelUpstreamRecorder["startAttempt"]> | null = null;
  try {
    const dispatch = options.beforeDispatch ? await options.beforeDispatch() : undefined;
    if (signal.aborted) {
      await dispatch?.cancelBeforeTransport();
      throw signal.reason ?? new DOMException("The request was aborted.", "AbortError");
    }
    dispatch?.markTransportStarted();
    options.onDispatch?.();
    upstreamAttempt = options.sentinelUpstreamRecorder?.startAttempt("surplus") ?? null;
    response = await awaitWithAbort(
      (options.fetcher ?? fetch)(surplusRequestUrl(native), {
        method: "POST",
        headers,
        body: encodedBody,
        redirect: "manual",
        signal,
      }),
      signal
    );
  } catch (error) {
    upstreamAttempt?.recordFetchError();
    throw surplusTransportFailure(error, options.signal, headersDeadline);
  } finally {
    clearTimeout(headersTimer);
  }

  const requestId = responseRequestId(response);
  const recorded = upstreamAttempt ? upstreamAttempt.wrap(response) : response;
  const delivered = await deliverSurplusResponse(recorded, body, options, native, requestId);
  return {
    response: delivered,
    request_id: requestId,
    ...nativeCacheMetadata(native),
  };
};
