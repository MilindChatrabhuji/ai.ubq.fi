import { createFetchMock } from "./helpers/fetch-mock.ts";
import { test } from "bun:test";
import assert from "node:assert/strict";

import { isHealthAvailable, refreshHealthBadge } from "../static/app.js";

type Badge = {
  dataset: { state?: string };
  textContent: string;
};

const makeBadge = (): Badge => ({ dataset: {}, textContent: "Checking..." });

test("homepage accepts only the passive available health contract", () => {
  assert.equal(isHealthAvailable({ ok: true }, { status: "available" }), true);
  assert.equal(isHealthAvailable({ ok: true }, { ok: true }), false);
  assert.equal(isHealthAvailable({ ok: false }, { status: "available" }), false);
  assert.equal(isHealthAvailable({ ok: true }, null), false);
});

test("homepage renders OK for the passive available health contract", async () => {
  const badge = makeBadge();
  const requests: unknown[][] = [];

  await refreshHealthBadge(
    createFetchMock((...args: unknown[]) => {
      requests.push(args);
      return Promise.resolve(
        new Response(JSON.stringify({ status: "available" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }),
    badge
  );

  assert.deepEqual(requests, [["/health", { cache: "no-store" }]]);
  assert.equal(badge.dataset.state, "ok");
  assert.equal(badge.textContent, "OK");
});

test("homepage renders Degraded for obsolete, unsuccessful, or malformed health", async () => {
  for (const response of [
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({ status: "available" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }),
    new Response("not JSON", { status: 200 }),
  ]) {
    const badge = makeBadge();
    await refreshHealthBadge(
      createFetchMock(() => Promise.resolve(response)),
      badge
    );
    assert.equal(badge.dataset.state, "bad");
    assert.equal(badge.textContent, "Degraded");
  }
});

test("homepage renders Offline when its health request fails", async () => {
  const badge = makeBadge();
  await refreshHealthBadge(
    createFetchMock(() => Promise.reject(new Error("offline"))),
    badge
  );
  assert.equal(badge.dataset.state, "bad");
  assert.equal(badge.textContent, "Offline");
});
