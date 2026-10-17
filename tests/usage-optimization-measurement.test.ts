import { createFetchMock } from "./helpers/fetch-mock.ts";
import type { Kv } from "#kv";
import { test } from "bun:test";
import { setKvForTest } from "../src/kv.ts";
import assert from "node:assert/strict";
import { classifyKvKey, CountingKv, type KvMeasurementContext, type KvOperationBudget } from "./helpers/counting-kv.ts";

const textEncoder = new TextEncoder();
const MODEL = "gpt-5-usage-measurement";
const UOS_ALLOWLIST_TOKEN = "uos-usage-measurement-token";
const ADMIN_ALLOWLIST_TOKEN = "admin-usage-measurement-token";

type UpstreamReply = Readonly<{
  body: BodyInit;
  responseBytes: number;
  status?: number;
  headers?: HeadersInit;
  waitFor?: Promise<void>;
}>;

const bytes = (value: string): number => textEncoder.encode(value).byteLength;

const completedSse = (label: string): string =>
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: `resp-${label}`,
      model: MODEL,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `measurement ${label}` }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  })}\n\n`;

const sseReply = (label: string, options: Readonly<{ waitFor?: Promise<void> }> = {}): UpstreamReply => {
  const body = completedSse(label);
  return {
    body,
    responseBytes: bytes(body),
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...options,
  };
};

const errorReply = (status: number, type = "server_error", retryAfter?: string): UpstreamReply => {
  const body = JSON.stringify({ error: { message: "measurement upstream failure", type } });
  return {
    body,
    responseBytes: bytes(body),
    status,
    headers: { "Content-Type": "application/json", ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
  };
};

const cancellableSseReply = (): UpstreamReply => {
  const firstEvent = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`;
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(textEncoder.encode(firstEvent));
      },
    }),
    responseBytes: bytes(firstEvent),
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  };
};

const inferenceRequest = (token: string, stream = false): Request =>
  new Request("https://ai.ubq.fi/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: "measure the exact wire body", ...(stream ? { stream: true } : {}) }),
  });

const settleBackgroundWork = async (commandCount: () => number): Promise<void> => {
  let previous = commandCount();
  let stableTurns = 0;
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const current = commandCount();
    stableTurns = current === previous ? stableTurns + 1 : 0;
    if (stableTurns >= 2) return;
    previous = current;
  }
  throw new Error("background KV work did not settle before the measurement window closed");
};

const restoreEnvironment = (saved: ReadonlyMap<string, string | undefined>): void => {
  for (const [key, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
};

const budgetFor = (budgets: KvOperationBudget[], scenario: string): KvOperationBudget => {
  const budget = budgets.find((candidate) => candidate.scenario === scenario);
  assert.ok(budget, `missing measurement budget for ${scenario}`);
  return budget;
};

test("usage optimization fixture records per-auth KV commands, atomic commits, and Codex wire bytes", async () => {
  const savedEnvironment = new Map<string, string | undefined>([
    ["UOS_AI_TOKEN", process.env.UOS_AI_TOKEN],
    ["DENO_DEPLOY_TOKEN", process.env.DENO_DEPLOY_TOKEN],
  ]);
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const kv = new CountingKv();
  let queuedReplies: UpstreamReply[] = [];
  let fetchCalls = 0;
  let onFetch: (() => void) | null = null;

  process.env.UOS_AI_TOKEN = UOS_ALLOWLIST_TOKEN;
  process.env.DENO_DEPLOY_TOKEN = ADMIN_ALLOWLIST_TOKEN;
  console.info = (...args: unknown[]): void => {
    if (args[0] === "[usage-optimization] operation-byte-budget") originalInfo(...args);
  };
  console.warn = (): void => {};
  console.error = (): void => {};

  try {
    setKvForTest(kv as unknown as Kv);
    const { default: handler } = await import("../src/handler/index.ts");
    const { sha256Base64Url } = await import("../src/utils.ts");
    const { RUNTIME_CONFIG_V2_KEY, resetRuntimeConfigCacheForTest } = await import("../src/runtime-config.ts");
    const { CODEX_AUTH_POOL_KV_KEY, fetchCodexResponses, resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
    const { resetApiKeyPolicyCacheForTest } = await import("../src/api-key-policy.ts");
    const { resetProviderHealthThrottleForTest } = await import("../src/provider/health.ts");

    globalThis.fetch = createFetchMock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      let url: string;
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.toString();
      else url = input.url;
      assert.ok(url.endsWith("/responses"), `measurement fixture only permits Codex response requests, got ${url}`);
      assert.equal(typeof init?.body, "string", "Codex request must reach fetch as a serialized string");
      kv.recordSerializedRequestBytes(bytes(init?.body as string));
      const reply = queuedReplies.shift();
      assert.ok(reply, "unexpected Codex transport call");
      fetchCalls += 1;
      onFetch?.();
      if (reply.waitFor) await reply.waitFor;
      kv.recordUpstreamResponseBytes(reply.responseBytes);
      return new Response(reply.body, { status: reply.status ?? 200, headers: reply.headers });
    });

    const runtime = () => ({
      version: 2,
      default_model: MODEL,
      default_reasoning_effort: "medium",
      codex_models: {
        source: "chatgpt_codex",
        client_version: "0.150.0",
        updated_at_ms: Date.now(),
        models: [
          {
            slug: MODEL,
            default_reasoning_level: "medium",
            supported_reasoning_levels: ["none", "low", "medium", "high"],
          },
        ],
      },
      updated_at_ms: Date.now(),
    });

    const codexAuthPool = () => ({
      accounts: [
        {
          access_token: "measurement-access-token",
          refresh_token: "measurement-refresh-token",
          account_id: "measurement-account",
          updated_at_ms: Date.now(),
        },
      ],
      updated_at_ms: Date.now(),
    });

    const seedApiKey = async (token: string, id: string, limit: number): Promise<void> => {
      const hash = await sha256Base64Url(token);
      const resetAtMs = Date.now() + 60_000;
      kv.seed(["ubq_ai", "api_keys", "hash", hash], {
        id,
        expires_at_ms: -1,
        revoked_at_ms: null,
        usage_limit_requests: limit,
        usage_requests: 0,
        usage_reset_at_ms: resetAtMs,
        window_ms: 60_000,
        usage_quota_version: 3,
        paid_fallback_enabled: false,
        paid_fallback_limit_microcredits: 0,
        paid_fallback_spent_microcredits: 0,
        paid_fallback_reserved_microcredits: 0,
        paid_fallback_reservation_request_id: null,
      });
    };

    const prepare = async (apiKey?: Readonly<{ token: string; id: string; limit: number }>): Promise<void> => {
      kv.clearData();
      resetApiKeyPolicyCacheForTest();
      resetRuntimeConfigCacheForTest();
      resetCodexAuthCacheForTest();
      resetProviderHealthThrottleForTest();
      kv.seed(RUNTIME_CONFIG_V2_KEY, runtime());
      kv.seed(CODEX_AUTH_POOL_KV_KEY, codexAuthPool());
      if (apiKey) await seedApiKey(apiKey.token, apiKey.id, apiKey.limit);
    };

    const queue = (...replies: UpstreamReply[]): void => {
      queuedReplies = [...replies];
      fetchCalls = 0;
      onFetch = null;
    };

    const runScenario = async <T>(context: KvMeasurementContext, run: () => Promise<T>): Promise<T> => {
      const finish = kv.beginMeasurement(context);
      const startedAt = performance.now();
      try {
        return await run();
      } finally {
        const latencyMs = performance.now() - startedAt;
        await settleBackgroundWork(() => kv.commands.length);
        kv.setLatency(latencyMs);
        finish();
      }
    };

    assert.equal(classifyKvKey(["uos_ai", "api_key_usage", "v3", "key"]), "mandatory_correctness");
    assert.equal(classifyKvKey(["ubq_ai", "prompt_cache_telemetry", "v1"]), "optional_telemetry");

    const boundedToken = `u_${"1".repeat(64)}`;
    await prepare({ token: boundedToken, id: "bounded-measurement", limit: 2 });
    queue(sseReply("bounded"));
    const bounded = await runScenario({ authKind: "bounded_api_key", outcome: "success" }, () => handler(inferenceRequest(boundedToken)));
    assert.equal(bounded.status, 200);
    assert.equal(fetchCalls, 1);

    const unlimitedToken = `u_${"2".repeat(64)}`;
    await prepare({ token: unlimitedToken, id: "unlimited-measurement", limit: -1 });
    queue(sseReply("unlimited"));
    const unlimited = await runScenario({ authKind: "unlimited_api_key", outcome: "success" }, () => handler(inferenceRequest(unlimitedToken)));
    assert.equal(unlimited.status, 200);
    assert.equal(fetchCalls, 1);

    await prepare();
    queue(sseReply("uos"));
    const uos = await runScenario({ authKind: "uos_allowlist", outcome: "success" }, () => handler(inferenceRequest(UOS_ALLOWLIST_TOKEN)));
    assert.equal(uos.status, 200);
    assert.equal(fetchCalls, 1);

    await prepare();
    queue(sseReply("admin"));
    const admin = await runScenario({ authKind: "admin_allowlist", outcome: "success" }, () => handler(inferenceRequest(ADMIN_ALLOWLIST_TOKEN)));
    assert.equal(admin.status, 200);
    assert.equal(fetchCalls, 1);

    const upstreamFailureToken = `u_${"3".repeat(64)}`;
    await prepare({ token: upstreamFailureToken, id: "upstream-failure-measurement", limit: 2 });
    queue(errorReply(503));
    const upstreamFailure = await runScenario({ authKind: "bounded_api_key", outcome: "upstream_failure" }, () =>
      handler(inferenceRequest(upstreamFailureToken))
    );
    assert.equal(upstreamFailure.status, 503);
    assert.equal(fetchCalls, 1);

    await prepare();
    const retryBody = { model: MODEL, input: "retry must preserve the same serialized body" };
    queue(errorReply(429, "rate_limit_error", "1"), sseReply("retry"));
    const retried = await runScenario({ authKind: "codex_auth_pool", outcome: "retry" }, () => fetchCodexResponses(retryBody, { retrySleep: async () => {} }));
    assert.equal(retried.status, 200);
    assert.equal(fetchCalls, 2, "bounded Codex retry must dispatch exactly twice");

    const disconnectToken = `u_${"4".repeat(64)}`;
    await prepare({ token: disconnectToken, id: "disconnect-measurement", limit: 2 });
    queue(cancellableSseReply());
    await runScenario({ authKind: "bounded_api_key", outcome: "client_disconnect" }, async () => {
      const response = await handler(inferenceRequest(disconnectToken, true));
      assert.equal(response.status, 200);
      assert.ok(response.body);
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false);
      await reader.cancel("measurement client disconnected");
    });
    assert.equal(fetchCalls, 1);

    const concurrentToken = `u_${"5".repeat(64)}`;
    await prepare({ token: concurrentToken, id: "concurrent-measurement", limit: 1 });
    let releaseUpstream = (): void => {};
    const upstreamGate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    queue(sseReply("concurrent", { waitFor: upstreamGate }));
    const firstFetch = new Promise<void>((resolve) => {
      onFetch = resolve;
    });
    const concurrentResponses = await runScenario({ authKind: "bounded_api_key", outcome: "concurrent_admission" }, async () => {
      const pending = Array.from({ length: 8 }, () => handler(inferenceRequest(concurrentToken)));
      await firstFetch;
      releaseUpstream();
      return await Promise.all(pending);
    });
    assert.equal(concurrentResponses.filter((response) => response.status === 200).length, 1);
    const quotaResponses = concurrentResponses.filter((response) => response.status === 429);
    assert.equal(quotaResponses.length, 7);
    assert.equal(fetchCalls, 1, "over-limit concurrent admissions must not reach the upstream");

    assert.equal(queuedReplies.length, 0, "every planned upstream response must be consumed");
    const budgets = kv.budgets();
    assert.equal(
      kv.commands.some((record) => record.scenario === null),
      false,
      "fixture commands must remain attributed to an auth-kind and outcome scenario"
    );
    const expectedScenarios = [
      "admin_allowlist:success",
      "bounded_api_key:client_disconnect",
      "bounded_api_key:concurrent_admission",
      "bounded_api_key:success",
      "bounded_api_key:upstream_failure",
      "codex_auth_pool:retry",
      "unlimited_api_key:success",
      "uos_allowlist:success",
    ];
    assert.deepEqual(
      budgets.map((budget) => budget.scenario),
      expectedScenarios
    );

    for (const budget of budgets) {
      assert.ok(budget.commands > 0, `${budget.scenario} must record KV commands`);
      assert.ok(budget.serialized_request_bytes > 0, `${budget.scenario} must measure outbound request bytes`);
      assert.ok(budget.upstream_response_bytes > 0, `${budget.scenario} must measure upstream response bytes`);
      assert.notEqual(budget.latency_ms, null, `${budget.scenario} must report latency`);
    }

    const boundedSuccess = budgetFor(budgets, "bounded_api_key:success");
    const unlimitedSuccess = budgetFor(budgets, "unlimited_api_key:success");
    const uosSuccess = budgetFor(budgets, "uos_allowlist:success");
    const adminSuccess = budgetFor(budgets, "admin_allowlist:success");
    const retry = budgetFor(budgets, "codex_auth_pool:retry");
    const disconnect = budgetFor(budgets, "bounded_api_key:client_disconnect");
    const concurrent = budgetFor(budgets, "bounded_api_key:concurrent_admission");

    assert.ok(boundedSuccess.atomic_commits >= 2, "bounded admission must retain durable V3 reservation and dispatch");
    assert.ok(unlimitedSuccess.atomic_commits >= 2, "unlimited admission still records dispatch exactly once");
    assert.ok(uosSuccess.commands > 0, "UOS allowlist activity must remain measurable");
    assert.ok(adminSuccess.commands > 0, "admin allowlist activity must remain measurable");
    assert.equal(retry.serialized_request_bytes, bytes(JSON.stringify(retryBody)) * 2);
    // The terminal usage rollup is deliberate per-response observability
    // accounting for routes the paid ledger never sees (the Codex subscription
    // path here): one bounded strong read plus one compare-and-set merge for a
    // response whose usage was observed. It is recorded here instead of
    // absorbed.
    const usageRollupCommandsFor = (scenario: string) =>
      kv.commands.filter(
        (record) => record.scenario === scenario && record.keys.some((key) => key[0] === "uos_ai" && key[1] === "paid_fallback" && key[3] === "usage_rollup")
      );
    const boundedUsageRollupCommands = usageRollupCommandsFor("bounded_api_key:success");
    assert.equal(
      boundedUsageRollupCommands.filter((record) => record.command === "get").length,
      1,
      "one observed buffered response reads the terminal usage-rollup shard once"
    );
    assert.equal(
      boundedUsageRollupCommands.filter((record) => record.command === "atomic.commit" && record.atomicResult === "committed").length,
      1,
      "one observed buffered response records exactly one terminal usage-rollup merge"
    );
    // A cancelled Codex stream never observed usage, so the writer skips it
    // rather than inventing a zero-token row; the disconnect keeps only its V3
    // reservation and dispatch commits plus the serial admission CAS.
    assert.equal(
      disconnect.atomic_commits,
      3,
      "a post-dispatch disconnect retains the V3 reservation and dispatch commits plus the serial active-account admission CAS"
    );
    assert.equal(
      usageRollupCommandsFor("bounded_api_key:client_disconnect").length,
      0,
      "an unobserved terminal response must not write a fabricated zero-token usage row"
    );
    const disconnectV3Commits = kv.commands.filter(
      (record) =>
        record.scenario === "bounded_api_key:client_disconnect" &&
        record.command === "atomic.commit" &&
        record.atomicResult === "committed" &&
        record.keys.some((key) => key[0] === "uos_ai" && key[1] === "api_key_usage" && key[2] === "v3")
    );
    assert.equal(disconnectV3Commits.length, 2, "the disconnect path writes the V3 reservation and dispatch exactly once each");
    assert.ok(concurrent.atomic_commits >= 2, "concurrent admission must retain the winning reservation and dispatch");
    assert.equal(
      kv.commands.some(
        (record) =>
          (record.scenario === "uos_allowlist:success" || record.scenario === "admin_allowlist:success") &&
          record.keys.some((key) => key[0] === "uos_ai" && key[1] === "api_key_usage")
      ),
      false,
      "allowlist paths must remain separate from V3 API-key ledger keys"
    );
    assert.ok(
      kv.commands.some((record) => record.command === "atomic.commit" && record.atomicResult === "committed"),
      "fixture must retain atomic-commit records, not only aggregate counters"
    );

    console.info(
      "[usage-optimization] operation-byte-budget",
      JSON.stringify(
        budgets.map((budget) => ({
          scenario: budget.scenario,
          reads: budget.read_commands,
          writes: budget.write_mutations,
          atomic_commits: budget.atomic_commits,
          mandatory_commands: budget.mandatory_correctness_commands,
          optional_commands: budget.optional_telemetry_commands,
          request_bytes: budget.serialized_request_bytes,
          response_bytes: budget.upstream_response_bytes,
          latency_ms: budget.latency_ms,
        }))
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
    setKvForTest(null);
    restoreEnvironment(savedEnvironment);
  }
});
