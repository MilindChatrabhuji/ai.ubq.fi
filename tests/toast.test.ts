import { test } from "bun:test";
import assert from "node:assert/strict";
import { toast } from "../static/toast.js";

class ToastElement {
  readonly dataset: Record<string, string> = {};
  readonly children: ToastElement[] = [];
  readonly listeners = new Map<string, () => void>();
  textContent = "";
  parent: ToastElement | null = null;
  private _queries = 0;

  constructor(private readonly _root = false) {}

  get isConnected(): boolean {
    return this.parent?.isConnected ?? this._root;
  }

  setAttribute(name: string, value: string): void {
    if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
  }

  appendChild(child: ToastElement): void {
    child.parent = this;
    this.children.push(child);
  }

  append(child: ToastElement): void {
    this.appendChild(child);
  }

  addEventListener(name: string, callback: () => void): void {
    this.listeners.set(name, callback);
  }

  querySelectorAll(selector: string): ToastElement[] {
    if (++this._queries > 100) throw new Error("Toast eviction did not converge");
    assert.ok(selector === "[data-toast]" || selector === "[data-toast]:not([data-exiting])");
    return this.children.filter((child) => "toast" in child.dataset && (selector === "[data-toast]" || !("exiting" in child.dataset)));
  }

  querySelector(selector: string): ToastElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

test("a synchronous toast burst keeps three active notifications while older nodes exit", () => {
  const body = new ToastElement(true);
  const timers: { callback: () => void; delay: number }[] = [];
  const replacements = {
    document: {
      body,
      createElement: () => new ToastElement(),
      createElementNS: () => new ToastElement(),
    },
    requestAnimationFrame: (callback: () => void) => {
      callback();
    },
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length;
    },
  };

  const originals = new Map(Object.keys(replacements).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    // The query budget makes a non-converging synchronous loop fail instead of hanging the test runner.
    for (let i = 1; i <= 6; i++) toast.info(String(i), { duration: 0 });

    const host = body.children[0];
    assert.equal(host.children.length, 6, "evicted nodes remain during the exit animation");
    assert.deepEqual(
      host.querySelectorAll("[data-toast]:not([data-exiting])").map((element) => element.children[0].textContent),
      ["4", "5", "6"],
      "the oldest active notifications are evicted first"
    );
    assert.deepEqual(
      timers.map((timer) => timer.delay),
      [160, 160, 160]
    );
    for (const timer of timers) timer.callback();
    assert.equal(host.children.length, 3, "exit timers remove the evicted nodes");
    assert.equal(host.querySelectorAll("[data-toast]:not([data-exiting])").length, 3);
  } finally {
    body.children[0]?.remove();
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("loading toasts persist beyond normal durations and remain dismissible after completion", () => {
  const body = new ToastElement(true);
  const timers = new Map<number, { callback: () => void; deadline: number }>();
  let now = 0;
  let nextTimerId = 0;
  let dismissals = 0;
  const replacements = {
    document: {
      body,
      createElement: () => new ToastElement(),
      createElementNS: () => new ToastElement(),
    },
    requestAnimationFrame: (callback: () => void) => {
      callback();
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, deadline: now + delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  };
  const advance = (milliseconds: number) => {
    const until = now + milliseconds;
    while (timers.size > 0) {
      const next = [...timers].sort((a, b) => a[1].deadline - b[1].deadline)[0];
      if (next[1].deadline > until) break;
      now = next[1].deadline;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = until;
  };
  const originals = new Map(Object.keys(replacements).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const originalNow = Date.now;
  try {
    for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    Date.now = () => now;
    const loading = toast.loading("Sending", { onDismiss: () => dismissals++ });
    const host = body.children[0];
    const loadingEl = host.children[0];
    toast.info("Normal notification");
    const normalEl = host.children[1];

    advance(4000);
    assert.equal(normalEl.dataset.exiting, "", "ordinary info toasts still expire at four seconds");
    advance(160);
    assert.equal(normalEl.isConnected, false);
    advance(10_000);
    assert.equal(loadingEl.isConnected, true, "loading stays mounted beyond the ordinary duration");
    assert.equal(loadingEl.dataset.visible, "");
    assert.equal(loadingEl.dataset.exiting, undefined);
    assert.equal(dismissals, 0);
    loadingEl.listeners.get("mouseenter")?.();
    loadingEl.listeners.get("mouseleave")?.();
    advance(10_000);
    assert.equal(loadingEl.dataset.exiting, undefined, "hovering does not start a loading timer");

    loading.update({ type: "success", title: "Sent" });
    assert.equal(loadingEl.dataset.type, "success");
    assert.equal(loadingEl.children[0].textContent, "Sent");
    toast.dismiss(loading);
    assert.equal(loadingEl.dataset.exiting, "");
    assert.equal(dismissals, 1);
    advance(159);
    assert.equal(loadingEl.isConnected, true, "completion dismissal retains the existing exit fade");
    advance(1);
    assert.equal(loadingEl.isConnected, false);

    toast.loading("Another request");
    const manualEl = host.children[0];
    advance(10_000);
    assert.equal(manualEl.dataset.exiting, undefined);
    manualEl.children[1].listeners.get("click")?.();
    advance(160);
    assert.equal(manualEl.isConnected, false, "the close button still dismisses a loading toast");

    toast.success("Timed success", { duration: 250 });
    const finiteEl = host.children[0];
    advance(249);
    assert.equal(finiteEl.dataset.exiting, undefined);
    advance(1);
    assert.equal(finiteEl.dataset.exiting, "", "explicit finite durations still expire on schedule");
    advance(160);
    assert.equal(finiteEl.isConnected, false);

    toast.success("Hovered success");
    const hoveredEl = host.children[0];
    advance(1000);
    hoveredEl.listeners.get("mouseenter")?.();
    advance(10_000);
    assert.equal(hoveredEl.dataset.exiting, undefined, "hovering pauses the toast past its original deadline");
    hoveredEl.listeners.get("mouseleave")?.();
    advance(2499);
    assert.equal(hoveredEl.dataset.exiting, undefined, "the toast remains for its captured remaining duration");
    advance(1);
    assert.equal(hoveredEl.dataset.exiting, "", "the toast expires after the captured remaining duration");
  } finally {
    body.children[0]?.remove();
    Date.now = originalNow;
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
