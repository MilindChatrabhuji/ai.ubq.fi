import { test, beforeAll, afterAll } from "bun:test";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { buildPermissionsNative } from "../scripts/build-permissions.ts";
import { applyLinuxPermissions } from "../src/runtime/permissions-linux.ts";
import assert from "node:assert/strict";

import { classifySupervisorState, ensureSupervisorSnapshot, newestTurnOf, quotaFromRateLimits, sessionFromParts } from "../src/codex/supervisor-inventory.ts";
import type { SupervisorSource } from "../src/codex/supervisor-config.ts";
import {
  boundedText,
  mapWithConcurrency,
  parseSupervisorConfig,
  readHostname,
  resolveSupervisorConfig,
  uniqueStrings,
  waitForPoll,
} from "../src/codex/supervisor-config.ts";
import { openSupervisorConnection, setSupervisorWebSocketConstructorForTest, type SupervisorConnection } from "../src/codex/supervisor-transport.ts";
import {
  appendRolloutTailTurn,
  assembleBriefContext,
  buildSupervisorBriefPrompt,
  buildSupervisorBriefRequestBody,
  collectSupervisorBriefContext,
  handleAdminCodexSupervisorBrief,
  parseSupervisorBriefOutput,
  type SupervisorBriefContext,
} from "../src/codex/supervisor-brief.ts";

// This disposable test process uses actual kernel read/exec denial, not a JS permission facade.
const INITIAL_CWD = process.cwd();
const CONFINED_CWD = await mkdtemp(join(tmpdir(), "m09-supervisor-"));
const CONFIG_DIR = join(CONFINED_CWD, ".data");
const CONFIG_FILE = join(CONFIG_DIR, "codex-supervisor.json");
const NATIVE_DIR = join(CONFINED_CWD, "native");
await mkdir(CONFIG_DIR);
await writeFile(CONFIG_FILE, JSON.stringify({ sources: [] }), { flag: "wx" });
const artifact = await buildPermissionsNative(NATIVE_DIR);
beforeAll(() => {
  assert.equal(process.env.HOME, undefined);
  assert.equal(process.env.CODEX_HOME, undefined);
  process.chdir(CONFINED_CWD);
  applyLinuxPermissions(
    { read: ["src", "tests", "scripts", "node_modules", "package.json"].map((path) => join(INITIAL_CWD, path)), write: [CONFINED_CWD] },
    artifact
  );
  assert.throws(
    () => readFileSync(CONFIG_FILE),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EACCES"
  );
});
afterAll(async () => {
  process.chdir(INITIAL_CWD);
  await unlink(CONFIG_FILE);
  await unlink(join(NATIVE_DIR, "manifest.json"));
  await unlink(artifact.path);
  await rmdir(CONFIG_DIR);
  await rmdir(NATIVE_DIR);
  // Its parent is outside the child write grants; the worker removes this empty root after exit.
  console.info("m09-supervisor-fixture:", CONFINED_CWD);
});

/* --------------------------------------------------- inventory: projections */

test("quotaFromRateLimits falls back to the account-wide bucket when no per-limit map exists", () => {
  const quota = quotaFromRateLimits({ rateLimits: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_790_000_000 } } });
  assert.ok(quota, "a single account-wide bucket must still be reported");
  assert.equal(quota.accountScope, "shared_codex_account");
  assert.equal(quota.resetCreditsAvailable, null, "an absent credit count stays unknown rather than zero");
  assert.deepEqual(quota.buckets, [
    {
      limitId: "codex",
      limitName: null,
      usedPercent: 12,
      windowDurationMins: 300,
      resetsAtMs: 1_790_000_000_000,
      planType: null,
      reachedType: null,
    },
  ]);
});

test("quotaFromRateLimits ignores non-object buckets and prefers explicit bucket fields over the legacy primary window", () => {
  const quota = quotaFromRateLimits({
    rateLimits: { limitId: "codex" },
    rateLimitsByLimitId: {
      codex: { limitId: "codex", usedPercent: 41, windowDurationMins: 60, resetsAt: 1_790_000_100, planType: "pro", rateLimitReachedType: "primary" },
      gpt6: "not-a-bucket",
      broken: null,
    },
  });
  assert.ok(quota);
  assert.deepEqual(
    quota.buckets.map((bucket) => bucket.limitId),
    ["codex"],
    "a bucket whose entry is not an object is dropped instead of fabricated"
  );
  assert.equal(quota.buckets[0].usedPercent, 41);
  assert.equal(quota.buckets[0].planType, "pro");
  assert.equal(quota.buckets[0].reachedType, "primary");
});

test("quotaFromRateLimits reads the fallback bucket fields from the nested primary window", () => {
  const quota = quotaFromRateLimits({ rateLimits: { limitId: null, primary: { usedPercent: 7, windowDurationMins: 5, resetsAt: 1_790_000_200 } } });
  assert.ok(quota);
  assert.deepEqual(quota.buckets[0], {
    limitId: "codex",
    limitName: null,
    usedPercent: 7,
    windowDurationMins: 5,
    resetsAtMs: 1_790_000_200_000,
    planType: null,
    reachedType: null,
  });
});

test("newestTurnOf reports only a well-formed turn record", () => {
  assert.equal(newestTurnOf(null), null);
  assert.equal(newestTurnOf({ data: "not-an-array" }), null);
  assert.equal(newestTurnOf({ data: [null] }), null);
  assert.deepEqual(newestTurnOf({ data: [{ id: "turn-1", status: "inProgress", items: [{ type: "agentMessage" }] }] }), {
    id: "turn-1",
    status: "inProgress",
    items: [{ type: "agentMessage" }],
  });
  assert.equal(newestTurnOf({ data: [7, { id: "turn-2", status: null }] }), null, "only the newest record is read, so a non-record head means no turn");
});

test("classifySupervisorState and sessionFromParts keep a source that answered nothing honestly unknown", () => {
  assert.equal(classifySupervisorState({ runtimeStatus: null, turnStatus: null, loaded: false }), "unknown");
  const source: SupervisorSource = { id: "local", name: "This Mac", socketPath: "/var/lib/uos-supervisor/local.sock", codexHome: "/home/tester/.codex" };
  const session = sessionFromParts({
    id: "01a0bd67-no-probe",
    source,
    metadata: null,
    listed: null,
    probe: null,
    loaded: false,
    sampledAtMs: 1_790_000_000_000,
    childIds: null,
    unavailable: ["live status not sampled in this pass"],
  });
  assert.equal(session.state, "unknown");
  assert.equal(session.sampled, false);
  assert.equal(session.childIds, null);
  assert.equal(session.title, null);
  assert.equal(session.titleSource, null);
  assert.equal(session.tokensUsed, null);
  assert.equal(session.usageSource, null);
  assert.deepEqual(session.activeFlags, []);
  assert.deepEqual(session.unavailable, ["live status not sampled in this pass"]);
});

/* ----------------------------------------------- inventory: snapshot assembly */

test("ensureSupervisorSnapshot reports an empty inventory when no source can be resolved and caches the single sampling round", async () => {
  // The kernel denies the existing configuration file and the sparse profile omits
  // HOME/CODEX_HOME: the honest
  // result is zero sources and zero sessions, never an invented local source.
  const [first, concurrent] = await Promise.all([ensureSupervisorSnapshot(), ensureSupervisorSnapshot()]);
  assert.equal(first, concurrent, "two polls that overlap must share one sampling round");
  assert.equal(first.view, "codex_app_server_read_only");
  assert.deepEqual(first.sources, []);
  assert.deepEqual(first.sessions, []);
  assert.deepEqual(first.counts, { total: 0, active: 0, waiting: 0, idle: 0, stale: 0, unknown: 0, systemError: 0 });
  assert.deepEqual(first.coverage, { listed: 0, sampled: 0, truncated: false, notes: first.coverage.notes });
  assert.ok(first.coverage.notes.length >= 1, "an empty inventory must explain why it is empty");
  assert.ok(
    first.coverage.notes.some((note) => note.includes("codex-supervisor.json")),
    "the missing configuration file must be reported as a note"
  );

  const cached = await ensureSupervisorSnapshot();
  assert.equal(cached, first, "a snapshot inside the short TTL is reused rather than resampled");
  assert.equal(cached.sampledAtMs, first.sampledAtMs);
});

/* ------------------------------------------------------- supervisor-config */

test("uniqueStrings keeps first-seen order and readHostname never invents a hostname", () => {
  assert.deepEqual(uniqueStrings(["b", "a", "b", "c", "a"]), ["b", "a", "c"]);
  assert.deepEqual(uniqueStrings([]), []);
  // Bun exposes the actual OS hostname independently of filesystem confinement.
  assert.equal(readHostname(), hostname(), "the available hostname is reported without invention");
  assert.equal(boundedText("short", 10), "short");
  assert.equal(boundedText("0123456789", 5), "01234…");
});

test("waitForPoll resolves on its own deadline and immediately on abort", async () => {
  const startedAt = performance.now();
  await waitForPoll(25, new AbortController().signal);
  assert.ok(performance.now() - startedAt >= 20, "an unaborted poll waits for its deadline");

  const controller = new AbortController();
  const abortedStart = performance.now();
  const pending = waitForPoll(5_000, controller.signal);
  controller.abort();
  await pending;
  assert.ok(performance.now() - abortedStart < 1_000, "an aborted poll must not wait out its deadline");
});

test("mapWithConcurrency preserves result order and never exceeds its concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return item * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2, "the worker pool must stay at its limit");
  assert.deepEqual(await mapWithConcurrency([], 4, () => Promise.resolve("unused")), []);
});

test("parseSupervisorConfig names every reason a source was ignored", () => {
  const longName = "n".repeat(65);
  const parsed = parseSupervisorConfig({
    sources: [
      "not-an-object",
      { id: "Local", name: "Uppercase id", socketPath: "/var/lib/uos-supervisor/a.sock" },
      { id: "long-name", name: longName, socketPath: "/var/lib/uos-supervisor/b.sock" },
      { id: "relative-home", name: "Relative home", socketPath: "/var/lib/uos-supervisor/c.sock", codexHome: "relative/.codex" },
      { id: "kept", name: "Kept", socketPath: "/var/lib/uos-supervisor/d.sock" },
    ],
  });
  assert.deepEqual(
    parsed.sources.map((source) => source.id),
    ["kept"]
  );
  assert.ok(parsed.notes.some((note) => note === "ignored a source that is not an object"));
  assert.ok(parsed.notes.some((note) => note.includes("name must be 1-64 characters")));
  assert.ok(parsed.notes.some((note) => note.includes("codexHome must be an absolute path")));
  assert.ok(parsed.notes.some((note) => note.includes("socketPath must be an absolute path") || note.includes("id must match")));
});

test("parseSupervisorConfig caps the usable source list and says so", () => {
  const sources = Array.from({ length: 9 }, (_value, index) => ({
    id: `source-${index}`,
    name: `Source ${index}`,
    socketPath: `/var/lib/uos-supervisor/source-${index}.sock`,
  }));
  const parsed = parseSupervisorConfig({ sources });
  assert.equal(parsed.sources.length, 8);
  assert.equal(parsed.sources.at(-1)?.id, "source-7");
  assert.ok(parsed.notes.includes("only the first 8 sources are used"));
});

test("resolveSupervisorConfig falls back to the local source and reports an unreadable configuration", async () => {
  const missing = await resolveSupervisorConfig({ cwd: CONFINED_CWD, env: () => undefined });
  assert.equal(missing.configLoaded, false);
  assert.deepEqual(missing.sources, [], "no environment and no config file means no source at all");
  assert.ok(missing.notes.some((note) => note.includes(".data/codex-supervisor.json could not be read")));
  assert.ok(missing.notes.some((note) => note.includes("HOME and CODEX_HOME are both unavailable")));
  assert.ok(missing.configPath.endsWith(".data/codex-supervisor.json"));

  const fromHome = await resolveSupervisorConfig({
    cwd: CONFINED_CWD,
    env: (name) => (name === "HOME" ? "/home/tester/" : undefined),
  });
  assert.deepEqual(fromHome.sources, [
    {
      id: "local",
      name: "Local Codex",
      socketPath: "/home/tester/.codex/app-server-control/app-server-control.sock",
      codexHome: "/home/tester/.codex",
    },
  ]);
  assert.equal(fromHome.configLoaded, false);

  const fromCodexHome = await resolveSupervisorConfig({
    cwd: CONFINED_CWD,
    env: (name) => (name === "CODEX_HOME" ? "/custom/codex" : "/home/tester"),
  });
  assert.equal(fromCodexHome.sources[0]?.codexHome, "/custom/codex");
  assert.equal(fromCodexHome.sources[0]?.socketPath, "/custom/codex/app-server-control/app-server-control.sock");
});

/* ---------------------------------------------------- supervisor-transport */

type RpcFrame = { id?: unknown; method?: unknown; params?: unknown };
type RpcResponder = (method: string, params: Record<string, unknown>, frame: RpcFrame) => unknown;
type SocketListener = (...args: unknown[]) => void;
type ListenerEntry = { listener: SocketListener; once: boolean };

/** Defer the reply so a test can deliver the frame itself. */
const DEFER = Symbol("defer");

/**
 * Minimal structural stand-in for the `ws` client: it opens on a microtask and
 * answers JSON-RPC requests from a queued script, so the transport can be driven
 * end to end without a live socket.
 */
class ScriptedSocket {
  static readonly created: ScriptedSocket[] = [];
  private static readonly _plans: RpcResponder[] = [];
  readonly frames: RpcFrame[] = [];
  readonly url: string;
  readonly options: unknown;
  readyState = 1;
  terminated = false;
  closeFrame: { code: number | undefined; reason: string | undefined } | null = null;
  closeThrows = false;
  sendThrows = false;
  private readonly _responders: RpcResponder;
  private readonly _listeners = new Map<string, ListenerEntry[]>();

  constructor(url: string, options?: unknown) {
    this.url = url;
    this.options = options;
    this._responders = ScriptedSocket._plans.shift() ?? (() => ({}));
    ScriptedSocket.created.push(this);
    queueMicrotask(() => {
      this.emit("open");
    });
  }

  static plan(responder: RpcResponder): void {
    ScriptedSocket._plans.push(responder);
  }

  static latest(): ScriptedSocket {
    const socket = ScriptedSocket.created.at(-1);
    assert.ok(socket, "the transport must construct a socket");
    return socket;
  }

  static reset(): void {
    ScriptedSocket.created.length = 0;
    ScriptedSocket._plans.length = 0;
  }

  on(event: string, listener: SocketListener): this {
    this.#add(event, listener, false);
    return this;
  }

  once(event: string, listener: SocketListener): this {
    this.#add(event, listener, true);
    return this;
  }

  send(data: string): void {
    if (this.sendThrows) throw new Error("socket is gone");
    const frame = JSON.parse(data) as RpcFrame;
    this.frames.push(frame);
    if (typeof frame.id !== "number" || typeof frame.method !== "string") return;
    const reply = this._responders(frame.method, (frame.params ?? {}) as Record<string, unknown>, frame);
    if (reply === DEFER) return;
    queueMicrotask(() => {
      this.#reply(frame.id as number, reply);
    });
  }

  close(code?: number, reason?: string): void {
    if (this.closeThrows) throw new Error("close failed");
    this.closeFrame = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  emit(event: string, ...args: unknown[]): void {
    const entries = this._listeners.get(event) ?? [];
    const remaining: ListenerEntry[] = [];
    for (const entry of entries) {
      entry.listener(...args);
      if (!entry.once) remaining.push(entry);
    }
    this._listeners.set(event, remaining);
  }

  /** Delivers one websocket message frame exactly as the `ws` client would. */
  emitMessage(payload: unknown): void {
    this.emit("message", payload);
  }

  #reply(id: number, reply: unknown): void {
    if (this.terminated) return;
    const text = reply instanceof Error ? JSON.stringify({ id, error: { message: reply.message } }) : JSON.stringify({ id, result: reply });
    this.emitMessage(new TextEncoder().encode(text));
  }

  #add(event: string, listener: SocketListener, once: boolean): void {
    const entries = this._listeners.get(event) ?? [];
    entries.push({ listener, once });
    this._listeners.set(event, entries);
  }
}

const withScriptedSockets = async (run: () => Promise<void>): Promise<void> => {
  ScriptedSocket.reset();
  setSupervisorWebSocketConstructorForTest(ScriptedSocket as unknown);
  try {
    await run();
  } finally {
    setSupervisorWebSocketConstructorForTest(null);
    ScriptedSocket.reset();
  }
};

const deferredSignal = (): AbortSignal => new AbortController().signal;

test("the transport handshakes, targets the configured socket and resolves read-only calls", async () => {
  await withScriptedSockets(async () => {
    const responder: RpcResponder = (method) => {
      if (method === "thread/read") return { thread: { id: "thread-1", name: "Covered" } };
      return {};
    };
    ScriptedSocket.plan(responder);
    const connection = await openSupervisorConnection("/var/lib/uos-supervisor/scripted.sock");
    const socket = ScriptedSocket.latest();
    assert.equal(socket.url, "ws+unix:///var/lib/uos-supervisor/scripted.sock:/");
    assert.deepEqual(socket.options, {
      headers: { Host: "localhost" },
      perMessageDeflate: false,
      maxPayload: 1_048_576,
      handshakeTimeout: 3_000,
    });

    const result = await connection.call("thread/read", { threadId: "thread-1" }, deferredSignal());
    assert.deepEqual(result, { thread: { id: "thread-1", name: "Covered" } });
    assert.deepEqual(
      socket.frames.map((frame) => frame.method),
      ["initialize", "initialized", "thread/read"],
      "only the handshake and the requested read method are ever sent"
    );
    assert.deepEqual(socket.frames[0]?.params, { clientInfo: { name: "uos_supervisor", version: "1" }, capabilities: { experimentalApi: true } });
    const sentCount = socket.frames.length;

    type CallMethod = Parameters<SupervisorConnection["call"]>[0];
    const callWithMethod = (method: string): Promise<unknown> => connection.call(method as CallMethod, { threadId: "thread-1" });
    await assert.rejects(callWithMethod("thread/archive"), /refused a non-read-only method/);
    assert.equal(socket.frames.length, sentCount, "a refused method must never reach the socket");
    await connection.close();
  });
});

test("the transport closes cleanly: close frame, termination, failed pending calls and a no-op second close", async () => {
  await withScriptedSockets(async () => {
    ScriptedSocket.plan((method) => (method === "initialize" ? {} : DEFER));
    const connection = await openSupervisorConnection("/var/lib/uos-supervisor/closing.sock");
    const socket = ScriptedSocket.latest();
    const pending = connection.call("thread/read", { threadId: "thread-1" }, deferredSignal());
    const rejected = assert.rejects(pending, /app-server connection closed/);
    await connection.close();
    await rejected;
    assert.deepEqual(socket.closeFrame, { code: 1000, reason: "supervisor sample complete" });
    assert.equal(socket.terminated, true, "the grace period must end in a terminated socket");

    const framesAfterClose = socket.frames.length;
    await connection.close();
    assert.equal(socket.frames.length, framesAfterClose, "a second close must not send anything");
  });
});

test("a close whose frame fails is still terminated", async () => {
  await withScriptedSockets(async () => {
    ScriptedSocket.plan(() => ({}));
    const connection = await openSupervisorConnection("/var/lib/uos-supervisor/close-throws.sock");
    const socket = ScriptedSocket.latest();
    socket.closeThrows = true;
    await connection.close();
    assert.equal(socket.terminated, true, "the close frame is best effort, not the guarantee");
  });
});

test("a socket that already reported itself closed is not closed twice", async () => {
  await withScriptedSockets(async () => {
    ScriptedSocket.plan(() => ({}));
    const connection = await openSupervisorConnection("/var/lib/uos-supervisor/already-closed.sock");
    const socket = ScriptedSocket.latest();
    socket.readyState = 3;
    await connection.close();
    assert.equal(socket.closeFrame, null, "no close frame is sent to a socket that is already closed");
    assert.equal(socket.terminated, false);
  });
});

test("calls fail fast on a closed socket, an aborted signal and a send failure", async () => {
  await withScriptedSockets(async () => {
    ScriptedSocket.plan(() => ({}));
    const connection = await openSupervisorConnection("/var/lib/uos-supervisor/fail-fast.sock");
    const socket = ScriptedSocket.latest();

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(connection.call("thread/read", { threadId: "thread-1" }, controller.signal), /app-server call aborted/);

    const pending = connection.call("thread/read", { threadId: "thread-1" }, deferredSignal());
    socket.emit("error");
    await assert.rejects(pending, /app-server connection failed/);

    socket.sendThrows = true;
    await assert.rejects(connection.call("thread/read", { threadId: "thread-1" }, deferredSignal()), /app-server send failed/);
    socket.sendThrows = false;

    socket.readyState = 3;
    await assert.rejects(connection.call("thread/read", { threadId: "thread-1" }, deferredSignal()), /app-server connection unavailable/);
  });
});

test("an aborted call signal rejects the exact pending call", async () => {
  await withScriptedSockets(async () => {
    ScriptedSocket.plan((method) => (method === "initialize" ? {} : DEFER));
    const connection = await openSupervisorConnection("/var/lib/uos-supervisor/abort-pending.sock");
    const controller = new AbortController();
    const pending = connection.call("thread/read", { threadId: "thread-1" }, controller.signal);
    controller.abort();
    await assert.rejects(pending, /app-server call aborted/);
  });
});

test("an aborted sampling signal never opens a socket", async () => {
  await withScriptedSockets(async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(openSupervisorConnection("/var/lib/uos-supervisor/never.sock", controller.signal), /app-server connection aborted/);
    assert.equal(ScriptedSocket.created.length, 0, "no socket is constructed for an aborted attempt");
  });
});

test("message frames are decoded as text, bytes or multipart arrays and malformed frames are ignored", async () => {
  await withScriptedSockets(async () => {
    ScriptedSocket.plan((method) => (method === "initialize" ? {} : DEFER));
    const connection = await openSupervisorConnection("/var/lib/uos-supervisor/frames.sock");
    const socket = ScriptedSocket.latest();
    const pending = connection.call("thread/read", { threadId: "thread-1" }, deferredSignal());
    const requestId = socket.frames.at(-1)?.id;
    assert.equal(typeof requestId, "number");

    socket.emitMessage(7);
    socket.emitMessage("not json at all");
    socket.emitMessage(JSON.stringify("a string, not an object"));
    socket.emitMessage(JSON.stringify({ id: 99_999, result: "unknown call" }));
    socket.emitMessage(JSON.stringify({ id: "not-a-number", result: "bad id" }));
    socket.emitMessage(new TextEncoder().encode(JSON.stringify({ id: requestId, result: { thread: { id: "thread-1" } } })));
    assert.deepEqual(await pending, { thread: { id: "thread-1" } }, "a byte payload carrying a valid reply resolves the call");

    const multipart = connection.call("thread/turns/list", { threadId: "thread-1" }, deferredSignal());
    const multipartId = socket.frames.at(-1)?.id;
    assert.equal(typeof multipartId, "number", "the multipart request must carry a numeric id");
    const multipartFrame = JSON.stringify({ id: multipartId, result: ["ok"] });
    const half = Math.floor(multipartFrame.length / 2);
    socket.emitMessage([multipartFrame.slice(0, half), multipartFrame.slice(half)]);
    assert.deepEqual(await multipart, ["ok"], "a Buffer[] payload is concatenated before decoding");
  });
});

test("an error frame rejects the pending call with the bounded upstream message", async () => {
  await withScriptedSockets(async () => {
    ScriptedSocket.plan((method) => (method === "initialize" ? {} : DEFER));
    const connection = await openSupervisorConnection("/var/lib/uos-supervisor/errors.sock");
    const socket = ScriptedSocket.latest();

    const described = connection.call("thread/read", { threadId: "thread-1" }, deferredSignal());
    socket.emitMessage(JSON.stringify({ id: socket.frames.at(-1)?.id, error: { message: "x".repeat(500) } }));
    await assert.rejects(described, (error: Error) => {
      assert.equal(error.message.length, 400, "an upstream message is bounded before it reaches a caller");
      return true;
    });

    const undescribed = connection.call("thread/read", { threadId: "thread-1" }, deferredSignal());
    socket.emitMessage(JSON.stringify({ id: socket.frames.at(-1)?.id, error: { code: -32_000 } }));
    await assert.rejects(undescribed, /app-server returned an error/);
  });
});
/* ---------------------------------------------------- supervisor-brief */

test("collectSupervisorBriefContext reads one redacted transcript through the read-only allowlist", async () => {
  await withScriptedSockets(async () => {
    const thread = {
      id: "thread-1",
      name: "Coverage work",
      cwd: "/repo",
      model: "gpt-6-astra",
      modelProvider: "uos",
      reasoningEffort: "high",
      status: { type: "active", activeFlags: ["waitingOnApproval", 7] },
      updatedAt: 1_790_001_000,
      path: "/rollout.jsonl",
    };
    ScriptedSocket.plan((method, params) => {
      if (method === "thread/read") return { thread };
      if (method !== "thread/turns/list") return {};
      if (params.itemsView === "summary" && params.sortDirection === "asc") {
        return {
          data: [
            {
              id: "turn-1",
              status: "completed",
              startedAt: 1_790_000_000,
              completedAt: 1_790_000_100,
              items: [
                { type: "userMessage", content: [{ type: "text", text: "opening request" }, { type: "image", url: "ignored" }, null, 7] },
                { type: "mcpToolCall", name: "search", status: "completed" },
                { type: "mcpToolCall", server: "filesystem" },
                { type: "fileChange" },
              ],
            },
          ],
        };
      }
      return { data: [{ id: "turn-2", status: "inProgress", startedAt: 1_790_000_500, items: [{ type: "agentMessage", text: "recent progress" }] }] };
    });

    const source: SupervisorSource = { id: "vps", name: "vps.pavelcik.com", socketPath: "/var/lib/uos-supervisor/brief.sock", codexHome: null };
    const context = await collectSupervisorBriefContext(source, "thread-1", deferredSignal());
    assert.equal(context.sourceId, "vps");
    assert.equal(context.machine, "vps.pavelcik.com");
    assert.equal(context.threadId, "thread-1");
    assert.equal(context.title, "Coverage work");
    assert.equal(context.cwd, "/repo");
    assert.equal(context.model, "gpt-6-astra");
    assert.equal(context.provider, "uos");
    assert.equal(context.effort, "high");
    assert.equal(context.state, "active");
    assert.deepEqual(context.activeFlags, ["waitingOnApproval"], "non-string active flags are dropped");
    assert.equal(context.updatedAtMs, 1_790_001_000_000);
    assert.equal(context.rolloutPath, "/rollout.jsonl");
    assert.deepEqual(
      context.turns.map((turn) => turn.id),
      ["turn-1", "turn-2"],
      "page order alone produces a chronological transcript"
    );
    assert.equal(context.transcriptAvailable, true);
    assert.equal(context.truncated, false);
    assert.equal(context.rolloutTailEvents, 0, "a source without a local codex home has no rollout tail");
    assert.equal(context.projectedHistoryBehindMs, 500_000, "the fresh metadata leads the projected history by the recorded gap");

    const prompt = buildSupervisorBriefPrompt(context);
    assert.match(prompt, /opening request/);
    assert.match(prompt, /mcpToolCall search completed/);
    assert.match(prompt, /mcpToolCall filesystem/, "a tool item without a name falls back to its server");
    assert.match(prompt, /recent progress/);
    assert.match(prompt, /runtime_state=active/);
    assert.match(prompt, /active_flags=waitingOnApproval/);
    assert.doesNotMatch(prompt, /ignored/, "non-text user-message parts never reach the prompt");
  });
});

test("collectSupervisorBriefContext tolerates unusable pages and skips malformed turns and items", async () => {
  await withScriptedSockets(async () => {
    ScriptedSocket.plan((method, params) => {
      if (method === "thread/read") return { thread: { id: "thread-1", status: { type: "idle" } } };
      if (method !== "thread/turns/list") return {};
      if (params.itemsView === "summary" && params.sortDirection === "asc") return { data: "not-an-array" };
      if (params.sortDirection === "desc" && params.itemsView === "summary") {
        return {
          data: [
            "not-a-turn",
            { status: "completed", items: [{ type: "agentMessage", text: "no id, ignored" }] },
            {
              id: "turn-2",
              status: "inProgress",
              items: [
                null,
                { type: "reasoning", text: "private" },
                { type: "agentMessage", text: 7 },
                { type: "agentMessage", text: "visible agent message" },
                { type: "commandExecution", command: null, status: null, exitCode: "1", aggregatedOutput: "out" },
              ],
            },
          ],
        };
      }
      return { data: [] };
    });

    const source: SupervisorSource = { id: "vps", name: "vps", socketPath: "/var/lib/uos-supervisor/malformed.sock", codexHome: null };
    const context = await collectSupervisorBriefContext(source, "thread-1", deferredSignal());
    assert.deepEqual(
      context.turns.map((turn) => turn.id),
      ["turn-2"],
      "a page without an array, a turn without an id and non-record items are skipped"
    );
    assert.equal(context.transcriptAvailable, true);
    const prompt = buildSupervisorBriefPrompt(context);
    assert.match(prompt, /visible agent message/);
    assert.match(prompt, /\(command unavailable\) \[recorded\]\nout/, "a command without a recorded command or status stays explicit");
    assert.doesNotMatch(prompt, /no id, ignored/);
    assert.doesNotMatch(prompt, /private/);
  });
});

test("assembleBriefContext spends the budget newest-first, drops content-free turns and reports truncation", () => {
  const item = (text: string) => ({ type: "assistant", text });
  const turnOf = (id: string, items: { type: string; text: string }[], extra: { droppedItems?: number; startedAtMs?: number } = {}) => ({
    id,
    status: "completed",
    startedAtMs: extra.startedAtMs ?? 1_790_000_000,
    completedAtMs: null,
    items,
    droppedItems: extra.droppedItems ?? 0,
  });

  // Recent turns are allocated newest-first, so the newest progress keeps the
  // budget and the opening turn is dropped once the remaining budget is smaller
  // than a single bounded item.
  const heavy = (id: string, startedAtMs: number) =>
    turnOf(
      id,
      Array.from({ length: 12 }, () => item("h".repeat(1_200))),
      { startedAtMs }
    );
  const assembled = assembleBriefContext([
    heavy("turn-opening", 1_790_000_000),
    heavy("turn-recent-3", 1_790_000_300),
    heavy("turn-recent-2", 1_790_000_600),
    heavy("turn-recent-1", 1_790_000_900),
  ]);
  assert.deepEqual(
    assembled.turns.map((turn) => turn.id),
    ["turn-recent-3", "turn-recent-2", "turn-recent-1"],
    "the newest turns keep the budget and the opening turn is omitted rather than half-kept"
  );
  const partial = assembled.turns[0];
  assert.ok(partial.items.length > 0 && partial.items.length < 12, "a turn is kept only with the items that still fit");
  assert.equal(assembled.truncated, true);
  assert.equal(assembled.transcriptAvailable, true);
  assert.ok(assembled.contextBytes <= 32 * 1024, "the assembled context stays inside its byte budget");

  const flagged = assembleBriefContext([turnOf("turn-a", [item("kept")], { droppedItems: 3 })]);
  assert.equal(flagged.truncated, true, "item-limit drops recorded upstream still mark the brief truncated");

  const contentFree = assembleBriefContext([turnOf("turn-empty", [])]);
  assert.deepEqual(contentFree.turns, [], "a turn with no items contributes nothing");
  assert.equal(contentFree.transcriptAvailable, false);
  assert.equal(contentFree.truncated, true, "an omitted turn still marks the transcript as incomplete");

  const redaction = assembleBriefContext([turnOf("turn-secret", [item("token=Bearer abcdefghijklmnop"), item("second")])]);
  assert.equal(redaction.redactions, 2, "both credential-shaped spans (the bearer value and the token assignment) are counted");
  assert.ok(redaction.turns.length === 1);
  assert.doesNotMatch(redaction.turns[0]?.items.map((entry) => entry.text).join("\n") ?? "", /abcdefghijklmnop/);
});

test("appendRolloutTailTurn drops stale, duplicate and empty events and keeps the newest items", () => {
  const turns = [
    {
      id: "turn-1",
      status: "completed",
      startedAtMs: 1_000,
      completedAtMs: 2_000,
      items: [{ type: "assistant", text: "known text" }],
      droppedItems: 0,
    },
  ];
  const events = [
    { atMs: 1_500, kind: "assistant" as const, text: "stale event" },
    { atMs: 2_100, kind: "assistant" as const, text: "known text" },
    { atMs: 2_200, kind: "assistant" as const, text: "   " },
    { atMs: 2_300, kind: "tool" as const, text: "t".repeat(500) },
    { atMs: 2_400, kind: "assistant" as const, text: "x".repeat(1_300) },
  ];
  const next = appendRolloutTailTurn(turns, { threadId: "thread-1", state: "inProgress", events });
  assert.equal(next.length, 2);
  const tail = next[1];
  assert.ok(tail.freshTail);
  assert.equal(tail.id, "rollout-tail:thread-1");
  assert.equal(tail.status, "inProgress");
  assert.equal(tail.startedAtMs, 2_300);
  assert.equal(tail.completedAtMs, 2_400);
  assert.equal(tail.droppedItems, 2, "a duplicate and a blank-after-trim event are counted while the stale event is skipped");
  assert.deepEqual(
    tail.items.map((entry) => entry.type),
    ["tool", "assistant"]
  );
  assert.equal(tail.items[0].text.length, 400, "a tool tail item is bounded to its own smaller limit");
  assert.ok(tail.items[0].text.endsWith("…"));
  assert.equal(tail.items[1].text.length, 1_200);
  assert.ok(tail.items[1].text.endsWith("…"));

  const allStale = appendRolloutTailTurn(turns, { threadId: "thread-1", state: null, events: [{ atMs: 500, kind: "assistant", text: "old" }] });
  assert.deepEqual(allStale, turns, "events older than the projected history never create a tail turn");

  const many = Array.from({ length: 14 }, (_value, index) => ({ atMs: 2_500 + index, kind: "assistant" as const, text: `event ${index}` }));
  const capped = appendRolloutTailTurn(turns, { threadId: "thread-1", state: null, events: many });
  const cappedTail = capped[1];
  assert.equal(cappedTail.items.length, 12, "the tail turn keeps at most one per-turn item budget");
  assert.equal(cappedTail.items[0].text, "event 2");
  assert.equal(cappedTail.items.at(-1)?.text, "event 13", "the newest events win the cap");
  assert.equal(cappedTail.droppedItems, 2);
});

test("parseSupervisorBriefOutput accepts only a usable two-field JSON object", () => {
  assert.deepEqual(parseSupervisorBriefOutput('{"about":"a","status":"b"}'), { about: "a", status: "b" });
  assert.deepEqual(parseSupervisorBriefOutput('```json\n{"about":"a","status":"b"}\n```'), { about: "a", status: "b" });
  assert.deepEqual(parseSupervisorBriefOutput('{"about":"  spaced \\n out ","status":"ok"}'), { about: "spaced out", status: "ok" });
  const bounded = parseSupervisorBriefOutput(JSON.stringify({ about: "a".repeat(1_300), status: "ok" }));
  assert.ok(bounded);
  assert.equal(bounded.about.length, 1_200);
  assert.ok(bounded.about.endsWith("…"));
  assert.equal(parseSupervisorBriefOutput("not json"), null);
  assert.equal(parseSupervisorBriefOutput("[1,2]"), null);
  assert.equal(parseSupervisorBriefOutput('{"about":"a"}'), null);
  assert.equal(parseSupervisorBriefOutput('{"about":"   ","status":"b"}'), null);
  assert.equal(parseSupervisorBriefOutput(null), null);
  assert.equal(parseSupervisorBriefOutput(""), null);
});

test("buildSupervisorBriefRequestBody bounds the prompt, names unavailable metadata and keeps the model contract", () => {
  const emptyContext: SupervisorBriefContext = {
    sourceId: "vps",
    machine: "vps.pavelcik.com",
    threadId: "thread-1",
    title: null,
    cwd: null,
    model: null,
    provider: null,
    effort: null,
    state: null,
    activeFlags: [],
    updatedAtMs: null,
    rolloutPath: null,
    turns: [],
    transcriptAvailable: false,
    truncated: false,
    redactions: 0,
    contextBytes: 0,
    rolloutTailEvents: 0,
    projectedHistoryBehindMs: null,
  };
  const prompt = buildSupervisorBriefPrompt(emptyContext);
  assert.match(prompt, /\(no recorded turns were available\)/);
  assert.match(prompt, /title=unavailable/);
  assert.match(prompt, /runtime_state=unavailable/);
  assert.match(prompt, /active_flags=none/);
  assert.match(prompt, /projected_history_behind_ms=unknown/);
  const body = buildSupervisorBriefRequestBody(emptyContext);
  assert.equal(body.stream, false);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.model, "gpt-oss-120b");
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.max_completion_tokens, 4_096);
  const messages = body.messages as { role: string; content: string }[];
  assert.deepEqual(
    messages.map((message) => message.role),
    ["system", "user"]
  );
  assert.equal(messages[1].content, prompt);

  const huge: SupervisorBriefContext = {
    ...emptyContext,
    transcriptAvailable: true,
    turns: Array.from({ length: 40 }, (_value, index) => ({
      id: `turn-${index}`,
      status: "completed",
      startedAtMs: 1_790_000_000,
      completedAtMs: null,
      items: Array.from({ length: 12 }, () => ({ type: "assistant", text: "y".repeat(1_200) })),
      droppedItems: 0,
      freshTail: index === 0,
    })),
  };
  const hugeBody = buildSupervisorBriefRequestBody(huge);
  const hugeMessages = hugeBody.messages as { role: string; content: string }[];
  assert.equal(hugeMessages[1].content.length, 48 * 1024, "the prompt is bounded before it is sent");
  assert.ok(hugeMessages[1].content.endsWith("…"));
});

test("handleAdminCodexSupervisorBrief validates the request body and refuses an unknown source", async () => {
  const send = (body: string): Promise<Response> =>
    handleAdminCodexSupervisorBrief(
      new Request("https://ai.ubq.fi/admin/codex/supervisor/brief", { method: "POST", body, headers: { "Content-Type": "application/json" } })
    );

  const notJson = await send("not json");
  assert.equal(notJson.status, 400);
  assert.equal(((await notJson.json()) as { error: { message: string } }).error.message, "Expected a JSON body with source and id");

  const noSource = await send("{}");
  assert.equal(noSource.status, 400);
  assert.equal(((await noSource.json()) as { error: { message: string } }).error.message, "Invalid supervisor source id");

  const badThread = await send(JSON.stringify({ source: "local", id: "bad id!" }));
  assert.equal(badThread.status, 400);
  assert.equal(((await badThread.json()) as { error: { message: string } }).error.message, "Invalid thread id");

  const unknownSource = await send(JSON.stringify({ source: "local", id: "01a0c7ae-5be8-7712-aaee-26638cf84a32" }));
  assert.equal(unknownSource.status, 400);
  assert.equal(((await unknownSource.json()) as { error: { message: string } }).error.message, "Unknown supervisor source");
});

test("a repeated opening turn is merged and an empty newest turn is enriched from the single frame-safe full read", async () => {
  await withScriptedSockets(async () => {
    const thread = { id: "thread-1", name: "Enrichment", updatedAt: 1_790_001_500 };
    const fullRequests: Record<string, unknown>[] = [];
    ScriptedSocket.plan((method, params) => {
      if (method === "thread/read") return { thread };
      if (method !== "thread/turns/list") return {};
      if (params.itemsView === "full") {
        fullRequests.push(params);
        return { data: [{ id: "turn-3", status: "inProgress", startedAt: 1_790_001_000, items: [{ type: "agentMessage", text: "newest full content" }] }] };
      }
      if (params.sortDirection === "asc") {
        return {
          data: [
            {
              id: "turn-1",
              status: "completed",
              startedAt: 1_790_000_000,
              completedAt: 1_790_000_100,
              items: [{ type: "userMessage", content: [{ type: "text", text: "opening request" }] }],
            },
          ],
        };
      }
      return {
        data: [
          { id: "turn-3", status: "inProgress", startedAt: 1_790_001_000, items: [] },
          {
            id: "turn-2",
            status: "completed",
            startedAt: 1_790_000_500,
            completedAt: 1_790_000_600,
            items: [{ type: "agentMessage", text: "middle progress" }],
          },
          {
            id: "turn-1",
            status: "completed",
            startedAt: 1_790_000_000,
            completedAt: 1_790_000_100,
            items: [{ type: "agentMessage", text: "opening tail" }],
          },
        ],
      };
    });

    const source: SupervisorSource = { id: "vps", name: "vps", socketPath: "/var/lib/uos-supervisor/enrich.sock", codexHome: null };
    const context = await collectSupervisorBriefContext(source, "thread-1", deferredSignal());
    assert.deepEqual(
      context.turns.map((turn) => turn.id),
      ["turn-1", "turn-2", "turn-3"],
      "the repeated opening turn is merged in place and the chronological order is preserved"
    );
    const opening = context.turns.find((turn) => turn.id === "turn-1");
    const newest = context.turns.find((turn) => turn.id === "turn-3");
    assert.ok(opening && newest);
    assert.deepEqual(
      opening.items.map((item) => item.text),
      ["opening request", "opening tail"],
      "the merged opening turn keeps its request and its newest recorded tail"
    );
    assert.deepEqual(
      newest.items.map((item) => item.text),
      ["newest full content"],
      "the empty newest turn is replaced by the one permitted full read"
    );
    assert.equal(fullRequests.length, 1, "exactly one full-view read is issued");
    assert.equal(fullRequests[0].sortDirection, "desc");
    assert.equal(fullRequests[0].limit, 1);
  });

  await withScriptedSockets(async () => {
    ScriptedSocket.plan((method, params) => {
      if (method === "thread/read") return { thread: { id: "thread-1", status: { type: "active" } } };
      if (method !== "thread/turns/list") return {};
      if (params.itemsView === "full") return new Error("app-server connection failed");
      if (params.sortDirection === "asc") return { data: [] };
      return { data: [{ id: "turn-9", status: "inProgress", items: [] }] };
    });
    const source: SupervisorSource = { id: "vps", name: "vps", socketPath: "/var/lib/uos-supervisor/failed-full.sock", codexHome: null };
    const context = await collectSupervisorBriefContext(source, "thread-1", deferredSignal());
    assert.equal(context.transcriptAvailable, false, "a failed full read degrades to the honest recorded summaries");
    assert.deepEqual(context.turns, []);
    assert.equal(context.state, "active", "the fresh runtime metadata still survives the failed enrichment");
  });
});

test("brief tail pages keep the newest items, skip content-free parts and tolerate a repeated turn with no opening request", async () => {
  await withScriptedSockets(async () => {
    ScriptedSocket.plan((method, params) => {
      if (method === "thread/read") return { thread: { id: "thread-1", status: { type: "idle" } } };
      if (method !== "thread/turns/list") return {};
      if (params.itemsView === "full") return { data: [] };
      if (params.sortDirection === "asc") {
        return {
          data: [
            {
              id: "turn-1",
              status: "completed",
              items: [
                { type: "userMessage", content: "not-an-array" },
                { type: "agentMessage", text: "recorded opening" },
              ],
            },
          ],
        };
      }
      return {
        data: [
          {
            id: "turn-1",
            status: "completed",
            items: Array.from({ length: 13 }, (_value, index) => ({ type: "agentMessage", text: `tail item ${index}` })),
          },
        ],
      };
    });
    const source: SupervisorSource = { id: "vps", name: "vps", socketPath: "/var/lib/uos-supervisor/tail.sock", codexHome: null };
    const context = await collectSupervisorBriefContext(source, "thread-1", deferredSignal());
    const opening = context.turns.find((turn) => turn.id === "turn-1");
    assert.ok(opening);
    assert.deepEqual(
      opening.items.map((item) => item.text),
      [
        "tail item 1",
        "tail item 2",
        "tail item 3",
        "tail item 4",
        "tail item 5",
        "tail item 6",
        "tail item 7",
        "tail item 8",
        "tail item 9",
        "tail item 10",
        "tail item 11",
        "tail item 12",
      ],
      "the newest tail items win the per-turn cap while the content-free user message contributes nothing"
    );
    assert.equal(opening.droppedItems, 1, "the single item dropped by the tail cap is reported");
  });
});

test("parseSupervisorConfig reports a duplicate id and a relative socket path", () => {
  const parsed = parseSupervisorConfig({
    sources: [
      { id: "dupe", name: "First", socketPath: "/var/lib/uos-supervisor/a.sock" },
      { id: "dupe", name: "Second", socketPath: "/var/lib/uos-supervisor/b.sock" },
      { id: "relative", name: "Relative", socketPath: "app-server.sock" },
    ],
  });
  assert.deepEqual(
    parsed.sources.map((source) => source.id),
    ["dupe"]
  );
  assert.ok(parsed.notes.includes("ignored duplicate source id dupe"));
  assert.ok(parsed.notes.includes("ignored source relative: socketPath must be an absolute path"));
});

test("handleAdminCodexSupervisorBrief refuses a JSON body that is not an object", async () => {
  const response = await handleAdminCodexSupervisorBrief(
    new Request("https://ai.ubq.fi/admin/codex/supervisor/brief", {
      method: "POST",
      body: '"a string, not an object"',
      headers: { "Content-Type": "application/json" },
    })
  );
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: { message: string } }).error.message, "Expected a JSON body with source and id");
});

test("an empty opening turn older than the newest turn keeps its honest absence while the newest turn is enriched", async () => {
  await withScriptedSockets(async () => {
    const fullCalls: Record<string, unknown>[] = [];
    ScriptedSocket.plan((method, params) => {
      if (method === "thread/read") return { thread: { id: "thread-1", status: { type: "active" } } };
      if (method !== "thread/turns/list") return {};
      if (params.itemsView === "full") {
        fullCalls.push(params);
        return {
          data: [{ id: "turn-2", status: "inProgress", startedAt: 1_790_000_900, items: [{ type: "agentMessage", text: "enriched newest" }] }],
        };
      }
      if (params.sortDirection === "asc") {
        return { data: [{ id: "turn-1", status: "completed", startedAt: 1_790_000_100, completedAt: 1_790_000_200, items: [] }] };
      }
      return {
        data: [
          { id: "turn-2", status: "inProgress", startedAt: 1_790_000_900, items: [] },
          { id: "turn-1", status: "completed", startedAt: 1_790_000_100, completedAt: 1_790_000_200, items: [] },
        ],
      };
    });
    const source: SupervisorSource = { id: "vps", name: "vps", socketPath: "/var/lib/uos-supervisor/unreachable.sock", codexHome: null };
    const context = await collectSupervisorBriefContext(source, "thread-1", deferredSignal());
    assert.equal(fullCalls.length, 1, "the unreachable older target buys no extra read");
    assert.deepEqual(
      context.turns.map((turn) => turn.id),
      ["turn-2"],
      "only the reachable newest turn is returned"
    );
    assert.deepEqual(
      context.turns[0].items.map((item) => item.text),
      ["enriched newest"]
    );
    assert.equal(context.truncated, true, "the omitted empty opening is reported as an incomplete transcript");
  });
});
