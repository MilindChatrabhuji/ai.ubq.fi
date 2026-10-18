import { test } from "bun:test";
import { type Kv, type KvKey } from "#kv";
/**
 * Coverage tests for the Sentinel replay read/export surface.
 *
 * Every capture read here is either sealed through the real store or built with
 * the exact primitives the store uses (encodePlaintext, gzip, importAesKey,
 * splitChunks, hmacHex, fingerprintParts), so an accepted fixture is
 * byte-identical to what production writes and a rejected fixture differs only
 * in the field under test. Storage is the runtime's `:memory:` KV when
 * `--unstable-kv` is present, otherwise the CAS-faithful substitute in
 * tests/helpers/sentinel-kv-stub.ts; both satisfy the same contract.
 */

import assert from "node:assert/strict";
import { setKvForTest } from "../src/kv.ts";
import { base64UrlEncode } from "../src/utils.ts";
import {
  AES_GCM_IV_BYTES,
  ENVELOPE_VERSION,
  MAX_CAPTURE_ID_CHARS,
  MAX_REPLAY_CHUNKS,
  MAX_REPLAY_CIPHERTEXT_BYTES,
  SENTINEL_REPLAY_CHUNK_BYTES,
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_DEDUPE_PREFIX,
  SENTINEL_REPLAY_MANIFEST_PREFIX,
  SENTINEL_REPLAY_TTL_MS,
  type AcceptedSentinelReplayInput,
  type ExportedSentinelReplayCapture,
  type SentinelClientFailureObservation,
  type SentinelFailureObservation,
  type SentinelReplayManifest,
  type SentinelReplayUnavailableReason,
} from "../src/sentinel/replay-model.ts";
import {
  ciphertextDigest,
  downstreamObservation,
  encodePlaintext,
  encryptionAdditionalData,
  fingerprintParts,
  gzip,
  hmacHex,
  importAesKey,
  splitChunks,
  type ReplayMetadata,
} from "../src/sentinel/replay-envelope.ts";
import {
  decryptExportedSentinelReplay,
  getChunks,
  isExportedSentinelReplayCapture,
  isSentinelReplayManifest,
  listEncryptedSentinelIncidentReplays,
  listEncryptedSentinelReplays,
  listEncryptedSentinelReplaysByRequestId,
  manifestMatchesKey,
  readSentinelReplayCaptureStatus,
} from "../src/sentinel/replay-read.ts";
import { persistEncryptedSentinelReplay, persistSentinelReplayFromEnvironment } from "../src/sentinel/replay-store.ts";
import { sentinelFailureSignature } from "../src/sentinel/replay-observation.ts";
import { emptySentinelUpstreamTrace } from "../src/sentinel/upstream-capture.ts";
import {
  bindSentinelIncidentIndexEvidence,
  completeSentinelIncidentFailureEvent,
  createSentinelIncidentFailureEvent,
  isSentinelIncidentFailureEvent,
  readySentinelIncidentFailureEvent,
  linkSentinelReplayToIncident,
  recordSentinelIncidentIndexObservation,
  SENTINEL_INCIDENT_CAPTURE_REF_PREFIX,
  sentinelIncidentFingerprint,
} from "../src/sentinel/incident-outbox.ts";
import { openSentinelTestKv } from "./helpers/sentinel-kv-stub.ts";

const encoder = new TextEncoder();
const KEY_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array(32).fill(0x33);
const NOW = 1_800_000_000_000;
const GIT_SHA = "c".repeat(40);
const INCIDENT_UUID = "12345678-1234-4abc-8def-1234567890ab";
const SEALED_REQUEST_ID = "sealed-request";
const SEALED_ENDPOINT = "/v1/responses";
const SEALED_BODY = '{"model":"gpt-5","stream":true}';

const sealedIv = (): Uint8Array<ArrayBuffer> => new Uint8Array([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8]);

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
  endpoint: SEALED_ENDPOINT,
  method: "POST",
  body: encoder.encode(body) as Uint8Array<ArrayBuffer>,
  content_type: "application/json",
  compatibility_headers: {},
  request_id: requestId,
  git_sha: GIT_SHA,
  deno_revision: "sealed-revision",
});

/** Code-unit ordering with an explicit comparator: never the default alphabetical sort. */
const byCodeUnits = (left: string, right: string): number => left.localeCompare(right);

const closeKv = (kv: Kv): void => {
  try {
    kv.close();
  } catch {
    // Idempotent close for both the stub and a real in-memory KV.
  }
};

type SealedEnvelope = Readonly<{ manifest: SentinelReplayManifest; chunks: string[]; metadata: ReplayMetadata; body: Uint8Array<ArrayBuffer> }>;

/**
 * Seal one capture with the production primitives. `aadFingerprint` and
 * `mutateMetadata` are the two tampering seams: the ciphertext is sealed under
 * the given additional data (which is also what the manifest claims as its
 * fingerprint, so the bytes decrypt) while the plaintext carries metadata that
 * no longer reproduces that fingerprint, which is exactly the disagreement the
 * reader must detect.
 */
const sealEnvelope = async (
  options: Readonly<{
    body?: string;
    aadFingerprint?: string;
    mutateMetadata?: (metadata: ReplayMetadata) => ReplayMetadata;
  }> = {}
): Promise<SealedEnvelope> => {
  const body = encoder.encode(options.body ?? SEALED_BODY) as Uint8Array<ArrayBuffer>;
  const input = acceptedInput(options.body ?? SEALED_BODY, SEALED_REQUEST_ID);
  const observation = internalObservation();
  const client = clientObservation();
  const upstream = emptySentinelUpstreamTrace();
  const failureSignature = sentinelFailureSignature(client);
  const unavailable: readonly SentinelReplayUnavailableReason[] = [];
  const base: ReplayMetadata = {
    version: 3,
    captured_at_ms: NOW,
    endpoint: input.endpoint,
    method: input.method,
    content_type: input.content_type,
    compatibility_headers: input.compatibility_headers,
    failure_signature: failureSignature,
    observation,
    client_observation: client,
    request_id: input.request_id,
    git_sha: input.git_sha,
    deno_revision: input.deno_revision,
    upstream,
    settings: {
      source: "recorded_request_body",
      provider_route: observation.provider_route,
      model_requested: "gpt-5",
      reasoning_requested: null,
      stream_requested: true,
      stream_observed: true,
    },
    capture_status: "ready",
    replay_coverage: "full",
    unavailable,
    body_sha256: await ciphertextDigest(body),
    body_bytes: body.byteLength,
    downstream: downstreamObservation(client),
  };
  const metadata = options.mutateMetadata ? options.mutateMetadata(base) : base;
  const fingerprint = await hmacHex(KEY_BYTES, "fingerprint", fingerprintParts(input, failureSignature, "fingerprint", upstream));
  const caseGroupDigest = await hmacHex(KEY_BYTES, "case-group", fingerprintParts(input, failureSignature, "case-group"));
  const plaintext = encodePlaintext(metadata, body);
  const compressed = await gzip(plaintext);
  const iv = sealedIv();
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encryptionAdditionalData(options.aadFingerprint ?? fingerprint) },
      await importAesKey(KEY_BYTES),
      compressed
    )
  );
  const chunks = splitChunks(ciphertext);
  const manifest: SentinelReplayManifest = {
    version: ENVELOPE_VERSION,
    capture_id: "sealed-capture",
    fingerprint: options.aadFingerprint ?? fingerprint,
    case_group_digest: caseGroupDigest,
    captured_at_ms: NOW,
    expires_at_ms: NOW + SENTINEL_REPLAY_TTL_MS,
    algorithm: "AES-256-GCM",
    compression: "gzip",
    iv: base64UrlEncode(iv),
    chunk_count: chunks.length,
    ciphertext_bytes: ciphertext.byteLength,
  };
  return { manifest, chunks: chunks.map(base64UrlEncode), metadata, body };
};

/** Store a real capture through the store and return what it wrote. */
const storeCapture = async (kv: Kv, body: string, requestId: string, captureId: string, nowMs = NOW) => {
  const result = await persistEncryptedSentinelReplay(
    acceptedInput(body, requestId),
    internalObservation(),
    { kv, keyBytes: KEY_BYTES, now: () => nowMs, randomUuid: () => captureId, randomBytes: sealedIv },
    clientObservation()
  );
  // The assertion narrows the returned result to the stored variant.
  assert.equal(result.status, "stored");
  return result;
};

test("a real manifest is accepted and every out-of-contract field is rejected", async () => {
  const { manifest } = await sealEnvelope();
  assert.equal(isSentinelReplayManifest(manifest), true);

  const twelveByteIv = base64UrlEncode(new Uint8Array(AES_GCM_IV_BYTES));
  const variants: [string, unknown][] = [
    ["not an object", null],
    ["array", []],
    ["envelope version", { ...manifest, version: 2 }],
    ["empty capture id", { ...manifest, capture_id: "" }],
    ["over-long capture id", { ...manifest, capture_id: "a".repeat(MAX_CAPTURE_ID_CHARS + 1) }],
    ["non-url-safe capture id", { ...manifest, capture_id: "capture/1" }],
    ["non-hex fingerprint", { ...manifest, fingerprint: "z".repeat(64) }],
    ["short case group digest", { ...manifest, case_group_digest: "a".repeat(63) }],
    ["float captured_at_ms", { ...manifest, captured_at_ms: NOW + 0.5 }],
    ["negative captured_at_ms", { ...manifest, captured_at_ms: -1 }],
    ["expiry not derived from capture time", { ...manifest, expires_at_ms: NOW + SENTINEL_REPLAY_TTL_MS + 1 }],
    ["unknown algorithm", { ...manifest, algorithm: "AES-128-GCM" }],
    ["unknown compression", { ...manifest, compression: "deflate" }],
    ["missing iv", { ...manifest, iv: undefined }],
    ["short iv", { ...manifest, iv: base64UrlEncode(new Uint8Array(AES_GCM_IV_BYTES - 1)) }],
    ["over-long iv", { ...manifest, iv: base64UrlEncode(new Uint8Array(AES_GCM_IV_BYTES + 1)) }],
    ["non-base64 iv", { ...manifest, iv: "________!_______" }],
    ["zero chunk count", { ...manifest, chunk_count: 0 }],
    ["fractional chunk count", { ...manifest, chunk_count: 1.5 }],
    ["chunk count above the bound", { ...manifest, chunk_count: MAX_REPLAY_CHUNKS + 1 }],
    ["ciphertext below the AEAD tag", { ...manifest, ciphertext_bytes: 15 }],
    ["ciphertext above the bound", { ...manifest, ciphertext_bytes: MAX_REPLAY_CIPHERTEXT_BYTES + 1 }],
    ["ciphertext too small for its chunks", { ...manifest, chunk_count: 3, ciphertext_bytes: 2 * SENTINEL_REPLAY_CHUNK_BYTES }],
    ["ciphertext too large for its chunks", { ...manifest, chunk_count: 2, ciphertext_bytes: 2 * SENTINEL_REPLAY_CHUNK_BYTES + 1 }],
  ];
  for (const [label, candidate] of variants) {
    const untrusted: unknown = JSON.parse(JSON.stringify(candidate));
    assert.equal(isSentinelReplayManifest(untrusted), false, label);
  }
  // A one-chunk manifest spans the whole lower/upper chunk arithmetic.
  assert.equal(isSentinelReplayManifest({ ...manifest, chunk_count: 1, ciphertext_bytes: 16 }), true);
  assert.equal(isSentinelReplayManifest({ ...manifest, iv: twelveByteIv }), true);
  assert.equal(isSentinelReplayManifest({ ...manifest, iv: "A".repeat(20) }), false);
  assert.equal(isSentinelReplayManifest({ ...manifest, iv: "A".repeat(24) }), false);
});

test("an export is accepted exactly when its chunk payloads match the manifest", async () => {
  const sealed = await sealEnvelope();
  assert.equal(sealed.manifest.chunk_count, 1);
  assert.equal(isExportedSentinelReplayCapture({ manifest: sealed.manifest, chunks: sealed.chunks }), true);

  const variant: [string, unknown][] = [
    ["not an object", "sealed"],
    ["missing manifest", { chunks: sealed.chunks }],
    ["chunks not an array", { manifest: sealed.manifest, chunks: {} }],
    ["chunk count mismatch", { manifest: { ...sealed.manifest, chunk_count: 2 }, chunks: sealed.chunks }],
    ["non-string chunk", { manifest: sealed.manifest, chunks: [7] }],
    ["empty chunk", { manifest: sealed.manifest, chunks: [""] }],
    ["over-long chunk", { manifest: sealed.manifest, chunks: [`a${"A".repeat(Math.ceil(SENTINEL_REPLAY_CHUNK_BYTES / 3) * 4)}`] }],
    ["non-url-safe chunk", { manifest: sealed.manifest, chunks: ["has spaces"] }],
    ["chunk does not match the manifest size", { manifest: sealed.manifest, chunks: [base64UrlEncode(new Uint8Array(4))] }],
    [
      "fewer chunks than the manifest declares",
      {
        manifest: { ...sealed.manifest, chunk_count: 2, ciphertext_bytes: SENTINEL_REPLAY_CHUNK_BYTES + 16 },
        chunks: [base64UrlEncode(new Uint8Array(SENTINEL_REPLAY_CHUNK_BYTES + 16))],
      },
    ],
  ];
  for (const [label, candidate] of variant) {
    const untrusted: unknown = JSON.parse(JSON.stringify(candidate));
    assert.equal(isExportedSentinelReplayCapture(untrusted), false, label);
  }
  // Unpadded base64 whose decoded length is wrong for the manifest.
  assert.equal(
    isExportedSentinelReplayCapture({
      manifest: { ...sealed.manifest, chunk_count: 1, ciphertext_bytes: 16 },
      chunks: [base64UrlEncode(new Uint8Array(17))],
    }),
    false
  );
});

test("decryption returns the exact accepted request and rejects key, export and integrity faults", async () => {
  const sealed = await sealEnvelope();
  await assert.rejects(() => decryptExportedSentinelReplay(sealed, new Uint8Array(31)), /Sentinel replay key must be 32 bytes/);
  await assert.rejects(
    () => decryptExportedSentinelReplay({ manifest: sealed.manifest, chunks: ["not base64!"] }, KEY_BYTES),
    /Sentinel replay export is invalid/
  );

  const plaintext = await decryptExportedSentinelReplay(sealed, KEY_BYTES);
  assert.equal(plaintext.version, 3);
  assert.equal(plaintext.endpoint, SEALED_ENDPOINT);
  assert.equal(plaintext.method, "POST");
  assert.equal(plaintext.request_id, SEALED_REQUEST_ID);
  assert.equal(plaintext.captured_at_ms, NOW);
  assert.equal(plaintext.capture_status, "ready");
  assert.equal(plaintext.replay_coverage, "full");
  assert.deepEqual(plaintext.unavailable, []);
  assert.deepEqual([...plaintext.body], [...sealed.body]);
  assert.deepEqual(plaintext.upstream.attempts, []);
  assert.equal(plaintext.settings?.model_requested, "gpt-5");
  assert.equal(plaintext.downstream?.body_base64, btoa("upstream failed"));
  assert.equal(sentinelFailureSignature(plaintext.client_observation), plaintext.failure_signature);

  // A different key cannot decrypt the same envelope.
  await assert.rejects(() => decryptExportedSentinelReplay(sealed, new Uint8Array(32).fill(0x44)), /OperationError|Decryption failed|Unsupported|error/i);

  // Sealed under a fingerprint the plaintext does not reproduce: the bytes
  // decrypt, and the reader must still refuse them.
  const foreignAad = await sealEnvelope({ aadFingerprint: "a".repeat(64) });
  await assert.rejects(() => decryptExportedSentinelReplay(foreignAad, KEY_BYTES), /Sentinel replay manifest integrity check failed/);
  // A case-group digest that no longer matches its metadata.
  const mismatchedGroup = await sealEnvelope();
  await assert.rejects(
    () => decryptExportedSentinelReplay({ ...mismatchedGroup, manifest: { ...mismatchedGroup.manifest, case_group_digest: "b".repeat(64) } }, KEY_BYTES),
    /Sentinel replay manifest integrity check failed/
  );
  // A capture time that disagrees with the sealed metadata.
  const shiftedTime = await sealEnvelope({ mutateMetadata: (metadata) => ({ ...metadata, captured_at_ms: NOW + 5 }) });
  await assert.rejects(() => decryptExportedSentinelReplay(shiftedTime, KEY_BYTES), /Sentinel replay manifest integrity check failed/);
  // A failure signature that no longer matches the client observation.
  const orphanedSignature = await sealEnvelope({ mutateMetadata: (metadata) => ({ ...metadata, failure_signature: "{}" }) });
  await assert.rejects(() => decryptExportedSentinelReplay(orphanedSignature, KEY_BYTES), /Sentinel replay manifest integrity check failed/);
  // The request frames are integrity-protected too: a rewritten endpoint or
  // request body cannot be smuggled in under a valid manifest fingerprint.
  const rewrittenEndpoint = await sealEnvelope({ mutateMetadata: (metadata) => ({ ...metadata, endpoint: "/v1/chat/completions" }) });
  await assert.rejects(() => decryptExportedSentinelReplay(rewrittenEndpoint, KEY_BYTES), /Sentinel replay manifest integrity check failed/);
  const swappedBody = await sealEnvelope({ body: SEALED_BODY, mutateMetadata: (metadata) => ({ ...metadata, method: "PUT" }) });
  await assert.rejects(() => decryptExportedSentinelReplay(swappedBody, KEY_BYTES), /Sentinel replay manifest integrity check failed/);
});

test("chunk reads are paged, size-checked and fail closed on missing storage", async () => {
  const kv = await openSentinelTestKv();
  try {
    const stored = await storeCapture(kv, SEALED_BODY, "chunk-request", "capture-chunks");
    const chunks = await getChunks(kv, stored.manifest);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.byteLength, stored.manifest.ciphertext_bytes);
    const storedChunk = await kv.get<Uint8Array>([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-chunks", 0]);
    assert.deepEqual([...(chunks[0] ?? new Uint8Array())], [...(storedChunk.value ?? new Uint8Array())]);

    await kv.set([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-chunks", 0], new Uint8Array(4));
    await assert.rejects(() => getChunks(kv, stored.manifest), /Sentinel replay chunk size does not match its manifest/);

    await kv.delete([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-chunks", 0]);
    await assert.rejects(() => getChunks(kv, stored.manifest), /Sentinel replay chunk is missing/);

    // Eleven chunks exercise the ten-key batch boundary and the exact tail size.
    const tailBytes = 1;
    const pageManifest: SentinelReplayManifest = {
      ...stored.manifest,
      capture_id: "capture-paged",
      chunk_count: 11,
      ciphertext_bytes: 10 * SENTINEL_REPLAY_CHUNK_BYTES + tailBytes,
    };
    for (let index = 0; index < 10; index += 1) {
      await kv.set([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-paged", index], new Uint8Array(SENTINEL_REPLAY_CHUNK_BYTES).fill(index));
    }
    await kv.set([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-paged", 10], new Uint8Array(tailBytes).fill(0xab));
    const paged = await getChunks(kv, pageManifest);
    assert.equal(paged.length, 11);
    assert.equal(paged[9]?.byteLength, SENTINEL_REPLAY_CHUNK_BYTES);
    assert.equal(paged[10]?.byteLength, tailBytes);
    assert.equal(paged[10]?.[0], 0xab);
    // A missing tail chunk in the second batch is still reported.
    await kv.delete([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-paged", 10]);
    await assert.rejects(() => getChunks(kv, pageManifest), /Sentinel replay chunk is missing/);

    assert.equal(manifestMatchesKey([...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, stored.manifest.fingerprint, "capture-chunks"], stored.manifest), true);
    assert.equal(manifestMatchesKey(["wrong", "prefix"], stored.manifest), false);
    assert.equal(manifestMatchesKey([...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW], stored.manifest), false);
    assert.equal(manifestMatchesKey([...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW + 1, stored.manifest.fingerprint, "capture-chunks"], stored.manifest), false);
    assert.equal(manifestMatchesKey([...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, "0".repeat(64), "capture-chunks"], stored.manifest), false);
  } finally {
    closeKv(kv);
  }
});

test("the time-range export validates its window, pages by cursor and refuses corrupt manifests", async () => {
  const kv = await openSentinelTestKv();
  const window = { afterMs: 0, beforeMs: NOW + 10_000 };
  try {
    for (const afterMs of [-1, 1.5]) {
      await assert.rejects(() => listEncryptedSentinelReplays(kv, { ...window, afterMs }), /Sentinel replay export start is invalid/);
    }
    for (const beforeMs of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(() => listEncryptedSentinelReplays(kv, { ...window, beforeMs }), /Sentinel replay export end is invalid/);
    }
    await assert.rejects(() => listEncryptedSentinelReplays(kv, { ...window, limit: 2 }), /Sentinel replay export limit must be one/);
    for (const cursor of ["", "a".repeat(2_049), "has spaces"]) {
      await assert.rejects(() => listEncryptedSentinelReplays(kv, { ...window, cursor }), /Sentinel replay export cursor is invalid/);
    }
    assert.deepEqual(await listEncryptedSentinelReplays(kv, window), { captures: [], cursor: "" });

    const first = await storeCapture(kv, SEALED_BODY, "range-request-1", "capture-range-1", NOW);
    const second = await storeCapture(kv, '{"model":"gpt-5","stream":false}', "range-request-2", "capture-range-2", NOW + 1_000);

    const pageOne = await listEncryptedSentinelReplays(kv, window);
    assert.equal(pageOne.captures.length, 1);
    assert.equal(pageOne.captures[0]?.manifest.captured_at_ms, NOW);
    assert.notEqual(pageOne.cursor, "");
    const pageTwo = await listEncryptedSentinelReplays(kv, { ...window, cursor: pageOne.cursor });
    assert.equal(pageTwo.captures.length, 1);
    assert.equal(pageTwo.captures[0]?.manifest.captured_at_ms, NOW + 1_000);
    assert.deepEqual(await listEncryptedSentinelReplays(kv, { ...window, cursor: pageTwo.cursor }).then((page) => page.captures), []);
    // A window that ends before the first capture exhausts the range instead
    // of handing out a cursor that would rescan it forever.
    assert.deepEqual(await listEncryptedSentinelReplays(kv, { afterMs: 0, beforeMs: NOW - 1 }), { captures: [], cursor: "" });

    // The exported chunk text is the stored ciphertext, and it decrypts.
    const exported = pageOne.captures[0];
    assert.ok(exported);
    assert.equal(exported.chunks.length, first.manifest.chunk_count);
    const plaintext = await decryptExportedSentinelReplay(exported, KEY_BYTES);
    assert.equal(plaintext.request_id, "range-request-1");

    // A manifest-shaped value under a manifest key is still rejected when it
    // disagrees with the key it was stored under.
    await kv.set([...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW + 7, second.manifest.fingerprint, "capture-range-2"], second.manifest);
    await assert.rejects(() => listEncryptedSentinelReplays(kv, { afterMs: NOW + 5, beforeMs: NOW + 10_000 }), /Sentinel replay manifest is invalid/);
    await kv.delete([...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW + 7, second.manifest.fingerprint, "capture-range-2"]);
    await kv.set([...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW + 1_000, second.manifest.fingerprint, "capture-range-2"], { version: 2 });
    await assert.rejects(() => listEncryptedSentinelReplays(kv, { afterMs: NOW + 500, beforeMs: NOW + 10_000 }), /Sentinel replay manifest is invalid/);
    await kv.set([...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW + 1_000, second.manifest.fingerprint, "capture-range-2"], second.manifest);
    await kv.delete([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-range-2", 0]);
    await assert.rejects(() => listEncryptedSentinelReplays(kv, { afterMs: NOW + 500, beforeMs: NOW + 10_000 }), /Sentinel replay chunk is missing/);
  } finally {
    closeKv(kv);
  }
});

test("the incident export validates ids and references and refuses unavailable evidence", async () => {
  const kv = await openSentinelTestKv();
  const incidentId = `provider-${INCIDENT_UUID}`;
  try {
    await assert.rejects(() => listEncryptedSentinelIncidentReplays(kv, { incidentId: "provider-nope" }), /Sentinel incident ID is invalid/);
    await assert.rejects(() => listEncryptedSentinelIncidentReplays(kv, { incidentId, limit: 2 }), /Sentinel replay export limit must be one/);
    for (const cursor of ["", "a".repeat(2_049), "has spaces"]) {
      await assert.rejects(() => listEncryptedSentinelIncidentReplays(kv, { incidentId, cursor }), /Sentinel replay export cursor is invalid/);
    }
    assert.deepEqual(await listEncryptedSentinelIncidentReplays(kv, { incidentId }), { captures: [], cursor: "" });

    const stored = await storeCapture(kv, SEALED_BODY, "incident-request", "capture-incident");
    assert.ok(stored.manifest_key);

    // A reference record that cannot describe a capture is never skipped.
    const invalidValues: [string, unknown][] = [
      ["wrong version", { version: 2, manifest_key: stored.manifest_key }],
      ["short manifest key", { version: 1, manifest_key: [NOW] }],
    ];
    for (const [label, value] of invalidValues) {
      const key = [...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, incidentId, "2".repeat(64)];
      await kv.set(key, value);
      await assert.rejects(() => listEncryptedSentinelIncidentReplays(kv, { incidentId }), /Sentinel incident replay reference is invalid/, label);
      await kv.delete(key);
    }
    const overLongKey = [...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, incidentId, "3".repeat(64), "extra"];
    await kv.set(overLongKey, { version: 1, manifest_key: stored.manifest_key });
    await assert.rejects(() => listEncryptedSentinelIncidentReplays(kv, { incidentId }), /Sentinel incident replay reference is invalid/);
    await kv.delete(overLongKey);
    const nonHexKey = [...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, incidentId, "not-hex"];
    await kv.set(nonHexKey, { version: 1, manifest_key: stored.manifest_key });
    await assert.rejects(() => listEncryptedSentinelIncidentReplays(kv, { incidentId }), /Sentinel incident replay reference is invalid/);
    await kv.delete(nonHexKey);

    await linkSentinelReplayToIncident(kv, incidentId, stored.manifest.fingerprint, stored.manifest_key);
    const listed = await listEncryptedSentinelIncidentReplays(kv, { incidentId });
    assert.equal(listed.captures.length, 1);
    assert.equal(listed.captures[0]?.manifest.fingerprint, stored.manifest.fingerprint);
    assert.equal((await decryptExportedSentinelReplay(listed.captures[0] as ExportedSentinelReplayCapture, KEY_BYTES)).request_id, "incident-request");

    // A reference that points at no manifest names a payload the store no
    // longer holds (evicted, expired, or written without a TTL by an older
    // revision). It is skipped and removed, and the same page still returns
    // the next live capture instead of a fault. The all-zero fingerprint
    // sorts before every real HMAC fingerprint, so the skip path runs first.
    const danglingFingerprint = "0".repeat(64);
    assert.notEqual(stored.manifest.fingerprint, danglingFingerprint);
    const danglingRefKey = [...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, incidentId, danglingFingerprint];
    await kv.set(danglingRefKey, { version: 1, manifest_key: [...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, danglingFingerprint, "capture-dangling"] });
    const firstPage = await listEncryptedSentinelIncidentReplays(kv, { incidentId });
    assert.equal(firstPage.captures.length, 1);
    assert.equal(firstPage.captures[0]?.manifest.fingerprint, stored.manifest.fingerprint);
    assert.notEqual(firstPage.cursor, "");
    assert.equal((await kv.get(danglingRefKey)).value, null);
    assert.deepEqual(await listEncryptedSentinelIncidentReplays(kv, { incidentId, cursor: firstPage.cursor }), { captures: [], cursor: "" });

    // A reference whose manifest exists but is not its own is still a fault.
    await kv.delete([...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, incidentId, stored.manifest.fingerprint]);
    await kv.set(danglingRefKey, {
      version: 1,
      manifest_key: [...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, stored.manifest.fingerprint, "capture-incident"],
    });
    await assert.rejects(() => listEncryptedSentinelIncidentReplays(kv, { incidentId }), /Sentinel incident replay manifest is unavailable/);
    await kv.delete(danglingRefKey);
  } finally {
    closeKv(kv);
  }
});

test("a request id resolves to its capture, to nothing, or to an explicit expiry", async () => {
  const kv = await openSentinelTestKv();
  try {
    const unknown = await listEncryptedSentinelReplaysByRequestId(kv, "never-captured-request");
    assert.deepEqual(unknown.captures, []);
    assert.equal(unknown.status.status, "unknown");
    assert.equal(unknown.status.reason, "no_capture_record");

    // A request that was refused before capture keeps its own status and has
    // no manifest to export.
    await kv.set([...["uos_ai", "sentinel_replay", "v1", "request"], "disabled-request"], {
      version: 1,
      request_id: "disabled-request",
      status: "disabled",
      reason: "key_missing",
      captured_at_ms: NOW,
      manifest_key: null,
      fingerprint: null,
      expires_at_ms: null,
    });
    const disabled = await listEncryptedSentinelReplaysByRequestId(kv, "disabled-request");
    assert.deepEqual(disabled.captures, []);
    assert.equal(disabled.status.status, "disabled");

    const stored = await storeCapture(kv, SEALED_BODY, "by-request-id", "capture-by-request");
    const resolved = await listEncryptedSentinelReplaysByRequestId(kv, "by-request-id");
    assert.equal(resolved.captures.length, 1);
    assert.equal(resolved.status.status, "incomplete");
    assert.equal((await decryptExportedSentinelReplay(resolved.captures[0] as ExportedSentinelReplayCapture, KEY_BYTES)).request_id, "by-request-id");

    // A status row whose manifest is gone is reported as expired, with the
    // reason that says why, never as an empty successful history.
    assert.ok(stored.manifest_key);
    await kv.delete(stored.manifest_key);
    const missingManifest = await listEncryptedSentinelReplaysByRequestId(kv, "by-request-id");
    assert.deepEqual(missingManifest.captures, []);
    assert.equal(missingManifest.status.status, "expired");
    assert.equal(missingManifest.status.reason, "manifest_unavailable");

    await kv.set(stored.manifest_key, stored.manifest);
    await kv.set([...["uos_ai", "sentinel_replay", "v1", "request"], "mismatched-request"], {
      version: 1,
      request_id: "mismatched-request",
      status: "ready",
      reason: null,
      captured_at_ms: NOW,
      manifest_key: stored.manifest_key,
      fingerprint: "5".repeat(64),
      expires_at_ms: NOW + SENTINEL_REPLAY_TTL_MS,
    });
    const mismatched = await listEncryptedSentinelReplaysByRequestId(kv, "mismatched-request");
    assert.deepEqual(mismatched.captures, []);
    assert.equal(mismatched.status.status, "expired");
    assert.equal(mismatched.status.fingerprint, "5".repeat(64));
    await assert.rejects(() => listEncryptedSentinelReplaysByRequestId(kv, "bad request id"), /Sentinel replay request ID is invalid/);
    assert.equal((await readSentinelReplayCaptureStatus(kv, "by-request-id")).status, "incomplete");
  } finally {
    closeKv(kv);
  }
});

test("a duplicate pointing at unavailable evidence fails closed instead of claiming a capture", async () => {
  const kv = await openSentinelTestKv();
  const client = clientObservation();
  try {
    const input = acceptedInput(SEALED_BODY, "ghost-request");
    const first = await storeCapture(kv, SEALED_BODY, "ghost-request", "capture-ghost");
    assert.ok(first.manifest_key);
    const indexFingerprint = await sentinelIncidentFingerprint({ endpoint: input.endpoint, method: input.method, observation: client });
    const seededIndex = await recordSentinelIncidentIndexObservation(
      kv,
      {
        endpoint: input.endpoint,
        method: input.method,
        gitSha: GIT_SHA,
        observedAtMs: NOW,
        observation: client,
      },
      { randomUuid: () => INCIDENT_UUID }
    );
    // The group fingerprint the duplicate path resolves is the seeded row's.
    assert.equal(seededIndex.key.at(-1), indexFingerprint);
    const dedupeKey = [...SENTINEL_REPLAY_DEDUPE_PREFIX, first.manifest.fingerprint];

    // 1. The dedupe winner's manifest is gone.
    await kv.set(dedupeKey, { manifest_key: first.manifest_key });
    await kv.delete(first.manifest_key);
    await assert.rejects(
      () =>
        persistEncryptedSentinelReplay({ ...input, request_id: "ghost-request-1" }, internalObservation(), { kv, keyBytes: KEY_BYTES, now: () => NOW }, client),
      /Sentinel incident replay manifest is unavailable/
    );

    // 2. The winning manifest record exists but is not a manifest.
    await kv.set(first.manifest_key, { version: 2 });
    await assert.rejects(
      () =>
        persistEncryptedSentinelReplay({ ...input, request_id: "ghost-request-2" }, internalObservation(), { kv, keyBytes: KEY_BYTES, now: () => NOW }, client),
      /Sentinel incident replay manifest is unavailable/
    );

    // 3. The record is a real manifest, just not the one the dedupe row claims.
    const other = await storeCapture(kv, '{"model":"other"}', "other-request", "capture-other");
    assert.ok(other.manifest_key);
    await kv.delete(first.manifest_key);
    await kv.set(dedupeKey, { manifest_key: other.manifest_key });
    await assert.rejects(
      () =>
        persistEncryptedSentinelReplay({ ...input, request_id: "ghost-request-3" }, internalObservation(), { kv, keyBytes: KEY_BYTES, now: () => NOW }, client),
      /Sentinel incident replay manifest is unavailable/
    );
    assert.equal((await kv.get([...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, `provider-${INCIDENT_UUID}`, first.manifest.fingerprint])).value, null);
  } finally {
    closeKv(kv);
  }
});

test("a capture that cannot be named, and an outbox event that lost its race, are both rejected", async () => {
  const kv = await openSentinelTestKv();
  try {
    // The per-request status row is part of the capture contract: a request
    // id that cannot be published aborts the store instead of writing a
    // capture nothing can find.
    await assert.rejects(
      () =>
        persistEncryptedSentinelReplay(acceptedInput(SEALED_BODY, "bad request id"), internalObservation(), {
          kv,
          keyBytes: KEY_BYTES,
          now: () => NOW,
          randomUuid: () => "capture-unnamed",
          randomBytes: sealedIv,
        }),
      /Sentinel replay capture status is invalid/
    );
    assert.equal((await kv.get([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-unnamed", 0])).value, null);
    const manifestKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_MANIFEST_PREFIX })) manifestKeys.push([...entry.key]);
    assert.deepEqual(manifestKeys, []);

    // An incident event whose recorded versionstamp was replaced can never be
    // completed, and the store reports the conflict instead of pretending.
    const event = await createSentinelIncidentFailureEvent(kv, NOW, { randomUuid: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    await kv.set(event.key, event.value);
    const input = acceptedInput(SEALED_BODY, "stale-event-request");
    const stored = await persistEncryptedSentinelReplay(
      input,
      internalObservation(),
      {
        kv,
        keyBytes: KEY_BYTES,
        now: () => NOW,
        randomUuid: () => "capture-stale-event",
        randomBytes: sealedIv,
      },
      clientObservation()
    );
    assert.equal(stored.status, "stored");
    await assert.rejects(
      () =>
        persistEncryptedSentinelReplay(
          { ...input, request_id: "stale-event-request-2" },
          internalObservation(),
          { kv, keyBytes: KEY_BYTES, now: () => NOW, incidentEvent: event },
          clientObservation()
        ),
      /Sentinel incident capture completion conflicted/
    );
    assert.deepEqual(await completeSentinelIncidentFailureEvent(kv, event, NOW + 1, { status: "unavailable" }), false);
  } finally {
    closeKv(kv);
  }
});

test("an observation the index cannot classify still stores its capture without index evidence", async () => {
  const kv = await openSentinelTestKv();
  const client = clientObservation({ status: 700 });
  try {
    const stored = await persistEncryptedSentinelReplay(
      acceptedInput(SEALED_BODY, "unclassifiable-request"),
      internalObservation({ status: 700 }),
      { kv, keyBytes: KEY_BYTES, now: () => NOW, randomUuid: () => "capture-unclassified", randomBytes: sealedIv },
      client
    );
    assert.equal(stored.status, "stored");
    assert.equal(stored.manifest.capture_id, "capture-unclassified");
    const indexKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: [...["uos_ai", "sentinel_incident", "v1", "index"]] })) indexKeys.push([...entry.key]);
    assert.deepEqual(indexKeys, []);
    const resolved = await listEncryptedSentinelReplaysByRequestId(kv, "unclassifiable-request");
    assert.equal(resolved.captures.length, 1);
  } finally {
    closeKv(kv);
  }
});

test("two identical requests racing the dedupe check settle to one capture and one duplicate", async () => {
  const kv = await openSentinelTestKv();
  const client = clientObservation();
  try {
    const input = acceptedInput(SEALED_BODY, "race-request-a");
    const [left, right] = await Promise.all([
      persistEncryptedSentinelReplay(
        input,
        internalObservation(),
        { kv, keyBytes: KEY_BYTES, now: () => NOW, randomUuid: () => "capture-race-a", randomBytes: sealedIv },
        client
      ),
      persistEncryptedSentinelReplay(
        { ...input, request_id: "race-request-b" },
        internalObservation(),
        { kv, keyBytes: KEY_BYTES, now: () => NOW, randomUuid: () => "capture-race-b", randomBytes: sealedIv },
        client
      ),
    ]);
    assert.deepEqual([left.status, right.status].sort(byCodeUnits), ["duplicate", "stored"]);
    const loser = left.status === "duplicate" ? left : right;
    const winner = left.status === "stored" ? left : right;
    // These assertions both document the outcome and narrow the two results.
    assert.equal(loser.status, "duplicate");
    assert.equal(winner.status, "stored");
    assert.equal(loser.fingerprint, winner.manifest.fingerprint);
    assert.deepEqual(loser.manifest_key, winner.manifest_key);

    // Exactly one manifest and one chunk set survived the race.
    const manifestKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_MANIFEST_PREFIX })) manifestKeys.push([...entry.key]);
    assert.equal(manifestKeys.length, 1);
    assert.deepEqual(manifestKeys[0], [...(winner.manifest_key ?? [])]);
    const chunkKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_CHUNK_PREFIX })) chunkKeys.push([...entry.key]);
    assert.equal(chunkKeys.length, winner.manifest.chunk_count);
    assert.deepEqual(
      chunkKeys.map((key) => key.at(-2)),
      chunkKeys.map(() => winner.manifest.capture_id)
    );

    // Both requests resolve to that one capture.
    for (const requestId of ["race-request-a", "race-request-b"]) {
      const resolved = await listEncryptedSentinelReplaysByRequestId(kv, requestId);
      assert.equal(resolved.captures.length, 1);
      assert.equal(resolved.status.fingerprint, winner.manifest.fingerprint);
    }
  } finally {
    closeKv(kv);
  }
});

test("incident failure events reject every out-of-contract shape and completion", async () => {
  const kv = await openSentinelTestKv();
  const incidentId = `provider-${INCIDENT_UUID}`;
  const capturing = {
    version: 1,
    incident_id: incidentId,
    state: "capturing",
    observed_at_ms: NOW,
    created_at_ms: NOW,
    ready_at_ms: null,
    capture_status: "pending",
    capture_fingerprint: null,
    manifest_key: null,
  };
  try {
    assert.equal(isSentinelIncidentFailureEvent(capturing), true);
    const variants: [string, unknown][] = [
      ["not a record", "event"],
      ["wrong version", { ...capturing, version: 2 }],
      ["invalid incident id", { ...capturing, incident_id: "provider-nope" }],
      ["zero observation time", { ...capturing, observed_at_ms: 0 }],
      ["fractional observation time", { ...capturing, observed_at_ms: 1.5 }],
      ["creation before observation", { ...capturing, created_at_ms: NOW - 1 }],
      ["non-null ready time while capturing", { ...capturing, ready_at_ms: NOW }],
      ["non-hex capture fingerprint", { ...capturing, capture_fingerprint: "not-hex" }],
      ["short manifest key", { ...capturing, manifest_key: ["short"] }],
      ["unknown state", { ...capturing, state: "finished" }],
      ["ready without ready time", { ...capturing, state: "ready", capture_status: "unavailable" }],
      ["ready before creation", { ...capturing, state: "ready", ready_at_ms: NOW - 1, capture_status: "unavailable" }],
      [
        "unavailable with a fingerprint",
        { ...capturing, state: "ready", ready_at_ms: NOW, capture_status: "unavailable", capture_fingerprint: "a".repeat(64) },
      ],
      ["stored without evidence", { ...capturing, state: "ready", ready_at_ms: NOW, capture_status: "stored" }],
    ];
    for (const [label, candidate] of variants) {
      const untrusted: unknown = JSON.parse(JSON.stringify(candidate));
      assert.equal(isSentinelIncidentFailureEvent(untrusted), false, label);
    }

    // A completion whose evidence cannot describe a capture is refused
    // rather than written as a ready event.
    const event = await createSentinelIncidentFailureEvent(kv, NOW, { randomUuid: () => INCIDENT_UUID });
    const badCompletion: unknown = JSON.parse(JSON.stringify({ status: "stored", fingerprint: "not-hex", manifestKey: ["short"] }));
    assert.throws(
      () => readySentinelIncidentFailureEvent(event, NOW + 1, badCompletion as Parameters<typeof readySentinelIncidentFailureEvent>[2]),
      /Sentinel incident capture completion is invalid/
    );

    // The same bound applies to the evidence a capture may claim: a capture
    // id that cannot be a bounded opaque reference never reaches storage.
    const observation = { status: 502, stream: false, completed: false, framing_valid: true, terminal_type: "http.error" };
    const row = await recordSentinelIncidentIndexObservation(
      kv,
      {
        endpoint: "/v1/responses",
        method: "POST",
        gitSha: GIT_SHA,
        observedAtMs: NOW,
        observation,
      },
      { randomUuid: () => INCIDENT_UUID }
    );
    await assert.rejects(
      () =>
        bindSentinelIncidentIndexEvidence(kv, row.value.fingerprint, {
          observedAtMs: NOW,
          captureId: "capture with spaces",
          gitSha: GIT_SHA,
          referenceFingerprint: "9".repeat(64),
          manifestKey: [...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, "9".repeat(64), "capture-bad-id"],
          manifestVersionstamp: null,
          capturedAtMs: NOW,
          digest: "9".repeat(64),
          expiresAtMs: NOW + SENTINEL_REPLAY_TTL_MS,
        }),
      /Sentinel incident index evidence is invalid/
    );
    assert.equal((await kv.get([...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, incidentId, "9".repeat(64)])).value, null);
  } finally {
    closeKv(kv);
  }
});

test("a status row write failure never replaces the reported persist outcome", async () => {
  const kv = await openSentinelTestKv();
  const unwritableKv = new Proxy(kv, {
    get(target, property) {
      if (property === "set") return () => Promise.reject(new Error("status storage unavailable"));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    setKvForTest(unwritableKv);
    const input = acceptedInput(SEALED_BODY, "unwritable-status-request");
    const result = await persistSentinelReplayFromEnvironment(input, internalObservation(), clientObservation());
    assert.deepEqual(result, { status: "disabled", reason: "key_missing" });
    assert.deepEqual([...input.body], new Array(input.body.byteLength).fill(0));
  } finally {
    setKvForTest(null);
    closeKv(kv);
  }
});
