import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createAuthorityState, PortableAuthority } from "../src/authority/admission-state.ts";
import type { AccountBinding, AuthorityState, AuthorityStore, PrincipalPolicy } from "../src/authority/contracts.ts";

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
