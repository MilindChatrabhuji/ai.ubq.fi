import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test, beforeEach, afterEach } from "bun:test";
import { type Kv } from "#kv";
import { runSequence } from "./helpers/sequence.ts";
// codex-auth-cache suite, part 2 of 4: tests moved out of tests/codex-auth-cache.test.ts.

import assert from "node:assert/strict";
import {
  installHarness,
  cleanupHarness,
  AUTH_KEY,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
  type CodexBankedResetConfig,
  CodexError,
  abortReasonError,
  accessToken,
  auth,
  bankedResetRequestOptions,
  beginCodexCacheScopeExperiment,
  config,
  fetchCodexResponses,
  fetchCodexResponsesForCacheScopeExperiment,
  fixedStartMs,
  getCodexRoutingProbe,
  kv,
  liveBankedResetConfig,
  markCodexQuotaBlocked,
  markCodexResponseCompleted,
  markCodexUpstreamTimeout,
  parseCodexAccountRoutingState,
  pool,
  releaseCodexResponseProbe,
  requestUrl,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  resetProviderHealthThrottleForTest,
  scriptedResetProvider,
  seedStableBankedResetBlock,
  selectCodexRoutingAccounts,
  stableBankedResetRetryAfter,
  staleAuth,
} from "./helpers/codex-auth-cache-harness.ts";

test("a malformed successful refresh is transient and does not quarantine the credential", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let refreshCalls = 0;
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const url = requestUrl(input);
    if (url.includes("auth.openai.com/oauth/token")) {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ refresh_token: "refresh-one" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: accessToken("recovered"), refresh_token: "refresh-recovered" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    inferenceCalls += 1;
    return Promise.resolve(new Response("{}", { status: inferenceCalls <= 2 ? 401 : 200 }));
  });

  try {
    await assert.rejects(
      () => fetchCodexResponses({ input: "malformed-refresh" }),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 503 && error.message.includes("missing access_token")
    );
    const recovered = await fetchCodexResponses({ input: "valid-refresh" });
    assert.equal(recovered.status, 200);
    assert.equal(refreshCalls, 2);
    assert.equal(inferenceCalls, 3);
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("direct failures release quota probes and timeouts do not gate the next request", () =>
  runSequence(async (step) => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const originalDeployFlag = config.isDeploy;
    let now = fixedStartMs;
    Date.now = () => now;
    (config as { isDeploy: boolean }).isDeploy = true;
    try {
      for (const testCase of [
        { name: "403", status: 403 },
        { name: "invalid 400", status: 400 },
        { name: "500", status: 500 },
        { name: "network", status: null },
        { name: "timeout", status: null, timeout: true },
      ] as const) {
        await step(testCase.name, async () => {
          now = fixedStartMs;
          kv.auth = pool(auth("one"));
          kv.extra.clear();
          resetCodexAuthCacheForTest();
          const initial = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, now);
          assert.equal(initial.kind, "eligible");

          await markCodexQuotaBlocked(
            initial.accounts[0],
            new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
              status: 429,
              headers: { "Content-Type": "application/json", "Retry-After": "1" },
            }),
            now
          );

          now += 1_001;
          let codexCalls = 0;
          let timeoutController: AbortController | null = null;
          globalThis.fetch = createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            codexCalls += 1;
            if (codexCalls > 1) return Promise.resolve(new Response("{}", { status: 200 }));
            if (testCase.timeout) {
              const reason = new DOMException("timed out", "TimeoutError");
              timeoutController?.abort(reason);
              return Promise.reject(abortReasonError(init?.signal?.reason ?? reason));
            }
            if (testCase.status === null) return Promise.reject(new TypeError("network fixture"));
            return Promise.resolve(new Response("{}", { status: testCase.status }));
          });

          if (testCase.timeout) {
            const abortController = new AbortController();
            timeoutController = abortController;
            await assert.rejects(
              () => fetchCodexResponses({ input: testCase.name }, { signal: abortController.signal }),
              (error: unknown) => error instanceof Error && "status" in error && error.status === 504
            );
          } else if (testCase.status === null) {
            await assert.rejects(
              () => fetchCodexResponses({ input: testCase.name }),
              (error: unknown) => error instanceof Error && "status" in error && error.status === 502
            );
          } else {
            const direct = await fetchCodexResponses({ input: testCase.name });
            assert.equal(direct.status, testCase.status);
          }

          const second = await fetchCodexResponses({ input: `${testCase.name}-second` });
          if (testCase.timeout) {
            // An in-flight timeout keeps the active account and its half-open
            // lease: the next admission is retryable and never dispatches a
            // speculative sibling or a paid provider.
            assert.equal(second.status, 503);
            assert.equal(codexCalls, 1);
          } else {
            assert.equal(second.status, 200);
            assert.equal(codexCalls, 2);
          }
        });
      }
    } finally {
      resetCodexAuthCacheForTest();
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    }
  }));

test("cache-scope dispatch timeouts remain request-scoped", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const controller = new AbortController();
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  const session = await beginCodexCacheScopeExperiment();
  globalThis.fetch = createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    inferenceCalls += 1;
    controller.abort(new DOMException("cache-scope timeout", "TimeoutError"));
    return Promise.reject(abortReasonError(init?.signal?.reason ?? controller.signal.reason));
  });

  try {
    await assert.rejects(
      () =>
        fetchCodexResponsesForCacheScopeExperiment(
          { input: "cache-scope-timeout" },
          {
            session,
            slot: 1,
            conversationId: "cache-scope-timeout-conversation",
            signal: controller.signal,
          }
        ),
      (error: unknown) => error instanceof CodexError && error.code === "gateway_timeout" && error.status === 504
    );
    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(kv.auth, [kv.auth.accounts[0]], fixedStartMs);
    assert.equal(selected.kind, "eligible");

    assert.equal(selected.accounts[0]?.probeRequired, false);
    assert.equal(inferenceCalls, 1);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a legacy timeout probe cannot block provider transport", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  const initial = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, fixedStartMs);
  assert.equal(initial.kind, "eligible");

  await markCodexUpstreamTimeout(initial.accounts[0], fixedStartMs - CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS - 1);
  globalThis.fetch = createFetchMock(() => {
    inferenceCalls += 1;
    return Promise.resolve(new Response("transport proceeds", { status: 200 }));
  });

  try {
    // The normalized read discards the legacy timeout circuit, so transport
    // proceeds without any speculative sibling or paid dispatch.
    const response = await fetchCodexResponses({ input: "timeout-probe-race" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "transport proceeds");
    assert.equal(inferenceCalls, 1);

    // A durable normalization write that cannot commit fails the admission
    // retryably before any provider transport.
    resetCodexAccountRoutingForTest();
    const reseeded = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, fixedStartMs);
    assert.equal(reseeded.kind, "eligible");
    await markCodexUpstreamTimeout(reseeded.accounts[0], fixedStartMs - CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS - 1);
    resetCodexAccountRoutingForTest();
    kv.routingCommitFailures = 3;
    const blocked = await fetchCodexResponses({ input: "routing-commit-unavailable" });
    assert.equal(blocked.status, 503);
    assert.equal(inferenceCalls, 1);
    await blocked.arrayBuffer();
  } finally {
    kv.routingCommitFailures = 0;
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a bounded retry that proves quota keeps its quota retry classification", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let inferenceCalls = 0;
  let concurrentStatus: number | null = null;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  const initial = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, fixedStartMs);
  assert.equal(initial.kind, "eligible");

  await markCodexUpstreamTimeout(initial.accounts[0], fixedStartMs - CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS - 1);
  globalThis.fetch = createFetchMock(async () => {
    inferenceCalls += 1;
    if (inferenceCalls === 1) {
      return new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      });
    }
    if (inferenceCalls === 2) {
      concurrentStatus = (await fetchCodexResponses({ input: "timeout-probe-race-concurrent" })).status;
      return new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      });
    }
    return new Response("unexpected extra transport", { status: 200 });
  });

  try {
    const response = await fetchCodexResponses({ input: "timeout-probe-quota-retry" }, { retrySleep: () => Promise.resolve() });
    assert.equal(response.status, 429);
    // The concurrent admission sees the retry's half-open lease and reports the
    // same retryable quota classification instead of guessing a sibling or a
    // paid provider.
    assert.equal(concurrentStatus, 429);
    assert.equal(inferenceCalls, 2);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a timeout during bounded retry refresh preserves only the quota fence", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const controller = new AbortController();
  let inferenceCalls = 0;
  let refreshCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = requestUrl(input);
    if (url.includes("auth.openai.com/oauth/token")) {
      refreshCalls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: accessToken("one"), refresh_token: "refresh-one" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    inferenceCalls += 1;
    if (inferenceCalls === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "1" },
        })
      );
    }
    if (inferenceCalls === 2) return Promise.resolve(new Response("{}", { status: 401 }));
    controller.abort(new DOMException("bounded retry timeout", "TimeoutError"));
    return Promise.reject(abortReasonError(init?.signal?.reason ?? controller.signal.reason));
  });

  try {
    await assert.rejects(
      () =>
        fetchCodexResponses(
          { input: "bounded-retry-refresh-timeout" },
          {
            signal: controller.signal,
            retrySleep: () => Promise.resolve(),
          }
        ),
      (error: unknown) => error instanceof CodexError && error.code === "gateway_timeout" && error.status === 504
    );
    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, fixedStartMs);
    assert.equal(selected.kind, "quota_blocked");
    assert.equal(inferenceCalls, 3);
    assert.equal(refreshCalls, 1);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("an already-aborted timeout signal does not open or dispatch an account circuit", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const controller = new AbortController();
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  controller.abort(new DOMException("deadline elapsed before dispatch", "TimeoutError"));
  globalThis.fetch = createFetchMock(() => {
    inferenceCalls += 1;
    return Promise.reject(new DOMException("transport should not start", "TimeoutError"));
  });

  try {
    await assert.rejects(
      () => fetchCodexResponses({ input: "pre-dispatch-timeout" }, { signal: controller.signal }),
      (error: unknown) => error instanceof CodexError && error.code === "gateway_timeout" && error.status === 504
    );
    resetCodexAccountRoutingForTest();
    const selected = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, fixedStartMs);
    assert.equal(selected.kind, "eligible");
    assert.equal(inferenceCalls, 0);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a 429 retry that proves invalid credentials remains quarantined", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let now = fixedStartMs;
  let inferenceCalls = 0;
  let refreshCalls = 0;
  Date.now = () => now;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  const initial = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, now);
  assert.equal(initial.kind, "eligible");

  await markCodexQuotaBlocked(
    initial.accounts[0],
    new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "1" },
    }),
    now
  );
  now += 1_001;
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const url = requestUrl(input);
    if (url.includes("auth.openai.com/oauth/token")) {
      refreshCalls += 1;
      return Promise.resolve(new Response('{"error":"invalid_grant"}', { status: 401 }));
    }
    inferenceCalls += 1;
    if (inferenceCalls === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "1" },
        })
      );
    }
    return Promise.resolve(new Response("{}", { status: 401 }));
  });

  try {
    const first = await fetchCodexResponses({ input: "retry-invalid" }, { retrySleep: () => Promise.resolve() });
    assert.equal(first.status, 401);
    const second = await fetchCodexResponses({ input: "retry-invalid-again" });
    assert.equal(second.status, 401);
    assert.equal(inferenceCalls, 2);
    assert.equal(refreshCalls, 1);
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a 401 after proactive refresh does not refresh the same account twice", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let refreshCalls = 0;
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(staleAuth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const url = requestUrl(input);
    if (url.includes("auth.openai.com/oauth/token")) {
      refreshCalls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: accessToken("refreshed-once"),
            refresh_token: "refresh-refreshed-once",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    inferenceCalls += 1;
    return Promise.resolve(new Response("{}", { status: 401 }));
  });

  try {
    const response = await fetchCodexResponses({ input: "one-refresh-only" });
    assert.equal(response.status, 401);
    assert.equal(refreshCalls, 1);
    assert.equal(inferenceCalls, 1);
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("every admission strongly reads the current durable credentials", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const authorizations: string[] = [];
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    authorizations.push(request.headers.get("authorization") ?? "");
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    kv.auth = pool(auth("old"));
    kv.extra.clear();
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();

    await fetchCodexResponses({ input: "cold" });
    assert.equal(authorizations.at(-1), `Bearer ${accessToken("old")}`);
    assert.equal(accountIds.at(-1), "account-old");

    // A rotation is observed on the very next admission: there is no warm TTL
    // that could keep serving a replaced credential.
    await kv.set(AUTH_KEY, pool(auth("rotated")));
    await fetchCodexResponses({ input: "rotated" });
    assert.equal(authorizations.at(-1), `Bearer ${accessToken("rotated")}`);
    assert.equal(accountIds.at(-1), "account-rotated");

    // Concurrent admissions converge on the same durable credential.
    await Promise.all(Array.from({ length: 4 }, (_, index) => fetchCodexResponses({ input: `concurrent-${index}` })));
    assert.deepEqual(authorizations.slice(-4), Array(4).fill(`Bearer ${accessToken("rotated")}`));
    assert.deepEqual(accountIds.slice(-4), Array(4).fill("account-rotated"));

    // A pool replacement between admissions is immediate as well.
    await kv.set(AUTH_KEY, pool(auth("replacement")));
    await fetchCodexResponses({ input: "replacement" });
    assert.equal(authorizations.at(-1), `Bearer ${accessToken("replacement")}`);
    assert.equal(accountIds.at(-1), "account-replacement");
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a valid persisted Codex pool is not overlaid by a local configured seed", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const originalSeed = config.codexAuthJsonB64;
  const authorizations: string[] = [];
  const persisted = auth("persisted");
  const localSeed = { ...auth("local-stale"), account_id: persisted.account_id };
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean; codexAuthJsonB64: string }).isDeploy = false;
  (config as { isDeploy: boolean; codexAuthJsonB64: string }).codexAuthJsonB64 = btoa(
    JSON.stringify({
      tokens: {
        access_token: localSeed.access_token,
        refresh_token: localSeed.refresh_token,
        account_id: localSeed.account_id,
      },
    })
  );
  kv.auth = pool(persisted);
  kv.extra.clear();
  const versionBefore = kv.authVersion;
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    authorizations.push(request.headers.get("authorization") ?? "");
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses({ input: "persisted-authority" });
    assert.equal(response.status, 200);
    assert.deepEqual(authorizations, [`Bearer ${persisted.access_token}`]);
    assert.deepEqual(kv.auth, pool(persisted));
    assert.equal(kv.authVersion, versionBefore, "loading a persisted pool must not write a local seed into KV");
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean; codexAuthJsonB64: string }).isDeploy = originalDeployFlag;
    (config as { isDeploy: boolean; codexAuthJsonB64: string }).codexAuthJsonB64 = originalSeed;
  }
});

test("banked reset exhausts normal routing, verifies, and retries the redeemed account once", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const reset = scriptedResetProvider();
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    if (accountIds.length === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
        })
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "response-after-reset" }), { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-happy" },
      {
        requestId: "banked-reset-happy",
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-happy",
        },
      }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(accountIds, ["account-one", "account-one"]);
    assert.deepEqual(reset.calls, ["inventory", "redeem", "verify"]);
    assert.equal(reset.idempotencyKeys.length, 1);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a partially blocked cohort is served by ordinary capacity with no reset-provider contact", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const originalCodexBaseUrl = config.codexBaseUrl;
  const requests: Readonly<{ url: string; method: string; headers: Headers; body: string; signal: AbortSignal | null }>[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean; codexBaseUrl: string }).isDeploy = true;
  (config as { isDeploy: boolean; codexBaseUrl: string }).codexBaseUrl = "https://upstream-reset.test/backend-api/codex";
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      headers: new Headers(request.headers),
      body: request.method === "POST" ? await request.text() : "",
      signal: init?.signal ?? null,
    });
    const accountId = request.headers.get("chatgpt-account-id");
    if (request.url.endsWith("/backend-api/codex/responses")) {
      if (accountId === "account-one" && requests.filter((entry) => entry.url.endsWith("/responses")).length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              type: "usage_limit_reached",
              resets_at: Math.floor(Date.parse(stableBankedResetRetryAfter) / 1_000),
            },
          }),
          {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response(JSON.stringify({ id: `response-${accountId}` }), { status: 200 });
    }
    if (request.url.endsWith("/backend-api/wham/rate-limit-reset-credits")) {
      return Response.json({
        available_count: 1,
        credits: [{ id: "expiring-credit", status: "available", reset_type: "codex_rate_limits", expires_at: null }],
      });
    }
    if (request.url.endsWith("/backend-api/wham/rate-limit-reset-credits/consume")) {
      return Response.json({ code: "reset", windows_reset: 1 });
    }
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });

  try {
    const seeded = await fetchCodexResponses({ input: "seed-partial-block" }, bankedResetRequestOptions("seed-partial-block"));
    assert.equal(seeded.status, 200);

    const shadowed = await fetchCodexResponses({ input: "shadow-partial-block" }, bankedResetRequestOptions("shadow-partial-block"));
    assert.equal(shadowed.status, 200);

    const duplicateShadow = await fetchCodexResponses({ input: "shadow-partial-block-duplicate" }, bankedResetRequestOptions("shadow-partial-block-duplicate"));
    assert.equal(duplicateShadow.status, 200);

    // Ordinary eligible capacity wins: no inventory read, no consume, and no
    // recovery inference for the blocked sibling.
    assert.deepEqual(
      requests.map((request) => `${request.method} ${new URL(request.url).pathname} ${request.headers.get("chatgpt-account-id")}`),
      [
        "POST /backend-api/codex/responses account-one",
        "POST /backend-api/codex/responses account-two",
        "POST /backend-api/codex/responses account-two",
        "POST /backend-api/codex/responses account-two",
      ]
    );
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean; codexBaseUrl: string }).isDeploy = originalDeployFlag;
    (config as { isDeploy: boolean; codexBaseUrl: string }).codexBaseUrl = originalCodexBaseUrl;
  }
});

test("persistent live never arms a partially blocked cohort while ordinary capacity serves", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const originalCodexBaseUrl = config.codexBaseUrl;
  const inventoryAccountIds: string[] = [];
  const consumeAccountIds: string[] = [];
  const inferenceAccountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean; codexBaseUrl: string }).isDeploy = true;
  (config as { isDeploy: boolean; codexBaseUrl: string }).codexBaseUrl = "https://upstream-reset.test/backend-api/codex";
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  await seedStableBankedResetBlock();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const accountId = request.headers.get("chatgpt-account-id") ?? "";
    if (request.url.endsWith("/backend-api/codex/responses")) {
      inferenceAccountIds.push(accountId);
      return Promise.resolve(Response.json({ id: `response-${accountId}` }));
    }
    if (request.url.endsWith("/backend-api/wham/rate-limit-reset-credits")) {
      inventoryAccountIds.push(accountId);
      return Promise.resolve(
        Response.json({
          available_count: 1,
          credits: [{ id: `credit-${accountId}`, status: "available", reset_type: "codex_rate_limits", expires_at: null }],
        })
      );
    }
    if (request.url.endsWith("/backend-api/wham/rate-limit-reset-credits/consume")) {
      consumeAccountIds.push(accountId);
      return Promise.resolve(Response.json({ code: "reset", windows_reset: 1 }));
    }
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });

  try {
    const first = await fetchCodexResponses({ input: "persistent-live-partial-arm" }, bankedResetRequestOptions("persistent-live-partial-arm"));
    assert.equal(first.status, 200);
    const second = await fetchCodexResponses({ input: "persistent-live-partial-consume" }, bankedResetRequestOptions("persistent-live-partial-consume"));
    assert.equal(second.status, 200);

    // The healthy configured sibling serves both requests; the blocked account
    // never reaches inventory, redemption or recovery inference.
    assert.deepEqual(inferenceAccountIds, ["account-two", "account-two"]);
    assert.deepEqual(inventoryAccountIds, []);
    assert.deepEqual(consumeAccountIds, []);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean; codexBaseUrl: string }).isDeploy = originalDeployFlag;
    (config as { isDeploy: boolean; codexBaseUrl: string }).codexBaseUrl = originalCodexBaseUrl;
  }
});

test("persistent live auto-arms an all-blocked cohort before one later consume and reset retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const originalCodexBaseUrl = config.codexBaseUrl;
  const inventoryAccountIds: string[] = [];
  const consumeAccountIds: string[] = [];
  const inferenceAccountIds: string[] = [];
  const consumeBodies: unknown[] = [];
  const persistentLiveConfig: CodexBankedResetConfig = {
    ...liveBankedResetConfig(),
  };
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean; codexBaseUrl: string }).isDeploy = true;
  (config as { isDeploy: boolean; codexBaseUrl: string }).codexBaseUrl = "https://upstream-reset.test/backend-api/codex";
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  await seedStableBankedResetBlock("account-one");
  await seedStableBankedResetBlock("account-two");
  globalThis.fetch = createFetchMock(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const accountId = request.headers.get("chatgpt-account-id") ?? "";
    if (request.url.endsWith("/backend-api/codex/responses")) {
      inferenceAccountIds.push(accountId);
      return Response.json({ id: `response-${accountId}` });
    }
    if (request.url.endsWith("/backend-api/wham/rate-limit-reset-credits")) {
      inventoryAccountIds.push(accountId);
      return Response.json({
        available_count: 1,
        credits: [
          {
            id: `credit-${accountId}`,
            status: "available",
            reset_type: "codex_rate_limits",
            expires_at: null,
          },
        ],
      });
    }
    if (request.url.endsWith("/backend-api/wham/rate-limit-reset-credits/consume")) {
      consumeAccountIds.push(accountId);
      consumeBodies.push(JSON.parse(await request.text()));
      return Response.json({ code: "reset", windows_reset: 1 });
    }
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  });

  const options = (requestId: string) => ({
    clientVersion: "0.145.0",
    requestId,
    bankedReset: {
      config: persistentLiveConfig,
      kv: kv as unknown as Kv,
      now: () => fixedStartMs,
      newOwnerToken: () => `owner-${requestId}`,
    },
  });

  try {
    const armed = await fetchCodexResponses({ input: "persistent-live-all-blocked-arm" }, options("persistent-live-all-blocked-arm"));
    assert.equal(armed.status, 429);
    assert.equal((await armed.json()).error.code, "codex_quota_blocked");
    assert.deepEqual(
      [...inventoryAccountIds].sort((a, b) => a.localeCompare(b)),
      ["account-one", "account-two"]
    );
    assert.deepEqual(consumeAccountIds, []);
    assert.deepEqual(inferenceAccountIds, []);

    const consumed = await fetchCodexResponses({ input: "persistent-live-all-blocked-consume" }, options("persistent-live-all-blocked-consume"));
    assert.equal(consumed.status, 200);
    assert.ok(getCodexRoutingProbe(consumed));
    assert.equal(inventoryAccountIds.filter((accountId) => accountId === "account-one").length, 2);
    assert.equal(inventoryAccountIds.filter((accountId) => accountId === "account-two").length, 2);
    assert.deepEqual(consumeAccountIds, ["account-one"]);
    assert.deepEqual(inferenceAccountIds, ["account-one"]);
    assert.equal(consumeBodies.length, 1);
    assert.equal((consumeBodies[0] as { credit_id: unknown }).credit_id, "credit-account-one");
    assert.equal(typeof (consumeBodies[0] as { redeem_request_id: unknown }).redeem_request_id, "string");
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean; codexBaseUrl: string }).isDeploy = originalDeployFlag;
    (config as { isDeploy: boolean; codexBaseUrl: string }).codexBaseUrl = originalCodexBaseUrl;
  }
});

test("post-reset response probes retain their tombstone until an explicit completed outcome", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  resetProviderHealthThrottleForTest();
  let releaseProviderHealthCommit = () => {};
  let providerHealthCommitted: Promise<void> | null = null;

  const routingSlot = () => {
    const state = parseCodexAccountRoutingState(kv.extra.get(JSON.stringify(CODEX_ACCOUNT_ROUTING_KV_KEY))?.value);
    return state?.slots[0] ?? null;
  };
  const assertTombstone = () => {
    const slot = routingSlot();
    assert.equal(slot?.banked_reset_generation_ambiguous, true);
    assert.notEqual(slot.observed_reset_at_ms, null);
  };
  const fetchPostResetResponse = async (owner: string): Promise<Response> => {
    const reset = scriptedResetProvider();
    let inferenceCalls = 0;
    kv.auth = pool(auth("one"));
    kv.extra.clear();
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = createFetchMock(() => {
      inferenceCalls += 1;
      return Promise.resolve(
        inferenceCalls === 1
          ? new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
              status: 429,
              headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
            })
          : new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n', {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            })
      );
    });
    const response = await fetchCodexResponses(
      { input: `post-reset-probe-${owner}` },
      {
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => owner,
        },
      }
    );
    assert.equal(response.status, 200);
    assert.equal(inferenceCalls, 2);
    assert.deepEqual(reset.calls, ["inventory", "redeem", "verify"]);
    assert.ok(getCodexRoutingProbe(response));
    assertTombstone();
    return response;
  };

  try {
    for (const outcome of ["failed", "incomplete", "cancelled"] as const) {
      const response = await fetchPostResetResponse(`owner-post-reset-${outcome}`);
      await releaseCodexResponseProbe(response);
      assert.equal(getCodexRoutingProbe(response), null, outcome);
      assertTombstone();
      assert.equal(routingSlot()?.probe_lease, null, outcome);
    }

    const completed = await fetchPostResetResponse("owner-post-reset-completed");
    const providerHealthCommitGate = new Promise<void>((resolve) => {
      releaseProviderHealthCommit = resolve;
    });
    let signalProviderHealthCommit = () => {};
    const providerHealthCommitEntered = new Promise<void>((resolve) => {
      signalProviderHealthCommit = resolve;
    });
    let signalProviderHealthCommitted = () => {};
    providerHealthCommitted = new Promise<void>((resolve) => {
      signalProviderHealthCommitted = resolve;
    });
    kv.providerHealthSuccessCommitGate = providerHealthCommitGate;
    kv.onProviderHealthSuccessCommit = signalProviderHealthCommit;
    kv.onProviderHealthSuccessCommitted = signalProviderHealthCommitted;
    let completionSettled = false;
    const completion = markCodexResponseCompleted(completed).then(() => {
      completionSettled = true;
    });
    assert.equal(getCodexRoutingProbe(completed), null);
    await providerHealthCommitEntered;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(completionSettled, true);
    await completion;
    const slot = routingSlot();
    assert.equal(slot?.banked_reset_generation_ambiguous, false);
    assert.equal(slot.observed_reset_at_ms, null);
    assert.equal(slot.probe_lease, null);
  } finally {
    releaseProviderHealthCommit();
    if (providerHealthCommitted) await providerHealthCommitted;
    kv.providerHealthSuccessCommitGate = null;
    kv.onProviderHealthSuccessCommit = null;
    kv.onProviderHealthSuccessCommitted = null;
    resetProviderHealthThrottleForTest();
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("simultaneous gateway requests share one durable banked-reset submission", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let signalRedeemEntered!: () => void;
  let releaseRedeem!: () => void;
  const redeemEntered = new Promise<void>((resolve) => {
    signalRedeemEntered = resolve;
  });
  const redeemGate = new Promise<void>((resolve) => {
    releaseRedeem = resolve;
  });
  const reset = scriptedResetProvider({
    onRedeem: signalRedeemEntered,
    redeemGate,
  });
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock(() => {
    inferenceCalls += 1;
    if (inferenceCalls === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
        })
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "response-after-concurrent-reset" }), { status: 200 }));
  });

  const bankedReset = {
    config: liveBankedResetConfig(),
    provider: reset.provider,
    kv: kv as unknown as Kv,
    now: () => fixedStartMs,
    newOwnerToken: () => "owner-concurrent-gateway-reset",
  };
  try {
    const first = fetchCodexResponses({ input: "first-concurrent-banked-reset" }, { requestId: "first-concurrent-banked-reset", bankedReset });
    await redeemEntered;

    // The second request sees the durable `submitted` transaction while its
    // provider call is stalled. It may return the normal quota response but
    // must neither dispatch inference nor submit another reset.
    const second = await fetchCodexResponses({ input: "second-concurrent-banked-reset" }, { requestId: "second-concurrent-banked-reset", bankedReset });
    assert.equal(second.status, 429);
    assert.equal(inferenceCalls, 1);
    assert.deepEqual(reset.calls, ["inventory", "redeem"]);
    assert.equal(reset.idempotencyKeys.length, 1);

    releaseRedeem();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    assert.equal(inferenceCalls, 2);
    assert.deepEqual(reset.calls, ["inventory", "redeem", "verify"]);
    assert.equal(reset.idempotencyKeys.length, 1);
    assert.equal(new Set(reset.idempotencyKeys).size, 1);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("an already-redeemed reset is independently verified before one same-account retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const reset = scriptedResetProvider({ redeemKind: "already_redeemed" });
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    if (accountIds.length === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
        })
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "response-after-already-redeemed" }), { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-already-redeemed" },
      {
        requestId: "banked-reset-already-redeemed",
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-already-redeemed",
        },
      }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(accountIds, ["account-one", "account-one"]);
    assert.deepEqual(reset.calls, ["inventory", "redeem", "verify"]);
    assert.equal(reset.idempotencyKeys.length, 1);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("an auth rotation after verification fences off the post-reset retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  const reset = scriptedResetProvider({
    onVerify: () => {
      kv.auth = pool({
        ...auth("one"),
        access_token: accessToken("one-rotated"),
        refresh_token: "refresh-one-rotated",
      });
      kv.authVersion += 1;
    },
  });
  globalThis.fetch = createFetchMock(() => {
    inferenceCalls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
      })
    );
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-auth-rotation" },
      {
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-auth-rotation",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.equal(inferenceCalls, 1, "a rotated auth-pool entry must prevent the post-reset retry");
    assert.deepEqual(reset.calls, ["inventory", "redeem", "verify"]);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("an auth rotation inside the final dispatch hook fences off a post-reset retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let inferenceCalls = 0;
  let beforeDispatchCalls = 0;
  const startedDispatchGenerations: number[] = [];
  const cancelledDispatchGenerations: number[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  const reset = scriptedResetProvider();
  globalThis.fetch = createFetchMock(() => {
    inferenceCalls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": stableBankedResetRetryAfter },
      })
    );
  });

  try {
    const response = await fetchCodexResponses(
      { input: "banked-reset-dispatch-race" },
      {
        beforeDispatch: () => {
          beforeDispatchCalls += 1;
          const dispatchGeneration = beforeDispatchCalls;
          if (beforeDispatchCalls === 2) {
            // This occurs after the verified record and routing repair, but
            // before the post-reset transport can mark itself started.
            kv.auth = pool({
              ...auth("one"),
              access_token: accessToken("one-rotated-during-dispatch"),
              refresh_token: "refresh-one-rotated-during-dispatch",
            });
            kv.authVersion += 1;
          }
          return Promise.resolve({
            markTransportStarted: () => {
              startedDispatchGenerations.push(dispatchGeneration);
            },
            cancelBeforeTransport: () => {
              cancelledDispatchGenerations.push(dispatchGeneration);
              return Promise.resolve();
            },
          });
        },
        bankedReset: {
          config: liveBankedResetConfig(),
          provider: reset.provider,
          kv: kv as unknown as Kv,
          now: () => fixedStartMs,
          newOwnerToken: () => "owner-dispatch-race",
        },
      }
    );
    assert.equal(response.status, 429);
    assert.equal(beforeDispatchCalls, 2);
    assert.equal(inferenceCalls, 1, "the rotated second attempt must not reach upstream transport");
    assert.deepEqual(startedDispatchGenerations, [1]);
    assert.deepEqual(cancelledDispatchGenerations, [2]);
    assert.deepEqual(reset.calls, ["inventory", "redeem", "verify"]);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

beforeEach(installHarness);
afterEach(cleanupHarness);
