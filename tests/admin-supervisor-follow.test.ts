import { test } from "bun:test";
import assert from "node:assert/strict";

import { createSupervisorView } from "../static/admin-supervisor.js";

type ReadResult = { done: boolean; value?: Uint8Array };
type PendingRead = { resolve: (result: ReadResult) => void; reject: (error: unknown) => void };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const SNAPSHOT = {
  sampledAtMs: 1_790_000_000_000,
  counts: { total: 2, active: 2, waiting: 0, idle: 0 },
  sources: [{ id: "local", name: "This Mac", kind: "local", state: "ok" }],
  coverage: { notes: [] },
  sessions: [
    { sourceId: "local", id: "thread-a", machine: "m1", title: "Session A", state: "active", cwd: "/repo/a" },
    { sourceId: "local", id: "thread-b", machine: "m1", title: "Session B", state: "active", cwd: "/repo/b" },
  ],
};

/** Minimal DOM stand-in: enough of the element surface the supervisor view uses. */
class FakeElement {
  readonly tag: string;
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  parentElement: FakeElement | null = null;
  options: FakeElement[] = [];
  hidden = false;
  disabled = false;
  title = "";
  value = "";
  private _text = "";

  constructor(tag = "div") {
    this.tag = tag;
  }

  get textContent(): string {
    return this._text;
  }

  set textContent(value: string) {
    this._text = value;
    this.children.length = 0;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  appendChild(node: FakeElement): FakeElement {
    this.append(node);
    return node;
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  dispatch(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    let node = this.parentElement;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  matches(selector: string): boolean {
    const match = /^([a-z]+)?\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!match) return false;
    const tag = match.at(1);
    const dataName = match.at(2);
    const value = match.at(3);
    if (!dataName) return false;
    if (tag && this.tag !== tag) return false;
    const key = dataName.replace(/-([a-z])/g, (_all: string, letter: string) => letter.toUpperCase());
    if (!(key in this.dataset)) return false;
    return value === undefined || this.dataset[key] === value;
  }
}

class FakeDocument {
  hidden = false;

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  addEventListener(_type: string, _handler: (event: unknown) => void): void {}
}

class FakeSection {
  private readonly _elements = new Map<string, FakeElement>();

  querySelector(selector: string): FakeElement {
    const id = selector.startsWith("#") ? selector.slice(1) : selector;
    let element = this._elements.get(id);
    if (!element) {
      element = new FakeElement("section");
      this._elements.set(id, element);
    }
    return element;
  }

  // The view appends its read-only providers card to the real section; the
  // follow harness never reads that card back.
  append(): void {}
}

const requestUrlOf = (input: unknown): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as { url: string }).url;
};

const createHarness = () => {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const originalDocument = globalRecord.document;
  const originalElement = globalRecord.Element;
  const originalFetch = globalRecord.fetch;

  globalRecord.document = new FakeDocument();
  globalRecord.Element = FakeElement;

  const pendingReads = new Map<string, PendingRead[]>();
  const signals = new Map<string, AbortSignal | null>();

  const readerFor = (threadId: string) => ({
    read: () =>
      new Promise<ReadResult>((resolve, reject) => {
        const queue = pendingReads.get(threadId) ?? [];
        queue.push({ resolve, reject });
        pendingReads.set(threadId, queue);
      }),
  });

  globalRecord.fetch = ((input: unknown, init?: { signal?: AbortSignal | null }) => {
    const url = requestUrlOf(input);
    const parsed = new URL(url);
    if (parsed.pathname === "/admin/codex/supervisor/sessions") {
      return Promise.resolve(new Response(JSON.stringify(SNAPSHOT), { status: 200 }));
    }
    if (parsed.pathname === "/admin/codex/supervisor/output") {
      const threadId = parsed.searchParams.get("id") ?? "";
      signals.set(threadId, init?.signal ?? null);
      return Promise.resolve({ ok: true, status: 200, body: { getReader: () => readerFor(threadId) } });
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as unknown as typeof fetch;

  const section = new FakeSection();
  const view = createSupervisorView({
    section,
    getToken: () => "",
    apiUrl: (path: string) => `https://supervisor.test${path}`,
  });
  const list = section.querySelector("#supervisor-list");
  const followStatus = section.querySelector("#supervisor-follow-status");
  const followLog = section.querySelector("#supervisor-follow-log");
  const followStop = section.querySelector("#supervisor-follow-stop");

  const takeRead = (threadId: string): PendingRead => {
    const queue = pendingReads.get(threadId) ?? [];
    const pending = queue.shift();
    assert.ok(pending, `expected a pending read for ${threadId}`);
    return pending;
  };

  return {
    view,
    followStatus,
    followLog,
    followStop,
    clickFollow(key: string): void {
      const row = list.querySelector(`[data-session-key="${key}"]`);
      assert.ok(row, `expected a rendered row for ${key}`);
      const button = row.querySelector('[data-action="follow"]');
      assert.ok(button, `expected a follow button for ${key}`);
      list.dispatch("click", { target: button });
    },
    resolveRead(threadId: string, chunk: string): void {
      takeRead(threadId).resolve({ done: false, value: new TextEncoder().encode(chunk) });
    },
    endRead(threadId: string): void {
      takeRead(threadId).resolve({ done: true });
    },
    rejectRead(threadId: string, error: unknown): void {
      takeRead(threadId).reject(error);
    },
    signalFor(threadId: string): AbortSignal | null {
      return signals.get(threadId) ?? null;
    },
    restore(): void {
      view.setActive(false);
      globalRecord.document = originalDocument;
      globalRecord.Element = originalElement;
      globalRecord.fetch = originalFetch;
    },
  };
};

const followEntriesFrame = (entries: unknown[]) => {
  const payload = { entries, sampledAtMs: 1_790_000_000_001 };
  return `event: entries\ndata: ${JSON.stringify(payload)}\n\n`;
};

const entriesFrame = (text: string) => followEntriesFrame([{ key: `late:${text}`, kind: "message", text }]);

test("a late abort rejection from a superseded follow never reports against or clears the new session", async () => {
  const harness = createHarness();
  try {
    harness.view.setActive(true);
    await flush();
    harness.clickFollow("local:thread-a");
    await flush();
    harness.clickFollow("local:thread-b");
    await flush();
    assert.equal(harness.signalFor("thread-a")?.aborted, true, "switching sessions aborts the previous follow");

    harness.rejectRead("thread-a", new DOMException("The operation was aborted.", "AbortError"));
    await flush();
    assert.equal(harness.followStatus.textContent, "Connecting to recorded output…", "session B keeps its own status");
    assert.equal(harness.followStatus.dataset.state, "ok");

    harness.followStop.dispatch("click", {});
    assert.equal(harness.signalFor("thread-b")?.aborted, true, "session B's controller is still owned by the follow panel");
    assert.equal(harness.followStatus.textContent, "Follow stopped.");
  } finally {
    harness.restore();
  }
});

test("frames from a superseded follow never reach the new session's log", async () => {
  const harness = createHarness();
  try {
    harness.view.setActive(true);
    await flush();
    harness.clickFollow("local:thread-a");
    await flush();
    harness.clickFollow("local:thread-b");
    await flush();

    harness.resolveRead("thread-a", entriesFrame("stale output"));
    await flush();
    assert.equal(harness.followLog.childElementCount, 0, "a superseded stream cannot append entries");
    assert.equal(harness.followStatus.textContent, "Connecting to recorded output…", "a superseded stream cannot overwrite status");
  } finally {
    harness.restore();
  }
});

test("the owning follow still consumes frames and cleans up when the stream closes", async () => {
  const harness = createHarness();
  try {
    harness.view.setActive(true);
    await flush();
    harness.clickFollow("local:thread-a");
    await flush();

    harness.resolveRead("thread-a", entriesFrame("fresh output"));
    await flush();
    assert.equal(harness.followLog.childElementCount, 1);
    assert.match(harness.followStatus.textContent, /^Recorded output · /);

    harness.endRead("thread-a");
    await flush();
    assert.equal(harness.followStatus.textContent, "Follow stream closed. Select the session again to resume recorded output.");
  } finally {
    harness.restore();
  }
});

test("an update to an evicted follow entry cannot displace newer output", async () => {
  const harness = createHarness();
  try {
    harness.view.setActive(true);
    await flush();
    harness.clickFollow("local:thread-a");
    await flush();

    const initialEntries = Array.from({ length: 201 }, (_, index) => ({
      key: `entry:${index}`,
      kind: "message",
      text: `entry ${index}`,
      revision: "1",
    }));
    harness.resolveRead("thread-a", followEntriesFrame(initialEntries));
    await flush();
    const retainedKeys = Array.from({ length: 200 }, (_, index) => `entry:${index + 1}`);
    assert.deepEqual(
      harness.followLog.children.map((entry) => entry.dataset.followKey),
      retainedKeys,
      "the initial trim removes only the oldest entry",
    );

    harness.resolveRead(
      "thread-a",
      followEntriesFrame([{ key: "entry:0", kind: "message", text: "updated entry 0", revision: "2" }]),
    );
    await flush();
    assert.deepEqual(
      harness.followLog.children.map((entry) => entry.dataset.followKey),
      retainedKeys,
      "a revision of the evicted entry must not append after newer output or evict it",
    );
  } finally {
    harness.restore();
  }
});
