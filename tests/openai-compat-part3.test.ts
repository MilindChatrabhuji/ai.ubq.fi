import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 3 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  type CodexAuthPoolState,
  DEBUG_ROUTING_KEY,
  DEFAULT_TEST_MODEL,
  Deferred,
  type ReasoningProgressState,
  TEXT_ENCODER,
  type VoidGate,
  authoritativeCodexQuotaResponse,
  baseSseChunks,
  captureResolve,
  clearProviderHealthKeysFor,
  fetchMeteredModels,
  getResponseTelemetry,
  getStoredPaidFallbackRequest,
  handleChatCompletions,
  handleResponses,
  keyToString,
  kvStore,
  parseResponsesSseValues,
  reasoningProgressUpstreamResponse,
  recordCodexProviderHealth,
  rejectOnAbort,
  resetCodexAccountRoutingForTest,
  resetCodexAuthCacheForTest,
  resetDebugRoutingCacheForTest,
  resetMeteredModelsCacheForTest,
  resetProviderHealthThrottleForTest,
  resetSurplusModelsCacheForTest,
  responsesRequest,
  seedPaidFallbackKey,
  seedPaidReasoningProvider,
  selectCodexRoutingAccounts,
  setStreamFirstEventDeadlineMsForTest,
  sha256Hex,
  sseResponse,
  waitForPaidFallbackTerminal,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";

test("openai: request abort after Codex headers releases its half-open probe neutrally", async () => {
  const accountId = "acct-cancelled-probe-fixture";
  const authPoolKey = keyToString(["ubq_ai", "codex_auth"]);
  const routingKey = keyToString(CODEX_ACCOUNT_ROUTING_KV_KEY);
  const healthKey = keyToString(["uos_ai", "provider_health", "v1", "codex", accountId, "current"]);
  const upstreamErrorHealthKey = keyToString(["uos_ai", "provider_health", "v1", "codex", accountId, "upstream_error"]);
  const previousAuthPool = kvStore.get(authPoolKey);
  const previousRouting = kvStore.get(routingKey);
  const awaitingSemantic = new Deferred<void>();
  let releaseBlockedPull = (): void => {};
  let upstreamCancellations = 0;
  let codexCalls = 0;
  const waitForLeaseRelease = async (label: string): Promise<void> => {
    const deadline = performance.now() + 1_000;
    for (;;) {
      const routing = kvStore.get(routingKey) as { slots?: { probe_lease?: unknown }[] } | undefined;
      if (routing?.slots?.[0]?.probe_lease === null) return;
      if (performance.now() >= deadline) assert.fail(`${label} did not release its half-open lease`);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  try {
    await withFetchMock(
      () => {
        codexCalls += 1;
        if (codexCalls !== 1) {
          return sseResponse([
            `data: ${JSON.stringify({
              type: "response.incomplete",
              response: { id: "resp_cancelled_probe_retry", status: "incomplete", output: [] },
            })}\n\n`,
          ]);
        }
        let emittedCreated = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!emittedCreated) {
                emittedCreated = true;
                controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_cancelled_probe" } })}\n\n`));
                return;
              }
              awaitingSemantic.resolve();
              return new Promise<void>((resolve) => {
                releaseBlockedPull = resolve;
              });
            },
            cancel() {
              upstreamCancellations += 1;
              releaseBlockedPull();
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "X-Request-Id": "cancelled-probe-request" },
          }
        );
      },
      async () => {
        const existingPool = kvStore.get(authPoolKey) as {
          accounts: {
            access_token: string;
            refresh_token: string;
            account_id: string;
          }[];
          updated_at_ms: number;
        };
        const pool = {
          ...existingPool,
          accounts: existingPool.accounts.map((account, index) => (index === 0 ? { ...account, account_id: accountId } : account)),
          updated_at_ms: Date.now(),
        };
        kvStore.set(authPoolKey, pool);
        resetCodexAuthCacheForTest();
        resetProviderHealthThrottleForTest();
        clearProviderHealthKeysFor(accountId);
        const account = pool.accounts[0];
        const credentialVersion = await sha256Hex(`${account.account_id}\u0000${account.access_token}\u0000${account.refresh_token}`);
        kvStore.set(routingKey, {
          v: 2,
          updated_at_ms: Date.now(),
          slots: [
            {
              credential_version: credentialVersion,
              quota_blocked_until_ms: Date.now() - 1,
              quota_block_source: "header_retry_after",
              invalid_credential_version: null,
              primary_used_percent: null,
              secondary_used_percent: null,
              observed_reset_at_ms: Date.now() - 1,
              generation: 1,
              probe_lease: null,
            },
          ],
        });
        resetCodexAccountRoutingForTest();

        const abortController = new AbortController();
        const cancelledResponse = handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "cancel half-open probe", stream: true }),
            signal: abortController.signal,
          })
        );
        await awaitingSemantic.promise;
        const claimed = kvStore.get(routingKey) as { slots?: { probe_lease?: unknown }[] } | undefined;
        assert.ok(claimed?.slots?.[0]?.probe_lease, "the in-flight 2xx response must own the half-open lease");

        abortController.abort(new DOMException("client cancelled", "AbortError"));
        const cancelled = await cancelledResponse;
        assert.equal(cancelled.status, 499);
        await cancelled.text();
        assert.equal(upstreamCancellations, 1);

        await recordCodexProviderHealth(accountId, "reachable", 299, Date.now, "cancel-barrier");
        await waitForLeaseRelease("the cancelled response");
        assert.equal(kvStore.get(upstreamErrorHealthKey), undefined);
        const cancellationHealth = kvStore.get(healthKey) as { event?: unknown; provider_request_id?: unknown } | undefined;
        assert.equal(cancellationHealth?.event, "reachable");
        assert.equal(cancellationHealth.provider_request_id, "cancel-barrier");

        const retry = await handleResponses(
          new Request("https://ai.ubq.fi/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "retry after cancellation" }),
          })
        );
        assert.equal(retry.status, 200);
        await retry.text();
        assert.equal(codexCalls, 2);
        await waitForLeaseRelease("the neutral retry");
        await recordCodexProviderHealth(accountId, "reachable", 299, Date.now, "retry-barrier");
        assert.equal(kvStore.get(upstreamErrorHealthKey), undefined, "neutral cancellation and incompletion must not write upstream-error health");
      }
    );
  } finally {
    if (previousAuthPool === undefined) kvStore.delete(authPoolKey);
    else kvStore.set(authPoolKey, previousAuthPool);
    if (previousRouting === undefined) kvStore.delete(routingKey);
    else kvStore.set(routingKey, previousRouting);
    clearProviderHealthKeysFor(accountId);
    resetProviderHealthThrottleForTest();
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
  }
});

test("openai: buffered inference deadline after Codex headers records an upstream failure", async () => {
  const accountId = "acct-buffered-deadline-fixture";
  const authPoolKey = keyToString(["ubq_ai", "codex_auth"]);
  const routingKey = keyToString(CODEX_ACCOUNT_ROUTING_KV_KEY);
  const healthKey = keyToString(["uos_ai", "provider_health", "v1", "codex", accountId, "current"]);
  const previousAuthPool = kvStore.get(authPoolKey);
  const previousRouting = kvStore.get(routingKey);
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const inferenceDeadline = new AbortController();
  const awaitingSemantic = new Deferred<void>();
  let releaseBlockedPull = (): void => {};
  let upstreamCancellations = 0;

  try {
    (AbortSignal as unknown as { timeout: (milliseconds: number) => AbortSignal }).timeout = () => inferenceDeadline.signal;
    await withFetchMock(
      () => {
        let emittedCreated = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!emittedCreated) {
                emittedCreated = true;
                controller.enqueue(
                  TEXT_ENCODER.encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_buffered_deadline" } })}\n\n`)
                );
                return;
              }
              awaitingSemantic.resolve();
              return new Promise<void>((resolve) => {
                releaseBlockedPull = resolve;
              });
            },
            cancel() {
              upstreamCancellations += 1;
              releaseBlockedPull();
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "X-Request-Id": "buffered-deadline-request" },
          }
        );
      },
      async () => {
        const existingPool = kvStore.get(authPoolKey) as CodexAuthPoolState;
        kvStore.set(authPoolKey, {
          ...existingPool,
          accounts: existingPool.accounts.map((account, index) => (index === 0 ? { ...account, account_id: accountId } : account)),
          updated_at_ms: Date.now(),
        });
        kvStore.delete(routingKey);
        clearProviderHealthKeysFor(accountId);
        resetCodexAuthCacheForTest();
        resetCodexAccountRoutingForTest();
        resetProviderHealthThrottleForTest();

        const downstreamRequest = new Request("https://ai.ubq.fi/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "buffered deadline" }),
        });
        const pending = handleResponses(downstreamRequest);
        await awaitingSemantic.promise;
        assert.equal(downstreamRequest.signal.aborted, false);

        inferenceDeadline.abort(new DOMException("buffered inference timed out", "TimeoutError"));
        const response = await pending;
        assert.equal(response.status, 504);
        assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
        await response.text();
        assert.equal(upstreamCancellations, 1);

        const healthDeadline = performance.now() + 1_000;
        for (;;) {
          const health = kvStore.get(healthKey) as { event?: unknown; status?: unknown; provider_request_id?: unknown } | undefined;
          if (health?.event === "upstream_error") {
            assert.equal(health.status, 200);
            assert.equal(health.provider_request_id, "buffered-deadline-request");
            break;
          }
          if (performance.now() >= healthDeadline) {
            assert.fail("the buffered deadline was not recorded as an upstream failure");
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    );
  } finally {
    (AbortSignal as unknown as { timeout: (milliseconds: number) => AbortSignal }).timeout = originalTimeout;
    if (previousAuthPool === undefined) kvStore.delete(authPoolKey);
    else kvStore.set(authPoolKey, previousAuthPool);
    if (previousRouting === undefined) kvStore.delete(routingKey);
    else kvStore.set(routingKey, previousRouting);
    clearProviderHealthKeysFor(accountId);
    resetProviderHealthThrottleForTest();
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
  }
});

test("openai: gateway first-event deadlines return 504 on both streaming routes", async () => {
  setStreamFirstEventDeadlineMsForTest(10);
  try {
    for (const route of ["responses", "chat"] as const) {
      await withFetchMock(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                // Response headers arrive, but the upstream never emits an SSE event.
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }
          ),
        async () => {
          const response =
            route === "responses"
              ? await handleResponses(
                  new Request("https://ai.ubq.fi/v1/responses", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }),
                  })
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
                  })
                );
          const payload = (await response.json()) as { error?: { type?: unknown; code?: unknown } };
          assert.equal(response.status, 504, route);
          assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex", route);
          assert.equal(payload.error?.type, "server_error", route);
          assert.equal(payload.error.code, "gateway_timeout", route);
          assert.equal(getResponseTelemetry(response)?.streamTerminalType, "deadline", route);
        }
      );
    }
  } finally {
    setStreamFirstEventDeadlineMsForTest(null);
  }
});

test("openai: reasoning progress releases streaming headers before semantic output", async () =>
  runSequence(async (step) => {
    const originalMeteredApiKey = process.env.METERED_API_KEY;
    const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
    const debugKey = keyToString(DEBUG_ROUTING_KEY);
    const previousDebugRouting = kvStore.get(debugKey);
    const deadlineMs = 300;
    const routeCases = [
      { route: "responses", keyId: "reasoning-progress-responses" },
      { route: "chat", keyId: "reasoning-progress-chat" },
    ] as const;

    const progressingReasoningResponse = (
      responseId: string,
      observation: { reasoningEmitted: boolean; semanticEmitted: boolean }
    ): { response: Response; releaseSemantic: () => void } => {
      let stopped = false;
      const semanticGate: VoidGate = Promise.withResolvers();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enqueue = (value: Record<string, unknown>): void => {
            if (stopped) return;
            const type = typeof value.type === "string" ? value.type : "";
            if (type.startsWith("response.reasoning_")) observation.reasoningEmitted = true;
            if (type === "response.output_text.delta") observation.semanticEmitted = true;
            controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(value)}\n\n`));
          };

          enqueue({
            type: "response.created",
            response: { id: responseId, object: "response", status: "in_progress", output: [] },
          });
          enqueue({
            type: "response.reasoning_summary_text.delta",
            response_id: responseId,
            item_id: `reasoning_${responseId}`,
            output_index: 0,
            summary_index: 0,
            delta: "hidden summary progress",
          });
          enqueue({
            type: "response.reasoning_text.delta",
            response_id: responseId,
            item_id: `reasoning_${responseId}`,
            output_index: 0,
            content_index: 0,
            delta: "hidden reasoning progress",
          });

          await semanticGate.promise;
          if (stopped) return;
          enqueue({
            type: "response.output_text.delta",
            response_id: responseId,
            item_id: `message_${responseId}`,
            output_index: 0,
            content_index: 0,
            delta: "progress complete",
          });
          enqueue({
            type: "response.completed",
            response: {
              id: responseId,
              object: "response",
              status: "completed",
              model: DEFAULT_TEST_MODEL,
              output: [
                {
                  id: `message_${responseId}`,
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [{ type: "output_text", text: "progress complete", annotations: [] }],
                },
              ],
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
          });
          stopped = true;
          controller.close();
        },
        cancel() {
          stopped = true;
          semanticGate.resolve();
        },
      });
      return {
        response: new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
        releaseSemantic: semanticGate.resolve,
      };
    };

    try {
      process.env.METERED_API_KEY = "metered-test-key";
      Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
      resetMeteredModelsCacheForTest();
      resetSurplusModelsCacheForTest();
      await fetchMeteredModels({
        force: true,
        fetcher: () =>
          Promise.resolve(
            Response.json({
              data: [{ id: DEFAULT_TEST_MODEL, supported_endpoint_types: ["openai", "openai-response"] }],
            })
          ),
      });
      setStreamFirstEventDeadlineMsForTest(deadlineMs);

      for (const routeCase of routeCases) {
        await step(`${routeCase.route} stays alive through hidden reasoning`, async () => {
          const { keyId } = routeCase;
          const requestId = `request-${keyId}`;
          seedPaidFallbackKey(keyId);
          let codexCalls = 0;
          const observation = { reasoningEmitted: false, semanticEmitted: false };
          let releaseSemantic: (() => void) | null = null;
          const response = await withFetchMock(
            (url) => {
              if (url !== "https://chatgpt.com/backend-api/codex/responses") {
                throw new Error(`Reasoning progress must not change providers: ${url}`);
              }
              codexCalls += 1;
              const upstream = progressingReasoningResponse(`resp_${routeCase.route}_reasoning_progress`, observation);
              releaseSemantic = upstream.releaseSemantic;
              return upstream.response;
            },
            () => {
              const usageContext = {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: true,
                requestId,
                startedAtMs: Date.now(),
              };
              return routeCase.route === "responses"
                ? handleResponses(responsesRequest({ stream: true }), usageContext)
                : handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        stream: true,
                        messages: [{ role: "user", content: "work through this carefully" }],
                      }),
                    }),
                    usageContext
                  );
            }
          );

          assert.equal(response.status, 200);
          assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
          assert.equal(observation.reasoningEmitted, true);
          assert.equal(observation.semanticEmitted, false);
          await new Promise((resolve) => setTimeout(resolve, deadlineMs + 50));
          assert.equal(observation.semanticEmitted, false);
          assert.notEqual(releaseSemantic, null);
          const release = releaseSemantic as unknown as () => void;
          release();
          const serialized = await response.text();
          assert.equal(observation.semanticEmitted, true);
          assert.match(serialized, /progress complete/);
          if (routeCase.route === "responses") {
            const values = parseResponsesSseValues(serialized);
            assert.equal(values.filter((event) => event.type === "response.completed").length, 1);
            assert.ok(values.some((event) => event.type === "response.reasoning_summary_text.delta"));
            assert.ok(values.some((event) => event.type === "response.reasoning_text.delta"));
          } else {
            assert.equal(serialized.match(/data: \[DONE\]/g)?.length, 1);
          }
          assert.equal(codexCalls, 1);
          assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);
        });
      }

      kvStore.set(debugKey, {
        scenario: "normal",
        expires_at_ms: null,
        updated_at_ms: Date.now(),
      });
      resetDebugRoutingCacheForTest();
      for (const routeCase of routeCases) {
        await step(`${routeCase.route} keeps Metered alive through hidden reasoning`, async () => {
          const keyId = `paid-${routeCase.keyId}`;
          const requestId = `request-${keyId}`;
          seedPaidFallbackKey(keyId);
          const observation = { reasoningEmitted: false, semanticEmitted: false };
          let releaseSemantic: (() => void) | null = null;
          const response = await withFetchMock(
            (url) => {
              if (url === "https://chatgpt.com/backend-api/codex/responses") {
                return authoritativeCodexQuotaResponse();
              }
              if (url !== "https://api.openlux.ai/v1/responses") {
                throw new Error(`Unexpected provider during Metered reasoning progress: ${url}`);
              }
              const upstream = progressingReasoningResponse(`resp_${routeCase.route}_metered_reasoning`, observation);
              releaseSemantic = upstream.releaseSemantic;
              return upstream.response;
            },
            () => {
              const usageContext = {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: true,
                requestId,
                startedAtMs: Date.now(),
              };
              return routeCase.route === "responses"
                ? handleResponses(responsesRequest({ stream: true }), usageContext)
                : handleChatCompletions(
                    new Request("https://ai.ubq.fi/v1/chat/completions", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        model: DEFAULT_TEST_MODEL,
                        stream: true,
                        messages: [{ role: "user", content: "work through this carefully" }],
                      }),
                    }),
                    usageContext
                  );
            }
          );

          assert.equal(response.status, 200);
          assert.equal(response.headers.get("x-uos-upstream"), "metered");
          assert.equal(observation.reasoningEmitted, true);
          assert.equal(observation.semanticEmitted, false);
          await new Promise((resolve) => setTimeout(resolve, deadlineMs + 50));
          assert.equal(observation.semanticEmitted, false);
          assert.notEqual(releaseSemantic, null);
          const release = releaseSemantic as unknown as () => void;
          release();
          const serialized = await response.text();
          assert.equal(observation.semanticEmitted, true);
          assert.match(serialized, /progress complete/);
          const stored = await waitForPaidFallbackTerminal(keyId, requestId, "completed");
          assert.equal(stored.provider, "metered");
          kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
          kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
        });
      }
    } finally {
      setStreamFirstEventDeadlineMsForTest(null);
      if (previousDebugRouting === undefined) kvStore.delete(debugKey);
      else kvStore.set(debugKey, previousDebugRouting);
      resetDebugRoutingCacheForTest();
      for (const { keyId } of routeCases) {
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", `paid-${keyId}`]));
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-paid-${keyId}`]));
      }
      resetMeteredModelsCacheForTest();
      resetSurplusModelsCacheForTest();
      if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
      else process.env.METERED_API_KEY = originalMeteredApiKey;
      if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
      else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
    }
  }));

/** Seeds the paid-provider model catalog one reasoning-progress case needs. */

/** Mutable state shared with the paid-provider reasoning-progress stream fixture. */

/** Builds the upstream SSE body that emits hidden reasoning before its semantic output. */

test("openai: paid-provider reasoning progress releases only streaming requests", async () =>
  runSequence(async (step) => {
    const originalMeteredApiKey = process.env.METERED_API_KEY;
    const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
    const deadlineMs = 150;

    try {
      setStreamFirstEventDeadlineMsForTest(deadlineMs);
      for (const provider of ["surplus", "metered"] as const) {
        await seedPaidReasoningProvider(provider);

        for (const route of ["responses", "chat"] as const) {
          for (const stream of [true, false]) {
            const delivery = stream ? "streaming" : "buffered";
            await step(`${provider} ${route} ${delivery}`, async () => {
              const keyId = `reasoning-progress-${provider}-${route}-${delivery}`;
              const requestId = `request-${keyId}`;
              seedPaidFallbackKey(keyId);
              const reasoningObserved: VoidGate = Promise.withResolvers();
              const semanticGate: VoidGate = Promise.withResolvers();
              const upstreamState: ReasoningProgressState = { stopped: false, semanticEmitted: false, upstreamCancellations: 0 };
              const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
              const bufferedDeadline = stream ? null : new AbortController();
              if (bufferedDeadline) {
                (AbortSignal as unknown as { timeout: (milliseconds: number) => AbortSignal }).timeout = () => bufferedDeadline.signal;
              }

              const upstreamResponse = (): Response =>
                reasoningProgressUpstreamResponse(upstreamState, { provider, route, delivery, requestId }, reasoningObserved, semanticGate);

              try {
                await withFetchMock(
                  (url) => {
                    if (url === "https://chatgpt.com/backend-api/codex/responses") {
                      return authoritativeCodexQuotaResponse();
                    }
                    if (url === (provider === "surplus" ? "https://api.surplusintelligence.ai/v1/responses" : "https://api.openlux.ai/v1/responses")) {
                      return upstreamResponse();
                    }
                    if (url.startsWith("https://api.openlux.ai/api/log/token?")) {
                      return Response.json({ success: true, data: { items: [] } });
                    }
                    throw new Error(`Unexpected ${provider} reasoning-progress request: ${url}`);
                  },
                  async () => {
                    const usageContext = {
                      keyId,
                      kernelRepo: null,
                      kernelOrg: null,
                      paidFallbackEnabled: true,
                      requestId,
                      startedAtMs: Date.now(),
                    };
                    const pending =
                      route === "responses"
                        ? handleResponses(responsesRequest({ stream }), usageContext)
                        : handleChatCompletions(
                            new Request("https://ai.ubq.fi/v1/chat/completions", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                model: DEFAULT_TEST_MODEL,
                                stream,
                                messages: [{ role: "user", content: "reason before answering" }],
                              }),
                            }),
                            usageContext
                          );

                    await reasoningObserved.promise;
                    assert.equal(upstreamState.semanticEmitted, false);
                    bufferedDeadline?.abort(new DOMException("buffered inference timed out", "TimeoutError"));
                    const response = await pending;
                    assert.equal(response.headers.get("x-uos-upstream"), provider);
                    assert.notEqual(getResponseTelemetry(response)?.semanticOutputObserved, true);

                    if (stream) {
                      assert.equal(response.status, 200);
                      await new Promise((resolve) => setTimeout(resolve, deadlineMs + 50));
                      assert.equal(upstreamState.semanticEmitted, false);
                      semanticGate.resolve();
                      const serialized = await response.text();
                      assert.match(serialized, /paid progress complete/);
                      assert.equal(upstreamState.upstreamCancellations, 0);
                      await waitForPaidFallbackTerminal(keyId, requestId, "completed");
                    } else {
                      assert.equal(response.status, 504);
                      const payload = (await response.json()) as { error?: { code?: unknown } };
                      assert.equal(payload.error?.code, "gateway_timeout");
                      assert.equal(upstreamState.semanticEmitted, false);
                      await waitForPaidFallbackTerminal(keyId, requestId, "ambiguous");
                      // Resolve the fixture gate even when a provider wrapper has
                      // already detached from the timed-out response body.
                      semanticGate.resolve();
                    }
                  }
                );
              } finally {
                (AbortSignal as unknown as { timeout: (milliseconds: number) => AbortSignal }).timeout = originalTimeout;
              }

              for (const encodedKey of [...kvStore.keys()]) {
                const key = JSON.parse(encodedKey) as unknown[];
                if (key.includes(keyId)) kvStore.delete(encodedKey);
              }
              resetProviderHealthThrottleForTest();
            });
          }
        }
      }
    } finally {
      setStreamFirstEventDeadlineMsForTest(null);
      resetMeteredModelsCacheForTest();
      resetSurplusModelsCacheForTest();
      kvStore.delete(keyToString(CODEX_ACCOUNT_ROUTING_KV_KEY));
      resetCodexAccountRoutingForTest();
      resetProviderHealthThrottleForTest();
      if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
      else process.env.METERED_API_KEY = originalMeteredApiKey;
      if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
      else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
    }
  }));

test("openai: cancelling a reasoning-released Codex stream stays cancelled and unpaid", async () =>
  runSequence(async (step) => {
    const originalMeteredApiKey = process.env.METERED_API_KEY;
    const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
    const routeCases = [
      { route: "responses", keyId: "reasoning-cancel-responses" },
      { route: "chat", keyId: "reasoning-cancel-chat" },
    ] as const;

    try {
      process.env.METERED_API_KEY = "metered-test-key";
      process.env.SURPLUS_API_KEY = "surplus-test-key";

      for (const routeCase of routeCases) {
        await step(`${routeCase.route} cancels after hidden reasoning releases headers`, async () => {
          const { keyId } = routeCase;
          const requestId = `request-${keyId}`;
          seedPaidFallbackKey(keyId);
          let codexCalls = 0;
          let surplusCalls = 0;
          let meteredCalls = 0;
          let upstreamCancellations = 0;
          const blockedPull = { resolve: (): void => {} };
          const observedTerminalUsages: { completed: boolean; inputTokens: number | null }[] = [];

          const response = await withFetchMock(
            (url) => {
              if (url === "https://chatgpt.com/backend-api/codex/responses") {
                codexCalls += 1;
                const responseId = `resp_${routeCase.route}_reasoning_cancel`;
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(
                        TEXT_ENCODER.encode(
                          `data: ${JSON.stringify({
                            type: "response.created",
                            response: { id: responseId, object: "response", status: "in_progress", output: [] },
                          })}\n\n` +
                            `data: ${JSON.stringify({
                              type: "response.reasoning_summary_text.delta",
                              response_id: responseId,
                              item_id: `reasoning_${responseId}`,
                              output_index: 0,
                              summary_index: 0,
                              delta: "hidden progress before cancellation",
                            })}\n\n`
                        )
                      );
                    },
                    pull() {
                      return captureResolve(blockedPull);
                    },
                    cancel() {
                      upstreamCancellations += 1;
                      blockedPull.resolve();
                    },
                  }),
                  { status: 200, headers: { "Content-Type": "text/event-stream" } }
                );
              }
              if (url === "https://api.surplusintelligence.ai/v1/responses") {
                surplusCalls += 1;
                throw new Error("reasoning-progress cancellation must not dispatch to Surplus");
              }
              if (url === "https://api.openlux.ai/v1/responses") {
                meteredCalls += 1;
                throw new Error("reasoning-progress cancellation must not dispatch to OpenLux");
              }
              throw new Error(`Unexpected upstream dispatch during reasoning cancellation: ${url}`);
            },
            async () => {
              const usageContext = {
                keyId,
                kernelRepo: null,
                kernelOrg: null,
                paidFallbackEnabled: true,
                requestId,
                startedAtMs: Date.now(),
                onTerminalUsage: (usage: { inputTokens: number | null } | null, completed: boolean) => {
                  observedTerminalUsages.push({ completed, inputTokens: usage?.inputTokens ?? null });
                },
              };
              const routed =
                routeCase.route === "responses"
                  ? await handleResponses(responsesRequest({ stream: true }), usageContext)
                  : await handleChatCompletions(
                      new Request("https://ai.ubq.fi/v1/chat/completions", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          model: DEFAULT_TEST_MODEL,
                          stream: true,
                          messages: [{ role: "user", content: "reason until I cancel" }],
                        }),
                      }),
                      usageContext
                    );

              assert.equal(routed.status, 200);
              assert.equal(routed.headers.get("x-uos-upstream"), "chatgpt_codex");
              assert.ok(routed.body);
              await routed.body.cancel("client cancelled after reasoning progress");

              const cancellationDeadline = performance.now() + 1_000;
              while (upstreamCancellations === 0 || getResponseTelemetry(routed)?.streamTerminalType !== "cancelled") {
                if (performance.now() >= cancellationDeadline) {
                  assert.fail(`${routeCase.route} did not finish its cancellation lifecycle`);
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
              }
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              return routed;
            }
          );

          const telemetry = getResponseTelemetry(response);
          assert.equal(telemetry?.provider, "chatgpt_codex");
          assert.equal(telemetry.fallbackReason, null);
          assert.equal(telemetry.streamTerminalType, "cancelled");
          assert.equal(telemetry.completed, false);
          assert.notEqual(telemetry.semanticOutputObserved, true);
          assert.deepEqual(observedTerminalUsages, []);
          assert.equal(upstreamCancellations, 1);
          assert.equal(codexCalls, 1);
          assert.equal(surplusCalls, 0);
          assert.equal(meteredCalls, 0);
          assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);

          const keyRecord = kvStore.get(keyToString(["ubq_ai", "api_keys", "id", keyId])) as {
            usage_reset_at_ms: number;
            paid_fallback_spent_microcredits: number;
            paid_fallback_reserved_microcredits: number;
            paid_fallback_reservation_request_id: string | null;
          };
          assert.equal(keyRecord.paid_fallback_spent_microcredits, 0);
          assert.equal(keyRecord.paid_fallback_reserved_microcredits, 0);
          assert.equal(keyRecord.paid_fallback_reservation_request_id, null);
          assert.equal(kvStore.get(keyToString(["uos_ai", "paid_fallback", "v3", "window", keyId, keyRecord.usage_reset_at_ms])), undefined);
        });
      }
    } finally {
      for (const { keyId } of routeCases) {
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
      }
      if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
      else process.env.METERED_API_KEY = originalMeteredApiKey;
      if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
      else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
    }
  }));

test("openai: streaming Responses clear their absolute deadline after semantic output", async () => {
  setStreamFirstEventDeadlineMsForTest(30);
  try {
    const response = await withFetchMock(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                TEXT_ENCODER.encode(
                  `data: ${JSON.stringify({
                    type: "response.created",
                    response: { id: "resp_stream_absolute", object: "response", status: "in_progress", output: [] },
                  })}\n\n`
                )
              );
              controller.enqueue(
                TEXT_ENCODER.encode(
                  `data: ${JSON.stringify({
                    type: "response.output_text.delta",
                    response_id: "resp_stream_absolute",
                    item_id: "msg_stream_absolute",
                    output_index: 0,
                    content_index: 0,
                    delta: "still streaming",
                  })}\n\n`
                )
              );
              setTimeout(() => {
                controller.enqueue(
                  TEXT_ENCODER.encode(
                    `data: ${JSON.stringify({
                      type: "response.completed",
                      response: {
                        id: "resp_stream_absolute",
                        object: "response",
                        status: "completed",
                        output: [],
                        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                      },
                    })}\n\n`
                  )
                );
              }, 60);
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ),
      () => handleResponses(responsesRequest())
    );
    assert.equal(response.status, 200);
    const values = parseResponsesSseValues(await response.text());
    assert.equal(values.filter((event) => event.type === "response.completed").length, 1);
    assert.equal(values.filter((event) => event.type === "response.failed").length, 0);
  } finally {
    setStreamFirstEventDeadlineMsForTest(null);
  }
});

test("openai: Codex pre-header gateway deadlines use server_error on both streaming routes", async () => {
  setStreamFirstEventDeadlineMsForTest(10);
  try {
    for (const route of ["responses", "chat"] as const) {
      await withFetchMock(
        (_url, _bodyText, init) => {
          const signal = init?.signal;
          if (!signal) return Promise.reject(new Error("Codex request did not receive a gateway deadline signal"));
          return rejectOnAbort(signal);
        },
        async () => {
          const response =
            route === "responses"
              ? await handleResponses(
                  new Request("https://ai.ubq.fi/v1/responses", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping", stream: true }),
                  })
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
                  })
                );
          const payload = (await response.json()) as { error?: { type?: unknown; code?: unknown } };
          assert.equal(response.status, 504, route);
          assert.equal(payload.error?.type, "server_error", route);
          assert.equal(payload.error.code, "gateway_timeout", route);
        }
      );
    }
  } finally {
    setStreamFirstEventDeadlineMsForTest(null);
  }
});

test("openai: transient Codex stalls never advance to paid fallback", async () =>
  runSequence(async (step) => {
    const originalMeteredApiKey = process.env.METERED_API_KEY;
    const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
    const keyIds = ["fallback-codex-no-headers", "fallback-codex-no-semantic-event", "fallback-codex-post-semantic-eof"];
    try {
      process.env.METERED_API_KEY = "metered-test-key";
      Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
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
      setStreamFirstEventDeadlineMsForTest(160);

      await step("no response headers returns Codex timeout and the next request retries Codex", async () => {
        const keyId = keyIds[0];
        const firstRequestId = `request-${keyId}`;
        seedPaidFallbackKey(keyId);
        let codexCalls = 0;
        let meteredCalls = 0;
        await withFetchMock(
          (url, _bodyText, init) => {
            if (url === "https://api.openlux.ai/v1/responses") {
              meteredCalls += 1;
              return sseResponse(baseSseChunks());
            }
            codexCalls += 1;
            if (codexCalls === 1) {
              const signal = init?.signal;
              if (!signal) return Promise.reject(new Error("Codex timeout fixture did not receive a signal"));
              return rejectOnAbort(signal);
            }
            return sseResponse(baseSseChunks());
          },
          async () => {
            const first = await handleResponses(responsesRequest(), {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              paidFallbackEnabled: true,
              requestId: firstRequestId,
              startedAtMs: Date.now(),
            });
            assert.equal(first.status, 504);
            assert.equal(first.headers.get("x-uos-upstream"), "chatgpt_codex");
            assert.equal(getResponseTelemetry(first)?.fallbackReason, null);
            assert.equal(getStoredPaidFallbackRequest(keyId, firstRequestId), null);

            const authPool = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as CodexAuthPoolState;
            const selection = await selectCodexRoutingAccounts(authPool, authPool.accounts, Date.now());
            assert.equal(selection.kind, "eligible");

            const second = await handleResponses(responsesRequest(), {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              paidFallbackEnabled: true,
              requestId: `${firstRequestId}-next`,
              startedAtMs: Date.now(),
            });
            assert.equal(second.status, 200);
            assert.equal(second.headers.get("x-uos-upstream"), "chatgpt_codex");
            await second.text();
          }
        );
        assert.equal(codexCalls, 2);
        assert.equal(meteredCalls, 0);
      });

      await step("buffered setup events never leak when a pre-semantic Codex stream stalls", async () => {
        const keyId = keyIds[1];
        const requestId = `request-${keyId}`;
        seedPaidFallbackKey(keyId);
        let codexCalls = 0;
        let meteredCalls = 0;
        const response = await withFetchMock(
          (url) => {
            if (url === "https://api.openlux.ai/v1/responses") {
              meteredCalls += 1;
              return sseResponse(baseSseChunks());
            }
            codexCalls += 1;
            if (codexCalls > 1) return sseResponse(baseSseChunks());
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    TEXT_ENCODER.encode(
                      `data: ${JSON.stringify({
                        type: "response.created",
                        response: { id: "resp_codex_stalled", created_at: 0 },
                      })}\n\n`
                    )
                  );
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
              }
            );
          },
          () =>
            handleResponses(responsesRequest(), {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              paidFallbackEnabled: true,
              requestId,
              startedAtMs: Date.now(),
            })
        );
        assert.equal(response.status, 504);
        assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
        assert.equal(getResponseTelemetry(response)?.fallbackReason, null);
        const body = await response.text();
        assert.equal(body.includes("resp_codex_stalled"), false);
        assert.equal(getStoredPaidFallbackRequest(keyId, requestId), null);

        const authPool = kvStore.get(keyToString(["ubq_ai", "codex_auth"])) as CodexAuthPoolState;
        const selection = await selectCodexRoutingAccounts(authPool, authPool.accounts, Date.now());
        assert.equal(selection.kind, "eligible");

        const next = await withFetchMock(
          (url) => {
            if (url === "https://api.openlux.ai/v1/responses") {
              meteredCalls += 1;
              return sseResponse(baseSseChunks());
            }
            codexCalls += 1;
            return sseResponse(baseSseChunks());
          },
          () =>
            handleResponses(responsesRequest(), {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              paidFallbackEnabled: true,
              requestId: `${requestId}-next`,
              startedAtMs: Date.now(),
            })
        );
        assert.equal(next.status, 200);
        assert.equal(next.headers.get("x-uos-upstream"), "chatgpt_codex");
        await next.text();
        assert.equal(codexCalls, 2);
        assert.equal(meteredCalls, 0);
      });

      await step("a stream failure after semantic output never switches providers", async () => {
        const keyId = keyIds[2];
        seedPaidFallbackKey(keyId);
        let meteredCalls = 0;
        const response = await withFetchMock(
          (url) => {
            if (url === "https://api.openlux.ai/v1/responses") {
              meteredCalls += 1;
              throw new Error("a committed Codex stream must not switch providers");
            }
            return sseResponse([
              `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_codex_committed" } })}\n\n`,
              `data: ${JSON.stringify({
                type: "response.output_text.delta",
                response_id: "resp_codex_committed",
                item_id: "msg_codex_committed",
                output_index: 0,
                content_index: 0,
                delta: "partial",
              })}\n\n`,
            ]);
          },
          () =>
            handleResponses(responsesRequest(), {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              paidFallbackEnabled: true,
              requestId: `request-${keyId}`,
              startedAtMs: Date.now(),
            })
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
        const events = parseResponsesSseValues(await response.text());
        assert.equal(events.filter((event) => event.type === "response.created").length, 1);
        assert.equal(events.filter((event) => event.type === "response.failed").length, 1);
        assert.equal(meteredCalls, 0);
      });
    } finally {
      setStreamFirstEventDeadlineMsForTest(null);
      for (const keyId of keyIds) {
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
      }
      resetMeteredModelsCacheForTest();
      resetSurplusModelsCacheForTest();
      if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
      else process.env.METERED_API_KEY = originalMeteredApiKey;
      if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
      else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
    }
  }));

test("openai: upstream fetch logs redact provider error payloads", async () => {
  const secret = "prompt-or-credential-must-not-reach-server-logs";
  const logs: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => logs.push(args);

  try {
    for (const route of ["responses", "chat"] as const) {
      await withFetchMock(
        () => {
          const error = new TypeError(`provider echoed ${secret}`);
          (error as { cause?: unknown }).cause = { body: secret, message: secret };
          throw error;
        },
        async () => {
          const response =
            route === "responses"
              ? await handleResponses(
                  new Request("https://ai.ubq.fi/v1/responses", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, input: "ping" }),
                  })
                )
              : await handleChatCompletions(
                  new Request("https://ai.ubq.fi/v1/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: DEFAULT_TEST_MODEL, messages: [{ role: "user", content: "ping" }] }),
                  })
                );
          assert.equal(response.status, 502, route);
          const payload = (await response.json()) as { error?: { code?: unknown } };
          assert.equal(payload.error?.code, "codex_upstream_unreachable", route);
        }
      );
    }
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(logs.length, 2);
  for (const args of logs) {
    assert.equal(args.length, 2);
    assert.equal(args[0], "[ai.ubq.fi] Upstream fetch failed:");
    assert.deepEqual(args[1], {
      error_class: "CodexError",
      status: 502,
      code: "codex_upstream_unreachable",
    });
    assert.equal(JSON.stringify(args).includes(secret), false);
  }
});
