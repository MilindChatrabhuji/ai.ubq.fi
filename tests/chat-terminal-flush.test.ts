import { test } from "bun:test";
import assert from "node:assert/strict";

class ChatElement extends EventTarget {
  dataset: Record<string, string | undefined> = {};
  children: ChatElement[] = [];
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  scrollTop = 0;
  scrollHeight = 0;
  isConnected = true;
  private _text = "";

  get textContent(): string {
    return this._text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this._text = value;
    this.children = [];
  }

  appendChild(child: ChatElement): ChatElement {
    this.children.push(child);
    return child;
  }

  append(child: ChatElement): void {
    this.appendChild(child);
  }

  setAttribute(name: string, value: string): void {
    if (!name.startsWith("data-")) return;
    const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    this.dataset[key] = value;
  }

  querySelector(selector: string): ChatElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ChatElement[] {
    const matches = selector === "[data-message-content]" ? this.children.filter((child) => child.dataset.messageContent !== undefined) : [];
    return [...matches, ...this.children.flatMap((child) => child.querySelectorAll(selector))];
  }

  focus(): void {}

  remove(): void {
    this.isConnected = false;
  }
}

class ChatDocument extends EventTarget {
  visibilityState = "visible";
  body = new ChatElement();
  private _elements = new Map<string, ChatElement>();

  getElementById(id: string): ChatElement {
    const element = this._elements.get(id) ?? new ChatElement();
    this._elements.set(id, element);
    return element;
  }

  createElement(): ChatElement {
    return new ChatElement();
  }

  createElementNS(): ChatElement {
    return new ChatElement();
  }

  querySelector(): ChatElement {
    return this.getElementById("chat-stats");
  }

  querySelectorAll(): ChatElement[] {
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

const until = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.fail("chat did not reach the expected stream checkpoint");
};

type TerminalCase = "completed" | "failed" | "truncated" | "invalid" | "empty" | "read-error" | "stopped";

const terminalText: Record<TerminalCase, string> = {
  completed: "partial tail",
  failed: "partial tail\n\n[fixture failure]",
  truncated: "partial tail\n\n[The response stream ended before completion.]",
  invalid: "partial tail\n\n[The response stream returned an invalid event.]",
  empty: "The response stream completed with no assistant output.",
  "read-error": "Request failed.",
  stopped: "[stopped]",
};

test("shipped chat fences rAF and fallback timer flushes after every terminal path", async () => {
  const documentTarget = new ChatDocument();
  const windowTarget = new EventTarget();
  const restore = [
    setGlobal("document", documentTarget),
    setGlobal("location", new URL("https://chat.fixture.invalid")),
    setGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }),
    setGlobal("addEventListener", windowTarget.addEventListener.bind(windowTarget)),
    setGlobal("removeEventListener", windowTarget.removeEventListener.bind(windowTarget)),
    setGlobal("__uosNetworkTraceInstalled", true),
  ];
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextHandle = 0;
  const frameScheduler = (callback: () => void) => {
    nextHandle += 1;
    frames.set(nextHandle, callback);
    return nextHandle;
  };
  restore.push(
    setGlobal("setTimeout", (callback: () => void, delay = 0) => {
      nextHandle += 1;
      timers.set(nextHandle, { callback, delay });
      return nextHandle;
    }),
    setGlobal("clearTimeout", (handle: number) => timers.delete(handle)),
    setGlobal("requestAnimationFrame", frameScheduler)
  );
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const getController = (): ReadableStreamDefaultController<Uint8Array> | undefined => streamController;
  restore.push(
    setGlobal("fetch", (input: RequestInfo | URL, options?: RequestInit) => {
      assert.equal(input instanceof Request ? input.url : String(input), "https://chat.fixture.invalid/v1/chat/completions");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          options?.signal?.addEventListener(
            "abort",
            () => {
              controller.error(new DOMException("Stopped", "AbortError"));
            },
            { once: true }
          );
        },
      });
      return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    })
  );
  try {
    // Import the complete production module and exercise its registered submit/stop handlers.
    await import("../static/chat.js");
    documentTarget.getElementById("token").value = "fixture-token";
    const messages = documentTarget.getElementById("messages");
    const send = documentTarget.getElementById("send");
    const encoder = new TextEncoder();
    const runScenario = async (mode: "raf" | "timeout", scenario: TerminalCase) => {
      frames.clear();
      timers.clear();
      streamController = undefined;
      documentTarget.getElementById("prompt").value = `${mode} ${scenario}`;
      documentTarget.getElementById("chat-form").dispatchEvent(new Event("submit", { cancelable: true }));
      await until(() => getController() !== undefined && messages.children.at(-1)?.dataset.streaming !== undefined);
      const controller = getController();
      assert.ok(controller);
      const assistant = messages.children.at(-1);
      assert.ok(assistant);
      const delta = (text: string) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      };
      const flushes = () => (mode === "raf" ? [...frames.values()] : [...timers.values()].filter((timer) => timer.delay === 16).map((timer) => timer.callback));
      delta(scenario === "empty" ? " " : "partial");
      await until(() => flushes().length === 1);
      flushes()[0]();
      frames.clear();
      timers.clear();
      assert.equal(assistant.textContent, scenario === "empty" ? " " : "partial", "active callbacks must still render live text");
      delta(scenario === "empty" ? " " : " tail");
      await until(() => flushes().length === 1);
      const deferredFlush = flushes()[0];
      if (scenario === "stopped") documentTarget.getElementById("stop").dispatchEvent(new Event("click"));
      else if (scenario === "read-error") controller.error(new Error("fixture reader failure"));
      else {
        if (scenario === "failed") controller.enqueue(encoder.encode('data: {"error":{"message":"fixture failure"}}\n\n'));
        if (scenario === "invalid") controller.enqueue(encoder.encode("data: invalid-json\n\n"));
        if (scenario !== "truncated") controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
      await until(() => !send.disabled);
      assert.equal(assistant.dataset.streaming, undefined);
      assert.equal(assistant.textContent, terminalText[scenario], `${mode} ${scenario} terminal text`);
      documentTarget.visibilityState = "hidden";
      documentTarget.visibilityState = "visible";
      deferredFlush();
      assert.equal(assistant.textContent, terminalText[scenario], `${mode} ${scenario} delayed callback must preserve terminal text`);
    };
    for (const mode of ["raf", "timeout"] as const) {
      Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: mode === "raf" ? frameScheduler : undefined });
      for (const scenario of Object.keys(terminalText) as TerminalCase[]) {
        await runScenario(mode, scenario);
      }
    }
  } finally {
    for (const restoreGlobal of restore.toReversed()) restoreGlobal();
  }
});
