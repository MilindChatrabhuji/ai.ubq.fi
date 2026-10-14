import { KvU64 } from "#kv";
import type { AtomicOperation, Kv, KvEntryMaybe, KvKey } from "#kv";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { warnQuotaAccountingFailure, withTerminalRequestLog } from "../src/handler/terminal-log.ts";
import { recordPromptCacheAnalytics } from "../src/cache/prompt-analytics.ts";
import {
  PROMPT_CACHE_TELEMETRY_MIN_COMPLETED,
  readPromptCacheTelemetryBaseline,
  recordPromptCacheTelemetry,
  resolvePromptCacheTelemetryCounterKeys,
} from "../src/cache/telemetry-gate.ts";

const encodeKey = (key: KvKey): string => JSON.stringify(key);

class MemoryKv {
  readonly values = new Map<string, unknown>();
  atomicCommits = 0;
  failNextCommit = false;

  get<T>(key: KvKey): Promise<KvEntryMaybe<T>> {
    return Promise.resolve({
      key,
      value: (this.values.get(encodeKey(key)) as T | undefined) ?? null,
      versionstamp: this.values.has(encodeKey(key)) ? "00000000000000000001" : null,
    } as KvEntryMaybe<T>);
  }

  atomic(): AtomicOperation {
    const sums: Readonly<{ key: KvKey; amount: bigint }>[] = [];
    const operation = {
      sum: (key: KvKey, amount: bigint) => {
        sums.push({ key, amount });
        return operation;
      },
      commit: () => {
        this.atomicCommits += 1;
        if (this.failNextCommit) {
          this.failNextCommit = false;
          return Promise.reject(new Error("raw-model-must-not-reach-the-result"));
        }
        for (const { key, amount } of sums) {
          const encoded = encodeKey(key);
          const existing = this.values.get(encoded);
          const current = existing instanceof KvU64 ? existing.value : 0n;
          this.values.set(encoded, new KvU64(current + amount));
        }
        return Promise.resolve({ ok: true, versionstamp: "00000000000000000001" });
      },
    };
    return operation as unknown as AtomicOperation;
  }

  setCounter(key: KvKey, value: bigint): void {
    this.values.set(encodeKey(key), new KvU64(value));
  }

  setRawCounter(key: KvKey, value: unknown): void {
    this.values.set(encodeKey(key), value);
  }
}

const RELEASE = "0123456789abcdef0123456789abcdef01234567";
const event = (overrides: Partial<Parameters<typeof recordPromptCacheTelemetry>[0]> = {}) => ({
  provider: "chatgpt_codex",
  model: "gpt-cache-target",
  route: "responses",
  status: 200,
  completed: true,
  usageTelemetryStatus: "reported",
  cacheWriteTokensPresent: true,
  ...overrides,
});

test("prompt-cache telemetry gate atomically stores only redacted completed 2xx inference counters", async () => {
  const kv = new MemoryKv();
  const rawModel = "gpt-secret-model-name-must-not-persist";
  const recorded = await recordPromptCacheTelemetry(event({ model: rawModel }), {
    kv: kv as unknown as Kv,
    release: RELEASE,
  });

  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.reason, "recorded");
  assert.ok(recorded.model_hash);
  assert.doesNotMatch(JSON.stringify(recorded), new RegExp(rawModel));
  assert.equal(kv.atomicCommits, 1);
  assert.equal(kv.values.size, 3);
  for (const [key, value] of kv.values) {
    assert.doesNotMatch(key, new RegExp(rawModel));
    assert.ok(value instanceof KvU64);
    assert.equal(value.value, 1n);
  }

  const incomplete = await recordPromptCacheTelemetry(event({ completed: false, usageTelemetryStatus: "reported" }), {
    kv: kv as unknown as Kv,
    release: RELEASE,
  });
  const failed = await recordPromptCacheTelemetry(event({ status: 503, usageTelemetryStatus: "reported" }), { kv: kv as unknown as Kv, release: RELEASE });
  assert.deepEqual([incomplete.reason, failed.reason], ["not_completed_2xx", "not_completed_2xx"]);
  assert.equal(kv.atomicCommits, 1);

  kv.failNextCommit = true;
  const unavailable = await recordPromptCacheTelemetry(event({ model: rawModel }), { kv: kv as unknown as Kv, release: RELEASE });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.reason, "kv_unavailable");
  assert.doesNotMatch(JSON.stringify(unavailable), new RegExp(rawModel));
});

test("prompt-cache telemetry gate records invalid usage separately from reported coverage", async () => {
  const kv = new MemoryKv();
  const options = { kv: kv as unknown as Kv, release: RELEASE };
  const target = { provider: "chatgpt_codex", model: "gpt-cache-target" };

  const recorded = await recordPromptCacheTelemetry(event({ usageTelemetryStatus: "invalid" }), options);
  assert.equal(recorded.status, "recorded");
  assert.equal(kv.atomicCommits, 1);

  const keys = await resolvePromptCacheTelemetryCounterKeys(target, options);
  assert.ok(keys);
  const responseKeys = keys.routes.find((route) => route.route === "responses");
  assert.ok(responseKeys);
  assert.equal((kv.values.get(encodeKey(responseKeys.completed)) as KvU64).value, 1n);
  assert.equal((kv.values.get(encodeKey(responseKeys.invalid)) as KvU64).value, 1n);
  assert.equal(kv.values.has(encodeKey(responseKeys.reported)), false);
  assert.equal(kv.values.has(encodeKey(responseKeys.cache_write_reported)), false);

  const baseline = await readPromptCacheTelemetryBaseline(target, options);
  assert.equal(baseline.aggregate?.invalid, "1");
  assert.equal(baseline.routes.find((route) => route.route === "responses")?.invalid, "1");
  assert.equal(baseline.aggregate.reported, "0");
  assert.equal(baseline.aggregate.cache_write_reported, "0");
});

test("prompt-cache telemetry gate fails closed for an unknown release and malformed durable counters", async () => {
  const kv = new MemoryKv();
  const unknown = await recordPromptCacheTelemetry(event(), { kv: kv as unknown as Kv, release: "unknown" });
  assert.deepEqual(unknown, {
    status: "ignored",
    reason: "unknown_release",
    release: null,
    provider: null,
    route: null,
    model_hash: null,
  });
  assert.equal(kv.atomicCommits, 0);

  const target = { provider: "chatgpt_codex", model: "gpt-cache-target" };
  const unknownBaseline = await readPromptCacheTelemetryBaseline(target, {
    kv: kv as unknown as Kv,
    release: "unknown",
  });
  assert.equal(unknownBaseline.status, "not_ready");
  assert.equal(unknownBaseline.reason, "unknown_release");

  const keys = await resolvePromptCacheTelemetryCounterKeys(target, { release: RELEASE });
  assert.ok(keys);
  const responseKeys = keys.routes.find((route) => route.route === "responses");
  assert.ok(responseKeys);
  kv.setRawCounter(responseKeys.completed, { value: 1n });
  const malformed = await readPromptCacheTelemetryBaseline(target, { kv: kv as unknown as Kv, release: RELEASE });
  assert.equal(malformed.status, "not_ready");
  assert.equal(malformed.reason, "invalid_counter");
});

test("prompt-cache telemetry gate requires aggregate volume, every observed route, and reported coverage", async () => {
  const kv = new MemoryKv();
  const options = { kv: kv as unknown as Kv, release: RELEASE };
  const target = { provider: "chatgpt_codex", model: "gpt-cache-target" };

  const keys = await resolvePromptCacheTelemetryCounterKeys(target, options);
  assert.ok(keys);
  const responseKeys = keys.routes.find((route) => route.route === "responses");
  const chatKeys = keys.routes.find((route) => route.route === "chat.completions");
  assert.ok(responseKeys);
  assert.ok(chatKeys);
  kv.setCounter(responseKeys.completed, BigInt(PROMPT_CACHE_TELEMETRY_MIN_COMPLETED));
  kv.setCounter(responseKeys.reported, BigInt(PROMPT_CACHE_TELEMETRY_MIN_COMPLETED));
  kv.setCounter(responseKeys.cache_write_reported, BigInt(PROMPT_CACHE_TELEMETRY_MIN_COMPLETED));
  kv.setCounter(chatKeys.completed, 999n);
  kv.setCounter(chatKeys.reported, 999n);
  kv.setCounter(chatKeys.cache_write_reported, 999n);

  const undersizedRoute = await readPromptCacheTelemetryBaseline(target, options);
  assert.equal(undersizedRoute.status, "not_ready");
  assert.equal(undersizedRoute.reason, "route_completed_below_minimum");
  assert.equal(undersizedRoute.aggregate?.completed, "10999");

  await recordPromptCacheTelemetry(event({ route: "chat.completions" }), options);
  const eligible = await readPromptCacheTelemetryBaseline(target, options);
  assert.equal(eligible.status, "eligible");
  assert.equal(eligible.reason, "eligible");
  assert.equal(eligible.aggregate?.completed, "11000");
  assert.equal(eligible.aggregate.reported_coverage, 1);
  assert.deepEqual(
    eligible.routes.map((route) => [route.route, route.completed, route.reported_coverage_passed, route.cache_write_reported_coverage_passed]),
    [
      ["responses", "10000", true, true],
      ["chat.completions", "1000", true, true],
    ]
  );

  for (let index = 0; index < 6; index += 1) {
    await recordPromptCacheTelemetry(event({ route: "chat.completions", usageTelemetryStatus: "partial" }), options);
  }
  const incompleteCoverage = await readPromptCacheTelemetryBaseline(target, options);
  assert.equal(incompleteCoverage.status, "not_ready");
  assert.equal(incompleteCoverage.reason, "route_reported_coverage_below_minimum");
  const chatRoute = incompleteCoverage.routes.find((route) => route.route === "chat.completions");
  assert.equal(chatRoute?.completed, "1006");
  assert.equal(chatRoute.reported, "1000");
  assert.equal(chatRoute.reported_coverage_passed, false);
});

test("prompt-cache telemetry gate requires complete cache-write coverage and counts a valid zero as present", async () => {
  const kv = new MemoryKv();
  const options = { kv: kv as unknown as Kv, release: RELEASE };
  const target = { provider: "chatgpt_codex", model: "gpt-cache-target" };
  const keys = await resolvePromptCacheTelemetryCounterKeys(target, options);
  assert.ok(keys);
  const responseKeys = keys.routes.find((route) => route.route === "responses");
  assert.ok(responseKeys);

  const absent = await recordPromptCacheTelemetry(event({ cacheWriteTokensPresent: false }), options);
  const zero = await recordPromptCacheTelemetry(event({ cacheWriteTokensPresent: true }), options);
  assert.equal(absent.status, "recorded");
  assert.equal(zero.status, "recorded");
  assert.equal((kv.values.get(encodeKey(responseKeys.cache_write_reported)) as KvU64).value, 1n);

  kv.setCounter(responseKeys.completed, 10_000n);
  kv.setCounter(responseKeys.reported, 10_000n);
  kv.setCounter(responseKeys.cache_write_reported, 9_949n);
  const belowBoundary = await readPromptCacheTelemetryBaseline(target, options);
  assert.equal(belowBoundary.status, "not_ready");
  assert.equal(belowBoundary.reason, "aggregate_cache_write_reported_coverage_below_minimum");
  assert.equal(belowBoundary.aggregate?.cache_write_reported_coverage, 0.9949);

  kv.setCounter(responseKeys.cache_write_reported, 9_950n);
  const boundary = await readPromptCacheTelemetryBaseline(target, options);
  assert.equal(boundary.status, "eligible");
  assert.equal(boundary.aggregate?.cache_write_reported_coverage, 0.995);

  kv.setCounter(responseKeys.cache_write_reported, 10_001n);
  const malformed = await readPromptCacheTelemetryBaseline(target, options);
  assert.equal(malformed.status, "not_ready");
  assert.equal(malformed.reason, "invalid_counter");
});

test("terminal telemetry failures do not change non-stream or SSE responses", async () => {
  const originalInfo = console.info;
  const terminalLogs: unknown[][] = [];
  let telemetryAttempts = 0;
  let analyticsAttempts = 0;
  const failTelemetry: typeof recordPromptCacheTelemetry = () => {
    telemetryAttempts += 1;
    return Promise.reject(new Error("optional terminal telemetry unavailable"));
  };
  const failAnalytics: typeof recordPromptCacheAnalytics = () => {
    analyticsAttempts += 1;
    return Promise.reject(new Error("optional cache analytics unavailable"));
  };
  console.info = (...args: unknown[]): void => {
    if (args[0] === "[ai.ubq.fi] request_terminal") terminalLogs.push(args);
  };

  try {
    const nonStream = await withTerminalRequestLog(new Response("complete", { status: 200, headers: { "Content-Type": "application/json" } }), {
      route: "responses",
      startedAtMonotonicMs: performance.now(),
      requestId: "telemetry-failure-non-stream",
      recordCacheAnalytics: failAnalytics,
      recordTelemetry: failTelemetry,
    });
    assert.equal(nonStream.status, 200);
    assert.equal(await nonStream.text(), "complete");

    const stream = await withTerminalRequestLog(new Response("data: complete\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }), {
      route: "responses",
      startedAtMonotonicMs: performance.now(),
      requestId: "telemetry-failure-sse",
      recordCacheAnalytics: failAnalytics,
      recordTelemetry: failTelemetry,
    });
    assert.equal(stream.status, 200);
    assert.equal(await stream.text(), "data: complete\n\n");
    assert.equal(telemetryAttempts, 2, "both injected telemetry writes must have failed");
    assert.equal(analyticsAttempts, 2, "both injected cache analytics writes must have failed");
    assert.equal(terminalLogs.length, 2, "each response emits at most one terminal log");
  } finally {
    console.info = originalInfo;
  }
});

test("quota accounting warnings expose only error classes", () => {
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  const secret = "quota-secret-must-not-reach-logs";
  console.warn = (...args: unknown[]): void => {
    warnings.push(args);
  };
  try {
    warnQuotaAccountingFailure({ route: "responses", requestId: "quota-warning-redaction" }, new TypeError(secret));
    const serialized = JSON.stringify(warnings);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /TypeError/);
  } finally {
    console.warn = originalWarn;
  }
});
