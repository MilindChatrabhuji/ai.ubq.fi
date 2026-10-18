// Responses routing, attempts, delivery and handler, extracted from src/openai.ts.

import { handleLithosResponses } from "./provider/lithos-handlers.ts";
import { handleCerebrasResponses } from "./provider/cerebras-responses.ts";
import { handleDeepSeekResponses } from "./deepseek/handlers.ts";
import { handleDeepSeekWaterfallResponses } from "./deepseek/waterfall-handler.ts";
import { isDeepSeekWaterfallModel } from "./deepseek/waterfall.ts";
import { markCodexResponseCompleted, markCodexResponseUpstreamError, releaseCodexResponseProbe } from "./codex/index.ts";
import { deepSeekUpstreamModelFor } from "./deepseek/index.ts";
import { cerebrasUpstreamModelFor } from "./provider/cerebras.ts";
import { lithosUpstreamModelFor } from "./provider/lithos.ts";
import { resolveOpenRouterUpstreamModel } from "./provider/openrouter.ts";
import { handleOpenRouterResponses } from "./provider/openrouter-handlers.ts";
import { openRouterPromptCacheRequestExtensions } from "./provider/openrouter-request-controls.ts";
import { isProviderEnabled, loadProviderSelectionCached } from "./provider/selection.ts";
import { createStreamFirstEventDeadline, createStreamSemanticDeadline, STREAM_FAILOVER_RESERVE_MS } from "./inference-deadline.ts";
import { ResponsesStreamError, type ResponsesStreamEvent, withSseKeepalive } from "./responses-stream.ts";
import {
  deriveRemovedProviderSessionId,
  isEligibleRemovedProviderModel,
  readRemovedProviderApiKey,
  removedProviderModelFromEvent,
} from "./paid-fallback/removed-provider.ts";
import {
  claimRemovedProviderEarlyRecoveryProbe,
  closeRemovedProviderCircuit,
  recordRemovedProviderEligibleFailure,
  releaseRemovedProviderCircuitProbe as releaseGlobalRemovedProviderProbe,
  type RemovedProviderCircuitProbe,
  renewRemovedProviderCircuitProbe,
  selectRemovedProviderCircuitRoute,
} from "./provider/removed-provider-circuit.ts";
import { createOwnedResponsesStream, isSyntheticResponsesFailureEvent } from "./responses-failover-stream.ts";
import { getString, isRecord } from "./utils.ts";
import type { ResponsesRequest } from "./types.ts";
import { loadDebugRoutingConfig } from "./debug-routing.ts";
import {
  type ResponseStreamTerminalType,
  type RoutedResponsesUpstream,
  type UpstreamProvider,
  type UsageContext,
  classifyPreHeaderFailure,
  classifyStreamFailure,
  countExplicitPromptCacheBreakpoints,
  extractUsageTokens,
  isTimeoutFailure,
  persistFailedRemovedProviderAttempt,
  persistRemovedProviderFields,
  promptCacheKeyPresent,
  promptCacheModeFor,
  recordErrorUsage,
  recordFirstSemanticCommitment,
  recordRemovedProviderFields,
  recordRequestUsage,
  recordResponsesEventTelemetry,
  recordResponsesFailureTelemetry,
  recordStreamTerminalType,
  recordTerminalUsage,
  runWithResponseTelemetry,
  selectRemovedProviderTelemetry,
  streamErrorResponse,
} from "./openai-telemetry.ts";
import { recordResponsesTerminal } from "./chat/stream-translation.ts";
import { logRedactedUpstreamError, toPreHeaderErrorResponse } from "./upstream-wire.ts";
import { isTemporaryFreeSurplusModel, WARNING_KEY_MAP, responseWarnings, validateKnownUnsupportedPromptCacheUse, withUosWarning } from "./request-policy.ts";
import {
  type FailedResponsesAttempt,
  type PreparedResponsesAttempt,
  type ResponsesRouteAttempt,
  type ResponsesRouteFailure,
  failureKindForResponsesAttemptTrigger,
  fetchAndPreparePrimaryResponses,
  fetchAndPrepareRemovedProviderResponses,
  finalizeAbandonedPrimaryAttempt,
  isEligibleResponsesAttemptStatus,
  markPrimarySemanticRecovery,
  responseFailureTerminalType,
} from "./responses-attempts.ts";
import { collectBufferedResponses } from "./responses-buffered.ts";
import { canAttemptPaidFallback, createMeteredTransportLifecycle } from "./paid-fallback/health.ts";
import {
  type ResponsesCircuitRoute,
  type ResponsesDeliveryState,
  type ResponsesHandlerState,
  type ResponsesRequestState,
  type ResponsesRoutingState,
  type ResponsesStep,
  buildResponsesUpstreamBodies,
  normalizeResponsesInput,
  readResponsesRequest,
  resolveResponsesModel,
  resolveResponsesReasoning,
  resolveResponsesStreamSettings,
  validateResponsesRequestFields,
} from "./responses-request.ts";
import { downstreamSignalFor, inferenceSignal } from "./openai.ts";

export const recordRemovedProviderCircuitTransition = (usageContext: UsageContext | undefined, transition: string): void => {
  if (transition !== "none") recordRemovedProviderFields(usageContext, { circuitTransition: transition });
};

const prepareResponsesRouting = async (req: Request, state: ResponsesRequestState, model: string): Promise<ResponsesRoutingState> => {
  const downstreamSignal = downstreamSignalFor(req, state.usageContext);
  const requestInferenceSignal = state.clientWantsStream ? downstreamSignal : inferenceSignal(req, state.usageContext);
  const preHeaderDeadline = createStreamFirstEventDeadline(requestInferenceSignal);
  const apiKey = isTemporaryFreeSurplusModel(model) ? null : readRemovedProviderApiKey();
  const paidFallbackAvailable = canAttemptPaidFallback(state.usageContext, await loadProviderSelectionCached());
  const debugRoutingScenario = (await loadDebugRoutingConfig()).scenario;
  const circuit = apiKey ? await selectRemovedProviderCircuitRoute() : null;
  if (circuit) {
    recordRemovedProviderCircuitTransition(state.usageContext, circuit.transition);
  }
  const sessionId = apiKey ? await deriveRemovedProviderSessionId(state.usageContext?.idempotencyPrincipal, state.rawRecord.client_metadata) : null;
  const route: "codex" | "removed_provider" = debugRoutingScenario === "removed_provider_first" && apiKey ? "removed_provider" : (circuit?.route ?? "codex");
  return {
    downstreamSignal,
    requestInferenceSignal,
    preHeaderDeadline,
    apiKey,
    paidFallbackAvailable,
    sessionId,
    route,
    probe: circuit ? circuit.probe : null,
    primaryFailureResponse: null,
    primaryFailureCorrelation: null,
    primaryResult: null,
    removedProviderAttempt: null,
    selectedModel: null,
    fallbackStartedAt: 0,
  };
};

const prepareResponsesRequest = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  rawBody: ResponsesRequest,
  usageContext: UsageContext | undefined,
  options?: ResponsesTailOptions
): Promise<ResponsesStep<ResponsesHandlerState>> => {
  const settings = resolveResponsesStreamSettings(rawRecord, rawBody);
  if (!settings.ok) return settings;
  const modelResolution = await resolveResponsesModel(rawRecord, usageContext, options);
  if (!modelResolution.ok) return modelResolution;
  const input = normalizeResponsesInput(rawBody.input);
  if (!input.ok) return input;
  const promptCacheAvailabilityError = validateKnownUnsupportedPromptCacheUse(
    modelResolution.value.modelRaw,
    modelResolution.value.modelMetadata,
    rawRecord,
    input.value,
    "input"
  );
  if (promptCacheAvailabilityError) return { ok: false, response: promptCacheAvailabilityError };
  const reasoning = await resolveResponsesReasoning(rawRecord, rawBody, modelResolution.value.modelMetadata, usageContext);
  if (!reasoning.ok) return reasoning;
  const upstreamBodies = buildResponsesUpstreamBodies(
    modelResolution.value.model,
    input.value,
    reasoning.value.instructions,
    reasoning.value.reasoning,
    rawRecord
  );
  await recordRequestUsage(usageContext, {
    model: modelResolution.value.modelRaw,
    route: "responses",
    stream: settings.value.clientWantsStream,
    reasoning: reasoning.value.reasoningLabel,
    promptCacheKeyPresent: promptCacheKeyPresent(rawRecord),
    promptCacheMode: promptCacheModeFor(rawRecord),
    explicitBreakpointCount: countExplicitPromptCacheBreakpoints(input.value),
  });
  const requestState: ResponsesRequestState = {
    usageContext,
    rawRecord,
    warnings: settings.value.warnings,
    clientWantsStream: settings.value.clientWantsStream,
    modelRaw: modelResolution.value.modelRaw,
    model: modelResolution.value.model,
    modelMetadata: modelResolution.value.modelMetadata,
    input: input.value,
    reasoningLabel: reasoning.value.reasoningLabel,
    codexBody: upstreamBodies.codexBody,
    removedProviderBody: upstreamBodies.removedProviderBody,
  };
  const routingState = await prepareResponsesRouting(req, requestState, modelResolution.value.model);
  return { ok: true, value: { ...requestState, ...routingState } };
};

const releaseResponsesProbeIfSet = (probe: RemovedProviderCircuitProbe | null): void => {
  if (probe) void releaseGlobalRemovedProviderProbe(probe).catch(() => {});
};

const releaseResponsesProbeAndReturn = (probe: RemovedProviderCircuitProbe | null, response: Response): Response => {
  releaseResponsesProbeIfSet(probe);
  return response;
};

const completeCodexPrimaryAttempt = (state: ResponsesHandlerState, attempt: ResponsesRouteAttempt): void => {
  state.primaryResult = attempt;
  const terminalType = attempt.prepared.prepared.terminal?.type;
  if (terminalType === "response.completed" || terminalType === "response.incomplete") {
    markPrimarySemanticRecovery(attempt.routed, state.probe, state.usageContext, terminalType);
  }
};

const recordCodexPrimaryFailureTelemetry = (state: ResponsesHandlerState, failed: FailedResponsesAttempt, terminalType: ResponseStreamTerminalType): void => {
  const telemetry = state.usageContext?.responseTelemetry;
  if (telemetry) {
    state.primaryFailureCorrelation = {
      provider: telemetry.provider,
      accountSlot: telemetry.accountSlot,
      accountCohortId: telemetry.accountCohortId,
      activeGeneration: telemetry.activeGeneration,
      activeTransitionReason: telemetry.activeTransitionReason,
      providerRequestId: telemetry.providerRequestId,
    };
  }
  recordStreamTerminalType(state.usageContext, terminalType);
  const failureKind = failureKindForResponsesAttemptTrigger(failed.trigger);
  if (failureKind && state.usageContext?.responseTelemetry) {
    state.usageContext.responseTelemetry.failureKind = failureKind;
    if (failureKind === "empty_upstream_completion") {
      state.usageContext.responseTelemetry.semanticOutputObserved = false;
    }
  }
};

const settleCodexPrimaryFailure = async (state: ResponsesHandlerState, failure: ResponsesRouteFailure): Promise<Response | null> => {
  const { routed, failed, lifecycle } = failure;
  state.primaryFailureResponse = failed.response;
  const terminalType = responseFailureTerminalType(failed.trigger, failed.signal, state.downstreamSignal);
  recordCodexPrimaryFailureTelemetry(state, failed, terminalType);
  if (failed.trigger === "empty_upstream_completion") {
    const terminalUsage = failed.terminal && isRecord(failed.terminal.value.response) ? extractUsageTokens(failed.terminal.value.response.usage) : null;
    recordTerminalUsage(state.usageContext, terminalUsage, false);
    await finalizeAbandonedPrimaryAttempt(routed, lifecycle, { failureTrigger: failed.trigger });
    return releaseResponsesProbeAndReturn(state.probe, failed.response);
  }
  if (routed.allowRemovedProviderRecovery === false) {
    return releaseResponsesProbeAndReturn(state.probe, failed.response);
  }
  if (routed.gatewayResponse && !isEligibleResponsesAttemptStatus(failed.response)) {
    return releaseResponsesProbeAndReturn(state.probe, failed.response);
  }
  if (
    !isEligibleResponsesAttemptStatus(failed.response) &&
    (failed.trigger === "http_4xx" || failed.trigger === "http_error" || failed.trigger === "read_error")
  ) {
    releaseResponsesProbeIfSet(state.probe);
    lifecycle.terminal("response.failed");
    return failed.response;
  }
  if (!routed.gatewayResponse) {
    await finalizeAbandonedPrimaryAttempt(routed, lifecycle, {
      cancelled: terminalType === "cancelled",
      failureTrigger: failed.trigger,
    });
  }
  if (terminalType === "cancelled") {
    releaseResponsesProbeIfSet(state.probe);
    await recordErrorUsage(state.usageContext);
    return toPreHeaderErrorResponse(state.downstreamSignal.reason, terminalType, routed.provider);
  }
  if (!state.apiKey) return failed.response;
  recordRemovedProviderCircuitTransition(state.usageContext, await recordRemovedProviderEligibleFailure(state.probe));
  recordRemovedProviderFields(state.usageContext, { triggerClass: failed.trigger });
  state.route = "removed_provider";
  return null;
};

const handleCodexPrimaryThrow = async (state: ResponsesHandlerState, error: unknown): Promise<Response> => {
  releaseResponsesProbeIfSet(state.probe);
  const terminalType = classifyPreHeaderFailure(error, state.preHeaderDeadline.signal, state.downstreamSignal);
  recordStreamTerminalType(state.usageContext, terminalType);
  if (terminalType !== "cancelled") {
    logRedactedUpstreamError("[ai.ubq.fi] Upstream fetch failed:", error);
  }
  await recordErrorUsage(state.usageContext);
  return toPreHeaderErrorResponse(error, terminalType, state.usageContext?.responseTelemetry?.provider);
};

const runCodexPrimaryAttempt = async (state: ResponsesHandlerState, options?: ResponsesTailOptions): Promise<Response | null> => {
  try {
    const remainingMs = state.preHeaderDeadline.remainingMs();
    const failoverReserveMs = Math.min(STREAM_FAILOVER_RESERVE_MS, remainingMs / 2);
    const primaryBudgetMs = state.apiKey || state.paidFallbackAvailable ? Math.max(0, remainingMs - failoverReserveMs) : remainingMs;
    const result = await fetchAndPreparePrimaryResponses(state.codexBody, {
      model: state.model,
      reasoning: state.reasoningLabel,
      clientWantsStream: state.clientWantsStream,
      usageContext: state.usageContext,
      clientVersion: state.modelMetadata.snapshot?.client_version,
      requestSignal: state.requestInferenceSignal,
      downstreamSignal: state.downstreamSignal,
      warnings: state.warnings,
      attemptDeadline: createStreamSemanticDeadline(state.preHeaderDeadline.signal, Math.ceil(primaryBudgetMs)),
      fallbackSignal: state.paidFallbackAvailable ? state.preHeaderDeadline.signal : undefined,
      createFallbackDeadline: state.paidFallbackAvailable
        ? () => createStreamSemanticDeadline(state.preHeaderDeadline.signal, Math.ceil(state.preHeaderDeadline.remainingMs()))
        : undefined,
      rejectPresemanticFailureTerminal: state.apiKey !== null,
      releaseOnProgress: state.clientWantsStream,
      allowedPaidProviders: options?.allowedPaidProviders ?? null,
      deepSeekWaterfallPaidHop: options?.deepSeekWaterfallPaidHop ?? null,
    });
    if (result.kind === "ready") {
      completeCodexPrimaryAttempt(state, result.value);
      return null;
    }
    return await settleCodexPrimaryFailure(state, result.value);
  } catch (error) {
    return await handleCodexPrimaryThrow(state, error);
  }
};

const resolveResponsesRecoveryRoute = (recoveryRoute: ResponsesCircuitRoute, fallbackResponse: Response): ResponsesStep<RemovedProviderCircuitProbe | null> => {
  if (recoveryRoute.route !== "codex") return { ok: false, response: fallbackResponse };
  return { ok: true, value: recoveryRoute.probe };
};

const resolveResponsesRecoveryProbe = async (
  claimedProbe: RemovedProviderCircuitProbe | null,
  fallbackResponse: Response
): Promise<ResponsesStep<RemovedProviderCircuitProbe | null>> => {
  if (claimedProbe) return { ok: true, value: claimedProbe };
  const recoveryRoute = await selectRemovedProviderCircuitRoute();
  return resolveResponsesRecoveryRoute(recoveryRoute, fallbackResponse);
};

const acquireResponsesRecoveryProbe = async (fallbackResponse: Response): Promise<ResponsesStep<RemovedProviderCircuitProbe | null>> => {
  const claimedProbe = await claimRemovedProviderEarlyRecoveryProbe();
  return await resolveResponsesRecoveryProbe(claimedProbe, fallbackResponse);
};

const releaseResponsesRecoveryProbe = async (state: ResponsesHandlerState, recoveryProbe: RemovedProviderCircuitProbe | null): Promise<void> => {
  const transition = recoveryProbe ? await releaseGlobalRemovedProviderProbe(recoveryProbe) : "none";
  recordRemovedProviderCircuitTransition(state.usageContext, transition);
};

const settleResponsesRecoveryFailure = async (
  state: ResponsesHandlerState,
  failure: ResponsesRouteFailure,
  recoveryProbe: RemovedProviderCircuitProbe | null,
  fallbackResponse: Response
): Promise<Response> => {
  const { routed, failed, lifecycle } = failure;
  const terminalType = responseFailureTerminalType(failed.trigger, failed.signal, state.downstreamSignal);
  await finalizeAbandonedPrimaryAttempt(routed, lifecycle, {
    cancelled: terminalType === "cancelled",
    failureTrigger: failed.trigger,
  });
  if (failed.trigger === "empty_upstream_completion") {
    if (state.usageContext?.responseTelemetry) {
      state.usageContext.responseTelemetry.failureKind = "empty_upstream_completion";
      state.usageContext.responseTelemetry.semanticOutputObserved = false;
    }
    const terminalUsage = failed.terminal && isRecord(failed.terminal.value.response) ? extractUsageTokens(failed.terminal.value.response.usage) : null;
    recordTerminalUsage(state.usageContext, terminalUsage, false);
    recordStreamTerminalType(state.usageContext, "response.failed");
    await releaseResponsesRecoveryProbe(state, recoveryProbe);
    return failed.response;
  }
  if (terminalType === "cancelled") {
    await releaseResponsesRecoveryProbe(state, recoveryProbe);
    recordStreamTerminalType(state.usageContext, terminalType);
    await recordErrorUsage(state.usageContext);
    return toPreHeaderErrorResponse(state.downstreamSignal.reason, terminalType, routed.provider);
  }
  if (failed.trigger === "semantic_timeout") {
    await releaseResponsesRecoveryProbe(state, recoveryProbe);
    return failed.response;
  }
  if (isEligibleResponsesAttemptStatus(failed.response)) {
    recordRemovedProviderCircuitTransition(state.usageContext, await recordRemovedProviderEligibleFailure(recoveryProbe));
  } else {
    await releaseResponsesRecoveryProbe(state, recoveryProbe);
  }
  selectRemovedProviderTelemetry(state.usageContext);
  return fallbackResponse;
};

const runResponsesRecoveryAttempt = async (
  state: ResponsesHandlerState,
  fallbackAttempt: FailedResponsesAttempt,
  recoveryProbe: RemovedProviderCircuitProbe | null,
  options?: ResponsesTailOptions
): Promise<Response | null> => {
  let recovery: Awaited<ReturnType<typeof fetchAndPreparePrimaryResponses>>;
  try {
    recovery = await fetchAndPreparePrimaryResponses(state.codexBody, {
      model: state.model,
      reasoning: state.reasoningLabel,
      clientWantsStream: state.clientWantsStream,
      usageContext: state.usageContext,
      clientVersion: state.modelMetadata.snapshot?.client_version,
      requestSignal: state.requestInferenceSignal,
      downstreamSignal: state.downstreamSignal,
      warnings: state.warnings,
      attemptDeadline: createStreamSemanticDeadline(state.preHeaderDeadline.signal, Math.ceil(state.preHeaderDeadline.remainingMs())),
      rejectPresemanticFailureTerminal: true,
      releaseOnProgress: state.clientWantsStream,
      allowedPaidProviders: options?.allowedPaidProviders ?? null,
      deepSeekWaterfallPaidHop: options?.deepSeekWaterfallPaidHop ?? null,
    });
  } catch (error) {
    await releaseResponsesRecoveryProbe(state, recoveryProbe);
    if (state.requestInferenceSignal.aborted) throw state.requestInferenceSignal.reason ?? error;
    selectRemovedProviderTelemetry(state.usageContext);
    return fallbackAttempt.response;
  }
  if (recovery.kind === "failed") {
    return await settleResponsesRecoveryFailure(state, recovery.value, recoveryProbe, fallbackAttempt.response);
  }
  completeCodexPrimaryAttempt(state, recovery.value);
  return null;
};

const settleRemovedProviderFailure = async (
  state: ResponsesHandlerState,
  attempt: FailedResponsesAttempt,
  options?: ResponsesTailOptions
): Promise<Response | null> => {
  void persistFailedRemovedProviderAttempt(state.usageContext, state.fallbackStartedAt, attempt.trigger);
  if (attempt.trigger === "empty_upstream_completion") {
    if (state.usageContext?.responseTelemetry) {
      state.usageContext.responseTelemetry.failureKind = "empty_upstream_completion";
      state.usageContext.responseTelemetry.semanticOutputObserved = false;
    }
    const terminalUsage = attempt.terminal && isRecord(attempt.terminal.value.response) ? extractUsageTokens(attempt.terminal.value.response.usage) : null;
    recordTerminalUsage(state.usageContext, terminalUsage, false);
    recordStreamTerminalType(state.usageContext, "response.failed");
    return attempt.response;
  }
  const primaryFailureResponse = state.primaryFailureResponse;
  if (primaryFailureResponse || attempt.trigger === "terminal_failure") {
    if (primaryFailureResponse && state.usageContext?.responseTelemetry) {
      const telemetry = state.usageContext.responseTelemetry;
      telemetry.provider = state.primaryFailureCorrelation?.provider ?? primaryFailureResponse.headers.get("x-uos-upstream") ?? "chatgpt_codex";
      telemetry.accountSlot = state.primaryFailureCorrelation?.accountSlot ?? null;
      telemetry.accountCohortId = state.primaryFailureCorrelation?.accountCohortId ?? null;
      telemetry.activeGeneration = state.primaryFailureCorrelation?.activeGeneration ?? null;
      telemetry.activeTransitionReason = state.primaryFailureCorrelation?.activeTransitionReason ?? null;
      telemetry.providerRequestId = state.primaryFailureCorrelation?.providerRequestId ?? null;
    } else {
      selectRemovedProviderTelemetry(state.usageContext);
    }
    return primaryFailureResponse ?? attempt.response;
  }
  const recovery = await acquireResponsesRecoveryProbe(attempt.response);
  if (!recovery.ok) return recovery.response;
  state.probe = recovery.value;
  return await runResponsesRecoveryAttempt(state, attempt, recovery.value, options);
};

const runRemovedProviderAttempt = async (state: ResponsesHandlerState, apiKey: string, options?: ResponsesTailOptions): Promise<Response | null> => {
  state.fallbackStartedAt = performance.now();
  const removedProvider = await fetchAndPrepareRemovedProviderResponses(state.removedProviderBody, {
    usageContext: state.usageContext,
    requestSignal: state.requestInferenceSignal,
    sessionId: state.sessionId,
    apiKey,
    attemptDeadline: createStreamSemanticDeadline(state.preHeaderDeadline.signal, Math.ceil(state.preHeaderDeadline.remainingMs())),
  });
  if (removedProvider.kind !== "ready") {
    return await settleRemovedProviderFailure(state, removedProvider.attempt, options);
  }
  state.removedProviderAttempt = removedProvider.attempt;
  state.selectedModel = removedProvider.attempt.selectedModel;
  recordRemovedProviderFields(state.usageContext, {
    selectedModel: state.selectedModel,
    taskType: removedProvider.attempt.taskType,
    semanticCommitment:
      removedProvider.attempt.prepared.semanticKind ?? (removedProvider.attempt.prepared.terminal?.type === "response.completed" ? "terminal_completed" : null),
  });
  return null;
};

/**
 * Request-scoped paid-tier pin for the DeepSeek waterfall's paid hops. Null or
 * absent keeps the routing layer's fixed Surplus -> Metered cost order for
 * every other caller.
 */
type ResponsesTailOptions = Readonly<{
  allowedPaidProviders?: readonly ("metered" | "surplus")[] | null;
  deepSeekWaterfallPaidHop?: "surplus" | "openlux" | null;
}>;

const runResponsesFailover = async (state: ResponsesHandlerState, options?: ResponsesTailOptions): Promise<Response | null> => {
  try {
    if (state.route === "codex") {
      const codexResponse = await runCodexPrimaryAttempt(state, options);
      if (codexResponse) return codexResponse;
    }

    if (state.route === "removed_provider" && state.apiKey) {
      const removedProviderResponse = await runRemovedProviderAttempt(state, state.apiKey, options);
      if (removedProviderResponse) return removedProviderResponse;
    }
    return null;
  } finally {
    state.preHeaderDeadline.clear();
  }
};

const removedProviderProbeTransitionForTerminal = (probe: RemovedProviderCircuitProbe | null, terminalType: ResponseStreamTerminalType): Promise<"none"> => {
  if (terminalType !== "cancelled") return recordRemovedProviderEligibleFailure(probe);
  if (probe) return releaseGlobalRemovedProviderProbe(probe);
  return Promise.resolve("none" as const);
};

const reconcileCommittedFailure = (delivery: ResponsesDeliveryState, terminalType: ResponseStreamTerminalType): void => {
  delivery.clearProbeRenewal();
  // A terminal buffered during preflight already describes the provider.
  // A later client-body cancellation is delivery-only and cannot change that
  // provider outcome, health result, or paid settlement.
  if (delivery.providerTerminalValidated) return;
  if (delivery.usageContext?.responseTelemetry?.streamTerminalType === null) {
    recordStreamTerminalType(delivery.usageContext, terminalType);
  }
  const routed = delivery.routed;
  if (routed) {
    void finalizeAbandonedPrimaryAttempt(routed, delivery.lifecycle, { cancelled: terminalType === "cancelled" });
  }
  if (delivery.probe && (routed?.provider === "metered" || routed?.provider === "surplus")) {
    void releaseGlobalRemovedProviderProbe(delivery.probe)
      .then((value) => {
        recordRemovedProviderCircuitTransition(delivery.usageContext, value);
      })
      .catch(() => {});
  } else if (routed?.provider === "chatgpt_codex") {
    void removedProviderProbeTransitionForTerminal(delivery.probe, terminalType)
      .then((value) => {
        recordRemovedProviderCircuitTransition(delivery.usageContext, value);
      })
      .catch(() => {});
  }
  if (delivery.removedProviderAttempt && delivery.usageContext?.responseTelemetry?.removedProviderTerminalStatus !== "response.failed") {
    recordRemovedProviderFields(delivery.usageContext, {
      latencyMs: Math.max(0, Math.round(performance.now() - delivery.fallbackStartedAt)),
      terminalStatus: terminalType,
    });
    void persistRemovedProviderFields(delivery.usageContext);
  }
  void recordErrorUsage(delivery.usageContext);
};

const validateRemovedProviderStreamEvent = (delivery: ResponsesDeliveryState, event: ResponsesStreamEvent): void => {
  if (!delivery.removedProviderAttempt || !delivery.selectedModel) return;
  const candidate = removedProviderModelFromEvent(event.value);
  if (!candidate) return;
  if (candidate !== delivery.selectedModel || !isEligibleRemovedProviderModel(candidate)) {
    throw new ResponsesStreamError("RemovedProvider changed the selected model after stream release.", {
      kind: "malformed_event",
    });
  }
};

const codexResponseTerminalTransition = (response: Response, eventType: string): Promise<void> => {
  if (eventType === "response.completed") return markCodexResponseCompleted(response);
  if (eventType === "response.failed" || eventType === "error") return markCodexResponseUpstreamError(response);
  return releaseCodexResponseProbe(response);
};

const codexTerminalCircuitTransition = (provider: UpstreamProvider, eventType: string, probe: RemovedProviderCircuitProbe | null): Promise<"none"> => {
  if (provider !== "chatgpt_codex") return releaseGlobalRemovedProviderProbe(probe);
  if (eventType === "response.completed" || eventType === "response.incomplete") return closeRemovedProviderCircuit(probe);
  if (eventType === "response.failed" || eventType === "error") return recordRemovedProviderEligibleFailure(probe);
  return releaseGlobalRemovedProviderProbe(probe);
};

const applyRemovedProviderTerminalTransition = (delivery: ResponsesDeliveryState, event: ResponsesStreamEvent, routed: RoutedResponsesUpstream): void => {
  if (delivery.probe) {
    void codexTerminalCircuitTransition(routed.provider, event.type, delivery.probe)
      .then((value) => {
        recordRemovedProviderCircuitTransition(delivery.usageContext, value);
      })
      .catch(() => {});
    return;
  }
  if (routed.provider === "chatgpt_codex" && (event.type === "response.failed" || event.type === "error")) {
    void recordRemovedProviderEligibleFailure(null)
      .then((value) => {
        recordRemovedProviderCircuitTransition(delivery.usageContext, value);
      })
      .catch(() => {});
  }
};

const applyRoutedStreamTerminal = (delivery: ResponsesDeliveryState, routed: RoutedResponsesUpstream, event: ResponsesStreamEvent): void => {
  const terminalUsage = isRecord(event.value.response) ? extractUsageTokens(event.value.response.usage) : null;
  delivery.lifecycle.terminal(event.type, terminalUsage);
  if (routed.provider === "chatgpt_codex") {
    void codexResponseTerminalTransition(routed.response, event.type).catch(() => {});
  }
  applyRemovedProviderTerminalTransition(delivery, event, routed);
};

const onResponsesTerminal = (delivery: ResponsesDeliveryState, event: ResponsesStreamEvent): void => {
  if (!event.terminal) return;
  delivery.clearProbeRenewal();
  const syntheticFailure = isSyntheticResponsesFailureEvent(event);
  if (!syntheticFailure && delivery.providerTerminalValidated) {
    // Buffered collection replays a terminal already settled during
    // preflight, after it has recorded the first SSE event. Complete timing
    // telemetry without repeating provider settlement or usage recording.
    recordStreamTerminalType(delivery.usageContext, event.type as ResponseStreamTerminalType);
    return;
  }
  if (!syntheticFailure) delivery.providerTerminalValidated = true;
  const routed = delivery.routed;
  if (routed && !syntheticFailure) {
    applyRoutedStreamTerminal(delivery, routed, event);
  }
  // A synthetic failure is the client-visible terminal owner after a
  // committed stream breaks. For an abandoned Codex/Metered attempt, keep the
  // underlying EOF/read classification in telemetry so paid-fallback
  // reconciliation retains its diagnostic cause. RemovedProvider owns its
  // synthetic terminal because no later provider can take over after the
  // failover notice has been released.
  if (!syntheticFailure || delivery.removedProviderAttempt) {
    recordResponsesTerminal(event, delivery.usageContext);
  }
  if (delivery.removedProviderAttempt) {
    recordRemovedProviderFields(delivery.usageContext, {
      latencyMs: Math.max(0, Math.round(performance.now() - delivery.fallbackStartedAt)),
      terminalStatus: event.type,
    });
    void persistRemovedProviderFields(delivery.usageContext);
  }
};

const buildResponsesClientWarnings = (state: ResponsesHandlerState, ready: PreparedResponsesAttempt): string[] => {
  const forwardedRemovedProviderControls = new Set([
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "prompt_cache_options",
    "prompt_cache_retention",
    "safety_identifier",
    "service_tier",
    "temperature",
    "top_p",
    "truncation",
    "user",
  ]);
  const primaryFailureResponse = state.primaryFailureResponse;
  return [...state.warnings, ...(primaryFailureResponse ? responseWarnings(primaryFailureResponse) : []), ...responseWarnings(ready.response)].filter(
    (warning) => {
      if (!state.removedProviderAttempt) return true;
      if (warning === "prompt_cache_breakpoint_ignored" && countExplicitPromptCacheBreakpoints(state.input) > 0) {
        return false;
      }
      return ![...forwardedRemovedProviderControls].some(
        (key) => Object.prototype.hasOwnProperty.call(state.rawRecord, key) && warning === (WARNING_KEY_MAP.get(key) ?? `${key}_ignored`)
      );
    }
  );
};

const buildResponsesDelivery = (state: ResponsesHandlerState): ResponsesStep<ResponsesDeliveryState> => {
  const ready = state.removedProviderAttempt ?? state.primaryResult?.prepared;
  if (!ready) {
    return {
      ok: false,
      response:
        state.primaryFailureResponse ??
        streamErrorResponse(502, "No upstream provider produced a response.", "upstream_error", "chatgpt_codex", state.warnings),
    };
  }
  // A failed pre-commit attempt is diagnostic evidence for routing, not the
  // terminal result of a later provider. Reset only final-failure telemetry
  // when failover produced a ready response; the selected attempt will record
  // its own terminal or stream failure below.
  if (state.usageContext?.responseTelemetry) {
    state.usageContext.responseTelemetry.failureKind = null;
    state.usageContext.responseTelemetry.syntheticTerminalType = null;
    state.usageContext.responseTelemetry.streamTerminalType = null;
  }
  const lifecycle = state.primaryResult?.lifecycle ?? createMeteredTransportLifecycle(null);
  const routed = state.primaryResult?.routed ?? null;
  const clientWarnings = buildResponsesClientWarnings(state, ready);
  const structuredTextOutput =
    isRecord(state.rawRecord.text) &&
    isRecord(state.rawRecord.text.format) &&
    (state.rawRecord.text.format.type === "json_schema" || state.rawRecord.text.format.type === "json_object");
  const warningModel = state.removedProviderAttempt && !structuredTextOutput ? state.selectedModel : null;
  const probe = state.probe;
  if (probe && ready.prepared.semantic) {
    void renewRemovedProviderCircuitProbe(probe).catch(() => {});
  }
  const probeRenewal = probe && ready.prepared.semantic ? setInterval(() => void renewRemovedProviderCircuitProbe(probe).catch(() => {}), 60_000) : null;
  const clearProbeRenewal = (): void => {
    if (probeRenewal !== null) clearInterval(probeRenewal);
  };
  return {
    ok: true,
    value: {
      usageContext: state.usageContext,
      ready,
      lifecycle,
      routed,
      clientWantsStream: state.clientWantsStream,
      downstreamSignal: state.downstreamSignal,
      clientWarnings,
      warningModel,
      selectedModel: state.selectedModel,
      probe,
      removedProviderAttempt: state.removedProviderAttempt,
      fallbackStartedAt: state.fallbackStartedAt,
      providerTerminalValidated: false,
      clearProbeRenewal,
    },
  };
};

const deliverBufferedResponses = async (delivery: ResponsesDeliveryState): Promise<Response> => {
  const response = await collectBufferedResponses(delivery.ready, {
    warningModel: delivery.warningModel,
    usageContext: delivery.usageContext,
    onTerminal: (event) => {
      onResponsesTerminal(delivery, event);
    },
    validateEvent: (event) => {
      validateRemovedProviderStreamEvent(delivery, event);
    },
    onFailure: (error, details) => {
      const terminalType = classifyStreamFailure(error, delivery.ready.signal, delivery.downstreamSignal);
      if (terminalType !== "cancelled") recordResponsesFailureTelemetry(delivery.usageContext, error, details);
      else if (delivery.usageContext?.responseTelemetry) {
        delivery.usageContext.responseTelemetry.responseCreatedObserved =
          details?.responseCreatedObserved ?? delivery.usageContext.responseTelemetry.responseCreatedObserved;
      }
      reconcileCommittedFailure(delivery, terminalType);
      if (terminalType === "cancelled" || terminalType === "deadline") {
        return toPreHeaderErrorResponse(error, terminalType, delivery.ready.provider);
      }
    },
  });
  return withUosWarning(response, delivery.clientWarnings);
};

const deliverStreamingResponses = (delivery: ResponsesDeliveryState): Response => {
  const body = createOwnedResponsesStream({
    initial: delivery.ready.prepared.buffered,
    iterator: delivery.ready.prepared.iterator,
    responseId: delivery.ready.responseId,
    ...(delivery.warningModel ? { warning: { model: delivery.warningModel } } : {}),
    signal: delivery.ready.signal,
    downstreamSignal: delivery.downstreamSignal,
    abortUpstream: delivery.ready.abort,
    onEvent: (event) => {
      recordResponsesEventTelemetry(delivery.usageContext, event);
      onResponsesTerminal(delivery, event);
    },
    validateEvent: (event) => {
      validateRemovedProviderStreamEvent(delivery, event);
    },
    onFailure: (error, details) => {
      const terminalType = classifyStreamFailure(error, delivery.ready.signal, delivery.downstreamSignal);
      if (terminalType !== "cancelled") recordResponsesFailureTelemetry(delivery.usageContext, error, details);
      else if (delivery.usageContext?.responseTelemetry) {
        delivery.usageContext.responseTelemetry.responseCreatedObserved = details.responseCreatedObserved;
      }
      if (details.failureKind === "empty_upstream_completion") {
        const terminalUsage =
          details.upstreamTerminal && isRecord(details.upstreamTerminal.value.response)
            ? extractUsageTokens(details.upstreamTerminal.value.response.usage)
            : null;
        recordTerminalUsage(delivery.usageContext, terminalUsage, false);
      }
      reconcileCommittedFailure(delivery, terminalType);
    },
    onCancel: () => {
      reconcileCommittedFailure(delivery, "cancelled");
    },
  });
  const headers = new Headers(delivery.ready.response.headers);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.set("Content-Type", "text/event-stream");
  headers.set("x-uos-upstream", delivery.ready.provider);
  return withUosWarning(new Response(withSseKeepalive(body), { status: 200, headers }), delivery.clientWarnings);
};

const deliverPreparedResponses = async (delivery: ResponsesDeliveryState): Promise<Response> => {
  // Preflight has established either semantic ownership or a valid terminal,
  // so this is the content-free release boundary. Parser callbacks record the
  // earlier first upstream SSE event independently.
  recordFirstSemanticCommitment(delivery.usageContext);

  // Preflight can already contain a terminal. Record its provider outcome
  // before returning a body that a client may cancel without consuming.
  if (delivery.ready.prepared.terminal) onResponsesTerminal(delivery, delivery.ready.prepared.terminal);

  if (!delivery.clientWantsStream) return await deliverBufferedResponses(delivery);
  return deliverStreamingResponses(delivery);
};

const handleResponsesInternal = async (req: Request, usageContext?: UsageContext, parsedBody?: unknown): Promise<Response> => {
  const request = await readResponsesRequest(req, parsedBody);
  if (!request.ok) return request.response;
  const { rawRecord, rawBody } = request.value;
  const invalidField = validateResponsesRequestFields(rawRecord, rawBody, await openRouterPromptCacheRequestExtensions(rawRecord));
  if (invalidField) return invalidField;
  // DeepSeek official models are dispatched from the Responses adapter before
  // the Codex catalog lookup, exactly as the Chat Completions route is
  // dispatched before Codex model validation. Only an explicit DeepSeek id
  // takes this branch; a switched-off DeepSeek provider leaves its ids to the
  // ordinary availability check.
  const requestedModel = getString(rawRecord.model)?.trim();
  // The synthetic waterfall id is owned by the gateway itself: it walks the
  // measured DeepSeek provider order on the client's behalf, so it dispatches
  // before the provider-specific ids and their availability checks.
  if (requestedModel && isDeepSeekWaterfallModel(requestedModel)) {
    return await handleDeepSeekWaterfallResponses(req, rawRecord, rawBody, usageContext);
  }
  if (requestedModel && deepSeekUpstreamModelFor(requestedModel) && isProviderEnabled("deepseek", await loadProviderSelectionCached())) {
    return await handleDeepSeekResponses(req, rawRecord, requestedModel, usageContext);
  }
  // LithosAI has no Responses endpoint of its own, so this route is served by
  // the shared translation under the LithosAI profile rather than by a
  // provider-side endpoint. Only an explicit LithosAI id takes this branch.
  if (requestedModel && lithosUpstreamModelFor(requestedModel) && isProviderEnabled("lithos", await loadProviderSelectionCached())) {
    return await handleLithosResponses(req, rawRecord, requestedModel, usageContext);
  }
  // Cerebras ids are owned by the Cerebras route on both wires, so they are
  // dispatched before the Codex catalog lookup exactly as the Chat Completions
  // route dispatches them; a switched-off Cerebras provider leaves its ids to
  // the ordinary availability check.
  if (requestedModel && cerebrasUpstreamModelFor(requestedModel) && isProviderEnabled("cerebras", await loadProviderSelectionCached())) {
    return await handleCerebrasResponses(req, rawRecord, requestedModel, usageContext);
  }
  // OpenRouter serves the Responses wire natively; only an id in its served
  // catalogue takes this branch, and a switched-off provider leaves its ids to
  // the ordinary availability check.
  if (requestedModel && isProviderEnabled("openrouter", await loadProviderSelectionCached()) && (await resolveOpenRouterUpstreamModel(requestedModel))) {
    return await handleOpenRouterResponses(req, rawRecord, requestedModel, usageContext);
  }
  return await runOrdinaryResponsesTail(req, rawRecord, rawBody, usageContext);
};

/**
 * The ordinary routing tail behind the specialty-provider branches: prepare the
 * request, run the primary/paid failover path and deliver the result. Exported
 * so the DeepSeek waterfall's paid hops re-enter exactly this pipeline
 * (admission, reservation and ledger settlement included) instead of
 * reimplementing it, each pinned to its own paid tier through `options`.
 */
export const runOrdinaryResponsesTail = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  rawBody: ResponsesRequest,
  usageContext?: UsageContext,
  options?: ResponsesTailOptions
): Promise<Response> => {
  const prepared = await prepareResponsesRequest(req, rawRecord, rawBody, usageContext, options);
  if (!prepared.ok) return prepared.response;
  const failoverResponse = await runResponsesFailover(prepared.value, options);
  if (failoverResponse) return failoverResponse;
  const delivery = buildResponsesDelivery(prepared.value);
  if (!delivery.ok) return delivery.response;
  return await deliverPreparedResponses(delivery.value);
};

const responsesHandlerTerminalType = (error: unknown, downstreamSignal: AbortSignal): "deadline" | "cancelled" | null => {
  if (isTimeoutFailure(error, downstreamSignal.reason)) return "deadline";
  if (downstreamSignal.aborted) return "cancelled";
  return null;
};

export const runResponsesHandler = async (req: Request, usageContext?: UsageContext, parsedBody?: unknown): Promise<Response> =>
  await runWithResponseTelemetry(usageContext, async (context) => {
    try {
      return await handleResponsesInternal(req, context, parsedBody);
    } catch (error) {
      const downstreamSignal = downstreamSignalFor(req, context);
      const terminalType = responsesHandlerTerminalType(error, downstreamSignal);
      if (terminalType === null) throw error;
      recordStreamTerminalType(context, terminalType);
      await recordErrorUsage(context);
      return toPreHeaderErrorResponse(error, terminalType, context.responseTelemetry?.provider ?? "chatgpt_codex");
    }
  });

export const handleResponses = async (req: Request, usageContext?: UsageContext): Promise<Response> => await runResponsesHandler(req, usageContext);
