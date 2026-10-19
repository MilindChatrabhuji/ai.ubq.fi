import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const PRINCIPAL_CONTROL_CASE_IDS = Array.from({ length: 28 }, (_, index) => "P" + String(index + 1).padStart(2, "0"));
const NOW = 1_800_000_000_000,
  DAY = 86_400_000,
  RETENTION = 7 * DAY;
const row = (e, family) => e.rows[family][0]?.value;
const count = (e, family) => e.rows[family].length;
const isKind = (reply, kind) => assert.equal(reply.kind, kind, JSON.stringify(reply));
const required = (value) => {
  assert(value !== null && value !== undefined);
  return value;
};
const names = [
  "six-method DTO refuses caller identity, target, token, policy, clock and proof",
  "same-operation resolver rereads mutable H without ID or accounting side effects",
  "current grant, epoch, role, subject, context, digest, target and expiry rechecked",
  "native create defaults, duplicate, pricing, UUID and audit ordering",
  "malformed and retired-field precedence without key or audit writes",
  "actual SQLite audit rollback and persisted preparation survive reconstruction",
  "live V3 no-op, trusted binding, same-ms reset and pending exposure",
  "original-window lease reclamation and missing original identity refusal",
  "pricing await rechecks revisions and live reset guard",
  "fresh repeat revoke, historical acknowledgment and guarded active unrevoke",
  "revocation denies new exposure and cached permissions but permits original accounting cleanup",
  "all-principal pending, unresolved and marker deletion guard; log-before-API cleanup",
  "local pre-ID claim release and post-ID cleanup retry after reconstruction",
  "lost acknowledgment survives disposal; current durable grant revocation wins",
  "joined create mints once and refuses changed private target or intent",
  "missing trusted unrostered binding refuses create and preserves existing binding",
  "direct raw H revocation and removal refuse fresh and replayed admission",
  "SQLite audit faults preserve atomic revoke, unrevoke and owned pre-ID release",
  "legacy, foreign and crashed/completed local tombstones cannot be stolen",
  "native pricing error mapping and pricing-before-reset validation",
  "malformed durable grant refuses historical acknowledgment",
  "native no-op and revocation do not require complete quota migration",
  "delayed paid admission charges the original window and isolates the next",
  "joined same-owner deletion cannot acknowledge or complete before cleanup settles",
  "failed preparation write recovers on same authority without remint",
  "early trusted hash failure retains private preparation and current authorization",
  "joined cleanup failure remains pending; same-authority retry and restart replay",
  "raw ID/H permanence, original-window API TTL, audit TTL and permanent paid/local guards",
];
export async function runPrincipalControlCases({ owner, remote, restart, nativeBindings, epoch }) {
  const cases = [],
    contexts = new Map();
  const fresh = async (id) => {
    const initial = await owner(id, "setup"),
      clients = { bun: 0, worker: 0 },
      receipts = [];
    assert.deepEqual(initial.bindings, nativeBindings);
    let sequence = 0;
    const send = async (surface, profile, command, options = {}) => {
      const client = options.client ?? (sequence++ % 2 === 0 ? "bun" : "worker");
      clients[client]++;
      try {
        const result = await remote({ id, surface, profile, command, client, raw: options.raw === true });
        receipts.push({ client, surface, profile, command, result });
        return result;
      } catch (error) {
        receipts.push({
          client,
          surface,
          profile,
          command,
          error: {
            code: error.code,
            status: error.status,
            fixtureRefusal: error.fixtureRefusal === true,
            fixtureFault: error.fixtureFault === true,
            message: error.message,
          },
        });
        throw error;
      }
    };
    const c = {
      id,
      initial,
      clients,
      receipts,
      call: (method, args = {}, operationId = randomUUID(), profile = "admin", options = {}) =>
        send("principal", profile, { epoch, method, args, operationId }, options),
      raw: (command, profile = "resolver", options = {}) => send("principal", profile, command, { ...options, raw: true }),
      infer: (method, args = {}, operationId = randomUUID(), principal = "control", options = {}) =>
        send("inference", principal, { epoch, method, args, operationId }, options),
      action: (action, value) => owner(id, "action", { action, value }),
      evidence: () => owner(id, "evidence"),
    };
    contexts.set(id, c);
    return c;
  };
  const deny = async (promise, code) => {
    try {
      await promise;
    } catch (error) {
      assert.equal(error.fixtureRefusal, true, "transport, parse, process and timeout failures are not domain denials");
      assert.notEqual(error.code, "authority_operation_failed");
      assert.equal(error.code, code);
      return { code: error.code, status: error.status };
    }
    assert.fail("expected native domain refusal " + code);
  };
  const fault = async (promise, message) => {
    try {
      await promise;
    } catch (error) {
      assert.equal(error.fixtureFault, true, "only the exact injected source/storage fault counts here");
      assert.match(error.message, message);
      return error.message;
    }
    assert.fail("expected injected fault");
  };
  const reserve = async (c, id, principal = "control", operationId = randomUUID()) => {
    const r = await c.infer("reserveApiUsage", { requestId: id, route: "/v1/responses", model: "fixture", stream: false }, operationId, principal);
    isKind(r, "reserved");
    return required(r.handle);
  };
  const paid = async (c, id, principal = "control", operationId = randomUUID()) => {
    const handle = await reserve(c, id, principal),
      r = await c.infer("reservePaidAttempt", { handle, hopId: "paid" }, operationId, principal);
    isKind(r, "reserved");
    return { handle, attemptHandle: required(r.attemptHandle) };
  };
  const finish = async (c, extra = {}) => {
    const prior = await c.evidence();
    for (const client of ["bun", "worker"]) if (!prior.clients[client]) await c.call("resolvePrincipal", {}, randomUUID(), "resolver", { client });
    const after = await c.evidence();
    assert(c.clients.bun > 0 && c.clients.worker > 0);
    assert(after.clients.bun > 0 && after.clients.worker > 0, "both actual private control transports must reach this DO");
    assert.equal(after.active, 0);
    assert.equal(after.doId, c.initial.doId);
    assert(after.verifications.every((v) => /^[0-9a-f]{64}$/.test(v.intentDigest)));
    cases.push({ id: c.id, name: names[Number(c.id.slice(1)) - 1], clients: c.clients, before: c.initial, after, receipts: c.receipts, ...extra });
  };
  const wait = async (c, predicate) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const e = await c.evidence();
      if (predicate(e)) return e;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.fail("fixture barrier did not reach its actual observed stage");
  };
  {
    const c = await fresh("P01"),
      base = { epoch, operationId: "strict", method: "resolvePrincipal", args: {} };
    for (const key of ["principalId", "keyId", "targetKeyId", "tokenHash", "actor", "role", "verified", "now", "revision", "grantId", "proof"])
      assert.equal((await c.raw({ ...base, args: { [key]: "caller" } })).error.code, "invalid_control_arguments");
    for (const key of ["id", "token", "hash", "policy", "clock", "actor", "release"])
      assert.equal(
        (await c.raw({ ...base, method: "createKey", args: { input: { name: "new", [key]: "caller" } } }, "create")).error.code,
        "invalid_control_arguments"
      );
    for (const method of ["snapshot", "execute", "verify", "grant"]) assert.equal((await c.raw({ ...base, method })).error.code, "invalid_control_operation");
    await c.call("resolvePrincipal", {}, "valid", "resolver");
    assert.equal(count(await c.evidence(), "api_key_audit"), 0);
    await finish(c);
  }
  {
    const c = await fresh("P02");
    await c.action("raw", "remove-id");
    const first = await c.call("resolvePrincipal", {}, "same-resolution", "resolver");
    isKind(first, "principal");
    assert.deepEqual(await c.call("resolvePrincipal", {}, "same-resolution", "resolver"), first);
    const observations = [];
    for (const [transition, status] of [
      ["revoke", 401],
      ["expired", 401],
      ["quota-v2", 503],
      ["invalid-paid", 503],
    ]) {
      await c.action("raw", transition);
      const r = await c.call("resolvePrincipal", {}, "same-resolution", "resolver");
      isKind(r, "refused");
      assert.equal(r.status, status);
      observations.push(await c.evidence());
    }
    await c.action("raw", "restore");
    isKind(await c.call("resolvePrincipal", {}, "same-resolution", "resolver"), "principal");
    await c.action("raw", "remove-h");
    assert.equal((await c.call("resolvePrincipal", {}, "same-resolution", "resolver")).status, 401);
    const e = await c.evidence();
    for (const family of ["api_request", "api_window", "request_lifetime", "attempt_lifetime", "operation_receipt"]) assert.equal(count(e, family), 0);
    assert.deepEqual(e.rows.capability, c.initial.rows.capability, "resolution must not mint an inference capability");
    await finish(c, { mutableHObservations: observations });
  }
  {
    const c = await fresh("P03");
    await c.action("barrier", "verification");
    const pending = c.call("revokeKey", {}, "revoked-during-verification");
    await wait(c, (e) => e.barriers.verification?.entered === 1);
    await c.action("grant", "revoked");
    await c.action("release", "verification");
    await deny(pending, "control_grant_denied");
    for (const transition of ["expired", "epoch", "role", "subject", "context"]) {
      await c.action("grant", transition);
      await deny(c.call("revokeKey"), "control_grant_denied");
    }
    await c.action("grant", "target");
    await deny(c.call("revokeKey"), "control_target_denied");
    await c.action("grant", "restore");
    for (const profile of ["wrong-context", "wrong-subject", "wrong-digest", "wrong-role"])
      await deny(c.call("revokeKey", {}, randomUUID(), profile), "control_grant_denied");
    assert.equal((await c.raw({ epoch: "wrong", operationId: "epoch", method: "revokeKey", args: {} }, "admin")).error.code, "control_grant_denied");
    const e = await c.evidence();
    assert.equal(count(e, "api_key_audit"), 0);
    assert.equal(row(e, "api_key_hash").revoked_at_ms, null);
    await finish(c);
  }
  {
    const c = await fresh("P04"),
      input = {
        name: " created ",
        expires_at_ms: -1,
        usage_limit_requests: 0,
        window_ms: "60000",
        paid_fallback_enabled: true,
        paid_fallback_limit_credits: -1,
      };
    const r = await c.call("createKey", { input }, "create", "create");
    isKind(r, "applied");
    let e = await c.evidence();
    assert.deepEqual(e.calls, ["token", "clock", "defaults", "hash", "pricing", "uuid", "audit-uuid", "release"]);
    const created = required(e.rows.api_key_id.find((x) => x.value.id === r.keyId));
    assert.equal(created.value.name, "created");
    assert.equal(created.value.hash, "synthetic-bbbbbbbb");
    assert.equal(created.value.usage_limit_requests, 0);
    assert.equal(created.value.expires_at_ms, -1);
    assert.equal(created.expiresAtMs, null);
    const projection = e.rows.api_policy.find((x) => x.value.api.key_id === r.keyId).value;
    assert.equal(projection.rawSource, true);
    assert.equal(projection.paid.allowUnrosteredUnlimited, false);
    assert.deepEqual(projection.paid.modelExposure, { fixture: 40 });
    assert.equal(e.rows.api_window[0].expiresAtMs, NOW + 60_000 + RETENTION);
    assert.equal(e.rows.api_key_audit[0].expiresAtMs, NOW + 90 * DAY);
    assert.deepEqual(row(e, "api_key_audit").actor, { kind: "local_admin", principal_id: null, principal_label: null, is_super_admin: true });
    assert.equal(row(e, "api_key_audit").request_id, "safe-correlation");
    assert.equal(row(e, "api_key_audit").release, "synthetic-release");
    assert(!JSON.stringify(e.rows.api_key_audit).includes("synthetic-bbbbbbbb"));
    const calls = [...e.calls];
    isKind(await c.call("createKey", { input }, "create", "create"), "historical_ack");
    assert.deepEqual((await c.evidence()).calls, calls);
    const duplicate = await c.call("createKey", { input }, "duplicate", "create");
    assert.equal(duplicate.status, 409);
    assert.deepEqual((await c.evidence()).calls.slice(calls.length), ["token", "clock", "defaults", "hash"]);
    const defaults = await c.call("createKey", { input: { name: "defaults" } }, "defaults", "private-token");
    isKind(defaults, "applied");
    e = await c.evidence();
    const d = e.rows.api_key_id.find((x) => x.value.id === defaults.keyId).value;
    assert.equal(d.expires_at_ms, nativeBindings.defaults.expiryMs);
    assert.equal(d.usage_limit_requests, nativeBindings.defaults.usageLimitRequests);
    await finish(c);
  }
  {
    const c = await fresh("P05");
    for (const [input, message] of [
      [{ banked_resets_enabled: false, name: 4 }, "banked_resets_enabled is retired"],
      [{ name: "" }, "name must be"],
      [{ name: "new", expires_at_ms: NOW, usage_limit_requests: -2 }, "expires_at_ms must be"],
      [{ name: "new", usage_limit_requests: -2, window_ms: null }, "usage_limit_requests must be"],
      [{ name: "new", window_ms: null, paid_fallback_enabled: "bad" }, "window_ms must be"],
      [{ name: "new", paid_fallback_enabled: "bad" }, "paid_fallback_enabled must be"],
      [{ name: "new", paid_fallback_enabled: true }, "paid_fallback_limit_credits must be positive"],
    ]) {
      const r = await c.call("createKey", { input }, randomUUID(), "create");
      isKind(r, "refused");
      assert(r.message.includes(message));
    }
    assert.equal((await c.call("createKey", { input: { name: "invalid-token" } }, randomUUID(), "invalid-token")).status, 400);
    assert.equal((await c.call("deleteKey")).status, 400);
    const e = await c.evidence();
    assert.equal(count(e, "api_key_id"), 1);
    assert.equal(count(e, "api_key_audit"), 0);
    assert.equal(count(e, "paid_deletion_guard"), 0);
    await finish(c);
  }
  {
    const c = await fresh("P06"),
      args = { input: { name: "atomic", window_ms: 60_000 } };
    await c.action("fault", { name: "audit", enabled: true });
    await fault(c.call("createKey", args, "atomic", "create"), /synthetic audit fault/);
    const failed = await c.evidence();
    for (const family of ["api_key_id", "api_key_hash", "api_policy"]) assert.deepEqual(failed.rows[family], c.initial.rows[family]);
    assert.equal(count(failed, "api_window"), 0);
    assert.equal(count(failed, "api_key_audit"), 0);
    assert.equal(row(failed, "key_control_receipt").reply, null);
    assert.equal(row(failed, "key_control_receipt").prepared.record.id, "synthetic-uuid-1");
    await c.action("fault", { name: "audit", enabled: false });
    await restart();
    const rebuilt = await c.evidence();
    assert.notEqual(rebuilt.incarnation, failed.incarnation);
    const r = await c.call("createKey", args, "atomic", "create");
    isKind(r, "applied");
    assert.equal(r.keyId, "synthetic-uuid-1");
    assert.deepEqual((await c.evidence()).calls.slice(failed.calls.length), ["audit-uuid", "release"]);
    isKind(await c.call("createKey", args, "atomic", "create"), "historical_ack");
    assert.equal(count(await c.evidence(), "api_key_audit"), 1);
    await finish(c, { failed, rebuilt });
  }
  {
    const c = await fresh("P07"),
      handle = await reserve(c, "used");
    await c.infer("markApiDispatch", { handle, provider: "deepseek" });
    const noop = await c.call("updateKey", { input: {} });
    isKind(noop, "unchanged");
    assert.equal(noop.detail.usage_requests, 1);
    assert.equal(count(await c.evidence(), "api_key_audit"), 0);
    const reset = await c.call("updateKey", { input: { reset_usage: true } });
    isKind(reset, "applied");
    assert.equal(reset.detail.usage_requests, 0);
    assert.equal(reset.detail.usage_reset_at_ms, NOW + 60_001);
    const e = await c.evidence();
    assert.equal(row(e, "api_key_id").paid_fallback_reserved_microcredits, 17);
    assert.equal(row(e, "api_key_id").paid_fallback_reservation_request_id, "pending-original");
    assert.equal(row(e, "api_policy").paid.allowUnrosteredUnlimited, true);
    assert.equal(count(e, "api_window"), 2);
    await finish(c);
  }
  {
    const c = await fresh("P08");
    await reserve(c, "old-window");
    await c.action("clock", NOW + 60_001);
    await reserve(c, "new-window");
    assert.equal((await c.call("updateKey", { input: { reset_usage: true } })).status, 409);
    await c.action("clock", NOW + 300_001);
    assert.equal((await c.call("updateKey", { input: { reset_usage: true } })).status, 409);
    const original = (await c.evidence()).rows.api_request.find((x) => x.value.request_id === "old-window");
    assert.equal(original.value.state, "released");
    assert.equal(original.value.release_reason, "reservation_lease_expired");
    assert.equal(original.expiresAtMs, NOW + 60_000 + RETENTION);
    await c.action("clock", NOW + 360_002);
    isKind(await c.call("updateKey", { input: { window_ms: 120_000 } }), "applied");
    await reserve(c, "identity-missing");
    await c.action("missing-lifetime");
    await deny(c.call("updateKey", { input: { reset_usage: true } }), "api_reset_original_identity_missing");
    await finish(c);
  }
  {
    const c = await fresh("P09");
    await c.action("barrier", "pricing");
    const pending = c.call("updateKey", { input: { name: "stale", paid_fallback_enabled: true, paid_fallback_limit_credits: -1, reset_usage: true } }, "stale");
    await wait(c, (e) => e.barriers.pricing?.entered === 1);
    await reserve(c, "racing-reservation");
    await c.action("raw", "rename");
    await c.action("release", "pricing");
    const result = await pending;
    assert.equal(result.status, 409);
    assert(result.message.includes("requests are reserved"));
    const e = await c.evidence();
    assert.equal(row(e, "api_key_id").name, "new-source-name");
    assert.equal(count(e, "api_key_audit"), 0);
    await finish(c);
  }
  {
    const c = await fresh("P10");
    isKind(await c.call("unrevokeKey", {}, "active"), "unchanged");
    assert.equal((await c.evidence()).calls.length, 0);
    const resolution = await c.call("resolvePrincipal", {}, "same-control-resolution", "resolver");
    isKind(resolution, "principal");
    isKind(await c.call("revokeKey", {}, "revoke"), "applied");
    assert.equal((await c.call("resolvePrincipal", {}, "same-control-resolution", "resolver")).status, 401);
    await c.action("clock", NOW + 1);
    assert.equal((await c.call("revokeKey", {}, "fresh-revoke")).detail.revoked_at_ms, NOW);
    const before = await c.evidence();
    assert.equal(count(before, "api_key_audit"), 2);
    assert(before.rows.api_key_audit.some((x) => !Object.keys(x.value.changed).length));
    isKind(await c.call("revokeKey", {}, "revoke"), "historical_ack");
    assert.deepEqual((await c.evidence()).rows.api_key_audit, before.rows.api_key_audit);
    await deny(c.call("unrevokeKey", {}, "revoke"), "control_operation_replay_conflict");
    await c.call("unrevokeKey");
    assert.deepEqual(await c.call("resolvePrincipal", {}, "same-control-resolution", "resolver"), resolution);
    await c.action("guard", "legacy");
    const calls = (await c.evidence()).calls.length;
    assert.equal((await c.call("unrevokeKey")).code, "paid_fallback_deletion_in_progress");
    assert.equal((await c.evidence()).calls.length, calls);
    await finish(c);
  }
  {
    const c = await fresh("P11"),
      { handle, attemptHandle } = await paid(c, "inflight", "control", "paid-admission"),
      prefetch = await paid(c, "prefetch");
    isKind(await c.infer("reserveKernelUsage", { handle }), "reserved");
    await c.infer("markApiDispatch", { handle, provider: "metered" });
    await c.infer("recordTransportStarted", { handle, provider: "metered", attemptHandle }, "transport");
    await c.infer("recordPaidAttemptLifecycle", { attemptHandle, patch: { provider_request_id: "paid-response" } });
    await c.call("revokeKey");
    assert.equal((await c.call("resolvePrincipal", {}, "resolve", "resolver")).status, 401);
    isKind(await c.infer("reserveApiUsage", { requestId: "fresh", route: "/v1/responses", model: "fixture", stream: false }), "unauthorized");
    assert.equal((await c.infer("reservePaidAttempt", { handle, hopId: "paid" })).detail, "invalid_policy");
    await deny(c.infer("reservePaidAttempt", { handle, hopId: "paid" }, "paid-admission"), "api_policy_revoked");
    await deny(c.infer("recordTransportStarted", { handle, provider: "metered", attemptHandle }, "transport"), "api_policy_revoked");
    await deny(c.infer("markApiDispatch", { handle, provider: "metered" }), "api_policy_revoked");
    await deny(c.infer("reserveKernelUsage", { handle }), "api_policy_revoked");
    isKind(await c.infer("renewKernelReservation", { handle }), "renewed");
    isKind(await c.infer("recordKernelTerminalIntent", { handle, terminalState: "committed" }), "intent");
    isKind(await c.infer("settleKernelUsage", { handle, terminalState: "committed", reason: "completed" }), "settle");
    isKind(await c.infer("recordSemanticTerminal", { handle, attemptHandle, outcome: "completed" }), "recorded");
    isKind(await c.infer("recordDeliveryObservation", { handle, observation: "delivered" }), "recorded");
    isKind(
      await c.infer("recordVerifiedPaidBilling", {
        attemptHandle,
        log: { request_id: "paid-response", quota: 7, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: NOW / 1000 },
      }),
      "settled"
    );
    isKind(await c.infer("releasePaidBeforeFetch", { attemptHandle: prefetch.attemptHandle }), "released");
    isKind(await c.infer("releaseApiUndispatched", { handle: prefetch.handle, reason: "revoked-before-fetch" }), "released");
    await finish(c);
  }
  {
    const c = await fresh("P12"),
      first = await paid(c, "foreign-pending", "foreign"),
      second = await paid(c, "foreign-unresolved", "foreign");
    await c.action("clock", NOW + DAY + 1);
    isKind(await c.infer("deferPaidReconciliation", { attemptHandle: second.attemptHandle }, randomUUID(), "foreign"), "write");
    await c.call("revokeKey");
    const blocked = await c.call("deleteKey");
    assert.equal(blocked.code, "paid_fallback_billing_outstanding");
    assert(blocked.message.includes("pending=1, unresolved=1, markers=2"));
    const guard = (await c.evidence()).rows.paid_deletion_guard[0];
    assert.equal(guard.expiresAtMs, null);
    isKind(await c.infer("releasePaidBeforeFetch", { attemptHandle: first.attemptHandle }, randomUUID(), "foreign"), "released");
    const unresolved = await c.evidence();
    isKind(await c.infer("releasePaidBeforeFetch", { attemptHandle: second.attemptHandle }, randomUUID(), "foreign"), "unchanged");
    const retained = await c.evidence();
    for (const family of ["paid_request", "paid_window", "paid_pending"]) assert.deepEqual(retained.rows[family], unresolved.rows[family]);
    const stillBlocked = await c.call("deleteKey");
    assert.equal(stillBlocked.code, "paid_fallback_billing_outstanding");
    assert(stillBlocked.message.includes("pending=0, unresolved=1, markers=1"));
    const providerRequestId = "foreign-deferred-bill";
    await c.infer(
      "recordPaidAttemptLifecycle",
      { attemptHandle: second.attemptHandle, patch: { provider_request_id: providerRequestId, terminal_state: "completed" } },
      randomUUID(),
      "foreign"
    );
    const claim = await c.infer("claimPaidReconciliation", { limit: 100 }, randomUUID(), "foreign");
    isKind(claim, "claimed");
    assert.equal(claim.detail.length, 1);
    assert.equal(claim.detail[0].attemptHandle, second.attemptHandle);
    const settled = await c.infer(
      "recordVerifiedPaidBilling",
      {
        attemptHandle: claim.detail[0].attemptHandle,
        log: { request_id: providerRequestId, quota: 7, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: NOW / 1000 },
      },
      randomUUID(),
      "foreign"
    );
    isKind(settled, "settled");
    assert.equal(settled.detail.billing_state, "settled");
    assert.equal(settled.detail.terminal_state, "completed");
    assert.equal(settled.detail.spend_microcredits, 7);
    isKind(await c.infer("finishPaidReconciliation", { lease: claim.lease }, randomUUID(), "foreign"), "finished");
    const reconciled = await c.evidence();
    assert.equal(count(reconciled, "paid_pending"), 0);
    assert.equal(count(reconciled, "paid_lease"), 0);
    assert(reconciled.rows.paid_request.some((item) => item.value.billing_state === "not_billed" && item.value.terminal_state === "cancelled"));
    assert(reconciled.rows.paid_request.some((item) => item.value.provider_request_id === providerRequestId && item.value.billing_state === "settled"));
    assert.equal(row(reconciled, "paid_window").reserved_microcredits, 0);
    assert.equal(row(reconciled, "paid_window").pending_count, 0);
    assert.equal(row(reconciled, "paid_window").settled_microcredits, 7);
    assert.equal(row(reconciled, "paid_rollup").request_count, 1);
    assert.equal(row(reconciled, "paid_rollup").spend_microcredits, 7);
    isKind(await c.call("deleteKey", {}, "delete"), "applied");
    const e = await c.evidence();
    assert.equal(count(e, "api_request"), 0);
    assert.equal(count(e, "api_key_hash"), 0);
    assert.equal(count(e, "api_policy"), 0);
    assert.deepEqual(row(e, "paid_deletion_guard"), { created_at_ms: NOW + DAY + 1 });
    assert(e.cleanupObservations.every((o) => o.idAbsent && o.hashAbsent && o.projectionAbsent && o.apiRows === 2 && o.deleteAudits === 1));
    isKind(await c.call("deleteKey", {}, "delete"), "historical_ack");
    assert.equal((await c.call("deleteKey", {}, "fresh-delete")).status, 404);
    await finish(c, { unresolved, retained, reconciled });
  }
  {
    const c = await fresh("P13"),
      attempt = await paid(c, "local-paid");
    await c.call("revokeKey");
    assert.equal((await c.call("deleteKey")).code, "paid_fallback_billing_outstanding");
    assert.deepEqual(row(await c.evidence(), "paid_deletion_guard").local_deletion, { owner: null, completed_at_ms: null });
    await c.infer("releasePaidBeforeFetch", { attemptHandle: attempt.attemptHandle });
    await c.action("mode", { name: "cleanupFailure", value: true });
    await fault(c.call("deleteKey", {}, "local-delete"), /synthetic joined cleanup failure/);
    const failed = await c.evidence();
    assert.equal(row(failed, "paid_deletion_guard").local_deletion.completed_at_ms, null);
    await c.action("mode", { name: "cleanupFailure", value: false });
    await restart();
    isKind(await c.call("deleteKey", {}, "local-delete"), "historical_ack");
    const e = await c.evidence();
    assert.equal(row(e, "paid_deletion_guard").local_deletion.completed_at_ms, NOW);
    assert.equal(count(e, "paid_lease"), 0);
    assert.equal(e.rows.api_key_audit.filter((x) => x.value.action === "delete").length, 1);
    assert.equal(e.rows.paid_deletion_guard[0].expiresAtMs, null);
    await finish(c, { failed });
  }
  {
    const c = await fresh("P14");
    await c.call("revokeKey", {}, "lost-ack");
    const before = await c.evidence();
    await restart();
    isKind(await c.call("revokeKey", {}, "lost-ack"), "historical_ack");
    let e = await c.evidence();
    assert.notEqual(e.incarnation, before.incarnation);
    assert.deepEqual(e.rows.api_key_hash, before.rows.api_key_hash);
    assert.deepEqual(e.calls, before.calls);
    await c.action("grant", "revoked");
    await deny(c.call("revokeKey", {}, "lost-ack"), "control_grant_denied");
    e = await c.evidence();
    assert.equal(row(e, "key_control_grant").revoked, true);
    assert.equal(count(e, "api_key_audit"), 1);
    await finish(c);
  }
  {
    const c = await fresh("P15"),
      args = { input: { name: "concurrent", paid_fallback_enabled: true, paid_fallback_limit_credits: -1 } };
    await c.action("barrier", "pricing");
    const first = c.call("createKey", args, "concurrent", "create", { client: "bun" });
    await wait(c, (e) => e.barriers.pricing?.entered === 1);
    const second = c.call("createKey", args, "concurrent", "create", { client: "worker" });
    await wait(c, (e) => e.active === 2 && e.verifications.length >= 2);
    await c.action("release", "pricing");
    assert.deepEqual((await Promise.all([first, second])).map((r) => r.kind).sort(), ["applied", "historical_ack"]);
    const e = await c.evidence();
    for (const stage of ["token", "pricing", "uuid"]) assert.equal(e.calls.filter((x) => x === stage).length, 1);
    assert.equal(count(e, "api_key_audit"), 1);
    await deny(c.call("createKey", { input: { ...args.input, name: "changed" } }, "concurrent", "create"), "control_operation_replay_conflict");
    await c.call("revokeKey", {}, "target-bound");
    await deny(c.call("revokeKey", {}, "target-bound", "other-target"), "control_operation_replay_conflict");
    await finish(c);
  }
  {
    const c = await fresh("P16");
    await c.action("mode", { name: "noUnrostered", value: true });
    await deny(c.call("createKey", { input: { name: "missing-binding" } }, randomUUID(), "create"), "trusted_unrostered_binding_unavailable");
    assert.equal(count(await c.evidence(), "api_key_audit"), 0);
    isKind(await c.call("updateKey", { input: { name: "preserved" } }), "applied");
    assert.equal(row(await c.evidence(), "api_policy").paid.allowUnrosteredUnlimited, true);
    await finish(c);
  }
  {
    const c = await fresh("P17"),
      args = { requestId: "before-revocation", route: "/v1/responses", model: "fixture", stream: false };
    isKind(await c.infer("reserveApiUsage", args, "admission"), "reserved");
    await c.action("raw", "revoke");
    isKind(await c.infer("reserveApiUsage", { ...args, requestId: "after-revocation" }), "unauthorized");
    await deny(c.infer("reserveApiUsage", args, "admission"), "api_policy_revoked");
    await c.action("raw", "remove-h");
    isKind(await c.infer("reserveApiUsage", { ...args, requestId: "after-removal" }), "unauthorized");
    const e = await c.evidence();
    assert.equal(row(e, "api_policy").revoked, false);
    assert.equal(count(e, "request_lifetime"), 1);
    await finish(c);
  }
  {
    const c = await fresh("P18");
    await c.action("fault", { name: "audit", enabled: true });
    await fault(c.call("revokeKey", {}, "atomic-revoke"), /synthetic audit fault/);
    let e = await c.evidence();
    assert.equal(row(e, "api_key_hash").revoked_at_ms, null);
    assert.equal(row(e, "api_policy").revoked, false);
    await c.action("fault", { name: "audit", enabled: false });
    await c.call("revokeKey");
    await c.action("fault", { name: "audit", enabled: true });
    await fault(c.call("unrevokeKey", {}, "atomic-unrevoke"), /synthetic audit fault/);
    await fault(c.call("deleteKey", {}, "atomic-delete"), /synthetic audit fault/);
    e = await c.evidence();
    assert.equal(row(e, "api_key_id").revoked_at_ms, NOW);
    assert.equal(row(e, "paid_deletion_guard").local_deletion.owner, null);
    assert.equal(count(e, "api_key_audit"), 1);
    await c.action("fault", { name: "audit", enabled: false });
    isKind(await c.call("deleteKey", {}, "atomic-delete"), "applied");
    await finish(c);
  }
  {
    const c = await fresh("P19");
    await c.call("revokeKey");
    const observations = [];
    for (const guard of ["legacy", "foreign", "completed"]) {
      await c.action("guard", guard);
      const before = await c.evidence();
      assert.equal((await c.call("deleteKey")).code, "paid_fallback_deletion_in_progress");
      const after = await c.evidence();
      assert.deepEqual(after.rows.paid_deletion_guard, before.rows.paid_deletion_guard);
      assert.equal(count(after, "api_key_id"), 1);
      observations.push(after);
      if (guard === "foreign") {
        await restart();
        assert.equal((await c.call("deleteKey")).code, "paid_fallback_deletion_in_progress");
        assert.deepEqual((await c.evidence()).rows.paid_deletion_guard, before.rows.paid_deletion_guard);
      }
    }
    await finish(c, { tombstoneObservations: observations });
  }
  {
    const c = await fresh("P20");
    await c.action("mode", { name: "pricingFailure", value: "native" });
    assert.deepEqual(
      await c.call("createKey", { input: { name: "pricing", paid_fallback_enabled: true, paid_fallback_limit_credits: -1 } }, randomUUID(), "create"),
      nativeBindings.pricingFailure
    );
    await c.action("mode", { name: "pricingFailure", value: "unknown" });
    assert.deepEqual(
      await c.call("createKey", { input: { name: "pricing", paid_fallback_enabled: true, paid_fallback_limit_credits: -1 } }, randomUUID(), "create"),
      nativeBindings.unknownPricingFailure
    );
    await c.action("mode", { name: "pricingFailure", value: false });
    const r = await c.call("updateKey", { input: { paid_fallback_enabled: true, paid_fallback_limit_credits: -1, reset_usage: "invalid" } });
    assert.equal(r.message, "reset_usage must be a boolean");
    const e = await c.evidence();
    assert.equal(e.calls.filter((x) => x === "pricing").length, 3);
    assert.equal(count(e, "api_key_audit"), 0);
    assert.equal(row(e, "api_key_id").paid_fallback_enabled, false);
    await finish(c);
  }
  {
    const c = await fresh("P21");
    await c.call("revokeKey", {}, "historical");
    await c.action("grant", "malformed");
    await deny(c.call("revokeKey", {}, "historical"), "control_grant_denied");
    assert.equal(count(await c.evidence(), "api_key_audit"), 1);
    await finish(c);
  }
  {
    const c = await fresh("P22");
    await c.action("raw", "quota-v2");
    isKind(await c.call("updateKey", { input: {} }), "unchanged");
    await c.call("revokeKey");
    await c.call("unrevokeKey");
    assert.equal((await c.call("resolvePrincipal", {}, "incomplete", "resolver")).status, 503);
    isKind(await c.infer("reserveApiUsage", { requestId: "migration", route: "/v1/responses", model: "fixture", stream: false }), "unauthorized");
    assert.equal(count(await c.evidence(), "api_key_audit"), 2);
    await finish(c);
  }
  {
    const c = await fresh("P23");
    await c.action("clock", NOW + 59_000);
    const handles = [];
    for (let i = 0; i < 6; i++) handles.push(await reserve(c, "original-window-" + i));
    isKind(await c.infer("reservePaidAttempt", { handle: handles[0], hopId: "paid" }), "reserved");
    await c.action("clock", NOW + 60_001);
    const second = await c.infer("reservePaidAttempt", { handle: handles[1], hopId: "paid" });
    isKind(second, "reserved");
    const late = (await c.evidence()).rows.attempt_lifetime.find((x) => x.value.handle === second.attemptHandle).value;
    assert.equal(late.windowResetAtMs, NOW + 60_000);
    for (const handle of handles.slice(2, 5)) isKind(await c.infer("reservePaidAttempt", { handle, hopId: "paid" }), "reserved");
    assert.equal((await c.infer("reservePaidAttempt", { handle: handles[5], hopId: "paid" })).detail, "limit_exceeded");
    const following = await reserve(c, "following-window");
    isKind(await c.infer("reservePaidAttempt", { handle: following, hopId: "paid" }), "reserved");
    const windows = (await c.evidence()).rows.paid_window.map((x) => x.value);
    assert(windows.some((x) => x.window_reset_at_ms === NOW + 60_000 && x.reserved_microcredits === 200));
    assert(windows.some((x) => x.window_reset_at_ms === NOW + 120_000 && x.reserved_microcredits === 40));
    await finish(c, { delayedAdmission: late });
  }
  {
    const c = await fresh("P24");
    await reserve(c, "cleanup-api-row");
    await c.call("revokeKey");
    await c.action("barrier", "cleanup");
    const first = c.call("deleteKey", {}, "cleanup-race", "admin", { client: "bun" });
    await wait(c, (e) => e.barriers.cleanup?.entered === 1);
    const second = c.call("deleteKey", {}, "cleanup-race", "admin", { client: "worker" });
    const pending = await wait(c, (e) => e.active === 2 && e.verifications.length >= 3);
    assert.equal(pending.cleanupCalls, 1);
    assert.equal(pending.cleanupSettled, 0);
    assert.equal(pending.logRows, 1);
    assert.equal(row(pending, "paid_deletion_guard").local_deletion.completed_at_ms, null);
    assert.equal(pending.reprovisionEligible, false);
    assert.equal(count(pending, "api_request"), 1);
    assert.equal(pending.controls.filter((x) => x.method === "deleteKey").length, 0);
    await c.action("release", "cleanup");
    assert.deepEqual(
      (await Promise.all([first, second])).map((r) => r.kind),
      ["applied", "historical_ack"]
    );
    const e = await c.evidence();
    assert.equal(e.cleanupCalls, 1);
    assert.equal(e.cleanupSettled, 1);
    assert.equal(e.logRows, 0);
    assert.equal(row(e, "paid_deletion_guard").local_deletion.completed_at_ms, NOW);
    assert.equal(e.reprovisionEligible, true);
    assert.equal(count(e, "api_request"), 0);
    await finish(c, { pending });
  }
  {
    const c = await fresh("P25"),
      args = { input: { name: "recoverable preparation" } };
    await c.action("fault", { name: "preparation", enabled: true });
    await fault(c.call("createKey", args, "failed-preparation", "create"), /synthetic preparation fault/);
    const failed = await c.evidence();
    assert.equal(count(failed, "api_key_id"), 1);
    assert.equal(count(failed, "api_key_audit"), 0);
    assert.equal(count(failed, "key_control_receipt"), 0);
    await c.action("fault", { name: "preparation", enabled: false });
    const r = await c.call("createKey", args, "failed-preparation", "create");
    isKind(r, "applied");
    assert.equal(r.keyId, "synthetic-uuid-1");
    assert.deepEqual((await c.evidence()).calls.slice(failed.calls.length), ["audit-uuid", "release"]);
    isKind(await c.call("createKey", args, "failed-preparation", "create"), "historical_ack");
    assert.equal(count(await c.evidence(), "api_key_audit"), 1);
    await finish(c, { failed });
  }
  {
    const c = await fresh("P26"),
      args = { input: { name: "recover source" } };
    await c.action("mode", { name: "hashFailure", value: true });
    await fault(c.call("createKey", args, "source-retry", "create"), /synthetic hash source unavailable/);
    await deny(c.call("createKey", { input: { name: "changed" } }, "source-retry", "create"), "control_operation_replay_conflict");
    await deny(c.call("createKey", args, "source-retry", "private-token"), "control_operation_replay_conflict");
    await c.action("grant", "revoked");
    await deny(c.call("createKey", args, "source-retry", "create"), "control_grant_denied");
    await c.action("grant", "restore");
    await c.action("mode", { name: "hashFailure", value: false });
    isKind(await c.call("createKey", args, "source-retry", "create"), "applied");
    const e = await c.evidence();
    for (const stage of ["token", "clock", "defaults", "uuid"]) assert.equal(e.calls.filter((x) => x === stage).length, 1);
    assert.equal(e.calls.filter((x) => x === "hash").length, 2);
    assert.equal(count(e, "api_key_audit"), 1);
    isKind(await c.call("createKey", args, "source-retry", "create"), "historical_ack");
    await finish(c);
  }
  {
    const c = await fresh("P27");
    await reserve(c, "cleanup-failure-log");
    await c.call("revokeKey");
    await c.action("barrier", "cleanup");
    await c.action("mode", { name: "cleanupFailure", value: true });
    const first = c.call("deleteKey", {}, "cleanup-failure", "admin", { client: "bun" });
    const firstFailure = fault(first, /synthetic joined cleanup failure/);
    await wait(c, (e) => e.barriers.cleanup?.entered === 1);
    const second = c.call("deleteKey", {}, "cleanup-failure", "admin", { client: "worker" });
    const secondFailure = fault(second, /synthetic joined cleanup failure/);
    const pending = await wait(c, (e) => e.active === 2 && e.verifications.length >= 3);
    assert.equal(pending.cleanupCalls, 1);
    assert.equal(pending.cleanupSettled, 0);
    assert.equal(pending.logRows, 1);
    assert.equal(pending.reprovisionEligible, false);
    await c.action("release", "cleanup");
    await Promise.all([firstFailure, secondFailure]);
    const failed = await c.evidence();
    assert.equal(failed.cleanupSettled, 0);
    assert.equal(failed.logRows, 1);
    assert.equal(row(failed, "paid_deletion_guard").local_deletion.completed_at_ms, null);
    assert.deepEqual(failed.rows.paid_deletion_guard, pending.rows.paid_deletion_guard);
    assert.equal(failed.rows.key_control_receipt.find((x) => x.value.cleanup).value.cleanup.keyId, "local-development");
    await c.action("mode", { name: "cleanupFailure", value: false });
    isKind(await c.call("deleteKey", {}, "cleanup-failure"), "historical_ack");
    const completed = await c.evidence();
    assert.equal(completed.cleanupSettled, 1);
    assert.equal(completed.logRows, 0);
    assert.equal(completed.cleanupCalls, 2);
    assert.equal(row(completed, "paid_deletion_guard").local_deletion.completed_at_ms, NOW);
    await restart();
    isKind(await c.call("deleteKey", {}, "cleanup-failure"), "historical_ack");
    const e = await c.evidence();
    assert.equal(e.cleanupCalls, 2);
    assert.deepEqual(e.calls, completed.calls);
    assert.equal(e.rows.api_key_audit.filter((x) => x.value.action === "delete").length, 1);
    await finish(c, { pending, failed, completed });
  }
  {
    const c = await fresh("P28"),
      { handle, attemptHandle } = await paid(c, "retention");
    await c.infer("markApiDispatch", { handle, provider: "metered" });
    await c.infer("recordTransportStarted", { handle, provider: "metered", attemptHandle });
    await c.infer("recordPaidAttemptLifecycle", { attemptHandle, patch: { provider_request_id: "retained-bill", terminal_state: "completed" } });
    await c.infer("recordSemanticTerminal", { handle, attemptHandle, outcome: "completed" });
    await c.infer("recordVerifiedPaidBilling", {
      attemptHandle,
      log: { request_id: "retained-bill", quota: 7, prompt_tokens: 3, completion_tokens: 2, model: "fixture", created_at: NOW / 1000 },
    });
    await c.call("revokeKey", {}, "retained-audit");
    isKind(await c.infer("beginPaidKeyDeletion"), "deleted");
    const before = await c.evidence();
    for (const family of ["api_key_id", "api_key_hash", "paid_rollup", "paid_deletion_guard"]) {
      assert.equal(count(before, family), 1);
      assert.equal(before.rows[family][0].expiresAtMs, null);
    }
    for (const x of [...before.rows.api_request, ...before.rows.api_window]) assert.equal(x.expiresAtMs, NOW + 60_000 + RETENTION);
    assert.equal(before.rows.api_key_audit[0].expiresAtMs, NOW + 90 * DAY);
    await c.action("clock", NOW + 90 * DAY + 1);
    isKind(await c.call("revokeKey", {}, "retained-audit"), "historical_ack");
    const after = await c.evidence();
    assert.deepEqual(after.rows.api_key_audit, before.rows.api_key_audit);
    assert.deepEqual(after.rows.paid_rollup, before.rows.paid_rollup);
    assert.deepEqual(after.rows.paid_deletion_guard, before.rows.paid_deletion_guard);
    assert.equal(after.visibleCounts.api_key_audit, 0);
    assert.equal(after.visibleCounts.api_request, 0);
    assert.equal(after.visibleCounts.api_window, 0);
    for (const family of ["api_key_id", "api_key_hash", "paid_rollup", "paid_deletion_guard"]) assert.equal(after.visibleCounts[family], 1);
    await finish(c, { retentionBefore: before });
  }
  assert.deepEqual(
    cases.map((c) => c.id),
    PRINCIPAL_CONTROL_CASE_IDS
  );
  assert.equal(contexts.size, PRINCIPAL_CONTROL_CASE_IDS.length);
  return {
    state: "passed",
    orderedCaseIds: PRINCIPAL_CONTROL_CASE_IDS,
    cases,
    nativeBindings,
    clients: cases.reduce((sum, c) => ({ bun: sum.bun + c.clients.bun, worker: sum.worker + c.clients.worker }), { bun: 0, worker: 0 }),
    cleanupCalls: cases.reduce((sum, c) => sum + c.after.cleanupCalls, 0),
    sqliteObjects: cases.map((c) => c.after.doId),
    inferenceBaseline: "all original 22 scenarios and main 402-row atom retained independently",
    reprovisionAcceptance: "actual authority completion guard and available cleanup rows; full native provisioner and request-log handler port remain deferred",
  };
}
