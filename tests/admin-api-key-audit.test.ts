import { createFetchMock } from "./helpers/fetch-mock.ts";
import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/admin-auth-harness.ts";
// Focused coverage for the durable API-key change audit: lifecycle actions,
// actor attribution, secret omission, atomic append, bounded reads and the
// retained interactions with existing reservation/deletion guards.

import assert from "node:assert/strict";

import {
  atomicSetCalls,
  handleAdminApiKeysCreate,
  handleAdminApiKeysDelete,
  handleAdminApiKeysUnrevoke,
  handleAdminApiKeysUpdate,
  keyToString,
  kvStore,
  kvStoreHasPrefix,
  meteredMetadataResponse,
  seedCodexSnapshot,
  setAtomicCommitsBeforeFailure,
  setAtomicCommitsToFail,
  urlOf,
} from "./helpers/admin-auth-harness.ts";
import { handleAdminApiKeysRevoke } from "../src/admin/api-key-mutations.ts";
import { handleAdminApiKeyChanges } from "../src/admin/index.ts";
import {
  API_KEY_CHANGE_PREFIX,
  API_KEY_CHANGE_RETENTION_DAYS,
  API_KEY_CHANGE_RETENTION_MS,
  apiKeyChangeEventKey,
  type ApiKeyAuditContext,
  type ApiKeyChangeEvent,
} from "../src/admin/api-key-audit.ts";
import handler from "../src/handler/index.ts";

const KEY_ID_PREFIX = ["ubq_ai", "api_keys", "id"] as const;

type AuditBody = Readonly<{
  object?: string;
  retention_days?: number;
  data?: ApiKeyChangeEvent[];
  next_cursor?: string | null;
}>;

const passkeyContext = (userId = "user-1", handle = "alice"): ApiKeyAuditContext => ({
  auth: {
    ok: true,
    token: "unused-test-token",
    is_super_admin: false,
    method: { kind: "passkey_session", user_id: userId, handle, is_admin: true, credential_count: 1 },
  },
  request_id: "req-passkey-1",
});

const sharedContext = (requestId = "req-shared-1"): ApiKeyAuditContext => ({
  auth: { ok: true, token: "unused-test-token", is_super_admin: true, method: { kind: "admin_allowlist" } },
  request_id: requestId,
});

const passportContext = (sub = "passport-user-42", handle = "bob"): ApiKeyAuditContext => ({
  auth: {
    ok: true,
    token: "unused-jwt-token-never-persisted",
    is_super_admin: false,
    method: {
      kind: "passport_session",
      principal: `passport-user:${sub}`,
      user: {
        sub,
        handle,
        is_admin: true,
        scopes: [],
        auth: "sso",
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: "fixture-jti",
        agent_token_id: null,
      },
    },
  },
  request_id: "req-passport-1",
});


const jsonRequest = (path: string, body: Record<string, unknown>, method = "POST"): Request =>
  new Request(`https://ai.ubq.fi${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createRequest = (body: Record<string, unknown>): Request => jsonRequest("/admin/api-keys", body);
const patchRequest = (body: Record<string, unknown>): Request => jsonRequest("/admin/api-keys", body, "PATCH");
const revokeRequest = (body: Record<string, unknown>): Request => jsonRequest("/admin/api-keys/revoke", body);
const unrevokeRequest = (body: Record<string, unknown>): Request => jsonRequest("/admin/api-keys/unrevoke", body);
const deleteRequest = (body: Record<string, unknown>): Request => jsonRequest("/admin/api-keys", body, "DELETE");

const createKey = async (body: Record<string, unknown>, context = passkeyContext()): Promise<string> => {
  const response = await handleAdminApiKeysCreate(createRequest(body), context);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { id?: string; token?: string };
  const id = payload.id;
  if (typeof id !== "string" || !id) throw new Error("created API key response omitted its id");
  return id;
};

const listAudit = async (query = ""): Promise<{ status: number; body: AuditBody }> => {
  const response = await handleAdminApiKeyChanges(new Request(`https://ai.ubq.fi/admin/api-keys/changes${query}`));
  return { status: response.status, body: (await response.json()) as AuditBody };
};

const storedRecord = (id: string): Record<string, unknown> | undefined =>
  kvStore.get(keyToString([...KEY_ID_PREFIX, id])) as Record<string, unknown> | undefined;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("key lifecycle writes ordered audit events with safe fields and actor attribution", async () => {
  kvStore.clear();

  const id = await createKey({ name: "Audit key", usage_limit_requests: -1, expires_at_ms: -1 });
  const createdToken = (kvStore.get(keyToString([...KEY_ID_PREFIX, id])) as { hash?: string }).hash ?? "";

  await tick();
  assert.equal((await handleAdminApiKeysUpdate(patchRequest({ id, name: "Audit key renamed", usage_limit_requests: 3 }), sharedContext())).status, 200);
  await tick();
  assert.equal((await handleAdminApiKeysRevoke(revokeRequest({ id }), sharedContext())).status, 200);
  await tick();
  assert.equal((await handleAdminApiKeysUnrevoke(unrevokeRequest({ id }), passkeyContext())).status, 200);
  await tick();
  assert.equal((await handleAdminApiKeysRevoke(revokeRequest({ id }), sharedContext())).status, 200);
  await tick();
  assert.equal((await handleAdminApiKeysDelete(deleteRequest({ id }), passkeyContext("user-2", "bob"))).status, 200);

  // The key row is purged, but its deletion event is retained.
  assert.equal(kvStore.has(keyToString([...KEY_ID_PREFIX, id])), false);

  const { status, body } = await listAudit();
  assert.equal(status, 200);
  assert.equal(body.object, "list");
  assert.equal(body.retention_days, API_KEY_CHANGE_RETENTION_DAYS);
  const events = body.data ?? [];
  assert.deepEqual(
    events.map((event) => event.action),
    ["delete", "revoke", "unrevoke", "revoke", "update", "create"]
  );
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index - 1].at_ms >= events[index].at_ms, "events are newest-first");
  }

  const createEvent = events.find((event) => event.action === "create");
  assert.ok(createEvent);
  assert.equal(createEvent.actor.kind, "passkey_user");
  assert.equal(createEvent.actor.principal_id, "user-1");
  assert.equal(createEvent.actor.principal_label, "alice");
  assert.equal(createEvent.target_key_id, id);
  assert.equal(createEvent.target_key_name, "Audit key");
  assert.equal(createEvent.changed.usage_limit_requests, -1);
  assert.equal(createEvent.request_id, "req-passkey-1");
  assert.equal(typeof createEvent.release, "string");
  assert.equal(typeof createEvent.id, "string");

  const updateEvent = events.find((event) => event.action === "update");
  assert.ok(updateEvent);
  assert.equal(updateEvent.actor.kind, "shared_admin_credential");
  assert.equal(updateEvent.actor.principal_id, null);
  assert.equal(updateEvent.changed.usage_limit_requests, 3);
  assert.equal(updateEvent.changed.name, "Audit key renamed");

  const deleteEvent = events.find((event) => event.action === "delete");
  assert.ok(deleteEvent);
  assert.equal(deleteEvent.actor.kind, "passkey_user");
  assert.equal(deleteEvent.actor.principal_id, "user-2");

  // No token, token hash, Authorization header, prompt or raw error is ever served.
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(createdToken), false);
  assert.equal(/authorization|bearer|token_hash|prompt|"hash"|"error"/i.test(serialized), false);
});

test("finite and unlimited wire values round-trip through create, update and persisted readback", async () => {
  kvStore.clear();

  const finiteId = await createKey({ name: "Finite", usage_limit_requests: 7, window_ms: 60_000, expires_at_ms: -1 });
  const unlimitedId = await createKey({ name: "Unlimited", usage_limit_requests: -1, window_ms: 60_000, expires_at_ms: -1 });
  assert.equal(storedRecord(finiteId)?.usage_limit_requests, 7);
  assert.equal(storedRecord(unlimitedId)?.usage_limit_requests, -1);

  // Finite -> unlimited, then unlimited -> finite, both persisted.
  const toUnlimited = await handleAdminApiKeysUpdate(patchRequest({ id: finiteId, usage_limit_requests: -1 }), sharedContext());
  assert.equal(toUnlimited.status, 200);
  assert.equal(((await toUnlimited.json()) as { usage_limit_requests?: number }).usage_limit_requests, -1);
  assert.equal(storedRecord(finiteId)?.usage_limit_requests, -1);

  const toFinite = await handleAdminApiKeysUpdate(patchRequest({ id: unlimitedId, usage_limit_requests: 12 }), sharedContext());
  assert.equal(toFinite.status, 200);
  assert.equal(storedRecord(unlimitedId)?.usage_limit_requests, 12);

  // Malformed finite input is refused; it never quietly becomes unlimited.
  const malformed: readonly (readonly [Record<string, unknown>, string])[] = [
    [{ usage_limit_requests: "5" }, "usage_limit_requests must be a non-negative number or -1 for unlimited"],
    [{ usage_limit_requests: -2 }, "usage_limit_requests must be a non-negative number or -1 for unlimited"],
    [{ window_ms: 0 }, "window_ms must be a positive number"],
    [{ paid_fallback_limit_credits: -5 }, "paid_fallback_limit_credits must be a non-negative number or -1"],
    [{ paid_fallback_enabled: true, paid_fallback_limit_credits: 0 }, "paid_fallback_limit_credits must be positive or -1 when paid fallback is enabled"],
  ];
  for (const [patch, message] of malformed) {
    const response = await handleAdminApiKeysUpdate(patchRequest({ id: finiteId, ...patch }), sharedContext());
    assert.equal(response.status, 400, message);
    assert.equal(((await response.json()) as { error?: { message?: string } }).error?.message, message);
    assert.equal(storedRecord(finiteId)?.usage_limit_requests, -1, "rejected patches do not change the stored policy");
  }

  // An enabled unlimited paid-overflow cap keeps the -1 sentinel and the paid
  // overflow stays distinct from a disabled one.
  const originalFetch = globalThis.fetch;
  const originalMeteredKey = process.env.METERED_API_KEY;
  process.env.METERED_API_KEY = "metered-test-key";
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => Promise.resolve(meteredMetadataResponse(urlOf(input))));
  try {
    seedCodexSnapshot({
      source: "chatgpt_codex",
      updated_at_ms: Date.now(),
      models: [{ slug: "gpt-5.6-sol", context_window: 272_000 }],
    });
    const paidId = await createKey({
      name: "Paid unlimited",
      usage_limit_requests: 3,
      window_ms: 60_000,
      expires_at_ms: -1,
      paid_fallback_enabled: true,
      paid_fallback_limit_credits: -1,
    });
    assert.equal(storedRecord(paidId)?.paid_fallback_enabled, true);
    assert.equal(storedRecord(paidId)?.paid_fallback_limit_microcredits, -1);

    const disabledId = await createKey({ name: "Paid disabled", usage_limit_requests: 3, expires_at_ms: -1 });
    assert.equal(storedRecord(disabledId)?.paid_fallback_enabled, false);
    assert.notEqual(storedRecord(disabledId)?.paid_fallback_limit_microcredits, -1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMeteredKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalMeteredKey;
  }

  const { body } = await listAudit();
  const unlimitedEvent = (body.data ?? []).find((event) => event.target_key_id === finiteId && event.action === "update");
  assert.ok(unlimitedEvent);
  assert.equal(unlimitedEvent.changed.usage_limit_requests, -1);
});

test("an injected audit commit failure leaves key state and history unchanged", async () => {
  kvStore.clear();

  setAtomicCommitsToFail(1);
  const failedCreate = await handleAdminApiKeysCreate(createRequest({ name: "Atomic create", usage_limit_requests: 5 }), passkeyContext());
  assert.equal(failedCreate.status, 500);
  assert.equal(kvStoreHasPrefix([...KEY_ID_PREFIX]), false, "a failed audit commit leaves no key row");
  assert.equal((await listAudit()).body.data?.length, 0, "a failed audit commit leaves no event");

  const id = await createKey({ name: "Atomic update", usage_limit_requests: 5 });
  const before = storedRecord(id);
  setAtomicCommitsToFail(1);
  const failedUpdate = await handleAdminApiKeysUpdate(patchRequest({ id, name: "Should not persist" }), sharedContext());
  assert.equal(failedUpdate.status, 409);
  assert.equal(storedRecord(id)?.name, before?.name);
  assert.equal(
    (await listAudit()).body.data?.some((event) => event.action === "update" && event.changed.name === "Should not persist"),
    false
  );
});

test("audit reads are bounded, paginate newest-first and validate the cursor", async () => {
  kvStore.clear();
  const ids: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    ids.push(await createKey({ name: `Page ${index}`, usage_limit_requests: index + 1 }));
    // Distinct millisecond timestamps make the newest-first order deterministic.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.equal(API_KEY_CHANGE_RETENTION_DAYS, 90);
  assert.equal(API_KEY_CHANGE_RETENTION_MS, 90 * 24 * 60 * 60 * 1000);
  assert.equal(API_KEY_CHANGE_PREFIX[0], "uos_ai");

  // The atomic append carries the 90-day TTL, and an event past the window is
  // never served even if its KV TTL has not been enforced yet.
  const auditSetCall = atomicSetCalls.find(
    (call) => call.key[0] === API_KEY_CHANGE_PREFIX[0] && call.key[1] === API_KEY_CHANGE_PREFIX[1] && call.key[2] === API_KEY_CHANGE_PREFIX[2]
  );
  assert.ok(auditSetCall);
  assert.equal(auditSetCall.expireIn, API_KEY_CHANGE_RETENTION_MS);
  const expiredEvent: ApiKeyChangeEvent = {
    id: "expired-event",
    at_ms: Date.now() - API_KEY_CHANGE_RETENTION_MS - 60_000,
    action: "update",
    actor: { kind: "unknown", principal_id: null, principal_label: null, is_super_admin: false },
    target_key_id: "expired-key",
    target_key_name: "Expired key",
    changed: {},
    request_id: "expired-request",
    release: "test-release",
  };
  kvStore.set(keyToString(apiKeyChangeEventKey(expiredEvent)), expiredEvent);

  const first = await listAudit("?limit=2");
  assert.equal(first.status, 200);
  const firstEvents = first.body.data ?? [];
  assert.equal(firstEvents.length, 2);
  assert.equal(firstEvents[0].target_key_id, ids[4]);
  assert.equal(typeof first.body.next_cursor, "string");

  const second = await listAudit(`?limit=2&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`);
  const secondEvents = second.body.data ?? [];
  assert.equal(secondEvents.length, 2);
  assert.equal(secondEvents[0].target_key_id, ids[2]);

  const third = await listAudit(`?limit=2&cursor=${encodeURIComponent(second.body.next_cursor ?? "")}`);
  const thirdEvents = third.body.data ?? [];
  assert.equal(thirdEvents.length, 1);
  assert.equal(thirdEvents[0].target_key_id, ids[0]);
  assert.equal(third.body.next_cursor, null);

  // Distinct pages never repeat an event.
  const seen = new Set([...firstEvents, ...secondEvents].map((event) => event.id));
  assert.equal(seen.size, 4);

  for (const query of ["?limit=0", "?limit=abc", "?limit=-1", "?cursor=not-a-real-cursor"]) {
    assert.equal((await listAudit(query)).status, 400, query);
  }
  // A large requested limit is bounded by the server cap, never unbounded, and
  // the expired seed is excluded from the bounded page.
  const bounded = await listAudit("?limit=100000");
  assert.equal(bounded.body.data?.length, 5);
  assert.equal(
    bounded.body.data.some((event) => event.id === "expired-event"),
    false
  );
});

test("no-op patch and already-active unrevoke keep success without fabricating an event", async () => {
  kvStore.clear();
  const id = await createKey({ name: "No-op key", usage_limit_requests: 5 });
  const before = (await listAudit()).body.data?.length ?? 0;

  const noopPatch = await handleAdminApiKeysUpdate(patchRequest({ id }));
  assert.equal(noopPatch.status, 200);
  assert.equal(((await noopPatch.json()) as { id?: string }).id, id);
  assert.equal((await listAudit()).body.data?.length, before);

  const activeUnrevoke = await handleAdminApiKeysUnrevoke(unrevokeRequest({ id }));
  assert.equal(activeUnrevoke.status, 200);
  assert.deepEqual(await activeUnrevoke.json(), { id, revoked_at_ms: null });
  assert.equal((await listAudit()).body.data?.length, before);
  assert.equal(storedRecord(id)?.revoked_at_ms, null);
});

test("revoke, unrevoke and final delete audit commits fail closed without key or history changes", async () => {
  kvStore.clear();
  const id = await createKey({ name: "Atomic lifecycle", usage_limit_requests: 5, expires_at_ms: -1 });

  setAtomicCommitsToFail(1);
  const failedRevoke = await handleAdminApiKeysRevoke(revokeRequest({ id }), sharedContext());
  assert.equal(failedRevoke.status, 409);
  assert.equal(storedRecord(id)?.revoked_at_ms, null);
  assert.equal(
    (await listAudit()).body.data?.some((event) => event.action === "revoke"),
    false
  );

  assert.equal((await handleAdminApiKeysRevoke(revokeRequest({ id }), sharedContext())).status, 200);
  const revokeEvents = (await listAudit()).body.data?.filter((event) => event.action === "revoke").length ?? 0;
  assert.equal(revokeEvents, 1);

  setAtomicCommitsToFail(1);
  const failedUnrevoke = await handleAdminApiKeysUnrevoke(unrevokeRequest({ id }), sharedContext());
  assert.equal(failedUnrevoke.status, 409);
  assert.equal(typeof storedRecord(id)?.revoked_at_ms, "number");
  assert.equal((await listAudit()).body.data?.filter((event) => event.action === "unrevoke").length ?? 0, 0);

  // Return the key to revoked so the delete path is allowed, then fail the
  // final delete-plus-audit atomic after its preceding guard claim succeeds.
  assert.equal((await handleAdminApiKeysUnrevoke(unrevokeRequest({ id }), sharedContext())).status, 200);
  assert.equal((await handleAdminApiKeysRevoke(revokeRequest({ id }), sharedContext())).status, 200);
  setAtomicCommitsBeforeFailure(1);
  const failedDelete = await handleAdminApiKeysDelete(deleteRequest({ id }), sharedContext());
  assert.equal(failedDelete.status, 409);
  assert.equal(kvStore.has(keyToString([...KEY_ID_PREFIX, id])), true);
  assert.equal(
    (await listAudit()).body.data?.some((event) => event.action === "delete"),
    false
  );
  assert.equal((await listAudit()).body.data?.filter((event) => event.action === "revoke").length ?? 0, revokeEvents + 1);
});

test("blocked deletion and live reservations keep state and record no event", async () => {
  kvStore.clear();

  const deleteGuardId = await createKey({ name: "Blocked delete", usage_limit_requests: 5, window_ms: 60_000 });
  assert.equal((await handleAdminApiKeysRevoke(revokeRequest({ id: deleteGuardId }))).status, 200);
  kvStore.set(keyToString(["uos_ai", "paid_fallback", "v3", "pending", deleteGuardId, "pending-marker"]), {
    created_at_ms: Date.now() - 1_000,
  });
  const blockedDelete = await handleAdminApiKeysDelete(deleteRequest({ id: deleteGuardId }));
  assert.equal(blockedDelete.status, 409);
  assert.equal(((await blockedDelete.json()) as { error?: { code?: string } }).error?.code, "paid_fallback_billing_outstanding");
  assert.equal(kvStore.has(keyToString([...KEY_ID_PREFIX, deleteGuardId])), true);
  assert.equal(
    (await listAudit()).body.data?.some((event) => event.action === "delete"),
    false
  );

  // A live request reservation still refuses a window-changing update, and the
  // refusal does not append an update event.
  const reservedId = await createKey({ name: "Reserved", usage_limit_requests: 5, window_ms: 60_000 });
  const record = storedRecord(reservedId) as { usage_reset_at_ms: number; window_ms: number };
  const windowStartMs = record.usage_reset_at_ms - record.window_ms;
  kvStore.set(keyToString(["uos_ai", "api_key_usage", "v3", "request", reservedId, `v3:${record.window_ms}`, windowStartMs, "live-lease"]), {
    v: 3,
    key_id: reservedId,
    request_id: "live-lease",
    route: "responses",
    state: "reserved",
    reserved_at_ms: Date.now() - 1_000,
    lease_expires_at_ms: Date.now() + 300_000,
    provider: null,
    dispatched_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  });
  const updatesBefore = (await listAudit()).body.data?.filter((event) => event.target_key_id === reservedId && event.action === "update").length ?? 0;
  const reservedConflict = await handleAdminApiKeysUpdate(patchRequest({ id: reservedId, window_ms: 30_000 }), sharedContext());
  assert.equal(reservedConflict.status, 409);
  assert.match(((await reservedConflict.json()) as { error?: { message?: string } }).error?.message ?? "", /reserved/);
  assert.equal(storedRecord(reservedId)?.window_ms, 60_000);
  const updatesAfter = (await listAudit()).body.data?.filter((event) => event.target_key_id === reservedId && event.action === "update").length ?? 0;
  assert.equal(updatesAfter, updatesBefore);
});

test("the change-history route is authenticated and fails closed without KV", async () => {
  kvStore.clear();
  const anonymous = await handler(new Request("https://ai.ubq.fi/admin/api-keys/changes", { method: "GET" }));
  assert.equal(anonymous.status, 401);
  await anonymous.body?.cancel();

  const unavailable = await handleAdminApiKeyChanges(new Request("https://ai.ubq.fi/admin/api-keys/changes"), null);
  assert.equal(unavailable.status, 500);
  assert.equal(((await unavailable.json()) as { error?: { message?: string } }).error?.message, "Deno KV is not available; cannot load key change history");
});

test("Passport-authenticated admin mutations retain verified Passport subject and handle without persisting JWT", async () => {
  kvStore.clear();

  const id = await createKey(
    { name: "Passport audit key", usage_limit_requests: -1, expires_at_ms: -1 },
    passportContext("sub-passport-user-99", "passport-alice")
  );

  const history = await listAudit();
  assert.equal(history.status, 200);
  assert(history.body.data && history.body.data.length > 0);

  const createEvent = history.body.data.find((e) => e.target_key_id === id && e.action === "create");
  assert(createEvent);
  assert.equal(createEvent.actor.kind, "passport_user");
  assert.equal(createEvent.actor.principal_id, "sub-passport-user-99");
  assert.equal(createEvent.actor.principal_label, "passport-alice");
  assert.equal(createEvent.actor.is_super_admin, false);

  // Verify the JWT is NEVER persisted in the audit event or in stored KV values
  const serializedEvent = JSON.stringify(createEvent);
  assert.equal(serializedEvent.includes("unused-jwt-token-never-persisted"), false);
  const rawKv = JSON.stringify(Array.from(kvStore.values()));
  assert.equal(rawKv.includes("unused-jwt-token-never-persisted"), false);
});
