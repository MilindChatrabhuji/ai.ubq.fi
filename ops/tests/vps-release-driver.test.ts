import { test } from "bun:test";
import { readlink, rm, stat, symlink } from "node:fs/promises";
import assert from "node:assert/strict";
import { parseVpsReceipt, vpsDigest } from "../vps-release-contract.ts";
import { readVpsPins } from "../vps-release-journal.ts";
import { pruneReleases } from "../release-retention.ts";
import { makeVpsDriverFixture, mutation } from "./vps-release-driver-fixture.ts";

test("VPS driver uses real immutable archives, durable intent, exact public identity and restoration", async () => {
  const fixture = await makeVpsDriverFixture();
  try {
    const prepared = await fixture.prepare();
    assert.equal(prepared.phase, "prepared");
    assert.equal(prepared.candidate.gitSha, fixture.candidateSha);
    assert.equal(fixture.system.calls.filter((call) => call.includes("restart")).length, 0);
    const active = await fixture.driver.activate(await mutation(prepared));
    assert.equal(active.phase, "ingress_applied");
    assert.equal(active.public?.bodyMatches, true);
    assert.equal(await readlink(`${fixture.root}/.data/current`), `releases/${fixture.candidateSha}`);
    assert.equal(fixture.system.calls.filter((call) => call.includes("restart")).length, 1);
    const observed = await fixture.driver.observe({ operationId: active.operationId, requestDigest: active.binding.requestDigest });
    assert.deepEqual(parseVpsReceipt(observed), active, "producer bytes are strict consumer input");
    await pruneReleases({ releasesDir: `${fixture.root}/.data/releases`, currentLink: `${fixture.root}/.data/current`, keep: 0 });
    await stat(`${fixture.root}/.data/releases/${fixture.priorSha}`);
    fixture.now += 1000;
    const restored = await fixture.driver.restore(await mutation(active));
    assert.equal(restored.phase, "rolled_back");
    assert.equal(restored.restoration?.public.identity.gitSha, fixture.priorSha);
    assert.equal(await readlink(`${fixture.root}/.data/current`), `releases/${fixture.priorSha}`);
    const settled = await fixture.driver.settle({
      ...(await mutation(restored)),
      stateRevision: "d".repeat(40),
      disposition: "rolled_back",
      digest: await vpsDigest(restored),
    });
    assert.equal(settled.settlement?.disposition, "rolled_back");
    assert.equal((await readVpsPins(`${fixture.root}/.data/vps-release-pins.json`)).length, 0);
    await stat(`${fixture.root}/.data/sentinel-releases/${active.operationId}.json`);
  } finally {
    await fixture.cleanup();
  }
});

test("VPS driver receipt CAS and newer unrelated selector refuse before another effect", async () => {
  const fixture = await makeVpsDriverFixture();
  try {
    const prepared = await fixture.prepare();
    const stale = await mutation(prepared);
    stale.expectedSequence++;
    await assert.rejects(() => fixture.driver.activate(stale), /receipt_conflict/);
    assert.equal(fixture.system.calls.filter((call) => call.includes("restart")).length, 0);
    const active = await fixture.driver.activate(await mutation(prepared));
    await rm(`${fixture.root}/.data/current`);
    await symlink(`releases/${"f".repeat(40)}`, `${fixture.root}/.data/current`);
    await assert.rejects(async () => fixture.driver.restore(await mutation(active)), /unrelated_current/);
    assert.equal(fixture.system.calls.filter((call) => call.includes("restart")).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("VPS driver daemon reload refusal restores only the selector and never restarts", async () => {
  const fixture = await makeVpsDriverFixture();
  try {
    const prepared = await fixture.prepare();
    fixture.system.failDaemonReload = true;
    const restored = await fixture.driver.activate(await mutation(prepared));
    assert.equal(restored.phase, "rolled_back");
    assert.equal(restored.restoration?.loopback.identity.gitSha, fixture.priorSha);
    assert.equal(fixture.system.calls.filter((call) => call.includes("restart")).length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("VPS driver post-ingress public mismatch retains nondestructive exact-operation retry", async () => {
  const fixture = await makeVpsDriverFixture();
  try {
    const prepared = await fixture.prepare();
    fixture.system.publicFailureRevision = fixture.candidateSha;
    fixture.system.failPublic = true;
    const pending = await fixture.driver.activate(await mutation(prepared));
    assert.equal(pending.phase, "ingress_applied");
    assert.equal(pending.error, "public_identity_pending");
    assert.equal(await readlink(`${fixture.root}/.data/current`), `releases/${fixture.candidateSha}`);
    fixture.system.failPublic = false;
    const retried = await fixture.driver.activate(await mutation(pending));
    assert.equal(retried.public?.bodyMatches, true);
    assert.equal(fixture.system.calls.filter((call) => call.includes("restart")).length, 1);
    fixture.system.settlementAllowed = false;
    await assert.rejects(
      async () =>
        fixture.driver.settle({ ...(await mutation(retried)), stateRevision: "d".repeat(40), disposition: "accepted", digest: await vpsDigest(retried) }),
      /settlement_unavailable/
    );
    assert.equal((await readVpsPins(`${fixture.root}/.data/vps-release-pins.json`)).length, 1);
  } finally {
    await fixture.cleanup();
  }
});
