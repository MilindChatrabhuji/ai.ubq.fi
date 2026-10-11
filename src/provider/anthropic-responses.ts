// Native Anthropic Messages output translated into the public Responses contract.
import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { encodeClaudeResponsesEvent as encodeResponsesEvent, claudeResponsesEnvelope as responsesEnvelope } from "./anthropic-response-wire.ts";
import { BUFFERED_INFERENCE_DEADLINE_MS, STREAM_FIRST_EVENT_DEADLINE_MS, STREAM_INACTIVITY_DEADLINE_MS } from "../inference-deadline.ts";
import { MAX_RESPONSES_SSE_EVENT_BYTES, ResponsesStreamError } from "../responses-stream.ts";
import { isRecord } from "../utils.ts";
import { rememberAnthropicReplay } from "./anthropic-replay.ts";

type JsonRecord = Record<string, unknown>;

export type AnthropicResponsesOptions = Readonly<{
  model: string;
  requestId?: string;
  signal?: AbortSignal;
  reasoningSummary?: string;
  reasoningReplayScope?: string;
  provider?: string;
}>;

const record = (value: unknown): value is JsonRecord => isRecord(value) && !Array.isArray(value);
const has = (value: JsonRecord, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const malformed = (message: string): ResponsesStreamError => new ResponsesStreamError(message, { kind: "malformed_event" });
const responseIdFor = (id: string): string => `resp_${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 40) || crypto.randomUUID().replaceAll("-", "")}`;

const nativeReasoningDetails = (value: JsonRecord, output: number | null): JsonRecord | null => {
  const details = record(value.output_tokens_details) ? value.output_tokens_details : null;
  if (!details || !has(details, "thinking_tokens")) return null;
  const thinking = count(details.thinking_tokens);
  const reasoning = thinking !== null && (output === null || thinking <= output) ? thinking : null;
  return { reasoning_tokens: reasoning };
};

/**
 * Messages counts input_tokens after subtracting cache hits and cache writes.
 * Responses counts the whole input, with caching as a subset. Optional native
 * counters remain absent when unreported; an invalid counter never becomes 0.
 * The original buyer cost is retained for authoritative paid-route settlement.
 */
export const toAnthropicResponsesUsage = (value: unknown): JsonRecord | null => {
  if (!record(value)) return null;
  const net = count(value.input_tokens);
  const output = count(value.output_tokens);
  const read = count(value.cache_read_input_tokens);
  const write = count(value.cache_creation_input_tokens);
  const invalidCache = (has(value, "cache_read_input_tokens") && read === null) || (has(value, "cache_creation_input_tokens") && write === null);
  const gross = net === null || invalidCache ? null : count(net + (read ?? 0) + (write ?? 0));
  const details: JsonRecord = {
    ...(has(value, "cache_read_input_tokens") ? { cached_tokens: read } : {}),
    ...(has(value, "cache_creation_input_tokens") ? { cache_write_tokens: write } : {}),
  };
  const outputDetails = nativeReasoningDetails(value, output);
  return {
    input_tokens: gross,
    ...(Object.keys(details).length ? { input_tokens_details: details } : {}),
    output_tokens: output,
    ...(outputDetails ? { output_tokens_details: outputDetails } : {}),
    total_tokens: gross === null || output === null ? null : count(gross + output),
    ...(has(value, "buyer_cost_micro") ? { buyer_cost_micro: value.buyer_cost_micro } : {}),
  };
};

type ContentBlock = {
  nativeIndex: number;
  outputIndex: number;
  kind: "text" | "thinking" | "tool_use" | "redacted_thinking";
  id: string;
  text: string;
  callId: string;
  name: string;
  args: string;
  input: JsonRecord;
  argumentDelta: boolean;
  suppressed: boolean;
  closed: boolean;
  native: JsonRecord;
};

const stringField = (value: JsonRecord, key: string): string => {
  if (typeof value[key] !== "string") throw malformed(`Anthropic Messages ${key} must be a string.`);
  return value[key];
};

const blockIndex = (value: JsonRecord): number => {
  const index = count(value.index);
  if (index === null) throw malformed("Anthropic Messages content block index must be a nonnegative integer.");
  return index;
};

const itemPrefix = (kind: ContentBlock["kind"]): string => {
  if (kind === "text") return "msg";
  if (kind === "thinking") return "rs";
  return "fc";
};

const newContentBlock = (
  nativeIndex: number,
  outputIndex: number,
  responseId: string,
  content: JsonRecord,
  options: AnthropicResponsesOptions
): ContentBlock => {
  const kind = content.type;
  if (kind !== "text" && kind !== "thinking" && kind !== "tool_use" && kind !== "redacted_thinking") {
    throw malformed("Anthropic Messages emitted an unsupported content block.");
  }
  const block: ContentBlock = {
    nativeIndex,
    outputIndex,
    kind,
    id: `${itemPrefix(kind)}_${responseId}_${nativeIndex}`,
    text: "",
    callId: "",
    name: "",
    args: "",
    input: {},
    argumentDelta: false,
    suppressed: kind === "redacted_thinking" || (kind === "thinking" && options.reasoningSummary === "none"),
    closed: false,
    native: { ...content },
  };
  if (kind === "tool_use") {
    block.callId = stringField(content, "id");
    block.name = stringField(content, "name");
    if (!block.callId || !block.name || !record(content.input)) throw malformed("Anthropic Messages tool_use must have an id, name and object input.");
    block.input = content.input;
  }
  return block;
};

const initialBlockText = (kind: ContentBlock["kind"], content: JsonRecord): string => {
  if (kind === "text") return stringField(content, "text");
  if (kind === "thinking") return stringField(content, "thinking");
  return "";
};

/** Retain signatures privately and reconstruct tool inputs only when complete. */
const nativeReplayBlock = (block: ContentBlock): JsonRecord | null => {
  const native = { ...block.native };
  if (block.kind === "text") native.text = block.text;
  if (block.kind === "thinking") native.thinking = block.text;
  if (block.kind !== "tool_use" || !block.argumentDelta) return native;
  let input: unknown;
  try {
    input = JSON.parse(block.args);
  } catch {
    return null;
  }
  if (!record(input)) return null;
  return { ...native, input };
};

const stopStatus = (reason: unknown): "completed" | "incomplete" | "failed" => {
  if (reason === "end_turn" || reason === "tool_use" || reason === "stop_sequence") return "completed";
  if (reason === "max_tokens") return "incomplete";
  return "failed";
};

const nativeErrorCode = (error: JsonRecord): string => {
  if (typeof error.code === "string") return error.code;
  if (typeof error.type === "string") return error.type;
  return "anthropic_upstream_error";
};

const objectField = (value: JsonRecord, key: string): JsonRecord => {
  const child = value[key];
  if (!record(child)) throw malformed(`Anthropic Messages event has no object ${key}.`);
  return child;
};

/** Native blocks are closed before the next output item, matching Codex's single active item. */
const createMessagesTranslator = (options: AnthropicResponsesOptions) => {
  let responseId = responseIdFor(options.requestId ?? crypto.randomUUID());
  const createdAt = Math.floor(Date.now() / 1000);
  const echo = { tools: undefined, tool_choice: undefined, parallel_tool_calls: undefined, instructions: null };
  const blocks = new Map<number, ContentBlock>();
  const output: JsonRecord[] = [];
  let started = false;
  let terminal = false;
  let sequence = 0;
  let stopReason: unknown;
  let usage: JsonRecord | null = null;
  let finalResponse: JsonRecord | null = null;

  const envelope = (status: string): JsonRecord => responsesEnvelope(responseId, options.model, createdAt, status, echo);
  const numbered = (events: JsonRecord[]): JsonRecord[] => events.map((event) => ({ ...event, sequence_number: sequence++ }));

  const start = (message: JsonRecord): JsonRecord[] => {
    if (started || terminal) throw malformed("Anthropic Messages emitted more than one message_start.");
    if (message.type !== "message" || message.role !== "assistant") throw malformed("Anthropic Messages returned an invalid assistant message.");
    if (typeof message.id === "string" && message.id) responseId = responseIdFor(message.id);
    started = true;
    usage = record(message.usage) ? { ...message.usage } : null;
    if (has(message, "stop_reason")) stopReason = message.stop_reason;
    return numbered([
      { type: "response.created", response: envelope("in_progress") },
      { type: "response.in_progress", response: { ...envelope("in_progress"), usage: toAnthropicResponsesUsage(usage) } },
    ]);
  };

  const itemFor = (block: ContentBlock, status: string): JsonRecord => {
    if (block.kind === "text") {
      return { id: block.id, type: "message", status, role: "assistant", content: [{ type: "output_text", text: block.text, annotations: [] }] };
    }
    if (block.kind === "thinking") {
      return { id: block.id, type: "reasoning", status, summary: [{ type: "summary_text", text: block.text }] };
    }
    return { id: block.id, type: "function_call", status, call_id: block.callId, name: block.name, arguments: block.args };
  };

  const open = (nativeIndex: number, content: JsonRecord): JsonRecord[] => {
    if (!started || terminal || blocks.has(nativeIndex) || [...blocks.values()].some((block) => !block.closed)) {
      throw malformed("Anthropic Messages content block lifecycle is invalid.");
    }
    const outputIndex = output.length;
    const block = newContentBlock(nativeIndex, outputIndex, responseId, content, options);
    const kind = block.kind;
    blocks.set(nativeIndex, block);
    // Opaque redacted thinking and provider signatures have no public Responses
    // representation. They never become invented encrypted_content payloads.
    if (block.suppressed) {
      block.text = initialBlockText(kind, content);
      return [];
    }
    const item = itemFor(block, "in_progress");
    if (kind === "text") item.content = [];
    if (kind === "thinking") item.summary = [];
    output.push(item);
    const events: JsonRecord[] = [{ type: "response.output_item.added", output_index: outputIndex, item }];
    if (kind === "text") {
      events.push({
        type: "response.content_part.added",
        item_id: block.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    } else if (kind === "thinking") {
      events.push({
        type: "response.reasoning_summary_part.added",
        item_id: block.id,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    const initial = initialBlockText(kind, content);
    const numberedEvents = numbered(events);
    return initial ? [...numberedEvents, ...delta(nativeIndex, { type: kind === "text" ? "text_delta" : "thinking_delta", [kind]: initial })] : numberedEvents;
  };

  const delta = (nativeIndex: number, value: JsonRecord): JsonRecord[] => {
    const block = blocks.get(nativeIndex);
    if (!block || block.closed || terminal) throw malformed("Anthropic Messages delta references no open content block.");
    const common = { item_id: block.id, output_index: block.outputIndex };
    if (block.kind === "thinking" && value.type === "signature_delta") {
      const signature = stringField(value, "signature");
      const initial = typeof block.native.signature === "string" ? block.native.signature : "";
      block.native.signature = initial + signature;
      return [];
    }
    if (block.kind === "redacted_thinking") throw malformed("Anthropic Messages emitted a delta for redacted thinking.");
    if (block.kind === "text" && value.type === "text_delta") {
      const text = stringField(value, "text");
      block.text += text;
      return numbered([{ type: "response.output_text.delta", ...common, content_index: 0, delta: text, logprobs: [] }]);
    }
    if (block.kind === "thinking" && value.type === "thinking_delta") {
      const text = stringField(value, "thinking");
      block.text += text;
      if (block.suppressed) return [];
      return numbered([{ type: "response.reasoning_summary_text.delta", ...common, summary_index: 0, delta: text }]);
    }
    if (block.kind === "tool_use" && value.type === "input_json_delta") {
      const text = stringField(value, "partial_json");
      block.argumentDelta = true;
      block.args += text;
      return numbered([{ type: "response.function_call_arguments.delta", ...common, delta: text }]);
    }
    throw malformed("Anthropic Messages content delta does not match its block type.");
  };

  const close = (nativeIndex: number): JsonRecord[] => {
    const block = blocks.get(nativeIndex);
    if (!block || block.closed || terminal) throw malformed("Anthropic Messages content_block_stop references no open block.");
    block.closed = true;
    if (block.suppressed) return [];
    const common = { item_id: block.id, output_index: block.outputIndex };
    const events: JsonRecord[] = [];
    if (block.kind === "text") {
      events.push(
        { type: "response.output_text.done", ...common, content_index: 0, text: block.text, logprobs: [] },
        { type: "response.content_part.done", ...common, content_index: 0, part: { type: "output_text", text: block.text, annotations: [] } }
      );
    } else if (block.kind === "thinking") {
      events.push(
        { type: "response.reasoning_summary_text.done", ...common, summary_index: 0, text: block.text },
        { type: "response.reasoning_summary_part.done", ...common, summary_index: 0, part: { type: "summary_text", text: block.text } }
      );
    } else {
      if (!block.argumentDelta) {
        block.args = JSON.stringify(block.input);
        events.push({ type: "response.function_call_arguments.delta", ...common, delta: block.args });
      }
      events.push({ type: "response.function_call_arguments.done", ...common, arguments: block.args });
    }
    const item = itemFor(block, "completed");
    output[block.outputIndex] = item;
    events.push({ type: "response.output_item.done", output_index: block.outputIndex, item });
    return numbered(events);
  };

  const rememberCompletedTurn = (): void => {
    if (!options.reasoningReplayScope || !options.provider) return;
    const nativeBlocks = [...blocks.values()].map(nativeReplayBlock);
    if (nativeBlocks.some((block) => block === null)) return;
    rememberAnthropicReplay({
      scope: options.reasoningReplayScope,
      provider: options.provider,
      model: options.model,
      output,
      nativeBlocks: nativeBlocks.filter((block) => block !== null),
    });
  };

  const finish = (): JsonRecord[] => {
    if (!started || terminal || [...blocks.values()].some((block) => !block.closed))
      throw malformed("Anthropic Messages ended with an invalid message lifecycle.");
    terminal = true;
    const status = stopStatus(stopReason);
    const response: JsonRecord = { ...envelope(status), output, usage: toAnthropicResponsesUsage(usage) };
    if (status === "incomplete") response.incomplete_details = { reason: "max_output_tokens" };
    if (status === "failed")
      response.error = { code: "anthropic_unrecognized_stop_reason", message: `Anthropic Messages stopped with reason ${String(stopReason)}.` };
    if (status === "completed") rememberCompletedTurn();
    finalResponse = response;
    return numbered([{ type: `response.${status}`, response }]);
  };

  const handlers: Record<string, (event: JsonRecord) => JsonRecord[]> = {
    error: (event) => {
      const error = objectField(event, "error");
      const message = stringField(error, "message");
      const code = nativeErrorCode(error);
      terminal = true;
      return numbered([{ type: "error", code, message, param: null }]);
    },
    message_start: (event) => start(objectField(event, "message")),
    content_block_start: (event) => open(blockIndex(event), objectField(event, "content_block")),
    content_block_delta: (event) => delta(blockIndex(event), objectField(event, "delta")),
    content_block_stop: (event) => close(blockIndex(event)),
    message_delta: (event) => {
      const change = objectField(event, "delta");
      if (has(change, "stop_reason")) stopReason = change.stop_reason;
      if (has(event, "usage")) {
        if (!record(event.usage)) throw malformed("Anthropic Messages message_delta has invalid usage.");
        usage = { ...(usage ?? {}), ...event.usage };
      }
      return has(event, "usage")
        ? numbered([{ type: "response.in_progress", response: { ...envelope("in_progress"), usage: toAnthropicResponsesUsage(usage) } }])
        : [];
    },
    message_stop: () => finish(),
  };

  const push = (event: JsonRecord): JsonRecord[] => {
    if (terminal) throw malformed("Anthropic Messages emitted an event after its terminal.");
    if (event.type === "ping") return [];
    if (!started && event.type !== "message_start" && event.type !== "error") throw malformed("Anthropic Messages emitted content before message_start.");
    const handler = typeof event.type === "string" && has(handlers, event.type) ? handlers[event.type] : undefined;
    if (!handler) throw malformed("Anthropic Messages emitted an unsupported event type.");
    return handler(event);
  };

  const buffered = (message: unknown): JsonRecord => {
    if (!record(message) || !Array.isArray(message.content)) throw malformed("Anthropic Messages returned an invalid message body.");
    start(message);
    for (const [index, content] of message.content.entries()) {
      if (!record(content)) throw malformed("Anthropic Messages returned a non-object content block.");
      open(index, content);
      close(index);
    }
    finish();
    if (!finalResponse) throw malformed("Anthropic Messages did not produce a terminal response.");
    return finalResponse;
  };
  return { push, buffered, done: (): boolean => terminal };
};

const parseFrame = (raw: string): JsonRecord | null => {
  const data: string[] = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (line === "data") data.push("");
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  let value: unknown;
  try {
    value = JSON.parse(data.join("\n"));
  } catch (cause) {
    throw new ResponsesStreamError("Anthropic Messages emitted malformed SSE JSON.", { cause, kind: "malformed_event" });
  }
  if (!record(value) || typeof value.type !== "string") throw malformed("Anthropic Messages emitted an SSE event without a type.");
  return value;
};

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("Anthropic Messages stream was aborted.", "AbortError");

const readWithAbort = async (reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> => {
  let abort = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

type MessagesFrame = Readonly<{ kind: "event"; value: JsonRecord }> | Readonly<{ kind: "comment" }>;

const assertFrameBound = (text: string): void => {
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSES_SSE_EVENT_BYTES) {
    throw new ResponsesStreamError("Anthropic Messages SSE event exceeded its bound.", { kind: "event_too_large" });
  }
};

/** One framing concern, shared by ordinary chunks and the final unterminated frame. */
const createMessagesFrameReader = () => {
  const decoder = new TextDecoder();
  let buffer = "";
  function* frames(incoming?: Uint8Array): Generator<MessagesFrame, void, unknown> {
    buffer += incoming ? decoder.decode(incoming, { stream: true }) : decoder.decode();
    for (;;) {
      const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
      if (!boundary && incoming) {
        assertFrameBound(buffer);
        return;
      }
      const end = boundary?.index ?? buffer.length;
      const raw = buffer.slice(0, end);
      assertFrameBound(raw);
      buffer = boundary ? buffer.slice(end + boundary[0].length) : "";
      const event = parseFrame(raw);
      if (event) yield { kind: "event", value: event };
      else if (raw.trim().startsWith(":")) yield { kind: "comment" };
      if (!boundary) return;
    }
  }
  return { frames };
};

const streamReadFailure = (error: unknown, options: AnthropicResponsesOptions, consumerAbort: AbortSignal, deadline: AbortSignal): Error => {
  if (options.signal?.aborted) return abortError(options.signal);
  if (consumerAbort.aborted) return abortError(consumerAbort);
  if (deadline.aborted) return new ResponsesStreamError("Anthropic Messages stream became inactive.", { cause: error, kind: "inactivity_timeout" });
  if (error instanceof ResponsesStreamError) return error;
  return new ResponsesStreamError("Anthropic Messages stream could not be read.", { cause: error });
};

/** Owns native framing, read deadlines and the upstream reader's cancellation. */
async function* readMessagesFrames(
  response: Response,
  options: AnthropicResponsesOptions,
  consumerAbort: AbortSignal
): AsyncGenerator<MessagesFrame, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ResponsesStreamError("Anthropic Messages returned no stream body.", { kind: "premature_eof" });
  const framer = createMessagesFrameReader();
  const deadline = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, consumerAbort, deadline.signal]) : AbortSignal.any([consumerAbort, deadline.signal]);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let sawFrame = false;
  let cancelled = false;
  const cancelReader = (reason: unknown): void => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel(reason).catch(() => {});
  };
  const abort = (): void => {
    cancelReader(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  const armDeadline = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(
      () => {
        deadline.abort(new DOMException("Anthropic Messages stream stalled.", "TimeoutError"));
      },
      sawFrame ? STREAM_INACTIVITY_DEADLINE_MS : STREAM_FIRST_EVENT_DEADLINE_MS
    );
  };
  armDeadline();
  try {
    for (;;) {
      if (signal.aborted) throw abortError(signal);
      const next = await readWithAbort(reader, signal);
      for (const frame of framer.frames(next.done ? undefined : next.value)) {
        if (frame.kind === "event") sawFrame = true;
        armDeadline();
        yield frame;
      }
      if (next.done) throw new ResponsesStreamError("Anthropic Messages stream ended before message_stop.", { kind: "premature_eof" });
    }
  } catch (error) {
    throw streamReadFailure(error, options, consumerAbort, deadline.signal);
  } finally {
    clearTimeout(watchdog);
    signal.removeEventListener("abort", abort);
    cancelReader("Anthropic Messages stream consumer finished");
    reader.releaseLock();
  }
}

/** Progressive translation stops only at an actual native message_stop or error. */
async function* translatedMessagesStream(
  response: Response,
  options: AnthropicResponsesOptions,
  consumerAbort: AbortSignal
): AsyncGenerator<Uint8Array, void, unknown> {
  const translator = createMessagesTranslator(options);
  const encoder = new TextEncoder();
  for await (const frame of readMessagesFrames(response, options, consumerAbort)) {
    if (frame.kind === "comment") {
      yield encoder.encode(": keepalive\n\n");
      continue;
    }
    for (const translated of translator.push(frame.value)) yield encoder.encode(encodeResponsesEvent(translated));
    if (translator.done()) return;
  }
}

/** Normalize only recognizable native error JSON; leave other HTTP bodies intact. */
const normalizeMessagesHttpError = async (response: Response, options: AnthropicResponsesOptions): Promise<Response> => {
  const body = await readBoundedResponseBody(response.clone(), { signal: options.signal });
  if (options.signal?.aborted) throw abortError(options.signal);
  if (!body.complete) return response;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return response;
  }
  if (!record(value) || value.type !== "error" || !record(value.error) || typeof value.error.message !== "string") return response;
  const source = value.error;
  const type = typeof source.type === "string" ? source.type : "api_error";
  const error = {
    message: source.message,
    type,
    code: typeof source.code === "string" ? source.code : type,
    ...(source.param === null || typeof source.param === "string" ? { param: source.param } : {}),
  };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  void response.body?.cancel("Native Messages HTTP error normalized").catch(() => {});
  return new Response(JSON.stringify({ error }), { status: response.status, statusText: response.statusText, headers });
};

/** Preserve upstream HTTP status and provenance; normalize JSON and progressive SSE. */
export const normalizeAnthropicResponsesResponse = async (response: Response, options: AnthropicResponsesOptions): Promise<Response> => {
  if (!response.ok) return await normalizeMessagesHttpError(response, options);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    const cancellation = new AbortController();
    const iterator = translatedMessagesStream(response, options, cancellation.signal);
    let iteratorStarted = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        iteratorStarted = true;
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
        if (!iteratorStarted) await response.body?.cancel(reason).catch(() => {});
        await iterator.return().catch(() => {});
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers });
  }
  const body = await readBoundedResponseBody(response, {
    signal: options.signal,
    maxBytes: MAX_RESPONSES_SSE_EVENT_BYTES,
    timeoutMs: BUFFERED_INFERENCE_DEADLINE_MS,
  });
  if (options.signal?.aborted) throw abortError(options.signal);
  if (!body.complete) throw new ResponsesStreamError("Anthropic Messages body was incomplete or exceeded its bound.", { kind: "read_error" });
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch (cause) {
    throw new ResponsesStreamError("Anthropic Messages returned malformed JSON.", { cause, kind: "malformed_event" });
  }
  const translated = createMessagesTranslator(options).buffered(message);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(translated), { status: response.status, statusText: response.statusText, headers });
};
