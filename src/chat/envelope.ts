// Chat Completions envelope, dispatch and handler, extracted from src/openai.ts.

import { handleDeepSeekChatCompletions } from "../deepseek/handlers.ts";
import { handleLithosChatCompletions } from "../provider/lithos-handlers.ts";
import { handleCerebrasChatCompletions } from "../provider/cerebras-handlers.ts";
import { buildCodexRequest, markCodexResponseCompleted, markCodexResponseUpstreamError, releaseCodexResponseProbe } from "../codex/index.ts";
import { cerebrasUpstreamModelFor } from "../provider/cerebras.ts";
import { deepSeekUpstreamModelFor } from "../deepseek/index.ts";
import { lithosUpstreamModelFor } from "../provider/lithos.ts";
import { resolveOpenRouterUpstreamModel } from "../provider/openrouter.ts";
import { handleOpenRouterChatCompletions } from "../provider/openrouter-handlers.ts";
import { openRouterPromptCacheRequestExtensions, validateOpenRouterPromptCacheRequestControl } from "../provider/openrouter-request-controls.ts";
import { isProviderEnabled, loadProviderSelectionCached, type ProviderSelection } from "../provider/selection.ts";
import { type ReasoningEffort } from "../defaults.ts";
import { openaiError } from "../http.ts";
import { createStreamFirstEventDeadline } from "../inference-deadline.ts";
import { readJsonBody } from "../request.ts";
import { type PreflightedResponsesStream, preflightResponsesStream, type ResponsesStreamIterator } from "../responses-stream.ts";
import { type PreparedResponsesStream, prepareResponsesStreamForCommit } from "../responses-failover-stream.ts";
import { getString, isRecord } from "../utils.ts";
import type { ChatCompletionRequest, MessageContentItem, ResponseInputItem } from "../types.ts";
import {
  type ResponseStreamTerminalType,
  type RoutedResponsesUpstream,
  type UpstreamProvider,
  type UsageContext,
  type UsageTokens,
  attachResponseTelemetry,
  classifyPreHeaderFailure,
  classifyStreamFailure,
  countExplicitPromptCacheBreakpoints,
  createResponseTelemetryState,
  extractUsageTokens,
  promptCacheKeyPresent,
  promptCacheModeFor,
  recordErrorUsage,
  recordFirstSemanticCommitment,
  recordFirstUpstreamSseEvent,
  recordRequestUsage,
  recordResponsesEventTelemetry,
  recordResponsesFailureTelemetry,
  recordStreamTerminalType,
  recordTerminalUsage,
  runWithResponseTelemetry,
  streamErrorResponse,
  streamPreflightFailureResponse,
  supportsReasoningProgressRelease,
  type MeteredTransportLifecycle,
} from "../openai-telemetry.ts";
import { normalizeChatMessage, normalizeModelForCodex, validatePromptCacheControls } from "../input-normalization.ts";
import {
  EMPTY_UPSTREAM_COMPLETION_MESSAGE,
  chatSourceFromPrepared,
  preparedChatCompletionIsEmpty,
  recordEmptyUpstreamCompletion,
} from "./stream-translation.ts";
import { logRedactedUpstreamError, toOpenAiUpstreamErrorResponse, toPreHeaderErrorResponse } from "../upstream-wire.ts";
import {
  type CodexModelMetadata,
  type CodexModelReasoning,
  type PassthroughToolSchemaKey,
  applyPassthroughToCodexRequest,
  buildIgnoredWarnings,
  getCodexModelMetadata,
  parseChatStreamOptions,
  parseMaxCompletionTokensField,
  parseReasoningEffortField,
  parseStreamField,
  reasoningEffortForCodexRequest,
  resolveDefaultReasoningLabel,
  resolveReasoningLabelFromEffort,
  responseWarnings,
  validateCodexModelAvailable,
  validateKnownUnsupportedPromptCacheUse,
  withUosWarning,
} from "../request-policy.ts";
import { createMeteredTransportLifecycle } from "../paid-fallback/health.ts";
import { fetchResponsesWithPaidFallback } from "../paid-fallback/routing.ts";
import { completeChatCompletions, streamChatCompletions } from "./completions.ts";
import {
  CHAT_COMPLETIONS_ALLOWED_KEYS,
  DEEPSEEK_CHAT_EXTENSION_KEYS,
  defaultModelUnavailableError,
  downstreamSignalFor,
  findUnknownKey,
  getDefaultModel,
  getDefaultReasoningEffort,
  inferenceSignal,
  temporaryFreeSurplusCapabilityError,
} from "../openai.ts";

const parseChatCompletionsEnvelope = async (
  req: Request
): Promise<
  | {
      ok: true;
      value: {
        body: ChatCompletionRequest;
        rawRecord: Record<string, unknown>;
        warnings: string[];
        jsonObjectTextFormat: { type: "json_object" } | null;
        selection: ProviderSelection | null;
      };
    }
  | { ok: false; response: Response }
> => {
  const body = (await readJsonBody(req)) as ChatCompletionRequest | null;
  if (!body || !isRecord(body)) return { ok: false, response: openaiError(400, "Invalid JSON body", "invalid_request_error") };

  const rawRecord = body as Record<string, unknown>;
  // The enabled DeepSeek route dispatches before the Codex/paid path and speaks the
  // provider's own documented Chat contract, which includes `thinking`. Accept
  // that one field there so a first-party DeepSeek client can reach this route
  // at all; every other route keeps the strict OpenAI allowlist. The field is
  // read for its documented semantics (it selects thinking mode) and is not
  // forwarded verbatim: `projectDeepSeekRequest` owns the wire translation.
  const selection = await loadProviderSelectionCached();
  const isDeepSeekRoute = isProviderEnabled("deepseek", selection) && deepSeekUpstreamModelFor(getString(rawRecord.model)?.trim() ?? "") !== null;
  const providerExtensions = isDeepSeekRoute ? DEEPSEEK_CHAT_EXTENSION_KEYS : await openRouterPromptCacheRequestExtensions(rawRecord);
  const unknownKey = findUnknownKey(rawRecord, CHAT_COMPLETIONS_ALLOWED_KEYS, providerExtensions);
  if (unknownKey) {
    return { ok: false, response: openaiError(400, `Unrecognized request argument supplied: ${unknownKey}`, "invalid_request_error") };
  }
  if (providerExtensions?.has("cache_control")) {
    const invalidCacheControl = validateOpenRouterPromptCacheRequestControl(rawRecord);
    if (invalidCacheControl) return { ok: false, response: invalidCacheControl };
  }
  const promptCacheControls = validatePromptCacheControls(rawRecord);
  if (!promptCacheControls.ok) {
    return { ok: false, response: openaiError(400, promptCacheControls.message, "invalid_request_error", { param: promptCacheControls.param }) };
  }
  const jsonObjectTextFormat =
    isRecord(rawRecord.response_format) && Object.keys(rawRecord.response_format).length === 1 && rawRecord.response_format.type === "json_object"
      ? { type: "json_object" as const }
      : null;
  const handledKeys = new Set([
    "messages",
    "model",
    "stream",
    "reasoning_effort",
    "max_completion_tokens",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
    "stream_options",
  ]);
  if (jsonObjectTextFormat) handledKeys.add("response_format");
  const warnings = buildIgnoredWarnings(rawRecord, handledKeys);
  return { ok: true, value: { body, rawRecord, warnings, jsonObjectTextFormat, selection } };
};

const resolveChatCompletionsModel = async (
  rawRecord: Record<string, unknown>,
  usageContext: UsageContext | undefined
): Promise<{ ok: true; value: { modelRaw: string; model: string; maxCompletionTokens: number | undefined } } | { ok: false; response: Response }> => {
  const hasModel = Object.prototype.hasOwnProperty.call(rawRecord, "model");
  const rawModelValue = rawRecord.model;
  const modelRawValue = getString(rawModelValue);
  if (hasModel && modelRawValue === null && rawModelValue !== null && rawModelValue !== undefined) {
    return { ok: false, response: openaiError(400, "model must be a string", "invalid_request_error") };
  }
  let modelRaw = (modelRawValue ?? "").trim();
  if (!modelRaw) {
    const defaultModel = await getDefaultModel();
    if (!defaultModel) return { ok: false, response: defaultModelUnavailableError() };
    modelRaw = defaultModel;
  }
  const model = normalizeModelForCodex(modelRaw);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.model = modelRaw;
  const maxCompletionTokens = parseMaxCompletionTokensField(rawRecord.max_completion_tokens);
  if (!maxCompletionTokens.ok) {
    return { ok: false, response: openaiError(400, maxCompletionTokens.message, "invalid_request_error", { param: "max_completion_tokens" }) };
  }
  return { ok: true, value: { modelRaw, model, maxCompletionTokens: maxCompletionTokens.value } };
};

const validateChatCompletionsOptions = async (
  model: string,
  modelRaw: string,
  rawRecord: Record<string, unknown>,
  body: ChatCompletionRequest
): Promise<
  | {
      ok: true;
      value: {
        modelMetadata: CodexModelMetadata;
        messagesRaw: readonly unknown[];
        reasoningEffort: ReasoningEffort | undefined;
        stream: boolean;
        includeUsage: boolean;
      };
    }
  | { ok: false; response: Response }
> => {
  const modelMetadata = await getCodexModelMetadata(model, "chat.completions");
  const modelAvailabilityError = validateCodexModelAvailable(modelRaw, "chat.completions", modelMetadata);
  if (modelAvailabilityError) return { ok: false, response: modelAvailabilityError };
  const modelCapabilityError = temporaryFreeSurplusCapabilityError(model, rawRecord);
  if (modelCapabilityError) return { ok: false, response: modelCapabilityError };
  const messagesRaw = body.messages;
  if (!Array.isArray(messagesRaw)) return { ok: false, response: openaiError(400, "messages must be an array", "invalid_request_error") };
  if (messagesRaw.length === 0) return { ok: false, response: openaiError(400, "messages must be a non-empty array", "invalid_request_error") };

  const reasoningEffort = parseReasoningEffortField(body.reasoning_effort, "reasoning_effort");
  if (!reasoningEffort.ok) {
    return { ok: false, response: openaiError(400, reasoningEffort.message, "invalid_request_error", { param: "reasoning_effort" }) };
  }

  const parsedStream = parseStreamField(body.stream);
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
      modelMetadata,
      messagesRaw,
      reasoningEffort: reasoningEffort.value,
      stream: parsedStream.value,
      includeUsage: streamOptions.includeUsage,
    },
  };
};

const normalizeChatCompletionsInput = (
  messagesRaw: readonly unknown[],
  modelRaw: string,
  modelMetadata: CodexModelMetadata,
  rawRecord: Record<string, unknown>
): { ok: true; value: { input: ResponseInputItem[]; instructions: string | undefined } } | { ok: false; response: Response } => {
  const normalizedMessages: Readonly<{
    instruction: string | null;
    instructionContent: MessageContentItem[] | null;
    input: ResponseInputItem[];
  }>[] = [];
  for (const [index, msg] of messagesRaw.entries()) {
    const converted = normalizeChatMessage(msg, index);
    if (!converted.ok) {
      return { ok: false, response: openaiError(400, converted.message, "invalid_request_error", { param: converted.param }) };
    }
    normalizedMessages.push(converted.value);
  }
  const preserveDeveloperMessages = normalizedMessages.some(
    (message) => message.instructionContent?.some((item) => item.type !== "output_text" && item.prompt_cache_breakpoint?.mode === "explicit") === true
  );
  const input: ResponseInputItem[] = [];
  const instructionParts: string[] = [];
  for (const message of normalizedMessages) {
    if (preserveDeveloperMessages && message.instructionContent !== null) {
      input.push({ type: "message", role: "developer", content: message.instructionContent });
    } else if (message.instruction?.trim()) {
      instructionParts.push(message.instruction.trim());
    }
    input.push(...message.input);
  }

  if (input.length === 0) {
    // Ensure upstream receives a non-empty input for system-only chats.
    input.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "" }],
    });
  }

  const instructions = preserveDeveloperMessages ? undefined : instructionParts.join("\n\n").trim();
  const promptCacheAvailabilityError = validateKnownUnsupportedPromptCacheUse(modelRaw, modelMetadata, rawRecord, input, "messages");
  if (promptCacheAvailabilityError) return { ok: false, response: promptCacheAvailabilityError };
  return { ok: true, value: { input, instructions } };
};

const buildChatCompletionsCodexBody = async (
  model: string,
  input: ResponseInputItem[],
  options: Readonly<{
    instructions: string | undefined;
    reasoningEffort: ReasoningEffort | undefined;
    modelReasoning: CodexModelReasoning;
    jsonObjectTextFormat: { type: "json_object" } | null;
    maxCompletionTokens: number | undefined;
    rawRecord: Record<string, unknown>;
  }>
): Promise<{ codexBody: Record<string, unknown>; defaultReasoningLabel: ReasoningEffort }> => {
  const defaultEffort = await getDefaultReasoningEffort();
  const modelReasoning = options.modelReasoning;
  const defaultReasoningLabel = resolveDefaultReasoningLabel(modelReasoning, defaultEffort);
  let reasoningValue: Record<string, unknown> | undefined;
  if (options.reasoningEffort === undefined) {
    reasoningValue = { effort: reasoningEffortForCodexRequest(defaultReasoningLabel, modelReasoning) };
  } else {
    reasoningValue = { effort: reasoningEffortForCodexRequest(options.reasoningEffort, modelReasoning) };
  }
  const codexBody = buildCodexRequest(model, input, {
    reasoning: reasoningValue,
    instructions: options.instructions,
  });
  if (options.jsonObjectTextFormat) codexBody.text = { format: options.jsonObjectTextFormat };
  if (options.maxCompletionTokens !== undefined) codexBody.max_output_tokens = options.maxCompletionTokens;
  const passthroughKeys: PassthroughToolSchemaKey[] = [
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
  ];
  applyPassthroughToCodexRequest(codexBody, options.rawRecord, passthroughKeys);
  codexBody.store = false;
  return { codexBody, defaultReasoningLabel };
};

const completedTerminalUsageOf = (prepared: PreparedResponsesStream): UsageTokens | null =>
  prepared.terminal?.type === "response.completed" && isRecord(prepared.terminal.value.response)
    ? extractUsageTokens(prepared.terminal.value.response.usage)
    : null;

const chatCompletionPreflightIsEmpty = (
  prepared: PreparedResponsesStream,
  completedTerminalUsage: UsageTokens | null,
  usageContext: UsageContext | undefined
): boolean => {
  if (prepared.terminal?.type !== "response.completed" || prepared.semantic !== null) return false;
  try {
    return preparedChatCompletionIsEmpty(prepared);
  } catch (error) {
    recordTerminalUsage(usageContext, completedTerminalUsage, false);
    throw error;
  }
};

const rejectEmptyChatCompletion = async (
  prepared: PreparedResponsesStream,
  completedTerminalUsage: UsageTokens | null,
  usageContext: UsageContext | undefined,
  lifecycle: MeteredTransportLifecycle,
  resolveCodexProbe: (terminalType: ResponseStreamTerminalType) => void,
  provider: UpstreamProvider,
  warnings: string[]
): Promise<Response> => {
  for (const event of prepared.buffered) recordResponsesEventTelemetry(usageContext, event);
  recordEmptyUpstreamCompletion(usageContext, lifecycle, completedTerminalUsage, resolveCodexProbe);
  await prepared.iterator.return("Empty Chat completion rejected").catch(() => {});
  return streamErrorResponse(502, EMPTY_UPSTREAM_COMPLETION_MESSAGE, "empty_upstream_completion", provider, warnings, "server_error", null);
};

const respondChatCompletionsDispatchFailure = async (
  error: unknown,
  requestInferenceSignal: AbortSignal,
  downstreamSignal: AbortSignal,
  usageContext: UsageContext | undefined
): Promise<Response> => {
  const terminalType = classifyPreHeaderFailure(error, requestInferenceSignal, downstreamSignal);
  recordStreamTerminalType(usageContext, terminalType);
  if (terminalType !== "cancelled") {
    logRedactedUpstreamError("[ai.ubq.fi] Upstream fetch failed:", error);
  }
  await recordErrorUsage(usageContext);
  return toPreHeaderErrorResponse(error, terminalType, usageContext?.responseTelemetry?.provider);
};

const respondChatCompletionsUpstreamHttpFailure = async (
  upstream: Response,
  options: Readonly<{
    provider: UpstreamProvider;
    requestInferenceSignal: AbortSignal;
    usageContext: UsageContext | undefined;
    lifecycle: MeteredTransportLifecycle;
    clearStreamFirstEventDeadline: () => void;
  }>
): Promise<Response> => {
  options.lifecycle.terminal("response.failed");
  recordStreamTerminalType(options.usageContext, "response.failed");
  await recordErrorUsage(options.usageContext);
  try {
    const normalized = await toOpenAiUpstreamErrorResponse(upstream, options.provider, options.requestInferenceSignal);
    return attachResponseTelemetry(normalized, options.usageContext?.responseTelemetry ?? createResponseTelemetryState());
  } finally {
    options.clearStreamFirstEventDeadline();
  }
};

const respondChatCompletionsPreflightFailure = async (
  error: unknown,
  options: Readonly<{
    requestInferenceSignal: AbortSignal;
    downstreamSignal: AbortSignal;
    usageContext: UsageContext | undefined;
    provider: UpstreamProvider;
    lifecycle: MeteredTransportLifecycle;
    warnings: string[];
    resolveCodexProbe: (terminalType: ResponseStreamTerminalType) => void;
    clearStreamFirstEventDeadline: () => void;
  }>
): Promise<Response> => {
  options.clearStreamFirstEventDeadline();
  const terminalType = classifyStreamFailure(error, options.requestInferenceSignal, options.downstreamSignal);
  options.resolveCodexProbe(terminalType);
  recordStreamTerminalType(options.usageContext, terminalType);
  if (terminalType !== "cancelled") recordResponsesFailureTelemetry(options.usageContext, error);
  if (terminalType === "cancelled") options.lifecycle.cancelled();
  else options.lifecycle.ambiguous();
  await recordErrorUsage(options.usageContext);
  return streamPreflightFailureResponse(terminalType, options.provider, options.warnings);
};

const dispatchAndPreflightChatCompletions = async (
  codexBody: Record<string, unknown>,
  options: Readonly<{
    req: Request;
    model: string;
    clientVersion: string | null | undefined;
    stream: boolean;
    reasoningLabel: ReasoningEffort;
    warnings: string[];
    usageContext: UsageContext | undefined;
    downstreamSignal: AbortSignal;
  }>
): Promise<
  | {
      ok: true;
      value: {
        preflight: PreflightedResponsesStream;
        provider: UpstreamProvider;
        lifecycle: MeteredTransportLifecycle;
        signal: AbortSignal;
        resolveCodexProbe: (terminalType: ResponseStreamTerminalType) => void;
        combinedWarnings: string[];
      };
    }
  | { ok: false; response: Response }
> => {
  const downstreamSignal = options.downstreamSignal;
  const usageContext = options.usageContext;
  // One timer covers both provider dispatch/headers and the first SSE event.
  // It is cleared immediately after preflight so active streams get their own
  // renewable inactivity deadline rather than an absolute buffered cutoff.
  const streamFirstEventDeadline = options.stream ? createStreamFirstEventDeadline(downstreamSignal) : null;
  const requestInferenceSignal = streamFirstEventDeadline?.signal ?? inferenceSignal(options.req, usageContext);
  const clearStreamFirstEventDeadline = (): void => streamFirstEventDeadline?.clear();

  let routed: RoutedResponsesUpstream;
  try {
    routed = await fetchResponsesWithPaidFallback(codexBody, {
      model: options.model,
      route: "chat.completions",
      stream: options.stream,
      reasoning: options.reasoningLabel,
      usageContext,
      clientVersion: options.clientVersion,
      signal: requestInferenceSignal,
    });
  } catch (error) {
    clearStreamFirstEventDeadline();
    return { ok: false, response: await respondChatCompletionsDispatchFailure(error, requestInferenceSignal, downstreamSignal, usageContext) };
  }
  const upstream = routed.response;
  const provider = routed.provider;
  const providerWarnings = responseWarnings(upstream);
  const combinedWarnings = [...options.warnings, ...providerWarnings];
  const lifecycle = createMeteredTransportLifecycle(
    routed.paidFallback,
    provider,
    routed.paidFallbackProviderRequestId ?? null,
    routed.paidFallbackBilling ?? null,
    options.model,
    routed.providerHealthOnly === true
  );
  let codexTerminalResolved = false;
  const resolveCodexProbe = (terminalType: ResponseStreamTerminalType): void => {
    if (routed.provider !== "chatgpt_codex" || codexTerminalResolved) return;
    codexTerminalResolved = true;
    let transition: Promise<void>;
    if (terminalType === "response.completed") {
      transition = markCodexResponseCompleted(upstream);
    } else if (terminalType === "response.failed" || terminalType === "error" || terminalType === "eof" || terminalType === "deadline") {
      transition = markCodexResponseUpstreamError(upstream);
    } else {
      transition = releaseCodexResponseProbe(upstream);
    }
    void transition.catch(() => {});
  };

  if (routed.gatewayResponse) {
    clearStreamFirstEventDeadline();
    recordStreamTerminalType(usageContext, upstream.status === 504 ? "deadline" : "error");
    await recordErrorUsage(usageContext);
    return { ok: false, response: upstream };
  }
  if (!upstream.ok) {
    return {
      ok: false,
      response: await respondChatCompletionsUpstreamHttpFailure(upstream, {
        provider,
        requestInferenceSignal,
        usageContext,
        lifecycle,
        clearStreamFirstEventDeadline,
      }),
    };
  }

  if (!upstream.body) {
    clearStreamFirstEventDeadline();
    resolveCodexProbe("error");
    lifecycle.ambiguous();
    recordStreamTerminalType(usageContext, "error");
    await recordErrorUsage(usageContext);
    return {
      ok: false,
      response: streamErrorResponse(502, "Codex upstream response missing body.", "codex_upstream_missing_body", provider, combinedWarnings),
    };
  }

  let preflight: PreflightedResponsesStream;
  try {
    const firstEvent = await preflightResponsesStream(upstream.body, requestInferenceSignal, {});
    recordFirstUpstreamSseEvent(usageContext);
    const replay = (async function* (): ResponsesStreamIterator {
      try {
        yield firstEvent.first;
        for await (const event of firstEvent.iterator) yield event;
        return undefined;
      } finally {
        await firstEvent.iterator.return("Chat semantic preflight closed").catch(() => {});
      }
    })();
    const prepared = await prepareResponsesStreamForCommit(replay, {
      releaseOnProgress: options.stream && supportsReasoningProgressRelease(provider),
    });
    clearStreamFirstEventDeadline();
    const completedTerminalUsage = completedTerminalUsageOf(prepared);
    if (chatCompletionPreflightIsEmpty(prepared, completedTerminalUsage, usageContext)) {
      return {
        ok: false,
        response: await rejectEmptyChatCompletion(prepared, completedTerminalUsage, usageContext, lifecycle, resolveCodexProbe, provider, combinedWarnings),
      };
    }
    preflight = chatSourceFromPrepared(firstEvent, prepared);
  } catch (error) {
    return {
      ok: false,
      response: await respondChatCompletionsPreflightFailure(error, {
        requestInferenceSignal,
        downstreamSignal,
        usageContext,
        provider,
        lifecycle,
        warnings: combinedWarnings,
        resolveCodexProbe,
        clearStreamFirstEventDeadline,
      }),
    };
  }
  return { ok: true, value: { preflight, provider, lifecycle, signal: requestInferenceSignal, resolveCodexProbe, combinedWarnings } };
};

export const handleChatCompletionsInternal = async (req: Request, usageContext?: UsageContext): Promise<Response> => {
  const envelope = await parseChatCompletionsEnvelope(req);
  if (!envelope.ok) return envelope.response;
  const { body, rawRecord, warnings, jsonObjectTextFormat, selection } = envelope.value;

  const modelChoice = await resolveChatCompletionsModel(rawRecord, usageContext);
  if (!modelChoice.ok) return modelChoice.response;
  const { modelRaw, model, maxCompletionTokens } = modelChoice.value;

  // A switched-off direct provider is not dispatched to; those ids then follow
  // the ordinary Codex/paid waterfall like any other catalog model.
  const cerebrasModel = cerebrasUpstreamModelFor(model);
  if (isProviderEnabled("cerebras", selection) && cerebrasModel) {
    return await handleCerebrasChatCompletions(req, rawRecord, modelRaw, usageContext, cerebrasModel);
  }
  if (isProviderEnabled("deepseek", selection) && deepSeekUpstreamModelFor(model)) {
    return await handleDeepSeekChatCompletions(req, rawRecord, modelRaw, usageContext);
  }
  if (isProviderEnabled("lithos", selection) && lithosUpstreamModelFor(model)) {
    return await handleLithosChatCompletions(req, rawRecord, modelRaw, usageContext);
  }
  if (isProviderEnabled("openrouter", selection) && (await resolveOpenRouterUpstreamModel(model))) {
    return await handleOpenRouterChatCompletions(req, rawRecord, model, usageContext);
  }

  const options = await validateChatCompletionsOptions(model, modelRaw, rawRecord, body);
  if (!options.ok) return options.response;
  const { modelMetadata, messagesRaw, reasoningEffort, stream, includeUsage } = options.value;

  const preparedInput = normalizeChatCompletionsInput(messagesRaw, modelRaw, modelMetadata, rawRecord);
  if (!preparedInput.ok) return preparedInput.response;
  const { input, instructions } = preparedInput.value;

  const built = await buildChatCompletionsCodexBody(model, input, {
    instructions,
    reasoningEffort,
    modelReasoning: modelMetadata.reasoning,
    jsonObjectTextFormat,
    maxCompletionTokens,
    rawRecord,
  });
  const codexBody = built.codexBody;

  const reasoningLabel = resolveReasoningLabelFromEffort(reasoningEffort, built.defaultReasoningLabel);
  if (usageContext?.responseTelemetry) {
    usageContext.responseTelemetry.reasoning = reasoningLabel;
    usageContext.responseTelemetry.outputTokenAllowance = maxCompletionTokens ?? null;
    usageContext.responseTelemetry.semanticOutputObserved = false;
  }
  await recordRequestUsage(usageContext, {
    model: modelRaw,
    route: "chat.completions",
    stream,
    reasoning: reasoningLabel,
    promptCacheKeyPresent: promptCacheKeyPresent(rawRecord),
    promptCacheMode: promptCacheModeFor(rawRecord),
    explicitBreakpointCount: countExplicitPromptCacheBreakpoints(input),
  });
  const downstreamSignal = downstreamSignalFor(req, usageContext);
  const dispatched = await dispatchAndPreflightChatCompletions(codexBody, {
    req,
    model,
    clientVersion: modelMetadata.snapshot?.client_version,
    stream,
    reasoningLabel,
    warnings,
    usageContext,
    downstreamSignal,
  });
  if (!dispatched.ok) return dispatched.response;
  const { preflight, provider, lifecycle, signal, resolveCodexProbe, combinedWarnings } = dispatched.value;

  recordFirstSemanticCommitment(usageContext);
  const response = stream
    ? streamChatCompletions(preflight, model, includeUsage, usageContext, provider, lifecycle, signal, downstreamSignal, resolveCodexProbe)
    : await completeChatCompletions(preflight, model, usageContext, provider, lifecycle, signal, downstreamSignal, combinedWarnings, resolveCodexProbe);
  return withUosWarning(response, combinedWarnings);
};

export const handleChatCompletions = async (req: Request, usageContext?: UsageContext): Promise<Response> =>
  await runWithResponseTelemetry(usageContext, (context) => handleChatCompletionsInternal(req, context));
