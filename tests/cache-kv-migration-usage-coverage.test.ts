import type { KvU64 } from "#kv";
import type { AtomicOperation, Kv, KvCommitError, KvCommitResult, KvEntry, KvEntryMaybe, KvKey, KvListIterator, KvListOptions, KvListSelector } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  API_KEY_USAGE_V3_REQUEST_PREFIX,
  API_KEY_USAGE_V3_RETENTION_MS,
  API_KEY_USAGE_V3_WINDOW_PREFIX,
  type ApiKeyPolicy,
  apiKeyUsageV2Key,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
} from "../src/api-key-policy.ts";
import { API_KEY_HASH_PREFIX, API_KEY_ID_PREFIX, apiKeyHashKey, apiKeyIdKey } from "../src/api-keys.ts";
import {
  apiKeyUsageV2MigrationBaselineKey,
  type ApiKeyUsageV2MigrationBaseline,
  countReconciledBoundedCounterBaselines,
  currentLegacyUsage,
  inspectApiKeyUsageV3,
  inspectKernelQuotaV2,
  inspectStrictApiKeyPairs,
  migrateBoundedCounterHandoff,
  migrateKernelQuotaV2,
  migrationPolicyNow,
  normalizeApiKeyUsageV2MigrationBaseline,
} from "../src/cache/kv-migration-usage.ts";
import {
  DEFAULT_KERNEL_POLICY_LIMIT_KEY,
  DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS,
  DEFAULT_KERNEL_POLICY_WINDOW_KEY,
  DEFAULT_KERNEL_POLICY_WINDOW_MS,
} from "../src/defaults.ts";
import {
  kernelOrgPolicyKey,
  kernelOrgReservationKey,
  kernelOrgWindowKey,
  kernelRepoPolicyKey,
  kernelRepoReservationKey,
  kernelRepoWindowKey,
} from "../src/kernel/quota-v2.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "../src/types.ts";

/**
 * Coverage for the bounded-counter handoff, the V2 kernel-quota migration, and
 * the read-only inventories in src/cache/kv-migration-usage.ts.
 *
 * Every case drives the real exported functions against a deterministic
 * in-memory KV stand-in and asserts the durable rows (or thrown error) they
 * produce, so the assertions describe observable KV state rather than mere
 * execution. `nowMs` is always an explicit argument, which keeps fixtures
 * independent of the wall clock, and the stand-in records the `expireIn` lease
 * each write asks for so retention is observable too.
 */

const NOW = 1_800_000_000_000;
const WINDOW_MS = 60_000;

type StoredEntry = Readonly<{ value: unknown; versionstamp: string }>;
type SetOptions = Readonly<{ expireIn?: number }>;
type PendingWrite = { type: "set"; key: KvKey; value: unknown; options?: SetOptions } | { type: "delete"; key: KvKey };

const encodeKey = (key: KvKey): string => JSON.stringify(key);
const startsWith = (key: KvKey, prefix: KvKey): boolean => prefix.every((part, index) => Object.is(part, key[index]));

/** A deterministic Kv stand-in with CAS semantics and a commit-failure switch. */
class MapKv {
  readonly store = new Map<string, StoredEntry>();
  readonly expireIn = new Map<string, number>();
  failCommits = false;
  #version = 0;

  seed(key: KvKey, value: unknown): void {
    this.store.set(encodeKey(key), { value, versionstamp: this.#nextVersionstamp() });
  }

  value(key: KvKey): unknown {
    return this.store.get(encodeKey(key))?.value ?? null;
  }

  get<T = unknown>(key: KvKey, _options?: SetOptions): Promise<KvEntryMaybe<T>> {
    const entry = this.store.get(encodeKey(key));
    return Promise.resolve({ key, value: (entry?.value ?? null) as T, versionstamp: entry?.versionstamp ?? null } as KvEntryMaybe<T>);
  }

  set(key: KvKey, value: unknown, options?: SetOptions): Promise<KvCommitResult> {
    const versionstamp = this.#write(key, value);
    if (options?.expireIn !== undefined) this.expireIn.set(encodeKey(key), options.expireIn);
    return Promise.resolve({ ok: true, versionstamp });
  }

  delete(key: KvKey): Promise<void> {
    this.store.delete(encodeKey(key));
    this.expireIn.delete(encodeKey(key));
    return Promise.resolve();
  }

  list<T = unknown>(selector: KvListSelector, options?: KvListOptions): KvListIterator<T> {
    const prefix = "prefix" in selector ? selector.prefix : [];
    const candidates: StoredEntry[] = [];
    const keys: KvKey[] = [];
    for (const [encoded, entry] of this.store) {
      const key = JSON.parse(encoded) as KvKey;
      if (!startsWith(key, prefix)) continue;
      keys.push(key);
      candidates.push(entry);
    }
    const order = keys.map((_, index) => index).sort((left, right) => encodeKey(keys[left]).localeCompare(encodeKey(keys[right])));
    const limit = typeof options?.limit === "number" ? options.limit : Number.POSITIVE_INFINITY;
    const iterator = (function* (): Generator<KvEntry<T>> {
      for (const index of order.slice(0, limit)) yield { key: keys[index], value: candidates[index].value as T, versionstamp: candidates[index].versionstamp };
    })() as unknown as KvListIterator<T>;
    Object.defineProperty(iterator, "cursor", { get: () => "" });
    return iterator;
  }

  atomic(): AtomicOperation {
    const checks: { key: KvKey; versionstamp: string | null }[] = [];
    const writes: PendingWrite[] = [];
    const operation = {
      check: (entry: { key: KvKey; versionstamp?: string | null }) => {
        checks.push({ key: entry.key, versionstamp: entry.versionstamp ?? null });
        return operation;
      },
      set: (key: KvKey, value: unknown, options?: SetOptions) => {
        writes.push({ type: "set", key, value, options });
        return operation;
      },
      delete: (key: KvKey) => {
        writes.push({ type: "delete", key });
        return operation;
      },
      commit: (): Promise<KvCommitResult | KvCommitError> => {
        const stale = checks.some((check) => (this.store.get(encodeKey(check.key))?.versionstamp ?? null) !== check.versionstamp);
        if (this.failCommits || stale) return Promise.resolve({ ok: false } as KvCommitError);
        const versionstamp = this.#nextVersionstamp();
        for (const write of writes) {
          if (write.type === "delete") {
            this.store.delete(encodeKey(write.key));
            this.expireIn.delete(encodeKey(write.key));
            continue;
          }
          this.store.set(encodeKey(write.key), { value: write.value, versionstamp });
          if (write.options?.expireIn !== undefined) this.expireIn.set(encodeKey(write.key), write.options.expireIn);
        }
        return Promise.resolve({ ok: true, versionstamp });
      },
    };
    return operation as unknown as AtomicOperation;
  }

  #nextVersionstamp(): string {
    this.#version += 1;
    return String(this.#version).padStart(20, "0");
  }

  #write(key: KvKey, value: unknown): string {
    const versionstamp = this.#nextVersionstamp();
    this.store.set(encodeKey(key), { value, versionstamp });
    return versionstamp;
  }
}

const kv = (stub: MapKv): Kv => stub as unknown as Kv;

const kvU64 = (value: bigint): KvU64 => ({ value }) as unknown as KvU64;

/** Inventory errors are ordered by the KV listing, so compare them order-insensitively. */
const sorted = (values: readonly string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));

const policyFor = (overrides: Partial<ApiKeyPolicy> = {}): ApiKeyPolicy => ({
  token_hash: "h".repeat(43),
  key_id: "key-alpha",
  expires_at_ms: -1,
  usage_limit_requests: 10,
  window_ms: WINDOW_MS,
  window_start_ms: NOW - WINDOW_MS,
  usage_reset_at_ms: NOW,
  policy_version: `v3:${WINDOW_MS}`,
  paid_fallback_enabled: false,
  paid_fallback_limit_microcredits: 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
  ...overrides,
});

const baselineRecord = (policy: ApiKeyPolicy, overrides: Partial<ApiKeyUsageV2MigrationBaseline> = {}): ApiKeyUsageV2MigrationBaseline => ({
  version: 1,
  key_id: policy.key_id,
  policy_version: policy.policy_version,
  window_start_ms: policy.window_start_ms,
  last_legacy_usage_requests: 0,
  seeded_at_ms: NOW,
  reconciled_at_ms: null,
  reconciliation_runs: 0,
  ...overrides,
});

const windowRecord = (policy: ApiKeyPolicy, overrides: Partial<ApiKeyUsageWindowV3> = {}): ApiKeyUsageWindowV3 => ({
  v: 3,
  key_id: policy.key_id,
  policy_version: policy.policy_version,
  window_start_ms: policy.window_start_ms,
  window_reset_at_ms: policy.usage_reset_at_ms,
  committed_requests: 0,
  reserved_requests: 0,
  updated_at_ms: NOW,
  ...overrides,
});

const requestRecord = (policy: ApiKeyPolicy, requestId: string, overrides: Partial<ApiKeyUsageRequestV3> = {}): ApiKeyUsageRequestV3 => ({
  v: 3,
  key_id: policy.key_id,
  request_id: requestId,
  route: "/v1/responses",
  state: "reserved",
  reserved_at_ms: NOW - 1_000,
  lease_expires_at_ms: NOW + 60_000,
  provider: null,
  dispatched_at_ms: null,
  released_at_ms: null,
  release_reason: null,
  ...overrides,
});

test("bounded counter handoff: seeds the baseline and V3 window from the legacy usage count", async () => {
  const stub = new MapKv();
  const policy = policyFor();

  const handoff = await migrateBoundedCounterHandoff(kv(stub), policy, 4, NOW, false);

  assert.deepEqual(handoff, { baseline_created: true, baseline_reconciled: false, legacy_usage_delta_applied: 4 });
  assert.deepEqual(stub.value(apiKeyUsageV2MigrationBaselineKey(policy)), {
    version: 1,
    key_id: policy.key_id,
    policy_version: policy.policy_version,
    window_start_ms: policy.window_start_ms,
    last_legacy_usage_requests: 4,
    seeded_at_ms: NOW,
    reconciled_at_ms: null,
    reconciliation_runs: 0,
  });
  assert.deepEqual(stub.value(apiKeyUsageV3WindowKey(policy)), windowRecord(policy, { committed_requests: 4 }));
  // The seed keeps the aggregate for the post-migration validation pass.
  assert.equal(stub.expireIn.get(encodeKey(apiKeyUsageV3WindowKey(policy))), API_KEY_USAGE_V3_RETENTION_MS);
});

test("bounded counter handoff: a stored legacy counter outweighs the caller count and never lowers the window", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.seed(apiKeyUsageV2Key(policy), kvU64(9n));
  stub.seed(apiKeyUsageV3WindowKey(policy), windowRecord(policy, { committed_requests: 12 }));

  const handoff = await migrateBoundedCounterHandoff(kv(stub), policy, 4, NOW, false);

  assert.deepEqual(handoff, { baseline_created: true, baseline_reconciled: false, legacy_usage_delta_applied: 9 });
  assert.equal((stub.value(apiKeyUsageV2MigrationBaselineKey(policy)) as ApiKeyUsageV2MigrationBaseline | null)?.last_legacy_usage_requests, 9);
  assert.equal((stub.value(apiKeyUsageV3WindowKey(policy)) as ApiKeyUsageWindowV3 | null)?.committed_requests, 12);
});

test("bounded counter handoff: reconcile updates apply only the legacy delta and count reconciliation runs", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  const seeded = await migrateBoundedCounterHandoff(kv(stub), policy, 4, NOW, true);
  assert.deepEqual(seeded, { baseline_created: true, baseline_reconciled: true, legacy_usage_delta_applied: 4 });
  const seededBaseline = stub.value(apiKeyUsageV2MigrationBaselineKey(policy)) as ApiKeyUsageV2MigrationBaseline | null;
  assert.equal(seededBaseline?.reconciled_at_ms, NOW);
  assert.equal(seededBaseline.reconciliation_runs, 1);

  const raised = await migrateBoundedCounterHandoff(kv(stub), policy, 10, NOW + 1_000, true);
  assert.deepEqual(raised, { baseline_created: false, baseline_reconciled: true, legacy_usage_delta_applied: 6 });
  const raisedBaseline = stub.value(apiKeyUsageV2MigrationBaselineKey(policy)) as ApiKeyUsageV2MigrationBaseline | null;
  assert.equal(raisedBaseline?.last_legacy_usage_requests, 10);
  assert.equal(raisedBaseline.reconciled_at_ms, NOW + 1_000);
  assert.equal(raisedBaseline.reconciliation_runs, 2);
  assert.deepEqual(stub.value(apiKeyUsageV3WindowKey(policy)), windowRecord(policy, { committed_requests: 10, updated_at_ms: NOW + 1_000 }));

  // A legacy count below the stored high-water mark contributes no delta.
  const lowered = await migrateBoundedCounterHandoff(kv(stub), policy, 3, NOW + 2_000, true);
  assert.deepEqual(lowered, { baseline_created: false, baseline_reconciled: true, legacy_usage_delta_applied: 0 });
  assert.equal((stub.value(apiKeyUsageV3WindowKey(policy)) as ApiKeyUsageWindowV3 | null)?.committed_requests, 10);
});

test("bounded counter handoff: an unreconciled update clears the reconciliation state", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  await migrateBoundedCounterHandoff(kv(stub), policy, 4, NOW, true);

  const handoff = await migrateBoundedCounterHandoff(kv(stub), policy, 6, NOW + 5_000, false);

  assert.deepEqual(handoff, { baseline_created: false, baseline_reconciled: false, legacy_usage_delta_applied: 2 });
  const baseline = stub.value(apiKeyUsageV2MigrationBaselineKey(policy)) as ApiKeyUsageV2MigrationBaseline | null;
  assert.equal(baseline?.reconciled_at_ms, null);
  assert.equal(baseline.reconciliation_runs, 0);
});

test("bounded counter handoff: rejects an out-of-range legacy V2 counter", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.seed(apiKeyUsageV2Key(policy), kvU64(BigInt(Number.MAX_SAFE_INTEGER) + 1n));

  await assert.rejects(() => migrateBoundedCounterHandoff(kv(stub), policy, 5, NOW, false), /Legacy V2 API-key counter is out of range: key-alpha/);
  assert.equal(stub.value(apiKeyUsageV3WindowKey(policy)), null);
});

test("bounded counter handoff: rejects a legacy V2 counter that is not a U64", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.seed(apiKeyUsageV2Key(policy), { value: "not-a-counter" });

  await assert.rejects(() => migrateBoundedCounterHandoff(kv(stub), policy, 5, NOW, false), /Legacy V2 API-key counter is invalid: key-alpha/);
});

test("bounded counter handoff: rejects a V3 window whose identity does not match the policy", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.seed(apiKeyUsageV3WindowKey(policy), windowRecord(policy, { policy_version: "v3:3600000" }));

  await assert.rejects(() => migrateBoundedCounterHandoff(kv(stub), policy, 5, NOW, false), /V3 API-key window identity is invalid: key-alpha/);
  assert.equal(stub.value(apiKeyUsageV2MigrationBaselineKey(policy)), null);
});

test("bounded counter handoff: rejects an unusable stored baseline", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.seed(apiKeyUsageV2MigrationBaselineKey(policy), { version: 1, key_id: policy.key_id });
  stub.seed(apiKeyUsageV3WindowKey(policy), windowRecord(policy));

  await assert.rejects(() => migrateBoundedCounterHandoff(kv(stub), policy, 5, NOW, false), /Bounded counter handoff baseline is invalid: key-alpha/);
});

test("bounded counter handoff: rejects an existing baseline whose V3 window is missing", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.seed(apiKeyUsageV2MigrationBaselineKey(policy), baselineRecord(policy, { last_legacy_usage_requests: 2 }));

  await assert.rejects(() => migrateBoundedCounterHandoff(kv(stub), policy, 5, NOW, false), /V3 API-key window is missing: key-alpha/);
});

test("bounded counter handoff: five lost commits fail closed instead of writing a partial seed", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.failCommits = true;

  await assert.rejects(() => migrateBoundedCounterHandoff(kv(stub), policy, 5, NOW, false), /Bounded counter handoff changed concurrently: key-alpha/);
  assert.equal(stub.value(apiKeyUsageV3WindowKey(policy)), null);
});

test("bounded counter handoff: a conflicting update commit fails closed as well", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.seed(apiKeyUsageV2MigrationBaselineKey(policy), baselineRecord(policy, { last_legacy_usage_requests: 2 }));
  stub.seed(apiKeyUsageV3WindowKey(policy), windowRecord(policy, { committed_requests: 2 }));
  stub.failCommits = true;

  await assert.rejects(() => migrateBoundedCounterHandoff(kv(stub), policy, 7, NOW, false), /Bounded counter handoff changed concurrently: key-alpha/);
  assert.equal((stub.value(apiKeyUsageV2MigrationBaselineKey(policy)) as ApiKeyUsageV2MigrationBaseline | null)?.last_legacy_usage_requests, 2);
});

test("bounded counter handoff: a lost CAS retries and keeps the competing writer's higher count", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  let raced = false;
  const racing = {
    get: (key: KvKey, options?: SetOptions) => stub.get(key, options),
    set: (key: KvKey, value: unknown, options?: SetOptions) => stub.set(key, value, options),
    delete: (key: KvKey) => stub.delete(key),
    list: (selector: KvListSelector, options?: KvListOptions) => stub.list(selector, options),
    atomic: () => {
      if (!raced) {
        raced = true;
        // A competing writer lands between this attempt's read and its commit.
        stub.seed(apiKeyUsageV3WindowKey(policy), windowRecord(policy, { committed_requests: 99 }));
      }
      return stub.atomic();
    },
  } as unknown as Kv;

  const handoff = await migrateBoundedCounterHandoff(racing, policy, 5, NOW, false);

  assert.deepEqual(handoff, { baseline_created: true, baseline_reconciled: false, legacy_usage_delta_applied: 5 });
  assert.equal((stub.value(apiKeyUsageV3WindowKey(policy)) as ApiKeyUsageWindowV3 | null)?.committed_requests, 99);
  assert.equal((stub.value(apiKeyUsageV2MigrationBaselineKey(policy)) as ApiKeyUsageV2MigrationBaseline | null)?.last_legacy_usage_requests, 5);
});

test("baseline validation: accepts both reconciliation states and rejects every malformed field", () => {
  const policy = policyFor();
  const valid = baselineRecord(policy);
  assert.deepEqual(normalizeApiKeyUsageV2MigrationBaseline(valid), valid);
  const reconciled = baselineRecord(policy, { reconciled_at_ms: NOW + 1, reconciliation_runs: 3 });
  assert.deepEqual(normalizeApiKeyUsageV2MigrationBaseline(reconciled), reconciled);

  const rejects: readonly unknown[] = [
    null,
    "baseline",
    [],
    { ...valid, version: 2 },
    { ...valid, key_id: "" },
    { ...valid, policy_version: "" },
    { ...valid, policy_version: 7 },
    { ...valid, window_start_ms: -1 },
    { ...valid, last_legacy_usage_requests: -1 },
    { ...valid, seeded_at_ms: 0 },
    { ...valid, reconciled_at_ms: 0 },
    { ...valid, reconciled_at_ms: "now" },
    { ...valid, reconciliation_runs: -1 },
  ];
  for (const value of rejects) {
    assert.equal(normalizeApiKeyUsageV2MigrationBaseline(value), null, `expected rejection of ${JSON.stringify(value)}`);
  }
});

test("legacy usage helpers: only an unexpired, unrevoked record keeps its counter", () => {
  const active = { usage_requests: 7, usage_reset_at_ms: NOW + 1, revoked_at_ms: null } as ApiKeyRecord;
  assert.equal(currentLegacyUsage(active, NOW), 7);
  assert.equal(migrationPolicyNow(active, NOW), NOW);
  // An expired window reads as zero legacy usage.
  assert.equal(currentLegacyUsage({ ...active, usage_reset_at_ms: NOW } as ApiKeyRecord, NOW), 0);
  // A revoked key stays pinned to the last stored window instead of rolling forward.
  const revoked = { ...active, revoked_at_ms: NOW - 5_000 } as ApiKeyRecord;
  assert.equal(migrationPolicyNow(revoked, NOW), NOW);
  assert.equal(migrationPolicyNow({ ...revoked, usage_reset_at_ms: NOW - 5_000 } as ApiKeyRecord, NOW), NOW - 5_001);
  assert.equal(migrationPolicyNow({ ...revoked, usage_reset_at_ms: 0 } as ApiKeyRecord, NOW), 0);
});

test("countReconciledBoundedCounterBaselines: counts only reconciled, well-formed baselines", async () => {
  const stub = new MapKv();
  const reconciled = policyFor({ key_id: "key-reconciled" });
  const pending = policyFor({ key_id: "key-pending" });
  const malformed = policyFor({ key_id: "key-malformed" });
  stub.seed(apiKeyUsageV2MigrationBaselineKey(reconciled), baselineRecord(reconciled, { reconciled_at_ms: NOW }));
  stub.seed(apiKeyUsageV2MigrationBaselineKey(pending), baselineRecord(pending));
  stub.seed(apiKeyUsageV2MigrationBaselineKey(malformed), { version: 1, key_id: malformed.key_id });

  assert.equal(await countReconciledBoundedCounterBaselines(kv(stub)), 1);
});
type KernelPolicyRow = Readonly<{
  v: 2;
  scope: "repo" | "org";
  owner: string;
  repo?: string;
  usage_limit_requests: number;
  window_ms: number;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}>;

type KernelWindowRow = Readonly<{
  v: 2;
  scope: "repo" | "org";
  owner: string;
  repo?: string;
  usage_requests: number;
  reserved_requests: number;
  usage_reset_at_ms: number;
  applied_window_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}>;

type KernelReservationRow = Readonly<{
  v: 2;
  scope: "repo" | "org";
  owner: string;
  repo?: string;
  request_id: string;
  route: string;
  window_created_at_ms: number;
  window_reset_at_ms: number;
  state: "reserved" | "committed" | "released";
  terminal_intent: "committed" | "released" | null;
  reserved_at_ms: number;
  lease_expires_at_ms: number;
  committed_at_ms: number | null;
  released_at_ms: number | null;
  release_reason: string | null;
}>;

const kernelPolicyRow = (scope: "repo" | "org", owner: string, repo: string | undefined, overrides: Partial<KernelPolicyRow> = {}): KernelPolicyRow => ({
  v: 2,
  scope,
  owner,
  ...(scope === "repo" ? { repo } : {}),
  usage_limit_requests: 50,
  window_ms: WINDOW_MS,
  expires_at_ms: -1,
  created_at_ms: NOW - 10_000,
  updated_at_ms: NOW - 10_000,
  ...overrides,
});

const kernelWindowRow = (scope: "repo" | "org", owner: string, repo: string | undefined, overrides: Partial<KernelWindowRow> = {}): KernelWindowRow => ({
  v: 2,
  scope,
  owner,
  ...(scope === "repo" ? { repo } : {}),
  usage_requests: 0,
  reserved_requests: 0,
  usage_reset_at_ms: NOW + WINDOW_MS,
  applied_window_ms: WINDOW_MS,
  created_at_ms: NOW - 10_000,
  updated_at_ms: NOW - 10_000,
  ...overrides,
});

const kernelReservationRow = (
  scope: "repo" | "org",
  owner: string,
  repo: string | undefined,
  requestId: string,
  windowCreatedAtMs: number,
  overrides: Partial<KernelReservationRow> = {}
): KernelReservationRow => ({
  v: 2,
  scope,
  owner,
  ...(scope === "repo" ? { repo } : {}),
  request_id: requestId,
  route: "/v1/chat/completions",
  window_created_at_ms: windowCreatedAtMs,
  window_reset_at_ms: NOW + WINDOW_MS,
  state: "reserved",
  terminal_intent: null,
  reserved_at_ms: NOW - 1_000,
  lease_expires_at_ms: NOW + 60_000,
  committed_at_ms: null,
  released_at_ms: null,
  release_reason: null,
  ...overrides,
});

const legacyRepoLimitKey = (owner: string, repo: string): KvKey => ["ubq_ai", "kernel_auth", "limits", owner, repo];
const legacyOrgLimitKey = (owner: string): KvKey => ["ubq_ai", "kernel_auth", "org_limits", owner];

const legacyLimitRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  usage_limit_requests: 25,
  usage_requests: 3,
  usage_reset_at_ms: NOW + WINDOW_MS,
  window_ms: WINDOW_MS,
  expires_at_ms: -1,
  created_at_ms: NOW - 30_000,
  updated_at_ms: NOW - 20_000,
  ...overrides,
});

test("kernel quota migration: an empty store reports zero migrated scopes", async () => {
  const stub = new MapKv();

  assert.deepEqual(await migrateKernelQuotaV2(kv(stub), NOW), { repo: 0, org: 0 });
});

test("kernel quota migration: legacy repo and org limits become V2 policy and window rows", async () => {
  const stub = new MapKv();
  stub.seed(legacyRepoLimitKey("ubq", "repo-a"), legacyLimitRecord());
  stub.seed(legacyOrgLimitKey("ubq"), legacyLimitRecord({ usage_limit_requests: -1, usage_requests: 8 }));

  assert.deepEqual(await migrateKernelQuotaV2(kv(stub), NOW), { repo: 1, org: 1 });

  // The legacy rows are deleted and their V2 replacements carry the same policy.
  assert.equal(stub.value(legacyRepoLimitKey("ubq", "repo-a")), null);
  assert.equal(stub.value(legacyOrgLimitKey("ubq")), null);
  // The migrated policy carries the legacy limit, window and creation time.
  assert.deepEqual(stub.value(kernelRepoPolicyKey("ubq", "repo-a")), {
    v: 2,
    scope: "repo",
    owner: "ubq",
    repo: "repo-a",
    usage_limit_requests: 25,
    window_ms: WINDOW_MS,
    expires_at_ms: -1,
    created_at_ms: NOW - 30_000,
    updated_at_ms: NOW,
  });
  assert.deepEqual(stub.value(kernelRepoWindowKey("ubq", "repo-a")), {
    v: 2,
    scope: "repo",
    owner: "ubq",
    repo: "repo-a",
    usage_requests: 3,
    reserved_requests: 0,
    usage_reset_at_ms: NOW + WINDOW_MS,
    applied_window_ms: WINDOW_MS,
    created_at_ms: NOW - 30_000,
    updated_at_ms: NOW,
  });
  assert.deepEqual(stub.value(kernelOrgPolicyKey("ubq")), {
    v: 2,
    scope: "org",
    owner: "ubq",
    usage_limit_requests: -1,
    window_ms: WINDOW_MS,
    expires_at_ms: -1,
    created_at_ms: NOW - 30_000,
    updated_at_ms: NOW,
  });
  assert.equal((stub.value(kernelOrgWindowKey("ubq")) as KernelWindowRow | null)?.usage_requests, 8);
});

test("kernel quota migration: an expired legacy window rolls forward with zero usage", async () => {
  const stub = new MapKv();
  stub.seed(legacyRepoLimitKey("ubq", "repo-b"), legacyLimitRecord({ usage_reset_at_ms: NOW - 1_000, usage_requests: 5 }));

  assert.deepEqual(await migrateKernelQuotaV2(kv(stub), NOW), { repo: 1, org: 0 });

  const window = stub.value(kernelRepoWindowKey("ubq", "repo-b")) as KernelWindowRow | null;
  assert.equal(window?.usage_requests, 0);
  assert.equal(window.usage_reset_at_ms, NOW + WINDOW_MS);
  assert.equal(window.applied_window_ms, WINDOW_MS);
});

test("kernel quota migration: a default-backed legacy row drops the redundant policy and uses the stored default window", async () => {
  const stub = new MapKv();
  stub.seed(DEFAULT_KERNEL_POLICY_LIMIT_KEY, -1);
  stub.seed(DEFAULT_KERNEL_POLICY_WINDOW_KEY, 30_000);
  stub.seed(
    legacyRepoLimitKey("ubq", "repo-c"),
    legacyLimitRecord({ usage_limit_requests: -1, window_ms: 30_000, expires_at_ms: -1, usage_reset_at_ms: NOW - 1 })
  );

  assert.deepEqual(await migrateKernelQuotaV2(kv(stub), NOW), { repo: 1, org: 0 });

  assert.equal(stub.value(kernelRepoPolicyKey("ubq", "repo-c")), null);
  const window = stub.value(kernelRepoWindowKey("ubq", "repo-c")) as KernelWindowRow | null;
  assert.equal(window?.applied_window_ms, 30_000);
  assert.equal(window.usage_reset_at_ms, NOW + 30_000);
  assert.equal(stub.value(legacyRepoLimitKey("ubq", "repo-c")), null);
});

test("kernel quota migration: an unusable stored default falls back to the built-in limit and window", async () => {
  const stub = new MapKv();
  stub.seed(DEFAULT_KERNEL_POLICY_LIMIT_KEY, -5);
  stub.seed(DEFAULT_KERNEL_POLICY_WINDOW_KEY, 0);
  stub.seed(
    legacyRepoLimitKey("ubq", "repo-defaults"),
    legacyLimitRecord({
      usage_limit_requests: DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS,
      window_ms: DEFAULT_KERNEL_POLICY_WINDOW_MS,
      expires_at_ms: -1,
      usage_reset_at_ms: NOW - 1,
    })
  );

  assert.deepEqual(await migrateKernelQuotaV2(kv(stub), NOW), { repo: 1, org: 0 });

  // The built-in default resolved through the fallback, and the row is then
  // recognised as default-backed, so no policy row is written.
  const window = stub.value(kernelRepoWindowKey("ubq", "repo-defaults")) as KernelWindowRow | null;
  assert.equal(window?.applied_window_ms, DEFAULT_KERNEL_POLICY_WINDOW_MS);
  assert.equal(stub.value(kernelRepoPolicyKey("ubq", "repo-defaults")), null);
});

test("kernel quota migration: an existing V2 policy row only triggers deletion of the legacy row", async () => {
  const stub = new MapKv();
  stub.seed(kernelRepoPolicyKey("ubq", "repo-d"), kernelPolicyRow("repo", "ubq", "repo-d"));
  stub.seed(kernelRepoWindowKey("ubq", "repo-d"), kernelWindowRow("repo", "ubq", "repo-d", { usage_requests: 11 }));
  stub.seed(legacyRepoLimitKey("ubq", "repo-d"), legacyLimitRecord({ usage_requests: 99 }));

  assert.deepEqual(await migrateKernelQuotaV2(kv(stub), NOW), { repo: 1, org: 0 });

  assert.equal(stub.value(legacyRepoLimitKey("ubq", "repo-d")), null);
  assert.deepEqual(stub.value(kernelRepoPolicyKey("ubq", "repo-d")), kernelPolicyRow("repo", "ubq", "repo-d"));
  // The pre-existing window is untouched: only the legacy row was removed.
  assert.equal((stub.value(kernelRepoWindowKey("ubq", "repo-d")) as KernelWindowRow | null)?.usage_requests, 11);
  assert.equal((stub.value(kernelRepoWindowKey("ubq", "repo-d")) as KernelWindowRow | null)?.updated_at_ms, NOW - 10_000);
});

test("kernel quota migration: a matching V2 window only raises its usage to the legacy high-water mark", async () => {
  const stub = new MapKv();
  stub.seed(kernelRepoWindowKey("ubq", "repo-e"), kernelWindowRow("repo", "ubq", "repo-e", { usage_requests: 4, created_at_ms: NOW - 500_000 }));
  stub.seed(legacyRepoLimitKey("ubq", "repo-e"), legacyLimitRecord({ usage_requests: 9 }));

  assert.deepEqual(await migrateKernelQuotaV2(kv(stub), NOW), { repo: 1, org: 0 });

  const window = stub.value(kernelRepoWindowKey("ubq", "repo-e")) as KernelWindowRow | null;
  assert.equal(window?.usage_requests, 9);
  assert.equal(window.created_at_ms, NOW - 500_000);
  assert.equal(window.updated_at_ms, NOW);
  // The written policy is the legacy row's policy, not the pre-existing V2 window's.
  assert.deepEqual(stub.value(kernelRepoPolicyKey("ubq", "repo-e")), {
    v: 2,
    scope: "repo",
    owner: "ubq",
    repo: "repo-e",
    usage_limit_requests: 25,
    window_ms: WINDOW_MS,
    expires_at_ms: -1,
    created_at_ms: NOW - 30_000,
    updated_at_ms: NOW,
  });
});

test("kernel quota migration: string and unusable legacy numbers are coerced or defaulted", async () => {
  const stub = new MapKv();
  stub.seed(
    legacyRepoLimitKey("ubq", "repo-f"),
    legacyLimitRecord({
      usage_limit_requests: "40",
      usage_requests: "6",
      window_ms: "not-a-number",
      usage_reset_at_ms: Number.POSITIVE_INFINITY,
      created_at_ms: "abc",
    })
  );

  assert.deepEqual(await migrateKernelQuotaV2(kv(stub), NOW), { repo: 1, org: 0 });

  const policy = stub.value(kernelRepoPolicyKey("ubq", "repo-f")) as KernelPolicyRow | null;
  assert.equal(policy?.usage_limit_requests, 40);
  assert.equal(policy.window_ms, DEFAULT_KERNEL_POLICY_WINDOW_MS);
  assert.equal(policy.created_at_ms, NOW);
  const window = stub.value(kernelRepoWindowKey("ubq", "repo-f")) as KernelWindowRow | null;
  assert.equal(window?.usage_requests, 6);
  assert.equal(window.created_at_ms, NOW);
});

test("kernel quota migration: a malformed legacy value fails loudly and writes nothing", async () => {
  const stub = new MapKv();
  stub.seed(legacyRepoLimitKey("ubq", "repo-g"), { usage_limit_requests: 5, window_ms: 0 });

  await assert.rejects(() => migrateKernelQuotaV2(kv(stub), NOW), /legacy kernel quota value is malformed/);
  assert.equal(stub.value(kernelRepoWindowKey("ubq", "repo-g")), null);
  assert.notEqual(stub.value(legacyRepoLimitKey("ubq", "repo-g")), null);
});

test("kernel quota migration: a malformed legacy key fails loudly", async () => {
  const stub = new MapKv();
  stub.seed(["ubq_ai", "kernel_auth", "limits", "ubq"], legacyLimitRecord());

  await assert.rejects(() => migrateKernelQuotaV2(kv(stub), NOW), /legacy kernel quota key is malformed/);
});

test("kernel quota migration: a lost CAS aborts the migration instead of splitting a policy", async () => {
  const stub = new MapKv();
  stub.seed(legacyRepoLimitKey("ubq", "repo-h"), legacyLimitRecord());
  stub.failCommits = true;

  await assert.rejects(() => migrateKernelQuotaV2(kv(stub), NOW), /legacy kernel quota changed concurrently: ubq\/repo-h/);
  assert.notEqual(stub.value(legacyRepoLimitKey("ubq", "repo-h")), null);
});

test("API key usage V3 inventory: valid rows report counts and consistent reservation aggregates", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.seed(apiKeyUsageV3WindowKey(policy), windowRecord(policy, { committed_requests: 2, reserved_requests: 1 }));
  stub.seed(apiKeyUsageV3RequestKey(policy, "req-1"), requestRecord(policy, "req-1"));
  stub.seed(
    apiKeyUsageV3RequestKey(policy, "req-2"),
    requestRecord(policy, "req-2", { state: "released", released_at_ms: NOW - 10, release_reason: "completed" })
  );

  assert.deepEqual(await inspectApiKeyUsageV3(kv(stub), new Set([policy.key_id])), { windows: 1, requests: 2, errors: [] });
});

test("API key usage V3 inventory: reserved aggregates are cross-checked and complete terminal states pass", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  // Window aggregate disagrees with the single reserved request.
  stub.seed(apiKeyUsageV3WindowKey(policy), windowRecord(policy, { reserved_requests: 4 }));
  stub.seed(apiKeyUsageV3RequestKey(policy, "req-1"), requestRecord(policy, "req-1"));
  // A dispatched row carries its provider and dispatch time, so it is coherent.
  stub.seed(apiKeyUsageV3RequestKey(policy, "req-2"), requestRecord(policy, "req-2", { state: "dispatched", provider: "lithos", dispatched_at_ms: NOW }));
  stub.seed(
    apiKeyUsageV3RequestKey(policy, "req-3"),
    requestRecord(policy, "req-3", { state: "released", released_at_ms: NOW - 10, release_reason: "completed" })
  );
  // A dispatched row missing its provider fails the row's own normalization, so
  // it is reported as malformed rather than as an incomplete state.
  stub.seed(apiKeyUsageV3RequestKey(policy, "req-4"), requestRecord(policy, "req-4", { state: "dispatched", provider: null, dispatched_at_ms: NOW }));

  const inventory = await inspectApiKeyUsageV3(kv(stub), new Set([policy.key_id]));

  assert.equal(inventory.requests, 4);
  assert.deepEqual(inventory.errors, [
    `API key usage V3 request is malformed: ${JSON.stringify(apiKeyUsageV3RequestKey(policy, "req-4"))}`,
    `API key usage V3 reserved aggregate is inconsistent: ${JSON.stringify([policy.key_id, policy.policy_version, policy.window_start_ms])}`,
  ]);
});

test("API key usage V3 inventory: malformed window rows are rejected and orphaned windows are reported", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  // Key identity matches but the stored value's identity disagrees.
  stub.seed(apiKeyUsageV3WindowKey(policy), windowRecord(policy, { window_start_ms: policy.window_start_ms + 1 }));
  // Wrong key arity.
  stub.seed([...API_KEY_USAGE_V3_WINDOW_PREFIX, policy.key_id, policy.policy_version, policy.window_start_ms, "extra"], windowRecord(policy));
  // Key id is not an id at all.
  stub.seed([...API_KEY_USAGE_V3_WINDOW_PREFIX, 7, policy.policy_version, policy.window_start_ms], windowRecord(policy));
  // A structurally valid window for an unknown key is orphaned rather than malformed.
  const orphan = policyFor({ key_id: "key-orphan" });
  stub.seed(apiKeyUsageV3WindowKey(orphan), windowRecord(orphan));

  const inventory = await inspectApiKeyUsageV3(kv(stub), new Set([policy.key_id]));

  assert.equal(inventory.windows, 4);
  assert.equal(inventory.requests, 0);
  assert.equal(inventory.errors.filter((error) => error.includes("API key usage V3 window is malformed")).length, 3);
  assert.ok(inventory.errors.includes("API key usage V3 window is orphaned: key-orphan"));
});

test("API key usage V3 inventory: malformed and windowless request rows are reported", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.seed(apiKeyUsageV3WindowKey(policy), windowRecord(policy));
  // Value is not a valid V3 request row.
  stub.seed(apiKeyUsageV3RequestKey(policy, "req-bad-value"), { v: 3 });
  // Key arity is wrong.
  stub.seed(
    [...API_KEY_USAGE_V3_REQUEST_PREFIX, policy.key_id, policy.policy_version, policy.window_start_ms, "req-extra", "tail"],
    requestRecord(policy, "req-extra")
  );
  // Key request id is not a string.
  stub.seed([...API_KEY_USAGE_V3_REQUEST_PREFIX, policy.key_id, policy.policy_version, policy.window_start_ms, 12], requestRecord(policy, "req-number"));
  // Value identity disagrees with the key.
  stub.seed(apiKeyUsageV3RequestKey(policy, "req-shifted"), requestRecord(policy, "req-shifted", { key_id: "other-key" }));
  // Valid request naming a window that does not exist.
  const windowless = policyFor({ key_id: "key-windowless" });
  stub.seed(apiKeyUsageV3RequestKey(windowless, "req-windowless"), requestRecord(windowless, "req-windowless"));

  const inventory = await inspectApiKeyUsageV3(kv(stub), new Set([policy.key_id, windowless.key_id]));

  assert.equal(inventory.windows, 1);
  assert.equal(inventory.requests, 5);
  assert.equal(inventory.errors.filter((error) => error.includes("API key usage V3 request is malformed")).length, 4);
  assert.ok(inventory.errors.some((error) => error.startsWith("API key usage V3 request has no window:")));
});

test("kernel quota V2 inventory: consistent rows are counted without errors", async () => {
  const stub = new MapKv();
  stub.seed(kernelRepoPolicyKey("ubq", "repo-a"), kernelPolicyRow("repo", "ubq", "repo-a"));
  stub.seed(kernelOrgPolicyKey("ubq"), kernelPolicyRow("org", "ubq", undefined));
  stub.seed(kernelRepoWindowKey("ubq", "repo-a"), kernelWindowRow("repo", "ubq", "repo-a", { reserved_requests: 1 }));
  stub.seed(kernelOrgWindowKey("ubq"), kernelWindowRow("org", "ubq", undefined));
  stub.seed(kernelRepoReservationKey("ubq", "repo-a", NOW - 10_000, "req-1"), kernelReservationRow("repo", "ubq", "repo-a", "req-1", NOW - 10_000));
  stub.seed(
    kernelOrgReservationKey("ubq", NOW - 10_000, "req-2"),
    kernelReservationRow("org", "ubq", undefined, "req-2", NOW - 10_000, { state: "committed", terminal_intent: "committed", committed_at_ms: NOW - 500 })
  );

  assert.deepEqual(await inspectKernelQuotaV2(kv(stub)), {
    repoPolicies: 1,
    orgPolicies: 1,
    repoWindows: 1,
    orgWindows: 1,
    repoReservations: 1,
    orgReservations: 1,
    errors: [],
  });
});

test("kernel quota V2 inventory: malformed policy and window rows are reported with their scope", async () => {
  const stub = new MapKv();
  // Repo policy with a bad owner and a value that fails validation.
  stub.seed(["uos_ai", "kernel_quota", "v2", "repo_policy", "ubq", "repo-bad"], { v: 2 });
  // Org policy carrying an extra key part, which org scope forbids.
  stub.seed(["uos_ai", "kernel_quota", "v2", "org_policy", "ubq", "extra"], kernelPolicyRow("org", "ubq", undefined));
  // Window rows: one malformed value, one malformed key.
  stub.seed(kernelRepoWindowKey("ubq", "repo-b"), { v: 2, scope: "repo", owner: "ubq", repo: "repo-b" });
  stub.seed(["uos_ai", "kernel_quota", "v2", "org_window", 5], kernelWindowRow("org", "ubq", undefined));

  const inventory = await inspectKernelQuotaV2(kv(stub));

  assert.deepEqual(inventory, {
    repoPolicies: 1,
    orgPolicies: 1,
    repoWindows: 1,
    orgWindows: 1,
    repoReservations: 0,
    orgReservations: 0,
    errors: [
      `kernel quota V2 policy is malformed: ${JSON.stringify(["uos_ai", "kernel_quota", "v2", "repo_policy", "ubq", "repo-bad"])}`,
      `kernel quota V2 policy is malformed: ${JSON.stringify(["uos_ai", "kernel_quota", "v2", "org_policy", "ubq", "extra"])}`,
      `kernel quota V2 window is malformed: ${JSON.stringify(kernelRepoWindowKey("ubq", "repo-b"))}`,
      `kernel quota V2 window is malformed: ${JSON.stringify(["uos_ai", "kernel_quota", "v2", "org_window", 5])}`,
    ],
  });
});

test("kernel quota V2 inventory: malformed reservation rows are reported and identities checked", async () => {
  const stub = new MapKv();
  const windowCreatedAtMs = NOW - 10_000;
  // Reserved row whose key does not carry a string request id.
  stub.seed(
    ["uos_ai", "kernel_quota", "v2", "repo_reservation", "ubq", "repo-a", windowCreatedAtMs, 9],
    kernelReservationRow("repo", "ubq", "repo-a", "req-1", windowCreatedAtMs)
  );
  // Valid key, unusable value.
  stub.seed(kernelRepoReservationKey("ubq", "repo-a", windowCreatedAtMs, "req-2"), { v: 2, scope: "repo" });
  // Key/value identity disagreement on the request id.
  stub.seed(
    kernelRepoReservationKey("ubq", "repo-a", windowCreatedAtMs, "req-3"),
    kernelReservationRow("repo", "ubq", "repo-a", "req-mismatched", windowCreatedAtMs)
  );
  // Org reservation with the wrong key arity for its scope.
  stub.seed([...kernelOrgReservationKey("ubq", windowCreatedAtMs, "req-4"), "tail"], kernelReservationRow("org", "ubq", undefined, "req-4", windowCreatedAtMs));

  const inventory = await inspectKernelQuotaV2(kv(stub));

  assert.equal(inventory.repoReservations, 3);
  assert.equal(inventory.orgReservations, 1);
  assert.equal(inventory.errors.filter((error) => error.includes("kernel quota V2 reservation is malformed")).length, 4);
});

test("kernel quota V2 inventory: reserved aggregates and windowless reservations are cross-checked", async () => {
  const stub = new MapKv();
  const windowCreatedAtMs = NOW - 10_000;
  // Window claims one reservation while two reserved rows exist.
  stub.seed(kernelRepoWindowKey("ubq", "repo-a"), kernelWindowRow("repo", "ubq", "repo-a", { reserved_requests: 1, created_at_ms: windowCreatedAtMs }));
  stub.seed(kernelRepoReservationKey("ubq", "repo-a", windowCreatedAtMs, "req-1"), kernelReservationRow("repo", "ubq", "repo-a", "req-1", windowCreatedAtMs));
  stub.seed(kernelRepoReservationKey("ubq", "repo-a", windowCreatedAtMs, "req-2"), kernelReservationRow("repo", "ubq", "repo-a", "req-2", windowCreatedAtMs));
  // A reserved row for a window that was never written.
  stub.seed(kernelOrgReservationKey("ubq", NOW - 20_000, "req-3"), kernelReservationRow("org", "ubq", undefined, "req-3", NOW - 20_000));

  const inventory = await inspectKernelQuotaV2(kv(stub));

  assert.equal(inventory.repoReservations, 2);
  assert.equal(inventory.orgReservations, 1);
  assert.deepEqual(inventory.errors, [
    `kernel quota V2 reserved aggregate is inconsistent: ${JSON.stringify(["repo", "ubq", "repo-a", windowCreatedAtMs])}`,
    `kernel quota V2 active reservation has no window: ${JSON.stringify(["org", "ubq", NOW - 20_000])}`,
  ]);
});

test("kernel quota V2 inventory: a window without the reservation aggregate field is not cross-checked", async () => {
  const stub = new MapKv();
  const windowCreatedAtMs = NOW - 10_000;
  const window: Record<string, unknown> = kernelWindowRow("repo", "ubq", "repo-a", { created_at_ms: windowCreatedAtMs });
  delete window.reserved_requests;
  stub.seed(kernelRepoWindowKey("ubq", "repo-a"), window);
  stub.seed(kernelRepoReservationKey("ubq", "repo-a", windowCreatedAtMs, "req-1"), kernelReservationRow("repo", "ubq", "repo-a", "req-1", windowCreatedAtMs));

  const inventory = await inspectKernelQuotaV2(kv(stub));

  assert.deepEqual(inventory.errors, []);
  assert.equal(inventory.repoWindows, 1);
});

test("kernel quota migration: a non-record legacy value fails as malformed", async () => {
  const stub = new MapKv();
  stub.seed(legacyOrgLimitKey("ubq"), "not-a-record");

  await assert.rejects(() => migrateKernelQuotaV2(kv(stub), NOW), /legacy kernel quota value is malformed/);
});

test("kernel quota migration: a lost CAS while dropping a redundant legacy row aborts the migration", async () => {
  const stub = new MapKv();
  stub.seed(kernelOrgPolicyKey("ubq"), kernelPolicyRow("org", "ubq", undefined));
  stub.seed(legacyOrgLimitKey("ubq"), legacyLimitRecord());
  stub.failCommits = true;

  await assert.rejects(() => migrateKernelQuotaV2(kv(stub), NOW), /legacy kernel quota changed concurrently: ubq\//);
  assert.notEqual(stub.value(legacyOrgLimitKey("ubq")), null);
});

test("API key usage V3 inventory: an unusable window value and an orphaned request are reported", async () => {
  const stub = new MapKv();
  const policy = policyFor();
  stub.seed(apiKeyUsageV3WindowKey(policy), { v: 3 });
  const orphan = policyFor({ key_id: "key-unknown" });
  stub.seed(apiKeyUsageV3WindowKey(orphan), windowRecord(orphan));
  stub.seed(apiKeyUsageV3RequestKey(orphan, "req-orphan"), requestRecord(orphan, "req-orphan"));

  const inventory = await inspectApiKeyUsageV3(kv(stub), new Set([policy.key_id]));

  assert.deepEqual(
    sorted(inventory.errors),
    [
      `API key usage V3 window is malformed: ${JSON.stringify(apiKeyUsageV3WindowKey(policy))}`,
      "API key usage V3 window is orphaned: key-unknown",
      "API key usage V3 request is orphaned: key-unknown/req-orphan",
      // The orphan window has a reserved request while its stored aggregate is zero.
      `API key usage V3 reserved aggregate is inconsistent: ${JSON.stringify(["key-unknown", orphan.policy_version, orphan.window_start_ms])}`,
    ].sort((left, right) => left.localeCompare(right))
  );
});

const API_KEY_HASH = "h".repeat(43);
const OTHER_HASH = "i".repeat(43);

const apiKeyRecord = (overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  id: "key-alpha",
  name: "alpha",
  prefix: "u_0123456789",
  hash: API_KEY_HASH,
  created_at_ms: NOW - 10_000,
  expires_at_ms: -1,
  revoked_at_ms: null,
  usage_limit_requests: 10,
  usage_requests: 2,
  usage_reset_at_ms: NOW + WINDOW_MS,
  window_ms: WINDOW_MS,
  usage_quota_version: 3,
  paid_fallback_enabled: false,
  paid_fallback_limit_microcredits: 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
  paid_fallback_model_ids: [],
  paid_fallback_quota_per_credit: 0,
  paid_fallback_pricing_checked_at_ms: null,
  ...overrides,
});

const apiKeyHashRecord = (overrides: Partial<ApiKeyHashRecord> = {}): ApiKeyHashRecord => ({
  id: "key-alpha",
  expires_at_ms: -1,
  revoked_at_ms: null,
  usage_limit_requests: 10,
  usage_requests: 2,
  usage_reset_at_ms: NOW + WINDOW_MS,
  window_ms: WINDOW_MS,
  usage_quota_version: 3,
  paid_fallback_enabled: false,
  paid_fallback_limit_microcredits: 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
  ...overrides,
});

test("strict api key pairs: a consistent id and hash row is paired", async () => {
  const stub = new MapKv();
  const record = apiKeyRecord();
  stub.seed(apiKeyIdKey(record.id), record);
  stub.seed(apiKeyHashKey(record.hash), apiKeyHashRecord());

  const inventory = await inspectStrictApiKeyPairs(kv(stub));

  assert.deepEqual(inventory.errors, []);
  assert.equal(inventory.pairs.length, 1);
  assert.equal(inventory.pairs[0].record.id, record.id);
  assert.equal(inventory.pairs[0].hashRecord.usage_requests, 2);
});

test("strict api key pairs: unusable hash rows are reported and left unpaired", async () => {
  const stub = new MapKv();
  // Key suffix is not a valid api-key hash.
  stub.seed([...API_KEY_HASH_PREFIX, "short"], apiKeyHashRecord());
  // Key suffix is valid but the stored policy is missing its core fields.
  stub.seed(apiKeyHashKey(OTHER_HASH), { id: "key-beta" });

  const inventory = await inspectStrictApiKeyPairs(kv(stub));

  assert.deepEqual(inventory.pairs, []);
  assert.deepEqual(
    sorted(inventory.errors),
    [
      `api key hash entry has an invalid key: ${JSON.stringify([...API_KEY_HASH_PREFIX, "short"])}`,
      `api key hash policy has invalid core fields: ${OTHER_HASH}`,
    ].sort((left, right) => left.localeCompare(right))
  );
});

test("strict api key pairs: unusable id rows are reported individually", async () => {
  const stub = new MapKv();
  stub.seed(apiKeyHashKey(API_KEY_HASH), apiKeyHashRecord());
  // Key suffix is not an api-key id.
  stub.seed([...API_KEY_ID_PREFIX, 42], apiKeyRecord());
  // Record id disagrees with the key suffix.
  stub.seed(apiKeyIdKey("key-shifted"), apiKeyRecord());
  // Valid key but the stored record has no strict v2 policy.
  stub.seed(apiKeyIdKey("key-thin"), { id: "key-thin" });

  const inventory = await inspectStrictApiKeyPairs(kv(stub));

  assert.deepEqual(inventory.pairs, []);
  assert.deepEqual(
    sorted(inventory.errors),
    [
      `api key id entry has an invalid key: ${JSON.stringify([...API_KEY_ID_PREFIX, 42])}`,
      `api key id key suffix does not match record id: key=key-shifted record=key-alpha`,
      "api key has invalid v2 policy: key-thin",
      `api key hash policy is orphaned: ${API_KEY_HASH}`,
    ].sort((left, right) => left.localeCompare(right))
  );
});

test("strict api key pairs: a missing or inconsistent hash policy blocks the pair", async () => {
  const stub = new MapKv();
  const record = apiKeyRecord();
  stub.seed(apiKeyIdKey(record.id), record);

  const missing = await inspectStrictApiKeyPairs(kv(stub));
  assert.deepEqual(missing.pairs, []);
  assert.deepEqual(missing.errors, [`api key hash policy is missing or inconsistent: ${record.id}`]);

  const inconsistent = new MapKv();
  inconsistent.seed(apiKeyIdKey(record.id), record);
  inconsistent.seed(apiKeyHashKey(record.hash), apiKeyHashRecord({ usage_requests: 9 }));
  const inconsistentInventory = await inspectStrictApiKeyPairs(kv(inconsistent));
  assert.deepEqual(inconsistentInventory.pairs, []);
  // A mismatched hash policy is never referenced, so it is also reported as orphaned.
  assert.deepEqual(
    sorted(inconsistentInventory.errors),
    [`api key hash policy is missing or inconsistent: ${record.id}`, `api key hash policy is orphaned: ${record.hash}`].sort((left, right) =>
      left.localeCompare(right)
    )
  );
});

test("strict api key pairs: a second id row claiming the same hash is inconsistent, not a duplicate reference", async () => {
  const stub = new MapKv();
  stub.seed(apiKeyIdKey("key-alpha"), apiKeyRecord({ id: "key-alpha" }));
  stub.seed(apiKeyIdKey("key-beta"), apiKeyRecord({ id: "key-beta" }));
  stub.seed(apiKeyHashKey(API_KEY_HASH), apiKeyHashRecord());

  const inventory = await inspectStrictApiKeyPairs(kv(stub));

  // Only the id row the hash policy names can pair with it; the second row is
  // reported as inconsistent instead of as a duplicate reference.
  assert.equal(inventory.pairs.length, 1);
  assert.equal(inventory.pairs[0].record.id, "key-alpha");
  assert.deepEqual(inventory.errors, ["api key hash policy is missing or inconsistent: key-beta"]);
});

// --- src/cache/scope-experiment-model.ts -----------------------------------
