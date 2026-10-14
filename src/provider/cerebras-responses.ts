// Cerebras Responses adapter: the shared Chat translation under CEREBRAS_RESPONSES_PROFILE.

import { downstreamSignalFor, inferenceSignal } from "../openai.ts";
import { DEFAULT_REASONING_EFFORT } from "../defaults.ts";
import { json, openaiError } from "../http.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "../inference-deadline.ts";
import { isRecord } from "../utils.ts";
import { cerebrasProviderHint, parseStreamField } from "../request-policy.ts";
import { cerebrasUpstreamModelFor, fetchCerebrasChatCompletions, getCerebrasProviderRequestId, normalizeCerebrasProviderRequestId } from "./cerebras.ts";
import {
  cerebrasReasoningEffortRefusal,
  readCerebrasChatCompletion,
  recordCerebrasFailureKind,
  recordCerebrasResponseHealth,
  respondCerebrasChatDispatchFailure,
  respondCerebrasChatIncompleteCapture,
  respondCerebrasChatInvalidCompletion,
  respondCerebrasChatUpstreamHttpFailure,
} from "./cerebras-handlers.ts";
import { recordCerebrasProviderHealth } from "./health.ts";
import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { logForwardedPayloadElisions, toDeepSeekResponsesChatBody } from "../deepseek/chat-projection.ts";
import { CEREBRAS_RESPONSES_PROFILE, type OriginalToolName } from "../deepseek/responses.ts";
import { type DeepSeekResponsesEcho, toDeepSeekResponsesPayload } from "../deepseek/responses-payload.ts";
import { createDeepSeekResponsesStreamTranslator, encodeResponsesEvent } from "../deepseek/responses-stream.ts";
import { deepSeekTerminalTypeForPayload } from "../deepseek/handlers.ts";
import { markChatSemanticOutput } from "../chat/stream-translation.ts";
import { GPT_OSS_STREAM_DOWNGRADED_WARNING, cerebrasResponseHeaders, chatCompletionHasAnswerBearingOutput } from "../upstream-wire.ts";
import {
  type UsageContext,
  type UsageTokens,
  extractChatUsageTokens,
  recordAttemptedProvider,
  recordFirstProviderDispatch,
  recordFirstProviderHeaders,
  recordFirstSemanticCommitment,
  recordRequestUsage,
  recordStreamTerminal,
  recordStreamTerminalType,
  recordTerminalUsage,
} from "../openai-telemetry.ts";

const CEREBRAS_BUFFERED_BODY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Cerebras Responses adapter.
 *
 * The vendor serves Chat Completions only, so the shared translation in
 * `src/deepseek/responses.ts` runs under `CEREBRAS_RESPONSES_PROFILE`: one
 * profile per provider owns the model table, the reasoning-tier acceptance and
 * the usage counters, and the translation itself is the one the DeepSeek and
 * LithosAI routes already use.
 *
 * The upstream is non-streaming whatever the client asked for (the route's own
 * transport buffers `gpt-oss-120b`), so a `stream: true` request is answered by
 * replaying the finished completion as one Responses event sequence. That is a
 * replayed burst, not progressive generation, and this adapter must not depend
 * on incremental delivery.
 */

/** The client's own request fields the Responses envelope echoes back. */
const responsesEcho = (rawRecord: Record<string, unknown>): DeepSeekResponsesEcho => ({
  tools: rawRecord.tools,
  tool_choice: rawRecord.tool_choice,
  parallel_tool_calls: rawRecord.parallel_tool_calls,
  instructions: typeof rawRecord.instructions === "string" && rawRecord.instructions.trim() ? rawRecord.instructions : null,
});

/**
 * The transport's reasoning field under the name this shared translation reads.
 *
 * Cerebras reports `reasoning` on its Chat wire while the Responses translation
 * (and DeepSeek's own wire) spell the same payload `reasoning_content`. The copy
 * is made on a projected completion, so the caller's normalized body is never
 * rewritten and the Chat route keeps its own field untouched.
 */
const responsesCompletion = (completion: Record<string, unknown>): Record<string, unknown> => ({
  ...completion,
  choices: (Array.isArray(completion.choices) ? completion.choices : []).map((choice) => {
    if (!isRecord(choice) || Array.isArray(choice) || !isRecord(choice.message) || Array.isArray(choice.message)) return choice;
    const message = choice.message;
    return {
      ...choice,
      message: {
        ...message,
        ...(typeof message.reasoning === "string" && message.reasoning && message.reasoning_content === undefined
          ? { reasoning_content: message.reasoning }
          : {}),
      },
    };
  }),
});

/**
 * One buffered completion as the single non-streaming chunk the Responses
 * stream translator consumes. Tool calls are complete here, so each carries its
 * index, name and arguments at once.
 */
const responsesChunk = (completion: Record<string, unknown>): Record<string, unknown> => ({
  id: completion.id,
  object: "chat.completion.chunk",
  created: completion.created,
  model: completion.model,
  choices: (Array.isArray(completion.choices) ? completion.choices : []).map((choice, position) => {
    const entry = isRecord(choice) && !Array.isArray(choice) ? choice : {};
    const message = isRecord(entry.message) && !Array.isArray(entry.message) ? entry.message : {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : null;
    return {
      index: typeof entry.index === "number" ? entry.index : position,
      delta: {
        role: "assistant",
        ...(typeof message.reasoning_content === "string" && message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        ...(typeof message.content === "string" ? { content: message.content } : {}),
        ...(typeof message.refusal === "string" && message.refusal ? { refusal: message.refusal } : {}),
        ...(toolCalls === null
          ? {}
          : { tool_calls: toolCalls.map((call, callIndex) => (isRecord(call) && !Array.isArray(call) ? { ...call, index: callIndex } : call)) }),
      },
      finish_reason: typeof entry.finish_reason === "string" ? entry.finish_reason : null,
    };
  }),
  ...(completion.usage === undefined ? {} : { usage: completion.usage }),
});

/**
 * Records a Cerebras Responses terminal. The payload carries the provider's own
 * stop reason, so telemetry reports the terminal the client receives instead of
 * assuming success, and the non-completed classification matches the Chat route.
 */
const recordCerebrasResponsesTerminal = (
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
    recordCerebrasResponseHealth(upstreamStatus, providerRequestId);
  } else {
    recordCerebrasFailureKind(usageContext, terminalType === "response.incomplete" ? "incomplete_response" : "upstream_error");
    void recordCerebrasProviderHealth("upstream_error", upstreamStatus, Date.now, providerRequestId);
  }
};

/**
 * The completion's answer-bearing view, failing closed when the provider
 * reported success but handed the client nothing to act on.
 *
 * A Cerebras response that stops at the token budget can carry reasoning only
 * (`content: null`, `finish_reason: "length"`); returning it as a completed or
 * even an incomplete Responses object would publish an unusable empty answer,
 * so it is refused with the transport's own `cerebras_upstream_invalid_response`
 * identity - the same code and failure kind the Chat route uses for a completion
 * with no payload at all.
 */
const respondCerebrasResponsesEmptyCompletion = (
  upstreamStatus: number,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined
): Promise<Response> => respondCerebrasChatInvalidCompletion("invalid_completion_schema", upstreamStatus, providerRequestId, usageContext);

/**
 * Replays one buffered completion as the Responses event sequence a `stream:
 * true` client consumes. The events are the shared translator's under this
 * provider's profile, so the sequence is the same one the streaming routes
 * emit, including the terminal the provider's own stop reason implies.
 */
const replayCerebrasResponsesStream = (
  completion: Record<string, unknown>,
  options: Readonly<{
    requestedModel: string;
    responseId: string;
    createdAtSeconds: number;
    echo: DeepSeekResponsesEcho;
    toolNames: ReadonlyMap<string, OriginalToolName>;
    customToolNames: ReadonlySet<string>;
    payload: Record<string, unknown>;
    usage: UsageTokens | null;
    upstreamStatus: number;
    providerRequestId: string | null;
    usageContext?: UsageContext;
  }>
): Response => {
  const translator = createDeepSeekResponsesStreamTranslator(
    options.requestedModel,
    options.responseId,
    options.echo,
    options.createdAtSeconds,
    options.toolNames,
    options.customToolNames,
    CEREBRAS_RESPONSES_PROFILE
  );
  const events = [...translator.open(), ...translator.push(responsesChunk(completion)), ...translator.finish()];
  let sequenceNumber = 0;
  const body = events.map((event) => encodeResponsesEvent({ ...event, sequence_number: sequenceNumber++ })).join("");
  // The completion was already measured as answer-bearing above, so the streamed
  // caller's semantic commitment is this request's own, not the parser's.
  markChatSemanticOutput(options.usageContext);
  recordFirstSemanticCommitment(options.usageContext);
  recordCerebrasResponsesTerminal(options.usageContext, options.payload, options.usage, options.upstreamStatus, options.providerRequestId);
  return new Response(body, {
    status: 200,
    headers: {
      ...cerebrasResponseHeaders(options.providerRequestId, GPT_OSS_STREAM_DOWNGRADED_WARNING),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
};

/** The per-id default the chat route applies when the client sent no tier. */
const cerebrasDeclaredDefaultReasoning = (declared: unknown): string => (typeof declared === "string" && declared !== "" ? declared : DEFAULT_REASONING_EFFORT);

type CerebrasResponsesDispatch =
  | Readonly<{ ok: true; completion: Record<string, unknown>; providerRequestId: string | null; upstreamStatus: number }>
  | Readonly<{ ok: false; response: Response }>;

/**
 * Dispatches one translated Chat body to Cerebras and reads its buffered
 * completion, answering every transport-level failure with the Chat route's own
 * responder. Both adapter routes share the transport, so this is the same
 * admission, deadline, health and error-reflection path the Chat route takes.
 */
const dispatchCerebrasResponses = async (
  req: Request,
  chatBody: Record<string, unknown>,
  upstreamModel: string,
  usageContext: UsageContext | undefined
): Promise<CerebrasResponsesDispatch> => {
  const downstreamSignal = downstreamSignalFor(req, usageContext);
  const requestSignal = inferenceSignal(req, usageContext);
  let upstream: Response;
  try {
    upstream = await fetchCerebrasChatCompletions(chatBody, {
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
    return { ok: false, response: await respondCerebrasChatDispatchFailure(error, downstreamSignal, usageContext) };
  }

  let providerRequestId = getCerebrasProviderRequestId(upstream);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.providerRequestId = providerRequestId;

  if (!upstream.ok) {
    return { ok: false, response: await respondCerebrasChatUpstreamHttpFailure(upstream, requestSignal, providerRequestId, usageContext) };
  }

  const captured = await readBoundedResponseBody(upstream, {
    signal: requestSignal,
    maxBytes: CEREBRAS_BUFFERED_BODY_MAX_BYTES,
    // Successful buffered inference uses the request-level edge deadline, not
    // the one-second error-body default. `requestSignal` still caps the whole
    // request from dispatch through body completion.
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
    cancellationReason: "Cerebras Responses adapter body was incomplete",
  });
  if (!captured.complete) {
    return { ok: false, response: await respondCerebrasChatIncompleteCapture(usageContext, downstreamSignal, requestSignal, providerRequestId) };
  }

  const completion = await readCerebrasChatCompletion(captured.bytes, upstream.status, providerRequestId, usageContext, upstreamModel);
  if (!completion.ok) return { ok: false, response: completion.response };

  providerRequestId ??= normalizeCerebrasProviderRequestId(completion.value.id);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.providerRequestId = providerRequestId;
  return { ok: true, completion: completion.value, providerRequestId, upstreamStatus: upstream.status };
};

/**
 * The Cerebras Responses route.
 *
 * A Cerebras id reaches this adapter before the Codex catalog availability check
 * in `handleResponsesInternal`, so the two ids are servable on `/v1/responses`
 * exactly as they are on `/v1/chat/completions`. Everything provider-level
 * (dispatch admission, deadlines, health, telemetry, error reflection) is shared
 * with the Cerebras Chat route; this adapter differs only in how it translates
 * the payload.
 */
export const handleCerebrasResponses = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  modelRaw: string,
  usageContext?: UsageContext
): Promise<Response> => {
  const parsedStream = parseStreamField(rawRecord.stream);
  if (!parsedStream.ok) return openaiError(400, parsedStream.message, "invalid_request_error", { param: "stream" });
  const clientWantsStream = parsedStream.value;
  // The route only dispatches here for a Cerebras id, so this guard covers the
  // handler's own contract rather than a reachable client path.
  const upstreamModel = cerebrasUpstreamModelFor(modelRaw);
  if (!upstreamModel) return openaiError(400, `model '${modelRaw}' is not a Cerebras model`, "invalid_request_error", { param: "model" });

  // The upstream answers a buffered completion, so the translation never asks
  // for a stream: a client's `stream: true` is answered by the replay below.
  const translated = toDeepSeekResponsesChatBody(rawRecord, modelRaw, false, CEREBRAS_RESPONSES_PROFILE);
  if (!translated.ok) return openaiError(400, translated.message, translated.code ?? "invalid_request_error", { param: translated.param });
  // The Cerebras transport projects and collapses the translated messages in
  // its final JSON-encoding step, shared with the Chat wire. That is also where
  // unsupported system/developer content is rejected before dispatch.
  const chatBody: Record<string, unknown> = { ...translated.value.body };
  const { toolNames, customToolNames } = translated.value;
  if (translated.value.elisions.length) logForwardedPayloadElisions(translated.value.elisions);
  // The provider's tier contract is per id, and it is the route's own decision:
  // `none` is refused for gpt-oss-120b while qwen-3.8-27b accepts it. The same
  // helper the Chat route uses answers for both wires.
  const tierRefusal = cerebrasReasoningEffortRefusal(upstreamModel, chatBody.reasoning_effort);
  if (tierRefusal) return tierRefusal;

  const echo = responsesEcho(rawRecord);
  const reasoningLabel =
    typeof chatBody.reasoning_effort === "string"
      ? chatBody.reasoning_effort
      : cerebrasDeclaredDefaultReasoning(cerebrasProviderHint(upstreamModel).default_reasoning_effort);
  // The client's cap when it sent one, else unknown: an absent `max_tokens`
  // leaves the provider's own per-tier allowance in place, which this route does
  // not restate.
  const outputAllowance = typeof chatBody.max_tokens === "number" ? chatBody.max_tokens : null;
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.provider = "cerebras";
    usageContext.responseTelemetry.reasoning = reasoningLabel;
    usageContext.responseTelemetry.outputTokenAllowance = outputAllowance;
  }
  await recordRequestUsage(usageContext, {
    model: modelRaw,
    route: "responses",
    stream: clientWantsStream,
    reasoning: reasoningLabel,
  });

  const dispatched = await dispatchCerebrasResponses(req, chatBody, upstreamModel, usageContext);
  if (!dispatched.ok) return dispatched.response;
  const { completion: normalized, providerRequestId, upstreamStatus } = dispatched;

  // The provider's own reason is read before the payload is built, so an
  // unusable truncation fails here instead of being replayed as a terminal.
  if (!chatCompletionHasAnswerBearingOutput(normalized)) {
    return await respondCerebrasResponsesEmptyCompletion(upstreamStatus, providerRequestId, usageContext);
  }

  const projected = responsesCompletion(normalized);
  const usage = extractChatUsageTokens(projected.usage);
  const responseId = `resp_${(providerRequestId ?? crypto.randomUUID()).replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`;
  const payload = toDeepSeekResponsesPayload(projected, modelRaw, responseId, echo, toolNames, customToolNames, CEREBRAS_RESPONSES_PROFILE);

  if (clientWantsStream) {
    return replayCerebrasResponsesStream(projected, {
      requestedModel: modelRaw,
      responseId,
      createdAtSeconds: Math.floor(Date.now() / 1000),
      echo,
      toolNames,
      customToolNames,
      payload,
      usage,
      upstreamStatus,
      providerRequestId,
      usageContext,
    });
  }

  markChatSemanticOutput(usageContext);
  recordCerebrasResponsesTerminal(usageContext, payload, usage, upstreamStatus, providerRequestId);
  return json(200, payload, cerebrasResponseHeaders(providerRequestId));
};
