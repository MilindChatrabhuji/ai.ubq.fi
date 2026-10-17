// Provider stream relay, extracted from src/openai.ts.

import { type DeepSeekStreamFrame } from "../deepseek/stream.ts";
import { type ChatOnlyResponsesProfile, type OriginalToolName } from "../deepseek/responses.ts";
import { type DeepSeekResponsesEcho } from "../deepseek/responses-payload.ts";
import { createDeepSeekResponsesStreamTranslator, encodeResponsesEvent } from "../deepseek/responses-stream.ts";
import {
  type ResponseStreamTerminalType,
  type UsageContext,
  type UsageTokens,
  extractChatUsageTokens,
  recordCompletionUsage,
  recordErrorUsage,
  recordFirstSemanticCommitment,
  recordFirstUpstreamSseEvent,
  recordStreamTerminal,
  recordStreamTerminalType,
  recordTerminalUsage,
} from "../openai-telemetry.ts";
import { EMPTY_UPSTREAM_COMPLETION_MESSAGE, markChatSemanticOutput } from "../chat/stream-translation.ts";
import { chatChunkHasAnswerBearingOutput, isAnswerBearingCompletion, isGatewayDeadlineResponse } from "../upstream-wire.ts";
import { getString, isRecord } from "../utils.ts";

export type ProviderStreamFrame = DeepSeekStreamFrame;

/**
 * The provider-specific seams the shared stream writers need, one adapter per
 * provider. Every other part of both route shapes - framing, teardown,
 * telemetry, semantic-output detection, failure classification order - is
 * written once.
 */
/** The adapter a chat-wire relay needs; the Responses translator profile is not part of it. */
export type ProviderChatStreamAdapter = Omit<ProviderStreamAdapter, "responsesProfile">;

export type ProviderStreamAdapter = Readonly<{
  /** This provider's response headers, including its provider-request-id echo. */
  responseHeaders: (providerRequestId: string | null) => Record<string, string>;
  /** This provider's upstream SSE frames, normalized to the shared union. */
  frames: (upstream: Response, upstreamModel: string, options: Readonly<{ signal: AbortSignal }>) => AsyncGenerator<ProviderStreamFrame, void, unknown>;
  /** Records the upstream response against this provider's health counters. */
  recordResponseHealth: (status: number, providerRequestId: string | null) => void;
  /** Records a provider fault against this provider's health counters. */
  recordProviderError: (status: number | null, providerRequestId: string | null) => void;
  /** Records the cancellation failure kind in this provider's vocabulary. */
  recordCancellation: (usageContext: UsageContext | undefined) => void;
  /** Records an incomplete upstream response in this provider's vocabulary. */
  recordIncompleteResponse: (usageContext: UsageContext | undefined) => void;
  /** Records the failure kind for an unmapped upstream finish reason. */
  recordFinishFailureKind: (usageContext: UsageContext | undefined, finishReason: string | null) => void;
  /** Records a transport error's failure kind in this provider's vocabulary. */
  recordTransportFailure: (usageContext: UsageContext | undefined, error: unknown, terminalType: ResponseStreamTerminalType) => void;
  /** Maps a transport error onto the shared terminal vocabulary. */
  terminalTypeForError: (error: unknown, downstreamSignal: AbortSignal) => ResponseStreamTerminalType;
  /** The code this provider stamps on its streamed Chat error payloads. */
  streamErrorCode: string;
  /** The provider profile the shared Responses translator runs under. */
  responsesProfile: ChatOnlyResponsesProfile;
}>;

/** The OpenAI-shaped SSE error body a relay emits when the upstream stream itself failed. */
const chatStreamErrorValue = (code: string, message = UPSTREAM_STREAM_REFUSAL_MESSAGE): Record<string, unknown> => ({
  error: {
    message,
    type: "server_error",
    code,
    param: null,
  },
});

/** The message an in-stream refusal uses when the provider's own body carries none. */
const UPSTREAM_STREAM_REFUSAL_MESSAGE = "Upstream Chat Completions stream failed.";

/** One provider refusal that arrived after its stream had already opened. */
type UpstreamStreamRefusal = Readonly<{ status: number; code: string | null; message: string | null }>;

/**
 * Lifts the provider's own refusal code and message out of the bounded failure
 * body the HTTP path already built, so an in-stream refusal reports the same
 * identity the buffered route would have returned for it. Shape-only, and it
 * never throws: an unreadable body keeps the relay's own code and message.
 */
const readUpstreamStreamRefusal = async (response: Response): Promise<UpstreamStreamRefusal> => {
  const fallback: UpstreamStreamRefusal = { status: response.status, code: null, message: null };
  try {
    const payload = (await response.json()) as unknown;
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    if (error === null) return fallback;
    return { status: response.status, code: getString(error.code), message: getString(error.message) };
  } catch {
    return fallback;
  }
};

/** Closing is best effort: the client may already have cancelled the stream. */
const closeController = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
  try {
    controller.close();
  } catch {
    // Already closed or errored by the consumer.
  }
};

/**
 * Relays one provider's Chat Completions SSE stream as it arrives. Chunk frames
 * are validated by the provider transport before they reach this writer, so the
 * client sees the same incremental tokens the provider produced rather than a
 * buffered replay.
 */
export const relayChatCompletionStream = (
  adapter: ProviderChatStreamAdapter,
  /**
   * The provider attempt that is ready now, or the promise a deferred wait
   * resolves with once the vendor's own window passes. A pending source is
   * awaited when the client first pulls; the caller's keepalive wrapper holds
   * the open stream while it is unresolved.
   */
  upstreamSource: Response | Promise<Response>,
  providerRequestId: string | null,
  usageContext: UsageContext | undefined,
  downstreamSignal: AbortSignal,
  requestSignal: AbortSignal,
  upstreamModel: string
): Response => {
  const encoder = new TextEncoder();
  const headers = new Headers(adapter.responseHeaders(providerRequestId));
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");

  // One stream-owned interrupt composed with the caller's request signal. The
  // external downstream signal is driven by Deno delivery completion, which
  // itself waits on this teardown, so a queued `iterator.return()` alone can
  // never interrupt a generator parked in an upstream read.
  const cancellation = new AbortController();
  const readSignal = AbortSignal.any([requestSignal, cancellation.signal]);
  const [initialUpstream, pendingUpstream] = upstreamSource instanceof Response ? ([upstreamSource, null] as const) : ([null, upstreamSource] as const);
  let upstream: Response | null = initialUpstream;
  let iterator: AsyncGenerator<ProviderStreamFrame, void, unknown> | null = null;
  let closed = false;
  let terminalSettled = false;
  let semantic = false;
  let usage: UsageTokens | null = null;

  const settleTerminal = (terminalType: ResponseStreamTerminalType): void => {
    if (terminalSettled) return;
    terminalSettled = true;
    recordStreamTerminalType(usageContext, terminalType);
  };
  const finishStream = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    if (closed) return;
    closed = true;
    await recordCompletionUsage(usageContext, usage);
    settleTerminal("response.completed");
    recordStreamTerminal(usageContext);
    adapter.recordResponseHealth(upstream?.status ?? 200, providerRequestId);
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    controller.close();
  };
  const failStream = async (controller: ReadableStreamDefaultController<Uint8Array>, error: unknown): Promise<void> => {
    if (closed) return;
    closed = true;
    const terminalType = adapter.terminalTypeForError(error, downstreamSignal);
    settleTerminal(terminalType);
    adapter.recordTransportFailure(usageContext, error, terminalType);
    if (usage) recordTerminalUsage(usageContext, usage, false);
    if (terminalType !== "cancelled") {
      adapter.recordProviderError(null, providerRequestId);
      await recordErrorUsage(usageContext);
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chatStreamErrorValue(adapter.streamErrorCode))}\n\n`));
    }
    controller.close();
  };

  /** Terminates the open stream with the provider's own refusal identity. */
  const refuseStream = async (controller: ReadableStreamDefaultController<Uint8Array>, refusal: Response): Promise<void> => {
    if (closed) return;
    closed = true;
    const detail = await readUpstreamStreamRefusal(refusal);
    // A wait the caller abandoned - a client cancellation, or the gateway's own
    // deadline - is not a provider refusal: it keeps its own terminal and emits
    // no error frame, exactly like a stream interrupted mid-read. An upstream
    // 504 is a refusal when the inference signal is still live. Explicit
    // provenance also covers a per-attempt gateway timeout while that signal
    // remains live, and prevents a late signal abort from hiding a provider 504.
    if (detail.status === 499 || isGatewayDeadlineResponse(refusal, requestSignal)) {
      settleTerminal(detail.status === 499 ? "cancelled" : "deadline");
      if (detail.status === 499) adapter.recordCancellation(usageContext);
      else adapter.recordTransportFailure(usageContext, new Error("The gateway deadline passed while waiting for the provider retry window."), "deadline");
      recordStreamTerminal(usageContext);
      closeController(controller);
      return;
    }
    settleTerminal("response.failed");
    adapter.recordResponseHealth(detail.status, providerRequestId);
    adapter.recordProviderError(detail.status, providerRequestId);
    await recordErrorUsage(usageContext);
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify(chatStreamErrorValue(detail.code ?? adapter.streamErrorCode, detail.message ?? UPSTREAM_STREAM_REFUSAL_MESSAGE))}\n\n`
      )
    );
    closeController(controller);
  };

  /** Whether the stream already closed; re-read after every await. */
  const streamClosed = (): boolean => closed;

  /** Resolves the provider attempt once (awaiting a pending source), or null when the stream ended. */
  const ensureIterator = async (
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<AsyncGenerator<ProviderStreamFrame, void, unknown> | null> => {
    if (iterator !== null) return iterator;
    if (streamClosed()) return null;
    const source = upstream ?? (pendingUpstream === null ? null : await pendingUpstream);
    // A pending source resolves asynchronously: the client may have cancelled
    // while it was awaited, so the state is re-read rather than remembered.
    if (source === null || streamClosed()) return null;
    upstream = source;
    if (!source.ok) {
      await refuseStream(controller, source);
      return null;
    }
    iterator = adapter.frames(source, upstreamModel, { signal: readSignal });
    return iterator;
  };

  // Pull-driven so the upstream stream is read only as fast as the client
  // consumes it; an eager writer would buffer an unbounded reply in memory.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const frames = await ensureIterator(controller);
        if (frames === null) return;
        const next = await frames.next();
        if (next.done) {
          await finishStream(controller);
          return;
        }
        const frame = next.value;
        if (frame.kind === "comment") {
          // DeepSeek's documented `: keep-alive` comment frame is what keeps a
          // long thinking turn from looking idle to an edge proxy, and SSE
          // comments are inert for clients, so it is relayed verbatim. A
          // transport that carries no comment frames never yields this branch.
          controller.enqueue(encoder.encode(`${frame.text}\n\n`));
          return;
        }
        if (frame.kind === "done") {
          iterator = null;
          await frames.return();
          await finishStream(controller);
          return;
        }
        recordFirstUpstreamSseEvent(usageContext);
        if (!semantic && chatChunkHasAnswerBearingOutput(frame.value)) {
          semantic = true;
          markChatSemanticOutput(usageContext);
          recordFirstSemanticCommitment(usageContext);
        }
        usage = extractChatUsageTokens(frame.value.usage) ?? usage;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame.value)}\n\n`));
      } catch (error) {
        await failStream(controller, error);
      }
    },
    cancel(reason) {
      if (closed) return;
      closed = true;
      settleTerminal("cancelled");
      adapter.recordCancellation(usageContext);
      // Usage observed before the disconnect is real evidence: record it with
      // completed=false so the terminal reports the counters without claiming a
      // completion. Missing usage stays unknown rather than invented.
      if (usage) recordTerminalUsage(usageContext, usage, false);
      // Abort the local read first: the pending upstream read then rejects, the
      // iterator's own `finally` cancels the physical provider body, and no
      // uninterruptible `return()` can block teardown. A consumer can cancel
      // before the first read, so an untouched source is cancelled directly.
      if (!cancellation.signal.aborted) cancellation.abort(reason);
      const upstreamBody = upstream?.body;
      if (upstreamBody && !upstreamBody.locked) void upstreamBody.cancel(reason).catch(() => {});
      // Cleanup is best effort and never surfaces as a provider error.
      if (iterator !== null) void iterator.return().catch(() => {});
    },
  });
  return new Response(body, { status: 200, headers });
};

/**
 * Relays one provider's translated Responses event sequence as it arrives. The
 * Chat chunks are validated by the provider transport before they reach the
 * translator, so the client sees incremental `response.*` events rather than a
 * buffered replay.
 */
export const relayResponsesStream = (
  adapter: ProviderStreamAdapter,
  options: Readonly<{
    /**
     * The provider attempt that is ready now, or the promise a deferred wait
     * resolves with once the vendor's own window passes. A pending source is
     * awaited when the client first pulls; the caller's keepalive wrapper holds
     * the open stream while it is unresolved.
     */
    upstream: Response | Promise<Response>;
    requestedModel: string;
    responseId: string;
    createdAtSeconds: number;
    echo: DeepSeekResponsesEcho;
    toolNames: ReadonlyMap<string, OriginalToolName>;
    customToolNames: ReadonlySet<string>;
    providerRequestId: string | null;
    usageContext: UsageContext | undefined;
    downstreamSignal: AbortSignal;
    requestSignal: AbortSignal;
    upstreamModel: string;
  }>
): Response => {
  const {
    upstream: upstreamSource,
    requestedModel,
    responseId,
    createdAtSeconds,
    echo,
    toolNames,
    customToolNames,
    providerRequestId,
    usageContext,
    downstreamSignal,
    requestSignal,
    upstreamModel,
  } = options;
  const encoder = new TextEncoder();
  const headers = new Headers(adapter.responseHeaders(providerRequestId));
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");

  // One stream-owned interrupt for the parked original read. The external
  // request signal alone is driven by Deno delivery completion, which itself
  // waits on this teardown, so a queued `iterator.return()` could never reach
  // the read.
  const cancellation = new AbortController();
  const readSignal = AbortSignal.any([requestSignal, cancellation.signal]);
  const [initialUpstream, pendingUpstream] = upstreamSource instanceof Response ? ([upstreamSource, null] as const) : ([null, upstreamSource] as const);
  let upstream: Response | null = initialUpstream;
  let iterator: AsyncGenerator<ProviderStreamFrame, void, unknown> | null = null;
  const translator = createDeepSeekResponsesStreamTranslator(
    requestedModel,
    responseId,
    echo,
    createdAtSeconds,
    toolNames,
    customToolNames,
    adapter.responsesProfile
  );
  const state = {
    settled: false,
    cancelled: false,
    semantic: false,
    usage: null as UsageTokens | null,
  };
  /** The next `sequence_number` this response's SSE stream will emit. */
  let sequenceNumber = 0;

  const settleTerminal = (terminalType: ResponseStreamTerminalType): void => {
    if (state.settled) return;
    state.settled = true;
    recordStreamTerminalType(usageContext, terminalType);
  };
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, events: readonly Record<string, unknown>[]): void => {
    for (const event of events) {
      // Official Responses events carry a monotonic per-response
      // `sequence_number`. The translator's own `output_index`/`content_index`
      // values are copied through untouched, so this is the only field the wire
      // gains and every event - including refusals, item and terminal events -
      // is stamped by this one encoder seam.
      controller.enqueue(encoder.encode(encodeResponsesEvent({ ...event, sequence_number: sequenceNumber })));
      sequenceNumber += 1;
    }
  };
  /**
   * The client-visible shape of the gateway's existing degenerate-completion
   * classification. Response headers were sent when the stream opened, so the
   * truth travels on the terminal event instead of as a 502 status; the
   * failure kind and message are the ones the ordinary routes already use.
   */
  const emptyCompletionFailure = (): Record<string, unknown> => ({
    type: "response.failed",
    response: {
      id: responseId,
      object: "response",
      status: "failed",
      error: { code: "empty_upstream_completion", message: EMPTY_UPSTREAM_COMPLETION_MESSAGE },
    },
  });
  /**
   * Emits the fail-closed terminal for a completion the provider reported as
   * successful but that carries nothing a client can act on. Returns true when
   * it handled the terminal.
   */
  const emitEmptyCompletionFailure = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    if (translator.terminalKind() !== "completed" || isAnswerBearingCompletion(translator.answerBearingOutput())) return false;
    if (usageContext?.responseTelemetry) {
      usageContext.responseTelemetry.failureKind = "empty_upstream_completion";
      usageContext.responseTelemetry.semanticOutputObserved = false;
    }
    recordTerminalUsage(usageContext, state.usage, false);
    settleTerminal("response.failed");
    recordStreamTerminal(usageContext);
    emit(controller, [...translator.open(), emptyCompletionFailure()]);
    adapter.recordResponseHealth(upstream?.status ?? 200, providerRequestId);
    return true;
  };

  const finishStream = async (controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> => {
    if (state.settled) return;
    try {
      // The provider's own stop reason decides the terminal (Goal B's Delta 1
      // vocabulary), and the provider-agnostic completion-validity predicate
      // (Goal A's G3) decides whether a would-be completion carries anything a
      // client can act on. An explicit non-completed signal wins over validity.
      if (emitEmptyCompletionFailure(controller)) return;
      const terminalKind = translator.terminalKind();
      emit(controller, translator.finish());
      if (terminalKind === "completed") {
        await recordCompletionUsage(usageContext, state.usage);
        settleTerminal("response.completed");
      } else {
        // A non-completed terminal is classified the same way on the streamed
        // and buffered paths, so telemetry reads the same on both.
        recordTerminalUsage(usageContext, state.usage, false);
        if (terminalKind === "incomplete") {
          adapter.recordIncompleteResponse(usageContext);
        } else {
          // The only remaining non-completed kind is "failed".
          adapter.recordFinishFailureKind(usageContext, translator.upstreamFinishReason());
          adapter.recordProviderError(upstream?.status ?? 200, providerRequestId);
        }
        settleTerminal(terminalKind === "incomplete" ? "response.incomplete" : "response.failed");
      }
      recordStreamTerminal(usageContext);
      adapter.recordResponseHealth(upstream?.status ?? 200, providerRequestId);
    } finally {
      closeController(controller);
    }
  };

  /** Terminates the open stream with the provider's own refusal identity. */
  const refuseStream = async (controller: ReadableStreamDefaultController<Uint8Array>, refusal: Response): Promise<void> => {
    if (state.settled) {
      closeController(controller);
      return;
    }
    const detail = await readUpstreamStreamRefusal(refusal);
    // The caller's own cancellation or deadline keeps its terminal and emits no
    // error frame; only a provider refusal travels as one. An upstream 504 is a
    // refusal when the inference signal is still live. Explicit provenance also
    // distinguishes an attempt deadline from a provider response.
    if (detail.status === 499 || isGatewayDeadlineResponse(refusal, requestSignal)) {
      settleTerminal(detail.status === 499 ? "cancelled" : "deadline");
      if (detail.status === 499) adapter.recordCancellation(usageContext);
      else adapter.recordTransportFailure(usageContext, new Error("The gateway deadline passed while waiting for the provider retry window."), "deadline");
      recordStreamTerminal(usageContext);
      closeController(controller);
      return;
    }
    settleTerminal("response.failed");
    adapter.recordResponseHealth(detail.status, providerRequestId);
    adapter.recordProviderError(detail.status, providerRequestId);
    await recordErrorUsage(usageContext);
    recordStreamTerminal(usageContext);
    emit(controller, [
      {
        type: "response.failed",
        response: {
          id: responseId,
          object: "response",
          status: "failed",
          error: { code: detail.code ?? adapter.streamErrorCode, message: detail.message ?? UPSTREAM_STREAM_REFUSAL_MESSAGE },
        },
      },
    ]);
    closeController(controller);
  };

  /** Whether the stream already settled or was cancelled; re-read after every await. */
  const streamEnded = (): boolean => state.settled || state.cancelled;

  /** Resolves the provider attempt once (awaiting a pending source), or null when the stream ended. */
  const ensureIterator = async (
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<AsyncGenerator<ProviderStreamFrame, void, unknown> | null> => {
    if (iterator !== null) return iterator;
    if (streamEnded()) return null;
    const source = upstream ?? (pendingUpstream === null ? null : await pendingUpstream);
    // A pending source resolves asynchronously: the client may have cancelled
    // while it was awaited, so the state is re-read rather than remembered.
    if (source === null || streamEnded()) return null;
    upstream = source;
    if (!source.ok) {
      await refuseStream(controller, source);
      return null;
    }
    iterator = adapter.frames(source, upstreamModel, { signal: readSignal });
    return iterator;
  };
  const failStream = async (controller: ReadableStreamDefaultController<Uint8Array>, error: unknown): Promise<void> => {
    if (state.settled) {
      closeController(controller);
      return;
    }
    const terminalType = adapter.terminalTypeForError(error, downstreamSignal);
    settleTerminal(terminalType);
    adapter.recordTransportFailure(usageContext, error, terminalType);
    if (state.usage) recordTerminalUsage(usageContext, state.usage, false);
    try {
      if (terminalType !== "cancelled") {
        adapter.recordProviderError(null, providerRequestId);
        await recordErrorUsage(usageContext);
        emit(controller, [
          {
            type: "response.failed",
            response: {
              id: responseId,
              object: "response",
              status: "failed",
              error: { code: adapter.streamErrorCode, message: "Upstream Chat Completions stream failed." },
            },
          },
        ]);
      }
    } finally {
      closeController(controller);
    }
  };

  /** Records the chunk's telemetry and returns the events it translates to. */
  const handleChunk = (chunk: Record<string, unknown>): Record<string, unknown>[] => {
    const chunkUsage = extractChatUsageTokens(chunk.usage);
    if (chunkUsage) state.usage = chunkUsage;
    if (!state.semantic && chatChunkHasAnswerBearingOutput(chunk)) {
      state.semantic = true;
      markChatSemanticOutput(usageContext);
      recordFirstSemanticCommitment(usageContext);
    }
    recordFirstUpstreamSseEvent(usageContext);
    return translator.push(chunk);
  };

  // Pull-driven so the upstream stream is read only as fast as the client
  // consumes it. A pull that enqueues nothing does not reliably schedule the
  // next pull, so this loop keeps reading until it has at least one event to
  // hand over or the upstream ends. Keep-alive comments and usage-only chunks
  // enqueue nothing by design, and returning early on either used to stall the
  // stream.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (state.settled) return;
      try {
        const frames = await ensureIterator(controller);
        if (frames === null) return;
        for (;;) {
          const next = await frames.next();
          if (next.done) {
            await finishStream(controller);
            return;
          }
          const frame = next.value;
          if (frame.kind === "done") {
            iterator = null;
            await frames.return();
            await finishStream(controller);
            return;
          }
          if (frame.kind === "comment") continue;
          const events = handleChunk(frame.value);
          if (!events.length) continue;
          emit(controller, events);
          return;
        }
      } catch (error) {
        await failStream(controller, error);
      }
    },
    cancel(reason) {
      if (state.cancelled) return;
      state.cancelled = true;
      settleTerminal("cancelled");
      adapter.recordCancellation(usageContext);
      // Usage observed before the disconnect is real evidence: record it with
      // completed=false so the terminal reports the counters without claiming a
      // completion. Missing usage stays unknown rather than invented.
      if (state.usage) recordTerminalUsage(usageContext, state.usage, false);
      // Abort the local read first: the pending upstream read then rejects, the
      // iterator's own `finally` cancels the physical provider body, and no
      // uninterruptible `return()` can block teardown. A consumer can cancel
      // before the first read, so an untouched source is cancelled directly.
      if (!cancellation.signal.aborted) cancellation.abort(reason);
      const upstreamBody = upstream?.body;
      if (upstreamBody && !upstreamBody.locked) void upstreamBody.cancel(reason).catch(() => {});
      // Cleanup is best effort and never surfaces as a provider error.
      if (iterator !== null) void iterator.return().catch(() => {});
    },
  });
  return new Response(body, { status: 200, headers });
};

/** The DeepSeek seams for the shared stream writers. */
