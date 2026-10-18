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
