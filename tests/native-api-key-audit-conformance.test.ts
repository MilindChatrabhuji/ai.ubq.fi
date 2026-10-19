import { test } from "bun:test";
import assert from "node:assert/strict";
import * as audit from "../src/authority/native-api-key-audit.ts";

// BEGIN SHARED_API_KEY_AUDIT_VECTORS
type AuditDecisions = Pick<typeof audit, "sanitizeApiKeyChangeFields" | "apiKeyChangeActorFromAuth" | "buildApiKeyChangeEvent" | "apiKeyChangeEventKey">;

const encodeAuditValue = (value: unknown): unknown => {
  if (value === undefined) return { type: "undefined" };
  if (typeof value === "number" && !Number.isFinite(value)) return { type: "number", value: String(value) };
  if (Object.is(value, -0)) return { type: "number", value: "-0" };
  if (Array.isArray(value)) return value.map(encodeAuditValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeAuditValue(entry)]));
  }
  return value;
};

const auditAuth = (kind: string, isSuperAdmin = false): NonNullable<audit.ApiKeyAuditContext["auth"]> =>
  ({
    ok: true,
    token: "synthetic-secret-never-persisted",
    method: { kind, user_id: "synthetic-user", handle: "synthetic-handle", is_admin: true, credential_count: 1 },
    is_super_admin: isSuperAdmin,
  }) as NonNullable<audit.ApiKeyAuditContext["auth"]>;

const traceAuditInput = (trace: string[], input: audit.ApiKeyChangeEventInput): audit.ApiKeyChangeEventInput =>
  new Proxy(input, {
    get(target, key, receiver) {
      trace.push("input:" + String(key));
      return Reflect.get(target, key, receiver);
    },
  });

export const runApiKeyAuditVectors = (decisions: AuditDecisions = audit): Record<string, unknown> => {
  const rows: Record<string, unknown> = {};
  const observe = (name: string, input: (trace: string[]) => audit.ApiKeyChangeEventInput, failure?: string): void => {
    const trace: string[] = [];
    const source = <T>(label: string, value: T): T => {
      trace.push(label);
      if (failure === label) throw new Error("synthetic-" + label);
      return value;
    };
    try {
      const event = decisions.buildApiKeyChangeEvent(traceAuditInput(trace, input(trace)), {
        randomUUID: () => source("uuid", "00000000-0000-4000-8000-000000000001"),
        now: () => source("clock", 1_800_000_000_000),
        release: () => source("release", "synthetic-release"),
      });
      rows[name] = { event: encodeAuditValue(event), key: encodeAuditValue(decisions.apiKeyChangeEventKey(event)), trace };
    } catch (error) {
      let detail = String(error);
      if (error instanceof Error) {
        detail = error.name;
        if (error.message.startsWith("synthetic-")) detail += ":" + error.message;
      }
      rows[name] = { error: detail, trace };
    }
  };
  observe("defaults", () => ({ action: "create", targetKeyId: "key-1" }));
  observe("explicit-zero-clock", () => ({ action: "update", targetKeyId: "key-1", targetKeyName: "", nowMs: 0 }));
  observe("explicit-nan-clock", () => ({ action: "update", targetKeyId: "key-1", nowMs: NaN }));
  observe("trimmed-request-and-name", () => ({
    action: "delete",
    targetKeyId: "key-1",
    targetKeyName: "😀".repeat(101),
    changed: { token: "must-drop", name: "n".repeat(201), reset_usage: true },
    context: { request_id: "  synthetic-request \n", auth: auditAuth("passkey_session", true) },
  }));
  observe("blank-request-falls-back-to-event-id", () => ({ action: "revoke", targetKeyId: "key-1", context: { request_id: " \t " } }));
  observe("lazy-property-order", (trace) => ({
    action: "unrevoke",
    targetKeyId: "key-1",
    context: new Proxy(
      { request_id: " r ", auth: auditAuth("disabled") },
      {
        get(target, key, receiver) {
          trace.push("context:" + String(key));
          return Reflect.get(target, key, receiver);
        },
      }
    ),
    changed: Object.defineProperty({}, "name", {
      enumerable: true,
      get() {
        trace.push("changed:name");
        return "safe";
      },
    }),
  }));
  observe("uuid-refusal", () => ({ action: "create", targetKeyId: "key-1" }), "uuid");
  observe("clock-refusal", () => ({ action: "create", targetKeyId: "key-1" }), "clock");
  observe("release-refusal", () => ({ action: "create", targetKeyId: "key-1", changed: { reset_usage: true } }), "release");
  observe("malformed-request-stops-before-clock", () => ({
    action: "create",
    targetKeyId: "key-1",
    context: { request_id: 5 as never },
  }));
  observe("sanitizer-refusal-stops-before-release", () => ({
    action: "create",
    targetKeyId: "key-1",
    changed: Object.defineProperty({}, "name", {
      get() {
        throw new Error("synthetic-field");
      },
    }),
  }));
  rows.actors = [
    undefined,
    { ok: false as const, response: new Response() },
    ...["passkey_session", "disabled", "admin_allowlist", "deno_deploy_token", "other"].flatMap((kind) => [auditAuth(kind), auditAuth(kind, true)]),
  ].map((auth) => decisions.apiKeyChangeActorFromAuth(auth));
  const inherited: Record<string, unknown> = Object.create({ name: "inherited-must-drop" });
  Object.defineProperty(inherited, "token", {
    get() {
      throw new Error("secret field was read");
    },
  });
  inherited.window_ms = 60_000;
  rows.inheritedAndSecret = decisions.sanitizeApiKeyChangeFields(inherited);
  const nullPrototype: Record<string, unknown> = Object.create(null);
  nullPrototype.name = "safe-null-prototype";
  rows.nullPrototype = decisions.sanitizeApiKeyChangeFields(nullPrototype);
  rows.scalarValues = [null, false, true, 0, -0, -1, 5.5, NaN, Infinity, -Infinity, "", "x".repeat(201), undefined, {}, [], 1n, Symbol("synthetic")].map(
    (value) => encodeAuditValue(decisions.sanitizeApiKeyChangeFields({ name: value, expires_at_ms: value, unexpected: "must-drop" }))
  );
  rows.safeFieldOrder = Object.keys(
    decisions.sanitizeApiKeyChangeFields({
      revoked_at_ms: 0,
      reset_usage: false,
      paid_fallback_limit_credits: null,
      paid_fallback_enabled: true,
      window_ms: 60_000,
      usage_limit_requests: -1,
      expires_at_ms: -1,
      name: "ordered",
    })
  );
  rows.keyEdges = [-1, 0, -0, 1_800_000_000_000, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity].map((atMs) =>
    encodeAuditValue(decisions.apiKeyChangeEventKey({ at_ms: atMs, id: "id" }))
  );
  return rows;
};

export const runApiKeyAuditReadVectors = (): Record<string, unknown> => {
  const cutoff = 1_800_000_000_000 - audit.API_KEY_CHANGE_RETENTION_MS;
  const retention = [
    null,
    undefined,
    {},
    { at_ms: String(cutoff) },
    { at_ms: cutoff - 1 },
    { at_ms: cutoff },
    { at_ms: Infinity },
    { at_ms: NaN },
    Object.assign([], { at_ms: cutoff }),
  ].map((value) => audit.isRetainedApiKeyChangeEvent(value, cutoff));
  const limits = [null, "1", " 02 ", "999", "", " ", "0", "-1", "1e2", "1.0", "9007199254740992"].map((raw) => audit.parseApiKeyChangeLimit(raw));
  return { retention, limits, ttl: audit.API_KEY_CHANGE_RETENTION_MS, days: audit.API_KEY_CHANGE_RETENTION_DAYS };
};
// END SHARED_API_KEY_AUDIT_VECTORS

test("native audit event fields, IDs, actor attribution and lazy source order remain exact", () => {
  const rows = runApiKeyAuditVectors();
  const defaults = rows.defaults as { event: audit.ApiKeyChangeEvent; key: unknown[]; trace: string[] };
  assert.deepEqual(defaults.event, {
    id: "00000000-0000-4000-8000-000000000001",
    at_ms: 1_800_000_000_000,
    action: "create",
    actor: { kind: "unknown", principal_id: null, principal_label: null, is_super_admin: false },
    target_key_id: "key-1",
    target_key_name: null,
    changed: {},
    request_id: "00000000-0000-4000-8000-000000000001",
    release: "synthetic-release",
  });
  assert.deepEqual(defaults.key, ["uos_ai", "api_keys", "change", Number.MAX_SAFE_INTEGER - 1_800_000_000_000, defaults.event.id]);
  assert.deepEqual(defaults.trace, [
    "uuid",
    "input:context",
    "input:nowMs",
    "clock",
    "input:action",
    "input:context",
    "input:targetKeyId",
    "input:targetKeyName",
    "input:changed",
    "release",
  ]);
  assert.equal((rows["explicit-zero-clock"] as typeof defaults).event.at_ms, 0);
  assert.equal((rows["explicit-zero-clock"] as typeof defaults).trace.includes("clock"), false);
  assert.equal((rows["explicit-nan-clock"] as typeof defaults).trace.includes("clock"), false);
  assert.deepEqual((rows["uuid-refusal"] as { trace: string[] }).trace, ["uuid"]);
  assert.deepEqual((rows["clock-refusal"] as { trace: string[] }).trace, ["uuid", "input:context", "input:nowMs", "clock"]);
  assert.equal((rows["malformed-request-stops-before-clock"] as { trace: string[] }).trace.includes("clock"), false);
  assert.equal((rows["sanitizer-refusal-stops-before-release"] as { trace: string[] }).trace.includes("release"), false);
  const named = (rows["trimmed-request-and-name"] as typeof defaults).event;
  assert.equal(named.request_id, "synthetic-request");
  assert.equal(named.target_key_name?.length, 200);
  assert.deepEqual(named.changed, { name: "n".repeat(200), reset_usage: true });
  assert.deepEqual(named.actor, { kind: "passkey_user", principal_id: "synthetic-user", principal_label: "synthetic-handle", is_super_admin: true });
  assert.equal((rows["blank-request-falls-back-to-event-id"] as typeof defaults).event.request_id, defaults.event.id);
});

test("native audit sanitization preserves own scalar values and source allowlist order", () => {
  const rows = runApiKeyAuditVectors();
  assert.deepEqual(rows.inheritedAndSecret, { window_ms: 60_000 });
  assert.deepEqual(rows.nullPrototype, { name: "safe-null-prototype" });
  assert.deepEqual(rows.safeFieldOrder, [
    "name",
    "expires_at_ms",
    "usage_limit_requests",
    "window_ms",
    "paid_fallback_enabled",
    "paid_fallback_limit_credits",
    "reset_usage",
    "revoked_at_ms",
  ]);
  const scalar = rows.scalarValues as unknown[];
  assert.deepEqual(scalar[0], { name: null, expires_at_ms: null });
  assert.deepEqual(scalar[4], { name: { type: "number", value: "-0" }, expires_at_ms: { type: "number", value: "-0" } });
  for (const index of [7, 8, 9, 12, 13, 14, 15, 16]) assert.deepEqual(scalar[index], {});
  const actors = rows.actors as audit.ApiKeyChangeActor[];
  assert.equal(actors[0].kind, "unknown");
  assert.equal(actors[1].kind, "unknown");
  assert.deepEqual(
    actors.slice(2).map((actor) => actor.kind),
    [
      "passkey_user",
      "passkey_user",
      "local_admin",
      "local_admin",
      "shared_admin_credential",
      "shared_admin_credential",
      "shared_admin_credential",
      "shared_admin_credential",
      "shared_admin_credential",
      "shared_admin_credential",
    ]
  );
  assert.equal(JSON.stringify(actors).includes("synthetic-secret"), false);
});

test("native audit retention and bounded limits preserve cutoff and malformed input decisions", () => {
  assert.equal(audit.API_KEY_CHANGE_RETENTION_DAYS, 90);
  assert.equal(audit.API_KEY_CHANGE_RETENTION_MS, 7_776_000_000);
  const cutoff = 1_800_000_000_000 - audit.API_KEY_CHANGE_RETENTION_MS;
  for (const [value, retained] of [
    [null, false],
    [undefined, false],
    [{}, false],
    [{ at_ms: String(cutoff) }, false],
    [{ at_ms: cutoff - 1 }, false],
    [{ at_ms: cutoff }, true],
    [{ at_ms: Infinity }, true],
    [{ at_ms: NaN }, false],
  ] as const) {
    assert.equal(audit.isRetainedApiKeyChangeEvent(value, cutoff), retained);
  }
  assert.equal(audit.isRetainedApiKeyChangeEvent(Object.assign([], { at_ms: cutoff }), cutoff), true);
  for (const [raw, expected] of [
    [null, 20],
    ["1", 1],
    [" 02 ", 2],
    ["999", 50],
    ["", null],
    [" ", null],
    ["0", null],
    ["-1", null],
    ["1e2", null],
    ["1.0", null],
    ["9007199254740992", null],
  ] as const) {
    assert.equal(audit.parseApiKeyChangeLimit(raw), expected);
  }
  assert.deepEqual(runApiKeyAuditReadVectors(), {
    retention: [false, false, false, false, false, true, true, false, true],
    limits: [20, 1, 2, 50, null, null, null, null, null, null, null],
    ttl: 7_776_000_000,
    days: 90,
  });
});
