// DeepSeek Chat and Responses handlers and support, extracted from src/openai.ts.

import {
  DEEPSEEK_DEFAULT_REASONING_EFFORT,
  DEEPSEEK_FLASH_MODEL,
  deepSeekDefaultOutputAllowance,
  deepSeekThinkingToolChoiceConflict,
  deepSeekToolChoiceThinkingConflictMessage,
  deepSeekUpstreamModelFor,
  normalizeDeepSeekProviderRequestId,
} from "./index.ts";
import { type DeepSeekResponsesEcho, toDeepSeekResponsesPayload } from "./responses-payload.ts";
import { logForwardedPayloadElisions, toDeepSeekResponsesChatBody } from "./chat-projection.ts";
import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { json, openaiError } from "../http.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "../inference-deadline.ts";
import { isRecord } from "../utils.ts";
import { type UsageContext, extractChatUsageTokens, recordCompletionUsage, recordRequestUsage, recordStreamTerminalType } from "../openai-telemetry.ts";
import { markChatSemanticOutput } from "../chat/stream-translation.ts";
import { chatCompletionHasAnswerBearingOutput, deepseekResponseHeaders } from "../upstream-wire.ts";
import { parseStreamField, withUosWarning } from "../request-policy.ts";
import { relayResponsesStream } from "../provider/stream-relay.ts";
import { downstreamSignalFor, inferenceSignal } from "../openai.ts";
import {
  DeepSeekError,
  deepSeekThinkingModeActive,
  fetchDeepSeekChatCompletions,
  getDeepSeekProviderRequestId,
  normalizeDeepSeekChatCompletion,
} from "./index.ts";
import { DeepSeekStreamError, iterateDeepSeekChatCompletionStream } from "./stream.ts";
import { DEEPSEEK_RESPONSES_PROFILE, type OriginalToolName } from "./responses.ts";
import { ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { recordDeepSeekProviderHealth } from "../provider/health.ts";
import {
  type ResponseStreamTerminalType,
  type UsageTokens,
  recordAttemptedProvider,
  recordErrorUsage,
  recordFirstProviderDispatch,
  recordFirstProviderHeaders,
  recordStreamTerminal,
  recordTerminalUsage,
} from "../openai-telemetry.ts";
import { EMPTY_UPSTREAM_COMPLETION_MESSAGE } from "../chat/stream-translation.ts";
import { deepSeekChatBodyDiagnostic, toDeepSeekErrorResponse, toDeepSeekUpstreamErrorResponse } from "../upstream-wire.ts";
import { parseChatStreamOptions, parseMaxCompletionTokensField, parseReasoningEffortField } from "../request-policy.ts";

export const recordDeepSeekResponseHealth = (status: number, providerRequestId: string | null): void => {
  if (status === 401 || status === 403) {
    void recordDeepSeekProviderHealth("auth_invalid", status, Date.now, providerRequestId);
    return;
  }
  if (status === 429) {
    void recordDeepSeekProviderHealth("quota_exhausted", status, Date.now, providerRequestId);
    return;
  }
  if (status >= 500) {
    void recordDeepSeekProviderHealth("upstream_error", status, Date.now, providerRequestId);
    return;
  }
  if (status >= 400) {
    void recordDeepSeekProviderHealth("reachable", status, Date.now, providerRequestId);
    return;
  }
  void recordDeepSeekProviderHealth("success", status, Date.now, providerRequestId);
};

/**
 * Provider health for the LithosAI route.
 *
 * `402 insufficient_quota` gets its own explicit branch instead of falling into
 * the generic failure bucket. It is still a quota event (`quota_exhausted`), but
 * the recorded status keeps "out of credit" distinguishable from "rate
 * limited", and unlike a 429 it is terminal for the account rather than a
 * transient per-minute budget. The comparison statuses are the vendor's own:
 * `401`/`403` are auth, `>=500` is an upstream fault, any other `4xx` is a
 * reachable provider answering a client-shaped error.
 */

/**
 * Fails a buffered DeepSeek Responses completion closed when the provider
 * reported success but the translated output carries nothing a client can act
 * on. This is the buffered counterpart of the streamed G3 guard: one request
 * shape must not report success on one transport and failure on the other.
 *
 * Response headers are still unsent on this branch, so the client gets the
 * ordinary `empty_upstream_completion` 502 the non-DeepSeek routes already
 * return rather than a synthetic terminal event.
 */
export const respondDeepSeekEmptyBufferedCompletion = (
  usageContext: UsageContext | undefined,
  usage: UsageTokens | null,
  upstreamStatus: number,
  providerRequestId: string | null
): Response => {
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.failureKind = "empty_upstream_completion";
    usageContext.responseTelemetry.semanticOutputObserved = false;
  }
  recordTerminalUsage(usageContext, usage, false);
  recordStreamTerminalType(usageContext, "response.failed");
  recordDeepSeekResponseHealth(upstreamStatus, providerRequestId);
  return openaiError(502, EMPTY_UPSTREAM_COMPLETION_MESSAGE, "empty_upstream_completion", {
    type: "server_error",
    headers: deepseekResponseHeaders(providerRequestId),
  });
};

/**
 * Records a buffered DeepSeek Responses terminal. The payload carries the
 * provider's own terminal, so telemetry reports the terminal the client
 * receives instead of assuming success, and the non-completed classification
 * matches the streamed path.
 *
 * `completed` is derived from that same terminal: recording the usage counters
 * as a completion before reading the payload's status would persist a
 * truncated reply as a completed one.
 */
export const recordBufferedDeepSeekResponsesTerminal = (
  usageContext: UsageContext | undefined,
  payload: Record<string, unknown>,
  usage: UsageTokens | null,
  upstreamStatus: number,
  providerRequestId: string | null
): void => {
  const terminalType = deepSeekTerminalTypeForPayload(payload.status);
  recordTerminalUsage(usageContext, usage, terminalType === "response.completed");
  recordStreamTerminalType(usageContext, terminalType);
  if (terminalType === "response.completed") {
    recordStreamTerminal(usageContext);
  } else {
    recordDeepSeekFailureKind(usageContext, terminalType === "response.incomplete" ? "incomplete_response" : "upstream_error");
    void recordDeepSeekProviderHealth("upstream_error", upstreamStatus, Date.now, providerRequestId);
  }
  recordDeepSeekResponseHealth(upstreamStatus, providerRequestId);
};

/** The gateway terminal a buffered DeepSeek Responses payload's status implies. */
export const deepSeekTerminalTypeForPayload = (status: unknown): ResponseStreamTerminalType => {
  if (status === "incomplete") return "response.incomplete";
  if (status === "failed") return "response.failed";
  return "response.completed";
};

const deepSeekTerminalTypeForError = (error: unknown, downstreamSignal: AbortSignal): ResponseStreamTerminalType => {
  if (downstreamSignal.aborted) return "cancelled";
  if (error instanceof DeepSeekStreamError) {
    if (error.kind === "inactivity_timeout") return "deadline";
    if (error.kind === "premature_eof") return "eof";
    return "error";
  }
  if (error instanceof DeepSeekError && error.status === 504) return "deadline";
  if (error instanceof Error && error.name === "TimeoutError") return "deadline";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "error";
};

type DeepSeekFailureKind =
  | "upstream_error"
  | "upstream_http_error"
  | "upstream_unreachable"
  | "incomplete_response"
  | "invalid_json"
  | "invalid_completion_schema"
  | "invalid_stream_chunk"
  | "deadline"
  | "cancellation"
  | "api_key_quota_reservation_unavailable"
  | "deepseek_api_key_missing"
  | "deepseek_request_invalid"
  /** A stop reason the gateway cannot place in its terminal vocabulary. */
  | `deepseek_finish_reason:${string}`;

const recordDeepSeekFailureKind = (context: UsageContext | undefined, failureKind: DeepSeekFailureKind): void => {
  if (context?.responseTelemetry) context.responseTelemetry.failureKind = failureKind;
};

/**
 * The telemetry classification for an upstream stop reason the gateway cannot
 * place. The value is bounded and carried so an operator can see exactly what
 * the provider said instead of reading a normal completion.
 */
const deepSeekFinishReasonFailureKind = (finishReason: string | null): DeepSeekFailureKind =>
  `deepseek_finish_reason:${finishReason !== null && /^[A-Za-z0-9_.:-]{1,64}$/.test(finishReason) ? finishReason : "unrecognized"}`;

const deepSeekTransportFailureKind = (error: unknown, terminalType: ResponseStreamTerminalType): DeepSeekFailureKind => {
  if (terminalType === "cancelled") return "cancellation";
  if (terminalType === "deadline") return "deadline";
  if (terminalType === "eof") return "incomplete_response";
  if (error instanceof ApiKeyQuotaDispatchError) return "api_key_quota_reservation_unavailable";
  if (error instanceof DeepSeekStreamError) {
    switch (error.kind) {
      case "malformed_event":
        return "invalid_json";
      case "invalid_chunk":
        return "invalid_stream_chunk";
      case "premature_eof":
        return "incomplete_response";
      case "inactivity_timeout":
        return "deadline";
      default:
        break;
    }
  }
  if (error instanceof DeepSeekError) {
    switch (error.code) {
      case "deepseek_api_key_missing":
        return "deepseek_api_key_missing";
      case "deepseek_request_invalid":
        return "deepseek_request_invalid";
      case "deepseek_upstream_unreachable":
        return "upstream_unreachable";
      case "gateway_timeout":
        return "deadline";
      default:
        break;
    }
  }
  return "upstream_unreachable";
};

export const DEEPSEEK_BUFFERED_BODY_MAX_BYTES = 8 * 1024 * 1024;

export const validateDeepSeekChatRequestFields = (
  rawRecord: Record<string, unknown>
): { ok: true; value: { reasoning: string; clientWantsStream: boolean } } | { ok: false; response: Response } => {
  const messages = rawRecord.messages;
  if (!Array.isArray(messages)) return { ok: false, response: openaiError(400, "messages must be an array", "invalid_request_error") };
  if (messages.length === 0) {
    return { ok: false, response: openaiError(400, "messages must be a non-empty array", "invalid_request_error") };
  }
  if (messages.some((message) => !isRecord(message) || Array.isArray(message))) {
    return { ok: false, response: openaiError(400, "messages must contain objects", "invalid_request_error", { param: "messages" }) };
  }
  // Unlike Cerebras, DeepSeek documents every tier the gateway can carry,
  // including `none` (which disables thinking mode), so no tier is rejected
  // locally here.
  const reasoningEffort = parseReasoningEffortField(rawRecord.reasoning_effort, "reasoning_effort");
  if (!reasoningEffort.ok) {
    return { ok: false, response: openaiError(400, reasoningEffort.message, "invalid_request_error", { param: "reasoning_effort" }) };
  }
  const parsedStream = parseStreamField(rawRecord.stream);
  if (!parsedStream.ok) {
    return { ok: false, response: openaiError(400, parsedStream.message, "invalid_request_error", { param: "stream" }) };
  }
  const streamOptions = parseChatStreamOptions(rawRecord.stream_options);
  if (!streamOptions.ok) {
    return { ok: false, response: openaiError(400, streamOptions.message, "invalid_request_error", { param: "stream_options" }) };
  }
  return {
    ok: true,
    value: {
      // DeepSeek's documented default is thinking mode enabled at effort
      // `high`. Sending it explicitly keeps the wire and the gateway's
      // reasoning telemetry in agreement without changing provider behavior.
      //
      // A first-party client may instead send the provider's own
      // `thinking: { type }` switch. That field is authoritative for whether
      // thinking is on, so it resolves the effort here rather than being
      // forwarded beside a contradictory default: `disabled` becomes `none`
      // (the documented equivalent this gateway already sends, see the Delta 5
      // entry in docs/DECISIONS.md) and an explicit `reasoning_effort` still
      // wins when thinking is enabled.
      reasoning:
        reasoningEffort.value === undefined && !deepSeekThinkingModeActive(undefined, rawRecord.thinking)
          ? "none"
          : (reasoningEffort.value ?? DEEPSEEK_DEFAULT_REASONING_EFFORT),
      clientWantsStream: parsedStream.value,
    },
  };
};

/** The output cap the client supplied on the DeepSeek Chat contract, if any. */
export const deepSeekChatClientOutputAllowance = (rawRecord: Record<string, unknown>): number | null => {
  // `max_completion_tokens` is the documented OpenAI field and the one
  // `projectDeepSeekRequest` maps onto the provider's `max_tokens`; a literal
  // `max_tokens` in the record is forwarded unchanged, so both are real caps.
  const completionTokens = parseMaxCompletionTokensField(rawRecord.max_completion_tokens);
  if (!completionTokens.ok) return null;
  if (completionTokens.value !== undefined) return completionTokens.value;
  const maxTokens = parseMaxCompletionTokensField(rawRecord.max_tokens);
  return maxTokens.ok ? (maxTokens.value ?? null) : null;
};

const respondDeepSeekChatInvalidCompletion = async (
  failureKind: "invalid_json" | "invalid_completion_schema",
  upstreamStatus: number,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined
): Promise<Response> => {
  recordStreamTerminalType(usageContext, "error");
  recordDeepSeekFailureKind(usageContext, failureKind);
  void recordDeepSeekProviderHealth("upstream_error", upstreamStatus, Date.now, providerRequestId);
  await recordErrorUsage(usageContext);
  return openaiError(502, "Upstream returned an invalid Chat Completions response.", "deepseek_upstream_invalid_response", {
    type: "server_error",
    headers: deepseekResponseHeaders(providerRequestId),
  });
};

export const readDeepSeekChatCompletion = async (
  bytes: Uint8Array,
  upstreamStatus: number,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  upstreamModel: string
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> => {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, response: await respondDeepSeekChatInvalidCompletion("invalid_json", upstreamStatus, providerRequestId, usageContext) };
  }
  const normalized = normalizeDeepSeekChatCompletion(payload, upstreamModel);
  if (!normalized.ok) {
    return { ok: false, response: await respondDeepSeekChatInvalidCompletion("invalid_completion_schema", upstreamStatus, providerRequestId, usageContext) };
  }
  return { ok: true, value: normalized.value };
};

const respondDeepSeekChatDispatchFailure = async (error: unknown, downstreamSignal: AbortSignal, usageContext: UsageContext | undefined): Promise<Response> => {
  const terminalType = deepSeekTerminalTypeForError(error, downstreamSignal);
  recordDeepSeekFailureKind(usageContext, deepSeekTransportFailureKind(error, terminalType));
  recordStreamTerminalType(usageContext, terminalType);
  if (terminalType !== "cancelled") {
    void recordDeepSeekProviderHealth("upstream_error", null, Date.now, null);
  }
  await recordErrorUsage(usageContext);
  return toDeepSeekErrorResponse(error);
};

const respondDeepSeekChatUpstreamHttpFailure = async (
  upstream: Response,
  requestSignal: AbortSignal,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  bodyDiagnostic: Record<string, unknown> | undefined
): Promise<Response> => {
  recordDeepSeekResponseHealth(upstream.status, providerRequestId);
  recordDeepSeekFailureKind(usageContext, "upstream_http_error");
  recordStreamTerminalType(usageContext, "response.failed");
  await recordErrorUsage(usageContext);
  return await toDeepSeekUpstreamErrorResponse(upstream, requestSignal, bodyDiagnostic);
};

export const respondDeepSeekChatIncompleteCapture = async (
  usageContext: UsageContext | undefined,
  downstreamSignal: AbortSignal,
  requestSignal: AbortSignal,
  providerRequestId: string | null
): Promise<Response> => {
  let terminalType: ResponseStreamTerminalType = "error";
  let failureKind: DeepSeekFailureKind = "incomplete_response";
  if (downstreamSignal.aborted) {
    terminalType = "cancelled";
    failureKind = "cancellation";
  } else if (requestSignal.aborted) {
    terminalType = "deadline";
    failureKind = "deadline";
  }
  recordDeepSeekFailureKind(usageContext, failureKind);
  recordStreamTerminalType(usageContext, terminalType);
  if (terminalType !== "cancelled") {
    void recordDeepSeekProviderHealth("upstream_error", null, Date.now, providerRequestId);
  }
  await recordErrorUsage(usageContext);
  if (terminalType === "cancelled") {
    return openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error", headers: deepseekResponseHeaders(providerRequestId) });
  }
  return openaiError(
    terminalType === "deadline" ? 504 : 502,
    terminalType === "deadline" ? "Upstream request exceeded the gateway deadline." : "Upstream returned an incomplete response.",
    terminalType === "deadline" ? "gateway_timeout" : "deepseek_upstream_invalid_response",
    { type: "server_error", headers: deepseekResponseHeaders(providerRequestId) }
  );
};

/**
 * The frame union both provider transports are normalized to. DeepSeek's
 * iterator yields these frames directly; the LithosAI normalizer maps the
 * chunks its transport validates onto the same shape.
 */
import { type ProviderStreamAdapter, relayChatCompletionStream } from "../provider/stream-relay.ts";

export const deepseekStreamAdapter: ProviderStreamAdapter = {
  responseHeaders: deepseekResponseHeaders,
  frames: iterateDeepSeekChatCompletionStream,
  recordResponseHealth: recordDeepSeekResponseHealth,
  recordProviderError: (status, providerRequestId) => void recordDeepSeekProviderHealth("upstream_error", status, Date.now, providerRequestId),
  recordCancellation: (usageContext) => {
    recordDeepSeekFailureKind(usageContext, "cancellation");
  },
  recordIncompleteResponse: (usageContext) => {
    recordDeepSeekFailureKind(usageContext, "incomplete_response");
  },
  recordFinishFailureKind: (usageContext, finishReason) => {
    recordDeepSeekFailureKind(usageContext, deepSeekFinishReasonFailureKind(finishReason));
  },
  recordTransportFailure: (usageContext, error, terminalType) => {
    recordDeepSeekFailureKind(usageContext, deepSeekTransportFailureKind(error, terminalType));
  },
  terminalTypeForError: deepSeekTerminalTypeForError,
  streamErrorCode: "deepseek_upstream_stream_error",
  responsesProfile: DEEPSEEK_RESPONSES_PROFILE,
};

/**
 * Relays the DeepSeek Chat Completions SSE stream through the shared writer,
 * keeping DeepSeek's documented `: keep-alive` comment frames relayed verbatim.
 */
export const streamDeepSeekChatCompletion = (
  upstream: Response,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  downstreamSignal: AbortSignal,
  requestSignal: AbortSignal,
  upstreamModel: string
): Response => relayChatCompletionStream(deepseekStreamAdapter, upstream, providerRequestId, usageContext, downstreamSignal, requestSignal, upstreamModel);

type DeepSeekDispatchResult =
  | Readonly<{ ok: true; upstream: Response; providerRequestId: string | null; requestSignal: AbortSignal; downstreamSignal: AbortSignal }>
  | Readonly<{ ok: false; response: Response }>;

/**
 * Shared DeepSeek dispatch for both gateway routes. It owns the provider
 * request-id capture, the dispatch/headers telemetry, and the failure
 * responders, so the Chat and Responses adapters differ only in how they
 * translate the payload.
 */
export const dispatchDeepSeekUpstream = async (
  req: Request,
  body: Record<string, unknown>,
  modelRaw: string,
  usageContext: UsageContext | undefined
): Promise<DeepSeekDispatchResult> => {
  const downstreamSignal = downstreamSignalFor(req, usageContext);
  const requestSignal = inferenceSignal(req, usageContext);
  let upstream: Response;
  let bodyDiagnostic: Record<string, unknown> | undefined;
  try {
    upstream = await fetchDeepSeekChatCompletions(body, modelRaw, {
      onProjectedBody: (projectedBody) => {
        bodyDiagnostic = deepSeekChatBodyDiagnostic(projectedBody);
      },
      signal: requestSignal,
      beforeDispatch: () => usageContext?.beforeProviderDispatch?.("deepseek") ?? Promise.resolve(undefined),
      onDispatch: () => {
        recordAttemptedProvider(usageContext, "deepseek");
        recordFirstProviderDispatch(usageContext);
      },
      onHeaders: () => {
        recordFirstProviderHeaders(usageContext);
      },
      sentinelUpstreamRecorder: usageContext?.sentinelUpstreamRecorder,
    });
  } catch (error) {
    return { ok: false, response: await respondDeepSeekChatDispatchFailure(error, downstreamSignal, usageContext) };
  }

  const providerRequestId = getDeepSeekProviderRequestId(upstream);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.providerRequestId = providerRequestId;
  if (!upstream.ok) {
    return { ok: false, response: await respondDeepSeekChatUpstreamHttpFailure(upstream, requestSignal, providerRequestId, usageContext, bodyDiagnostic) };
  }
  return { ok: true, upstream, providerRequestId, requestSignal, downstreamSignal };
};

export const handleDeepSeekChatCompletions = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  modelRaw: string,
  usageContext?: UsageContext
): Promise<Response> => {
  const parsedRequest = validateDeepSeekChatRequestFields(rawRecord);
  if (!parsedRequest.ok) return parsedRequest.response;
  const { reasoning, clientWantsStream } = parsedRequest.value;
  // DeepSeek refuses `tool_choice` `required` and the named-function form while
  // thinking mode is active (upstream 400 "Thinking mode does not support this
  // tool_choice"). Reject the combination at the boundary with a gateway-shaped
  // error naming both fields rather than relaying the provider's message about
  // a parameter this route otherwise advertises.
  const toolChoiceConflict = deepSeekThinkingToolChoiceConflict(reasoning, rawRecord.thinking, rawRecord.tool_choice);
  if (toolChoiceConflict) {
    return openaiError(400, deepSeekToolChoiceThinkingConflictMessage(toolChoiceConflict, "reasoning_effort"), "invalid_request_error", {
      param: "tool_choice",
    });
  }
  // The canonical id the provider serves for this request; the buffered and
  // streamed readers echo it, so an alias never reports a mismatched model.
  const upstreamModel = deepSeekUpstreamModelFor(modelRaw) ?? DEEPSEEK_FLASH_MODEL;

  // Preserve the official nested Chat tools/tool_choice contract. In
  // particular, do not run the Codex-specific flattening that follows this
  // early branch in handleChatCompletionsInternal.
  const deepseekBody: Record<string, unknown> = {
    ...rawRecord,
    reasoning_effort: reasoning,
    stream: clientWantsStream,
  };
  // `thinking` is an input to the effort resolution above, not a wire field for
  // this route: the gateway sends one representation (`reasoning_effort`) so
  // the two can never disagree on the wire.
  delete deepseekBody.thinking;
  if (clientWantsStream) {
    // DeepSeek requires stream_options to be requested alongside a stream, and
    // reports usage on the final content chunk rather than a separate frame.
    if (!isRecord(deepseekBody.stream_options)) deepseekBody.stream_options = { include_usage: true };
  } else {
    // DeepSeek answers 400 when stream_options is present without stream:true.
    delete deepseekBody.stream_options;
  }
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.provider = "deepseek";
    usageContext.responseTelemetry.reasoning = reasoning;
    // The client's cap when it sent one, else the provider's own default for
    // the requested tier, else unknown. The gateway never supplies a cap here,
    // so an omitted field stays omitted on the wire.
    usageContext.responseTelemetry.outputTokenAllowance = deepSeekChatClientOutputAllowance(rawRecord) ?? deepSeekDefaultOutputAllowance(reasoning);
  }
  await recordRequestUsage(usageContext, {
    model: modelRaw,
    route: "chat.completions",
    stream: clientWantsStream,
    reasoning,
  });

  const dispatched = await dispatchDeepSeekUpstream(req, deepseekBody, modelRaw, usageContext);
  if (!dispatched.ok) return dispatched.response;
  const { upstream, requestSignal, downstreamSignal } = dispatched;
  let providerRequestId = dispatched.providerRequestId;

  if (clientWantsStream) {
    return streamDeepSeekChatCompletion(upstream, providerRequestId, usageContext, downstreamSignal, requestSignal, upstreamModel);
  }

  const captured = await readBoundedResponseBody(upstream, {
    signal: requestSignal,
    maxBytes: DEEPSEEK_BUFFERED_BODY_MAX_BYTES,
    // Successful buffered inference uses the request-level edge deadline, not
    // the one-second error-body default. `requestSignal` still caps the whole
    // request from dispatch through body completion.
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
    cancellationReason: "DeepSeek Chat Completions response was incomplete",
  });
  if (!captured.complete) {
    return await respondDeepSeekChatIncompleteCapture(usageContext, downstreamSignal, requestSignal, providerRequestId);
  }

  const completion = await readDeepSeekChatCompletion(captured.bytes, upstream.status, providerRequestId, usageContext, upstreamModel);
  if (!completion.ok) return completion.response;

  if (chatCompletionHasAnswerBearingOutput(completion.value)) markChatSemanticOutput(usageContext);
  providerRequestId ??= normalizeDeepSeekProviderRequestId(completion.value.id);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.providerRequestId = providerRequestId;
  const usage = extractChatUsageTokens(completion.value.usage);
  await recordCompletionUsage(usageContext, usage);
  recordStreamTerminalType(usageContext, "response.completed");
  recordDeepSeekResponseHealth(upstream.status, providerRequestId);
  return json(200, completion.value, deepseekResponseHeaders(providerRequestId));
};

/**
 * Finalizes the buffered DeepSeek Responses branch: reads the captured body,
 * applies the provider terminal's classification, and returns this request's
 * single response.
 *
 * Admission, the request record, the response identity and the echo all belong
 * to the caller; this helper only reuses the already-dispatched upstream, so no
 * second admission, request record or terminal is created.
 */
const finalizeBufferedDeepSeekResponses = async (
  options: Readonly<{
    upstream: Response;
    modelRaw: string;
    responseId: string;
    echo: DeepSeekResponsesEcho;
    toolNames: ReadonlyMap<string, OriginalToolName>;
    customToolNames: ReadonlySet<string>;
    upstreamModel: string;
    providerRequestId: string | null;
    requestSignal: AbortSignal;
    downstreamSignal: AbortSignal;
    usageContext?: UsageContext;
  }>
): Promise<Response> => {
  const captured = await readBoundedResponseBody(options.upstream, {
    signal: options.requestSignal,
    maxBytes: DEEPSEEK_BUFFERED_BODY_MAX_BYTES,
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
    cancellationReason: "DeepSeek Responses adapter body was incomplete",
  });
  if (!captured.complete) {
    return await respondDeepSeekChatIncompleteCapture(options.usageContext, options.downstreamSignal, options.requestSignal, options.providerRequestId);
  }

  const completion = await readDeepSeekChatCompletion(
    captured.bytes,
    options.upstream.status,
    options.providerRequestId,
    options.usageContext,
    options.upstreamModel
  );
  if (!completion.ok) return completion.response;

  let providerRequestId = options.providerRequestId;
  providerRequestId ??= normalizeDeepSeekProviderRequestId(completion.value.id);
  if (options.usageContext?.responseTelemetry) options.usageContext.responseTelemetry.providerRequestId = providerRequestId;
  const firstCompletion = completion.value;
  const payload = toDeepSeekResponsesPayload(firstCompletion, options.modelRaw, options.responseId, options.echo, options.toolNames, options.customToolNames);
  const usage = extractChatUsageTokens(firstCompletion.usage);
  // The provider's own reason decides the terminal first: an explicit
  // truncation is `response.incomplete` and is reported as such. Only a
  // would-be completion is then measured for answer-bearing output, which is
  // the same order the streamed path applies.
  if (deepSeekTerminalTypeForPayload(payload.status) === "response.completed" && !chatCompletionHasAnswerBearingOutput(firstCompletion)) {
    return respondDeepSeekEmptyBufferedCompletion(options.usageContext, usage, options.upstream.status, providerRequestId);
  }
  recordBufferedDeepSeekResponsesTerminal(options.usageContext, payload, usage, options.upstream.status, providerRequestId);
  return json(200, payload, deepseekResponseHeaders(providerRequestId));
};

/**
 * Responses adapter for the DeepSeek official route.
 *
 * The Codex client speaks only the Responses API, so this route translates the
 * request, the buffered payload and the stream through
 * `src/deepseek_responses.ts`. Every provider-level concern (dispatch
 * admission, deadlines, health, telemetry, error reflection) is shared with the
 * Chat route.
 *
 * The translation is no longer forced by a provider gap: DeepSeek now serves a
 * native Responses endpoint (`POST /responses` and `/v1/responses`, probed
 * 2026-09-21). Two reasons the translator is still the right seam, not a
 * legacy shim: the provider's native endpoint is documented as stateless with
 * several control parameters ignored, and this adapter's filler for
 * `reasoning_content` on the tool-bearing tail is a measured provider
 * requirement a native response would have to reproduce. Migrating would be a
 * separate, evidence-driven evaluation against representative histories, not
 * an assumed cure.
 */
export const handleDeepSeekResponses = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  modelRaw: string,
  usageContext?: UsageContext
): Promise<Response> => {
  const parsedStream = parseStreamField(rawRecord.stream);
  if (!parsedStream.ok) return openaiError(400, parsedStream.message, "invalid_request_error", { param: "stream" });
  const clientWantsStream = parsedStream.value;

  const translated = toDeepSeekResponsesChatBody(rawRecord, modelRaw, clientWantsStream);
  const upstreamModel = deepSeekUpstreamModelFor(modelRaw) ?? DEEPSEEK_FLASH_MODEL;
  if (!translated.ok) return openaiError(400, translated.message, translated.code ?? "invalid_request_error", { param: translated.param });
  const { body: chatBody, toolNames, customToolNames, warnings } = translated.value;
  if (translated.value.elisions.length) logForwardedPayloadElisions(translated.value.elisions);

  const echo: DeepSeekResponsesEcho = {
    tools: rawRecord.tools,
    tool_choice: rawRecord.tool_choice,
    parallel_tool_calls: rawRecord.parallel_tool_calls,
    instructions: typeof rawRecord.instructions === "string" && rawRecord.instructions.trim() ? rawRecord.instructions : null,
  };
  const reasoningLabel = typeof chatBody.reasoning_effort === "string" ? chatBody.reasoning_effort : DEEPSEEK_DEFAULT_REASONING_EFFORT;
  // The client's cap when it sent one, else the provider's own measured default
  // for the requested tier, else null. When it is unknown, telemetry stays null
  // rather than inventing a default for the tier.
  const outputAllowance = (typeof chatBody.max_tokens === "number" ? chatBody.max_tokens : null) ?? deepSeekDefaultOutputAllowance(reasoningLabel);
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.provider = "deepseek";
    usageContext.responseTelemetry.reasoning = reasoningLabel;
    // `applyOutputLimit` put the client's `max_output_tokens` on the wire as
    // `max_tokens`; when it was absent the provider's own tier default applies.
    usageContext.responseTelemetry.outputTokenAllowance = outputAllowance;
  }
  await recordRequestUsage(usageContext, {
    model: modelRaw,
    route: "responses",
    stream: clientWantsStream,
    reasoning: reasoningLabel,
  });

  const dispatched = await dispatchDeepSeekUpstream(req, chatBody, modelRaw, usageContext);
  if (!dispatched.ok) return withUosWarning(dispatched.response, warnings);
  const { upstream, requestSignal, downstreamSignal } = dispatched;
  const providerRequestId = dispatched.providerRequestId;
  const responseId = `resp_${(providerRequestId ?? crypto.randomUUID()).replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`;
  const createdAtSeconds = Math.floor(Date.now() / 1000);

  if (clientWantsStream) {
    const response = streamDeepSeekResponses(
      upstream,
      modelRaw,
      responseId,
      createdAtSeconds,
      echo,
      toolNames,
      customToolNames,
      providerRequestId,
      usageContext,
      downstreamSignal,
      requestSignal,
      upstreamModel
    );
    return withUosWarning(response, warnings);
  }

  const response = await finalizeBufferedDeepSeekResponses({
    upstream,
    modelRaw,
    responseId,
    echo,
    toolNames,
    customToolNames,
    upstreamModel,
    providerRequestId,
    requestSignal,
    downstreamSignal,
    usageContext,
  });
  return withUosWarning(response, warnings);
};

/**
 * Relays the DeepSeek translated Responses event sequence through the shared
 * writer; this shape skips comment frames and lets the translator decide the
 * terminal under DeepSeek's own profile.
 */
const streamDeepSeekResponses = (
  upstream: Response,
  requestedModel: string,
  responseId: string,
  createdAtSeconds: number,
  echo: DeepSeekResponsesEcho,
  toolNames: ReadonlyMap<string, OriginalToolName>,
  customToolNames: ReadonlySet<string>,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  downstreamSignal: AbortSignal,
  requestSignal: AbortSignal,
  upstreamModel: string
): Response =>
  relayResponsesStream(deepseekStreamAdapter, {
    upstream,
    requestedModel,
    responseId,
    createdAtSeconds,
    echo,
    toolNames,
    customToolNames,
    providerRequestId,
    usageContext,
    downstreamSignal,
    requestSignal,
    upstreamModel,
  });

/**
 * LithosAI route support.
 *
 * The vendor serves OpenAI Chat Completions only — `POST /v1/responses` answers
 * 404 (probed 2026-09-23) — while the gateway's shared Responses adapter
 * (`src/deepseek_responses.ts`) translates a Responses request into a Chat
 * Completions body under a provider profile. Both gateway routes are therefore
 * served natively, and everything provider-level (dispatch admission,
 * deadlines, health, telemetry, error reflection) is shared between them here;
 * the two adapters differ only in how they translate the payload.
 */
