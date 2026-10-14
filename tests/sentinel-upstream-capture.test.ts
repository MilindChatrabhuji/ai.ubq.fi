import { test } from "bun:test";
import { openKv, type Kv } from "#kv";
import assert from "node:assert/strict";
import { setKvForTest } from "../src/kv.ts";
import {
  canonicalSentinelUpstreamJson,
  createSentinelUpstreamRecorder,
  emptySentinelUpstreamTrace,
  isSentinelUpstreamTrace,
  normalizeSentinelUpstreamContentType,
  parseSentinelUpstreamTrace,
  SENTINEL_UPSTREAM_MAX_ATTEMPTS,
  SENTINEL_UPSTREAM_MAX_BYTES,
  SENTINEL_UPSTREAM_MAX_CHUNKS,
  type SentinelUpstreamAttempt,
  type SentinelUpstreamTrace,
} from "../src/sentinel/upstream-capture.ts";
import {
  type AcceptedSentinelReplayInput,
  decryptExportedSentinelReplay,
  type ExportedSentinelReplayCapture,
  persistEncryptedSentinelReplay,
  SENTINEL_REPLAY_CHUNK_PREFIX,
  type SentinelFailureObservation,
} from "../src/sentinel/replay-capture.ts";
import { base64UrlDecode, base64UrlEncode } from "../src/utils.ts";

const encoder = new TextEncoder();

/** The wrapped response body, which every wrapped response in this file must expose. */
const responseBody = (response: Response): ReadableStream<Uint8Array> => {
  const body = response.body;
  assert.ok(body, "the wrapped response must expose a body stream");
  return body;
};

/** The single captured attempt of a trace that must contain one. */
const firstAttempt = (trace: SentinelUpstreamTrace): SentinelUpstreamAttempt => {
  const attempt = trace.attempts[0];
  assert.ok(attempt, "the trace must contain at least one attempt");
  return attempt;
};

const invalidTrace = (attempt: Record<string, unknown>): Record<string, unknown> => ({
  version: 1,
  attempts: [attempt],
  attempts_truncated: false,
  bytes_truncated: false,
  chunks_truncated: false,
});

const baseAttempt = (): Record<string, unknown> => ({
  provider: "chatgpt_codex",
  status: 200,
  content_type: "application/json",
  chunks_base64: [],
  terminal: "eof",
});

/** A minimal valid version-2 attempt: one canonical chunk, timing and headers. */
const v2Attempt = (): Record<string, unknown> => ({
  provider: "chatgpt_codex",
  status: 200,
  content_type: "application/json",
  chunks_base64: ["YQ=="],
  terminal: "eof",
  headers: { "content-type": "application/json" },
  headers_truncated: false,
  chunk_times_ms: [0],
  started_at_ms: 1_700_000_000_000,
  headers_at_ms: 1_700_000_000_001,
  ended_at_ms: 1_700_000_000_002,
});

const v2Trace = (attempt: Record<string, unknown>): Record<string, unknown> => ({
  version: 2,
  attempts: [attempt],
  attempts_truncated: false,
  bytes_truncated: false,
  chunks_truncated: false,
});

test("frozen trace relationship: status and content_type are null together", () => {
  assert.throws(() => parseSentinelUpstreamTrace(invalidTrace({ ...baseAttempt(), status: null, content_type: "application/json" })), /content type/);
  assert.throws(() => parseSentinelUpstreamTrace(invalidTrace({ ...baseAttempt(), status: 204, content_type: null })), /content type/);
  // A pending pre-header attempt is exactly null/null with no chunks.
  const preHeader = parseSentinelUpstreamTrace(
    invalidTrace({
      provider: "surplus",
      status: null,
      content_type: null,
      chunks_base64: [],
      terminal: "pending",
    })
  );
  assert.equal(preHeader.attempts.length, 1);
  assert.equal(preHeader.attempts[0]?.status, null);
  assert.equal(preHeader.attempts[0]?.content_type, null);
  assert.equal(preHeader.attempts[0]?.terminal, "pending");
});

test("frozen trace relationship: fetch_error and header-bearing terminals", () => {
  const fetchError = invalidTrace({
    provider: "metered",
    status: null,
    content_type: null,
    chunks_base64: [],
    terminal: "fetch_error",
  });
  assert.equal(parseSentinelUpstreamTrace(fetchError).attempts[0]?.terminal, "fetch_error");
  assert.throws(
    () =>
      parseSentinelUpstreamTrace(
        invalidTrace({
          provider: "metered",
          status: 502,
          content_type: "application/json",
          chunks_base64: [],
          terminal: "fetch_error",
        })
      ),
    /fetch_error/
  );
  assert.throws(
    () =>
      parseSentinelUpstreamTrace(
        invalidTrace({
          provider: "metered",
          status: null,
          content_type: null,
          chunks_base64: [],
          terminal: "eof",
        })
      ),
    /requires a status/
  );
  assert.throws(
    () =>
      parseSentinelUpstreamTrace(
        invalidTrace({
          provider: "metered",
          status: null,
          content_type: null,
          chunks_base64: [],
          terminal: "read_error",
        })
      ),
    /requires a status/
  );
  assert.throws(
    () =>
      parseSentinelUpstreamTrace(
        invalidTrace({
          provider: "metered",
          status: null,
          content_type: null,
          chunks_base64: [],
          terminal: "cancelled",
        })
      ),
    /requires a status/
  );
  assert.throws(
    () =>
      parseSentinelUpstreamTrace(
        invalidTrace({
          ...baseAttempt(),
          status: null,
          content_type: null,
          chunks_base64: ["YQ=="],
        })
      ),
    /cannot have chunks/
  );
  assert.throws(() => parseSentinelUpstreamTrace(invalidTrace({ ...baseAttempt(), status: 99 })), /status is invalid/);
  assert.throws(() => parseSentinelUpstreamTrace(invalidTrace({ ...baseAttempt(), status: 600 })), /status is invalid/);
});

test("strict parser rejects provider enum, keys, version, canonical base64, and attempt bounds", () => {
  assert.throws(() => parseSentinelUpstreamTrace(invalidTrace({ ...baseAttempt(), provider: "codex" })), /provider/);
  assert.throws(() => parseSentinelUpstreamTrace(invalidTrace({ ...baseAttempt(), content_type: "text/plain" })), /content type/);
  // A version-2 trace must carry the version-2 attempt key set; a version-1
  // attempt inside it is a key-set violation, and an unknown version is rejected.
  assert.throws(() => parseSentinelUpstreamTrace({ ...invalidTrace(baseAttempt()), version: 2 }), /keys are invalid/);
  assert.throws(() => parseSentinelUpstreamTrace({ ...invalidTrace(baseAttempt()), version: 3 }), /version/);
  assert.throws(() => parseSentinelUpstreamTrace(v2Trace({ ...v2Attempt(), headers: { authorization: "Bearer secret" } })), /not allowlisted/);
  assert.throws(() => parseSentinelUpstreamTrace(v2Trace({ ...v2Attempt(), headers: { "content-type": "x".repeat(513) } })), /header value is invalid/);
  assert.throws(() => parseSentinelUpstreamTrace(v2Trace({ ...v2Attempt(), chunk_times_ms: [] })), /chunk timing does not match/);
  assert.throws(() => parseSentinelUpstreamTrace(v2Trace({ ...v2Attempt(), chunk_times_ms: [5] })), /timing exceeds its bounds/);
  assert.throws(() => parseSentinelUpstreamTrace(v2Trace({ ...v2Attempt(), ended_at_ms: null })), /end time disagrees/);
  const parsedV2 = parseSentinelUpstreamTrace(v2Trace(v2Attempt()));
  assert.equal(parsedV2.version, 2);
  assert.deepEqual(firstAttempt(parsedV2).chunk_times_ms, [0]);
  assert.throws(() => parseSentinelUpstreamTrace({ ...invalidTrace(baseAttempt()), extra: true }), /keys are invalid/);
  // Non-canonical padded base64: YR== decodes to the same byte as YQ== but
  // leaves non-zero trailing bits, so it must be rejected.
  assert.throws(() => parseSentinelUpstreamTrace(invalidTrace({ ...baseAttempt(), chunks_base64: ["YR=="] })), /base64/);
  assert.throws(() => parseSentinelUpstreamTrace(invalidTrace({ ...baseAttempt(), chunks_base64: ["a"] })), /base64/);
  assert.throws(() => parseSentinelUpstreamTrace(invalidTrace({ ...baseAttempt(), chunks_base64: ["YQ"] })), /base64/);
  const tooManyAttempts = {
    version: 1,
    attempts: Array.from({ length: SENTINEL_UPSTREAM_MAX_ATTEMPTS + 1 }, () => ({ ...baseAttempt() })),
    attempts_truncated: true,
    bytes_truncated: false,
    chunks_truncated: false,
  };
  assert.throws(() => parseSentinelUpstreamTrace(tooManyAttempts), /too many attempts/);
  assert.equal(isSentinelUpstreamTrace(tooManyAttempts), false);
  assert.equal(isSentinelUpstreamTrace(emptySentinelUpstreamTrace()), true);
});

test("normalizeSentinelUpstreamContentType maps MIME before semicolon to fixed literals", () => {
  assert.equal(normalizeSentinelUpstreamContentType("text/event-stream; charset=utf-8"), "text/event-stream");
  assert.equal(normalizeSentinelUpstreamContentType("TEXT/EVENT-STREAM"), "text/event-stream");
  assert.equal(normalizeSentinelUpstreamContentType("application/json; charset=utf-8"), "application/json");
  assert.equal(normalizeSentinelUpstreamContentType("text/plain"), "other");
  assert.equal(normalizeSentinelUpstreamContentType(""), "other");
  assert.equal(normalizeSentinelUpstreamContentType(null), null);
});

test("recorder wrapper is lazy, forwards bytes, and records a complete EOF trace", async () => {
  const recorder = createSentinelUpstreamRecorder();
  const sourceParts = ["data: one\n\n", "data: two\n\n"];
  let sourcePulls = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        sourcePulls += 1;
        const next = sourceParts.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
    },
    { highWaterMark: 0 }
  );
  const response = new Response(source, {
    status: 200,
    statusText: "OK",
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Upstream-Secret": "must-never-be-retained",
      "X-Request-Id": "secret-request-id",
    },
  });
  const wrapped = recorder.startAttempt("surplus").wrap(response);
  assert.equal(sourcePulls, 0, "wrap must not read ahead");
  assert.equal(wrapped.status, 200);
  assert.equal(wrapped.statusText, "OK");
  assert.equal(wrapped.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
  const reader = responseBody(wrapped).getReader();
  assert.equal(sourcePulls, 0, "getReader must not pull");
  const collected: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    collected.push(new TextDecoder().decode(value));
  }
  assert.deepEqual(collected, ["data: one\n\n", "data: two\n\n"]);
  assert.equal(sourcePulls, 3, "one pull per read plus the terminal close read");
  const trace = recorder.snapshotAndSeal();
  assert.equal(JSON.stringify(trace).includes("must-never-be-retained"), false);
  assert.equal(JSON.stringify(trace).includes("secret-request-id"), false);
  assert.deepEqual(
    trace.attempts.map((attempt) => attempt.provider),
    ["surplus"]
  );
  const attempt = firstAttempt(trace);
  assert.equal(attempt.status, 200);
  assert.equal(attempt.content_type, "text/event-stream");
  assert.equal(attempt.terminal, "eof");
  assert.deepEqual(
    attempt.chunks_base64.map((chunk) => new TextDecoder().decode(base64UrlDecode(chunk))),
    ["data: one\n\n", "data: two\n\n"]
  );
  assert.equal(trace.attempts_truncated, false);
  assert.equal(trace.bytes_truncated, false);
  assert.equal(trace.chunks_truncated, false);
  recorder.dispose();
});

test("recorder maps missing Content-Type on a real response to other and bodyless to EOF", () => {
  const recorder = createSentinelUpstreamRecorder();
  const bodyless = recorder.startAttempt("chatgpt_codex").wrap(new Response(null, { status: 204 }));
  assert.equal(bodyless.status, 204);
  const trace = recorder.snapshotAndSeal();
  assert.deepEqual(
    trace.attempts.map(({ status, content_type: contentType, terminal }) => ({ status, content_type: contentType, terminal })),
    [{ status: 204, content_type: "other", terminal: "eof" }]
  );
  recorder.dispose();
});

test("recorder preserves the original read error object and marks the trace read_error", async () => {
  const recorder = createSentinelUpstreamRecorder();
  const readError = new Error("original upstream read error");
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(encoder.encode("partial-async"));
        controller.error(readError);
      },
    },
    { highWaterMark: 0 }
  );
  const wrapped = recorder.startAttempt("metered").wrap(new Response(source, { status: 200, headers: { "Content-Type": "application/json" } }));
  const reader = responseBody(wrapped).getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "partial-async");
  await assert.rejects(reader.read(), (error: unknown) => error === readError);
  const attempt = firstAttempt(recorder.snapshotAndSeal());
  assert.equal(attempt.terminal, "read_error");
  assert.equal(attempt.status, 200);
  assert.deepEqual(
    attempt.chunks_base64.map((chunk) => new TextDecoder().decode(base64UrlDecode(chunk))),
    ["partial-async"]
  );
  recorder.dispose();
});

test("recorder forwards cancellation with the exact reason and surfaces reader cancel rejections", async () => {
  const recorder = createSentinelUpstreamRecorder();
  let sourceCancelReason: unknown = null;
  const blocking = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(encoder.encode("pending"));
      },
      cancel(reason) {
        sourceCancelReason = reason;
        return Promise.resolve();
      },
    },
    { highWaterMark: 0 }
  );
  const reason = new DOMException("client cancelled the stream", "AbortError");
  const wrapped = recorder.startAttempt("cerebras").wrap(new Response(blocking, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  await responseBody(wrapped).cancel(reason);
  assert.equal(sourceCancelReason, reason, "the exact cancellation reason must reach the original reader");
  const attempt = firstAttempt(recorder.snapshotAndSeal());
  assert.equal(attempt.terminal, "cancelled");
  assert.equal(attempt.status, 200);
  recorder.dispose();

  // A rejection from the original reader must reach the wrapper caller.
  const recorderReject = createSentinelUpstreamRecorder();
  const cancelFailure = new Error("original cancel failure");
  const rejecting = new ReadableStream<Uint8Array>(
    {
      cancel() {
        return Promise.reject(cancelFailure);
      },
    },
    { highWaterMark: 0 }
  );
  const wrappedReject = recorderReject
    .startAttempt("chatgpt_codex")
    .wrap(new Response(rejecting, { status: 200, headers: { "Content-Type": "application/json" } }));
  await assert.rejects(responseBody(wrappedReject).cancel(new DOMException("abort", "AbortError")), (error: unknown) => error === cancelFailure);
  assert.equal(recorderReject.snapshotAndSeal().attempts[0]?.terminal, "cancelled");
  recorderReject.dispose();
});

test("recorder bounds: attempts, chunks, and bytes with permanent truncation flags", async () => {
  const recorder = createSentinelUpstreamRecorder();
  const handles = Array.from({ length: SENTINEL_UPSTREAM_MAX_ATTEMPTS + 1 }, () => recorder.startAttempt("surplus"));
  const response = new Response(null, { status: 200 });
  const lastHandle = handles.at(-1);
  assert.ok(lastHandle, "the recorder must return a handle for every attempt");
  assert.equal(lastHandle.wrap(response), response, "over-bound attempts must be no-ops");
  const traced = recorder.snapshotAndSeal();
  assert.equal(traced.attempts.length, SENTINEL_UPSTREAM_MAX_ATTEMPTS);
  assert.equal(traced.attempts_truncated, true);
  recorder.dispose();

  const byteRecorder = createSentinelUpstreamRecorder();
  // Two chunks whose total exceeds the byte bound by exactly one byte, so the
  // retained prefix is the bound and the omission is reported.
  const halfBound = Math.ceil(SENTINEL_UPSTREAM_MAX_BYTES / 2);
  const bigChunks = [new Uint8Array(halfBound).fill(0x61), new Uint8Array(SENTINEL_UPSTREAM_MAX_BYTES - halfBound + 1).fill(0x62)];
  const bigSource = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = bigChunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(next);
      },
    },
    { highWaterMark: 0 }
  );
  const bigWrapped = byteRecorder.startAttempt("chatgpt_codex").wrap(new Response(bigSource, { status: 200, headers: { "Content-Type": "application/json" } }));
  const bigReader = responseBody(bigWrapped).getReader();
  for (;;) {
    const { done } = await bigReader.read();
    if (done) break;
  }
  const byteTrace = byteRecorder.snapshotAndSeal();
  assert.equal(byteTrace.bytes_truncated, true);
  assert.equal(
    firstAttempt(byteTrace).chunks_base64.reduce((sum, chunk) => sum + base64UrlDecode(chunk).byteLength, 0),
    SENTINEL_UPSTREAM_MAX_BYTES
  );
  assert.equal(firstAttempt(byteTrace).chunks_base64.length, 2);
  assert.equal(byteTrace.chunks_truncated, false);
  byteRecorder.dispose();

  const chunkRecorder = createSentinelUpstreamRecorder();
  const manyChunks = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array([0x61]));
      },
      cancel() {},
    },
    { highWaterMark: 0 }
  );
  const manyWrapped = chunkRecorder.startAttempt("metered").wrap(new Response(manyChunks, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const manyReader = responseBody(manyWrapped).getReader();
  let readCount = 0;
  while (readCount < SENTINEL_UPSTREAM_MAX_CHUNKS + 1) {
    const { done } = await manyReader.read();
    if (done) break;
    readCount += 1;
  }
  await manyReader.cancel(new DOMException("test complete", "AbortError"));
  const chunkTrace = chunkRecorder.snapshotAndSeal();
  assert.equal(firstAttempt(chunkTrace).chunks_base64.length, SENTINEL_UPSTREAM_MAX_CHUNKS);
  assert.equal(chunkTrace.chunks_truncated, true);
  chunkRecorder.dispose();
  // The sealed trace survives disposal (the base64 snapshot is immutable).
  assert.equal(firstAttempt(byteTrace).chunks_base64.length, 2);
});

test("recorder bounds: simultaneous chunk and byte exhaustion discloses both limits", async () => {
  const recorder = createSentinelUpstreamRecorder();
  let chunkIndex = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        // An exact even split: MAX_CHUNKS retained chunks exhaust the byte
        // bound exactly, so the next omitted chunk trips both permanent flags.
        const chunkBytes = SENTINEL_UPSTREAM_MAX_BYTES / SENTINEL_UPSTREAM_MAX_CHUNKS;
        if (chunkIndex < SENTINEL_UPSTREAM_MAX_CHUNKS) controller.enqueue(new Uint8Array(chunkBytes).fill(0x41));
        else if (chunkIndex === SENTINEL_UPSTREAM_MAX_CHUNKS) controller.enqueue(new Uint8Array([0x42]));
        else controller.close();
        chunkIndex += 1;
      },
    },
    { highWaterMark: 0 }
  );
  const wrapped = recorder.startAttempt("metered").wrap(new Response(source, { status: 200, headers: { "Content-Type": "application/json" } }));
  const delivered = await wrapped.arrayBuffer();
  assert.equal(delivered.byteLength, SENTINEL_UPSTREAM_MAX_BYTES + 1, "capture bounds must not truncate the original response");
  const trace = recorder.snapshotAndSeal();
  const attempt = firstAttempt(trace);
  assert.equal(attempt.chunks_base64.length, SENTINEL_UPSTREAM_MAX_CHUNKS);
  assert.equal(
    attempt.chunks_base64.reduce((sum, chunk) => sum + base64UrlDecode(chunk).byteLength, 0),
    SENTINEL_UPSTREAM_MAX_BYTES
  );
  assert.equal(trace.chunks_truncated, true, "chunk limit is exhausted");
  assert.equal(trace.bytes_truncated, true, "the byte limit is exhausted on the same omitted chunk too");
  assert.equal(attempt.terminal, "eof");
  assert.deepEqual(parseSentinelUpstreamTrace(trace), trace);
  recorder.dispose();
});

test("sealed snapshot is immutable and repeated snapshots return the same trace", () => {
  const recorder = createSentinelUpstreamRecorder();
  recorder.startAttempt("chatgpt_codex").wrap(new Response("ok", { status: 200, headers: { "Content-Type": "application/json" } }));
  const first = recorder.snapshotAndSeal();
  const second = recorder.snapshotAndSeal();
  assert.equal(first, second);
  assert.throws(() => {
    (first as unknown as { attempts: unknown[] }).attempts.push({});
  }, TypeError);
  assert.throws(() => {
    (first as { bytes_truncated: boolean }).bytes_truncated = true;
  }, TypeError);
  // After sealing, the wrapper still forwards but retains nothing.
  const postSeal = recorder.startAttempt("surplus").wrap(new Response("later", { status: 200, headers: { "Content-Type": "application/json" } }));
  assert.equal(postSeal.status, 200);
  recorder.dispose();
  assert.deepEqual(recorder.snapshotAndSeal(), first);
});

test("canonical upstream JSON is deterministic and matches the v2 frame encoding", async () => {
  const recorder = createSentinelUpstreamRecorder();
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(encoder.encode("a"));
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  const wrapped = recorder.startAttempt("chatgpt_codex").wrap(new Response(source, { status: 200, headers: { "Content-Type": "application/json" } }));
  const reader = responseBody(wrapped).getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  const trace = recorder.snapshotAndSeal();
  const canonical = canonicalSentinelUpstreamJson(trace);
  assert.equal(canonicalSentinelUpstreamJson(trace), canonical);
  // The recorder now seals a version-2 attempt: the frozen keys keep their
  // exact frame encoding and the new timing/header evidence follows the same
  // recursive key ordering.
  const frozenV1 =
    '{"attempts":[{"chunks_base64":["YQ=="],"content_type":"application/json","provider":"chatgpt_codex","status":200,"terminal":"eof"}],"attempts_truncated":false,"bytes_truncated":false,"chunks_truncated":false,"version":1}';
  assert.equal(canonicalSentinelUpstreamJson(parseSentinelUpstreamTrace(JSON.parse(frozenV1))), frozenV1);
  assert.equal(canonical.startsWith('{"attempts":[{"chunk_times_ms":['), true);
  assert.equal(canonical.includes('"headers":{"content-type":"application/json"}'), true);
  assert.equal(canonical.endsWith('"version":2}'), true);
  // A different partial trace canonicalizes differently.
  const partial = createSentinelUpstreamRecorder();
  partial.startAttempt("chatgpt_codex").wrap(new Response("ab", { status: 200, headers: { "Content-Type": "application/json" } }));
  const partialTrace = partial.snapshotAndSeal();
  assert.notEqual(canonicalSentinelUpstreamJson(partialTrace), canonical);
  recorder.dispose();
  partial.dispose();
});

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

const exportRoundTrip = async (
  stored: Extract<Awaited<ReturnType<typeof persistEncryptedSentinelReplay>>, { status: "stored" }>,
  kv: Kv
): Promise<ExportedSentinelReplayCapture> => {
  const rows: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < stored.manifest.chunk_count; index += 1) {
    const row = await kv.get<Uint8Array<ArrayBuffer>>([...SENTINEL_REPLAY_CHUNK_PREFIX, stored.manifest.capture_id, index]);
    if (!row.value) throw new Error("missing replay chunk");
    rows.push(row.value);
  }
  return { manifest: stored.manifest, chunks: rows.map(base64UrlEncode) } satisfies ExportedSentinelReplayCapture;
};

const buildRecordedTrace = async (terminal: "eof" | "cancelled"): Promise<ReturnType<typeof parseSentinelUpstreamTrace>> => {
  const recorder = createSentinelUpstreamRecorder();
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(encoder.encode(`data: {"type":"response.created"}\n\n`));
        controller.enqueue(encoder.encode(`data: {"type":"response.completed"}\n\n`));
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  const wrapped = recorder.startAttempt("chatgpt_codex").wrap(new Response(source, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const reader = responseBody(wrapped).getReader();
  if (terminal === "eof") {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } else {
    await reader.read();
    await reader.cancel(new DOMException("client cancelled", "AbortError"));
  }
  return recorder.snapshotAndSeal();
};

test("v2 fingerprint binds the exact upstream trace: partial vs complete differ, case-group stays v1-identical", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
  const now = () => 1_700_000_000_000;
  const input = syntheticInput(encoder.encode('{"model":"gpt-5.6-sol","stream":false,"input":"same-request"}'), "v2-fingerprint-binding");
  try {
    const complete = await buildRecordedTrace("eof");
    const partial = await buildRecordedTrace("cancelled");
    assert.equal(firstAttempt(complete).terminal, "eof");
    assert.equal(firstAttempt(partial).terminal, "cancelled");
    assert.notEqual(canonicalSentinelUpstreamJson(complete), canonicalSentinelUpstreamJson(partial));
    const storedComplete = await persistEncryptedSentinelReplay({ ...input, upstream: complete }, failureObservation(), {
      kv,
      keyBytes,
      now,
      randomUuid: () => "capture-complete",
    });
    const storedPartial = await persistEncryptedSentinelReplay({ ...input, upstream: partial }, failureObservation(), {
      kv,
      keyBytes,
      now,
      randomUuid: () => "capture-partial",
    });
    assert.equal(storedComplete.status, "stored");
    assert.equal(storedPartial.status, "stored", "partial and complete must not suppress one another");
    assert.notEqual(storedComplete.manifest.fingerprint, storedPartial.manifest.fingerprint);
    assert.equal(
      storedComplete.manifest.case_group_digest,
      storedPartial.manifest.case_group_digest,
      "case-group identity must remain the request-only v1 HMAC"
    );
    const completePlaintext = await decryptExportedSentinelReplay(await exportRoundTrip(storedComplete, kv), keyBytes);
    assert.equal(completePlaintext.version, 3);
    // This synthetic observation carries no observed downstream body, so the
    // capture reports that omission instead of claiming full coverage.
    assert.equal(completePlaintext.capture_status, "incomplete");
    assert.equal(completePlaintext.replay_coverage, "partial");
    assert.equal(completePlaintext.unavailable?.includes("downstream_terminal_body_unavailable"), true);
    assert.deepEqual(completePlaintext.upstream, complete);
    const partialPlaintext = await decryptExportedSentinelReplay(await exportRoundTrip(storedPartial, kv), keyBytes);
    assert.deepEqual(partialPlaintext.upstream, partial);
  } finally {
    kv.close();
    setKvForTest(null);
  }
});

test("strict v2 metadata: invalid upstream traces are rejected and tampered ciphertext fails closed", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
  const now = () => 1_700_000_000_000;
  const input = syntheticInput(encoder.encode('{"model":"gpt-5.6-sol","stream":false,"input":"tamper"}'), "v2-tamper");
  const encoderTrace = () => {
    const recorder = createSentinelUpstreamRecorder();
    recorder.startAttempt("chatgpt_codex").wrap(new Response("upstream-500", { status: 500, headers: { "Content-Type": "application/json" } }));
    const trace = recorder.snapshotAndSeal();
    recorder.dispose();
    return trace;
  };
  try {
    const trace = encoderTrace();
    // A tainted upstream trace must fail closed at persistence.
    const tainted = trace as unknown as Record<string, unknown>;
    await assert.rejects(
      persistEncryptedSentinelReplay(
        {
          ...input,
          upstream: {
            ...tainted,
            attempts: [
              {
                ...(tainted.attempts as Record<string, unknown>[])[0],
                status: null,
                content_type: "application/json",
              },
            ],
          },
        } as unknown as AcceptedSentinelReplayInput,
        failureObservation(),
        { kv, keyBytes, now, randomUuid: () => "capture-taint" }
      )
    );
    // A truthful capture round-trips, then an authenticated tamper fails closed.
    const stored = await persistEncryptedSentinelReplay({ ...input, upstream: trace }, failureObservation(), {
      kv,
      keyBytes,
      now,
      randomUuid: () => "capture-tamper",
      randomBytes: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    });
    assert.equal(stored.status, "stored");
    const good = await exportRoundTrip(stored, kv);
    const tampered: ExportedSentinelReplayCapture = {
      manifest: good.manifest,
      chunks: good.chunks.map((chunk, index) => {
        if (index !== 0) return chunk;
        const bytes = base64UrlDecode(chunk);
        bytes[0] ^= 0xff;
        return base64UrlEncode(bytes);
      }),
    };
    await assert.rejects(decryptExportedSentinelReplay(tampered, keyBytes));
  } finally {
    kv.close();
    setKvForTest(null);
  }
});

test("request-only inputs emit the required empty upstream trace and never claim coverage", async () => {
  const empty = emptySentinelUpstreamTrace();
  assert.deepEqual(empty.attempts, []);
  assert.equal(empty.attempts_truncated, false);
  assert.equal(empty.bytes_truncated, false);
  assert.equal(empty.chunks_truncated, false);
  assert.equal(JSON.stringify(empty).includes("captured"), false);
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  try {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;
    const input = syntheticInput(encoder.encode('{"input":"request-only"}'), "request-only-empty-trace");
    const stored = await persistEncryptedSentinelReplay(input, failureObservation(), {
      kv,
      keyBytes,
      now: () => 1_700_000_000_000,
      randomUuid: () => "request-only-capture",
    });
    assert.equal(stored.status, "stored");
    const plaintext = await decryptExportedSentinelReplay(await exportRoundTrip(stored, kv), keyBytes);
    assert.deepEqual(plaintext.upstream, empty);
  } finally {
    kv.close();
    setKvForTest(null);
  }
});
