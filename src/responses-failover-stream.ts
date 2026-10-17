import {
  RESPONSES_TERMINAL_EVENT_TYPES,
  ResponsesStreamError,
  type ResponsesStreamEvent,
  type ResponsesStreamFailureKind,
  type ResponsesStreamIterator,
} from "./responses-stream.ts";
import { getString, isRecord } from "./utils.ts";

export type ResponsesSemanticKind = "text" | "tool_call";

export const MAX_RESPONSES_PRECOMMIT_EVENTS = 10_000;
export const MAX_RESPONSES_PRECOMMIT_CHARS = 32 * 1024 * 1024;

const textTypes = new Set(["response.output_text.delta", "response.output_text.done"]);
const refusalTypes = new Set(["response.refusal.delta", "response.refusal.done"]);
const reasoningTextProgressFields: ReadonlyMap<string, "delta" | "text"> = new Map([
  ["response.reasoning_summary_text.delta", "delta"],
  ["response.reasoning_summary_text.done", "text"],
  ["response.reasoning_text.delta", "delta"],
  ["response.reasoning_text.done", "text"],
]);
const reasoningSummaryPartProgressTypes = new Set(["response.reasoning_summary_part.added", "response.reasoning_summary_part.done"]);
const executableToolTypes = new Set(["function_call", "custom_tool_call"]);
const hostedToolTypes = new Set(["code_interpreter_call", "computer_call", "file_search_call", "image_generation_call", "mcp_call", "web_search_call"]);
const hostedToolCompletedEventTypes = new Set([...hostedToolTypes].map((type) => `response.${type}.completed`));
const hostedToolTerminalEventTypes = new Set([
  ...hostedToolCompletedEventTypes,
  ...[...hostedToolTypes].map((type) => `response.${type}.in_progress`),
  ...[...hostedToolTypes].map((type) => `response.${type}.failed`),
]);
const imagePartialEventType = "response.image_generation_call.partial_image";

const nonEmptyText = (value: Record<string, unknown>): boolean => [value.delta, value.text].some((item) => typeof item === "string" && item.length > 0);

const nonEmptyString = (value: unknown): boolean => typeof value === "string" && value.length > 0;

const nonEmptyTrimmedString = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

/** An executable tool call is only semantic once its identity and payload are both present. */
const executableToolCallKind = (item: Record<string, unknown>): ResponsesSemanticKind | null => {
  const itemType = item.type;
  if (typeof itemType !== "string" || !executableToolTypes.has(itemType)) return null;
  if (!nonEmptyTrimmedString(item.call_id) || !nonEmptyTrimmedString(item.name)) return null;
  if (itemType === "function_call") return typeof item.arguments === "string" ? "tool_call" : null;
  return typeof item.input === "string" ? "tool_call" : null;
};

/** A hosted tool call item is semantic once it carries one of the three lifecycle statuses. */
const hostedToolItemKind = (item: Record<string, unknown>): ResponsesSemanticKind | null => {
  if (typeof item.type !== "string" || !hostedToolTypes.has(item.type)) return null;
  if (item.status !== "in_progress" && item.status !== "completed" && item.status !== "failed") return null;
  return "tool_call";
};

const outputContentPartHasText = (part: unknown): boolean =>
  isRecord(part) &&
  (((part.type === "output_text" || part.type === "text") && nonEmptyString(part.text)) || (part.type === "refusal" && nonEmptyString(part.refusal)));

/** Classifies one `output` entry exactly as the upstream providers shape them. */
const semanticKindFromOutputItem = (item: unknown, ignoredOutputItemId: string | null): ResponsesSemanticKind | null => {
  if (!isRecord(item) || Array.isArray(item)) return null;
  if (ignoredOutputItemId !== null && getString(item.id)?.trim() === ignoredOutputItemId) return null;
  const executableKind = executableToolCallKind(item);
  if (executableKind) return executableKind;
  const hostedKind = hostedToolItemKind(item);
  if (hostedKind) return hostedKind;
  if (item.type === "reasoning") return null;
  const content = item.content;
  if (!Array.isArray(content)) return null;
  if (content.some(outputContentPartHasText)) return "text";
  return null;
};

const semanticKindFromOutput = (output: unknown, ignoredOutputItemId: string | null = null): ResponsesSemanticKind | null => {
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    const kind = semanticKindFromOutputItem(item, ignoredOutputItemId);
    if (kind) return kind;
  }
  return null;
};

const contentPartSemanticKind = (part: Record<string, unknown>): ResponsesSemanticKind | null => {
  if ((part.type === "output_text" || part.type === "text") && nonEmptyString(part.text)) return "text";
  if (part.type === "refusal" && nonEmptyString(part.refusal)) return "text";
  return null;
};

const imagePartialSemanticKind = (value: Record<string, unknown>): ResponsesSemanticKind | null =>
  [value.partial_image_b64, value.partial_image, value.result].some(nonEmptyString) ? "tool_call" : null;

/** Text-bearing events decide their kind from their own fields; `undefined` means undecided. */
const textBearingEventSemanticKind = (event: ResponsesStreamEvent): ResponsesSemanticKind | null | undefined => {
  if (textTypes.has(event.type)) return nonEmptyText(event.value) ? "text" : null;
  if (refusalTypes.has(event.type)) return nonEmptyText(event.value) || nonEmptyString(event.value.refusal) ? "text" : null;
  if (event.type !== "response.content_part.done") return undefined;
  const part = event.value.part;
  if (!isRecord(part)) return undefined;
  const partKind = contentPartSemanticKind(part);
  if (partKind !== null) return partKind;
  return undefined;
};

/** Decides a kind from the event itself, without inspecting any output payload. */
const directResponsesEventSemanticKind = (event: ResponsesStreamEvent): ResponsesSemanticKind | null | undefined => {
  const textKind = textBearingEventSemanticKind(event);
  if (textKind !== undefined) return textKind;
  if (hostedToolTerminalEventTypes.has(event.type)) return "tool_call";
  if (event.type === imagePartialEventType) return imagePartialSemanticKind(event.value);
  return undefined;
};

const outputItemEventSemanticKind = (
  event: ResponsesStreamEvent,
  item: Record<string, unknown>,
  ignoredOutputItemId: string | null
): ResponsesSemanticKind | null => {
  const itemType = getString(item.type) ?? "";
  if (event.type === "response.output_item.done" && executableToolTypes.has(itemType)) return executableToolCallKind(item);
  if (hostedToolTypes.has(itemType)) return semanticKindFromOutput([item], ignoredOutputItemId);
  if (event.type === "response.output_item.added") return null;
  return semanticKindFromOutput([item], ignoredOutputItemId);
};

/** Lifecycle output items decide their kind from the item alone; `undefined` means undecided. */
const outputItemResponsesEventSemanticKind = (event: ResponsesStreamEvent, ignoredOutputItemId: string | null): ResponsesSemanticKind | null | undefined => {
  const isOutputItemEvent = event.type === "response.output_item.added" || event.type === "response.output_item.done";
  const item = event.value.item;
  if (!isOutputItemEvent || !isRecord(item)) return undefined;
  return outputItemEventSemanticKind(event, item, ignoredOutputItemId);
};

const outputPayloadSemanticKind = (event: ResponsesStreamEvent, ignoredOutputItemId: string | null): ResponsesSemanticKind | null => {
  const valueResponse = event.value.response;
  if (isRecord(valueResponse) && !Array.isArray(valueResponse)) return semanticKindFromOutput(valueResponse.output, ignoredOutputItemId);
  return semanticKindFromOutput(event.value.output, ignoredOutputItemId);
};

const responsesEventSemanticKindWithIgnoredOutputItem = (event: ResponsesStreamEvent, ignoredOutputItemId: string | null): ResponsesSemanticKind | null => {
  const directKind = directResponsesEventSemanticKind(event);
  if (directKind !== undefined) return directKind;
  const itemKind = outputItemResponsesEventSemanticKind(event, ignoredOutputItemId);
  if (itemKind !== undefined) return itemKind;
  return outputPayloadSemanticKind(event, ignoredOutputItemId);
};

export const responsesEventSemanticKind = (event: ResponsesStreamEvent): ResponsesSemanticKind | null =>
  responsesEventSemanticKindWithIgnoredOutputItem(event, null);

/** Buffered Responses payloads use the same answer-bearing output-item rule as streamed events. */
export const responsesPayloadHasAnswerBearingOutput = (payload: Record<string, unknown>): boolean => semanticKindFromOutput(payload.output) !== null;

/** Reports active hidden-reasoning work without classifying it as client-visible output. */
export const responsesEventReportsProgress = (event: ResponsesStreamEvent): boolean => {
  const textField = reasoningTextProgressFields.get(event.type);
  if (textField) {
    const value = event.value[textField];
    const index = event.type.startsWith("response.reasoning_summary_") ? event.value.summary_index : event.value.content_index;
    return typeof value === "string" && value.length > 0 && typeof index === "number" && Number.isSafeInteger(index) && index >= 0;
  }
  if (reasoningSummaryPartProgressTypes.has(event.type)) {
    const summaryIndex = event.value.summary_index;
    return typeof summaryIndex === "number" && Number.isSafeInteger(summaryIndex) && summaryIndex >= 0;
  }
  if (
    (event.type === "response.output_item.added" || event.type === "response.output_item.done") &&
    isRecord(event.value.item) &&
    !Array.isArray(event.value.item) &&
    event.value.item.type === "reasoning"
  ) {
    const itemId = getString(event.value.item.id)?.trim();
    return Boolean(itemId) && (Array.isArray(event.value.item.summary) || Array.isArray(event.value.item.content));
  }
  return false;
};

const reasoningLifecycleProgressKey = (event: ResponsesStreamEvent): string | null => {
  if (reasoningSummaryPartProgressTypes.has(event.type)) {
    return `${event.type}:${getString(event.value.item_id) ?? ""}:${String(event.value.summary_index)}`;
  }
  if (
    (event.type === "response.output_item.added" || event.type === "response.output_item.done") &&
    isRecord(event.value.item) &&
    !Array.isArray(event.value.item) &&
    event.value.item.type === "reasoning"
  ) {
    const itemId = getString(event.value.item.id)?.trim();
    return itemId ? `${event.type}:${itemId}` : null;
  }
  return null;
};

export type PreparedResponsesStream = Readonly<{
  iterator: ResponsesStreamIterator;
  buffered: ResponsesStreamEvent[];
  bufferedChars: number;
  semantic: ResponsesStreamEvent | null;
  semanticKind: ResponsesSemanticKind | null;
  terminal: ResponsesStreamEvent | null;
}>;

export const appendResponsesPrecommitEvent = (buffered: ResponsesStreamEvent[], event: ResponsesStreamEvent, bufferedChars: number): number => {
  const nextChars = bufferedChars + event.raw.length;
  if (buffered.length >= MAX_RESPONSES_PRECOMMIT_EVENTS || nextChars > MAX_RESPONSES_PRECOMMIT_CHARS) {
    throw new ResponsesStreamError("Upstream Responses precommit buffer exceeded its limit.", {
      kind: "event_too_large",
    });
  }
  buffered.push(event);
  return nextChars;
};

/** Reads the next upstream event, normalizing iterator exhaustion to `null`. */
const nextUpstreamEvent = async (iterator: ResponsesStreamIterator): Promise<ResponsesStreamEvent | null> => {
  const next = await iterator.next();
  if (next.done) return null;
  return next.value;
};

/**
 * Reports lifecycle progress at most once per key. Returns whether the caller must
 * release the stream now, which is only requested while `releaseOnProgress` is set.
 */
const reportProgressOnce = (
  event: ResponsesStreamEvent,
  reportedLifecycleProgress: Set<string>,
  options: { onProgress?: (event: ResponsesStreamEvent) => void; releaseOnProgress?: boolean }
): boolean => {
  if (!responsesEventReportsProgress(event)) return false;
  const lifecycleKey = reasoningLifecycleProgressKey(event);
  if (lifecycleKey !== null && reportedLifecycleProgress.has(lifecycleKey)) return false;
  if (lifecycleKey !== null) reportedLifecycleProgress.add(lifecycleKey);
  options.onProgress?.(event);
  return Boolean(options.releaseOnProgress);
};

/** Holds all provider events until semantic output or a valid terminal owns the attempt. */
export const prepareResponsesStreamForCommit = async (
  iterator: ResponsesStreamIterator,
  options: Readonly<{
    onEvent?: (event: ResponsesStreamEvent) => void;
    onProgress?: (event: ResponsesStreamEvent) => void;
    releaseOnProgress?: boolean;
  }> = {}
): Promise<PreparedResponsesStream> => {
  const buffered: ResponsesStreamEvent[] = [];
  const reportedLifecycleProgress = new Set<string>();
  let bufferedChars = 0;
  try {
    for (;;) {
      const event = await nextUpstreamEvent(iterator);
      if (!event) {
        throw new ResponsesStreamError("Upstream Responses stream ended before semantic output.", {
          kind: "premature_eof",
        });
      }
      bufferedChars = appendResponsesPrecommitEvent(buffered, event, bufferedChars);
      options.onEvent?.(event);
      if (reportProgressOnce(event, reportedLifecycleProgress, options)) {
        return {
          iterator,
          buffered,
          bufferedChars,
          semantic: null,
          semanticKind: null,
          terminal: null,
        };
      }
      const semanticKind = responsesEventSemanticKind(event);
      if (semanticKind) {
        return {
          iterator,
          buffered,
          bufferedChars,
          semantic: event,
          semanticKind,
          terminal: event.terminal ? event : null,
        };
      }
      if (event.terminal) {
        return { iterator, buffered, bufferedChars, semantic: null, semanticKind: null, terminal: event };
      }
    }
  } catch (error) {
    await iterator.return(error).catch(() => {});
    throw error;
  }
};

const sseRaw = (value: Record<string, unknown>): string => `event: ${getString(value.type) ?? "message"}\ndata: ${JSON.stringify(value)}\n\n`;

export const responseEventFromValue = (value: Record<string, unknown>): ResponsesStreamEvent => {
  const type = getString(value.type)?.trim();
  if (!type) throw new ResponsesStreamError("Responses event rewrite omitted type.", { kind: "malformed_event" });
  return {
    raw: sseRaw(value),
    value,
    type,
    terminal: RESPONSES_TERMINAL_EVENT_TYPES.has(type),
  };
};

const incrementOutputIndex = (value: unknown): unknown => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value + 1 : value);

const withResponseOutputPrefix = (response: Record<string, unknown>, warningItem: Record<string, unknown>): Record<string, unknown> => ({
  ...response,
  output: [warningItem, ...(Array.isArray(response.output) ? response.output : [])],
});

export const rewriteResponsesEventForWarning = (
  event: ResponsesStreamEvent,
  warningItem: Record<string, unknown>,
  sequenceNumber: number
): ResponsesStreamEvent => {
  const value: Record<string, unknown> = { ...event.value, sequence_number: sequenceNumber };
  if (Object.prototype.hasOwnProperty.call(value, "output_index")) {
    value.output_index = incrementOutputIndex(value.output_index);
  }
  if (
    (event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") &&
    isRecord(value.response) &&
    !Array.isArray(value.response)
  ) {
    value.response = withResponseOutputPrefix(value.response, warningItem);
  }
  return responseEventFromValue(value);
};

export const rewriteResponsesEventSequence = (event: ResponsesStreamEvent, sequenceNumber: number): ResponsesStreamEvent =>
  responseEventFromValue({ ...event.value, sequence_number: sequenceNumber });

/** The single source of truth for the warning text this gateway injects. */
export const failoverWarningText = (actualModel: string): string =>
  `⚠ Failover active: this response is from \`removed_provider:${actualModel}\` because the Codex upstream was unavailable.`;

const FAILOVER_WARNING_ID_PREFIX = "msg_failover_";
const FAILOVER_WARNING_PREFIX = "⚠ Failover active: this response is from `removed_provider:";
const FAILOVER_WARNING_SUFFIX = "` because the Codex upstream was unavailable.";

/**
 * Identifies an assistant item this gateway injected as a failover notice, so a
 * replayed conversation does not send the notice back upstream as if the user
 * or the model had written it. The id prefix alone is not enough: it is
 * attacker-controllable input, so the shape and the exact text are checked too.
 */
export const isGatewayFailoverWarningItem = (value: unknown): boolean => {
  if (!isRecord(value) || Array.isArray(value) || value.type !== "message" || value.role !== "assistant") return false;
  const id = getString(value.id);
  if (!id?.startsWith(FAILOVER_WARNING_ID_PREFIX)) return false;
  if (!Array.isArray(value.content) || value.content.length !== 1) return false;
  const content = value.content[0];
  if (!isRecord(content) || Array.isArray(content) || content.type !== "output_text") return false;
  const text = getString(content.text);
  return (
    !!text &&
    text.startsWith(FAILOVER_WARNING_PREFIX) &&
    text.endsWith(FAILOVER_WARNING_SUFFIX) &&
    text.length > FAILOVER_WARNING_PREFIX.length + FAILOVER_WARNING_SUFFIX.length
  );
};

export const buildFailoverWarningEvents = (
  actualModel: string,
  responseId: string,
  startingSequenceNumber = 0
): Readonly<{ item: Record<string, unknown>; events: ResponsesStreamEvent[] }> => {
  const itemId = `msg_failover_${crypto.randomUUID().replace(/-/g, "")}`;
  const text = failoverWarningText(actualModel);
  const content = { type: "output_text", text, annotations: [] };
  const item: Record<string, unknown> = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [content],
  };
  const values: Record<string, unknown>[] = [
    {
      type: "response.output_item.added",
      response_id: responseId,
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.content_part.done",
      response_id: responseId,
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: content,
    },
    {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: 0,
      item,
    },
  ].map((value, index) => ({ ...value, sequence_number: startingSequenceNumber + index }));
  return { item, events: values.map(responseEventFromValue) };
};

const idsFromEvent = (event: ResponsesStreamEvent): string[] => {
  const ids: string[] = [];
  const direct = getString(event.value.response_id)?.trim();
  if (direct) ids.push(direct);
  if (isRecord(event.value.response) && !Array.isArray(event.value.response)) {
    const nested = getString(event.value.response.id)?.trim();
    if (nested) ids.push(nested);
  }
  return ids;
};

export const responseIdFromEvents = (events: readonly ResponsesStreamEvent[]): string | null => {
  let responseId: string | null = null;
  for (const event of events) {
    for (const candidate of idsFromEvent(event)) {
      if (responseId && responseId !== candidate) {
        throw new ResponsesStreamError("Upstream Responses stream changed response identifiers.", {
          kind: "malformed_event",
        });
      }
      responseId = candidate;
    }
  }
  return responseId;
};

const syntheticFailureEvents = new WeakSet<ResponsesStreamEvent>();

export type OwnedResponsesStreamFailureDetails = Readonly<{
  failureKind: ResponsesStreamFailureKind;
  responseCreatedObserved: boolean;
  semanticCommitmentObserved: boolean;
  syntheticTerminalType: "response.failed" | "error" | null;
  upstreamTerminal: ResponsesStreamEvent | null;
}>;

export const failureEventAfterCommit = (
  responseId: string,
  sequenceNumber: number,
  output: readonly Record<string, unknown>[] = [],
  responseTemplate: Readonly<Record<string, unknown>> = {}
): ResponsesStreamEvent => {
  const event = responseEventFromValue({
    type: "response.failed",
    sequence_number: sequenceNumber,
    response: {
      ...responseTemplate,
      id: responseId,
      object: getString(responseTemplate.object) ?? "response",
      status: "failed",
      error: {
        code: "server_error",
        message: "The upstream stream ended unexpectedly.",
      },
      output: [...output],
    },
  });
  syntheticFailureEvents.add(event);
  return event;
};

const errorEventAfterCommit = (sequenceNumber: number): ResponsesStreamEvent => {
  const event = responseEventFromValue({
    type: "error",
    sequence_number: sequenceNumber,
    code: "server_error",
    message: "The upstream stream ended unexpectedly.",
    param: null,
  });
  syntheticFailureEvents.add(event);
  return event;
};

const EMPTY_UPSTREAM_COMPLETION_MESSAGE = "Upstream response completed with no translated semantic output.";

const emptyCompletionEventAfterCommit = (sequenceNumber: number): ResponsesStreamEvent => {
  const event = responseEventFromValue({
    type: "error",
    sequence_number: sequenceNumber,
    code: "empty_upstream_completion",
    message: EMPTY_UPSTREAM_COMPLETION_MESSAGE,
    param: null,
  });
  syntheticFailureEvents.add(event);
  return event;
};

export const isSyntheticResponsesFailureEvent = (event: ResponsesStreamEvent): boolean => syntheticFailureEvents.has(event);

type OwnedResponsesStreamOptions = Readonly<{
  initial: readonly ResponsesStreamEvent[];
  iterator: ResponsesStreamIterator;
  responseId: string | null;
  warning?: Readonly<{ model: string }>;
  signal?: AbortSignal;
  downstreamSignal?: AbortSignal;
  abortUpstream?: (reason?: unknown) => void;
  onEvent?: (event: ResponsesStreamEvent) => void | Promise<void>;
  validateEvent?: (event: ResponsesStreamEvent) => void;
  onFailure?: (error: unknown, details: OwnedResponsesStreamFailureDetails) => void | Promise<void>;
  onCancel?: (reason: unknown) => void | Promise<void>;
}>;

const invoke = (callback: (() => void | Promise<void>) | undefined): void => {
  if (!callback) return;
  try {
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    // Observability callbacks never own stream delivery.
  }
};

/** Maps delta/done event types onto the field that carries their text payload. */
const textFieldForEventType = (eventType: string): "delta" | "text" | "refusal" | null => {
  if (eventType === "response.output_text.delta" || eventType === "response.refusal.delta") return "delta";
  if (eventType === "response.output_text.done") return "text";
  if (eventType === "response.refusal.done") return "refusal";
  return null;
};

/** Setup events that may precede the failover warning instead of following it. */
const isLeadingSetupEvent = (event: ResponsesStreamEvent): boolean => event.type === "response.in_progress" || event.type === "response.queued";

/** The trailing lifecycle segment of a hosted-tool event type (`response.<tool>.<lifecycle>`). */
const hostedToolLifecycle = (eventType: string): string => eventType.slice(eventType.lastIndexOf(".") + 1);

/** Maps a hosted-tool lifecycle segment onto the recovered output item status. */
const hostedToolItemStatus = (lifecycle: string): string => {
  if (lifecycle === "completed") return "completed";
  if (lifecycle === "failed") return "failed";
  return "in_progress";
};

/** The synthetic terminal type reported with a failure event, when it is one. */
const syntheticTerminalTypeOf = (event: ResponsesStreamEvent): "response.failed" | "error" | null =>
  event.type === "response.failed" || event.type === "error" ? event.type : null;

/** Builds the error reported when the upstream stream ended without a terminal. */
const prematureEofError = (): ResponsesStreamError =>
  new ResponsesStreamError("Responses stream ended without a terminal.", {
    kind: "premature_eof",
  });

type WarningPreambleContext = {
  initial: ResponsesStreamEvent[];
  queue: ResponsesStreamEvent[];
  responseId: string;
  warningModel: string;
  sequenceNumber: number;
  validateEvent?: (event: ResponsesStreamEvent) => void;
  originalUpstreamEvents: WeakMap<ResponsesStreamEvent, ResponsesStreamEvent>;
};

/**
 * Consumes the RemovedProvider preamble: `response.created` is re-sequenced first, the leading
 * setup events follow it, the failover warning is inserted, and everything else is rewritten.
 */
const queueWarningPreamble = (context: WarningPreambleContext): Readonly<{ item: Record<string, unknown>; sequenceNumber: number }> => {
  const { initial, queue, originalUpstreamEvents } = context;
  let sequenceNumber = context.sequenceNumber;
  const created = initial.find((event) => event.type === "response.created");
  if (!created) {
    throw new ResponsesStreamError("RemovedProvider stream omitted response.created.", { kind: "malformed_event" });
  }
  initial.splice(initial.indexOf(created), 1);
  context.validateEvent?.(created);
  const rewrittenCreated = rewriteResponsesEventSequence(created, sequenceNumber++);
  originalUpstreamEvents.set(rewrittenCreated, created);
  queue.push(rewrittenCreated);

  const leadingCount = initial.findIndex((event) => !isLeadingSetupEvent(event));
  const leadingSetup = initial.splice(0, leadingCount < 0 ? initial.length : leadingCount);
  for (const event of leadingSetup) context.validateEvent?.(event);
  for (const event of leadingSetup) {
    const rewritten = rewriteResponsesEventSequence(event, sequenceNumber++);
    originalUpstreamEvents.set(rewritten, event);
    queue.push(rewritten);
  }

  const warning = buildFailoverWarningEvents(context.warningModel, context.responseId, sequenceNumber);
  queue.push(...warning.events);
  sequenceNumber += warning.events.length;
  for (const event of initial) context.validateEvent?.(event);
  for (const event of initial) {
    const rewritten = rewriteResponsesEventForWarning(event, warning.item, sequenceNumber++);
    originalUpstreamEvents.set(rewritten, event);
    queue.push(rewritten);
  }
  return { item: warning.item, sequenceNumber };
};

/** Owns event ordering and guarantees at most one client-visible terminal event. */
export const createOwnedResponsesStream = (options: OwnedResponsesStreamOptions): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const localAbort = new AbortController();
  const initial = [...options.initial];
  let warningItem: Record<string, unknown> | null = null;
  let responseId = options.responseId;
  let sequenceNumber = options.warning
    ? 0
    : initial.reduce(
        (max, event) =>
          typeof event.value.sequence_number === "number" && Number.isSafeInteger(event.value.sequence_number)
            ? Math.max(max, event.value.sequence_number + 1)
            : max,
        0
      );
  let closed = false;
  let terminalEmitted = false;
  let responseCreatedObserved = false;
  let semanticCommitmentObserved = false;
  const queue: ResponsesStreamEvent[] = [];
  const originalUpstreamEvents = new WeakMap<ResponsesStreamEvent, ResponsesStreamEvent>();
  let responseTemplate: Record<string, unknown> = {};
  const completedOutputItems: Record<string, unknown>[] = [];
  const completedOutputItemIds = new Map<string, number>();
  const accumulatedText = new Map<string, { id: string; text: string; completed: boolean; refusal: boolean }>();

  if (options.warning) {
    if (!responseId) {
      throw new ResponsesStreamError("RemovedProvider stream omitted a response identifier.", {
        kind: "malformed_event",
      });
    }
    const preamble = queueWarningPreamble({
      initial,
      queue,
      responseId,
      warningModel: options.warning.model,
      sequenceNumber,
      validateEvent: options.validateEvent,
      originalUpstreamEvents,
    });
    warningItem = preamble.item;
    sequenceNumber = preamble.sequenceNumber;
  } else {
    for (const event of initial) options.validateEvent?.(event);
    queue.push(...initial);
  }

  const warningItemId = (): string | null => (warningItem ? (getString(warningItem.id)?.trim() ?? null) : null);
  const eventItemId = (event: ResponsesStreamEvent): string | null => {
    const direct = getString(event.value.item_id)?.trim();
    if (direct) return direct;
    if (isRecord(event.value.item) && !Array.isArray(event.value.item)) {
      return getString(event.value.item.id)?.trim() ?? null;
    }
    return null;
  };
  const isWarningEvent = (event: ResponsesStreamEvent): boolean => {
    const warningId = warningItemId();
    return warningId !== null && eventItemId(event) === warningId;
  };
  const itemHasOutputText = (item: Record<string, unknown>): boolean =>
    Array.isArray(item.content) &&
    item.content.some(
      (part) =>
        isRecord(part) && !Array.isArray(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string" && part.text.length > 0
    );
  const rememberText = (event: ResponsesStreamEvent): void => {
    if (isWarningEvent(event)) return;
    const refusal = refusalTypes.has(event.type);
    const textField = textFieldForEventType(event.type);
    const text = textField === null ? null : getString(event.value[textField]);
    if (!text) return;
    const id = eventItemId(event) ?? `msg_recovered_${getString(event.value.output_index) ?? accumulatedText.size}`;
    const current = accumulatedText.get(id);
    if (event.type === "response.output_text.done" || event.type === "response.refusal.done") {
      if (!current || text.startsWith(current.text)) accumulatedText.set(id, { id, text, completed: true, refusal });
      return;
    }
    accumulatedText.set(id, {
      id,
      text: `${current?.text ?? ""}${text}`,
      completed: current?.completed ?? false,
      refusal,
    });
  };
  const observeResponseIdentity = (event: ResponsesStreamEvent): void => {
    const candidateResponseId = responseIdFromEvents([event]);
    if (candidateResponseId && responseId && candidateResponseId !== responseId) {
      throw new ResponsesStreamError("Upstream Responses stream changed response identifiers.", {
        kind: "malformed_event",
      });
    }
    responseId ??= candidateResponseId;
    const valueResponse = event.value.response;
    if (isRecord(valueResponse) && !Array.isArray(valueResponse)) {
      responseTemplate = { ...responseTemplate, ...valueResponse };
    }
  };
  const compatibilityOutputOf = (event: ResponsesStreamEvent): unknown => {
    if (event.type !== "response.output") return undefined;
    const explicit = event.value.output;
    if (explicit !== undefined && explicit !== null) return explicit;
    const valueResponse = event.value.response;
    if (!isRecord(valueResponse)) return undefined;
    return valueResponse.output;
  };
  const recordCompatibilityOutput = (output: unknown): void => {
    if (!Array.isArray(output)) return;
    for (const outputItem of output) {
      if (!isRecord(outputItem)) continue;
      const id = getString(outputItem.id)?.trim();
      const existingIndex = id ? completedOutputItemIds.get(id) : undefined;
      if (existingIndex !== undefined) {
        completedOutputItems[existingIndex] = { ...outputItem };
        continue;
      }
      if (id) completedOutputItemIds.set(id, completedOutputItems.length);
      completedOutputItems.push({ ...outputItem });
    }
  };
  const visibleItemFromEvent = (event: ResponsesStreamEvent): Record<string, unknown> | null => {
    const valueItem = event.value.item;
    if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && isRecord(valueItem) && !Array.isArray(valueItem)) {
      const item = { ...valueItem };
      if (event.type === "response.output_item.added") item.status = "incomplete";
      return item;
    }
    if (!hostedToolTerminalEventTypes.has(event.type)) return null;
    const lifecycle = hostedToolLifecycle(event.type);
    const type = event.type.slice("response.".length, -(lifecycle.length + 1));
    const existingId = eventItemId(event);
    const existing = existingId ? completedOutputItems[completedOutputItemIds.get(existingId) ?? -1] : undefined;
    return {
      ...(existing ?? {}),
      id: eventItemId(event) ?? `tool_recovered_${completedOutputItems.length}`,
      type,
      status: hostedToolItemStatus(lifecycle),
    };
  };
  const observeVisibleEvent = (event: ResponsesStreamEvent): void => {
    if (event.type === "response.created") responseCreatedObserved = true;
    if (!isWarningEvent(event) && responsesEventSemanticKindWithIgnoredOutputItem(event, warningItemId())) semanticCommitmentObserved = true;
    observeResponseIdentity(event);
    rememberText(event);
    if (isWarningEvent(event)) return;
    recordCompatibilityOutput(compatibilityOutputOf(event));
    const item = visibleItemFromEvent(event);
    if (!item) return;
    const id = getString(item.id)?.trim();
    const existingIndex = id ? completedOutputItemIds.get(id) : undefined;
    if (existingIndex !== undefined) {
      completedOutputItems[existingIndex] = item;
      return;
    }
    if (id) completedOutputItemIds.set(id, completedOutputItems.length);
    completedOutputItems.push(item);
  };
  const mergeCompletedOutputItems = (output: Record<string, unknown>[], outputById: Map<string, number>): void => {
    for (const item of completedOutputItems) {
      const id = getString(item.id)?.trim();
      if (id && outputById.has(id)) continue;
      if (id) outputById.set(id, output.length);
      output.push({ ...item });
    }
  };
  const mergeRecoveredText = (output: Record<string, unknown>[], outputById: Map<string, number>): void => {
    for (const recovered of accumulatedText.values()) {
      const existingIndex = outputById.get(recovered.id);
      const existingItem = existingIndex === undefined ? undefined : output[existingIndex];
      if (existingItem !== undefined && itemHasOutputText(existingItem)) continue;
      const message = {
        id: recovered.id,
        type: "message",
        status: recovered.completed ? "completed" : "incomplete",
        role: "assistant",
        content: recovered.refusal ? [{ type: "refusal", refusal: recovered.text }] : [{ type: "output_text", text: recovered.text, annotations: [] }],
      };
      if (existingIndex === undefined) {
        outputById.set(recovered.id, output.length);
        output.push(message);
        continue;
      }
      output[existingIndex] = { ...existingItem, ...message };
    }
  };
  const failureOutput = (): Record<string, unknown>[] => {
    const output = warningItem ? [{ ...warningItem }] : [];
    const outputById = new Map<string, number>();
    const warningId = warningItemId();
    if (warningId) outputById.set(warningId, 0);
    mergeCompletedOutputItems(output, outputById);
    mergeRecoveredText(output, outputById);
    return output;
  };
  const syntheticFailure = (): ResponsesStreamEvent => {
    return semanticCommitmentObserved
      ? failureEventAfterCommit(responseId ?? `resp_${crypto.randomUUID().replace(/-/g, "")}`, sequenceNumber++, failureOutput(), responseTemplate)
      : errorEventAfterCommit(sequenceNumber++);
  };
  const failureKindFor = (error: unknown): ResponsesStreamFailureKind => (error instanceof ResponsesStreamError ? error.kind : "read_error");
  const failureDetails = (
    error: unknown,
    syntheticTerminalType: OwnedResponsesStreamFailureDetails["syntheticTerminalType"],
    upstreamTerminal: ResponsesStreamEvent | null = null
  ): OwnedResponsesStreamFailureDetails => ({
    failureKind: failureKindFor(error),
    responseCreatedObserved,
    semanticCommitmentObserved,
    syntheticTerminalType,
    upstreamTerminal,
  });
  const advanceSequence = (event: ResponsesStreamEvent): void => {
    const value = event.value.sequence_number;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= sequenceNumber) {
      sequenceNumber = value + 1;
    }
  };

  const nextVisible = async (): Promise<ResponsesStreamEvent | null> => {
    const queued = queue.shift();
    if (queued) return queued;
    const event = await nextUpstreamEvent(options.iterator);
    if (!event) return null;
    options.validateEvent?.(event);
    const candidate = responseIdFromEvents([event]);
    if (candidate && responseId && candidate !== responseId) {
      throw new ResponsesStreamError("Upstream Responses stream changed response identifiers.", {
        kind: "malformed_event",
      });
    }
    responseId ??= candidate;
    if (!warningItem) return event;
    const rewritten = rewriteResponsesEventForWarning(event, warningItem, sequenceNumber++);
    originalUpstreamEvents.set(rewritten, event);
    return rewritten;
  };

  /** Closes the stream with a synthetic terminal, releases the iterator, then reports the failure. */
  const emitFailureTerminal = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    failure: ResponsesStreamEvent,
    error: unknown,
    upstreamTerminal: ResponsesStreamEvent | null
  ): Promise<void> => {
    const details = failureDetails(error, syntheticTerminalTypeOf(failure), upstreamTerminal);
    terminalEmitted = true;
    closed = true;
    controller.enqueue(encoder.encode(failure.raw));
    controller.close();
    await options.iterator.return(error).catch(() => {});
    invoke(() => options.onEvent?.(failure));
    invoke(() => options.onFailure?.(error, details));
  };

  /** Delivers one visible event, or the synthetic failure that replaces a missing one. */
  const deliverNextEvent = async (controller: ReadableStreamDefaultController<Uint8Array>, event: ResponsesStreamEvent | null): Promise<void> => {
    if (closed) return;
    if (!event) {
      const failure = syntheticFailure();
      const details = failureDetails(prematureEofError(), syntheticTerminalTypeOf(failure));
      terminalEmitted = true;
      closed = true;
      controller.enqueue(encoder.encode(failure.raw));
      controller.close();
      invoke(() => options.onEvent?.(failure));
      invoke(() => options.onFailure?.(prematureEofError(), details));
      return;
    }
    if (terminalEmitted) return;
    observeVisibleEvent(event);
    advanceSequence(event);
    if (event.type === "response.completed" && !semanticCommitmentObserved) {
      const error = new ResponsesStreamError(EMPTY_UPSTREAM_COMPLETION_MESSAGE, {
        kind: "empty_upstream_completion",
      });
      const failure = emptyCompletionEventAfterCommit(sequenceNumber++);
      await emitFailureTerminal(controller, failure, error, originalUpstreamEvents.get(event) ?? event);
      return;
    }
    terminalEmitted = event.terminal;
    controller.enqueue(encoder.encode(event.raw));
    invoke(() => options.onEvent?.(event));
    if (event.terminal) {
      closed = true;
      controller.close();
      await options.iterator.return("Responses terminal event forwarded").catch(() => {});
    }
  };

  /** Handles a pull failure: a cancelled stream closes quietly, anything else reports a failure. */
  const handlePullFailure = async (controller: ReadableStreamDefaultController<Uint8Array>, error: unknown): Promise<void> => {
    if (closed) return;
    if (options.downstreamSignal?.aborted || options.signal?.aborted || localAbort.signal.aborted) {
      closed = true;
      controller.close();
      await options.iterator.return(error).catch(() => {});
      invoke(() => options.onFailure?.(error, failureDetails(error, null)));
      return;
    }
    await emitFailureTerminal(controller, syntheticFailure(), error, null);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        await deliverNextEvent(controller, await nextVisible());
      } catch (error) {
        await handlePullFailure(controller, error);
      }
    },
    cancel(reason) {
      if (closed) return;
      closed = true;
      localAbort.abort(reason);
      options.abortUpstream?.(reason);
      invoke(() => options.onCancel?.(reason));
      void options.iterator.return(reason).catch(() => {});
    },
  });
};
