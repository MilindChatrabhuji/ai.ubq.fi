import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { Kv } from "#kv";
import { serveHttp } from "#http";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { apiKeyHashKey } from "../src/api-keys.ts";
import {
  type ApiKeyPolicy,
  apiKeyPolicyFromHashRecord,
  ApiKeyQuotaDispatchError,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
  type ApiKeyUsageReservation,
  reserveApiKeyUsageV3,
} from "../src/api-key-policy.ts";
import { kernelQuotaRouteForRequest, terminalRouteForRequest } from "../src/handler/http.ts";
import { setKvForTest } from "../src/kv.ts";
import { getResponseTelemetry, type UsageContext } from "../src/openai-telemetry.ts";
import { getOpenRouterProviderHealth, resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import { fetchOpenRouterSystemOne, OpenRouterError, OPENROUTER_SYSTEMONE_URL } from "../src/provider/openrouter.ts";
import { handleSystemOne, SYSTEMONE_DEFAULT_MODEL } from "../src/systemone/handlers.ts";
import type { ApiKeyHashRecord, ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "../src/types.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const jsonBodyOf = (init?: RequestInit): unknown => {
  const body = init?.body;
  return typeof body === "string" ? JSON.parse(body) : null;
};

const request = (body: unknown): Request =>
  new Request("https://ai.ubq.fi/uos/systemone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const state = {
  question: {
    capabilityKey: "search.person.filter_group",
    filterKey: "search.lead.filter.industry",
    prompt: "Which candidate is the filter group container?",
    options: [{ optionId: "g-industry", selector: 'fieldset[data-x-search-filter="INDUSTRY"]' }],
  },
};

const questions = {
  candidate: {
    type: "choice",
    instructions: "Choose one offered candidate or not_stated.",
    criteria: { "g-industry": "The INDUSTRY fieldset.", not_stated: "No sound repair." },
  },
};

const answerPayload = {
  model: "typesafe/jev-1.13-20260917",
  answers: { candidate: { type: "choice", choice: "g-industry", confidence: 0.99 } },
  usage: { input_tokens: 1118, output_tokens: 117, cost: 4.6956e-5 },
};

/**
 * The bounded V3 API-key ledger the terminal wrapper admits requests into: an
 * in-memory KV holding the hash record `reserveApiKeyUsageV3` reads, plus the
 * policy the reservation is built from.
 */
const ledgerFixture = (id: string, usageLimitRequests: number, nowMs = Date.now()): Readonly<{ kv: CountingKv; policy: ApiKeyPolicy }> => {
  const tokenHash = `systemone-${id}`;
  const record: ApiKeyHashRecord = {
    id,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: usageLimitRequests,
    usage_requests: 0,
    usage_reset_at_ms: nowMs + 60 * 60_000,
    window_ms: 60 * 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  const policy = apiKeyPolicyFromHashRecord(tokenHash, record, nowMs);
  if (!policy) throw new Error("test API key policy must be valid");
  const kv = new CountingKv();
  kv.seed(apiKeyHashKey(tokenHash), record);
  return { kv, policy };
};

/** Admits one request through the same deferred path the terminal wrapper uses. */
const admissionFor = async (kv: CountingKv, policy: ApiKeyPolicy, requestId: string): Promise<ApiKeyUsageReservation> => {
  const decision = await reserveApiKeyUsageV3(policy, requestId, "systemone", { kv: kv as unknown as Kv, deferWhenFull: true });
  if (!decision.ok) throw new Error(`unexpected admission failure: ${decision.response.status}`);
  return decision.reservation;
};

const usageContextWith = (reservation: ApiKeyUsageReservation): UsageContext => ({
  keyId: null,
  kernelRepo: null,
  kernelOrg: null,
  beforeProviderDispatch: reservation.beforeProviderDispatch,
});

const storedWindow = (kv: CountingKv, policy: ApiKeyPolicy): ApiKeyUsageWindowV3 => {
  const window = kv.entries.get(JSON.stringify(apiKeyUsageV3WindowKey(policy)))?.value as ApiKeyUsageWindowV3 | undefined;
  if (!window) throw new Error("expected a V3 usage window");
  return window;
};

const storedRequest = (kv: CountingKv, policy: ApiKeyPolicy, requestId: string): ApiKeyUsageRequestV3 | null =>
  (kv.entries.get(JSON.stringify(apiKeyUsageV3RequestKey(policy, requestId)))?.value as ApiKeyUsageRequestV3 | undefined) ?? null;

test("systemone cancels an expired pre-dispatch reservation before returning a bounded upstream error", async () => {
  const { kv, policy } = ledgerFixture("deadline", 1);
  const reservation = await admissionFor(kv, policy, "systemone-deadline");
  let fetchCalls = 0;
  let cancelCalls = 0;
  let transportStarts = 0;
  await assert.rejects(
    () =>
      fetchOpenRouterSystemOne({
        body: { state, questions },
        apiKey: "or-test-key",
        timeoutMs: 1,
        fetcher: () => {
          fetchCalls += 1;
          return Promise.resolve(Response.json(answerPayload));
        },
        hooks: {
          beforeDispatch: async () => {
            const dispatch = await reservation.beforeProviderDispatch("openrouter");
            assert.ok(dispatch);
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            return {
              markTransportStarted: () => {
                transportStarts += 1;
                dispatch.markTransportStarted();
              },
              cancelBeforeTransport: async () => {
                cancelCalls += 1;
                await dispatch.cancelBeforeTransport();
              },
            };
          },
        },
      }),
    (error: unknown) => error instanceof OpenRouterError && error.code === "openrouter_upstream_unreachable" && error.status === 502
  );
  assert.equal(fetchCalls, 0);
  assert.equal(transportStarts, 0);
  assert.equal(cancelCalls, 1);
  assert.equal(storedWindow(kv, policy).committed_requests, 0);
  assert.equal(storedWindow(kv, policy).reserved_requests, 0);
  assert.equal(storedRequest(kv, policy, "systemone-deadline")?.release_reason, "transport_cancelled_before_fetch");
});

test("systemone loopback deadline responses preserve quota hook errors and headers", async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  let deadline: AbortSignal | null = null;
  let fetchCalls = 0;
  let cancelCalls = 0;
  const quotaError = new ApiKeyQuotaDispatchError("Synthetic quota refusal", {
    status: 429,
    code: "rate_limit_exceeded",
    errorType: "rate_limit_error",
    retryAfter: "7",
    headers: { "RateLimit-Limit": "1", "RateLimit-Remaining": "0" },
  });
  const kv = new CountingKv();
  setKvForTest(kv as unknown as Kv);
  resetProviderHealthThrottleForTest();
  AbortSignal.timeout = () => {
    deadline = originalTimeout(1);
    return deadline;
  };
  const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) =>
    handleSystemOne(
      req,
      {
        keyId: null,
        kernelRepo: null,
        kernelOrg: null,
        beforeProviderDispatch: async () => {
          assert.ok(deadline);
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          assert.equal(deadline.aborted, true);
          if (new URL(req.url).pathname === "/quota") throw quotaError;
          return {
            markTransportStarted: () => assert.fail("expired deadline must not start transport"),
            cancelBeforeTransport: () => {
              cancelCalls += 1;
              if (new URL(req.url).pathname === "/cancel-quota") return Promise.reject(quotaError);
              return Promise.resolve();
            },
          };
        },
      },
      {
        apiKey: () => "or-test-key",
        fetcher: () => {
          fetchCalls += 1;
          return Promise.resolve(Response.json(answerPayload));
        },
      }
    )
  );
  try {
    await server.ready;
    for (const path of ["/v1/systemone", "/quota", "/cancel-quota"]) {
      const response = await fetch(`http://127.0.0.1:${server.addr.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, questions }),
      });
      const quota = path !== "/v1/systemone";
      assert.equal(response.status, quota ? 429 : 502);
      assert.deepEqual(await response.json(), {
        error: {
          message: quota ? "Synthetic quota refusal" : "System One upstream unreachable",
          type: quota ? "rate_limit_error" : "invalid_request_error",
          code: quota ? "rate_limit_exceeded" : "openrouter_upstream_unreachable",
          ...(quota ? { param: null } : {}),
        },
      });
      const expectedQuotaHeaders = quota ? ["7", "1", "0"] : [null, null, null];
      assert.equal(response.headers.get("retry-after"), expectedQuotaHeaders[0]);
      assert.equal(response.headers.get("ratelimit-limit"), expectedQuotaHeaders[1]);
      assert.equal(response.headers.get("ratelimit-remaining"), expectedQuotaHeaders[2]);
    }
    assert.equal(fetchCalls, 0);
    assert.equal(cancelCalls, 2);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((await getOpenRouterProviderHealth()).state, "unknown");
  } finally {
    await server.shutdown();
    AbortSignal.timeout = originalTimeout;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    setKvForTest(null);
    resetProviderHealthThrottleForTest();
  }
});

test("systemone commits the api-key request reservation exactly once before dispatch", async () => {
  const { kv, policy } = ledgerFixture("commit-once", 2);
  const reservation = await admissionFor(kv, policy, "systemone-commit-once");
  let fetchCalls = 0;
  const fetcher = createFetchMock(() => {
    fetchCalls += 1;
    return Promise.resolve(Response.json(answerPayload));
  });

  const response = await handleSystemOne(request({ state, questions }), usageContextWith(reservation), { fetcher, apiKey: () => "or-test-key" });

  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
  const window = storedWindow(kv, policy);
  assert.equal(window.committed_requests, 1);
  assert.equal(window.reserved_requests, 0);
  const row = storedRequest(kv, policy, "systemone-commit-once");
  assert.ok(row);
  assert.equal(row.state, "dispatched");
  assert.equal(row.provider, "openrouter");
});

test("systemone refuses an exhausted api-key window before the upstream fetch", async () => {
  const { kv, policy } = ledgerFixture("exhausted", 1);
  const first = await admissionFor(kv, policy, "systemone-exhausted-1");
  await first.beforeProviderDispatch("openrouter");
  const second = await admissionFor(kv, policy, "systemone-exhausted-2");
  let fetchCalls = 0;
  const fetcher = createFetchMock(() => {
    fetchCalls += 1;
    return Promise.resolve(Response.json(answerPayload));
  });

  const response = await handleSystemOne(request({ state, questions }), usageContextWith(second), { fetcher, apiKey: () => "or-test-key" });

  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, "rate_limit_exceeded");
  assert.equal(body.error.type, "rate_limit_error");
  assert.equal(response.headers.get("ratelimit-limit"), "1");
  assert.equal(response.headers.get("ratelimit-remaining"), "0");
  assert.ok(Number(response.headers.get("retry-after")) >= 1);
  assert.equal(fetchCalls, 0);
  const window = storedWindow(kv, policy);
  assert.equal(window.committed_requests, 1);
  assert.equal(window.reserved_requests, 0);
  assert.equal(storedRequest(kv, policy, "systemone-exhausted-2"), null);
});

test("systemone proxies one typed question set upstream with the server key", async () => {
  const captured: { url: string; headers: Headers | null; body: unknown } = {
    url: "",
    headers: null,
    body: null,
  };
  const fetcher = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = urlOf(input);
    captured.headers = new Headers(init?.headers);
    captured.body = jsonBodyOf(init);
    return Promise.resolve(Response.json(answerPayload));
  });

  const response = await handleSystemOne(request({ state, questions }), undefined, {
    fetcher,
    apiKey: () => "or-test-key",
  });

  assert.equal(response.status, 200);
  assert.equal(captured.url, OPENROUTER_SYSTEMONE_URL);
  assert.equal(captured.headers?.get("authorization"), "Bearer or-test-key");
  const sent = captured.body as Record<string, unknown>;
  assert.equal(sent.model, SYSTEMONE_DEFAULT_MODEL);
  assert.deepEqual(sent.state, state);
  assert.deepEqual(sent.questions, questions);
  const payload = await response.json();
  assert.deepEqual(payload.answers.candidate.choice, "g-industry");
  assert.equal(payload.answers.candidate.confidence, 0.99);
});

test("systemone accepts an explicit typesafe model and rejects other models", async () => {
  const seen: string[] = [];
  const fetcher = createFetchMock((_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push((jsonBodyOf(init) as { model: string }).model);
    return Promise.resolve(Response.json(answerPayload));
  });

  const ok = await handleSystemOne(request({ state, questions, model: "~typesafe/jev-1.13.0" }), undefined, {
    fetcher,
    apiKey: () => "or-test-key",
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, ["~typesafe/jev-1.13.0"]);

  for (const model of ["openai/gpt-6-sol", "typesafe/", "~typesafe/" + "a".repeat(90)]) {
    const rejected = await handleSystemOne(request({ state, questions, model }), undefined, {
      fetcher,
      apiKey: () => "or-test-key",
    });
    assert.equal(rejected.status, 400);
  }
  assert.deepEqual(seen, ["~typesafe/jev-1.13.0"]);
});

test("systemone requires configuration and refuses malformed question sets", async () => {
  const unconfigured = await handleSystemOne(request({ state, questions }), undefined, {
    fetcher: createFetchMock(() => Promise.resolve(Response.json(answerPayload))),
    apiKey: () => null,
  });
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).error.code, "openrouter_api_key_missing");

  const fetcher = createFetchMock(() => Promise.reject(new Error("must not reach upstream")));
  const apiKey = () => "or-test-key";
  const cases: unknown[] = [
    { state, questions, extra: true },
    { state: "not-an-object", questions },
    { state, questions: {} },
    { state, questions: { a: { type: "unsupported" } } },
    { state, questions: { a: { instructions: "missing type" } } },
  ];
  for (const body of cases) {
    const response = await handleSystemOne(request(body), undefined, { fetcher, apiKey });
    assert.equal(response.status, 400);
  }
});

test("systemone maps upstream upsets to bounded errors", async () => {
  const apiKey = () => "or-test-key";

  const unreachable = await handleSystemOne(request({ state, questions }), undefined, {
    fetcher: createFetchMock(() => Promise.reject(new Error("connect timeout"))),
    apiKey,
  });
  assert.equal(unreachable.status, 502);
  assert.equal((await unreachable.json()).error.code, "openrouter_upstream_unreachable");

  for (const [status, expected] of [
    [429, 429],
    [500, 502],
    [503, 502],
  ] as const) {
    const failed = await handleSystemOne(request({ state, questions }), undefined, {
      fetcher: createFetchMock(() => Promise.resolve(new Response("{}", { status }))),
      apiKey,
    });
    assert.equal(failed.status, expected);
  }

  const invalid = await handleSystemOne(request({ state, questions }), undefined, {
    fetcher: createFetchMock(() => Promise.resolve(Response.json({ model: "typesafe/jev-1.13-20260917" }))),
    apiKey,
  });
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).error.code, "openrouter_upstream_invalid_response");
});

test("systemone is a terminal inference route with its own quota route", () => {
  assert.equal(terminalRouteForRequest("POST", "/v1/systemone"), "systemone");
  assert.equal(kernelQuotaRouteForRequest("POST", "/v1/systemone"), "systemone");
  // Hard cutover: the previous UOS platform path no longer routes.
  assert.equal(terminalRouteForRequest("POST", "/uos/systemone"), null);
});

test("systemone attaches reported usage telemetry to its response", async () => {
  const fetcher = createFetchMock(() =>
    Promise.resolve(
      Response.json({
        model: "typesafe/jev-1.13-20260917",
        answers: { candidate: { type: "choice", choice: "yes", confidence: 0.9 } },
        usage: { input_tokens: 310, output_tokens: 20, cost: 0.00001302 },
      })
    )
  );
  const response = await handleSystemOne(request({ state, questions }), undefined, {
    fetcher,
    apiKey: () => "or-test-key",
  });
  assert.equal(response.status, 200);
  const telemetry = getResponseTelemetry(response);
  assert.ok(telemetry);
  assert.equal(telemetry.model, SYSTEMONE_DEFAULT_MODEL);
  assert.equal(telemetry.provider, "openrouter");
  assert.equal(telemetry.inputTokens, 310);
  assert.equal(telemetry.cachedInputTokens, 0);
  assert.equal(telemetry.outputTokens, 20);
  assert.equal(telemetry.totalTokens, 330);
  assert.equal(telemetry.usageObserved, true);
  assert.equal(telemetry.usageTelemetryStatus, "reported");
  assert.equal(telemetry.completed, true);
  assert.equal(telemetry.stream, false);
});

for (const [status, upstreamBody, expectedEvent, expectedState, clientStatus] of [
  [402, '{"error":{"message":"Insufficient credits"}}', "quota_exhausted", "exhausted", 502],
  [402, "{}", "quota_exhausted", "exhausted", 502],
  [429, "{}", "quota_exhausted", "exhausted", 429],
  [403, '{"error":{"message":"Insufficient credits"}}', "auth_invalid", "invalid", 502],
  [500, '{"error":{"message":"Insufficient credits"}}', "upstream_error", "degraded", 502],
  [503, "{}", "upstream_error", "degraded", 502],
  [400, '{"error":{"message":"Insufficient credits"}}', "reachable", "degraded", 400],
  [null, "", "upstream_error", "degraded", 502],
] as const) {
  test(`systemone records upstream ${status ?? "transport failure"} health for ${upstreamBody}`, async () => {
    const kv = new CountingKv();
    setKvForTest(kv as unknown as Kv);
    resetProviderHealthThrottleForTest();
    let fetchCalls = 0;
    try {
      const response = await handleSystemOne(request({ state, questions }), undefined, {
        fetcher: (input) => {
          assert.equal(urlOf(input), OPENROUTER_SYSTEMONE_URL);
          fetchCalls += 1;
          if (status === null) return Promise.reject(new Error("connect timeout"));
          return Promise.resolve(new Response(upstreamBody, { status }));
        },
        apiKey: () => "or-test-key",
      });
      assert.equal(fetchCalls, 1);
      assert.equal(response.status, clientStatus);
      assert.deepEqual(await response.json(), {
        error: {
          message: status === null ? "System One upstream unreachable" : "System One upstream error",
          type: "invalid_request_error",
          code: status === null ? "openrouter_upstream_unreachable" : "openrouter_upstream_error",
        },
      });
      // Health is intentionally recorded without delaying the response. Let
      // its pending KV writes settle before reading or replacing the fixture.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const health = await getOpenRouterProviderHealth();
      assert.equal(health.last_event, expectedEvent);
      assert.equal(health.last_status, status);
      assert.equal(health.state, expectedState);
      assert.equal(health.last_429_at_ms !== null, expectedState === "exhausted");
    } finally {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      setKvForTest(null);
      resetProviderHealthThrottleForTest();
    }
  });
}
