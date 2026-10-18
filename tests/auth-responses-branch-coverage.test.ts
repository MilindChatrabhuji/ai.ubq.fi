import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/passkeys-harness.ts";
import assert from "node:assert/strict";

import { API_KEY_NO_EXPIRATION_MS, API_KEY_NO_USAGE_LIMIT } from "../src/api-keys.ts";
import {
  API_KEY_USAGE_PROVIDERS,
  ApiKeyQuotaDispatchError,
  apiKeyQuotaUsedPercent,
  apiKeyRateLimitPolicyHeaders,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
  authenticateApiKeyToken,
  deleteApiKeyUsageV3,
  getApiKeyUsageV3,
  hasLiveApiKeyUsageReservationsV3,
  invalidateApiKeyPolicy,
  looksLikeUosApiKey,
  makeApiKeyUsageWindowV3,
  normalizeApiKeyUsageRequestV3,
  normalizeApiKeyUsageWindowV3,
  reclaimApiKeyUsageReservationsForKeyV3,
  reclaimExpiredApiKeyUsageReservationsV3,
  reserveApiKeyUsageV3,
  resetApiKeyPolicyCacheForTest,
} from "../src/api-key-policy.ts";
import type { ApiKeyPolicy } from "../src/api-key-policy.ts";
import type { ApiKeyHashRecord } from "../src/types.ts";
import { getPasskeySession, getPasskeySessionFromRequest } from "../src/auth/passkeys.ts";
import {
  ChatFunctionCallAccumulator,
  chatOutputTextPartKey,
  chatToolCallDelta,
  EMPTY_UPSTREAM_COMPLETION_MESSAGE,
  emptyUpstreamCompletionError,
  malformedFunctionCallStream,
  reconcileChatContentPart,
  reconcileChatOutputItemContent,
  reconcileChatResponseOutputContent,
  reconcileCompletedOutputText,
  reconcileCompletedRefusal,
  recordResponsesTerminal,
  translatedChatOutputObserved,
  withAccumulatedResponseItems,
  withAccumulatedResponseRefusal,
  withAccumulatedResponseText,
} from "../src/chat/stream-translation.ts";
import { setKvForTest } from "../src/kv.ts";
import { sha256Base64Url } from "../src/utils.ts";
import {
  buildPasskeyHandle,
  getPasskeyRequestMeta,
  handlePasskeyLoginFinish,
  handlePasskeyLoginStart,
  handlePasskeyLogout,
  handlePasskeyRegisterFinish,
  handlePasskeyRegisterStart,
  handlePasskeySession,
  handlePasskeyUsersList,
  handlePasskeyUsersUpdate,
  hasPasskeyUsers,
  keyToString,
  kvStore,
  kvStub,
  normalizePasskeyHandle,
  PASSKEY_RELAY_COOKIE_NAME,
  passkeyChallengeKey,
  passkeySessionKey,
  passkeyUserKey,
  seedPasskeySession,
  setBeforeAtomicCommit,
} from "./helpers/passkeys-harness.ts";

/* --------------------------------------------------------------- passkeys */

const jsonRequest = (url: string, body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

const clientDataJson = (challenge: string): string => btoa(JSON.stringify({ type: "webauthn.create", challenge, origin: "https://ai.ubq.fi" }));

const seedChallenge = (challenge: string, overrides: Record<string, unknown> = {}): void => {
  kvStore.set(keyToString(passkeyChallengeKey(challenge)), {
    challenge,
    type: "registration",
    user_id: "user-test",
    handle: "uos-passkey-test",
    rp_id: "ai.ubq.fi",
    origin: "https://ai.ubq.fi",
    is_admin: false,
    created_at_ms: Date.now(),
    expires_at_ms: Date.now() + 60_000,
    ...overrides,
  });
};

/** Runs one handler with the KV binding removed, restoring it afterwards. */
const withoutKv = async (run: () => Promise<void>): Promise<void> => {
  setKvForTest(null);
  try {
    await run();
  } finally {
    setKvForTest(kvStub);
  }
};

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("passkey handles are normalized and an empty seed produces no handle", async () => {
  assert.equal(await buildPasskeyHandle("   "), "", "a blank seed has no usable fingerprint");
  assert.match(await buildPasskeyHandle("  token-value  "), /^uos-passkey-[0-9a-f]{16}$/);
  assert.equal(normalizePasskeyHandle("---"), "", "leading and trailing separators are stripped");
  assert.equal(normalizePasskeyHandle("---Mixed   Name---"), "mixed-name");
  assert.equal(normalizePasskeyHandle(null), "");
  assert.equal(normalizePasskeyHandle("a".repeat(200)).length, 96);
});

test("passkey request metadata prefers a trusted origin and tolerates malformed headers", () => {
  const canonical = getPasskeyRequestMeta(new Request("https://ai.ubq.fi/auth/passkey/register/start"));
  assert.equal(canonical.origin, "https://ai.ubq.fi");
  assert.equal(canonical.rpId, "ai.ubq.fi");

  const forwarded = getPasskeyRequestMeta(
    new Request("https://internal.example/auth/passkey/register/start", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "ai.ubq.fi" } })
  );
  assert.equal(forwarded.origin, "https://ai.ubq.fi");

  const malformedHost = getPasskeyRequestMeta(new Request("https://ai.ubq.fi/x", { headers: { "x-forwarded-host": "not a host /" } }));
  assert.equal(malformedHost.origin, "https://ai.ubq.fi", "an unusable host header falls back to the canonical origin");

  const loopback = getPasskeyRequestMeta(new Request("http://localhost:8080/x", { headers: { "x-forwarded-proto": "http" } }));
  assert.equal(loopback.origin, "http://localhost:8080", "a loopback host is trusted for local development");

  const untrusted = getPasskeyRequestMeta(new Request("https://ai.ubq.fi/x"), "https://evil.example.com");
  assert.equal(untrusted.origin, "https://ai.ubq.fi");
  const garbageOrigin = getPasskeyRequestMeta(new Request("https://ai.ubq.fi/x"), "not a url");
  assert.equal(garbageOrigin.origin, "https://ai.ubq.fi");
});

test("passkey sessions reject unknown, expired and orphaned records", async () => {
  kvStore.clear();
  assert.equal(await getPasskeySession("uos_ai_session_missing"), null);
  assert.equal(await hasPasskeyUsers(), false);

  seedPasskeySession("uos_ai_session_live_here");
  const expiredRecord = kvStore.get(keyToString(passkeySessionKey("uos_ai_session_live_here"))) as { expires_at_ms: number };
  kvStore.set(keyToString(passkeySessionKey("uos_ai_session_live_here")), { ...expiredRecord, expires_at_ms: Date.now() - 1 });
  assert.equal(await getPasskeySession("uos_ai_session_live_here"), null, "an expired session is refused and removed");
  assert.equal(kvStore.has(keyToString(passkeySessionKey("uos_ai_session_live_here"))), false);

  const orphanToken = "uos_ai_session_orphan";
  kvStore.set(keyToString(passkeySessionKey(orphanToken)), {
    token: orphanToken,
    user_id: "user-gone",
    created_at_ms: Date.now(),
    expires_at_ms: Date.now() + 60_000,
  });
  assert.equal(await getPasskeySession(orphanToken), null, "a session whose user disappeared is refused");
  assert.equal(await hasPasskeyUsers(), true);
  const { token } = seedPasskeySession("uos_ai_session_usable");
  assert.ok(await getPasskeySession(token));
});

test("a passkey session is read from a bearer token or the relay cookie, and a corrupt cookie is refused", async () => {
  kvStore.clear();
  const { token } = seedPasskeySession("uos_ai_session_cookie");

  const bearer = await getPasskeySessionFromRequest(new Request("https://ai.ubq.fi/x", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(bearer?.token, token);

  const cookie = await getPasskeySessionFromRequest(
    new Request("https://ai.ubq.fi/x", { headers: { cookie: `other=1; ${PASSKEY_RELAY_COOKIE_NAME}=${token}` } })
  );
  assert.equal(cookie?.token, token);

  const emptyCookie = await getPasskeySessionFromRequest(new Request("https://ai.ubq.fi/x", { headers: { cookie: `${PASSKEY_RELAY_COOKIE_NAME}=` } }));
  assert.equal(emptyCookie, null, "an empty cookie value carries no token");
  const corruptCookie = await getPasskeySessionFromRequest(
    new Request("https://ai.ubq.fi/x", { headers: { cookie: `${PASSKEY_RELAY_COOKIE_NAME}=%E0%A4%A` } })
  );
  assert.equal(corruptCookie, null, "a cookie that cannot be decoded is refused instead of throwing");
  assert.equal(await getPasskeySessionFromRequest(new Request("https://ai.ubq.fi/x")), null);
});

test("passkey handlers fail closed without a KV binding", async () => {
  await withoutKv(async () => {
    assert.equal(await hasPasskeyUsers(), false);
    assert.equal((await handlePasskeyRegisterStart(jsonRequest("https://ai.ubq.fi/auth/passkey/register/start", {}), {})).status, 503);
    assert.equal((await handlePasskeyRegisterFinish(jsonRequest("https://ai.ubq.fi/auth/passkey/register/finish", {}))).status, 503);
    assert.equal((await handlePasskeyLoginStart(jsonRequest("https://ai.ubq.fi/auth/passkey/login/start", {}))).status, 503);
    assert.equal((await handlePasskeyLoginFinish(jsonRequest("https://ai.ubq.fi/auth/passkey/login/finish", {}))).status, 503);
    assert.equal((await handlePasskeyUsersList()).status, 503);
    assert.equal((await handlePasskeyUsersUpdate(jsonRequest("https://ai.ubq.fi/admin/passkeys", {}))).status, 503);
    assert.equal(await getPasskeySession("uos_ai_session_any"), null);
  });
});

test("passkey register start validates the body, refuses a taken username and issues a challenge", async () => {
  kvStore.clear();
  const start = (body: unknown, options: { defaultIsAdmin?: boolean; authenticatedPasskeyToken?: string } = {}) =>
    handlePasskeyRegisterStart(jsonRequest("https://ai.ubq.fi/auth/passkey/register/start", body), options);

  const notJson = await handlePasskeyRegisterStart(new Request("https://ai.ubq.fi/auth/passkey/register/start", { method: "POST", body: "not json" }));
  assert.equal(notJson.status, 400);
  assert.equal((await start("a string, not an object")).status, 400, "a non-object body is refused");

  const { user } = seedPasskeySession("uos_ai_session_owner");
  const taken = await start({ handle: user.handle });
  assert.equal(taken.status, 409, "an existing username owned by another account cannot be registered again");

  const created = await start({ handle: "Brand New Name" }, { defaultIsAdmin: true });
  assert.equal(created.status, 200);
  const createdBody = (await created.json()) as { publicKey: { challenge: unknown }; handle: string };
  assert.equal(createdBody.handle, "brand-new-name");
  assert.ok(createdBody.publicKey.challenge, "a registration challenge is issued");

  const existing = seedPasskeySession("uos_ai_session_existing");
  const rekeyed = await start({ handle: existing.user.handle }, { authenticatedPasskeyToken: existing.token });
  assert.equal(rekeyed.status, 200);
  assert.equal(((await rekeyed.json()) as { handle: string }).handle, existing.user.handle);

  const unauthorized = await start({ handle: "whatever" }, { authenticatedPasskeyToken: "uos_ai_session_absent" });
  assert.equal(unauthorized.status, 401, "an unknown relay token is refused");
});

test("passkey register finish rejects every unusable challenge before attestation", async () => {
  const finish = (body: unknown) => handlePasskeyRegisterFinish(jsonRequest("https://ai.ubq.fi/auth/passkey/register/finish", body));
  assert.equal((await handlePasskeyRegisterFinish(new Request("https://ai.ubq.fi/x", { method: "POST", body: "not json" }))).status, 400);
  assert.equal((await finish({})).status, 400, "a body without a webauthn response is refused");
  assert.equal((await finish({ response: { id: "credential" } })).status, 400, "a response without client data is refused");
  assert.equal((await finish({ response: { id: "credential", response: { clientDataJSON: "not base64!!" } } })).status, 400);

  const unknownChallenge = await finish({ response: { id: "credential", response: { clientDataJSON: clientDataJson("unknown-challenge") } } });
  assert.equal(unknownChallenge.status, 400, "an unknown challenge is refused");

  seedChallenge("login-shaped", { type: "authentication" });
  const wrongType = await finish({ response: { id: "credential", response: { clientDataJSON: clientDataJson("login-shaped") } } });
  assert.equal(wrongType.status, 400, "an authentication challenge is not a registration challenge");

  seedChallenge("attestation-fails");
  const failedAttestation = await finish({
    response: { id: "credential", response: { clientDataJSON: clientDataJson("attestation-fails"), attestationObject: "AA" } },
  });
  assert.equal(failedAttestation.status, 400, "an invalid attestation is refused");
});

test("passkey login start validates the relay origin and tolerates an empty body", async () => {
  kvStore.clear();
  const emptyBody = await handlePasskeyLoginStart(new Request("https://ai.ubq.fi/auth/passkey/login/start", { method: "POST" }));
  assert.equal(emptyBody.status, 200, "an empty login-start body is allowed so the browser can discover the accountless flow");

  const badOrigin = await handlePasskeyLoginStart(jsonRequest("https://ai.ubq.fi/auth/passkey/login/start", { relay_origin: "not a url" }));
  assert.equal(badOrigin.status, 400, "an unusable relay origin is refused");
  const untrustedOrigin = await handlePasskeyLoginStart(
    jsonRequest("https://ai.ubq.fi/auth/passkey/login/start", { relay_origin: "https://evil.example.com" })
  );
  assert.equal(untrustedOrigin.status, 400, "an untrusted relay origin is refused");

  const relayed = await handlePasskeyLoginStart(jsonRequest("https://ai.ubq.fi/auth/passkey/login/start", { relay_origin: "https://ai.ubq.fi" }));
  assert.equal(relayed.status, 200, "the canonical relay origin is trusted");
});

test("passkey login finish rejects an unusable response, challenge and credential", async () => {
  const finish = (body: unknown) => handlePasskeyLoginFinish(jsonRequest("https://ai.ubq.fi/auth/passkey/login/finish", body));
  assert.equal((await handlePasskeyLoginFinish(new Request("https://ai.ubq.fi/x", { method: "POST", body: "not json" }))).status, 400);
  assert.equal((await finish({})).status, 400);
  assert.equal(
    (await finish({ response: { response: { clientDataJSON: clientDataJson("c") } } })).status,
    400,
    "a response without a credential id is refused"
  );
  assert.equal((await finish({ response: { id: "credential", response: { clientDataJSON: "!!!" } } })).status, 400);
  assert.equal((await finish({ response: { id: "credential", response: { clientDataJSON: clientDataJson("absent") } } })).status, 400);

  seedChallenge("registration-shaped", { type: "registration" });
  const wrongType = await finish({ response: { id: "credential", response: { clientDataJSON: clientDataJson("registration-shaped") } } });
  assert.equal(wrongType.status, 400, "a registration challenge is not an authentication challenge");

  seedChallenge("unknown-credential", { type: "authentication", user_id: undefined });
  const unknownCredential = await finish({ response: { id: "absent-credential", response: { clientDataJSON: clientDataJson("unknown-credential") } } });
  assert.equal(unknownCredential.status, 400, "an unknown credential is refused");
});

test("an expired passkey challenge is consumed once and refused", async () => {
  kvStore.clear();
  seedChallenge("expired-challenge", { expires_at_ms: Date.now() - 1 });
  const response = await handlePasskeyRegisterFinish(
    jsonRequest("https://ai.ubq.fi/auth/passkey/register/finish", {
      response: { id: "credential", response: { clientDataJSON: clientDataJson("expired-challenge") } },
    })
  );
  assert.equal(response.status, 400);
  assert.equal(kvStore.has(keyToString(passkeyChallengeKey("expired-challenge"))), false, "an expired challenge is deleted when it is read");
});

test("passkey user administration lists stored users and validates every update field", async () => {
  kvStore.clear();
  const now = Date.now();
  kvStore.set(keyToString(passkeyUserKey("user-old")), {
    id: "user-old",
    handle: "first",
    is_admin: false,
    credential_ids: [],
    created_at_ms: now - 500,
    updated_at_ms: now - 500,
  });
  kvStore.set(keyToString(passkeyUserKey("user-new")), {
    id: "user-new",
    handle: "second",
    is_admin: true,
    credential_ids: ["c1"],
    created_at_ms: now,
    updated_at_ms: now,
  });
  const listed = await handlePasskeyUsersList();
  assert.equal(listed.status, 200);
  const listBody = (await listed.json()) as { object: string; data: { id: string }[] };
  assert.equal(listBody.object, "list");
  assert.deepEqual(
    listBody.data.map((user) => user.id),
    ["user-new", "user-old"],
    "users are listed newest first"
  );

  const update = (body: unknown) => handlePasskeyUsersUpdate(jsonRequest("https://ai.ubq.fi/admin/passkeys", body));
  assert.equal((await handlePasskeyUsersUpdate(new Request("https://ai.ubq.fi/x", { method: "POST", body: "not json" }))).status, 400);
  assert.equal((await update([])).status, 400);
  assert.equal((await update({ is_admin: true })).status, 400, "an update without an id is refused");
  assert.equal((await update({ id: "user-new", is_admin: "yes" })).status, 400, "a non-boolean admin flag is refused");
  assert.equal((await update({ id: "user-absent", is_admin: true })).status, 404);

  const updated = await update({ id: "user-new", is_admin: false });
  assert.equal(updated.status, 200);
  assert.equal(((await updated.json()) as { user: { is_admin: boolean } }).user.is_admin, false);

  setBeforeAtomicCommit(() => {
    const stored = kvStore.get(keyToString(passkeyUserKey("user-new"))) as Record<string, unknown>;
    kvStore.set(keyToString(passkeyUserKey("user-new")), { ...stored, updated_at_ms: Date.now() + 5 });
  });
  const conflicted = await update({ id: "user-new", is_admin: true });
  assert.equal(conflicted.status, 409, "a concurrently modified user is reported instead of overwritten");
});

test("passkey session and logout handlers require a live session", async () => {
  kvStore.clear();
  const anonymousSession = await handlePasskeySession(new Request("https://ai.ubq.fi/auth/session"));
  assert.equal(anonymousSession.status, 401);
  const anonymousLogout = await handlePasskeyLogout(new Request("https://ai.ubq.fi/auth/logout"));
  assert.equal(anonymousLogout.status, 204, "logout is idempotent for an anonymous caller");

  const { token, user } = seedPasskeySession("uos_ai_session_live");
  const session = await handlePasskeySession(new Request("https://ai.ubq.fi/auth/session", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(session.status, 200);
  assert.equal(((await session.json()) as { user: { id: string } }).user.id, user.id);

  const logout = await handlePasskeyLogout(new Request("https://ai.ubq.fi/auth/logout", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(logout.status, 204);
  assert.equal(await getPasskeySession(token), null, "logout removes the session");

  const relayed = await handlePasskeySession(new Request("https://ai.ubq.fi/auth/session"), { authenticatedPasskeyToken: "uos_ai_session_absent" });
  assert.equal(relayed.status, 401, "an expired relay token is refused");
});
/* --------------------------------------------------------- api-key-policy */

const TOKEN = `u_${"a".repeat(64)}`;

const hashRecord = (overrides: Partial<ApiKeyHashRecord> = {}): ApiKeyHashRecord => ({
  id: "key-1",
  expires_at_ms: API_KEY_NO_EXPIRATION_MS,
  revoked_at_ms: null,
  usage_limit_requests: 10,
  usage_requests: 0,
  usage_reset_at_ms: Date.now() + 60_000,
  window_ms: 60_000,
  usage_quota_version: 3,
  paid_fallback_enabled: false,
  paid_fallback_limit_microcredits: 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
  ...overrides,
});

/** The HTTP status of a failed decision: 0 when the decision succeeded. */
const failureStatus = (decision: { ok: true } | { ok: false; response: Response }): number => (decision.ok ? 0 : decision.response.status);

/** The policy of a successful decision, or null when authentication was refused. */
const policyOrNull = (decision: { ok: true; policy: ApiKeyPolicy } | { ok: false; response: Response }): ApiKeyPolicy | null =>
  decision.ok ? decision.policy : null;

const policyOf = (overrides: Partial<ApiKeyPolicy> = {}): ApiKeyPolicy => ({
  token_hash: "hash-1",
  key_id: "key-1",
  expires_at_ms: API_KEY_NO_EXPIRATION_MS,
  usage_limit_requests: 2,
  window_ms: 60_000,
  window_start_ms: 0,
  usage_reset_at_ms: 60_000,
  policy_version: "v3:60000",
  paid_fallback_enabled: false,
  paid_fallback_limit_microcredits: 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
  ...overrides,
});

/** A policy whose first window starts exactly at `nowMs`. */
const policyAt = (nowMs: number, overrides: Partial<ApiKeyPolicy> = {}): ApiKeyPolicy =>
  policyOf({ window_start_ms: nowMs, usage_reset_at_ms: nowMs + 60_000, ...overrides });

const seedPolicyRecord = (policy: ApiKeyPolicy): void => {
  kvStore.set(
    keyToString(["ubq_ai", "api_keys", "hash", policy.token_hash]),
    hashRecord({
      id: policy.key_id,
      usage_limit_requests: policy.usage_limit_requests,
      usage_reset_at_ms: policy.usage_reset_at_ms,
      window_ms: policy.window_ms,
    })
  );
};

const seedHashRecord = async (record: ApiKeyHashRecord, token = TOKEN): Promise<string> => {
  const tokenHash = await sha256Base64Url(token);
  kvStore.set(keyToString(["ubq_ai", "api_keys", "hash", tokenHash]), record);
  return tokenHash;
};

test("an api key token shape, the usage window and the reset projection are validated", () => {
  assert.equal(looksLikeUosApiKey(TOKEN), true);
  assert.equal(looksLikeUosApiKey(`  ${TOKEN}  `), true, "surrounding whitespace is tolerated");
  assert.equal(looksLikeUosApiKey("u_short"), false);
  assert.equal(looksLikeUosApiKey(`u_${"A".repeat(64)}`), false, "the opaque id is lowercase hex");

  const window = makeApiKeyUsageWindowV3(policyOf({ window_start_ms: 1_000, usage_reset_at_ms: 61_000 }), 5_000);
  assert.equal(window.v, 3);
  assert.equal(window.key_id, "key-1");
  assert.equal(window.committed_requests, 0);
  assert.equal(window.reserved_requests, 0);
});

test("a malformed usage window or request row is refused instead of trusted", () => {
  const validWindow = {
    v: 3,
    key_id: "key-1",
    policy_version: "v3:60000",
    window_start_ms: 0,
    window_reset_at_ms: 1,
    committed_requests: 0,
    reserved_requests: 0,
    updated_at_ms: 0,
  };
  assert.deepEqual(normalizeApiKeyUsageWindowV3(validWindow), validWindow);
  assert.equal(normalizeApiKeyUsageWindowV3(null), null);
  assert.equal(normalizeApiKeyUsageWindowV3({ ...validWindow, v: 2 }), null);
  assert.equal(normalizeApiKeyUsageWindowV3({ ...validWindow, key_id: "" }), null);
  assert.equal(normalizeApiKeyUsageWindowV3({ ...validWindow, policy_version: "" }), null);
  assert.equal(normalizeApiKeyUsageWindowV3({ ...validWindow, window_start_ms: -1 }), null);
  assert.equal(normalizeApiKeyUsageWindowV3({ ...validWindow, window_reset_at_ms: 0 }), null, "a reset at or before the window start is unusable");
  assert.equal(normalizeApiKeyUsageWindowV3({ ...validWindow, committed_requests: 1.5 }), null);
  assert.equal(normalizeApiKeyUsageWindowV3({ ...validWindow, reserved_requests: -2 }), null);
  assert.equal(normalizeApiKeyUsageWindowV3({ ...validWindow, updated_at_ms: Number.NaN }), null);

  const reserved = {
    v: 3,
    key_id: "key-1",
    request_id: "request-1",
    route: "/v1/responses",
    state: "reserved",
    provider: null,
    reserved_at_ms: 0,
    lease_expires_at_ms: 1,
    dispatched_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  };
  assert.deepEqual(normalizeApiKeyUsageRequestV3(reserved), reserved);
  assert.equal(normalizeApiKeyUsageRequestV3("reserved"), null);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...reserved, v: 1 }), null);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...reserved, key_id: "" }), null);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...reserved, request_id: "" }), null);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...reserved, route: "" }), null);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...reserved, state: "unknown" }), null);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...reserved, provider: "unlisted" }), null);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...reserved, lease_expires_at_ms: -1 }), null);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...reserved, provider: "cerebras" }), null, "a reserved row may not name a provider");
  assert.equal(normalizeApiKeyUsageRequestV3({ ...reserved, released_at_ms: 5 }), null);
  assert.ok(
    normalizeApiKeyUsageRequestV3({ ...reserved, state: "dispatched", dispatched_at_ms: 1, provider: "cerebras" }),
    "a dispatched row with a provider and dispatch time is usable"
  );
  const dispatched = { ...reserved, state: "dispatched", provider: "cerebras", dispatched_at_ms: 2 };
  assert.deepEqual(normalizeApiKeyUsageRequestV3(dispatched), dispatched);
  const openRouterDispatched = { ...reserved, state: "dispatched", provider: "openrouter", dispatched_at_ms: 2 };
  assert.deepEqual(normalizeApiKeyUsageRequestV3(openRouterDispatched), openRouterDispatched, "an OpenRouter dispatch keeps its provider identity");
  // Every provider the ledger may write must stay readable: an unreadable
  // dispatched row surfaces as an unavailable reservation for the next hop.
  for (const provider of API_KEY_USAGE_PROVIDERS) {
    const row = { ...reserved, state: "dispatched" as const, provider, dispatched_at_ms: 2 };
    assert.deepEqual(normalizeApiKeyUsageRequestV3(row), row, `a ${provider} dispatch row stays readable`);
  }
  assert(API_KEY_USAGE_PROVIDERS.includes("claude_code"), "the Claude subscription dispatch must be a listed API-key usage provider");
  assert.equal(normalizeApiKeyUsageRequestV3({ ...dispatched, provider: null }), null);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...dispatched, dispatched_at_ms: null }), null);
  const released = { ...reserved, state: "released", released_at_ms: 3, release_reason: "route_completed_without_provider_dispatch" };
  assert.deepEqual(normalizeApiKeyUsageRequestV3(released), released);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...released, release_reason: null }), null);
  assert.equal(normalizeApiKeyUsageRequestV3({ ...released, provider: "cerebras" }), null);
});

test("rate-limit policy headers and the used-percent projection describe only bounded policies", () => {
  assert.deepEqual(apiKeyRateLimitPolicyHeaders(null), {});
  assert.deepEqual(apiKeyRateLimitPolicyHeaders(policyOf({ usage_limit_requests: API_KEY_NO_USAGE_LIMIT })), {}, "an unlimited key advertises no policy");
  assert.deepEqual(apiKeyRateLimitPolicyHeaders(policyOf({ usage_limit_requests: 100, window_ms: 3_600_000 })), {
    "RateLimit-Policy": '"api-key";q=100;w=3600',
  });

  assert.equal(apiKeyQuotaUsedPercent(null), null);
  assert.equal(apiKeyQuotaUsedPercent(policyOf()), null, "a key without paid fallback has no spend projection");
  assert.equal(apiKeyQuotaUsedPercent(policyOf({ paid_fallback_enabled: true, paid_fallback_limit_microcredits: 0 })), null);
  const spend = (spent: number, reserved: number) =>
    apiKeyQuotaUsedPercent(
      policyOf({
        paid_fallback_enabled: true,
        paid_fallback_limit_microcredits: 4,
        paid_fallback_spent_microcredits: spent,
        paid_fallback_reserved_microcredits: reserved,
      })
    );
  assert.equal(spend(0, 0), 0);
  assert.equal(spend(3, 0), 75);
  assert.equal(spend(1, 1), 50, "reserved microcredits count toward the projection");
  assert.equal(spend(9, 0), 100, "a projection is capped");
});

test("authentication refuses an absent, revoked, legacy or expired key record", async () => {
  kvStore.clear();
  resetApiKeyPolicyCacheForTest();
  const nowMs = Date.now();

  assert.equal((await authenticateApiKeyToken("not-a-uos-key")).ok, false);
  assert.equal((await authenticateApiKeyToken(`u_${"b".repeat(63)}`)).ok, false);
  const withoutKv = await authenticateApiKeyToken(TOKEN, { kv: null });
  assert.equal(withoutKv.ok, false);
  assert.equal(failureStatus(withoutKv), 401);

  const missing = await authenticateApiKeyToken(TOKEN, { nowMs });
  assert.equal(failureStatus(missing), 401, "a key with no hash record is refused as unauthorized");

  await seedHashRecord(hashRecord({ revoked_at_ms: nowMs - 1 }));
  const revoked = await authenticateApiKeyToken(TOKEN, { nowMs });
  assert.equal(failureStatus(revoked), 401);

  kvStore.clear();
  await seedHashRecord(hashRecord({ usage_quota_version: 2 }));
  const legacy = await authenticateApiKeyToken(TOKEN, { nowMs });
  assert.equal(failureStatus(legacy), 503);

  kvStore.clear();
  await seedHashRecord(hashRecord({ expires_at_ms: nowMs - 1 }));
  const expired = await authenticateApiKeyToken(TOKEN, { nowMs });
  assert.equal(failureStatus(expired), 401);
});

test("authentication serves a live policy, reuses its cache and rolls the window forward", async () => {
  kvStore.clear();
  resetApiKeyPolicyCacheForTest();
  const nowMs = Date.now();
  await seedHashRecord(hashRecord({ usage_reset_at_ms: nowMs + 30_000 }));

  const first = await authenticateApiKeyToken(TOKEN, { nowMs });
  assert.equal(first.ok, true);
  const policy = policyOrNull(first);
  assert.ok(policy);
  assert.equal(policy.key_id, "key-1");
  assert.equal(policy.usage_limit_requests, 10);

  const second = await authenticateApiKeyToken(TOKEN, { nowMs: nowMs + 1_000 });
  assert.equal(second.ok, true, "a cached policy inside its TTL avoids a KV read");

  const rolled = await authenticateApiKeyToken(TOKEN, { nowMs: policy.usage_reset_at_ms + 1 });
  assert.equal(rolled.ok, true);
  assert.ok(rolled.ok);
  assert.ok(rolled.policy.window_start_ms > policy.window_start_ms, "a policy past its reset rolls into the next window");

  invalidateApiKeyPolicy();
  const afterInvalidateAll = await authenticateApiKeyToken(TOKEN, { nowMs: policy.usage_reset_at_ms + 2 });
  assert.equal(afterInvalidateAll.ok, true);
  invalidateApiKeyPolicy("other-key");
  invalidateApiKeyPolicy("key-1");
  const afterInvalidateKey = await authenticateApiKeyToken(TOKEN, { nowMs: policy.usage_reset_at_ms + 3 });
  assert.equal(afterInvalidateKey.ok, true);

  kvStore.clear();
  resetApiKeyPolicyCacheForTest();
  await seedHashRecord(hashRecord({ expires_at_ms: nowMs + 5_000, usage_reset_at_ms: nowMs + 30_000 }));
  const soonExpired = await authenticateApiKeyToken(TOKEN, { nowMs });
  assert.equal(soonExpired.ok, true);
  const afterExpiry = await authenticateApiKeyToken(TOKEN, { nowMs: nowMs + 6_000 });
  assert.equal(failureStatus(afterExpiry), 401, "a cached policy is rechecked against its expiry");
});

test("reserving usage requires a binding, ids and a usable window", async () => {
  kvStore.clear();
  const nowMs = Date.now();
  const policy = policyAt(nowMs);
  seedPolicyRecord(policy);

  const noKv = await reserveApiKeyUsageV3(policy, "request-1", "/v1/responses", { kv: null, nowMs });
  assert.equal(failureStatus(noKv), 503);
  const noIds = await reserveApiKeyUsageV3(policy, "", "", { kv: kvStub, nowMs });
  assert.equal(failureStatus(noIds), 503);

  kvStore.set(keyToString(apiKeyUsageV3RequestKey(policy, "request-malformed")), { v: 3, key_id: policy.key_id });
  const malformed = await reserveApiKeyUsageV3(policy, "request-malformed", "/v1/responses", { kv: kvStub, nowMs });
  assert.equal(failureStatus(malformed), 503, "a malformed row fails closed");

  const reserved = await reserveApiKeyUsageV3(policy, "request-2", "/v1/responses", { kv: kvStub, nowMs });
  assert.equal(reserved.ok, true);
  assert.ok(reserved.ok);
  assert.equal(reserved.reservation.request_id, "request-2");
  assert.equal(await getApiKeyUsageV3(policy, kvStub), 0, "a reservation is not yet committed usage");
  assert.equal(await hasLiveApiKeyUsageReservationsV3(kvStub, policy.key_id, nowMs), true);

  const reused = await reserveApiKeyUsageV3(policy, "request-2", "/v1/responses", { kv: kvStub, nowMs });
  assert.equal(reused.ok, true, "the same request reuses its own reservation");

  const dispatched = await reserved.reservation.beforeProviderDispatch("cerebras");
  assert.ok(dispatched, "a dispatch admission returns the provider dispatch context");
  assert.equal(typeof dispatched.cancelBeforeTransport, "function");
  assert.equal(await getApiKeyUsageV3(policy, kvStub), 1, "a dispatched reservation becomes committed usage");
  await reserved.reservation.release("route_completed_without_provider_dispatch");
  assert.equal(await getApiKeyUsageV3(policy, kvStub), 1, "a dispatched reservation cannot be released");

  const second = policyAt(nowMs, { key_id: "key-2", token_hash: "hash-2", usage_limit_requests: 1 });
  seedPolicyRecord(second);
  const thirdReservation = await reserveApiKeyUsageV3(second, "request-3", "/v1/responses", { kv: kvStub, nowMs });
  assert.equal(thirdReservation.ok, true);
  assert.ok(thirdReservation.ok);
  await thirdReservation.reservation.release("client_disconnected");
  assert.equal(await getApiKeyUsageV3(second, kvStub), 0, "releasing a reserved request never consumes quota");
  assert.equal(await hasLiveApiKeyUsageReservationsV3(kvStub, second.key_id, nowMs), false, "a released reservation is no longer live");

  const exhausted = await reserveApiKeyUsageV3(policy, "request-4", "/v1/responses", {
    kv: kvStub,
    nowMs: policy.usage_reset_at_ms + 1,
  });
  assert.equal(exhausted.ok, true, "a new window starts empty");
});

test("expired leases are reclaimed before admission and can be reclaimed by key", async () => {
  kvStore.clear();
  const nowMs = 100_000;
  const policy = policyAt(0, { usage_limit_requests: 1, window_start_ms: 0, usage_reset_at_ms: 60_000 });
  seedPolicyRecord(policy);
  const expiredRequest = {
    v: 3,
    key_id: policy.key_id,
    request_id: "request-expired",
    route: "/v1/responses",
    state: "reserved",
    provider: null,
    reserved_at_ms: 0,
    lease_expires_at_ms: nowMs - 1,
    dispatched_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  };
  kvStore.set(keyToString(apiKeyUsageV3RequestKey(policy, "request-expired")), expiredRequest);
  kvStore.set(keyToString(apiKeyUsageV3WindowKey(policy)), {
    v: 3,
    key_id: policy.key_id,
    policy_version: policy.policy_version,
    window_start_ms: policy.window_start_ms,
    window_reset_at_ms: policy.usage_reset_at_ms,
    committed_requests: 0,
    reserved_requests: 1,
    updated_at_ms: 0,
  });

  await reclaimExpiredApiKeyUsageReservationsV3(kvStub, policy, nowMs);
  const released = kvStore.get(keyToString(apiKeyUsageV3RequestKey(policy, "request-expired"))) as { state: string; release_reason: string };
  assert.equal(released.state, "released", "an expired lease is released before admission");
  assert.equal(released.release_reason, "lease_expired");
  const window = kvStore.get(keyToString(apiKeyUsageV3WindowKey(policy))) as { reserved_requests: number };
  assert.equal(window.reserved_requests, 0);

  kvStore.set(keyToString(apiKeyUsageV3RequestKey(policy, "request-expired-2")), { ...expiredRequest, request_id: "request-expired-2" });
  kvStore.set(keyToString(apiKeyUsageV3WindowKey(policy)), { ...window, reserved_requests: 1 });
  await reclaimApiKeyUsageReservationsForKeyV3(kvStub, policy.key_id, nowMs);
  assert.equal((kvStore.get(keyToString(apiKeyUsageV3RequestKey(policy, "request-expired-2"))) as { state: string }).state, "released");

  await deleteApiKeyUsageV3(kvStub, policy.key_id);
  assert.equal(kvStore.has(keyToString(apiKeyUsageV3RequestKey(policy, "request-expired"))), false);
  assert.equal(kvStore.has(keyToString(apiKeyUsageV3WindowKey(policy))), false);

  assert.equal(await getApiKeyUsageV3(policy, null), 0);
  assert.equal(await hasLiveApiKeyUsageReservationsV3(kvStub, "absent-key", nowMs), false);
});

test("a quota dispatch error carries its status, code and retry hint", () => {
  const plain = new ApiKeyQuotaDispatchError();
  assert.equal(plain.name, "ApiKeyQuotaDispatchError");
  assert.equal(plain.status, 503);
  assert.equal(plain.code, "api_key_quota_reservation_unavailable");
  assert.equal(plain.errorType, "server_error");

  const described = new ApiKeyQuotaDispatchError("quota unavailable", {
    status: 429,
    code: "api_key_quota_exceeded",
    errorType: "rate_limit_error",
    headers: { "Retry-After": "30" },
  });
  assert.equal(described.status, 429);
  assert.equal(described.retryAfter, "30", "the retry hint is read from the provided headers");
  assert.equal(described.headers["Retry-After"], "30");

  const explicit = new ApiKeyQuotaDispatchError("quota unavailable", { retryAfter: "60" });
  assert.equal(explicit.retryAfter, "60");
  assert.equal(explicit.headers["Retry-After"], "60", "an explicit retry hint is added to the headers");
  assert.equal(new ApiKeyQuotaDispatchError("plain", { retryAfter: null }).retryAfter, null);
});

/* ---------------------------------------------------- chat stream translation */

test("terminal telemetry events and malformed streams are classified", () => {
  const event = (terminal: boolean, type: string, value: Record<string, unknown> = {}) => ({ raw: `event: ${type}`, terminal, type, value });
  const ranWithoutThrowing = (run: () => void): boolean => {
    run();
    return true;
  };
  assert.ok(
    ranWithoutThrowing(() => {
      recordResponsesTerminal(event(false, "response.output_text.delta"));
    }),
    "a non-terminal event is a no-op, not a failure"
  );
  assert.ok(
    ranWithoutThrowing(() => {
      recordResponsesTerminal(event(true, "response.completed", { response: { usage: null } }));
    })
  );
  assert.ok(
    ranWithoutThrowing(() => {
      recordResponsesTerminal(event(true, "response.failed"));
    })
  );

  const malformed = emptyUpstreamCompletionError();
  assert.deepEqual(malformed.error, {
    message: EMPTY_UPSTREAM_COMPLETION_MESSAGE,
    type: "server_error",
    code: "empty_upstream_completion",
    param: null,
  });

  assert.throws(() => malformedFunctionCallStream("upstream drift"), /upstream drift/);
});

test("completed text and refusal reconciliation accepts a prefix and rejects a conflict", () => {
  assert.equal(reconcileCompletedOutputText("hello", "hello world"), " world");
  assert.equal(reconcileCompletedOutputText("hello world", "hello world"), "");
  assert.equal(reconcileCompletedOutputText("hello", "hello"), "");
  assert.equal(reconcileCompletedOutputText("hello", ""), "");
  assert.equal(reconcileCompletedOutputText("hello world", "hello"), "", "an already-emitted completion is not re-emitted");
  assert.throws(() => reconcileCompletedOutputText("hello", "goodbye"), /conflicts with prior text deltas/);

  assert.equal(reconcileCompletedRefusal("no", "no thanks"), " thanks");
  assert.equal(reconcileCompletedRefusal("no thanks", "no thanks"), "");
  assert.equal(reconcileCompletedRefusal("", ""), "");
  assert.equal(reconcileCompletedRefusal("no thanks", "no"), "", "an already-emitted refusal is not re-emitted");
  assert.throws(() => reconcileCompletedRefusal("no", "yes"), /conflicts with prior refusal deltas/);
});

test("a chat content part key prefers the item id, then the output index, then the part index", () => {
  assert.equal(chatOutputTextPartKey({ item_id: "item-1" }), "item:item-1:0");
  assert.equal(chatOutputTextPartKey({ item_id: "item-1", content_index: 2 }), "item:item-1:2");
  assert.equal(chatOutputTextPartKey({ item_id: "   ", output_index: 4 }), "output:4:0", "a blank item id falls back to the output index");
  assert.equal(chatOutputTextPartKey({ output_index: 2, content_index: "1" }), "output:2:1");
  assert.equal(chatOutputTextPartKey({ output_index: "two" }), "output:two:0", "a string index is preserved verbatim");
  assert.equal(chatOutputTextPartKey({ output_index: true }), "output:0:0", "a non-index value falls back to zero");
  assert.equal(chatOutputTextPartKey({ content_index: {} }), "output:0:0");
});

test("completed chat content parts reject unusable shapes and reconcile repeats", () => {
  const textParts = new Map<string, string>();
  const refusalParts = new Map<string, string>();
  const identified = { item_id: "item-1" };

  assert.throws(() => reconcileChatContentPart(textParts, refusalParts, identified, null), /missing its part object/);
  assert.throws(() => reconcileChatContentPart(textParts, refusalParts, identified, ["not", "a", "record"]), /missing its part object/);
  assert.throws(() => reconcileChatContentPart(textParts, refusalParts, identified, { type: "output_text" }), /missing string output text/);
  assert.throws(() => reconcileChatContentPart(textParts, refusalParts, identified, { type: "refusal" }), /missing string refusal text/);

  assert.deepEqual(
    reconcileChatContentPart(textParts, refusalParts, identified, { type: "image" }),
    { outputText: "", refusal: "" },
    "an unrelated part type contributes nothing"
  );

  const first = reconcileChatContentPart(textParts, refusalParts, identified, { type: "output_text", text: "hello" });
  assert.deepEqual(first, { outputText: "hello", refusal: "" });
  const repeat = reconcileChatContentPart(textParts, refusalParts, identified, { type: "output_text", text: "hello there" });
  assert.deepEqual(repeat, { outputText: " there", refusal: "" }, "only the missing suffix is emitted");

  const unidentified = {};
  assert.deepEqual(
    reconcileChatContentPart(textParts, refusalParts, unidentified, { type: "output_text", text: "hello there" }),
    { outputText: "", refusal: "" },
    "an unidentified part that repeats the emitted aggregate contributes nothing"
  );
  const unidentifiedNew = reconcileChatContentPart(new Map(), new Map(), unidentified, { type: "output_text", text: "fresh text" });
  assert.deepEqual(unidentifiedNew, { outputText: "fresh text", refusal: "" });

  const refusal = reconcileChatContentPart(refusalParts, refusalParts, identified, { type: "refusal", refusal: "no" });
  assert.deepEqual(refusal, { outputText: "", refusal: "no" });
});

test("id-less completed chat parts are reconciled by output position", () => {
  const textParts = new Map<string, string>();
  const refusalParts = new Map<string, string>();
  const response = reconcileChatResponseOutputContent(textParts, refusalParts, {}, [
    { content: [{ type: "output_text", text: "ha" }] },
    { content: [{ type: "output_text", text: "ha" }] },
  ]);

  assert.deepEqual(response, { outputText: "haha", refusal: "" });
});

test("completed output items and response outputs accumulate their content", () => {
  const textParts = new Map<string, string>();
  const refusalParts = new Map<string, string>();
  assert.deepEqual(reconcileChatOutputItemContent(textParts, refusalParts, {}, null), { outputText: "", refusal: "" });
  assert.deepEqual(reconcileChatOutputItemContent(textParts, refusalParts, {}, { content: "not an array" }), { outputText: "", refusal: "" });
  const item = reconcileChatOutputItemContent(
    textParts,
    refusalParts,
    { item_id: "item-1" },
    {
      content: [{ type: "output_text", text: "hello" }, { type: "nonsense" }],
    }
  );
  assert.deepEqual(item, { outputText: "hello", refusal: "" });

  assert.deepEqual(reconcileChatResponseOutputContent(textParts, refusalParts, {}, "not an array"), { outputText: "", refusal: "" });
  const response = reconcileChatResponseOutputContent(textParts, refusalParts, {}, [
    { content: [{ type: "output_text", text: "hello" }] },
    { content: [{ type: "refusal", refusal: "no" }] },
  ]);
  assert.deepEqual(response, { outputText: "", refusal: "no" }, "an already-emitted part contributes only its new suffix");
});

test("accumulated text, refusal and items are appended only when the response lacks them", () => {
  const empty: Record<string, unknown> = {};
  assert.equal(withAccumulatedResponseText(empty, ""), empty, "an empty accumulator never changes the response");
  const appended = withAccumulatedResponseText(empty, "hello");
  const output = appended.output as Record<string, unknown>[];
  assert.equal(output.length, 1);
  assert.equal((output[0].content as Record<string, unknown>[])[0].text, "hello");
  const alreadyPresent = { output: [{ content: [{ type: "output_text", text: "existing" }] }] };
  assert.equal(withAccumulatedResponseText(alreadyPresent, "hello"), alreadyPresent, "a response that already carries output text is unchanged");
  const prefixed = { output: [{ content: [{ type: "output_text", text: "kept" }] }, {}] };
  const skippedPrefix = withAccumulatedResponseText(prefixed, "hello", 1);
  assert.ok(Array.isArray(skippedPrefix.output), "an ignored prefix lets the accumulator append after existing items");
  assert.equal((skippedPrefix.output as unknown[]).length, 3, "only the item after the ignored prefix is inspected");

  assert.equal(withAccumulatedResponseRefusal(empty, ""), empty);
  const refused = withAccumulatedResponseRefusal(empty, "no");
  assert.equal(((refused.output as Record<string, unknown>[])[0].content as Record<string, unknown>[])[0].refusal, "no");
  const refusalPresent = { output: [{ content: [{ type: "refusal", refusal: "existing" }] }] };
  assert.equal(withAccumulatedResponseRefusal(refusalPresent, "no"), refusalPresent);

  assert.equal(withAccumulatedResponseItems(empty, []), empty);
  const withItems = withAccumulatedResponseItems(empty, [{ id: "call-1" }]);
  assert.deepEqual(withItems.output, [{ id: "call-1" }]);
});

test("a function-call accumulator creates, streams, finalizes and rejects drift", () => {
  const calls = new ChatFunctionCallAccumulator();
  assert.equal(calls.hasCalls, false);
  assert.equal(calls.add({ item_id: "call-1" }, "not an item"), null);
  assert.equal(calls.add({ item_id: "call-1" }, { type: "message" }), null);
  assert.throws(() => calls.add({ item_id: "call-1" }, { type: "function_call", name: "tool" }), /missing call_id, name, or string arguments/);
  assert.throws(() => calls.add({}, { type: "function_call", call_id: "call-1", name: "tool" }), /omitted item_id and output_index/);

  const created = calls.add({ item_id: "call-1" }, { type: "function_call", call_id: "call-1", name: "tool", arguments: "{" });
  assert.ok(created);
  assert.equal(created.includeIdentity, true);
  assert.equal(created.suffix, "{");
  assert.equal(calls.hasCalls, true);
  assert.equal(calls.calls.length, 1);

  const repeated = calls.add({ item_id: "call-1" }, { type: "function_call", call_id: "call-1", name: "tool", arguments: '{"a":1}' });
  assert.ok(repeated);
  assert.equal(repeated.includeIdentity, false, "a repeated item does not re-emit its identity");
  assert.equal(repeated.suffix, '"a":1}');
  assert.throws(
    () => calls.add({ item_id: "call-1" }, { type: "function_call", call_id: "other", name: "tool", arguments: "" }),
    /changed its call_id or name/
  );

  assert.throws(() => calls.delta({ item_id: "absent" }), /no matching item/);
  assert.throws(() => calls.delta({ item_id: "call-1", delta: 5 }), /not a string/);
  const streamed = calls.delta({ item_id: "call-1", delta: "!" });
  assert.equal(streamed.delta, "!");
  assert.throws(() => calls.done({ item_id: "absent" }), /completion has no matching item/);
  assert.throws(() => calls.done({ item_id: "call-1" }), /missing string arguments/);
  const done = calls.done({ item_id: "call-1", arguments: '{"a":1}!' });
  assert.equal(done.suffix, "", "a completion that repeats the delivered argument stream emits nothing new");
  assert.throws(() => calls.delta({ item_id: "call-1", delta: "x" }), /after its completion event/);
  assert.throws(() => calls.done({ item_id: "call-1", arguments: "different" }), /changed finalized arguments/);
  assert.equal(calls.done({ item_id: "call-1", arguments: '{"a":1}!' }).suffix, "", "a repeated identical completion emits nothing");
  calls.assertFinalized();

  assert.throws(
    () => calls.reconcileItem({ item_id: "call-1" }, { type: "function_call" }),
    /missing string arguments/,
    "a final item must carry concrete arguments"
  );
  assert.equal(calls.reconcileItem({ item_id: "call-1" }, { type: "message" }), null, "a non function-call item is not reconciled");
  assert.equal(calls.reconcileOutput({ item_id: "call-1" }, "not an array").length, 0);
  assert.equal(calls.reconcileOutput({ item_id: "call-1" }, [null, { type: "message" }]).length, 0);

  const fresh = new ChatFunctionCallAccumulator();
  const reconciled = fresh.reconcileItem({ item_id: "call-2" }, { type: "function_call", call_id: "call-2", name: "tool", arguments: "{}" });
  assert.ok(reconciled);
  assert.equal(reconciled.suffix, "{}");
  assert.throws(
    () => fresh.reconcileItem({ item_id: "call-2" }, { type: "function_call", call_id: "call-2", name: "tool", arguments: '{"b":2}' }),
    /changed finalized arguments/
  );

  const unfinished = new ChatFunctionCallAccumulator();
  unfinished.add({ item_id: "call-3" }, { type: "function_call", call_id: "call-3", name: "tool", arguments: "" });
  assert.throws(() => {
    unfinished.assertFinalized();
  }, /ended before finalized arguments/);
});

test("a chat tool-call delta carries its identity and arguments only when asked", () => {
  const call = { key: "item:call-1", index: 1, callId: "call-1", name: "tool", arguments: "{}", argumentsDone: true };
  assert.deepEqual(chatToolCallDelta(call), { index: 1, function: {} });
  assert.deepEqual(chatToolCallDelta(call, { includeIdentity: true }), {
    index: 1,
    function: { name: "tool" },
    id: "call-1",
    type: "function",
  });
  assert.deepEqual(chatToolCallDelta(call, { includeIdentity: false, argumentsDelta: "more" }), { index: 1, function: { arguments: "more" } });
  assert.equal(translatedChatOutputObserved("", "", new ChatFunctionCallAccumulator()), false);
  assert.equal(translatedChatOutputObserved("text", "", new ChatFunctionCallAccumulator()), true);
  assert.equal(translatedChatOutputObserved("", "no", new ChatFunctionCallAccumulator()), true);
  const withCall = new ChatFunctionCallAccumulator();
  withCall.add({ item_id: "call-1" }, { type: "function_call", call_id: "call-1", name: "tool", arguments: "" });
  assert.equal(translatedChatOutputObserved("", "", withCall), true, "an accumulated function call is semantic output");
});
