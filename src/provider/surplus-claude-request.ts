import type { PromptCacheMode } from "../openai-telemetry.ts";
import { restoreAnthropicReplay } from "./anthropic-replay.ts";

type JsonRecord = Record<string, unknown>;
type NativeMessage = { role: "user" | "assistant"; content: JsonRecord[] };
export type SurplusClaudeRequest = Readonly<{
  body: JsonRecord;
  promptCacheMode: PromptCacheMode;
  explicitBreakpointCount: number;
}>;
export type ClaudeNativeReplayEntry = Readonly<{ type: "original"; item: JsonRecord }> | Readonly<{ type: "native_assistant"; blocks: JsonRecord[] }>;
export type SurplusClaudeRequestOptions = Readonly<{
  provider?: "surplus" | "metered" | "claude_code";
  reasoningReplayScope?: string;
  /** A provider-specific contract proof is required before translating an explicit effort. */
  supportsNativeReasoningEffort?: boolean;
}>;

const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value: JsonRecord, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const toolName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

export const isSurplusClaudeModel = (model: unknown): model is string => typeof model === "string" && /^(?:~?anthropic\/)?claude-/.test(model);

const cacheControl = (value: unknown): JsonRecord | null => {
  if (!isRecord(value) || value.type !== "ephemeral" || Object.keys(value).some((key) => key !== "type" && key !== "ttl")) return null;
  if (value.ttl !== undefined && value.ttl !== "5m" && value.ttl !== "1h") return null;
  return { ...value };
};

const withBlockCache = (block: JsonRecord, original: JsonRecord): JsonRecord | null => {
  if (has(original, "prompt_cache_breakpoint")) {
    const marker = original.prompt_cache_breakpoint;
    if (!isRecord(marker) || marker.mode !== "explicit" || Object.keys(marker).length !== 1) return null;
  }
  if (has(original, "cache_control")) {
    const control = cacheControl(original.cache_control);
    return control ? { ...block, cache_control: control } : null;
  }
  if (has(original, "prompt_cache_breakpoint")) {
    return { ...block, cache_control: { type: "ephemeral" } };
  }
  return block;
};

const textBlock = (text: string): JsonRecord => ({ type: "text", text });

const imageSource = (url: string): JsonRecord | null => {
  const inline = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  if (inline) return { type: "base64", media_type: inline[1], data: inline[2] };
  return /^https?:\/\//.test(url) ? { type: "url", url } : null;
};

const contentBlock = (value: unknown): JsonRecord | null => {
  if (!isRecord(value)) return null;
  if ((value.type === "input_text" || value.type === "output_text" || value.type === "text") && typeof value.text === "string") {
    return withBlockCache(textBlock(value.text), value);
  }
  if (value.type === "input_image" && typeof value.image_url === "string" && value.file_id === undefined) {
    // Native Messages has no equivalent for a caller-selected OpenAI image detail.
    if (value.detail !== undefined && value.detail !== null && value.detail !== "auto") return null;
    const source = imageSource(value.image_url);
    return source ? withBlockCache({ type: "image", source }, value) : null;
  }
  return null;
};

const contentBlocks = (value: unknown): JsonRecord[] | null => {
  if (typeof value === "string") return [textBlock(value)];
  if (!Array.isArray(value)) return null;
  const blocks: JsonRecord[] = [];
  for (const original of value) {
    const block = contentBlock(original);
    if (!block) return null;
    blocks.push(block);
  }
  return blocks;
};

const functionArguments = (value: unknown): JsonRecord | null => {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    // JSON numbers beyond the JavaScript range would otherwise silently become null.
    const pending: unknown[] = [parsed];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === "number" && !Number.isFinite(item)) return null;
      if (Array.isArray(item)) pending.push(...item);
      else if (isRecord(item)) pending.push(...Object.values(item));
    }
    return parsed;
  } catch {
    return null;
  }
};

const appendMessage = (messages: NativeMessage[], role: NativeMessage["role"], blocks: JsonRecord[]): void => {
  const previous = messages.at(-1);
  if (previous?.role === role) previous.content.push(...blocks);
  else messages.push({ role, content: blocks });
};

const appendInputMessage = (item: JsonRecord, system: JsonRecord[], messages: NativeMessage[]): boolean => {
  const blocks = contentBlocks(item.content);
  if (!blocks) return false;
  if (item.role === "system" || item.role === "developer") {
    // A later instruction cannot be promoted ahead of earlier user input losslessly.
    if (messages.length || blocks.some((block) => block.type !== "text")) return false;
    system.push(...blocks);
    return true;
  }
  if (item.role !== "user" && item.role !== "assistant") return false;
  appendMessage(messages, item.role, blocks);
  return true;
};

const nativeToolUse = (item: JsonRecord): JsonRecord | null => {
  if (!toolName(item.name) || typeof item.call_id !== "string" || !item.call_id || item.namespace !== undefined) return null;
  const args = functionArguments(item.arguments);
  return args ? withBlockCache({ type: "tool_use", id: item.call_id, name: item.name, input: args }, item) : null;
};

const nativeToolResult = (item: JsonRecord): JsonRecord | null => {
  if (typeof item.call_id !== "string" || !item.call_id) return null;
  const output = typeof item.output === "string" ? item.output : contentBlocks(item.output);
  return output === null ? null : withBlockCache({ type: "tool_result", tool_use_id: item.call_id, content: output }, item);
};

const appendInputItem = (item: unknown, system: JsonRecord[], messages: NativeMessage[]): boolean => {
  if (!isRecord(item)) return false;
  if (item.type === "message" || item.type === undefined) return appendInputMessage(item, system, messages);
  const role = item.type === "function_call" ? "assistant" : "user";
  let block: JsonRecord | null = null;
  if (item.type === "function_call") block = nativeToolUse(item);
  if (item.type === "function_call_output") block = nativeToolResult(item);
  if (!block) return false;
  appendMessage(messages, role, [block]);
  return true;
};

const inputMessages = (input: unknown, system: JsonRecord[], replayEntries?: readonly ClaudeNativeReplayEntry[]): NativeMessage[] | null => {
  if (typeof input === "string") return [{ role: "user", content: [textBlock(input)] }];
  if (!Array.isArray(input)) return null;
  const messages: NativeMessage[] = [];
  if (replayEntries) {
    if (!appendReplayEntries(replayEntries, system, messages)) return null;
  } else {
    for (const item of input) if (!appendInputItem(item, system, messages)) return null;
  }
  // Hosted tools and opaque OpenAI reasoning without a scope-bound receipt retain Responses transport.
  return messages.length ? messages : null;
};

const appendReplayEntries = (entries: readonly ClaudeNativeReplayEntry[], system: JsonRecord[], messages: NativeMessage[]): boolean => {
  for (const entry of entries) {
    if (entry.type === "native_assistant") appendMessage(messages, "assistant", structuredClone(entry.blocks));
    else if (!appendInputItem(entry.item, system, messages)) return false;
  }
  return true;
};

const nativeTools = (value: unknown): JsonRecord[] | null => {
  if (!Array.isArray(value)) return null;
  const tools: JsonRecord[] = [];
  for (const tool of value) {
    if (!isRecord(tool) || tool.type !== "function" || !toolName(tool.name) || tool.strict === true || tool.namespace !== undefined) return null;
    if (tool.description !== undefined && typeof tool.description !== "string") return null;
    if (tool.parameters !== undefined && !isRecord(tool.parameters)) return null;
    const native = withBlockCache(
      { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), input_schema: tool.parameters ?? { type: "object" } },
      tool
    );
    if (!native) return null;
    tools.push(native);
  }
  return tools;
};

const nativeToolChoice = (value: unknown): JsonRecord | null => {
  if (value === "auto" || value === "none") return { type: value };
  if (value === "required") return { type: "any" };
  if (isRecord(value) && value.type === "function" && toolName(value.name) && value.namespace === undefined) return { type: "tool", name: value.name };
  return null;
};

const nativeReasoning = (value: unknown, supportsEffort: boolean): JsonRecord | null => {
  if (value === undefined || value === null) return {};
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "effort" && key !== "summary")) return null;
  if (value.summary !== undefined && value.summary !== "auto" && value.summary !== "detailed" && value.summary !== "none") return null;
  if (value.effort === undefined) return {};
  if (!supportsEffort) return null;
  const effort = value.effort === "ultra" ? "max" : value.effort;
  if (typeof effort !== "string" || !["low", "medium", "high", "xhigh", "max"].includes(effort)) return null;
  return { thinking: { type: "adaptive" }, output_config: { effort } };
};

const supportedCachePolicy = (body: JsonRecord): boolean => {
  if (has(body, "cache_control") && !cacheControl(body.cache_control)) return false;
  const options = body.prompt_cache_options;
  if (
    options !== undefined &&
    (!isRecord(options) ||
      options.ttl !== undefined ||
      Object.keys(options).some((key) => key !== "mode") ||
      (options.mode !== undefined && options.mode !== "implicit" && options.mode !== "explicit"))
  )
    return false;
  // Neither the native five-minute nor one-hour cache can honor an explicit 24-hour/30-minute lifetime.
  return body.prompt_cache_retention === undefined || body.prompt_cache_retention === "in_memory";
};

const explicitCacheBlocks = (system: JsonRecord[], messages: NativeMessage[], tools: JsonRecord[]): JsonRecord[] => {
  const blocks = [...system, ...tools, ...messages.flatMap((message) => message.content)];
  const controls: JsonRecord[] = [];
  for (const block of blocks) {
    if (has(block, "cache_control")) controls.push(block);
    if (block.type === "tool_result" && Array.isArray(block.content)) blocks.push(...block.content.filter(isRecord));
  }
  return controls;
};

const applyNativeCachePolicy = (body: JsonRecord, system: JsonRecord[], messages: NativeMessage[], tools: JsonRecord[]): SurplusClaudeRequest | null => {
  if (!supportedCachePolicy(body)) return null;
  const options = body.prompt_cache_options;
  const controls = explicitCacheBlocks(system, messages, tools);
  const explicitBreakpointCount = controls.length;
  if (explicitBreakpointCount > 4) return null;
  const declaredExplicit = isRecord(options) && options.mode === "explicit";
  const explicit = explicitBreakpointCount > 0 || declaredExplicit;
  if (!explicit) {
    const control = has(body, "cache_control") ? cacheControl(body.cache_control) : { type: "ephemeral" };
    if (!control) return null;
    const eligible = new Set(["text", "image", "tool_use", "tool_result"]);
    const last = messages.flatMap((message) => message.content).findLast((block) => eligible.has(String(block.type))) ?? system.at(-1) ?? tools.at(-1);
    if (!last) return null;
    last.cache_control = control;
  }
  return { body: {}, promptCacheMode: explicit ? "explicit" : "implicit", explicitBreakpointCount };
};

const supportedTextFormat = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "format")) return false;
  const format = value.format;
  return format === undefined || (isRecord(format) && format.type === "text" && Object.keys(format).every((key) => key === "type"));
};

const supportedBaseControls = (body: JsonRecord): boolean => {
  if (!isSurplusClaudeModel(body.model) || (body.store !== undefined && body.store !== false)) return false;
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) return false;
  const unsupported = ["context_management", "max_tool_calls", "truncation", "metadata", "service_tier", "safety_identifier", "user"];
  if (unsupported.some((key) => body[key] !== undefined) || !supportedTextFormat(body.text)) return false;
  return body.include === undefined || (Array.isArray(body.include) && body.include.every((field) => field === "reasoning.encrypted_content"));
};

const nativeRequestMessages = (body: JsonRecord, system: JsonRecord[], options: SurplusClaudeRequestOptions): NativeMessage[] | null => {
  if (!Array.isArray(body.input) || !options.reasoningReplayScope) return inputMessages(body.input, system);
  const entries = restoreAnthropicReplay(body.input, {
    scope: options.reasoningReplayScope,
    provider: options.provider ?? "surplus",
    model: String(body.model),
  });
  return entries ? inputMessages(body.input, system, entries) : null;
};

const parallelToolChoice = (body: JsonRecord): JsonRecord | null => {
  const choice = body.tool_choice === undefined ? {} : nativeToolChoice(body.tool_choice);
  if (!choice) return null;
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") return null;
    if (!has(choice, "type")) choice.type = "auto";
    choice.disable_parallel_tool_use = !body.parallel_tool_calls;
  }
  return choice;
};

const nativeBody = (
  body: JsonRecord,
  maxTokens: number,
  system: JsonRecord[],
  messages: NativeMessage[],
  tools: JsonRecord[],
  choice: JsonRecord,
  reasoning: JsonRecord
): JsonRecord => {
  const native: JsonRecord = { model: body.model, max_tokens: maxTokens, messages, stream: body.stream === true, ...reasoning };
  if (system.length) native.system = system;
  if (tools.length) native.tools = tools;
  if (Object.keys(choice).length) native.tool_choice = choice;
  // The caller's affinity key remains a Surplus router hint, never a native Codex header.
  for (const key of ["temperature", "top_p", "prompt_cache_key"] as const) if (body[key] !== undefined) native[key] = body[key];
  return native;
};

/**
 * Claude's Surplus Responses bridge drops cache policy, while native Messages
 * preserves explicit block markers. Return null instead of dropping an input
 * or a control that has no lossless native representation.
 */
export const buildSurplusClaudeRequest = (
  body: JsonRecord,
  catalogMaxOutputTokens?: number,
  options: SurplusClaudeRequestOptions = {}
): SurplusClaudeRequest | null => {
  if (!supportedBaseControls(body)) return null;
  const maxTokens = body.max_output_tokens ?? catalogMaxOutputTokens;
  if (!positiveInteger(maxTokens)) return null;
  const system = body.instructions === undefined || body.instructions === null ? [] : contentBlocks(body.instructions);
  if (!system || system.some((block) => block.type !== "text")) return null;
  const messages = nativeRequestMessages(body, system, options);
  if (!messages) return null;
  const tools = body.tools === undefined ? [] : nativeTools(body.tools);
  if (!tools) return null;
  const reasoning = nativeReasoning(body.reasoning, options.supportsNativeReasoningEffort === true);
  if (!reasoning) return null;
  const choice = parallelToolChoice(body);
  if (!choice) return null;
  const policy = applyNativeCachePolicy(body, system, messages, tools);
  if (!policy) return null;
  return { ...policy, body: nativeBody(body, maxTokens, system, messages, tools, choice, reasoning) };
};
