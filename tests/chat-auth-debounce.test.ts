import { test } from "bun:test";
import assert from "node:assert/strict";

class ChatAuthElement extends EventTarget {
  dataset: Record<string, string | undefined> = {};
  children: ChatAuthElement[] = [];
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  isConnected = true;
  style = {};
  private text = "";

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  appendChild(child: ChatAuthElement): ChatAuthElement {
    this.children.push(child);
    return child;
  }

  append(...children: ChatAuthElement[]): void {
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name: string, value: string): void {
    if (!name.startsWith("data-")) return;
    const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    this.dataset[key] = value;
  }

  querySelector(): ChatAuthElement | null {
    return null;
  }

  querySelectorAll(): ChatAuthElement[] {
    return [];
  }

  focus(): void {}

  remove(): void {
    this.isConnected = false;
  }
}

class ChatAuthDocument extends EventTarget {
  visibilityState = "visible";
  body = new ChatAuthElement();
  private elements = new Map<string, ChatAuthElement>();
  private chatStats = new ChatAuthElement();

  getElementById(id: string): ChatAuthElement {
    const element = this.elements.get(id) ?? new ChatAuthElement();
    this.elements.set(id, element);
    return element;
  }

  createElement(): ChatAuthElement {
    return new ChatAuthElement();
  }

  createElementNS(): ChatAuthElement {
    return new ChatAuthElement();
  }

  querySelector(selector: string): ChatAuthElement | null {
    return selector === "[data-chat-stats]" ? this.chatStats : null;
  }

  querySelectorAll(): ChatAuthElement[] {
    return [];
  }
}

const setGlobal = (key: string, value: unknown): (() => void) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  };
};

const flushMicrotasks = async (): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
};

test("empty-token local auth cancels a pending token check", async () => {
  const documentTarget = new ChatAuthDocument();
  const windowTarget = new EventTarget();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  const setTimeoutMock = (callback: () => void, delay = 0): number => {
    const handle = ++nextTimer;
    timers.set(handle, { callback, delay });
    return handle;
  };
  const clearTimeoutMock = (handle: number): void => {
    timers.delete(handle);
  };
  const localStorageItems = new Map<string, string>();
  const authRequests: string[] = [];
  const fetchMock = async (input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/uos/auth")) {
      authRequests.push(new Headers(options?.headers).get("Authorization") ?? "");
      return new Response(
        JSON.stringify({ auth: { mode: "disabled", is_admin: true, is_super_admin: true } }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } });
  };
  const restore = [
    setGlobal("document", documentTarget),
    setGlobal("location", new URL("http://127.0.0.1:8000")),
    setGlobal("localStorage", {
      getItem: (key: string) => localStorageItems.get(key) ?? null,
      setItem: (key: string, value: string) => localStorageItems.set(key, value),
      removeItem: (key: string) => localStorageItems.delete(key),
    }),
    setGlobal("addEventListener", windowTarget.addEventListener.bind(windowTarget)),
    setGlobal("removeEventListener", windowTarget.removeEventListener.bind(windowTarget)),
    setGlobal("fetch", fetchMock),
    setGlobal("setTimeout", setTimeoutMock),
    setGlobal("clearTimeout", clearTimeoutMock),
    setGlobal("__uosNetworkTraceInstalled", true),
  ];

  try {
    const chatModule = "../static/chat.js?chat-auth-debounce";
    await import(chatModule);
    await flushMicrotasks();
    const tokenInput = documentTarget.getElementById("token");
    const authBadge = documentTarget.getElementById("auth-badge");
    assert.equal(authRequests.length, 1, "initialization should probe local authentication");
    assert.equal(authBadge.dataset.state, "ok");

    tokenInput.value = "pending-token";
    tokenInput.dispatchEvent(new Event("input"));
    assert.equal(timers.size, 2, "non-empty input should schedule persistence and auth checks");

    tokenInput.value = "";
    tokenInput.dispatchEvent(new Event("input"));
    assert.equal(timers.size, 1, "empty-token input should cancel the pending auth check");
    await flushMicrotasks();
    assert.equal(authRequests.length, 2, "empty-token input should probe local authentication");
    assert.equal(authRequests[1], "", "local authentication should not send a stale token");
    assert.equal(authBadge.dataset.state, "ok", "local authentication should succeed before pending timers run");

    const pendingTimers = [...timers.values()];
    timers.clear();
    pendingTimers.forEach(({ callback }) => callback());
    assert.equal(authBadge.textContent, "Local super admin");
    assert.equal(authBadge.dataset.state, "ok", "a stale token check must not report Missing token");
  } finally {
    timers.clear();
    for (const restoreGlobal of restore.toReversed()) restoreGlobal();
  }
});
