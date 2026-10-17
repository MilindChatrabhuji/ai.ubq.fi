/**
 * Trusted recorded-upstream replay transport for sentinel regression tests.
 *
 * It converts an already-validated SentinelUpstreamTrace (see
 * src/sentinel_upstream_capture.ts) into a fetch transport that reproduces the
 * recorded upstream attempt sequence: the exact provider route per attempt in
 * recorded order, the exact recorded chunk boundaries, and the recorded
 * terminal semantics (eof, read_error, fetch_error, cancelled). It never
 * invokes the global fetch and never falls through to a real service: a
 * request whose URL is not the exact route of the next recorded attempt is a
 * permanent failure and rejects with a TypeError.
 *
 * Every failure is a fixed static message: no URL, body, token or header value
 * is ever included in an error, snapshot or assertion text. The helper performs
 * no sanitization and no causal-success attestation; replayed raw bytes remain
 * restricted capture evidence.
 */

import {
  parseSentinelUpstreamTrace,
  type SentinelUpstreamAttempt,
  type SentinelUpstreamProvider,
  type SentinelUpstreamTrace,
} from "../../src/sentinel/upstream-capture.ts";

export type RecordedUpstreamReplay = Readonly<{
  fetch: typeof fetch;
  assertComplete: () => void;
  snapshot: () => {
    attemptsDispatched: number;
    attemptsCompleted: number;
    chunksConsumed: number;
    chunksTotal: number;
    failed: boolean;
  };
}>;

const PROVIDERS: readonly SentinelUpstreamProvider[] = ["chatgpt_codex", "surplus", "metered", "cerebras", "deepseek", "lithos"];

const ROUTE_INVALID = "Sentinel recorded upstream route is not an exact HTTPS endpoint";
const ROUTE_AMBIGUOUS = "Sentinel recorded upstream routes are not unique across providers";
const TRACE_INVALID = "Sentinel recorded upstream trace is invalid";
const TRACE_EMPTY = "Sentinel recorded upstream trace has no attempts";
const TRACE_TRUNCATED = "Sentinel recorded upstream trace is truncated";
const ATTEMPT_PENDING = "Sentinel recorded upstream attempt is pending";
const ATTEMPT_NO_HEADERS = "Sentinel recorded upstream attempt has no response headers";
const ATTEMPT_INFORMATIONAL = "Sentinel recorded upstream attempt uses an unsupported informational status";
const ATTEMPT_BODYLESS = "Sentinel recorded upstream bodyless attempt is inconsistent";
const ATTEMPT_MIME = "Sentinel recorded upstream attempt lacks an exact MIME category";
const DISPATCH_MISMATCH = "Sentinel recorded upstream dispatch does not match the next recorded attempt";
const DISPATCH_EXTRA = "Sentinel recorded upstream received an extra dispatch";
const DISPATCH_FAILED = "Sentinel recorded upstream replay is already failed";
const STREAM_READ_ERROR = "Sentinel recorded upstream read failure is reproduced";
const STREAM_OVERREAD = "Sentinel recorded upstream prefix was read beyond its recorded chunks";
const INCOMPLETE = "Sentinel recorded upstream replay is incomplete";
const FAILED = "Sentinel recorded upstream replay failed";

type ReplayAttempt = {
  attempt: SentinelUpstreamAttempt;
  chunks: Uint8Array<ArrayBuffer>[];
  nextChunk: number;
  completed: boolean;
};

const decodeStandardBase64 = (encoded: string): Uint8Array<ArrayBuffer> => {
  // The trace parser enforces canonical padded base64, so atob never throws.
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/**
 * Build the replayed upstream transport for one parsed trace. The trace is
 * cloned and re-validated with the real exported parser; the caller's input
 * objects and buffers are never mutated. `routes` must map the recorded
 * provider enums to distinct exact HTTPS endpoint strings (there must be no
 * ambiguity where one endpoint could belong to two providers).
 *
 * The returned transport is unavailable (creation throws) for a trace with no
 * attempts, truncation flags, or any pending attempt, and for attempts whose
 * evidence cannot be reproduced exactly (headerless or unsupported MIME,
 * informational final status, inconsistent bodyless terminal).
 */
export const createRecordedUpstreamReplay = (
  trace: SentinelUpstreamTrace,
  routes: Readonly<Record<SentinelUpstreamProvider, string>>
): RecordedUpstreamReplay => {
  let parsed: SentinelUpstreamTrace;
  // The parser's own error text may embed indices; every helper-visible
  // failure is a fixed static message instead.
  try {
    parsed = parseSentinelUpstreamTrace(trace);
  } catch {
    throw new Error(TRACE_INVALID);
  }

  if (parsed.attempts.length === 0) throw new Error(TRACE_EMPTY);
  if (parsed.attempts_truncated || parsed.bytes_truncated || parsed.chunks_truncated) {
    throw new Error(TRACE_TRUNCATED);
  }

  const routeUrls = new Map<SentinelUpstreamProvider, string>();
  for (const provider of PROVIDERS) {
    const route = routes[provider];
    if (typeof route !== "string") throw new Error(ROUTE_INVALID);
    let url: URL;
    try {
      url = new URL(route);
    } catch {
      throw new Error(ROUTE_INVALID);
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
      throw new Error(ROUTE_INVALID);
    }
    routeUrls.set(provider, url.href);
  }
  if (new Set(routeUrls.values()).size !== PROVIDERS.length) throw new Error(ROUTE_AMBIGUOUS);

  const replayAttempts: ReplayAttempt[] = parsed.attempts.map((attempt) => {
    if (attempt.terminal === "pending") throw new Error(ATTEMPT_PENDING);
    if (attempt.terminal === "fetch_error") {
      // The parser enforces status null, no content type and no chunks here.
      return { attempt, chunks: [], nextChunk: 0, completed: false };
    }
    if (attempt.status === null) throw new Error(ATTEMPT_NO_HEADERS);
    if (attempt.status < 200) throw new Error(ATTEMPT_INFORMATIONAL);
    if (attempt.status === 204 || attempt.status === 205 || attempt.status === 304) {
      // Bodyless responses are only reproducible when the terminal was EOF
      // with no chunks; MIME evidence is not required for a null body.
      if (attempt.terminal !== "eof" || attempt.chunks_base64.length !== 0) {
        throw new Error(ATTEMPT_BODYLESS);
      }
      return { attempt, chunks: [], nextChunk: 0, completed: false };
    }
    if (attempt.content_type !== "application/json" && attempt.content_type !== "text/event-stream") {
      throw new Error(ATTEMPT_MIME);
    }
    return {
      attempt,
      chunks: attempt.chunks_base64.map(decodeStandardBase64),
      nextChunk: 0,
      completed: false,
    };
  });
  const totalChunks = replayAttempts.reduce((sum, state) => sum + state.chunks.length, 0);

  let dispatchedCount = 0;
  let completedCount = 0;
  let failed = false;

  const markCompleted = (state: ReplayAttempt): void => {
    if (state.completed) return;
    state.completed = true;
    completedCount += 1;
  };

  const makeReplayResponse = (state: ReplayAttempt): Response => {
    const { attempt } = state;
    const status = attempt.status;
    // Validation guarantees only header-bearing attempts reach this point.
    if (status === null) throw new Error(ATTEMPT_NO_HEADERS);
    if (status === 204 || status === 205 || status === 304) {
      markCompleted(state);
      return new Response(null, { status });
    }
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (state.nextChunk < state.chunks.length) {
            // Exact recorded boundary: one original chunk per pull, zero
            // read-ahead (highWaterMark 0).
            controller.enqueue(state.chunks[state.nextChunk]);
            state.nextChunk += 1;
            return;
          }
          if (attempt.terminal === "eof") {
            // EOF closes only on the pull after the final chunk was delivered.
            controller.close();
            markCompleted(state);
            return;
          }
          if (attempt.terminal === "read_error") {
            controller.error(new TypeError(STREAM_READ_ERROR));
            markCompleted(state);
            return;
          }
          // Recorded cancelled prefix: reading past the captured prefix is a
          // permanent failure and must error, never invent EOF.
          failed = true;
          controller.error(new TypeError(STREAM_OVERREAD));
        },
        cancel() {
          if (attempt.terminal !== "cancelled") return;
          if (state.nextChunk >= state.chunks.length) {
            markCompleted(state);
          } else {
            failed = true;
          }
        },
      },
      { highWaterMark: 0 }
    );
    return new Response(stream, {
      status,
      headers: {
        "Content-Type": attempt.content_type === "application/json" ? "application/json" : "text/event-stream",
      },
    });
  };

  const fetchImpl: typeof fetch = Object.assign(
    (input: RequestInfo | URL, _init?: RequestInit) => {
      if (failed) return Promise.reject(new TypeError(DISPATCH_FAILED));
      let requestedUrl: string;
      try {
        requestedUrl = input instanceof Request ? input.url : new URL(String(input)).href;
      } catch {
        failed = true;
        return Promise.reject(new TypeError(DISPATCH_MISMATCH));
      }
      // `at` keeps the out-of-range read visible to the type checker, so the
      // DISPATCH_EXTRA guard below validates a genuinely optional element.
      const state = replayAttempts.at(dispatchedCount);
      if (state === undefined) {
        failed = true;
        return Promise.reject(new TypeError(DISPATCH_EXTRA));
      }
      if (requestedUrl !== routeUrls.get(state.attempt.provider)) {
        failed = true;
        return Promise.reject(new TypeError(DISPATCH_MISMATCH));
      }
      dispatchedCount += 1;
      if (state.attempt.terminal === "fetch_error") {
        markCompleted(state);
        return Promise.reject(new TypeError(STREAM_READ_ERROR));
      }
      return Promise.resolve(makeReplayResponse(state));
    },
    { preconnect: () => {} }
  );

  return Object.freeze({
    fetch: fetchImpl,
    assertComplete: () => {
      if (failed) throw new Error(FAILED);
      if (dispatchedCount !== replayAttempts.length || completedCount !== replayAttempts.length) {
        throw new Error(INCOMPLETE);
      }
    },
    snapshot: () => ({
      attemptsDispatched: dispatchedCount,
      attemptsCompleted: completedCount,
      // Chunks the consumer actually pulled, which is how a claim that the
      // whole recorded prefix was replayed is attested without requiring a
      // parser to read past its own terminal marker.
      chunksConsumed: replayAttempts.reduce((sum, state) => sum + state.nextChunk, 0),
      chunksTotal: totalChunks,
      failed,
    }),
  });
};
