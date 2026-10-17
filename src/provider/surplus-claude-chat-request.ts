import type { PromptCacheMode } from "../openai-telemetry.ts";
import type { OriginalToolName } from "../deepseek/responses.ts";
import { restoreAnthropicChatReplay } from "./anthropic-replay.ts";
import type { AnthropicChatReplayEntry } from "./anthropic-replay.ts";
import { isSurplusClaudeModel } from "./surplus-claude-request.ts";

type JsonRecord = Record<string, unknown>;
type ToolProjection = {
  tools: JsonRecord[];
  toolNames: Map<string, OriginalToolName>;
  customToolNames: Set<string>;
};
export type SurplusClaudeChatRequest = Readonly<{
  body: JsonRecord;
  promptCacheMode: PromptCacheMode;
  explicitBreakpointCount: number;
  toolNames: ReadonlyMap<string, OriginalToolName>;
  customToolNames: ReadonlySet<string>;
}>;
export type ClaudeChatRequestOptions = Readonly<{ provider?: string; reasoningReplayScope?: string }>;
const record = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value: JsonRecord, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const name = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const control = (value: unknown): JsonRecord | null => {
  if (!record(value) || value.type !== "ephemeral" || Object.keys(value).some((key) => key !== "type" && key !== "ttl")) return null;
  return value.ttl === undefined || value.ttl === "5m" || value.ttl === "1h" ? { ...value } : null;
};

const cachedBlock = (projected: JsonRecord, original: JsonRecord): JsonRecord | null => {
  const marker = original.prompt_cache_breakpoint;
  if (has(original, "prompt_cache_breakpoint") && (!record(marker) || marker.mode !== "explicit" || Object.keys(marker).length !== 1)) return null;
  if (has(original, "cache_control")) {
    const policy = control(original.cache_control);
    return policy ? { ...projected, cache_control: policy } : null;
  }
  return marker === undefined ? projected : { ...projected, cache_control: { type: "ephemeral" } };
};

const chatPart = (part: unknown): JsonRecord | null => {
  if (!record(part)) return null;
  if (["input_text", "output_text", "text"].includes(String(part.type)) && typeof part.text === "string") {
    return cachedBlock({ type: "text", text: part.text }, part);
  }
  if (part.type !== "input_image" || typeof part.image_url !== "string" || part.file_id !== undefined) return null;
  if (!/^https?:\/\//.test(part.image_url) && !/^data:image\/(?:jpeg|png|gif|webp);base64,/.test(part.image_url)) return null;
  return cachedBlock({ type: "image_url", image_url: { url: part.image_url, ...(part.detail === undefined ? {} : { detail: part.detail }) } }, part);
};

const chatContent = (value: unknown): JsonRecord[] | null => {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return null;
  const parts: JsonRecord[] = [];
  for (const original of value) {
    const part = chatPart(original);
    if (!part) return null;
    parts.push(part);
  }
  return parts;
};

const collectFunction = (projection: ToolProjection, tool: JsonRecord, namespace: string | null): boolean => {
  if (!name(tool.name) || (tool.parameters !== undefined && !record(tool.parameters))) return false;
  if (tool.strict !== undefined && tool.strict !== null && typeof tool.strict !== "boolean") return false;
  if (tool.description !== undefined && typeof tool.description !== "string") return false;
  const preferred = namespace ? `${namespace}_${tool.name}` : tool.name;
  if (!name(preferred) || projection.tools.some((entry) => record(entry.function) && entry.function.name === preferred)) return false;
  const fn = cachedBlock(
    {
      name: preferred,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
    tool
  );
  if (!fn) return false;
  projection.tools.push({ type: "function", function: fn });
  projection.toolNames.set(preferred, { name: tool.name, namespace });
  return true;
};

const collectCustom = (projection: ToolProjection, tool: JsonRecord): boolean => {
  // Chat cannot enforce a caller's context-free grammar. Retain Responses for that control.
  if (tool.format !== undefined && (!record(tool.format) || tool.format.type !== "text" || Object.keys(tool.format).length !== 1)) return false;
  const fn = {
    ...tool,
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
  };
  if (!collectFunction(projection, fn, null)) return false;
  if (typeof tool.name !== "string") return false;
  projection.customToolNames.add(tool.name);
  return true;
};

const collectTool = (projection: ToolProjection, tool: unknown): boolean => {
  if (!record(tool)) return false;
  if (tool.type === "function") return collectFunction(projection, tool, null);
  if (tool.type === "custom") return collectCustom(projection, tool);
  if (tool.type !== "namespace" || !name(tool.name) || !Array.isArray(tool.tools)) return false;
  for (const nested of tool.tools) if (!record(nested) || nested.type !== "function" || !collectFunction(projection, nested, tool.name)) return false;
  return true;
};

const chatTools = (value: unknown): ToolProjection | null => {
  const projection: ToolProjection = { tools: [], toolNames: new Map(), customToolNames: new Set() };
  if (value === undefined) return projection;
  if (!Array.isArray(value)) return null;
  for (const tool of value) if (!collectTool(projection, tool)) return null;
  return projection;
};

const projectedToolName = (item: JsonRecord, projection: ToolProjection): string | null => {
  if (!name(item.name)) return null;
  const namespace = item.namespace ?? null;
  if (namespace !== null && !name(namespace)) return null;
  for (const [projected, original] of projection.toolNames) if (original.name === item.name && original.namespace === namespace) return projected;
  return namespace === null ? item.name : null;
};

const appendCall = (messages: JsonRecord[], call: JsonRecord): void => {
  const previous = messages.at(-1);
  if (previous?.role === "assistant" && Array.isArray(previous.tool_calls)) previous.tool_calls.push(call);
  else messages.push({ role: "assistant", content: null, tool_calls: [call] });
};

const appendToolCall = (item: JsonRecord, messages: JsonRecord[], projection: ToolProjection): boolean => {
  // The Chat tool-call union has no documented explicit block cache marker.
  if (has(item, "cache_control") || has(item, "prompt_cache_breakpoint")) return false;
  const projected = projectedToolName(item, projection);
  if (!projected || typeof item.call_id !== "string" || !item.call_id) return false;
  let argumentsText: string;
  if (item.type === "custom_tool_call") {
    if (!projection.customToolNames.has(projected) || typeof item.input !== "string") return false;
    argumentsText = JSON.stringify({ input: item.input });
  } else {
    if (typeof item.arguments !== "string" || projection.customToolNames.has(projected)) return false;
    argumentsText = item.arguments;
  }
  appendCall(messages, { id: item.call_id, type: "function", function: { name: projected, arguments: argumentsText } });
  return true;
};

const appendToolResult = (item: JsonRecord, messages: JsonRecord[]): boolean => {
  if (typeof item.call_id !== "string" || !item.call_id) return false;
  const content = chatContent(item.output);
  if (!content) return false;
  if (has(item, "cache_control") || has(item, "prompt_cache_breakpoint")) {
    const last = content.at(-1);
    if (!last) return false;
    const cached = cachedBlock(last, item);
    if (!cached) return false;
    content[content.length - 1] = cached;
  }
  messages.push({ role: "tool", tool_call_id: item.call_id, content });
  return true;
};

const appendOriginal = (item: unknown, messages: JsonRecord[], projection: ToolProjection): boolean => {
  if (!record(item)) return false;
  if (item.type === "function_call" || item.type === "custom_tool_call") return appendToolCall(item, messages, projection);
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") return appendToolResult(item, messages);
  if (item.type !== undefined && item.type !== "message") return false;
  if (!["system", "developer", "user", "assistant"].includes(String(item.role))) return false;
  const content = chatContent(item.content);
  if (!content) return false;
  messages.push({ role: item.role, content });
  return true;
};

const appendInstructions = (instructions: unknown, messages: JsonRecord[]): boolean => {
  if (instructions === undefined || instructions === null) return true;
  const content = chatContent(instructions);
  if (!content || content.some((part) => part.type !== "text")) return false;
  messages.push({ role: "system", content });
  return true;
};

const appendReplayEntries = (entries: readonly AnthropicChatReplayEntry[], messages: JsonRecord[], projection: ToolProjection): boolean => {
  for (const entry of entries) {
    if (entry.type === "native_chat_assistant") messages.push(structuredClone(entry.message));
    else if (!appendOriginal(entry.item, messages, projection)) return false;
  }
  return true;
};

const chatMessages = (body: JsonRecord, projection: ToolProjection, options: ClaudeChatRequestOptions): JsonRecord[] | null => {
  const messages: JsonRecord[] = [];
  if (!appendInstructions(body.instructions, messages)) return null;
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: body.input }] });
    return messages;
  }
  if (!Array.isArray(body.input)) return null;
  if (options.reasoningReplayScope) {
    const entries = restoreAnthropicChatReplay(body.input, {
      scope: options.reasoningReplayScope,
      provider: options.provider ?? "surplus",
      model: String(body.model),
    });
    if (!entries) return null;
    if (!appendReplayEntries(entries, messages, projection)) return null;
  } else {
    for (const item of body.input) if (!appendOriginal(item, messages, projection)) return null;
  }
  return messages.length ? messages : null;
};

const cachePolicy = (body: JsonRecord, messages: JsonRecord[], tools: ToolProjection): { mode: PromptCacheMode; count: number } | null => {
  if (body.prompt_cache_retention !== undefined && body.prompt_cache_retention !== "in_memory") return null;
  const options = body.prompt_cache_options;
  if (
    options !== undefined &&
    (!record(options) ||
      Object.keys(options).some((key) => key !== "mode") ||
      (options.mode !== undefined && options.mode !== "implicit" && options.mode !== "explicit"))
  )
    return null;
  const rootControl = has(body, "cache_control") ? control(body.cache_control) : { type: "ephemeral" };
  if (!rootControl) return null;
  const parts: JsonRecord[] = messages.flatMap((message) => (Array.isArray(message.content) ? message.content.filter(record) : []));
  const toolBlocks = tools.tools.flatMap((tool) => (record(tool.function) ? [tool.function] : []));
  const count = [...parts, ...toolBlocks].filter((part) => has(part, "cache_control")).length;
  if (count > 4) return null;
  if (count || (record(options) && options.mode === "explicit")) return { mode: "explicit", count };
  const last = parts.findLast((part) => part.type === "text" || part.type === "image_url") ?? toolBlocks.at(-1);
  if (!last) return null;
  last.cache_control = rootControl;
  return { mode: "implicit", count: 0 };
};

const reasoningEffort = (value: unknown): { effort?: string } | null => {
  if (value === undefined || value === null) return {};
  if (!record(value) || Object.keys(value).some((key) => key !== "effort" && key !== "summary")) return null;
  if (value.summary !== undefined && value.summary !== "auto" && value.summary !== "detailed" && value.summary !== "none") return null;
  if (value.effort === undefined) return {};
  if (typeof value.effort !== "string" || !value.effort.trim()) return null;
  return { effort: value.effort === "ultra" ? "max" : value.effort };
};

const chatToolChoice = (value: unknown, tools: ToolProjection): unknown => {
  if (value === undefined) return undefined;
  if (typeof value === "string" && ["auto", "none", "required"].includes(value)) return value;
  if (!record(value) || !["function", "custom"].includes(String(value.type))) return null;
  const projected = projectedToolName(value, tools);
  return projected ? { type: "function", function: { name: projected } } : null;
};

const chatResponseFormat = (value: unknown): JsonRecord | undefined | null => {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).some((key) => key !== "format")) return null;
  const format = value.format;
  if (format === undefined) return undefined;
  if (!record(format)) return null;
  if (format.type === "text" && Object.keys(format).length === 1) return undefined;
  if (format.type === "json_object" && Object.keys(format).length === 1) return { type: "json_object" };
  if (format.type !== "json_schema") return null;
  const jsonSchema = { ...format };
  delete jsonSchema.type;
  return { type: "json_schema", json_schema: jsonSchema };
};

const supportedControls = (body: JsonRecord): boolean => {
  if (!isSurplusClaudeModel(body.model) || (body.store !== undefined && body.store !== false)) return false;
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) return false;
  if (["context_management", "max_tool_calls", "truncation", "metadata", "service_tier", "safety_identifier", "user"].some((key) => body[key] !== undefined))
    return false;
  if (body.include !== undefined && (!Array.isArray(body.include) || body.include.some((field) => field !== "reasoning.encrypted_content"))) return false;
  return body.parallel_tool_calls === undefined || typeof body.parallel_tool_calls === "boolean";
};

const projectedBody = (
  body: JsonRecord,
  messages: JsonRecord[],
  tools: ToolProjection,
  maxTokens: number | undefined,
  effort: string | undefined,
  choice: unknown,
  format: JsonRecord | undefined
): JsonRecord => {
  const projected: JsonRecord = { model: body.model, messages, stream: body.stream === true };
  if (body.stream === true) projected.stream_options = { include_usage: true };
  if (maxTokens !== undefined) projected.max_tokens = maxTokens;
  if (effort !== undefined) projected.reasoning_effort = effort;
  if (tools.tools.length) projected.tools = tools.tools;
  if (choice !== undefined) projected.tool_choice = choice;
  if (format !== undefined) projected.response_format = format;
  for (const key of ["parallel_tool_calls", "temperature", "top_p", "prompt_cache_key"] as const) if (body[key] !== undefined) projected[key] = body[key];
  return projected;
};

/** Claude's canonical Chat route preserves both explicit block caching and requested effort. */
export const buildSurplusClaudeChatRequest = (
  body: JsonRecord,
  catalogMaxOutputTokens?: number,
  options: ClaudeChatRequestOptions = {}
): SurplusClaudeChatRequest | null => {
  if (!supportedControls(body)) return null;
  const tools = chatTools(body.tools);
  if (!tools) return null;
  const messages = chatMessages(body, tools, options);
  if (!messages) return null;
  const reasoning = reasoningEffort(body.reasoning);
  if (!reasoning) return null;
  const choice = chatToolChoice(body.tool_choice, tools);
  if (choice === null) return null;
  const format = chatResponseFormat(body.text);
  if (format === null) return null;
  const maxTokens = body.max_output_tokens ?? catalogMaxOutputTokens;
  if (maxTokens !== undefined && !positiveInteger(maxTokens)) return null;
  const cache = cachePolicy(body, messages, tools);
  if (!cache) return null;
  const projected = projectedBody(body, messages, tools, maxTokens, reasoning.effort, choice, format);
  return {
    body: projected,
    promptCacheMode: cache.mode,
    explicitBreakpointCount: cache.count,
    toolNames: tools.toolNames,
    customToolNames: tools.customToolNames,
  };
};
