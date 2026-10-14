import assert from "node:assert/strict";
import { withRejectionTerminalLog, withTerminalRequestLog } from "../src/handler/terminal-log.ts";
import { handleTerminalRoute } from "../src/handler/terminal-route.ts";
import { setInferenceAdmissionControllerForTest } from "../src/handler/admission.ts";
import { createInferenceAdmissionController } from "../src/inference-admission.ts";
import { config } from "../src/config.ts";
import { VpsJournalMetrics } from "../ops/vps-release-metrics.ts";
import type { VpsIdentity } from "../ops/vps-release-contract.ts";

type RequestEvent = { kind: "accepted" | "terminal"; payload: Record<string, unknown> };
const start = 1_800_000_000_000;
const identity: VpsIdentity = {
  runtime: "vps",
  gitSha: "a".repeat(40),
  deploymentId: `vps-${"a".repeat(40)}`,
  sourceArchiveSha256: "b".repeat(64),
  immutableTreeSha256: "c".repeat(64),
};

const captureEvents = async (run: () => Promise<Response>, afterAccepted?: () => void) => {
  const original = console.info;
  const events: RequestEvent[] = [];
  console.info = (label: unknown, payload?: unknown) => {
    if (label !== "[ai.ubq.fi] request_accepted" && label !== "[ai.ubq.fi] request_terminal") return;
    events.push({
      kind: label === "[ai.ubq.fi] request_accepted" ? "accepted" : "terminal",
      payload: JSON.parse(String(payload)) as Record<string, unknown>,
    });
    if (label === "[ai.ubq.fi] request_accepted") afterAccepted?.();
  };
  try {
    const response = await run();
    await response.text();
    return { response, events };
  } finally {
    console.info = original;
  }
};

/** Model the baked release identity in the fake journal; preserve every actual producer field and event. */
const sampleEvents = (events: readonly RequestEvent[]) =>
  new VpsJournalMetrics(
    {
      read: () =>
        Promise.resolve(
          events
            .map((event, index) =>
              JSON.stringify({
                _SYSTEMD_UNIT: "ai-ubq-fi.service",
                _BOOT_ID: "fixture-boot",
                __CURSOR: `cursor-${index}`,
                __REALTIME_TIMESTAMP: String((start + index + 1) * 1000),
                MESSAGE: `[ai.ubq.fi] request_${event.kind} ${JSON.stringify({
                  ...event.payload,
                  git_sha: identity.gitSha,
                  deno_revision: identity.deploymentId,
                })}`,
              })
            )
            .join("\n")
        ),
      coverage: (windowStart, windowEnd) =>
        Promise.resolve({
          complete: true,
          unit: "ai-ubq-fi.service",
          windowStart,
          windowEnd,
          bootId: "fixture-boot",
          firstCursor: "first",
          lastCursor: "last",
          digest: "d".repeat(64),
        }),
    },
    () => start + 65_000,
    5000,
    [],
    []
  ).sample({ identity, windowStart: start, windowEnd: start + 30_000 });

Deno.test("terminal admission: actual authentication refusal is excluded with complete journal coverage", async () => {
  const { response, events } = await captureEvents(() =>
    handleTerminalRoute(
      new Request("https://fixture.invalid/v1/responses", { method: "POST", body: "{}" }),
      "/v1/responses",
      undefined,
      "terminal-auth-refusal",
      start,
      performance.now()
    )
  );
  assert.equal(response.status, 401);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "terminal");
  assert.equal(events[0].payload.admission_stage, "pre_admission");
  assert.ok(Object.hasOwn(events[0].payload, "rate_limit_wait_ms"));
  assert.ok(Object.hasOwn(events[0].payload, "rate_limit_failover_model"));
  const sample = await sampleEvents(events);
  assert.equal(sample.coverage, "complete");
  assert.equal(sample.requestCount, 0);
});

Deno.test("terminal admission: rejection wrapper preserves explicit stages and generic logger remains unknown", async () => {
  for (const admissionStage of ["pre_admission", "accepted"] as const) {
    const { events } = await captureEvents(() =>
      withRejectionTerminalLog(new Response("fixture rejection", { status: 401 }), "responses", {
        requestId: `terminal-wrapper-${admissionStage}`,
        admissionStage,
        startedAtMonotonicMs: performance.now(),
      })
    );
    assert.equal(events[0].payload.admission_stage, admissionStage);
    const sample = await sampleEvents(events);
    assert.equal(sample.coverage, admissionStage === "pre_admission" ? "complete" : "incomplete");
  }
  const { events } = await captureEvents(() =>
    withTerminalRequestLog(new Response("fixture success"), {
      route: "responses",
      requestId: "terminal-legacy-unknown",
      startedAtMonotonicMs: performance.now(),
    })
  );
  assert.equal(events[0].payload.admission_stage, null);
  assert.equal((await sampleEvents(events)).coverage, "incomplete");
});

Deno.test("terminal admission: accepted cancellation remains in the real producer-reader cohort without dispatch", async () => {
  const token = "terminal-admission-fixture";
  const tokens = config.authTokens as Set<string>;
  assert.equal(tokens.has(token), false);
  const controller = createInferenceAdmissionController({ maxActive: 1, maxWaiting: 0 });
  const caller = new AbortController();
  const originalFetch = globalThis.fetch;
  let dispatched = 0;
  tokens.add(token);
  setInferenceAdmissionControllerForTest(controller);
  globalThis.fetch = () => {
    dispatched += 1;
    return Promise.reject(new Error("fixture must never dispatch"));
  };
  try {
    const { response, events } = await captureEvents(
      () =>
        handleTerminalRoute(
          new Request("https://fixture.invalid/v1/responses", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: "{}",
            signal: caller.signal,
          }),
          "/v1/responses",
          undefined,
          "terminal-accepted-cancellation",
          start,
          performance.now()
        ),
      () => {
        caller.abort(new DOMException("fixture accepted cancellation", "AbortError"));
      }
    );
    assert.equal(response.status, 499);
    assert.equal(dispatched, 0);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["accepted", "terminal"]
    );
    assert.equal(events[1].payload.admission_stage, "accepted");
    assert.equal(controller.snapshot().active, 0);
    assert.equal(controller.snapshot().waiting, 0);
    const sample = await sampleEvents(events);
    assert.equal(sample.coverage, "complete");
    assert.equal(sample.requestCount, 1);
    assert.equal(sample.fiveXxCount, 0);
    assert.equal((await sampleEvents(events.slice(1))).coverage, "incomplete");
  } finally {
    globalThis.fetch = originalFetch;
    setInferenceAdmissionControllerForTest(null);
    tokens.delete(token);
  }
});
