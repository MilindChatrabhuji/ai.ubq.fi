import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { test } from "bun:test";
// Branch-coverage tests for src/responses-failover-stream.ts.
//
// The module is a pure event classifier plus one owned ReadableStream. These
// tests drive the classifier with each provider event shape and then drive the
// stream through success, premature EOF, empty completion, cancellation and the
// RemovedProvider warning preamble.

import assert from "node:assert/strict";
import {
  appendResponsesPrecommitEvent,
  buildFailoverWarningEvents,
  createOwnedResponsesStream,
  failoverWarningText,
  failureEventAfterCommit,
  isGatewayFailoverWarningItem,
  isSyntheticResponsesFailureEvent,
  MAX_RESPONSES_PRECOMMIT_CHARS,
  MAX_RESPONSES_PRECOMMIT_EVENTS,
  prepareResponsesStreamForCommit,
  responseEventFromValue,
  responseIdFromEvents,
  responsesEventReportsProgress,
  responsesEventSemanticKind,
  rewriteResponsesEventForWarning,
  rewriteResponsesEventSequence,
} from "../src/responses-failover-stream.ts";
import { ResponsesStreamError, type ResponsesStreamEvent, type ResponsesStreamIterator } from "../src/responses-stream.ts";

const event = (value: Record<string, unknown>): ResponsesStreamEvent => responseEventFromValue(value);

// The iterator contract is an async generator, so the fixture drains through an
// asynchronous source exactly like the upstream reader does.
const iterator = (events: readonly ResponsesStreamEvent[]): ResponsesStreamIterator =>
  (async function* () {
    yield* NodeReadableStream.from(events);
  })();

/** An iterator whose first read rejects, built without a yield-less generator body. */
type FailingIteratorHandle = Readonly<{
  next: () => Promise<never>;
  return: () => Promise<IteratorResult<unknown, unknown>>;
  throw: () => Promise<never>;
  [Symbol.asyncIterator]: () => FailingIteratorHandle;
}>;

const failingIterator = (error: Error): ResponsesStreamIterator => {
  const handle: FailingIteratorHandle = {
    next: () => Promise.reject(error),
    return: () => Promise.resolve({ done: true, value: undefined }),
    throw: () => Promise.reject(error),
    [Symbol.asyncIterator]: () => handle,
  };
  return handle as unknown as ResponsesStreamIterator;
};

const readerOf = (stream: ReadableStream<Uint8Array>) => stream.getReader();
const textOf = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = readerOf(stream);
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text;
    text += decoder.decode(chunk.value, { stream: true });
  }
};

/**
 * The failure callbacks run after the stream releases its iterator, so a test
 * that inspects them drains the pending promise jobs first. This is deterministic:
 * no timers and no wall-clock input.
 */
const flushMicrotasks = async (): Promise<void> => {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
};

const sseData = (text: string): Record<string, unknown>[] =>
  [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1] as string) as Record<string, unknown>);

test("semantic classifier rejects incomplete executable tool call items", () => {
  const kinds = [
    event({ type: "response.output_item.done", item: { type: "function_call", name: "lookup", arguments: "{}" } }),
    event({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", arguments: "{}" } }),
    event({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "  ", arguments: "{}" } }),
    event({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "lookup", arguments: null } }),
    event({ type: "response.output_item.done", item: { type: "custom_tool_call", call_id: "call_2", name: "shell", input: null } }),
    event({ type: "response.output_item.done", item: { type: "not_a_tool", call_id: "call_3", name: "lookup" } }),
  ];
  for (const value of kinds) assert.equal(responsesEventSemanticKind(value), null, value.type);

  assert.equal(
    responsesEventSemanticKind(event({ type: "response.output_item.done", item: { type: "custom_tool_call", call_id: "call_2", name: "shell", input: "ls" } })),
    "tool_call"
  );
  assert.equal(
    responsesEventSemanticKind(event({ type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "lookup", arguments: "" } })),
    "tool_call"
  );
});

test("semantic classifier accepts hosted tool lifecycles and ignores other statuses", () => {
  for (const status of ["in_progress", "completed", "failed"]) {
    assert.equal(responsesEventSemanticKind(event({ type: "response.output_item.done", item: { type: "web_search_call", status } })), "tool_call", status);
  }
  assert.equal(responsesEventSemanticKind(event({ type: "response.output_item.done", item: { type: "web_search_call" } })), null);
  assert.equal(responsesEventSemanticKind(event({ type: "response.output_item.done", item: { type: "web_search_call", status: "queued" } })), null);
  assert.equal(responsesEventSemanticKind(event({ type: "response.web_search_call.completed" })), "tool_call");
  assert.equal(responsesEventSemanticKind(event({ type: "response.code_interpreter_call.failed" })), "tool_call");
  assert.equal(responsesEventSemanticKind(event({ type: "response.web_search_call.searching" })), null);
});

test("semantic classifier reads output payloads, content parts and image partials", () => {
  const payload = (output: unknown): ResponsesStreamEvent => event({ type: "response.completed", response: { id: "resp_1", output } });
  assert.equal(responsesEventSemanticKind(payload([{ type: "message", content: [{ type: "output_text", text: "hello" }] }])), "text");
  assert.equal(responsesEventSemanticKind(payload([{ type: "message", content: [{ type: "output_text", text: "" }] }])), null);
  assert.equal(responsesEventSemanticKind(payload([{ type: "message", content: "not-an-array" }])), null);
  assert.equal(responsesEventSemanticKind(payload([{ type: "reasoning", content: [{ type: "output_text", text: "hidden" }] }])), null);
  assert.equal(responsesEventSemanticKind(payload([7, { type: "message", content: [{ type: "refusal", refusal: "no" }] }])), "text");
  assert.equal(responsesEventSemanticKind(payload("not-an-array")), null);

  // The compatibility `output` field on the event itself is the second source.
  assert.equal(
    responsesEventSemanticKind(event({ type: "response.output", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] })),
    "text"
  );

  assert.equal(responsesEventSemanticKind(event({ type: "response.content_part.done", part: { type: "output_text", text: "part" } })), "text");
  assert.equal(responsesEventSemanticKind(event({ type: "response.content_part.done", part: { type: "refusal", refusal: "stop" } })), "text");
  assert.equal(responsesEventSemanticKind(event({ type: "response.content_part.done", part: { type: "output_text", text: "" } })), null);
  assert.equal(responsesEventSemanticKind(event({ type: "response.content_part.done", part: 7 })), null);
  assert.equal(responsesEventSemanticKind(event({ type: "response.refusal.done", refusal: "declined" })), "text");
  assert.equal(responsesEventSemanticKind(event({ type: "response.refusal.delta", refusal: "" })), null);

  assert.equal(responsesEventSemanticKind(event({ type: "response.image_generation_call.partial_image", partial_image_b64: "AAAA" })), "tool_call");
  assert.equal(responsesEventSemanticKind(event({ type: "response.image_generation_call.partial_image", result: "done" })), "tool_call");
  assert.equal(responsesEventSemanticKind(event({ type: "response.image_generation_call.partial_image" })), null);
});

test("progress detector reports reasoning work and ignores unusable identifiers", () => {
  assert.equal(responsesEventReportsProgress(event({ type: "response.reasoning_summary_part.added", summary_index: 2 })), true);
  assert.equal(responsesEventReportsProgress(event({ type: "response.reasoning_summary_part.added" })), false);
  assert.equal(responsesEventReportsProgress(event({ type: "response.reasoning_summary_text.delta", delta: "x", summary_index: "0" })), false);
  assert.equal(responsesEventReportsProgress(event({ type: "response.reasoning_text.delta", delta: "x", content_index: 1 })), true);
  assert.equal(responsesEventReportsProgress(event({ type: "response.output_item.added", item: { id: "rs_1", type: "reasoning", summary: [] } })), true);
  assert.equal(responsesEventReportsProgress(event({ type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } })), false);
  assert.equal(responsesEventReportsProgress(event({ type: "response.output_item.done", item: { type: "reasoning", content: [] } })), false);
  assert.equal(responsesEventReportsProgress(event({ type: "response.output_item.done", item: "not-a-record" })), false);
  assert.equal(responsesEventReportsProgress(event({ type: "response.output_text.delta", delta: "visible" })), false);
});

test("precommit buffering enforces its event and character budgets", () => {
  const buffered: ResponsesStreamEvent[] = [];
  const single = event({ type: "response.output_text.delta", delta: "x" });
  assert.equal(appendResponsesPrecommitEvent(buffered, single, 0), single.raw.length);

  const oversized = "x".repeat(MAX_RESPONSES_PRECOMMIT_CHARS + 1);
  assert.throws(
    () => appendResponsesPrecommitEvent([], event({ type: "response.output_text.delta", delta: oversized }), 0),
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "event_too_large"
  );

  const many = Array.from({ length: MAX_RESPONSES_PRECOMMIT_EVENTS }, () => single);
  assert.throws(
    () => appendResponsesPrecommitEvent(many, single, 0),
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "event_too_large"
  );
});

test("precommit preparation stops at semantic output, terminal events and premature EOF", async () => {
  const semantic = event({ type: "response.output_text.delta", delta: "hello" });
  const prepared = await prepareResponsesStreamForCommit(iterator([event({ type: "response.created" }), semantic]));
  assert.equal(prepared.semantic, semantic);
  assert.equal(prepared.semanticKind, "text");
  assert.equal(prepared.terminal, null);
  assert.equal(prepared.buffered.length, 2);

  const terminal = event({ type: "response.failed", sequence_number: 1 });
  const terminalPrepared = await prepareResponsesStreamForCommit(iterator([terminal]));
  assert.equal(terminalPrepared.semantic, null);
  assert.equal(terminalPrepared.terminal, terminal);

  const progressEvents: ResponsesStreamEvent[] = [];
  const released = await prepareResponsesStreamForCommit(iterator([event({ type: "response.reasoning_summary_text.delta", delta: "x", summary_index: 0 })]), {
    onProgress: (progressEvent) => progressEvents.push(progressEvent),
    releaseOnProgress: true,
  });
  assert.equal(released.semantic, null);
  assert.equal(released.terminal, null);
  assert.equal(progressEvents.length, 1);

  // Lifecycle-keyed progress is reported once; keyless progress is reported per event.
  let progressCount = 0;
  const repeatedPart = event({ type: "response.reasoning_summary_part.added", summary_index: 0 });
  const held = await prepareResponsesStreamForCommit(iterator([repeatedPart, repeatedPart, terminal]), {
    onProgress: () => {
      progressCount += 1;
    },
  });
  assert.equal(progressCount, 1);
  assert.equal(held.terminal, terminal);

  let keylessCount = 0;
  const repeatedDelta = event({ type: "response.reasoning_summary_text.delta", delta: "y", summary_index: 0 });
  await prepareResponsesStreamForCommit(iterator([repeatedDelta, repeatedDelta, terminal]), {
    onProgress: () => {
      keylessCount += 1;
    },
  });
  assert.equal(keylessCount, 2);

  await assert.rejects(
    () => prepareResponsesStreamForCommit(iterator([])),
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "premature_eof"
  );

  // A failing iterator is released and the original error surfaces.
  const failure = new Error("upstream read failed");
  await assert.rejects(() => prepareResponsesStreamForCommit(failingIterator(failure)), failure);
});

test("warning helpers identify exactly the injected assistant notice", () => {
  const { item, events } = buildFailoverWarningEvents("gpt-5.6-sol", "resp_1", 5);
  assert.equal(isGatewayFailoverWarningItem(item), true);
  assert.equal(events.length, 6);
  assert.equal(events[0].value.sequence_number, 5);
  assert.equal(events.at(-1)?.value.sequence_number, 10);
  assert.equal(isSyntheticResponsesFailureEvent(events[0]), false);

  assert.equal(isGatewayFailoverWarningItem(null), false);
  assert.equal(isGatewayFailoverWarningItem([item]), false);
  assert.equal(isGatewayFailoverWarningItem({ ...item, type: "function_call" }), false);
  assert.equal(isGatewayFailoverWarningItem({ ...item, role: "user" }), false);
  assert.equal(isGatewayFailoverWarningItem({ ...item, id: "msg_other" }), false);
  assert.equal(isGatewayFailoverWarningItem({ ...item, content: [] }), false);
  assert.equal(
    isGatewayFailoverWarningItem({
      ...item,
      content: [
        { type: "output_text", text: "x" },
        { type: "output_text", text: "y" },
      ],
    }),
    false
  );
  assert.equal(isGatewayFailoverWarningItem({ ...item, content: [{ type: "input_text", text: failoverWarningText("m") }] }), false);
  assert.equal(isGatewayFailoverWarningItem({ ...item, content: [{ type: "output_text", text: "not the notice" }] }), false);
  assert.equal(isGatewayFailoverWarningItem({ ...item, content: [{ type: "output_text", text: failoverWarningText("m").slice(0, -1) }] }), false);
});

test("warning rewrites increment output indexes and prefix terminal outputs", () => {
  const { item } = buildFailoverWarningEvents("gpt-5.6-sol", "resp_1");
  const delta = event({ type: "response.output_text.delta", output_index: 2, delta: "x" });
  const rewritten = rewriteResponsesEventForWarning(delta, item, 7);
  assert.equal(rewritten.value.sequence_number, 7);
  assert.equal(rewritten.value.output_index, 3);
  assert.equal(rewritten.value.delta, "x");

  const nonNumericIndex = rewriteResponsesEventForWarning(event({ type: "response.output_text.delta", output_index: "2", delta: "x" }), item, 8);
  assert.equal(nonNumericIndex.value.output_index, "2");

  const completed = rewriteResponsesEventForWarning(event({ type: "response.completed", response: { id: "resp_1", output: [{ id: "msg_1" }] } }), item, 9);
  const output = (completed.value.response as { output: Record<string, unknown>[] }).output;
  assert.equal(output.length, 2);
  assert.deepEqual(output[0], item);
  assert.deepEqual(output[1], { id: "msg_1" });

  const noOutput = rewriteResponsesEventForWarning(event({ type: "response.completed", response: { id: "resp_1", output: "nope" } }), item, 10);
  assert.equal((noOutput.value.response as { output: unknown[] }).output.length, 1);

  const notTerminal = rewriteResponsesEventForWarning(event({ type: "response.in_progress", response: { id: "resp_1" } }), item, 11);
  assert.deepEqual(notTerminal.value.response, { id: "resp_1" });

  const nonRecordResponse = rewriteResponsesEventForWarning(event({ type: "response.completed", response: "nope" }), item, 12);
  assert.equal(nonRecordResponse.value.response, "nope");

  assert.equal(rewriteResponsesEventSequence(delta, 3).value.sequence_number, 3);
});

test("event builders reject unusable payloads and tag synthetic failures", () => {
  assert.throws(
    () => responseEventFromValue({ type: "  " }),
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "malformed_event"
  );
  assert.throws(
    () => responseEventFromValue({}),
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "malformed_event"
  );

  const synthetic = failureEventAfterCommit("resp_1", 4, [{ id: "msg_1" }], { model: "gpt-5.6-sol" });
  assert.equal(isSyntheticResponsesFailureEvent(synthetic), true);
  assert.equal(synthetic.type, "response.failed");
  assert.equal(synthetic.terminal, true);
  assert.deepEqual(synthetic.value.response, {
    model: "gpt-5.6-sol",
    id: "resp_1",
    object: "response",
    status: "failed",
    error: { code: "server_error", message: "The upstream stream ended unexpectedly." },
    output: [{ id: "msg_1" }],
  });

  const withObject = failureEventAfterCommit("resp_2", 5, [], { object: "chat.completion" });
  assert.equal((withObject.value.response as { object: string }).object, "chat.completion");
});

test("response identifiers are read from both places and conflicts are rejected", () => {
  assert.equal(responseIdFromEvents([]), null);
  assert.equal(responseIdFromEvents([event({ type: "response.created", response_id: " resp_1 " })]), "resp_1");
  assert.equal(responseIdFromEvents([event({ type: "response.created", response: { id: "resp_1" } })]), "resp_1");
  assert.equal(responseIdFromEvents([event({ type: "response.created" })]), null);
  assert.equal(
    responseIdFromEvents([event({ type: "response.created", response_id: "resp_1" }), event({ type: "response.completed", response_id: "resp_1" })]),
    "resp_1"
  );
  assert.throws(
    () => responseIdFromEvents([event({ type: "response.created", response_id: "resp_1" }), event({ type: "response.completed", response_id: "resp_2" })]),
    (error: unknown) => error instanceof ResponsesStreamError && error.kind === "malformed_event"
  );
});
test("owned stream forwards initial and upstream events verbatim and closes at its terminal", async () => {
  const created = event({ type: "response.created", response_id: "resp_1", sequence_number: 4 });
  const queued = event({ type: "response.in_progress", response_id: "resp_1" });
  const delta = event({ type: "response.output_text.delta", delta: "hi", response_id: "resp_1", sequence_number: 5 });
  const completed = event({ type: "response.completed", response_id: "resp_1", sequence_number: 6 });
  const delivered: ResponsesStreamEvent[] = [];
  const stream = createOwnedResponsesStream({
    initial: [created, queued],
    iterator: iterator([delta, completed]),
    responseId: null,
    onEvent: (deliveredEvent) => {
      delivered.push(deliveredEvent);
    },
  });

  const values = sseData(await textOf(stream));
  assert.deepEqual(
    values.map((value) => value.type),
    ["response.created", "response.in_progress", "response.output_text.delta", "response.completed"]
  );
  assert.equal(values[3].sequence_number, 6);
  assert.deepEqual(delivered, [created, queued, delta, completed]);
});

test("owned stream replaces a premature EOF with a terminal event", async () => {
  const observed: ResponsesStreamEvent[] = [];
  const failures: { kind: string; terminal: string | null }[] = [];
  const beforeCommit = createOwnedResponsesStream({
    initial: [],
    iterator: iterator([event({ type: "response.created", response_id: "resp_1" })]),
    responseId: null,
    onEvent: (deliveredEvent) => {
      observed.push(deliveredEvent);
    },
    onFailure: (_error, details) => {
      failures.push({ kind: details.failureKind, terminal: details.syntheticTerminalType });
    },
  });
  const values = sseData(await textOf(beforeCommit));
  assert.deepEqual(
    values.map((value) => value.type),
    ["response.created", "error"]
  );
  assert.equal(values[1].code, "server_error");
  assert.deepEqual(failures, [{ kind: "premature_eof", terminal: "error" }]);
  assert.equal(observed.length, 2);

  // After semantic output the failure is a response.failed carrying what was seen.
  const afterCommit = createOwnedResponsesStream({
    initial: [event({ type: "response.output_text.delta", delta: "partial text", response_id: "resp_9", output_index: 0 })],
    iterator: iterator([]),
    responseId: null,
  });
  const committed = sseData(await textOf(afterCommit));
  assert.deepEqual(
    committed.map((value) => value.type),
    ["response.output_text.delta", "response.failed"]
  );
  const failure = committed[1].response as { id: string; status: string; output: { id: string; content: { type: string; text: string }[] }[] };
  assert.equal(failure.id, "resp_9");
  assert.equal(failure.status, "failed");
  assert.equal(failure.output.length, 1);
  assert.equal(failure.output[0].id, "msg_recovered_0");
  assert.equal(failure.output[0].content[0].text, "partial text");
});

test("owned stream fails an empty upstream completion instead of forwarding it", async () => {
  const failures: string[] = [];
  const stream = createOwnedResponsesStream({
    initial: [event({ type: "response.created", response_id: "resp_2" })],
    iterator: iterator([event({ type: "response.completed", response_id: "resp_2", response: { id: "resp_2", output: [] } })]),
    responseId: "resp_2",
    onFailure: (_error, details) => {
      failures.push(details.failureKind);
    },
  });
  const values = sseData(await textOf(stream));
  await flushMicrotasks();
  assert.deepEqual(
    values.map((value) => value.type),
    ["response.created", "error"]
  );
  assert.equal(values[1].code, "empty_upstream_completion");
  assert.deepEqual(failures, ["empty_upstream_completion"]);
});

test("owned stream cancellation aborts upstream once and a cancelled read closes quietly", async () => {
  let abortedWith: unknown = null;
  let cancelledWith: unknown = null;
  const cancellable = createOwnedResponsesStream({
    initial: [event({ type: "response.created", response_id: "resp_3" })],
    iterator: iterator([event({ type: "response.output_text.delta", delta: "late", response_id: "resp_3" })]),
    responseId: "resp_3",
    abortUpstream: (reason) => {
      abortedWith = reason;
    },
    onCancel: (reason) => {
      cancelledWith = reason;
    },
  });
  await cancellable.cancel("client left");
  assert.equal(abortedWith, "client left");
  assert.equal(cancelledWith, "client left");
  await cancellable.cancel("again");
  assert.equal(cancelledWith, "client left");

  const controller = new AbortController();
  controller.abort(new Error("caller gone"));
  const failures: { kind: string; terminal: string | null }[] = [];
  const aborted = createOwnedResponsesStream({
    initial: [],
    iterator: failingIterator(new Error("read failed")),
    responseId: "resp_4",
    signal: controller.signal,
    onFailure: (_error, details) => {
      failures.push({ kind: details.failureKind, terminal: details.syntheticTerminalType });
    },
  });
  assert.equal(await textOf(aborted), "");
  await flushMicrotasks();
  assert.deepEqual(failures, [{ kind: "read_error", terminal: null }]);
});

test("owned stream survives observers that throw, sync or async", async () => {
  const stream = createOwnedResponsesStream({
    initial: [],
    iterator: iterator([]),
    responseId: null,
    onEvent: () => {
      throw new Error("synchronous observer failed");
    },
    onFailure: () => Promise.reject(new Error("asynchronous observer failed")),
  });
  const values = sseData(await textOf(stream));
  assert.deepEqual(
    values.map((value) => value.type),
    ["error"]
  );
});

test("RemovedProvider preamble reorders setup events and refuses an unusable preamble", () => {
  assert.throws(
    () =>
      createOwnedResponsesStream({
        initial: [event({ type: "response.in_progress", response_id: "resp_5" })],
        iterator: iterator([]),
        responseId: "resp_5",
        warning: { model: "gpt-5.6-sol" },
      }),
    /RemovedProvider stream omitted response.created/
  );
  assert.throws(
    () =>
      createOwnedResponsesStream({
        initial: [event({ type: "response.created" })],
        iterator: iterator([]),
        responseId: null,
        warning: { model: "gpt-5.6-sol" },
      }),
    /RemovedProvider stream omitted a response identifier/
  );
});

test("RemovedProvider preamble sequences created, setup, warning and payload events", async () => {
  const validated: ResponsesStreamEvent[] = [];
  const stream = createOwnedResponsesStream({
    initial: [
      event({ type: "response.created", response_id: "resp_6" }),
      event({ type: "response.in_progress", response_id: "resp_6" }),
      event({ type: "response.output_text.delta", delta: "hi", response_id: "resp_6" }),
    ],
    iterator: iterator([
      event({ type: "response.output_text.done", text: "hi", response_id: "resp_6" }),
      event({ type: "response.completed", response_id: "resp_6", response: { id: "resp_6", output: [{ id: "msg_a", type: "message" }] } }),
    ]),
    responseId: "resp_6",
    warning: { model: "gpt-5.6-sol" },
    validateEvent: (validatedEvent) => {
      validated.push(validatedEvent);
    },
  });

  const values = sseData(await textOf(stream));
  assert.equal(values.length, 11);
  assert.deepEqual(
    values.slice(0, 3).map((value) => value.type),
    ["response.created", "response.in_progress", "response.output_item.added"]
  );
  assert.equal(typeof values[2].item === "object" && values[2].item !== null, true);
  assert.equal(typeof values[0].sequence_number, "number");
  assert.equal(values[8].type, "response.output_text.delta");
  assert.equal(values[10].type, "response.completed");
  const output = (values[10].response as { output: { id: string }[] }).output;
  assert.equal(output.length, 2);
  assert.equal(output[0].id.startsWith("msg_failover_"), true);
  assert.deepEqual(output[1], { id: "msg_a", type: "message" });
  assert.equal(validated.length, 5);
});

test("owned stream rejects a changed response identifier before and after the queue", async () => {
  const readFailure: string[] = [];
  const fromIterator = createOwnedResponsesStream({
    initial: [event({ type: "response.created", response_id: "resp_7" })],
    iterator: iterator([event({ type: "response.completed", response_id: "resp_other" })]),
    responseId: "resp_7",
    onFailure: (_error, details) => {
      readFailure.push(details.failureKind);
    },
  });
  const iteratorValues = sseData(await textOf(fromIterator));
  await flushMicrotasks();
  assert.equal(iteratorValues.at(-1)?.type, "error");
  assert.deepEqual(readFailure, ["malformed_event"]);

  const queuedFailure: string[] = [];
  const fromQueue = createOwnedResponsesStream({
    initial: [event({ type: "response.created", response_id: "resp_8" }), event({ type: "response.completed", response_id: "resp_other" })],
    iterator: iterator([]),
    responseId: "resp_8",
    onFailure: (_error, details) => {
      queuedFailure.push(details.failureKind);
    },
  });
  const queuedValues = sseData(await textOf(fromQueue));
  await flushMicrotasks();
  assert.deepEqual(
    queuedValues.map((value) => value.type),
    ["response.created", "error"]
  );
  assert.deepEqual(queuedFailure, ["malformed_event"]);
});

test("owned stream recovers observed items, compatibility output and streamed text into a failure", async () => {
  const recovered = event({ type: "response.output_text.delta", delta: "kept", response_id: "resp_10", output_index: 0 });
  const stream = createOwnedResponsesStream({
    initial: [
      recovered,
      event({ type: "response.output_item.added", response_id: "resp_10", item: { id: "msg_a", type: "message", content: [] } }),
      event({
        type: "response.output_item.done",
        response_id: "resp_10",
        item: { id: "msg_a", type: "message", status: "completed", content: [{ type: "output_text", text: "final" }] },
      }),
      // A stored item that already carries text keeps its own copy (no recovered merge).
      event({
        type: "response.output_item.added",
        response_id: "resp_10",
        item: { id: "msg_b", type: "message", content: [{ type: "output_text", text: "already" }] },
      }),
      event({ type: "response.output_text.delta", delta: "extra", response_id: "resp_10", item_id: "msg_b" }),
      // An item without text is upgraded with the recovered copy.
      event({ type: "response.output_item.added", response_id: "resp_10", item: { id: "msg_c", type: "message", content: [] } }),
      event({ type: "response.output_text.delta", delta: "merged", response_id: "resp_10", item_id: "msg_c" }),
      // Compatibility output, including the null form that falls back to response.output.
      event({
        type: "response.output",
        response_id: "resp_10",
        output: [{ id: "call_1", type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" }],
      }),
      event({
        type: "response.output",
        response_id: "resp_10",
        output: null,
        response: { output: [{ id: "compat_1", type: "message", content: [{ type: "output_text", text: "fallback" }] }] },
      }),
      event({ type: "response.output", response_id: "resp_10" }),
      // Hosted tool lifecycles recover an identity, then update it in place, and a
      // repeated compatibility id replaces the stored entry instead of duplicating it.
      event({ type: "response.web_search_call.completed", response_id: "resp_10" }),
      event({ type: "response.web_search_call.completed", response_id: "resp_10", item_id: "tool_recovered_1" }),
      event({ type: "response.file_search_call.in_progress", response_id: "resp_10", item_id: "tool_2" }),
      event({ type: "response.image_generation_call.failed", response_id: "resp_10", item_id: "tool_3" }),
      event({ type: "response.output", response_id: "resp_10", output: [7, { id: "call_1", type: "function_call" }] }),
      // Re-observing an id updates the stored entry instead of duplicating it.
      event({
        type: "response.output_item.done",
        response_id: "resp_10",
        item: { id: "msg_a", type: "message", status: "completed", content: [{ type: "output_text", text: "final" }] },
      }),
    ],
    iterator: iterator([]),
    responseId: "resp_10",
  });

  const values = sseData(await textOf(stream));
  const failure = values.at(-1)?.response as { output: { id: string; content?: { text?: string }[]; status?: string }[] };
  assert.equal(values.at(-1)?.type, "response.failed");
  const ids = failure.output.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.includes("msg_a"), true);
  assert.equal(ids.includes("msg_b"), true);
  assert.equal(ids.includes("msg_c"), true);
  assert.equal(ids.includes("call_1"), true);
  assert.equal(ids.includes("compat_1"), true);

  const msgB = failure.output.find((item) => item.id === "msg_b");
  assert.equal(msgB?.content?.[0]?.text, "already");
  const msgC = failure.output.find((item) => item.id === "msg_c");
  assert.equal(msgC?.content?.[0]?.text, "merged");
  const tool2 = failure.output.find((item) => item.id === "tool_2");
  assert.equal(tool2?.status, "in_progress");
  const tool3 = failure.output.find((item) => item.id === "tool_3");
  assert.equal(tool3?.status, "failed");
  const recoveredText = failure.output.find((item) => item.id === "msg_recovered_0");
  assert.equal(recoveredText?.content?.[0]?.text, "kept");
  assert.equal(
    failure.output.some((item) => item.id.startsWith("tool_recovered_")),
    true
  );
});

test("owned stream reports a failover warning item in its failure output", async () => {
  const stream = createOwnedResponsesStream({
    initial: [
      event({ type: "response.created", response_id: "resp_11" }),
      event({ type: "response.output_text.delta", delta: "seen", response_id: "resp_11" }),
    ],
    iterator: iterator([]),
    responseId: "resp_11",
    warning: { model: "gpt-5.6-sol" },
  });
  const values = sseData(await textOf(stream));
  assert.equal(values.at(-1)?.type, "response.failed");
  const output = (values.at(-1)?.response as { output: { id: string; role?: string }[] }).output;
  assert.equal(output[0].id.startsWith("msg_failover_"), true);
  assert.equal(output[0].role, "assistant");
  const recovered = output.find((item) => item.id === "msg_recovered_0");
  assert.equal(recovered !== undefined, true);
});
