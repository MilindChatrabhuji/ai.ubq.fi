// Claude's Chat transport preserves explicit effort and provider prompt caching.
// Public output uses standard Responses items; signed Chat replay stays private.
import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS } from "../inference-deadline.ts";
import { MAX_RESPONSES_SSE_EVENT_BYTES, ResponsesStreamError } from "../responses-stream.ts";
import type { AnthropicResponsesOptions } from "./anthropic-responses.ts";
import { rememberAnthropicChatReplay } from "./anthropic-replay.ts";
import { createClaudeResponsesWriter, encodeClaudeResponsesEvent as encodeResponsesEvent, type ClaudeToolName } from "./anthropic-response-wire.ts";
import { readAnthropicChatStream } from "./anthropic-chat-stream.ts";

type JsonRecord = Record<string, unknown>;
export type AnthropicChatResponsesOptions = AnthropicResponsesOptions &
  Readonly<{
    toolNames?: ReadonlyMap<string, ClaudeToolName>;
    customToolNames?: ReadonlySet<string>;
  }>;

const record = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value: JsonRecord, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const malformed = (message: string): ResponsesStreamError => new ResponsesStreamError(message, { kind: "malformed_event" });
const responseId = (id: unknown): string =>
  `resp_${typeof id === "string" ? id.replace(/[^A-Za-z0-9]/g, "").slice(0, 40) : crypto.randomUUID().replaceAll("-", "")}`;

/** Chat already reports gross input: never add cache-read or cache-write again. */
export const toAnthropicChatResponsesUsage = (usage: unknown): JsonRecord | null => {
  if (!record(usage)) return null;
  const result: JsonRecord = {};
  for (const [source, target] of [
    ["prompt_tokens", "input_tokens"],
    ["prompt_tokens_details", "input_tokens_details"],
    ["completion_tokens", "output_tokens"],
    ["completion_tokens_details", "output_tokens_details"],
    ["total_tokens", "total_tokens"],
    ["buyer_cost_micro", "buyer_cost_micro"],
    ["cost", "cost"],
    ["cost_details", "cost_details"],
  ]) {
    if (has(usage, source)) result[target] = usage[source];
  }
  return result;
};

const detailText = (value: unknown): string => {
  if (!Array.isArray(value)) return "";
  return value.map((detail: unknown) => (record(detail) && detail.type === "reasoning.text" && typeof detail.text === "string" ? detail.text : "")).join("");
};

const projectedMessage = (message: JsonRecord, options: AnthropicChatResponsesOptions): JsonRecord => {
  const reasoning = readableReasoning(message);
  const projected = { ...message };
  delete projected.reasoning_details;
  delete projected.reasoning_content;
  delete projected.reasoning;
  if (options.reasoningSummary !== "none" && reasoning) projected.reasoning_content = reasoning;
  return projected;
};

const readableReasoning = (message: JsonRecord): string => {
  if (typeof message.reasoning_content === "string" && message.reasoning_content) return message.reasoning_content;
  if (typeof message.reasoning === "string" && message.reasoning) return message.reasoning;
  return detailText(message.reasoning_details);
};

const deltaReasoning = (delta: JsonRecord): string => {
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content;
  return typeof delta.reasoning === "string" ? delta.reasoning : "";
};

const publishReplay = (payload: JsonRecord, assistant: JsonRecord, options: AnthropicChatResponsesOptions, valid = true): void => {
  if (!valid || payload.status !== "completed" || !options.provider || !options.reasoningReplayScope || !Array.isArray(payload.output)) return;
  rememberAnthropicChatReplay({
    scope: options.reasoningReplayScope,
    provider: options.provider,
    model: options.model,
    output: payload.output,
    assistant,
    toolNames: options.toolNames,
    customToolNames: options.customToolNames,
  });
};

const readChoice = (completion: unknown): Readonly<{ completion: JsonRecord; choice: JsonRecord; assistant: JsonRecord }> => {
  if (!record(completion) || !Array.isArray(completion.choices) || completion.choices.length !== 1 || !record(completion.choices[0])) {
    throw malformed("Claude Chat returned an invalid single-choice completion.");
  }
  const choice = completion.choices[0];
  if (!record(choice.message) || choice.message.role !== "assistant" || typeof choice.finish_reason !== "string") {
    throw malformed("Claude Chat completion has no assistant message or finish reason.");
  }
  return { completion, choice, assistant: choice.message };
};

const bufferedPayload = (value: unknown, options: AnthropicChatResponsesOptions): JsonRecord => {
  const { completion, choice, assistant } = readChoice(value);
  const writer = createClaudeResponsesWriter({
    model: options.model,
    id: responseId(completion.id),
    created: typeof completion.created === "number" ? completion.created : Math.floor(Date.now() / 1000),
    toolNames: options.toolNames,
    customToolNames: options.customToolNames,
  });
  writer.push(projectedMessage(assistant, options));
  const tools = Array.isArray(assistant.tool_calls) ? assistant.tool_calls.filter(record) : [];
  writer.finish(tools, choice.finish_reason, toAnthropicChatResponsesUsage(completion.usage));
  const payload = writer.response();
  if (!payload) throw malformed("Claude Chat produced no terminal response.");
  publishReplay(payload, assistant, options);
  return payload;
};

type ToolCall = { id: string; name: string; arguments: string };

const mergeReasoningDetail = (prior: JsonRecord, item: JsonRecord): boolean => {
  let valid = !(typeof item.signature === "string" && item.signature && typeof prior.signature === "string" && prior.signature);
  for (const [key, value] of Object.entries(item)) {
    if (key === "text" && typeof value === "string") prior.text = (typeof prior.text === "string" ? prior.text : "") + value;
    else if (key === "signature" && typeof value === "string" && !prior.signature) prior.signature = value;
    else if (key !== "signature" && has(prior, key) && prior[key] !== value) valid = false;
    else if (!has(prior, key)) prior[key] = value;
  }
  return valid;
};

/** Accumulate the exact standard Chat assistant fields, without synthesizing native signatures. */
const createChatState = () => {
  const assistant: JsonRecord = { role: "assistant", content: null };
  const tools = new Map<number, ToolCall>();
  const details = new Map<number, JsonRecord>();
  let replayable = true;
  let usage: unknown;
  let finish: string | null = null;
  let reasoningSource: "content" | "details" | null = null;

  const appendField = (key: string, delta: JsonRecord): void => {
    if (!has(delta, key) || delta[key] === null) return;
    if (typeof delta[key] !== "string") throw malformed(`Claude Chat ${key} delta must be text.`);
    const prior = typeof assistant[key] === "string" ? assistant[key] : "";
    assistant[key] = prior + delta[key];
  };

  const mergeDetails = (raw: unknown): void => {
    if (raw === undefined || raw === null) return;
    if (!Array.isArray(raw)) {
      replayable = false;
      return;
    }
    for (const item of raw) {
      if (!record(item) || !Number.isSafeInteger(item.index) || Number(item.index) < 0 || item.type !== "reasoning.text") {
        replayable = false;
        continue;
      }
      const index = Number(item.index);
      const prior = details.get(index);
      if (!prior) {
        details.set(index, { ...item });
        continue;
      }
      // Text is a standard delta; undocumented repeated signatures or changing
      // metadata cannot safely become an original signed replay receipt.
      if (!mergeReasoningDetail(prior, item)) replayable = false;
    }
  };

  const mergeTools = (raw: unknown): void => {
    if (raw === undefined || raw === null) return;
    if (!Array.isArray(raw)) throw malformed("Claude Chat tool_calls delta must be an array.");
    for (const [position, item] of raw.entries()) {
      if (!record(item) || !record(item.function)) throw malformed("Claude Chat tool call delta must have a function.");
      const index = typeof item.index === "number" ? item.index : position;
      if (!Number.isSafeInteger(index) || index < 0) throw malformed("Claude Chat tool call index is invalid.");
      const call = tools.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof item.id === "string") call.id = item.id;
      if (typeof item.function.name === "string") call.name += item.function.name;
      if (typeof item.function.arguments === "string") call.arguments += item.function.arguments;
      tools.set(index, call);
    }
  };

  const push = (chunk: JsonRecord): JsonRecord => {
    if (has(chunk, "usage") && chunk.usage !== null) usage = chunk.usage;
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) throw malformed("Claude Chat emitted an invalid single-choice stream chunk.");
    if (chunk.choices.length === 0) return { ...chunk, choices: [] };
    const choice = chunk.choices[0];
    if (!record(choice)) throw malformed("Claude Chat emitted a non-object choice.");
    if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    const delta = record(choice.delta) ? choice.delta : {};
    appendField("content", delta);
    appendField("reasoning_content", delta);
    appendField("reasoning", delta);
    appendField("refusal", delta);
    mergeDetails(delta.reasoning_details);
    mergeTools(delta.tool_calls);
    const fromContent = deltaReasoning(delta);
    const fromDetails = detailText(delta.reasoning_details);
    if (!reasoningSource && (fromContent || fromDetails)) reasoningSource = fromContent ? "content" : "details";
    const reasoning = reasoningSource === "content" ? fromContent : fromDetails;
    const projected: JsonRecord = { ...delta };
    delete projected.reasoning_details;
    delete projected.reasoning_content;
    delete projected.reasoning;
    // Tools are announced once their names/arguments are complete at [DONE].
    delete projected.tool_calls;
    if (reasoning) projected.reasoning_content = reasoning;
    return { ...chunk, choices: [{ ...choice, delta: projected }] };
  };

  const message = (): JsonRecord => {
    if (details.size) assistant.reasoning_details = [...details.entries()].sort(([left], [right]) => left - right).map(([, detail]) => detail);
    if (tools.size)
      assistant.tool_calls = toolCalls().map((call) => {
        const original = { ...call };
        delete original.index;
        return original;
      });
    return assistant;
  };
  const toolCalls = (): JsonRecord[] =>
    [...tools.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => ({
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
  return { push, message, toolCalls, usage: () => usage, finish: () => finish, replayable: () => replayable };
};

async function* translateChatStream(
  response: Response,
  options: AnthropicChatResponsesOptions,
  signal: AbortSignal
): AsyncGenerator<Uint8Array, void, unknown> {
  const state = createChatState();
  const translator = createClaudeResponsesWriter({
    model: options.model,
    id: responseId(options.requestId ?? crypto.randomUUID()),
    created: Math.floor(Date.now() / 1000),
    toolNames: options.toolNames,
    customToolNames: options.customToolNames,
  });
  const encoder = new TextEncoder();
  let sequence = 0;
  const encode = (event: JsonRecord): Uint8Array => encoder.encode(encodeResponsesEvent({ ...event, sequence_number: sequence++ }));
  const chunkEvents = (chunk: JsonRecord): JsonRecord[] => {
    const projected = state.push(chunk);
    const choice = Array.isArray(projected.choices) ? projected.choices[0] : null;
    const delta = record(choice) && record(choice.delta) ? choice.delta : {};
    if (options.reasoningSummary === "none") delete delta.reasoning_content;
    const events = translator.push(delta);
    if (has(chunk, "usage") && chunk.usage !== null) events.push(translator.observedUsage(toAnthropicChatResponsesUsage(state.usage())));
    return events;
  };
  const finishEvents = (): JsonRecord[] => {
    if (!state.finish()) throw new ResponsesStreamError("Claude Chat ended without a finish reason.", { kind: "premature_eof" });
    const events = translator.finish(state.toolCalls(), state.finish(), toAnthropicChatResponsesUsage(state.usage()));
    const response = translator.response();
    if (response) publishReplay(response, state.message(), options, state.replayable());
    return events;
  };
  try {
    for await (const frame of readAnthropicChatStream(response, signal)) {
      if (frame.kind === "comment") {
        yield encoder.encode(`${frame.text}\n\n`);
        continue;
      }
      if (frame.kind === "chunk") {
        for (const event of chunkEvents(frame.value)) yield encode(event);
        continue;
      }
      for (const event of finishEvents()) yield encode(event);
    }
  } catch (error) {
    throw error instanceof Error ? error : new ResponsesStreamError("Claude Chat stream failed.", { cause: error });
  }
}

/** Normalize the proven Claude Chat route while preserving status and cost headers. */
export const normalizeAnthropicChatResponsesResponse = async (response: Response, options: AnthropicChatResponsesOptions): Promise<Response> => {
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const cancellation = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
    const iterator = translateChatStream(response, options, signal);
    let started = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        started = true;
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        cancellation.abort(reason);
        if (!started) await response.body?.cancel(reason).catch(() => {});
        await iterator.return().catch(() => {});
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers });
  }
  const captured = await readBoundedResponseBody(response, {
    signal: options.signal,
    maxBytes: MAX_RESPONSES_SSE_EVENT_BYTES,
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
  });
  if (options.signal?.aborted)
    throw options.signal.reason instanceof Error ? options.signal.reason : new DOMException("Claude Chat was aborted.", "AbortError");
  if (!captured.complete) throw new ResponsesStreamError("Claude Chat body was incomplete or oversized.", { kind: "read_error" });
  let completion: unknown;
  try {
    completion = JSON.parse(new TextDecoder().decode(captured.bytes));
  } catch (cause) {
    throw new ResponsesStreamError("Claude Chat returned malformed JSON.", { cause, kind: "malformed_event" });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(bufferedPayload(completion, options)), { status: response.status, statusText: response.statusText, headers });
};
