import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorityState, PortableAuthority } from "../src/authority/admission-state.ts";
import { DeliveryOutbox } from "../src/authority/delivery-outbox.ts";
import type { AccountBinding, AuthorityState, AuthorityStore, TerminalEvidence } from "../src/authority/contracts.ts";

const scope = { namespace: "synthetic-settlement", epoch: 1 };
const fixture = (saved?: AuthorityState) => {
  const account: AccountBinding = {
    accountId: "a",
    fingerprint: "fp",
    credentialGeneration: 1,
    routingGeneration: 1,
    resetGeneration: 1,
    overageVersion: 1,
    overageEnabled: false,
    enabled: true,
    models: ["fixture"],
    proof: { kind: "quota_exhausted", model: "fixture", fingerprint: "fp", observedAtMs: 1, validUntilMs: 10_000 },
  };
  let state =
    saved ??
    createAuthorityState(
      scope,
      [account],
      [
        {
          principalId: "p",
          version: 1,
          deleted: false,
          windowResetAtMs: 10_000,
          requestLimit: 10,
          kernelLimit: 10,
          concurrencyLimit: 10,
          paidLimitMicrocredits: 100,
        },
      ]
    );
  let revision = 0;
  const store: AuthorityStore = {
    read() {
      return Promise.resolve({ revision, state: structuredClone(state) });
    },
    compareAndSwap(expected, candidate) {
      if (expected !== revision) return Promise.resolve(false);
      state = structuredClone(candidate);
      revision += 1;
      return Promise.resolve(true);
    },
  };
  return { authority: new PortableAuthority(store, scope), state: () => state };
};
const admitted = async (authority: PortableAuthority) =>
  await authority.admit({
    scope,
    requestId: "request",
    principalId: "p",
    policyVersion: 1,
    digest: "digest",
    route: "/v1/responses",
    model: "fixture",
    nowMs: 100,
  });
const completed: TerminalEvidence = { outcome: "completed", providerRequestId: "openlux-id", spendMicrocredits: null, fallback: null };

test("separate paid-hop billing survives abort and terminal/outbox replay after persisted fixture restart", async () => {
  const f = fixture();
  const handle = await admitted(f.authority);
  const first = { attemptId: "surplus-hop", provider: "surplus" as const, account: null, maximumExposureMicrocredits: 40 };
  await f.authority.reserveAttempt(handle, first, 100);
  await f.authority.reserveAttempt(handle, first, 100);
  expect(await f.authority.beginDispatch(handle, first.attemptId, 100)).toBe(true);
  expect(await f.authority.beginDispatch(handle, first.attemptId, 100)).toBe(false);
  await f.authority.confirmDispatched(handle, first.attemptId);
  await f.authority.observeTerminal(
    handle,
    first.attemptId,
    { outcome: "failed", providerRequestId: "surplus-id", spendMicrocredits: 3, fallback: "quota_exhausted" },
    false
  );
  await f.authority.reserveAttempt(handle, { attemptId: "openlux-hop", provider: "openlux", account: null, maximumExposureMicrocredits: 50 }, 100);
  await f.authority.beginDispatch(handle, "openlux-hop", 100);
  await f.authority.confirmDispatched(handle, "openlux-hop");
  await f.authority.observeTerminal(handle, "openlux-hop", completed);
  const beforeDelivery = Object.values(f.state().windows)[0];
  expect(beforeDelivery.kernelCompleted).toBe(1);
  expect(beforeDelivery.dispatched).toBe(1);
  expect(beforeDelivery.paidReservedMicrocredits).toBe(50);
  expect(await f.authority.settle(handle)).toBe("pending");
  const directory = await mkdtemp(join(tmpdir(), "uos-authority-restart-"));
  try {
    const path = join(directory, "state.json");
    await writeFile(path, JSON.stringify(f.state()));
    const saved: AuthorityState = JSON.parse(await readFile(path, "utf8"));
    const restart = fixture(saved);
    const outbox = new DeliveryOutbox(restart.authority, handle);
    await outbox.delivery("interrupted");
    await outbox.terminal("openlux-hop", completed);
    await restart.authority.observeUsage(handle, "openlux-hop", { providerRequestId: "openlux-id", spendMicrocredits: 12 });
    await restart.authority.observeUsage(handle, "openlux-hop", { providerRequestId: "openlux-id", spendMicrocredits: 12 });
    await outbox.terminal("openlux-hop", completed);
    expect(await restart.authority.settle(handle)).toBe("settled");
    expect(Object.values(restart.state().windows)[0]).toMatchObject({
      dispatched: 1,
      reserved: 0,
      kernelCompleted: 1,
      kernelReserved: 0,
      active: 0,
      paidReservedMicrocredits: 0,
      paidSettledMicrocredits: 15,
    });
    await assert.rejects(
      restart.authority.observeUsage(handle, "openlux-hop", { providerRequestId: "surplus-id", spendMicrocredits: 12 }),
      /usage_correlation_mismatch/
    );
    await assert.rejects(
      restart.authority.observeUsage(handle, "openlux-hop", { providerRequestId: "openlux-id", spendMicrocredits: 13 }),
      /usage_evidence_conflict/
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("indeterminate dispatch stays pending and cannot refund or replay", async () => {
  const f = fixture();
  const handle = await admitted(f.authority);
  await f.authority.reserveAttempt(handle, { attemptId: "hop", provider: "surplus", account: null, maximumExposureMicrocredits: 50 }, 100);
  await f.authority.beginDispatch(handle, "hop", 100);
  await assert.rejects(f.authority.releaseBeforeDispatch(handle, "hop"), /dispatch_indeterminate/);
  await assert.rejects(f.authority.cancelUndispatched(handle), /dispatch_indeterminate/);
  await f.authority.observeDelivery(handle, "unobserved");
  expect(await f.authority.settle(handle)).toBe("pending");
  expect(Object.values(f.state().windows)[0].paidReservedMicrocredits).toBe(50);
});

test("pretransport cancellation releases every reservation once", async () => {
  const f = fixture();
  const handle = await admitted(f.authority);
  await f.authority.reserveAttempt(handle, { attemptId: "hop", provider: "surplus", account: null, maximumExposureMicrocredits: 50 }, 100);
  await f.authority.cancelUndispatched(handle);
  await f.authority.cancelUndispatched(handle);
  expect(Object.values(f.state().windows)[0]).toMatchObject({ reserved: 0, dispatched: 0, active: 0, paidReservedMicrocredits: 0, kernelReserved: 0 });
});
