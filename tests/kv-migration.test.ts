import { test } from "bun:test";
import { KvU64 } from "#kv";
import type { Kv, KvEntry, KvEntryMaybe, KvKey, KvListOptions, KvListSelector } from "#kv";
import assert from "node:assert/strict";
import { keyToJson } from "../src/kv-conversion/profile-json.ts";
import { appendBooleanParam } from "../scripts/kv-migrate.ts";
import { API_KEY_USAGE_V3_RETENTION_MS } from "../src/api-key-policy.ts";
import { codexResetUsageKey, readCodexResetUsage } from "../src/codex/reset-settings.ts";
import {
  classifyKvMigrationKey,
  importKvMigrationLines,
  KV_READ_INCIDENT_V2_MIGRATION_KEY,
  migrateKvReadIncidentV2,
  validateKvMigrationTarget,
} from "../src/cache/kv-migration.ts";
import { paidFallbackReconciliationGateV3Key } from "../src/paid-fallback/ledger-state.ts";

const keyToString = (key: KvKey): string => JSON.stringify(key);

const simpleValueToJson = (value: unknown): unknown => {
  if (value === null) return { type: "null", value: null };
  if (Array.isArray(value)) return { type: "Array", value: value.map(simpleValueToJson) };
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, simpleValueToJson(item)]);
    return { type: "object", value: Object.fromEntries(entries) };
  }
  return { type: typeof value, value };
};

const entryLine = (key: KvKey, value: unknown): string =>
  JSON.stringify({
    key: keyToJson(key),
    value: simpleValueToJson(value),
    versionstamp: "00000000000000000000",
  });

const paidFallbackGateDueAtMs = (store: Map<string, unknown>): number => {
  const value = store.get(keyToString(paidFallbackReconciliationGateV3Key())) as { next_due_at_ms?: unknown } | undefined;
  const dueAtMs = value?.next_due_at_ms;
  if (typeof dueAtMs !== "number") throw new Error("expected a numeric paid fallback gate timestamp");
  return dueAtMs;
};

type KvSetOptions = Readonly<{ expireIn?: number }>;

const makeKvStub = (
  store: Map<string, unknown>,
  options: Readonly<{ onSet?: (key: KvKey, options?: KvSetOptions) => void; onAtomicSet?: (key: KvKey, options?: KvSetOptions) => void }> = {}
): Kv =>
  ({
    get: (key: KvKey) => Promise.resolve({ key, value: store.get(keyToString(key)) ?? null } as KvEntryMaybe<unknown>),
    set: (key: KvKey, value: unknown, setOptions?: KvSetOptions) => {
      store.set(keyToString(key), value);
      options.onSet?.(key, setOptions);
      return Promise.resolve({ ok: true } as const);
    },
    delete: (key: KvKey) => {
      store.delete(keyToString(key));
      return Promise.resolve();
    },
    atomic: () => {
      const writes: { key: KvKey; value: unknown; options?: KvSetOptions }[] = [];
      const sums: { key: KvKey; value: bigint }[] = [];
      const operation = {
        check: (_entry: KvEntryMaybe<unknown>) => operation,
        set: (key: KvKey, value: unknown, setOptions?: KvSetOptions) => {
          writes.push({ key, value, options: setOptions });
          return operation;
        },
        sum: (key: KvKey, value: bigint) => {
          sums.push({ key, value });
          return operation;
        },
        commit: () => {
          for (const write of writes) {
            store.set(keyToString(write.key), write.value);
            options.onAtomicSet?.(write.key, write.options);
          }
          for (const sum of sums) {
            const existing = store.get(keyToString(sum.key)) as KvU64 | undefined;
            store.set(keyToString(sum.key), new KvU64((existing?.value ?? 0n) + sum.value));
          }
          return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" });
        },
      };
      return operation;
    },
    list: function* (selector: KvListSelector, options?: KvListOptions) {
      const prefix = "prefix" in selector ? selector.prefix : [];
      const limit = typeof options?.limit === "number" ? options.limit : Infinity;
      let yielded = 0;
      for (const [rawKey, value] of store.entries()) {
        const key = JSON.parse(rawKey) as KvKey;
        if (!prefix.every((part, index) => key[index] === part)) continue;
        yield { key, value, versionstamp: "00000000000000000000" } as KvEntry<unknown>;
        yielded += 1;
        if (yielded >= limit) break;
      }
    },
  }) as unknown as Kv;

const seedUnlimitedIncidentApiKey = (
  store: Map<string, unknown>,
  options: Readonly<{
    id?: string;
    hash?: string;
    sharedOverrides?: Record<string, unknown>;
    keyOverrides?: Record<string, unknown>;
  }> = {}
) => {
  const now = Date.now();
  const id = options.id ?? "unlimited-paid-fallback-key";
  const hash = options.hash ?? "d".repeat(43);
  const shared = {
    id,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: -1,
    usage_requests: 0,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: -1,
    paid_fallback_spent_microcredits: 2_000_000,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: "pending-unlimited-request",
    ...options.sharedOverrides,
  };
  const record = {
    ...shared,
    name: "Unlimited paid fallback",
    prefix: "u_1234567890",
    hash,
    created_at_ms: now - 60_000,
    paid_fallback_model_ids: ["gpt-5.5"],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_pricing_checked_at_ms: now,
    ...options.keyOverrides,
  };
  store.set(keyToString(["ubq_ai", "codex_models"]), {
    models: [{ slug: "gpt-5.5", supported_reasoning_levels: ["none", "medium"] }],
    source: "chatgpt_codex",
    updated_at_ms: now,
  });
  store.set(keyToString(["default", "model"]), "gpt-5.5");
  store.set(keyToString(["default", "reasoning_effort"]), "medium");
  store.set(keyToString(["ubq_ai", "api_keys", "id", id]), record);
  store.set(keyToString(["ubq_ai", "api_keys", "hash", hash]), shared);
  return { id, hash, now, record, shared };
};

test("KV migration HTTP CLI serializes explicit false flags", () => {
  const url = new URL("https://ai.ubq.fi/admin/kv-migration/import");
  appendBooleanParam(url, "include_legacy", false);
  appendBooleanParam(url, "overwrite", true);

  assert.equal(url.searchParams.get("include_legacy"), "0");
  assert.equal(url.searchParams.get("overwrite"), "1");
});

test("KV migration classifies v2 incident state and skips the transient circuit", () => {
  const options = { profile: "prod", includeCache: false, includeLegacy: false } as const;
  assert.equal(classifyKvMigrationKey(["uos_ai", "api_key_usage", "v2", "id"], options).action, "import");
  assert.equal(classifyKvMigrationKey(["uos_ai", "paid_fallback", "ledger", "id"], options).action, "import");
  assert.equal(classifyKvMigrationKey(["uos_ai", "paid_fallback", "v3", "window", "id", 123], options).group, "paid_fallback_v3_windows");
  assert.equal(classifyKvMigrationKey(["uos_ai", "paid_fallback", "v3", "request", "id", "request"], options).group, "paid_fallback_v3_requests");
  assert.equal(classifyKvMigrationKey(["uos_ai", "paid_fallback", "v3", "pending", "id", "request"], options).group, "paid_fallback_v3_pending");
  assert.equal(
    classifyKvMigrationKey(["uos_ai", "paid_fallback", "v3", "reconciliation_lease", "id"], options).group,
    "paid_fallback_v3_reconciliation_leases"
  );
  assert.equal(classifyKvMigrationKey(["uos_ai", "paid_fallback", "v3", "deletion_guard", "id"], options).group, "paid_fallback_v3_deletion_guards");
  assert.equal(
    classifyKvMigrationKey(["uos_ai", "kernel_quota", "v2", "repo_reservation", "owner", "repo", 123, "request"], options).group,
    "kernel_quota_v2_repo_reservation"
  );
  assert.equal(
    classifyKvMigrationKey(["uos_ai", "kernel_quota", "v2", "org_reservation", "owner", 123, "request"], options).group,
    "kernel_quota_v2_org_reservation"
  );
  assert.equal(classifyKvMigrationKey(["uos_ai", "runtime_config", "v2"], options).action, "import");
  assert.equal(classifyKvMigrationKey(codexResetUsageKey("account-hash"), options).action, "import");
  assert.equal(classifyKvMigrationKey(codexResetUsageKey("account-hash"), options).group, "codex_reset_usage");
  assert.equal(classifyKvMigrationKey(["uos_ai", "codex_rate_limit"], options).group, "unknown");
});

test("KV migration restores bounded TTLs and skips expired usage rows", async () => {
  const store = new Map<string, unknown>();
  const now = Date.now();
  const freshKey = ["uos_ai", "api_key_usage", "v3", "window", "ttl-key", "policy", now] as const;
  const expiredKey = ["uos_ai", "api_key_usage", "v3", "window", "expired-key", "policy", now - 1] as const;
  let importedTtl: number | undefined;
  const kv = makeKvStub(store, {
    onSet: (_key, options) => {
      importedTtl = options?.expireIn;
    },
  });

  const fresh = await importKvMigrationLines(kv, [entryLine(freshKey, { window_reset_at_ms: now + 60_000 })], {
    profile: "prod",
    includeCache: false,
    includeLegacy: false,
    overwrite: true,
    dryRun: false,
  });
  assert.equal(fresh.imported, 1);
  assert.ok(importedTtl !== undefined && importedTtl > 0);

  const expired = await importKvMigrationLines(
    kv,
    [entryLine(expiredKey, { window_reset_at_ms: now - API_KEY_USAGE_V3_RETENTION_MS - 1 })],
    { profile: "prod", includeCache: false, includeLegacy: false, overwrite: true, dryRun: false }
  );
  assert.equal(expired.imported, 0);
  assert.equal(expired.skipped, 1);
  assert.equal(store.has(keyToString(expiredKey)), false);
});

test("KV migration anchors V3 request TTLs to their usage window", async () => {
  const store = new Map<string, unknown>();
  const now = Date.now();
  const windowMs = 30 * 24 * 60 * 60_000;
  const windowStartMs = now - 8 * 24 * 60 * 60_000;
  const requestKey = ["uos_ai", "api_key_usage", "v3", "request", "ttl-key", `v3:${windowMs}`, windowStartMs, "request"] as const;
  let importedTtl: number | undefined;

  const result = await importKvMigrationLines(
    makeKvStub(store, { onSet: (_key, options) => (importedTtl = options?.expireIn) }),
    [entryLine(requestKey, { reserved_at_ms: windowStartMs })],
    { profile: "prod", includeCache: false, includeLegacy: false, overwrite: true, dryRun: false }
  );

  assert.equal(result.imported, 1);
  assert.ok(importedTtl !== undefined && importedTtl > API_KEY_USAGE_V3_RETENTION_MS);
});

test("KV migration reconciles an imported Kernel quota reservation aggregate", async () => {
  const store = new Map<string, unknown>();
  const now = Date.now();
  const owner = "migration-reconcile-org";
  const windowKey = ["uos_ai", "kernel_quota", "v2", "org_window", owner] as const;
  const reservationKey = ["uos_ai", "kernel_quota", "v2", "org_reservation", owner, now, "request"] as const;
  const window = {
    v: 2,
    scope: "org",
    owner,
    usage_requests: 0,
    usage_reset_at_ms: now + 60_000,
    applied_window_ms: 60_000,
    created_at_ms: now,
    updated_at_ms: now,
  };
  const reservation = {
    v: 2,
    scope: "org",
    owner,
    request_id: "request",
    route: "responses",
    window_created_at_ms: now,
    window_reset_at_ms: now + 60_000,
    state: "reserved",
    terminal_intent: null,
    reserved_at_ms: now,
    lease_expires_at_ms: now + 30_000,
    committed_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  };

  const result = await importKvMigrationLines(makeKvStub(store), [entryLine(reservationKey, reservation), entryLine(windowKey, window)], {
    profile: "prod",
    includeCache: false,
    includeLegacy: false,
    overwrite: true,
    dryRun: false,
  });
  assert.equal(result.imported, 2);
  assert.equal((store.get(keyToString(windowKey)) as { reserved_requests?: number }).reserved_requests, 1);
});

test("KV migration validates Kernel quota reservation aggregates", async () => {
  const store = new Map<string, unknown>();
  const now = Date.now();
  const owner = "migration-reservation-org";
  const requestId = "migration-reservation-request";
  const windowKey = ["uos_ai", "kernel_quota", "v2", "org_window", owner] as const;
  const reservationKey = ["uos_ai", "kernel_quota", "v2", "org_reservation", owner, now, requestId] as const;
  store.set(keyToString(windowKey), {
    v: 2,
    scope: "org",
    owner,
    usage_requests: 0,
    reserved_requests: 1,
    usage_reset_at_ms: now + 60_000,
    applied_window_ms: 60_000,
    created_at_ms: now,
    updated_at_ms: now,
  });
  store.set(keyToString(reservationKey), {
    v: 2,
    scope: "org",
    owner,
    request_id: requestId,
    route: "responses",
    window_created_at_ms: now,
    window_reset_at_ms: now + 60_000,
    state: "reserved",
    terminal_intent: null,
    reserved_at_ms: now,
    lease_expires_at_ms: now + 30_000,
    committed_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  });

  const valid = await validateKvMigrationTarget(makeKvStub(store));
  assert.equal(valid.counts.kernel_v2_org_windows, 1);
  assert.equal(valid.counts.kernel_v2_org_reservations, 1);
  assert.doesNotMatch(valid.errors.join("\n"), /kernel quota V2/);

  const windowWithAggregate = store.get(keyToString(windowKey)) as Record<string, unknown>;
  const reservedReservation = store.get(keyToString(reservationKey)) as Record<string, unknown>;
  store.delete(keyToString(windowKey));
  const activeReservationWithoutWindow = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(activeReservationWithoutWindow.errors.join("\n"), /kernel quota V2 active reservation has no window/);

  store.set(keyToString(reservationKey), {
    ...reservedReservation,
    state: "committed",
    committed_at_ms: now + 1,
  });
  const retainedCommittedReservation = await validateKvMigrationTarget(makeKvStub(store));
  assert.doesNotMatch(retainedCommittedReservation.errors.join("\n"), /active reservation has no window/);

  store.set(keyToString(reservationKey), {
    ...reservedReservation,
    state: "released",
    released_at_ms: now + 1,
    release_reason: "request_cancelled",
  });
  const retainedReleasedReservation = await validateKvMigrationTarget(makeKvStub(store));
  assert.doesNotMatch(retainedReleasedReservation.errors.join("\n"), /active reservation has no window/);

  store.set(keyToString(windowKey), windowWithAggregate);
  store.set(keyToString(reservationKey), reservedReservation);
  const legacyWindow = { ...windowWithAggregate };
  delete legacyWindow.reserved_requests;
  store.set(keyToString(windowKey), legacyWindow);
  const compatibleLegacyWindow = await validateKvMigrationTarget(makeKvStub(store));
  assert.doesNotMatch(compatibleLegacyWindow.errors.join("\n"), /kernel quota V2/);

  store.set(keyToString(windowKey), windowWithAggregate);
  store.delete(keyToString(reservationKey));
  const missingReservation = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(missingReservation.errors.join("\n"), /kernel quota V2 reserved aggregate is inconsistent/);
});

test("prod KV migration imports only modern durable rows by default", async () => {
  const store = new Map<string, unknown>();
  const result = await importKvMigrationLines(
    makeKvStub(store),
    [
      entryLine(["default", "model"], "gpt-5.4"),
      entryLine(["ubq_ai", "codex_models"], { models: [{ slug: "gpt-5.4" }] }),
      entryLine(["key", "config", "1"], { apiKey: "legacy" }),
      entryLine(["uos_ai", "auth", "sessions", "session-id"], { user_id: "user-id" }),
    ],
    {
      profile: "prod",
      includeCache: false,
      includeLegacy: false,
      overwrite: true,
      dryRun: false,
    }
  );

  assert.equal(result.total, 4);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 3);
  assert.equal(result.errors, 0);
  assert.equal(store.get(keyToString(["default", "model"])), "gpt-5.4");
  assert.equal(store.has(keyToString(["ubq_ai", "codex_models"])), false);
  assert.equal(store.has(keyToString(["key", "config", "1"])), false);
  assert.equal(store.has(keyToString(["uos_ai", "auth", "sessions", "session-id"])), false);
});

test("KV migration imports and validates the complete paid fallback V3 state", async () => {
  const store = new Map<string, unknown>();
  const now = Date.now();
  const keyId = "paid-fallback-v3-migration";
  const requestId = "request-v3-migration";
  const resetAtMs = now + 60_000;
  const request = {
    v: 3,
    key_id: keyId,
    request_id: requestId,
    policy_version: "policy-v3",
    route: "responses",
    path: "/v1/responses",
    model: "gpt-5.5",
    stream: true,
    reasoning: "high",
    window_reset_at_ms: resetAtMs,
    reserved_microcredits: 50_000,
    quota_per_credit: 500_000,
    provider_request_id: "provider-v3-migration",
    provider_quota: 12.5,
    input_tokens: 10,
    output_tokens: 5,
    dispatch_state: "dispatched",
    terminal_state: "completed",
    spend_microcredits: 25,
    billing_state: "settled",
    reconciliation_attempts: 1,
    last_reconciliation_at_ms: now,
    dispatched_at_ms: now - 500,
    terminal_at_ms: now - 100,
    settled_at_ms: now,
    created_at_ms: now - 1_000,
    updated_at_ms: now,
  } as const;
  const pendingRequestId = "pending-request-v3-migration";
  const pendingRequest = {
    ...request,
    request_id: pendingRequestId,
    provider_request_id: "provider-v3-pending",
    provider_quota: null,
    input_tokens: null,
    output_tokens: null,
    terminal_state: "pending",
    spend_microcredits: null,
    billing_state: "pending",
    reconciliation_attempts: 0,
    last_reconciliation_at_ms: null,
    terminal_at_ms: null,
    settled_at_ms: null,
    updated_at_ms: now - 100,
  } as const;
  const window = {
    v: 3,
    key_id: keyId,
    policy_version: "policy-v3",
    window_reset_at_ms: resetAtMs,
    limit_microcredits: 2_000_000,
    settled_microcredits: 25,
    reserved_microcredits: 50_000,
    pending_count: 1,
    updated_at_ms: now,
  } as const;
  const entries = [
    entryLine(["uos_ai", "paid_fallback", "v3", "window", keyId, resetAtMs], window),
    entryLine(["uos_ai", "paid_fallback", "v3", "request", keyId, requestId], request),
    entryLine(["uos_ai", "paid_fallback", "v3", "request", keyId, pendingRequestId], pendingRequest),
    entryLine(["uos_ai", "paid_fallback", "v3", "pending", keyId, pendingRequestId], {
      created_at_ms: pendingRequest.created_at_ms,
      next_reconciliation_at_ms: now + 5_000,
    }),
    entryLine(["uos_ai", "paid_fallback", "v3", "reconciliation_lease", keyId], { token: "lease-v3-migration", expires_at_ms: now + 60_000 }),
    entryLine(["uos_ai", "paid_fallback", "v3", "deletion_guard", "deleted-key-v3-migration"], { created_at_ms: now }),
  ];
  const imported = await importKvMigrationLines(makeKvStub(store), entries, {
    profile: "prod",
    includeCache: false,
    includeLegacy: false,
    overwrite: true,
    dryRun: false,
  });
  assert.equal(imported.imported, 6);
  assert.deepEqual(imported.groups, {
    paid_fallback_v3_deletion_guards: 1,
    paid_fallback_v3_pending: 1,
    paid_fallback_v3_reconciliation_leases: 1,
    paid_fallback_v3_requests: 2,
    paid_fallback_v3_windows: 1,
  });
  assert.deepEqual(store.get(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, requestId])), request);

  store.clear();
  seedUnlimitedIncidentApiKey(store, {
    id: keyId,
    sharedOverrides: { paid_fallback_reservation_request_id: null },
  });
  await migrateKvReadIncidentV2(makeKvStub(store));
  store.set(keyToString(["uos_ai", "paid_fallback", "v3", "window", keyId, resetAtMs]), window);
  store.set(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, requestId]), request);
  store.set(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, pendingRequestId]), pendingRequest);
  store.set(keyToString(["uos_ai", "paid_fallback", "v3", "pending", keyId, pendingRequestId]), {
    created_at_ms: pendingRequest.created_at_ms,
    next_reconciliation_at_ms: now + 5_000,
  });
  store.set(keyToString(["uos_ai", "paid_fallback", "v3", "reconciliation_lease", keyId]), {
    token: "lease-v3-migration",
    expires_at_ms: now + 60_000,
  });
  store.set(keyToString(["uos_ai", "paid_fallback", "v3", "deletion_guard", "deleted-key-v3-migration"]), { created_at_ms: now });

  const valid = await validateKvMigrationTarget(makeKvStub(store));
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.counts.paid_fallback_v3_windows, 1);
  assert.equal(valid.counts.paid_fallback_v3_requests, 2);
  assert.equal(valid.counts.paid_fallback_v3_pending, 1);
  assert.equal(valid.counts.paid_fallback_v3_reconciliation_leases, 1);
  assert.equal(valid.counts.paid_fallback_v3_deletion_guards, 1);

  // Unlimited V3 fallback requests are deliberately windowless. Their
  // per-request ledger remains durable, while bounded policies use a shared
  // aggregate window for admission and reconciliation.
  store.delete(keyToString(["uos_ai", "paid_fallback", "v3", "window", keyId, resetAtMs]));
  store.delete(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, pendingRequestId]));
  store.delete(keyToString(["uos_ai", "paid_fallback", "v3", "pending", keyId, pendingRequestId]));
  store.set(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, requestId]), {
    ...request,
    policy_version: "v3:60000",
    reserved_microcredits: 0,
  });
  assert.deepEqual((await validateKvMigrationTarget(makeKvStub(store))).errors, []);
  await migrateKvReadIncidentV2(makeKvStub(store));
  assert.equal(store.has(keyToString(["uos_ai", "paid_fallback", "v3", "window", keyId, resetAtMs])), false);

  store.set(keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, requestId]), {
    ...request,
    billing_state: "pending",
  });
  const missingPending = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(missingPending.errors.join("\n"), /request is missing its pending marker/);
});

test("local KV migration keeps legacy and Codex bootstrap rows for replay", async () => {
  const store = new Map<string, unknown>();
  const result = await importKvMigrationLines(
    makeKvStub(store),
    [entryLine(["ubq_ai", "codex_models"], { models: [{ slug: "gpt-5.4" }] }), entryLine(["key", "health", "1"], { status: "ok" })],
    {
      profile: "local",
      includeCache: false,
      includeLegacy: true,
      overwrite: true,
      dryRun: false,
    }
  );

  assert.equal(result.imported, 2);
  assert.equal(store.has(keyToString(["ubq_ai", "codex_models"])), true);
  assert.equal(store.has(keyToString(["key", "health", "1"])), true);
});

test("KV migration preserves embeddings idempotency ledgers and response chunks", async () => {
  const store = new Map<string, unknown>();
  const ledgerKey: KvKey = ["embeddings", "idempotency", "v1", "principal-hash", "idempotency-key-hash"];
  const responseChunkKey: KvKey = ["embeddings", "idempotency", "v1", "response", "principal-hash", "idempotency-key-hash", "response-generation", 0];
  const transientJobKey: KvKey = ["embeddings", "jobs", "v2", "token-hash", "profile", "job-id"];
  const ledger = { v: 1, state: "succeeded", response_chunk_count: 1 };
  const result = await importKvMigrationLines(
    makeKvStub(store),
    [entryLine(ledgerKey, ledger), entryLine(responseChunkKey, '{"data":[]}'), entryLine(transientJobKey, { status: "succeeded" })],
    {
      profile: "prod",
      includeCache: false,
      includeLegacy: false,
      overwrite: true,
      dryRun: false,
    }
  );

  assert.equal(result.imported, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.groups.embeddings_idempotency, 1);
  assert.equal(result.groups.embeddings_idempotency_responses, 1);
  assert.equal(result.groups.embeddings_jobs, 1);
  assert.deepEqual(store.get(keyToString(ledgerKey)), ledger);
  assert.equal(store.get(keyToString(responseChunkKey)), '{"data":[]}');
  assert.equal(store.has(keyToString(transientJobKey)), false);
});

test("KV migration imports only the option-aware v2 embedding cache when requested", async () => {
  const store = new Map<string, unknown>();
  const v1Key: KvKey = ["embeddings", "v1", "legacy-model", "text-hash"];
  const v2Key: KvKey = ["embeddings", "v2", "voyage-4-large|document|1024|float|float|false", "text-hash"];
  const result = await importKvMigrationLines(makeKvStub(store), [entryLine(v1Key, { embedding: [1] }), entryLine(v2Key, { embedding: [2] })], {
    profile: "prod",
    includeCache: true,
    includeLegacy: false,
    overwrite: true,
    dryRun: false,
  });

  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  assert.equal(store.has(keyToString(v1Key)), false);
  assert.deepEqual(store.get(keyToString(v2Key)), { embedding: [2] });
});

test("KV migration dry-run reports destination collisions like writes", async () => {
  const store = new Map<string, unknown>();
  store.set(keyToString(["default", "model"]), "existing-model");

  const result = await importKvMigrationLines(makeKvStub(store), [entryLine(["default", "model"], "new-model")], {
    profile: "prod",
    includeCache: false,
    includeLegacy: false,
    overwrite: false,
    dryRun: true,
  });

  assert.equal(result.imported, 0);
  assert.equal(result.skipped, 1);
  assert.equal(store.get(keyToString(["default", "model"])), "existing-model");
});

test("KV migration imports a missing row with an atomic destination check", async () => {
  const store = new Map<string, unknown>();
  const result = await importKvMigrationLines(makeKvStub(store), [entryLine(["default", "model"], "gpt-5.6"), entryLine(["default", "model"], "gpt-5.7")], {
    profile: "prod",
    includeCache: false,
    includeLegacy: false,
    overwrite: false,
    dryRun: false,
  });

  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  assert.equal(store.get(keyToString(["default", "model"])), "gpt-5.6");
});

test("KV migration validation rejects unusable codex model snapshots for configured defaults", async () => {
  const store = new Map<string, unknown>();
  store.set(keyToString(["default", "model"]), "gpt-5.5");
  store.set(keyToString(["ubq_ai", "codex_models"]), { models: [] });

  const result = await validateKvMigrationTarget(makeKvStub(store));

  assert.match(result.errors.join("\n"), /codex model snapshot is empty or malformed/);
});

test("KV incident migration rejects an active reservation without a pending ledger before mutation", async () => {
  const store = new Map<string, unknown>();
  const { id } = seedUnlimitedIncidentApiKey(store);
  const before = structuredClone([...store.entries()]);

  const validation = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(validation.errors.join("\n"), new RegExp(`reservation has no pending ledger record: ${id}`));
  await assert.rejects(
    () => migrateKvReadIncidentV2(makeKvStub(store)),
    /Paid fallback ledger validation failed: paid fallback reservation has no pending ledger record/
  );

  assert.deepEqual([...store.entries()], before);
  assert.equal(store.has(keyToString(["uos_ai", "runtime_config", "v2"])), false);
  assert.equal(store.has(keyToString(KV_READ_INCIDENT_V2_MIGRATION_KEY)), false);
});

test("KV incident migration preserves a valid unlimited reservation and requires its ledger to stay pending", async () => {
  const store = new Map<string, unknown>();
  const { id, now } = seedUnlimitedIncidentApiKey(store);
  const requestId = "pending-unlimited-request";
  const legacyKey = ["ubq_ai", "api_keys", "request_log", id, now, requestId] as const;
  const ledgerKey = ["uos_ai", "paid_fallback", "ledger", id, now, requestId] as const;
  const pendingLedger = {
    id: requestId,
    key_id: id,
    provider: "metered",
    billing_status: "pending",
    created_at_ms: now,
  };
  store.set(keyToString(legacyKey), pendingLedger);

  const migrated = await migrateKvReadIncidentV2(makeKvStub(store));
  assert.equal(migrated.handoff_phase, "no_bounded_keys");
  assert.equal(migrated.paid_fallback_records, 1);
  assert.deepEqual(store.get(keyToString(ledgerKey)), pendingLedger);
  assert.deepEqual((await validateKvMigrationTarget(makeKvStub(store))).errors, []);

  store.set(keyToString(ledgerKey), { ...pendingLedger, billing_status: "reconciled" });
  const terminalLedger = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(terminalLedger.errors.join("\n"), /reservation has no pending ledger record/);
});

test("KV incident migration permits matching terminal ledgers but rejects destination identity collisions", async () => {
  const store = new Map<string, unknown>();
  const { id, now } = seedUnlimitedIncidentApiKey(store, {
    sharedOverrides: { paid_fallback_reservation_request_id: null },
  });
  const requestId = "legacy-pending-request";
  const legacyKey = ["ubq_ai", "api_keys", "request_log", id, now, requestId] as const;
  const ledgerKey = ["uos_ai", "paid_fallback", "ledger", id, now, requestId] as const;
  const pendingLedger = {
    id: requestId,
    key_id: id,
    provider: "metered",
    billing_status: "pending",
    created_at_ms: now,
  };
  store.set(keyToString(legacyKey), pendingLedger);
  store.set(keyToString(ledgerKey), {
    ...pendingLedger,
    id: "different-request",
    billing_status: "reconciled",
  });
  const before = structuredClone([...store.entries()]);

  await assert.rejects(() => migrateKvReadIncidentV2(makeKvStub(store)), /paid fallback ledger destination conflicts with legacy record/);
  assert.deepEqual([...store.entries()], before);
  assert.equal(store.has(keyToString(["uos_ai", "runtime_config", "v2"])), false);
  assert.equal(store.has(keyToString(KV_READ_INCIDENT_V2_MIGRATION_KEY)), false);

  const reconciledLedger = { ...pendingLedger, billing_status: "reconciled" };
  store.set(keyToString(ledgerKey), reconciledLedger);
  const migrated = await migrateKvReadIncidentV2(makeKvStub(store));
  assert.equal(migrated.paid_fallback_records, 1);
  assert.deepEqual(store.get(keyToString(ledgerKey)), reconciledLedger);
});

test("KV incident migration projects settled spend and unresolved exposure exactly once", async () => {
  const store = new Map<string, unknown>();
  const keyId = "bounded-paid-fallback-key";
  const requestId = "unresolved-paid-fallback-request";
  const settledRequestId = "settled-paid-fallback-request";
  const hash = "e".repeat(43);
  const now = Date.now();
  const windowResetAtMs = now + 60_000;
  seedUnlimitedIncidentApiKey(store, {
    id: keyId,
    hash,
    sharedOverrides: {
      paid_fallback_limit_microcredits: 2_000_000,
      paid_fallback_spent_microcredits: 0,
      paid_fallback_reserved_microcredits: 100_000,
      paid_fallback_reservation_request_id: requestId,
    },
    keyOverrides: {
      paid_fallback_max_exposure_microcredits: { "gpt-5.6-sol": 100_000 },
    },
  });

  const settledLegacy = {
    id: settledRequestId,
    key_id: keyId,
    provider: "metered",
    route: "responses",
    path: "/v1/responses",
    method: "POST",
    status_code: 200,
    stream: false,
    model: "gpt-5.6-sol",
    reasoning: null,
    created_at_ms: now - 2_000,
    fallback_reason: "primary_429",
    provider_request_id: "provider-settled",
    completed_at_ms: now - 1_000,
    input_tokens: 10,
    output_tokens: 5,
    provider_quota: 25,
    quota_per_credit: 500_000,
    spend_microcredits: 25_000,
    paid_fallback_window_reset_at_ms: windowResetAtMs,
    billing_status: "reconciled",
  };
  const unresolvedLegacy = {
    ...settledLegacy,
    id: requestId,
    provider_request_id: null,
    status_code: 502,
    completed_at_ms: null,
    input_tokens: null,
    output_tokens: null,
    provider_quota: null,
    spend_microcredits: null,
    paid_fallback_window_reset_at_ms: windowResetAtMs,
    billing_status: "unresolved",
  };
  store.set(keyToString(["ubq_ai", "api_keys", "request_log", keyId, settledLegacy.created_at_ms, settledRequestId]), settledLegacy);
  store.set(keyToString(["ubq_ai", "api_keys", "request_log", keyId, unresolvedLegacy.created_at_ms, requestId]), unresolvedLegacy);

  const first = await migrateKvReadIncidentV2(makeKvStub(store));
  assert.equal(first.paid_fallback_records, 1);
  const windowKey = keyToString(["uos_ai", "paid_fallback", "v3", "window", keyId, windowResetAtMs]);
  const requestKey = (id: string) => keyToString(["uos_ai", "paid_fallback", "v3", "request", keyId, id]);
  const pendingKey = keyToString(["uos_ai", "paid_fallback", "v3", "pending", keyId, requestId]);
  const projectedWindow = store.get(windowKey) as Record<string, unknown>;
  assert.equal(projectedWindow.settled_microcredits, 25_000);
  assert.equal(projectedWindow.reserved_microcredits, 100_000);
  assert.equal(projectedWindow.pending_count, 1);
  assert.equal((store.get(requestKey(requestId)) as Record<string, unknown>).billing_state, "unresolved");
  assert.equal((store.get(requestKey(requestId)) as Record<string, unknown>).reserved_microcredits, 100_000);
  assert.equal(store.has(pendingKey), true);
  assert.equal(paidFallbackGateDueAtMs(store) <= Date.now(), true);

  const second = await migrateKvReadIncidentV2(makeKvStub(store));
  assert.equal(second.paid_fallback_records, 1);
  assert.deepEqual(store.get(windowKey), projectedWindow);

  // A partial V3 write is repaired from the immutable V3 request rows and
  // legacy source rows without adding a second copy of settled spend.
  store.delete(windowKey);
  store.delete(pendingKey);
  store.set(keyToString(paidFallbackReconciliationGateV3Key()), { next_due_at_ms: Date.now() + 60_000 });
  await migrateKvReadIncidentV2(makeKvStub(store));
  const repairedWindow = store.get(windowKey) as Record<string, unknown>;
  assert.equal(repairedWindow.settled_microcredits, 25_000);
  assert.equal(repairedWindow.reserved_microcredits, 100_000);
  assert.equal(repairedWindow.pending_count, 1);
  assert.equal(store.has(pendingKey), true);
  assert.equal(paidFallbackGateDueAtMs(store) <= Date.now(), true);
  assert.deepEqual((await validateKvMigrationTarget(makeKvStub(store))).errors, []);

  store.set(windowKey, { ...repairedWindow, settled_microcredits: 25_001 });
  const aggregateMismatch = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(aggregateMismatch.errors.join("\n"), /window aggregate is inconsistent/);
});

test("KV incident migration resumes concurrent phase one and retains postdeploy counter versions", async () => {
  const store = new Map<string, unknown>();
  const now = Date.now();
  const id = "bounded-key";
  const hash = "a".repeat(43);
  const fallback = {
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: 1_000_000,
    paid_fallback_spent_microcredits: 100_000,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  store.set(keyToString(["ubq_ai", "codex_models"]), {
    models: [{ slug: "gpt-5.5", supported_reasoning_levels: ["none", "medium"] }],
    source: "chatgpt_codex",
    updated_at_ms: now,
  });
  store.set(keyToString(["default", "model"]), "gpt-5.5");
  store.set(keyToString(["default", "reasoning_effort"]), "medium");
  store.set(keyToString(["ubq_ai", "api_keys", "id", id]), {
    id,
    name: "Bounded",
    prefix: "u_0123456789",
    hash,
    created_at_ms: now,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 10,
    usage_requests: 4,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    ...fallback,
    paid_fallback_model_ids: ["gpt-5.5"],
    paid_fallback_quota_per_credit: 500_000,
    paid_fallback_pricing_checked_at_ms: now,
  });
  store.set(keyToString(["ubq_ai", "api_keys", "hash", hash]), {
    id,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 10,
    usage_requests: 4,
    usage_reset_at_ms: now + 60_000,
    window_ms: 60_000,
    ...fallback,
  });
  const staleCounterKey = ["uos_ai", "api_key_usage", "v2", id, `10:60000:${now + 60_000}`, now] as const;
  const expiredCounterKey = ["uos_ai", "api_key_usage", "v2", id, `10:60000:${now}`, now - 60_000] as const;
  const unsafeCurrentCounterKey = ["uos_ai", "api_key_usage", "v2", id, "60000", now] as const;
  const currentBaselineKey = [...KV_READ_INCIDENT_V2_MIGRATION_KEY, "api_key_usage_baseline", id, "v3:60000", now] as const;
  store.set(keyToString(staleCounterKey), new KvU64(7n));
  store.set(keyToString(expiredCounterKey), new KvU64(99n));
  store.set(keyToString(unsafeCurrentCounterKey), new KvU64(8n));
  store.set(keyToString(KV_READ_INCIDENT_V2_MIGRATION_KEY), { version: 2, completed_at_ms: now - 1 });
  for (const [requestId, billingStatus] of [
    ["pending", "pending"],
    ["done", "reconciled"],
  ] as const) {
    store.set(keyToString(["ubq_ai", "api_keys", "request_log", id, now, requestId]), {
      id: requestId,
      key_id: id,
      provider: "metered",
      billing_status: billingStatus,
      created_at_ms: now,
    });
  }

  const result = await migrateKvReadIncidentV2(makeKvStub(store));
  assert.deepEqual(result, {
    api_keys: 1,
    bounded_counters: 1,
    handoff_phase: "predeploy_seed",
    bounded_baselines_created: 1,
    bounded_baselines_reconciled: 0,
    legacy_usage_delta_applied: 8,
    kernel_repo_records: 0,
    kernel_org_records: 0,
    paid_fallback_records: 1,
    runtime_config_written: true,
  });
  assert.equal(store.has(keyToString(["uos_ai", "runtime_config", "v2"])), true);
  assert.equal(store.has(keyToString(staleCounterKey)), true);
  assert.equal(store.has(keyToString(expiredCounterKey)), true);
  assert.equal((store.get(keyToString(unsafeCurrentCounterKey)) as KvU64).value, 8n);
  const v3WindowKey = ["uos_ai", "api_key_usage", "v3", "window", id, "v3:60000", now] as const;
  assert.equal((store.get(keyToString(v3WindowKey)) as { committed_requests?: number }).committed_requests, 8);
  const ledgerKey = ["uos_ai", "paid_fallback", "ledger", id, now, "pending"] as const;
  assert.equal(store.has(keyToString(ledgerKey)), true);
  assert.equal(store.has(keyToString(["uos_ai", "paid_fallback", "ledger", id, now, "done"])), false);
  const validation = await validateKvMigrationTarget(makeKvStub(store));
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.counts.api_key_bounded_counter_baselines_v2, 1);
  assert.equal(validation.counts.api_key_bounded_counter_reconciled_baselines_v2, 0);

  // A concurrent phase-one invocation may observe the missing global marker
  // after another invocation has already seeded this per-key baseline. It must
  // catch up old-revision usage without declaring post-deploy reconciliation.
  store.delete(keyToString(KV_READ_INCIDENT_V2_MIGRATION_KEY));
  const phaseOneIdPolicyKey = keyToString(["ubq_ai", "api_keys", "id", id]);
  const phaseOneHashPolicyKey = keyToString(["ubq_ai", "api_keys", "hash", hash]);
  const phaseOneIdPolicy = store.get(phaseOneIdPolicyKey) as Record<string, unknown>;
  const phaseOneHashPolicy = store.get(phaseOneHashPolicyKey) as Record<string, unknown>;
  store.set(phaseOneIdPolicyKey, { ...phaseOneIdPolicy, usage_requests: 5 });
  store.set(phaseOneHashPolicyKey, { ...phaseOneHashPolicy, usage_requests: 5 });
  store.set(keyToString(unsafeCurrentCounterKey), new KvU64(9n));

  const concurrentPhaseOne = await migrateKvReadIncidentV2(makeKvStub(store));
  assert.equal(concurrentPhaseOne.handoff_phase, "predeploy_seed");
  assert.equal(concurrentPhaseOne.bounded_baselines_created, 0);
  assert.equal(concurrentPhaseOne.bounded_baselines_reconciled, 0);
  assert.equal(concurrentPhaseOne.legacy_usage_delta_applied, 1);
  assert.equal((store.get(keyToString(unsafeCurrentCounterKey)) as KvU64).value, 9n);
  const caughtUpBaseline = store.get(keyToString(currentBaselineKey)) as Record<string, unknown>;
  assert.equal(caughtUpBaseline.last_legacy_usage_requests, 9);
  assert.equal(caughtUpBaseline.reconciled_at_ms, null);
  assert.equal(caughtUpBaseline.reconciliation_runs, 0);

  const migratedLedger = store.get(keyToString(ledgerKey)) as Record<string, unknown>;
  const reconciledLedger = {
    ...migratedLedger,
    billing_status: "reconciled",
    spend_microcredits: 123,
  };
  store.set(keyToString(ledgerKey), reconciledLedger);

  const idPolicyKey = keyToString(["ubq_ai", "api_keys", "id", id]);
  const hashPolicyKey = keyToString(["ubq_ai", "api_keys", "hash", hash]);
  const initialIdPolicy = store.get(idPolicyKey) as Record<string, unknown>;
  const initialHashPolicy = store.get(hashPolicyKey) as Record<string, unknown>;
  store.set(idPolicyKey, { ...initialIdPolicy, usage_requests: 7 });
  store.set(hashPolicyKey, { ...initialHashPolicy, usage_requests: 7 });
  store.set(keyToString(unsafeCurrentCounterKey), new KvU64(11n));

  // Once phase one has installed the durable marker, a post-deploy migration
  // must not delete a counter created for a newer window or an older baseline.
  const concurrentlyCreatedNextWindowCounterKey = ["uos_ai", "api_key_usage", "v2", id, "60000", now + 60_000] as const;
  const retainedPriorBaselineKey = [...KV_READ_INCIDENT_V2_MIGRATION_KEY, "api_key_usage_baseline", id, "legacy-policy", now - 60_000] as const;
  store.set(keyToString(concurrentlyCreatedNextWindowCounterKey), new KvU64(2n));
  store.set(keyToString(retainedPriorBaselineKey), {
    version: 1,
    key_id: id,
    policy_version: "legacy-policy",
    window_start_ms: now - 60_000,
    last_legacy_usage_requests: 1,
    seeded_at_ms: now,
    reconciled_at_ms: now,
    reconciliation_runs: 1,
  });

  const rerun = await migrateKvReadIncidentV2(makeKvStub(store));
  assert.equal(rerun.handoff_phase, "postdeploy_reconcile");
  assert.equal(rerun.bounded_baselines_created, 0);
  assert.equal(rerun.bounded_baselines_reconciled, 1);
  assert.equal(rerun.legacy_usage_delta_applied, 2);
  assert.equal(rerun.paid_fallback_records, 1);
  assert.deepEqual(store.get(keyToString(ledgerKey)), reconciledLedger);
  assert.equal((store.get(keyToString(unsafeCurrentCounterKey)) as KvU64).value, 11n);
  assert.equal((store.get(keyToString(v3WindowKey)) as { committed_requests?: number }).committed_requests, 11);
  assert.equal((store.get(keyToString(concurrentlyCreatedNextWindowCounterKey)) as KvU64).value, 2n);
  assert.equal(store.has(keyToString(retainedPriorBaselineKey)), true);

  const repeated = await migrateKvReadIncidentV2(makeKvStub(store));
  assert.equal(repeated.handoff_phase, "postdeploy_reconcile");
  assert.equal(repeated.legacy_usage_delta_applied, 0);
  assert.equal((store.get(keyToString(unsafeCurrentCounterKey)) as KvU64).value, 11n);
  const reconciledValidation = await validateKvMigrationTarget(makeKvStub(store));
  assert.deepEqual(reconciledValidation.errors, []);
  assert.equal(reconciledValidation.counts.api_key_bounded_counters_v2, 4);
  assert.equal(reconciledValidation.counts.api_key_bounded_counter_baselines_v2, 2);
  assert.equal(reconciledValidation.counts.api_key_bounded_counter_reconciled_baselines_v2, 2);
  assert.equal(reconciledValidation.counts.api_key_usage_v3_windows, 1);

  const idPolicy = store.get(idPolicyKey);
  store.delete(idPolicyKey);
  store.set(keyToString(["ubq_ai", "api_keys", "id", "wrong-key-suffix"]), idPolicy);
  const wrongIdKey = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(wrongIdKey.errors.join("\n"), /id key suffix does not match record id/);
  await assert.rejects(() => migrateKvReadIncidentV2(makeKvStub(store)), /id key suffix does not match record id/);
  store.delete(keyToString(["ubq_ai", "api_keys", "id", "wrong-key-suffix"]));
  store.set(idPolicyKey, idPolicy);

  const hashPolicy = store.get(hashPolicyKey) as Record<string, unknown>;
  const orphanHash = "c".repeat(43);
  store.set(keyToString(["ubq_ai", "api_keys", "hash", orphanHash]), {
    ...hashPolicy,
    id: "orphan-key",
  });
  const orphaned = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(orphaned.errors.join("\n"), /hash policy is orphaned/);
  store.delete(keyToString(["ubq_ai", "api_keys", "hash", orphanHash]));

  store.set(hashPolicyKey, { ...hashPolicy, usage_limit_requests: 11 });
  const drifted = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(drifted.errors.join("\n"), /hash policy is missing or inconsistent/);
});

test("KV incident migration starts a fresh counter after an expired legacy window and rejects malformed policy", async () => {
  const store = new Map<string, unknown>();
  const now = Date.now();
  const id = "expired-bounded-key";
  const hash = "b".repeat(43);
  const resetAtMs = now - 1;
  const windowMs = 60_000;
  const sharedPolicy = {
    id,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: 10,
    usage_requests: 99,
    usage_reset_at_ms: resetAtMs,
    window_ms: windowMs,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  store.set(keyToString(["ubq_ai", "codex_models"]), {
    models: [{ slug: "gpt-5.5", supported_reasoning_levels: ["none", "medium"] }],
    source: "chatgpt_codex",
    updated_at_ms: now,
  });
  store.set(keyToString(["default", "model"]), "gpt-5.5");
  store.set(keyToString(["default", "reasoning_effort"]), "medium");
  store.set(keyToString(["ubq_ai", "api_keys", "id", id]), {
    ...sharedPolicy,
    name: "Expired bounded",
    prefix: "u_abcdef0123",
    hash,
    created_at_ms: now - windowMs,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_pricing_checked_at_ms: null,
  });
  store.set(keyToString(["ubq_ai", "api_keys", "hash", hash]), sharedPolicy);
  const expiredCounterKey = ["uos_ai", "api_key_usage", "v2", id, `10:${windowMs}:${resetAtMs}`, resetAtMs - windowMs] as const;
  store.set(keyToString(expiredCounterKey), new KvU64(99n));

  await migrateKvReadIncidentV2(makeKvStub(store));

  assert.equal(store.has(keyToString(expiredCounterKey)), true);
  const v3Windows = [...store.entries()].filter(([key]) => key.includes(`"api_key_usage","v3","window","${id}"`));
  assert.equal(v3Windows.length, 1);
  assert.equal((v3Windows[0][1] as { committed_requests?: number }).committed_requests, 0);
  const expiredValidation = await validateKvMigrationTarget(makeKvStub(store));
  assert.deepEqual(expiredValidation.errors, []);
  assert.equal(expiredValidation.counts.api_key_bounded_counter_baselines_v2, 1);

  const idPolicyKey = keyToString(["ubq_ai", "api_keys", "id", id]);
  const hashPolicyKey = keyToString(["ubq_ai", "api_keys", "hash", hash]);
  const migratedIdPolicy = store.get(idPolicyKey) as Record<string, unknown>;
  const migratedHashPolicy = store.get(hashPolicyKey) as Record<string, unknown>;
  const changedResetAtMs = now + windowMs;
  store.set(idPolicyKey, { ...migratedIdPolicy, usage_requests: 2, usage_reset_at_ms: changedResetAtMs });
  store.set(hashPolicyKey, { ...migratedHashPolicy, usage_requests: 2, usage_reset_at_ms: changedResetAtMs });
  const rolledCounterKey = ["uos_ai", "api_key_usage", "v2", id, String(windowMs), now] as const;
  store.set(keyToString(rolledCounterKey), new KvU64(3n));
  const staleBaseline = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(staleBaseline.errors.join("\n"), /baseline is missing, stale, or invalid/);
  const rolled = await migrateKvReadIncidentV2(makeKvStub(store));
  assert.equal(rolled.handoff_phase, "postdeploy_reconcile");
  assert.equal(rolled.bounded_baselines_created, 1);
  assert.equal(rolled.bounded_baselines_reconciled, 1);
  assert.equal(rolled.legacy_usage_delta_applied, 3);
  assert.equal((store.get(keyToString(rolledCounterKey)) as KvU64).value, 3n);
  const rolledValidation = await validateKvMigrationTarget(makeKvStub(store));
  assert.deepEqual(rolledValidation.errors, []);
  const repeatedRoll = await migrateKvReadIncidentV2(makeKvStub(store));
  assert.equal(repeatedRoll.legacy_usage_delta_applied, 0);
  assert.equal((store.get(keyToString(rolledCounterKey)) as KvU64).value, 3n);

  store.set(idPolicyKey, { ...(store.get(idPolicyKey) as Record<string, unknown>), usage_limit_requests: "bad" });
  store.set(hashPolicyKey, {
    ...(store.get(hashPolicyKey) as Record<string, unknown>),
    usage_limit_requests: "bad",
  });

  const malformed = await validateKvMigrationTarget(makeKvStub(store));
  assert.match(malformed.errors.join("\n"), /invalid core fields|invalid v2 policy/);
  await assert.rejects(() => migrateKvReadIncidentV2(makeKvStub(store)), /API key policy validation failed/);
});

test("KV incident validation retains historical revoked V3 windows", async () => {
  const store = new Map<string, unknown>();
  const now = Date.now();
  const id = "revoked-bounded-key";
  const hash = "c".repeat(43);
  const resetAtMs = now - API_KEY_USAGE_V3_RETENTION_MS - 60_000;
  const shared = {
    id,
    expires_at_ms: -1,
    revoked_at_ms: now - 10_000,
    usage_limit_requests: 20,
    usage_requests: 4,
    usage_reset_at_ms: resetAtMs,
    window_ms: 60_000,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  store.set(keyToString(["ubq_ai", "codex_models"]), {
    models: [{ slug: "gpt-5.6-sol-max", supported_reasoning_levels: ["none"] }],
    source: "test",
    updated_at_ms: now,
  });
  store.set(keyToString(["default", "model"]), "gpt-5.6-sol-max");
  store.set(keyToString(["default", "reasoning_effort"]), "none");
  store.set(keyToString(["ubq_ai", "api_keys", "id", id]), {
    ...shared,
    name: "Revoked bounded",
    prefix: "u_abcdef0123",
    hash,
    created_at_ms: now - 120_000,
    paid_fallback_model_ids: [],
    paid_fallback_quota_per_credit: 0,
    paid_fallback_pricing_checked_at_ms: null,
  });
  store.set(keyToString(["ubq_ai", "api_keys", "hash", hash]), shared);

  let v3WindowExpireIn: number | undefined;
  await migrateKvReadIncidentV2(
    makeKvStub(store, {
      onAtomicSet: (key, options) => {
        if (key.slice(0, 4).join(":") === "uos_ai:api_key_usage:v3:window") {
          v3WindowExpireIn = options?.expireIn;
        }
      },
    })
  );
  assert.equal(v3WindowExpireIn, API_KEY_USAGE_V3_RETENTION_MS);
  const validation = await validateKvMigrationTarget(makeKvStub(store));
  assert.deepEqual(validation.errors, []);
});

test("KV migration preserves Codex reset usage fences and agrees with validation counts", async () => {
  const store = new Map<string, unknown>();
  const disabledHash = "reset-disabled-account-hash";
  const enabledHash = "reset-enabled-account-hash";
  const disabledKey = codexResetUsageKey(disabledHash);
  const enabledKey = codexResetUsageKey(enabledHash);
  const adjacentPrefixKey = ["uos_ai", "codex_instructions", "prompt-a"] as const;
  const transientKey = ["uos_ai", "auth", "sessions", "session-a"] as const;

  seedUnlimitedIncidentApiKey(store, { sharedOverrides: { paid_fallback_reservation_request_id: null } });
  await migrateKvReadIncidentV2(makeKvStub(store));

  const result = await importKvMigrationLines(
    makeKvStub(store),
    [
      entryLine(disabledKey, { enabled: false }),
      entryLine(enabledKey, { enabled: true }),
      entryLine(adjacentPrefixKey, { prompt: "keep" }),
      entryLine(transientKey, { token: "skip" }),
    ],
    { profile: "prod", includeCache: false, includeLegacy: false, overwrite: true, dryRun: false }
  );

  assert.equal(result.total, 4);
  assert.equal(result.imported, 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.groups.codex_reset_usage, 2);
  assert.equal(result.groups.codex_prompts, 1);
  assert.equal(result.groups.passkey_sessions, 1);

  // The explicit disable is a spend fence: it survives the migration path with its exact key and value.
  assert.deepEqual(store.get(keyToString(disabledKey)), { enabled: false });
  assert.deepEqual(store.get(keyToString(enabledKey)), { enabled: true });
  assert.deepEqual(store.get(keyToString(adjacentPrefixKey)), { prompt: "keep" });
  assert.equal(store.has(keyToString(transientKey)), false);

  assert.equal((await readCodexResetUsage(makeKvStub(store), disabledHash)).allowed, false);
  assert.equal((await readCodexResetUsage(makeKvStub(store), enabledHash)).allowed, true);

  const validation = await validateKvMigrationTarget(makeKvStub(store));
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.counts.codex_reset_usage, 2);
});

test("KV migration validation rejects malformed Codex reset usage rows", async () => {
  const store = new Map<string, unknown>();
  store.set(keyToString(["uos_ai", "codex_reset_usage", "bad_key"]), { enabled: false });
  store.set(keyToString(["uos_ai", "codex_reset_usage", "account", "v1", "bad_value"]), { enabled: "not_a_boolean" });
  store.set(keyToString(["uos_ai", "codex_reset_usage", "account", "v1", "valid_value"]), { enabled: true });

  const result = await validateKvMigrationTarget(makeKvStub(store));
  const resetErrors = result.errors.filter((error) => error.startsWith("codex reset usage"));

  assert.equal(result.counts.codex_reset_usage, 3);
  assert.equal(resetErrors.length, 2);
  assert.match(resetErrors.join("\n"), /codex reset usage key is malformed/);
  assert.match(resetErrors.join("\n"), /codex reset usage record is malformed/);
});
