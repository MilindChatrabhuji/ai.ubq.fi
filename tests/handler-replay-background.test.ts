import { test } from "bun:test";
import assert from "node:assert/strict";
import { withTerminalRequestLog } from "../src/handler/terminal-log.ts";
import { persistInferenceExceptionReplay } from "../src/handler/terminal-route.ts";

type TerminalLogInput = Parameters<typeof withTerminalRequestLog>[1];
type ReplayInput = NonNullable<TerminalLogInput["sentinelReplayInput"]>;
type ReplayPersistence = NonNullable<TerminalLogInput["persistSentinelReplay"]>;
type ExceptionReplayOptions = NonNullable<Parameters<typeof persistInferenceExceptionReplay>[2]>;
type ExceptionReplayPersistence = NonNullable<ExceptionReplayOptions["persistSentinelReplay"]>;
type RecordTelemetry = NonNullable<TerminalLogInput["recordTelemetry"]>;
type RecordAnalytics = NonNullable<TerminalLogInput["recordCacheAnalytics"]>;
type RecordAdminError = NonNullable<TerminalLogInput["recordAdminError"]>;
/** `void` may not appear as a call-site type argument, so name the deferred shape. */
type VoidDeferred = PromiseWithResolvers<void>;

const acceptedInput = (): ReplayInput => ({
  endpoint: "/v1/responses",
  method: "POST",
  body: new TextEncoder().encode('{"model":"fixture"}'),
  content_type: "application/json",
  compatibility_headers: {},
  request_id: "handler-replay-background",
  git_sha: "fixture-git-sha",
  deno_revision: "fixture-deno-revision",
});

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

test("terminal logging reports admission busy failures to the admin error ledger", async () => {
  const recorded: Parameters<RecordAdminError>[0][] = [];
  const response = await withTerminalRequestLog(
    new Response(
      JSON.stringify({
        error: {
          message: "All Codex accounts are busy",
          type: "server_error",
          code: "codex_admission_busy",
        },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    ),
    {
      route: "responses",
      startedAtMonotonicMs: performance.now(),
      requestId: "admission-busy-admin-error",
      recordTelemetry: ignoredTelemetry,
      recordCacheAnalytics: ignoredAnalytics,
      recordAdminError: (error) => {
        recorded.push(error);
        return Promise.resolve();
      },
    }
  );

  assert.equal(response.status, 503);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].request_id, "admission-busy-admin-error");
  assert.equal(recorded[0].status, 503);
  assert.equal(recorded[0].terminal_type, "http.error");
  assert.equal(recorded[0].failure_kind, "codex_admission_busy");
});

type TestGlobals = typeof globalThis & {
  EdgeRuntime?: Readonly<{ waitUntil?: (task: Promise<unknown>) => void }>;
};

test("EdgeRuntime replay registration returns failure responses before deferred persistence settles", async () => {
  const globals = globalThis as TestGlobals;
  const previousEdgeRuntime = globals.EdgeRuntime;
  const registeredTasks: Promise<unknown>[] = [];
  const persistence = Promise.withResolvers<Awaited<ReturnType<ReplayPersistence>>>();
  const persistenceStarted: VoidDeferred = Promise.withResolvers();
  let persistenceSettled = false;
  let persistedSnapshot: ReplayInput | null = null;
  const capture = acceptedInput();
  const originalBytes = [...capture.body];

  globals.EdgeRuntime = {
    waitUntil(task) {
      registeredTasks.push(task);
    },
  };

  try {
    const response = await withTerminalRequestLog(
      new Response('{"error":{"code":"provider_transport"}}', {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
      {
        route: "responses",
        startedAtMonotonicMs: performance.now(),
        requestId: "handler-replay-background",
        sentinelReplayInput: capture,
        persistSentinelReplay: (snapshot) => {
          persistedSnapshot = snapshot;
          persistenceStarted.resolve();
          return persistence.promise;
        },
        recordTelemetry: ignoredTelemetry,
        recordCacheAnalytics: ignoredAnalytics,
      }
    );

    assert.equal(response.status, 502);
    await persistenceStarted.promise;
    assert.equal(registeredTasks.length, 1);
    const snapshot = persistedSnapshot as ReplayInput | null;
    if (snapshot === null) throw new Error("replay persistence did not receive a snapshot");
    assert.notEqual(snapshot.body, capture.body);
    assert.deepEqual([...snapshot.body], originalBytes);
    assert.ok(capture.body.every((byte) => byte === 0));
    assert.equal(persistenceSettled, false);

    persistenceSettled = true;
    persistence.reject(new Error("fixture persistence failure"));
    await registeredTasks[0];
    assert.equal(response.status, 502);
    assert.ok(capture.body.every((byte) => byte === 0));
  } finally {
    if (!persistenceSettled) {
      persistence.resolve({ status: "disabled", reason: "kv_unavailable" });
    }
    await Promise.allSettled(registeredTasks);
    if (previousEdgeRuntime === undefined) delete globals.EdgeRuntime;
    else globals.EdgeRuntime = previousEdgeRuntime;
  }
});

test("thrown inference errors propagate before deferred exception replay persistence settles", async () => {
  const globals = globalThis as TestGlobals;
  const previousEdgeRuntime = globals.EdgeRuntime;
  const registeredTasks: Promise<unknown>[] = [];
  const persistence = Promise.withResolvers<Awaited<ReturnType<ExceptionReplayPersistence>>>();
  const persisted: ReplayInput[] = [];
  let persistenceSettled = false;
  const capture = acceptedInput();
  const originalBytes = [...capture.body];
  const runError = new Error("fixture inference failure");

  globals.EdgeRuntime = {
    waitUntil(task) {
      registeredTasks.push(task);
    },
  };

  try {
    // Mirrors the handler's exception path: await the scheduling helper and
    // then propagate the original error without waiting for replay storage.
    const scheduling = persistInferenceExceptionReplay(capture, runError, {
      persistSentinelReplay: (snapshot) => {
        persisted.push(snapshot);
        return persistence.promise;
      },
    });
    const propagated = scheduling.then(() => {
      throw runError;
    });

    await assert.rejects(propagated, (error: unknown) => {
      assert.equal(error, runError);
      return true;
    });
    assert.equal(persistenceSettled, false);
    assert.equal(registeredTasks.length, 1);
    // The request-owned original is released before the background handoff.
    assert.ok(capture.body.every((byte) => byte === 0));
    const snapshot = persisted.at(0);
    if (!snapshot) throw new Error("exception replay persistence did not receive a snapshot");
    assert.notEqual(snapshot.body, capture.body);
    assert.deepEqual([...snapshot.body], originalBytes);

    persistenceSettled = true;
    persistence.reject(new Error("fixture persistence failure"));
    await registeredTasks[0];
    assert.ok(snapshot.body.every((byte) => byte === 0));
  } finally {
    if (!persistenceSettled) {
      persistence.resolve({ status: "disabled", reason: "kv_unavailable" });
    }
    await Promise.allSettled(registeredTasks);
    if (previousEdgeRuntime === undefined) delete globals.EdgeRuntime;
    else globals.EdgeRuntime = previousEdgeRuntime;
  }
});

test("exception replay persistence is awaited and cleaned up without a background registrar", async () => {
  const globals = globalThis as TestGlobals;
  const previousEdgeRuntime = globals.EdgeRuntime;
  delete globals.EdgeRuntime;
  const persisted: ReplayInput[] = [];
  let persistenceSettled = false;
  const capture = acceptedInput();
  const originalBytes = [...capture.body];

  try {
    const scheduling = persistInferenceExceptionReplay(capture, new Error("fixture inference failure"), {
      persistSentinelReplay: (snapshot) => {
        persisted.push(snapshot);
        return Promise.resolve({ status: "disabled" as const, reason: "kv_unavailable" as const }).finally(() => {
          persistenceSettled = true;
        });
      },
    });

    // Nothing is registered and nothing has settled yet: the unscheduled path
    // still carries the snapshot until the persistence settles.
    assert.equal(persistenceSettled, false);
    const snapshot = persisted.at(0);
    if (!snapshot) throw new Error("exception replay persistence did not receive a snapshot");
    assert.ok(capture.body.every((byte) => byte === 0));
    assert.deepEqual([...snapshot.body], originalBytes);

    await scheduling;
    assert.equal(persistenceSettled, true);
    assert.ok(snapshot.body.every((byte) => byte === 0));
  } finally {
    if (previousEdgeRuntime === undefined) delete globals.EdgeRuntime;
    else globals.EdgeRuntime = previousEdgeRuntime;
  }
});
