import { test } from "bun:test";
import { openKv } from "#kv";
/**
 * Shared limit coverage: one allowed maximum-size capture round-trips through
 * store -> export -> decrypt, and one byte/chunk over each bound is rejected.
 * Synthetic bytes only; the injectable budget avoids writing a real GiB.
 */
import assert from "node:assert/strict";
import { setKvForTest } from "../src/kv.ts";
import { resolveSentinelClientFailureObservation } from "../src/sentinel/replay-observation.ts";
import { decryptExportedSentinelReplay, listEncryptedSentinelReplaysByRequestId } from "../src/sentinel/replay-read.ts";
import { persistEncryptedSentinelReplay } from "../src/sentinel/replay-store.ts";
import { type AcceptedSentinelReplayInput, type SentinelFailureObservation } from "../src/sentinel/replay-model.ts";
import {
  SENTINEL_REPLAY_JSON_ESCAPE_FACTOR,
  SENTINEL_REPLAY_MAX_METADATA_BYTES,
  SENTINEL_REPLAY_MAX_REQUEST_BYTES,
  SENTINEL_REPLAY_MAX_UPSTREAM_BYTES,
  SENTINEL_REPLAY_MAX_UPSTREAM_CHUNKS,
  SENTINEL_REPLAY_METADATA_DERIVED_BYTES,
  SENTINEL_REPLAY_REQUEST_FILE_MAX_BYTES,
  SENTINEL_REPLAY_UPSTREAM_FILE_MAX_BYTES,
} from "../src/sentinel/replay-limits.ts";
import { parseSentinelUpstreamTrace, type SentinelUpstreamTrace } from "../src/sentinel/upstream-capture.ts";

const encoder = new TextEncoder();
const BUDGET_HEADROOM_BYTES = 512 * 1_024 * 1_024;

const failureObservation = (): SentinelFailureObservation => ({
  status: 502,
  stream: false,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  synthetic_terminal_type: null,
  provider_route: "chatgpt_codex",
});

const input = (body: Uint8Array<ArrayBuffer>, upstream: SentinelUpstreamTrace, requestId: string): AcceptedSentinelReplayInput => ({
  endpoint: "/v1/responses",
  method: "POST",
  body,
  content_type: "application/json",
  compatibility_headers: {},
  request_id: requestId,
  git_sha: "a".repeat(40),
  deno_revision: "limits-fixture",
  upstream,
});

/** A JSON request body of exactly SENTINEL_REPLAY_MAX_REQUEST_BYTES bytes using control-char escapes. */
const maximalEscapedBody = (): Uint8Array<ArrayBuffer> => {
  const control = "\u0001";
  const target = SENTINEL_REPLAY_MAX_REQUEST_BYTES - 64;
  const repeats = Math.floor(target / 6);
  const body = encoder.encode(JSON.stringify({ model: "gpt-5.6-sol", input: control.repeat(repeats) }));
  assert.equal(body.byteLength <= SENTINEL_REPLAY_MAX_REQUEST_BYTES, true);
  assert.equal(body.byteLength > SENTINEL_REPLAY_MAX_REQUEST_BYTES - 128, true, "the body must sit at the cap");
  return body;
};

/** A trace at the chunk-count and byte ceilings: 4,096 chunks of 1,023 raw bytes. */
const maximalTrace = (): SentinelUpstreamTrace => {
  const chunk = "b".repeat(1_023);
  const chunks = Array.from({ length: SENTINEL_REPLAY_MAX_UPSTREAM_CHUNKS }, () => chunk);
  const trace: SentinelUpstreamTrace = {
    version: 1,
    attempts: [{ provider: "chatgpt_codex", status: 200, content_type: "text/event-stream", chunks_base64: chunks.map((text) => btoa(text)), terminal: "eof" }],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  };
  const total = chunks.length * chunk.length;
  assert.equal(total <= SENTINEL_REPLAY_MAX_UPSTREAM_BYTES, true);
  return trace;
};

test("derived metadata allowance covers the full allowed trace and escaping covers the request envelope", () => {
  assert.equal(SENTINEL_REPLAY_METADATA_DERIVED_BYTES < SENTINEL_REPLAY_MAX_METADATA_BYTES, true);
  assert.equal(SENTINEL_REPLAY_REQUEST_FILE_MAX_BYTES >= SENTINEL_REPLAY_JSON_ESCAPE_FACTOR * SENTINEL_REPLAY_MAX_REQUEST_BYTES, true);
  assert.equal(SENTINEL_REPLAY_UPSTREAM_FILE_MAX_BYTES >= SENTINEL_REPLAY_MAX_METADATA_BYTES, true);
});

test("a trace one chunk over the bound and a body one byte over the bound are rejected", () => {
  const overChunk = maximalTrace();
  const attempts = overChunk.attempts[0];
  assert.throws(
    () =>
      parseSentinelUpstreamTrace({
        ...overChunk,
        attempts: [{ ...attempts, chunks_base64: [...attempts.chunks_base64, btoa("b")] }],
      }),
    /too many chunks/
  );
});

test("a maximum-size capture round-trips through store, export and decrypt", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
  try {
    const body = maximalEscapedBody();
    const trace = maximalTrace();
    const stored = await persistEncryptedSentinelReplay(input(body, trace, "limits-maximal"), failureObservation(), {
      kv,
      keyBytes,
      now: () => 1_700_000_000_000,
      randomUuid: () => "capture-limits-maximal",
      budgetBytes: BUDGET_HEADROOM_BYTES,
    });
    assert.equal(stored.status, "stored");
    const exported = await listEncryptedSentinelReplaysByRequestId(kv, "limits-maximal");
    assert.equal(exported.captures.length, 1);
    const plaintext = await decryptExportedSentinelReplay(exported.captures[0], keyBytes);
    assert.equal(plaintext.body.byteLength, body.byteLength);
    assert.equal(plaintext.upstream.attempts.length, 1);
    assert.equal(plaintext.upstream.attempts[0].chunks_base64.length, SENTINEL_REPLAY_MAX_UPSTREAM_CHUNKS);
    assert.equal(plaintext.version, 3);

    // A capture with a complete recorded upstream attempt is fully replayable,
    // so its persisted status row must be `ready`, never `incomplete`.
    const readyTrace: SentinelUpstreamTrace = {
      version: 2,
      attempts: [
        {
          provider: "chatgpt_codex",
          status: 200,
          content_type: "text/event-stream",
          chunks_base64: [btoa("data: {}\n\n")],
          terminal: "eof",
          headers: { "content-type": "text/event-stream" },
          headers_truncated: false,
          chunk_times_ms: [5],
          started_at_ms: 100,
          headers_at_ms: 101,
          ended_at_ms: 110,
        },
      ],
      attempts_truncated: false,
      bytes_truncated: false,
      chunks_truncated: false,
    };
    const readyBody = encoder.encode(JSON.stringify({ model: "gpt-5.6-sol", input: "ready-coverage" }));
    // `ready` requires every coverage reason absent: a complete upstream
    // attempt AND the recorded downstream terminal body.
    const readyObservation = {
      ...resolveSentinelClientFailureObservation(failureObservation()),
      terminal_body_base64: btoa(JSON.stringify({ error: { message: "upstream timeout" } })),
    };
    const ready = await persistEncryptedSentinelReplay(
      input(readyBody, readyTrace, "limits-ready-coverage"),
      failureObservation(),
      {
        kv,
        keyBytes,
        now: () => 1_700_000_000_500,
        randomUuid: () => "capture-limits-ready",
        budgetBytes: BUDGET_HEADROOM_BYTES,
      },
      readyObservation
    );
    assert.equal(ready.status, "stored");
    // Read at the fixture clock, not the wall clock: the stored expiry is synthetic.
    const readyExport = await listEncryptedSentinelReplaysByRequestId(kv, "limits-ready-coverage", 1_700_000_000_500);
    assert.equal(readyExport.captures.length, 1);
    assert.equal(readyExport.status.status, "ready");
    assert.equal(readyExport.status.reason, null);

    // One byte over the accepted request cap is rejected before publication.
    const overBody = new Uint8Array(SENTINEL_REPLAY_MAX_REQUEST_BYTES + 1);
    overBody.fill(0x61);
    await assert.rejects(
      persistEncryptedSentinelReplay(input(overBody, trace, "limits-over-body"), failureObservation(), {
        kv,
        keyBytes,
        now: () => 1_700_000_001_000,
        randomUuid: () => "capture-limits-over-body",
        budgetBytes: BUDGET_HEADROOM_BYTES,
      }),
      /too large/
    );
  } finally {
    kv.close();
    setKvForTest(null);
  }
});
