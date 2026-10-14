import assert from "node:assert/strict";
import { apiKeyHashKey, apiKeyIdKey, PAID_FALLBACK_NO_LIMIT } from "../src/api-keys.ts";
import { CODEX_AUTH_POOL_KV_KEY, resetCodexAuthCacheForTest } from "../src/codex/index.ts";
import { config } from "../src/config.ts";
import { setKvForTest } from "../src/kv.ts";
import { handleResponses } from "../src/responses-handler.ts";
import { resetProviderHealthThrottleForTest } from "../src/provider/health.ts";
import { resetRuntimeConfigCacheForTest, RUNTIME_CONFIG_V2_KEY } from "../src/runtime-config.ts";
import { METERED_BASE_URL } from "../src/provider/metered.ts";
import { CODEX_ACCOUNT_ROUTING_KV_KEY, type CodexAccountRoutingState, selectCodexRoutingAccountsStrong } from "../src/codex/account-routing.ts";
import { markCodexQuotaBlocked } from "../src/codex/rate-limit-429.ts";
import type { CodexAuthPoolState } from "../src/types.ts";

type StoredEntry = {
  key: Deno.KvKey;
  value: unknown;
  versionstamp: string;
  expiresAtMs: number | null;
};

type AtomicMutation = { type: "set"; key: Deno.KvKey; value: unknown; options?: { expireIn?: number } } | { type: "delete"; key: Deno.KvKey };

const encodeKey = (key: Deno.KvKey): string => JSON.stringify(key);
const clone = <T>(value: T): T => structuredClone(value);

class MemoryKv {
  readonly entries = new Map<string, StoredEntry>();
  #version = 0;

  clear(): void {
    this.entries.clear();
    this.#version = 0;
  }

  #nextVersionstamp(): string {
    this.#version += 1;
    return String(this.#version).padStart(20, "0");
  }

  #purgeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= now) {
        this.entries.delete(key);
      }
    }
  }

  #write(key: Deno.KvKey, value: unknown, options: { expireIn?: number } | undefined, versionstamp: string): void {
    this.entries.set(encodeKey(key), {
      key: clone(key),
      value: clone(value),
      versionstamp,
      expiresAtMs: options?.expireIn === undefined ? null : Date.now() + Math.max(0, options.expireIn),
    });
  }

  get<T = unknown>(key: Deno.KvKey, _options?: { consistency?: Deno.KvConsistencyLevel }): Promise<Deno.KvEntryMaybe<T>> {
    this.#purgeExpired();
    const entry = this.entries.get(encodeKey(key));
    return Promise.resolve({
      key: clone(key),
      value: entry ? (clone(entry.value) as T) : null,
      versionstamp: entry?.versionstamp ?? null,
    } as Deno.KvEntryMaybe<T>);
  }

  getMany<T extends readonly unknown[]>(
    keys: readonly Deno.KvKey[],
    _options?: { consistency?: Deno.KvConsistencyLevel }
  ): Promise<{ [K in keyof T]: Deno.KvEntryMaybe<T[K]> }> {
    // Snapshot every value and versionstamp synchronously so one resolved tuple
    // cannot mix rows from different write generations.
    this.#purgeExpired();
    const snapshot = keys.map((key) => {
      const entry = this.entries.get(encodeKey(key));
      return {
        key: clone(key),
        value: entry ? clone(entry.value) : null,
        versionstamp: entry?.versionstamp ?? null,
      };
    });
    return Promise.resolve(snapshot as { [K in keyof T]: Deno.KvEntryMaybe<T[K]> });
  }

  set(key: Deno.KvKey, value: unknown, options?: { expireIn?: number }): Promise<Deno.KvCommitResult> {
    const versionstamp = this.#nextVersionstamp();
    this.#write(key, value, options, versionstamp);
    return Promise.resolve({ ok: true, versionstamp });
  }

  delete(key: Deno.KvKey): Promise<void> {
    this.#purgeExpired();
    this.entries.delete(encodeKey(key));
    this.#nextVersionstamp();
    return Promise.resolve();
  }

  atomic(): Deno.AtomicOperation {
    const checks: { key: Deno.KvKey; versionstamp: string | null }[] = [];
    const mutations: AtomicMutation[] = [];
    const operation = {
      check: (...entries: { key: Deno.KvKey; versionstamp: string | null }[]) => {
        checks.push(...entries.map((entry) => ({ key: clone(entry.key), versionstamp: entry.versionstamp })));
        return operation;
      },
      set: (key: Deno.KvKey, value: unknown, options?: { expireIn?: number }) => {
        mutations.push({ type: "set", key: clone(key), value: clone(value), options });
        return operation;
      },
      delete: (key: Deno.KvKey) => {
        mutations.push({ type: "delete", key: clone(key) });
        return operation;
      },
      commit: (): Promise<Deno.KvCommitResult | Deno.KvCommitError> => {
        this.#purgeExpired();
        for (const check of checks) {
          const current = this.entries.get(encodeKey(check.key));
          if ((current?.versionstamp ?? null) !== check.versionstamp) {
            return Promise.resolve({ ok: false });
          }
        }

        const versionstamp = this.#nextVersionstamp();
        for (const mutation of mutations) {
          if (mutation.type === "delete") {
            this.entries.delete(encodeKey(mutation.key));
          } else {
            this.#write(mutation.key, mutation.value, mutation.options, versionstamp);
          }
        }
        return Promise.resolve({ ok: true, versionstamp });
      },
    };
    return operation as unknown as Deno.AtomicOperation;
  }

  close(): void {}
}

type HttpOutcome = Readonly<{
  name: string;
  kind: "http";
  status: number;
}>;

type TransportOutcome = Readonly<{ name: "timeout"; kind: "timeout" }> | Readonly<{ name: "network"; kind: "network" }>;

type Outcome = HttpOutcome | TransportOutcome;

const OUTCOMES: readonly Outcome[] = [
  { name: "401", kind: "http", status: 401 },
  { name: "403", kind: "http", status: 403 },
  { name: "429", kind: "http", status: 429 },
  { name: "400", kind: "http", status: 400 },
  { name: "404", kind: "http", status: 404 },
  { name: "409", kind: "http", status: 409 },
  { name: "422", kind: "http", status: 422 },
  { name: "503", kind: "http", status: 503 },
  { name: "timeout", kind: "timeout" },
  { name: "network", kind: "network" },
];

const MODEL = "gpt-5-routing-matrix";
const KEY_ID = "routing-matrix-key";
const KEY_HASH = "routing-matrix-hash";
const ACCOUNT_IDS = ["account-one", "account-two"] as const;
const CODEX_RESPONSES_URL = `${config.codexBaseUrl}/responses`;
const CODEX_REFRESH_URL = "https://auth.openai.com/oauth/token";
const METERED_RESPONSES_URL = `${METERED_BASE_URL}/v1/responses`;
const encoder = new TextEncoder();

const is401 = (outcome: Outcome): boolean => outcome.kind === "http" && outcome.status === 401;
const is429 = (outcome: Outcome): boolean => outcome.kind === "http" && outcome.status === 429;

const directStatus = (outcome: Outcome): number => {
  if (outcome.kind === "timeout") return 504;
  if (outcome.kind === "network") return 502;
  return outcome.status;
};

const errorTypeForStatus = (status: number): string => {
  if (status >= 500) return "server_error";
  if (status === 429) return "rate_limit_error";
  return "invalid_request_error";
};

const jsonErrorResponse = (status: number): Response =>
  new Response(
    JSON.stringify({
      error: {
        message: `Codex fixture ${status}`,
        type: errorTypeForStatus(status),
        code: status === 429 ? "rate_limit_exceeded" : `fixture_${status}`,
        param: null,
      },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );

const meteredSuccessResponse = (): Response => {
  const chunks = [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_matrix", created_at: 0 } })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_matrix",
        status: "completed",
        model: MODEL,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "metered routing matrix" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })}\n\n`,
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Oneapi-Request-Id": "metered-routing-matrix",
      },
    }
  );
};

type ActiveRun = {
  outcomes: readonly [Outcome, Outcome];
  codexCalls: Record<(typeof ACCOUNT_IDS)[number], number>;
  refreshCalls: Record<(typeof ACCOUNT_IDS)[number], number>;
  meteredCalls: number;
  infoLogs: unknown[][];
};

const memoryKv = new MemoryKv();
const kv = memoryKv as unknown as Deno.Kv;
let activeRun: ActiveRun | null = null;

const seedFixture = async (): Promise<void> => {
  memoryKv.clear();
  const now = Date.now();
  const authPool = {
    accounts: ACCOUNT_IDS.map((accountId, index) => ({
      access_token: `access-${index + 1}`,
      refresh_token: `refresh-${index + 1}`,
      account_id: accountId,
      updated_at_ms: now,
    })),
    updated_at_ms: now,
  };
  const runtimeConfig = {
    version: 2,
    default_model: MODEL,
    default_reasoning_effort: "low",
    codex_models: {
      source: "chatgpt_codex",
      client_version: "0.100.0",
      updated_at_ms: now,
      models: [
        {
          slug: MODEL,
          default_reasoning_level: "low",
          supported_reasoning_levels: ["none", "low", "medium", "high"],
        },
      ],
    },
    updated_at_ms: now,
  };
  const commonPaidFallbackPolicy = {
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: PAID_FALLBACK_NO_LIMIT,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  const keyRecord = {
    id: KEY_ID,
    name: "Routing matrix key",
    prefix: "u_matrix",
    hash: KEY_HASH,
    created_at_ms: now,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: -1,
    usage_requests: 0,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    ...commonPaidFallbackPolicy,
    paid_fallback_model_ids: [MODEL],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_max_exposure_microcredits: {},
    paid_fallback_pricing_checked_at_ms: now,
  };
  const hashRecord = {
    id: KEY_ID,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: -1,
    usage_requests: 0,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    ...commonPaidFallbackPolicy,
  };

  await Promise.all([
    memoryKv.set(CODEX_AUTH_POOL_KV_KEY, authPool),
    memoryKv.set(RUNTIME_CONFIG_V2_KEY, runtimeConfig),
    memoryKv.set(apiKeyIdKey(KEY_ID), keyRecord),
    memoryKv.set(apiKeyHashKey(KEY_HASH), hashRecord),
  ]);
  resetCodexAuthCacheForTest();
  resetRuntimeConfigCacheForTest();
  resetProviderHealthThrottleForTest();
};

const accountForRefreshToken = (refreshToken: unknown): (typeof ACCOUNT_IDS)[number] => {
  if (refreshToken === "refresh-1") return ACCOUNT_IDS[0];
  if (refreshToken === "refresh-2") return ACCOUNT_IDS[1];
  throw new Error(`Unexpected refresh token fixture: ${String(refreshToken)}`);
};

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const mockedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const run = activeRun;
  if (!run) throw new Error("Routing matrix fetch occurred without an active case.");
  const url = requestUrl(input);

  if (url === CODEX_REFRESH_URL) {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { refresh_token?: unknown }) : {};
    const accountId = accountForRefreshToken(body.refresh_token);
    run.refreshCalls[accountId] += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: `refreshed-${accountId}`,
          refresh_token: body.refresh_token,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  }

  if (url === METERED_RESPONSES_URL) {
    run.meteredCalls += 1;
    return Promise.resolve(meteredSuccessResponse());
  }

  if (url === `${METERED_BASE_URL}/v1/models`) {
    return Promise.resolve(Response.json({ data: [{ id: MODEL, supported_endpoint_types: ["openai-response"] }] }));
  }

  if (url !== CODEX_RESPONSES_URL) throw new Error(`Unexpected routing matrix URL: ${url}`);
  const accountId = new Headers(init?.headers).get("ChatGPT-Account-ID");
  const accountIndex = ACCOUNT_IDS.indexOf(accountId as (typeof ACCOUNT_IDS)[number]);
  if (accountIndex < 0) throw new Error(`Unexpected Codex account fixture: ${String(accountId)}`);
  const typedAccountId = ACCOUNT_IDS[accountIndex];
  run.codexCalls[typedAccountId] += 1;
  const outcome = run.outcomes[accountIndex];
  if (outcome.kind === "network") return Promise.reject(new TypeError("Codex fixture network failure"));
  if (outcome.kind === "timeout") {
    return Promise.reject(new DOMException("Codex fixture timeout", "TimeoutError"));
  }
  return Promise.resolve(jsonErrorResponse(outcome.status));
};

const retryLogs = (logs: readonly unknown[][]): Record<string, unknown>[] =>
  logs.flatMap((args) => {
    if (args[0] !== "[ai.ubq.fi] codex_routing" || typeof args[1] !== "string") return [];
    try {
      const fields = JSON.parse(args[1]) as Record<string, unknown>;
      return fields.event === "codex_two_second_retry" ? [fields] : [];
    } catch {
      return [];
    }
  });

const drainBackgroundTasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const runCase = async (first: Outcome, second: Outcome, sequence: number): Promise<void> => {
  await seedFixture();
  const run: ActiveRun = {
    outcomes: [first, second],
    codexCalls: { "account-one": 0, "account-two": 0 },
    refreshCalls: { "account-one": 0, "account-two": 0 },
    meteredCalls: 0,
    infoLogs: [],
  };
  const label = `${first.name} -> ${second.name}`;
  activeRun = run;
  try {
    const response = await handleResponses(
      new Request("https://ai.ubq.fi/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, input: "routing matrix" }),
      }),
      {
        keyId: KEY_ID,
        // Admission identity must not alter the explicit account ordering.
        idempotencyPrincipal: "matrix-0",
        kernelRepo: null,
        kernelOrg: null,
        requestId: `routing-matrix-${sequence}-${first.name}-${second.name}`,
        startedAtMs: Date.now(),
      }
    );

    const reachesSecond = is401(first);
    // Serial routing keeps one active account: only a final credential
    // invalidity moves the request to the second configured account. A generic
    // 429 stays on the same account with one bounded retry, and a raw 403 with
    // a still-valid bearer is terminal.
    const firstAuthRetry = is401(first) ? 1 : 0;
    const firstGenericRetry = is429(first) ? 1 : 0;
    const secondAuthRetry = reachesSecond && is401(second) ? 1 : 0;
    const secondGenericRetry = reachesSecond && is429(second) ? 1 : 0;
    const terminalCodexOutcome = reachesSecond ? second : first;
    const allCredentialsInvalid = is401(first) && is401(second);
    let expectedStatus = directStatus(terminalCodexOutcome);
    if (is401(terminalCodexOutcome)) expectedStatus = 503;
    if (allCredentialsInvalid) expectedStatus = 200;
    assert.equal(response.status, expectedStatus, `${label}: final status`);
    assert.equal(response.headers.get("x-uos-upstream"), allCredentialsInvalid ? "metered" : "chatgpt_codex", `${label}: selected upstream`);
    assert.equal(run.meteredCalls, allCredentialsInvalid ? 1 : 0, `${label}: paid fallback requires complete authoritative unavailability`);
    assert.equal(run.codexCalls["account-one"], 1 + firstAuthRetry + firstGenericRetry, `${label}: account one attempt count`);
    assert.equal(run.codexCalls["account-two"], reachesSecond ? 1 + secondAuthRetry + secondGenericRetry : 0, `${label}: account two attempt count`);
    assert.equal(run.refreshCalls["account-one"], firstAuthRetry, `${label}: account one refresh count`);
    assert.equal(run.refreshCalls["account-two"], secondAuthRetry, `${label}: account two refresh count`);

    const retries = retryLogs(run.infoLogs);
    assert.equal(retries.length, firstGenericRetry + secondGenericRetry, `${label}: bounded retry count`);
    for (const retry of retries) {
      assert.equal(retry.delay_ms, 0, `${label}: generic 429 recheck must be immediate`);
    }
    await response.arrayBuffer();
    await drainBackgroundTasks();
  } finally {
    activeRun = null;
  }
};

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
};

Deno.test("two-account Codex-to-Metered /v1/responses routing matrix", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalMeteredApiKey = Deno.env.get("METERED_API_KEY");
  setKvForTest(kv);
  globalThis.fetch = mockedFetch;
  console.info = (...args: unknown[]) => activeRun?.infoLogs.push(args);
  console.warn = () => {};
  console.error = () => {};
  Deno.env.set("METERED_API_KEY", "metered-routing-matrix-key");

  try {
    await t.step("Cartesian outcome matrix", async () => {
      let sequence = 0;
      for (const first of OUTCOMES) {
        for (const second of OUTCOMES) {
          sequence += 1;
          await runCase(first, second, sequence);
        }
      }
    });

    await t.step("every first-account 5xx returns directly", async () => {
      const second = OUTCOMES.find((outcome) => outcome.name === "429");
      assert.ok(second);
      for (const [index, status] of [500, 501, 502, 503, 504, 599].entries()) {
        await runCase({ name: String(status), kind: "http", status }, second, 10_000 + index);
      }
    });

    await t.step("every reached second-account 5xx returns directly", async () => {
      const first = OUTCOMES.find((outcome) => outcome.name === "401");
      assert.ok(first);
      for (const [index, status] of [500, 501, 502, 503, 504, 599].entries()) {
        await runCase(first, { name: String(status), kind: "http", status }, 20_000 + index);
      }
    });
  } finally {
    await drainBackgroundTasks();
    activeRun = null;
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
    restoreEnv("METERED_API_KEY", originalMeteredApiKey);
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
    resetProviderHealthThrottleForTest();
    setKvForTest(null);
  }
});

Deno.test("mixed exhausted and current-invalid Codex subscriptions fail over to the same model", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalMeteredApiKey = Deno.env.get("METERED_API_KEY");
  const originalSurplusApiKey = Deno.env.get("SURPLUS_API_KEY");
  setKvForTest(kv);
  Deno.env.set("METERED_API_KEY", "mixed-unavailable-test-key");
  Deno.env.delete("SURPLUS_API_KEY");
  try {
    const scenarios = ["mixed", "all-invalid", "disabled", "cap-denied", "paid-failure", "generic-429", "stale-fingerprint"] as const;
    for (const scenario of scenarios) {
      await t.step(scenario, async () => {
        const calls: string[] = [];
        let paidModel: unknown = null;
        await seedFixture();
        const pool = (await memoryKv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY)).value;
        assert.ok(pool);
        const selected = await selectCodexRoutingAccountsStrong(pool, pool.accounts, Date.now(), MODEL);
        assert.equal(selected.kind, "eligible");
        if (scenario !== "all-invalid") {
          const resetAt = Math.floor(Date.now() / 1000) + 453_376;
          await markCodexQuotaBlocked(
            selected.accounts[0],
            Response.json({ error: { type: "usage_limit_reached", resets_at: resetAt } }, { status: 429, headers: { "Retry-After": "453376" } })
          );
        }
        if (scenario === "stale-fingerprint") {
          const state = (await memoryKv.get<CodexAccountRoutingState>(CODEX_ACCOUNT_ROUTING_KV_KEY)).value;
          assert.ok(state);
          const second = state.slots[1];
          assert.ok(second);
          await memoryKv.set(CODEX_ACCOUNT_ROUTING_KV_KEY, { ...state, slots: [state.slots[0], { ...second, invalid_credential_version: "stale-version" }] });
        }
        if (scenario === "cap-denied") {
          const key = (await memoryKv.get<Record<string, unknown>>(apiKeyIdKey(KEY_ID))).value;
          await memoryKv.set(apiKeyIdKey(KEY_ID), { ...key, paid_fallback_limit_microcredits: 0 });
        }
        globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = requestUrl(input);
          calls.push(url);
          if (url === CODEX_RESPONSES_URL) {
            if (scenario === "stale-fingerprint") return Promise.resolve(meteredSuccessResponse());
            return Promise.resolve(jsonErrorResponse(scenario === "generic-429" ? 429 : 401));
          }
          if (url === CODEX_REFRESH_URL) return Promise.resolve(jsonErrorResponse(401));
          if (url === `${METERED_BASE_URL}/v1/models`) {
            return Promise.resolve(Response.json({ data: [{ id: MODEL, supported_endpoint_types: ["openai-response"] }] }));
          }
          if (url === METERED_RESPONSES_URL) {
            const body = init?.body;
            if (typeof body !== "string") throw new Error("paid fixture requires a serialized JSON request");
            paidModel = JSON.parse(body).model;
            return Promise.resolve(scenario === "paid-failure" ? jsonErrorResponse(503) : meteredSuccessResponse());
          }
          throw new Error(`Unexpected mixed-unavailable fixture URL: ${url}`);
        };
        const response = await handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", { method: "POST", body: JSON.stringify({ model: MODEL, input: "mixed unavailable", stream: false }) }),
          {
            keyId: KEY_ID,
            requestId: `mixed-unavailable-${scenario}`,
            startedAtMs: Date.now(),
            paidFallbackEnabled: scenario !== "disabled",
            kernelOrg: null,
            kernelRepo: null,
          }
        );
        const payload = await response.json();
        const paidExpected = ["mixed", "all-invalid", "paid-failure"].includes(scenario);
        const completedExpected = scenario === "mixed" || scenario === "all-invalid" || scenario === "stale-fingerprint";
        let expectedStatus = 503;
        if (scenario === "generic-429") expectedStatus = 429;
        if (completedExpected) expectedStatus = 200;
        assert.equal(response.status, expectedStatus, JSON.stringify(payload));
        assert.equal(response.headers.get("retry-after"), null);
        assert.equal(calls.filter((url) => url === METERED_RESPONSES_URL).length, paidExpected ? 1 : 0);
        if (completedExpected) assert.equal(payload.status, "completed");
        if (paidExpected) assert.equal(paidModel, MODEL);
        if (scenario === "disabled" || scenario === "cap-denied") assert.equal(payload.error.code, "codex_subscriptions_unavailable");
        if (scenario === "mixed") {
          assert.equal(response.headers.get("x-uos-upstream"), "metered");
          assert.equal(calls.filter((url) => url === CODEX_RESPONSES_URL).length, 1);
          assert.equal(calls.filter((url) => url === CODEX_REFRESH_URL).length, 1);
          const current = await selectCodexRoutingAccountsStrong(pool, pool.accounts, Date.now(), MODEL);
          assert.equal(current.kind, "quota_blocked");
          assert.equal(current.fullCohortExhausted, false);
        }
      });
    }
  } finally {
    await drainBackgroundTasks();
    globalThis.fetch = originalFetch;
    restoreEnv("METERED_API_KEY", originalMeteredApiKey);
    restoreEnv("SURPLUS_API_KEY", originalSurplusApiKey);
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
    setKvForTest(null);
  }
});
