import { test } from "bun:test";
import assert from "node:assert/strict";

import { bindForegroundRefresh } from "../static/foreground-refresh.js";

class TestDocument extends EventTarget {
  visibilityState: "hidden" | "visible" = "visible";
}

const flushTimer = () => new Promise((resolve) => setTimeout(resolve, 5));

const pageShow = (persisted?: boolean) => {
  const event = new Event("pageshow");
  if (persisted !== undefined) Object.defineProperty(event, "persisted", { value: persisted });
  return event;
};

test("foreground refresh coalesces focus events and ignores hidden pages", async () => {
  const windowTarget = new EventTarget();
  const documentTarget = new TestDocument();
  let refreshes = 0;
  const unbind = bindForegroundRefresh(
    () => {
      refreshes += 1;
    },
    { windowTarget, documentTarget, delayMs: 0 }
  );

  windowTarget.dispatchEvent(new Event("focus"));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await flushTimer();
  assert.equal(refreshes, 1);

  documentTarget.visibilityState = "hidden";
  windowTarget.dispatchEvent(new Event("focus"));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await flushTimer();
  assert.equal(refreshes, 1);

  documentTarget.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await flushTimer();
  assert.equal(refreshes, 2);

  unbind();
  windowTarget.dispatchEvent(new Event("focus"));
  await flushTimer();
  assert.equal(refreshes, 2);
});

test("foreground refresh refreshes on a bfcache pageshow but not on the first load", async () => {
  const windowTarget = new EventTarget();
  const documentTarget = new TestDocument();
  let refreshes = 0;
  const unbind = bindForegroundRefresh(
    () => {
      refreshes += 1;
    },
    { windowTarget, documentTarget, delayMs: 0 }
  );

  // The initial load's `pageshow` (persisted false or absent) is not a resume.
  windowTarget.dispatchEvent(pageShow());
  windowTarget.dispatchEvent(pageShow(false));
  await flushTimer();
  assert.equal(refreshes, 0);

  // A bfcache restore coalesces with the focus/visibility events that accompany it.
  windowTarget.dispatchEvent(pageShow(true));
  windowTarget.dispatchEvent(new Event("focus"));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await flushTimer();
  assert.equal(refreshes, 1);

  // A restored page that is still hidden must not refresh.
  documentTarget.visibilityState = "hidden";
  windowTarget.dispatchEvent(pageShow(true));
  await flushTimer();
  assert.equal(refreshes, 1);

  documentTarget.visibilityState = "visible";
  windowTarget.dispatchEvent(pageShow(true));
  await flushTimer();
  assert.equal(refreshes, 2);

  unbind();
  windowTarget.dispatchEvent(pageShow(true));
  await flushTimer();
  assert.equal(refreshes, 2);
});
