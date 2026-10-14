import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 4 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  ApiKeyQuotaDispatchError,
  type CodexAuthPoolState,
  type CodexUsageResetProvider,
  DEBUG_ROUTING_KEY,
  DEFAULT_TEST_MODEL,
  METERED_MODELS_CACHE_TTL_MS,
  SURPLUS_MODELS_CACHE_TTL_MS,
  TEMPORARY_FREE_SURPLUS_TEST_MODEL,
  TEXT_ENCODER,
  authoritativeCodexQuotaResponse,
  baseSseChunks,
  clearBankedResetRecords,
  fetchMeteredModels,
  fetchSurplusModels,
  getResponseTelemetry,
  getStoredPaidFallbackRequest,
  handleChatCompletions,
  handleResponses,
  keyToString,
  kvStore,
  kvStub,
  liveBankedResetFixtureConfig,
  markCodexQuotaBlocked,
  parseWarnings,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  resetDebugRoutingCacheForTest,
  resetMeteredModelsCacheForTest,
  resetProviderHealthThrottleForTest,
  resetSurplusModelsCacheForTest,
  responsesRequest,
  seedPaidFallbackKey,
  selectCodexRoutingAccounts,
  setCodexBankedResetOptionsForTest,
  setMeteredModelsFetchForTest,
  setRemovedProviderApiKeyForTest,
  setRemovedProviderTestAdapterForTest,
  sseResponse,
  waitForPaidFallbackTerminal,
  withFetchMock,
  withProviderSelection,
} from "./helpers/openai-compat-harness.ts";

test("openai: a generic post-reset 429 does not authorize paid fallback", async () => {
  const previousMeteredKey = process.env.METERED_API_KEY;
  const keyId = "fallback-post-reset-generic-429";
  const requestId = "request-post-reset-generic-429";
  const providerCalls: string[] = [];
  let codexCalls = 0;
  let meteredCalls = 0;
  const provider: CodexUsageResetProvider = {
    contract: {
      idempotency: { callerSupplied: true, retentionMs: 86_400_000 },
      lookup: { byIdempotencyKey: true, byProviderReceiptId: true },
      verification: { independentlyVerifiable: true },
      receiptIdsSafeToPersistAndLog: false,
      supportedResetTypes: ["codex_rate_limits"],
    },
    readInventory: () => {
      providerCalls.push("inventory");
      return Promise.resolve({
        availableCount: 1,
        observedAtMs: Date.now(),
        credits: [{ id: "fixture-credit", status: "available", resetType: "codex_rate_limits", expiresAtMs: null }],
      });
    },
    redeem: () => {
      providerCalls.push("redeem");
      return Promise.resolve({ kind: "completed", providerReceiptId: "post-reset-generic-receipt" } as const);
    },
    lookup: () => {
      providerCalls.push("lookup");
      return Promise.resolve({ kind: "completed", providerReceiptId: "post-reset-generic-receipt" } as const);
    },
    verifyApplied: () => {
      providerCalls.push("verify");
      return Promise.resolve(true);
    },
  };

  process.env.METERED_API_KEY = "metered-test-key";
  resetMeteredModelsCacheForTest();
  await fetchMeteredModels({
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [{ id: DEFAULT_TEST_MODEL, supported_endpoint_types: ["openai-response"] }],
        })
      ),
  });
  seedPaidFallbackKey(keyId);

  try {
    const response = await withFetchMock(
      (url) => {
        if (url === "https://chatgpt.com/backend-api/codex/responses") {
          codexCalls += 1;
          if (codexCalls === 1) return authoritativeCodexQuotaResponse();
          return new Response(JSON.stringify({ error: { message: "Still limited" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === "https://api.openlux.ai/v1/responses") {
          meteredCalls += 1;
          return sseResponse(baseSseChunks());
        }
        throw new Error(`Unexpected upstream dispatch in post-reset fallback test: ${url}`);
      },
      async () => {
        clearBankedResetRecords();
        setCodexBankedResetOptionsForTest({
          config: liveBankedResetFixtureConfig(),
          provider,
          kv: kvStub,
          now: () => Date.now(),
          newOwnerToken: () => "post-reset-generic-owner",
        });
        try {
          return await handleResponses(responsesRequest(), {
            keyId,
            kernelRepo: null,
            kernelOrg: null,
            paidFallbackEnabled: true,
            requestId,
            startedAtMs: Date.now(),
          });
        } finally {
          setCodexBankedResetOptionsForTest(null);
          clearBankedResetRecords();
        }
      }
    );

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
    assert.equal(codexCalls, 2);
    assert.equal(meteredCalls, 0);
    assert.deepEqual(providerCalls, ["inventory", "redeem", "verify"]);
  } finally {
    setCodexBankedResetOptionsForTest(null);
    clearBankedResetRecords();
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    resetMeteredModelsCacheForTest();
    if (previousMeteredKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = previousMeteredKey;
  }
});

test("openai: an all-blocked Codex response continues through paid Metered fallback", async () => {
  const authKey = keyToString(["ubq_ai", "codex_auth"]);
  const previousAuth = kvStore.get(authKey);
  const previousMeteredKey = process.env.METERED_API_KEY;
  const keyId = "fallback-gateway-codex-quota";
  const requestId = "request-gateway-codex-quota";
  const now = Date.now();
  const expectedRetryAtMs = Math.floor((now + 60_000) / 1_000) * 1_000;
  const authPool: CodexAuthPoolState = {
    accounts: [
      {
        access_token: "access-one",
        refresh_token: "refresh-one",
        account_id: "account-one",
        updated_at_ms: now,
      },
      {
        access_token: "access-two",
        refresh_token: "refresh-two",
        account_id: "account-two",
        updated_at_ms: now,
      },
    ],
    updated_at_ms: now,
  };
  let meteredCalls = 0;
  process.env.METERED_API_KEY = "metered-test-key";
  resetMeteredModelsCacheForTest();
  await fetchMeteredModels({
    force: true,
    fetcher: () =>
      Promise.resolve(
        Response.json({
          data: [{ id: DEFAULT_TEST_MODEL, supported_endpoint_types: ["openai-response"] }],
        })
      ),
  });
  seedPaidFallbackKey(keyId);

  try {
    await withFetchMock(
      (url) => {
        if (url === "https://api.openlux.ai/v1/responses") {
          meteredCalls += 1;
          return sseResponse(baseSseChunks());
        }
        throw new Error(`Unexpected upstream dispatch in all-blocked routing test: ${url}`);
      },
      async () => {
        kvStore.set(authKey, authPool);
        resetCodexAuthCacheForTest();
        const selection = await selectCodexRoutingAccounts(authPool, authPool.accounts, now);
        assert.equal(selection.kind, "eligible");

        for (const account of selection.accounts) {
          const blocked = await markCodexQuotaBlocked(
            account,
            new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": new Date(now + 60_000).toUTCString(),
              },
            }),
            now
          );
          assert.equal(blocked.usageLimitReached, true);
          assert.equal(blocked.retryAtMs, expectedRetryAtMs);
        }

        const response = await handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "use fallback after all Codex circuits open" }),
          }),
          {
            keyId,
            kernelRepo: null,
            kernelOrg: null,
            requestId,
            startedAtMs: now,
          }
        );

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-codex-routing-error"), null);
        assert.equal(response.headers.get("x-uos-upstream"), "metered");
        assert.equal(meteredCalls, 1);
        assert.equal(getResponseTelemetry(response)?.activeGeneration, null);
        assert.equal(getResponseTelemetry(response)?.activeTransitionReason, null);
        assert.equal(kvStore.has(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, requestId])), true);
      }
    );
  } finally {
    if (previousAuth === undefined) kvStore.delete(authKey);
    else kvStore.set(authKey, previousAuth);
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
    resetCodexAuthCacheForTest();
    resetMeteredModelsCacheForTest();
    if (previousMeteredKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = previousMeteredKey;
  }
});

test("openai: temporary free GLM cut uses only Surplus without paid fallback", async () =>
  runSequence(async (step) => {
    const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
    const originalMeteredApiKey = process.env.METERED_API_KEY;
    const debugKey = keyToString(DEBUG_ROUTING_KEY);
    const previousDebugRouting = kvStore.get(debugKey);
    const healthPrefix = ["uos_ai", "provider_health", "v1", "surplus", "default"] as const;
    const healthKey = keyToString([...healthPrefix, "current"]);
    let removedProviderCalls = 0;

    const clearSurplusHealth = (): void => {
      for (const encodedKey of [...kvStore.keys()]) {
        const key = JSON.parse(encodedKey) as unknown[];
        if (healthPrefix.every((part, index) => key[index] === part)) kvStore.delete(encodedKey);
      }
      resetProviderHealthThrottleForTest();
    };
    const waitForSurplusHealth = async (event: string): Promise<Record<string, unknown>> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = kvStore.get(healthKey) as Record<string, unknown> | undefined;
        if (current?.event === event) return current;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const current = kvStore.get(healthKey) as Record<string, unknown> | undefined;
      const observedEvent = current?.event;
      assert.fail(`Expected Surplus health event ${event}, received ${typeof observedEvent === "string" ? observedEvent : "missing"}`);
    };

    process.env.SURPLUS_API_KEY = "surplus-test-key";
    process.env.METERED_API_KEY = "metered-must-not-run";
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    setRemovedProviderApiKeyForTest("removed-provider-must-not-run");
    setRemovedProviderTestAdapterForTest({
      fetchResponses: () => {
        removedProviderCalls += 1;
        throw new Error("RemovedProvider must not run for the temporary GLM cut");
      },
      modelFromEvent: () => null,
      isEligibleModel: () => true,
    });
    kvStore.set(debugKey, {
      scenario: "removed_provider_first",
      expires_at_ms: Date.now() + 60_000,
      updated_at_ms: Date.now(),
    });
    resetDebugRoutingCacheForTest();

    try {
      for (const routeCase of [
        { route: "responses", requestId: "free-glm-responses", reasoningEffort: "low" },
        { route: "chat", requestId: "free-glm-chat", reasoningEffort: "medium" },
      ] as const) {
        await step(`${routeCase.route} bypasses catalogs, Codex, RemovedProvider, Metered, and the ledger`, async () => {
          clearSurplusHealth();
          const upstreamUrls: string[] = [];
          const dispatchedProviders: string[] = [];
          let upstreamModel: unknown = null;
          let upstreamReasoningEffort: unknown = null;
          let upstreamTextFormat: unknown = null;
          const response = await withFetchMock(
            (url, bodyText, init) => {
              upstreamUrls.push(url);
              assert.equal(url, "https://api.surplusintelligence.ai/v1/responses");
              assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer surplus-test-key");
              const upstreamRequest = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
              upstreamModel = upstreamRequest?.model ?? null;
              upstreamReasoningEffort = (upstreamRequest?.reasoning as Record<string, unknown> | undefined)?.effort ?? null;
              upstreamTextFormat = (upstreamRequest?.text as Record<string, unknown> | undefined)?.format ?? null;
              return new Response(sseResponse(baseSseChunks()).body, {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "X-Oneapi-Request-Id": routeCase.requestId + "-provider",
                },
              });
            },
            () => {
              const context = {
                keyId: "key-" + routeCase.requestId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: false,
                requestId: routeCase.requestId,
                startedAtMs: Date.now(),
                startedAtMonotonicMs: performance.now(),
                beforeProviderDispatch: (provider: string) => {
                  dispatchedProviders.push(provider);
                  return Promise.resolve(undefined);
                },
              };
              return routeCase.route === "responses"
                ? handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: TEMPORARY_FREE_SURPLUS_TEST_MODEL,
                        input: "ping",
                        reasoning: { effort: routeCase.reasoningEffort },
                      }),
                    }),
                    context
                  )
                : handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: TEMPORARY_FREE_SURPLUS_TEST_MODEL,
                        messages: [{ role: "user", content: "ping" }],
                        reasoning_effort: routeCase.reasoningEffort,
                        response_format: { type: "json_object" },
                      }),
                    }),
                    context
                  );
            }
          );

          assert.equal(response.status, 200);
          assert.equal(response.headers.get("x-uos-upstream"), "surplus");
          await response.text();
          assert.deepEqual(upstreamUrls, ["https://api.surplusintelligence.ai/v1/responses"]);
          assert.deepEqual(dispatchedProviders, ["surplus"]);
          assert.equal(upstreamModel, TEMPORARY_FREE_SURPLUS_TEST_MODEL);
          assert.equal(upstreamReasoningEffort, routeCase.reasoningEffort);
          assert.deepEqual(upstreamTextFormat, routeCase.route === "chat" ? { type: "json_object" } : null);
          assert.ok(!parseWarnings(response.headers.get("x-uos-warning")).includes("response_format_ignored"));
          const telemetry = getResponseTelemetry(response);
          assert.equal(telemetry?.provider, "surplus");
          assert.equal(telemetry.fallbackReason, null);
          assert.equal(telemetry.reasoning, routeCase.reasoningEffort);
          assert.equal(telemetry.providerRequestId, routeCase.requestId + "-provider");
          assert.deepEqual(telemetry.attemptedProviders, ["surplus"]);
          assert.equal(telemetry.activeGeneration, null);
          assert.equal(telemetry.activeTransitionReason, null);
          assert.equal(telemetry.firstCodexDispatchMs, null);
          assert.equal(telemetry.firstCodexHeadersMs, null);
          assert.equal(typeof telemetry.firstProviderDispatchMs, "number");
          assert.equal(typeof telemetry.firstProviderHeadersMs, "number");
          assert.equal(getStoredPaidFallbackRequest("key-" + routeCase.requestId, routeCase.requestId), null);
          const health = await waitForSurplusHealth("success");
          assert.equal(health.status, 200);
          assert.equal(health.provider_request_id, routeCase.requestId + "-provider");
        });
      }

      await step("ordinary API-key quota rejection happens before Surplus transport", async () => {
        clearSurplusHealth();
        const keyId = "free-glm-quota-key";
        const requestId = "free-glm-quota-request";
        let fetchCalls = 0;
        const response = await withFetchMock(
          () => {
            fetchCalls += 1;
            return sseResponse(baseSseChunks());
          },
          () =>
            handleChatCompletions(
              new Request("https://ai.ubq.fi/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: TEMPORARY_FREE_SURPLUS_TEST_MODEL,
                  messages: [{ role: "user", content: "ping" }],
                }),
              }),
              {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: false,
                requestId,
                startedAtMs: Date.now(),
                beforeProviderDispatch: () => Promise.reject(new ApiKeyQuotaDispatchError("API key quota reservation is unavailable")),
              }
            )
        );
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("x-uos-upstream"), "surplus");
        assert.equal(fetchCalls, 0);
        assert.deepEqual(getResponseTelemetry(response)?.attemptedProviders, ["surplus"]);
        assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
        assert.equal(kvStore.has(healthKey), false);
      });

      await step("tool-bearing requests fail before every provider and paid ledger", async () => {
        clearSurplusHealth();
        for (const route of ["responses", "chat"] as const) {
          const keyId = `free-glm-tools-${route}-key`;
          const requestId = `free-glm-tools-${route}-request`;
          const dispatchedProviders: string[] = [];
          let fetchCalls = 0;
          const response = await withFetchMock(
            () => {
              fetchCalls += 1;
              throw new Error("tool-bearing GLM requests must not reach a provider");
            },
            () => {
              const context = {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: false,
                requestId,
                startedAtMs: Date.now(),
                beforeProviderDispatch: (provider: string) => {
                  dispatchedProviders.push(provider);
                  return Promise.resolve(undefined);
                },
              };
              const tool = {
                type: "function",
                name: "inspect_workspace",
                description: "Inspect the workspace.",
                parameters: { type: "object", properties: {}, additionalProperties: false },
              };
              return route === "responses"
                ? handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: TEMPORARY_FREE_SURPLUS_TEST_MODEL,
                        input: "inspect the workspace",
                        tools: [tool],
                      }),
                    }),
                    context
                  )
                : handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: TEMPORARY_FREE_SURPLUS_TEST_MODEL,
                        messages: [{ role: "user", content: "inspect the workspace" }],
                        tools: [{ type: "function", function: tool }],
                      }),
                    }),
                    context
                  );
            }
          );

          assert.equal(response.status, 400, route);
          const payload = (await response.json()) as {
            error?: { code?: string; param?: string };
          };
          assert.equal(payload.error?.code, "unsupported_model_capability", route);
          assert.equal(payload.error.param, "tools", route);
          assert.equal(fetchCalls, 0, route);
          assert.deepEqual(dispatchedProviders, [], route);
          assert.deepEqual(getResponseTelemetry(response)?.attemptedProviders, [], route);
          assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null, route);
          assert.equal(kvStore.has(healthKey), false, route);
        }
      });

      await step("Surplus 429 remains quota health and never falls through", async () => {
        clearSurplusHealth();
        const keyId = "free-glm-provider-quota-key";
        const requestId = "free-glm-provider-quota-request";
        const upstreamUrls: string[] = [];
        const response = await withFetchMock(
          (url) => {
            upstreamUrls.push(url);
            return new Response(
              JSON.stringify({
                error: { message: "temporary provider quota", type: "rate_limit_error", code: "provider_quota" },
              }),
              {
                status: 429,
                headers: {
                  "Content-Type": "application/json",
                  "X-Oneapi-Request-Id": "free-glm-provider-429",
                },
              }
            );
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: TEMPORARY_FREE_SURPLUS_TEST_MODEL, input: "ping" }),
              }),
              {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: false,
                requestId,
                startedAtMs: Date.now(),
              }
            )
        );
        assert.equal(response.status, 429);
        assert.equal(response.headers.get("x-uos-upstream"), "surplus");
        await response.text();
        assert.deepEqual(upstreamUrls, ["https://api.surplusintelligence.ai/v1/responses"]);
        assert.deepEqual(getResponseTelemetry(response)?.attemptedProviders, ["surplus"]);
        assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
        const health = await waitForSurplusHealth("quota_exhausted");
        assert.equal(health.status, 429);
        assert.equal(health.provider_request_id, "free-glm-provider-429");
      });

      await step("Surplus upstream 400 stays an HTTP failure without paid advancement", async () => {
        clearSurplusHealth();
        const keyId = "free-glm-http-400-key";
        const requestId = "free-glm-http-400-request";
        let surplusCalls = 0;
        let meteredCalls = 0;
        const response = await withFetchMock(
          (url) => {
            if (url === "https://api.surplusintelligence.ai/v1/responses") {
              surplusCalls += 1;
              return new Response(JSON.stringify({ error: { message: "invalid request" } }), {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "X-Oneapi-Request-Id": "free-glm-http-400-provider",
                },
              });
            }
            if (url === "https://api.openlux.ai/v1/responses") {
              meteredCalls += 1;
              throw new Error("Metered must not follow a Surplus HTTP 400");
            }
            throw new Error("Unexpected upstream URL: " + url);
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: TEMPORARY_FREE_SURPLUS_TEST_MODEL,
                  input: "ping",
                }),
              }),
              {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: true,
                requestId,
                startedAtMs: Date.now(),
                startedAtMonotonicMs: performance.now(),
              }
            )
        );
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("x-uos-upstream"), "surplus");
        const telemetry = getResponseTelemetry(response);
        assert.ok(telemetry);
        assert.equal(telemetry.failureKind, "upstream_http_4xx");
        assert.equal(telemetry.streamTerminalType, "error");
        assert.equal(telemetry.responseCreatedObserved, false);
        assert.equal(telemetry.fallbackReason, null);
        assert.deepEqual(telemetry.attemptedProviders, ["surplus"]);
        assert.equal(surplusCalls, 1);
        assert.equal(meteredCalls, 0);
        assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
        const health = await waitForSurplusHealth("reachable");
        assert.equal(health.status, 400);
        assert.notEqual(health.event, "quota_exhausted");
        assert.equal(health.provider_request_id, "free-glm-http-400-provider");
      });

      await step("failed Surplus terminal marks provider health without a paid ledger row", async () => {
        clearSurplusHealth();
        const keyId = "free-glm-terminal-key";
        const requestId = "free-glm-terminal-request";
        const response = await withFetchMock(
          (url) => {
            assert.equal(url, "https://api.surplusintelligence.ai/v1/responses");
            return new Response(
              sseResponse([
                "data: " +
                  JSON.stringify({
                    type: "response.failed",
                    response: {
                      id: "free-glm-failed-response",
                      status: "failed",
                      model: TEMPORARY_FREE_SURPLUS_TEST_MODEL,
                      output: [],
                      error: { type: "server_error", code: "provider_error", message: "provider failed" },
                    },
                  }) +
                  "\n\n",
              ]).body,
              {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "X-Oneapi-Request-Id": "free-glm-failed-provider",
                },
              }
            );
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: TEMPORARY_FREE_SURPLUS_TEST_MODEL, input: "ping" }),
              }),
              {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: false,
                requestId,
                startedAtMs: Date.now(),
              }
            )
        );
        assert.equal(response.headers.get("x-uos-upstream"), "surplus");
        await response.text();
        assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
        const health = await waitForSurplusHealth("upstream_error");
        assert.equal(health.status, null);
        assert.equal(health.provider_request_id, "free-glm-failed-provider");
      });

      await step("contentless Surplus Chat completion marks provider health as failed", async () => {
        clearSurplusHealth();
        const keyId = "free-glm-empty-chat-key";
        const requestId = "free-glm-empty-chat-request";
        const response = await withFetchMock(
          (url) => {
            assert.equal(url, "https://api.surplusintelligence.ai/v1/responses");
            return new Response(
              sseResponse([
                `data: ${JSON.stringify({
                  type: "response.completed",
                  response: {
                    id: "free-glm-empty-response",
                    status: "completed",
                    model: TEMPORARY_FREE_SURPLUS_TEST_MODEL,
                    output: [],
                    usage: { input_tokens: 1642, output_tokens: 2048, total_tokens: 3690 },
                  },
                })}\n\n`,
              ]).body,
              {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "X-Oneapi-Request-Id": "free-glm-empty-provider",
                },
              }
            );
          },
          () =>
            handleChatCompletions(
              new Request("https://ai.ubq.fi/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: TEMPORARY_FREE_SURPLUS_TEST_MODEL,
                  max_completion_tokens: 2048,
                  messages: [{ role: "user", content: "contentless GLM response" }],
                }),
              }),
              {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: false,
                requestId,
                startedAtMs: Date.now(),
              }
            )
        );
        assert.equal(response.status, 502);
        assert.equal(response.headers.get("x-uos-upstream"), "surplus");
        const payload = (await response.json()) as { error?: { code?: unknown } };
        assert.equal(payload.error?.code, "empty_upstream_completion");
        assert.equal(getResponseTelemetry(response)?.completed, false);
        assert.equal(getResponseTelemetry(response)?.failureKind, "empty_upstream_completion");
        assert.equal(getResponseTelemetry(response)?.semanticOutputObserved, false);
        assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
        const health = await waitForSurplusHealth("upstream_error");
        assert.equal(health.status, null);
        assert.equal(health.provider_request_id, "free-glm-empty-provider");
      });

      await step("client cancellation after headers does not mark Surplus degraded", async () => {
        clearSurplusHealth();
        const keyId = "free-glm-cancel-key";
        const requestId = "free-glm-cancel-request";
        let upstreamCancelled = 0;
        const response = await withFetchMock(
          (url) => {
            assert.equal(url, "https://api.surplusintelligence.ai/v1/responses");
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  TEXT_ENCODER.encode(
                    "data: " +
                      JSON.stringify({
                        type: "response.created",
                        response: { id: "free-glm-cancel-response", model: TEMPORARY_FREE_SURPLUS_TEST_MODEL },
                      }) +
                      "\n\n"
                  )
                );
                controller.enqueue(TEXT_ENCODER.encode("data: " + JSON.stringify({ type: "response.output_text.delta", delta: "started" }) + "\n\n"));
              },
              cancel() {
                upstreamCancelled += 1;
              },
            });
            return new Response(body, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "X-Oneapi-Request-Id": "free-glm-cancel-provider",
              },
            });
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: TEMPORARY_FREE_SURPLUS_TEST_MODEL,
                  input: "ping",
                  stream: true,
                }),
              }),
              {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: false,
                requestId,
                startedAtMs: Date.now(),
              }
            )
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-upstream"), "surplus");
        await response.body?.cancel("client stopped");
        assert.equal(upstreamCancelled, 1);
        assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
        const health = await waitForSurplusHealth("reachable");
        assert.equal(health.status, 200);
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal((kvStore.get(healthKey) as Record<string, unknown>).event, "reachable");
      });

      assert.equal(removedProviderCalls, 0);
    } finally {
      clearSurplusHealth();
      setRemovedProviderTestAdapterForTest(null);
      setRemovedProviderApiKeyForTest(undefined);
      if (previousDebugRouting === undefined) kvStore.delete(debugKey);
      else kvStore.set(debugKey, previousDebugRouting);
      resetDebugRoutingCacheForTest();
      resetMeteredModelsCacheForTest();
      resetSurplusModelsCacheForTest();
      if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
      else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
      if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
      else process.env.METERED_API_KEY = originalMeteredApiKey;
    }
  }));

test("openai: paid-only catalog models route directly to catalog-proven Surplus", async () => {
  const model = "deepseek-v3.2";
  const keyId = "dynamic-deepseek-surplus-tools";
  const requestId = `request-${keyId}`;
  const originalMeteredApiKey = process.env.METERED_API_KEY;
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  const originalDateNow = Date.now;
  let nowMs = originalDateNow();
  Date.now = () => nowMs;
  process.env.METERED_API_KEY = "metered-test-key";
  process.env.SURPLUS_API_KEY = "surplus-test-key";
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  seedPaidFallbackKey(keyId, {
    limitMicrocredits: -1,
    modelIds: [DEFAULT_TEST_MODEL],
  });
  const tools = [
    {
      type: "function",
      name: "inspect_workspace",
      description: "Inspect the workspace before continuing.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: false,
    },
  ];

  try {
    // The explicit inference request must refresh stale non-null catalogs
    // before it decides that this paid-only model belongs on Codex.
    await fetchMeteredModels({
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [
              {
                id: "previous-metered-model",
                supported_endpoint_types: ["openai-response"],
              },
            ],
          })
        ),
    });
    await fetchSurplusModels({
      apiKey: "surplus-test-key",
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [
              {
                id: "previous-surplus-model",
                provider: "Surplus",
                pricing: { prompt: 0.000001, completion: 0.000003 },
              },
            ],
          })
        ),
    });
    nowMs += Math.max(METERED_MODELS_CACHE_TTL_MS, SURPLUS_MODELS_CACHE_TTL_MS) + 1;
    setMeteredModelsFetchForTest((input, init) => globalThis.fetch(input, init));

    let meteredCatalogCalls = 0;
    let surplusCatalogCalls = 0;
    let codexCalls = 0;
    let surplusCalls = 0;
    let forwardedBody: Record<string, unknown> | null = null;
    const response = await withFetchMock(
      (url, bodyText) => {
        if (url === "https://api.openlux.ai/v1/models") {
          meteredCatalogCalls += 1;
          return Response.json({
            data: [
              {
                id: "previous-metered-model",
                supported_endpoint_types: ["openai-response"],
              },
            ],
          });
        }
        if (url === "https://api.surplusintelligence.ai/v1/models") {
          surplusCatalogCalls += 1;
          return Response.json({
            data: [
              {
                id: model,
                provider: "DeepSeek",
                supported_parameters: ["tools", "tool_choice", "reasoning"],
                supported_features: ["streaming", "tools", "reasoning"],
                pricing: { prompt: 0.000001, completion: 0.000003 },
              },
            ],
          });
        }
        if (url === "https://chatgpt.com/backend-api/codex/responses") {
          codexCalls += 1;
          throw new Error("dynamic DeepSeek requests must not reach Codex");
        }
        if (url === "https://api.surplusintelligence.ai/v1/responses") {
          surplusCalls += 1;
          forwardedBody = JSON.parse(String(bodyText)) as Record<string, unknown>;
          return sseResponse(baseSseChunks());
        }
        throw new Error(`Unexpected upstream request in DeepSeek direct-routing test: ${url}`);
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              input: "inspect the workspace",
              tools,
              tool_choice: "auto",
              parallel_tool_calls: true,
              reasoning: { effort: "max" },
              stream: true,
            }),
          }),
          {
            keyId,
            kernelRepo: null,
            kernelOrg: null,
            paidFallbackEnabled: true,
            requestId,
            startedAtMs: Date.now(),
            startedAtMonotonicMs: performance.now(),
          }
        )
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-upstream"), "surplus");
    assert.equal(meteredCatalogCalls, 1);
    assert.equal(surplusCatalogCalls, 1);
    assert.equal(codexCalls, 0);
    assert.equal(surplusCalls, 1);
    assert.deepEqual(getResponseTelemetry(response)?.attemptedProviders, ["surplus"]);
    assert.equal(getResponseTelemetry(response)?.fallbackReason, "dynamic_paid_model");
    assert.equal(typeof getResponseTelemetry(response)?.firstProviderDispatchMs, "number");
    assert.equal(typeof getResponseTelemetry(response)?.firstProviderHeadersMs, "number");
    assert.equal(getResponseTelemetry(response)?.firstCodexDispatchMs, null);
    assert.equal(getResponseTelemetry(response)?.firstCodexHeadersMs, null);
    assert.deepEqual(forwardedBody, {
      model,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "inspect the workspace" }],
        },
      ],
      store: false,
      stream: true,
      reasoning: { effort: "max" },
      tools,
      tool_choice: "auto",
    });
    await response.text();
    const stored = await waitForPaidFallbackTerminal(keyId, requestId, "completed");
    assert.equal(stored.provider, "surplus");
  } finally {
    Date.now = originalDateNow;
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
    resetMeteredModelsCacheForTest();
    setMeteredModelsFetchForTest(null);
    resetSurplusModelsCacheForTest();
    if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = originalMeteredApiKey;
    if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
  }
});

test("openai: direct paid admission failures do not enter removed-provider recovery", async () => {
  const model = "deepseek-v3.2";
  const keyId = "dynamic-deepseek-admission-stop";
  const requestId = `request-${keyId}`;
  const originalMeteredApiKey = process.env.METERED_API_KEY;
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  Reflect.deleteProperty(process.env, "METERED_API_KEY");
  process.env.SURPLUS_API_KEY = "surplus-test-key";
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  seedPaidFallbackKey(keyId, { limitMicrocredits: -1 });

  let removedProviderCalls = 0;
  setRemovedProviderApiKeyForTest("removed-provider-test-key");
  setRemovedProviderTestAdapterForTest({
    fetchResponses: async (_body, options) => {
      removedProviderCalls += 1;
      await options.beforeDispatch?.();
      options.timing?.onDispatch?.();
      options.timing?.onHeaders?.();
      return { response: sseResponse(baseSseChunks()) };
    },
    modelFromEvent: () => model,
    isEligibleModel: (candidate) => candidate === model,
  });

  try {
    // Endpoint support without complete pricing proves that the model is paid
    // only, but it must fail admission before any provider transport.
    await fetchSurplusModels({
      apiKey: "surplus-test-key",
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [{ id: model, provider: "DeepSeek" }],
          })
        ),
    });

    let upstreamCalls = 0;
    const response = await withFetchMock(
      (url) => {
        upstreamCalls += 1;
        throw new Error(`Admission failure must not reach an upstream: ${url}`);
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, input: "do not recover", stream: true }),
          }),
          {
            keyId,
            kernelRepo: null,
            kernelOrg: null,
            paidFallbackEnabled: true,
            requestId,
            startedAtMs: Date.now(),
          }
        )
    );

    assert.equal(response.status, 503);
    const payload = (await response.json()) as { error?: { code?: string } };
    assert.equal(payload.error?.code, "paid_provider_unconfigured");
    assert.equal(upstreamCalls, 0);
    assert.equal(removedProviderCalls, 0);
    assert.deepEqual(getResponseTelemetry(response)?.attemptedProviders, []);
    assert.equal(getResponseTelemetry(response)?.fallbackReason, "dynamic_paid_model");
    assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
  } finally {
    setRemovedProviderTestAdapterForTest(null);
    setRemovedProviderApiKeyForTest(undefined);
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = originalMeteredApiKey;
    if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
  }
});

test("openai: unknown paid-model routing honors catalog refresh backoff", async () => {
  const model = "deepseek-v3.2";
  const originalMeteredApiKey = process.env.METERED_API_KEY;
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  const originalDateNow = Date.now;
  let nowMs = originalDateNow();
  Date.now = () => nowMs;
  process.env.METERED_API_KEY = "metered-test-key";
  process.env.SURPLUS_API_KEY = "surplus-test-key";
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();

  try {
    await fetchMeteredModels({
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [{ id: "previous-metered-model", supported_endpoint_types: ["openai-response"] }],
          })
        ),
    });
    await fetchSurplusModels({
      apiKey: "surplus-test-key",
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [
              {
                id: model,
                provider: "DeepSeek",
                pricing: { prompt: 0.000001, completion: 0.000003 },
              },
            ],
          })
        ),
    });
    nowMs += Math.max(METERED_MODELS_CACHE_TTL_MS, SURPLUS_MODELS_CACHE_TTL_MS) + 1;
    setMeteredModelsFetchForTest((input, init) => globalThis.fetch(input, init));

    let meteredCatalogCalls = 0;
    let surplusCatalogCalls = 0;
    let inferenceCalls = 0;
    await withFetchMock(
      (url) => {
        if (url === "https://api.openlux.ai/v1/models") {
          meteredCatalogCalls += 1;
          return new Response("catalog unavailable", { status: 503 });
        }
        if (url === "https://api.surplusintelligence.ai/v1/models") {
          surplusCatalogCalls += 1;
          return new Response("catalog unavailable", { status: 503 });
        }
        inferenceCalls += 1;
        throw new Error(`Disabled direct routing must not reach inference: ${url}`);
      },
      async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model, input: "respect discovery backoff" }),
            }),
            {
              keyId: `catalog-backoff-${attempt}`,
              kernelRepo: null,
              kernelOrg: null,
              paidFallbackEnabled: false,
              requestId: `request-catalog-backoff-${attempt}`,
              startedAtMs: Date.now(),
            }
          );
          assert.equal(response.status, 403);
          const payload = (await response.json()) as { error?: { code?: string } };
          assert.equal(payload.error?.code, "paid_fallback_disabled");
          assert.notEqual(getResponseTelemetry(response)?.failureKind, "upstream_http_4xx");
        }
      }
    );

    assert.equal(meteredCatalogCalls, 1);
    assert.equal(surplusCatalogCalls, 1);
    assert.equal(inferenceCalls, 0);
  } finally {
    Date.now = originalDateNow;
    resetMeteredModelsCacheForTest();
    setMeteredModelsFetchForTest(null);
    resetSurplusModelsCacheForTest();
    if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = originalMeteredApiKey;
    if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
  }
});

test("openai: dynamic tool requests reject unverified Surplus capability before transport", async () => {
  const model = "deepseek-v3.2";
  const keyId = "dynamic-deepseek-unverified-tools";
  const requestId = `request-${keyId}`;
  const originalMeteredApiKey = process.env.METERED_API_KEY;
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  Reflect.deleteProperty(process.env, "METERED_API_KEY");
  process.env.SURPLUS_API_KEY = "surplus-test-key";
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  seedPaidFallbackKey(keyId, { limitMicrocredits: -1 });

  try {
    await fetchSurplusModels({
      apiKey: "surplus-test-key",
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [
              {
                id: model,
                provider: "DeepSeek",
                supported_parameters: ["tools"],
                supported_features: ["tools"],
                pricing: { prompt: 0.000001, completion: 0.000003 },
              },
            ],
          })
        ),
    });

    let upstreamCalls = 0;
    const response = await withFetchMock(
      (url) => {
        upstreamCalls += 1;
        throw new Error(`Unverified dynamic tool request must not reach an upstream: ${url}`);
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              input: "inspect the workspace",
              tools: [
                {
                  type: "function",
                  name: "inspect_workspace",
                  description: "Inspect the workspace before continuing.",
                  parameters: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
              reasoning: { effort: "max" },
              stream: true,
            }),
          }),
          {
            keyId,
            kernelRepo: null,
            kernelOrg: null,
            paidFallbackEnabled: true,
            requestId,
            startedAtMs: Date.now(),
          }
        )
    );

    assert.equal(response.status, 400);
    const payload = (await response.json()) as { error?: { code?: string; param?: string } };
    assert.equal(payload.error?.code, "model_tool_calling_unsupported");
    assert.equal(payload.error.param, "tools");
    assert.equal(upstreamCalls, 0);
    assert.deepEqual(getResponseTelemetry(response)?.attemptedProviders, []);
    assert.equal(getResponseTelemetry(response)?.fallbackReason, "dynamic_paid_model");
    assert.notEqual(getResponseTelemetry(response)?.failureKind, "upstream_http_4xx");
    assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
  } finally {
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = originalMeteredApiKey;
    if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
  }
});

test("openai: local paid limit rejection is not an upstream HTTP failure", async () => {
  const keyId = "local-paid-limit-rejection";
  const requestId = `request-${keyId}`;
  const originalMeteredApiKey = process.env.METERED_API_KEY;
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  Reflect.deleteProperty(process.env, "METERED_API_KEY");
  process.env.SURPLUS_API_KEY = "surplus-test-key";
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  seedPaidFallbackKey(keyId, { limitMicrocredits: 100, v3SettledMicrocredits: 100 });

  try {
    await fetchSurplusModels({
      apiKey: "surplus-test-key",
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [
              {
                id: DEFAULT_TEST_MODEL,
                provider: "Surplus",
                supported_endpoint_types: ["openai-response"],
                pricing: { prompt: 0.000001, completion: 0.000003 },
              },
            ],
          })
        ),
    });

    await withProviderSelection(["surplus"], async () => {
      let upstreamCalls = 0;
      const response = await withFetchMock(
        (url) => {
          upstreamCalls += 1;
          throw new Error(`Paid limit rejection must not reach an upstream: ${url}`);
        },
        () =>
          handleResponses(responsesRequest({ model: DEFAULT_TEST_MODEL }), {
            keyId,
            kernelRepo: null,
            kernelOrg: null,
            paidFallbackEnabled: true,
            requestId,
            startedAtMs: Date.now(),
          })
      );

      assert.equal(response.status, 429);
      const payload = (await response.json()) as { error?: { code?: string } };
      assert.equal(payload.error?.code, "paid_fallback_limit_exceeded");
      assert.equal(upstreamCalls, 0);
      assert.notEqual(getResponseTelemetry(response)?.failureKind, "upstream_http_4xx");
      assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
    });
  } finally {
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = originalMeteredApiKey;
    if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
  }
});

test("openai: tool-bearing paid fallback skips Surplus without capability evidence", async () => {
  const originalMeteredApiKey = process.env.METERED_API_KEY;
  const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
  const keyId = "fallback-tools-skip-unverified-surplus";
  const requestId = `request-${keyId}`;
  try {
    process.env.METERED_API_KEY = "metered-test-key";
    process.env.SURPLUS_API_KEY = "surplus-test-key";
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    await fetchMeteredModels({
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [{ id: DEFAULT_TEST_MODEL, supported_endpoint_types: ["openai-response"] }],
          })
        ),
    });
    await fetchSurplusModels({
      apiKey: "surplus-test-key",
      force: true,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            data: [
              {
                id: DEFAULT_TEST_MODEL,
                pricing: { prompt: 0.000001, completion: 0.000003 },
              },
            ],
          })
        ),
    });
    seedPaidFallbackKey(keyId);
    let surplusCalls = 0;
    let meteredCalls = 0;

    const response = await withFetchMock(
      (url) => {
        if (url === "https://api.surplusintelligence.ai/v1/responses") {
          surplusCalls += 1;
          throw new Error("unverified Surplus tool transport must not start");
        }
        if (url === "https://api.openlux.ai/v1/responses") {
          meteredCalls += 1;
          return sseResponse(baseSseChunks());
        }
        return authoritativeCodexQuotaResponse();
      },
      () =>
        handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEFAULT_TEST_MODEL,
              input: "inspect the workspace",
              tools: [
                {
                  type: "function",
                  name: "inspect_workspace",
                  description: "Inspect the workspace before continuing.",
                  parameters: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
            }),
          }),
          { keyId, kernelRepo: null, kernelOrg: null, requestId, startedAtMs: Date.now() }
        )
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-uos-upstream"), "metered");
    assert.equal(surplusCalls, 0);
    assert.equal(meteredCalls, 1);
    const stored = await waitForPaidFallbackTerminal(keyId, requestId, "completed");
    assert.equal(stored.provider, "metered");
  } finally {
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
    kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
    else process.env.METERED_API_KEY = originalMeteredApiKey;
    if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
    else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
  }
});
