import { getString, isRecord } from "./utils.ts";
import { STREAM_FIRST_EVENT_DEADLINE_MS, STREAM_INACTIVITY_DEADLINE_MS } from "./inference-deadline.ts";

export const RESPONSES_TERMINAL_EVENT_TYPES = new Set(["error", "response.completed", "response.failed", "response.incomplete"]);

export type ResponsesStreamEvent = Readonly<{
  raw: string;
  value: Record<string, unknown>;
  type: string;
  terminal: boolean;
}>;

export type ResponsesStreamFailureKind =
  | "malformed_event"
  | "premature_eof"
  | "read_error"
  | "inactivity_timeout"
  | "event_too_large"
  | "upstream_http_4xx"
  | "upstream_http_5xx"
  | "upstream_http_error"
  | "empty_upstream_completion";

export const MAX_RESPONSES_SSE_EVENT_BYTES = 16 * 1024 * 1024;

// Keep serverless and proxy connections active while the provider is thinking.
// SSE comments are ignored by OpenAI clients and do not change the wire schema.
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
const SSE_KEEPALIVE_FRAME = new TextEncoder().encode(": keepalive\n\n");

export type ResponsesStreamIterator = AsyncGenerator<ResponsesStreamEvent, unknown, unknown>;

export type PreflightedResponsesStream = Readonly<{
  first: ResponsesStreamEvent;
  iterator: ResponsesStreamIterator;
  cancel: (reason?: unknown) => Promise<void>;
}>;

export class ResponsesStreamError extends Error {
  readonly kind: ResponsesStreamFailureKind;

  constructor(message: string, options?: ErrorOptions & { kind?: ResponsesStreamFailureKind }) {
    super(message, options);
    this.name = "ResponsesStreamError";
    this.kind = options?.kind ?? "read_error";
  }
}

const parseEventBlock = (raw: string): ResponsesStreamEvent | null => {
  const data: string[] = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line === "data") data.push("");
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;

  let value: unknown;
  try {
    value = JSON.parse(data.join("\n"));
  } catch (cause) {
    throw new ResponsesStreamError("Upstream emitted malformed Responses SSE JSON.", {
      cause,
      kind: "malformed_event",
    });
  }
  if (!isRecord(value)) {
    throw new ResponsesStreamError("Upstream emitted a non-object Responses SSE event.", {
      kind: "malformed_event",
    });
  }
  const type = getString(value.type)?.trim();
  if (!type) {
    throw new ResponsesStreamError("Upstream emitted a Responses SSE event without a type.", {
      kind: "malformed_event",
    });
  }
  const hasNestedError = Object.prototype.hasOwnProperty.call(value, "error");
  const isFlatError =
    (value.code === null || (typeof value.code === "string" && value.code.trim())) &&
    typeof value.message === "string" &&
    value.message.trim() &&
    (value.param === null || typeof value.param === "string");
  if (
    (type === "error" && (hasNestedError ? !isRecord(value.error) || Array.isArray(value.error) : !isFlatError)) ||
    (type !== "error" && RESPONSES_TERMINAL_EVENT_TYPES.has(type) && (!isRecord(value.response) || Array.isArray(value.response)))
  ) {
    throw new ResponsesStreamError("Upstream emitted a Responses terminal event with an invalid payload.", {
      kind: "malformed_event",
    });
  }
  return { raw, value, type, terminal: RESPONSES_TERMINAL_EVENT_TYPES.has(type) };
};

/**
 * Incremental SSE framing state. Bytes accumulate into a reusable buffer that
 * grows geometrically and never exceeds the protocol's ceiling; complete
 * blocks are handed back one at a time so the reader can yield between them.
 * Unlike a string accumulator, this neither re-encodes every fragmented event
 * nor allocates an unbounded intermediate string.
 */
type SseEventFramer = Readonly<{
  /** Raw text of every complete SSE block found in `chunk`, in wire order. */
  frames(chunk: Uint8Array): Generator<string, void, unknown>;
  /** Raw text of the trailing block that never received a closing boundary. */
  flush(): string;
  /** True while bytes belonging to an incomplete block are buffered. */
  hasPending(): boolean;
}>;

const createSseEventFramer = (decoder: TextDecoder): SseEventFramer => {
  let buffer = new Uint8Array(Math.min(4_096, MAX_RESPONSES_SSE_EVENT_BYTES));
  let length = 0;
  let thirdPreviousByte = -1;
  let secondPreviousByte = -1;
  let previousByte = -1;

  const oversized = (): ResponsesStreamError =>
    new ResponsesStreamError("Upstream emitted an oversized Responses SSE event.", {
      kind: "event_too_large",
    });

  const append = (value: Uint8Array): void => {
    const nextLength = length + value.byteLength;
    if (nextLength > MAX_RESPONSES_SSE_EVENT_BYTES) throw oversized();
    if (nextLength > buffer.byteLength) {
      const nextCapacity = Math.min(MAX_RESPONSES_SSE_EVENT_BYTES, Math.max(nextLength, buffer.byteLength * 2));
      const next = new Uint8Array(nextCapacity);
      next.set(buffer.subarray(0, length));
      buffer = next;
    }
    buffer.set(value, length);
    length = nextLength;
  };

  const take = (): string => {
    const raw = decoder.decode(buffer.subarray(0, length));
    length = 0;
    thirdPreviousByte = -1;
    secondPreviousByte = -1;
    previousByte = -1;
    return raw;
  };

  const isBoundary = (byte: number): boolean => {
    // CRLF is one line terminator. The CR in CRLFCRLF must not terminate
    // early, while mixed LF+CRLF framing (\n\r\n) must still split.
    if (byte === 10) {
      return previousByte === 10 || (previousByte === 13 && thirdPreviousByte === 13 && secondPreviousByte === 10);
    }
    if (byte !== 13) return false;
    if (previousByte === 13) return true;
    return previousByte === 10 && secondPreviousByte !== 13;
  };

  const advanceBoundaryState = (byte: number): void => {
    thirdPreviousByte = secondPreviousByte;
    secondPreviousByte = previousByte;
    previousByte = byte;
  };

  const ensurePendingWithinLimit = (pendingBytes: number): void => {
    if (length + pendingBytes > MAX_RESPONSES_SSE_EVENT_BYTES) throw oversized();
  };

  function* frames(chunk: Uint8Array): Generator<string, void, unknown> {
    let segmentStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index];
      ensurePendingWithinLimit(index - segmentStart + 1);
      if (!isBoundary(byte)) {
        advanceBoundaryState(byte);
        continue;
      }
      append(chunk.subarray(segmentStart, index + 1));
      segmentStart = index + 1;
      yield take();
    }
    if (segmentStart < chunk.byteLength) append(chunk.subarray(segmentStart));
  }

  return { frames, flush: take, hasPending: () => length > 0 };
};

const EMPTY_CHUNK = new Uint8Array(0);

type ResponsesStreamChunk = Readonly<{
  /** Bytes carried by one upstream read; empty when the read carried none. */
  bytes: Uint8Array;
  /** True when the upstream reader reported that the stream ended. */
  done: boolean;
}>;

type ResponsesStreamSession = Readonly<{
  nextChunk(): Promise<ResponsesStreamChunk>;
  /** Complete events framed by `bytes`, in wire order. */
  takeEvents(bytes: Uint8Array): Generator<ResponsesStreamEvent, void, unknown>;
  /** Trailing event of a stream that ended without a closing boundary. */
  takeTrailingEvent(): ResponsesStreamEvent | null;
  cancel(reason: unknown): void;
  /** Releases the upstream reader, cancelling it when no terminal event arrived. */
  dispose(): void;
}>;

const createResponsesStreamSession = (
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  options: Readonly<{
    firstEventTimeoutMs?: number;
    inactivityTimeoutMs?: number;
    /** Runs for every non-empty raw read, including comments and partial SSE frames. */
    onActivity?: () => void | Promise<void>;
  }>
): ResponsesStreamSession => {
  const reader = stream.getReader();
  const framer = createSseEventFramer(new TextDecoder());
  let readerDone = false;
  let cancelStarted = false;
  let sawEvent = false;
  const cancelReaderOnce = (reason: unknown): void => {
    if (cancelStarted || readerDone) return;
    cancelStarted = true;
    void reader.cancel(reason).catch(() => {});
  };
  const abort = (): void => {
    cancelReaderOnce(signal?.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const firstEventDeadlineAtMs = Date.now() + (options.firstEventTimeoutMs ?? STREAM_FIRST_EVENT_DEADLINE_MS);
  const readWithDeadline = async (): Promise<Awaited<ReturnType<typeof reader.read>>> => {
    const timeoutMs = sawEvent ? (options.inactivityTimeoutMs ?? STREAM_INACTIVITY_DEADLINE_MS) : Math.max(0, firstEventDeadlineAtMs - Date.now());
    const timeout = AbortSignal.timeout(timeoutMs);
    let abortTimeout = (): void => {};
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          abortTimeout = () => {
            reject(
              new ResponsesStreamError("Upstream Responses stream became inactive.", {
                kind: "inactivity_timeout",
              })
            );
          };
          timeout.addEventListener("abort", abortTimeout, { once: true });
        }),
      ]);
    } finally {
      timeout.removeEventListener("abort", abortTimeout);
    }
  };
  const markParsedEvent = (parsed: ResponsesStreamEvent): void => {
    sawEvent = true;
    if (parsed.terminal) cancelReaderOnce("Responses terminal event received");
  };
  function* takeEvents(bytes: Uint8Array): Generator<ResponsesStreamEvent, void, unknown> {
    for (const frame of framer.frames(bytes)) {
      const parsed = parseEventBlock(frame);
      if (!parsed) continue;
      markParsedEvent(parsed);
      yield parsed;
    }
  }
  const takeTrailingEvent = (): ResponsesStreamEvent | null => {
    if (!framer.hasPending()) return null;
    const parsed = parseEventBlock(framer.flush());
    if (!parsed) return null;
    markParsedEvent(parsed);
    return parsed;
  };
  const nextChunk = async (): Promise<ResponsesStreamChunk> => {
    if (signal?.aborted) throw signal.reason;
    const { value, done } = await readWithDeadline();
    if (signal?.aborted) throw signal.reason;
    readerDone = done;
    const bytes = value ?? EMPTY_CHUNK;
    if (!bytes.byteLength) return { bytes, done };
    await options.onActivity?.();
    if (signal?.aborted) throw signal.reason;
    return { bytes, done };
  };
  const dispose = (): void => {
    signal?.removeEventListener("abort", abort);
    if (!readerDone) cancelReaderOnce("Responses stream consumer stopped before a terminal event");
    reader.releaseLock();
  };
  return { nextChunk, takeEvents, takeTrailingEvent, cancel: cancelReaderOnce, dispose };
};

/**
 * Forwards upstream events until a terminal one has been yielded, and reports
 * whether that happened. `markParsedEvent` closes the reader as soon as it sees
 * a terminal event, so `false` always means the upstream stream ended early.
 */
async function* consumeResponsesStream(session: ResponsesStreamSession): AsyncGenerator<ResponsesStreamEvent, boolean, unknown> {
  for (;;) {
    const { bytes, done } = await session.nextChunk();
    for (const parsed of session.takeEvents(bytes)) {
      yield parsed;
      if (parsed.terminal) return true;
    }
    if (done) break;
  }
  const trailing = session.takeTrailingEvent();
  if (trailing) {
    yield trailing;
    if (trailing.terminal) return true;
  }
  return false;
}

export async function* readResponsesStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options: Readonly<{
    firstEventTimeoutMs?: number;
    inactivityTimeoutMs?: number;
    /** Runs for every non-empty raw read, including comments and partial SSE frames. */
    onActivity?: () => void | Promise<void>;
  }> = {}
): ResponsesStreamIterator {
  const session = createResponsesStreamSession(stream, signal, options);
  try {
    if (yield* consumeResponsesStream(session)) return;
    throw new ResponsesStreamError("Upstream Responses stream ended before a terminal event.", {
      kind: "premature_eof",
    });
  } catch (error) {
    session.cancel(error);
    if (signal?.aborted) throw signal.reason;
    if (error instanceof ResponsesStreamError) throw error;
    throw new ResponsesStreamError("Upstream Responses stream could not be read.", { cause: error });
  } finally {
    session.dispose();
  }
}

export const preflightResponsesStream = async (
  upstream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options: Readonly<{ onActivity?: () => void | Promise<void> }> = {}
): Promise<PreflightedResponsesStream> => {
  const cancellation = new AbortController();
  const streamSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  const iterator = readResponsesStream(upstream, streamSignal, options);
  const cancel = async (reason?: unknown): Promise<void> => {
    if (!cancellation.signal.aborted) cancellation.abort(reason);
    await iterator.return(reason).catch(() => {});
  };
  try {
    const next = await iterator.next();
    const first: ResponsesStreamEvent | undefined = next.done ? undefined : next.value;
    if (!first) {
      throw new ResponsesStreamError("Upstream Responses stream ended before its first event.", {
        kind: "premature_eof",
      });
    }
    return {
      first,
      iterator,
      cancel,
    };
  } catch (error) {
    await cancel(error);
    throw error;
  }
};

const errorEvent = (message: string): Uint8Array => {
  const value = {
    type: "error",
    error: {
      type: "server_error",
      code: "upstream_stream_error",
      message,
      param: null,
    },
  };
  return new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(value)}\n\n`);
};

type ProxyResponsesStreamOptions = Readonly<{
  signal?: AbortSignal;
  downstreamSignal?: AbortSignal;
  onEvent?: (event: ResponsesStreamEvent) => void | Promise<void>;
  onFailure?: (error: unknown) => void | Promise<void>;
  onCancel?: (reason: unknown) => void | Promise<void>;
  /**
   * Releases the upstream read when the downstream consumer cancels.  An
   * abandoned consumer cannot await an iterator parked on a pending upstream
   * read, so cancellation has to reach the source directly.
   */
  abortUpstream?: (reason?: unknown) => void;
}>;

export const proxyResponsesStreamIterator = (
  iterator: ResponsesStreamIterator,
  options: ProxyResponsesStreamOptions = {},
  initialEvent?: ResponsesStreamEvent
): ReadableStream<Uint8Array> => {
  const localAbort = new AbortController();
  let pending = initialEvent;
  let closed = false;
  // `cancel()` can flip this flag while `pull` is awaiting the upstream read, so
  // the post-await check reads it through a call: a direct read would keep the
  // value the checker narrowed before the await.
  const isClosed = (): boolean => closed;
  const invoke = (callback: (() => void | Promise<void>) | undefined): void => {
    if (!callback) return;
    try {
      void Promise.resolve(callback()).catch(() => {});
    } catch {
      // Lifecycle callbacks must never interfere with downstream delivery.
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const next = pending ? { done: false as const, value: pending } : await iterator.next();
        pending = undefined;
        if (isClosed()) return;
        if (next.done) {
          closed = true;
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(next.value.raw));
        invoke(() => options.onEvent?.(next.value));
        if (next.value.terminal) {
          closed = true;
          controller.close();
          void iterator.return("Responses terminal event forwarded").catch(() => {});
        }
      } catch (error) {
        if (closed) return;
        if (!localAbort.signal.aborted && !options.signal?.aborted && !options.downstreamSignal?.aborted) {
          controller.enqueue(errorEvent("The upstream stream ended unexpectedly."));
        }
        closed = true;
        controller.close();
        invoke(() => options.onFailure?.(error));
      }
    },
    cancel(reason) {
      if (closed) return;
      closed = true;
      invoke(() => options.onCancel?.(reason));
      localAbort.abort(reason);
      options.abortUpstream?.(reason);
      void iterator.return(reason).catch(() => {});
    },
  });
};

/**
 * Adds protocol-level SSE comments while an upstream stream is quiet. The
 * source remains incremental: provider bytes are forwarded as soon as they
 * arrive, and the heartbeat is only a small connection-preserving burst.
 */
export const withSseKeepalive = (source: ReadableStream<Uint8Array>, options: Readonly<{ intervalMs?: number }> = {}): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  const configuredIntervalMs = options.intervalMs ?? SSE_KEEPALIVE_INTERVAL_MS;
  const intervalMs = Number.isFinite(configuredIntervalMs) && configuredIntervalMs > 0 ? configuredIntervalMs : 0;
  let closed = false;
  // `cancel()` can flip this flag while `pull` is waiting on the read race, so
  // the post-wait check reads it through a call: a direct read would keep the
  // value the checker narrowed before the await.
  const isClosed = (): boolean => closed;
  // The pending timer is tracked by the call that cancels it: Deno's timer
  // handle type is not portable across the lint project's type environment.
  let clearPendingHeartbeat: (() => void) | null = null;
  let pendingRead: Promise<Awaited<ReturnType<typeof reader.read>>> | null = null;
  let resolveHeartbeat: (() => void) | null = null;
  const heartbeat = (): Promise<"heartbeat"> =>
    new Promise((resolve) => {
      resolveHeartbeat = () => {
        resolve("heartbeat");
      };
      const timer = setTimeout(() => {
        clearPendingHeartbeat = null;
        resolveHeartbeat = null;
        resolve("heartbeat");
      }, intervalMs);
      clearPendingHeartbeat = () => {
        clearTimeout(timer);
      };
    });
  const stopHeartbeat = (): void => {
    clearPendingHeartbeat?.();
    clearPendingHeartbeat = null;
    resolveHeartbeat?.();
    resolveHeartbeat = null;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        pendingRead ??= reader.read();
        const outcome =
          intervalMs > 0
            ? await Promise.race([pendingRead.then((result) => ({ kind: "read" as const, result })), heartbeat().then((kind) => ({ kind }))])
            : { kind: "read" as const, result: await pendingRead };
        if (outcome.kind === "heartbeat") {
          // Cancellation resolves the pending heartbeat, so a cancelled
          // consumer must not receive one more frame from that race.
          if (isClosed()) return;
          controller.enqueue(SSE_KEEPALIVE_FRAME.slice());
          return;
        }
        stopHeartbeat();
        pendingRead = null;
        const { value, done } = outcome.result;
        if (isClosed()) return;
        if (done) {
          closed = true;
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        if (closed) return;
        closed = true;
        stopHeartbeat();
        controller.error(error);
      }
    },
    cancel(reason) {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      void reader.cancel(reason).catch(() => {});
    },
  });
};

export const proxyResponsesStream = (upstream: ReadableStream<Uint8Array>, options: ProxyResponsesStreamOptions = {}): ReadableStream<Uint8Array> => {
  const cancellation = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  return proxyResponsesStreamIterator(readResponsesStream(upstream, signal), {
    ...options,
    abortUpstream: (reason) => {
      if (!cancellation.signal.aborted) cancellation.abort(reason);
      // A consumer can cancel before the iterator's first read, so the session
      // never owns the reader; release the untouched source here instead.
      if (!upstream.locked) void upstream.cancel(reason).catch(() => {});
      options.abortUpstream?.(reason);
    },
  });
};
