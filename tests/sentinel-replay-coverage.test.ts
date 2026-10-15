import { test } from "bun:test";
import { type AtomicOperation, type Kv, type KvKey } from "#kv";
/**
 * Coverage tests for the Sentinel replay store and incident outbox.
 *
 * These tests exercise the real modules through their exported surface: the
 * persistence entry points take their KV, key bytes, clock and randomization
 * explicitly, so every assertion here is about what the modules actually wrote,
 * returned or rejected — never about a mock's call log. Storage is the
 * runtime's own `:memory:` KV when `--unstable-kv` is present, otherwise the
 * CAS-faithful in-memory substitute in tests/helpers/sentinel-kv-stub.ts.
 */

import assert from "node:assert/strict";
import { setKvForTest } from "../src/kv.ts";
import {
  AES_GCM_IV_BYTES,
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_DEDUPE_PREFIX,
  SENTINEL_REPLAY_MANIFEST_PREFIX,
  SENTINEL_REPLAY_REQUEST_PREFIX,
  SENTINEL_REPLAY_TTL_MS,
  requestStatusKey,
} from "../src/sentinel/replay-model.ts";
import {
  persistEncryptedSentinelReplay,
  persistSentinelReplayFromEnvironment,
  recordSentinelReplayOmissionFromEnvironment,
  writeSentinelReplayCaptureStatus,
} from "../src/sentinel/replay-store.ts";
import { decryptExportedSentinelReplay, listEncryptedSentinelIncidentReplays, readSentinelReplayCaptureStatus } from "../src/sentinel/replay-read.ts";
import {
  bindSentinelIncidentIndexEvidence,
  classifySentinelIncidentTerminal,
  completeSentinelIncidentFailureEvent,
  createSentinelIncidentFailureEvent,
  createSentinelIncidentFailureEventFromEnvironment,
  isSentinelIncidentCaptureReference,
  isSentinelIncidentId,
  isSentinelIncidentIndexEvidenceRef,
  isSentinelIncidentIndexEndpoint,
  isSentinelIncidentIndexRow,
  isSentinelIncidentFailureEvent,
  isSentinelIncidentTerminalCategory,
  isSentinelProductionRuntime,
  linkSentinelReplayToIncident,
  listSentinelIncidentIndexRows,
  normalizeSentinelIncidentEndpoint,
  normalizeSentinelIncidentMethod,
  readySentinelIncidentFailureEvent,
  recordSentinelIncidentIndexObservation,
  recordSentinelProviderDegradation,
  recordSentinelProviderDegradationFromEnvironment,
  SENTINEL_INCIDENT_CAPTURE_REF_PREFIX,
  SENTINEL_INCIDENT_EVENT_PREFIX,
  SENTINEL_INCIDENT_INDEX_PREFIX,
  SENTINEL_INCIDENT_INDEX_MAX_PAGE_LIMIT,
  sentinelIncidentClassification,
  sentinelIncidentFingerprint,
} from "../src/sentinel/incident-outbox.ts";
import type { SentinelClientFailureObservation, SentinelFailureObservation } from "../src/sentinel/replay-model.ts";
import { SentinelKvStub, openSentinelTestKv } from "./helpers/sentinel-kv-stub.ts";

const encoder = new TextEncoder();
const KEY_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array(32).fill(0x5a);
const NOW = 1_800_000_000_000;
const GIT_SHA = "b".repeat(40);
const INCIDENT_UUID = "12345678-1234-4abc-8def-1234567890ab";
/** Documentation-range client address (RFC 5737 TEST-NET-2), exactly as tests/images.test.ts fixtures use it. */
const CLIENT_ADDRESS = "198.51.100.7";

const twelveByteIv = (): Uint8Array<ArrayBuffer> => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

const internalObservation = (overrides: Partial<SentinelFailureObservation> = {}): SentinelFailureObservation => ({
  status: 502,
  stream: false,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  synthetic_terminal_type: null,
  provider_route: "test-provider",
  ...overrides,
});

const clientObservation = (overrides: Partial<SentinelClientFailureObservation> = {}): SentinelClientFailureObservation => ({
  status: 502,
  stream: false,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  framing_valid: true,
  provider_route: "test-provider",
  error_code: null,
  error_param: null,
  terminal_body_base64: null,
  terminal_body_truncated: false,
  ...overrides,
});

const replayInput = (body: string, requestId: string) => ({
  endpoint: "/v1/responses",
  method: "POST",
  body: encoder.encode(body) as Uint8Array<ArrayBuffer>,
  content_type: "application/json",
  compatibility_headers: {},
  request_id: requestId,
  git_sha: GIT_SHA,
  deno_revision: "test-deno-revision",
});

const storeDependencies = (kv: Kv, overrides: Partial<Parameters<typeof persistEncryptedSentinelReplay>[2]> = {}) => ({
  kv,
  keyBytes: KEY_BYTES,
  now: () => NOW,
  randomUuid: () => "capture-1",
  randomBytes: twelveByteIv,
  ...overrides,
});

/** One recorded upstream trace, built through the real recorder. */
const recordedTrace = async (body: string) => {
  const { createSentinelUpstreamRecorder } = await import("../src/sentinel/upstream-capture.ts");
  const recorder = createSentinelUpstreamRecorder();
  const handle = recorder.startAttempt("cerebras");
  const wrapped = handle.wrap(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
  await wrapped.arrayBuffer();
  const trace = recorder.snapshotAndSeal();
  recorder.dispose();
  return trace;
};

const closeKv = (kv: Kv): void => {
  try {
    kv.close();
  } catch {
    // The stub and a real in-memory KV both allow an idempotent close.
  }
};

/** Runs `fn` with an explicitly unavailable KV binding. */
const withoutRuntimeKv = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    setKvForTest(null);
    return await fn();
  } finally {
    setKvForTest(null);
  }
};

/**
 * A store whose every atomic commit loses the CAS race. Each chained call stays
 * on the wrapper, so the outcome does not depend on which operation the caller
 * happens to chain first.
 */
const alwaysConflictingKv = (kv: Kv): Kv => {
  const failingOperation = (operation: AtomicOperation): AtomicOperation =>
    new Proxy(operation, {
      get(target, property) {
        if (property === "commit") return () => Promise.resolve({ ok: false });
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => failingOperation(Reflect.apply(value, target, args) as AtomicOperation);
      },
    });
  return new Proxy(kv, {
    get(target, property) {
      if (property === "atomic") return () => failingOperation(target.atomic());
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const requestKeys = async (kv: Kv): Promise<KvKey[]> => {
  const keys: KvKey[] = [];
  for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_REQUEST_PREFIX })) keys.push([...entry.key]);
  return keys;
};

test("capture status rows are validated on write", async () => {
  const kv = await openSentinelTestKv();
  const valid = {
    version: 1 as const,
    request_id: "status-row-request",
    status: "ready" as const,
    reason: null,
    captured_at_ms: NOW,
    manifest_key: [...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, "d".repeat(64), "capture-1"],
    fingerprint: "d".repeat(64),
    expires_at_ms: NOW + SENTINEL_REPLAY_TTL_MS,
  };
  const invalidRows: unknown[] = [
    { ...valid, version: 2 },
    { ...valid, request_id: "bad request id" },
    { ...valid, status: "unknown" },
    { ...valid, status: "expired" },
    { ...valid, reason: "not a reason" },
    { ...valid, captured_at_ms: -1 },
    { ...valid, captured_at_ms: 1.5 },
    { ...valid, manifest_key: [...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW] },
    { ...valid, fingerprint: "not-hex" },
    { ...valid, expires_at_ms: 1.5 },
    { ...valid, manifest_key: null },
    { ...valid, status: "disabled" },
  ];
  try {
    for (const row of invalidRows) {
      // Stored rows are untrusted input on the way back in: the writer's own
      // validator is the boundary these records are fed through.
      const untrusted: unknown = JSON.parse(JSON.stringify(row));
      await assert.rejects(() => writeSentinelReplayCaptureStatus(kv, untrusted as typeof valid), /Sentinel replay capture status is invalid/);
    }
    assert.deepEqual(await requestKeys(kv), []);
    await writeSentinelReplayCaptureStatus(kv, valid);
    const stored = await readSentinelReplayCaptureStatus(kv, valid.request_id, NOW);
    assert.equal(stored.status, "ready");
    assert.equal(stored.reason, null);
  } finally {
    closeKv(kv);
  }
});

test("an omitted capture publishes a bounded status row and never replaces the caller's outcome", async () => {
  const kv = await openSentinelTestKv();
  try {
    setKvForTest(kv);
    await recordSentinelReplayOmissionFromEnvironment("bad request id", "body_over_limit", NOW);
    assert.deepEqual(await requestKeys(kv), []);

    await recordSentinelReplayOmissionFromEnvironment("omitted-request", "body_over_limit", NOW);
    const omitted = await readSentinelReplayCaptureStatus(kv, "omitted-request", NOW);
    assert.equal(omitted.status, "disabled");
    assert.equal(omitted.reason, "body_over_limit");
    assert.equal(omitted.captured_at_ms, NOW);
    assert.equal(omitted.manifest_key, null);
    assert.equal(omitted.expires_at_ms, null);

    // A storage failure is diagnostic only: the call still resolves. The
    // status row is committed through kv.atomic(), so this unwritable seam
    // must fail that channel as well as the plain kv.set path; no row may be
    // written when storage fails.
    const failingKv = new Proxy(alwaysConflictingKv(kv), {
      get(target, property) {
        if (property === "set") return () => Promise.reject(new Error("storage unavailable"));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    setKvForTest(failingKv);
    await recordSentinelReplayOmissionFromEnvironment("unwritable-request", "rejected_before_capture", NOW);
    assert.deepEqual(await requestKeys(kv), [["uos_ai", "sentinel_replay", "v1", "request", "omitted-request"]]);
  } finally {
    setKvForTest(null);
    closeKv(kv);
  }

  await withoutRuntimeKv(async () => {
    await recordSentinelReplayOmissionFromEnvironment("runtime-less-request", "body_unavailable", NOW);
  });
});

test("environment persistence reports how it was disabled and zeroes the request body", async () => {
  const failure = internalObservation();

  await withoutRuntimeKv(async () => {
    const input = replayInput('{"model":"gpt-5"}', "env-kv-unavailable");
    const result = await persistSentinelReplayFromEnvironment(input, failure);
    assert.deepEqual(result, { status: "disabled", reason: "kv_unavailable" });
    // The request-owned buffer is zeroed on every exit path, including the
    // one where no storage or key was available at all.
    assert.deepEqual([...input.body], new Array(input.body.byteLength).fill(0));
  });

  const kv = await openSentinelTestKv();
  try {
    setKvForTest(kv);
    const client = clientObservation({ terminal_body_base64: btoa("upstream failed") });
    const input = replayInput('{"model":"gpt-5","stream":false}', "env-key-missing");
    const result = await persistSentinelReplayFromEnvironment(input, failure, client);
    assert.deepEqual(result, { status: "disabled", reason: "key_missing" });
    // The request body is zeroed whatever the outcome.
    assert.deepEqual([...input.body], new Array(input.body.byteLength).fill(0));

    const status = await readSentinelReplayCaptureStatus(kv, input.request_id);
    assert.equal(status.status, "disabled");
    assert.equal(status.reason, "key_missing");
    assert.equal(status.fingerprint, null);

    // The durable index observation is recorded before the key lookup, so a
    // missing key still leaves a discoverable row without evidence.
    const indexFingerprint = await sentinelIncidentFingerprint({ endpoint: input.endpoint, method: input.method, observation: client });
    const indexRow = await kv.get<{ evidence_ref: unknown; count: number }>([...SENTINEL_INCIDENT_INDEX_PREFIX, indexFingerprint]);
    assert.ok(indexRow.value, "the index observation must be durable");
    assert.equal(indexRow.value.evidence_ref, null);
    assert.equal(indexRow.value.count, 1);

    // A successful request is never persisted, and no status row is written
    // for a request id that could not be recorded.
    const localOnly = replayInput('{"model":"gpt-5"}', "env-successful-request");
    await assert.rejects(
      () =>
        persistSentinelReplayFromEnvironment(
          localOnly,
          internalObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: null }),
          clientObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: null })
        ),
      /A successful request cannot be persisted as a sentinel replay/
    );
    assert.deepEqual([...localOnly.body], new Array(localOnly.body.byteLength).fill(0));

    const unnameable = replayInput('{"model":"gpt-5"}', "bad request id");
    const unnameableResult = await persistSentinelReplayFromEnvironment(unnameable, failure, client);
    assert.deepEqual(unnameableResult, { status: "disabled", reason: "key_missing" });
    assert.deepEqual(
      (await requestKeys(kv)).map((key) => key.at(-1)),
      ["env-key-missing"]
    );
  } finally {
    setKvForTest(null);
    closeKv(kv);
  }
});

test("an index write failure is reported as deferred without changing the persist outcome", async () => {
  const kv = await openSentinelTestKv();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  // The index observation is the first storage write: failing it must leave
  // the disabled outcome intact and must be announced, never silent.
  const failingKv = new Proxy(kv, {
    get(target, property) {
      // A synchronous throw keeps the failure on the awaited call path: no
      // rejected promise can be orphaned away from the caller's try block.
      if (property === "atomic")
        return () => {
          throw new Error("index unavailable");
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value)).join(" "));
  };
  try {
    setKvForTest(failingKv);
    const input = replayInput('{"model":"gpt-5"}', "env-index-failure");
    const result = await persistSentinelReplayFromEnvironment(input, internalObservation(), clientObservation({ terminal_body_base64: btoa("x") }));
    assert.deepEqual(result, { status: "disabled", reason: "key_missing" });
    assert.deepEqual([...input.body], new Array(input.body.byteLength).fill(0));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /sentinel_incident/);
    assert.match(warnings[0] ?? "", /index_write_failed/);
  } finally {
    console.warn = originalWarn;
    setKvForTest(null);
    closeKv(kv);
  }
});

test("in-memory sentinel KV keeps Deno's versionstamp CAS, ordering and cursor contract", async () => {
  const kv = new SentinelKvStub();
  assert.deepEqual(await kv.get(["absent"]), { key: ["absent"], value: null, versionstamp: null });

  await kv.set(["m", 2], "two");
  await kv.set(["m", "b"], "string-b");
  await kv.set(["m", 10], "ten");
  const ordered: KvKey[] = [];
  for await (const entry of kv.list({ prefix: ["m"] })) ordered.push(entry.key);
  assert.deepEqual(ordered, [
    ["m", "b"],
    ["m", 2],
    ["m", 10],
  ]);

  // Stored values are snapshots: mutating the caller's buffer must not
  // rewrite what a later read observes.
  const original = new Uint8Array([1, 2, 3]);
  await kv.set(["bytes"], original);
  original.fill(9);
  assert.deepEqual(await kv.get<Uint8Array>(["bytes"]).then((entry) => [...(entry.value ?? new Uint8Array())]), [1, 2, 3]);

  // A cursor resumes strictly after the last yielded entry and is exhausted
  // into the empty cursor Deno KV reports.
  const pageKeys = async (cursor?: string): Promise<KvKey[]> => {
    const keys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: ["m"] }, { cursor, limit: 1 })) keys.push([...entry.key]);
    return keys;
  };
  assert.deepEqual(await pageKeys(), [["m", "b"]]);
  // A consumer that stops after one entry gets the cursor that resumes at
  // the next key; only a page read to its end reports the empty cursor.
  const firstPage = kv.list({ prefix: ["m"] }, { limit: 1 });
  for await (const entry of firstPage) {
    assert.deepEqual([...entry.key], ["m", "b"]);
    break;
  }
  assert.deepEqual(await pageKeys(firstPage.cursor), [["m", 2]]);
  const exhausted = kv.list({ prefix: ["m"] }, { limit: 10 });
  let consumedPageEntries = 0;
  for await (const entry of exhausted) {
    assert.equal(entry.key[0], "m");
    consumedPageEntries += 1;
  }
  assert.equal(consumedPageEntries, 3);
  assert.equal(exhausted.cursor, "");

  // `start` is inclusive, exactly as the export scanner assumes.
  const fromStart = kv.list({ prefix: ["m"], start: ["m", 2] }, { limit: 10 });
  const started: KvKey[] = [];
  for await (const entry of fromStart) started.push(entry.key);
  assert.deepEqual(started, [
    ["m", 2],
    ["m", 10],
  ]);

  // CAS: a check against an absent key succeeds once, then conflicts.
  const create = await kv
    .atomic()
    .check({ key: ["cas"], versionstamp: null })
    .set(["cas"], "first")
    .commit();
  assert.equal(create.ok, true);
  const stale = await kv
    .atomic()
    .check({ key: ["cas"], versionstamp: null })
    .set(["cas"], "second")
    .commit();
  assert.equal(stale.ok, false);
  assert.equal((await kv.get<string>(["cas"])).value, "first");
  const versionstamp = (await kv.get<string>(["cas"])).versionstamp;
  const matched = await kv
    .atomic()
    .check({ key: ["cas"], versionstamp })
    .set(["cas"], "third")
    .commit();
  assert.equal(matched.ok, true);
  assert.equal((await kv.get<string>(["cas"])).value, "third");

  const many = await kv.getMany([["cas"], ["absent"]]);
  assert.equal(many.length, 2);
  assert.equal(many[0].value, "third");
  assert.deepEqual(many[1], { key: ["absent"], value: null, versionstamp: null });

  await kv.delete(["cas"]);
  assert.equal((await kv.get(["cas"])).value, null);
  kv.close();
});

test("a request-only capture is stored with its dedupe, manifest, chunk and status rows", async () => {
  const kv = await openSentinelTestKv();
  setKvForTest(kv);
  try {
    const input = replayInput('{"model":"gpt-5","stream":false}', "store-basic-request");
    const stored = await persistEncryptedSentinelReplay(input, internalObservation(), storeDependencies(kv));
    // The assertion narrows the result to the stored variant for the reads below.
    assert.equal(stored.status, "stored");
    assert.equal(stored.manifest.version, 1);
    assert.equal(stored.manifest.capture_id, "capture-1");
    assert.equal(stored.manifest.algorithm, "AES-256-GCM");
    assert.equal(stored.manifest.compression, "gzip");
    assert.equal(stored.manifest.captured_at_ms, NOW);
    assert.equal(stored.manifest.expires_at_ms, NOW + SENTINEL_REPLAY_TTL_MS);
    assert.equal(stored.manifest.chunk_count, 1);
    assert.match(stored.manifest.iv, /^[A-Za-z0-9_-]{16}$/);
    assert.deepEqual(stored.manifest_key, [...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, stored.manifest.fingerprint, "capture-1"]);

    // The dedupe row is the only thing a second identical request can see.
    const dedupe = await kv.get<{ manifest_key: KvKey }>([...SENTINEL_REPLAY_DEDUPE_PREFIX, stored.manifest.fingerprint]);
    assert.deepEqual(dedupe.value?.manifest_key, stored.manifest_key);
    const chunk = await kv.get<Uint8Array>([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-1", 0]);
    assert.ok(chunk.value instanceof Uint8Array);
    assert.equal(chunk.value.byteLength, stored.manifest.ciphertext_bytes);

    // The request id resolves to its own status row, and to the capture.
    const status = await readSentinelReplayCaptureStatus(kv, input.request_id);
    assert.equal(status.status, "incomplete");
    assert.equal(status.reason, null);
    assert.equal(status.fingerprint, stored.manifest.fingerprint);
    assert.equal(status.expires_at_ms, NOW + SENTINEL_REPLAY_TTL_MS);

    const listed = await listEncryptedSentinelIncidentReplays(kv, { incidentId: `provider-${INCIDENT_UUID}` });
    assert.deepEqual(listed.captures, []);

    // The stored envelope decrypts back to the exact accepted request.
    const manifestEntry = await kv.get<typeof stored.manifest>(stored.manifest_key);
    assert.ok(manifestEntry.value);
    const chunks = await kv.get<Uint8Array>([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-1", 0]);
    const { base64UrlEncode } = await import("../src/utils.ts");
    assert.ok(chunks.value);
    const plaintext = await decryptExportedSentinelReplay({ manifest: manifestEntry.value, chunks: [base64UrlEncode(chunks.value)] }, KEY_BYTES);
    assert.equal(plaintext.version, 3);
    assert.equal(plaintext.endpoint, input.endpoint);
    assert.equal(plaintext.method, "POST");
    assert.equal(plaintext.request_id, input.request_id);
    assert.equal(plaintext.git_sha, GIT_SHA);
    assert.deepEqual([...plaintext.body], [...input.body]);
    assert.equal(plaintext.capture_status, "incomplete");
    assert.equal(plaintext.replay_coverage, "unavailable");
    assert.deepEqual(plaintext.unavailable, ["upstream_trace_empty", "downstream_terminal_body_unavailable"]);
    assert.deepEqual(plaintext.upstream.attempts, []);
    assert.ok(plaintext.settings, "a version-3 capture seals its request settings");
    assert.equal(plaintext.settings.source, "recorded_request_body");
    assert.equal(plaintext.settings.model_requested, "gpt-5");
    assert.equal(plaintext.settings.stream_requested, false);
    assert.equal(plaintext.observation.failure_kind, "upstream_timeout");
    assert.equal(plaintext.client_observation.terminal_type, "http.error");
  } finally {
    setKvForTest(null);
    closeKv(kv);
  }
});

test("a captured trace binds the durable index row, the incident event and the capture reference", async () => {
  const kv = await openSentinelTestKv();
  try {
    const client = clientObservation({ terminal_body_base64: btoa("upstream failed"), terminal_body_truncated: false });
    const trace = await recordedTrace('{"error":"upstream failed"}');
    const input = { ...replayInput('{"model":"gpt-5","stream":true}', "store-indexed-request"), upstream: trace };
    const index = await recordSentinelIncidentIndexObservation(kv, {
      endpoint: input.endpoint,
      method: input.method,
      gitSha: GIT_SHA,
      observedAtMs: NOW - 10,
      observation: client,
      classification: { provider: "test-provider", model: null, reasoning: null, failure_kind: "upstream_timeout" },
    });
    const incidentId = index.value.incident_id;
    const event = await createSentinelIncidentFailureEvent(kv, NOW - 5, { randomUuid: () => INCIDENT_UUID });

    const stored = await persistEncryptedSentinelReplay(input, internalObservation(), storeDependencies(kv, { incidentEvent: event }), client);
    assert.equal(stored.status, "stored");
    assert.deepEqual([...index.key], [...SENTINEL_INCIDENT_INDEX_PREFIX, index.value.fingerprint]);

    // The index row keeps its identity and gains this capture's exact evidence.
    const bound = await kv.get<{
      evidence_ref: { ref: string; digest: string };
      failing_revision: string;
      provenance: { captured_at_ms: number };
      evidence_expires_at_ms: number;
    }>(index.key);
    assert.ok(bound.value, "the bound index row must exist");
    assert.equal(bound.value.evidence_ref.ref, "capture:capture-1");
    assert.match(bound.value.evidence_ref.digest, /^[0-9a-f]{64}$/);
    assert.equal(bound.value.failing_revision, GIT_SHA);
    assert.equal(bound.value.provenance.captured_at_ms, NOW);
    assert.equal(bound.value.evidence_expires_at_ms, NOW + SENTINEL_REPLAY_TTL_MS);

    // The outbox event and the incident capture reference are both durable.
    const eventEntry = await kv.get<{ state: string; capture_status: string; capture_fingerprint: string; manifest_key: KvKey; ready_at_ms: number }>(
      event.key
    );
    assert.ok(eventEntry.value, "the outbox event must exist");
    assert.equal(eventEntry.value.state, "ready");
    assert.equal(eventEntry.value.capture_status, "stored");
    assert.equal(eventEntry.value.capture_fingerprint, stored.manifest.fingerprint);
    assert.deepEqual(eventEntry.value.manifest_key, [...(stored.manifest_key ?? [])]);
    assert.equal(eventEntry.value.ready_at_ms, NOW);
    const reference = await kv.get<{ version: number; manifest_key: KvKey }>([
      ...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX,
      incidentId,
      stored.manifest.fingerprint,
    ]);
    assert.deepEqual(reference.value, { version: 1, manifest_key: [...(stored.manifest_key ?? [])] });

    // Listing by incident returns exactly that capture, and it decrypts to
    // the accepted request plus the recorded upstream attempt.
    const listed = await listEncryptedSentinelIncidentReplays(kv, { incidentId });
    assert.equal(listed.captures.length, 1);
    const capture = listed.captures[0];
    assert.ok(capture);
    const plaintext = await decryptExportedSentinelReplay(capture, KEY_BYTES);
    assert.equal(plaintext.capture_status, "ready");
    assert.equal(plaintext.replay_coverage, "full");
    assert.deepEqual(plaintext.unavailable, []);
    assert.deepEqual(plaintext.upstream, trace);
    assert.deepEqual([...plaintext.body], [...input.body]);
    assert.equal(plaintext.downstream?.terminal_type, "http.error");
    assert.equal(plaintext.client_observation.terminal_body_base64, btoa("upstream failed"));

    const rows = await listSentinelIncidentIndexRows(kv, { incidentId });
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.evidence_ref?.ref, "capture:capture-1");
  } finally {
    closeKv(kv);
  }
});

test("a duplicate capture is settled against the winning manifest without creating evidence", async () => {
  const kv = await openSentinelTestKv();
  try {
    const trace = await recordedTrace('{"error":"upstream failed"}');
    const failure = internalObservation();
    const client = clientObservation({ terminal_body_base64: btoa("upstream failed") });
    const first = await persistEncryptedSentinelReplay(
      { ...replayInput('{"model":"gpt-5"}', "duplicate-first-request"), upstream: trace },
      failure,
      storeDependencies(kv, { randomUuid: () => "capture-winner" }),
      client
    );
    assert.equal(first.status, "stored");

    // A durable index observation appears between the two identical requests.
    const index = await recordSentinelIncidentIndexObservation(kv, {
      endpoint: "/v1/responses",
      method: "POST",
      gitSha: GIT_SHA,
      observedAtMs: NOW,
      observation: client,
      classification: { provider: "test-provider", model: null, reasoning: null, failure_kind: null },
    });
    const duplicateEvent = await createSentinelIncidentFailureEvent(kv, NOW, { randomUuid: () => "99999999-9999-4999-8999-999999999999" });

    const duplicate = await persistEncryptedSentinelReplay(
      { ...replayInput('{"model":"gpt-5"}', "duplicate-second-request"), upstream: trace },
      failure,
      storeDependencies(kv, { randomUuid: () => "capture-loser", incidentEvent: duplicateEvent }),
      client
    );
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.fingerprint, first.manifest.fingerprint);
    assert.deepEqual(duplicate.manifest_key, first.manifest_key);

    // The loser wrote no second capture, but the index row points at the
    // winner's actual ciphertext.
    assert.equal((await kv.get([...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, first.manifest.fingerprint, "capture-loser"])).value, null);
    const bound = await kv.get<{ evidence_ref: { ref: string } | null }>(index.key);
    assert.equal(bound.value?.evidence_ref?.ref, "capture:capture-winner");
    const reference = await kv.get([...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, index.value.incident_id, first.manifest.fingerprint]);
    assert.deepEqual(reference.value, { version: 1, manifest_key: [...(first.manifest_key ?? [])] });

    const eventEntry = await kv.get<{ state: string; capture_status: string }>(duplicateEvent.key);
    assert.ok(eventEntry.value, "the duplicate request must settle its own outbox event");
    assert.equal(eventEntry.value.state, "ready");
    assert.equal(eventEntry.value.capture_status, "duplicate");

    // The duplicate request still resolves to the winning capture.
    const status = await readSentinelReplayCaptureStatus(kv, "duplicate-second-request");
    assert.equal(status.status, "ready");
    assert.deepEqual(status.manifest_key, [...(first.manifest_key ?? [])]);
    assert.equal(status.fingerprint, first.manifest.fingerprint);
  } finally {
    closeKv(kv);
  }
});

test("a duplicate without a durable index row binds nothing and reports the winner", async () => {
  const kv = await openSentinelTestKv();
  try {
    const failure = internalObservation();
    const client = clientObservation({ terminal_body_base64: btoa("upstream failed") });
    const input = replayInput('{"model":"gpt-5","stream":false}', "unindexed-first-request");
    const first = await persistEncryptedSentinelReplay(input, failure, storeDependencies(kv, { randomUuid: () => "capture-unindexed" }), client);
    assert.equal(first.status, "stored");

    const duplicate = await persistEncryptedSentinelReplay(
      { ...input, request_id: "unindexed-second-request" },
      failure,
      storeDependencies(kv, { randomUuid: () => "capture-unindexed-loser" }),
      client
    );
    assert.equal(duplicate.status, "duplicate");
    const indexFingerprint = await sentinelIncidentFingerprint({ endpoint: input.endpoint, method: input.method, observation: client });
    assert.equal((await kv.get([...SENTINEL_INCIDENT_INDEX_PREFIX, indexFingerprint])).value, null);
    assert.equal(await listEncryptedSentinelIncidentReplays(kv, { incidentId: `provider-${INCIDENT_UUID}` }).then((listed) => listed.captures.length), 0);
    const status = await readSentinelReplayCaptureStatus(kv, "unindexed-second-request");
    assert.equal(status.status, "incomplete");
    assert.equal(status.fingerprint, first.manifest.fingerprint);
  } finally {
    closeKv(kv);
  }
});

test("a duplicate against a corrupt index row fails closed on the first read", async () => {
  const kv = await openSentinelTestKv();
  try {
    const failure = internalObservation();
    const client = clientObservation({ terminal_body_base64: btoa("upstream failed") });
    const input = replayInput('{"model":"gpt-5"}', "corrupt-index-first");
    const first = await persistEncryptedSentinelReplay(input, failure, storeDependencies(kv, { randomUuid: () => "capture-corrupt-index" }), client);
    assert.equal(first.status, "stored");

    const indexFingerprint = await sentinelIncidentFingerprint({ endpoint: input.endpoint, method: input.method, observation: client });
    await kv.set([...SENTINEL_INCIDENT_INDEX_PREFIX, indexFingerprint], { version: 1, incident_id: "not-an-incident" });
    await assert.rejects(
      () => persistEncryptedSentinelReplay({ ...input, request_id: "corrupt-index-second" }, failure, storeDependencies(kv), client),
      /Sentinel incident index record is invalid/
    );
    // The winning capture is untouched by the rejected duplicate.
    assert.ok((await kv.get([...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, first.manifest.fingerprint, "capture-corrupt-index"])).value);
  } finally {
    closeKv(kv);
  }
});

test("a corrupt index row rejects the whole store attempt and cleans up its chunks", async () => {
  const kv = await openSentinelTestKv();
  try {
    const client = clientObservation({ terminal_body_base64: btoa("upstream failed") });
    const input = replayInput('{"model":"gpt-5"}', "corrupt-index-store");
    const indexFingerprint = await sentinelIncidentFingerprint({ endpoint: input.endpoint, method: input.method, observation: client });
    await kv.set([...SENTINEL_INCIDENT_INDEX_PREFIX, indexFingerprint], { version: 1 });

    await assert.rejects(
      () => persistEncryptedSentinelReplay(input, internalObservation(), storeDependencies(kv, { randomUuid: () => "capture-corrupt-store" }), client),
      /Sentinel incident index record is invalid/
    );
    assert.equal((await kv.get([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-corrupt-store", 0])).value, null);
    const manifestKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_MANIFEST_PREFIX })) manifestKeys.push([...entry.key]);
    assert.deepEqual(manifestKeys, []);
    const dedupeEntries: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_DEDUPE_PREFIX })) dedupeEntries.push([...entry.key]);
    assert.deepEqual(dedupeEntries, []);
  } finally {
    closeKv(kv);
  }
});

test("an unusable dedupe record and an exhausted CAS both fail closed", async () => {
  const kv = await openSentinelTestKv();
  try {
    const failure = internalObservation();
    const client = clientObservation({ terminal_body_base64: btoa("upstream failed") });
    const input = replayInput('{"model":"gpt-5"}', "invalid-dedupe-request");
    const probe = await persistEncryptedSentinelReplay(input, failure, storeDependencies(kv, { randomUuid: () => "capture-invalid-dedupe" }), client);
    assert.equal(probe.status, "stored");
    await kv.set([...SENTINEL_REPLAY_DEDUPE_PREFIX, probe.manifest.fingerprint], { manifest_key: "not-a-key" });
    await assert.rejects(
      () =>
        persistEncryptedSentinelReplay(
          { ...input, request_id: "invalid-dedupe-second" },
          failure,
          storeDependencies(kv, { randomUuid: () => "capture-invalid-dedupe-2" }),
          client
        ),
      /Sentinel replay dedupe record is invalid/
    );

    // A reservation commit that never lands leaves no chunks and no manifest
    // behind: accounting is already bootstrap-complete here, so the bounded
    // reservation retries are exhausted and admission reports storage_full
    // instead of staging unaccounted bytes, exactly as PR437's fallthrough does.
    const failingKv = alwaysConflictingKv(kv);
    const refused = await persistEncryptedSentinelReplay(
      replayInput('{"model":"gpt-5-lost-cas"}', "lost-cas-request"),
      failure,
      storeDependencies(failingKv, { randomUuid: () => "capture-lost-cas" }),
      client
    );
    assert.deepEqual(refused, { status: "incomplete", reason: "storage_full" });
    assert.equal((await kv.get([...SENTINEL_REPLAY_CHUNK_PREFIX, "capture-lost-cas", 0])).value, null);
    const manifestKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_MANIFEST_PREFIX })) manifestKeys.push([...entry.key]);
    assert.deepEqual(
      manifestKeys.map((key) => key.at(-1)),
      ["capture-invalid-dedupe"]
    );
  } finally {
    closeKv(kv);
  }
});

test("store inputs that cannot represent a failure are rejected before any write", async () => {
  const kv = await openSentinelTestKv();
  try {
    const client = clientObservation();
    const input = replayInput('{"model":"gpt-5"}', "rejected-store-request");

    await assert.rejects(
      () => persistEncryptedSentinelReplay(input, internalObservation(), storeDependencies(kv, { keyBytes: new Uint8Array(31) }), client),
      /Sentinel replay key must be 32 bytes/
    );
    await assert.rejects(
      () =>
        persistEncryptedSentinelReplay(
          { ...input, compatibility_headers: { "x-forwarded-for": CLIENT_ADDRESS } },
          internalObservation(),
          storeDependencies(kv),
          client
        ),
      /Sentinel replay compatibility headers contain a disallowed value/
    );
    await assert.rejects(
      () =>
        persistEncryptedSentinelReplay(
          input,
          internalObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: null }),
          storeDependencies(kv),
          clientObservation({ status: 200, completed: true, terminal_type: "response.completed", failure_kind: null })
        ),
      /A successful request cannot be persisted as a sentinel replay/
    );
    await assert.rejects(
      () =>
        persistEncryptedSentinelReplay(
          input,
          internalObservation(),
          storeDependencies(kv, { randomBytes: () => new Uint8Array(AES_GCM_IV_BYTES - 1) }),
          client
        ),
      /Sentinel replay IV must be 12 bytes/
    );
    // Nothing above may have written to storage.
    const keys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: ["uos_ai", "sentinel_replay"] })) keys.push([...entry.key]);
    assert.deepEqual(keys, []);
  } finally {
    closeKv(kv);
  }
});

test("incident outbox events are created, completed and conflict-checked", async () => {
  const kv = await openSentinelTestKv();
  const fingerprint = "e".repeat(64);
  const manifestKey: KvKey = [...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, fingerprint, "capture-1"];
  try {
    for (const timestamp of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(() => createSentinelIncidentFailureEvent(kv, timestamp), /Sentinel incident timestamp is invalid/);
    }
    await assert.rejects(() => createSentinelIncidentFailureEvent(kv, NOW, { randomUuid: () => "not-a-uuid" }), /Sentinel incident UUID is invalid/);

    // A runtime UUID is accepted in any case and normalized to lower case.
    const event = await createSentinelIncidentFailureEvent(kv, NOW, { randomUuid: () => INCIDENT_UUID.toUpperCase() });
    assert.equal(event.value.incident_id, `provider-${INCIDENT_UUID}`);
    assert.equal(event.value.state, "capturing");
    assert.equal(event.value.capture_status, "pending");
    assert.deepEqual(event.key, [...SENTINEL_INCIDENT_EVENT_PREFIX, `provider-${INCIDENT_UUID}`]);
    assert.equal(isSentinelIncidentFailureEvent(event.value), true);
    await assert.rejects(
      () => createSentinelIncidentFailureEvent(kv, NOW, { randomUuid: () => INCIDENT_UUID }),
      /Sentinel incident event identifier conflicted/
    );

    // An unavailable completion keeps the event without evidence.
    const unavailable = readySentinelIncidentFailureEvent(event, NOW + 1, { status: "unavailable" });
    assert.equal(unavailable.state, "ready");
    assert.equal(unavailable.capture_status, "unavailable");
    assert.equal(unavailable.capture_fingerprint, null);
    assert.equal(unavailable.manifest_key, null);
    assert.equal(isSentinelIncidentFailureEvent(unavailable), true);
    assert.throws(
      () => readySentinelIncidentFailureEvent({ ...event, value: unavailable }, NOW + 2, { status: "unavailable" }),
      /Sentinel incident event is not awaiting capture/
    );
    assert.throws(() => readySentinelIncidentFailureEvent(event, NOW - 1, { status: "unavailable" }), /Sentinel incident ready timestamp is invalid/);

    const completed = await completeSentinelIncidentFailureEvent(kv, event, NOW + 1, { status: "duplicate", fingerprint, manifestKey });
    assert.equal(completed, true);
    const stored = await kv.get<{ state: string; capture_status: string; capture_fingerprint: string; manifest_key: KvKey }>(event.key);
    assert.ok(stored.value, "the completed event must exist");
    assert.equal(stored.value.state, "ready");
    assert.equal(stored.value.capture_status, "duplicate");
    assert.equal(stored.value.capture_fingerprint, fingerprint);
    assert.deepEqual(stored.value.manifest_key, manifestKey);
    // The stale entry cannot complete an already completed event.
    assert.equal(await completeSentinelIncidentFailureEvent(kv, event, NOW + 2, { status: "unavailable" }), false);
    assert.equal((await kv.get<{ capture_status: string }>(event.key)).value?.capture_status, "duplicate");

    // Capture references validate their incident id, fingerprint and key.
    assert.equal(isSentinelIncidentCaptureReference({ version: 1, manifest_key: manifestKey }), true);
    assert.equal(isSentinelIncidentCaptureReference({ version: 1, manifest_key: ["short"] }), false);
    assert.equal(isSentinelIncidentCaptureReference({ version: 2, manifest_key: manifestKey }), false);
    assert.equal(isSentinelIncidentId(`provider-${INCIDENT_UUID}`), true);
    assert.equal(isSentinelIncidentId(`provider-${INCIDENT_UUID}`.toUpperCase()), false);
    assert.equal(isSentinelIncidentId(7), false);
    await assert.rejects(() => linkSentinelReplayToIncident(kv, "not-an-incident", fingerprint, manifestKey), /Sentinel incident capture reference is invalid/);
    await assert.rejects(
      () => linkSentinelReplayToIncident(kv, `provider-${INCIDENT_UUID}`, "not-hex", manifestKey),
      /Sentinel incident capture reference is invalid/
    );
    await assert.rejects(
      () => linkSentinelReplayToIncident(kv, `provider-${INCIDENT_UUID}`, fingerprint, ["too", "short"]),
      /Sentinel replay manifest key is invalid/
    );
    await linkSentinelReplayToIncident(kv, `provider-${INCIDENT_UUID}`, fingerprint, manifestKey);
    assert.deepEqual(await kv.get([...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, `provider-${INCIDENT_UUID}`, fingerprint]).then((entry) => entry.value), {
      version: 1,
      manifest_key: manifestKey,
    });
  } finally {
    closeKv(kv);
  }
});

test("provider degradation is recorded and only published in a production runtime", async () => {
  const kv = await openSentinelTestKv();
  const production = {
    get: (name: string) => ({ DENO_DEPLOY_ORG_SLUG: "ubiquity-dao", DENO_DEPLOY_APP_SLUG: "ai-ubq-fi", DENO_TIMELINE: "production" })[name],
  };
  const development = {
    get: (name: string) => ({ DENO_DEPLOY_ORG_SLUG: "ubiquity-dao", DENO_DEPLOY_APP_SLUG: "ai-ubq-fi", DENO_TIMELINE: "development" })[name],
  };
  const degradationUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    assert.equal(isSentinelProductionRuntime(production), true);
    assert.equal(isSentinelProductionRuntime(development), false);
    assert.equal(isSentinelProductionRuntime({ get: () => undefined }), false);

    await assert.rejects(() => recordSentinelProviderDegradation(kv, 0), /Sentinel incident timestamp is invalid/);
    await assert.rejects(() => recordSentinelProviderDegradation(kv, NOW, { randomUuid: () => "nope" }), /Sentinel incident UUID is invalid/);
    const incidentId = await recordSentinelProviderDegradation(kv, NOW, { randomUuid: () => degradationUuid });
    assert.equal(incidentId, `provider-${degradationUuid}`);
    const row = await kv.get<{ state: string; capture_status: string; ready_at_ms: number }>([...SENTINEL_INCIDENT_EVENT_PREFIX, incidentId]);
    assert.ok(row.value, "the degradation event must exist");
    assert.equal(row.value.state, "ready");
    assert.equal(row.value.capture_status, "unavailable");
    assert.equal(row.value.ready_at_ms, NOW);
    await assert.rejects(
      () => recordSentinelProviderDegradation(kv, NOW, { randomUuid: () => degradationUuid }),
      /Sentinel incident event identifier conflicted/
    );

    // The environment entry point refuses a non-production runtime and
    // reports success only when the event really landed.
    assert.equal(await recordSentinelProviderDegradationFromEnvironment(NOW, { environment: development, kv }), false);
    const published = await recordSentinelProviderDegradationFromEnvironment(NOW, {
      environment: production,
      kv,
      randomUuid: () => "ffffffff-ffff-4fff-8fff-ffffffffffff",
    });
    assert.equal(published, true);
    assert.ok(await kv.get([...SENTINEL_INCIDENT_EVENT_PREFIX, "provider-ffffffff-ffff-4fff-8fff-ffffffffffff"]).then((entry) => entry.value));
    assert.equal(await createSentinelIncidentFailureEventFromEnvironment(kv, NOW, development), null);
    const environmentEvent = await createSentinelIncidentFailureEventFromEnvironment(kv, NOW, production);
    assert.equal(environmentEvent?.value.state, "capturing");
  } finally {
    closeKv(kv);
  }
  // Without any runtime storage the environment helper must not claim success.
  await withoutRuntimeKv(async () => {
    assert.equal(await recordSentinelProviderDegradationFromEnvironment(NOW, { environment: production }), false);
  });
});

test("incident classification and index rows are bounded to their fixed categories", async () => {
  const kv = await openSentinelTestKv();
  const observation = { status: 502, stream: false, completed: false, framing_valid: true, terminal_type: "http.error" };
  try {
    assert.equal(classifySentinelIncidentTerminal({ ...observation, stream: true, framing_valid: false }), "stream_framing");
    const terminals: readonly [string | null, string][] = [
      ["http.error", "http_error"],
      ["response.failed", "response_failed"],
      ["response.incomplete", "response_incomplete"],
      ["error", "error"],
      ["deadline", "deadline"],
      ["eof", "eof"],
      ["response.completed", "unknown"],
      [null, "unknown"],
    ];
    for (const [terminalType, expected] of terminals) {
      assert.equal(classifySentinelIncidentTerminal({ ...observation, terminal_type: terminalType }), expected);
      assert.equal(isSentinelIncidentTerminalCategory(expected), true);
    }
    assert.equal(isSentinelIncidentTerminalCategory("not-a-category"), false);
    assert.equal(isSentinelIncidentTerminalCategory(3), false);

    assert.equal(normalizeSentinelIncidentEndpoint("/v1/responses?after_ms=0"), "/v1/responses");
    assert.equal(normalizeSentinelIncidentEndpoint("/v1/chat/completions"), "/v1/chat/completions");
    assert.equal(normalizeSentinelIncidentEndpoint("/v1/embeddings"), "other");
    assert.equal(normalizeSentinelIncidentMethod("POST"), "POST");
    assert.equal(normalizeSentinelIncidentMethod("GET"), "other");
    assert.equal(isSentinelIncidentIndexEndpoint("other"), true);
    assert.equal(isSentinelIncidentIndexEndpoint("/v1/embeddings"), false);
    assert.equal(isSentinelIncidentIndexEndpoint(5), false);

    for (const status of [-1, 600, 1.5, Number.NaN]) {
      assert.throws(
        () => sentinelIncidentClassification({ endpoint: "/v1/responses", method: "POST", observation: { ...observation, status } }),
        /classification status is invalid/
      );
    }
    const classification = sentinelIncidentClassification({ endpoint: "/v1/responses?x=1", method: "GET", observation });
    assert.deepEqual(JSON.parse(classification), {
      endpoint: "/v1/responses",
      method: "other",
      status: 502,
      stream: false,
      completed: false,
      framing_valid: true,
      terminal: "http_error",
    });
    // The fingerprint is stable for the same classification and specific to it.
    const fingerprint = await sentinelIncidentFingerprint({ endpoint: "/v1/responses", method: "POST", observation });
    assert.equal(fingerprint, await sentinelIncidentFingerprint({ endpoint: "/v1/responses", method: "POST", observation }));
    assert.notEqual(
      fingerprint,
      await sentinelIncidentFingerprint({ endpoint: "/v1/responses", method: "POST", observation: { ...observation, status: 500 } })
    );

    assert.equal(isSentinelIncidentIndexEvidenceRef({ ref: "capture:abc", digest: null }), true);
    assert.equal(isSentinelIncidentIndexEvidenceRef({ ref: "capture:abc", digest: "a".repeat(64) }), true);
    assert.equal(isSentinelIncidentIndexEvidenceRef({ ref: "abc", digest: null }), false);
    assert.equal(isSentinelIncidentIndexEvidenceRef({ ref: "capture:abc", digest: "not-hex" }), false);
    assert.equal(isSentinelIncidentIndexEvidenceRef(null), false);

    const seeded = await recordSentinelIncidentIndexObservation(
      kv,
      {
        endpoint: "/v1/responses",
        method: "POST",
        gitSha: GIT_SHA,
        observedAtMs: NOW,
        observation,
        classification: { provider: "cerebras", model: "gpt-5", reasoning: "high", failure_kind: "upstream_timeout" },
      },
      { randomUuid: () => INCIDENT_UUID }
    );
    assert.equal(isSentinelIncidentIndexRow(seeded.value), true);
    const brokenRows: unknown[] = [
      { ...seeded.value, version: 2 },
      { ...seeded.value, incident_id: "provider-nope" },
      { ...seeded.value, fingerprint: "short" },
      { ...seeded.value, severity: "P1" },
      { ...seeded.value, first_seen_at_ms: 0 },
      { ...seeded.value, last_seen_at_ms: NOW - 1 },
      { ...seeded.value, count: 0 },
      { ...seeded.value, failing_revision: "not-a-sha" },
      { ...seeded.value, error_type: "not-a-category" },
      { ...seeded.value, context: { ...seeded.value.context, message: "rewritten" } },
      { ...seeded.value, context: { ...seeded.value.context, location: "here" } },
      { ...seeded.value, context: { ...seeded.value.context, sample: ["raw"] } },
      { ...seeded.value, provenance: { ...seeded.value.provenance, endpoint: "/v1/embeddings" } },
      { ...seeded.value, provenance: { ...seeded.value.provenance, captured_at_ms: -1 } },
      { ...seeded.value, evidence_ref: { ref: "capture:abc", digest: null } },
      { ...seeded.value, latest: { ...seeded.value.latest, status: 600 } },
      { ...seeded.value, latest: { ...seeded.value.latest, revision: "nope" } },
      { ...seeded.value, latest: { ...seeded.value.latest, provider: "has spaces" } },
      { ...seeded.value, latest: { ...seeded.value.latest, reasoning: "r".repeat(33) } },
      { ...seeded.value, latest: { ...seeded.value.latest, terminal: "not-a-category" } },
      { ...seeded.value, latest: { ...seeded.value.latest, stream: "yes" } },
    ];
    for (const broken of brokenRows) {
      const untrusted: unknown = JSON.parse(JSON.stringify(broken));
      assert.equal(isSentinelIncidentIndexRow(untrusted), false);
    }
    assert.equal(isSentinelIncidentIndexRow(null), false);
  } finally {
    closeKv(kv);
  }
});

test("index observations merge into one monotonic group row and reject corrupt storage", async () => {
  const kv = await openSentinelTestKv();
  const observation = { status: 502, stream: false, completed: false, framing_valid: true, terminal_type: "http.error" };
  const input = { endpoint: "/v1/responses", method: "POST", gitSha: GIT_SHA, observedAtMs: NOW, observation };
  try {
    await assert.rejects(() => recordSentinelIncidentIndexObservation(kv, { ...input, observedAtMs: 0 }), /Sentinel incident timestamp is invalid/);
    await assert.rejects(() => recordSentinelIncidentIndexObservation(kv, input, { randomUuid: () => "not-a-uuid" }), /Sentinel incident UUID is invalid/);

    const first = await recordSentinelIncidentIndexObservation(
      kv,
      { ...input, classification: { provider: "cerebras", model: "gpt-5", reasoning: "high", failure_kind: "upstream_timeout" } },
      { randomUuid: () => INCIDENT_UUID }
    );
    assert.equal(first.value.count, 1);
    assert.equal(first.value.severity, "P2");
    assert.equal(first.value.incident_id, `provider-${INCIDENT_UUID}`);
    assert.equal(first.value.first_seen_at_ms, NOW);
    assert.equal(first.value.last_seen_at_ms, NOW);
    assert.equal(first.value.failing_revision, GIT_SHA);
    assert.deepEqual(first.value.context.sample, []);
    assert.equal(first.value.evidence_ref, null);
    assert.ok(first.value.latest, "the first observation carries its classification");
    assert.equal(first.value.latest.model, "gpt-5");
    assert.equal(first.value.latest.reasoning, "high");
    assert.deepEqual(first.key, [...SENTINEL_INCIDENT_INDEX_PREFIX, first.value.fingerprint]);

    // The classification is metadata, not group identity: the same observed
    // failure keeps its incident id while the latest classification refreshes.
    const second = await recordSentinelIncidentIndexObservation(
      kv,
      {
        ...input,
        observedAtMs: NOW + 1_000,
        classification: { provider: "surplus", model: "gpt-5-mini", reasoning: null, failure_kind: null },
      },
      { randomUuid: () => "ignored-uuid" }
    );
    assert.equal(second.value.count, 2);
    assert.equal(second.value.incident_id, first.value.incident_id);
    assert.equal(second.value.first_seen_at_ms, NOW);
    assert.equal(second.value.last_seen_at_ms, NOW + 1_000);
    assert.ok(second.value.latest, "the merge refreshes the latest classification");
    assert.equal(second.value.latest.provider, "surplus");
    assert.equal(second.value.latest.model, "gpt-5-mini");
    assert.equal(second.value.latest.reasoning, null);
    assert.equal(second.value.failing_revision, GIT_SHA);

    // An observation that arrives out of order still counts, but it never
    // replaces the newest recorded classification.
    const third = await recordSentinelIncidentIndexObservation(kv, { ...input, observedAtMs: NOW + 500 });
    assert.equal(third.value.count, 3);
    assert.equal(third.value.last_seen_at_ms, NOW + 1_000);
    assert.equal(third.value.latest?.provider, "surplus");
    assert.equal(third.value.evidence_ref, null);

    await kv.set(first.key, { version: 1 });
    await assert.rejects(() => recordSentinelIncidentIndexObservation(kv, input), /Sentinel incident index record is invalid/);
  } finally {
    closeKv(kv);
  }

  const busyKv = await openSentinelTestKv();
  try {
    // Every CAS attempt loses: the writer must give up rather than count twice.
    const conflicting = alwaysConflictingKv(busyKv);
    await assert.rejects(() => recordSentinelIncidentIndexObservation(conflicting, input), /Sentinel incident index update conflicted repeatedly/);
    assert.equal((await busyKv.get([...SENTINEL_INCIDENT_INDEX_PREFIX, await sentinelIncidentFingerprint(input)])).value, null);
  } finally {
    closeKv(busyKv);
  }
});

test("index pagination is bounded, resumable and fails closed on corrupt rows", async () => {
  const kv = await openSentinelTestKv();
  const observation = { status: 502, stream: false, completed: false, framing_valid: true, terminal_type: "http.error" };
  for (const limit of [0, -1, SENTINEL_INCIDENT_INDEX_MAX_PAGE_LIMIT + 1, 1.5]) {
    await assert.rejects(() => listSentinelIncidentIndexRows(kv, { limit }), /Sentinel incident index pagination is invalid/);
  }
  await assert.rejects(() => listSentinelIncidentIndexRows(kv, { cursor: "not a cursor" }), /Sentinel incident index pagination is invalid/);
  try {
    const incidentIds: string[] = [];
    for (const [index, status] of [502, 503, 504].entries()) {
      const row = await recordSentinelIncidentIndexObservation(
        kv,
        {
          endpoint: index === 2 ? "/v1/chat/completions" : "/v1/responses",
          method: "POST",
          gitSha: GIT_SHA,
          observedAtMs: NOW + index,
          observation: { ...observation, status },
        },
        { randomUuid: () => `${index}${INCIDENT_UUID.slice(1)}` }
      );
      incidentIds.push(row.value.incident_id);
    }

    const singlePage = await listSentinelIncidentIndexRows(kv, {});
    assert.equal(singlePage.rows.length, 3);
    assert.equal(singlePage.cursor, null);

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const listed = await listSentinelIncidentIndexRows(kv, { cursor, limit: 1 });
      collected.push(...listed.rows.map((row) => row.incident_id));
      if (listed.cursor === null) break;
      cursor = listed.cursor;
    }
    const byCodeUnits = (left: string, right: string): number => left.localeCompare(right);
    assert.deepEqual(collected.slice().sort(byCodeUnits), incidentIds.slice().sort(byCodeUnits));

    const filtered = await listSentinelIncidentIndexRows(kv, { incidentId: incidentIds[1] });
    assert.deepEqual(
      filtered.rows.map((row) => row.incident_id),
      [incidentIds[1]]
    );

    // A row whose stored fingerprint disagrees with its own key is corrupt
    // storage, never a silently skipped page.
    const corruptKey = [...SENTINEL_INCIDENT_INDEX_PREFIX, "0".repeat(64)];
    await kv.set(corruptKey, { ...singlePage.rows[0], fingerprint: "1".repeat(64) });
    await assert.rejects(() => listSentinelIncidentIndexRows(kv, {}), /Sentinel incident index record is invalid/);
  } finally {
    closeKv(kv);
  }
});

test("evidence binding is exact, CAS-checked against the winning manifest and persisted atomically", async () => {
  const kv = await openSentinelTestKv();
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
  const referenceFingerprint = "2".repeat(64);
  const digest = "3".repeat(64);
  const manifestKey: KvKey = [...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, referenceFingerprint, "capture-bound"];
  const binding = {
    observedAtMs: NOW,
    captureId: "capture-bound",
    gitSha: GIT_SHA,
    referenceFingerprint,
    manifestKey,
    manifestVersionstamp: null,
    capturedAtMs: NOW,
    digest,
    expiresAtMs: NOW + SENTINEL_REPLAY_TTL_MS,
  };
  try {
    // Every rejection reason in the binding validator is exercised through
    // the real entry point, not through a reach-in.
    const invalidBindings: [string, unknown][] = [
      ["4".repeat(63), binding],
      ["4".repeat(64), { ...binding, referenceFingerprint: "short" }],
      ["4".repeat(64), { ...binding, digest: "not-hex" }],
      ["4".repeat(64), { ...binding, observedAtMs: 0 }],
      ["4".repeat(64), { ...binding, capturedAtMs: 1.5 }],
      ["4".repeat(64), { ...binding, expiresAtMs: -1 }],
      ["4".repeat(64), { ...binding, manifestKey: "not-a-key" }],
      ["4".repeat(64), { ...binding, manifestKey: ["not", "seven", "parts"] }],
      ["4".repeat(64), { ...binding, manifestVersionstamp: 5 }],
    ];
    for (const [indexFingerprint, candidate] of invalidBindings) {
      const untrusted: unknown = JSON.parse(JSON.stringify(candidate));
      await assert.rejects(
        () => bindSentinelIncidentIndexEvidence(kv, indexFingerprint, untrusted as typeof binding),
        /Sentinel incident index evidence binding is invalid/
      );
    }
    await assert.rejects(() => bindSentinelIncidentIndexEvidence(kv, "5".repeat(64), binding), /Sentinel incident index record is missing/);
    await kv.set([...SENTINEL_INCIDENT_INDEX_PREFIX, "6".repeat(64)], { version: 1 });
    await assert.rejects(() => bindSentinelIncidentIndexEvidence(kv, "6".repeat(64), binding), /Sentinel incident index record is invalid/);

    const bound = await bindSentinelIncidentIndexEvidence(kv, row.value.fingerprint, binding);
    assert.ok(bound.value.evidence_ref, "the binding must carry its evidence reference");
    assert.equal(bound.value.evidence_ref.ref, "capture:capture-bound");
    assert.equal(bound.value.evidence_ref.digest, digest);
    assert.equal(bound.value.evidence_expires_at_ms, NOW + SENTINEL_REPLAY_TTL_MS);
    assert.equal(bound.value.provenance.captured_at_ms, NOW);
    assert.equal(bound.value.failing_revision, GIT_SHA);
    assert.deepEqual(await kv.get([...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, row.value.incident_id, referenceFingerprint]).then((entry) => entry.value), {
      version: 1,
      manifest_key: manifestKey,
    });

    // An already-expired binding writes the row but no expiring reference,
    // and a null revision is recorded as absent rather than guessed.
    const expired = await bindSentinelIncidentIndexEvidence(kv, row.value.fingerprint, {
      ...binding,
      gitSha: null,
      referenceFingerprint: "7".repeat(64),
      expiresAtMs: NOW,
    });
    assert.equal(expired.value.failing_revision, null);
    assert.equal(expired.value.evidence_ref?.ref, "capture:capture-bound");
    assert.equal((await kv.get([...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, row.value.incident_id, "7".repeat(64)])).value, null);

    // A manifest versionstamp that no longer matches can never be bound.
    await assert.rejects(
      () =>
        bindSentinelIncidentIndexEvidence(kv, row.value.fingerprint, {
          ...binding,
          referenceFingerprint: "8".repeat(64),
          manifestVersionstamp: "00000000000000000000",
        }),
      /Sentinel incident index evidence binding conflicted repeatedly/
    );
    assert.equal((await kv.get([...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, row.value.incident_id, "8".repeat(64)])).value, null);
  } finally {
    closeKv(kv);
  }
});

test("a request id with no row reads as unknown and a stored row expires at read time", async () => {
  const kv = await openSentinelTestKv();
  try {
    const unknown = await readSentinelReplayCaptureStatus(kv, "never-stored-request", NOW);
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.reason, "no_capture_record");
    assert.equal(unknown.captured_at_ms, NOW);
    assert.equal(unknown.manifest_key, null);

    await assert.rejects(() => readSentinelReplayCaptureStatus(kv, "bad request id"), /Sentinel replay request ID is invalid/);

    await writeSentinelReplayCaptureStatus(kv, {
      version: 1,
      request_id: "expiring-request",
      status: "ready",
      reason: null,
      captured_at_ms: NOW,
      manifest_key: [...SENTINEL_REPLAY_MANIFEST_PREFIX, NOW, "c".repeat(64), "capture-x"],
      fingerprint: "c".repeat(64),
      expires_at_ms: NOW + 1_000,
    });
    const live = await readSentinelReplayCaptureStatus(kv, "expiring-request", NOW + 999);
    assert.equal(live.status, "ready");
    const expired = await readSentinelReplayCaptureStatus(kv, "expiring-request", NOW + 1_000);
    assert.equal(expired.status, "expired");
    assert.equal(expired.fingerprint, "c".repeat(64));

    // A corrupt stored row fails closed instead of being reported as unknown.
    await kv.set(requestStatusKey("corrupt-request"), { version: 1, request_id: "corrupt-request" });
    await assert.rejects(() => readSentinelReplayCaptureStatus(kv, "corrupt-request"), /Sentinel replay capture status record is invalid/);
  } finally {
    closeKv(kv);
  }
});
