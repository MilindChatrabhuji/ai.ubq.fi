import { NativeAuthorityError } from "../../../src/authority/native-authority-contracts.ts";
import { API_KEY_USAGE_PROVIDERS, currentApiKeyUsageWindow, planApiKeyUsageReservation } from "../../../src/authority/native-api-key.ts";
import { apiKeyHashKey, apiKeyIdKey, DEFAULT_USAGE_LIMIT_REQUESTS, getDefaultExpiryMs } from "../../../src/api-keys.ts";
import { apiKeyHashRecordFor, apiKeyPolicyFromHashRecord } from "../../../src/authority/native-api-key-policy.ts";
import { NativeAuthority } from "../../../src/authority/native-authority.ts";
import { NativeAuthoritySql, nativeKey } from "../../../src/authority/native-authority-sql.ts";
import {
  NativeAuthorityClient,
  NativeAuthorityRpcServer,
  NativePrincipalControlServer,
  NativePrincipalControlClient,
} from "../../../src/authority/native-authority-rpc.ts";
import * as paidRows from "../../../src/authority/native-paid.ts";

/**
 * Restore synthetic predecessor accounting data; this never opens a request or grants an inference identity.
 * @param {import("../../../src/authority/native-authority-contracts.ts").NativeAuthorityInitial} seed
 * @param {import("../../../src/authority/native-authority-contracts.ts").NativeSqlStorage} storage
 * @param {()=>number} clock
 * @param {readonly { id: string; principalId: string; keyId: string; requestIds: readonly string[] }[]} histories
 */
export const syntheticRetainedHistory = (seed, storage, clock, histories) => {
  const sql = new NativeAuthoritySql(storage, seed.namespace, seed.epoch);
  const requests = histories.flatMap((history) =>
    history.requestIds.map((requestId) => ({ ...history, requestId, handle: "retained-request:" + history.id + ":" + requestId }))
  );
  /** @type {import("../../../src/authority/native-runtime-contracts.ts").NativeRetainedHistoryGrant[]} */
  const grants = histories.map((history) => ({
    id: "retained-grant:" + history.id,
    revision: 3,
    epoch: seed.epoch,
    subjectId: "retained-source:" + history.id,
    contextBinding: "retained-context:" + history.id,
    roles: ["transport", "billing", "reconcile"],
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    revoked: false,
    namespace: seed.namespace,
    originalBindingId: history.id,
    originalPrincipalId: history.principalId,
    keyId: history.keyId,
    requestHandles: requests.filter((request) => request.id === history.id).map((request) => request.handle),
  }));
  return {
    initial: {
      grants,
      verifier: {
        verify: async (context, intentDigest) => {
          const grant = grants.find((candidate) => candidate.id === context?.retainedGrant);
          if (!grant) throw new NativeAuthorityError("synthetic_retained_source_denied", 403);
          return {
            grantId: grant.id,
            epoch: grant.epoch,
            subjectId: grant.subjectId,
            contextBinding: grant.contextBinding,
            namespace: grant.namespace,
            originalBindingId: grant.originalBindingId,
            originalPrincipalId: grant.originalPrincipalId,
            keyId: grant.keyId,
            requestHandles: grant.requestHandles,
            intentDigest,
          };
        },
      },
    },
    /** @returns {import("../../../src/authority/native-runtime-contracts.ts").NativeRetainedHistoryBinding} */
    binding: (id) => {
      const grant = grants.find((candidate) => candidate.originalBindingId === id);
      if (!grant) throw new NativeAuthorityError("synthetic_retained_source_denied", 403);
      return { kind: "retained_history", grantId: grant.id, contextBinding: grant.contextBinding, privateContext: { retainedGrant: grant.id } };
    },
    restore: () =>
      sql.transaction(() => {
        for (const original of requests) {
          const prior = sql.read("request_lifetime", [original.handle], clock()).value;
          if (prior) {
            if (prior.runtimeBindingId !== original.id || prior.principalId !== original.principalId || prior.keyId !== original.keyId)
              throw new Error("synthetic retained restoration conflicts with durable provenance");
            continue;
          }
          const now = clock(),
            source = seed.keys.find((key) => key.api.key_id === original.keyId),
            hop = seed.providerHops[0];
          if (!source || !hop) throw new Error("synthetic retained source missing");
          const window = currentApiKeyUsageWindow(source.api.usage_reset_at_ms, source.api.window_ms, now);
          const policy = { ...source.api, window_start_ms: window.start, usage_reset_at_ms: window.reset };
          const apiWindowKey = ["uos_ai", "api_key_usage", "v3", "window", policy.key_id, policy.policy_version, policy.window_start_ms];
          const apiRequestKey = [...apiWindowKey.slice(0, 3), "request", ...apiWindowKey.slice(4), original.requestId];
          const api = planApiKeyUsageReservation(
            policy,
            original.requestId,
            "/v1/responses",
            { request: null, window: sql.read("api_window", apiWindowKey, now).value },
            now
          );
          if (api.kind !== "write") throw new Error("synthetic retained API snapshot invalid");
          sql.write("api_request", apiRequestKey, api.request, now + api.expireIn, { scope: original.keyId, parent: nativeKey(apiWindowKey) });
          sql.write("api_window", apiWindowKey, api.window, now + api.expireIn, { scope: original.keyId });
          const billingRequestId = original.requestId + ":" + hop.billingSuffix,
            paidKey = paidRows.paidFallbackRequestV3Key(original.keyId, billingRequestId),
            paidWindowKey = paidRows.paidFallbackWindowV3Key(original.keyId, window.reset),
            attemptHandle = "retained-attempt:" + original.id + ":" + original.requestId;
          const paid = paidRows.planPaidFallbackAdmissionV3(
            {
              keyId: original.keyId,
              requestId: billingRequestId,
              createdAtMs: now,
              policyVersion: source.paid.policyVersion,
              limitMicrocredits: policy.paid_fallback_limit_microcredits,
              maximumExposureMicrocredits: source.paid.modelExposure.fixture,
              initialSettledMicrocredits: 0,
              quotaPerCredit: source.paid.quotaPerCredit,
              windowResetAtMs: window.reset,
              model: "fixture",
              route: "/v1/responses",
              path: "/v1/responses",
              stream: false,
              reasoning: null,
              dispatchIntent: true,
            },
            {
              request: sql.read("paid_request", paidKey, now),
              window: sql.read("paid_window", paidWindowKey, now),
              deletionGuard: sql.read("paid_deletion_guard", paidRows.paidFallbackDeletionGuardV3Key(original.keyId), now),
            },
            { unlimited: policy.paid_fallback_limit_microcredits === -1, maximumExposure: source.paid.modelExposure.fixture },
            now
          );
          if (paid.kind !== "write") throw new Error("synthetic retained paid snapshot invalid");
          sql.write("paid_request", paidKey, paid.request, now + paid.requestExpireIn, { scope: original.keyId });
          sql.write("paid_pending", paidRows.paidFallbackPendingV3Key(original.keyId, billingRequestId), paid.pending, null, {
            scope: original.keyId,
            due: paid.pending.next_reconciliation_at_ms,
          });
          if (paid.window) sql.write("paid_window", paidWindowKey, paid.window, now + paid.windowExpireIn, { scope: original.keyId });
          sql.write("paid_gate", paidRows.paidFallbackReconciliationGateV3Key(), paidRows.paidFallbackReconciliationGateDueNow({ value: null }, now));
          sql.write(
            "request_lifetime",
            [original.handle],
            {
              handle: original.handle,
              runtimeBindingId: original.id,
              principalId: original.principalId,
              keyId: original.keyId,
              requestId: original.requestId,
              route: "/v1/responses",
              path: "/v1/responses",
              model: "fixture",
              stream: false,
              reasoning: null,
              metadataBound: true,
              apiApplicable: true,
              kernelApplicable: false,
              createdAtMs: now,
              api: policy,
              kernel: null,
              routingDecision: null,
              codex: null,
              selection: null,
              codexProof: null,
              ownerFence: null,
              semantic: null,
              providerObserved: false,
              delivery: null,
              transport: null,
              responding: null,
              dispatch: null,
            },
            null,
            { scope: original.keyId, parent: nativeKey(apiRequestKey) }
          );
          sql.write(
            "attempt_lifetime",
            [attemptHandle],
            {
              handle: attemptHandle,
              runtimeBindingId: original.id,
              requestHandle: original.handle,
              principalId: original.principalId,
              keyId: original.keyId,
              hopId: hop.id,
              billingRequestId,
              windowResetAtMs: window.reset,
              fetchStarted: false,
            },
            null,
            { scope: original.keyId, parent: original.handle }
          );
        }
        return requests.map((request) => ({
          bindingId: request.id,
          handle: request.handle,
          attemptHandle: "retained-attempt:" + request.id + ":" + request.requestId,
        }));
      }),
  };
};

/**
 * Synthetic private source construction shared by local SQLite and real DO fixtures.
 * @param {import("../../../src/authority/native-authority-contracts.ts").NativeAuthorityInitial} seed
 * @param {readonly Pick<import("../../../src/authority/native-authority-contracts.ts").NativeCapability, "id"|"keyId"|"tokenHash"|"kernel"|"roles">[]} subjects
 * @param {import("../../../src/authority/native-authority-contracts.ts").NativeSqlStorage} storage
 * @param {()=>number} clock
 * @param {import("../../../src/authority/native-principal-contracts.ts").NativePrincipalControlInitial|null} baseControl
 */
export const syntheticRuntimeSources = (seed, subjects, storage, clock, baseControl = null) => {
  const records = seed.keys.map(({ api, paid }) => {
    const original = baseControl?.records.find(({ record }) => record.id === api.key_id);
    if (original) return original;
    const record = {
      id: api.key_id,
      name: "synthetic",
      prefix: "u_synthetic",
      hash: api.token_hash,
      created_at_ms: clock(),
      expires_at_ms: api.expires_at_ms,
      revoked_at_ms: null,
      usage_limit_requests: api.usage_limit_requests,
      usage_requests: 0,
      usage_reset_at_ms: api.usage_reset_at_ms,
      window_ms: api.window_ms,
      usage_quota_version: 3,
      paid_fallback_enabled: api.paid_fallback_enabled,
      paid_fallback_limit_microcredits: api.paid_fallback_limit_microcredits,
      paid_fallback_spent_microcredits: api.paid_fallback_spent_microcredits,
      paid_fallback_reserved_microcredits: api.paid_fallback_reserved_microcredits,
      paid_fallback_reservation_request_id: api.paid_fallback_reservation_request_id,
      paid_fallback_model_ids: [...paid.eligibleModels],
      paid_fallback_quota_per_credit: paid.quotaPerCredit,
      paid_fallback_max_exposure_microcredits: { ...paid.modelExposure },
      paid_fallback_pricing_checked_at_ms: 1,
    };
    return { record, hashRecord: apiKeyHashRecordFor(record) };
  });
  /** @type {import("../../../src/authority/native-runtime-contracts.ts").NativeRuntimeGrant[]} */
  const grants = subjects.map((subject) => ({
    id: subject.id,
    revision: 3,
    epoch: seed.epoch,
    subjectId: subject.id,
    contextBinding: subject.id,
    roles: subject.roles,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    revoked: false,
  }));
  const resolverGrant = (keyId) => "runtime-resolver:" + keyId;
  let authority;
  const sql = new NativeAuthoritySql(storage, seed.namespace, seed.epoch);
  const refs = new Map();
  /** @type {import("../../../src/authority/native-principal-contracts.ts").NativePrincipalControlInitial} */
  const control = {
    ...(baseControl ?? {}),
    grants: [
      ...(baseControl?.grants ?? []),
      ...records.map(({ record }) => ({
        id: resolverGrant(record.id),
        epoch: seed.epoch,
        subjectId: resolverGrant(record.id),
        contextBinding: resolverGrant(record.id),
        roles: ["principal_resolver"],
        expiresAtMs: Number.MAX_SAFE_INTEGER,
        revoked: false,
        targetKeyIds: null,
      })),
    ],
    records,
    sources: baseControl?.sources ?? {
      localDevelopmentKeyId: "synthetic-local",
      defaults: () => ({ expiryMs: -1, usageLimitRequests: 10 }),
      defaultPaidPolicy: () => structuredClone(NATIVE_PAID_DEFAULTS),
      generateToken: () => {
        throw new Error("unexpected synthetic create");
      },
      hashToken: async () => {
        throw new Error("unexpected synthetic hashing");
      },
      randomUUID: () => crypto.randomUUID(),
      audit: { now: clock, randomUUID: () => crypto.randomUUID(), release: () => "synthetic-runtime" },
      initializePricing: async () => {
        throw new Error("unexpected synthetic pricing");
      },
      pricingFailure: () => ({ kind: "refused", status: 503, code: "synthetic_pricing", message: "synthetic pricing unavailable" }),
      cleanupApiLogs: async () => {},
    },
    verifier: {
      verify: async (context, intentDigest, authorityNow) => {
        if (context?.runtimeKey) {
          const record = records.find((entry) => entry.record.id === context.runtimeKey)?.record;
          if (!record) throw new Error("synthetic runtime identity missing");
          return {
            kind: "principal_resolver",
            subjectId: resolverGrant(record.id),
            contextBinding: resolverGrant(record.id),
            intentDigest,
            principalId: "api-key:" + record.id,
            tokenHash: record.hash,
          };
        }
        if (!baseControl) throw new Error("synthetic control unavailable");
        return await baseControl.verifier.verify(context, intentDigest, authorityNow);
      },
    },
  };
  /** @type {import("../../../src/authority/native-runtime-contracts.ts").NativeRuntimeInitial} */
  const runtime = {
    grants,
    records: [],
    verifier: {
      verify: async (context, intentDigest) => {
        const subject = subjects.find((candidate) => candidate.id === context?.id);
        if (!subject || subject.keyId === null || subject.tokenHash === null) throw new Error("synthetic runtime subject denied");
        let principalRef = refs.get(subject.id);
        if (!principalRef) {
          const prior = sql
            .page("principal_resolution", clock(), "", 100, { scope: subject.keyId })
            .find((entry) => entry.row.value?.grantId === resolverGrant(subject.keyId))?.row.value;
          if (prior) principalRef = { id: prior.id, principalId: prior.principalId, keyId: prior.keyId, epoch: prior.epoch };
          else {
            const retained = sql.read("capability", [subject.id], clock()).value;
            if (retained?.principalRefId)
              principalRef = { id: retained.principalRefId, principalId: "api-key:" + subject.keyId, keyId: subject.keyId, epoch: seed.epoch };
            else {
              if (!authority) throw new Error("synthetic runtime not attached");
              const result = await new NativePrincipalControlClient(
                new NativePrincipalControlServer(authority, {
                  grantId: resolverGrant(subject.keyId),
                  contextBinding: resolverGrant(subject.keyId),
                  privateContext: { runtimeKey: subject.keyId },
                }),
                seed.epoch
              ).call("resolvePrincipal", {}, "runtime-reference:" + subject.id);
              const outcome = result.kind === "historical_ack" ? result.outcome : result;
              if (outcome.kind === "refused") throw new NativeAuthorityError(outcome.code, outcome.status);
              if (outcome.kind !== "principal") throw new NativeAuthorityError("synthetic_principal_resolution_invalid", 503);
              principalRef = outcome.principalRef;
            }
          }
          refs.set(subject.id, principalRef);
        }
        return {
          bindingId: subject.id,
          subjectId: subject.id,
          contextBinding: subject.id,
          intentDigest,
          identity: { kind: "kv_api_key", keyId: subject.keyId },
          api: { principalRef, tokenHash: subject.tokenHash },
          kernel: subject.kernel,
        };
      },
      verifyRouting: async (context, request, intentDigest) => {
        const subject = subjects.find((candidate) => candidate.id === context?.id);
        if (!subject) throw new Error("synthetic routing subject denied");
        const hops = sql.read("authority_config", ["config"], clock()).value?.providerHops ?? [];
        return {
          subjectId: subject.id,
          contextBinding: subject.id,
          intentDigest,
          sourceRevision: "synthetic-catalog-v3",
          cohort: "synthetic-cohort",
          codex: "eligible",
          providers: [...API_KEY_USAGE_PROVIDERS],
          allowUnrosteredModel: context.allowUnrosteredModel === true,
          hops: hops.map((hop) => ({ hopId: hop.id, authorization: hop.authorization, upstreamModel: request.model, billingModel: request.model })),
        };
      },
    },
  };
  return {
    runtime,
    control,
    attach: (owner) => {
      authority = owner;
    },
    binding: (id, allowUnrosteredModel = false) => ({ grantId: id, contextBinding: id, privateContext: { id, allowUnrosteredModel } }),
  };
};

/** Explicit v3 source phases; never an overload accepting a retired admission DTO. */
export const openSyntheticRequest = async (client, args, operationId = String(crypto.randomUUID())) => {
  const opened = await client.call(
    "openAuthenticatedRequest",
    { requestId: args.requestId, route: args.route, path: args.path ?? args.route },
    operationId + ":open"
  );
  if (!opened.handle) return opened;
  return await client.call("reserveApiUsage", { handle: opened.handle }, operationId + ":api");
};
export const bindSyntheticMetadata = async (client, handle, metadata, operationId = String(crypto.randomUUID())) => {
  await client.call(
    "bindValidatedRequestMetadata",
    { handle, model: metadata.model, stream: metadata.stream, reasoning: metadata.reasoning ?? null },
    operationId + ":metadata"
  );
  return await client.bindTrustedRoutingDecision(handle, operationId + ":routing");
};
/** A distinct fixture-source action; NativeCommand still rejects every retired admission shape. */
export const runSyntheticRequestPhase = async (client, operation) => {
  const id = operation.operationId ?? crypto.randomUUID();
  if (operation.fixturePhase === "open-api") return await openSyntheticRequest(client, operation.request, id);
  if (operation.fixturePhase === "admit-api") {
    const admitted = await openSyntheticRequest(client, operation.request, id);
    if (admitted.handle && ["reserved", "reuse", "not_applicable"].includes(admitted.kind))
      await bindSyntheticMetadata(client, admitted.handle, operation.metadata, id);
    return admitted;
  }
  if (operation.fixturePhase === "metadata") return await bindSyntheticMetadata(client, operation.handle, operation.metadata, id);
  if (operation.fixturePhase === "routing") return await client.bindTrustedRoutingDecision(operation.handle, id);
  throw new Error("unknown synthetic v3 phase");
};
export const admitSyntheticRequest = async (client, args, operationId = String(crypto.randomUUID())) => {
  const admitted = await openSyntheticRequest(client, args, operationId);
  if (admitted.handle && ["reserved", "reuse", "not_applicable"].includes(admitted.kind))
    await bindSyntheticMetadata(client, admitted.handle, args, operationId);
  return admitted;
};

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
      runtimeSubjects: ["control", "foreign"].map((id) => ({
        id,
        epoch: this.epoch,
        principalId: id === "control" ? "p" : "foreign",
        keyId: this.keyId,
        tokenHash: this.original.hash,
        kernel: this.state.scenario === "P11" && id === "control" ? { owner: "control-org", repo: "repo" } : null,
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
      seed.runtimeSubjects.push({
        id: "p28-retention-admin",
        epoch: this.epoch,
        principalId: "p28-retention-admin",
        keyId: this.keyId,
        tokenHash: this.original.hash,
        kernel: null,
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
    const nativeControl = {
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
    };

    this.runtimeSources = syntheticRuntimeSources(seed, seed.runtimeSubjects, this.ctx.storage, clock, nativeControl);
    this.retainedSources = syntheticRetainedHistory(
      seed,
      this.ctx.storage,
      clock,
      this.state.scenario === "P12"
        ? [
            { id: "history-p", principalId: "p", keyId: this.keyId, requestIds: ["foreign-pending"] },
            { id: "history-foreign", principalId: "foreign", keyId: this.keyId, requestIds: ["foreign-unresolved"] },
          ]
        : []
    );
    this.runtimeSources.runtime.retainedHistory = this.retainedSources.initial;
    this.authority = new NativeAuthority(this.ctx.storage, seed, clock, this.runtimeSources.control, this.runtimeSources.runtime);
    this.runtimeSources.attach(this.authority);
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
      "retained_history_grant",
      "runtime_grant",
      "runtime_request",
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
    if (action === "p12-restore-retained") {
      if (this.state.scenario !== "P12" || value !== undefined) throw new Error("fixture retained restoration denied");
      const restored = this.retainedSources.restore();
      for (const item of restored) this.recordLog(this.sql.read("request_lifetime", [item.handle], this.state.now).value.requestId);
      return restored;
    }
    if (action === "p28-begin-paid-key-deletion") {
      if (this.state.scenario !== "P28" || value !== undefined) throw new Error("fixture retention administrator action denied");
      return new NativeAuthorityClient(new NativeAuthorityRpcServer(this.authority, this.runtimeSources.binding("p28-retention-admin")), this.epoch).call(
        "beginPaidKeyDeletion",
        {}
      );
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
      sql.transaction(() => sql.write("paid_deletion_guard", paidRows.paidFallbackDeletionGuardV3Key(this.keyId), guards[value], null, { scope: this.keyId }));
    } else if (action === "missing-lifetime") {
      const row = sql.page("request_lifetime", now, "", 100).find((entry) => entry.row.value.requestId === "identity-missing");
      if (!row) throw new Error("fixture missing identity setup denied");
      sql.transaction(() => sql.delete("request_lifetime", row.key));
    } else throw new Error("fixture principal action denied");
    this.flush();
    return this.evidence(owner);
  }
}
