// Prepared Chat Completions stream translation and reconciliation, extracted from src/openai.ts.

import { type PreflightedResponsesStream, ResponsesStreamError, type ResponsesStreamEvent, type ResponsesStreamIterator } from "../responses-stream.ts";
import { type PreparedResponsesStream } from "../responses-failover-stream.ts";
import { getString, isRecord } from "../utils.ts";
import {
  type ResponseStreamTerminalType,
  type UsageContext,
  type UsageTokens,
  extractUsageTokens,
  recordCompletionUsage,
  recordResponsesEventTelemetry,
  recordStreamTerminalType,
  recordTerminalUsage,
  type MeteredTransportLifecycle,
} from "../openai-telemetry.ts";

export const recordResponsesTerminal = (event: ResponsesStreamEvent, usageContext?: UsageContext): void => {
  if (!event.terminal) return;
  recordResponsesEventTelemetry(usageContext, event);
  recordStreamTerminalType(usageContext, event.type as ResponseStreamTerminalType);
  const usage = isRecord(event.value.response) ? extractUsageTokens(event.value.response.usage) : null;
  if (event.type === "response.completed") void recordCompletionUsage(usageContext, usage);
  else recordTerminalUsage(usageContext, usage, false);
};

const responseHasOutputText = (output: unknown, startIndex = 0): boolean => {
  if (!Array.isArray(output)) return false;
  for (const item of output.slice(startIndex)) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const contentItem of item.content) {
      if (!isRecord(contentItem)) continue;
      if (getString(contentItem.type) === "output_text" && (getString(contentItem.text) ?? "").length > 0) {
        return true;
      }
    }
  }
  return false;
};

const responseHasRefusal = (output: unknown, startIndex = 0): boolean => {
  if (!Array.isArray(output)) return false;
  return output
    .slice(startIndex)
    .some(
      (item) =>
        isRecord(item) &&
        Array.isArray(item.content) &&
        item.content.some((part) => isRecord(part) && part.type === "refusal" && Boolean(getString(part.refusal)))
    );
};

export const reconcileCompletedOutputText = (emittedText: string, completedText: string): string => {
  if (!completedText || completedText === emittedText || emittedText.startsWith(completedText)) return "";
  if (completedText.startsWith(emittedText)) return completedText.slice(emittedText.length);
  return malformedFunctionCallStream("Upstream response output text conflicts with prior text deltas.");
};

export const reconcileCompletedRefusal = (emittedRefusal: string, completedRefusal: string): string => {
  if (!completedRefusal || completedRefusal === emittedRefusal || emittedRefusal.startsWith(completedRefusal)) {
    return "";
  }
  if (completedRefusal.startsWith(emittedRefusal)) return completedRefusal.slice(emittedRefusal.length);
  return malformedFunctionCallStream("Upstream response refusal conflicts with prior refusal deltas.");
};

const chatOutputTextPartIndexText = (value: unknown): string => (typeof value === "number" || typeof value === "string" ? String(value) : "0");

const chatOutputTextPartPositionKey = (event: Record<string, unknown>): string | null => {
  if (typeof event.output_index !== "number" && typeof event.output_index !== "string") return null;
  return `output:${chatOutputTextPartIndexText(event.output_index)}:${chatOutputTextPartIndexText(event.content_index ?? 0)}`;
};

export const chatOutputTextPartKey = (event: Record<string, unknown>): string => {
  const itemId = getString(event.item_id)?.trim();
  if (itemId) return `item:${itemId}:${chatOutputTextPartIndexText(event.content_index ?? 0)}`;
  return `output:${chatOutputTextPartIndexText(event.output_index ?? 0)}:${chatOutputTextPartIndexText(event.content_index ?? 0)}`;
};

export const chatOutputTextPartStorageKey = (event: Record<string, unknown>): string => chatOutputTextPartPositionKey(event) ?? chatOutputTextPartKey(event);

type ReconciledChatContent = Readonly<{ outputText: string; refusal: string }>;

/**
 * True when an identity-less completed part only repeats content this stream has
 * already delivered at the same output/content position. Compatible upstreams
 * repeat the complete message content in their terminal payload, and one that
 * omits the message id there -- Surplus drops `id` inside `response.completed` --
 * may not address the per-part entry its own deltas wrote, so the repeat would
 * otherwise look like new content. A longer or conflicting payload still takes
 * the ordinary path.
 */
const completedPartRepeatsEmittedContent = (emittedParts: ReadonlyMap<string, string>, event: Record<string, unknown>, completed: string): boolean => {
  if (!completed) return false;
  const positionKey = chatOutputTextPartPositionKey(event);
  if (positionKey !== null) {
    const emitted = emittedParts.get(positionKey);
    if (emitted !== undefined) return emitted === completed || emitted.startsWith(completed);
    return false;
  }
  // Without a position, infer a repeat only when the stream has one item-id entry;
  // never let another part's content become this part's deduplication key.
  const unpositioned = [...emittedParts.entries()].filter(([key]) => key.startsWith("item:"));
  if (emittedParts.size !== 1 || unpositioned.length !== 1) return false;
  const [, emitted] = unpositioned[0];
  return emitted === completed || emitted.startsWith(completed);
};

export const reconcileChatContentPart = (
  outputTextParts: Map<string, string>,
  refusalParts: Map<string, string>,
  event: Record<string, unknown>,
  part: unknown
): ReconciledChatContent => {
  if (!isRecord(part) || Array.isArray(part)) {
    return malformedFunctionCallStream("Upstream completed content part is missing its part object.");
  }
  const type = getString(part.type);
  const key = chatOutputTextPartStorageKey(event);
  // Without an item id this part may not address the entry its own deltas wrote.
  const identified = Boolean(getString(event.item_id)?.trim());
  if (type === "output_text" || type === "text") {
    const completedText = getString(part.text);
    if (completedText === null) {
      return malformedFunctionCallStream("Upstream completed content part is missing string output text.");
    }
    if (!identified && !outputTextParts.has(key) && completedPartRepeatsEmittedContent(outputTextParts, event, completedText)) {
      return { outputText: "", refusal: "" };
    }
    const emittedText = outputTextParts.get(key) ?? "";
    const suffix = reconcileCompletedOutputText(emittedText, completedText);
    outputTextParts.set(key, `${emittedText}${suffix}`);
    return { outputText: suffix, refusal: "" };
  }
  if (type === "refusal") {
    const completedRefusal = getString(part.refusal);
    if (completedRefusal === null) {
      return malformedFunctionCallStream("Upstream completed content part is missing string refusal text.");
    }
    if (!identified && !refusalParts.has(key) && completedPartRepeatsEmittedContent(refusalParts, event, completedRefusal)) {
      return { outputText: "", refusal: "" };
    }
    const emittedRefusal = refusalParts.get(key) ?? "";
    const suffix = reconcileCompletedRefusal(emittedRefusal, completedRefusal);
    refusalParts.set(key, `${emittedRefusal}${suffix}`);
    return { outputText: "", refusal: suffix };
  }
  return { outputText: "", refusal: "" };
};

export const reconcileChatOutputItemContent = (
  outputTextParts: Map<string, string>,
  refusalParts: Map<string, string>,
  event: Record<string, unknown>,
  item: unknown
): ReconciledChatContent => {
  if (!isRecord(item) || Array.isArray(item) || !Array.isArray(item.content)) {
    return { outputText: "", refusal: "" };
  }
  let outputText = "";
  let refusal = "";
  for (const [contentIndex, part] of item.content.entries()) {
    const partEvent: Record<string, unknown> = {
      ...event,
      item_id: getString(item.id) ?? event.item_id,
      content_index: contentIndex,
    };
    const reconciled = reconcileChatContentPart(outputTextParts, refusalParts, partEvent, part);
    outputText += reconciled.outputText;
    refusal += reconciled.refusal;
  }
  return { outputText, refusal };
};

/**
 * Some compatible upstreams provide complete message content in response.output
 * before repeating it in the normal final-item events. Reconcile every part
 * through the same per-item maps so either ordering emits each value once.
 */
export const reconcileChatResponseOutputContent = (
  outputTextParts: Map<string, string>,
  refusalParts: Map<string, string>,
  event: Record<string, unknown>,
  output: unknown
): ReconciledChatContent => {
  if (!Array.isArray(output)) return { outputText: "", refusal: "" };
  let outputText = "";
  let refusal = "";
  for (const [outputIndex, item] of output.entries()) {
    const reconciled = reconcileChatOutputItemContent(outputTextParts, refusalParts, { ...event, output_index: outputIndex }, item);
    outputText += reconciled.outputText;
    refusal += reconciled.refusal;
  }
  return { outputText, refusal };
};

export const withAccumulatedResponseText = (response: Record<string, unknown>, text: string, ignoredOutputPrefix = 0): Record<string, unknown> => {
  if (!text || responseHasOutputText(response.output, ignoredOutputPrefix)) return response;
  const output = Array.isArray(response.output) ? [...response.output] : [];
  output.push({
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  });
  return { ...response, output };
};

export const withAccumulatedResponseRefusal = (response: Record<string, unknown>, refusal: string, ignoredOutputPrefix = 0): Record<string, unknown> => {
  if (!refusal || responseHasRefusal(response.output, ignoredOutputPrefix)) return response;
  const output = Array.isArray(response.output) ? [...response.output] : [];
  output.push({
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "refusal", refusal }],
  });
  return { ...response, output };
};

export const withAccumulatedResponseItems = (response: Record<string, unknown>, accumulated: Record<string, unknown>[]): Record<string, unknown> => {
  if (!accumulated.length) return response;
  const output = Array.isArray(response.output) ? response.output.filter(isRecord).map((item) => ({ ...item })) : [];
  const existingIds = new Set(output.map((item) => getString(item.id)).filter(Boolean));
  for (const item of accumulated) {
    const id = getString(item.id);
    if (id && existingIds.has(id)) continue;
    output.push(item);
    if (id) existingIds.add(id);
  }
  return { ...response, output };
};

export type ChatFunctionCall = {
  key: string;
  index: number;
  callId: string;
  name: string;
  arguments: string;
  argumentsDone: boolean;
};

export const malformedFunctionCallStream = (message: string): never => {
  throw new ResponsesStreamError(message, { kind: "malformed_event" });
};

/**
 * Reconciles Responses function-call events into the Chat Completions shape.
 * Both buffered and SSE translations use this one accumulator so a final
 * output item cannot duplicate arguments already emitted as deltas.
 */
export class ChatFunctionCallAccumulator {
  #calls: ChatFunctionCall[] = [];
  #byKey = new Map<string, ChatFunctionCall>();

  get hasCalls(): boolean {
    return this.#calls.length > 0;
  }

  get calls(): readonly ChatFunctionCall[] {
    return this.#calls;
  }

  assertFinalized(): void {
    const unfinished = this.#calls.find((call) => !call.argumentsDone);
    if (unfinished) {
      return malformedFunctionCallStream("Upstream function-call stream ended before finalized arguments were received.");
    }
  }

  has(event: Record<string, unknown>, item?: Record<string, unknown>): boolean {
    const key = this.#key(event, item);
    return Boolean(key && this.#byKey.has(key));
  }

  #key(event: Record<string, unknown>, item?: Record<string, unknown>): string | null {
    const itemId = getString(event.item_id) ?? getString(item?.id);
    if (itemId?.trim()) return `item:${itemId}`;
    const outputIndex = event.output_index;
    if (typeof outputIndex === "number" && Number.isInteger(outputIndex) && outputIndex >= 0) {
      return `output:${outputIndex}`;
    }
    return null;
  }

  #create(event: Record<string, unknown>, item: Record<string, unknown>): ChatFunctionCall {
    if (getString(item.type) !== "function_call") {
      return malformedFunctionCallStream("Upstream function-call event did not contain a function_call item.");
    }
    const key = this.#key(event, item);
    if (!key) return malformedFunctionCallStream("Upstream function-call event omitted item_id and output_index.");
    const callId = getString(item.call_id)?.trim();
    const name = getString(item.name)?.trim();
    // Added items may omit arguments because the argument stream follows.
    const argumentsText = item.arguments === undefined ? "" : getString(item.arguments);
    if (!callId || !name || argumentsText === null) {
      return malformedFunctionCallStream("Upstream function-call item is missing call_id, name, or string arguments.");
    }
    const existing = this.#byKey.get(key);
    if (existing) {
      if (existing.callId !== callId || existing.name !== name) {
        return malformedFunctionCallStream("Upstream function-call item changed its call_id or name.");
      }
      this.#reconcileArguments(existing, argumentsText);
      return existing;
    }
    const call: ChatFunctionCall = {
      key,
      index: this.#calls.length,
      callId,
      name,
      arguments: argumentsText,
      argumentsDone: false,
    };
    this.#calls.push(call);
    this.#byKey.set(key, call);
    return call;
  }

  #reconcileArguments(call: ChatFunctionCall, finalArguments: string): string {
    if (finalArguments === call.arguments) return "";
    if (!finalArguments.startsWith(call.arguments)) {
      return malformedFunctionCallStream("Upstream function-call arguments conflict with prior argument deltas.");
    }
    const suffix = finalArguments.slice(call.arguments.length);
    call.arguments = finalArguments;
    return suffix;
  }

  add(event: Record<string, unknown>, item: unknown): Readonly<{ call: ChatFunctionCall; includeIdentity: boolean; suffix: string }> | null {
    if (!isRecord(item) || Array.isArray(item) || getString(item.type) !== "function_call") return null;
    const existing = this.#byKey.get(this.#key(event, item) ?? "");
    const priorArguments = existing?.arguments;
    const call = this.#create(event, item);
    return {
      call,
      includeIdentity: !existing,
      suffix: priorArguments === undefined ? call.arguments : call.arguments.slice(priorArguments.length),
    };
  }

  delta(event: Record<string, unknown>): Readonly<{ call: ChatFunctionCall; delta: string }> {
    const key = this.#key(event);
    const call = key ? this.#byKey.get(key) : undefined;
    if (!call) return malformedFunctionCallStream("Upstream function-call argument delta has no matching item.");
    if (call.argumentsDone) {
      return malformedFunctionCallStream("Upstream function-call emitted arguments after its completion event.");
    }
    const delta = getString(event.delta);
    if (delta === null) return malformedFunctionCallStream("Upstream function-call argument delta is not a string.");
    call.arguments += delta;
    return { call, delta };
  }

  done(event: Record<string, unknown>): Readonly<{ call: ChatFunctionCall; suffix: string }> {
    const key = this.#key(event);
    const call = key ? this.#byKey.get(key) : undefined;
    if (!call) return malformedFunctionCallStream("Upstream function-call completion has no matching item.");
    const finalArguments = getString(event.arguments);
    if (finalArguments === null) {
      return malformedFunctionCallStream("Upstream function-call completion is missing string arguments.");
    }
    if (call.argumentsDone) {
      if (finalArguments !== call.arguments) {
        return malformedFunctionCallStream("Upstream function-call completion changed finalized arguments.");
      }
      return { call, suffix: "" };
    }
    const suffix = this.#reconcileArguments(call, finalArguments);
    call.argumentsDone = true;
    return { call, suffix };
  }

  reconcileItem(event: Record<string, unknown>, item: unknown): Readonly<{ call: ChatFunctionCall; suffix: string }> | null {
    if (!isRecord(item) || Array.isArray(item) || getString(item.type) !== "function_call") return null;
    const key = this.#key(event, item);
    const existing = key ? this.#byKey.get(key) : undefined;
    // An item that is done or appears in final output, on the other hand,
    // must carry a concrete arguments string. Accepting a missing value would
    // emit a successful terminal for a malformed upstream function call.
    const argumentsText = getString(item.arguments);
    if (argumentsText === null) {
      return malformedFunctionCallStream("Upstream function-call item is missing string arguments.");
    }
    if (!existing) {
      const created = this.#create(event, item);
      created.argumentsDone = true;
      return { call: created, suffix: created.arguments };
    }
    if (existing.callId !== getString(item.call_id)?.trim() || existing.name !== getString(item.name)?.trim()) {
      return malformedFunctionCallStream("Upstream function-call item changed its call_id or name.");
    }
    if (existing.argumentsDone) {
      if (argumentsText !== existing.arguments) {
        return malformedFunctionCallStream("Upstream function-call item changed finalized arguments.");
      }
      return { call: existing, suffix: "" };
    }
    const suffix = this.#reconcileArguments(existing, argumentsText);
    existing.argumentsDone = true;
    return { call: existing, suffix };
  }

  reconcileOutput(event: Record<string, unknown>, output: unknown): Readonly<{ call: ChatFunctionCall; suffix: string }>[] {
    if (!Array.isArray(output)) return [];
    const reconciled: Readonly<{ call: ChatFunctionCall; suffix: string }>[] = [];
    for (const item of output) {
      const result = this.reconcileItem(event, item);
      if (result) reconciled.push(result);
    }
    return reconciled;
  }
}

const applyPreparedChatEvent = (
  event: ResponsesStreamEvent,
  state: {
    outputText: string;
    refusal: string;
    outputTextParts: Map<string, string>;
    refusalParts: Map<string, string>;
    functionCalls: ChatFunctionCallAccumulator;
    completed: boolean;
  }
): string | null => {
  const ev = event.value;
  switch (event.type) {
    case "response.output_text.delta": {
      const delta = getString(ev.delta);
      if (delta === null) return "Upstream output-text delta is not a string.";
      const key = chatOutputTextPartStorageKey(ev);
      state.outputTextParts.set(key, `${state.outputTextParts.get(key) ?? ""}${delta}`);
      state.outputText += delta;
      break;
    }
    case "response.output_text.done": {
      const completedText = getString(ev.text);
      if (completedText === null) {
        return "Upstream completed output text is not a string.";
      }
      const key = chatOutputTextPartStorageKey(ev);
      const partText = state.outputTextParts.get(key) ?? "";
      const suffix = reconcileCompletedOutputText(partText, completedText);
      state.outputTextParts.set(key, `${partText}${suffix}`);
      state.outputText += suffix;
      break;
    }
    case "response.refusal.delta": {
      const delta = getString(ev.delta);
      if (delta === null) return "Upstream refusal delta is not a string.";
      const key = chatOutputTextPartStorageKey(ev);
      state.refusalParts.set(key, `${state.refusalParts.get(key) ?? ""}${delta}`);
      state.refusal += delta;
      break;
    }
    case "response.refusal.done": {
      const completedRefusal = getString(ev.refusal);
      if (completedRefusal === null) {
        return "Upstream completed refusal is not a string.";
      }
      const key = chatOutputTextPartStorageKey(ev);
      const partRefusal = state.refusalParts.get(key) ?? "";
      const suffix = reconcileCompletedRefusal(partRefusal, completedRefusal);
      state.refusalParts.set(key, `${partRefusal}${suffix}`);
      state.refusal += suffix;
      break;
    }
    case "response.content_part.done": {
      const reconciled = reconcileChatContentPart(state.outputTextParts, state.refusalParts, ev, ev.part);
      state.outputText += reconciled.outputText;
      state.refusal += reconciled.refusal;
      break;
    }
    case "response.output_item.added":
      state.functionCalls.add(ev, ev.item);
      break;
    case "response.function_call_arguments.delta":
      state.functionCalls.delta(ev);
      break;
    case "response.function_call_arguments.done":
      state.functionCalls.done(ev);
      break;
    case "response.output_item.done": {
      const functionCall = state.functionCalls.reconcileItem(ev, ev.item);
      if (!functionCall) {
        const reconciled = reconcileChatOutputItemContent(state.outputTextParts, state.refusalParts, ev, ev.item);
        state.outputText += reconciled.outputText;
        state.refusal += reconciled.refusal;
      }
      break;
    }
    case "response.output": {
      const output = ev.output ?? (isRecord(ev.response) ? ev.response.output : undefined);
      const reconciled = reconcileChatResponseOutputContent(state.outputTextParts, state.refusalParts, ev, output);
      state.outputText += reconciled.outputText;
      state.refusal += reconciled.refusal;
      state.functionCalls.reconcileOutput(ev, output);
      break;
    }
    case "response.completed": {
      if (!isRecord(ev.response) || Array.isArray(ev.response)) {
        return "Upstream response.completed event is missing its response object.";
      }
      const reconciled = reconcileChatResponseOutputContent(state.outputTextParts, state.refusalParts, ev, ev.response.output);
      state.outputText += reconciled.outputText;
      state.refusal += reconciled.refusal;
      state.functionCalls.reconcileOutput(ev, ev.response.output);
      state.functionCalls.assertFinalized();
      state.completed = true;
      break;
    }
    default:
      break;
  }
  return null;
};

export const preparedChatCompletionIsEmpty = (prepared: PreparedResponsesStream): boolean => {
  const state = {
    outputText: "",
    refusal: "",
    outputTextParts: new Map<string, string>(),
    refusalParts: new Map<string, string>(),
    functionCalls: new ChatFunctionCallAccumulator(),
    completed: false,
  };

  for (const event of prepared.buffered) {
    const malformedMessage = applyPreparedChatEvent(event, state);
    if (malformedMessage !== null) return malformedFunctionCallStream(malformedMessage);
  }

  if (!state.completed) {
    return malformedFunctionCallStream("Chat semantic preflight did not retain a completed terminal.");
  }
  return !state.outputText && !state.refusal && !state.functionCalls.hasCalls;
};

export const chatToolCallDelta = (
  call: ChatFunctionCall,
  options: Readonly<{ includeIdentity: boolean; argumentsDelta?: string }> = { includeIdentity: false }
): Record<string, unknown> => {
  const fn: Record<string, unknown> = {};
  if (options.includeIdentity) fn.name = call.name;
  if (options.argumentsDelta !== undefined) fn.arguments = options.argumentsDelta;
  const value: Record<string, unknown> = { index: call.index, function: fn };
  if (options.includeIdentity) {
    value.id = call.callId;
    value.type = "function";
  }
  return value;
};

export const chatSourceFromPrepared = (source: PreflightedResponsesStream, prepared: PreparedResponsesStream): PreflightedResponsesStream => {
  const first = prepared.buffered.at(0);
  if (!first) throw new ResponsesStreamError("Chat preflight did not retain its first event.", { kind: "read_error" });
  const iterator = (async function* (): ResponsesStreamIterator {
    try {
      for (const event of prepared.buffered.slice(1)) yield event;
      for await (const event of prepared.iterator) yield event;
      return undefined;
    } finally {
      await prepared.iterator.return("Chat prepared stream closed").catch(() => {});
    }
  })();
  return {
    first,
    iterator,
    cancel: async (reason?: unknown): Promise<void> => {
      await source.cancel(reason);
      await iterator.return(reason).catch(() => {});
    },
  };
};

export const EMPTY_UPSTREAM_COMPLETION_MESSAGE = "Upstream response completed with no translated semantic output.";

export const emptyUpstreamCompletionError = (): Record<string, unknown> => ({
  error: {
    message: EMPTY_UPSTREAM_COMPLETION_MESSAGE,
    type: "server_error",
    code: "empty_upstream_completion",
    param: null,
  },
});

export const markChatSemanticOutput = (context: UsageContext | undefined): void => {
  if (context?.responseTelemetry) context.responseTelemetry.semanticOutputObserved = true;
};

export const markFinalizedChatToolOutput = (context: UsageContext | undefined, functionCalls: ChatFunctionCallAccumulator): void => {
  if (functionCalls.calls.some((call) => call.argumentsDone)) markChatSemanticOutput(context);
};

export const translatedChatOutputObserved = (outputText: string, refusal: string, functionCalls: ChatFunctionCallAccumulator): boolean =>
  outputText.length > 0 || refusal.length > 0 || functionCalls.hasCalls;

export const recordSuccessfulChatCompletion = async (
  context: UsageContext | undefined,
  lifecycle: MeteredTransportLifecycle,
  usage: UsageTokens | null,
  onResponseTerminal?: (terminalType: ResponseStreamTerminalType) => void
): Promise<void> => {
  markChatSemanticOutput(context);
  onResponseTerminal?.("response.completed");
  lifecycle.terminal("response.completed", usage);
  recordStreamTerminalType(context, "response.completed");
  await recordCompletionUsage(context, usage);
};

export const recordEmptyUpstreamCompletion = (
  context: UsageContext | undefined,
  lifecycle: MeteredTransportLifecycle,
  usage: UsageTokens | null,
  onResponseTerminal?: (terminalType: ResponseStreamTerminalType) => void
): void => {
  if (context?.responseTelemetry) {
    context.responseTelemetry.failureKind = "empty_upstream_completion";
    context.responseTelemetry.semanticOutputObserved = false;
  }
  onResponseTerminal?.("error");
  lifecycle.terminal("response.failed", usage);
  recordStreamTerminalType(context, "error");
  recordTerminalUsage(context, usage, false);
};
