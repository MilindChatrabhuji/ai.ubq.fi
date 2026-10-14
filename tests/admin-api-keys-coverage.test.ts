import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { Kv } from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/admin-auth-harness.ts";
// Coverage suite for the admin API key mutation handlers, the API key create/list handlers,
// and the Sentinel incident index admin route.

import assert from "node:assert/strict";
import {
  handleAdminApiKeysCreate,
  handleAdminApiKeysDelete,
  handleAdminApiKeysList,
  handleAdminApiKeysPaidFallbacks,
  handleAdminApiKeysUnrevoke,
  handleAdminApiKeysUpdate,
  keyToString,
  kvStore,
  kvStub,
  setAtomicCommitsToFail,
} from "./helpers/admin-auth-harness.ts";
import { handleAdminApiKeysRevoke } from "../src/admin/api-key-mutations.ts";
import { handleAdminSentinelIncidents } from "../src/admin/sentinel-incident.ts";
import { estimateJsonSize } from "../src/admin/api-keys.ts";
import { setKvForTest } from "../src/kv.ts";
import { SENTINEL_INCIDENT_INDEX_PREFIX, type SentinelIncidentIndexRow } from "../src/sentinel/incident-outbox.ts";

type ErrorPayload = Readonly<{ error?: { message?: string; code?: string; type?: string; param?: string | null } }>;
type KeyPayload = Readonly<{
  id?: string;
  name?: string;
  usage_requests?: number;
  usage_limit_requests?: number;
  window_ms?: number;
  expires_at_ms?: number;
  revoked_at_ms?: number | null;
}>;

const KEY_ID_PREFIX = ["ubq_ai", "api_keys", "id"] as const;
const KEY_HASH_PREFIX = ["ubq_ai", "api_keys", "hash"] as const;
const USAGE_WINDOW_PREFIX = ["uos_ai", "api_key_usage", "v3", "window"] as const;
const USAGE_REQUEST_PREFIX = ["uos_ai", "api_key_usage", "v3", "request"] as const;
const PAID_FALLBACK_REQUEST_PREFIX = ["uos_ai", "paid_fallback", "v3", "request"] as const;
const PAID_FALLBACK_PENDING_PREFIX = ["uos_ai", "paid_fallback", "v3", "pending"] as const;

/** The complete strict paid-fallback policy every mutation target must carry. */
const STRICT_POLICY_FIELDS = {
  usage_quota_version: 3,
  paid_fallback_enabled: false,
  paid_fallback_limit_microcredits: 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
  paid_fallback_model_ids: [] as string[],
  paid_fallback_quota_per_credit: 0,
  paid_fallback_pricing_checked_at_ms: null,
};

type SeededKey = Readonly<{ id: string; hash: string; windowMs: number; windowStartMs: number; record: Record<string, unknown> }>;

const adminRequest = (path: string, body: string | Record<string, unknown>, method = "POST"): Request =>
  new Request(`https://ai.ubq.fi${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const payloadOf = async (response: Response): Promise<ErrorPayload & KeyPayload> => (await response.json()) as ErrorPayload & KeyPayload;

const seedApiKey = (overrides: Record<string, unknown> = {}, options: Readonly<{ hashRecord?: boolean }> = {}): SeededKey => {
  const id = `coverage-key-${crypto.randomUUID()}`;
  const hash = `coverage-hash-${crypto.randomUUID()}`;
  const windowMs = 60_000;
  const now = Date.now();
  const record: Record<string, unknown> = {
    id,
    name: "Coverage key",
    prefix: "u_coverage00",
    hash,
    created_at_ms: now - 5_000,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 25,
    usage_requests: 0,
    usage_reset_at_ms: now + windowMs,
    window_ms: windowMs,
    ...STRICT_POLICY_FIELDS,
    ...overrides,
  };
  kvStore.set(keyToString([...KEY_ID_PREFIX, id]), record);
  if (options.hashRecord !== false) {
    kvStore.set(keyToString([...KEY_HASH_PREFIX, hash]), {
      id,
      expires_at_ms: record.expires_at_ms,
      revoked_at_ms: record.revoked_at_ms,
      usage_limit_requests: record.usage_limit_requests,
      usage_requests: record.usage_requests,
      usage_reset_at_ms: record.usage_reset_at_ms,
      window_ms: record.window_ms,
      usage_quota_version: record.usage_quota_version,
      paid_fallback_enabled: record.paid_fallback_enabled,
      paid_fallback_limit_microcredits: record.paid_fallback_limit_microcredits,
      paid_fallback_spent_microcredits: record.paid_fallback_spent_microcredits,
      paid_fallback_reserved_microcredits: record.paid_fallback_reserved_microcredits,
      paid_fallback_reservation_request_id: record.paid_fallback_reservation_request_id,
    });
  }
  return { id, hash, windowMs, windowStartMs: Number(record.usage_reset_at_ms) - windowMs, record };
};

const storedRecord = (key: SeededKey): Record<string, unknown> => kvStore.get(keyToString([...KEY_ID_PREFIX, key.id])) as Record<string, unknown>;
const storedHashRecord = (key: SeededKey): Record<string, unknown> => kvStore.get(keyToString([...KEY_HASH_PREFIX, key.hash])) as Record<string, unknown>;

const seedUsageWindow = (key: SeededKey, committedRequests: number, reservedRequests = 0): void => {
  kvStore.set(keyToString([...USAGE_WINDOW_PREFIX, key.id, `v3:${key.windowMs}`, key.windowStartMs]), {
    v: 3,
    key_id: key.id,
    policy_version: `v3:${key.windowMs}`,
    window_start_ms: key.windowStartMs,
    window_reset_at_ms: key.windowStartMs + key.windowMs,
    committed_requests: committedRequests,
    reserved_requests: reservedRequests,
    updated_at_ms: Date.now(),
  });
};

/** A reservation row the reclaim pass cannot normalize, which fails the ledger closed. */
const seedMalformedReservation = (key: SeededKey): void => {
  kvStore.set(keyToString([...USAGE_REQUEST_PREFIX, key.id, `v3:${key.windowMs}`, key.windowStartMs, "malformed"]), {});
};

/** An expired lease whose policy is collected before the same-prefix malformed row fails the pass. */
const seedExpiredReservation = (key: SeededKey): void => {
  const now = Date.now();
  kvStore.set(keyToString([...USAGE_REQUEST_PREFIX, key.id, `v3:${key.windowMs}`, key.windowStartMs, "expired-lease"]), {
    v: 3,
    key_id: key.id,
    request_id: "expired-lease",
    route: "responses",
    state: "reserved",
    reserved_at_ms: now - 600_000,
    lease_expires_at_ms: now - 300_000,
    provider: null,
    dispatched_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  });
};

const removeSeededReservations = (key: SeededKey): void => {
  for (const requestId of ["malformed", "expired-lease"]) {
    kvStore.delete(keyToString([...USAGE_REQUEST_PREFIX, key.id, `v3:${key.windowMs}`, key.windowStartMs, requestId]));
  }
};

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("admin API key update rejects every malformed field and non-strict records", async () => {
  kvStore.clear();
  const key = seedApiKey();

  const invalidJson = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", "{"));
  assert.equal(invalidJson.status, 400);
  assert.equal((await payloadOf(invalidJson)).error?.message, "Invalid JSON body");

  const missingId = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", {}));
  assert.equal(missingId.status, 400);
  assert.equal((await payloadOf(missingId)).error?.message, "id is required");

  const unknownId = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: "missing-key" }));
  assert.equal(unknownId.status, 404);
  assert.equal((await payloadOf(unknownId)).error?.code, "not_found");

  const legacy = seedApiKey({ paid_fallback_pricing_checked_at_ms: undefined });
  delete legacy.record.paid_fallback_pricing_checked_at_ms;
  kvStore.set(keyToString([...KEY_ID_PREFIX, legacy.id]), legacy.record);
  const migrationIncomplete = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: legacy.id, name: "renamed" }));
  assert.equal(migrationIncomplete.status, 503);
  assert.equal((await payloadOf(migrationIncomplete)).error?.message, "API key paid fallback migration is incomplete");

  const cases: readonly (readonly [Record<string, unknown>, string])[] = [
    [{ name: "   " }, "name must be a non-empty string (<=80 chars)"],
    [{ name: "x".repeat(81) }, "name must be a non-empty string (<=80 chars)"],
    [{ expires_at_ms: 1 }, "expires_at_ms must be a Unix epoch ms timestamp in the future, or -1"],
    [{ usage_limit_requests: "5" }, "usage_limit_requests must be a non-negative number or -1 for unlimited"],
    [{ window_ms: 0 }, "window_ms must be a positive number"],
    [{ paid_fallback_enabled: "enabled" }, "paid_fallback_enabled must be a boolean"],
    [{ paid_fallback_limit_credits: -5 }, "paid_fallback_limit_credits must be a non-negative number or -1"],
    [{ paid_fallback_enabled: true, paid_fallback_limit_credits: 0 }, "paid_fallback_limit_credits must be positive or -1 when paid fallback is enabled"],
    [{ reset_usage: "yes" }, "reset_usage must be a boolean"],
  ];
  for (const [patch, expectedMessage] of cases) {
    const response = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: key.id, ...patch }));
    assert.equal(response.status, 400);
    assert.equal((await payloadOf(response)).error?.message, expectedMessage);
  }

  const accepted = await handleAdminApiKeysUpdate(
    adminRequest("/admin/api-keys", { id: key.id, name: "Renamed", usage_limit_requests: -1, window_ms: 30_000, expires_at_ms: -1 })
  );
  assert.equal(accepted.status, 200);
  const acceptedPayload = await payloadOf(accepted);
  assert.equal(acceptedPayload.name, "Renamed");
  assert.equal(acceptedPayload.usage_limit_requests, -1);
  assert.equal(acceptedPayload.window_ms, 30_000);
  assert.equal(storedRecord(key).name, "Renamed");
});

test("admin API key update answers a no-op patch from the live V3 aggregate", async () => {
  kvStore.clear();
  const key = seedApiKey();
  seedUsageWindow(key, 3);

  const response = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: key.id }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
  const payload = await payloadOf(response);
  assert.equal(payload.id, key.id);
  assert.equal(payload.name, "Coverage key");
  assert.equal(payload.usage_requests, 3);
  assert.equal(payload.window_ms, key.windowMs);
  assert.equal(payload.revoked_at_ms, null);
  assert.equal(storedRecord(key).name, "Coverage key");
});

test("admin API key update fails closed on a broken quota ledger and reports commit conflicts", async () => {
  kvStore.clear();
  const key = seedApiKey();
  // The reclaim pass only collects a policy from a valid expired reservation; the
  // malformed row in the same policy prefix then fails the recheck closed.
  seedUsageWindow(key, 0, 1);
  seedExpiredReservation(key);
  seedMalformedReservation(key);
  const ledgerFailure = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: key.id, reset_usage: true }));
  assert.equal(ledgerFailure.status, 503);
  assert.equal((await payloadOf(ledgerFailure)).error?.message, "API key quota ledger is unavailable");
  assert.equal(storedRecord(key).usage_requests, 0);

  removeSeededReservations(key);
  setAtomicCommitsToFail(1);
  const identityConflict = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: key.id, name: "Racing rename" }));
  assert.equal(identityConflict.status, 409);
  assert.equal((await payloadOf(identityConflict)).error?.message, "API key was modified concurrently; retry");
  assert.equal(storedRecord(key).name, "Coverage key");

  setAtomicCommitsToFail(1);
  const resetConflict = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: key.id, reset_usage: true }));
  assert.equal(resetConflict.status, 409);
  assert.equal((await payloadOf(resetConflict)).error?.message, "API key was modified concurrently; retry");

  const unmigrated = seedApiKey({ usage_quota_version: 2 });
  const unmigratedResponse = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: unmigrated.id, name: "Renamed legacy" }));
  assert.equal(unmigratedResponse.status, 503);
  assert.equal((await payloadOf(unmigratedResponse)).error?.message, "API key quota migration is incomplete");
  assert.equal(storedRecord(unmigrated).name, "Coverage key");
});

test("admin API key revoke validates input, preserves the first revocation and reports conflicts", async () => {
  kvStore.clear();
  const invalidJson = await handleAdminApiKeysRevoke(adminRequest("/admin/api-keys/revoke", "{"));
  assert.equal(invalidJson.status, 400);
  assert.equal((await payloadOf(invalidJson)).error?.message, "Invalid JSON body");

  const missingId = await handleAdminApiKeysRevoke(adminRequest("/admin/api-keys/revoke", {}));
  assert.equal(missingId.status, 400);
  assert.equal((await payloadOf(missingId)).error?.message, "id is required");

  const unknownId = await handleAdminApiKeysRevoke(adminRequest("/admin/api-keys/revoke", { id: "nope" }));
  assert.equal(unknownId.status, 404);
  assert.equal((await payloadOf(unknownId)).error?.code, "not_found");

  const legacy = seedApiKey({ paid_fallback_pricing_checked_at_ms: undefined });
  delete legacy.record.paid_fallback_pricing_checked_at_ms;
  kvStore.set(keyToString([...KEY_ID_PREFIX, legacy.id]), legacy.record);
  const migrationIncomplete = await handleAdminApiKeysRevoke(adminRequest("/admin/api-keys/revoke", { id: legacy.id }));
  assert.equal(migrationIncomplete.status, 503);
  assert.equal((await payloadOf(migrationIncomplete)).error?.message, "API key paid fallback migration is incomplete");

  const key = seedApiKey();
  const revoked = await handleAdminApiKeysRevoke(adminRequest("/admin/api-keys/revoke", { id: key.id }));
  assert.equal(revoked.status, 200);
  const revokedPayload = await payloadOf(revoked);
  assert.equal(revokedPayload.id, key.id);
  assert.equal(typeof revokedPayload.revoked_at_ms, "number");
  assert.equal(storedRecord(key).revoked_at_ms, revokedPayload.revoked_at_ms);
  assert.equal(storedHashRecord(key).revoked_at_ms, revokedPayload.revoked_at_ms);

  const revokedAgain = await handleAdminApiKeysRevoke(adminRequest("/admin/api-keys/revoke", { id: key.id }));
  assert.equal(revokedAgain.status, 200);
  assert.equal((await payloadOf(revokedAgain)).revoked_at_ms, revokedPayload.revoked_at_ms);

  const unmirrored = seedApiKey({}, { hashRecord: false });
  const unmirroredResponse = await handleAdminApiKeysRevoke(adminRequest("/admin/api-keys/revoke", { id: unmirrored.id }));
  assert.equal(unmirroredResponse.status, 200);
  assert.equal(typeof kvStore.get(keyToString([...KEY_HASH_PREFIX, unmirrored.hash])), "object");

  const racing = seedApiKey();
  setAtomicCommitsToFail(1);
  const conflict = await handleAdminApiKeysRevoke(adminRequest("/admin/api-keys/revoke", { id: racing.id }));
  assert.equal(conflict.status, 409);
  assert.equal((await payloadOf(conflict)).error?.message, "API key was modified concurrently; retry");
  assert.equal(storedRecord(racing).revoked_at_ms, null);
});

test("admin API key unrevoke validates input, honors the deletion guard and clears revocation", async () => {
  kvStore.clear();
  const invalidJson = await handleAdminApiKeysUnrevoke(adminRequest("/admin/api-keys/unrevoke", "{"));
  assert.equal(invalidJson.status, 400);
  assert.equal((await payloadOf(invalidJson)).error?.message, "Invalid JSON body");

  const missingId = await handleAdminApiKeysUnrevoke(adminRequest("/admin/api-keys/unrevoke", {}));
  assert.equal(missingId.status, 400);
  assert.equal((await payloadOf(missingId)).error?.message, "id is required");

  const unknownId = await handleAdminApiKeysUnrevoke(adminRequest("/admin/api-keys/unrevoke", { id: "nope" }));
  assert.equal(unknownId.status, 404);
  assert.equal((await payloadOf(unknownId)).error?.code, "not_found");

  const legacy = seedApiKey({ paid_fallback_pricing_checked_at_ms: undefined });
  delete legacy.record.paid_fallback_pricing_checked_at_ms;
  kvStore.set(keyToString([...KEY_ID_PREFIX, legacy.id]), legacy.record);
  const migrationIncomplete = await handleAdminApiKeysUnrevoke(adminRequest("/admin/api-keys/unrevoke", { id: legacy.id }));
  assert.equal(migrationIncomplete.status, 503);
  assert.equal((await payloadOf(migrationIncomplete)).error?.message, "API key paid fallback migration is incomplete");

  const active = seedApiKey();
  const alreadyActive = await handleAdminApiKeysUnrevoke(adminRequest("/admin/api-keys/unrevoke", { id: active.id }));
  assert.equal(alreadyActive.status, 200);
  assert.deepEqual(await alreadyActive.json(), { id: active.id, revoked_at_ms: null });

  const revoked = seedApiKey({ revoked_at_ms: Date.now() - 1_000 });
  kvStore.set(keyToString([...KEY_HASH_PREFIX, revoked.hash]), {
    ...(storedHashRecord(revoked) as Record<string, unknown>),
    revoked_at_ms: revoked.record.revoked_at_ms,
  });
  const unrevoked = await handleAdminApiKeysUnrevoke(adminRequest("/admin/api-keys/unrevoke", { id: revoked.id }));
  assert.equal(unrevoked.status, 200);
  assert.equal((await payloadOf(unrevoked)).revoked_at_ms, null);
  assert.equal(storedRecord(revoked).revoked_at_ms, null);
  assert.equal(storedHashRecord(revoked).revoked_at_ms, null);

  const guarded = seedApiKey({ revoked_at_ms: Date.now() - 1_000 });
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "deletion_guard", guarded.id]), { created_at_ms: Date.now() });
  const blocked = await handleAdminApiKeysUnrevoke(adminRequest("/admin/api-keys/unrevoke", { id: guarded.id }));
  assert.equal(blocked.status, 409);
  assert.equal((await payloadOf(blocked)).error?.code, "paid_fallback_deletion_in_progress");
  assert.equal(storedRecord(guarded).revoked_at_ms, guarded.record.revoked_at_ms);

  const racing = seedApiKey({ revoked_at_ms: Date.now() - 1_000 });
  setAtomicCommitsToFail(1);
  const conflict = await handleAdminApiKeysUnrevoke(adminRequest("/admin/api-keys/unrevoke", { id: racing.id }));
  assert.equal(conflict.status, 409);
  assert.equal((await payloadOf(conflict)).error?.message, "API key was modified concurrently; retry");
  assert.equal(storedRecord(racing).revoked_at_ms, racing.record.revoked_at_ms);
});

test("admin API key delete validates state and fails closed when paid fallback state cannot be read", async () => {
  kvStore.clear();
  const invalidJson = await handleAdminApiKeysDelete(adminRequest("/admin/api-keys", "{", "DELETE"));
  assert.equal(invalidJson.status, 400);
  assert.equal((await payloadOf(invalidJson)).error?.message, "Invalid JSON body");

  const missingId = await handleAdminApiKeysDelete(adminRequest("/admin/api-keys", {}, "DELETE"));
  assert.equal(missingId.status, 400);
  assert.equal((await payloadOf(missingId)).error?.message, "id is required");

  const unknownId = await handleAdminApiKeysDelete(adminRequest("/admin/api-keys", { id: "nope" }, "DELETE"));
  assert.equal(unknownId.status, 404);
  assert.equal((await payloadOf(unknownId)).error?.code, "not_found");

  const active = seedApiKey();
  const notRevoked = await handleAdminApiKeysDelete(adminRequest("/admin/api-keys", { id: active.id }, "DELETE"));
  assert.equal(notRevoked.status, 400);
  assert.equal((await payloadOf(notRevoked)).error?.message, "Only revoked keys can be deleted");

  const broken = seedApiKey({ revoked_at_ms: Date.now() - 1_000 });
  kvStore.set(keyToString([...PAID_FALLBACK_REQUEST_PREFIX, broken.id, "unreadable-row"]), null);
  const unreadable = await handleAdminApiKeysDelete(adminRequest("/admin/api-keys", { id: broken.id }, "DELETE"));
  assert.equal(unreadable.status, 500);
  assert.equal((await payloadOf(unreadable)).error?.message, "Failed to prepare paid fallback state for API key deletion");
  assert.equal(kvStore.has(keyToString([...KEY_ID_PREFIX, broken.id])), true);
  kvStore.delete(keyToString([...PAID_FALLBACK_REQUEST_PREFIX, broken.id, "unreadable-row"]));

  const racing = seedApiKey({ revoked_at_ms: Date.now() - 1_000 });
  setAtomicCommitsToFail(1);
  const guardConflict = await handleAdminApiKeysDelete(adminRequest("/admin/api-keys", { id: racing.id }, "DELETE"));
  assert.equal(guardConflict.status, 409);
  assert.equal((await payloadOf(guardConflict)).error?.message, "API key was modified concurrently; retry");

  kvStore.set(keyToString([...PAID_FALLBACK_PENDING_PREFIX, broken.id, "pending-marker"]), { created_at_ms: Date.now() - 1_000 });
  const billingBlocked = await handleAdminApiKeysDelete(adminRequest("/admin/api-keys", { id: broken.id }, "DELETE"));
  assert.equal(billingBlocked.status, 409);
  assert.equal((await payloadOf(billingBlocked)).error?.code, "paid_fallback_billing_outstanding");
  kvStore.delete(keyToString([...PAID_FALLBACK_PENDING_PREFIX, broken.id, "pending-marker"]));

  const deleted = await handleAdminApiKeysDelete(adminRequest("/admin/api-keys", { id: broken.id }, "DELETE"));
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { id: broken.id });
  assert.equal(kvStore.has(keyToString([...KEY_ID_PREFIX, broken.id])), false);
  assert.equal(kvStore.has(keyToString([...KEY_HASH_PREFIX, broken.hash])), false);
});

test("admin API key handlers report a missing KV store", async () => {
  kvStore.clear();
  const key = seedApiKey();
  // The explicit null fixture prevents disk fallback and makes KV unavailable.
  setKvForTest(null);
  try {
    const cases = [
      await handleAdminApiKeysCreate(adminRequest("/admin/api-keys", { name: "kv-less" })),
      await handleAdminApiKeysList(new Request("https://ai.ubq.fi/admin/api-keys")),
      await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: key.id, name: "kv-less" })),
      await handleAdminApiKeysRevoke(adminRequest("/admin/api-keys/revoke", { id: key.id })),
      await handleAdminApiKeysUnrevoke(adminRequest("/admin/api-keys/unrevoke", { id: key.id })),
      await handleAdminApiKeysDelete(adminRequest("/admin/api-keys", { id: key.id }, "DELETE")),
      await handleAdminApiKeysPaidFallbacks(new Request(`https://ai.ubq.fi/admin/api-keys/${key.id}/paid-fallbacks`), key.id),
      await handleAdminApiKeysPaidFallbacks(new Request(`https://ai.ubq.fi/admin/api-keys/${key.id}/paid-fallbacks`), key.id, null),
    ];
    for (const response of cases) {
      assert.equal(response.status, 500);
      assert.match((await payloadOf(response)).error?.message ?? "", /Deno KV is not available/);
    }
  } finally {
    setKvForTest(kvStub);
  }
  const restored = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: key.id, name: "Restored" }));
  assert.equal(restored.status, 200);
});

test("admin API key create validates its fields and reports persistence failures", async () => {
  kvStore.clear();
  const invalidJson = await handleAdminApiKeysCreate(adminRequest("/admin/api-keys", "{"));
  assert.equal(invalidJson.status, 400);
  assert.equal((await payloadOf(invalidJson)).error?.message, "Invalid JSON body");

  const cases: readonly (readonly [Record<string, unknown>, string])[] = [
    [{ name: 5 }, "name must be a non-empty string (<=80 chars)"],
    [{ name: "has\nnewline" }, "name must be a non-empty string (<=80 chars)"],
    [{ name: "token case", token: "nope" }, "token must use the u_ prefix followed by 64 lowercase hexadecimal characters"],
    [{ name: "expiry case", expires_at_ms: 5 }, "expires_at_ms must be a Unix epoch ms timestamp in the future, or -1"],
    [{ name: "limit case", usage_limit_requests: "many" }, "usage_limit_requests must be a positive number or -1 for unlimited"],
    [{ name: "window case", window_ms: "soon" }, "window_ms must be a positive number"],
    [{ name: "fallback case", paid_fallback_enabled: "yes" }, "paid_fallback_enabled must be a boolean"],
    [{ name: "fallback limit case", paid_fallback_limit_credits: "lots" }, "paid_fallback_limit_credits must be a non-negative number or -1"],
    [
      { name: "fallback zero case", paid_fallback_enabled: true, paid_fallback_limit_credits: 0 },
      "paid_fallback_limit_credits must be positive or -1 when paid fallback is enabled",
    ],
  ];
  for (const [body, expectedMessage] of cases) {
    const response = await handleAdminApiKeysCreate(adminRequest("/admin/api-keys", body));
    assert.equal(response.status, 400);
    assert.equal((await payloadOf(response)).error?.message, expectedMessage);
  }

  const created = await handleAdminApiKeysCreate(adminRequest("/admin/api-keys", { name: "Persistence case", usage_limit_requests: -1 }));
  assert.equal(created.status, 200);
  const createdPayload = (await created.json()) as { id?: string; token?: string };
  assert.equal(typeof createdPayload.token, "string");
  assert.match(createdPayload.token ?? "", /^u_[0-9a-f]{64}$/);

  const duplicate = await handleAdminApiKeysCreate(adminRequest("/admin/api-keys", { name: "Duplicate", token: createdPayload.token }));
  assert.equal(duplicate.status, 409);
  assert.equal((await payloadOf(duplicate)).error?.message, "API key already exists");

  setAtomicCommitsToFail(1);
  const failed = await handleAdminApiKeysCreate(adminRequest("/admin/api-keys", { name: "Commit failure" }));
  assert.equal(failed.status, 500);
  assert.equal((await payloadOf(failed)).error?.message, "Failed to persist API key");
});

test("retired API-key banked reset settings are rejected without mutation", async () => {
  kvStore.clear();

  const created = await handleAdminApiKeysCreate(adminRequest("/admin/api-keys", { name: "Retired setting", banked_resets_enabled: false }));
  assert.equal(created.status, 400);
  assert.equal((await payloadOf(created)).error?.message, "banked_resets_enabled is retired; configure banked resets per Codex subscription");
  assert.equal(kvStore.size, 0);

  const key = seedApiKey();
  const before = structuredClone(storedRecord(key));
  const updated = await handleAdminApiKeysUpdate(adminRequest("/admin/api-keys", { id: key.id, banked_resets_enabled: false }, "PATCH"));
  assert.equal(updated.status, 400);
  assert.equal((await payloadOf(updated)).error?.message, "banked_resets_enabled is retired; configure banked resets per Codex subscription");
  assert.deepEqual(storedRecord(key), before);
});

test("admin API key create reports an unusable Metered pricing response", async () => {
  kvStore.clear();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.reject(new Error("metered pricing is unreachable")));
  try {
    // Without a paid provider credential the initialization fails before any
    // metadata request, which is the closed behavior the create route reports.
    const response = await handleAdminApiKeysCreate(
      adminRequest("/admin/api-keys", { name: "Metered outage", paid_fallback_enabled: true, paid_fallback_limit_credits: 5 })
    );
    assert.equal(response.status, 503);
    const payload = await payloadOf(response);
    // Both closed paths answer 503: no paid provider credential reports
    // `metered_api_key_missing`, a credential without a priced catalog reports
    // `metered_pricing_invalid`. Which one applies depends on whether the test
    // environment exposes a paid provider key.
    assert.match(payload.error?.code ?? "", /^metered_(api_key_missing|pricing_invalid)$/);
    assert.equal(payload.error?.type, "server_error");
    assert.equal(kvStore.get(keyToString(["ubq_ai", "api_keys", "id"])), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // A configured paid provider with no initialized Codex model catalog also
  // fails closed instead of storing an enabled key with no priced models.
  const originalMeteredKey = process.env.METERED_API_KEY;
  process.env.METERED_API_KEY = "metered-coverage-key";
  try {
    const response = await handleAdminApiKeysCreate(
      adminRequest("/admin/api-keys", { name: "No catalog", paid_fallback_enabled: true, paid_fallback_limit_credits: 5 })
    );
    assert.equal(response.status, 503);
    const payload = await payloadOf(response);
    assert.equal(payload.error?.code, "metered_pricing_invalid");
    assert.match(payload.error.message ?? "", /Codex model catalog is initialized/);
  } finally {
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
  }
});

test("admin API key paid fallback history validates the key id and limit", async () => {
  kvStore.clear();
  const key = seedApiKey();
  const blank = await handleAdminApiKeysPaidFallbacks(new Request("https://ai.ubq.fi/admin/api-keys/%20/paid-fallbacks"), " ");
  assert.equal(blank.status, 400);
  assert.equal((await payloadOf(blank)).error?.message, "Invalid API key id");

  const overlong = await handleAdminApiKeysPaidFallbacks(new Request("https://ai.ubq.fi/admin/api-keys/x/paid-fallbacks"), "k".repeat(201));
  assert.equal(overlong.status, 400);

  const unknown = await handleAdminApiKeysPaidFallbacks(new Request("https://ai.ubq.fi/admin/api-keys/none/paid-fallbacks"), "none");
  assert.equal(unknown.status, 404);

  for (const limit of ["0", "not-a-number", "9999999999999999999999"]) {
    const response = await handleAdminApiKeysPaidFallbacks(new Request(`https://ai.ubq.fi/admin/api-keys/${key.id}/paid-fallbacks?limit=${limit}`), key.id);
    assert.equal(response.status, 400);
    assert.equal((await payloadOf(response)).error?.message, "limit must be a positive integer");
  }

  const listed = await handleAdminApiKeysPaidFallbacks(new Request(`https://ai.ubq.fi/admin/api-keys/${key.id}/paid-fallbacks`), key.id);
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { object: "list", data: [] });
});

test("admin API key paid fallback history reports a ledger read failure", async () => {
  kvStore.clear();
  const failingKv = {
    get: () => Promise.resolve({ key: [], value: { id: "broken" }, versionstamp: "00000000000000000001" }),
    list: () => {
      throw new Error("ledger unavailable");
    },
  } as unknown as Kv;
  const response = await handleAdminApiKeysPaidFallbacks(new Request("https://ai.ubq.fi/admin/api-keys/broken/paid-fallbacks"), "broken", failingKv);
  assert.equal(response.status, 500);
  assert.equal((await payloadOf(response)).error?.message, "Failed to load paid fallbacks");
});

test("estimateJsonSize reports non-serializable values as null", () => {
  // Byte length of the UTF-8 JSON text {"model_ids":["gpt-5"]}.
  assert.equal(estimateJsonSize({ model_ids: ["gpt-5"] }), 23);
  assert.equal(estimateJsonSize({ value: 1n }), null);
});

test("Sentinel incident index rejects malformed pagination and unknown query keys", async () => {
  const unavailableIndex = () => Promise.reject(new Error("must not be reached"));
  const cases = [
    "https://ai.ubq.fi/admin/sentinel/incidents?limit=0",
    "https://ai.ubq.fi/admin/sentinel/incidents?limit=101",
    "https://ai.ubq.fi/admin/sentinel/incidents?limit=abc",
    "https://ai.ubq.fi/admin/sentinel/incidents?cursor=",
    "https://ai.ubq.fi/admin/sentinel/incidents?cursor=has%20space",
    "https://ai.ubq.fi/admin/sentinel/incidents?incident_id=not-an-incident",
    "https://ai.ubq.fi/admin/sentinel/incidents?unexpected=1",
    "https://ai.ubq.fi/admin/sentinel/incidents?limit=5&limit=6",
  ];
  for (const url of cases) {
    const response = await handleAdminSentinelIncidents(new Request(url), { listSentinelIncidentIndexRows: unavailableIndex });
    assert.equal(response.status, 400, url);
    const payload = await payloadOf(response);
    assert.equal(payload.error?.type, "invalid_request_error");
    assert.match(payload.error.message ?? "", /limit must be an integer from 1 to 100/);
  }

  const seen: Record<string, unknown>[] = [];
  const accepted = await handleAdminSentinelIncidents(new Request("https://ai.ubq.fi/admin/sentinel/incidents"), {
    listSentinelIncidentIndexRows: (_kv, options) => {
      seen.push(options as Record<string, unknown>);
      return Promise.resolve({ rows: [], cursor: null });
    },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.deepEqual(await accepted.json(), { data: [], cursor: null, coverage: { status: "complete" } });
  assert.deepEqual(seen, [{ incidentId: undefined, limit: 20, cursor: undefined }]);
});

test("Sentinel incident index fails closed when its storage or reader is unavailable", async () => {
  const noKv = await handleAdminSentinelIncidents(new Request("https://ai.ubq.fi/admin/sentinel/incidents?limit=1"), { getKv: () => Promise.resolve(null) });
  assert.equal(noKv.status, 503);
  assert.equal((await payloadOf(noKv)).error?.code, "sentinel_incidents_unavailable");

  const readerFailure = await handleAdminSentinelIncidents(new Request("https://ai.ubq.fi/admin/sentinel/incidents?limit=1"), {
    listSentinelIncidentIndexRows: () => Promise.reject(new Error("index unavailable")),
  });
  assert.equal(readerFailure.status, 503);
  assert.equal((await payloadOf(readerFailure)).error?.message, "Sentinel incident index is unavailable");
});

const sentinelRow = (overrides: Partial<SentinelIncidentIndexRow> = {}): SentinelIncidentIndexRow => ({
  version: 1,
  incident_id: "provider-2f1c4a4e-5b6d-4c7e-8f90-1a2b3c4d5e6f",
  fingerprint: "a".repeat(64),
  severity: "P2",
  first_seen_at_ms: 1_000,
  last_seen_at_ms: 2_000,
  count: 3,
  failing_revision: "b".repeat(40),
  error_type: "response_failed",
  context: { message: "Gateway observed a provider failure for this incident group.", location: null, sample: ["line one", "line two"] },
  provenance: { endpoint: "/v1/responses", captured_at_ms: 1_500, captured_by: null },
  evidence_ref: { ref: "capture:cap-1", digest: "c".repeat(64) },
  evidence_expires_at_ms: 9_000,
  ...overrides,
});

test("Sentinel incident index projects rows onto the frozen wire contract", async () => {
  const relied: { rows: SentinelIncidentIndexRow[]; cursor: string | null } = { rows: [sentinelRow()], cursor: "next-page" };
  const response = await handleAdminSentinelIncidents(
    new Request("https://ai.ubq.fi/admin/sentinel/incidents?limit=5&cursor=abc&incident_id=provider-2f1c4a4e-5b6d-4c7e-8f90-1a2b3c4d5e6f"),
    {
      listSentinelIncidentIndexRows: (_kv, options) => {
        assert.deepEqual(options, {
          incidentId: "provider-2f1c4a4e-5b6d-4c7e-8f90-1a2b3c4d5e6f",
          limit: 5,
          cursor: "abc",
        });
        return Promise.resolve(relied);
      },
    }
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { data?: Record<string, unknown>[]; cursor?: string | null; coverage?: { status?: string } };
  assert.equal(payload.cursor, "next-page");
  assert.equal(payload.coverage?.status, "complete");
  const row = payload.data?.[0] as {
    incident_id?: string;
    fingerprint?: string;
    severity?: string;
    context?: { message?: string; location?: unknown; sample?: unknown[] };
    provenance?: { endpoint?: string; captured_at_ms?: number; captured_by?: unknown };
    evidence_ref?: { ref?: string; digest?: string | null } | null;
    evidence_expires_at_ms?: number | null;
    latest?: unknown;
  };
  assert.equal(row.incident_id, "provider-2f1c4a4e-5b6d-4c7e-8f90-1a2b3c4d5e6f");
  assert.equal(row.severity, "P2");
  assert.equal(row.provenance?.endpoint, "https://ai.ubq.fi/v1/responses");
  assert.equal(row.evidence_ref?.ref, "artifact://sentinel/provider-2f1c4a4e-5b6d-4c7e-8f90-1a2b3c4d5e6f/cap-1");
  assert.equal(row.evidence_ref.digest, "c".repeat(64));
  assert.deepEqual(row.context?.sample, ["line one", "line two"]);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "version"), false);
  assert.equal("latest" in row, false);

  const className = await handleAdminSentinelIncidents(new Request("https://ai.ubq.fi/admin/sentinel/incidents"), {
    listSentinelIncidentIndexRows: () =>
      Promise.resolve({
        rows: [
          sentinelRow({
            fingerprint: "d".repeat(64),
            provenance: { endpoint: "/v1/chat/completions", captured_at_ms: 1, captured_by: null },
            evidence_ref: null,
            evidence_expires_at_ms: null,
          }),
          sentinelRow({ fingerprint: "e".repeat(64), provenance: { endpoint: "other", captured_at_ms: 1, captured_by: null } }),
        ],
        cursor: null,
      }),
  });
  assert.equal(className.status, 200);
  const classPayload = (await className.json()) as { data: { provenance: { endpoint: string }; evidence_ref: unknown }[] };
  assert.equal(classPayload.data[0]?.provenance.endpoint, "https://ai.ubq.fi/v1/chat/completions");
  assert.equal(classPayload.data[0]?.evidence_ref, null);
  assert.equal(classPayload.data[1]?.provenance.endpoint, "https://ai.ubq.fi/");
});

test("Sentinel incident index rejects an unvalidated evidence reference", async () => {
  const response = await handleAdminSentinelIncidents(new Request("https://ai.ubq.fi/admin/sentinel/incidents"), {
    listSentinelIncidentIndexRows: () => Promise.resolve({ rows: [sentinelRow({ evidence_ref: { ref: "https://evil.test/1", digest: null } })], cursor: null }),
  });
  assert.equal(response.status, 503);
  assert.equal((await payloadOf(response)).error?.code, "sentinel_incidents_unavailable");
});

test("Sentinel incident index reads the durable KV index through its default dependencies", async () => {
  kvStore.clear();
  // The KV-backed reader validates the canonical row shape, which carries an
  // empty context sample.
  const readable = sentinelRow({
    fingerprint: "f".repeat(64),
    context: { message: "Gateway observed a provider failure for this incident group.", location: null, sample: [] },
  });
  kvStore.set(keyToString([...SENTINEL_INCIDENT_INDEX_PREFIX, readable.fingerprint]), readable);
  const response = await handleAdminSentinelIncidents(new Request("https://ai.ubq.fi/admin/sentinel/incidents?limit=1"));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { data: { incident_id: string; fingerprint: string }[]; cursor: string | null };
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0]?.fingerprint, "f".repeat(64));
  assert.equal(payload.cursor, null);

  kvStore.set(keyToString([...SENTINEL_INCIDENT_INDEX_PREFIX, "g".repeat(64)]), { version: 1 });
  const broken = await handleAdminSentinelIncidents(new Request("https://ai.ubq.fi/admin/sentinel/incidents?limit=10"));
  assert.equal(broken.status, 503);
  assert.equal((await payloadOf(broken)).error?.code, "sentinel_incidents_unavailable");
});
