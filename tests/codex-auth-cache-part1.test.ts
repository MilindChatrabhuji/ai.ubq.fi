import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test, beforeEach, afterEach } from "bun:test";
import { type Kv, type KvKey } from "#kv";
// codex-auth-cache suite, part 1 of 4: tests moved out of tests/codex-auth-cache.test.ts.

import assert from "node:assert/strict";
import {
  installHarness,
  cleanupHarness,
  AUTH_KEY,
  AuthKv,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_AUTH_REAUTH_WARNING,
  type CodexAuthPoolState,
  type CodexAuthState,
  CodexError,
  PROVIDER_CAPACITY_SNAPSHOT_KEY,
  type VoidDeferred,
  abortReasonError,
  accessToken,
  auth,
  cacheCodexAuthPool,
  config,
  fetchCodexResponses,
  fixedStartMs,
  getCodexResponseActiveTelemetry,
  getCodexResponseSlot,
  kv,
  markCodexQuotaBlocked,
  markCodexResponseCompleted,
  orderCodexAuthAccounts,
  parseCodexActiveAccountSelection,
  pool,
  requestUrl,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  selectCodexRoutingAccounts,
  setKvForTest,
  staleAuth,
  utf8ByteLength,
} from "./helpers/codex-auth-cache-harness.ts";

test("Codex auth account ordering rotates from the selected account", () => {
  const accounts = [auth("one"), auth("two")];
  assert.deepEqual(
    orderCodexAuthAccounts(accounts, 0).map((candidate) => candidate.account_id),
    ["account-one", "account-two"]
  );
  assert.deepEqual(
    orderCodexAuthAccounts(accounts, 1).map((candidate) => candidate.account_id),
    ["account-two", "account-one"]
  );
});

test("repeated requests preserve subscription account order", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    accountIds.push(new Headers(init?.headers).get("ChatGPT-Account-ID") ?? "missing");
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const response = await fetchCodexResponses({ model: "gpt-5.6-luna", input: "stable routing order" }, {});
      assert.equal(response.status, 200);
      await markCodexResponseCompleted(response);
    }
    assert.deepEqual(accountIds, ["account-one", "account-one"]);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("AuthKv strong getMany snapshots auth and routing rows before a routing-read hook mutates them", async () => {
  const fixture = new AuthKv(pool(auth("old")));
  const routingKey = CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY;
  const initialRoutingRow = { v: 1, generation: 1 } as const;
  fixture.extra.set(JSON.stringify(routingKey), { value: initialRoutingRow, version: 3 });
  const rotatedAuth = pool(auth("rotated"));
  const rotatedRoutingRow = { v: 1, generation: 2 } as const;
  let mutated = false;
  // The hook fires only after getMany captured the tuple; replacing both rows
  // here must not leak into the snapshot it returns.
  fixture.onRoutingRead = () => {
    if (mutated) return;
    mutated = true;
    fixture.auth = rotatedAuth;
    fixture.authVersion += 1;
    fixture.extra.set(JSON.stringify(routingKey), { value: rotatedRoutingRow, version: 4 });
  };

  try {
    const snapshot = await fixture.getMany<[CodexAuthPoolState, Readonly<{ v: number; generation: number }>]>([AUTH_KEY, routingKey], {
      consistency: "strong",
    });
    assert.equal(mutated, true, "the routing read hook must observe the read");
    assert.deepEqual(snapshot[0].value, pool(auth("old")));
    assert.equal(snapshot[0].versionstamp, "00000000000000000001");
    assert.deepEqual(snapshot[1].value, initialRoutingRow);
    assert.equal(snapshot[1].versionstamp, "00000000000000000003");

    // A fresh strong read observes both rows the hook wrote.
    const fresh = await fixture.getMany<[CodexAuthPoolState, Readonly<{ v: number; generation: number }>]>([AUTH_KEY, routingKey], { consistency: "strong" });
    assert.deepEqual(fresh[0].value, rotatedAuth);
    assert.equal(fresh[0].versionstamp, "00000000000000000002");
    assert.deepEqual(fresh[1].value, rotatedRoutingRow);
    assert.equal(fresh[1].versionstamp, "00000000000000000004");
    assert.equal(fixture.reads, 2);
    assert.equal(fixture.routingReads, 2);
  } finally {
    fixture.onRoutingRead = null;
  }
});

test("retired affinity rows are never written by terminal completion", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  const retiredKey = ["uos_ai", "codex_account_affinity", "v1", "retired-terminal-fixture"] as const;
  const retiredRow = { account_cohort_hash: "uos-prompt-cache-account-cohort-v1\u0000account-one", expires_at_ms: fixedStartMs + 60_000 };
  await kv.set(retiredKey, retiredRow);
  const storedBefore = kv.extra.get(JSON.stringify(retiredKey));
  const accountIds: string[] = [];
  globalThis.fetch = createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    accountIds.push(new Headers(init?.headers).get("ChatGPT-Account-ID") ?? "missing");
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { input: "terminal affinity", prompt_cache_key: "retired-terminal-key" },
      { cacheScope: "api-key:terminal-affinity" }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(accountIds, ["account-one"]);
    assert.deepEqual(kv.extra.get(JSON.stringify(retiredKey)), storedBefore, "inference never reads or rewrites retired affinity rows");

    await markCodexResponseCompleted(response);
    assert.deepEqual(kv.extra.get(JSON.stringify(retiredKey)), storedBefore, "terminal completion never rewrites retired affinity rows");
    assert.deepEqual(getCodexResponseActiveTelemetry(response), { activeGeneration: 1, activeTransitionReason: null });
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a durable routing-state outage fails retryably before dispatch", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let providerCalls = 0;
  let beforeDispatchCalls = 0;
  let transportStarts = 0;
  Date.now = () => fixedStartMs;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  cacheCodexAuthPool(kv.auth);
  setKvForTest(null);
  globalThis.fetch = createFetchMock(() => {
    providerCalls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses(
      { model: "gpt-5.6-luna", input: "wait for KV" },
      {
        beforeDispatch: () => {
          beforeDispatchCalls += 1;
          return Promise.resolve({
            markTransportStarted: () => {
              transportStarts += 1;
            },
            cancelBeforeTransport: () => Promise.resolve(),
          });
        },
      }
    );
    // Unavailable durable routing state is a retryable error before dispatch:
    // the gateway never guesses a sibling or deletes existing state.
    assert.equal(response.status, 503);
    assert.equal(providerCalls, 0);
    assert.equal(beforeDispatchCalls, 0);
    assert.equal(transportStarts, 0);
    await response.arrayBuffer();
  } finally {
    setKvForTest(kv as unknown as Kv);
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("concurrent Codex requests dispatch without gateway admission rejection", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let providerCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();

  globalThis.fetch = createFetchMock(async () => {
    providerCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => fetchCodexResponses({ model: "gpt-5.6-luna", input: `agent-${index}` })));
    assert.equal(providerCalls, 8);
    assert.deepEqual(
      responses.map((response) => response.status),
      Array(8).fill(200)
    );
    await Promise.all(responses.map(markCodexResponseCompleted));
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex responses use the native prompt-cache wire contract and stable keyed sessions", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const requests: Request[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push(new Request(input, init));
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  const cacheableBody = {
    model: "gpt-5.6-luna",
    prompt_cache_key: "stable-cache-key",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_retention: "24h",
    max_output_tokens: 64,
    max_completion_tokens: 64,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "stable prefix",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        name: "cache_schema_fixture",
        parameters: {
          type: "object",
          properties: { prompt_cache_breakpoint: { type: "string" } },
        },
      },
    ],
  };
  const originalBody = structuredClone(cacheableBody);

  try {
    const first = await fetchCodexResponses(cacheableBody, { cacheScope: "principal-one" });
    const second = await fetchCodexResponses(cacheableBody, { cacheScope: "principal-one" });
    const differentKey = await fetchCodexResponses({ ...cacheableBody, prompt_cache_key: "different-cache-key" }, { cacheScope: "principal-one" });
    const differentPrincipal = await fetchCodexResponses(cacheableBody, { cacheScope: "principal-two" });
    await fetchCodexResponses(cacheableBody);
    await fetchCodexResponses(cacheableBody);
    await fetchCodexResponses({ model: "gpt-5.6-luna", input: "no key" }, { cacheScope: "principal-one" });
    await fetchCodexResponses({ model: "gpt-5.6-luna", input: "no key" }, { cacheScope: "principal-one" });

    assert.deepEqual(cacheableBody, originalBody);
    assert.equal(requests.length, 8);
    const bodies = await Promise.all(requests.map((request) => request.clone().json() as Promise<Record<string, unknown>>));
    const firstBody = bodies[0];
    assert.equal(firstBody.prompt_cache_key, "stable-cache-key");
    assert.equal("prompt_cache_options" in firstBody, false);
    assert.equal("prompt_cache_retention" in firstBody, false);
    assert.equal("max_output_tokens" in firstBody, false);
    assert.equal("max_completion_tokens" in firstBody, false);
    const input = firstBody.input as Record<string, unknown>[];
    const content = input[0]?.content as Record<string, unknown>[];
    assert.equal("prompt_cache_breakpoint" in content[0], false);
    const tools = firstBody.tools as Record<string, unknown>[];
    assert.deepEqual(tools[0], cacheableBody.tools[0]);
    assert.deepEqual(bodies[1], firstBody);

    const identityHeaders = ["conversation_id", "session-id", "thread-id", "x-client-request-id"] as const;
    const stableIdentity = requests[0].headers.get("conversation_id");
    assert.match(stableIdentity ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const header of identityHeaders) {
      assert.equal(requests[0].headers.get(header), stableIdentity);
      assert.equal(requests[1].headers.get(header), stableIdentity);
      assert.notEqual(requests[2].headers.get(header), stableIdentity);
      assert.notEqual(requests[3].headers.get(header), stableIdentity);
    }
    for (const request of requests.slice(4)) {
      assert.equal(request.headers.get("session-id"), null);
      assert.equal(request.headers.get("thread-id"), null);
      assert.equal(request.headers.get("x-client-request-id"), null);
    }
    assert.notEqual(requests[4].headers.get("conversation_id"), requests[5].headers.get("conversation_id"));
    assert.notEqual(requests[6].headers.get("conversation_id"), requests[7].headers.get("conversation_id"));

    const expectedWarnings = ["prompt_cache_options_ignored", "prompt_cache_retention_ignored", "max_output_tokens_ignored", "prompt_cache_breakpoint_ignored"];
    for (const response of [first, second, differentKey, differentPrincipal]) {
      const warnings =
        response.headers
          .get("x-uos-warning")
          ?.split(",")
          .map((value) => value.trim()) ?? [];
      assert.deepEqual(warnings, expectedWarnings);
    }
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex responses retry the same active account after an account-level 429", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    if (accountIds.length > 2) throw new Error("a bounded 429 retry must not dispatch a third attempt");
    return Promise.resolve(new Response("{}", { status: accountIds.length === 1 ? 429 : 200 }));
  });

  try {
    const response = await fetchCodexResponses({ input: "balance" });
    assert.equal(response.status, 200);
    // The serial active account owns the one bounded retry: a sibling is never
    // dispatched for an account-level 429.
    assert.deepEqual(accountIds, ["account-one", "account-one"]);
    assert.equal(accountIds.length, 2);
    assert.equal(getCodexResponseSlot(response), 1);
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex responses keep the durable active account over sibling dashboard headroom", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    const initial = await selectCodexRoutingAccounts(kv.auth, kv.auth.accounts, fixedStartMs);
    assert.equal(initial.kind, "eligible");

    const accountTwo = initial.accounts.find((account) => account.auth.account_id === "account-two");
    assert.ok(accountTwo);

    const blockedUntil = fixedStartMs + 60_000;
    await markCodexQuotaBlocked(
      accountTwo,
      new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": new Date(blockedUntil).toUTCString() },
      }),
      fixedStartMs - 1
    );
    await kv.set(PROVIDER_CAPACITY_SNAPSHOT_KEY, {
      snapshot_at_ms: fixedStartMs,
      sources: [
        {
          source: "codex",
          slot: 2,
          state: "available",
          source_observed_at_ms: fixedStartMs,
          snapshot_at_ms: fixedStartMs,
          windows: {
            primary: { limit_window_seconds: 604_800, used_percent: 100, reset_at_ms: fixedStartMs + 604_800_000 },
            secondary: null,
          },
          additional_rate_limits: [
            {
              limit_name: "GPT-5.3-Codex-Spark",
              metered_feature: "codex_bengalfox",
              windows: {
                primary: { limit_window_seconds: 18_000, used_percent: 50, reset_at_ms: fixedStartMs + 18_000_000 },
                secondary: null,
              },
            },
          ],
        },
      ],
    });
    resetCodexAccountRoutingForTest();

    const response = await fetchCodexResponses({ model: "gpt-5.3-codex-spark", input: "dashboard-positive" });
    assert.equal(response.status, 200);
    // Fresh sibling dashboard headroom is not a transition reason: the durable
    // active account stays selected.
    assert.deepEqual(accountIds, ["account-one"]);
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex responses return a raw 403 without sibling failover", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    if (accountIds.length > 1) throw new Error("a raw 403 with a valid bearer must not dispatch a sibling");
    return Promise.resolve(new Response("{}", { status: 403 }));
  });

  try {
    const response = await fetchCodexResponses({ input: "forbidden-failover" });
    assert.equal(response.status, 403);
    assert.deepEqual(accountIds, ["account-one"]);
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex responses do not replay a dispatched transport failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    if (accountIds.length === 1) {
      return Promise.reject(new DOMException("upstream socket closed", "TimeoutError"));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    await assert.rejects(
      () => fetchCodexResponses({ input: "timeout-sibling-retry" }, {}),
      (error: unknown) => error instanceof CodexError && error.code === "gateway_timeout"
    );
    assert.deepEqual(accountIds, ["account-one"]);
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("transport failures preserve retired affinity rows and provider health", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  const retiredKey = ["uos_ai", "codex_account_affinity", "v1", "retired-transport-fixture"] as const;
  const retiredRow = { account_cohort_hash: "uos-prompt-cache-account-cohort-v1\u0000account-one", expires_at_ms: fixedStartMs + 60_000 };
  await kv.set(retiredKey, retiredRow);
  const affinityBefore = kv.extra.get(JSON.stringify(retiredKey));
  globalThis.fetch = createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    accountIds.push(new Headers(init?.headers).get("ChatGPT-Account-ID") ?? "missing");
    return Promise.reject(new DOMException("upstream socket closed", "TimeoutError"));
  });

  try {
    await assert.rejects(
      () =>
        fetchCodexResponses(
          { input: "all siblings fail", prompt_cache_key: "transport-failure-affinity-key" },
          { cacheScope: "api-key:transport-failure-affinity" }
        ),
      (error: unknown) => error instanceof CodexError && error.code === "gateway_timeout" && error.status === 504
    );
    assert.deepEqual(accountIds, ["account-one"]);
    assert.deepEqual(kv.extra.get(JSON.stringify(retiredKey)), affinityBefore);
    // A transient timeout never advances or rolls back the durable active
    // generation, and it never dispatches a sibling or paid provider.
    const active = parseCodexActiveAccountSelection(kv.extra.get(JSON.stringify(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY))?.value);
    assert.equal(active?.generation, 1);
    assert.equal(active.slot, 0);
    for (const encoded of kv.extra.keys()) {
      const key = JSON.parse(encoded) as KvKey;
      assert.notEqual(key[1], "provider_health", `transport failure mutated provider health at ${encoded}`);
    }
  } finally {
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("post-dispatch client cancellation stops Codex transport", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const transportStarted: VoidDeferred = Promise.withResolvers();
  const requestAbort = new AbortController();
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock(
    (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        transportStarted.resolve();
        const rejectFromSignal = (): void => {
          reject(abortReasonError(signal.reason));
        };
        if (signal.aborted) rejectFromSignal();
        else signal.addEventListener("abort", rejectFromSignal, { once: true });
      })
  );

  try {
    const pending = fetchCodexResponses(
      { input: "cancel after dispatch" },
      {
        signal: requestAbort.signal,
      }
    );
    await transportStarted.promise;
    requestAbort.abort(new DOMException("client disconnected", "AbortError"));
    await assert.rejects(
      () => pending,
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex responses make one bounded same-active retry when a generic 429 repeats", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const serializedBodies: string[] = [];
  const retryDelays: number[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const serializedBody = init?.body;
    if (typeof serializedBody !== "string") throw new Error("Expected Codex request body to be a serialized string.");
    serializedBodies.push(serializedBody);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    if (accountIds.length > 2) throw new Error("a generic 429 gets exactly one same-active bounded retry");
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      })
    );
  });

  try {
    const response = await fetchCodexResponses(
      { input: "bounded-retry" },
      {
        requestId: "request-bounded-retry",
        retrySleep: (milliseconds) => {
          retryDelays.push(milliseconds);
          return Promise.resolve();
        },
      }
    );
    // A generic rate_limit_error is not quota exhaustion, so the one bounded
    // retry stays on the same active account and the second 429 is final.
    assert.equal(response.status, 429);
    assert.deepEqual(accountIds, ["account-one", "account-one"]);
    assert.deepEqual(retryDelays, [1_000]);
    const expectedSerializedBody = JSON.stringify({ input: "bounded-retry" });
    assert.equal(utf8ByteLength(expectedSerializedBody), 25);
    assert.deepEqual(serializedBodies, [expectedSerializedBody, expectedSerializedBody]);
    assert.deepEqual(serializedBodies.map(utf8ByteLength), [25, 25]);
    assert.equal(
      serializedBodies.reduce((total, body) => total + utf8ByteLength(body), 0),
      50
    );
    await response.arrayBuffer();
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex 429 retry sleep normalizes a shared timeout as a gateway timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const controller = new AbortController();
  const timeoutReason = new DOMException("request deadline exceeded", "TimeoutError");
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      })
    );
  });

  try {
    await assert.rejects(
      () =>
        fetchCodexResponses(
          { input: "retry-timeout" },
          {
            signal: controller.signal,
            retrySleep: () => {
              queueMicrotask(() => {
                controller.abort(timeoutReason);
              });
              return new Promise<void>(() => {});
            },
          }
        ),
      (error: unknown) => {
        if (!(error instanceof CodexError)) return false;
        assert.equal(error.code, "gateway_timeout");
        assert.equal(error.status, 504);
        assert.equal((error as Error & { cause?: unknown }).cause, timeoutReason);
        return true;
      }
    );
    assert.deepEqual(accountIds, ["account-one"]);
    assert.equal(accountIds.length, 1, "the retry transport never began");
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex 429 retry sleep preserves ordinary cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  const controller = new AbortController();
  const abortReason = new DOMException("client disconnected", "AbortError");
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(
      new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "1" },
      })
    );
  });

  try {
    await assert.rejects(
      () =>
        fetchCodexResponses(
          { input: "retry-cancelled" },
          {
            signal: controller.signal,
            retrySleep: () => {
              queueMicrotask(() => {
                controller.abort(abortReason);
              });
              return new Promise<void>(() => {});
            },
          }
        ),
      (error: unknown) => {
        assert.equal(error, abortReason);
        return true;
      }
    );
    assert.deepEqual(accountIds, ["account-one"]);
    assert.equal(accountIds.length, 1, "the retry transport never began");
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("an expired generic 429 retry preserves the subsequent raw 403 response", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  let now = fixedStartMs;
  Date.now = () => now;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    if (accountIds.length === 1) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              message: "Active account temporarily rate limited",
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
            },
          },
          { status: 429 }
        )
      );
    }
    if (accountIds.length === 2) {
      now = fixedStartMs + 5_000;
      return Promise.resolve(
        Response.json(
          {
            error: {
              message: "Active account forbidden",
              type: "invalid_request_error",
              code: "active_account_forbidden",
            },
          },
          { status: 403 }
        )
      );
    }
    throw new Error("a raw 403 is terminal and must not dispatch a third attempt");
  });

  try {
    const response = await fetchCodexResponses(
      { input: "expired-generic-retry" },
      {
        requestId: "request-expired-generic-retry",
        retrySleep: () => Promise.resolve(),
      }
    );
    // The generic 429's one bounded retry stays on the active account, and its
    // raw 403 is the final response.
    assert.equal(response.status, 403);
    assert.deepEqual(accountIds, ["account-one", "account-one"]);
    assert.equal(accountIds.length, 2);
    assert.equal(now, fixedStartMs + 5_000);
    assert.deepEqual(await response.json(), {
      error: {
        message: "Active account forbidden",
        type: "invalid_request_error",
        code: "active_account_forbidden",
      },
    });
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex routing logs attempts, refresh, and bounded retry without sensitive values", async () => {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const lines: string[] = [];
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  console.info = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    if (request.url.includes("auth.openai.com/oauth/token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "refreshed-secret-access",
            refresh_token: "refreshed-secret-refresh",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    inferenceCalls += 1;
    const status = inferenceCalls === 1 ? 401 : 429;
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: "full-sensitive-upstream-error-body" } }), {
        status,
        headers: status === 429 ? { "Retry-After": "1" } : undefined,
      })
    );
  });

  try {
    const response = await fetchCodexResponses(
      { input: "redacted-logs" },
      {
        requestId: "request-redacted-logs",
        retrySleep: () => Promise.resolve(),
      }
    );
    assert.equal(response.status, 429);
    const output = lines.join("\n");
    assert.match(output, /"event":"codex_attempt"/);
    assert.match(output, /"event":"codex_token_refresh"/);
    assert.match(output, /"event":"codex_two_second_retry"/);
    assert.match(output, /"status_class":"401"/);
    assert.match(output, /"status_class":"429"/);
    for (const forbidden of [
      "account-one",
      "account-two",
      "access-one",
      "refresh-one",
      "refreshed-secret-access",
      "refreshed-secret-refresh",
      "full-sensitive-upstream-error-body",
    ]) {
      assert.equal(output.includes(forbidden), false, forbidden);
    }
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex responses retry the other account when a 401 cannot refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  let firstCancellationStarted = false;
  let refreshCancellationStarted = false;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    if (request.url.includes("auth.openai.com/oauth/token")) {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"error":"invalid_grant"}'));
            },
            cancel() {
              refreshCancellationStarted = true;
              return new Promise<void>(() => {});
            },
          }),
          { status: 401 }
        )
      );
    }
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    if (accountIds.length === 1) {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{}"));
            },
            cancel() {
              firstCancellationStarted = true;
              return new Promise<void>(() => {});
            },
          }),
          { status: 401 }
        )
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses({ input: "auth-failover" });
    assert.equal(response.status, 200);
    assert.equal(accountIds.length, 2);
    assert.equal(new Set(accountIds).size, 2);
    assert.equal(firstCancellationStarted, true);
    assert.equal(refreshCancellationStarted, true);
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a credential replacement landing after 401 is retried without an OAuth refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const attempted = auth("one");
  const replacement: CodexAuthState = {
    ...attempted,
    access_token: accessToken("replacement"),
    refresh_token: "refresh-replacement",
    updated_at_ms: fixedStartMs + 1,
  };
  const authorizationHeaders: string[] = [];
  const serializedBodies: string[] = [];
  let oauthCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(attempted);
  kv.authVersion += 1;
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    if (request.url.includes("auth.openai.com/oauth/token")) {
      oauthCalls += 1;
      return Promise.resolve(new Response('{"error":"must_not_refresh_replacement"}', { status: 401 }));
    }
    const serializedBody = init?.body;
    if (typeof serializedBody !== "string") throw new Error("Expected Codex request body to be a serialized string.");
    serializedBodies.push(serializedBody);
    authorizationHeaders.push(request.headers.get("Authorization") ?? "");
    if (authorizationHeaders.length === 1) {
      kv.auth = pool(replacement);
      kv.authVersion += 1;
      return Promise.resolve(new Response("{}", { status: 401 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses({ input: "rotation-between-401-and-refresh" });
    assert.equal(response.status, 200);
    assert.equal(oauthCalls, 0);
    assert.deepEqual(authorizationHeaders, [`Bearer ${attempted.access_token}`, `Bearer ${replacement.access_token}`]);
    const expectedSerializedBody = JSON.stringify({ input: "rotation-between-401-and-refresh" });
    assert.equal(utf8ByteLength(expectedSerializedBody), 44);
    assert.deepEqual(serializedBodies, [expectedSerializedBody, expectedSerializedBody]);
    assert.deepEqual(serializedBodies.map(utf8ByteLength), [44, 44]);
    assert.equal(
      serializedBodies.reduce((total, body) => total + utf8ByteLength(body), 0),
      88
    );
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("Codex responses synthesize 401 only after every account has an invalid refresh credential", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  let refreshCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"), auth("two"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    if (request.url.includes("auth.openai.com/oauth/token")) {
      refreshCalls += 1;
      return Promise.resolve(new Response('{"error":"invalid_grant"}', { status: 401 }));
    }
    accountIds.push(request.headers.get("chatgpt-account-id") ?? "");
    return Promise.resolve(new Response("{}", { status: 401 }));
  });

  try {
    const response = await fetchCodexResponses({ input: "auth-exhaustion" });
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as { error?: { code?: string } }).error?.code, "codex_auth_invalid");
    assert.equal(accountIds.length, 2);
    assert.equal(new Set(accountIds).size, 2);
    assert.equal(refreshCalls, 2);
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("concurrent proactive refreshes share one OAuth exchange", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let refreshCalls = 0;
  let inferenceCalls = 0;
  let releaseRefresh = (): void => {};
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let releaseFirstRoutingRead = (): void => {};
  const firstRoutingReadGate = new Promise<void>((resolve) => {
    releaseFirstRoutingRead = resolve;
  });
  let routingReads = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(staleAuth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  // Hold only the first selector's routing read so every later caller queues on
  // the admission tail; never wait for eight strong reads, which would deadlock.
  kv.onRoutingRead = () => {
    routingReads += 1;
    if (routingReads === 1) return firstRoutingReadGate;
  };
  globalThis.fetch = createFetchMock(async (input: Parameters<typeof fetch>[0]) => {
    const url = requestUrl(input);
    if (url.includes("auth.openai.com/oauth/token")) {
      refreshCalls += 1;
      await refreshGate;
      return new Response(JSON.stringify({ access_token: "refreshed-access", refresh_token: "refreshed-refresh" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    inferenceCalls += 1;
    return new Response("{}", { status: 200 });
  });

  try {
    const requests = Array.from({ length: 8 }, (_, index) => fetchCodexResponses({ input: `refresh-${index}` }));
    for (let attempt = 0; attempt < 100 && routingReads === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(routingReads, 1, "only the first queued selector may reach the strong read");
    releaseFirstRoutingRead();
    for (let attempt = 0; attempt < 100 && refreshCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(refreshCalls, 1, "expected one refresh to begin");
    releaseRefresh();
    const responses = await Promise.all(requests);
    assert.equal(refreshCalls, 1);
    // Only non-200 responses are read, so a failure is diagnosable here without
    // changing the test just to inspect its body.
    const failedResponses: string[] = [];
    for (const [index, response] of responses.entries()) {
      if (response.status !== 200) failedResponses.push(`${index}: ${response.status} ${await response.text()}`);
    }
    assert.deepEqual(
      responses.map((response) => response.status),
      Array(8).fill(200),
      failedResponses.join("\n")
    );
    assert.equal(inferenceCalls, 8, "every response is a distinct ordinary inference");
  } finally {
    releaseFirstRoutingRead();
    releaseRefresh();
    kv.onRoutingRead = null;
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a failed strong selector read releases the admission queue for the next request", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(auth("one"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  globalThis.fetch = createFetchMock((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    accountIds.push(new Headers(init?.headers).get("ChatGPT-Account-ID") ?? "missing");
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  kv.onRoutingRead = () => {
    throw new Error("routing KV unavailable");
  };

  try {
    const failed = await fetchCodexResponses({ input: "selector-failure" });
    assert.equal(failed.status, 503);
    await failed.arrayBuffer();

    // The failed selector released its queue, so the next request may bootstrap.
    kv.onRoutingRead = null;
    const recovered = await fetchCodexResponses({ input: "selector-recovery" });
    assert.equal(recovered.status, 200);
    assert.deepEqual(accountIds, ["account-one"]);
    await recovered.arrayBuffer();
  } finally {
    kv.onRoutingRead = null;
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a deterministic proactive refresh rejection quarantines the credential before inference", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let refreshCalls = 0;
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(staleAuth("invalid"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const url = requestUrl(input);
    if (url.includes("auth.openai.com/oauth/token")) {
      refreshCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }));
    }
    inferenceCalls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    const first = await fetchCodexResponses({ input: "expired-auth" });
    const second = await fetchCodexResponses({ input: "expired-auth-again" });
    assert.equal(first.status, 401);
    assert.equal(second.status, 401);
    assert.equal(first.headers.get("x-uos-warning"), CODEX_AUTH_REAUTH_WARNING);
    assert.equal(second.headers.get("x-uos-warning"), CODEX_AUTH_REAUTH_WARNING);
    assert.equal(refreshCalls, 1);
    assert.equal(inferenceCalls, 0);
    assert.equal(((await first.json()) as { error?: { code?: string } }).error?.code, "codex_auth_invalid");
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("refresh-token reuse returns an actionable re-auth warning without exposing the OAuth body", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  let inferenceCalls = 0;
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(staleAuth("reused"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0]) => {
    const url = requestUrl(input);
    if (url.includes("auth.openai.com/oauth/token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "refresh_token_reused",
              message: "provider secret must not escape",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    inferenceCalls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  try {
    const response = await fetchCodexResponses({ input: "reused-refresh-token" });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("x-uos-warning"), CODEX_AUTH_REAUTH_WARNING);
    const payload = (await response.json()) as { error?: { message?: string; code?: string } };
    assert.equal(payload.error?.code, "refresh_token_reused");
    assert.match(payload.error.message ?? "", /already used/i);
    assert.equal((payload.error.message ?? "").includes("provider secret"), false);
    assert.equal(inferenceCalls, 0);
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

test("a refresh failure warning survives a later quota-shaped 403 from another account", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalDeployFlag = config.isDeploy;
  const accountIds: string[] = [];
  Date.now = () => fixedStartMs;
  (config as { isDeploy: boolean }).isDeploy = true;
  kv.auth = pool(staleAuth("expired"), auth("quota"));
  kv.extra.clear();
  resetCodexAuthCacheForTest();
  globalThis.fetch = createFetchMock((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    if (request.url.includes("auth.openai.com/oauth/token")) {
      return Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }));
    }
    const accountId = request.headers.get("chatgpt-account-id") ?? "";
    accountIds.push(accountId);
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: "user quota is not enough" } }), {
        status: accountId === "account-quota" ? 403 : 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  try {
    const response = await fetchCodexResponses({ input: "expired-auth-with-quota-shaped-403" });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("x-uos-warning"), CODEX_AUTH_REAUTH_WARNING);
    assert.deepEqual(accountIds, ["account-quota"]);
  } finally {
    resetCodexAuthCacheForTest();
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
  }
});

beforeEach(installHarness);
afterEach(cleanupHarness);
