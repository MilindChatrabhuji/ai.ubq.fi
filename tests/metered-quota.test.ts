import { test } from "bun:test";
import type { AtomicOperation, Kv, KvEntryMaybe, KvKey } from "#kv";
import assert from "node:assert/strict";
import { buildCodexQuotaHeaders, METERED_CODEX_LIMIT_NAME } from "../src/codex/quota.ts";
import {
  fetchMeteredQuotaObservation,
  getCachedMeteredQuotaSnapshot,
  getMeteredQuotaSnapshot,
  invalidateMeteredQuotaSnapshot,
  METERED_API_KEY_ENV,
  METERED_QUOTA_FRESH_MS,
  METERED_QUOTA_INVALIDATION_KEY,
  METERED_QUOTA_RETENTION_MS,
  METERED_QUOTA_STATE_KEY,
  type MeteredQuotaObservation,
  type MeteredQuotaSnapshot,
  type MeteredQuotaState,
  readMeteredAccountCredentials,
  updateMeteredQuotaState,
} from "../src/metered-quota.ts";

const keyString = (key: KvKey): string => JSON.stringify(key);

class MemoryKv {
  #values = new Map<string, { value: unknown; version: number }>();
  #nextVersion = 1;

  seed(key: KvKey, value: unknown): void {
    this.#values.set(keyString(key), { value, version: this.#nextVersion++ });
  }

  value(key: KvKey): unknown {
    return this.#values.get(keyString(key))?.value ?? null;
  }

  get<T>(key: KvKey): Promise<KvEntryMaybe<T>> {
    const stored = this.#values.get(keyString(key));
    return Promise.resolve({
      key,
      value: (stored?.value as T | undefined) ?? null,
      versionstamp: stored ? String(stored.version).padStart(20, "0") : null,
    } as KvEntryMaybe<T>);
  }

  atomic(): AtomicOperation {
    const checks: KvEntryMaybe<unknown>[] = [];
    const mutations: { kind: "set" | "delete"; key: KvKey; value?: unknown }[] = [];
    const operation = {
      check: (...entries: KvEntryMaybe<unknown>[]) => {
        checks.push(...entries);
        return operation;
      },
      set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
        mutations.push({ kind: "set", key, value });
        return operation;
      },
      delete: (key: KvKey) => {
        mutations.push({ kind: "delete", key });
        return operation;
      },
      commit: () => {
        for (const check of checks) {
          const stored = this.#values.get(keyString(check.key));
          const versionstamp = stored ? String(stored.version).padStart(20, "0") : null;
          if (versionstamp !== check.versionstamp) return Promise.resolve({ ok: false } as const);
        }
        for (const mutation of mutations) {
          if (mutation.kind === "delete") this.#values.delete(keyString(mutation.key));
          else this.seed(mutation.key, mutation.value);
        }
        return Promise.resolve({ ok: true, versionstamp: String(this.#nextVersion).padStart(20, "0") } as const);
      },
    };
    return operation as unknown as AtomicOperation;
  }
}

const credentials = { apiKey: "metered-api-key" };

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
};

test("Metered account credentials require a non-whitespace API key", () => {
  const originalApiKey = process.env[METERED_API_KEY_ENV];
  try {
    process.env[METERED_API_KEY_ENV] = credentials.apiKey;
    assert.deepEqual(readMeteredAccountCredentials(), credentials);

    process.env[METERED_API_KEY_ENV] = "";
    assert.equal(readMeteredAccountCredentials(), null);

    process.env[METERED_API_KEY_ENV] = "contains whitespace";
    assert.equal(readMeteredAccountCredentials(), null);
  } finally {
    restoreEnv(METERED_API_KEY_ENV, originalApiKey);
  }
});

const observation = (overrides: Partial<MeteredQuotaObservation> = {}): MeteredQuotaObservation => ({
  balance_quota: 50_000_000,
  used_quota: 100_000,
  quota_per_credit: 500_000,
  observed_at_ms: 1_000_000,
  latest_refill: {
    id: "refill-1",
    amount_credits: 100,
    completed_at_ms: 900_000,
  },
  ...overrides,
});

const state = (overrides: Partial<MeteredQuotaState> = {}): MeteredQuotaState => ({
  current_balance_quota: 50_000_000,
  post_refill_baseline_quota: 50_000_000,
  last_observed_used_quota: 100_000,
  quota_per_credit: 500_000,
  observed_at_ms: 1_000_000,
  cycle_started_at_ms: 1_000_000,
  confidence: "provisional",
  last_known_debits_quota: 0,
  last_inferred_credit_quota: 0,
  last_credit_at_ms: null,
  latest_refill_id: "refill-1",
  latest_refill_amount_credits: 100,
  latest_refill_completed_at_ms: 900_000,
  ...overrides,
});

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

/** Request URL as text; `String(input)` would render a `Request` as "[object Object]". */
const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const meteredFetcher =
  (calls: { url: string; headers: Headers }[]) =>
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    if (url === "https://api.openlux.ai/api/usage/token/") {
      return Promise.resolve(
        jsonResponse({
          success: true,
          data: {
            expires_at: 0,
            model_limits: {},
            model_limits_enabled: false,
            name: "business-key",
            object: "token_usage",
            total_available: -53_413,
            total_granted: -545,
            total_used: 52_868,
            unlimited_quota: true,
          },
        })
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

test("Metered account observation reads wallet balance and latest successful top-up", async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const result = await fetchMeteredQuotaObservation(credentials, {
    fetcher: meteredFetcher(calls),
    now: () => 2_000_000,
  });

  assert.deepEqual(result, {
    balance_quota: null,
    used_quota: null,
    quota_per_credit: null,
    observed_at_ms: 2_000_000,
    latest_refill: null,
    unlimited_quota: true,
    total_available: -53_413,
    total_granted: -545,
    total_used: 52_868,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.openlux.ai/api/usage/token/");
  assert.equal(calls[0]?.headers.get("Authorization"), "Bearer metered-api-key");
  assert.equal(calls[0]?.headers.has("New-API-User"), false);
  assert.equal(calls[0]?.headers.has("Cookie"), false);
});

test("Metered token usage preserves provider totals, including negative available values", async () => {
  const result = await fetchMeteredQuotaObservation(credentials, {
    fetcher: meteredFetcher([]),
    now: () => 2_000_000,
  });
  assert.equal(result.unlimited_quota, true);
  assert.equal(result.total_available, -53_413);
  assert.equal(result.total_granted, -545);
  assert.equal(result.total_used, 52_868);
});

test("Metered quota seeds a provisional baseline from the first observation", () => {
  const next = updateMeteredQuotaState(null, observation());
  assert.equal(next.current_balance_quota, 50_000_000);
  assert.equal(next.post_refill_baseline_quota, 50_000_000);
  assert.equal(next.confidence, "provisional");
  assert.equal(next.last_inferred_credit_quota, 0);
});

test("Metered quota seeds a partially spent first cycle from the latest refill amount", () => {
  const next = updateMeteredQuotaState(null, observation({ balance_quota: 40_000_000 }));
  assert.equal(next.current_balance_quota, 40_000_000);
  assert.equal(next.post_refill_baseline_quota, 50_000_000);
  assert.equal(next.confidence, "provisional");
});

test("Metered quota keeps the refill baseline across known and external debits", () => {
  const previous = state();
  const next = updateMeteredQuotaState(
    previous,
    observation({
      balance_quota: 48_500_000,
      used_quota: 1_600_000,
      observed_at_ms: 2_000_000,
    })
  );
  assert.equal(next.post_refill_baseline_quota, 50_000_000);
  assert.equal(next.last_known_debits_quota, 1_500_000);
  assert.equal(next.last_inferred_credit_quota, 0);
  assert.equal(next.confidence, "provisional");
});

test("Metered quota detects a refill despite intervening debits and starts a new baseline", () => {
  const previous = state({
    current_balance_quota: 20_000_000,
    post_refill_baseline_quota: 50_000_000,
    last_observed_used_quota: 30_000_000,
  });
  const next = updateMeteredQuotaState(
    previous,
    observation({
      balance_quota: 44_000_000,
      used_quota: 31_000_000,
      observed_at_ms: 2_000_000,
      latest_refill: {
        id: "refill-2",
        amount_credits: 50,
        completed_at_ms: 1_900_000,
      },
    })
  );
  assert.equal(next.last_known_debits_quota, 1_000_000);
  assert.equal(next.last_inferred_credit_quota, 25_000_000);
  assert.equal(next.post_refill_baseline_quota, 45_000_000);
  assert.equal(next.cycle_started_at_ms, 1_900_000);
  assert.equal(next.confidence, "refill_observed");
  assert.equal(next.latest_refill_amount_credits, 50);
});

test("Metered quota restores post-refill debits when the wallet carries a prior balance", () => {
  const previous = state({
    current_balance_quota: 10_000_000,
    post_refill_baseline_quota: 50_000_000,
    last_observed_used_quota: 30_000_000,
  });
  const next = updateMeteredQuotaState(
    previous,
    observation({
      balance_quota: 30_000_000,
      used_quota: 35_000_000,
      observed_at_ms: 2_000_000,
      latest_refill: {
        id: "refill-2",
        amount_credits: 50,
        completed_at_ms: 1_900_000,
      },
    })
  );
  assert.equal(next.last_known_debits_quota, 5_000_000);
  assert.equal(next.last_inferred_credit_quota, 25_000_000);
  assert.equal(next.current_balance_quota, 30_000_000);
  assert.equal(next.post_refill_baseline_quota, 35_000_000);
});

test("Metered quota keeps reconstructed refill capacity within safe integer bounds", () => {
  const previous = state({
    current_balance_quota: Number.MAX_SAFE_INTEGER,
    last_observed_used_quota: 100_000,
  });
  const next = updateMeteredQuotaState(
    previous,
    observation({
      balance_quota: Number.MAX_SAFE_INTEGER,
      used_quota: 100_001,
      observed_at_ms: 2_000_000,
      latest_refill: {
        id: "refill-2",
        amount_credits: 1,
        completed_at_ms: 1_900_000,
      },
    })
  );
  assert.equal(next.post_refill_baseline_quota, Number.MAX_SAFE_INTEGER);
  assert.equal(Number.isSafeInteger(next.post_refill_baseline_quota), true);
});

test("Metered quota never starts a refill cycle below the observed top-up amount", () => {
  const previous = state({
    current_balance_quota: 20_000_000,
    post_refill_baseline_quota: 50_000_000,
    last_observed_used_quota: 30_000_000,
  });
  const next = updateMeteredQuotaState(
    previous,
    observation({
      balance_quota: 20_000_000,
      used_quota: 30_000_000,
      observed_at_ms: 2_000_000,
      latest_refill: {
        id: "refill-2",
        amount_credits: 50,
        completed_at_ms: 1_900_000,
      },
    })
  );
  assert.equal(next.last_inferred_credit_quota, 0);
  assert.equal(next.post_refill_baseline_quota, 25_000_000);
  assert.equal(next.confidence, "refill_observed");
});

test("Metered quota treats an unlisted positive adjustment as an inferred credit", () => {
  const previous = state({ current_balance_quota: 10_000_000 });
  const next = updateMeteredQuotaState(
    previous,
    observation({
      balance_quota: 11_000_000,
      used_quota: previous.last_observed_used_quota,
      observed_at_ms: 2_000_000,
    })
  );
  assert.equal(next.last_inferred_credit_quota, 1_000_000);
  assert.equal(next.post_refill_baseline_quota, 11_000_000);
  assert.equal(next.confidence, "inferred_adjustment");
});

test("Metered quota ignores a reset used counter unless the wallet itself rises", () => {
  const previous = state({ current_balance_quota: 10_000_000, last_observed_used_quota: 5_000_000 });
  const debit = updateMeteredQuotaState(
    previous,
    observation({
      balance_quota: 9_000_000,
      used_quota: 100,
      observed_at_ms: 2_000_000,
    })
  );
  assert.equal(debit.last_inferred_credit_quota, 0);
  assert.equal(debit.post_refill_baseline_quota, 50_000_000);

  const credit = updateMeteredQuotaState(
    previous,
    observation({
      balance_quota: 12_000_000,
      used_quota: 100,
      observed_at_ms: 2_000_000,
    })
  );
  assert.equal(credit.last_inferred_credit_quota, 2_000_000);
});

test("Metered quota cache serves fresh state without an upstream request", async () => {
  const kv = new MemoryKv();
  const now = 10_000_000;
  kv.seed(METERED_QUOTA_STATE_KEY, state({ observed_at_ms: now - METERED_QUOTA_FRESH_MS + 1 }));
  let fetches = 0;
  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: kv as unknown as Kv,
    now: () => now,
    fetcher: () => {
      fetches += 1;
      throw new Error("should not fetch");
    },
  });
  assert.equal(fetches, 0);
  assert.equal(snapshot?.cache_state, "fresh");
  assert.equal(snapshot.remaining_percent, 100);
});

test("Metered quota forced refresh bypasses a fresh cached state", async () => {
  const kv = new MemoryKv();
  const now = 11_000_000;
  kv.seed(METERED_QUOTA_STATE_KEY, state({ observed_at_ms: now - 1_000 }));
  const calls: { url: string; headers: Headers }[] = [];
  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: kv as unknown as Kv,
    now: () => now,
    fetcher: meteredFetcher(calls),
    forceRefresh: true,
    createLeaseOwner: () => "forced-refresh-owner",
  });
  assert.equal(snapshot?.cache_state, "refreshed");
  assert.equal(calls.length, 1);
});

test("Metered quota cache marks an invalidated observation stale", async () => {
  const kv = new MemoryKv();
  const now = 15_000_000;
  kv.seed(METERED_QUOTA_STATE_KEY, state({ observed_at_ms: now }));
  kv.seed(METERED_QUOTA_INVALIDATION_KEY, { invalidated_at_ms: now });

  const snapshot = await getCachedMeteredQuotaSnapshot({
    kv: kv as unknown as Kv,
    now: () => now,
  });

  assert.equal(snapshot?.cache_state, "stale");
  assert.equal(snapshot.remaining_percent, 100);
});

test("Metered quota invalidation forces a fresh account observation", async () => {
  const kv = new MemoryKv();
  const now = 16_000_000;
  kv.seed(METERED_QUOTA_STATE_KEY, state({ observed_at_ms: now }));
  await invalidateMeteredQuotaSnapshot({
    kv: kv as unknown as Kv,
    now: () => now,
  });
  const calls: { url: string; headers: Headers }[] = [];

  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: kv as unknown as Kv,
    now: () => now,
    fetcher: meteredFetcher(calls),
    createLeaseOwner: () => "invalidation-refresh-owner",
  });

  assert.equal(snapshot?.cache_state, "refreshed");
  assert.equal(calls.length, 1);
  assert.equal(kv.value(METERED_QUOTA_INVALIDATION_KEY), null);
});

test("Metered quota refresh stores a new observation and computes its percentage", async () => {
  const kv = new MemoryKv();
  const now = 20_000_000;
  kv.seed(
    METERED_QUOTA_STATE_KEY,
    state({
      current_balance_quota: 50_000_000,
      post_refill_baseline_quota: 50_000_000,
      last_observed_used_quota: 100_000,
      observed_at_ms: now - METERED_QUOTA_FRESH_MS,
      latest_refill_id: "10",
    })
  );
  const calls: { url: string; headers: Headers }[] = [];
  const snapshot = await getMeteredQuotaSnapshot(credentials, {
    kv: kv as unknown as Kv,
    now: () => now,
    fetcher: meteredFetcher(calls),
    createLeaseOwner: () => "refresh-owner",
  });
  assert.equal(snapshot?.cache_state, "refreshed");
  assert.equal(snapshot.unlimited_quota, true);
  assert.equal(snapshot.state.total_available, -53_413);
  assert.equal(snapshot.total_used, 52_868);
  assert.equal(snapshot.balance_credits, null);
  assert.equal(snapshot.remaining_percent, null);
  assert.equal(calls.length, 1);
});

test("Metered quota serves stale state on refresh failure and drops expired state", async () => {
  const now = 30_000_000;
  const staleKv = new MemoryKv();
  staleKv.seed(METERED_QUOTA_STATE_KEY, state({ observed_at_ms: now - METERED_QUOTA_FRESH_MS }));
  const stale = await getMeteredQuotaSnapshot(credentials, {
    kv: staleKv as unknown as Kv,
    now: () => now,
    fetcher: () => Promise.reject(new Error("temporary outage")),
  });
  assert.equal(stale?.cache_state, "stale");

  const expiredKv = new MemoryKv();
  expiredKv.seed(METERED_QUOTA_STATE_KEY, state({ observed_at_ms: now - METERED_QUOTA_RETENTION_MS }));
  const expired = await getMeteredQuotaSnapshot(credentials, {
    kv: expiredKv as unknown as Kv,
    now: () => now,
    fetcher: () => Promise.reject(new Error("temporary outage")),
  });
  assert.equal(expired, null);
});

test("Metered quota refresh lease permits only one upstream refresh", async () => {
  const kv = new MemoryKv();
  const now = 40_000_000;
  kv.seed(METERED_QUOTA_STATE_KEY, state({ observed_at_ms: now - METERED_QUOTA_FRESH_MS }));
  const calls: { url: string; headers: Headers }[] = [];
  let releaseFetch = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const baseFetcher = meteredFetcher(calls);
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await gate;
    return await baseFetcher(input, init);
  };
  let owner = 0;
  const requests = Array.from({ length: 12 }, () =>
    getMeteredQuotaSnapshot(credentials, {
      kv: kv as unknown as Kv,
      now: () => now,
      fetcher,
      createLeaseOwner: () => `owner-${++owner}`,
    })
  );
  await Promise.resolve();
  await Promise.resolve();
  releaseFetch();
  const snapshots = await Promise.all(requests);
  assert.equal(calls.length, 1);
  assert.equal(snapshots.filter((snapshot) => snapshot?.cache_state === "refreshed").length, 1);
  assert.equal(snapshots.filter((snapshot) => snapshot?.cache_state === "stale").length, 11);
});

test("Metered quota invalidation rejects an in-flight pre-debit refresh", async () => {
  const kv = new MemoryKv();
  const now = 50_000_000;
  const previous = state({ observed_at_ms: now - METERED_QUOTA_FRESH_MS });
  kv.seed(METERED_QUOTA_STATE_KEY, previous);
  let releaseFetch = (): void => {};
  let markFetchStarted = (): void => {};
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const baseFetcher = meteredFetcher([]);
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    markFetchStarted();
    await gate;
    return await baseFetcher(input, init);
  };
  const pending = getMeteredQuotaSnapshot(credentials, {
    kv: kv as unknown as Kv,
    now: () => now,
    fetcher,
    createLeaseOwner: () => "pre-debit-refresh-owner",
  });
  await fetchStarted;
  await invalidateMeteredQuotaSnapshot({
    kv: kv as unknown as Kv,
    now: () => now + 1,
  });
  releaseFetch();

  const snapshot = await pending;
  assert.equal(snapshot?.cache_state, "stale");
  assert.deepEqual(kv.value(METERED_QUOTA_STATE_KEY), previous);
  assert.deepEqual(kv.value(METERED_QUOTA_INVALIDATION_KEY), { invalidated_at_ms: now + 1 });
});

const quotaSnapshot = (usedPercent: number): MeteredQuotaSnapshot => ({
  state: state({
    current_balance_quota: Math.round((100 - usedPercent) * 500_000),
    post_refill_baseline_quota: 50_000_000,
  }),
  cache_state: "fresh",
  balance_credits: 100 - usedPercent,
  baseline_credits: 100,
  last_inferred_credit_credits: 0,
  remaining_percent: 100 - usedPercent,
  used_percent: usedPercent,
  unlimited_quota: false,
  total_available: null,
  total_granted: null,
  total_used: null,
});

test("Codex quota headers replace every parseable upstream family with canonical Metered", () => {
  const headers = buildCodexQuotaHeaders(
    new Headers({
      "x-codex-primary-used-percent": "96.5",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "1785000000",
      "x-codex-primary-reset-after-seconds": "86400",
      "x-codex-secondary-used-percent": "20",
      "x-codex-secondary-window-minutes": "300",
      "x-codex-secondary-reset-after-seconds": "120",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "false",
      "x-codex-credits-balance": "12",
      "x-codex-rate-limit-reached-type": "workspace_owner_usage_limit_reached",
      "x-codex-spark-limit-name": "GPT-5.3-Codex-Spark Weekly limit",
      "x-codex-spark-primary-used-percent": "0",
      "x-codex-spark-primary-window-minutes": "10080",
      "x-codex-spark-primary-reset-at": "1785100000",
      "x-openai-subscription-limit-name": "OpenAI subscription",
      "x-openai-subscription-primary-used-percent": "96.5",
      "x-metered-limit-name": "stale Metered family",
      "x-metered-primary-used-percent": "40",
      "x-codex-model": "gpt-5.6-sol",
      "x-codex-plan-type": "pro",
      "x-codex-safety-identifier": "safety-id",
      "x-uos-router-revision": "routing-revision",
    }),
    quotaSnapshot(95)
  );

  assert.equal(headers.get("x-codex-limit-name"), METERED_CODEX_LIMIT_NAME);
  assert.equal(headers.get("x-codex-primary-used-percent"), "95");
  assert.equal(headers.has("x-codex-primary-window-minutes"), false);
  assert.equal(headers.has("x-codex-primary-reset-at"), false);
  assert.equal(headers.has("x-codex-primary-reset-after-seconds"), false);
  assert.equal(headers.has("x-codex-secondary-used-percent"), false);
  assert.equal(headers.has("x-codex-secondary-reset-after-seconds"), false);
  assert.equal(headers.has("x-codex-spark-limit-name"), false);
  assert.equal(headers.has("x-codex-spark-primary-used-percent"), false);
  assert.equal(headers.has("x-codex-spark-primary-window-minutes"), false);
  assert.equal(headers.has("x-codex-spark-primary-reset-at"), false);
  assert.equal(headers.has("x-openai-subscription-limit-name"), false);
  assert.equal(headers.has("x-openai-subscription-primary-used-percent"), false);
  assert.equal(headers.has("x-metered-limit-name"), false);
  assert.equal(headers.has("x-metered-primary-used-percent"), false);
  assert.equal(headers.has("x-codex-credits-has-credits"), false);
  assert.equal(headers.has("x-codex-rate-limit-reached-type"), false);
  assert.equal(headers.get("x-codex-model"), "gpt-5.6-sol");
  assert.equal(headers.get("x-codex-plan-type"), "pro");
  assert.equal(headers.get("x-codex-safety-identifier"), "safety-id");
  assert.equal(headers.get("x-uos-router-revision"), "routing-revision");
});

test("Codex quota headers publish a healthy Metered balance canonically", () => {
  const headers = buildCodexQuotaHeaders({}, quotaSnapshot(50));
  assert.equal(headers.get("x-codex-limit-name"), METERED_CODEX_LIMIT_NAME);
  assert.equal(headers.get("x-codex-primary-used-percent"), "50");
  assert.equal(headers.has("x-codex-primary-window-minutes"), false);
  assert.equal(headers.has("x-codex-primary-reset-at"), false);
});

test("Codex quota headers emit no percentage and strip every family without Metered state", () => {
  const headers = buildCodexQuotaHeaders(
    {
      "x-codex-primary-used-percent": "42",
      "x-codex-primary-window-minutes": "300",
      "x-codex-spark-primary-used-percent": "25",
      "x-openai-subscription-primary-used-percent": "42",
      "x-metered-primary-used-percent": "50",
      "x-codex-model": "gpt-5.6-sol",
    },
    null
  );
  assert.equal(headers.has("x-codex-primary-used-percent"), false);
  assert.equal(headers.has("x-codex-primary-window-minutes"), false);
  assert.equal(headers.has("x-codex-spark-primary-used-percent"), false);
  assert.equal(headers.has("x-openai-subscription-primary-used-percent"), false);
  assert.equal(headers.has("x-metered-primary-used-percent"), false);
  assert.equal(headers.get("x-codex-model"), "gpt-5.6-sol");
});
