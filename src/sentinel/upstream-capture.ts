/**
 * Request-owned passive upstream recorder plus strict trace parser and
 * canonicalizer for private v2 upstream evidence (frozen contract:
 * upstream-format-contract-v3.md, docs/contracts.md section 12).
 *
 * One recorder exists per accepted gateway request and is carried through the
 * existing UsageContext and provider options. It never intercepts fetch
 * globally, never clones/tees a response, never reads ahead or drains a stream
 * for capture, never records authentication material (headers, URLs, account
 * or request IDs), and never adds an upstream request or product
 * configuration. Recording is best effort: no recording failure may replace a
 * downstream response or error.
 *
 * Internal retained buffers are zeroable Uint8Array copies; base64 is produced
 * only when a snapshot is sealed. Attempts are bounded (8/256/131072) with
 * permanent truncation flags, exactly as the frozen contract specifies.
 */

export const SENTINEL_UPSTREAM_MAX_ATTEMPTS = 8;
/**
 * Long local streams (a 35-second reasoning generation, an interrupted
 * Codex turn) routinely exceeded the original 128 KiB/256-chunk ceiling, so a
 * capture could be exported but not replayed. These bounds keep capture
 * finite while covering ordinary long local requests; exceeding either sets
 * the matching permanent truncation flag and can never be reported as full
 * replay coverage.
 */
export const SENTINEL_UPSTREAM_MAX_CHUNKS = 4_096;
export const SENTINEL_UPSTREAM_MAX_BYTES = 4 * 1_024 * 1_024;
/** A trace may not claim more than seven days of elapsed timing. */
export const SENTINEL_UPSTREAM_MAX_TIMING_MS = 7 * 24 * 60 * 60 * 1_000;
export const SENTINEL_UPSTREAM_MAX_HEADER_VALUE_CHARS = 512;

/**
 * Fixed safe upstream response header allowlist. Authentication material,
 * cookies, provider account identifiers and request IDs are excluded by
 * construction; only bounded wire-shape and rate-limit metadata is retained.
 */
export const SENTINEL_UPSTREAM_SAFE_RESPONSE_HEADER_NAMES = [
  "cache-control",
  "content-length",
  "content-type",
  "openai-processing-ms",
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
] as const;
const SAFE_RESPONSE_HEADER_NAME_SET = new Set<string>(SENTINEL_UPSTREAM_SAFE_RESPONSE_HEADER_NAMES);

export type SentinelUpstreamProvider = "chatgpt_codex" | "surplus" | "metered" | "cerebras" | "deepseek" | "lithos" | "openrouter" | "claude_code";

export type SentinelUpstreamTerminal = "pending" | "fetch_error" | "eof" | "read_error" | "cancelled";

export type SentinelUpstreamContentType = "text/event-stream" | "application/json" | "other";

export type SentinelUpstreamSafeHeaders = Readonly<Record<string, string>>;

/**
 * One recorded upstream attempt. Version-1 traces carry exactly the first five
 * fields; version-2 traces additionally carry the observed response headers
 * and attempt/chunk timing. Absent (undefined) timing fields mean the attempt
 * predates timing capture and must be reported as unavailable, never guessed.
 */
export type SentinelUpstreamAttempt = Readonly<{
  provider: SentinelUpstreamProvider;
  status: number | null;
  content_type: SentinelUpstreamContentType | null;
  chunks_base64: readonly string[];
  terminal: SentinelUpstreamTerminal;
  headers?: SentinelUpstreamSafeHeaders;
  headers_truncated?: boolean;
  chunk_times_ms?: readonly number[];
  started_at_ms?: number;
  headers_at_ms?: number | null;
  ended_at_ms?: number | null;
}>;

export type SentinelUpstreamTrace = Readonly<{
  version: 1 | 2;
  attempts: readonly SentinelUpstreamAttempt[];
  attempts_truncated: boolean;
  bytes_truncated: boolean;
  chunks_truncated: boolean;
}>;

/**
 * Handle for one actual dispatched upstream attempt. The response wrapper
 * retains consumed chunks only while the recorder is unsealed and forwards
 * the original stream without read-ahead.
 */
export type SentinelUpstreamAttemptHandle = Readonly<{
  wrap: (response: Response) => Response;
  recordFetchError: () => void;
}>;

export type SentinelUpstreamRecorder = Readonly<{
  startAttempt: (provider: SentinelUpstreamProvider) => SentinelUpstreamAttemptHandle;
  snapshotAndSeal: () => SentinelUpstreamTrace;
  dispose: () => void;
}>;

const PROVIDER_SET = new Set<string>(["chatgpt_codex", "surplus", "metered", "cerebras", "deepseek", "lithos", "openrouter"]);
const TERMINAL_SET = new Set<string>(["pending", "fetch_error", "eof", "read_error", "cancelled"]);
const CONTENT_TYPE_SET = new Set<string>(["text/event-stream", "application/json", "other"]);

const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const freezeAttempt = (attempt: SentinelUpstreamAttempt): SentinelUpstreamAttempt => {
  const frozen: Record<string, unknown> = {
    provider: attempt.provider,
    status: attempt.status,
    content_type: attempt.content_type,
    chunks_base64: Object.freeze([...attempt.chunks_base64]),
    terminal: attempt.terminal,
  };
  if (attempt.headers !== undefined) frozen.headers = Object.freeze({ ...attempt.headers });
  if (attempt.headers_truncated !== undefined) frozen.headers_truncated = attempt.headers_truncated;
  if (attempt.chunk_times_ms !== undefined) frozen.chunk_times_ms = Object.freeze([...attempt.chunk_times_ms]);
  if (attempt.started_at_ms !== undefined) frozen.started_at_ms = attempt.started_at_ms;
  if (attempt.headers_at_ms !== undefined) frozen.headers_at_ms = attempt.headers_at_ms;
  if (attempt.ended_at_ms !== undefined) frozen.ended_at_ms = attempt.ended_at_ms;
  return Object.freeze(frozen) as SentinelUpstreamAttempt;
};

const freezeTrace = (value: SentinelUpstreamTrace): SentinelUpstreamTrace =>
  Object.freeze({ ...value, attempts: Object.freeze(value.attempts.map(freezeAttempt)) });

export const emptySentinelUpstreamTrace = (): SentinelUpstreamTrace =>
  Object.freeze({
    version: 2,
    attempts: [] as readonly SentinelUpstreamAttempt[],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  });

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const isCanonicalBase64 = (value: string): boolean => {
  if (!value || !STANDARD_BASE64.test(value) || value.length % 4 !== 0) return false;
  try {
    const decoded = decodeBase64(value);
    const reencoded = encodeBase64(decoded);
    decoded.fill(0);
    return reencoded === value;
  } catch {
    return false;
  }
};

/**
 * Normalize an upstream Content-Type before its semicolon without retaining
 * arbitrary text: exactly the three frozen literals, else `other`.
 */
export const normalizeSentinelUpstreamContentType = (raw: string | null): SentinelUpstreamContentType | null => {
  if (raw === null) return null;
  const mime = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "text/event-stream" || mime === "application/json") return mime;
  return "other";
};

const cloneIndex = (_value: unknown, index: number, message: string): never => {
  throw new Error(`${message} (attempt ${index})`);
};

const canonicalChunk = (encoded: unknown, index: number): string => {
  if (typeof encoded !== "string" || !isCanonicalBase64(encoded)) {
    cloneIndex(encoded, index, "Sentinel upstream chunk base64 is invalid");
  }
  return encoded as string;
};

type SentinelTraceAccumulator = {
  attempts: SentinelUpstreamAttempt[];
  decodedChunks: Uint8Array<ArrayBuffer>[];
  totalBytes: number;
  totalChunks: number;
};

const SENTINEL_ATTEMPT_V1_KEYS = ["provider", "status", "content_type", "chunks_base64", "terminal"];
const SENTINEL_ATTEMPT_V2_KEYS = [
  "provider",
  "status",
  "content_type",
  "chunks_base64",
  "terminal",
  "headers",
  "headers_truncated",
  "chunk_times_ms",
  "started_at_ms",
  "headers_at_ms",
  "ended_at_ms",
];

/** Validate one attempt's exact key set for its trace version and return it as a raw record. */
const sentinelAttemptRecord = (attempt: unknown, index: number, version: 1 | 2): Record<string, unknown> => {
  const expected = version === 2 ? SENTINEL_ATTEMPT_V2_KEYS : SENTINEL_ATTEMPT_V1_KEYS;
  const keys = attempt === null || typeof attempt !== "object" || Array.isArray(attempt) ? [] : Object.keys(attempt);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    cloneIndex(attempt, index, "Sentinel upstream attempt keys are invalid");
  }
  return attempt as Record<string, unknown>;
};

const sentinelAttemptProvider = (value: unknown, index: number): SentinelUpstreamProvider => {
  if (typeof value !== "string" || !PROVIDER_SET.has(value)) {
    cloneIndex(value, index, "Sentinel upstream attempt provider is invalid");
  }
  return value as SentinelUpstreamProvider;
};

const sentinelAttemptStatus = (value: unknown, index: number): number | null => {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 100 || value > 599)) {
    cloneIndex(value, index, "Sentinel upstream attempt status is invalid");
  }
  return value as number | null;
};

const sentinelAttemptContentType = (value: unknown, index: number): SentinelUpstreamContentType | null => {
  if (value !== null && (typeof value !== "string" || !CONTENT_TYPE_SET.has(value))) {
    cloneIndex(value, index, "Sentinel upstream attempt content type is invalid");
  }
  return value as SentinelUpstreamContentType | null;
};

const sentinelAttemptTerminal = (value: unknown, index: number): SentinelUpstreamTerminal => {
  if (typeof value !== "string" || !TERMINAL_SET.has(value)) {
    cloneIndex(value, index, "Sentinel upstream attempt terminal is invalid");
  }
  return value as SentinelUpstreamTerminal;
};

const sentinelAttemptChunks = (value: unknown, index: number): unknown[] => {
  const chunks: unknown[] = [];
  if (!Array.isArray(value)) {
    cloneIndex(value, index, "Sentinel upstream attempt chunks are invalid");
  } else {
    chunks.push(...value);
  }
  return chunks;
};

const sentinelAttemptHeaders = (value: unknown, index: number): SentinelUpstreamSafeHeaders => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    cloneIndex(value, index, "Sentinel upstream attempt headers are invalid");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (!SAFE_RESPONSE_HEADER_NAME_SET.has(name)) {
      cloneIndex(name, index, "Sentinel upstream attempt header name is not allowlisted");
    }
    if (typeof headerValue !== "string" || headerValue.length === 0 || headerValue.length > SENTINEL_UPSTREAM_MAX_HEADER_VALUE_CHARS) {
      cloneIndex(name, index, "Sentinel upstream attempt header value is invalid");
    }
    const text = headerValue as string;
    if (text.trim() !== text) cloneIndex(name, index, "Sentinel upstream attempt header value is not canonical");
    headers[name] = text;
  }
  return headers;
};

const sentinelAttemptChunkTimes = (value: unknown, index: number, chunkCount: number): number[] => {
  if (!Array.isArray(value) || value.length !== chunkCount) {
    cloneIndex(value, index, "Sentinel upstream attempt chunk timing does not match its chunks");
  }
  const times: number[] = [];
  let previous = 0;
  for (const candidate of value as unknown[]) {
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 0 ||
      candidate > SENTINEL_UPSTREAM_MAX_TIMING_MS ||
      candidate < previous
    ) {
      cloneIndex(candidate, index, "Sentinel upstream attempt chunk timing is invalid");
    }
    previous = candidate as number;
    times.push(previous);
  }
  return times;
};

const sentinelAttemptClock = (value: unknown, index: number, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    cloneIndex(value, index, `Sentinel upstream attempt ${label} is invalid`);
  }
  return value as number;
};

const assertSentinelAttemptHeaderConsistency = (
  status: number | null,
  contentType: SentinelUpstreamContentType | null,
  chunkCount: number,
  index: number
): void => {
  if (status === null && contentType !== null) {
    cloneIndex(status, index, "Sentinel upstream pre-header attempt cannot carry a content type");
  }
  if (status !== null && contentType === null) {
    cloneIndex(status, index, "Sentinel upstream header-bearing attempt requires a content type");
  }
  if (status === null && chunkCount > 0) {
    cloneIndex(status, index, "Sentinel upstream pre-header attempt cannot have chunks");
  }
};

const assertSentinelAttemptTerminalConsistency = (
  status: number | null,
  contentType: SentinelUpstreamContentType | null,
  terminal: SentinelUpstreamTerminal,
  chunkCount: number,
  index: number
): void => {
  if (terminal === "fetch_error" && (status !== null || contentType !== null || chunkCount > 0)) {
    cloneIndex(terminal, index, "Sentinel upstream fetch_error attempt is inconsistent");
  }
  if ((terminal === "eof" || terminal === "read_error" || terminal === "cancelled") && status === null) {
    cloneIndex(terminal, index, "Sentinel upstream header-bearing terminal requires a status");
  }
};

/** Retain one attempt's chunks under the aggregate trace bounds, in wire order. */
const retainSentinelChunks = (encodedChunks: readonly unknown[], index: number, state: SentinelTraceAccumulator): string[] => {
  if (state.totalChunks + encodedChunks.length > SENTINEL_UPSTREAM_MAX_CHUNKS) {
    throw new Error("Sentinel upstream trace has too many chunks");
  }
  state.totalChunks += encodedChunks.length;
  const chunks: string[] = [];
  for (const encoded of encodedChunks) {
    const text = canonicalChunk(encoded, index);
    const decoded = decodeBase64(text);
    state.decodedChunks.push(decoded);
    state.totalBytes += decoded.byteLength;
    if (state.totalBytes > SENTINEL_UPSTREAM_MAX_BYTES) {
      throw new Error("Sentinel upstream trace exceeds its byte bound");
    }
    chunks.push(text);
  }
  return chunks;
};

/** One version-2 attempt's validated header and timing metadata. */
type SentinelAttemptMetadata = Readonly<{
  headers: SentinelUpstreamSafeHeaders;
  headersTruncated: boolean;
  chunkTimes: readonly number[];
  startedAtMs: number;
  headersAtMs: number | null;
  endedAtMs: number | null;
}>;

/** Reject an attempt whose recorded timing disagrees with its status or terminal. */
const assertSentinelAttemptTiming = (
  status: number | null,
  terminal: SentinelUpstreamTerminal,
  metadata: Pick<SentinelAttemptMetadata, "startedAtMs" | "headersAtMs" | "endedAtMs" | "chunkTimes">,
  index: number
): void => {
  const { startedAtMs, headersAtMs, endedAtMs, chunkTimes } = metadata;
  if (status !== null && headersAtMs === null) {
    cloneIndex(status, index, "Sentinel upstream header-bearing attempt requires a header time");
  }
  if (status === null && headersAtMs !== null) {
    cloneIndex(status, index, "Sentinel upstream pre-header attempt cannot carry a header time");
  }
  if (headersAtMs !== null && headersAtMs < startedAtMs) {
    cloneIndex(headersAtMs, index, "Sentinel upstream attempt header time predates its start");
  }
  if (endedAtMs !== null && endedAtMs < (headersAtMs ?? startedAtMs)) {
    cloneIndex(endedAtMs, index, "Sentinel upstream attempt end time predates its headers");
  }
  if ((terminal === "pending") !== (endedAtMs === null)) {
    cloneIndex(terminal, index, "Sentinel upstream attempt end time disagrees with its terminal");
  }
  if (endedAtMs === null) return;
  const elapsed = endedAtMs - startedAtMs;
  if (elapsed > SENTINEL_UPSTREAM_MAX_TIMING_MS || chunkTimes.some((time) => time > elapsed)) {
    cloneIndex(endedAtMs, index, "Sentinel upstream attempt timing exceeds its bounds");
  }
};

/** Validate and normalize one version-2 attempt's headers and timing metadata. */
const sentinelAttemptV2Metadata = (
  wire: Record<string, unknown>,
  status: number | null,
  terminal: SentinelUpstreamTerminal,
  chunksLength: number,
  index: number
): SentinelAttemptMetadata => {
  const headers = sentinelAttemptHeaders(wire.headers, index);
  // A local primitive keeps the validated boolean type explicit: the wire value
  // stays rejected when it is not a boolean, and no assertion is needed.
  const headersTruncated = wire.headers_truncated;
  if (typeof headersTruncated !== "boolean") {
    return cloneIndex(headersTruncated, index, "Sentinel upstream attempt header truncation flag is invalid");
  }
  const chunkTimes = sentinelAttemptChunkTimes(wire.chunk_times_ms, index, chunksLength);
  const startedAtMs = sentinelAttemptClock(wire.started_at_ms, index, "start time");
  const headersAtMs = wire.headers_at_ms === null ? null : sentinelAttemptClock(wire.headers_at_ms, index, "header time");
  const endedAtMs = wire.ended_at_ms === null ? null : sentinelAttemptClock(wire.ended_at_ms, index, "end time");
  assertSentinelAttemptTiming(status, terminal, { startedAtMs, headersAtMs, endedAtMs, chunkTimes }, index);
  return { headers, headersTruncated, chunkTimes, startedAtMs, headersAtMs, endedAtMs };
};

/** Validate one attempt, decode its retained chunks, and append it to the trace under construction. */
const appendSentinelAttempt = (raw: unknown, index: number, state: SentinelTraceAccumulator, version: 1 | 2): void => {
  const wire = sentinelAttemptRecord(raw, index, version);
  const provider = sentinelAttemptProvider(wire.provider, index);
  const status = sentinelAttemptStatus(wire.status, index);
  const contentType = sentinelAttemptContentType(wire.content_type, index);
  const terminal = sentinelAttemptTerminal(wire.terminal, index);
  const chunks = retainSentinelChunks(sentinelAttemptChunks(wire.chunks_base64, index), index, state);
  assertSentinelAttemptHeaderConsistency(status, contentType, chunks.length, index);
  assertSentinelAttemptTerminalConsistency(status, contentType, terminal, chunks.length, index);
  const attempt: Record<string, unknown> = { provider, status, content_type: contentType, chunks_base64: chunks, terminal };
  if (version === 2) {
    const metadata = sentinelAttemptV2Metadata(wire, status, terminal, chunks.length, index);
    attempt.headers = metadata.headers;
    attempt.headers_truncated = metadata.headersTruncated;
    attempt.chunk_times_ms = metadata.chunkTimes;
    attempt.started_at_ms = metadata.startedAtMs;
    attempt.headers_at_ms = metadata.headersAtMs;
    attempt.ended_at_ms = metadata.endedAtMs;
  }
  state.attempts.push(attempt as SentinelUpstreamAttempt);
};

/**
 * Strictly parse and validate one upstream trace. Crypto-authenticated JSON is
 * still untrusted input here: exact keys, literal enums, canonical padded
 * base64, aggregate byte/chunk/attempt bounds and cross-field consistency are
 * all enforced. Returns a deep immutable copy.
 */
export const parseSentinelUpstreamTrace = (value: unknown): SentinelUpstreamTrace => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sentinel upstream trace is not an object");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["version", "attempts", "attempts_truncated", "bytes_truncated", "chunks_truncated"];
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key) => !expectedKeys.includes(key))) {
    throw new Error("Sentinel upstream trace keys are invalid");
  }
  if (record.version !== 1 && record.version !== 2) throw new Error("Sentinel upstream trace version is invalid");
  const version: 1 | 2 = record.version;
  if (typeof record.attempts_truncated !== "boolean" || typeof record.bytes_truncated !== "boolean" || typeof record.chunks_truncated !== "boolean") {
    throw new Error("Sentinel upstream trace truncation flags are invalid");
  }
  if (!Array.isArray(record.attempts)) throw new Error("Sentinel upstream trace attempts are invalid");
  if (record.attempts.length > SENTINEL_UPSTREAM_MAX_ATTEMPTS) {
    throw new Error("Sentinel upstream trace has too many attempts");
  }
  const state: SentinelTraceAccumulator = { attempts: [], decodedChunks: [], totalBytes: 0, totalChunks: 0 };
  try {
    for (let index = 0; index < record.attempts.length; index += 1) {
      appendSentinelAttempt(record.attempts[index], index, state, version);
    }
    return freezeTrace({
      version,
      attempts: state.attempts,
      attempts_truncated: record.attempts_truncated as boolean,
      bytes_truncated: record.bytes_truncated as boolean,
      chunks_truncated: record.chunks_truncated as boolean,
    });
  } finally {
    for (const chunk of state.decodedChunks) chunk.fill(0);
  }
};

export const isSentinelUpstreamTrace = (value: unknown): value is SentinelUpstreamTrace => {
  try {
    parseSentinelUpstreamTrace(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Normalize upstream response headers to the fixed safe allowlist. A value that
 * is too long to retain is dropped and reported through `truncated` rather than
 * silently shortened.
 */
export const normalizeSentinelUpstreamSafeHeaders = (headers: Headers): Readonly<{ headers: SentinelUpstreamSafeHeaders; truncated: boolean }> => {
  const retained: Record<string, string> = {};
  let truncated = false;
  for (const name of SENTINEL_UPSTREAM_SAFE_RESPONSE_HEADER_NAMES) {
    const value = headers.get(name)?.trim();
    if (!value) continue;
    if (value.length > SENTINEL_UPSTREAM_MAX_HEADER_VALUE_CHARS) {
      truncated = true;
      continue;
    }
    retained[name] = value;
  }
  return { headers: retained, truncated };
};

/** Code-unit ordering, exactly the default `Array.prototype.sort` comparison. */
const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const canonicalEntry = (entry: readonly [string, unknown]): string => `${JSON.stringify(entry[0])}:${canonicalValue(entry[1])}`;

const canonicalValue = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareCodeUnits(left, right));
    const body = entries.map(canonicalEntry).join(",");
    return `{${body}}`;
  }
  throw new Error("Sentinel upstream trace contains an unsupported value");
};

/**
 * Canonical upstream JSON for the v2 fingerprint frame: recursively sorted
 * object keys, preserved array order, JSON.stringify primitive/string
 * encoding, no whitespace. Callers must strictly validate before
 * canonicalizing.
 */
export const canonicalSentinelUpstreamJson = (trace: SentinelUpstreamTrace): string => canonicalValue(trace);

type MutableAttempt = {
  provider: SentinelUpstreamProvider;
  status: number | null;
  contentType: SentinelUpstreamContentType | null;
  chunks: Uint8Array<ArrayBuffer>[];
  terminal: SentinelUpstreamTerminal;
  bookkeepingFailed: boolean;
  headers: SentinelUpstreamSafeHeaders;
  headersTruncated: boolean;
  chunkTimesMs: number[];
  startedAtMs: number;
  headersAtMs: number | null;
  endedAtMs: number | null;
};

const noopHandle = (): SentinelUpstreamAttemptHandle =>
  Object.freeze({
    wrap: (response: Response) => response,
    recordFetchError: () => {},
  });

/** Monotonic, bounded elapsed milliseconds measured from one attempt's start. */
const elapsedMs = (startedAtMs: number, nowMs: number): number => Math.min(SENTINEL_UPSTREAM_MAX_TIMING_MS, Math.max(0, Math.trunc(nowMs - startedAtMs)));

export const createSentinelUpstreamRecorder = (): SentinelUpstreamRecorder => {
  const attempts: MutableAttempt[] = [];
  let attemptsTruncated = false;
  let bytesTruncated = false;
  let chunksTruncated = false;
  let totalBytes = 0;
  let totalChunks = 0;
  let sealed = false;
  let disposed = false;
  let sealedTrace: SentinelUpstreamTrace | null = null;

  const finishAttempt = (attempt: MutableAttempt, terminal: SentinelUpstreamTerminal, nowMs: number): void => {
    if (attempt.terminal !== "pending" || attempt.bookkeepingFailed) return;
    // A bodyless response records EOF with zero bytes; a header-bearing
    // read/cancel terminal requires its status which is set at wrap time.
    attempt.terminal = terminal;
    attempt.endedAtMs = Math.max(attempt.headersAtMs ?? attempt.startedAtMs, attempt.startedAtMs, nowMs);
  };

  const retainChunk = (attempt: MutableAttempt, chunk: Uint8Array, nowMs: number): void => {
    if (sealed || disposed || attempt.bookkeepingFailed || attempt.terminal !== "pending" || chunk.byteLength === 0) {
      return;
    }
    if (totalChunks >= SENTINEL_UPSTREAM_MAX_CHUNKS) {
      chunksTruncated = true;
      // The byte bound may be exhausted at the same time; each respective
      // bound that prevents capture must set its flag before returning.
      if (totalBytes >= SENTINEL_UPSTREAM_MAX_BYTES) bytesTruncated = true;
      return;
    }
    if (totalBytes >= SENTINEL_UPSTREAM_MAX_BYTES) {
      bytesTruncated = true;
      return;
    }
    const remaining = SENTINEL_UPSTREAM_MAX_BYTES - totalBytes;
    const keep = chunk.byteLength <= remaining ? chunk.byteLength : remaining;
    const copy = new Uint8Array(keep);
    copy.set(chunk.subarray(0, keep));
    attempt.chunks.push(copy);
    const previous = attempt.chunkTimesMs.at(-1) ?? 0;
    attempt.chunkTimesMs.push(Math.max(previous, elapsedMs(attempt.startedAtMs, nowMs)));
    totalChunks += 1;
    totalBytes += keep;
    if (keep < chunk.byteLength) bytesTruncated = true;
  };

  const wrapStream = (attempt: MutableAttempt, response: Response): Response => {
    if (response.body === null) {
      finishAttempt(attempt, "eof", Date.now());
      return response;
    }
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (error) {
            finishAttempt(attempt, "read_error", Date.now());
            try {
              controller.error(error);
            } catch {
              // The downstream may have cancelled while the upstream read failed.
            }
            return;
          }
          if (attempt.terminal === "cancelled") return;
          if (result.done) {
            finishAttempt(attempt, "eof", Date.now());
            try {
              controller.close();
            } catch {
              // Concurrent consumer cancellation may have closed the wrapper first.
            }
            return;
          }
          try {
            retainChunk(attempt, result.value, Date.now());
          } catch {
            // Recorder-side bookkeeping failure must never replace a valid
            // original chunk: disable further retention for this attempt and
            // leave it pending so the sealed trace truthfully reports
            // incomplete coverage instead of inventing complete bytes.
            attempt.bookkeepingFailed = true;
          }
          try {
            controller.enqueue(result.value);
          } catch {
            // The downstream cancelled after the read; the cancel callback owns
            // the terminal transition and underlying reader cancellation.
          }
        },
        cancel(reason) {
          finishAttempt(attempt, "cancelled", Date.now());
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 }
    );
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  const wrapAttempt = (attempt: MutableAttempt, response: Response): Response => {
    attempt.status = response.status >= 100 && response.status <= 599 ? response.status : null;
    // A real response always carries a content type: a missing or empty MIME
    // normalizes to the fixed `other` literal, never null. The null slot only
    // exists before headers.
    attempt.contentType = normalizeSentinelUpstreamContentType(response.headers.get("content-type")) ?? "other";
    try {
      const normalized = normalizeSentinelUpstreamSafeHeaders(response.headers);
      attempt.headers = normalized.headers;
      attempt.headersTruncated = normalized.truncated;
      attempt.headersAtMs = Date.now();
      return wrapStream(attempt, response);
    } catch {
      return response;
    }
  };

  const recorder: SentinelUpstreamRecorder = {
    startAttempt(provider) {
      if (sealed || disposed) return noopHandle();
      if (attempts.length >= SENTINEL_UPSTREAM_MAX_ATTEMPTS) {
        attemptsTruncated = true;
        return noopHandle();
      }
      const attempt: MutableAttempt = {
        provider,
        status: null,
        contentType: null,
        chunks: [],
        terminal: "pending",
        bookkeepingFailed: false,
        headers: {},
        headersTruncated: false,
        chunkTimesMs: [],
        startedAtMs: Date.now(),
        headersAtMs: null,
        endedAtMs: null,
      };
      attempts.push(attempt);
      return Object.freeze({
        wrap: (response: Response) => wrapAttempt(attempt, response),
        recordFetchError: () => {
          if (sealed || disposed || attempt.terminal !== "pending" || attempt.status !== null) return;
          attempt.terminal = "fetch_error";
          attempt.endedAtMs = Math.max(attempt.startedAtMs, Date.now());
        },
      });
    },
    snapshotAndSeal() {
      const sealedSnapshot = sealedTrace;
      if (sealed && sealedSnapshot !== null) return sealedSnapshot;
      sealed = true;
      sealedTrace = freezeTrace({
        version: 2,
        attempts: attempts.map((attempt) => ({
          provider: attempt.provider,
          status: attempt.status,
          content_type: attempt.contentType,
          chunks_base64: attempt.chunks.map(encodeBase64),
          headers: { ...attempt.headers },
          headers_truncated: attempt.headersTruncated,
          chunk_times_ms: [...attempt.chunkTimesMs],
          started_at_ms: attempt.startedAtMs,
          headers_at_ms: attempt.headersAtMs,
          ended_at_ms: attempt.endedAtMs,
          terminal: attempt.terminal,
        })),
        attempts_truncated: attemptsTruncated,
        bytes_truncated: bytesTruncated,
        chunks_truncated: chunksTruncated,
      });
      return sealedTrace;
    },
    dispose() {
      disposed = true;
      for (const attempt of attempts) {
        for (const chunk of attempt.chunks) chunk.fill(0);
        attempt.chunks = [];
        attempt.chunkTimesMs = [];
        attempt.headers = {};
      }
      totalBytes = 0;
      totalChunks = 0;
    },
  };
  return recorder;
};
