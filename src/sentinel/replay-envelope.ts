import type { KvKey } from "#kv";
// Sentinel replay envelope, key derivation and validation, split out of src/sentinel_replay_capture.ts.

import { canonicalSentinelUpstreamJson, parseSentinelUpstreamTrace, type SentinelUpstreamTrace } from "./upstream-capture.ts";
import { base64UrlDecode, encodeHex, isRecord } from "../utils.ts";
import type {
  AcceptedSentinelReplayInput,
  SentinelClientFailureObservation,
  SentinelCompatibilityHeaders,
  SentinelFailureObservation,
  SentinelReplayDownstream,
  SentinelReplayPlaintext,
  SentinelReplaySettings,
  SentinelReplayManifest,
  SentinelReplayUnavailableReason,
} from "./replay-model.ts";
import {
  CASE_GROUP_NAMESPACE_V1,
  COMPATIBILITY_HEADER_NAME_SET,
  FINGERPRINT_NAMESPACE_V2,
  HEX_DIGEST,
  KEY_DERIVATION_SALT,
  MAX_REPLAY_METADATA_BYTES,
  MAX_REPLAY_PLAINTEXT_BYTES,
  REPLAY_KEY_BYTES,
  REPLAY_PLAINTEXT_VERSION,
  REPLAY_PLAINTEXT_VERSION_V2,
  SENTINEL_REPLAY_CHUNK_BYTES,
  SENTINEL_REPLAY_MAX_BODY_BYTES,
  SENTINEL_REPLAY_UNAVAILABLE_REASONS,
  TEXT_DECODER,
  TEXT_ENCODER,
  cloneBytes,
  concatBytes,
  stableHeaderText,
} from "./replay-model.ts";
import { boundedErrorParam, boundedFailureKind } from "./replay-observation.ts";

export const decodeSentinelReplayKey = (raw: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(raw)) return null;
  try {
    const decoded = base64UrlDecode(raw);
    return decoded.byteLength === REPLAY_KEY_BYTES ? decoded : null;
  } catch {
    return null;
  }
};

const deriveKeyBytes = async (keyBytes: Uint8Array<ArrayBuffer>, purpose: "encryption" | "fingerprint" | "case-group"): Promise<ArrayBuffer> => {
  const material = await crypto.subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveBits"]);
  return await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: KEY_DERIVATION_SALT,
      info: TEXT_ENCODER.encode(purpose),
    },
    material,
    256
  );
};

const importAesKey = async (keyBytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  await crypto.subtle.importKey("raw", await deriveKeyBytes(keyBytes, "encryption"), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

const importHmacKey = async (keyBytes: Uint8Array<ArrayBuffer>, purpose: "fingerprint" | "case-group"): Promise<CryptoKey> =>
  await crypto.subtle.importKey("raw", await deriveKeyBytes(keyBytes, purpose), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

const hmacHex = async (keyBytes: Uint8Array<ArrayBuffer>, purpose: "fingerprint" | "case-group", parts: readonly Uint8Array[]): Promise<string> => {
  const key = await importHmacKey(keyBytes, purpose);
  const message = concatBytes(parts);
  try {
    const digest = await crypto.subtle.sign("HMAC", key, message);
    return encodeHex(new Uint8Array(digest));
  } finally {
    message.fill(0);
  }
};

const gzip = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const gunzip = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REPLAY_PLAINTEXT_BYTES) throw new Error("Sentinel replay plaintext exceeds its size limit");
      parts.push(cloneBytes(value));
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(parts);
};

type ReplayMetadata = Omit<SentinelReplayPlaintext, "body">;

const encodePlaintext = (metadata: ReplayMetadata, body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  const metadataBytes = TEXT_ENCODER.encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > MAX_REPLAY_METADATA_BYTES) throw new Error("Sentinel replay metadata is too large");
  if (body.byteLength > SENTINEL_REPLAY_MAX_BODY_BYTES) throw new Error("Sentinel replay body is too large");
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, metadataBytes.byteLength, false);
  return concatBytes([size, metadataBytes, body]);
};

const decodePlaintext = (bytes: Uint8Array<ArrayBuffer>): SentinelReplayPlaintext => {
  if (bytes.byteLength < 4 || bytes.byteLength > MAX_REPLAY_PLAINTEXT_BYTES) {
    throw new Error("Sentinel replay envelope size is invalid");
  }
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  if (metadataLength > MAX_REPLAY_METADATA_BYTES) throw new Error("Sentinel replay metadata is too large");
  const bodyOffset = 4 + metadataLength;
  if (bodyOffset > bytes.byteLength) throw new Error("Sentinel replay metadata length is invalid");
  if (bytes.byteLength - bodyOffset > SENTINEL_REPLAY_MAX_BODY_BYTES) {
    throw new Error("Sentinel replay body is too large");
  }
  const parsed = JSON.parse(TEXT_DECODER.decode(bytes.subarray(4, bodyOffset)));
  if (!isReplayMetadata(parsed)) throw new Error("Sentinel replay metadata is invalid");
  return { ...parsed, body: cloneBytes(bytes.subarray(bodyOffset)) };
};

const isStringRecord = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every((item) => typeof item === "string");

const isCompatibilityHeaders = (value: unknown): value is SentinelCompatibilityHeaders =>
  isStringRecord(value) &&
  Object.entries(value).every(([name, headerValue]) => COMPATIBILITY_HEADER_NAME_SET.has(name) && headerValue.length > 0 && headerValue.trim() === headerValue);

const isFailureObservation = (value: unknown): value is SentinelFailureObservation =>
  isRecord(value) &&
  typeof value.status === "number" &&
  Number.isSafeInteger(value.status) &&
  (value.stream === null || typeof value.stream === "boolean") &&
  typeof value.completed === "boolean" &&
  (value.terminal_type === null || typeof value.terminal_type === "string") &&
  (value.failure_kind === null || typeof value.failure_kind === "string") &&
  (value.synthetic_terminal_type === null || typeof value.synthetic_terminal_type === "string") &&
  typeof value.provider_route === "string";

const isClientFailureObservation = (value: unknown, requireRich: boolean): value is SentinelClientFailureObservation =>
  isRecord(value) &&
  typeof value.status === "number" &&
  Number.isSafeInteger(value.status) &&
  typeof value.stream === "boolean" &&
  typeof value.completed === "boolean" &&
  (value.terminal_type === null || typeof value.terminal_type === "string") &&
  (value.failure_kind === null || typeof value.failure_kind === "string") &&
  typeof value.framing_valid === "boolean" &&
  typeof value.provider_route === "string" &&
  (!requireRich ||
    ((value.error_code === null || boundedFailureKind(value.error_code) !== null) &&
      (value.error_param === null || boundedErrorParam(value.error_param) !== null) &&
      (value.terminal_body_base64 === null || typeof value.terminal_body_base64 === "string") &&
      typeof value.terminal_body_truncated === "boolean"));

const isReplaySettings = (value: unknown): value is SentinelReplaySettings =>
  isRecord(value) &&
  (value.source === "recorded_request_body" || value.source === "unavailable") &&
  typeof value.provider_route === "string" &&
  (value.model_requested === null || boundedFailureKind(value.model_requested) !== null) &&
  (value.reasoning_requested === null || boundedFailureKind(value.reasoning_requested) !== null) &&
  (value.stream_requested === null || typeof value.stream_requested === "boolean") &&
  (value.stream_observed === null || typeof value.stream_observed === "boolean");

const isReplayDownstream = (value: unknown): value is SentinelReplayDownstream =>
  isRecord(value) &&
  (value.terminal_type === null || typeof value.terminal_type === "string") &&
  (value.failure_kind === null || typeof value.failure_kind === "string") &&
  (value.error_code === null || boundedFailureKind(value.error_code) !== null) &&
  (value.error_param === null || boundedErrorParam(value.error_param) !== null) &&
  (value.body_base64 === null || typeof value.body_base64 === "string") &&
  typeof value.body_truncated === "boolean";

const isUnavailableReasons = (value: unknown): value is readonly SentinelReplayUnavailableReason[] =>
  Array.isArray(value) &&
  value.length <= SENTINEL_REPLAY_UNAVAILABLE_REASONS.length &&
  value.every((item) => typeof item === "string" && (SENTINEL_REPLAY_UNAVAILABLE_REASONS as readonly string[]).includes(item));

const REPLAY_METADATA_V2_KEYS = [
  "version",
  "captured_at_ms",
  "endpoint",
  "method",
  "content_type",
  "compatibility_headers",
  "failure_signature",
  "observation",
  "client_observation",
  "request_id",
  "git_sha",
  "deno_revision",
  "upstream",
] as const;

const REPLAY_METADATA_V3_KEYS = [
  ...REPLAY_METADATA_V2_KEYS,
  "settings",
  "capture_status",
  "replay_coverage",
  "unavailable",
  "body_sha256",
  "body_bytes",
  "downstream",
] as const;

const REPLAY_CAPTURE_STATUS_VALUES: readonly string[] = ["ready", "incomplete"];
const REPLAY_COVERAGE_VALUES: readonly string[] = ["full", "partial", "unavailable"];

const isReplayPlaintextVersion = (value: unknown): value is 2 | 3 => value === REPLAY_PLAINTEXT_VERSION_V2 || value === REPLAY_PLAINTEXT_VERSION;

const isOneOfLiterals = (value: unknown, allowed: readonly string[]): boolean => typeof value === "string" && allowed.includes(value);

/** The version-3 additions: settings, coverage and the downstream outcome. */
const isReplayMetadataV3 = (value: Record<string, unknown>): boolean => {
  if (!isReplaySettings(value.settings) || !isReplayDownstream(value.downstream)) return false;
  if (!isOneOfLiterals(value.capture_status, REPLAY_CAPTURE_STATUS_VALUES)) return false;
  if (!isOneOfLiterals(value.replay_coverage, REPLAY_COVERAGE_VALUES)) return false;
  if (!isUnavailableReasons(value.unavailable)) return false;
  if (typeof value.body_sha256 !== "string" || !HEX_DIGEST.test(value.body_sha256)) return false;
  if (typeof value.body_bytes !== "number" || !Number.isSafeInteger(value.body_bytes) || value.body_bytes < 0) return false;
  return true;
};

/** The metadata fields every plaintext version shares. */
const isReplayMetadataCommon = (value: Record<string, unknown>, version: 2 | 3): boolean => {
  if (!Number.isSafeInteger(value.captured_at_ms) || (value.captured_at_ms as number) < 0) return false;
  if (typeof value.endpoint !== "string" || typeof value.method !== "string") return false;
  if (value.content_type !== null && typeof value.content_type !== "string") return false;
  if (!isCompatibilityHeaders(value.compatibility_headers)) return false;
  if (typeof value.failure_signature !== "string") return false;
  if (!isFailureObservation(value.observation) || !isClientFailureObservation(value.client_observation, version === REPLAY_PLAINTEXT_VERSION)) {
    return false;
  }
  if (typeof value.request_id !== "string" || typeof value.git_sha !== "string") return false;
  if (typeof value.deno_revision !== "string") return false;
  return true;
};

/** The envelope key set must match the declared plaintext version exactly. */
const hasExactReplayMetadataKeys = (value: Record<string, unknown>, version: 2 | 3): boolean => {
  const expectedKeys: readonly string[] = version === REPLAY_PLAINTEXT_VERSION ? REPLAY_METADATA_V3_KEYS : REPLAY_METADATA_V2_KEYS;
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length && actualKeys.every((key) => expectedKeys.includes(key));
};

const isReplayMetadata = (value: unknown): value is SentinelReplayPlaintext => {
  if (!isRecord(value)) return false;
  const version = value.version;
  if (!isReplayPlaintextVersion(version)) return false;
  if (!hasExactReplayMetadataKeys(value, version)) return false;
  if (!isReplayMetadataCommon(value, version)) return false;
  try {
    parseSentinelUpstreamTrace(value.upstream);
  } catch {
    return false;
  }
  if (version === REPLAY_PLAINTEXT_VERSION && !isReplayMetadataV3(value)) return false;
  return true;
};

/**
 * Request-declared settings read back from the exact recorded request bytes.
 * This never invents a serving decision: `provider_route` and
 * `stream_observed` are observations, and the model/reasoning/stream values are
 * labelled as the recorded request's own declared settings.
 */
const requestSettingsFromBody = (body: Uint8Array<ArrayBuffer>, providerRoute: string, streamObserved: boolean | null): SentinelReplaySettings => {
  const observed: SentinelReplaySettings = {
    source: "unavailable",
    provider_route: providerRoute,
    model_requested: null,
    reasoning_requested: null,
    stream_requested: null,
    stream_observed: streamObserved,
  };
  try {
    const parsed: unknown = JSON.parse(TEXT_DECODER.decode(body));
    if (!isRecord(parsed) || Array.isArray(parsed)) return observed;
    const reasoning = isRecord(parsed.reasoning) ? boundedFailureKind(parsed.reasoning.effort) : null;
    return {
      source: "recorded_request_body",
      provider_route: providerRoute,
      model_requested: boundedFailureKind(parsed.model),
      reasoning_requested: reasoning ?? boundedFailureKind(parsed.reasoning_effort),
      stream_requested: typeof parsed.stream === "boolean" ? parsed.stream : null,
      stream_observed: streamObserved,
    };
  } catch {
    return observed;
  }
};

const downstreamObservation = (observation: SentinelClientFailureObservation): SentinelReplayDownstream => ({
  terminal_type: observation.terminal_type,
  failure_kind: observation.failure_kind,
  error_code: observation.error_code,
  error_param: observation.error_param,
  body_base64: observation.terminal_body_base64,
  body_truncated: observation.terminal_body_truncated,
});

/**
 * A 4xx rejection the gateway produced without dispatching a provider is
 * decided by the recorded request bytes and the gateway's own validation, so
 * its empty attempt list is correct evidence rather than a missing attempt.
 */
const isGatewayReproducibleRejection = (clientObservation: SentinelClientFailureObservation): boolean =>
  clientObservation.status >= 400 && clientObservation.status < 500;

/** Every reason this capture is not a complete, fully replayable record. */
const replayUnavailableReasons = (upstream: SentinelUpstreamTrace, clientObservation: SentinelClientFailureObservation): SentinelReplayUnavailableReason[] => {
  const reasons: SentinelReplayUnavailableReason[] = [];
  if (upstream.attempts.length === 0 && !isGatewayReproducibleRejection(clientObservation)) reasons.push("upstream_trace_empty");
  if (upstream.attempts_truncated || upstream.bytes_truncated || upstream.chunks_truncated) reasons.push("upstream_trace_truncated");
  if (upstream.attempts.some((attempt) => attempt.terminal === "pending")) reasons.push("upstream_attempt_pending");
  if (upstream.attempts.some((attempt) => attempt.started_at_ms === undefined)) reasons.push("upstream_timing_unavailable");
  if (upstream.attempts.some((attempt) => attempt.headers === undefined)) reasons.push("upstream_response_headers_unavailable");
  if (upstream.attempts.some((attempt) => attempt.headers_truncated === true)) reasons.push("upstream_response_headers_unavailable");
  if (clientObservation.terminal_body_base64 === null) reasons.push("downstream_terminal_body_unavailable");
  // An unreported serving-model label is optional diagnostic metadata. It is
  // never evidence the capture is missing: the recorded provider response bytes
  // are what replay consumes, so an unknown label must not make byte-complete
  // evidence permanently partial.
  return reasons;
};

const replayCoverageFor = (
  upstream: SentinelUpstreamTrace,
  clientObservation: SentinelClientFailureObservation,
  unavailable: readonly SentinelReplayUnavailableReason[]
): "full" | "partial" | "unavailable" => {
  if (unavailable.includes("upstream_trace_truncated") || unavailable.includes("upstream_attempt_pending")) return "partial";
  if (upstream.attempts.length === 0) {
    // No provider was dispatched. Only a deterministic gateway-side rejection
    // can be reproduced without provider state.
    const status = clientObservation.status;
    return status >= 400 && status < 500 ? "full" : "unavailable";
  }
  return unavailable.length === 0 ? "full" : "partial";
};

const encryptionAdditionalData = (fingerprint: string): Uint8Array<ArrayBuffer> => TEXT_ENCODER.encode(`uos-sentinel-replay-v1\0${fingerprint}`);

const splitChunks = (bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] => {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += SENTINEL_REPLAY_CHUNK_BYTES) {
    chunks.push(cloneBytes(bytes.subarray(offset, offset + SENTINEL_REPLAY_CHUNK_BYTES)));
  }
  return chunks.length ? chunks : [new Uint8Array()];
};

const fingerprintParts = (
  input: AcceptedSentinelReplayInput,
  failureSignature: string,
  purpose: "fingerprint" | "case-group",
  upstream?: SentinelUpstreamTrace
): Uint8Array<ArrayBuffer>[] => {
  const frame = (value: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] => {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(value.byteLength), false);
    return [length, value];
  };
  const common = [
    ...frame(TEXT_ENCODER.encode(purpose === "fingerprint" ? FINGERPRINT_NAMESPACE_V2 : CASE_GROUP_NAMESPACE_V1)),
    ...frame(TEXT_ENCODER.encode(input.method)),
    ...frame(TEXT_ENCODER.encode(input.endpoint)),
    ...frame(TEXT_ENCODER.encode(stableHeaderText(input.compatibility_headers))),
  ];
  // Keep the case-group identity exactly the v1 request-only HMAC. Only the
  // fingerprint gains one appended frame of canonical upstream JSON, so
  // different partial/complete traces cannot suppress one another.
  return purpose === "fingerprint"
    ? [
        ...common,
        ...frame(input.body),
        ...frame(TEXT_ENCODER.encode(failureSignature)),
        ...frame(TEXT_ENCODER.encode(upstream ? canonicalSentinelUpstreamJson(upstream) : "")),
      ]
    : [...common, ...frame(input.body)];
};

const dedupeManifestKey = (value: unknown): KvKey | null => {
  if (!isRecord(value) || !Array.isArray(value.manifest_key) || value.manifest_key.length !== 7) return null;
  return value.manifest_key as KvKey;
};

/** The durable dedupe row now carries the winning manifest's real identity and expiry. */
const dedupeRecordFor = (manifestKey: KvKey, manifest: SentinelReplayManifest): Readonly<Record<string, unknown>> => ({
  manifest_key: manifestKey,
  captured_at_ms: manifest.captured_at_ms,
  expires_at_ms: manifest.expires_at_ms,
});

/** Winner identity from a dedupe row; legacy rows (no expiry) return null and require a manifest read. */
const dedupeWinnerIdentity = (value: unknown): Readonly<{ capturedAtMs: number; expiresAtMs: number }> | null =>
  isRecord(value) && Number.isSafeInteger(value.captured_at_ms) && Number.isSafeInteger(value.expires_at_ms)
    ? { capturedAtMs: value.captured_at_ms as number, expiresAtMs: value.expires_at_ms as number }
    : null;

const ciphertextDigest = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

/**
 * Read and validate the winning manifest/chunks of an existing capture, then
 * bind the same actual capture to the stable index row in one CAS transaction.
 * The digest is the SHA-256 of the decoded concatenated ciphertext bytes,
 * exactly the consumer capture digest; the original expiry is retained and
 * nothing pretends a duplicate created new evidence. The winning capture is
 * authenticated/decrypted with the key already held by the caller so the bound
 * revision and provenance timestamp are the EXACT originals carried by that
 * encrypted capture; plaintext is zeroed and never persisted.
 */

export type { ReplayMetadata };
export {
  ciphertextDigest,
  decodePlaintext,
  dedupeManifestKey,
  dedupeRecordFor,
  dedupeWinnerIdentity,
  downstreamObservation,
  encodePlaintext,
  encryptionAdditionalData,
  fingerprintParts,
  gunzip,
  gzip,
  hmacHex,
  importAesKey,
  isCompatibilityHeaders,
  replayCoverageFor,
  replayUnavailableReasons,
  requestSettingsFromBody,
  splitChunks,
};
