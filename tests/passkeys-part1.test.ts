import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { KvEntryMaybe } from "#kv";
import { serveHttp } from "#http";
import { once } from "node:events";
import { connect } from "node:net";
import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/passkeys-harness.ts";
// Suite part: tests moved out of the original file.

import assert from "node:assert/strict";
import {
  METERED_QUOTA_FRESH_MS,
  METERED_QUOTA_STATE_KEY,
  PASSKEY_MAX_REQUEST_BODY_BYTES,
  PASSKEY_RELAY_COOKIE_NAME,
  abortError,
  authenticateAdmin,
  authenticateClient,
  buildPasskeyHandle,
  encodeBase64Url,
  getPasskeyRequestMeta,
  getPasskeySessionForRequest,
  handlePasskeyLoginFinish,
  handlePasskeyLoginStart,
  handlePasskeyLogout,
  handlePasskeyRegisterFinish,
  handlePasskeyRegisterStart,
  handlePasskeySession,
  handlePasskeyUsersList,
  handlePasskeyUsersUpdate,
  handleV1Auth,
  hasPasskeyUsers,
  keyToString,
  kvStore,
  kvStub,
  normalizePasskeyHandle,
  passkeyChallengeKey,
  passkeyCredentialKey,
  passkeyHandleKey,
  passkeySessionKey,
  passkeyUserKey,
  requestUrl,
  requireAdminAuth,
  saveVerifiedPasskeyRegistration,
  seedPasskeySession,
  setBeforeAtomicCommit,
  setKvGetDelayMs,
  updatePasskeyCredentialSignCount,
  withEnv,
} from "./helpers/passkeys-harness.ts";

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("inference handler omits synthetic quota headers for passkey sessions", async () => {
  kvStore.clear();
  const { token } = seedPasskeySession();
  const now = Date.now();
  kvStore.set(keyToString(METERED_QUOTA_STATE_KEY), {
    current_balance_quota: 25_000_000,
    post_refill_baseline_quota: 50_000_000,
    last_observed_used_quota: 25_000_000,
    quota_per_credit: 500_000,
    observed_at_ms: now,
    cycle_started_at_ms: now - 60_000,
    confidence: "refill_observed",
    last_known_debits_quota: 1_000_000,
    last_inferred_credit_quota: 0,
    last_credit_at_ms: now - 60_000,
    latest_refill_id: "refill-2",
    latest_refill_amount_credits: 50,
    latest_refill_completed_at_ms: now - 60_000,
  });

  await withEnv({ METERED_API_KEY: "metered-api-key" }, async () => {
    const { default: handler } = await import("../src/handler/index.ts");
    for (const path of ["/v1/responses", "/v1/chat/completions"]) {
      const response = await handler(
        new Request(`https://ai.ubq.fi${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("x-codex-limit-name"), null);
      assert.equal(response.headers.get("x-codex-primary-used-percent"), null);
      assert.equal(response.headers.has("x-codex-primary-window-minutes"), false);
      assert.equal(response.headers.has("x-codex-primary-reset-at"), false);
      const exposedHeaders = response.headers.get("access-control-expose-headers") ?? "";
      assert.match(exposedHeaders, /(?:^|,)x-codex-primary-used-percent(?:,|$)/i);
      assert.doesNotMatch(exposedHeaders, /(?:^|,)x-metered-primary-used-percent(?:,|$)/i);
      assert.doesNotMatch(exposedHeaders, /(?:^|,)x-openai-subscription-primary-used-percent(?:,|$)/i);
    }
  });
});

test("passkey inference does not read a retained Metered snapshot", async () => {
  kvStore.clear();
  const { token } = seedPasskeySession();
  const now = Date.now();
  kvStore.set(keyToString(METERED_QUOTA_STATE_KEY), {
    current_balance_quota: 25_000_000,
    post_refill_baseline_quota: 50_000_000,
    last_observed_used_quota: 25_000_000,
    quota_per_credit: 500_000,
    observed_at_ms: now,
    cycle_started_at_ms: now - 60_000,
    confidence: "refill_observed",
    last_known_debits_quota: 1_000_000,
    last_inferred_credit_quota: 0,
    last_credit_at_ms: now - 60_000,
    latest_refill_id: "refill-2",
    latest_refill_amount_credits: 50,
    latest_refill_completed_at_ms: now - 60_000,
  });

  await withEnv({ METERED_API_KEY: "metered-api-key" }, async () => {
    const { default: handler } = await import("../src/handler/index.ts");
    setKvGetDelayMs(10);
    const response = await handler(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-codex-primary-used-percent"), null);
  });
});

test("passkey inference never waits for a Metered quota refresh", async () => {
  kvStore.clear();
  const { token } = seedPasskeySession();
  const now = Date.now();
  kvStore.set(keyToString(METERED_QUOTA_STATE_KEY), {
    current_balance_quota: 25_000_000,
    post_refill_baseline_quota: 50_000_000,
    last_observed_used_quota: 25_000_000,
    quota_per_credit: 500_000,
    observed_at_ms: now - METERED_QUOTA_FRESH_MS,
    cycle_started_at_ms: now - 60_000,
    confidence: "refill_observed",
    last_known_debits_quota: 1_000_000,
    last_inferred_credit_quota: 0,
    last_credit_at_ms: now - 60_000,
    latest_refill_id: "refill-2",
    latest_refill_amount_credits: 50,
    latest_refill_completed_at_ms: now - 60_000,
  });

  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = createFetchMock(
    (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(abortError(init.signal?.reason));
          },
          { once: true }
        );
      })
  );
  try {
    await withEnv({ METERED_API_KEY: "metered-api-key" }, async () => {
      const { default: handler } = await import("../src/handler/index.ts");
      let cancelTimeout = (): void => {};
      try {
        const response = await Promise.race([
          handler(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: "{}",
              signal: controller.signal,
            })
          ),
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error("handler waited for Metered quota refresh"));
            }, 500);
            cancelTimeout = () => {
              clearTimeout(timer);
            };
          }),
        ]);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("x-codex-primary-used-percent"), null);
      } finally {
        cancelTimeout();
      }
    });
  } finally {
    controller.abort();
    globalThis.fetch = originalFetch;
    await Promise.resolve();
  }
});

test("passkey session authenticates as client and admin", async () => {
  kvStore.clear();
  const { token, user } = seedPasskeySession();
  const req = new Request("https://ai.ubq.fi/uos/auth", {
    headers: { Authorization: `Bearer ${token}` },
  });

  const clientAuth = await authenticateClient(req);
  assert.equal(clientAuth.ok, true);
  {
    assert.equal(clientAuth.method.kind, "passkey_session");
    assert.equal(clientAuth.method.handle, user.handle);
    assert.equal(clientAuth.method.credential_count, 1);
  }

  const adminError = await requireAdminAuth(req);
  assert.equal(adminError, null);

  const whoami = await handleV1Auth(req);
  assert.equal(whoami.status, 200);
  const body = await whoami.json();
  assert.equal(body.auth.is_admin, true);
  assert.equal(body.auth.is_super_admin, false);
  assert.equal(body.auth.method.kind, "passkey_session");
  assert.equal(body.auth.method.user.handle, user.handle);
  assert.equal(body.auth.method.user.is_admin, true);
  assert.equal(body.auth.method.user.credential_count, 1);

  const sessionResponse = await handlePasskeySession(req);
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json();
  assert.equal(sessionBody.user.handle, user.handle);
  assert.equal(sessionBody.user.credential_count, 1);
});

test("an admin passkey session reaches the former super-admin Stage 0 diagnostic", async () => {
  kvStore.clear();
  const { token } = seedPasskeySession();
  const { default: handler } = await import("../src/handler/index.ts");
  const response = await handler(
    new Request("https://ai.ubq.fi/admin/providers/codex/cache-scope-experiment", {
      headers: { Authorization: `Bearer ${token}` },
    })
  );

  // The super-admin gate is gone: the request reaches the diagnostic handler
  // (200 when the baseline reads, 503 when the harness KV cannot serve it),
  // and it is never refused as forbidden or unauthorized.
  assert.notEqual(response.status, 401);
  assert.notEqual(response.status, 403);
  assert.ok([200, 503].includes(response.status), `unexpected status ${response.status}`);
  const body = (await response.json()) as { error?: { code?: unknown } };
  assert.notEqual(body.error?.code, "forbidden");
});

test("non-admin passkey session authenticates as client but not admin", async () => {
  kvStore.clear();
  const { token, user } = seedPasskeySession("uos_ai_session_user", { isAdmin: false });
  const req = new Request("https://ai.ubq.fi/uos/auth", {
    headers: { Authorization: `Bearer ${token}` },
  });

  const clientAuth = await authenticateClient(req);
  assert.equal(clientAuth.ok, true);
  {
    assert.equal(clientAuth.method.kind, "passkey_session");
    assert.equal(clientAuth.method.handle, user.handle);
    assert.equal(clientAuth.method.is_admin, false);
    assert.equal(clientAuth.method.credential_count, 1);
  }

  const adminError = await requireAdminAuth(req);
  assert.equal(adminError?.status, 403);

  const whoami = await handleV1Auth(req);
  assert.equal(whoami.status, 200);
  const body = await whoami.json();
  assert.equal(body.auth.is_admin, false);
  assert.equal(body.auth.is_super_admin, false);
  assert.equal(body.auth.method.user.is_admin, false);
  assert.equal(body.auth.method.user.credential_count, 1);
});

test("Deno Deploy tokens are verified with the Deno API outside deployed runtime", async () => {
  kvStore.clear();
  const originalFetch = globalThis.fetch;
  const requested: { url: string; authorization: string | null }[] = [];
  const token = "ddo_test_fixture_value";

  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    requested.push({
      url: requestUrl(input),
      authorization: headers.get("authorization"),
    });
    return Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  try {
    await withEnv({ DENO_DEPLOY_APP_SLUG: "ai-ubq-fi-test" }, async () => {
      const req = new Request("https://ai.ubq.fi/uos/auth", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const adminAuth = await authenticateAdmin(req);
      assert.equal(adminAuth.ok, true);
      {
        assert.equal(adminAuth.is_super_admin, true);
        assert.equal(adminAuth.method.kind, "deno_deploy_token");
      }

      const clientAuth = await authenticateClient(req);
      assert.equal(clientAuth.ok, true);
      {
        assert.equal(clientAuth.method.kind, "deno_deploy_token");
      }

      const whoami = await handleV1Auth(req);
      assert.equal(whoami.status, 200);
      const body = await whoami.json();
      assert.equal(body.auth.is_admin, true);
      assert.equal(body.auth.is_super_admin, true);

      assert.equal(requested.length, 1);
      assert.equal(requested[0].url, "https://api.deno.com/v2/apps/ai-ubq-fi-test");
      assert.equal(requested[0].authorization, `Bearer ${token}`);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Deno Deploy console tokens are verified against the app page", async () => {
  kvStore.clear();
  const originalFetch = globalThis.fetch;
  const requested: { url: string; authorization: string | null; cookie: string | null }[] = [];
  const token = "ddo_console_fixture_value";

  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const url = requestUrl(input);
    requested.push({
      url,
      authorization: headers.get("authorization"),
      cookie: headers.get("cookie"),
    });
    if (url.includes("https://api.deno.com/v2/apps/")) {
      return Promise.resolve(new Response("{}", { status: 401 }));
    }
    return Promise.resolve(
      new Response("<title>Overview | ai-ubq-fi | Deploy</title>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    );
  });

  try {
    await withEnv(
      {
        DENO_DEPLOY_APP_SLUG: "ai-ubq-fi",
        DENO_DEPLOY_ORG_SLUG: "ubiquity-dao",
      },
      async () => {
        const req = new Request("https://ai.ubq.fi/uos/auth", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const adminAuth = await authenticateAdmin(req);
        assert.equal(adminAuth.ok, true);
        {
          assert.equal(adminAuth.method.kind, "deno_deploy_token");
        }

        assert.equal(requested.length, 2);
        assert.equal(requested[0].authorization, `Bearer ${token}`);
        assert.equal(requested[1].url, "https://console.deno.com/ubiquity-dao/ai-ubq-fi");
        assert.equal(requested[1].cookie, `token=${token}; deno_auth_ghid=force`);
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Deno Deploy console fallback rejects path-only HTML", async () => {
  kvStore.clear();
  const originalFetch = globalThis.fetch;
  const token = "ddo_console_path_token_1234567890abcdefghijklmnopqrstuvwxyz";

  globalThis.fetch = createFetchMock((input: RequestInfo | URL): Promise<Response> => {
    const url = requestUrl(input);
    if (url.includes("https://api.deno.com/v2/apps/")) {
      return Promise.resolve(new Response("{}", { status: 401 }));
    }
    return Promise.resolve(
      new Response("Sign in to view /ubiquity-dao/ai-ubq-fi", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    );
  });

  try {
    await withEnv(
      {
        DENO_DEPLOY_APP_SLUG: "ai-ubq-fi",
        DENO_DEPLOY_ORG_SLUG: "ubiquity-dao",
        DENO_DEPLOYMENT_ID: null,
      },
      async () => {
        const req = new Request("https://ai.ubq.fi/uos/auth", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const adminAuth = await authenticateAdmin(req);
        assert.equal(adminAuth.ok, false);
        {
          assert.equal(adminAuth.response.status, 401);
        }
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Deno Deploy tokens do not fall back to the production app slug", async () => {
  kvStore.clear();
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  const token = "ddo_deployment_token_1234567890abcdefghijklmnopqrstuvwxyz";

  globalThis.fetch = createFetchMock((input: RequestInfo | URL): Promise<Response> => {
    const url = requestUrl(input);
    requested.push(url);
    return Promise.resolve(new Response("{}", { status: url.includes("/v1/deployments/dep_test") ? 200 : 401 }));
  });

  try {
    await withEnv(
      {
        DENO_DEPLOY_APP_SLUG: null,
        DENO_DEPLOY_ORG_SLUG: null,
        DENO_DEPLOYMENT_ID: "dep_test",
      },
      async () => {
        const req = new Request("https://ai.ubq.fi/uos/auth", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const adminAuth = await authenticateAdmin(req);
        assert.equal(adminAuth.ok, true);
        {
          assert.equal(adminAuth.method.kind, "deno_deploy_token");
        }

        assert.deepEqual(requested, ["https://api.deno.com/v1/deployments/dep_test"]);
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("passkey handles are deterministic and normalized", async () => {
  assert.equal(await buildPasskeyHandle("admin-token"), await buildPasskeyHandle("admin-token"));
  assert.match(await buildPasskeyHandle("admin-token"), /^uos-passkey-[0-9a-f]{16}$/);
  assert.equal(normalizePasskeyHandle(" Admin Passkey: Laptop! "), "admin-passkey-laptop");
});

test("passkey user presence is detected from KV", async () => {
  kvStore.clear();
  assert.equal(await hasPasskeyUsers(), false);

  const now = Date.now();
  kvStore.set(keyToString(passkeyUserKey("user-existing")), {
    id: "user-existing",
    handle: "uos-passkey-existing",
    is_admin: false,
    credential_ids: [],
    created_at_ms: now,
    updated_at_ms: now,
  });

  assert.equal(await hasPasskeyUsers(), true);
});

test("passkey RP ID follows browser origin behind Deno Deploy custom domain", () => {
  const req = new Request("https://ai-ubq-fi.ubiquity-dao.deno.net/api/auth/register/start", {
    method: "POST",
    headers: {
      Origin: "https://ai.ubq.fi",
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  assert.deepEqual(getPasskeyRequestMeta(req), {
    origin: "https://ai.ubq.fi",
    rpId: "ai.ubq.fi",
  });
});

test("passkey RP ID uses client window location when headers are unavailable", () => {
  const req = new Request("https://ai-ubq-fi.ubiquity-dao.deno.net/api/auth/register/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  assert.deepEqual(getPasskeyRequestMeta(req, "https://ai.ubq.fi"), {
    origin: "https://ai.ubq.fi",
    rpId: "ai.ubq.fi",
  });
});

test("passkey RP ID allows localhost client origin for remote target", () => {
  const req = new Request("https://ai.ubq.fi/api/auth/register/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  assert.deepEqual(getPasskeyRequestMeta(req, "http://localhost:8000"), {
    origin: "http://localhost:8000",
    rpId: "localhost",
  });
});

test("passkey RP ID ignores untrusted client origin", () => {
  const req = new Request("https://ai.ubq.fi/api/auth/register/start", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  assert.deepEqual(getPasskeyRequestMeta(req, "https://evil.example"), {
    origin: "https://ai.ubq.fi",
    rpId: "ai.ubq.fi",
  });
});

test("passkey RP ID ignores opaque origins", () => {
  const req = new Request("https://ai.ubq.fi/api/auth/register/start", {
    method: "POST",
    headers: {
      Origin: "foo://bar",
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  assert.deepEqual(getPasskeyRequestMeta(req), {
    origin: "https://ai.ubq.fi",
    rpId: "ai.ubq.fi",
  });
});

test("passkey registration start requires admin proof", async () => {
  kvStore.clear();
  const { default: handler } = await import("../src/handler/index.ts");

  const response = await handler(
    new Request("https://ai.ubq.fi/api/auth/register/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  );

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_api_key");
});

test("passkey registration start can use an existing passkey session", async () => {
  kvStore.clear();
  const { token, user } = seedPasskeySession();
  const { default: handler } = await import("../src/handler/index.ts");

  const response = await handler(
    new Request("https://ai.ubq.fi/api/auth/register/start", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    })
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  const encodedUserId = encodeBase64Url(user.id);
  assert.equal(body.handle, user.handle);
  assert.equal(body.publicKey.user.id, encodedUserId);
  assert.equal(body.publicKey.user.name, user.handle);
  assert.equal(body.publicKey.authenticatorSelection.userVerification, "required");
});

test("passkey JSON handlers reject oversized streamed bodies with 413", async () => {
  const handlers = [
    ["register start", "https://ai.ubq.fi/api/auth/register/start", handlePasskeyRegisterStart],
    ["register finish", "https://ai.ubq.fi/api/auth/register/finish", handlePasskeyRegisterFinish],
    ["login start", "https://ai.ubq.fi/api/auth/login/start", handlePasskeyLoginStart],
    ["login finish", "https://ai.ubq.fi/api/auth/login/finish", handlePasskeyLoginFinish],
  ] as const;

  for (const [name, url, passkeyHandler] of handlers) {
    let cancelled = false;
    const request = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(Math.floor(PASSKEY_MAX_REQUEST_BODY_BYTES / 2) + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    });

    const response = await passkeyHandler(request);
    assert.equal(response.status, 413, name);
    const payload = (await response.json()) as { error?: { code?: string } };
    assert.equal(payload.error?.code, "invalid_request_error", name);
    assert.equal(cancelled, true, name);
  }
});

test("passkey JSON handlers reject an oversized declared body before parsing", async () => {
  let cancelled = false;
  const response = await handlePasskeyLoginStart(
    new Request("https://ai.ubq.fi/api/auth/login/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(PASSKEY_MAX_REQUEST_BODY_BYTES + 1),
      },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("{}"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    })
  );

  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
});

test("passkey registration start rejects session claims for another user handle", async () => {
  kvStore.clear();
  const { token } = seedPasskeySession();
  const now = Date.now();
  const otherUser = {
    id: "user-other",
    handle: "other-admin",
    is_admin: true,
    credential_ids: ["credential-other"],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kvStore.set(keyToString(passkeyUserKey(otherUser.id)), otherUser);
  kvStore.set(keyToString(passkeyHandleKey(otherUser.handle)), otherUser.id);
  const { default: handler } = await import("../src/handler/index.ts");

  const response = await handler(
    new Request("https://ai.ubq.fi/api/auth/register/start", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ handle: otherUser.handle }),
    })
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error.message, /already exists/);
});

test("passkey registration start rejects token bootstrap claims for another user handle", async () => {
  kvStore.clear();
  const token = "ddo_bootstrap_fixture_value";
  const now = Date.now();
  const otherUser = {
    id: "user-claimed",
    handle: "claimed-admin",
    is_admin: true,
    credential_ids: ["credential-claimed"],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kvStore.set(keyToString(passkeyUserKey(otherUser.id)), otherUser);
  kvStore.set(keyToString(passkeyHandleKey(otherUser.handle)), otherUser.id);

  const response = await handlePasskeyRegisterStart(
    new Request("https://ai.ubq.fi/api/auth/register/start", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ handle: otherUser.handle }),
    }),
    { defaultIsAdmin: true }
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error.message, /already exists/);
});

test("passkey registration start reuses an existing token-handle user", async () => {
  kvStore.clear();
  const token = "ddo_register_fixture_value";
  const handle = await buildPasskeyHandle(token);
  const now = Date.now();
  const user = {
    id: "user-token-handle",
    handle,
    is_admin: true,
    credential_ids: ["credential-token"],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kvStore.set(keyToString(passkeyUserKey(user.id)), user);
  kvStore.set(keyToString(passkeyHandleKey(handle)), user.id);

  const response = await handlePasskeyRegisterStart(
    new Request("https://ai.ubq.fi/api/auth/register/start", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    { defaultIsAdmin: true }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  const encodedUserId = encodeBase64Url(user.id);
  assert.equal(body.handle, handle);
  assert.equal(body.publicKey.user.id, encodedUserId);
  assert.equal(body.publicKey.authenticatorSelection.userVerification, "required");
  assert.deepEqual(body.publicKey.excludeCredentials, [{ id: "credential-token", type: "public-key" }]);
});

test("passkey login start requires user verification for admin handles", async () => {
  kvStore.clear();
  const now = Date.now();
  const adminUser = {
    id: "user-admin-login",
    handle: "admin-login",
    is_admin: true,
    credential_ids: ["credential-admin-login"],
    created_at_ms: now,
    updated_at_ms: now,
  };
  const memberUser = {
    id: "user-member-login",
    handle: "member-login",
    is_admin: false,
    credential_ids: ["credential-member-login"],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kvStore.set(keyToString(passkeyUserKey(adminUser.id)), adminUser);
  kvStore.set(keyToString(passkeyHandleKey(adminUser.handle)), adminUser.id);
  kvStore.set(keyToString(passkeyUserKey(memberUser.id)), memberUser);
  kvStore.set(keyToString(passkeyHandleKey(memberUser.handle)), memberUser.id);

  const adminResponse = await handlePasskeyLoginStart(
    new Request("https://ai.ubq.fi/api/auth/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: adminUser.handle }),
    })
  );
  const memberResponse = await handlePasskeyLoginStart(
    new Request("https://ai.ubq.fi/api/auth/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: memberUser.handle }),
    })
  );

  assert.equal(adminResponse.status, 200);
  assert.equal(memberResponse.status, 200);
  assert.equal((await adminResponse.json()).publicKey.userVerification, "required");
  assert.equal((await memberResponse.json()).publicKey.userVerification, "preferred");
});

test("passkey login start without username requires verification and remains discoverable", async () => {
  kvStore.clear();

  const response = await handlePasskeyLoginStart(
    new Request("https://ai.ubq.fi/api/auth/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.publicKey.allowCredentials, undefined);
  assert.equal(body.publicKey.userVerification, "required");
});

test("passkey login start accepts an explicit zero-byte body only on the allow-empty route", async () => {
  kvStore.clear();
  const emptyBody = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

  const loginStart = await handlePasskeyLoginStart(
    new Request("https://ai.ubq.fi/api/auth/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: emptyBody(),
    })
  );
  assert.equal(loginStart.status, 200);
  const loginBody = await loginStart.json();
  assert.equal(loginBody.publicKey.allowCredentials, undefined);
  assert.equal(loginBody.publicKey.userVerification, "required");

  for (const [name, url, handler] of [
    ["register start", "https://ai.ubq.fi/api/auth/register/start", handlePasskeyRegisterStart],
    ["register finish", "https://ai.ubq.fi/api/auth/register/finish", handlePasskeyRegisterFinish],
    ["login finish", "https://ai.ubq.fi/api/auth/login/finish", handlePasskeyLoginFinish],
  ] as const) {
    const response = await handler(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: emptyBody(),
      })
    );
    assert.equal(response.status, 400, name);
    const payload = (await response.json()) as { error?: { message?: unknown } };
    assert.equal(payload.error?.message, "Invalid JSON body", name);
  }
});

test("passkey login challenges bind only to exact trusted relay audiences", async () => {
  kvStore.clear();
  for (const audienceOrigin of [
    "https://p-ai-ubq-fi-cv5fc93pzb5a.ubiquity-dao.deno.net",
    "https://telegram-daily-exporter-4d2p9cx7m1ab.0x4007.deno.net",
    "https://agent-worker.ubiquity-os.deno.net",
  ]) {
    const response = await handlePasskeyLoginStart(
      new Request("https://ai.ubq.fi/api/auth/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relay_origin: audienceOrigin }),
      })
    );
    assert.equal(response.status, 200, audienceOrigin);
    const body = (await response.json()) as { publicKey: { challenge: string } };
    const challenge = await kvStub.get(passkeyChallengeKey(body.publicKey.challenge));
    assert.equal((challenge.value as { audience_origin?: string } | null)?.audience_origin, audienceOrigin);
  }

  for (const relayOrigin of ["http://localhost:8000", "https://evil.example", "https://app.0x4007.deno.net"]) {
    const response = await handlePasskeyLoginStart(
      new Request("https://ai.ubq.fi/api/auth/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relay_origin: relayOrigin }),
      })
    );
    assert.equal(response.status, 400, relayOrigin);
    assert.equal(((await response.json()) as { error?: { message?: string } }).error?.message, "Invalid passkey relay origin");
  }
});

test("audience-bound relay cookies authenticate auth checks and admin actions", async () => {
  kvStore.clear();
  const audienceOrigin = "https://agent-worker-4d2p9cx7m1ab.ubiquity-os.deno.net";
  const { token } = seedPasskeySession("uos_ai_session_relay_cookie", { audienceOrigin });
  const cookie = `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(token)}`;

  const clientAuth = await authenticateClient(new Request("https://ai.ubq.fi/v1/models", { headers: { Cookie: cookie, Origin: audienceOrigin } }));
  assert.equal(clientAuth.ok, true);
  {
    assert.equal(clientAuth.token, token);
    assert.equal(clientAuth.method.kind, "passkey_session");
  }

  const adminAuth = await authenticateAdmin(new Request("https://ai.ubq.fi/uos/auth", { headers: { Cookie: cookie, Origin: audienceOrigin } }));
  assert.equal(adminAuth.ok, true);
  {
    assert.equal(adminAuth.token, token);
  }

  const { default: handler } = await import("../src/handler/index.ts");
  const encodedAudience = encodeURIComponent(audienceOrigin);
  const authCheck = await handler(new Request(`https://ai.ubq.fi/uos/auth?cors_origin=${encodedAudience}`, { headers: { Cookie: cookie } }));
  assert.equal(authCheck.status, 200);
  assert.equal(authCheck.headers.get("access-control-allow-origin"), audienceOrigin);
  assert.equal(authCheck.headers.get("access-control-allow-credentials"), "true");

  const adminAction = await handler(
    new Request(`https://ai.ubq.fi/admin/api-keys?include_usage=1&cors_origin=${encodedAudience}`, {
      headers: { Cookie: cookie },
    })
  );
  assert.equal(adminAction.status, 200);

  const conflictingOrigin = await handler(
    new Request(`https://ai.ubq.fi/uos/auth?cors_origin=${encodedAudience}`, {
      headers: { Cookie: cookie, Origin: "https://evil.example" },
    })
  );
  assert.equal(conflictingOrigin.status, 401);

  const missingAudience = await getPasskeySessionForRequest(new Request("https://ai.ubq.fi/uos/auth", { headers: { Cookie: cookie } }));
  assert.equal(missingAudience, null);
});

test("relay logout clears the audience cookie and bound server session", async () => {
  kvStore.clear();
  const audienceOrigin = "https://telegram-daily-exporter.0x4007.deno.net";
  const { token } = seedPasskeySession("uos_ai_session_relay_logout", { audienceOrigin });
  const response = await handlePasskeyLogout(
    new Request("https://ai.ubq.fi/api/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(token)}`,
        Origin: audienceOrigin,
      },
    })
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("set-cookie"), `${PASSKEY_RELAY_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`);
  assert.equal((await kvStub.get(passkeySessionKey(token))).value, null);
});

test("credentialed CORS reflects only exact trusted relay origins", async () => {
  const { default: handler } = await import("../src/handler/index.ts");
  for (const audienceOrigin of [
    "https://ai-ubq-fi-cv5fc93pzb5a.deno.dev",
    "https://p-ai-ubq-fi.ubiquity-dao.deno.net",
    "https://telegram-daily-exporter-4d2p9cx7m1ab.0x4007.deno.net",
    "https://agent-worker.ubiquity-os.deno.net",
  ]) {
    const response = await handler(
      new Request("https://ai.ubq.fi/api/auth/session", {
        method: "OPTIONS",
        headers: { Origin: audienceOrigin, "Access-Control-Request-Method": "GET" },
      })
    );
    assert.equal(response.status, 204, audienceOrigin);
    assert.equal(response.headers.get("access-control-allow-origin"), audienceOrigin);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.equal(response.headers.get("vary"), "Origin");
  }

  const fallbackOrigin = "https://agent-worker-4d2p9cx7m1ab.ubiquity-os.deno.net";
  const cloudflareFallback = await handler(
    new Request(`https://ai.ubq.fi/api/auth/session?cors_origin=${encodeURIComponent(fallbackOrigin)}`, {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Method": "GET" },
    })
  );
  assert.equal(cloudflareFallback.headers.get("access-control-allow-origin"), fallbackOrigin);
  assert.equal(cloudflareFallback.headers.get("access-control-allow-credentials"), "true");

  for (const origin of ["http://localhost:8000", "https://evil.example", "https://app.0x4007.deno.net"]) {
    const response = await handler(
      new Request("https://ai.ubq.fi/api/auth/session", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
      })
    );
    assert.equal(response.headers.get("access-control-allow-origin"), "*", origin);
    assert.equal(response.headers.get("access-control-allow-credentials"), null, origin);
  }

  const conflictingOrigin = await handler(
    new Request(`https://ai.ubq.fi/api/auth/session?cors_origin=${encodeURIComponent(fallbackOrigin)}`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" },
    })
  );
  assert.equal(conflictingOrigin.headers.get("access-control-allow-origin"), "*");
  assert.equal(conflictingOrigin.headers.get("access-control-allow-credentials"), null);
});

test("passkey login finish does not log raw user handles on assertion failure", async () => {
  kvStore.clear();
  const now = Date.now();
  const challenge = "auth-log-challenge";
  const user = {
    id: "user-log",
    handle: "sensitive-admin-handle",
    is_admin: true,
    credential_ids: ["credential-log"],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kvStore.set(keyToString(passkeyUserKey(user.id)), user);
  kvStore.set(keyToString(passkeyCredentialKey("credential-log")), {
    credential_id: "credential-log",
    user_id: user.id,
    public_key: encodeBase64Url("not a valid public key"),
    sign_count: 0,
    transports: [],
    created_at_ms: now,
  });
  kvStore.set(keyToString(passkeyChallengeKey(challenge)), {
    challenge,
    type: "authentication",
    origin: "https://ai.ubq.fi",
    rp_id: "ai.ubq.fi",
    created_at_ms: now,
    expires_at_ms: now + 300_000,
  });

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const response = await handlePasskeyLoginFinish(
      new Request("https://ai.ubq.fi/api/auth/login/finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: {
            id: "credential-log",
            rawId: "credential-log",
            type: "public-key",
            response: {
              clientDataJSON: encodeBase64Url(
                JSON.stringify({
                  type: "webauthn.get",
                  challenge,
                  origin: "https://ai.ubq.fi",
                })
              ),
              authenticatorData: encodeBase64Url("invalid authenticator data"),
              signature: encodeBase64Url("invalid signature"),
              userHandle: encodeBase64Url(user.id),
            },
          },
        }),
      })
    );

    assert.equal(response.status, 400);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  const details = warnings[0][1] as Record<string, unknown>;
  assert.equal(details.has_user_handle, true);
  assert.equal(Object.prototype.hasOwnProperty.call(details, "user_handle"), false);
});

test("passkey registration deletes stale handle mapping when a user handle changes", async () => {
  kvStore.clear();
  const now = Date.now();
  const user = {
    id: "user-rename",
    handle: "old-name",
    is_admin: true,
    credential_ids: ["credential-old"],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kvStore.set(keyToString(passkeyUserKey(user.id)), user);
  kvStore.set(keyToString(passkeyHandleKey(user.handle)), user.id);

  const saved = await saveVerifiedPasskeyRegistration(kvStub, {
    userId: user.id,
    handle: "new-name",
    isAdmin: false,
    credentialId: "credential-new",
    publicKey: "public-key",
    signCount: 0,
    transports: [],
  });

  assert.equal(saved.ok, true);

  assert.equal(saved.user.handle, "new-name");
  assert.equal(kvStore.has(keyToString(passkeyHandleKey("old-name"))), false);
  assert.equal(kvStore.get(keyToString(passkeyHandleKey("new-name"))), user.id);
  assert.deepEqual((kvStore.get(keyToString(passkeyUserKey(user.id))) as { credential_ids: string[] }).credential_ids, ["credential-old", "credential-new"]);
  assert.equal((kvStore.get(keyToString(passkeyCredentialKey("credential-new"))) as { user_id: string }).user_id, user.id);
});

test("passkey registration rejects concurrent handle claims", async () => {
  kvStore.clear();
  setBeforeAtomicCommit(() => {
    kvStore.set(keyToString(passkeyHandleKey("race-name")), "user-other");
  });

  const saved = await saveVerifiedPasskeyRegistration(kvStub, {
    userId: "user-race",
    handle: "race-name",
    isAdmin: true,
    credentialId: "credential-race",
    publicKey: "public-key",
    signCount: 0,
    transports: [],
  });

  assert.equal(saved.ok, false);

  assert.equal(saved.response.status, 409);
  assert.equal(kvStore.has(keyToString(passkeyUserKey("user-race"))), false);
  assert.equal(kvStore.get(keyToString(passkeyHandleKey("race-name"))), "user-other");
});

test("passkey credential sign count update rejects concurrent writes", async () => {
  kvStore.clear();
  const credentialKey = passkeyCredentialKey("credential-counter");
  kvStore.set(keyToString(credentialKey), {
    credential_id: "credential-counter",
    user_id: "user-counter",
    public_key: "public-key",
    sign_count: 4,
    transports: [],
    created_at_ms: Date.now(),
  });
  const entry = (await kvStub.get(credentialKey)) as KvEntryMaybe<{
    credential_id: string;
    user_id: string;
    public_key: string;
    sign_count: number;
    transports: string[];
    created_at_ms: number;
  }>;
  if (!entry.value || !entry.versionstamp) throw new Error("missing seeded credential");
  setBeforeAtomicCommit(() => {
    kvStore.set(keyToString(credentialKey), { ...entry.value, sign_count: 6 });
  });

  const updated = await updatePasskeyCredentialSignCount(
    kvStub,
    {
      key: entry.key,
      value: entry.value,
      versionstamp: entry.versionstamp,
    },
    5
  );

  assert.equal(updated, false);
  assert.equal((kvStore.get(keyToString(credentialKey)) as { sign_count: number }).sign_count, 6);
});

test("passkey logout deletes the cached session", async () => {
  kvStore.clear();
  const { token } = seedPasskeySession("uos_ai_session_logout");
  const { default: handler } = await import("../src/handler/index.ts");

  const response = await handler(
    new Request("https://ai.ubq.fi/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
  );

  assert.equal(response.status, 204);
  assert.equal(kvStore.has(keyToString(passkeySessionKey(token))), false);

  const req = new Request("https://ai.ubq.fi/uos/auth", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const clientAuth = await authenticateClient(req);
  assert.equal(clientAuth.ok, false);
});

test("passkey user handlers list and toggle admin", async () => {
  kvStore.clear();
  const { user } = seedPasskeySession("uos_ai_session_role", { isAdmin: false });

  const listBefore = await handlePasskeyUsersList();
  assert.equal(listBefore.status, 200);
  const beforeBody = await listBefore.json();
  assert.equal(beforeBody.data[0].id, user.id);
  assert.equal(beforeBody.data[0].is_admin, false);

  const update = await handlePasskeyUsersUpdate(
    new Request("https://ai.ubq.fi/admin/passkey-users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: user.id, is_admin: true }),
    })
  );
  assert.equal(update.status, 200);
  const updateBody = await update.json();
  assert.equal(updateBody.user.is_admin, true);

  const listAfter = await handlePasskeyUsersList();
  const afterBody = await listAfter.json();
  assert.equal(afterBody.data[0].is_admin, true);
});
test("unattested GitHub tokens never reach Deno verification", async () => {
  kvStore.clear();
  const originalFetch = globalThis.fetch;
  const requested: { url: string; authorization: string | null; cookie: string | null }[] = [];
  const token = "ghp_unattested_github_token_1234567890abcdefghijklmnopqrstuvwxyz";

  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    requested.push({
      url: requestUrl(input),
      authorization: headers.get("authorization"),
      cookie: headers.get("cookie"),
    });
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    await withEnv(
      {
        DENO_DEPLOY_APP_SLUG: "ai-ubq-fi",
        DENO_DEPLOY_ORG_SLUG: "ubiquity-dao",
        DENO_DEPLOYMENT_ID: "deployment-test",
      },
      async () => {
        const req = new Request("https://ai.ubq.fi/uos/auth", {
          headers: { Authorization: `Bearer ${token}` },
        });

        const clientAuth = await authenticateClient(req);
        assert.equal(clientAuth.ok, false);
        {
          assert.equal(clientAuth.response.status, 401);
        }

        const adminAuth = await authenticateAdmin(req);
        assert.equal(adminAuth.ok, false);
        {
          assert.equal(adminAuth.response.status, 401);
        }
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requested.length, 0);
  assert.equal(
    requested.some(({ authorization }) => authorization === `Bearer ${token}`),
    false
  );
  assert.equal(
    requested.some(({ cookie }) => cookie?.includes(`token=${token}`) ?? false),
    false
  );
});

test("relay passkey cookies survive an unattested GitHub bearer on /uos/auth", async () => {
  kvStore.clear();
  const audienceOrigin = "https://agent-worker-4d2p9cx7m1ab.ubiquity-os.deno.net";
  const { token: passkeyToken, user } = seedPasskeySession("uos_ai_session_cookie_precedence", { audienceOrigin });
  const githubToken = "ghp_unattested_browser_token_1234567890abcdefghijklmnopqrstuvwxyz";
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = createFetchMock((input: RequestInfo | URL): Promise<Response> => {
    requests.push(requestUrl(input));
    return Promise.resolve(new Response("{}", { status: 401 }));
  });

  try {
    const request = (withStaleRepoHeaders = false) =>
      new Request("https://ai.ubq.fi/uos/auth", {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(passkeyToken)}`,
          Origin: audienceOrigin,
          ...(withStaleRepoHeaders ? { "X-GitHub-Owner": "ubiquity", "X-GitHub-Repo": "ai.ubq.fi" } : {}),
        },
      });

    const adminResult = await authenticateAdmin(request());
    assert.equal(adminResult.ok, true);
    {
      assert.equal(adminResult.method.kind, "passkey_session");
      assert.equal(adminResult.is_super_admin, false);
      assert.equal(adminResult.token, passkeyToken);
    }

    const { default: handler } = await import("../src/handler/index.ts");
    const response = await handler(request());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.auth.method.kind, "passkey_session");
    assert.equal(body.auth.method.user.handle, user.handle);
    assert.equal(body.auth.is_admin, true);
    assert.equal(body.auth.is_super_admin, false);
    const staleHeadersResponse = await handler(request(true));
    assert.equal(staleHeadersResponse.status, 200);
    const staleHeadersBody = await staleHeadersResponse.json();
    assert.equal(staleHeadersBody.auth.method.kind, "passkey_session");
    assert.deepEqual(requests, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relay passkey cookie fallback accepts raw forbidden Request methods", async () => {
  kvStore.clear();
  const { token: passkeyToken } = seedPasskeySession("uos_ai_session_raw_method_fallback");
  const githubToken = "ghp_raw_fallback_fixture";
  const abort = new AbortController();
  let port = 0;
  const server = serveHttp(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abort.signal,
      onListen: (address) => {
        port = address.port;
      },
    },
    async (request) => {
      const result = await authenticateClient(request);
      const payload = result.ok ? result.method.kind : String(result.response.status);
      return new Response(payload, {
        status: result.ok ? 200 : result.response.status,
        headers: { "Content-Length": String(new TextEncoder().encode(payload).byteLength) },
      });
    }
  );

  await server.ready;
  assert.notEqual(port, 0);
  const connection = connect({ host: "127.0.0.1", port });
  try {
    await once(connection, "connect");
    const rawRequest = [
      "TRACE /v1/models HTTP/1.1",
      "Host: ai.ubq.fi",
      `Authorization: Bearer ${githubToken}`,
      `Cookie: ${PASSKEY_RELAY_COOKIE_NAME}=${passkeyToken}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    connection.write(rawRequest);
    const chunks: Uint8Array[] = [];
    for await (const chunk of connection as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const responseBytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      responseBytes.set(chunk, offset);
      offset += chunk.length;
    }
    const response = new TextDecoder().decode(responseBytes);
    assert.match(response, /^HTTP\/1\.1 200 /);
    assert.match(response, /passkey_session$/);
  } finally {
    connection.destroy();
    abort.abort();
    await server.shutdown();
    await server.finished.catch(() => {});
  }
});
