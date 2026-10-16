import { test } from "bun:test";
/**
 * Coverage tests for the Sentinel replay envelope and the client-observation
 * inspector.
 *
 * These modules expose the primitives the store and the reader share, so the
 * assertions here are byte-level: the exact encoded envelope layout, the exact
 * fingerprint frames, the exact classification of an observed downstream
 * response, and every rejection the validators promise.
 */

import assert from "node:assert/strict";
import { encodeHex } from "../src/utils.ts";
import {
  MAX_SSE_EVENT_CHARS,
  MAX_REPLAY_METADATA_BYTES,
  MAX_REPLAY_PLAINTEXT_BYTES,
  REPLAY_KEY_BYTES,
  REPLAY_PLAINTEXT_VERSION_V2,
  SENTINEL_REPLAY_CHUNK_BYTES,
  SENTINEL_REPLAY_MAX_BODY_BYTES,
  SENTINEL_REPLAY_MAX_BUFFERED_OBSERVATION_BYTES,
  SENTINEL_REPLAY_MAX_DOWNSTREAM_BODY_BYTES,
  type AcceptedSentinelReplayInput,
  type SentinelClientFailureObservation,
  type SentinelFailureObservation,
  type SentinelReplayPlaintext,
} from "../src/sentinel/replay-model.ts";
import {
  ciphertextDigest,
  decodePlaintext,
  decodeSentinelReplayKey,
  dedupeManifestKey,
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
  type ReplayMetadata,
} from "../src/sentinel/replay-envelope.ts";
import {
  captureAcceptedSentinelReplayInput,
  createSentinelSseInspector,
  discardSentinelReplayCaptureCandidate,
  disposeSentinelUpstreamRecorder,
  inspectSentinelBufferedResponse,
  inspectSentinelBufferedResponseBody,
  inspectSentinelSse,
  materializeSentinelReplayInput,
  resolveSentinelClientFailureObservation,
  shouldPersistSentinelReplay,
  shouldSignalSentinelIncident,
  snapshotSentinelReplayInput,
  zeroSentinelReplayInput,
} from "../src/sentinel/replay-observation.ts";
import { captureRawBodyOnce, MAX_ACCEPTED_JSON_BODY_BYTES } from "../src/request.ts";
import {
  canonicalSentinelUpstreamJson,
  createSentinelUpstreamRecorder,
  emptySentinelUpstreamTrace,
  type SentinelUpstreamTrace,
} from "../src/sentinel/upstream-capture.ts";

const encoder = new TextEncoder();
const NOW = 1_800_000_000_000;
const GIT_SHA = "c".repeat(40);
const KEY_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array(32).fill(0x11);
/** Documentation-range client address (RFC 5737 TEST-NET-2), exactly as tests/images.test.ts fixtures use it. */
const CLIENT_ADDRESS = "198.51.100.7";

const internalObservation = (overrides: Partial<SentinelFailureObservation> = {}): SentinelFailureObservation => ({
  status: 502,
  stream: true,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  synthetic_terminal_type: null,
  provider_route: "test-provider",
  ...overrides,
});

const clientObservation = (overrides: Partial<SentinelClientFailureObservation> = {}): SentinelClientFailureObservation => ({
  status: 502,
  stream: true,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  framing_valid: true,
  provider_route: "test-provider",
  error_code: "upstream_error",
  error_param: null,
  terminal_body_base64: btoa("upstream failed"),
  terminal_body_truncated: false,
  ...overrides,
});

const acceptedInput = (body: string, requestId: string): AcceptedSentinelReplayInput => ({
  endpoint: "/v1/responses",
  method: "POST",
  body: encoder.encode(body) as Uint8Array<ArrayBuffer>,
  content_type: "application/json",
  compatibility_headers: {},
  request_id: requestId,
  git_sha: GIT_SHA,
  deno_revision: "envelope-revision",
});

const baseMetadata = (): ReplayMetadata => {
  const client = clientObservation();
  return {
    version: 3,
    captured_at_ms: NOW,
    endpoint: "/v1/responses",
    method: "POST",
    content_type: "application/json",
    compatibility_headers: {},
    failure_signature: JSON.stringify({ status: 502 }),
    observation: internalObservation(),
    client_observation: client,
    request_id: "envelope-request",
    git_sha: GIT_SHA,
    deno_revision: "envelope-revision",
    upstream: emptySentinelUpstreamTrace(),
    settings: {
      source: "recorded_request_body",
      provider_route: "test-provider",
      model_requested: "gpt-5",
      reasoning_requested: null,
      stream_requested: true,
      stream_observed: true,
    },
    capture_status: "ready",
    replay_coverage: "full",
    unavailable: [],
    body_sha256: "a".repeat(64),
    body_bytes: 4,
    downstream: downstreamObservation(client),
  };
};

/** The thirteen keys every plaintext version shares, in the order the envelope writes them. */
const REPLAY_SHARED_KEYS = [
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

/** A version-2 plaintext body: the 13 shared keys, no version-3 additions. */
const baseV2Metadata = (): Record<string, unknown> => {
  const sealed = baseMetadata() as unknown as Record<string, unknown>;
  const shared: Record<string, unknown> = {};
  for (const key of REPLAY_SHARED_KEYS) shared[key] = sealed[key];
  return {
    ...shared,
    version: REPLAY_PLAINTEXT_VERSION_V2,
    client_observation: {
      status: 502,
      stream: true,
      completed: false,
      terminal_type: "http.error",
      failure_kind: "upstream_timeout",
      framing_valid: true,
      provider_route: "test-provider",
    },
  };
};

const decodeCandidate = (metadata: unknown, body = new Uint8Array([1, 2, 3, 4])): unknown => {
  const untrusted: unknown = JSON.parse(JSON.stringify(metadata));
  return decodePlaintext(encodePlaintext(untrusted as ReplayMetadata, body));
};

const v1Trace = (attempt: SentinelUpstreamTrace["attempts"][number]): SentinelUpstreamTrace =>
  Object.freeze({
    version: 1,
    attempts: Object.freeze([attempt]),
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  });

test("the replay key decoder accepts only one canonical 32-byte key", () => {
  const decoded = decodeSentinelReplayKey("A".repeat(43));
  assert.ok(decoded, "the canonical 43-character key must decode");
  assert.equal(decoded.byteLength, REPLAY_KEY_BYTES);
  assert.deepEqual([...decoded], new Array(REPLAY_KEY_BYTES).fill(0));
  assert.equal(decodeSentinelReplayKey(`${"A".repeat(43)}=`)?.byteLength, REPLAY_KEY_BYTES);
  assert.equal(decodeSentinelReplayKey(""), null);
  assert.equal(decodeSentinelReplayKey("A".repeat(42)), null);
  assert.equal(decodeSentinelReplayKey("A".repeat(44)), null);
  assert.equal(decodeSentinelReplayKey(`${"A".repeat(43)}==`), null);
  assert.equal(decodeSentinelReplayKey(`${"A".repeat(43)}+`), null);
  assert.equal(decodeSentinelReplayKey(`${"A".repeat(42)}/A`), null);
});

test("the encoded envelope is a length-prefixed metadata frame followed by the exact body", () => {
  const metadata = baseMetadata();
  const body: Uint8Array<ArrayBuffer> = encoder.encode("body-bytes");
  const encoded = encodePlaintext(metadata, body);
  const metadataBytes = encoder.encode(JSON.stringify(metadata));
  assert.equal(encoded.byteLength, 4 + metadataBytes.byteLength + body.byteLength);
  assert.equal(new DataView(encoded.buffer, encoded.byteOffset, 4).getUint32(0, false), metadataBytes.byteLength);
  assert.equal(new TextDecoder().decode(encoded.subarray(4, 4 + metadataBytes.byteLength)), JSON.stringify(metadata));

  const plaintext: SentinelReplayPlaintext = decodePlaintext(encoded);
  assert.equal(plaintext.captured_at_ms, NOW);
  assert.equal(plaintext.request_id, "envelope-request");
  assert.deepEqual([...plaintext.body], [...body]);
  assert.equal(plaintext.body_bytes, 4);
  assert.deepEqual(plaintext.upstream, emptySentinelUpstreamTrace());
  assert.equal(plaintext.settings?.source, "recorded_request_body");
  assert.equal(plaintext.downstream?.terminal_type, "http.error");

  // A version-2 envelope still decodes: it carries the shared keys only.
  const v2: SentinelReplayPlaintext = decodePlaintext(encodePlaintext(baseV2Metadata() as ReplayMetadata, body));
  assert.equal(v2.version, REPLAY_PLAINTEXT_VERSION_V2);
  assert.deepEqual([...v2.body], [...body]);
});

test("envelope size faults are rejected before any metadata is interpreted", () => {
  assert.throws(() => decodePlaintext(new Uint8Array([0, 0, 0])), /Sentinel replay envelope size is invalid/);
  assert.throws(() => decodePlaintext(new Uint8Array(MAX_REPLAY_PLAINTEXT_BYTES + 1)), /Sentinel replay envelope size is invalid/);

  const oversizedMetadata = new Uint8Array(4);
  new DataView(oversizedMetadata.buffer).setUint32(0, MAX_REPLAY_METADATA_BYTES + 1, false);
  assert.throws(() => decodePlaintext(oversizedMetadata), /Sentinel replay metadata is too large/);

  const truncatedFrame = new Uint8Array(4);
  new DataView(truncatedFrame.buffer).setUint32(0, 10, false);
  assert.throws(() => decodePlaintext(truncatedFrame), /Sentinel replay metadata length is invalid/);

  const oversizedBody = new Uint8Array(4 + 2 + SENTINEL_REPLAY_MAX_BODY_BYTES + 1);
  new DataView(oversizedBody.buffer).setUint32(0, 2, false);
  assert.throws(() => decodePlaintext(oversizedBody), /Sentinel replay body is too large/);

  const notJson = new Uint8Array([0, 0, 0, 8, ...encoder.encode("not json")]);
  assert.throws(() => decodePlaintext(notJson), SyntaxError);

  const emptyObject = new Uint8Array([0, 0, 0, 2, ...encoder.encode("{}")]);
  assert.throws(() => decodePlaintext(emptyObject), /Sentinel replay metadata is invalid/);

  // JSON that is not an object at all is refused before any field is read.
  const scalarMetadata = new Uint8Array([0, 0, 0, 6, ...encoder.encode('"text"')]);
  assert.throws(() => decodePlaintext(scalarMetadata), /Sentinel replay metadata is invalid/);
  const arrayMetadata = new Uint8Array([0, 0, 0, 2, ...encoder.encode("[]")]);
  assert.throws(() => decodePlaintext(arrayMetadata), /Sentinel replay metadata is invalid/);

  // Encoding refuses what decoding would refuse.
  assert.throws(
    () => encodePlaintext({ ...baseMetadata(), endpoint: "e".repeat(MAX_REPLAY_METADATA_BYTES) }, new Uint8Array(1)),
    /Sentinel replay metadata is too large/
  );
  assert.throws(() => encodePlaintext(baseMetadata(), new Uint8Array(SENTINEL_REPLAY_MAX_BODY_BYTES + 1)), /Sentinel replay body is too large/);
});

test("plaintext metadata is accepted exactly when every version-3 field is in contract", () => {
  const valid = decodeCandidate(baseMetadata());
  assert.equal((valid as SentinelReplayPlaintext).version, 3);
  assert.equal((decodeCandidate(baseV2Metadata()) as SentinelReplayPlaintext).version, REPLAY_PLAINTEXT_VERSION_V2);

  const withVersion = (version: unknown): Record<string, unknown> => ({ ...(baseMetadata() as unknown as Record<string, unknown>), version });
  const variants: [string, Record<string, unknown>][] = [
    ["unknown version", withVersion(4)],
    ["missing settings", { ...(baseMetadata() as unknown as Record<string, unknown>), settings: undefined }],
    ["unavailable settings source", { ...(baseMetadata() as unknown as Record<string, unknown>), settings: { ...baseMetadata().settings, source: "guessed" } }],
    ["unbounded model", { ...(baseMetadata() as unknown as Record<string, unknown>), settings: { ...baseMetadata().settings, model_requested: "has spaces" } }],
    [
      "non-boolean stream request",
      { ...(baseMetadata() as unknown as Record<string, unknown>), settings: { ...baseMetadata().settings, stream_requested: "yes" } },
    ],
    ["unknown capture status", { ...(baseMetadata() as unknown as Record<string, unknown>), capture_status: "maybe" }],
    ["unknown coverage", { ...(baseMetadata() as unknown as Record<string, unknown>), replay_coverage: "mostly" }],
    ["unknown unavailable reason", { ...(baseMetadata() as unknown as Record<string, unknown>), unavailable: ["not_a_reason"] }],
    ["unavailable reasons not an array", { ...(baseMetadata() as unknown as Record<string, unknown>), unavailable: "upstream_trace_empty" }],
    ["short body digest", { ...(baseMetadata() as unknown as Record<string, unknown>), body_sha256: "abc" }],
    ["negative body bytes", { ...(baseMetadata() as unknown as Record<string, unknown>), body_bytes: -1 }],
    ["fractional body bytes", { ...(baseMetadata() as unknown as Record<string, unknown>), body_bytes: 1.5 }],
    [
      "downstream body flag missing",
      { ...(baseMetadata() as unknown as Record<string, unknown>), downstream: { ...baseMetadata().downstream, body_truncated: undefined } },
    ],
    ["negative capture time", { ...(baseMetadata() as unknown as Record<string, unknown>), captured_at_ms: -1 }],
    ["non-string endpoint", { ...(baseMetadata() as unknown as Record<string, unknown>), endpoint: 7 }],
    ["non-string method", { ...(baseMetadata() as unknown as Record<string, unknown>), method: null }],
    ["non-string content type", { ...(baseMetadata() as unknown as Record<string, unknown>), content_type: 7 }],
    [
      "disallowed compatibility header",
      { ...(baseMetadata() as unknown as Record<string, unknown>), compatibility_headers: { "x-forwarded-for": CLIENT_ADDRESS } },
    ],
    [
      "padded compatibility header value",
      { ...(baseMetadata() as unknown as Record<string, unknown>), compatibility_headers: { accept: " application/json" } },
    ],
    ["empty compatibility header value", { ...(baseMetadata() as unknown as Record<string, unknown>), compatibility_headers: { accept: "" } }],
    ["non-string failure signature", { ...(baseMetadata() as unknown as Record<string, unknown>), failure_signature: 3 }],
    ["invalid observation", { ...(baseMetadata() as unknown as Record<string, unknown>), observation: { status: "502" } }],
    [
      "observation missing provider route",
      { ...(baseMetadata() as unknown as Record<string, unknown>), observation: { ...baseMetadata().observation, provider_route: 3 } },
    ],
    [
      "client observation missing framing",
      { ...(baseMetadata() as unknown as Record<string, unknown>), client_observation: { ...clientObservation(), framing_valid: undefined } },
    ],
    [
      "client observation with unbounded error code",
      { ...(baseMetadata() as unknown as Record<string, unknown>), client_observation: { ...clientObservation(), error_code: "has spaces" } },
    ],
    [
      "client observation with unbounded error param",
      { ...(baseMetadata() as unknown as Record<string, unknown>), client_observation: { ...clientObservation(), error_param: "has spaces" } },
    ],
    [
      "client observation with non-string body",
      { ...(baseMetadata() as unknown as Record<string, unknown>), client_observation: { ...clientObservation(), terminal_body_base64: 7 } },
    ],
    [
      "client observation without truncation flag",
      { ...(baseMetadata() as unknown as Record<string, unknown>), client_observation: { ...clientObservation(), terminal_body_truncated: undefined } },
    ],
    ["non-string request id", { ...(baseMetadata() as unknown as Record<string, unknown>), request_id: 7 }],
    ["non-string git sha", { ...(baseMetadata() as unknown as Record<string, unknown>), git_sha: 7 }],
    ["non-string deno revision", { ...(baseMetadata() as unknown as Record<string, unknown>), deno_revision: 7 }],
    ["invalid upstream trace", { ...(baseMetadata() as unknown as Record<string, unknown>), upstream: { bad: true } }],
    ["extra field", { ...(baseMetadata() as unknown as Record<string, unknown>), extra: 1 }],
    ["missing version-3 field", { ...(baseMetadata() as unknown as Record<string, unknown>), body_bytes: undefined }],
  ];
  for (const [label, metadata] of variants) {
    assert.throws(() => decodeCandidate(metadata), /Sentinel replay metadata is invalid/, label);
  }

  // The version-2 key set is exact as well.
  assert.throws(() => decodeCandidate({ ...baseV2Metadata(), body_bytes: 4 }), /Sentinel replay metadata is invalid/);
  assert.throws(() => decodeCandidate(withVersion(1)), /Sentinel replay metadata is invalid/);
});

test("request settings are read back from the recorded body, or declared unavailable", () => {
  const recorded = requestSettingsFromBody(encoder.encode(JSON.stringify({ model: "gpt-5", stream: true })), "test-provider", true);
  assert.equal(recorded.source, "recorded_request_body");
  assert.equal(recorded.model_requested, "gpt-5");
  assert.equal(recorded.stream_requested, true);
  assert.equal(recorded.stream_observed, true);
  assert.equal(recorded.reasoning_requested, null);

  const nested = requestSettingsFromBody(encoder.encode(JSON.stringify({ reasoning: { effort: "high" } })), "test-provider", null);
  assert.equal(nested.reasoning_requested, "high");
  assert.equal(nested.stream_requested, null);

  const flat = requestSettingsFromBody(encoder.encode(JSON.stringify({ reasoning_effort: "low" })), "test-provider", null);
  assert.equal(flat.reasoning_requested, "low");

  const unbounded = requestSettingsFromBody(encoder.encode(JSON.stringify({ model: "has spaces", stream: "yes" })), "test-provider", null);
  assert.equal(unbounded.source, "recorded_request_body");
  assert.equal(unbounded.model_requested, null);
  assert.equal(unbounded.stream_requested, null);

  for (const body of ["not json", "[]", '"text"', "null", "7"]) {
    const unavailable = requestSettingsFromBody(encoder.encode(body), "test-provider", false);
    assert.equal(unavailable.source, "unavailable", body);
    assert.equal(unavailable.model_requested, null);
    assert.equal(unavailable.stream_requested, null);
    assert.equal(unavailable.stream_observed, false);
  }
});

test("unavailable reasons and coverage follow the recorded trace and the observed downstream", () => {
  const complete = clientObservation();
  assert.deepEqual(replayUnavailableReasons(emptySentinelUpstreamTrace(), complete), ["upstream_trace_empty"]);
  assert.equal(replayCoverageFor(emptySentinelUpstreamTrace(), complete, ["upstream_trace_empty"]), "unavailable");
  const rejection = clientObservation({ status: 400, terminal_body_base64: btoa("bad request") });
  assert.deepEqual(replayUnavailableReasons(emptySentinelUpstreamTrace(), rejection), []);
  assert.equal(replayCoverageFor(emptySentinelUpstreamTrace(), rejection, []), "full");

  const withoutTerminalBody = clientObservation({ terminal_body_base64: null });
  assert.deepEqual(replayUnavailableReasons(emptySentinelUpstreamTrace(), withoutTerminalBody), [
    "upstream_trace_empty",
    "downstream_terminal_body_unavailable",
  ]);

  const attempt = Object.freeze({
    provider: "cerebras" as const,
    status: 200,
    content_type: "application/json" as const,
    chunks_base64: Object.freeze(["e30="]),
    terminal: "eof" as const,
  });
  const v1 = v1Trace(attempt);
  const v1Reasons = replayUnavailableReasons(v1, complete);
  assert.deepEqual(v1Reasons, ["upstream_timing_unavailable", "upstream_response_headers_unavailable"]);
  assert.equal(replayCoverageFor(v1, complete, v1Reasons), "partial");

  const headedAttempt = { ...attempt, started_at_ms: 1, headers: {}, chunk_times_ms: Object.freeze([1]) } as typeof attempt;
  const headed = v1Trace(headedAttempt);
  assert.deepEqual(replayUnavailableReasons(headed, complete), []);
  assert.equal(replayCoverageFor(headed, complete, []), "full");

  const truncatedHeaders = v1Trace({ ...headedAttempt, headers_truncated: true });
  assert.deepEqual(replayUnavailableReasons(truncatedHeaders, complete), ["upstream_response_headers_unavailable"]);
  assert.equal(replayCoverageFor(truncatedHeaders, complete, ["upstream_response_headers_unavailable"]), "partial");

  const pending = Object.freeze({ ...v1, attempts: Object.freeze([{ ...headedAttempt, terminal: "pending" as const }]) });
  const pendingReasons = replayUnavailableReasons(pending, complete);
  assert.deepEqual(pendingReasons, ["upstream_attempt_pending"]);
  assert.equal(replayCoverageFor(pending, complete, pendingReasons), "partial");

  const truncated = Object.freeze({
    ...v1,
    attempts_truncated: true,
    bytes_truncated: true,
    chunks_truncated: true,
    attempts: Object.freeze([headed.attempts[0] as typeof attempt]),
  });
  const truncatedReasons = replayUnavailableReasons(truncated, complete);
  assert.deepEqual(truncatedReasons, ["upstream_trace_truncated"]);
  assert.equal(replayCoverageFor(truncated, complete, truncatedReasons), "partial");
});

test("the crypto and framing helpers agree with their declared contracts", async () => {
  // splitChunks keeps the recorded chunk size and never returns zero chunks.
  assert.deepEqual(
    splitChunks(new Uint8Array(0)).map((chunk) => chunk.byteLength),
    [0]
  );
  assert.deepEqual(
    splitChunks(new Uint8Array(4)).map((chunk) => chunk.byteLength),
    [4]
  );
  assert.deepEqual(
    splitChunks(new Uint8Array(SENTINEL_REPLAY_CHUNK_BYTES)).map((chunk) => chunk.byteLength),
    [SENTINEL_REPLAY_CHUNK_BYTES]
  );
  assert.deepEqual(
    splitChunks(new Uint8Array(SENTINEL_REPLAY_CHUNK_BYTES + 1)).map((chunk) => chunk.byteLength),
    [SENTINEL_REPLAY_CHUNK_BYTES, 1]
  );

  // fingerprintParts frames every part with an 8-byte big-endian length, and
  // the case-group frame is upstream-independent while the fingerprint is not.
  const input = acceptedInput('{"model":"gpt-5"}', "frame-request");
  const trace = emptySentinelUpstreamTrace();
  const fingerprintFrames = fingerprintParts(input, "signature", "fingerprint", trace);
  const framesWithoutUpstream = fingerprintParts(input, "signature", "fingerprint");
  const caseGroupFrames = fingerprintParts(input, "signature", "case-group");
  // Five shared frames (namespace, method, endpoint, headers, body) plus the
  // signature and canonical upstream JSON frames for the fingerprint purpose;
  // the case-group identity stays the four-part request frame plus the body.
  assert.equal(fingerprintFrames.length, 14);
  assert.equal(caseGroupFrames.length, 10);
  assert.equal(framesWithoutUpstream.length, 14);
  assert.equal(new DataView(fingerprintFrames[0].buffer, fingerprintFrames[0].byteOffset, 8).getBigUint64(0, false), BigInt(fingerprintFrames[1].byteLength));
  assert.deepEqual([...fingerprintFrames[1]], [...encoder.encode("uos-sentinel-replay-v2:fingerprint")]);
  assert.deepEqual([...caseGroupFrames[1]], [...encoder.encode("uos-sentinel-replay-v1:case-group")]);
  // Everything after the purpose-specific namespace frame is shared: the
  // method, endpoint, header, body and signature frames are identical.
  for (let index = 2; index <= 9; index += 1) {
    assert.deepEqual([...fingerprintFrames[index]], [...caseGroupFrames[index]], `frame ${index}`);
  }
  // The trailing frame is the canonical upstream JSON, whose byte length is
  // what the preceding 8-byte frame declares.
  const canonicalUpstream = encoder.encode(canonicalSentinelUpstreamJson(trace));
  const upstreamLengthFrame = fingerprintFrames.at(-2) ?? new Uint8Array(0);
  assert.equal(new DataView(upstreamLengthFrame.buffer, upstreamLengthFrame.byteOffset, 8).getBigUint64(0, false), BigInt(canonicalUpstream.byteLength));
  assert.deepEqual([...(fingerprintFrames.at(-1) ?? [])], [...canonicalUpstream]);
  // Without an explicit trace the frame is present and empty, so a
  // request-only fingerprint can never collide with a trace-bearing one.
  assert.deepEqual([...(framesWithoutUpstream.at(-1) ?? [])], []);
  assert.notDeepEqual(
    fingerprintFrames.map((frame) => [...frame]),
    fingerprintParts(
      input,
      "signature",
      "fingerprint",
      v1Trace({ provider: "cerebras", status: 200, content_type: "application/json", chunks_base64: [], terminal: "eof" })
    ).map((frame) => [...frame])
  );

  // The HMAC is deterministic, purpose-separated and hex-encoded.
  const parts = [encoder.encode("a"), encoder.encode("b")];
  const fingerprintDigest = await hmacHex(KEY_BYTES, "fingerprint", parts);
  assert.match(fingerprintDigest, /^[0-9a-f]{64}$/);
  assert.equal(fingerprintDigest, await hmacHex(KEY_BYTES, "fingerprint", parts));
  assert.notEqual(fingerprintDigest, await hmacHex(KEY_BYTES, "case-group", parts));
  assert.notEqual(fingerprintDigest, await hmacHex(new Uint8Array(32).fill(0x22), "fingerprint", parts));

  // The ciphertext digest is the SHA-256 hex of the exact bytes.
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  assert.equal(await ciphertextDigest(bytes), encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))));

  // Gzip round-trips and refuses both truncated input and over-large output.
  const compressed = await gzip(encoder.encode("compressible".repeat(64)));
  assert.deepEqual([...(await gunzip(compressed))], [...encoder.encode("compressible".repeat(64))]);
  assert.equal(compressed[0], 0x1f);
  assert.equal(compressed[1], 0x8b);
  await assert.rejects(() => gunzip(encoder.encode("not gzip")), /error/i);
  const tooLarge = await gzip(new Uint8Array(MAX_REPLAY_PLAINTEXT_BYTES + 1));
  await assert.rejects(() => gunzip(tooLarge), /Sentinel replay plaintext exceeds its size limit/);

  // The AES key is derived, not the raw secret, and is usable both ways.
  const key = await importAesKey(KEY_BYTES);
  assert.equal(key.algorithm.name, "AES-GCM");
  const iv = new Uint8Array(12).fill(7);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encryptionAdditionalData("a".repeat(64)) }, key, encoder.encode("payload"))
  );
  assert.deepEqual([...encryptionAdditionalData("a".repeat(64))], [...encoder.encode(`uos-sentinel-replay-v1\u0000${"a".repeat(64)}`)]);
  const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encryptionAdditionalData("a".repeat(64)) }, key, sealed);
  assert.equal(new TextDecoder().decode(opened), "payload");
  await assert.rejects(() => crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encryptionAdditionalData("b".repeat(64)) }, key, sealed));

  // Compatibility header validation is an exact allowlist with canonical values.
  assert.equal(isCompatibilityHeaders({}), true);
  assert.equal(isCompatibilityHeaders({ accept: "application/json", "x-stainless-lang": "js" }), true);
  assert.equal(isCompatibilityHeaders({ "x-forwarded-for": CLIENT_ADDRESS }), false);
  assert.equal(isCompatibilityHeaders({ accept: "" }), false);
  assert.equal(isCompatibilityHeaders({ accept: " application/json" }), false);
  assert.equal(isCompatibilityHeaders({ accept: 7 }), false);
  assert.equal(isCompatibilityHeaders("accept: application/json"), false);
  assert.equal(isCompatibilityHeaders(null), false);
  // The record check is structural, so an empty JSON array carries no headers
  // and therefore nothing disallowed.
  assert.equal(isCompatibilityHeaders([]), true);

  // The dedupe record and the downstream projection keep their exact shapes.
  const manifestKey = ["uos_ai", "sentinel_replay", "v1", "manifest", NOW, "b".repeat(64), "capture-1"];
  assert.deepEqual(dedupeManifestKey({ manifest_key: manifestKey }), manifestKey);
  assert.equal(dedupeManifestKey({ manifest_key: ["short"] }), null);
  assert.equal(dedupeManifestKey({ manifest_key: "not-a-key" }), null);
  assert.equal(dedupeManifestKey("not-a-record"), null);
  const downstream = downstreamObservation(clientObservation({ terminal_body_truncated: true }));
  assert.deepEqual(downstream, {
    terminal_type: "http.error",
    failure_kind: "upstream_timeout",
    error_code: "upstream_error",
    error_param: null,
    body_base64: btoa("upstream failed"),
    body_truncated: true,
  });
});
// ---------------------------------------------------------------------------
// Client-observation inspector
// ---------------------------------------------------------------------------

const observedBody = (bytes: Uint8Array | null): Uint8Array<ArrayBuffer> => (bytes ?? new Uint8Array()) as Uint8Array<ArrayBuffer>;

test("an accepted request is captured once, and a body the cap cannot carry is declared omitted", async () => {
  const request = new Request("https://ai.ubq.fi/v1/responses?after_ms=1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-forwarded-for": CLIENT_ADDRESS },
  });
  const candidate = captureAcceptedSentinelReplayInput(request, "capture-input-request");
  assert.ok(candidate);
  assert.equal(candidate.endpoint, "/v1/responses?after_ms=1");
  assert.equal(candidate.method, "POST");
  assert.equal(candidate.content_type, "application/json");
  // Only allowlisted compatibility headers are retained, never the client IP.
  assert.deepEqual(candidate.compatibility_headers, { accept: "application/json" });
  assert.equal(candidate.body, null);
  assert.equal(candidate.body_omitted_reason, null);

  // The route hands the accepted bytes over exactly once.
  const accepted = encoder.encode('{"model":"gpt-5"}') as Uint8Array<ArrayBuffer>;
  assert.equal(captureRawBodyOnce(request, accepted), true);
  assert.equal(candidate.body, accepted);
  assert.equal(captureRawBodyOnce(request, accepted), false);
  const materialized = materializeSentinelReplayInput(candidate);
  assert.ok(materialized);
  assert.equal(materialized.request_id, "capture-input-request");
  assert.deepEqual([...materialized.body], [...accepted]);
  assert.equal(candidate.body, null);

  // A GET has no accepted request body to capture at all.
  assert.equal(captureAcceptedSentinelReplayInput(new Request("https://ai.ubq.fi/v1/responses", { method: "GET" }), "get-request"), null);

  // A body past the fixed replay cap is rejected with an explicit reason, so
  // the omission is reportable instead of looking like an empty history.
  const oversized = new Request("https://ai.ubq.fi/v1/responses", { method: "POST" });
  const oversizedCandidate = captureAcceptedSentinelReplayInput(oversized, "oversized-request");
  assert.ok(oversizedCandidate);
  assert.equal(captureRawBodyOnce(oversized, new Uint8Array(MAX_ACCEPTED_JSON_BODY_BYTES + 1)), false);
  assert.equal(oversizedCandidate.body_omitted_reason, "body_over_limit");
  assert.equal(materializeSentinelReplayInput(oversizedCandidate), null);

  // A candidate whose body never arrived carries the default omission reason.
  const unavailable = captureAcceptedSentinelReplayInput(new Request("https://ai.ubq.fi/v1/responses", { method: "POST" }), "missing-body-request");
  assert.ok(unavailable);
  assert.equal(materializeSentinelReplayInput(unavailable), null);
  assert.equal(unavailable.body_omitted_reason, "body_unavailable");
  assert.equal(materializeSentinelReplayInput(null), null);

  // Discarding zeroes the retained bytes and drops the reference.
  const discardedRequest = new Request("https://ai.ubq.fi/v1/responses", { method: "POST" });
  const discarded = captureAcceptedSentinelReplayInput(discardedRequest, "discarded-request");
  assert.ok(discarded);
  const bytes = encoder.encode("discard-me") as Uint8Array<ArrayBuffer>;
  assert.equal(captureRawBodyOnce(discardedRequest, bytes), true);
  discardSentinelReplayCaptureCandidate(discarded);
  assert.equal(discarded.body, null);
  assert.deepEqual([...bytes], new Array(bytes.byteLength).fill(0));
  discardSentinelReplayCaptureCandidate(null);

  // The snapshot is an independent copy, and a request-owned recorder is sealed
  // and disposed as part of it.
  const zeroTarget = acceptedInput("snapshot-me", "snapshot-request");
  const recorder = createSentinelUpstreamRecorder();
  const handle = recorder.startAttempt("deepseek");
  await handle.wrap(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })).arrayBuffer();
  const snapshot = snapshotSentinelReplayInput({ ...zeroTarget, upstreamRecorder: recorder });
  assert.deepEqual([...snapshot.body], [...zeroTarget.body]);
  assert.equal(snapshot.upstream?.attempts.length, 1);
  assert.equal(snapshot.upstreamRecorder, undefined);
  zeroSentinelReplayInput(zeroTarget);
  assert.deepEqual([...zeroTarget.body], new Array(zeroTarget.body.byteLength).fill(0));
  assert.deepEqual([...snapshot.body], [...acceptedInput("snapshot-me", "snapshot-request").body]);
  zeroSentinelReplayInput(null);
  zeroSentinelReplayInput(undefined);
  disposeSentinelUpstreamRecorder(snapshot);
  disposeSentinelUpstreamRecorder(null);
});

test("buffered responses are classified from their status, body and semantic markers", () => {
  const json = (value: unknown): Uint8Array<ArrayBuffer> => encoder.encode(JSON.stringify(value)) as Uint8Array<ArrayBuffer>;

  const embeddingsQueued = inspectSentinelBufferedResponse(202, "application/json", json({ object: "embeddings.job", status: "queued" }));
  assert.equal(embeddingsQueued.terminal_type, "job.queued");
  assert.equal(embeddingsQueued.completed, false);
  for (const status of ["running", "in_progress"]) {
    assert.equal(inspectSentinelBufferedResponse(202, "application/json", json({ object: "embeddings.job", status })).terminal_type, "job.queued");
  }
  const failed = inspectSentinelBufferedResponse(200, "application/json", json({ object: "embeddings.job", status: "failed", error: { code: "job_error" } }));
  assert.equal(failed.terminal_type, "job.failed");
  assert.equal(failed.failure_kind, "job_error");
  const succeeded = inspectSentinelBufferedResponse(200, "application/json", json({ object: "embeddings.job", status: "succeeded" }));
  assert.equal(succeeded.terminal_type, "job.succeeded");
  assert.equal(succeeded.completed, true);
  assert.equal(succeeded.terminal_body_base64, undefined);
  // An embeddings job with an unknown semantic status falls through to the
  // response-level reader, which keeps the HTTP status authoritative.
  assert.equal(inspectSentinelBufferedResponse(200, "application/json", json({ object: "embeddings.job", status: "weird" })).completed, true);

  const responseFailed = inspectSentinelBufferedResponse(200, "application/json", json({ status: "failed", error: { code: "server_error" } }));
  assert.equal(responseFailed.terminal_type, "response.failed");
  assert.equal(responseFailed.error_code, "server_error");
  const responseIncomplete = inspectSentinelBufferedResponse(
    200,
    "application/json",
    json({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })
  );
  assert.equal(responseIncomplete.terminal_type, "response.incomplete");
  assert.equal(responseIncomplete.failure_kind, "max_output_tokens");
  // When the incomplete details carry no usable reason, the nested error code
  // is the fallback cause rather than a dropped diagnostic.
  const incompleteWithoutReason = inspectSentinelBufferedResponse(200, "application/json", json({ status: "incomplete", error: { code: "server_error" } }));
  assert.equal(incompleteWithoutReason.terminal_type, "response.incomplete");
  assert.equal(incompleteWithoutReason.failure_kind, "server_error");
  const responseCompleted = inspectSentinelBufferedResponse(200, "application/json", json({ status: "succeeded" }));
  assert.equal(responseCompleted.terminal_type, "response.completed");
  assert.equal(responseCompleted.failure_kind, null);
  const accepted = inspectSentinelBufferedResponse(202, "application/json", json({ status: "queued" }));
  assert.equal(accepted.terminal_type, "http.accepted");
  assert.equal(accepted.failure_kind, null);

  // A retained terminal body is bounded and reported as truncated past the cap.
  const largeBody = json({ error: { code: "invalid_request_error", param: "model" }, padding: "x".repeat(SENTINEL_REPLAY_MAX_DOWNSTREAM_BODY_BYTES) });
  const truncated = inspectSentinelBufferedResponse(400, "application/json", largeBody);
  assert.equal(truncated.terminal_type, "http.error");
  assert.equal(truncated.error_param, "model");
  assert.equal(truncated.terminal_body_truncated, true);

  // Non-JSON bodies keep the HTTP status as the terminal, with the observed
  // body retained as bounded evidence.
  const plainError = inspectSentinelBufferedResponse(400, "text/plain", observedBody(encoder.encode("bad request")));
  assert.equal(plainError.terminal_type, "http.error");
  assert.equal(plainError.failure_kind, null);
  assert.equal(plainError.stream, false);
  assert.equal(plainError.framing_valid, true);
  assert.equal(plainError.terminal_body_base64, btoa("bad request"));
  const plainAccepted = inspectSentinelBufferedResponse(202, "text/plain", new Uint8Array());
  assert.equal(plainAccepted.terminal_type, "http.accepted");
  assert.equal(plainAccepted.terminal_body_base64, undefined);
  const plainCompleted = inspectSentinelBufferedResponse(200, "text/plain", new Uint8Array());
  assert.equal(plainCompleted.terminal_type, "http.completed");
  assert.equal(plainCompleted.completed, true);

  // A body that is not JSON at all is never parsed into a semantic claim.
  const malformed = inspectSentinelBufferedResponse(502, "application/json", observedBody(encoder.encode("{not json")));
  assert.equal(malformed.terminal_type, "http.error");
  assert.equal(malformed.error_code, null);
  const malformedOk = inspectSentinelBufferedResponse(200, "application/json", observedBody(encoder.encode("{not json")));
  assert.equal(malformedOk.terminal_type, "http.completed");

  // A JSON array is not a response object.
  assert.equal(inspectSentinelBufferedResponse(200, "application/json", json([1, 2, 3])).terminal_type, "http.completed");
});

test("buffered response bodies are read once, under a bound, and never throw at the caller", async () => {
  const inspect = inspectSentinelBufferedResponseBody;
  const ok = new Response(JSON.stringify({ error: { code: "upstream_error" } }), { status: 502, headers: { "content-type": "application/json" } });
  const observation = await inspect(ok);
  assert.ok(observation, "a buffered JSON error body must be inspected");
  assert.equal(observation.terminal_type, "http.error");
  assert.equal(observation.error_code, "upstream_error");
  // The observed clone never consumes the response the caller still needs.
  assert.equal((await ok.text()).length > 0, true);

  // A bodyless response is inspected with an empty body.
  const bodyless = await inspect(new Response(null, { status: 204 }));
  assert.ok(bodyless, "a bodyless response is inspected as an empty body");
  assert.equal(bodyless.terminal_type, "http.completed");
  assert.equal(bodyless.completed, true);

  // A declared length past the observation bound is refused before reading.
  const tooLong = await inspect(new Response("{}", { status: 502, headers: { "content-length": String(SENTINEL_REPLAY_MAX_BUFFERED_OBSERVATION_BYTES + 1) } }));
  assert.equal(tooLong, null);
  // A declared length that is not a canonical integer is a refusal, not a guess.
  const invalidLength = await inspect(new Response("{}", { status: 502, headers: { "content-length": "12abc" } }));
  assert.equal(invalidLength, null);
  const negativeLength = await inspect(new Response("{}", { status: 502, headers: { "content-length": "-1" } }));
  assert.equal(negativeLength, null);
  // Digits that are not a safe integer are refused as well.
  const unsafeLength = await inspect(new Response("{}", { status: 502, headers: { "content-length": "9".repeat(30) } }));
  assert.equal(unsafeLength, null);
  // An undeclared length is enforced while streaming.
  const streamed = await inspect(new Response(new Uint8Array(SENTINEL_REPLAY_MAX_BUFFERED_OBSERVATION_BYTES + 1), { status: 502 }));
  assert.equal(streamed, null);
});

test("the SSE inspector accepts real frames and reports every framing fault", () => {
  const hello = inspectSentinelSse(encoder.encode('data: {"type":"response.completed","response":{"id":"r"}}\n\ndata: [DONE]\n\n'));
  assert.equal(hello.stream, true);
  assert.equal(hello.completed, true);
  assert.equal(hello.framing_valid, true);
  assert.equal(hello.terminal_type, "response.completed");
  // A later terminal of equal rank never replaces the first one observed.
  assert.equal(inspectSentinelSse(encoder.encode("data: [DONE]\n\ndata: [DONE]\n\n")).terminal_type, "[DONE]");

  // Unknown fields are a framing fault, and a failed event outranks completion.
  const unknownField = inspectSentinelSse(encoder.encode('weird: 1\ndata: {"type":"response.completed"}\n\ndata: {"type":"response.failed"}\n\n'));
  assert.equal(unknownField.framing_valid, false);
  assert.equal(unknownField.terminal_type, "response.failed");
  assert.equal(unknownField.completed, false);

  // A data payload that is not a JSON object is invalid framing.
  const malformed = inspectSentinelSse(encoder.encode("data: not json\n\n"));
  assert.equal(malformed.framing_valid, false);
  assert.equal(malformed.terminal_type, null);
  const arrayPayload = inspectSentinelSse(encoder.encode("data: [1,2]\n\n"));
  assert.equal(arrayPayload.framing_valid, false);
  // A comment-only stream carries no terminal at all.
  const commentOnly = inspectSentinelSse(encoder.encode(": keepalive\n\n"));
  assert.equal(commentOnly.terminal_type, null);

  // An error event keeps the failing cause, including a nested param.
  const errorEvent = inspectSentinelSse(encoder.encode('event: error\ndata: {"error":{"code":"invalid_request_error","param":"model"}}\n\n'));
  assert.equal(errorEvent.terminal_type, "error");
  assert.equal(errorEvent.error_code, "invalid_request_error");
  assert.equal(errorEvent.error_param, "model");

  // A read error before any terminal is reported as the transport cause, and an
  // incomplete stream keeps its own missing-terminal reason.
  const readFailure = createSentinelSseInspector();
  readFailure.push(encoder.encode(": keepalive\n\n"));
  assert.equal(readFailure.finish("read_error").failure_kind, "stream_read_error");
  const eofFailure = createSentinelSseInspector();
  eofFailure.push(encoder.encode(": keepalive\n\n"));
  assert.equal(eofFailure.finish().failure_kind, "missing_sse_terminal");
  const terminated = createSentinelSseInspector();
  terminated.push(encoder.encode('data: {"type":"response.completed"}\n\n'));
  assert.equal(terminated.finish("read_error").terminal_type, "response.completed");

  // A carried carriage return is normalized across chunk boundaries.
  const carriageReturn = createSentinelSseInspector();
  carriageReturn.push(encoder.encode('data: {"type":"response.completed"}\r'));
  carriageReturn.push(encoder.encode("\n\r\n"));
  assert.equal(carriageReturn.finish().terminal_type, "response.completed");
  // A CR held back at a chunk boundary is joined to the next chunk's CRLF, so
  // the event is not split into stray field lines.
  const splitCrlf = createSentinelSseInspector();
  splitCrlf.push(encoder.encode('data: {"type":"response.completed"}\r'));
  splitCrlf.push(encoder.encode("\n\ndata: [DONE]\n\n"));
  const rejoined = splitCrlf.finish();
  assert.equal(rejoined.framing_valid, true);
  assert.equal(rejoined.terminal_type, "response.completed");
  assert.equal(rejoined.completed, true);
  // A stream that ends on a CR still terminates the pending event, because the
  // deferred carriage return is flushed as the final line break.
  const loneCr = inspectSentinelSse(encoder.encode('data: {"type":"response.completed"}\r\r'));
  assert.equal(loneCr.terminal_type, "response.completed");
  assert.equal(loneCr.framing_valid, true);

  // An event past the fixed frame bound is dropped while the stream continues,
  // and the framing fault is remembered.
  const oversized = createSentinelSseInspector();
  oversized.push(encoder.encode("x".repeat(MAX_SSE_EVENT_CHARS + 1)));
  oversized.push(encoder.encode('data: {"type":"response.completed"}\n\n'));
  const dropped = oversized.finish();
  assert.equal(dropped.framing_valid, false);
  assert.equal(dropped.terminal_type, null);

  // A stream that ends mid-event is not valid framing.
  const pending = inspectSentinelSse(encoder.encode('data: {"type":"response.completed"}'));
  assert.equal(pending.framing_valid, false);
});

test("the client failure observation keeps the specific cause and the client-visible literals", () => {
  const cancelled = resolveSentinelClientFailureObservation(internalObservation({ terminal_type: "cancelled", failure_kind: "client_aborted", stream: true }));
  assert.equal(cancelled.failure_kind, null);
  assert.equal(cancelled.error_code, null);
  assert.equal(cancelled.error_param, null);
  assert.equal(cancelled.terminal_body_base64, null);
  assert.equal(cancelled.terminal_body_truncated, false);
  assert.equal(cancelled.terminal_type, "cancelled");
  assert.equal(cancelled.stream, true);

  // A synthetic post-commit terminal reports `server_error` to the client while
  // the transport cause stays in the diagnostic slot.
  const synthetic = resolveSentinelClientFailureObservation(
    internalObservation({ terminal_type: "eof", failure_kind: "premature_eof", synthetic_terminal_type: "response.failed", stream: true })
  );
  assert.equal(synthetic.terminal_type, "response.failed");
  assert.equal(synthetic.failure_kind, "premature_eof");
  assert.equal(synthetic.error_code, "server_error");
  // An observed body always carries its own terminal, even when the internal
  // observation claims a synthetic one.
  const observedBodyWins = resolveSentinelClientFailureObservation(
    internalObservation({ terminal_type: "eof", failure_kind: "premature_eof", synthetic_terminal_type: "response.failed", stream: true }),
    { stream: true, completed: false, terminal_type: "response.incomplete", failure_kind: null, framing_valid: true }
  );
  assert.equal(observedBodyWins.terminal_type, "response.incomplete");
  assert.equal(observedBodyWins.failure_kind, "premature_eof");
  const genericOnly = resolveSentinelClientFailureObservation(
    internalObservation({ terminal_type: "eof", failure_kind: null, synthetic_terminal_type: "response.failed" }),
    { stream: false, completed: false, terminal_type: null, failure_kind: "server_error", framing_valid: true }
  );
  assert.equal(genericOnly.failure_kind, "server_error");
  assert.equal(genericOnly.error_code, "server_error");
  // With no transport cause at all, the synthetic terminal is the only
  // evidence and is reported as the generic server error it was.
  const syntheticOnly = resolveSentinelClientFailureObservation(
    internalObservation({ status: 200, completed: false, terminal_type: "eof", failure_kind: null, synthetic_terminal_type: "response.failed" })
  );
  assert.equal(syntheticOnly.terminal_type, "response.failed");
  assert.equal(syntheticOnly.failure_kind, "server_error");
  assert.equal(syntheticOnly.error_code, "server_error");
  const genericPair = resolveSentinelClientFailureObservation(internalObservation({ terminal_type: "error", failure_kind: "error" }), {
    stream: false,
    completed: false,
    terminal_type: "error",
    failure_kind: "server_error",
    framing_valid: true,
  });
  assert.equal(genericPair.failure_kind, "server_error");

  // Without an observed body the fallback terminal is derived from the status.
  const httpError = resolveSentinelClientFailureObservation(internalObservation());
  assert.equal(httpError.terminal_type, "http.error");
  assert.equal(httpError.completed, false);
  const completed = resolveSentinelClientFailureObservation(internalObservation({ status: 200, completed: true, terminal_type: null, failure_kind: null }));
  assert.equal(completed.terminal_type, "http.completed");
  const carried = resolveSentinelClientFailureObservation(internalObservation({ status: 200, terminal_type: "response.failed", failure_kind: "server_error" }));
  assert.equal(carried.terminal_type, "response.failed");
  assert.equal(carried.framing_valid, false);
  assert.equal(carried.stream, true);
});

test("persistence and incident signal decisions follow the recorded terminal, not the status alone", () => {
  assert.equal(shouldPersistSentinelReplay(internalObservation({ terminal_type: "cancelled" })), false);
  assert.equal(
    shouldPersistSentinelReplay(internalObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: null })),
    false
  );
  assert.equal(shouldPersistSentinelReplay(internalObservation({ status: 429, terminal_type: "http.error" })), true);
  // A synthetic terminal with no transport cause is still a failure worth
  // persisting, and a null-cause non-2xx terminal is not.
  assert.equal(
    shouldPersistSentinelReplay(
      internalObservation({ status: 200, completed: false, terminal_type: "eof", failure_kind: null, synthetic_terminal_type: "response.failed" })
    ),
    true
  );
  assert.equal(
    shouldPersistSentinelReplay(
      internalObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: null }),
      clientObservation({ stream: true, framing_valid: false, completed: false, terminal_type: "response.incomplete", failure_kind: "invalid_sse_framing" })
    ),
    true
  );
  assert.equal(
    shouldPersistSentinelReplay(
      internalObservation({ status: 200, completed: false, terminal_type: "response.incomplete", failure_kind: "gateway_timeout" }),
      clientObservation({ status: 200, completed: false, terminal_type: "response.incomplete", failure_kind: "gateway_timeout" })
    ),
    true
  );
  assert.equal(
    shouldPersistSentinelReplay(
      internalObservation({ status: 200, completed: false, terminal_type: "response.incomplete", failure_kind: "client_choice" }),
      clientObservation({ status: 200, completed: false, terminal_type: "response.incomplete", failure_kind: "client_choice" })
    ),
    false
  );
  // A client observation that itself carries the cancellation terminal cannot
  // make an otherwise successful request persistable.
  assert.equal(
    shouldPersistSentinelReplay(
      internalObservation({ status: 200, stream: false, terminal_type: null, failure_kind: null }),
      clientObservation({ status: 200, terminal_type: "cancelled", failure_kind: null })
    ),
    false
  );

  assert.equal(shouldSignalSentinelIncident(internalObservation({ terminal_type: "cancelled" }), clientObservation({ terminal_type: "cancelled" })), false);
  assert.equal(
    shouldSignalSentinelIncident(
      internalObservation({ status: 200, completed: false, terminal_type: "response.incomplete", failure_kind: null }),
      clientObservation({ stream: true, framing_valid: false })
    ),
    true
  );
  assert.equal(
    shouldSignalSentinelIncident(
      internalObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: null }),
      clientObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: null })
    ),
    false
  );
  assert.equal(shouldSignalSentinelIncident(internalObservation({ status: 503, terminal_type: "http.error" }), clientObservation({ status: 503 })), true);
  assert.equal(
    shouldSignalSentinelIncident(
      internalObservation({ status: 200, terminal_type: "response.incomplete", failure_kind: null }),
      clientObservation({ status: 200, failure_kind: "upstream_timeout" })
    ),
    true
  );
  // An incomplete response whose only cause is a client-side choice is not an
  // incident, while a gateway-side incomplete reason is.
  assert.equal(
    shouldSignalSentinelIncident(
      internalObservation({ status: 200, completed: false, terminal_type: "response.incomplete", failure_kind: null }),
      clientObservation({ status: 200, completed: false, terminal_type: "response.incomplete", failure_kind: null })
    ),
    false
  );
  assert.equal(
    shouldSignalSentinelIncident(
      internalObservation({ status: 200, completed: false, terminal_type: "response.incomplete", failure_kind: "response_incomplete:gateway_timeout" }),
      clientObservation({ status: 200, completed: false, terminal_type: "response.incomplete", failure_kind: null })
    ),
    true
  );
  assert.equal(
    shouldSignalSentinelIncident(
      internalObservation({ status: 200, terminal_type: "eof", failure_kind: null }),
      clientObservation({ status: 200, failure_kind: null })
    ),
    true
  );
  assert.equal(
    shouldSignalSentinelIncident(
      internalObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: "server_error" }),
      clientObservation({ status: 200, failure_kind: "server_error" })
    ),
    false
  );
  // A synthetic terminal, a specific transport cause or a deadline terminal is
  // always reportable.
  assert.equal(
    shouldSignalSentinelIncident(
      internalObservation({
        status: 200,
        completed: false,
        terminal_type: "response.completed",
        failure_kind: null,
        synthetic_terminal_type: "response.failed",
      }),
      clientObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: null })
    ),
    true
  );
  assert.equal(
    shouldSignalSentinelIncident(
      internalObservation({ status: 200, completed: false, terminal_type: "response.completed", failure_kind: "upstream_timeout" }),
      clientObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: null })
    ),
    true
  );
  assert.equal(
    shouldSignalSentinelIncident(
      internalObservation({ status: 200, terminal_type: "deadline", failure_kind: null }),
      clientObservation({ status: 200, failure_kind: null })
    ),
    true
  );
});
