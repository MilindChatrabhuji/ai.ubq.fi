// Responses attempt preparation and buffered-response accumulation, extracted from src/openai.ts.

import { recordRemovedProviderCircuitTransition } from "./responses-handler.ts";
import { createMeteredTransportLifecycle } from "./paid-fallback/health.ts";
import { fetchResponsesWithPaidFallback } from "./paid-fallback/routing.ts";
import { CodexError, markCodexResponseUpstreamError, releaseCodexResponseProbe } from "./codex/index.ts";
import { ApiKeyQuotaDispatchError } from "./api-key-policy.ts";
import { type StreamDeadline } from "./inference-deadline.ts";
import {
  readResponsesStream,
  ResponsesStreamError,
  type ResponsesStreamEvent,
  type ResponsesStreamFailureKind,
  type ResponsesStreamIterator,
} from "./responses-stream.ts";
import {
  fetchRemovedProviderResponses,
  isEligibleRemovedProviderModel,
  removedProviderModelFromEvent,
  removedProviderTaskTypeFromResponse,
  stripRemovedProviderMetadata,
} from "./paid-fallback/removed-provider.ts";
import {
  closeRemovedProviderCircuit,
  recordRemovedProviderEligibleFailure,
  releaseRemovedProviderCircuitProbe as releaseGlobalRemovedProviderProbe,
  type RemovedProviderCircuitProbe,
} from "./provider/removed-provider-circuit.ts";
import {
  appendResponsesPrecommitEvent,
  type PreparedResponsesStream,
  prepareResponsesStreamForCommit,
  responseEventFromValue,
  responseIdFromEvents,
} from "./responses-failover-stream.ts";
import { isRecord } from "./utils.ts";
import {
  type ResponseStreamTerminalType,
  type RoutedResponsesUpstream,
  type UpstreamProvider,
  type UsageContext,
  classifyPreHeaderFailure,
  isTimeoutFailure,
  recordAttemptedProvider,
  recordFirstProviderDispatch,
  recordFirstProviderHeaders,
  recordFirstUpstreamSseEvent,
  recordResponsesEventTelemetry,
  selectRemovedProviderTelemetry,
  streamErrorResponse,
  supportsReasoningProgressRelease,
  type MeteredTransportLifecycle,
} from "./openai-telemetry.ts";
import {} from "./chat/stream-translation.ts";
import { logRedactedUpstreamError, toCodexErrorResponse, toOpenAiUpstreamErrorResponse } from "./upstream-wire.ts";
import { responseWarnings } from "./request-policy.ts";

type ResponsesAttemptTrigger =
  | "http_4xx"
  | "http_5xx"
  | "http_error"
  | "missing_body"
  | "malformed_event"
  | "event_too_large"
  | "premature_eof"
  | "semantic_timeout"
  | "terminal_failure"
  | "empty_upstream_completion"
  | "read_error"
  | "invalid_model";

export type PreparedResponsesAttempt = Readonly<{
  provider: UpstreamProvider;
  response: Response;
  prepared: PreparedResponsesStream;
  responseId: string | null;
  selectedModel: string | null;
  taskType: string | null;
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  clearDeadline: () => void;
}>;

export type FailedResponsesAttempt = Readonly<{
  provider: UpstreamProvider;
  response: Response;
  trigger: ResponsesAttemptTrigger;
  terminal?: ResponsesStreamEvent | null;
  signal: AbortSignal;
  clearDeadline: () => void;
}>;

type ResponsesAttemptResult = { kind: "ready"; attempt: PreparedResponsesAttempt } | { kind: "failed"; attempt: FailedResponsesAttempt };

export const isEligibleResponsesAttemptStatus = (response: Response): boolean => response.status >= 500;

/**
 * Classifies a non-2xx upstream response: a client 4xx is an HTTP failure, not
 * a stream read fault, and every other non-5xx status is a generic HTTP error.
 * `primaryResponsesAttemptTrigger` keeps the separate 504 semantic timeout.
 */
const responsesHttpErrorTrigger = (status: number): "http_4xx" | "http_5xx" | "http_error" => {
  if (status >= 500) return "http_5xx";
  if (status >= 400) return "http_4xx";
  return "http_error";
};

const triggerForResponsesError = (error: unknown, signal: AbortSignal): ResponsesAttemptTrigger => {
  if (signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError") {
    return "semantic_timeout";
  }
  if (error instanceof ResponsesStreamError) {
    if (error.kind === "event_too_large") return "event_too_large";
    if (error.kind === "malformed_event") return "malformed_event";
    if (error.kind === "premature_eof") return "premature_eof";
    if (error.kind === "inactivity_timeout") return "semantic_timeout";
  }
  return "read_error";
};

export const failureKindForResponsesAttemptTrigger = (trigger: ResponsesAttemptTrigger): ResponsesStreamFailureKind | null => {
  switch (trigger) {
    case "http_4xx":
      return "upstream_http_4xx";
    case "http_5xx":
      return "upstream_http_5xx";
    case "http_error":
      return "upstream_http_error";
    case "premature_eof":
      return "premature_eof";
    case "malformed_event":
      return "malformed_event";
    case "event_too_large":
      return "event_too_large";
    case "semantic_timeout":
      return "inactivity_timeout";
    case "empty_upstream_completion":
      return "empty_upstream_completion";
    case "read_error":
    case "missing_body":
      return "read_error";
    default:
      return null;
  }
};

const safeFailedAttemptResponse = (response: Response, provider: UpstreamProvider, trigger: ResponsesAttemptTrigger, warnings: readonly string[]): Response => {
  if (!response.ok) return response;
  if (trigger === "empty_upstream_completion") {
    return streamErrorResponse(502, "The upstream completed without visible output.", "empty_upstream_completion", provider, warnings, "server_error", null);
  }
  if (trigger === "semantic_timeout") {
    return streamErrorResponse(
      504,
      "Upstream stream exceeded the gateway deadline before semantic output.",
      "gateway_timeout",
      provider,
      warnings,
      "server_error"
    );
  }
  if (trigger === "missing_body") {
    return streamErrorResponse(502, "Upstream response missing body.", "server_error", provider, warnings);
  }
  return streamErrorResponse(502, "Upstream Responses stream ended unexpectedly.", "server_error", provider, warnings);
};

const responsesAttemptTriggerFor = (semantic: ResponsesStreamEvent | null, fallback: ResponsesAttemptTrigger): ResponsesAttemptTrigger =>
  semantic ? "terminal_failure" : fallback;

const responsesTerminalRejectionTrigger = (
  presemanticRejection: boolean | undefined,
  semantic: ResponsesStreamEvent | null,
  terminal: ResponsesStreamEvent
): ResponsesAttemptTrigger =>
  presemanticRejection && semantic === null && (terminal.type === "response.failed" || terminal.type === "error") ? "terminal_failure" : "read_error";

const applyResponsesEventIdentity = (
  event: ResponsesStreamEvent,
  selectedModel: string | null,
  taskType: string | null
): Readonly<{ selectedModel: string | null; taskType: string | null; modelConflict: boolean }> => {
  let resolvedModel = selectedModel;
  let resolvedTaskType = taskType;
  const candidate = removedProviderModelFromEvent(event.value);
  if (candidate) {
    if (resolvedModel && resolvedModel !== candidate) return { selectedModel: resolvedModel, taskType: resolvedTaskType, modelConflict: true };
    resolvedModel = candidate;
  }
  if (!resolvedTaskType && isRecord(event.value.response)) {
    resolvedTaskType = removedProviderTaskTypeFromResponse(event.value.response);
  }
  return { selectedModel: resolvedModel, taskType: resolvedTaskType, modelConflict: false };
};

const resolveBufferedResponsesIdentity = async (
  iterator: ResponsesStreamIterator,
  prepared: PreparedResponsesStream
): Promise<Readonly<{ selectedModel: string | null; taskType: string | null; trigger: ResponsesAttemptTrigger | null }>> => {
  let selectedModel: string | null = null;
  let taskType: string | null = null;
  for (const event of prepared.buffered) {
    const identity = applyResponsesEventIdentity(event, selectedModel, taskType);
    if (identity.modelConflict) {
      await iterator.return("inconsistent model identity").catch(() => {});
      return { selectedModel, taskType, trigger: responsesAttemptTriggerFor(prepared.semantic, "invalid_model") };
    }
    selectedModel = identity.selectedModel;
    taskType = identity.taskType;
  }
  return { selectedModel, taskType, trigger: null };
};

const extendResponsesIdentityFromStream = async (
  iterator: ResponsesStreamIterator,
  prepared: PreparedResponsesStream,
  options: Readonly<{ usageContext?: UsageContext; requireEligibleModel?: boolean }>,
  buffered: Readonly<{ selectedModel: string | null; taskType: string | null }>
): Promise<
  | Readonly<{ kind: "failed"; trigger: ResponsesAttemptTrigger }>
  | Readonly<{
      kind: "discovered";
      responseId: string | null;
      bufferedChars: number;
      terminal: ResponsesStreamEvent | null;
      selectedModel: string | null;
      taskType: string | null;
    }>
> => {
  let responseId = responseIdFromEvents(prepared.buffered);
  let bufferedChars = prepared.bufferedChars;
  let discoveredTerminal = prepared.terminal;
  let selectedModel = buffered.selectedModel;
  let taskType = buffered.taskType;
  while (options.requireEligibleModel && (!selectedModel || !responseId) && !discoveredTerminal) {
    const next = await iterator.next();
    if (next.done) break;
    recordResponsesEventTelemetry(options.usageContext, next.value);
    bufferedChars = appendResponsesPrecommitEvent(prepared.buffered, next.value, bufferedChars);
    const candidateResponseId = responseIdFromEvents([next.value]);
    if (candidateResponseId && responseId && candidateResponseId !== responseId) {
      await iterator.return("inconsistent response identity").catch(() => {});
      return { kind: "failed", trigger: responsesAttemptTriggerFor(prepared.semantic, "malformed_event") };
    }
    responseId ??= candidateResponseId;
    const identity = applyResponsesEventIdentity(next.value, selectedModel, taskType);
    if (identity.modelConflict) {
      await iterator.return("inconsistent model identity").catch(() => {});
      return { kind: "failed", trigger: responsesAttemptTriggerFor(prepared.semantic, "invalid_model") };
    }
    selectedModel = identity.selectedModel;
    taskType = identity.taskType;
    if (next.value.terminal) discoveredTerminal = next.value;
  }
  return { kind: "discovered", responseId, bufferedChars, terminal: discoveredTerminal, selectedModel, taskType };
};

const rejectFailedResponsesDiscovery = async (
  iterator: ResponsesStreamIterator,
  prepared: PreparedResponsesStream,
  deadline: StreamDeadline,
  options: Readonly<{ requireEligibleModel?: boolean; rejectFailedTerminal?: boolean }>,
  discovered: Readonly<{ responseId: string | null; selectedModel: string | null; terminal: ResponsesStreamEvent | null }>
): Promise<ResponsesAttemptTrigger | null> => {
  if (
    options.rejectFailedTerminal &&
    discovered.terminal &&
    (discovered.terminal.type === "response.failed" || discovered.terminal.type === "error") &&
    prepared.semantic === null
  ) {
    await iterator.return("failed terminal before release").catch(() => {});
    return "read_error";
  }
  if (options.requireEligibleModel && !prepared.buffered.some((event) => event.type === "response.created")) {
    await iterator.return("missing response.created").catch(() => {});
    return responsesAttemptTriggerFor(prepared.semantic, "malformed_event");
  }
  if (options.requireEligibleModel && !discovered.responseId) {
    await iterator.return("missing response id").catch(() => {});
    return responsesAttemptTriggerFor(prepared.semantic, "malformed_event");
  }
  deadline.clear();
  if (options.requireEligibleModel && (!discovered.selectedModel || !isEligibleRemovedProviderModel(discovered.selectedModel))) {
    await iterator.return("invalid selected model").catch(() => {});
    return responsesAttemptTriggerFor(prepared.semantic, "invalid_model");
  }
  return null;
};

const responsesStreamTerminalFailure = async (
  iterator: ResponsesStreamIterator,
  prepared: PreparedResponsesStream,
  deadline: StreamDeadline,
  options: Readonly<{ rejectFailedTerminal?: boolean; rejectPresemanticFailureTerminal?: boolean }>
): Promise<Readonly<{ trigger: ResponsesAttemptTrigger; terminal: ResponsesStreamEvent | null }> | null> => {
  if (prepared.terminal?.type === "response.completed" && prepared.semantic === null) {
    await iterator.return("empty upstream completion").catch(() => {});
    return { trigger: "empty_upstream_completion", terminal: prepared.terminal };
  }
  if (
    prepared.terminal &&
    ((options.rejectFailedTerminal && (prepared.terminal.type === "response.failed" || prepared.terminal.type === "error") && prepared.semantic === null) ||
      (options.rejectPresemanticFailureTerminal &&
        prepared.semantic === null &&
        (prepared.terminal.type === "response.failed" || prepared.terminal.type === "error")))
  ) {
    deadline.clear();
    return {
      trigger: responsesTerminalRejectionTrigger(options.rejectPresemanticFailureTerminal, prepared.semantic, prepared.terminal),
      terminal: null,
    };
  }
  return null;
};

const finalizePreparedResponsesAttempt = (
  prepared: PreparedResponsesStream,
  iterator: ResponsesStreamIterator,
  discovered: Readonly<{
    responseId: string | null;
    bufferedChars: number;
    terminal: ResponsesStreamEvent | null;
    selectedModel: string | null;
    taskType: string | null;
  }>,
  provider: UpstreamProvider,
  response: Response,
  deadline: StreamDeadline,
  options: Readonly<{ requireEligibleModel?: boolean }>
): ResponsesAttemptResult => {
  const sanitizedBuffered = options.requireEligibleModel
    ? prepared.buffered.map((event) => {
        const value = stripRemovedProviderMetadata(event.value);
        return value === event.value ? event : responseEventFromValue(value);
      })
    : prepared.buffered;
  const sanitizedTerminal = discovered.terminal ? (sanitizedBuffered[prepared.buffered.indexOf(discovered.terminal)] ?? discovered.terminal) : null;
  const sanitizedIterator = options.requireEligibleModel
    ? (async function* (): ResponsesStreamIterator {
        for await (const event of iterator) {
          const value = stripRemovedProviderMetadata(event.value);
          yield value === event.value ? event : responseEventFromValue(value);
        }
        return undefined;
      })()
    : iterator;
  return {
    kind: "ready",
    attempt: {
      provider,
      response,
      prepared: {
        ...prepared,
        iterator: sanitizedIterator,
        buffered: sanitizedBuffered,
        bufferedChars: discovered.bufferedChars,
        terminal: sanitizedTerminal,
      },
      responseId: discovered.responseId,
      selectedModel: discovered.selectedModel,
      taskType: discovered.taskType,
      signal: deadline.signal,
      abort: deadline.abort,
      clearDeadline: deadline.clear,
    },
  };
};

export const prepareResponsesAttempt = async (
  response: Response,
  provider: UpstreamProvider,
  deadline: StreamDeadline,
  requestSignal: AbortSignal,
  warnings: readonly string[],
  options: Readonly<{
    usageContext?: UsageContext;
    requireEligibleModel?: boolean;
    rejectFailedTerminal?: boolean;
    rejectPresemanticFailureTerminal?: boolean;
    releaseOnProgress?: boolean;
  }> = {}
): Promise<ResponsesAttemptResult> => {
  const fail = (trigger: ResponsesAttemptTrigger, failedResponse = response, terminal: ResponsesStreamEvent | null = null): ResponsesAttemptResult => {
    deadline.clear();
    return {
      kind: "failed",
      attempt: {
        provider,
        response: safeFailedAttemptResponse(failedResponse, provider, trigger, warnings),
        trigger,
        terminal,
        signal: deadline.signal,
        clearDeadline: deadline.clear,
      },
    };
  };
  if (!response.ok) {
    const trigger = responsesHttpErrorTrigger(response.status);
    const normalized = await toOpenAiUpstreamErrorResponse(response, provider, deadline.signal);
    deadline.clear();
    return fail(trigger, normalized);
  }
  if (!response.body) {
    deadline.clear();
    return fail("missing_body");
  }
  const iterator = readResponsesStream(response.body, deadline.signal, {
    firstEventTimeoutMs: Math.ceil(deadline.remainingMs()),
  });
  let preparedStream: PreparedResponsesStream | null = null;
  try {
    const prepared = await prepareResponsesStreamForCommit(iterator, {
      onEvent: (event) => {
        recordFirstUpstreamSseEvent(options.usageContext);
        recordResponsesEventTelemetry(options.usageContext, event);
      },
      releaseOnProgress: options.releaseOnProgress,
    });
    preparedStream = prepared;
    const terminalFailure = await responsesStreamTerminalFailure(iterator, prepared, deadline, options);
    if (terminalFailure) return fail(terminalFailure.trigger, response, terminalFailure.terminal);
    const buffered = await resolveBufferedResponsesIdentity(iterator, prepared);
    if (buffered.trigger) return fail(buffered.trigger);
    const discovered = await extendResponsesIdentityFromStream(iterator, prepared, options, buffered);
    if (discovered.kind === "failed") return fail(discovered.trigger);
    const rejectionTrigger = await rejectFailedResponsesDiscovery(iterator, prepared, deadline, options, discovered);
    if (rejectionTrigger) return fail(rejectionTrigger);
    return finalizePreparedResponsesAttempt(prepared, iterator, discovered, provider, response, deadline, options);
  } catch (error) {
    await preparedStream?.iterator.return(error).catch(() => {});
    deadline.clear();
    if (requestSignal.aborted) throw requestSignal.reason ?? error;
    return fail(preparedStream?.semantic ? "terminal_failure" : triggerForResponsesError(error, deadline.signal));
  }
};

export type ResponsesRouteAttempt = Readonly<{
  routed: RoutedResponsesUpstream;
  prepared: PreparedResponsesAttempt;
  lifecycle: MeteredTransportLifecycle;
}>;

export type ResponsesRouteFailure = Readonly<{
  routed: RoutedResponsesUpstream;
  failed: FailedResponsesAttempt;
  lifecycle: MeteredTransportLifecycle;
}>;

export const responseFailureTerminalType = (
  trigger: ResponsesAttemptTrigger,
  signal: AbortSignal,
  downstreamSignal: AbortSignal
): ResponseStreamTerminalType => {
  if (trigger === "semantic_timeout" || isTimeoutFailure(signal.reason, downstreamSignal.reason)) return "deadline";
  if (downstreamSignal.aborted) return "cancelled";
  if (signal.aborted) return "deadline";
  if (trigger === "premature_eof") return "eof";
  if (trigger === "terminal_failure" || trigger === "empty_upstream_completion") return "response.failed";
  return "error";
};

type PrimaryResponsesOptions = Readonly<{
  model: string;
  reasoning: string | null;
  clientWantsStream: boolean;
  usageContext?: UsageContext;
  clientVersion?: string | null;
  requestSignal: AbortSignal;
  downstreamSignal: AbortSignal;
  warnings: readonly string[];
  attemptDeadline: StreamDeadline;
  fallbackSignal?: AbortSignal;
  createFallbackDeadline?: () => StreamDeadline;
  rejectPresemanticFailureTerminal?: boolean;
  releaseOnProgress?: boolean;
  /**
   * Request-scoped paid-tier pin, threaded from the DeepSeek waterfall's paid
   * hops; null or absent keeps the fixed paid cost order for every other
   * caller.
   */
  allowedPaidProviders?: readonly ("metered" | "surplus")[] | null;
  deepSeekWaterfallPaidHop?: "surplus" | "openlux" | null;
}>;

const isRetryablePrimaryFetchFailure = (error: unknown): error is CodexError =>
  error instanceof CodexError && (error.code === "gateway_timeout" || error.code === "codex_upstream_unreachable");

const primaryResponsesAttemptTrigger = (status: number): ResponsesAttemptTrigger => {
  if (status === 504) return "semantic_timeout";
  return responsesHttpErrorTrigger(status);
};

const failedPrimaryResponsesFetchOutcome = (error: CodexError, deadline: StreamDeadline): { kind: "failed"; value: ResponsesRouteFailure } => {
  logRedactedUpstreamError("[ai.ubq.fi] Upstream fetch failed:", error);
  const response = toCodexErrorResponse(error, "chatgpt_codex");
  const trigger: ResponsesAttemptTrigger = error.code === "gateway_timeout" ? "semantic_timeout" : "read_error";
  return {
    kind: "failed",
    value: {
      routed: {
        response,
        provider: "chatgpt_codex",
        paidFallback: null,
        gatewayResponse: false,
        fallbackReason: null,
      },
      lifecycle: createMeteredTransportLifecycle(null),
      failed: {
        provider: "chatgpt_codex",
        response,
        trigger,
        signal: deadline.signal,
        clearDeadline: deadline.clear,
      },
    },
  };
};

const failedPrimaryResponsesGatewayOutcome = (
  routed: RoutedResponsesUpstream,
  lifecycle: MeteredTransportLifecycle,
  preparationDeadline: StreamDeadline
): { kind: "failed"; value: ResponsesRouteFailure } => ({
  kind: "failed",
  value: {
    routed,
    lifecycle,
    failed: {
      provider: routed.provider,
      response: routed.response,
      // Admission and capability rejections are gateway decisions, not HTTP
      // responses from the selected provider. Preserve their pre-existing
      // gateway classification instead of labeling them upstream failures.
      trigger: routed.allowRemovedProviderRecovery === false ? "read_error" : primaryResponsesAttemptTrigger(routed.response.status),
      signal: preparationDeadline.signal,
      clearDeadline: preparationDeadline.clear,
    },
  },
});

const preparePrimaryResponsesAttempt = async (
  routed: RoutedResponsesUpstream,
  preparationDeadline: StreamDeadline,
  lifecycle: MeteredTransportLifecycle,
  options: PrimaryResponsesOptions
): Promise<ResponsesAttemptResult> => {
  try {
    return await prepareResponsesAttempt(
      routed.response,
      routed.provider,
      preparationDeadline,
      options.requestSignal,
      [...options.warnings, ...responseWarnings(routed.response)],
      {
        usageContext: options.usageContext,
        rejectPresemanticFailureTerminal: options.rejectPresemanticFailureTerminal,
        releaseOnProgress: options.releaseOnProgress === true && supportsReasoningProgressRelease(routed.provider),
      }
    );
  } catch (error) {
    if (options.requestSignal.aborted) {
      await finalizeAbandonedPrimaryAttempt(routed, lifecycle, {
        cancelled: classifyPreHeaderFailure(error, options.requestSignal, options.downstreamSignal) === "cancelled",
      });
    }
    throw error;
  }
};

export const fetchAndPreparePrimaryResponses = async (
  body: Record<string, unknown>,
  options: PrimaryResponsesOptions
): Promise<{ kind: "ready"; value: ResponsesRouteAttempt } | { kind: "failed"; value: ResponsesRouteFailure }> => {
  const deadline = options.attemptDeadline;
  let routed: RoutedResponsesUpstream;
  try {
    routed = await fetchResponsesWithPaidFallback(body, {
      model: options.model,
      route: "responses",
      stream: options.clientWantsStream,
      reasoning: options.reasoning,
      usageContext: options.usageContext,
      clientVersion: options.clientVersion,
      signal: deadline.signal,
      fallbackSignal: options.fallbackSignal,
      allowedPaidProviders: options.allowedPaidProviders ?? null,
      deepSeekWaterfallPaidHop: options.deepSeekWaterfallPaidHop ?? null,
    });
  } catch (error) {
    deadline.clear();
    if (options.requestSignal.aborted || error instanceof ApiKeyQuotaDispatchError) throw error;
    if (!isRetryablePrimaryFetchFailure(error)) throw error;
    return failedPrimaryResponsesFetchOutcome(error, deadline);
  }
  let preparationDeadline = deadline;
  if (routed.provider !== "chatgpt_codex" && options.createFallbackDeadline) {
    deadline.clear();
    preparationDeadline = options.createFallbackDeadline();
  }
  const lifecycle = createMeteredTransportLifecycle(
    routed.paidFallback,
    routed.provider,
    routed.paidFallbackProviderRequestId ?? null,
    routed.paidFallbackBilling ?? null,
    options.model,
    routed.providerHealthOnly === true,
    routed.paidFallbackErrorHealth ?? null
  );
  if (routed.gatewayResponse) {
    preparationDeadline.clear();
    return failedPrimaryResponsesGatewayOutcome(routed, lifecycle, preparationDeadline);
  }
  const prepared = await preparePrimaryResponsesAttempt(routed, preparationDeadline, lifecycle, options);
  if (prepared.kind === "ready") {
    return { kind: "ready", value: { routed, prepared: prepared.attempt, lifecycle } };
  }
  return { kind: "failed", value: { routed, failed: prepared.attempt, lifecycle } };
};

export const fetchAndPrepareRemovedProviderResponses = async (
  body: Record<string, unknown>,
  options: Readonly<{
    usageContext?: UsageContext;
    requestSignal: AbortSignal;
    sessionId: string | null;
    apiKey: string;
    attemptDeadline: StreamDeadline;
  }>
): Promise<ResponsesAttemptResult> => {
  const deadline = options.attemptDeadline;
  recordAttemptedProvider(options.usageContext, "removed_provider");
  selectRemovedProviderTelemetry(options.usageContext);
  let response: Response;
  try {
    const result = await fetchRemovedProviderResponses(body, {
      apiKey: options.apiKey,
      sessionId: options.sessionId,
      signal: deadline.signal,
      timing: {
        onDispatch: () => {
          recordFirstProviderDispatch(options.usageContext);
        },
        onHeaders: () => {
          recordFirstProviderHeaders(options.usageContext);
        },
      },
      beforeDispatch: () => options.usageContext?.beforeProviderDispatch?.("removed_provider") ?? Promise.resolve(undefined),
    });
    response = result.response;
  } catch (error) {
    deadline.clear();
    if (error instanceof ApiKeyQuotaDispatchError) throw error;
    if (options.requestSignal.aborted) throw options.requestSignal.reason ?? error;
    return {
      kind: "failed",
      attempt: {
        provider: "removed_provider",
        response: streamErrorResponse(502, "RemovedProvider request failed before response headers were received.", "server_error", "removed_provider", []),
        trigger: triggerForResponsesError(error, deadline.signal),
        signal: deadline.signal,
        clearDeadline: deadline.clear,
      },
    };
  }
  return await prepareResponsesAttempt(response, "removed_provider", deadline, options.requestSignal, [], {
    usageContext: options.usageContext,
    requireEligibleModel: true,
    rejectFailedTerminal: true,
  });
};

export const finalizeAbandonedPrimaryAttempt = async (
  routed: RoutedResponsesUpstream,
  lifecycle: MeteredTransportLifecycle,
  options: Readonly<{
    cancelled?: boolean;
    failureTrigger?: ResponsesAttemptTrigger;
  }> = {}
): Promise<void> => {
  if (routed.provider === "chatgpt_codex") {
    const transition = routed.response.ok && !options.cancelled ? markCodexResponseUpstreamError(routed.response) : releaseCodexResponseProbe(routed.response);
    await transition.catch(() => {});
  } else if ((routed.provider === "metered" || routed.provider === "surplus") && !routed.gatewayResponse) {
    if (options.cancelled) lifecycle.cancelled();
    else if (options.failureTrigger === "http_5xx" || options.failureTrigger === "terminal_failure" || options.failureTrigger === "empty_upstream_completion") {
      lifecycle.terminal("response.failed");
    } else lifecycle.ambiguous();
  }
};

const selectPrimarySemanticRecoveryTransition = (
  routed: RoutedResponsesUpstream,
  circuitProbe: RemovedProviderCircuitProbe,
  terminalType?: string | null
): Promise<"none"> => {
  if (routed.provider !== "chatgpt_codex") return releaseGlobalRemovedProviderProbe(circuitProbe);
  if (terminalType === "response.failed") return recordRemovedProviderEligibleFailure(circuitProbe);
  return closeRemovedProviderCircuit(circuitProbe);
};

export const markPrimarySemanticRecovery = (
  routed: RoutedResponsesUpstream,
  circuitProbe: RemovedProviderCircuitProbe | null,
  usageContext?: UsageContext,
  terminalType?: string | null
): void => {
  if (!circuitProbe) return;
  const transition = selectPrimarySemanticRecoveryTransition(routed, circuitProbe, terminalType);
  void transition
    .then((value) => {
      // The retired circuit module only ever yields "none" today, so the
      // transition is recorded through the same string-typed helper the
      // failover path uses. The guard still evaluates the real value.
      recordRemovedProviderCircuitTransition(usageContext, value);
    })
    .catch(() => {});
};
