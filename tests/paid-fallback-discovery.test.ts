import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/openai-compat-harness.ts";
// Focused regression for paid-catalog discovery under a switched-off Codex
// tier: an enabled paid catalog must be discovered before the request can be
// rejected as provider_disabled, only enabled providers are discovered, and an
// enabled Codex tier still keeps its cached-first paid catalogs.

import assert from "node:assert/strict";
import {
  DEFAULT_TEST_MODEL,
  baseSseChunks,
  handleResponses,
  keyToString,
  kvStore,
  resetMeteredModelsCacheForTest,
  resetSurplusModelsCacheForTest,
  responsesRequest,
  seedPaidFallbackKey,
  sseResponse,
  withFetchMock,
  withProviderSelection,
} from "./helpers/openai-compat-harness.ts";

const SURPLUS_MODELS_URL = "https://api.surplusintelligence.ai/v1/models";
const SURPLUS_RESPONSES_URL = "https://api.surplusintelligence.ai/v1/responses";
const METERED_MODELS_URL = "https://api.openlux.ai/v1/models";
const METERED_RESPONSES_URL = "https://api.openlux.ai/v1/responses";
const PAID_URLS: readonly string[] = [SURPLUS_MODELS_URL, SURPLUS_RESPONSES_URL, METERED_MODELS_URL, METERED_RESPONSES_URL];

/** Keeps only the Surplus credential so its enabled catalog has to be discovered. */
const withSurplusOnlyCredentials = async <T>(run: () => Promise<T>): Promise<T> => {
  const previousSurplus = process.env.SURPLUS_API_KEY;
  const previousMetered = process.env.METERED_API_KEY;
  process.env.SURPLUS_API_KEY = "surplus-discovery-test-key";
  delete process.env.METERED_API_KEY;
  try {
    return await run();
  } finally {
    if (previousSurplus === undefined) delete process.env.SURPLUS_API_KEY;
    else process.env.SURPLUS_API_KEY = previousSurplus;
    if (previousMetered === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = previousMetered;
  }
};

const surplusCatalogResponse = (ids: readonly string[]): Response =>
  Response.json({ data: ids.map((id) => ({ id, pricing: { prompt: 0.000001, completion: 0.000003 } })) });

const surplusResponsesResponse = (requestId: string): Response =>
  new Response(sseResponse(baseSseChunks()).body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "X-Oneapi-Request-Id": requestId },
  });

const codexSseResponse = (): Response => new Response(sseResponse(baseSseChunks()).body, { status: 200, headers: { "Content-Type": "text/event-stream" } });

const deletePaidKeyRecords = (keyId: string): void => {
  kvStore.delete(keyToString(["ubq_ai", "api_keys", "id", keyId]));
  kvStore.delete(keyToString(["ubq_ai", "api_keys", "hash", `hash-${keyId}`]));
};

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("openai: a switched-off Codex tier discovers a cold enabled paid catalog before rejecting provider_disabled", async () => {
  const keyId = "paid-discovery-surplus";
  const requestId = `request-${keyId}`;
  const calls: string[] = [];
  const dispatchedProviders: string[] = [];
  const beforeProviderDispatch = (provider: string): Promise<undefined> => {
    dispatchedProviders.push(provider);
    return Promise.resolve(undefined);
  };
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  seedPaidFallbackKey(keyId);
  try {
    await withSurplusOnlyCredentials(async () => {
      await withProviderSelection(["surplus"], async () => {
        const response = await withFetchMock(
          (url) => {
            calls.push(url);
            if (url === SURPLUS_MODELS_URL) return surplusCatalogResponse([DEFAULT_TEST_MODEL]);
            if (url === SURPLUS_RESPONSES_URL) return surplusResponsesResponse(requestId);
            throw new Error(`a switched-off provider must not be reached: ${url}`);
          },
          () =>
            handleResponses(responsesRequest({ stream: false }), {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              requestId,
              startedAtMs: Date.now(),
              beforeProviderDispatch,
            })
        );
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assert.equal(response.headers.get("x-uos-upstream"), "surplus");
        assert.deepEqual(dispatchedProviders, ["surplus"]);
        assert.deepEqual(calls, [SURPLUS_MODELS_URL, SURPLUS_RESPONSES_URL]);
      });
    });
  } finally {
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    deletePaidKeyRecords(keyId);
  }
});

test("openai: a discovered enabled paid catalog that cannot serve the model still fails closed", async () => {
  const keyId = "paid-discovery-unroutable";
  const requestId = `request-${keyId}`;
  const calls: string[] = [];
  const dispatchedProviders: string[] = [];
  const beforeProviderDispatch = (provider: string): Promise<undefined> => {
    dispatchedProviders.push(provider);
    return Promise.resolve(undefined);
  };
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  seedPaidFallbackKey(keyId);
  try {
    await withSurplusOnlyCredentials(async () => {
      await withProviderSelection(["surplus"], async () => {
        const response = await withFetchMock(
          (url) => {
            calls.push(url);
            if (url === SURPLUS_MODELS_URL) return surplusCatalogResponse(["another-model"]);
            throw new Error(`no transport may be reached after the catalog disproves routability: ${url}`);
          },
          () =>
            handleResponses(responsesRequest({ stream: false }), {
              keyId,
              kernelRepo: null,
              kernelOrg: null,
              requestId,
              startedAtMs: Date.now(),
              beforeProviderDispatch,
            })
        );
        const payload = (await response.json()) as { error?: { code?: unknown; type?: unknown } };
        assert.equal(response.status, 503);
        assert.equal(payload.error?.code, "provider_disabled");
        assert.equal(payload.error.type, "server_error");
        assert.deepEqual(dispatchedProviders, []);
        assert.deepEqual(calls, [SURPLUS_MODELS_URL]);
      });
    });
  } finally {
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
    deletePaidKeyRecords(keyId);
  }
});

test("openai: an enabled Codex tier keeps cached-first paid catalogs", async () => {
  const calls: string[] = [];
  resetMeteredModelsCacheForTest();
  resetSurplusModelsCacheForTest();
  try {
    await withSurplusOnlyCredentials(async () => {
      await withProviderSelection(["codex", "surplus"], async () => {
        const response = await withFetchMock(
          (url) => {
            calls.push(url);
            if (PAID_URLS.includes(url)) throw new Error(`a Codex-enabled request must keep paid discovery cached-first: ${url}`);
            return codexSseResponse();
          },
          () => handleResponses(responsesRequest({ input: "codex cached-first" }))
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-uos-upstream"), "chatgpt_codex");
        await response.text();
        assert.deepEqual(
          calls.filter((url) => PAID_URLS.includes(url)),
          []
        );
      });
    });
  } finally {
    resetMeteredModelsCacheForTest();
    resetSurplusModelsCacheForTest();
  }
});
