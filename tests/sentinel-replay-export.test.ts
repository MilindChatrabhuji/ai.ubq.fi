import { test } from "bun:test";
import { openKv, type Kv } from "#kv";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { setKvForTest } from "../src/kv.ts";
import { OPENROUTER_CHAT_COMPLETIONS_URL } from "../src/provider/openrouter.ts";
import {
  type AcceptedSentinelReplayInput,
  decryptExportedSentinelReplay,
  type ExportedSentinelReplayCapture,
  persistEncryptedSentinelReplay,
  type SentinelFailureObservation,
} from "../src/sentinel/replay-capture.ts";
import { handleAdminSentinelReplayCaptures } from "../src/sentinel/replay-admin.ts";
import {
  createSentinelUpstreamRecorder,
  SENTINEL_UPSTREAM_MAX_BYTES,
  SENTINEL_UPSTREAM_MAX_CHUNKS,
  type SentinelUpstreamProvider,
  type SentinelUpstreamTrace,
} from "../src/sentinel/upstream-capture.ts";
import { PASSKEY_RELAY_COOKIE_NAME, passkeyHandleKey, passkeySessionKey, passkeyUserKey } from "../src/auth/passkeys.ts";
import { linkSentinelReplayToIncident } from "../src/sentinel/incident-outbox.ts";
import type { SentinelClientFailureObservation } from "../src/sentinel/replay-model.ts";
import { createRecordedUpstreamReplay } from "./helpers/sentinel-recorded-upstream.ts";

const { default: handler } = await import("../src/handler/index.ts");

const SUPER_ADMIN_TOKEN = "sentinel-replay-export-super-admin-token";
const INCIDENT_ID = "provider-12345678-1234-4abc-8def-1234567890ab";

const encoder = new TextEncoder();

const failureObservation = (): SentinelFailureObservation => ({
  status: 502,
  stream: false,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  synthetic_terminal_type: null,
  provider_route: "test-provider",
});

const syntheticInput = (bytes: Uint8Array<ArrayBuffer>, requestId: string): AcceptedSentinelReplayInput => ({
  endpoint: "/v1/responses",
  method: "POST",
  body: bytes,
  content_type: "application/json",
  compatibility_headers: {},
  request_id: requestId,
  git_sha: "synthetic-git-sha",
  deno_revision: "synthetic-revision",
});

const twelveByteIv = (): Uint8Array<ArrayBuffer> => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

/** Records upstream bytes through the real recorder and seals the trace. */
const recordUpstreamTrace = async (bytes: Uint8Array<ArrayBuffer>, chunkBytes: number): Promise<SentinelUpstreamTrace> => {
  const recorder = createSentinelUpstreamRecorder();
  const source = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          controller.enqueue(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength)));
        }
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  const wrapped = recorder.startAttempt("cerebras").wrap(new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } }));
  await wrapped.arrayBuffer();
  const trace = recorder.snapshotAndSeal();
  recorder.dispose();
  return trace;
};

/** One 64 KiB recorder chunk: the shape every large bound case is assembled from. */
const UPSTREAM_CHUNK_BYTES = 64 * 1_024;

/**
 * Distinct exact HTTPS endpoints, one per provider enum, for the trusted
 * recorded-upstream replay transport. Nothing here is contacted: the transport
 * only matches the recorded provider route and serves the recorded chunks.
 */
const REPLAY_ROUTES: Readonly<Record<SentinelUpstreamProvider, string>> = Object.freeze({
  chatgpt_codex: "https://recorded-upstream.invalid/codex/responses",
  claude_code: "https://recorded-upstream.invalid/anthropic/v1/messages",
  surplus: "https://recorded-upstream.invalid/surplus/v1/responses",
  metered: "https://recorded-upstream.invalid/metered/v1/responses",
  cerebras: "https://recorded-upstream.invalid/cerebras/v1/chat/completions",
  deepseek: "https://recorded-upstream.invalid/deepseek/v1/chat/completions",
  lithos: "https://recorded-upstream.invalid/lithos/v1/chat/completions",
  openrouter: OPENROUTER_CHAT_COMPLETIONS_URL,
});

/** Deterministic synthetic bytes: the value at every offset is its position modulo 251. */
const patternedBytes = (byteLength: number): Uint8Array<ArrayBuffer> => {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) bytes[index] = index % 251;
  return bytes;
};

/** A client-visible failure observation whose downstream terminal body was retained. */
const retainedBodyObservation = (): SentinelClientFailureObservation => ({
  status: 502,
  stream: false,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  framing_valid: true,
  provider_route: "test-provider",
  error_code: null,
  error_param: null,
  terminal_body_base64: btoa("upstream timed out"),
  terminal_body_truncated: false,
});

/**
 * Bounded byte comparison: a mismatch reports its first offset and the two
 * lengths, never a multi-megabyte array spread through an assertion diagnostic.
 */
const firstDifferingOffset = (actual: Uint8Array, expected: Uint8Array): number | null => {
  const shared = Math.min(actual.byteLength, expected.byteLength);
  for (let index = 0; index < shared; index += 1) {
    if (actual[index] !== expected[index]) return index;
  }
  return actual.byteLength === expected.byteLength ? null : shared;
};

const assertBytesEqual = (actual: Uint8Array, expected: Uint8Array, label: string): void => {
  assert.equal(actual.byteLength, expected.byteLength, `${label}: byte length`);
  assert.equal(firstDifferingOffset(actual, expected), null, `${label}: first differing offset`);
};

/** Decode one recorded chunk's canonical padded base64 without materializing the whole trace. */
const decodeStandardBase64 = (encoded: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(encoded);
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/**
 * Replay a decrypted trace through the trusted recorded-upstream transport and
 * require every original byte to arrive at its exact recorded chunk boundary:
 * a merged, split, reordered, substituted or missing chunk fails this check.
 */
const assertReplayedUpstream = async (trace: SentinelUpstreamTrace, expected: Uint8Array<ArrayBuffer>, label: string): Promise<void> => {
  const replay = createRecordedUpstreamReplay(trace, REPLAY_ROUTES);
  const provider = trace.attempts[0]?.provider;
  assert.ok(provider, `${label}: the trace must carry the replayed attempt`);
  const response = await replay.fetch(REPLAY_ROUTES[provider]);
  assert.equal(response.status, 200, `${label}: replayed status`);
  assert.equal(response.headers.get("content-type"), "text/event-stream", `${label}: replayed content type`);
  const reader = response.body?.getReader();
  assert.ok(reader, `${label}: the replay must expose a body stream`);
  let offset = 0;
  for (;;) {
    const { done, value }: { done?: boolean; value?: Uint8Array<ArrayBuffer> } = await reader.read();
    if (done) break;
    assert.ok(value);
    const expectedLength = Math.min(UPSTREAM_CHUNK_BYTES, expected.byteLength - offset);
    assert.equal(value.byteLength, expectedLength, `${label}: replayed boundary at ${offset}`);
    assertBytesEqual(value, expected.subarray(offset, offset + expectedLength), `${label}: replayed bytes at ${offset}`);
    offset += value.byteLength;
  }
  assert.equal(offset, expected.byteLength, `${label}: every recorded byte must be replayed`);
  replay.assertComplete();
  const snapshot = replay.snapshot();
  assert.equal(snapshot.failed, false, `${label}: replay failure`);
  assert.equal(snapshot.chunksConsumed, snapshot.chunksTotal, `${label}: every recorded chunk consumed`);
  assert.equal(snapshot.chunksTotal, Math.ceil(expected.byteLength / UPSTREAM_CHUNK_BYTES), `${label}: recorded chunk count`);
};

const expectStored = (result: Awaited<ReturnType<typeof persistEncryptedSentinelReplay>>) => {
  assert.equal(result.status, "stored");

  return result;
};

const superAdminHeaders = { Authorization: `Bearer ${SUPER_ADMIN_TOKEN}` };

const exportUrl = (params: Record<string, string>): string => `https://ai.ubq.fi/admin/sentinel/replay-captures?${new URLSearchParams(params).toString()}`;

/**
 * Code-unit ascending string order: exactly what an argument-less
 * `Array.prototype.sort()` does for strings, stated explicitly so these
 * order-insensitive comparisons keep their byte-identical ordering.
 */
const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

/** The first exported capture, which every one of these assertions expects. */
const firstCapture = (body: { data: ExportedSentinelReplayCapture[] }): ExportedSentinelReplayCapture => {
  const capture = body.data[0];
  assert.ok(capture, "the export must return at least one capture");
  return capture;
};

/** Simulates an unavailable KV binding, without touching the filesystem. */
const runWithoutKv = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    setKvForTest(null);
    return await fn();
  } finally {
    setKvForTest(null);
  }
};

test("anonymous replay-captures requests are rejected before any storage access", async () => {
  await runWithoutKv(async () => {
    const anonymous = await handler(new Request(exportUrl({ after_ms: "0", before_ms: "1" })));
    assert.equal(anonymous.status, 401);
    const anonymousPayload = (await anonymous.json()) as { error?: { code?: string } };
    assert.equal(anonymousPayload.error?.code, "invalid_api_key");

    // The same request with a valid super-admin token must reach storage, and
    // missing storage must fail closed rather than return an empty success.
    const adminTokens = config.adminTokens as Set<string>;
    adminTokens.add(SUPER_ADMIN_TOKEN);
    try {
      const authenticated = await handler(new Request(exportUrl({ after_ms: "0", before_ms: "1" }), { headers: superAdminHeaders }));
      assert.equal(authenticated.status, 503);
      const payload = (await authenticated.json()) as { error?: { code?: string } };
      assert.equal(payload.error?.code, "sentinel_replay_storage_unavailable");
    } finally {
      adminTokens.delete(SUPER_ADMIN_TOKEN);
    }
  });
});

test("an authenticated admin passkey reaches the replay export", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const now = Date.now();
  const userId = "sentinel-replay-passkey-user";
  const handle = "sentinel-replay-passkey-handle";
  const sessionToken = "sentinel-replay-passkey-session-token";
  await kv.set(passkeyUserKey(userId), {
    id: userId,
    handle,
    is_admin: true,
    credential_ids: ["sentinel-replay-credential"],
    created_at_ms: now,
    updated_at_ms: now,
  });
  await kv.set(passkeyHandleKey(handle), userId);
  await kv.set(passkeySessionKey(sessionToken), {
    token: sessionToken,
    user_id: userId,
    created_at_ms: now,
    expires_at_ms: now + 3_600_000,
  });
  try {
    const response = await handler(
      new Request(exportUrl({ after_ms: "0", before_ms: "1" }), {
        headers: { Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
      })
    );
    // The former super-admin gate is gone: an admin passkey session now
    // reads the same bounded export a token admin reads.
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { data?: unknown };
    assert.equal(Array.isArray(payload.data), true);
  } finally {
    kv.close();
    setKvForTest(null);
  }
});

test("replay-captures export returns encrypted captures that decrypt to exact synthetic bytes", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
    const nowMs = 1_700_000_000_000;
    const exactBytes: Uint8Array<ArrayBuffer> = encoder.encode(
      JSON.stringify({
        model: "gpt-5.6-sol",
        stream: false,
        messages: [{ role: "user", content: "synthetic replay bytes for export round trip" }],
      })
    );
    const input = syntheticInput(exactBytes, "synthetic-export-request-id");
    const stored = expectStored(
      await persistEncryptedSentinelReplay(input, failureObservation(), {
        kv,
        keyBytes,
        now: () => nowMs,
        randomUuid: () => "synthetic-capture-1",
        randomBytes: twelveByteIv,
      })
    );

    const response = await handler(new Request(exportUrl({ after_ms: "0", before_ms: String(nowMs + 1) }), { headers: superAdminHeaders }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = (await response.json()) as {
      data: ExportedSentinelReplayCapture[];
      cursor: string | null;
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.manifest.fingerprint, stored.manifest.fingerprint);
    assert.equal(body.data[0]?.manifest.algorithm, "AES-256-GCM");
    assert.equal(body.data[0]?.manifest.compression, "gzip");
    // The exported manifest is exactly the frozen wire schema: the additive
    // retention-accounting fields never leave the store.
    assert.deepEqual(Object.keys(body.data[0]?.manifest ?? {}), [
      "version",
      "capture_id",
      "fingerprint",
      "case_group_digest",
      "captured_at_ms",
      "expires_at_ms",
      "algorithm",
      "compression",
      "iv",
      "chunk_count",
      "ciphertext_bytes",
    ]);
    // The exported payload is encrypted only: no plaintext bytes may appear.
    assert.equal(body.data[0]?.chunks.join("").includes("synthetic replay bytes for export round trip"), false);

    const plaintext = await decryptExportedSentinelReplay(firstCapture(body), keyBytes);
    assert.equal(plaintext.endpoint, input.endpoint);
    assert.equal(plaintext.method, input.method);
    assert.equal(plaintext.content_type, input.content_type);
    assert.equal(plaintext.request_id, input.request_id);
    assert.equal(plaintext.git_sha, input.git_sha);
    assert.equal(plaintext.deno_revision, input.deno_revision);
    assert.deepEqual([...plaintext.body], [...exactBytes]);
    assert.equal(new TextDecoder().decode(plaintext.body), new TextDecoder().decode(exactBytes));
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

/**
 * The advertised upstream capture bound is `SENTINEL_UPSTREAM_MAX_BYTES` (4 MiB),
 * yet the earlier regression only exercised 256 KiB + 1 byte: well past the
 * ~192 KiB of upstream bytes the legacy fixed metadata bound could carry once
 * base64-encoded, but nowhere near the boundary the bound actually advertises.
 * Both sizes now run the whole record -> persist -> export -> decrypt -> replay
 * chain, so a capture the recorder accepted is proven exportable and replayable
 * byte for byte at the representative size and at the exact upper bound.
 */
const CAPTURE_BOUND_CASES: readonly Readonly<{ label: string; byteLength: number }>[] = [
  { label: "256 KiB + 1 byte above the legacy fixed metadata bound", byteLength: 256 * 1_024 + 1 },
  { label: "exactly the advertised 4 MiB capture bound", byteLength: SENTINEL_UPSTREAM_MAX_BYTES },
];

for (const boundCase of CAPTURE_BOUND_CASES) {
  test(`replay capture exports and replays an upstream capture at ${boundCase.label}`, async () => {
    const kv = await openKv(":memory:");
    setKvForTest(kv);
    const adminTokens = config.adminTokens as Set<string>;
    adminTokens.add(SUPER_ADMIN_TOKEN);
    try {
      const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
      const nowMs = 1_400_000_000_000;
      const requestId = `synthetic-envelope-${boundCase.byteLength}-request`;
      const upstreamBytes = patternedBytes(boundCase.byteLength);
      const expectedChunks = Math.ceil(boundCase.byteLength / UPSTREAM_CHUNK_BYTES);
      const trace = await recordUpstreamTrace(upstreamBytes, UPSTREAM_CHUNK_BYTES);
      assert.equal(trace.attempts[0]?.chunks_base64.length, expectedChunks, `${boundCase.label}: recorded chunk count`);
      assert.equal(trace.bytes_truncated, false, `${boundCase.label}: recorded byte truncation`);
      assert.equal(trace.chunks_truncated, false, `${boundCase.label}: recorded chunk truncation`);
      assert.equal(trace.attempts_truncated, false, `${boundCase.label}: recorded attempt truncation`);

      const input: AcceptedSentinelReplayInput = {
        ...syntheticInput(encoder.encode(JSON.stringify({ model: "gpt-5.6-sol", stream: false })), requestId),
        upstream: trace,
      };
      const stored = expectStored(
        await persistEncryptedSentinelReplay(
          input,
          failureObservation(),
          { kv, keyBytes, now: () => nowMs, randomUuid: () => `synthetic-envelope-capture-${boundCase.byteLength}`, randomBytes: twelveByteIv },
          retainedBodyObservation()
        )
      );

      const response = await handler(new Request(exportUrl({ request_id: requestId }), { headers: superAdminHeaders }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data: ExportedSentinelReplayCapture[] };
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0]?.manifest.fingerprint, stored.manifest.fingerprint);
      const plaintext = await decryptExportedSentinelReplay(firstCapture(body), keyBytes);

      // A capture the recorder accepted must stay exactly the capture the
      // envelope bound admits: no truncation flag and no unavailable reason
      // may appear, so incompleteness is never silently dropped.
      assert.deepEqual(plaintext.unavailable, [], `${boundCase.label}: unavailable evidence`);
      assert.equal(plaintext.capture_status, "ready", `${boundCase.label}: capture status`);
      assert.equal(plaintext.replay_coverage, "full", `${boundCase.label}: replay coverage`);
      assert.equal(plaintext.upstream.attempts_truncated, false, `${boundCase.label}: decrypted attempt truncation`);
      assert.equal(plaintext.upstream.bytes_truncated, false, `${boundCase.label}: decrypted byte truncation`);
      assert.equal(plaintext.upstream.chunks_truncated, false, `${boundCase.label}: decrypted chunk truncation`);
      assert.equal(plaintext.upstream.attempts.length, 1);
      assert.equal(plaintext.upstream.attempts[0]?.chunks_base64.length, expectedChunks, `${boundCase.label}: decrypted chunk count`);

      // Byte preservation: the accepted request body and the recorded upstream
      // bytes are reconstructed from the encrypted export alone, and the
      // replay transport must hand back every original chunk boundary.
      assert.equal(plaintext.body_bytes, input.body.byteLength, `${boundCase.label}: recorded body length`);
      assertBytesEqual(plaintext.body, input.body, `${boundCase.label}: request body`);
      await assertReplayedUpstream(plaintext.upstream, upstreamBytes, boundCase.label);
    } finally {
      adminTokens.delete(SUPER_ADMIN_TOKEN);
      kv.close();
      setKvForTest(null);
    }
  });
}

test("replay capture marks an upstream capture over the advertised 4 MiB bound as explicitly incomplete", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
    const nowMs = 1_410_000_000_000;
    const requestId = "synthetic-over-limit-envelope-request";
    // One full 64 KiB chunk beyond the advertised bound: the recorder keeps
    // exactly the bound and permanently flags the dropped bytes.
    const upstreamBytes = patternedBytes(SENTINEL_UPSTREAM_MAX_BYTES + UPSTREAM_CHUNK_BYTES);
    const retainedChunks = Math.ceil(SENTINEL_UPSTREAM_MAX_BYTES / UPSTREAM_CHUNK_BYTES);
    const trace = await recordUpstreamTrace(upstreamBytes, UPSTREAM_CHUNK_BYTES);
    assert.equal(trace.attempts[0]?.chunks_base64.length, retainedChunks);
    assert.equal(trace.bytes_truncated, true);
    assert.equal(trace.chunks_truncated, false);
    assert.equal(trace.attempts_truncated, false);

    const input: AcceptedSentinelReplayInput = {
      ...syntheticInput(encoder.encode(JSON.stringify({ model: "gpt-5.6-sol", stream: false })), requestId),
      upstream: trace,
    };
    const stored = expectStored(
      await persistEncryptedSentinelReplay(
        input,
        failureObservation(),
        { kv, keyBytes, now: () => nowMs, randomUuid: () => "synthetic-over-limit-envelope-capture", randomBytes: twelveByteIv },
        retainedBodyObservation()
      )
    );

    const response = await handler(new Request(exportUrl({ request_id: requestId }), { headers: superAdminHeaders }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: ExportedSentinelReplayCapture[] };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.manifest.fingerprint, stored.manifest.fingerprint);
    const plaintext = await decryptExportedSentinelReplay(firstCapture(body), keyBytes);

    // The over-limit loss is itself evidence, never a silent success: the
    // capture is flagged, classified incomplete and reported as partial.
    assert.equal(plaintext.upstream.bytes_truncated, true);
    assert.deepEqual(plaintext.unavailable, ["upstream_trace_truncated"]);
    assert.equal(plaintext.capture_status, "incomplete");
    assert.equal(plaintext.replay_coverage, "partial");

    const attempt = plaintext.upstream.attempts[0];
    assert.ok(attempt);
    assert.equal(attempt.chunks_base64.length, retainedChunks);
    let offset = 0;
    for (const chunk of attempt.chunks_base64) {
      const decoded = decodeStandardBase64(chunk);
      assertBytesEqual(decoded, upstreamBytes.subarray(offset, offset + decoded.byteLength), `retained upstream prefix at ${offset}`);
      offset += decoded.byteLength;
    }
    assert.equal(offset, SENTINEL_UPSTREAM_MAX_BYTES, "exactly the advertised bound is retained");

    // The replay transport refuses truncated evidence instead of replaying a
    // prefix as if it were the whole capture.
    assert.throws(
      () => createRecordedUpstreamReplay(plaintext.upstream, REPLAY_ROUTES),
      (error: unknown) => error instanceof Error && error.message === "Sentinel recorded upstream trace is truncated"
    );
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("replay capture still rejects an upstream trace beyond the bounded capture contract", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
    const requestId = "synthetic-out-of-contract-request";
    // One chunk over the frozen capture chunk bound: the derived envelope
    // bound must not widen the evidence contract the recorder enforces.
    const oversizedTrace: SentinelUpstreamTrace = {
      version: 1,
      attempts: [
        {
          provider: "cerebras",
          status: 200,
          content_type: "application/json",
          chunks_base64: Array.from({ length: SENTINEL_UPSTREAM_MAX_CHUNKS + 1 }, () => "AA=="),
          terminal: "eof",
        },
      ],
      attempts_truncated: false,
      bytes_truncated: false,
      chunks_truncated: false,
    };
    const input: AcceptedSentinelReplayInput = {
      ...syntheticInput(encoder.encode(JSON.stringify({ model: "gpt-5.6-sol" })), requestId),
      upstream: oversizedTrace,
    };
    await assert.rejects(
      persistEncryptedSentinelReplay(input, failureObservation(), {
        kv,
        keyBytes,
        now: () => 1_450_000_000_000,
        randomUuid: () => "synthetic-out-of-contract-capture",
        randomBytes: twelveByteIv,
      }),
      /Sentinel upstream trace has too many chunks/
    );

    // The rejected trace persisted nothing and stayed fail-closed.
    const response = await handler(new Request(exportUrl({ request_id: requestId }), { headers: superAdminHeaders }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: unknown[] };
    assert.deepEqual(body.data, []);
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("replay-captures export paginates multiple captures with an exhaustible cursor", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
    const nowMs = 1_600_000_000_000;
    const requestIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const requestId = `synthetic-pagination-request-${index}`;
      requestIds.push(requestId);
      const bytes: Uint8Array<ArrayBuffer> = encoder.encode(
        JSON.stringify({
          model: "gpt-5.6-sol",
          seq: index,
          content: `synthetic pagination capture ${index}`,
        })
      );
      const result = expectStored(
        await persistEncryptedSentinelReplay(syntheticInput(bytes, requestId), failureObservation(), {
          kv,
          keyBytes,
          now: () => nowMs + index * 1_000,
          randomUuid: () => `synthetic-pagination-capture-${index}`,
          randomBytes: twelveByteIv,
        })
      );
      assert.equal(result.manifest.capture_id, `synthetic-pagination-capture-${index}`, requestId);
    }

    const collected: ExportedSentinelReplayCapture[] = [];
    const pageCapturedAt: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const params: Record<string, string> = {
        after_ms: "0",
        before_ms: String(nowMs + 10_000),
      };
      if (cursor !== null) params.cursor = cursor;
      const response = await handler(new Request(exportUrl(params), { headers: superAdminHeaders }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        data: ExportedSentinelReplayCapture[];
        cursor: string | null;
      };
      for (const capture of body.data) {
        collected.push(capture);
        pageCapturedAt.push(capture.manifest.captured_at_ms);
      }
      cursor = body.cursor;
      pages += 1;
      assert.ok(pages <= 10, "pagination must terminate");
      if (cursor === null) break;
    }

    assert.equal(collected.length, 3);
    assert.equal(new Set(collected.map((capture) => capture.manifest.fingerprint)).size, 3);
    assert.deepEqual(
      pageCapturedAt,
      [...pageCapturedAt].sort((left, right) => left - right)
    );
    const decryptedRequestIds = new Set<string>();
    for (const capture of collected) {
      const plaintext = await decryptExportedSentinelReplay(capture, keyBytes);
      decryptedRequestIds.add(plaintext.request_id);
    }
    assert.deepEqual([...decryptedRequestIds].sort(compareStrings), [...requestIds].sort(compareStrings));
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("replay-captures export scopes to a linked incident and stays encrypted", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
    const nowMs = 1_500_000_000_000;
    const bytes: Uint8Array<ArrayBuffer> = encoder.encode(
      JSON.stringify({
        model: "gpt-5.6-sol",
        content: "incident-linked synthetic capture",
      })
    );
    const stored = expectStored(
      await persistEncryptedSentinelReplay(syntheticInput(bytes, "synthetic-incident-request"), failureObservation(), {
        kv,
        keyBytes,
        now: () => nowMs,
        randomUuid: () => "synthetic-incident-capture",
        randomBytes: twelveByteIv,
      })
    );
    const manifestKey = stored.manifest_key;
    assert.ok(manifestKey, "a stored capture must expose its manifest key");
    await linkSentinelReplayToIncident(kv, INCIDENT_ID, stored.manifest.fingerprint, manifestKey);

    const response = await handler(
      new Request(
        exportUrl({
          after_ms: "0",
          before_ms: String(nowMs + 1),
          incident_id: INCIDENT_ID,
        }),
        { headers: superAdminHeaders }
      )
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: ExportedSentinelReplayCapture[];
      cursor: string | null;
    };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.manifest.fingerprint, stored.manifest.fingerprint);
    // The incident listing emits the same frozen manifest schema; a strict
    // consumer rejects unknown keys.
    assert.deepEqual(Object.keys(body.data[0]?.manifest ?? {}), [
      "version",
      "capture_id",
      "fingerprint",
      "case_group_digest",
      "captured_at_ms",
      "expires_at_ms",
      "algorithm",
      "compression",
      "iv",
      "chunk_count",
      "ciphertext_bytes",
    ]);
    const plaintext = await decryptExportedSentinelReplay(firstCapture(body), keyBytes);
    assert.equal(plaintext.request_id, "synthetic-incident-request");
    assert.deepEqual([...plaintext.body], [...bytes]);

    // An incident listing for a foreign incident ID yields an empty page,
    // never another incident's capture.
    const foreign = await handler(
      new Request(
        exportUrl({
          after_ms: "0",
          before_ms: String(nowMs + 1),
          incident_id: "provider-00000000-0000-4000-8000-000000000000",
        }),
        { headers: superAdminHeaders }
      )
    );
    assert.equal(foreign.status, 200);
    const foreignBody = (await foreign.json()) as { data: unknown[]; cursor: string | null };
    assert.deepEqual(foreignBody.data, []);
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("replay-captures export resolves a request id without any time parameters", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
    const nowMs = Date.now();
    const bytes: Uint8Array<ArrayBuffer> = encoder.encode(JSON.stringify({ model: "gpt-5.6-sol", content: "request-id-only synthetic capture" }));
    const stored = expectStored(
      await persistEncryptedSentinelReplay(syntheticInput(bytes, "synthetic-request-id-only"), failureObservation(), {
        kv,
        keyBytes,
        now: () => nowMs,
        randomUuid: () => "synthetic-request-id-capture",
        randomBytes: twelveByteIv,
      })
    );

    // Exactly the request id, no after_ms/before_ms: the point lookup must
    // still resolve the capture and report its status.
    const response = await handler(new Request(exportUrl({ request_id: "synthetic-request-id-only" }), { headers: superAdminHeaders }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = (await response.json()) as {
      data: ExportedSentinelReplayCapture[];
      cursor: string | null;
      capture_status: { status: string; reason: string | null };
    };
    assert.equal(body.cursor, null);
    // This fixture is request-only (`syntheticInput` carries no recorded
    // upstream attempt) on a 502 provider failure, so the capture is
    // truthfully incomplete: the missing upstream evidence is asserted
    // through the decrypted `unavailable` reason below, while the status row
    // itself only classifies the capture.
    assert.equal(body.capture_status.status, "incomplete");
    assert.equal(body.capture_status.reason, null);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.manifest.fingerprint, stored.manifest.fingerprint);
    const plaintext = await decryptExportedSentinelReplay(firstCapture(body), keyBytes);
    assert.equal(plaintext.request_id, "synthetic-request-id-only");
    assert.deepEqual([...plaintext.body], [...bytes]);
    assert.equal(plaintext.unavailable?.includes("upstream_trace_empty"), true);

    // Related fail-closed boundaries stay intact: a malformed request id is
    // still refused, and the lookup modes remain mutually exclusive.
    const malformed = await handler(new Request(exportUrl({ request_id: "not a request id" }), { headers: superAdminHeaders }));
    assert.equal(malformed.status, 400);
    const bothModes = await handler(
      new Request(exportUrl({ request_id: "synthetic-request-id-only", incident_id: INCIDENT_ID }), { headers: superAdminHeaders })
    );
    assert.equal(bothModes.status, 400);
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("replay-captures export rejects malformed interval, limit, cursor, and incident parameters", async () => {
  await runWithoutKv(async () => {
    const adminTokens = config.adminTokens as Set<string>;
    adminTokens.add(SUPER_ADMIN_TOKEN);
    try {
      for (const query of [
        "after_ms=abc&before_ms=1",
        "after_ms=10&before_ms=5",
        "after_ms=0",
        "after_ms=0&before_ms=1&limit=0",
        "after_ms=0&before_ms=1&limit=2",
        "after_ms=0&before_ms=1&limit=abc",
        "after_ms=0&before_ms=1&cursor=!!",
        `after_ms=0&before_ms=1&cursor=${"a".repeat(3_000)}`,
        "after_ms=0&before_ms=1&incident_id=not-an-incident-id",
      ]) {
        const response = await handler(new Request(`https://ai.ubq.fi/admin/sentinel/replay-captures?${query}`, { headers: superAdminHeaders }));
        assert.equal(response.status, 400, query);
      }
    } finally {
      adminTokens.delete(SUPER_ADMIN_TOKEN);
    }
  });
});

test("replay-captures export fails closed when the storage read fails instead of succeeding empty", async () => {
  const request = new Request(exportUrl({ after_ms: "0", before_ms: "1" }));
  const brokenKv = { list: null } as unknown as Kv;
  const interval = await handleAdminSentinelReplayCaptures(request, {
    getKv: () => Promise.resolve(brokenKv),
    listEncryptedSentinelReplays: () => {
      throw new Error("injected listing failure");
    },
  });
  assert.equal(interval.status, 503);
  const intervalPayload = (await interval.json()) as { error?: { code?: string } };
  assert.equal(intervalPayload.error?.code, "sentinel_replay_export_failed");

  const incidentRequest = new Request(exportUrl({ after_ms: "0", before_ms: "1", incident_id: INCIDENT_ID }));
  const incident = await handleAdminSentinelReplayCaptures(incidentRequest, {
    getKv: () => Promise.resolve(brokenKv),
    listEncryptedSentinelIncidentReplays: () => {
      throw new Error("injected incident listing failure");
    },
  });
  assert.equal(incident.status, 503);
  const incidentPayload = (await incident.json()) as { error?: { code?: string } };
  assert.equal(incidentPayload.error?.code, "sentinel_replay_export_failed");
});
