import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  fetchLithosChatCompletions,
  iterateLithosChatCompletionStream,
  LITHOS_MODEL_IDS,
  LithosError,
  normalizeLithosChatCompletion,
  normalizeLithosChatCompletionChunk,
  setLithosFetchTimeoutMsForTest,
} from "../src/provider/lithos.ts";

/**
 * Branch coverage for the LithosAI Chat Completions provider.
 *
 * Every case drives an exported entry point with an in-memory fixture and
 * asserts the observable result: the normalized frame, the rejection message,
 * the client-visible error code and status, or the frames a stream yields.
 * There is no network, no KV, no port and no wall-clock assertion.
 */

const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat";
const KIMI = "moonshotai/Kimi-K3";

const USAGE = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } as const;

const completion = (message: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-lithos-branch",
  object: "chat.completion",
  created: 1_780_000_000,
  model: MODEL,
  choices: [{ index: 0, message, finish_reason: "stop" }],
  usage: USAGE,
  ...overrides,
});

const chunk = (choices: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-lithos-chunk",
  object: "chat.completion.chunk",
  created: 1_780_000_001,
  model: MODEL,
  choices,
  ...extra,
});

type NormalizationOutcome = { ok: true } | { ok: false; message: string };

const rejectionMessage = (result: NormalizationOutcome): string => {
  if (result.ok) throw new Error("expected the payload to be rejected");
  return result.message;
};

const normalizedCompletion = (value: Record<string, unknown>, requestedModel = MODEL): Record<string, unknown> => {
  const result = normalizeLithosChatCompletion(value, requestedModel);
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

const normalizedChoice = (message: Record<string, unknown>, finishReason?: unknown, requestedModel = MODEL): Record<string, unknown> => {
  const raw = completion(message);
  // `undefined` keeps the fixture's own finish_reason, `null` omits the field so
  // the normalizer has to derive it, and any other value overrides it.
  const choices = (raw.choices as Record<string, unknown>[]).map((entry) => {
    if (finishReason === undefined) return entry;
    const rest = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "finish_reason"));
    return finishReason === null ? rest : { ...rest, finish_reason: finishReason };
  });
  const result = normalizeLithosChatCompletion({ ...raw, choices, model: requestedModel }, requestedModel);
  if (!result.ok) throw new Error(result.message);
  return (result.value.choices as Record<string, unknown>[])[0];
};

const normalizedChunk = (value: Record<string, unknown>): Record<string, unknown> => {
  const result = normalizeLithosChatCompletionChunk(value, MODEL);
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

const sseResponse = (body: string): Response => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });

const collectFrames = async (response: Response, signal?: AbortSignal): Promise<Record<string, unknown>[]> => {
  const frames: Record<string, unknown>[] = [];
  for await (const frame of iterateLithosChatCompletionStream(response, MODEL, signal ? { signal } : {})) frames.push(frame);
  return frames;
};

test("lithos transport rejects an unknown model and an unserializable body before dispatch", async () => {
  let dispatched = false;
  const fetcher = () => {
    dispatched = true;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  // The projection's own client error is rethrown unchanged rather than rewritten.
  const unknownModel = await fetchLithosChatCompletions({}, "not/a-lithos-model", { apiKey: "lith_sk_test", fetcher }).catch((error: unknown) => error);
  assert.ok(unknownModel instanceof LithosError);
  assert.equal(unknownModel.code, "lithos_request_invalid");
  assert.equal(unknownModel.status, 400);
  assert.match(unknownModel.message, /not configured/);

  // A body whose `toJSON` probe yields no string is not serializable on this wire.
  const unserializable = await fetchLithosChatCompletions({ toJSON: () => undefined }, LITHOS_MODEL_IDS[0], { apiKey: "lith_sk_test", fetcher }).catch(
    (error: unknown) => error
  );
  assert.ok(unserializable instanceof LithosError);
  assert.equal(unserializable.code, "lithos_request_invalid");
  assert.equal(unserializable.status, 400);
  assert.match(unserializable.message, /JSON-serializable body/);
  assert.equal(dispatched, false);

  // A blank supplied key is treated as absent, not as an override.
  const blankKey = await fetchLithosChatCompletions({}, LITHOS_MODEL_IDS[0], { apiKey: "   ", fetcher }).catch((error: unknown) => error);
  assert.ok(blankKey instanceof LithosError);
  assert.equal(blankKey.code, "lithos_api_key_missing");
  assert.equal(blankKey.status, 503);
  assert.equal(dispatched, false);
});

test("lithos transport classifies a caller timeout and a blown header deadline as gateway timeouts", async () => {
  const caller = new AbortController();
  caller.abort(new DOMException("caller deadline", "TimeoutError"));
  let dispatched = 0;
  const fetcher = () => {
    dispatched += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };

  // The caller's own TimeoutError identity wins over the abort classification.
  const callerTimeout = await fetchLithosChatCompletions({}, LITHOS_MODEL_IDS[0], { apiKey: "lith_sk_test", signal: caller.signal, fetcher }).catch(
    (error: unknown) => error
  );
  assert.ok(callerTimeout instanceof LithosError);
  assert.equal(callerTimeout.code, "gateway_timeout");
  assert.equal(callerTimeout.status, 504);
  assert.equal(dispatched, 0);

  // An expiring header deadline aborts the dispatch before the transport is touched.
  setLithosFetchTimeoutMsForTest(1);
  try {
    const deadline = await fetchLithosChatCompletions({}, LITHOS_MODEL_IDS[0], {
      apiKey: "lith_sk_test",
      fetcher,
      beforeDispatch: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    }).catch((error: unknown) => error);
    assert.ok(deadline instanceof LithosError);
    assert.equal(deadline.code, "gateway_timeout");
    assert.equal(deadline.status, 504);
    assert.equal(dispatched, 0);
  } finally {
    setLithosFetchTimeoutMsForTest(null);
  }
});

test("lithos buffered normalization accepts an absent model echo and rejects an unusable one", () => {
  // A non-string echo carries no model claim, so it is not a mismatch.
  const scalarEcho = normalizedCompletion(completion({ role: "assistant", content: "hello" }, { model: 42 }));
  assert.equal(scalarEcho.model, MODEL);

  // The provider folds the `-ultra-chat` tier onto the base slug; that echo is accepted.
  const foldedEcho = normalizedCompletion(completion({ role: "assistant", content: "hello" }, { model: "/models/DeepSeek-V4.1-Flash" }));
  assert.equal(foldedEcho.model, MODEL);

  // An exact canonical echo (any casing) is accepted for the other models too.
  const kim = normalizedCompletion(
    {
      id: "chatcmpl-lithos-kimi",
      object: "chat.completion",
      created: 1_780_000_000,
      model: "moonshotai/kimi-k3",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    },
    KIMI
  );
  assert.equal(kim.model, KIMI);

  const mismatch = normalizeLithosChatCompletion(completion({ role: "assistant", content: "hello" }, { model: "moonshotai/Kimi-K3" }), MODEL);
  assert.match(rejectionMessage(mismatch), /different model than requested/);
});

test("lithos buffered normalization rejects every unusable message field", () => {
  assert.match(rejectionMessage(normalizeLithosChatCompletion(completion({ role: "user", content: "hello" }), MODEL)), /does not contain an assistant message/);
  assert.match(rejectionMessage(normalizeLithosChatCompletion(completion({ role: "assistant", content: 42 }), MODEL)), /unsupported message content/);
  assert.match(
    rejectionMessage(normalizeLithosChatCompletion(completion({ role: "assistant", content: "hi", reasoning_content: 42 }), MODEL)),
    /invalid reasoning content/
  );
  assert.match(rejectionMessage(normalizeLithosChatCompletion(completion({ role: "assistant", content: "hi", refusal: 5 }), MODEL)), /invalid refusal/);
  // A message with neither content nor a tool call is not answer-bearing.
  assert.match(rejectionMessage(normalizeLithosChatCompletion(completion({ role: "assistant" }), MODEL)), /neither content nor a tool call/);
  assert.match(
    rejectionMessage(normalizeLithosChatCompletion(completion({ role: "assistant", content: "hi", tool_calls: "none" }), MODEL)),
    /invalid tool calls/
  );
  assert.match(
    rejectionMessage(
      normalizeLithosChatCompletion(
        completion({ role: "assistant", content: "hi" }, { choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: 7 }] }),
        MODEL
      )
    ),
    /invalid finish reason/
  );

  // An answer-bearing refusal string is carried through unchanged.
  const refused = normalizedChoice({ role: "assistant", content: "hi", refusal: "I cannot help with that." });
  const refusedMessage = refused.message as Record<string, unknown>;
  assert.equal(refusedMessage.refusal, "I cannot help with that.");

  // A choice without an explicit finish reason derives it from its payload shape.
  assert.equal(normalizedChoice({ role: "assistant", content: "hi" }, null).finish_reason, "stop");
  assert.equal(
    normalizedChoice({ role: "assistant", content: null, tool_calls: [{ id: "f:0", type: "function", function: { name: "f", arguments: "{}" } }] }, null)
      .finish_reason,
    "tool_calls"
  );

  // A choice whose message is not an object is rejected before any message field.
  const badChoice = normalizeLithosChatCompletion(completion({ role: "assistant", content: "hi" }, { choices: [{ index: 0, message: "nope" }] }), MODEL);
  assert.match(rejectionMessage(badChoice), /missing an assistant message/);
  const badIndex = normalizeLithosChatCompletion(
    completion({ role: "assistant", content: "hi" }, { choices: [{ message: { role: "assistant", content: "hi" } }] }),
    MODEL
  );
  assert.match(rejectionMessage(badIndex), /has an invalid index/);
});

test("lithos tool calls are validated field by field on the buffered path", () => {
  const withToolCall = (toolCall: unknown): NormalizationOutcome =>
    normalizeLithosChatCompletion(completion({ role: "assistant", content: null, tool_calls: toolCall }), MODEL);

  assert.match(rejectionMessage(withToolCall([5])), /tool call 0 is not an object/);
  assert.match(rejectionMessage(withToolCall([{ type: "function", function: { name: "f", arguments: "{}" } }])), /missing an id/);
  assert.match(rejectionMessage(withToolCall([{ id: "f:0", function: { name: "f", arguments: "{}" } }])), /unsupported type/);
  assert.match(rejectionMessage(withToolCall([{ id: "f:0", type: "function", function: "nope" }])), /missing its function/);
  assert.match(rejectionMessage(withToolCall([{ id: "f:0", type: "function", function: { arguments: "{}" } }])), /missing a function name/);
  assert.match(rejectionMessage(withToolCall([{ id: "f:0", type: "function", function: { name: "f", arguments: 5 } }])), /non-string arguments/);
  // An id with surrounding whitespace is not an opaque wire value.
  assert.match(rejectionMessage(withToolCall([{ id: " f:0 ", type: "function", function: { name: "f", arguments: "{}" } }])), /missing an id/);

  // The accepted call is relayed verbatim, name-index id included.
  const accepted = normalizedCompletion(
    completion({ role: "assistant", content: null, tool_calls: [{ id: "f:0", type: "function", function: { name: "f", arguments: '{"a":1}' } }] })
  );
  const message = (accepted.choices as Record<string, unknown>[])[0].message as Record<string, unknown>;
  assert.deepEqual(message.tool_calls, [{ id: "f:0", type: "function", function: { name: "f", arguments: '{"a":1}' } }]);
  assert.equal(message.content, null);
});

test("lithos chunk normalization validates delta fields and the chunk envelope", () => {
  const chunkOutcome = (frame: Record<string, unknown>): NormalizationOutcome => normalizeLithosChatCompletionChunk(frame, MODEL);

  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: "nope" }]))), /invalid delta/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { role: 5 } }]))), /invalid delta role/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { content: 5 } }]))), /invalid content/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { reasoning_content: 5 } }]))), /invalid reasoning_content/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { refusal: 5 } }]))), /invalid refusal/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { tool_calls: [5] } }]))), /tool call delta 0 is not an object/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { tool_calls: [{ index: -1 }] } }]))), /invalid index/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { tool_calls: [{ id: " padded " }] } }]))), /invalid id/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { tool_calls: [{ type: "other" }] } }]))), /unsupported type/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { tool_calls: [{ function: "nope" }] } }]))), /invalid function/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { tool_calls: [{ function: { name: 5 } }] } }]))), /invalid function name/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { tool_calls: [{ function: { arguments: 5 } }] } }]))), /non-string arguments/);
  // A tool-call delta carrying no field at all is not a frame the client can apply.
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { tool_calls: [{ function: {} }] } }]))), /carries no fields/);
  // A choice delta with no fields is relayed as an empty delta rather than dropped.
  assert.deepEqual(normalizedChunk(chunk([{ index: 0, delta: {} }])).choices, [{ index: 0, delta: {} }]);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ delta: { content: "hi" } }]))), /invalid index/);
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { content: "hi" }, finish_reason: 7 }]))), /invalid finish reason/);
  assert.match(rejectionMessage(chunkOutcome(chunk("nope"))), /no choices array/);
  assert.match(
    rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { content: "hi" } }], { object: "chat.completion" }))),
    /did not return a Chat Completion chunk/
  );
  assert.match(rejectionMessage(chunkOutcome(chunk([{ index: 0, delta: { content: "hi" } }], { usage: { prompt_tokens: 1 } }))), /usage is incomplete/);

  // A delta refusal string and a delta tool-call continuation are relayed.
  const refused = normalizedChunk(chunk([{ index: 0, delta: { content: "hi", refusal: "no thanks" } }]));
  assert.deepEqual(refused.choices, [{ index: 0, delta: { content: "hi", refusal: "no thanks" } }]);
  const toolDelta = normalizedChunk(chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "f", arguments: "{}" } }] } }]));
  assert.deepEqual(toolDelta.choices, [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "f", arguments: "{}" } }] } }]);
  // The totals frame is a valid chunk with an empty choices array.
  const totals = normalizedChunk(chunk([], { usage: USAGE }));
  assert.deepEqual(totals.choices, []);
  assert.deepEqual(totals.usage, USAGE);
});

test("lithos SSE framing skips a data-free frame and rejects a bare data line", async () => {
  const payload = JSON.stringify(chunk([{ index: 0, delta: { content: "hi" } }]));
  // A leading blank frame carries no `data:` line and is skipped, not relayed.
  const frames = await collectFrames(sseResponse(`\r\rdata: ${payload}\r\rdata: [DONE]\r\r`));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].choices, [{ index: 0, delta: { content: "hi" } }]);

  // A `data` line without a colon is an empty payload, which is malformed JSON.
  const bare = await iterateLithosChatCompletionStream(sseResponse("data\n\n"), MODEL)
    .next()
    .catch((error: unknown) => error);
  assert.ok(bare instanceof LithosError);
  assert.equal(bare.code, "lithos_upstream_invalid_response");
  assert.equal(bare.status, 502);

  // A comment-only frame is skipped rather than relayed.
  const commented = await iterateLithosChatCompletionStream(sseResponse(": keep-alive\n\ndata: [DONE]\n\n"), MODEL).next();
  assert.equal(commented.done, true);

  // A response without a body cannot be framed.
  const bodyless = await iterateLithosChatCompletionStream(new Response(null, { status: 200 }), MODEL)
    .next()
    .catch((error: unknown) => error);
  assert.ok(bodyless instanceof LithosError);
  assert.equal(bodyless.code, "lithos_upstream_invalid_response");
  assert.equal(bodyless.status, 502);
  assert.match(bodyless.message, /no Chat Completions stream body/);

  // A stream that ends without [DONE] is truncated, not a finished answer.
  const truncated = await collectFrames(sseResponse(`data: ${payload}\n\n`)).catch((error: unknown) => error);
  assert.ok(truncated instanceof LithosError);
  assert.equal(truncated.code, "lithos_upstream_invalid_response");
  assert.match(truncated.message, /ended before \[DONE\]/);
});

test("lithos stream failures keep the caller's abort reason and fail closed on a broken reader", async () => {
  // An already-aborted signal rejects the pending read with the caller's reason.
  const controller = new AbortController();
  const abortReason = new Error("caller left");
  controller.abort(abortReason);
  const aborted = await iterateLithosChatCompletionStream(sseResponse("data: [DONE]\n\n"), MODEL, { signal: controller.signal })
    .next()
    .catch((error: unknown) => error);
  assert.equal(aborted, abortReason);

  // A reader that rejects is an invalid upstream response, not a caller abort.
  const broken = new ReadableStream<Uint8Array>({
    start(source) {
      source.error(new Error("socket reset"));
    },
  });
  const failed = await iterateLithosChatCompletionStream(new Response(broken), MODEL)
    .next()
    .catch((error: unknown) => error);
  assert.ok(failed instanceof LithosError);
  assert.equal(failed.code, "lithos_upstream_invalid_response");
  assert.match(failed.message, /stream failed/);
});

test("lithos stream sessions release their reader lock even when the upstream cancels badly", async () => {
  // The upstream `cancel` itself throws, and the release still happens.
  let cancelAttempted = false;
  const throwingCancel = new ReadableStream<Uint8Array>({
    start(source) {
      source.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    },
    cancel() {
      cancelAttempted = true;
      throw new Error("cancel refused");
    },
  });
  const iterator = iterateLithosChatCompletionStream(new Response(throwingCancel), MODEL);
  const first = await iterator.next();
  assert.equal(first.done, true);
  await iterator.return(undefined);
  assert.equal(cancelAttempted, true);
});
