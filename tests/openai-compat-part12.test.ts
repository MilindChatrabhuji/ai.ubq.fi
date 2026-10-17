import { test, beforeEach, afterEach } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import { installHarness, cleanupHarness } from "./helpers/openai-compat-harness.ts";
beforeEach(installHarness);
afterEach(cleanupHarness);
// openai-compat suite, part 12 of 12: tests moved out of tests/openai-compat.test.ts.

import assert from "node:assert/strict";
import {
  DEFAULT_TEST_MODEL,
  type OpenAiAtomicOp,
  atomicCommitObservation,
  atomicWritesForKey,
  authoritativeCodexQuotaResponse,
  baseSseChunks,
  clearMeteredAndSurplusProviderHealth,
  delayBy,
  fetchMeteredModels,
  getMeteredProviderHealth,
  getSurplusProviderHealth,
  handleResponses,
  keyToString,
  kvStore,
  resetMeteredModelsCacheForTest,
  resetProviderHealthThrottleForTest,
  resetSurplusModelsCacheForTest,
  responsesRequest,
  seedPaidFallbackKey,
  seedPaidFallthroughProviders,
  setKvForTest,
  sseResponse,
  waitForPaidFallbackTerminal,
  withFetchMock,
} from "./helpers/openai-compat-harness.ts";

test("openai: paid-provider health classification follows the provider body, not the status alone", async () =>
  runSequence(async (step) => {
    const originalMeteredApiKey = process.env.METERED_API_KEY;
    const originalSurplusApiKey = process.env.SURPLUS_API_KEY;
    const previousAtomicObserver = atomicCommitObservation.observer;
    const atomicCommits: OpenAiAtomicOp[][] = [];
    const keyIds: string[] = [];
    const meteredHealthCurrentKey = ["uos_ai", "provider_health", "v1", "metered", "default", "current"] as const;
    atomicCommitObservation.observer = (operations) => atomicCommits.push([...operations]);

    const runRequest = async (keyId: string, handler: (url: string, signal: AbortSignal | undefined) => Response): Promise<Response> => {
      keyIds.push(keyId);
      seedPaidFallbackKey(keyId);
      return await withFetchMock(
        (url, _bodyText, init) => {
          if (url === "https://api.surplusintelligence.ai/v1/responses" || url === "https://api.openlux.ai/v1/responses") {
            return handler(url, init?.signal ?? undefined);
          }
          return authoritativeCodexQuotaResponse();
        },
        () =>
          handleResponses(responsesRequest({ stream: false }), {
            keyId,
            kernelRepo: null,
            kernelOrg: null,
            requestId: `request-${keyId}`,
            startedAtMs: Date.now(),
          })
      );
    };

    try {
      process.env.METERED_API_KEY = "metered-classification-test-key";
      Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
      resetProviderHealthThrottleForTest();
      clearMeteredAndSurplusProviderHealth();
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

      const forbiddenBody = (body: Record<string, unknown>, providerRequestId: string): Response =>
        new Response(JSON.stringify(body), {
          status: 403,
          headers: { "Content-Type": "application/json", "X-Oneapi-Request-Id": providerRequestId },
        });

      await step("an OpenLux 403 with local:insufficient_quota records quota exhaustion", async () => {
        clearMeteredAndSurplusProviderHealth();
        resetProviderHealthThrottleForTest();
        const response = await runRequest("openlux-quota-code-403", (url) => {
          assert.equal(url, "https://api.openlux.ai/v1/responses");
          return forbiddenBody({ error: { message: "user quota is not enough, please top up", code: "local:insufficient_quota" } }, "openlux-403-code");
        });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get("x-uos-upstream"), "metered");
        await response.text();
        const health = await getMeteredProviderHealth();
        assert.equal(health.state, "exhausted");
        assert.equal(health.last_event, "quota_exhausted");
        assert.equal(health.last_status, 403);
        assert.equal(health.last_provider_request_id, "openlux-403-code");
        const stored = await waitForPaidFallbackTerminal("openlux-quota-code-403", "request-openlux-quota-code-403", "failed");
        assert.equal(stored.provider, "metered");
        // The terminal transport record must not downgrade the body-proven
        // classification to a generic upstream error.
        await delayBy(20);
        const upstreamErrorWrites = atomicWritesForKey(atomicCommits, meteredHealthCurrentKey).filter(
          (operation) => typeof operation.value === "object" && operation.value !== null && (operation.value as { event?: unknown }).event === "upstream_error"
        );
        assert.deepEqual(upstreamErrorWrites, [], "quota exhaustion is not overwritten by upstream_error");
        const current = kvStore.get(keyToString(meteredHealthCurrentKey)) as { event?: unknown; status?: unknown } | undefined;
        assert.ok(current);
        assert.equal(current.event, "quota_exhausted");
        assert.equal(current.status, 403);
      });

      await step("an OpenLux 403 with a message-only quota signal records quota exhaustion", async () => {
        clearMeteredAndSurplusProviderHealth();
        resetProviderHealthThrottleForTest();
        const response = await runRequest("openlux-quota-message-403", (url) => {
          assert.equal(url, "https://api.openlux.ai/v1/responses");
          return forbiddenBody({ error: { message: "Insufficient balance: user quota is not enough for this request" } }, "openlux-403-message");
        });
        assert.equal(response.status, 403);
        await response.text();
        const health = await getMeteredProviderHealth();
        assert.equal(health.state, "exhausted");
        assert.equal(health.last_event, "quota_exhausted");
        assert.equal(health.last_status, 403);
        assert.equal(health.last_provider_request_id, "openlux-403-message");
      });

      await step("an OpenLux 403 without a quota signal stays an auth fault", async () => {
        clearMeteredAndSurplusProviderHealth();
        resetProviderHealthThrottleForTest();
        const response = await runRequest("openlux-auth-403", (url) => {
          assert.equal(url, "https://api.openlux.ai/v1/responses");
          return forbiddenBody({ error: { message: "invalid access token", code: "invalid_token" } }, "openlux-403-auth");
        });
        assert.equal(response.status, 403);
        await response.text();
        const health = await getMeteredProviderHealth();
        assert.equal(health.state, "invalid");
        assert.equal(health.last_event, "auth_invalid");
        assert.equal(health.last_status, 403);
        assert.equal(health.last_provider_request_id, "openlux-403-auth");
      });

      await step("a transient Surplus 402 still falls through and is not recorded as exhaustion", async () => {
        process.env.SURPLUS_API_KEY = "surplus-classification-test-key";
        clearMeteredAndSurplusProviderHealth();
        resetProviderHealthThrottleForTest();
        await seedPaidFallthroughProviders();
        let surplusCalls = 0;
        let meteredCalls = 0;
        const response = await runRequest("surplus-402-health", (url) => {
          if (url === "https://api.surplusintelligence.ai/v1/responses") {
            surplusCalls += 1;
            return new Response(JSON.stringify({ error: { message: "no capacity", code: "no_capacity" } }), {
              status: 402,
              headers: { "Content-Type": "application/json", "X-Oneapi-Request-Id": "surplus-402-request" },
            });
          }
          assert.equal(url, "https://api.openlux.ai/v1/responses");
          meteredCalls += 1;
          return sseResponse(baseSseChunks());
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-upstream"), "metered");
        assert.equal(surplusCalls, 1);
        assert.equal(meteredCalls, 1);
        await response.text();
        const surplusHealth = await getSurplusProviderHealth();
        assert.equal(surplusHealth.last_event, "upstream_error");
        assert.equal(surplusHealth.last_status, 402);
        assert.equal(surplusHealth.last_provider_request_id, "surplus-402-request");
        assert.notEqual(surplusHealth.state, "exhausted");
      });

      await step("a Surplus 402 with insufficient_credit records quota exhaustion", async () => {
        clearMeteredAndSurplusProviderHealth();
        resetProviderHealthThrottleForTest();
        await seedPaidFallthroughProviders();
        let surplusCalls = 0;
        let meteredCalls = 0;
        const response = await runRequest("surplus-402-credit", (url) => {
          if (url === "https://api.surplusintelligence.ai/v1/responses") {
            surplusCalls += 1;
            return new Response(JSON.stringify({ error: { message: "insufficient balance", code: "insufficient_credit" } }), {
              status: 402,
              headers: { "Content-Type": "application/json", "X-Oneapi-Request-Id": "surplus-402-credit-request" },
            });
          }
          assert.equal(url, "https://api.openlux.ai/v1/responses");
          meteredCalls += 1;
          return sseResponse(baseSseChunks());
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-upstream"), "metered");
        assert.equal(surplusCalls, 1);
        assert.equal(meteredCalls, 1);
        await response.text();
        const surplusHealth = await getSurplusProviderHealth();
        assert.equal(surplusHealth.last_event, "quota_exhausted");
        assert.equal(surplusHealth.last_status, 402);
        assert.equal(surplusHealth.last_provider_request_id, "surplus-402-credit-request");
        assert.equal(surplusHealth.state, "exhausted");
      });
    } finally {
      atomicCommitObservation.observer = previousAtomicObserver;
      resetMeteredModelsCacheForTest();
      resetSurplusModelsCacheForTest();
      resetProviderHealthThrottleForTest();
      clearMeteredAndSurplusProviderHealth();
      for (const keyId of keyIds) {
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
        kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
      }
      if (originalMeteredApiKey === undefined) Reflect.deleteProperty(process.env, "METERED_API_KEY");
      else process.env.METERED_API_KEY = originalMeteredApiKey;
      if (originalSurplusApiKey === undefined) Reflect.deleteProperty(process.env, "SURPLUS_API_KEY");
      else process.env.SURPLUS_API_KEY = originalSurplusApiKey;
    }
  }));

addEventListener("unload", () => {
  setKvForTest(null);
});
