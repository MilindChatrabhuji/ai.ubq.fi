import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";

import type { Kv, KvKey } from "#kv";
import { config } from "../src/config.ts";
import { setKvForTest } from "../src/kv.ts";
import { PROVIDER_CAPACITY_HISTORY_BUCKET_MS, type ProviderCapacityCodexSource, type ProviderCapacityHistoryPoint } from "../src/provider/capacity-contract.ts";
import { REMOTE_CAPACITY_OBSERVATION_PREFIX } from "../src/provider/capacity-analytics.ts";

// POST /admin/providers/capacity/observations through the real route table and
// admin authentication, not the handler function alone.
const { default: handler } = await import("../src/handler/index.ts");

const ADMIN_TOKEN = "capacity-observation-route-admin-token";
const ROUTE_URL = "https://ai.ubq.fi/admin/providers/capacity/observations";

const keyId = (key: KvKey): string => JSON.stringify(key);
const startsWith = (key: KvKey, prefix: KvKey): boolean => prefix.every((part, index) => key[index] === part);

/** In-memory KV with the operations the admin request path uses. */
const createMemoryKv = () => {
  const rows = new Map<string, { key: KvKey; value: unknown }>();
  const entry = (key: KvKey) => {
    const row = rows.get(keyId(key));
    return { key, value: row ? row.value : null, versionstamp: row ? "00000000000000000001" : null };
  };
  const kv = {
    get: (key: KvKey) => Promise.resolve(entry(key)),
    getMany: (keys: KvKey[]) => Promise.resolve(keys.map(entry)),
    set: (key: KvKey, value: unknown) => {
      rows.set(keyId(key), { key: [...key], value });
      return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" });
    },
    delete: (key: KvKey) => {
      rows.delete(keyId(key));
      return Promise.resolve();
    },
    list: ({ prefix }: { prefix: KvKey }) => {
      const matches = [...rows.values()].filter((row) => startsWith(row.key, prefix));
      return (function* () {
        for (const row of matches) yield { key: row.key, value: row.value, versionstamp: "00000000000000000001" };
      })();
    },
    atomic: () => {
      const writes: (() => void)[] = [];
      const operation = {
        check: () => operation,
        set: (key: KvKey, value: unknown) => {
          writes.push(() => rows.set(keyId(key), { key: [...key], value }));
          return operation;
        },
        delete: (key: KvKey) => {
          writes.push(() => rows.delete(keyId(key)));
          return operation;
        },
        sum: () => operation,
        commit: () => {
          for (const write of writes) write();
          return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" });
        },
      };
      return operation;
    },
    close: () => {},
  };
  return { kv: kv as unknown as Kv, rows };
};

const codex = (slot: 1 | 2, sampledAtMs: number): ProviderCapacityCodexSource => ({
  source: "codex",
  label: `slot ${slot}`,
  slot,
  account_cohort_id: String(slot).repeat(64),
  state: "available",
  source_observed_at_ms: sampledAtMs,
  snapshot_at_ms: sampledAtMs,
  failure_kind: null,
  failure_status: null,
  windows: { primary: { limit_window_seconds: 604_800, used_percent: 10, reset_at_ms: sampledAtMs + 60_000 }, secondary: null },
  additional_rate_limits: [],
});

const recentPoint = (): ProviderCapacityHistoryPoint => {
  const bucketStartAtMs =
    Math.floor(Date.now() / PROVIDER_CAPACITY_HISTORY_BUCKET_MS) * PROVIDER_CAPACITY_HISTORY_BUCKET_MS - PROVIDER_CAPACITY_HISTORY_BUCKET_MS;
  const sampledAtMs = bucketStartAtMs + 1_000;
  return {
    bucket_start_at_ms: bucketStartAtMs,
    sampled_at_ms: sampledAtMs,
    sources: [
      codex(1, sampledAtMs),
      codex(2, sampledAtMs),
      {
        source: "metered",
        label: "Metered fallback",
        state: "unavailable",
        source_observed_at_ms: null,
        snapshot_at_ms: sampledAtMs,
        wallet: {
          balance_credits: null,
          baseline_credits: null,
          refill_cycle_remaining_percent: null,
          refill_cycle_used_percent: null,
          unlimited_quota: null,
          total_available: null,
          total_granted: null,
          total_used: null,
          cycle_started_at_ms: null,
          last_credit_at_ms: null,
          confidence: null,
          cache_state: null,
          reset_at_ms: null,
        },
      },
    ],
  };
};

const push = (body: unknown, headers: Record<string, string> = {}, method = "POST"): Promise<Response> =>
  handler(
    new Request(ROUTE_URL, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    })
  );

const remoteRows = (rows: Map<string, { key: KvKey; value: unknown }>): KvKey[] =>
  [...rows.values()].filter((row) => startsWith(row.key, REMOTE_CAPACITY_OBSERVATION_PREFIX)).map((row) => row.key);

let memory = createMemoryKv();
const adminTokens = config.adminTokens as Set<string>;

beforeEach(() => {
  memory = createMemoryKv();
  setKvForTest(memory.kv);
  adminTokens.add(ADMIN_TOKEN);
});

afterEach(() => {
  adminTokens.delete(ADMIN_TOKEN);
  setKvForTest(null);
});

test("the capacity observation route refuses an unauthenticated push", async () => {
  const point = recentPoint();
  const attempts: Record<string, string>[] = [{}, { Authorization: "Bearer not-an-admin-token" }];
  for (const headers of attempts) {
    const response = await push({ host: "mac", history: [point] }, headers);
    assert.equal(response.status, 401);
    await response.body?.cancel();
  }
  assert.deepEqual(remoteRows(memory.rows), []);
});

test("an admin push through the route is stored under its host, bucket and sample", async () => {
  const point = recentPoint();
  const response = await push({ host: "mac", history: [point] }, { Authorization: `Bearer ${ADMIN_TOKEN}` });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, host: "mac" });
  assert.deepEqual(remoteRows(memory.rows), [[...REMOTE_CAPACITY_OBSERVATION_PREFIX, "mac", point.bucket_start_at_ms, point.sampled_at_ms]]);
});

test("the route rejects a malformed admin push without storing it", async () => {
  const point = recentPoint();
  const response = await push(
    { host: "mac", history: [{ ...point, bucket_start_at_ms: point.bucket_start_at_ms + 1 }] },
    { Authorization: `Bearer ${ADMIN_TOKEN}` }
  );
  assert.equal(response.status, 400);
  await response.body?.cancel();
  assert.deepEqual(remoteRows(memory.rows), []);
});

test("the observation route accepts POST only", async () => {
  const response = await push(null, { Authorization: `Bearer ${ADMIN_TOKEN}` }, "GET");
  assert.notEqual(response.status, 200);
  await response.body?.cancel();
  assert.deepEqual(remoteRows(memory.rows), []);
});
