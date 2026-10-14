// Cerebras Chat Completions handler and support, extracted from src/openai.ts.

import { downstreamSignalFor, inferenceSignal } from "../openai.ts";
import {
  CEREBRAS_GPT_OSS_120B_MODEL,
  CerebrasError,
  fetchCerebrasChatCompletions,
  getCerebrasProviderRequestId,
  normalizeCerebrasChatCompletion,
  normalizeCerebrasProviderRequestId,
} from "./cerebras.ts";
import { ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { DEFAULT_REASONING_EFFORT } from "../defaults.ts";
import { cerebrasProviderHint } from "../request-policy.ts";
import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { json, openaiError } from "../http.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "../inference-deadline.ts";
import { recordCerebrasProviderHealth } from "./health.ts";
import { isRecord } from "../utils.ts";
import {
  type ResponseStreamTerminalType,
  type UsageContext,
  extractChatUsageTokens,
  recordAttemptedProvider,
  recordCompletionUsage,
  recordErrorUsage,
  recordFirstProviderDispatch,
  recordFirstProviderHeaders,
  recordFirstSemanticCommitment,
  recordRequestUsage,
  recordStreamTerminal,
  recordStreamTerminalType,
} from "../openai-telemetry.ts";
import { markChatSemanticOutput } from "../chat/stream-translation.ts";
import {
  GPT_OSS_STREAM_DOWNGRADED_WARNING,
  cerebrasResponseHeaders,
  chatCompletionHasAnswerBearingOutput,
  streamCerebrasChatCompletion,
  toCerebrasErrorResponse,
  toCerebrasUpstreamErrorResponse,
} from "../upstream-wire.ts";
import { parseChatStreamOptions, parseReasoningEffortField, parseStreamField } from "../request-policy.ts";

export const recordCerebrasResponseHealth = (status: number, providerRequestId: string | null): void => {
  if (status === 401 || status === 403) {
    void recordCerebrasProviderHealth("auth_invalid", status, Date.now, providerRequestId);
    return;
  }
  if (status === 429) {
    void recordCerebrasProviderHealth("quota_exhausted", status, Date.now, providerRequestId);
    return;
  }
  if (status >= 500) {
    void recordCerebrasProviderHealth("upstream_error", status, Date.now, providerRequestId);
    return;
  }
  if (status >= 400) {
    void recordCerebrasProviderHealth("reachable", status, Date.now, providerRequestId);
    return;
  }
  void recordCerebrasProviderHealth("success", status, Date.now, providerRequestId);
};

const cerebrasTerminalTypeForError = (error: unknown, downstreamSignal: AbortSignal): ResponseStreamTerminalType => {
  if (downstreamSignal.aborted) return "cancelled";
  if (error instanceof CerebrasError && error.status === 504) return "deadline";
  if (error instanceof Error && error.name === "TimeoutError") return "deadline";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "error";
};

type CerebrasFailureKind =
  | "upstream_error"
  | "upstream_http_error"
  | "upstream_unreachable"
  | "incomplete_response"
  | "invalid_json"
  | "invalid_completion_schema"
  | "deadline"
  | "cancellation"
  | "api_key_quota_reservation_unavailable"
  | "cerebras_api_key_missing"
  | "cerebras_request_invalid";

export const recordCerebrasFailureKind = (context: UsageContext | undefined, failureKind: CerebrasFailureKind): void => {
  if (context?.responseTelemetry) context.responseTelemetry.failureKind = failureKind;
};

const cerebrasTransportFailureKind = (error: unknown, terminalType: ResponseStreamTerminalType): CerebrasFailureKind => {
  if (terminalType === "cancelled") return "cancellation";
  if (terminalType === "deadline") return "deadline";
  if (error instanceof ApiKeyQuotaDispatchError) return "api_key_quota_reservation_unavailable";
  if (error instanceof CerebrasError) {
    switch (error.code) {
      case "cerebras_api_key_missing":
        return "cerebras_api_key_missing";
      case "cerebras_request_invalid":
        return "cerebras_request_invalid";
      case "cerebras_upstream_unreachable":
        return "upstream_unreachable";
      case "gateway_timeout":
        return "deadline";
      default:
        break;
    }
  }
  return "upstream_unreachable";
};

/**
 * The per-id reasoning-tier refusal for one Cerebras model, or null when the
 * tier is acceptable.
 *
 * Tiers are per model, not per route: `gpt-oss-120b` cannot disable reasoning
 * while `qwen-3.8-27b` accepts `none` and defaults to `high`. Both the Chat and
 * the Responses handler ask this one function, so the two wires cannot drift on
 * which tiers a model accepts, and neither restates the per-model sets.
 *
 * An omitted tier (`undefined`) and a non-string value are the model's own
 * default or a shape this helper does not judge, so only an explicitly supplied
 * string tier is validated against this model's list.
 */
export const cerebrasReasoningEffortRefusal = (upstreamModel: string, reasoningEffort: unknown): Response | null => {
  if (typeof reasoningEffort !== "string") return null;
  const levels = cerebrasProviderHint(upstreamModel).supported_reasoning_levels ?? [];
  if (!levels.length || levels.includes(reasoningEffort)) return null;
  return openaiError(400, `reasoning_effort '${reasoningEffort}' is not supported for ${upstreamModel}. Use ${levels.join(", ")}.`, "invalid_request_error", {
    param: "reasoning_effort",
  });
};

/**
 * The GPT-OSS route is deliberately separate from the Codex Responses bridge.
 * It forwards the official Chat Completions body unchanged (apart from the
 * canonical model and explicit non-streaming flag) and never races or falls
 * back to another provider.
 */
const validateCerebrasChatRequestFields = (
  rawRecord: Record<string, unknown>,
  upstreamModel: string
): { ok: true; value: { reasoning: string; clientWantsStream: boolean; includeUsage: boolean } } | { ok: false; response: Response } => {
  const messages = rawRecord.messages;
  if (!Array.isArray(messages)) return { ok: false, response: openaiError(400, "messages must be an array", "invalid_request_error") };
  if (messages.length === 0) {
    return { ok: false, response: openaiError(400, "messages must be a non-empty array", "invalid_request_error") };
  }
  if (messages.some((message) => !isRecord(message) || Array.isArray(message))) {
    return { ok: false, response: openaiError(400, "messages must contain objects", "invalid_request_error", { param: "messages" }) };
  }

  const reasoningEffort = parseReasoningEffortField(rawRecord.reasoning_effort, "reasoning_effort");
  if (!reasoningEffort.ok) {
    return { ok: false, response: openaiError(400, reasoningEffort.message, "invalid_request_error", { param: "reasoning_effort" }) };
  }
  const tierRefusal = cerebrasReasoningEffortRefusal(upstreamModel, reasoningEffort.value);
  if (tierRefusal) return { ok: false, response: tierRefusal };
  const hint = cerebrasProviderHint(upstreamModel);
  // The hint owns each model's default (gpt-oss-120b is `medium`, qwen is
  // `high`); the gateway-wide default only covers a hint that states none.
  const declaredDefault = hint.default_reasoning_effort;
  const defaultReasoning = typeof declaredDefault === "string" && declaredDefault !== "" ? declaredDefault : DEFAULT_REASONING_EFFORT;
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
      reasoning: reasoningEffort.value ?? defaultReasoning,
      clientWantsStream: parsedStream.value,
      includeUsage: streamOptions.includeUsage,
    },
  };
};

export const respondCerebrasChatInvalidCompletion = async (
  failureKind: "invalid_json" | "invalid_completion_schema",
  upstreamStatus: number,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined
): Promise<Response> => {
  recordStreamTerminalType(usageContext, "error");
  recordCerebrasFailureKind(usageContext, failureKind);
  void recordCerebrasProviderHealth("upstream_error", upstreamStatus, Date.now, providerRequestId);
  await recordErrorUsage(usageContext);
  return openaiError(502, "Upstream returned an invalid Chat Completions response.", "cerebras_upstream_invalid_response", {
    type: "server_error",
    headers: cerebrasResponseHeaders(providerRequestId),
  });
};

export const readCerebrasChatCompletion = async (
  bytes: Uint8Array,
  upstreamStatus: number,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  model: string
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> => {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { ok: false, response: await respondCerebrasChatInvalidCompletion("invalid_json", upstreamStatus, providerRequestId, usageContext) };
  }
  const normalized = normalizeCerebrasChatCompletion(payload, model);
  if (!normalized.ok) {
    return {
      ok: false,
      response: await respondCerebrasChatInvalidCompletion("invalid_completion_schema", upstreamStatus, providerRequestId, usageContext),
    };
  }
  return { ok: true, value: normalized.value };
};

export const respondCerebrasChatDispatchFailure = async (
  error: unknown,
  downstreamSignal: AbortSignal,
  usageContext: UsageContext | undefined
): Promise<Response> => {
  const terminalType = cerebrasTerminalTypeForError(error, downstreamSignal);
  recordCerebrasFailureKind(usageContext, cerebrasTransportFailureKind(error, terminalType));
  recordStreamTerminalType(usageContext, terminalType);
  if (terminalType !== "cancelled") void recordCerebrasProviderHealth("upstream_error", null);
  await recordErrorUsage(usageContext);
  // Do not log the caught value: an upstream implementation can attach raw
  // response text or request configuration to an Error instance.
  return toCerebrasErrorResponse(error);
};

export const respondCerebrasChatUpstreamHttpFailure = async (
  upstream: Response,
  requestSignal: AbortSignal,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined
): Promise<Response> => {
  recordCerebrasResponseHealth(upstream.status, providerRequestId);
  recordCerebrasFailureKind(usageContext, "upstream_http_error");
  recordStreamTerminalType(usageContext, "response.failed");
  await recordErrorUsage(usageContext);
  return await toCerebrasUpstreamErrorResponse(upstream, requestSignal);
};

export const respondCerebrasChatIncompleteCapture = async (
  usageContext: UsageContext | undefined,
  downstreamSignal: AbortSignal,
  requestSignal: AbortSignal,
  providerRequestId: string | null
): Promise<Response> => {
  let terminalType: ResponseStreamTerminalType = "error";
  let failureKind: CerebrasFailureKind = "incomplete_response";
  if (downstreamSignal.aborted) {
    terminalType = "cancelled";
    failureKind = "cancellation";
  } else if (requestSignal.aborted) {
    terminalType = "deadline";
    failureKind = "deadline";
  }
  recordCerebrasFailureKind(usageContext, failureKind);
  recordStreamTerminalType(usageContext, terminalType);
  if (terminalType !== "cancelled") {
    void recordCerebrasProviderHealth("upstream_error", null, Date.now, providerRequestId);
  }
  await recordErrorUsage(usageContext);
  if (terminalType === "cancelled") {
    return openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error", headers: cerebrasResponseHeaders(providerRequestId) });
  }
  return openaiError(
    terminalType === "deadline" ? 504 : 502,
    terminalType === "deadline" ? "Upstream request exceeded the gateway deadline." : "Upstream returned an incomplete response.",
    terminalType === "deadline" ? "gateway_timeout" : "cerebras_upstream_invalid_response",
    { type: "server_error", headers: cerebrasResponseHeaders(providerRequestId) }
  );
};

export const handleCerebrasChatCompletions = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  modelRaw: string,
  usageContext?: UsageContext,
  /** The exact Cerebras wire id this request resolved to; never the client spelling. */
  upstreamModel: string = CEREBRAS_GPT_OSS_120B_MODEL
): Promise<Response> => {
  const parsedRequest = validateCerebrasChatRequestFields(rawRecord, upstreamModel);
  if (!parsedRequest.ok) return parsedRequest.response;
  const { reasoning, clientWantsStream, includeUsage } = parsedRequest.value;

  // Preserve the official nested Chat tools/tool_choice contract. In
  // particular, do not run the Codex-specific flattening that follows this
  // early branch in handleChatCompletionsInternal.
  const cerebrasBody: Record<string, unknown> = {
    ...rawRecord,
    model: upstreamModel,
    reasoning_effort: reasoning,
    stream: false,
  };
  delete cerebrasBody.stream_options;
  // Cerebras validates the whole body instead of ignoring what it does not
  // implement, so an ordinary OpenAI field this route cannot serve fails the
  // entire turn with a 400 `wrong_api_format` before the model is reached
  // (verified live 2026-09-26). `store` and `metadata` are refused even as
  // explicit nulls, so the keys must be absent rather than blanked.
  delete cerebrasBody.store;
  delete cerebrasBody.metadata;
  // `top_logprobs` is rejected only on its own, so it survives a request that
  // also asked for `logprobs`.
  if (!cerebrasBody.logprobs) delete cerebrasBody.top_logprobs;
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.provider = "cerebras";
    usageContext.responseTelemetry.reasoning = reasoning;
  }
  await recordRequestUsage(usageContext, {
    model: modelRaw,
    route: "chat.completions",
    stream: clientWantsStream,
    reasoning,
  });

  const downstreamSignal = downstreamSignalFor(req, usageContext);
  const requestSignal = inferenceSignal(req, usageContext);
  let upstream: Response;
  try {
    upstream = await fetchCerebrasChatCompletions(cerebrasBody, {
      signal: requestSignal,
      beforeDispatch: () => usageContext?.beforeProviderDispatch?.("cerebras") ?? Promise.resolve(undefined),
      onDispatch: () => {
        recordAttemptedProvider(usageContext, "cerebras");
        recordFirstProviderDispatch(usageContext);
      },
      onHeaders: () => {
        recordFirstProviderHeaders(usageContext);
      },
      sentinelUpstreamRecorder: usageContext?.sentinelUpstreamRecorder,
    });
  } catch (error) {
    return await respondCerebrasChatDispatchFailure(error, downstreamSignal, usageContext);
  }

  let providerRequestId = getCerebrasProviderRequestId(upstream);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.providerRequestId = providerRequestId;

  if (!upstream.ok) {
    return await respondCerebrasChatUpstreamHttpFailure(upstream, requestSignal, providerRequestId, usageContext);
  }

  const captured = await readBoundedResponseBody(upstream, {
    signal: requestSignal,
    maxBytes: 128 * 1024,
    // Successful buffered inference uses the request-level edge deadline, not
    // the one-second error-body default. `requestSignal` still caps the whole
    // request from dispatch through body completion.
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
    cancellationReason: "Cerebras Chat Completions response was incomplete",
  });
  if (!captured.complete) {
    return await respondCerebrasChatIncompleteCapture(usageContext, downstreamSignal, requestSignal, providerRequestId);
  }

  const completion = await readCerebrasChatCompletion(captured.bytes, upstream.status, providerRequestId, usageContext, upstreamModel);
  if (!completion.ok) return completion.response;

  if (chatCompletionHasAnswerBearingOutput(completion.value)) markChatSemanticOutput(usageContext);
  providerRequestId ??= normalizeCerebrasProviderRequestId(completion.value.id);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.providerRequestId = providerRequestId;
  const usage = extractChatUsageTokens(completion.value.usage);
  await recordCompletionUsage(usageContext, usage);
  if (clientWantsStream) recordFirstSemanticCommitment(usageContext);
  recordStreamTerminalType(usageContext, "response.completed");
  recordCerebrasResponseHealth(upstream.status, providerRequestId);
  const responseHeaders = cerebrasResponseHeaders(providerRequestId, clientWantsStream ? GPT_OSS_STREAM_DOWNGRADED_WARNING : undefined);
  if (clientWantsStream) {
    recordStreamTerminal(usageContext);
    return streamCerebrasChatCompletion(completion.value, includeUsage, responseHeaders);
  }
  return json(200, completion.value, responseHeaders);
};

/**
 * The DeepSeek route is deliberately separate from the Codex Responses bridge.
 * It forwards the official Chat Completions body to the official DeepSeek API,
 * relays native SSE chunks as they arrive instead of buffering a streamed
 * reply, and never races or falls back to another provider.
 */
