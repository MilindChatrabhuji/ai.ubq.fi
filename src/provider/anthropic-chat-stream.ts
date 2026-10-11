import { STREAM_FIRST_EVENT_DEADLINE_MS, STREAM_INACTIVITY_DEADLINE_MS } from "../inference-deadline.ts";
import { MAX_RESPONSES_SSE_EVENT_BYTES, ResponsesStreamError } from "../responses-stream.ts";
type JsonRecord = Record<string, unknown>;
type ChatFrame = Readonly<{ kind: "chunk"; value: JsonRecord }> | Readonly<{ kind: "done" }> | Readonly<{ kind: "comment"; text: string }>;
const record = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const malformed = (message: string): ResponsesStreamError => new ResponsesStreamError(message, { kind: "malformed_event" });
const parse = (raw: string): ChatFrame | null => {
  const data: string[] = [];
  const comments: string[] = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (line.startsWith(":")) comments.push(line);
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return comments.length ? { kind: "comment", text: comments.join("\n") } : null;
  if (data.join("\n").trim() === "[DONE]") return { kind: "done" };
  let value: unknown;
  try {
    value = JSON.parse(data.join("\n"));
  } catch (cause) {
    throw new ResponsesStreamError("Claude Chat emitted malformed SSE JSON.", { cause, kind: "malformed_event" });
  }
  if (!record(value)) throw malformed("Claude Chat emitted a non-object stream chunk.");
  if (value.error !== undefined) throw new ResponsesStreamError("Claude Chat reported an upstream stream error.", { cause: value.error, kind: "read_error" });
  if (!Array.isArray(value.choices)) throw malformed("Claude Chat stream chunk has no choices.");
  return { kind: "chunk", value };
};
const frames = () => {
  let buffer = "";
  const decoder = new TextDecoder();
  const bounded = (value: string): void => {
    if (new TextEncoder().encode(value).byteLength > MAX_RESPONSES_SSE_EVENT_BYTES)
      throw new ResponsesStreamError("Claude Chat stream frame exceeded its bound.", { kind: "event_too_large" });
  };
  function* push(incoming?: Uint8Array): Generator<ChatFrame, void, unknown> {
    buffer += incoming ? decoder.decode(incoming, { stream: true }) : decoder.decode();
    for (;;) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
      if (!match && incoming) {
        bounded(buffer);
        return;
      }
      const end = match?.index ?? buffer.length;
      const raw = buffer.slice(0, end);
      bounded(raw);
      buffer = match ? buffer.slice(end + match[0].length) : "";
      const event = parse(raw);
      if (event) yield event;
      if (!match) return;
    }
  }
  return { push };
};
const abortedError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("Claude Chat was aborted.", "AbortError");
const read = async (reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> => {
  let abort = (): void => {};
  const rejected = new Promise<never>((_, reject) => {
    abort = () => {
      reject(abortedError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([reader.read(), rejected]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};
const readFailure = (error: unknown, downstream: AbortSignal, deadline: AbortSignal): Error => {
  if (downstream.aborted) return abortedError(downstream);
  if (deadline.aborted) return new ResponsesStreamError("Claude Chat stream became inactive.", { cause: error, kind: "inactivity_timeout" });
  if (error instanceof ResponsesStreamError) return error;
  return new ResponsesStreamError("Claude Chat stream could not be read.", { cause: error });
};
export async function* readAnthropicChatStream(response: Response, downstream: AbortSignal): AsyncGenerator<ChatFrame, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ResponsesStreamError("Claude Chat returned no stream body.", { kind: "premature_eof" });
  const framer = frames();
  const deadline = new AbortController();
  const signal = AbortSignal.any([downstream, deadline.signal]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let sawFrame = false;
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel(signal.reason).catch(() => {});
  };
  const arm = (): void => {
    clearTimeout(timeout);
    timeout = setTimeout(
      () => {
        deadline.abort(new DOMException("Claude Chat stream stalled.", "TimeoutError"));
      },
      sawFrame ? STREAM_INACTIVITY_DEADLINE_MS : STREAM_FIRST_EVENT_DEADLINE_MS
    );
  };
  signal.addEventListener("abort", cancel, { once: true });
  arm();
  try {
    for (;;) {
      const next = await read(reader, signal);
      for (const frame of framer.push(next.done ? undefined : next.value)) {
        sawFrame = true;
        arm();
        yield frame;
        if (frame.kind === "done") return;
      }
      if (next.done) throw new ResponsesStreamError("Claude Chat stream ended before [DONE].", { kind: "premature_eof" });
    }
  } catch (error) {
    throw readFailure(error, downstream, deadline.signal);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
