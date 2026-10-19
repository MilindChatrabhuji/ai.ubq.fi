import { apiKeyHashKey, apiKeyIdKey, DEFAULT_USAGE_LIMIT_REQUESTS, getDefaultExpiryMs } from "../../../src/api-keys.ts";
import { apiKeyHashRecordFor, apiKeyPolicyFromHashRecord } from "../../../src/authority/native-api-key-policy.ts";
import { NativeAuthority } from "../../../src/authority/native-authority.ts";
import { NativeAuthoritySql } from "../../../src/authority/native-authority-sql.ts";
import { NativeAuthorityClient, NativeAuthorityRpcServer, NativePrincipalControlServer } from "../../../src/authority/native-authority-rpc.ts";
import { paidFallbackDeletionGuardV3Key } from "../../../src/authority/native-paid.ts";

export const CONTROL_CASE_IDS = Array.from({ length: 28 }, (_, index) => "P" + String(index + 1).padStart(2, "0"));
const LOCAL_CASES = ["P13", "P18", "P19", "P24", "P27"];
const NATIVE_PAID_DEFAULTS = {
  paid_fallback_enabled: false,
  paid_fallback_limit_microcredits: 0,
  paid_fallback_spent_microcredits: 0,
  paid_fallback_reserved_microcredits: 0,
  paid_fallback_reservation_request_id: null,
  paid_fallback_model_ids: [],
  paid_fallback_quota_per_credit: 0,
  paid_fallback_max_exposure_microcredits: {},
  paid_fallback_pricing_checked_at_ms: null,
};
export const nativeBindingSnapshot = (now) => ({
  localDevelopmentKeyId: "local-development",
  defaults: { expiryMs: getDefaultExpiryMs(now), usageLimitRequests: DEFAULT_USAGE_LIMIT_REQUESTS },
  defaultPaidPolicy: structuredClone(NATIVE_PAID_DEFAULTS),
  pricingFailure: { kind: "refused", status: 503, message: "synthetic native pricing refusal", code: "metered_pricing_invalid" },
  unknownPricingFailure: { kind: "refused", status: 502, message: "Failed to initialize Metered paid fallback", code: "metered_pricing_unavailable" },
});
const rawRecord = (id, now, paid) => ({
  id,
  name: "fixture",
  prefix: "u_synthetic",
  hash: "synthetic-control-hash",
  created_at_ms: now,
  expires_at_ms: -1,
  revoked_at_ms: null,
  usage_limit_requests: 20,
  usage_requests: 0,
  usage_reset_at_ms: now + 60_000,
  window_ms: 60_000,
  usage_quota_version: 3,
  ...structuredClone(NATIVE_PAID_DEFAULTS),
  ...(paid
    ? {
        paid_fallback_enabled: true,
        paid_fallback_limit_microcredits: 200,
        paid_fallback_model_ids: ["fixture"],
        paid_fallback_quota_per_credit: 100,
        paid_fallback_max_exposure_microcredits: { fixture: 40 },
        paid_fallback_pricing_checked_at_ms: now,
      }
    : {}),
});
const injectedFault = (error) =>
  /synthetic (?:audit fault|preparation fault|hash source unavailable|joined cleanup failure|cleanup crash)/.test(String(error?.message));

/** Test-only private source bindings. Every SQL operation uses the actual DO storage. */
export class PrincipalControlFixture {
  constructor(ctx, owner, seed, fixedNow, epoch) {
    Object.assign(this, { ctx, owner, seed, fixedNow, epoch });
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS uos_fixture_control (id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS uos_fixture_control_logs (request_id TEXT PRIMARY KEY, key_id TEXT NOT NULL)");
    this.state = ctx.storage.sql
      .exec("SELECT state_json FROM uos_fixture_control WHERE id=1")
      .toArray()
      .map((row) => JSON.parse(row.state_json))[0];
    this.barriers = new Map();
    this.active = 0;
    if (this.state) this.start();
  }
  authorize(owner) {
    if (owner !== this.owner) throw new Error("fixture principal owner denied");
  }
  flush() {
    this.ctx.storage.sql.exec("UPDATE uos_fixture_control SET state_json=? WHERE id=1", JSON.stringify(this.state));
  }
  trace(stage) {
    this.state.calls.push(stage);
  }
  async pause(stage) {
    const barrier = this.barriers.get(stage);
    if (barrier) {
      barrier.entered++;
      await barrier.wait;
      barrier.settled++;
    }
  }
  setup(owner, scenario) {
    this.authorize(owner);
    if (!CONTROL_CASE_IDS.includes(scenario)) throw new Error("fixture principal scenario denied");
    if (this.state && this.state.scenario !== scenario) throw new Error("fixture principal namespace mismatch");
    if (!this.state) {
      this.state = {
        scenario,
        now: this.fixedNow,
        calls: [],
        uuid: 0,
        cleanupCalls: 0,
        cleanupSettled: 0,
        cleanupObservations: [],
        verifications: [],
        controls: [],
        modes: {},
        clients: { bun: 0, worker: 0 },
        failures: [],
        observations: [],
      };
      this.ctx.storage.sql.exec("INSERT INTO uos_fixture_control VALUES(1,?)", JSON.stringify(this.state));
      this.start();
    }
    return this.evidence(owner);
  }
  start() {
    const now = this.fixedNow;
    this.keyId = LOCAL_CASES.includes(this.state.scenario) ? "local-development" : "key";
    const paid = ["P11", "P12", "P13", "P23", "P28"].includes(this.state.scenario);
    this.original = rawRecord(this.keyId, now, paid);
    if (this.state.scenario === "P07")
      Object.assign(this.original, { paid_fallback_reserved_microcredits: 17, paid_fallback_reservation_request_id: "pending-original" });
    const seed = {
      ...this.seed,
      namespace: "synthetic-principal-control:" + this.ctx.id.toString(),
      capabilities: ["control", "foreign"].map((id) => ({
        id,
        epoch: this.epoch,
        principalId: id === "control" ? "p" : "foreign",
        keyId: this.keyId,
        tokenHash: this.original.hash,
        kernel: { owner: "control-org", repo: "repo" },
        roles: ["inference", "transport", "terminal", "billing", "reconcile", "observer"],
        revoked: false,
      })),
      keys: [
        {
          api: apiKeyPolicyFromHashRecord(this.original.hash, apiKeyHashRecordFor(this.original), now),
          revoked: false,
          paid: {
            policyVersion: "60000:" + (paid ? now : 0),
            quotaPerCredit: this.original.paid_fallback_quota_per_credit,
            modelExposure: this.original.paid_fallback_max_exposure_microcredits,
            eligibleModels: this.original.paid_fallback_model_ids,
            allowUnrosteredUnlimited: true,
          },
        },
      ],
      kernelDefaults: { limit: 20, windowMs: 60_000 },
      pool: { identities: [], selectedAccountHashes: [], policies: {} },
      owners: [],
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
    if (this.state.scenario === "P28")
      seed.capabilities.push({
        id: "p28-retention-admin",
        epoch: this.epoch,
        principalId: "p28-retention-admin",
        keyId: this.keyId,
        tokenHash: this.original.hash,
        kernel: { owner: "control-org", repo: "repo" },
        roles: ["quota_admin"],
        revoked: false,
      });
    const clock = () => this.state.now;
    const grant = (role) => ({
      id: role,
      epoch: this.epoch,
      subjectId: role,
      contextBinding: role,
      roles: [role],
      expiresAtMs: now + 366 * 86_400_000,
      revoked: false,
      targetKeyIds: null,
    });
    this.grant = grant;
    const sources = {
      localDevelopmentKeyId: nativeBindingSnapshot(now).localDevelopmentKeyId,
      defaults: (at) => {
        this.trace("defaults");
        return nativeBindingSnapshot(at).defaults;
      },
      defaultPaidPolicy: () => structuredClone(NATIVE_PAID_DEFAULTS),
      generateToken: () => {
        this.trace("token");
        return "u_" + "b".repeat(64);
      },
      hashToken: async (token) => {
        this.trace("hash");
        if (this.state.modes.hashFailure) throw new Error("synthetic hash source unavailable");
        return "synthetic-" + token.slice(2, 10);
      },
      randomUUID: () => {
        this.trace("uuid");
        return "synthetic-uuid-" + ++this.state.uuid;
      },
      audit: {
        now: () => {
          this.trace("clock");
          return clock();
        },
        randomUUID: () => {
          this.trace("audit-uuid");
          return "synthetic-audit-" + ++this.state.uuid;
        },
        release: () => {
          this.trace("release");
          return "synthetic-release";
        },
      },
      initializePricing: async () => {
        this.trace("pricing");
        await this.pause("pricing");
        if (this.state.modes.pricingFailure) throw new Error(this.state.modes.pricingFailure);
        return {
          paid_fallback_model_ids: ["fixture"],
          paid_fallback_quota_per_credit: 100,
          paid_fallback_max_exposure_microcredits: { fixture: 40 },
          paid_fallback_pricing_checked_at_ms: clock(),
        };
      },
      pricingFailure: () => nativeBindingSnapshot(now)[this.state.modes.pricingFailure === "native" ? "pricingFailure" : "unknownPricingFailure"],
      ...(this.state.modes.noUnrostered ? {} : { allowUnrosteredUnlimited: () => false }),
      cleanupApiLogs: async () => {
        this.trace("logs-cleanup");
        this.state.cleanupCalls++;
        const e = this.rows();
        this.state.cleanupObservations.push({
          idAbsent: !e.api_key_id.length,
          hashAbsent: !e.api_key_hash.length,
          projectionAbsent: !e.api_policy.length,
          apiRows: e.api_request.length,
          deleteAudits: e.api_key_audit.filter((row) => row.value.action === "delete").length,
          logRows: this.logRows(),
        });
        await this.pause("cleanup");
        if (this.state.modes.cleanupFailure) throw new Error("synthetic joined cleanup failure");
        this.ctx.storage.sql.exec("DELETE FROM uos_fixture_control_logs WHERE key_id=?", this.keyId);
        this.state.cleanupSettled++;
      },
    };
    this.authority = new NativeAuthority(this.ctx.storage, seed, clock, {
      grants: [grant("key_admin"), grant("principal_resolver")],
      records: [{ record: this.original, hashRecord: apiKeyHashRecordFor(this.original) }],
      sources,
      verifier: {
        verify: async (context, intentDigest, authorityNow) => {
          await this.pause("verification");
          const profile = context.profile;
          const resolver = profile === "resolver";
          const kind = resolver ? "principal_resolver" : "key_admin";
          const identity = {
            subjectId: profile === "wrong-subject" ? "untrusted" : kind,
            contextBinding: kind,
            intentDigest: profile === "wrong-digest" ? "wrong" : intentDigest,
          };
          this.state.verifications.push({ profile, kind, intentDigest, authorityNow, targetKeyId: resolver ? null : context.target });
          if (resolver) return { ...identity, kind, principalId: "p", tokenHash: this.original.hash };
          return {
            ...identity,
            kind,
            targetKeyId: context.target,
            createToken: context.token,
            auditContext: {
              request_id: "safe-correlation",
              auth: { ok: true, token: "synthetic-private-admin", is_super_admin: true, method: { kind: "disabled" } },
            },
          };
        },
      },
    });
    this.sql = new NativeAuthoritySql(this.ctx.storage, seed.namespace, this.epoch);
  }
  binding(profile) {
    const profiles = [
      "admin",
      "create",
      "resolver",
      "other-target",
      "wrong-context",
      "wrong-subject",
      "wrong-digest",
      "wrong-role",
      "private-token",
      "invalid-token",
    ];
    if (!profiles.includes(profile)) throw new Error("fixture principal profile denied");
    const resolver = profile === "resolver",
      role = resolver ? "principal_resolver" : "key_admin";
    return {
      grantId: profile === "wrong-role" ? "principal_resolver" : role,
      contextBinding: profile === "wrong-context" ? "principal_resolver" : role,
      privateContext: {
        profile,
        target: ["create", "private-token", "invalid-token"].includes(profile) ? null : profile === "other-target" ? "another-key" : this.keyId,
        ...(profile === "private-token" ? { token: "u_" + "c".repeat(64) } : profile === "invalid-token" ? { token: "invalid" } : {}),
      },
    };
  }
  async control(profile, command, clientType) {
    this.state.clients[clientType]++;
    this.active++;
    try {
      const reply = await new NativePrincipalControlServer(this.authority, this.binding(profile)).control(command);
      this.state.controls.push({ profile, operationId: command.operationId, method: command.method, reply });
      return reply;
    } catch (error) {
      if (!injectedFault(error)) throw error;
      const fault = { message: error.message };
      this.state.failures.push(fault);
      return { fixtureFault: fault };
    } finally {
      this.active--;
      this.flush();
    }
  }
  rows() {
    const tables = [
      "capability",
      "api_key_id",
      "api_key_hash",
      "api_policy",
      "api_key_audit",
      "key_control_grant",
      "key_control_receipt",
      "principal_resolution",
      "api_window",
      "api_request",
      "request_lifetime",
      "attempt_lifetime",
      "operation_receipt",
      "paid_window",
      "paid_request",
      "paid_pending",
      "paid_deletion_guard",
      "paid_rollup",
      "paid_lease",
      "kernel_reservation",
    ];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        this.ctx.storage.sql
          .exec(`SELECT key_json,row_json,revision,expires_at_ms FROM uos_native_${table} ORDER BY row_key`)
          .toArray()
          .map((row) => ({ key: JSON.parse(row.key_json), value: JSON.parse(row.row_json), revision: row.revision, expiresAtMs: row.expires_at_ms })),
      ])
    );
  }
  evidence(owner) {
    this.authorize(owner);
    this.flush();
    const rows = this.rows(),
      guard = rows.paid_deletion_guard[0]?.value;
    return {
      scenario: this.state.scenario,
      doId: this.ctx.id.toString(),
      now: this.state.now,
      keyId: this.keyId,
      rows,
      logRows: this.logRows(),
      visibleCounts: Object.fromEntries(
        ["api_key_id", "api_key_hash", "api_key_audit", "api_request", "api_window", "paid_rollup", "paid_deletion_guard"].map((family) => [
          family,
          this.sql.page(family, this.state.now, "", 100).length,
        ])
      ),
      ...structuredClone(this.state),
      active: this.active,
      bindings: nativeBindingSnapshot(this.fixedNow),
      reprovisionEligible:
        !rows.api_key_id.length &&
        guard?.local_deletion?.completed_at_ms !== null &&
        typeof guard?.local_deletion?.completed_at_ms === "number" &&
        !rows.api_request.length &&
        !rows.api_window.length &&
        !rows.paid_request.length &&
        !rows.paid_window.length &&
        !rows.paid_pending.length &&
        !rows.paid_lease.length &&
        this.logRows() === 0,
      barriers: Object.fromEntries([...this.barriers].map(([name, barrier]) => [name, { entered: barrier.entered, settled: barrier.settled }])),
    };
  }
  logRows() {
    return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM uos_fixture_control_logs WHERE key_id=?", this.keyId).one().n;
  }
  recordLog(requestId) {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO uos_fixture_control_logs VALUES(?,?)", requestId, this.keyId);
  }
  action(owner, action, value) {
    this.authorize(owner);
    if (action === "p28-begin-paid-key-deletion") {
      if (this.state.scenario !== "P28" || value !== undefined) throw new Error("fixture retention administrator action denied");
      return new NativeAuthorityClient(new NativeAuthorityRpcServer(this.authority, "p28-retention-admin"), this.epoch).call("beginPaidKeyDeletion", {});
    }
    const sql = this.sql,
      now = this.state.now,
      hashKey = apiKeyHashKey(this.original.hash),
      idKey = apiKeyIdKey(this.keyId);
    if (action === "clock") {
      if (!Number.isSafeInteger(value) || value < this.fixedNow || value > this.fixedNow + 100 * 86_400_000) throw new Error("fixture clock denied");
      this.state.now = value;
    } else if (action === "barrier") {
      if (!["cleanup", "pricing", "verification"].includes(value)) throw new Error("fixture barrier denied");
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      this.barriers.set(value, { wait, release, entered: 0, settled: 0 });
    } else if (action === "release") {
      const barrier = this.barriers.get(value);
      if (!barrier) throw new Error("fixture barrier missing");
      barrier.release();
      this.barriers.delete(value);
    } else if (action === "mode") {
      if (!value || !["hashFailure", "pricingFailure", "cleanupFailure", "noUnrostered"].includes(value.name)) throw new Error("fixture mode denied");
      this.state.modes[value.name] = value.value;
      if (value.name === "noUnrostered") this.start();
    } else if (action === "fault") {
      const names = ["audit", "preparation"];
      if (!names.includes(value.name)) throw new Error("fixture SQL fault denied");
      const table = value.name === "audit" ? "api_key_audit" : "key_control_receipt";
      const when = value.name === "audit" ? "" : " WHEN json_extract(NEW.row_json,'$.prepared') IS NOT NULL";
      this.ctx.storage.sql.exec(
        value.enabled
          ? `CREATE TRIGGER synthetic_${value.name}_fault BEFORE INSERT ON uos_native_${table}${when} BEGIN SELECT RAISE(ABORT,'synthetic ${value.name} fault'); END`
          : `DROP TRIGGER synthetic_${value.name}_fault`
      );
    } else if (action === "raw") {
      const patches = {
        restore: {},
        revoke: { revoked_at_ms: now },
        expired: { expires_at_ms: now },
        "quota-v2": { usage_quota_version: 2 },
        "invalid-paid": { paid_fallback_limit_microcredits: -2 },
        rename: { name: "new-source-name" },
      };
      sql.transaction(() => {
        if (value === "remove-id") sql.delete("api_key_id", idKey);
        else if (value === "remove-h") sql.delete("api_key_hash", hashKey);
        else if (Object.hasOwn(patches, value)) {
          const record = { ...this.original, ...patches[value] };
          if (value === "rename" || value === "quota-v2") sql.write("api_key_id", idKey, record);
          sql.write("api_key_hash", hashKey, apiKeyHashRecordFor(record));
        } else throw new Error("fixture raw transition denied");
      });
    } else if (action === "grant") {
      const patches = {
        restore: {},
        revoked: { revoked: true },
        expired: { expiresAtMs: now },
        epoch: { epoch: "wrong-epoch" },
        role: { roles: ["principal_resolver"] },
        target: { targetKeyIds: ["another-key"] },
        subject: { subjectId: "foreign" },
        context: { contextBinding: "foreign" },
      };
      if (value === "malformed")
        this.ctx.storage.sql.exec(
          "UPDATE uos_native_key_control_grant SET row_json=json_remove(row_json,'$.revoked') WHERE json_extract(row_json,'$.id')='key_admin'"
        );
      else if (Object.hasOwn(patches, value))
        sql.transaction(() => sql.write("key_control_grant", ["key_admin"], { ...this.grant("key_admin"), ...patches[value] }));
      else throw new Error("fixture grant transition denied");
    } else if (action === "guard") {
      const guards = {
        legacy: { created_at_ms: now },
        foreign: { created_at_ms: now, local_deletion: { owner: "other-owner", completed_at_ms: null } },
        completed: { created_at_ms: now, local_deletion: { owner: "completed-owner", completed_at_ms: now } },
      };
      if (!Object.hasOwn(guards, value)) throw new Error("fixture guard denied");
      sql.transaction(() => sql.write("paid_deletion_guard", paidFallbackDeletionGuardV3Key(this.keyId), guards[value], null, { scope: this.keyId }));
    } else if (action === "missing-lifetime") {
      const row = sql.page("request_lifetime", now, "", 100).find((entry) => entry.row.value.requestId === "identity-missing");
      if (!row) throw new Error("fixture missing identity setup denied");
      sql.transaction(() => sql.delete("request_lifetime", row.key));
    } else throw new Error("fixture principal action denied");
    this.flush();
    return this.evidence(owner);
  }
}
