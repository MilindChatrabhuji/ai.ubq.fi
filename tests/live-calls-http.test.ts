import assert from "node:assert/strict";
import { CountingKv } from "./helpers/counting-kv.ts";
import { CODEX_REFRESH_TOKEN_URL } from "../src/codex/auth.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, CodexAuthState } from "../src/types.ts";
import { LIVE_CALL_MAX_BODY_BYTES } from "../src/live/upstream.ts";
import { sha256Base64Url } from "../src/utils.ts";

// Hermetic loopback proof for `POST /v1/live`: the real production handler, a
// disposable in-memory KV, a seeded Codex auth pool, and one task-owned
// loopback upstream standing in for the ChatGPT backend route. No production
// data, no real upstream, and no paid provider is touched.
const loopbackPermission = await Deno.permissions.query({ name: "net", host: "127.0.0.1" });

const BOUNDARY = "codex-realtime-call-boundary";
const ACCOUNT_A = "live-calls-http-account-a";
const ACCOUNT_B = "live-calls-http-account-b";
const CALL_ID = "rtc_live_calls_http";
/** The authenticated principal the fixture's API key resolves to. */
const PRINCIPAL = "api-key:live-calls-http-key";
const SDP_OFFER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const SDP_ANSWER = "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const SESSION = { model: "gpt-live-1-codex", instructions: "be brief", delegation: { type: "client" }, audio: { output: { voice: "cove" } } };
const CLIENT_SESSION_HEADERS = {
  "openai-alpha": "quicksilver=v2",
  "x-session-id": "live-calls-http-session",
  "session-id": "live-calls-http-session",
  "thread-id": "live-calls-http-thread",
  "x-codex-turn-metadata": '{"thread_source":"user"}',
  "x-oai-attestation": "live-calls-http-attestation",
} as const;

const codexAccount = (accountId: string, nowMs: number): CodexAuthState => ({
  account_id: accountId,
  access_token: `${accountId}-access-token`,
  refresh_token: `${accountId}-refresh-token`,
  updated_at_ms: nowMs,
});

const encodeBase64Url = (value: unknown): string =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/={1,2}$/u, "");

/** A decodable JWT-shaped token; only `exp` matters to the refresh decision. */
const jwtLike = (payload: unknown): string => `${encodeBase64Url({ alg: "none" })}.${encodeBase64Url(payload)}.signature`;

/** A credential whose JWT expiry is already past, so the coordinated path must refresh it. */
const expiredCodexAccount = (accountId: string): CodexAuthState => ({
  account_id: accountId,
  access_token: jwtLike({ exp: Math.floor((Date.now() - 60_000) / 1_000) }),
  refresh_token: `${accountId}-refresh-token`,
  updated_at_ms: Date.now(),
});

/** The synthetic credential pair the controlled refresh endpoint answers with. */
const REFRESH_ACCESS_TOKEN = "live-calls-refreshed-access-token";
const REFRESH_REFRESH_TOKEN = "live-calls-refreshed-refresh-token";

type RefreshCall = Readonly<{ url: string; refreshToken: string | null }>;

type RefreshResponder = (call: RefreshCall) => Response;

type LiveCallsFixtureOptions = Readonly<{ accounts?: readonly CodexAuthState[] }>;

/** The client's exact byte layout: CRLF-delimited parts `sdp` then `session`. */
const realtimeCallBody = (sdp: string, session: unknown): string =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="sdp"\r\nContent-Type: application/sdp\r\n\r\n${sdp}\r\n` +
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="session"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(session)}\r\n` +
  `--${BOUNDARY}--\r\n`;

type UpstreamCall = Readonly<{ method: string; path: string; search: string; headers: Headers; bodyText: string }>;

type LiveCallsResponder = (accountId: string | null, bodyText: string) => Response | Promise<Response>;

type LiveCallsFixture = {
  readonly kv: CountingKv;
  readonly token: string;
  readonly gatewayBaseUrl: string;
  readonly upstreamCalls: UpstreamCall[];
  readonly refreshCalls: RefreshCall[];
  setResponder: (responder: LiveCallsResponder) => void;
  setRefreshResponder: (responder: RefreshResponder) => void;
  setAuthPool: (accounts: readonly CodexAuthState[]) => Promise<void>;
  stopUpstream: () => Promise<void>;
  close: () => Promise<void>;
};

const acceptedAnswer = (): Response => new Response(SDP_ANSWER, { status: 201, headers: { Location: `/v1/realtime/calls/${CALL_ID}` } });

const startLiveCallsFixture = async (responder: LiveCallsResponder, options: LiveCallsFixtureOptions = {}): Promise<LiveCallsFixture> => {
  const { setKvForTest } = await import("../src/kv.ts");
  const { resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
  const { resetCodexAccountRoutingForTest } = await import("../src/codex/account-routing.ts");
  const { default: handler } = await import("../src/handler/index.ts");
  const { createServeHandler } = await import("../src/handler/serve-handler.ts");
  const { setLiveUpstreamBasesForTest } = await import("../src/live/upstream.ts");
  const { config } = await import("../src/config.ts");

  const kv = new CountingKv();
  const upstreamCalls: UpstreamCall[] = [];
  const refreshCalls: RefreshCall[] = [];
  let activeResponder = responder;
  let activeRefreshResponder: RefreshResponder = (_call) => Response.json({ access_token: REFRESH_ACCESS_TOKEN, refresh_token: REFRESH_REFRESH_TOKEN });
  const originalDeployFlag = config.isDeploy;
  const originalInfo = console.info;
  const originalWarn = console.warn;

  setKvForTest(kv as unknown as Deno.Kv);
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  console.info = () => {};
  console.warn = () => {};
  // A loopback caller would otherwise receive the passwordless local principal
  // instead of an API key decision, which would hide the 401 arm.
  (config as { isDeploy: boolean }).isDeploy = true;

  const now = Date.now();
  const accounts = options.accounts ?? [codexAccount(ACCOUNT_A, now), codexAccount(ACCOUNT_B, now)];
  await kv.set(["ubq_ai", "codex_auth"], { accounts, updated_at_ms: now });
  const token = `u_${"c".repeat(64)}`;
  await seedApiKey(kv, token, now);

  // The refresh URL is a module constant, so the fixture redirects that exact
  // URL to a real loopback endpoint; no production refresh code or upstream
  // auth server is involved.
  const refreshServer = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (request) => {
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    const call: RefreshCall = { url: request.url, refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null };
    refreshCalls.push(call);
    return activeRefreshResponder(call);
  });
  const refreshEndpointUrl = `http://127.0.0.1:${(refreshServer.addr as Deno.NetAddr).port}/oauth/token`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let target: string;
    if (typeof input === "string") target = input;
    else if (input instanceof URL) target = input.href;
    else target = input.url;
    return originalFetch(target === CODEX_REFRESH_TOKEN_URL ? refreshEndpointUrl : input, init);
  };

  const upstreamServer = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (request) => {
    const bodyText = await request.text();
    const url = new URL(request.url);
    upstreamCalls.push({ method: request.method, path: url.pathname, search: url.search, headers: request.headers, bodyText });
    return activeResponder(request.headers.get("chatgpt-account-id"), bodyText);
  });
  setLiveUpstreamBasesForTest({ callsBaseUrl: `http://127.0.0.1:${(upstreamServer.addr as Deno.NetAddr).port}`, sidebandBaseUrl: null });

  const gatewayServer = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, createServeHandler(handler));

  let upstreamStopped = false;
  return {
    kv,
    token,
    gatewayBaseUrl: `http://127.0.0.1:${(gatewayServer.addr as Deno.NetAddr).port}`,
    upstreamCalls,
    refreshCalls,
    setResponder: (next) => {
      activeResponder = next;
    },
    setRefreshResponder: (next) => {
      activeRefreshResponder = next;
    },
    setAuthPool: async (nextAccounts) => {
      await kv.set(["ubq_ai", "codex_auth"], { accounts: nextAccounts, updated_at_ms: Date.now() });
    },
    stopUpstream: async () => {
      if (upstreamStopped) return;
      upstreamStopped = true;
      await upstreamServer.shutdown();
    },
    close: async () => {
      console.info = originalInfo;
      console.warn = originalWarn;
      (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
      globalThis.fetch = originalFetch;
      setLiveUpstreamBasesForTest({ callsBaseUrl: null, sidebandBaseUrl: null });
      setKvForTest(null);
      resetCodexAuthCacheForTest();
      resetCodexAccountRoutingForTest();
      await gatewayServer.shutdown();
      await upstreamServer.shutdown();
      await refreshServer.shutdown();
    },
  };
};

const seedApiKey = async (kv: CountingKv, token: string, nowMs: number): Promise<void> => {
  const tokenHash = await sha256Base64Url(token);
  const commonPolicy = {
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: -1,
    usage_requests: 0,
    usage_reset_at_ms: nowMs + 60 * 60_000,
    window_ms: 60 * 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  } satisfies Omit<ApiKeyHashRecord, "id">;
  const keyRecord: ApiKeyRecord = {
    id: "live-calls-http-key",
    name: "Live calls HTTP key",
    prefix: token.slice(0, 10),
    hash: tokenHash,
    created_at_ms: nowMs,
    ...commonPolicy,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: nowMs,
  };
  await kv.set(["ubq_ai", "api_keys", "id", keyRecord.id], keyRecord);
  await kv.set(["ubq_ai", "api_keys", "hash", tokenHash], { id: keyRecord.id, ...commonPolicy } satisfies ApiKeyHashRecord);
};

const postLiveCall = async (
  fixture: LiveCallsFixture,
  options: Readonly<{ body?: string; stream?: ReadableStream<Uint8Array>; contentType?: string | null; authorization?: string | null }> = {}
): Promise<Response> => {
  const headers = new Headers();
  const contentType = options.contentType === undefined ? `multipart/form-data; boundary=${BOUNDARY}` : options.contentType;
  if (contentType !== null) headers.set("content-type", contentType);
  const authorization = options.authorization === undefined ? `Bearer ${fixture.token}` : options.authorization;
  if (authorization !== null) headers.set("authorization", authorization);
  for (const [name, value] of Object.entries(CLIENT_SESSION_HEADERS)) headers.set(name, value);
  return await fetch(`${fixture.gatewayBaseUrl}/v1/live`, {
    method: "POST",
    headers,
    body: options.stream ?? options.body ?? realtimeCallBody(SDP_OFFER, SESSION),
  });
};

const errorPayload = async (response: Response): Promise<Record<string, unknown>> => {
  const payload = (await response.json()) as Record<string, unknown>;
  const error = payload.error;
  assert.ok(error && typeof error === "object", JSON.stringify(payload));
  return error as Record<string, unknown>;
};

Deno.test({
  name: "POST /v1/live answers 413 for an oversize body with a declared Content-Length",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startLiveCallsFixture(() => acceptedAnswer());
    try {
      const response = await postLiveCall(fixture, { body: "x".repeat(LIVE_CALL_MAX_BODY_BYTES + 1) });
      const error = await errorPayload(response);
      assert.equal(response.status, 413, JSON.stringify(error));
      assert.equal(error.message, `Live call creation bodies must be no larger than ${LIVE_CALL_MAX_BODY_BYTES} bytes.`);
      assert.equal(fixture.upstreamCalls.length, 0, "an oversize body never reaches upstream");
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "POST /v1/live answers 413 for an oversize streamed body that declares no length",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startLiveCallsFixture(() => acceptedAnswer());
    try {
      // A streamed request body is chunked, so no `content-length` exists and
      // only the read-time byte cap can decide this rejection.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(LIVE_CALL_MAX_BODY_BYTES + 2));
          controller.close();
        },
      });
      const response = await postLiveCall(fixture, { stream });
      const error = await errorPayload(response);
      assert.equal(response.status, 413, JSON.stringify(error));
      assert.equal(error.message, `Live call creation bodies must be no larger than ${LIVE_CALL_MAX_BODY_BYTES} bytes.`);
      assert.equal(fixture.upstreamCalls.length, 0, "an oversize body never reaches upstream");
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "POST /v1/live relays the multipart SDP offer as the backend JSON call and maps the call to its account",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startLiveCallsFixture(() => acceptedAnswer());
    try {
      const response = await postLiveCall(fixture);
      const body = await response.text();
      assert.equal(response.status, 201, body);
      assert.equal(body, SDP_ANSWER);
      assert.equal(response.headers.get("location"), `/v1/live/${CALL_ID}`);
      assert.ok(response.headers.get("x-uos-request-id"), "the JSON arm carries the gateway request id");
      assert.equal(response.headers.get("access-control-allow-origin"), "*");

      const upstream = fixture.upstreamCalls.at(-1);
      assert.ok(upstream, "the call reached the upstream");
      assert.equal(fixture.upstreamCalls.length, 1);
      assert.equal(upstream.method, "POST");
      assert.equal(upstream.path, "/realtime/calls");
      assert.equal(upstream.search, "?intent=quicksilver&architecture=avas");
      assert.equal(upstream.headers.get("content-type"), "application/json");
      assert.equal(upstream.headers.get("chatgpt-account-id"), ACCOUNT_A);
      assert.equal(upstream.headers.get("authorization"), `Bearer ${ACCOUNT_A}-access-token`);
      assert.notEqual(upstream.headers.get("authorization"), `Bearer ${fixture.token}`, "the client's own bearer token is never forwarded");
      assert.equal(upstream.headers.get("originator"), "codex_cli_rs");
      assert.match(upstream.headers.get("user-agent") ?? "", /^codex_cli_rs\//u);
      assert.equal(upstream.headers.get("openai-alpha"), "quicksilver=v2");
      assert.equal(upstream.headers.get("x-session-id"), "live-calls-http-session");
      assert.equal(upstream.headers.get("session-id"), "live-calls-http-session");
      assert.equal(upstream.headers.get("thread-id"), "live-calls-http-thread");
      assert.equal(upstream.headers.get("x-codex-turn-metadata"), '{"thread_source":"user"}');
      assert.equal(upstream.headers.get("x-oai-attestation"), "live-calls-http-attestation");

      const relayed = JSON.parse(upstream.bodyText) as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(relayed).sort((left, right) => left.localeCompare(right)),
        ["sdp", "session"]
      );
      assert.equal(relayed.sdp, SDP_OFFER);
      assert.deepEqual(relayed.session, SESSION);

      const mapping = fixture.kv.entries.get(JSON.stringify(["uos_ai", "codex_live_calls", "v1", CALL_ID]))?.value;
      assert.ok(mapping && typeof mapping === "object", "the call id is mapped to its creating account");
      assert.equal((mapping as { account_id?: unknown }).account_id, ACCOUNT_A);
      assert.equal((mapping as { principal_id?: unknown }).principal_id, PRINCIPAL, "the call is bound to its creating principal");
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "POST /v1/live answers 401 without client auth and never reaches upstream",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startLiveCallsFixture(() => acceptedAnswer());
    try {
      const response = await postLiveCall(fixture, { authorization: null });
      const error = await errorPayload(response);
      assert.equal(response.status, 401, JSON.stringify(error));
      assert.equal(error.code, "invalid_api_key");
      assert.equal(fixture.upstreamCalls.length, 0);
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "POST /v1/live rejects a non-multipart body and a multipart body without a session part",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startLiveCallsFixture(() => acceptedAnswer());
    try {
      const jsonBody = await postLiveCall(fixture, { body: JSON.stringify({ sdp: SDP_OFFER, session: SESSION }), contentType: "application/json" });
      const jsonError = await errorPayload(jsonBody);
      assert.equal(jsonBody.status, 400, JSON.stringify(jsonError));
      assert.equal(jsonError.type, "invalid_request_error");

      const missingSession = await postLiveCall(fixture, {
        body: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="sdp"\r\n\r\n${SDP_OFFER}\r\n--${BOUNDARY}--\r\n`,
      });
      const missingError = await errorPayload(missingSession);
      assert.equal(missingSession.status, 400, JSON.stringify(missingError));
      assert.equal(missingError.param, "session");

      const invalidSession = await postLiveCall(fixture, { body: realtimeCallBody(SDP_OFFER, "not-json") });
      assert.equal(invalidSession.status, 400, await invalidSession.text());

      assert.equal(fixture.upstreamCalls.length, 0, "no rejected body reaches upstream");
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "POST /v1/live answers 502 when the upstream call-creation route is unreachable",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startLiveCallsFixture(() => acceptedAnswer());
    try {
      await fixture.stopUpstream();
      const response = await postLiveCall(fixture);
      const error = await errorPayload(response);
      assert.equal(response.status, 502, JSON.stringify(error));
      assert.equal(error.code, "codex_upstream_unreachable");
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "POST /v1/live retries a credential failure once with the next eligible account",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startLiveCallsFixture((accountId) => {
      if (accountId !== ACCOUNT_A) return acceptedAnswer();
      return Response.json({ detail: "credential expired" }, { status: 401 });
    });
    try {
      const response = await postLiveCall(fixture);
      const body = await response.text();
      assert.equal(response.status, 201, body);
      assert.equal(body, SDP_ANSWER);
      assert.equal(fixture.upstreamCalls.length, 2, "a 401 admits exactly one retry");
      assert.equal(fixture.upstreamCalls[0]?.headers.get("chatgpt-account-id"), ACCOUNT_A);
      assert.equal(fixture.upstreamCalls[1]?.headers.get("chatgpt-account-id"), ACCOUNT_B);
      assert.equal(fixture.upstreamCalls[1]?.headers.get("authorization"), `Bearer ${ACCOUNT_B}-access-token`);
      assert.equal(fixture.upstreamCalls[1]?.path, "/realtime/calls");
      assert.equal(response.headers.get("location"), `/v1/live/${CALL_ID}`);
      const mapping = fixture.kv.entries.get(JSON.stringify(["uos_ai", "codex_live_calls", "v1", CALL_ID]))?.value;
      assert.equal((mapping as { account_id?: unknown } | undefined)?.account_id, ACCOUNT_B, "the call is mapped to the account that created it");
      assert.equal((mapping as { principal_id?: unknown } | undefined)?.principal_id, PRINCIPAL, "the call stays bound to its creating principal");
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "POST /v1/live relays an upstream credential failure verbatim when no other account is eligible",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fixture = await startLiveCallsFixture(() => Response.json({ detail: "credential expired" }, { status: 401 }));
    try {
      const response = await postLiveCall(fixture);
      const body = await response.text();
      assert.equal(response.status, 401, body);
      assert.equal(body, '{"detail":"credential expired"}');
      assert.equal(fixture.upstreamCalls.length, 1, "the reloaded pool still offers only the failed account");
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "POST /v1/live refreshes the selected account's expired token before dispatch and leaves other accounts untouched",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const untouchedAccount = codexAccount(ACCOUNT_B, Date.now());
    const fixture = await startLiveCallsFixture(() => acceptedAnswer(), { accounts: [expiredCodexAccount(ACCOUNT_A), untouchedAccount] });
    try {
      const response = await postLiveCall(fixture);
      const body = await response.text();
      assert.equal(response.status, 201, body);
      assert.equal(body, SDP_ANSWER);

      const upstream = fixture.upstreamCalls.at(-1);
      assert.ok(upstream, "the call reached the upstream");
      assert.equal(upstream.headers.get("chatgpt-account-id"), ACCOUNT_A);
      assert.equal(
        upstream.headers.get("authorization"),
        `Bearer ${REFRESH_ACCESS_TOKEN}`,
        "the dispatch carries the refreshed credential instead of the expired bearer the routing read exposed"
      );
      assert.equal(fixture.refreshCalls.length, 1, "the expired account is refreshed exactly once");
      assert.equal(fixture.refreshCalls[0]?.refreshToken, `${ACCOUNT_A}-refresh-token`, "the refresh re-read the selected account by identity");

      const storedPool = fixture.kv.entries.get(JSON.stringify(["ubq_ai", "codex_auth"]))?.value as { accounts?: CodexAuthState[] } | undefined;
      const refreshed = storedPool?.accounts?.find((account) => account.account_id === ACCOUNT_A);
      assert.equal(refreshed?.access_token, REFRESH_ACCESS_TOKEN, "the rotated credential is persisted under the same account identity");
      assert.equal(refreshed.refresh_token, REFRESH_REFRESH_TOKEN);
      const untouched = storedPool?.accounts?.find((account) => account.account_id === ACCOUNT_B);
      assert.deepEqual(untouched, untouchedAccount, "an unrelated account's credential is left exactly as seeded");

      const mapping = fixture.kv.entries.get(JSON.stringify(["uos_ai", "codex_live_calls", "v1", CALL_ID]))?.value;
      assert.equal((mapping as { account_id?: unknown } | undefined)?.account_id, ACCOUNT_A, "the call keeps its creating account identity");
      assert.equal((mapping as { principal_id?: unknown } | undefined)?.principal_id, PRINCIPAL, "the creator-principal binding is preserved");
    } finally {
      await fixture.close();
    }
  },
});

Deno.test({
  name: "POST /v1/live fails closed when the selected account disappears while its token is refreshing",
  ignore: loopbackPermission.state !== "granted",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let fixture: LiveCallsFixture | null = null;
    fixture = await startLiveCallsFixture(() => acceptedAnswer(), { accounts: [expiredCodexAccount(ACCOUNT_A), codexAccount(ACCOUNT_B, Date.now())] });
    fixture.setRefreshResponder(() => {
      // The account leaves the pool while its refresh is in flight, so its
      // rotated credential can never be persisted for it.
      void fixture.setAuthPool([codexAccount(ACCOUNT_B, Date.now())]);
      return Response.json({ access_token: REFRESH_ACCESS_TOKEN, refresh_token: REFRESH_REFRESH_TOKEN });
    });
    try {
      const response = await postLiveCall(fixture);
      const error = await errorPayload(response);
      assert.equal(response.status, 503, JSON.stringify(error));
      assert.equal(error.code, "codex_auth_missing");
      assert.equal(fixture.upstreamCalls.length, 0, "a disappeared account dispatches no credential at all");
      assert.equal(fixture.refreshCalls.length, 1);
    } finally {
      await fixture.close();
    }
  },
});
