import { test } from "bun:test";
import assert from "node:assert/strict";

import { type ApiKeyProviderDispatch, ApiKeyQuotaDispatchError } from "../src/api-key-policy.ts";
import {
  fetchLithosChatCompletions,
  getLithosProviderRequestId,
  iterateLithosChatCompletionStream,
  LITHOS_CHAT_COMPLETIONS_URL,
  LITHOS_REASONING_LEVELS,
  LithosError,
  type LithosFetch,
  lithosCachedPromptTokens,
  lithosReasoningTokens,
  normalizeLithosProviderRequestId,
  projectLithosRequest,
  setLithosFetchTimeoutMsForTest,
} from "../src/provider/lithos.ts";
import { createSentinelUpstreamRecorder } from "../src/sentinel/upstream-capture.ts";

const REQUESTED_MODEL = "moonshotai/Kimi-K3";
const API_KEY = "lith_sk_fixture";

/** Shaped like the real streaming frames probed on 2026-09-23. */
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-lithos-stream",
  object: "chat.completion.chunk",
  created: 1_790_160_303,
  model: REQUESTED_MODEL,
  choices: [{ index: 0, delta, logprobs: null, finish_reason: null }],
  ...extra,
});

/** Encodes one recorded frame the way the wire carried it. */
const sseFrame = (frame: unknown): string => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`;

/** Encodes recorded frames the way the wire carried them, comments included. */
const sse = (frames: readonly unknown[], prefix = ""): string => prefix + frames.map(sseFrame).join("");

/** Drives one recorded SSE body through the transport the route consumes. */
const readStream = async (body: string): Promise<Record<string, unknown>[]> => {
  const response = new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const received: Record<string, unknown>[] = [];
  for await (const value of iterateLithosChatCompletionStream(response, REQUESTED_MODEL)) received.push(value);
  return received;
};

/** A fetch that never settles until its cancellation signal aborts, then rejects with that reason. */
const rejectOnAbort = (signal: AbortSignal | null | undefined): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    if (!signal) {
      reject(new Error("Lithos transport dispatched without a cancellation signal"));
      return;
    }
    const rejectWithReason = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted.", "AbortError"));
    };
    if (signal.aborted) rejectWithReason();
    else signal.addEventListener("abort", rejectWithReason, { once: true });
  });

const isLithosError = (code: string, status: number) => (error: unknown) => error instanceof LithosError && error.code === code && error.status === status;

test("lithos transport: projects max_completion_tokens to max_tokens and keeps reasoning_effort verbatim", () => {
  const body: Record<string, unknown> = {
    model: REQUESTED_MODEL,
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 512,
    reasoning_effort: "xhigh",
    stream: true,
  };
  const projected = projectLithosRequest(body, "MOONSHOTAI/KIMI-K3");
  assert.deepEqual(projected, {
    model: REQUESTED_MODEL,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 512,
    reasoning_effort: "xhigh",
    stream: true,
  });
  // The caller's own body is not mutated.
  assert.equal(body.max_completion_tokens, 512);
  assert.equal(Object.hasOwn(body, "max_tokens"), false);

  // Every advertised tier reaches the wire unchanged, and so does a value the
  // provider will refuse: only the upstream may reject it.
  for (const effort of LITHOS_REASONING_LEVELS) {
    assert.equal(projectLithosRequest({ reasoning_effort: effort }, REQUESTED_MODEL).reasoning_effort, effort);
  }
  // DeepSeek's `ultra`→`max` map must not run on this provider.
  assert.equal(projectLithosRequest({ reasoning_effort: "ultra" }, REQUESTED_MODEL).reasoning_effort, "ultra");

  // A model this provider does not publish is a client error, not an upstream one.
  assert.throws(() => projectLithosRequest({}, "nope/nope"), isLithosError("lithos_request_invalid", 400));
  assert.throws(() => projectLithosRequest({}, ""), isLithosError("lithos_request_invalid", 400));
});

test("lithos transport: a buffered dispatch sends the projected body and reports its lifecycle in order", async () => {
  const events: string[] = [];
  let dispatchedInit: RequestInit | undefined;
  let dispatchedBody: Record<string, unknown> | null = null;
  const fetcher: LithosFetch = (input, init) => {
    events.push("fetch");
    assert.equal(input, LITHOS_CHAT_COMPLETIONS_URL);
    if (typeof init?.body !== "string") throw new Error("lithos fixture expected a serialized request body");
    dispatchedInit = init;
    dispatchedBody = JSON.parse(init.body) as Record<string, unknown>;
    return Promise.resolve(
      Response.json(
        {
          id: "chatcmpl-lithos-1",
          object: "chat.completion",
          created: 1_790_160_326,
          model: REQUESTED_MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        },
        { status: 200, headers: { "Content-Type": "application/json", "x-request-id": "lithos-must-not-be-read" } }
      )
    );
  };
  const dispatch: ApiKeyProviderDispatch = {
    markTransportStarted: () => events.push("markTransportStarted"),
    cancelBeforeTransport: () => {
      events.push("cancelBeforeTransport");
      return Promise.resolve();
    },
  };
  const recorder = createSentinelUpstreamRecorder();
  const response = await fetchLithosChatCompletions(
    { model: REQUESTED_MODEL, messages: [{ role: "user", content: "hi" }], max_completion_tokens: 64 },
    REQUESTED_MODEL,
    {
      apiKey: API_KEY,
      fetcher,
      beforeDispatch: () => {
        events.push("beforeDispatch");
        return Promise.resolve(dispatch);
      },
      onDispatch: () => events.push("onDispatch"),
      onHeaders: () => events.push("onHeaders"),
      sentinelUpstreamRecorder: recorder,
    }
  );

  assert.equal(response.status, 200);
  // Key admission is the final awaited step before transport, and the
  // recorder wrapper is what the caller receives.
  assert.deepEqual(events, ["beforeDispatch", "markTransportStarted", "onDispatch", "fetch", "onHeaders"]);
  assert.deepEqual(dispatchedBody, { model: REQUESTED_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 64 });
  assert.ok(dispatchedInit, "the fixture must have recorded the dispatched init");
  const headers = new Headers(dispatchedInit.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${API_KEY}`);
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(dispatchedInit.method, "POST");
  assert.equal(dispatchedInit.redirect, "manual");
  assert.ok(dispatchedInit.signal, "the transport must own a header deadline signal");
  assert.equal(((await response.json()) as Record<string, unknown>).id, "chatcmpl-lithos-1");
  // No provider request-id header exists on this wire, so none is read even
  // when a middlebox injects one.
  assert.equal(getLithosProviderRequestId(response), null);

  const attempt = recorder.snapshotAndSeal().attempts[0];
  assert.equal(attempt.provider, "lithos");
  assert.equal(attempt.status, 200);
  assert.equal(attempt.terminal, "eof");
  recorder.dispose();

  // A body that cannot be serialized fails closed before any key or socket work.
  const circular: Record<string, unknown> = { model: REQUESTED_MODEL };
  circular.self = circular;
  await assert.rejects(
    fetchLithosChatCompletions(circular, REQUESTED_MODEL, {
      apiKey: API_KEY,
      fetcher: () => {
        throw new Error("a non-serializable body must never reach the transport");
      },
    }),
    isLithosError("lithos_request_invalid", 400)
  );
});

test("lithos transport: classifies unreachable, deadline, caller abort and quota failures without rewriting them", async () => {
  const failedRecorder = createSentinelUpstreamRecorder();
  await assert.rejects(
    fetchLithosChatCompletions({ model: REQUESTED_MODEL }, REQUESTED_MODEL, {
      apiKey: API_KEY,
      fetcher: () => Promise.reject(new TypeError("lithos socket closed")),
      sentinelUpstreamRecorder: failedRecorder,
    }),
    isLithosError("lithos_upstream_unreachable", 502)
  );
  assert.equal(failedRecorder.snapshotAndSeal().attempts[0]?.terminal, "fetch_error");
  failedRecorder.dispose();

  setLithosFetchTimeoutMsForTest(10);
  try {
    await assert.rejects(
      fetchLithosChatCompletions({ model: REQUESTED_MODEL }, REQUESTED_MODEL, {
        apiKey: API_KEY,
        fetcher: (_input, init) => rejectOnAbort(init?.signal),
      }),
      isLithosError("gateway_timeout", 504)
    );
  } finally {
    setLithosFetchTimeoutMsForTest(null);
  }

  // A caller abort keeps the caller's own reason rather than becoming a
  // provider fault, during transport and before it.
  const abortReason = new DOMException("client disconnected", "AbortError");
  const controller = new AbortController();
  await assert.rejects(
    fetchLithosChatCompletions({ model: REQUESTED_MODEL }, REQUESTED_MODEL, {
      apiKey: API_KEY,
      signal: controller.signal,
      fetcher: (_input, init) => {
        controller.abort(abortReason);
        return rejectOnAbort(init?.signal);
      },
    }),
    (error: unknown) => error === abortReason
  );

  let cancelled = 0;
  let fetchCalls = 0;
  const preAborted = new AbortController();
  preAborted.abort(abortReason);
  await assert.rejects(
    fetchLithosChatCompletions({ model: REQUESTED_MODEL }, REQUESTED_MODEL, {
      apiKey: API_KEY,
      signal: preAborted.signal,
      beforeDispatch: () => ({
        markTransportStarted: () => {
          throw new Error("a cancelled request must not start transport");
        },
        cancelBeforeTransport: () => {
          cancelled += 1;
          return Promise.resolve();
        },
      }),
      fetcher: () => {
        fetchCalls += 1;
        return Promise.resolve(Response.json({}));
      },
    }),
    (error: unknown) => error === abortReason
  );
  assert.equal(cancelled, 1);
  assert.equal(fetchCalls, 0);

  // A quota admission failure is the caller's to render, never reclassified.
  const quota = new ApiKeyQuotaDispatchError("quota reservation is gone");
  await assert.rejects(
    fetchLithosChatCompletions({ model: REQUESTED_MODEL }, REQUESTED_MODEL, {
      apiKey: API_KEY,
      beforeDispatch: () => {
        throw quota;
      },
      fetcher: () => {
        throw new Error("a refused admission must never reach the transport");
      },
    }),
    (error: unknown) => error === quota
  );
});

test("lithos transport: relays reason-only deltas, a tool-call delta and the empty-choices totals frame until [DONE]", async () => {
  const frames = [
    chunk({ role: "assistant", content: "" }),
    chunk({ reasoning_content: "Let me think" }),
    chunk({ content: "Paris" }),
    chunk({
      reasoning_content: null,
      tool_calls: [{ index: 0, id: "get_weather:0", type: "function", function: { name: "get_weather", arguments: '{"city":' } }],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
    chunk(
      {},
      {
        created: 1_790_160_304,
        choices: [],
        usage: {
          prompt_tokens: 91,
          total_tokens: 204,
          completion_tokens: 113,
          prompt_tokens_details: null,
          completion_tokens_details: { reasoning_tokens: 99 },
        },
      }
    ),
  ];
  // Keep-alive comments and non-`data:` fields carry no payload and are skipped.
  const received = await readStream(sse(frames, ": keep-alive\n\nevent: message\n\n") + "data: [DONE]\n\n");

  assert.equal(received.length, frames.length);
  assert.deepEqual(received[0]?.choices, [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
  // A reason-only delta is a real frame, not an empty one: it must survive.
  assert.deepEqual(received[1]?.choices, [{ index: 0, delta: { reasoning_content: "Let me think" }, finish_reason: null }]);
  assert.deepEqual(received[3]?.choices, [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, id: "get_weather:0", type: "function", function: { name: "get_weather", arguments: '{"city":' } }] },
      finish_reason: null,
    },
  ]);
  assert.deepEqual(received[4]?.choices, [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }]);
  // The authoritative totals ride a chunk with an EMPTY choices array, and
  // usage is relayed without any `stream_options.include_usage` gate.
  assert.deepEqual(received[5]?.choices, []);
  assert.deepEqual(received[5]?.usage, {
    prompt_tokens: 91,
    completion_tokens: 113,
    total_tokens: 204,
    completion_tokens_details: { reasoning_tokens: 99 },
  });

  // [DONE] terminates: a frame after it is never read.
  const terminated = await readStream(sse([chunk({ content: "Paris" })]) + "data: [DONE]\n\n" + sse([chunk({ content: "never relayed" })]));
  assert.equal(terminated.length, 1);
});

test("lithos transport: fails closed on a malformed, truncated or oversized stream", async () => {
  // Malformed JSON is never skipped: dropping a frame would truncate the answer.
  await assert.rejects(readStream('data: {"id":\n\n'), isLithosError("lithos_upstream_invalid_response", 502));
  // A frame that is JSON but not a valid chunk is refused the same way.
  await assert.rejects(
    readStream(
      sse([{ id: "chatcmpl-lithos-bad", object: "chat.completion.chunk", created: 1, model: REQUESTED_MODEL, choices: [{ index: 0, delta: { content: 5 } }] }])
    ),
    isLithosError("lithos_upstream_invalid_response", 502)
  );
  // A stream that ends before [DONE] is truncated, not complete.
  await assert.rejects(readStream(sse([chunk({ content: "Paris" })])), isLithosError("lithos_upstream_invalid_response", 502));
  // One frame may not exceed the retained-tail bound.
  await assert.rejects(readStream(`data: ${"x".repeat(4 * 1024 * 1024 + 1)}\n\n`), isLithosError("lithos_upstream_invalid_response", 502));

  const controller = new AbortController();
  // A body that never produces a byte keeps the read pending, so the caller's
  // abort is the only thing that can settle it.
  const stalled = new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const reading = (async () => {
    for await (const frame of iterateLithosChatCompletionStream(stalled, REQUESTED_MODEL, { signal: controller.signal })) {
      throw new Error(`a stalled stream must not yield a frame: ${JSON.stringify(frame)}`);
    }
  })();
  controller.abort(new DOMException("client disconnected", "AbortError"));
  await assert.rejects(reading, (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("lithos transport: the provider correlation seam reads no header and the detail counters keep their guards", () => {
  const response = new Response("{}", { status: 200, headers: { "x-request-id": "lithos-1", "x-lithos-request-id": "lithos-2" } });
  assert.equal(getLithosProviderRequestId(response), null);
  assert.equal(normalizeLithosProviderRequestId("lithos-correlation-1"), "lithos-correlation-1");
  assert.equal(normalizeLithosProviderRequestId(" lithos-1"), null);
  assert.equal(normalizeLithosProviderRequestId("a".repeat(257)), null);
  assert.equal(normalizeLithosProviderRequestId(7), null);

  assert.equal(lithosCachedPromptTokens({ prompt_tokens_details: { cached_tokens: 64 } }, 91), 64);
  assert.equal(lithosCachedPromptTokens({ prompt_tokens_details: null }, 91), null);
  assert.equal(lithosCachedPromptTokens({ prompt_tokens_details: { cached_tokens: 200 } }, 91), null);
  assert.equal(lithosReasoningTokens({ completion_tokens_details: { reasoning_tokens: 99 } }, 113), 99);
  assert.equal(lithosReasoningTokens({ completion_tokens_details: { reasoning_tokens: -1 } }, 113), null);
  assert.equal(lithosReasoningTokens({}, 113), null);
});
