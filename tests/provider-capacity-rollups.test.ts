import type { Kv } from "#kv";
import { test } from "bun:test";
// Rollup coverage moved beside tests/provider-capacity.test.ts: that file sits
// at the 1500-line test cap enforced by scripts/file-size-ratchet.ts, and the
// original PR's additions pushed it to 1514 lines, which failed `size:check`.
import assert from "node:assert/strict";

import { resetCodexAccountRoutingForTest } from "../src/codex/account-routing.ts";
import { CODEX_AUTH_POOL_KV_KEY, resetCodexAuthCacheForTest } from "../src/codex/index.ts";
import { setKvForTest } from "../src/kv.ts";
import { METERED_QUOTA_STATE_KEY } from "../src/metered-quota.ts";
import {
  handleProviderCapacityRollups,
  PROVIDER_CAPACITY_RESEARCH_DEFAULT_WINDOW_DAYS,
  PROVIDER_CAPACITY_RESEARCH_MAX_WINDOW_DAYS,
  PROVIDER_CAPACITY_ROLLUP_BUCKET_MS,
  refreshProviderCapacity,
  sampleProviderCapacityOnEvent,
} from "../src/provider/capacity.ts";
import {
  listProviderCapacityRollups,
  mergeProviderCapacityRollup,
  providerCapacityRollupBucketStartAtMs,
  providerCapacityRollupKey,
} from "../src/provider/capacity-rollups.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

const nowMs = 1_800_000_000_000;
const kv = new CountingKv();

const seed = (): void => {
  kv.clearData();
  kv.clearMeasurements();
  kv.seed(CODEX_AUTH_POOL_KV_KEY, {
    accounts: [
      { access_token: "token-one", refresh_token: "refresh-one", account_id: "account-one", updated_at_ms: nowMs },
      { access_token: "token-two", refresh_token: "refresh-two", account_id: "account-two", updated_at_ms: nowMs },
    ],
    updated_at_ms: nowMs,
  });
  kv.seed(METERED_QUOTA_STATE_KEY, {
    current_balance_quota: 750,
    post_refill_baseline_quota: 1_000,
    last_observed_used_quota: 250,
    quota_per_credit: 100,
    observed_at_ms: nowMs - 1_000,
    cycle_started_at_ms: nowMs - 5_000,
    confidence: "refill_observed",
    last_known_debits_quota: 0,
    last_inferred_credit_quota: 1_000,
    last_credit_at_ms: nowMs - 5_000,
    latest_refill_id: "refill-one",
    latest_refill_amount_credits: 10,
    latest_refill_completed_at_ms: nowMs - 5_000,
  });
  process.env.METERED_API_KEY = "metered-api-key";
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
  setKvForTest(kv as unknown as Kv);
};

// `String(input)` would render a `Request` as "[object Request]" instead of its URL.
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const createFetcher =
  (usage: (account: string | null) => readonly [number, number]) =>
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (url === "https://api.openlux.ai/api/usage/token/") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            data: { total_available: 750, total_granted: 1_000, total_used: 250, unlimited_quota: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    const headers = new Headers(init?.headers);
    const [primaryUsed, secondaryUsed] = usage(headers.get("ChatGPT-Account-ID"));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              limit_window_seconds: 10_800,
              used_percent: primaryUsed,
              reset_at: 1_800_010_000,
            },
            secondary_window: {
              limit_window_seconds: 86_400,
              used_percent: secondaryUsed,
              reset_at: 1_800_020_000,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
  };

const rollupTestInput = (bucketStartAtMs: number, sampledAtMs: number, primaryUsedPercent: number, state: "available" | "unavailable" = "available") => ({
  bucket_start_at_ms: bucketStartAtMs,
  sampled_at_ms: sampledAtMs,
  slots: [
    {
      slot: 1 as const,
      state,
      primary: state === "available" ? { limit_window_seconds: 10_800, used_percent: primaryUsedPercent, reset_at_ms: sampledAtMs + 10_800_000 } : null,
      secondary: null,
    },
    { slot: 2 as const, state: "unavailable" as const, primary: null, secondary: null },
  ] as const,
});

test("capacity sampling folds an hourly capacity rollup into the persisted history atomic", async () => {
  seed();
  await refreshProviderCapacity({
    kv: kv as unknown as Kv,
    fetcher: createFetcher((account) => (account === "account-one" ? [12.5, 38] : [67, 81.25])),
    now: () => nowMs,
  });
  const bucketStartAtMs = providerCapacityRollupBucketStartAtMs(nowMs);
  const stored = (await kv.get(providerCapacityRollupKey(bucketStartAtMs))).value;
  assert.notEqual(stored, null);

  const first = await listProviderCapacityRollups(kv as unknown as Kv, { sinceMs: nowMs - PROVIDER_CAPACITY_ROLLUP_BUCKET_MS, nowMs });
  assert.equal(first.length, 1);
  const point = first[0];
  assert.ok(point);
  assert.equal(point.bucket_start_at_ms, bucketStartAtMs);
  assert.equal(point.sample_count, 1);
  assert.equal(point.slots[0].slot, 1);
  assert.equal(point.slots[0].last_state, "available");
  assert.equal(point.slots[0].primary.last_used_percent, 12.5);
  assert.equal(point.slots[0].primary.min_used_percent, 12.5);
  assert.equal(point.slots[0].secondary.last_used_percent, 38);
  assert.equal(point.slots[1].primary.last_used_percent, 67);

  // A later sample in the same hour merges into the existing rollup record.
  await refreshProviderCapacity({
    kv: kv as unknown as Kv,
    fetcher: createFetcher((account) => (account === "account-one" ? [20.5, 30] : [10, 90])),
    now: () => nowMs + 60_000,
  });
  const merged = await listProviderCapacityRollups(kv as unknown as Kv, { sinceMs: nowMs - PROVIDER_CAPACITY_ROLLUP_BUCKET_MS, nowMs: nowMs + 60_000 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.sample_count, 2);
  assert.equal(merged[0]?.slots[0].primary.min_used_percent, 12.5);
  assert.equal(merged[0]?.slots[0].primary.max_used_percent, 20.5);
  assert.equal(merged[0]?.slots[0].primary.last_used_percent, 20.5);
  assert.equal(merged[0]?.slots[1].primary.min_used_percent, 10);
  assert.equal(merged[0]?.slots[1].primary.max_used_percent, 67);
});

test("the event sampler records the hourly rollup on the request-terminal hook path", async () => {
  seed();
  await sampleProviderCapacityOnEvent({
    kv: kv as unknown as Kv,
    fetcher: createFetcher((account) => (account === "account-one" ? [5, 15] : [25, 35])),
    now: () => nowMs,
    createLeaseOwner: () => "event-sampler",
  });
  const points = await listProviderCapacityRollups(kv as unknown as Kv, { sinceMs: nowMs - PROVIDER_CAPACITY_ROLLUP_BUCKET_MS, nowMs });
  assert.equal(points.length, 1);
  assert.equal(points[0]?.sample_count, 1);
  assert.equal(points[0]?.slots[0].last_state, "available");
  assert.equal(points[0]?.slots[0].primary.last_used_percent, 5);
  assert.equal(points[0]?.slots[1].primary.last_used_percent, 25);
});

test("research rollups keep hourly capacity summaries beyond the seven-day raw history window", async () => {
  seed();
  const researchNowMs = nowMs + 30 * 24 * 60 * 60_000;
  const oldBucketStartAtMs = providerCapacityRollupBucketStartAtMs(nowMs - 30 * 24 * 60 * 60_000);
  kv.seed(
    providerCapacityRollupKey(oldBucketStartAtMs),
    mergeProviderCapacityRollup(null, rollupTestInput(oldBucketStartAtMs, oldBucketStartAtMs + 1_000, 42))
  );
  const nowBucketStartAtMs = providerCapacityRollupBucketStartAtMs(researchNowMs);
  kv.seed(
    providerCapacityRollupKey(nowBucketStartAtMs),
    mergeProviderCapacityRollup(null, rollupTestInput(nowBucketStartAtMs, nowBucketStartAtMs + 1_000, 7, "unavailable"))
  );

  const long = await listProviderCapacityRollups(kv as unknown as Kv, { sinceMs: researchNowMs - 90 * 24 * 60 * 60_000, nowMs: researchNowMs });
  assert.deepEqual(
    long.map((entry) => entry.bucket_start_at_ms),
    [oldBucketStartAtMs, nowBucketStartAtMs]
  );
  assert.equal(long[0]?.slots[0].primary.max_used_percent, 42);
  assert.equal(long[1]?.slots[0].last_state, "unavailable");

  const recent = await listProviderCapacityRollups(kv as unknown as Kv, { sinceMs: researchNowMs - 7 * 24 * 60 * 60_000, nowMs: researchNowMs });
  assert.deepEqual(
    recent.map((entry) => entry.bucket_start_at_ms),
    [nowBucketStartAtMs]
  );
});

test("capacity rollups research route returns the requested window", async () => {
  seed();
  const bucketStartAtMs = providerCapacityRollupBucketStartAtMs(nowMs);
  kv.seed(providerCapacityRollupKey(bucketStartAtMs), mergeProviderCapacityRollup(null, rollupTestInput(bucketStartAtMs, nowMs, 33)));

  const response = await handleProviderCapacityRollups(new Request("https://ai.ubq.fi/admin/providers/capacity/rollups?window_days=365"), {
    kv: kv as unknown as Kv,
    now: () => nowMs,
  });
  assert.equal(response.status, 200);
  // The route always emits these fields, so the response contract declares them
  // required and the assertions need no optional chains.
  const body = (await response.json()) as {
    window_days: number;
    rollup_scan: string;
    retention: { rollup_bucket_ms: number; rollup_window_ms: number };
    rollups: { bucket_start_at_ms: number; slots: { primary: { last_used_percent: number } }[] }[];
  };
  assert.equal(body.window_days, 365);
  assert.equal(body.rollup_scan, "ok");
  assert.equal(body.retention.rollup_bucket_ms, PROVIDER_CAPACITY_ROLLUP_BUCKET_MS);
  assert.equal(body.retention.rollup_window_ms, 365 * 24 * 60 * 60_000);
  assert.equal(body.rollups.length, 1);
  assert.equal(body.rollups[0].bucket_start_at_ms, bucketStartAtMs);
  assert.equal(body.rollups[0].slots[0].primary.last_used_percent, 33);

  const defaults = await handleProviderCapacityRollups(new Request("https://ai.ubq.fi/admin/providers/capacity/rollups?window_days=nope"), {
    kv: kv as unknown as Kv,
    now: () => nowMs,
  });
  assert.equal(((await defaults.json()) as { window_days?: number }).window_days, PROVIDER_CAPACITY_RESEARCH_DEFAULT_WINDOW_DAYS);

  const capped = await handleProviderCapacityRollups(new Request("https://ai.ubq.fi/admin/providers/capacity/rollups?window_days=100000"), {
    kv: kv as unknown as Kv,
    now: () => nowMs,
  });
  assert.equal(((await capped.json()) as { window_days?: number }).window_days, PROVIDER_CAPACITY_RESEARCH_MAX_WINDOW_DAYS);
});

test("capacity rollups route requires admin authentication through the request router", async () => {
  const { default: handler } = await import("../src/handler/index.ts");
  const response = await handler(new Request("https://ai.ubq.fi/admin/providers/capacity/rollups"));
  assert.equal(response.status, 401);
});
