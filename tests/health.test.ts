import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import type { Kv, KvEntryMaybe, KvKey, KvListOptions, KvListSelector } from "#kv";
import { setKvForTest } from "../src/kv.ts";
import assert from "node:assert/strict";
import { sha256Hex } from "../src/utils.ts";

const keyToString = (key: KvKey): string => JSON.stringify(key);

let resetAuthCache = (): void => {};
class HealthKvStore extends Map<string, unknown> {
  override clear(): void {
    super.clear();
    resetAuthCache();
  }
}
const kvStore = new HealthKvStore();
let atomicCommitCount = 0;

const kvStub = {
  get: (key: KvKey) => Promise.resolve({ key, value: kvStore.get(keyToString(key)) ?? null } as KvEntryMaybe<unknown>),
  set: (key: KvKey, value: unknown) => {
    kvStore.set(keyToString(key), value);
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    kvStore.delete(keyToString(key));
    return Promise.resolve();
  },
  list: function* (_selector: KvListSelector, _options?: KvListOptions) {
    yield* [];
  },
  atomic: () => {
    const ops: { type: "set" | "delete"; key: KvKey; value?: unknown }[] = [];
    const chain = {
      check: () => chain,
      set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
        ops.push({ type: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        ops.push({ type: "delete", key });
        return chain;
      },
      commit: () => {
        atomicCommitCount += 1;
        for (const op of ops) {
          if (op.type === "set") kvStore.set(keyToString(op.key), op.value);
          else kvStore.delete(keyToString(op.key));
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

setKvForTest(kvStub);

const { handleHealth, handleHealthProviders, handleHealthUpstream, setActiveUpstreamHealthTimeoutMsForTest } = await import("../src/health.ts");
const { default: handler } = await import("../src/handler/index.ts");
const { config } = await import("../src/config.ts");
const { getJwtExpMs, resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
const {
  getCerebrasProviderHealth,
  getCodexProviderHealth,
  getDeepSeekProviderHealth,
  recordCerebrasProviderHealth,
  recordCodexProviderHealth,
  recordDeepSeekProviderHealth,
  recordMeteredProviderHealth,
  recordSurplusProviderHealth,
  resetProviderHealthThrottleForTest,
} = await import("../src/provider/health.ts");
resetAuthCache = resetCodexAuthCacheForTest;

// Base64url strips the "=" padding. A regex such as /=+$/g is super-linear: an
// unanchored quantifier re-consumes the whole "=" run at every start position,
// so strip the trailing run with a linear scan instead.
const base64Url = (value: string): string => {
  const encoded = btoa(value).replace(/\+/g, "-").replace(/\//g, "_");
  let end = encoded.length;
  while (end > 0 && encoded.charAt(end - 1) === "=") end -= 1;
  return encoded.slice(0, end);
};

const makeJwt = (expSeconds: number | null): string => {
  const header = base64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(expSeconds === null ? {} : { exp: expSeconds }));
  return `${header}.${payload}.`;
};

const makeAuthEntry = (
  accessTokenExpSeconds: number | null,
  accountId = "acct"
): {
  access_token: string;
  refresh_token: string;
  account_id: string;
  updated_at_ms: number;
} => ({
  access_token: makeJwt(accessTokenExpSeconds),
  refresh_token: "refresh",
  account_id: accountId,
  updated_at_ms: Date.now(),
});
const makeAuthPool = (...accounts: ReturnType<typeof makeAuthEntry>[]) => ({
  accounts,
  updated_at_ms: Date.now(),
});

const CODEX_AUTH_KEY: KvKey = ["ubq_ai", "codex_auth"];

test("getJwtExpMs ignores non-string, empty, and malformed tokens", () => {
  for (const token of [undefined, null, 42, {}, "", "not-a-jwt", "header.%%%.", "header.e30.signature.extra"] as unknown[]) {
    assert.doesNotThrow(() => {
      assert.equal(getJwtExpMs(token), null);
    });
  }
});

test("passive provider health returns every Codex slot without contacting upstream", async () => {
  kvStore.clear();
  resetProviderHealthThrottleForTest();
  const future = Math.floor(Date.now() / 1000) + 3600;
  kvStore.set(keyToString(CODEX_AUTH_KEY), makeAuthPool(makeAuthEntry(future, "private-account-a"), makeAuthEntry(future, "private-account-b")));
  await recordCodexProviderHealth("private-account-a", "quota_exhausted", 429, () => 1_000);
  await recordCodexProviderHealth("private-account-b", "refresh_failed", 401, () => 2_000);
  await recordMeteredProviderHealth("success", 200, () => 3_000);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => {
    throw new Error("/health/providers must not contact any upstream");
  });
  try {
    const response = await handleHealthProviders();
    const text = await response.text();
    const payload = JSON.parse(text) as {
      mode?: string;
      codex?: {
        account_count?: number;
        state?: string;
        accounts?: { slot?: number; health?: { state?: string; last_status?: number | null } }[];
      };
      metered?: { health?: { state?: string; last_status?: number | null }; quota?: { balance_credits?: unknown } };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.mode, "passive");
    assert.equal(payload.codex?.account_count, 2);
    assert.equal(payload.codex.state, "degraded");
    assert.deepEqual(
      payload.codex.accounts?.map((account) => [account.slot, account.health?.state, account.health?.last_status]),
      [
        [1, "exhausted", 429],
        [2, "invalid", 401],
      ]
    );
    assert.equal(payload.metered?.health?.state, "healthy");
    assert.equal("balance_credits" in (payload.metered.quota ?? {}), false);
    assert.equal(text.includes("private-account-a"), false);
    assert.equal(text.includes("private-account-b"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("passive provider health reports configured Cerebras without probing it", async () => {
  const envKey = "CEREBRAS_API_KEY";
  const originalApiKey = process.env[envKey];
  process.env[envKey] = "cerebras-test-key";
  kvStore.clear();
  resetProviderHealthThrottleForTest();
  await recordCerebrasProviderHealth("success", 200, () => 4_000);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => {
    throw new Error("passive Cerebras health must not probe an upstream");
  });
  try {
    const response = await handleHealthProviders();
    const payload = (await response.json()) as {
      cerebras?: { configured?: boolean; health?: { state?: string; last_status?: number | null } };
    };
    assert.equal(response.status, 200);
    assert.equal(payload.cerebras?.configured, true);
    assert.equal(payload.cerebras.health?.state, "healthy");
    assert.equal(payload.cerebras.health.last_status, 200);
    assert.equal((await getCerebrasProviderHealth(() => 4_001)).state, "healthy");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
    else process.env[envKey] = originalApiKey;
  }
});

test("passive provider health reports configured DeepSeek official without probing it", async () => {
  const envKey = "DEEPSEEK_API_KEY";
  const originalApiKey = process.env[envKey];
  process.env[envKey] = "deepseek-test-key";
  kvStore.clear();
  resetProviderHealthThrottleForTest();
  await recordDeepSeekProviderHealth("success", 200, () => 5_000);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => {
    throw new Error("passive DeepSeek health must not probe an upstream");
  });
  try {
    const response = await handleHealthProviders();
    const payload = (await response.json()) as {
      deepseek?: { configured?: boolean; health?: { state?: string; last_status?: number | null } };
    };
    assert.equal(response.status, 200);
    assert.equal(payload.deepseek?.configured, true);
    assert.equal(payload.deepseek.health?.state, "healthy");
    assert.equal(payload.deepseek.health.last_status, 200);
    assert.equal((await getDeepSeekProviderHealth(() => 5_001)).state, "healthy");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) Reflect.deleteProperty(process.env, envKey);
    else process.env[envKey] = originalApiKey;
  }
});

test("passive provider health reports DeepSeek as unconfigured without the official credential", async () => {
  const envKey = "DEEPSEEK_API_KEY";
  const originalApiKey = process.env[envKey];
  Reflect.deleteProperty(process.env, envKey);
  kvStore.clear();
  resetProviderHealthThrottleForTest();
  try {
    const response = await handleHealthProviders();
    const payload = (await response.json()) as { deepseek?: { configured?: boolean; health?: { state?: string } } };
    assert.equal(response.status, 200);
    assert.equal(payload.deepseek?.configured, false);
    assert.equal(payload.deepseek.health?.state, "unknown");
  } finally {
    if (originalApiKey !== undefined) process.env[envKey] = originalApiKey;
  }
});

test("admin provider health includes cached quota fields without an active refresh", async () => {
  kvStore.clear();
  kvStore.set(keyToString(CODEX_AUTH_KEY), makeAuthPool(makeAuthEntry(Math.floor(Date.now() / 1000) + 3600)));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => {
    throw new Error("/admin/providers must not contact any upstream");
  });
  try {
    const response = await handleHealthProviders({ includeQuota: true });
    const payload = (await response.json()) as {
      metered?: { quota?: { available?: boolean; balance_credits?: unknown } };
    };
    assert.equal(response.status, 200);
    assert.equal(typeof payload.metered?.quota?.available, "boolean");
    assert.equal("balance_credits" in (payload.metered?.quota ?? {}), true);
    assert.equal("removed_provider" in payload, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin provider health exposes Surplus identity and honest quota availability", async () => {
  kvStore.clear();
  resetProviderHealthThrottleForTest();
  const originalApiKey = process.env.SURPLUS_API_KEY;
  process.env.SURPLUS_API_KEY = "surplus-test-key";
  await recordSurplusProviderHealth("success", 200, () => 4_000);
  try {
    const response = await handleHealthProviders({ includeQuota: true });
    const payload = (await response.json()) as {
      surplus?: {
        configured?: boolean;
        quota_monitoring_configured?: boolean;
        health?: { state?: string };
        quota?: { available?: boolean; source?: string };
      };
    };
    assert.equal(response.status, 200);
    assert.equal(payload.surplus?.configured, true);
    assert.equal(payload.surplus.quota_monitoring_configured, false);
    assert.equal(payload.surplus.health?.state, "healthy");
    assert.equal(payload.surplus.quota?.available, false);
    assert.equal(payload.surplus.quota.source, "not_reported");
  } finally {
    if (originalApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = originalApiKey;
  }
});

test("provider health persists a recovery immediately while retaining the last 429", async () => {
  kvStore.clear();
  resetProviderHealthThrottleForTest();
  await recordCodexProviderHealth("recovering-account", "success", 200, () => 1_000);
  await recordCodexProviderHealth("recovering-account", "quota_exhausted", 429, () => 2_000);
  await recordCodexProviderHealth("recovering-account", "success", 200, () => 3_000);

  const health = await getCodexProviderHealth("recovering-account", () => 3_001);
  assert.equal(health.state, "healthy");
  assert.equal(health.last_429_at_ms, 2_000);
  assert.equal(health.last_success_at_ms, 3_000);
});

test("provider reachability and token refresh stay degraded until inference succeeds", async () => {
  kvStore.clear();
  resetProviderHealthThrottleForTest();
  await recordCodexProviderHealth("reachable-only-account", "reachable", 200, () => 500);
  const reachableOnly = await getCodexProviderHealth("reachable-only-account", () => 501);
  assert.equal(reachableOnly.state, "degraded");
  assert.equal(reachableOnly.last_event, "reachable");
  assert.equal(reachableOnly.last_success_at_ms, null);

  await recordCodexProviderHealth("evidence-account", "success", 200, () => 1_000);
  await recordCodexProviderHealth("evidence-account", "reachable", 200, () => 2_000);
  await recordCodexProviderHealth("evidence-account", "refresh_success", 200, () => 3_000);

  const refreshed = await getCodexProviderHealth("evidence-account", () => 3_001);
  assert.equal(refreshed.state, "degraded");
  assert.equal(refreshed.last_event, "refresh_success");
  assert.equal(refreshed.last_success_at_ms, 1_000);
  assert.equal(refreshed.last_refresh_at_ms, 3_000);
  assert.equal(refreshed.last_refresh_succeeded, true);

  await recordCodexProviderHealth("evidence-account", "success", 200, () => 4_000);
  const recovered = await getCodexProviderHealth("evidence-account", () => 4_001);
  assert.equal(recovered.state, "healthy");
  assert.equal(recovered.last_success_at_ms, 4_000);
});

test("provider request IDs are bounded, normalized, and sampled without per-request writes", async () => {
  kvStore.clear();
  resetProviderHealthThrottleForTest();
  atomicCommitCount = 0;
  await recordCodexProviderHealth("request-id-account", "reachable", 200, () => 1_000);
  assert.equal(atomicCommitCount, 1);
  await recordCodexProviderHealth("request-id-account", "reachable", 200, () => 2_000, "  first-id  ");
  assert.equal(atomicCommitCount, 2);
  await recordCodexProviderHealth("request-id-account", "reachable", 200, () => 3_000, "second-id");
  assert.equal(atomicCommitCount, 2);
  const sampled = await getCodexProviderHealth("request-id-account", () => 3_001);
  assert.equal(sampled.last_provider_request_id, "first-id");
  assert.equal(sampled.last_provider_request_id_at_ms, 2_000);

  await recordCodexProviderHealth("control-id-account", "reachable", 200, () => 4_000, "bad\nrequest-id");
  const control = await getCodexProviderHealth("control-id-account", () => 4_001);
  assert.equal(control.last_provider_request_id, null);

  await recordCodexProviderHealth("oversized-id-account", "reachable", 200, () => 5_000, "x".repeat(257));
  const oversized = await getCodexProviderHealth("oversized-id-account", () => 5_001);
  assert.equal(oversized.last_provider_request_id, null);
});

test("provider health coalesces identical quota observations without hiding a later transition", async () => {
  kvStore.clear();
  resetProviderHealthThrottleForTest();
  atomicCommitCount = 0;
  await Promise.all(Array.from({ length: 100 }, () => recordCodexProviderHealth("coalesced-account", "quota_exhausted", 429, () => 1_000)));

  const coalesced = await getCodexProviderHealth("coalesced-account", () => 1_001);
  assert.equal(coalesced.state, "exhausted");
  assert.equal(coalesced.last_observed_at_ms, 1_000);
  assert.equal(atomicCommitCount, 1);

  await recordCodexProviderHealth("coalesced-account", "success", 200, () => 2_000);
  const recovered = await getCodexProviderHealth("coalesced-account", () => 2_001);
  assert.equal(recovered.state, "healthy");
  assert.equal(recovered.last_observed_at_ms, 2_000);
  assert.equal(recovered.last_429_at_ms, 1_000);
});

test("provider health serializes success to 429 to success transitions", async () => {
  kvStore.clear();
  resetProviderHealthThrottleForTest();
  atomicCommitCount = 0;
  await Promise.all([
    recordCodexProviderHealth("ordered-account", "success", 200, () => 1_000),
    recordCodexProviderHealth("ordered-account", "quota_exhausted", 429, () => 2_000),
    recordCodexProviderHealth("ordered-account", "success", 200, () => 3_000),
  ]);

  const health = await getCodexProviderHealth("ordered-account", () => 3_001);
  assert.equal(health.state, "healthy");
  assert.equal(health.last_observed_at_ms, 3_000);
  assert.equal(health.last_success_at_ms, 3_000);
  assert.equal(health.last_429_at_ms, 2_000);
  assert.equal(atomicCommitCount, 3);
});

test("public health is passive release provenance with zero upstream and KV work", async () => {
  kvStore.clear();
  let fetchCalls = 0;
  let kvCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalGet = kvStub.get.bind(kvStub);
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    throw new Error("public health must not fetch");
  });
  (kvStub as { get: typeof kvStub.get }).get = (...args) => {
    kvCalls += 1;
    return originalGet(...args);
  };

  try {
    const response = handleHealth();
    const payload = (await response.json()) as {
      status?: string;
      release?: { git_sha?: string; deployment_id?: string };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.status, "available");
    assert.equal(typeof payload.release?.git_sha, "string");
    assert.equal(typeof payload.release?.deployment_id, "string");
    assert.equal(fetchCalls, 0);
    assert.equal(kvCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    (kvStub as { get: typeof kvStub.get }).get = originalGet;
  }
});

test("public health HEAD is release liveness without a response body", async () => {
  const response = await handler(new Request("https://ai.ubq.fi/health", { method: "HEAD" }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(typeof response.headers.get("x-uos-git-sha"), "string");
  assert.equal(typeof response.headers.get("x-uos-deployment-id"), "string");
  assert.equal(await response.text(), "");
});

test("obsolete auth health route is not exposed", async () => {
  const response = await handler(new Request("https://ai.ubq.fi/health/auth"));
  assert.equal(response.status, 404);
});

test("detailed provider health and recheck routes require admin authentication", async () => {
  for (const request of [
    new Request("https://ai.ubq.fi/health/providers"),
    new Request("https://ai.ubq.fi/health/upstream"),
    new Request("https://ai.ubq.fi/admin/providers"),
    new Request("https://ai.ubq.fi/admin/providers/codex/1/recheck", { method: "POST" }),
    new Request("https://ai.ubq.fi/admin/providers/codex/cache-scope-experiment", { method: "GET" }),
    new Request("https://ai.ubq.fi/admin/providers/codex/cache-scope-experiment", { method: "POST" }),
  ]) {
    const response = await handler(request);
    assert.equal(response.status, 401);
  }
});

test("authenticated admin provider route is private and not cacheable", async () => {
  const token = "health-route-admin-token";
  const adminTokens = config.adminTokens as Set<string>;
  adminTokens.add(token);
  try {
    const response = await handler(
      new Request("https://ai.ubq.fi/admin/providers", {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const payload = (await response.json()) as { mode?: unknown };
    assert.equal(payload.mode, "passive");
  } finally {
    adminTokens.delete(token);
  }
});

test("active upstream health retains detailed failure diagnostics", async () => {
  kvStore.clear();
  kvStore.set(keyToString(CODEX_AUTH_KEY), makeAuthPool(makeAuthEntry(Math.floor(Date.now() / 1000) + 3600)));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      new Response("temporary error", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      })
    )
  );

  try {
    const upstream = await handleHealthUpstream();
    const upstreamPayload = (await upstream.json()) as Record<string, unknown>;

    assert.equal(upstream.status, 503);
    assert.equal(upstreamPayload.status, 503);
    const authBlock = upstreamPayload.auth as
      | {
          accounts?: { refresh_sha256?: string | null; native_owner_codex_home?: string | null }[];
        }
      | undefined;
    assert.equal(authBlock?.accounts?.[0]?.refresh_sha256, await sha256Hex("refresh"));
    assert.equal(authBlock.accounts[0]?.native_owner_codex_home, null);
    assert.equal((upstreamPayload.probes as { codex?: { provider?: string; status?: number } } | undefined)?.codex?.provider, "chatgpt_codex");
    assert.equal((upstreamPayload.probes as { codex?: { status?: number } } | undefined)?.codex?.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("active upstream health bounds malformed Codex auth metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => {
    throw new Error("malformed auth health must not contact upstream");
  });
  const malformedRecords: unknown[] = [
    { tokens: { access_token: "legacy-access-token", refresh_token: "legacy-refresh-token" } },
    {
      accounts: [
        {
          access_token: "partial-access-token",
          refresh_token: "partial-refresh-token",
          account_id: "partial-account",
        },
      ],
      updated_at_ms: Date.now(),
    },
  ];

  try {
    for (const record of malformedRecords) {
      kvStore.clear();
      kvStore.set(keyToString(CODEX_AUTH_KEY), record);

      const response = await handleHealthUpstream();
      const text = await response.text();
      const payload = JSON.parse(text) as {
        status?: unknown;
        probes?: { codex?: { status?: unknown } };
      };

      assert.equal(response.status, 503);
      assert.equal(payload.status, 503);
      assert.equal(payload.probes?.codex?.status, 503);
      assert.ok(text.length < 2_048);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("active upstream health preserves the provider that finishes before the shared deadline", async () => {
  const originalApiKey = process.env.METERED_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.METERED_API_KEY = "metered-api-key";
  setActiveUpstreamHealthTimeoutMsForTest(20);

  const restoreEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  };
  const waitForAbort = (signal: AbortSignal | null | undefined): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      if (!signal) {
        reject(new Error("health probe did not pass an abort signal"));
        return;
      }
      const rejectWithReason = () => {
        reject(new Error("health probe fetch was aborted", { cause: signal.reason }));
      };
      if (signal.aborted) rejectWithReason();
      else signal.addEventListener("abort", rejectWithReason, { once: true });
    });
  const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

  try {
    for (const stalledProvider of ["codex", "metered"] as const) {
      kvStore.clear();
      kvStore.set(keyToString(CODEX_AUTH_KEY), makeAuthPool(makeAuthEntry(Math.floor(Date.now() / 1000) + 3600)));
      globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const isCodex = url.hostname === "chatgpt.com";
        if ((stalledProvider === "codex" && isCodex) || (stalledProvider === "metered" && !isCodex)) {
          return waitForAbort(init?.signal);
        }
        if (isCodex) return Promise.resolve(jsonResponse({ models: [{ slug: "gpt-health" }] }));
        if (url.pathname === "/api/usage/token/") {
          return Promise.resolve(
            jsonResponse({
              success: true,
              data: {
                total_available: 1_000_000,
                total_granted: 1_000_000,
                total_used: 10,
                unlimited_quota: false,
              },
            })
          );
        }
        throw new Error(`Unexpected Metered URL: ${url.href}`);
      });

      const response = await handleHealthUpstream();
      const payload = (await response.json()) as {
        probes?: {
          codex?: { status?: number; error?: string };
          metered_quota?: { status?: number; error?: string } | null;
        };
      };
      assert.equal(response.status, 503, stalledProvider);
      if (stalledProvider === "codex") {
        assert.equal(payload.probes?.codex?.status, 503);
        assert.equal(payload.probes.codex.error, "Codex models probe timed out.");
        assert.equal(payload.probes.metered_quota?.status, 200);
      } else {
        assert.equal(payload.probes?.codex?.status, 200);
        assert.equal(payload.probes.metered_quota?.status, 503);
        assert.equal(payload.probes.metered_quota.error, "Metered quota probe timed out.");
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    setActiveUpstreamHealthTimeoutMsForTest(null);
    restoreEnv("METERED_API_KEY", originalApiKey);
  }
});
