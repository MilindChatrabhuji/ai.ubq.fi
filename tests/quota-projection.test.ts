import { createFetchMock } from "./helpers/fetch-mock.ts";
import type {
  AtomicOperation,
  Kv,
  KvCommitError,
  KvCommitResult,
  KvEntry,
  KvEntryMaybe,
  KvKey,
  KvKeyPart,
  KvListIterator,
  KvListOptions,
  KvListSelector,
} from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import { setKvForTest } from "../src/kv.ts";
import assert from "node:assert/strict";
import type { PaidFallbackUsageRollup } from "../src/paid-fallback/rollups.ts";

type StoredEntry = {
  key: KvKey;
  value: unknown;
  versionstamp: string;
  expiresAtMs: number | null;
};

const encodeKey = (key: KvKey): string => JSON.stringify(key);
const clone = <T>(value: T): T => structuredClone(value);

const compareKeyPart = (left: KvKeyPart, right: KvKeyPart): number => {
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : 1;
};

const compareKeys = (left: KvKey, right: KvKey): number => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const comparison = compareKeyPart(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
};

const startsWithKey = (key: KvKey, prefix: KvKey): boolean => prefix.every((part, index) => key[index] === part);

class MemoryKv {
  readonly entries = new Map<string, StoredEntry>();
  #version = 0;
  /** When set, the next atomic commit fails once (simulated CAS conflict). */
  atomicConflictOnce = false;

  #nextVersionstamp(): string {
    this.#version += 1;
    return String(this.#version).padStart(20, "0");
  }

  #purgeExpired(): void {
    const now = Date.now();
    for (const [encodedKey, entry] of this.entries) {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= now) {
        this.entries.delete(encodedKey);
      }
    }
  }

  #write(key: KvKey, value: unknown, options: { expireIn?: number } | undefined, versionstamp: string): void {
    const expireIn = options?.expireIn;
    const expiresAtMs = typeof expireIn === "number" ? Date.now() + Math.max(0, expireIn) : null;
    this.entries.set(encodeKey(key), {
      key: clone(key),
      value: clone(value),
      versionstamp,
      expiresAtMs,
    });
  }

  versionstamp(key: KvKey): string | null {
    this.#purgeExpired();
    return this.entries.get(encodeKey(key))?.versionstamp ?? null;
  }

  expiration(key: KvKey): number | null {
    this.#purgeExpired();
    return this.entries.get(encodeKey(key))?.expiresAtMs ?? null;
  }

  get<T = unknown>(key: KvKey, _options?: Readonly<{ consistency?: "strong" | "eventual" }>): Promise<KvEntryMaybe<T>> {
    this.#purgeExpired();
    const entry = this.entries.get(encodeKey(key));
    return Promise.resolve({
      key: clone(key),
      value: entry ? (clone(entry.value) as T) : null,
      versionstamp: entry?.versionstamp ?? null,
    } as KvEntryMaybe<T>);
  }

  set(key: KvKey, value: unknown, options?: { expireIn?: number }): Promise<KvCommitResult> {
    const versionstamp = this.#nextVersionstamp();
    this.#write(key, value, options, versionstamp);
    return Promise.resolve({ ok: true, versionstamp });
  }

  delete(key: KvKey): Promise<void> {
    this.entries.delete(encodeKey(key));
    this.#nextVersionstamp();
    return Promise.resolve();
  }

  list<T = unknown>(selector: KvListSelector, options: KvListOptions = {}): KvListIterator<T> {
    if ("prefix" in selector && "start" in selector && "end" in selector) {
      throw new TypeError("Selector can not specify both 'start' and 'end' key when specifying 'prefix'");
    }
    this.#purgeExpired();
    let entries = [...this.entries.values()]
      .filter((entry) => {
        const prefix = "prefix" in selector ? selector.prefix : [];
        if (!startsWithKey(entry.key, prefix)) return false;
        if ("start" in selector && Array.isArray(selector.start) && compareKeys(entry.key, selector.start) < 0) return false;
        if ("end" in selector && Array.isArray(selector.end) && compareKeys(entry.key, selector.end) >= 0) return false;
        return true;
      })
      .sort((left, right) => compareKeys(left.key, right.key));
    if (options.reverse) entries = entries.reverse();
    if (typeof options.limit === "number") entries = entries.slice(0, options.limit);
    const iterator = (function* (): Generator<KvEntry<T>> {
      for (const entry of entries) {
        yield {
          key: clone(entry.key),
          value: clone(entry.value) as T,
          versionstamp: entry.versionstamp,
        };
      }
    })() as unknown as KvListIterator<T>;
    Object.defineProperty(iterator, "cursor", { get: () => "" });
    return iterator;
  }

  atomic(): AtomicOperation {
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const mutations: ({ kind: "set"; key: KvKey; value: unknown; options?: { expireIn?: number } } | { kind: "delete"; key: KvKey })[] = [];
    const operation = {
      check: (entry: { key: KvKey; versionstamp: string | null }) => {
        checks.push({ key: clone(entry.key), versionstamp: entry.versionstamp });
        return operation;
      },
      set: (key: KvKey, value: unknown, options?: { expireIn?: number }) => {
        mutations.push({ kind: "set", key: clone(key), value: clone(value), options });
        return operation;
      },
      delete: (key: KvKey) => {
        mutations.push({ kind: "delete", key: clone(key) });
        return operation;
      },
      commit: (): Promise<KvCommitResult | KvCommitError> => {
        this.#purgeExpired();
        if (this.atomicConflictOnce) {
          this.atomicConflictOnce = false;
          return Promise.resolve({ ok: false });
        }
        if (checks.some((check) => this.versionstamp(check.key) !== check.versionstamp)) {
          return Promise.resolve({ ok: false });
        }
        const versionstamp = this.#nextVersionstamp();
        for (const mutation of mutations) {
          if (mutation.kind === "delete") {
            this.entries.delete(encodeKey(mutation.key));
          } else {
            this.#write(mutation.key, mutation.value, mutation.options, versionstamp);
          }
        }
        return Promise.resolve({ ok: true, versionstamp });
      },
    };
    return operation as unknown as AtomicOperation;
  }

  close(): void {}
}

const memoryKv = new MemoryKv();
const kv = memoryKv as unknown as Kv;
setKvForTest(kv);
beforeEach(() => {
  setKvForTest(kv);
});
afterEach(() => {
  setKvForTest(null);
});

const { apiKeyHashKey, apiKeyIdKey } = await import("../src/api-keys.ts");
const { recordMeteredTerminal, recordMeteredUpstreamResponse, recordSurplusUsage, reservePaidFallback } = await import("../src/paid-fallback/index.ts");
const { backfillPaidFallbackUsageRollups, backfillPaidFallbackWindowTtls } = await import("../src/paid-fallback/ledger-backfill.ts");
const {
  PAID_FALLBACK_REQUEST_LOG_RETENTION_MS,
  paidFallbackBackfillCursorV3Key,
  paidFallbackBackfillWindowCursorV3Key,
  paidFallbackRequestV3Key,
  paidFallbackWindowV3Key,
} = await import("../src/paid-fallback/ledger-state.ts");
const { listPaidFallbackUsageRollups, mergePaidFallbackUsageRollup, paidFallbackUsageRollupKey, recordTerminalUsageRollup } =
  await import("../src/paid-fallback/rollups.ts");
const {
  METERED_QUOTA_BALANCE_HISTORY_DAILY_BUCKET_MS,
  METERED_QUOTA_BALANCE_HISTORY_PREFIX,
  METERED_QUOTA_STATE_KEY,
  meterQuotaAccountFingerprint,
  normalizeMeteredQuotaBalanceWindowDays,
  readMeteredQuotaBalanceHistory,
  resampleMeteredQuotaBalanceHistory,
  updateMeteredQuotaState,
} = await import("../src/metered-quota.ts");
const { groupPaidFallbackUsageRollups, meteredQuotaRunwayView, projectPaidFallbackRunway, summarizePaidFallbackUsage } =
  await import("../src/quota-projection.ts");
const {
  estimatePaidFallbackRecordBytes,
  isPaidFallbackLedgerDailyStats,
  PAID_FALLBACK_RAW_STORE_ALERT_RATIO,
  PAID_FALLBACK_RAW_STORE_BUDGET_BYTES,
  paidFallbackLedgerStatsDayKey,
  paidFallbackLedgerStatsDayStart,
  readPaidFallbackLedgerGrowth,
  recordPaidFallbackLedgerProjectionStats,
} = await import("../src/paid-fallback/ledger-stats.ts");
const { getKv } = await import("../src/kv.ts");
await getKv();

type ApiKeyRecord = import("../src/types.ts").ApiKeyRecord;
type PaidFallbackRequestV3 = import("../src/types.ts").PaidFallbackRequestV3;
type PaidFallbackWindowV3 = import("../src/types.ts").PaidFallbackWindowV3;
type MeteredQuotaSnapshot = import("../src/metered-quota.ts").MeteredQuotaSnapshot;
type MeteredQuotaState = import("../src/metered-quota.ts").MeteredQuotaState;
type MeteredQuotaBalanceSample = import("../src/metered-quota.ts").MeteredQuotaBalanceSample;
type PaidFallbackLedgerDailyStats = import("../src/paid-fallback/ledger-stats.ts").PaidFallbackLedgerDailyStats;

const keyId = "quota-projection-key";
const keyHash = "quota-projection-hash";
const DAY_MS = 24 * 60 * 60 * 1_000;

const seedKeyRecord = (): void => {
  const now = Date.now();
  const record: ApiKeyRecord = {
    id: keyId,
    name: "Quota projection",
    prefix: "u_qp",
    hash: keyHash,
    created_at_ms: now - 60_000,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 100,
    usage_requests: 0,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: 5_000_000,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
    paid_fallback_model_ids: ["gpt-5.6-sol"],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_max_exposure_microcredits: { "gpt-5.6-sol": 250_000 },
    paid_fallback_pricing_checked_at_ms: now - 30_000,
  };
  memoryKv.entries.clear();
  void memoryKv.set(apiKeyIdKey(keyId), record);
  void memoryKv.set(apiKeyHashKey(keyHash), {
    id: record.id,
    expires_at_ms: record.expires_at_ms,
    revoked_at_ms: record.revoked_at_ms,
    usage_limit_requests: record.usage_limit_requests,
    usage_requests: record.usage_requests,
    usage_reset_at_ms: record.usage_reset_at_ms,
    window_ms: record.window_ms,
    usage_quota_version: record.usage_quota_version,
    paid_fallback_enabled: record.paid_fallback_enabled,
    paid_fallback_limit_microcredits: record.paid_fallback_limit_microcredits,
    paid_fallback_spent_microcredits: record.paid_fallback_spent_microcredits,
    paid_fallback_reserved_microcredits: record.paid_fallback_reserved_microcredits,
    paid_fallback_reservation_request_id: record.paid_fallback_reservation_request_id,
  });
};

const reservationInput = (requestId: string, createdAtMs: number) =>
  ({
    keyId,
    requestId,
    createdAtMs,
    model: "gpt-5.6-sol",
    route: "responses",
    path: "/v1/responses",
    stream: true,
    reasoning: "high",
    reason: "primary_429",
  }) as const;

const reserve = async (requestId: string, createdAtMs: number) => {
  const decision = await reservePaidFallback(reservationInput(requestId, createdAtMs));
  assert.equal(decision.kind, "reserved");

  return decision.reservation;
};

const settleSurplus = async (reservation: Awaited<ReturnType<typeof reserve>>): Promise<void> => {
  await recordMeteredUpstreamResponse(reservation, new Response(null, { status: 200 }), null, "surplus");
  await recordMeteredTerminal(reservation, "completed", "surplus");
  await recordSurplusUsage(
    reservation,
    `surplus:${reservation.request_id}`,
    "gpt-5.6-sol",
    { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 30, output_tokens: 10 },
    {
      input_price_per_token: 0.000001,
      cache_read_price_per_token: 0.0000001,
      cache_write_price_per_token: 0.000002,
      output_price_per_token: 0.000003,
    }
  );
};

const withMeteredEnv = async (run: () => Promise<void>): Promise<void> => {
  const originalEnvGet = process.env.METERED_API_KEY;
  process.env.METERED_API_KEY = "test-metered-key";
  try {
    await run();
  } finally {
    if (originalEnvGet === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalEnvGet;
  }
};

const HOUR_MS = 60 * 60 * 1_000;

test("settlement writes an hourly rollup and retains the raw row for one year", async () => {
  await withMeteredEnv(async () => {
    seedKeyRecord();
    const now = Date.now();
    const reservation = await reserve("qp-settled-a", now);
    await settleSurplus(reservation);

    const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - 30 * DAY_MS, nowMs: now });
    assert.equal(rollups.length, 1);
    const rollup = rollups[0];
    assert.equal(rollup.model, "gpt-5.6-sol");
    assert.equal(rollup.provider, "surplus");
    assert.equal(rollup.request_count, 1);
    assert.equal(rollup.quota_sum, 86); // surplus usage charge, see settlement calc
    assert.equal(rollup.spend_microcredits, 172);
    assert.equal(rollup.input_tokens, 100);
    assert.equal(rollup.cached_input_tokens, 20);
    assert.equal(rollup.output_tokens, 10);
    assert.equal(rollup.bucket_start_at_ms, Math.floor(reservation.created_at_ms / HOUR_MS) * HOUR_MS);

    // Raw row carries a one-year TTL anchored at creation.
    const requestKey = paidFallbackRequestV3Key(keyId, reservation.request_id);
    const expiresAtMs = memoryKv.expiration(requestKey);
    assert.ok(expiresAtMs !== null, "raw request row must carry a TTL");
    assert.ok(
      Math.abs(expiresAtMs - (reservation.created_at_ms + PAID_FALLBACK_REQUEST_LOG_RETENTION_MS)) < 5_000,
      `expiry ${expiresAtMs} should be ~creation + one year`
    );

    // Replaying settlement must not double count the rollup.
    await settleSurplus(reservation);
    const afterReplay = await listPaidFallbackUsageRollups(kv, { sinceMs: now - 30 * DAY_MS, nowMs: now });
    assert.equal(afterReplay.length, 1);
    assert.equal(afterReplay[0]?.request_count, 1);
    assert.equal(afterReplay[0]?.quota_sum, 86);
  });
});

test("two requests in one hour bucket accumulate across rollup shards", async () => {
  await withMeteredEnv(async () => {
    seedKeyRecord();
    const now = Date.now();
    const bucketStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    const first = await reserve("qp-merge-a", bucketStart + 1_000);
    const second = await reserve("qp-merge-b", bucketStart + 2_000);
    await settleSurplus(first);
    await settleSurplus(second);

    const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - 30 * DAY_MS, nowMs: now });
    const totalRequests = rollups.reduce((sum, rollup) => sum + rollup.request_count, 0);
    const totalQuota = rollups.reduce((sum, rollup) => sum + rollup.quota_sum, 0);
    const totalSpend = rollups.reduce((sum, rollup) => sum + rollup.spend_microcredits, 0);
    assert.equal(totalRequests, 2);
    assert.equal(totalQuota, 172);
    assert.equal(totalSpend, 344);
  });
});

test("rollup listing respects the requested time range", async () => {
  await withMeteredEnv(async () => {
    seedKeyRecord();
    const now = Date.now();
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    const oldBucketKey = paidFallbackUsageRollupKey(hourStart - 2 * HOUR_MS, "gpt-5.6-sol", "metered", 3);
    const freshBucketKey = paidFallbackUsageRollupKey(hourStart, "gpt-5.6-sol", "metered", 3);
    const sample: PaidFallbackUsageRollup = {
      v: 1,
      bucket_start_at_ms: 0,
      model: "gpt-5.6-sol",
      provider: "metered",
      request_count: 1,
      quota_sum: 50,
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 10,
      spend_microcredits: 25,
      first_request_at_ms: 0,
      last_request_at_ms: 0,
      updated_at_ms: now,
    };
    await memoryKv.set(oldBucketKey, { ...sample, bucket_start_at_ms: hourStart - 2 * HOUR_MS });
    await memoryKv.set(freshBucketKey, { ...sample, bucket_start_at_ms: hourStart });

    const retained = await listPaidFallbackUsageRollups(kv, { sinceMs: hourStart - HOUR_MS, nowMs: now + HOUR_MS });
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.bucket_start_at_ms, hourStart);
  });
});

test("balance history listing uses a valid bounded KV range selector", async () => {
  memoryKv.entries.clear();
  const fingerprint = "quota-projection-account";
  const now = Date.now();
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const sample = (bucketStartAtMs: number, observedAtMs = bucketStartAtMs + 1_000) => ({
    v: 1 as const,
    bucket_start_at_ms: bucketStartAtMs,
    observed_at_ms: observedAtMs,
    balance_quota: 1_000,
    baseline_quota: 2_000,
    quota_per_credit: 1,
    remaining_percent: 50,
  });
  await memoryKv.set([...METERED_QUOTA_BALANCE_HISTORY_PREFIX, fingerprint, hourStart - 2 * HOUR_MS], sample(hourStart - 2 * HOUR_MS));
  await memoryKv.set(
    [...METERED_QUOTA_BALANCE_HISTORY_PREFIX, fingerprint, hourStart - HOUR_MS],
    sample(hourStart - HOUR_MS, hourStart - HOUR_MS + 45 * 60_000)
  );
  await memoryKv.set([...METERED_QUOTA_BALANCE_HISTORY_PREFIX, fingerprint, hourStart], sample(hourStart));

  const retained = await readMeteredQuotaBalanceHistory(kv, {
    accountFingerprint: fingerprint,
    sinceMs: hourStart - HOUR_MS + 30 * 60_000,
    nowMs: now,
  });
  assert.equal(retained.length, 2);
  assert.equal(retained[0]?.bucket_start_at_ms, hourStart - HOUR_MS);
  assert.equal(retained[1]?.bucket_start_at_ms, hourStart);
});

test("365-day balance history is deterministically resampled to UTC days", () => {
  const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const sample = (bucketStartAtMs: number, observedAtMs: number, balanceQuota: number) => ({
    v: 1 as const,
    bucket_start_at_ms: bucketStartAtMs,
    observed_at_ms: observedAtMs,
    balance_quota: balanceQuota,
    baseline_quota: 2_000,
    quota_per_credit: 1,
    remaining_percent: 50,
  });
  const source = [
    sample(dayStart - DAY_MS, dayStart - DAY_MS + HOUR_MS, 1_200),
    sample(dayStart + HOUR_MS, dayStart + HOUR_MS + 1, 1_100),
    sample(dayStart + 2 * HOUR_MS, dayStart + 2 * HOUR_MS + 1, 1_000),
  ];
  const resampled = resampleMeteredQuotaBalanceHistory(source, METERED_QUOTA_BALANCE_HISTORY_DAILY_BUCKET_MS, 365);
  assert.equal(resampled.length, 2);
  assert.equal(resampled[0]?.bucket_start_at_ms, dayStart - DAY_MS);
  assert.equal(resampled[1]?.bucket_start_at_ms, dayStart);
  assert.equal(resampled[1]?.balance_quota, 1_000);

  const bucketMs = 25 * HOUR_MS;
  const rangeStart = 30 * 60_000;
  const rangeEnd = rangeStart + 365 * DAY_MS;
  const oversized = Array.from({ length: 365 * 24 + 1 }, (_, index) => sample(rangeStart + index * HOUR_MS, rangeStart + index * HOUR_MS, index));
  const capped = resampleMeteredQuotaBalanceHistory(oversized, bucketMs, 365);
  assert.ok(capped.length <= 365);
  assert.equal(capped[0]?.observed_at_ms, rangeStart + 24 * HOUR_MS);
  assert.equal(capped.at(-1)?.observed_at_ms, rangeEnd);
});

test("balance window accepts supported values and defaults invalid input to seven days", () => {
  assert.equal(normalizeMeteredQuotaBalanceWindowDays(null), 7);
  for (const invalid of ["", "invalid", "0", "8", "7.5", "7days"]) {
    assert.equal(normalizeMeteredQuotaBalanceWindowDays(invalid), 7);
  }
  for (const accepted of [7, 30, 90, 365] as const) {
    assert.equal(normalizeMeteredQuotaBalanceWindowDays(String(accepted)), accepted);
  }
});

test("merge sums counters and tracks first/last request times", () => {
  const base = {
    bucket_start_at_ms: 1_000,
    model: "gpt-5.6-sol",
    provider: "metered",
    request_id: "merge-req-1",
    quota: 30,
    input_tokens: 10,
    cached_input_tokens: null,
    output_tokens: 5,
    spend_microcredits: 15,
    request_created_at_ms: 5_000,
    updated_at_ms: 6_000,
  } as const;
  const first = mergePaidFallbackUsageRollup(null, base);
  assert.equal(first.request_count, 1);
  assert.equal(first.quota_sum, 30);
  assert.equal(first.first_request_at_ms, 5_000);
  assert.equal(first.last_request_at_ms, 5_000);
  const second = mergePaidFallbackUsageRollup(first, {
    ...base,
    quota: 20,
    input_tokens: 40,
    cached_input_tokens: 7,
    spend_microcredits: 10,
    request_created_at_ms: 4_000,
    updated_at_ms: 7_000,
  });
  assert.equal(second.request_count, 2);
  assert.equal(second.quota_sum, 50);
  assert.equal(second.cached_input_tokens, 7);
  assert.equal(second.first_request_at_ms, 4_000);
  assert.equal(second.last_request_at_ms, 5_000);
});

test("terminal observations record subscription usage and skip settled providers", async () => {
  memoryKv.entries.clear();
  const now = Date.now();
  const observation = {
    model: "gpt-5.6-sol",
    provider: "chatgpt_codex",
    request_created_at_ms: now,
    input_tokens: 120,
    cached_input_tokens: 40,
    output_tokens: 30,
  } as const;

  assert.equal(await recordTerminalUsageRollup({ ...observation, request_id: "terminal-codex-a" }, kv), true);
  assert.equal(await recordTerminalUsageRollup({ ...observation, request_id: "terminal-codex-b" }, kv), true);
  // Settled providers already contribute their authoritative settlement row.
  assert.equal(await recordTerminalUsageRollup({ ...observation, provider: "metered", request_id: "terminal-metered" }, kv), false);
  assert.equal(await recordTerminalUsageRollup({ ...observation, provider: "surplus", request_id: "terminal-surplus" }, kv), false);
  // A gateway rejection and an image-fanout aggregate are labels, not routes.
  assert.equal(await recordTerminalUsageRollup({ ...observation, provider: "gateway", request_id: "terminal-gateway" }, kv), false);
  assert.equal(await recordTerminalUsageRollup({ ...observation, provider: "mixed", request_id: "terminal-mixed" }, kv), false);
  assert.equal(await recordTerminalUsageRollup({ ...observation, model: null, request_id: "terminal-model-unknown" }, kv), false);
  // An unavailable KV never throws on the terminal path.
  assert.equal(await recordTerminalUsageRollup({ ...observation, request_id: "terminal-no-kv" }, null), false);

  const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - 30 * DAY_MS, nowMs: now });
  const subscription = rollups.filter((entry) => entry.provider === "chatgpt_codex");
  assert.ok(subscription.length >= 1, "terminal observations must land in the hourly rollup");
  const sum = (key: "request_count" | "input_tokens" | "cached_input_tokens" | "output_tokens" | "quota_sum" | "spend_microcredits") =>
    subscription.reduce((total, entry) => total + entry[key], 0);
  assert.equal(sum("request_count"), 2);
  assert.equal(sum("input_tokens"), 240);
  assert.equal(sum("cached_input_tokens"), 80);
  assert.equal(sum("output_tokens"), 60);
  assert.equal(sum("quota_sum"), 0);
  assert.equal(sum("spend_microcredits"), 0);
  const bucketStartAtMs = Math.floor(now / HOUR_MS) * HOUR_MS;
  for (const entry of subscription) {
    assert.equal(entry.model, "gpt-5.6-sol");
    assert.equal(entry.bucket_start_at_ms, bucketStartAtMs);
  }
});

test("terminal observations skip unobserved usage instead of recording zero-token rows", async () => {
  memoryKv.entries.clear();
  const now = Date.now();
  assert.equal(
    await recordTerminalUsageRollup(
      {
        model: "gpt-5.6-sol",
        provider: "chatgpt_codex",
        request_id: "terminal-unobserved",
        request_created_at_ms: now,
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
      },
      kv
    ),
    false
  );
  // A partial observation is missing a core dimension, so it is not recorded
  // as a zero either.
  assert.equal(
    await recordTerminalUsageRollup(
      {
        model: "gpt-5.6-sol",
        provider: "chatgpt_codex",
        request_id: "terminal-partial",
        request_created_at_ms: now,
        input_tokens: 10,
        cached_input_tokens: null,
        output_tokens: null,
      },
      kv
    ),
    false
  );
  const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - DAY_MS, nowMs: now });
  assert.equal(rollups.length, 0, "an unobserved response must not create a zero-token rollup row");
});

test("terminal observations retry a conflicting shard write instead of dropping it", async () => {
  memoryKv.entries.clear();
  const now = Date.now();
  memoryKv.atomicConflictOnce = true;
  const recorded = await recordTerminalUsageRollup(
    {
      model: "gpt-5.6-luna",
      provider: "cerebras",
      request_id: "terminal-cas-retry",
      request_created_at_ms: now,
      input_tokens: 11,
      cached_input_tokens: null,
      output_tokens: 3,
    },
    kv
  );
  assert.equal(recorded, true);
  const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - DAY_MS, nowMs: now });
  const recordedCount = rollups.filter((entry) => entry.provider === "cerebras").reduce((total, entry) => total + entry.request_count, 0);
  assert.equal(recordedCount, 1);
});

test("subscription observations join the projection without runway estimates", async () => {
  memoryKv.entries.clear();
  const now = Date.now();
  await recordTerminalUsageRollup(
    {
      model: "gpt-5.6-sol",
      provider: "chatgpt_codex",
      request_id: "terminal-projection",
      request_created_at_ms: now,
      input_tokens: 50,
      cached_input_tokens: null,
      output_tokens: 20,
    },
    kv
  );
  const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - DAY_MS, nowMs: now });
  const usage = summarizePaidFallbackUsage(groupPaidFallbackUsageRollups(rollups), now);
  const subscription = usage.find((entry) => entry.provider === "chatgpt_codex");
  assert.ok(subscription, "the subscription provider must be part of the projection");
  const window = subscription.windows.find((candidate) => candidate.window_days === 30);
  assert.equal(window?.request_count, 1);
  assert.equal(window.input_tokens, 50);
  assert.equal(window.quota_sum, 0);
  // Nothing in an observability row can be projected against the OpenLux balance.
  assert.deepEqual(projectPaidFallbackRunway(subscription, meteredQuotaRunwayView(null), now), []);
});

test("admin projection tags settled rows paid_fallback and terminal accounting observability", async () => {
  await withMeteredEnv(async () => {
    memoryKv.entries.clear();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock(() => Promise.reject(new Error("offline projection test")));
    try {
      const now = Date.now();
      const bucketStartAtMs = Math.floor(now / HOUR_MS) * HOUR_MS;
      const settled: PaidFallbackUsageRollup = {
        v: 1,
        bucket_start_at_ms: bucketStartAtMs,
        model: "gpt-5.6-sol",
        provider: "metered",
        request_count: 1,
        quota_sum: 50,
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 10,
        spend_microcredits: 25,
        first_request_at_ms: now,
        last_request_at_ms: now,
        updated_at_ms: now,
      };
      await memoryKv.set(paidFallbackUsageRollupKey(bucketStartAtMs, "gpt-5.6-sol", "metered", 0), settled);
      assert.equal(
        await recordTerminalUsageRollup(
          {
            model: "gpt-5.6-sol",
            provider: "chatgpt_codex",
            request_id: "terminal-usage-source",
            request_created_at_ms: now,
            input_tokens: 40,
            cached_input_tokens: null,
            output_tokens: 5,
          },
          kv
        ),
        true
      );
      const { handleAdminProvidersQuotaProjection } = await import("../src/admin/kernel.ts");
      const response = await handleAdminProvidersQuotaProjection(new Request("https://ai.ubq.fi/admin/providers/quota-projection?window_days=30"));
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { models?: { provider?: string; usage_source?: string }[] };
      const usageSourceByProvider = new Map((payload.models ?? []).map((row) => [row.provider, row.usage_source]));
      assert.equal(usageSourceByProvider.get("metered"), "paid_fallback");
      assert.equal(usageSourceByProvider.get("chatgpt_codex"), "observability");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("summarize and project offer per-window rates and exhaustion estimates", () => {
  const now = 1_000_000_000_000;
  const hour = HOUR_MS;
  const bucket = (startAtMs: number, quotaSum: number): PaidFallbackUsageRollup => ({
    v: 1,
    bucket_start_at_ms: startAtMs,
    model: "gpt-5.6-sol",
    provider: "metered",
    request_count: 1,
    quota_sum: quotaSum,
    input_tokens: 100,
    cached_input_tokens: 10,
    output_tokens: 20,
    spend_microcredits: Math.round(quotaSum / 2),
    first_request_at_ms: startAtMs + 1,
    last_request_at_ms: startAtMs + hour - 1,
    updated_at_ms: startAtMs + hour - 1,
  });
  const series = groupPaidFallbackUsageRollups([
    bucket(now - 30 * hour, 60),
    bucket(now - 29 * hour, 60),
    bucket(now - 2 * hour, 60),
    bucket(now - 1 * hour, 60),
  ]);
  const usage = summarizePaidFallbackUsage(series, now);
  assert.equal(usage.length, 1);
  const windows = usage[0].windows;
  const sevenDay = windows[0];
  assert.equal(sevenDay.request_count, 4);
  assert.equal(sevenDay.quota_sum, 240);
  assert.equal(sevenDay.avg_quota_per_request, 60);
  // The rate covers the whole window including idle hours: 240 quota over
  // 168 hours, not over the 4 hours that happened to have traffic.
  assert.ok(sevenDay.quota_per_hour !== null && Math.abs(sevenDay.quota_per_hour - 240 / 168) < 1e-9);

  const walletSnapshot = {
    state: {
      current_balance_quota: 600,
      post_refill_baseline_quota: 3_000,
      last_observed_used_quota: 0,
      quota_per_credit: 2,
      observed_at_ms: now - 1_000,
      cycle_started_at_ms: now - 2 * dayMs(),
      confidence: "refill_observed",
      last_known_debits_quota: 0,
      last_inferred_credit_quota: 0,
      last_credit_at_ms: null,
      latest_refill_id: "refill-1",
      latest_refill_amount_credits: 1_500,
      latest_refill_completed_at_ms: now - 2 * dayMs(),
    },
    cache_state: "fresh",
    balance_credits: 300,
    baseline_credits: 1_500,
    last_inferred_credit_credits: null,
    remaining_percent: 20,
    used_percent: 80,
    unlimited_quota: false,
    total_available: null,
    total_granted: null,
    total_used: null,
  } satisfies MeteredQuotaSnapshot;
  const quota = meteredQuotaRunwayView(walletSnapshot);
  assert.equal(quota.available, true);
  assert.equal(quota.balance_quota, 600);
  const estimates = projectPaidFallbackRunway(usage[0], quota, now);
  const thirtyDay = estimates.find((estimate) => estimate.window_days === 30);
  assert.ok(thirtyDay);
  assert.equal(thirtyDay.unlimited, false);
  assert.equal(thirtyDay.requests_remaining, 10); // 600 / 60
  assert.ok(thirtyDay.time_remaining_ms !== null && thirtyDay.time_remaining_ms > 0);
  assert.equal(thirtyDay.percent_per_request_vs_balance, 10); // 60/600*100
  assert.equal(thirtyDay.percent_per_request_vs_baseline, 2); // 60/3000*100
});

test("token-usage and unlimited quota modes do not fabricate estimates", () => {
  const now = 1_000_000_000_000;
  const entry = summarizePaidFallbackUsage(
    groupPaidFallbackUsageRollups([
      {
        v: 1,
        bucket_start_at_ms: now - HOUR_MS,
        model: "gpt-5.6-sol",
        provider: "metered",
        request_count: 2,
        quota_sum: 60,
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 20,
        spend_microcredits: 30,
        first_request_at_ms: now - HOUR_MS + 1,
        last_request_at_ms: now - 1,
        updated_at_ms: now - 1,
      },
    ]),
    now
  );
  const tokenSnapshot = {
    unlimited_quota: false,
    total_available: 1_000,
    total_granted: 1_000,
    total_used: 400,
  } as const;
  const tokenState = {
    current_balance_quota: 0,
    post_refill_baseline_quota: 0,
    last_observed_used_quota: 0,
    quota_per_credit: 1,
    observed_at_ms: now,
    cycle_started_at_ms: now,
    confidence: "provisional",
    last_known_debits_quota: 0,
    last_inferred_credit_quota: 0,
    last_credit_at_ms: null,
    latest_refill_id: null,
    latest_refill_amount_credits: null,
    latest_refill_completed_at_ms: null,
    unlimited_quota: tokenSnapshot.unlimited_quota,
    total_available: tokenSnapshot.total_available,
    total_granted: tokenSnapshot.total_granted,
    total_used: tokenSnapshot.total_used,
  } as const;
  const tokenSnapshotFull: MeteredQuotaSnapshot = {
    state: tokenState,
    cache_state: "fresh",
    balance_credits: null,
    baseline_credits: null,
    last_inferred_credit_credits: null,
    remaining_percent: null,
    used_percent: null,
    unlimited_quota: tokenSnapshot.unlimited_quota,
    total_available: tokenSnapshot.total_available,
    total_granted: tokenSnapshot.total_granted,
    total_used: tokenSnapshot.total_used,
  };
  const tokenQuota = meteredQuotaRunwayView(tokenSnapshotFull);
  const tokenEstimates = projectPaidFallbackRunway(entry[0], tokenQuota, now);
  const token30 = tokenEstimates.find((estimate) => estimate.window_days === 30);
  if (token30 === undefined) throw new Error("expected a 30-day token estimate");
  // total_available is the remaining inventory ("Available tokens"), so the
  // balance is 1000 quota units at 30 quota per request → 33 requests.
  // Subtracting total_used again would double-count consumption.
  assert.equal(token30.requests_remaining, 33);
  assert.equal(token30.stale_balance, false);

  const staleQuota = meteredQuotaRunwayView({ ...tokenSnapshotFull, cache_state: "stale" });
  const staleEstimates = projectPaidFallbackRunway(entry[0], staleQuota, now);
  assert.equal(staleEstimates.find((estimate) => estimate.window_days === 30)?.stale_balance, true);

  // Surplus has its own billing and no monitored quota; never project it
  // against the OpenLux balance.
  const surplusSeries = groupPaidFallbackUsageRollups([
    {
      v: 1,
      bucket_start_at_ms: now - HOUR_MS,
      model: "gpt-5.6-sol",
      provider: "surplus",
      request_count: 2,
      quota_sum: 60,
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 20,
      spend_microcredits: 30,
      first_request_at_ms: now - HOUR_MS + 1,
      last_request_at_ms: now - 1,
      updated_at_ms: now - 1,
    },
  ]);
  const surplusUsage = summarizePaidFallbackUsage(surplusSeries, now);
  assert.equal(projectPaidFallbackRunway(surplusUsage[0], tokenQuota, now).length, 0);

  const unlimitedSnapshotFull: MeteredQuotaSnapshot = {
    ...tokenSnapshotFull,
    state: { ...tokenState, unlimited_quota: true },
    unlimited_quota: true,
  };
  const unlimitedQuota = meteredQuotaRunwayView(unlimitedSnapshotFull);
  const unlimitedEstimates = projectPaidFallbackRunway(entry[0], unlimitedQuota, now);
  assert.equal(unlimitedEstimates[0]?.unlimited, true);
  assert.equal(unlimitedEstimates[0]?.requests_remaining, null);

  const unconfigured = meteredQuotaRunwayView(null);
  assert.equal(unconfigured.available, false);
  assert.equal(unconfigured.balance_quota, null);
});

function dayMs(): number {
  return 24 * 60 * 60 * 1_000;
}

const refillBalanceSample = (state: MeteredQuotaState): MeteredQuotaBalanceSample => ({
  v: 1,
  bucket_start_at_ms: Math.floor(state.observed_at_ms / HOUR_MS) * HOUR_MS,
  observed_at_ms: state.observed_at_ms,
  balance_quota: state.current_balance_quota,
  baseline_quota: state.post_refill_baseline_quota,
  quota_per_credit: state.quota_per_credit,
  remaining_percent: null,
});

const refillSnapshot = (state: MeteredQuotaState): MeteredQuotaSnapshot => ({
  state,
  cache_state: "fresh",
  balance_credits: state.total_available === undefined ? state.current_balance_quota / state.quota_per_credit : null,
  baseline_credits: state.total_available === undefined ? state.post_refill_baseline_quota / state.quota_per_credit : null,
  last_inferred_credit_credits: state.last_inferred_credit_quota / state.quota_per_credit,
  remaining_percent: null,
  used_percent: null,
  unlimited_quota: state.unlimited_quota ?? false,
  total_available: state.total_available ?? null,
  total_granted: state.total_granted ?? null,
  total_used: state.total_used ?? null,
});

const inferredRefillFixture = (retainedRefill = false) => {
  const start = 1_800_000_000_000;
  let previous: MeteredQuotaState | null = null;
  const states = [
    [0, 200, 0],
    [8, 230, 10],
    [16, 260, 20],
  ].map(([hours, balance, used]) => {
    previous = updateMeteredQuotaState(previous, {
      balance_quota: balance,
      used_quota: used,
      quota_per_credit: 1,
      observed_at_ms: start + hours * HOUR_MS,
      latest_refill: hours === 0 && retainedRefill ? { id: "old-refill", amount_credits: 100, completed_at_ms: start } : null,
    });
    return previous;
  });
  return { state: states[2], history: states.map(refillBalanceSample), now: start + 16 * HOUR_MS };
};

const refillRollup = (now: number, quotaPerHour = 10): PaidFallbackUsageRollup => ({
  v: 1,
  bucket_start_at_ms: now - HOUR_MS,
  model: "gpt-5.6-sol",
  provider: "metered",
  request_count: 168,
  quota_sum: 168 * quotaPerHour,
  input_tokens: 100,
  cached_input_tokens: 0,
  output_tokens: 10,
  spend_microcredits: 0,
  first_request_at_ms: now - HOUR_MS,
  last_request_at_ms: now - 1,
  updated_at_ms: now - 1,
});

const refillUsage = (now: number, quotaPerHour = 10) => summarizePaidFallbackUsage(groupPaidFallbackUsageRollups([refillRollup(now, quotaPerHour)]), now)[0];

test("refill projection distinguishes sustainable, early depletion and scheduled exhaustion", () => {
  const { state, history, now } = inferredRefillFixture();
  const cases = [
    { burn: 5, status: "sustainable", remaining: null },
    { burn: 40, status: "exhausts_without_refill", remaining: 6.5 * HOUR_MS },
    { burn: 10, status: "exhausts_with_refill", remaining: 46 * HOUR_MS },
  ];
  for (const scenario of cases) {
    const estimate = projectPaidFallbackRunway(refillUsage(now, scenario.burn), meteredQuotaRunwayView(refillSnapshot(state)), now, history)[0];
    assert.equal(estimate.refill_aware_status, scenario.status);
    assert.equal(estimate.refill_aware_time_remaining_ms, scenario.remaining);
    assert.equal(estimate.time_remaining_ms, (260 / scenario.burn) * HOUR_MS);
  }
});

test("refill projection uses inferred credits rather than net balance growth", () => {
  const { state, history, now } = inferredRefillFixture();
  assert.equal(state.last_inferred_credit_quota, 40);
  const estimate = projectPaidFallbackRunway(refillUsage(now), meteredQuotaRunwayView(refillSnapshot(state)), now, history)[0];
  assert.equal(estimate.refill_amount_credits, 40);
  assert.equal(estimate.refill_cadence_ms, 8 * HOUR_MS);
  assert.equal(estimate.refill_rate_quota_per_hour, 5);
  assert.equal(estimate.refill_aware_status, "exhausts_with_refill");
  assert.equal(estimate.refill_aware_time_remaining_ms, 46 * HOUR_MS);
  assert.equal(estimate.refill_aware_exhausted_at_ms, now + 46 * HOUR_MS);
  assert.equal(estimate.time_remaining_ms, 26 * HOUR_MS);
});

test("refill projection prefers a newer inferred credit to retained refill metadata", () => {
  const { state, history, now } = inferredRefillFixture(true);
  assert.equal(state.latest_refill_amount_credits, 100);
  assert.equal(state.last_inferred_credit_quota, 40);
  const estimate = projectPaidFallbackRunway(refillUsage(now), meteredQuotaRunwayView(refillSnapshot(state)), now, history)[0];
  assert.equal(estimate.refill_amount_credits, 40);
  assert.equal(estimate.refill_rate_quota_per_hour, 5);
  assert.equal(estimate.refill_aware_status, "exhausts_with_refill");
  assert.equal(estimate.refill_aware_exhausted_at_ms, now + 46 * HOUR_MS);
  assert.equal(estimate.time_remaining_ms, 26 * HOUR_MS);
});

test("refill projection does not apply retained wallet history to finite token inventory", () => {
  const fixture = inferredRefillFixture();
  const now = fixture.now + 8 * HOUR_MS;
  const state = updateMeteredQuotaState(fixture.state, {
    balance_quota: null,
    used_quota: null,
    quota_per_credit: null,
    observed_at_ms: now,
    latest_refill: null,
    unlimited_quota: false,
    total_available: 100,
    total_granted: 100,
    total_used: 0,
  });
  const estimate = projectPaidFallbackRunway(refillUsage(now), meteredQuotaRunwayView(refillSnapshot(state)), now, fixture.history)[0];
  assert.equal(estimate.refill_aware_status, "unknown");
  assert.equal(estimate.refill_amount_credits, null);
  assert.equal(estimate.refill_cadence_ms, null);
  assert.equal(estimate.refill_rate_quota_per_hour, null);
  assert.equal(estimate.refill_aware_time_remaining_ms, null);
  assert.equal(estimate.time_remaining_ms, 10 * HOUR_MS);
});

test("refill projection stays unknown when a later refresh no longer retains the inferred amount", () => {
  const fixture = inferredRefillFixture(true);
  const now = fixture.now + HOUR_MS;
  const state = updateMeteredQuotaState(fixture.state, {
    balance_quota: 250,
    used_quota: 30,
    quota_per_credit: 1,
    observed_at_ms: now,
    latest_refill: null,
  });
  assert.equal(state.last_inferred_credit_quota, 0);
  const history = [...fixture.history, refillBalanceSample(state)];
  const estimate = projectPaidFallbackRunway(refillUsage(now), meteredQuotaRunwayView(refillSnapshot(state)), now, history)[0];
  assert.equal(estimate.refill_aware_status, "unknown");
  assert.equal(estimate.refill_amount_credits, null);
  assert.equal(estimate.refill_rate_quota_per_hour, null);
  assert.equal(estimate.refill_aware_time_remaining_ms, null);
  assert.equal(estimate.refill_aware_exhausted_at_ms, null);
  assert.equal(estimate.time_remaining_ms, 25 * HOUR_MS);
});

test("admin quota projection returns the inferred-credit refill forecast", async () => {
  await withMeteredEnv(async () => {
    const { state, history, now } = inferredRefillFixture(true);
    const originalNow = Date.now;
    const originalFetch = globalThis.fetch;
    Date.now = () => now;
    globalThis.fetch = createFetchMock(() => Promise.reject(new Error("offline refill projection test")));
    try {
      seedKeyRecord();
      await memoryKv.set(METERED_QUOTA_STATE_KEY, state);
      const fingerprint = await meterQuotaAccountFingerprint({ apiKey: "test-metered-key" });
      assert.ok(fingerprint);
      for (const sample of history) {
        await memoryKv.set([...METERED_QUOTA_BALANCE_HISTORY_PREFIX, fingerprint, sample.bucket_start_at_ms], sample);
      }
      const rollup = refillRollup(now);
      await memoryKv.set(paidFallbackUsageRollupKey(rollup.bucket_start_at_ms, rollup.model, rollup.provider, 0), rollup);
      const { handleAdminProvidersQuotaProjection } = await import("../src/admin/kernel.ts");
      const response = await handleAdminProvidersQuotaProjection(new Request("https://ai.ubq.fi/admin/providers/quota-projection?window_days=7"));
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        quota: Record<string, unknown>;
        models: { provider: string; estimates: import("../src/quota-projection.ts").PaidFallbackRunwayEstimate[] }[];
      };
      assert.equal(Object.hasOwn(payload.quota, "last_inferred_credit_quota"), false);
      const estimate = payload.models.find((entry) => entry.provider === "metered")?.estimates[0];
      assert.ok(estimate);
      assert.equal(estimate.refill_amount_credits, 40);
      assert.equal(estimate.refill_rate_quota_per_hour, 5);
      assert.equal(estimate.refill_aware_status, "exhausts_with_refill");
      assert.equal(estimate.refill_aware_exhausted_at_ms, now + 46 * HOUR_MS);
      assert.equal(estimate.time_remaining_ms, 26 * HOUR_MS);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });
});

const settledRequestRow = (requestId: string, createdAtMs: number): PaidFallbackRequestV3 => ({
  v: 3,
  key_id: keyId,
  request_id: requestId,
  policy_version: "60000:123",
  route: "responses",
  path: "/v1/responses",
  model: "gpt-5.6-sol",
  stream: true,
  reasoning: "high",
  window_reset_at_ms: createdAtMs + 60_000,
  reserved_microcredits: 300,
  quota_per_credit: 1,
  provider: "metered",
  provider_request_id: null,
  provider_quota: 60,
  input_tokens: 90,
  cached_input_tokens: null,
  output_tokens: 10,
  dispatch_state: "dispatched",
  terminal_state: "completed",
  spend_microcredits: 60,
  billing_state: "settled",
  reconciliation_attempts: 1,
  last_reconciliation_at_ms: createdAtMs + 1_000,
  dispatched_at_ms: createdAtMs + 500,
  terminal_at_ms: createdAtMs + 1_000,
  settled_at_ms: createdAtMs + 1_000,
  created_at_ms: createdAtMs,
  updated_at_ms: createdAtMs + 1_000,
});

test("backfill folds pre-existing settled rows into rollups and applies the TTL once", async () => {
  seedKeyRecord();
  const now = Date.now();
  await memoryKv.set(paidFallbackRequestV3Key(keyId, "bf-1"), settledRequestRow("bf-1", now - 2 * HOUR_MS));
  const first = await backfillPaidFallbackUsageRollups(kv, { nowMs: now });
  assert.equal(first.scanned, 1);
  assert.equal(first.processed, 1);
  assert.equal(first.rollups_written, 1);
  assert.equal(first.truncated, false);

  const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - 30 * DAY_MS, nowMs: now });
  assert.equal(rollups.length, 1);
  assert.equal(rollups[0]?.request_count, 1);
  assert.equal(rollups[0]?.quota_sum, 60);

  const requestKey = paidFallbackRequestV3Key(keyId, "bf-1");
  const requestEntry = await memoryKv.get<PaidFallbackRequestV3>(requestKey);
  assert.equal(requestEntry.value?.usage_rollup_at_ms, now);
  assert.ok(memoryKv.expiration(requestKey) !== null, "backfilled row must carry the one-year TTL");

  // Re-running must not double count.
  const second = await backfillPaidFallbackUsageRollups(kv, { nowMs: now });
  assert.equal(second.processed, 0);
  const after = await listPaidFallbackUsageRollups(kv, { sinceMs: now - 30 * DAY_MS, nowMs: now });
  assert.equal(after[0]?.request_count, 1);
  assert.equal(after[0]?.quota_sum, 60);
});

test("settlement marks the row so a later backfill never double counts", async () => {
  await withMeteredEnv(async () => {
    seedKeyRecord();
    const now = Date.now();
    const reservation = await reserve("qp-live-then-backfill", now);
    await settleSurplus(reservation);

    const row = (await memoryKv.get<PaidFallbackRequestV3>(paidFallbackRequestV3Key(keyId, reservation.request_id))).value;
    assert.ok(row, "settled row must exist");
    assert.equal(row.usage_rollup_at_ms, row.settled_at_ms, "settled rows carry the rollup marker");

    const backfill = await backfillPaidFallbackUsageRollups(kv, { nowMs: now });
    assert.equal(backfill.processed, 0, "live-settled rows must not be re-folded");
    assert.equal(backfill.rollups_written, 0);

    const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - 30 * DAY_MS, nowMs: now });
    assert.equal(rollups.length, 1);
    assert.equal(rollups[0]?.request_count, 1);
    assert.equal(rollups[0]?.quota_sum, 86);
  });
});

test("backfill is resumable with a limit and marks non-billable rows", async () => {
  seedKeyRecord();
  const now = Date.now();
  await memoryKv.set(paidFallbackRequestV3Key(keyId, "bf-a"), settledRequestRow("bf-a", now - 2 * HOUR_MS));
  await memoryKv.set(paidFallbackRequestV3Key(keyId, "bf-b"), {
    ...settledRequestRow("bf-b", now - HOUR_MS),
    billing_state: "pending",
    spend_microcredits: null,
    provider_quota: null,
  });
  const partial = await backfillPaidFallbackUsageRollups(kv, { limit: 1, nowMs: now });
  assert.equal(partial.processed, 1);
  assert.equal(partial.rollups_written, 1);
  assert.equal(partial.truncated, true);
  assert.ok((await memoryKv.get(paidFallbackBackfillCursorV3Key())).value !== null, "resume cursor persisted");
  const remainder = await backfillPaidFallbackUsageRollups(kv, { limit: 1, nowMs: now });
  assert.equal(remainder.truncated, false);
  assert.equal(remainder.rollups_written, 0); // the non-billable row contributes no rollup
  assert.equal(remainder.processed, 1); // but it is marked so bounded runs advance
  assert.equal((await memoryKv.get(paidFallbackBackfillCursorV3Key())).value, null, "cursor cleared on completion");

  // Non-billable rows must never consume the budget twice.
  const complete = await backfillPaidFallbackUsageRollups(kv, { limit: 1, nowMs: now });
  assert.equal(complete.truncated, false);
  assert.equal(complete.processed, 0);

  const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - 30 * DAY_MS, nowMs: now });
  assert.equal(rollups.length, 1);
  assert.equal(rollups[0]?.request_count, 1);
  assert.equal(rollups[0]?.quota_sum, 60);
});

test("backfill scan budget trips before the deadline and keeps forward progress", async () => {
  seedKeyRecord();
  const now = Date.now();
  // Ten marked rows precede one unmarked row; with limit=1 the scan budget
  // (limit*10) trips before the unmarked row on the first pass.
  for (let index = 0; index < 10; index += 1) {
    await memoryKv.set(paidFallbackRequestV3Key(keyId, `bf-m${index}`), {
      ...settledRequestRow(`bf-m${index}`, now - 30 * HOUR_MS),
      usage_rollup_at_ms: now,
    });
  }
  await memoryKv.set(paidFallbackRequestV3Key(keyId, "bf-z"), settledRequestRow("bf-z", now - 2 * HOUR_MS));
  const first = await backfillPaidFallbackUsageRollups(kv, { limit: 1, nowMs: now });
  assert.equal(first.truncated, true);
  assert.equal(first.processed, 0);
  assert.ok((await memoryKv.get(paidFallbackBackfillCursorV3Key())).value !== null);
  const second = await backfillPaidFallbackUsageRollups(kv, { limit: 1, nowMs: now });
  assert.equal(second.truncated, false);
  assert.equal(second.processed, 1);
  assert.equal(second.rollups_written, 1);
  const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - 30 * DAY_MS, nowMs: now });
  assert.equal(
    rollups.reduce((sum, rollup) => sum + rollup.request_count, 0),
    1
  );
});

test("window TTL backfill is resumable across batches", async () => {
  seedKeyRecord();
  const now = Date.now();
  const windowRow = (resetAtMs: number): PaidFallbackWindowV3 => ({
    v: 3,
    key_id: keyId,
    policy_version: "60000:123",
    window_reset_at_ms: resetAtMs,
    limit_microcredits: 5_000_000,
    settled_microcredits: 100,
    reserved_microcredits: 0,
    pending_count: 0,
    updated_at_ms: now,
  });
  await memoryKv.set(paidFallbackWindowV3Key(keyId, now - 2 * DAY_MS), windowRow(now - 2 * DAY_MS));
  await memoryKv.set(paidFallbackWindowV3Key(keyId, now + DAY_MS), windowRow(now + DAY_MS));
  const partial = await backfillPaidFallbackWindowTtls(kv, { limit: 1, nowMs: now });
  assert.equal(partial.rewritten, 1);
  assert.equal(partial.truncated, true);
  assert.ok((await memoryKv.get(paidFallbackBackfillWindowCursorV3Key())).value !== null);
  const remainder = await backfillPaidFallbackWindowTtls(kv, { limit: 1, nowMs: now });
  assert.equal(remainder.rewritten, 1);
  assert.equal(remainder.truncated, false);
  assert.equal((await memoryKv.get(paidFallbackBackfillWindowCursorV3Key())).value, null);
  assert.ok(memoryKv.expiration(paidFallbackWindowV3Key(keyId, now - 2 * DAY_MS)) !== null);
  assert.ok(memoryKv.expiration(paidFallbackWindowV3Key(keyId, now + DAY_MS)) !== null);
});

test("backfill retries a row whose shard CAS failed instead of advancing past it", async () => {
  seedKeyRecord();
  const now = Date.now();
  await memoryKv.set(paidFallbackRequestV3Key(keyId, "bf-x"), settledRequestRow("bf-x", now - 2 * HOUR_MS));
  memoryKv.atomicConflictOnce = true;
  const conflicted = await backfillPaidFallbackUsageRollups(kv, { nowMs: now });
  assert.equal(conflicted.failed, 1);
  assert.equal(conflicted.processed, 0);
  assert.equal(conflicted.truncated, true);

  const retried = await backfillPaidFallbackUsageRollups(kv, { nowMs: now });
  assert.equal(retried.failed, 0);
  assert.equal(retried.processed, 1);
  assert.equal(retried.rollups_written, 1);
  assert.equal(retried.truncated, false);

  const rollups = await listPaidFallbackUsageRollups(kv, { sinceMs: now - 30 * DAY_MS, nowMs: now });
  assert.equal(
    rollups.reduce((sum, rollup) => sum + rollup.request_count, 0),
    1
  );
  assert.equal(
    rollups.reduce((sum, rollup) => sum + rollup.quota_sum, 0),
    60
  );
});

test("settlement records measured ledger bytes in the daily growth counters", async () => {
  await withMeteredEnv(async () => {
    seedKeyRecord();
    const now = Date.now();
    const dayKey = paidFallbackLedgerStatsDayKey(paidFallbackLedgerStatsDayStart(now));
    const before = (await memoryKv.get<PaidFallbackLedgerDailyStats>(dayKey)).value;
    const reservation = await reserve("qp-growth-settled", now);
    await settleSurplus(reservation);

    const after = (await memoryKv.get<PaidFallbackLedgerDailyStats>(dayKey)).value;
    assert.ok(after, "settlement must write the daily growth counters");
    assert.equal(isPaidFallbackLedgerDailyStats(after), true);
    const settledRows = after.settled_rows - (before?.settled_rows ?? 0);
    const settledBytes = after.settled_row_bytes - (before?.settled_row_bytes ?? 0);
    const rollupWrites = after.rollup_writes - (before?.rollup_writes ?? 0);
    const rollupBytes = after.rollup_bytes - (before?.rollup_bytes ?? 0);
    assert.equal(settledRows, 1);
    assert.equal(rollupWrites, 1);
    assert.ok(settledBytes > 400 && settledBytes < 2000, `measured settled row size ${settledBytes} should be near the ~800 B estimate`);
    assert.ok(rollupBytes > 0, "the merged rollup record size must be measured");

    const row = (await memoryKv.get<PaidFallbackRequestV3>(paidFallbackRequestV3Key(keyId, reservation.request_id))).value;
    assert.ok(row, "the settled row must exist");
    assert.equal(settledBytes, estimatePaidFallbackRecordBytes(row));

    // A replay never re-commits, so it must not inflate the daily counters.
    await settleSurplus(reservation);
    const replayed = (await memoryKv.get<PaidFallbackLedgerDailyStats>(dayKey)).value;
    assert.ok(replayed);
    assert.equal(replayed.settled_rows, after.settled_rows);
    assert.equal(replayed.settled_row_bytes, after.settled_row_bytes);
  });
});

test("ledger growth view derives bytes-per-row and the storage alert threshold", async () => {
  const now = Date.now();
  const threshold = Math.floor(PAID_FALLBACK_RAW_STORE_BUDGET_BYTES * PAID_FALLBACK_RAW_STORE_ALERT_RATIO);
  const isolated = new MemoryKv() as unknown as Kv;
  const dayStart = paidFallbackLedgerStatsDayStart(now);
  await isolated.set(paidFallbackLedgerStatsDayKey(dayStart), {
    v: 1,
    day_start_at_ms: dayStart,
    settled_rows: 1_000_000,
    settled_row_bytes: threshold,
    rollup_writes: 48,
    rollup_bytes: 50_000,
    projection_7d: { views: 1, read_units: 2, rollup_rows: 3 },
    projection_30d: { views: 2, read_units: 100, rollup_rows: 500 },
    projection_90d: { views: 4, read_units: 1_600, rollup_rows: 8_000 },
    updated_at_ms: now,
  });
  const growth = await readPaidFallbackLedgerGrowth(isolated, { nowMs: now, retentionMs: PAID_FALLBACK_REQUEST_LOG_RETENTION_MS });
  assert.equal(growth.scan, "ok");
  assert.equal(growth.alert, true);
  assert.equal(growth.alert_threshold_bytes, threshold);
  assert.equal(growth.budget_bytes, PAID_FALLBACK_RAW_STORE_BUDGET_BYTES);
  assert.equal(growth.estimated_retained_rows, 1_000_000);
  assert.equal(growth.estimated_retained_raw_bytes, threshold);
  assert.equal(growth.avg_row_bytes, Math.round(threshold / 1_000_000));
  assert.equal(growth.active_days, 1);
  assert.equal(growth.read_units, 2);
  const p90 = growth.projections.find((entry) => entry.window_days === 90);
  assert.ok(p90, "the 90-day projection summary must exist");
  assert.equal(p90.avg_read_units_per_view, 400);
  assert.equal(p90.avg_rollup_rows_per_view, 2_000);
  assert.equal(growth.leaderboard.length, 1);
  assert.equal(growth.leaderboard[0]?.projection_views, 7);

  const quiet = await readPaidFallbackLedgerGrowth(new MemoryKv() as unknown as Kv, {
    nowMs: now,
    retentionMs: PAID_FALLBACK_REQUEST_LOG_RETENTION_MS,
  });
  assert.equal(quiet.scan, "ok");
  assert.equal(quiet.alert, false);
  assert.equal(quiet.avg_row_bytes, null);
  assert.equal(quiet.read_units, 1);
  assert.equal(
    quiet.projections.every((entry) => entry.avg_read_units_per_view === null && entry.avg_rollup_rows_per_view === null),
    true
  );
});

test("projection views record KV read units per 7/30/90-day window", async () => {
  const now = Date.now();
  const isolated = new MemoryKv() as unknown as Kv;
  await recordPaidFallbackLedgerProjectionStats(isolated, { windowDays: 30, readUnits: 120, rollupRows: 100, nowMs: now });
  await recordPaidFallbackLedgerProjectionStats(isolated, { windowDays: 30, readUnits: 80, rollupRows: 60, nowMs: now });
  await recordPaidFallbackLedgerProjectionStats(isolated, { windowDays: 90, readUnits: 400, rollupRows: 380, nowMs: now });

  const stored = (await isolated.get<PaidFallbackLedgerDailyStats>(paidFallbackLedgerStatsDayKey(paidFallbackLedgerStatsDayStart(now)))).value;
  assert.ok(stored, "projection recording must write the daily counters");
  assert.equal(isPaidFallbackLedgerDailyStats(stored), true);
  assert.deepEqual(stored.projection_30d, { views: 2, read_units: 200, rollup_rows: 160 });

  const growth = await readPaidFallbackLedgerGrowth(isolated, { nowMs: now, retentionMs: PAID_FALLBACK_REQUEST_LOG_RETENTION_MS });
  const byWindow = new Map(growth.projections.map((entry) => [entry.window_days, entry]));
  assert.equal(byWindow.get(30)?.views, 2);
  assert.equal(byWindow.get(30)?.avg_read_units_per_view, 100);
  assert.equal(byWindow.get(30)?.avg_rollup_rows_per_view, 80);
  assert.equal(byWindow.get(90)?.views, 1);
  assert.equal(byWindow.get(90)?.avg_read_units_per_view, 400);
  assert.equal(byWindow.get(7)?.views, 0);
  assert.equal(byWindow.get(7)?.avg_read_units_per_view, null);
  assert.equal(growth.leaderboard.length, 1);
});

test("admin quota projection records and exposes the measured ledger growth", async () => {
  await withMeteredEnv(async () => {
    seedKeyRecord();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock(() => Promise.reject(new Error("offline projection test")));
    try {
      const { handleAdminProvidersQuotaProjection } = await import("../src/admin/kernel.ts");
      const dayKey = paidFallbackLedgerStatsDayKey(paidFallbackLedgerStatsDayStart(Date.now()));
      const before = (await memoryKv.get<PaidFallbackLedgerDailyStats>(dayKey)).value;
      const response = await handleAdminProvidersQuotaProjection(new Request("https://ai.ubq.fi/admin/providers/quota-projection?window_days=30"));
      assert.equal(response.status, 200);
      const payload = (await response.json()) as {
        ledger_growth?: { scan?: string; read_units?: number; projections?: { window_days: number; views: number; read_units: number }[] };
      };
      assert.ok(payload.ledger_growth, "the projection payload must carry the ledger growth view");
      assert.equal(payload.ledger_growth.scan, "ok");
      assert.deepEqual(
        payload.ledger_growth.projections?.map((entry) => entry.window_days),
        [7, 30, 90]
      );

      // The view measures itself for the next reader: the 30-day counters grew
      // by exactly one view whose read units cover the three scans plus entries.
      const after = (await memoryKv.get<PaidFallbackLedgerDailyStats>(dayKey)).value;
      assert.ok(after, "the admin view must record its projection counters");
      assert.equal(after.projection_30d.views - (before?.projection_30d.views ?? 0), 1);
      assert.ok(after.projection_30d.read_units - (before?.projection_30d.read_units ?? 0) >= 4);
      assert.equal(after.projection_7d.views, before?.projection_7d.views ?? 0);
      assert.equal(after.projection_90d.views, before?.projection_90d.views ?? 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
