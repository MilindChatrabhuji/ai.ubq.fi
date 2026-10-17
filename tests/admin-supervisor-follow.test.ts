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
    return this._text || this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this._text = value;
    this.children.length = 0;
  }

  get childElementCount(): number {
    return this.children.length;
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

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this._text = "";
    this.append(...nodes);
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
  private readonly children: FakeElement[] = [];

  querySelector(selector: string): FakeElement {
    if (selector.startsWith("#")) {
      const id = selector.slice(1);
      let element = this._elements.get(id);
      if (!element) {
        element = new FakeElement("section");
        this._elements.set(id, element);
      }
      return element;
    }
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    throw new Error(`expected a section element for ${selector}`);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.children.push(node);
  }
}

const requestUrlOf = (input: unknown): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as { url: string }).url;
};

type ProviderFetch = (path: string, signal: AbortSignal | null) => Promise<Response>;

const createHarness = (providerFetch?: ProviderFetch) => {
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
    if (parsed.pathname === "/admin/providers/selection" || parsed.pathname === "/admin/providers") {
      if (providerFetch) return providerFetch(parsed.pathname, init?.signal ?? null);
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
  const providerList = section.querySelector("[data-provider-list]");
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
    providerList,
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

const entriesFrame = (text: string) => {
  const payload = { entries: [{ key: `late:${text}`, kind: "message", text }], sampledAtMs: 1_790_000_000_001 };
  return `event: entries\ndata: ${JSON.stringify(payload)}\n\n`;
};

const PROVIDER_SELECTION = {
  data: {
    providers: [
      {
        id: "codex",
        label: "Codex",
        tier: "subscription",
        tier_label: "Subscription",
        health_key: "codex",
        model_count: 1,
        endpoints: ["responses"],
      },
    ],
  },
};
const PROVIDER_HEALTH = { codex: { configured: true, state: "healthy" } };

const providerResponse = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

type PendingProvider = {
  path: string;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

type ProviderFailure =
  | { name: string; rejected: true }
  | { name: string; rejected: false; selection: Response; health: Response };

const createProviderQueue = () => {
  const pending: PendingProvider[] = [];
  const fetch: ProviderFetch = (path) =>
    new Promise<Response>((resolve, reject) => {
      pending.push({ path, resolve, reject });
    });
  const resolveRefresh = (index: number, selection: Response, health: Response): void => {
    const requests = pending.splice(index * 2, 2);
    assert.equal(requests.length, 2, `expected provider refresh ${index}`);
    assert.equal(requests[0]?.path, "/admin/providers/selection");
    assert.equal(requests[1]?.path, "/admin/providers");
    requests[0]?.resolve(selection);
    requests[1]?.resolve(health);
  };
  const rejectRefresh = (index: number): void => {
    const requests = pending.splice(index * 2, 2);
    assert.equal(requests.length, 2, `expected provider refresh ${index}`);
    const error = new Error("provider request failed");
    requests[0]?.reject(error);
    requests[1]?.reject(error);
  };
  return { fetch, resolveRefresh, rejectRefresh };
};

const startProviderRefresh = async (harness: ReturnType<typeof createHarness>): Promise<void> => {
  harness.view.setActive(false);
  harness.view.setActive(true);
  await flush();
};

test("a provider failure clears a previously healthy strip", async () => {
  const failures: ProviderFailure[] = [
    { name: "selection 502", rejected: false, selection: providerResponse({}, 502), health: providerResponse(PROVIDER_HEALTH) },
    { name: "health 500", rejected: false, selection: providerResponse(PROVIDER_SELECTION), health: providerResponse({}, 500) },
    { name: "malformed body", rejected: false, selection: providerResponse("not json"), health: providerResponse(PROVIDER_HEALTH) },
    { name: "empty provider list", rejected: false, selection: providerResponse({ data: { providers: [] } }), health: providerResponse(PROVIDER_HEALTH) },
    { name: "rejected fetch", rejected: true },
  ];

  for (const failure of failures) {
    const queue = createProviderQueue();
    const harness = createHarness(queue.fetch);
    try {
      harness.view.setActive(true);
      await flush();
      queue.resolveRefresh(0, providerResponse(PROVIDER_SELECTION), providerResponse(PROVIDER_HEALTH));
      await flush();
      await flush();
      assert.match(harness.providerList.textContent, /Health healthy/);

      await startProviderRefresh(harness);
      if (failure.rejected) queue.rejectRefresh(0);
      else queue.resolveRefresh(0, failure.selection, failure.health);
      await flush();
      await flush();
      assert.doesNotMatch(harness.providerList.textContent, /Health healthy/, failure.name);
      assert.equal(harness.providerList.children[0]?.attributes.get("role"), "listitem");
    } finally {
      harness.restore();
    }
  }
});

test("a superseded provider refresh cannot overwrite a newer unavailable state", async () => {
  const queue = createProviderQueue();
  const harness = createHarness(queue.fetch);
  try {
    harness.view.setActive(true);
    await flush();
    await startProviderRefresh(harness);
    queue.resolveRefresh(1, providerResponse({}, 502), providerResponse({}, 500));
    await flush();
    await flush();
    assert.match(harness.providerList.textContent, /unavailable/);

    queue.resolveRefresh(0, providerResponse(PROVIDER_SELECTION), providerResponse(PROVIDER_HEALTH));
    await flush();
    await flush();
    assert.doesNotMatch(harness.providerList.textContent, /Health healthy/);
  } finally {
    harness.restore();
  }
});

test("a superseded provider failure cannot clear a newer healthy state", async () => {
  const queue = createProviderQueue();
  const harness = createHarness(queue.fetch);
  try {
    harness.view.setActive(true);
    await flush();
    await startProviderRefresh(harness);
    queue.resolveRefresh(1, providerResponse(PROVIDER_SELECTION), providerResponse(PROVIDER_HEALTH));
    await flush();
    await flush();
    assert.match(harness.providerList.textContent, /Health healthy/);

    queue.rejectRefresh(0);
    await flush();
    await flush();
    assert.match(harness.providerList.textContent, /Health healthy/);
  } finally {
    harness.restore();
  }
});

test("a provider timeout clears the previous healthy strip", async () => {
  const timeoutController = new AbortController();
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeoutApi = AbortSignal as unknown as { timeout: (milliseconds: number) => AbortSignal };
  timeoutApi.timeout = () => timeoutController.signal;
  let calls = 0;
  const providerFetch: ProviderFetch = (path, signal) => {
    calls += 1;
    if (calls <= 2) {
      return Promise.resolve(path === "/admin/providers/selection" ? providerResponse(PROVIDER_SELECTION) : providerResponse(PROVIDER_HEALTH));
    }
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException("timed out", "TimeoutError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const harness = createHarness(providerFetch);
  try {
    harness.view.setActive(true);
    await flush();
    await flush();
    assert.match(harness.providerList.textContent, /Health healthy/);

    await startProviderRefresh(harness);
    timeoutController.abort(new DOMException("timed out", "TimeoutError"));
    await flush();
    await flush();
    assert.doesNotMatch(harness.providerList.textContent, /Health healthy/);
    assert.match(harness.providerList.textContent, /previous observations cleared/);
  } finally {
    harness.restore();
    timeoutApi.timeout = originalTimeout;
  }
});

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
