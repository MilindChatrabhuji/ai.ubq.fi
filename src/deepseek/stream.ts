// DeepSeek SSE stream parsing, split out of src/deepseek.ts.

import { STREAM_FIRST_EVENT_DEADLINE_MS, STREAM_INACTIVITY_DEADLINE_MS } from "../inference-deadline.ts";
import { MAX_DEEPSEEK_SSE_FRAME_BYTES, SSE_FRAME_BOUNDARY, SSE_LINE_BOUNDARY, isTimeoutError, normalizeDeepSeekChatCompletionChunk } from "./index.ts";

export type DeepSeekStreamFailureKind = "malformed_event" | "invalid_chunk" | "frame_too_large" | "premature_eof" | "read_error" | "inactivity_timeout";

export class DeepSeekStreamError extends Error {
  readonly kind: DeepSeekStreamFailureKind;

  constructor(message: string, options?: ErrorOptions & { kind?: DeepSeekStreamFailureKind }) {
    super(message, options);
    this.name = "DeepSeekStreamError";
    this.kind = options?.kind ?? "read_error";
  }
}

export type DeepSeekStreamFrame =
  Readonly<{ kind: "comment"; text: string }> | Readonly<{ kind: "chunk"; value: Record<string, unknown> }> | Readonly<{ kind: "done" }>;

export type DeepSeekStreamOptions = Readonly<{
  /** Request-level cancellation, composed with the stream deadlines. */
  signal?: AbortSignal;
  /** Bounds the wait for the first upstream frame. */
  firstEventTimeoutMs?: number;
  /** Bounds the gap between subsequent upstream frames. */
  inactivityTimeoutMs?: number;
}>;

/**
 * Parses one complete SSE event block. `data:` payloads are the OpenAI Chat
 * Completions stream contract; DeepSeek's `: keep-alive` comments are relayed
 * verbatim because they are what keeps a long thinking turn from looking like
 * an idle connection to an edge proxy. Any other SSE field (`event:`, `id:`,
 * `retry:`) is not part of the Chat Completions contract and is not relayed.
 */
const parseSseEventBlock = (raw: string, requestedModel: string): DeepSeekStreamFrame | null => {
  const data: string[] = [];
  const comments: string[] = [];
  for (const line of raw.split(SSE_LINE_BOUNDARY)) {
    if (!line) continue;
    if (line.startsWith(":")) comments.push(line);
    else if (line === "data") data.push("");
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return comments.length ? { kind: "comment", text: comments.join("\n") } : null;
  const payload = data.join("\n");
  if (payload.trim() === "[DONE]") return { kind: "done" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new DeepSeekStreamError("Upstream emitted malformed Chat Completions SSE JSON.", { cause, kind: "malformed_event" });
  }
  const normalized = normalizeDeepSeekChatCompletionChunk(parsed, requestedModel);
  if (!normalized.ok) {
    throw new DeepSeekStreamError(`Upstream emitted an invalid Chat Completions chunk: ${normalized.message}`, { kind: "invalid_chunk" });
  }
  return { kind: "chunk", value: normalized.value };
};

/**
 * Splits an incremental SSE byte stream into relayable frames, retaining the
 * unterminated tail between reads. Frames that carry neither `data:` nor a
 * comment are skipped, and the byte bound is enforced on the retained tail.
 */
const createDeepSeekFrameReader = (
  requestedModel: string
): Readonly<{ push: (incoming: Uint8Array | null) => void; shift: () => DeepSeekStreamFrame | null }> => {
  const decoder = new TextDecoder();
  const buffered = { text: "" };
  const push = (incoming: Uint8Array | null): void => {
    buffered.text += incoming === null ? decoder.decode() : decoder.decode(incoming, { stream: true });
    if (buffered.text.length > MAX_DEEPSEEK_SSE_FRAME_BYTES) {
      throw new DeepSeekStreamError("Upstream SSE frame exceeded the gateway bound.", { kind: "frame_too_large" });
    }
  };
  const shift = (): DeepSeekStreamFrame | null => {
    for (;;) {
      const match = SSE_FRAME_BOUNDARY.exec(buffered.text);
      if (!match) return null;
      const raw = buffered.text.slice(0, match.index);
      buffered.text = buffered.text.slice(match.index + match[0].length);
      const frame = parseSseEventBlock(raw, requestedModel);
      if (frame) return frame;
    }
  };
  return { push, shift };
};

/**
 * Owns one upstream SSE read loop: the reader lock, the first-event and
 * inactivity watchdogs, and the frame queue. Kept outside the generator so
 * each concern is independently readable.
 */
const createDeepSeekStreamSession = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  requestedModel: string,
  deadline: AbortController,
  options: DeepSeekStreamOptions
): Readonly<{ next: () => Promise<DeepSeekStreamFrame | null>; finish: () => void }> => {
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const frames = createDeepSeekFrameReader(requestedModel);
  const state = { eof: false, released: false, sawFrame: false, watchdog: null as ReturnType<typeof setTimeout> | null };

  const stopWatchdog = (): void => {
    if (state.watchdog !== null) clearTimeout(state.watchdog);
  };
  const resetWatchdog = (): void => {
    stopWatchdog();
    const timeoutMs = state.sawFrame
      ? (options.inactivityTimeoutMs ?? STREAM_INACTIVITY_DEADLINE_MS)
      : (options.firstEventTimeoutMs ?? STREAM_FIRST_EVENT_DEADLINE_MS);
    state.watchdog = setTimeout(() => {
      deadline.abort(new DOMException("DeepSeek Chat Completions stream stalled.", "TimeoutError"));
    }, timeoutMs);
  };
  const releaseReaderLock = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released by a failing upstream stream.
    }
  };
  const finish = (): void => {
    stopWatchdog();
    if (state.released) return;
    state.released = true;
    try {
      const cancellation = reader.cancel("DeepSeek Chat Completions stream finished");
      releaseReaderLock();
      void cancellation.catch(() => {});
    } catch {
      releaseReaderLock();
    }
  };

  resetWatchdog();
  const next = async (): Promise<DeepSeekStreamFrame | null> => {
    for (;;) {
      const frame = frames.shift();
      if (frame) {
        state.sawFrame = true;
        resetWatchdog();
        return frame;
      }
      if (state.eof) return null;
      const result = await raceReaderRead(reader, signal);
      state.eof = result.done;
      frames.push(result.done ? null : result.value);
    }
  };
  return { next, finish };
};

/** Races one upstream read against the composed cancellation/deadline signal. */
const raceReaderRead = async (reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<Awaited<ReturnType<typeof reader.read>>> => {
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("The stream was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

/**
 * Reads the upstream Chat Completions SSE body and yields validated frames.
 *
 * `data:` frames are the OpenAI Chat Completions stream contract and are
 * normalized before they leave this module. DeepSeek's documented
 * `: keep-alive` comment frames are forwarded verbatim, because they are what
 * keeps a long thinking turn from looking like an idle connection to an edge
 * proxy. Any other SSE field (`event:`, `id:`, `retry:`) is not part of the
 * Chat Completions contract and is not relayed.
 */
export async function* iterateDeepSeekChatCompletionStream(
  response: Response,
  requestedModel: string,
  options: DeepSeekStreamOptions = {}
): AsyncGenerator<DeepSeekStreamFrame, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new DeepSeekStreamError("Upstream returned no Chat Completions stream body.", { kind: "premature_eof" });

  const deadline = new AbortController();
  const session = createDeepSeekStreamSession(reader, requestedModel, deadline, options);
  try {
    for (;;) {
      const frame = await session.next();
      if (!frame) throw new DeepSeekStreamError("Upstream Chat Completions stream ended before [DONE].", { kind: "premature_eof" });
      yield frame;
      if (frame.kind === "done") return;
    }
  } catch (error) {
    if (error instanceof DeepSeekStreamError) throw error;
    if (deadline.signal.aborted) {
      throw new DeepSeekStreamError("DeepSeek Chat Completions stream stalled.", { cause: error, kind: "inactivity_timeout" });
    }
    if (isTimeoutError(error) || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new DeepSeekStreamError("DeepSeek Chat Completions stream failed.", { cause: error, kind: "read_error" });
  } finally {
    session.finish();
  }
}
