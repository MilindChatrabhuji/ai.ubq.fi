import type { Kv, KvEntry, KvKey } from "#kv";
// Sentinel replay capture and client observation, split out of src/sentinel_replay_capture.ts.

import { runtimeDeploymentId, runtimeGitSha } from "../config.ts";
import { observeRawBodyOnce } from "../request.ts";
import { emptySentinelUpstreamTrace } from "./upstream-capture.ts";
import { type SentinelIncidentFailureEvent } from "./incident-outbox.ts";
import { isRecord } from "../utils.ts";
import { SENTINEL_REPLAY_ACCOUNTING_REASON, SENTINEL_REPLAY_STORAGE_FULL_REASON } from "./replay-retention-schema.ts";
import type {
  AcceptedSentinelReplayInput,
  SentinelClientBodyObservation,
  SentinelClientFailureObservation,
  SentinelCompatibilityHeaders,
  SentinelFailureObservation,
  SentinelReplayCaptureCandidate,
  SentinelReplayCaptureStatus,
  SentinelReplayCaptureStatusRow,
  SentinelReplayManifest,
} from "./replay-model.ts";
import {
  COMPATIBILITY_HEADER_NAMES,
  HEX_DIGEST,
  MAX_SSE_EVENT_CHARS,
  SENTINEL_REPLAY_MAX_BUFFERED_OBSERVATION_BYTES,
  SENTINEL_REPLAY_MAX_DOWNSTREAM_BODY_BYTES,
  TEXT_DECODER,
  TEXT_ENCODER,
  cloneBytes,
  concatBytes,
} from "./replay-model.ts";

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/**
 * Statuses a persisted row may carry. `unknown` and `status_not_retained` are
 * derived at read time and are deliberately absent: they must never be decoded
 * from storage. `expired` IS persisted by retention reclamation so that an
 * expired payload stays reportable after its manifest and chunks are deleted.
 */
const STORED_CAPTURE_STATUSES = new Set<SentinelReplayCaptureStatus>(["ready", "incomplete", "disabled", "failed", "evicted", "expired"]);
const STATUS_REASON = /^[A-Za-z0-9_.:-]{1,128}$/;

export const isSentinelReplayRequestId = (value: unknown): value is string => typeof value === "string" && REQUEST_ID.test(value);

export const isSentinelReplayCaptureStatusRow = (value: unknown): value is SentinelReplayCaptureStatusRow => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isSentinelReplayRequestId(value.request_id) ||
    typeof value.status !== "string" ||
    !STORED_CAPTURE_STATUSES.has(value.status as SentinelReplayCaptureStatus) ||
    (value.reason !== null && (typeof value.reason !== "string" || !STATUS_REASON.test(value.reason))) ||
    typeof value.captured_at_ms !== "number" ||
    !Number.isSafeInteger(value.captured_at_ms) ||
    value.captured_at_ms < 0 ||
    (value.manifest_key !== null && (!Array.isArray(value.manifest_key) || value.manifest_key.length !== 7)) ||
    (value.fingerprint !== null && (typeof value.fingerprint !== "string" || !HEX_DIGEST.test(value.fingerprint))) ||
    (value.expires_at_ms !== null && (typeof value.expires_at_ms !== "number" || !Number.isSafeInteger(value.expires_at_ms)))
  )
    return false;
  if (value.status === "ready" || value.status === "incomplete") {
    return value.manifest_key !== null && value.fingerprint !== null && value.expires_at_ms !== null;
  }
  return value.manifest_key === null && value.expires_at_ms === null;
};

export type SentinelReplayPersistResult =
  | Readonly<{ status: "stored"; manifest: SentinelReplayManifest; manifest_key?: KvKey }>
  | Readonly<{ status: "duplicate"; fingerprint: string; manifest_key?: KvKey }>
  | Readonly<{ status: "disabled"; reason: "key_missing" | "kv_unavailable" }>
  | Readonly<{ status: "incomplete"; reason: typeof SENTINEL_REPLAY_STORAGE_FULL_REASON | typeof SENTINEL_REPLAY_ACCOUNTING_REASON }>;

type PersistDependencies = Readonly<{
  kv: Kv;
  keyBytes: Uint8Array<ArrayBuffer>;
  now?: () => number;
  /** Fresh wall-clock seam for reservation lease checks. */
  currentNow?: () => number;
  randomUuid?: () => string;
  randomBytes?: (length: number) => Uint8Array<ArrayBuffer>;
  incidentEvent?: KvEntry<SentinelIncidentFailureEvent>;
  /** Test seam: an injectable small retention budget; production uses the fixed 1 GiB default. */
  budgetBytes?: number;
}>;

export const normalizeSentinelCompatibilityHeaders = (headers: Headers): SentinelCompatibilityHeaders => {
  const normalized: Record<string, string> = {};
  for (const name of COMPATIBILITY_HEADER_NAMES) {
    const value = headers.get(name)?.trim();
    if (value) normalized[name] = value;
  }
  return normalized;
};

/** A blank Content-Type header is treated as absent. */
const optionalContentType = (value: string | null): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
};

export const captureAcceptedSentinelReplayInput = (req: Request, requestId: string): SentinelReplayCaptureCandidate | null => {
  if (req.method !== "POST") return null;
  const url = new URL(req.url);
  const candidate: SentinelReplayCaptureCandidate = {
    endpoint: `${url.pathname}${url.search}`,
    method: req.method,
    body: null,
    content_type: optionalContentType(req.headers.get("content-type")),
    compatibility_headers: normalizeSentinelCompatibilityHeaders(req.headers),
    request_id: requestId,
    git_sha: runtimeGitSha(),
    deno_revision: runtimeDeploymentId(),
    body_omitted_reason: null,
  };
  observeRawBodyOnce(
    req,
    (bytes) => {
      candidate.body = bytes;
    },
    (reason) => {
      candidate.body_omitted_reason = reason;
    }
  );
  return candidate;
};

/**
 * Materialize the accepted body. A declined body is never silent: the
 * candidate keeps a bounded omission reason so a caller can publish a capture
 * status instead of an empty replay history.
 */
export const materializeSentinelReplayInput = (candidate: SentinelReplayCaptureCandidate | null): AcceptedSentinelReplayInput | null => {
  if (!candidate?.body) {
    if (candidate) candidate.body_omitted_reason ??= "body_unavailable";
    return null;
  }
  const body = candidate.body;
  candidate.body = null;
  return {
    endpoint: candidate.endpoint,
    method: candidate.method,
    body,
    content_type: candidate.content_type,
    compatibility_headers: candidate.compatibility_headers,
    request_id: candidate.request_id,
    git_sha: candidate.git_sha,
    deno_revision: candidate.deno_revision,
  };
};

export const zeroSentinelReplayInput = (input: AcceptedSentinelReplayInput | null | undefined): void => {
  input?.body.fill(0);
};

/**
 * Narrow application-terminal snapshot helper: copy the accepted body and
 * seal the request-owned upstream recorder together, before the original body
 * is zeroed or any await. HMAC, encryption and the plaintext metadata all use
 * this same immutable trace; the recorder is disposed so zeroing the original
 * never erases the snapshot and no later read retains additional bytes.
 */
export const snapshotSentinelReplayInput = (input: AcceptedSentinelReplayInput): AcceptedSentinelReplayInput => {
  const recorder = input.upstreamRecorder;
  const upstream = recorder ? recorder.snapshotAndSeal() : (input.upstream ?? emptySentinelUpstreamTrace());
  recorder?.dispose();
  return {
    endpoint: input.endpoint,
    method: input.method,
    body: cloneBytes(input.body),
    content_type: input.content_type,
    compatibility_headers: input.compatibility_headers,
    request_id: input.request_id,
    git_sha: input.git_sha,
    deno_revision: input.deno_revision,
    upstream,
  };
};

/** Discard a recorder that never reached a snapshot (zero retained bytes). */
export const disposeSentinelUpstreamRecorder = (input: AcceptedSentinelReplayInput | null | undefined): void => {
  input?.upstreamRecorder?.dispose();
};

export const discardSentinelReplayCaptureCandidate = (candidate: SentinelReplayCaptureCandidate | null | undefined): void => {
  candidate?.body?.fill(0);
  if (candidate) candidate.body = null;
};

export const sentinelFailureSignature = (observation: SentinelClientFailureObservation): string =>
  JSON.stringify({
    status: observation.status,
    stream: observation.stream,
    completed: observation.completed,
    terminal_type: observation.terminal_type,
    failure_kind: observation.failure_kind,
    framing_valid: observation.framing_valid,
    provider_route: observation.provider_route,
  });

const boundedFailureKind = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null);

/** A client-visible validation discriminator: bounded, printable, non-secret. */
const boundedErrorParam = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z0-9_.:[\]-]{1,128}$/.test(value) ? value : null);

/** Bounded base64 of an observed downstream terminal body, with its truncation state. */
const boundedTerminalBody = (bytes: Uint8Array | null): Readonly<{ base64: string | null; truncated: boolean }> => {
  if (!bytes || bytes.byteLength === 0) return { base64: null, truncated: false };
  const bounded = bytes.subarray(0, SENTINEL_REPLAY_MAX_DOWNSTREAM_BODY_BYTES);
  let binary = "";
  for (const byte of bounded) binary += String.fromCharCode(byte);
  return { base64: btoa(binary), truncated: bounded.byteLength < bytes.byteLength };
};

const errorKind = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  return boundedFailureKind(value.code) ?? boundedFailureKind(value.type);
};

const errorParam = (value: unknown): string | null => (isRecord(value) ? boundedErrorParam(value.param) : null);

/** Semantic terminal of an embeddings-job payload, or null for other statuses. */
const embeddingsJobObservation = (
  semanticStatus: string | null,
  nestedError: string | null
): Omit<SentinelClientBodyObservation, "stream" | "framing_valid"> | null => {
  if (semanticStatus === "failed") {
    return { completed: false, terminal_type: "job.failed", failure_kind: nestedError ?? "job_failed" };
  }
  if (semanticStatus === "queued" || semanticStatus === "running" || semanticStatus === "in_progress") {
    return { completed: false, terminal_type: "job.queued", failure_kind: nestedError };
  }
  if (semanticStatus === "succeeded" || semanticStatus === "completed") {
    return { completed: true, terminal_type: "job.succeeded", failure_kind: null };
  }
  return null;
};

const responseSemanticObservation = (
  status: number,
  parsed: Record<string, unknown>
): Omit<SentinelClientBodyObservation, "stream" | "framing_valid"> | null => {
  const semanticStatus = typeof parsed.status === "string" ? parsed.status.trim().toLowerCase() : null;
  const object = typeof parsed.object === "string" ? parsed.object.trim().toLowerCase() : null;
  const nestedError = errorKind(parsed.error);
  if (object === "embeddings.job") {
    const job = embeddingsJobObservation(semanticStatus, nestedError);
    if (job !== null) return job;
  }
  if (semanticStatus === "failed") {
    return { completed: false, terminal_type: "response.failed", failure_kind: nestedError ?? "response_failed", error_code: nestedError };
  }
  if (semanticStatus === "incomplete") {
    const details = isRecord(parsed.incomplete_details) ? parsed.incomplete_details : null;
    return {
      completed: false,
      terminal_type: "response.incomplete",
      failure_kind: boundedFailureKind(details?.reason) ?? nestedError,
    };
  }
  if (semanticStatus === "completed" || semanticStatus === "succeeded") {
    return { completed: true, terminal_type: "response.completed", failure_kind: null };
  }
  if (isRecord(parsed.error)) {
    return {
      completed: false,
      terminal_type: "http.error",
      failure_kind: nestedError,
      error_code: nestedError,
      error_param: errorParam(parsed.error),
    };
  }
  if (status === 202) return { completed: false, terminal_type: "http.accepted", failure_kind: null };
  return null;
};

export const inspectSentinelBufferedResponse = (status: number, contentType: string, bytes: Uint8Array): SentinelClientBodyObservation => {
  let semantic: Omit<SentinelClientBodyObservation, "stream" | "framing_valid"> | null = null;
  if (contentType.toLowerCase().includes("json")) {
    try {
      const parsed: unknown = JSON.parse(TEXT_DECODER.decode(bytes));
      if (isRecord(parsed) && !Array.isArray(parsed)) {
        semantic = responseSemanticObservation(status, parsed);
        // A non-2xx JSON body the semantic reader did not classify is still an
        // HTTP error: its own `error.code`/`error.param` are the client-visible
        // cause and must survive instead of being dropped as a bare status.
        if (semantic === null && status >= 400 && isRecord(parsed.error)) {
          semantic = {
            completed: false,
            terminal_type: "http.error",
            failure_kind: errorKind(parsed.error),
            error_code: errorKind(parsed.error),
            error_param: errorParam(parsed.error),
          };
        }
      }
    } catch {
      // HTTP status remains authoritative when a buffered body is not valid JSON.
    }
  }
  const withBody = (observation: SentinelClientBodyObservation): SentinelClientBodyObservation =>
    observation.completed
      ? observation
      : (() => {
          const body = boundedTerminalBody(bytes);
          return { ...observation, terminal_body_base64: body.base64, terminal_body_truncated: body.truncated };
        })();
  if (semantic) return withBody({ stream: false, framing_valid: true, ...semantic });
  if (status >= 400) {
    return withBody({
      stream: false,
      completed: false,
      terminal_type: "http.error",
      failure_kind: null,
      framing_valid: true,
      error_code: null,
      error_param: null,
    });
  }
  if (status === 202) {
    return {
      stream: false,
      completed: false,
      terminal_type: "http.accepted",
      failure_kind: null,
      framing_valid: true,
    };
  }
  return {
    stream: false,
    completed: true,
    terminal_type: "http.completed",
    failure_kind: null,
    framing_valid: true,
  };
};

const boundedContentLength = (headers: Headers): number | null => {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error("Response Content-Length is invalid");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error("Response Content-Length is invalid");
  return parsed;
};

const readBoundedResponseClone = async (response: Response): Promise<Uint8Array<ArrayBuffer>> => {
  const declared = boundedContentLength(response.headers);
  if (declared !== null && declared > SENTINEL_REPLAY_MAX_BUFFERED_OBSERVATION_BYTES) {
    throw new Error("Response body is too large for sentinel inspection");
  }
  const clone = response.clone();
  if (!clone.body) return new Uint8Array();
  const reader = clone.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > SENTINEL_REPLAY_MAX_BUFFERED_OBSERVATION_BYTES - total) {
        void reader.cancel().catch(() => {});
        throw new Error("Response body is too large for sentinel inspection");
      }
      total += value.byteLength;
      chunks.push(new Uint8Array(value));
    }
    return concatBytes(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
};

export const inspectSentinelBufferedResponseBody = async (response: Response): Promise<SentinelClientBodyObservation | null> => {
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  try {
    bytes = await readBoundedResponseClone(response);
    return inspectSentinelBufferedResponse(response.status, response.headers.get("content-type")?.toLowerCase() ?? "", bytes);
  } catch {
    return null;
  } finally {
    bytes?.fill(0);
  }
};

const terminalRank = (terminalType: string | null): number => {
  if (terminalType === "response.failed" || terminalType === "error") return 3;
  if (terminalType === "response.incomplete") return 2;
  if (terminalType === "response.completed" || terminalType === "[DONE]") return 1;
  return 0;
};

const SSE_KNOWN_FIELDS = new Set(["event", "data", "id", "retry"]);

type SseEventFields = Readonly<{
  eventName: string | null;
  data: readonly string[];
  hasUnknownField: boolean;
}>;

/** Splits one raw SSE event into its `event` name, `data` lines and field check. */
const parseSseEventFields = (rawEvent: string): SseEventFields => {
  const data: string[] = [];
  let eventName: string | null = null;
  let hasUnknownField = false;
  for (const line of rawEvent.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (!SSE_KNOWN_FIELDS.has(field)) hasUnknownField = true;
    if (field === "event") eventName = value;
    else if (field === "data") data.push(value);
  }
  return { eventName, data, hasUnknownField };
};

/** The observed semantic fields of one SSE event, before stream/framing context. */
type SseEventSemantic = Omit<SentinelClientBodyObservation, "stream" | "framing_valid">;

/** The terminal observation for a failed Responses terminal event. */
const failedEventObservation = (type: string, response: Record<string, unknown> | null, topLevelError: string | null): SseEventSemantic => ({
  completed: false,
  terminal_type: type,
  failure_kind: errorKind(response?.error) ?? topLevelError ?? "response_failed",
  error_code: errorKind(response?.error) ?? topLevelError,
  error_param: errorParam(response?.error),
});

/** The terminal observation for an incomplete Responses terminal event. */
const incompleteEventObservation = (type: string, response: Record<string, unknown> | null, topLevelError: string | null): SseEventSemantic => {
  const details = response && isRecord(response.incomplete_details) ? response.incomplete_details : null;
  return {
    completed: false,
    terminal_type: type,
    failure_kind: boundedFailureKind(details?.reason) ?? errorKind(response?.error) ?? topLevelError,
    error_code: errorKind(response?.error) ?? topLevelError,
    error_param: errorParam(response?.error),
  };
};

/** The terminal observation for an error event or a top-level error payload. */
const errorEventObservation = (parsed: Record<string, unknown>, topLevelError: string | null): SseEventSemantic => {
  const nested = isRecord(parsed.error) ? parsed.error : parsed;
  return {
    completed: false,
    terminal_type: "error",
    failure_kind: topLevelError ?? "error",
    error_code: topLevelError ?? "error",
    error_param: errorParam(nested),
  };
};

/** The terminal observation one parsed SSE event carries, or null when it is not terminal. */
const sseTerminalObservation = (
  type: string | null,
  parsed: Record<string, unknown>,
  response: Record<string, unknown> | null,
  topLevelError: string | null
): SseEventSemantic | null => {
  if (type === "response.failed") return failedEventObservation(type, response, topLevelError);
  if (type === "response.incomplete") return incompleteEventObservation(type, response, topLevelError);
  if (type === "error" || isRecord(parsed.error)) return errorEventObservation(parsed, topLevelError);
  if (type === "response.completed") return { completed: true, terminal_type: type, failure_kind: null };
  return null;
};

const sseEventObservation = (rawEvent: string): SseEventSemantic | null => {
  const { eventName, data } = parseSseEventFields(rawEvent);
  if (!data.length) return null;
  const joined = data.join("\n");
  if (joined === "[DONE]") return { completed: true, terminal_type: "[DONE]", failure_kind: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(joined);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return null;
  const type = typeof parsed.type === "string" ? parsed.type : eventName;
  const response = isRecord(parsed.response) && !Array.isArray(parsed.response) ? parsed.response : null;
  const topLevelError = errorKind(parsed.error) ?? (type === "error" ? boundedFailureKind(parsed.code) : null);
  return sseTerminalObservation(type, parsed, response, topLevelError);
};

/** Failure kind used when no terminal SSE frame was observed. */
const missingTerminalFailureKind = (framingValid: boolean, terminalMissing: boolean, termination: "eof" | "read_error"): string | null => {
  if (framingValid) return null;
  if (!terminalMissing) return "invalid_sse_framing";
  return termination === "read_error" ? "stream_read_error" : "missing_sse_terminal";
};

export type SentinelSseInspector = Readonly<{
  push: (bytes: Uint8Array) => void;
  finish: (termination?: "eof" | "read_error") => SentinelClientBodyObservation;
}>;

export const createSentinelSseInspector = (): SentinelSseInspector => {
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingCarriageReturn = false;
  let droppingOversizedEvent = false;
  let observedFrame = false;
  let framingValid = true;
  let terminal: Omit<SentinelClientBodyObservation, "stream" | "framing_valid"> | null = null;
  let terminalBody: string | null = null;
  let terminalBodyTruncated = false;

  const observeEvent = (rawEvent: string): void => {
    const { data, hasUnknownField } = parseSseEventFields(rawEvent);
    if (hasUnknownField) framingValid = false;
    if (data.length && data.join("\n") !== "[DONE]") {
      try {
        const parsed: unknown = JSON.parse(data.join("\n"));
        if (!isRecord(parsed) || Array.isArray(parsed)) framingValid = false;
      } catch {
        framingValid = false;
      }
    }
    const observation = sseEventObservation(rawEvent);
    if (!observation) return;
    if (terminalRank(observation.terminal_type) > terminalRank(terminal?.terminal_type ?? null)) {
      terminal = observation;
      // Only a terminal event's own bytes are retained, bounded, so the
      // observed downstream terminal is replayable without keeping the trace.
      const retained = boundedTerminalBody(TEXT_ENCODER.encode(rawEvent));
      terminalBody = retained.base64;
      terminalBodyTruncated = retained.truncated;
    }
  };
  const process = (): void => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      observedFrame = true;
      if (droppingOversizedEvent) {
        droppingOversizedEvent = false;
        continue;
      }
      observeEvent(rawEvent);
    }
    if (buffer.length > MAX_SSE_EVENT_CHARS) {
      framingValid = false;
      droppingOversizedEvent = true;
      buffer = "";
    }
  };
  const append = (text: string, final = false): void => {
    let normalized = pendingCarriageReturn ? `\r${text}` : text;
    pendingCarriageReturn = !final && normalized.endsWith("\r");
    if (pendingCarriageReturn) normalized = normalized.slice(0, -1);
    normalized = normalized.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    buffer += normalized;
    process();
  };

  return {
    push(bytes) {
      append(decoder.decode(bytes, { stream: true }));
    },
    finish(termination = "eof") {
      append(decoder.decode(), true);
      if (pendingCarriageReturn) {
        buffer += "\n";
        pendingCarriageReturn = false;
      }
      process();
      const terminalMissing = terminal === null;
      if (!observedFrame || buffer.trim() || droppingOversizedEvent || terminalMissing) framingValid = false;
      return {
        stream: true,
        completed: terminal?.completed ?? false,
        terminal_type: terminal?.terminal_type ?? null,
        failure_kind: terminal?.failure_kind ?? missingTerminalFailureKind(framingValid, terminalMissing, termination),
        framing_valid: framingValid,
        error_code: terminal?.error_code ?? null,
        error_param: terminal?.error_param ?? null,
        terminal_body_base64: terminalBody,
        terminal_body_truncated: terminalBodyTruncated,
      };
    },
  };
};

export const inspectSentinelSse = (bytes: Uint8Array): SentinelClientBodyObservation => {
  const inspector = createSentinelSseInspector();
  inspector.push(bytes);
  return inspector.finish();
};

/** Terminal type used when the internal observation carries no authoritative one. */
const fallbackTerminalType = (internal: SentinelFailureObservation, cancelled: boolean): string | null => {
  if (
    internal.terminal_type === "response.completed" ||
    internal.terminal_type === "response.failed" ||
    internal.terminal_type === "response.incomplete" ||
    internal.terminal_type === "error" ||
    cancelled
  ) {
    return internal.terminal_type;
  }
  if (internal.status >= 400) return "http.error";
  if (internal.completed) return "http.completed";
  return internal.terminal_type;
};

/**
 * The client-visible generic literal. It is a real observed value, but it is
 * never allowed to replace a trigger-specific transport cause (`read_error`,
 * `premature_eof`, `inactivity_timeout`, `malformed_event`, ...) in the
 * diagnostic `failure_kind` slot.
 */
const GENERIC_CLIENT_FAILURE_KINDS = new Set(["server_error", "error", "internal_error", "api_error"]);

const isGenericClientFailureKind = (value: string | null): boolean => value === null || GENERIC_CLIENT_FAILURE_KINDS.has(value);

/** Keep the more specific of the observed and internal causes; never the literal over a cause. */
const preferDiagnosticFailureKind = (observed: string | null, internal: string | null): string | null => {
  if (observed !== null && !isGenericClientFailureKind(observed)) return observed;
  if (internal !== null && !isGenericClientFailureKind(internal)) return internal;
  return observed ?? internal;
};

/**
 * A synthetic post-commit terminal is reported to the client as `server_error`,
 * but the transport cause that produced it must stay in the diagnostic slot.
 * The generic literal remains the fallback only when no more specific cause
 * exists at all.
 */
const diagnosticFailureKind = (
  cancelled: boolean,
  observedKind: string | null,
  internalKind: string | null,
  syntheticTerminal: string | null
): string | null => {
  if (cancelled) return null;
  const preferred = preferDiagnosticFailureKind(observedKind, internalKind);
  if (preferred !== null) return preferred;
  if (syntheticTerminal) return "server_error";
  return internalKind;
};

/** The client-visible error code, or the synthetic terminal literal when the client saw one. */
const clientErrorCode = (cancelled: boolean, body: SentinelClientBodyObservation | null | undefined, syntheticTerminal: string | null): string | null => {
  if (cancelled) return null;
  const observed = body?.error_code ?? null;
  if (observed !== null) return observed;
  return syntheticTerminal ? "server_error" : null;
};

export const resolveSentinelClientFailureObservation = (
  internal: SentinelFailureObservation,
  body?: SentinelClientBodyObservation | null
): SentinelClientFailureObservation => {
  const cancelled = internal.terminal_type === "cancelled";
  const syntheticTerminal = cancelled ? null : internal.synthetic_terminal_type;
  const fallbackTerminal = syntheticTerminal ?? fallbackTerminalType(internal, cancelled);
  const internalKind = cancelled ? null : internal.failure_kind;
  const observedKind = cancelled ? null : (body?.failure_kind ?? null);
  const bodyTerminalType = body ? body.terminal_type : fallbackTerminal;
  return {
    status: internal.status,
    stream: body ? body.stream : (internal.stream ?? false),
    completed: body ? body.completed : internal.completed,
    terminal_type: cancelled ? fallbackTerminal : bodyTerminalType,
    failure_kind: diagnosticFailureKind(cancelled, observedKind, internalKind, syntheticTerminal),
    framing_valid: body?.framing_valid ?? internal.stream !== true,
    provider_route: internal.provider_route,
    error_code: clientErrorCode(cancelled, body, syntheticTerminal),
    error_param: cancelled ? null : (body?.error_param ?? null),
    terminal_body_base64: cancelled ? null : (body?.terminal_body_base64 ?? null),
    terminal_body_truncated: cancelled ? false : (body?.terminal_body_truncated ?? false),
  };
};

const isGatewayOrProviderIncompleteReason = (value: string | null): boolean =>
  value !== null && /^(?:response_incomplete:)?(?:gateway|provider|upstream|server|network|timeout|deadline)[a-z0-9_.:-]*$/i.test(value);

const isPersistableSentinelFailure = (observation: SentinelFailureObservation | SentinelClientFailureObservation): boolean => {
  if (observation.terminal_type === "cancelled") return false;
  if ("framing_valid" in observation && observation.stream && !observation.framing_valid) return true;
  if (observation.status < 400 && observation.completed && observation.terminal_type === "response.completed") {
    return false;
  }
  if (observation.status >= 400) return true;
  if (observation.terminal_type === "response.incomplete") {
    return (
      isGatewayOrProviderIncompleteReason(observation.failure_kind) ||
      ("synthetic_terminal_type" in observation && observation.synthetic_terminal_type !== null)
    );
  }
  if (observation.failure_kind !== null) return true;
  if ("synthetic_terminal_type" in observation && observation.synthetic_terminal_type !== null) return true;
  if (
    observation.terminal_type === "deadline" ||
    observation.terminal_type === "eof" ||
    observation.terminal_type === "error" ||
    observation.terminal_type === "response.failed"
  )
    return true;
  return observation.stream === true && !observation.completed && observation.terminal_type !== null && observation.terminal_type !== "cancelled";
};

export const shouldPersistSentinelReplay = (observation: SentinelFailureObservation, clientObservation?: SentinelClientFailureObservation): boolean => {
  if (observation.terminal_type === "cancelled") return false;
  return isPersistableSentinelFailure(observation) || (clientObservation !== undefined && isPersistableSentinelFailure(clientObservation));
};

export const shouldSignalSentinelIncident = (observation: SentinelFailureObservation, clientObservation: SentinelClientFailureObservation): boolean => {
  if (observation.terminal_type === "cancelled") return false;
  if (clientObservation.stream && !clientObservation.framing_valid) return true;
  if (observation.status < 400 && observation.completed && observation.terminal_type === "response.completed") {
    return false;
  }
  if (observation.status >= 500) return true;
  if (isGatewayOrProviderIncompleteReason(clientObservation.failure_kind)) return true;
  if (observation.terminal_type === "response.incomplete") {
    return (
      isGatewayOrProviderIncompleteReason(observation.failure_kind) ||
      observation.synthetic_terminal_type !== null ||
      (clientObservation.terminal_type === "response.incomplete" && isGatewayOrProviderIncompleteReason(clientObservation.failure_kind))
    );
  }
  if (observation.synthetic_terminal_type !== null || observation.failure_kind !== null) return true;
  return observation.terminal_type === "deadline" || observation.terminal_type === "eof" || observation.terminal_type === "error";
};

export type { PersistDependencies };
export { boundedErrorParam, boundedFailureKind };
