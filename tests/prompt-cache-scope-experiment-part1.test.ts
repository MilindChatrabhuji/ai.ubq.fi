import { createFetchMock } from "./helpers/fetch-mock.ts";
import { KvU64 } from "#kv";
import type { Kv, KvKey } from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/prompt-cache-scope-experiment-harness.ts";
import { runSequence } from "./helpers/sequence.ts";
// Suite part: tests moved out of the original file.

import assert from "node:assert/strict";
import {
  CACHE_READ_CYCLE,
  CACHE_WRITE_CYCLE_ALTERNATING,
  CACHE_WRITE_CYCLE_LEADING,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_MODELS_KV_KEY,
  MODEL,
  PromptCacheScopeExperimentBusyError,
  PromptCacheScopeExperimentUnavailableError,
  RUNTIME_CONFIG_V2_KEY,
  TELEMETRY_RELEASE,
  assertPromptCacheScopeExperimentTelemetryBaseline,
  cacheControls,
  campaignLeaseKey,
  compareStrings,
  cycleValue,
  encodeKey,
  evidenceKey,
  evidenceKeyFor,
  fetchInputUrl,
  handleAdminCodexCacheScopeExperiment,
  handleAdminCodexCacheScopeExperimentTelemetryBaseline,
  kv,
  makeAuth,
  modelRecord,
  readPromptCacheScopeExperimentCompletedUsage,
  readPromptCacheScopeExperimentTelemetryBaseline,
  requestBodyText,
  resetCodexAuthCacheForTest,
  resetProviderHealthThrottleForTest,
  resetRuntimeConfigCacheForTest,
  resolvePromptCacheTelemetryCounterKeys,
  runExperiment,
  runPromptCacheScopeExperiment,
  scopeBaselineFor,
  seed,
  seedStage0Baseline,
  sseCompleted,
  stateKey,
  stateKeyFor,
  storeCodexModelsSnapshot,
  waitForCodexHealth,
} from "./helpers/prompt-cache-scope-experiment-harness.ts";

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("prompt-cache Stage 0 diagnostic is read-only and redacts the server-selected target", async () => {
  seed();
  await seedStage0Baseline(MODEL);
  const originalFetch = globalThis.fetch;
  const originalBeforeGet = kv.beforeGet;
  const readKeys: KvKey[] = [];
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    throw new Error("Stage 0 diagnostics must not contact upstream");
  });
  kv.beforeGet = (key) => {
    readKeys.push(key);
  };

  try {
    const baseline = await readPromptCacheScopeExperimentTelemetryBaseline({
      kv: kv as unknown as Kv,
      release: TELEMETRY_RELEASE,
    });
    assert.equal(baseline.status, "eligible");
    assert.doesNotMatch(JSON.stringify(baseline), new RegExp(MODEL));
    assert.ok(readKeys.some((key) => key[0] === "uos_ai" && key[1] === "prompt_cache_telemetry_gate"));
    assert.equal(kv.atomicCalls, 0);
    assert.equal(fetchCalls, 0);

    const response = await handleAdminCodexCacheScopeExperimentTelemetryBaseline(() => Promise.resolve(baseline));
    const body = await response.text();
    const payload = JSON.parse(body) as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(payload.status, "eligible");
    assert.equal("model_hash" in payload, false);
    assert.equal("target" in payload, false);
    assert.doesNotMatch(body, new RegExp(MODEL));
  } finally {
    globalThis.fetch = originalFetch;
    kv.beforeGet = originalBeforeGet;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("prompt-cache Stage 0 diagnostic does not expose target-selection failures", async () => {
  const secret = "target-or-kv-detail-must-not-be-exposed";
  const logs: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => logs.push(args);
  try {
    const response = await handleAdminCodexCacheScopeExperimentTelemetryBaseline(() => {
      throw new Error(secret);
    });
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(body, new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(secret));
  } finally {
    console.error = originalConsoleError;
  }
});

test("a missing or mismatched pinned slot is an inconclusive scope result", async () => {
  const response = sseCompleted(0, 2_560);
  const result = await readPromptCacheScopeExperimentCompletedUsage(response, 1, MODEL, performance.now(), new AbortController().signal);

  assert.deepEqual(result, { status: "inconclusive", reason: "slot_drift" });
});

test("prompt-cache scope uses three fixed cycles, publishes canonical scope, and stores only redacted evidence", async () => {
  seed();
  resetProviderHealthThrottleForTest();
  const originalFetch = globalThis.fetch;
  const requests: { account: string | null; conversation: string | null; body: string }[] = [];
  let responseIndex = 0;
  let refreshes = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://auth.openai.com/oauth/token") {
      refreshes += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: `access-refreshed-${refreshes}`,
            refresh_token: `refresh-refreshed-${refreshes}`,
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );
    }
    requests.push({
      account: request.headers.get("chatgpt-account-id"),
      conversation: request.headers.get("conversation_id"),
      body: requestBodyText(init),
    });
    const step = responseIndex++ % 10;
    const cachedTokens = cycleValue(CACHE_READ_CYCLE, step);
    // A cache read and a cache write may be reported together. The scope
    // probe must still treat cached_tokens as a conclusive read signal.
    const cacheWriteTokens = cycleValue(CACHE_WRITE_CYCLE_LEADING, step);
    return Promise.resolve(sseCompleted(cachedTokens, cacheWriteTokens));
  });

  try {
    const first = await runExperiment();
    for (const accountId of ["account-one", "account-two"]) {
      const health = await waitForCodexHealth(accountId);
      assert.equal(health.state, "healthy", accountId);
      assert.equal(health.last_event, "success", accountId);
      assert.equal(typeof health.last_success_at_ms, "number", accountId);
    }
    const second = await runExperiment();
    const third = await runExperiment();
    assert.equal(first.status, "in_progress");
    assert.equal(first.completed_cycles, 1);
    assert.equal(second.status, "in_progress");
    assert.equal(second.completed_cycles, 2);
    assert.equal(third.status, "completed");
    assert.deepEqual(third.scope, {
      probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
      account_slots: "account_scoped",
      token_refresh: "preserved",
      conversation_id: "independent",
      effective_model: MODEL,
    });
    assert.equal(requests.length, 30);
    assert.equal(refreshes, 3);

    const cycleNonces = new Set<string>();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const rows = requests.slice(cycle * 10, (cycle + 1) * 10);
      assert.deepEqual(
        rows.map((row) => row.account),
        ["account-one", "account-one", "account-two", "account-two", "account-one", "account-one", "account-one", "account-one", "account-one", "account-one"]
      );
      assert.equal(
        rows.every((row) => row.body === rows[0]?.body),
        true
      );
      assert.equal(new Set(rows.map((row) => (JSON.parse(row.body) as Record<string, unknown>).prompt_cache_key)).size, 1);
      const body = JSON.parse(rows[0]?.body ?? "") as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(compareStrings), ["input", "model", "prompt_cache_key", "reasoning", "store", "stream"]);
      assert.equal(body.model, MODEL);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal("max_output_tokens" in body, false);
      assert.deepEqual(body.reasoning, { effort: "none" });
      assert.equal("prompt_cache_options" in body, false);
      assert.match(String(body.prompt_cache_key), /^uos-cache-scope-v5-[0-9a-f-]{36}$/);
      assert.equal("cache_affinity" in body, false);
      const input = body.input as Record<string, unknown>[];
      assert.equal(input.length, 2);
      assert.deepEqual(input[0]?.type, "message");
      assert.deepEqual(input[0]?.role, "developer");
      const prefix = input[0]?.content as Record<string, unknown>[];
      assert.deepEqual(prefix[0]?.type, "input_text");
      assert.equal("prompt_cache_breakpoint" in (prefix[0] ?? {}), false);
      const [cycleNonce, stablePrefix] = String(prefix[0]?.text).split("\n\n");
      assert.match(cycleNonce, /^cache-scope-cycle:/);
      cycleNonces.add(cycleNonce);
      assert.equal(stablePrefix.split(" ").length, 2_560);
      const request = input[1]?.content as Record<string, unknown>[];
      assert.deepEqual(input[1]?.role, "user");
      assert.deepEqual(request, [{ type: "input_text", text: "Reply with exactly: cache scope experiment." }]);
      assert.equal(rows[0]?.conversation, rows[6]?.conversation);
      assert.notEqual(rows[0]?.conversation, rows[7]?.conversation);
      assert.equal(rows[0]?.conversation, rows[9]?.conversation);
    }
    assert.equal(cycleNonces.size, 3);

    const snapshot = kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)) as {
      models?: {
        prompt_cache?: { providers?: { id?: string; scope?: unknown }[] };
      }[];
    };
    const provider = snapshot.models?.[0]?.prompt_cache?.providers?.[0];
    assert.equal(provider?.id, "codex_chatgpt");
    assert.deepEqual(provider.scope, {
      probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
      account_slots: "account_scoped",
      token_refresh: "preserved",
      conversation_id: "independent",
      effective_model: MODEL,
      reproducible_cycles: 3,
      source: "live_probe",
      verified_at_ms: provider.scope && (provider.scope as { verified_at_ms?: unknown }).verified_at_ms,
    });

    const runtime = kv.values.get(encodeKey(RUNTIME_CONFIG_V2_KEY)) as {
      codex_models?: {
        models?: {
          prompt_cache?: { providers?: { scope?: unknown }[] };
        }[];
      };
    };
    assert.equal(runtime.codex_models?.models?.[0]?.prompt_cache?.providers?.[0]?.scope, undefined);

    assert.equal(
      await storeCodexModelsSnapshot({
        source: "admin-refresh",
        updated_at_ms: Date.now(),
        models: [
          {
            slug: MODEL,
            supported_reasoning_levels: ["none"],
            prompt_cache: { version: 1, providers: [{ id: "codex_chatgpt", controls: cacheControls }] },
          },
        ],
      }),
      true
    );
    const refreshedSnapshot = kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)) as {
      models?: {
        prompt_cache?: { providers?: { scope?: unknown }[] };
      }[];
    };
    assert.equal(
      (refreshedSnapshot.models?.[0]?.prompt_cache?.providers?.[0]?.scope as { account_slots?: string } | undefined)?.account_slots,
      "account_scoped"
    );

    const evidence = kv.values.get(encodeKey(evidenceKey)) as {
      outcome?: string;
      cycles?: { samples?: { usage?: Record<string, unknown>; raw_usage?: Record<string, unknown> }[] }[];
    };
    assert.equal(evidence.outcome, "completed");
    assert.equal(evidence.cycles?.length, 3);
    const samples = evidence.cycles.flatMap((cycle) => cycle.samples ?? []);
    assert.equal(samples.length, 30);
    for (const sample of samples) {
      assert.deepEqual(sample.raw_usage, sample.usage);
      assert.deepEqual(Object.keys(sample.raw_usage ?? {}).sort(compareStrings), [
        "cache_write_tokens",
        "cached_tokens",
        "input_tokens",
        "output_tokens",
        "total_tokens",
      ]);
      assert.equal(
        Object.values(sample.raw_usage ?? {}).every((value) => typeof value === "number"),
        true
      );
    }
    const serializedEvidence = JSON.stringify(evidence);
    assert.equal(serializedEvidence.includes("account-one"), false);
    assert.equal(serializedEvidence.includes("uos-cache-scope-v5"), false);
    assert.equal(serializedEvidence.includes("cache-scope-cycle"), false);
    assert.equal(serializedEvidence.includes(requests[0]?.conversation ?? "missing-conversation"), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetProviderHealthThrottleForTest();
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("prompt-cache scope makes a sample with neither read nor write telemetry inconclusive", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = fetchInputUrl(input);
    if (url === "https://auth.openai.com/oauth/token") throw new Error("refresh must not run");
    inferenceCalls += 1;
    return Promise.resolve(sseCompleted(0, 0));
  });

  try {
    const result = await runExperiment();
    assert.equal(result.status, "inconclusive");
    assert.equal(result.inconclusive_reason, "invalid_cache_signal");
    assert.equal(inferenceCalls, 1);
    const snapshot = JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)));
    assert.equal(snapshot.includes('"scope"'), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("prompt-cache scope stops on an unexpected warm cache read", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = fetchInputUrl(input);
    if (url === "https://auth.openai.com/oauth/token") throw new Error("refresh must not run");
    inferenceCalls += 1;
    return Promise.resolve(sseCompleted(2_560, 0));
  });

  try {
    const result = await runExperiment();
    assert.equal(result.status, "inconclusive");
    assert.equal(result.inconclusive_reason, "invalid_cache_signal");
    assert.equal(inferenceCalls, 1);
    const snapshot = JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)));
    assert.equal(snapshot.includes('"scope"'), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("prompt-cache scope rejects sub-prefix, inconsistent, or impossible counter evidence before account-slot classification", () =>
  runSequence(async (step) => {
    for (const { name, cachedTokens, cacheWriteTokens } of [
      { name: "small write", cachedTokens: 0, cacheWriteTokens: 1 },
      { name: "small read beside a full write", cachedTokens: 1, cacheWriteTokens: 2_560 },
      { name: "inconsistent prefix-scale write", cachedTokens: 0, cacheWriteTokens: 2_048 },
      { name: "inconsistent prefix-scale read", cachedTokens: 2_048, cacheWriteTokens: 0 },
      { name: "write larger than input", cachedTokens: 0, cacheWriteTokens: 3_001 },
    ]) {
      await step(name, async () => {
        seed();
        const originalFetch = globalThis.fetch;
        let inferenceCalls = 0;
        globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
          const url = fetchInputUrl(input);
          if (url === "https://auth.openai.com/oauth/token") throw new Error("refresh must not run");
          const step = inferenceCalls++;
          if (step === 0) return Promise.resolve(sseCompleted(0, 2_560));
          if (step === 1) return Promise.resolve(sseCompleted(2_560, 2_560));
          if (step === 2) return Promise.resolve(sseCompleted(cachedTokens, cacheWriteTokens));
          throw new Error("scope experiment should stop on the discriminating account-slot sample");
        });

        try {
          const result = await runExperiment();
          assert.equal(result.status, "inconclusive");
          assert.equal(result.inconclusive_reason, "invalid_cache_signal");
          assert.equal(inferenceCalls, 3);
          const snapshot = JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)));
          assert.equal(snapshot.includes('"scope"'), false);
        } finally {
          globalThis.fetch = originalFetch;
          resetCodexAuthCacheForTest();
          resetRuntimeConfigCacheForTest();
        }
      });
    }
  }));

test("prompt-cache scope rejects mixed cache evidence on every discriminator sample", () =>
  runSequence(async (step) => {
    const expectedCachedTokens = [0, 2_560, 0, 2_560, 2_560, 2_560, 2_560, 2_560, 2_560, 2_560];
    const expectedCacheWriteTokens = [2_560, 2_560, 2_560, 0, 0, 0, 0, 0, 0, 0];
    for (const { name, index } of [
      { name: "account-slot first sample", index: 2 },
      { name: "post-refresh first sample", index: 5 },
      { name: "changed-conversation first sample", index: 7 },
    ]) {
      await step(name, async () => {
        seed();
        const originalFetch = globalThis.fetch;
        let inferenceCalls = 0;
        let refreshes = 0;
        globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
          const url = fetchInputUrl(input);
          if (url === "https://auth.openai.com/oauth/token") {
            refreshes += 1;
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  access_token: `access-refreshed-${refreshes}`,
                  refresh_token: `refresh-refreshed-${refreshes}`,
                }),
                { headers: { "Content-Type": "application/json" } }
              )
            );
          }
          const step = inferenceCalls++;
          if (step > index) throw new Error("scope experiment should stop at the mixed discriminator sample");
          return Promise.resolve(
            sseCompleted(step === index ? 2_560 : cycleValue(expectedCachedTokens, step), step === index ? 2_560 : cycleValue(expectedCacheWriteTokens, step))
          );
        });

        try {
          const result = await runExperiment();
          assert.equal(result.status, "inconclusive");
          assert.equal(result.inconclusive_reason, "invalid_cache_signal");
          assert.equal(inferenceCalls, index + 1);
          assert.equal(refreshes, index >= 5 ? 1 : 0);
          const snapshot = JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)));
          assert.equal(snapshot.includes('"scope"'), false);
        } finally {
          globalThis.fetch = originalFetch;
          resetCodexAuthCacheForTest();
          resetRuntimeConfigCacheForTest();
        }
      });
    }
  }));

test("a target-scoped cycle lease blocks a concurrent same-target invocation", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let releaseFirst = () => {};
  let markFirstDispatched = () => {};
  const firstDispatched = new Promise<void>((resolve) => (markFirstDispatched = resolve));
  const heldResponse = new Promise<Response>(
    (resolve) =>
      (releaseFirst = () => {
        resolve(sseCompleted(0, 0));
      })
  );
  let inferenceCalls = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = fetchInputUrl(input);
    if (url === "https://auth.openai.com/oauth/token") throw new Error("refresh must not run");
    inferenceCalls += 1;
    if (inferenceCalls === 1) {
      markFirstDispatched();
      return heldResponse;
    }
    return Promise.resolve(sseCompleted(0, 0));
  });
  let first: ReturnType<typeof runPromptCacheScopeExperiment> | null = null;
  try {
    first = runExperiment();
    await firstDispatched;
    await assert.rejects(() => runExperiment(), PromptCacheScopeExperimentBusyError);
    assert.equal(inferenceCalls, 1);

    releaseFirst();
    const firstResult = await first;
    assert.equal(firstResult.status, "inconclusive");
    assert.equal(firstResult.inconclusive_reason, "invalid_cache_signal");
  } finally {
    releaseFirst();
    await first?.catch(() => {});
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("a provider campaign lease blocks a sibling target between cycles and prevents OAuth interleaving", async () => {
  const modelA = "gpt-5.5-cache-scope-target-a";
  const modelB = "gpt-5.6-cache-scope-target-b";
  seed({ models: [modelB, modelA], defaultModel: modelB });
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  let refreshes = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://auth.openai.com/oauth/token") {
      refreshes += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `refresh-access-${refreshes}`, refresh_token: `refresh-token-${refreshes}` }), {
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    const body = JSON.parse(requestBodyText(init)) as { model?: unknown };
    if (typeof body.model !== "string") throw new Error("scope request lost its target model");
    const step = inferenceCalls++ % 10;
    const cachedTokens = cycleValue(CACHE_READ_CYCLE, step);
    const cacheWriteTokens = cycleValue(CACHE_WRITE_CYCLE_ALTERNATING, step);
    return Promise.resolve(sseCompleted(cachedTokens, cacheWriteTokens, body.model));
  });

  try {
    const firstA = await runExperiment(modelA);
    assert.equal(firstA.status, "in_progress");
    assert.equal(firstA.completed_cycles, 1);
    const aState = JSON.stringify(kv.values.get(encodeKey(stateKeyFor(modelA))));
    const aEvidence = JSON.stringify(kv.values.get(encodeKey(evidenceKeyFor(modelA))));

    await assert.rejects(() => runExperiment(modelB), PromptCacheScopeExperimentBusyError);
    assert.equal(inferenceCalls, 10);
    assert.equal(refreshes, 1);
    assert.equal(kv.values.has(encodeKey(stateKeyFor(modelB))), false);
    assert.equal(kv.values.has(encodeKey(evidenceKeyFor(modelB))), false);
    const stateAfterB = JSON.stringify(kv.values.get(encodeKey(stateKeyFor(modelA))));
    const evidenceAfterB = JSON.stringify(kv.values.get(encodeKey(evidenceKeyFor(modelA))));
    assert.equal(stateAfterB, aState);
    assert.equal(evidenceAfterB, aEvidence);

    const secondA = await runExperiment(modelA);
    assert.equal(secondA.status, "in_progress");
    assert.equal(secondA.completed_cycles, 2);
    assert.equal(inferenceCalls, 20);
    assert.equal(refreshes, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("a v4 campaign lease cannot block the v5 plain-key experiment", async () => {
  seed();
  const legacyCampaignKey: KvKey = [
    "uos_ai",
    "prompt_cache_scope_experiment",
    "v4",
    "campaign",
    "codex_chatgpt",
    "chatgpt_codex",
    "responses_implicit_input_text_keyed",
  ];
  kv.put(legacyCampaignKey, {
    owner: "legacy-owner",
    target_id: "legacy-target",
    inventory_fingerprint: "legacy-inventory",
    lease_until_ms: Date.now() + 60_000,
  });
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = fetchInputUrl(input);
    if (url === "https://auth.openai.com/oauth/token") throw new Error("refresh must not run");
    inferenceCalls += 1;
    return Promise.resolve(sseCompleted(0, 0));
  });

  try {
    const result = await runExperiment();
    assert.equal(result.status, "inconclusive");
    assert.equal(result.inconclusive_reason, "invalid_cache_signal");
    assert.equal(inferenceCalls, 1);
    assert.ok(kv.values.has(encodeKey(legacyCampaignKey)));
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("an expired target session clears its prior evidence before starting a fresh cycle", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  let refreshes = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://auth.openai.com/oauth/token") {
      refreshes += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: `expired-access-${refreshes}`,
            refresh_token: `expired-refresh-${refreshes}`,
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );
    }
    const step = inferenceCalls++ % 10;
    const cachedTokens = cycleValue(CACHE_READ_CYCLE, step);
    const cacheWriteTokens = cycleValue(CACHE_WRITE_CYCLE_ALTERNATING, step);
    return Promise.resolve(sseCompleted(cachedTokens, cacheWriteTokens));
  });

  try {
    assert.equal((await runExperiment()).status, "in_progress");
    const priorState = kv.values.get(encodeKey(stateKey)) as {
      campaign_owner: string;
      target: { id: string; inventory_fingerprint: string };
      [key: string]: unknown;
    };
    const priorEvidence = kv.values.get(encodeKey(evidenceKey)) as Record<string, unknown>;
    const staleStartedAtMs = Date.now() - 10_000;
    kv.put(stateKey, {
      ...priorState,
      started_at_ms: staleStartedAtMs,
      expires_at_ms: staleStartedAtMs + 1,
    });
    kv.put(evidenceKey, { ...priorEvidence, started_at_ms: staleStartedAtMs });
    kv.put(campaignLeaseKey, {
      owner: priorState.campaign_owner,
      target_id: priorState.target.id,
      inventory_fingerprint: priorState.target.inventory_fingerprint,
      lease_until_ms: staleStartedAtMs + 1,
    });

    const restarted = await runExperiment();
    assert.equal(restarted.status, "in_progress");
    assert.equal(restarted.completed_cycles, 1);
    assert.equal(inferenceCalls, 20);
    assert.equal(refreshes, 2);
    const freshState = kv.values.get(encodeKey(stateKey)) as { campaign_owner?: unknown; started_at_ms?: unknown };
    const freshEvidence = kv.values.get(encodeKey(evidenceKey)) as { started_at_ms?: unknown; cycles?: unknown[] };
    assert.notEqual(freshState.campaign_owner, priorState.campaign_owner);
    assert.notEqual(freshState.started_at_ms, staleStartedAtMs);
    assert.equal(freshEvidence.started_at_ms, freshState.started_at_ms);
    assert.equal(freshEvidence.cycles?.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("a same-account credential rotation during forced refresh is inconclusive auth-pool drift", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  let rotationApplied = false;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://auth.openai.com/oauth/token") {
      if (rotationApplied) throw new Error("the forced refresh must not retry after credential rotation");
      rotationApplied = true;
      const pool = kv.values.get(encodeKey(CODEX_AUTH_POOL_KV_KEY)) as
        | {
            accounts: ReturnType<typeof makeAuth>[];
            updated_at_ms: number;
          }
        | undefined;
      const first = pool?.accounts[0];
      const second = pool?.accounts[1];
      if (!pool || !first || !second) throw new Error("missing seeded Codex auth pool");
      kv.put(CODEX_AUTH_POOL_KV_KEY, {
        ...pool,
        accounts: [
          {
            ...first,
            access_token: "externally-rotated-access",
            refresh_token: "externally-rotated-refresh",
            updated_at_ms: Date.now(),
          },
          second,
        ],
        updated_at_ms: Date.now(),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "experiment-refresh-access", refresh_token: "experiment-refresh-refresh" }), {
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    const step = inferenceCalls++ % 10;
    const cachedTokens = cycleValue(CACHE_READ_CYCLE, step);
    const cacheWriteTokens = cycleValue(CACHE_WRITE_CYCLE_ALTERNATING, step);
    return Promise.resolve(sseCompleted(cachedTokens, cacheWriteTokens));
  });

  try {
    const result = await runExperiment();
    assert.equal(rotationApplied, true);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.inconclusive_reason, "auth_pool_drift");
    assert.equal(inferenceCalls, 5);
    assert.equal(JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY))).includes('"scope"'), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("malformed v3 target state or evidence fails closed before any outbound work", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    throw new Error("malformed durable data must fail closed before upstream work");
  });

  try {
    for (const kind of ["state", "evidence"] as const) {
      seed();
      const baseline = await scopeBaselineFor();
      const key = kind === "state" ? stateKey : evidenceKey;
      const malformed =
        kind === "state"
          ? { v: 3, target: baseline.target, next_cycle: 2 }
          : {
              v: 3,
              target: baseline.target,
              outcome: "completed",
              started_at_ms: Date.now(),
              verified_at_ms: Date.now(),
              cycles: [],
            };
      kv.put(key, malformed);
      const persisted = JSON.stringify(kv.values.get(encodeKey(key)));

      const response = await handleAdminCodexCacheScopeExperiment(
        new Request("https://ai.ubq.fi/admin/providers/codex/cache-scope-experiment", { method: "POST" })
      );
      assert.equal(response.status, 503, kind);
      const body = (await response.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "prompt_cache_scope_experiment_unavailable", kind);
      await assert.rejects(() => runPromptCacheScopeExperiment(baseline), PromptCacheScopeExperimentUnavailableError, kind);
      assert.equal(JSON.stringify(kv.values.get(encodeKey(key))), persisted, kind);
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("semantically malformed v3 timestamps fail closed before any outbound work", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    throw new Error("semantically malformed durable timestamps must fail closed before upstream work");
  });

  try {
    for (const kind of ["future_state", "inverted_evidence", "future_evidence"] as const) {
      seed();
      const baseline = await scopeBaselineFor();
      const now = Date.now();
      const owner = `timestamp-owner-${kind}`;
      const key = kind === "future_state" ? stateKey : evidenceKey;
      const malformed =
        kind === "future_state"
          ? {
              v: 3,
              target: baseline.target,
              campaign_owner: owner,
              started_at_ms: now + 60_000,
              expires_at_ms: now + 120_000,
              auth_pool_versionstamp: baseline.target.auth_pool_versionstamp,
              next_cycle: 1,
              classifications: [],
            }
          : {
              v: 3,
              target: baseline.target,
              outcome: "failed",
              started_at_ms: kind === "inverted_evidence" ? now : now + 60_000,
              verified_at_ms: kind === "inverted_evidence" ? now - 1 : now + 120_000,
              cycles: [],
            };
      kv.put(key, malformed);
      if (kind === "future_state") {
        kv.put(campaignLeaseKey, {
          owner,
          target_id: baseline.target.id,
          inventory_fingerprint: baseline.target.inventory_fingerprint,
          lease_until_ms: now + 120_000,
        });
      }
      const persisted = JSON.stringify(kv.values.get(encodeKey(key)));

      await assert.rejects(
        () =>
          assertPromptCacheScopeExperimentTelemetryBaseline({
            kv: kv as unknown as Kv,
            release: TELEMETRY_RELEASE,
          }),
        PromptCacheScopeExperimentUnavailableError,
        kind
      );
      await assert.rejects(() => runPromptCacheScopeExperiment(baseline), PromptCacheScopeExperimentUnavailableError, kind);
      assert.equal(JSON.stringify(kv.values.get(encodeKey(key))), persisted, kind);
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("semantically inconsistent ready-to-promote state cannot publish a scope", async () => {
  seed();
  const baseline = await scopeBaselineFor();
  const startedAtMs = Date.now();
  const observation = {
    probe_profile: "responses_implicit_input_text_keyed_cycle_isolated_v5",
    account_slots: "account_scoped",
    token_refresh: "preserved",
    conversation_id: "independent",
    effective_model: MODEL,
  } as const;
  const disagreeingObservation = { ...observation, account_slots: "shared" as const };
  const owner = "inconsistent-ready-owner";
  kv.put(stateKey, {
    v: 3,
    target: baseline.target,
    campaign_owner: owner,
    started_at_ms: startedAtMs,
    expires_at_ms: startedAtMs + 60_000,
    auth_pool_versionstamp: baseline.target.auth_pool_versionstamp,
    next_cycle: 4,
    classifications: [observation, disagreeingObservation, observation],
    pending_scope: observation,
  });
  kv.put(campaignLeaseKey, {
    owner,
    target_id: baseline.target.id,
    inventory_fingerprint: baseline.target.inventory_fingerprint,
    lease_until_ms: startedAtMs + 60_000,
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    throw new Error("a malformed ready state must not dispatch or refresh");
  });

  try {
    await assert.rejects(() => runPromptCacheScopeExperiment(baseline), PromptCacheScopeExperimentUnavailableError);
    assert.equal(fetchCalls, 0);
    assert.equal(JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY))).includes('"scope"'), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("a completed target advances the bodyless campaign to the next exact model", async () => {
  const modelA = "gpt-5.5-cache-scope-completed-a";
  const modelB = "gpt-5.6-cache-scope-pending-b";
  seed({ models: [modelB, modelA], defaultModel: modelB });
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  let refreshes = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://auth.openai.com/oauth/token") {
      refreshes += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: `progress-access-${refreshes}`,
            refresh_token: `progress-refresh-${refreshes}`,
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );
    }
    const body = JSON.parse(requestBodyText(init)) as { model?: unknown };
    if (typeof body.model !== "string") throw new Error("scope request lost its target model");
    const step = inferenceCalls++ % 10;
    const cachedTokens = cycleValue(CACHE_READ_CYCLE, step);
    const cacheWriteTokens = cycleValue(CACHE_WRITE_CYCLE_ALTERNATING, step);
    return Promise.resolve(sseCompleted(cachedTokens, cacheWriteTokens, body.model));
  });

  try {
    assert.equal((await runExperiment(modelA)).status, "in_progress");
    assert.equal((await runExperiment(modelA)).status, "in_progress");
    const completed = await runExperiment(modelA);
    assert.equal(completed.status, "completed");
    assert.equal(inferenceCalls, 30);
    assert.equal(refreshes, 3);
    const aEvidence = kv.values.get(encodeKey(evidenceKeyFor(modelA))) as { outcome?: unknown };
    assert.equal(aEvidence.outcome, "completed");

    await seedStage0Baseline(modelB);
    const nextBaseline = await assertPromptCacheScopeExperimentTelemetryBaseline({
      kv: kv as unknown as Kv,
      release: TELEMETRY_RELEASE,
    });
    assert.equal(nextBaseline.target.model, modelB);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("an inconclusive target is retried before the campaign advances to another model", async () => {
  const modelA = "gpt-5.5-cache-scope-retry-a";
  const modelB = "gpt-5.6-cache-scope-pending-b";
  seed({ models: [modelB, modelA], defaultModel: modelB });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = fetchInputUrl(input);
    if (url === "https://auth.openai.com/oauth/token") throw new Error("refresh must not run");
    return Promise.resolve(sseCompleted(0, 0, modelA));
  });

  try {
    const inconclusive = await runExperiment(modelA);
    assert.equal(inconclusive.status, "inconclusive");
    assert.equal(inconclusive.inconclusive_reason, "invalid_cache_signal");

    await seedStage0Baseline(modelA);
    await seedStage0Baseline(modelB);
    const retryBaseline = await assertPromptCacheScopeExperimentTelemetryBaseline({
      kv: kv as unknown as Kv,
      release: TELEMETRY_RELEASE,
    });
    assert.equal(retryBaseline.target.model, modelA);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("completed evidence survives token rotation but is reprobeable after an account-pool membership change", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  let refreshes = 0;
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://auth.openai.com/oauth/token") {
      refreshes += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: `identity-refresh-access-${refreshes}`,
            refresh_token: `identity-refresh-token-${refreshes}`,
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );
    }
    const step = inferenceCalls++ % 10;
    const cachedTokens = cycleValue(CACHE_READ_CYCLE, step);
    const cacheWriteTokens = cycleValue(CACHE_WRITE_CYCLE_ALTERNATING, step);
    return Promise.resolve(sseCompleted(cachedTokens, cacheWriteTokens));
  });

  try {
    assert.equal((await runExperiment()).status, "in_progress");
    assert.equal((await runExperiment()).status, "in_progress");
    assert.equal((await runExperiment()).status, "completed");
    assert.equal(inferenceCalls, 30);

    const tokenOnlyPool = kv.values.get(encodeKey(CODEX_AUTH_POOL_KV_KEY)) as
      | {
          accounts: ReturnType<typeof makeAuth>[];
          updated_at_ms: number;
        }
      | undefined;
    const tokenOnlyFirst = tokenOnlyPool?.accounts[0];
    if (!tokenOnlyPool || !tokenOnlyFirst) throw new Error("missing seeded Codex auth pool");
    kv.put(CODEX_AUTH_POOL_KV_KEY, {
      ...tokenOnlyPool,
      accounts: [
        {
          ...tokenOnlyFirst,
          access_token: "token-only-rotation-access",
          refresh_token: "token-only-rotation-refresh",
          updated_at_ms: Date.now(),
        },
        ...tokenOnlyPool.accounts.slice(1),
      ],
      updated_at_ms: Date.now(),
    });
    const tokenOnlyBaseline = await scopeBaselineFor();
    const completedEvidence = kv.values.get(encodeKey(evidenceKey)) as
      | {
          target?: { auth_pool_identity_fingerprint?: unknown };
        }
      | undefined;
    assert.equal(completedEvidence?.target?.auth_pool_identity_fingerprint, tokenOnlyBaseline.target.auth_pool_identity_fingerprint);
    await seedStage0Baseline(MODEL);
    await assert.rejects(
      () =>
        assertPromptCacheScopeExperimentTelemetryBaseline({
          kv: kv as unknown as Kv,
          release: TELEMETRY_RELEASE,
        }),
      PromptCacheScopeExperimentUnavailableError
    );
    assert.equal(inferenceCalls, 30);

    const membershipChangedPool = kv.values.get(encodeKey(CODEX_AUTH_POOL_KV_KEY)) as
      | {
          accounts: ReturnType<typeof makeAuth>[];
          updated_at_ms: number;
        }
      | undefined;
    const membershipFirst = membershipChangedPool?.accounts[0];
    if (!membershipChangedPool || !membershipFirst) throw new Error("missing Codex auth pool after token rotation");
    kv.put(CODEX_AUTH_POOL_KV_KEY, {
      ...membershipChangedPool,
      accounts: [
        {
          ...membershipFirst,
          account_id: "replacement-account-id",
          access_token: "membership-change-access",
          refresh_token: "membership-change-refresh",
          updated_at_ms: Date.now(),
        },
        ...membershipChangedPool.accounts.slice(1),
      ],
      updated_at_ms: Date.now(),
    });
    const membershipBaseline = await assertPromptCacheScopeExperimentTelemetryBaseline({
      kv: kv as unknown as Kv,
      release: TELEMETRY_RELEASE,
    });
    assert.notEqual(membershipBaseline.target.auth_pool_identity_fingerprint, tokenOnlyBaseline.target.auth_pool_identity_fingerprint);
    assert.equal((await runPromptCacheScopeExperiment(membershipBaseline)).status, "in_progress");
    assert.equal(inferenceCalls, 40);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("prompt-cache scope admin trigger rejects request fields before any outbound work", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createFetchMock(() => {
    throw new Error("request fields must be rejected before dispatch");
  });
  try {
    const response = await handleAdminCodexCacheScopeExperiment(
      new Request("https://ai.ubq.fi/admin/providers/codex/cache-scope-experiment", {
        method: "POST",
        body: JSON.stringify({ model: "forbidden", cache_affinity: "forbidden" }),
      })
    );
    assert.equal(response.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prompt-cache scope admin trigger requires a current-release Stage 0 baseline before any outbound work", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    throw new Error("the Stage 0 gate must run before any upstream work");
  });
  try {
    const response = await handleAdminCodexCacheScopeExperiment(
      new Request("https://ai.ubq.fi/admin/providers/codex/cache-scope-experiment", { method: "POST" })
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    assert.equal(body.error?.code, "prompt_cache_scope_experiment_unavailable");
    assert.match(body.error.message ?? "", /Stage 0 telemetry baseline/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("prompt-cache scope Stage 0 baseline uses the Codex telemetry provider identity", async () => {
  seed();
  const counterKeys = await resolvePromptCacheTelemetryCounterKeys({ provider: "chatgpt_codex", model: MODEL }, { release: TELEMETRY_RELEASE });
  assert.ok(counterKeys);
  for (const route of counterKeys.routes) {
    kv.put(route.completed, new KvU64(5_000n));
    kv.put(route.reported, new KvU64(5_000n));
    kv.put(route.cache_write_reported, new KvU64(5_000n));
  }

  await assert.doesNotReject(() =>
    assertPromptCacheScopeExperimentTelemetryBaseline({
      kv: kv as unknown as Kv,
      release: TELEMETRY_RELEASE,
    })
  );
});

test("prompt-cache scope Stage 0 baseline rejects reported usage without cache-write fields before any scope traffic", async () => {
  seed();
  const counterKeys = await resolvePromptCacheTelemetryCounterKeys({ provider: "chatgpt_codex", model: MODEL }, { release: TELEMETRY_RELEASE });
  assert.ok(counterKeys);
  for (const route of counterKeys.routes) {
    kv.put(route.completed, new KvU64(5_000n));
    kv.put(route.reported, new KvU64(5_000n));
  }
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    throw new Error("incomplete Stage 0 telemetry must block scope traffic");
  });

  try {
    await assert.rejects(
      () =>
        assertPromptCacheScopeExperimentTelemetryBaseline({
          kv: kv as unknown as Kv,
          release: TELEMETRY_RELEASE,
        }),
      PromptCacheScopeExperimentUnavailableError
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("prompt-cache scope Stage 0 baseline requires Responses telemetry for its paid transport", async () => {
  seed();
  const counterKeys = await resolvePromptCacheTelemetryCounterKeys({ provider: "chatgpt_codex", model: MODEL }, { release: TELEMETRY_RELEASE });
  assert.ok(counterKeys);
  const chat = counterKeys.routes.find((route) => route.route === "chat.completions");
  assert.ok(chat);
  kv.put(chat.completed, new KvU64(10_000n));
  kv.put(chat.reported, new KvU64(10_000n));
  kv.put(chat.cache_write_reported, new KvU64(10_000n));

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    throw new Error("Chat-only telemetry must not unlock paid Responses scope traffic");
  });

  try {
    await assert.rejects(
      () =>
        assertPromptCacheScopeExperimentTelemetryBaseline({
          kv: kv as unknown as Kv,
          release: TELEMETRY_RELEASE,
        }),
      PromptCacheScopeExperimentUnavailableError
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("a catalog roster change after the Stage 0 gate stops before paid scope traffic", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    throw new Error("a stale Stage 0 binding must fail before any outbound work");
  });

  try {
    const counterKeys = await resolvePromptCacheTelemetryCounterKeys({ provider: "chatgpt_codex", model: MODEL }, { release: TELEMETRY_RELEASE });
    assert.ok(counterKeys);
    for (const route of counterKeys.routes) {
      kv.put(route.completed, new KvU64(5_000n));
      kv.put(route.reported, new KvU64(5_000n));
      kv.put(route.cache_write_reported, new KvU64(5_000n));
    }
    const baseline = await assertPromptCacheScopeExperimentTelemetryBaseline({
      kv: kv as unknown as Kv,
      release: TELEMETRY_RELEASE,
    });

    const alternateModel = `${MODEL}-alternate-after-gate`;
    const snapshot = kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)) as {
      source: string;
      client_version: string;
      updated_at_ms: number;
      models: Record<string, unknown>[];
    };
    const snapshotWithAlternate = {
      ...snapshot,
      models: [...snapshot.models, modelRecord(alternateModel)],
    };
    kv.put(CODEX_MODELS_KV_KEY, snapshotWithAlternate);

    await assert.rejects(() => runPromptCacheScopeExperiment(baseline), PromptCacheScopeExperimentUnavailableError);
    assert.equal(fetchCalls, 0);
    assert.equal(kv.values.has(encodeKey(stateKey)), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("a runtime default-only switch preserves a selected non-default target", async () => {
  const targetModel = "gpt-5.5-cache-scope-non-default";
  const firstDefault = "gpt-5.7-cache-scope-default-one";
  const secondDefault = "gpt-5.8-cache-scope-default-two";
  seed({ models: [targetModel, firstDefault, secondDefault], defaultModel: firstDefault });
  await seedStage0Baseline(targetModel);
  const baseline = await assertPromptCacheScopeExperimentTelemetryBaseline({
    kv: kv as unknown as Kv,
    release: TELEMETRY_RELEASE,
  });
  assert.equal(baseline.target.model, targetModel);

  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  let refreshes = 0;
  const requestedModels: string[] = [];
  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://auth.openai.com/oauth/token") {
      refreshes += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: `refreshed-access-${refreshes}`,
            refresh_token: `refreshed-refresh-${refreshes}`,
          }),
          { headers: { "Content-Type": "application/json" } }
        )
      );
    }
    const body = JSON.parse(requestBodyText(init)) as { model?: unknown };
    if (typeof body.model !== "string") throw new Error("scope request did not preserve the selected model");
    requestedModels.push(body.model);
    const step = inferenceCalls++;
    if (step === 0) {
      const runtime = kv.values.get(encodeKey(RUNTIME_CONFIG_V2_KEY)) as {
        version: number;
        default_model: string;
        default_reasoning_effort: string;
        codex_models: unknown;
        updated_at_ms: number;
      };
      kv.put(RUNTIME_CONFIG_V2_KEY, { ...runtime, default_model: secondDefault, updated_at_ms: Date.now() });
    }
    const cachedTokens = cycleValue(CACHE_READ_CYCLE, step);
    const cacheWriteTokens = cycleValue(CACHE_WRITE_CYCLE_ALTERNATING, step);
    return Promise.resolve(sseCompleted(cachedTokens, cacheWriteTokens, body.model));
  });

  try {
    const result = await runPromptCacheScopeExperiment(baseline);
    assert.equal(result.status, "in_progress");
    assert.equal(result.model, targetModel);
    assert.equal(inferenceCalls, 10);
    assert.equal(refreshes, 1);
    assert.deepEqual(requestedModels, Array(10).fill(targetModel));
    const runtime = kv.values.get(encodeKey(RUNTIME_CONFIG_V2_KEY)) as { default_model?: unknown };
    assert.equal(runtime.default_model, secondDefault);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("a catalog roster drift during a scope cycle stops before the next paid sample", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;

  const snapshot = kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)) as {
    source: string;
    client_version: string;
    updated_at_ms: number;
    models: Record<string, unknown>[];
  };
  const alternateModel = `${MODEL}-alternate-during-cycle`;
  const snapshotWithAlternate = {
    ...snapshot,
    models: [
      ...snapshot.models,
      {
        slug: alternateModel,
        supported_reasoning_levels: ["none"],
        prompt_cache: { version: 1, providers: [{ id: "codex_chatgpt", controls: cacheControls }] },
      },
    ],
  };
  const runtime = kv.values.get(encodeKey(RUNTIME_CONFIG_V2_KEY)) as {
    version: number;
    default_model: string;
    default_reasoning_effort: string;
    codex_models: unknown;
    updated_at_ms: number;
  };

  globalThis.fetch = createFetchMock((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://auth.openai.com/oauth/token") {
      throw new Error("a model change after sample one must stop before credential refresh");
    }
    inferenceCalls += 1;
    if (inferenceCalls === 1) {
      kv.put(CODEX_MODELS_KV_KEY, snapshotWithAlternate);
      kv.put(RUNTIME_CONFIG_V2_KEY, { ...runtime, updated_at_ms: Date.now() });
    }
    return Promise.resolve(sseCompleted(0, 2_560));
  });

  try {
    const result = await runExperiment();
    assert.equal(result.status, "inconclusive");
    assert.equal(result.inconclusive_reason, "inventory_drift");
    assert.equal(inferenceCalls, 1);
    assert.equal(JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY))).includes('"scope"'), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});

test("a target capability drift stops before the next paid sample", async () => {
  seed();
  const originalFetch = globalThis.fetch;
  let inferenceCalls = 0;
  const snapshot = kv.values.get(encodeKey(CODEX_MODELS_KV_KEY)) as {
    source: string;
    client_version: string;
    updated_at_ms: number;
    models: Record<string, unknown>[];
  };
  globalThis.fetch = createFetchMock((input: RequestInfo | URL) => {
    const url = fetchInputUrl(input);
    if (url === "https://auth.openai.com/oauth/token") {
      throw new Error("capability drift must stop before credential refresh");
    }
    inferenceCalls += 1;
    if (inferenceCalls === 1) {
      kv.put(CODEX_MODELS_KV_KEY, {
        ...snapshot,
        models: [modelRecord(MODEL, { ...cacheControls, expected_usage_fields: ["cached_tokens"] })],
        updated_at_ms: Date.now(),
      });
    }
    return Promise.resolve(sseCompleted(0, 2_560));
  });

  try {
    const result = await runExperiment();
    assert.equal(result.status, "inconclusive");
    assert.equal(result.inconclusive_reason, "target_catalog_drift");
    assert.equal(inferenceCalls, 1);
    assert.equal(JSON.stringify(kv.values.get(encodeKey(CODEX_MODELS_KV_KEY))).includes('"scope"'), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetCodexAuthCacheForTest();
    resetRuntimeConfigCacheForTest();
  }
});
