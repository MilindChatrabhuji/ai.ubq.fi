import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test, beforeEach, afterEach } from "bun:test";
import type { Kv } from "#kv";
import { installHarness, cleanupHarness } from "./helpers/kv-budget-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// kv-budget suite part: tests moved out of tests/kv-budget.test.ts.

import assert from "node:assert/strict";
import {
  API_KEY_USAGE_V3_REQUEST_PREFIX,
  DEFAULT_KERNEL_POLICY_LIMIT_KEY,
  KERNEL_QUOTA_RESERVATION_LEASE_MS,
  MODEL,
  PASSKEY_RELAY_COOKIE_NAME,
  RUNTIME_CONFIG_V2_KEY,
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
  authenticateAdmin,
  authenticateClient,
  authoritativeCodexQuotaResponse,
  codexAuthPool,
  completedSseEvent,
  encodeBase64Url,
  encodeJsonBase64Url,
  encodeKey,
  getCodexProviderHealth,
  handler,
  kernelOrgReservationKey,
  kernelOrgWindowKey,
  kernelRepoPolicyKey,
  kv,
  makeApiKeyUsageWindowV3,
  passkeySessionKey,
  passkeyUserKey,
  prepareApiKeyInference,
  request,
  reserveApiKeyUsageV3,
  reserveEffectiveKernelUsageLimit,
  reserveKernelOrgUsageLimit,
  resetApiKeyPolicyCacheForTest,
  resetCodexAuthCacheForTest,
  resetProviderHealthThrottleForTest,
  resetRuntimeConfigCacheForTest,
  runtime,
  seedKernelDefaultLimit,
  seedKernelTestPublicKey,
  seedKey,
  seedPaidFallbackKey,
  semanticSseEvent,
  sha256Base64Url,
  sse,
  streamingRequest,
  textEncoder,
  toPublicKeyPem,
  usageWindow,
  validStreamingSse,
  waitFor,
  withKernelTestToken,
} from "./helpers/kv-budget-harness.ts";

test("GitHub quota lookup failures do not fall back to relay passkey cookies", async () => {
  kv.values.clear();
  kv.resetCounts();
  await seedKernelTestPublicKey();
  const now = Date.now();
  const owner = "relay-fallback-org";
  const repo = "relay-fallback-repo";
  const relayGitHubFixture = "ghp_relay_fallback_quota_1234567890abcdefghijklmnopqrstuvwxyz";
  const passkeyToken = "uos_ai_session_quota_failure_fallback";
  const passkeyUser = {
    id: "quota-failure-passkey-user",
    handle: "quota-failure-passkey-user",
    is_admin: true,
    credential_ids: ["quota-failure-credential"],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kv.values.set(encodeKey(passkeyUserKey(passkeyUser.id)), passkeyUser);
  kv.values.set(encodeKey(passkeySessionKey(passkeyToken)), {
    token: passkeyToken,
    user_id: passkeyUser.id,
    created_at_ms: now,
    expires_at_ms: now + 60_000,
  });

  const request = () =>
    withKernelTestToken(
      new Request("https://ai.ubq.fi/uos/auth", {
        headers: {
          Authorization: `Bearer ${relayGitHubFixture}`,
          Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${passkeyToken}`,
          "X-GitHub-Owner": owner,
          "X-GitHub-Repo": repo,
        },
      }),
      relayGitHubFixture,
      owner,
      repo
    );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.resolve(new Response(null, { status: 200 })));
  try {
    const initial = await authenticateClient(await request());
    assert.equal(initial.ok, true);
    {
      assert.equal(initial.method.kind, "github_token");
    }

    kv.failKernelQuotaReads = true;
    const unavailable = await authenticateClient(await request());
    assert.equal(unavailable.ok, false);
    {
      assert.equal(unavailable.response.status, 503);
    }
  } finally {
    kv.failKernelQuotaReads = false;
    globalThis.fetch = originalFetch;
  }
});

test("GitHub HTTP verification failures do not fall back to relay passkey cookies", async () => {
  kv.values.clear();
  kv.resetCounts();
  await seedKernelTestPublicKey();
  const now = Date.now();
  const owner = "relay-http-fallback-org";
  const repo = "relay-http-fallback-repo";
  const passkeyToken = "uos_ai_session_github_http_failure_fallback";
  const passkeyUser = {
    id: "github-http-failure-passkey-user",
    handle: "github-http-failure-passkey-user",
    is_admin: true,
    credential_ids: ["github-http-failure-credential"],
    created_at_ms: now,
    updated_at_ms: now,
  };
  kv.values.set(encodeKey(passkeyUserKey(passkeyUser.id)), passkeyUser);
  kv.values.set(encodeKey(passkeySessionKey(passkeyToken)), {
    token: passkeyToken,
    user_id: passkeyUser.id,
    created_at_ms: now,
    expires_at_ms: now + 60_000,
  });

  let githubResponse = new Response(null, { status: 401 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.resolve(githubResponse));
  try {
    const request = async (suffix: string) => {
      const relayGitHubFixture = `ghp_relay_http_${suffix}_1234567890abcdefghijklmnopqrstuvwxyz`;
      return await withKernelTestToken(
        new Request("https://ai.ubq.fi/uos/auth", {
          headers: {
            Authorization: `Bearer ${relayGitHubFixture}`,
            Cookie: `${PASSKEY_RELAY_COOKIE_NAME}=${passkeyToken}`,
            "X-GitHub-Owner": owner,
            "X-GitHub-Repo": repo,
          },
        }),
        relayGitHubFixture,
        owner,
        repo
      );
    };

    const rejected = await authenticateClient(await request("rejected"));
    assert.equal(rejected.ok, true);
    {
      assert.equal(rejected.method.kind, "passkey_session");
    }

    const adminRejected = await authenticateAdmin(await request("admin_rejected"));
    assert.equal(adminRejected.ok, true);
    {
      assert.equal(adminRejected.method.kind, "passkey_session");
    }

    githubResponse = new Response(null, { status: 200 });
    kv.resetCounts();
    const adminValidRequest = await request("admin_valid");
    const adminValid = await authenticateAdmin(adminValidRequest);
    assert.equal(adminValid.ok, false);
    {
      assert.equal(adminValid.response.status, 401);
    }
    assert.equal(
      kv.readKeys.some((key) => key[0] === "uos_ai" && key[1] === "kernel_quota" && key[2] === "v2"),
      false,
      "Admin bearer validation must not read kernel quota policy"
    );
    assert.equal(
      kv.writeKeys.some((key) => encodeKey(key) === encodeKey(["uos_ai", "kernel_policy_queue"])),
      false,
      "Admin bearer validation must not enqueue kernel policy work"
    );

    githubResponse = new Response(null, { status: 503 });
    const uncachedClient = await authenticateClient(await request("admin_valid"));
    assert.equal(uncachedClient.ok, false);
    {
      assert.equal(uncachedClient.response.status, 502);
    }

    const unavailableResponses = [
      new Response(null, { status: 408 }),
      new Response(null, { status: 429 }),
      new Response(null, { status: 403 }),
      new Response(null, { status: 500 }),
      new Response(null, { status: 502 }),
      new Response(null, { status: 503 }),
      new Response(null, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    ];
    for (const [index, response] of unavailableResponses.entries()) {
      githubResponse = response;
      const unavailable = await authenticateClient(await request(`unavailable_${index}`));
      assert.equal(unavailable.ok, false, `GitHub status ${response.status}`);
      {
        assert.equal(unavailable.response.status, 502, `GitHub status ${response.status}`);
      }

      const adminUnavailable = await authenticateAdmin(await request(`admin_unavailable_${index}`));
      assert.equal(adminUnavailable.ok, false, `Admin GitHub status ${response.status}`);
      {
        assert.equal(adminUnavailable.response.status, 502, `Admin GitHub status ${response.status}`);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V3 dispatch ledger commits unlimited API-key requests exactly once", async () => {
  const { token, policy } = await prepareApiKeyInference("1", "unlimited", -1);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.resolve(sse()));
  try {
    assert.equal((await handler(request(token))).status, 200);
    assert.equal((await handler(request(token))).status, 200);
    assert.deepEqual(usageWindow(policy), {
      committed_requests: 2,
      reserved_requests: 0,
      window_reset_at_ms: policy.usage_reset_at_ms,
    });
    assert.equal(
      [...kv.values.keys()].some((key) => key.includes('"api_key_usage","v2"')),
      false,
      "runtime inference must not write V2 counters"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V3 unlimited concurrent reservations avoid local CAS exhaustion and lease scans", async () => {
  const { policy } = await prepareApiKeyInference("9", "unlimited-concurrent", -1);
  const concurrency = 100;
  kv.resetCounts();

  const admissions = await Promise.all(
    Array.from({ length: concurrency }, (_, index) =>
      reserveApiKeyUsageV3(policy, `unlimited-concurrent-${index}`, "responses", {
        kv: kv as unknown as Kv,
      })
    )
  );
  const reservations = admissions.map((admission) => {
    if (!admission.ok) throw new Error(`unexpected quota admission status ${admission.response.status}`);
    return admission.reservation;
  });
  assert.equal(reservations.length, concurrency);

  await Promise.all(reservations.map((reservation) => reservation.beforeProviderDispatch("metered")));

  assert.deepEqual(usageWindow(policy), {
    committed_requests: concurrency,
    reserved_requests: 0,
    window_reset_at_ms: policy.usage_reset_at_ms,
  });
  assert.equal(kv.listCalls, 0, "unlimited admission must not eagerly scan reservation leases");
});

test("V3 reservations release validation failures before any provider dispatch", async () => {
  const { token, policy } = await prepareApiKeyInference("2", "release-before-dispatch", 1);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    return Promise.resolve(sse());
  });
  try {
    const invalid = new Request("https://ai.ubq.fi/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: 42 }),
    });
    assert.equal((await handler(invalid)).status, 400);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(usageWindow(policy), {
      committed_requests: 0,
      reserved_requests: 0,
      window_reset_at_ms: policy.usage_reset_at_ms,
    });
    const released = [...kv.values.entries()].find(([key]) => key.includes(JSON.stringify(API_KEY_USAGE_V3_REQUEST_PREFIX).slice(1, -1)))?.[1] as
      { state?: string; release_reason?: string } | undefined;
    assert.equal(released?.state, "released");
    assert.equal(released.release_reason, "route_completed_without_provider_dispatch");

    assert.equal((await handler(request(token))).status, 200);
    assert.equal(fetchCalls, 1);
    assert.equal(usageWindow(policy).committed_requests, 1);
    assert.equal(usageWindow(policy).reserved_requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V3 dispatch is idempotent across retries and remains consumed after provider failure", async () => {
  const { policy } = await prepareApiKeyInference("a", "dispatch-once", 2);
  const admission = await reserveApiKeyUsageV3(policy, "request-dispatch-once", "responses", {
    kv: kv as unknown as Kv,
  });
  assert.equal(admission.ok, true);

  await admission.reservation.beforeProviderDispatch("chatgpt_codex");
  await admission.reservation.beforeProviderDispatch("metered");
  await admission.reservation.release("provider_http_failure");

  assert.deepEqual(usageWindow(policy), {
    committed_requests: 1,
    reserved_requests: 0,
    window_reset_at_ms: policy.usage_reset_at_ms,
  });
  const requestRecord = kv.values.get(encodeKey(apiKeyUsageV3RequestKey(policy, "request-dispatch-once"))) as
    { state?: string; provider?: string; dispatched_at_ms?: number | null } | undefined;
  assert.equal(requestRecord?.state, "dispatched");
  assert.equal(requestRecord.provider, "chatgpt_codex");
  assert.equal(typeof requestRecord.dispatched_at_ms, "number");
});

test("V3 cancellation during the Codex dispatch commit releases quota before fetch", async () => {
  const { token, policy } = await prepareApiKeyInference("e", "dispatch-cancelled", 1);
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const logs: unknown[][] = [];
  let fetchCalls = 0;
  let releaseDispatchCommit = () => {};
  const dispatchCommitGate = new Promise<void>((resolve) => {
    releaseDispatchCommit = resolve;
  });
  let dispatchCommitStarted = () => {};
  const dispatchCommitStartedPromise = new Promise<void>((resolve) => {
    dispatchCommitStarted = resolve;
  });
  kv.apiKeyV3DispatchCommitGate = dispatchCommitGate;
  kv.onApiKeyV3DispatchCommit = dispatchCommitStarted;
  const controller = new AbortController();
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    return Promise.resolve(sse());
  });
  console.info = (...args: unknown[]) => logs.push(args);
  try {
    const pending = handler(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: "cancel before transport" }),
        signal: controller.signal,
      })
    );
    await dispatchCommitStartedPromise;
    controller.abort(new DOMException("cancelled", "AbortError"));
    releaseDispatchCommit();
    const response = await pending;

    assert.equal(response.status, 499);
    assert.equal(fetchCalls, 0);
    const terminalLogs = logs.filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal");
    assert.equal(terminalLogs.length, 1);
    const terminal = JSON.parse(String(terminalLogs[0]?.[1])) as Record<string, unknown>;
    assert.equal(terminal.status, 499);
    assert.equal(terminal.stream_terminal_type, "cancelled");
    assert.equal(terminal.delivery_outcome, "unobserved");
    assert.deepEqual(usageWindow(policy), {
      committed_requests: 0,
      reserved_requests: 0,
      window_reset_at_ms: policy.usage_reset_at_ms,
    });
  } finally {
    releaseDispatchCommit();
    kv.apiKeyV3DispatchCommitGate = null;
    kv.onApiKeyV3DispatchCommit = null;
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
  }
});

test("V3 admission reclaims expired reservations and preserves dispatch identity", async () => {
  const { policy } = await prepareApiKeyInference("c", "expired-lease", 1);
  const expiredRequestId = "expired-request";
  const nowMs = Date.now();
  kv.values.set(encodeKey(apiKeyUsageV3WindowKey(policy)), { ...makeApiKeyUsageWindowV3(policy, nowMs), reserved_requests: 1 });
  kv.values.set(encodeKey(apiKeyUsageV3RequestKey(policy, expiredRequestId)), {
    v: 3,
    key_id: policy.key_id,
    request_id: expiredRequestId,
    route: "responses",
    state: "reserved",
    reserved_at_ms: nowMs - 10_000,
    lease_expires_at_ms: nowMs - 1,
    provider: null,
    dispatched_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  });

  const admission = await reserveApiKeyUsageV3(policy, "replacement-request", "responses", {
    kv: kv as unknown as Kv,
    nowMs,
  });
  assert.equal(admission.ok, true);

  const expired = kv.values.get(encodeKey(apiKeyUsageV3RequestKey(policy, expiredRequestId))) as { state?: string; release_reason?: string } | undefined;
  assert.equal(expired?.state, "released");
  assert.equal(expired.release_reason, "lease_expired");
  assert.equal(usageWindow(policy).reserved_requests, 1);

  await admission.reservation.release();
  assert.equal(usageWindow(policy).reserved_requests, 0);
  assert.equal(usageWindow(policy).committed_requests, 0);
});

test("V3 dispatch CAS failure prevents a provider fetch and exhausted quota does not block models", async () => {
  const { token, policy } = await prepareApiKeyInference("d", "dispatch-cas", 1);
  const originalFetch = globalThis.fetch;
  // A models request may legitimately discover paid catalogs even for a
  // quota-exhausted key, so count inference transports separately from the
  // recognized OpenLux/Surplus catalog lookups instead of counting every fetch.
  const recognizedCatalogUrls = ["https://api.openlux.ai/v1/models", "https://api.surplusintelligence.ai/v1/models"];
  let fetchCalls = 0;
  let inferenceTransports = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    fetchCalls += 1;
    const url = new Request(input).url;
    if (recognizedCatalogUrls.includes(url)) return Promise.resolve(Response.json({ data: [] }));
    inferenceTransports += 1;
    return Promise.resolve(new Response(`unexpected inference transport ${url}`, { status: 500 }));
  });
  try {
    // Reservation retries five conflicts, then fails closed before openai.ts
    // can call the configured provider transport.
    kv.failNextCommits = 5;
    const unavailable = await handler(request(token));
    assert.equal(unavailable.status, 503);
    assert.equal(fetchCalls, 0);
    assert.equal(inferenceTransports, 0);

    kv.failNextCommits = 0;
    kv.values.set(encodeKey(apiKeyUsageV3WindowKey(policy)), { ...makeApiKeyUsageWindowV3(policy), committed_requests: 1 });
    const models = await handler(
      new Request("https://ai.ubq.fi/v1/models", {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    assert.equal(models.status, 200);
    assert.equal(inferenceTransports, 0, "an exhausted quota must not dispatch an inference transport for /v1/models");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming V3 quota is committed at dispatch, including premature and cancelled streams", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const prepare = async (tokenDigit: string, keyId: string) => {
    kv.values.clear();
    resetApiKeyPolicyCacheForTest();
    resetRuntimeConfigCacheForTest();
    resetCodexAuthCacheForTest();
    kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
    kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool());
    const token = `u_${tokenDigit.repeat(64)}`;
    const { hash, record } = await seedKey(token, keyId, 100);
    const policy = apiKeyPolicyFromHashRecord(hash, record, Date.now());
    assert.ok(policy);
    return { token, policy };
  };

  try {
    for (const [route, tokenDigit] of [
      ["responses", "a"],
      ["chat", "b"],
    ] as const) {
      const { token, policy } = await prepare(tokenDigit, `stream-completed-${route}`);
      const upstream = { controller: null as ReadableStreamDefaultController<Uint8Array> | null };
      globalThis.fetch = createFetchMock(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                upstream.controller = controller;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: route } })}\n\n`));
                controller.enqueue(encoder.encode(semanticSseEvent()));
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          )
        )
      );

      const response = await handler(streamingRequest(token, route));
      assert.equal(response.status, 200);
      assert.equal(usageWindow(policy).committed_requests, 1, `${route} did not commit at provider dispatch`);
      assert.ok(response.body, `${route} streaming response must expose a body`);
      const reader = response.body.getReader();
      if (route === "responses") {
        const created = await reader.read();
        assert.equal(created.done, false);
        assert.equal(usageWindow(policy).committed_requests, 1, "Responses committed more than once");
      }

      const completedChunk = reader.read();
      const upstreamController = upstream.controller;
      assert.ok(upstreamController, `${route} upstream stream controller must be captured`);
      upstreamController.enqueue(encoder.encode(completedSseEvent(3, 4)));
      upstreamController.enqueue(encoder.encode(completedSseEvent(5, 6)));
      upstreamController.close();
      assert.equal((await completedChunk).done, false);
      while (!(await reader.read()).done) {
        // Drain any trailing [DONE] or duplicate upstream completion chunks.
      }
      assert.equal(usageWindow(policy).committed_requests, 1, `${route} counted one response more than once`);
      assert.equal(usageWindow(policy).reserved_requests, 0);
    }

    for (const [route, tokenDigit] of [
      ["responses", "c"],
      ["chat", "d"],
    ] as const) {
      const { token, policy } = await prepare(tokenDigit, `stream-truncated-${route}`);
      globalThis.fetch = createFetchMock(() =>
        Promise.resolve(
          new Response(`data: ${JSON.stringify({ type: "response.created", response: { id: route } })}\n\n${semanticSseEvent()}`, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        )
      );
      const response = await handler(streamingRequest(token, route));
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(usageWindow(policy).committed_requests, 1, `${route} did not count a dispatched truncated stream`);
      assert.equal(usageWindow(policy).reserved_requests, 0);
    }

    for (const [route, tokenDigit] of [
      ["responses", "e"],
      ["chat", "f"],
    ] as const) {
      const { token, policy } = await prepare(tokenDigit, `stream-cancelled-${route}`);
      const upstream = { controller: null as ReadableStreamDefaultController<Uint8Array> | null };
      globalThis.fetch = createFetchMock(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                upstream.controller = controller;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: route } })}\n\n`));
                controller.enqueue(encoder.encode(semanticSseEvent()));
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          )
        )
      );
      const response = await handler(streamingRequest(token, route));
      assert.equal(response.status, 200);
      assert.ok(response.body, `${route} cancelled response must expose a body`);
      if (route === "responses") {
        const reader = response.body.getReader();
        assert.equal((await reader.read()).done, false);
        await reader.cancel("test cancelled before completion");
      } else {
        await response.body.cancel("test cancelled before completion");
      }
      try {
        upstream.controller?.close();
      } catch {
        // Cancellation may already have closed the upstream source.
      }
      assert.equal(usageWindow(policy).committed_requests, 1, `${route} did not count a dispatched cancelled stream`);
      assert.equal(usageWindow(policy).reserved_requests, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex terminal health distinguishes completion, post-header failure, and cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const currentHealthKey = encodeKey(["uos_ai", "provider_health", "v1", "codex", "acct-1", "current"]);
  const currentHealth = () => kv.values.get(currentHealthKey) as { event?: string; status?: number | null; provider_request_id?: string | null } | undefined;
  const waitForHealth = async (event: string, providerRequestId: string) => {
    await waitFor(
      () => currentHealth()?.event === event && currentHealth()?.provider_request_id === providerRequestId,
      `${event} health for ${providerRequestId}`
    );
    return await getCodexProviderHealth("acct-1");
  };

  try {
    for (const [route, tokenDigit] of [
      ["responses", "2"],
      ["chat", "3"],
    ] as const) {
      const { token } = await prepareApiKeyInference(tokenDigit, `terminal-health-${route}`, 20);
      resetProviderHealthThrottleForTest();

      const firstSuccessId = `${route}-success-1`;
      globalThis.fetch = createFetchMock(() =>
        Promise.resolve(
          new Response(`${route === "chat" ? semanticSseEvent() : ""}${completedSseEvent()}`, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "X-Request-Id": firstSuccessId },
          })
        )
      );
      const firstSuccess = await handler(streamingRequest(token, route));
      assert.equal(firstSuccess.status, 200);
      await firstSuccess.text();
      const healthy = await waitForHealth("success", firstSuccessId);
      assert.equal(healthy.state, "healthy");
      assert.equal(healthy.last_status, 200);

      const failureId = `${route}-post-header-failure`;
      globalThis.fetch = createFetchMock(() =>
        Promise.resolve(
          new Response(`data: ${JSON.stringify({ type: "response.created", response: { id: failureId } })}\n\n${semanticSseEvent()}`, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "X-Request-Id": failureId },
          })
        )
      );
      const failed = await handler(streamingRequest(token, route));
      assert.equal(failed.status, 200);
      await failed.text();
      const degraded = await waitForHealth("upstream_error", failureId);
      assert.equal(degraded.state, "degraded");
      assert.equal(degraded.last_status, 200);

      const recoveredId = `${route}-success-2`;
      globalThis.fetch = createFetchMock(() =>
        Promise.resolve(
          new Response(`${route === "chat" ? semanticSseEvent() : ""}${completedSseEvent()}`, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "X-Request-Id": recoveredId },
          })
        )
      );
      const recoveredResponse = await handler(streamingRequest(token, route));
      assert.equal(recoveredResponse.status, 200);
      await recoveredResponse.text();
      const recovered = await waitForHealth("success", recoveredId);
      assert.equal(recovered.state, "healthy");

      const terminalFailureId = `${route}-response-failed`;
      globalThis.fetch = createFetchMock(() =>
        Promise.resolve(
          new Response(
            `data: ${JSON.stringify({
              type: "response.failed",
              response: { id: terminalFailureId, error: { code: "fixture_failure" } },
            })}\n\n`,
            {
              status: 200,
              headers: { "Content-Type": "text/event-stream", "X-Request-Id": terminalFailureId },
            }
          )
        )
      );
      const terminalFailure = await handler(streamingRequest(token, route));
      await terminalFailure.text();
      const failedTerminalHealth = await waitForHealth("upstream_error", terminalFailureId);
      assert.equal(failedTerminalHealth.state, "degraded");

      const finalRecoveryId = `${route}-success-3`;
      globalThis.fetch = createFetchMock(() =>
        Promise.resolve(
          new Response(`${route === "chat" ? semanticSseEvent() : ""}${completedSseEvent()}`, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "X-Request-Id": finalRecoveryId },
          })
        )
      );
      const finalRecoveryResponse = await handler(streamingRequest(token, route));
      assert.equal(finalRecoveryResponse.status, 200);
      await finalRecoveryResponse.text();
      const finalRecovery = await waitForHealth("success", finalRecoveryId);
      assert.equal(finalRecovery.state, "healthy");

      let lastHealthyId = finalRecoveryId;
      for (const malformedTerminal of ["response.completed", "response.failed"] as const) {
        const malformedId = `${route}-${malformedTerminal}-array`;
        globalThis.fetch = createFetchMock(() =>
          Promise.resolve(
            new Response(`data: ${JSON.stringify({ type: malformedTerminal, response: [] })}\n\n`, {
              status: 200,
              headers: { "Content-Type": "text/event-stream", "X-Request-Id": malformedId },
            })
          )
        );
        const malformed = await handler(streamingRequest(token, route));
        assert.equal(malformed.status, 502);
        await malformed.text();
        const malformedHealth = await waitForHealth("upstream_error", malformedId);
        assert.equal(malformedHealth.state, "degraded");

        lastHealthyId = `${malformedId}-recovered`;
        globalThis.fetch = createFetchMock(() =>
          Promise.resolve(
            new Response(`${route === "chat" ? semanticSseEvent() : ""}${completedSseEvent()}`, {
              status: 200,
              headers: { "Content-Type": "text/event-stream", "X-Request-Id": lastHealthyId },
            })
          )
        );
        const malformedRecovery = await handler(streamingRequest(token, route));
        assert.equal(malformedRecovery.status, 200);
        await malformedRecovery.text();
        const malformedRecoveredHealth = await waitForHealth("success", lastHealthyId);
        assert.equal(malformedRecoveredHealth.state, "healthy");
      }

      const incompleteId = `${route}-incomplete`;
      globalThis.fetch = createFetchMock(() =>
        Promise.resolve(
          new Response(`data: ${JSON.stringify({ type: "response.incomplete", response: { id: incompleteId } })}\n\n`, {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "X-Request-Id": incompleteId },
          })
        )
      );
      const incomplete = await handler(streamingRequest(token, route));
      await incomplete.text();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const afterIncomplete = await getCodexProviderHealth("acct-1");
      assert.equal(afterIncomplete.state, "healthy");
      assert.equal(afterIncomplete.last_event, "success");
      assert.equal(afterIncomplete.last_provider_request_id, lastHealthyId);

      let upstreamCancelled = 0;
      const cancelledRequestId = `${route}-cancelled`;
      globalThis.fetch = createFetchMock(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: cancelledRequestId } })}\n\n`));
                controller.enqueue(textEncoder.encode(semanticSseEvent()));
              },
              cancel() {
                upstreamCancelled += 1;
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "text/event-stream", "X-Request-Id": cancelledRequestId },
            }
          )
        )
      );
      const cancelled = await handler(streamingRequest(token, route));
      assert.equal(cancelled.status, 200);
      assert.ok(cancelled.body, `${route} cancelled response must expose a body`);
      if (route === "responses") {
        const reader = cancelled.body.getReader();
        assert.equal((await reader.read()).done, false);
        await reader.cancel("client cancelled");
      } else {
        await cancelled.body.cancel("client cancelled");
      }
      await waitFor(() => upstreamCancelled === 1, `${route} upstream cancellation`);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const afterCancellation = await getCodexProviderHealth("acct-1");
      assert.equal(afterCancellation.state, "healthy");
      assert.equal(afterCancellation.last_event, "success");
      assert.equal(afterCancellation.last_provider_request_id, lastHealthyId);
    }
  } finally {
    globalThis.fetch = originalFetch;
    resetProviderHealthThrottleForTest();
    resetCodexAuthCacheForTest();
  }
});

test("provider dispatch commits API-key V3 while kernel completion writes only the split window", async () => {
  const { token, policy } = await prepareApiKeyInference("0", "stream-kernel-and-key", 100);

  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  kv.values.set(encodeKey(["uos_ai", "kernel_pubkeys"]), [{ pem: toPublicKeyPem(publicKey) }]);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = encodeJsonBase64Url({ alg: "RS256", typ: "JWT" });
  const makeKernelToken = async (): Promise<string> => {
    const payload = encodeJsonBase64Url({
      iss: "ubiquity-os-kernel",
      aud: "ai.ubq.fi",
      iat: nowSeconds,
      exp: nowSeconds + 600,
      jti: `jti_${crypto.randomUUID()}`,
      owner: "lifecycle-org",
      repo: "lifecycle-repo",
      installation_id: null,
      auth_token_sha256: await sha256Base64Url(token),
      state_id: "state_lifecycle",
    });
    const signingInput = `${header}.${payload}`;
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, textEncoder.encode(signingInput)));
    return `${signingInput}.${encodeBase64Url(signature)}`;
  };
  const kernelToken = await makeKernelToken();

  const upstream = { controller: null as ReadableStreamDefaultController<Uint8Array> | null };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream.controller = controller;
            controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "kernel" } })}\n\n`));
            controller.enqueue(textEncoder.encode(semanticSseEvent()));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    )
  );
  try {
    const baseRequest = streamingRequest(token, "responses");
    const headers = new Headers(baseRequest.headers);
    headers.set("X-Ubiquity-Kernel-Token", kernelToken);
    const response = await handler(new Request(baseRequest, { headers }));
    assert.equal(response.status, 200);
    const orgWindowKey = kernelOrgWindowKey("lifecycle-org");
    assert.equal(usageWindow(policy).committed_requests, 1);
    const reservedKernelWindow = kv.values.get(encodeKey(orgWindowKey)) as
      | {
          usage_requests?: number;
          reserved_requests?: number;
        }
      | undefined;
    assert.equal(reservedKernelWindow?.usage_requests, 0);
    assert.equal(reservedKernelWindow.reserved_requests, 1);

    const body = response.text();
    const upstreamController = upstream.controller;
    assert.ok(upstreamController, "upstream stream controller must be captured");
    upstreamController.enqueue(textEncoder.encode(completedSseEvent(2, 3)));
    upstreamController.enqueue(textEncoder.encode(completedSseEvent(4, 5)));
    upstreamController.close();
    await body;

    assert.equal(usageWindow(policy).committed_requests, 1);
    const kernelWindow = kv.values.get(encodeKey(orgWindowKey)) as
      | {
          usage_requests?: number;
          reserved_requests?: number;
        }
      | undefined;
    assert.equal(kernelWindow?.usage_requests, 1);
    assert.equal(kernelWindow.reserved_requests, 0);

    let imageFetches = 0;
    globalThis.fetch = createFetchMock(() => {
      imageFetches += 1;
      return Promise.resolve(
        new Response(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              model: MODEL,
              created_at: 1787431659,
              output: [
                {
                  type: "image_generation_call",
                  status: "completed",
                  result: "SU1BR0U=",
                },
              ],
              usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
            },
          })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
      );
    });
    const pendingImageResponse = handler(
      new Request("https://ai.ubq.fi/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Ubiquity-Kernel-Token": kernelToken,
        },
        body: JSON.stringify({ prompt: "five telemetry regression images", n: 5, user: "kernel-image-user" }),
      })
    );
    const imageResponse = await pendingImageResponse;
    assert.equal(imageResponse.status, 200);
    assert.deepEqual((await imageResponse.json()).data, [
      { b64_json: "SU1BR0U=" },
      { b64_json: "SU1BR0U=" },
      { b64_json: "SU1BR0U=" },
      { b64_json: "SU1BR0U=" },
      { b64_json: "SU1BR0U=" },
    ]);
    assert.equal(imageResponse.headers.get("x-uos-warning"), "user_ignored");
    assert.equal(imageFetches, 5);
    assert.equal(usageWindow(policy).committed_requests, 2);
    const kernelWindowAfterImage = kv.values.get(encodeKey(orgWindowKey)) as
      | {
          usage_requests?: number;
          reserved_requests?: number;
        }
      | undefined;
    assert.equal(kernelWindowAfterImage?.usage_requests, 2);
    assert.equal(kernelWindowAfterImage.reserved_requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kernel quota reserves one concurrent limit-one request and commits only its semantic completion", async () => {
  const { token } = await prepareApiKeyInference("1", "kernel-concurrent-limit-one", 100);
  await seedKernelTestPublicKey();
  seedKernelDefaultLimit(1);
  const owner = "kernel-concurrency-org";
  const repo = "kernel-concurrency-repo";
  const upstream = { controller: null as ReadableStreamDefaultController<Uint8Array> | null };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream.controller = controller;
            controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "kernel-concurrent" } })}\n\n`));
            controller.enqueue(textEncoder.encode(semanticSseEvent()));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );
  });
  try {
    const requests = await Promise.all(Array.from({ length: 8 }, () => withKernelTestToken(streamingRequest(token, "responses"), token, owner, repo)));
    const responses = await Promise.all(requests.map((request) => handler(request)));
    assert.equal(fetchCalls, 1);
    assert.deepEqual(
      responses.map((response) => response.status).sort((left, right) => left - right),
      [200, 429, 429, 429, 429, 429, 429, 429]
    );
    const windowKey = kernelOrgWindowKey(owner);
    const reserved = kv.values.get(encodeKey(windowKey)) as {
      usage_requests?: number;
      reserved_requests?: number;
    };
    assert.equal(reserved.usage_requests, 0);
    assert.equal(reserved.reserved_requests, 1);

    const admitted = responses.find((response) => response.status === 200);
    assert.ok(admitted);
    const body = admitted.text();
    const upstreamController = upstream.controller;
    assert.ok(upstreamController, "upstream stream controller must be captured");
    upstreamController.enqueue(textEncoder.encode(completedSseEvent()));
    upstreamController.close();
    await body;
    await waitFor(() => {
      const window = kv.values.get(encodeKey(windowKey)) as
        | {
            usage_requests?: number;
            reserved_requests?: number;
          }
        | undefined;
      return window?.usage_requests === 1 && window.reserved_requests === 0;
    }, "Kernel semantic completion commit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kernel quota reconstructs reservations after an older writer erases the aggregate field", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(2);
  const owner = "kernel-mixed-revision-org";
  const first = await reserveKernelOrgUsageLimit(owner, "mixed-revision-first", "responses", {
    kv: kv as unknown as Kv,
  });
  assert.equal(first.ok, true);

  const windowKey = kernelOrgWindowKey(owner);
  const reservedWindow = kv.values.get(encodeKey(windowKey)) as Record<string, unknown>;
  assert.equal(reservedWindow.reserved_requests, 1);

  // The older writer must not carry the aggregate reservation field forward; an
  // unused destructuring target for it is rejected by sonarjs/no-unused-vars, so
  // the copy is built and the field erased explicitly.
  const olderWriterWindow: Record<string, unknown> = { ...reservedWindow };
  delete olderWriterWindow.reserved_requests;
  kv.values.set(encodeKey(windowKey), {
    ...olderWriterWindow,
    usage_requests: 1,
    updated_at_ms: Date.now(),
  });

  const blocked = await reserveKernelOrgUsageLimit(owner, "mixed-revision-second", "responses", {
    kv: kv as unknown as Kv,
  });
  assert.equal(blocked.ok, false);
  {
    assert.equal(blocked.response.status, 429);
  }

  await first.reservation.release("mixed_revision_test_complete");
  const repairedWindow = kv.values.get(encodeKey(windowKey)) as {
    usage_requests?: number;
    reserved_requests?: number;
  };
  assert.equal(repairedWindow.usage_requests, 1);
  assert.equal(repairedWindow.reserved_requests, 0);
});

test("Kernel quota releases a cancelled stream before admitting its replacement", async () => {
  const { token } = await prepareApiKeyInference("2", "kernel-cancel-release", 100);
  await seedKernelTestPublicKey();
  seedKernelDefaultLimit(1);
  const owner = "kernel-cancel-org";
  const repo = "kernel-cancel-repo";
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let upstreamCancelled = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    if (fetchCalls > 1) return Promise.resolve(validStreamingSse());
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "kernel-cancel" } })}\n\n`));
            controller.enqueue(textEncoder.encode(semanticSseEvent()));
          },
          cancel() {
            upstreamCancelled += 1;
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );
  });
  try {
    const first = await handler(await withKernelTestToken(streamingRequest(token, "responses"), token, owner, repo));
    assert.equal(first.status, 200);
    assert.ok(first.body, "cancelled Kernel response must expose a body");
    await first.body.cancel("client cancelled");
    const windowKey = kernelOrgWindowKey(owner);
    await waitFor(() => {
      const window = kv.values.get(encodeKey(windowKey)) as { reserved_requests?: number } | undefined;
      return window?.reserved_requests === 0;
    }, "Kernel cancellation release");
    await waitFor(() => upstreamCancelled === 1, "Kernel upstream cancellation");

    const replacement = await handler(await withKernelTestToken(streamingRequest(token, "responses"), token, owner, repo));
    assert.equal(replacement.status, 200);
    await replacement.text();
    const committed = kv.values.get(encodeKey(windowKey)) as {
      usage_requests?: number;
      reserved_requests?: number;
    };
    assert.equal(committed.usage_requests, 1);
    assert.equal(committed.reserved_requests, 0);
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kernel quota releases validation failures and admits a later valid request", async () => {
  const { token } = await prepareApiKeyInference("3", "kernel-validation-release", 100);
  await seedKernelTestPublicKey();
  seedKernelDefaultLimit(1);
  const owner = "kernel-validation-org";
  const repo = "kernel-validation-repo";
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    return Promise.resolve(validStreamingSse());
  });
  try {
    const invalidBase = new Request("https://ai.ubq.fi/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: "ping", unsupported_kernel_test_field: true }),
    });
    const invalid = await handler(await withKernelTestToken(invalidBase, token, owner, repo));
    assert.equal(invalid.status, 400);
    assert.equal(fetchCalls, 0);
    const windowKey = kernelOrgWindowKey(owner);
    const released = kv.values.get(encodeKey(windowKey)) as {
      usage_requests?: number;
      reserved_requests?: number;
    };
    assert.equal(released.usage_requests, 0);
    assert.equal(released.reserved_requests, 0);

    const replacement = await handler(await withKernelTestToken(streamingRequest(token, "responses"), token, owner, repo));
    assert.equal(replacement.status, 200);
    await replacement.text();
    const committed = kv.values.get(encodeKey(windowKey)) as {
      usage_requests?: number;
      reserved_requests?: number;
    };
    assert.equal(committed.usage_requests, 1);
    assert.equal(committed.reserved_requests, 0);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kernel quota reclaims an expired reservation lease before admission", async () => {
  const { token } = await prepareApiKeyInference("4", "kernel-lease-recovery", 100);
  await seedKernelTestPublicKey();
  seedKernelDefaultLimit(1);
  const owner = "kernel-lease-org";
  const repo = "kernel-lease-repo";
  const nowMs = Date.now();
  const windowCreatedAtMs = nowMs - 10_000;
  const windowResetAtMs = nowMs + 60_000;
  const expiredRequestId = "expired-kernel-request";
  const windowKey = kernelOrgWindowKey(owner);
  const expiredReservationKey = kernelOrgReservationKey(owner, windowCreatedAtMs, expiredRequestId);
  kv.values.set(encodeKey(windowKey), {
    v: 2,
    scope: "org",
    owner,
    usage_requests: 0,
    reserved_requests: 1,
    usage_reset_at_ms: windowResetAtMs,
    applied_window_ms: 60_000,
    created_at_ms: windowCreatedAtMs,
    updated_at_ms: nowMs,
  });
  kv.values.set(encodeKey(expiredReservationKey), {
    v: 2,
    scope: "org",
    owner,
    request_id: expiredRequestId,
    route: "responses",
    window_created_at_ms: windowCreatedAtMs,
    window_reset_at_ms: windowResetAtMs,
    state: "reserved",
    reserved_at_ms: nowMs - 10_000,
    lease_expires_at_ms: nowMs - 1,
    committed_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => Promise.resolve(validStreamingSse()));
  try {
    const response = await handler(await withKernelTestToken(streamingRequest(token, "responses"), token, owner, repo));
    assert.equal(response.status, 200);
    await response.text();
    const expired = kv.values.get(encodeKey(expiredReservationKey)) as {
      state?: string;
      release_reason?: string;
    };
    assert.equal(expired.state, "released");
    assert.equal(expired.release_reason, "lease_expired");
    const committed = kv.values.get(encodeKey(windowKey)) as {
      usage_requests?: number;
      reserved_requests?: number;
    };
    assert.equal(committed.usage_requests, 1);
    assert.equal(committed.reserved_requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kernel quota reservation fails closed when KV is unavailable", async () => {
  const decision = await reserveKernelOrgUsageLimit("kernel-unavailable-org", "request-id", "responses", {
    kv: null,
  });
  assert.equal(decision.ok, false);

  assert.equal(decision.response.status, 503);
});

test("Kernel quota rejects malformed effective-scope policy records", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(10);
  const owner = "kernel-malformed-scope-org";
  const repo = "kernel-malformed-scope-repo";
  kv.values.set(encodeKey(kernelRepoPolicyKey(owner, repo)), {
    v: 2,
    scope: "repo",
    owner,
    repo,
    usage_limit_requests: "not-a-limit",
  });
  const decision = await reserveEffectiveKernelUsageLimit(owner, repo, "malformed-scope-request", "responses", {
    kv: kv as unknown as Kv,
  });
  assert.equal(decision.ok, false);

  assert.equal(decision.response.status, 503);
  assert.equal(kv.values.has(encodeKey(kernelOrgWindowKey(owner))), false);
});

test("Kernel quota CAS-checks repo-policy absence before org admission", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(10);
  const owner = "kernel-scope-race-org";
  const repo = "kernel-scope-race-repo";
  kv.onKernelReservationCommit = () => {
    const nowMs = Date.now();
    kv.values.set(encodeKey(kernelRepoPolicyKey(owner, repo)), {
      v: 2,
      scope: "repo",
      owner,
      repo,
      usage_limit_requests: 0,
      window_ms: 60_000,
      expires_at_ms: -1,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    });
  };
  const decision = await reserveEffectiveKernelUsageLimit(owner, repo, "scope-race-request", "responses", {
    kv: kv as unknown as Kv,
  });
  assert.equal(decision.ok, false);

  assert.equal(decision.response.status, 503);
  assert.equal(kv.values.has(encodeKey(kernelOrgWindowKey(owner))), false);
});

test("Kernel quota CAS-checks default policy entries before admission", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(10);
  const owner = "kernel-default-race-org";
  kv.onKernelReservationCommit = () => {
    kv.values.set(encodeKey(DEFAULT_KERNEL_POLICY_LIMIT_KEY), 0);
  };
  const decision = await reserveKernelOrgUsageLimit(owner, "default-race-request", "responses", {
    kv: kv as unknown as Kv,
  });
  assert.equal(decision.ok, false);

  assert.equal(decision.response.status, 429);
  assert.equal(kv.values.has(encodeKey(kernelOrgWindowKey(owner))), false);
});

test("Kernel quota renews an active reservation and aborts if renewal cannot reach KV before expiry", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(1, KERNEL_QUOTA_RESERVATION_LEASE_MS * 2);
  const owner = "kernel-renewal-org";
  const requestId = "kernel-renewal-request";
  const nowMs = Date.now() - KERNEL_QUOTA_RESERVATION_LEASE_MS + 30;
  const decision = await reserveKernelOrgUsageLimit(owner, requestId, "responses", {
    kv: kv as unknown as Kv,
    nowMs,
    renewalIntervalMs: 5,
  });
  assert.equal(decision.ok, true);

  const window = kv.values.get(encodeKey(kernelOrgWindowKey(owner))) as { created_at_ms: number };
  const reservationKey = kernelOrgReservationKey(owner, window.created_at_ms, requestId);
  const initialLease = (kv.values.get(encodeKey(reservationKey)) as { lease_expires_at_ms: number }).lease_expires_at_ms;
  await waitFor(
    () => (kv.values.get(encodeKey(reservationKey)) as { lease_expires_at_ms?: number } | undefined)?.lease_expires_at_ms !== initialLease,
    "Kernel lease renewal"
  );
  assert.equal(decision.reservation.signal.aborted, false);
  const renewedLease = (kv.values.get(encodeKey(reservationKey)) as { lease_expires_at_ms: number }).lease_expires_at_ms;
  assert.ok(renewedLease > initialLease);
  await decision.reservation.release("test_cleanup");

  const failingOwner = "kernel-renewal-failure-org";
  const failingDecision = await reserveKernelOrgUsageLimit(failingOwner, "kernel-renewal-failure-request", "responses", {
    kv: kv as unknown as Kv,
    nowMs: Date.now() - KERNEL_QUOTA_RESERVATION_LEASE_MS + 30,
    renewalIntervalMs: 5,
  });
  assert.equal(failingDecision.ok, true);

  kv.failKernelQuotaReads = true;
  await waitFor(() => failingDecision.reservation.signal.aborted, "Kernel lease renewal fail-closed abort");
  kv.failKernelQuotaReads = false;
  await failingDecision.reservation.release("test_cleanup");
});

test("Kernel quota lease expiry aborts independently while a renewal read hangs", async () => {
  kv.values.clear();
  kv.resetCounts();
  seedKernelDefaultLimit(1, KERNEL_QUOTA_RESERVATION_LEASE_MS * 2);
  const decision = await reserveKernelOrgUsageLimit("kernel-hung-renewal-org", "kernel-hung-renewal-request", "responses", {
    kv: kv as unknown as Kv,
    nowMs: Date.now() - KERNEL_QUOTA_RESERVATION_LEASE_MS + 80,
    renewalIntervalMs: 5,
  });
  assert.equal(decision.ok, true);

  let unblockRead!: () => void;
  let readUnblocked = false;
  kv.kernelQuotaReadGate = new Promise<void>((resolve) => {
    unblockRead = () => {
      readUnblocked = true;
      resolve();
    };
  });
  await waitFor(() => decision.reservation.signal.aborted, "Kernel hung-renewal lease expiry abort");
  assert.equal(readUnblocked, false, "lease expiry must not wait for the renewal read");
  kv.kernelQuotaReadGate = null;
  unblockRead();
  await decision.reservation.release("test_cleanup");
});

test("first bounded paid fallback response exposes settled spend and consumes one V3 dispatch", async () => {
  kv.values.clear();
  resetApiKeyPolicyCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetCodexAuthCacheForTest();
  kv.values.set(encodeKey(RUNTIME_CONFIG_V2_KEY), runtime);
  kv.values.set(encodeKey(["ubq_ai", "codex_auth"]), codexAuthPool(2));
  const token = `u_${"8".repeat(64)}`;
  const keyId = "first-fallback-quota";
  const { hash, record } = await seedPaidFallbackKey(token, keyId);
  const policy = apiKeyPolicyFromHashRecord(hash, record, Date.now());
  assert.ok(policy);

  const originalFetch = globalThis.fetch;
  const originalMeteredApiKey = process.env.METERED_API_KEY;
  let calls = 0;
  const primaryAccountIds: string[] = [];
  process.env.METERED_API_KEY = "metered-test-key";
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const request = new Request(input, init);
    const url = request.url;
    if (url === "https://api.openlux.ai/v1/responses") {
      const response = sse();
      const headers = new Headers(response.headers);
      headers.set("X-Oneapi-Request-Id", "first-fallback-provider-request");
      return Promise.resolve(new Response(response.body, { status: 200, headers }));
    }
    primaryAccountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(authoritativeCodexQuotaResponse());
  });
  try {
    kv.resetCounts();
    const response = await handler(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: "ping", stream: true }),
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-codex-primary-used-percent"), "0");
    assert.equal(calls, 3);
    assert.deepEqual(primaryAccountIds, ["acct-1", "acct-2"]);
    // Two authoritative Codex quota responses plus Metered still belong to one routed inference. The
    // V3 request is committed before the first transport and not incremented
    // again by retries or fallback.
    assert.equal(usageWindow(policy).committed_requests, 1);
    assert.equal(usageWindow(policy).reserved_requests, 0);
    await response.body?.cancel();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = originalMeteredApiKey;
  }
});
