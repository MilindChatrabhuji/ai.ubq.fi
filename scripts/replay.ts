/**
 * Fixed local Sentinel replay consumer.
 *
 * This script is dispatched by trusted host code and executed exactly as:
 *
 *   bun --no-env-file run scripts/replay.ts
 *
 * It reads only the trusted dispatch metadata at the checkout root
 * (`.sentinel-replay-input.json`), the two exact relative fixture paths that
 * metadata names, and existing gateway source. It never scans permanent
 * fixtures, never picks the newest entry, never reads a host credential, never
 * replaces global fetch, and never performs network, KV or write operations.
 *
 * Supported coverage now spans the recorded provider paths this gateway
 * actually serves: the Responses providers (chatgpt_codex, surplus, metered)
 * with a Responses request body and an SSE 200 response, and DeepSeek on both
 * wires — a Chat Completions body replayed through the real DeepSeek
 * projection/transport and the real DeepSeek SSE parser and chunk normalizer,
 * plus the gateway's own answer-bearing completion rule. A recorded provider
 * HTTP error is replayed through the same real transport and its status
 * fidelity is asserted; the gateway's client-visible error mapping is not
 * exported, so that mapping is reported as not exercised rather than claimed.
 * Multi-attempt traces are replayed in recorded order through the same real
 * transports, with the recorded terminal of every attempt reproduced before
 * the final attempt is converted.
 *
 * Everything else is a fixed static unavailable result.
 *
 * Never report raw request, upstream, response or error fields. The only
 * stdout this script can produce is the trusted test markers, the fixed causal
 * failure line, the fixed unavailable line, or — when the trusted dispatch
 * metadata explicitly asks for it — one additive structured replay report line
 * whose fields are enumerated classifications and counts, never captured bytes.
 */

import { lstatSync, readFileSync, writeSync, type Stats } from "node:fs";
import { consumeDeepSeekBufferedChat, consumeDeepSeekChatStream } from "./replay-chat-stream.ts";
import { config } from "../src/config.ts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL, DeepSeekError, fetchDeepSeekChatCompletions } from "../src/deepseek/index.ts";
import { DeepSeekStreamError } from "../src/deepseek/stream.ts";
import { LITHOS_CHAT_COMPLETIONS_URL } from "../src/provider/lithos.ts";
import { fetchMeteredResponses, METERED_BASE_URL } from "../src/provider/metered.ts";
import { OPENROUTER_CHAT_COMPLETIONS_URL } from "../src/provider/openrouter.ts";
import { collectBufferedResponses } from "../src/responses-buffered.ts";

import { MAX_ACCEPTED_JSON_BODY_BYTES } from "../src/request.ts";
import { SENTINEL_REPLAY_REQUEST_FILE_MAX_BYTES, SENTINEL_REPLAY_UPSTREAM_FILE_MAX_BYTES } from "../src/sentinel/replay-limits.ts";
import {
  createOwnedResponsesStream,
  type PreparedResponsesStream,
  prepareResponsesStreamForCommit,
  responseEventFromValue,
  responseIdFromEvents,
  responsesEventSemanticKind,
} from "../src/responses-failover-stream.ts";
import {
  preflightResponsesStream,
  readResponsesStream,
  ResponsesStreamError,
  type ResponsesStreamEvent,
  type ResponsesStreamIterator,
} from "../src/responses-stream.ts";
import {
  parseSentinelUpstreamTrace,
  type SentinelUpstreamAttempt,
  type SentinelUpstreamProvider,
  type SentinelUpstreamTerminal,
  type SentinelUpstreamTrace,
} from "../src/sentinel/upstream-capture.ts";
import { fetchSurplusResponses, SURPLUS_BASE_URL } from "../src/provider/surplus.ts";
import { getString, isRecord } from "../src/utils.ts";
import { createRecordedUpstreamReplay, type RecordedUpstreamReplay } from "../tests/helpers/sentinel-recorded-upstream.ts";
const METADATA_FILE = ".sentinel-replay-input.json";
const METADATA_MAX_BYTES = 16 * 1024;
/**
 * Reader file bounds come from the same shared limit module the producer uses:
 * the upstream envelope allows the full derived metadata allowance (base64
 * chunks, timing, safe headers, framing); the request envelope allows the JSON
 * escaping worst case while the decoded body stays capped at 32 MiB.
 */
const UPSTREAM_FILE_MAX_BYTES = SENTINEL_REPLAY_UPSTREAM_FILE_MAX_BYTES;
const REQUEST_FILE_MAX_BYTES = SENTINEL_REPLAY_REQUEST_FILE_MAX_BYTES;
const MAX_TEST_IDS = 64;
const TEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const SYNTHETIC_PAID_API_KEY = "sentinel-replay-synthetic-key";
const SYNTHETIC_DEEPSEEK_API_KEY = "sentinel-replay-synthetic-deepseek-key";

const TEST_MARKER_PREFIX = "sentinel-replay-test:";
const REPORT_PREFIX = "sentinel-replay-report:";
const CAUSAL_FAILURE_LINE = "sentinel-causal-failure:stream terminated unexpectedly\n";
const UNAVAILABLE_LINE = "sentinel-replay-unavailable: replay input is unavailable\n";
/** Additive opt-in dispatch-metadata value; absent keeps the frozen output shape. */
const STRUCTURED_REPORT = "structured-v1";

/**
 * The fixed synthetic gateway failure texts. The owned stream and the buffered
 * converter surface the same real parser failure with different exact wording.
 */
const OWNED_UPSTREAM_ENDED_MESSAGE = "The upstream stream ended unexpectedly.";
const BUFFERED_UPSTREAM_ENDED_MESSAGE = "Upstream Responses stream ended unexpectedly.";
const UPSTREAM_ENDED_CODE = "server_error";

/**
 * Distinct fixed HTTPS route map. The recorded transport never performs
 * network I/O: it only matches the exact dispatch URL of the next recorded
 * attempt. Paid routes must equal the endpoints the exported paid fetch
 * functions request; the codex route mirrors the real gateway endpoint and the
 * unused cerebras and deepseek routes stay synthetic.
 */
const PROVIDER_ROUTES: Readonly<Record<SentinelUpstreamProvider, string>> = Object.freeze({
  chatgpt_codex: `${config.codexBaseUrl}/responses`,
  claude_code: "https://sentinel-replay.invalid/claude-code/v1/messages",
  surplus: `${SURPLUS_BASE_URL}/v1/responses`,
  metered: `${METERED_BASE_URL}/v1/responses`,
  cerebras: "https://sentinel-replay.invalid/cerebras/v1/chat/completions",
  // The real DeepSeek endpoint: the recorded transport only answers the exact
  // URL the exported gateway transport dispatches to.
  deepseek: DEEPSEEK_CHAT_COMPLETIONS_URL,
  // The real LithosAI endpoint, for the same reason. Replay coverage for this
  // provider is not claimed here: the route is registered so the recorded
  // transport's provider list matches the routes it is asked to validate.
  lithos: LITHOS_CHAT_COMPLETIONS_URL,
  // The supported OpenRouter Chat Completions endpoint, registered for the same
  // reason: the recorded transport validates the route set it may be asked for.
  openrouter: OPENROUTER_CHAT_COMPLETIONS_URL,
});

type SupportedProvider = "chatgpt_codex" | "surplus" | "metered" | "deepseek";
type SupportedTerminal = "eof" | "cancelled" | "read_error" | "fetch_error";
type ReplayOutcome = "completed" | "causal" | "unavailable";
/**
 * What a real converter surfaced. Matching the exact fixed failure output is
 * never a classification by itself: only observed parser evidence can turn it
 * into the causal result.
 */
type ConverterOutcome = "completed" | "premature_eof_output" | "unavailable";
/** Recorded attempts that can be reproduced exactly by the recorded transport. */
type PlannedAttempt = Readonly<{
  provider: SupportedProvider;
  terminal: SupportedTerminal;
  status: number | null;
  content_type: SentinelUpstreamAttempt["content_type"];
}>;
type ReplayPlan = Readonly<{
  attempts: readonly PlannedAttempt[];
  final: PlannedAttempt;
}>;

type DispatchInput = Readonly<{
  requestPath: string;
  upstreamPath: string;
  testIds: readonly string[];
  /** Additive opt-in; absent preserves the frozen single-line output shape. */
  report: boolean;
}>;

type RequestWire = "responses" | "chat.completions";

type RequestEnvelope = Readonly<{
  wire: RequestWire;
  bodyText: string;
  body: Record<string, unknown>;
  model: string;
}>;

class UnavailableInput extends Error {
  constructor() {
    super("Sentinel replay input is unavailable");
    this.name = "UnavailableInput";
  }
}

export const unavailable: () => never = () => {
  throw new UnavailableInput();
};

const encoder = new TextEncoder();

export const isPlainRecord = (value: unknown): value is Record<string, unknown> => isRecord(value) && !Array.isArray(value);

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return unavailable();
  }
};

const relativeSegments = (value: string): readonly string[] => {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) unavailable();
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) unavailable();
  return segments;
};

const absoluteUnder = (cwd: string, segments: readonly string[]): string => {
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return `${base}/${segments.join("/")}`;
};

/** Every ancestor and the final entry must be a regular non-symlink entry inside cwd. */
const requireRegularFile = (cwd: string, segments: readonly string[]): string => {
  for (let index = 0; index < segments.length - 1; index += 1) {
    const ancestor = absoluteUnder(cwd, segments.slice(0, index + 1));
    let info: Stats;
    try {
      info = lstatSync(ancestor);
    } catch {
      return unavailable();
    }
    if (!info.isDirectory() || info.isSymbolicLink()) unavailable();
  }
  const absolute = absoluteUnder(cwd, segments);
  let info: Stats;
  try {
    info = lstatSync(absolute);
  } catch {
    return unavailable();
  }
  if (!info.isFile() || info.isSymbolicLink()) unavailable();
  return absolute;
};

const readBoundedFile = (absolute: string, maxBytes: number): Uint8Array => {
  let info: Stats;
  try {
    info = lstatSync(absolute);
  } catch {
    return unavailable();
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) unavailable();
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(absolute);
  } catch {
    return unavailable();
  }
  if (bytes.byteLength > maxBytes) unavailable();
  return bytes;
};

/** Trusted dispatch metadata: exact shape, 16 KiB bound, fatal UTF-8, ordered valid IDs. */
const readDispatchInput = (cwd: string): DispatchInput => {
  const bytes = readBoundedFile(requireRegularFile(cwd, [METADATA_FILE]), METADATA_MAX_BYTES);
  const parsed = parseJson(decodeUtf8(bytes));
  if (!isPlainRecord(parsed)) unavailable();
  const requiredKeys = ["version", "requestPath", "upstreamPath", "testIds"];
  const keys = Object.keys(parsed);
  const reportRequested = parsed.report === STRUCTURED_REPORT;
  if (keys.some((key) => !requiredKeys.includes(key) && key !== "report")) unavailable();
  if (keys.length !== requiredKeys.length + (reportRequested ? 1 : 0)) unavailable();
  if (parsed.report !== undefined && !reportRequested) unavailable();
  if (parsed.version !== "v1") unavailable();
  const requestPath = parsed.requestPath;
  const upstreamPath = parsed.upstreamPath;
  if (typeof requestPath !== "string" || typeof upstreamPath !== "string") unavailable();
  if (requestPath === upstreamPath) unavailable();
  if (!Array.isArray(parsed.testIds)) unavailable();
  if (parsed.testIds.length < 1 || parsed.testIds.length > MAX_TEST_IDS) unavailable();
  const testIds: string[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed.testIds) {
    if (typeof candidate !== "string" || !TEST_ID_PATTERN.test(candidate) || seen.has(candidate)) unavailable();
    seen.add(candidate);
    testIds.push(candidate);
  }
  return { requestPath, upstreamPath, testIds, report: reportRequested };
};

/**
 * Existing request envelope: `{ body: string, ...sanitized envelope }` with a
 * Responses-shaped or Chat Completions-shaped body. The wire is decided by the
 * body itself, never by a provider guess.
 */
const readRequestEnvelope = (cwd: string, requestPath: string): RequestEnvelope => {
  const bytes = readBoundedFile(requireRegularFile(cwd, relativeSegments(requestPath)), REQUEST_FILE_MAX_BYTES);
  const parsed = parseJson(decodeUtf8(bytes));
  if (!isPlainRecord(parsed) || typeof parsed.body !== "string") unavailable();
  const bodyText = parsed.body;
  if (encoder.encode(bodyText).byteLength > MAX_ACCEPTED_JSON_BODY_BYTES) unavailable();
  const body = parseJson(bodyText);
  if (!isPlainRecord(body)) unavailable();
  const model = body.model;
  const stream = body.stream;
  if (stream !== undefined && typeof stream !== "boolean") unavailable();
  if (Array.isArray(body.messages)) {
    // A Chat Completions replay needs a real model id: the recorded request's
    // own projection decides the upstream model, and an unconfigured id is a
    // gateway rejection this consumer cannot reproduce.
    if (typeof model !== "string" || model.trim() !== model || model === "") unavailable();
    return { wire: "chat.completions", bodyText, body, model };
  }
  // A Responses body requires `input`.
  const input = body.input;
  if (typeof input !== "string" && !Array.isArray(input)) unavailable();
  return { wire: "responses", bodyText, body, model: typeof model === "string" ? model : "" };
};

/** Existing recorded upstream trace with truncation flags and the parser's own bounds enforced. */
const readUpstreamTrace = (cwd: string, upstreamPath: string): SentinelUpstreamTrace => {
  const bytes = readBoundedFile(requireRegularFile(cwd, relativeSegments(upstreamPath)), UPSTREAM_FILE_MAX_BYTES);
  const parsed = parseJson(decodeUtf8(bytes));
  try {
    return parseSentinelUpstreamTrace(parsed);
  } catch {
    return unavailable();
  }
};

/** Provider transports this consumer replays through their real exported fetch. */
const isSupportedProvider = (provider: SentinelUpstreamProvider): provider is SupportedProvider =>
  provider === "chatgpt_codex" || provider === "surplus" || provider === "metered" || provider === "deepseek";

/** Recorded terminals the recorded transport can reproduce exactly. */
const isSupportedTerminal = (terminal: SentinelUpstreamTerminal): terminal is SupportedTerminal =>
  terminal === "eof" || terminal === "cancelled" || terminal === "read_error" || terminal === "fetch_error";

/** A success attempt must carry a body shape the real consumer for that provider and wire can read. */
const isReplayableSuccessShape = (provider: SupportedProvider, contentType: SentinelUpstreamAttempt["content_type"]): boolean =>
  provider === "deepseek" ? contentType === "application/json" || contentType === "text/event-stream" : contentType === "text/event-stream";

/** Validate one recorded attempt and project it; null is the fixed unavailable verdict. */
const replayableAttempt = (attempt: SentinelUpstreamAttempt): PlannedAttempt | null => {
  if (!isSupportedProvider(attempt.provider) || !isSupportedTerminal(attempt.terminal)) return null;
  if (attempt.terminal === "fetch_error" ? attempt.status !== null : attempt.status === null) return null;
  if (attempt.status !== null && attempt.status < 400 && !isReplayableSuccessShape(attempt.provider, attempt.content_type)) return null;
  return { provider: attempt.provider, terminal: attempt.terminal, status: attempt.status, content_type: attempt.content_type };
};

const requireReplayableAttempt = (attempt: SentinelUpstreamAttempt): PlannedAttempt => {
  const planned = replayableAttempt(attempt);
  if (planned === null) unavailable();
  return planned;
};

/** Truncation flags are never partial evidence: they make the whole chain unavailable. */
const traceIsTruncated = (trace: SentinelUpstreamTrace): boolean => trace.attempts_truncated || trace.bytes_truncated || trace.chunks_truncated;

/** An intermediate success could not have been followed by another dispatch. */
const assertNoIntermediateSuccess = (attempts: readonly PlannedAttempt[]): void => {
  for (const attempt of attempts.slice(0, -1)) {
    if (attempt.status !== null && attempt.status < 400) unavailable();
  }
};

/**
 * Plan the recorded attempt chain. Every attempt must be exactly reproducible
 * by the recorded transport, and only the last attempt may be a success: a
 * gateway retry chain is only a chain because the earlier dispatches failed.
 */
const planAttempts = (trace: SentinelUpstreamTrace): ReplayPlan => {
  if (traceIsTruncated(trace)) unavailable();
  if (trace.attempts.length < 1) unavailable();
  const attempts = trace.attempts.map(requireReplayableAttempt);
  assertNoIntermediateSuccess(attempts);
  const final = attempts.at(-1);
  if (final === undefined) unavailable();
  return { attempts, final };
};

/** Every recorded attempt of the chain, in order, with its terminal reproduced. */
const dispatchAttempt = async (
  attempt: PlannedAttempt,
  request: RequestEnvelope,
  replay: RecordedUpstreamReplay
): Promise<Readonly<{ response: Response | null; transport: "response" | "classified_failure" | "unclassified_failure" }>> => {
  try {
    const response = await openRecordedResponse(attempt.provider, request, replay);
    if (response.status !== attempt.status) unavailable();
    return { response, transport: "response" };
  } catch (error) {
    // A recorded transport failure is reproduced as a thrown provider error.
    // The gateway's own typed classification is recorded, and an untyped
    // failure stays explicitly untyped instead of being reported as a
    // provider-specific cause.
    if (attempt.terminal === "fetch_error" || attempt.status === null) {
      const classified = error instanceof DeepSeekError || error instanceof DeepSeekStreamError;
      return { response: null, transport: classified ? "classified_failure" : "unclassified_failure" };
    }
    return unavailable();
  }
};

/**
 * Dispatch the recorded attempt. Codex raw recorded bytes feed the recorded
 * transport directly (no provider dispatch, no auth or routing simulation).
 * Paid attempts go through the exported provider fetch functions with the
 * recorded fetcher and an explicit synthetic key, preserving their real
 * normalization. No host key is ever read.
 */
const openRecordedResponse = async (provider: SupportedProvider, request: RequestEnvelope, replay: RecordedUpstreamReplay): Promise<Response> => {
  if (provider === "deepseek") {
    // The real DeepSeek projection and transport: only the fetcher, the
    // synthetic key and the recorded model differ from production.
    return await fetchDeepSeekChatCompletions(request.body, request.model, {
      apiKey: SYNTHETIC_DEEPSEEK_API_KEY,
      fetcher: replay.fetch,
    });
  }
  if (provider === "chatgpt_codex") {
    return await replay.fetch(PROVIDER_ROUTES.chatgpt_codex, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request.bodyText,
    });
  }
  if (provider === "surplus") {
    return (
      await fetchSurplusResponses(request.body, {
        apiKey: SYNTHETIC_PAID_API_KEY,
        fetcher: replay.fetch,
      })
    ).response;
  }
  return (
    await fetchMeteredResponses(request.body, {
      apiKey: SYNTHETIC_PAID_API_KEY,
      fetcher: replay.fetch,
    })
  ).response;
};

/**
 * Structured evidence recorded from the real parser while the real converter
 * consumes the prepared iterator. The buffered converter maps every iterator
 * failure, including malformed events and changed response identities, to the
 * same fixed 502 body, so that failure text alone never proves causality.
 * Recording this observation never replaces or reimplements conversion.
 */
type ParserEvidence = {
  /** The parser itself threw its recognized premature_eof kind. */
  prematureEof: boolean;
  /** The parser itself threw its recognized read_error kind. */
  readError: boolean;
  /** The parser threw a different failure (malformed event, ...). */
  otherFailure: boolean;
  /** The iterator was fully consumed and returned done without a terminal. */
  exhaustedWithoutTerminal: boolean;
  /** Upstream-declared terminal event type the parser observed, if any. */
  upstreamTerminalType: string | null;
};

const emptyParserEvidence = (): ParserEvidence => ({
  prematureEof: false,
  readError: false,
  otherFailure: false,
  exhaustedWithoutTerminal: false,
  upstreamTerminalType: null,
});

/** Record the parser's own recognized failure kind before it is rethrown unchanged. */
const noteParserFailure = (error: unknown, evidence: ParserEvidence): void => {
  if (error instanceof ResponsesStreamError && error.kind === "premature_eof") evidence.prematureEof = true;
  else if (error instanceof ResponsesStreamError && error.kind === "read_error") evidence.readError = true;
  else evidence.otherFailure = true;
};

/**
 * Transparent observation of the real prepared iterator: identical events in
 * the identical order, the identical terminal `done` result, the identical
 * error object rethrown to the converter, and the identical iterator cleanup.
 * The only added effect is the structured parser evidence above.
 */
const observeParserIterator = (iterator: ResponsesStreamIterator, evidence: ParserEvidence): ResponsesStreamIterator =>
  (async function* (): AsyncGenerator<ResponsesStreamEvent, unknown, unknown> {
    try {
      for (;;) {
        let next: IteratorResult<ResponsesStreamEvent, unknown>;
        try {
          next = await iterator.next();
        } catch (error) {
          noteParserFailure(error, evidence);
          throw error;
        }
        // `done` is a discriminant, but what the iterator produced stays unknown:
        // a falsy value is exhaustion, not an event to hand to the converter.
        const { value } = next;
        if (next.done || !value) {
          if (evidence.upstreamTerminalType === null) evidence.exhaustedWithoutTerminal = true;
          return value;
        }
        if (next.value.terminal) evidence.upstreamTerminalType ??= next.value.type;
        yield next.value;
      }
    } finally {
      await iterator.return("Sentinel replay parser observation closed").catch(() => {});
    }
  })();

/** The owned stream's fixed failure event for a parser failure, matched exactly. */
const isSyntheticPrematureEofEvent = (event: ResponsesStreamEvent): boolean => {
  if (event.type === "response.failed") {
    const response = event.value.response;
    if (!isPlainRecord(response) || response.status !== "failed") return false;
    const error = response.error;
    if (!isPlainRecord(error)) return false;
    return error.code === UPSTREAM_ENDED_CODE && error.message === OWNED_UPSTREAM_ENDED_MESSAGE;
  }
  if (event.type === "error") {
    return event.value.code === UPSTREAM_ENDED_CODE && event.value.message === OWNED_UPSTREAM_ENDED_MESSAGE;
  }
  return false;
};

/** The buffered converter's fixed 502 body for a parser failure, matched exactly. */
const isBufferedPrematureEofResponse = (status: number, parsed: unknown): boolean => {
  if (status !== 502 || !isPlainRecord(parsed)) return false;
  const error = parsed.error;
  if (!isPlainRecord(error)) return false;
  return error.code === UPSTREAM_ENDED_CODE && error.message === BUFFERED_UPSTREAM_ENDED_MESSAGE;
};

/** Semantic content the gateway's own utility accepts on a completed response. */
const hasSemanticCompletion = (event: ResponsesStreamEvent): boolean => responsesEventSemanticKind(event) !== null;

/**
 * The gateway's own empty-semantic-completion guard
 * (`prepareResponsesAttempt`): a committed `response.completed` terminal with
 * no semantic event is never a successful completion, however nonempty its
 * output array looks.
 */
const isEmptySemanticCompletion = (prepared: PreparedResponsesStream): boolean =>
  prepared.terminal?.type === "response.completed" && prepared.semantic === null;

/**
 * The actual converted Response object must carry completed status, the
 * Responses object shape and the observed response identity. Malformed output
 * the real converter did not repair must not become a claimed success.
 */
const isCompletedResponseObject = (value: Record<string, unknown>, observedResponseId: string | null): boolean => {
  if (value.status !== "completed" && value.status !== "succeeded") return false;
  if (value.object !== "response") return false;
  const id = getString(value.id)?.trim();
  if (!id) return false;
  return observedResponseId === null || id === observedResponseId;
};

/**
 * stream=true: the owned stream must produce a validated terminal. Its fixed
 * failure event is only recorded as an observed converter output, never as a
 * classification.
 */
const consumeOwnedResponses = async (prepared: PreparedResponsesStream): Promise<ConverterOutcome> => {
  const observedResponseId = responseIdFromEvents(prepared.buffered);
  const owned = createOwnedResponsesStream({
    initial: prepared.buffered,
    iterator: prepared.iterator,
    responseId: observedResponseId,
  });
  let terminalEvent: ResponsesStreamEvent | null = null;
  for await (const event of readResponsesStream(owned)) {
    if (event.terminal) terminalEvent = event;
  }
  if (terminalEvent === null) unavailable();
  if (terminalEvent.type === "response.completed") {
    // The terminal is the real owned stream's own output: validate the actual
    // completed Response it carries, not just its event type.
    const response = terminalEvent.value.response;
    if (!isPlainRecord(response)) unavailable();
    if (!isCompletedResponseObject(response, observedResponseId)) unavailable();
    if (!hasSemanticCompletion(terminalEvent)) unavailable();
    return "completed";
  }
  if (isSyntheticPrematureEofEvent(terminalEvent)) return "premature_eof_output";
  return unavailable();
};

/**
 * stream=false: the exported buffered converter must return a completed
 * response or its exact fixed failure body. That body is only recorded as an
 * observed converter output, never as a classification.
 */
const consumeBufferedResponses = async (prepared: PreparedResponsesStream, provider: SupportedProvider): Promise<ConverterOutcome> => {
  const observedResponseId = responseIdFromEvents(prepared.buffered);
  const response = await collectBufferedResponses({ provider, responseId: observedResponseId, prepared });
  const parsed = parseJson(await response.text());
  if (response.ok) {
    if (!isPlainRecord(parsed) || !isCompletedResponseObject(parsed, observedResponseId)) unavailable();
    // The actual buffered Response object is what the converter returned: the
    // gateway's own utility decides whether it carries useful semantic content
    // instead of trusting a nonempty output array.
    const completed = responseEventFromValue({ type: "response.completed", response: parsed });
    if (!hasSemanticCompletion(completed)) unavailable();
    return "completed";
  }
  if (isBufferedPrematureEofResponse(response.status, parsed)) return "premature_eof_output";
  return unavailable();
};

/**
 * Causal only when the recorded body ended (eof), the real parser recorded an
 * actual end-of-stream signal, no upstream terminal or other failure was
 * declared, and the converter produced its exact fixed failure output.
 */
const classifyConverterFailure = (terminal: SupportedTerminal, evidence: ParserEvidence): ReplayOutcome => {
  // A client-cancelled or fetch-failed attempt is not a gateway outcome this
  // consumer attests. An EOF or a recorded upstream read failure is, when the
  // real parser observed exactly that condition, declared no upstream
  // terminal, and the real converter produced its fixed failure output.
  if (terminal !== "eof" && terminal !== "read_error") return "unavailable";
  if (evidence.upstreamTerminalType !== null) return "unavailable";
  if (evidence.otherFailure) return "unavailable";
  if (terminal === "read_error") return evidence.readError ? "causal" : "unavailable";
  if (evidence.prematureEof || evidence.exhaustedWithoutTerminal) return "causal";
  return "unavailable";
};

/** Frozen real response sequence: replayed body -> preflight -> first event plus iterator -> prepare -> observed converter. */
const runReplaySequence = async (
  provider: SupportedProvider,
  terminal: SupportedTerminal,
  response: Response,
  body: Record<string, unknown>
): Promise<ReplayOutcome> => {
  let prepared: PreparedResponsesStream;
  try {
    // The owned response always carries a body (see openRecordedResponse); this
    // keeps the precommit classification of that impossible case unchanged.
    if (!response.body) unavailable();
    const preflight = await preflightResponsesStream(response.body);
    const replayed = (async function* (): AsyncGenerator<ResponsesStreamEvent> {
      try {
        yield preflight.first;
        for await (const event of preflight.iterator) yield event;
        return undefined;
      } finally {
        await preflight.iterator.return("Sentinel replay preflight closed").catch(() => {});
      }
    })();
    prepared = await prepareResponsesStreamForCommit(replayed);
  } catch (error) {
    // Precommit evidence only: the real parser (or the precommit stage
    // consuming it) ended the recorded body before a terminal and before any
    // semantic output. A recorded eof plus its recognized premature_eof kind
    // is the causal failure; every other precommit failure is unavailable.
    if (!(error instanceof ResponsesStreamError)) return "unavailable";
    if (terminal === "eof" && error.kind === "premature_eof") return "causal";
    if (terminal === "read_error" && error.kind === "read_error") return "causal";
    return "unavailable";
  }
  const evidence = emptyParserEvidence();
  // Mirror the gateway's own empty-semantic-completion guard
  // (prepareResponsesAttempt): a `response.completed` terminal committed
  // without a semantic event is rejected before any conversion.
  if (isEmptySemanticCompletion(prepared)) unavailable();
  // A terminal buffered before semantic output is upstream-declared evidence,
  // never the parser's premature EOF.
  if (prepared.terminal) evidence.upstreamTerminalType ??= prepared.terminal.type;
  const observed: PreparedResponsesStream = {
    ...prepared,
    iterator: observeParserIterator(prepared.iterator, evidence),
  };
  const outcome = body.stream === true ? await consumeOwnedResponses(observed) : await consumeBufferedResponses(observed, provider);
  return outcome === "premature_eof_output" ? classifyConverterFailure(terminal, evidence) : outcome;
};

/** Accumulates the answer-bearing view of the real normalized DeepSeek chunks. */

const runAttempt = async (
  provider: SupportedProvider,
  terminal: SupportedTerminal,
  response: Response,
  body: Record<string, unknown>
): Promise<ReplayOutcome> => {
  try {
    return await runReplaySequence(provider, terminal, response, body);
  } catch {
    // Any failure outside the classified replay sequence is unavailable.
    return unavailable();
  }
};

/** What a replayed provider attempt produced, without any raw payload. */
type AttemptObservation = Readonly<{
  transport: "response" | "classified_failure" | "unclassified_failure";
  status: number | null;
  /** Only set for a successful 200 conversion. */
  converted: "completed" | "causal" | "unavailable" | null;
  /** Fixed classification of the replayed outcome. */
  classification:
    | "converted_completed"
    | "converted_causal"
    | "invalid_completion"
    | "empty_completion"
    | "recorded_premature_eof"
    | "recorded_read_error"
    | "recorded_malformed_stream"
    | "provider_http_error_replayed"
    | "transport_failure_classified"
    | "transport_failure_unclassified"
    | "unsupported";
}>;

/** Replay the final streamed chat.completions attempt through the real DeepSeek consumer. */
const replayFinalChatStreamAttempt = async (
  attempt: PlannedAttempt,
  request: RequestEnvelope,
  response: Response,
  transport: AttemptObservation["transport"]
): Promise<AttemptObservation> => {
  const status = attempt.status;
  const evidence = await consumeDeepSeekChatStream(response, request.model);
  if (evidence.terminalKind === "completed" && evidence.doneFrames > 0 && evidence.answerBearing) {
    return { transport, status, converted: "completed", classification: "converted_completed" };
  }
  if (evidence.terminalKind === "premature_eof") {
    return { transport, status, converted: "causal", classification: "recorded_premature_eof" };
  }
  if (evidence.terminalKind === "read_error") {
    return { transport, status, converted: "causal", classification: "recorded_read_error" };
  }
  if (evidence.malformed) return { transport, status, converted: null, classification: "recorded_malformed_stream" };
  if (evidence.terminalKind === "completed" && evidence.doneFrames > 0) {
    return { transport, status, converted: null, classification: "empty_completion" };
  }
  return { transport, status, converted: null, classification: "unsupported" };
};

/** Replay the final chat.completions attempt, streamed or buffered. */
const replayFinalChatAttempt = async (
  attempt: PlannedAttempt,
  request: RequestEnvelope,
  response: Response,
  transport: AttemptObservation["transport"]
): Promise<AttemptObservation> => {
  if (attempt.provider !== "deepseek") unavailable();
  if (request.body.stream === true) return await replayFinalChatStreamAttempt(attempt, request, response, transport);
  const buffered = await consumeDeepSeekBufferedChat(response, request.model);
  if (buffered === "completed") return { transport, status: attempt.status, converted: "completed", classification: "converted_completed" };
  if (buffered === "empty_completion") return { transport, status: attempt.status, converted: null, classification: "empty_completion" };
  return { transport, status: attempt.status, converted: null, classification: "invalid_completion" };
};

/** Replay the final planned attempt through the real consumer for its wire. */
const replayFinalAttempt = async (
  attempt: PlannedAttempt,
  request: RequestEnvelope,
  response: Response | null,
  transport: AttemptObservation["transport"]
): Promise<AttemptObservation> => {
  if (response === null) {
    return {
      transport,
      status: null,
      converted: null,
      classification: transport === "classified_failure" ? "transport_failure_classified" : "transport_failure_unclassified",
    };
  }
  if (attempt.status === null || attempt.status >= 400) {
    // The recorded provider HTTP error reached the transport with its exact
    // status. The gateway's client-visible error mapping is not exported, so
    // the mapping is reported as not exercised rather than claimed.
    return { transport, status: attempt.status, converted: null, classification: "provider_http_error_replayed" };
  }
  if (request.wire === "chat.completions") return await replayFinalChatAttempt(attempt, request, response, transport);
  const converted = await runAttempt(attempt.provider, attempt.terminal, response, request.body);
  if (converted === "completed") return { transport, status: attempt.status, converted: "completed", classification: "converted_completed" };
  if (converted === "causal") return { transport, status: attempt.status, converted: "causal", classification: "converted_causal" };
  return { transport, status: attempt.status, converted: null, classification: "unsupported" };
};

/** The structured local replay report: enumerated classifications and counts only. */
type ReplayReport = Readonly<{
  version: 1;
  provider: string;
  request_wire: RequestWire | "unavailable";
  attempts: number;
  attempt_statuses: readonly (number | null)[];
  attempt_terminals: readonly string[];
  transport: AttemptObservation["transport"];
  classification: AttemptObservation["classification"];
  outcome: ReplayOutcome;
  replay_coverage: "full" | "partial" | "unavailable";
  retry_policy: "not_replayed";
  provider_error_mapping: "not_exercised" | "not_applicable";
  unavailable_reason: string | null;
}>;

type ReplayResult = Readonly<{
  outcome: ReplayOutcome;
  report: ReplayReport;
}>;

const runReplay = async (input: DispatchInput): Promise<ReplayResult> => {
  const cwd = process.cwd();
  const request = readRequestEnvelope(cwd, input.requestPath);
  const trace = readUpstreamTrace(cwd, input.upstreamPath);
  const plan = planAttempts(trace);
  let replay: RecordedUpstreamReplay;
  try {
    replay = createRecordedUpstreamReplay(trace, PROVIDER_ROUTES);
  } catch {
    return { outcome: "unavailable", report: unavailableReport(plan, request.wire, "recorded_transport_unavailable") };
  }
  // Every recorded attempt is dispatched in order through the real transport
  // for its provider. An earlier attempt that cannot be reproduced exactly
  // makes the whole chain unavailable rather than a partial claim.
  for (const attempt of plan.attempts.slice(0, -1)) {
    // The planner already proved every intermediate attempt is a recorded
    // failure (a transport failure or an HTTP status at or above 400), so a
    // reproduced intermediate response is the expected evidence, not a
    // contradiction. Its recorded body is read to its end so the chain's
    // consumed-prefix accounting covers every attempt.
    const dispatched = await dispatchAttempt(attempt, request, replay);
    if (dispatched.response?.body) await dispatched.response.arrayBuffer().catch(() => {});
  }
  const dispatchedFinal = await dispatchAttempt(plan.final, request, replay);
  const observation = await replayFinalAttempt(plan.final, request, dispatchedFinal.response, dispatchedFinal.transport);
  const outcome: ReplayOutcome = observation.converted ?? "unavailable";
  if (outcome === "unavailable") {
    return { outcome, report: reportFor(plan, request, observation, outcome, unavailableReasonFor(observation)) };
  }
  // Every recorded attempt must have been dispatched exactly once through its
  // real transport, no over-read or invented EOF may have occurred, and a
  // converted claim may only rest on a fully consumed recorded prefix.
  const snapshot = replay.snapshot();
  // The only non-conversion outcome ("unavailable") already returned above, so
  // every remaining outcome is a conversion claim that must rest on a fully
  // consumed recorded prefix.
  if (snapshot.failed || snapshot.attemptsDispatched !== plan.attempts.length || snapshot.chunksConsumed !== snapshot.chunksTotal) {
    return { outcome: "unavailable", report: reportFor(plan, request, observation, "unavailable", "recorded_transport_incomplete") };
  }
  return { outcome, report: reportFor(plan, request, observation, outcome, null) };
};

const unavailableReport = (plan: ReplayPlan, wire: RequestWire, reason: string): ReplayReport => ({
  version: 1,
  provider: plan.final.provider,
  request_wire: wire,
  attempts: plan.attempts.length,
  attempt_statuses: plan.attempts.map((attempt) => attempt.status),
  attempt_terminals: plan.attempts.map((attempt) => attempt.terminal),
  transport: "response",
  classification: "unsupported",
  outcome: "unavailable",
  replay_coverage: "unavailable",
  retry_policy: "not_replayed",
  provider_error_mapping: "not_applicable",
  unavailable_reason: reason,
});

const unavailableReasonFor = (observation: AttemptObservation): string => {
  switch (observation.classification) {
    case "provider_http_error_replayed":
      return "gateway_error_mapping_not_exported";
    case "empty_completion":
      return "gateway_empty_completion_rule_not_exported";
    case "invalid_completion":
      return "recorded_completion_rejected_by_gateway_normalizer";
    case "recorded_malformed_stream":
      return "recorded_stream_was_malformed";
    case "transport_failure_unclassified":
      return "transport_failure_not_classified";
    default:
      return "recorded_attempt_not_replayable";
  }
};

/**
 * Only a single complete attempt that the real consumer converted without a
 * recorded omission is full coverage; anything else is explicitly partial.
 */
const replayCoverageFor = (plan: ReplayPlan, outcome: ReplayOutcome): ReplayReport["replay_coverage"] => {
  if (outcome === "unavailable") return "unavailable";
  return plan.attempts.length === 1 && attemptIsComplete(plan.final) ? "full" : "partial";
};

const reportFor = (
  plan: ReplayPlan,
  request: RequestEnvelope,
  observation: AttemptObservation,
  outcome: ReplayOutcome,
  unavailableReason: string | null
): ReplayReport => ({
  version: 1,
  provider: plan.final.provider,
  request_wire: request.wire,
  attempts: plan.attempts.length,
  attempt_statuses: plan.attempts.map((attempt) => attempt.status),
  attempt_terminals: plan.attempts.map((attempt) => attempt.terminal),
  transport: observation.transport,
  classification: observation.classification,
  outcome,
  replay_coverage: replayCoverageFor(plan, outcome),
  retry_policy: "not_replayed",
  provider_error_mapping: observation.classification === "provider_http_error_replayed" ? "not_exercised" : "not_applicable",
  unavailable_reason: unavailableReason,
});

/** A complete attempt ended on its own recorded terminal with headers observed. */
const attemptIsComplete = (attempt: PlannedAttempt): boolean =>
  (attempt.terminal === "eof" || attempt.terminal === "cancelled") && attempt.status !== null && attempt.status < 400;

const writeStdout = (text: string): void => {
  writeSync(process.stdout.fd, encoder.encode(text));
};

const emitUnavailable = (): never => {
  writeStdout(UNAVAILABLE_LINE);
  process.exit(2);
};

try {
  const input = readDispatchInput(process.cwd());
  let result: ReplayResult;
  try {
    result = await runReplay(input);
  } catch (error) {
    if (!(error instanceof UnavailableInput)) throw error;
    // A fixed unavailable verdict from any inner stage still carries the
    // opt-in structured reason instead of only the frozen static line.
    result = {
      outcome: "unavailable",
      report: {
        version: 1,
        provider: "unavailable",
        request_wire: "unavailable",
        attempts: 0,
        attempt_statuses: [],
        attempt_terminals: [],
        transport: "response",
        classification: "unsupported",
        outcome: "unavailable",
        replay_coverage: "unavailable",
        retry_policy: "not_replayed",
        provider_error_mapping: "not_applicable",
        unavailable_reason: "input_unavailable",
      },
    };
  }
  if (input.report) writeStdout(`${REPORT_PREFIX}${JSON.stringify(result.report)}\n`);
  if (result.outcome === "unavailable") emitUnavailable();
  writeStdout(input.testIds.map((id) => `${TEST_MARKER_PREFIX}${id}\n`).join(""));
  if (result.outcome === "causal") {
    writeStdout(CAUSAL_FAILURE_LINE);
    process.exit(1);
  }
  process.exit(0);
} catch {
  emitUnavailable();
}
