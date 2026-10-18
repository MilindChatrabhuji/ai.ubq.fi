import { test } from "bun:test";
import assert from "node:assert/strict";
import { DEEPSEEK_RESPONSES_PROFILE } from "../src/deepseek/responses.ts";
import { iterateDeepSeekChatCompletionStream } from "../src/deepseek/stream.ts";
import { createResponseTelemetryState, type UsageTokens } from "../src/openai-telemetry.ts";
import { relayChatCompletionStream, relayResponsesStream, type ProviderStreamAdapter, type ProviderStreamFrame } from "../src/provider/stream-relay.ts";
import {
  appendResponsesPrecommitEvent,
  createOwnedResponsesStream,
  MAX_RESPONSES_PRECOMMIT_CHARS,
  MAX_RESPONSES_PRECOMMIT_EVENTS,
  prepareResponsesStreamForCommit,
  responseEventFromValue,
} from "../src/responses-failover-stream.ts";
import {
  preflightResponsesStream,
  proxyResponsesStream,
  ResponsesStreamError,
  readResponsesStream,
  type ResponsesStreamEvent,
  type ResponsesStreamIterator,
  withSseKeepalive,
} from "../src/responses-stream.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytes = (value: string): Uint8Array => encoder.encode(value);
const sseFrame = (value: Record<string, unknown>): string => `data: ${JSON.stringify(value)}\n\n`;
const deltaFrame = (text: string): string => sseFrame({ type: "response.output_text.delta", delta: text });
const completedFrame = (): string => sseFrame({ type: "response.completed", response: { status: "completed" } });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Races `settled` against a bounded wait; the timer is cleared whichever side wins. */
const settlesWithin = async (settled: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([settled.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Bounded poll for state a stream does not expose as a promise. */
const becomesTrue = async (condition: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadlineAt = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadlineAt) return false;
    await sleep(5);
  }
  return true;
};

const rejectionOf = async (pending: Promise<unknown>): Promise<unknown> => {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  assert.fail("Expected the operation to reject");
};

type UpstreamProbe = Readonly<{
  stream: ReadableStream<Uint8Array>;
  /** Pull callbacks entered so far, i.e. finished plus concurrent upstream reads. */
  started: () => number;
  /** Pull callbacks that have not returned yet, i.e. concurrent upstream reads. */
  pending: () => number;
  /** Resolves once `count` pull callbacks have been entered. */
  startedAtLeast: (count: number) => Promise<void>;
  cancelled: Promise<void>;
  cancelCount: () => number;
}>;

/**
 * A scripted upstream provider. `produce` supplies the frame for one pull, or
 * `null` to hold that read open until the source is cancelled. Entering a pull
 * is the handshake these fixtures wait on instead of assuming microtask turns.
 */
const probeUpstream = (produce?: (pullIndex: number) => Uint8Array | null, highWaterMark = 1): UpstreamProbe => {
  let started = 0;
  let pending = 0;
  let cancelCount = 0;
  let releaseQuiet: (() => void) | null = null;
  let resolveCancelled = (): void => {};
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const waiters = new Set<() => void>();
  const notify = (): void => {
    for (const waiter of [...waiters]) waiter();
  };
  const startedAtLeast = (count: number): Promise<void> => {
    if (started >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter = (): void => {
        if (started < count) return;
        waiters.delete(waiter);
        resolve();
      };
      waiters.add(waiter);
    });
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        started += 1;
        pending += 1;
        notify();
        try {
          const chunk = produce?.(started) ?? null;
          if (chunk === null) {
            await new Promise<void>((resolve) => {
              releaseQuiet = resolve;
            });
            return;
          }
          controller.enqueue(chunk);
        } finally {
          pending -= 1;
          notify();
        }
      },
      cancel() {
        cancelCount += 1;
        releaseQuiet?.();
        releaseQuiet = null;
        resolveCancelled();
      },
    },
    { highWaterMark }
  );
  return { stream, started: () => started, pending: () => pending, startedAtLeast, cancelled, cancelCount: () => cancelCount };
};

/** Releases a probe stream that a failed assertion may have left locked. */
const releaseProbe = async (probe: UpstreamProbe): Promise<void> => {
  if (!probe.stream.locked) await probe.stream.cancel("test cleanup").catch(() => {});
};

/** The real DeepSeek parser owns the body; a gated generator finally exposes settlement ordering. */
const providerRelayFixture = (wire: "chat" | "responses") => {
  const chunk = {
    id: "chatcmpl_lifecycle",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek-flash",
    choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
  const probe = probeUpstream((index) => (index === 1 ? bytes(`${sseFrame(chunk)}data: [DONE]\n\n${sseFrame(chunk)}`) : null));
  const counts = { next: 0, returned: 0, finalized: 0, postDone: 0, health: 0, cancelled: 0, errors: 0 };
  let releaseCleanup = (): void => {};
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let enterCleanup = (): void => {};
  const cleanupEntered = new Promise<void>((resolve) => {
    enterCleanup = resolve;
  });
  let iterator: AsyncGenerator<ProviderStreamFrame, void, unknown> | null = null;
  const adapter: ProviderStreamAdapter = {
    responseHeaders: () => ({}),
    frames: (upstream, model, options) => {
      const frames = (async function* () {
        try {
          for await (const frame of iterateDeepSeekChatCompletionStream(upstream, model, options)) {
            yield frame;
            if (frame.kind === "done") counts.postDone += 1;
          }
        } finally {
          counts.finalized += 1;
          enterCleanup();
          await cleanupGate;
        }
      })();
      const next = frames.next.bind(frames);
      frames.next = (...args) => {
        counts.next += 1;
        return next(...args);
      };
      const finish = frames.return.bind(frames);
      frames.return = (value) => {
        counts.returned += 1;
        return finish(value);
      };
      iterator = frames;
      return frames;
    },
    recordResponseHealth: () => {
      counts.health += 1;
    },
    recordProviderError: () => {
      counts.errors += 1;
    },
    recordCancellation: () => {
      counts.cancelled += 1;
    },
    recordIncompleteResponse: () => {},
    recordFinishFailureKind: () => {},
    recordTransportFailure: () => {},
    terminalTypeForError: () => "response.failed",
    streamErrorCode: "deepseek_upstream_error",
    responsesProfile: DEEPSEEK_RESPONSES_PROFILE,
  };
  const telemetry = createResponseTelemetryState();
  const observedUsage: { usage: UsageTokens | null; completed: boolean }[] = [];
  const usageContext = {
    keyId: null,
    kernelRepo: null,
    kernelOrg: null,
    responseTelemetry: telemetry,
    onTerminalUsage: (usage: UsageTokens | null, completed: boolean) => {
      observedUsage.push({ usage, completed });
    },
  };
  const upstream = new Response(probe.stream);
  const signal = new AbortController().signal;
  const response =
    wire === "chat"
      ? relayChatCompletionStream(adapter, upstream, null, usageContext, signal, signal, "deepseek-flash")
      : relayResponsesStream(adapter, {
          upstream,
          requestedModel: "deepseek-flash",
          responseId: "resp_lifecycle",
          createdAtSeconds: 1,
          echo: { tools: [], tool_choice: "auto", parallel_tool_calls: true, instructions: null },
          toolNames: new Map(),
          customToolNames: new Set(),
          providerRequestId: null,
          usageContext,
          downstreamSignal: signal,
          requestSignal: signal,
          upstreamModel: "deepseek-flash",
        });
  const cleanup = async (): Promise<void> => {
    releaseCleanup();
    if (iterator !== null && counts.finalized === 0) await iterator.return();
    await releaseProbe(probe);
  };
  return { response, probe, counts, telemetry, observedUsage, cleanupEntered, releaseCleanup, cleanup };
};

for (const wire of ["chat", "responses"] as const) {
  test(`Provider ${wire} relay disposes DONE before terminal and usage settlement`, async () => {
    const fixture = providerRelayFixture(wire);
    const output = fixture.response.text();
    try {
      assert.equal(await settlesWithin(fixture.cleanupEntered, 500), true, "DONE must enter the generator finally");
      assert.equal(fixture.counts.returned, 1);
      assert.equal(fixture.counts.finalized, 1);
      assert.equal(fixture.counts.next, 2, "the relay must not read after the DONE frame");
      assert.equal(fixture.counts.postDone, 0);
      assert.equal(fixture.probe.cancelCount(), 1, "the parser must dispose the physical body");
      assert.equal(fixture.probe.stream.locked, false);
      assert.ok(fixture.probe.started() <= 2, "only the initial body read and bounded read-ahead are allowed");
      assert.equal(fixture.telemetry.streamTerminalType, null);
      assert.equal(fixture.observedUsage.length, 0);
      assert.equal(fixture.counts.health, 0);
      assert.equal(await settlesWithin(output, 25), false, "completion must await generator cleanup");

      fixture.releaseCleanup();
      const text = await output;
      assert.ok(text.includes("answer"));
      if (wire === "chat") assert.equal(text.match(/data: \[DONE\]/g)?.length, 1);
      else assert.equal(text.match(/event: response.completed/g)?.length, 1);
      assert.equal(fixture.telemetry.streamTerminalType, "response.completed");
      assert.equal(fixture.observedUsage.length, 1);
      assert.equal(fixture.observedUsage[0].completed, true);
      assert.equal(fixture.observedUsage[0].usage?.totalTokens, 5);
      assert.equal(fixture.counts.health, 1);
      assert.equal(fixture.counts.errors, 0);
      assert.equal(fixture.counts.returned, 1);
      assert.equal(fixture.probe.cancelCount(), 1);
    } finally {
      await fixture.cleanup();
      await output.catch(() => {});
    }
  });

  test(`Provider ${wire} cancellation during DONE disposal returns the iterator only once`, async () => {
    const fixture = providerRelayFixture(wire);
    const body = fixture.response.body;
    assert.ok(body);
    const reader = body.getReader();
    const output = (async () => {
      for (;;) {
        if ((await reader.read()).done) return;
      }
    })();
    try {
      assert.equal(await settlesWithin(fixture.cleanupEntered, 500), true);
      assert.equal(fixture.counts.returned, 1);
      await reader.cancel("client disconnected during DONE disposal");
      assert.equal(fixture.counts.returned, 1, "cancellation must not return an iterator already being disposed");
      fixture.releaseCleanup();
      await output;
      assert.equal(fixture.telemetry.streamTerminalType, "cancelled");
      assert.equal(fixture.counts.cancelled, 1);
      assert.equal(fixture.counts.finalized, 1);
      assert.equal(fixture.counts.next, 2);
      assert.equal(fixture.counts.postDone, 0);
      assert.equal(fixture.counts.health, 0);
      assert.equal(fixture.counts.errors, 0);
      assert.equal(fixture.observedUsage.length, 1);
      assert.equal(fixture.observedUsage[0].completed, false);
      assert.equal(fixture.probe.cancelCount(), 1);
      assert.equal(fixture.probe.stream.locked, false);
    } finally {
      fixture.releaseCleanup();
      await reader.cancel("test cleanup").catch(() => {});
      await fixture.cleanup();
      await output.catch(() => {});
    }
  });
}

test("Provider relays cancel a late deferred response without reading it", async () => {
  const adapter: ProviderStreamAdapter = {
    responseHeaders: () => ({}),
    frames: iterateDeepSeekChatCompletionStream,
    recordResponseHealth: () => {},
    recordProviderError: () => {},
    recordCancellation: () => {},
    recordIncompleteResponse: () => {},
    recordFinishFailureKind: () => {},
    recordTransportFailure: () => {},
    terminalTypeForError: () => "cancelled",
    streamErrorCode: "upstream_stream_error",
    responsesProfile: DEEPSEEK_RESPONSES_PROFILE,
  };
  for (const wire of ["chat", "responses"] as const) {
    // Bun eagerly pulls a normal stream once it enters the microtask queue;
    // keep this late body genuinely unread until the relay owns it.
    const lateUpstream = probeUpstream(undefined, 0);
    let resolvePending: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolvePending = resolve;
    });
    let pendingResolved = false;
    const signal = new AbortController().signal;
    const pendingDispatch = new AbortController();
    let pendingCancellationCount = 0;
    const cancelPending = (reason?: unknown): void => {
      pendingCancellationCount += 1;
      pendingDispatch.abort(reason);
    };
    const response =
      wire === "chat"
        ? relayChatCompletionStream(adapter, pending, null, undefined, signal, signal, "deepseek-flash", cancelPending)
        : relayResponsesStream(adapter, {
            upstream: pending,
            requestedModel: "deepseek-flash",
            responseId: "resp_deferred_cancel",
            createdAtSeconds: 1,
            echo: { tools: [], tool_choice: "auto", parallel_tool_calls: true, instructions: null },
            toolNames: new Map(),
            customToolNames: new Set(),
            providerRequestId: null,
            usageContext: undefined,
            downstreamSignal: signal,
            requestSignal: signal,
            upstreamModel: "deepseek-flash",
            cancelPending,
          });
    const body = response.body;
    assert.ok(body);
    const reader = body.getReader();
    const pendingRead = reader.read();
    try {
      await reader.cancel("client disconnected");
      assert.equal(pendingCancellationCount, 1, "client cancellation must reach the deferred dispatch");
      assert.equal(pendingDispatch.signal.aborted, true);
      pendingResolved = true;
      resolvePending(new Response(lateUpstream.stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      assert.equal(await settlesWithin(pendingRead, 500), true, "the abandoned downstream read must settle");
      assert.equal((await pendingRead).done, true, "client cancellation must not emit an error frame");
      assert.equal(await settlesWithin(lateUpstream.cancelled, 500), true, "the late upstream body must be cancelled");
      assert.equal(lateUpstream.cancelCount(), 1, "the late upstream body must be cancelled exactly once");
      assert.equal(lateUpstream.started(), 0, "cancellation must not start an upstream read");
    } finally {
      if (!pendingResolved) resolvePending(new Response(lateUpstream.stream));
      await reader.cancel("test cleanup").catch(() => {});
      await releaseProbe(lateUpstream);
    }
  }
});

test("Responses proxy releases an in-flight upstream read when its reader cancels", async () => {
  const probe = probeUpstream();
  const reader = proxyResponsesStream(probe.stream).getReader();
  const abandonedRead = reader.read();
  try {
    assert.equal(await settlesWithin(probe.startedAtLeast(1), 500), true, "the proxy read must reach the upstream reader");
    assert.equal(probe.stream.locked, true, "the proxy read must own the upstream reader before cancellation");
    assert.equal(probe.pending(), 1, "the proxy must hold exactly one concurrent upstream read");

    await reader.cancel("downstream client disconnected");
    assert.equal(await settlesWithin(probe.cancelled, 500), true, "cancellation must reach the pending upstream read");
    assert.equal(probe.cancelCount(), 1);
    assert.equal(probe.started(), 1, "cancellation must not start another upstream read");
    assert.equal(await settlesWithin(abandonedRead, 500), true, "the abandoned downstream read must settle closed");
    assert.equal(await becomesTrue(() => !probe.stream.locked, 500), true, "the cancelled upstream reader must be released");
  } finally {
    await reader.cancel("test cleanup").catch(() => {});
    await releaseProbe(probe);
  }
});

test("Responses proxy cancels an upstream stream that was never read", async () => {
  const probe = probeUpstream();
  const reader = proxyResponsesStream(probe.stream).getReader();
  try {
    await reader.cancel("downstream client disconnected before the first read");
    assert.equal(probe.cancelCount(), 1, "an unstarted proxy must still cancel its upstream stream");
    assert.equal(probe.started(), 0, "an unstarted proxy must not start an upstream read to cancel it");
    assert.equal(probe.stream.locked, false);
  } finally {
    await reader.cancel("test cleanup").catch(() => {});
    await releaseProbe(probe);
  }
});

test("Responses proxy stops an eager upstream producer while its reader is idle", async () => {
  const probe = probeUpstream((pullIndex) => bytes(deltaFrame(`chunk-${pullIndex}`)));
  const reader = proxyResponsesStream(probe.stream).getReader();
  try {
    const first = await reader.read();
    if (first.done) assert.fail("Expected the first proxied event.");
    assert.equal(decoder.decode(first.value), deltaFrame("chunk-1"));

    await sleep(25);
    const settledPulls = probe.started();
    // One event queued downstream plus one upstream read-ahead chunk is the whole
    // end-to-end allowance; the caps alone do not bound what an idle reader sees.
    assert.ok(settledPulls <= 3, `the proxy queued ${settledPulls} upstream events for one downstream read`);
    await sleep(50);
    assert.equal(probe.started(), settledPulls, "an idle downstream reader must stop the upstream producer");
    assert.ok(probe.pending() <= 1, `the proxy held ${probe.pending()} concurrent upstream reads`);
  } finally {
    await reader.cancel("slow reader stopped").catch(() => {});
    await releaseProbe(probe);
  }
});

test("Owned Responses stream stops an eager upstream producer while its consumer is idle", async () => {
  const probe = probeUpstream((pullIndex) => bytes(deltaFrame(`chunk-${pullIndex}`)));
  const body = createOwnedResponsesStream({
    initial: [],
    iterator: readResponsesStream(probe.stream),
    responseId: "resp_lifecycle",
  });
  const reader = body.getReader();
  try {
    const first = await reader.read();
    if (first.done) assert.fail("Expected the first owned event.");
    assert.equal(decoder.decode(first.value), deltaFrame("chunk-1"));

    await sleep(25);
    const settledPulls = probe.started();
    assert.ok(settledPulls <= 3, `the owned stream queued ${settledPulls} upstream events for one downstream read`);
    await sleep(50);
    assert.equal(probe.started(), settledPulls, "an idle consumer must stop the owned stream's upstream producer");
    assert.ok(probe.pending() <= 1, `the owned stream held ${probe.pending()} concurrent upstream reads`);
  } finally {
    await reader.cancel("slow consumer stopped").catch(() => {});
    await releaseProbe(probe);
  }
});

test("Responses proxy forwards one terminal, cancels once, and never replays its upstream", async () => {
  // Typed with the gap the pull index can land on, so the sentinel check below
  // stays an honest runtime guard rather than a comparison the types disprove.
  const frames: (string | undefined)[] = [deltaFrame("committed"), completedFrame(), deltaFrame("post-terminal")];
  const probe = probeUpstream((pullIndex) => {
    const frame: string | undefined = frames[pullIndex - 1];
    return frame === undefined ? null : bytes(frame);
  });
  const reader = proxyResponsesStream(probe.stream).getReader();
  try {
    const committed = await reader.read();
    if (committed.done) assert.fail("Expected the committed text event.");
    assert.equal(decoder.decode(committed.value), frames[0]);
    const terminal = await reader.read();
    if (terminal.done) assert.fail("Expected the terminal event.");
    assert.equal(decoder.decode(terminal.value), frames[1]);

    assert.equal((await reader.read()).done, true);
    assert.equal(probe.cancelCount(), 1, "the upstream must be cancelled exactly once after its terminal");
    assert.ok(probe.started() <= 3, `read-ahead crossed the terminal: ${probe.started()} upstream pulls`);
    await reader.cancel("terminal already delivered");
    assert.equal(probe.cancelCount(), 1, "cancelling a completed proxy must not touch the upstream again");
  } finally {
    await reader.cancel("test cleanup").catch(() => {});
    await releaseProbe(probe);
  }
});

test("Responses preflight propagates caller cancellation into a pending first read", async () => {
  const controller = new AbortController();
  const probe = probeUpstream();
  const preflight = preflightResponsesStream(probe.stream, controller.signal);
  try {
    assert.equal(await settlesWithin(probe.startedAtLeast(1), 500), true, "preflight must start reading the upstream");
    assert.equal(probe.stream.locked, true, "preflight must own the upstream reader before its first event");
    assert.equal(probe.pending(), 1);
    controller.abort(new DOMException("client disconnected", "AbortError"));

    const error = await rejectionOf(preflight);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    assert.equal(probe.cancelCount(), 1);
    assert.equal(probe.started(), 1);
    assert.equal(await becomesTrue(() => !probe.stream.locked, 500), true);
  } finally {
    controller.abort(new DOMException("test cleanup", "AbortError"));
    await settlesWithin(
      preflight.catch(() => undefined),
      500
    );
    await releaseProbe(probe);
  }
});

test("Owned Responses stream aborts a parked upstream read when its consumer cancels", async () => {
  const upstreamAbort = new AbortController();
  const probe = probeUpstream();
  const body = createOwnedResponsesStream({
    initial: [],
    iterator: readResponsesStream(probe.stream, upstreamAbort.signal),
    responseId: "resp_lifecycle",
    abortUpstream: (reason) => {
      upstreamAbort.abort(reason);
    },
  });
  const reader = body.getReader();
  const parked = reader.read();
  try {
    assert.equal(await settlesWithin(probe.startedAtLeast(1), 500), true, "the owned stream must start reading the upstream");
    assert.equal(probe.stream.locked, true, "the owned stream must be parked on its upstream read");
    assert.equal(probe.pending(), 1);

    await reader.cancel("downstream client disconnected");
    assert.equal(await settlesWithin(probe.cancelled, 500), true, "cancellation must abort the parked upstream read");
    assert.equal(probe.cancelCount(), 1);
    assert.equal(probe.started(), 1);
    assert.equal(await settlesWithin(parked, 500), true);
    assert.equal(await becomesTrue(() => !probe.stream.locked, 500), true);
  } finally {
    await reader.cancel("test cleanup").catch(() => {});
    if (!upstreamAbort.signal.aborted) upstreamAbort.abort(new DOMException("test cleanup", "AbortError"));
    await releaseProbe(probe);
  }
});

test("SSE keepalive forwards cancellation and keeps one pending upstream read", async () => {
  const probe = probeUpstream((pullIndex) => (pullIndex === 1 ? bytes(deltaFrame("first")) : null));
  const reader = withSseKeepalive(probe.stream, { intervalMs: 5 }).getReader();
  try {
    const first = await reader.read();
    if (first.done) assert.fail("Expected the first upstream frame.");
    assert.equal(decoder.decode(first.value), deltaFrame("first"));
    const keepalive = await reader.read();
    if (keepalive.done) assert.fail("Expected a keepalive frame while the provider is quiet.");
    assert.equal(decoder.decode(keepalive.value), ": keepalive\n\n");
    assert.ok(probe.pending() <= 1, `keepalive held ${probe.pending()} concurrent upstream reads`);

    const startedWhileIdle = probe.started();
    await sleep(25);
    assert.equal(probe.started(), startedWhileIdle, "a quiet provider must not be read while its consumer is idle");

    await reader.cancel("client disconnected");
    assert.equal(probe.cancelCount(), 1, "keepalive cancellation must reach its source");
  } finally {
    await reader.cancel("test cleanup").catch(() => {});
    await releaseProbe(probe);
  }
});

test("Responses precommit buffer refuses an unbounded eager producer and releases its iterator", async () => {
  let produced = 0;
  let released = false;
  // A producing iterator with no asynchronous work of its own: an
  // `async function*` would need an await it genuinely does not have, so the
  // async iterator protocol is written out directly. `return` records the
  // release the precommit buffer must perform.
  const eager: ResponsesStreamIterator = {
    next: () => {
      produced += 1;
      return Promise.resolve<IteratorResult<ResponsesStreamEvent, unknown>>({
        done: false,
        value: responseEventFromValue({ type: "response.in_progress", sequence_number: produced }),
      });
    },
    return: () => {
      released = true;
      return Promise.resolve<IteratorResult<ResponsesStreamEvent, unknown>>({ done: true, value: undefined });
    },
    // A thrown Error is preserved; a non-Error fixture reason is normalized so
    // the rejection reason is always an Error.
    throw: (error: unknown) => Promise.reject(error instanceof Error ? error : new Error("The eager producer was thrown a non-Error reason.")),
    [Symbol.asyncIterator]() {
      return this;
    },
    // Deno's AsyncGenerator also requires the explicit resource-management
    // member. It delegates to the same return path, so disposal performs the
    // real cleanup and no counts change unless the consumer disposes.
    async [Symbol.asyncDispose](): Promise<void> {
      await this.return(undefined);
    },
  };
  try {
    const error = await rejectionOf(prepareResponsesStreamForCommit(eager));
    assert.ok(error instanceof ResponsesStreamError);
    assert.equal(error.kind, "event_too_large");
    assert.equal(produced, MAX_RESPONSES_PRECOMMIT_EVENTS + 1, "the buffer must refuse the event past its cap");
    assert.equal(released, true, "an overflowing precommit buffer must release its upstream iterator");
  } finally {
    await settlesWithin(
      eager.return(undefined).catch(() => undefined),
      250
    );
  }
});

test("Responses precommit character budget refuses events past its cap without buffering them", () => {
  const chunk = responseEventFromValue({ type: "response.in_progress", pad: "x".repeat(1024 * 1024) });
  const buffered: ResponsesStreamEvent[] = [];
  let chars = 0;
  let accepted = 0;
  assert.throws(
    () => {
      for (;;) {
        chars = appendResponsesPrecommitEvent(buffered, chunk, chars);
        accepted += 1;
      }
    },
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "event_too_large"
  );
  assert.equal(buffered.length, accepted);
  assert.ok(chars <= MAX_RESPONSES_PRECOMMIT_CHARS, `buffered ${chars} characters past the ${MAX_RESPONSES_PRECOMMIT_CHARS} cap`);

  assert.throws(
    () => appendResponsesPrecommitEvent(buffered, chunk, MAX_RESPONSES_PRECOMMIT_CHARS - 1),
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "event_too_large"
  );
  assert.equal(buffered.length, accepted, "a refused event must not be buffered");
});
