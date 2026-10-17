import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { acquireDeployLock } from "../deploy-lock.ts";
import { VpsJournalMetrics } from "../vps-release-metrics.ts";
import { createVpsJoinFileStorage } from "../vps-metrics-storage.ts";
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
const row = (accepted: boolean, at: number, id = "long", latency = 0) =>
  JSON.stringify({
    _SYSTEMD_UNIT: "ai-ubq-fi.service",
    _BOOT_ID: "boot",
    __CURSOR: `${id}-${accepted}-${at}`,
    __REALTIME_TIMESTAMP: String(at * 1000),
    MESSAGE: `[ai.ubq.fi] request_${accepted ? "accepted" : "terminal"} ${JSON.stringify({
      request_id: id,
      git_sha: identity.gitSha,
      deno_revision: identity.deploymentId,
      ...(accepted ? {} : { status: 200, stream: true, failure_kind: null, admission_stage: "accepted", latency_ms: latency }),
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
const temporaryRoot = async (prefix: string): Promise<string> => {
  const parent = new URL("../../.cleanup-evidence/vps-metrics-fixtures/", import.meta.url).pathname;
  await mkdir(parent, { recursive: true });
  return realpath(await mkdtemp(parent + prefix));
};
test("VPS joins: interrupted collection reconstructs an encrypted checkpoint and counts the long request once", async () => {
  let now = start + 35_000;
  const source = reader([row(true, start + 29_500), row(false, start + 69_500, "long", 40_000)].join("\n"));
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
test("VPS joins: a progressing stream beyond thirty minutes and bounded old admission recovery preserve exact denominator", async () => {
  let now = start + 35_000;
  const source = reader([row(true, start + 29_500), row(false, start + 1_850_000, "long", 1_820_500)].join("\n"));
  const fixture = await metricsFixture(identity, source, () => now);
  assert.equal((await fixture.metrics.sample(input)).coverage, "incomplete");
  now = start + 1_900_000;
  // A cohort spends at most its share of each tick, so a thirty-minute tail takes a few ticks rather than one.
  let result: Awaited<ReturnType<typeof fixture.metrics.sample>>,
    ticks = 0;
  do {
    fixture.metrics.beginTick(now);
    result = await fixture.metrics.sample(input);
    ticks++;
    now += 20_000;
  } while (result.coverage !== "complete" && ticks < 8);
  assert.equal(result.requestCount, 1);
  assert.ok(ticks <= 4, `a lone cohort catches up its tail within its tick shares; took ${ticks} ticks`);
  const old = await metricsFixture(identity, reader([row(true, start - 90_000, "old"), row(false, start + 1, "old", 90_001)].join("\n")), () => start + 65_000);
  assert.equal((await old.metrics.sample(input)).coverage, "complete");
  assert.equal((await old.metrics.sample(input)).requestCount, 0, "old admission never enters this cohort denominator");
});
test("VPS joins: missing policy, corrupted ciphertext, expiry, byte bound and stale checkpoint CAS never pass", async () => {
  const source = reader([row(true, start + 1), row(false, start + 2, "long", 1)].join("\n"));
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
test("VPS joins: filesystem storage enforces exact private modes, operation path, file CAS and stale scope", async () => {
  const root = await temporaryRoot("store-");
  try {
    const source = reader([row(true, start + 1), row(false, start + 2, "long", 1)].join("\n"));
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
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(`${root}/.data/sentinel-vps-metrics`)).mode & 0o777, 0o700);
    assert.equal(await disk.save({ ...scope, stateHead: "a".repeat(40) }, 1, fixture.stored() ?? new Uint8Array()), false);
    assert.equal(await disk.save(scope, 0, (await disk.load(scope)) ?? new Uint8Array()), false);
    assert.equal(
      await disk.save(scope, 1, (await disk.load(scope)) ?? new Uint8Array()),
      false,
      "replaying the same encrypted sequence is not a CAS increment"
    );
    await chmod(path, 0o400);
    await assert.rejects(() => disk.load(scope), /unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VPS joins: late accepted terminal with a missing admission cannot disappear from the denominator", async () => {
  const source = reader([row(true, start + 1, "A"), row(false, start + 60_000, "A", 59_999), row(false, start + 65_000, "B", 5_000)].join("\n"));
  const fixture = await metricsFixture(identity, source, () => start + 100_000);
  const result = await fixture.metrics.sample(input);
  assert.equal(result.coverage, "incomplete", "late B needs authentic admission evidence before this cohort can complete");
  assert.equal(result.requestCount, null);
});

test("VPS joins: scope advancing during the owned deploy-lock wait refuses checkpoint publication", async () => {
  const root = await temporaryRoot("lock-race-");
  try {
    const source = reader([row(true, start + 1), row(false, start + 2, "long", 1)].join("\n"));
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
    await mkdir(`${root}/.data`, { recursive: true, mode: 0o700 });
    const release = await acquireDeployLock(`${root}/.data/deploy.lock`);
    const writing = disk.save(scope, null, bytes);
    await before;
    current = { ...scope, stateHead: "9".repeat(40), stateSequence: scope.stateSequence + 1 };
    release();
    assert.equal(await writing, false, "the pre-lock scope cannot authorize a write after state advancement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VPS joins: elapsed query budget checkpoints completed slices and yields collecting", async () => {
  let now = start + 100_000,
    queries = 0;
  const original = reader([row(true, start + 1), row(false, start + 60_001, "long", 60_000)].join("\n"));
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

test("VPS joins: steady overlapping traffic with history beyond retention completes from its own neighbouring slices", async () => {
  const history = 5 * 60 * 60_000,
    every = 7_000,
    duration = 13_000;
  const rows: { at: number; line: string }[] = [];
  let members = 0;
  for (let at = start - history, index = 0; at < start + 10 * 60_000; at += every, index++) {
    rows.push({ at, line: row(true, at, `steady-${index}`) }, { at: at + duration, line: row(false, at + duration, `steady-${index}`, duration) });
    if (at >= input.windowStart && at < input.windowEnd) members++;
  }
  rows.sort((left, right) => left.at - right.at);
  const original = reader(rows.map((item) => item.line).join("\n"));
  let reads = 0;
  const source = {
    ...original,
    read: (from: number, to: number) => {
      reads++;
      return original.read(from, to);
    },
  };
  const fixture = await metricsFixture(identity, source, () => start + 65_000);
  assert.ok(history > fixture.options.retention.evidenceMaxAgeMs, "older traffic reaches past the retention floor");
  const result = await fixture.metrics.sample(input);
  assert.equal(result.coverage, "complete", "terminals before the window belong to earlier requests and cannot hold this cohort open");
  assert.equal(result.requestCount, members);
  assert.equal((await fixture.metrics.progress(input)).state, "complete");
  assert.ok(reads <= 3, `the window, one backward slice for in-flight admissions and one terminal slice suffice; read ${reads}`);
});

test("VPS joins: sixty consecutive candidate windows of steady traffic complete within the evidence byte policy", async () => {
  const lines: string[] = [];
  for (let at = start - 30 * 60_000, index = 0; at < start + 32 * 60_000; at += 2_000, index++)
    lines.push(row(true, at, `window-${index}`), row(false, at + 13_000, `window-${index}`, 13_000));
  lines.sort((left, right) => Number(JSON.parse(left).__REALTIME_TIMESTAMP) - Number(JSON.parse(right).__REALTIME_TIMESTAMP));
  let now = start;
  const fixture = await metricsFixture(identity, reader(lines.join("\n")), () => now);
  for (let window = 0; window < 60; window++) {
    now = start + (window + 2) * 30_000 + 5_000;
    fixture.metrics.beginTick(now);
    const result = await fixture.metrics.sample({ identity, windowStart: start + window * 30_000, windowEnd: start + (window + 1) * 30_000 });
    assert.equal(result.coverage, "complete", `window ${window} must not be refused by accumulated backward history`);
    assert.equal(result.requestCount, 15);
  }
  assert.ok((fixture.stored()?.byteLength ?? Infinity) <= fixture.options.retention.evidenceMaxBytes);
});

type JournalRow = { at: number; line: string };
const PRODUCTION_BOOT_ID = "0123456789abcdef0123456789abcdef";
const requestId = (index: number) =>
  `${index.toString(16).padStart(8, "0")}-7e1f-4c2a-9b3d-${((index * 2_654_435_761) % 2 ** 32).toString(16).padStart(12, "0")}`;
/** A journal row at production sizes: UUID request id, a ~130-character cursor and a 32-hex boot id. */
const productionRow = (accepted: boolean, at: number, id: string, extra: Record<string, unknown> = {}): JournalRow => ({
  at,
  line: JSON.stringify({
    _SYSTEMD_UNIT: "ai-ubq-fi.service",
    _BOOT_ID: PRODUCTION_BOOT_ID,
    __CURSOR: `s=4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f;i=${at.toString(16)};b=${PRODUCTION_BOOT_ID};m=${(at * 1000).toString(16)};t=${(at * 1000).toString(16)};x=${id.slice(0, 16)}`,
    __REALTIME_TIMESTAMP: String(at * 1000),
    MESSAGE: `[ai.ubq.fi] request_${accepted ? "accepted" : "terminal"} ${JSON.stringify({ request_id: id, git_sha: identity.gitSha, deno_revision: identity.deploymentId, ...extra })}`,
  }),
});
const productionRequest = (index: number, acceptedAt: number, lifetime: number, extra: Record<string, unknown> = {}): JournalRow[] => [
  productionRow(true, acceptedAt, requestId(index)),
  productionRow(false, acceptedAt + lifetime, requestId(index), {
    status: 200,
    stream: lifetime > 60_000,
    failure_kind: null,
    admission_stage: "accepted",
    latency_ms: lifetime,
    ...extra,
  }),
];
/** Sorted rows behind a binary search, so long simulations stay fast; it counts journal reads. */
const journal = (rows: JournalRow[], bootId = PRODUCTION_BOOT_ID) => {
  const sorted = [...rows].sort((left, right) => left.at - right.at);
  const lower = (at: number) => {
    let low = 0,
      high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sorted[middle].at < at) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const counter = { reads: 0 };
  return {
    counter,
    read: (from: number, to: number) => {
      counter.reads++;
      return Promise.resolve(
        sorted
          .slice(lower(from), lower(to))
          .map((item) => item.line)
          .join("\n")
      );
    },
    coverage: (windowStart: number, windowEnd: number) =>
      Promise.resolve({
        complete: true as const,
        unit: "ai-ubq-fi.service" as const,
        windowStart,
        windowEnd,
        bootId,
        firstCursor: "first",
        lastCursor: "last",
        digest: "d".repeat(64),
      }),
  };
};
const windowInput = (window: number) => ({ identity, windowStart: start + window * 30_000, windowEnd: start + (window + 1) * 30_000 });
/** Short requests every two seconds; each three-second request terminates in the window after it starts or the next. */
const steadyTraffic = (from: number, to: number): JournalRow[] => {
  const rows: JournalRow[] = [];
  for (let at = from, index = 0; at < to; at += 2_000, index++) rows.push(...productionRequest(index, at, 3_000));
  return rows;
};

test("VPS joins: sixty windows of production-sized traffic with five-minute streams stay inside a 4 MiB evidence policy", async () => {
  const rows: JournalRow[] = [];
  // Two requests a second; one in ten is a stream that runs five minutes, so every window has a multi-minute tail.
  for (let at = start - 10 * 60_000, index = 0; at < start + 31 * 60_000; at += 500, index++)
    rows.push(...productionRequest(index, at, index % 10 === 0 ? 5 * 60_000 : 3_000));
  const source = journal(rows);
  let now = start;
  const fixture = await metricsFixture(identity, source, () => now);
  fixture.options.retention.evidenceMaxBytes = 4 * 1024 * 1024;
  const counts = new Map<number, number | null>();
  let largest = 0;
  for (let tick = 0; counts.size < 60 && tick < 60; tick++) {
    now = start + (tick + 1) * 60_000;
    fixture.metrics.beginTick(now);
    for (let window = 0; window < 60; window++) {
      const request = windowInput(window);
      if (counts.has(window) || request.windowEnd > now) continue;
      const result = await fixture.metrics.sample(request);
      const progress = await fixture.metrics.progress(request);
      assert.notEqual(progress.state, "unavailable", `window ${window} was refused at tick ${tick}: ${progress.reason}`);
      largest = Math.max(largest, fixture.stored()?.byteLength ?? 0);
      if (result.coverage === "complete") counts.set(window, result.requestCount);
    }
  }
  assert.equal(counts.size, 60, "every window completes once its streams have terminated");
  for (const [window, requests] of counts) assert.equal(requests, 60, `window ${window} counts its own sixty admissions`);
  assert.ok(largest <= 4 * 1024 * 1024, `the sealed checkpoint peaked at ${largest} bytes`);
  assert.ok(source.counter.reads < 200, `each journal slice is read about once per operation; read ${source.counter.reads}`);
}, 120_000);

test("VPS joins: a legacy null-stage 401 terminal is refused within its own lifetime and leaves the tick to later windows", async () => {
  const legacy = productionRow(false, start + 10_000, "legacy-401", {
    status: 401,
    stream: false,
    failure_kind: null,
    admission_stage: null,
    latency_ms: 4,
  });
  const source = journal([...steadyTraffic(start - 30 * 60_000, start + 3 * 60_000), legacy]);
  const fixture = await metricsFixture(identity, source, () => start + 4 * 30_000 + 5_000);
  const first = await fixture.metrics.sample(windowInput(0));
  assert.equal(first.coverage, "incomplete");
  assert.deepEqual(await fixture.metrics.progress(windowInput(0)), { state: "unavailable", reason: "coverage_missing" });
  for (const window of [1, 2]) {
    const result = await fixture.metrics.sample(windowInput(window));
    assert.equal(result.coverage, "complete", `window ${window} is not starved by the orphan in window 0`);
    assert.equal(result.requestCount, 15);
  }
  assert.ok(source.counter.reads <= 8, `the orphan search stops at its four-millisecond lifetime; read ${source.counter.reads}`);
});

test("VPS joins: an accepted-stage orphan whose admission was lost is refused once its reported lifetime has been searched", async () => {
  const lost = productionRow(false, start + 20_000, "lost-admission", {
    status: 200,
    stream: false,
    failure_kind: null,
    admission_stage: "accepted",
    latency_ms: 50_000,
  });
  const source = journal([...steadyTraffic(start - 30 * 60_000, start + 2 * 60_000), lost]);
  const fixture = await metricsFixture(identity, source, () => start + 65_000);
  assert.equal((await fixture.metrics.sample(input)).coverage, "incomplete");
  assert.deepEqual(await fixture.metrics.progress(input), { state: "unavailable", reason: "coverage_missing" }, "not collecting toward the retention floor");
  assert.ok(source.counter.reads <= 5, `the search covers the fifty-second lifetime and one slice of skew; read ${source.counter.reads}`);
});

test("VPS joins: a long admission chase spends only its share of a tick and still completes", async () => {
  const lifetime = 40 * 60_000 + 10_000;
  const source = journal([...steadyTraffic(start - 45 * 60_000, start + 3 * 60_000), ...productionRequest(999_999, start - 40 * 60_000, lifetime)]);
  let now = start + 4 * 30_000 + 5_000;
  const fixture = await metricsFixture(identity, source, () => now);
  assert.equal((await fixture.metrics.sample(windowInput(0))).coverage, "incomplete", "eighty backward slices do not fit one tick share");
  assert.equal((await fixture.metrics.progress(windowInput(0))).state, "collecting");
  for (const window of [1, 2]) assert.equal((await fixture.metrics.sample(windowInput(window))).coverage, "complete", `window ${window} keeps its share`);
  let ticks = 1,
    result = await fixture.metrics.sample(windowInput(0));
  while (result.coverage !== "complete" && ticks < 10) {
    now += 20_000;
    fixture.metrics.beginTick(now);
    result = await fixture.metrics.sample(windowInput(0));
    ticks++;
  }
  assert.equal(result.coverage, "complete", "the forty-minute admission is found inside its reported lifetime");
  assert.equal(result.requestCount, 15, "the long request belongs to the window that admitted it");
  assert.ok(ticks <= 7, `took ${ticks} ticks`);
});

test("VPS joins: a restarted monitoring period refreshes checkpoint expiry instead of refusing the operation forever", async () => {
  const restartedAt = start + 4 * 60 * 60_000 + 60_000;
  const source = journal([...steadyTraffic(start - 60_000, start + 2 * 60_000), ...steadyTraffic(restartedAt - 60_000, restartedAt + 2 * 60_000)]);
  let now = start + 65_000;
  const fixture = await metricsFixture(identity, source, () => now);
  assert.equal((await fixture.metrics.sample(input)).coverage, "complete");
  const original = fixture.options.context.bind(fixture.options);
  fixture.options.deadline = restartedAt + 30 * 60_000;
  // The stored checkpoint resolves to its own historical state; the current state is the restarted monitoring period.
  fixture.options.context = async (request, saved) => {
    const scope = await original(request, saved);
    return saved ? scope : { ...scope, monitoringStartedAt: restartedAt, stateSequence: 2 };
  };
  now = restartedAt + 65_000;
  fixture.metrics.beginTick(now);
  const restarted = { identity, windowStart: restartedAt, windowEnd: restartedAt + 30_000 };
  const result = await fixture.metrics.sample(restarted);
  assert.equal(result.coverage, "complete", "the old checkpoint's age no longer refuses the new monitoring period");
  assert.equal(result.requestCount, 15);
});

test("VPS joins: after the operation deadline a pending window reports a terminal deadline reason", async () => {
  const source = reader(row(true, start + 1));
  let now = start + 65_000;
  const fixture = await metricsFixture(identity, source, () => now);
  fixture.options.deadline = start + 10 * 60_000;
  assert.equal((await fixture.metrics.sample(input)).coverage, "incomplete");
  assert.deepEqual(await fixture.metrics.progress(input), { state: "collecting", reason: "terminal_or_slice_pending" });
  now = fixture.options.deadline + 1;
  fixture.metrics.beginTick(now);
  assert.equal((await fixture.metrics.sample(input)).coverage, "incomplete");
  assert.deepEqual(await fixture.metrics.progress(input), { state: "unavailable", reason: "deadline_exceeded" });
});

test("VPS joins: the release-state read made under the deploy lock is bounded and the lock is released", async () => {
  const root = await temporaryRoot("bounded-read-");
  try {
    const fixture = await metricsFixture(identity, reader([row(true, start + 1), row(false, start + 2, "long", 1)].join("\n")), () => start + 65_000);
    await fixture.metrics.sample(input);
    const bytes = fixture.stored();
    assert.ok(bytes);
    const scope = await fixture.options.context(input);
    let reads = 0;
    const disk = createVpsJoinFileStorage(
      root,
      fixture.options.retention,
      fixture.options.cipher,
      () => (++reads === 1 ? Promise.resolve(scope) : new Promise<never>(() => {})),
      () => start + 65_000,
      50
    );
    const settled = <T>(work: Promise<T>) =>
      Promise.race([
        work,
        new Promise<"held">((resolve) => {
          setTimeout(() => {
            resolve("held");
          }, 2_000);
        }),
      ]);
    assert.equal(await settled(disk.save(scope, null, bytes)), false, "a stalled state store refuses the write instead of holding the lock");
    const release = await settled(acquireDeployLock(`${root}/.data/deploy.lock`));
    assert.notEqual(release, "held", "deploys can take the lock straight away");
    if (release !== "held") release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VPS joins: a checkpoint save prunes crashed temporaries and expired operations and keeps live files", async () => {
  const root = await temporaryRoot("prune-");
  try {
    const fixture = await metricsFixture(identity, reader([row(true, start + 1), row(false, start + 2, "long", 1)].join("\n")), () => start + 65_000);
    const scope = await fixture.options.context(input);
    fixture.options.storage = createVpsJoinFileStorage(
      root,
      fixture.options.retention,
      fixture.options.cipher,
      () => Promise.resolve(scope),
      () => start + 65_000
    );
    const directory = `${root}/.data/sentinel-vps-metrics`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const expired = `${directory}/${"6".repeat(64)}.sealed`,
      live = `${directory}/${"7".repeat(64)}.sealed`,
      crashed = `${directory}/${scope.operationId}.sealed-${crypto.randomUUID()}`,
      unrelated = `${directory}/notes.txt`;
    for (const path of [expired, live, crashed, unrelated]) await writeFile(path, "x", { mode: 0o600 });
    const old = (Date.now() - fixture.options.retention.evidenceMaxAgeMs - 60_000) / 1000;
    await utimes(expired, old, old);
    assert.equal((await fixture.metrics.sample(input)).coverage, "complete");
    const present = async (path: string) => (await stat(path).catch(() => null)) !== null;
    assert.equal(await present(`${directory}/${scope.operationId}.sealed`), true);
    assert.equal(await present(live), true, "another operation's current checkpoint is kept");
    assert.equal(await present(unrelated), true, "only checkpoint names are pruned");
    assert.equal(await present(expired), false, "a checkpoint untouched for the whole evidence age is pruned");
    assert.equal(await present(crashed), false, "a temporary left by a crashed writer is pruned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
