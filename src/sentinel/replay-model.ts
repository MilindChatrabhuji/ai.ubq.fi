import type { KvKey } from "#kv";
// Sentinel replay constants, record types and byte primitives, split out of src/sentinel_replay_capture.ts.

import { MAX_ACCEPTED_JSON_BODY_BYTES } from "../request.ts";
import { type SentinelUpstreamRecorder, type SentinelUpstreamTrace } from "./upstream-capture.ts";
import {
  SENTINEL_REPLAY_MAX_CIPHERTEXT_BYTES as MAX_REPLAY_CIPHERTEXT_BYTES,
  SENTINEL_REPLAY_MAX_DOWNSTREAM_BYTES,
  SENTINEL_REPLAY_MAX_METADATA_BYTES as MAX_REPLAY_METADATA_BYTES,
  SENTINEL_REPLAY_MAX_PLAINTEXT_BYTES as MAX_REPLAY_PLAINTEXT_BYTES,
  SENTINEL_REPLAY_MAX_STORED_CHUNKS as MAX_REPLAY_CHUNKS,
  SENTINEL_REPLAY_STORAGE_CHUNK_BYTES,
} from "./replay-limits.ts";

export const SENTINEL_REPLAY_TTL_MS = 48 * 60 * 60 * 1_000;
/**
 * Status rows are bounded non-sensitive metadata (request id, status, reason,
 * fingerprint, expiry). They outlive their payload by one additional replay TTL
 * so a request whose encrypted evidence has expired can still be reported as
 * `expired` instead of decaying into `unknown` at exactly the same instant.
 */
export const SENTINEL_REPLAY_STATUS_TTL_MS = 2 * SENTINEL_REPLAY_TTL_MS;
export const SENTINEL_REPLAY_CHUNK_BYTES = SENTINEL_REPLAY_STORAGE_CHUNK_BYTES;
export const SENTINEL_REPLAY_MAX_BODY_BYTES = MAX_ACCEPTED_JSON_BODY_BYTES;
export const SENTINEL_REPLAY_MAX_BUFFERED_OBSERVATION_BYTES = 1 * 1_024 * 1_024;
/** Bounded observed downstream terminal/error body retained with a failure. */
export const SENTINEL_REPLAY_MAX_DOWNSTREAM_BODY_BYTES = SENTINEL_REPLAY_MAX_DOWNSTREAM_BYTES;
export const SENTINEL_REPLAY_EXPORT_PAGE_LIMIT = 1;
export const SENTINEL_REPLAY_MANIFEST_PREFIX = ["uos_ai", "sentinel_replay", "v1", "manifest"] as const;
export const SENTINEL_REPLAY_DEDUPE_PREFIX = ["uos_ai", "sentinel_replay", "v1", "dedupe"] as const;
export const SENTINEL_REPLAY_CHUNK_PREFIX = ["uos_ai", "sentinel_replay", "v1", "chunk"] as const;
/** Per-request capture status/correlation row, written with the capture. */
export const SENTINEL_REPLAY_REQUEST_PREFIX = ["uos_ai", "sentinel_replay", "v1", "request"] as const;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const AES_GCM_IV_BYTES = 12;
const REPLAY_KEY_BYTES = 32;
const ENVELOPE_VERSION = 1;
/** Private plaintext metadata cut over to version 2 with required upstream evidence. */
const REPLAY_PLAINTEXT_VERSION_V2 = 2;
/** Current private plaintext: adds request settings, coverage and downstream outcome. */
const REPLAY_PLAINTEXT_VERSION = 3;
/** v2 fingerprint frame namespace; the outer crypto transport stays v1. */
const FINGERPRINT_NAMESPACE_V2 = "uos-sentinel-replay-v2:fingerprint";
const CASE_GROUP_NAMESPACE_V1 = "uos-sentinel-replay-v1:case-group";
/** Limits are shared with export/decode and the offline reader; see replay-limits.ts. */
const MAX_CAPTURE_ID_CHARS = 128;
const MAX_SSE_EVENT_CHARS = 16 * 1_024 * 1_024;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const CAPTURE_ID = /^[A-Za-z0-9_-]+$/;
const KV_CURSOR = /^[A-Za-z0-9_-]+={0,2}$/;
const KEY_DERIVATION_SALT = TEXT_ENCODER.encode("uos-sentinel-replay-v1");

const COMPATIBILITY_HEADER_NAMES = [
  "accept",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "originator",
  "user-agent",
  "x-codex-client-version",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
] as const;
const COMPATIBILITY_HEADER_NAME_SET = new Set<string>(COMPATIBILITY_HEADER_NAMES);

export type SentinelCompatibilityHeaders = Readonly<Record<string, string>>;

export type SentinelFailureObservation = Readonly<{
  status: number;
  stream: boolean | null;
  completed: boolean;
  terminal_type: string | null;
  failure_kind: string | null;
  synthetic_terminal_type: string | null;
  provider_route: string;
}>;

export type SentinelClientFailureObservation = Readonly<{
  status: number;
  stream: boolean;
  completed: boolean;
  terminal_type: string | null;
  failure_kind: string | null;
  framing_valid: boolean;
  provider_route: string;
  /** Client-visible error code when the observed downstream body carried one. */
  error_code: string | null;
  /** Validation discriminator (`param`) when the observed body carried one. */
  error_param: string | null;
  /** Bounded base64 of the observed downstream terminal/error body, or null. */
  terminal_body_base64: string | null;
  /** Whether that retained body was cut at the fixed bound. */
  terminal_body_truncated: boolean;
}>;

export type SentinelClientBodyObservation = Readonly<{
  stream: boolean;
  completed: boolean;
  terminal_type: string | null;
  failure_kind: string | null;
  framing_valid: boolean;
  error_code?: string | null;
  error_param?: string | null;
  terminal_body_base64?: string | null;
  terminal_body_truncated?: boolean;
}>;

export type AcceptedSentinelReplayInput = Readonly<{
  endpoint: string;
  method: string;
  body: Uint8Array<ArrayBuffer>;
  content_type: string | null;
  compatibility_headers: SentinelCompatibilityHeaders;
  request_id: string;
  git_sha: string;
  deno_revision: string;
  /** Sealed immutable v2 upstream trace; absent means request-only evidence. */
  upstream?: SentinelUpstreamTrace;
  /** Request-owned passive upstream recorder carried until the snapshot handoff. */
  upstreamRecorder?: SentinelUpstreamRecorder;
}>;

export type SentinelReplayCaptureCandidate = {
  readonly endpoint: string;
  readonly method: string;
  body: Uint8Array<ArrayBuffer> | null;
  readonly content_type: string | null;
  readonly compatibility_headers: SentinelCompatibilityHeaders;
  readonly request_id: string;
  readonly git_sha: string;
  readonly deno_revision: string;
  /** Why no accepted body was captured, when that happened. */
  body_omitted_reason: SentinelReplayBodyOmissionReason | null;
};

/** Why a body the gateway accepted was not carried into a capture. */
export type SentinelReplayBodyOmissionReason = "body_over_limit" | "body_unavailable" | "non_post";

/**
 * Why a request produced no encrypted payload at all. In addition to the body
 * omissions, an authenticated request rejected before capture setup (quota
 * admission) still publishes an explicit status row rather than looking like a
 * request that never happened.
 */
export type SentinelReplayCaptureOmissionReason = SentinelReplayBodyOmissionReason | "rejected_before_capture";

/** Why a stored capture cannot be replayed in full. */
export type SentinelReplayUnavailableReason =
  | "request_body_omitted"
  | "upstream_trace_empty"
  | "upstream_trace_truncated"
  | "upstream_attempt_pending"
  | "upstream_timing_unavailable"
  | "upstream_response_headers_unavailable"
  | "downstream_terminal_body_unavailable"
  | "observed_serving_model_unavailable"
  | "provider_state_not_reproducible";

export const SENTINEL_REPLAY_UNAVAILABLE_REASONS: readonly SentinelReplayUnavailableReason[] = Object.freeze([
  "request_body_omitted",
  "upstream_trace_empty",
  "upstream_trace_truncated",
  "upstream_attempt_pending",
  "upstream_timing_unavailable",
  "upstream_response_headers_unavailable",
  "downstream_terminal_body_unavailable",
  "observed_serving_model_unavailable",
  "provider_state_not_reproducible",
]);

/** Request-declared settings read back from the recorded request bytes. */
export type SentinelReplaySettings = Readonly<{
  source: "recorded_request_body" | "unavailable";
  provider_route: string;
  model_requested: string | null;
  reasoning_requested: string | null;
  stream_requested: boolean | null;
  stream_observed: boolean | null;
}>;

/** Observed downstream terminal/error outcome carried with the capture. */
export type SentinelReplayDownstream = Readonly<{
  terminal_type: string | null;
  failure_kind: string | null;
  error_code: string | null;
  error_param: string | null;
  body_base64: string | null;
  body_truncated: boolean;
}>;

export type SentinelReplayPlaintext = Readonly<{
  /** 2 = request/upstream only; 3 = adds settings, coverage and downstream outcome. */
  version: 2 | 3;
  captured_at_ms: number;
  endpoint: string;
  method: string;
  content_type: string | null;
  compatibility_headers: SentinelCompatibilityHeaders;
  failure_signature: string;
  observation: SentinelFailureObservation;
  client_observation: SentinelClientFailureObservation;
  request_id: string;
  git_sha: string;
  deno_revision: string;
  upstream: SentinelUpstreamTrace;
  /** Version-3 additions; absent on a version-2 capture. */
  settings?: SentinelReplaySettings;
  capture_status?: "ready" | "incomplete";
  replay_coverage?: "full" | "partial" | "unavailable";
  unavailable?: readonly SentinelReplayUnavailableReason[];
  body_sha256?: string;
  body_bytes?: number;
  downstream?: SentinelReplayDownstream;
  body: Uint8Array<ArrayBuffer>;
}>;

export type SentinelReplayManifest = Readonly<{
  version: 1;
  capture_id: string;
  fingerprint: string;
  case_group_digest: string;
  captured_at_ms: number;
  expires_at_ms: number;
  algorithm: "AES-256-GCM";
  compression: "gzip";
  iv: string;
  chunk_count: number;
  ciphertext_bytes: number;
  /** Additive retention accounting: encoded KV charge when this build stored it. */
  stored_bytes?: number;
  /** Additive owner lookup: request id, so eviction can publish a truthful status. */
  request_id?: string;
}>;

export type ExportedSentinelReplayCapture = Readonly<{
  manifest: SentinelReplayManifest;
  chunks: readonly string[];
}>;

/**
 * Per-request capture status. It exists so a failure is discoverable by its
 * request id even when nothing was stored: a missing replay key, a failed
 * persist or a retention eviction must never look like an empty history.
 */
export type SentinelReplayCaptureStatus = "ready" | "incomplete" | "disabled" | "failed" | "evicted" | "expired" | "unknown" | "status_not_retained";

export type SentinelReplayCaptureStatusRow = Readonly<{
  version: 1;
  request_id: string;
  status: SentinelReplayCaptureStatus;
  reason: string | null;
  captured_at_ms: number;
  manifest_key: KvKey | null;
  fingerprint: string | null;
  expires_at_ms: number | null;
}>;

const cloneBytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output: Uint8Array<ArrayBuffer> = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const stableHeaderText = (headers: SentinelCompatibilityHeaders): string =>
  Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");

const randomBytes = (length: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(length));

const requestStatusKey = (requestId: string): KvKey => [...SENTINEL_REPLAY_REQUEST_PREFIX, requestId];

export {
  AES_GCM_IV_BYTES,
  CAPTURE_ID,
  CASE_GROUP_NAMESPACE_V1,
  COMPATIBILITY_HEADER_NAMES,
  COMPATIBILITY_HEADER_NAME_SET,
  ENVELOPE_VERSION,
  FINGERPRINT_NAMESPACE_V2,
  HEX_DIGEST,
  KEY_DERIVATION_SALT,
  KV_CURSOR,
  MAX_CAPTURE_ID_CHARS,
  MAX_REPLAY_CHUNKS,
  MAX_REPLAY_CIPHERTEXT_BYTES,
  MAX_REPLAY_METADATA_BYTES,
  MAX_REPLAY_PLAINTEXT_BYTES,
  MAX_SSE_EVENT_CHARS,
  REPLAY_KEY_BYTES,
  REPLAY_PLAINTEXT_VERSION,
  REPLAY_PLAINTEXT_VERSION_V2,
  TEXT_DECODER,
  TEXT_ENCODER,
  cloneBytes,
  concatBytes,
  randomBytes,
  requestStatusKey,
  stableHeaderText,
};
