import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/passkeys-harness.ts";
// Bounds on anonymous passkey login challenge issuance.
//
// These tests pin the acceptance contract for issue #115: a burst of
// unauthenticated login-start requests is bounded by a deterministic,
// clock-aligned window; a rejected request writes nothing; and named attempts
// cannot distinguish an unknown handle from a handle without passkeys.

import assert from "node:assert/strict";
import { handlePasskeyLoginStart, keyToString, kvStore, passkeyHandleKey, passkeyUserKey } from "./helpers/passkeys-harness.ts";
import { PASSKEY_LOGIN_START_LIMIT, PASSKEY_LOGIN_START_WINDOW_MS, passkeyLoginStartThrottleKey } from "../src/auth/passkeys.ts";

const loginStartUrl = "https://ai.ubq.fi/api/auth/login/start";

const loginStartRequest = (body: Record<string, unknown> = {}): Request =>
  new Request(loginStartUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const challengeKeyCount = (): number => [...kvStore.keys()].filter((key) => key.includes('"challenges"')).length;

const windowStartMs = (atMs: number): number => Math.floor(atMs / PASSKEY_LOGIN_START_WINDOW_MS) * PASSKEY_LOGIN_START_WINDOW_MS;

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("passkey login start bounds anonymous challenge creation and writes nothing after the limit", async () => {
  kvStore.clear();

  for (let index = 0; index < PASSKEY_LOGIN_START_LIMIT; index += 1) {
    const response = await handlePasskeyLoginStart(loginStartRequest());
    assert.equal(response.status, 200, `request ${index} is allowed`);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(challengeKeyCount(), PASSKEY_LOGIN_START_LIMIT);

  const limited = await handlePasskeyLoginStart(loginStartRequest());
  assert.equal(limited.status, 429);
  const payload = (await limited.json()) as { error?: { code?: string; type?: string; message?: string } };
  assert.ok(payload.error, "rate-limited login start answers with an error body");
  assert.equal(payload.error.code, "rate_limit_exceeded");
  assert.equal(payload.error.type, "rate_limit_error");
  assert.match(payload.error.message ?? "", /too many/i);
  const retryAfterSeconds = Number(limited.headers.get("Retry-After"));
  assert.equal(Number.isInteger(retryAfterSeconds), true);
  assert.equal(retryAfterSeconds > 0, true);
  assert.equal(retryAfterSeconds <= PASSKEY_LOGIN_START_WINDOW_MS / 1000, true);
  assert.equal(challengeKeyCount(), PASSKEY_LOGIN_START_LIMIT);

  // Every rejected request must leave the KV store untouched, not just skip the
  // challenge write.
  const before = [...kvStore.entries()].map(([key, value]) => [key, JSON.stringify(value)] as const);
  const repeated = await handlePasskeyLoginStart(loginStartRequest());
  assert.equal(repeated.status, 429);
  const after = [...kvStore.entries()].map(([key, value]) => [key, JSON.stringify(value)] as const);
  assert.deepEqual(after, before);
});

test("passkey login start resets deterministically at the next clock-aligned window", async () => {
  kvStore.clear();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    for (let index = 0; index < PASSKEY_LOGIN_START_LIMIT; index += 1) {
      assert.equal((await handlePasskeyLoginStart(loginStartRequest())).status, 200);
    }
    assert.equal((await handlePasskeyLoginStart(loginStartRequest())).status, 429);
    assert.equal(kvStore.has(keyToString(passkeyLoginStartThrottleKey(windowStartMs(clock)))), true);

    // Advancing exactly to the next window boundary admits requests again.
    clock = windowStartMs(clock) + PASSKEY_LOGIN_START_WINDOW_MS;
    const allowed = await handlePasskeyLoginStart(loginStartRequest());
    assert.equal(allowed.status, 200);
    const payload = (await allowed.json()) as { publicKey?: { challenge?: string } };
    assert.equal(typeof payload.publicKey?.challenge, "string");
    assert.equal(challengeKeyCount(), PASSKEY_LOGIN_START_LIMIT + 1);
  } finally {
    Date.now = realNow;
  }
});

test("named passkey login failures are indistinguishable from discoverable login", async () => {
  kvStore.clear();
  const now = Date.now();
  const credentialless = {
    id: "user-credentialless",
    handle: "credentialless",
    is_admin: true,
    credential_ids: [],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kvStore.set(keyToString(passkeyUserKey(credentialless.id)), credentialless);
  kvStore.set(keyToString(passkeyHandleKey(credentialless.handle)), credentialless.id);

  const bodies: Record<string, unknown>[] = [{ handle: "unknown-handle" }, { handle: credentialless.handle }, {}];
  const shapes: Record<string, unknown>[] = [];
  for (const body of bodies) {
    const response = await handlePasskeyLoginStart(loginStartRequest(body));
    assert.equal(response.status, 200, JSON.stringify(body));
    const payload = (await response.json()) as { publicKey?: Record<string, unknown> };
    assert.equal(typeof payload.publicKey?.challenge, "string");
    assert.equal(payload.publicKey?.allowCredentials, undefined);
    assert.equal(payload.publicKey?.userVerification, "required");
    const shape: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload.publicKey ?? {})) {
      if (key !== "challenge") shape[key] = value;
    }
    shapes.push(shape);
  }
  assert.deepEqual(shapes[0], shapes[1]);
  assert.deepEqual(shapes[1], shapes[2]);
});

test("named failures share the anonymous login-start budget", async () => {
  kvStore.clear();
  const now = Date.now();
  const credentialless = {
    id: "user-budget",
    handle: "budget-credentialless",
    is_admin: false,
    credential_ids: [],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kvStore.set(keyToString(passkeyUserKey(credentialless.id)), credentialless);
  kvStore.set(keyToString(passkeyHandleKey(credentialless.handle)), credentialless.id);

  for (let index = 0; index < PASSKEY_LOGIN_START_LIMIT; index += 1) {
    const body = index % 2 === 0 ? { handle: "unknown-budget-handle" } : { handle: credentialless.handle };
    assert.equal((await handlePasskeyLoginStart(loginStartRequest(body))).status, 200);
  }
  const limited = await handlePasskeyLoginStart(loginStartRequest());
  assert.equal(limited.status, 429);
  assert.equal(challengeKeyCount(), PASSKEY_LOGIN_START_LIMIT);
});

test("concurrent passkey login start bursts never exceed the anonymous window budget", async () => {
  kvStore.clear();
  const responses = await Promise.all(Array.from({ length: PASSKEY_LOGIN_START_LIMIT + 5 }, () => handlePasskeyLoginStart(loginStartRequest())));
  const statuses = responses.map((response) => response.status);
  assert.equal(statuses.filter((status) => status === 200).length, PASSKEY_LOGIN_START_LIMIT);
  assert.equal(statuses.filter((status) => status === 429).length, 5);
  assert.equal(challengeKeyCount(), PASSKEY_LOGIN_START_LIMIT);
});
