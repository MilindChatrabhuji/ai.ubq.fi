import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { apiKeyHashKey } from "../src/api-keys.ts";
import { NativeAuthority } from "../src/authority/native-authority.ts";
import { NativeAuthoritySql } from "../src/authority/native-authority-sql.ts";
import {
  NativeAuthorityClient,
  NativeAuthorityRpcServer,
  NativePrincipalControlClient,
  NativePrincipalControlServer,
  NativeRetainedHistoryServer,
  parseNativeCommand,
} from "../src/authority/native-authority-rpc.ts";
import type { NativeAuthorityInitial, NativeSqlStorage } from "../src/authority/native-authority-contracts.ts";
import type {
  NativeRetainedHistoryBinding,
  NativeRuntimeIdentity,
  NativeRuntimeInitial,
  NativeTrustedRoutingDecision,
} from "../src/authority/native-runtime-contracts.ts";
import {
  admitSyntheticRequest,
  bindSyntheticMetadata,
  PrincipalControlFixture,
  syntheticRuntimeSources,
} from "./fixtures/native-authority/principal-control-sources.mjs";

type SqlBinding = string | number | null;
const NOW = 1_800_000_000_000;
const required = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null) throw new Error("required synthetic runtime value absent");
  return value;
};
const storage = (database: Database): NativeSqlStorage => ({
  sql: {
    exec: (query, ...bindings) => {
      const rows = database.query<Record<string, unknown>, SqlBinding[]>(query).all(...bindings);
      return { toArray: () => rows };
    },
  },
  transactionSync: <T>(callback: () => T) => database.transaction(callback)(),
});
const fixture = (api = true, kernel = false, identity: NativeRuntimeIdentity = { kind: "kv_api_key", keyId: "synthetic-key" }) => {
  const db = new Database(":memory:");
  const clock = { now: NOW };
  const source = { routingRevision: "catalog-v3", allowUnrostered: false, wrongIntent: false, failAuth: false, direct: true };
  let verifiedKernel: Readonly<{ owner: string; repo: string }> | null = null;
  if (kernel)
    verifiedKernel =
      identity.kind === "github_token"
        ? { owner: identity.owner.toLowerCase(), repo: identity.repo.toLowerCase() }
        : { owner: "synthetic-org", repo: "synthetic-repo" };
  const seed: NativeAuthorityInitial = {
    namespace: "synthetic-runtime-v3",
    epoch: "runtime-epoch-v3",
    keys: api
      ? [
          {
            api: {
              key_id: "synthetic-key",
              token_hash: "synthetic-runtime-hash",
              expires_at_ms: -1,
              usage_limit_requests: 10,
              window_ms: 60_000,
              window_start_ms: NOW - 1000,
              usage_reset_at_ms: NOW + 59_000,
              policy_version: "v3:60000",
              paid_fallback_enabled: true,
              paid_fallback_limit_microcredits: -1,
              paid_fallback_spent_microcredits: 0,
              paid_fallback_reserved_microcredits: 0,
              paid_fallback_reservation_request_id: null,
            },
            revoked: false,
            paid: {
              policyVersion: "60000:1",
              quotaPerCredit: 100,
              eligibleModels: ["fixture"],
              modelExposure: { fixture: 40 },
              allowUnrosteredUnlimited: true,
            },
          },
        ]
      : [],
    kernelPolicies: [],
    kernelDefaults: { limit: 10, windowMs: 60_000 },
    kernelConstants: { noUsageLimit: -1, noExpirationMs: -1 },
    pool: { identities: [], selectedAccountHashes: [], policies: {} },
    routing: null,
    active: null,
    capacity: { v: 1, observations: [] },
    owners: [],
    resetProofs: [],
    providerHops: [
      {
        id: "paid-hop",
        publicProvider: "openlux",
        ledgerProvider: "metered",
        billingCorrelation: "provider_request_id",
        microcreditsPerCredit: 100,
        billingSuffix: "synthetic-paid",
        authorization: "direct",
      },
    ],
  };
  const subject = {
    id: "synthetic-runtime",
    keyId: api ? "synthetic-key" : null,
    tokenHash: api ? "synthetic-runtime-hash" : null,
    kernel: verifiedKernel,
    roles: ["inference", "transport", "terminal", "billing", "observer"] as const,
  };
  const sources = syntheticRuntimeSources(seed, [subject], storage(db), () => clock.now);
  const runtime: NativeRuntimeInitial = {
    ...sources.runtime,
    verifier: {
      verify: async (context, intentDigest, at) => {
        if (source.failAuth) throw new Error("synthetic native authentication refused");
        const verified = api
          ? await sources.runtime.verifier.verify(context, intentDigest, at)
          : { bindingId: subject.id, subjectId: subject.id, contextBinding: subject.id, intentDigest, identity, api: null, kernel: verifiedKernel };
        return { ...verified, identity, intentDigest: source.wrongIntent ? "wrong-intent" : intentDigest };
      },
      verifyRouting: (_context, request, intentDigest) =>
        Promise.resolve<NativeTrustedRoutingDecision>({
          subjectId: subject.id,
          contextBinding: subject.id,
          intentDigest,
          sourceRevision: source.routingRevision,
          cohort: "synthetic-selected-cohort",
          codex: "eligible",
          providers: ["metered", "deepseek"],
          allowUnrosteredModel: source.allowUnrostered && request.model === "unrostered",
          hops: source.direct ? [{ hopId: "paid-hop", authorization: "direct", upstreamModel: "upstream:" + request.model, billingModel: request.model }] : [],
        }),
    },
  };
  const construct = () => {
    const authority = new NativeAuthority(storage(db), seed, () => clock.now, sources.control, runtime);
    sources.attach(authority);
    return new NativeAuthorityRpcServer(authority, sources.binding(subject.id));
  };
  let rpc = construct();
  const client = new NativeAuthorityClient(
    { execute: (command) => rpc.execute(command), bindTrustedRoutingDecision: (handle, operationId) => rpc.bindTrustedRoutingDecision(handle, operationId) },
    seed.epoch
  );
  const sql = new NativeAuthoritySql(storage(db), seed.namespace, seed.epoch);
  const open = async (requestId = "synthetic-request", operationId?: string) =>
    required(
      (
        await client.call(
          "openAuthenticatedRequest",
          {
            requestId,
            route: "/v1/responses",
            path: "/v1/responses?synthetic=1",
          },
          operationId
        )
      ).handle
    );
  const admit = async (requestId = "synthetic-request", model = "fixture") => {
    const handle = await open(requestId);
    await client.call("reserveApiUsage", { handle });
    await client.call("reserveKernelUsage", { handle });
    await bindSyntheticMetadata(client, handle, { model, stream: false, reasoning: "literal-future-tier" });
    return handle;
  };
  return {
    db,
    clock,
    source,
    seed,
    sql,
    client,
    open,
    admit,
    restart: () => {
      rpc = construct();
    },
  };
};

for (const api of [false, true])
  for (const kernel of [false, true]) {
    test(`runtime v3: API ${api} / kernel ${kernel} retains independent native accounting phases`, async () => {
      const f = fixture(api, kernel, api ? { kind: "kv_api_key", keyId: "synthetic-key" } : { kind: "passkey_session", userId: "synthetic-user" });
      try {
        const handle = await f.open();
        for (const family of ["api_request", "api_window", "kernel_reservation", "kernel_window", "paid_request", "attempt_lifetime"] as const)
          expect(f.sql.page(family, NOW, "", 100)).toHaveLength(0);
        expect(f.sql.read("request_lifetime", [handle], NOW).value).toMatchObject({ model: null, stream: null, metadataBound: false, api: null, kernel: null });
        if (api || kernel)
          await assert.rejects(f.client.call("bindValidatedRequestMetadata", { handle, model: "fixture", stream: false, reasoning: null }), /phase_incomplete/);
        expect((await f.client.call("reserveApiUsage", { handle })).kind).toBe(api ? "reserved" : "not_applicable");
        expect((await f.client.call("reserveKernelUsage", { handle })).kind).toBe(kernel ? "reserved" : "not_applicable");
        await bindSyntheticMetadata(f.client, handle, { model: "fixture", stream: false, reasoning: "literal-future-tier" });
        expect(f.sql.page("api_request", NOW, "", 100)).toHaveLength(api ? 1 : 0);
        expect(f.sql.page("kernel_reservation", NOW, "", 100)).toHaveLength(kernel ? 1 : 0);
        expect(f.sql.read("request_lifetime", [handle], NOW).value).toMatchObject({
          model: "fixture",
          reasoning: "literal-future-tier",
          path: "/v1/responses?synthetic=1",
        });
        expect((await f.client.call("reservePaidAttempt", { handle, hopId: "paid-hop" })).kind).toBe(api ? "reserved" : "blocked");
      } finally {
        f.db.close();
      }
    });
  }

const identities: readonly (readonly [NativeRuntimeIdentity, string, boolean])[] = [
  [{ kind: "kv_api_key", keyId: "synthetic-key" }, "api-key:synthetic-key", true],
  [{ kind: "local_development_key", keyId: "synthetic-key" }, "api-key:synthetic-key", true],
  [{ kind: "github_token", owner: "Synthetic-Owner", repo: "Synthetic-Repo" }, "github-repo:synthetic-owner/synthetic-repo", false],
  [{ kind: "passkey_session", userId: "synthetic-user" }, "passkey-user:synthetic-user", false],
  [{ kind: "auth_tokens_allowlist" }, "auth-method:auth_tokens_allowlist", false],
  [{ kind: "admin_allowlist" }, "auth-method:admin_allowlist", false],
  [{ kind: "deno_deploy_token" }, "auth-method:deno_deploy_token", false],
  [{ kind: "disabled_local", bearerDigest: null }, "local-auth-disabled", false],
  [{ kind: "disabled_local", bearerDigest: "a".repeat(64) }, "a".repeat(64), false],
];
for (const [identity, expected, api] of identities)
  test(`runtime v3: ${identity.kind} preserves source principal identity`, async () => {
    const f = fixture(api, identity.kind === "github_token", identity);
    try {
      const handle = await f.open();
      expect(f.sql.read("request_lifetime", [handle], NOW).value?.principalId).toBe(expected);
      if (!api) {
        expect(f.sql.page("api_key_hash", NOW, "", 100)).toHaveLength(0);
        expect(f.sql.page("principal_resolution", NOW, "", 100)).toHaveLength(0);
      }
    } finally {
      f.db.close();
    }
  });

test("runtime v3: failed private auth/intent has no request or accounting effects", async () => {
  const f = fixture();
  try {
    f.source.failAuth = true;
    await assert.rejects(f.open(), /authentication refused/);
    f.source.failAuth = false;
    f.source.wrongIntent = true;
    await assert.rejects(f.open(), /runtime_context_or_intent_mismatch/);
    for (const family of ["request_lifetime", "api_request", "kernel_reservation", "paid_request"] as const)
      expect(f.sql.page(family, NOW, "", 100)).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("runtime v3: wrong epoch/grant/context and old admission DTO refuse before opening", async () => {
  const f = fixture();
  try {
    const old = {
      epoch: f.seed.epoch,
      operationId: "old",
      method: "reserveApiUsage",
      args: { requestId: "old", route: "/v1/responses", model: "fixture", stream: false },
    };
    expect(() => parseNativeCommand(old)).toThrow(/invalid_authority_arguments/);
    for (const field of ["principalId", "keyId", "tokenHash", "repository", "verified", "grantId", "now", "policy", "allowUnrosteredModel"])
      expect(() =>
        parseNativeCommand({
          epoch: f.seed.epoch,
          operationId: field,
          method: "openAuthenticatedRequest",
          args: { requestId: "r", route: "/v1/responses", path: "/v1/responses", [field]: "forged" },
        })
      ).toThrow();
    const grant = required(f.sql.read("runtime_grant", ["synthetic-runtime"], NOW).value);
    for (const patch of [{ revoked: true }, { expiresAtMs: NOW }, { epoch: "wrong" }, { contextBinding: "wrong" }, { subjectId: "wrong" }]) {
      f.sql.transaction(() => {
        f.sql.write("runtime_grant", [grant.id], { ...grant, ...patch });
      });
      await assert.rejects(f.open(), /runtime_grant/);
    }
    expect(f.sql.page("request_lifetime", NOW, "", 100)).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("runtime v3: original lifetime/API window and immutable metadata survive restart and retry", async () => {
  const f = fixture();
  try {
    const handle = await f.admit();
    const original = required(f.sql.read("request_lifetime", [handle], NOW).value);
    f.clock.now += 120_000;
    f.restart();
    expect(await f.open()).toBe(handle);
    expect((await f.client.call("reserveApiUsage", { handle })).handle).toBe(handle);
    expect(f.sql.read("request_lifetime", [handle], f.clock.now).value?.api).toEqual(original.api);
    await assert.rejects(
      f.client.call("bindValidatedRequestMetadata", { handle, model: "changed", stream: false, reasoning: "literal-future-tier" }),
      /validated_metadata_conflict/
    );
    await assert.rejects(
      f.client.call("openAuthenticatedRequest", { requestId: "synthetic-request", route: "/v1/chat/completions", path: "/changed" }),
      /request_intent_conflict/
    );
    expect(f.sql.page("request_lifetime", f.clock.now, "", 100)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("runtime v3: current raw-H revocation fences admission/exposure but retains terminal/kernel cleanup", async () => {
  const f = fixture(true, true);
  try {
    const handle = await f.admit();
    const key = apiKeyHashKey("synthetic-runtime-hash");
    f.sql.transaction(() => {
      f.sql.write("api_key_hash", key, { ...required(f.sql.read("api_key_hash", key, NOW).value), revoked_at_ms: NOW });
    });
    expect(await f.client.call("openAuthenticatedRequest", { requestId: "fresh", route: "/v1/responses", path: "/v1/responses" })).toMatchObject({
      kind: "unauthorized",
    });
    expect(await f.client.call("reservePaidAttempt", { handle, hopId: "paid-hop" })).toMatchObject({ kind: "blocked", detail: "invalid_policy" });
    expect((await f.client.call("recordKernelTerminalIntent", { handle, terminalState: "released" })).kind).toBe("intent");
    expect((await f.client.call("settleKernelUsage", { handle, terminalState: "released", reason: "synthetic cancellation" })).kind).toBe("settle");
    expect((await f.client.call("releaseApiUndispatched", { handle, reason: "synthetic no fetch" })).kind).toBe("released");
    expect((await f.client.call("recordSemanticTerminal", { handle, outcome: "cancelled" })).kind).toBe("recorded");
  } finally {
    f.db.close();
  }
});

test("runtime v3: paid/unrostered permission comes from the current private request decision", async () => {
  const f = fixture();
  try {
    const denied = await f.admit("unrostered-denied", "unrostered");
    expect(await f.client.call("reservePaidAttempt", { handle: denied, hopId: "paid-hop" })).toMatchObject({ kind: "skip", detail: "model_not_priced" });
    f.source.allowUnrostered = true;
    const allowed = await f.admit("unrostered-allowed", "unrostered");
    expect((await f.client.call("reservePaidAttempt", { handle: allowed, hopId: "paid-hop" })).kind).toBe("reserved");
    f.source.routingRevision = "catalog-replaced";
    await assert.rejects(f.client.call("reservePaidAttempt", { handle: allowed, hopId: "paid-hop" }), /trusted_routing_stale/);
    expect(f.sql.page("attempt_lifetime", NOW, "", 100)).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("runtime v3: source direct-hop withdrawal denies caller-selected paid exposure", async () => {
  const f = fixture();
  try {
    f.source.direct = false;
    const handle = await f.admit();
    expect(await f.client.call("reservePaidAttempt", { handle, hopId: "paid-hop" })).toMatchObject({ kind: "blocked", detail: "request_hop_not_authorized" });
    expect(f.sql.page("paid_request", NOW, "", 100)).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("runtime v3: lost start acknowledgment and authority outage cannot recreate no-fetch compensation", async () => {
  const f = fixture();
  try {
    const handle = await f.admit();
    await f.client.call("markApiDispatch", { handle, provider: "deepseek" });
    const first = await f.client.call("recordTransportStarted", { handle, provider: "deepseek" }, "start");
    f.restart();
    expect(await f.client.call("recordTransportStarted", { handle, provider: "deepseek" }, "start")).toEqual(first);
    await assert.rejects(f.client.call("releaseApiUndispatched", { handle, reason: "lost ack" }), /prefetch_compensation_closed/);
    const unavailable = new NativeAuthorityClient({ execute: () => Promise.reject(new Error("synthetic authority outage")) }, f.seed.epoch);
    await assert.rejects(unavailable.call("readRequestStatus", { handle, limit: 1 }), /authority outage/);
    expect(required(f.sql.read("request_lifetime", [handle], NOW).value).transport).not.toBeNull();
  } finally {
    f.db.close();
  }
});

test("runtime v3: policy-free transport retains a lifetime without API or paid entitlement", async () => {
  const f = fixture(false, false, { kind: "passkey_session", userId: "synthetic-user" });
  try {
    const handle = await f.admit();
    expect((await f.client.call("markApiDispatch", { handle, provider: "deepseek" })).kind).toBe("dispatched");
    expect((await f.client.call("recordTransportStarted", { handle, provider: "deepseek" })).kind).toBe("started");
    expect((await f.client.call("recordSemanticTerminal", { handle, outcome: "completed" })).kind).toBe("recorded");
    expect((await f.client.call("recordDeliveryObservation", { handle, observation: "unobserved" })).kind).toBe("recorded");
    for (const family of ["api_request", "api_window", "paid_request", "paid_window"] as const) expect(f.sql.page(family, NOW, "", 100)).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("runtime v3: schema v2 predecessor is refused without migrating or activating its rows", () => {
  const f = fixture();
  try {
    f.db.run("UPDATE uos_native_authority_meta SET schema_version=1 WHERE id=1");
    expect(() => {
      f.restart();
    }).toThrow(/authority_schema_or_epoch_mismatch/);
    expect(f.db.query<{ schema_version: number }, []>("SELECT schema_version FROM uos_native_authority_meta").get()?.schema_version).toBe(1);
  } finally {
    f.db.close();
  }
});

/** Actual local SQLite/private source clients only; no HTTP, Worker or Linux acceptance claim. */
const sourceFixture = (scenario: "P12" | "P28") => {
  const template = fixture();
  const seed = template.seed;
  template.db.close();
  const db = new Database(":memory:");
  const adapter = {
    ...storage(db),
    sql: {
      exec(query: string, ...bindings: SqlBinding[]) {
        const rows = db.query<Record<string, unknown>, SqlBinding[]>(query).all(...bindings);
        return {
          toArray: () => rows,
          one: () => {
            assert.equal(rows.length, 1);
            return required(rows[0]);
          },
        };
      },
    },
  };
  const owner = "synthetic-fixture-owner";
  const source = new PrincipalControlFixture({ id: { toString: () => "synthetic-" + scenario }, storage: adapter }, owner, seed, NOW, seed.epoch);
  source.setup(owner, scenario);
  const authority = required(source.authority),
    runtimeSources = required(source.runtimeSources);
  const client = (id: string) => new NativeAuthorityClient(new NativeAuthorityRpcServer(authority, runtimeSources.binding(id)), seed.epoch);
  const sql = required(source.sql),
    retainedSources = required(source.retainedSources);
  return {
    db,
    source,
    authority,
    client,
    owner,
    epoch: seed.epoch,
    storage: adapter,
    seed: { ...seed, namespace: sql.namespace },
    sql,
    runtimeSources,
    retainedSources,
  };
};

test("runtime v3 local source sanity: P12 foreign binding keeps verified paid settlement after revocation", async () => {
  const f = sourceFixture("P12");
  try {
    const foreign = f.client("foreign");
    const handle = required(
      (await admitSyntheticRequest(foreign, { requestId: "synthetic-P12", route: "/v1/responses", model: "fixture", stream: false })).handle
    );
    const attemptHandle = required((await foreign.call("reservePaidAttempt", { handle, hopId: "paid" })).attemptHandle);
    await foreign.call("recordPaidAttemptLifecycle", { attemptHandle, patch: { provider_request_id: "synthetic-provider-receipt" } });
    const admin = new NativePrincipalControlClient(new NativePrincipalControlServer(f.authority, f.source.binding("admin")), f.epoch);
    expect((await admin.call("revokeKey", {})).kind).toBe("applied");
    expect(
      (
        await foreign.call("recordVerifiedPaidBilling", {
          attemptHandle,
          log: { request_id: "synthetic-provider-receipt", quota: 7, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: NOW / 1000 },
        })
      ).kind
    ).toBe("settled");
    await assert.rejects(f.client("control").call("readRequestStatus", { handle, limit: 1 }), /request_ownership_mismatch/);
    const rows = f.source.rows();
    expect(rows.paid_request[0].value.billing_state).toBe("settled");
    expect(rows.paid_window[0].value.reserved_microcredits).toBe(0);
  } finally {
    f.db.close();
  }
});

test("runtime v3 local source sanity: P28 ordinary-role denial and private retention administrator remain distinct", async () => {
  const f = sourceFixture("P28");
  try {
    for (const id of ["control", "foreign"]) await assert.rejects(f.client(id).call("beginPaidKeyDeletion", {}), /authority_capability_denied/);
    const before = f.source.rows();
    expect(before.paid_deletion_guard).toHaveLength(0);
    expect(before.runtime_grant.find((row: { value: { id: string } }) => row.value.id === "control").value.roles).not.toContain("quota_admin");
    await f.source.action(f.owner, "p28-begin-paid-key-deletion");
    const after = f.source.rows();
    expect(after.paid_deletion_guard).toHaveLength(1);
    expect(after.paid_deletion_guard[0].expiresAtMs).toBeNull();
    expect(after.runtime_grant.find((row: { value: { id: string } }) => row.value.id === "p28-retention-admin").value.roles).toEqual(["quota_admin"]);
  } finally {
    f.db.close();
  }
});

test("runtime v3 retained history: distinct durable principals clean up without new inference authority", async () => {
  const f = sourceFixture("P12");
  try {
    const [first, second] = f.source.action(f.owner, "p12-restore-retained");
    const sql = f.sql;
    const snapshots = { before: f.source.rows() };
    const retained = (id: string) => new NativeAuthorityClient(new NativeRetainedHistoryServer(f.authority, f.retainedSources.binding(id)), f.epoch);
    expect(
      sql
        .page("request_lifetime", NOW, "", 100)
        .map((entry) => required(entry.row.value).principalId)
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(["foreign", "p"]);
    expect(
      sql
        .page("attempt_lifetime", NOW, "", 100)
        .map((entry) => required(entry.row.value).principalId)
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(["foreign", "p"]);
    expect(sql.page("capability", NOW, "", 100)).toHaveLength(0);
    expect(sql.page("runtime_request", NOW, "", 100)).toHaveLength(0);
    const freshHandle = required(
      (
        await f.client("control").call("openAuthenticatedRequest", {
          requestId: "fresh-native",
          route: "/v1/responses",
          path: "/v1/responses",
        })
      ).handle
    );
    expect(sql.read("request_lifetime", [freshHandle], NOW).value?.principalId).toBe("api-key:key");
    await assert.rejects(f.client("foreign").call("releasePaidBeforeFetch", { attemptHandle: second.attemptHandle }), /attempt_ownership_mismatch/);
    await assert.rejects(retained("history-p").call("releasePaidBeforeFetch", { attemptHandle: second.attemptHandle }), /retained_history_target_mismatch/);
    const rpc = new NativeRetainedHistoryServer(f.authority, f.retainedSources.binding("history-foreign"));
    for (const [method, args] of [
      ["openAuthenticatedRequest", { requestId: "forged", route: "/v1/responses", path: "/v1/responses" }],
      ["reserveApiUsage", { handle: second.handle }],
      ["reserveKernelUsage", { handle: second.handle }],
      ["bindValidatedRequestMetadata", { handle: second.handle, model: "changed", stream: true, reasoning: null }],
      ["reservePaidAttempt", { handle: second.handle, hopId: "paid" }],
      ["markApiDispatch", { handle: second.handle, provider: "metered" }],
      ["recordTransportStarted", { handle: second.handle, provider: "metered", attemptHandle: second.attemptHandle }],
      ["beginPaidKeyDeletion", {}],
      ["recordSemanticTerminal", { handle: second.handle, outcome: "completed" }],
    ] as const) {
      expect(await rpc.execute({ epoch: f.epoch, operationId: "denied-" + method, method, args })).toMatchObject({
        error: { code: "retained_operation_denied", status: 403 },
      });
    }
    for (const args of [
      { attemptHandle: second.attemptHandle, patch: {}, fetchStarted: true },
      { attemptHandle: second.attemptHandle, patch: { dispatch_state: "dispatched" } },
    ])
      expect(await rpc.execute({ epoch: f.epoch, operationId: crypto.randomUUID(), method: "recordPaidAttemptLifecycle", args })).toMatchObject({
        error: { code: "retained_dispatch_denied", status: 403 },
      });
    expect(sql.page("paid_request", NOW, "", 100)).toHaveLength(2);
    expect(sql.read("attempt_lifetime", [second.attemptHandle], NOW).value?.fetchStarted).toBe(false);
    const admin = new NativePrincipalControlClient(new NativePrincipalControlServer(f.authority, f.source.binding("admin")), f.epoch);
    await admin.call("revokeKey", {});
    f.source.action(f.owner, "clock", NOW + 86_400_001);
    await retained("history-foreign").call("deferPaidReconciliation", { attemptHandle: second.attemptHandle });
    expect(await admin.call("deleteKey", {})).toMatchObject({
      kind: "refused",
      code: "paid_fallback_billing_outstanding",
      message: expect.stringContaining("pending=1, unresolved=1, markers=2"),
    });
    const refused = f.source.rows();
    const release = await retained("history-p").call("releasePaidBeforeFetch", { attemptHandle: first.attemptHandle }, "retained-lost-ack");
    expect(release.kind).toBe("released");
    expect(await retained("history-p").call("releasePaidBeforeFetch", { attemptHandle: first.attemptHandle }, "retained-lost-ack")).toEqual(release);
    await assert.rejects(
      retained("history-p").call("releasePaidBeforeFetch", { attemptHandle: second.attemptHandle }, "retained-lost-ack"),
      /retained_history_target_mismatch/
    );
    expect(await admin.call("deleteKey", {})).toMatchObject({ kind: "refused", message: expect.stringContaining("pending=0, unresolved=1, markers=1") });
    const released = f.source.rows();
    expect(sql.page("runtime_request", NOW, "", 100)).toHaveLength(1);
    expect(sql.page("capability", NOW, "", 100).every((entry) => entry.row.value?.principalId === "api-key:key")).toBe(true);
    await retained("history-foreign").call("recordPaidAttemptLifecycle", {
      attemptHandle: second.attemptHandle,
      patch: { provider_request_id: "retained-provider-receipt", terminal_state: "completed" },
    });
    const claim = await retained("history-foreign").call("claimPaidReconciliation", { limit: 100 });
    expect(claim.detail).toMatchObject([{ attemptHandle: second.attemptHandle }]);
    expect(
      (
        await retained("history-foreign").call("recordVerifiedPaidBilling", {
          attemptHandle: second.attemptHandle,
          log: { request_id: "retained-provider-receipt", quota: 7, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: NOW / 1000 },
        })
      ).kind
    ).toBe("settled");
    expect((await retained("history-foreign").call("finishPaidReconciliation", { lease: required(claim.lease) })).kind).toBe("finished");
    const reconciled = f.source.rows();
    expect(sql.page("paid_window", NOW, "", 100)[0].row.value).toMatchObject({ reserved_microcredits: 0, pending_count: 0, settled_microcredits: 7 });
    expect(await admin.call("deleteKey", {}, "retained-delete")).toMatchObject({ kind: "applied" });
    expect(await admin.call("deleteKey", {}, "retained-delete")).toMatchObject({ kind: "historical_ack" });
    expect(await admin.call("deleteKey", {}, "retained-fresh-delete")).toMatchObject({ kind: "refused", status: 404 });
    expect(sql.page("api_request", NOW, "", 100)).toHaveLength(0);
    expect(f.source.state.cleanupObservations).toMatchObject([{ idAbsent: true, hashAbsent: true, projectionAbsent: true, apiRows: 2, deleteAudits: 1 }]);
    console.log(JSON.stringify({ retainedHistory: "v3", ...snapshots, refused, released, reconciled, deleted: f.source.rows() }));
  } finally {
    f.db.close();
  }
});

test("runtime v3 retained history: grants, verifier, replay, cursor and lease scopes fail closed", async () => {
  const f = sourceFixture("P12");
  try {
    const [, second] = f.source.action(f.owner, "p12-restore-retained");
    const sql = f.sql;
    const binding: NativeRetainedHistoryBinding = f.retainedSources.binding("history-foreign");
    const grant = required(sql.read("retained_history_grant", [binding.grantId], NOW).value);
    const client = (value = binding, owner = f.authority) => new NativeAuthorityClient(new NativeRetainedHistoryServer(owner, value), f.epoch);
    const command = { attemptHandle: second.attemptHandle, patch: {} };
    for (const malformed of [null, {}, { ...binding, kind: "runtime" }, { ...binding, principalId: "forged" }])
      expect(() => f.authority.bindRetainedHistory(malformed)).toThrow(/invalid_retained_history_binding/);
    const raw = new NativeRetainedHistoryServer(f.authority, binding);
    expect(await raw.execute({ epoch: "wrong", operationId: "wrong-epoch", method: "recordPaidAttemptLifecycle", args: command })).toMatchObject({
      error: { code: "authority_epoch_mismatch", status: 403 },
    });
    expect(
      await raw.execute({ epoch: f.epoch, operationId: "forged-principal", method: "recordPaidAttemptLifecycle", args: { ...command, principalId: "forged" } })
    ).toMatchObject({ error: { code: "invalid_authority_arguments", status: 400 } });
    const acknowledged = await client().call("recordPaidAttemptLifecycle", command, "retained-ack");
    expect(acknowledged.kind).toBe("updated");
    expect(await client().call("recordPaidAttemptLifecycle", command, "retained-ack")).toEqual(acknowledged);
    await assert.rejects(
      client().call("recordPaidAttemptLifecycle", { ...command, patch: { provider_request_id: "changed" } }, "retained-ack"),
      /retained_operation_replay_conflict/
    );
    const patches = [
      { revoked: true },
      { expiresAtMs: NOW },
      { epoch: "wrong" },
      { id: "wrong" },
      { namespace: "wrong" },
      { contextBinding: "wrong" },
      { subjectId: "wrong" },
      { originalBindingId: "wrong" },
      { originalPrincipalId: "wrong" },
      { keyId: "wrong" },
      { requestHandles: ["missing"] },
      { requestHandles: [] },
      { roles: ["inference"] },
    ];
    for (const patch of patches) {
      sql.transaction(() => {
        sql.write("retained_history_grant", [grant.id], { ...grant, ...patch } as typeof grant);
      });
      await assert.rejects(
        client().call("recordPaidAttemptLifecycle", command, "retained-ack"),
        /retained_(grant_denied|scope_mismatch|history_target_mismatch)/
      );
    }
    sql.transaction(() => {
      sql.write("retained_history_grant", [grant.id], grant);
    });
    await assert.rejects(client({ ...binding, contextBinding: "wrong" }).call("recordPaidAttemptLifecycle", command), /retained_context_or_intent_mismatch/);
    await assert.rejects(
      client({ ...binding, privateContext: { retainedGrant: "missing" } }).call("recordPaidAttemptLifecycle", command),
      /synthetic_retained_source_denied/
    );
    const seed = f.seed;
    const runtime = f.runtimeSources.runtime;
    const withoutVerifier = new NativeAuthority(f.storage, seed, () => NOW, undefined, {
      grants: runtime.grants,
      records: runtime.records,
      verifier: runtime.verifier,
    });
    await assert.rejects(client(binding, withoutVerifier).call("recordPaidAttemptLifecycle", command), /retained_history_unavailable/);
    const wrongIntent = new NativeAuthority(f.storage, seed, () => NOW, undefined, {
      ...runtime,
      retainedHistory: {
        grants: [grant],
        verifier: {
          verify: async (context: unknown, intent: string) => ({
            ...(await f.retainedSources.initial.verifier.verify(context, intent)),
            intentDigest: "wrong",
          }),
        },
      },
    });
    await assert.rejects(client(binding, wrongIntent).call("recordPaidAttemptLifecycle", command), /retained_context_or_intent_mismatch/);
    const alternate = { ...grant, id: "alternate-retained-grant" };
    f.retainedSources.initial.grants.push(alternate);
    sql.transaction(() => {
      sql.write("retained_history_grant", [alternate.id], alternate);
    });
    const alternateBinding = { ...binding, grantId: alternate.id, privateContext: { retainedGrant: alternate.id } };
    const claim = await client().call("claimPaidReconciliation", { limit: 1 });
    expect(claim.kind).toBe("claimed");
    const lease = required(claim.lease),
      cursor = required(claim.cursor);
    await assert.rejects(client(alternateBinding).call("finishPaidReconciliation", { lease }), /reconciliation_lease_stale/);
    expect((await client().call("finishPaidReconciliation", { lease })).kind).toBe("finished");
    await assert.rejects(client(alternateBinding).call("claimPaidReconciliation", { cursor, limit: 1 }), /cursor_ownership_mismatch/);
    expect(sql.page("paid_lease", NOW, "", 100)).toHaveLength(0);
    expect(sql.page("paid_pending", NOW, "", 100)).toHaveLength(2);
  } finally {
    f.db.close();
  }
});
