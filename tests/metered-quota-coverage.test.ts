import { test } from "bun:test";
import type { AtomicOperation, Kv, KvCommitError, KvCommitResult, KvEntry, KvEntryMaybe, KvKey, KvListIterator, KvListOptions, KvListSelector } from "#kv";
import assert from "node:assert/strict";

import {
  fetchMeteredQuotaObservation,
  getCachedMeteredQuotaSnapshot,
  getMeteredQuotaDiagnostics,
  getMeteredQuotaSnapshot,
  invalidateMeteredQuotaSnapshot,
  METERED_API_KEY_ENV,
  METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS,
  METERED_QUOTA_BALANCE_HISTORY_PREFIX,
  METERED_QUOTA_COLD_WAIT_MS,
  METERED_QUOTA_FRESH_MS,
  METERED_QUOTA_INVALIDATION_KEY,
  METERED_QUOTA_REFRESH_LEASE_KEY,
  METERED_QUOTA_RETENTION_MS,
  METERED_QUOTA_STATE_KEY,
  type MeteredQuotaBalanceSample,
  type MeteredQuotaObservation,
  type MeteredQuotaState,
  meterQuotaAccountFingerprint,
  normalizeMeteredQuotaBalanceWindowDays,
  readMeteredQuotaBalanceHistory,
  resampleMeteredQuotaBalanceHistory,
  updateMeteredQuotaState,
  writeMeteredQuotaBalanceSample,
} from "../src/metered-quota.ts";
import {
  enqueueDuePaidFallbackReconciliationJobsV3,
  handlePaidFallbackReconciliationJobV3,
  runPaidFallbackBackfillV3,
} from "../src/paid-fallback/ledger-backfill.ts";
import { paidFallbackBackfillLeaseV3Key, paidFallbackBackfillStateV3Key, paidFallbackRequestV3Key } from "../src/paid-fallback/ledger-state.ts";
import {
  mergePaidFallbackUsageRollup,
  PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS,
  PAID_FALLBACK_USAGE_ROLLUP_PREFIX,
  paidFallbackUsageRollupKey,
  paidFallbackUsageRollupShard,
} from "../src/paid-fallback/rollups.ts";
import type { PaidFallbackRequestV3 } from "../src/types.ts";

const encodeKey = (key: KvKey): string => JSON.stringify(key);

type ReadBehavior = "value" | "null" | "throw";

type StoredEntry = Readonly<{ value: unknown; versionstamp: string }>;

type Mutation = { kind: "set"; key: KvKey; value: unknown; expireIn?: number } | { kind: "delete"; key: KvKey };

/**
 * Small in-memory Deno.Kv substitute. `Deno.openKv` needs `--unstable-kv`, which
 * the repository test command does not pass, so every metered-quota KV path is
 * driven through this stub. `planReads` scripts the first N reads of one key
 * (`value`, `null` or `throw`) and `conflictOnSet` forces a CAS conflict.
 */
class MeteredKv {
  readonly stored = new Map<string, StoredEntry>();
  readonly ttlOf = new Map<string, number | undefined>();
  readonly readLog: KvKey[] = [];
  #readPlan = new Map<string, ReadBehavior[]>();
  #conflicts = new Set<string>();
  #nextVersion = 1;

  seed(key: KvKey, value: unknown, expireIn?: number): void {
    this.stored.set(encodeKey(key), { value, versionstamp: this.#stamp() });
    this.ttlOf.set(encodeKey(key), expireIn);
  }

  value(key: KvKey): unknown {
    return this.stored.get(encodeKey(key))?.value ?? null;
  }

  has(key: KvKey): boolean {
    return this.stored.has(encodeKey(key));
  }

  planReads(key: KvKey, behaviors: readonly ReadBehavior[]): void {
    this.#readPlan.set(encodeKey(key), [...behaviors]);
  }

  conflictOnSet(key: KvKey): void {
    this.#conflicts.add(encodeKey(key));
  }

  get<T>(key: KvKey): Promise<KvEntryMaybe<T>> {
    this.readLog.push(key);
    const plan = this.#readPlan.get(encodeKey(key));
    const behavior = plan?.shift();
    if (behavior === "throw") return Promise.reject(new Error(`kv read failed for ${encodeKey(key)}`));
    if (behavior === "null") return Promise.resolve({ key, value: null, versionstamp: null } as KvEntryMaybe<T>);
    const entry = this.stored.get(encodeKey(key));
    return Promise.resolve({
      key,
      value: entry ? (entry.value as T) : null,
      versionstamp: entry?.versionstamp ?? null,
    } as KvEntryMaybe<T>);
  }

  list<T>(selector: KvListSelector, options?: KvListOptions): KvListIterator<T> {
    const start = "start" in selector ? selector.start : undefined;
    const end = "end" in selector ? selector.end : undefined;
    const prefix = "prefix" in selector ? selector.prefix : undefined;
    const last = (key: KvKey): unknown => key[key.length - 1];
    const matches = (key: KvKey): boolean => {
      if (prefix) return prefix.every((part, index) => Object.is(part, key[index]));
      if (start === undefined || end === undefined) return false;
      if (start.length !== end.length || key.length !== start.length) return false;
      for (let index = 0; index < start.length - 1; index += 1) {
        if (!Object.is(start[index], key[index])) return false;
      }
      const value = Number(last(key));
      return value >= Number(last(start)) && value < Number(last(end));
    };
    const selected = [...this.stored.entries()]
      .filter(([encoded]) => matches(JSON.parse(encoded) as KvKey))
      .sort((left, right) => {
        const leftPart = last(JSON.parse(left[0]) as KvKey);
        const rightPart = last(JSON.parse(right[0]) as KvKey);
        if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart - rightPart;
        return String(leftPart).localeCompare(String(rightPart));
      })
      .slice(0, options?.limit ?? 1_000);
    const iterator = (function* (): Generator<KvEntry<T>> {
      for (const [encoded, entry] of selected) {
        yield { key: JSON.parse(encoded) as KvKey, value: entry.value as T, versionstamp: entry.versionstamp };
      }
    })() as unknown as KvListIterator<T>;
    Object.defineProperty(iterator, "cursor", { get: () => "" });
    return iterator;
  }

  set(key: KvKey, value: unknown, options?: { expireIn?: number }): Promise<KvCommitResult | KvCommitError> {
    if (this.#conflicts.has(encodeKey(key))) return Promise.resolve({ ok: false } as KvCommitError);
    const versionstamp = this.#stamp();
    this.stored.set(encodeKey(key), { value, versionstamp });
    this.ttlOf.set(encodeKey(key), options?.expireIn);
    return Promise.resolve({ ok: true, versionstamp });
  }

  delete(key: KvKey): Promise<void> {
    this.stored.delete(encodeKey(key));
    return Promise.resolve();
  }

  atomic(): AtomicOperation {
    const checks: KvEntryMaybe<unknown>[] = [];
    const mutations: Mutation[] = [];
    const operation = {
      check: (...entries: KvEntryMaybe<unknown>[]) => {
        checks.push(...entries);
        return operation;
      },
      set: (key: KvKey, value: unknown, options?: { expireIn?: number }) => {
        mutations.push({ kind: "set", key, value, expireIn: options?.expireIn });
        return operation;
      },
      delete: (key: KvKey) => {
        mutations.push({ kind: "delete", key });
        return operation;
      },
      commit: (): Promise<KvCommitResult | KvCommitError> => {
        for (const check of checks) {
          const current = this.stored.get(encodeKey(check.key))?.versionstamp ?? null;
          if (current !== check.versionstamp) return Promise.resolve({ ok: false } as KvCommitError);
        }
        for (const mutation of mutations) {
          if (mutation.kind === "set" && this.#conflicts.has(encodeKey(mutation.key))) return Promise.resolve({ ok: false } as KvCommitError);
        }
        const versionstamp = this.#stamp();
        for (const mutation of mutations) {
          if (mutation.kind === "delete") this.stored.delete(encodeKey(mutation.key));
          else {
            this.stored.set(encodeKey(mutation.key), { value: mutation.value, versionstamp });
            this.ttlOf.set(encodeKey(mutation.key), mutation.expireIn);
          }
        }
        return Promise.resolve({ ok: true, versionstamp });
      },
    };
    return operation as unknown as AtomicOperation;
  }

  #stamp(): string {
    this.#nextVersion += 1;
    return String(this.#nextVersion).padStart(20, "0");
  }
}

const asKv = (kv: MeteredKv): Kv => kv as unknown as Kv;

const credentials = { apiKey: "metered-api-key" };

const withEnv = (key: string, value: string | undefined): (() => void) => {
  const previous = process.env[key];
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
  return () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = previous;
  };
};

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

type FetchCall = Readonly<{ url: string; init: RequestInit | undefined; headers: Headers }>;

const jsonFetcher =
  (
    payload: unknown,
    calls: FetchCall[] = [],
    status = 200,
    contentType = "application/json"
  ): ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  (input, init) => {
    calls.push({ url: requestUrl(input), init, headers: new Headers(init?.headers) });
    return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { "Content-Type": contentType } }));
  };

const rawFetcher =
  (
    body: string,
    calls: FetchCall[] = [],
    status = 200,
    contentType = "application/json"
  ): ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  (input, init) => {
    calls.push({ url: requestUrl(input), init, headers: new Headers(init?.headers) });
    return Promise.resolve(new Response(body, { status, headers: { "Content-Type": contentType } }));
  };

const tokenUsageEnvelope = (
  overrides: Partial<{ unlimited_quota: unknown; total_available: unknown; total_granted: unknown; total_used: unknown }> = {}
): unknown => ({
  success: true,
  data: {
    expires_at: 0,
    model_limits: {},
    model_limits_enabled: false,
    name: "business-key",
    object: "token_usage",
    total_available: 9_000,
    total_granted: 10_000,
    total_used: 1_000,
    unlimited_quota: false,
    ...overrides,
  },
});

const observation = (overrides: Partial<MeteredQuotaObservation> = {}): MeteredQuotaObservation => ({
  balance_quota: 50_000_000,
  used_quota: 100_000,
  quota_per_credit: 500_000,
  observed_at_ms: 1_000_000,
  latest_refill: { id: "refill-1", amount_credits: 100, completed_at_ms: 900_000 },
  ...overrides,
});

const walletState = (overrides: Partial<MeteredQuotaState> = {}): MeteredQuotaState => ({
  current_balance_quota: 50_000_000,
  post_refill_baseline_quota: 50_000_000,
  last_observed_used_quota: 100_000,
  quota_per_credit: 500_000,
  observed_at_ms: 1_000_000,
  cycle_started_at_ms: 900_000,
  confidence: "provisional",
  last_known_debits_quota: 0,
  last_inferred_credit_quota: 0,
  last_credit_at_ms: null,
  latest_refill_id: "refill-1",
  latest_refill_amount_credits: 100,
  latest_refill_completed_at_ms: 900_000,
  ...overrides,
});

const balanceSample = (overrides: Partial<MeteredQuotaBalanceSample> = {}): MeteredQuotaBalanceSample => ({
  v: 1,
  bucket_start_at_ms: METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS,
  observed_at_ms: METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS + 1,
  balance_quota: 10,
  baseline_quota: 20,
  quota_per_credit: 1,
  remaining_percent: 50,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Account fingerprint and window normalization
// ---------------------------------------------------------------------------

test("the account fingerprint is a stable non-secret digest of the configured key", async () => {
  const fingerprint = await meterQuotaAccountFingerprint(credentials);
  assert.match(fingerprint ?? "", /^[0-9a-f]{16}$/);
  assert.equal(await meterQuotaAccountFingerprint(credentials), fingerprint);
  assert.notEqual(await meterQuotaAccountFingerprint({ apiKey: "another-metered-key" }), fingerprint);
  assert.equal((fingerprint ?? "").includes(credentials.apiKey), false);
});

test("the account fingerprint refuses missing, blank and whitespace keys", async () => {
  assert.equal(await meterQuotaAccountFingerprint(null), null);
  assert.equal(await meterQuotaAccountFingerprint({ apiKey: "" }), null);
  assert.equal(await meterQuotaAccountFingerprint({ apiKey: "  " }), null);
  assert.equal(await meterQuotaAccountFingerprint({ apiKey: "before after" }), null);
});

test("the balance window accepts only published day counts", () => {
  assert.equal(normalizeMeteredQuotaBalanceWindowDays("7"), 7);
  assert.equal(normalizeMeteredQuotaBalanceWindowDays("30"), 30);
  assert.equal(normalizeMeteredQuotaBalanceWindowDays("365"), 365);
  assert.equal(normalizeMeteredQuotaBalanceWindowDays("5"), 7);
  assert.equal(normalizeMeteredQuotaBalanceWindowDays(null), 7);
  assert.equal(normalizeMeteredQuotaBalanceWindowDays("7.5"), 7);
});

// ---------------------------------------------------------------------------
// Observation fetch
// ---------------------------------------------------------------------------

test("a Metered observation rejects invalid credentials before any request", async () => {
  const calls: FetchCall[] = [];
  await assert.rejects(
    () => fetchMeteredQuotaObservation({ apiKey: "not valid" }, { fetcher: jsonFetcher(tokenUsageEnvelope(), calls) }),
    /Metered account credentials are invalid/
  );
  assert.equal(calls.length, 0);
});

test("a Metered observation request is a manual-redirect JSON GET with a combined deadline", async () => {
  const calls: FetchCall[] = [];
  await fetchMeteredQuotaObservation(credentials, { fetcher: jsonFetcher(tokenUsageEnvelope(), calls), now: () => 2_000_000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.openlux.ai/api/usage/token/");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.redirect, "manual");
  assert.equal(calls[0]?.headers.get("Accept"), "application/json");
  assert.equal(calls[0]?.headers.get("Authorization"), "Bearer metered-api-key");
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
});

test("a Metered observation reports every upstream transport fault", async () => {
  await assert.rejects(
    () => fetchMeteredQuotaObservation(credentials, { fetcher: rawFetcher("rate limited", [], 429, "text/plain") }),
    /Metered account API returned HTTP 429/
  );
  await assert.rejects(
    () => fetchMeteredQuotaObservation(credentials, { fetcher: rawFetcher("not json", [], 200, "text/plain") }),
    /Metered account API returned non-JSON data/
  );
  await assert.rejects(
    () => fetchMeteredQuotaObservation(credentials, { fetcher: rawFetcher("{not json", [], 200, "application/json") }),
    /Metered account API returned invalid JSON/
  );
});

test("a Metered observation rejects envelopes that do not carry token usage", async () => {
  await assert.rejects(
    () => fetchMeteredQuotaObservation(credentials, { fetcher: jsonFetcher({ success: false, message: "bad key" }) }),
    /Metered account API returned an invalid envelope/
  );
  await assert.rejects(
    () => fetchMeteredQuotaObservation(credentials, { fetcher: jsonFetcher({ success: true, data: "nope" }) }),
    /Metered account API returned an invalid envelope/
  );
  await assert.rejects(
    () => fetchMeteredQuotaObservation(credentials, { fetcher: jsonFetcher(tokenUsageEnvelope({ total_used: "1000" })) }),
    /Metered account API returned invalid token usage data/
  );
  await assert.rejects(
    () => fetchMeteredQuotaObservation(credentials, { fetcher: jsonFetcher(tokenUsageEnvelope({ unlimited_quota: undefined })) }),
    /Metered account API returned invalid token usage data/
  );
});

test("a Metered observation rejects an invalid clock", async () => {
  await assert.rejects(
    () => fetchMeteredQuotaObservation(credentials, { fetcher: jsonFetcher(tokenUsageEnvelope()), now: () => -1 }),
    /Metered quota observation clock is invalid/
  );
  await assert.rejects(
    () => fetchMeteredQuotaObservation(credentials, { fetcher: jsonFetcher(tokenUsageEnvelope()), now: () => Number.NaN }),
    /Metered quota observation clock is invalid/
  );
});

test("a Metered token usage observation keeps provider totals and neutral wallet fields", async () => {
  const result = await fetchMeteredQuotaObservation(credentials, {
    fetcher: jsonFetcher(tokenUsageEnvelope({ unlimited_quota: true, total_available: -53_413 }), [], 200),
    now: () => 2_000_000.9,
  });

  assert.deepEqual(result, {
    balance_quota: null,
    used_quota: null,
    quota_per_credit: null,
    observed_at_ms: 2_000_000,
    latest_refill: null,
    unlimited_quota: true,
    total_available: -53_413,
    total_granted: 10_000,
    total_used: 1_000,
  });
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

test("token usage becomes a neutral provisional state with no spendable credit", () => {
  const next = updateMeteredQuotaState(null, observation({ unlimited_quota: true, total_available: 9_000, total_granted: 10_000, total_used: 1_000 }));

  assert.equal(next.current_balance_quota, 0);
  assert.equal(next.post_refill_baseline_quota, 0);
  assert.equal(next.last_observed_used_quota, 0);
  assert.equal(next.quota_per_credit, 1);
  assert.equal(next.confidence, "provisional");
  assert.equal(next.observed_at_ms, 1_000_000);
  assert.equal(next.cycle_started_at_ms, 1_000_000);
  assert.equal(next.unlimited_quota, true);
  assert.equal(next.total_available, 9_000);
  assert.equal(next.total_granted, 10_000);
  assert.equal(next.total_used, 1_000);
  assert.equal(next.latest_refill_id, null);
});

test("token usage supersedes a retained wallet state", () => {
  const next = updateMeteredQuotaState(walletState(), observation({ unlimited_quota: false, total_available: 1, total_granted: 2, total_used: 1 }));
  assert.equal(next.current_balance_quota, 0);
  assert.equal(next.latest_refill_id, null);
});

test("an incomplete token usage observation is rejected", () => {
  assert.throws(() => updateMeteredQuotaState(null, observation({ total_used: 5 })), /Metered token usage observation is incomplete/);
  assert.throws(() => updateMeteredQuotaState(null, observation({ unlimited_quota: true })), /Metered token usage observation is incomplete/);
});

test("a wallet observation without credit fields is rejected", () => {
  assert.throws(
    () => updateMeteredQuotaState(null, observation({ balance_quota: null, used_quota: null, quota_per_credit: null })),
    /Metered wallet observation is incomplete/
  );
  assert.throws(() => updateMeteredQuotaState(null, observation({ quota_per_credit: null })), /Metered wallet observation is incomplete/);
});

test("a first wallet observation without a refill keeps neutral refill metadata", () => {
  const next = updateMeteredQuotaState(null, observation({ latest_refill: null }));

  assert.equal(next.current_balance_quota, 50_000_000);
  assert.equal(next.post_refill_baseline_quota, 50_000_000);
  assert.equal(next.cycle_started_at_ms, 1_000_000);
  assert.equal(next.latest_refill_id, null);
  assert.equal(next.latest_refill_amount_credits, null);
  assert.equal(next.latest_refill_completed_at_ms, null);
  assert.equal(next.confidence, "provisional");
});

test("an advanced wallet observation keeps prior refill metadata when no refill is reported", () => {
  const previous = walletState();
  const next = updateMeteredQuotaState(previous, observation({ balance_quota: 49_000_000, used_quota: 1_100_000, latest_refill: null }));

  assert.equal(next.latest_refill_id, previous.latest_refill_id);
  assert.equal(next.latest_refill_amount_credits, previous.latest_refill_amount_credits);
  assert.equal(next.latest_refill_completed_at_ms, previous.latest_refill_completed_at_ms);
  assert.equal(next.last_known_debits_quota, 1_000_000);
  assert.equal(next.confidence, "provisional");
});

// ---------------------------------------------------------------------------
// Snapshot reads
// ---------------------------------------------------------------------------

test("a fresh cached wallet state answers without touching the network", async () => {
  const kv = new MeteredKv();
  const now = 10_000_000;
  kv.seed(
    METERED_QUOTA_STATE_KEY,
    walletState({ observed_at_ms: now, post_refill_baseline_quota: 50_000_000, current_balance_quota: 25_000_000 }),
    METERED_QUOTA_RETENTION_MS
  );

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    now: () => now,
    fetcher: () => Promise.reject(new Error("must not fetch")),
  });

  assert.equal(snapshot?.cache_state, "fresh");
  assert.equal(snapshot.balance_credits, 50);
  assert.equal(snapshot.baseline_credits, 100);
  assert.equal(snapshot.remaining_percent, 50);
  assert.equal(snapshot.used_percent, 50);
  assert.equal(snapshot.last_inferred_credit_credits, 0);
  assert.equal(snapshot.unlimited_quota, false);
  assert.equal(snapshot.total_available, null);
  assert.equal(snapshot.total_granted, null);
  assert.equal(snapshot.total_used, null);
});

test("a zero baseline reports no remaining percentage instead of dividing by zero", async () => {
  const kv = new MeteredKv();
  const now = 12_000_000;
  kv.seed(METERED_QUOTA_STATE_KEY, walletState({ observed_at_ms: now, current_balance_quota: 0, post_refill_baseline_quota: 0 }));

  const snapshot = await getCachedMeteredQuotaSnapshot({ kv: asKv(kv), now: () => now });

  assert.equal(snapshot?.cache_state, "fresh");
  assert.equal(snapshot.remaining_percent, null);
  assert.equal(snapshot.used_percent, null);
  assert.equal(snapshot.balance_credits, 0);
  assert.equal(snapshot.baseline_credits, 0);
});

test("a token usage snapshot carries no credit or percentage fields", async () => {
  const kv = new MeteredKv();
  const now = 13_000_000;
  kv.seed(
    METERED_QUOTA_STATE_KEY,
    walletState({ observed_at_ms: now, unlimited_quota: true, total_available: -53_413, total_granted: -545, total_used: 52_868 })
  );

  const snapshot = await getCachedMeteredQuotaSnapshot({ kv: asKv(kv), now: () => now });

  assert.equal(snapshot?.cache_state, "fresh");
  assert.equal(snapshot.balance_credits, null);
  assert.equal(snapshot.baseline_credits, null);
  assert.equal(snapshot.last_inferred_credit_credits, null);
  assert.equal(snapshot.remaining_percent, null);
  assert.equal(snapshot.used_percent, null);
  assert.equal(snapshot.unlimited_quota, true);
  assert.equal(snapshot.total_available, -53_413);
  assert.equal(snapshot.total_granted, -545);
  assert.equal(snapshot.total_used, 52_868);
});

test("a cache peek without a KV or without retained state reports nothing", async () => {
  assert.equal(await getCachedMeteredQuotaSnapshot({ kv: null }), null);

  const kv = new MeteredKv();
  assert.equal(await getCachedMeteredQuotaSnapshot({ kv: asKv(kv), now: () => 1 }), null);
});

test("a cache peek reports a KV read failure instead of throwing", async () => {
  const kv = new MeteredKv();
  kv.planReads(METERED_QUOTA_STATE_KEY, ["throw"]);

  assert.equal(await getCachedMeteredQuotaSnapshot({ kv: asKv(kv), now: () => 1 }), null);
});

test("a snapshot request refuses unusable credentials or a missing KV", async () => {
  assert.equal(await getMeteredQuotaSnapshot({ apiKey: "bad key" }, { kv: null }), null);
  assert.equal(await getMeteredQuotaSnapshot(credentials, { kv: null }), null);
});

test("a snapshot request survives a failed cache read and still refreshes", async () => {
  const kv = new MeteredKv();
  const now = 14_000_000;
  kv.planReads(METERED_QUOTA_STATE_KEY, ["throw"]);
  const calls: FetchCall[] = [];

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    now: () => now,
    fetcher: jsonFetcher(tokenUsageEnvelope(), calls),
    createLeaseOwner: () => "cache-read-failure-owner",
  });

  assert.equal(snapshot?.cache_state, "refreshed");
  assert.equal(calls.length, 1);
  assert.equal(snapshot.total_used, 1_000);
});

test("a snapshot request survives a failed invalidation read and still refreshes", async () => {
  const kv = new MeteredKv();
  const now = 15_000_000;
  kv.planReads(METERED_QUOTA_INVALIDATION_KEY, ["throw"]);
  kv.seed(METERED_QUOTA_STATE_KEY, walletState({ observed_at_ms: now - METERED_QUOTA_FRESH_MS, latest_refill_id: "0" }));
  const calls: FetchCall[] = [];

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    now: () => now,
    fetcher: jsonFetcher(tokenUsageEnvelope(), calls),
    createLeaseOwner: () => "invalidation-read-failure-owner",
  });

  assert.equal(snapshot?.cache_state, "refreshed");
  assert.equal(calls.length, 1);
});

test("a live lease serves the retained stale state immediately", async () => {
  const kv = new MeteredKv();
  const observedAt = Date.now() - METERED_QUOTA_FRESH_MS;
  const cached = walletState({ observed_at_ms: observedAt, current_balance_quota: 25_000_000 });
  kv.seed(METERED_QUOTA_STATE_KEY, cached);
  kv.seed(METERED_QUOTA_REFRESH_LEASE_KEY, { owner: "another-worker", lease_until_ms: Date.now() + 60_000 });

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    fetcher: () => Promise.reject(new Error("must not fetch")),
    createLeaseOwner: () => "blocked-owner",
  });

  assert.equal(snapshot?.cache_state, "stale");
  assert.equal(snapshot.state.current_balance_quota, 25_000_000);
  assert.equal(snapshot.remaining_percent, 50);
});

test("a refused refresh commit keeps the stored state and serves it as stale", async () => {
  const kv = new MeteredKv();
  const observedAt = Date.now() - METERED_QUOTA_FRESH_MS;
  const cached = walletState({ observed_at_ms: observedAt, current_balance_quota: 20_000_000 });
  kv.seed(METERED_QUOTA_STATE_KEY, cached);
  kv.conflictOnSet(METERED_QUOTA_STATE_KEY);

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    fetcher: jsonFetcher(tokenUsageEnvelope()),
    createLeaseOwner: () => "losing-commit-owner",
  });

  assert.equal(snapshot?.cache_state, "stale");
  assert.equal(snapshot.state.current_balance_quota, 20_000_000);
  assert.deepEqual(kv.value(METERED_QUOTA_STATE_KEY), cached);
  assert.equal(kv.value(METERED_QUOTA_REFRESH_LEASE_KEY), null);
  assert.equal(
    [...kv.stored.keys()].some((encoded) => encoded.includes("balance_history")),
    false
  );
});

test("a held refresh lease makes the caller wait for retained state", async () => {
  const kv = new MeteredKv();
  const observedAt = Date.now() - METERED_QUOTA_FRESH_MS;
  kv.seed(METERED_QUOTA_REFRESH_LEASE_KEY, { owner: "another-worker", lease_until_ms: Date.now() + 60_000 });
  kv.seed(METERED_QUOTA_STATE_KEY, walletState({ observed_at_ms: observedAt }));
  kv.planReads(METERED_QUOTA_STATE_KEY, ["null"]);

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    fetcher: () => Promise.reject(new Error("must not fetch")),
    createLeaseOwner: () => "waiting-owner",
  });

  assert.equal(snapshot?.cache_state, "wait");
  assert.equal(snapshot.state.observed_at_ms, observedAt);
  assert.equal(snapshot.remaining_percent, 100);
  assert.equal(kv.value(METERED_QUOTA_STATE_KEY) === null, false);
});

test("a held refresh lease with no retained state gives up after the cold wait", async () => {
  const startedAt = Date.now();
  const kv = new MeteredKv();
  kv.seed(METERED_QUOTA_REFRESH_LEASE_KEY, { owner: "another-worker", lease_until_ms: Date.now() + 60_000 });

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    fetcher: () => Promise.reject(new Error("must not fetch")),
    createLeaseOwner: () => "cold-wait-owner",
  });

  assert.equal(snapshot, null);
  assert.ok(Date.now() - startedAt >= METERED_QUOTA_COLD_WAIT_MS);
  assert.equal(kv.readLog.filter((key) => encodeKey(key) === encodeKey(METERED_QUOTA_STATE_KEY)).length > 10, true);
});

test("a snapshot request reports no state when the lease read and the cold wait fail", async () => {
  const kv = new MeteredKv();
  kv.planReads(METERED_QUOTA_REFRESH_LEASE_KEY, ["throw"]);
  kv.planReads(METERED_QUOTA_STATE_KEY, ["null", "throw"]);

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    fetcher: () => Promise.reject(new Error("must not fetch")),
    createLeaseOwner: () => "unavailable-owner",
  });

  assert.equal(snapshot, null);
});

test("a stale cached state is served while the refresh lease is lost during the fetch", async () => {
  const kv = new MeteredKv();
  const observedAt = Date.now() - METERED_QUOTA_FRESH_MS;
  kv.seed(METERED_QUOTA_STATE_KEY, walletState({ observed_at_ms: observedAt, current_balance_quota: 20_000_000 }));

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    fetcher: (_input, init) => {
      kv.seed(METERED_QUOTA_REFRESH_LEASE_KEY, { owner: "thief", lease_until_ms: Date.now() + 60_000 });
      assert.ok(init?.signal instanceof AbortSignal);
      return Promise.resolve(new Response(JSON.stringify(tokenUsageEnvelope()), { headers: { "Content-Type": "application/json" } }));
    },
    createLeaseOwner: () => "losing-owner",
  });

  assert.equal(snapshot?.cache_state, "stale");
  assert.equal(snapshot.state.current_balance_quota, 20_000_000);
  assert.equal(snapshot.state.observed_at_ms, observedAt);
});

test("a refresh whose retained state disappears falls back to the cached state", async () => {
  const kv = new MeteredKv();
  const observedAt = Date.now() - METERED_QUOTA_FRESH_MS;
  kv.seed(METERED_QUOTA_STATE_KEY, walletState({ observed_at_ms: observedAt, current_balance_quota: 30_000_000 }));
  // Reads: 1 cache probe, 2 refresh state entry, 3 replacement probe.
  kv.planReads(METERED_QUOTA_STATE_KEY, ["value", "value", "null"]);

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    fetcher: () => {
      kv.seed(METERED_QUOTA_REFRESH_LEASE_KEY, { owner: "thief", lease_until_ms: Date.now() + 60_000 });
      return Promise.resolve(new Response(JSON.stringify(tokenUsageEnvelope()), { headers: { "Content-Type": "application/json" } }));
    },
    createLeaseOwner: () => "losing-owner",
  });

  assert.equal(snapshot?.cache_state, "stale");
  assert.equal(snapshot.state.current_balance_quota, 30_000_000);
});

test("a refresh that loses its lease with no retained state reports nothing", async () => {
  const kv = new MeteredKv();
  kv.planReads(METERED_QUOTA_STATE_KEY, ["null", "null", "null"]);

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    fetcher: () => {
      kv.seed(METERED_QUOTA_REFRESH_LEASE_KEY, { owner: "thief", lease_until_ms: Date.now() + 60_000 });
      return Promise.resolve(new Response(JSON.stringify(tokenUsageEnvelope()), { headers: { "Content-Type": "application/json" } }));
    },
    createLeaseOwner: () => "losing-owner",
  });

  assert.equal(snapshot, null);
});

test("a refresh keeps the lease it acquired and stores the observation with its retention TTL", async () => {
  const kv = new MeteredKv();
  const now = 16_000_000;
  const calls: FetchCall[] = [];

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    now: () => now,
    fetcher: jsonFetcher(tokenUsageEnvelope(), calls),
    createLeaseOwner: () => "committing-owner",
  });

  assert.equal(snapshot?.cache_state, "refreshed");
  assert.equal(kv.value(METERED_QUOTA_REFRESH_LEASE_KEY), null);
  assert.equal(kv.ttlOf.get(encodeKey(METERED_QUOTA_STATE_KEY)), METERED_QUOTA_RETENTION_MS);
  assert.deepEqual(kv.value(METERED_QUOTA_STATE_KEY), snapshot.state);
  assert.equal(calls.length, 1);
});

test("a failed refresh lease release never fails the answered snapshot", async () => {
  const kv = new MeteredKv();
  const now = 17_000_000;
  // Reads: 1 acquire probe, 2 lease re-check, 3 release probe.
  kv.planReads(METERED_QUOTA_REFRESH_LEASE_KEY, ["null", "value", "throw"]);

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    now: () => now,
    fetcher: jsonFetcher(tokenUsageEnvelope()),
    createLeaseOwner: () => "release-failure-owner",
  });

  assert.equal(snapshot?.cache_state, "refreshed");
  assert.equal(snapshot.total_used, 1_000);
});

test("a failed balance-history write never fails the answered snapshot", async () => {
  const kv = new MeteredKv();
  const now = 18_000_000;
  const fingerprint = await meterQuotaAccountFingerprint(credentials);
  assert.ok(fingerprint);
  const bucketStart = Math.floor(now / METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS) * METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS;
  kv.planReads([...METERED_QUOTA_BALANCE_HISTORY_PREFIX, fingerprint, bucketStart], ["throw"]);

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    now: () => now,
    fetcher: jsonFetcher(tokenUsageEnvelope()),
    createLeaseOwner: () => "history-failure-owner",
  });

  assert.equal(snapshot?.cache_state, "refreshed");
  assert.equal(kv.ttlOf.get(encodeKey(METERED_QUOTA_STATE_KEY)), METERED_QUOTA_RETENTION_MS);
});

test("a refresh failure with no cached state reports nothing", async () => {
  const kv = new MeteredKv();
  const now = 19_000_000;

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: asKv(kv),
    now: () => now,
    fetcher: () => Promise.reject(new Error("outage")),
    createLeaseOwner: () => "failing-owner",
  });

  assert.equal(snapshot, null);
  assert.equal(kv.value(METERED_QUOTA_REFRESH_LEASE_KEY), null);
});

test("an aborted refresh rethrows instead of serving stale state", async () => {
  const kv = new MeteredKv();
  const now = 19_500_000;
  kv.seed(METERED_QUOTA_STATE_KEY, walletState({ observed_at_ms: now - METERED_QUOTA_FRESH_MS }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      getMeteredQuotaSnapshot(credentials, {
        kv: asKv(kv),
        now: () => now,
        signal: controller.signal,
        fetcher: () => Promise.reject(new Error("aborted")),
        createLeaseOwner: () => "aborted-owner",
      }),
    /aborted/
  );
});

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

test("invalidation records one retention-bounded marker", async () => {
  const kv = new MeteredKv();
  await invalidateMeteredQuotaSnapshot({ kv: asKv(kv), now: () => 1_234.9 });

  assert.deepEqual(kv.value(METERED_QUOTA_INVALIDATION_KEY), { invalidated_at_ms: 1_234 });
  assert.equal(kv.ttlOf.get(encodeKey(METERED_QUOTA_INVALIDATION_KEY)), METERED_QUOTA_RETENTION_MS);
});

test("invalidation without a KV or with an invalid clock is refused", async () => {
  await invalidateMeteredQuotaSnapshot({ kv: null });

  const kv = new MeteredKv();
  await assert.rejects(() => invalidateMeteredQuotaSnapshot({ kv: asKv(kv), now: () => Number.NaN }), /Metered quota invalidation clock is invalid/);
  assert.equal(kv.has(METERED_QUOTA_INVALIDATION_KEY), false);
});

test("invalidation reports a refused KV commit", async () => {
  const kv = new MeteredKv();
  kv.conflictOnSet(METERED_QUOTA_INVALIDATION_KEY);

  await assert.rejects(() => invalidateMeteredQuotaSnapshot({ kv: asKv(kv), now: () => 5 }), /Deno KV could not invalidate the Metered quota snapshot/);
});

// ---------------------------------------------------------------------------
// Balance history
// ---------------------------------------------------------------------------

test("a balance sample is keyed by account and hour bucket", async () => {
  const kv = new MeteredKv();
  const state = walletState();
  await writeMeteredQuotaBalanceSample(asKv(kv), state, 3_600_000 + 900, "fingerprint-a");

  const key = [...METERED_QUOTA_BALANCE_HISTORY_PREFIX, "fingerprint-a", 3_600_000];
  assert.deepEqual(kv.value(key), {
    v: 1,
    bucket_start_at_ms: 3_600_000,
    observed_at_ms: 3_600_900,
    balance_quota: 50_000_000,
    baseline_quota: 50_000_000,
    quota_per_credit: 500_000,
    remaining_percent: 100,
  });
});

test("a token usage balance sample keeps the provider totals and no percentage", async () => {
  const kv = new MeteredKv();
  const state = updateMeteredQuotaState(null, observation({ unlimited_quota: true, total_available: 9_000, total_granted: 10_000, total_used: 1_000 }));
  await writeMeteredQuotaBalanceSample(asKv(kv), state, 7_200_000, "fingerprint-a");

  const stored = kv.value([...METERED_QUOTA_BALANCE_HISTORY_PREFIX, "fingerprint-a", 7_200_000]);
  assert.deepEqual(stored, {
    v: 1,
    bucket_start_at_ms: 7_200_000,
    observed_at_ms: 7_200_000,
    balance_quota: 0,
    baseline_quota: 0,
    quota_per_credit: 1,
    remaining_percent: null,
    unlimited_quota: true,
    total_available: 9_000,
    total_granted: 10_000,
    total_used: 1_000,
  });
});

test("a balance sample refuses an invalid clock or a missing account fingerprint", async () => {
  const kv = new MeteredKv();

  await writeMeteredQuotaBalanceSample(asKv(kv), walletState(), -1, "fingerprint-a");
  await writeMeteredQuotaBalanceSample(asKv(kv), walletState(), 3_600_000, null);
  assert.equal(kv.stored.size, 0);
});

test("a balance sample never overwrites a newer observation in the same hour", async () => {
  const kv = new MeteredKv();
  const key = [...METERED_QUOTA_BALANCE_HISTORY_PREFIX, "fingerprint-a", 3_600_000];
  const newest = balanceSample({ observed_at_ms: 3_600_900, balance_quota: 11 });
  kv.seed(key, newest);

  await writeMeteredQuotaBalanceSample(asKv(kv), walletState(), 3_600_500, "fingerprint-a");

  assert.deepEqual(kv.value(key), newest);
});

test("a persistently contended balance history write fails loudly", async () => {
  const kv = new MeteredKv();
  const key = [...METERED_QUOTA_BALANCE_HISTORY_PREFIX, "fingerprint-a", 3_600_000];
  kv.conflictOnSet(key);

  await assert.rejects(
    () => writeMeteredQuotaBalanceSample(asKv(kv), walletState(), 3_600_000, "fingerprint-a"),
    /Metered quota balance history changed concurrently/
  );
});

test("a balance history read requires a KV and an account fingerprint", async () => {
  assert.deepEqual(await readMeteredQuotaBalanceHistory(null, { sinceMs: 0, nowMs: 10, accountFingerprint: "fingerprint-a" }), []);

  const kv = new MeteredKv();
  assert.deepEqual(await readMeteredQuotaBalanceHistory(asKv(kv), { sinceMs: 0, nowMs: 10, accountFingerprint: null }), []);
});

test("a balance history read returns only this account's samples inside the window", async () => {
  const kv = new MeteredKv();
  const bucket = METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS;
  kv.seed([...METERED_QUOTA_BALANCE_HISTORY_PREFIX, "fingerprint-a", bucket], balanceSample({ bucket_start_at_ms: bucket, observed_at_ms: bucket + 10 }));
  kv.seed(
    [...METERED_QUOTA_BALANCE_HISTORY_PREFIX, "fingerprint-a", bucket * 2],
    balanceSample({ bucket_start_at_ms: bucket * 2, observed_at_ms: bucket * 2 + 10 })
  );
  kv.seed(
    [...METERED_QUOTA_BALANCE_HISTORY_PREFIX, "fingerprint-a", bucket * 3],
    balanceSample({ bucket_start_at_ms: bucket * 3, observed_at_ms: bucket * 3 + 10 })
  );
  kv.seed([...METERED_QUOTA_BALANCE_HISTORY_PREFIX, "fingerprint-b", bucket], balanceSample({ bucket_start_at_ms: bucket, observed_at_ms: bucket + 10 }));
  kv.seed([...METERED_QUOTA_BALANCE_HISTORY_PREFIX, "fingerprint-a", bucket * 4], { v: 2, bucket_start_at_ms: bucket * 4 });

  const samples = await readMeteredQuotaBalanceHistory(asKv(kv), {
    sinceMs: bucket + 1,
    nowMs: bucket * 2 + 20,
    accountFingerprint: "fingerprint-a",
  });

  assert.deepEqual(
    samples.map((sample) => sample.observed_at_ms),
    [bucket + 10, bucket * 2 + 10]
  );
  assert.deepEqual(
    samples.map((sample) => sample.bucket_start_at_ms),
    [bucket, bucket * 2]
  );
});

test("a balance history read honors the requested row limit", async () => {
  const kv = new MeteredKv();
  const bucket = METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS;
  for (let index = 1; index <= 4; index += 1) {
    kv.seed(
      [...METERED_QUOTA_BALANCE_HISTORY_PREFIX, "fingerprint-a", bucket * index],
      balanceSample({ bucket_start_at_ms: bucket * index, observed_at_ms: bucket * index + 5 })
    );
  }

  const limited = await readMeteredQuotaBalanceHistory(asKv(kv), { sinceMs: 0, nowMs: bucket * 5, accountFingerprint: "fingerprint-a", limit: 2 });
  assert.deepEqual(
    limited.map((sample) => sample.bucket_start_at_ms),
    [bucket, bucket * 2]
  );

  const floored = await readMeteredQuotaBalanceHistory(asKv(kv), { sinceMs: 0, nowMs: bucket * 5, accountFingerprint: "fingerprint-a", limit: 0 });
  assert.equal(floored.length, 1);

  const clamped = await readMeteredQuotaBalanceHistory(asKv(kv), { sinceMs: 0, nowMs: bucket * 5, accountFingerprint: "fingerprint-a", limit: 5_000_000 });
  assert.equal(clamped.length, 4);
});

test("resampling rejects unusable bucket or limit values", () => {
  const samples = [balanceSample()];
  assert.deepEqual(resampleMeteredQuotaBalanceHistory(samples, 0, 10), []);
  assert.deepEqual(resampleMeteredQuotaBalanceHistory(samples, -1, 10), []);
  assert.deepEqual(resampleMeteredQuotaBalanceHistory(samples, 1.5, 10), []);
  assert.deepEqual(resampleMeteredQuotaBalanceHistory(samples, 3_600_000, 0), []);
  assert.deepEqual(resampleMeteredQuotaBalanceHistory(samples, 3_600_000, -3), []);
});

test("resampling keeps the newest observation in each bucket and the latest buckets", () => {
  const hour = METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS;
  const samples: MeteredQuotaBalanceSample[] = [
    balanceSample({ bucket_start_at_ms: hour, observed_at_ms: hour + 100, balance_quota: 1 }),
    balanceSample({ bucket_start_at_ms: hour, observed_at_ms: hour + 200, balance_quota: 2 }),
    balanceSample({ bucket_start_at_ms: hour * 2, observed_at_ms: hour * 2 + 100, balance_quota: 3 }),
    balanceSample({ bucket_start_at_ms: hour * 3, observed_at_ms: hour * 3 + 100, balance_quota: 4 }),
  ];

  const resampled = resampleMeteredQuotaBalanceHistory(samples, hour, 2);

  assert.deepEqual(
    resampled.map((sample) => sample.bucket_start_at_ms),
    [hour * 2, hour * 3]
  );
  assert.deepEqual(
    resampled.map((sample) => sample.balance_quota),
    [3, 4]
  );

  const single = resampleMeteredQuotaBalanceHistory(samples, hour, 10);
  assert.deepEqual(
    single.map((sample) => sample.balance_quota),
    [2, 3, 4]
  );
  assert.equal(single[0]?.bucket_start_at_ms, hour);
  assert.equal(single[0]?.observed_at_ms, hour + 200);
});

test("resampling breaks an observation-time tie by the source bucket timestamp", () => {
  const hour = METERED_QUOTA_BALANCE_HISTORY_BUCKET_MS;
  const observedAt = hour * 5 + 30;
  const newerBucket = balanceSample({ bucket_start_at_ms: observedAt, observed_at_ms: observedAt, balance_quota: 1 });
  const olderBucket = balanceSample({ bucket_start_at_ms: observedAt - 1, observed_at_ms: observedAt, balance_quota: 2 });

  // The comparison runs against the normalized bucket start already stored, so
  // a later-iterated sample whose own bucket timestamp is above that normalized
  // start replaces the stored one. Both orders stay deterministic.
  const [fromOlderFirst] = resampleMeteredQuotaBalanceHistory([olderBucket, newerBucket], hour, 1);
  assert.deepEqual(fromOlderFirst, { ...olderBucket, balance_quota: 1, bucket_start_at_ms: hour * 5 });

  const [fromNewerFirst] = resampleMeteredQuotaBalanceHistory([newerBucket, olderBucket], hour, 1);
  assert.deepEqual(fromNewerFirst, { ...olderBucket, bucket_start_at_ms: hour * 5 });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

test("diagnostics report an unconfigured Metered account without touching the network", async () => {
  const restore = withEnv(METERED_API_KEY_ENV, "");
  try {
    const diagnostics = await getMeteredQuotaDiagnostics({ kv: null });
    assert.deepEqual(diagnostics, {
      configured: false,
      available: false,
      cache_state: null,
      confidence: null,
      balance_credits: null,
      baseline_credits: null,
      remaining_percent: null,
      used_percent: null,
      observed_at_ms: null,
      cycle_started_at_ms: null,
      last_known_debits_credits: null,
      last_inferred_credit_credits: null,
      last_credit_at_ms: null,
      latest_refill_id: null,
      latest_refill_amount_credits: null,
      latest_refill_completed_at_ms: null,
      unlimited_quota: null,
      total_available: null,
      total_granted: null,
      total_used: null,
    });
  } finally {
    restore();
  }
});

test("diagnostics report a configured account with no reachable snapshot", async () => {
  const restore = withEnv(METERED_API_KEY_ENV, credentials.apiKey);
  try {
    const diagnostics = await getMeteredQuotaDiagnostics({ kv: null });
    assert.equal(diagnostics.configured, true);
    assert.equal(diagnostics.available, false);
    assert.equal(diagnostics.cache_state, null);
    assert.equal(diagnostics.total_used, null);
  } finally {
    restore();
  }
});

test("diagnostics describe a wallet snapshot with confidence and debit history", async () => {
  const restore = withEnv(METERED_API_KEY_ENV, credentials.apiKey);
  try {
    const kv = new MeteredKv();
    const now = 21_000_000;
    kv.seed(
      METERED_QUOTA_STATE_KEY,
      walletState({
        observed_at_ms: now,
        current_balance_quota: 40_000_000,
        post_refill_baseline_quota: 50_000_000,
        last_known_debits_quota: 10_000_000,
        last_inferred_credit_quota: 5_000_000,
        last_credit_at_ms: now - 1_000,
        confidence: "inferred_adjustment",
      })
    );

    const diagnostics = await getMeteredQuotaDiagnostics({ kv: asKv(kv), now: () => now });

    assert.equal(diagnostics.configured, true);
    assert.equal(diagnostics.available, true);
    assert.equal(diagnostics.cache_state, "fresh");
    assert.equal(diagnostics.confidence, "inferred_adjustment");
    assert.equal(diagnostics.balance_credits, 80);
    assert.equal(diagnostics.baseline_credits, 100);
    assert.equal(diagnostics.remaining_percent, 80);
    assert.equal(diagnostics.used_percent, 20);
    assert.equal(diagnostics.observed_at_ms, now);
    assert.equal(diagnostics.cycle_started_at_ms, 900_000);
    assert.equal(diagnostics.last_known_debits_credits, 20);
    assert.equal(diagnostics.last_inferred_credit_credits, 10);
    assert.equal(diagnostics.last_credit_at_ms, now - 1_000);
    assert.equal(diagnostics.latest_refill_id, "refill-1");
    assert.equal(diagnostics.latest_refill_amount_credits, 100);
    assert.equal(diagnostics.latest_refill_completed_at_ms, 900_000);
    assert.equal(diagnostics.unlimited_quota, false);
    assert.equal(diagnostics.total_available, null);
    assert.equal(diagnostics.total_granted, null);
    assert.equal(diagnostics.total_used, null);
  } finally {
    restore();
  }
});

test("diagnostics describe a refreshed token usage snapshot without wallet fields", async () => {
  const restore = withEnv(METERED_API_KEY_ENV, credentials.apiKey);
  try {
    const kv = new MeteredKv();
    const now = 22_000_000;

    const diagnostics = await getMeteredQuotaDiagnostics({
      kv: asKv(kv),
      now: () => now,
      fetcher: jsonFetcher(tokenUsageEnvelope({ unlimited_quota: true, total_available: 9_000 })),
      createLeaseOwner: () => "diagnostics-owner",
    });

    assert.equal(diagnostics.configured, true);
    assert.equal(diagnostics.available, true);
    assert.equal(diagnostics.cache_state, "refreshed");
    assert.equal(diagnostics.confidence, null);
    assert.equal(diagnostics.balance_credits, null);
    assert.equal(diagnostics.baseline_credits, null);
    assert.equal(diagnostics.remaining_percent, null);
    assert.equal(diagnostics.used_percent, null);
    assert.equal(diagnostics.observed_at_ms, now);
    assert.equal(diagnostics.cycle_started_at_ms, null);
    assert.equal(diagnostics.last_known_debits_credits, null);
    assert.equal(diagnostics.last_inferred_credit_credits, null);
    assert.equal(diagnostics.last_credit_at_ms, null);
    assert.equal(diagnostics.unlimited_quota, true);
    assert.equal(diagnostics.total_available, 9_000);
    assert.equal(diagnostics.total_granted, 10_000);
    assert.equal(diagnostics.total_used, 1_000);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Paid-fallback automatic backfill (src/paid-fallback/ledger-backfill.ts)
// ---------------------------------------------------------------------------

const settledRequestRow = (overrides: Partial<PaidFallbackRequestV3> = {}): PaidFallbackRequestV3 => ({
  v: 3,
  key_id: "coverage-key",
  request_id: "1",
  policy_version: "v3",
  route: "responses",
  path: "/v1/responses",
  model: "gpt-5-codex",
  stream: true,
  reasoning: "high",
  window_reset_at_ms: 60_000,
  reserved_microcredits: 7,
  quota_per_credit: 500_000,
  provider_request_id: "upstream-1",
  provider_quota: 12,
  input_tokens: 100,
  cached_input_tokens: 20,
  output_tokens: 30,
  dispatch_state: "dispatched",
  terminal_state: "completed",
  spend_microcredits: 7,
  billing_state: "settled",
  reconciliation_attempts: 1,
  last_reconciliation_at_ms: 900,
  dispatched_at_ms: 100,
  terminal_at_ms: 200,
  settled_at_ms: 300,
  created_at_ms: 3_600_000,
  updated_at_ms: 300,
  ...overrides,
});

test("the automatic backfill refuses an invalid clock", async () => {
  const kv = new MeteredKv();

  await assert.rejects(() => runPaidFallbackBackfillV3(asKv(kv), { nowMs: -1 }), /Paid fallback automatic backfill clock is invalid/);
  await assert.rejects(() => runPaidFallbackBackfillV3(asKv(kv), { nowMs: Number.NaN }), /Paid fallback automatic backfill clock is invalid/);
  assert.equal(kv.stored.size, 0);
});

test("a completed automatic backfill with no pending work is skipped", async () => {
  const kv = new MeteredKv();
  kv.seed(paidFallbackBackfillStateV3Key(), { v: 1, completed_at_ms: 5 });

  const run = await runPaidFallbackBackfillV3(asKv(kv), { nowMs: 10 });

  assert.deepEqual(run, { kind: "skipped", requests: null, windows: null });
  assert.equal(kv.has(paidFallbackBackfillLeaseV3Key()), false);
  assert.equal(
    [...kv.stored.keys()].some((encoded) => encoded.includes("usage_rollup")),
    false
  );
});

test("a completed automatic backfill runs again when a settled row is unmarked", async () => {
  const kv = new MeteredKv();
  const nowMs = 4_000_000;
  kv.seed(paidFallbackBackfillStateV3Key(), { v: 1, completed_at_ms: 5 });
  const row = settledRequestRow();
  const requestKey = paidFallbackRequestV3Key(row.key_id, row.request_id);
  kv.seed(requestKey, row);

  const run = await runPaidFallbackBackfillV3(asKv(kv), { nowMs });

  assert.equal(run.kind, "completed");
  assert.deepEqual(run.requests, { scanned: 1, processed: 1, rollups_written: 1, failed: 0, truncated: false });
  assert.deepEqual(run.windows, { scanned: 0, rewritten: 0, truncated: false });
  assert.deepEqual(kv.value(paidFallbackBackfillStateV3Key()), { v: 1, completed_at_ms: nowMs });

  const bucketStartAtMs = Math.floor(row.created_at_ms / PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS) * PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS;
  const rollupKey = paidFallbackUsageRollupKey(bucketStartAtMs, row.model, "metered", paidFallbackUsageRollupShard(row.request_id));
  const rollup = kv.value(rollupKey) as Record<string, unknown>;
  assert.equal(rollup.bucket_start_at_ms, bucketStartAtMs);
  assert.equal(rollup.model, row.model);
  assert.equal(rollup.provider, "metered");
  assert.equal(rollup.v, 1);
  assert.equal(rollup.request_count, 1);
  assert.equal(rollup.quota_sum, 12);
  assert.equal(rollup.spend_microcredits, 7);
  assert.equal(rollup.input_tokens, 100);
  assert.equal(rollup.cached_input_tokens, 20);
  assert.equal(rollup.output_tokens, 30);
  assert.equal(rollup.first_request_at_ms, row.created_at_ms);
  assert.equal(rollup.last_request_at_ms, row.created_at_ms);
  assert.equal(rollup.updated_at_ms, nowMs);

  const rewritten = kv.value(requestKey) as PaidFallbackRequestV3;
  assert.equal(rewritten.usage_rollup_at_ms, nowMs);
  assert.equal(rewritten.updated_at_ms, nowMs);
  assert.equal(kv.has(paidFallbackBackfillLeaseV3Key()), false);
});

test("a held automatic backfill lease reports the run as busy", async () => {
  const kv = new MeteredKv();
  const nowMs = 5_000_000;
  const row = settledRequestRow();
  kv.seed(paidFallbackRequestV3Key(row.key_id, row.request_id), row);
  kv.seed(paidFallbackBackfillLeaseV3Key(), { token: "held-by-another-worker", expires_at_ms: nowMs + 60_000 });

  const run = await runPaidFallbackBackfillV3(asKv(kv), { nowMs });

  assert.deepEqual(run, { kind: "busy", requests: null, windows: null });
  assert.equal((kv.value(paidFallbackRequestV3Key(row.key_id, row.request_id)) as PaidFallbackRequestV3).usage_rollup_at_ms, undefined);
});

test("a refused completion marker fails the automatic backfill loudly", async () => {
  const kv = new MeteredKv();
  const nowMs = 6_000_000;
  kv.conflictOnSet(paidFallbackBackfillStateV3Key());

  await assert.rejects(() => runPaidFallbackBackfillV3(asKv(kv), { nowMs, force: true }), /Paid fallback automatic backfill state changed concurrently/);
  assert.equal(kv.has(paidFallbackBackfillLeaseV3Key()), false);
});

test("an automatic backfill with existing rollups and no marked work is skipped", async () => {
  const kv = new MeteredKv();
  kv.seed(paidFallbackBackfillStateV3Key(), { v: 1, completed_at_ms: 5 });
  kv.seed(
    [...PAID_FALLBACK_USAGE_ROLLUP_PREFIX, 0, "gpt-5-codex", "metered", 0],
    mergePaidFallbackUsageRollup(null, {
      bucket_start_at_ms: 0,
      request_id: "1",
      model: "gpt-5-codex",
      provider: "metered",
      quota: 1,
      input_tokens: 1,
      cached_input_tokens: null,
      output_tokens: 1,
      spend_microcredits: 1,
      request_created_at_ms: 0,
      updated_at_ms: 5,
    })
  );

  const run = await runPaidFallbackBackfillV3(asKv(kv), { nowMs: 10 });

  assert.deepEqual(run, { kind: "skipped", requests: null, windows: null });
});

test("a contended automatic backfill lease reports the run as busy", async () => {
  const kv = new MeteredKv();
  kv.conflictOnSet(paidFallbackBackfillLeaseV3Key());

  const run = await runPaidFallbackBackfillV3(asKv(kv), { nowMs: 7_000_000, force: true });

  assert.deepEqual(run, { kind: "busy", requests: null, windows: null });
  assert.equal(kv.has(paidFallbackBackfillLeaseV3Key()), false);
});

test("an unreadable lease during release still reports the completed backfill", async () => {
  const kv = new MeteredKv();
  const nowMs = 8_000_000;
  // Reads: 1 lease acquire probe, 2 release probe.
  kv.planReads(paidFallbackBackfillLeaseV3Key(), ["value", "throw"]);

  const run = await runPaidFallbackBackfillV3(asKv(kv), { nowMs, force: true });

  assert.equal(run.kind, "completed");
  assert.deepEqual(kv.value(paidFallbackBackfillStateV3Key()), { v: 1, completed_at_ms: nowMs });
  assert.equal(kv.has(paidFallbackBackfillLeaseV3Key()), true);
});

test("a malformed reconciliation job message is dropped without touching the ledger", async () => {
  const kv = new MeteredKv();

  assert.equal(await handlePaidFallbackReconciliationJobV3(null, asKv(kv)), 0);
  assert.equal(await handlePaidFallbackReconciliationJobV3("key_id", asKv(kv)), 0);
  assert.equal(await handlePaidFallbackReconciliationJobV3({ key_id: 5 }, asKv(kv)), 0);
  assert.equal(kv.stored.size, 0);
});

test("enqueueing due reconciliation jobs requires an available KV", async () => {
  const kv = new MeteredKv();

  assert.equal(await enqueueDuePaidFallbackReconciliationJobsV3(9_000_000, null), 0);
  assert.equal(await enqueueDuePaidFallbackReconciliationJobsV3(9_000_000, asKv(kv)), 0);
  assert.equal(kv.stored.size, 0);
});
