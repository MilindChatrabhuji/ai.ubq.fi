import { test } from "bun:test";
import assert from "node:assert/strict";
import { createRequestDeliveryLifecycle } from "../src/handler/serve-handler.ts";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

test("request delivery lifecycle switches from request aborts to server delivery completion", async () => {
  const beforeHandoffRequest = new AbortController();
  const beforeHandoffCompletion = deferred();
  const beforeHandoff = createRequestDeliveryLifecycle(beforeHandoffRequest.signal, beforeHandoffCompletion.promise);
  const requestAbort = new DOMException("client left before handoff", "AbortError");
  beforeHandoffRequest.abort(requestAbort);
  assert.equal(beforeHandoff.signal.aborted, true);
  assert.equal(beforeHandoff.signal.reason, requestAbort);
  beforeHandoffCompletion.resolve();

  const deliveredRequest = new AbortController();
  const deliveredCompletion = deferred();
  const delivered = createRequestDeliveryLifecycle(deliveredRequest.signal, deliveredCompletion.promise);
  delivered.handoff();
  deliveredRequest.abort(new DOMException("legacy post-handoff abort", "AbortError"));
  await Promise.resolve();
  assert.equal(delivered.signal.aborted, false);
  deliveredCompletion.resolve();
  await deliveredCompletion.promise;
  assert.equal(delivered.signal.aborted, false);

  const interruptedRequest = new AbortController();
  const interruptedCompletion = deferred();
  const interrupted = createRequestDeliveryLifecycle(interruptedRequest.signal, interruptedCompletion.promise);
  interrupted.handoff();
  const deliveryFailure = new DOMException("response delivery failed", "AbortError");
  interruptedCompletion.reject(deliveryFailure);
  await interruptedCompletion.promise.catch(() => {});
  await Promise.resolve();
  assert.equal(interrupted.signal.aborted, true);
  assert.equal(interrupted.signal.reason, deliveryFailure);
});
