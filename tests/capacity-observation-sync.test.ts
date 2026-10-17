import { test } from "bun:test";
import assert from "node:assert/strict";

import type { Kv, KvKey } from "#kv";
import { handleCapacityObservationIngest } from "../src/admin/capacity-observation-sync.ts";
import {
  PROVIDER_CAPACITY_HISTORY_BUCKET_MS,
  PROVIDER_CAPACITY_HISTORY_RETENTION_MS,
  type ProviderCapacityCodexSource,
  type ProviderCapacityHistoryPoint,
} from "../src/provider/capacity-contract.ts";
import {
  isRemoteCapacityHostId,
  MAX_REMOTE_CAPACITY_OBSERVATIONS,
  mergeCapacityHistory,
  parseRemoteCapacityObservations,
  readRemoteCapacityObservations,
  REMOTE_CAPACITY_OBSERVATION_PREFIX,
  type RemoteCapacityObservation,
  storeRemoteCapacityObservations,
} from "../src/provider/capacity-analytics.ts";

const COHORT_A = "a".repeat(64);
const COHORT_B = "b".repeat(64);
const COHORT_C = "c".repeat(64);
const BUCKET_MS = PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
const bucket = (index: number): number => index * BUCKET_MS;

const historyPoint = (bucketStartAtMs: number, sampledAtMs: number, usedPercent: number): ProviderCapacityHistoryPoint => ({
  bucket_start_at_ms: bucketStartAtMs,
  sampled_at_ms: sampledAtMs,
  sources: [
    {
      source: "codex",
      label: "p***@gmail.com",
      slot: 1,
      account_cohort_id: COHORT_A,
      state: "available",
      source_observed_at_ms: sampledAtMs,
      snapshot_at_ms: sampledAtMs,
      failure_kind: null,
      failure_status: null,
      windows: { primary: { limit_window_seconds: 604_800, used_percent: usedPercent, reset_at_ms: sampledAtMs + 1_000 }, secondary: null },
      additional_rate_limits: [],
    },
    {
      source: "codex",
      label: "u***@gmail.com",
      slot: 2,
      account_cohort_id: COHORT_B,
      state: "available",
      source_observed_at_ms: sampledAtMs,
      snapshot_at_ms: sampledAtMs,
      failure_kind: null,
      failure_status: null,
      windows: { primary: { limit_window_seconds: 604_800, used_percent: usedPercent + 1, reset_at_ms: sampledAtMs + 2_000 }, secondary: null },
      additional_rate_limits: [],
    },
    {
      source: "metered",
      label: "Metered fallback",
      state: "available",
      source_observed_at_ms: sampledAtMs,
      snapshot_at_ms: sampledAtMs,
      wallet: {
        balance_credits: null,
        baseline_credits: null,
        refill_cycle_remaining_percent: null,
        refill_cycle_used_percent: null,
        unlimited_quota: true,
        total_available: 0,
        total_granted: 0,
        total_used: 0,
        cycle_started_at_ms: null,
        last_credit_at_ms: null,
        confidence: null,
        cache_state: "fresh",
        reset_at_ms: null,
      },
    },
  ],
});

/** Replaces one Codex slot of a fixture point. */
const withSlot = (point: ProviderCapacityHistoryPoint, slot: 1 | 2, patch: Partial<ProviderCapacityCodexSource>): ProviderCapacityHistoryPoint => {
  const [one, two, metered] = point.sources;
  return {
    ...point,
    sources:
      slot === 1 ? [{ ...one, ...patch } as ProviderCapacityCodexSource, two, metered] : [one, { ...two, ...patch } as ProviderCapacityCodexSource, metered],
  };
};

const unreachable = (point: ProviderCapacityHistoryPoint, slot: 1 | 2): ProviderCapacityHistoryPoint =>
  withSlot(point, slot, { state: "unavailable", failure_kind: "unreachable", windows: { primary: null, secondary: null } });

const notConfigured = (point: ProviderCapacityHistoryPoint, slot: 1 | 2): ProviderCapacityHistoryPoint =>
  withSlot(point, slot, { state: "unavailable", failure_kind: "not_configured", account_cohort_id: null, windows: { primary: null, secondary: null } });

const remote = (point: ProviderCapacityHistoryPoint, host = "mac"): RemoteCapacityObservation => ({ host, point });

const createFakeKv = () => {
  const rows = new Map<string, { key: KvKey; value: unknown }>();
  const stats = { directSets: 0, commits: 0, largestCommit: 0 };
  const keyId = (key: KvKey): string => JSON.stringify(key);
  const write = (key: KvKey, value: unknown): void => {
    rows.set(keyId(key), { key: [...key], value });
  };
  const matchesPrefix = (key: KvKey, prefix: KvKey): boolean => prefix.every((part, index) => key[index] === part);
  const fake = {
    set(key: KvKey, value: unknown) {
      stats.directSets += 1;
      write(key, value);
      return Promise.resolve({ ok: true, versionstamp: "1" });
    },
    atomic() {
      const pending: [KvKey, unknown][] = [];
      const operation = {
        set(key: KvKey, value: unknown) {
          pending.push([key, value]);
          return operation;
        },
        commit() {
          stats.commits += 1;
          stats.largestCommit = Math.max(stats.largestCommit, pending.length);
          for (const [key, value] of pending) write(key, value);
          return Promise.resolve({ ok: true, versionstamp: "1" });
        },
      };
      return operation;
    },
    list({ prefix }: { prefix: KvKey }) {
      const entries = [...rows.values()].filter((entry) => matchesPrefix(entry.key, prefix));
      return (function* () {
        for (const entry of entries) yield { key: entry.key, value: entry.value, versionstamp: "1" };
      })();
    },
  };
  return { kv: fake as unknown as Kv, rows, stats };
};

const ingest = (kv: Kv, body: unknown, nowMs: number): Promise<Response> =>
  handleCapacityObservationIngest(
    new Request("https://ai.ubq.fi/admin/providers/capacity/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { kv, now: () => nowMs }
  );

test("remote capacity host ids stay bounded lowercase labels", () => {
  assert.equal(isRemoteCapacityHostId("mac"), true);
  assert.equal(isRemoteCapacityHostId("mac-1"), true);
  assert.equal(isRemoteCapacityHostId("Mac"), false);
  assert.equal(isRemoteCapacityHostId(""), false);
  assert.equal(isRemoteCapacityHostId("a".repeat(33)), false);
});

test("remote capacity observations reject any malformed row", () => {
  const valid = historyPoint(bucket(1), bucket(1) + 1_000, 7);
  assert.equal(parseRemoteCapacityObservations([valid])?.length, 1);
  assert.equal(parseRemoteCapacityObservations([]), null);
  assert.equal(parseRemoteCapacityObservations([{ ...valid, bucket_start_at_ms: -1 }]), null);
  assert.equal(parseRemoteCapacityObservations([valid, { nope: true }]), null);
});

test("remote capacity observations reject unaligned buckets, samples outside their bucket, and oversized batches", () => {
  const valid = historyPoint(bucket(1), bucket(1) + 1_000, 7);
  // A bucket that does not start on a fifteen-minute boundary.
  assert.equal(parseRemoteCapacityObservations([historyPoint(bucket(1) + 1, bucket(1) + 1_000, 7)]), null);
  // A sample taken before its bucket starts, or in the next bucket.
  assert.equal(parseRemoteCapacityObservations([historyPoint(bucket(1), bucket(1) - 1, 7)]), null);
  assert.equal(parseRemoteCapacityObservations([historyPoint(bucket(1), bucket(2), 7)]), null);
  assert.equal(parseRemoteCapacityObservations([historyPoint(bucket(1), bucket(2) - 1, 7)])?.length, 1);
  // One request carries less than a full week of buckets, so a whole-history re-push cannot fit in one batch.
  assert.ok(MAX_REMOTE_CAPACITY_OBSERVATIONS < PROVIDER_CAPACITY_HISTORY_RETENTION_MS / BUCKET_MS);
  const full = Array.from({ length: MAX_REMOTE_CAPACITY_OBSERVATIONS }, (_, index) => historyPoint(bucket(index), bucket(index) + 1, 7));
  assert.equal(parseRemoteCapacityObservations(full)?.length, MAX_REMOTE_CAPACITY_OBSERVATIONS);
  assert.equal(parseRemoteCapacityObservations([...full, valid]), null);
  // A single oversized row is refused before it reaches KV.
  assert.equal(parseRemoteCapacityObservations([withSlot(valid, 1, { label: "x".repeat(64 * 1024) })]), null);
});

test("remote capacity observations persist in the analytics namespace with their host", async () => {
  const { kv } = createFakeKv();
  const accepted = await storeRemoteCapacityObservations(
    kv,
    "mac",
    [historyPoint(bucket(0), 1_000, 7), historyPoint(bucket(1), bucket(1) + 1_000, 0)],
    bucket(2)
  );
  assert.equal(accepted, 2);
  const read = await readRemoteCapacityObservations(kv, bucket(2));
  assert.deepEqual(
    read.map(({ host, point }) => [host, point.bucket_start_at_ms]),
    [
      ["mac", bucket(0)],
      ["mac", bucket(1)],
    ]
  );
});

test("remote capacity observations keep same-bucket transition points", async () => {
  const { kv, rows } = createFakeKv();
  const exhausted = historyPoint(bucket(1), bucket(1) + 1_000, 100);
  const refilled = historyPoint(bucket(1), bucket(1) + 600_000, 0);
  assert.equal(await storeRemoteCapacityObservations(kv, "mac", [exhausted, refilled], bucket(2)), 2);
  const read = await readRemoteCapacityObservations(kv, bucket(2));
  assert.deepEqual(
    read.map(({ point }) => point.sampled_at_ms),
    [exhausted.sampled_at_ms, refilled.sampled_at_ms]
  );
  assert.deepEqual(
    [...rows.values()].map(({ key }) => key),
    [
      [...REMOTE_CAPACITY_OBSERVATION_PREFIX, "mac", bucket(1), exhausted.sampled_at_ms],
      [...REMOTE_CAPACITY_OBSERVATION_PREFIX, "mac", bucket(1), refilled.sampled_at_ms],
    ]
  );
});

test("remote capacity observation writes are committed in bounded atomic batches", async () => {
  const { kv, stats } = createFakeKv();
  const points = Array.from({ length: 130 }, (_, index) => historyPoint(bucket(index), bucket(index) + 1, 7));
  assert.equal(await storeRemoteCapacityObservations(kv, "mac", points, bucket(200)), 130);
  assert.equal(stats.directSets, 0);
  assert.ok(stats.commits >= 2 && stats.commits <= 3, `commits: ${stats.commits}`);
  assert.ok(stats.largestCommit <= 64, `largest commit: ${stats.largestCommit}`);
  assert.equal((await readRemoteCapacityObservations(kv, bucket(200))).length, 130);
});

test("remote capacity observations drop points outside the seven-day retention", async () => {
  const { kv } = createFakeKv();
  const nowMs = 8 * 24 * 60 * 60_000;
  const recentBucket = nowMs - BUCKET_MS;
  const accepted = await storeRemoteCapacityObservations(kv, "mac", [historyPoint(0, 1_000, 7), historyPoint(recentBucket, recentBucket + 1_000, 0)], nowMs);
  assert.equal(accepted, 1);
  const read = await readRemoteCapacityObservations(kv, nowMs);
  assert.equal(read.length, 1);
  assert.equal(read[0]?.point.bucket_start_at_ms, recentBucket);
});

test("pushed samples fill only empty VPS buckets, and only when available", () => {
  const local = [historyPoint(bucket(0), bucket(0) + 1_000, 7), historyPoint(bucket(3), bucket(3) + 1_000, 9)];
  const merged = mergeCapacityHistory(local, [
    // The VPS already observed this bucket: its own sample stays canonical.
    remote(historyPoint(bucket(0), bucket(0) + 5_000, 99)),
    // An available sample with the same slot accounts fills the gap, including its same-bucket transition point.
    remote(historyPoint(bucket(1), bucket(1) + 1_000, 100)),
    remote(historyPoint(bucket(1), bucket(1) + 600_000, 0)),
    // The Mac's own unreachable or 401 sample is not a VPS outage and never enters the chart.
    remote(unreachable(historyPoint(bucket(2), bucket(2) + 1_000, 8), 1)),
    remote(withSlot(historyPoint(bucket(2), bucket(2) + 2_000, 8), 2, { state: "unavailable", failure_kind: "http_error", failure_status: 401 })),
  ]);
  assert.deepEqual(
    merged.map((point) => [point.bucket_start_at_ms, point.sampled_at_ms]),
    [
      [bucket(0), bucket(0) + 1_000],
      [bucket(1), bucket(1) + 1_000],
      [bucket(1), bucket(1) + 600_000],
      [bucket(3), bucket(3) + 1_000],
    ]
  );
  assert.equal(merged[0]?.sources[0].windows.primary?.used_percent, 7);
});

test("pushed samples from other slot accounts never fill a VPS gap", () => {
  const before = historyPoint(bucket(0), bucket(0) + 1_000, 7);
  const after = withSlot(historyPoint(bucket(4), bucket(4) + 1_000, 7), 1, { account_cohort_id: COHORT_C });
  const merged = mergeCapacityHistory(
    [before, after],
    [
      // Matches the preceding VPS sample.
      remote(historyPoint(bucket(1), bucket(1) + 1_000, 8)),
      // Matches the following VPS sample after the VPS slot moved to another account.
      remote(withSlot(historyPoint(bucket(3), bucket(3) + 1_000, 8), 1, { account_cohort_id: COHORT_C })),
      // A Mac slot bound to an account neither neighbour shows would zig-zag the series.
      remote(withSlot(historyPoint(bucket(2), bucket(2) + 1_000, 8), 2, { account_cohort_id: COHORT_C })),
      // An unknown cohort cannot be matched.
      remote(withSlot(historyPoint(bucket(2), bucket(2) + 2_000, 8), 1, { account_cohort_id: null })),
      // A slot the VPS has not configured.
      remote(notConfigured(historyPoint(bucket(2), bucket(2) + 3_000, 8), 2)),
    ]
  );
  assert.deepEqual(
    merged.map((point) => point.bucket_start_at_ms),
    [bucket(0), bucket(1), bucket(3), bucket(4)]
  );
});

test("pushed samples match an unconfigured slot only against an unconfigured VPS slot", () => {
  const local = [notConfigured(historyPoint(bucket(0), bucket(0) + 1_000, 7), 2)];
  const merged = mergeCapacityHistory(local, [
    remote(notConfigured(historyPoint(bucket(1), bucket(1) + 1_000, 8), 2)),
    remote(historyPoint(bucket(2), bucket(2) + 1_000, 8)),
  ]);
  assert.deepEqual(
    merged.map((point) => point.bucket_start_at_ms),
    [bucket(0), bucket(1)]
  );
});

test("one observer fills a VPS gap bucket, and a VPS with no samples takes none", () => {
  const local = [historyPoint(bucket(0), bucket(0) + 1_000, 7)];
  const merged = mergeCapacityHistory(local, [
    remote(historyPoint(bucket(1), bucket(1) + 2_000, 50), "mac-studio"),
    remote(historyPoint(bucket(1), bucket(1) + 1_000, 8), "mac"),
    remote(historyPoint(bucket(1), bucket(1) + 1_000, 8), "mac"),
  ]);
  assert.deepEqual(
    merged.map((point) => point.sampled_at_ms),
    [bucket(0) + 1_000, bucket(1) + 1_000]
  );
  assert.deepEqual(mergeCapacityHistory([], [remote(historyPoint(bucket(1), bucket(1) + 1_000, 8))]), []);
});

test("capacity observation ingest validates and stores a batch", async () => {
  const { kv } = createFakeKv();
  const response = await ingest(kv, { host: "mac", history: [historyPoint(bucket(1), bucket(1) + 1_000, 7)] }, bucket(2));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, host: "mac" });
  assert.equal((await readRemoteCapacityObservations(kv, bucket(2))).length, 1);
});

test("capacity observation ingest rejects invalid hosts and malformed rows", async () => {
  const { kv, rows } = createFakeKv();
  const nowMs = bucket(2);
  assert.equal((await ingest(kv, { host: "Mac!", history: [historyPoint(bucket(1), bucket(1) + 1_000, 7)] }, nowMs)).status, 400);
  assert.equal((await ingest(kv, { host: "mac", history: [{ nope: true }] }, nowMs)).status, 400);
  assert.equal((await ingest(kv, { host: "mac", history: [historyPoint(bucket(1) + 1, bucket(1) + 1_000, 7)] }, nowMs)).status, 400);
  assert.equal(rows.size, 0);
});

test("capacity observation ingest reports a failed write instead of a partial acknowledgement", async () => {
  const { kv } = createFakeKv();
  const failing = {
    ...kv,
    list: kv.list.bind(kv),
    atomic: () => {
      throw new Error("database is locked");
    },
    set: () => Promise.reject(new Error("database is locked")),
  } as unknown as Kv;
  const response = await ingest(failing, { host: "mac", history: [historyPoint(bucket(1), bucket(1) + 1_000, 7)] }, bucket(2));
  assert.equal(response.status, 503);
});
