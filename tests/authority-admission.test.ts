import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createAuthorityState, PortableAuthority } from "../src/authority/admission-state.ts";
import type { AccountBinding, AdmissionHandle, AuthorityState, AuthorityStore, PrincipalPolicy } from "../src/authority/contracts.ts";

const scope = { namespace: "synthetic-admission", epoch: 1 };
const now = 1_000;
const account = (accountId: string): AccountBinding => ({
  accountId,
  fingerprint: `${accountId}-fp`,
  credentialGeneration: 0,
  routingGeneration: 1,
  resetGeneration: 1,
  overageVersion: 1,
  overageEnabled: false,
  enabled: true,
  models: ["fixture"],
  proof: null,
});
const policy: PrincipalPolicy = {
  principalId: "p",
  version: 1,
  deleted: false,
  windowResetAtMs: 10_000,
  requestLimit: 2,
  kernelLimit: 2,
  concurrencyLimit: 2,
  paidLimitMicrocredits: 100,
};
const fixture = () => {
  let state = createAuthorityState(scope, [account("a"), account("b")], [policy, { ...policy, principalId: "q" }]);
  let revision = 0;
  let conflict: ((state: AuthorityState) => void) | null = null;
  const store: AuthorityStore = {
    read() {
      return Promise.resolve({ revision, state: structuredClone(state) });
    },
    compareAndSwap(expected, candidate) {
      if (conflict) {
        conflict(state);
        conflict = null;
        revision += 1;
        return Promise.resolve(false);
      }
      if (expected !== revision) return Promise.resolve(false);
      state = structuredClone(candidate);
      revision += 1;
      return Promise.resolve(true);
    },
  };
  return {
    authority: new PortableAuthority(store, scope),
    store,
    state: () => state,
    conflict: (action: (value: AuthorityState) => void) => {
      conflict = action;
    },
  };
};
const input = (requestId: string, principalId = "p") => ({
  scope,
  requestId,
  principalId,
  policyVersion: 1,
  digest: "digest",
  route: "/v1/responses" as const,
  model: "fixture",
  nowMs: now,
});

test("concurrent shared-principal admissions retry CAS without exceeding quota; another principal shares global active", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.authority.admit(input("r1")), f.authority.admit(input("r2")), f.authority.admit(input("r3"))]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  const other = await f.authority.admit(input("q1", "q"));
  expect((await f.authority.selection(other)).account?.accountId).toBe("a");
  expect(f.state().active?.generation).toBe(1);
  expect(
    Object.values(f.state().windows)
      .map((window) => window.active)
      .sort((left, right) => left - right)
  ).toEqual([1, 2]);
});

test("request identity, scope and handle fences fail closed while duplicate admission is idempotent", async () => {
  const f = fixture();
  const handle = await f.authority.admit(input("r"));
  expect(await f.authority.admit(input("r"))).toEqual(handle);
  await assert.rejects(f.authority.admit({ ...input("r"), digest: "different" }), /request_identity_conflict/);
  await assert.rejects(f.authority.admit({ ...input("s"), scope: { ...scope, epoch: 2 } }), /namespace_or_epoch_mismatch/);
  await assert.rejects(f.authority.selection({ ...handle, fence: 999 }), /admission_fence_mismatch/);
});

test("a CAS conflict rereads principal deletion and cannot return stale admission success", async () => {
  const f = fixture();
  f.conflict((state) => {
    state.policies.p = { ...policy, deleted: true };
  });
  await assert.rejects(f.authority.admit(input("r")), /principal_policy_changed/);
  expect(Object.keys(f.state().admissions)).toHaveLength(0);
});

test("global active survives restart and reorder; replacement fences a reserved dispatch", async () => {
  const f = fixture();
  const handle = await f.authority.admit(input("r"));
  const selected = await f.authority.selection(handle);
  await f.authority.reserveAttempt(handle, { attemptId: "a1", provider: "codex", account: selected.account, maximumExposureMicrocredits: 0 }, now);
  f.state().accounts.reverse();
  const restart = new PortableAuthority(f.store, scope);
  const other = await restart.admit(input("q", "q"));
  expect((await restart.selection(other)).account?.accountId).toBe("a");
  f.state().accounts = f.state().accounts.map((value) => (value.accountId === "a" ? { ...value, fingerprint: "new", credentialGeneration: 1 } : value));
  await assert.rejects(restart.beginDispatch(handle, "a1", now), /account_fence_mismatch/);
});

test("transient, stale and mixed proof cannot authorize paid fallback or reset redemption", async () => {
  const f = fixture();
  f.state().accounts = f.state().accounts.map((value) => ({
    ...value,
    proof: {
      kind: value.accountId === "a" ? "quota_exhausted" : "transient",
      model: "fixture",
      fingerprint: value.fingerprint,
      observedAtMs: 900,
      validUntilMs: 2_000,
    },
  }));
  await assert.rejects(f.authority.admit(input("r")), /routing_unavailable/);
  f.state().accounts = f.state().accounts.map((value) => ({
    ...value,
    proof: { kind: "credential_invalid", model: "fixture", fingerprint: value.fingerprint, observedAtMs: 900, validUntilMs: 2_000 },
  }));
  const handle = await f.authority.admit(input("paid"));
  expect(await f.authority.resetEligible(handle, now)).toBe(false);
  await f.authority.reserveAttempt(handle, { attemptId: "paid1", provider: "surplus", account: null, maximumExposureMicrocredits: 50 }, now);
  await assert.rejects(f.authority.beginDispatch(handle, "paid1", 2_001), /paid_pool_proof_required/);
});

test("a window rollover between reserve and dispatch is fenced", async () => {
  const f = fixture();
  const handle = await f.authority.admit(input("r"));
  await f.authority.reserveAttempt(
    handle,
    { attemptId: "a1", provider: "codex", account: (await f.authority.selection(handle)).account, maximumExposureMicrocredits: 0 },
    now
  );
  f.state().policies.p = { ...policy, windowResetAtMs: 20_000 };
  await assert.rejects(f.authority.beginDispatch(handle, "a1", now), /quota_window_changed/);
});

const dispatchSubscription = async (f: ReturnType<typeof fixture>, handle: AdmissionHandle, attemptId: string): Promise<void> => {
  await f.authority.reserveAttempt(
    handle,
    { attemptId, provider: "codex", account: (await f.authority.selection(handle)).account, maximumExposureMicrocredits: 0 },
    now
  );
  await f.authority.beginDispatch(handle, attemptId, now);
  await f.authority.confirmDispatched(handle, attemptId);
};
const exhaustedSubscription = async () => {
  const f = fixture();
  f.state().policies.p = { ...policy, requestLimit: 1, kernelLimit: 1, concurrencyLimit: 1 };
  const handle = await f.authority.admit(input("failover"));
  await dispatchSubscription(f, handle, "a-hop");
  await f.authority.observeProof(handle, "a-hop", {
    kind: "quota_exhausted",
    model: "fixture",
    fingerprint: "a-fp",
    observedAtMs: now,
    validUntilMs: 2_000,
  });
  await f.authority.observeTerminal(
    handle,
    "a-hop",
    { outcome: "failed", providerRequestId: "a-upstream", spendMicrocredits: 0, fallback: "quota_exhausted" },
    false
  );
  return { ...f, handle };
};

test("strong-proof subscription failover preserves one admission and reservation through CAS retry", async () => {
  const f = await exhaustedSubscription();
  await assert.rejects(f.authority.admit(input("another")), /principal_quota_exceeded/);
  await assert.rejects(
    f.authority.reserveAttempt(f.handle, { attemptId: "paid", provider: "surplus", account: null, maximumExposureMicrocredits: 10 }, now),
    /paid_pool_proof_required/
  );
  f.conflict((state) => {
    state.accounts.reverse();
  });
  expect((await f.authority.reselectSubscription(f.handle, now))?.accountId).toBe("b");
  expect((await f.authority.selection(f.handle)).account?.accountId).toBe("b");
  expect(f.state().active).toEqual({ accountId: "b", fingerprint: "b-fp", generation: 2 });
  expect(Object.keys(f.state().admissions)).toEqual(["failover"]);
  expect(Object.values(f.state().windows)[0]).toMatchObject({ reserved: 0, dispatched: 1, active: 1, kernelReserved: 1 });
  await dispatchSubscription(f, f.handle, "b-hop");
  await f.authority.observeTerminal(f.handle, "b-hop", { outcome: "completed", providerRequestId: "b-upstream", spendMicrocredits: 0, fallback: null });
  await f.authority.observeDelivery(f.handle, "unobserved");
  expect(await f.authority.settle(f.handle)).toBe("settled");
  expect(Object.values(f.state().windows)[0]).toMatchObject({ dispatched: 1, active: 0, kernelReserved: 0, kernelCompleted: 1 });
});

test("subscription reselection rejects pending terminals, weak proof and changed policy or binding fences", async () => {
  const pending = fixture();
  const handle = await pending.authority.admit(input("pending"));
  await dispatchSubscription(pending, handle, "hop");
  await assert.rejects(pending.authority.reselectSubscription(handle, now), /attempt_outcome_pending/);
  for (const proof of [{ kind: "transient" as const }, { validUntilMs: now }, { model: "another-model" }, { fingerprint: "retired-fingerprint" }]) {
    const f = await exhaustedSubscription();
    const current = f.state().accounts[0];
    assert(current.proof);
    f.state().accounts[0] = { ...current, proof: { ...current.proof, ...proof } };
    await assert.rejects(f.authority.reselectSubscription(f.handle, now), /subscription_proof_required/);
    expect(f.state().active?.accountId).toBe("a");
  }
  for (const field of ["credentialGeneration", "routingGeneration", "resetGeneration", "overageVersion"] as const) {
    const f = await exhaustedSubscription();
    f.conflict((state) => {
      state.accounts[0] = { ...state.accounts[0], [field]: state.accounts[0][field] + 1 };
    });
    await assert.rejects(f.authority.reselectSubscription(f.handle, now), /account_fence_mismatch/);
    expect(f.state().admissions.failover.account?.accountId).toBe("a");
  }
  for (const change of [{ deleted: true }, { version: 2 }, { windowResetAtMs: 20_000 }]) {
    const f = await exhaustedSubscription();
    f.state().policies.p = { ...f.state().policies.p, ...change };
    await assert.rejects(f.authority.reselectSubscription(f.handle, now), /principal_policy_changed|quota_window_changed/);
  }
});

test("quota rollover retains outstanding principal concurrency until the old admission settles", async () => {
  const f = fixture();
  f.state().policies.p = { ...policy, concurrencyLimit: 1 };
  const old = await f.authority.admit(input("old-window"));
  await dispatchSubscription(f, old, "old-hop");
  f.state().policies.p = { ...f.state().policies.p, windowResetAtMs: 20_000 };
  const rollover = (requestId: string) => ({ ...input(requestId), nowMs: 10_001 });
  const blocked = await Promise.allSettled([f.authority.admit(rollover("blocked1")), f.authority.admit(rollover("blocked2"))]);
  expect(blocked.every((result) => result.status === "rejected" && String(result.reason).includes("principal_quota_exceeded"))).toBe(true);
  expect(Object.values(f.state().windows).reduce((sum, window) => sum + window.active, 0)).toBe(1);
  await f.authority.observeTerminal(old, "old-hop", { outcome: "completed", providerRequestId: "old-upstream", spendMicrocredits: 0, fallback: null });
  await f.authority.observeDelivery(old, "unobserved");
  expect(await f.authority.settle(old)).toBe("settled");
  const admitted = await Promise.allSettled([f.authority.admit(rollover("new1")), f.authority.admit(rollover("new2"))]);
  expect(admitted.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(Object.values(f.state().windows).reduce((sum, window) => sum + window.active, 0)).toBe(1);
});
