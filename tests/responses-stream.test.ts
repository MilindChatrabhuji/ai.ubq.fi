import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  MAX_RESPONSES_SSE_EVENT_BYTES,
  preflightResponsesStream,
  proxyResponsesStream,
  readResponsesStream,
  ResponsesStreamError,
  withSseKeepalive,
} from "../src/responses-stream.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const captureError = async (run: () => Promise<void>): Promise<unknown> => {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) assert.fail("Expected operation to reject");
  return caught;
};

const chunked = (value: string, boundaries: number[], cancel?: () => void): ReadableStream<Uint8Array> => {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      const end = boundaries.shift() ?? value.length;
      if (offset >= value.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes(value.slice(offset, end)));
      offset = end;
      if (offset >= value.length) controller.close();
    },
    cancel,
  });
};

test("Responses SSE parser handles mixed separators, multiline data, and fragmented UTF-8", async () => {
  const payload =
    ': keepalive\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"hi 🌍"}\r\n\r\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}';
  const encoded = bytes(payload);
  for (let boundary = 1; boundary < encoded.length; boundary += 1) {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, boundary));
        controller.enqueue(encoded.slice(boundary));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readResponsesStream(source)) events.push(event);
    assert.deepEqual(
      events.map((event) => event.type),
      ["response.output_text.delta", "response.completed"]
    );
  }
});

test("Responses SSE parser accepts an LF then CRLF event boundary", async () => {
  const source = chunked(
    'data: {"type":"response.output_text.delta","delta":"x"}\n\r\n' + 'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n',
    []
  );
  const events = [];
  for await (const event of readResponsesStream(source)) events.push(event);
  assert.deepEqual(
    events.map((event) => event.type),
    ["response.output_text.delta", "response.completed"]
  );
});

test("Responses SSE parser rejects malformed JSON and EOF before terminal", async () => {
  const malformed = await captureError(async () => {
    await Array.fromAsync(readResponsesStream(chunked("data: nope\n\n", [])));
  });
  assert.ok(malformed instanceof ResponsesStreamError);
  assert.equal(malformed.kind, "malformed_event");
  const eof = await captureError(async () => {
    await Array.fromAsync(readResponsesStream(chunked('data: {"type":"response.output_text.delta","delta":"x"}\n\n', [])));
  });
  assert.ok(eof instanceof ResponsesStreamError);
  assert.match(eof.message, /before a terminal event/);
  assert.equal(eof.kind, "premature_eof");
});

test("Responses parser rejects terminal events without their protocol payload", async () => {
  const error = await captureError(async () => {
    await Array.fromAsync(readResponsesStream(chunked('data: {"type":"response.completed"}\n\n', [])));
  });
  assert.ok(error instanceof ResponsesStreamError);
  assert.equal(error.kind, "malformed_event");
});

test("Responses parser rejects array-valued terminal response payloads", async () => {
  for (const type of ["response.completed", "response.failed", "response.incomplete"]) {
    const error = await captureError(async () => {
      await Array.fromAsync(readResponsesStream(chunked(`data: ${JSON.stringify({ type, response: [] })}\n\n`, [])));
    });
    assert.ok(error instanceof ResponsesStreamError, type);
    assert.equal(error.kind, "malformed_event", type);
  }
});

test("Responses parser rejects an array-valued nested error payload", async () => {
  const error = await captureError(async () => {
    await Array.fromAsync(readResponsesStream(chunked('data: {"type":"error","error":[]}\n\n', [])));
  });
  assert.ok(error instanceof ResponsesStreamError);
  assert.equal(error.kind, "malformed_event");
});

test("Responses parser rejects an array-valued nested error despite valid flat fields", async () => {
  const error = await captureError(async () => {
    await Array.fromAsync(
      readResponsesStream(chunked('data: {"type":"error","error":[],"code":"provider_error","message":"Provider stopped.","param":null}\n\n', []))
    );
  });
  assert.ok(error instanceof ResponsesStreamError);
  assert.equal(error.kind, "malformed_event");
});

test("Responses parser accepts an official flat error terminal", async () => {
  const events = [];
  for await (const event of readResponsesStream(chunked('data: {"type":"error","code":"provider_error","message":"Provider stopped.","param":null}\n\n', [])))
    events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  assert.equal(events[0]?.value.code, "provider_error");
});

test("Responses parser accepts a nullable code in an official flat error terminal", async () => {
  const events = [];
  for await (const event of readResponsesStream(chunked('data: {"type":"error","code":null,"message":"Provider stopped.","param":"input"}\n\n', [])))
    events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.value.code, null);
  assert.equal(events[0]?.value.param, "input");
});

test("Responses preflight surfaces immediate failures before a stream response is created", async () => {
  const malformed = await captureError(async () => {
    await preflightResponsesStream(chunked("data: nope\n\n", []));
  });
  assert.ok(malformed instanceof ResponsesStreamError);
  assert.equal(malformed.kind, "malformed_event");

  const eof = await captureError(async () => {
    await preflightResponsesStream(chunked("", []));
  });
  assert.ok(eof instanceof ResponsesStreamError);
  assert.equal(eof.kind, "premature_eof");
});

test("Responses activity observes comments and partial frames before parsed events", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(": keepalive\n\n"));
      controller.enqueue(bytes('data: {"type":"response.output_text.delta",'));
      controller.enqueue(bytes('"delta":"x"}\n\n'));
      controller.enqueue(bytes('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'));
      controller.close();
    },
  });
  let activityCount = 0;
  const events = [];
  for await (const event of readResponsesStream(source, undefined, {
    onActivity: () => {
      activityCount += 1;
    },
  }))
    events.push(event);

  assert.equal(activityCount, 4);
  assert.deepEqual(
    events.map((event) => event.type),
    ["response.output_text.delta", "response.completed"]
  );
});

test("Responses parser wraps reader exceptions and releases its lock", async () => {
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("socket reset"));
    },
  });
  const error = await captureError(async () => {
    await Array.fromAsync(readResponsesStream(source));
  });
  assert.ok(error instanceof ResponsesStreamError);
  assert.equal(error.kind, "read_error");
  assert.equal(source.locked, false);
});

test("Responses parser keeps one absolute first-event deadline across non-event frames", async () => {
  let cancelled = 0;
  let active = true;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      setTimeout(() => {
        if (active) controller.enqueue(bytes(": keepalive\n\n"));
      }, 2);
    },
    cancel() {
      active = false;
      cancelled += 1;
    },
  });
  const error = await captureError(async () => {
    // No data event is ever emitted.
    await Array.fromAsync(readResponsesStream(source, undefined, { firstEventTimeoutMs: 12 }));
  });
  assert.ok(error instanceof ResponsesStreamError);
  assert.equal(error.kind, "inactivity_timeout");
  assert.equal(cancelled, 1);
});

test("Responses parser rejects one fragmented oversized SSE event and cancels once", async () => {
  let cancelled = 0;
  const oversized = `data: ${"x".repeat(MAX_RESPONSES_SSE_EVENT_BYTES + 1)}`;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      const value = bytes(oversized);
      const middle = Math.floor(value.byteLength / 2);
      controller.enqueue(value.slice(0, middle));
      controller.enqueue(value.slice(middle));
    },
    cancel() {
      cancelled += 1;
    },
  });
  const error = await captureError(async () => {
    await Array.fromAsync(readResponsesStream(source));
  });
  assert.ok(error instanceof ResponsesStreamError);
  assert.equal(error.kind, "event_too_large");
  assert.equal(cancelled, 1);
});

test("Responses proxy forwards only the first terminal and cancels a hanging upstream once", async () => {
  let cancelCount = 0;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        bytes(
          'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n' +
            'data: {"type":"response.output_text.delta","delta":"post-terminal"}\n\n'
        )
      );
    },
    cancel() {
      cancelCount += 1;
    },
  });
  const output = await new Response(proxyResponsesStream(source)).text();
  assert.match(output, /response.incomplete/);
  assert.doesNotMatch(output, /response.completed/);
  assert.doesNotMatch(output, /post-terminal/);
  assert.equal(cancelCount, 1);
  for (let turn = 0; source.locked && turn < 10; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(source.locked, false);
});

test("Responses proxy keeps first-event delivery, byte framing, and terminal cancellation incremental", async () => {
  const firstFrame = 'data: {"type":"response.output_text.delta","delta":"first"}\n\n';
  const terminalFrame = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  let releaseTerminal = (): void => {};
  const terminalGate = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  let firstSent = false;
  let terminalScheduled = false;
  let upstreamCancelCount = 0;
  let resolveCancelled = (): void => {};
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!firstSent) {
        firstSent = true;
        controller.enqueue(bytes(firstFrame));
        return;
      }
      if (terminalScheduled) return;
      terminalScheduled = true;
      return terminalGate.then(() => {
        controller.enqueue(bytes(terminalFrame));
      });
    },
    cancel() {
      upstreamCancelCount += 1;
      resolveCancelled();
    },
  });

  const reader = proxyResponsesStream(source).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error("first SSE event was delayed"));
      }, 100)
    ),
  ]);
  if (first.done) assert.fail("Expected the first SSE event before the terminal event was released.");
  assert.equal(new TextDecoder().decode(first.value), firstFrame);

  const terminalRead = reader.read();
  const terminalBeforeRelease = await Promise.race([
    terminalRead.then(() => true),
    new Promise<false>((resolve) =>
      setTimeout(() => {
        resolve(false);
      }, 20)
    ),
  ]);
  assert.equal(terminalBeforeRelease, false);
  releaseTerminal();

  const terminal = await terminalRead;
  if (terminal.done) assert.fail("Expected the terminal SSE event.");
  assert.equal(new TextDecoder().decode(terminal.value), terminalFrame);
  const done = await reader.read();
  assert.equal(done.done, true);
  await Promise.race([
    cancelled,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error("terminal did not cancel upstream"));
      }, 100)
    ),
  ]);
  assert.equal(upstreamCancelCount, 1);
  assert.equal(
    bytes(new TextDecoder().decode(first.value) + new TextDecoder().decode(terminal.value)).byteLength,
    bytes(firstFrame).byteLength + bytes(terminalFrame).byteLength
  );
  assert.equal(new TextDecoder().decode(first.value) + new TextDecoder().decode(terminal.value), `${firstFrame}${terminalFrame}`);
  assert.equal(source.locked, false);
});

test("Responses proxy emits an official error event after premature EOF", async () => {
  const source = chunked('data: {"type":"response.output_text.delta","delta":"x"}\n\n', []);
  const output = await new Response(proxyResponsesStream(source)).text();
  assert.match(output, /response.output_text.delta/);
  assert.match(output, /event: error/);
  assert.doesNotMatch(output, /response.completed/);
});

test("SSE keepalive emits short comment bursts while the provider is quiet", async () => {
  const encoder = new TextEncoder();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      void gate.then(() => {
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'));
        controller.close();
      });
    },
  });
  const reader = withSseKeepalive(source, { intervalMs: 5 }).getReader();
  const heartbeat = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error("keepalive was delayed"));
      }, 100)
    ),
  ]);
  assert.equal(heartbeat.done, false);
  assert.equal(new TextDecoder().decode(heartbeat.value), ": keepalive\n\n");

  release();
  const terminal = await reader.read();
  assert.equal(terminal.done, false);
  assert.match(new TextDecoder().decode(terminal.value), /response.completed/);
  assert.equal((await reader.read()).done, true);
});

test("Responses proxy does not wait for lifecycle callbacks before terminal delivery", async () => {
  const never = new Promise<void>(() => {});
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'));
    },
  });
  const output = await Promise.race([
    new Response(proxyResponsesStream(source, { onEvent: () => never })).text(),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error("terminal delivery was delayed"));
      }, 100)
    ),
  ]);
  assert.match(output, /response.completed/);
});

test("Responses proxy cancellation is forwarded once without waiting for bookkeeping", async () => {
  let upstreamCancelCount = 0;
  let downstreamCancelCount = 0;
  const never = new Promise<void>(() => {});
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes('data: {"type":"response.output_text.delta","delta":"x"}\n\n'));
    },
    cancel() {
      upstreamCancelCount += 1;
    },
  });
  const reader = proxyResponsesStream(source, {
    onCancel: () => {
      downstreamCancelCount += 1;
      return never;
    },
  }).getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await Promise.race([
    reader.cancel("downstream disconnected"),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error("cancel was delayed"));
      }, 100)
    ),
  ]);
  await Promise.resolve();
  assert.equal(downstreamCancelCount, 1);
  assert.equal(upstreamCancelCount, 1);
  assert.equal(source.locked, false);
});
