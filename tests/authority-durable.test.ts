import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorityState, PortableAuthority } from "../src/authority/admission-state.ts";
import { AuthorityRpcClient, AuthorityRpcServer } from "../src/authority/authority-rpc.ts";
import { DurableAuthorityStore, type AuthoritySqlStorage } from "../src/authority/durable-store.ts";
import type { AccountBinding, AuthorityState } from "../src/authority/contracts.ts";

const scope = { namespace: "synthetic-durable", epoch: 1 };
const maximumBytes = 262_144;
const initial = (paid = false): AuthorityState => {
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
    proof: paid ? { kind: "quota_exhausted", model: "fixture", fingerprint: "fp", observedAtMs: 1, validUntilMs: 10_000 } : null,
  };
  return createAuthorityState(
    scope,
    [account],
    ["p", "q"].map((principalId) => ({
      principalId,
      version: 1,
      deleted: false,
      windowResetAtMs: 10_000,
      requestLimit: 2,
      kernelLimit: 2,
      concurrencyLimit: 2,
      paidLimitMicrocredits: 100,
    }))
  );
};
const input = (requestId: string, principalId = "p") => ({
  scope,
  requestId,
  principalId,
  policyVersion: 1,
  digest: requestId,
  route: "/v1/responses" as const,
  model: "fixture",
  nowMs: 100,
});
const storage = (database: Database, after: () => void = () => {}): AuthoritySqlStorage => ({
  sql: {
    exec: (query, ...bindings) => {
      const rows = database.query<Record<string, unknown>, (string | number | null)[]>(query).all(...bindings);
      return { toArray: () => rows };
    },
  },
  transactionSync<TResult>(callback: () => TResult): TResult {
    return database.transaction(() => {
      const result = callback();
      after();
      return result;
    })();
  },
});
const client = (store: DurableAuthorityStore) => new AuthorityRpcClient(new AuthorityRpcServer(new PortableAuthority(store, scope), maximumBytes));
const onDisk = async (run: (path: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "uos-authority-durable-"));
  try {
    await run(join(directory, "authority.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("two authority clients contend on one actual SQLite atom without exceeding principal quota", async () => {
  await onDisk(async (path) => {
    const database = new Database(path);
    try {
      const store = new DurableAuthorityStore(storage(database), initial(), maximumBytes);
      const left = client(store);
      const right = client(new DurableAuthorityStore(storage(database), initial(), maximumBytes));
      const outcomes = await Promise.allSettled([left.admit(input("one")), right.admit(input("two")), left.admit(input("three"))]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      const other = await right.admit(input("other", "q"));
      expect((await right.selection(other)).account?.accountId).toBe("a");
      const saved = (await store.read()).state;
      expect(saved.active).toEqual({ accountId: "a", fingerprint: "fp", generation: 1 });
      expect(saved.windows[JSON.stringify(["p", 10_000])]).toMatchObject({ active: 2, reserved: 2, dispatched: 0 });
      expect(Object.keys(saved.admissions)).toHaveLength(3);
    } finally {
      database.close();
    }
  });
});

test("restart preserves dispatch intent and refuses duplicate dispatch or an uncertain refund", async () => {
  await onDisk(async (path) => {
    let database = new Database(path);
    try {
      let store = new DurableAuthorityStore(storage(database), initial(true), maximumBytes);
      let authority = client(store);
      const handle = await authority.admit(input("pending"));
      const attempt = { attemptId: "paid", provider: "surplus" as const, account: null, maximumExposureMicrocredits: 40 };
      await authority.reserveAttempt(handle, attempt, 100);
      expect(await authority.beginDispatch(handle, "paid", 100)).toBe(true);
      const before = await store.read();
      database.close();
      database = new Database(path);
      store = new DurableAuthorityStore(storage(database), initial(true), maximumBytes);
      authority = client(store);
      expect(await store.read()).toEqual(before);
      expect(await authority.admit(input("pending"))).toEqual(handle);
      await authority.reserveAttempt(handle, attempt, 100);
      expect(await authority.beginDispatch(handle, "paid", 100)).toBe(false);
      await assert.rejects(authority.releaseBeforeDispatch(handle, "paid"), /dispatch_indeterminate/);
      await assert.rejects(authority.cancelUndispatched(handle), /dispatch_indeterminate/);
      expect(await authority.settle(handle)).toBe("pending");
      expect((await store.read()).state.windows[JSON.stringify(["p", 10_000])]).toMatchObject({ active: 1, reserved: 1, paidReservedMicrocredits: 40 });
    } finally {
      database.close();
    }
  });
});

test("durable terminal and late usage replay settle once without erasing unknown provider exposure", async () => {
  await onDisk(async (path) => {
    let database = new Database(path);
    try {
      let store = new DurableAuthorityStore(storage(database), initial(true), maximumBytes);
      let authority = client(store);
      const handle = await authority.admit(input("billing"));
      await authority.reserveAttempt(handle, { attemptId: "paid", provider: "surplus", account: null, maximumExposureMicrocredits: 40 }, 100);
      await authority.beginDispatch(handle, "paid", 100);
      await authority.confirmDispatched(handle, "paid");
      const terminal = { outcome: "completed" as const, providerRequestId: "synthetic-charge", spendMicrocredits: null, fallback: null };
      await authority.observeTerminal(handle, "paid", terminal);
      database.close();
      database = new Database(path);
      store = new DurableAuthorityStore(storage(database), initial(true), maximumBytes);
      authority = client(store);
      await authority.observeTerminal(handle, "paid", terminal);
      await authority.observeDelivery(handle, "unobserved");
      expect(await authority.settle(handle)).toBe("settled");
      expect((await store.read()).state.windows[JSON.stringify(["p", 10_000])]).toMatchObject({
        active: 0,
        dispatched: 1,
        kernelCompleted: 1,
        paidReservedMicrocredits: 40,
      });
      await authority.observeUsage(handle, "paid", { providerRequestId: "synthetic-charge", spendMicrocredits: 7 });
      await authority.observeUsage(handle, "paid", { providerRequestId: "synthetic-charge", spendMicrocredits: 7 });
      expect(await authority.settle(handle)).toBe("settled");
      expect((await store.read()).state.windows[JSON.stringify(["p", 10_000])]).toMatchObject({
        active: 0,
        dispatched: 1,
        kernelCompleted: 1,
        paidReservedMicrocredits: 0,
        paidSettledMicrocredits: 7,
      });
      await assert.rejects(authority.observeUsage(handle, "paid", { providerRequestId: "synthetic-charge", spendMicrocredits: 8 }), /usage_evidence_conflict/);
    } finally {
      database.close();
    }
  });
});

test("failed SQLite transaction rolls back the whole atom and stale CAS never overwrites a successor", async () => {
  const database = new Database(":memory:");
  try {
    let fail = false;
    const store = new DurableAuthorityStore(
      storage(database, () => {
        if (fail) throw new Error("synthetic commit failure");
      }),
      initial(),
      maximumBytes
    );
    const before = await store.read();
    fail = true;
    await assert.rejects(async () => await store.compareAndSwap(before.revision, { ...before.state, sequence: 9 }), /synthetic commit failure/);
    expect(await store.read()).toEqual(before);
    fail = false;
    expect(await store.compareAndSwap(before.revision, { ...before.state, sequence: 2 })).toBe(true);
    expect(await store.compareAndSwap(before.revision, { ...before.state, sequence: 99 })).toBe(false);
    expect((await store.read()).state.sequence).toBe(2);
  } finally {
    database.close();
  }
});

test("corrupt schema, malformed state, wrong scope and oversized snapshots fail closed without reset", async () => {
  const database = new Database(":memory:");
  try {
    const store = new DurableAuthorityStore(storage(database), initial(), maximumBytes);
    const before = await store.read();
    await assert.rejects(
      async () => await store.compareAndSwap(before.revision, { ...before.state, scope: { ...scope, epoch: 2 } }),
      /namespace_or_epoch_mismatch/
    );
    await assert.rejects(
      async () =>
        await store.compareAndSwap(before.revision, { ...before.state, active: { accountId: "x".repeat(maximumBytes), fingerprint: "fp", generation: 1 } }),
      /authority_state_too_large/
    );
    expect(await store.read()).toEqual(before);
    database.query("UPDATE uos_authority_atom SET schema_version = 2").run();
    assert.throws(() => new DurableAuthorityStore(storage(database), initial(), maximumBytes), /authority_schema_mismatch/);
    expect(database.query<{ schema_version: number }, []>("SELECT schema_version FROM uos_authority_atom").get()?.schema_version).toBe(2);
    database.query("UPDATE uos_authority_atom SET schema_version = 1, state_json = ?").run(JSON.stringify({ scope }));
    assert.throws(() => new DurableAuthorityStore(storage(database), initial(), maximumBytes), /invalid_authority_state/);
    database.query("UPDATE uos_authority_atom SET state_json = ?").run("{");
    await assert.rejects(async () => await store.read(), /invalid_authority_state/);
  } finally {
    database.close();
  }
});

test("data-plane RPC cannot read or replace state and preserves structured quota and namespace refusal", async () => {
  const database = new Database(":memory:");
  try {
    const store = new DurableAuthorityStore(storage(database), initial(), maximumBytes);
    const server = new AuthorityRpcServer(new PortableAuthority(store, scope), 2_000);
    const authority = new AuthorityRpcClient(server);
    for (const operation of ["read", "compareAndSwap", "publish", "setPolicy", "__proto__"]) {
      const command = JSON.parse(JSON.stringify({ operation, arguments: [] }));
      expect(await server.invoke(command)).toEqual({ error: { code: "invalid_authority_operation", status: 400 } });
    }
    await assert.rejects(authority.admit({ ...input("wrong"), scope: { ...scope, epoch: 2 } }), /namespace_or_epoch_mismatch/);
    await assert.rejects(authority.admit({ ...input("huge"), digest: "x".repeat(3_000) }), /authority_command_too_large/);
    expect((await store.read()).state.admissions).toEqual({});
    await authority.admit(input("one"));
    await authority.admit(input("two"));
    await assert.rejects(authority.admit(input("three")), /principal_quota_exceeded/);
    expect("read" in authority || "compareAndSwap" in authority || "publish" in authority).toBe(false);
  } finally {
    database.close();
  }
});

test("RPC refuses uncorrelated or invalid usage identifiers without clearing unknown paid exposure", async () => {
  for (const providerRequestId of [null, "", " ", 0, {}]) {
    const database = new Database(":memory:");
    try {
      const store = new DurableAuthorityStore(storage(database), initial(true), maximumBytes);
      const server = new AuthorityRpcServer(new PortableAuthority(store, scope), maximumBytes);
      const authority = new AuthorityRpcClient(server);
      const handle = await authority.admit(input("uncorrelated"));
      await authority.reserveAttempt(handle, { attemptId: "paid", provider: "surplus", account: null, maximumExposureMicrocredits: 40 }, 100);
      await authority.beginDispatch(handle, "paid", 100);
      await authority.confirmDispatched(handle, "paid");
      await authority.observeTerminal(handle, "paid", { outcome: "completed", providerRequestId: null, spendMicrocredits: null, fallback: null });
      const command = JSON.parse(JSON.stringify({ operation: "observeUsage", arguments: [handle, "paid", { providerRequestId, spendMicrocredits: 0 }] }));
      const reply = await server.invoke(command);
      const saved = (await store.read()).state;
      assert.deepEqual(
        {
          reply,
          reserved: saved.windows[JSON.stringify(["p", 10_000])].paidReservedMicrocredits,
          billingSettled: saved.admissions.uncorrelated.attempts.paid.billingSettled,
        },
        { reply: { error: { code: "invalid_authority_operation", status: 400 } }, reserved: 40, billingSettled: false }
      );
    } finally {
      database.close();
    }
  }
});

test("RPC validates every operation's complete payload before any authority mutation", async () => {
  const database = new Database(":memory:");
  try {
    const store = new DurableAuthorityStore(storage(database), initial(), maximumBytes);
    const server = new AuthorityRpcServer(new PortableAuthority(store, scope), maximumBytes);
    const handle = await client(store).admit(input("shape"));
    const badHandle = { ...handle, fence: -1 };
    const commands = [
      { operation: "admit", arguments: [{ ...input("bad"), requestId: null }] },
      { operation: "admit", arguments: [{ ...input("bad"), nowMs: 0.5 }] },
      { operation: "admit", arguments: [{ ...input("bad"), route: "/arbitrary" }] },
      { operation: "reserveAttempt", arguments: [handle, { attemptId: "a", provider: "arbitrary", account: null, maximumExposureMicrocredits: 0 }, 100] },
      { operation: "reserveAttempt", arguments: [handle, { attemptId: "a", provider: "codex", account: null, maximumExposureMicrocredits: -1 }, 100] },
      { operation: "beginDispatch", arguments: [handle, "a", "100"] },
      { operation: "selection", arguments: [badHandle] },
      { operation: "reselectSubscription", arguments: [handle, Number.MAX_SAFE_INTEGER + 1] },
      { operation: "confirmDispatched", arguments: [badHandle, "a"] },
      { operation: "releaseBeforeDispatch", arguments: [handle, null] },
      { operation: "observeProof", arguments: [handle, "a", { kind: "unknown", model: "fixture", fingerprint: "fp", observedAtMs: 1, validUntilMs: 2 }] },
      { operation: "observeTerminal", arguments: [handle, "a", { outcome: "completed", providerRequestId: null, spendMicrocredits: 0.5, fallback: null }] },
      {
        operation: "observeTerminal",
        arguments: [handle, "a", { outcome: "completed", providerRequestId: null, spendMicrocredits: 0, fallback: null }, "true"],
      },
      { operation: "observeDelivery", arguments: [handle, "assumed_delivered"] },
      { operation: "observeUsage", arguments: [handle, "a", { providerRequestId: "id", spendMicrocredits: -1 }] },
      { operation: "resetEligible", arguments: [handle, -1] },
      { operation: "settle", arguments: [badHandle] },
      { operation: "cancelUndispatched", arguments: [badHandle] },
      { operation: "admit", arguments: [{ ...input("bad"), forgedQuota: 999 }] },
    ];
    const before = await store.read();
    for (const value of commands) {
      const command = JSON.parse(JSON.stringify(value));
      expect(await server.invoke(command)).toEqual({ error: { code: "invalid_authority_operation", status: 400 } });
      expect(await store.read()).toEqual(before);
    }
  } finally {
    database.close();
  }
});

test("restore and CAS reject negative, fractional and unsafe persisted accounting fields without reseeding", async () => {
  const database = new Database(":memory:");
  try {
    const store = new DurableAuthorityStore(storage(database), initial(true), maximumBytes);
    const authority = client(store);
    const handle = await authority.admit(input("corrupt"));
    const before = await store.read();
    const candidates = [
      (state: AuthorityState, value: number) => {
        state.sequence = value;
      },
      (state: AuthorityState, value: number) => {
        state.accounts[0] = { ...state.accounts[0], credentialGeneration: value };
      },
      (state: AuthorityState, value: number) => {
        state.policies.p = { ...state.policies.p, paidLimitMicrocredits: value };
      },
      (state: AuthorityState, value: number) => {
        state.admissions.corrupt.handle = { ...handle, fence: value };
      },
      ...["reserved", "dispatched", "kernelReserved", "kernelCompleted", "active", "paidReservedMicrocredits", "paidSettledMicrocredits"].map(
        (field) => (state: AuthorityState, value: number) => {
          Object.assign(state.windows[JSON.stringify(["p", 10_000])], { [field]: value });
        }
      ),
    ];
    for (const mutate of candidates) {
      for (const value of [-100, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const corrupted = structuredClone(before.state);
        mutate(corrupted, value);
        await assert.rejects(async () => await store.compareAndSwap(before.revision, corrupted), /invalid_authority_state/);
        expect(await store.read()).toEqual(before);
        const encoded = JSON.stringify(corrupted);
        database.query("UPDATE uos_authority_atom SET state_json = ?").run(encoded);
        assert.throws(() => new DurableAuthorityStore(storage(database), initial(true), maximumBytes), /invalid_authority_state/);
        await assert.rejects(async () => await store.read(), /invalid_authority_state/);
        expect(database.query<{ state_json: string }, []>("SELECT state_json FROM uos_authority_atom").get()?.state_json).toBe(encoded);
        database.query("UPDATE uos_authority_atom SET state_json = ?").run(JSON.stringify(before.state));
      }
    }
  } finally {
    database.close();
  }
});

test("validated RPC preserves legitimate proof, reselection, release and optional terminal arguments", async () => {
  const database = new Database(":memory:");
  try {
    const seed = initial();
    seed.accounts.push({ ...seed.accounts[0], accountId: "b", fingerprint: "b-fp" });
    const store = new DurableAuthorityStore(storage(database), seed, maximumBytes);
    const server = new AuthorityRpcServer(new PortableAuthority(store, scope), maximumBytes);
    const authority = new AuthorityRpcClient(server);
    const handle = await authority.admit(input("valid-operations"));
    await authority.reserveAttempt(
      handle,
      { attemptId: "a", provider: "codex", account: (await authority.selection(handle)).account, maximumExposureMicrocredits: 0 },
      100
    );
    expect(await authority.beginDispatch(handle, "a", 100)).toBe(true);
    await authority.confirmDispatched(handle, "a");
    await authority.observeProof(handle, "a", { kind: "quota_exhausted", model: "fixture", fingerprint: "fp", observedAtMs: 100, validUntilMs: 1_000 });
    await authority.observeTerminal(handle, "a", { outcome: "failed", providerRequestId: null, spendMicrocredits: 0, fallback: "quota_exhausted" }, false);
    expect(await authority.resetEligible(handle, 100)).toBe(false);
    const selected = await authority.reselectSubscription(handle, 100);
    expect(selected?.accountId).toBe("b");
    await authority.reserveAttempt(handle, { attemptId: "released", provider: "codex", account: selected, maximumExposureMicrocredits: 0 }, 100);
    await authority.releaseBeforeDispatch(handle, "released");
    await authority.reserveAttempt(handle, { attemptId: "b", provider: "codex", account: selected, maximumExposureMicrocredits: 0 }, 100);
    await authority.beginDispatch(handle, "b", 100);
    await authority.confirmDispatched(handle, "b");
    const evidence = { outcome: "completed" as const, providerRequestId: "b", spendMicrocredits: 0, fallback: null };
    expect(await server.invoke({ operation: "observeTerminal", arguments: [handle, "b", evidence] })).toEqual({ value: undefined });
    expect(await server.invoke({ operation: "observeTerminal", arguments: [handle, "b", evidence, undefined] })).toEqual({ value: undefined });
    await authority.observeDelivery(handle, "unobserved");
    expect(await authority.settle(handle)).toBe("settled");
    expect((await store.read()).state.windows[JSON.stringify(["p", 10_000])]).toMatchObject({ dispatched: 1, kernelCompleted: 1, active: 0 });
  } finally {
    database.close();
  }
});
