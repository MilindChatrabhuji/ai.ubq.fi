import { test } from "bun:test";
import type { Kv } from "#kv";
import assert from "node:assert/strict";

import { withTerminalRequestLog } from "../src/handler/terminal-log.ts";
import { setKvForTest } from "../src/kv.ts";
import { attachResponseTelemetry, createResponseTelemetryState } from "../src/openai-telemetry.ts";
import { listPaidFallbackUsageRollups } from "../src/paid-fallback/rollups.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

type TerminalLogInput = Parameters<typeof withTerminalRequestLog>[1];
type RecordUsageRollup = NonNullable<TerminalLogInput["recordUsageRollup"]>;
type UsageRollupInput = Parameters<RecordUsageRollup>[0];
type RecordTelemetry = NonNullable<TerminalLogInput["recordTelemetry"]>;
type RecordAnalytics = NonNullable<TerminalLogInput["recordCacheAnalytics"]>;

const HOUR_MS = 60 * 60 * 1_000;

const ignoredTelemetry: RecordTelemetry = () =>
  Promise.resolve({
    status: "ignored" as const,
    reason: "unknown_release" as const,
    release: null,
    provider: null,
    route: null,
    model_hash: null,
  });

const ignoredAnalytics: RecordAnalytics = () =>
  Promise.resolve({
    status: "ignored" as const,
    reason: "unknown_release" as const,
    bucket_start_at_ms: null,
  });

/** A terminal response labelled with the Codex subscription route. */
const codexResponse = (): Response =>
  new Response("complete", { status: 200, headers: { "Content-Type": "application/json", "x-uos-upstream": "chatgpt_codex" } });

/** A Codex response whose telemetry observed the request's token usage. */
const codexResponseWithUsage = (): Response => {
  const response = codexResponse();
  attachResponseTelemetry(response, {
    ...createResponseTelemetryState(),
    provider: "chatgpt_codex",
    model: "gpt-5.6-sol",
    inputTokens: 120,
    cachedInputTokens: 40,
    outputTokens: 30,
    usageObserved: true,
    usageTelemetryStatus: "reported",
  });
  return response;
};

const terminalOptions = (requestId: string, extra: Partial<TerminalLogInput> = {}): TerminalLogInput => ({
  route: "responses",
  startedAtMonotonicMs: performance.now(),
  requestId,
  recordTelemetry: ignoredTelemetry,
  recordCacheAnalytics: ignoredAnalytics,
  ...extra,
});

test("terminal usage accounting records one observation with the observed request hour and usage", async () => {
  const observations: UsageRollupInput[] = [];
  const requestStartedAtMs = Date.parse("2026-09-22T16:00:00Z");
  const response = await withTerminalRequestLog(
    codexResponseWithUsage(),
    terminalOptions("handler-usage-rollup-codex", {
      requestStartedAtMs,
      recordUsageRollup: (input) => {
        observations.push(input);
        return Promise.resolve(true);
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "complete");
  assert.equal(observations.length, 1, "one terminal response records exactly one usage observation");
  assert.deepEqual(observations[0], {
    model: "gpt-5.6-sol",
    provider: "chatgpt_codex",
    request_id: "handler-usage-rollup-codex",
    request_created_at_ms: requestStartedAtMs,
    input_tokens: 120,
    cached_input_tokens: 40,
    output_tokens: 30,
  });
});

test("terminal usage accounting falls back to the terminal clock when no request start is supplied", async () => {
  const observations: UsageRollupInput[] = [];
  const before = Date.now();
  const response = await withTerminalRequestLog(
    codexResponse(),
    terminalOptions("handler-usage-rollup-rejection", {
      recordUsageRollup: (input) => {
        observations.push(input);
        return Promise.resolve(true);
      },
    })
  );
  const after = Date.now();

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "complete");
  assert.equal(observations.length, 1);
  const observed = observations[0].request_created_at_ms;
  assert.ok(
    typeof observed === "number" && observed >= before && observed <= after,
    `a rejection path must bucket with the terminal wall clock, observed ${observed} outside ${before}..${after}`
  );
});

test("a failed terminal usage-rollup write never changes the terminal response", async () => {
  let attempts = 0;
  const response = await withTerminalRequestLog(
    codexResponse(),
    terminalOptions("handler-usage-rollup-failure", {
      recordUsageRollup: () => {
        attempts += 1;
        return Promise.reject(new Error("terminal usage rollup KV unavailable"));
      },
    })
  );

  assert.equal(attempts, 1, "the failed observation must still be attempted exactly once");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "complete");
});

test("terminal usage accounting performs no KV work for settled, aggregate, route-less or unobserved terminals", async () => {
  const kv = new CountingKv();
  setKvForTest(kv as unknown as Kv);
  try {
    for (const provider of ["metered", "surplus", "mixed"]) {
      const response = await withTerminalRequestLog(
        new Response("complete", { status: 200, headers: { "Content-Type": "application/json", "x-uos-upstream": provider } }),
        terminalOptions(`handler-usage-rollup-skip-${provider}`)
      );
      assert.equal(await response.text(), "complete");
    }
    const gateway = await withTerminalRequestLog(
      new Response("complete", { status: 200, headers: { "Content-Type": "application/json" } }),
      terminalOptions("handler-usage-rollup-skip-gateway")
    );
    assert.equal(await gateway.text(), "complete");
    // The Codex route is real but this response never reported usage, so the
    // writer must skip it instead of recording a fabricated zero-token row.
    const unobserved = await withTerminalRequestLog(codexResponse(), terminalOptions("handler-usage-rollup-skip-unobserved"));
    assert.equal(await unobserved.text(), "complete");
    assert.equal(kv.commands.length, 0, "a skipped observation must reach no KV call");
    assert.equal(kv.entries.size, 0, "a skipped observation must not create a rollup entry");
  } finally {
    setKvForTest(null);
  }
});

test("one observed terminal response writes exactly one rollup merge with actual tokens and no ledger charge", async () => {
  const kv = new CountingKv();
  setKvForTest(kv as unknown as Kv);
  try {
    const requestStartedAtMs = Date.parse("2026-09-22T16:00:00Z");
    const response = await withTerminalRequestLog(codexResponseWithUsage(), terminalOptions("handler-usage-rollup-observed", { requestStartedAtMs }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "complete");

    const rollupCommands = kv.commands.filter((record) =>
      record.keys.some((key) => key[0] === "uos_ai" && key[1] === "paid_fallback" && key[3] === "usage_rollup")
    );
    assert.equal(rollupCommands.filter((record) => record.command === "get").length, 1, "the writer reads its shard once");
    assert.equal(
      rollupCommands.filter((record) => record.command === "atomic.commit" && record.atomicResult === "committed").length,
      1,
      "the writer merges once without a retry"
    );

    const rollups = await listPaidFallbackUsageRollups(kv as unknown as Kv, { sinceMs: requestStartedAtMs - 1, nowMs: requestStartedAtMs + 1 });
    assert.equal(rollups.length, 1);
    assert.equal(rollups[0]?.provider, "chatgpt_codex");
    assert.equal(rollups[0]?.model, "gpt-5.6-sol");
    assert.equal(rollups[0]?.request_count, 1);
    assert.equal(rollups[0]?.input_tokens, 120);
    assert.equal(rollups[0]?.cached_input_tokens, 40);
    assert.equal(rollups[0]?.output_tokens, 30);
    assert.equal(rollups[0]?.quota_sum, 0);
    assert.equal(rollups[0]?.spend_microcredits, 0);
    assert.equal(rollups[0]?.bucket_start_at_ms, Math.floor(requestStartedAtMs / HOUR_MS) * HOUR_MS);
  } finally {
    setKvForTest(null);
  }
});
