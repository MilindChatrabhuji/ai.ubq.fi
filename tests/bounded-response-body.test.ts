import { test } from "bun:test";
import { runSequence } from "./helpers/sequence.ts";
import assert from "node:assert/strict";
import { BOUNDED_RESPONSE_BODY_MAX_BYTES, readBoundedResponseBody } from "../src/bounded-response-body.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("bounded response body reads fragmented complete bodies", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("frag"));
        controller.enqueue(encoder.encode("mented"));
        controller.close();
      },
    })
  );

  const result = await readBoundedResponseBody(response);
  assert.equal(result.complete, true);
  assert.equal(decoder.decode(result.bytes), "fragmented");
});

test("bounded response body recognizes EOF exactly at the byte limit", async () => {
  let cancellations = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(BOUNDED_RESPONSE_BODY_MAX_BYTES));
        controller.close();
      },
      cancel() {
        cancellations += 1;
      },
    })
  );

  const result = await readBoundedResponseBody(response);
  assert.equal(result.complete, true);
  assert.equal(result.bytes.byteLength, BOUNDED_RESPONSE_BODY_MAX_BYTES);
  assert.equal(cancellations, 0);
});

test("bounded response body truncates and cancels oversized bodies", async () => {
  let cancellations = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(BOUNDED_RESPONSE_BODY_MAX_BYTES + 1));
      },
      cancel() {
        cancellations += 1;
      },
    })
  );

  const result = await readBoundedResponseBody(response);
  assert.equal(result.complete, false);
  assert.equal(result.bytes.byteLength, BOUNDED_RESPONSE_BODY_MAX_BYTES);
  await new Promise<void>((resolve) => {
    queueMicrotask(() => {
      resolve();
    });
  });
  assert.equal(cancellations, 1);
});

test("bounded response body respects timeout and caller abort", () =>
  runSequence(async (step) => {
    const pendingResponse = (onCancel: () => void): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => {}),
          cancel: onCancel,
        })
      );

    await step("timeout", async () => {
      let cancellations = 0;
      const startedAt = performance.now();
      const result = await readBoundedResponseBody(
        pendingResponse(() => {
          cancellations += 1;
        }),
        { timeoutMs: 10 }
      );
      assert.equal(result.complete, false);
      assert.ok(performance.now() - startedAt < 500);
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          resolve();
        });
      });
      assert.equal(cancellations, 1);
    });

    await step("caller abort", async () => {
      let cancellations = 0;
      const controller = new AbortController();
      queueMicrotask(() => {
        controller.abort("caller cancelled");
      });
      const result = await readBoundedResponseBody(
        pendingResponse(() => {
          cancellations += 1;
        }),
        {
          signal: controller.signal,
          timeoutMs: 1_000,
        }
      );
      assert.equal(result.complete, false);
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          resolve();
        });
      });
      assert.equal(cancellations, 1);
    });
  }));

test("bounded response body releases an incomplete reader exactly once", async () => {
  let releases = 0;
  let cancellations = 0;
  const reader = {
    read: () => Promise.resolve({ done: false, value: new Uint8Array(2) }),
    cancel: () => {
      cancellations += 1;
      return Promise.resolve();
    },
    releaseLock: () => (releases += 1),
  };
  const response = { body: { getReader: () => reader } } as unknown as Response;

  const result = await readBoundedResponseBody(response, { maxBytes: 1 });
  assert.equal(result.complete, false);
  await new Promise<void>((resolve) => {
    queueMicrotask(() => {
      resolve();
    });
  });
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
});

test("bounded response body releases native readers before stalled cancellation settles", () =>
  runSequence(async (step) => {
    for (const mode of ["timeout", "overflow"] as const) {
      await step(mode, async () => {
        let cancellations = 0;
        let cancellationSettled = false;
        const { promise, resolve } = Promise.withResolvers<undefined>();
        const cancellation = promise.then(() => {
          cancellationSettled = true;
        });
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (mode === "overflow") controller.enqueue(new Uint8Array([1, 2]));
          },
          cancel() {
            cancellations += 1;
            return cancellation;
          },
        });
        const startedAt = performance.now();
        const boundedRead = readBoundedResponseBody(new Response(body), { maxBytes: 1, timeoutMs: 10 });
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            boundedRead,
            new Promise<never>((_, reject) => {
              watchdog = setTimeout(() => {
                reject(new Error("Bounded read waited for stalled cancellation."));
              }, 500);
            }),
          ]);
          assert.ok(performance.now() - startedAt < 500);
          assert.equal(result.complete, false);
          assert.deepEqual(result.bytes, mode === "overflow" ? new Uint8Array([1]) : new Uint8Array());
          assert.equal(cancellations, 1);
          assert.equal(cancellationSettled, false);
          assert.equal(body.locked, false);
          const reader = body.getReader();
          try {
            assert.deepEqual(await reader.read(), { done: true, value: undefined });
          } finally {
            reader.releaseLock();
          }
        } finally {
          clearTimeout(watchdog);
          resolve(undefined);
          await cancellation;
          await boundedRead;
        }
        assert.equal(cancellations, 1);
        assert.equal(body.locked, false);
      });
    }
  }));
