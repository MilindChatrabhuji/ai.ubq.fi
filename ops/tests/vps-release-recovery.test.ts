import { test } from "bun:test";
import { mkdir, readFile, readlink } from "node:fs/promises";
import assert from "node:assert/strict";
import { parseVpsReceipt, vpsDigest, type VpsSettlement } from "../vps-release-contract.ts";
import { readVpsPins, VpsOperationJournal } from "../vps-release-journal.ts";
import { makeVpsDriverFixture, mutation } from "./vps-release-driver-fixture.ts";

test("VPS recovery waits for asynchronous candidate and prior listener identity", async () => {
  const fixture = await makeVpsDriverFixture();
  try {
    const prepared = await fixture.prepare();
    fixture.system.listenerFailures.set(fixture.candidateSha, 1);
    const active = await fixture.driver.activate(await mutation(prepared));
    assert.equal(active.phase, "ingress_applied");
    assert.equal(fixture.system.serviceSha, fixture.candidateSha);
    fixture.now += 1000;
    fixture.system.listenerFailures.set(fixture.priorSha, 1);
    const restored = await fixture.driver.restore(await mutation(active));
    assert.equal(restored.phase, "rolled_back");
    assert.equal(restored.restoration?.public.identity.gitSha, fixture.priorSha);
    assert.equal(fixture.system.calls.filter((call) => call.includes("restart")).length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("VPS recovery resumes interrupted restart after the prior selector was restored", async () => {
  const fixture = await makeVpsDriverFixture();
  try {
    const active = await fixture.driver.activate(await mutation(await fixture.prepare()));
    fixture.system.restartFailures = 1;
    await assert.rejects(async () => fixture.driver.restore(await mutation(active)), /interruption before restart/);
    assert.equal(await readlink(`${fixture.root}/.data/current`), fixture.prior.target);
    assert.equal(fixture.system.serviceSha, fixture.candidateSha);
    const pending = await fixture.driver.observe({ operationId: active.operationId, requestDigest: active.binding.requestDigest });
    assert.equal(pending.phase, "rollback_pending");
    fixture.now += 1000;
    const restored = await fixture.driver.restore(await mutation(pending));
    assert.equal(restored.phase, "rolled_back");
    assert.equal(fixture.system.serviceSha, fixture.priorSha);
    const calls = fixture.system.calls.length;
    assert.deepEqual(await fixture.driver.restore(await mutation(restored)), restored);
    assert.equal(fixture.system.calls.length, calls);
  } finally {
    await fixture.cleanup();
  }
});

for (const disposition of ["accepted", "rolled_back", "failed"] as const) {
  test(`VPS recovery retries ${disposition} pin cleanup with exact terminal CAS and original settlement`, async () => {
    const fixture = await makeVpsDriverFixture();
    const releasePin = Object.getOwnPropertyDescriptor(VpsOperationJournal.prototype, "releasePin");
    assert.ok(releasePin);
    try {
      let predecessor = await fixture.prepare();
      if (disposition !== "failed") predecessor = await fixture.driver.activate(await mutation(predecessor));
      if (disposition === "rolled_back") predecessor = await fixture.driver.restore(await mutation(predecessor));
      const input: VpsSettlement = {
        ...(await mutation(predecessor)),
        stateRevision: "d".repeat(40),
        disposition,
        digest: await vpsDigest(predecessor),
      };
      VpsOperationJournal.prototype.releasePin = () => Promise.reject(new Error("fake pin cleanup interruption"));
      await assert.rejects(() => fixture.driver.settle(input), /pin cleanup interruption/);
      Object.defineProperty(VpsOperationJournal.prototype, "releasePin", releasePin);
      const terminal = await fixture.driver.observe(input);
      assert.equal(terminal.phase, disposition);
      assert.equal((await readVpsPins(`${fixture.root}/.data/vps-release-pins.json`)).length, 1);
      assert.equal(terminal.intent === null, disposition === "failed");
      await assert.rejects(() => fixture.driver.settle(input), /receipt_conflict/);
      const retry = { ...input, ...(await mutation(terminal)) };
      await assert.rejects(() => fixture.driver.settle({ ...retry, stateRevision: "f".repeat(40) }), /settlement_unavailable/);
      await assert.rejects(() => fixture.driver.settle({ ...retry, digest: "f".repeat(64) }), /settlement_unavailable/);
      fixture.system.settlementAllowed = false;
      await assert.rejects(() => fixture.driver.settle(retry), /settlement_unavailable/);
      assert.equal((await readVpsPins(`${fixture.root}/.data/vps-release-pins.json`)).length, 1);
      fixture.system.settlementAllowed = true;
      fixture.now += 1000;
      const journal = new VpsOperationJournal(fixture.root);
      const before = await readFile(journal.path(terminal.operationId), "utf8");
      const effects = [fixture.system.calls.length, fixture.system.healthCalls];
      assert.deepEqual(await fixture.driver.settle(retry), terminal);
      assert.deepEqual(await fixture.driver.settle(retry), terminal);
      assert.equal((await readVpsPins(journal.pinsPath)).length, 0);
      assert.equal(await readFile(journal.path(terminal.operationId), "utf8"), before);
      assert.deepEqual([fixture.system.calls.length, fixture.system.healthCalls], effects);
    } finally {
      Object.defineProperty(VpsOperationJournal.prototype, "releasePin", releasePin);
      await fixture.cleanup();
    }
  });
}

test("VPS recovery permits only the exact no-promotion failed receipt and never strips durable intent", async () => {
  const fixture = await makeVpsDriverFixture();
  try {
    const prepared = await fixture.prepare();
    const failed = parseVpsReceipt({
      ...prepared,
      phase: "failed",
      sequence: 2,
      settlement: { stateRevision: "d".repeat(40), disposition: "failed", digest: "e".repeat(64) },
      error: "acceptance_insufficient",
    });
    for (const patch of [{ sequence: 3 }, { settlement: null }, { error: "different_failure" }, { phase: "rollback_pending" }]) {
      assert.throws(() => parseVpsReceipt({ ...failed, ...patch }), /contract is invalid/);
    }
    const journal = new VpsOperationJournal(`${fixture.root}/intent-guard`);
    await mkdir(`${journal.root}/.data`, { recursive: true });
    await journal.write({ ...prepared, intent: { action: "promote", persistedAt: prepared.createdAt } });
    await assert.rejects(() => journal.write(failed), /journal is unavailable/);
    assert.equal((await journal.read(prepared.operationId))?.intent?.action, "promote");
  } finally {
    await fixture.cleanup();
  }
});
