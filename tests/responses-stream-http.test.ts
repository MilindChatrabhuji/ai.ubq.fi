import { test } from "bun:test";
import { serveHttp, type NetAddr } from "#http";
import assert from "node:assert/strict";
import { proxyResponsesStream } from "../src/responses-stream.ts";

// Timer callbacks are hoisted out of the stream's `start` method so the nested
// closure depth stays within the lint ceiling: the stream controller, the timer
// registry, and the payload are passed in as parameters instead of captured.
const scheduleEnqueue = (
  timers: Set<ReturnType<typeof setTimeout>>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: Uint8Array,
  delayMs: number
): void => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    controller.enqueue(payload);
  }, delayMs);
  timers.add(timer);
};

const scheduleClose = (timers: Set<ReturnType<typeof setTimeout>>, controller: ReadableStreamDefaultController<Uint8Array>, delayMs: number): void => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    controller.close();
  }, delayMs);
  timers.add(timer);
};

test("Responses proxy terminates a fragmented real HTTP stream without waiting for trailing bytes", async () => {
  const encoder = new TextEncoder();
  const delta = encoder.encode('data: {"type":"response.output_text.delta","delta":"real HTTP 🌍"}\n\n');
  const terminal = encoder.encode('data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n');
  const emojiStart = delta.indexOf(0xf0);
  assert.ok(emojiStart >= 0, "the fixture must contain the four-byte UTF-8 emoji");
  const chunks = [
    delta.slice(0, emojiStart + 2),
    delta.slice(emojiStart + 2),
    terminal.slice(0, 7),
    terminal.slice(7, terminal.length - 1),
    terminal.slice(terminal.length - 1),
  ];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let upstreamCancelled = false;
  let resolveCancelled = () => {};
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });

  const server = serveHttp(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            chunks.forEach((chunk, index) => {
              scheduleEnqueue(timers, controller, chunk, 5 * (index + 1));
            });
            scheduleEnqueue(timers, controller, encoder.encode('data: {"type":"response.output_text.delta","delta":"post-terminal"}\n\n'), 250);
            scheduleClose(timers, controller, 1_000);
          },
          cancel() {
            upstreamCancelled = true;
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            resolveCancelled();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      )
  );
  await server.ready;

  try {
    const address = server.addr as NetAddr;
    const upstream = await fetch(`http://127.0.0.1:${address.port}/responses`);
    assert.ok(upstream.body);
    const startedAt = performance.now();
    const output = await new Response(proxyResponsesStream(upstream.body)).text();
    const elapsedMs = performance.now() - startedAt;

    assert.match(output, /real HTTP 🌍/);
    assert.match(output, /response.completed/);
    assert.doesNotMatch(output, /post-terminal/);
    assert.ok(elapsedMs < 200, `terminal delivery took ${elapsedMs.toFixed(1)}ms`);
    await Promise.race([
      cancelled,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error("real HTTP upstream was not cancelled"));
        }, 200)
      ),
    ]);
    assert.equal(upstreamCancelled, true);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await server.shutdown();
  }
}, 300_000);
