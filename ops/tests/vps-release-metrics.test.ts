import { test } from "bun:test";
import { runSequence } from "../../tests/helpers/sequence.ts";
import assert from "node:assert/strict";
import { VpsJournalMetrics, type VpsJournalReader } from "../vps-release-metrics.ts";
import type { VpsIdentity } from "../vps-release-contract.ts";

const identity: VpsIdentity = {
  runtime: "vps",
  gitSha: "a".repeat(40),
  deploymentId: `vps-${"a".repeat(40)}`,
  sourceArchiveSha256: "b".repeat(64),
  immutableTreeSha256: "c".repeat(64),
};
const start = 1_800_000_000_000;
const entry = (name: string, at: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    _SYSTEMD_UNIT: "ai-ubq-fi.service",
    _BOOT_ID: "fixture-boot",
    __CURSOR: `cursor-${at}`,
    __REALTIME_TIMESTAMP: String(at * 1000),
    MESSAGE: `[ai.ubq.fi] request_${name} ${JSON.stringify({ request_id: "request-fixture", git_sha: identity.gitSha, deno_revision: identity.deploymentId, ...extra })}`,
  });
test("VPS metrics: actual accepted/terminal producer fields join adjacent windows with exact denominator", async () => {
  const raw = [entry("accepted", start + 29_999), entry("terminal", start + 30_001, { status: 502, stream: true, failure_kind: "gateway_timeout" })].join("\n");
  const reader: VpsJournalReader = {
    read: () => Promise.resolve(raw),
    coverage: (from, to) =>
      Promise.resolve({
        complete: true,
        unit: "ai-ubq-fi.service",
        windowStart: from,
        windowEnd: to,
        bootId: "fixture-boot",
        firstCursor: "first",
        lastCursor: "last",
        digest: "d".repeat(64),
      }),
  };
  const metrics = new VpsJournalMetrics(reader, () => start + 65_000, 5000, ["gateway_timeout"], []);
  const sample = await metrics.sample({ identity, windowStart: start, windowEnd: start + 30_000 });
  assert.equal(sample.coverage, "complete");
  assert.equal(sample.requestCount, 1);
  assert.equal(sample.fiveXxCount, 1);
  assert.equal(sample.timeoutCount, 1);
  assert.equal(sample.streamFailureCount, 1);
});
test("VPS metrics: absent independent coverage and dropped journal evidence never become zero-rate success", async () => {
  const reader: VpsJournalReader = { read: () => Promise.resolve(""), coverage: () => Promise.resolve(null) };
  const sample = await new VpsJournalMetrics(reader, () => start + 65_000, 5000, [], []).sample({ identity, windowStart: start, windowEnd: start + 30_000 });
  assert.equal(sample.coverage, "incomplete");
  assert.equal(sample.requestCount, null);
});

const sampleRaw = (raw: string) =>
  new VpsJournalMetrics(
    {
      read: () => Promise.resolve(raw),
      coverage: (windowStart, windowEnd) =>
        Promise.resolve({
          complete: true,
          unit: "ai-ubq-fi.service",
          windowStart,
          windowEnd,
          bootId: "fixture-boot",
          firstCursor: "first",
          lastCursor: "last",
          digest: "d".repeat(64),
        }),
    },
    () => start + 65_000,
    5000,
    [],
    []
  ).sample({ identity, windowStart: start, windowEnd: start + 30_000 });
const terminalEntry = (admissionStage?: unknown) =>
  entry("terminal", start + 2, {
    status: 200,
    stream: false,
    failure_kind: null,
    admission_stage: admissionStage,
    rate_limit_wait_ms: null,
    rate_limit_failover_model: null,
  });

test("VPS metrics: admission evidence excludes only positive pre-admission orphans", async () => {
  await runSequence(async (step) => {
    const accepted = entry("accepted", start + 1);
    const cases = [
      { name: "pre-admission orphan", rows: [terminalEntry("pre_admission")], coverage: "complete", requests: 0 },
      { name: "accepted pair", rows: [accepted, terminalEntry("accepted")], coverage: "complete", requests: 1 },
      { name: "legacy pair", rows: [accepted, terminalEntry()], coverage: "complete", requests: 1 },
      { name: "null legacy pair", rows: [accepted, terminalEntry(null)], coverage: "complete", requests: 1 },
      { name: "unmarked orphan", rows: [terminalEntry()], coverage: "incomplete", requests: null },
      { name: "null legacy orphan", rows: [terminalEntry(null)], coverage: "incomplete", requests: null },
      { name: "accepted orphan", rows: [terminalEntry("accepted")], coverage: "incomplete", requests: null },
      { name: "missing terminal", rows: [accepted], coverage: "incomplete", requests: null },
      { name: "contradiction", rows: [accepted, terminalEntry("pre_admission")], coverage: "incomplete", requests: null },
      { name: "reverse contradiction", rows: [terminalEntry("pre_admission"), accepted], coverage: "incomplete", requests: null },
      { name: "conflicting duplicates", rows: [terminalEntry("accepted"), terminalEntry("pre_admission")], coverage: "incomplete", requests: null },
      { name: "reverse conflicting duplicates", rows: [terminalEntry("pre_admission"), terminalEntry("accepted")], coverage: "incomplete", requests: null },
      { name: "unknown cannot become excluded", rows: [terminalEntry(), terminalEntry("pre_admission")], coverage: "incomplete", requests: null },
    ];
    for (const scenario of cases) {
      await step(scenario.name, async () => {
        const sample = await sampleRaw(scenario.rows.join("\n"));
        assert.equal(sample.coverage, scenario.coverage);
        assert.equal(sample.requestCount, scenario.requests);
      });
    }
    for (const invalid of [false, "", 0, {}, "rejected"]) {
      await step(`invalid stage ${JSON.stringify(invalid)}`, async () => {
        const sample = await sampleRaw([accepted, terminalEntry(invalid)].join("\n"));
        assert.equal(sample.coverage, "incomplete");
        assert.equal(sample.requestCount, null);
      });
    }
  });
});

test("VPS metrics: actual journal suppression notice refuses coverage while application fields remain valid", async () => {
  const row = JSON.parse(entry("accepted", start + 3)) as Record<string, unknown>;
  for (const message of ["Suppressed 42 messages from ai-ubq-fi.service", "Missed 42 kernel messages"]) {
    const lost = await sampleRaw(JSON.stringify({ ...row, MESSAGE: message }));
    assert.equal(lost.coverage, "incomplete");
    assert.equal(lost.requestCount, null);
  }
  const ordinary = await sampleRaw(JSON.stringify({ ...row, MESSAGE: '[ai.ubq.fi] diagnostic {"suppressed":false,"dropped":0,"rate_limit_wait_ms":0}' }));
  assert.equal(ordinary.coverage, "complete");
  assert.equal(ordinary.requestCount, 0);
});
