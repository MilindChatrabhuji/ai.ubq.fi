import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  METERED_BASE_URL,
  MeteredError,
  fetchMeteredModels,
  fetchMeteredResponses,
  fetchMeteredTokenLogs,
  initializeMeteredPricing,
  resetMeteredModelsCacheForTest,
  setMeteredModelsFetchForTest,
} from "../src/provider/metered.ts";

/**
 * Branch coverage for the OpenLux (Metered) provider.
 *
 * Every case drives an exported entry point through its injected fetcher seam
 * and asserts the observable result: the published model snapshot, the pricing
 * snapshot, the client-visible error code, or the parsed token log. No network,
 * no KV and no wall-clock dependence.
 */

const API_KEY_ENV = "METERED_API_KEY";

/** Runs `run` with a discovery key in the environment and a clean models cache. */
const withDiscoveryKey = async (run: () => Promise<void>): Promise<void> => {
  const previous = process.env[API_KEY_ENV];
  process.env[API_KEY_ENV] = "metered-fixture-key";
  resetMeteredModelsCacheForTest();
  try {
    await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, API_KEY_ENV);
    else process.env[API_KEY_ENV] = previous;
    resetMeteredModelsCacheForTest();
  }
};

const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const emptyModelsResponse = (): Response => jsonResponse({ data: [] });

test("metered models: discovery reads the upstream list, normalizes each row and skips duplicates", async () => {
  await withDiscoveryKey(async () => {
    const payload = {
      data: [
        {
          id: "gpt-6-astra",
          created: 1_800_000_000,
          owned_by: "openlux",
          model_type: "chat",
          description: "frontier",
          tags: ["fast"],
          supported_endpoint_types: ["/v1/responses", 5],
        },
        { id: "gpt-6-astra" },
        { id: "   " },
        { created: 1 },
        42,
        { id: "thin" },
        { id: "tagged-model", tags: "fast,cheap", owned_by: "   ", created: -5, supported_endpoint_types: "none" },
      ],
    };
    const snapshot = await fetchMeteredModels({ fetcher: () => Promise.resolve(jsonResponse(payload)) });

    assert.ok(snapshot, "discovery must publish a snapshot");
    assert.equal(snapshot.models.length, 3);
    // Non-string endpoint entries are dropped, and a non-string `tags` value
    // (an array here) is not part of the published model at all.
    assert.deepEqual(snapshot.models[0], {
      id: "gpt-6-astra",
      object: "model",
      created: 1_800_000_000,
      owned_by: "openlux",
      supported_endpoint_types: ["/v1/responses"],
      model_type: "chat",
      description: "frontier",
    });
    // A row with only an id keeps the defaults: created 0, owned_by openlux,
    // and no optional fields at all.
    assert.deepEqual(snapshot.models[1], { id: "thin", object: "model", created: 0, owned_by: "openlux", supported_endpoint_types: [] });
    // A blank owner, a negative timestamp and a non-array endpoint list all fall
    // back to their defaults, while a string `tags` value is preserved verbatim.
    assert.deepEqual(snapshot.models[2], {
      id: "tagged-model",
      object: "model",
      created: 0,
      owned_by: "openlux",
      supported_endpoint_types: [],
      tags: "fast,cheap",
    });
  });
});

test("metered models: an unusable payload, a rejecting fetch and a missing key all keep the cache", async () => {
  await withDiscoveryKey(async () => {
    // A successful first read publishes a snapshot.
    const published = await fetchMeteredModels({ fetcher: () => Promise.resolve(jsonResponse({ data: [{ id: "gpt-6-astra" }] })) });
    assert.equal(published?.models.length, 1);

    // A payload without a data array is a failure and returns the cache.
    const malformed = await fetchMeteredModels({ force: true, fetcher: () => Promise.resolve(jsonResponse({ data: "none" })) });
    assert.equal(malformed?.models.length, 1);
    // A non-record payload takes the same path.
    const scalar = await fetchMeteredModels({ force: true, fetcher: () => Promise.resolve(jsonResponse(7)) });
    assert.equal(scalar?.models.length, 1);
  });

  await withDiscoveryKey(async () => {
    // A rejecting fetch is swallowed and reports the (empty) cache.
    const rejected = await fetchMeteredModels({ fetcher: () => Promise.reject(new Error("connect refused")) });
    assert.equal(rejected, null);

    // A non-JSON body is a failure too.
    const nonJson = await fetchMeteredModels({ force: true, fetcher: () => Promise.resolve(new Response("<html>", { status: 200 })) });
    assert.equal(nonJson, null);

    // Without a fetcher and without the default fetch the cache is returned.
    const unavailable = await fetchMeteredModels({ force: true });
    assert.equal(unavailable, null);

    // An already-aborted caller signal is not reported as an upstream failure,
    // so the call resolves with the cache rather than a backoff.
    const controller = new AbortController();
    controller.abort();
    const aborted = await fetchMeteredModels({ force: true, signal: controller.signal, fetcher: () => Promise.resolve(emptyModelsResponse()) });
    assert.equal(aborted, null);
  });
});

test("metered models: the cached snapshot is served for a fresh cache and for cachedOnly callers", async () => {
  await withDiscoveryKey(async () => {
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ data: [{ id: "gpt-6-astra" }] }));
    };
    await fetchMeteredModels({ fetcher });
    assert.equal(calls, 1);

    // A fresh cache short-circuits, and cachedOnly never reaches the transport.
    const cached = await fetchMeteredModels({ fetcher });
    const cachedOnly = await fetchMeteredModels({ cachedOnly: true, fetcher });
    assert.equal(calls, 1);
    assert.equal(cached?.models.length, 1);
    assert.equal(cachedOnly?.models.length, 1);
  });

  // Without a discovery key there is nothing to fetch.
  const previous = process.env[API_KEY_ENV];
  Reflect.deleteProperty(process.env, API_KEY_ENV);
  resetMeteredModelsCacheForTest();
  try {
    const withoutKey = await fetchMeteredModels({ force: true, fetcher: () => Promise.resolve(emptyModelsResponse()) });
    assert.equal(withoutKey, null);
  } finally {
    if (previous !== undefined) process.env[API_KEY_ENV] = previous;
    resetMeteredModelsCacheForTest();
  }
});

test("metered models: the test fetch seam is used when no fetcher is supplied", async () => {
  await withDiscoveryKey(async () => {
    setMeteredModelsFetchForTest((input) => {
      const url = urlOf(input);
      assert.match(url, /\/v1\/models$/);
      return Promise.resolve(jsonResponse({ data: [{ id: "seam-model" }] }));
    });
    try {
      const snapshot = await fetchMeteredModels({});
      assert.equal(snapshot?.models[0].id, "seam-model");
    } finally {
      setMeteredModelsFetchForTest(null);
    }
  });
});

const pricingEnvelope = (overrides: Record<string, unknown> = {}): Response =>
  jsonResponse({
    success: true,
    data: {
      model_ratio: { "gpt-6-astra": 2, "ignored-model": 0 },
      model_price: { "gpt-6-astra": 0.5, "free-model": 0 },
      completion_ratio: { "gpt-6-astra": 1.5, "ignored-model": 4 },
      ...overrides,
    },
  });

const statusEnvelope = (overrides: Record<string, unknown> = {}): Response =>
  jsonResponse({ success: true, data: { setup: true, quota_per_unit: 500_000, ...overrides } });

const pricingFetcher = (pricing: Response, status: Response) => (input: RequestInfo | URL) => {
  const url = urlOf(input);
  return Promise.resolve(url.endsWith("/api/ratio_config") ? pricing : status);
};

test("metered pricing: a well-formed pair publishes the coefficients for the eligible Codex ids", async () => {
  const pricing = jsonResponse({
    success: true,
    data: {
      // A ratio-only model folds the completion ratio into its coefficient and a
      // fixed price overrides any ratio; a zero ratio is not priced at all.
      model_ratio: { "gpt-6-astra": 2, "ratio-only": 4, "zero-ratio": 0 },
      model_price: { "gpt-6-astra": 0.5 },
      completion_ratio: { "gpt-6-astra": 1.5, "ratio-only": 0.5, "zero-ratio": 4 },
    },
  });
  const snapshot = await initializeMeteredPricing({
    codexModelIds: ["gpt-6-astra", "ratio-only", "unpriced-model"],
    now: () => 1_800_000_000_000,
    fetcher: pricingFetcher(pricing, statusEnvelope()),
  });

  assert.equal(snapshot.quota_per_credit, 500_000);
  assert.equal(snapshot.checked_at_ms, 1_800_000_000_000);
  // Only ids the pricing maps actually price reach the snapshot, in caller order.
  assert.deepEqual(snapshot.eligible_model_ids, ["gpt-6-astra", "ratio-only"]);
  // ratio-only: 4 * (1 + 0.5) = 6; gpt-6-astra keeps its fixed price 0.5.
  assert.deepEqual(snapshot.model_quota_coefficients, { "gpt-6-astra": 0.5, "ratio-only": 6 });
});

test("metered pricing: every malformed envelope and configuration is rejected by code", async () => {
  const expectRejection = async (fetcher: (input: RequestInfo | URL) => Promise<Response>, code: string, status?: number) => {
    const error = await initializeMeteredPricing({ codexModelIds: ["gpt-6-astra"], fetcher }).catch((reason: unknown) => reason);
    assert.ok(error instanceof MeteredError, `expected a MeteredError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
  };

  // A transport failure is unavailable, and an unreadable body is invalid.
  await expectRejection(() => Promise.reject(new Error("offline")), "metered_pricing_unavailable", 502);
  await expectRejection(() => Promise.resolve(new Response("<html>", { status: 200 })), "metered_pricing_invalid", 502);
  await expectRejection(() => Promise.resolve(jsonResponse({ success: false })), "metered_pricing_invalid", 502);
  await expectRejection(() => Promise.resolve(jsonResponse({ success: true, data: "none" })), "metered_pricing_invalid", 502);

  // The status envelope carries the quota conversion.
  await expectRejection(pricingFetcher(pricingEnvelope(), jsonResponse({ success: false })), "metered_status_invalid", 502);
  await expectRejection(pricingFetcher(pricingEnvelope(), statusEnvelope({ setup: false })), "metered_status_invalid", 502);
  await expectRejection(pricingFetcher(pricingEnvelope(), statusEnvelope({ quota_per_unit: 1.5 })), "metered_status_invalid", 502);
  await expectRejection(pricingFetcher(pricingEnvelope(), statusEnvelope({ quota_per_unit: -1 })), "metered_status_invalid", 502);

  // A pricing configuration without both required maps is invalid.
  await expectRejection(
    pricingFetcher(jsonResponse({ success: true, data: { model_ratio: {}, model_price: "none" } }), statusEnvelope()),
    "metered_pricing_invalid",
    502
  );
  await expectRejection(
    pricingFetcher(jsonResponse({ success: true, data: { model_ratio: "none", model_price: {} } }), statusEnvelope()),
    "metered_pricing_invalid",
    502
  );

  // A non-record completion_ratio is tolerated rather than rejected: every
  // ratio-priced model falls back to a completion ratio of 1.
  const completionFallback = await initializeMeteredPricing({
    codexModelIds: ["gpt-6-astra"],
    now: () => 1,
    fetcher: pricingFetcher(
      jsonResponse({ success: true, data: { model_ratio: { "gpt-6-astra": 3 }, model_price: {}, completion_ratio: "none" } }),
      statusEnvelope()
    ),
  });
  assert.deepEqual(completionFallback.eligible_model_ids, ["gpt-6-astra"]);
  assert.deepEqual(completionFallback.model_quota_coefficients, { "gpt-6-astra": 6 });

  // An invalid clock and an unusable Codex model id are rejected before publication.
  const validFetcher = pricingFetcher(pricingEnvelope(), statusEnvelope());
  const clockError = await initializeMeteredPricing({ codexModelIds: ["gpt-6-astra"], now: () => -1, fetcher: validFetcher }).catch(
    (reason: unknown) => reason
  );
  assert.ok(clockError instanceof MeteredError);
  assert.equal(clockError.code, "metered_status_invalid");

  const idError = await initializeMeteredPricing({ codexModelIds: ["   "], now: () => 1, fetcher: validFetcher }).catch((reason: unknown) => reason);
  assert.ok(idError instanceof MeteredError);
  assert.equal(idError.code, "metered_pricing_invalid");
});

test("metered responses: the projection refuses unusable bodies and applies the reasoning suffix", async () => {
  const rejection = await fetchMeteredResponses("not-an-object", { apiKey: "sk-test" }).catch((reason: unknown) => reason);
  assert.ok(rejection instanceof MeteredError);
  assert.equal(rejection.code, "metered_request_invalid");
  assert.equal(rejection.status, 400);

  const circular: Record<string, unknown> = { model: "gpt-6-astra" };
  circular.self = circular;
  const unserializable = await fetchMeteredResponses(circular, { apiKey: "sk-test" }).catch((reason: unknown) => reason);
  assert.ok(unserializable instanceof MeteredError);
  assert.equal(unserializable.code, "metered_request_invalid");

  // The reasoning tier rides the model id for the models that support it, and the
  // request id comes from the upstream response headers rather than the body.
  const bodies: string[] = [];
  const fetcher = (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return Promise.resolve(
      new Response(JSON.stringify({ id: "resp_1" }), { status: 200, headers: { "X-Api-Request-Id": "resp_1", "Content-Type": "application/json" } })
    );
  };
  const dispatch = { markTransportStarted: () => {}, cancelBeforeTransport: () => Promise.resolve() };
  const captured = await fetchMeteredResponses(
    { model: "gpt-5.6-sol", reasoning: { effort: "none" } },
    { apiKey: "sk-test", fetcher, beforeDispatch: () => Promise.resolve(dispatch) }
  );
  assert.equal(captured.request_id, "resp_1");
  assert.equal(captured.response.status, 200);
  const lowered = JSON.parse(bodies[0]) as Record<string, unknown>;
  assert.equal(lowered.model, "gpt-5.6-sol-low");
  // The translated body replaces the effort argument with the model suffix.
  assert.equal("reasoning" in lowered, false);

  await fetchMeteredResponses({ model: "gpt-5.6-sol", reasoning: { effort: "minimal" } }, { apiKey: "sk-test", fetcher });
  assert.equal(JSON.parse(bodies[1]).model, "gpt-5.6-sol-low");
  await fetchMeteredResponses({ model: "gpt-5.6-sol", reasoning: { effort: "ultra" } }, { apiKey: "sk-test", fetcher });
  assert.equal(JSON.parse(bodies[2]).model, "gpt-5.6-sol-max");
  await fetchMeteredResponses({ model: "other-model", reasoning: { effort: "max" } }, { apiKey: "sk-test", fetcher });
  assert.equal(JSON.parse(bodies[3]).model, "other-model");
  // A model the suffix table does not list keeps its own id and its reasoning.
  assert.deepEqual(JSON.parse(bodies[3]).reasoning, { effort: "max" });
  await fetchMeteredResponses({ model: "gpt-5.6-sol", reasoning: { effort: "high" } }, { apiKey: "sk-test", fetcher });
  assert.equal(JSON.parse(bodies[4]).model, "gpt-5.6-sol-high");
});

test("metered responses: dispatch admission, abort and transport failures keep their own identity", async () => {
  // An already-aborted caller signal fails before the transport is touched.
  const controller = new AbortController();
  const reason = new Error("client left");
  controller.abort(reason);
  let dispatched = false;
  let cancelled = false;
  await assert.rejects(
    () =>
      fetchMeteredResponses(
        { model: "gpt-6-astra" },
        {
          apiKey: "sk-test",
          signal: controller.signal,
          fetcher: () => {
            dispatched = true;
            return Promise.resolve(jsonResponse({}));
          },
          beforeDispatch: () =>
            Promise.resolve({
              markTransportStarted: () => {},
              cancelBeforeTransport: () => {
                cancelled = true;
                return Promise.resolve();
              },
            }),
        }
      ),
    (error: unknown) => error === reason
  );
  assert.equal(dispatched, false);
  assert.equal(cancelled, true);

  // The dispatch hooks run in order when the request does go out.
  const events: string[] = [];
  const response = await fetchMeteredResponses(
    { model: "gpt-6-astra" },
    {
      apiKey: "sk-test",
      fetcher: () => Promise.resolve(jsonResponse({ id: "resp_2" })),
      beforeDispatch: () =>
        Promise.resolve({
          markTransportStarted: () => events.push("started"),
          cancelBeforeTransport: () => Promise.resolve(),
        }),
      onDispatch: () => events.push("dispatched"),
    }
  );
  assert.equal(response.response.status, 200);
  assert.deepEqual(events, ["started", "dispatched"]);

  // A rejecting transport becomes the unreachable error.
  const unreachable = await fetchMeteredResponses({ model: "gpt-6-astra" }, { apiKey: "sk-test", fetcher: () => Promise.reject(new Error("offline")) }).catch(
    (error: unknown) => error
  );
  assert.ok(unreachable instanceof MeteredError);
  assert.equal(unreachable.code, "metered_upstream_unreachable");
  assert.equal(unreachable.status, 502);

  // A caller abort mid-flight keeps the caller's own reason.
  const caller = new AbortController();
  const abortReason = new Error("caller cancelled");
  await assert.rejects(
    () =>
      fetchMeteredResponses(
        { model: "gpt-6-astra" },
        {
          apiKey: "sk-test",
          signal: caller.signal,
          fetcher: () => {
            caller.abort(abortReason);
            return Promise.reject(new Error("aborted"));
          },
        }
      ),
    (error: unknown) => error === abortReason
  );

  // Without a configured key the paid provider reports itself unavailable.
  const previous = process.env[API_KEY_ENV];
  Reflect.deleteProperty(process.env, API_KEY_ENV);
  try {
    const missingKey = await fetchMeteredResponses({ model: "gpt-6-astra" }, { apiKey: "" }).catch((error: unknown) => error);
    assert.ok(missingKey instanceof MeteredError);
    assert.equal(missingKey.code, "metered_api_key_missing");
    assert.equal(missingKey.status, 503);
  } finally {
    if (previous !== undefined) process.env[API_KEY_ENV] = previous;
  }
});

test("metered token logs: a successful page is parsed, filtered and paginated", async () => {
  const entries = [
    { request_id: "req-1", model_name: "gpt-6-astra", quota: 1, prompt_tokens: 2, cached_prompt_tokens: 1, completion_tokens: 3, created_at: 10 },
    { request_id: "  ", other: '{"request_id":"req-2"}', model_name: "gpt-6-astra", quota: 1, prompt_tokens: 2, completion_tokens: 3, created_at: 10 },
    { request_id: "req-bad-other", other: "not json", model_name: "gpt-6-astra", quota: 1, prompt_tokens: 2, completion_tokens: 3, created_at: 10 },
    // No request id anywhere, so the row is dropped.
    { model_name: "gpt-6-astra", quota: 1, prompt_tokens: 2, completion_tokens: 3, created_at: 10 },
    // A blank model name is not a usable row either.
    { request_id: "req-blank-model", model_name: "   ", quota: 1, prompt_tokens: 2, completion_tokens: 3, created_at: 10 },
    // Negative usage counters are rejected.
    { request_id: "req-negative", model_name: "gpt-6-astra", quota: -1, prompt_tokens: 2, completion_tokens: 3, created_at: 10 },
    // A missing timestamp is rejected.
    { request_id: "req-no-time", model_name: "gpt-6-astra", quota: 1, prompt_tokens: 2, completion_tokens: 3 },
    "skip",
  ];
  const requested: string[] = [];
  const fetcher = (input: RequestInfo | URL) => {
    const url = urlOf(input);
    requested.push(url);
    return Promise.resolve(jsonResponse({ success: true, data: { items: entries, total: entries.length } }));
  };

  const logs = await fetchMeteredTokenLogs({ apiKey: "sk-test", fetcher, requestIds: ["req-2"], startAtMs: 1_000, endAtMs: 9_000 });

  // The requested id was found on the first page, so the walk stops there.
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/api\/log\/token\?key=sk-test&page=1&page_size=100/);
  assert.match(requested[0], /start_timestamp=1/);
  assert.match(requested[0], /end_timestamp=9/);
  // The `other` JSON fallback supplies the request id, and unusable rows are dropped.
  assert.deepEqual(
    logs.map((log) => log.request_id),
    ["req-1", "req-2", "req-bad-other"]
  );
  assert.equal(logs[0].cached_prompt_tokens, 1);
  assert.equal(logs[1].cached_prompt_tokens, undefined);
  assert.equal(logs[2].cached_prompt_tokens, undefined);
  assert.deepEqual(
    logs.map((log) => log.model),
    ["gpt-6-astra", "gpt-6-astra", "gpt-6-astra"]
  );
  assert.equal(logs[0].created_at, 10);
});

test("metered token logs: a bare array page and an enveloped empty page both terminate the walk", async () => {
  // A bare array page carries no total, so the page's own length ends the walk.
  let bareCalls = 0;
  const bareFetcher = () => {
    bareCalls += 1;
    return Promise.resolve(
      jsonResponse({ success: true, data: [{ request_id: "req-1", model_name: "m", quota: 1, prompt_tokens: 1, completion_tokens: 1, created_at: 1 }] })
    );
  };
  const bare = await fetchMeteredTokenLogs({ apiKey: "sk-test", fetcher: bareFetcher });
  assert.equal(bare.length, 1);
  assert.equal(bareCalls, 1);

  // An enveloped page with a larger total continues to a second page; its empty
  // item list ends the walk.
  let envelopedCalls = 0;
  const envelopedFetcher = () => {
    envelopedCalls += 1;
    const items = envelopedCalls === 1 ? [{ request_id: "req-1", model_name: "m", quota: 1, prompt_tokens: 1, completion_tokens: 1, created_at: 1 }] : [];
    return Promise.resolve(jsonResponse({ success: true, data: { items, total: 250 } }));
  };
  const enveloped = await fetchMeteredTokenLogs({ apiKey: "sk-test", fetcher: envelopedFetcher });
  assert.equal(enveloped.length, 1);
  assert.equal(envelopedCalls, 2);
});

test("metered token logs: every malformed envelope is rejected with its code", async () => {
  const rejectionFor = (fetcher: (input: RequestInfo | URL) => Promise<Response>) =>
    fetchMeteredTokenLogs({ apiKey: "sk-test", fetcher }).catch((reason: unknown) => reason);

  const rejected = await rejectionFor(() => Promise.reject(new Error("offline")));
  assert.ok(rejected instanceof MeteredError);
  assert.equal(rejected.code, "metered_logs_unavailable");

  const nonOk = await rejectionFor(() => Promise.resolve(jsonResponse({ success: true }, 503)));
  assert.ok(nonOk instanceof MeteredError);
  assert.equal(nonOk.code, "metered_logs_unavailable");
  // The client-visible status is the gateway's own 502; the upstream status rides along.
  assert.equal(nonOk.status, 502);
  assert.equal(nonOk.upstream_status, 503);

  const invalidJson = await rejectionFor(() => Promise.resolve(new Response("<html>", { status: 200 })));
  assert.ok(invalidJson instanceof MeteredError);
  assert.equal(invalidJson.code, "metered_logs_invalid");

  const failedEnvelope = await rejectionFor(() => Promise.resolve(jsonResponse({ success: false })));
  assert.ok(failedEnvelope instanceof MeteredError);
  assert.equal(failedEnvelope.code, "metered_logs_invalid");

  const missingItems = await rejectionFor(() => Promise.resolve(jsonResponse({ success: true, data: "none" })));
  assert.ok(missingItems instanceof MeteredError);
  assert.equal(missingItems.code, "metered_logs_invalid");

  // An empty page is valid and simply yields no logs.
  const empty = await fetchMeteredTokenLogs({ apiKey: "sk-test", fetcher: () => Promise.resolve(jsonResponse({ success: true, data: [] })) });
  assert.deepEqual(empty, []);
});

test("metered base url is the documented host", () => {
  assert.equal(METERED_BASE_URL, "https://api.openlux.ai");
});

test("metered discovery and pricing cover the stale-generation, unusable-fetch and overflow guards", async () => {
  await withDiscoveryKey(async () => {
    // A failure that lands after the cache generation moved on must not arm the
    // backoff, so the next ordinary call still reaches upstream.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return calls === 1 ? gate.then(() => new Response("unavailable", { status: 503 })) : Promise.resolve(jsonResponse({ data: [{ id: "after-reset" }] }));
    };
    const stale = fetchMeteredModels({ fetcher });
    resetMeteredModelsCacheForTest();
    release();
    assert.equal(await stale, null);
    const recovered = await fetchMeteredModels({ fetcher });
    assert.equal(calls, 2);
    assert.equal(recovered?.models[0].id, "after-reset");

    // Without a fetcher option, a test seam or the module's own fetch binding,
    // discovery has no transport and reports the (empty) cache.
    setMeteredModelsFetchForTest(null);
    const originalFetch = globalThis.fetch;
    let replacedFetchCalls = 0;
    globalThis.fetch = createFetchMock(() => {
      replacedFetchCalls += 1;
      return Promise.reject(new Error("replaced fetch"));
    });
    try {
      const cachedOnly = await fetchMeteredModels({ force: true });
      assert.equal(cachedOnly?.models[0].id, "after-reset");
      assert.equal(replacedFetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // A ratio that is finite on its own but overflows once the completion ratio
    // folds in stays eligible, while its unusable coefficient is omitted.
    const overflow = await initializeMeteredPricing({
      codexModelIds: ["overflow-model"],
      now: () => 7,
      fetcher: pricingFetcher(jsonResponse({ success: true, data: { model_ratio: { "overflow-model": 1e308 }, model_price: {} } }), statusEnvelope()),
    });
    assert.deepEqual(overflow.eligible_model_ids, ["overflow-model"]);
    assert.deepEqual(overflow.model_quota_coefficients, {});

    // The runtime guard protects untyped callers that hand over a non-array catalog.
    const invalidCatalog = await initializeMeteredPricing({
      codexModelIds: "gpt-6-astra" as unknown as readonly string[],
      now: () => 7,
      fetcher: pricingFetcher(pricingEnvelope(), statusEnvelope()),
    }).catch((error: unknown) => error);
    assert.ok(invalidCatalog instanceof MeteredError);
    assert.equal(invalidCatalog.code, "metered_pricing_invalid");
    assert.match(invalidCatalog.message, /requires the current Codex model catalog/);
  });
});

test("metered responses and logs reject unserializable bodies and wrap a non-Error abort reason", async () => {
  // JSON.stringify resolving to undefined (a `toJSON` probe) is not a usable body.
  const unserializable = await fetchMeteredResponses({ toJSON: () => undefined }, { apiKey: "sk-test" }).catch((error: unknown) => error);
  assert.ok(unserializable instanceof MeteredError);
  assert.equal(unserializable.code, "metered_request_invalid");
  assert.equal(unserializable.status, 400);
  assert.match(unserializable.message, /JSON-serializable body/);

  // A reasoning tier the model's suffix table does not list leaves the body alone.
  const bodies: string[] = [];
  const responsesFetcher = (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return Promise.resolve(jsonResponse({ id: "resp_1" }));
  };
  await fetchMeteredResponses({ model: "gpt-5.6-sol", reasoning: { effort: "lowest" } }, { apiKey: "sk-test", fetcher: responsesFetcher });
  assert.deepEqual(JSON.parse(bodies[0]), { model: "gpt-5.6-sol", reasoning: { effort: "lowest" } });

  // A non-Error abort reason is carried as the wrapper's cause instead of being lost.
  const controller = new AbortController();
  const pending = fetchMeteredTokenLogs({
    apiKey: "sk-test",
    signal: controller.signal,
    fetcher: () => new Promise<Response>(() => {}),
  });
  controller.abort("caller string reason");
  const wrapped = await pending.catch((error: unknown) => error);
  assert.ok(wrapped instanceof Error);
  assert.equal(wrapped.message, "Metered request failed");
  assert.equal((wrapped as Error & { cause?: unknown }).cause, "caller string reason");
});
