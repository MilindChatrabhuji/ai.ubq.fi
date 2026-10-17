type JsonRecord = Record<string, unknown>;

export type AnthropicReplayContext = Readonly<{ scope: string; provider: string; model: string }>;
export type NativeReplayEntry = { type: "original"; item: JsonRecord } | { type: "native_assistant"; blocks: JsonRecord[] };
export type AnthropicChatReplayEntry = { type: "original"; item: JsonRecord } | { type: "native_chat_assistant"; message: JsonRecord };
type ReplayPublication = AnthropicReplayContext & Readonly<{ output: readonly JsonRecord[]; nativeBlocks: readonly JsonRecord[] }>;
type ChatReplayPublication = AnthropicReplayContext &
  Readonly<{
    output: readonly JsonRecord[];
    assistant: JsonRecord;
    toolNames?: ReadonlyMap<string, { name: string; namespace: string | null }>;
    customToolNames?: ReadonlySet<string>;
  }>;
type ReplayLimits = Readonly<{ now?: () => number; ttlMs?: number; maxEntries?: number; maxBytes?: number; maxEntryBytes?: number }>;
type Receipt = { keys: string[]; fingerprints: string[]; payloadJson: string; transport: "messages" | "chat"; expiresAt: number; bytes: number };

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 64;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_ITEMS = 256;
const record = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const absent = (value: unknown): boolean => value === undefined || value === null;

const contextKey = (value: AnthropicReplayContext): string | null => {
  if (!value.scope || value.scope.length > 512 || !value.provider || value.provider.length > 64 || !value.model || value.model.length > 256) return null;
  return JSON.stringify([value.scope, value.provider, value.model]);
};

// Only finite JSON values are retained. Private native signatures never leave this store.
const canonical = (value: unknown, depth = 0, ancestors = new Set<object>()): string | null => {
  if (depth > 64) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (typeof value !== "object" || ancestors.has(value)) return null;
  ancestors.add(value);
  if (Array.isArray(value)) {
    const children = value.map((child: unknown) => canonical(child, depth + 1, ancestors));
    ancestors.delete(value);
    return children.some((child) => child === null) ? null : `[${children.join(",")}]`;
  }
  if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
  const children = Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => {
      const child = canonical(value[key], depth + 1, ancestors);
      return child === null ? null : `${JSON.stringify(key)}:${child}`;
    });
  ancestors.delete(value);
  return children.some((child) => child === null) ? null : `{${children.join(",")}}`;
};

const itemId = (item: JsonRecord): string | null => (typeof item.id === "string" && /^(?:rs|fc|msg|ctc)_[A-Za-z0-9_-]{1,240}$/.test(item.id) ? item.id : null);
const nativeReplayId = (id: string | null): boolean => id !== null && /^(?:rs|fc|msg|ctc)_resp_[A-Za-z0-9_-]+_\d+$/.test(id);

// Codex drops display status/annotations and adds null optional fields when replaying.
// Compare model-visible content rather than the incidental output envelope.
const reasoningFingerprint = (item: JsonRecord, id: string): string | null => {
  if (!absent(item.encrypted_content) || (!absent(item.content) && (!Array.isArray(item.content) || item.content.length !== 0))) return null;
  if (!Array.isArray(item.summary) || item.summary.some((part: unknown) => !record(part) || part.type !== "summary_text" || typeof part.text !== "string")) {
    return null;
  }
  return canonical({ id, type: item.type, summary: item.summary.map((part: JsonRecord) => ({ type: part.type, text: part.text })) });
};

const publicContent = (part: unknown): JsonRecord | null => {
  if (!record(part)) return null;
  if (part.type === "output_text" && typeof part.text === "string") return { type: part.type, text: part.text };
  return part.type === "refusal" && typeof part.refusal === "string" ? { type: part.type, refusal: part.refusal } : null;
};

const messageFingerprint = (item: JsonRecord, id: string): string | null => {
  if (item.role !== "assistant" || !Array.isArray(item.content)) return null;
  const content = item.content.map(publicContent);
  return content.some((part) => part === null) ? null : canonical({ id, type: item.type, role: item.role, content });
};

const toolFingerprint = (item: JsonRecord, id: string): string | null => {
  if (typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name) return null;
  if ((!absent(item.namespace) && typeof item.namespace !== "string") || !absent(item.encrypted_function_args)) return null;
  const base = { id, type: item.type, call_id: item.call_id, name: item.name, namespace: item.namespace ?? null };
  if (item.type === "custom_tool_call") return typeof item.input === "string" ? canonical({ ...base, input: item.input }) : null;
  if (typeof item.arguments !== "string") return null;
  try {
    const args: unknown = JSON.parse(item.arguments);
    return record(args) ? canonical({ ...base, arguments: args }) : null;
  } catch {
    return null;
  }
};

const fingerprint = (item: JsonRecord): string | null => {
  if (!record(item)) return null;
  const id = itemId(item);
  if (!id) return null;
  if (item.type === "reasoning") return reasoningFingerprint(item, id);
  if (item.type === "message") return messageFingerprint(item, id);
  return item.type === "function_call" || item.type === "custom_tool_call" ? toolFingerprint(item, id) : null;
};

const textMatchesOutput = (block: JsonRecord, item: JsonRecord | undefined): boolean =>
  typeof block.text === "string" &&
  item?.type === "message" &&
  Array.isArray(item.content) &&
  canonical(item.content.map((part: JsonRecord) => ({ type: part.type, text: part.text }))) === canonical([{ type: "output_text", text: block.text }]);

const toolMatchesOutput = (block: JsonRecord, item: JsonRecord | undefined): boolean =>
  record(block.input) &&
  item?.type === "function_call" &&
  block.id === item.call_id &&
  block.name === item.name &&
  canonical(block.input) === canonical(JSON.parse(String(item.arguments)));

const thinkingBlockAdvance = (block: JsonRecord, item: JsonRecord | undefined): number | null => {
  if (typeof block.thinking !== "string" || typeof block.signature !== "string" || !block.signature) return null;
  if (item?.type !== "reasoning") return 0;
  return canonical(item.summary) === canonical([{ type: "summary_text", text: block.thinking }]) ? 1 : null;
};

const nativeBlockAdvance = (block: JsonRecord, item: JsonRecord | undefined): number | null => {
  if (!record(block)) return null;
  if (block.type === "redacted_thinking") return typeof block.data === "string" && block.data ? 0 : null;
  if (block.type === "thinking") return thinkingBlockAdvance(block, item);
  if (block.type === "text") return textMatchesOutput(block, item) ? 1 : null;
  return block.type === "tool_use" && toolMatchesOutput(block, item) ? 1 : null;
};

const nativeMatchesOutput = (native: readonly JsonRecord[], output: readonly JsonRecord[]): boolean => {
  let next = 0;
  for (const block of native) {
    const advance = nativeBlockAdvance(block, output.at(next));
    if (advance === null) return false;
    next += advance;
  }
  return next === output.length;
};

const chatReadableReasoning = (assistant: JsonRecord, detailText: string): string | null => {
  if (!absent(assistant.reasoning_content) && typeof assistant.reasoning_content !== "string") return null;
  if (!absent(assistant.reasoning) && typeof assistant.reasoning !== "string") return null;
  if (typeof assistant.reasoning_content === "string" && assistant.reasoning_content) return assistant.reasoning_content;
  return typeof assistant.reasoning === "string" && assistant.reasoning ? assistant.reasoning : detailText;
};

const chatReasoning = (assistant: JsonRecord): string | null => {
  const details = assistant.reasoning_details;
  if (!absent(details) && (!Array.isArray(details) || details.length > MAX_ITEMS)) return null;
  const texts: string[] = [];
  for (const detail of Array.isArray(details) ? details : []) {
    if (!record(detail) || detail.type !== "reasoning.text" || typeof detail.text !== "string" || typeof detail.signature !== "string" || !detail.signature)
      return null;
    if (!absent(detail.index) && (typeof detail.index !== "number" || !Number.isSafeInteger(detail.index) || detail.index < 0)) return null;
    texts.push(detail.text);
  }
  return chatReadableReasoning(assistant, texts.join(""));
};

const expectedChatTool = (call: unknown, publication: ChatReplayPublication): JsonRecord | null => {
  if (!record(call) || call.type !== "function" || typeof call.id !== "string" || !call.id || !record(call.function)) return null;
  const name = call.function.name;
  if (typeof name !== "string" || !name || typeof call.function.arguments !== "string") return null;
  const original = publication.toolNames?.get(name) ?? { name, namespace: null };
  const base = { call_id: call.id, name: original.name, namespace: original.namespace };
  if (!publication.customToolNames?.has(name)) return { ...base, type: "function_call", arguments: call.function.arguments };
  try {
    const args: unknown = JSON.parse(call.function.arguments);
    if (!record(args) || Object.keys(args).length !== 1 || typeof args.input !== "string") return null;
    return { call_id: call.id, name: original.name, type: "custom_tool_call", input: args.input };
  } catch {
    return null;
  }
};

const chatContent = (assistant: JsonRecord): JsonRecord[] | null => {
  if ((!absent(assistant.content) && typeof assistant.content !== "string") || (!absent(assistant.refusal) && typeof assistant.refusal !== "string"))
    return null;
  return [
    ...(assistant.content ? [{ type: "output_text", text: assistant.content }] : []),
    ...(assistant.refusal ? [{ type: "refusal", refusal: assistant.refusal }] : []),
  ];
};

const chatMatchesOutput = (publication: ChatReplayPublication): boolean => {
  const { assistant, output } = publication;
  if (!record(assistant) || assistant.role !== "assistant") return false;
  const reasoning = chatReasoning(assistant);
  const content = chatContent(assistant);
  if (reasoning === null || content === null) return false;
  let next = 0;
  if (output.at(next)?.type === "reasoning") {
    if (!reasoning || canonical(output[next].summary) !== canonical([{ type: "summary_text", text: reasoning }])) return false;
    next += 1;
  }
  if (content.length) {
    const item = output.at(next);
    if (item?.type !== "message" || !Array.isArray(item.content) || canonical(item.content.map(publicContent)) !== canonical(content)) return false;
    next += 1;
  }
  if (!absent(assistant.tool_calls) && (!Array.isArray(assistant.tool_calls) || assistant.tool_calls.length > MAX_ITEMS)) return false;
  for (const call of Array.isArray(assistant.tool_calls) ? assistant.tool_calls : []) {
    const expected = expectedChatTool(call, publication);
    const item = output.at(next);
    if (!expected || !item || fingerprint({ ...expected, id: item.id }) !== fingerprint(item)) return false;
    next += 1;
  }
  return next === output.length;
};

const receiptMatchesInput = (receipt: Receipt, input: readonly JsonRecord[], position: number, context: string): boolean => {
  for (let offset = 0; offset < receipt.keys.length; offset += 1) {
    const candidate = input[position + offset];
    if (!record(candidate) || JSON.stringify([context, itemId(candidate)]) !== receipt.keys[offset] || fingerprint(candidate) !== receipt.fingerprints[offset])
      return false;
  }
  return true;
};

const boundedLimit = (value: number | undefined, maximum: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;

/**
 * Process-local, authenticated receipts preserve native signed assistant blocks
 * behind ordinary public item IDs. Restarts/expiry fail closed to Responses.
 * No signature, raw scope, or private encoding enters the public wire or disk.
 */
export const createAnthropicReplayStore = (limits: ReplayLimits = {}) => {
  const now = limits.now ?? Date.now;
  const ttlMs = boundedLimit(limits.ttlMs, TTL_MS);
  const maxEntries = boundedLimit(limits.maxEntries, MAX_ENTRIES);
  const maxBytes = boundedLimit(limits.maxBytes, MAX_BYTES);
  const maxEntryBytes = boundedLimit(limits.maxEntryBytes, MAX_ENTRY_BYTES);
  const receipts = new Set<Receipt>();
  const index = new Map<string, Receipt>();
  let totalBytes = 0;

  const remove = (receipt: Receipt): void => {
    receipts.delete(receipt);
    for (const key of receipt.keys) index.delete(key);
    totalBytes -= receipt.bytes;
  };
  const prune = (at: number): void => {
    for (const receipt of receipts) if (receipt.expiresAt <= at) remove(receipt);
  };

  const publish = (publication: AnthropicReplayContext & { output: readonly JsonRecord[] }, payloadJson: string, transport: Receipt["transport"]): boolean => {
    const context = contextKey(publication);
    if (!context || publication.output.length === 0 || publication.output.length > MAX_ITEMS) return false;
    const fingerprints = publication.output.map(fingerprint);
    if (fingerprints.some((value) => value === null)) return false;
    const keys = publication.output.map((item) => JSON.stringify([context, itemId(item)]));
    if (new Set(keys).size !== keys.length) return false;
    const validFingerprints = fingerprints.filter((value): value is string => value !== null);
    const bytes = new TextEncoder().encode(JSON.stringify([keys, validFingerprints, payloadJson, transport])).byteLength;
    if (bytes > maxEntryBytes || bytes > maxBytes) return false;
    const at = now();
    if (!Number.isFinite(at)) return false;
    prune(at);
    // Never replace a receipt whose public IDs have already been emitted.
    if (keys.some((key) => index.has(key))) return false;
    while (receipts.size >= maxEntries || totalBytes + bytes > maxBytes) {
      const oldest = receipts.values().next().value;
      if (!oldest) return false;
      remove(oldest);
    }
    const receipt = { keys, fingerprints: validFingerprints, payloadJson, transport, expiresAt: at + ttlMs, bytes };
    receipts.add(receipt);
    totalBytes += bytes;
    for (const key of keys) index.set(key, receipt);
    return true;
  };

  const restoreAs = <T extends { type: "native_assistant" | "native_chat_assistant" }>(
    input: readonly JsonRecord[],
    contextValue: AnthropicReplayContext,
    transport: Receipt["transport"],
    entry: (json: string) => T
  ): ({ type: "original"; item: JsonRecord } | T)[] | null => {
    const context = contextKey(contextValue);
    const at = now();
    if (!context || !Number.isFinite(at)) return null;
    prune(at);
    const result: ({ type: "original"; item: JsonRecord } | T)[] = [];
    const used = new Set<Receipt>();
    for (let position = 0; position < input.length; position += 1) {
      const item = input[position];
      if (!record(item)) return null;
      const id = itemId(item);
      const key = JSON.stringify([context, id]);
      const receipt = id ? index.get(key) : undefined;
      if (!receipt) {
        if (item.type === "reasoning" || nativeReplayId(id)) return null;
        result.push({ type: "original", item });
        continue;
      }
      if (receipt.transport !== transport || key !== receipt.keys[0] || used.has(receipt)) return null;
      if (!receiptMatchesInput(receipt, input, position, context)) return null;
      result.push(entry(receipt.payloadJson));
      used.add(receipt);
      position += receipt.keys.length - 1;
    }
    return result;
  };
  const remember = (publication: ReplayPublication): boolean => {
    if (publication.nativeBlocks.length === 0 || publication.nativeBlocks.length > MAX_ITEMS) return false;
    const json = canonical(publication.nativeBlocks);
    if (!json || publication.output.some((item) => fingerprint(item) === null) || !nativeMatchesOutput(publication.nativeBlocks, publication.output))
      return false;
    return publish(publication, json, "messages");
  };
  const rememberChat = (publication: ChatReplayPublication): boolean => {
    const json = canonical(publication.assistant);
    if (!json || publication.output.some((item) => fingerprint(item) === null) || !chatMatchesOutput(publication)) return false;
    return publish(publication, json, "chat");
  };
  const restore = (input: readonly JsonRecord[], context: AnthropicReplayContext): NativeReplayEntry[] | null =>
    restoreAs(input, context, "messages", (json) => ({ type: "native_assistant", blocks: JSON.parse(json) as JsonRecord[] }));
  const restoreChat = (input: readonly JsonRecord[], context: AnthropicReplayContext): AnthropicChatReplayEntry[] | null =>
    restoreAs(input, context, "chat", (json) => ({ type: "native_chat_assistant", message: JSON.parse(json) as JsonRecord }));
  return { remember, restore, rememberChat, restoreChat };
};

const replayStore = createAnthropicReplayStore();
export const rememberAnthropicReplay = replayStore.remember;
export const restoreAnthropicReplay = replayStore.restore;
export const rememberAnthropicChatReplay = replayStore.rememberChat;
export const restoreAnthropicChatReplay = replayStore.restoreChat;
