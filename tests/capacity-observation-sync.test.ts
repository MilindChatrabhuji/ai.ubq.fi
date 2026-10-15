import assert from "node:assert/strict";

import { handleCapacityObservationIngest } from "../src/admin/capacity-observation-sync.ts";
import type { ProviderCapacityHistoryPoint } from "../src/provider/capacity-contract.ts";
import {
  isRemoteCapacityHostId,
  mergeCapacityHistory,
  parseRemoteCapacityObservations,
  readRemoteCapacityObservations,
  storeRemoteCapacityObservations,
} from "../src/provider/capacity-analytics.ts";

const COHORT_A = "a".repeat(64);
const COHORT_B = "b".repeat(64);

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

const createFakeKv = (): { kv: Deno.Kv; rows: Map<string, { key: Deno.KvKey; value: unknown }> } => {
  const rows = new Map<string, { key: Deno.KvKey; value: unknown }>();
  const keyId = (key: Deno.KvKey): string => JSON.stringify(key);
  const matchesPrefix = (key: Deno.KvKey, prefix: Deno.KvKey): boolean => prefix.every((part, index) => key[index] === part);
  const fake = {
    set(key: Deno.KvKey, value: unknown) {
      rows.set(keyId(key), { key: [...key], value });
      return Promise.resolve({ ok: true, versionstamp: "1" });
    },
    list({ prefix }: { prefix: Deno.KvKey }) {
      const entries = [...rows.values()].filter((entry) => matchesPrefix(entry.key, prefix));
      return (function* () {
        for (const entry of entries) yield { key: entry.key, value: entry.value, versionstamp: "1" };
      })();
    },
  };
  return { kv: fake as unknown as Deno.Kv, rows };
};

Deno.test("remote capacity host ids stay bounded lowercase labels", () => {
  assert.equal(isRemoteCapacityHostId("mac"), true);
  assert.equal(isRemoteCapacityHostId("mac-1"), true);
  assert.equal(isRemoteCapacityHostId("Mac"), false);
  assert.equal(isRemoteCapacityHostId(""), false);
  assert.equal(isRemoteCapacityHostId("a".repeat(33)), false);
});

Deno.test("remote capacity observations reject any malformed row", () => {
  const valid = historyPoint(0, 1_000, 7);
  assert.equal(parseRemoteCapacityObservations([valid])?.length, 1);
  assert.equal(parseRemoteCapacityObservations([]), null);
  assert.equal(parseRemoteCapacityObservations([{ ...valid, bucket_start_at_ms: -1 }]), null);
  assert.equal(parseRemoteCapacityObservations([valid, { nope: true }]), null);
});

Deno.test("remote capacity observations persist in the analytics namespace", async () => {
  const { kv } = createFakeKv();
  const accepted = await storeRemoteCapacityObservations(kv, "mac", [historyPoint(0, 1_000, 7), historyPoint(900_000, 1_001_000, 0)], 2_000_000);
  assert.equal(accepted, 2);
  const read = await readRemoteCapacityObservations(kv, 2_000_000);
  assert.deepEqual(
    read.map((point) => point.bucket_start_at_ms),
    [0, 900_000]
  );
});

Deno.test("remote capacity observations drop points outside the seven-day retention", async () => {
  const { kv } = createFakeKv();
  const nowMs = 8 * 24 * 60 * 60_000;
  const accepted = await storeRemoteCapacityObservations(kv, "mac", [historyPoint(0, 1_000, 7), historyPoint(nowMs - 60_000, nowMs - 59_000, 0)], nowMs);
  assert.equal(accepted, 1);
  const read = await readRemoteCapacityObservations(kv, nowMs);
  assert.equal(read.length, 1);
  assert.equal(read[0]?.bucket_start_at_ms, nowMs - 60_000);
});

Deno.test("capacity history merge keeps the union and prefers the local duplicate", () => {
  const merged = mergeCapacityHistory([historyPoint(0, 1_000, 7)], [historyPoint(0, 1_000, 99), historyPoint(900_000, 1_001_000, 0)]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((point) => point.sampled_at_ms === 1_000)?.sources[0]?.windows.primary?.used_percent, 7);
  assert.equal(merged.find((point) => point.sampled_at_ms === 1_001_000)?.sources[0]?.windows.primary?.used_percent, 0);
});

Deno.test("capacity observation ingest validates and stores a batch", async () => {
  const { kv } = createFakeKv();
  const response = await handleCapacityObservationIngest(
    new Request("https://ai.ubq.fi/admin/providers/capacity/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "mac", history: [historyPoint(1_000_000, 1_001_000, 7)] }),
    }),
    { kv, now: () => 1_002_000 }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, host: "mac" });
  assert.equal((await readRemoteCapacityObservations(kv, 1_002_000)).length, 1);
});

Deno.test("capacity observation ingest rejects invalid hosts and malformed rows", async () => {
  const { kv } = createFakeKv();
  const invalidHost = await handleCapacityObservationIngest(
    new Request("https://ai.ubq.fi/admin/providers/capacity/observations", {
      method: "POST",
      body: JSON.stringify({ host: "Mac!", history: [historyPoint(0, 1_000, 7)] }),
    }),
    { kv, now: () => 1_000 }
  );
  assert.equal(invalidHost.status, 400);
  const invalidRow = await handleCapacityObservationIngest(
    new Request("https://ai.ubq.fi/admin/providers/capacity/observations", {
      method: "POST",
      body: JSON.stringify({ host: "mac", history: [{ nope: true }] }),
    }),
    { kv, now: () => 1_000 }
  );
  assert.equal(invalidRow.status, 400);
});
