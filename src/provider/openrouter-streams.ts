// OpenRouter stream plumbing: validated SSE frames for both OpenAI wires.
//
// OpenRouter re-publishes the OpenAI streaming contracts, so the chat wire can
// run through the shared provider relay once its frames are validated, and the
// native Responses events can run through the shared Responses proxy. Both
// wrappers keep the gateway's standard `: keepalive` frames, so a quiet
// provider never looks like a dead connection to a client or an edge proxy.

import { markChatSemanticOutput, recordResponsesTerminal } from "../chat/stream-translation.ts";
import { openaiError } from "../http.ts";
import { STREAM_FIRST_EVENT_DEADLINE_MS, STREAM_INACTIVITY_DEADLINE_MS } from "../inference-deadline.ts";
import {
  type ResponseStreamTerminalType,
  type UsageContext,
  recordErrorUsage,
  recordFirstSemanticCommitment,
  recordFirstUpstreamSseEvent,
  recordStreamTerminal,
  recordStreamTerminalType,
} from "../openai-telemetry.ts";
import { proxyResponsesStream, type ResponsesStreamEvent, withSseKeepalive } from "../responses-stream.ts";
import { openRouterResponseHeaders } from "../upstream-wire.ts";
import { isRecord } from "../utils.ts";
import { recordOpenRouterProviderHealth } from "./health.ts";
import { type ProviderChatStreamAdapter, type ProviderStreamFrame, relayChatCompletionStream } from "./stream-relay.ts";

/** A single SSE frame bound; the gateway's other chat relays use the same order of magnitude. */
export const OPENROUTER_SSE_FRAME_MAX_BYTES = 4 * 1024 * 1024;
const SSE_FRAME_BOUNDARY = /\r?\n\r?\n/;
const SSE_LINE_BOUNDARY = /\r?\n/;

export type OpenRouterStreamFailureKind =
  | "malformed_event"
  | "invalid_chunk"
  | "upstream_error"
  | "frame_too_large"
  | "premature_eof"
  | "read_error"
  | "inactivity_timeout"
  | "incomplete_response"
  | "cancellation"
  | `openrouter_finish_reason:${string}`;

export class OpenRouterStreamError extends Error {
  readonly kind: OpenRouterStreamFailureKind;

  constructor(message: string, options?: ErrorOptions & { kind?: OpenRouterStreamFailureKind }) {
    super(message, options);
    this.name = "OpenRouterStreamError";
    this.kind = options?.kind ?? "read_error";
  }
}

/** Mirrors the buffered route's health classification for both streamed wires. */
export const recordOpenRouterResponseHealth = (status: number, providerRequestId: string | null = null): void => {
  if (status === 401 || status === 403) {
    void recordOpenRouterProviderHealth("auth_invalid", status, Date.now, providerRequestId);
    return;
  }
  if (status === 402 || status === 429) {
    void recordOpenRouterProviderHealth("quota_exhausted", status, Date.now, providerRequestId);
    return;
  }
  if (status >= 500) {
    void recordOpenRouterProviderHealth("upstream_error", status, Date.now, providerRequestId);
    return;
  }
  if (status >= 400) {
    void recordOpenRouterProviderHealth("reachable", status, Date.now, providerRequestId);
    return;
  }
  void recordOpenRouterProviderHealth("success", status, Date.now, providerRequestId);
};

const failureKindForStreamError = (error: unknown): OpenRouterStreamFailureKind => (error instanceof OpenRouterStreamError ? error.kind : "read_error");

const openRouterFinishReasonFailureKind = (finishReason: string | null): OpenRouterStreamFailureKind =>
  `openrouter_finish_reason:${finishReason !== null && /^[A-Za-z0-9_.:-]{1,64}$/.test(finishReason) ? finishReason : "unrecognized"}`;

const terminalTypeForStreamError = (error: unknown, downstreamSignal: AbortSignal): ResponseStreamTerminalType => {
  if (downstreamSignal.aborted) return "cancelled";
  if (error instanceof OpenRouterStreamError && error.kind === "inactivity_timeout") return "deadline";
  if (error instanceof Error && error.name === "TimeoutError") return "deadline";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "error";
};

/**
 * Parses one complete SSE event block from the Chat Completions wire. `data:`
 * payloads are validated as OpenAI chunks; OpenRouter's `: PROCESSING`
 * keep-alive comments are relayed verbatim because they are what keeps a long
 * generation from looking like an idle connection to an edge proxy.
 */
const chatFrameFromPayload = (payload: string): ProviderStreamFrame => {
  if (payload.trim() === "[DONE]") return { kind: "done" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new OpenRouterStreamError("OpenRouter emitted malformed Chat Completions SSE JSON.", { cause, kind: "malformed_event" });
  }
  if (!isRecord(parsed)) throw new OpenRouterStreamError("OpenRouter emitted a non-object Chat Completions chunk.", { kind: "invalid_chunk" });
  if (parsed.error !== undefined) {
    const message = isRecord(parsed.error) ? parsed.error.message : parsed.error;
    throw new OpenRouterStreamError(typeof message === "string" && message ? message : "OpenRouter reported an upstream stream error.", {
      kind: "upstream_error",
    });
  }
  if (!Array.isArray(parsed.choices))
    throw new OpenRouterStreamError("OpenRouter emitted a Chat Completions chunk without choices.", { kind: "invalid_chunk" });
  return { kind: "chunk", value: parsed };
};

const parseOpenRouterSseEventBlock = (raw: string): ProviderStreamFrame | null => {
  const data: string[] = [];
  const comments: string[] = [];
  for (const line of raw.split(SSE_LINE_BOUNDARY)) {
    if (!line) continue;
    if (line.startsWith(":")) comments.push(line);
    else if (line === "data") data.push("");
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return comments.length ? { kind: "comment", text: comments.join("\n") } : null;
  return chatFrameFromPayload(data.join("\n"));
};

/** Splits an incremental SSE byte stream into relayable frames, retaining the unterminated tail between reads. */
const createOpenRouterFrameReader = (): Readonly<{ push: (incoming: Uint8Array | null) => void; shift: () => ProviderStreamFrame | null }> => {
  const decoder = new TextDecoder();
  const buffered = { text: "" };
  const push = (incoming: Uint8Array | null): void => {
    buffered.text += incoming === null ? decoder.decode() : decoder.decode(incoming, { stream: true });
    if (buffered.text.length > OPENROUTER_SSE_FRAME_MAX_BYTES) {
      throw new OpenRouterStreamError("OpenRouter SSE frame exceeded the gateway bound.", { kind: "frame_too_large" });
    }
  };
  const shift = (): ProviderStreamFrame | null => {
    for (;;) {
      const match = SSE_FRAME_BOUNDARY.exec(buffered.text);
      if (!match) return null;
      const raw = buffered.text.slice(0, match.index);
      buffered.text = buffered.text.slice(match.index + match[0].length);
      const frame = parseOpenRouterSseEventBlock(raw);
      if (frame) return frame;
    }
  };
  return { push, shift };
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

/** Owns one upstream SSE read loop: the reader lock, the watchdogs, and the frame queue. */
const createOpenRouterStreamSession = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: AbortController,
  options: Readonly<{ signal?: AbortSignal; firstEventTimeoutMs?: number; inactivityTimeoutMs?: number }>
): Readonly<{ next: () => Promise<ProviderStreamFrame | null>; finish: () => void }> => {
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const frames = createOpenRouterFrameReader();
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
      deadline.abort(new DOMException("OpenRouter Chat Completions stream stalled.", "TimeoutError"));
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
      const cancellation = reader.cancel("OpenRouter Chat Completions stream finished");
      releaseReaderLock();
      void cancellation.catch(() => {});
    } catch {
      releaseReaderLock();
    }
  };

  resetWatchdog();
  const next = async (): Promise<ProviderStreamFrame | null> => {
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

/**
 * Reads the upstream Chat Completions SSE body and yields validated frames.
 * A stream that ends before `[DONE]` is a premature EOF, exactly as the other
 * chat relays classify it, so a truncated reply never looks complete.
 */
export async function* iterateOpenRouterChatCompletionStream(
  response: Response,
  options: Readonly<{ signal?: AbortSignal; firstEventTimeoutMs?: number; inactivityTimeoutMs?: number }> = {}
): AsyncGenerator<ProviderStreamFrame, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new OpenRouterStreamError("OpenRouter returned no Chat Completions stream body.", { kind: "premature_eof" });

  const deadline = new AbortController();
  const session = createOpenRouterStreamSession(reader, deadline, options);
  try {
    for (;;) {
      const frame = await session.next();
      if (!frame) throw new OpenRouterStreamError("OpenRouter Chat Completions stream ended before [DONE].", { kind: "premature_eof" });
      yield frame;
      if (frame.kind === "done") return;
    }
  } catch (error) {
    if (error instanceof OpenRouterStreamError) throw error;
    if (deadline.signal.aborted) throw new OpenRouterStreamError("OpenRouter Chat Completions stream stalled.", { cause: error, kind: "inactivity_timeout" });
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw error;
    throw new OpenRouterStreamError("OpenRouter Chat Completions stream failed.", { cause: error, kind: "read_error" });
  } finally {
    session.finish();
  }
}

/** The OpenRouter seams for the shared Chat stream writer. */
const openRouterStreamAdapter: ProviderChatStreamAdapter = {
  responseHeaders: openRouterResponseHeaders,
  frames: (upstream, _upstreamModel, options) => iterateOpenRouterChatCompletionStream(upstream, options),
  recordResponseHealth: (status, providerRequestId) => {
    recordOpenRouterResponseHealth(status, providerRequestId);
  },
  recordProviderError: (status, providerRequestId) => void recordOpenRouterProviderHealth("upstream_error", status, Date.now, providerRequestId),
  recordCancellation: (context) => {
    if (context?.responseTelemetry) context.responseTelemetry.failureKind = "cancellation";
  },
  recordIncompleteResponse: (context) => {
    if (context?.responseTelemetry) context.responseTelemetry.failureKind = "incomplete_response";
  },
  recordFinishFailureKind: (context, finishReason) => {
    if (context?.responseTelemetry) context.responseTelemetry.failureKind = openRouterFinishReasonFailureKind(finishReason);
  },
  recordTransportFailure: (context, error, terminalType) => {
    if (!context?.responseTelemetry) return;
    context.responseTelemetry.failureKind = terminalType === "cancelled" ? "cancellation" : failureKindForStreamError(error);
  },
  terminalTypeForError: terminalTypeForStreamError,
  streamErrorCode: "openrouter_upstream_stream_error",
};

/** The gateway's standard `: keepalive` frames over any relayed SSE body. */
const withOpenRouterSseKeepalive = (response: Response): Response => {
  const body = response.body;
  if (!body) return response;
  return new Response(withSseKeepalive(body), { status: response.status, headers: response.headers });
};

/** Relays the served Chat Completions attempt through the shared provider stream writer. */
export const streamOpenRouterChatCompletion = (
  upstream: Response | Promise<Response>,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  downstreamSignal: AbortSignal,
  requestSignal: AbortSignal,
  upstreamModel: string
): Response =>
  withOpenRouterSseKeepalive(
    relayChatCompletionStream(openRouterStreamAdapter, upstream, providerRequestId, usageContext, downstreamSignal, requestSignal, upstreamModel)
  );

const OPENROUTER_SEMANTIC_RESPONSES_EVENT_TYPES = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.function_call_arguments.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
]);

const openRouterResponsesEventIsSemantic = (event: ResponsesStreamEvent): boolean =>
  OPENROUTER_SEMANTIC_RESPONSES_EVENT_TYPES.has(event.type) && typeof event.value.delta === "string" && event.value.delta.length > 0;

/**
 * Relays OpenRouter's native Responses event sequence through the shared
 * Responses proxy: every event is validated and forwarded as it arrives, a
 * terminal event settles usage and the terminal type, and a broken stream
 * surfaces the gateway's own error event instead of a silent truncation.
 */
export const streamOpenRouterResponses = (
  upstream: Response,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  downstreamSignal: AbortSignal,
  requestSignal: AbortSignal
): Response => {
  const body = upstream.body;
  if (!body) {
    recordStreamTerminalType(usageContext, "error");
    return openaiError(502, "OpenRouter returned no Responses stream body.", "openrouter_upstream_invalid_response");
  }
  const headers = new Headers(openRouterResponseHeaders(providerRequestId));
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  const stream = proxyResponsesStream(body, {
    signal: requestSignal,
    downstreamSignal,
    onEvent: (event) => {
      recordFirstUpstreamSseEvent(usageContext);
      recordResponsesTerminal(event, usageContext);
      if (event.terminal) {
        recordStreamTerminal(usageContext);
        if (event.type === "error" || event.type === "response.failed") {
          void recordOpenRouterProviderHealth("upstream_error", 200, Date.now, providerRequestId);
        } else if (event.type === "response.completed" || event.type === "response.incomplete") {
          recordOpenRouterResponseHealth(200, providerRequestId);
        }
        return;
      }
      if (openRouterResponsesEventIsSemantic(event)) {
        markChatSemanticOutput(usageContext);
        recordFirstSemanticCommitment(usageContext);
      }
    },
    onFailure: (error) => {
      const terminalType = terminalTypeForStreamError(error, downstreamSignal);
      recordStreamTerminalType(usageContext, terminalType);
      if (terminalType === "cancelled") return;
      if (usageContext?.responseTelemetry) usageContext.responseTelemetry.failureKind = failureKindForStreamError(error);
      void recordOpenRouterProviderHealth("upstream_error", null, Date.now, providerRequestId);
      void recordErrorUsage(usageContext);
    },
    onCancel: () => {
      recordStreamTerminalType(usageContext, "cancelled");
      if (usageContext?.responseTelemetry) usageContext.responseTelemetry.failureKind = "cancellation";
    },
  });
  return new Response(withSseKeepalive(stream), { status: 200, headers });
};
