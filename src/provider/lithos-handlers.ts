// LithosAI Chat and Responses handlers, extracted from src/openai.ts.

import { LITHOS_RESPONSES_PROFILE, type OriginalToolName } from "../deepseek/responses.ts";
import { logForwardedPayloadElisions, toDeepSeekResponsesChatBody } from "../deepseek/chat-projection.ts";
import { type DeepSeekResponsesEcho, toDeepSeekResponsesPayload } from "../deepseek/responses-payload.ts";
import {
  fetchLithosChatCompletions,
  getLithosProviderRequestId,
  LITHOS_DEFAULT_REASONING_EFFORT,
  LITHOS_REASONING_LEVELS,
  lithosUpstreamModelFor,
  normalizeLithosChatCompletion,
} from "./lithos.ts";
import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { json, openaiError } from "../http.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "../inference-deadline.ts";
import { recordLithosProviderHealth } from "./health.ts";
import {
  recordLithosFailureKind,
  recordLithosResponseHealth,
  streamLithosChatCompletion,
  streamLithosResponses,
  type LithosFailureKind,
  lithosTerminalTypeForError,
  lithosTransportFailureKind,
} from "./lithos-streams.ts";
import { isRecord } from "../utils.ts";
import {
  type ResponseStreamTerminalType,
  type UsageContext,
  type UsageTokens,
  extractChatUsageTokens,
  recordAttemptedProvider,
  recordCompletionUsage,
  recordErrorUsage,
  recordFirstProviderDispatch,
  recordFirstProviderHeaders,
  recordRequestUsage,
  recordStreamTerminal,
  recordStreamTerminalType,
  recordTerminalUsage,
} from "../openai-telemetry.ts";
import { EMPTY_UPSTREAM_COMPLETION_MESSAGE, markChatSemanticOutput } from "../chat/stream-translation.ts";
import {
  cancelResponseBody,
  chatCompletionHasAnswerBearingOutput,
  deepSeekChatBodyDiagnostic,
  lithosResponseHeaders,
  toLithosErrorResponse,
  toLithosUpstreamErrorResponse,
} from "../upstream-wire.ts";
import { parseChatStreamOptions, parseReasoningEffortField, parseStreamField } from "../request-policy.ts";
import { downstreamSignalFor, inferenceSignal } from "../openai.ts";
import { deepSeekChatClientOutputAllowance, deepSeekTerminalTypeForPayload } from "../deepseek/handlers.ts";

const LITHOS_BUFFERED_BODY_MAX_BYTES = 8 * 1024 * 1024;

import {
  LITHOS_BUFFERED_REFUSAL_WAIT_POLICY,
  LITHOS_REFUSAL_WAIT_CAP_MS,
  LITHOS_STREAMED_REFUSAL_WAIT_POLICY,
  type LithosRateLimitWait,
  type LithosRefusalWaitPolicy,
  lithosFailoverLadderFor,
  lithosFailoverTargetAt,
  lithosOpenFailoverWindow,
  lithosRateLimitWait,
  lithosRateLimitSnapshot,
  lithosRefusalWait,
  lithosRetryProhibited,
  logLithosRateLimitFailover,
  logLithosRateLimitRefusal,
  logLithosRateLimitWait,
  recordLithosRateLimitWaitMs,
  waitForLithosRetry,
  recordLithosFailoverModel,
} from "./lithos-rate-limits.ts";

/** The seven tiers the provider accepted verbatim on 2026-09-23, as a membership set. */
export const LITHOS_REASONING_LEVEL_SET: ReadonlySet<string> = new Set(LITHOS_REASONING_LEVELS);

/** The canonical wire spelling for an accepted tier, or null when the provider refuses it. */
const lithosReasoningLevel = (value: string): string | null => {
  const level = value.trim().toLowerCase();
  return LITHOS_REASONING_LEVEL_SET.has(level) ? level : null;
};

/**
 * Validates the Chat Completions fields this route owns before any dispatch.
 *
 * `messages` is checked exactly as the DeepSeek branch checks it. The reasoning
 * tier is the one provider-specific rule: the vendor accepted exactly the seven
 * lowercase tiers verbatim and refused everything else with a 400, so a tier
 * outside that set (notably the Codex `ultra` preset, which this wire has no
 * mapping for) fails closed here instead of leaving the gateway only to be
 * refused upstream.
 */
const validateLithosChatRequestFields = (
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
  const reasoningEffort = parseReasoningEffortField(rawRecord.reasoning_effort, "reasoning_effort");
  if (!reasoningEffort.ok) {
    return { ok: false, response: openaiError(400, reasoningEffort.message, "invalid_request_error", { param: "reasoning_effort" }) };
  }
  // The provider's default for an omitted effort was not probed, so the
  // gateway's declared default (the middle verified tier) is sent explicitly
  // and the wire agrees with the capabilities endpoint.
  const reasoning = reasoningEffort.value === undefined ? LITHOS_DEFAULT_REASONING_EFFORT : lithosReasoningLevel(reasoningEffort.value);
  if (reasoning === null) {
    return {
      ok: false,
      response: openaiError(
        400,
        `reasoning_effort '${reasoningEffort.value}' is not supported by LithosAI. Use none, minimal, low, medium, high, xhigh, or max.`,
        "invalid_request_error",
        { param: "reasoning_effort" }
      ),
    };
  }
  const parsedStream = parseStreamField(rawRecord.stream);
  if (!parsedStream.ok) {
    return { ok: false, response: openaiError(400, parsedStream.message, "invalid_request_error", { param: "stream" }) };
  }
  const streamOptions = parseChatStreamOptions(rawRecord.stream_options);
  if (!streamOptions.ok) {
    return { ok: false, response: openaiError(400, streamOptions.message, "invalid_request_error", { param: "stream_options" }) };
  }
  return { ok: true, value: { reasoning, clientWantsStream: parsedStream.value } };
};

/**
 * The output cap the client supplied, if any. The cap fields are the official
 * Chat contract's (`max_completion_tokens`, then a literal `max_tokens`), not
 * provider-specific, so the shared reader serves this route too.
 */
const lithosChatClientOutputAllowance = (rawRecord: Record<string, unknown>): number | null => deepSeekChatClientOutputAllowance(rawRecord);

const respondLithosChatInvalidCompletion = async (
  failureKind: "invalid_json" | "invalid_completion_schema",
  upstreamStatus: number,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined
): Promise<Response> => {
  recordStreamTerminalType(usageContext, "error");
  recordLithosFailureKind(usageContext, failureKind);
  void recordLithosProviderHealth("upstream_error", upstreamStatus, Date.now, providerRequestId);
  await recordErrorUsage(usageContext);
  return openaiError(502, "Upstream returned an invalid Chat Completions response.", "lithos_upstream_invalid_response", {
    type: "server_error",
    headers: lithosResponseHeaders(providerRequestId),
  });
};

const readLithosChatCompletion = async (
  bytes: Uint8Array,
  upstreamStatus: number,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  upstreamModel: string,
  servedModel: string
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> => {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { ok: false, response: await respondLithosChatInvalidCompletion("invalid_json", upstreamStatus, providerRequestId, usageContext) };
  }
  const normalized = normalizeLithosChatCompletion(payload, upstreamModel, servedModel);
  if (!normalized.ok) {
    return { ok: false, response: await respondLithosChatInvalidCompletion("invalid_completion_schema", upstreamStatus, providerRequestId, usageContext) };
  }
  return { ok: true, value: normalized.value };
};

const respondLithosChatDispatchFailure = async (error: unknown, downstreamSignal: AbortSignal, usageContext: UsageContext | undefined): Promise<Response> => {
  const terminalType = lithosTerminalTypeForError(error, downstreamSignal);
  recordLithosFailureKind(usageContext, lithosTransportFailureKind(error, terminalType));
  recordStreamTerminalType(usageContext, terminalType);
  if (terminalType !== "cancelled") {
    void recordLithosProviderHealth("upstream_error", null, Date.now, null);
  }
  await recordErrorUsage(usageContext);
  return toLithosErrorResponse(error);
};

const respondLithosChatUpstreamHttpFailure = async (
  upstream: Response,
  requestSignal: AbortSignal,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  body: Record<string, unknown>
): Promise<Response> => {
  recordLithosResponseHealth(upstream.status, providerRequestId);
  recordLithosFailureKind(usageContext, "upstream_http_error");
  recordStreamTerminalType(usageContext, "response.failed");
  await recordErrorUsage(usageContext);
  // The digest is shape-only (no prompt text, tool names, or ids), so the
  // existing Chat-body reader is provider-agnostic and serves this route too.
  return await toLithosUpstreamErrorResponse(upstream, requestSignal, deepSeekChatBodyDiagnostic(body));
};

const respondLithosChatIncompleteCapture = async (
  usageContext: UsageContext | undefined,
  downstreamSignal: AbortSignal,
  requestSignal: AbortSignal,
  providerRequestId: string | null
): Promise<Response> => {
  let terminalType: ResponseStreamTerminalType = "error";
  let failureKind: LithosFailureKind = "incomplete_response";
  if (downstreamSignal.aborted) {
    terminalType = "cancelled";
    failureKind = "cancellation";
  } else if (requestSignal.aborted) {
    terminalType = "deadline";
    failureKind = "deadline";
  }
  recordLithosFailureKind(usageContext, failureKind);
  recordStreamTerminalType(usageContext, terminalType);
  if (terminalType !== "cancelled") {
    void recordLithosProviderHealth("upstream_error", null, Date.now, providerRequestId);
  }
  await recordErrorUsage(usageContext);
  if (terminalType === "cancelled") {
    return openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error", headers: lithosResponseHeaders(providerRequestId) });
  }
  return openaiError(
    terminalType === "deadline" ? 504 : 502,
    terminalType === "deadline" ? "Upstream request exceeded the gateway deadline." : "Upstream returned an incomplete response.",
    terminalType === "deadline" ? "gateway_timeout" : "lithos_upstream_invalid_response",
    { type: "server_error", headers: lithosResponseHeaders(providerRequestId) }
  );
};

type LithosDispatchOutcome =
  | Readonly<{
      ok: true;
      upstream: Response;
      providerRequestId: string | null;
      requestSignal: AbortSignal;
      downstreamSignal: AbortSignal;
      /** The tier this attempt addressed; a mapped sibling after a failover. */
      servedModel: string;
    }>
  | Readonly<{
      ok: false;
      response: Response;
      /** Carried so a streamed handler can open its stream and report the refusal in-band. */
      requestSignal: AbortSignal;
      downstreamSignal: AbortSignal;
    }>;

/** Everything one request's dispatch loop needs that never changes. */
type LithosDispatchInput = Readonly<{
  body: Record<string, unknown>;
  modelRaw: string;
  requestSignal: AbortSignal;
  downstreamSignal: AbortSignal;
  usageContext: UsageContext | undefined;
}>;

/** Where one request's dispatch loop stands between attempts. */
type LithosDispatchProgress = Readonly<{
  attempt: number;
  /** The tier the next attempt addresses; the sibling after a failover. */
  attemptModel: string;
  /** How many ladder tiers this cycle has already tried; 0 means only the requested tier. */
  ladderIndex: number;
  /** Tiers whose refusal explicitly forbade another attempt during this request. */
  noRetryModels: ReadonlySet<string>;
  /** Waited time spent so far, so the total pause stays bounded. */
  waitedMs: number;
  /** Absorbed pauses so far, so a stream of tiny windows cannot loop forever. */
  waits: number;
}>;

/** One provider attempt with the route's transport hooks. */
const lithosDispatchAttempt = async (
  body: Record<string, unknown>,
  modelRaw: string,
  requestSignal: AbortSignal,
  usageContext: UsageContext | undefined
): Promise<Response> =>
  await fetchLithosChatCompletions(body, modelRaw, {
    signal: requestSignal,
    // Idempotent per request: a retry after a real dispatch is the same
    // reservation, so the second call cannot double-count the attempt.
    beforeDispatch: () => usageContext?.beforeProviderDispatch?.("lithos") ?? Promise.resolve(undefined),
    onDispatch: () => {
      recordAttemptedProvider(usageContext, "lithos");
      recordFirstProviderDispatch(usageContext);
    },
    onHeaders: () => {
      recordFirstProviderHeaders(usageContext);
    },
    sentinelUpstreamRecorder: usageContext?.sentinelUpstreamRecorder,
  });

/** The outcome of an attempt the loop decided not to retry. */
const lithosAttemptOutcome = async (input: LithosDispatchInput, upstream: Response, servedModel: string): Promise<LithosDispatchOutcome> => {
  const providerRequestId = getLithosProviderRequestId(upstream);
  if (input.usageContext?.responseTelemetry) input.usageContext.responseTelemetry.providerRequestId = providerRequestId;
  if (!upstream.ok) {
    return {
      ok: false,
      response: await respondLithosChatUpstreamHttpFailure(upstream, input.requestSignal, providerRequestId, input.usageContext, input.body),
      requestSignal: input.requestSignal,
      downstreamSignal: input.downstreamSignal,
    };
  }
  recordLithosFailoverModel(input.usageContext, servedModel === input.modelRaw ? null : servedModel);
  return { ok: true, upstream, providerRequestId, requestSignal: input.requestSignal, downstreamSignal: input.downstreamSignal, servedModel };
};

/**
 * Opens the tier's failover window for as long as the refusal's own headers
 * say, so later requests go straight to the sibling instead of asking a
 * saturated tier again. A refusal that names no window (or carries
 * `x-should-retry: false`) opens nothing and stays a per-request failover.
 */
const lithosOpenFailoverWindowFrom = (modelRaw: string, refusal: Response, target: string, refusedRung: string): void => {
  const window = lithosRateLimitWait(refusal.headers, Date.now());
  if (window === null) return;
  lithosOpenFailoverWindow(modelRaw, Date.now(), window.waitMs, target, refusedRung);
};

/**
 * The next eligible rung of the failover ladder for a refusal, or null once the
 * ladder is exhausted (the whole stack refused) and the request must wait out
 * the vendor's own window before retrying an eligible tier.
 */
const lithosFailoverProgress = (
  input: Readonly<{ modelRaw: string; usageContext: UsageContext | undefined }>,
  state: LithosDispatchProgress
): LithosDispatchProgress | null => {
  const ladder = lithosFailoverLadderFor(input.modelRaw);
  for (let index = state.ladderIndex; index < ladder.length; index += 1) {
    const next = ladder[index];
    if (state.noRetryModels.has(next)) continue;
    logLithosRateLimitFailover({
      request_id: input.usageContext?.requestId ?? null,
      model: input.modelRaw,
      sibling_model: next,
      attempt: state.attempt,
    });
    recordLithosFailoverModel(input.usageContext, next);
    return { ...state, attemptModel: next, ladderIndex: index + 1 };
  }
  return null;
};

/** The highest tier that has not explicitly prohibited a retry, with its next ladder position. */
const lithosRetryStart = (modelRaw: string, noRetryModels: ReadonlySet<string>): Readonly<{ attemptModel: string; ladderIndex: number }> | null => {
  if (!noRetryModels.has(modelRaw)) return { attemptModel: modelRaw, ladderIndex: 0 };
  const ladder = lithosFailoverLadderFor(modelRaw);
  for (let index = 0; index < ladder.length; index += 1) {
    if (!noRetryModels.has(ladder[index])) return { attemptModel: ladder[index], ladderIndex: index + 1 };
  }
  return null;
};

/** One pass: a terminal outcome, the state the next attempt runs from, or a deferral the streamed route opens its stream behind. */
type LithosDispatchPass =
  | Readonly<{ kind: "result"; result: LithosDispatchOutcome }>
  | Readonly<{ kind: "retry"; state: LithosDispatchProgress }>
  | Readonly<{ kind: "defer"; planned: LithosRateLimitWait; state: LithosDispatchProgress }>;

/**
 * A refusal whose window is absorbed behind an already-open stream. The caller
 * returns the SSE response first and awaits this completion while its keepalive
 * frames hold the client.
 */
type LithosPendingDispatch = Readonly<{
  pending: Promise<LithosDispatchOutcome>;
  requestSignal: AbortSignal;
  downstreamSignal: AbortSignal;
  cancel: (reason?: unknown) => void;
}>;

type LithosDispatchResult = LithosDispatchOutcome | LithosPendingDispatch;

/**
 * One pass: a refusal on the requested tier is load-balanced once onto its
 * sibling tier so the request still completes. Anything else is this pass's
 * terminal outcome, carrying the vendor's own status and code.
 */
const lithosDispatchPass = async (
  input: LithosDispatchInput,
  state: LithosDispatchProgress,
  policy: LithosRefusalWaitPolicy,
  defer: boolean
): Promise<LithosDispatchPass> => {
  const attempt = await lithosDispatchAttempt(input.body, state.attemptModel, input.requestSignal, input.usageContext);
  const progressed: LithosDispatchProgress = { ...state, attempt: state.attempt + 1 };
  if (attempt.status !== 429) return { kind: "result", result: await lithosAttemptOutcome(input, attempt, progressed.attemptModel) };
  // Header capture: record what the vendor said at the refusal, not after the fact.
  logLithosRateLimitRefusal({
    request_id: input.usageContext?.requestId ?? null,
    model: progressed.attemptModel,
    attempt: progressed.attempt,
    ...lithosRateLimitSnapshot(attempt.headers),
  });
  const noRetryModels = lithosRetryProhibited(attempt.headers) ? new Set([...progressed.noRetryModels, progressed.attemptModel]) : progressed.noRetryModels;
  const eligible = { ...progressed, noRetryModels };
  // A refusal with a window deepens later requests to the next eligible ladder
  // tier; the target is re-derived per refusal, so fast refusing deepens it to
  // the family's normal tier instead of bouncing back to saturated ultra.
  const failover = lithosFailoverProgress(input, eligible);
  if (failover !== null) {
    lithosOpenFailoverWindowFrom(input.modelRaw, attempt, failover.attemptModel, progressed.attemptModel);
    cancelResponseBody(attempt);
    return { kind: "retry", state: failover };
  }
  // The eligible ladder is exhausted (or this tier has no sibling). The vendor
  // names its own reset instant on these refusals, so one bounded pause followed
  // by a retry of an eligible tier absorbs the refusal instead of surfacing it.
  // Past the caps the refusal is relayed unchanged.
  const planned = lithosRefusalWait(attempt.headers, progressed.waitedMs, progressed.waits, policy);
  if (planned !== null) {
    const retryStart = lithosRetryStart(input.modelRaw, noRetryModels);
    if (retryStart === null) return { kind: "result", result: await lithosAttemptOutcome(input, attempt, progressed.attemptModel) };
    const waitedMs = progressed.waitedMs + planned.waitMs;
    const nextState: LithosDispatchProgress = {
      attempt: progressed.attempt,
      attemptModel: retryStart.attemptModel,
      ladderIndex: retryStart.ladderIndex,
      noRetryModels,
      waitedMs,
      waits: progressed.waits + 1,
    };
    if (defer) {
      // The route opens its SSE response now and spends this window behind it;
      // the runner logs the pause and owns the retry once it elapses.
      cancelResponseBody(attempt);
      return { kind: "defer", planned, state: nextState };
    }
    logLithosRateLimitWait({
      request_id: input.usageContext?.requestId ?? null,
      model: input.modelRaw,
      attempt: progressed.attempt,
      wait_ms: planned.waitMs,
      wait_source: planned.source,
      waited_ms: waitedMs,
      cap_ms: LITHOS_REFUSAL_WAIT_CAP_MS,
    });
    recordLithosRateLimitWaitMs(input.usageContext, waitedMs);
    // The refused body is never read, so it is released here.
    cancelResponseBody(attempt);
    await waitForLithosRetry(planned.waitMs, input.requestSignal);
    return { kind: "retry", state: nextState };
  }
  // This pass is terminal: its refusal body is read by the responders below, so
  // it must not be cancelled here (only the discarded attempts above are).
  return { kind: "result", result: await lithosAttemptOutcome(input, attempt, progressed.attemptModel) };
};

/**
 * Dispatches until one pass is terminal. With `allowDefer`, a streamed caller
 * gets the absorb as a pending completion instead of an inline pause, so its
 * SSE stream can open first and keepalives can hold the client; the completion
 * then continues this loop inline with the wider streamed budget.
 */
const runLithosDispatch = async (
  input: LithosDispatchInput,
  start: LithosDispatchProgress,
  policy: LithosRefusalWaitPolicy,
  allowDefer: boolean
): Promise<LithosDispatchResult> => {
  let state = start;
  for (;;) {
    let pass: LithosDispatchPass;
    try {
      pass = await lithosDispatchPass(input, state, policy, allowDefer);
    } catch (error) {
      return {
        ok: false,
        response: await respondLithosChatDispatchFailure(error, input.downstreamSignal, input.usageContext),
        requestSignal: input.requestSignal,
        downstreamSignal: input.downstreamSignal,
      };
    }
    if (pass.kind === "result") return pass.result;
    if (pass.kind === "defer") {
      logLithosRateLimitWait({
        request_id: input.usageContext?.requestId ?? null,
        model: input.modelRaw,
        attempt: pass.state.attempt,
        wait_ms: pass.planned.waitMs,
        wait_source: pass.planned.source,
        waited_ms: pass.state.waitedMs,
        cap_ms: LITHOS_REFUSAL_WAIT_CAP_MS,
      });
      recordLithosRateLimitWaitMs(input.usageContext, pass.state.waitedMs);
      const cancellation = new AbortController();
      const requestSignal = AbortSignal.any([input.requestSignal, cancellation.signal]);
      const downstreamSignal = AbortSignal.any([input.downstreamSignal, cancellation.signal]);
      const pendingInput: LithosDispatchInput = { ...input, requestSignal, downstreamSignal };
      return {
        pending: (async (): Promise<LithosDispatchOutcome> => {
          try {
            await waitForLithosRetry(pass.planned.waitMs, requestSignal);
            const continued = await runLithosDispatch(pendingInput, pass.state, policy, false);
            if ("pending" in continued) throw new Error("A resumed LithosAI dispatch cannot defer again.");
            return continued;
          } catch (error) {
            return {
              ok: false,
              response: await respondLithosChatDispatchFailure(error, downstreamSignal, input.usageContext),
              requestSignal,
              downstreamSignal,
            };
          }
        })(),
        requestSignal,
        downstreamSignal,
        cancel: (reason) => {
          if (!cancellation.signal.aborted) cancellation.abort(reason);
        },
      };
    }
    state = pass.state;
  }
};

/**
 * Shared LithosAI dispatch for both gateway routes. It owns the provider
 * request-id capture, the dispatch/headers telemetry, and the failure
 * responders, so the Chat and Responses adapters differ only in how they
 * translate the payload. A streaming caller (`streamed`) gets the wider
 * keepalive-backed absorb as a pending completion; a buffered caller spends its
 * smaller budget inline.
 */
const dispatchLithosUpstreamResult = async (
  req: Request,
  body: Record<string, unknown>,
  modelRaw: string,
  usageContext: UsageContext | undefined,
  streamed: boolean
): Promise<LithosDispatchResult> => {
  const downstreamSignal = downstreamSignalFor(req, usageContext);
  const requestSignal = inferenceSignal(req, usageContext);
  // A tier whose window is open is served by the ladder target it points at
  // without asking the saturated tier again, and that decision is announced
  // exactly like a per-request failover. A deeper target resumes mid-ladder, so
  // its own refusal advances further down rather than restarting at the top.
  const ladder = lithosFailoverLadderFor(modelRaw);
  const stickyTarget = lithosFailoverTargetAt(modelRaw, Date.now());
  const stickyIndex = stickyTarget === null ? -1 : ladder.indexOf(stickyTarget);
  if (stickyTarget !== null) {
    logLithosRateLimitFailover({
      request_id: usageContext?.requestId ?? null,
      model: modelRaw,
      sibling_model: stickyTarget,
      attempt: 1,
    });
    recordLithosFailoverModel(usageContext, stickyTarget);
  }
  return await runLithosDispatch(
    { body, modelRaw, requestSignal, downstreamSignal, usageContext },
    { attempt: 0, attemptModel: stickyTarget ?? modelRaw, ladderIndex: stickyIndex + 1, noRetryModels: new Set(), waitedMs: 0, waits: 0 },
    streamed ? LITHOS_STREAMED_REFUSAL_WAIT_POLICY : LITHOS_BUFFERED_REFUSAL_WAIT_POLICY,
    streamed
  );
};

/**
 * The LithosAI Chat Completions route.
 *
 * The official nested Chat tools/`tool_choice` contract is preserved: this
 * branch dispatches before the Codex-specific flattening that follows it in
 * `handleChatCompletionsInternal`. Streaming is relayed rather than buffered,
 * because the vendor streams normally and reports usage on every frame
 * regardless of `stream_options`.
 */
export const handleLithosChatCompletions = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  modelRaw: string,
  usageContext?: UsageContext
): Promise<Response> => {
  const parsedRequest = validateLithosChatRequestFields(rawRecord);
  if (!parsedRequest.ok) return parsedRequest.response;
  const { reasoning, clientWantsStream } = parsedRequest.value;
  // The canonical id the provider serves for this request; the buffered and
  // streamed readers echo it, so a differently-cased request never reports a
  // mismatched model.
  const upstreamModel = lithosUpstreamModelFor(modelRaw);
  if (!upstreamModel) {
    return openaiError(400, "The requested model is not configured.", "lithos_request_invalid", { param: "model" });
  }

  // Preserve the official nested Chat tools/tool_choice contract. In
  // particular, do not run the Codex-specific flattening that follows this
  // early branch in handleChatCompletionsInternal.
  const lithosBody: Record<string, unknown> = {
    ...rawRecord,
    reasoning_effort: reasoning,
    stream: clientWantsStream,
  };
  if (!clientWantsStream) {
    // OpenAI's own contract refuses stream_options without stream:true, and this
    // provider needs nothing from it: usage arrives unconditionally.
    delete lithosBody.stream_options;
  }
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.provider = "lithos";
    usageContext.responseTelemetry.reasoning = reasoning;
    // The client's cap when it sent one, else unknown: this vendor publishes no
    // per-tier default allowance to stand in for it.
    usageContext.responseTelemetry.outputTokenAllowance = lithosChatClientOutputAllowance(rawRecord);
  }
  await recordRequestUsage(usageContext, {
    model: modelRaw,
    route: "chat.completions",
    stream: clientWantsStream,
    reasoning,
  });

  const dispatched = await dispatchLithosUpstreamResult(req, lithosBody, modelRaw, usageContext, clientWantsStream);
  if ("pending" in dispatched) {
    // Same deferred absorb as the Responses route: the Chat stream opens now,
    // keepalives hold the client, and the vendor's window is spent behind it.
    const servedModel = { current: modelRaw };
    const upstream = dispatched.pending.then((outcome) => {
      if (outcome.ok) servedModel.current = outcome.servedModel;
      return outcome.ok ? outcome.upstream : outcome.response;
    });
    return streamLithosChatCompletion(
      upstream,
      null,
      usageContext,
      dispatched.downstreamSignal,
      dispatched.requestSignal,
      upstreamModel,
      () => servedModel.current,
      dispatched.cancel
    );
  }
  if (!dispatched.ok) {
    // Same guarantee as the Responses route: a streamed refusal is reported
    // in-band so no client can surface it as a retryable 429.
    if (clientWantsStream) {
      return streamLithosChatCompletion(
        dispatched.response,
        null,
        usageContext,
        dispatched.downstreamSignal,
        dispatched.requestSignal,
        upstreamModel,
        modelRaw
      );
    }
    return dispatched.response;
  }
  const { upstream, requestSignal, downstreamSignal, servedModel } = dispatched;
  const providerRequestId = dispatched.providerRequestId;

  if (clientWantsStream) {
    return streamLithosChatCompletion(upstream, providerRequestId, usageContext, downstreamSignal, requestSignal, upstreamModel, servedModel);
  }

  const captured = await readBoundedResponseBody(upstream, {
    signal: requestSignal,
    maxBytes: LITHOS_BUFFERED_BODY_MAX_BYTES,
    // Successful buffered inference uses the request-level edge deadline, not
    // the one-second error-body default. `requestSignal` still caps the whole
    // request from dispatch through body completion.
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
    cancellationReason: "LithosAI Chat Completions response was incomplete",
  });
  if (!captured.complete) {
    return await respondLithosChatIncompleteCapture(usageContext, downstreamSignal, requestSignal, providerRequestId);
  }

  const completion = await readLithosChatCompletion(captured.bytes, upstream.status, providerRequestId, usageContext, upstreamModel, servedModel);
  if (!completion.ok) return completion.response;

  if (chatCompletionHasAnswerBearingOutput(completion.value)) markChatSemanticOutput(usageContext);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.providerRequestId = providerRequestId;
  const usage = extractChatUsageTokens(completion.value.usage);
  await recordCompletionUsage(usageContext, usage);
  recordStreamTerminalType(usageContext, "response.completed");
  recordLithosResponseHealth(upstream.status, providerRequestId);
  return json(200, completion.value, lithosResponseHeaders(providerRequestId));
};

/**
 * Fails a buffered LithosAI Responses completion closed when the provider
 * reported success but the translated output carries nothing a client can act
 * on, matching the streamed path's guard.
 */
const respondLithosEmptyBufferedCompletion = (
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
  recordLithosResponseHealth(upstreamStatus, providerRequestId);
  return openaiError(502, EMPTY_UPSTREAM_COMPLETION_MESSAGE, "empty_upstream_completion", {
    type: "server_error",
    headers: lithosResponseHeaders(providerRequestId),
  });
};

/**
 * Records a buffered LithosAI Responses terminal. The payload carries the
 * provider's own terminal, so telemetry reports the terminal the client
 * receives instead of assuming success, and the non-completed classification
 * matches the streamed path.
 */
const recordBufferedLithosResponsesTerminal = (
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
    recordLithosFailureKind(usageContext, terminalType === "response.incomplete" ? "incomplete_response" : "upstream_error");
    void recordLithosProviderHealth("upstream_error", upstreamStatus, Date.now, providerRequestId);
  }
  recordLithosResponseHealth(upstreamStatus, providerRequestId);
};

/**
 * Finalizes the buffered LithosAI Responses branch: reads the captured body,
 * applies the provider terminal's classification, and returns this request's
 * single response. Admission, the request record, the response identity and the
 * echo all belong to the caller, so no second terminal is created here.
 */
const finalizeBufferedLithosResponses = async (
  options: Readonly<{
    upstream: Response;
    modelRaw: string;
    responseId: string;
    echo: DeepSeekResponsesEcho;
    toolNames: ReadonlyMap<string, OriginalToolName>;
    customToolNames: ReadonlySet<string>;
    upstreamModel: string;
    servedModel: string;
    providerRequestId: string | null;
    requestSignal: AbortSignal;
    downstreamSignal: AbortSignal;
    usageContext?: UsageContext;
  }>
): Promise<Response> => {
  const captured = await readBoundedResponseBody(options.upstream, {
    signal: options.requestSignal,
    maxBytes: LITHOS_BUFFERED_BODY_MAX_BYTES,
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
    cancellationReason: "LithosAI Responses adapter body was incomplete",
  });
  if (!captured.complete) {
    return await respondLithosChatIncompleteCapture(options.usageContext, options.downstreamSignal, options.requestSignal, options.providerRequestId);
  }

  const completion = await readLithosChatCompletion(
    captured.bytes,
    options.upstream.status,
    options.providerRequestId,
    options.usageContext,
    options.upstreamModel,
    options.servedModel
  );
  if (!completion.ok) return completion.response;

  const providerRequestId = options.providerRequestId;
  if (options.usageContext?.responseTelemetry) options.usageContext.responseTelemetry.providerRequestId = providerRequestId;
  const firstCompletion = completion.value;
  const payload = toDeepSeekResponsesPayload(
    firstCompletion,
    options.modelRaw,
    options.responseId,
    options.echo,
    options.toolNames,
    options.customToolNames,
    LITHOS_RESPONSES_PROFILE
  );
  const usage = extractChatUsageTokens(firstCompletion.usage);
  // The provider's own reason decides the terminal first: an explicit
  // truncation is `response.incomplete` and is reported as such. Only a
  // would-be completion is then measured for answer-bearing output, which is
  // the same order the streamed path applies.
  if (deepSeekTerminalTypeForPayload(payload.status) === "response.completed" && !chatCompletionHasAnswerBearingOutput(firstCompletion)) {
    return respondLithosEmptyBufferedCompletion(options.usageContext, usage, options.upstream.status, providerRequestId);
  }
  recordBufferedLithosResponsesTerminal(options.usageContext, payload, usage, options.upstream.status, providerRequestId);
  return json(200, payload, lithosResponseHeaders(providerRequestId));
};

/**
 * Responses adapter for the LithosAI route.
 *
 * The vendor has no `/v1/responses` endpoint (probed: 404), so the shared
 * translation in `src/deepseek_responses.ts` runs under
 * `LITHOS_RESPONSES_PROFILE`: the profile owns this provider's model table,
 * reasoning-tier acceptance, usage counters and streaming-usage policy, and the
 * translation itself is the same one the DeepSeek route uses. Everything
 * provider-level (dispatch admission, deadlines, health, telemetry, error
 * reflection) is shared with the Chat route above.
 */
export const handleLithosResponses = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  modelRaw: string,
  usageContext?: UsageContext
): Promise<Response> => {
  const parsedStream = parseStreamField(rawRecord.stream);
  if (!parsedStream.ok) return openaiError(400, parsedStream.message, "invalid_request_error", { param: "stream" });
  const clientWantsStream = parsedStream.value;
  // The route only dispatches here for a LithosAI id, so this guard covers the
  // handler's own contract rather than a reachable client path.
  const upstreamModel = lithosUpstreamModelFor(modelRaw);
  if (!upstreamModel) return openaiError(400, `model '${modelRaw}' is not a LithosAI official model`, "invalid_request_error", { param: "model" });

  const translated = toDeepSeekResponsesChatBody(rawRecord, modelRaw, clientWantsStream, LITHOS_RESPONSES_PROFILE);
  if (!translated.ok) return openaiError(400, translated.message, translated.code ?? "invalid_request_error", { param: translated.param });
  const { body: chatBody, toolNames, customToolNames } = translated.value;
  if (translated.value.elisions.length) logForwardedPayloadElisions(translated.value.elisions);

  const echo: DeepSeekResponsesEcho = {
    tools: rawRecord.tools,
    tool_choice: rawRecord.tool_choice,
    parallel_tool_calls: rawRecord.parallel_tool_calls,
    instructions: typeof rawRecord.instructions === "string" && rawRecord.instructions.trim() ? rawRecord.instructions : null,
  };
  const reasoningLabel = typeof chatBody.reasoning_effort === "string" ? chatBody.reasoning_effort : LITHOS_DEFAULT_REASONING_EFFORT;
  chatBody.reasoning_effort = reasoningLabel;
  // The client's cap when it sent one, else unknown: this vendor publishes no
  // per-tier default allowance to stand in for it.
  const outputAllowance = typeof chatBody.max_tokens === "number" ? chatBody.max_tokens : null;
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.provider = "lithos";
    usageContext.responseTelemetry.reasoning = reasoningLabel;
    // `applyOutputLimit` put the client's `max_output_tokens` on the wire as
    // `max_tokens`; an absent cap stays unknown rather than being invented.
    usageContext.responseTelemetry.outputTokenAllowance = outputAllowance;
  }
  await recordRequestUsage(usageContext, {
    model: modelRaw,
    route: "responses",
    stream: clientWantsStream,
    reasoning: reasoningLabel,
  });

  const createdAtSeconds = Math.floor(Date.now() / 1000);
  const dispatched = await dispatchLithosUpstreamResult(req, chatBody, modelRaw, usageContext, clientWantsStream);
  if ("pending" in dispatched) {
    // The streamed route opens its SSE response now and its keepalive frames
    // hold the client while the vendor's own window passes behind it. The
    // pending completion resolves either to the attempt that answers - possibly
    // the sibling, so the serving tier is read after it lands - or to the
    // refusal, which the relay reports in-band because a status can no longer
    // be returned.
    const servedModel = { current: modelRaw };
    const upstream = dispatched.pending.then((outcome) => {
      if (outcome.ok) servedModel.current = outcome.servedModel;
      return outcome.ok ? outcome.upstream : outcome.response;
    });
    const responseId = `resp_${crypto
      .randomUUID()
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 40)}`;
    return streamLithosResponses(
      upstream,
      modelRaw,
      responseId,
      createdAtSeconds,
      echo,
      toolNames,
      customToolNames,
      null,
      usageContext,
      dispatched.downstreamSignal,
      dispatched.requestSignal,
      upstreamModel,
      () => servedModel.current,
      dispatched.cancel
    );
  }
  if (!dispatched.ok) {
    // A streamed request never receives an HTTP 429 from this route: the
    // gateway's Codex clients interpret that status as "retry", and when their
    // own retry limit runs out the user sees `exceeded retry limit, last status:
    // 429`. Opening the stream and reporting the refusal in-band makes the
    // vendor's own code (and its reset instant) the thing the client reads, and
    // makes that banner unreachable on this wire. Buffered requests keep the
    // status, because no stream exists to carry the terminal.
    if (clientWantsStream) {
      return streamLithosResponses(
        dispatched.response,
        modelRaw,
        `resp_${crypto
          .randomUUID()
          .replace(/[^A-Za-z0-9]/g, "")
          .slice(0, 40)}`,
        createdAtSeconds,
        echo,
        toolNames,
        customToolNames,
        null,
        usageContext,
        dispatched.downstreamSignal,
        dispatched.requestSignal,
        upstreamModel,
        modelRaw
      );
    }
    return dispatched.response;
  }
  const { upstream, requestSignal, downstreamSignal, servedModel } = dispatched;
  const providerRequestId = dispatched.providerRequestId;
  const responseId = `resp_${(providerRequestId ?? crypto.randomUUID()).replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`;

  if (clientWantsStream) {
    return streamLithosResponses(
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
      upstreamModel,
      servedModel
    );
  }

  return finalizeBufferedLithosResponses({
    upstream,
    modelRaw,
    responseId,
    echo,
    toolNames,
    customToolNames,
    upstreamModel,
    servedModel,
    providerRequestId,
    requestSignal,
    downstreamSignal,
    usageContext,
  });
};
