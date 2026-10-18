import { test } from "bun:test";
import { runSequence } from "../../tests/helpers/sequence.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { type VpsJournalReader } from "../vps-release-metrics.ts";
import type { VpsIdentity } from "../vps-release-contract.ts";
import { metricsFixture, boundedRows } from "./vps-metrics-fixture.ts";

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
test("VPS metrics: supported healthy long completion matures its original admission cohort", async () => {
  const rows = [
    entry("accepted", start + 29_500),
    entry("terminal", start + 69_500, { status: 200, stream: false, failure_kind: null, admission_stage: "accepted" }),
  ];
  const reader: VpsJournalReader = {
    read: (from, to) =>
      Promise.resolve(
        rows
          .filter((row) => {
            const at = Number(JSON.parse(row).__REALTIME_TIMESTAMP) / 1000;
            return at >= from && at < to;
          })
          .join("\n")
      ),
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
  };
  const { metrics } = await metricsFixture(identity, reader, () => start + 100_000);
  const sample = await metrics.sample({ identity, windowStart: start, windowEnd: start + 30_000 });
  assert.equal(sample.coverage, "complete", "a healthy supported 40-second request must not remain unavailable forever");
  assert.equal(sample.requestCount, 1);
});
test("VPS metrics: actual accepted/terminal producer fields join adjacent windows with exact denominator", async () => {
  const raw = [entry("accepted", start + 29_999), entry("terminal", start + 30_001, { status: 502, stream: true, failure_kind: "gateway_timeout" })].join("\n");
  const reader: VpsJournalReader = {
    read: (from, to) => Promise.resolve(boundedRows(raw, from, to)),
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
  const { metrics } = await metricsFixture(identity, reader, () => start + 65_000, start, ["gateway_timeout"]);
  const sample = await metrics.sample({ identity, windowStart: start, windowEnd: start + 30_000 });
  assert.equal(sample.coverage, "complete");
  assert.equal(sample.requestCount, 1);
  assert.equal(sample.fiveXxCount, 1);
  assert.equal(sample.timeoutCount, 1);
  assert.equal(sample.streamFailureCount, 1);
});
test("VPS metrics: absent independent coverage and dropped journal evidence never become zero-rate success", async () => {
  const reader: VpsJournalReader = { read: () => Promise.resolve(""), coverage: () => Promise.resolve(null) };
  const { metrics } = await metricsFixture(identity, reader, () => start + 65_000);
  const sample = await metrics.sample({ identity, windowStart: start, windowEnd: start + 30_000 });
  assert.equal(sample.coverage, "incomplete");
  assert.equal(sample.requestCount, null);
});

const sampleRaw = async (raw: string) => {
  const { metrics } = await metricsFixture(
    identity,
    {
      read: (from, to) => Promise.resolve(boundedRows(raw, from, to)),
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
    () => start + 65_000
  );
  return metrics.sample({ identity, windowStart: start, windowEnd: start + 30_000 });
};
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

test("VPS metrics: the bridge-loaded journal metrics graph never imports a Bun-only specifier", async () => {
  const seen = new Set<string>();
  const visit = async (url: URL): Promise<void> => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = await readFile(url, "utf8");
    for (const [, specifier] of source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)) {
      assert.equal(specifier.startsWith("bun:"), false, `${url.pathname} imports ${specifier}`);
      if (specifier.startsWith(".")) await visit(new URL(specifier, url));
    }
  };
  await visit(new URL("../vps-release-metrics.ts", import.meta.url));
  assert.ok([...seen].some((href) => href.endsWith("/ops/vps-metrics-join.ts")));
  assert.ok([...seen].some((href) => href.endsWith("/ops/vps-journal-reader.ts")));
});

test("VPS metrics: PID 1 rows about the unit, such as an activation restart, never hold a window open", async () => {
  await runSequence(async (step) => {
    const accepted = entry("accepted", start + 1);
    const terminal = entry("terminal", start + 2, { status: 200, stream: false, failure_kind: null, admission_stage: "accepted", latency_ms: 1 });
    const fromPid1 = (at: number, message: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        _SYSTEMD_UNIT: "init.scope",
        _PID: "1",
        UNIT: "ai-ubq-fi.service",
        _BOOT_ID: "fixture-boot",
        __CURSOR: `systemd-${at}`,
        __REALTIME_TIMESTAMP: String(at * 1000),
        MESSAGE: message,
        ...extra,
      });
    await step("restart rows", async () => {
      const restart = [
        fromPid1(start + 3, "Stopping ai-ubq-fi.service - ai.ubq.fi gateway..."),
        fromPid1(start + 4, "ai-ubq-fi.service: Deactivated successfully."),
        fromPid1(start + 5, "Started ai-ubq-fi.service - ai.ubq.fi gateway."),
        fromPid1(start + 6, null),
      ];
      const sample = await sampleRaw([accepted, terminal, ...restart].join("\n"));
      assert.equal(sample.coverage, "complete");
      assert.equal(sample.requestCount, 1);
    });
    await step("a PID 1 row on another boot still refuses", async () => {
      const sample = await sampleRaw([accepted, terminal, fromPid1(start + 3, "Started ai-ubq-fi.service.", { _BOOT_ID: "other-boot" })].join("\n"));
      assert.equal(sample.coverage, "incomplete");
    });
    await step("another process's row about the unit still refuses", async () => {
      const journald = JSON.stringify({
        _SYSTEMD_UNIT: "systemd-journald.service",
        _PID: "312",
        OBJECT_SYSTEMD_UNIT: "ai-ubq-fi.service",
        _BOOT_ID: "fixture-boot",
        __CURSOR: "journald",
        __REALTIME_TIMESTAMP: String((start + 3) * 1000),
        MESSAGE: "Suppressed 42 messages from ai-ubq-fi.service",
      });
      const sample = await sampleRaw([accepted, terminal, journald].join("\n"));
      assert.equal(sample.coverage, "incomplete");
      assert.equal(sample.requestCount, null);
    });
  });
});

test("VPS metrics: request rows journalctl encodes as bytes are decoded and a missing message still refuses", async () => {
  const accepted = entry("accepted", start + 1);
  const terminal = JSON.parse(
    entry("terminal", start + 2, { status: 200, stream: false, failure_kind: null, admission_stage: "accepted", latency_ms: 1, model: "gpt\u0085x" })
  ) as Record<string, unknown>;
  const encoded = JSON.stringify({ ...terminal, MESSAGE: [...new TextEncoder().encode(String(terminal.MESSAGE))] });
  const decoded = await sampleRaw([accepted, encoded].join("\n"));
  assert.equal(decoded.coverage, "complete", "a C1 control character makes journalctl emit the message as a byte array");
  assert.equal(decoded.requestCount, 1);
  const binary = JSON.stringify({ ...terminal, __CURSOR: "binary", MESSAGE: [0xff, 0xfe, 0x00] });
  const skipped = await sampleRaw([accepted, JSON.stringify(terminal), binary].join("\n"));
  assert.equal(skipped.coverage, "complete", "invalid UTF-8 cannot be a request row");
  assert.equal(skipped.requestCount, 1);
  const missing = await sampleRaw([accepted, JSON.stringify({ ...terminal, MESSAGE: null })].join("\n"));
  assert.equal(missing.coverage, "incomplete", "a null message could hide a request row");
});
