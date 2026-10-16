// Response usage, provider and stream telemetry, extracted from src/openai.ts.

export type MeteredTransportLifecycle = Readonly<{
  terminal: (eventType: string, usage?: UsageTokens | null) => void;
  ambiguous: () => void;
  cancelled: () => void;
}>;

export type PaidProviderHealthEvent = "auth_invalid" | "quota_exhausted" | "upstream_error" | "reachable";

export type PaidProviderHealthClassification = Readonly<{ event: PaidProviderHealthEvent; status: number | null }>;

import { CODEX_AUTH_REAUTH_MESSAGE, CODEX_AUTH_REAUTH_WARNING, CodexError } from "./codex/index.ts";
import { type ApiKeyUsageReservation } from "./api-key-policy.ts";
import { openaiError } from "./http.ts";
import { ResponsesStreamError, type ResponsesStreamEvent, type ResponsesStreamFailureKind } from "./responses-stream.ts";
import { recordRemovedProviderTelemetry } from "./provider/removed-provider-telemetry.ts";
import { isSyntheticResponsesFailureEvent, type OwnedResponsesStreamFailureDetails } from "./responses-failover-stream.ts";
import { type PaidFallbackReservation, type SurplusBillingPricing } from "./paid-fallback/index.ts";
import { isRecord } from "./utils.ts";
import type { ResponseInputItem } from "./types.ts";
import type { SentinelUpstreamRecorder } from "./sentinel/upstream-capture.ts";

export type UsageContext = Readonly<{
  keyId: string | null;
  kernelRepo: { owner: string; repo: string } | null;
  kernelOrg: { owner: string } | null;
  paidFallbackEnabled?: boolean;
  idempotencyPrincipal?: string | null;
  requestId?: string;
  /** Internal paid-attempt ledger identity; client correlation and request quota retain requestId. */
  paidFallbackRequestId?: string;
  startedAtMs?: number;
  startedAtMonotonicMs?: number;
  downstreamSignal?: AbortSignal;
  responseTelemetry?: ResponseTelemetryState;
  /** Commits an admitted API-key reservation exactly once before transport. */
  beforeProviderDispatch?: ApiKeyUsageReservation["beforeProviderDispatch"];
  /** Request-owned passive upstream recorder for accepted inference requests. */
  sentinelUpstreamRecorder?: SentinelUpstreamRecorder;
  /** Test seam for proving one terminal usage observation per response. */
  onTerminalUsage?: (usage: UsageTokens | null, completed: boolean) => void;
}>;

export type UpstreamProvider = "cerebras" | "chatgpt_codex" | "claude_code" | "deepseek" | "lithos" | "openrouter" | "removed_provider" | "metered" | "surplus";
export const supportsReasoningProgressRelease = (provider: UpstreamProvider): boolean =>
  provider === "chatgpt_codex" || provider === "surplus" || provider === "metered";
export type InferenceFallbackReason = "primary_quota_blocked" | "primary_subscriptions_unavailable" | "dynamic_paid_model";
/**
 * Exact fallback reason for one failed hop of the `ubiquity/deepseek-v4.1-flash`
 * waterfall, so production traffic keeps the same per-hop evidence the
 * benchmark recorded (provider plus failure class or status). The paid
 * admission reasons stay their own union; only the telemetry record carries
 * either kind.
 */
export type DeepSeekWaterfallFallbackReason =
  `deepseek_waterfall:${"lithos" | "deepseek" | "openrouter" | "surplus" | "openlux"}:${number | "transport_failure" | "stream_failure"}`;
export type RecordedFallbackReason = InferenceFallbackReason | DeepSeekWaterfallFallbackReason;
export type UsageTelemetryStatus = "missing" | "partial" | "reported" | "invalid";
export type PromptCacheMode = "implicit" | "explicit" | "legacy_retention" | "unspecified";
export type ActiveTransitionReason = "quota_exhausted" | "credential_invalid" | "account_removed_or_replaced" | "model_unavailable" | null;

export type ResponseTelemetry = Readonly<{
  provider: string;
  fallbackReason: RecordedFallbackReason | null;
  model: string | null;
  reasoning: string | null;
  outputTokenAllowance: number | null;
  /** Total time this request spent waiting for a provider's own retry window. */
  rateLimitWaitMs: number | null;
  /** The sibling tier that served this request after its own tier refused it. */
  rateLimitFailoverModel: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageObserved: boolean;
  usageTelemetryStatus: UsageTelemetryStatus;
  promptCacheKeyPresent: boolean;
  promptCacheMode: PromptCacheMode;
  explicitBreakpointCount: number;
  accountSlot: number | null;
  activeGeneration: number | null;
  activeTransitionReason: ActiveTransitionReason;
  quotaUsedPercent: number | null | undefined;
  completed: boolean;
  semanticOutputObserved: boolean | null;
  upstreamEventKinds: readonly string[];
  streamTerminalType: ResponseStreamTerminalType | null;
  failureKind: string | null;
  responseCreatedObserved: boolean;
  syntheticTerminalType: "response.failed" | "error" | null;
  stream: boolean | null;
  providerRequestId: string | null;
  firstProviderDispatchMs: number | null;
  firstProviderHeadersMs: number | null;
  firstCodexDispatchMs: number | null;
  firstCodexHeadersMs: number | null;
  firstUpstreamSseEventMs: number | null;
  firstSemanticCommitmentMs: number | null;
  streamTerminalMs: number | null;
  attemptedProviders: readonly string[];
  removedProviderTriggerClass: string | null;
  removedProviderCircuitTransition: string | null;
  removedProviderSelectedModel: string | null;
  removedProviderTaskType: string | null;
  removedProviderSemanticCommitment: string | null;
  removedProviderLatencyMs: number | null;
  removedProviderTerminalStatus: string | null;
}>;

export type ResponseStreamTerminalType = "response.completed" | "response.failed" | "response.incomplete" | "error" | "eof" | "cancelled" | "deadline";

export type ResponseTelemetryState = {
  provider: string | null;
  fallbackReason: RecordedFallbackReason | null;
  model: string | null;
  reasoning: string | null;
  outputTokenAllowance: number | null;
  /** Total time this request spent waiting for a provider's own retry window. */
  rateLimitWaitMs: number | null;
  /** The sibling tier that served this request after its own tier refused it. */
  rateLimitFailoverModel: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageObserved: boolean;
  usageTelemetryStatus: UsageTelemetryStatus;
  promptCacheKeyPresent: boolean;
  promptCacheMode: PromptCacheMode;
  explicitBreakpointCount: number;
  accountSlot: number | null;
  accountCohortId: string | null;
  activeGeneration: number | null;
  activeTransitionReason: ActiveTransitionReason;
  quotaUsedPercent: number | null | undefined;
  completed: boolean;
  semanticOutputObserved: boolean | null;
  upstreamEventKinds: string[];
  streamTerminalType: ResponseStreamTerminalType | null;
  failureKind: string | null;
  responseCreatedObserved: boolean;
  syntheticTerminalType: "response.failed" | "error" | null;
  stream: boolean | null;
  providerRequestId: string | null;
  firstProviderDispatchMs: number | null;
  firstProviderHeadersMs: number | null;
  firstCodexDispatchMs: number | null;
  firstCodexHeadersMs: number | null;
  firstUpstreamSseEventMs: number | null;
  firstSemanticCommitmentMs: number | null;
  streamTerminalMs: number | null;
  attemptedProviders: string[];
  removedProviderTriggerClass: string | null;
  removedProviderCircuitTransition: string | null;
  removedProviderSelectedModel: string | null;
  removedProviderTaskType: string | null;
  removedProviderSemanticCommitment: string | null;
  removedProviderLatencyMs: number | null;
  removedProviderTerminalStatus: string | null;
};

export const responseTelemetry = new WeakMap<Response, ResponseTelemetryState>();

export const createResponseTelemetryState = (): ResponseTelemetryState => ({
  provider: null,
  fallbackReason: null,
  model: null,
  reasoning: null,
  outputTokenAllowance: null,
  rateLimitWaitMs: null,
  rateLimitFailoverModel: null,
  inputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  outputTokens: null,
  totalTokens: null,
  usageObserved: false,
  usageTelemetryStatus: "missing",
  promptCacheKeyPresent: false,
  promptCacheMode: "unspecified",
  explicitBreakpointCount: 0,
  accountSlot: null,
  accountCohortId: null,
  activeGeneration: null,
  activeTransitionReason: null,
  quotaUsedPercent: undefined,
  completed: false,
  semanticOutputObserved: null,
  upstreamEventKinds: [],
  streamTerminalType: null,
  failureKind: null,
  responseCreatedObserved: false,
  syntheticTerminalType: null,
  stream: null,
  providerRequestId: null,
  firstProviderDispatchMs: null,
  firstProviderHeadersMs: null,
  firstCodexDispatchMs: null,
  firstCodexHeadersMs: null,
  firstUpstreamSseEventMs: null,
  firstSemanticCommitmentMs: null,
  streamTerminalMs: null,
  attemptedProviders: [],
  removedProviderTriggerClass: null,
  removedProviderCircuitTransition: null,
  removedProviderSelectedModel: null,
  removedProviderTaskType: null,
  removedProviderSemanticCommitment: null,
  removedProviderLatencyMs: null,
  removedProviderTerminalStatus: null,
});

const withResponseTelemetryContext = (context: UsageContext | undefined, state: ResponseTelemetryState): UsageContext => ({
  keyId: context?.keyId ?? null,
  kernelRepo: context?.kernelRepo ?? null,
  kernelOrg: context?.kernelOrg ?? null,
  paidFallbackEnabled: context?.paidFallbackEnabled,
  idempotencyPrincipal: context?.idempotencyPrincipal,
  requestId: context?.requestId,
  paidFallbackRequestId: context?.paidFallbackRequestId,
  startedAtMs: context?.startedAtMs,
  startedAtMonotonicMs: context?.startedAtMonotonicMs,
  downstreamSignal: context?.downstreamSignal,
  beforeProviderDispatch: context?.beforeProviderDispatch,
  sentinelUpstreamRecorder: context?.sentinelUpstreamRecorder,
  onTerminalUsage: context?.onTerminalUsage,
  responseTelemetry: state,
});

// A header present with an empty value still falls back to the gateway label,
// so this keeps the original falsy fallback instead of a nullish one.
const upstreamProviderLabel = (response: Response): string => {
  const header = response.headers.get("x-uos-upstream");
  if (header === null || header === "") return "gateway";
  return header;
};

export const attachResponseTelemetry = (response: Response, state: ResponseTelemetryState): Response => {
  state.provider ??= upstreamProviderLabel(response);
  responseTelemetry.set(response, state);
  return response;
};

/**
 * Attaches completed, answer-bearing telemetry to a gateway-produced Responses
 * result that did not come from a provider dispatch (the local Jev compaction
 * answer). The terminal wrapper's normal completion decision reads this state,
 * so the request settles as completed through the existing handoff instead of
 * being classified as a stream that ended without a completion. No token,
 * allowance, model-cost or provider-usage counter is invented: those fields stay
 * null/missing because no main-model call measured them, and the provider label
 * remains the honest gateway default. Timing fields stay unknown too: there is
 * no provider-relative stream or semantic-commitment instant here, and a
 * wall-clock stamp would be misread as request-relative latency.
 */
export const setResponseCompletionTelemetry = (response: Response, stream: boolean): Response => {
  const state = createResponseTelemetryState();
  state.completed = true;
  state.semanticOutputObserved = true;
  state.stream = stream;
  state.streamTerminalType = "response.completed";
  return attachResponseTelemetry(response, state);
};

const sumTelemetryCounts = (
  states: readonly ResponseTelemetryState[],
  key: "inputTokens" | "cachedInputTokens" | "cacheWriteInputTokens" | "outputTokens" | "totalTokens",
  expectedCount: number
): number | null => {
  if (states.length !== expectedCount || states.some((state) => state[key] === null)) return null;
  return states.reduce((total, state) => total + (state[key] ?? 0), 0);
};

const commonTelemetryValue = <T>(values: readonly T[]): T | null => {
  if (values.length === 0) return null;
  const first = values[0] as T;
  return values.every((value) => Object.is(value, first)) ? first : null;
};

// An invalid member state poisons the aggregate, an incomplete set of members
// can never be reported as complete, and a fully reported set counts as
// reported once usage was observed.
const aggregatedUsageTelemetryStatus = (states: readonly ResponseTelemetryState[], sourceCount: number, usageObserved: boolean): UsageTelemetryStatus => {
  if (states.some((state) => state.usageTelemetryStatus === "invalid")) return "invalid";
  if (states.length !== sourceCount) return usageObserved ? "partial" : "missing";
  if (states.every((state) => state.usageTelemetryStatus === "reported")) return "reported";
  return usageObserved ? "partial" : "missing";
};

const aggregatedQuotaUsedPercent = (usedPercents: readonly number[], states: readonly ResponseTelemetryState[]): number | null | undefined => {
  if (usedPercents.length > 0) return Math.max(...usedPercents);
  return states.some((state) => state.quotaUsedPercent === null) ? null : undefined;
};

const aggregatedSemanticOutputObserved = (states: readonly ResponseTelemetryState[]): boolean | null => {
  if (states.some((state) => state.semanticOutputObserved === true)) return true;
  return states.every((state) => state.semanticOutputObserved === false) ? false : null;
};

const aggregatedProviderLabel = (providers: readonly string[]): string | null => {
  if (providers.length === 1) return providers[0];
  if (providers.length > 1) return "mixed";
  return null;
};

export const aggregateResponseTelemetry = (sources: readonly Response[], target: Response): Response => {
  const states = sources.flatMap((source) => {
    const state = responseTelemetry.get(source);
    return state ? [state] : [];
  });
  if (states.length === 0) return target;
  if (states.length === 1 && sources.length === 1) {
    responseTelemetry.set(target, states[0]);
    return target;
  }

  const aggregate = createResponseTelemetryState();
  const providers = [...new Set(states.map((state) => state.provider).filter((value): value is string => !!value))];
  aggregate.provider = aggregatedProviderLabel(providers);
  aggregate.fallbackReason = commonTelemetryValue(states.map((state) => state.fallbackReason));
  aggregate.model = commonTelemetryValue(states.map((state) => state.model));
  aggregate.reasoning = commonTelemetryValue(states.map((state) => state.reasoning));
  aggregate.outputTokenAllowance = commonTelemetryValue(states.map((state) => state.outputTokenAllowance));
  // Waits from several attempts of one request add up into the absorbed total.
  const waits = states.map((state) => state.rateLimitWaitMs).filter((value): value is number => value !== null);
  aggregate.rateLimitWaitMs = waits.length ? waits.reduce((total, value) => total + value, 0) : null;
  aggregate.rateLimitFailoverModel = commonTelemetryValue(states.map((state) => state.rateLimitFailoverModel));
  aggregate.inputTokens = sumTelemetryCounts(states, "inputTokens", sources.length);
  aggregate.cachedInputTokens = sumTelemetryCounts(states, "cachedInputTokens", sources.length);
  aggregate.cacheWriteInputTokens = sumTelemetryCounts(states, "cacheWriteInputTokens", sources.length);
  aggregate.outputTokens = sumTelemetryCounts(states, "outputTokens", sources.length);
  aggregate.totalTokens = sumTelemetryCounts(states, "totalTokens", sources.length);
  aggregate.usageObserved = states.some((state) => state.usageObserved);
  aggregate.usageTelemetryStatus = aggregatedUsageTelemetryStatus(states, sources.length, aggregate.usageObserved);
  aggregate.promptCacheKeyPresent = states.some((state) => state.promptCacheKeyPresent);
  aggregate.promptCacheMode = commonTelemetryValue(states.map((state) => state.promptCacheMode)) ?? "unspecified";
  aggregate.explicitBreakpointCount = Math.max(0, ...states.map((state) => state.explicitBreakpointCount));
  aggregate.accountSlot = commonTelemetryValue(states.map((state) => state.accountSlot));
  aggregate.accountCohortId = commonTelemetryValue(states.map((state) => state.accountCohortId));
  // Generation and reason are reported together: a differing generation, or
  // any source without active telemetry, yields null for both fields.
  const allSourcesHaveActiveGeneration = states.length === sources.length && states.every((state) => state.activeGeneration !== null);
  const commonActiveGeneration = allSourcesHaveActiveGeneration ? commonTelemetryValue(states.map((state) => state.activeGeneration)) : null;
  aggregate.activeGeneration = commonActiveGeneration;
  aggregate.activeTransitionReason = commonActiveGeneration === null ? null : commonTelemetryValue(states.map((state) => state.activeTransitionReason));
  const usedPercents = states.map((state) => state.quotaUsedPercent).filter((value): value is number => typeof value === "number");
  aggregate.quotaUsedPercent = aggregatedQuotaUsedPercent(usedPercents, states);
  aggregate.completed = states.length === sources.length && states.every((state) => state.completed);
  aggregate.semanticOutputObserved = aggregatedSemanticOutputObserved(states);
  aggregate.upstreamEventKinds = [...new Set(states.flatMap((state) => state.upstreamEventKinds))];
  aggregate.streamTerminalType = aggregate.completed ? "response.completed" : commonTelemetryValue(states.map((state) => state.streamTerminalType));
  aggregate.failureKind = commonTelemetryValue(states.map((state) => state.failureKind));
  aggregate.responseCreatedObserved = states.length === sources.length && states.every((state) => state.responseCreatedObserved);
  aggregate.syntheticTerminalType = commonTelemetryValue(states.map((state) => state.syntheticTerminalType));
  aggregate.stream = false;
  aggregate.providerRequestId = states.length === 1 ? states[0].providerRequestId : null;
  const earliestTiming = (
    key:
      | "firstProviderDispatchMs"
      | "firstProviderHeadersMs"
      | "firstCodexDispatchMs"
      | "firstCodexHeadersMs"
      | "firstUpstreamSseEventMs"
      | "firstSemanticCommitmentMs"
  ): number | null => {
    const values = states.map((state) => state[key]).filter((value): value is number => value !== null);
    return values.length > 0 ? Math.min(...values) : null;
  };
  aggregate.firstProviderDispatchMs = earliestTiming("firstProviderDispatchMs");
  aggregate.firstProviderHeadersMs = earliestTiming("firstProviderHeadersMs");
  aggregate.firstCodexDispatchMs = earliestTiming("firstCodexDispatchMs");
  aggregate.firstCodexHeadersMs = earliestTiming("firstCodexHeadersMs");
  aggregate.firstUpstreamSseEventMs = earliestTiming("firstUpstreamSseEventMs");
  aggregate.firstSemanticCommitmentMs = earliestTiming("firstSemanticCommitmentMs");
  const terminalTimes = states.map((state) => state.streamTerminalMs).filter((value): value is number => value !== null);
  aggregate.streamTerminalMs = terminalTimes.length > 0 ? Math.max(...terminalTimes) : null;
  aggregate.attemptedProviders = [...new Set(states.flatMap((state) => state.attemptedProviders))];
  aggregate.removedProviderTriggerClass = commonTelemetryValue(states.map((state) => state.removedProviderTriggerClass));
  aggregate.removedProviderCircuitTransition = commonTelemetryValue(states.map((state) => state.removedProviderCircuitTransition));
  aggregate.removedProviderSelectedModel = commonTelemetryValue(states.map((state) => state.removedProviderSelectedModel));
  aggregate.removedProviderTaskType = commonTelemetryValue(states.map((state) => state.removedProviderTaskType));
  aggregate.removedProviderSemanticCommitment = commonTelemetryValue(states.map((state) => state.removedProviderSemanticCommitment));
  const removedProviderLatencies = states.map((state) => state.removedProviderLatencyMs).filter((value): value is number => value !== null);
  aggregate.removedProviderLatencyMs = removedProviderLatencies.length > 0 ? Math.max(...removedProviderLatencies) : null;
  aggregate.removedProviderTerminalStatus = commonTelemetryValue(states.map((state) => state.removedProviderTerminalStatus));
  return attachResponseTelemetry(target, aggregate);
};

export const getResponseTelemetry = (response: Response): ResponseTelemetry | null => {
  const state = responseTelemetry.get(response);
  if (!state) return null;
  return {
    provider: state.provider ?? upstreamProviderLabel(response),
    fallbackReason: state.fallbackReason,
    model: state.model,
    reasoning: state.reasoning,
    outputTokenAllowance: state.outputTokenAllowance,
    rateLimitWaitMs: state.rateLimitWaitMs,
    rateLimitFailoverModel: state.rateLimitFailoverModel,
    inputTokens: state.inputTokens,
    cachedInputTokens: state.cachedInputTokens,
    cacheWriteInputTokens: state.cacheWriteInputTokens,
    outputTokens: state.outputTokens,
    totalTokens: state.totalTokens,
    usageObserved: state.usageObserved,
    usageTelemetryStatus: state.usageTelemetryStatus,
    promptCacheKeyPresent: state.promptCacheKeyPresent,
    promptCacheMode: state.promptCacheMode,
    explicitBreakpointCount: state.explicitBreakpointCount,
    accountSlot: state.accountSlot,
    activeGeneration: state.activeGeneration,
    activeTransitionReason: state.activeTransitionReason,
    quotaUsedPercent: state.quotaUsedPercent,
    completed: state.completed,
    semanticOutputObserved: state.semanticOutputObserved,
    upstreamEventKinds: [...state.upstreamEventKinds],
    streamTerminalType: state.streamTerminalType,
    failureKind: state.failureKind,
    responseCreatedObserved: state.responseCreatedObserved,
    syntheticTerminalType: state.syntheticTerminalType,
    stream: state.stream,
    providerRequestId: state.providerRequestId,
    firstProviderDispatchMs: state.firstProviderDispatchMs,
    firstProviderHeadersMs: state.firstProviderHeadersMs,
    firstCodexDispatchMs: state.firstCodexDispatchMs,
    firstCodexHeadersMs: state.firstCodexHeadersMs,
    firstUpstreamSseEventMs: state.firstUpstreamSseEventMs,
    firstSemanticCommitmentMs: state.firstSemanticCommitmentMs,
    streamTerminalMs: state.streamTerminalMs,
    attemptedProviders: [...state.attemptedProviders],
    removedProviderTriggerClass: state.removedProviderTriggerClass,
    removedProviderCircuitTransition: state.removedProviderCircuitTransition,
    removedProviderSelectedModel: state.removedProviderSelectedModel,
    removedProviderTaskType: state.removedProviderTaskType,
    removedProviderSemanticCommitment: state.removedProviderSemanticCommitment,
    removedProviderLatencyMs: state.removedProviderLatencyMs,
    removedProviderTerminalStatus: state.removedProviderTerminalStatus,
  };
};
/** Stable pseudonymous account identity used only by aggregate cache telemetry. */
export const getResponseAccountCohortId = (response: Response): string | null => responseTelemetry.get(response)?.accountCohortId ?? null;

export const recordAttemptedProvider = (context: UsageContext | undefined, provider: string): void => {
  const attempted = context?.responseTelemetry?.attemptedProviders;
  if (attempted && !attempted.includes(provider)) attempted.push(provider);
};

export const selectRemovedProviderTelemetry = (context: UsageContext | undefined): void => {
  const telemetry = context?.responseTelemetry;
  if (!telemetry) return;
  telemetry.provider = "removed_provider";
  telemetry.accountSlot = null;
  telemetry.accountCohortId = null;
  telemetry.activeGeneration = null;
  telemetry.activeTransitionReason = null;
  telemetry.providerRequestId = null;
};

type ResponseTelemetryTimingField =
  | "firstProviderDispatchMs"
  | "firstProviderHeadersMs"
  | "firstCodexDispatchMs"
  | "firstCodexHeadersMs"
  | "firstUpstreamSseEventMs"
  | "firstSemanticCommitmentMs"
  | "streamTerminalMs";

// Timings are elapsed from handler ingress using a monotonic clock. They are
// telemetry only: missing context leaves the corresponding field unavailable.
const recordResponseTiming = (context: UsageContext | undefined, field: ResponseTelemetryTimingField): void => {
  const state = context?.responseTelemetry;
  const startedAtMs = context?.startedAtMonotonicMs;
  if (!state) return;
  if (state[field] !== null || typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return;
  state[field] = Math.max(0, Math.round(performance.now() - startedAtMs));
};

export const recordFirstCodexDispatch = (context: UsageContext | undefined): void => {
  recordResponseTiming(context, "firstProviderDispatchMs");
  recordResponseTiming(context, "firstCodexDispatchMs");
};

export const recordFirstCodexHeaders = (context: UsageContext | undefined): void => {
  recordResponseTiming(context, "firstProviderHeadersMs");
  recordResponseTiming(context, "firstCodexHeadersMs");
};

export const recordFirstProviderDispatch = (context: UsageContext | undefined): void => {
  recordResponseTiming(context, "firstProviderDispatchMs");
};

export const recordFirstProviderHeaders = (context: UsageContext | undefined): void => {
  recordResponseTiming(context, "firstProviderHeadersMs");
};

export const recordRemovedProviderFields = (context: UsageContext | undefined, fields: Readonly<Record<string, string | number | null | undefined>>): void => {
  const telemetry = context?.responseTelemetry;
  if (!telemetry) return;
  if (fields.triggerClass !== undefined) telemetry.removedProviderTriggerClass = fields.triggerClass as string | null;
  if (fields.circuitTransition !== undefined) {
    telemetry.removedProviderCircuitTransition = fields.circuitTransition as string | null;
  }
  if (fields.selectedModel !== undefined) {
    telemetry.removedProviderSelectedModel = fields.selectedModel as string | null;
  }
  if (fields.taskType !== undefined) telemetry.removedProviderTaskType = fields.taskType as string | null;
  if (fields.semanticCommitment !== undefined) {
    telemetry.removedProviderSemanticCommitment = fields.semanticCommitment as string | null;
  }
  if (fields.latencyMs !== undefined) telemetry.removedProviderLatencyMs = fields.latencyMs as number | null;
  if (fields.terminalStatus !== undefined) {
    telemetry.removedProviderTerminalStatus = fields.terminalStatus as string | null;
  }
};

export const persistRemovedProviderFields = (_context: UsageContext | undefined): Promise<void> => recordRemovedProviderTelemetry({}).catch(() => {});

export const persistFailedRemovedProviderAttempt = (context: UsageContext | undefined, _startedAtMonotonicMs: number, triggerClass: string): Promise<void> => {
  recordRemovedProviderFields(context, { triggerClass, terminalStatus: "failed_before_commit" });
  return persistRemovedProviderFields(context);
};

export const recordFirstUpstreamSseEvent = (context: UsageContext | undefined): void => {
  recordResponseTiming(context, "firstUpstreamSseEventMs");
};

export const recordFirstSemanticCommitment = (context: UsageContext | undefined): void => {
  recordResponseTiming(context, "firstSemanticCommitmentMs");
};

export const recordStreamTerminal = (context: UsageContext | undefined): void => {
  recordResponseTiming(context, "streamTerminalMs");
};

const CHAT_RESPONSE_EVENT_KINDS = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
  "response.output_text.delta",
  "response.output_text.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.custom_tool_call_input.delta",
  "response.custom_tool_call_input.done",
  "response.output_item.added",
  "response.output_item.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.output",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

const boundedResponseEventKind = (type: string): string => (CHAT_RESPONSE_EVENT_KINDS.has(type) ? type : "unrecognized");

// An incomplete terminal is a recorded failure only when its reason names a
// gateway, provider or transport fault; unrecognized reasons are ignored.
const incompleteFailureKind = (event: ResponsesStreamEvent): string | null => {
  const response = isRecord(event.value.response) ? event.value.response : null;
  if (!response) return null;
  const details = isRecord(response.incomplete_details) ? response.incomplete_details : null;
  if (!details) return null;
  const reason = typeof details.reason === "string" ? details.reason : null;
  if (!reason) return null;
  // This character class is case-insensitive, so the upper-case range already
  // covers the lower-case letters.
  if (!/^(?:gateway|provider|upstream|server|network|timeout|deadline)[A-Z0-9_.:-]*$/i.test(reason)) return null;
  return `response_incomplete:${reason}`;
};

export const recordResponsesEventTelemetry = (context: UsageContext | undefined, event: ResponsesStreamEvent): void => {
  const telemetry = context?.responseTelemetry;
  if (!telemetry) return;
  const eventKind = boundedResponseEventKind(event.type);
  if (!telemetry.upstreamEventKinds.includes(eventKind)) telemetry.upstreamEventKinds.push(eventKind);
  if (event.type === "response.created") telemetry.responseCreatedObserved = true;
  if (event.type === "response.incomplete") {
    const failureKind = incompleteFailureKind(event);
    if (failureKind !== null) telemetry.failureKind = failureKind;
  }
  if (isSyntheticResponsesFailureEvent(event)) {
    telemetry.syntheticTerminalType = event.type === "response.failed" || event.type === "error" ? event.type : null;
  }
};

const failureKindFromError = (error: unknown): ResponsesStreamFailureKind => (error instanceof ResponsesStreamError ? error.kind : "read_error");

export const recordResponsesFailureTelemetry = (context: UsageContext | undefined, error: unknown, details?: OwnedResponsesStreamFailureDetails): void => {
  const telemetry = context?.responseTelemetry;
  if (!telemetry) return;
  telemetry.failureKind = details?.failureKind ?? failureKindFromError(error);
  if (details) {
    telemetry.responseCreatedObserved = details.responseCreatedObserved;
    telemetry.semanticOutputObserved = details.semanticCommitmentObserved;
    telemetry.syntheticTerminalType = details.syntheticTerminalType;
  }
};

export const runWithResponseTelemetry = async (context: UsageContext | undefined, run: (context: UsageContext) => Promise<Response>): Promise<Response> => {
  const state = createResponseTelemetryState();
  const telemetryContext = withResponseTelemetryContext(context, state);
  const response = await run(telemetryContext);
  // Attempt-level terminal types can be abandoned during failover. Record a
  // precommit terminal time only after the handler has selected the final
  // response, and only when an upstream SSE event was actually observed.
  if (
    state.firstUpstreamSseEventMs !== null &&
    state.firstSemanticCommitmentMs === null &&
    state.streamTerminalType !== null &&
    state.streamTerminalMs === null
  ) {
    recordStreamTerminal(telemetryContext);
  }
  return attachResponseTelemetry(response, state);
};

export type RoutedResponsesUpstream = Readonly<{
  response: Response;
  provider: UpstreamProvider;
  paidFallback: PaidFallbackReservation | null;
  paidFallbackBilling?: SurplusBillingPricing | null;
  /** Trustworthy opaque identifier supplied by the selected upstream. */
  paidFallbackProviderRequestId?: string | null;
  /**
   * Health classification of a delivered non-2xx paid response, so the terminal
   * transport record preserves the provider-specific signal.
   */
  paidFallbackErrorHealth?: PaidProviderHealthClassification;
  gatewayResponse: boolean;
  fallbackReason: RecordedFallbackReason | null;
  /** Local admission decisions are terminal and must not enter legacy recovery. */
  allowRemovedProviderRecovery?: false;
  /** Record stream health even though this free route has no paid reservation. */
  providerHealthOnly?: boolean;
}>;

export type UsageTokens = Readonly<{
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  status: UsageTelemetryStatus;
  /** Exact Surplus charge in microcredits; null means a present malformed amount. */
  buyerCostMicro?: number | null;
}>;

type ParsedUsageToken = Readonly<{ value: number | null; invalid: boolean }>;

const parseUsageToken = (value: unknown, present: boolean): ParsedUsageToken => {
  if (!present) return { value: null, invalid: false };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return { value: null, invalid: true };
  }
  return { value, invalid: false };
};

/**
 * Normalizes terminal Responses usage for gateway telemetry. The fixed
 * cache-scope experiment reuses this parser so it cannot invent a divergent
 * interpretation of cache-read or cache-write fields.
 */
export const extractUsageTokens = (value: unknown): UsageTokens | null => {
  if (value === undefined) return null;
  if (!isRecord(value) || Array.isArray(value)) {
    return {
      inputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: null,
      totalTokens: null,
      status: "invalid",
    };
  }
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
  const inputTokens = parseUsageToken(value.input_tokens, has("input_tokens"));
  const outputTokens = parseUsageToken(value.output_tokens, has("output_tokens"));
  const totalTokens = parseUsageToken(value.total_tokens, has("total_tokens"));
  const detailsPresent = has("input_tokens_details");
  const details = detailsPresent && isRecord(value.input_tokens_details) && !Array.isArray(value.input_tokens_details) ? value.input_tokens_details : null;
  const cachedInputTokens = parseUsageToken(details?.cached_tokens, details !== null && Object.prototype.hasOwnProperty.call(details, "cached_tokens"));
  const cacheWriteInputTokens = parseUsageToken(
    details?.cache_write_tokens,
    details !== null && Object.prototype.hasOwnProperty.call(details, "cache_write_tokens")
  );

  const coreMissing = inputTokens.value === null || outputTokens.value === null || totalTokens.value === null;
  // OpenAI documents cached_tokens for every response, including an explicit
  // zero below the cacheability threshold. cache_write_tokens remains
  // model-dependent, so its absence does not downgrade otherwise complete
  // cache-read telemetry.
  const cacheReadMissing = cachedInputTokens.value === null;
  // cache_write_tokens is an independent dimension: an input can be both
  // newly cached and partly served from cache. cached_tokens, however, is a
  // subset of the request input and may never exceed input_tokens.
  const cachedTokensExceedInput = inputTokens.value !== null && cachedInputTokens.value !== null && cachedInputTokens.value > inputTokens.value;
  const inconsistentTotals = !coreMissing && inputTokens.value + outputTokens.value !== totalTokens.value;
  const invalid =
    inputTokens.invalid ||
    outputTokens.invalid ||
    totalTokens.invalid ||
    (detailsPresent && details === null) ||
    cachedInputTokens.invalid ||
    cacheWriteInputTokens.invalid ||
    cachedTokensExceedInput ||
    inconsistentTotals;

  let status: UsageTelemetryStatus;
  if (invalid) status = "invalid";
  else if (coreMissing || cacheReadMissing) status = "partial";
  else status = "reported";

  return {
    inputTokens: inputTokens.value,
    cachedInputTokens: cachedInputTokens.value,
    cacheWriteInputTokens: cacheWriteInputTokens.value,
    outputTokens: outputTokens.value,
    totalTokens: totalTokens.value,
    status,
    ...(has("buyer_cost_micro") ? { buyerCostMicro: parseUsageToken(value.buyer_cost_micro, true).value } : {}),
  };
};

export const toChatUsage = (usage: UsageTokens | null): Record<string, unknown> | null => {
  if (usage === null) return null;
  if (usage.inputTokens === null || usage.outputTokens === null || usage.totalTokens === null) {
    return null;
  }
  const promptTokenDetails: Record<string, number> = {};
  // Prompt Caching documents both fields on Chat Completions usage details.
  if (usage.cachedInputTokens !== null) promptTokenDetails.cached_tokens = usage.cachedInputTokens;
  if (usage.cacheWriteInputTokens !== null) promptTokenDetails.cache_write_tokens = usage.cacheWriteInputTokens;
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(Object.keys(promptTokenDetails).length ? { prompt_tokens_details: promptTokenDetails } : {}),
  };
};

export const promptCacheModeFor = (rawRecord: Record<string, unknown>): PromptCacheMode => {
  const options = isRecord(rawRecord.prompt_cache_options) && !Array.isArray(rawRecord.prompt_cache_options) ? rawRecord.prompt_cache_options : null;
  if (options?.mode === "explicit") return "explicit";
  // OpenAI's cache policy defaults to implicit whenever options are supplied
  // without an explicit mode (for example, a ttl-only configuration).
  if (options !== null) return "implicit";
  if (Object.prototype.hasOwnProperty.call(rawRecord, "prompt_cache_retention")) return "legacy_retention";
  return "unspecified";
};

export const countExplicitPromptCacheBreakpoints = (input: readonly ResponseInputItem[]): number => {
  let count = 0;
  const countContent = (content: unknown): void => {
    if (!Array.isArray(content)) return;
    for (const contentItem of content) {
      if (!isRecord(contentItem) || !isRecord(contentItem.prompt_cache_breakpoint)) continue;
      if (contentItem.prompt_cache_breakpoint.mode === "explicit") count += 1;
    }
  };
  for (const item of input) {
    if (!isRecord(item)) continue;
    countContent(item.content);
    if (item.type === "function_call_output") countContent(item.output);
  }
  return count;
};

export const promptCacheKeyPresent = (rawRecord: Record<string, unknown>): boolean =>
  typeof rawRecord.prompt_cache_key === "string" && rawRecord.prompt_cache_key.trim().length > 0;

/**
 * Cache-read telemetry for the special upstreams that answer with Chat
 * Completions usage. Their transports publish the provider's cache counter
 * under the official `prompt_tokens_details.cached_tokens` field, and the
 * Responses parser owns the interpretation of that field so the two routes
 * cannot report cache reads through divergent rules.
 *
 * An upstream that reports no counter leaves `input_tokens_details` absent,
 * which the parser reports as `partial`: unmeasured is never published as a
 * measured zero.
 */
export const extractChatUsageTokens = (value: unknown): UsageTokens | null => {
  if (!isRecord(value) || Array.isArray(value)) return null;
  const responsesUsage: Record<string, unknown> = {};
  for (const [chatKey, responsesKey] of [
    ["prompt_tokens", "input_tokens"],
    ["completion_tokens", "output_tokens"],
    ["total_tokens", "total_tokens"],
    ["prompt_tokens_details", "input_tokens_details"],
    ["buyer_cost_micro", "buyer_cost_micro"],
  ]) {
    if (Object.prototype.hasOwnProperty.call(value, chatKey)) responsesUsage[responsesKey] = value[chatKey];
  }
  // Preserve field presence and exact values for the shared strict parser:
  // truncating a fractional counter can fabricate a measured cache miss.
  return extractUsageTokens(responsesUsage);
};

export const recordRequestUsage = (
  context: UsageContext | undefined,
  details: {
    model: string;
    route: string;
    stream: boolean;
    reasoning: string | null;
    promptCacheKeyPresent?: boolean;
    promptCacheMode?: PromptCacheMode;
    explicitBreakpointCount?: number;
  }
): Promise<void> => {
  if (context?.responseTelemetry) {
    context.responseTelemetry.model = details.model;
    context.responseTelemetry.reasoning = details.reasoning;
    context.responseTelemetry.stream = details.stream;
    context.responseTelemetry.promptCacheKeyPresent = details.promptCacheKeyPresent ?? false;
    context.responseTelemetry.promptCacheMode = details.promptCacheMode ?? "unspecified";
    context.responseTelemetry.explicitBreakpointCount = details.explicitBreakpointCount ?? 0;
  }
  return Promise.resolve();
};

export const recordCompletionUsage = (context: UsageContext | undefined, usage: UsageTokens | null): Promise<void> => {
  recordTerminalUsage(context, usage, true);
  return Promise.resolve();
};

export const recordTerminalUsage = (context: UsageContext | undefined, usage: UsageTokens | null, completed: boolean): void => {
  const telemetry = context?.responseTelemetry;
  if (!telemetry) return;
  telemetry.inputTokens = usage?.inputTokens ?? null;
  telemetry.cachedInputTokens = usage?.cachedInputTokens ?? null;
  telemetry.cacheWriteInputTokens = usage?.cacheWriteInputTokens ?? null;
  telemetry.outputTokens = usage?.outputTokens ?? null;
  telemetry.totalTokens = usage?.totalTokens ?? null;
  telemetry.usageObserved = usage !== null;
  telemetry.usageTelemetryStatus = usage?.status ?? "missing";
  telemetry.completed = completed;
  try {
    context.onTerminalUsage?.(usage, completed);
  } catch {
    // A test/observability callback cannot alter response delivery.
  }
};

export const recordErrorUsage = (_context: UsageContext | undefined): Promise<void> => Promise.resolve();

export const recordStreamTerminalType = (context: UsageContext | undefined, terminalType: ResponseStreamTerminalType): void => {
  const telemetry = context?.responseTelemetry;
  if (!telemetry) return;
  telemetry.streamTerminalType = terminalType;
  if (telemetry.firstSemanticCommitmentMs !== null) recordStreamTerminal(context);
};

export const classifyStreamFailure = (error: unknown, signal: AbortSignal, downstreamSignal: AbortSignal): ResponseStreamTerminalType => {
  if (isTimeoutFailure(error, signal.reason, downstreamSignal.reason)) return "deadline";
  if (downstreamSignal.aborted) return "cancelled";
  if (signal.aborted) return "deadline";
  if (error instanceof ResponsesStreamError && error.kind === "inactivity_timeout") return "deadline";
  if (error instanceof ResponsesStreamError && error.kind === "premature_eof") return "eof";
  return "error";
};

export const isTimeoutFailure = (...values: readonly unknown[]): boolean =>
  values.some((value) => (value instanceof CodexError && value.code === "gateway_timeout") || (value instanceof Error && value.name === "TimeoutError"));

export const classifyPreHeaderFailure = (error: unknown, signal: AbortSignal, downstreamSignal: AbortSignal): ResponseStreamTerminalType => {
  if (isTimeoutFailure(error, signal.reason, downstreamSignal.reason)) return "deadline";
  if (downstreamSignal.aborted) return "cancelled";
  if (signal.aborted) return "deadline";
  return "error";
};

export const streamErrorResponse = (
  status: number,
  message: string,
  code: string,
  provider: UpstreamProvider,
  warnings: readonly string[],
  type?: string,
  param?: string | null
): Response => {
  const mergedWarnings = Array.from(new Set(warnings));
  const hasAuthWarning = mergedWarnings.includes(CODEX_AUTH_REAUTH_WARNING);
  const headers: Record<string, string> = { "x-uos-upstream": provider };
  if (mergedWarnings.length) headers["x-uos-warning"] = mergedWarnings.join(", ");
  return openaiError(status, hasAuthWarning ? message + " " + CODEX_AUTH_REAUTH_MESSAGE : message, code, {
    ...(type ? { type } : {}),
    ...(param !== undefined ? { param } : {}),
    headers,
  });
};

export const streamPreflightFailureResponse = (
  terminalType: ResponseStreamTerminalType,
  provider: UpstreamProvider,
  warnings: readonly string[] = []
): Response => {
  if (terminalType === "cancelled") {
    return streamErrorResponse(499, "Request was cancelled.", "request_cancelled", provider, warnings, "server_error", null);
  }
  if (terminalType === "deadline") {
    return streamErrorResponse(
      504,
      "Upstream stream exceeded the gateway deadline before its first SSE event.",
      "gateway_timeout",
      provider,
      warnings,
      "server_error"
    );
  }
  return streamErrorResponse(502, "Codex upstream stream ended unexpectedly.", "codex_upstream_stream_error", provider, warnings);
};
