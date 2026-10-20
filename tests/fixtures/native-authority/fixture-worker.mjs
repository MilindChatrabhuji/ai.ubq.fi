import { DurableObject } from "cloudflare:workers";
import { NativeAuthority } from "../../../src/authority/native-authority.ts";
import {
  NativeAuthorityClient,
  NativeAuthorityRpcServer,
  NativePrincipalControlClient,
  NativeRetainedHistoryServer,
} from "../../../src/authority/native-authority-rpc.ts";
import { NativeAuthorityError } from "../../../src/authority/native-authority-contracts.ts";
import { NativeAuthoritySql } from "../../../src/authority/native-authority-sql.ts";
import {
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
} from "../../../src/authority/native-codex-contracts.ts";
import { PAID_FALLBACK_REQUEST_LOG_RETENTION_MS } from "../../../src/authority/native-paid.ts";
import {
  CONTROL_CASE_IDS,
  PrincipalControlFixture,
  syntheticRuntimeSources,
  runSyntheticRequestPhase,
  openSyntheticRequest,
  bindSyntheticMetadata,
} from "./principal-control-sources.mjs";
const reviewScenarios = [
  "F01",
  "F02-terminal",
  "F02-delivery",
  "F02-start",
  "F02-provider",
  "F03",
  "F04",
  "F05",
  "F06",
  "F07",
  "F08",
  "F09",
  "F10",
  "F11",
  "F12",
  "F13",
  "transport-tuple",
  "R2-paid-start",
  "R2-shared-pagination",
  "R2-provider-usage",
  "R2-prefetch-release",
  "R2-refresh-revision",
];
const epoch = "synthetic-native-do-epoch";
const fixedNow = 18e11;
const roles = ["inference", "transport", "terminal", "billing", "reconcile", "quota_admin", "reset", "observer"];
const initial = () => {
  const specs = [
    { id: "a", key: "shared", owner: "shared-org", limit: 2 },
    { id: "b", key: "shared", owner: "shared-org", limit: 2 },
    { id: "ledger", key: "ledger", owner: "ledger-org", limit: -1 },
    { id: "growth", key: "growth", owner: "growth-org", limit: -1 },
    { id: "kernel-a", key: "kernel", owner: "kernel-org", limit: -1 },
    { id: "kernel-b", key: "kernel", owner: "kernel-org", limit: -1 },
    { id: "workflow", key: "workflow", owner: "workflow-org", limit: -1 },
    { id: "mixed-a", key: "mixed", owner: "mixed-org", limit: 2 },
    { id: "mixed-b", key: "mixed", owner: "mixed-org", limit: 2 },
    { id: "mixed-overflow", key: "mixed-overflow", owner: "mixed-org", limit: -1 },
  ];
  const keys = [...new Map(specs.map((spec) => [spec.key, spec])).values()].map((spec) => ({
    api: {
      token_hash: `synthetic-hash-${spec.key}`,
      key_id: spec.key,
      expires_at_ms: -1,
      usage_limit_requests: spec.limit,
      window_ms: 36e5,
      window_start_ms: fixedNow - 1e3,
      usage_reset_at_ms: fixedNow + 3599e3,
      policy_version: "v3:3600000",
      paid_fallback_enabled: true,
      paid_fallback_limit_microcredits: spec.key === "growth" ? -1 : 100,
      paid_fallback_spent_microcredits: 0,
      paid_fallback_reserved_microcredits: 0,
      paid_fallback_reservation_request_id: null,
    },
    paid: { policyVersion: "3600000:1", quotaPerCredit: 100, modelExposure: { fixture: 40 }, eligibleModels: ["fixture"], allowUnrosteredUnlimited: false },
    revoked: false,
  }));
  return {
    namespace: "synthetic-native-sqlite-do",
    epoch,
    runtimeSubjects: specs.map((spec) => ({
      id: spec.id,
      epoch,
      principalId: spec.id,
      keyId: spec.key,
      tokenHash: `synthetic-hash-${spec.key}`,
      kernel: { owner: spec.owner, repo: "repo" },
      roles,
      revoked: false,
    })),
    keys,
    kernelPolicies: [],
    kernelDefaults: { limit: 2, windowMs: 36e5 },
    kernelConstants: { noUsageLimit: -1, noExpirationMs: -1 },
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
    routing: null,
    active: null,
    capacity: { v: 1, observations: [] },
    owners: ["a", "b"].map((id) => ({
      administrativeAccountLabelHash: (id === "a" ? "1" : "2").repeat(64),
      routingAccountIdHash: id.repeat(64),
      credentialVersion: (id === "a" ? "c" : "d").repeat(64),
      nativeGenerationHash: (id === "a" ? "e" : "f").repeat(64),
      publicationRevision: `publication-${id}`,
      ownerId: `native-owner-${id}`,
      ownerEpoch: "owner-epoch",
      revoked: false,
      issuedAtMs: fixedNow - 1e3,
      expiresAtMs: fixedNow + 36e5,
      nativeRefreshedAt: null,
    })),
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
  };
};
class SharedNativeAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.incarnation = crypto.randomUUID();
    this.fixtureOwner = env.FIXTURE_OWNER;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS uos_fixture_review (id INTEGER PRIMARY KEY CHECK(id=1), scenario TEXT NOT NULL, now_ms INTEGER NOT NULL)"
    );
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO uos_fixture_review VALUES(1,'main',?)", fixedNow);
    const seed = initial();
    seed.namespace += ":" + ctx.id.toString();
    const scenario = this.ctx.storage.sql.exec("SELECT scenario FROM uos_fixture_review WHERE id=1").one().scenario;
    this.runtimeSubjects = seed.runtimeSubjects.map((subject) => ({
      ...subject,
      kernel:
        scenario === "main" ? (["a", "b"].includes(subject.id) ? null : subject.kernel) : scenario === "F12" && subject.id === "ledger" ? subject.kernel : null,
    }));
    this.runtimeSources = syntheticRuntimeSources(seed, this.runtimeSubjects, ctx.storage, () => this.fixtureClock());
    this.authority = new NativeAuthority(ctx.storage, seed, () => this.fixtureClock(), this.runtimeSources.control, this.runtimeSources.runtime);
    this.runtimeSources.attach(this.authority);
    this.fixtureSql = new NativeAuthoritySql(ctx.storage, seed.namespace, seed.epoch);
  }
  execute(capabilityId, command) {
    return new NativeAuthorityRpcServer(this.authority, this.runtimeSources.binding(capabilityId)).execute(command);
  }
  fixtureClock() {
    return this.ctx.storage.sql.exec("SELECT now_ms FROM uos_fixture_review WHERE id=1").one().now_ms;
  }
  bindTrustedRoutingDecision(principal, handle, operationId) {
    return new NativeAuthorityRpcServer(this.authority, this.runtimeSources.binding(principal)).bindTrustedRoutingDecision(handle, operationId);
  }
  sourcePhase(principal, operation) {
    return runSyntheticRequestPhase(boundClient(this, principal), operation);
  }
  fixtureReviewAuth(token, scenario) {
    if (token !== this.fixtureOwner || !reviewScenarios.includes(scenario)) throw new Error("fixture review owner denied");
    const state = this.ctx.storage.sql.exec("SELECT scenario FROM uos_fixture_review WHERE id=1").one();
    if (state.scenario !== scenario) throw new Error("fixture review namespace mismatch");
  }
  fixtureReviewSetup(token, scenario) {
    if (token !== this.fixtureOwner || !reviewScenarios.includes(scenario)) throw new Error("fixture review owner denied");
    const state = this.ctx.storage.sql.exec("SELECT scenario FROM uos_fixture_review WHERE id=1").one();
    if (state.scenario !== "main" && state.scenario !== scenario) throw new Error("fixture review namespace mismatch");
    if (state.scenario === scenario) return { scenario, arrangement: "existing fixed synthetic fixture" };
    this.ctx.storage.sql.exec("UPDATE uos_fixture_review SET scenario=? WHERE id=1", scenario);
    for (const subject of this.runtimeSubjects) subject.kernel = scenario === "F12" && subject.id === "ledger" ? { owner: "ledger-org", repo: "repo" } : null;
    if (scenario === "F08")
      this.fixtureSql.transaction(() => {
        const pool = this.fixtureSql.read("codex_pool", CODEX_AUTH_POOL_KV_KEY, fixedNow).value;
        this.fixtureSql.write("codex_pool", CODEX_AUTH_POOL_KV_KEY, { ...pool, identities: [pool.identities[0]], selectedAccountHashes: ["a".repeat(64)] });
      });
    return { scenario, arrangement: "fixed synthetic owner/pool/time setup; not live publisher acceptance" };
  }
  fixtureReviewControl(token, scenario, action) {
    this.fixtureReviewAuth(token, scenario);
    const sql = this.fixtureSql,
      now = this.fixtureClock();
    if (action === "rotate" && ["F05", "F08"].includes(scenario)) {
      sql.transaction(() => {
        const pool = sql.read("codex_pool", CODEX_AUTH_POOL_KV_KEY, now).value;
        const owner = sql.read("codex_owner", ["a".repeat(64)], now).value;
        const credentialVersion = "e".repeat(64);
        sql.write("codex_pool", CODEX_AUTH_POOL_KV_KEY, {
          ...pool,
          identities: pool.identities.map((identity) => (identity.slot === 0 ? { ...identity, credentialVersion } : identity)),
        });
        sql.write("codex_owner", ["a".repeat(64)], {
          ...owner,
          credentialVersion,
          nativeGenerationHash: "generation-" + credentialVersion,
          publicationRevision: "publication-" + credentialVersion,
        });
      });
    } else if (action === "advance" && ["F08", "F11", "F12", "F13"].includes(scenario)) {
      const delta = { F08: 1001, F11: 1, F12: 3600001, F13: PAID_FALLBACK_REQUEST_LOG_RETENTION_MS + 1 }[scenario];
      this.ctx.storage.sql.exec("UPDATE uos_fixture_review SET now_ms=? WHERE id=1", fixedNow + delta);
    } else if (action === "install-reset" && scenario === "F09") {
      const request = sql.page("request_lifetime", now, "", 100).find((entry) => entry.row.value.requestId === "proof-blocked").row.value;
      if (request.selection?.kind !== "quota_blocked") throw new Error("fixture reset requires actual quota cohort");
      const account = request.selection.blockedAccounts[0];
      sql.transaction(() =>
        sql.write("codex_reset", ["review-proof"], {
          id: "review-proof",
          account,
          quotaResetAtMs: account.quotaResetAtMs,
          routingGeneration: account.routingGeneration,
          activeSnapshot: sql.read("codex_active", CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, now).value,
          poolRevision: sql.read("codex_pool", CODEX_AUTH_POOL_KV_KEY, now).revision,
          capacityRevision: sql.read("codex_capacity", CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, now).revision,
          verified: true,
        })
      );
    } else throw new Error("fixture review action denied");
    return { scenario, action, now: this.fixtureClock(), arrangement: "fixed trusted test setup only" };
  }
  async fixtureReviewEvidence(token, scenario) {
    this.fixtureReviewAuth(token, scenario);
    const sql = this.fixtureSql,
      now = this.fixtureClock();
    const values = (family) => sql.page(family, now, "", 100).map((entry) => entry.row.value);
    const requests = values("request_lifetime");
    const request =
      requests.find((row) =>
        ["own-refresh-receipt", "current-invalid", "owned-probe", "kernel-lifetime", "retention-tombstone", "nonpaid", "responding-paid"].includes(
          row.requestId
        )
      ) ?? requests[0];
    const windows = values("api_window"),
      paidWindows = values("paid_window"),
      routing = sql.read("codex_routing", CODEX_ACCOUNT_ROUTING_KV_KEY, now);
    const routingValueSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(routing.value))))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return {
      scenario,
      incarnation: this.incarnation,
      now,
      routingValueSha256,
      apiCommitted: windows.reduce((sum, row) => sum + row.committed_requests, 0),
      apiReserved: windows.reduce((sum, row) => sum + row.reserved_requests, 0),
      apiStates: values("api_request").map((row) => row.state),
      paidReserved: paidWindows.reduce((sum, row) => sum + row.reserved_microcredits, 0),
      paidSettled: paidWindows.reduce((sum, row) => sum + row.settled_microcredits, 0),
      paidWindowIdentity: JSON.stringify(paidWindows),
      paidCount: values("paid_request").length,
      paidStates: values("paid_request").map((row) => ({ terminal: row.terminal_state, billing: row.billing_state })),
      attemptCount: values("attempt_lifetime").length,
      pendingDue: values("paid_pending").map((row) => row.next_reconciliation_at_ms),
      gateRevision: values("paid_gate").length ? sql.page("paid_gate", now, "", 100)[0].row.revision : null,
      kernelCount: values("kernel_reservation").length,
      kernelBinding: JSON.stringify(request?.kernel ?? null),
      credentialVersion: request?.codex?.credentialVersion ?? null,
      requestedModel: request?.codex?.requestedModel ?? null,
      probeToken: request?.codex?.probeToken ?? null,
      probeGeneration: request?.codex?.probeGeneration ?? null,
      routingGeneration: request?.codex?.routingGeneration ?? null,
      routingRevision: routing.revision,
      slotGeneration: routing.value?.slots[0]?.generation ?? null,
      proofVerified: sql.read("codex_reset", ["review-proof"], now).value?.verified ?? null,
      providerObserved: request?.providerObserved === true,
      transport: request?.transport ? { provider: request.transport.provider, attemptHandle: request.transport.attemptHandle } : null,
      responding: request?.responding ?? null,
      rollups: values("paid_rollup").map((row) => ({
        provider: row.provider,
        request_count: row.request_count,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        spend_microcredits: row.spend_microcredits,
      })),
    };
  }

  fixtureInspect() {
    const projection = {
      incarnation: this.incarnation,
      runtimeSchemaVersion: this.ctx.storage.sql.exec("SELECT schema_version FROM uos_native_authority_meta WHERE id=1").one().schema_version,
      runtimeBindingRevisions: this.ctx.storage.sql
        .exec("SELECT DISTINCT json_extract(row_json,'$.revision') AS revision FROM uos_native_runtime_grant ORDER BY revision")
        .toArray()
        .map((row) => row.revision),
      rows: {},
      apiWindows: [],
      kernelWindows: [],
      paidWindows: [],
      active: [],
      paidRequestBytes: 0,
      paidRequestCount: 0,
      operationReceipts: 0,
      permanentRollups: 0,
      permanentGuards: 0,
    };
    for (const family of [
      "api_window",
      "api_request",
      "kernel_window",
      "kernel_reservation",
      "paid_request",
      "paid_window",
      "paid_pending",
      "paid_rollup",
      "paid_deletion_guard",
      "operation_receipt",
    ]) {
      projection.rows[family] = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM uos_native_${family}`).one().n;
    }
    for (const [key, family] of [
      ["apiWindows", "api_window"],
      ["kernelWindows", "kernel_window"],
      ["paidWindows", "paid_window"],
      ["active", "codex_active"],
    ])
      projection[key] = this.ctx.storage.sql
        .exec(`SELECT row_json,expires_at_ms FROM uos_native_${family} ORDER BY row_key`)
        .toArray()
        .map((row) => ({ value: JSON.parse(row.row_json), expiresAtMs: row.expires_at_ms }));
    projection.paidRequestBytes = this.ctx.storage.sql.exec("SELECT COALESCE(SUM(LENGTH(row_json)),0) AS n FROM uos_native_paid_request").one().n;
    projection.paidRequestCount = projection.rows.paid_request;
    projection.operationReceipts = projection.rows.operation_receipt;
    projection.permanentRollups = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM uos_native_paid_rollup WHERE expires_at_ms IS NULL").one().n;
    projection.permanentGuards = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM uos_native_paid_deletion_guard WHERE expires_at_ms IS NULL").one().n;
    return projection;
  }
  fixtureCrash() {
    this.ctx.abort("synthetic native authority crash after acknowledged durable phase");
  }
}
const boundClient = (stub, principal) =>
  new NativeAuthorityClient(
    {
      execute: (command) => stub.execute(principal, command),
      bindTrustedRoutingDecision: (handle, operationId) => stub.bindTrustedRoutingDecision(principal, handle, operationId),
    },
    epoch
  );
class PrincipalNativeAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.incarnation = crypto.randomUUID();
    this.fixture = new PrincipalControlFixture(ctx, env.FIXTURE_OWNER, initial(), fixedNow, epoch);
  }
  setup(owner, scenario) {
    return this.fixture.setup(owner, scenario);
  }
  action(owner, action, value) {
    return this.fixture.action(owner, action, value);
  }
  evidence(owner) {
    return { ...this.fixture.evidence(owner), incarnation: this.incarnation };
  }
  control(profile, command, clientType) {
    return this.fixture.control(profile, command, clientType);
  }
  async execute(principal, command) {
    const reply = await new NativeAuthorityRpcServer(this.fixture.authority, this.fixture.runtimeSources.binding(principal)).execute(command);
    if (command.method === "reserveApiUsage" && reply.result?.kind === "reserved")
      this.fixture.recordLog(this.fixture.sql.read("request_lifetime", [reply.result.handle], this.fixture.state.now).value.requestId);
    return reply;
  }
  retained(profile, command) {
    return new NativeRetainedHistoryServer(this.fixture.authority, this.fixture.retainedSources.binding(profile)).execute(command);
  }
  bindTrustedRoutingDecision(principal, handle, operationId) {
    return new NativeAuthorityRpcServer(this.fixture.authority, this.fixture.runtimeSources.binding(principal)).bindTrustedRoutingDecision(handle, operationId);
  }
  sourcePhase(principal, operation) {
    return runSyntheticRequestPhase(boundClient(this, principal), operation);
  }
}
const principalRoute = async (request, env, match) => {
  const [, scenario, path] = match;
  if (!CONTROL_CASE_IDS.includes(scenario)) return new Response(null, { status: 403 });
  const stub = env.PRINCIPAL.getByName("native-principal-" + scenario);
  if (path.startsWith("/__fixture/")) {
    if (request.headers.get("x-fixture-owner") !== env.FIXTURE_OWNER) return new Response(null, { status: 403 });
    if (path === "/__fixture/setup") return Response.json(await stub.setup(env.FIXTURE_OWNER, scenario));
    if (path === "/__fixture/evidence") return Response.json(await stub.evidence(env.FIXTURE_OWNER));
    if (path === "/__fixture/action") {
      const { action, value } = await request.json();
      return Response.json(await stub.action(env.FIXTURE_OWNER, action, value));
    }
    return new Response(null, { status: 404 });
  }
  const route = /^\/(control-rpc|control-client|control-raw|rpc|client|trusted-routing|source-phase|retained-rpc|retained-client)\/([^/]+)$/.exec(path);
  if (!route) return new Response(null, { status: 404 });
  const [, surface, profile] = route,
    command = await request.json();
  if (surface === "retained-rpc" || surface === "retained-client") {
    if (scenario !== "P12" || !["history-p", "history-foreign"].includes(profile)) return new Response(null, { status: 403 });
    if (surface === "retained-rpc") return Response.json(await stub.retained(profile, command));
    try {
      const client = new NativeAuthorityClient({ execute: (input) => stub.retained(profile, input) }, epoch);
      return Response.json({ result: await client.call(command.method, command.args, command.operationId) });
    } catch (error) {
      if (!(error instanceof NativeAuthorityError)) throw error;
      return Response.json({ error: { code: error.code, status: error.status } });
    }
  }
  if (["rpc", "client", "trusted-routing", "source-phase"].includes(surface)) {
    if (!["control", "foreign"].includes(profile)) return new Response(null, { status: 403 });
    if (surface === "rpc") return Response.json(await stub.execute(profile, command));
    if (surface === "trusted-routing") return Response.json(await stub.bindTrustedRoutingDecision(profile, command.handle, command.operationId));
    if (surface === "source-phase") {
      try {
        return Response.json({ result: await stub.sourcePhase(profile, command) });
      } catch (error) {
        if (!(error instanceof NativeAuthorityError)) throw error;
        return Response.json({ error: { code: error.code, status: error.status } });
      }
    }
    try {
      return Response.json({ result: await boundClient(stub, profile).call(command.method, command.args, command.operationId) });
    } catch (error) {
      if (!(error instanceof NativeAuthorityError)) throw error;
      return Response.json({ error: { code: error.code, status: error.status } });
    }
  }
  if (surface !== "control-client") return Response.json(await stub.control(profile, command, surface === "control-rpc" ? "bun" : "worker"));
  const transport = {
    control: async (input) => {
      const reply = await stub.control(profile, input, "worker");
      if (reply.fixtureFault) throw Object.assign(new Error(reply.fixtureFault.message), { fixtureFault: true });
      return reply;
    },
  };
  try {
    return Response.json({ result: await new NativePrincipalControlClient(transport, epoch).call(command.method, command.args, command.operationId) });
  } catch (error) {
    if (error.fixtureFault) return Response.json({ fixtureFault: { message: error.message } });
    if (!(error instanceof NativeAuthorityError)) throw error;
    return Response.json({ error: { code: error.code, status: error.status } });
  }
};
var stdin_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const principal = /^\/control\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (principal) return await principalRoute(request, env, principal);
    const review = /^\/review\/([^/]+)(\/.*)$/.exec(url.pathname);
    const scenario = review?.[1] ?? null;
    if (scenario !== null && !reviewScenarios.includes(scenario)) return new Response(null, { status: 403 });
    const path = review?.[2] ?? url.pathname;
    const stub = env.AUTHORITY.getByName(scenario ? "native-review-" + scenario : "one-native-gateway-coordination-atom");
    if (path.startsWith("/__fixture/")) {
      if (request.headers.get("x-fixture-owner") !== env.FIXTURE_OWNER) return new Response(null, { status: 403 });
      if (scenario && path === "/__fixture/setup") return Response.json(await stub.fixtureReviewSetup(env.FIXTURE_OWNER, scenario));
      if (scenario && path === "/__fixture/control")
        return Response.json(await stub.fixtureReviewControl(env.FIXTURE_OWNER, scenario, (await request.json()).action));
      if (scenario && path === "/__fixture/evidence") return Response.json(await stub.fixtureReviewEvidence(env.FIXTURE_OWNER, scenario));
      if (path === "/__fixture/inspect") return Response.json(await stub.fixtureInspect());
      if (path === "/__fixture/crash") {
        await stub.fixtureCrash();
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 404 });
    }
    if (path.startsWith("/source-phase/") || path.startsWith("/trusted-routing/")) {
      const principal = path.split("/")[2];
      if (!initial().runtimeSubjects.some((subject) => subject.id === principal)) return new Response(null, { status: 403 });
      const operation = await request.json();
      try {
        if (path.startsWith("/trusted-routing/"))
          return Response.json(await stub.bindTrustedRoutingDecision(principal, operation.handle, operation.operationId));
        return Response.json({ result: await stub.sourcePhase(principal, operation) });
      } catch (error) {
        if (!(error instanceof NativeAuthorityError)) throw error;
        return Response.json({ error: { code: error.code, status: error.status } });
      }
    }
    if (scenario && path.startsWith("/client/")) {
      const principal = path.slice(8),
        command = await request.json();
      if (!initial().runtimeSubjects.some((cap) => cap.id === principal)) return new Response(null, { status: 403 });
      try {
        return Response.json({ result: await boundClient(stub, principal).call(command.method, command.args, command.operationId) });
      } catch (error) {
        if (!(error instanceof NativeAuthorityError)) throw error;
        return Response.json({ error: { code: error.code } });
      }
    }
    if (path.startsWith("/rpc/")) {
      const principal = path.slice(5);
      if (!initial().runtimeSubjects.some((cap) => cap.id === principal)) return new Response(null, { status: 403 });
      return Response.json(await stub.execute(principal, await request.json()));
    }
    if (path !== "/workflow") return new Response(null, { status: 404 });
    if (!env.SYNTHETIC_UPSTREAM) return new Response("Linux mixed transport fixture is not enabled", { status: 503 });
    const body = await request.json(),
      client = boundClient(stub, "workflow");
    const admitted = await openSyntheticRequest(client, {
      requestId: body.requestId,
      route: "/v1/responses",
      model: "fixture",
      stream: body.stream === true,
    });
    if (!admitted.handle) return Response.json(admitted, { status: 429 });
    const handle = admitted.handle;
    const kernel = await client.call("reserveKernelUsage", { handle });
    if (kernel.kind !== "reserved") {
      await client.call("releaseApiUndispatched", { handle, reason: "kernel_quota_refused" });
      return Response.json(kernel, { status: 429 });
    }
    await bindSyntheticMetadata(client, handle, { model: "fixture", stream: body.stream === true, reasoning: null });
    const selection = await client.call("selectCodexAccount", { handle });
    if (selection.kind !== "eligible") return Response.json(selection, { status: 503 });
    await client.call("refreshCodexAdmission", { handle });
    await client.call("markApiDispatch", { handle, provider: "chatgpt_codex" });
    await client.call("recordTransportStarted", { handle, provider: "chatgpt_codex" });
    const upstream = await fetch(env.SYNTHETIC_UPSTREAM + (body.stream ? "/sse" : "/json"), {
      method: "POST",
      body: JSON.stringify({ requestId: body.requestId }),
      signal: request.signal,
    });
    const terminal = async (outcome, delivery) => {
      await client.call("recordSemanticTerminal", { handle, outcome });
      const terminalState = outcome === "completed" ? "committed" : "released";
      await client.call("recordKernelTerminalIntent", { handle, terminalState });
      await client.call("settleKernelUsage", { handle, terminalState, reason: outcome });
      await client.call("recordDeliveryObservation", { handle, observation: delivery });
    };
    if (!body.stream) {
      const bytes = await upstream.text();
      const payload = JSON.parse(bytes);
      if (payload.status === "completed") await terminal("completed", "unobserved");
      return new Response(bytes, { status: upstream.status, headers: { "content-type": "application/json", "x-fixture-handle": handle } });
    }
    const reader = upstream.body.getReader();
    let observed = "";
    const decoder = new TextDecoder();
    return new Response(
      new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              if (observed.includes('"type":"response.completed"')) await terminal("completed", "unobserved");
              controller.close();
              return;
            }
            observed += decoder.decode(chunk.value, { stream: true });
            controller.enqueue(chunk.value);
          } catch (error) {
            await terminal("cancelled", "interrupted");
            controller.error(error);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
          await terminal("cancelled", "interrupted");
        },
      }),
      { headers: { "content-type": "text/event-stream", "x-fixture-handle": handle } }
    );
  },
};
export { SharedNativeAuthority, PrincipalNativeAuthority, stdin_default as default };
