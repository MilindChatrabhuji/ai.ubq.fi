// Buffered Responses accumulation, extracted from src/responses_attempts.ts.

import type { PreparedResponsesAttempt } from "./responses-attempts.ts";
// Responses attempt preparation and buffered-response accumulation, extracted from src/openai.ts.

import {} from "./codex/index.ts";
import { json } from "./http.ts";
import {} from "./inference-deadline.ts";
import { readResponsesStream, ResponsesStreamError, type ResponsesStreamEvent } from "./responses-stream.ts";
import {} from "./paid-fallback/removed-provider.ts";
import {} from "./provider/removed-provider-circuit.ts";
import { createOwnedResponsesStream, type OwnedResponsesStreamFailureDetails, responseIdFromEvents } from "./responses-failover-stream.ts";
import { getString, isRecord } from "./utils.ts";
import { type UpstreamProvider, type UsageContext, recordResponsesEventTelemetry, streamErrorResponse } from "./openai-telemetry.ts";
import { withAccumulatedResponseItems, withAccumulatedResponseRefusal, withAccumulatedResponseText } from "./chat/stream-translation.ts";
import {} from "./upstream-wire.ts";
import {} from "./request-policy.ts";

type BufferedResponsesOptions = Readonly<{
  warningModel?: string | null;
  usageContext?: UsageContext;
  onTerminal?: (event: ResponsesStreamEvent) => void;
  onEvent?: (event: ResponsesStreamEvent) => void;
  validateEvent?: (event: ResponsesStreamEvent) => void;
  onFailure?: (error: unknown, details?: OwnedResponsesStreamFailureDetails) => Response | undefined;
}>;

type BufferedResponsesAccumulator = {
  responseId: string | null;
  refusalText: string;
  readonly deltaTextParts: Map<string, string>;
  readonly doneTextParts: Map<string, string>;
  readonly textPartOrder: string[];
  readonly outputItems: Record<string, unknown>[];
};

type BufferedResponsesTerminalOutcome = Readonly<{ kind: "error"; response: Response }> | Readonly<{ kind: "terminal"; response: Record<string, unknown> }>;

// Parsed upstream JSON can put any shape on an index field. Stringify primitives
// exactly as before, serialize objects explicitly, and otherwise fall back to the
// same default the absent case uses instead of rendering "[object Object]".
const formatTextPartIndex = (value: unknown): string => {
  if (value === null || value === undefined) return "0";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return "0";
};

const textPartKeyFromValue = (value: Record<string, unknown>): string => {
  const itemId = getString(value.item_id)?.trim();
  if (itemId) return `item:${itemId}:${formatTextPartIndex(value.content_index)}`;
  return `output:${formatTextPartIndex(value.output_index)}:${formatTextPartIndex(value.content_index)}`;
};

const createBufferedResponsesAccumulator = (responseId: string | null): BufferedResponsesAccumulator => ({
  responseId,
  refusalText: "",
  deltaTextParts: new Map<string, string>(),
  doneTextParts: new Map<string, string>(),
  textPartOrder: [],
  outputItems: [],
});

const rememberBufferedTextPart = (accumulator: BufferedResponsesAccumulator, value: Record<string, unknown>, text: string, done: boolean): void => {
  if (!text) return;
  const key = textPartKeyFromValue(value);
  if (!accumulator.textPartOrder.includes(key)) accumulator.textPartOrder.push(key);
  if (done) {
    const deltaText = accumulator.deltaTextParts.get(key) ?? "";
    // A done event normally repeats the complete text accumulated by its
    // deltas. Some upstreams instead send a conflicting fragment; retain
    // the delta text in that case, matching the owned stream reconciler.
    if (!deltaText || text.startsWith(deltaText)) accumulator.doneTextParts.set(key, text);
    return;
  }
  accumulator.deltaTextParts.set(key, `${accumulator.deltaTextParts.get(key) ?? ""}${text}`);
};

const trackBufferedResponseId = (accumulator: BufferedResponsesAccumulator, event: ResponsesStreamEvent): void => {
  const eventResponseId = responseIdFromEvents([event]);
  if (eventResponseId && accumulator.responseId && eventResponseId !== accumulator.responseId) {
    throw new ResponsesStreamError("Upstream Responses stream changed response identifiers.", {
      kind: "malformed_event",
    });
  }
  accumulator.responseId ??= eventResponseId;
};

const accumulateBufferedResponsesEvent = (
  accumulator: BufferedResponsesAccumulator,
  event: ResponsesStreamEvent,
  warningModel: string | null | undefined
): void => {
  const value = event.value;
  const suppressedWarningModelOutput = Boolean(warningModel) && value.output_index === 0;
  if (event.type === "response.output_text.delta" && !suppressedWarningModelOutput) {
    rememberBufferedTextPart(accumulator, value, getString(value.delta) ?? "", false);
  }
  if (event.type === "response.output_text.done" && !suppressedWarningModelOutput) {
    rememberBufferedTextPart(accumulator, value, getString(value.text) ?? "", true);
  }
  if (event.type === "response.refusal.delta") accumulator.refusalText += getString(value.delta) ?? "";
  if (event.type === "response.refusal.done" && !accumulator.refusalText) accumulator.refusalText = getString(value.refusal) ?? "";
  if (event.type === "response.output_item.done" && isRecord(value.item)) accumulator.outputItems.push(value.item);
  if (event.type === "response.output") {
    const output = value.output ?? (isRecord(value.response) ? value.response.output : undefined);
    if (Array.isArray(output)) accumulator.outputItems.push(...output.filter(isRecord));
  }
};

const resolveBufferedResponsesTerminal = (
  event: ResponsesStreamEvent,
  provider: UpstreamProvider,
  onTerminal?: (event: ResponsesStreamEvent) => void
): BufferedResponsesTerminalOutcome | null => {
  if (event.type === "error") {
    onTerminal?.(event);
    const code = getString(event.value.code) ?? "server_error";
    const message = getString(event.value.message) ?? "Upstream Responses stream ended unexpectedly.";
    return { kind: "error", response: streamErrorResponse(502, message, code, provider, []) };
  }
  if (
    (event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete") &&
    isRecord(event.value.response) &&
    !Array.isArray(event.value.response)
  ) {
    onTerminal?.(event);
    return { kind: "terminal", response: event.value.response };
  }
  return null;
};

const createBufferedResponsesInitial = (
  attempt: Pick<PreparedResponsesAttempt, "responseId" | "prepared">,
  options: BufferedResponsesOptions
): AsyncIterable<ResponsesStreamEvent> => {
  const warningModel = options.warningModel;
  if (warningModel) {
    const stream = createOwnedResponsesStream({
      initial: attempt.prepared.buffered,
      iterator: attempt.prepared.iterator,
      responseId: attempt.responseId,
      warning: { model: warningModel },
      validateEvent: options.validateEvent,
      onEvent: (event) => {
        recordResponsesEventTelemetry(options.usageContext, event);
        options.onEvent?.(event);
      },
      onFailure: (error, details) => {
        options.onFailure?.(error, details);
      },
    });
    return readResponsesStream(stream);
  }
  return (async function* (): AsyncGenerator<ResponsesStreamEvent> {
    for (const event of attempt.prepared.buffered) {
      options.validateEvent?.(event);
      recordResponsesEventTelemetry(options.usageContext, event);
      options.onEvent?.(event);
      yield event;
    }
    for await (const event of attempt.prepared.iterator) {
      options.validateEvent?.(event);
      recordResponsesEventTelemetry(options.usageContext, event);
      options.onEvent?.(event);
      yield event;
    }
  })();
};

export const collectBufferedResponses = async (
  attempt: Pick<PreparedResponsesAttempt, "provider" | "responseId" | "prepared">,
  options: BufferedResponsesOptions = {}
): Promise<Response> => {
  const initial = createBufferedResponsesInitial(attempt, options);
  const accumulator = createBufferedResponsesAccumulator(attempt.responseId);
  let finalResponse: Record<string, unknown> | null = null;
  try {
    for await (const event of initial) {
      trackBufferedResponseId(accumulator, event);
      accumulateBufferedResponsesEvent(accumulator, event, options.warningModel);
      const terminal = resolveBufferedResponsesTerminal(event, attempt.provider, options.onTerminal);
      if (!terminal) continue;
      if (terminal.kind === "error") return terminal.response;
      finalResponse = terminal.response;
      break;
    }
  } catch (error) {
    const failureResponse = options.onFailure?.(error);
    if (failureResponse) return failureResponse;
    return streamErrorResponse(502, "Upstream Responses stream ended unexpectedly.", "server_error", attempt.provider, []);
  }
  if (!finalResponse) {
    return streamErrorResponse(502, "Upstream Responses stream ended unexpectedly.", "server_error", attempt.provider, []);
  }
  const outputText = accumulator.textPartOrder.map((key) => accumulator.doneTextParts.get(key) ?? accumulator.deltaTextParts.get(key) ?? "").join("");
  finalResponse = withAccumulatedResponseItems(finalResponse, accumulator.outputItems);
  finalResponse = withAccumulatedResponseText(finalResponse, outputText, options.warningModel ? 1 : 0);
  finalResponse = withAccumulatedResponseRefusal(finalResponse, accumulator.refusalText, options.warningModel ? 1 : 0);
  // The terminal callback owns usage and terminal telemetry for buffered and
  // streamed Responses alike. Do not record it a second time here.
  return json(200, finalResponse, { "x-uos-upstream": attempt.provider });
};
