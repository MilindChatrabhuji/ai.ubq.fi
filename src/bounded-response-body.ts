/**
 * Read an upstream response body under fixed byte and time limits.
 *
 * The returned bytes are useful only when `complete` is true unless a caller
 * deliberately chooses to retain a partial body.  Incomplete reads are
 * cancelled without awaiting the upstream cancellation so a stalled peer
 * cannot extend the gateway request's latency.
 */
export type BoundedResponseBody = Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  complete: boolean;
}>;

export type ReadBoundedResponseBodyOptions = Readonly<{
  /** An optional request-level cancellation signal. */
  signal?: AbortSignal;
  /** Defaults to the shared 64 KiB upstream-error ceiling. */
  maxBytes?: number;
  /** Defaults to the shared one-second upstream-error deadline. */
  timeoutMs?: number;
  /** Passed to `ReadableStreamDefaultReader.cancel` for observability. */
  cancellationReason?: unknown;
}>;

export const BOUNDED_RESPONSE_BODY_MAX_BYTES = 64 * 1024;
export const BOUNDED_RESPONSE_BODY_TIMEOUT_MS = 1_000;

/**
 * `AbortSignal.reason` is untyped, so a caller can abort with an arbitrary
 * value.  A promise rejection must carry an `Error`: when the reason already is
 * one it is passed through unchanged, otherwise it is preserved as the abort
 * error's `cause` instead of being rejected verbatim.
 */
const abortError = (reason: unknown): Error => {
  if (reason instanceof Error) return reason;
  const error = new Error("Upstream response body read aborted.", { cause: reason });
  error.name = "AbortError";
  return error;
};

const abortableRead = async <T>(reader: ReadableStreamDefaultReader<T>, signal: AbortSignal): Promise<Awaited<ReturnType<typeof reader.read>>> => {
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(abortError(signal.reason));
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
 * Read at most `maxBytes` before the deadline, returning the bytes accumulated
 * so far and whether the upstream body ended normally.  Readers are released
 * exactly once; incomplete streams are cancelled best-effort in the
 * background to preserve the bounded caller latency.
 */
export const readBoundedResponseBody = async (response: Response, options: ReadBoundedResponseBodyOptions = {}): Promise<BoundedResponseBody> => {
  const maxBytes = options.maxBytes ?? BOUNDED_RESPONSE_BODY_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? BOUNDED_RESPONSE_BODY_TIMEOUT_MS;
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), complete: true };

  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  let released = false;
  let cancellationStarted = false;
  const releaseReader = (): void => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released by a failing upstream stream.
    }
  };
  const cancelReader = (): void => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    try {
      const cancellation = reader.cancel(options.cancellationReason ?? "Bounded upstream body read incomplete");
      releaseReader();
      void cancellation.catch(() => {});
    } catch {
      releaseReader();
    }
  };

  const deadline = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    for (;;) {
      const next = await abortableRead(reader, deadline);
      if (next.done) {
        complete = true;
        break;
      }
      const remaining = maxBytes - length;
      const part = next.value.slice(0, remaining);
      chunks.push(part);
      length += part.byteLength;
      if (part.byteLength !== next.value.byteLength) break;
    }
  } catch {
    // Callers choose whether a partial body is safe to use.  The shared
    // primitive deliberately does not expose error details across providers.
  } finally {
    if (complete) releaseReader();
    else cancelReader();
  }

  const bytes = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, complete };
};
