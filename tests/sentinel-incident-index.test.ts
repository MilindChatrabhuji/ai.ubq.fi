import { test } from "bun:test";
import { openKv, type Kv, type KvKey } from "#kv";
import assert from "node:assert/strict";
import { apiKeyHashKey, apiKeyIdKey } from "../src/api-keys.ts";
import { config } from "../src/config.ts";
import { DEBUG_ROUTING_KEY } from "../src/debug-routing.ts";
import { setKvForTest } from "../src/kv.ts";
import {
  type AcceptedSentinelReplayInput,
  decryptExportedSentinelReplay,
  type ExportedSentinelReplayCapture,
  persistEncryptedSentinelReplay,
  SENTINEL_REPLAY_MANIFEST_PREFIX,
  type SentinelFailureObservation,
} from "../src/sentinel/replay-capture.ts";
import { PASSKEY_RELAY_COOKIE_NAME, passkeyHandleKey, passkeySessionKey, passkeyUserKey } from "../src/auth/passkeys.ts";
import {
  bindSentinelIncidentIndexEvidence,
  isSentinelIncidentId,
  listSentinelIncidentIndexRows,
  recordSentinelIncidentIndexObservation,
  SENTINEL_INCIDENT_CAPTURE_REF_PREFIX,
  SENTINEL_INCIDENT_INDEX_PREFIX,
} from "../src/sentinel/incident-outbox.ts";
import { base64UrlDecode, base64UrlEncode, encodeHex, sha256Base64Url } from "../src/utils.ts";

const { default: handler } = await import("../src/handler/index.ts");

const SUPER_ADMIN_TOKEN = "sentinel-incident-index-super-admin";
const MARKER = "sentinel-incident-index-marker-7b1d4e";
const CAPTURE_BODY: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
  JSON.stringify({
    model: "gpt-5.6-sol",
    stream: false,
    input: MARKER,
    user: "incident-index-test-user",
  })
);

const newSyntheticKey = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(32)).slice() as Uint8Array<ArrayBuffer>;

const failureObservation = (status = 502): SentinelFailureObservation => ({
  status,
  stream: false,
  completed: false,
  terminal_type: "http.error",
  failure_kind: "upstream_timeout",
  synthetic_terminal_type: null,
  provider_route: "test-provider",
});

const syntheticInput = (bytes: Uint8Array<ArrayBuffer>, requestId: string, endpoint = "/v1/responses"): AcceptedSentinelReplayInput => ({
  endpoint,
  method: "POST",
  body: bytes,
  content_type: "application/json",
  compatibility_headers: { "x-codex-client-version": "9.9.9-secret-version" },
  request_id: requestId,
  git_sha: "synthetic-git-sha",
  deno_revision: "synthetic-revision",
});

const twelveByteIv = (): Uint8Array<ArrayBuffer> => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

const ciphertextDigest = async (capture: ExportedSentinelReplayCapture): Promise<string> => {
  const parts = capture.chunks.map(base64UrlDecode);
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
};

const captureChunkDigest = async (kv: Kv, captureId: string, chunkCount: number): Promise<string> => {
  const chunkPrefix = ["uos_ai", "sentinel_replay", "v1", "chunk", captureId] as const;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = await kv.get<Uint8Array>([...chunkPrefix, index]);
    assert.ok(chunk.value instanceof Uint8Array, `capture chunk ${index} must exist`);
    parts.push(new Uint8Array(chunk.value));
  }
  const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", merged)));
};

const clientObservationFor = (status: number) => ({
  status,
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
});

const seedAuthenticatedKey = async (kv: Kv, token: string): Promise<void> => {
  const now = Date.now();
  const hash = await sha256Base64Url(token);
  const id = `incident-index-${hash.slice(0, 12)}`;
  const policyBase = {
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 100,
    usage_requests: 0,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: 1_000_000,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  await kv.set(apiKeyHashKey(hash), { id, ...policyBase });
  await kv.set(apiKeyIdKey(id), {
    id,
    name: "incident index test key",
    prefix: token.slice(0, 12),
    hash,
    created_at_ms: now,
    ...policyBase,
    paid_fallback_model_ids: ["gpt-5.6-sol"],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_max_exposure_microcredits: { "gpt-5.6-sol": 250_000 },
    paid_fallback_pricing_checked_at_ms: now,
  });
};

const indexUrl = (params: Record<string, string> = {}): string => {
  const query = new URLSearchParams(params);
  const querySuffix = query.size > 0 ? `?${query.toString()}` : "";
  return `https://ai.ubq.fi/admin/sentinel/incidents${querySuffix}`;
};

const exportUrl = (params: Record<string, string>): string => `https://ai.ubq.fi/admin/sentinel/replay-captures?${new URLSearchParams(params).toString()}`;

const superAdminHeaders = { Authorization: `Bearer ${SUPER_ADMIN_TOKEN}` };

const assertIndexRowShape = (row: Record<string, unknown>, count: number): void => {
  assert.equal(typeof row.incident_id, "string");
  assert.equal(isSentinelIncidentId(row.incident_id), true, "row incident_id must be a frozen provider-UUID");
  assert.match(row.fingerprint as string, /^[0-9a-f]{64}$/);
  assert.equal(row.severity, "P2", "general failures must never be inferred above P2");
  assert.equal(typeof row.first_seen_at_ms, "number");
  assert.equal(typeof row.last_seen_at_ms, "number");
  assert.ok((row.last_seen_at_ms as number) >= (row.first_seen_at_ms as number));
  assert.equal(row.count, count);
  if (row.failing_revision !== null) assert.match(row.failing_revision as string, /^[0-9a-f]{40}$/);
  assert.equal(typeof row.error_type, "string");
  assert.ok((row.error_type as string).length > 0);
  const context = row.context as { message: string; location: unknown; sample: unknown[] };
  assert.equal(typeof context.message, "string");
  assert.equal(context.location, null);
  assert.deepEqual(context.sample, []);
  const provenance = row.provenance as { endpoint: string; captured_at_ms: number; captured_by: unknown };
  assert.equal(provenance.endpoint, "https://ai.ubq.fi/v1/responses", "wire provenance must emit the fixed canonical gateway URL");
  assert.equal(typeof provenance.captured_at_ms, "number");
  assert.equal(provenance.captured_by, null);
  const evidenceRef = row.evidence_ref as { ref: string; digest: string | null } | null;
  if (evidenceRef !== null) {
    assert.equal(typeof evidenceRef.ref, "string");
    assert.ok(evidenceRef.ref.length > 0);
    const wireRefPrefix = `artifact://sentinel/${String(row.incident_id)}/`;
    assert.equal(evidenceRef.ref.startsWith(wireRefPrefix), true, "wire ref must use the restricted artifact namespace and bind the exact incident id");
    const wireCaptureId = evidenceRef.ref.slice(wireRefPrefix.length);
    assert.match(wireCaptureId, /^[A-Za-z0-9_-]{1,128}$/, "wire ref must carry exactly one capture id segment");
    assert.equal(evidenceRef.ref.startsWith("capture:"), false, "internal capture refs must never reach wire output");
    if (evidenceRef.digest !== null) assert.match(evidenceRef.digest, /^[0-9a-f]{64}$/);
  }
  const expires = row.evidence_expires_at_ms as number | null;
  assert.equal(expires === null, evidenceRef === null, "evidence expiry and ref must be consistent");
};

test("real handler failure flow: durable index, incident-filtered export, byte-exact decryption", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  const keyBytes = newSyntheticKey();
  process.env.SENTINEL_REPLAY_KEY = base64UrlEncode(keyBytes);
  const token = `u_${encodeHex(crypto.getRandomValues(new Uint8Array(32)))}`;
  try {
    await seedAuthenticatedKey(kv, token);
    await kv.set(DEBUG_ROUTING_KEY, {
      scenario: "codex_429",
      expires_at_ms: null,
      updated_at_ms: Date.now(),
    });
    // Include a query string and a compatibility header plus a user field:
    // none of these may leak into the public index rows.
    const request = new Request("https://ai.ubq.fi/v1/responses?incident_index_secret_query=1", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-codex-client-version": "9.9.9-secret-version",
      },
      body: CAPTURE_BODY,
    });
    const response = await handler(request);
    assert.ok(response.status >= 400, `expected a failure response, got ${response.status}`);
    const responseText = await response.text();
    assert.equal(responseText.includes(MARKER), false, "failure response leaks request plaintext");

    const indexResponse = await handler(new Request(indexUrl(), { headers: superAdminHeaders }));
    assert.equal(indexResponse.status, 200);
    assert.equal(indexResponse.headers.get("Cache-Control"), "no-store");
    const indexBody = (await indexResponse.json()) as {
      data: Record<string, unknown>[];
      cursor: string | null;
      coverage: { status: string };
    };
    assert.deepEqual(indexBody.coverage, { status: "complete" });
    assert.equal(indexBody.cursor, null, "a single durable row must exhaust pagination");
    assert.equal(indexBody.data.length, 1);
    const row = indexBody.data[0];
    assertIndexRowShape(row, 1);
    const indexText = JSON.stringify(indexBody);
    assert.equal(indexText.includes(MARKER), false, "index leaks request plaintext marker");
    assert.equal(indexText.includes("incident_index_secret_query"), false, "index leaks a query string");
    assert.equal(indexText.includes("9.9.9-secret-version"), false, "index leaks a compatibility header");
    assert.equal(indexText.includes("incident-index-test-user"), false, "index leaks user input");
    assert.equal(indexText.includes("rate_limit_error"), false, "index leaks provider error text");
    assert.equal(indexText.includes("chatgpt_codex"), false, "index leaks a provider route");
    assert.ok(row.evidence_ref !== null, "a successfully captured incident must carry evidence");
    const incidentId = row.incident_id as string;

    const filtered = await handler(
      new Request(
        exportUrl({
          after_ms: "0",
          before_ms: String(Date.now() + 1),
          incident_id: incidentId,
        }),
        { headers: superAdminHeaders }
      )
    );
    assert.equal(filtered.status, 200, "incident-filtered export must be reachable by index incident_id");
    const filteredBody = (await filtered.json()) as { data: ExportedSentinelReplayCapture[]; cursor: string | null };
    assert.equal(filteredBody.data.length, 1, "the bound capture must be reachable through the stable incident id");
    const capture = filteredBody.data[0];

    const evidence = row.evidence_ref as { ref: string; digest: string | null };
    const wireRef = `artifact://sentinel/${incidentId}/${capture.manifest.capture_id}`;
    assert.equal(evidence.ref, wireRef, "wire ref must bind the exact incident id and capture id through the restricted artifact namespace");
    const internalRows = (await listSentinelIncidentIndexRows(kv, { incidentId, limit: 1 })).rows;
    assert.equal(internalRows.length, 1);
    assert.equal(internalRows[0].evidence_ref?.ref, `capture:${capture.manifest.capture_id}`, "the internal index must keep the validated capture: ref");
    const digest = await ciphertextDigest(capture);
    assert.equal(evidence.digest, digest, "index digest must be the SHA-256 of the actual concatenated ciphertext");
    assert.equal(row.evidence_expires_at_ms, capture.manifest.expires_at_ms);

    const plaintext = await decryptExportedSentinelReplay(capture, keyBytes);
    assert.deepEqual([...plaintext.body], [...CAPTURE_BODY]);
    assert.equal(new TextDecoder().decode(plaintext.body), new TextDecoder().decode(CAPTURE_BODY));
    assert.equal(plaintext.observation.status, response.status);
    assert.equal(plaintext.client_observation.terminal_type, "http.error");

    // The existing unfiltered export remains compatible and returns the same capture.
    const unfiltered = await handler(new Request(exportUrl({ after_ms: "0", before_ms: String(Date.now() + 1) }), { headers: superAdminHeaders }));
    assert.equal(unfiltered.status, 200);
    const unfilteredBody = (await unfiltered.json()) as { data: ExportedSentinelReplayCapture[] };
    assert.equal(unfilteredBody.data.length, 1);
    assert.deepEqual(unfilteredBody.data[0]?.manifest, capture.manifest);
  } finally {
    delete process.env.SENTINEL_REPLAY_KEY;
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("duplicate observations keep one stable incident id, exact digest, and original expiry", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  try {
    const keyBytes = newSyntheticKey();
    const now1 = Date.now() - 60_000;
    const now2 = now1 + 60_000;
    const randomUuid = () => "00000000-0000-4000-8000-000000000001";
    const bytes = new TextEncoder().encode(JSON.stringify({ model: "gpt-5.6-sol", input: "dup" }));
    const input = syntheticInput(bytes, "incident-index-duplicate");
    const observation = failureObservation(502);
    const clientObservation = clientObservationFor(502);

    const first = await recordSentinelIncidentIndexObservation(
      kv,
      {
        endpoint: input.endpoint,
        method: input.method,
        gitSha: input.git_sha,
        observedAtMs: now1,
        observation: clientObservation,
      },
      { randomUuid }
    );
    const second = await recordSentinelIncidentIndexObservation(
      kv,
      {
        endpoint: input.endpoint,
        method: input.method,
        gitSha: input.git_sha,
        observedAtMs: now2,
        observation: clientObservation,
      },
      { randomUuid }
    );
    assert.equal(second.value.incident_id, first.value.incident_id, "a stable group must keep one incident id");
    assert.equal(second.value.count, 2);
    assert.equal(second.value.first_seen_at_ms, now1);
    assert.equal(second.value.last_seen_at_ms, now2);

    const stored = await persistEncryptedSentinelReplay(
      input,
      observation,
      {
        kv,
        keyBytes,
        now: () => now1,
        randomUuid: () => "duplicate-capture-one",
        randomBytes: twelveByteIv,
      },
      clientObservation
    );
    assert.equal(stored.status, "stored");

    const originalExpiry = stored.manifest.expires_at_ms;

    const duplicate = await persistEncryptedSentinelReplay(
      input,
      observation,
      {
        kv,
        keyBytes,
        now: () => now2,
        randomUuid: () => "duplicate-capture-two",
        randomBytes: twelveByteIv,
      },
      clientObservation
    );
    assert.equal(duplicate.status, "duplicate");

    assert.deepEqual(duplicate.manifest_key, stored.manifest_key, "a duplicate must reference the winning manifest");

    const manifestKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_MANIFEST_PREFIX })) manifestKeys.push(entry.key);
    assert.equal(manifestKeys.length, 1, "duplicate observations must not create new evidence");
    const referenceKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_INCIDENT_CAPTURE_REF_PREFIX })) referenceKeys.push(entry.key);
    assert.equal(referenceKeys.length, 1, "one capture ref per stable incident");

    const { rows } = await listSentinelIncidentIndexRows(kv, { incidentId: first.value.incident_id, limit: 1 });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.count, 2, "each actual observation is counted exactly once");
    assert.equal(row.evidence_ref?.ref, "capture:duplicate-capture-one");
    assert.equal(row.evidence_expires_at_ms, originalExpiry, "a duplicate must retain the original expiry");

    // Capture deletion (manifest + chunks + ref) keeps the durable index row
    // with its evidence metadata so the consumer can report the expiry.
    const manifestKey = stored.manifest_key;
    assert.ok(manifestKey, "a stored capture must expose its manifest key");
    await kv.delete(manifestKey);
    for (let index = 0; index < stored.manifest.chunk_count; index += 1) {
      await kv.delete(["uos_ai", "sentinel_replay", "v1", "chunk", stored.manifest.capture_id, index]);
    }
    for await (const entry of kv.list({ prefix: SENTINEL_INCIDENT_CAPTURE_REF_PREFIX })) {
      await kv.delete(entry.key);
    }
    const afterDelete = await listSentinelIncidentIndexRows(kv, { incidentId: first.value.incident_id, limit: 1 });
    assert.equal(afterDelete.rows.length, 1, "durable discovery must survive capture deletion");
    assert.equal(afterDelete.rows[0].evidence_ref?.ref, "capture:duplicate-capture-one");
    assert.equal(afterDelete.rows[0].evidence_expires_at_ms, originalExpiry);
  } finally {
    kv.close();
    setKvForTest(null);
  }
});

test("durable index survives a clock beyond the capture lifetime with expired evidence metadata", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  try {
    const keyBytes = newSyntheticKey();
    const capturedAt = Date.now() - 49 * 60 * 60 * 1_000;
    const randomUuid = () => "00000000-0000-4000-8000-000000000002";
    const clientObservation = clientObservationFor(503);
    const bytes = new TextEncoder().encode(JSON.stringify({ input: "expiry" }));
    const input: AcceptedSentinelReplayInput = {
      ...syntheticInput(bytes, "incident-index-expiry"),
      git_sha: "1234567890abcdef1234567890abcdef12345678",
    };
    await recordSentinelIncidentIndexObservation(
      kv,
      {
        endpoint: input.endpoint,
        method: input.method,
        gitSha: "1234567890abcdef1234567890abcdef12345678",
        observedAtMs: capturedAt,
        observation: clientObservation,
      },
      { randomUuid }
    );
    const stored = await persistEncryptedSentinelReplay(
      input,
      failureObservation(503),
      {
        kv,
        keyBytes,
        now: () => capturedAt,
        randomUuid: () => "expired-capture",
        randomBytes: twelveByteIv,
      },
      clientObservation
    );
    assert.equal(stored.status, "stored");

    const { rows } = await listSentinelIncidentIndexRows(kv, { limit: 20 });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.evidence_ref?.ref, "capture:expired-capture");
    assert.ok((row.evidence_expires_at_ms ?? 0) < Date.now(), "expired evidence must not claim validity");
    assert.equal(row.failing_revision, "1234567890abcdef1234567890abcdef12345678");
  } finally {
    kv.close();
    setKvForTest(null);
  }
});

test("real handler with a missing capture key leaves a discoverable row without evidence", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  const token = `u_${encodeHex(crypto.getRandomValues(new Uint8Array(32)))}`;
  try {
    await seedAuthenticatedKey(kv, token);
    await kv.set(DEBUG_ROUTING_KEY, {
      scenario: "codex_429",
      expires_at_ms: null,
      updated_at_ms: Date.now(),
    });
    delete process.env.SENTINEL_REPLAY_KEY;

    const response = await handler(captureRequest(token, "https://ai.ubq.fi/v1/responses"));
    assert.ok(response.status >= 400, `expected a failure response, got ${response.status}`);

    const indexResponse = await handler(new Request(indexUrl(), { headers: superAdminHeaders }));
    assert.equal(indexResponse.status, 200);
    const indexBody = (await indexResponse.json()) as { data: Record<string, unknown>[] };
    assert.equal(indexBody.data.length, 1, "a missing key still leaves a discoverable index row");
    assert.equal(indexBody.data[0]?.evidence_ref, null);
    assert.equal(indexBody.data[0]?.evidence_expires_at_ms, null);

    const incidentId = indexBody.data[0].incident_id as string;
    const filtered = await handler(
      new Request(
        exportUrl({
          after_ms: "0",
          before_ms: String(Date.now() + 1),
          incident_id: incidentId,
        }),
        { headers: superAdminHeaders }
      )
    );
    assert.equal(filtered.status, 200);
    const filteredBody = (await filtered.json()) as { data: unknown[] };
    assert.deepEqual(filteredBody.data, []);
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("a duplicate binds the exact original capture revision, timestamp, digest, and expiry", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  try {
    const keyBytes = newSyntheticKey();
    const now1 = 1_700_000_000_000;
    const now2 = now1 + 60_000;
    const now3 = now2 + 60_000;
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const observation = failureObservation(502);
    const clientObservation = clientObservationFor(502);
    const inputA = syntheticInput(new TextEncoder().encode(JSON.stringify({ input: "original-a" })), "revision-request-a");
    const inputB = syntheticInput(new TextEncoder().encode(JSON.stringify({ input: "newer-b" })), "revision-request-b");

    await recordSentinelIncidentIndexObservation(kv, {
      endpoint: inputA.endpoint,
      method: inputA.method,
      gitSha: shaA,
      observedAtMs: now1,
      observation: clientObservation,
    });
    const storedA = await persistEncryptedSentinelReplay(
      { ...inputA, git_sha: shaA },
      observation,
      {
        kv,
        keyBytes,
        now: () => now1,
        randomUuid: () => "revision-capture-a",
        randomBytes: twelveByteIv,
      },
      clientObservation
    );
    assert.equal(storedA.status, "stored");

    await recordSentinelIncidentIndexObservation(kv, {
      endpoint: inputB.endpoint,
      method: inputB.method,
      gitSha: shaB,
      observedAtMs: now2,
      observation: clientObservation,
    });
    const storedB = await persistEncryptedSentinelReplay(
      { ...inputB, git_sha: shaB },
      observation,
      {
        kv,
        keyBytes,
        now: () => now2,
        randomUuid: () => "revision-capture-b",
        randomBytes: twelveByteIv,
      },
      clientObservation
    );
    assert.equal(storedB.status, "stored");

    const afterB = (await listSentinelIncidentIndexRows(kv, { limit: 1 })).rows[0];
    assert.equal(afterB.failing_revision, shaB, "freshly captured evidence carries its own revision");
    assert.equal(afterB.provenance.captured_at_ms, now2, "fresh binding provenance is the capture timestamp");

    // Same body as A but a newer request revision: the capture must remain a
    // duplicate of A, so the index keeps A's exact revision/provenance and
    // never the newer B revision or the duplicate request's git_sha. The
    // observation is recorded first exactly like the environment producer.
    await recordSentinelIncidentIndexObservation(kv, {
      endpoint: inputA.endpoint,
      method: inputA.method,
      gitSha: "c".repeat(40),
      observedAtMs: now3,
      observation: clientObservation,
    });
    const duplicateA = await persistEncryptedSentinelReplay(
      { ...inputA, git_sha: "c".repeat(40) },
      observation,
      {
        kv,
        keyBytes,
        now: () => now3,
        randomUuid: () => "revision-capture-c",
        randomBytes: twelveByteIv,
      },
      clientObservation
    );
    assert.equal(duplicateA.status, "duplicate");

    assert.deepEqual(duplicateA.manifest_key, storedA.manifest_key, "duplicate must reference the winning A manifest");

    const row = (await listSentinelIncidentIndexRows(kv, { limit: 1 })).rows[0];
    assert.equal(row.count, 3, "observation history still counts every observation");
    assert.equal(row.first_seen_at_ms, now1);
    assert.equal(row.last_seen_at_ms, now3);
    assert.equal(row.evidence_ref?.ref, "capture:revision-capture-a", "duplicate remains bound to the original capture");
    assert.equal(row.failing_revision, shaA, "the older duplicate must bind the referenced capture's exact revision");
    assert.equal(row.provenance.captured_at_ms, now1, "index provenance must match the referenced capture timestamp");
    assert.equal(row.evidence_expires_at_ms, storedA.manifest.expires_at_ms, "a duplicate must never renew evidence");

    const chunkPrefix = ["uos_ai", "sentinel_replay", "v1", "chunk", "revision-capture-a"] as const;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let index = 0; index < storedA.manifest.chunk_count; index += 1) {
      const chunk = await kv.get<Uint8Array>([...chunkPrefix, index]);
      assert.ok(chunk.value instanceof Uint8Array, "capture A chunk must still exist");
      parts.push(new Uint8Array(chunk.value));
    }
    const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    const digestA = encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", merged)));
    assert.equal(row.evidence_ref.digest, digestA, "duplicate digest must be capture A's exact ciphertext digest");

    // Missing winning evidence fails closed and never erases useful evidence.
    const manifestKeyA = storedA.manifest_key;
    assert.ok(manifestKeyA, "a stored capture must expose its manifest key");
    await kv.delete(manifestKeyA);
    await assert.rejects(
      () =>
        persistEncryptedSentinelReplay(
          { ...inputA, git_sha: "c".repeat(40) },
          observation,
          {
            kv,
            keyBytes,
            now: () => now3,
            randomUuid: () => "revision-capture-d",
            randomBytes: twelveByteIv,
          },
          clientObservation
        ),
      /Sentinel incident replay manifest is unavailable/
    );
    const preserved = (await listSentinelIncidentIndexRows(kv, { limit: 1 })).rows[0];
    assert.equal(preserved.evidence_ref?.ref, "capture:revision-capture-a", "a failed duplicate must not erase useful existing evidence");
  } finally {
    kv.close();
    setKvForTest(null);
  }
});

test("direct duplicate persistence without a durable index row still returns duplicate and binds nothing", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  try {
    const keyBytes = newSyntheticKey();
    const now1 = 1_700_000_000_000;
    const now2 = now1 + 60_000;
    const input = syntheticInput(new TextEncoder().encode(JSON.stringify({ input: "no-index-direct-caller" })), "no-index-direct-request");
    const observation = failureObservation(502);
    const clientObservation = clientObservationFor(502);
    const stored = await persistEncryptedSentinelReplay(
      input,
      observation,
      {
        kv,
        keyBytes,
        now: () => now1,
        randomUuid: () => "no-index-capture",
        randomBytes: twelveByteIv,
      },
      clientObservation
    );
    assert.equal(stored.status, "stored");

    const duplicate = await persistEncryptedSentinelReplay(
      input,
      observation,
      {
        kv,
        keyBytes,
        now: () => now2,
        randomUuid: () => "no-index-capture-two",
        randomBytes: twelveByteIv,
      },
      clientObservation
    );
    assert.equal(duplicate.status, "duplicate", "the optional passive index must not make a direct duplicate fail");
    assert.deepEqual(duplicate.manifest_key, stored.manifest_key);

    const indexKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_INCIDENT_INDEX_PREFIX })) indexKeys.push(entry.key);
    assert.equal(indexKeys.length, 0, "the low-level encryptor must never create an implicit index row");
    const referenceKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_INCIDENT_CAPTURE_REF_PREFIX })) referenceKeys.push(entry.key);
    assert.equal(referenceKeys.length, 0, "no capture ref may be written without a recorded index observation");

    // With no index row the optional passive integration stays absent even
    // when evidence is gone: duplicates still report duplicate instead of a
    // storage error, because nothing was ever observed to attach to.
    const manifestKey = stored.manifest_key;
    assert.ok(manifestKey, "a stored capture must expose its manifest key");
    await kv.delete(manifestKey);
    const afterDelete = await persistEncryptedSentinelReplay(
      input,
      observation,
      {
        kv,
        keyBytes,
        now: () => now2,
        randomUuid: () => "no-index-capture-three",
        randomBytes: twelveByteIv,
      },
      clientObservation
    );
    assert.equal(afterDelete.status, "duplicate");
  } finally {
    kv.close();
    setKvForTest(null);
  }
});

test("index evidence binding CAS-checks the winning manifest versionstamp", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  try {
    const observed = await recordSentinelIncidentIndexObservation(kv, {
      endpoint: "/v1/responses",
      method: "POST",
      gitSha: "aa".repeat(20),
      observedAtMs: 1_700_000_000_000,
      observation: clientObservationFor(500),
    });
    const manifestKey = [...SENTINEL_REPLAY_MANIFEST_PREFIX, 1_700_000_000_000, "ff".repeat(32), "cas-capture"];
    await kv.set(manifestKey, { version: 1, signature: "original" });
    const first = await kv.get(manifestKey);
    await kv.set(manifestKey, { version: 1, signature: "replaced" });
    await assert.rejects(
      () =>
        bindSentinelIncidentIndexEvidence(kv, observed.value.fingerprint, {
          observedAtMs: 1_700_000_000_000,
          captureId: "cas-capture",
          gitSha: "aa".repeat(20),
          referenceFingerprint: "ff".repeat(32),
          manifestKey,
          manifestVersionstamp: first.versionstamp,
          capturedAtMs: 1_700_000_000_000,
          digest: "cd".repeat(32),
          expiresAtMs: 1_700_000_000_000 + 48 * 60 * 60 * 1_000,
        }),
      /conflicted repeatedly/
    );
    const after = (
      await listSentinelIncidentIndexRows(kv, {
        incidentId: observed.value.incident_id,
        limit: 1,
      })
    ).rows[0];
    assert.equal(after.evidence_ref, null, "a replaced manifest must never silently attach evidence");
    assert.equal(after.evidence_expires_at_ms, null);
    assert.equal(after.provenance.captured_at_ms, 1_700_000_000_000, "observation provenance is untouched before a successful binding");
  } finally {
    kv.close();
    setKvForTest(null);
  }
});

const captureRequest = (token: string, url = "https://ai.ubq.fi/v1/responses"): Request =>
  new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: CAPTURE_BODY,
  });

test("concurrent observations converge to one group row with one count per observation", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  try {
    const randomUuid = (): string => crypto.randomUUID();
    const observations = Array.from({ length: 6 }, (_, index) =>
      recordSentinelIncidentIndexObservation(
        kv,
        {
          endpoint: "/v1/responses",
          method: "POST",
          gitSha: "abcdef0123456789abcdef0123456789abcdef01",
          observedAtMs: 1_700_000_000_000 + index,
          observation: { ...clientObservationFor(529), terminal_type: "error" },
        },
        { randomUuid }
      )
    );
    await Promise.all(observations);
    const { rows } = await listSentinelIncidentIndexRows(kv, { limit: 20 });
    assert.equal(rows.length, 1, "one stable failure group must yield exactly one row");
    assert.equal(rows[0].count, 6, "each actual observation must count exactly once");
    assert.equal(rows[0].first_seen_at_ms, 1_700_000_000_000);
    assert.equal(rows[0].last_seen_at_ms, 1_700_000_000_005);
    const referenceKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_INCIDENT_CAPTURE_REF_PREFIX })) referenceKeys.push(entry.key);
    assert.equal(referenceKeys.length, 0, "observations alone must never create orphan capture references");
    const manifestKeys: KvKey[] = [];
    for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_MANIFEST_PREFIX })) manifestKeys.push(entry.key);
    assert.equal(manifestKeys.length, 0);
  } finally {
    kv.close();
    setKvForTest(null);
  }
});

test("incident index requires admin authorization and then reaches storage", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    const anonymous = await handler(new Request(indexUrl()));
    assert.equal(anonymous.status, 401);
    const payload = (await anonymous.json()) as { error?: { code?: string } };
    assert.equal(payload.error?.code, "invalid_api_key");

    const now = Date.now();
    const userId = "incident-index-passkey-user";
    const handle = "incident-index-passkey-handle";
    const sessionToken = "incident-index-passkey-session-token";
    await kv.set(passkeyUserKey(userId), {
      id: userId,
      handle,
      is_admin: true,
      credential_ids: ["incident-index-credential"],
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
    // The former super-admin gate is gone: an admin passkey session now
    // reads the same bounded index a token admin reads.
    const adminSession = await handler(
      new Request(indexUrl(), {
        headers: { Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
      })
    );
    assert.equal(adminSession.status, 200);
    const adminPayload = (await adminSession.json()) as { data?: unknown };
    assert.equal(Array.isArray(adminPayload.data), true);
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("incident index pagination is bounded and an incident filter never silently misses a row", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    const randomUuid = (): string => crypto.randomUUID();
    const incidentIds: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const entry = await recordSentinelIncidentIndexObservation(
        kv,
        {
          endpoint: index === 24 ? "/v1/chat/completions" : "/v1/responses",
          method: "POST",
          gitSha: "",
          observedAtMs: 1_700_000_000_000 + index,
          observation: { ...clientObservationFor(400 + index), terminal_type: index % 2 === 0 ? "error" : null },
        },
        { randomUuid }
      );
      incidentIds.push(entry.value.incident_id);
    }
    const pageOne = await handler(new Request(indexUrl({ limit: "20" }), { headers: superAdminHeaders }));
    assert.equal(pageOne.status, 200);
    const pageOneBody = (await pageOne.json()) as { data: Record<string, unknown>[]; cursor: string | null };
    assert.equal(pageOneBody.data.length, 20);
    assert.equal(typeof pageOneBody.cursor, "string");
    assert.ok(pageOneBody.cursor, "a complete page with more rows must carry a non-null cursor");
    const pageTwo = await handler(new Request(indexUrl({ limit: "20", cursor: pageOneBody.cursor }), { headers: superAdminHeaders }));
    const pageTwoBody = (await pageTwo.json()) as { data: Record<string, unknown>[]; cursor: string | null };
    assert.equal(pageTwoBody.data.length, 5);
    assert.equal(pageTwoBody.cursor, null, "exhaustion must be signaled by null cursor");

    // The target incident is the LAST row: an incident filter with limit 1
    // must follow cursors and still find it rather than silently dropping it.
    const target = incidentIds[24];
    let cursor: string | null = null;
    let found = false;
    for (let page = 0; page < 64; page += 1) {
      const params: Record<string, string> = { limit: "1", incident_id: target };
      if (cursor !== null) params.cursor = cursor;
      const response = await handler(new Request(indexUrl(params), { headers: superAdminHeaders }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data: Record<string, unknown>[]; cursor: string | null };
      if (body.data.some((row) => row.incident_id === target)) {
        found = true;
        break;
      }
      cursor = body.cursor;
      if (cursor === null) break;
    }
    assert.equal(found, true, "a filtered scan must never silently miss a matching later row");
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("incident index rejects invalid inputs and fails closed on corrupt storage", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    // Frozen 1..100 server limit contract: every integer in range is accepted.
    for (const limit of [1, 20, 21, 100]) {
      const accepted = await handler(new Request(`${indexUrl()}?limit=${limit}`, { headers: superAdminHeaders }));
      assert.equal(accepted.status, 200, `frozen 1..100 contract rejected limit ${limit}`);
      await accepted.body?.cancel();
    }
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=",
      "limit=abc",
      "limit=1.5",
      "limit=1e1",
      "limit=1.0",
      "cursor=",
      "cursor=!!",
      `cursor=${"a".repeat(3_000)}`,
      "incident_id=",
      "incident_id=not-an-incident-id",
      "unexpected=1",
      "limit=1&limit=2",
      "cursor=cursor-1&cursor=cursor-2",
    ]) {
      const response = await handler(new Request(`${indexUrl()}?${query}`, { headers: superAdminHeaders }));
      assert.equal(response.status, 400, query);
      await response.body?.cancel();
    }

    // An index record that does not parse must fail closed, never succeed empty.
    await kv.set([...SENTINEL_INCIDENT_INDEX_PREFIX, "f".repeat(64)], { version: 999, corrupted: true });
    const corrupt = await handler(new Request(indexUrl(), { headers: superAdminHeaders }));
    assert.equal(corrupt.status, 503);
    const corruptPayload = (await corrupt.json()) as { error?: { code?: string }; data?: unknown };
    assert.equal(corruptPayload.error?.code, "sentinel_incidents_unavailable");
    assert.equal(corruptPayload.data, undefined);
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("index rows never carry internal KV keys or metadata into wire output", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    await recordSentinelIncidentIndexObservation(kv, {
      endpoint: "/v1/responses?internal_query=zzz",
      method: "POST",
      gitSha: "",
      observedAtMs: Date.now(),
      observation: clientObservationFor(500),
    });
    const response = await handler(new Request(indexUrl(), { headers: superAdminHeaders }));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes("internal_query"), false, "query strings must never reach wire output");
    assert.equal(text.includes("uos_ai"), false, "internal KV prefixes must never reach wire output");
    assert.equal(text.includes("sentinel_replay"), false, "capture storage prefixes must never reach wire output");
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});

test("wire provenance is a fixed canonical allowlist: known/other classifications, hostile request, query, and index origins cannot alter the emitted URL", async () => {
  const kv = await openKv(":memory:");
  setKvForTest(kv);
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(SUPER_ADMIN_TOKEN);
  try {
    const keyBytes = newSyntheticKey();
    const observedAtMs = 1_700_000_200_000;
    const capturedAtMs = 1_700_000_300_000;
    const randomUuid = (): string => crypto.randomUUID();

    // Known, unknown, hostile-URL and hostile-query endpoints go through the
    // same producer index observation the actual gateway capture path uses
    // (recordSentinelIncidentIndexObservation at capture time).
    const cases: readonly { endpoint: string; status: number; expected: string }[] = [
      { endpoint: "/v1/responses", status: 500, expected: "https://ai.ubq.fi/v1/responses" },
      { endpoint: "/v1/chat/completions", status: 501, expected: "https://ai.ubq.fi/v1/chat/completions" },
      { endpoint: "/v1/images/generations", status: 502, expected: "https://ai.ubq.fi/" },
      { endpoint: "https://evil.example/v1/responses", status: 503, expected: "https://ai.ubq.fi/" },
      {
        endpoint: "/v1/responses?origin=https://evil.example",
        status: 504,
        expected: "https://ai.ubq.fi/v1/responses",
      },
    ];
    const first = await recordSentinelIncidentIndexObservation(
      kv,
      {
        endpoint: cases[0].endpoint,
        method: "POST",
        gitSha: "",
        observedAtMs,
        observation: clientObservationFor(cases[0].status),
      },
      { randomUuid }
    );
    for (const item of cases.slice(1)) {
      await recordSentinelIncidentIndexObservation(
        kv,
        {
          endpoint: item.endpoint,
          method: "POST",
          gitSha: "",
          observedAtMs: observedAtMs + item.status,
          observation: clientObservationFor(item.status),
        },
        { randomUuid }
      );
    }

    // Bind real capture evidence to the known /v1/responses group so the
    // historical timestamp/digest projection can be compared exactly.
    const input = syntheticInput(new TextEncoder().encode(JSON.stringify({ input: "fixed-allowlist" })), "fixed-allowlist-request", "/v1/responses");
    const stored = await persistEncryptedSentinelReplay(
      input,
      failureObservation(cases[0].status),
      {
        kv,
        keyBytes,
        now: () => capturedAtMs,
        randomUuid: () => "fixed-allowlist-capture",
        randomBytes: twelveByteIv,
      },
      clientObservationFor(cases[0].status)
    );
    assert.equal(stored.status, "stored");

    // Actual authenticated handler read: even a hostile admin request origin
    // cannot influence the emitted provenance.
    const response = await handler(new Request("https://evil.example/admin/sentinel/incidents", { headers: superAdminHeaders }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Record<string, unknown>[] };
    assert.equal(body.data.length, cases.length);
    const text = JSON.stringify(body);
    assert.equal(text.includes("evil.example"), false, "a hostile origin must never reach wire output");
    assert.deepEqual(
      body.data.map((row) => (row.provenance as { endpoint: string }).endpoint).sort((a, b) => a.localeCompare(b)),
      cases.map((item) => item.expected).sort((a, b) => a.localeCompare(b)),
      "wire provenance must be exactly the fixed canonical allowlist projection"
    );

    // A hostile query on the admin request is rejected by the frozen
    // unknown-key validation (fail closed) instead of reaching the rows.
    const hostileQuery = await handler(new Request("https://ai.ubq.fi/admin/sentinel/incidents?origin=https://evil.example", { headers: superAdminHeaders }));
    assert.equal(hostileQuery.status, 400);

    // Historical evidence projection: the internal `capture:<id>` ref is
    // mapped to the restricted wire artifact ref while the exact id and
    // digest stay bound; captured_at_ms remains the exact stored timestamp.
    const { rows: storedRows } = await listSentinelIncidentIndexRows(kv, { limit: 100 });
    assert.equal(storedRows.length, cases.length);
    const wireByIncident = new Map(body.data.map((row) => [row.incident_id as string, row]));
    for (const storedRow of storedRows) {
      const wire = wireByIncident.get(storedRow.incident_id);
      assert.ok(wire, "every stored row must be on the wire page");
      assert.equal(
        (wire.provenance as { captured_at_ms: number }).captured_at_ms,
        storedRow.provenance.captured_at_ms,
        "wire captured_at_ms must be the exact stored historical timestamp"
      );
      assert.equal((wire.provenance as { captured_by: unknown }).captured_by, storedRow.provenance.captured_by);
      const wireEvidence = wire.evidence_ref as { ref: string; digest: string | null } | null;
      const storedEvidence = storedRow.evidence_ref;
      assert.equal(wireEvidence === null, storedEvidence === null, "wire evidence_ref must mirror internal evidence presence");
      if (wireEvidence !== null && storedEvidence !== null) {
        assert.equal(
          wireEvidence.ref,
          `artifact://sentinel/${storedRow.incident_id}/${storedEvidence.ref.slice("capture:".length)}`,
          "wire evidence_ref must map the stored capture: id through the exact incident id"
        );
        assert.equal(wireEvidence.digest, storedEvidence.digest, "wire evidence_ref digest must stay the exact stored historical digest");
      }
    }
    const boundWire = wireByIncident.get(first.value.incident_id);
    assert.ok(boundWire, "the bound incident must appear on the wire page");
    assert.equal((boundWire.provenance as { captured_at_ms: number }).captured_at_ms, capturedAtMs, "the bound row must carry the original capture timestamp");
    const digest = await captureChunkDigest(kv, "fixed-allowlist-capture", stored.manifest.chunk_count);
    assert.equal((boundWire.evidence_ref as { digest: string }).digest, digest);
    const boundStored = storedRows.find((storedRow) => storedRow.incident_id === first.value.incident_id);
    assert.ok(boundStored, "the bound incident must appear in the stored index rows");
    assert.equal(boundStored.evidence_ref?.ref, "capture:fixed-allowlist-capture", "the internal index must keep the validated capturing ref");
    assert.equal(
      (boundWire.evidence_ref as { ref: string }).ref,
      `artifact://sentinel/${first.value.incident_id}/fixed-allowlist-capture`,
      "wire ref must link exactly the bound incident id and capture id"
    );

    // A hostile endpoint written directly into storage must be rejected by
    // the unchanged row validation (fail closed, 503) and never emitted.
    const corrupted = {
      ...storedRows[0],
      provenance: { ...storedRows[0].provenance, endpoint: "https://evil.example" },
    };
    await kv.set([...SENTINEL_INCIDENT_INDEX_PREFIX, corrupted.fingerprint], corrupted);
    const corrupt = await handler(new Request(indexUrl(), { headers: superAdminHeaders }));
    assert.equal(corrupt.status, 503);
    const corruptText = await corrupt.text();
    assert.equal(corruptText.includes("evil.example"), false, "a corrupted origin must fail closed, never be emitted");
  } finally {
    adminTokens.delete(SUPER_ADMIN_TOKEN);
    kv.close();
    setKvForTest(null);
  }
});
