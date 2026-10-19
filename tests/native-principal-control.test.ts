import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKeyHashKey, apiKeyIdKey } from "../src/api-keys.ts";
import type { ApiKeyRecord } from "../src/types.ts";
import { defaultPaidFallbackPolicy } from "../src/paid-fallback/index.ts";
import { LOCAL_DEVELOPMENT_KEY_ID } from "../src/auth/local-development-key.ts";
import { MeteredError } from "../src/provider/metered.ts";
import { apiKeyHashRecordFor, apiKeyPolicyFromHashRecord, buildApiKeyCreateRecords } from "../src/authority/native-api-key-policy.ts";
import { API_KEY_USAGE_V3_RETENTION_MS } from "../src/authority/native-api-key.ts";
import { API_KEY_CHANGE_RETENTION_MS } from "../src/authority/native-api-key-audit.ts";
import { NativeAuthority } from "../src/authority/native-authority.ts";
import { NativeAuthoritySql } from "../src/authority/native-authority-sql.ts";
import { paidFallbackDeletionGuardV3Key, paidFallbackReconciliationLeaseV3Key, paidFallbackWindowV3Key } from "../src/authority/native-paid.ts";
import type { NativeAuthorityInitial, NativeCapability, NativeSqlStorage } from "../src/authority/native-authority-contracts.ts";
import type { NativeControlReply, NativeKeyControlGrant, NativePrincipalControlInitial } from "../src/authority/native-principal-contracts.ts";
import {
  NativeAuthorityClient,
  NativeAuthorityRpcServer,
  NativePrincipalControlClient,
  NativePrincipalControlServer,
  parseNativeCommand,
  parseNativeControlCommand,
} from "../src/authority/native-authority-rpc.ts";

const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("required synthetic value missing");
  return value;
};
const NOW = 1_800_000_000_000;
const cap: NativeCapability = {
  id: "synthetic-cap",
  epoch: "control-epoch",
  principalId: "p",
  keyId: "key",
  tokenHash: "synthetic-hash",
  kernel: { owner: "org", repo: "repo" },
  roles: ["inference", "transport", "terminal", "billing", "reconcile", "observer"],
  revoked: false,
};
const rawRecord = (id = "key", paid = false): ApiKeyRecord => ({
  id,
  name: "fixture",
  prefix: "u_synthetic",
  hash: "synthetic-hash",
  created_at_ms: NOW,
  expires_at_ms: -1,
  revoked_at_ms: null,
  usage_limit_requests: 20,
  usage_requests: 0,
  usage_reset_at_ms: NOW + 60_000,
  window_ms: 60_000,
  usage_quota_version: 3,
  paid_fallback_enabled: paid,
  paid_fallback_limit_microcredits: paid ? 200 : 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
  paid_fallback_model_ids: paid ? ["fixture"] : [],
  paid_fallback_quota_per_credit: paid ? 100 : 0,
  paid_fallback_max_exposure_microcredits: paid ? { fixture: 40 } : {},
  paid_fallback_pricing_checked_at_ms: paid ? NOW : null,
});
const grant = (role: "key_admin" | "principal_resolver"): NativeKeyControlGrant => ({
  id: role,
  epoch: cap.epoch,
  subjectId: role,
  contextBinding: role,
  roles: [role],
  expiresAtMs: NOW + 86_400_000,
  revoked: false,
  targetKeyIds: null,
});
const sqlObservers = new WeakMap<Database, (query: string) => void>();
const storage = (database: Database): NativeSqlStorage => ({
  sql: {
    exec(query, ...bindings) {
      const rows = database.query<Record<string, unknown>, (string | number | null)[]>(query).all(...bindings);
      sqlObservers.get(database)?.(query);
      return { toArray: () => rows };
    },
  },
  transactionSync<T>(callback: () => T): T {
    return database.transaction(callback)();
  },
});
type FixtureContext = Readonly<{ kind: "key_admin" | "principal_resolver"; target?: string | null; token?: string | null; tokenHash?: string }>;
const fixture = (record = rawRecord(), path = ":memory:") => {
  const db = new Database(path),
    clock = { now: NOW },
    calls: string[] = [];
  let uuid = 0,
    pricing: (() => Promise<void>) | undefined,
    verification: (() => Promise<void>) | undefined,
    cleanup: (() => Promise<void>) | undefined;
  const options: NativeAuthorityInitial = {
    namespace: "private-control-fixture",
    epoch: cap.epoch,
    capabilities: [{ ...cap, keyId: record.id }],
    keys: [
      {
        api: required(apiKeyPolicyFromHashRecord(record.hash, apiKeyHashRecordFor(record), NOW)),
        revoked: record.revoked_at_ms !== null,
        paid: {
          policyVersion: `${record.window_ms}:${record.paid_fallback_pricing_checked_at_ms ?? 0}`,
          quotaPerCredit: record.paid_fallback_quota_per_credit,
          modelExposure: record.paid_fallback_max_exposure_microcredits ?? {},
          eligibleModels: record.paid_fallback_model_ids,
          allowUnrosteredUnlimited: true,
        },
      },
    ],
    kernelPolicies: [],
    kernelDefaults: { limit: 20, windowMs: 60_000 },
    kernelConstants: { noUsageLimit: -1, noExpirationMs: -1 },
    pool: { identities: [], selectedAccountHashes: [], policies: {} },
    routing: null,
    active: null,
    capacity: { v: 1, observations: [] },
    owners: [],
    resetProofs: [],
    providerHops: [
      {
        id: "paid",
        publicProvider: "openlux",
        ledgerProvider: "metered",
        billingCorrelation: "provider_request_id",
        microcreditsPerCredit: 100,
        billingSuffix: "openlux",
        authorization: "direct",
      },
    ],
  };
  const control: NativePrincipalControlInitial = {
    grants: [grant("key_admin"), grant("principal_resolver")],
    records: [{ record, hashRecord: apiKeyHashRecordFor(record) }],
    verifier: {
      async verify(context, intentDigest) {
        await verification?.();
        const source = context as FixtureContext;
        const identity = { subjectId: source.kind, contextBinding: source.kind, intentDigest };
        if (source.kind === "principal_resolver") return { ...identity, kind: source.kind, principalId: "p", tokenHash: source.tokenHash ?? record.hash };
        return {
          ...identity,
          kind: "key_admin",
          targetKeyId: source.target === undefined ? record.id : source.target,
          createToken: source.token,
          auditContext: {
            request_id: "safe-correlation",
            auth: { ok: true, token: "synthetic-private-admin", is_super_admin: true, method: { kind: "disabled" } },
          },
        };
      },
    },
    sources: {
      localDevelopmentKeyId: LOCAL_DEVELOPMENT_KEY_ID,
      defaultPaidPolicy: defaultPaidFallbackPolicy,
      defaults: () => {
        calls.push("defaults");
        return { expiryMs: NOW + 90_000_000, usageLimitRequests: 73 };
      },
      generateToken: () => {
        calls.push("token");
        return "u_" + "b".repeat(64);
      },
      hashToken: (token) => {
        calls.push("hash");
        return Promise.resolve("synthetic-" + token.slice(2, 10));
      },
      randomUUID: () => {
        calls.push("uuid");
        return `synthetic-uuid-${++uuid}`;
      },
      audit: {
        now: () => {
          calls.push("clock");
          return clock.now;
        },
        randomUUID: () => {
          calls.push("audit-uuid");
          return `synthetic-audit-${++uuid}`;
        },
        release: () => {
          calls.push("release");
          return "synthetic-release";
        },
      },
      initializePricing: async () => {
        calls.push("pricing");
        await pricing?.();
        return {
          paid_fallback_model_ids: ["fixture"],
          paid_fallback_quota_per_credit: 100,
          paid_fallback_max_exposure_microcredits: { fixture: 40 },
          paid_fallback_pricing_checked_at_ms: clock.now,
        };
      },
      pricingFailure: (error) =>
        error instanceof MeteredError
          ? { kind: "refused", status: error.status, message: error.message, code: error.code }
          : { kind: "refused", status: 502, message: "Failed to initialize Metered paid fallback", code: "metered_pricing_unavailable" },
      allowUnrosteredUnlimited: () => false,
      cleanupApiLogs: async () => {
        calls.push("logs-cleanup");
        await cleanup?.();
      },
    },
  };
  const authority = new NativeAuthority(storage(db), options, () => clock.now, control);
  const sql = new NativeAuthoritySql(storage(db), options.namespace, options.epoch);
  const admin = (target: string | null = record.id, token?: string | null, owner = authority) =>
    new NativePrincipalControlClient(
      new NativePrincipalControlServer(owner, { grantId: "key_admin", contextBinding: "key_admin", privateContext: { kind: "key_admin", target, token } }),
      cap.epoch
    );
  const resolver = (owner = authority) =>
    new NativePrincipalControlClient(
      new NativePrincipalControlServer(owner, {
        grantId: "principal_resolver",
        contextBinding: "principal_resolver",
        privateContext: { kind: "principal_resolver" },
      }),
      cap.epoch
    );
  const client = (id = cap.id, owner = authority) => new NativeAuthorityClient(new NativeAuthorityRpcServer(owner, id), cap.epoch);
  return {
    db,
    sql,
    clock,
    calls,
    control,
    options,
    authority,
    admin,
    resolver,
    client,
    observeSql: (observer: (query: string) => void) => {
      sqlObservers.set(db, observer);
    },
    pricing: (hook: () => Promise<void>) => {
      pricing = hook;
    },
    verification: (hook: () => Promise<void>) => {
      verification = hook;
    },
    cleanup: (hook: () => Promise<void>) => {
      cleanup = hook;
    },
    restart: () => new NativeAuthority(storage(db), options, () => clock.now, control),
  };
};
const apiReserve = async (f: ReturnType<typeof fixture>, requestId: string, client = f.client()): Promise<string> =>
  required((await client.call("reserveApiUsage", { requestId, route: "/v1/responses", model: "fixture", stream: false })).handle);
const appliedId = (reply: NativeControlReply): string => {
  if (reply.kind !== "applied") throw new Error("expected applied synthetic control result: " + JSON.stringify(reply));
  return reply.keyId;
};
const audits = (f: ReturnType<typeof fixture>) => f.sql.page("api_key_audit", f.clock.now, "", 100);
const barrier = () => {
  let release = () => {},
    entered = () => {};
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    wait = new Promise<void>((resolve) => {
      release = resolve;
    });
  return {
    ready,
    release,
    hook: async () => {
      entered();
      await wait;
    },
  };
};

test("private control accepts exactly six intents and refuses caller identity or scope assertions", () => {
  const command = { epoch: "synthetic-epoch", operationId: "operation", method: "resolvePrincipal", args: {} } as const;
  expect(parseNativeControlCommand(command)).toEqual(command);
  for (const assertion of ["principalId", "keyId", "targetKeyId", "tokenHash", "actor", "role", "verified", "now", "revision", "grantId"])
    expect(() => parseNativeControlCommand({ ...command, args: { [assertion]: "caller" } })).toThrow("invalid_control_arguments");
  expect(() => parseNativeCommand(command)).toThrow("invalid_authority_operation");
  for (const assertion of ["id", "token", "hash", "policy", "clock", "actor", "release"])
    expect(() => parseNativeControlCommand({ ...command, method: "createKey", args: { input: { name: "fixture", [assertion]: "caller" } } })).toThrow(
      "invalid_control_arguments"
    );
});

test("resolver reads current mutable H without requiring ID, creating a lifetime or reserving quota", async () => {
  const f = fixture();
  try {
    f.sql.transaction(() => {
      f.sql.delete("api_key_id", apiKeyIdKey("key"));
    });
    expect(await f.resolver().call("resolvePrincipal", {}, "same-resolution")).toMatchObject({
      kind: "principal",
      principalRef: { principalId: "p", keyId: "key" },
    });
    for (const table of ["api_request", "api_window", "request_lifetime", "attempt_lifetime", "operation_receipt"] as const)
      expect(f.sql.page(table, NOW, "", 100)).toHaveLength(0);
    const original = required(f.sql.read("api_key_hash", apiKeyHashKey(cap.tokenHash), NOW).value);
    for (const [patch, expected] of [
      [{ revoked_at_ms: NOW }, { status: 401, code: "invalid_api_key" }],
      [{ expires_at_ms: NOW }, { status: 401, code: "invalid_api_key" }],
      [{ usage_quota_version: 2 }, { status: 503, message: "API key quota migration is incomplete" }],
      [{ paid_fallback_limit_microcredits: -2 }, { status: 503, message: "API key quota migration is incomplete" }],
    ] as const) {
      f.sql.transaction(() => {
        f.sql.write("api_key_hash", apiKeyHashKey(cap.tokenHash), { ...original, ...patch });
      });
      expect(await f.resolver().call("resolvePrincipal", {}, "same-resolution")).toMatchObject({ kind: "refused", ...expected });
    }
  } finally {
    f.db.close();
  }
});

test("current grant, epoch, role, context and target are rechecked after private verification", async () => {
  const f = fixture();
  try {
    const pause = barrier();
    f.verification(pause.hook);
    const pending = f.admin().call("revokeKey", {}, "revoked-grant");
    await pause.ready;
    f.sql.transaction(() => {
      f.sql.write("key_control_grant", ["key_admin"], { ...grant("key_admin"), revoked: true });
    });
    pause.release();
    await assert.rejects(pending, /control_grant_denied/);
    expect(audits(f)).toHaveLength(0);
    expect(f.sql.read("api_key_hash", apiKeyHashKey(cap.tokenHash), NOW).value?.revoked_at_ms).toBeNull();
    f.verification(() => Promise.resolve());
    f.sql.transaction(() => {
      f.sql.write("key_control_grant", ["key_admin"], { ...grant("key_admin"), targetKeyIds: ["another-key"] });
    });
    await assert.rejects(f.admin().call("revokeKey", {}), /control_target_denied/);
    const wrong = new NativePrincipalControlClient(
      new NativePrincipalControlServer(f.authority, {
        grantId: "key_admin",
        contextBinding: "principal_resolver",
        privateContext: { kind: "principal_resolver" },
      }),
      cap.epoch
    );
    await assert.rejects(wrong.call("revokeKey", {}), /control_grant_denied/);
    f.sql.transaction(() => {
      f.sql.write("key_control_grant", ["key_admin"], { ...grant("key_admin"), expiresAtMs: NOW });
    });
    await assert.rejects(f.admin().call("revokeKey", {}), /control_grant_denied/);
  } finally {
    f.db.close();
  }
});

test("create preserves native material/defaults/duplicate/pricing/UUID ordering and atomically projects raw records", async () => {
  const f = fixture();
  try {
    const input = {
      name: " created ",
      expires_at_ms: -1,
      usage_limit_requests: 0,
      window_ms: "60000",
      paid_fallback_enabled: true,
      paid_fallback_limit_credits: -1,
    };
    const id = appliedId(await f.admin(null).call("createKey", { input }, "create"));
    expect(f.calls).toEqual(["token", "clock", "defaults", "hash", "pricing", "uuid", "audit-uuid", "release"]);
    const record = required(f.sql.read("api_key_id", apiKeyIdKey(id), NOW).value);
    const expected = buildApiKeyCreateRecords(
      { id, name: "created", prefix: "u_bbbbbbbbbb", hash: "synthetic-bbbbbbbb" },
      { expiresAtMs: -1, usageLimitRequests: 0, windowMs: 60_000, paidFallbackEnabled: true, paidFallbackLimitMicrocredits: -1 },
      {
        paid_fallback_enabled: true,
        paid_fallback_limit_microcredits: -1,
        paid_fallback_spent_microcredits: 0,
        paid_fallback_reserved_microcredits: 0,
        paid_fallback_reservation_request_id: null,
        paid_fallback_model_ids: ["fixture"],
        paid_fallback_quota_per_credit: 100,
        paid_fallback_max_exposure_microcredits: { fixture: 40 },
        paid_fallback_pricing_checked_at_ms: NOW,
      },
      NOW
    );
    expect(record).toEqual(expected.record);
    expect(f.sql.read("api_key_hash", apiKeyHashKey(record.hash), NOW).value).toEqual(expected.hashRecord);
    expect(f.sql.read("api_policy", apiKeyHashKey(record.hash), NOW).value).toMatchObject({
      rawSource: true,
      paid: { allowUnrosteredUnlimited: false, policyVersion: "60000:1800000000000", modelExposure: { fixture: 40 } },
    });
    expect(f.sql.page("api_window", NOW, "", 100)[0].row.expiresAtMs).toBe(NOW + 60_000 + API_KEY_USAGE_V3_RETENTION_MS);
    expect(audits(f)[0].row.expiresAtMs).toBe(NOW + API_KEY_CHANGE_RETENTION_MS);
    const event = required(audits(f)[0].row.value);
    expect(event).toMatchObject({
      action: "create",
      actor: { kind: "local_admin", principal_id: null },
      request_id: "safe-correlation",
      release: "synthetic-release",
    });
    expect(JSON.stringify(event)).not.toContain("synthetic-bbbbbbbb");
    const before = [...f.calls];
    expect(await f.admin(null).call("createKey", { input }, "create")).toMatchObject({ kind: "historical_ack", outcome: { kind: "applied", keyId: id } });
    expect(f.calls).toEqual(before);
    expect(await f.admin(null).call("createKey", { input }, "fresh-duplicate")).toMatchObject({
      kind: "refused",
      status: 409,
      message: "API key already exists",
    });
    expect(f.calls.slice(before.length)).toEqual(["token", "clock", "defaults", "hash"]);
  } finally {
    f.db.close();
  }
});

test("native malformed-field and retired-setting precedence fails without key or audit writes", async () => {
  const f = fixture();
  try {
    for (const [input, message] of [
      [{ banked_resets_enabled: false, name: 4 }, "banked_resets_enabled is retired"],
      [{ name: "" }, "name must be"],
      [{ name: "new", expires_at_ms: NOW, usage_limit_requests: -2 }, "expires_at_ms must be"],
      [{ name: "new", usage_limit_requests: -2, window_ms: null }, "usage_limit_requests must be"],
      [{ name: "new", window_ms: null, paid_fallback_enabled: "bad" }, "window_ms must be"],
      [{ name: "new", paid_fallback_enabled: "bad" }, "paid_fallback_enabled must be"],
      [{ name: "new", paid_fallback_enabled: true }, "paid_fallback_limit_credits must be positive"],
    ] as const) {
      const result = await f.admin(null).call("createKey", { input });
      expect(result.kind).toBe("refused");
      if (result.kind === "refused") expect(result.message).toContain(message);
    }
    expect(audits(f)).toHaveLength(0);
    expect(f.sql.page("api_key_id", NOW, "", 100)).toHaveLength(1);
    expect(await f.admin().call("deleteKey", {})).toMatchObject({ kind: "refused", status: 400, message: "Only revoked keys can be deleted" });
    expect(f.sql.page("paid_deletion_guard", NOW, "", 100)).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("actual SQLite audit failure rolls back ID/H/projection/window and retry never remints prepared create material", async () => {
  const f = fixture();
  try {
    f.db.run("CREATE TRIGGER synthetic_audit_fault BEFORE INSERT ON uos_native_api_key_audit BEGIN SELECT RAISE(ABORT,'synthetic audit fault'); END");
    const command = { input: { name: "atomic", window_ms: 60_000 } };
    await assert.rejects(f.admin(null).call("createKey", command, "atomic"), /synthetic audit fault/);
    for (const table of ["api_key_id", "api_key_hash", "api_policy"] as const) expect(f.sql.page(table, NOW, "", 100)).toHaveLength(1);
    expect(f.sql.page("api_window", NOW, "", 100)).toHaveLength(0);
    expect(audits(f)).toHaveLength(0);
    expect(f.sql.page("key_control_receipt", NOW, "", 100)[0].row.value).toMatchObject({ reply: null, prepared: { record: { id: "synthetic-uuid-1" } } });
    f.db.run("DROP TRIGGER synthetic_audit_fault");
    const calls = [...f.calls];
    expect(await f.admin(null, undefined, f.restart()).call("createKey", command, "atomic")).toMatchObject({ kind: "applied", keyId: "synthetic-uuid-1" });
    expect(f.calls.slice(calls.length)).toEqual(["audit-uuid", "release"]);
    expect(audits(f)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("update no-op uses live V3 usage, preserves trusted paid binding and opens a fresh same-ms reset window", async () => {
  const record = { ...rawRecord(), paid_fallback_reserved_microcredits: 17, paid_fallback_reservation_request_id: "pending-original" };
  const f = fixture(record);
  try {
    const handle = await apiReserve(f, "used");
    await f.client().call("markApiDispatch", { handle, provider: "deepseek" });
    expect(await f.admin().call("updateKey", { input: {} })).toMatchObject({ kind: "unchanged", detail: { usage_requests: 1 } });
    expect(audits(f)).toHaveLength(0);
    expect(await f.admin().call("updateKey", { input: { reset_usage: true } })).toMatchObject({
      kind: "applied",
      detail: { usage_requests: 0, usage_reset_at_ms: NOW + 60_001 },
    });
    const updated = required(f.sql.read("api_key_id", apiKeyIdKey("key"), NOW).value);
    expect(updated).toMatchObject({ paid_fallback_reserved_microcredits: 17, paid_fallback_reservation_request_id: "pending-original" });
    expect(f.sql.read("api_policy", apiKeyHashKey(record.hash), NOW).value?.paid.allowUnrosteredUnlimited).toBe(true);
    expect(f.sql.page("api_window", NOW, "", 100)).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("key-wide reset reclaims only expired original-window reservations and refuses live or missing identities", async () => {
  const f = fixture();
  try {
    await apiReserve(f, "old-window");
    f.clock.now = NOW + 60_001;
    await apiReserve(f, "new-window");
    expect(await f.admin().call("updateKey", { input: { reset_usage: true } })).toMatchObject({ kind: "refused", status: 409 });
    expect(audits(f)).toHaveLength(0);
    f.clock.now = NOW + 300_001;
    expect(await f.admin().call("updateKey", { input: { reset_usage: true } })).toMatchObject({ kind: "refused", status: 409 });
    const original = f.sql.page("api_request", f.clock.now, "", 100).find((entry) => entry.row.value?.request_id === "old-window");
    expect(original?.row.value).toMatchObject({ state: "released", release_reason: "reservation_lease_expired" });
    expect(original?.row.expiresAtMs).toBe(NOW + 60_000 + API_KEY_USAGE_V3_RETENTION_MS);
    f.clock.now = NOW + 360_002;
    expect(await f.admin().call("updateKey", { input: { window_ms: 120_000 } })).toMatchObject({ kind: "applied" });
    await apiReserve(f, "identity-missing");
    const lifetime = required(f.sql.page("request_lifetime", f.clock.now, "", 100).find((entry) => entry.row.value?.requestId === "identity-missing"));
    f.sql.transaction(() => {
      f.sql.delete("request_lifetime", lifetime.key);
    });
    await assert.rejects(f.admin().call("updateKey", { input: { reset_usage: true } }), /api_reset_original_identity_missing/);
  } finally {
    f.db.close();
  }
});

test("pricing await rechecks source revisions and live reset guards without rebasing the old patch", async () => {
  const f = fixture();
  try {
    const pause = barrier();
    f.pricing(pause.hook);
    const pending = f
      .admin()
      .call("updateKey", { input: { name: "stale", paid_fallback_enabled: true, paid_fallback_limit_credits: -1, reset_usage: true } }, "stale");
    await pause.ready;
    await apiReserve(f, "racing-reservation");
    const original = required(f.sql.read("api_key_id", apiKeyIdKey("key"), NOW).value);
    f.sql.transaction(() => {
      const next = { ...original, name: "new-source-name" };
      f.sql.write("api_key_id", apiKeyIdKey("key"), next);
      f.sql.write("api_key_hash", apiKeyHashKey(next.hash), apiKeyHashRecordFor(next));
    });
    pause.release();
    expect(await pending).toMatchObject({
      kind: "refused",
      status: 409,
      message: "Cannot reset API key quota while requests are reserved; retry after their five-minute lease expires",
    });
    expect(f.sql.read("api_key_id", apiKeyIdKey("key"), NOW).value?.name).toBe("new-source-name");
    expect(audits(f)).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("repeat revoke audits retain first timestamp, replay does not audit, and guarded active unrevoke is refused", async () => {
  const f = fixture();
  try {
    expect(await f.admin().call("unrevokeKey", {}, "already-active")).toMatchObject({ kind: "unchanged" });
    expect(f.calls).toHaveLength(0);
    expect(await f.admin().call("revokeKey", {}, "revoke")).toMatchObject({ kind: "applied", detail: { revoked_at_ms: NOW } });
    f.clock.now++;
    expect(await f.admin().call("revokeKey", {}, "repeat-revoke")).toMatchObject({ kind: "applied", detail: { revoked_at_ms: NOW } });
    expect(audits(f)).toHaveLength(2);
    expect(audits(f)[0].row.value?.changed).toEqual({});
    expect(await f.admin().call("revokeKey", {}, "revoke")).toMatchObject({ kind: "historical_ack" });
    expect(audits(f)).toHaveLength(2);
    await assert.rejects(f.admin().call("unrevokeKey", {}, "revoke"), /control_operation_replay_conflict/);
    await f.admin().call("unrevokeKey", {});
    f.sql.transaction(() => {
      f.sql.write("paid_deletion_guard", paidFallbackDeletionGuardV3Key("key"), { created_at_ms: NOW });
    });
    const calls = f.calls.length;
    expect(await f.admin().call("unrevokeKey", {})).toMatchObject({ kind: "refused", code: "paid_fallback_deletion_in_progress" });
    expect(f.calls).toHaveLength(calls);
  } finally {
    f.db.close();
  }
});

test("revocation denies fresh and replayed admission/transport while preserving existing-handle accounting cleanup", async () => {
  const f = fixture(rawRecord("key", true));
  try {
    const client = f.client(),
      handle = await apiReserve(f, "inflight", client);
    expect(await client.call("reserveKernelUsage", { handle })).toMatchObject({ kind: "reserved" });
    const attempt = required((await client.call("reservePaidAttempt", { handle, hopId: "paid" }, "paid-admission")).attemptHandle);
    await client.call("markApiDispatch", { handle, provider: "metered" });
    await client.call("recordTransportStarted", { handle, provider: "metered", attemptHandle: attempt }, "transport");
    await client.call("recordPaidAttemptLifecycle", { attemptHandle: attempt, patch: { provider_request_id: "paid-response" } });
    await f.admin().call("revokeKey", {});
    expect(await f.resolver().call("resolvePrincipal", {})).toMatchObject({ kind: "refused", status: 401 });
    expect(await client.call("reserveApiUsage", { requestId: "fresh", route: "/v1/responses", model: "fixture", stream: false })).toMatchObject({
      kind: "unauthorized",
    });
    expect(await client.call("reservePaidAttempt", { handle, hopId: "paid" })).toMatchObject({ kind: "blocked", detail: "invalid_policy" });
    await assert.rejects(client.call("reservePaidAttempt", { handle, hopId: "paid" }, "paid-admission"), /api_policy_revoked/);
    await assert.rejects(client.call("recordTransportStarted", { handle, provider: "metered", attemptHandle: attempt }, "transport"), /api_policy_revoked/);
    expect(await client.call("renewKernelReservation", { handle })).toMatchObject({ kind: "renewed" });
    expect(await client.call("recordKernelTerminalIntent", { handle, terminalState: "committed" })).toMatchObject({ kind: "intent" });
    expect(await client.call("settleKernelUsage", { handle, terminalState: "committed", reason: "completed" })).toMatchObject({
      kind: "settle",
      detail: { state: "committed" },
    });
    expect(await client.call("recordSemanticTerminal", { handle, attemptHandle: attempt, outcome: "completed" })).toMatchObject({ kind: "recorded" });
    expect(await client.call("recordDeliveryObservation", { handle, observation: "delivered" })).toMatchObject({ kind: "recorded" });
    expect(
      await client.call("recordVerifiedPaidBilling", {
        attemptHandle: attempt,
        log: { request_id: "paid-response", quota: 7, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: NOW / 1000 },
      })
    ).toMatchObject({ kind: "settled" });
    expect(f.sql.read("capability", [cap.id], NOW).value?.revoked).toBe(false);
    const second = fixture(rawRecord("key", true));
    try {
      const handle2 = await apiReserve(second, "prefetch");
      const paid2 = required((await second.client().call("reservePaidAttempt", { handle: handle2, hopId: "paid" })).attemptHandle);
      await second.admin().call("revokeKey", {});
      expect(await second.client().call("releasePaidBeforeFetch", { attemptHandle: paid2 })).toMatchObject({ kind: "released" });
      expect(await second.client().call("releaseApiUndispatched", { handle: handle2, reason: "revoked-before-fetch" })).toMatchObject({ kind: "released" });
    } finally {
      second.db.close();
    }
  } finally {
    f.db.close();
  }
});

test("key deletion inspects every principal, preserves permanent guard and fresh delete404, then cleans logs before API rows", async () => {
  const f = fixture(rawRecord("key", true));
  try {
    f.sql.transaction(() => {
      f.sql.write("capability", ["foreign"], { ...cap, id: "foreign", principalId: "foreign" });
    });
    const foreign = f.client("foreign"),
      handle = await apiReserve(f, "foreign-paid", foreign);
    const attempt = required((await foreign.call("reservePaidAttempt", { handle, hopId: "paid" })).attemptHandle);
    await f.admin().call("revokeKey", {});
    expect(await f.admin().call("deleteKey", {})).toMatchObject({ kind: "refused", code: "paid_fallback_billing_outstanding" });
    expect(f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("key"), NOW).expiresAtMs).toBeNull();
    expect(audits(f)).toHaveLength(1);
    await foreign.call("releasePaidBeforeFetch", { attemptHandle: attempt });
    f.cleanup(() => {
      expect(f.sql.read("api_key_id", apiKeyIdKey("key"), NOW).value).toBeNull();
      expect(f.sql.page("api_request", NOW, "", 100)).toHaveLength(1);
      expect(audits(f).some((entry) => entry.row.value?.action === "delete")).toBe(true);
      return Promise.resolve();
    });
    expect(await f.admin().call("deleteKey", {}, "delete")).toMatchObject({ kind: "applied", keyId: "key" });
    expect(f.sql.page("api_request", NOW, "", 100)).toHaveLength(0);
    expect(f.sql.read("api_key_hash", apiKeyHashKey(cap.tokenHash), NOW).value).toBeNull();
    expect(f.sql.read("api_policy", apiKeyHashKey(cap.tokenHash), NOW).value).toBeNull();
    expect(f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("key"), NOW).value).toEqual({ created_at_ms: NOW });
    expect(await f.admin().call("deleteKey", {}, "delete")).toMatchObject({ kind: "historical_ack" });
    expect(await f.admin().call("deleteKey", {}, "fresh-delete")).toMatchObject({ kind: "refused", status: 404 });
  } finally {
    f.db.close();
  }
});

test("local-key refusal releases only its own claim and deletion completion is durable after cleanup retry", async () => {
  const f = fixture(rawRecord("local-development", true));
  try {
    const handle = await apiReserve(f, "local-paid"),
      attempt = required((await f.client().call("reservePaidAttempt", { handle, hopId: "paid" })).attemptHandle);
    await f.admin().call("revokeKey", {});
    expect(await f.admin().call("deleteKey", {})).toMatchObject({ kind: "refused", code: "paid_fallback_billing_outstanding" });
    expect(f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("local-development"), NOW).value).toMatchObject({
      created_at_ms: NOW,
      local_deletion: { owner: null, completed_at_ms: null },
    });
    await f.client().call("releasePaidBeforeFetch", { attemptHandle: attempt });
    f.cleanup(() => Promise.reject(new Error("synthetic cleanup crash")));
    await assert.rejects(f.admin().call("deleteKey", {}, "local-delete"), /synthetic cleanup crash/);
    const guardBefore = required(f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("local-development"), NOW).value);
    expect(guardBefore).toMatchObject({ local_deletion: { completed_at_ms: null } });
    f.cleanup(() => Promise.resolve());
    expect(await f.admin("local-development", undefined, f.restart()).call("deleteKey", {}, "local-delete")).toMatchObject({ kind: "historical_ack" });
    expect(f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("local-development"), NOW).value).toMatchObject({
      created_at_ms: NOW,
      local_deletion: { completed_at_ms: NOW },
    });
    expect(f.sql.read("paid_lease", paidFallbackReconciliationLeaseV3Key("local-development"), NOW).value).toBeNull();
    expect(audits(f).filter((entry) => entry.row.value?.action === "delete")).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("completed lost acknowledgments survive a real SQLite close/reopen and current grant revocation still wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uos-private-control-")),
    path = join(dir, "authority.sqlite3");
  const first = fixture(rawRecord(), path);
  try {
    await first.admin().call("revokeKey", {}, "lost-ack");
  } finally {
    first.db.close();
  }
  const next = fixture(rawRecord(), path);
  try {
    expect(await next.admin().call("revokeKey", {}, "lost-ack")).toMatchObject({ kind: "historical_ack" });
    expect(audits(next)).toHaveLength(1);
    expect(next.calls).toHaveLength(0);
    next.sql.transaction(() => {
      next.sql.write("key_control_grant", ["key_admin"], { ...grant("key_admin"), revoked: true });
    });
    await assert.rejects(next.admin().call("revokeKey", {}, "lost-ack"), /control_grant_denied/);
  } finally {
    next.db.close();
    rmSync(dir, { recursive: true });
  }
});

test("concurrent lost-ack create retries mint material once and target or intent changes refuse replay", async () => {
  const f = fixture();
  try {
    const pause = barrier();
    f.pricing(pause.hook);
    const command = { input: { name: "concurrent", paid_fallback_enabled: true, paid_fallback_limit_credits: -1 } };
    const first = f.admin(null).call("createKey", command, "concurrent");
    await pause.ready;
    const second = f.admin(null).call("createKey", command, "concurrent");
    pause.release();
    const results = await Promise.all([first, second]);
    expect(results.filter((reply) => reply.kind === "applied")).toHaveLength(1);
    expect(results.filter((reply) => reply.kind === "historical_ack")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "token")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "pricing")).toHaveLength(1);
    expect(audits(f)).toHaveLength(1);
    await assert.rejects(
      f.admin(null).call("createKey", { input: { ...command.input, name: "different" } }, "concurrent"),
      /control_operation_replay_conflict/
    );
    await f.admin().call("revokeKey", {}, "target-bound");
    await assert.rejects(f.admin("another-key").call("revokeKey", {}, "target-bound"), /control_operation_replay_conflict/);
  } finally {
    f.db.close();
  }
});

test("trusted unrostered binding absence refuses new keys while existing bindings survive updates", async () => {
  const f = fixture();
  try {
    const owner = new NativeAuthority(storage(f.db), f.options, () => f.clock.now, {
      ...f.control,
      sources: { ...f.control.sources, allowUnrosteredUnlimited: undefined },
    });
    await assert.rejects(f.admin(null, undefined, owner).call("createKey", { input: { name: "missing-binding" } }), /trusted_unrostered_binding_unavailable/);
    expect(audits(f)).toHaveLength(0);
    expect(f.sql.page("api_key_id", NOW, "", 100)).toHaveLength(1);
    expect(await f.admin("key", undefined, owner).call("updateKey", { input: { name: "preserved" } })).toMatchObject({ kind: "applied" });
    expect(f.sql.read("api_policy", apiKeyHashKey(cap.tokenHash), NOW).value?.paid.allowUnrosteredUnlimited).toBe(true);
  } finally {
    f.db.close();
  }
});

test("direct raw-H revocation or removal denies managed admission and cannot replay earlier admission permission", async () => {
  const f = fixture();
  try {
    const client = f.client(),
      args = { requestId: "before-revocation", route: "/v1/responses", model: "fixture", stream: false };
    await client.call("reserveApiUsage", args, "admission");
    const original = required(f.sql.read("api_key_hash", apiKeyHashKey(cap.tokenHash), NOW).value);
    f.sql.transaction(() => {
      f.sql.write("api_key_hash", apiKeyHashKey(cap.tokenHash), { ...original, revoked_at_ms: NOW });
    });
    expect(await client.call("reserveApiUsage", { ...args, requestId: "after-revocation" })).toMatchObject({ kind: "unauthorized" });
    await assert.rejects(client.call("reserveApiUsage", args, "admission"), /api_policy_revoked/);
    f.sql.transaction(() => {
      f.sql.delete("api_key_hash", apiKeyHashKey(cap.tokenHash));
    });
    expect(await client.call("reserveApiUsage", { ...args, requestId: "after-removal" })).toMatchObject({ kind: "unauthorized" });
    expect(f.sql.read("api_policy", apiKeyHashKey(cap.tokenHash), NOW).value?.revoked).toBe(false);
    expect(f.sql.page("request_lifetime", NOW, "", 100)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("audit failure leaves revocation transitions atomic and releases only a known local pre-ID deletion claim", async () => {
  const f = fixture(rawRecord("local-development"));
  try {
    const failAudit = () => {
      f.db.run("CREATE TRIGGER synthetic_audit_fault BEFORE INSERT ON uos_native_api_key_audit BEGIN SELECT RAISE(ABORT,'synthetic audit fault'); END");
    };
    failAudit();
    await assert.rejects(f.admin().call("revokeKey", {}, "atomic-revoke"), /synthetic audit fault/);
    expect(f.sql.read("api_key_hash", apiKeyHashKey(cap.tokenHash), NOW).value?.revoked_at_ms).toBeNull();
    expect(f.sql.read("api_policy", apiKeyHashKey(cap.tokenHash), NOW).value?.revoked).toBe(false);
    f.db.run("DROP TRIGGER synthetic_audit_fault");
    await f.admin().call("revokeKey", {});
    failAudit();
    await assert.rejects(f.admin().call("unrevokeKey", {}, "atomic-unrevoke"), /synthetic audit fault/);
    expect(f.sql.read("api_key_id", apiKeyIdKey("local-development"), NOW).value?.revoked_at_ms).toBe(NOW);
    await assert.rejects(f.admin().call("deleteKey", {}, "atomic-delete"), /synthetic audit fault/);
    expect(f.sql.read("api_key_id", apiKeyIdKey("local-development"), NOW).value?.revoked_at_ms).toBe(NOW);
    expect(f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("local-development"), NOW).value).toMatchObject({
      local_deletion: { owner: null, completed_at_ms: null },
    });
    expect(audits(f)).toHaveLength(1);
    f.db.run("DROP TRIGGER synthetic_audit_fault");
    expect(await f.admin().call("deleteKey", {}, "atomic-delete")).toMatchObject({ kind: "applied" });
  } finally {
    f.db.close();
  }
});

test("legacy and foreign active local deletion tombstones never become retryable", async () => {
  const f = fixture(rawRecord("local-development"));
  try {
    await f.admin().call("revokeKey", {});
    for (const guardValue of [
      { created_at_ms: NOW },
      { created_at_ms: NOW, local_deletion: { owner: "other-owner", completed_at_ms: null } },
      { created_at_ms: NOW, local_deletion: { owner: "completed-owner", completed_at_ms: NOW } },
    ]) {
      f.sql.transaction(() => {
        f.sql.write("paid_deletion_guard", paidFallbackDeletionGuardV3Key("local-development"), guardValue);
      });
      expect(await f.admin().call("deleteKey", {})).toMatchObject({ kind: "refused", code: "paid_fallback_deletion_in_progress" });
      expect(f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("local-development"), NOW).value).toEqual(guardValue);
      expect(f.sql.read("api_key_id", apiKeyIdKey("local-development"), NOW).value).not.toBeNull();
    }
  } finally {
    f.db.close();
  }
});

test("native pricing errors preserve their mapping and pricing still precedes reset validation", async () => {
  const f = fixture();
  try {
    f.pricing(() => Promise.reject(new MeteredError("synthetic native pricing refusal", "metered_pricing_invalid", 503)));
    expect(await f.admin(null).call("createKey", { input: { name: "pricing", paid_fallback_enabled: true, paid_fallback_limit_credits: -1 } })).toMatchObject({
      kind: "refused",
      status: 503,
      code: "metered_pricing_invalid",
      message: "synthetic native pricing refusal",
    });
    f.pricing(() => Promise.resolve());
    expect(
      await f.admin().call("updateKey", { input: { paid_fallback_enabled: true, paid_fallback_limit_credits: -1, reset_usage: "invalid" } })
    ).toMatchObject({
      kind: "refused",
      status: 400,
      message: "reset_usage must be a boolean",
    });
    expect(f.calls.filter((call) => call === "pricing")).toHaveLength(2);
    expect(audits(f)).toHaveLength(0);
    expect(f.sql.read("api_key_id", apiKeyIdKey("key"), NOW).value?.paid_fallback_enabled).toBe(false);
  } finally {
    f.db.close();
  }
});

test("malformed durable grants fail closed before mutation or historical acknowledgment", async () => {
  const f = fixture();
  try {
    await f.admin().call("revokeKey", {}, "historical");
    f.db.run("UPDATE uos_native_key_control_grant SET row_json=json_remove(row_json,'$.revoked') WHERE row_key=?", [
      // The source row is real SQLite; no typed source seed claims the missing revoked field is valid.
      f.sql.page("key_control_grant", NOW, "", 100).find((entry) => entry.row.value?.id === "key_admin")?.encoded ?? "missing",
    ]);
    await assert.rejects(f.admin().call("revokeKey", {}, "historical"), /control_grant_denied/);
    expect(audits(f)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("native no-op and revocation administration do not invent a quota-migration prerequisite", async () => {
  const f = fixture();
  try {
    const record = { ...rawRecord(), usage_quota_version: 2 };
    f.sql.transaction(() => {
      f.sql.write("api_key_id", apiKeyIdKey(record.id), record);
      f.sql.write("api_key_hash", apiKeyHashKey(record.hash), apiKeyHashRecordFor(record));
    });
    expect(await f.admin().call("updateKey", { input: {} })).toMatchObject({ kind: "unchanged", detail: { usage_requests: 0 } });
    expect(await f.admin().call("revokeKey", {})).toMatchObject({ kind: "applied" });
    expect(await f.admin().call("unrevokeKey", {})).toMatchObject({ kind: "applied" });
    expect(await f.resolver().call("resolvePrincipal", {})).toMatchObject({ kind: "refused", status: 503, message: "API key quota migration is incomplete" });
    expect(await f.client().call("reserveApiUsage", { requestId: "migration", route: "/v1/responses", model: "fixture", stream: false })).toMatchObject({
      kind: "unauthorized",
    });
    expect(audits(f)).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test("review P1 original paid window remains charged when paid admission occurs after rollover", async () => {
  const f = fixture(rawRecord("key", true));
  try {
    f.clock.now = NOW + 59_000;
    const handles = await Promise.all(Array.from({ length: 6 }, (_, index) => apiReserve(f, `original-window-${index}`)));
    expect(await f.client().call("reservePaidAttempt", { handle: handles[0], hopId: "paid" })).toMatchObject({ kind: "reserved" });
    f.clock.now = NOW + 60_001;
    const first = await f.client().call("reservePaidAttempt", { handle: handles[1], hopId: "paid" });
    const attempt = f.sql.read("attempt_lifetime", [required(first.attemptHandle)], f.clock.now).value;
    console.log(
      JSON.stringify({ regression: "P1-original-window", requestCreatedAtMs: NOW + 59_000, reservedAtMs: f.clock.now, actualReset: attempt?.windowResetAtMs })
    );
    expect(attempt?.windowResetAtMs).toBe(NOW + 60_000);
    for (const handle of handles.slice(2, 5))
      expect(await f.client().call("reservePaidAttempt", { handle, hopId: "paid" })).toMatchObject({ kind: "reserved" });
    expect(await f.client().call("reservePaidAttempt", { handle: handles[5], hopId: "paid" })).toMatchObject({ kind: "blocked", detail: "limit_exceeded" });
    const following = await apiReserve(f, "following-window");
    expect(await f.client().call("reservePaidAttempt", { handle: following, hopId: "paid" })).toMatchObject({ kind: "reserved" });
    expect(f.sql.read("paid_window", paidFallbackWindowV3Key("key", NOW + 60_000), f.clock.now).value).toMatchObject({ reserved_microcredits: 200 });
    expect(f.sql.read("paid_window", paidFallbackWindowV3Key("key", NOW + 120_000), f.clock.now).value).toMatchObject({ reserved_microcredits: 40 });
  } finally {
    f.db.close();
  }
});

test("review P1 concurrent deletion replay cannot complete while original cleanup effects remain active", async () => {
  const f = fixture(rawRecord("local-development")),
    paused = barrier();
  let cleanupCalls = 0,
    originalEffectsSettled = false;
  const pending: Promise<NativeControlReply>[] = [];
  try {
    await f.admin().call("revokeKey", {});
    f.cleanup(async () => {
      cleanupCalls++;
      if (cleanupCalls === 1) {
        await paused.hook();
        originalEffectsSettled = true;
      }
    });
    pending.push(f.admin().call("deleteKey", {}, "cleanup-race"));
    await paused.ready;
    // A resolved observational hook marks a real SQLite receipt read. Its following
    // synchronous path has entered cleanup before the next event-loop check.
    let receiptObserved = () => {};
    const observed = new Promise<void>((resolve) => {
      receiptObserved = resolve;
    });
    f.observeSql((query) => {
      if (query.startsWith("SELECT row_json,revision,expires_at_ms FROM uos_native_key_control_receipt")) receiptObserved();
    });
    pending.push(f.admin().call("deleteKey", {}, "cleanup-race"));
    await observed;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const guard = f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("local-development"), NOW).value;
    console.log(JSON.stringify({ regression: "P1-cleanup-owner", cleanupCalls, originalEffectsSettled, guard }));
    expect(originalEffectsSettled).toBe(false);
    expect(guard).toMatchObject({ local_deletion: { completed_at_ms: null } });
    expect(cleanupCalls).toBe(1);
    paused.release();
    const results = await Promise.all(pending);
    expect(results.map((reply) => reply.kind)).toEqual(["applied", "historical_ack"]);
    expect(originalEffectsSettled).toBe(true);
    expect(f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("local-development"), NOW).value).toMatchObject({
      local_deletion: { completed_at_ms: NOW },
    });
    expect(audits(f).filter((entry) => entry.row.value?.action === "delete")).toHaveLength(1);
  } finally {
    paused.release();
    await Promise.allSettled(pending);
    f.db.close();
  }
});

test("review P2 failed preparation write recovers on the same authority and operation without reminting", async () => {
  const f = fixture();
  try {
    f.db.run(
      "CREATE TRIGGER synthetic_preparation_fault BEFORE INSERT ON uos_native_key_control_receipt WHEN json_extract(NEW.row_json,'$.prepared') IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic preparation fault'); END"
    );
    const args = { input: { name: "recoverable preparation" } };
    await assert.rejects(f.admin(null).call("createKey", args, "failed-preparation"), /synthetic preparation fault/);
    expect(f.sql.page("api_key_id", NOW, "", 100)).toHaveLength(1);
    expect(audits(f)).toHaveLength(0);
    expect(f.sql.page("key_control_receipt", NOW, "", 100)).toHaveLength(0);
    const before = [...f.calls];
    f.db.run("DROP TRIGGER synthetic_preparation_fault");
    const result = await f.admin(null).call("createKey", args, "failed-preparation");
    console.log(JSON.stringify({ regression: "P2-preparation-retry", kind: result.kind, sourceCallsAfterFailure: f.calls.slice(before.length) }));
    expect(result).toMatchObject({ kind: "applied", keyId: "synthetic-uuid-1" });
    expect(f.calls.slice(before.length)).toEqual(["audit-uuid", "release"]);
    expect(await f.admin(null).call("createKey", args, "failed-preparation")).toMatchObject({ kind: "historical_ack" });
    expect(audits(f)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("review P2 early source failure retries the same private token and preparation stages", async () => {
  const f = fixture();
  try {
    let attempts = 0;
    const owner = new NativeAuthority(storage(f.db), f.options, () => f.clock.now, {
      ...f.control,
      sources: {
        ...f.control.sources,
        hashToken: async (token) => {
          if (++attempts === 1) throw new Error("synthetic hash source unavailable");
          return await f.control.sources.hashToken(token);
        },
      },
    });
    const args = { input: { name: "recover source" } },
      client = f.admin(null, undefined, owner);
    await assert.rejects(client.call("createKey", args, "source-retry"), /synthetic hash source unavailable/);
    expect(await client.call("createKey", args, "source-retry")).toMatchObject({ kind: "applied", keyId: "synthetic-uuid-1" });
    expect(f.calls.filter((call) => call === "token")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "clock")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "defaults")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "uuid")).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(await client.call("createKey", args, "source-retry")).toMatchObject({ kind: "historical_ack" });
    expect(audits(f)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("review P1 joined cleanup failure remains pending and same-authority retry survives restart", async () => {
  const f = fixture(rawRecord("local-development")),
    paused = barrier();
  const pending: Promise<NativeControlReply>[] = [];
  try {
    await f.admin().call("revokeKey", {});
    let cleanupCalls = 0;
    f.cleanup(async () => {
      cleanupCalls++;
      await paused.hook();
      throw new Error("synthetic joined cleanup failure");
    });
    pending.push(f.admin().call("deleteKey", {}, "cleanup-failure"));
    await paused.ready;
    let receiptObserved = () => {};
    const observed = new Promise<void>((resolve) => {
      receiptObserved = resolve;
    });
    f.observeSql((query) => {
      if (query.startsWith("SELECT row_json,revision,expires_at_ms FROM uos_native_key_control_receipt")) receiptObserved();
    });
    pending.push(f.admin().call("deleteKey", {}, "cleanup-failure"));
    await observed;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    paused.release();
    const results = await Promise.allSettled(pending);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(cleanupCalls).toBe(1);
    const guard = required(f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("local-development"), NOW).value);
    expect(guard).toMatchObject({ local_deletion: { completed_at_ms: null } });
    f.cleanup(() => Promise.resolve());
    expect(await f.admin().call("deleteKey", {}, "cleanup-failure")).toMatchObject({ kind: "historical_ack" });
    expect(f.sql.read("paid_deletion_guard", paidFallbackDeletionGuardV3Key("local-development"), NOW).value).toMatchObject({
      local_deletion: { completed_at_ms: NOW },
    });
    const before = [...f.calls];
    expect(await f.admin("local-development", undefined, f.restart()).call("deleteKey", {}, "cleanup-failure")).toMatchObject({ kind: "historical_ack" });
    expect(f.calls).toEqual(before);
    expect(audits(f).filter((entry) => entry.row.value?.action === "delete")).toHaveLength(1);
  } finally {
    paused.release();
    await Promise.allSettled(pending);
    f.db.close();
  }
});
