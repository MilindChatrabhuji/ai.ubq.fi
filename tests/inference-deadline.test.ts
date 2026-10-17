import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  BUFFERED_INFERENCE_DEADLINE_MS,
  createInferenceSignal,
  createStreamFirstEventDeadline,
  createStreamSemanticDeadline,
  INFERENCE_DEADLINE_MS,
  OPENAI_DEFAULT_REQUEST_TIMEOUT_MS,
  OPENAI_FLEX_REQUEST_TIMEOUT_MS,
  STREAM_FAILOVER_RESERVE_MS,
  STREAM_FIRST_EVENT_DEADLINE_MS,
  STREAM_INACTIVITY_DEADLINE_MS,
} from "../src/inference-deadline.ts";

/** The wall-clock budget one inference attempt owns, in milliseconds. */
const INFERENCE_BUDGET_MS = 30 * 60_000;

test("inference deadlines pin the documented per-attempt budget", () => {
  assert.equal(OPENAI_DEFAULT_REQUEST_TIMEOUT_MS, 10 * 60_000);
  assert.equal(OPENAI_FLEX_REQUEST_TIMEOUT_MS, 15 * 60_000);
  assert.equal(STREAM_FIRST_EVENT_DEADLINE_MS, INFERENCE_BUDGET_MS);
  assert.equal(STREAM_INACTIVITY_DEADLINE_MS, INFERENCE_BUDGET_MS);
  assert.equal(INFERENCE_DEADLINE_MS, STREAM_FIRST_EVENT_DEADLINE_MS);
  assert.equal(BUFFERED_INFERENCE_DEADLINE_MS, STREAM_FIRST_EVENT_DEADLINE_MS);
  // The failover reserve is subtracted from this budget before a fallback
  // attempt starts, so it must stay far below it.
  assert.equal(STREAM_FAILOVER_RESERVE_MS, 15_000);
});

test("inference signal propagates downstream cancellation", () => {
  const controller = new AbortController();
  const signal = createInferenceSignal(controller.signal);
  const reason = new DOMException("client disconnected", "AbortError");

  controller.abort(reason);

  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, reason);
});

test("inference signal enforces its deadline", async () => {
  const signal = createInferenceSignal(new AbortController().signal, 1);

  await new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true }
    );
  });

  assert.equal(signal.aborted, true);
  assert.equal(signal.reason?.name, "TimeoutError");
});

test("failover attempts share one pre-header deadline", async () => {
  const request = new AbortController();
  const shared = createStreamFirstEventDeadline(request.signal, 80);
  const primary = createStreamSemanticDeadline(shared.signal, 30);
  await new Promise<void>((resolve) => {
    primary.signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true }
    );
  });
  assert.equal(primary.signal.reason?.name, "TimeoutError");
  assert.equal(shared.signal.aborted, false);
  const remainingAtFallback = shared.remainingMs();
  assert.ok(remainingAtFallback > 0 && remainingAtFallback < 80);
  const fallback = createStreamSemanticDeadline(shared.signal, Math.ceil(remainingAtFallback) + 20);
  await new Promise<void>((resolve) => {
    fallback.signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true }
    );
  });
  assert.equal(shared.signal.aborted, true);
  assert.equal(fallback.signal.reason?.name, "TimeoutError");
  primary.clear();
  fallback.clear();
  shared.clear();
});

test("clearing a selected attempt leaves it available after the shared deadline", async () => {
  const request = new AbortController();
  const shared = createStreamFirstEventDeadline(request.signal, 20);
  const selected = createStreamSemanticDeadline(shared.signal, Math.ceil(shared.remainingMs()));
  selected.clear();
  shared.clear();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(selected.signal.aborted, false);
  assert.equal(shared.signal.aborted, false);
});
