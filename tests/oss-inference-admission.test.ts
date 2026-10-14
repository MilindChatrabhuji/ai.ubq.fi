import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  acquireInferenceAdmission,
  createInferenceAdmissionController,
  DEFAULT_INFERENCE_ADMISSION_LIMITS,
  inferenceAdmissionSnapshot,
  type InferenceAdmissionResult,
} from "../src/inference-admission.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Admitted = Extract<InferenceAdmissionResult, { ok: true }>;

const admittedOrThrow = (result: InferenceAdmissionResult, message: string): Admitted => {
  if (!result.ok) throw new Error(`${message} (received ${result.kind})`);
  return result;
};

type LocalOverload = Extract<InferenceAdmissionResult, { kind: "local_overload" }>;

const localOverloadOrThrow = (result: InferenceAdmissionResult, message: string): LocalOverload => {
  if (result.ok) throw new Error(`${message} (received an admission)`);
  if (result.kind !== "local_overload") throw new Error(`${message} (received ${result.kind})`);
  return result;
};

/** Block the event loop synchronously so no timer callback can run. */
const holdEventLoopForMs = (ms: number): void => {
  const deadline = performance.now() + ms;
  let spins = 0;
  while (performance.now() < deadline) spins += 1;
  assert.ok(spins > 0, "the fixture must actually block the event loop");
};

test("admission bounds active permits and reports the queue wait to the integration", async () => {
  const controller = createInferenceAdmissionController({ maxActive: 2, maxWaiting: 4, maxQueueWaitMs: 1_000 });
  const first = admittedOrThrow(await controller.acquire(), "expected the first attempt to be admitted");
  const second = admittedOrThrow(await controller.acquire(), "expected the second attempt to be admitted");
  assert.equal(controller.snapshot().active, 2);
  assert.equal(controller.snapshot().waiting, 0);

  const queued = controller.acquire();
  await sleep(15);
  assert.equal(controller.snapshot().active, 2, "the active bound holds while a request waits");
  assert.equal(controller.snapshot().waiting, 1);

  first.release();
  const admitted = admittedOrThrow(await queued, "expected the queued attempt to be admitted on release");
  assert.ok(admitted.waitedMs >= 10, `expected the queue wait to be visible to the integration, received ${admitted.waitedMs}ms`);
  assert.equal(controller.snapshot().active, 2);
  assert.equal(controller.snapshot().waiting, 0);

  admitted.release();
  second.release();
  assert.equal(controller.snapshot().active, 0);
});

test("admission rejects a new request once the waiting bound is full", async () => {
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 1, maxQueueWaitMs: 1_000 });
  const active = admittedOrThrow(await controller.acquire(), "expected the first attempt to be admitted");
  const queued = controller.acquire();
  assert.equal(controller.snapshot().waiting, 1);

  const rejected = localOverloadOrThrow(await controller.acquire(), "expected the full waiting bound to reject the new request");
  assert.equal(rejected.kind, "local_overload");
  assert.equal(rejected.cause, "queue_limit");
  assert.equal(rejected.waitedMs, 0);
  assert.equal(controller.snapshot().active, 1);

  active.release();
  const admitted = admittedOrThrow(await queued, "expected the queued attempt to keep its place");
  admitted.release();
  assert.equal(controller.snapshot().active, 0);
});

test("admission enforces finite waiting and recovers after overload", async () => {
  const maxQueueWaitMs = 25;
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 1, maxQueueWaitMs });
  const active = admittedOrThrow(await controller.acquire(), "expected the first attempt to be admitted");
  const waiting = controller.acquire();
  const overBound = localOverloadOrThrow(await controller.acquire(), "expected the full waiting bound to reject the third attempt");
  assert.equal(overBound.cause, "queue_limit");

  const startedAtMs = performance.now();
  const expired = localOverloadOrThrow(await waiting, "expected the finite queue wait to reject the waiting attempt");
  const elapsedWallMs = performance.now() - startedAtMs;
  assert.equal(expired.kind, "local_overload");
  assert.equal(expired.cause, "queue_wait_timeout");
  assert.ok(expired.waitedMs >= maxQueueWaitMs - 5, `queue wait ${expired.waitedMs}ms should approach the ${maxQueueWaitMs}ms bound`);
  assert.ok(elapsedWallMs >= maxQueueWaitMs - 5 && elapsedWallMs < 5_000, `queue wait measured ${Math.round(elapsedWallMs)}ms`);
  assert.equal(controller.snapshot().active, 1, "a rejected waiter never consumed the held permit");
  assert.equal(controller.snapshot().waiting, 0);

  active.release();
  assert.equal(controller.snapshot().active, 0);
  const recovered = admittedOrThrow(await controller.acquire(), "expected the guard to admit after overload");
  assert.equal(recovered.waitedMs, 0, "recovery admits immediately instead of inheriting the previous wait");
  recovered.release();
  assert.equal(controller.snapshot().active, 0);
});

test("admission removes an aborted waiter promptly and never gives it a permit", async () => {
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 2, maxQueueWaitMs: 1_000 });
  const active = admittedOrThrow(await controller.acquire(), "expected the first attempt to be admitted");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const immediate = await controller.acquire({ signal: alreadyAborted.signal });
  if (immediate.ok) throw new Error("expected an already-aborted caller to be rejected without queueing");
  assert.equal(immediate.kind, "caller_aborted");
  assert.equal(immediate.waitedMs, 0);
  assert.equal(controller.snapshot().waiting, 0);

  const abortController = new AbortController();
  const waiting = controller.acquire({ signal: abortController.signal });
  assert.equal(controller.snapshot().waiting, 1);
  abortController.abort();
  const aborted = await waiting;
  if (aborted.ok) throw new Error("expected the aborted waiter to be rejected");
  assert.equal(aborted.kind, "caller_aborted");
  assert.equal(controller.snapshot().waiting, 0, "the aborted waiter leaves the queue promptly");

  active.release();
  assert.equal(controller.snapshot().active, 0, "the aborted attempt never consumed the freed permit");
  const admitted = admittedOrThrow(await controller.acquire(), "expected a fresh attempt to be admitted");
  admitted.release();
  assert.equal(controller.snapshot().active, 0);
});

test("admission gives a freed permit to a live waiter, not to one that aborted first", async () => {
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 3, maxQueueWaitMs: 1_000 });
  const active = admittedOrThrow(await controller.acquire(), "expected the first attempt to be admitted");
  const abortController = new AbortController();
  const aborted = controller.acquire({ signal: abortController.signal });
  const live = controller.acquire();
  assert.equal(controller.snapshot().waiting, 2);

  abortController.abort();
  active.release();
  const rejected = await aborted;
  if (rejected.ok) throw new Error("expected the aborted waiter to lose the race for the freed permit");
  assert.equal(rejected.kind, "caller_aborted");
  const admitted = admittedOrThrow(await live, "expected the live waiter to receive the freed permit");
  assert.equal(controller.snapshot().active, 1);
  admitted.release();
  assert.equal(controller.snapshot().active, 0);
});

test("admission returns a permit exactly once", async () => {
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 2, maxQueueWaitMs: 1_000 });
  const active = admittedOrThrow(await controller.acquire(), "expected the first attempt to be admitted");
  const queued = controller.acquire();

  active.release();
  active.release();
  const admitted = admittedOrThrow(await queued, "expected the queued attempt to be admitted");
  assert.equal(controller.snapshot().active, 1, "the repeated release must not return the permit twice");

  admitted.release();
  admitted.release();
  assert.equal(controller.snapshot().active, 0, "the active count returns to zero and never below it");
});

test("fixture: an unrelated principal is served promptly despite a sustained backlog", async () => {
  // The noisy principal holds the only permit and sustains a backlog behind it.
  // The first turn belongs to the principal that arrived first; the second turn
  // must then go to the unrelated principal, so the quiet request is admitted
  // after two turns even though the noisy principal still has queued work.
  // Arrival order alone served the whole backlog first and exhausted the quiet
  // request's queue wait (receipt 1c7ed31d reproduced exactly that starvation).
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 6, maxQueueWaitMs: 600 });
  const noisyActive = admittedOrThrow(await controller.acquire({ principal: "noisy" }), "expected the noisy principal to hold the permit");
  const noisyBacklog = [controller.acquire({ principal: "noisy" }), controller.acquire({ principal: "noisy" })];
  const quiet = controller.acquire({ principal: "quiet" });
  assert.equal(controller.snapshot().waiting, 3);
  assert.equal(controller.snapshot().principals, 2);

  noisyActive.release();
  const firstTurn = admittedOrThrow(await noisyBacklog[0], "expected the first turn to serve the arrival-first principal");

  firstTurn.release();
  const quietTurn = admittedOrThrow(await quiet, "expected the second turn to serve the unrelated principal");
  assert.equal(controller.snapshot().waiting, 1, "the remaining noisy backlog still waits behind the fair turn");

  quietTurn.release();
  const backlogTurn = admittedOrThrow(await noisyBacklog[1], "expected the remaining backlog to be served on its next turn");
  backlogTurn.release();
  assert.equal(controller.snapshot().active, 0);
  assert.equal(controller.snapshot().waiting, 0);
  assert.equal(controller.snapshot().principals, 0);
});

test("fixture: a delayed event loop cannot grant a permit past the queue wait", async () => {
  const maxQueueWaitMs = 25;
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 4, maxQueueWaitMs });
  const holder = admittedOrThrow(await controller.acquire({ principal: "holder" }), "expected the holder to be admitted");
  const queued = controller.acquire({ principal: "waiter" });
  assert.equal(controller.snapshot().waiting, 1);

  // The queue-wait timer cannot run while the loop is blocked, so the release
  // below would otherwise grant this permit after the advertised bound.
  holdEventLoopForMs(40);
  holder.release();

  const result = localOverloadOrThrow(await queued, "expected the overdue waiter to expire instead of being granted");
  assert.equal(result.cause, "queue_wait_timeout");
  assert.ok(result.waitedMs >= maxQueueWaitMs, `expired wait ${result.waitedMs}ms should have reached the ${maxQueueWaitMs}ms bound`);
  assert.equal(controller.snapshot().active, 0, "the overdue waiter never consumed the released permit");
  assert.equal(controller.snapshot().waiting, 0);
  assert.equal(controller.snapshot().principals, 0);
});

test("admission restores an expiring principal's turn to its next waiter", async () => {
  const maxQueueWaitMs = 25;
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 6, maxQueueWaitMs });
  const holder = admittedOrThrow(await controller.acquire({ principal: "holder" }), "expected the holder to be admitted");
  const overdue = controller.acquire({ principal: "a" });
  holdEventLoopForMs(40);
  // Both of these arrive after the block, so only the head waiter is overdue.
  const next = controller.acquire({ principal: "a" });
  const other = controller.acquire({ principal: "b" });
  assert.equal(controller.snapshot().waiting, 3);

  holder.release();
  const overdueResult = localOverloadOrThrow(await overdue, "expected the overdue head waiter to expire");
  assert.equal(overdueResult.cause, "queue_wait_timeout");
  const nextResult = admittedOrThrow(await next, "expected the same principal's next waiter to keep the restored turn");
  assert.equal(controller.snapshot().waiting, 1, "the unrelated principal still waits behind the restored turn");

  nextResult.release();
  const otherResult = admittedOrThrow(await other, "expected the unrelated principal to be served next");
  otherResult.release();
  assert.equal(controller.snapshot().active, 0);
  assert.equal(controller.snapshot().principals, 0);
});

test("admission rotates waiting turns across three principals during a sustained burst", async () => {
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 12, maxQueueWaitMs: 500 });
  const holder = admittedOrThrow(await controller.acquire({ principal: "a" }), "expected the burst principal to hold the permit");
  const burst = [
    controller.acquire({ principal: "a" }),
    controller.acquire({ principal: "a" }),
    controller.acquire({ principal: "a" }),
    controller.acquire({ principal: "a" }),
  ];
  const other = controller.acquire({ principal: "b" });
  const third = controller.acquire({ principal: "c" });
  assert.equal(controller.snapshot().waiting, 6);
  assert.equal(controller.snapshot().principals, 3);

  // One turn per principal per rotation, and arrival order inside each
  // principal: the sustained burst takes one waiting turn while `b` and `c`
  // still have requests queued, so neither waits for the whole burst.
  const turnOrder = [burst[0], other, third, burst[1], burst[2], burst[3]];
  const served: Admitted[] = [];
  let held = holder;
  for (const [index, next] of turnOrder.entries()) {
    held.release();
    held = admittedOrThrow(await next, `expected turn ${index + 1} to serve the scheduled principal`);
    assert.equal(controller.snapshot().waiting, turnOrder.length - index - 1, "one waiting request is served per turn");
    served.push(held);
  }
  assert.equal(controller.snapshot().principals, 0);
  for (const permit of served) permit.release();
  assert.equal(controller.snapshot().active, 0);
});

test("admission keeps principal-less waiting requests in arrival order", async () => {
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 4, maxQueueWaitMs: 500 });
  const holder = admittedOrThrow(await controller.acquire(), "expected the principal-less holder to be admitted");
  const first = controller.acquire();
  const second = controller.acquire();
  assert.equal(controller.snapshot().waiting, 2);
  assert.equal(controller.snapshot().principals, 1, "principal-less requests share one arrival-ordered group");

  holder.release();
  const servedFirst = admittedOrThrow(await first, "expected the first principal-less request to be served first");
  assert.equal(controller.snapshot().waiting, 1);
  servedFirst.release();
  const servedSecond = admittedOrThrow(await second, "expected the second principal-less request to be served next");
  servedSecond.release();
  assert.equal(controller.snapshot().active, 0);
  assert.equal(controller.snapshot().principals, 0);
});

test("admission removes a cancelled principal's empty waiting state", async () => {
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 4, maxQueueWaitMs: 1_000 });
  const holder = admittedOrThrow(await controller.acquire({ principal: "holder" }), "expected the holder to be admitted");
  const abortController = new AbortController();
  const cancelled = controller.acquire({ principal: "cancelled", signal: abortController.signal });
  const kept = controller.acquire({ principal: "kept" });
  assert.equal(controller.snapshot().waiting, 2);
  assert.equal(controller.snapshot().principals, 2);

  abortController.abort();
  const cancelledResult = await cancelled;
  if (cancelledResult.ok) throw new Error("expected the cancelled waiter to be rejected");
  assert.equal(cancelledResult.kind, "caller_aborted");
  assert.equal(controller.snapshot().waiting, 1);
  assert.equal(controller.snapshot().principals, 1, "only the principal that still waits keeps its state");

  holder.release();
  const keptResult = admittedOrThrow(await kept, "expected the surviving principal to keep its turn");
  keptResult.release();
  assert.equal(controller.snapshot().active, 0);
  assert.equal(controller.snapshot().principals, 0);
});

test("admission removes expired principals' empty waiting state", async () => {
  const maxQueueWaitMs = 25;
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 4, maxQueueWaitMs });
  const holder = admittedOrThrow(await controller.acquire({ principal: "holder" }), "expected the holder to be admitted");
  const first = controller.acquire({ principal: "expired-a" });
  const second = controller.acquire({ principal: "expired-b" });
  assert.equal(controller.snapshot().principals, 2);

  const firstResult = localOverloadOrThrow(await first, "expected the first queue wait to expire");
  const secondResult = localOverloadOrThrow(await second, "expected the second queue wait to expire");
  assert.equal(firstResult.cause, "queue_wait_timeout");
  assert.equal(secondResult.cause, "queue_wait_timeout");
  assert.ok(firstResult.waitedMs >= maxQueueWaitMs - 5, `queue wait ${firstResult.waitedMs}ms should reach the ${maxQueueWaitMs}ms bound`);
  assert.equal(controller.snapshot().waiting, 0);
  assert.equal(controller.snapshot().principals, 0, "expired waiters leave no per-principal state");

  holder.release();
  assert.equal(controller.snapshot().active, 0);
  const fresh = admittedOrThrow(await controller.acquire({ principal: "expired-a" }), "expected a fresh admission after cleanup");
  fresh.release();
  assert.equal(controller.snapshot().active, 0);
});

test("the shared guard exposes the fixed internal limits to the integration", async () => {
  assert.deepEqual(DEFAULT_INFERENCE_ADMISSION_LIMITS, { maxActive: 64, maxWaiting: 128, maxQueueWaitMs: 5_000 });
  const before = inferenceAdmissionSnapshot();
  assert.equal(before.maxActive, DEFAULT_INFERENCE_ADMISSION_LIMITS.maxActive);
  assert.equal(before.maxWaiting, DEFAULT_INFERENCE_ADMISSION_LIMITS.maxWaiting);

  const admitted = admittedOrThrow(await acquireInferenceAdmission(), "expected the shared guard to admit one request");
  assert.equal(admitted.waitedMs, 0);
  assert.equal(inferenceAdmissionSnapshot().active, before.active + 1);
  admitted.release();
  assert.equal(inferenceAdmissionSnapshot().active, before.active);
});

test("internal construction rejects limits that cannot bound anything", () => {
  assert.throws(() => createInferenceAdmissionController({ maxActive: 0 }), RangeError);
  assert.throws(() => createInferenceAdmissionController({ maxWaiting: -1 }), RangeError);
  assert.throws(() => createInferenceAdmissionController({ maxQueueWaitMs: 1.5 }), RangeError);
});
