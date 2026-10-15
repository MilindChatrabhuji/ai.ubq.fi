import type { SequenceStep } from "./sequence.ts";
// Metered paid fallback routing matrix, part 2 of 2, moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  type CodexAuthPoolState,
  DEBUG_ROUTING_KEY,
  DEFAULT_TEST_MODEL,
  Deferred,
  type OpenAiAtomicOp,
  TEXT_ENCODER,
  atomicCommitObservation,
  atomicWritesForKey,
  authoritativeCodexQuotaResponse,
  baseSseChunks,
  captureResolve,
  gatewayHandler,
  getResponseTelemetry,
  handleChatCompletions,
  handleResponses,
  keyToString,
  kvStore,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  resetDebugRoutingCacheForTest,
  resetProviderHealthThrottleForTest,
  runValidatedTerminalCancellationCase,
  seedPaidFallbackKey,
  setAtomicCommitFailure,
  setExposePaidFallbackLedgerEntries,
  setRemovedProviderApiKeyForTest,
  setRemovedProviderTestAdapterForTest,
  sha256Hex,
  sseResponse,
  waitForPaidFallbackTerminal,
  withFetchMock,
} from "./openai-compat-harness.ts";

export const runMeteredPaidFallbackMatrixPart2 = async (step: SequenceStep): Promise<void> => {
  const originalApiKey = process.env.METERED_API_KEY;
  process.env.METERED_API_KEY = "metered-test-key";
  try {
    await step("direct Codex failure selects RemovedProvider without failed metadata", async () => {
      const debugKey = keyToString(DEBUG_ROUTING_KEY);
      const previousDebugRouting = kvStore.get(debugKey);
      const originalInfo = console.info;
      const logs: unknown[][] = [];
      let removedProviderBody: Record<string, unknown> | null = null;
      setRemovedProviderApiKeyForTest("removed-provider-test-key");
      setRemovedProviderTestAdapterForTest({
        fetchResponses: async (body, options) => {
          removedProviderBody = structuredClone(body);
          await options.beforeDispatch?.();
          options.timing?.onDispatch?.();
          options.timing?.onHeaders?.();
          return {
            response: sseResponse([
              `data: ${JSON.stringify({
                type: "response.created",
                response: { id: "resp_removed_provider_direct", model: DEFAULT_TEST_MODEL },
              })}\n\n`,
              `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Recovered" })}\n\n`,
              `data: ${JSON.stringify({
                type: "response.completed",
                response: {
                  id: "resp_removed_provider_direct",
                  model: DEFAULT_TEST_MODEL,
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              })}\n\n`,
            ]),
          };
        },
        modelFromEvent: (value) => {
          const response = value.response;
          if (!response || typeof response !== "object" || Array.isArray(response)) return null;
          const model = (response as Record<string, unknown>).model;
          return typeof model === "string" ? model : null;
        },
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
            new Response(JSON.stringify({ error: { message: "Codex direct failure" } }), {
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
                body: JSON.stringify({
                  model: DEFAULT_TEST_MODEL,
                  prompt_cache_key: "removed-provider-cache-key",
                  prompt_cache_options: { mode: "explicit", ttl: "30m" },
                  prompt_cache_retention: "24h",
                  input: [
                    {
                      type: "input_text",
                      text: "recover through RemovedProvider",
                      prompt_cache_breakpoint: { mode: "explicit" },
                    },
                  ],
                }),
              })
            )
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-upstream"), "removed_provider");
        assert.equal(response.headers.get("x-uos-provider-request-id"), null);
        assert.equal(response.headers.get("x-uos-warning"), null);
        assert.ok(removedProviderBody);
        const forwardedBody = removedProviderBody as Record<string, unknown>;
        assert.equal(forwardedBody.prompt_cache_key, "removed-provider-cache-key");
        assert.deepEqual(forwardedBody.prompt_cache_options, { mode: "explicit", ttl: "30m" });
        assert.equal(forwardedBody.prompt_cache_retention, "24h");
        const forwardedInput = forwardedBody.input as Record<string, unknown>[];
        const forwardedContent = forwardedInput[0]?.content as Record<string, unknown>[];
        assert.deepEqual(forwardedContent[0]?.prompt_cache_breakpoint, { mode: "explicit" });
        await response.text();
        for (let attempt = 0; attempt < 100 && logs.length === 0; attempt += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        const terminals = logs
          .filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal")
          .map((entry) => JSON.parse(String(entry[1])) as Record<string, unknown>);
        assert.equal(terminals.length, 1);
        const terminal = terminals[0];
        assert.equal(terminal.provider, "removed_provider");
        assert.equal(terminal.provider_request_id, null);
        assert.equal(terminal.account_slot, null);
        assert.equal(terminal.account_cohort_id, null);
      } finally {
        console.info = originalInfo;
        setRemovedProviderTestAdapterForTest(null);
        setRemovedProviderApiKeyForTest(undefined);
        if (previousDebugRouting === undefined) kvStore.delete(debugKey);
        else kvStore.set(debugKey, previousDebugRouting);
        resetDebugRoutingCacheForTest();
      }
    });

    await step("Metered pre-header deadlines return an attributed 504 without retrying", async () => {
      const routeCases = [
        { route: "responses", stream: false },
        { route: "responses", stream: true },
        { route: "chat", stream: false },
        { route: "chat", stream: true },
      ] as const;
      for (const routeCase of routeCases) {
        const suffix = `${routeCase.route}-${routeCase.stream ? "stream" : "buffered"}`;
        const keyId = `fallback-deadline-${suffix}`;
        const requestId = `request-${keyId}`;
        seedPaidFallbackKey(keyId);
        const controller = new AbortController();
        let meteredAttempts = 0;
        await withFetchMock(
          (url) => {
            if (url === "https://api.openlux.ai/v1/responses") {
              meteredAttempts += 1;
              controller.abort(new DOMException("gateway deadline exceeded", "TimeoutError"));
              throw controller.signal.reason;
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
                      signal: controller.signal,
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
                      signal: controller.signal,
                    }),
                    context
                  );
            assert.equal(response.status, 504, suffix);
            assert.equal(response.headers.get("x-uos-upstream"), "metered", suffix);
            assert.equal(meteredAttempts, 1, suffix);
            const payload = (await response.json()) as {
              error?: { type?: unknown; code?: unknown };
            };
            assert.equal(payload.error?.type, "server_error", suffix);
            assert.equal(payload.error.code, "gateway_timeout", suffix);
            const stored = await waitForPaidFallbackTerminal(keyId, requestId, "ambiguous");
            assert.equal(stored.dispatch_state, "dispatched", suffix);
            assert.equal(stored.provider_request_id, null, suffix);
            assert.equal(stored.billing_state, "pending", suffix);
          }
        );
      }
    });

    await step("missing Metered bodies are recorded as ambiguous across routes and stream modes", async () => {
      const routeCases = [
        { route: "responses", stream: false },
        { route: "responses", stream: true },
        { route: "chat", stream: false },
        { route: "chat", stream: true },
      ] as const;
      for (const routeCase of routeCases) {
        const suffix = `${routeCase.route}-${routeCase.stream ? "stream" : "buffered"}`;
        const keyId = `fallback-missing-body-${suffix}`;
        const requestId = `request-${keyId}`;
        seedPaidFallbackKey(keyId);
        await withFetchMock(
          (url) => {
            if (url === "https://api.openlux.ai/v1/responses") {
              return new Response(null, {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "X-Api-Request-Id": `provider-${suffix}`,
                },
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
            assert.equal(response.status, 502, suffix);
            assert.equal(getResponseTelemetry(response)?.streamTerminalType, "error", suffix);
            await response.text();
            const stored = await waitForPaidFallbackTerminal(keyId, requestId, "ambiguous");
            assert.equal(stored.billing_state, "pending", suffix);
          }
        );
      }
    });

    await step("premature EOF, malformed events, and reader errors remain billable and ambiguous", async () => {
      const routeCases = [
        { route: "responses", stream: false },
        { route: "responses", stream: true },
        { route: "chat", stream: false },
        { route: "chat", stream: true },
      ] as const;
      const failureCases = [
        {
          name: "eof",
          terminalType: "eof",
          body: () => sseResponse(['data: {"type":"response.output_text.delta","delta":"partial"}\n\n']).body,
        },
        {
          name: "malformed",
          terminalType: "error",
          body: () => sseResponse(["data: not-json\n\n"]).body,
        },
        {
          name: "read-error",
          terminalType: "error",
          body: () =>
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(new Error("provider socket reset"));
              },
            }),
        },
      ] as const;

      for (const routeCase of routeCases) {
        for (const failureCase of failureCases) {
          const suffix = `${routeCase.route}-${routeCase.stream ? "stream" : "buffered"}-${failureCase.name}`;
          const keyId = `fallback-stream-failure-${suffix}`;
          const requestId = `request-${keyId}`;
          seedPaidFallbackKey(keyId);
          await withFetchMock(
            (url) => {
              if (url === "https://api.openlux.ai/v1/responses") {
                return new Response(failureCase.body(), {
                  status: 200,
                  headers: {
                    "Content-Type": "text/event-stream",
                    "X-Api-Request-Id": `provider-${suffix}`,
                  },
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
              const responseText = await response.text();
              const expectedStatus = routeCase.stream && failureCase.name === "eof" ? 200 : 502;
              assert.equal(response.status, expectedStatus, suffix);
              if (routeCase.stream) {
                assert.match(responseText, routeCase.route === "responses" ? /server_error/ : /upstream_stream_error/, suffix);
                if (routeCase.route === "chat" && failureCase.name === "eof") {
                  assert.match(responseText, /"error":\s*\{/, suffix);
                  assert.doesNotMatch(responseText, /\[DONE\]/, suffix);
                }
              }
              assert.equal(getResponseTelemetry(response)?.streamTerminalType, failureCase.terminalType, suffix);
              const stored = await waitForPaidFallbackTerminal(keyId, requestId, "ambiguous");
              assert.equal(stored.billing_state, "pending", suffix);
            }
          );
        }
      }
    });

    await step("downstream cancellation marks dispatched streaming requests cancelled", async () => {
      for (const route of ["responses", "chat"] as const) {
        const keyId = `fallback-downstream-cancel-${route}`;
        const requestId = `request-${keyId}`;
        seedPaidFallbackKey(keyId);
        let upstreamCancelCount = 0;
        await withFetchMock(
          (url) => {
            if (url === "https://api.openlux.ai/v1/responses") {
              const body = new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    TEXT_ENCODER.encode(
                      'data: {"type":"response.created","response":{"id":"resp_cancel","created_at":1}}\n\n' +
                        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
                    )
                  );
                },
                cancel() {
                  upstreamCancelCount += 1;
                },
              });
              return new Response(body, {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "X-Api-Request-Id": `provider-cancel-${route}`,
                },
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
              route === "responses"
                ? await handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }),
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
                        stream: true,
                      }),
                    }),
                    context
                  );
            assert.equal(response.status, 200, route);
            assert.ok(response.body);
            const reader = response.body.getReader();
            const first = await reader.read();
            assert.equal(first.done, false, route);
            await reader.cancel("client disconnected");
            const stored = await waitForPaidFallbackTerminal(keyId, requestId, "cancelled");
            assert.equal(stored.dispatch_state, "dispatched", route);
            assert.equal(stored.billing_state, "pending", route);
            assert.equal(getResponseTelemetry(response)?.streamTerminalType, "cancelled", route);
          }
        );
        assert.equal(upstreamCancelCount, 1, route);
      }
    });

    await step("buffered post-header cancellation returns the OpenAI-shaped 499 contract", async () => {
      for (const route of ["responses", "chat"] as const) {
        const keyId = `fallback-buffered-cancel-${route}`;
        const requestId = `request-${keyId}`;
        seedPaidFallbackKey(keyId);
        const controller = new AbortController();
        const secondPull = new Deferred<void>();
        let emittedSemantic = false;
        const blockedPull = { resolve: (): void => {} };
        const response = await withFetchMock(
          (url) => {
            if (url === "https://api.openlux.ai/v1/responses") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  pull(streamController) {
                    if (!emittedSemantic) {
                      emittedSemantic = true;
                      streamController.enqueue(TEXT_ENCODER.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
                      return;
                    }
                    secondPull.resolve();
                    return captureResolve(blockedPull);
                  },
                  cancel() {
                    blockedPull.resolve();
                  },
                }),
                {
                  status: 200,
                  headers: {
                    "Content-Type": "text/event-stream",
                    "X-Request-Id": `provider-buffered-cancel-${route}`,
                  },
                }
              );
            }
            return authoritativeCodexQuotaResponse();
          },
          async () => {
            const pending =
              route === "responses"
                ? handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
                      signal: controller.signal,
                    }),
                    { keyId, kernelRepo: null, kernelOrg: null, requestId, startedAtMs: Date.now() }
                  )
                : handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        messages: [{ role: "user", content: "ping" }],
                      }),
                      signal: controller.signal,
                    }),
                    { keyId, kernelRepo: null, kernelOrg: null, requestId, startedAtMs: Date.now() }
                  );
            await secondPull.promise;
            controller.abort(new DOMException("client disconnected", "AbortError"));
            return await pending;
          }
        );
        assert.equal(response.status, 499, route);
        assert.deepEqual(
          await response.json(),
          {
            error: {
              message: "Request was cancelled.",
              type: "server_error",
              code: "request_cancelled",
              param: null,
            },
          },
          route
        );
        assert.equal(getResponseTelemetry(response)?.streamTerminalType, "cancelled", route);
        const stored = await waitForPaidFallbackTerminal(keyId, requestId, "cancelled");
        assert.equal(stored.dispatch_state, "dispatched", route);
      }
    });

    await step("validated terminals survive later client-body cancellation", async () => {
      for (const provider of ["chatgpt_codex", "metered"] as const) {
        for (const route of ["responses", "chat"] as const) {
          for (const terminalType of ["response.completed", "response.incomplete"] as const) {
            await runValidatedTerminalCancellationCase({ provider, route, terminalType });
          }
        }
      }
    });

    await step("validated Codex terminals resolve each half-open probe once", async () => {
      const authPoolKey = keyToString(["ubq_ai", "codex_auth"]);
      const routingKey = keyToString(CODEX_ACCOUNT_ROUTING_KV_KEY);
      const previousAuthPool = kvStore.get(authPoolKey);
      const previousRouting = kvStore.get(routingKey);
      try {
        for (const route of ["responses", "chat"] as const) {
          for (const terminalType of ["response.completed", "response.incomplete"] as const) {
            const suffix = `${route}-${terminalType.replace(".", "-")}`;
            const accountId = `acct-terminal-probe-${suffix}`;
            const providerRequestId = `provider-terminal-probe-${suffix}`;
            const healthKey = ["uos_ai", "provider_health", "v1", "codex", accountId, "current"] as const;
            const terminalState = terminalType === "response.completed" ? "completed" : "incomplete";
            const observedTerminalUsages: { completed: boolean; inputTokens: number | null }[] = [];
            const atomicCommits: OpenAiAtomicOp[][] = [];
            await withFetchMock(
              () =>
                new Response(
                  sseResponse([
                    `data: ${JSON.stringify({
                      type: terminalType,
                      response: {
                        id: `resp_terminal_probe_${suffix}`,
                        status: terminalState,
                        model: DEFAULT_TEST_MODEL,
                        output:
                          terminalType === "response.completed"
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
                    })}\n\n`,
                  ]).body,
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "text/event-stream",
                      "X-Request-Id": providerRequestId,
                    },
                  }
                ),
              async () => {
                const existingPool = kvStore.get(authPoolKey) as CodexAuthPoolState;
                const account = existingPool.accounts[0];
                const pool = {
                  ...existingPool,
                  accounts: existingPool.accounts.map((entry, index) => (index === 0 ? { ...entry, account_id: accountId } : entry)),
                  updated_at_ms: Date.now(),
                };
                kvStore.set(authPoolKey, pool);
                resetCodexAuthCacheForTest();
                const credentialVersion = await sha256Hex(`${accountId}\u0000${account.access_token}\u0000${account.refresh_token}`);
                const accountIdHash = await sha256Hex(`uos_ai\u0000codex_routing_account\u0000${accountId}`);
                kvStore.set(routingKey, {
                  v: 2,
                  updated_at_ms: Date.now(),
                  banked_reset_legacy_identity_unresolved: false,
                  slots: [
                    {
                      account_id_hash: accountIdHash,
                      credential_version: credentialVersion,
                      quota_blocked_until_ms: Date.now() - 1,
                      quota_block_source: "header_retry_after",
                      quota_blocked_classes: [],
                      quota_blocks_by_class: {},
                      invalid_credential_version: null,
                      primary_used_percent: null,
                      secondary_used_percent: null,
                      quota_signal_observed_at_ms: null,
                      capacity_observed_at_ms: null,
                      upstream_timeout_blocked_until_ms: null,
                      observed_reset_at_ms: Date.now() - 1,
                      observed_reset_at_is_stable: false,
                      banked_reset_generation_ambiguous: false,
                      banked_reset_recovery_probe_pending: false,
                      generation: 1,
                      probe_lease: null,
                    },
                  ],
                });
                resetCodexAccountRoutingForTest();
                resetProviderHealthThrottleForTest();
                const previousAtomicObserver = atomicCommitObservation.observer;
                atomicCommitObservation.observer = (operations) => atomicCommits.push([...operations]);
                try {
                  const context = {
                    keyId: null,
                    kernelRepo: null,
                    kernelOrg: null,
                    requestId: `request-terminal-probe-${suffix}`,
                    startedAtMs: Date.now(),
                    onTerminalUsage: (usage: { inputTokens: number | null } | null, completed: boolean) => {
                      observedTerminalUsages.push({ completed, inputTokens: usage?.inputTokens ?? null });
                    },
                  };
                  const response =
                    route === "responses"
                      ? await handleResponses(
                          new Request("https://ai.ubq.fi/v1/responses", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }),
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
                              stream: true,
                            }),
                          }),
                          context
                        );
                  assert.equal(response.status, 200, suffix);
                  assert.ok(response.body, suffix);
                  await response.body.cancel("client cancelled after upstream terminal");

                  const routingWrites = (): OpenAiAtomicOp[] => atomicWritesForKey(atomicCommits, CODEX_ACCOUNT_ROUTING_KV_KEY);
                  const isProbeClaim = (operation: OpenAiAtomicOp): boolean => {
                    const slot = (operation.value as { slots?: { probe_lease?: unknown }[] } | undefined)?.slots?.[0];
                    return slot?.probe_lease !== null && slot?.probe_lease !== undefined;
                  };
                  const isProbeClear = (operation: OpenAiAtomicOp): boolean => {
                    const slot = (operation.value as { slots?: { probe_lease?: unknown }[] } | undefined)?.slots?.[0];
                    return slot?.probe_lease === null;
                  };
                  const expectedHealthEvent = terminalType === "response.completed" ? "success" : null;
                  for (let attempt = 0; attempt < 100; attempt += 1) {
                    const claims = routingWrites().filter(isProbeClaim);
                    const clears = routingWrites().filter(isProbeClear);
                    const healthWrites = atomicWritesForKey(atomicCommits, healthKey).filter(
                      (operation) =>
                        typeof operation.value === "object" &&
                        operation.value !== null &&
                        (operation.value as { event?: unknown }).event === expectedHealthEvent
                    );
                    if (claims.length === 1 && clears.length === 1 && (expectedHealthEvent === null || healthWrites.length === 1)) break;
                    await new Promise<void>((resolve) => setTimeout(resolve, 1));
                  }

                  const telemetry = getResponseTelemetry(response);
                  assert.equal(telemetry?.streamTerminalType, terminalType, suffix);
                  assert.equal(telemetry.completed, terminalType === "response.completed", suffix);
                  assert.deepEqual(
                    observedTerminalUsages,
                    [
                      {
                        completed: terminalType === "response.completed",
                        inputTokens: 1,
                      },
                    ],
                    suffix
                  );
                  assert.equal(routingWrites().filter(isProbeClaim).length, 1, `${suffix} probe claim`);
                  assert.equal(routingWrites().filter(isProbeClear).length, 1, `${suffix} probe clear`);

                  const terminalHealthWrites = atomicWritesForKey(atomicCommits, healthKey).filter(
                    (operation) =>
                      typeof operation.value === "object" &&
                      operation.value !== null &&
                      ((operation.value as { event?: unknown }).event === "success" || (operation.value as { event?: unknown }).event === "upstream_error")
                  );
                  if (terminalType === "response.completed") {
                    assert.equal(terminalHealthWrites.length, 1, `${suffix} health transition`);
                    const health = terminalHealthWrites[0]?.value as { event?: unknown; status?: unknown; provider_request_id?: unknown } | undefined;
                    assert.equal(health?.event, "success", suffix);
                    assert.equal(health.status, 200, suffix);
                    assert.equal(health.provider_request_id, providerRequestId, suffix);
                  } else {
                    assert.equal(terminalHealthWrites.length, 0, `${suffix} has no false health failure`);
                  }
                } finally {
                  atomicCommitObservation.observer = previousAtomicObserver;
                  resetProviderHealthThrottleForTest();
                }
              }
            );
          }
        }
      } finally {
        if (previousAuthPool === undefined) kvStore.delete(authPoolKey);
        else kvStore.set(authPoolKey, previousAuthPool);
        if (previousRouting === undefined) kvStore.delete(routingKey);
        else kvStore.set(routingKey, previousRouting);
        resetCodexAuthCacheForTest();
        resetCodexAccountRoutingForTest();
        resetProviderHealthThrottleForTest();
      }
    });

    await step("gateway logs a preflight terminal once after body cancellation", async () => {
      const originalInfo = console.info;
      const logs: unknown[][] = [];
      const providerRequestId = "provider-terminal-log-once";
      console.info = (...args: unknown[]) => logs.push(args);
      try {
        const response = await withFetchMock(
          () =>
            new Response(
              sseResponse([
                `data: ${JSON.stringify({
                  type: "response.completed",
                  response: {
                    id: "resp_terminal_log_once",
                    status: "completed",
                    model: DEFAULT_TEST_MODEL,
                    output: [
                      {
                        id: "msg_terminal_log_once",
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "done" }],
                      },
                    ],
                    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
                  },
                })}\n\n`,
              ]).body,
              {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "X-Request-Id": providerRequestId,
                },
              }
            ),
          () =>
            gatewayHandler(
              new Request("http://localhost/v1/responses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }),
              })
            )
        );
        assert.equal(response.status, 200);
        assert.ok(response.body);
        await response.body.cancel("client cancelled after upstream terminal");
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const terminals = logs
            .filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal")
            .map((entry) => JSON.parse(String(entry[1])) as Record<string, unknown>)
            .filter((terminal) => terminal.provider_request_id === providerRequestId);
          if (terminals.length === 1) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        const terminals = logs
          .filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal")
          .map((entry) => JSON.parse(String(entry[1])) as Record<string, unknown>)
          .filter((terminal) => terminal.provider_request_id === providerRequestId);
        const cancelledTerminals = terminals.filter((terminal) => terminal.stream_terminal_type === "cancelled");
        assert.equal(terminals.length, 1);
        assert.equal(cancelledTerminals.length, 0);
        const terminal = terminals[0];
        assert.equal(terminal.status, 200);
        assert.equal(terminal.stream_terminal_type, "response.completed");
        assert.equal(terminal.input_tokens, 3);
        assert.equal(terminal.output_tokens, 2);
        assert.equal(terminal.total_tokens, 5);
      } finally {
        console.info = originalInfo;
      }
    });

    await step("buffered Chat preflight terminals record usage exactly once", async () => {
      for (const terminalType of ["response.completed", "response.incomplete"] as const) {
        const observedTerminalUsages: { completed: boolean; inputTokens: number | null }[] = [];
        const response = await withFetchMock(
          () =>
            new Response(
              sseResponse([
                `data: ${JSON.stringify({
                  type: terminalType,
                  response: {
                    id: `resp-buffered-chat-${terminalType}`,
                    status: terminalType === "response.completed" ? "completed" : "incomplete",
                    model: DEFAULT_TEST_MODEL,
                    output:
                      terminalType === "response.completed"
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
                })}\n\n`,
              ]).body,
              {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
              }
            ),
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
                keyId: null,
                kernelRepo: null,
                kernelOrg: null,
                onTerminalUsage: (usage, completed) => {
                  observedTerminalUsages.push({ completed, inputTokens: usage?.inputTokens ?? null });
                },
              }
            )
        );
        assert.equal(response.status, terminalType === "response.completed" ? 200 : 502, terminalType);
        if (response.body) await response.body.cancel("client cancelled after buffered upstream terminal");
        assert.deepEqual(
          observedTerminalUsages,
          [
            {
              completed: terminalType === "response.completed",
              inputTokens: 1,
            },
          ],
          terminalType
        );
      }
    });

    await step("Chat streaming remains bounded until the downstream client pulls", async () => {
      const keyId = "fallback-chat-backpressure";
      const requestId = `request-${keyId}`;
      seedPaidFallbackKey(keyId);
      const providerChunks = Array.from({ length: 40 }, (_, index) =>
        TEXT_ENCODER.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: String(index) })}\n\n`)
      );
      providerChunks.push(
        TEXT_ENCODER.encode(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              status: "completed",
              model: DEFAULT_TEST_MODEL,
              output: [],
              usage: { input_tokens: 1, output_tokens: 40, total_tokens: 41 },
            },
          })}\n\n`
        )
      );
      let upstreamPullCount = 0;
      let upstreamCancelCount = 0;

      await withFetchMock(
        (url) => {
          if (url === "https://api.openlux.ai/v1/responses") {
            const body = new ReadableStream<Uint8Array>({
              pull(controller) {
                const chunk = providerChunks.at(upstreamPullCount);
                upstreamPullCount += 1;
                if (chunk) controller.enqueue(chunk);
                else controller.close();
              },
              cancel() {
                upstreamCancelCount += 1;
              },
            });
            return new Response(body, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "X-Api-Request-Id": "provider-chat-backpressure",
              },
            });
          }
          return authoritativeCodexQuotaResponse();
        },
        async () => {
          const response = await handleChatCompletions(
            new Request("https://ai.ubq.fi/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: DEFAULT_TEST_MODEL,
                messages: [{ role: "user", content: "ping" }],
                stream: true,
              }),
            }),
            {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              requestId,
              startedAtMs: Date.now(),
            }
          );
          await Promise.resolve();
          await Promise.resolve();
          assert.ok(upstreamPullCount <= 3, `expected bounded upstream reads before downstream demand, received ${upstreamPullCount}`);
          assert.ok(response.body);
          const reader = response.body.getReader();
          const first = await reader.read();
          assert.equal(first.done, false);
          await reader.cancel("stop after first translated chunk");
          await waitForPaidFallbackTerminal(keyId, requestId, "cancelled");
        }
      );
      assert.equal(upstreamCancelCount, 1);
    });

    await step("Metered HTTP errors use OpenAI envelopes without changing routing", async (step) => {
      const cases = [
        {
          name: "responses preserves an existing error envelope and 429",
          route: "responses",
          status: 429,
          statusText: "Metered Rate Limited",
          body: JSON.stringify({
            error: {
              message: "Metered is rate limited.",
              type: "rate_limit_error",
              code: "provider_rate_limit",
              param: null,
            },
            opaque: { drop: true },
          }),
          retryAfter: "17",
          expectedError: {
            message: "Metered is rate limited.",
            type: "rate_limit_error",
            code: "provider_rate_limit",
            param: null,
          },
        },
        {
          name: "chat completions parses a provider-root message and preserves 502",
          route: "chat.completions",
          status: 502,
          statusText: "Metered Bad Gateway",
          body: JSON.stringify({
            message: "Metered could not reach its model backend.",
            type: "server_error",
            code: "provider_unavailable",
            opaque: { drop: true },
          }),
          retryAfter: null,
          expectedError: {
            message: "Metered could not reach its model backend.",
            type: "server_error",
            code: "provider_unavailable",
          },
        },
        {
          name: "chat completions converts plain text and preserves 401",
          route: "chat.completions",
          status: 401,
          statusText: "Metered Unauthorized",
          body: "Metered rejected the configured credential.",
          retryAfter: null,
          expectedError: {
            message: "Metered rejected the configured credential.",
            type: "invalid_request_error",
            code: "upstream_error",
          },
        },
        {
          name: "responses classifies an untyped upstream 429 as rate limited",
          route: "responses",
          status: 429,
          statusText: "Metered Rate Limited",
          body: JSON.stringify({ detail: "Metered has no capacity." }),
          retryAfter: "3",
          expectedError: {
            message: "Metered has no capacity.",
            type: "rate_limit_error",
            code: "upstream_error",
          },
        },
      ] as const;

      for (const [index, testCase] of cases.entries()) {
        await step(testCase.name, async () => {
          const keyId = `fallback-metered-normalized-${index}`;
          const requestId = `request-fallback-metered-normalized-${index}`;
          seedPaidFallbackKey(keyId);
          let codexCalls = 0;
          let meteredCalls = 0;
          const response = await withFetchMock(
            (url) => {
              if (url === "https://api.openlux.ai/v1/responses") {
                meteredCalls += 1;
                const headers = new Headers({
                  "Content-Type": "application/problem+json",
                  "X-Metered-Diagnostic": "drop-me",
                });
                if (testCase.retryAfter) headers.set("Retry-After", testCase.retryAfter);
                return new Response(testCase.body, {
                  status: testCase.status,
                  statusText: testCase.statusText,
                  headers,
                });
              }
              codexCalls += 1;
              return authoritativeCodexQuotaResponse();
            },
            () =>
              testCase.route === "chat.completions"
                ? handleChatCompletions(
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
                      requestId,
                      startedAtMs: Date.now(),
                    }
                  )
                : handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
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

          assert.equal(response.status, testCase.status);
          assert.equal(response.statusText, "");
          assert.equal(response.headers.get("Content-Type"), "application/json");
          assert.equal(response.headers.get("x-uos-upstream"), "metered");
          assert.equal(response.headers.get("Retry-After"), testCase.retryAfter);
          assert.equal(response.headers.get("X-Metered-Diagnostic"), null);
          assert.deepEqual(await response.json(), { error: testCase.expectedError });
          assert.equal(codexCalls, 1);
          assert.equal(meteredCalls, 1);
          const failed = await waitForPaidFallbackTerminal(keyId, requestId, "failed");
          assert.equal(failed.terminal_state, "failed");
        });
      }
    });

    await step("a ledger write failure after Metered accepts preserves the usable response", async () => {
      const keyId = "fallback-ledger-write-failure";
      const requestId = "request-fallback-ledger-write-failure";
      const providerRequestId = "metered-ledger-write-failure";
      seedPaidFallbackKey(keyId);
      setAtomicCommitFailure((ops) =>
        ops.some((op) => {
          const value = op.value as { provider_request_id?: unknown } | undefined;
          return (
            op.type === "set" &&
            op.key[0] === "uos_ai" &&
            op.key[1] === "paid_fallback" &&
            op.key[2] === "ledger" &&
            value?.provider_request_id === providerRequestId
          );
        })
          ? new Error("injected paid fallback ledger failure")
          : null
      );
      try {
        const response = await withFetchMock(
          (url) => {
            if (url === "https://api.openlux.ai/v1/responses") {
              return new Response(sseResponse(baseSseChunks()).body, {
                status: 200,
                headers: {
                  "Content-Type": "text/event-stream",
                  "X-Oneapi-Request-Id": providerRequestId,
                },
              });
            }
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
                requestId,
                startedAtMs: Date.now(),
              }
            )
        );
        assert.equal(response.status, 200);
        assert.match(await response.text(), /pong/);
        assert.equal(getResponseTelemetry(response)?.completed, true);
      } finally {
        setAtomicCommitFailure(null);
      }
    });

    await step("reconciliation failures preserve chat and Responses results across stream modes", async () => {
      const cases = [
        { route: "responses", stream: false },
        { route: "responses", stream: true },
        { route: "chat", stream: false },
        { route: "chat", stream: true },
      ] as const;
      setExposePaidFallbackLedgerEntries(true);
      setAtomicCommitFailure((ops) =>
        ops.some((op) => {
          const value = op.value as { billing_status?: unknown } | undefined;
          return (
            op.type === "set" && op.key[0] === "uos_ai" && op.key[1] === "paid_fallback" && op.key[2] === "ledger" && value?.billing_status === "reconciled"
          );
        })
          ? new Error("injected paid fallback reconciliation failure")
          : null
      );
      try {
        for (const testCase of cases) {
          const suffix = `${testCase.route}-${testCase.stream ? "stream" : "nonstream"}`;
          const keyId = `fallback-reconcile-${suffix}`;
          const requestId = `request-fallback-reconcile-${suffix}`;
          const providerRequestId = `metered-reconcile-${suffix}`;
          seedPaidFallbackKey(keyId);
          const result = await withFetchMock(
            (url) => {
              if (url === "https://api.openlux.ai/v1/responses") {
                return new Response(sseResponse(baseSseChunks()).body, {
                  status: 200,
                  headers: {
                    "Content-Type": "text/event-stream",
                    "X-Oneapi-Request-Id": providerRequestId,
                  },
                });
              }
              if (url === "https://api.openlux.ai/api/log/token") {
                return new Response(
                  JSON.stringify({
                    success: true,
                    data: [
                      {
                        request_id: providerRequestId,
                        quota: 100,
                        prompt_tokens: 1,
                        completion_tokens: 1,
                        model_name: DEFAULT_TEST_MODEL,
                        created_at: Math.floor(Date.now() / 1000),
                      },
                    ],
                  }),
                  { status: 200, headers: { "Content-Type": "application/json" } }
                );
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
              const response = await (testCase.route === "responses"
                ? handleResponses(
                    new Request("https://ai.ubq.fi/v1/responses", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        input: "ping",
                        stream: testCase.stream,
                      }),
                    }),
                    context
                  )
                : handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        messages: [{ role: "user", content: "ping" }],
                        stream: testCase.stream,
                      }),
                    }),
                    context
                  ));
              const completedBeforeConsumption = getResponseTelemetry(response)?.completed;
              const text = await response.text();
              return { response, text, completedBeforeConsumption };
            }
          );
          const { response, text, completedBeforeConsumption } = result;
          assert.equal(response.status, 200, suffix);
          if (testCase.stream) assert.equal(completedBeforeConsumption, false, suffix);
          assert.match(text, /pong/, suffix);
          assert.equal(getResponseTelemetry(response)?.completed, true, suffix);
        }
      } finally {
        setAtomicCommitFailure(null);
        setExposePaidFallbackLedgerEntries(false);
      }
    });

    await step("reconciliation failure does not replace the original Metered error", async () => {
      const keyId = "fallback-error-reconcile-failure";
      const requestId = "request-fallback-error-reconcile-failure";
      const providerRequestId = "metered-error-reconcile-failure";
      seedPaidFallbackKey(keyId);
      setExposePaidFallbackLedgerEntries(true);
      setAtomicCommitFailure((ops) =>
        ops.some((op) => (op.value as { billing_status?: unknown } | undefined)?.billing_status === "reconciled")
          ? new Error("injected upstream error reconciliation failure")
          : null
      );
      try {
        const response = await withFetchMock(
          (url) => {
            if (url === "https://api.openlux.ai/v1/responses") {
              return new Response(JSON.stringify({ error: { message: "Metered original error" } }), {
                status: 503,
                headers: {
                  "Content-Type": "application/json",
                  "X-Oneapi-Request-Id": providerRequestId,
                },
              });
            }
            if (url === "https://api.openlux.ai/api/log/token") {
              return new Response(
                JSON.stringify({
                  success: true,
                  data: [
                    {
                      request_id: providerRequestId,
                      quota: 100,
                      prompt_tokens: 1,
                      completion_tokens: 0,
                      model_name: DEFAULT_TEST_MODEL,
                      created_at: Math.floor(Date.now() / 1000),
                    },
                  ],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              );
            }
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
                requestId,
                startedAtMs: Date.now(),
              }
            )
        );
        assert.equal(response.status, 503);
        const payload = (await response.json()) as { error?: { message?: string } };
        assert.equal(payload.error?.message, "Metered original error");
      } finally {
        setAtomicCommitFailure(null);
        setExposePaidFallbackLedgerEntries(false);
      }
    });
  } finally {
    setAtomicCommitFailure(null);
    setExposePaidFallbackLedgerEntries(false);
    kvStore.delete(keyToString(CODEX_ACCOUNT_ROUTING_KV_KEY));
    resetCodexAccountRoutingForTest();
    resetCodexAuthCacheForTest();
    if (originalApiKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalApiKey;
  }
};
