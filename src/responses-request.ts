// Responses request parsing, validation and upstream body assembly, extracted from src/openai.ts.

import { buildCodexRequest } from "./codex/index.ts";
import { type ReasoningEffort } from "./defaults.ts";
import { openaiError } from "./http.ts";
import { type StreamDeadline } from "./inference-deadline.ts";
import { readJsonBody } from "./request.ts";
import { type RemovedProviderCircuitProbe } from "./provider/removed-provider-circuit.ts";
import { fetchMeteredModels } from "./provider/metered.ts";
import { loadProviderSelectionCached } from "./provider/selection.ts";
import { validateOpenRouterPromptCacheRequestControl } from "./provider/openrouter-request-controls.ts";
import { resolvePaidRoutingState } from "./paid-fallback/health.ts";
import { DEEPSEEK_WATERFALL_PAID_MODEL_ID } from "./deepseek/waterfall.ts";
import { isGatewayFailoverWarningItem } from "./responses-failover-stream.ts";
import { getString, isRecord } from "./utils.ts";
import type { MessageContentItem, ResponseInputItem, ResponsesRequest } from "./types.ts";
import { type ActiveTransitionReason, type RoutedResponsesUpstream, type UsageContext, type MeteredTransportLifecycle } from "./openai-telemetry.ts";
import {
  normalizeFunctionCallOutputItem,
  normalizeModelForCodex,
  normalizeResponseContentItem,
  normalizeResponseMessageItem,
  validatePromptCacheControls,
} from "./input-normalization.ts";
import {
  type CodexModelMetadata,
  type PassthroughToolSchemaKey,
  applyPassthroughToCodexRequest,
  buildIgnoredWarnings,
  getCodexModelMetadata,
  normalizeReasoningParamForCodex,
  parseReasoningParam,
  parseStreamField,
  reasoningEffortForCodexRequest,
  resolveDefaultReasoningLabel,
  resolveReasoningLabelFromParam,
  validateCodexModelAvailable,
} from "./request-policy.ts";
import { type PreparedResponsesAttempt, type ResponsesRouteAttempt } from "./responses-attempts.ts";
import {
  CODEX_RESPONSES_EXTENSION_KEYS,
  RESPONSES_ALLOWED_KEYS,
  defaultModelUnavailableError,
  findUnknownKey,
  getDefaultModel,
  getDefaultReasoningEffort,
  temporaryFreeSurplusCapabilityError,
} from "./openai.ts";

export type ResponsesStep<T> = { ok: true; value: T } | { ok: false; response: Response };

export type ResponsesRequestState = {
  usageContext: UsageContext | undefined;
  rawRecord: Record<string, unknown>;
  warnings: string[];
  clientWantsStream: boolean;
  modelRaw: string;
  model: string;
  modelMetadata: CodexModelMetadata;
  input: ResponseInputItem[];
  reasoningLabel: ReasoningEffort;
  codexBody: Record<string, unknown>;
  removedProviderBody: Record<string, unknown>;
};

export type ResponsesCircuitRoute = Readonly<{
  route: "codex" | "removed_provider";
  probe: RemovedProviderCircuitProbe | null;
}>;

type ResponsesFailureCorrelation = Readonly<{
  provider: string | null;
  accountSlot: number | null;
  accountCohortId: string | null;
  activeGeneration: number | null;
  activeTransitionReason: ActiveTransitionReason;
  providerRequestId: string | null;
}>;

export type ResponsesRoutingState = {
  downstreamSignal: AbortSignal;
  requestInferenceSignal: AbortSignal;
  preHeaderDeadline: StreamDeadline;
  apiKey: string | null;
  paidFallbackAvailable: boolean;
  sessionId: string | null;
  route: "codex" | "removed_provider";
  probe: RemovedProviderCircuitProbe | null;
  primaryFailureResponse: Response | null;
  primaryFailureCorrelation: ResponsesFailureCorrelation | null;
  primaryResult: ResponsesRouteAttempt | null;
  removedProviderAttempt: PreparedResponsesAttempt | null;
  selectedModel: string | null;
  fallbackStartedAt: number;
};

export type ResponsesHandlerState = ResponsesRequestState & ResponsesRoutingState;

type ResponsesInputAccumulator = {
  converted: ResponseInputItem[];
  contentBuffer: MessageContentItem[];
  sawNonContentItem: boolean;
};

export type ResponsesDeliveryState = {
  usageContext: UsageContext | undefined;
  ready: PreparedResponsesAttempt;
  lifecycle: MeteredTransportLifecycle;
  routed: RoutedResponsesUpstream | null;
  clientWantsStream: boolean;
  downstreamSignal: AbortSignal;
  clientWarnings: string[];
  warningModel: string | null;
  selectedModel: string | null;
  probe: RemovedProviderCircuitProbe | null;
  removedProviderAttempt: PreparedResponsesAttempt | null;
  fallbackStartedAt: number;
  providerTerminalValidated: boolean;
  clearProbeRenewal: () => void;
};

export const readResponsesRequest = async (
  req: Request,
  parsedBody?: unknown
): Promise<ResponsesStep<{ rawBody: ResponsesRequest; rawRecord: Record<string, unknown> }>> => {
  const rawBody = (parsedBody === undefined ? await readJsonBody(req) : parsedBody) as ResponsesRequest | null;
  if (!rawBody || !isRecord(rawBody)) return { ok: false, response: openaiError(400, "Invalid JSON body", "invalid_request_error") };
  return { ok: true, value: { rawBody, rawRecord: rawBody as Record<string, unknown> } };
};

export const validateResponsesRequestFields = (
  rawRecord: Record<string, unknown>,
  rawBody: ResponsesRequest,
  providerExtensions?: ReadonlySet<string>
): Response | null => {
  const extensions = providerExtensions ? new Set([...CODEX_RESPONSES_EXTENSION_KEYS, ...providerExtensions]) : CODEX_RESPONSES_EXTENSION_KEYS;
  const unknownKey = findUnknownKey(rawRecord, RESPONSES_ALLOWED_KEYS, extensions);
  if (unknownKey) {
    return openaiError(400, `Unrecognized request argument supplied: ${unknownKey}`, "invalid_request_error");
  }
  if (providerExtensions?.has("cache_control")) {
    const invalidCacheControl = validateOpenRouterPromptCacheRequestControl(rawRecord);
    if (invalidCacheControl) return invalidCacheControl;
  }
  const maxOutputTokens = rawRecord.max_output_tokens;
  if (
    maxOutputTokens !== undefined &&
    maxOutputTokens !== null &&
    (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
  ) {
    return openaiError(400, "max_output_tokens must be a positive integer", "invalid_request_error", {
      param: "max_output_tokens",
    });
  }
  const parallelToolCalls = rawRecord.parallel_tool_calls;
  if (parallelToolCalls !== undefined && typeof parallelToolCalls !== "boolean") {
    return openaiError(400, "parallel_tool_calls must be a boolean", "invalid_request_error", {
      param: "parallel_tool_calls",
    });
  }
  const maxToolCalls = rawRecord.max_tool_calls;
  if (maxToolCalls !== undefined && maxToolCalls !== null && (typeof maxToolCalls !== "number" || !Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0)) {
    return openaiError(400, "max_tool_calls must be a positive integer", "invalid_request_error", {
      param: "max_tool_calls",
    });
  }
  const promptCacheControls = validatePromptCacheControls(rawRecord);
  if (!promptCacheControls.ok) {
    return openaiError(400, promptCacheControls.message, "invalid_request_error", { param: promptCacheControls.param });
  }
  if (Object.prototype.hasOwnProperty.call(rawRecord, "client_metadata")) {
    const clientMetadata = rawBody.client_metadata;
    if (!isRecord(clientMetadata) || Array.isArray(clientMetadata) || Object.values(clientMetadata).some((value) => typeof value !== "string")) {
      return openaiError(400, "client_metadata must be an object with string values", "invalid_request_error", { param: "client_metadata" });
    }
  }
  return null;
};

export const resolveResponsesStreamSettings = (
  rawRecord: Record<string, unknown>,
  rawBody: ResponsesRequest
): ResponsesStep<{ warnings: string[]; clientWantsStream: boolean }> => {
  const warnings = buildIgnoredWarnings(
    rawRecord,
    new Set([
      "model",
      "input",
      "stream",
      "reasoning",
      "instructions",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "max_output_tokens",
      "prompt_cache_key",
      "prompt_cache_options",
      "prompt_cache_retention",
      "text",
      "include",
      "context_management",
      "client_metadata",
    ])
  );

  const parsedStream = parseStreamField(rawBody.stream);
  if (!parsedStream.ok) {
    return { ok: false, response: openaiError(400, parsedStream.message, "invalid_request_error", { param: "stream" }) };
  }
  return { ok: true, value: { warnings, clientWantsStream: parsedStream.value } };
};

export const resolveResponsesModel = async (
  rawRecord: Record<string, unknown>,
  usageContext: UsageContext | undefined,
  options?: Readonly<{
    allowedPaidProviders?: readonly ("metered" | "surplus")[] | null;
    deepSeekWaterfallPaidHop?: "surplus" | "openlux" | null;
  }>
): Promise<ResponsesStep<{ modelRaw: string; model: string; modelMetadata: CodexModelMetadata }>> => {
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
  // The DeepSeek official route is deliberately scoped to /v1/chat/completions.
  // Unlike the Cerebras model, the interchangeable DeepSeek ids are already
  // catalog models that /v1/responses serves through the provider waterfall,
  // and this gateway has no Responses adapter for the official API. Leave that
  // route untouched so existing Responses clients keep working; only the Chat
  // Completions route is redirected to the official provider.
  const modelMetadata = await getCodexModelMetadata(model, "responses");
  // Reuse the paid router's exact verified-hop gate before route availability
  // rejects OpenLux's incomplete catalog. This internal context neither
  // changes the public metadata nor authorizes a paid request by itself.
  const verifiedOpenLuxResponses =
    options?.deepSeekWaterfallPaidHop === "openlux" &&
    model === DEEPSEEK_WATERFALL_PAID_MODEL_ID &&
    resolvePaidRoutingState({
      meteredCatalog: await fetchMeteredModels({ cachedOnly: true }),
      surplusCatalog: null,
      codexModelKnown: false,
      endpointType: "openai-response",
      requestUsesTools: false,
      model,
      selection: await loadProviderSelectionCached(),
      allowedPaidProviders: options.allowedPaidProviders,
      deepSeekWaterfallPaidHop: options.deepSeekWaterfallPaidHop,
    }).paidProviders.includes("metered");
  const modelAvailabilityError = verifiedOpenLuxResponses ? null : validateCodexModelAvailable(modelRaw, "responses", modelMetadata);
  if (modelAvailabilityError) return { ok: false, response: modelAvailabilityError };
  const modelCapabilityError = temporaryFreeSurplusCapabilityError(model, rawRecord);
  if (modelCapabilityError) return { ok: false, response: modelCapabilityError };
  return { ok: true, value: { modelRaw, model, modelMetadata } };
};

const flushResponsesContentBuffer = (accumulator: ResponsesInputAccumulator): void => {
  if (!accumulator.contentBuffer.length) return;
  accumulator.converted.push({ type: "message", role: "user", content: accumulator.contentBuffer });
  accumulator.contentBuffer = [];
};

const appendResponsesMessageEntry = (msg: unknown, param: string, accumulator: ResponsesInputAccumulator): Response | null => {
  const mapped = normalizeResponseMessageItem(msg, param);
  if (!mapped.ok) {
    return openaiError(400, mapped.message, "invalid_request_error", { param: mapped.param });
  }
  flushResponsesContentBuffer(accumulator);
  accumulator.converted.push(mapped.value);
  accumulator.sawNonContentItem = true;
  return null;
};

const appendResponsesTextEntry = (msg: string, accumulator: ResponsesInputAccumulator): void => {
  const contentItem: MessageContentItem = { type: "input_text", text: msg };
  if (accumulator.sawNonContentItem) {
    accumulator.converted.push({ type: "message", role: "user", content: [contentItem] });
  } else {
    accumulator.contentBuffer.push(contentItem);
  }
};

const appendResponsesContentEntry = (msg: unknown, param: string, accumulator: ResponsesInputAccumulator): Response | null => {
  const contentItem = normalizeResponseContentItem(msg, param, "user");
  if (!contentItem.ok) {
    return openaiError(400, contentItem.message, "invalid_request_error", { param: contentItem.param });
  }
  if (accumulator.sawNonContentItem) {
    accumulator.converted.push({ type: "message", role: "user", content: [contentItem.value] });
  } else {
    accumulator.contentBuffer.push(contentItem.value);
  }
  return null;
};

const appendResponsesPassthroughEntry = (
  msg: Record<string, unknown>,
  messageType: string,
  param: string,
  accumulator: ResponsesInputAccumulator
): Response | null => {
  // Content items belong inside a message (or are normalized above).
  // Do not mistake an unsupported input_* content type for an arbitrary
  // Responses item and silently relay it upstream.
  if (messageType.startsWith("input_") || messageType === "text" || messageType === "image_url" || messageType === "output_text") {
    return openaiError(400, `${param}.type is not supported`, "invalid_request_error", {
      param: `${param}.type`,
    });
  }
  flushResponsesContentBuffer(accumulator);
  const normalizedFunctionOutput = normalizeFunctionCallOutputItem(msg, param);
  if (!normalizedFunctionOutput.ok) {
    return openaiError(400, normalizedFunctionOutput.message, "invalid_request_error", {
      param: normalizedFunctionOutput.param,
    });
  }
  accumulator.converted.push(normalizedFunctionOutput.value);
  accumulator.sawNonContentItem = true;
  return null;
};

const appendResponsesInputEntry = (msg: unknown, param: string, accumulator: ResponsesInputAccumulator): Response | null => {
  const messageType = isRecord(msg) && !Array.isArray(msg) ? getString(msg.type) : null;
  if (messageType === "message" || (messageType === null && isRecord(msg) && "role" in msg)) {
    // A turn replayed from a failover response carries this gateway's own
    // notice. Sending it upstream would feed the provider text the model never
    // wrote and the user never typed.
    if (isGatewayFailoverWarningItem(msg)) return null;
    return appendResponsesMessageEntry(msg, param, accumulator);
  }

  if (typeof msg === "string") {
    appendResponsesTextEntry(msg, accumulator);
    return null;
  }

  if (messageType === "input_text" || messageType === "input_image" || messageType === "input_file") {
    return appendResponsesContentEntry(msg, param, accumulator);
  }

  if (isRecord(msg) && !Array.isArray(msg) && Object.prototype.hasOwnProperty.call(msg, "prompt_cache_breakpoint")) {
    return openaiError(400, "prompt_cache_breakpoint is only valid on supported input content blocks", "invalid_request_error", {
      param: `${param}.prompt_cache_breakpoint`,
    });
  }

  // Codex CLI uses the Responses API and can send additional input item types
  // (e.g. reasoning + function_call + function_call_output). Pass them through
  // so tool-calling conversations work end-to-end.
  if (isRecord(msg) && typeof msg.type === "string" && msg.type !== "message") {
    return appendResponsesPassthroughEntry(msg, msg.type, param, accumulator);
  }

  return openaiError(400, "Invalid message in input[]", "invalid_request_error", { param });
};

export const normalizeResponsesInput = (inputRaw: unknown): ResponsesStep<ResponseInputItem[]> => {
  if (inputRaw === undefined) {
    return { ok: true, value: [] };
  }
  if (typeof inputRaw === "string") {
    return { ok: true, value: [{ type: "message", role: "user", content: [{ type: "input_text", text: inputRaw }] }] };
  }
  if (!Array.isArray(inputRaw)) {
    return { ok: false, response: openaiError(400, "input must be a string or an array", "invalid_request_error") };
  }

  const accumulator: ResponsesInputAccumulator = { converted: [], contentBuffer: [], sawNonContentItem: false };
  for (const [index, msg] of inputRaw.entries()) {
    const entryError = appendResponsesInputEntry(msg, `input[${index}]`, accumulator);
    if (entryError) return { ok: false, response: entryError };
  }
  if (!accumulator.sawNonContentItem || accumulator.contentBuffer.length) {
    flushResponsesContentBuffer(accumulator);
  }
  return { ok: true, value: accumulator.converted };
};

export const resolveResponsesReasoning = async (
  rawRecord: Record<string, unknown>,
  rawBody: ResponsesRequest,
  modelMetadata: CodexModelMetadata,
  usageContext: UsageContext | undefined
): Promise<ResponsesStep<{ reasoningLabel: ReasoningEffort; instructions: string | undefined; reasoning: Record<string, unknown> | undefined }>> => {
  const reasoning = parseReasoningParam(rawBody.reasoning);
  if (!reasoning.ok) return { ok: false, response: openaiError(400, reasoning.message, "invalid_request_error", { param: "reasoning" }) };

  let instructions: string | undefined;
  if (Object.prototype.hasOwnProperty.call(rawRecord, "instructions")) {
    if (rawBody.instructions === null) {
      instructions = undefined;
    } else if (typeof rawBody.instructions === "string") {
      instructions = rawBody.instructions;
    } else {
      return { ok: false, response: openaiError(400, "instructions must be a string", "invalid_request_error") };
    }
  }
  const defaultEffort = await getDefaultReasoningEffort();
  const modelReasoning = modelMetadata.reasoning;
  const defaultReasoningLabel = resolveDefaultReasoningLabel(modelReasoning, defaultEffort);
  const reasoningLabel = resolveReasoningLabelFromParam(reasoning.value, defaultReasoningLabel);
  if (usageContext?.responseTelemetry) usageContext.responseTelemetry.reasoning = reasoningLabel;

  let reasoningValue = normalizeReasoningParamForCodex(reasoning.value, modelReasoning);
  if (reasoningValue === undefined && reasoning.value === undefined) {
    reasoningValue = { effort: reasoningEffortForCodexRequest(defaultReasoningLabel, modelReasoning) };
  }
  return { ok: true, value: { reasoningLabel, instructions, reasoning: reasoningValue } };
};

export const buildResponsesUpstreamBodies = (
  model: string,
  input: ResponseInputItem[],
  instructions: string | undefined,
  reasoning: Record<string, unknown> | undefined,
  rawRecord: Record<string, unknown>
): { codexBody: Record<string, unknown>; removedProviderBody: Record<string, unknown> } => {
  const codexBody = buildCodexRequest(model, input, { reasoning, instructions });
  if (Object.prototype.hasOwnProperty.call(rawRecord, "max_output_tokens")) {
    codexBody.max_output_tokens = rawRecord.max_output_tokens;
  }
  const passthroughKeys: PassthroughToolSchemaKey[] = [
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
    "text",
    "include",
    "context_management",
  ];
  applyPassthroughToCodexRequest(codexBody, rawRecord, passthroughKeys);
  codexBody.model = model;
  codexBody.stream = true;
  codexBody.store = false;
  // The Codex body keeps the repaired replay; the removed-provider fallback
  // gets the client's exact input back, including the gateway's own item ids.
  const removedProviderBody: Record<string, unknown> = { ...codexBody, input };
  // Preserve official controls supported by RemovedProvider even when Codex does
  // not currently accept them on its compatibility transport.
  for (const key of ["max_output_tokens", "max_tool_calls", "metadata", "safety_identifier", "service_tier", "temperature", "top_p", "truncation", "user"]) {
    if (Object.prototype.hasOwnProperty.call(rawRecord, key)) removedProviderBody[key] = rawRecord[key];
  }
  return { codexBody, removedProviderBody };
};
