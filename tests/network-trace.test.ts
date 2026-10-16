import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";

import { installNetworkTrace } from "../static/network.js";

const INSTALL_FLAG = "__uosNetworkTraceInstalled";

test("a caller-handled rejecting fetch does not create an unhandled network-trace continuation", async () => {
  const originalFetch = globalThis.fetch;
  const traceGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  const hadInstallFlag = Object.hasOwn(traceGlobal, INSTALL_FLAG);
  const originalInstallFlag = traceGlobal[INSTALL_FLAG];
  const unhandled: PromiseRejectionEvent[] = [];
  const onUnhandled = (event: PromiseRejectionEvent): void => {
    unhandled.push(event);
    event.preventDefault();
  };

  globalThis.addEventListener("unhandledrejection", onUnhandled);
  Reflect.deleteProperty(traceGlobal, INSTALL_FLAG);
  globalThis.fetch = createFetchMock(() => Promise.reject(new TypeError("caller catches this fetch rejection")));

  try {
    installNetworkTrace();
    await assert.rejects(() => globalThis.fetch("https://trace.example/reject"), /caller catches this fetch rejection/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.removeEventListener("unhandledrejection", onUnhandled);
    if (hadInstallFlag) traceGlobal[INSTALL_FLAG] = originalInstallFlag;
    else Reflect.deleteProperty(traceGlobal, INSTALL_FLAG);
  }
});
