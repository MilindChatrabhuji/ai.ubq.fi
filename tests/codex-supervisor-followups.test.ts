import { test } from "bun:test";
import assert from "node:assert/strict";

import { extractFollowEntries, followEntryRevision, readFollowUpdate, selectFollowUpdates } from "../src/codex/supervisor-follow.ts";
import { FOLLOW_MAX_ENTRIES } from "../src/codex/supervisor-config.ts";
import type { SupervisorSource } from "../src/codex/supervisor-config.ts";
import { buildSupervisorBriefPrompt, collectBriefTranscript } from "../src/codex/supervisor-brief.ts";
import { openSupervisorConnection, setSupervisorWebSocketConstructorForTest, type SupervisorConnection } from "../src/codex/supervisor-transport.ts";

const SOURCE: SupervisorSource = { id: "local", name: "m1.local", socketPath: "/var/lib/uos-supervisor/local.sock", codexHome: null };

/* ------------------------------------------------------------------ issue 400 */

test("follow updates re-emit one command index as its output, status and exit code change", () => {
  const partial = extractFollowEntries("turn-1", [
    { type: "commandExecution", id: "c1", command: "deno task test", status: "in_progress", exitCode: null, aggregatedOutput: "running" },
  ]);
  const revisions = new Map<string, string>();
  const first = selectFollowUpdates(partial, -1, revisions);
  const [firstEntry] = first;
  assert.ok(firstEntry);
  assert.equal(firstEntry.key, "turn-1:c1");
  assert.equal(firstEntry.text, "running");
  assert.equal(selectFollowUpdates(partial, 0, revisions).length, 0, "an unchanged poll must not churn");

  const changed = extractFollowEntries("turn-1", [
    { type: "commandExecution", id: "c1", command: "deno task test", status: "in_progress", exitCode: null, aggregatedOutput: "running\nmore" },
  ]);
  const second = selectFollowUpdates(changed, 0, revisions);
  const [secondEntry] = second;
  assert.ok(secondEntry);
  assert.equal(secondEntry.text, "running\nmore", "later output at the same index must be emitted");
  assert.notEqual(followEntryRevision(secondEntry), followEntryRevision(firstEntry));

  const completed = extractFollowEntries("turn-1", [
    { type: "commandExecution", id: "c1", command: "deno task test", status: "completed", exitCode: 0, aggregatedOutput: "running\nmore\nok" },
  ]);
  const third = selectFollowUpdates(completed, 0, revisions);
  const [thirdEntry] = third;
  assert.ok(thirdEntry);
  assert.equal(thirdEntry.status, "completed", "the final status must be emitted");
  assert.equal(thirdEntry.exitCode, 0, "the final exit code must be emitted");
  assert.equal(thirdEntry.text, "running\nmore\nok");

  const reconnect = new Map<string, string>();
  assert.equal(selectFollowUpdates(completed, 0, reconnect).length, 1, "a reconnect re-baselines the current item once");
  assert.equal(selectFollowUpdates(completed, 0, reconnect).length, 0, "the reconnected stream then stays quiet");
});

test("follow retains a completed entry that falls outside a sampled update batch", () => {
  const count = FOLLOW_MAX_ENTRIES + 2;
  const partial = extractFollowEntries("turn-gap", [
    {
      type: "commandExecution",
      id: "c0",
      command: "command 0",
      status: "in_progress",
      exitCode: null,
      aggregatedOutput: "partial 0",
    },
  ]);
  const revisions = new Map<string, string>();
  const first = selectFollowUpdates(partial, -1, revisions);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.key, "turn-gap:c0");

  const completed = extractFollowEntries(
    "turn-gap",
    Array.from({ length: count }, (_, index) => ({
      type: "commandExecution",
      id: `c${index}`,
      command: `command ${index}`,
      status: "completed",
      exitCode: index === 0 ? 7 : 0,
      aggregatedOutput: index === 0 ? "final output" : `final ${index}`,
    })),
  );
  const second = selectFollowUpdates(completed, 0, revisions);
  assert.equal(second.length, FOLLOW_MAX_ENTRIES);
  assert.equal(second.some((entry) => entry.key === "turn-gap:c0"), false, "the completed entry is outside this oversized update batch");

  const [delivered] = selectFollowUpdates(completed, count - 1, revisions);
  assert.ok(delivered);
  assert.equal(delivered.key, "turn-gap:c0");
  assert.equal(delivered.text, "final output");
  assert.equal(delivered.status, "completed");
  assert.equal(delivered.exitCode, 7);
});

/* ------------------------------------------------------------------ issue 401 */

type FakeListener = (...args: unknown[]) => void;

/**
 * Minimal structural stand-in for the ws client. It opens on a microtask, then
 * answers the initialize frame on demand so the transport's failure cleanup can
 * be observed without a live socket.
 */
class FakeSupervisorSocket {
  private static readonly _created: FakeSupervisorSocket[] = [];
  readonly frames: string[] = [];
  readyState = 1;
  terminated = false;
  closed = false;
  private readonly _listeners = new Map<string, FakeListener[]>();

  constructor(_url: string) {
    FakeSupervisorSocket._created.push(this);
    queueMicrotask(() => {
      this._emit("open");
    });
  }

  /** Typed accessor so the newest fake is never narrowed to a mutable singleton. */
  static latest(): FakeSupervisorSocket | null {
    return FakeSupervisorSocket._created.at(-1) ?? null;
  }

  static reset(): void {
    FakeSupervisorSocket._created.length = 0;
  }

  on(event: string, listener: FakeListener): this {
    this._add(event, listener);
    return this;
  }

  once(event: string, listener: FakeListener): this {
    this._add(event, listener);
    return this;
  }

  send(data: string): void {
    this.frames.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this._emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  rejectInitialize(message: string): void {
    const frame = this.frames.find((value) => value.includes('"initialize"'));
    assert.ok(frame, "the transport must send an initialize frame");
    const id = (JSON.parse(frame) as { id: number }).id;
    this._emit("message", JSON.stringify({ id, error: { message } }));
  }

  private _add(event: string, listener: FakeListener): void {
    const list = this._listeners.get(event) ?? [];
    list.push(listener);
    this._listeners.set(event, list);
  }

  private _emit(event: string, ...args: unknown[]): void {
    const list = this._listeners.get(event) ?? [];
    this._listeners.set(event, []);
    for (const listener of list) listener(...args);
  }
}

const tick = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });

test("a rejected initialize terminates the exact socket, settles callbacks, and rethrows the cause", async () => {
  FakeSupervisorSocket.reset();
  setSupervisorWebSocketConstructorForTest(FakeSupervisorSocket as unknown);
  try {
    const pending = openSupervisorConnection("/var/lib/uos-supervisor/rejected.sock");
    await tick();
    const socket = FakeSupervisorSocket.latest();
    assert.ok(socket, "the transport must construct its own socket");
    socket.rejectInitialize("initialize rejected");
    await assert.rejects(pending, /initialize rejected/);
    assert.equal(socket.terminated, true, "the exact failed socket must be terminated");

    // A later sampling attempt must build a fresh socket instead of reusing the failed one.
    const retry = openSupervisorConnection("/var/lib/uos-supervisor/retry.sock");
    await tick();
    const second = FakeSupervisorSocket.latest();
    assert.ok(second);
    assert.notEqual(second, socket);
    second.rejectInitialize("initialize rejected");
    await assert.rejects(retry, /initialize rejected/);
    assert.equal(second.terminated, true);
  } finally {
    setSupervisorWebSocketConstructorForTest(null);
  }
});

test("a stalled initialize terminates the exact socket at the call deadline and rethrows", async () => {
  FakeSupervisorSocket.reset();
  setSupervisorWebSocketConstructorForTest(FakeSupervisorSocket as unknown);
  try {
    const pending = openSupervisorConnection("/var/lib/uos-supervisor/stalled.sock");
    await tick();
    const socket = FakeSupervisorSocket.latest();
    assert.ok(socket);
    await assert.rejects(pending, /timed out/);
    assert.equal(socket.terminated, true, "the stalled socket must not be left open");
  } finally {
    setSupervisorWebSocketConstructorForTest(null);
  }
});

/* -------------------------------------------------------------- issues 402/403 */

type BriefPages = {
  read?: unknown;
  asc?: unknown[];
  desc?: unknown[];
  /** Full-view pages, consumed in order. Every fixture must use `desc` + `limit: 1`. */
  full?: unknown[];
  /** Rejects every full-view call with this message, as a frame-cap socket error does. */
  fullError?: string;
};

type BriefRequest = { view: string; direction: string; limit: number | null; cursor: string | null };

const briefConnection = (pages: BriefPages): { connection: SupervisorConnection; calls: string[]; requests: BriefRequest[] } => {
  const calls: string[] = [];
  const requests: BriefRequest[] = [];
  let ascIndex = 0;
  let descIndex = 0;
  let fullIndex = 0;
  const connection: SupervisorConnection = {
    call: (method, params) => {
      const view = typeof params?.itemsView === "string" ? params.itemsView : "";
      const direction = typeof params?.sortDirection === "string" ? params.sortDirection : "";
      calls.push(`${method}:${view}:${direction}`);
      requests.push({
        view,
        direction,
        limit: typeof params?.limit === "number" ? params.limit : null,
        cursor: typeof params?.cursor === "string" ? params.cursor : null,
      });
      if (method === "thread/read") return Promise.resolve(pages.read ?? {});
      if (view === "summary") {
        if (direction === "asc") {
          const value = pages.asc?.[ascIndex] ?? pages.asc?.at(-1);
          ascIndex += 1;
          return Promise.resolve(value ?? { data: [] });
        }
        const value = pages.desc?.[descIndex] ?? pages.desc?.at(-1);
        descIndex += 1;
        return Promise.resolve(value ?? { data: [] });
      }
      if (view === "full") {
        if (pages.fullError) return Promise.reject(new Error(pages.fullError));
        const value = pages.full?.[fullIndex] ?? { data: [] };
        fullIndex += 1;
        return Promise.resolve(value);
      }
      return Promise.resolve({});
    },
    close: () => Promise.resolve(),
  };
  return { connection, calls, requests };
};

type FollowSocketReply = { result?: unknown; error?: string };

class ScriptedFollowSocket {
  private static _scripts: FollowSocketReply[][] = [];
  private readonly _script: FollowSocketReply[];
  private readonly _listeners = new Map<string, { listener: FakeListener; once: boolean }[]>();
  readyState = 1;

  constructor(_url: string) {
    this._script = ScriptedFollowSocket._scripts.shift() ?? [];
    queueMicrotask(() => {
      this._emit("open");
    });
  }

  static setScripts(scripts: FollowSocketReply[][]): void {
    ScriptedFollowSocket._scripts = scripts.map((script) => [...script]);
  }

  on(event: string, listener: FakeListener): this {
    this._add(event, listener, false);
    return this;
  }

  once(event: string, listener: FakeListener): this {
    this._add(event, listener, true);
    return this;
  }

  send(data: string): void {
    const request = JSON.parse(data) as { id?: unknown };
    if (typeof request.id !== "number") return;
    const reply = this._script.shift();
    if (!reply) throw new Error("missing scripted supervisor reply");
    const frame = typeof reply.error === "string" ? { id: request.id, error: { message: reply.error } } : { id: request.id, result: reply.result };
    queueMicrotask(() => {
      this._emit("message", JSON.stringify(frame));
    });
  }

  close(): void {
    this.readyState = 3;
    this._emit("close");
  }

  terminate(): void {
    this.readyState = 3;
  }

  private _add(event: string, listener: FakeListener, once: boolean): void {
    const list = this._listeners.get(event) ?? [];
    list.push({ listener, once });
    this._listeners.set(event, list);
  }

  private _emit(event: string, ...args: unknown[]): void {
    const list = this._listeners.get(event) ?? [];
    this._listeners.set(
      event,
      list.filter((entry) => !entry.once)
    );
    for (const entry of list) entry.listener(...args);
  }
}

const turnRead = { thread: { id: "thread-1", name: "Ordering", status: { type: "active" }, updatedAt: 1_790_000_900 } };

test("a failed follow enrichment does not replace an already-rendered command output", async () => {
  const summary = {
    data: [
      {
        id: "turn-follow",
        status: "inProgress",
        items: [{ type: "commandExecution", id: "command-1", command: "printf output", status: "in_progress", exitCode: null, aggregatedOutput: "" }],
      },
    ],
  };
  const full = {
    data: [
      {
        id: "turn-follow",
        status: "inProgress",
        items: [
          { type: "commandExecution", id: "command-1", command: "printf output", status: "in_progress", exitCode: null, aggregatedOutput: "known output" },
        ],
      },
    ],
  };
  ScriptedFollowSocket.setScripts([
    [{ result: {} }, { result: summary }, { result: full }],
    [{ result: {} }, { result: summary }, { error: "frame cap" }],
  ]);
  setSupervisorWebSocketConstructorForTest(ScriptedFollowSocket as unknown);
  try {
    const revisions = new Map<string, string>();
    const signal = new AbortController().signal;
    const first = await readFollowUpdate(SOURCE, "thread-follow", "", signal, revisions);
    const firstEntry = first.entries[0];
    assert.ok(firstEntry, "the successful enrichment must emit the command");
    assert.equal(first.enriched, true);
    assert.equal(firstEntry.text, "known output");

    const second = await readFollowUpdate(SOURCE, "thread-follow", first.cursor, signal, revisions);
    let renderedOutput = firstEntry.text;
    for (const entry of second.entries) {
      if (entry.key === firstEntry.key && entry.kind === "command") renderedOutput = entry.text;
    }
    assert.equal(second.enriched, false);
    assert.equal(second.entries.length, 0, "the failed full read must not emit the empty summary entry");
    assert.equal(renderedOutput, "known output", "the card keeps output from the successful enrichment");
    assert.equal(revisions.get(firstEntry.key), followEntryRevision(firstEntry));
  } finally {
    setSupervisorWebSocketConstructorForTest(null);
  }
});

test("brief turns are deduplicated and presented chronologically", async () => {
  const { connection } = briefConnection({
    read: turnRead,
    asc: [
      {
        data: [
          {
            id: "turn-a",
            status: "completed",
            startedAt: 1_790_000_100,
            completedAt: 1_790_000_110,
            items: [{ type: "userMessage", id: "u0", content: [{ type: "text", text: "opening request" }] }],
          },
        ],
      },
    ],
    desc: [
      {
        data: [
          { id: "turn-c", status: "inProgress", startedAt: 1_790_000_300, items: [{ type: "agentMessage", id: "a2", text: "newest progress" }] },
          {
            id: "turn-b",
            status: "completed",
            startedAt: 1_790_000_200,
            completedAt: 1_790_000_210,
            items: [{ type: "agentMessage", id: "a1", text: "middle progress" }],
          },
          {
            id: "turn-a",
            status: "completed",
            startedAt: 1_790_000_100,
            completedAt: 1_790_000_110,
            items: [{ type: "agentMessage", id: "a0", text: "opening tail" }],
          },
        ],
      },
    ],
  });
  const context = await collectBriefTranscript(connection, SOURCE, "thread-1", new AbortController().signal);
  assert.deepEqual(
    context.turns.map((turn) => turn.id),
    ["turn-a", "turn-b", "turn-c"],
    "newest-first summaries must be presented chronologically"
  );
  assert.equal(context.turns.filter((turn) => turn.id === "turn-a").length, 1, "the repeated opening turn is deduplicated");
  const prompt = buildSupervisorBriefPrompt(context);
  assert.match(prompt, /opening request/, "the opening request survives the head/tail merge");
  assert.match(prompt, /opening tail/, "the newest tail of the repeated turn survives");
  assert.match(prompt, /newest progress/);
});

test("brief turns stay chronological by page order when every timestamp is missing", async () => {
  const { connection } = briefConnection({
    read: { thread: { id: "thread-1", name: "No timestamps", status: { type: "active" } } },
    asc: [
      {
        data: [
          {
            id: "turn-opening",
            status: "completed",
            items: [{ type: "userMessage", id: "u0", content: [{ type: "text", text: "opening request" }] }],
          },
        ],
      },
    ],
    desc: [
      {
        data: [
          { id: "turn-newest", status: "inProgress", items: [{ type: "agentMessage", id: "n1", text: "newest progress" }] },
          { id: "turn-middle", status: "completed", items: [{ type: "agentMessage", id: "m1", text: "middle progress" }] },
        ],
      },
    ],
  });
  const context = await collectBriefTranscript(connection, SOURCE, "thread-1", new AbortController().signal);
  assert.deepEqual(
    context.turns.map((turn) => turn.id),
    ["turn-opening", "turn-middle", "turn-newest"],
    "page order alone must produce a chronological transcript"
  );
  const prompt = buildSupervisorBriefPrompt(context);
  assert.ok(prompt.indexOf("middle progress") < prompt.indexOf("newest progress"), "the prompt stays chronological");
});

test("the newest brief turn survives when the transcript budget trims older material", async () => {
  const heavyTurn = (id: string, startedAt: number) => ({
    id,
    status: "completed",
    startedAt,
    completedAt: startedAt + 1,
    items: Array.from({ length: 12 }, (_value, index) => ({ type: "agentMessage", id: `${id}-${index}`, text: "x".repeat(1_500) })),
  });
  const { connection } = briefConnection({
    read: turnRead,
    asc: [{ data: [heavyTurn("turn-oldest", 1_790_000_000)] }],
    desc: [
      {
        data: [
          { id: "turn-newest", status: "inProgress", startedAt: 1_790_000_500, items: [{ type: "agentMessage", id: "n1", text: "newest tail survives" }] },
          heavyTurn("turn-heavy-b", 1_790_000_400),
          heavyTurn("turn-heavy-a", 1_790_000_300),
        ],
      },
    ],
  });
  const context = await collectBriefTranscript(connection, SOURCE, "thread-1", new AbortController().signal);
  assert.ok(context.truncated, "the heavy older turns must mark truncation");
  const [last] = context.turns.slice(-1);
  assert.ok(last);
  assert.equal(last.id, "turn-newest", "the newest turn stays in the chronological output");
  assert.match(buildSupervisorBriefPrompt(context), /newest tail survives/);
});

test("the newest empty turn is enriched from one desc limit-1 full read", async () => {
  const { connection, calls, requests } = briefConnection({
    read: turnRead,
    asc: [{ data: [{ id: "turn-opening", status: "completed", startedAt: 1_790_000_000, completedAt: 1_790_000_005, items: [] }] }],
    desc: [
      {
        data: [
          { id: "turn-recent", status: "inProgress", startedAt: 1_790_000_900, items: [] },
          {
            id: "turn-mid",
            status: "completed",
            startedAt: 1_790_000_500,
            completedAt: 1_790_000_510,
            items: [{ type: "agentMessage", id: "m1", text: "middle summary" }],
          },
        ],
      },
    ],
    full: [
      {
        data: [{ id: "turn-recent", status: "inProgress", startedAt: 1_790_000_900, items: [{ type: "agentMessage", id: "r1", text: "recent full content" }] }],
      },
    ],
  });
  const context = await collectBriefTranscript(connection, SOURCE, "thread-1", new AbortController().signal);
  assert.equal(calls.filter((call) => call.includes(":full:")).length, 1, "one frame-safe full read per brief");
  const [fullRequest] = requests.filter((request) => request.view === "full");
  assert.ok(fullRequest);
  assert.equal(fullRequest.direction, "desc", "the full read is descending");
  assert.equal(fullRequest.limit, 1, "the full read is a single turn");
  assert.equal(fullRequest.cursor, null, "no cursor walk is issued");
  const recent = context.turns.find((turn) => turn.id === "turn-recent");
  assert.ok(recent);
  assert.equal(
    recent.items.some((item) => item.text.includes("recent full content")),
    true,
    "the single newest turn is enriched"
  );
  // The older empty opening is out of reach of a desc limit-1 read, so it keeps
  // its empty summary and the budget assembly omits it instead of substituting it.
  assert.equal(
    context.turns.some((turn) => turn.id === "turn-opening"),
    false,
    "an unreachable opening keeps its honest absence"
  );
  assert.deepEqual(
    context.turns.map((turn) => turn.id),
    ["turn-mid", "turn-recent"],
    "the returned order stays chronological"
  );
});

test("an unmatched enrichment id is never substituted", async () => {
  const { connection, requests } = briefConnection({
    read: turnRead,
    asc: [{ data: [{ id: "turn-missing", status: "completed", startedAt: 1_790_000_100, completedAt: 1_790_000_110, items: [] }] }],
    desc: [{ data: [{ id: "turn-recent", status: "inProgress", startedAt: 1_790_000_300, items: [] }] }],
    full: [
      {
        data: [{ id: "turn-recent", status: "inProgress", startedAt: 1_790_000_300, items: [{ type: "agentMessage", id: "r1", text: "recent full content" }] }],
      },
    ],
  });
  const context = await collectBriefTranscript(connection, SOURCE, "thread-1", new AbortController().signal);
  assert.equal(requests.filter((request) => request.view === "full").length, 1, "one full read, no retry for the missing id");
  // The unmatched turn's summary is empty and stays unmatched: no substitute
  // content may be fabricated for it, and the budget assembly intentionally
  // omits content-free turns, so it is absent rather than empty.
  assert.equal(
    context.turns.some((turn) => turn.id === "turn-missing"),
    false,
    "no unmatched turn may be substituted"
  );
  assert.deepEqual(
    context.turns.map((turn) => turn.id),
    ["turn-recent"]
  );
  const recent = context.turns.find((turn) => turn.id === "turn-recent");
  assert.ok(recent);
  assert.equal(
    recent.items.some((item) => item.text.includes("recent full content")),
    true,
    "the matched replacement is kept"
  );
});

test("the opening turn is enriched only when the single full read returns it", async () => {
  const run = async (withTimestamps: boolean) => {
    const stamp = (value: number) => (withTimestamps ? { startedAt: value, completedAt: value + 1 } : {});
    // A single-turn thread: the opening turn is also the newest turn, so the one
    // permitted full shape can reach it.
    const single = briefConnection({
      read: turnRead,
      asc: [{ data: [{ id: "turn-opening", status: "completed", ...stamp(1_790_000_100), items: [] }] }],
      desc: [{ data: [{ id: "turn-opening", status: "completed", ...stamp(1_790_000_100), items: [] }] }],
      full: [
        {
          data: [{ id: "turn-opening", status: "completed", ...stamp(1_790_000_100), items: [{ type: "agentMessage", id: "o1", text: "opening context" }] }],
        },
      ],
    });
    const context = await collectBriefTranscript(single.connection, SOURCE, "thread-1", new AbortController().signal);
    assert.equal(single.requests.filter((request) => request.view === "full").length, 1, "the opening is fetched exactly once");
    const opening = context.turns.find((turn) => turn.id === "turn-opening");
    assert.ok(opening, "the opening turn must keep its own full data");
    assert.equal(
      opening.items.some((item) => item.text.includes("opening context")),
      true
    );
    assert.match(buildSupervisorBriefPrompt(context), /opening context/);

    // An older empty opening is out of reach: the newest turn is the only target
    // the safe read can return, so the opening keeps its recorded summary
    // instead of a cursor walk or a wider full page.
    const older = briefConnection({
      read: turnRead,
      asc: [{ data: [{ id: "turn-opening", status: "completed", ...stamp(1_790_000_100), items: [] }] }],
      desc: [
        {
          data: [
            { id: "turn-newest", status: "inProgress", ...stamp(1_790_000_300), items: [] },
            { id: "turn-older", status: "completed", ...stamp(1_790_000_200), items: [] },
          ],
        },
      ],
      full: [
        {
          data: [
            { id: "turn-newest", status: "inProgress", ...stamp(1_790_000_300), items: [{ type: "agentMessage", id: "n1", text: "newest progress survives" }] },
          ],
        },
      ],
    });
    const limited = await collectBriefTranscript(older.connection, SOURCE, "thread-1", new AbortController().signal);
    assert.equal(older.requests.filter((request) => request.view === "full").length, 1, "no second page or retry is attempted");
    assert.deepEqual(
      limited.turns.map((turn) => turn.id),
      ["turn-newest"],
      "only the reachable newest turn is enriched"
    );
    assert.equal(
      limited.turns.some((turn) => turn.id === "turn-opening" || turn.id === "turn-older"),
      false,
      "unreachable empty summaries are never substituted"
    );
    assert.match(buildSupervisorBriefPrompt(limited), /newest progress survives/);
  };
  await run(false);
  await run(true);
});

test("every full-view read is a single newest turn: limit 1 and descending", async () => {
  const { connection, requests } = briefConnection({
    read: turnRead,
    asc: [{ data: [{ id: "turn-opening", status: "completed", items: [] }] }],
    desc: [{ data: [{ id: "turn-newest", status: "inProgress", items: [] }] }],
    full: [
      {
        data: [{ id: "turn-newest", status: "inProgress", items: [{ type: "agentMessage", id: "n1", text: "newest" }] }],
      },
    ],
  });
  await collectBriefTranscript(connection, SOURCE, "thread-1", new AbortController().signal);
  const fullRequests = requests.filter((request) => request.view === "full");
  assert.ok(fullRequests.length > 0, "the fixture must exercise the full-view path");
  assert.ok(fullRequests.length <= 2, "at most two full reads per brief");
  for (const request of fullRequests) {
    assert.equal(request.direction, "desc", "full views are always descending");
    assert.equal(request.limit, 1, "a full view is always exactly one turn");
    assert.equal(request.cursor, null, "no cursor walk is ever issued");
  }
  assert.equal(
    requests.some((request) => request.view === "full" && request.direction === "asc"),
    false,
    "no ascending full view is ever issued"
  );
});

test("a failed full read degrades to the recorded summary instead of failing the brief", async () => {
  const { connection, calls, requests } = briefConnection({
    read: turnRead,
    asc: [
      {
        data: [
          {
            id: "turn-opening",
            status: "completed",
            startedAt: 1_790_000_100,
            completedAt: 1_790_000_110,
            items: [{ type: "userMessage", id: "u0", content: [{ type: "text", text: "recorded summary request" }] }],
          },
        ],
      },
    ],
    desc: [{ data: [{ id: "turn-newest", status: "inProgress", startedAt: 1_790_000_300, items: [] }] }],
    // The frame cap errors the socket and rejects every pending call, which is
    // exactly how a too-large full read takes the connection down.
    fullError: "app-server connection failed",
  });
  const context = await collectBriefTranscript(connection, SOURCE, "thread-1", new AbortController().signal);
  assert.equal(calls.filter((call) => call.includes(":full:")).length, 1, "the fixture must exercise the failing full read");
  assert.equal(requests.filter((request) => request.view === "full").length, 1);
  assert.equal(context.transcriptAvailable, true, "the brief still returns the recorded history");
  const opening = context.turns.find((turn) => turn.id === "turn-opening");
  assert.ok(opening);
  assert.equal(
    opening.items.some((item) => item.text.includes("recorded summary request")),
    true,
    "the recorded summary turn survives the failed enrichment"
  );
  assert.equal(
    context.turns.some((turn) => turn.id === "turn-newest"),
    false,
    "the failed enrichment leaves no substitute content"
  );
  assert.match(buildSupervisorBriefPrompt(context), /recorded summary request/);
});
