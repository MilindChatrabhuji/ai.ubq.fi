// Upstream error translation, redaction diagnostics, and provider wire helpers, extracted from src/openai.ts.

import { CODEX_AUTH_REAUTH_MESSAGE, CODEX_AUTH_REAUTH_WARNING, CodexError } from "./codex/index.ts";
import { CEREBRAS_GPT_OSS_120B_MODEL, CerebrasError, getCerebrasProviderRequestId } from "./provider/cerebras.ts";
import { CEREBRAS_RATE_LIMIT_HEADERS } from "./provider/cerebras-rate-limits.ts";
import { DEEPSEEK_OFFICIAL_MODEL_IDS, DeepSeekError, getDeepSeekProviderRequestId } from "./deepseek/index.ts";
import { getLithosProviderRequestId, LITHOS_MODEL_IDS, LITHOS_RATE_LIMIT_HEADERS, LithosError } from "./provider/lithos.ts";
import { ApiKeyQuotaDispatchError } from "./api-key-policy.ts";
import { BOUNDED_RESPONSE_BODY_MAX_BYTES, BOUNDED_RESPONSE_BODY_TIMEOUT_MS, readBoundedResponseBody } from "./bounded-response-body.ts";
import { openaiError } from "./http.ts";
import { getString, isRecord } from "./utils.ts";
import { MeteredError } from "./provider/metered.ts";
import { SurplusError } from "./provider/surplus.ts";
import { type ResponseStreamTerminalType, type UpstreamProvider } from "./openai-telemetry.ts";

const GATEWAY_DEADLINE_ORIGIN = "gateway_deadline";
type RefusalResponseOrigin = typeof GATEWAY_DEADLINE_ORIGIN | "upstream";
const refusalResponseOrigins = new WeakMap<Response, RefusalResponseOrigin>();

/** Keep local-vs-provider refusal provenance out of the client-visible wire. */
const markGatewayDeadlineResponse = (response: Response): Response => {
  refusalResponseOrigins.set(response, GATEWAY_DEADLINE_ORIGIN);
  return response;
};

const markUpstreamRefusalResponse = (response: Response): Response => {
  refusalResponseOrigins.set(response, "upstream");
  return response;
};

/**
 * A status-only 504 is still treated as a local deadline for an already
 * aborted request, while an explicitly marked upstream refusal wins over a
 * later abort of that signal.
 */
export const isGatewayDeadlineResponse = (response: Response, requestSignal: AbortSignal): boolean => {
  if (response.status !== 504) return false;
  const origin = refusalResponseOrigins.get(response);
  return origin === GATEWAY_DEADLINE_ORIGIN || (origin === undefined && requestSignal.aborted);
};

export const formatErrorSnippet = (error: unknown, maxLen = 280): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}...`;
};

type RedactedUpstreamErrorDiagnostic = Readonly<{
  error_class: "ApiKeyQuotaDispatchError" | "CodexError" | "MeteredError" | "SurplusError" | "DOMException" | "TypeError" | "Error" | "unknown";
  status: number | null;
  code: string | null;
}>;

// Only codes owned by this gateway's typed errors may reach server logs. In
// particular, never log arbitrary error messages, causes, stacks, or provider
// response bodies: an upstream error may echo request content or credentials.
const REDACTED_UPSTREAM_DIAGNOSTIC_CODES = new Set<string>([
  "api_key_quota_reservation_unavailable",
  "codex_auth_missing",
  "codex_auth_invalid",
  "codex_auth_refresh_failed",
  "refresh_token_reused",
  "codex_auth_refresh_unreachable",
  "codex_auth_owner_unavailable",
  "codex_auth_owner_conflict",
  "codex_upstream_unreachable",
  "gateway_timeout",
  "invalid_api_key",
  "rate_limit_exceeded",
  "server_error",
  "metered_api_key_missing",
  "metered_pricing_unavailable",
  "metered_pricing_invalid",
  "metered_status_unavailable",
  "metered_status_invalid",
  "metered_request_invalid",
  "metered_upstream_unreachable",
  "metered_logs_unavailable",
  "metered_logs_invalid",
  "surplus_api_key_missing",
  "surplus_request_invalid",
  "surplus_upstream_unreachable",
]);

const redactedDiagnosticStatus = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;

const redactedUpstreamErrorDiagnostic = (error: unknown): RedactedUpstreamErrorDiagnostic => {
  let errorClass: RedactedUpstreamErrorDiagnostic["error_class"] = "unknown";
  let status: number | null = null;
  let code: string | null = null;

  if (error instanceof ApiKeyQuotaDispatchError) {
    errorClass = "ApiKeyQuotaDispatchError";
    status = redactedDiagnosticStatus(error.status);
    code = REDACTED_UPSTREAM_DIAGNOSTIC_CODES.has(error.code) ? error.code : null;
  } else if (error instanceof CodexError) {
    errorClass = "CodexError";
    status = redactedDiagnosticStatus(error.status);
    code = REDACTED_UPSTREAM_DIAGNOSTIC_CODES.has(error.code) ? error.code : null;
  } else if (error instanceof MeteredError) {
    errorClass = "MeteredError";
    status = redactedDiagnosticStatus(error.status);
    code = REDACTED_UPSTREAM_DIAGNOSTIC_CODES.has(error.code) ? error.code : null;
  } else if (error instanceof SurplusError) {
    errorClass = "SurplusError";
    status = redactedDiagnosticStatus(error.status);
    code = REDACTED_UPSTREAM_DIAGNOSTIC_CODES.has(error.code) ? error.code : null;
  } else if (error instanceof DOMException) {
    errorClass = "DOMException";
  } else if (error instanceof TypeError) {
    errorClass = "TypeError";
  } else if (error instanceof Error) {
    errorClass = "Error";
    // Voyage attaches a numeric HTTP status to its locally-created Error.
    status = redactedDiagnosticStatus((error as { status?: unknown }).status);
  }

  return { error_class: errorClass, status, code };
};

export const logRedactedUpstreamError = (label: string, error: unknown): void => {
  console.error(label, redactedUpstreamErrorDiagnostic(error));
};

const withUpstreamProviderHeader = (response: Response, provider: string | null | undefined): Response => {
  if (!provider) return response;
  const headers = new Headers(response.headers);
  headers.set("x-uos-upstream", provider);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const MAX_PROVIDER_REQUEST_ID_CHARS = 256;

export const normalizeProviderRequestId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const requestId = value.trim();
  if (!requestId || requestId.length > MAX_PROVIDER_REQUEST_ID_CHARS) return null;
  for (const character of requestId) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return requestId;
};

export const providerRequestIdFromResponse = (response: Response): string | null => {
  const requestId = response.headers.get("X-Request-Id") ?? response.headers.get("X-Api-Request-Id") ?? response.headers.get("X-Oneapi-Request-Id");
  return normalizeProviderRequestId(requestId);
};

const paidUpstreamProviderLabel = (provider: string | null | undefined): string => {
  if (provider === "surplus") return "Surplus";
  if (provider === "metered") return "Metered";
  return "Codex";
};

const codexUpstreamErrorResponse = (error: CodexError): Response => {
  const authReauthenticationFailure =
    error.code === "codex_auth_invalid" || error.code === "codex_auth_refresh_failed" || error.code === "refresh_token_reused";
  const options = {
    ...(error.code === "gateway_timeout" || error.code === "codex_auth_refresh_failed" || error.code === "refresh_token_reused"
      ? { type: "server_error" }
      : {}),
    ...(authReauthenticationFailure ? { headers: { "x-uos-warning": CODEX_AUTH_REAUTH_WARNING } } : {}),
  };
  return openaiError(
    error.code === "codex_auth_refresh_failed" || error.code === "refresh_token_reused" ? 503 : error.status,
    error.message,
    error.code,
    options
  );
};

const unreachableUpstreamErrorResponse = (error: unknown, provider?: string | null): Response => {
  const detail = formatErrorSnippet(error);
  const paidProvider = provider === "metered" || provider === "surplus" ? provider : null;
  const providerLabel = paidUpstreamProviderLabel(paidProvider);
  const message = detail ? `${providerLabel} upstream request failed: ${detail}` : `${providerLabel} upstream request failed.`;
  if (paidProvider) {
    return openaiError(502, message, `${paidProvider}_upstream_unreachable`, {
      type: "server_error",
      param: null,
    });
  }
  return openaiError(502, message, "codex_upstream_unreachable");
};

export const toCodexErrorResponse = (error: unknown, provider?: string | null): Response => {
  let response: Response;
  if (error instanceof ApiKeyQuotaDispatchError) {
    response = openaiError(error.status, error.message, error.code, {
      type: error.errorType,
      headers: error.headers,
    });
  } else if (error instanceof CodexError) {
    response = codexUpstreamErrorResponse(error);
  } else {
    response = unreachableUpstreamErrorResponse(error, provider);
  }
  return withUpstreamProviderHeader(response, provider);
};

export const toPreHeaderErrorResponse = (error: unknown, terminalType: ResponseStreamTerminalType, provider?: string | null): Response => {
  if (terminalType === "cancelled") {
    return withUpstreamProviderHeader(
      openaiError(499, "Request was cancelled.", "request_cancelled", {
        type: "server_error",
        param: null,
      }),
      provider
    );
  }
  if (terminalType === "deadline" && !(error instanceof CodexError && error.code === "gateway_timeout")) {
    return withUpstreamProviderHeader(
      openaiError(504, "Upstream request exceeded the gateway deadline.", "gateway_timeout", {
        type: "server_error",
        param: null,
      }),
      provider
    );
  }
  return toCodexErrorResponse(error, provider);
};

export const toCerebrasErrorResponse = (error: unknown): Response => {
  let response: Response;
  if (error instanceof ApiKeyQuotaDispatchError) {
    response = openaiError(error.status, error.message, error.code, {
      type: error.errorType,
      headers: error.headers,
    });
  } else if (error instanceof CerebrasError) {
    response = openaiError(error.status, error.message, error.code, {
      type: error.status >= 500 ? "server_error" : "invalid_request_error",
    });
  } else if (error instanceof Error && error.name === "TimeoutError") {
    response = openaiError(504, "Upstream request exceeded the gateway deadline.", "gateway_timeout", {
      type: "server_error",
    });
  } else if (error instanceof Error && error.name === "AbortError") {
    response = openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error" });
  } else {
    // The adapter deliberately converts provider transport errors to a safe
    // CerebrasError. Keep this fallback content-free as a final guard.
    response = openaiError(502, "Upstream request could not be completed.", "cerebras_upstream_unreachable", {
      type: "server_error",
    });
  }
  return withUpstreamProviderHeader(response, "cerebras");
};

export const cerebrasResponseHeaders = (providerRequestId: string | null, warning?: string): Record<string, string> => ({
  "x-uos-upstream": "cerebras",
  ...(providerRequestId ? { "x-uos-provider-request-id": providerRequestId } : {}),
  ...(warning ? { "x-uos-warning": warning } : {}),
});

export const GPT_OSS_STREAM_DOWNGRADED_WARNING = "gpt_oss_stream_downgraded";

/**
 * The gateway's terminal-validity question, answered once for every
 * translation route: does this accumulated output contain something a client
 * can act on?
 *
 * Assistant text, a refusal, or a tool call is answer-bearing. Reasoning is
 * not: it is streaming progress (`reasoning` on Cerebras, `reasoning_content`
 * on DeepSeek), and a completion whose only output is reasoning hands the
 * client nothing to act on. Providers contribute only the field names their
 * wire shape uses, through the adapters below; they do not re-answer the
 * question, and a route-local copy of this rule must not come back.
 */
export type CompletionAnswerBearingOutput = Readonly<{
  /** Assistant text, in the provider's text field. */
  text: string;
  /** Refusal text, when the provider's shape carries one. */
  refusal?: string;
  /** How many tool calls the output carries. */
  toolCallCount: number;
}>;

export const isAnswerBearingCompletion = (output: CompletionAnswerBearingOutput): boolean =>
  output.text.length > 0 || (output.refusal?.length ?? 0) > 0 || output.toolCallCount > 0;

/**
 * Reads the answer-bearing view out of one Chat Completions `message` or
 * `delta` object. Both wire shapes spell the fields the same way, and the
 * provider-specific reasoning fields are deliberately absent from this view:
 * `reasoning` (Cerebras) and `reasoning_content` (DeepSeek) are streaming
 * progress, and reading either one here is exactly the bug this rule removes.
 */
const answerBearingOutputFromChatFields = (fields: Record<string, unknown>): CompletionAnswerBearingOutput => ({
  text: typeof fields.content === "string" ? fields.content : "",
  refusal: typeof fields.refusal === "string" ? fields.refusal : "",
  toolCallCount: Array.isArray(fields.tool_calls) ? fields.tool_calls.length : 0,
});

const anyAnswerBearingCompletion = (outputs: readonly CompletionAnswerBearingOutput[]): boolean => outputs.some(isAnswerBearingCompletion);

/** Buffered Chat completion: every choice's `message`. */
export const chatCompletionHasAnswerBearingOutput = (completion: Record<string, unknown>): boolean =>
  anyAnswerBearingCompletion(
    (Array.isArray(completion.choices) ? completion.choices : []).flatMap((choice) =>
      isRecord(choice) && !Array.isArray(choice) && isRecord(choice.message) && !Array.isArray(choice.message)
        ? [answerBearingOutputFromChatFields(choice.message)]
        : []
    )
  );

/** Streamed Chat chunk: every choice's `delta`. */
export const chatChunkHasAnswerBearingOutput = (chunk: Record<string, unknown>): boolean =>
  anyAnswerBearingCompletion(
    (Array.isArray(chunk.choices) ? chunk.choices : []).flatMap((choice) =>
      isRecord(choice) && !Array.isArray(choice) && isRecord(choice.delta) && !Array.isArray(choice.delta)
        ? [answerBearingOutputFromChatFields(choice.delta)]
        : []
    )
  );

const cerebrasChatToolCallDeltas = (toolCalls: readonly unknown[]): Record<string, unknown>[] =>
  toolCalls.flatMap((toolCall, toolCallIndex) => {
    if (!isRecord(toolCall) || Array.isArray(toolCall)) return [];
    const fn = isRecord(toolCall.function) && !Array.isArray(toolCall.function) ? toolCall.function : null;
    if (!fn) return [];
    return [
      {
        index: toolCallIndex,
        id: toolCall.id,
        type: "function",
        function: {
          name: fn.name,
          arguments: fn.arguments,
        },
      },
    ];
  });

const cerebrasChatDelta = (message: Record<string, unknown>): Record<string, unknown> => {
  const delta: Record<string, unknown> = { role: "assistant" };
  // Native Cerebras stream deltas carry reasoning in the leading chunk;
  // mirror that 1:1 (compliance D1) instead of dropping it.
  if (typeof message.reasoning === "string" && message.reasoning) delta.reasoning = message.reasoning;
  if (typeof message.content === "string") delta.content = message.content;
  if (typeof message.refusal === "string" && message.refusal) delta.refusal = message.refusal;

  if (Array.isArray(message.tool_calls)) {
    delta.tool_calls = cerebrasChatToolCallDeltas(message.tool_calls);
  }

  return delta;
};

export const streamCerebrasChatCompletion = (completion: Record<string, unknown>, includeUsage: boolean, headers: HeadersInit): Response => {
  const id = getString(completion.id) ?? `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  const created = typeof completion.created === "number" ? completion.created : Math.floor(Date.now() / 1000);
  const model = getString(completion.model) ?? CEREBRAS_GPT_OSS_120B_MODEL;
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  const events: string[] = [];
  const appendEvent = (value: Record<string, unknown>): void => {
    events.push(`data: ${JSON.stringify(value)}\n\n`);
  };

  for (const [choiceIndex, value] of choices.entries()) {
    if (!isRecord(value) || Array.isArray(value)) continue;
    const index = typeof value.index === "number" ? value.index : choiceIndex;
    const message = isRecord(value.message) && !Array.isArray(value.message) ? value.message : {};
    const delta = cerebrasChatDelta(message);

    appendEvent({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index, delta, finish_reason: null }],
    });
    appendEvent({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index, delta: {}, finish_reason: getString(value.finish_reason) ?? "stop" }],
    });
  }

  if (includeUsage && completion.usage !== undefined) {
    appendEvent({ id, object: "chat.completion.chunk", created, model, choices: [], usage: completion.usage });
  }
  events.push("data: [DONE]\n\n");

  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "text/event-stream");
  responseHeaders.set("Cache-Control", "no-cache");
  return new Response(events.join(""), { status: 200, headers: responseHeaders });
};

type UpstreamErrorDetails = Readonly<{
  message: string;
  type?: string;
  code?: string;
  param?: string | null;
}>;

const readUpstreamErrorBody = async (upstream: Response, signal: AbortSignal): Promise<Readonly<{ text: string; complete: boolean }>> => {
  const { bytes, complete } = await readBoundedResponseBody(upstream, {
    signal,
    cancellationReason: "Upstream error body captured",
  });
  // Error normalization must never surface a partial provider payload.
  return complete ? { text: new TextDecoder().decode(bytes), complete: true } : { text: "", complete: false };
};

const getJsonString = (value: unknown, key: string): string | null => {
  if (!isRecord(value)) return null;
  const stringValue = getString(value[key]);
  // Absent and blank values both mean "no string", so the falsy check stays.
  const trimmed = stringValue?.trim();
  if (trimmed === undefined || trimmed === "") return null;
  return trimmed;
};

const upstreamErrorDetailsFromParsedJson = (parsed: unknown): UpstreamErrorDetails | null => {
  if (!isRecord(parsed)) return null;
  const error = isRecord(parsed.error) ? parsed.error : null;
  const message = getJsonString(error, "message") ?? getJsonString(parsed, "detail") ?? getJsonString(parsed, "message");
  if (!message) return null;
  const details: UpstreamErrorDetails = {
    message,
    type: getJsonString(error, "type") ?? getJsonString(parsed, "type") ?? undefined,
    code: getJsonString(error, "code") ?? getJsonString(parsed, "code") ?? undefined,
  };
  return error && Object.prototype.hasOwnProperty.call(error, "param") ? { ...details, param: getString(error.param) ?? null } : details;
};

const parseUpstreamErrorDetails = (text: string, statusText: string): UpstreamErrorDetails => {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const details = upstreamErrorDetailsFromParsedJson(parsed);
      if (details) return details;
    } catch {
      // Non-JSON bodies are normalized as plain text below.
    }
  }

  const snippet = trimmed ? formatErrorSnippet(trimmed) : "";
  return { message: snippet || statusText || "Upstream request failed." };
};

const upstreamStatusToErrorType = (status: number, upstreamType?: string): string => {
  if (upstreamType) return upstreamType;
  if (status >= 500) return "server_error";
  return status === 429 ? "rate_limit_error" : "invalid_request_error";
};

export const toOpenAiUpstreamErrorResponse = async (upstream: Response, provider: UpstreamProvider, signal: AbortSignal): Promise<Response> => {
  const captured = await readUpstreamErrorBody(upstream, signal);
  const details = captured.complete
    ? parseUpstreamErrorDetails(captured.text, upstream.statusText)
    : { message: "Upstream returned an oversized or incomplete error response." };
  const headers: Record<string, string> = { "x-uos-upstream": provider };
  // A debug scenario sets its own header so an operator can confirm which
  // forced path produced a response. This function rebuilds the header set
  // from scratch for a non-2xx upstream, so it has to carry that field
  // explicitly or the scenario name is silently lost before the client sees it.
  const debugScenario = upstream.headers.get("x-uos-debug-scenario");
  if (debugScenario) headers["x-uos-debug-scenario"] = debugScenario;
  const warning = upstream.headers.get("x-uos-warning");
  const hasAuthWarning =
    warning
      ?.split(",")
      .map((value) => value.trim())
      .includes(CODEX_AUTH_REAUTH_WARNING) === true;
  if (warning) headers["x-uos-warning"] = warning;
  const retryAfter = upstream.headers.get("Retry-After");
  if (retryAfter) headers["Retry-After"] = retryAfter;
  const message = hasAuthWarning && !captured.text.includes(CODEX_AUTH_REAUTH_MESSAGE) ? `${details.message} ${CODEX_AUTH_REAUTH_MESSAGE}` : details.message;
  const options: { type?: string; param?: string | null; headers: HeadersInit } = {
    type: hasAuthWarning && upstream.status >= 500 ? "server_error" : upstreamStatusToErrorType(upstream.status, details.type),
    headers,
  };
  if (Object.prototype.hasOwnProperty.call(details, "param")) options.param = details.param ?? null;
  return openaiError(upstream.status, message, details.code ?? "upstream_error", options);
};

export const cancelResponseBody = (response: Response): void => {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => {});
  } catch {
    // The response may already be closed.
  }
};

// Special-provider error responses can contain provider-specific diagnostics.
// Preserve the HTTP semantics clients need and forward ONLY the standard
// OpenAI error fields (message/code, bounded + whitelisted) so 1:1 behavior is
// debuggable (compliance D2) — never reflect the arbitrary upstream body.
const UPSTREAM_ERROR_MESSAGE_MAX = 1_000;
const UPSTREAM_ERROR_CODE_MAX = 200;

const parseUpstreamErrorDetail = (body: unknown): { message?: string; code?: string } => {
  if (!isRecord(body) || Array.isArray(body)) return {};
  const error = isRecord(body.error) && !Array.isArray(body.error) ? body.error : null;
  const pickString = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.slice(0, max).trim();
    return trimmed ? trimmed : undefined;
  };
  return {
    message: pickString(error?.message ?? body.message, UPSTREAM_ERROR_MESSAGE_MAX),
    code: pickString(error?.code ?? body.code, UPSTREAM_ERROR_CODE_MAX),
  };
};

export const toCerebrasUpstreamErrorResponse = async (upstream: Response, signal?: AbortSignal): Promise<Response> => {
  // Read the error body under the shared bounded ceiling (64 KiB / 1 s) so a
  // stalled upstream cannot extend the gateway request; only message/code are
  // ever forwarded.
  let detail: { message?: string; code?: string } = {};
  try {
    const captured = await readBoundedResponseBody(upstream, {
      signal,
      maxBytes: BOUNDED_RESPONSE_BODY_MAX_BYTES,
      timeoutMs: BOUNDED_RESPONSE_BODY_TIMEOUT_MS,
      cancellationReason: "Cerebras upstream error body",
    });
    if (captured.complete && captured.bytes.length > 0) {
      try {
        detail = parseUpstreamErrorDetail(JSON.parse(new TextDecoder().decode(captured.bytes)) as unknown);
      } catch {
        // Non-JSON error body: keep the generic message (never reflect it).
      }
    }
  } catch {
    // Bounded read failure must not change the error semantics.
  } finally {
    cancelResponseBody(upstream);
  }
  const headers = cerebrasResponseHeaders(getCerebrasProviderRequestId(upstream));
  const retryAfter = upstream.headers.get("Retry-After");
  if (retryAfter) headers["Retry-After"] = retryAfter;
  if (upstream.status === 429) {
    for (const header of CEREBRAS_RATE_LIMIT_HEADERS) {
      const value = upstream.headers.get(header);
      if (value !== null) headers[header] = value;
    }
  }
  return openaiError(upstream.status, detail.message ?? "Cerebras upstream returned an error.", detail.code ?? "cerebras_upstream_error", {
    type: upstream.status === 408 ? "server_error" : upstreamStatusToErrorType(upstream.status),
    headers,
  });
};

export const toDeepSeekErrorResponse = (error: unknown): Response => {
  let response: Response;
  if (error instanceof ApiKeyQuotaDispatchError) {
    response = openaiError(error.status, error.message, error.code, {
      type: error.errorType,
      headers: error.headers,
    });
  } else if (error instanceof DeepSeekError) {
    response = openaiError(error.status, error.message, error.code, {
      type: error.status >= 500 ? "server_error" : "invalid_request_error",
    });
  } else if (error instanceof Error && error.name === "TimeoutError") {
    response = openaiError(504, "Upstream request exceeded the gateway deadline.", "gateway_timeout", {
      type: "server_error",
    });
  } else if (error instanceof Error && error.name === "AbortError") {
    response = openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error" });
  } else {
    // The adapter deliberately converts provider transport errors to a safe
    // DeepSeekError. Keep this fallback content-free as a final guard.
    response = openaiError(502, "Upstream request could not be completed.", "deepseek_upstream_unreachable", {
      type: "server_error",
    });
  }
  return withUpstreamProviderHeader(response, "deepseek");
};

export const deepseekResponseHeaders = (providerRequestId: string | null): Record<string, string> => ({
  "x-uos-upstream": "deepseek",
  ...(providerRequestId ? { "x-uos-provider-request-id": providerRequestId } : {}),
});

// DeepSeek documents no `x-ratelimit-*` response headers: its capacity model is
// concurrency based and surfaces as HTTP 429, so unlike Cerebras there is no
// provider capacity header list to forward.

/**
 * The LithosAI route's response headers. This provider publishes NO request-id
 * header at all, so the correlation field is normally absent; the seam exists so
 * the day a vendor sends one it has exactly one place to land.
 */
export const lithosResponseHeaders = (providerRequestId: string | null): Record<string, string> => ({
  "x-uos-upstream": "lithos",
  ...(providerRequestId ? { "x-uos-provider-request-id": providerRequestId } : {}),
});

export const openRouterResponseHeaders = (providerRequestId: string | null): Record<string, string> => ({
  "x-uos-upstream": "openrouter",
  ...(providerRequestId ? { "x-uos-provider-request-id": providerRequestId } : {}),
});

export const toLithosErrorResponse = (error: unknown): Response => {
  let response: Response;
  if (error instanceof ApiKeyQuotaDispatchError) {
    response = openaiError(error.status, error.message, error.code, {
      type: error.errorType,
      headers: error.headers,
    });
  } else if (error instanceof LithosError) {
    response = openaiError(error.status, error.message, error.code, {
      type: error.status >= 500 ? "server_error" : "invalid_request_error",
    });
  } else if (error instanceof Error && error.name === "TimeoutError") {
    response = openaiError(504, "Upstream request exceeded the gateway deadline.", "gateway_timeout", {
      type: "server_error",
    });
  } else if (error instanceof Error && error.name === "AbortError") {
    response = openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error" });
  } else {
    // The adapter deliberately converts provider transport errors to a safe
    // LithosError. Keep this fallback content-free as a final guard.
    response = openaiError(502, "Upstream request could not be completed.", "lithos_upstream_unreachable", {
      type: "server_error",
    });
  }
  const translated = withUpstreamProviderHeader(response, "lithos");
  return translated.status === 504 ? markGatewayDeadlineResponse(translated) : translated;
};

/**
 * The provider's documented final 4xx statuses. This route never retries a
 * dispatch (there is no failover, race, or backoff loop on it), and the
 * `x-should-retry: false` header states the same contract to a downstream
 * client so a caller does not turn "out of credit" or "unknown model" into a
 * retry storm.
 */
const LITHOS_TERMINAL_UPSTREAM_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 404]);

/** The three per-minute budgets whose name rides `error.type` on a 429. */
const LITHOS_RATE_LIMIT_BUDGET_TYPES: ReadonlySet<string> = new Set(["requests", "input_tokens", "output_tokens"]);

const LITHOS_PROVIDER_OVERLOADED_TYPE = "provider_overloaded";

type LithosUpstreamErrorDetail = Readonly<{ message: string | null; type: string | null; code: string | null }>;

/**
 * One bounded, trimmed text field. The engine-parameter envelope carries an
 * INTEGER `code`, so a safe integer is accepted and rendered as its own digits
 * rather than being dropped; anything else is not a code this route can state.
 */
const lithosErrorTextField = (value: unknown, maxChars: number): string | null => {
  if (typeof value === "string") {
    const trimmed = value.slice(0, maxChars).trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
};

/**
 * Reads either error envelope this provider is documented to send:
 *
 * 1. `{"error":{"message":…,"type":…,"code":…}}` for auth, validation and
 *    model failures.
 * 2. `{"object":"error","message":…,"type":"BadRequestError","code":400}` with
 *    an INTEGER `code` for engine parameter violations.
 *
 * A non-JSON body is tolerated instead of throwing: the error path may not
 * itself fail, and nothing from the body is reflected as a code unless it is
 * already a string or a safe integer.
 */
const parseLithosUpstreamErrorDetail = (text: string): LithosUpstreamErrorDetail => {
  try {
    const parsed: unknown = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || Array.isArray(parsed)) return { message: null, type: null, code: null };
    const error = isRecord(parsed.error) && !Array.isArray(parsed.error) ? parsed.error : null;
    return {
      message: lithosErrorTextField(error?.message ?? parsed.message, UPSTREAM_ERROR_MESSAGE_MAX),
      type: lithosErrorTextField(error?.type ?? parsed.type, UPSTREAM_ERROR_CODE_MAX),
      code: lithosErrorTextField(error?.code ?? parsed.code, UPSTREAM_ERROR_CODE_MAX),
    };
  } catch {
    return { message: null, type: null, code: null };
  }
};

/**
 * The client-visible code for one upstream refusal. The vendor semantics are
 * kept distinct rather than collapsed into one generic upstream error:
 *
 * - `402` is out of credit; the vendor's own code is carried when present.
 * - `404` is an unknown model.
 * - `429` is split by `error.type`: a per-minute budget (`requests`,
 *   `input_tokens`, `output_tokens`) becomes `rate_limit_exceeded`, while a
 *   model at capacity becomes `provider_overloaded`. A 429 whose body names
 *   neither is reported as the more common budget case.
 * - Everything else keeps the vendor's code, falling back to the route's own.
 */
const lithosUpstreamErrorCode = (status: number, detail: LithosUpstreamErrorDetail): string => {
  if (status === 429) {
    return detail.type === LITHOS_PROVIDER_OVERLOADED_TYPE || detail.code === LITHOS_PROVIDER_OVERLOADED_TYPE
      ? LITHOS_PROVIDER_OVERLOADED_TYPE
      : "rate_limit_exceeded";
  }
  if (status === 402) return detail.code ?? "insufficient_quota";
  if (status === 401 || status === 403) return detail.code ?? "auth_invalid";
  if (status === 404) return detail.code ?? "model_not_found";
  // `error.type` names the refusing budget when the vendor sends only that, so
  // it is a legitimate code source when `code` itself is absent.
  if (detail.code) return detail.code;
  if (detail.type && LITHOS_RATE_LIMIT_BUDGET_TYPES.has(detail.type)) return "rate_limit_exceeded";
  return "lithos_upstream_error";
};

/** One provider's refusal type. `402` and `429` are distinct on this wire. */
const lithosUpstreamErrorType = (status: number): string => {
  if (status === 402) return "insufficient_quota";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
};

export const toLithosUpstreamErrorResponse = async (upstream: Response, signal?: AbortSignal, bodyDiagnostic?: Record<string, unknown>): Promise<Response> => {
  // Read the error body under the shared bounded ceiling (64 KiB / 1 s) so a
  // stalled upstream cannot extend the gateway request; only message and code
  // are ever forwarded.
  let detail: LithosUpstreamErrorDetail = { message: null, type: null, code: null };
  try {
    const captured = await readBoundedResponseBody(upstream, {
      signal,
      maxBytes: BOUNDED_RESPONSE_BODY_MAX_BYTES,
      timeoutMs: BOUNDED_RESPONSE_BODY_TIMEOUT_MS,
      cancellationReason: "LithosAI upstream error body",
    });
    if (captured.complete && captured.bytes.length > 0) {
      detail = parseLithosUpstreamErrorDetail(new TextDecoder().decode(captured.bytes));
    }
  } catch {
    // Bounded read failure must not change the error semantics.
  } finally {
    cancelResponseBody(upstream);
  }
  const headers = lithosResponseHeaders(getLithosProviderRequestId(upstream));
  // Every admitted response and every refusal carries the capacity headers, so
  // a 429 forwards them the way the Cerebras branch forwards its own list. The
  // two retry hints keep the vendor's spelling and precedence: `retry-after-ms`
  // first, then `retry-after`.
  if (upstream.status === 429) {
    for (const header of LITHOS_RATE_LIMIT_HEADERS) {
      const value = upstream.headers.get(header);
      if (value !== null) headers[header] = value;
    }
    const retryAfterMs = upstream.headers.get("retry-after-ms");
    if (retryAfterMs !== null) headers["retry-after-ms"] = retryAfterMs;
  }
  const retryAfter = upstream.headers.get("Retry-After");
  if (retryAfter) headers["Retry-After"] = retryAfter;
  // A vendor instruction always wins; otherwise the documented terminal
  // statuses are marked non-retryable explicitly, and 402 is the one that
  // matters most: out of credit is never a transient condition.
  const upstreamShouldRetry = upstream.headers.get("x-should-retry");
  if (upstreamShouldRetry !== null) headers["x-should-retry"] = upstreamShouldRetry;
  else if (LITHOS_TERMINAL_UPSTREAM_STATUSES.has(upstream.status)) headers["x-should-retry"] = "false";
  const code = lithosUpstreamErrorCode(upstream.status, detail);
  // Bounded provider diagnostics: the gateway forwards this message to the
  // client, so it must also appear in the server log to be debuggable.
  console.warn(
    "[ai.ubq.fi] lithos_upstream_error",
    JSON.stringify({ status: upstream.status, code, message: detail.message ?? null, request: bodyDiagnostic ?? null })
  );
  const response = openaiError(upstream.status, detail.message ?? "LithosAI upstream returned an error.", code, {
    type: lithosUpstreamErrorType(upstream.status),
    headers,
  });
  return upstream.status === 504 ? markUpstreamRefusalResponse(response) : response;
};
const diagnosticReasoningLabel = (value: unknown): string => {
  if (typeof value !== "string") return "absent";
  return value ? "present" : "empty";
};

const diagnosticContentLabel = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  return Array.isArray(value) ? "parts" : typeof value;
};

const CHAT_BODY_DIAGNOSTIC_MESSAGE_LIMIT = 16;
const CHAT_BODY_DIAGNOSTIC_MODELS: readonly string[] = [...DEEPSEEK_OFFICIAL_MODEL_IDS, ...LITHOS_MODEL_IDS];
const diagnosticKnownString = (value: unknown, known: readonly string[]): string | null => (typeof value === "string" && known.includes(value) ? value : null);

/**
 * Bounded, content-free digest of a projected DeepSeek Chat body. Upstream 4xx
 * answers are client-visible but were previously opaque in the server log: a
 * production HTTP 400 was only diagnosable by reading the client's rollout file.
 * Message text, tool names, arguments, and ids are deliberately excluded — the
 * digest carries shapes, not prompts. Only the final 16 message positions are
 * projected; fixed vocabularies and scalar counts bound nested metadata and
 * serialization independently of history and content-part sizes.
 */
export const deepSeekChatBodyDiagnostic = (body: Record<string, unknown>): Record<string, unknown> => {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = messages.findLastIndex((message) => isRecord(message) && message.role === "user");
  const omittedMessages = Math.max(0, messages.length - CHAT_BODY_DIAGNOSTIC_MESSAGE_LIMIT);
  return {
    model: diagnosticKnownString(body.model, CHAT_BODY_DIAGNOSTIC_MODELS),
    reasoning_effort: diagnosticKnownString(body.reasoning_effort, ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
    stream: body.stream === true,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    tool_choice: diagnosticKnownString(body.tool_choice, ["auto", "none", "required"]),
    max_tokens: typeof body.max_tokens === "number" && Number.isSafeInteger(body.max_tokens) ? body.max_tokens : null,
    message_count: messages.length,
    last_user_index: lastUser,
    omitted_message_count: omittedMessages,
    messages: messages.slice(omittedMessages).map((value, offset) => {
      const message = isRecord(value) ? value : {};
      const index = omittedMessages + offset;
      return {
        index,
        role: diagnosticKnownString(message.role, ["system", "developer", "user", "assistant", "tool", "function"]),
        reasoning: diagnosticReasoningLabel(message.reasoning_content),
        tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
        content: diagnosticContentLabel(message.content),
        after_last_user: index > lastUser,
      };
    }),
  };
};

export const toDeepSeekUpstreamErrorResponse = async (
  upstream: Response,
  signal?: AbortSignal,
  bodyDiagnostic?: Record<string, unknown>
): Promise<Response> => {
  // Read the error body under the shared bounded ceiling (64 KiB / 1 s) so a
  // stalled upstream cannot extend the gateway request; only message/code are
  // ever forwarded.
  let detail: { message?: string; code?: string } = {};
  try {
    const captured = await readBoundedResponseBody(upstream, {
      signal,
      maxBytes: BOUNDED_RESPONSE_BODY_MAX_BYTES,
      timeoutMs: BOUNDED_RESPONSE_BODY_TIMEOUT_MS,
      cancellationReason: "DeepSeek upstream error body",
    });
    if (captured.complete && captured.bytes.length > 0) {
      try {
        detail = parseUpstreamErrorDetail(JSON.parse(new TextDecoder().decode(captured.bytes)) as unknown);
      } catch {
        // Non-JSON error body: keep the generic message (never reflect it).
      }
    }
  } catch {
    // Bounded read failure must not change the error semantics.
  } finally {
    cancelResponseBody(upstream);
  }
  const headers = deepseekResponseHeaders(getDeepSeekProviderRequestId(upstream));
  const retryAfter = upstream.headers.get("Retry-After");
  if (retryAfter) headers["Retry-After"] = retryAfter;
  // Bounded provider diagnostics: the gateway forwards this message to the
  // client, so it must also appear in the server log to be debuggable.
  console.warn(
    "[ai.ubq.fi] deepseek_upstream_error",
    JSON.stringify({ status: upstream.status, code: detail.code ?? null, message: detail.message ?? null, request: bodyDiagnostic ?? null })
  );
  return openaiError(upstream.status, detail.message ?? "DeepSeek upstream returned an error.", detail.code ?? "deepseek_upstream_error", {
    type: upstream.status === 408 ? "server_error" : upstreamStatusToErrorType(upstream.status),
    headers,
  });
};

export const apiKeyQuotaDispatchErrorResponse = (error: ApiKeyQuotaDispatchError): Response =>
  openaiError(error.status, error.message, error.code, {
    type: error.errorType,
    param: null,
    headers: error.headers,
  });
import {} from "./input-normalization.ts";
import {} from "./chat/stream-translation.ts";
