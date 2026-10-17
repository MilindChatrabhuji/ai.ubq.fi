import { readFileSync } from "node:fs";
import { test } from "bun:test";
import assert from "node:assert/strict";

import { handleAdminPromptCacheAnalytics } from "../src/admin/index.ts";
import type { PromptCacheAnalyticsView } from "../src/cache/prompt-analytics.ts";
const adminScript = readFileSync(new URL("../static/admin.js", import.meta.url), "utf8");

const readyView = (groupBy: readonly string[]): PromptCacheAnalyticsView => ({
  status: "ready",
  bucket_ms: 900_000,
  window_start_at_ms: 1_799_000_000_000,
  window_end_at_ms: 1_800_000_900_000,
  group_by: groupBy as PromptCacheAnalyticsView["group_by"],
  max_buckets: 512,
  cardinality_limited: false,
  truncated: false,
  buckets: [
    {
      bucket_start_at_ms: 1_800_000_000_000,
      bucket_end_at_ms: 1_800_000_900_000,
      input_tokens: 100,
      cached_input_tokens: 50,
      cache_write_input_tokens: 25,
      cache_write_reported_sample_count: 1,
      cached_percentage: 50,
      sample_count: 1,
      group: { prompt_cache_key_present: true },
      token_hit_percentage: 50,
      request_cache_hit_sample_count: 1,
      request_hit_percentage: 100,
      cache_reads_per_write: 2,
      usage_reported_sample_count: 1,
      usage_invalid_sample_count: 0,
      usage_missing_sample_count: 0,
      usage_telemetry_coverage_percentage: 100,
      dimension_cardinality_limited_sample_count: 0,
    },
  ],
});

test("prompt-cache analytics admin API validates a bounded group_by before reading KV", async () => {
  const reads: unknown[] = [];
  const response = await handleAdminPromptCacheAnalytics(new Request("https://ai.ubq.fi/admin/prompt-cache-analytics?group_by=provider,route"), (input) => {
    reads.push(input);
    return Promise.resolve(readyView(input.groupBy ?? []));
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(reads, [{ groupBy: ["provider", "route"] }]);
  assert.deepEqual(((await response.json()) as PromptCacheAnalyticsView).group_by, ["provider", "route"]);

  const defaultGroup = await handleAdminPromptCacheAnalytics(new Request("https://ai.ubq.fi/admin/prompt-cache-analytics"), (input) =>
    Promise.resolve(readyView(input.groupBy ?? []))
  );
  assert.deepEqual(((await defaultGroup.json()) as PromptCacheAnalyticsView).group_by, ["key_presence"]);

  for (const url of [
    "https://ai.ubq.fi/admin/prompt-cache-analytics?group_by=provider,unknown",
    "https://ai.ubq.fi/admin/prompt-cache-analytics?group_by=provider,provider",
    "https://ai.ubq.fi/admin/prompt-cache-analytics?group_by=provider,route,mode",
    "https://ai.ubq.fi/admin/prompt-cache-analytics?group_by=provider&group_by=route",
    "https://ai.ubq.fi/admin/prompt-cache-analytics?model=raw-model-must-not-be-accepted",
  ]) {
    const invalid = await handleAdminPromptCacheAnalytics(new Request(url), () => Promise.reject(new Error("reader must not run for invalid input")));
    assert.equal(invalid.status, 400, url);
    assert.equal(((await invalid.json()) as { error?: { type?: string } }).error?.type, "invalid_request_error");
  }
});

test("prompt-cache analytics admin API preserves an explicit unavailable state", async () => {
  const unavailable = await handleAdminPromptCacheAnalytics(new Request("https://ai.ubq.fi/admin/prompt-cache-analytics?group_by=key_presence"), (input) =>
    Promise.resolve({ ...readyView(input.groupBy ?? []), status: "unavailable", buckets: [] })
  );
  assert.equal(unavailable.status, 200);
  assert.equal(((await unavailable.json()) as PromptCacheAnalyticsView).status, "unavailable");

  const secret = "prompt-cache-reader-secret";
  const failed = await handleAdminPromptCacheAnalytics(new Request("https://ai.ubq.fi/admin/prompt-cache-analytics?group_by=key_presence"), () =>
    Promise.reject(new Error(secret))
  );
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await failed.text(), new RegExp(secret));
});

test("admin bundle omits the standalone prompt-cache analytics section", () => {
  assert.doesNotMatch(adminScript, /Prompt-cache analytics/);
  assert.doesNotMatch(adminScript, /promptCacheAnalytics/);
  assert.doesNotMatch(adminScript, /\/admin\/prompt-cache-analytics/);
});
