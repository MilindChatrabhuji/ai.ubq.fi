import type { SequenceStep } from "./sequence.ts";
// Metered paid fallback routing matrix, part 1 of 2, moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  type CodexAuthPoolState,
  DEBUG_ROUTING_KEY,
  DEFAULT_TEST_MODEL,
  TEXT_ENCODER,
  authoritativeCodexQuotaResponse,
  baseSseChunks,
  fetchMeteredModels,
  fetchSurplusModels,
  gatewayHandler,
  getResponseTelemetry,
  getStoredPaidFallbackRequest,
  handleChatCompletions,
  handleResponses,
  keyToString,
  kvStore,
  markCodexUpstreamTimeout,
  recordPromptCacheAnalytics,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  resetDebugRoutingCacheForTest,
  resetMeteredModelsCacheForTest,
  resetSurplusModelsCacheForTest,
  seedPaidFallbackKey,
  selectCodexRoutingAccounts,
  setAtomicCommitFailure,
  setExposePaidFallbackLedgerEntries,
  setRemovedProviderApiKeyForTest,
  setRemovedProviderTestAdapterForTest,
  sseResponse,
  waitForPaidFallbackTerminal,
  withFetchMock,
  withTerminalRequestLog,
} from "./openai-compat-harness.ts";

export const runMeteredPaidFallbackMatrixPart1 = async (step: SequenceStep): Promise<void> => {
  const originalApiKey = process.env["METERED_API_KEY"];
  process.env["METERED_API_KEY"] = "metered-test-key";
  try {
    await step("already-loaded disabled policy bypasses paid fallback reservation", async () => {
      const keyId = "fallback-policy-bypass";
      seedPaidFallbackKey(keyId, { enabled: true });
      let calls = 0;
      const response = await withFetchMock(
        () => {
          calls += 1;
          return authoritativeCodexQuotaResponse();
        },
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
            }),
            {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              paidFallbackEnabled: false,
              requestId: "request-fallback-policy-bypass",
              startedAtMs: Date.now(),
            }
          )
      );
      assert.equal(response.status, 429);
      assert.equal(calls, 1);
      const stored = kvStore.get(keyToString(["ubq_ai", "api_keys", "id", keyId])) as {
        paid_fallback_reservation_request_id?: string | null;
      };
      assert.equal(stored.paid_fallback_reservation_request_id, null);
    });

    await step("disabled, unpriced, and exhausted keys retain the primary 429", async () => {
      const cases = [
        {
          id: "fallback-disabled",
          options: { enabled: false },
        },
        {
          id: "fallback-unpriced",
          options: { modelIds: ["some-other-model"] },
        },
        {
          id: "fallback-exhausted",
          options: { limitMicrocredits: 100, v3SettledMicrocredits: 100 },
        },
      ] as const;

      for (const testCase of cases) {
        seedPaidFallbackKey(testCase.id, testCase.options);
        // The primary 429 may still trigger a paid MODEL CATALOG lookup, so
        // count Codex inference and paid inference separately instead of
        // counting every fetch.
        const codexResponsesUrl = "https://chatgpt.com/backend-api/codex/responses";
        const recognizedCatalogUrls = ["https://api.openlux.ai/v1/models", "https://api.surplusintelligence.ai/v1/models"];
        let codexInferenceCalls = 0;
        const unexpectedTransports: string[] = [];
        const response = await withFetchMock(
          (url) => {
            if (url === codexResponsesUrl) {
              codexInferenceCalls += 1;
              return authoritativeCodexQuotaResponse();
            }
            if (recognizedCatalogUrls.includes(url)) return Response.json({ data: [] });
            unexpectedTransports.push(url);
            return new Response(`unexpected paid or unrecognized transport ${url}`, { status: 500 });
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
              }),
              {
                keyId: testCase.id,
                kernelRepo: null,
                kernelOrg: null,
                requestId: `request-${testCase.id}`,
                startedAtMs: Date.now(),
              }
            )
        );
        assert.equal(response.status, 429, testCase.id);
        assert.equal(codexInferenceCalls, 1, `${testCase.id}: exactly one Codex inference`);
        assert.deepEqual(unexpectedTransports, [], `${testCase.id}: no paid inference or unrecognized transport`);
        assert.deepEqual(await response.json(), {
          error: {
            message: "Primary limited",
            type: "usage_limit_reached",
          },
        });
      }
    });

    await step("fallback admission infrastructure failure retains the authoritative primary 429", async () => {
      const keyId = "fallback-admission-failure";
      seedPaidFallbackKey(keyId);
      setAtomicCommitFailure((ops) =>
        ops.some((op) => op.type === "set" && op.key[0] === "uos_ai" && op.key[1] === "paid_fallback" && op.key[2] === "v3")
          ? new Error("Enqueue operations are not supported in KV Connect")
          : null
      );
      let calls = 0;
      try {
        const response = await withFetchMock(
          () => {
            calls += 1;
            return authoritativeCodexQuotaResponse();
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
              }),
              {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                requestId: "request-fallback-admission-failure",
                startedAtMs: Date.now(),
              }
            )
        );
        assert.equal(response.status, 429);
        assert.match(response.headers.get("Retry-After") ?? "", / GMT$/);
        assert.equal(calls, 1);
      } finally {
        setAtomicCommitFailure(null);
      }
    });

    await step("primary 402, errors, and network failures other than 429 never dispatch Metered", async () => {
      for (const scenario of ["http_402", "http_500", "network"] as const) {
        const keyId = `fallback-${scenario}`;
        seedPaidFallbackKey(keyId);
        let calls = 0;
        const response = await withFetchMock(
          () => {
            calls += 1;
            if (scenario === "network") throw new TypeError("primary network unavailable");
            return new Response(JSON.stringify({ error: { message: "Primary failed" } }), {
              status: scenario === "http_402" ? 402 : 500,
              headers: { "Content-Type": "application/json" },
            });
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
              }),
              {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                requestId: `request-${keyId}`,
                startedAtMs: Date.now(),
              }
            )
        );
        const expectedStatus = { http_402: 402, http_500: 500, network: 502 }[scenario];
        assert.equal(response.status, expectedStatus);
        assert.equal(calls, 1);
      }
    });

    await step("primary 401 and 403 fail closed without paid dispatch", async () => {
      const debugKey = keyToString(DEBUG_ROUTING_KEY);
      const previousDebugRouting = kvStore.get(debugKey);
      try {
        for (const status of [401, 403] as const) {
          const keyId = `fallback-primary-${status}`;
          const requestId = `request-${keyId}`;
          seedPaidFallbackKey(keyId);
          kvStore.set(debugKey, {
            scenario: `codex_${status}`,
            expires_at_ms: Date.now() + 60_000,
            updated_at_ms: Date.now(),
          });
          resetDebugRoutingCacheForTest();
          let paidCalls = 0;
          const response = await withFetchMock(
            () => {
              paidCalls += 1;
              throw new Error(`primary ${status} must not dispatch paid inference`);
            },
            () =>
              handleResponses(
                new Request("https://ai.ubq.fi/v1/responses", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "fail closed" }),
                }),
                { keyId, kernelRepo: null, kernelOrg: null, requestId, startedAtMs: Date.now() }
              )
          );

          assert.equal(response.status, status);
          assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
          assert.equal(getResponseTelemetry(response)?.fallbackReason, null);
          assert.equal(paidCalls, 0);
          assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
        }
        kvStore.set(debugKey, {
          scenario: "normal",
          expires_at_ms: null,
          updated_at_ms: Date.now(),
        });
        resetDebugRoutingCacheForTest();
      } finally {
        if (previousDebugRouting === undefined) kvStore.delete(debugKey);
        else kvStore.set(debugKey, previousDebugRouting);
        resetDebugRoutingCacheForTest();
      }
    });

    await step("a legacy timeout marker does not authorize paid fallback", async () => {
      const keyId = "fallback-upstream-degraded";
      const requestId = "request-fallback-upstream-degraded";
      seedPaidFallbackKey(keyId);
      let codexCalls = 0;
      let meteredCalls = 0;
      const response = await withFetchMock(
        (url) => {
          if (url === "https://api.openlux.ai/v1/responses") {
            meteredCalls += 1;
            throw new Error("a transient Codex failure must not dispatch to a paid provider");
          }
          codexCalls += 1;
          return new Response(JSON.stringify({ error: { message: "transient upstream failure" } }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        },
        async () => {
          const authPool = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as CodexAuthPoolState;
          const selected = await selectCodexRoutingAccounts(authPool, authPool.accounts, Date.now());
          assert.equal(selected.kind, "eligible");

          await markCodexUpstreamTimeout(selected.accounts[0]);
          return await handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "timeout circuit" }),
            }),
            {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              requestId,
              startedAtMs: Date.now(),
            }
          );
        }
      );

      assert.equal(response.status, 503);
      assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
      assert.equal(getResponseTelemetry(response)?.fallbackReason, null);
      assert.equal(codexCalls, 1);
      assert.equal(meteredCalls, 0);
      await response.text();
    });

    await step("cancellation before fallback admission creates no paid exposure", async () => {
      const keyId = "fallback-cancel-before-dispatch";
      const requestId = "request-fallback-cancel-before-dispatch";
      seedPaidFallbackKey(keyId);
      const controller = new AbortController();
      let codexCalls = 0;
      let meteredCalls = 0;
      const response = await withFetchMock(
        (url) => {
          if (url === "https://api.openlux.ai/v1/responses") {
            meteredCalls += 1;
            return sseResponse(baseSseChunks());
          }
          codexCalls += 1;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(streamController) {
                streamController.enqueue(TEXT_ENCODER.encode('{"error":{"message":"Primary limited"}}'));
              },
              cancel() {
                controller.abort(new DOMException("client disconnected", "AbortError"));
              },
            }),
            {
              status: 429,
              headers: { "Content-Type": "application/json" },
            }
          );
        },
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
              signal: controller.signal,
            }),
            {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              requestId,
              startedAtMs: Date.now(),
            }
          )
      );
      assert.equal(response.status, 499);
      const cancellation = (await response.json()) as { error?: { type?: unknown; code?: unknown; param?: unknown } };
      assert.equal(cancellation.error?.type, "server_error");
      assert.equal(cancellation.error.code, "request_cancelled");
      assert.equal(cancellation.error.param, null);
      assert.equal(codexCalls, 1);
      assert.equal(meteredCalls, 0);
      assert.equal(getResponseTelemetry(response)?.provider, "chatgpt_codex");
      assert.equal(getResponseTelemetry(response)?.streamTerminalType, "cancelled");
      const stored = getStoredPaidFallbackRequest(keyId, requestId);
      assert.equal(stored, null);
      const keyRecord = kvStore.get(keyToString(["ubq_ai", "api_keys", "id", keyId])) as {
        usage_reset_at_ms: number;
      };
      const window = kvStore.get(keyToString(["uos_ai", "paid_fallback", "v3", "window", keyId, keyRecord.usage_reset_at_ms])) as
        { reserved_microcredits?: number; pending_count?: number } | undefined;
      assert.equal(window, undefined);
    });

    await step("Responses strips only Codex-incompatible controls before Metered fallback", async () => {
      const keyId = "fallback-responses-success";
      seedPaidFallbackKey(keyId);
      const bodies: Record<string, unknown>[] = [];
      const urls: string[] = [];
      const response = await withFetchMock(
        (url, bodyText, init) => {
          urls.push(url);
          if (bodyText) bodies.push(JSON.parse(bodyText) as Record<string, unknown>);
          if (url === "https://api.openlux.ai/v1/responses") {
            const stored = getStoredPaidFallbackRequest(keyId, "request-fallback-responses-success");
            assert.equal(stored?.dispatch_state, "dispatched");
            assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer metered-test-key");
            return new Response(sseResponse(baseSseChunks()).body, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "X-Oneapi-Request-Id": "metered-responses-request",
              },
            });
          }
          return authoritativeCodexQuotaResponse({
            "x-uos-warning": "codex_quota_temporarily_exceeded",
          });
        },
        () =>
          handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: DEFAULT_TEST_MODEL,
                input: [
                  {
                    type: "message",
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: "stable fallback prefix",
                        prompt_cache_breakpoint: { mode: "explicit" },
                      },
                    ],
                  },
                ],
                max_output_tokens: 64,
                prompt_cache_key: "fallback-cache-key",
                prompt_cache_options: { mode: "explicit", ttl: "30m" },
                prompt_cache_retention: "24h",
                reasoning: { effort: "ultra" },
              }),
            }),
            {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              requestId: "request-fallback-responses-success",
              startedAtMs: Date.now(),
            }
          )
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-uos-upstream"), "metered");
      assert.equal(response.headers.get("x-uos-warning"), null);
      assert.equal(getResponseTelemetry(response)?.quotaUsedPercent, 0);
      assert.equal(getResponseTelemetry(response)?.fallbackReason, "primary_quota_blocked");
      assert.deepEqual(urls, ["https://chatgpt.com/backend-api/codex/responses", "https://api.openlux.ai/v1/responses"]);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].prompt_cache_key, "fallback-cache-key");
      assert.equal("max_output_tokens" in bodies[0], false);
      assert.equal("prompt_cache_options" in bodies[0], false);
      assert.equal("prompt_cache_retention" in bodies[0], false);
      const codexInput = bodies[0].input as Record<string, unknown>[];
      const codexContent = codexInput[0]?.content as Record<string, unknown>[];
      assert.equal("prompt_cache_breakpoint" in codexContent[0], false);
      assert.equal(bodies[1].max_output_tokens, 64);
      assert.equal(bodies[1].prompt_cache_key, "fallback-cache-key");
      assert.deepEqual(bodies[1].prompt_cache_options, { mode: "explicit", ttl: "30m" });
      assert.equal(bodies[1].prompt_cache_retention, "24h");
      const meteredInput = bodies[1].input as Record<string, unknown>[];
      const meteredContent = meteredInput[0]?.content as Record<string, unknown>[];
      assert.deepEqual(meteredContent[0]?.prompt_cache_breakpoint, { mode: "explicit" });
      assert.deepEqual(bodies[1].reasoning, { effort: "max" });

      const recordedAnalyticsEvents: Parameters<typeof recordPromptCacheAnalytics>[0][] = [];
      await withTerminalRequestLog(response, {
        route: "responses",
        startedAtMonotonicMs: performance.now(),
        requestId: "cache-analytics-metered-fallback",
        recordCacheAnalytics: (event) => {
          recordedAnalyticsEvents.push(event);
          return Promise.resolve({
            status: "ignored" as const,
            reason: "unknown_release" as const,
            bucket_start_at_ms: null,
          });
        },
        recordTelemetry: () =>
          Promise.resolve({
            status: "ignored" as const,
            reason: "unknown_release" as const,
            release: null,
            provider: null,
            route: null,
            model_hash: null,
          }),
      });
      const recordedAnalyticsEvent = recordedAnalyticsEvents[0];
      assert.ok(recordedAnalyticsEvent);
      assert.deepEqual(
        {
          provider: recordedAnalyticsEvent.provider,
          model: recordedAnalyticsEvent.model,
          route: recordedAnalyticsEvent.route,
          promptCacheKeyPresent: recordedAnalyticsEvent.promptCacheKeyPresent,
          promptCacheMode: recordedAnalyticsEvent.promptCacheMode,
          fallbackReason: recordedAnalyticsEvent.fallbackReason,
        },
        {
          provider: "metered",
          model: DEFAULT_TEST_MODEL,
          route: "responses",
          promptCacheKeyPresent: true,
          promptCacheMode: "explicit",
          fallbackReason: "primary_quota_blocked",
        }
      );
      assert.equal("affinityOutcome" in recordedAnalyticsEvent, false);
    });

    await step("streaming Responses closes after Metered's terminal event even when its socket stays open", async () => {
      const keyId = "fallback-responses-hanging-socket";
      seedPaidFallbackKey(keyId);
      let upstreamCancelled = false;
      const chunks = baseSseChunks();
      const terminalChunk = chunks.pop();
      assert.ok(terminalChunk);
      const crlfTerminalChunk = terminalChunk.replace(/\n/g, "\r\n");
      chunks.push(crlfTerminalChunk.slice(0, -1), `${crlfTerminalChunk.slice(-1)}: post-terminal bytes must not be forwarded\r\n\r\n`);

      const responseText = await withFetchMock(
        (url) => {
          if (url === "https://api.openlux.ai/v1/responses") {
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(TEXT_ENCODER.encode(chunk));
              },
              cancel() {
                upstreamCancelled = true;
              },
            });
            return new Response(body, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "X-Oneapi-Request-Id": "metered-hanging-socket-request",
              },
            });
          }
          if (url === "https://api.openlux.ai/api/log/token") {
            return new Response(JSON.stringify({ success: true, data: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return authoritativeCodexQuotaResponse();
        },
        async () => {
          const response = await handleResponses(
            new Request("https://ai.ubq.fi/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }),
            }),
            {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              requestId: "request-fallback-responses-hanging-socket",
              startedAtMs: Date.now(),
            }
          );
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("x-uos-upstream"), "metered");
          return await response.text();
        }
      );

      assert.match(responseText, /"type":"response.completed"/);
      assert.doesNotMatch(responseText, /post-terminal/);
      assert.equal(upstreamCancelled, true);
    });

    await step("Chat Completions also falls back through Metered Responses once", async () => {
      const keyId = "fallback-chat-success";
      seedPaidFallbackKey(keyId);
      const urls: string[] = [];
      const response = await withFetchMock(
        (url) => {
          urls.push(url);
          if (url === "https://api.openlux.ai/v1/responses") {
            return new Response(sseResponse(baseSseChunks()).body, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "X-Oneapi-Request-Id": "metered-chat-request",
              },
            });
          }
          return authoritativeCodexQuotaResponse();
        },
        () =>
          handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: DEFAULT_TEST_MODEL,
                messages: [{ role: "user", content: "ping" }],
              }),
            }),
            {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              requestId: "request-fallback-chat-success",
              startedAtMs: Date.now(),
            }
          )
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-uos-upstream"), "metered");
      assert.deepEqual(urls, ["https://chatgpt.com/backend-api/codex/responses", "https://api.openlux.ai/v1/responses"]);
    });

    await step("all recognized terminal events are recorded across routes and stream modes", async () => {
      const terminalCases = [
        { eventType: "response.completed", terminalState: "completed" },
        { eventType: "response.failed", terminalState: "failed" },
        { eventType: "response.incomplete", terminalState: "incomplete" },
        { eventType: "error", terminalState: "failed" },
      ] as const;
      const routeCases = [
        { route: "responses", stream: false },
        { route: "responses", stream: true },
        { route: "chat", stream: false },
        { route: "chat", stream: true },
      ] as const;

      for (const routeCase of routeCases) {
        for (const terminalCase of terminalCases) {
          const suffix = `${routeCase.route}-${routeCase.stream ? "stream" : "buffered"}-${terminalCase.eventType.replace(".", "-")}`;
          const keyId = `fallback-terminal-${suffix}`;
          const requestId = `request-${keyId}`;
          seedPaidFallbackKey(keyId);
          const terminalValue =
            terminalCase.eventType === "error"
              ? {
                  type: "error",
                  error: { type: "server_error", code: "provider_error", message: "provider failed" },
                }
              : {
                  type: terminalCase.eventType,
                  response: {
                    id: `resp_${suffix}`,
                    status: terminalCase.terminalState,
                    model: DEFAULT_TEST_MODEL,
                    output:
                      terminalCase.eventType === "response.completed"
                        ? [
                            {
                              type: "message",
                              role: "assistant",
                              content: [{ type: "output_text", text: "terminal output" }],
                            },
                          ]
                        : [],
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                  },
                };

          await withFetchMock(
            (url) => {
              if (url === "https://api.openlux.ai/v1/responses") {
                return new Response(sseResponse([`data: ${JSON.stringify(terminalValue)}\n\n`]).body, {
                  status: 200,
                  headers: {
                    "Content-Type": "text/event-stream",
                    "X-Api-Request-Id": `provider-${suffix}`,
                  },
                });
              }
              if (url.startsWith("https://api.openlux.ai/api/log/token?")) {
                return new Response(JSON.stringify({ success: true, data: { items: [] } }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                });
              }
              return authoritativeCodexQuotaResponse();
            },
            async () => {
              const context = {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                requestId,
                startedAtMs: Date.now(),
              };
              const response =
                routeCase.route === "responses"
                  ? await handleResponses(
                      new Request("https://ai.ubq.fi/v1/responses", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          model: DEFAULT_TEST_MODEL,
                          input: "ping",
                          stream: routeCase.stream,
                        }),
                      }),
                      context
                    )
                  : await handleChatCompletions(
                      new Request("https://ai.ubq.fi/v1/chat/completions", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          model: DEFAULT_TEST_MODEL,
                          messages: [{ role: "user", content: "ping" }],
                          stream: routeCase.stream,
                        }),
                      }),
                      context
                    );
              await response.text();
              const expectedStatus =
                routeCase.stream || terminalCase.eventType === "response.completed" || (routeCase.route === "responses" && terminalCase.eventType !== "error")
                  ? 200
                  : 502;
              assert.equal(response.status, expectedStatus, suffix);
              assert.equal(getResponseTelemetry(response)?.streamTerminalType, terminalCase.eventType, suffix);
              const stored = await waitForPaidFallbackTerminal(keyId, requestId, terminalCase.terminalState);
              assert.equal(stored.dispatch_state, "dispatched", suffix);
              assert.equal(stored.billing_state, "pending", suffix);
            }
          );
        }
      }
    });

    await step("Metered network ambiguity returns an attributed 502 without retrying", async () => {
      const routeCases = [
        { route: "responses", stream: false },
        { route: "responses", stream: true },
        { route: "chat", stream: false },
        { route: "chat", stream: true },
      ] as const;
      for (const routeCase of routeCases) {
        const suffix = `${routeCase.route}-${routeCase.stream ? "stream" : "buffered"}`;
        const keyId = `fallback-network-error-${suffix}`;
        const requestId = `request-${keyId}`;
        const promptCacheKey = `fallback-cache-key-${suffix}`;
        const codexSessionHeaders = ["conversation_id", "session-id", "thread-id", "x-client-request-id"] as const;
        seedPaidFallbackKey(keyId);
        let meteredAttempts = 0;
        const codexRequestHeaders: Headers[] = [];
        const paidRequests: Readonly<{ body: Record<string, unknown>; headers: Headers }>[] = [];
        await withFetchMock(
          (url, bodyText, init) => {
            const headers = new Headers(init?.headers);
            if (url === "https://api.openlux.ai/v1/responses") {
              meteredAttempts += 1;
              paidRequests.push({
                body: JSON.parse(bodyText ?? "{}") as Record<string, unknown>,
                headers,
              });
              throw new TypeError("network connection reset before response headers");
            }
            codexRequestHeaders.push(headers);
            return authoritativeCodexQuotaResponse();
          },
          async () => {
            const context = {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              requestId,
              startedAtMs: Date.now(),
            };
            const response =
              routeCase.route === "responses"
                ? await handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        input: "ping",
                        stream: routeCase.stream,
                        prompt_cache_key: promptCacheKey,
                        prompt_cache_options: { mode: "explicit", ttl: "30m" },
                        prompt_cache_retention: "24h",
                      }),
                    }),
                    context
                  )
                : await handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        messages: [{ role: "user", content: "ping" }],
                        stream: routeCase.stream,
                        prompt_cache_key: promptCacheKey,
                        prompt_cache_options: { mode: "explicit", ttl: "30m" },
                        prompt_cache_retention: "24h",
                      }),
                    }),
                    context
                  );
            assert.equal(response.status, 502, suffix);
            assert.equal(response.headers.get("x-uos-upstream"), "metered", suffix);
            assert.equal(meteredAttempts, 1, suffix);
            assert.ok(codexRequestHeaders.length > 0, suffix);
            for (const headers of codexRequestHeaders) {
              const sessionIdentity = headers.get("conversation_id");
              assert.ok(sessionIdentity, suffix);
              for (const header of codexSessionHeaders) {
                assert.equal(headers.get(header), sessionIdentity, `${suffix}:${header}`);
              }
            }
            assert.equal(paidRequests.length, 1, suffix);
            const paidRequest = paidRequests[0];
            assert.equal(paidRequest.body.prompt_cache_key, promptCacheKey, suffix);
            assert.deepEqual(paidRequest.body.prompt_cache_options, { mode: "explicit", ttl: "30m" }, suffix);
            assert.equal(paidRequest.body.prompt_cache_retention, "24h", suffix);
            for (const header of codexSessionHeaders) {
              assert.equal(paidRequest.headers.has(header), false, `${suffix}:${header}`);
            }
            const payload = (await response.json()) as {
              error?: { type?: unknown; code?: unknown };
            };
            assert.equal(payload.error?.type, "server_error", suffix);
            assert.equal(payload.error.code, "metered_upstream_unreachable", suffix);
            const stored = await waitForPaidFallbackTerminal(keyId, requestId, "ambiguous");
            assert.equal(stored.dispatch_state, "dispatched", suffix);
            assert.equal(stored.provider_request_id, null, suffix);
            assert.equal(stored.billing_state, "pending", suffix);
          }
        );
      }
    });

    await step("Surplus network ambiguity fails closed on Surplus and retains the spend cap", async () => {
      const previousMeteredApiKey = process.env["METERED_API_KEY"];
      const previousSurplusApiKey = process.env["SURPLUS_API_KEY"];
      try {
        process.env["METERED_API_KEY"] = "metered-test-key";
        process.env["SURPLUS_API_KEY"] = "surplus-test-key";
        resetMeteredModelsCacheForTest();
        resetSurplusModelsCacheForTest();
        await fetchMeteredModels({
          force: true,
          fetcher: () =>
            Promise.resolve(
              Response.json({
                data: [{ id: DEFAULT_TEST_MODEL, supported_endpoint_types: ["openai-response", "openai"] }],
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
        for (const routeCase of [
          { route: "responses", stream: false },
          { route: "responses", stream: true },
          { route: "chat", stream: false },
          { route: "chat", stream: true },
        ] as const) {
          const suffix = `${routeCase.route}-${routeCase.stream ? "stream" : "buffered"}`;
          const keyId = `fallback-surplus-network-${suffix}`;
          const requestId = `request-${keyId}`;
          const promptCacheKey = `fallback-cache-key-${suffix}`;
          const codexSessionHeaders = ["conversation_id", "session-id", "thread-id", "x-client-request-id"] as const;
          seedPaidFallbackKey(keyId);
          let surplusAttempts = 0;
          let meteredAttempts = 0;
          const codexRequestHeaders: Headers[] = [];
          const paidRequests: Readonly<{ body: Record<string, unknown>; headers: Headers }>[] = [];
          await withFetchMock(
            (url, bodyText, init) => {
              const headers = new Headers(init?.headers);
              if (url === "https://api.surplusintelligence.ai/v1/responses") {
                surplusAttempts += 1;
                paidRequests.push({
                  body: JSON.parse(bodyText ?? "{}") as Record<string, unknown>,
                  headers,
                });
                throw new TypeError("network connection reset before response headers");
              }
              if (url === "https://api.openlux.ai/v1/responses") {
                meteredAttempts += 1;
                return sseResponse(baseSseChunks());
              }
              codexRequestHeaders.push(headers);
              return authoritativeCodexQuotaResponse();
            },
            async () => {
              const response =
                routeCase.route === "responses"
                  ? await handleResponses(
                      new Request("https://ai.ubq.fi/v1/responses", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          model: DEFAULT_TEST_MODEL,
                          input: "ping",
                          stream: routeCase.stream,
                          prompt_cache_key: promptCacheKey,
                          prompt_cache_options: { mode: "explicit", ttl: "30m" },
                          prompt_cache_retention: "24h",
                        }),
                      }),
                      { keyId, kernelRepo: null, kernelOrg: null, requestId, startedAtMs: Date.now() }
                    )
                  : await handleChatCompletions(
                      new Request("https://ai.ubq.fi/v1/chat/completions", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          model: DEFAULT_TEST_MODEL,
                          messages: [{ role: "user", content: "ping" }],
                          stream: routeCase.stream,
                          prompt_cache_key: promptCacheKey,
                          prompt_cache_options: { mode: "explicit", ttl: "30m" },
                          prompt_cache_retention: "24h",
                        }),
                      }),
                      { keyId, kernelRepo: null, kernelOrg: null, requestId, startedAtMs: Date.now() }
                    );
              // A Surplus transport failure is not an authoritative capacity
              // signal: the request fails closed on Surplus instead of
              // advancing to OpenLux, and the ambiguous exposure stays pending.
              assert.equal(response.status, 502, suffix);
              assert.equal(response.headers.get("x-uos-upstream"), "surplus", suffix);
              assert.equal(surplusAttempts, 1, suffix);
              assert.equal(meteredAttempts, 0, suffix);
              assert.ok(codexRequestHeaders.length > 0, suffix);
              for (const headers of codexRequestHeaders) {
                const sessionIdentity = headers.get("conversation_id");
                assert.ok(sessionIdentity, suffix);
                for (const header of codexSessionHeaders) {
                  assert.equal(headers.get(header), sessionIdentity, `${suffix}:${header}`);
                }
              }
              assert.equal(paidRequests.length, 1, suffix);
              const paidRequest = paidRequests[0];
              assert.equal(paidRequest.body.prompt_cache_key, promptCacheKey, suffix);
              assert.deepEqual(paidRequest.body.prompt_cache_options, { mode: "explicit", ttl: "30m" }, suffix);
              assert.equal(paidRequest.body.prompt_cache_retention, "24h", suffix);
              for (const header of codexSessionHeaders) {
                assert.equal(paidRequest.headers.has(header), false, `${suffix}:${header}`);
              }
              const payload = (await response.json()) as {
                error?: { type?: unknown; code?: unknown };
              };
              assert.equal(payload.error?.type, "server_error", suffix);
              assert.equal(payload.error.code, "surplus_upstream_unreachable", suffix);
              const stored = await waitForPaidFallbackTerminal(keyId, requestId, "ambiguous");
              assert.equal(stored.provider, "surplus", suffix);
              assert.equal(stored.dispatch_state, "dispatched", suffix);
              assert.equal(stored.provider_request_id, null, suffix);
              assert.equal(stored.billing_state, "pending", suffix);
            }
          );
        }
      } finally {
        resetMeteredModelsCacheForTest();
        resetSurplusModelsCacheForTest();
        if (previousMeteredApiKey === undefined) delete process.env["METERED_API_KEY"];
        else process.env["METERED_API_KEY"] = previousMeteredApiKey;
        if (previousSurplusApiKey === undefined) delete process.env["SURPLUS_API_KEY"];
        else process.env["SURPLUS_API_KEY"] = previousSurplusApiKey;
      }
    });

    await step("failed RemovedProvider fallback restores primary Codex correlation", async () => {
      const debugKey = keyToString(DEBUG_ROUTING_KEY);
      const previousDebugRouting = kvStore.get(debugKey);
      const originalInfo = console.info;
      const logs: unknown[][] = [];
      setRemovedProviderApiKeyForTest("removed-provider-test-key");
      setRemovedProviderTestAdapterForTest({
        fetchResponses: () => {
          throw new Error("RemovedProvider fallback failed");
        },
        modelFromEvent: () => null,
        isEligibleModel: (model) => model === DEFAULT_TEST_MODEL,
      });
      kvStore.set(debugKey, {
        scenario: "normal",
        expires_at_ms: Date.now() + 60_000,
        updated_at_ms: Date.now(),
      });
      resetDebugRoutingCacheForTest();
      console.info = (...args: unknown[]) => logs.push(args);
      try {
        const response = await withFetchMock(
          () =>
            new Response(JSON.stringify({ error: { message: "Codex primary failed" } }), {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "X-Request-Id": "failed-codex-primary-id",
              },
            }),
          () =>
            gatewayHandler(
              new Request("http://localhost/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "preserve primary correlation" }),
              })
            )
        );
        assert.equal(response.status, 500);
        assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
        assert.equal(response.headers.get("x-uos-provider-request-id"), "failed-codex-primary-id");
        await response.json();
        for (let attempt = 0; attempt < 100 && logs.length === 0; attempt += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        const terminals = logs
          .filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal")
          .map((entry) => JSON.parse(String(entry[1])) as Record<string, unknown>);
        assert.equal(terminals.length, 1);
        const terminal = terminals[0];
        assert.equal(terminal.provider, "chatgpt_codex");
        assert.equal(terminal.provider_request_id, "failed-codex-primary-id");
        assert.equal(terminal.account_slot, 1);
        assert.equal(typeof terminal.account_cohort_id, "string");
      } finally {
        console.info = originalInfo;
        setRemovedProviderTestAdapterForTest(null);
        setRemovedProviderApiKeyForTest(undefined);
        if (previousDebugRouting === undefined) kvStore.delete(debugKey);
        else kvStore.set(debugKey, previousDebugRouting);
        resetDebugRoutingCacheForTest();
      }
    });

    await step("Codex primary 400 never advances to RemovedProvider or paid transport", async () => {
      const debugKey = keyToString(DEBUG_ROUTING_KEY);
      const previousDebugRouting = kvStore.get(debugKey);
      const codexResponsesUrl = "https://chatgpt.com/backend-api/codex/responses";
      const recognizedCatalogUrls = ["https://api.openlux.ai/v1/models", "https://api.surplusintelligence.ai/v1/models"];
      let codexInferenceCalls = 0;
      const unexpectedTransports: string[] = [];
      let removedProviderCalls = 0;
      setRemovedProviderApiKeyForTest("removed-provider-test-key");
      setRemovedProviderTestAdapterForTest({
        fetchResponses: () => {
          removedProviderCalls += 1;
          throw new Error("RemovedProvider must not follow a Codex HTTP 400");
        },
        modelFromEvent: () => null,
        isEligibleModel: (model) => model === DEFAULT_TEST_MODEL,
      });
      kvStore.set(debugKey, {
        scenario: "normal",
        expires_at_ms: Date.now() + 60_000,
        updated_at_ms: Date.now(),
      });
      resetDebugRoutingCacheForTest();
      try {
        const response = await withFetchMock(
          (url) => {
            if (url === codexResponsesUrl) {
              codexInferenceCalls += 1;
              return new Response(JSON.stringify({ error: { message: "Codex rejected the request body." } }), {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "X-Request-Id": "codex-http-400-request-id",
                },
              });
            }
            if (recognizedCatalogUrls.includes(url)) return Response.json({ data: [] });
            unexpectedTransports.push(url);
            return new Response(`unexpected paid or unrecognized transport ${url}`, { status: 500 });
          },
          () =>
            handleResponses(
              new Request("https://ai.ubq.fi/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "reject the request body" }),
              })
            )
        );
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
        await response.json();
        assert.equal(codexInferenceCalls, 1);
        assert.deepEqual(unexpectedTransports, []);
        assert.equal(removedProviderCalls, 0);
        const telemetry = getResponseTelemetry(response);
        assert.ok(telemetry);
        assert.equal(telemetry.failureKind, "upstream_http_4xx");
        assert.equal(telemetry.streamTerminalType, "error");
        assert.deepEqual(telemetry.attemptedProviders, ["chatgpt_codex"]);
        assert.equal(telemetry.fallbackReason, null);
        assert.equal(telemetry.removedProviderTriggerClass, null);
      } finally {
        setRemovedProviderTestAdapterForTest(null);
        setRemovedProviderApiKeyForTest(undefined);
        if (previousDebugRouting === undefined) kvStore.delete(debugKey);
        else kvStore.set(debugKey, previousDebugRouting);
        resetDebugRoutingCacheForTest();
      }
    });

    await step("RemovedProvider recovery clears failed Codex request metadata", async () => {
      const debugKey = keyToString(DEBUG_ROUTING_KEY);
      const previousDebugRouting = kvStore.get(debugKey);
      const originalInfo = console.info;
      const logs: unknown[][] = [];
      setRemovedProviderApiKeyForTest("removed-provider-test-key");
      kvStore.set(debugKey, {
        scenario: "removed_provider_first",
        expires_at_ms: Date.now() + 60_000,
        updated_at_ms: Date.now(),
      });
      resetDebugRoutingCacheForTest();
      console.info = (...args: unknown[]) => logs.push(args);
      try {
        const response = await withFetchMock(
          () =>
            new Response(JSON.stringify({ error: { message: "Codex recovery failed" } }), {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "X-Request-Id": "failed-codex-request-id",
              },
            }),
          () =>
            gatewayHandler(
              new Request("http://localhost/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "recover through RemovedProvider" }),
              })
            )
        );
        assert.equal(response.status, 502);
        assert.equal(response.headers.get("x-uos-upstream"), "removed_provider");
        assert.equal(response.headers.get("x-uos-provider-request-id"), null);
        const terminal = logs
          .filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal")
          .map((entry) => JSON.parse(String(entry[1])) as Record<string, unknown>)[0];
        assert.ok(terminal);
        assert.equal(terminal.provider, "removed_provider");
        assert.equal(terminal.provider_request_id, null);
        assert.equal(terminal.account_slot, null);
        assert.equal(terminal.account_cohort_id, null);
      } finally {
        console.info = originalInfo;
        setRemovedProviderApiKeyForTest(undefined);
        if (previousDebugRouting === undefined) kvStore.delete(debugKey);
        else kvStore.set(debugKey, previousDebugRouting);
        resetDebugRoutingCacheForTest();
      }
    });
  } finally {
    setAtomicCommitFailure(null);
    setExposePaidFallbackLedgerEntries(false);
    kvStore.delete(keyToString(CODEX_ACCOUNT_ROUTING_KV_KEY));
    resetCodexAccountRoutingForTest();
    resetCodexAuthCacheForTest();
    if (originalApiKey === undefined) delete process.env["METERED_API_KEY"];
    else process.env["METERED_API_KEY"] = originalApiKey;
  }
};
