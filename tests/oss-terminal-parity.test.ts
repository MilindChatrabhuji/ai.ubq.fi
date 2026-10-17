import { test } from "bun:test";
import assert from "node:assert/strict";

import { normalizeDeepSeekChatCompletion } from "../src/deepseek/index.ts";
import { iterateDeepSeekChatCompletionStream } from "../src/deepseek/stream.ts";
import { type DeepSeekResponsesEcho, toDeepSeekResponsesPayload } from "../src/deepseek/responses-payload.ts";
import { createDeepSeekResponsesStreamTranslator } from "../src/deepseek/responses-stream.ts";
import { toDeepSeekResponsesChatBody } from "../src/deepseek/chat-projection.ts";
import { createPaidProviderAttemptDeadline, createStreamFirstEventDeadline, createStreamSemanticDeadline } from "../src/inference-deadline.ts";
import { isAnswerBearingCompletion } from "../src/upstream-wire.ts";

/**
 * Terminal and deadline parity for the DeepSeek Responses adapter (module
 * m04-terminals).
 *
 * These tests drive the real exported adapters with deterministic mock
 * upstream traces and compare the buffered and streamed transports on the
 * facts a client can observe: the terminal type, the answer-bearing view the
 * provider-agnostic completion-validity predicate decides on, the output items
 * and their `output_index` positions, and the incomplete reason. Where the
 * route (not the adapter) owns a decision, the test asserts the adapter-side
 * facts that decision consumes and names the route site in a comment instead of
 * reimplementing the route.
 *
 * The refusal regression is exercised end to end through the real transport
 * normalizers (`normalizeDeepSeekChatCompletionChunk` via the SSE iterator, and
 * `normalizeDeepSeekChatCompletion`), because a refusal that the normalizer
 * strips can never reach either adapter. A string `refusal` is payload on this
 * route's own Chat contract; a non-string one is malformed input and must be
 * rejected rather than silently dropped. Whether DeepSeek emits `refusal` at
 * all is unverified here (no live provider call).
 */

const echo: DeepSeekResponsesEcho = { tools: undefined, tool_choice: undefined, parallel_tool_calls: true, instructions: null };

const chatChunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-stream",
  object: "chat.completion.chunk",
  created: 1_780_000_001,
  model: "deepseek-flash",
  choices: [{ index: 0, delta, finish_reason: null, ...extra }],
});

const chatCompletion = (message: Record<string, unknown>, finishReason = "stop"): Record<string, unknown> => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_780_000_000,
  model: "deepseek-flash",
  choices: [{ index: 0, message, finish_reason: finishReason }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
});

/** Runs one Chat trace through the streamed transport and returns its terminal event. */
const streamedTerminal = (chunks: readonly Record<string, unknown>[]): { type: string; response: Record<string, unknown> } => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_parity", echo, 1_780_000_000);
  for (const chunk of chunks) translator.push(chunk);
  const terminal = translator.finish().at(-1);
  assert.ok(terminal);
  return terminal as { type: string; response: Record<string, unknown> };
};

const bufferedPayload = (message: Record<string, unknown>, finishReason = "stop"): Record<string, unknown> =>
  toDeepSeekResponsesPayload(chatCompletion(message, finishReason), "deepseek-flash", "resp_parity", echo);

const outputTypes = (payload: Record<string, unknown>): unknown[] => (payload.output as Record<string, unknown>[]).map((item) => item.type);

/** Runs one Chat trace through the streamed transport and returns every event, terminal included. */
const streamedEvents = (chunks: readonly Record<string, unknown>[], responseId = "resp_sdk"): Record<string, unknown>[] => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", responseId, echo, 1_780_000_000);
  const events: Record<string, unknown>[] = [];
  for (const chunk of chunks) events.push(...translator.push(chunk));
  events.push(...translator.finish());
  return events;
};

/**
 * The accumulation contract of the official JavaScript SDK's `ResponseStream`,
 * reduced to the facts this adapter can violate: `response.output_item.added`
 * appends its item to an ordered output array at the position the event
 * declares, and every later event that names an `output_index` reads, and when
 * it carries a completed item replaces, that array entry. An item announced at
 * an index the client never accumulated fails the entire stream with the SDK's
 * `missing output at index N` error, which is exactly what a reasoning index
 * reserved without an announcement produced: the next item became the client's
 * first accumulated item while its content events still named the later index.
 */
const sdkAccumulateOutput = (events: readonly Record<string, unknown>[]): Record<string, unknown>[] => {
  const output: Record<string, unknown>[] = [];
  for (const event of events) {
    const type = String(event.type);
    if (type === "response.output_item.added") {
      assert.equal(event.output_index, output.length, `${type} must be accumulated at the output_index it declares`);
      output.push(event.item as Record<string, unknown>);
      continue;
    }
    if (typeof event.output_index !== "number") continue;
    const index = event.output_index;
    const item = output[index];
    assert.ok(item, `missing output at index ${index} for ${type}`);
    if (typeof event.item_id === "string") {
      assert.equal(event.item_id, item.id, `${type} must target the item accumulated at index ${index}`);
    }
    const replacement = event.item;
    if (replacement !== null && typeof replacement === "object" && !Array.isArray(replacement)) {
      const replaced = replacement as Record<string, unknown>;
      assert.equal(replaced.id, item.id, `${type} must close the item accumulated at index ${index}`);
      output[index] = replaced;
    }
  }
  return output;
};

const sse = (value: Record<string, unknown>): string => `data: ${JSON.stringify(value)}\n\n`;

/**
 * The pinned Codex client's single-active-item lifecycle, reduced to the facts
 * this adapter can violate. In `lib/codex/codex-rs/core/src/session/turn.rs`
 * only message and reasoning `response.output_item.added` events take the one
 * `active_item` slot (`handle_non_tool_response_item` returns `None` for tool
 * calls), every `response.output_item.done` clears that slot - tool items
 * included - and `stream_events_utils.rs::handle_output_item_done` emits a
 * second `ItemStarted` when a completed item finds no active item. A stream
 * that announces the next item before the current one completes therefore
 * closes the wrong item's slot and duplicates a start in the app-server.
 */
const codexItemLifecycle = (
  events: readonly Record<string, unknown>[]
): Readonly<{ started: string[]; completed: string[]; duplicateStarts: string[]; crossItemDones: string[]; activeId: string | null }> => {
  const occupiesActiveItem = (item: Record<string, unknown>): boolean => item.type === "message" || item.type === "reasoning";
  const started: string[] = [];
  const completed: string[] = [];
  const duplicateStarts: string[] = [];
  const crossItemDones: string[] = [];
  let activeId: string | null = null;
  for (const event of events) {
    const type = String(event.type);
    if (type === "response.output_item.added") {
      const item = event.item as Record<string, unknown>;
      if (!occupiesActiveItem(item)) continue;
      activeId = String(item.id);
      started.push(activeId);
      continue;
    }
    if (type !== "response.output_item.done") continue;
    const item = event.item as Record<string, unknown>;
    const id = String(item.id);
    const previousId = activeId;
    // `turn.rs` takes the active item on every done, tool items included.
    activeId = null;
    if (!occupiesActiveItem(item)) continue;
    if (previousId === null) {
      // The consumer synthesizes a start before completing a done with no active item.
      duplicateStarts.push(id);
      started.push(id);
    } else if (previousId !== id) {
      crossItemDones.push(id);
    }
    completed.push(id);
  }
  return { started, completed, duplicateStarts, crossItemDones, activeId };
};

/** No Codex-visible item may overlap the next one or start twice. */
const assertCodexItemLifecycle = (events: readonly Record<string, unknown>[]): void => {
  const lifecycle = codexItemLifecycle(events);
  assert.deepEqual(lifecycle.duplicateStarts, [], "a done must find its own active item, not synthesize a second start");
  assert.deepEqual(lifecycle.crossItemDones, [], "a done must close the item it names, not another item's active slot");
  assert.equal(lifecycle.activeId, null, "every started item must be completed");
  assert.deepEqual(lifecycle.completed, lifecycle.started, "each item starts once and completes in the same order");
};

/** The position of the first output-item event for one item type, or -1. */
const itemEventIndex = (
  events: readonly Record<string, unknown>[],
  type: "response.output_item.added" | "response.output_item.done",
  itemType: string
): number => events.findIndex((event) => event.type === type && (event.item as Record<string, unknown> | undefined)?.type === itemType);

/** Drives one raw SSE body through the transport the route consumes. */
const readChatStream = async (body: string): Promise<Record<string, unknown>[]> => {
  const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  const chunks: Record<string, unknown>[] = [];
  for await (const frame of iterateDeepSeekChatCompletionStream(response, "deepseek-flash")) {
    if (frame.kind === "chunk") chunks.push(frame.value);
  }
  return chunks;
};

const awaitAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true }
    );
  });

/** The kind a rejected DeepSeek transport error carries. */
const kindOf = (error: unknown): unknown => (error as { kind?: unknown }).kind;

test("m04 parity: answer text and fragmented tool calls agree between transports", () => {
  const streamed = streamedTerminal([
    chatChunk({ role: "assistant", content: "Weather: " }),
    chatChunk({ content: "sunny." }),
    chatChunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: '{"city":' } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }, { finish_reason: "tool_calls" }),
  ]);
  const buffered = bufferedPayload(
    {
      role: "assistant",
      content: "Weather: sunny.",
      tool_calls: [{ id: "call_a", type: "function", function: { name: "lookup", arguments: '{"city":"Oslo"}' } }],
    },
    "tool_calls"
  );

  assert.equal(streamed.type, "response.completed");
  assert.equal(buffered.status, "completed");
  assert.deepEqual(outputTypes(streamed.response), outputTypes(buffered));
  assert.deepEqual(outputTypes(streamed.response), ["message", "function_call"]);

  const streamedOutput = streamed.response.output as Record<string, unknown>[];
  const bufferedOutput = buffered.output as Record<string, unknown>[];
  assert.equal((streamedOutput[0].content as Record<string, unknown>[])[0].text, "Weather: sunny.");
  assert.equal((bufferedOutput[0].content as Record<string, unknown>[])[0].text, "Weather: sunny.");
  for (const item of [streamedOutput[1], bufferedOutput[1]]) {
    assert.equal(item.name, "lookup");
    assert.equal(item.call_id, "call_a");
    assert.equal(item.arguments, '{"city":"Oslo"}');
  }
});

test("m04 parity: fragmented tool calls announced out of call order keep output_index positions", () => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_order", echo, 1_780_000_000);
  const events: Record<string, unknown>[] = [];
  // Call 1 announces its name first while call 0 is still an anonymous
  // argument fragment, so announcement order and call index disagree.
  events.push(
    ...translator.push(
      chatChunk({
        role: "assistant",
        tool_calls: [
          { index: 0, id: "call_0", type: "function", function: { arguments: '{"a":' } },
          { index: 1, id: "call_1", type: "function", function: { name: "second", arguments: '{"b":' } },
        ],
      })
    )
  );
  events.push(
    ...translator.push(
      chatChunk(
        {
          tool_calls: [
            { index: 1, function: { arguments: "2}" } },
            { index: 0, function: { name: "first", arguments: "1}" } },
          ],
        },
        { finish_reason: "tool_calls" }
      )
    )
  );
  events.push(...translator.finish());

  const terminal = events.at(-1) as { response: Record<string, unknown> };
  const output = terminal.response.output as Record<string, unknown>[];
  assert.equal(output.length, 2);
  assert.deepEqual(
    output.map((item) => item.name),
    ["second", "first"]
  );
  // The invariant: every item sits in the terminal array at the `output_index`
  // its own added/done events announced, so a client that accumulated by index
  // and the terminal response describe the same output.
  let checked = 0;
  for (const event of events) {
    if (event.type !== "response.output_item.added") continue;
    const item = event.item;
    if (!item || typeof item !== "object") continue;
    const id = String((item as Record<string, unknown>).id);
    const index = Number(event.output_index);
    assert.equal(output[index]?.id, id, `item ${id} must sit at its announced output_index ${index}`);
    checked += 1;
  }
  assert.equal(checked, 2);
  assert.deepEqual(
    output.map((item) => item.arguments),
    ['{"b":2}', '{"a":1}']
  );
});

test("m04 parity: a reasoning item does not displace indexed items in the terminal output", () => {
  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_reasoning_slot", echo, 1_780_000_000);
  const events: Record<string, unknown>[] = [];
  events.push(...translator.push(chatChunk({ role: "assistant", reasoning_content: "thinking" })));
  events.push(...translator.push(chatChunk({ content: "answer" }, { finish_reason: "stop" })));
  events.push(...translator.finish());

  const terminal = events.at(-1) as { response: Record<string, unknown> };
  const output = terminal.response.output as Record<string, unknown>[];
  assert.deepEqual(
    output.map((item) => item.type),
    ["reasoning", "message"]
  );
  const added = events.find((event) => event.type === "response.output_item.added" && (event.item as Record<string, unknown>).type === "message");
  assert.ok(added);
  assert.equal(output[Number(added.output_index)].type, "message");
});

test("m04 parity: reasoning-first streams accumulate in the SDK's ordered output", () => {
  const events = streamedEvents([
    chatChunk({ role: "assistant", reasoning_content: "checking the weather " }),
    chatChunk({ reasoning_content: "for Oslo" }),
    chatChunk({ content: "Weather: " }),
    chatChunk(
      { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: '{"city":"Oslo"}' } }] },
      { finish_reason: "tool_calls" }
    ),
  ]);
  const accumulated = sdkAccumulateOutput(events);
  const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
  assert.equal(terminal.type, "response.completed");
  assert.deepEqual(
    accumulated.map((item) => item.type),
    ["reasoning", "message", "function_call"]
  );
  // The terminal response describes exactly what the client accumulated, at the
  // same positions, so no item is displaced or announced only in the terminal.
  assert.deepEqual(accumulated, terminal.response.output);
  const added = events.filter((event) => event.type === "response.output_item.added");
  assert.deepEqual(
    added.map((event) => [event.output_index, (event.item as Record<string, unknown>).type]),
    [
      [0, "reasoning"],
      [1, "message"],
      [2, "function_call"],
    ]
  );
  // The buffered transport reaches the same items in the same order.
  const buffered = bufferedPayload(
    {
      role: "assistant",
      reasoning_content: "checking the weather for Oslo",
      content: "Weather: ",
      tool_calls: [{ id: "call_a", type: "function", function: { name: "lookup", arguments: '{"city":"Oslo"}' } }],
    },
    "tool_calls"
  );
  assert.deepEqual(outputTypes(terminal.response), outputTypes(buffered));
});

test("m04 parity: reasoning that arrives after text is announced at its own later index", () => {
  // The provider sends reasoning before content, but the lifecycle must stay
  // coherent whatever order the deltas arrive in: a late reasoning item is
  // announced at the index it actually owns instead of displacing the answer.
  const events = streamedEvents([
    chatChunk({ role: "assistant", content: "answer first" }),
    chatChunk({ reasoning_content: "reconsidered" }, { finish_reason: "stop" }),
  ]);
  const accumulated = sdkAccumulateOutput(events);
  const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
  assert.deepEqual(
    accumulated.map((item) => item.type),
    ["message", "reasoning"]
  );
  assert.deepEqual(accumulated, terminal.response.output);
  const added = events.filter((event) => event.type === "response.output_item.added");
  assert.deepEqual(
    added.map((event) => [event.output_index, (event.item as Record<string, unknown>).type]),
    [
      [0, "message"],
      [1, "reasoning"],
    ]
  );
  // Every event that describes the reasoning names index 1, the slot its own
  // announcement claimed.
  const reasoningEvents = events.filter(
    (event) => String(event.type).includes("reasoning") || (event.item as Record<string, unknown> | undefined)?.type === "reasoning"
  );
  assert.ok(reasoningEvents.length >= 4);
  for (const event of reasoningEvents) assert.equal(event.output_index, 1);
  // The buffered transport keeps its established reasoning-first order for the
  // same Chat message; both transports carry the same two items.
  const buffered = bufferedPayload({ role: "assistant", content: "answer first", reasoning_content: "reconsidered" });
  assert.deepEqual(outputTypes(buffered), ["reasoning", "message"]);
  assert.deepEqual(
    accumulated.map((item) => item.type).sort((left, right) => String(left).localeCompare(String(right))),
    outputTypes(buffered).sort((left, right) => String(left).localeCompare(String(right)))
  );
});

test("m04 parity: a refusal after reasoning keeps every SDK event on its own item", () => {
  const refusal = "I cannot help with that.";
  const events = streamedEvents([
    chatChunk({ role: "assistant", reasoning_content: "checking the request" }),
    chatChunk({ refusal }),
    chatChunk({}, { finish_reason: "stop" }),
  ]);
  const accumulated = sdkAccumulateOutput(events);
  const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
  assert.deepEqual(
    accumulated.map((item) => item.type),
    ["reasoning", "message"]
  );
  assert.deepEqual(accumulated, terminal.response.output);
  assert.deepEqual((accumulated[1].content as Record<string, unknown>[])[0], { type: "refusal", refusal });
  assert.ok(events.some((event) => event.type === "response.refusal.done"));

  const buffered = bufferedPayload({ role: "assistant", content: null, refusal, reasoning_content: "checking the request" });
  assert.deepEqual(outputTypes(buffered), ["reasoning", "message"]);
  assert.deepEqual((buffered.output as Record<string, unknown>[])[1].content, [{ type: "refusal", refusal }]);
});

test("m04 parity: a reasoning-only stop accumulates its single indexed item on both transports", () => {
  const events = streamedEvents([chatChunk({ role: "assistant", reasoning_content: "thinking only" }), chatChunk({}, { finish_reason: "stop" })]);
  const accumulated = sdkAccumulateOutput(events);
  const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
  assert.equal(terminal.type, "response.completed");
  assert.deepEqual(
    accumulated.map((item) => item.type),
    ["reasoning"]
  );
  assert.deepEqual(accumulated, terminal.response.output);

  const buffered = bufferedPayload({ role: "assistant", content: null, reasoning_content: "thinking only" });
  assert.deepEqual(outputTypes(buffered), ["reasoning"]);
});

test("m04 Codex: reasoning then text completes reasoning before the message starts", () => {
  const events = streamedEvents([
    chatChunk({ role: "assistant", reasoning_content: "consider " }),
    chatChunk({ reasoning_content: "the answer" }),
    chatChunk({ content: "pong" }, { finish_reason: "stop" }),
  ]);
  // The pinned consumer must never see the reasoning item open while the message
  // is active; before this correction its done event cleared the message slot
  // and the message's done re-emitted a second ItemStarted.
  assertCodexItemLifecycle(events);
  const reasoningDone = itemEventIndex(events, "response.output_item.done", "reasoning");
  const messageAdded = itemEventIndex(events, "response.output_item.added", "message");
  assert.ok(reasoningDone >= 0 && messageAdded > reasoningDone, "reasoning must close before the message is announced");
  // The SDK still accumulates both items at the indexes their added events named.
  const accumulated = sdkAccumulateOutput(events);
  const terminal = events.at(-1) as { response: Record<string, unknown> };
  assert.deepEqual(accumulated, terminal.response.output);
  assert.deepEqual(
    accumulated.map((item) => item.type),
    ["reasoning", "message"]
  );
  assert.equal(((accumulated[0].summary as Record<string, unknown>[])[0] as Record<string, unknown>).text, "consider the answer");
  assert.equal(((accumulated[1].content as Record<string, unknown>[])[0] as Record<string, unknown>).text, "pong");
});

test("m04 Codex: reasoning then a tool call completes reasoning before the call is announced", () => {
  const events = streamedEvents([
    chatChunk({ role: "assistant", reasoning_content: "the city needs a lookup" }),
    chatChunk(
      { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: '{"city":"Oslo"}' } }] },
      { finish_reason: "tool_calls" }
    ),
  ]);
  assertCodexItemLifecycle(events);
  const reasoningDone = itemEventIndex(events, "response.output_item.done", "reasoning");
  const toolAdded = itemEventIndex(events, "response.output_item.added", "function_call");
  assert.ok(reasoningDone >= 0 && toolAdded > reasoningDone, "reasoning must close before the tool call is announced");
  const accumulated = sdkAccumulateOutput(events);
  const terminal = events.at(-1) as { response: Record<string, unknown> };
  assert.deepEqual(accumulated, terminal.response.output);
  assert.deepEqual(
    accumulated.map((item) => item.type),
    ["reasoning", "function_call"]
  );
});

test("m04 Codex: late reasoning is delivered as one closed item after the answer", () => {
  // The provider's normal order is reasoning first; this is the supported
  // robustness case where reasoning follows text. It cannot be announced while
  // the message is active, so it is delivered as one closed lifecycle after the
  // message completes and never targets an already-completed item.
  const events = streamedEvents([
    chatChunk({ role: "assistant", content: "answer first" }),
    chatChunk({ reasoning_content: "reconsidered" }, { finish_reason: "stop" }),
  ]);
  assertCodexItemLifecycle(events);
  const messageDone = itemEventIndex(events, "response.output_item.done", "message");
  const reasoningAdded = itemEventIndex(events, "response.output_item.added", "reasoning");
  assert.ok(messageDone >= 0 && reasoningAdded > messageDone, "late reasoning must be announced after the message completes");
  const accumulated = sdkAccumulateOutput(events);
  const terminal = events.at(-1) as { response: Record<string, unknown> };
  assert.deepEqual(accumulated, terminal.response.output);
  assert.deepEqual(
    accumulated.map((item) => item.type),
    ["message", "reasoning"]
  );
  assert.equal(((accumulated[1].summary as Record<string, unknown>[])[0] as Record<string, unknown>).text, "reconsidered");
});

test("m04 Codex: deferred reasoning stays ahead of the tool call it belongs to for history replay", () => {
  // content -> reasoning_content -> tool_calls. The deferred reasoning must be
  // flushed before the tool item, or the delivered output is
  // [message, function_call, reasoning] and replaying it with the tool result
  // drops the reasoning (it is only consumed by a following assistant item).
  // The first tool delta already carries the name, so only the deferral holds
  // its lifecycle back; the rest of the fragmented arguments keep merging.
  const events = streamedEvents([
    chatChunk({ role: "assistant", content: "Weather: " }),
    chatChunk({ reasoning_content: "checking the city" }),
    chatChunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: '{"city":' } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }, { finish_reason: "tool_calls" }),
  ]);
  assertCodexItemLifecycle(events);
  const accumulated = sdkAccumulateOutput(events);
  const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
  assert.equal(terminal.type, "response.completed");
  const output = terminal.response.output as Record<string, unknown>[];
  assert.deepEqual(
    output.map((item) => item.type),
    ["message", "reasoning", "function_call"]
  );
  assert.deepEqual(accumulated, output);
  assert.deepEqual(
    events.filter((event) => event.type === "response.output_item.added").map((event) => [event.output_index, (event.item as Record<string, unknown>).type]),
    [
      [0, "message"],
      [1, "reasoning"],
      [2, "function_call"],
    ]
  );
  // The tool item keeps the fully buffered fragmented arguments.
  assert.equal(output[2].arguments, '{"city":"Oslo"}');
  assert.equal(((output[1].summary as Record<string, unknown>[])[0] as Record<string, unknown>).text, "checking the city");

  // Replaying the delivered output with its matching tool result attaches the
  // exact reasoning text to the assistant turn that carries the tool call.
  const replay = toDeepSeekResponsesChatBody(
    { input: [...output, { type: "function_call_output", call_id: "call_a", output: "Oslo" }] },
    "deepseek-flash",
    false
  );
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.value.body.messages, [
    { role: "assistant", content: "Weather: " },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_a", type: "function", function: { name: "lookup", arguments: '{"city":"Oslo"}' } }],
      reasoning_content: "checking the city",
    },
    { role: "tool", tool_call_id: "call_a", content: "Oslo" },
  ]);
});

test("m04 parity: a refusal is answer-bearing payload on both transports", () => {
  const refusal = "I cannot help with that.";
  const buffered = bufferedPayload({ role: "assistant", content: null, refusal });

  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_refusal", echo, 1_780_000_000);
  const streamedEvents: Record<string, unknown>[] = [];
  streamedEvents.push(...translator.push(chatChunk({ role: "assistant", refusal })));
  streamedEvents.push(...translator.push(chatChunk({}, { finish_reason: "stop" })));
  streamedEvents.push(...translator.finish());
  const terminal = streamedEvents.at(-1) as { type: string; response: Record<string, unknown> };

  assert.equal(terminal.type, "response.completed");
  // This is the view the streamed route fails a degenerate completion on
  // (`src/openai.ts` around the DeepSeek Responses translator's terminal), so a
  // refusal must be visible here or the refusal is reported as an empty
  // completion and its text is lost.
  assert.equal(isAnswerBearingCompletion(translator.answerBearingOutput()), true);
  assert.ok(streamedEvents.some((event) => event.type === "response.refusal.done"));

  const streamedOutput = terminal.response.output as Record<string, unknown>[];
  const bufferedOutput = buffered.output as Record<string, unknown>[];
  assert.equal(buffered.status, "completed");
  assert.deepEqual(outputTypes(terminal.response), ["message"]);
  assert.deepEqual(outputTypes(buffered), ["message"]);
  assert.deepEqual(streamedOutput[0].content, [{ type: "refusal", refusal }]);
  assert.deepEqual(bufferedOutput[0].content, [{ type: "refusal", refusal }]);
});

test("m04 parity: a normalized refusal delta reaches the streamed translator", async () => {
  const refusal = "I will not do that.";
  const chunks = await readChatStream(
    [sse(chatChunk({ role: "assistant", refusal })), sse({ ...chatChunk({}), choices: [{ index: 0, finish_reason: "stop" }] }), "data: [DONE]\n\n"].join("")
  );
  const delta = (chunks[0].choices as Record<string, unknown>[])[0].delta as Record<string, unknown>;
  assert.equal(delta.refusal, refusal);

  const translator = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_refusal_norm", echo, 1_780_000_000);
  const events: Record<string, unknown>[] = [];
  for (const chunk of chunks) events.push(...translator.push(chunk));
  events.push(...translator.finish());

  // The documented `response.refusal.delta` fields, in the same shape every
  // other translator event uses (this translator emits no `sequence_number`).
  const refusalDelta = events.find((event) => event.type === "response.refusal.delta");
  assert.ok(refusalDelta);
  assert.equal(refusalDelta.item_id, "msg_resp_refusal_norm_0");
  assert.equal(refusalDelta.output_index, 0);
  assert.equal(refusalDelta.content_index, 0);
  assert.equal(refusalDelta.delta, refusal);

  const terminal = events.at(-1) as { type: string; response: Record<string, unknown> };
  assert.equal(terminal.type, "response.completed");
  assert.equal(isAnswerBearingCompletion(translator.answerBearingOutput()), true);
  assert.deepEqual(outputTypes(terminal.response), ["message"]);
  assert.deepEqual((terminal.response.output as Record<string, unknown>[])[0].content, [{ type: "refusal", refusal }]);
});

test("m04 parity: a normalized refusal-only completion is carried by the buffered adapter", () => {
  const refusal = "I will not do that.";
  const normalized = normalizeDeepSeekChatCompletion(chatCompletion({ role: "assistant", content: null, refusal }), "deepseek-flash");
  if (!normalized.ok) throw new Error(normalized.message);
  assert.equal(((normalized.value.choices as Record<string, unknown>[])[0].message as Record<string, unknown>).refusal, refusal);

  const payload = toDeepSeekResponsesPayload(normalized.value, "deepseek-flash", "resp_refusal_norm", echo);
  assert.equal(payload.status, "completed");
  assert.deepEqual(outputTypes(payload), ["message"]);
  assert.deepEqual((payload.output as Record<string, unknown>[])[0].content, [{ type: "refusal", refusal }]);
});

test("m04 parity: a non-string refusal is rejected by the transport, not dropped", async () => {
  await assert.rejects(readChatStream(`${sse(chatChunk({ role: "assistant", refusal: 42 }))}data: [DONE]\n\n`), (error) => kindOf(error) === "invalid_chunk");

  const buffered = normalizeDeepSeekChatCompletion(chatCompletion({ role: "assistant", content: "hi", refusal: 42 }), "deepseek-flash");
  assert.equal(buffered.ok, false);
});

test("m04 parity: a null refusal is absence, not a malformed chunk", async () => {
  // The official Chat schema types `refusal` as an optional string or null, so
  // an ordinary null must stay a normal completion rather than becoming a new
  // 502 on either transport.
  const chunks = await readChatStream(
    [
      sse(chatChunk({ role: "assistant", content: "hi", refusal: null })),
      sse({ ...chatChunk({}), choices: [{ index: 0, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ].join("")
  );
  const delta = (chunks[0].choices as Record<string, unknown>[])[0].delta as Record<string, unknown>;
  assert.equal("refusal" in delta, false);

  const buffered = normalizeDeepSeekChatCompletion(chatCompletion({ role: "assistant", content: "hi", refusal: null }), "deepseek-flash");
  if (!buffered.ok) throw new Error(buffered.message);
  const message = (buffered.value.choices as Record<string, unknown>[])[0].message as Record<string, unknown>;
  assert.equal("refusal" in message, false);
  assert.equal(message.content, "hi");
});

test("m04 parity: a reasoning-only nominal stop is a completion nothing can act on", () => {
  const streamed = streamedTerminal([chatChunk({ role: "assistant", reasoning_content: "thinking only" }), chatChunk({}, { finish_reason: "stop" })]);
  assert.equal(streamed.type, "response.completed");
  assert.deepEqual(outputTypes(streamed.response), ["reasoning"]);
  // The route fails this closed as `empty_upstream_completion` on both
  // transports because this view carries no answer (src/openai.ts: the buffered
  // DeepSeek branch and the streamed empty-completion guard).
  const probe = createDeepSeekResponsesStreamTranslator("deepseek-flash", "resp_reasoning_only", echo, 1_780_000_000);
  probe.push(chatChunk({ role: "assistant", reasoning_content: "thinking only" }));
  probe.push(chatChunk({}, { finish_reason: "stop" }));
  assert.equal(isAnswerBearingCompletion(probe.answerBearingOutput()), false);

  // The buffered transport reaches the same validity input: its normalized
  // message carries no answer text, no tool call and no refusal. (Reasoning is
  // transport payload, so normalization keeps the completion; it is not answer
  // payload, so the shared predicate still refuses it.)
  const normalized = normalizeDeepSeekChatCompletion(
    chatCompletion({ role: "assistant", content: null, reasoning_content: "thinking only" }),
    "deepseek-flash"
  );
  if (!normalized.ok) throw new Error(normalized.message);
  const message = (normalized.value.choices as Record<string, unknown>[])[0].message as Record<string, unknown>;
  assert.equal(message.content, "");
  assert.equal("tool_calls" in message, false);
  assert.equal("refusal" in message, false);
  assert.deepEqual(outputTypes(bufferedPayload({ role: "assistant", content: null, reasoning_content: "thinking only" })), ["reasoning"]);
});

test("m04 parity: explicit length and content_filter stops are incompletions on both transports", () => {
  for (const [reason, expected] of [
    ["length", "max_output_tokens"],
    ["content_filter", "content_filter"],
  ] as const) {
    const streamed = streamedTerminal([chatChunk({ role: "assistant", reasoning_content: "only thinking" }), chatChunk({}, { finish_reason: reason })]);
    assert.equal(streamed.type, "response.incomplete");
    assert.equal(streamed.response.status, "incomplete");
    assert.equal(streamed.response.error, null);
    assert.deepEqual(streamed.response.incomplete_details, { reason: expected });

    const buffered = bufferedPayload({ role: "assistant", content: null, reasoning_content: "only thinking" }, reason);
    assert.equal(buffered.status, "incomplete");
    assert.equal(buffered.error, null);
    assert.deepEqual(buffered.incomplete_details, { reason: expected });
  }
});

test("m04 parity: malformed terminals and abrupt EOF cannot reach a completed terminal", async () => {
  const chunk = chatChunk({ role: "assistant", content: "partial" });

  // The provider's [DONE] sentinel is what ends a Chat stream; a body that stops
  // before it is a transport failure, never a finished generation.
  await assert.rejects(readChatStream(sse(chunk)), (error) => kindOf(error) === "premature_eof");

  // A malformed finish reason is rejected by the transport validator instead of
  // being read as an absent reason (which would mean `stop`).
  await assert.rejects(
    readChatStream(`${sse({ ...chunk, choices: [{ index: 0, delta: { content: "x" }, finish_reason: 42 }] })}data: [DONE]\n\n`),
    (error) => kindOf(error) === "invalid_chunk"
  );

  await assert.rejects(readChatStream("data: {not json}\n\n"), (error) => kindOf(error) === "malformed_event");

  // An unrecognized reason string is a failed terminal that keeps the provider's
  // own value visible rather than a silent completion.
  const unknown = streamedTerminal([chatChunk({ role: "assistant", content: "partial" }, { finish_reason: "something_new" })]);
  assert.equal(unknown.type, "response.failed");
  assert.equal(unknown.response.status, "failed");
  assert.deepEqual(unknown.response.error, {
    code: "unrecognized_finish_reason:something_new",
    message: "DeepSeek stopped generating: unrecognized_finish_reason:something_new",
  });
  assert.deepEqual(unknown.response.incomplete_details, null);
});

test("m04 deadline: a queued wait spends the shared attempt budget instead of restarting it", async () => {
  const request = new AbortController();
  const shared = createStreamFirstEventDeadline(request.signal, 1_000);
  // Stand-in for queue waiting: the wait happens inside the caller's budget.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const remaining = shared.remainingMs();
  assert.ok(remaining > 0 && remaining < 1_000);

  const attempt = createStreamSemanticDeadline(shared.signal, Math.ceil(remaining));
  await awaitAbort(attempt.signal);
  assert.equal(attempt.signal.reason?.name, "TimeoutError");
  // The attempt's own budget is the shared remainder, so both deadlines expire
  // together instead of the attempt outliving the caller's budget.
  await awaitAbort(shared.signal);
  assert.equal(shared.signal.aborted, true);
  attempt.clear();
  shared.clear();
});

test("m04 deadline: a wait that outlives the budget leaves nothing to dispatch", async () => {
  const shared = createStreamFirstEventDeadline(new AbortController().signal, 40);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(shared.signal.aborted, true);
  assert.equal(shared.remainingMs(), 0);

  // Composing the remainder is what makes the already-spent budget visible to
  // the dispatch it guards; a fresh full timeout here would send a request the
  // caller has already abandoned.
  const attempt = createStreamSemanticDeadline(shared.signal, Math.ceil(shared.remainingMs()));
  await awaitAbort(attempt.signal);
  assert.equal(attempt.signal.aborted, true);
  attempt.clear();
  shared.clear();
});

test("m04 deadline: client cancellation composes through every attempt deadline", () => {
  const request = new AbortController();
  const shared = createStreamFirstEventDeadline(request.signal, 60_000);
  const attempt = createStreamSemanticDeadline(shared.signal, 60_000);
  const paid = createPaidProviderAttemptDeadline(shared.signal);
  const reason = new DOMException("client disconnected", "AbortError");

  request.abort(reason);

  assert.equal(shared.signal.reason, reason);
  assert.equal(attempt.signal.reason, reason);
  assert.equal(paid.signal.reason, reason);
  attempt.clear();
  paid.clear();
  shared.clear();
});

test("m04 deadline: an attempt-local abort does not cancel the shared budget", () => {
  const request = new AbortController();
  const shared = createStreamFirstEventDeadline(request.signal, 60_000);
  const attempt = createStreamSemanticDeadline(shared.signal, 60_000);
  const reason = new DOMException("attempt abandoned", "AbortError");

  attempt.abort(reason);

  assert.equal(attempt.signal.aborted, true);
  assert.equal(attempt.signal.reason, reason);
  // A single failed attempt must leave the caller's budget usable for the
  // fallback attempt that composes its own remainder from `remainingMs()`.
  assert.equal(shared.signal.aborted, false);
  assert.ok(shared.remainingMs() > 0);
  attempt.clear();
  shared.clear();
});

test("m04 deadline: aborting a deadline releases its timer", () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const armed = new Set<number>();
  // The deadline budget is deliberately short so a leaked timer cannot keep the
  // test process waiting on a 30-minute handle.
  const budgetMs = 250;
  Reflect.set(globalThis, "setTimeout", (handler: unknown, timeout?: number, ...args: unknown[]) => {
    const id = Reflect.apply(originalSetTimeout, undefined, [handler, timeout, ...args]) as number;
    armed.add(id);
    return id;
  });
  Reflect.set(globalThis, "clearTimeout", (id?: number) => {
    if (id !== undefined) armed.delete(id);
    originalClearTimeout(id);
  });
  try {
    const deadline = createStreamSemanticDeadline(new AbortController().signal, budgetMs);
    assert.equal(armed.size, 1, "creating a deadline arms its budget timer");
    deadline.abort(new DOMException("attempt abandoned", "AbortError"));
    assert.equal(deadline.signal.aborted, true);
    // An abandoned attempt must not keep its timer armed; `clear()` is not
    // required for the abort path to release the handle.
    assert.equal(armed.size, 0, "abort() must release the attempt deadline timer");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("m04 deadline: abort still aborts after clear", () => {
  const shared = createStreamFirstEventDeadline(new AbortController().signal, 60_000);
  const attempt = createStreamSemanticDeadline(shared.signal, 60_000);
  attempt.clear();
  assert.equal(attempt.signal.aborted, false);

  // Clearing the timer must not remove the ability to abort a composed signal.
  const reason = new DOMException("attempt abandoned", "AbortError");
  attempt.abort(reason);
  assert.equal(attempt.signal.aborted, true);
  assert.equal(attempt.signal.reason, reason);
  shared.clear();
});
