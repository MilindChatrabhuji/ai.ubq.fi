import assert from "node:assert/strict";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function objectBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  assert(isObject(value));
  return value;
}

function setCookies(response: Response): string[] {
  const values = response.headers.getSetCookie();
  if (Array.isArray(values) && values.length) return values;
  const combined = response.headers.get("set-cookie");
  return combined ? [combined] : [];
}

function cookiePair(cookie: string): string {
  return cookie.split(";", 1)[0] ?? "";
}

export async function passportCases(url: (path: string) => string, cases: string[]): Promise<void> {
  const login = await fetch(url("/auth/login"), { redirect: "manual" });
  assert.equal(login.status, 302);
  const location = login.headers.get("location") ?? "";
  const authorize = new URL(location);
  assert.equal(authorize.origin, "https://passport.ubq.fi");
  assert.equal(authorize.pathname, "/authorize");
  assert.equal(authorize.searchParams.get("client_id"), "ai");
  assert.equal(authorize.searchParams.get("audience"), "ai");
  assert.equal(authorize.searchParams.get("origin"), "https://ai.ubq.fi");
  assert.equal(authorize.searchParams.get("redirect_uri"), "https://ai.ubq.fi/auth/callback");
  const state = authorize.searchParams.get("state") ?? "";
  assert(state.length > 20);
  const loginCookies = setCookies(login);
  assert.equal(loginCookies.length, 1);
  assert(loginCookies[0].startsWith(`__Host-uos_ai_passport_state=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`));
  cases.push("passport_login_exact_authorize_redirect_and_state_cookie");

  const mismatch = await fetch(url(`/auth/callback?state=${encodeURIComponent(state)}&code=admin`), {
    headers: { cookie: "__Host-uos_ai_passport_state=other" },
    redirect: "manual",
  });
  assert.equal(mismatch.status, 401);
  assert(setCookies(mismatch).some((value) => value.startsWith("__Host-uos_ai_passport_state=;")));
  cases.push("passport_callback_rejects_state_mismatch");

  const exchange = async (code: string): Promise<{ token: string; cookie: string }> => {
    const callback = await fetch(url(`/auth/callback?state=${encodeURIComponent(state)}&code=${code}`), {
      headers: { cookie: cookiePair(loginCookies[0]) },
      redirect: "manual",
    });
    assert.equal(callback.status, 302);
    const cookies = setCookies(callback);
    assert.equal(cookies.length, 2, "callback must emit two independent Set-Cookie headers");
    const session = cookies.find((value) => value.startsWith("__Host-uos_ai_passport_session="));
    assert(session);
    assert(session.includes("Path=/; Max-Age=") && session.includes("HttpOnly; Secure; SameSite=Lax"));
    assert(cookies.some((value) => value.startsWith("__Host-uos_ai_passport_state=; Path=/; Max-Age=0")));
    const token = cookiePair(session).slice("__Host-uos_ai_passport_session=".length);
    return { token, cookie: cookiePair(session) };
  };

  const admin = await exchange("admin");
  const authPayload = await objectBody(await fetch(url("/uos/auth"), { headers: { cookie: admin.cookie } }));
  const auth = authPayload.auth;
  assert(isObject(auth));
  assert.equal(auth.principal, "passport-user:fixture-admin");
  const method = auth.method;
  assert(isObject(method));
  assert.equal(method.kind, "passport_session");
  assert.equal(auth.is_admin, true);
  const tokenInfo = auth.token;
  assert(isObject(tokenInfo));
  assert.equal(tokenInfo.present, false);
  cases.push("passport_cookie_principal_and_uos_auth");

  const models = await fetch(url("/v1/models?client_version=0.163.0"), { headers: { cookie: admin.cookie } });
  assert.equal(models.status, 200);
  const catalog = await objectBody(models);
  assert(Array.isArray(catalog.models) && catalog.models.length > 0);
  const inference = await fetch(url("/v1/responses"), {
    method: "POST",
    headers: { cookie: admin.cookie, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", input: "fixture:passport", stream: false }),
  });
  assert.equal(inference.status, 200);
  assert(JSON.stringify(await objectBody(inference)).includes("fixture answer"));
  cases.push("passport_cookie_authenticates_models_and_inference");

  const adminResponse = await fetch(url("/admin/api-keys"), { headers: { cookie: admin.cookie } });
  assert.equal(adminResponse.status, 200, await adminResponse.clone().text());
  cases.push("passport_admin_cookie_requires_isadmin");

  const user = await exchange("user");
  const nonAdmin = await fetch(url("/admin/api-keys"), { headers: { cookie: user.cookie } });
  assert.equal(nonAdmin.status, 403);
  cases.push("passport_non_admin_cookie_forbidden");

  const bearer = await fetch(url("/admin/api-keys"), { headers: { authorization: `Bearer ${admin.token}` } });
  assert.equal(bearer.status, 401);
  assert.equal((await fetch(url("/uos/auth"), { headers: { authorization: `Bearer ${admin.token}` } })).status, 200);
  cases.push("passport_bearer_denied_for_admin_and_allowed_for_client");

  const invalidJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.invalid";
  assert.equal((await fetch(url("/uos/auth"), { headers: { authorization: `Bearer ${invalidJwt}` } })).status, 401);
  assert.equal((await fetch(url("/admin/api-keys"), { headers: { authorization: `Bearer ${invalidJwt}` } })).status, 401);
  cases.push("jwt_shaped_invalid_credential_fails_closed");

  const foreignMutation = await fetch(url("/admin/api-keys"), {
    method: "POST",
    headers: { cookie: admin.cookie, origin: "https://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ name: "must-not-exist" }),
  });
  assert.equal(foreignMutation.status, 403);
  cases.push("passport_admin_cookie_mutation_rejects_foreign_origin");
}

export async function cerebrasPaymentCases(url: (path: string) => string, cases: string[]): Promise<void> {
  for (const [path, body] of [
    ["/v1/chat/completions", { model: "gpt-oss-120b", messages: [{ role: "user", content: "fixture:cerebras:402" }], stream: false }],
    ["/v1/responses", { model: "gpt-oss-120b", input: "fixture:cerebras:402", stream: false }],
  ] as const) {
    const response = await fetch(url(path), {
      method: "POST",
      headers: { authorization: "Bearer fixture-access", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 402);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.length, 146);
    assert.equal(
      new TextDecoder().decode(bytes),
      '{"error":{"message":"Payment required: add credits to this account to continue now!!!!","type":"invalid_request_error","code":"payment_required"}}'
    );
    assert.equal(response.headers.get("x-uos-upstream"), "cerebras");
    assert.equal(response.headers.get("retry-after"), "7");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("server"), null);
    assert.equal(response.headers.get("cf-ray"), null);
    assert.equal(response.headers.get("x-arbitrary"), null);
  }
  cases.push("cerebras_payment_required_normalized_146_byte_both_surfaces");
}
