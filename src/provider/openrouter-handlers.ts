// Direct OpenRouter serving: Chat Completions and Responses.
//
// OpenRouter exposes both OpenAI-compatible wires, so this route forwards the
// client's own body with the model swapped and default web tools for OpenAI
// models, then relays the upstream payload. The catalogue, capabilities, and dispatch
// all read `openRouterServableModelIds()`, so the offered set and the served
// set can never disagree, and a new upstream model becomes callable as soon as
// the cached public list refreshes.

import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { markChatSemanticOutput } from "../chat/stream-translation.ts";
import { json, openaiError } from "../http.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "../inference-deadline.ts";
import { downstreamSignalFor, inferenceSignal } from "../openai.ts";
import {
  extractChatUsageTokens,
  extractUsageTokens,
  promptCacheKeyPresent,
  promptCacheModeFor,
  recordAttemptedProvider,
  recordCompletionUsage,
  recordFirstProviderDispatch,
  recordFirstProviderHeaders,
  recordRequestUsage,
  recordStreamTerminalType,
  type PromptCacheMode,
  type UsageContext,
} from "../openai-telemetry.ts";
import { chatCompletionHasAnswerBearingOutput, providerRequestIdFromResponse, toOpenAiUpstreamErrorResponse } from "../upstream-wire.ts";
import { getString, isRecord } from "../utils.ts";
import { recordOpenRouterProviderHealth } from "./health.ts";
import { withOpenRouterOpenAiWebTools } from "./openrouter-web-tools.ts";
import { recordOpenRouterResponseHealth, streamOpenRouterChatCompletion, streamOpenRouterResponses } from "./openrouter-streams.ts";
import {
  fetchOpenRouterChatCompletions,
  fetchOpenRouterResponses,
  OpenRouterError,
  type OpenRouterDispatchHooks,
  resolveOpenRouterUpstreamModel,
} from "./openrouter.ts";

type OpenRouterRouteTransport = (
  body: Readonly<Record<string, unknown>>,
  init: Readonly<{ signal: AbortSignal; hooks?: OpenRouterDispatchHooks }>
) => Promise<Response>;

export type OpenRouterHandlerDeps = Readonly<{
  /** Test seam: the OpenRouter transport for each wire. */
  fetchChat?: OpenRouterRouteTransport;
  fetchResponses?: OpenRouterRouteTransport;
}>;

const OPENROUTER_UPSTREAM_LABEL = "openrouter";

const enqueueOpenRouterCacheBlocks = (item: unknown, pending: unknown[]): void => {
  if (Array.isArray(item)) {
    for (const part of item) pending.push(part);
    return;
  }
  if (!isRecord(item)) return;
  // Walk request content and tool blocks, excluding tool JSON schemas.
  for (const key of ["instructions", "input", "messages", "tools", "content", "output", "function"]) {
    if (item[key] !== undefined) pending.push(item[key]);
  }
};

const openRouterExplicitCacheControls = (body: Record<string, unknown>): Readonly<{ nestedControlPresent: boolean; explicitBreakpointCount: number }> => {
  const pending: unknown[] = [body];
  let explicitBreakpointCount = 0;
  let nestedControlPresent = false;
  while (pending.length > 0) {
    const item = pending.pop();
    enqueueOpenRouterCacheBlocks(item, pending);
    if (!isRecord(item) || item === body) continue;
    if (Object.prototype.hasOwnProperty.call(item, "cache_control") || Object.prototype.hasOwnProperty.call(item, "prompt_cache_breakpoint")) {
      nestedControlPresent = true;
      if (
        (isRecord(item.cache_control) && item.cache_control.type === "ephemeral") ||
        (isRecord(item.prompt_cache_breakpoint) && item.prompt_cache_breakpoint.mode === "explicit")
      )
        explicitBreakpointCount += 1;
    }
  }
  return { nestedControlPresent, explicitBreakpointCount };
};

/** Apply Claude's default five-minute cache policy only on the upstream wire. */
const withOpenRouterClaudePromptCache = (
  body: Record<string, unknown>,
  model: string
): Readonly<{ body: Record<string, unknown>; promptCacheMode: PromptCacheMode; explicitBreakpointCount: number }> => {
  const { nestedControlPresent, explicitBreakpointCount } = openRouterExplicitCacheControls(body);
  const declaredMode = promptCacheModeFor(body);
  const explicit = nestedControlPresent || declaredMode === "explicit";
  const automaticControlPresent = Object.prototype.hasOwnProperty.call(body, "cache_control");
  const enableAutomatic = /^~?anthropic\/claude-/.test(model) && !automaticControlPresent && !explicit;
  let promptCacheMode = declaredMode;
  if (explicit) promptCacheMode = "explicit";
  else if (automaticControlPresent || enableAutomatic) promptCacheMode = "implicit";
  return {
    body: enableAutomatic ? { ...body, cache_control: { type: "ephemeral" } } : body,
    promptCacheMode,
    explicitBreakpointCount,
  };
};

const dispatchFailure = (error: unknown): Response => {
  if (error instanceof OpenRouterError && error.code === "openrouter_api_key_missing") {
    return openaiError(503, "OpenRouter is not configured", "openrouter_api_key_missing");
  }
  void recordOpenRouterProviderHealth("upstream_error", null, Date.now);
  if (isAbortLike(error)) {
    return openaiError(499, "Request was cancelled.", "request_cancelled", { type: "server_error", param: null });
  }
  return openaiError(502, "OpenRouter upstream unreachable", "openrouter_upstream_unreachable");
};

const isAbortLike = (error: unknown): boolean => {
  if (error instanceof Error) return error.name === "AbortError" || error.name === "TimeoutError";
  return false;
};

type Dispatched = Readonly<{ response: Response; providerRequestId: string | null }>;

const dispatchUpstream = async (attempt: () => Promise<Response>, requestSignal: AbortSignal, usageContext: UsageContext | undefined): Promise<Dispatched> => {
  let upstream: Response;
  try {
    upstream = await attempt();
  } catch (error) {
    if (error instanceof ApiKeyQuotaDispatchError) throw error;
    return { response: dispatchFailure(error), providerRequestId: null };
  }
  const providerRequestId = providerRequestIdFromResponse(upstream);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.providerRequestId = providerRequestId;
  recordOpenRouterResponseHealth(upstream.status);
  if (!upstream.ok) {
    return {
      response: await toOpenAiUpstreamErrorResponse(upstream, OPENROUTER_UPSTREAM_LABEL, requestSignal),
      providerRequestId,
    };
  }
  return { response: upstream, providerRequestId };
};

const hooksFor = (usageContext: UsageContext | undefined) => ({
  beforeDispatch: () => usageContext?.beforeProviderDispatch?.("openrouter") ?? Promise.resolve(undefined),
  onDispatch: () => {
    recordAttemptedProvider(usageContext, "openrouter");
    recordFirstProviderDispatch(usageContext);
  },
  onHeaders: () => {
    recordFirstProviderHeaders(usageContext);
  },
  sentinelUpstreamRecorder: usageContext?.sentinelUpstreamRecorder,
});

export const handleOpenRouterChatCompletions = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  modelRaw: string,
  usageContext?: UsageContext,
  deps: OpenRouterHandlerDeps = {}
): Promise<Response> => {
  const upstreamModel = await resolveOpenRouterUpstreamModel(modelRaw);
  if (!upstreamModel) {
    return openaiError(400, "The requested model is not served by OpenRouter.", "openrouter_request_invalid", { param: "model" });
  }
  const clientWantsStream = rawRecord.stream === true;
  const cacheRequest = withOpenRouterClaudePromptCache(
    withOpenRouterOpenAiWebTools({ ...rawRecord, model: upstreamModel, stream: clientWantsStream }, upstreamModel),
    upstreamModel
  );
  const body = cacheRequest.body;
  if (clientWantsStream) {
    // The gateway needs the upstream usage frame to meter the call.
    if (body.stream_options === undefined) body.stream_options = { include_usage: true };
  } else {
    delete body.stream_options;
  }
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.provider = OPENROUTER_UPSTREAM_LABEL;
    usageContext.responseTelemetry.outputTokenAllowance = typeof rawRecord.max_completion_tokens === "number" ? rawRecord.max_completion_tokens : null;
  }
  await recordRequestUsage(usageContext, {
    model: modelRaw,
    route: "chat.completions",
    stream: clientWantsStream,
    reasoning: getString(rawRecord.reasoning_effort),
    promptCacheKeyPresent: promptCacheKeyPresent(rawRecord),
    promptCacheMode: cacheRequest.promptCacheMode,
    explicitBreakpointCount: cacheRequest.explicitBreakpointCount,
  });

  const requestSignal = inferenceSignal(req, usageContext);
  const downstreamSignal = downstreamSignalFor(req, usageContext);
  const transport = deps.fetchChat ?? fetchOpenRouterChatCompletions;
  const dispatched = await dispatchUpstream(
    async () => await transport(body, { signal: requestSignal, hooks: hooksFor(usageContext) }),
    requestSignal,
    usageContext
  );
  if (!dispatched.response.ok) return dispatched.response;
  if (clientWantsStream) {
    return streamOpenRouterChatCompletion(dispatched.response, dispatched.providerRequestId, usageContext, downstreamSignal, requestSignal, upstreamModel);
  }

  const captured = await readBoundedResponseBody(dispatched.response, {
    signal: requestSignal,
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
    cancellationReason: "OpenRouter Chat Completions response was incomplete",
  });
  if (!captured.complete) {
    recordStreamTerminalType(usageContext, "error");
    return openaiError(502, "OpenRouter Chat Completions response was incomplete", "openrouter_upstream_incomplete");
  }
  const payload = parseJsonRecord(captured.bytes);
  if (!payload) {
    recordStreamTerminalType(usageContext, "error");
    return openaiError(502, "OpenRouter returned an unusable body", "openrouter_upstream_invalid_response");
  }
  if (chatCompletionHasAnswerBearingOutput(payload)) markChatSemanticOutput(usageContext);
  await recordCompletionUsage(usageContext, extractChatUsageTokens(payload.usage));
  recordStreamTerminalType(usageContext, "response.completed");
  return json(200, payload, { "x-uos-upstream": OPENROUTER_UPSTREAM_LABEL });
};

export const handleOpenRouterResponses = async (
  req: Request,
  rawRecord: Record<string, unknown>,
  modelRaw: string,
  usageContext?: UsageContext,
  deps: OpenRouterHandlerDeps = {}
): Promise<Response> => {
  const upstreamModel = await resolveOpenRouterUpstreamModel(modelRaw);
  if (!upstreamModel) {
    return openaiError(400, "The requested model is not served by OpenRouter.", "openrouter_request_invalid", { param: "model" });
  }
  const clientWantsStream = rawRecord.stream === true;
  const cacheRequest = withOpenRouterClaudePromptCache(withOpenRouterOpenAiWebTools({ ...rawRecord, model: upstreamModel }, upstreamModel), upstreamModel);
  const body = cacheRequest.body;
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.provider = OPENROUTER_UPSTREAM_LABEL;
  }
  await recordRequestUsage(usageContext, {
    model: modelRaw,
    route: "responses",
    stream: clientWantsStream,
    reasoning: isRecord(rawRecord.reasoning) ? getString(rawRecord.reasoning.effort) : null,
    promptCacheKeyPresent: promptCacheKeyPresent(rawRecord),
    promptCacheMode: cacheRequest.promptCacheMode,
    explicitBreakpointCount: cacheRequest.explicitBreakpointCount,
  });

  const requestSignal = inferenceSignal(req, usageContext);
  const downstreamSignal = downstreamSignalFor(req, usageContext);
  const transport = deps.fetchResponses ?? fetchOpenRouterResponses;
  const dispatched = await dispatchUpstream(
    async () => await transport(body, { signal: requestSignal, hooks: hooksFor(usageContext) }),
    requestSignal,
    usageContext
  );
  if (!dispatched.response.ok) return dispatched.response;
  if (clientWantsStream) {
    return streamOpenRouterResponses(dispatched.response, dispatched.providerRequestId, usageContext, downstreamSignal, requestSignal);
  }

  const captured = await readBoundedResponseBody(dispatched.response, {
    signal: requestSignal,
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
    cancellationReason: "OpenRouter Responses response was incomplete",
  });
  if (!captured.complete) {
    recordStreamTerminalType(usageContext, "error");
    return openaiError(502, "OpenRouter Responses response was incomplete", "openrouter_upstream_incomplete");
  }
  const payload = parseJsonRecord(captured.bytes);
  if (!payload) {
    recordStreamTerminalType(usageContext, "error");
    return openaiError(502, "OpenRouter returned an unusable body", "openrouter_upstream_invalid_response");
  }
  if (Array.isArray(payload.output) && payload.output.length > 0) markChatSemanticOutput(usageContext);
  await recordCompletionUsage(usageContext, extractUsageTokens(payload.usage));
  recordStreamTerminalType(usageContext, "response.completed");
  return json(200, payload, { "x-uos-upstream": OPENROUTER_UPSTREAM_LABEL });
};

const parseJsonRecord = (bytes: Uint8Array): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
