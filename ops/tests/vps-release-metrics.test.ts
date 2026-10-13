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
Deno.test("VPS metrics: actual accepted/terminal producer fields join adjacent windows with exact denominator", async () => {
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
Deno.test("VPS metrics: absent independent coverage and dropped journal evidence never become zero-rate success", async () => {
  const reader: VpsJournalReader = { read: () => Promise.resolve(""), coverage: () => Promise.resolve(null) };
  const sample = await new VpsJournalMetrics(reader, () => start + 65_000, 5000, [], []).sample({ identity, windowStart: start, windowEnd: start + 30_000 });
  assert.equal(sample.coverage, "incomplete");
  assert.equal(sample.requestCount, null);
});
