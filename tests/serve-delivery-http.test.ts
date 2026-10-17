import { test } from "bun:test";
import { serveHttp, type NetAddr } from "#http";
import assert from "node:assert/strict";
import { createServeHandler } from "../src/handler/serve-handler.ts";
import { withTerminalRequestLog } from "../src/handler/terminal-log.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const disconnectPressure = encoder.encode(`: ${"x".repeat(64 * 1_024)}\n\n`);

const ignoredTelemetry = () =>
  Promise.resolve({
    status: "ignored" as const,
    reason: "unknown_release" as const,
    release: null,
    provider: null,
    route: null,
    model_hash: null,
  });

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const terminalPayloads = (logs: unknown[][], requestId: string): Record<string, unknown>[] =>
  logs
    .filter((entry) => entry[0] === "[ai.ubq.fi] request_terminal")
    .map((entry) => JSON.parse(String(entry[1])) as Record<string, unknown>)
    .filter((payload) => payload.request_id === requestId);

test("serve.ts classifies delivered and client-cancelled SSE responses from real HTTP completion", async () => {
  const originalInfo = console.info;
  const logs: unknown[][] = [];
  const signals = new Map<string, AbortSignal>();
  let interruptedSourceCancelled = 0;
  let interruptedClient: AbortController | null = null;
  let interruptedReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  console.info = (...args: unknown[]) => logs.push(args);

  const serveHandler = createServeHandler(async (request, delivery) => {
    const requestId = new URL(request.url).pathname === "/delivered" ? "served-delivered" : "served-interrupted";
    signals.set(requestId, delivery.downstreamSignal);
    const body =
      requestId === "served-delivered"
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: delivered\n\n"));
              controller.close();
            },
          })
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: interrupted\n\n"));
            },
            pull(controller) {
              controller.enqueue(disconnectPressure);
            },
            cancel() {
              interruptedSourceCancelled += 1;
            },
          });
    return await withTerminalRequestLog(new Response(body, { headers: { "Content-Type": "text/event-stream" } }), {
      route: "responses",
      startedAtMonotonicMs: performance.now(),
      requestId,
      deliveryCompleted: delivery.completed,
      deliverySignal: delivery.downstreamSignal,
      recordTelemetry: ignoredTelemetry,
    });
  });
  const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, serveHandler);
  await server.ready;

  try {
    const address = server.addr as NetAddr;
    const deliveredResponse = await fetch(`http://127.0.0.1:${address.port}/delivered`);
    assert.equal(await deliveredResponse.text(), "data: delivered\n\n");
    await waitFor(() => terminalPayloads(logs, "served-delivered").length === 1, "delivered terminal event");
    const deliveredTerminals = terminalPayloads(logs, "served-delivered");
    assert.equal(deliveredTerminals.length, 1);
    assert.equal(deliveredTerminals[0]?.delivery_outcome, "delivered");
    assert.equal(signals.get("served-delivered")?.aborted, false);

    interruptedClient = new AbortController();
    const interruptedResponse = await fetch(`http://127.0.0.1:${address.port}/interrupted`, {
      signal: interruptedClient.signal,
    });
    assert.ok(interruptedResponse.body);
    interruptedReader = interruptedResponse.body.getReader();
    const firstInterruptedChunk = await interruptedReader.read();
    assert.equal(firstInterruptedChunk.done, false);
    assert.match(decoder.decode(firstInterruptedChunk.value), /data: interrupted/);
    interruptedClient.abort(new DOMException("client disconnected", "AbortError"));
    await interruptedReader.cancel(interruptedClient.signal.reason).catch(() => {});

    await waitFor(() => interruptedSourceCancelled === 1, "upstream stream cancellation");
    await waitFor(() => terminalPayloads(logs, "served-interrupted").length === 1, "interrupted terminal event");
    const interruptedTerminals = terminalPayloads(logs, "served-interrupted");
    assert.equal(interruptedTerminals.length, 1);
    assert.equal(interruptedTerminals[0]?.delivery_outcome, "interrupted");
    assert.equal(interruptedSourceCancelled, 1);
  } finally {
    try {
      if (interruptedClient !== null && !interruptedClient.signal.aborted) {
        interruptedClient.abort(new DOMException("test cleanup", "AbortError"));
      }
      if (interruptedReader !== null) {
        await interruptedReader.cancel(interruptedClient?.signal.reason).catch(() => {});
      }
      await server.shutdown();
    } finally {
      console.info = originalInfo;
    }
  }
}, 300_000);
