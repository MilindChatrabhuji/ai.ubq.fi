import { DurableObject } from "cloudflare:workers";
import { NativeAuthority } from "../../../src/authority/native-authority.ts";
import { NativeAuthorityClient, NativeAuthorityRpcServer } from "../../../src/authority/native-authority-rpc.ts";
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
    capabilities: specs.map((spec) => ({
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
    this.authority = new NativeAuthority(ctx.storage, initial(), () => fixedNow);
  }
  execute(capabilityId, command) {
    return new NativeAuthorityRpcServer(this.authority, capabilityId).execute(command);
  }
  fixtureInspect() {
    const projection = {
      incarnation: this.incarnation,
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
const boundClient = (stub, principal) => new NativeAuthorityClient({ execute: (command) => stub.execute(principal, command) }, epoch);
var stdin_default = {
  async fetch(request, env) {
    const url = new URL(request.url),
      stub = env.AUTHORITY.getByName("one-native-gateway-coordination-atom");
    if (url.pathname.startsWith("/__fixture/")) {
      if (request.headers.get("x-fixture-owner") !== env.FIXTURE_OWNER) return new Response(null, { status: 403 });
      if (url.pathname === "/__fixture/inspect") return Response.json(await stub.fixtureInspect());
      if (url.pathname === "/__fixture/crash") {
        await stub.fixtureCrash();
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 404 });
    }
    if (url.pathname.startsWith("/rpc/")) {
      const principal = url.pathname.slice(5);
      if (!initial().capabilities.some((cap) => cap.id === principal)) return new Response(null, { status: 403 });
      return Response.json(await stub.execute(principal, await request.json()));
    }
    if (url.pathname !== "/workflow") return new Response(null, { status: 404 });
    if (!env.SYNTHETIC_UPSTREAM) return new Response("Linux mixed transport fixture is not enabled", { status: 503 });
    const body = await request.json(),
      client = boundClient(stub, "workflow");
    const admitted = await client.call("reserveApiUsage", {
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
    const selection = await client.call("selectCodexAccount", { handle });
    if (selection.kind !== "eligible") return Response.json(selection, { status: 503 });
    await client.call("refreshCodexAdmission", { handle });
    await client.call("markApiDispatch", { handle, provider: "chatgpt_codex" });
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
export { SharedNativeAuthority, stdin_default as default };
