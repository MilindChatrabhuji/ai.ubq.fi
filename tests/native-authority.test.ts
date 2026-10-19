import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { apiKeyHashKey } from "../src/api-keys.ts";
import { Database } from "bun:sqlite";
import { NativeAuthorityPaid } from "../src/authority/native-authority-paid.ts";
import * as nativePaid from "../src/authority/native-paid.ts";
import { NativeAuthority } from "../src/authority/native-authority.ts";
import { NativeAuthorityClient, NativeAuthorityRpcServer } from "../src/authority/native-authority-rpc.ts";
import { nativeKey } from "../src/authority/native-authority-sql.ts";
import { CODEX_AUTH_POOL_KV_KEY, CODEX_ACCOUNT_ROUTING_KV_KEY, CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY } from "../src/authority/native-codex-contracts.ts";
import { NativeAuthoritySql } from "../src/authority/native-authority-sql.ts";
import { NativeAuthorityApi } from "../src/authority/native-authority-api.ts";
import { NativeAuthorityKernel } from "../src/authority/native-authority-kernel.ts";
import type { NativeAuthorityInitial, NativeCapability, NativeReply, NativeSqlStorage } from "../src/authority/native-authority-contracts.ts";
import { kernelOrgPolicyKey, kernelOrgWindowKey, kernelOrgReservationKey, KERNEL_QUOTA_RESERVATION_RETENTION_MS } from "../src/authority/native-kernel.ts";
import { API_KEY_USAGE_V3_RETENTION_MS, planApiKeyUsageReservation, planApiKeyUsageReservedRelease } from "../src/authority/native-api-key.ts";

const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("required synthetic value absent");
  return value;
};
const now = 1_800_000_000_000;
const cap: NativeCapability = {
  id: "synthetic-inference",
  epoch: "epoch-one",
  principalId: "p",
  keyId: "key",
  tokenHash: "synthetic-hash",
  kernel: { owner: "org", repo: "repo" },
  roles: ["inference", "transport", "terminal", "billing", "reconcile", "quota_admin", "reset", "observer"],
  revoked: false,
};
const initial = (limit = 2, kernelLimit = 2): NativeAuthorityInitial => ({
  namespace: "synthetic-native-authority",
  epoch: cap.epoch,
  capabilities: [cap],
  keys: [
    {
      api: {
        token_hash: "synthetic-hash",
        key_id: "key",
        expires_at_ms: -1,
        usage_limit_requests: limit,
        window_ms: 3_600_000,
        window_start_ms: now - 1_000,
        usage_reset_at_ms: now + 3_599_000,
        policy_version: "v3:3600000",
        paid_fallback_enabled: true,
        paid_fallback_limit_microcredits: 100,
        paid_fallback_spent_microcredits: 0,
        paid_fallback_reserved_microcredits: 0,
        paid_fallback_reservation_request_id: null,
      },
      paid: { policyVersion: "3600000:1", quotaPerCredit: 100, modelExposure: { fixture: 40 }, eligibleModels: ["fixture"], allowUnrosteredUnlimited: false },
      revoked: false,
    },
  ],
  kernelPolicies: [],
  kernelDefaults: { limit: kernelLimit, windowMs: 3_600_000 },
  kernelConstants: { noUsageLimit: -1, noExpirationMs: -1 },
  pool: { identities: [], selectedAccountHashes: [], policies: {} },
  routing: null,
  active: null,
  capacity: { v: 1, observations: [] },
  owners: [],
  providerHops: [
    {
      id: "surplus-hop",
      publicProvider: "surplus",
      ledgerProvider: "surplus",
      billingCorrelation: "surplus_reservation",
      microcreditsPerCredit: 100,
      billingSuffix: "deepseek_waterfall:surplus",
      authorization: "direct",
    },
    {
      id: "openlux-hop",
      publicProvider: "openlux",
      ledgerProvider: "metered",
      billingCorrelation: "provider_request_id",
      microcreditsPerCredit: 100,
      billingSuffix: "deepseek_waterfall:openlux",
      authorization: "direct",
    },
  ],
  resetProofs: [],
});
const storage = (database: Database): NativeSqlStorage => ({
  sql: {
    exec(query, ...bindings) {
      const rows = database.query<Record<string, unknown>, (string | number | null)[]>(query).all(...bindings);
      return { toArray: () => rows };
    },
  },
  transactionSync<T>(callback: () => T): T {
    return database.transaction(callback)();
  },
});
const setup = (options = initial()) => {
  const db = new Database(":memory:");
  const sql = new NativeAuthoritySql(storage(db), options.namespace, options.epoch);
  sql.transaction(() => {
    sql.write("kernel_default", ["default", "kernel_policy_limit_requests"], options.kernelDefaults.limit);
    sql.write("kernel_default", ["default", "kernel_policy_window_ms"], options.kernelDefaults.windowMs);
    sql.write("authority_config", ["config"], { providerHops: options.providerHops });
    for (const key of options.keys) sql.write("api_policy", apiKeyHashKey(key.api.token_hash), key);
    for (const capability of options.capabilities) sql.write("capability", [capability.id], capability);
  });
  const api = new NativeAuthorityApi(sql);
  return { db, sql, api, kernel: new NativeAuthorityKernel(sql, api, options), options };
};
const reserve = (f: ReturnType<typeof setup>, id: string, time = now) =>
  f.sql.transaction(() => f.api.reserve(cap, { requestId: id, route: "/v1/responses", model: "fixture", stream: false }, time));
const handle = (reply: NativeReply): string => {
  if (!reply.handle) throw new Error("reservation handle absent: " + JSON.stringify(reply));
  return reply.handle;
};

test("native authority C1: twenty contenders share exact native API rows and never exceed policy", async () => {
  const f = setup();
  try {
    const other = new NativeAuthorityApi(new NativeAuthoritySql(storage(f.db), f.options.namespace, f.options.epoch));
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() =>
          f.sql.transaction(() =>
            (i % 2 ? other : f.api).reserve(
              cap,
              { requestId: `contention-${i}`, route: "/v1/responses", model: i % 2 ? "fixture" : "second-model", stream: false },
              now
            )
          )
        )
      )
    );
    expect(outcomes.filter((x) => x.kind === "reserved")).toHaveLength(2);
    expect(outcomes.filter((x) => x.kind === "full")).toHaveLength(18);
    const policy = f.options.keys[0].api;
    const expected = planApiKeyUsageReservation(policy, "contention-0", "/v1/responses", { request: null, window: null }, now);
    expect(expected.kind).toBe("write");
    const row = f.sql.page("api_window", now, "", 100)[0];
    expect(row.row.value?.reserved_requests).toBe(2);
    expect(row.row.expiresAtMs).toBe(policy.usage_reset_at_ms + API_KEY_USAGE_V3_RETENTION_MS);
    expect(f.sql.page("api_request", now, "", 100)).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("native authority C1: kernel refusal retains API reserve crash window until explicit compensation", () => {
  const f = setup(initial(3, 0));
  try {
    const admitted = handle(reserve(f, "kernel-refused"));
    expect(f.sql.transaction(() => f.kernel.reserve(cap, admitted, now)).kind).toBe("refused");
    const before = f.sql.page("api_request", now, "", 100)[0].row.value;
    expect(before?.state).toBe("reserved");
    const policy = f.api.request(cap, admitted, now).api;
    const window = f.sql.page("api_window", now, "", 100)[0].row.value;
    const expected = planApiKeyUsageReservedRelease(policy, "kernel-refused", "kernel_quota_refused", { request: before, window }, now + 1, "/v1/responses");
    expect(f.sql.transaction(() => f.api.release(cap, { handle: admitted, reason: "kernel_quota_refused" }, now + 1)).kind).toBe("released");
    expect(expected.kind).toBe("write");
    if (expected.kind === "write") expect(f.sql.page("api_request", now, "", 100)[0].row.value).toEqual(expected.request);
    expect(reserve(f, "kernel-refused", now + 2)).toMatchObject({ kind: "unavailable", detail: { reason: "identity_consumed" } });
    expect(f.sql.page("kernel_reservation", now, "", 100)).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("native authority C1: kernel native terminal intent survives reclaim; live reservations fence reset and delete", () => {
  const f = setup(initial(4, 1));
  try {
    expect(f.sql.transaction(() => f.kernel.policy(cap, { scope: "org", usageLimitRequests: 1, options: {} }, now))).toMatchObject({ kind: "written" });
    const admitted = handle(reserve(f, "kernel-terminal"));
    expect(f.sql.transaction(() => f.kernel.reserve(cap, admitted, now)).kind).toBe("reserved");
    expect(f.sql.transaction(() => f.kernel.policy(cap, { scope: "org", usageLimitRequests: 2, options: { resetUsage: true } }, now + 1)).kind).toBe(
      "conflict"
    );
    expect(f.sql.transaction(() => f.kernel.policy(cap, { scope: "org" }, now + 1))).toMatchObject({ kind: "conflict" });
    expect(f.sql.transaction(() => f.kernel.intent(cap, { handle: admitted, terminalState: "committed" }, now + 2)).kind).toBe("intent");
    expect(f.sql.transaction(() => f.kernel.reclaim(cap, { limit: 100 }, now + 300_003))).toMatchObject({ kind: "reclaimed", detail: { reclaimed: 1 } });
    const identity = required(f.api.request(cap, admitted, now).kernel);
    const reservation = f.sql.read("kernel_reservation", kernelOrgReservationKey("org", identity.windowCreatedAtMs, "kernel-terminal"), now).value;
    expect(reservation).toMatchObject({ state: "committed", terminal_intent: "committed" });
    expect(f.sql.read("kernel_window", kernelOrgWindowKey("org"), now).value).toMatchObject({ usage_requests: 1, reserved_requests: 0 });
    expect(f.sql.transaction(() => f.kernel.settle(cap, { handle: admitted, terminalState: "released", reason: "late-cancel" }, now + 300_004))).toMatchObject({
      kind: "unchanged",
      detail: "terminal_mismatch",
    });
    expect(
      f.sql.transaction(() => f.kernel.policy(cap, { scope: "org", usageLimitRequests: 4, options: { resetUsage: true, expiresAtMs: -1 } }, now + 300_005)).kind
    ).toBe("written");
    expect(f.sql.read("kernel_policy", kernelOrgPolicyKey("org"), now).expiresAtMs).toBeNull();
    expect(f.sql.read("kernel_window", kernelOrgWindowKey("org"), now).expiresAtMs).toBeNull();
    expect(f.sql.read("kernel_reservation", kernelOrgReservationKey("org", identity.windowCreatedAtMs, "kernel-terminal"), now).expiresAtMs).toBe(
      identity.windowCreatedAtMs + f.options.kernelDefaults.windowMs + KERNEL_QUOTA_RESERVATION_RETENTION_MS
    );
  } finally {
    f.db.close();
  }
});

test("native authority C1: synchronous failure rolls back all rows and revisions", () => {
  const f = setup();
  try {
    const baseline = f.db.query("SELECT sequence FROM uos_native_authority_meta").get();
    expect(() =>
      f.sql.transaction(() => {
        f.api.reserve(cap, { requestId: "rollback", route: "/v1/responses", model: "fixture", stream: false }, now);
        throw new Error("synthetic commit fault");
      })
    ).toThrow("synthetic commit fault");
    expect(f.sql.page("api_window", now, "", 100)).toHaveLength(0);
    expect(f.sql.page("request_lifetime", now, "", 100)).toHaveLength(0);
    expect(f.db.query("SELECT sequence FROM uos_native_authority_meta").get()).toEqual(baseline);
  } finally {
    f.db.close();
  }
});

test("native authority C1: no-expiration policy rolls windows using source identity and expired leases retain release history", () => {
  const f = setup(initial(1, 1));
  try {
    const first = handle(reserve(f, "lease"));
    expect(reserve(f, "after-expiry", now + 300_001).kind).toBe("reserved");
    expect(f.api.status(cap, first, now + 300_001)).toMatchObject({ detail: { api: { state: "released", release_reason: "reservation_lease_expired" } } });
    expect(reserve(f, "window-rollover", now + 3_600_000).kind).toBe("reserved");
    expect(f.sql.page("api_window", now + 3_600_000, "", 100)).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("native authority paid: distinct Surplus and public OpenLux hops retain independent native histories", () => {
  const f = setup(initial(-1, 5)),
    paid = new NativeAuthorityPaid(f.sql, f.api);
  try {
    const original = handle(reserve(f, "per-hop"));
    const left = f.sql.transaction(() => paid.reserve(cap, { handle: original, hopId: "surplus-hop" }, now));
    const right = f.sql.transaction(() => paid.reserve(cap, { handle: original, hopId: "openlux-hop" }, now));
    expect(left.attemptHandle).not.toBe(right.attemptHandle);
    const a = paid.attempt(cap, required(left.attemptHandle), now),
      b = paid.attempt(cap, required(right.attemptHandle), now);
    expect(a.billingRequestId).toBe("per-hop:deepseek_waterfall:surplus");
    expect(b.billingRequestId).toBe("per-hop:deepseek_waterfall:openlux");
    expect(f.sql.transaction(() => paid.release(cap, a.handle, now + 1)).kind).toBe("released");
    expect(
      f.sql.transaction(() =>
        paid.lifecycle(
          cap,
          { attemptHandle: b.handle, patch: { provider_request_id: "openlux-request", terminal_state: "completed" }, fetchStarted: true },
          now + 2
        )
      ).kind
    ).toBe("updated");
    const row = f.sql.read("paid_request", nativePaid.paidFallbackRequestV3Key("key", b.billingRequestId), now).value;
    expect(row).toMatchObject({
      provider: "metered",
      dispatch_state: "dispatched",
      terminal_state: "completed",
      billing_state: "pending",
      reconciliation_attempts: 1,
    });
    expect(() => f.sql.transaction(() => paid.release(cap, b.handle, now + 3))).toThrow("paid_fetch_may_have_started");
    expect(f.sql.read("paid_request", nativePaid.paidFallbackRequestV3Key("key", a.billingRequestId), now).value).toMatchObject({
      provider_request_id: null,
      dispatch_state: "not_dispatched",
      billing_state: "not_billed",
      spend_microcredits: 0,
    });
    expect(f.sql.page("paid_pending", now, "", 100)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("native authority paid: late zero billing settles once, preserves terminal-before-cancel and permanent rollups", () => {
  const f = setup(initial(-1, 5)),
    paid = new NativeAuthorityPaid(f.sql, f.api);
  try {
    const original = handle(reserve(f, "late-zero"));
    const admitted = f.sql.transaction(() => paid.reserve(cap, { handle: original, hopId: "openlux-hop" }, now));
    const attemptHandle = required(admitted.attemptHandle);
    f.sql.transaction(() =>
      paid.lifecycle(cap, { attemptHandle, patch: { provider_request_id: "provider-zero", terminal_state: "completed" }, fetchStarted: true }, now + 1)
    );
    f.sql.transaction(() => paid.lifecycle(cap, { attemptHandle, patch: { terminal_state: "cancelled" } }, now + 2));
    const log = { request_id: "provider-zero", quota: 0, prompt_tokens: 0, completion_tokens: 0, model: "fixture", created_at: now / 1000 };
    const settled = f.sql.transaction(() => paid.billing(cap, { attemptHandle, log }, now + 3));
    expect(settled).toMatchObject({
      kind: "settled",
      detail: { terminal_state: "completed", spend_microcredits: 0, input_tokens: 0, cached_input_tokens: null, output_tokens: 0, reconciliation_attempts: 1 },
    });
    expect(f.sql.transaction(() => paid.billing(cap, { attemptHandle, log }, now + 4)).kind).toBe("cleanup");
    const rollups = f.sql.page("paid_rollup", now, "", 100);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].row.value?.request_count).toBe(1);
    expect(rollups[0].row.expiresAtMs).toBeNull();
    expect(f.sql.transaction(() => paid.backfill(cap, { limit: 1 }, now + 5))).toMatchObject({ kind: "backfilled", detail: { folds: 0 } });
    expect(f.sql.page("paid_rollup", now, "", 100)[0].row.value?.request_count).toBe(1);
    expect(f.sql.transaction(() => paid.deletion(cap, now + 6)).kind).toBe("deleted");
    expect(f.sql.page("paid_deletion_guard", now, "", 100)[0].row.expiresAtMs).toBeNull();
    expect(f.sql.page("paid_rollup", now + 400 * 86400000, "", 100)).toHaveLength(1);
    expect(f.sql.transaction(() => paid.reserve(cap, { handle: handle(reserve(f, "deleted-key", now + 7)), hopId: "openlux-hop" }, now + 7))).toMatchObject({
      kind: "blocked",
      detail: "invalid_policy",
    });
  } finally {
    f.db.close();
  }
});

test("native authority paid: ambiguous intent retains exposure through deferred reconciliation and deletion guard", () => {
  const f = setup(initial(-1, 5)),
    paid = new NativeAuthorityPaid(f.sql, f.api);
  try {
    const original = handle(reserve(f, "pending-intent"));
    const admitted = f.sql.transaction(() => paid.reserve(cap, { handle: original, hopId: "surplus-hop" }, now));
    const attemptHandle = required(admitted.attemptHandle),
      attempt = paid.attempt(cap, attemptHandle, now);
    expect(f.sql.read("paid_request", nativePaid.paidFallbackRequestV3Key("key", attempt.billingRequestId), now).value).toMatchObject({
      dispatch_state: "dispatched",
      billing_state: "pending",
      input_tokens: null,
      spend_microcredits: null,
    });
    expect(f.sql.transaction(() => paid.deletion(cap, now + 1))).toMatchObject({ kind: "blocked", detail: { pending_requests: 1, pending_markers: 1 } });
    expect(f.sql.transaction(() => paid.defer(cap, attemptHandle, now + 86400001))).toMatchObject({
      kind: "write",
      detail: { request: { billing_state: "unresolved" } },
    });
    const claim = f.sql.transaction(() => paid.claim(cap, { limit: 1 }, now + 86405002));
    expect(claim.kind).toBe("claimed");
    expect(f.sql.read("paid_lease", nativePaid.paidFallbackReconciliationLeaseV3Key("key"), now + 86405002).expiresAtMs).toBe(now + 86465002);
    expect(f.sql.transaction(() => paid.finish(cap, required(claim.lease), now + 86405003)).kind).toBe("finished");
    expect(f.sql.page("paid_window", now + 86405003, "", 100)[0].row.value).toMatchObject({ reserved_microcredits: 40, pending_count: 1 });
    const row = f.sql.read("paid_request", nativePaid.paidFallbackRequestV3Key("key", attempt.billingRequestId), now + 86405003);
    expect(row.expiresAtMs).toBe(now + nativePaid.PAID_FALLBACK_REQUEST_LOG_RETENTION_MS);
  } finally {
    f.db.close();
  }
});

test("native authority paid: current H policy is re-read and bounded backfill cursors survive independent clients", () => {
  const f = setup(initial(-1, 5)),
    paid = new NativeAuthorityPaid(f.sql, f.api);
  try {
    const handles: string[] = [];
    for (let i = 0; i < 3; i++) {
      const original = handle(reserve(f, `h-${i}`));
      handles.push(original);
      const result = f.sql.transaction(() => paid.reserve(cap, { handle: original, hopId: "openlux-hop" }, now));
      expect(result.kind).toBe("reserved");
    }
    const first = f.sql.transaction(() => paid.backfill(cap, { limit: 1 }, now + 1));
    expect(typeof first.cursor).toBe("string");
    const other = new NativeAuthorityPaid(new NativeAuthoritySql(storage(f.db), f.options.namespace, f.options.epoch), f.api);
    expect(f.sql.transaction(() => other.backfill(cap, { limit: 1, cursor: required(first.cursor) }, now + 2))).toMatchObject({
      kind: "backfilled",
      detail: { scanned: 1 },
    });
    f.sql.transaction(() => {
      f.sql.write("api_policy", apiKeyHashKey(cap.tokenHash), { ...f.options.keys[0], api: { ...f.options.keys[0].api, paid_fallback_enabled: false } });
    });
    expect(f.sql.transaction(() => paid.reserve(cap, { handle: handles[0], hopId: "surplus-hop" }, now + 3))).toMatchObject({
      kind: "blocked",
      detail: "invalid_policy",
    });
    expect(() => f.sql.transaction(() => paid.backfill({ ...cap, id: "other-cap" }, { limit: 1, cursor: required(first.cursor) }, now + 4))).toThrow(
      "cursor_ownership_mismatch"
    );
  } finally {
    f.db.close();
  }
});

const withPool = (options = initial(-1, 10)): NativeAuthorityInitial => ({
  ...options,
  pool: {
    identities: [
      { slot: 0, accountIdHash: "a".repeat(64), credentialVersion: "c".repeat(64) },
      { slot: 1, accountIdHash: "b".repeat(64), credentialVersion: "d".repeat(64) },
    ],
    selectedAccountHashes: ["a".repeat(64), "b".repeat(64)],
    policies: {
      ["a".repeat(64)]: { modelUnavailable: null, overageUsageAllowed: false },
      ["b".repeat(64)]: { modelUnavailable: null, overageUsageAllowed: false },
    },
  },
  owners: ["a", "b"].map((id) => ({
    administrativeAccountLabelHash: `label-${id}`,
    routingAccountIdHash: id.repeat(64),
    credentialVersion: (id === "a" ? "c" : "d").repeat(64),
    nativeGenerationHash: `native-generation-${id}`,
    publicationRevision: `publication-${id}`,
    ownerId: `native-owner-${id}`,
    ownerEpoch: "owner-epoch",
    revoked: false,
    issuedAtMs: now - 1000,
    expiresAtMs: now + 3_600_000,
    nativeRefreshedAt: null,
  })),
});
const serviceFixture = (options = withPool()) => {
  const db = new Database(":memory:");
  let time = now;
  const authority = new NativeAuthority(storage(db), options, () => time);
  const sql = new NativeAuthoritySql(storage(db), options.namespace, options.epoch);
  const client = new NativeAuthorityClient(new NativeAuthorityRpcServer(authority, cap.id), cap.epoch);
  return {
    db,
    authority,
    sql,
    client,
    options,
    setTime: (value: number) => {
      time = value;
    },
  };
};
const clientReserve = async (f: ReturnType<typeof serviceFixture>, requestId: string) =>
  handle(await f.client.call("reserveApiUsage", { requestId, route: "/v1/responses", model: "fixture", stream: false }));

test("native authority C2: shared global active is sticky across principals, reorder, idle and restart", async () => {
  const options = withPool();
  const f = serviceFixture({ ...options, capabilities: [cap, { ...cap, id: "second-cap", principalId: "q" }] });
  try {
    const first = await clientReserve(f, "sticky-a");
    expect(await f.client.call("selectCodexAccount", { handle: first })).toMatchObject({ kind: "eligible", detail: { accountIdHash: "a".repeat(64) } });
    const original = required(f.sql.read("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, now).value);
    const reordered = {
      ...options.pool,
      identities: [
        { ...options.pool.identities[1], slot: 0 },
        { ...options.pool.identities[0], slot: 1 },
      ],
    };
    f.sql.transaction(() => {
      f.sql.write("codex_pool", CODEX_AUTH_POOL_KV_KEY, reordered);
    });
    const restarted = new NativeAuthority(storage(f.db), { ...options, pool: { ...options.pool, identities: [] } }, () => now + 100_000);
    const other = new NativeAuthorityClient(new NativeAuthorityRpcServer(restarted, "second-cap"), cap.epoch);
    const second = handle(await other.call("reserveApiUsage", { requestId: "sticky-b", route: "/v1/responses", model: "other-model", stream: false }));
    expect(await other.call("selectCodexAccount", { handle: second })).toMatchObject({
      kind: "eligible",
      detail: { accountIdHash: "a".repeat(64), slot: 1, activeGeneration: original.generation },
    });
    expect(f.sql.read("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, now).value?.account_id_hash).toBe("a".repeat(64));
    expect(f.sql.read("codex_pool", CODEX_AUTH_POOL_KV_KEY, now).value?.identities).toEqual(reordered.identities);
    await assert.rejects(other.call("readRequestStatus", { handle: first, limit: 1 }), /request_ownership_mismatch/);
  } finally {
    f.db.close();
  }
});

test("native authority C2: only full model-applicable native quota proof authorizes paid, transient429 does not", async () => {
  const source = withPool(),
    options = { ...source, providerHops: source.providerHops.map((hop) => ({ ...hop, authorization: "codex_unavailable" as const })) };
  const f = serviceFixture(options);
  try {
    let original = await clientReserve(f, "transient");
    await f.client.call("selectCodexAccount", { handle: original });
    const generic = await f.client.call("recordCodexAttemptSignal", {
      handle: original,
      signal: "quota",
      response: { status: 429, headers: [["retry-after", "3600"]], body: JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }) },
    });
    expect(generic).toMatchObject({ detail: { usageLimitReached: false } });
    original = await clientReserve(f, "still-a");
    expect(await f.client.call("selectCodexAccount", { handle: original })).toMatchObject({ kind: "eligible", detail: { accountIdHash: "a".repeat(64) } });
    expect(await f.client.call("reservePaidAttempt", { handle: original, hopId: "openlux-hop" })).toMatchObject({
      kind: "blocked",
      detail: "subscriptions_not_authoritatively_unavailable",
    });
    const response = {
      status: 429,
      headers: [] as [string, string][],
      body: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: Math.floor((now + 3_600_000) / 1000) } }),
    };
    expect(await f.client.call("recordCodexAttemptSignal", { handle: original, signal: "quota", response })).toMatchObject({
      detail: { usageLimitReached: true },
    });
    original = await clientReserve(f, "switch-b");
    expect(await f.client.call("selectCodexAccount", { handle: original })).toMatchObject({
      kind: "eligible",
      detail: { accountIdHash: "b".repeat(64), activeTransitionReason: "quota_exhausted" },
    });
    await f.client.call("recordCodexAttemptSignal", { handle: original, signal: "quota", response });
    original = await clientReserve(f, "all-blocked");
    expect(await f.client.call("selectCodexAccount", { handle: original })).toMatchObject({
      kind: "quota_blocked",
      detail: { fullCohortExhausted: true, fullCohortUnavailable: true },
    });
    expect(await f.client.call("reservePaidAttempt", { handle: original, hopId: "openlux-hop" })).toMatchObject({ kind: "reserved" });
    f.setTime(now + 3_600_001);
    expect(await f.client.call("reservePaidAttempt", { handle: original, hopId: "surplus-hop" })).toMatchObject({
      kind: "blocked",
      detail: "subscriptions_not_authoritatively_unavailable",
    });
  } finally {
    f.db.close();
  }
});

test("native authority service: lost acknowledgments replay durable receipts, conflicting commands and revocation fail closed", async () => {
  const f = serviceFixture();
  try {
    const args = { requestId: "lost-ack", route: "/v1/responses", model: "fixture", stream: false };
    const first = await f.client.call("reserveApiUsage", args, "same-operation");
    const sequence = f.db.query("SELECT sequence FROM uos_native_authority_meta").get();
    const restarted = new NativeAuthority(storage(f.db), f.options, () => now);
    const retry = new NativeAuthorityClient(new NativeAuthorityRpcServer(restarted, cap.id), cap.epoch);
    expect(await retry.call("reserveApiUsage", args, "same-operation")).toEqual(first);
    expect(f.db.query("SELECT sequence FROM uos_native_authority_meta").get()).toEqual(sequence);
    await assert.rejects(retry.call("reserveApiUsage", { ...args, model: "other" }, "same-operation"), /authority_operation_replay_conflict/);
    f.sql.transaction(() => {
      f.sql.write("capability", [cap.id], { ...cap, revoked: true });
    });
    await assert.rejects(retry.call("reserveApiUsage", args, "same-operation"), /capability_revoked_or_wrong_epoch/);
    expect(f.sql.page("api_request", now, "", 100)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("native authority service: owner epoch and opaque credential publication fence stale dispatch without inventing exhaustion", async () => {
  const f = serviceFixture();
  try {
    const original = await clientReserve(f, "owner-fence");
    await f.client.call("reserveKernelUsage", { handle: original });
    await f.client.call("selectCodexAccount", { handle: original });
    await f.client.call("refreshCodexAdmission", { handle: original }, "refresh-owned");
    const owner = required(f.sql.read("codex_owner", ["a".repeat(64)], now).value);
    f.sql.transaction(() => {
      f.sql.write("codex_owner", ["a".repeat(64)], { ...owner, ownerEpoch: "replacement-owner" });
    });
    await assert.rejects(f.client.call("markApiDispatch", { handle: original, provider: "chatgpt_codex" }), /codex_owner_fence_stale/);
    await assert.rejects(f.client.call("refreshCodexAdmission", { handle: original }, "refresh-owned"), /codex_owner_fence_stale/);
    const routing = required(f.sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now).value);
    expect(routing.slots[0].quota_blocked_until_ms).toBeNull();
    expect(routing.slots[0].invalid_credential_version).toBeNull();
  } finally {
    f.db.close();
  }
});

test("native authority service: closed RPC rejects generic operations, extra trust fields and cross-principal arguments", async () => {
  const f = serviceFixture();
  try {
    const rpc = new NativeAuthorityRpcServer(f.authority, cap.id);
    for (const method of ["get", "set", "list", "compareAndSwap", "seed", "snapshot", "publishAccess"]) {
      expect(await rpc.execute({ epoch: cap.epoch, operationId: method, method, args: {} })).toMatchObject({
        error: { code: "invalid_authority_operation", status: 400 },
      });
    }
    const args = { requestId: "bad", route: "/v1/responses", model: "fixture", stream: false };
    for (const field of ["namespace", "policyVersion", "policyCheck", "account", "credentialVersion", "providerUrl", "tokenHash", "principalId"]) {
      expect(await rpc.execute({ epoch: cap.epoch, operationId: field, method: "reserveApiUsage", args: { ...args, [field]: "forged" } })).toMatchObject({
        error: { code: "invalid_authority_arguments", status: 400 },
      });
    }
    expect(await rpc.execute({ epoch: "wrong", operationId: "wrong", method: "reserveApiUsage", args })).toMatchObject({
      error: { code: "authority_epoch_mismatch", status: 403 },
    });
    expect(
      await rpc.execute({ epoch: cap.epoch, operationId: "huge", method: "reserveApiUsage", args: { ...args, model: "x".repeat(100_000) } })
    ).toMatchObject({ error: { status: 400 } });
  } finally {
    f.db.close();
  }
});

test("native authority pagination uses exact pinned native tuple ordering including numeric width and restart boundary", () => {
  const values = [new Uint8Array([0, 255]), "2", "10", 2, 10, -0, 0, -10, -2, 2n, 10n, -2n, -10n, 0n, false, true] as const;
  const expected = [
    "0266697874757265000100ffff00",
    "026669787475726500023200",
    "02666978747572650002313000",
    "02666978747572650021c000000000000000",
    "02666978747572650021c024000000000000",
    "026669787475726500217fffffffffffffff",
    "026669787475726500218000000000000000",
    "026669787475726500213fdbffffffffffff",
    "026669787475726500213fffffffffffffff",
    "0266697874757265001502",
    "026669787475726500150a",
    "02666978747572650013fd",
    "02666978747572650013f5",
    "02666978747572650014",
    "02666978747572650026",
    "02666978747572650027",
  ];
  for (const [index, value] of values.entries()) expect(nativeKey(["fixture", value])).toBe(expected[index]);
  const f = setup();
  try {
    for (const start of [100, 10, 2])
      f.sql.transaction(() => {
        f.sql.write("kernel_window", ["window", start], {
          v: 2,
          scope: "org",
          owner: "org",
          usage_requests: 0,
          reserved_requests: 0,
          usage_reset_at_ms: start + 1,
          applied_window_ms: 1,
          created_at_ms: start,
          updated_at_ms: start,
        });
      });
    const first = f.sql.page("kernel_window", now, "", 1);
    expect(first[0].key).toEqual(["window", 2]);
    const restarted = new NativeAuthoritySql(storage(f.db), f.options.namespace, f.options.epoch);
    expect(restarted.page("kernel_window", now, first[0].encoded, 1)[0].key).toEqual(["window", 10]);
  } finally {
    f.db.close();
  }
});

test("native authority current defaults and cutover guard are read in each transaction", async () => {
  const f = serviceFixture();
  try {
    const first = await clientReserve(f, "default-first");
    expect(await f.client.call("reserveKernelUsage", { handle: first })).toMatchObject({ kind: "reserved" });
    f.sql.transaction(() => {
      f.sql.write("kernel_default", ["default", "kernel_policy_limit_requests"], 0);
    });
    const second = await clientReserve(f, "default-changed");
    expect(await f.client.call("reserveKernelUsage", { handle: second })).toMatchObject({ kind: "refused", detail: { status: 429 } });
    f.sql.transaction(() => {
      f.sql.write("kernel_default", ["default", "kernel_policy_limit_requests"], 20);
    });
    expect(await f.client.call("acquireKernelDefaultCutover", {})).toMatchObject({ kind: "acquire" });
    expect(await f.client.call("reserveKernelUsage", { handle: second })).toMatchObject({ kind: "refused", detail: { status: 503 } });
  } finally {
    f.db.close();
  }
});

test("native authority refresh preserves active identity through opaque credential and publication changes", async () => {
  const f = serviceFixture();
  try {
    const original = await clientReserve(f, "same-account-refresh");
    await f.client.call("selectCodexAccount", { handle: original });
    const active = required(f.sql.read("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, now).value);
    const owner = required(f.sql.read("codex_owner", ["a".repeat(64)], now).value);
    const credentialVersion = "e".repeat(64);
    f.sql.transaction(() => {
      f.sql.write("codex_pool", CODEX_AUTH_POOL_KV_KEY, {
        ...f.options.pool,
        identities: f.options.pool.identities.map((identity) => (identity.slot === 0 ? { ...identity, credentialVersion } : identity)),
      });
      f.sql.write("codex_owner", ["a".repeat(64)], {
        ...owner,
        credentialVersion,
        nativeGenerationHash: "f".repeat(64),
        publicationRevision: "publication-next",
      });
    });
    expect(await f.client.call("refreshCodexAdmission", { handle: original })).toMatchObject({
      kind: "current",
      detail: { accountIdHash: "a".repeat(64), credentialVersion, activeGeneration: active.generation },
    });
    expect(await f.client.call("markApiDispatch", { handle: original, provider: "chatgpt_codex" })).toMatchObject({ kind: "dispatched" });
  } finally {
    f.db.close();
  }
});

test("native authority reset election requires current full quota cohort and consumes only the trusted proof", async () => {
  const f = serviceFixture();
  try {
    const response = {
      status: 429,
      headers: [] as [string, string][],
      body: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: Math.floor((now + 3_600_000) / 1000) } }),
    };
    for (const requestId of ["reset-a", "reset-b"]) {
      const original = await clientReserve(f, requestId);
      await f.client.call("selectCodexAccount", { handle: original });
      await f.client.call("recordCodexAttemptSignal", { handle: original, signal: "quota", response });
    }
    const original = await clientReserve(f, "reset-election");
    await f.client.call("selectCodexAccount", { handle: original });
    const selection = required(f.sql.read("request_lifetime", [original], now).value).selection;
    if (selection?.kind !== "quota_blocked") throw new Error("expected source quota cohort");
    const account = required(selection.blockedAccounts.at(0));
    f.sql.transaction(() => {
      f.sql.write("codex_reset", ["trusted-reset"], {
        id: "trusted-reset",
        account,
        quotaResetAtMs: account.quotaResetAtMs,
        routingGeneration: account.routingGeneration,
        activeSnapshot: f.sql.read("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, now).value,
        poolRevision: required(f.sql.read("codex_pool", CODEX_AUTH_POOL_KV_KEY, now).revision),
        capacityRevision: f.sql.read("codex_capacity", ["uos_ai", "codex_capacity_routing", "v1", "observations"], now).revision,
        verified: true,
      });
    });
    const elected = await f.client.call("electCodexResetProbe", { handle: original, proofId: "trusted-reset" }, "reset-once");
    expect(elected).toMatchObject({ kind: "probe_elected" });
    expect(await f.client.call("electCodexResetProbe", { handle: original, proofId: "trusted-reset" }, "reset-once")).toEqual(elected);
    expect(await f.client.call("electCodexResetProbe", { handle: original, proofId: "trusted-reset" })).toMatchObject({
      kind: "refused",
      detail: "reset_proof_unavailable",
    });
    expect(await f.client.call("refreshCodexAdmission", { handle: original })).toMatchObject({ kind: "current" });
  } finally {
    f.db.close();
  }
});

test("native authority model entitlements are request-specific and never become quota exhaustion", async () => {
  const source = withPool();
  const model = "entitled-only-b";
  const f = serviceFixture({
    ...source,
    pool: {
      ...source.pool,
      modelPolicies: {
        [model]: {
          ...source.pool.policies,
          ["a".repeat(64)]: { modelUnavailable: { detail: "source account catalog excludes this model" }, overageUsageAllowed: false },
        },
      },
    },
  });
  try {
    const first = await clientReserve(f, "ordinary-model");
    expect(await f.client.call("selectCodexAccount", { handle: first })).toMatchObject({ kind: "eligible", detail: { accountIdHash: "a".repeat(64) } });
    const request = handle(await f.client.call("reserveApiUsage", { requestId: "different-entitlement", route: "/v1/responses", model, stream: false }));
    expect(await f.client.call("selectCodexAccount", { handle: request })).toMatchObject({
      kind: "eligible",
      detail: { accountIdHash: "b".repeat(64), activeTransitionReason: "model_unavailable" },
    });
    const ordinary = await clientReserve(f, "ordinary-after-model-switch");
    expect(await f.client.call("selectCodexAccount", { handle: ordinary })).toMatchObject({ kind: "eligible", detail: { accountIdHash: "b".repeat(64) } });
    const routing = required(f.sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now).value);
    expect(routing.slots.every((slot) => slot.quota_blocked_until_ms === null && slot.invalid_credential_version === null)).toBe(true);
  } finally {
    f.db.close();
  }
});

test("native authority paid rollup collisions retain both requests and cannot backfill twice", () => {
  const f = setup(initial(-1, 5));
  const paid = new NativeAuthorityPaid(f.sql, f.api);
  const shards = new Map<number, string>();
  let pair: string[] = [];
  for (let index = 0; index < 100; index++) {
    const requestId = `collision-${index}`;
    const shard = nativePaid.paidFallbackUsageRollupShard(`${requestId}:deepseek_waterfall:openlux`);
    const previous = shards.get(shard);
    if (previous) {
      pair = [previous, requestId];
      break;
    }
    shards.set(shard, requestId);
  }
  try {
    expect(pair).toHaveLength(2);
    for (const [index, requestId] of pair.entries()) {
      const original = handle(reserve(f, requestId));
      const admitted = f.sql.transaction(() => paid.reserve(cap, { handle: original, hopId: "openlux-hop" }, now));
      const attemptHandle = required(admitted.attemptHandle);
      const providerRequestId = `provider-${requestId}`;
      f.sql.transaction(() => paid.lifecycle(cap, { attemptHandle, patch: { provider_request_id: providerRequestId, terminal_state: "completed" } }, now));
      const log = { request_id: providerRequestId, quota: index ? 11 : 7, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: now / 1000 };
      expect(f.sql.transaction(() => paid.billing(cap, { attemptHandle, log }, now))).toMatchObject({ kind: "settled" });
    }
    const rollups = f.sql.page("paid_rollup", now, "", 100);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].row.value).toMatchObject({ request_count: 2, spend_microcredits: 18 });
    expect(f.sql.transaction(() => paid.backfill(cap, { limit: 100 }, now + 1))).toMatchObject({ kind: "backfilled", detail: { folds: 0 } });
    expect(f.sql.page("paid_rollup", now, "", 100)[0].row.value?.request_count).toBe(2);
  } finally {
    f.db.close();
  }
});

const reviewPaid = async (f: ReturnType<typeof serviceFixture>, id: string) => {
  const requestHandle = await clientReserve(f, id);
  const reply = await f.client.call("reservePaidAttempt", { handle: requestHandle, hopId: "openlux-hop" });
  expect(reply.kind).toBe("reserved");
  return { requestHandle, attemptHandle: required(reply.attemptHandle) };
};
const reviewTrace = (f: ReturnType<typeof serviceFixture>, finding: string, time = now) => {
  console.log(
    JSON.stringify({
      finding,
      api: f.sql.page("api_window", time, "", 100),
      kernel: f.sql.page("kernel_reservation", time, "", 100),
      paid: f.sql.page("paid_request", time, "", 100),
      attempts: f.sql.page("attempt_lifetime", time, "", 100),
      pending: f.sql.page("paid_pending", time, "", 100),
    })
  );
};
const reviewRotate = (f: ReturnType<typeof serviceFixture>, credentialVersion: string) => {
  const pool = required(f.sql.read("codex_pool", CODEX_AUTH_POOL_KV_KEY, now).value);
  const owner = required(f.sql.read("codex_owner", ["a".repeat(64)], now).value);
  f.sql.transaction(() => {
    f.sql.write("codex_pool", CODEX_AUTH_POOL_KV_KEY, {
      ...pool,
      identities: pool.identities.map((identity) => (identity.slot === 0 ? { ...identity, credentialVersion } : identity)),
    });
    f.sql.write("codex_owner", ["a".repeat(64)], {
      ...owner,
      credentialVersion,
      nativeGenerationHash: "generation-" + credentialVersion,
      publicationRevision: "publication-" + credentialVersion,
    });
  });
};
const reviewResetProof = async (f: ReturnType<typeof serviceFixture>) => {
  const response = {
    status: 429,
    headers: [] as [string, string][],
    body: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: (now + 3_600_000) / 1000 } }),
  };
  for (const id of ["proof-a", "proof-b"]) {
    const handle = await clientReserve(f, id);
    expect((await f.client.call("selectCodexAccount", { handle })).kind).toBe("eligible");
    await f.client.call("recordCodexAttemptSignal", { handle, signal: "quota", response });
  }
  const handle = await clientReserve(f, "proof-blocked");
  expect((await f.client.call("selectCodexAccount", { handle })).kind).toBe("quota_blocked");
  const selection = required(f.sql.read("request_lifetime", [handle], now).value).selection;
  if (selection?.kind !== "quota_blocked") throw new Error("native quota cohort missing");
  const account = required(selection.blockedAccounts.at(0));
  f.sql.transaction(() => {
    f.sql.write("codex_reset", ["review-proof"], {
      id: "review-proof",
      account,
      quotaResetAtMs: account.quotaResetAtMs,
      routingGeneration: account.routingGeneration,
      activeSnapshot: f.sql.read("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, now).value,
      poolRevision: required(f.sql.read("codex_pool", CODEX_AUTH_POOL_KV_KEY, now).revision),
      capacityRevision: f.sql.read("codex_capacity", ["uos_ai", "codex_capacity_routing", "v1", "observations"], now).revision,
      verified: true,
    });
  });
  return handle;
};

test("review F01 paid provider terminal forbids compensation without optional flags", async () => {
  const f = serviceFixture();
  try {
    const attempt = await reviewPaid(f, "terminal-release");
    expect((await f.client.call("recordPaidAttemptLifecycle", { attemptHandle: attempt.attemptHandle, patch: { terminal_state: "completed" } })).kind).toBe(
      "updated"
    );
    const outcome = await Promise.allSettled([f.client.call("releasePaidBeforeFetch", { attemptHandle: attempt.attemptHandle })]);
    reviewTrace(f, "F01");
    expect(f.sql.page("paid_request", now, "", 100)[0].row.value).toMatchObject({ terminal_state: "completed", billing_state: "pending" });
    expect(outcome[0].status).toBe("rejected");
    expect(f.sql.page("paid_window", now, "", 100)[0].row.value?.reserved_microcredits).toBe(40);
    await f.client.call("recordPaidAttemptLifecycle", { attemptHandle: attempt.attemptHandle, patch: { provider_request_id: "late-after-terminal" } });
    const log = { request_id: "late-after-terminal", quota: 9, prompt_tokens: 1, completion_tokens: 1, model: "fixture", created_at: now / 1000 };
    expect(await f.client.call("recordVerifiedPaidBilling", { attemptHandle: attempt.attemptHandle, log })).toMatchObject({ kind: "settled" });
    expect(f.sql.page("paid_window", now, "", 100)[0].row.value).toMatchObject({ settled_microcredits: 9, reserved_microcredits: 0 });
  } finally {
    f.db.close();
  }
});

test("review F02 nonpaid positive evidence and durable start fence API compensation", async () => {
  for (const evidence of ["terminal", "delivery", "start", "provider"] as const) {
    const f = serviceFixture();
    try {
      const handle = await clientReserve(f, "nonpaid-" + evidence);
      const provider = evidence === "provider" ? "chatgpt_codex" : "lithos";
      if (evidence === "provider") expect((await f.client.call("selectCodexAccount", { handle })).kind).toBe("eligible");
      expect((await f.client.call("markApiDispatch", { handle, provider })).kind).toBe("dispatched");
      if (evidence === "provider") await f.client.call("recordCodexAttemptSignal", { handle, signal: "success" });
      if (evidence === "terminal") await f.client.call("recordSemanticTerminal", { handle, outcome: "completed" });
      if (evidence === "delivery") await f.client.call("recordDeliveryObservation", { handle, observation: "delivered" });
      if (evidence === "start") {
        const rpc = new NativeAuthorityRpcServer(f.authority, cap.id);
        expect(
          await rpc.execute({ epoch: cap.epoch, operationId: "start", method: "recordTransportStarted", args: { handle, provider: "lithos" } })
        ).toMatchObject({ result: { kind: "started" } });
        const paid = await f.client.call("reservePaidAttempt", { handle, hopId: "openlux-hop" });
        expect(paid.kind).toBe("reserved");
        await f.client.call("recordPaidAttemptLifecycle", { attemptHandle: required(paid.attemptHandle), patch: { provider_request_id: "another-response" } });
        expect(
          await rpc.execute({ epoch: cap.epoch, operationId: "start-repeat", method: "recordTransportStarted", args: { handle, provider: "lithos" } })
        ).toMatchObject({ result: { kind: "unchanged", detail: { provider: "lithos", attemptHandle: null } } });
      }
      const outcome = await Promise.allSettled([f.client.call("recordApiDispatchCancellation", { handle })]);
      reviewTrace(f, "F02-" + evidence);
      expect(f.sql.page("api_window", now, "", 100)[0].row.value?.committed_requests).toBe(1);
      expect(outcome[0].status).toBe("rejected");
    } finally {
      f.db.close();
    }
  }
});

test("review F03 Codex dispatch requires an admitted subscription", async () => {
  const f = serviceFixture();
  try {
    const handle = await clientReserve(f, "no-codex-admission");
    const outcome = await Promise.allSettled([f.client.call("markApiDispatch", { handle, provider: "chatgpt_codex" })]);
    reviewTrace(f, "F03");
    expect(f.sql.page("api_window", now, "", 100)[0].row.value).toMatchObject({ committed_requests: 0, reserved_requests: 1 });
    expect(outcome[0].status).toBe("rejected");
  } finally {
    f.db.close();
  }
});

test("review F04 compensated API dispatch receipt cannot authorize dispatch again", async () => {
  const f = serviceFixture();
  try {
    const handle = await clientReserve(f, "compensated");
    expect((await f.client.call("markApiDispatch", { handle, provider: "lithos" }, "dispatch-receipt")).kind).toBe("dispatched");
    expect((await f.client.call("recordApiDispatchCancellation", { handle })).kind).toBe("released");
    const replay = await Promise.allSettled([f.client.call("markApiDispatch", { handle, provider: "lithos" }, "dispatch-receipt")]);
    reviewTrace(f, "F04");
    expect(f.sql.page("api_window", now, "", 100)[0].row.value?.committed_requests).toBe(0);
    expect(f.sql.page("api_request", now, "", 100)[0].row.value?.state).toBe("released");
    expect(replay[0].status).toBe("rejected");
  } finally {
    f.db.close();
  }
});

test("review F05 refresh receipt validates its own immutable credential and owner fences", async () => {
  const f = serviceFixture();
  try {
    const handle = await clientReserve(f, "own-refresh-receipt");
    expect((await f.client.call("selectCodexAccount", { handle })).kind).toBe("eligible");
    expect((await f.client.call("refreshCodexAdmission", { handle }, "refresh-C1")).kind).toBe("current");
    reviewRotate(f, "e".repeat(64));
    expect((await f.client.call("refreshCodexAdmission", { handle }, "refresh-C2")).kind).toBe("current");
    const replay = await Promise.allSettled([f.client.call("refreshCodexAdmission", { handle }, "refresh-C1")]);
    reviewTrace(f, "F05");
    expect(required(f.sql.read("request_lifetime", [handle], now).value).codex?.credentialVersion).toBe("e".repeat(64));
    expect(replay[0].status).toBe("rejected");
  } finally {
    f.db.close();
  }
});

test("review F06 current invalid credential blocks dispatch and cached refresh without generation change", async () => {
  const f = serviceFixture();
  try {
    const handle = await clientReserve(f, "current-invalid");
    expect((await f.client.call("selectCodexAccount", { handle })).kind).toBe("eligible");
    await f.client.call("refreshCodexAdmission", { handle }, "invalid-refresh");
    const generation = required(f.sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now).value).slots[0].generation;
    expect((await f.client.call("recordCodexAttemptSignal", { handle, signal: "credential_invalid" })).kind).toBe("recorded");
    const outcomes = await Promise.allSettled([
      f.client.call("markApiDispatch", { handle, provider: "chatgpt_codex" }),
      f.client.call("refreshCodexAdmission", { handle }, "invalid-refresh"),
    ]);
    reviewTrace(f, "F06");
    expect(required(f.sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now).value).slots[0].generation).toBe(generation);
    expect(f.sql.page("api_window", now, "", 100)[0].row.value?.committed_requests).toBe(0);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
  } finally {
    f.db.close();
  }
});

test("review F07 restarted reconciler claims usable persisted attempt handles", async () => {
  const f = serviceFixture();
  try {
    await reviewPaid(f, "claimable");
    const restarted = new NativeAuthority(storage(f.db), f.options, () => now);
    const client = new NativeAuthorityClient(new NativeAuthorityRpcServer(restarted, cap.id), cap.epoch);
    const claim = await client.call("claimPaidReconciliation", { limit: 10 });
    expect(claim.kind).toBe("claimed");
    reviewTrace(f, "F07");
    const item: unknown = Array.isArray(claim.detail) ? claim.detail[0] : null;
    expect(item).toHaveProperty("attemptHandle");
    if (item === null || typeof item !== "object" || !("attemptHandle" in item) || typeof item.attemptHandle !== "string")
      throw new Error("claim handle absent");
    expect((await client.call("deferPaidReconciliation", { attemptHandle: item.attemptHandle })).kind).toBe("write");
    expect(f.sql.page("paid_pending", now, "", 100)[0].row.value?.next_reconciliation_at_ms).toBeGreaterThan(now);
  } finally {
    f.db.close();
  }
});

test("review F08 same-account credential refresh adopts the transferred native probe lease", async () => {
  const source = withPool();
  const f = serviceFixture({ ...source, pool: { ...source.pool, identities: [source.pool.identities[0]], selectedAccountHashes: ["a".repeat(64)] } });
  try {
    const first = await clientReserve(f, "probe-block");
    await f.client.call("selectCodexAccount", { handle: first });
    await f.client.call("recordCodexAttemptSignal", {
      handle: first,
      signal: "quota",
      response: { status: 429, headers: [], body: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: (now + 1000) / 1000 } }) },
    });
    f.setTime(now + 1001);
    const handle = await clientReserve(f, "owned-probe");
    expect((await f.client.call("selectCodexAccount", { handle })).kind).toBe("eligible");
    const before = required(required(f.sql.read("request_lifetime", [handle], now).value).codex);
    expect(before.probeToken).toEqual(expect.any(String));
    reviewRotate(f, "e".repeat(64));
    expect((await f.client.call("refreshCodexAdmission", { handle })).kind).toBe("current");
    const after = required(required(f.sql.read("request_lifetime", [handle], now).value).codex);
    reviewTrace(f, "F08");
    expect(after.probeToken).toBe(before.probeToken);
    expect(after.probeGeneration).toBe(required(after.routingGeneration));
    expect((await f.client.call("markApiDispatch", { handle, provider: "chatgpt_codex" })).kind).toBe("dispatched");
    expect((await f.client.call("releaseCodexProbe", { handle })).kind).toBe("released");
  } finally {
    f.db.close();
  }
});

test("review F09 reset proof cannot cross native quota classes but permits proven standard aliases", async () => {
  const f = serviceFixture();
  try {
    await reviewResetProof(f);
    const reserve = handle(await f.client.call("reserveApiUsage", { requestId: "reserve-model", route: "/v1/responses", model: "gpt-reserve", stream: false }));
    const before = f.sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now);
    const rejected = await f.client.call("electCodexResetProbe", { handle: reserve, proofId: "review-proof" });
    reviewTrace(f, "F09");
    expect(rejected.kind).toBe("refused");
    expect(f.sql.read("codex_reset", ["review-proof"], now).value?.verified).toBe(true);
    expect(f.sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now)).toEqual(before);
    const alias = handle(
      await f.client.call("reserveApiUsage", { requestId: "standard-alias", route: "/v1/responses", model: "another-standard", stream: false })
    );
    expect((await f.client.call("electCodexResetProbe", { handle: alias, proofId: "review-proof" })).kind).toBe("probe_elected");
    expect(required(f.sql.read("request_lifetime", [alias], now).value).codex?.requestedModel).toBe("another-standard");
  } finally {
    f.db.close();
  }
});

test("review F10 paid response usage is separate from first Codex API dispatch", async () => {
  const f = serviceFixture();
  try {
    const handle = await clientReserve(f, "responding-paid");
    await f.client.call("selectCodexAccount", { handle });
    expect((await f.client.call("markApiDispatch", { handle, provider: "chatgpt_codex" })).kind).toBe("dispatched");
    const admitted = await f.client.call("reservePaidAttempt", { handle, hopId: "openlux-hop" });
    expect(admitted.kind).toBe("reserved");
    const attemptHandle = required(admitted.attemptHandle);
    expect((await f.client.call("markApiDispatch", { handle, provider: "metered" })).kind).toBe("already_dispatched");
    await f.client.call("recordPaidAttemptLifecycle", { attemptHandle, patch: { provider_request_id: "paid-response", terminal_state: "completed" } });
    await f.client.call("recordSemanticTerminal", { handle, outcome: "completed", usage: { input_tokens: 3, cached_input_tokens: null, output_tokens: 2 } });
    const log = { request_id: "paid-response", quota: 7, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: now / 1000 };
    expect((await f.client.call("recordVerifiedPaidBilling", { attemptHandle, log })).kind).toBe("settled");
    reviewTrace(f, "F10");
    const rollups = f.sql.page("paid_rollup", now, "", 100);
    expect(rollups).toHaveLength(1);
    expect(rollups[0].row.value).toMatchObject({ provider: "metered", request_count: 1, input_tokens: 3, output_tokens: 2 });
  } finally {
    f.db.close();
  }
});

test("review F11 provider terminal expedites pending marker and versions reconciliation gate", async () => {
  const f = serviceFixture();
  try {
    const attempt = await reviewPaid(f, "terminal-expedite");
    expect((await f.client.call("deferPaidReconciliation", { attemptHandle: attempt.attemptHandle })).kind).toBe("write");
    const gate = f.sql.read("paid_gate", nativePaid.paidFallbackReconciliationGateV3Key(), now).revision;
    f.setTime(now + 1);
    await f.client.call("recordPaidAttemptLifecycle", { attemptHandle: attempt.attemptHandle, patch: { terminal_state: "completed" } });
    reviewTrace(f, "F11");
    expect(f.sql.page("paid_pending", now + 1, "", 100)[0].row.value?.next_reconciliation_at_ms).toBe(now + 1);
    expect(f.sql.read("paid_gate", nativePaid.paidFallbackReconciliationGateV3Key(), now + 1).revision).not.toBe(gate);
    expect(await f.client.call("claimPaidReconciliation", { limit: 10 })).toMatchObject({
      kind: "claimed",
      detail: [{ attemptHandle: attempt.attemptHandle }],
    });
  } finally {
    f.db.close();
  }
});

test("review F12 window rollover cannot replace one request's original kernel binding", async () => {
  const f = serviceFixture();
  try {
    const handle = await clientReserve(f, "kernel-lifetime");
    expect((await f.client.call("reserveKernelUsage", { handle })).kind).toBe("reserved");
    const original = required(f.sql.read("request_lifetime", [handle], now).value).kernel;
    f.setTime(now + 3_600_001);
    const replay = await f.client.call("reserveKernelUsage", { handle });
    reviewTrace(f, "F12", now + 3_600_001);
    expect(required(f.sql.read("request_lifetime", [handle], now).value).kernel).toEqual(original);
    expect(f.sql.page("kernel_reservation", now + 3_600_001, "", 100)).toHaveLength(1);
    expect(replay.kind).toBe("refused");
    expect((await f.client.call("settleKernelUsage", { handle, terminalState: "committed", reason: "late original terminal" })).kind).toBe("settle");
  } finally {
    f.db.close();
  }
});

test("review F13 retention-expired paid history cannot recreate a permanent logical attempt", async () => {
  const f = serviceFixture();
  try {
    const attempt = await reviewPaid(f, "retention-tombstone");
    const before = f.sql.page("paid_window", now, "", 100)[0].row.value;
    const future = now + nativePaid.PAID_FALLBACK_REQUEST_LOG_RETENTION_MS + 1;
    f.setTime(future);
    const replay = await f.client.call("reservePaidAttempt", { handle: attempt.requestHandle, hopId: "openlux-hop" });
    reviewTrace(f, "F13", future);
    expect(replay.kind).toBe("blocked");
    expect(f.sql.page("attempt_lifetime", future, "", 100)).toHaveLength(1);
    expect(f.sql.page("paid_request", future, "", 100)).toHaveLength(0);
    expect(f.sql.page("paid_window", future, "", 100)[0].row.value).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("round2 R1 paid transport replay rechecks terminal and settlement states without rewriting history", async () => {
  for (const state of ["completed", "failed", "cancelled", "settled-pending", "settled-completed", "unresolved"] as const) {
    const f = serviceFixture();
    try {
      const attempt = await reviewPaid(f, "transport-" + state);
      const args = { handle: attempt.requestHandle, provider: "metered" as const, attemptHandle: attempt.attemptHandle };
      await f.client.call("markApiDispatch", { handle: attempt.requestHandle, provider: "metered" });
      expect((await f.client.call("recordTransportStarted", args, "start-paid")).kind).toBe("started");
      const active = f.sql.page("attempt_lifetime", now, "", 100);
      expect((await f.client.call("recordTransportStarted", args, "start-paid")).kind).toBe("started");
      expect(f.sql.page("attempt_lifetime", now, "", 100)).toEqual(active);
      const settled = state.startsWith("settled");
      const observedAt = state === "unresolved" ? now + 86_400_001 : now;
      if (state === "unresolved") {
        f.setTime(observedAt);
        expect((await f.client.call("deferPaidReconciliation", { attemptHandle: attempt.attemptHandle })).kind).toBe("write");
        expect(f.sql.page("paid_request", observedAt, "", 100)[0].row.value?.billing_state).toBe("unresolved");
      } else {
        await f.client.call("recordPaidAttemptLifecycle", {
          attemptHandle: attempt.attemptHandle,
          patch: settled
            ? { provider_request_id: "settled-transport", ...(state === "settled-completed" ? { terminal_state: "completed" as const } : {}) }
            : { terminal_state: state as "completed" | "failed" | "cancelled" },
        });
      }
      if (settled) {
        const log = { request_id: "settled-transport", quota: 7, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: now / 1000 };
        expect((await f.client.call("recordVerifiedPaidBilling", { attemptHandle: attempt.attemptHandle, log })).kind).toBe("settled");
      }
      const before = ["paid_request", "paid_window", "request_lifetime", "attempt_lifetime"] as const;
      const snapshot = before.map((table) => f.sql.page(table, observedAt, "", 100));
      const restarted = new NativeAuthority(storage(f.db), f.options, () => observedAt);
      const client = new NativeAuthorityClient(new NativeAuthorityRpcServer(restarted, cap.id), cap.epoch);
      const outcomes = await Promise.allSettled([
        client.call("recordTransportStarted", args, "start-paid"),
        client.call("recordTransportStarted", args, "fresh-paid"),
      ]);
      reviewTrace(f, "R2-1-" + state);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      expect(before.map((table) => f.sql.page(table, observedAt, "", 100))).toEqual(snapshot);
      expect(required(f.sql.read("request_lifetime", [attempt.requestHandle], now).value).semantic).toBeNull();
      expect((await client.call("readRequestStatus", { handle: attempt.requestHandle, limit: 10 })).kind).toBe("status");
    } finally {
      f.db.close();
    }
  }
});

const round2MixedAttempts = async (f: ReturnType<typeof serviceFixture>, other: NativeAuthorityClient, foreignIndex: number) => {
  const attempts: string[] = [];
  const pages: string[][] = [];
  for (const index of [0, 1, 2]) {
    const client = index === foreignIndex ? other : f.client;
    const requestHandle = handle(
      await client.call("reserveApiUsage", { requestId: "claim-" + String(index), route: "/v1/responses", model: "fixture", stream: false })
    );
    const attempt = required((await client.call("reservePaidAttempt", { handle: requestHandle, hopId: "openlux-hop" })).attemptHandle);
    attempts.push(attempt);
    pages.push(index === foreignIndex ? [] : [attempt]);
  }
  return { own: pages.flat(), foreignHandle: attempts[foreignIndex], pages };
};
const round2ClaimPage = async (f: ReturnType<typeof serviceFixture>, other: NativeAuthorityClient, cursor: string | undefined, expected: string[]) => {
  const restarted = new NativeAuthority(storage(f.db), f.options, () => now);
  const client = new NativeAuthorityClient(new NativeAuthorityRpcServer(restarted, cap.id), cap.epoch);
  const claim = await client.call("claimPaidReconciliation", { limit: 1, ...(cursor ? { cursor } : {}) });
  expect(claim.kind).toBe("claimed");
  expect((await client.call("claimPaidReconciliation", { limit: 1 })).kind).toBe("leased");
  expect(claim.detail).toMatchObject(expected.map((attemptHandle) => ({ attemptHandle })));
  expect(Array.isArray(claim.detail) ? claim.detail.length : -1).toBe(expected.length);
  for (const attemptHandle of expected) expect((await client.call("deferPaidReconciliation", { attemptHandle })).kind).toBe("write");
  if (claim.cursor) expect((await other.call("claimPaidReconciliation", { limit: 1, cursor: claim.cursor })).kind).toBe("leased");
  await client.call("finishPaidReconciliation", { lease: required(claim.lease) });
  if (claim.cursor) {
    const unauthorized = await Promise.allSettled([other.call("claimPaidReconciliation", { limit: 1, cursor: claim.cursor })]);
    expect(unauthorized[0].status).toBe("rejected");
  }
  return claim.cursor ?? undefined;
};
test("round2 R2 shared-key mixed-principal pages retain private handles and resumable leases", async () => {
  for (const foreignIndex of [0, 1, 2]) {
    const options = withPool();
    const foreign = { ...cap, id: "foreign-cap", principalId: "foreign" };
    const f = serviceFixture({
      ...options,
      capabilities: [cap, foreign],
      keys: options.keys.map((key) => ({ ...key, api: { ...key.api, paid_fallback_limit_microcredits: 200 } })),
    });
    try {
      const other = new NativeAuthorityClient(new NativeAuthorityRpcServer(f.authority, foreign.id), cap.epoch);
      const attempts = await round2MixedAttempts(f, other, foreignIndex);
      const recovered: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 4; page++) {
        const expected = attempts.pages[page] ?? [];
        cursor = await round2ClaimPage(f, other, cursor, expected);
        recovered.push(...expected);
        if (!cursor) break;
      }
      reviewTrace(f, "R2-2-" + String(foreignIndex));
      expect(recovered).toEqual(attempts.own);
      expect(recovered).not.toContain(attempts.foreignHandle);
      expect(f.sql.page("paid_pending", now, "", 100)).toHaveLength(3);
      expect(f.sql.page("paid_window", now, "", 100)[0].row.value?.reserved_microcredits).toBe(120);
      expect(f.sql.read("paid_lease", nativePaid.paidFallbackReconciliationLeaseV3Key(cap.keyId), now).value).toBeNull();
    } finally {
      f.db.close();
    }
  }
});

test("round2 R3 classified Codex success owns terminal usage with and without optional start", async () => {
  for (const start of [false, true]) {
    const f = serviceFixture();
    try {
      const handle = await clientReserve(f, "codex-success-" + String(start));
      await f.client.call("selectCodexAccount", { handle });
      await f.client.call("markApiDispatch", { handle, provider: "chatgpt_codex" });
      if (start) await f.client.call("recordTransportStarted", { handle, provider: "chatgpt_codex" });
      await f.client.call("recordCodexAttemptSignal", { handle, signal: "success" });
      const terminal = { handle, outcome: "completed" as const, usage: { input_tokens: 3, cached_input_tokens: null, output_tokens: 2 } };
      await f.client.call("recordSemanticTerminal", terminal, "codex-terminal");
      await f.client.call("recordSemanticTerminal", terminal, "codex-terminal");
      reviewTrace(f, "R2-3-" + String(start));
      const rollups = f.sql.page("paid_rollup", now, "", 100);
      expect(rollups).toHaveLength(1);
      expect(rollups[0].row.value).toMatchObject({ provider: "chatgpt_codex", request_count: 1, input_tokens: 3, output_tokens: 2, spend_microcredits: 0 });
      expect(required(f.sql.read("request_lifetime", [handle], now).value).responding).toEqual({ provider: "chatgpt_codex", attemptHandle: null });
    } finally {
      f.db.close();
    }
  }
});

test("round2 R4 compensation cancellation is distinct from positive lifecycle evidence", async () => {
  const patches = {
    empty: {},
    not_dispatched: { dispatch_state: "not_dispatched" },
    provider_id: { provider_request_id: "real-provider-observation" },
    completed: { terminal_state: "completed" },
    failed: { terminal_state: "failed" },
    cancelled: { terminal_state: "cancelled" },
    fetch: {},
  } as const;
  for (const evidence of ["empty", "not_dispatched", "provider_id", "completed", "failed", "cancelled", "fetch"] as const) {
    const f = serviceFixture();
    try {
      const attempt = await reviewPaid(f, "compensation-" + evidence);
      await f.client.call("markApiDispatch", { handle: attempt.requestHandle, provider: "metered" });
      expect((await f.client.call("releasePaidBeforeFetch", { attemptHandle: attempt.attemptHandle })).kind).toBe("released");
      const releasedStart = await Promise.allSettled([
        f.client.call("recordTransportStarted", { handle: attempt.requestHandle, provider: "metered", attemptHandle: attempt.attemptHandle }),
      ]);
      expect(releasedStart[0].status).toBe("rejected");
      await f.client.call("recordPaidAttemptLifecycle", {
        attemptHandle: attempt.attemptHandle,
        patch: patches[evidence],
        ...(evidence === "fetch" ? { fetchStarted: true } : {}),
      });
      const positive = evidence !== "empty" && evidence !== "not_dispatched";
      const outcome = await Promise.allSettled([f.client.call("recordApiDispatchCancellation", { handle: attempt.requestHandle })]);
      reviewTrace(f, "R2-4-" + evidence);
      expect(outcome[0].status).toBe(positive ? "rejected" : "fulfilled");
      expect(required(f.sql.read("request_lifetime", [attempt.requestHandle], now).value).providerObserved).toBe(positive);
      expect(f.sql.page("api_window", now, "", 100)[0].row.value?.committed_requests).toBe(positive ? 1 : 0);
      expect(f.sql.page("paid_request", now, "", 100)[0].row.value).toMatchObject({
        billing_state: "not_billed",
        dispatch_state: "not_dispatched",
        spend_microcredits: 0,
      });
      expect(f.sql.page("paid_window", now, "", 100)[0].row.value).toMatchObject({ reserved_microcredits: 0, pending_count: 0 });
    } finally {
      f.db.close();
    }
  }
});

test("round2 R5 current refresh preserves routing revisions while real credential refresh fences", async () => {
  const f = serviceFixture();
  try {
    const handle = await clientReserve(f, "unchanged-refresh");
    await f.client.call("selectCodexAccount", { handle });
    const before = f.sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now);
    for (const operation of ["refresh-noop-1", "refresh-noop-2", "refresh-noop-1"]) {
      expect((await f.client.call("refreshCodexAdmission", { handle }, operation)).kind).toBe("current");
      expect(f.sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now)).toEqual(before);
    }
    reviewRotate(f, "e".repeat(64));
    expect((await f.client.call("refreshCodexAdmission", { handle }, "refresh-changed")).kind).toBe("current");
    const after = f.sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now);
    reviewTrace(f, "R2-5");
    expect(after.revision).not.toBe(before.revision);
    expect(after.value?.slots[0].credential_version).toBe("e".repeat(64));
    const stale = await Promise.allSettled([f.client.call("refreshCodexAdmission", { handle }, "refresh-noop-1")]);
    expect(stale[0].status).toBe("rejected");
    expect((await f.client.call("markApiDispatch", { handle, provider: "chatgpt_codex" })).kind).toBe("dispatched");
  } finally {
    f.db.close();
  }
});
