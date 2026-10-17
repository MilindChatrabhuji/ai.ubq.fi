import { createFetchMock } from "./helpers/fetch-mock.ts";
import type * as KvTypes from "#kv";
import { afterEach, beforeEach, test } from "bun:test";
import { setKvForTest } from "../src/kv.ts";
import assert from "node:assert/strict";
type StoredEntry = {
  key: KvTypes.KvKey;
  value: unknown;
  versionstamp: string;
  expiresAtMs: number | null;
};
const encodeKey = (key: KvTypes.KvKey): string => JSON.stringify(key);
const clone = <T>(value: T): T => structuredClone(value);
const compareKeyPart = (left: KvTypes.KvKeyPart, right: KvTypes.KvKeyPart): number => {
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : 1;
};
const compareKeys = (left: KvTypes.KvKey, right: KvTypes.KvKey): number => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const comparison = compareKeyPart(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
};
const startsWithKey = (key: KvTypes.KvKey, prefix: KvTypes.KvKey): boolean => prefix.every((part, index) => key[index] === part);
class MemoryKv {
  readonly entries = new Map<string, StoredEntry>();
  readonly queueMessages: { message: unknown; options: unknown }[] = [];
  enqueueFailure: Error | null = null;
  beforeAtomicCommit: (() => void) | null = null;
  atomicCommitFailures = 0;
  getCalls = 0;
  listCalls = 0;
  #version = 0;
  clear(): void {
    this.entries.clear();
    this.queueMessages.length = 0;
    this.enqueueFailure = null;
    this.beforeAtomicCommit = null;
    this.atomicCommitFailures = 0;
    this.getCalls = 0;
    this.listCalls = 0;
    this.#version = 0;
  }
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
  #write(key: KvTypes.KvKey, value: unknown, options: { expireIn?: number } | undefined, versionstamp: string): void {
    const expireIn = options?.expireIn;
    const expiresAtMs = typeof expireIn === "number" ? Date.now() + Math.max(0, expireIn) : null;
    this.entries.set(encodeKey(key), {
      key: clone(key),
      value: clone(value),
      versionstamp,
      expiresAtMs,
    });
  }
  versionstamp(key: KvTypes.KvKey): string | null {
    this.#purgeExpired();
    return this.entries.get(encodeKey(key))?.versionstamp ?? null;
  }
  expiration(key: KvTypes.KvKey): number | null {
    this.#purgeExpired();
    return this.entries.get(encodeKey(key))?.expiresAtMs ?? null;
  }

  get<T = unknown>(key: KvTypes.KvKey): Promise<KvTypes.KvEntryMaybe<T>> {
    this.getCalls += 1;
    this.#purgeExpired();
    const entry = this.entries.get(encodeKey(key));
    return Promise.resolve({
      key: clone(key),
      value: entry ? (clone(entry.value) as T) : null,
      versionstamp: entry?.versionstamp ?? null,
    } as KvTypes.KvEntryMaybe<T>);
  }

  set(key: KvTypes.KvKey, value: unknown, options?: { expireIn?: number }): Promise<KvTypes.KvCommitResult> {
    const versionstamp = this.#nextVersionstamp();
    this.#write(key, value, options, versionstamp);
    return Promise.resolve({ ok: true, versionstamp });
  }

  delete(key: KvTypes.KvKey): Promise<void> {
    this.#purgeExpired();
    this.entries.delete(encodeKey(key));
    this.#nextVersionstamp();
    return Promise.resolve();
  }

  enqueue(message: unknown, options?: unknown): Promise<void> {
    if (this.enqueueFailure) return Promise.reject(this.enqueueFailure);
    this.queueMessages.push({ message: clone(message), options: clone(options) });
    return Promise.resolve();
  }

  list<T = unknown>(selector: KvTypes.KvListSelector, options: KvTypes.KvListOptions = {}): KvTypes.KvListIterator<T> {
    this.listCalls += 1;
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

    const iterator = (function* (): Generator<KvTypes.KvEntry<T>> {
      for (const entry of entries) {
        yield {
          key: clone(entry.key),
          value: clone(entry.value) as T,
          versionstamp: entry.versionstamp,
        };
      }
    })() as unknown as KvTypes.KvListIterator<T>;
    Object.defineProperty(iterator, "cursor", { get: () => "" });
    return iterator;
  }

  atomic(): KvTypes.AtomicOperation {
    const checks: { key: KvTypes.KvKey; versionstamp: string | null }[] = [];
    const mutations: ({ type: "set"; key: KvTypes.KvKey; value: unknown; options?: { expireIn?: number } } | { type: "delete"; key: KvTypes.KvKey })[] = [];
    const operation = {
      check: (entry: { key: KvTypes.KvKey; versionstamp: string | null }) => {
        checks.push({ key: clone(entry.key), versionstamp: entry.versionstamp });
        return operation;
      },
      set: (key: KvTypes.KvKey, value: unknown, options?: { expireIn?: number }) => {
        mutations.push({ type: "set", key: clone(key), value: clone(value), options });
        return operation;
      },
      delete: (key: KvTypes.KvKey) => {
        mutations.push({ type: "delete", key: clone(key) });
        return operation;
      },
      commit: (): Promise<KvTypes.KvCommitResult | KvTypes.KvCommitError> => {
        this.beforeAtomicCommit?.();
        this.beforeAtomicCommit = null;
        this.#purgeExpired();
        if (checks.some((check) => this.versionstamp(check.key) !== check.versionstamp)) {
          this.atomicCommitFailures += 1;
          return Promise.resolve({ ok: false });
        }

        const versionstamp = this.#nextVersionstamp();
        for (const mutation of mutations) {
          if (mutation.type === "delete") {
            this.entries.delete(encodeKey(mutation.key));
          } else {
            this.#write(mutation.key, mutation.value, mutation.options, versionstamp);
          }
        }
        return Promise.resolve({ ok: true, versionstamp });
      },
    };
    Object.defineProperty(operation, "then", {
      get() {
        throw new TypeError("'KvTypes.AtomicOperation' is not a promise: did you forget to call 'commit()'");
      },
    });
    return operation as unknown as KvTypes.AtomicOperation;
  }

  close(): void {}
}

const memoryKv = new MemoryKv();
const kv = memoryKv as unknown as KvTypes.Kv;
setKvForTest(kv);
beforeEach(() => {
  setKvForTest(kv);
});
afterEach(() => {
  setKvForTest(null);
});
const { apiKeyHashKey, apiKeyIdKey } = await import("../src/api-keys.ts");
const { apiKeyRequestLogKey, recordApiKeyRequestLog, updateApiKeyRequestLog } = await import("../src/analytics.ts");
const { hasStrictPaidFallbackKeyPolicy, hasStrictPaidFallbackPolicy, reservePaidFallback } = await import("../src/paid-fallback/index.ts");
const {
  admitPaidFallbackV3,
  deletePaidFallbackStateV3,
  releasePaidFallbackBeforeProviderFetchV3,
  releaseUndispatchedPaidFallbackV3,
  updatePaidFallbackRequestV3,
} = await import("../src/paid-fallback/ledger-admission.ts");
const {
  markPaidFallbackTerminalV3,
  reconcileDuePaidFallbacksV3,
  reconcilePaidFallbackV3,
  recordPaidFallbackTerminalV3,
  enqueueDuePaidFallbackReconciliationJobsV3,
  handlePaidFallbackReconciliationJobV3,
} = await import("../src/paid-fallback/ledger-backfill.ts");
const {
  getPaidFallbackOutstandingV3,
  getPaidFallbackWindowProjectionV3,
  listPaidFallbackRequestsV3,
  paidFallbackDeletionGuardV3Key,
  paidFallbackReconciliationGateV3Key,
  paidFallbackRequestV3Key,
  paidFallbackPendingV3Key,
  paidFallbackReconciliationLeaseV3Key,
  paidFallbackWindowV3Key,
} = await import("../src/paid-fallback/ledger-state.ts");
const { getKv } = await import("../src/kv.ts");
await getKv();
const strictKeyRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const now = Date.now();
  return {
    id: "key-paid",
    name: "Paid fallback test",
    prefix: "u_test",
    hash: "hash-paid",
    created_at_ms: now - 60_000,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 100,
    usage_requests: 3,
    usage_reset_at_ms: now + 60 * 60 * 1000,
    window_ms: 7 * 24 * 60 * 60 * 1000,
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: 5_000_000,
    paid_fallback_spent_microcredits: 1_000_000,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
    paid_fallback_model_ids: ["gpt-5-codex"],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_max_exposure_microcredits: { "gpt-5-codex": 250_000 },
    paid_fallback_pricing_checked_at_ms: now - 30_000,
    ...overrides,
  };
};

const strictHashRecord = (record: Record<string, unknown>): Record<string, unknown> => ({
  id: record.id,
  expires_at_ms: record.expires_at_ms,
  revoked_at_ms: record.revoked_at_ms,
  usage_limit_requests: record.usage_limit_requests,
  usage_requests: record.usage_requests,
  usage_reset_at_ms: record.usage_reset_at_ms,
  window_ms: record.window_ms,
  paid_fallback_enabled: record.paid_fallback_enabled,
  paid_fallback_limit_microcredits: record.paid_fallback_limit_microcredits,
  paid_fallback_spent_microcredits: record.paid_fallback_spent_microcredits,
  paid_fallback_reserved_microcredits: record.paid_fallback_reserved_microcredits,
  paid_fallback_reservation_request_id: record.paid_fallback_reservation_request_id,
});

const seedStrictKey = async (overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const record = strictKeyRecord(overrides);
  await memoryKv.set(apiKeyIdKey(String(record.id)), record);
  await memoryKv.set(apiKeyHashKey(String(record.hash)), strictHashRecord(record));
  return record;
};

const withMeteredApiKey = async (fn: () => Promise<void>): Promise<void> => {
  const originalGet = process.env.METERED_API_KEY;
  process.env.METERED_API_KEY = "metered-test-key";
  try {
    await fn();
  } finally {
    if (originalGet === undefined) delete process.env.METERED_API_KEY;
    else process.env.METERED_API_KEY = originalGet;
  }
};

const reservationInput = (keyId: string, requestId: string, createdAtMs = Date.now()) => ({
  keyId,
  requestId,
  createdAtMs,
  model: "gpt-5-codex",
  route: "responses",
  path: "/v1/responses",
  stream: false,
  reasoning: "high",
  reason: "primary_429" as const,
});

const v3AdmissionInput = (
  keyId: string,
  requestId: string,
  overrides: Partial<Parameters<typeof admitPaidFallbackV3>[0]> = {}
): Parameters<typeof admitPaidFallbackV3>[0] => ({
  keyId,
  requestId,
  createdAtMs: Date.now(),
  policyVersion: "policy-v3",
  limitMicrocredits: 1_000_000,
  maximumExposureMicrocredits: 250_000,
  initialSettledMicrocredits: 0,
  quotaPerCredit: 500_000,
  windowResetAtMs: Date.now() + 60_000,
  model: "gpt-5-codex",
  route: "responses",
  path: "/v1/responses",
  stream: true,
  reasoning: "high",
  ...overrides,
});

test("strict paid fallback policy accepts valid disabled history and unlimited reservation state", () => {
  const disabledHistory = strictKeyRecord({
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 5_000_000,
    paid_fallback_spent_microcredits: 1_250_000,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  });
  assert.equal(hasStrictPaidFallbackPolicy(disabledHistory), true);
  assert.equal(hasStrictPaidFallbackKeyPolicy(disabledHistory), true);

  const neverEnabled = strictKeyRecord({
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_pricing_checked_at_ms: null,
  });
  assert.equal(hasStrictPaidFallbackKeyPolicy(neverEnabled), true);

  const unlimitedReservation = strictKeyRecord({
    paid_fallback_limit_microcredits: -1,
    paid_fallback_spent_microcredits: 50_000_000,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: "request-unlimited",
  });
  assert.equal(hasStrictPaidFallbackPolicy(unlimitedReservation), true);
  assert.equal(hasStrictPaidFallbackKeyPolicy(unlimitedReservation), true);
});

test("strict paid fallback policy rejects invalid values but ignores legacy counter relationships", () => {
  const invalidCommonPolicies = [
    { paid_fallback_spent_microcredits: -1 },
    { paid_fallback_spent_microcredits: Number.MAX_SAFE_INTEGER + 1 },
    { paid_fallback_reserved_microcredits: -1 },
    { paid_fallback_reserved_microcredits: Number.MAX_SAFE_INTEGER + 1 },
    { paid_fallback_limit_microcredits: 0 },
    { paid_fallback_limit_microcredits: -2 },
  ];
  for (const overrides of invalidCommonPolicies) {
    assert.equal(hasStrictPaidFallbackPolicy(strictKeyRecord(overrides)), false, JSON.stringify(overrides));
  }

  const ignoredLegacyCounterRelationships = [
    {
      paid_fallback_reserved_microcredits: 1,
      paid_fallback_reservation_request_id: null,
    },
    {
      paid_fallback_limit_microcredits: 1_000_000,
      paid_fallback_spent_microcredits: 900_000,
      paid_fallback_reserved_microcredits: 100_001,
      paid_fallback_reservation_request_id: "request-over-cap",
    },
    {
      paid_fallback_reserved_microcredits: 0,
      paid_fallback_reservation_request_id: "request-empty-bounded-reservation",
    },
    {
      paid_fallback_enabled: false,
      paid_fallback_reserved_microcredits: 0,
      paid_fallback_reservation_request_id: "request-disabled",
    },
    {
      paid_fallback_limit_microcredits: -1,
      paid_fallback_reserved_microcredits: 1,
      paid_fallback_reservation_request_id: "request-unlimited-with-amount",
    },
  ];
  for (const overrides of ignoredLegacyCounterRelationships) {
    assert.equal(hasStrictPaidFallbackPolicy(strictKeyRecord(overrides)), true, JSON.stringify(overrides));
  }

  const invalidEnabledKeyPolicies = [
    { paid_fallback_model_ids: [] },
    { paid_fallback_quota_per_credit: 0 },
    { paid_fallback_quota_per_credit: Number.MAX_SAFE_INTEGER + 1 },
    { paid_fallback_pricing_checked_at_ms: null },
    { paid_fallback_pricing_checked_at_ms: 0 },
    { paid_fallback_pricing_checked_at_ms: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const overrides of invalidEnabledKeyPolicies) {
    assert.equal(hasStrictPaidFallbackKeyPolicy(strictKeyRecord(overrides)), false, JSON.stringify(overrides));
  }
});

test("concurrent paid fallback ledger patches retry without losing either update", async () => {
  memoryKv.clear();
  const keyId = "key-concurrent-ledger";
  const requestId = "request-concurrent-ledger";
  const createdAtMs = Date.now();

  await recordApiKeyRequestLog(
    keyId,
    {
      id: requestId,
      route: "responses",
      path: "/v1/responses",
      method: "POST",
      status_code: 0,
      stream: false,
      created_at_ms: createdAtMs,
      provider: "metered",
      billing_status: "pending",
    },
    kv
  );

  await Promise.all([
    updateApiKeyRequestLog(keyId, createdAtMs, requestId, { provider_request_id: "provider-concurrent" }, kv),
    updateApiKeyRequestLog(keyId, createdAtMs, requestId, { status_code: 200, completed_at_ms: createdAtMs + 50 }, kv),
  ]);

  assert.equal(memoryKv.atomicCommitFailures, 1);
  const stored = await memoryKv.get<Record<string, unknown>>(apiKeyRequestLogKey(keyId, createdAtMs, requestId));
  assert.equal(stored.value?.provider_request_id, "provider-concurrent");
  assert.equal(stored.value.status_code, 200);
  assert.equal(stored.value.completed_at_ms, createdAtMs + 50);
});

test("V3 admits concurrent bounded requests without a single reservation slot", async () => {
  memoryKv.clear();
  const keyId = "v3-concurrent";
  const resetAtMs = Date.now() + 60_000;
  const requests = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      admitPaidFallbackV3({
        keyId,
        requestId: `request-${index}`,
        createdAtMs: Date.now(),
        policyVersion: "policy-v3",
        limitMicrocredits: 1_000_000,
        maximumExposureMicrocredits: 10_000,
        initialSettledMicrocredits: 0,
        quotaPerCredit: 500_000,
        windowResetAtMs: resetAtMs,
        model: "gpt-5-codex",
        route: "responses",
        path: "/v1/responses",
        stream: true,
        reasoning: "high",
      })
    )
  );
  assert.deepEqual(
    requests.map((decision) => decision.kind),
    Array(100).fill("reserved")
  );
  const window = await memoryKv.get<Record<string, unknown>>(paidFallbackWindowV3Key(keyId, resetAtMs));
  assert.equal(window.value?.reserved_microcredits, 1_000_000);
  assert.equal(window.value.pending_count, 100);
  const rows = await Promise.all(Array.from({ length: 100 }, (_, index) => memoryKv.get(paidFallbackRequestV3Key(keyId, `request-${index}`))));
  assert.equal(rows.filter((entry) => entry.value !== null).length, 100);
  const pending = await memoryKv.get<Record<string, unknown>>(paidFallbackPendingV3Key(keyId, "request-0"));
  assert.equal(typeof pending.value?.next_reconciliation_at_ms, "number");
});

test("V3 idle reconciliation gate avoids pending scans and Metered billing reads", async () => {
  memoryKv.clear();
  await memoryKv.set(paidFallbackReconciliationGateV3Key(), { next_due_at_ms: null });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    return Promise.reject(new Error("idle reconciliation must not contact Metered"));
  });
  try {
    assert.equal(await reconcileDuePaidFallbacksV3(Date.now(), kv), 0);
    assert.equal(memoryKv.getCalls, 1);
    assert.equal(memoryKv.listCalls, 0);
    assert.equal(fetchCalls, 0);
    assert.deepEqual((await memoryKv.get<Record<string, unknown>>(paidFallbackReconciliationGateV3Key())).value, { next_due_at_ms: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V3 reconciliation gate arms at dispatch boundaries and clears after settlement", async () => {
  memoryKv.clear();
  const originalFetch = globalThis.fetch;
  const providerRequestId = "provider-gate-dispatch";
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    return Promise.resolve(
      Response.json({
        success: true,
        data: [
          {
            request_id: providerRequestId,
            quota: 10_000,
            prompt_tokens: 1,
            completion_tokens: 2,
            model_name: "gpt-5-codex",
            created_at: Math.trunc(Date.now() / 1_000),
          },
        ],
      })
    );
  });
  try {
    await withMeteredApiKey(async () => {
      const admission = await admitPaidFallbackV3(
        v3AdmissionInput("gate-dispatch", "gate-dispatch-request", {
          dispatchIntent: true,
          limitMicrocredits: -1,
          maximumExposureMicrocredits: null,
        })
      );
      assert.equal(admission.kind, "reserved");

      const armed = await memoryKv.get<Record<string, unknown>>(paidFallbackReconciliationGateV3Key());
      assert.equal(typeof armed.value?.next_due_at_ms, "number");

      await updatePaidFallbackRequestV3(admission.reservation, {
        provider_request_id: providerRequestId,
        dispatch_state: "dispatched",
      });
      assert.equal(await reconcileDuePaidFallbacksV3(Date.now() + 1_000, kv), 1);
      assert.equal(fetchCalls, 1);
      assert.deepEqual((await memoryKv.get<Record<string, unknown>>(paidFallbackReconciliationGateV3Key())).value, { next_due_at_ms: null });

      const transition = await admitPaidFallbackV3(
        v3AdmissionInput("gate-transition", "gate-transition-request", {
          limitMicrocredits: -1,
          maximumExposureMicrocredits: null,
        })
      );
      assert.equal(transition.kind, "reserved");

      assert.deepEqual((await memoryKv.get<Record<string, unknown>>(paidFallbackReconciliationGateV3Key())).value, { next_due_at_ms: null });
      await updatePaidFallbackRequestV3(transition.reservation, {
        provider_request_id: providerRequestId,
        dispatch_state: "dispatched",
      });
      assert.equal(typeof (await memoryKv.get<Record<string, unknown>>(paidFallbackReconciliationGateV3Key())).value?.next_due_at_ms, "number");
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V3 missing reconciliation gate bootstraps the earliest legacy marker", async () => {
  memoryKv.clear();
  const keyId = "gate-legacy";
  const requestId = "gate-legacy-request";
  const admission = await admitPaidFallbackV3(v3AdmissionInput(keyId, requestId));
  assert.equal(admission.kind, "reserved");
  const dueAtMs = Date.now() + 60_000;
  await memoryKv.set(paidFallbackPendingV3Key(keyId, requestId), {
    created_at_ms: Date.now(),
    next_reconciliation_at_ms: dueAtMs,
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    return Promise.reject(new Error("future legacy work must not contact Metered"));
  });
  try {
    assert.equal(await reconcileDuePaidFallbacksV3(Date.now(), kv), 0);
    assert.equal(memoryKv.listCalls, 1);
    assert.equal(fetchCalls, 0);
    assert.deepEqual((await memoryKv.get<Record<string, unknown>>(paidFallbackReconciliationGateV3Key())).value, { next_due_at_ms: dueAtMs });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V3 concurrent dispatch-intent admissions retain every reservation and gate arm", async () => {
  memoryKv.clear();
  const decisions = await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      admitPaidFallbackV3(
        v3AdmissionInput("gate-concurrent", `gate-concurrent-${index}`, {
          limitMicrocredits: -1,
          maximumExposureMicrocredits: null,
          dispatchIntent: true,
        })
      )
    )
  );
  assert.deepEqual(
    decisions.map((decision) => decision.kind),
    Array(32).fill("reserved")
  );
  const requests = await Promise.all(
    Array.from({ length: 32 }, (_, index) => memoryKv.get(paidFallbackRequestV3Key("gate-concurrent", `gate-concurrent-${index}`)))
  );
  assert.equal(requests.filter((entry) => entry.value !== null).length, 32);
  assert.equal(typeof (await memoryKv.get<Record<string, unknown>>(paidFallbackReconciliationGateV3Key())).value?.next_due_at_ms, "number");
});

test("paid fallback admission re-reads policy when a committed disable races its CAS", async () => {
  memoryKv.clear();
  const record = await seedStrictKey({ id: "key-policy-cas-barrier", hash: "hash-policy-cas-barrier" });
  const keyId = String(record.id);
  const requestId = "request-policy-cas-barrier";
  let policyMutationApplied = false;
  memoryKv.beforeAtomicCommit = () => {
    policyMutationApplied = true;
    void memoryKv.set(apiKeyIdKey(keyId), {
      ...record,
      paid_fallback_enabled: false,
      paid_fallback_limit_microcredits: 0,
      paid_fallback_model_ids: [],
      paid_fallback_quota_per_credit: 0,
      paid_fallback_max_exposure_microcredits: {},
      paid_fallback_pricing_checked_at_ms: null,
    });
  };

  await withMeteredApiKey(async () => {
    const decision = await reservePaidFallback(reservationInput(keyId, requestId));
    assert.deepEqual(decision, { kind: "skip", reason: "disabled" });
  });

  assert.equal(policyMutationApplied, true);
  assert.equal((await memoryKv.get(paidFallbackRequestV3Key(keyId, requestId))).value, null);
  const policy = await memoryKv.get<Record<string, unknown>>(apiKeyIdKey(keyId));
  assert.equal(policy.value?.paid_fallback_enabled, false);
});

test("paid fallback admission reconciles a due reservation and fails closed while exposure is unresolved", async () => {
  memoryKv.clear();
  const originalFetch = globalThis.fetch;
  const keyId = "admission-due-reconcile";
  const providerRequestId = "provider-admission-due";
  const providerLogs: Record<string, unknown>[] = [];
  let fetchCalls = 0;
  globalThis.fetch = createFetchMock(() => {
    fetchCalls += 1;
    return Promise.resolve(Response.json({ success: true, data: providerLogs }));
  });
  try {
    await withMeteredApiKey(async () => {
      await seedStrictKey({ id: keyId, paid_fallback_limit_microcredits: 500_000 });
      const first = await reservePaidFallback(reservationInput(keyId, `${keyId}-first`));
      if (first.kind !== "reserved") throw new Error(`expected the first reservation, got ${first.kind}`);
      assert.equal((await reservePaidFallback(reservationInput(keyId, `${keyId}-second`))).kind, "reserved");
      await updatePaidFallbackRequestV3(first.reservation, { provider_request_id: providerRequestId, dispatch_state: "dispatched" });
      const blocked = await reservePaidFallback(reservationInput(keyId, `${keyId}-third`));
      if (blocked.kind !== "blocked") throw new Error(`expected a blocked admission, got ${blocked.kind}`);
      assert.equal(blocked.reason, "limit_exceeded");
      assert.equal(fetchCalls, 1);
      providerLogs.push({
        request_id: providerRequestId,
        quota: 10_000,
        prompt_tokens: 1,
        completion_tokens: 2,
        model_name: "gpt-5-codex",
        created_at: Math.trunc(Date.now() / 1_000),
      });
      await memoryKv.set(paidFallbackPendingV3Key(keyId, first.reservation.request_id), {
        created_at_ms: first.reservation.created_at_ms,
        next_reconciliation_at_ms: Date.now() - 1,
      });
      await memoryKv.set(paidFallbackReconciliationGateV3Key(), { next_due_at_ms: 0 });
      const third = await reservePaidFallback(reservationInput(keyId, `${keyId}-third`));
      if (third.kind !== "reserved") throw new Error(`expected the retried admission to reserve, got ${third.kind}`);
      assert.equal(third.reservation.reserved_microcredits, 230_000);
      const settled = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, first.reservation.request_id));
      assert.equal(settled.value?.spend_microcredits, 20_000);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V3 unlimited admission writes independent rows without a shared window", async () => {
  memoryKv.clear();
  const keyId = "v3-unlimited";
  const resetAtMs = Date.now() + 60_000;
  const decisions = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      admitPaidFallbackV3({
        keyId,
        requestId: `unlimited-${index}`,
        createdAtMs: Date.now(),
        policyVersion: "policy-v3",
        limitMicrocredits: -1,
        maximumExposureMicrocredits: null,
        initialSettledMicrocredits: 0,
        quotaPerCredit: 500_000,
        windowResetAtMs: resetAtMs,
        model: "gpt-5-codex",
        route: "responses",
        path: "/v1/responses",
        stream: true,
        reasoning: "high",
      })
    )
  );
  assert.deepEqual(
    decisions.map((decision) => decision.kind),
    Array(100).fill("reserved")
  );
  assert.equal((await memoryKv.get(paidFallbackWindowV3Key(keyId, resetAtMs))).value, null);
});

test("V3 terminal reconciliation settles a pending request exactly once without KV queues", async () => {
  memoryKv.clear();
  const originalFetch = globalThis.fetch;
  const keyId = "v3-terminal";
  const requestId = "gateway-terminal";
  const providerRequestId = "provider-terminal";
  const resetAtMs = Date.now() + 60_000;
  const createdAtMs = Date.now();
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      Response.json({
        success: true,
        data: [
          {
            request_id: providerRequestId,
            quota: 123_456,
            prompt_tokens: 40,
            completion_tokens: 60,
            model_name: "gpt-5-codex",
            created_at: Math.trunc(Date.now() / 1_000),
          },
        ],
      })
    )
  );
  try {
    await withMeteredApiKey(async () => {
      const decision = await admitPaidFallbackV3({
        keyId,
        requestId,
        createdAtMs,
        policyVersion: "policy-v3",
        limitMicrocredits: 1_000_000,
        maximumExposureMicrocredits: 250_000,
        initialSettledMicrocredits: 0,
        quotaPerCredit: 500_000,
        windowResetAtMs: resetAtMs,
        model: "gpt-5-codex",
        route: "responses",
        path: "/v1/responses",
        stream: true,
        reasoning: "high",
      });
      assert.equal(decision.kind, "reserved");

      await updatePaidFallbackRequestV3(decision.reservation, {
        provider_request_id: providerRequestId,
        dispatch_state: "dispatched",
      });

      assert.equal(await recordPaidFallbackTerminalV3(decision.reservation, "completed"), 1);
      assert.equal(await recordPaidFallbackTerminalV3(decision.reservation, "completed"), 0);

      const request = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, requestId));
      assert.equal(request.value?.billing_state, "settled");
      assert.equal(request.value.terminal_state, "completed");
      assert.equal(request.value.spend_microcredits, 246_912);
      assert.equal(request.value.provider_quota, 123_456);
      assert.equal(request.value.input_tokens, 40);
      assert.equal(request.value.output_tokens, 60);
      assert.equal(typeof request.value.dispatched_at_ms, "number");
      assert.equal(typeof request.value.terminal_at_ms, "number");
      assert.equal(typeof request.value.settled_at_ms, "number");
      const window = await memoryKv.get<Record<string, unknown>>(paidFallbackWindowV3Key(keyId, resetAtMs));
      assert.equal(window.value?.reserved_microcredits, 0);
      assert.equal(window.value.settled_microcredits, 246_912);
      assert.equal(window.value.pending_count, 0);
      assert.equal((await memoryKv.get(paidFallbackPendingV3Key(keyId, requestId))).value, null);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V3 reconciliation records billing facts without manufacturing a terminal event", async () => {
  memoryKv.clear();
  const originalFetch = globalThis.fetch;
  const keyId = "v3-out-of-order";
  const requestId = "gateway-out-of-order";
  const providerRequestId = "provider-out-of-order";
  const requestKey = paidFallbackRequestV3Key(keyId, requestId);
  let injectedContention = false;
  globalThis.fetch = createFetchMock(() => {
    if (!injectedContention) {
      injectedContention = true;
      memoryKv.beforeAtomicCommit = () => {
        const existing = memoryKv.entries.get(encodeKey(requestKey));
        if (!existing) throw new Error("missing request for contention injection");
        void memoryKv.set(requestKey, {
          ...(existing.value as Record<string, unknown>),
          updated_at_ms: Number((existing.value as Record<string, unknown>).updated_at_ms) + 1,
        });
      };
    }
    return Promise.resolve(
      Response.json({
        success: true,
        data: [
          {
            request_id: providerRequestId,
            quota: 50_000,
            prompt_tokens: 12,
            completion_tokens: 34,
            model_name: "gpt-5-codex",
            created_at: Math.trunc(Date.now() / 1_000),
          },
        ],
      })
    );
  });
  try {
    await withMeteredApiKey(async () => {
      const decision = await admitPaidFallbackV3(v3AdmissionInput(keyId, requestId));
      assert.equal(decision.kind, "reserved");

      await updatePaidFallbackRequestV3(decision.reservation, {
        provider_request_id: providerRequestId,
        dispatch_state: "dispatched",
      });

      assert.equal(await reconcilePaidFallbackV3(keyId, Date.now() + 100, kv), 1);
      const settledBeforeTerminal = await memoryKv.get<Record<string, unknown>>(requestKey);
      assert.equal(settledBeforeTerminal.value?.billing_state, "settled");
      assert.equal(settledBeforeTerminal.value.terminal_state, "pending");
      assert.equal(settledBeforeTerminal.value.provider_quota, 50_000);
      assert.equal(settledBeforeTerminal.value.input_tokens, 12);
      assert.equal(settledBeforeTerminal.value.output_tokens, 34);
      assert.equal(settledBeforeTerminal.value.spend_microcredits, 100_000);
      assert.equal(memoryKv.atomicCommitFailures, 1);

      assert.equal(await recordPaidFallbackTerminalV3(decision.reservation, "ambiguous"), 0);
      const afterTerminal = await memoryKv.get<Record<string, unknown>>(requestKey);
      assert.equal(afterTerminal.value?.terminal_state, "ambiguous");
      assert.equal(typeof afterTerminal.value.terminal_at_ms, "number");
      assert.equal(afterTerminal.value.spend_microcredits, 100_000);
      assert.equal(await reconcilePaidFallbackV3(keyId, Date.now() + 200, kv), 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V3 terminal delivery expedites a request deferred before provider billing appeared", async () => {
  memoryKv.clear();
  const originalFetch = globalThis.fetch;
  const keyId = "v3-terminal-expedite";
  const requestId = "gateway-terminal-expedite";
  const providerRequestId = "provider-terminal-expedite";
  let billingVisible = false;
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      Response.json({
        success: true,
        data: billingVisible
          ? [
              {
                request_id: providerRequestId,
                quota: 25_000,
                prompt_tokens: 5,
                completion_tokens: 6,
                model_name: "gpt-5-codex",
                created_at: Math.trunc(Date.now() / 1_000),
              },
            ]
          : [],
      })
    )
  );
  try {
    await withMeteredApiKey(async () => {
      const decision = await admitPaidFallbackV3(v3AdmissionInput(keyId, requestId));
      assert.equal(decision.kind, "reserved");

      await updatePaidFallbackRequestV3(decision.reservation, {
        provider_request_id: providerRequestId,
        dispatch_state: "dispatched",
      });
      const deferredAtMs = Date.now() + 100;
      assert.equal(await reconcilePaidFallbackV3(keyId, deferredAtMs, kv), 0);
      const deferred = await memoryKv.get<Record<string, unknown>>(paidFallbackPendingV3Key(keyId, requestId));
      assert.equal(deferred.value?.next_reconciliation_at_ms, deferredAtMs + 5_000);
      assert.equal(Number((await memoryKv.get<Record<string, unknown>>(paidFallbackReconciliationGateV3Key())).value?.next_due_at_ms) > deferredAtMs, true);

      billingVisible = true;
      await markPaidFallbackTerminalV3(decision.reservation, "completed");
      assert.equal(Number((await memoryKv.get<Record<string, unknown>>(paidFallbackReconciliationGateV3Key())).value?.next_due_at_ms) <= Date.now(), true);
      assert.equal(await reconcilePaidFallbackV3(keyId, Date.now(), kv), 1);
      const settled = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, requestId));
      assert.equal(settled.value?.billing_state, "settled");
      assert.equal(settled.value.terminal_state, "completed");
      assert.equal(settled.value.spend_microcredits, 50_000);
      assert.equal(settled.value.reconciliation_attempts, 2);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V3 expedite versions an already-due gate against stale recomputation", async () => {
  memoryKv.clear();
  const keyId = "v3-expedite-gate-version";
  const requestId = "expedite-gate-version";
  const decision = await admitPaidFallbackV3(v3AdmissionInput(keyId, requestId));
  assert.equal(decision.kind, "reserved");

  const gateKey = paidFallbackReconciliationGateV3Key();
  const pendingKey = paidFallbackPendingV3Key(keyId, requestId);
  const now = Date.now();
  await memoryKv.set(gateKey, { next_due_at_ms: now });
  await memoryKv.set(pendingKey, {
    created_at_ms: now,
    next_reconciliation_at_ms: now + 60_000,
  });
  const before = memoryKv.versionstamp(gateKey);

  await markPaidFallbackTerminalV3(decision.reservation, "completed");

  assert.notEqual(memoryKv.versionstamp(gateKey), before);
  assert.equal(Number((await memoryKv.get<Record<string, unknown>>(gateKey)).value?.next_due_at_ms) <= Date.now(), true);
  assert.equal(Number((await memoryKv.get<Record<string, unknown>>(pendingKey)).value?.next_reconciliation_at_ms) <= Date.now(), true);
});

test("V3 bounded policy edits preserve exposure, admit concurrently, and retain final-call overshoot", async () => {
  memoryKv.clear();
  const originalFetch = globalThis.fetch;
  const keyId = "v3-policy-edit";
  const resetAtMs = Date.now() + 60_000;
  const first = await admitPaidFallbackV3(
    v3AdmissionInput(keyId, "policy-first", {
      policyVersion: "policy-v1",
      windowResetAtMs: resetAtMs,
      maximumExposureMicrocredits: 400_000,
    })
  );
  assert.equal(first.kind, "reserved");

  assert.equal(first.reservation.quota_used_percent, 0);

  const concurrent = await Promise.all(
    ["policy-second", "policy-third"].map((requestId) =>
      admitPaidFallbackV3(
        v3AdmissionInput(keyId, requestId, {
          policyVersion: "policy-v2",
          limitMicrocredits: 600_000,
          windowResetAtMs: resetAtMs,
          maximumExposureMicrocredits: 200_000,
        })
      )
    )
  );
  assert.deepEqual(
    concurrent.map((decision) => decision.kind).sort((a, b) => a.localeCompare(b)),
    ["blocked", "reserved"]
  );
  const second = concurrent.find((decision) => decision.kind === "reserved");
  if (second?.kind !== "reserved") throw new Error("expected concurrent reservation");

  const lowered = await admitPaidFallbackV3(
    v3AdmissionInput(keyId, "policy-lowered", {
      policyVersion: "policy-v3",
      limitMicrocredits: 500_000,
      windowResetAtMs: resetAtMs,
      maximumExposureMicrocredits: 200_000,
    })
  );
  assert.deepEqual(lowered, { kind: "blocked", reason: "limit_exceeded" });
  const transitioned = await memoryKv.get<Record<string, unknown>>(paidFallbackWindowV3Key(keyId, resetAtMs));
  assert.equal(transitioned.value?.policy_version, "policy-v3");
  assert.equal(transitioned.value.limit_microcredits, 500_000);
  assert.equal(transitioned.value.reserved_microcredits, 600_000);

  const providerIds = new Map([
    [first.reservation.request_id, "provider-policy-first"],
    [second.reservation.request_id, "provider-policy-second"],
  ]);
  await Promise.all(
    [first.reservation, second.reservation].map((reservation) => {
      const providerRequestId = providerIds.get(reservation.request_id);
      if (providerRequestId === undefined) throw new Error(`missing provider request id fixture for ${reservation.request_id}`);
      return updatePaidFallbackRequestV3(reservation, {
        provider_request_id: providerRequestId,
        dispatch_state: "dispatched",
        terminal_state: "completed",
      });
    })
  );
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      Response.json({
        success: true,
        data: [
          {
            request_id: "provider-policy-first",
            quota: 200_000,
            prompt_tokens: 10,
            completion_tokens: 20,
            model_name: "gpt-5-codex",
            created_at: Math.trunc(Date.now() / 1_000),
          },
          {
            request_id: "provider-policy-second",
            quota: 150_000,
            prompt_tokens: 20,
            completion_tokens: 30,
            model_name: "gpt-5-codex",
            created_at: Math.trunc(Date.now() / 1_000),
          },
        ],
      })
    )
  );
  try {
    await withMeteredApiKey(async () => {
      assert.equal(await reconcilePaidFallbackV3(keyId, Date.now() + 100, kv), 2);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const overshot = await memoryKv.get<Record<string, unknown>>(paidFallbackWindowV3Key(keyId, resetAtMs));
  assert.equal(overshot.value?.settled_microcredits, 700_000);
  assert.equal(overshot.value.reserved_microcredits, 0);
  assert.equal(overshot.value.pending_count, 0);
  assert.deepEqual(
    await admitPaidFallbackV3(
      v3AdmissionInput(keyId, "policy-after-overshoot", {
        policyVersion: "policy-v3",
        limitMicrocredits: 500_000,
        windowResetAtMs: resetAtMs,
      })
    ),
    { kind: "blocked", reason: "limit_exceeded" }
  );
  assert.deepEqual(await getPaidFallbackWindowProjectionV3(keyId, resetAtMs, 500_000, kv), {
    key_id: keyId,
    policy_version: "policy-v3",
    window_reset_at_ms: resetAtMs,
    limit_microcredits: 500_000,
    settled_microcredits: 700_000,
    reserved_microcredits: 0,
    pending_count: 0,
    updated_at_ms: overshot.value.updated_at_ms,
  });
});

test("V3 due scanning honors leases and backoff while retaining unresolved exposure after 24 hours", async () => {
  memoryKv.clear();
  const keyId = "v3-unresolved";
  const requestId = "missing-provider-id";
  const createdAtMs = Date.now();
  const resetAtMs = createdAtMs + 60_000;
  const decision = await admitPaidFallbackV3(
    v3AdmissionInput(keyId, requestId, {
      createdAtMs,
      windowResetAtMs: resetAtMs,
      maximumExposureMicrocredits: 300_000,
    })
  );
  assert.equal(decision.kind, "reserved");

  const firstAttemptAtMs = Date.now() + 100;
  await memoryKv.set(paidFallbackReconciliationLeaseV3Key(keyId), { token: "held-lease", expires_at_ms: firstAttemptAtMs + 60_000 }, { expireIn: 60_000 });
  assert.equal(await reconcileDuePaidFallbacksV3(firstAttemptAtMs, kv), 0);
  let request = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, requestId));
  assert.equal(request.value?.reconciliation_attempts, 0);

  await memoryKv.delete(paidFallbackReconciliationLeaseV3Key(keyId));
  assert.equal(await reconcileDuePaidFallbacksV3(firstAttemptAtMs, kv), 0);
  request = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, requestId));
  assert.equal(request.value?.reconciliation_attempts, 1);
  let pending = await memoryKv.get<Record<string, unknown>>(paidFallbackPendingV3Key(keyId, requestId));
  assert.equal(pending.value?.next_reconciliation_at_ms, firstAttemptAtMs + 5_000);

  assert.equal(await reconcileDuePaidFallbacksV3(firstAttemptAtMs + 4_999, kv), 0);
  assert.equal((await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, requestId))).value?.reconciliation_attempts, 1);
  assert.equal(await reconcileDuePaidFallbacksV3(firstAttemptAtMs + 5_000, kv), 0);
  pending = await memoryKv.get<Record<string, unknown>>(paidFallbackPendingV3Key(keyId, requestId));
  assert.equal(pending.value?.next_reconciliation_at_ms, firstAttemptAtMs + 35_000);

  const unresolvedAtMs = createdAtMs + 24 * 60 * 60_000 + 1;
  assert.equal(await reconcileDuePaidFallbacksV3(unresolvedAtMs, kv), 0);
  request = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, requestId));
  assert.equal(request.value?.billing_state, "unresolved");
  assert.equal(request.value.terminal_state, "pending");
  assert.equal(request.value.reconciliation_attempts, 3);
  assert.equal((await memoryKv.get<Record<string, unknown>>(paidFallbackPendingV3Key(keyId, requestId))).value !== null, true);
  const window = await memoryKv.get<Record<string, unknown>>(paidFallbackWindowV3Key(keyId, resetAtMs));
  assert.equal(window.value?.reserved_microcredits, 300_000);
  assert.equal(window.value.pending_count, 1);
  assert.deepEqual(await getPaidFallbackOutstandingV3(keyId, kv), {
    pending_requests: 0,
    unresolved_requests: 1,
    pending_markers: 1,
    has_outstanding: true,
  });
  const deletion = await deletePaidFallbackStateV3(keyId, kv);
  assert.equal(deletion.kind, "blocked");
});

test("V3 unlimited projection and newest-first history support safe settled-state deletion", async () => {
  memoryKv.clear();
  const originalFetch = globalThis.fetch;
  const keyId = "v3-unlimited-projection";
  const resetAtMs = Date.now() + 60_000;
  const createdAtMs = Date.now();
  const older = await admitPaidFallbackV3(
    v3AdmissionInput(keyId, "unlimited-older", {
      createdAtMs,
      limitMicrocredits: -1,
      maximumExposureMicrocredits: null,
      windowResetAtMs: resetAtMs,
    })
  );
  const newer = await admitPaidFallbackV3(
    v3AdmissionInput(keyId, "unlimited-newer", {
      createdAtMs: createdAtMs + 10,
      limitMicrocredits: -1,
      maximumExposureMicrocredits: null,
      windowResetAtMs: resetAtMs,
    })
  );
  assert.equal(older.kind, "reserved");
  assert.equal(newer.kind, "reserved");

  await Promise.all([
    updatePaidFallbackRequestV3(older.reservation, {
      provider_request_id: "provider-unlimited-older",
      dispatch_state: "dispatched",
      terminal_state: "completed",
    }),
    updatePaidFallbackRequestV3(newer.reservation, {
      provider_request_id: "provider-unlimited-newer",
      dispatch_state: "dispatched",
      terminal_state: "completed",
    }),
  ]);
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      Response.json({
        success: true,
        data: [
          {
            request_id: "provider-unlimited-older",
            quota: 10_000,
            prompt_tokens: 1,
            completion_tokens: 2,
            model_name: "gpt-5-codex",
            created_at: Math.trunc(Date.now() / 1_000),
          },
          {
            request_id: "provider-unlimited-newer",
            quota: 15_000,
            prompt_tokens: 3,
            completion_tokens: 4,
            model_name: "gpt-5-codex",
            created_at: Math.trunc(Date.now() / 1_000),
          },
        ],
      })
    )
  );
  try {
    await withMeteredApiKey(async () => {
      assert.equal(await reconcilePaidFallbackV3(keyId, Date.now() + 100, kv), 2);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal((await memoryKv.get(paidFallbackWindowV3Key(keyId, resetAtMs))).value, null);
  assert.deepEqual(await getPaidFallbackWindowProjectionV3(keyId, resetAtMs, -1, kv), {
    key_id: keyId,
    policy_version: "policy-v3",
    window_reset_at_ms: resetAtMs,
    limit_microcredits: -1,
    settled_microcredits: 50_000,
    reserved_microcredits: 0,
    pending_count: 0,
    updated_at_ms: (await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, "unlimited-newer"))).value?.updated_at_ms,
  });
  assert.deepEqual(
    (await listPaidFallbackRequestsV3(keyId, 1, kv)).map((request) => request.request_id),
    ["unlimited-newer"]
  );
  assert.deepEqual(await getPaidFallbackOutstandingV3(keyId, kv), {
    pending_requests: 0,
    unresolved_requests: 0,
    pending_markers: 0,
    has_outstanding: false,
  });
  await memoryKv.set(paidFallbackReconciliationLeaseV3Key(keyId), {
    token: "stale-cleanup-lease",
    expires_at_ms: Date.now() - 1,
  });
  assert.deepEqual(await deletePaidFallbackStateV3(keyId, kv), {
    kind: "deleted",
    deleted_requests: 2,
    deleted_windows: 0,
    deleted_pending: 0,
    deleted_leases: 1,
  });
  assert.deepEqual(await listPaidFallbackRequestsV3(keyId, 100, kv), []);
  assert.equal((await memoryKv.get(paidFallbackDeletionGuardV3Key(keyId))).value !== null, true);
  assert.deepEqual(await deletePaidFallbackStateV3(keyId, kv), {
    kind: "deleted",
    deleted_requests: 0,
    deleted_windows: 0,
    deleted_pending: 0,
    deleted_leases: 0,
  });
  assert.deepEqual(
    await admitPaidFallbackV3(
      v3AdmissionInput(keyId, "stale-after-deletion", {
        limitMicrocredits: -1,
        maximumExposureMicrocredits: null,
        windowResetAtMs: resetAtMs,
      })
    ),
    { kind: "blocked", reason: "invalid_policy" }
  );
});

test("V3 window rollover isolates prior exposure from new admissions", async () => {
  memoryKv.clear();
  const keyId = "v3-window-rollover";
  const firstResetAtMs = Date.now() + 60_000;
  const secondResetAtMs = firstResetAtMs + 60_000;
  const first = await admitPaidFallbackV3(
    v3AdmissionInput(keyId, "rollover-first", {
      windowResetAtMs: firstResetAtMs,
      initialSettledMicrocredits: 900_000,
      maximumExposureMicrocredits: 250_000,
    })
  );
  const second = await admitPaidFallbackV3(
    v3AdmissionInput(keyId, "rollover-second", {
      windowResetAtMs: secondResetAtMs,
      initialSettledMicrocredits: 0,
      maximumExposureMicrocredits: 250_000,
    })
  );
  assert.equal(first.kind, "reserved");
  assert.equal(second.kind, "reserved");

  assert.equal(first.reservation.reserved_microcredits, 100_000);
  assert.equal(first.reservation.quota_used_percent, 90);
  assert.equal(second.reservation.reserved_microcredits, 250_000);
  assert.equal(second.reservation.quota_used_percent, 0);
  const firstWindow = await memoryKv.get<Record<string, unknown>>(paidFallbackWindowV3Key(keyId, firstResetAtMs));
  const secondWindow = await memoryKv.get<Record<string, unknown>>(paidFallbackWindowV3Key(keyId, secondResetAtMs));
  assert.equal(firstWindow.value?.settled_microcredits, 900_000);
  assert.equal(firstWindow.value.reserved_microcredits, 100_000);
  assert.equal(secondWindow.value?.settled_microcredits, 0);
  assert.equal(secondWindow.value.reserved_microcredits, 250_000);
});

test("V3 deletion guard linearizes against an in-flight admission", async () => {
  memoryKv.clear();
  const keyId = "v3-deletion-race";
  memoryKv.beforeAtomicCommit = () => {
    void memoryKv.set(paidFallbackDeletionGuardV3Key(keyId), { created_at_ms: Date.now() });
  };
  assert.deepEqual(await admitPaidFallbackV3(v3AdmissionInput(keyId, "stale-in-flight-request")), { kind: "blocked", reason: "invalid_policy" });
  assert.equal(memoryKv.atomicCommitFailures, 1);
  assert.equal((await memoryKv.get(paidFallbackRequestV3Key(keyId, "stale-in-flight-request"))).value, null);
  assert.deepEqual(await getPaidFallbackOutstandingV3(keyId, kv), {
    pending_requests: 0,
    unresolved_requests: 0,
    pending_markers: 0,
    has_outstanding: false,
  });
});

test("V3 undispatched release is idempotent and cannot erase dispatched exposure", async () => {
  memoryKv.clear();
  const keyId = "v3-release";
  const resetAtMs = Date.now() + 60_000;
  await memoryKv.set(paidFallbackReconciliationGateV3Key(), { next_due_at_ms: Date.now() + 60_000 });
  const released = await admitPaidFallbackV3(v3AdmissionInput(keyId, "release-before-dispatch", { windowResetAtMs: resetAtMs }));
  assert.equal(released.kind, "reserved");

  await releaseUndispatchedPaidFallbackV3(released.reservation);
  await releaseUndispatchedPaidFallbackV3(released.reservation);
  const releasedRequest = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, released.reservation.request_id));
  assert.equal(releasedRequest.value?.billing_state, "not_billed");
  assert.equal(releasedRequest.value.dispatch_state, "not_dispatched");
  assert.equal(releasedRequest.value.terminal_state, "cancelled");
  assert.equal(typeof releasedRequest.value.terminal_at_ms, "number");
  assert.equal(Number((await memoryKv.get<Record<string, unknown>>(paidFallbackReconciliationGateV3Key())).value?.next_due_at_ms) <= Date.now(), true);

  const dispatched = await admitPaidFallbackV3(v3AdmissionInput(keyId, "release-after-dispatch", { windowResetAtMs: resetAtMs }));
  assert.equal(dispatched.kind, "reserved");

  await updatePaidFallbackRequestV3(dispatched.reservation, { dispatch_state: "dispatched" });
  await releaseUndispatchedPaidFallbackV3(dispatched.reservation);
  const dispatchedRequest = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, dispatched.reservation.request_id));
  assert.equal(dispatchedRequest.value?.billing_state, "pending");
  assert.equal(dispatchedRequest.value.dispatch_state, "dispatched");
  assert.equal((await memoryKv.get<Record<string, unknown>>(paidFallbackPendingV3Key(keyId, dispatched.reservation.request_id))).value !== null, true);

  const prefetch = await admitPaidFallbackV3(
    v3AdmissionInput(keyId, "release-prefetch-intent", {
      windowResetAtMs: resetAtMs,
      dispatchIntent: true,
    })
  );
  assert.equal(prefetch.kind, "reserved");

  const dispatchIntent = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, prefetch.reservation.request_id));
  assert.equal(dispatchIntent.value?.dispatch_state, "dispatched");
  assert.equal(typeof dispatchIntent.value.dispatched_at_ms, "number");
  await releasePaidFallbackBeforeProviderFetchV3(prefetch.reservation);
  const prefetchRequest = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, prefetch.reservation.request_id));
  assert.equal(prefetchRequest.value?.billing_state, "not_billed");
  assert.equal(prefetchRequest.value.dispatch_state, "not_dispatched");
  assert.equal(prefetchRequest.value.terminal_state, "cancelled");
});

test("V3 queue delivery coalesces due rows by key and duplicate delivery is idempotent", async () => {
  memoryKv.clear();
  const originalFetch = globalThis.fetch;
  const keyId = "v3-queue-coalesced";
  const resetAtMs = Date.now() + 60_000;
  const first = await admitPaidFallbackV3(v3AdmissionInput(keyId, "queue-first", { windowResetAtMs: resetAtMs }));
  const second = await admitPaidFallbackV3(v3AdmissionInput(keyId, "queue-second", { windowResetAtMs: resetAtMs }));
  assert.equal(first.kind, "reserved");
  assert.equal(second.kind, "reserved");

  assert.deepEqual(memoryKv.queueMessages, []);
  await updatePaidFallbackRequestV3(first.reservation, {
    provider_request_id: "provider-queue-first",
    dispatch_state: "dispatched",
  });
  await updatePaidFallbackRequestV3(second.reservation, {
    provider_request_id: "provider-queue-second",
    dispatch_state: "dispatched",
  });
  assert.equal(await enqueueDuePaidFallbackReconciliationJobsV3(Date.now() + 1, kv), 1);
  assert.deepEqual(
    memoryKv.queueMessages.map(({ message }) => message),
    [{ key_id: keyId }]
  );

  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      Response.json({
        success: true,
        data: [
          {
            request_id: "provider-queue-first",
            quota: 10_000,
            prompt_tokens: 1,
            completion_tokens: 2,
            model_name: "gpt-5-codex",
            created_at: Math.trunc(Date.now() / 1_000),
          },
        ],
      })
    )
  );
  try {
    await withMeteredApiKey(async () => {
      assert.equal(await handlePaidFallbackReconciliationJobV3({ key_id: keyId }, kv), 1);
      assert.equal(await handlePaidFallbackReconciliationJobV3({ key_id: keyId }, kv), 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const firstRequest = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, "queue-first"));
  const secondRequest = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, "queue-second"));
  assert.equal(firstRequest.value?.billing_state, "settled");
  assert.equal(secondRequest.value?.billing_state, "pending");
  assert.equal(secondRequest.value.reconciliation_attempts, 1);
});

test("V3 queue enqueue failure does not roll back durable reconciliation backoff", async () => {
  memoryKv.clear();
  const originalFetch = globalThis.fetch;
  const keyId = "v3-queue-failure";
  const requestId = "queue-failure-request";
  const decision = await admitPaidFallbackV3(v3AdmissionInput(keyId, requestId));
  assert.equal(decision.kind, "reserved");

  await updatePaidFallbackRequestV3(decision.reservation, {
    provider_request_id: "provider-queue-failure",
    dispatch_state: "dispatched",
  });
  globalThis.fetch = createFetchMock(() => Promise.resolve(Response.json({ success: true, data: [] })));
  memoryKv.enqueueFailure = new Error("queue unavailable");
  try {
    await withMeteredApiKey(async () => {
      assert.equal(await reconcilePaidFallbackV3(keyId, Date.now() + 100, kv), 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const request = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, requestId));
  const pending = await memoryKv.get<Record<string, unknown>>(paidFallbackPendingV3Key(keyId, requestId));
  assert.equal(request.value?.reconciliation_attempts, 1);
  assert.equal(pending.value?.next_reconciliation_at_ms, Number(request.value.last_reconciliation_at_ms) + 5_000);
});

test("V3 unresolved rows remain queue-reconcilable when late provider billing appears", async () => {
  memoryKv.clear();
  const originalFetch = globalThis.fetch;
  const keyId = "v3-unresolved-late";
  const requestId = "unresolved-late-request";
  const providerRequestId = "provider-unresolved-late";
  const decision = await admitPaidFallbackV3(v3AdmissionInput(keyId, requestId, { createdAtMs: Date.now() - 24 * 60 * 60_000 - 1 }));
  assert.equal(decision.kind, "reserved");

  await updatePaidFallbackRequestV3(decision.reservation, {
    provider_request_id: providerRequestId,
    dispatch_state: "dispatched",
  });
  globalThis.fetch = createFetchMock(() => Promise.resolve(Response.json({ success: true, data: [] })));
  try {
    await withMeteredApiKey(async () => {
      assert.equal(await reconcilePaidFallbackV3(keyId, Date.now() + 100, kv), 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const unresolved = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, requestId));
  assert.equal(unresolved.value?.billing_state, "unresolved");
  const pending = await memoryKv.get<Record<string, unknown>>(paidFallbackPendingV3Key(keyId, requestId));
  if (pending.value === null) throw new Error("expected a pending reconciliation record");
  await memoryKv.set(paidFallbackPendingV3Key(keyId, requestId), {
    ...pending.value,
    next_reconciliation_at_ms: Date.now() - 1,
  });
  globalThis.fetch = createFetchMock(() =>
    Promise.resolve(
      Response.json({
        success: true,
        data: [
          {
            request_id: providerRequestId,
            quota: 20_000,
            prompt_tokens: 1,
            completion_tokens: 2,
            model_name: "gpt-5-codex",
            created_at: Math.trunc(Date.now() / 1_000),
          },
        ],
      })
    )
  );
  try {
    await withMeteredApiKey(async () => {
      assert.equal(await handlePaidFallbackReconciliationJobV3({ key_id: keyId }, kv), 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const settled = await memoryKv.get<Record<string, unknown>>(paidFallbackRequestV3Key(keyId, requestId));
  assert.equal(settled.value?.billing_state, "settled");
  assert.equal((await memoryKv.get(paidFallbackPendingV3Key(keyId, requestId))).value, null);
});

test("disabled paid fallback does not rewrite an expired usage window", async () => {
  memoryKv.clear();
  const expiredResetAtMs = Date.now() - 1;
  const record = await seedStrictKey({
    id: "key-disabled-expired",
    hash: "hash-disabled-expired",
    paid_fallback_enabled: false,
    usage_reset_at_ms: expiredResetAtMs,
  });

  assert.deepEqual(await reservePaidFallback(reservationInput(String(record.id), "request-disabled")), { kind: "skip", reason: "disabled" });
  const stored = await memoryKv.get<Record<string, unknown>>(apiKeyIdKey(String(record.id)));
  assert.equal(stored.value?.usage_reset_at_ms, expiredResetAtMs);
  assert.equal(stored.value.paid_fallback_reservation_request_id, null);
});
