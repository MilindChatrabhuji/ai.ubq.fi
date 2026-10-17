import { test } from "bun:test";
import { serveHttp, type HttpServer, type NetAddr } from "#http";
import { openKv, type Kv, type KvKey, type KvEntry } from "#kv";
import assert from "node:assert/strict";
import { PAID_FALLBACK_NO_LIMIT } from "../src/api-keys.ts";
import { setInferenceAdmissionControllerForTest } from "../src/handler/admission.ts";
import { createInferenceAdmissionController } from "../src/inference-admission.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, PaidFallbackRequestV3, PaidFallbackWindowV3 } from "../src/types.ts";
import { sha256Base64Url } from "../src/utils.ts";

const outputText = (payload: Record<string, unknown>): string => {
  if (!Array.isArray(payload.output)) return "";
  return payload.output
    .flatMap((item) => {
      if (!item || typeof item !== "object" || !Array.isArray((item as { content?: unknown }).content)) return [];
      return (item as { content: { text?: unknown }[] }).content.map((content) => (typeof content.text === "string" ? content.text : ""));
    })
    .join("");
};

const listEntries = async <T>(kv: Kv, prefix: KvKey): Promise<KvEntry<T>[]> => {
  const entries: KvEntry<T>[] = [];
  for await (const entry of kv.list<T>({ prefix }, { consistency: "strong" })) entries.push(entry);
  return entries;
};

/** URL text of a fetch input, used to route the stress-test transport. */
const fetchInputUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const awaitWithin = async (promise: Promise<void>, milliseconds: number, message: () => string): Promise<void> => {
  // The timer handle is a `const` so its type is inferred: the lint project does
  // not resolve the `setTimeout` global, where `ReturnType<typeof setTimeout>`
  // degrades to `any` and cannot be named in a union.
  let rejectTimeout: (error: Error) => void = (_error: Error): void => undefined;
  const timeoutExpired = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    rejectTimeout(new Error(message()));
  }, milliseconds);
  try {
    await Promise.race([promise, timeoutExpired]);
  } finally {
    clearTimeout(timeout);
  }
};

test("100 concurrent real HTTP 429 failovers reach unlimited Metered together and settle exactly once", async () => {
  const kv = await openKv(":memory:");
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.METERED_API_KEY;
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  let originalDeployFlag: boolean | null = null;
  let providerServer: HttpServer | null = null;
  let gatewayServer: HttpServer | null = null;
  let releaseMeteredResponses = (): void => {};
  let releaseCodexResponses = (): void => {};

  try {
    // This fixture measures 100 simultaneous paid-hop settlements. Separate
    // OSS cases exercise admission bounds without widening the application default.
    setInferenceAdmissionControllerForTest(createInferenceAdmissionController({ maxActive: 100, maxWaiting: 1, maxQueueWaitMs: 150 }));
    process.env.METERED_API_KEY = "metered-real-http-stress-key";
    delete process.env.SURPLUS_API_KEY;
    const { setKvForTest } = await import("../src/kv.ts");
    const { fetchMeteredModels, resetMeteredModelsCacheForTest, setMeteredModelsFetchForTest } = await import("../src/provider/metered.ts");
    const { config } = await import("../src/config.ts");
    setKvForTest(kv);
    originalDeployFlag = config.isDeploy;
    resetMeteredModelsCacheForTest();
    setMeteredModelsFetchForTest(() =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "gpt-5.6-sol",
              owned_by: "openlux",
              supported_endpoint_types: ["openai-response"],
            },
          ],
        })
      )
    );
    assert.deepEqual(
      (await fetchMeteredModels({ force: true }))?.models.map((entry) => entry.id),
      ["gpt-5.6-sol"]
    );
    console.info = () => {};
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

    const keyId = "real-http-stress-key";
    const token = `u_${"a".repeat(64)}`;
    const tokenHash = await sha256Base64Url(token);
    const model = "gpt-5.6-sol";
    const now = Date.now();
    const windowMs = 60 * 60_000;
    const windowResetAtMs = now + windowMs;
    const pricingCheckedAtMs = now;
    const quotaPerCredit = 500_000;
    const commonPolicy = {
      expires_at_ms: -1,
      revoked_at_ms: null,
      usage_limit_requests: -1,
      usage_requests: 0,
      usage_reset_at_ms: windowResetAtMs,
      window_ms: windowMs,
      usage_quota_version: 3,
      paid_fallback_enabled: true,
      paid_fallback_limit_microcredits: PAID_FALLBACK_NO_LIMIT,
      paid_fallback_spent_microcredits: 0,
      paid_fallback_reserved_microcredits: 0,
      paid_fallback_reservation_request_id: null,
    } satisfies Omit<ApiKeyHashRecord, "id">;
    const keyRecord: ApiKeyRecord = {
      id: keyId,
      name: "Real HTTP stress key",
      prefix: token.slice(0, 10),
      hash: tokenHash,
      created_at_ms: now,
      ...commonPolicy,
      paid_fallback_model_ids: [model],
      paid_fallback_quota_per_credit: quotaPerCredit,
      paid_fallback_max_exposure_microcredits: {},
      paid_fallback_pricing_checked_at_ms: pricingCheckedAtMs,
    };
    await kv.set(["ubq_ai", "api_keys", "id", keyId], keyRecord);
    await kv.set(["ubq_ai", "api_keys", "hash", tokenHash], {
      id: keyId,
      ...commonPolicy,
    } satisfies ApiKeyHashRecord);
    await kv.set(["ubq_ai", "codex_auth"], {
      accounts: [
        {
          access_token: "real-http-access-token",
          refresh_token: "real-http-refresh-token",
          account_id: "real-http-account",
          updated_at_ms: now,
        },
      ],
      updated_at_ms: now,
    });
    const catalog = {
      source: "codex_cli",
      client_version: "0.145.0",
      updated_at_ms: now,
      models: [
        {
          slug: model,
          context_window: 272_000,
          max_context_window: 1_000_000,
          auto_compact_token_limit: null,
          default_reasoning_level: "low",
          supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
          reasoning_effort_wire_map: { ultra: "max" },
        },
      ],
    };
    await kv.set(["ubq_ai", "codex_models"], catalog);
    await kv.set(["uos_ai", "runtime_config", "v2"], {
      version: 2,
      default_model: model,
      default_reasoning_effort: "low",
      codex_models: catalog,
      updated_at_ms: now,
    });

    const providerLogs = new Map<
      string,
      {
        request_id: string;
        quota: number;
        prompt_tokens: number;
        completion_tokens: number;
        model_name: string;
        created_at: number;
      }
    >();
    let codexCalls = 0;
    let meteredCalls = 0;
    let meteredInFlight = 0;
    let maxMeteredInFlight = 0;
    let billingLogCalls = 0;
    let resolveAllMeteredDispatched = (): void => {};
    const allMeteredDispatched = new Promise<void>((resolve) => {
      resolveAllMeteredDispatched = resolve;
    });
    const meteredResponseBarrier = new Promise<void>((resolve) => {
      let released = false;
      releaseMeteredResponses = () => {
        if (released) return;
        released = true;
        resolve();
      };
    });
    const allCodexDispatched = Promise.withResolvers<undefined>();
    const codexResponseBarrier = new Promise<void>((resolve) => {
      releaseCodexResponses = resolve;
    });
    const codexRetryAfter = new Date((Math.floor(Date.now() / 1_000) + 60) * 1_000).toUTCString();
    providerServer = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/codex/responses") {
        codexCalls += 1;
        if (codexCalls === 100) allCodexDispatched.resolve(undefined);
        await codexResponseBarrier;
        return Response.json(
          { error: { message: "Primary quota exhausted", type: "usage_limit_reached" } },
          { status: 429, headers: { "Retry-After": codexRetryAfter } }
        );
      }
      if (url.pathname === "/metered/responses") {
        const callNumber = ++meteredCalls;
        if (callNumber > 100) throw new Error(`Unexpected Metered dispatch ${callNumber}`);
        meteredInFlight += 1;
        maxMeteredInFlight = Math.max(maxMeteredInFlight, meteredInFlight);
        if (callNumber === 100) resolveAllMeteredDispatched();
        try {
          const body = (await request.json()) as {
            input?: string | { content?: { text?: unknown }[] }[];
          };
          const sentinel =
            typeof body.input === "string"
              ? body.input
              : (body.input
                  ?.flatMap((item) => item.content ?? [])
                  .map((content) => (typeof content.text === "string" ? content.text : ""))
                  .join("") ?? "");
          await meteredResponseBarrier;
          const providerRequestId = `metered-real-http-${callNumber}`;
          providerLogs.set(providerRequestId, {
            request_id: providerRequestId,
            quota: 500,
            prompt_tokens: 2,
            completion_tokens: 1,
            model_name: model,
            created_at: Math.trunc(Date.now() / 1_000),
          });
          const responseId = `resp_${providerRequestId}`;
          const completed = {
            id: responseId,
            object: "response",
            created_at: Math.trunc(Date.now() / 1_000),
            status: "completed",
            model,
            output: [
              {
                type: "message",
                id: `msg_${providerRequestId}`,
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: sentinel, annotations: [] }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          };
          const sse = [
            `data: ${JSON.stringify({ type: "response.created", response: { id: responseId } })}\n\n`,
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: sentinel })}\n\n`,
            `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`,
          ].join("");
          return new Response(sse, {
            headers: {
              "Content-Type": "text/event-stream",
              "X-Oneapi-Request-Id": providerRequestId,
            },
          });
        } finally {
          meteredInFlight -= 1;
        }
      }
      if (url.pathname === "/metered/log/token") {
        billingLogCalls += 1;
        return Response.json({
          success: true,
          data: {
            items: [...providerLogs.values()],
            total: providerLogs.size,
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    await providerServer.ready;
    const providerAddress = providerServer.addr as NetAddr;
    const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}`;
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const sourceUrl = fetchInputUrl(input);
        if (sourceUrl === "https://chatgpt.com/backend-api/codex/responses") {
          return originalFetch(`${providerBaseUrl}/codex/responses`, init);
        }
        if (sourceUrl === "https://api.openlux.ai/v1/responses") {
          return originalFetch(`${providerBaseUrl}/metered/responses`, init);
        }
        if (sourceUrl.startsWith("https://api.openlux.ai/api/log/token?")) {
          return originalFetch(`${providerBaseUrl}/metered/log/token${new URL(sourceUrl).search}`, init);
        }
        const destination = new URL(sourceUrl);
        if (destination.hostname !== "127.0.0.1") return Promise.reject(new Error("Unmapped external URL refused by loopback HTTP fixture"));
        return originalFetch(input, init);
      },
      { preconnect: originalFetch.preconnect }
    );

    const { default: handler } = await import("../src/handler/index.ts");
    const { createServeHandler } = await import("../src/handler/serve-handler.ts");
    (config as { isDeploy: boolean }).isDeploy = true;
    const { reconcileDuePaidFallbacksV3 } = await import("../src/paid-fallback/ledger-backfill.ts");
    const { paidFallbackWindowV3Key } = await import("../src/paid-fallback/ledger-state.ts");
    const requestPrefix = ["uos_ai", "paid_fallback", "v3", "request", keyId] as const;
    const pendingPrefix = ["uos_ai", "paid_fallback", "v3", "pending", keyId] as const;
    gatewayServer = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, createServeHandler(handler));
    await gatewayServer.ready;
    const gatewayAddress = gatewayServer.addr as NetAddr;
    const gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}/v1/responses`;

    const pendingResults = Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        const sentinel = `UOS_REAL_HTTP_FAILOVER_${index}`;
        const response = await fetch(gatewayUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: sentinel,
            reasoning: { effort: "low" },
            client_metadata: { acceptance: "real-http-stress" },
            stream: false,
          }),
        });
        const payload = (await response.json()) as Record<string, unknown>;
        return {
          status: response.status,
          provider: response.headers.get("x-uos-upstream"),
          completed: payload.status === "completed",
          exact: outputText(payload) === sentinel,
          error: payload.error ?? null,
        };
      })
    );
    let dispatchBarrierError: unknown = null;
    try {
      await awaitWithin(allCodexDispatched.promise, 15_000, () => `Only ${codexCalls}/100 Codex requests dispatched before the concurrency deadline`);
      releaseCodexResponses();
      await awaitWithin(allMeteredDispatched, 15_000, () => `Only ${meteredCalls}/100 Metered requests dispatched before the concurrency deadline`);
      assert.equal(meteredCalls, 100);
      assert.equal(meteredInFlight, 100);
      assert.equal(maxMeteredInFlight, 100);
      assert.equal(codexCalls, 100);
    } catch (error) {
      dispatchBarrierError = error;
    } finally {
      releaseCodexResponses();
      releaseMeteredResponses();
    }
    const results = await pendingResults;
    if (dispatchBarrierError) {
      throw new Error(
        `${dispatchBarrierError instanceof Error ? dispatchBarrierError.message : JSON.stringify(dispatchBarrierError)}; ` +
          `Codex calls: ${codexCalls}; first results: ${JSON.stringify(results.slice(0, 3))}; ` +
          `warnings: ${JSON.stringify(warnings.slice(0, 5))}`,
        { cause: dispatchBarrierError }
      );
    }

    assert.deepEqual(
      results.map((result) => result.status),
      Array(100).fill(200)
    );
    assert.deepEqual(
      results.map((result) => result.provider),
      Array(100).fill("metered")
    );
    const invalidResults = results.filter((result) => !result.completed || !result.exact || result.error !== null);
    assert.deepEqual(invalidResults, []);
    assert.equal(codexCalls, 100);
    assert.equal(meteredCalls, 100);
    assert.equal(meteredInFlight, 0);
    assert.equal(maxMeteredInFlight, 100);
    assert.equal(providerLogs.size, 100);

    let requests: KvEntry<PaidFallbackRequestV3>[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      requests = await listEntries(kv, requestPrefix);
      if (
        requests.length === 100 &&
        requests.every(
          (entry) => entry.value.terminal_state === "completed" && entry.value.dispatch_state === "dispatched" && entry.value.provider_request_id !== null
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests.length, 100);
    assert.equal(new Set(requests.map((entry) => entry.value.provider_request_id)).size, 100);
    assert.equal(
      requests.every((entry) => entry.value.terminal_state === "completed"),
      true
    );

    const settled = await reconcileDuePaidFallbacksV3(Date.now() + 1_000, kv);
    assert.equal(settled, 100);
    assert.equal(billingLogCalls, 1);
    requests = await listEntries(kv, requestPrefix);
    assert.equal(requests.length, 100);
    assert.equal(
      requests.every((entry) => entry.value.billing_state === "settled"),
      true
    );
    assert.equal(
      requests.every((entry) => entry.value.spend_microcredits === 1_000),
      true
    );
    assert.equal(
      requests.every((entry) => entry.value.reserved_microcredits === 0),
      true
    );
    assert.equal(
      requests.every((entry) => entry.value.reconciliation_attempts === 1),
      true
    );
    assert.equal(
      requests.reduce((total, entry) => total + (entry.value.spend_microcredits ?? 0), 0),
      100_000
    );
    assert.equal((await listEntries(kv, pendingPrefix)).length, 0);

    const window = await kv.get(paidFallbackWindowV3Key(keyId, windowResetAtMs), { consistency: "strong" });
    assert.equal(window.value, null);

    assert.equal(await reconcileDuePaidFallbacksV3(Date.now() + 2_000, kv), 0);
    const replayedRequests = await listEntries<PaidFallbackRequestV3>(kv, requestPrefix);
    assert.equal(replayedRequests.length, 100);
    assert.equal(
      replayedRequests.every((entry) => entry.value.billing_state === "settled"),
      true
    );
    assert.equal(
      replayedRequests.every((entry) => entry.value.spend_microcredits === 1_000),
      true
    );
    assert.equal(
      replayedRequests.every((entry) => entry.value.reconciliation_attempts === 1),
      true
    );
    assert.equal(billingLogCalls, 1);
    assert.equal(
      warnings.some(
        (warning) =>
          warning.includes("Paid fallback policy changed concurrently") ||
          warning.includes("Paid fallback request changed concurrently") ||
          warning.includes("quota_accounting_failed")
      ),
      false,
      warnings.join("\n")
    );
  } finally {
    releaseCodexResponses();
    releaseMeteredResponses();
    if (gatewayServer) await gatewayServer.shutdown();
    if (providerServer) await providerServer.shutdown();
    setInferenceAdmissionControllerForTest(null);
    globalThis.fetch = originalFetch;
    const { setKvForTest } = await import("../src/kv.ts");
    const { resetMeteredModelsCacheForTest, setMeteredModelsFetchForTest } = await import("../src/provider/metered.ts");
    const { config } = await import("../src/config.ts");
    setKvForTest(null);
    setMeteredModelsFetchForTest(null);
    resetMeteredModelsCacheForTest();
    if (originalDeployFlag !== null) (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    console.info = originalInfo;
    console.warn = originalWarn;
    if (originalApiKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalApiKey;
    if (originalSurplusApiKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
    kv.close();
  }
}, 300_000);

test("a Surplus pre-header timeout is not replaced by a succeeding Metered retry and retains the spend cap", async () => {
  const kv = await openKv(":memory:");
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.METERED_API_KEY;
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  let originalDeployFlag: boolean | null = null;
  let providerServer: HttpServer | null = null;
  let gatewayServer: HttpServer | null = null;
  let releaseSurplusResponse = (): void => {};

  try {
    process.env.METERED_API_KEY = "metered-preheader-ambiguity-key";
    process.env.SURPLUS_API_KEY = "surplus-preheader-ambiguity-key";
    const { setKvForTest } = await import("../src/kv.ts");
    const { fetchMeteredModels, resetMeteredModelsCacheForTest, setMeteredModelsFetchForTest } = await import("../src/provider/metered.ts");
    const { fetchSurplusModels, resetSurplusModelsCacheForTest } = await import("../src/provider/surplus.ts");
    const { setPaidProviderFirstHeadersDeadlineMsForTest } = await import("../src/inference-deadline.ts");
    const { config } = await import("../src/config.ts");
    setKvForTest(kv);
    originalDeployFlag = config.isDeploy;
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    setMeteredModelsFetchForTest(() =>
      Promise.resolve(
        Response.json({
          data: [{ id: "gpt-5.6-sol", owned_by: "openlux", supported_endpoint_types: ["openai-response"] }],
        })
      )
    );
    assert.deepEqual(
      (await fetchMeteredModels({ force: true }))?.models.map((entry) => entry.id),
      ["gpt-5.6-sol"]
    );
    console.info = () => {};
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

    const keyId = "preheader-ambiguity-key";
    const token = `u_${"b".repeat(64)}`;
    const tokenHash = await sha256Base64Url(token);
    const model = "gpt-5.6-sol";
    const now = Date.now();
    const windowMs = 60 * 60_000;
    const windowResetAtMs = now + windowMs;
    const exposureMicrocredits = 100_000;
    const commonPolicy = {
      expires_at_ms: -1,
      revoked_at_ms: null,
      usage_limit_requests: -1,
      usage_requests: 0,
      usage_reset_at_ms: windowResetAtMs,
      window_ms: windowMs,
      usage_quota_version: 3,
      paid_fallback_enabled: true,
      paid_fallback_limit_microcredits: exposureMicrocredits,
      paid_fallback_spent_microcredits: 0,
      paid_fallback_reserved_microcredits: 0,
      paid_fallback_reservation_request_id: null,
    } satisfies Omit<ApiKeyHashRecord, "id">;
    const keyRecord: ApiKeyRecord = {
      id: keyId,
      name: "Surplus pre-header ambiguity key",
      prefix: token.slice(0, 10),
      hash: tokenHash,
      created_at_ms: now,
      ...commonPolicy,
      paid_fallback_model_ids: [model],
      paid_fallback_quota_per_credit: 500_000,
      paid_fallback_max_exposure_microcredits: { [model]: exposureMicrocredits },
      paid_fallback_pricing_checked_at_ms: now,
    };
    await kv.set(["ubq_ai", "api_keys", "id", keyId], keyRecord);
    await kv.set(["ubq_ai", "api_keys", "hash", tokenHash], {
      id: keyId,
      ...commonPolicy,
    } satisfies ApiKeyHashRecord);
    await kv.set(["ubq_ai", "codex_auth"], {
      accounts: [
        {
          access_token: "preheader-ambiguity-access-token",
          refresh_token: "preheader-ambiguity-refresh-token",
          account_id: "preheader-ambiguity-account",
          updated_at_ms: now,
        },
      ],
      updated_at_ms: now,
    });
    const catalog = {
      source: "codex_cli",
      client_version: "0.145.0",
      updated_at_ms: now,
      models: [
        {
          slug: model,
          context_window: 272_000,
          max_context_window: 1_000_000,
          auto_compact_token_limit: null,
          default_reasoning_level: "low",
          supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
          reasoning_effort_wire_map: { ultra: "max" },
        },
      ],
    };
    await kv.set(["ubq_ai", "codex_models"], catalog);
    await kv.set(["uos_ai", "runtime_config", "v2"], {
      version: 2,
      default_model: model,
      default_reasoning_effort: "low",
      codex_models: catalog,
      updated_at_ms: now,
    });

    const providerLogs = new Map<
      string,
      {
        request_id: string;
        quota: number;
        prompt_tokens: number;
        completion_tokens: number;
        model_name: string;
        created_at: number;
      }
    >();
    let codexCalls = 0;
    let surplusCalls = 0;
    let meteredCalls = 0;
    let billingLogCalls = 0;
    const surplusBarrier = new Promise<void>((resolve) => {
      let released = false;
      releaseSurplusResponse = () => {
        if (released) return;
        released = true;
        resolve();
      };
    });
    const codexRetryAfter = new Date((Math.floor(Date.now() / 1_000) + 60) * 1_000).toUTCString();
    providerServer = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/codex/responses") {
        codexCalls += 1;
        return Response.json(
          { error: { message: "Primary quota exhausted", type: "usage_limit_reached" } },
          { status: 429, headers: { "Retry-After": codexRetryAfter } }
        );
      }
      if (url.pathname === "/surplus/models") {
        return Response.json({ data: [{ id: model, pricing: { prompt: 0.000001, completion: 0.000003 } }] });
      }
      if (url.pathname === "/surplus/responses") {
        surplusCalls += 1;
        // Hold the response open so the Surplus attempt ends on its own
        // first-headers deadline with no response headers received.
        await surplusBarrier;
        return new Response("surplus released");
      }
      if (url.pathname === "/metered/responses") {
        meteredCalls += 1;
        const providerRequestId = "metered-preheader-retry";
        providerLogs.set(providerRequestId, {
          request_id: providerRequestId,
          quota: 500,
          prompt_tokens: 2,
          completion_tokens: 1,
          model_name: model,
          created_at: Math.trunc(Date.now() / 1_000),
        });
        const responseId = "resp_metered_preheader_retry";
        const completed = {
          id: responseId,
          object: "response",
          created_at: Math.trunc(Date.now() / 1_000),
          status: "completed",
          model,
          output: [
            {
              type: "message",
              id: "msg_metered_preheader_retry",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "metered retry delivered", annotations: [] }],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        };
        const sse = [
          `data: ${JSON.stringify({ type: "response.created", response: { id: responseId } })}\n\n`,
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "metered retry delivered" })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`,
        ].join("");
        return new Response(sse, {
          headers: {
            "Content-Type": "text/event-stream",
            "X-Oneapi-Request-Id": providerRequestId,
          },
        });
      }
      if (url.pathname === "/metered/log/token") {
        billingLogCalls += 1;
        return Response.json({
          success: true,
          data: {
            items: [...providerLogs.values()],
            total: providerLogs.size,
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    await providerServer.ready;
    const providerAddress = providerServer.addr as NetAddr;
    const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}`;
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const sourceUrl = fetchInputUrl(input);
        if (sourceUrl === "https://chatgpt.com/backend-api/codex/responses") {
          return originalFetch(`${providerBaseUrl}/codex/responses`, init);
        }
        if (sourceUrl === "https://api.surplusintelligence.ai/v1/models") {
          return originalFetch(`${providerBaseUrl}/surplus/models`, init);
        }
        if (sourceUrl === "https://api.surplusintelligence.ai/v1/responses") {
          return originalFetch(`${providerBaseUrl}/surplus/responses`, init);
        }
        if (sourceUrl === "https://api.openlux.ai/v1/responses") {
          return originalFetch(`${providerBaseUrl}/metered/responses`, init);
        }
        if (sourceUrl.startsWith("https://api.openlux.ai/api/log/token?")) {
          return originalFetch(`${providerBaseUrl}/metered/log/token${new URL(sourceUrl).search}`, init);
        }
        const destination = new URL(sourceUrl);
        if (destination.hostname !== "127.0.0.1") return Promise.reject(new Error("Unmapped external URL refused by loopback HTTP fixture"));
        return originalFetch(input, init);
      },
      { preconnect: originalFetch.preconnect }
    );
    await fetchSurplusModels({ force: true });
    assert.deepEqual(
      (await fetchSurplusModels({ cachedOnly: true }))?.models.map((entry) => entry.id),
      [model]
    );

    const { default: handler } = await import("../src/handler/index.ts");
    const { createServeHandler } = await import("../src/handler/serve-handler.ts");
    (config as { isDeploy: boolean }).isDeploy = true;
    const { reconcileDuePaidFallbacksV3 } = await import("../src/paid-fallback/ledger-backfill.ts");
    const { paidFallbackWindowV3Key } = await import("../src/paid-fallback/ledger-state.ts");
    const requestPrefix = ["uos_ai", "paid_fallback", "v3", "request", keyId] as const;
    const pendingPrefix = ["uos_ai", "paid_fallback", "v3", "pending", keyId] as const;
    gatewayServer = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, createServeHandler(handler));
    await gatewayServer.ready;
    const gatewayAddress = gatewayServer.addr as NetAddr;
    const gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}/v1/responses`;
    const callGateway = async (sentinel: string): Promise<Response> =>
      await fetch(gatewayUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: sentinel,
          reasoning: { effort: "low" },
          client_metadata: { acceptance: "surplus-preheader-ambiguity" },
          stream: false,
        }),
      });

    // One second is long enough for the loopback Surplus dispatch to start,
    // so the attempt ends inside provider transport with no headers.
    setPaidProviderFirstHeadersDeadlineMsForTest(1_000);
    const response = await callGateway("UOS_SURPLUS_PREHEADER_AMBIGUITY");
    const payload = (await response.json()) as { error?: { code?: unknown; type?: unknown } };
    assert.equal(response.status, 504);
    assert.equal(response.headers.get("x-uos-upstream"), "surplus");
    assert.equal(payload.error?.code, "gateway_timeout");
    assert.equal(payload.error.type, "server_error");
    assert.equal(codexCalls, 1);
    assert.equal(surplusCalls, 1);
    assert.equal(meteredCalls, 0);

    let requests: KvEntry<PaidFallbackRequestV3>[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      requests = await listEntries(kv, requestPrefix);
      if (requests.length === 1 && requests[0].value.terminal_state === "ambiguous") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests.length, 1);
    const stored = requests[0].value;
    assert.equal(stored.provider, "surplus");
    assert.equal(stored.terminal_state, "ambiguous");
    assert.equal(stored.dispatch_state, "dispatched");
    assert.equal(stored.provider_request_id, null);
    assert.equal(stored.billing_state, "pending");
    assert.equal(stored.spend_microcredits, null);
    assert.equal(stored.reserved_microcredits, exposureMicrocredits);

    // Surplus has no provider-log reconciliation path, so a due sweep defers
    // this row: the ambiguous exposure stays reserved instead of released.
    assert.equal(await reconcileDuePaidFallbacksV3(Date.now() + 60_000, kv), 0);
    const afterReconcile = await listEntries<PaidFallbackRequestV3>(kv, requestPrefix);
    assert.equal(afterReconcile.length, 1);
    assert.equal(afterReconcile[0].value.terminal_state, "ambiguous");
    assert.equal(afterReconcile[0].value.billing_state, "pending");
    assert.equal((await listEntries(kv, pendingPrefix)).length, 1);

    const window = await kv.get<PaidFallbackWindowV3>(paidFallbackWindowV3Key(keyId, windowResetAtMs), { consistency: "strong" });
    assert.ok(window.value);
    assert.equal(window.value.reserved_microcredits, exposureMicrocredits);
    assert.equal(window.value.settled_microcredits, 0);
    assert.equal(window.value.pending_count, 1);

    // The retained reservation spends the cap: a second paid request for the
    // same window is refused at admission instead of dispatching another paid
    // attempt, and the primary Codex failure is returned request-locally.
    const blockedResponse = await callGateway("UOS_SURPLUS_PREHEADER_AMBIGUITY_BLOCKED");
    await blockedResponse.text();
    assert.equal(blockedResponse.status, 429);
    assert.equal(surplusCalls, 1);
    assert.equal(meteredCalls, 0);
    assert.equal(billingLogCalls, 0);
    const retained = await kv.get<PaidFallbackWindowV3>(paidFallbackWindowV3Key(keyId, windowResetAtMs), { consistency: "strong" });
    assert.ok(retained.value);
    assert.equal(retained.value.reserved_microcredits, exposureMicrocredits);
    assert.equal(retained.value.settled_microcredits, 0);
    assert.equal(retained.value.pending_count, 1);
    assert.equal((await listEntries(kv, requestPrefix)).length, 1);
    assert.equal(
      warnings.some((warning) => warning.includes("failed; leaving the reservation pending")),
      false,
      warnings.join("\n")
    );
  } finally {
    releaseSurplusResponse();
    if (gatewayServer) await gatewayServer.shutdown();
    if (providerServer) await providerServer.shutdown();
    setInferenceAdmissionControllerForTest(null);
    globalThis.fetch = originalFetch;
    const { setKvForTest } = await import("../src/kv.ts");
    const { resetMeteredModelsCacheForTest, setMeteredModelsFetchForTest } = await import("../src/provider/metered.ts");
    const { resetSurplusModelsCacheForTest } = await import("../src/provider/surplus.ts");
    const { setPaidProviderFirstHeadersDeadlineMsForTest } = await import("../src/inference-deadline.ts");
    const { config } = await import("../src/config.ts");
    setPaidProviderFirstHeadersDeadlineMsForTest(null);
    setKvForTest(null);
    setMeteredModelsFetchForTest(null);
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalDeployFlag !== null) (config as { isDeploy: boolean }).isDeploy = originalDeployFlag;
    console.info = originalInfo;
    console.warn = originalWarn;
    if (originalApiKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalApiKey;
    if (originalSurplusApiKey === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
    kv.close();
  }
}, 300_000);
