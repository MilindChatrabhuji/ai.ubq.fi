import { test } from "bun:test";
import { KvU64 } from "#kv";
import type { Kv } from "#kv";
import assert from "node:assert/strict";

import { withTerminalRequestLog } from "../src/handler/terminal-log.ts";
import { setKvForTest } from "../src/kv.ts";
import { createOptionalTelemetryQueue } from "../src/optional-telemetry-queue.ts";
import {
  closeOptionalPromptCacheAnalytics,
  enqueuePromptCacheAnalytics,
  flushOptionalPromptCacheAnalytics,
  optionalPromptCacheAnalyticsSnapshot,
  type PromptCacheAnalyticsQueueEntry,
  type PromptCacheAnalyticsRecordResult,
  recordPromptCacheAnalytics,
  resetOptionalPromptCacheAnalyticsForTest,
  writePromptCacheAnalyticsQueueEntry,
} from "../src/cache/prompt-analytics.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

// The counting KV applies atomic `sum` mutations with `new Deno.KvU64(...)`,
// and the runtime global is not guaranteed to exist. Every existing suite that
// writes counters installs this guard for the same reason.

const RELEASE = "0123456789abcdef0123456789abcdef01234567";
const NOW_MS = 1_800_000_000_000;
const SINK_DELAY_MS = 250;

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

const deferred = (): Readonly<{ promise: Promise<boolean>; resolve: (value: boolean) => void }> => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const event = (overrides: Partial<Parameters<typeof recordPromptCacheAnalytics>[0]> = {}) => ({
  provider: "chatgpt_codex",
  model: "gpt-telemetry-overhead-model",
  route: "responses",
  status: 200,
  completed: true,
  usageTelemetryStatus: "reported",
  inputTokens: 1_000,
  cachedInputTokens: 400,
  cacheWriteInputTokens: 100,
  promptCacheKeyPresent: true,
  promptCacheMode: "explicit",
  fallbackReason: null,
  ...overrides,
});

const options = (kv: CountingKv) => ({ kv: kv as unknown as Kv, release: RELEASE, now: () => NOW_MS });

/** Fails like an optional telemetry sink whose storage is unavailable. */
const failingSink =
  (attempts: { count: number }): typeof recordPromptCacheAnalytics =>
  () => {
    attempts.count += 1;
    return Promise.reject(new Error("optional cache analytics sink unavailable"));
  };

const jsonResponse = (body: string, status = 200): Response => new Response(body, { status, headers: { "Content-Type": "application/json" } });

/**
 * A terminal response labelled by a supported telemetry provider, so the
 * analytics gate is decided by completion evidence alone.
 */
const providerResponse = (body: string, provider = "chatgpt_codex"): Response =>
  new Response(body, { status: 200, headers: { "Content-Type": "application/json", "x-uos-upstream": provider } });

/**
 * The completion evidence a real 2xx inference carries in its response
 * telemetry. A bare `Response` has none, so the handler reports `completed:
 * false` with `usageTelemetryStatus: "missing"`, and the shared gate ignores the
 * sample as `not_completed_2xx` instead of recording it.
 */
const handlerCompletionEvidence = {
  completed: true,
  usageTelemetryStatus: "reported",
  inputTokens: 1_000,
  cachedInputTokens: 400,
  cacheWriteInputTokens: 100,
} as const;

/** The exact event the handler's terminal log produces for `providerResponse`. */
const handlerTerminalEvent = () =>
  event({
    provider: "chatgpt_codex",
    model: null,
    promptCacheKeyPresent: false,
    promptCacheMode: "unspecified",
    fallbackReason: null,
    ...handlerCompletionEvidence,
  });

const durableCounters = (kv: CountingKv): readonly (readonly [string, bigint])[] =>
  [...kv.entries.entries()].map(([key, entry]) => [key, (entry.value as KvU64).value] as const).sort((left, right) => left[0].localeCompare(right[0]));

test("prompt-cache analytics sink fixture records on the counting KV", async () => {
  const kv = new CountingKv();
  const recorded = await recordPromptCacheAnalytics(handlerTerminalEvent(), options(kv));
  assert.equal(recorded.status, "recorded", `the fixture sink disposition must be recorded, observed ${recorded.status}/${recorded.reason}`);
  assert.equal(recorded.reason, "recorded");
  assert.equal(recorded.bucket_start_at_ms, Math.floor(NOW_MS / (15 * 60_000)) * (15 * 60_000));
  assert.ok(kv.entries.size > 0, "the durable aggregate, cohort and cardinality counters must land");
  const commits = kv.commands.filter((command) => command.command === "atomic.commit");
  assert.equal(commits.length, 1, "one recorded sample is one atomic CAS plus sum commit");
  assert.equal(commits[0].atomicResult, "committed", "the fixture KV must commit the sink's atomic CAS plus sum mutations");
});

test("optional cache analytics: an inline delayed sink decides non-stream response latency", async () => {
  const kv = new CountingKv();
  const sinkResults: PromptCacheAnalyticsRecordResult[] = [];
  const startedAt = performance.now();
  const response = await withTerminalRequestLog(providerResponse("complete"), {
    route: "responses",
    startedAtMonotonicMs: performance.now(),
    requestId: "telemetry-overhead-inline-non-stream",
    recordCacheAnalytics: async (input, sinkOptions) => {
      await delay(SINK_DELAY_MS);
      const recorded = await recordPromptCacheAnalytics({ ...input, ...handlerCompletionEvidence }, { ...sinkOptions, ...options(kv) });
      sinkResults.push(recorded);
      return recorded;
    },
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "complete");
  assert.equal(sinkResults.length, 1, "the optional sink is invoked exactly once");
  assert.equal(sinkResults[0].status, "recorded", `the inline sink disposition must be recorded, observed ${sinkResults[0].status}/${sinkResults[0].reason}`);
  assert.equal(sinkResults[0].reason, "recorded");
  assert.ok(kv.entries.size > 0, "the delayed sink commits its counters, so the request body is retained until the analytics write settles");
  assert.ok(
    elapsedMs >= SINK_DELAY_MS - 25,
    `expected the optional analytics write to hold the response for about ${SINK_DELAY_MS}ms, observed ${Math.round(elapsedMs)}ms`
  );
});

test("optional cache analytics: a failing inline sink loses the sample in one attempt", async () => {
  const attempts = { count: 0 };
  const startedAt = performance.now();
  const response = await withTerminalRequestLog(providerResponse("complete"), {
    route: "responses",
    startedAtMonotonicMs: performance.now(),
    requestId: "telemetry-overhead-inline-failing",
    recordCacheAnalytics: failingSink(attempts),
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "complete");
  assert.equal(attempts.count, 1, "an unavailable optional sink is attempted exactly once");
  assert.ok(elapsedMs < SINK_DELAY_MS, `a failing sink must not add sink latency, observed ${Math.round(elapsedMs)}ms`);
});

test("queued optional analytics leaves the non-stream response off the sink path and records the same counters", async () => {
  const kv = new CountingKv();
  const queuedResults: PromptCacheAnalyticsRecordResult[] = [];
  const sinkResults: boolean[] = [];
  const queue = createOptionalTelemetryQueue<PromptCacheAnalyticsQueueEntry>({
    write: async (entry) => {
      await delay(SINK_DELAY_MS);
      const recorded = await writePromptCacheAnalyticsQueueEntry(entry);
      sinkResults.push(recorded);
      return recorded;
    },
  });
  const startedAt = performance.now();
  const response = await withTerminalRequestLog(providerResponse("complete"), {
    route: "responses",
    startedAtMonotonicMs: performance.now(),
    requestId: "telemetry-overhead-queued-non-stream",
    recordCacheAnalytics: async (input, sinkOptions) => {
      const queued = await enqueuePromptCacheAnalytics({ ...input, ...handlerCompletionEvidence }, { ...sinkOptions, queue, ...options(kv) });
      queuedResults.push(queued);
      return queued;
    },
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "complete");
  assert.equal(queuedResults.length, 1, "the optional enqueue is invoked exactly once");
  assert.equal(queuedResults[0].status, "queued", `the fixture sample must be accepted, observed ${queuedResults[0].status}/${queuedResults[0].reason}`);
  assert.equal(queuedResults[0].reason, "queued");
  assert.equal(queue.snapshot().enqueued, 1, "the completed sample is retained by the bounded queue");
  assert.ok(elapsedMs < SINK_DELAY_MS / 2, `a ${SINK_DELAY_MS}ms optional sink must not extend the response, observed ${Math.round(elapsedMs)}ms`);

  await queue.close();
  const snapshot = queue.snapshot();
  assert.deepEqual(sinkResults, [true], "the queued durable sink must report a recorded outcome, not a declined or failed one");
  assert.equal(snapshot.delivered, 1);
  assert.equal(snapshot.failed, 0);
  assert.equal(snapshot.retained_entries, 0);
  assert.equal(snapshot.retained_bytes, 0);
  assert.equal(snapshot.dropped_by_age, 0);
  assert.equal(snapshot.drain_timeouts, 0);
  assert.equal(snapshot.drain_in_progress, false);
  assert.equal(snapshot.shutdown_incomplete, false);

  const reference = new CountingKv();
  assert.equal((await recordPromptCacheAnalytics(handlerTerminalEvent(), options(reference))).status, "recorded");
  assert.deepEqual(durableCounters(kv), durableCounters(reference), "a queued sample applies exactly the counters a direct write applies");
});

test("optional telemetry queue charges entries and UTF-8 bytes until each write settles", async () => {
  const held = deferred();
  const entriesQueue = createOptionalTelemetryQueue<number>({
    write: () => held.promise,
    bounds: { maxEntries: 2, maxBytes: 4_096, maxAgeMs: 60_000, maxConcurrentWrites: 1 },
  });
  assert.deepEqual(
    [0, 1, 2].map((value) => entriesQueue.enqueue(value)),
    ["enqueued", "enqueued", "dropped_capacity"],
    "the entry ceiling covers the unresolved in-flight write too"
  );
  const entriesSnapshot = entriesQueue.snapshot();
  assert.equal(entriesSnapshot.retained_entries, 2);
  assert.equal(entriesSnapshot.queued_entries, 1);
  assert.equal(entriesSnapshot.writes_in_flight, 1);
  assert.equal(entriesSnapshot.retained_bytes, 2, "one UTF-8 byte per JSON digit, in-flight write included");
  assert.equal(entriesSnapshot.dropped_by_entries, 1);
  assert.equal(entriesSnapshot.dropped_by_bytes, 0);

  const bytesQueue = createOptionalTelemetryQueue<number>({
    write: () => held.promise,
    bounds: { maxEntries: 8, maxBytes: 300, maxAgeMs: 60_000, maxConcurrentWrites: 1 },
    measure: () => 200,
  });
  assert.deepEqual(
    [0, 1, 2].map((value) => bytesQueue.enqueue(value)),
    ["enqueued", "dropped_bytes", "dropped_bytes"]
  );
  const bytesSnapshot = bytesQueue.snapshot();
  assert.equal(bytesSnapshot.retained_bytes, 200, "the unresolved in-flight write still holds its byte charge");
  assert.equal(bytesSnapshot.retained_entries, 1);
  assert.equal(bytesSnapshot.dropped_by_bytes, 2);
  assert.equal(bytesSnapshot.dropped_by_entries, 0);

  const utf8Queue = createOptionalTelemetryQueue<string>({ write: () => Promise.resolve(true) });
  assert.equal(utf8Queue.enqueue("é"), "enqueued");
  assert.equal(utf8Queue.snapshot().retained_bytes, 4, "a two-byte character plus its JSON quotes");
  assert.equal(utf8Queue.enqueue("😀"), "enqueued");
  assert.equal(utf8Queue.snapshot().retained_bytes, 10, "a four-byte character is measured in UTF-8 bytes, not UTF-16 code units");
  await utf8Queue.flush();

  const malformedQueue = createOptionalTelemetryQueue<unknown>({ write: () => Promise.resolve(true) });
  assert.equal(malformedQueue.enqueue(Number.POSITIVE_INFINITY), "dropped_bytes", "an unserializable payload is dropped, never charged as zero");
  assert.equal(malformedQueue.enqueue(1n), "dropped_bytes");
  assert.equal(malformedQueue.snapshot().dropped_by_bytes, 2);
  assert.equal(malformedQueue.snapshot().retained_entries, 0);

  const invalidMeasureQueue = createOptionalTelemetryQueue<number>({
    write: () => Promise.resolve(true),
    measure: (value) => (value === 1 ? Number.NaN : -1),
  });
  assert.equal(invalidMeasureQueue.enqueue(1), "dropped_bytes", "a malformed size fails closed");
  assert.equal(invalidMeasureQueue.enqueue(2), "dropped_bytes");
  assert.equal(invalidMeasureQueue.snapshot().retained_entries, 0);

  held.resolve(true);
  await entriesQueue.flush();
  await bytesQueue.flush();
});

test("optional telemetry queue drops queued samples past its age ceiling", async () => {
  let nowMs = NOW_MS;
  const held = deferred();
  const queue = createOptionalTelemetryQueue<string>({
    write: () => held.promise,
    bounds: { maxEntries: 4, maxBytes: 4_096, maxAgeMs: 1_000, maxConcurrentWrites: 1 },
    now: () => nowMs,
  });
  assert.equal(queue.enqueue("in-flight"), "enqueued");
  assert.equal(queue.enqueue("stale"), "enqueued");
  assert.equal(queue.snapshot().queued_entries, 1);
  assert.equal(queue.snapshot().retained_entries, 2);

  nowMs += 5_000;
  assert.equal(queue.enqueue("fresh"), "enqueued");
  const snapshot = queue.snapshot();
  assert.equal(snapshot.dropped_by_age, 1, "a queued sample past the age ceiling is dropped instead of written");
  assert.equal(snapshot.queued_entries, 1);
  assert.equal(snapshot.retained_entries, 2, "the unresolved in-flight write keeps its charge");
  assert.equal(snapshot.oldest_retained_age_ms, 5_000, "the oldest retained entry includes unresolved in-flight work");

  held.resolve(true);
  await queue.flush();
});

test("optional telemetry queue bounds writer concurrency and coalesces concurrent flushes", async () => {
  let inFlight = 0;
  let peakInFlight = 0;
  const releases: (() => void)[] = [];
  const queue = createOptionalTelemetryQueue<number>({
    write: async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return true;
    },
    bounds: { maxEntries: 32, maxBytes: 4_096, maxAgeMs: 60_000, maxConcurrentWrites: 2 },
  });
  for (let index = 0; index < 6; index += 1) assert.equal(queue.enqueue(index), "enqueued");

  const coalescedBefore = queue.snapshot().coalesced_flushes;
  const first = queue.flush();
  const second = queue.flush();
  assert.equal(first, second, "a concurrent flush coalesces onto the drain that is already running");
  assert.equal(queue.snapshot().coalesced_flushes, coalescedBefore + 2, "each concurrent flush is reported as coalesced");
  assert.ok(queue.snapshot().writes_in_flight <= 2, "writer concurrency never exceeds its bound");

  for (let round = 0; round < 50; round += 1) {
    for (const release of releases.splice(0, releases.length)) release();
    await tick();
    const snapshot = queue.snapshot();
    if (snapshot.queued_entries === 0 && snapshot.writes_in_flight === 0) break;
  }
  await first;
  const settled = queue.snapshot();
  assert.equal(settled.enqueued, 6);
  assert.equal(settled.delivered, 6);
  assert.equal(settled.failed, 0);
  assert.equal(settled.drain_in_progress, false);
  assert.equal(peakInFlight, 2);
});

test("optional telemetry queue dispatches an entry accepted while a completed drain retires", async () => {
  const written: number[] = [];
  const queue = createOptionalTelemetryQueue<number>({
    write: (entry) => {
      written.push(entry);
      return Promise.resolve(true);
    },
  });

  // The empty flush's loop has already returned, but its retirement microtask
  // has not run yet, so `drain` is still published when the entry is accepted.
  // Coalescing that enqueue onto the completed drain would strand the entry.
  const retiringFlush = queue.flush();
  assert.equal(queue.snapshot().drain_in_progress, true, "the completed drain stays published until its cleanup microtask runs");
  assert.equal(queue.enqueue(7), "enqueued");

  await retiringFlush;
  assert.deepEqual(written, [7], "an entry accepted during drain retirement must reach the sink without another enqueue or flush");

  await queue.flush();
  const snapshot = queue.snapshot();
  assert.equal(snapshot.enqueued, 1);
  assert.equal(snapshot.delivered, 1);
  assert.equal(snapshot.failed, 0);
  assert.equal(snapshot.retained_entries, 0);
  assert.equal(snapshot.retained_bytes, 0);
  assert.equal(snapshot.queued_entries, 0);
  assert.equal(snapshot.drain_timeouts, 0);
  assert.equal(snapshot.drain_in_progress, false);
});

test("optional telemetry queue reports a failing sink without throwing or stalling the drain", async () => {
  const attempts = { count: 0 };
  const queue = createOptionalTelemetryQueue<number>({
    write: () => {
      attempts.count += 1;
      return Promise.reject(new Error("optional telemetry sink unavailable"));
    },
  });
  assert.equal(queue.enqueue(1), "enqueued");
  assert.equal(queue.enqueue(2), "enqueued");
  await queue.flush();
  const snapshot = queue.snapshot();
  assert.equal(attempts.count, 2);
  assert.equal(snapshot.delivered, 0);
  assert.equal(snapshot.failed, 2);
  assert.equal(snapshot.retained_entries, 0);
  assert.equal(snapshot.retained_bytes, 0);
  assert.equal(snapshot.last_error_class, "Error");
  assert.equal(snapshot.drain_in_progress, false);

  const refusing = createOptionalTelemetryQueue<number>({ write: () => Promise.resolve(false) });
  assert.equal(refusing.enqueue(1), "enqueued");
  await refusing.flush();
  assert.equal(refusing.snapshot().failed, 1, "a sink that declines an entry is reported as a failure");

  assert.equal(queue.enqueue(3), "enqueued");
  await queue.close();
  assert.equal(queue.enqueue(4), "dropped_closed");
  const closedSnapshot = queue.snapshot();
  assert.equal(closedSnapshot.closed, true);
  assert.equal(closedSnapshot.shutdown_incomplete, false, "a close with no unresolved work is complete");
  assert.equal(closedSnapshot.retained_entries, 0);
  assert.equal(closedSnapshot.dropped_after_closed, 1);
  assert.equal(closedSnapshot.failed, 3);
});

test("queued optional analytics retains only sanitized metadata and never drops required evidence", async () => {
  const rawModel = "gpt-telemetry-secret-model-must-not-be-retained";
  const retained: PromptCacheAnalyticsQueueEntry[] = [];
  const queue = createOptionalTelemetryQueue<PromptCacheAnalyticsQueueEntry>({
    write: (entry) => {
      retained.push(entry);
      return Promise.resolve(true);
    },
  });
  const queued = await enqueuePromptCacheAnalytics(event({ model: rawModel }), { queue, release: RELEASE, now: () => NOW_MS });
  assert.equal(queued.status, "queued");
  assert.equal(queued.reason, "queued");
  assert.equal(queued.bucket_start_at_ms, Math.floor(NOW_MS / (15 * 60_000)) * (15 * 60_000));
  assert.equal(retained.length, 1);

  const serialized = JSON.stringify({ ...retained[0], kv: undefined });
  assert.doesNotMatch(serialized, new RegExp(rawModel));
  assert.match(serialized, /[a-f0-9]{64}/);
  assert.ok(serialized.length < 1_024, `retained metadata must stay small, observed ${serialized.length} bytes`);
  assert.equal(retained[0].usage_kind, "reported");
  assert.equal(retained[0].deltas.input_tokens, 1_000);
  assert.equal(retained[0].deltas.cached_input_tokens, 400);

  const missing = await enqueuePromptCacheAnalytics(event({ usageTelemetryStatus: "missing", inputTokens: null, cachedInputTokens: null }), {
    queue,
    release: RELEASE,
    now: () => NOW_MS,
  });
  assert.equal(missing.status, "queued");
  assert.equal(retained[1].usage_kind, "missing", "absent cache usage stays unknown");
  assert.deepEqual(retained[1].deltas, { sample_count: 1 }, "a missing count is never defaulted to a measured zero");

  // A dropping optional queue must not suppress required admin error evidence,
  // and a terminal the shared gate rejects must never reach the queue at all.
  let adminErrors = 0;
  const handlerAnalytics: PromptCacheAnalyticsRecordResult[] = [];
  const closedQueue = createOptionalTelemetryQueue<PromptCacheAnalyticsQueueEntry>({ write: () => Promise.resolve(true) });
  await closedQueue.close();
  const droppedDirect = await enqueuePromptCacheAnalytics(event(), { queue: closedQueue, release: RELEASE, now: () => NOW_MS });
  assert.equal(droppedDirect.status, "dropped");
  assert.equal(droppedDirect.reason, "dropped_closed");
  const response = await withTerminalRequestLog(jsonResponse("complete"), {
    route: "responses",
    startedAtMonotonicMs: performance.now(),
    requestId: "telemetry-overhead-required-evidence",
    recordCacheAnalytics: async (input, sinkOptions) => {
      const recorded = await enqueuePromptCacheAnalytics(input, { ...sinkOptions, queue: closedQueue, release: RELEASE, now: () => NOW_MS });
      handlerAnalytics.push(recorded);
      return recorded;
    },
    recordAdminError: () => {
      adminErrors += 1;
      return Promise.resolve();
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "complete");
  assert.equal(handlerAnalytics.length, 1);
  assert.equal(handlerAnalytics[0].status, "ignored", "a terminal without completion evidence is not an optional sample");
  assert.equal(handlerAnalytics[0].reason, "not_completed_2xx");
  assert.equal(adminErrors, 1, "required admin error evidence is never routed through, or dropped by, the optional queue");
  assert.equal(closedQueue.snapshot().delivered, 0);
  assert.equal(closedQueue.snapshot().dropped_after_closed, 1);
});

test("optional telemetry queue bounds flush and close when a sink never settles", async () => {
  const held = deferred();
  const queue = createOptionalTelemetryQueue<number>({
    write: () => held.promise,
    bounds: { maxEntries: 4, maxBytes: 4_096, maxAgeMs: 60_000, maxConcurrentWrites: 1, maxDrainWaitMs: 50 },
  });
  assert.equal(queue.enqueue(1), "enqueued");
  assert.equal(queue.enqueue(2), "enqueued");

  const flushStartedAt = performance.now();
  await queue.flush();
  const flushMs = performance.now() - flushStartedAt;
  assert.ok(flushMs < 1_000, `a never-settling write must bound flush, observed ${Math.round(flushMs)}ms`);
  const stalled = queue.snapshot();
  assert.equal(stalled.drain_timeouts, 1, "an operation that runs out of its wait bound reports the timeout");
  assert.equal(stalled.dispatch_stalled, true);
  assert.equal(stalled.writes_in_flight, 1, "the stuck write retains its capacity");
  assert.equal(stalled.retained_entries, 2, "the unresolved write and the queued sample both stay charged");
  assert.equal(stalled.queued_entries, 1, "no new dispatch accumulates behind the stuck write");
  assert.equal(stalled.delivered, 0);
  assert.equal(stalled.drain_in_progress, false);

  // A stalled queue never waits again, and nothing is dispatched automatically.
  const repeatStartedAt = performance.now();
  await queue.flush();
  assert.ok(performance.now() - repeatStartedAt < 1_000, "a stalled flush settles without waiting");
  assert.equal(queue.snapshot().drain_timeouts, 1);
  assert.equal(queue.snapshot().delivered, 0);

  // close() is bounded too, and a close that cannot finish is terminal: the
  // unresolved work stays charged and reported instead of being written later.
  const closeStartedAt = performance.now();
  await queue.close();
  const closeMs = performance.now() - closeStartedAt;
  assert.ok(closeMs < 1_000, `a never-settling write must bound close, observed ${Math.round(closeMs)}ms`);
  const closedWhileStuck = queue.snapshot();
  assert.equal(closedWhileStuck.closed, true);
  assert.equal(closedWhileStuck.dispatch_stalled, true);
  assert.equal(closedWhileStuck.shutdown_incomplete, true, "shutdown reports that unresolved work remains");
  assert.equal(closedWhileStuck.retained_entries, 2);
  assert.equal(closedWhileStuck.queued_entries, 1);
  assert.equal(closedWhileStuck.writes_in_flight, 1);
  assert.equal(queue.enqueue(3), "dropped_closed");

  // Once the stuck write settles, capacity returns but a timed-out close never
  // dispatches the withheld sample: it stays accounted, never silently written.
  held.resolve(true);
  await tick();
  await queue.flush();
  const afterClose = queue.snapshot();
  assert.equal(afterClose.dispatch_stalled, false, "capacity returned once the stuck write settled");
  assert.equal(afterClose.delivered, 1, "only the write already in flight completed");
  assert.equal(afterClose.retained_entries, 1, "the withheld sample stays charged");
  assert.equal(afterClose.queued_entries, 1);
  assert.equal(afterClose.writes_in_flight, 0);
  assert.equal(afterClose.shutdown_incomplete, true);
});

test("optional telemetry queue bounds an operation whose sink progresses slower than its wait bound", async () => {
  const queue = createOptionalTelemetryQueue<number>({
    write: async () => {
      await delay(40);
      return true;
    },
    bounds: { maxEntries: 8, maxBytes: 4_096, maxAgeMs: 60_000, maxConcurrentWrites: 1, maxDrainWaitMs: 150 },
  });
  for (let index = 0; index < 6; index += 1) assert.equal(queue.enqueue(index), "enqueued");

  const startedAt = performance.now();
  await queue.flush();
  const elapsedMs = performance.now() - startedAt;
  const afterFlush = queue.snapshot();
  assert.equal(afterFlush.drain_timeouts, 1, "progress does not reset the operation's absolute wait bound");
  assert.ok(afterFlush.delivered < 6, `per-item progress must not extend the operation, observed ${afterFlush.delivered} of 6`);
  assert.ok(elapsedMs < 240, `the operation ends at its absolute bound, observed ${Math.round(elapsedMs)}ms`);
  assert.equal(afterFlush.retained_entries, 6 - afterFlush.delivered);

  // Settle the write that was still in flight when the operation ran out of time.
  for (let round = 0; round < 50 && queue.snapshot().writes_in_flight > 0; round += 1) await delay(20);
  const settled = queue.snapshot();
  assert.equal(settled.writes_in_flight, 0, "the in-flight write settles without leaving a pending timer");
  assert.ok(settled.delivered < 6, "the timed-out operation never dispatched the rest of the queue");
  assert.equal(settled.retained_entries, 6 - settled.delivered);
  assert.equal(settled.queued_entries, 6 - settled.delivered);
});

test("optional telemetry shutdown drains and closes the module queue", async () => {
  const kv = new CountingKv();
  setKvForTest(kv as unknown as Kv);
  try {
    assert.equal(optionalPromptCacheAnalyticsSnapshot(), null, "the module queue is created lazily");
    await flushOptionalPromptCacheAnalytics();

    const queued = await enqueuePromptCacheAnalytics(event(), { release: RELEASE, now: () => NOW_MS });
    assert.equal(queued.status, "queued");
    const retained = optionalPromptCacheAnalyticsSnapshot();
    assert.ok(retained, "the first optional sample creates the module queue");
    assert.equal(retained.enqueued, 1);

    await closeOptionalPromptCacheAnalytics();
    const settled = optionalPromptCacheAnalyticsSnapshot();
    // The first assertion narrows `settled`: it already fails on a null snapshot,
    // so the fields below are read without a redundant chain or guard.
    assert.equal(settled?.closed, true);
    assert.equal(settled.failed, 0, "the module queue sink must not report a failed write");
    assert.equal(settled.drain_timeouts, 0);
    assert.equal(settled.retained_entries, 0);
    assert.equal(settled.shutdown_incomplete, false);
    assert.equal(settled.drain_in_progress, false);
    assert.equal(settled.delivered, 1, "the shutdown drain delivers the retained sample to the environment KV sink");
    assert.ok(kv.entries.size > 0, "the drain writes the same durable counters the direct path writes");
    assert.equal((await enqueuePromptCacheAnalytics(event(), { release: RELEASE, now: () => NOW_MS })).reason, "dropped_closed");
  } finally {
    setKvForTest(null);
  }
});

test("optional telemetry close before lazy initialization is terminal", async () => {
  const kv = new CountingKv();
  resetOptionalPromptCacheAnalyticsForTest();
  setKvForTest(kv as unknown as Kv);
  try {
    assert.equal(optionalPromptCacheAnalyticsSnapshot(), null, "no optional sample has created the module queue");

    await closeOptionalPromptCacheAnalytics();
    assert.equal(optionalPromptCacheAnalyticsSnapshot(), null, "a close before the first sample must not create the module queue");

    const refused = await enqueuePromptCacheAnalytics(event(), { release: RELEASE, now: () => NOW_MS });
    assert.equal(refused.status, "dropped", "an eligible sample after close must be refused, not queued");
    assert.equal(refused.reason, "dropped_closed");

    await flushOptionalPromptCacheAnalytics();
    assert.equal(optionalPromptCacheAnalyticsSnapshot(), null, "a refused sample never creates or opens the module queue");
    assert.equal(kv.entries.size, 0, "a refused sample must not write durable counters");
  } finally {
    resetOptionalPromptCacheAnalyticsForTest();
    setKvForTest(null);
  }
});

test("optional telemetry close refuses a sample already resolving when close arrives", async () => {
  resetOptionalPromptCacheAnalyticsForTest();
  try {
    // The sample suspends while it resolves its cohort hash, so the close lands
    // before it reaches the queue: it must be refused there, never create the
    // queue, and never restart the writing the close promised to stop.
    const pending = enqueuePromptCacheAnalytics(event(), { release: RELEASE, now: () => NOW_MS });
    await closeOptionalPromptCacheAnalytics();
    const refused = await pending;

    assert.equal(refused.status, "dropped");
    assert.equal(refused.reason, "dropped_closed");
    assert.equal(optionalPromptCacheAnalyticsSnapshot(), null, "an in-flight sample must not create the module queue after close");
  } finally {
    resetOptionalPromptCacheAnalyticsForTest();
  }
});
