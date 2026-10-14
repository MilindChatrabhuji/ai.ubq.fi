import assert from "node:assert/strict";
import { VpsJournalMetrics } from "../vps-release-metrics.ts";
import { createVpsJoinFileStorage } from "../vps-metrics-join.ts";
import { boundedRows, metricsFixture } from "./vps-metrics-fixture.ts";
import type { VpsIdentity } from "../vps-release-contract.ts";
const start = 1_800_000_000_000;
const identity: VpsIdentity = {
  runtime: "vps",
  gitSha: "a".repeat(40),
  deploymentId: `vps-${"a".repeat(40)}`,
  sourceArchiveSha256: "b".repeat(64),
  immutableTreeSha256: "c".repeat(64),
};
const row = (accepted: boolean, at: number, id = "long") =>
  JSON.stringify({
    _SYSTEMD_UNIT: "ai-ubq-fi.service",
    _BOOT_ID: "boot",
    __CURSOR: `${id}-${accepted}-${at}`,
    __REALTIME_TIMESTAMP: String(at * 1000),
    MESSAGE: `[ai.ubq.fi] request_${accepted ? "accepted" : "terminal"} ${JSON.stringify({
      request_id: id,
      git_sha: identity.gitSha,
      deno_revision: identity.deploymentId,
      ...(accepted ? {} : { status: 200, stream: true, failure_kind: null, admission_stage: "accepted" }),
    })}`,
  });
const reader = (raw: string) => ({
  read: (from: number, to: number) => Promise.resolve(boundedRows(raw, from, to)),
  coverage: (windowStart: number, windowEnd: number) =>
    Promise.resolve({
      complete: true as const,
      unit: "ai-ubq-fi.service" as const,
      windowStart,
      windowEnd,
      bootId: "boot",
      firstCursor: "first",
      lastCursor: "last",
      digest: "d".repeat(64),
    }),
});
const input = { identity, windowStart: start, windowEnd: start + 30_000 };
Deno.test("VPS joins: interrupted collection reconstructs an encrypted checkpoint and counts the long request once", async () => {
  let now = start + 35_000;
  const source = reader([row(true, start + 29_500), row(false, start + 69_500)].join("\n"));
  const fixture = await metricsFixture(identity, source, () => now);
  assert.equal((await fixture.metrics.sample(input)).coverage, "incomplete");
  assert.equal((await fixture.metrics.progress(input)).state, "collecting");
  const bytes = fixture.stored();
  assert.ok(bytes);
  assert.ok(bytes.length > 0);
  assert.equal(new TextDecoder().decode(bytes).includes("request_accepted"), false);
  now += 70_000;
  const resumed = new VpsJournalMetrics(source, () => now, 5000, [], [], fixture.options);
  resumed.beginTick(now);
  const result = await resumed.sample(input);
  assert.equal(result.coverage, "complete");
  assert.equal(result.requestCount, 1);
  assert.equal((await resumed.sample(input)).requestCount, 1);
});
Deno.test("VPS joins: a progressing stream beyond thirty minutes and bounded old admission recovery preserve exact denominator", async () => {
  let now = start + 35_000;
  const source = reader([row(true, start + 29_500), row(false, start + 1_850_000)].join("\n"));
  const fixture = await metricsFixture(identity, source, () => now);
  assert.equal((await fixture.metrics.sample(input)).coverage, "incomplete");
  now = start + 1_900_000;
  fixture.metrics.beginTick(now);
  assert.equal((await fixture.metrics.sample(input)).requestCount, 1);
  const old = await metricsFixture(identity, reader([row(true, start - 90_000, "old"), row(false, start + 1, "old")].join("\n")), () => start + 65_000);
  assert.equal((await old.metrics.sample(input)).coverage, "complete");
  assert.equal((await old.metrics.sample(input)).requestCount, 0, "old admission never enters this cohort denominator");
});
Deno.test("VPS joins: missing policy, corrupted ciphertext, expiry, byte bound and stale checkpoint CAS never pass", async () => {
  const source = reader([row(true, start + 1), row(false, start + 2)].join("\n"));
  let now = start + 65_000;
  const fixture = await metricsFixture(identity, source, () => now);
  assert.equal((await fixture.metrics.sample(input)).coverage, "complete");
  fixture.corrupt();
  assert.equal((await fixture.metrics.sample(input)).coverage, "incomplete");
  assert.equal((await fixture.metrics.progress(input)).state, "unavailable");
  const expired = await metricsFixture(identity, source, () => now);
  await expired.metrics.sample(input);
  now += expired.options.retention.evidenceMaxAgeMs;
  expired.metrics.beginTick(now);
  assert.equal((await expired.metrics.sample(input)).coverage, "incomplete");
  const small = await metricsFixture(identity, source, () => start + 65_000);
  small.options.retention.evidenceMaxBytes = 8;
  assert.equal((await small.metrics.sample(input)).coverage, "incomplete");
  const stale = await metricsFixture(identity, source, () => start + 65_000);
  stale.options.storage.save = () => Promise.resolve(false);
  assert.equal((await stale.metrics.sample(input)).coverage, "incomplete");
  assert.throws(
    () => new VpsJournalMetrics(source, () => now, 0, [], [], { ...stale.options, retention: { evidenceMaxAgeMs: 0, evidenceMaxBytes: 10 } }),
    /unavailable/
  );
});
Deno.test("VPS joins: filesystem storage enforces exact private modes, operation path, file CAS and stale scope", async () => {
  const root = await Deno.makeTempDir({ prefix: "vps-metrics-store-" });
  try {
    const source = reader([row(true, start + 1), row(false, start + 2)].join("\n"));
    const fixture = await metricsFixture(identity, source, () => start + 65_000);
    const scope = await fixture.options.context(input);
    const disk = createVpsJoinFileStorage(
      root,
      fixture.options.retention,
      fixture.options.cipher,
      () => Promise.resolve(scope),
      () => start + 65_000
    );
    fixture.options.storage = disk;
    assert.equal((await fixture.metrics.sample(input)).coverage, "complete");
    const path = `${root}/.data/sentinel-vps-metrics/${scope.operationId}.sealed`;
    assert.equal(((await Deno.stat(path)).mode ?? 0) & 0o777, 0o600);
    assert.equal(((await Deno.stat(`${root}/.data/sentinel-vps-metrics`)).mode ?? 0) & 0o777, 0o700);
    assert.equal(await disk.save({ ...scope, stateHead: "a".repeat(40) }, 1, fixture.stored() ?? new Uint8Array()), false);
    assert.equal(await disk.save(scope, 0, (await disk.load(scope)) ?? new Uint8Array()), false);
    assert.equal(
      await disk.save(scope, 1, (await disk.load(scope)) ?? new Uint8Array()),
      false,
      "replaying the same encrypted sequence is not a CAS increment"
    );
    await Deno.chmod(path, 0o400);
    await assert.rejects(() => disk.load(scope), /unavailable/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("VPS joins: late accepted terminal with a missing admission cannot disappear from the denominator", async () => {
  const source = reader([row(true, start + 1, "A"), row(false, start + 60_000, "A"), row(false, start + 65_000, "B")].join("\n"));
  const fixture = await metricsFixture(identity, source, () => start + 100_000);
  const result = await fixture.metrics.sample(input);
  assert.equal(result.coverage, "incomplete", "late B needs authentic admission evidence before this cohort can complete");
  assert.equal(result.requestCount, null);
});

Deno.test("VPS joins: scope advancing during the owned deploy-lock wait refuses checkpoint publication", async () => {
  const root = await Deno.makeTempDir({ prefix: "vps-metrics-lock-race-" });
  try {
    const source = reader([row(true, start + 1), row(false, start + 2)].join("\n"));
    const fixture = await metricsFixture(identity, source, () => start + 65_000);
    await fixture.metrics.sample(input);
    const bytes = fixture.stored();
    assert.ok(bytes);
    const scope = await fixture.options.context(input);
    let current = scope,
      entered!: () => void;
    const before = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const disk = createVpsJoinFileStorage(
      root,
      fixture.options.retention,
      fixture.options.cipher,
      () => {
        entered();
        return Promise.resolve(current);
      },
      () => start + 65_000
    );
    await Deno.mkdir(`${root}/.data`, { recursive: true, mode: 0o700 });
    const lock = await Deno.open(`${root}/.data/deploy.lock`, { create: true, write: true, mode: 0o600 });
    await lock.lock(true);
    const writing = disk.save(scope, null, bytes);
    await before;
    current = { ...scope, stateHead: "9".repeat(40), stateSequence: scope.stateSequence + 1 };
    lock.close();
    assert.equal(await writing, false, "the pre-lock scope cannot authorize a write after state advancement");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("VPS joins: elapsed query budget checkpoints completed slices and yields collecting", async () => {
  let now = start + 100_000,
    queries = 0;
  const original = reader([row(true, start + 1), row(false, start + 60_001)].join("\n"));
  const source = {
    ...original,
    read: async (from: number, to: number) => {
      queries++;
      if (queries === 2) now += 20_001;
      return original.read(from, to);
    },
  };
  const fixture = await metricsFixture(identity, source, () => now);
  assert.equal((await fixture.metrics.sample(input)).coverage, "incomplete");
  assert.equal((await fixture.metrics.progress(input)).state, "collecting", "budget is not a missing-journal failure");
  const stored = fixture.stored();
  assert.ok(stored, "the fully covered first slice remains durable");
  const beforeQueries = queries;
  const resumed = new VpsJournalMetrics(source, () => now, 5000, [], [], fixture.options);
  resumed.beginTick(now);
  const result = await resumed.sample(input);
  assert.equal(result.coverage, "complete");
  assert.equal(result.requestCount, 1);
  assert.ok(queries - beforeQueries <= 3, "resume does not restart from the completed first slice");
});
