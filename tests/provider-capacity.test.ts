import type { KvU64 } from "#kv";
import type { Kv, KvKey } from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import { cleanupHarness, resetHarness } from "./helpers/provider-capacity-harness.ts";
import assert from "node:assert/strict";

import { setKvForTest } from "../src/kv.ts";
import { codexResetRedemptionKey, codexResetShadowDecisionKey } from "../src/codex/banked-reset.ts";
import { CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, resetCodexAccountRoutingForTest } from "../src/codex/account-routing.ts";
import { CODEX_AUTH_POOL_KV_KEY, resetCodexAuthCacheForTest } from "../src/codex/index.ts";
import {
  getPersistedProviderCapacityView,
  handleProviderCapacity,
  PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
  PROVIDER_CAPACITY_HISTORY_KEY_PREFIX,
  PROVIDER_CAPACITY_HISTORY_RETENTION_MS,
  PROVIDER_CAPACITY_LEASE_KEY,
  PROVIDER_CAPACITY_RATE_LIMIT_RESET_MIN_GAIN_PERCENTAGE_POINTS,
  PROVIDER_CAPACITY_READ_FRESH_MS,
  PROVIDER_CAPACITY_SNAPSHOT_KEY,
  PROVIDER_CAPACITY_SOURCE_STALE_MS,
  type ProviderCapacityCodexSource,
  type ProviderCapacitySource,
  providerCapacityHistoryKey,
  refreshProviderCapacity,
  sampleProviderCapacityOnEvent,
} from "../src/provider/capacity.ts";
import { PROMPT_CACHE_ANALYTICS_BUCKET_MS, promptCacheAnalyticsCounterKey } from "../src/cache/prompt-analytics.ts";
import {
  listProviderCapacityDowntimeEvents,
  PROVIDER_CAPACITY_DOWNTIME_EVENT_KV_PREFIX,
  PROVIDER_CAPACITY_RATE_LIMIT_RESET_EVENT_KV_PREFIX,
  PROVIDER_CAPACITY_RESET_EVENT_KV_PREFIX,
  recordProviderCapacityDowntimeEvent,
} from "../src/provider/capacity-events.ts";
import { METERED_QUOTA_FRESH_MS, METERED_QUOTA_STATE_KEY } from "../src/metered-quota.ts";
import { CountingKv } from "./helpers/counting-kv.ts";
import { createFetcher, keyToString, kvStore, kvStub, nowMs, requestUrl, seed } from "./helpers/provider-capacity-harness.ts";

const TEST_ACCOUNT_COHORT_IDS = {
  1: "1".repeat(64),
  2: "2".repeat(64),
} as const;

const historySource = (
  slot: 1 | 2,
  sampledAtMs: number,
  state: "available" | "unavailable" = "available",
  options: Readonly<{
    primaryUsed?: number;
    primaryResetAtMs?: number;
    accountCohortId?: string | null;
  }> = {}
) => ({
  source: "codex" as const,
  label: `Codex account ${slot}`,
  slot,
  account_cohort_id: options.accountCohortId === undefined ? TEST_ACCOUNT_COHORT_IDS[slot] : options.accountCohortId,
  state,
  source_observed_at_ms: state === "available" ? sampledAtMs : null,
  snapshot_at_ms: sampledAtMs,
  windows:
    state === "available"
      ? {
          primary: {
            limit_window_seconds: 10_800,
            used_percent: options.primaryUsed ?? (slot === 1 ? 20 : 40),
            reset_at_ms: options.primaryResetAtMs ?? sampledAtMs + 10_800_000,
          },
          secondary: {
            limit_window_seconds: 86_400,
            used_percent: slot === 1 ? 30 : 50,
            reset_at_ms: sampledAtMs + 86_400_000,
          },
        }
      : { primary: null, secondary: null },
});

const historyRecord = (bucketStartAtMs: number, sampledAtMs = bucketStartAtMs + 1_000, state: "available" | "unavailable" = "available") => ({
  bucket_start_at_ms: bucketStartAtMs,
  sampled_at_ms: sampledAtMs,
  sources: [historySource(1, sampledAtMs, state), historySource(2, sampledAtMs, state)],
});

beforeEach(resetHarness);
afterEach(cleanupHarness);

test("sampler creates one fixed combined bucket and redacts account credentials", async () => {
  seed();
  const calls: { account: string | null; authorization: string | null; url: string }[] = [];
  const live = await refreshProviderCapacity({ kv: kvStub, fetcher: createFetcher(calls), now: () => nowMs });
  assert.equal(live.cache_state, "live");
  assert.equal(calls.length, 3);
  const codexCalls = calls.filter((call) => call.url.endsWith("/backend-api/wham/usage"));
  const meteredCalls = calls.filter((call) => call.url.startsWith("https://api.openlux.ai/api/"));
  assert.equal(codexCalls.length, 2);
  assert.equal(meteredCalls.length, 1);
  assert.deepEqual(
    codexCalls.map((call) => call.account).sort((left, right) => (left ?? "").localeCompare(right ?? "")),
    ["account-one", "account-two"]
  );
  assert.deepEqual(
    codexCalls.map((call) => call.authorization).sort((left, right) => (left ?? "").localeCompare(right ?? "")),
    ["Bearer token-one", "Bearer token-two"]
  );
  assert.equal(live.history.length, 1);
  assert.equal(live.history[0]?.bucket_start_at_ms, Math.floor(nowMs / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS);
  assert.equal(live.history[0]?.sources.length, 3);
  assert.equal(live.history[0]?.sources[0]?.windows.primary?.limit_window_seconds, 10_800);
  assert.equal(live.history[0]?.sources[0]?.windows.primary?.used_percent, 12.5);
  assert.equal(live.history[0]?.sources[1]?.windows.secondary?.reset_at_ms, 1_800_020_000_000);
  assert.equal(live.sources.find((source) => source.source === "metered")?.wallet.reset_at_ms, null);
  for (const source of live.sources.filter((candidate) => candidate.source === "codex")) {
    assert.match(source.account_cohort_id ?? "", /^[a-f0-9]{64}$/);
  }

  const callsInSameBucket: { account: string | null; authorization: string | null; url: string }[] = [];
  const second = await refreshProviderCapacity({
    kv: kvStub,
    fetcher: createFetcher(callsInSameBucket),
    now: () => nowMs + 1_000,
  });
  assert.equal(callsInSameBucket.length, 3);
  assert.equal(second.history.length, 1);
  const historyKeyCount = [...kvStore.keys()]
    .map((key) => JSON.parse(key) as KvKey)
    .filter((key) => PROVIDER_CAPACITY_HISTORY_KEY_PREFIX.every((part, index) => key[index] === part)).length;
  assert.equal(historyKeyCount, 1);

  const serialized = JSON.stringify({
    response: second,
    storedSnapshot: kvStore.get(keyToString(PROVIDER_CAPACITY_SNAPSHOT_KEY)),
  });
  for (const secret of ["account-one", "account-two", "token-one", "token-two", "refresh-one", "must-not-escape"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("sampler refresh observes Metered token usage", async () => {
  seed();
  const initial = await refreshProviderCapacity({
    kv: kvStub,
    fetcher: createFetcher([]),
    now: () => nowMs,
  });
  assert.equal(initial.history[0]?.sources[2]?.wallet.total_available, 750);

  const topupCalls: { account: string | null; authorization: string | null; url: string }[] = [];
  const topup = await refreshProviderCapacity({
    kv: kvStub,
    fetcher: createFetcher(topupCalls, null, {
      total_available: 1_750,
      total_granted: 2_000,
      total_used: 250,
    }),
    now: () => nowMs + PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
  });
  const current = topup.sources.find((source) => source.source === "metered");
  assert.equal(current?.state, "available");
  assert.equal(current.wallet.total_available, 1_750);
  assert.equal(current.wallet.total_used, 250);
  assert.equal(topup.history.length, 2);
  assert.equal(topup.history[0]?.sources[2]?.wallet.total_available, 750);
  assert.equal(topup.history[1]?.sources[2]?.wallet.total_available, 1_750);
  assert.equal(topupCalls.length, 3);
});

test("sampler preserves an exhaustion point when a reset refills the same bucket", async () => {
  seed();
  let phase = 0;
  const calls: { account: string | null; authorization: string | null; url: string }[] = [];
  const fetcher = createFetcher(calls, null, {}, () => (phase === 0 ? [100, 100] : [0, 0]));
  const exhausted = await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs });
  phase = 1;
  const refilled = await refreshProviderCapacity({
    kv: kvStub,
    fetcher,
    now: () => nowMs + 1_000,
  });
  assert.equal(exhausted.history.length, 1);
  assert.equal(refilled.history.length, 2);
  assert.equal(refilled.history[0]?.sampled_at_ms, nowMs);
  assert.equal(refilled.history[0]?.sources[0]?.windows.primary?.used_percent, 100);
  assert.equal(refilled.history[1]?.sampled_at_ms, nowMs + 1_000);
  assert.equal(refilled.history[1]?.sources[0]?.windows.primary?.used_percent, 0);
});

test("sampler records a substantial rate-limit reset and preserves both same-bucket samples", async () => {
  seed();
  let phase = 0;
  const fetcher = createFetcher(
    [],
    null,
    {},
    (account) => {
      if (account !== "account-one") return [45, 55];
      return phase === 0 ? [80, 35] : [20, 35];
    },
    false,
    1_800_011_000,
    503,
    null,
    (account) => {
      if (account !== "account-one") return [1_800_010_000, 1_800_020_000];
      return phase === 0 ? [1_800_010_000, 1_800_020_000] : [1_800_020_000, 1_800_020_000];
    }
  );

  await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs });
  phase = 1;
  const reset = await refreshProviderCapacity({
    kv: kvStub,
    fetcher,
    now: () => nowMs + 1_000,
  });

  assert.deepEqual(
    reset.history.map((point) => point.sampled_at_ms),
    [nowMs, nowMs + 1_000]
  );
  assert.equal(reset.history[0]?.sources[0]?.windows.primary?.used_percent, 80);
  assert.equal(reset.history[1]?.sources[0]?.windows.primary?.used_percent, 20);
  assert.deepEqual(reset.rate_limit_reset_events, [
    {
      v: 1,
      event_id: "openai-1-primary-1800000000000-1800000001000",
      provider: "openai",
      slot: 1,
      window: "primary",
      observed_at_ms: nowMs + 1_000,
      previous_sampled_at_ms: nowMs,
      previous_reset_at_ms: 1_800_010_000_000,
      reset_at_ms: 1_800_020_000_000,
      previous_used_percent: 80,
      current_used_percent: 20,
      capacity_gain_percentage_points: 60,
    },
  ]);

  const persisted = await getPersistedProviderCapacityView({ kv: kvStub, now: () => nowMs + 1_000 });
  assert.deepEqual(persisted.rate_limit_reset_events, reset.rate_limit_reset_events);
  const eventKeys = [...kvStore.keys()]
    .map((key) => JSON.parse(key) as KvKey)
    .filter((key) => PROVIDER_CAPACITY_RATE_LIMIT_RESET_EVENT_KV_PREFIX.every((part, index) => key[index] === part));
  assert.equal(eventKeys.length, 1);
});

test("sampler does not correlate reset evidence across reordered accounts", async () => {
  seed();
  let phase = 0;
  const fetcher = createFetcher(
    [],
    null,
    {},
    (account) => (account === "account-one" ? [80, 35] : [20, 35]),
    false,
    1_800_011_000,
    503,
    null,
    () => (phase === 0 ? [1_800_010_000, 1_800_020_000] : [1_800_020_000, 1_800_020_000])
  );

  const first = await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs });
  const firstSlotOne = first.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 1);
  const firstSlotTwo = first.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 2);
  assert.match(firstSlotOne?.account_cohort_id ?? "", /^[a-f0-9]{64}$/);
  assert.match(firstSlotTwo?.account_cohort_id ?? "", /^[a-f0-9]{64}$/);

  kvStore.put(CODEX_AUTH_POOL_KV_KEY, {
    accounts: [
      { access_token: "token-two", refresh_token: "refresh-two", account_id: "account-two", updated_at_ms: nowMs },
      { access_token: "token-one", refresh_token: "refresh-one", account_id: "account-one", updated_at_ms: nowMs },
    ],
    updated_at_ms: nowMs + 1,
  });
  resetCodexAuthCacheForTest();
  phase = 1;
  const reordered = await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs + 1_000 });
  const reorderedSlotOne = reordered.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 1);
  const reorderedSlotTwo = reordered.sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === 2);

  assert.deepEqual(reordered.rate_limit_reset_events, []);
  assert.equal(reorderedSlotOne?.account_cohort_id, firstSlotTwo?.account_cohort_id);
  assert.equal(reorderedSlotTwo?.account_cohort_id, firstSlotOne?.account_cohort_id);
  const persisted = JSON.stringify(
    [...kvStore.entries()].flatMap(([encodedKey, stored]) => {
      const key = JSON.parse(encodedKey) as KvKey;
      return key[0] === "uos_ai" && key[1] === "provider_capacity" ? [stored.value] : [];
    })
  );
  assert.equal(persisted.includes("account-one"), false);
  assert.equal(persisted.includes("account-two"), false);
});

test("rejected comparison read preserves the coherent durable reset evidence", async () => {
  seed();
  let phase = 0;
  const fetcher = createFetcher(
    [],
    null,
    {},
    (account) => {
      if (account !== "account-one") return [45, 55];
      return phase === 0 ? [80, 35] : [10, 35];
    },
    false,
    1_800_011_000,
    503,
    null,
    (account) => {
      if (account !== "account-one") return [1_800_010_000, 1_800_020_000];
      return phase === 0 ? [1_800_010_000, 1_800_020_000] : [1_800_020_000, 1_800_020_000];
    }
  );
  await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs });
  const bucketKey = providerCapacityHistoryKey(nowMs);
  const lastAvailableKey = ["uos_ai", "provider_capacity", "v1", "last_available", 1] as const;
  let rejectedHistoryRead = false;
  const failingKv = {
    get: (key: KvKey, options?: { consistency?: "strong" | "eventual" }) => {
      if (!rejectedHistoryRead && options?.consistency === "strong" && keyToString(key) === keyToString(bucketKey)) {
        rejectedHistoryRead = true;
        return Promise.reject(new Error("injected history comparison read failure"));
      }
      return kvStub.get(key, options);
    },
    set: kvStub.set.bind(kvStub),
    delete: kvStub.delete.bind(kvStub),
    list: kvStub.list.bind(kvStub),
    atomic: kvStub.atomic.bind(kvStub),
    close: kvStub.close.bind(kvStub),
  } as unknown as Kv;

  phase = 1;
  const live = await refreshProviderCapacity({ kv: failingKv, fetcher, now: () => nowMs + 1_000 });
  assert.equal(rejectedHistoryRead, true);
  assert.deepEqual(
    live.history.map((point) => point.sampled_at_ms),
    [nowMs, nowMs + 1_000]
  );
  assert.equal((kvStore.get(keyToString(PROVIDER_CAPACITY_SNAPSHOT_KEY))?.value as { snapshot_at_ms?: number } | undefined)?.snapshot_at_ms, nowMs);
  assert.equal((kvStore.get(keyToString(bucketKey))?.value as { sampled_at_ms?: number } | undefined)?.sampled_at_ms, nowMs);
  assert.equal((kvStore.get(keyToString(lastAvailableKey))?.value as { sampled_at_ms?: number } | undefined)?.sampled_at_ms, nowMs);
  assert.equal(kvStore.get(keyToString(PROVIDER_CAPACITY_LEASE_KEY)), undefined);

  const retried = await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs + 2_000 });
  assert.equal(retried.rate_limit_reset_events.length, 1);
  assert.deepEqual(
    retried.history.map((point) => point.sampled_at_ms),
    [nowMs, nowMs + 2_000]
  );
});

test("sampler detects a reset when the healthy sample follows a 401 outage", async () => {
  seed();
  let phase = 0;
  const calls: { account: string | null; authorization: string | null; url: string }[] = [];
  const baseFetcher = createFetcher(
    calls,
    null,
    {},
    (account) => {
      if (account !== "account-one") return [45, 55];
      return phase === 2 ? [10, 35] : [80, 35];
    },
    false,
    1_800_011_000,
    503,
    null,
    (account) => {
      if (account !== "account-one") return [1_800_010_000, 1_800_020_000];
      return phase === 2 ? [1_800_020_000, 1_800_020_000] : [1_800_010_000, 1_800_020_000];
    }
  );
  const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const account = new Headers(init?.headers).get("ChatGPT-Account-ID");
    if (phase === 1 && account === "account-one") {
      calls.push({ account, authorization: new Headers(init?.headers).get("Authorization"), url: requestUrl(input) });
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }
    return baseFetcher(input, init);
  };

  await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs });
  // Exercise the migration path: snapshots written before the recovery marker
  // existed still have enough retained history to identify the prior quota.
  kvStore.remove(["uos_ai", "provider_capacity", "v1", "last_available", 1]);
  kvStore.remove(["uos_ai", "provider_capacity", "v1", "last_available", 2]);
  phase = 1;
  const outageAtMs = nowMs + PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const outage = await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => outageAtMs });
  assert.deepEqual(outage.rate_limit_reset_events, []);
  assert.equal(outage.history[1]?.sources[0]?.state, "unavailable");
  assert.equal(outage.history[1]?.sources[0]?.failure_status, 401);
  const secondOutageAtMs = nowMs + 2 * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const secondOutage = await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => secondOutageAtMs });
  assert.deepEqual(secondOutage.rate_limit_reset_events, []);
  assert.equal(secondOutage.history[2]?.sources[0]?.state, "unavailable");
  assert.equal(secondOutage.history[2]?.sources[0]?.failure_status, 401);

  phase = 2;
  const recoveredAtMs = nowMs + 3 * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const recovered = await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => recoveredAtMs });
  assert.deepEqual(recovered.rate_limit_reset_events, [
    {
      v: 1,
      event_id: `openai-1-primary-${nowMs}-${recoveredAtMs}`,
      provider: "openai",
      slot: 1,
      window: "primary",
      observed_at_ms: recoveredAtMs,
      previous_sampled_at_ms: nowMs,
      previous_reset_at_ms: 1_800_010_000_000,
      reset_at_ms: 1_800_020_000_000,
      previous_used_percent: 80,
      current_used_percent: 10,
      capacity_gain_percentage_points: 70,
    },
  ]);
  assert.deepEqual(
    recovered.history.map((point) => [point.sampled_at_ms, point.sources[0].state]),
    [
      [nowMs, "available"],
      [outageAtMs, "unavailable"],
      [secondOutageAtMs, "unavailable"],
      [recoveredAtMs, "available"],
    ]
  );
});

test("sampler does not backfill an outage reset across an account replacement", async () => {
  seed();
  let phase = 0;
  const calls: { account: string | null; authorization: string | null; url: string }[] = [];
  const baseFetcher = createFetcher(
    calls,
    null,
    {},
    (account) => {
      if (account === "replacement-account") return [10, 35];
      if (account === "account-one") return [80, 35];
      return [45, 55];
    },
    false,
    1_800_011_000,
    503,
    null,
    (account) => (account === "replacement-account" ? [1_800_020_000, 1_800_020_000] : [1_800_010_000, 1_800_020_000])
  );
  const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (phase === 1 && headers.get("ChatGPT-Account-ID") === "account-one") {
      calls.push({
        account: "account-one",
        authorization: headers.get("Authorization"),
        url: requestUrl(input),
      });
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    }
    return baseFetcher(input, init);
  };

  await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs });
  phase = 1;
  await refreshProviderCapacity({
    kv: kvStub,
    fetcher,
    now: () => nowMs + PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
  });
  kvStore.put(CODEX_AUTH_POOL_KV_KEY, {
    accounts: [
      {
        access_token: "replacement-token",
        refresh_token: "replacement-refresh",
        account_id: "replacement-account",
        updated_at_ms: nowMs + 1,
      },
      { access_token: "token-two", refresh_token: "refresh-two", account_id: "account-two", updated_at_ms: nowMs },
    ],
    updated_at_ms: nowMs + 1,
  });
  resetCodexAuthCacheForTest();
  phase = 2;
  const recoveredAtMs = nowMs + 2 * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const recovered = await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => recoveredAtMs });
  assert.deepEqual(recovered.rate_limit_reset_events, []);
  const persisted = await getPersistedProviderCapacityView({ kv: kvStub, now: () => recoveredAtMs });
  assert.deepEqual(persisted.rate_limit_reset_events, []);
});

test("sampler does not record a capacity gain when the reset timer does not advance", async () => {
  seed();
  let phase = 0;
  const fetcher = createFetcher(
    [],
    null,
    {},
    (account) => {
      if (account !== "account-one") return [45, 55];
      return phase === 0 ? [80, 35] : [20, 35];
    },
    false,
    1_800_011_000,
    503,
    null,
    () => [1_800_010_000, 1_800_020_000]
  );

  await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs });
  phase = 1;
  const changed = await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs + 1_000 });

  assert.deepEqual(changed.rate_limit_reset_events, []);
});

test("sampler does not record a timer advance below the substantial-gain threshold", async () => {
  seed();
  let phase = 0;
  const belowThreshold = PROVIDER_CAPACITY_RATE_LIMIT_RESET_MIN_GAIN_PERCENTAGE_POINTS - 1;
  const fetcher = createFetcher(
    [],
    null,
    {},
    (account) => {
      if (account !== "account-one") return [45, 55];
      return phase === 0 ? [60, 35] : [60 - belowThreshold, 35];
    },
    false,
    1_800_011_000,
    503,
    null,
    (account) => {
      if (account !== "account-one") return [1_800_010_000, 1_800_020_000];
      return phase === 0 ? [1_800_010_000, 1_800_020_000] : [1_800_020_000, 1_800_020_000];
    }
  );

  await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs });
  phase = 1;
  const changed = await refreshProviderCapacity({ kv: kvStub, fetcher, now: () => nowMs + 1_000 });

  assert.deepEqual(changed.rate_limit_reset_events, []);
});

test("persisted history keeps seven days and filters older buckets", async () => {
  seed();
  const currentBucket = Math.floor(nowMs / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const oldBucket = currentBucket - PROVIDER_CAPACITY_HISTORY_RETENTION_MS - PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const retainedBucket = currentBucket - PROVIDER_CAPACITY_HISTORY_RETENTION_MS + PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  kvStore.put(providerCapacityHistoryKey(oldBucket), historyRecord(oldBucket));
  kvStore.put(providerCapacityHistoryKey(retainedBucket), historyRecord(retainedBucket));
  kvStore.put(providerCapacityHistoryKey(currentBucket), historyRecord(currentBucket));

  const view = await getPersistedProviderCapacityView({ kv: kvStub, now: () => nowMs });
  assert.equal(view.cache_state, "unavailable");
  assert.deepEqual(
    view.history.map((point) => point.bucket_start_at_ms),
    [retainedBucket, currentBucket]
  );
  assert.equal(view.history[0]?.sources[1]?.windows.secondary?.limit_window_seconds, 86_400);
});

test("persisted history backfills a reset across an unavailable outage", async () => {
  seed();
  const beforeMs = nowMs - 3 * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const outageMs = nowMs - 2 * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const recoveredMs = nowMs - PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const putPoint = (
    sampledAtMs: number,
    state: "available" | "unavailable",
    primaryUsed: readonly [number, number],
    primaryResetAtMs: readonly [number, number]
  ): void => {
    const bucketStartAtMs = Math.floor(sampledAtMs / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
    kvStore.put(providerCapacityHistoryKey(bucketStartAtMs), {
      bucket_start_at_ms: bucketStartAtMs,
      sampled_at_ms: sampledAtMs,
      sources: [
        historySource(1, sampledAtMs, state, {
          primaryUsed: primaryUsed[0],
          primaryResetAtMs: primaryResetAtMs[0],
        }),
        historySource(2, sampledAtMs, state, {
          primaryUsed: primaryUsed[1],
          primaryResetAtMs: primaryResetAtMs[1],
        }),
      ],
    });
  };
  putPoint(beforeMs, "available", [53, 51], [1_787_011_235_000, 1_787_012_131_000]);
  putPoint(outageMs, "unavailable", [0, 0], [0, 0]);
  putPoint(recoveredMs, "available", [1, 2], [1_787_197_026_000, 1_787_197_532_000]);

  const view = await getPersistedProviderCapacityView({ kv: kvStub, now: () => nowMs });
  assert.deepEqual(
    view.rate_limit_reset_events.map((event) => [event.slot, event.window, event.capacity_gain_percentage_points]),
    [
      [1, "primary", 52],
      [2, "primary", 49],
    ]
  );
  assert.equal([...kvStore.keys()].filter((key) => key.includes("rate_limit_reset_event")).length, 2);
});

test("legacy history without account cohorts remains readable but cannot infer resets", async () => {
  seed();
  const sampledAtMs = [
    nowMs - 3 * PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
    nowMs - 2 * PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
    nowMs - PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
  ];
  for (const [index, sampleMs] of sampledAtMs.entries()) {
    const state = index === 1 ? "unavailable" : "available";
    const bucketStartAtMs = Math.floor(sampleMs / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
    kvStore.put(providerCapacityHistoryKey(bucketStartAtMs), {
      bucket_start_at_ms: bucketStartAtMs,
      sampled_at_ms: sampleMs,
      sources: [
        historySource(1, sampleMs, state, {
          accountCohortId: null,
          primaryUsed: index === 0 ? 80 : 10,
          primaryResetAtMs: index === 0 ? 1_787_011_235_000 : 1_787_197_026_000,
        }),
        historySource(2, sampleMs, state, { accountCohortId: null }),
      ],
    });
  }

  const view = await getPersistedProviderCapacityView({ kv: kvStub, now: () => nowMs });
  assert.equal(view.history.length, 3);
  assert.equal(view.history[0]?.sources[0]?.account_cohort_id, null);
  assert.deepEqual(view.rate_limit_reset_events, []);
});

test("capacity view backfills recent verified reset events from the redacted redemption ledger", async () => {
  seed();
  const accountIdHash = "account-hash-one";
  const quotaGeneration = "v1:quota-generation-one";
  const verifiedAtMs = nowMs - 10_000;
  kvStore.put(codexResetShadowDecisionKey("episode-one"), {
    v: 1,
    episode_hash: "episode-one",
    created_at_ms: verifiedAtMs - 1_000,
    expires_at_ms: verifiedAtMs + 60_000,
    decision_reason: "selected",
    selected_account_id_hash: accountIdHash,
    selected_credit_id_hash: "credit-hash-one",
    selected_credit_expires_at_ms: null,
    fences: [
      {
        slot: 1,
        account_id_hash: accountIdHash,
        quota_generation: quotaGeneration,
        routing_generation: 3,
        quota_reset_at_ms: verifiedAtMs + 60_000,
      },
      {
        slot: 2,
        account_id_hash: "account-hash-two",
        quota_generation: "v1:quota-generation-two",
        routing_generation: 4,
        quota_reset_at_ms: verifiedAtMs + 60_000,
      },
    ],
  });
  kvStore.put(codexResetRedemptionKey(accountIdHash, quotaGeneration), {
    v: 1,
    account_id_hash: accountIdHash,
    credential_version: "credential-version-one",
    quota_generation: quotaGeneration,
    routing_generation: 3,
    idempotency_key_hash: "idempotency-hash-one",
    state: "verified",
    owner_token: "owner-one",
    fence: 1,
    lease_expires_at_ms: verifiedAtMs + 30_000,
    provider_receipt_id: null,
    created_at_ms: verifiedAtMs - 5_000,
    updated_at_ms: verifiedAtMs,
    submitted_at_ms: verifiedAtMs - 1_000,
    verified_at_ms: verifiedAtMs,
    last_error_code: null,
  });

  const view = await getPersistedProviderCapacityView({ kv: kvStub, now: () => nowMs });
  assert.deepEqual(view.reset_events, [
    {
      v: 1,
      event_id: "idempotency-hash-one",
      slot: 1,
      observed_at_ms: verifiedAtMs,
    },
  ]);
  const storedEventKeys = [...kvStore.keys()]
    .map((key) => JSON.parse(key) as KvKey)
    .filter((key) => PROVIDER_CAPACITY_RESET_EVENT_KV_PREFIX.every((part, index) => key[index] === part));
  assert.equal(storedEventKeys.length, 1);
});

const codexSourceAt = (sources: readonly ProviderCapacitySource[], slot: 1 | 2): ProviderCapacityCodexSource | undefined =>
  sources.find((source): source is ProviderCapacityCodexSource => source.source === "codex" && source.slot === slot);

test("capacity endpoint revalidates stale reads and reuses fresh persisted snapshots", async () => {
  seed();
  kvStore.put(promptCacheAnalyticsCounterKey(nowMs, "input_tokens"), { value: 200n } as KvU64);
  kvStore.put(promptCacheAnalyticsCounterKey(nowMs, "cached_input_tokens"), { value: 100n } as KvU64);
  kvStore.put(promptCacheAnalyticsCounterKey(nowMs, "cache_write_input_tokens"), { value: 50n } as KvU64);
  kvStore.put(promptCacheAnalyticsCounterKey(nowMs, "cache_write_reported_sample_count"), { value: 2n } as KvU64);
  kvStore.put(promptCacheAnalyticsCounterKey(nowMs, "sample_count"), { value: 2n } as KvU64);
  const calls: { account: string | null; authorization: string | null; url: string }[] = [];
  const fetcher = createFetcher(calls);

  // Without a persisted snapshot a normal read revalidates instead of serving unavailable.
  const initial = await handleProviderCapacity(new Request("https://ai.ubq.fi/admin/providers/capacity"), {
    kv: kvStub,
    fetcher,
    now: () => nowMs,
  });
  assert.equal(initial.status, 200);
  const initialBody = (await initial.json()) as {
    cache_state?: string;
    prompt_cache?: {
      bucket_ms?: number;
      buckets?: { cached_percentage?: number; cache_write_input_tokens?: number }[];
    };
  };
  assert.equal(initialBody.cache_state, "live");
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((call) => call.url.startsWith("https://api.openlux.ai/api/")).length, 0);
  assert.equal(initialBody.prompt_cache?.bucket_ms, PROMPT_CACHE_ANALYTICS_BUCKET_MS);
  assert.equal(initialBody.prompt_cache.buckets?.[0]?.cached_percentage, 50);
  assert.equal(initialBody.prompt_cache.buckets[0]?.cache_write_input_tokens, 50);

  // A read inside the freshness window serves the persisted snapshot and never probes.
  const fresh = await handleProviderCapacity(new Request("https://ai.ubq.fi/admin/providers/capacity"), {
    kv: kvStub,
    fetcher: () => Promise.reject(new Error("fresh capacity must not fetch")),
    now: () => nowMs + 1_000,
  });
  const freshBody = (await fresh.json()) as { cache_state?: string; history?: unknown[] };
  assert.equal(freshBody.cache_state, "persisted");
  assert.equal(freshBody.history?.length, 1);
  assert.equal(calls.length, 2);

  // `?refresh=live` still forces a probe inside the freshness window.
  const live = await handleProviderCapacity(new Request("https://ai.ubq.fi/admin/providers/capacity?refresh=live"), {
    kv: kvStub,
    fetcher,
    now: () => nowMs + 1_000,
  });
  assert.equal(((await live.json()) as { cache_state?: string }).cache_state, "live");
  assert.equal(calls.length, 5);
  assert.equal(calls.filter((call) => call.url.startsWith("https://api.openlux.ai/api/")).length, 1);
});

test("stale default read delivers the changed upstream Codex quota value", async () => {
  seed();
  let primaryUsed = 80;
  const usage = () => [primaryUsed, 20] as const;
  const staleSnapshotAtMs = nowMs - PROVIDER_CAPACITY_READ_FRESH_MS - 10_000;
  await refreshProviderCapacity({
    kv: kvStub,
    fetcher: createFetcher([], null, {}, usage),
    now: () => staleSnapshotAtMs,
  });
  const before = await getPersistedProviderCapacityView({ kv: kvStub, now: () => staleSnapshotAtMs + 1_000 });
  assert.equal(codexSourceAt(before.sources, 1)?.windows.primary?.used_percent, 80);
  assert.equal(before.cache_state, "persisted");

  primaryUsed = 5;
  const calls: { account: string | null; authorization: string | null; url: string }[] = [];
  const changed = await handleProviderCapacity(new Request("https://ai.ubq.fi/admin/providers/capacity"), {
    kv: kvStub,
    fetcher: createFetcher(calls, null, {}, usage),
    now: () => nowMs,
  });
  const changedBody = (await changed.json()) as { cache_state?: string; sources?: readonly ProviderCapacitySource[] };
  assert.equal(changedBody.cache_state, "live");
  assert.equal(codexSourceAt(changedBody.sources ?? [], 1)?.windows.primary?.used_percent, 5);
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((call) => call.url.startsWith("https://api.openlux.ai/api/")).length, 0);
});

test("event capacity samples still force-refresh Metered quota", async () => {
  seed();
  await refreshProviderCapacity({ kv: kvStub, fetcher: createFetcher([]), now: () => nowMs });

  const calls: { account: string | null; authorization: string | null; url: string }[] = [];
  await sampleProviderCapacityOnEvent({
    kv: kvStub,
    fetcher: createFetcher(calls, null, { total_available: 1_750, total_granted: 2_000, total_used: 250 }),
    now: () => nowMs + 1_000,
    createLeaseOwner: () => "event-metered-refresh",
  });

  assert.equal(calls.filter((call) => call.url.startsWith("https://api.openlux.ai/api/")).length, 1);
});

test("concurrent stale default reads share one upstream refresh", async () => {
  seed();
  // A default (non-`refresh=live`) read only revalidates stale sources. Seed past
  // both the 30s read-freshness window and the Metered wallet's five-minute
  // freshness window, so this refresh genuinely probes both Codex slots and the
  // Metered endpoint (three upstream calls) under the shared lease.
  await refreshProviderCapacity({ kv: kvStub, fetcher: createFetcher([]), now: () => nowMs - METERED_QUOTA_FRESH_MS - 60_000 });
  const calls: { account: string | null; authorization: string | null; url: string }[] = [];
  let releaseFetch = () => {};
  const fetchReleased = new Promise<void>((resolve) => {
    releaseFetch = () => {
      resolve();
    };
  });
  const fetcher = createGatedFetcher(
    createFetcher(calls, null, {}, () => [5, 20]),
    fetchReleased
  );
  const staleRequest = () =>
    handleProviderCapacity(new Request("https://ai.ubq.fi/admin/providers/capacity"), {
      kv: kvStub,
      fetcher,
      now: () => nowMs,
    });

  const firstPromise = staleRequest();
  const waitDeadline = Date.now() + 2_000;
  while (calls.length < 3) {
    assert.ok(Date.now() < waitDeadline, "stale refresh did not issue all provider calls");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const secondPromise = staleRequest();
  // The first read holds the lease while its upstream calls are gated, so the
  // second stale read must coalesce instead of probing again.
  await new Promise((resolve) => setTimeout(resolve, 100));
  releaseFetch();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  const firstBody = (await first.json()) as { sources?: readonly ProviderCapacitySource[] };
  const secondBody = (await second.json()) as { sources?: readonly ProviderCapacitySource[] };
  assert.equal(calls.length, 3);
  assert.equal(codexSourceAt(firstBody.sources ?? [], 1)?.windows.primary?.used_percent, 5);
  assert.equal(codexSourceAt(secondBody.sources ?? [], 1)?.windows.primary?.used_percent, 5);
});

test("failed stale revalidation reports unavailable quota instead of zero", async () => {
  seed();
  await refreshProviderCapacity({ kv: kvStub, fetcher: createFetcher([]), now: () => nowMs - 40_000 });
  const response = await handleProviderCapacity(new Request("https://ai.ubq.fi/admin/providers/capacity"), {
    kv: kvStub,
    fetcher: createFetcher([], "account-one", {}, null, false, 1_800_011_000, 503),
    now: () => nowMs,
  });
  const body = (await response.json()) as { sources?: readonly ProviderCapacitySource[] };
  const failed = codexSourceAt(body.sources ?? [], 1);
  assert.equal(failed?.state, "unavailable");
  assert.equal(failed.failure_status, 503);
  assert.equal(failed.windows.primary, null);
  assert.equal(codexSourceAt(body.sources ?? [], 2)?.state, "available");
});

test("read freshness window stays separate from the fifteen-minute history bucket", async () => {
  seed();
  assert.equal(PROVIDER_CAPACITY_READ_FRESH_MS, 30_000);
  assert.ok(PROVIDER_CAPACITY_READ_FRESH_MS < PROVIDER_CAPACITY_HISTORY_BUCKET_MS);
  const bucketStartAtMs = Math.floor(nowMs / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const read = (now: number) =>
    handleProviderCapacity(new Request("https://ai.ubq.fi/admin/providers/capacity"), {
      kv: kvStub,
      fetcher: createFetcher([]),
      now: () => now,
    });
  await read(nowMs);
  await read(nowMs + 31_000);
  const persisted = await getPersistedProviderCapacityView({ kv: kvStub, now: () => nowMs + 32_000 });
  assert.equal(persisted.history.filter((point) => point.bucket_start_at_ms === bucketStartAtMs).length, 1);
});

// Both concurrent-refresh tests hold their provider calls open until the test releases them.
const createGatedFetcher =
  (
    baseFetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    gate: Promise<void>
  ): ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  async (input, init) => {
    const response = await baseFetcher(input, init);
    await gate;
    return response;
  };

test("concurrent live refreshes coalesce through the durable lease", async () => {
  seed();
  const calls: { account: string | null; authorization: string | null; url: string }[] = [];
  let releaseFetch = () => {};
  const fetchReleased = new Promise<void>((resolve) => {
    releaseFetch = () => {
      resolve();
    };
  });
  const baseFetcher = createFetcher(calls);
  const fetcher = createGatedFetcher(baseFetcher, fetchReleased);

  const firstPromise = refreshProviderCapacity({
    kv: kvStub,
    fetcher,
    now: () => nowMs,
    createLeaseOwner: () => "sampler",
  });
  const waitDeadline = Date.now() + 2_000;
  while (calls.length < 3) {
    assert.ok(Date.now() < waitDeadline, "first refresh did not issue all provider calls");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const secondPromise = refreshProviderCapacity({
    kv: kvStub,
    fetcher,
    now: () => nowMs,
    createLeaseOwner: () => "tab",
  });
  releaseFetch();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(calls.length, 3);
  assert.equal(first.history.length, 1);
  assert.equal(second.history.length, 1);
  assert.equal(kvStore.get(keyToString(PROVIDER_CAPACITY_LEASE_KEY)), undefined);
});

test("partial sampler failures retain redacted downtime evidence for graph bridges", async () => {
  seed();
  const firstCalls: { account: string | null; authorization: string | null; url: string }[] = [];
  await refreshProviderCapacity({ kv: kvStub, fetcher: createFetcher(firstCalls), now: () => nowMs });
  const secondCalls: { account: string | null; authorization: string | null; url: string }[] = [];
  const partial = await refreshProviderCapacity({
    kv: kvStub,
    fetcher: createFetcher(secondCalls, "account-one", {}, null, false, 1_800_011_000, 504),
    now: () => nowMs + PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
  });
  const accountOne = partial.sources.find((source) => source.source === "codex" && source.slot === 1);
  const accountTwo = partial.sources.find((source) => source.source === "codex" && source.slot === 2);
  assert.equal(accountOne?.state, "unavailable");
  assert.equal(accountTwo?.state, "available");
  assert.equal(partial.history.length, 2);
  assert.equal(partial.history[1]?.sources[0]?.state, "unavailable");
  assert.equal(partial.history[1]?.sources[0]?.failure_kind, "upstream_error");
  assert.equal(partial.history[1]?.sources[0]?.failure_status, 504);
  assert.equal(partial.history[1]?.sources[0]?.source_observed_at_ms, nowMs + PROVIDER_CAPACITY_HISTORY_BUCKET_MS);
  assert.equal(partial.history[1]?.sources[0]?.windows.primary, null);
  assert.equal(partial.history[1]?.sources[1]?.windows.secondary?.used_percent, 81.25);
  assert.equal(JSON.stringify(partial).includes("upstream-secret-body"), false);
});

test("downtime evidence is redacted, deduplicated per chart bucket, and retained in the view", async () => {
  seed();
  const firstObservedAtMs = nowMs + 1_000;
  assert.equal(
    await recordProviderCapacityDowntimeEvent(
      {
        failure_kind: "upstream_error",
        status: 504,
        observed_at_ms: firstObservedAtMs,
      },
      kvStub
    ),
    true
  );
  assert.equal(
    await recordProviderCapacityDowntimeEvent(
      {
        failure_kind: "unreachable",
        status: null,
        observed_at_ms: firstObservedAtMs + 1_000,
      },
      kvStub
    ),
    true
  );
  const events = await listProviderCapacityDowntimeEvents({ kv: kvStub, now: () => firstObservedAtMs + 1_000 });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.provider, "openai");
  assert.equal(events[0]?.status, 504);
  assert.equal(
    [...kvStore.keys()].some((key) => key.includes("upstream-secret-body")),
    false
  );
  assert.equal(
    [...kvStore.keys()].filter((key) => {
      const parsed = JSON.parse(key) as KvKey;
      return PROVIDER_CAPACITY_DOWNTIME_EVENT_KV_PREFIX.every((part, index) => parsed[index] === part);
    }).length,
    1
  );
  const view = await getPersistedProviderCapacityView({ kv: kvStub, now: () => firstObservedAtMs + 1_000 });
  assert.deepEqual(view.downtime_events, events);
});

test("persisted Codex data becomes stale after the missed-run allowance", async () => {
  seed();
  await refreshProviderCapacity({ kv: kvStub, fetcher: createFetcher([]), now: () => nowMs });
  const stale = await getPersistedProviderCapacityView({
    kv: kvStub,
    now: () => nowMs + PROVIDER_CAPACITY_SOURCE_STALE_MS,
  });
  assert.equal(stale.cache_state, "stale");
  assert.equal(stale.sources.find((source) => source.source === "codex" && source.slot === 1)?.state, "stale");
  assert.equal(stale.sources.find((source) => source.source === "metered")?.state, "stale");
  assert.equal(stale.history[0]?.sources[0]?.state, "available");
});

test("capacity route requires admin authentication", async () => {
  const { default: handler } = await import("../src/handler/index.ts");
  const response = await handler(new Request("https://ai.ubq.fi/admin/providers/capacity"));
  assert.equal(response.status, 401);
});

const seedCountingCapacityKv = (kv: CountingKv): void => {
  kv.clearData();
  kv.clearMeasurements();
  resetCodexAuthCacheForTest();
  resetCodexAccountRoutingForTest();
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
};

const withCountingCapacityEnvironment = async (run: () => Promise<void>): Promise<void> => {
  const originalApiKey = process.env.METERED_API_KEY;
  process.env.METERED_API_KEY = "metered-api-key";
  try {
    await run();
  } finally {
    setKvForTest(kvStub);
    resetCodexAuthCacheForTest();
    resetCodexAccountRoutingForTest();
    if (originalApiKey === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalApiKey;
  }
};

test("event sampler persists capacity without building the discarded admin projection", async () => {
  await withCountingCapacityEnvironment(async () => {
    const samplerKv = new CountingKv();
    seedCountingCapacityKv(samplerKv);
    setKvForTest(samplerKv as unknown as Kv);
    const samplerCalls: { account: string | null; authorization: string | null; url: string }[] = [];
    const finishSamplerBudget = samplerKv.beginMeasurement({ authKind: "background", outcome: "capacity_sampler" });
    await sampleProviderCapacityOnEvent({
      kv: samplerKv as unknown as Kv,
      fetcher: createFetcher(samplerCalls),
      now: () => nowMs,
      createLeaseOwner: () => "event-sampler",
    });
    finishSamplerBudget();

    const samplerBudget = samplerKv.budgets()[0];
    assert.ok(samplerBudget);
    assert.equal(samplerCalls.length, 3);
    assert.equal(
      samplerKv.commands.filter((command) => command.scenario === "background:capacity_sampler" && command.command === "list").length,
      0,
      "the event sampler must not enumerate history or reset-event projection prefixes"
    );
    // The quota refresh inside a sample also appends at most one hourly
    // balance-history read plus one upsert; the rollup read is the 23rd command.
    assert.ok(samplerBudget.commands <= 23, `event sampler budget unexpectedly grew to ${samplerBudget.commands} KV commands`);
    assert.notEqual((await samplerKv.get(PROVIDER_CAPACITY_SNAPSHOT_KEY)).value, null);
    assert.notEqual((await samplerKv.get(providerCapacityHistoryKey(nowMs))).value, null);
    assert.notEqual((await samplerKv.get(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY)).value, null);
    assert.equal((await samplerKv.get(PROVIDER_CAPACITY_LEASE_KEY)).value, null);

    const stale = await getPersistedProviderCapacityView({
      kv: samplerKv as unknown as Kv,
      now: () => nowMs + PROVIDER_CAPACITY_SOURCE_STALE_MS,
    });
    assert.equal(stale.cache_state, "stale");

    const liveRefreshKv = new CountingKv();
    seedCountingCapacityKv(liveRefreshKv);
    setKvForTest(liveRefreshKv as unknown as Kv);
    const liveRefreshCalls: { account: string | null; authorization: string | null; url: string }[] = [];
    const finishLiveRefreshBudget = liveRefreshKv.beginMeasurement({
      authKind: "background",
      outcome: "capacity_view",
    });
    await refreshProviderCapacity({
      kv: liveRefreshKv as unknown as Kv,
      fetcher: createFetcher(liveRefreshCalls),
      now: () => nowMs,
      createLeaseOwner: () => "live-refresh",
    });
    finishLiveRefreshBudget();

    const liveRefreshBudget = liveRefreshKv.budgets()[0];
    assert.ok(liveRefreshBudget);
    assert.equal(liveRefreshCalls.length, 3);
    assert.ok(
      liveRefreshKv.commands.filter((command) => command.scenario === "background:capacity_view" && command.command === "list").length >= 8,
      "the full admin view should retain its history and reset-event projections"
    );
    assert.ok(liveRefreshBudget.commands - samplerBudget.commands >= 10, "the sampler-only path must retain the measured projection reduction");
  });
});

test("event sampler preserves a same-bucket reset transition", async () => {
  await withCountingCapacityEnvironment(async () => {
    const countingKv = new CountingKv();
    seedCountingCapacityKv(countingKv);
    setKvForTest(countingKv as unknown as Kv);
    let phase = 0;
    const calls: { account: string | null; authorization: string | null; url: string }[] = [];
    const fetcher = createFetcher(calls, null, {}, () => (phase === 0 ? [100, 100] : [0, 0]));

    await sampleProviderCapacityOnEvent({
      kv: countingKv as unknown as Kv,
      fetcher,
      now: () => nowMs,
      createLeaseOwner: () => "exhausted",
    });
    phase = 1;
    await sampleProviderCapacityOnEvent({
      kv: countingKv as unknown as Kv,
      fetcher,
      now: () => nowMs + 1_000,
      createLeaseOwner: () => "refilled",
    });

    const view = await getPersistedProviderCapacityView({
      kv: countingKv as unknown as Kv,
      now: () => nowMs + 1_000,
    });
    assert.equal(calls.length, 6);
    assert.deepEqual(
      view.history.map((point) => point.sampled_at_ms),
      [nowMs, nowMs + 1_000]
    );
    assert.equal(view.history[0]?.sources[0]?.windows.primary?.used_percent, 100);
    assert.equal(view.history[1]?.sources[0]?.windows.primary?.used_percent, 0);
  });
});

test("concurrent event samplers keep one provider probe under the durable lease", async () => {
  await withCountingCapacityEnvironment(async () => {
    const countingKv = new CountingKv();
    seedCountingCapacityKv(countingKv);
    setKvForTest(countingKv as unknown as Kv);
    const calls: { account: string | null; authorization: string | null; url: string }[] = [];
    let releaseFetch = (): void => {};
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const baseFetcher = createFetcher(calls);
    const fetcher = createGatedFetcher(baseFetcher, fetchReleased);

    const first = sampleProviderCapacityOnEvent({
      kv: countingKv as unknown as Kv,
      fetcher,
      now: () => nowMs,
      createLeaseOwner: () => "first-event",
    });
    const waitDeadline = Date.now() + 2_000;
    while (calls.length < 3) {
      assert.ok(Date.now() < waitDeadline, "first event sampler did not issue all provider calls");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const second = sampleProviderCapacityOnEvent({
      kv: countingKv as unknown as Kv,
      fetcher,
      now: () => nowMs,
      createLeaseOwner: () => "second-event",
    });
    releaseFetch();
    await Promise.all([first, second]);

    assert.equal(calls.length, 3);
    assert.equal((await countingKv.get(PROVIDER_CAPACITY_LEASE_KEY)).value, null);
    assert.equal(countingKv.commands.filter((command) => command.command === "list").length, 0);
  });
});
