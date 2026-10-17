import { KvU64 } from "#kv";
import type { Kv, KvEntry, KvKey, KvListIterator, KvListOptions, KvListSelector } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  PROMPT_CACHE_ANALYTICS_BUCKET_MS,
  PROMPT_CACHE_ANALYTICS_DIMENSIONS,
  PROMPT_CACHE_ANALYTICS_KV_PREFIX,
  PROMPT_CACHE_ANALYTICS_MAX_COHORTS_PER_BUCKET,
  PROMPT_CACHE_ANALYTICS_MAX_RESPONSE_BUCKETS,
  PROMPT_CACHE_ANALYTICS_RETENTION_MS,
  PROMPT_CACHE_ANALYTICS_WINDOW_BUCKETS,
  type PromptCacheAnalyticsBucket,
  promptCacheAnalyticsCounterKey,
  PromptCacheAnalyticsQueryError,
  prunePromptCacheAnalytics,
  readPromptCacheAnalytics,
  recordPromptCacheAnalytics,
} from "../src/cache/prompt-analytics.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const RELEASE = "0123456789abcdef0123456789abcdef01234567";
const NOW_MS = 1_800_000_000_000;
const LEGACY_V1_PREFIX = ["uos_ai", "prompt_cache_analytics", "v1"] as const;
const V2_PRUNABLE_NAMESPACES = ["all", "dimension", "overflow", "meta"] as const;

class ListSelectorCountingKv extends CountingKv {
  readonly listSelectors: KvListSelector[] = [];
  readonly listedKeys: KvKey[] = [];

  override list<T = unknown>(selector: KvListSelector, options?: KvListOptions): KvListIterator<T> {
    this.listSelectors.push(structuredClone(selector));
    const source = super.list<T>(selector, options);
    const prefix = "prefix" in selector ? selector.prefix : [];
    const endBucket = "end" in selector ? selector.end[prefix.length] : null;
    const listedKeys = this.listedKeys;
    const iterator = (async function* (): AsyncGenerator<KvEntry<T>> {
      for await (const entry of source) {
        const bucket = entry.key[prefix.length];
        if (typeof endBucket === "number" && typeof bucket === "number" && bucket >= endBucket) continue;
        listedKeys.push(structuredClone(entry.key));
        yield entry;
      }
    })() as unknown as KvListIterator<T>;
    Object.defineProperty(iterator, "cursor", { get: () => source.cursor });
    return iterator;
  }
}

const event = (overrides: Partial<Parameters<typeof recordPromptCacheAnalytics>[0]> = {}) => ({
  provider: "chatgpt_codex",
  model: "gpt-cache-visible-only-as-a-hash",
  route: "responses",
  status: 200,
  completed: true,
  usageTelemetryStatus: "reported",
  inputTokens: 100,
  cachedInputTokens: 25,
  cacheWriteInputTokens: 10,
  promptCacheKeyPresent: true,
  promptCacheMode: "explicit",
  fallbackReason: null,
  ...overrides,
});

const options = (kv: CountingKv, now = NOW_MS) => ({
  kv: kv as unknown as Kv,
  release: RELEASE,
  now: () => now,
});

const groupedCounters = (bucket: PromptCacheAnalyticsBucket) => ({
  input: bucket.input_tokens,
  cached: bucket.cached_input_tokens,
  write: bucket.cache_write_input_tokens,
  writeSamples: bucket.cache_write_reported_sample_count,
  samples: bucket.sample_count,
  hits: bucket.request_cache_hit_sample_count,
  reported: bucket.usage_reported_sample_count,
});

test("prompt-cache analytics v2 aggregates safe cohorts and keeps model and key material opaque", async () => {
  const kv = new CountingKv();
  const rawModel = "gpt-cache-secret-model";
  const rawKey = "prompt-cache-secret-key";
  const recorded = await Promise.all([
    recordPromptCacheAnalytics(event({ model: rawModel, promptCacheKeyPresent: true }), options(kv)),
    recordPromptCacheAnalytics(
      event({
        model: "gpt-cache-second-model",
        route: "chat.completions",
        inputTokens: 300,
        cachedInputTokens: 0,
        cacheWriteInputTokens: null,
        promptCacheKeyPresent: false,
        promptCacheMode: "implicit",
        fallbackReason: "primary_429",
      }),
      options(kv)
    ),
    recordPromptCacheAnalytics(
      event({
        provider: "metered",
        model: "gpt-cache-metered-model",
        inputTokens: 200,
        cachedInputTokens: 100,
        cacheWriteInputTokens: 50,
        promptCacheKeyPresent: true,
        promptCacheMode: "legacy_retention",
      }),
      options(kv)
    ),
  ]);
  assert.deepEqual(
    recorded.map((result) => result.status),
    ["recorded", "recorded", "recorded"]
  );

  const aggregate = await readPromptCacheAnalytics(options(kv));
  assert.equal(aggregate.status, "ready");
  assert.deepEqual(aggregate.group_by, []);
  assert.deepEqual(aggregate.buckets, [
    {
      bucket_start_at_ms: NOW_MS,
      bucket_end_at_ms: NOW_MS + PROMPT_CACHE_ANALYTICS_BUCKET_MS,
      input_tokens: 600,
      cached_input_tokens: 125,
      cache_write_input_tokens: 60,
      cache_write_reported_sample_count: 2,
      cached_percentage: 20.8333,
      sample_count: 3,
    },
  ]);

  const byProvider = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["provider"] });
  assert.equal(byProvider.status, "ready");
  assert.equal(byProvider.cardinality_limited, false);
  assert.deepEqual(
    byProvider.buckets.map((bucket) => ({
      provider: bucket.group?.provider,
      input: bucket.input_tokens,
      cached: bucket.cached_input_tokens,
      token: bucket.token_hit_percentage,
      request: bucket.request_hit_percentage,
      coverage: bucket.usage_telemetry_coverage_percentage,
      cacheReadsPerWrite: bucket.cache_reads_per_write,
    })),
    [
      {
        provider: "chatgpt_codex",
        input: 400,
        cached: 25,
        token: 6.25,
        request: 50,
        coverage: 100,
        cacheReadsPerWrite: 2.5,
      },
      {
        provider: "metered",
        input: 200,
        cached: 100,
        token: 50,
        request: 100,
        coverage: 100,
        cacheReadsPerWrite: 2,
      },
    ]
  );

  const byKeyAndRoute = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["key_presence", "route"] });
  assert.deepEqual(
    byKeyAndRoute.buckets.map((bucket) => bucket.group),
    [
      { prompt_cache_key_present: false, route: "chat.completions" },
      { prompt_cache_key_present: true, route: "responses" },
    ]
  );

  const byKeyPresence = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["key_presence"] });
  assert.deepEqual(
    byKeyPresence.buckets.map((bucket) => ({
      keyed: bucket.group?.prompt_cache_key_present,
      ...groupedCounters(bucket),
    })),
    [
      { keyed: false, input: 300, cached: 0, write: null, writeSamples: 0, samples: 1, hits: 0, reported: 1 },
      { keyed: true, input: 300, cached: 125, write: 60, writeSamples: 2, samples: 2, hits: 2, reported: 2 },
    ]
  );

  const persisted = [...kv.entries.values()].map((entry) => JSON.stringify(entry.key)).join("\n");
  assert.doesNotMatch(persisted, new RegExp(rawModel));
  assert.doesNotMatch(persisted, new RegExp(rawKey));
  assert.ok(byProvider.buckets.every((bucket) => !JSON.stringify(bucket).includes(rawModel)));
});

test("prompt-cache analytics groups and aggregates model, route, mode, and fallback cohorts", async () => {
  const kv = new CountingKv();
  const models = ["gpt-dimension-shared", "gpt-dimension-route", "gpt-dimension-mode", "gpt-dimension-fallback"];
  for (const input of [
    event({
      model: models[0],
      route: "responses",
      promptCacheKeyPresent: true,
      promptCacheMode: "explicit",
      fallbackReason: null,
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 5,
    }),
    event({
      model: models[0],
      route: "chat.completions",
      promptCacheKeyPresent: false,
      promptCacheMode: "implicit",
      fallbackReason: "primary_429",
      inputTokens: 200,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
    }),
    event({
      model: models[1],
      route: "responses",
      promptCacheKeyPresent: false,
      promptCacheMode: "implicit",
      fallbackReason: "primary_429",
      inputTokens: 300,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 15,
    }),
    event({
      model: models[2],
      route: "chat.completions",
      promptCacheKeyPresent: true,
      promptCacheMode: "explicit",
      fallbackReason: "primary_429",
      inputTokens: 400,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 20,
    }),
    event({
      model: models[3],
      route: "responses",
      promptCacheKeyPresent: false,
      promptCacheMode: "explicit",
      fallbackReason: null,
      inputTokens: 500,
      cachedInputTokens: 50,
      cacheWriteInputTokens: 25,
    }),
  ]) {
    assert.equal((await recordPromptCacheAnalytics(input, options(kv))).status, "recorded");
  }

  const byModel = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["model"] });
  const modelRows = byModel.buckets
    .map((bucket) => ({
      modelHash: bucket.group?.model_hash,
      ...groupedCounters(bucket),
    }))
    .sort((left, right) => left.samples - right.samples || (left.input ?? -1) - (right.input ?? -1));
  assert.equal(modelRows.length, 4);
  assert.ok(modelRows.every((row) => typeof row.modelHash === "string" && /^[a-f0-9]{64}$/.test(row.modelHash)));
  assert.equal(new Set(modelRows.map((row) => row.modelHash)).size, 4);
  assert.deepEqual(
    modelRows.map(({ modelHash: _modelHash, ...counters }) => counters),
    [
      { input: 300, cached: 30, write: 15, writeSamples: 1, samples: 1, hits: 1, reported: 1 },
      { input: 400, cached: 40, write: 20, writeSamples: 1, samples: 1, hits: 1, reported: 1 },
      { input: 500, cached: 50, write: 25, writeSamples: 1, samples: 1, hits: 1, reported: 1 },
      { input: 300, cached: 30, write: 15, writeSamples: 2, samples: 2, hits: 2, reported: 2 },
    ]
  );
  assert.ok(models.every((model) => !JSON.stringify(byModel.buckets).includes(model)));

  const byRoute = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["route"] });
  assert.deepEqual(
    byRoute.buckets
      .map((bucket) => ({ route: bucket.group?.route, ...groupedCounters(bucket) }))
      .sort((left, right) => String(left.route).localeCompare(String(right.route))),
    [
      {
        route: "chat.completions",
        input: 600,
        cached: 60,
        write: 30,
        writeSamples: 2,
        samples: 2,
        hits: 2,
        reported: 2,
      },
      { route: "responses", input: 900, cached: 90, write: 45, writeSamples: 3, samples: 3, hits: 3, reported: 3 },
    ]
  );

  const byMode = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["mode"] });
  assert.deepEqual(
    byMode.buckets
      .map((bucket) => ({ mode: bucket.group?.mode, ...groupedCounters(bucket) }))
      .sort((left, right) => String(left.mode).localeCompare(String(right.mode))),
    [
      { mode: "explicit", input: 1_000, cached: 100, write: 50, writeSamples: 3, samples: 3, hits: 3, reported: 3 },
      { mode: "implicit", input: 500, cached: 50, write: 25, writeSamples: 2, samples: 2, hits: 2, reported: 2 },
    ]
  );

  const byFallback = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["fallback"] });
  assert.deepEqual(
    byFallback.buckets
      .map((bucket) => ({ fallback: bucket.group?.fallback, ...groupedCounters(bucket) }))
      .sort((left, right) => String(left.fallback).localeCompare(String(right.fallback))),
    [
      { fallback: "none", input: 600, cached: 60, write: 30, writeSamples: 2, samples: 2, hits: 2, reported: 2 },
      { fallback: "primary_429", input: 900, cached: 90, write: 45, writeSamples: 3, samples: 3, hits: 3, reported: 3 },
    ]
  );
});

test("prompt-cache analytics distinguishes reported zeroes from missing and invalid telemetry", async () => {
  const kv = new CountingKv();
  await recordPromptCacheAnalytics(event({ usageTelemetryStatus: "partial", inputTokens: null, cachedInputTokens: null }), options(kv));
  await recordPromptCacheAnalytics(event({ inputTokens: 10, cachedInputTokens: 11 }), options(kv));
  await recordPromptCacheAnalytics(event({ inputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0 }), options(kv));

  const view = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["key_presence"] });
  const bucket = view.buckets[0];
  assert.ok(bucket, "key_presence grouping must produce a bucket");
  assert.deepEqual(
    {
      input: bucket.input_tokens,
      cached: bucket.cached_input_tokens,
      samples: bucket.sample_count,
      reported: bucket.usage_reported_sample_count,
      invalid: bucket.usage_invalid_sample_count,
      missing: bucket.usage_missing_sample_count,
      token: bucket.token_hit_percentage,
      request: bucket.request_hit_percentage,
      coverage: bucket.usage_telemetry_coverage_percentage,
      write: bucket.cache_write_input_tokens,
      writeSamples: bucket.cache_write_reported_sample_count,
    },
    {
      input: 20,
      cached: 0,
      samples: 3,
      reported: 1,
      invalid: 1,
      missing: 1,
      token: 0,
      request: 0,
      coverage: 33.3333,
      write: 0,
      writeSamples: 1,
    }
  );
});

test("prompt-cache analytics preserves concurrent counters and admits its first grouped cohort", async () => {
  const kv = new CountingKv();
  const results = await Promise.all(Array.from({ length: 100 }, () => recordPromptCacheAnalytics(event(), options(kv))));
  assert.ok(results.every((result) => result.status === "recorded"));

  const grouped = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["provider"] });
  assert.equal(grouped.buckets.length, 1);
  assert.deepEqual(
    grouped.buckets[0] && {
      provider: grouped.buckets[0].group?.provider,
      input: grouped.buckets[0].input_tokens,
      cached: grouped.buckets[0].cached_input_tokens,
      samples: grouped.buckets[0].sample_count,
      hits: grouped.buckets[0].request_cache_hit_sample_count,
    },
    {
      provider: "chatgpt_codex",
      input: 10_000,
      cached: 2_500,
      samples: 100,
      hits: 100,
    }
  );
});

test("prompt-cache analytics preserves concurrent samples across new-cohort admission conflicts", async () => {
  const kv = new CountingKv();
  const modes = ["implicit", "explicit", "legacy_retention"] as const;
  const cohorts = Array.from({ length: 12 }, (_, index) =>
    event({
      model: null,
      route: index % 2 === 0 ? "responses" : "chat.completions",
      promptCacheKeyPresent: Math.floor(index / 2) % 2 === 0,
      promptCacheMode: modes[Math.floor(index / 4)],
    })
  );

  const results = await Promise.all(cohorts.map((cohort) => recordPromptCacheAnalytics(cohort, options(kv))));
  assert.ok(kv.commands.some((command) => command.command === "atomic.commit" && command.atomicResult === "conflict"));
  assert.ok(results.every((result) => result.status === "recorded" && result.reason === "recorded"));

  const aggregate = await readPromptCacheAnalytics(options(kv));
  assert.equal(aggregate.buckets[0]?.sample_count, cohorts.length);
  const grouped = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["route", "mode"] });
  assert.equal(grouped.cardinality_limited, false);
  assert.equal(grouped.truncated, false);
  assert.equal(
    grouped.buckets.reduce((sampleCount, bucket) => sampleCount + bucket.sample_count, 0),
    cohorts.length
  );
});

test("prompt-cache analytics caps cohort cardinality while retaining aggregate evidence", async () => {
  const kv = new CountingKv();
  for (let index = 0; index < PROMPT_CACHE_ANALYTICS_MAX_COHORTS_PER_BUCKET; index += 1) {
    const result = await recordPromptCacheAnalytics(event({ model: `gpt-cardinality-${index}` }), options(kv));
    assert.equal(result.reason, "recorded");
  }
  for (const input of [
    event({ model: "gpt-cardinality-overflow" }),
    event({
      model: "gpt-cardinality-overflow-second",
      inputTokens: 200,
      cachedInputTokens: 50,
      cacheWriteInputTokens: 20,
    }),
  ]) {
    assert.deepEqual(await recordPromptCacheAnalytics(input, options(kv)), {
      status: "recorded",
      reason: "recorded_cardinality_capped",
      bucket_start_at_ms: NOW_MS,
    });
  }

  const aggregate = await readPromptCacheAnalytics(options(kv));
  assert.deepEqual(
    aggregate.buckets[0] && {
      input: aggregate.buckets[0].input_tokens,
      cached: aggregate.buckets[0].cached_input_tokens,
      write: aggregate.buckets[0].cache_write_input_tokens,
      writeSamples: aggregate.buckets[0].cache_write_reported_sample_count,
      samples: aggregate.buckets[0].sample_count,
    },
    { input: 3_500, cached: 875, write: 350, writeSamples: 34, samples: 34 }
  );
  const byModel = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["model"] });
  assert.equal(byModel.buckets.length, PROMPT_CACHE_ANALYTICS_MAX_COHORTS_PER_BUCKET + 1);
  assert.equal(byModel.cardinality_limited, true);
  assert.equal(byModel.truncated, true);
  assert.equal(byModel.buckets.filter((bucket) => bucket.group?.cardinality_limited !== true).length, 32);
  assert.doesNotMatch(JSON.stringify(byModel), /gpt-cardinality-overflow/);

  for (const groupBy of PROMPT_CACHE_ANALYTICS_DIMENSIONS) {
    const grouped = await readPromptCacheAnalytics({ ...options(kv), groupBy: [groupBy] });
    assert.equal(grouped.cardinality_limited, true, groupBy);
    assert.equal(grouped.truncated, true, groupBy);
    const overflow = grouped.buckets.find((bucket) => bucket.group?.cardinality_limited === true);
    assert.deepEqual(
      overflow && {
        group: overflow.group,
        input: overflow.input_tokens,
        cached: overflow.cached_input_tokens,
        write: overflow.cache_write_input_tokens,
        writeSamples: overflow.cache_write_reported_sample_count,
        samples: overflow.sample_count,
        hits: overflow.request_cache_hit_sample_count,
        reported: overflow.usage_reported_sample_count,
        limited: overflow.dimension_cardinality_limited_sample_count,
      },
      {
        group: { cardinality_limited: true },
        input: 300,
        cached: 75,
        write: 30,
        writeSamples: 2,
        samples: 2,
        hits: 2,
        reported: 2,
        limited: 2,
      },
      groupBy
    );
  }
});

test("prompt-cache analytics caps grouped response cardinality and marks the result", async () => {
  const kv = new CountingKv();
  const bucketCount = Math.ceil(PROMPT_CACHE_ANALYTICS_MAX_RESPONSE_BUCKETS / PROMPT_CACHE_ANALYTICS_MAX_COHORTS_PER_BUCKET) + 1;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const bucketNow = NOW_MS - bucket * PROMPT_CACHE_ANALYTICS_BUCKET_MS;
    for (let cohort = 0; cohort < PROMPT_CACHE_ANALYTICS_MAX_COHORTS_PER_BUCKET; cohort += 1) {
      const result = await recordPromptCacheAnalytics(event({ model: `gpt-response-cap-${bucket}-${cohort}` }), options(kv, bucketNow));
      assert.equal(result.status, "recorded");
    }
  }
  const view = await readPromptCacheAnalytics({ ...options(kv), groupBy: ["model"] });
  assert.equal(view.truncated, true);
  assert.equal(view.max_buckets, PROMPT_CACHE_ANALYTICS_MAX_RESPONSE_BUCKETS);
  assert.equal(view.buckets.length, PROMPT_CACHE_ANALYTICS_MAX_RESPONSE_BUCKETS);
});

test("prompt-cache analytics returns the complete ungrouped seven-day window", async () => {
  const kv = new CountingKv();
  for (let offset = 0; offset <= PROMPT_CACHE_ANALYTICS_WINDOW_BUCKETS; offset += 1) {
    kv.seed(promptCacheAnalyticsCounterKey(NOW_MS - offset * PROMPT_CACHE_ANALYTICS_BUCKET_MS, "sample_count"), new KvU64(1n));
  }

  const view = await readPromptCacheAnalytics(options(kv));
  assert.deepEqual(view.group_by, []);
  assert.equal(view.max_buckets, PROMPT_CACHE_ANALYTICS_WINDOW_BUCKETS);
  assert.equal(view.truncated, false);
  assert.deepEqual(
    view.buckets.map((bucket) => bucket.bucket_start_at_ms),
    Array.from(
      { length: PROMPT_CACHE_ANALYTICS_WINDOW_BUCKETS },
      (_, index) => NOW_MS - (PROMPT_CACHE_ANALYTICS_WINDOW_BUCKETS - 1 - index) * PROMPT_CACHE_ANALYTICS_BUCKET_MS
    )
  );
});

test("prompt-cache analytics isolates v1 reads and prunes stale v1 and v2 entries with bounded scans", async () => {
  const kv = new ListSelectorCountingKv();
  const expiredBucket = NOW_MS - PROMPT_CACHE_ANALYTICS_RETENTION_MS;
  const freshBucket = NOW_MS;
  kv.seed([...LEGACY_V1_PREFIX, freshBucket, "input_tokens"], new KvU64(777n));
  kv.seed([...LEGACY_V1_PREFIX, freshBucket, "cached_input_tokens"], new KvU64(777n));
  kv.seed([...LEGACY_V1_PREFIX, freshBucket, "sample_count"], new KvU64(1n));
  assert.deepEqual((await readPromptCacheAnalytics(options(kv))).buckets, []);
  kv.listSelectors.length = 0;
  kv.listedKeys.length = 0;
  for (const namespace of V2_PRUNABLE_NAMESPACES) {
    kv.seed([...PROMPT_CACHE_ANALYTICS_KV_PREFIX, namespace, freshBucket, "fresh-fixture"], new KvU64(1n));
  }

  await recordPromptCacheAnalytics(event({ model: "gpt-expired" }), options(kv, expiredBucket));
  kv.seed([...PROMPT_CACHE_ANALYTICS_KV_PREFIX, "overflow", expiredBucket, "sample_count"], new KvU64(1n));
  kv.seed([...LEGACY_V1_PREFIX, expiredBucket, "input_tokens"], new KvU64(1n));
  const pruned = await prunePromptCacheAnalytics({ kv: kv as unknown as Kv, now: () => NOW_MS });
  assert.equal(pruned.status, "pruned");
  assert.ok(pruned.deleted > 1);
  assert.deepEqual(kv.listSelectors, [
    ...V2_PRUNABLE_NAMESPACES.map((namespace) => {
      const prefix = [...PROMPT_CACHE_ANALYTICS_KV_PREFIX, namespace];
      return { prefix, end: [...prefix, expiredBucket + 1] };
    }),
    { prefix: [...LEGACY_V1_PREFIX], end: [...LEGACY_V1_PREFIX, expiredBucket + 1] },
  ]);
  assert.equal(
    kv.listedKeys.some((key) => key.includes(freshBucket)),
    false
  );
  assert.equal(
    kv.listedKeys.some((key) => key.includes(expiredBucket)),
    true
  );

  const remainingKeys = [...kv.entries.values()].map((entry) => JSON.stringify(entry.key));
  assert.equal(
    remainingKeys.some((key) => key.includes(String(expiredBucket))),
    false
  );
  assert.equal(
    remainingKeys.some((key) => key.includes('"v1"')),
    true
  );
  assert.ok(remainingKeys.every((key) => !key.includes('"v1"') || key.includes(String(freshBucket))));
  assert.ok(remainingKeys.every((key) => !key.includes('"v2"') || !key.includes(String(expiredBucket))));
  assert.equal(remainingKeys.filter((key) => key.includes('"v2"') && key.includes(String(freshBucket))).length, V2_PRUNABLE_NAMESPACES.length);
  assert.equal(PROMPT_CACHE_ANALYTICS_KV_PREFIX.at(-1), "v2");
  assert.ok((await readPromptCacheAnalytics(options(kv))).buckets.length === 0);
  assert.equal(kv.entries.has(JSON.stringify(promptCacheAnalyticsCounterKey(expiredBucket, "sample_count"))), false);
});

test("prompt-cache analytics rejects unknown, duplicate, and over-broad grouping", async () => {
  const kv = new CountingKv();
  await assert.rejects(() => readPromptCacheAnalytics({ ...options(kv), groupBy: ["provider", "provider"] }), PromptCacheAnalyticsQueryError);
  await assert.rejects(() => readPromptCacheAnalytics({ ...options(kv), groupBy: ["provider", "route", "mode"] }), PromptCacheAnalyticsQueryError);
  await assert.rejects(() => readPromptCacheAnalytics({ ...options(kv), groupBy: ["unknown"] as never }), PromptCacheAnalyticsQueryError);
  const unavailable = await readPromptCacheAnalytics({ kv: null, groupBy: ["provider"] });
  assert.deepEqual(unavailable.buckets, []);
  assert.equal(unavailable.status, "unavailable");
});
