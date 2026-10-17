/**
 * Cerebras/Harmony protocol adapter (plan m01).
 *
 * Builds bounded Chat Completions requests for `gpt-oss-120b` in two styles:
 *
 * - `generic`: the existing gateway shape (`tools` parameter, top-level
 *   `reasoning_effort`, optional `response_format`); the provider translates
 *   tool schemas and Harmony output itself.
 * - `native`: an explicit Harmony contract — identity/meta/reasoning render
 *   into the system message, tool schemas render as Harmony TypeScript-like
 *   types in the developer message, no `tools`/`response_format` fields.
 *
 * The adapter normalizes every exposed tool to one strictness value
 * (Cerebras rejects mixed values on a single request), never echoes private
 * analysis back upstream, and normalizes provider responses into the shared
 * Harmony turn model.  Transport is injected so focused tests stay
 * deterministic and offline.
 */

import { CEREBRAS_GPT_OSS_120B_MODEL, fetchCerebrasChatCompletions, projectCerebrasRequest, type CerebrasFetch } from "../provider/cerebras.ts";
import { isRecord } from "../utils.ts";
import { wireMessagesFromConversation } from "./conversation.ts";
import { normalizeToolArguments, parseHarmonyOutput } from "./parse.ts";
import { renderDeveloperMessage, renderSystemMessage } from "./render.ts";
import {
  type AssistantResponseShape,
  type CombinationPolicy,
  type ConversationTurn,
  HarmonyAdapterError,
  type HarmonyCallStyle,
  type HarmonyReasoningEffort,
  type HarmonyTurn,
  type NativeResponseFormat,
  type NormalizedAssistantResponse,
  type ResponseFormatParam,
  type ToolCall,
  type ToolDefinition,
  type ToolStrictnessMode,
} from "./types.ts";

export type HarmonyRequestOptions = Readonly<{
  style: HarmonyCallStyle;
  /** Full conversation (system/developer turns are dropped in native style). */
  turns: readonly ConversationTurn[];
  reasoningEffort?: HarmonyReasoningEffort;
  tools?: readonly ToolDefinition[];
  /** Default: `normalize-false` (Cerebras requires one value per request). */
  toolStrictnessMode?: ToolStrictnessMode;
  /** Generic style only. */
  responseFormat?: ResponseFormatParam;
  /** Native style only. */
  nativeResponseFormat?: NativeResponseFormat;
  /** Native style only: how tool results are replayed. */
  nativeToolResultStyle?: "tool-role" | "user-role";
  /** `error` (default) blocks tools+structured combinations until a probe proves them. */
  combinationPolicy?: CombinationPolicy;
  maxCompletionTokens?: number;
  /** Generic style only. */
  parallelToolCalls?: boolean;
  currentDate?: string;
  instructions?: string;
  namespace?: string;
}>;

export type BuiltHarmonyRequest = Readonly<{
  style: HarmonyCallStyle;
  body: Record<string, unknown>;
  metadata: Readonly<{
    model: string;
    /** Roles after the provider projection, matching the dispatched body. */
    messageRoles: readonly string[];
    toolsRendered: "parameter" | "developer" | "none";
    toolEntries: readonly { name: string; strict: boolean }[];
    toolStrictnessValues: readonly boolean[];
    reasoningEffortTopLevel: HarmonyReasoningEffort | null;
    reasoningEffortInSystem: boolean;
    responseFormat: "json_object" | "json_schema" | "developer" | "none";
    parallelToolCalls: boolean | null;
    maxCompletionTokens: number | null;
    analysisInWire: boolean;
    assistantToolTurns: number;
    toolResultTurns: number;
  }>;
}>;

const toolStrictnessFor = (tool: ToolDefinition): boolean => tool.strict === true;

/** Normalizes every tool to one strictness value (Cerebras requirement). */
export const normalizeToolStrictness = (tools: readonly ToolDefinition[], strictness: boolean): readonly ToolDefinition[] =>
  tools.map((tool) => ({ ...tool, strict: strictness }));

const applyStrictnessMode = (tools: readonly ToolDefinition[], mode: ToolStrictnessMode): readonly ToolDefinition[] => {
  switch (mode) {
    case "normalize-false":
      return normalizeToolStrictness(tools, false);
    case "normalize-true":
      return normalizeToolStrictness(tools, true);
    case "preserve":
      return tools;
    // no default
  }
};

const jsonSchemaTool = (tool: ToolDefinition): Record<string, unknown> => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  },
});

/** Reads roles from the same projected body that the Cerebras transport sends. */
const wireMessageRoles = (body: Record<string, unknown>): readonly string[] => {
  const projected = projectCerebrasRequest(body);
  if (!Array.isArray(projected.messages)) return [];
  return projected.messages.map((message) => {
    if (!isRecord(message) || Array.isArray(message)) return "?";
    const role = message.role;
    if (role === null || role === undefined) return "?";
    return String(role);
  });
};

/** Generic style: the gateway's existing Chat Completions shape. */
const buildGenericHarmonyRequest = (options: HarmonyRequestOptions, strictTools: readonly ToolDefinition[]): BuiltHarmonyRequest => {
  const messages = wireMessagesFromConversation({ turns: options.turns });
  const body: Record<string, unknown> = {
    model: CEREBRAS_GPT_OSS_120B_MODEL,
    messages,
    stream: false,
  };
  if (strictTools.length > 0) body.tools = strictTools.map(jsonSchemaTool);
  if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
  if (options.responseFormat) body.response_format = options.responseFormat;
  if (options.parallelToolCalls !== undefined) body.parallel_tool_calls = options.parallelToolCalls;
  if (options.maxCompletionTokens !== undefined) body.max_completion_tokens = options.maxCompletionTokens;

  return {
    style: "generic",
    body,
    metadata: {
      model: CEREBRAS_GPT_OSS_120B_MODEL,
      messageRoles: wireMessageRoles(body),
      toolsRendered: strictTools.length > 0 ? "parameter" : "none",
      toolEntries: strictTools.map((tool) => ({ name: tool.name, strict: toolStrictnessFor(tool) })),
      toolStrictnessValues: strictTools.map(toolStrictnessFor),
      reasoningEffortTopLevel: options.reasoningEffort ?? null,
      reasoningEffortInSystem: false,
      responseFormat: options.responseFormat ? options.responseFormat.type : "none",
      parallelToolCalls: options.parallelToolCalls ?? null,
      maxCompletionTokens: options.maxCompletionTokens ?? null,
      analysisInWire: false,
      assistantToolTurns: options.turns.filter((turn) => turn.role === "assistant" && turn.toolCalls.length > 0).length,
      toolResultTurns: options.turns.filter((turn) => turn.role === "tool").length,
    },
  };
};

/** One native-style wire message, or null when the turn is not replayed. */
const nativeHarmonyMessage = (turn: ConversationTurn, toolResultStyle: "tool-role" | "user-role"): Record<string, unknown> | null => {
  if (turn.role === "system" || turn.role === "developer") return null;
  if (turn.role === "assistant") {
    if (turn.content === null && turn.toolCalls.length === 0) return null;
    const message: Record<string, unknown> = {
      role: "assistant",
      content: turn.content ?? "",
    };
    if (turn.toolCalls.length > 0) {
      message.tool_calls = turn.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return message;
  }
  if (turn.role === "tool") {
    if (toolResultStyle === "tool-role") {
      return { role: "tool", tool_call_id: turn.toolCallId, content: turn.content };
    }
    return {
      role: "user",
      content: `Tool result from ${turn.name}:\n${turn.content}`,
    };
  }
  return { role: "user", content: turn.content };
};

/** Native style: identity/meta/reasoning render into the system and developer messages. */
const buildNativeHarmonyRequest = (options: HarmonyRequestOptions, strictTools: readonly ToolDefinition[]): BuiltHarmonyRequest => {
  const systemContent = renderSystemMessage({
    currentDate: options.currentDate ?? "2026-01-01",
    reasoningEffort: options.reasoningEffort ?? "medium",
  });
  const developerContent = renderDeveloperMessage({
    instructions: options.instructions ?? "Follow the user's request.",
    tools: strictTools,
    responseFormat: options.nativeResponseFormat,
    namespace: options.namespace,
  });
  const toolResultStyle = options.nativeToolResultStyle ?? "tool-role";
  const messages: Record<string, unknown>[] = [
    { role: "system", content: systemContent },
    { role: "developer", content: developerContent },
  ];
  for (const turn of options.turns) {
    const message = nativeHarmonyMessage(turn, toolResultStyle);
    if (message !== null) messages.push(message);
  }
  const result: Record<string, unknown> = { model: CEREBRAS_GPT_OSS_120B_MODEL, messages, stream: false };
  if (options.maxCompletionTokens !== undefined) result.max_completion_tokens = options.maxCompletionTokens;

  return {
    style: "native",
    body: result,
    metadata: {
      model: CEREBRAS_GPT_OSS_120B_MODEL,
      messageRoles: wireMessageRoles(result),
      toolsRendered: strictTools.length > 0 ? "developer" : "none",
      toolEntries: strictTools.map((tool) => ({ name: tool.name, strict: toolStrictnessFor(tool) })),
      toolStrictnessValues: strictTools.map(toolStrictnessFor),
      reasoningEffortTopLevel: null,
      reasoningEffortInSystem: true,
      responseFormat: options.nativeResponseFormat ? "developer" : "none",
      parallelToolCalls: null,
      maxCompletionTokens: options.maxCompletionTokens ?? null,
      analysisInWire: false,
      assistantToolTurns: options.turns.filter((turn) => turn.role === "assistant" && turn.toolCalls.length > 0).length,
      toolResultTurns: options.turns.filter((turn) => turn.role === "tool").length,
    },
  };
};

/**
 * Builds the request body for one model turn.  Never emits reasoning/analysis
 * on the wire and refuses unproven tools+structured combinations by default.
 */
export const buildCerebrasHarmonyRequest = (options: HarmonyRequestOptions): BuiltHarmonyRequest => {
  const style = options.style;
  const tools = options.tools ?? [];
  const toolStrictnessMode = options.toolStrictnessMode ?? "normalize-false";
  const combinationPolicy = options.combinationPolicy ?? "error";

  const toolsPlusFormat = tools.length > 0 && (options.responseFormat !== undefined || options.nativeResponseFormat !== undefined);
  if (toolsPlusFormat && combinationPolicy !== "probe") {
    throw new HarmonyAdapterError(
      "Combining tools with a structured response format is not proven for gpt-oss-120b; " + "use combinationPolicy 'probe' only for protocol evidence.",
      "unproven-combination"
    );
  }
  if (style === "generic" && options.nativeResponseFormat) {
    throw new HarmonyAdapterError("nativeResponseFormat applies only to the native Harmony style.", "invalid-request");
  }
  if (style === "native" && options.responseFormat) {
    throw new HarmonyAdapterError("responseFormat applies only to the generic style; use nativeResponseFormat.", "invalid-request");
  }

  const strictTools = applyStrictnessMode(tools, toolStrictnessMode);
  if (style === "generic") return buildGenericHarmonyRequest(options, strictTools);
  return buildNativeHarmonyRequest(options, strictTools);
};

const exactString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const nonNegativeInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
};

type NormalizedChoice = {
  content: string | null;
  refusal: string | null;
  reasoning: string | null;
  toolCalls: readonly ToolCall[];
  finishReason: string | null;
  reasoningField: "reasoning_content" | "reasoning" | "none";
};

const normalizeToolCallWire = (value: unknown, index: number): ToolCall | null => {
  if (!isRecord(value) || Array.isArray(value)) return null;
  const functionValue = value.function;
  if (!isRecord(functionValue) || Array.isArray(functionValue)) return null;
  const name = exactString(functionValue.name);
  const argumentsText = typeof functionValue.arguments === "string" ? functionValue.arguments : null;
  if (!name || argumentsText === null) return null;
  const id = exactString(value.id) ?? `harmony-call-${index + 1}`;
  const providerName = name.startsWith("functions.") ? name.slice("functions.".length) : name;
  return { id, name: providerName, arguments: normalizeToolArguments(argumentsText) };
};

const reasoningFieldOf = (message: Record<string, unknown>): NormalizedChoice["reasoningField"] => {
  if (typeof message.reasoning_content === "string") return "reasoning_content";
  if (typeof message.reasoning === "string") return "reasoning";
  return "none";
};

const finishReasonOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

const normalizeToolCallsWire = (value: unknown): readonly ToolCall[] | { error: string } => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return { error: "tool_calls is not an array" };
  const toolCalls: ToolCall[] = [];
  for (const [index, call] of value.entries()) {
    const normalized = normalizeToolCallWire(call, index);
    if (!normalized) return { error: `tool call ${index} is invalid` };
    toolCalls.push(normalized);
  }
  return toolCalls;
};

const normalizeChoice = (value: unknown): NormalizedChoice | { error: string } => {
  if (!isRecord(value) || Array.isArray(value)) {
    return { error: "choice is not an object" };
  }
  const message = value.message;
  if (!isRecord(message) || Array.isArray(message)) {
    return { error: "assistant message is missing" };
  }
  if (message.role !== undefined && message.role !== "assistant") {
    return { error: "message role is not assistant" };
  }
  if (!(message.content === undefined || message.content === null || typeof message.content === "string")) {
    return { error: "message content is not a string" };
  }
  const content = typeof message.content === "string" ? message.content : null;
  const refusal = typeof message.refusal === "string" ? message.refusal : null;
  const reasoningField = reasoningFieldOf(message);
  const reasoning = reasoningField === "none" ? null : String(message[reasoningField]);
  const toolCalls = normalizeToolCallsWire(message.tool_calls);
  if ("error" in toolCalls) return { error: toolCalls.error };
  return { content, refusal, reasoning, toolCalls, finishReason: finishReasonOf(value.finish_reason), reasoningField };
};

/** Builds the ordered Harmony turns from a normalized choice. */
export const harmonyTurnsFromChoice = (choice: NormalizedChoice): readonly HarmonyTurn[] => {
  const turns: HarmonyTurn[] = [];
  if (choice.reasoning) turns.push({ kind: "reasoning", text: choice.reasoning });
  if (choice.toolCalls.length > 0) {
    if (choice.content) turns.push({ kind: "commentary", text: choice.content });
    for (const call of choice.toolCalls) {
      turns.push({
        kind: "tool_call",
        recipient: `functions.${call.name}`,
        name: call.name,
        arguments: call.arguments,
      });
    }
  } else if (choice.content) {
    const parsed = parseHarmonyOutput(choice.content);
    if (parsed.turns.length > 0) turns.push(...parsed.turns);
    else turns.push({ kind: "final", text: choice.content });
  }
  return turns;
};

/**
 * Normalizes a Chat Completions success payload into the shared Harmony turn
 * model.  Raw text is parsed as Harmony whenever no provider-translated tool
 * calls are present, so Harmony-native output (analysis/commentary/tool calls
 * in content) is captured even when the provider does not translate it.
 */
export const normalizeHarmonyChatCompletion = (
  value: unknown,
  requestedModel: string = CEREBRAS_GPT_OSS_120B_MODEL
): NormalizedAssistantResponse | { error: string } => {
  if (!isRecord(value) || Array.isArray(value)) {
    return { error: "upstream reply is not a Chat Completion object" };
  }
  const id = exactString(value.id);
  const created = nonNegativeInteger(value.created);
  if (!id) return { error: "upstream reply is missing an id" };
  if (created === null) return { error: "upstream reply has an invalid creation time" };
  const model = exactString(value.model) ?? requestedModel;
  if (model !== requestedModel) {
    return { error: `upstream returned model ${model} instead of ${requestedModel}` };
  }
  if (!Array.isArray(value.choices) || value.choices.length === 0) {
    return { error: "upstream reply has no choices" };
  }
  const choice = normalizeChoice(value.choices[0]);
  if ("error" in choice) return { error: choice.error };

  const turns = harmonyTurnsFromChoice(choice);
  const analysis = turns.filter((turn) => turn.kind === "reasoning").map((turn) => turn.text);
  const visible = turns.filter((turn) => turn.kind === "commentary" || turn.kind === "final").map((turn) => turn.text);
  const content = visible.length > 0 ? visible.join("\n") : null;
  const toolCalls = turns
    .filter((turn): turn is Extract<HarmonyTurn, { kind: "tool_call" }> => turn.kind === "tool_call")
    .map((turn, index) => ({
      id: choice.toolCalls[index]?.id ?? `harmony-call-${index + 1}`,
      name: turn.name,
      arguments: turn.arguments,
    }));

  const shape: AssistantResponseShape = {
    contentPresent: content !== null,
    contentChars: content?.length ?? 0,
    reasoningField: choice.reasoningField,
    reasoningChars: choice.reasoning?.length ?? 0,
    toolCallsField: choice.toolCalls.length > 0,
    toolCallCount: choice.toolCalls.length,
    finishReason: choice.finishReason,
    refusal: choice.refusal !== null,
  };

  return {
    turns,
    analysis,
    content,
    toolCalls,
    finishReason: choice.finishReason,
    refusal: choice.refusal,
    shape,
    id,
    model,
    created,
  };
};

export type HarmonyTransportRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type HarmonyTransport = (body: Record<string, unknown>, options?: HarmonyTransportRequestOptions) => Promise<Response>;

export type HarmonyTransportOptions = Readonly<{
  apiKey?: string | null;
  fetcher?: CerebrasFetch;
}>;

/**
 * Transport adapter over the existing Cerebras transport: same URL, header
 * handling, deadline and error normalization (`src/cerebras.ts`).
 */
export const createCerebrasTransport = (options: HarmonyTransportOptions = {}): HarmonyTransport => {
  return (body, requestOptions) =>
    fetchCerebrasChatCompletions(body, {
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(requestOptions?.signal ? { signal: requestOptions.signal } : {}),
    });
};

export type RunTurnResult = Readonly<
  | {
      ok: true;
      status: number;
      normalized: NormalizedAssistantResponse;
    }
  | {
      ok: false;
      status: number;
      upstreamError: Readonly<{ code: string | null; message: string | null }> | null;
      normalizationError: string | null;
    }
>;

const upstreamErrorCode = (value: Record<string, unknown>): string | null => {
  if (typeof value.code === "string") return value.code;
  return typeof value.error === "string" ? value.error : null;
};

const upstreamErrorFromRecord = (value: Record<string, unknown>): { code: string | null; message: string | null } | null => {
  const code = upstreamErrorCode(value);
  const message = typeof value.message === "string" ? value.message : null;
  if (code !== null || message !== null) return { code, message };
  const inner = value.error;
  if (!isRecord(inner) || Array.isArray(inner)) return null;
  return {
    code: typeof inner.code === "string" ? inner.code : null,
    message: typeof inner.message === "string" ? inner.message : null,
  };
};

const upstreamErrorFromBody = (value: unknown): { code: string | null; message: string | null } | null =>
  isRecord(value) && !Array.isArray(value) ? upstreamErrorFromRecord(value) : null;

/**
 * Executes one bounded model turn: builds the request, dispatches it through
 * the injected transport and normalizes the reply.  Upstream HTTP failures
 * are summarized (status + sanitized code/message) and never logged verbatim.
 */
export const runHarmonyTurn = async (options: HarmonyRequestOptions, transport: HarmonyTransport): Promise<RunTurnResult> => {
  const built = buildCerebrasHarmonyRequest(options);
  const response = await transport(built.body);
  const status = response.status;
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return {
      ok: false,
      status,
      upstreamError: upstreamErrorFromBody(body),
      normalizationError: null,
    };
  }
  const body = await response.json().catch(() => null);
  if (body === null) {
    return { ok: false, status, upstreamError: null, normalizationError: "upstream reply is not JSON" };
  }
  const normalized = normalizeHarmonyChatCompletion(body);
  if ("error" in normalized) {
    return { ok: false, status, upstreamError: null, normalizationError: normalized.error };
  }
  return { ok: true, status, normalized };
};
