import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/passkeys-harness.ts";
// Suite part: tests moved out of the original file.

import assert from "node:assert/strict";
import {
  PASSKEY_RELAY_COOKIE_NAME,
  config,
  encodeBase64Url,
  handlePasskeyRegisterStart,
  handleV1Auth,
  kvStore,
  kvStub,
  passkeySessionKey,
  seedPasskeySession,
} from "./helpers/passkeys-harness.ts";

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("allowlisted GitHub client bearers keep precedence over passkey cookies", async () => {
  kvStore.clear();
  const { token: passkeyToken } = seedPasskeySession("uos_ai_session_client_cookie");
  const githubToken = "ghp_allowlisted_client_token_1234567890abcdefghijklmnopqrstuvwxyz";
  const authTokens = config.authTokens as Set<string>;
  authTokens.add(githubToken);
  try {
    const response = await handleV1Auth(
      new Request("https://ai.ubq.fi/uos/auth", {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(passkeyToken)}`,
        },
      })
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.auth.method.kind, "auth_tokens_allowlist");
    assert.equal(body.auth.token.shape, "github_prefix");
  } finally {
    authTokens.delete(githubToken);
  }
});

test("allowlisted GitHub admin bearers keep precedence over passkey cookies on /uos/auth", async () => {
  kvStore.clear();
  const { token: passkeyToken } = seedPasskeySession("uos_ai_session_non_admin_cookie", { isAdmin: false });
  const githubToken = "ghp_allowlisted_admin_fixture";
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(githubToken);
  try {
    const response = await handleV1Auth(
      new Request("https://ai.ubq.fi/uos/auth", {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(passkeyToken)}`,
        },
      })
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.auth.method.kind, "admin_allowlist");
    assert.equal(body.auth.is_admin, true);
    assert.equal(body.auth.is_super_admin, true);
    assert.equal(body.auth.token.shape, "github_prefix");
  } finally {
    adminTokens.delete(githubToken);
  }
});

test("passkey lifecycle handlers prefer a relay cookie over a stale GitHub bearer", async () => {
  kvStore.clear();
  const audienceOrigin = "https://agent-worker-4d2p9cx7m1ab.ubiquity-os.deno.net";
  const { token, user } = seedPasskeySession("uos_ai_session_lifecycle_cookie", { audienceOrigin });
  const githubToken = "ghp_stale_lifecycle_fixture";
  const { default: handler } = await import("../src/handler/index.ts");
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(token)}`,
    Origin: audienceOrigin,
  };

  const sessionResponse = await handler(new Request("https://ai.ubq.fi/api/auth/session", { headers }));
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json();
  assert.equal(sessionBody.user.id, user.id);

  const registerResponse = await handler(
    new Request("https://ai.ubq.fi/api/auth/register/start", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ handle: user.handle }),
    })
  );
  assert.equal(registerResponse.status, 200);
  const registerBody = await registerResponse.json();
  const encodedUserId = encodeBase64Url(user.id);
  assert.equal(registerBody.publicKey.user.id, encodedUserId);
  assert.equal(registerBody.publicKey.user.name, user.handle);

  const logoutResponse = await handler(new Request("https://ai.ubq.fi/api/auth/logout", { method: "POST", headers }));
  assert.equal(logoutResponse.status, 204);
  assert.equal((await kvStub.get(passkeySessionKey(token))).value, null);
});

test("passkey lifecycle handlers preserve configured bearer precedence", async () => {
  for (const configuredKind of ["client", "admin"] as const) {
    kvStore.clear();
    const audienceOrigin = "https://agent-worker-4d2p9cx7m1ab.ubiquity-os.deno.net";
    const { token: passkeyToken } = seedPasskeySession(`uos_ai_session_${configuredKind}_lifecycle_cookie`, {
      audienceOrigin,
    });
    const configuredToken = `ghp_configured_${configuredKind}_lifecycle_1234567890abcdefghijklmnopqrstuvwxyz`;
    const configuredTokens = configuredKind === "client" ? (config.authTokens as Set<string>) : (config.adminTokens as Set<string>);
    configuredTokens.add(configuredToken);
    try {
      const { default: handler } = await import("../src/handler/index.ts");
      const headers = {
        Authorization: `Bearer ${configuredToken}`,
        Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(passkeyToken)}`,
        Origin: audienceOrigin,
      };
      const registrationHandle = `configured-${configuredKind}-registration`;
      const registerResponse = await handler(
        new Request("https://ai.ubq.fi/api/auth/register/start", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ handle: registrationHandle }),
        })
      );
      assert.equal(registerResponse.status, configuredKind === "client" ? 401 : 200, configuredKind);
      if (configuredKind === "admin") {
        const registerBody = await registerResponse.json();
        assert.equal(registerBody.publicKey.user.name, registrationHandle);
      }

      const sessionResponse = await handler(new Request("https://ai.ubq.fi/api/auth/session", { headers }));
      assert.equal(sessionResponse.status, 401, configuredKind);

      const logoutResponse = await handler(new Request("https://ai.ubq.fi/api/auth/logout", { method: "POST", headers }));
      assert.equal(logoutResponse.status, 204, configuredKind);
      assert.notEqual((await kvStub.get(passkeySessionKey(passkeyToken))).value, null, configuredKind);
    } finally {
      configuredTokens.delete(configuredToken);
    }
  }
});

test("passkey logout preserves valid bearer precedence over a relay cookie", async () => {
  kvStore.clear();
  const audienceOrigin = "https://agent-worker-4d2p9cx7m1ab.ubiquity-os.deno.net";
  const { token: bearerToken } = seedPasskeySession("uos_ai_session_bearer_precedence");
  const { token: cookieToken } = seedPasskeySession("uos_ai_session_cookie_secondary", { audienceOrigin });
  const { default: handler } = await import("../src/handler/index.ts");
  const response = await handler(
    new Request("https://ai.ubq.fi/api/auth/logout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${encodeURIComponent(cookieToken)}`,
        Origin: audienceOrigin,
      },
    })
  );

  assert.equal(response.status, 204);
  assert.equal((await kvStub.get(passkeySessionKey(bearerToken))).value, null);
  assert.notEqual((await kvStub.get(passkeySessionKey(cookieToken))).value, null);
});

test("authenticated passkey token overrides remain bound to their relay audience", async () => {
  kvStore.clear();
  const audienceOrigin = "https://agent-worker-4d2p9cx7m1ab.ubiquity-os.deno.net";
  const { token } = seedPasskeySession("uos_ai_session_override_audience", { audienceOrigin });
  const response = await handlePasskeyRegisterStart(
    new Request("https://ai.ubq.fi/api/auth/register/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: "{}",
    }),
    { authenticatedPasskeyToken: token }
  );

  assert.equal(response.status, 401);
});
