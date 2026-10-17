import { test } from "bun:test";
import assert from "node:assert/strict";

import { createStreamFirstEventDeadline } from "../src/inference-deadline.ts";
import type { ResponsesStreamEvent } from "../src/responses-stream.ts";
import {
  failureKindForResponsesAttemptTrigger,
  isEligibleResponsesAttemptStatus,
  prepareResponsesAttempt,
  responseFailureTerminalType,
} from "../src/responses-attempts.ts";

/**
 * Coverage for the Responses attempt preparation in src/responses-attempts.ts.
 *
 * Each case drives `prepareResponsesAttempt` with a synthetic upstream SSE body
 * and asserts the observable outcome: the attempt kind, the trigger the gateway
 * will fail the attempt with, and the client-facing status/code of the failed
 * response. No network, no KV and no wall-clock dependence beyond the deadline
 * helper's own timer, which is always cleared by the attempt.
 */

const sse = (frames: readonly string[]): string => frames.map((frame) => `data: ${frame}\n\n`).join("");

const completedFrame = (id: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "response.completed", response: { id, usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 }, ...extra } });

const deltaFrame = (): string => JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "hi" });

const sseResponse = (body: string, init: ResponseInit = { status: 200 }): Response => {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/event-stream");
  return new Response(body, { ...init, headers });
};

const attemptError = async (response: Response, options: Parameters<typeof prepareResponsesAttempt>[5] = {}) => {
  const controller = new AbortController();
  const deadline = createStreamFirstEventDeadline(controller.signal, 5_000);
  const result = await prepareResponsesAttempt(response, "chatgpt_codex", deadline, controller.signal, ["w1"], options);
  assert.equal(result.kind, "failed");
  const body = (await result.attempt.response.json()) as { error: { code: string; message: string; type: string } };
  return { trigger: result.attempt.trigger, status: result.attempt.response.status, error: body.error, terminal: result.attempt.terminal };
};

test("responses attempts: eligibility and trigger classification cover the documented vocabulary", () => {
  assert.equal(isEligibleResponsesAttemptStatus(new Response(null, { status: 500 })), true);
  assert.equal(isEligibleResponsesAttemptStatus(new Response(null, { status: 599 })), true);
  assert.equal(isEligibleResponsesAttemptStatus(new Response(null, { status: 404 })), false);

  assert.equal(failureKindForResponsesAttemptTrigger("http_4xx"), "upstream_http_4xx");
  assert.equal(failureKindForResponsesAttemptTrigger("http_5xx"), "upstream_http_5xx");
  assert.equal(failureKindForResponsesAttemptTrigger("http_error"), "upstream_http_error");
  assert.equal(failureKindForResponsesAttemptTrigger("premature_eof"), "premature_eof");
  assert.equal(failureKindForResponsesAttemptTrigger("malformed_event"), "malformed_event");
  assert.equal(failureKindForResponsesAttemptTrigger("event_too_large"), "event_too_large");
  assert.equal(failureKindForResponsesAttemptTrigger("semantic_timeout"), "inactivity_timeout");
  assert.equal(failureKindForResponsesAttemptTrigger("empty_upstream_completion"), "empty_upstream_completion");
  assert.equal(failureKindForResponsesAttemptTrigger("read_error"), "read_error");
  assert.equal(failureKindForResponsesAttemptTrigger("missing_body"), "read_error");
  assert.equal(failureKindForResponsesAttemptTrigger("not_a_trigger" as never), null);
});

test("responses attempts: failure terminal types follow the trigger and both signals", () => {
  const open = new AbortController();
  assert.equal(responseFailureTerminalType("semantic_timeout", open.signal, open.signal), "deadline");
  assert.equal(responseFailureTerminalType("read_error", open.signal, open.signal), "error");
  assert.equal(responseFailureTerminalType("premature_eof", open.signal, open.signal), "eof");
  assert.equal(responseFailureTerminalType("terminal_failure", open.signal, open.signal), "response.failed");
  assert.equal(responseFailureTerminalType("empty_upstream_completion", open.signal, open.signal), "response.failed");

  const aborted = new AbortController();
  aborted.abort(new Error("cancelled"));
  assert.equal(responseFailureTerminalType("read_error", open.signal, aborted.signal), "cancelled");
  assert.equal(responseFailureTerminalType("read_error", aborted.signal, open.signal), "deadline");
  const timedOut = new AbortController();
  timedOut.abort(new DOMException("deadline", "TimeoutError"));
  assert.equal(responseFailureTerminalType("read_error", timedOut.signal, open.signal), "deadline");
});

test("responses attempts: a non-2xx upstream is classified by status and normalized for the client", async () => {
  const server = await attemptError(new Response(JSON.stringify({ error: { message: "upstream exploded", code: "boom" } }), { status: 503 }), {});
  assert.equal(server.trigger, "http_5xx");
  assert.equal(server.status, 503);
  assert.equal(server.error.message, "upstream exploded");
  assert.equal(server.error.code, "boom");

  const client = await attemptError(new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400 }), {});
  assert.equal(client.trigger, "http_4xx");
  assert.equal(client.status, 400);
  assert.equal(client.error.code, "upstream_error");

  const redirect = await attemptError(new Response("", { status: 302 }), {});
  assert.equal(redirect.trigger, "http_error");
  assert.equal(redirect.status, 302);
});

test("responses attempts: an upstream without a body fails closed as missing_body", async () => {
  const failed = await attemptError(new Response(null, { status: 200 }), {});

  assert.equal(failed.trigger, "missing_body");
  assert.equal(failed.status, 502);
  assert.equal(failed.error.message, "Upstream response missing body.");
  assert.equal(failed.error.code, "server_error");
});

test("responses attempts: a terminal completion without semantic output is an empty upstream completion", async () => {
  const failed = await attemptError(sseResponse(sse([completedFrame("resp_empty")])), {});

  assert.equal(failed.trigger, "empty_upstream_completion");
  assert.equal(failed.status, 502);
  assert.equal(failed.error.code, "empty_upstream_completion");
  assert.equal(failed.error.message, "The upstream completed without visible output.");
  assert.equal(failed.terminal?.type, "response.completed");
});

test("responses attempts: a failed terminal is rejected when the route asks for it", async () => {
  const body = sse([JSON.stringify({ type: "response.failed", response: { id: "resp_failed" } })]);
  const rejected = await attemptError(sseResponse(body), { rejectFailedTerminal: true });
  assert.equal(rejected.trigger, "read_error");
  assert.equal(rejected.terminal, null);

  const presemantic = await attemptError(sseResponse(body), { rejectPresemanticFailureTerminal: true });
  assert.equal(presemantic.trigger, "terminal_failure");
  assert.equal(presemantic.status, 502);

  // Without either rejection the failed terminal is a normal terminal event.
  const controller = new AbortController();
  const deadline = createStreamFirstEventDeadline(controller.signal, 5_000);
  const accepted = await prepareResponsesAttempt(sseResponse(body), "chatgpt_codex", deadline, controller.signal, [], {});
  assert.equal(accepted.kind, "ready");
  assert.equal(accepted.attempt.prepared.terminal?.type, "response.failed");
});

test("responses attempts: a semantic stream is prepared with its discovered identity", async () => {
  const controller = new AbortController();
  const deadline = createStreamFirstEventDeadline(controller.signal, 5_000);
  const body = sse([JSON.stringify({ type: "response.created", response: { id: "resp_ready" } }), deltaFrame(), completedFrame("resp_ready")]);

  const result = await prepareResponsesAttempt(sseResponse(body), "surplus", deadline, controller.signal, [], {});

  assert.equal(result.kind, "ready");
  assert.equal(result.attempt.provider, "surplus");
  assert.equal(result.attempt.responseId, "resp_ready");
  assert.equal(result.attempt.selectedModel, null);
  assert.equal(result.attempt.taskType, null);
  assert.deepEqual(
    result.attempt.prepared.buffered.map((event: ResponsesStreamEvent) => event.type),
    ["response.created", "response.output_text.delta"]
  );
  assert.equal(typeof result.attempt.clearDeadline, "function");
});

test("responses attempts: malformed SSE JSON fails the attempt as a malformed event", async () => {
  const failed = await attemptError(sseResponse("data: {not json}\n\n"), {});

  assert.equal(failed.trigger, "malformed_event");
  assert.equal(failed.status, 502);
});

test("responses attempts: an eligible-model route rejects a stream without a created event or identity", async () => {
  // The stream terminates without ever emitting response.created.
  const failedTerminal = JSON.stringify({ type: "response.failed", response: { id: "resp_1" } });
  const withoutCreated = await attemptError(sseResponse(sse([failedTerminal])), { requireEligibleModel: true });
  assert.equal(withoutCreated.trigger, "malformed_event");
  assert.equal(withoutCreated.status, 502);

  // A created event that carries no response id.
  const anonymousTerminal = JSON.stringify({ type: "response.failed", response: {} });
  const withoutId = await attemptError(sseResponse(sse([JSON.stringify({ type: "response.created", response: {} }), anonymousTerminal])), {
    requireEligibleModel: true,
  });
  assert.equal(withoutId.trigger, "malformed_event");

  // An identified stream that never names an eligible model.
  const withoutModel = await attemptError(sseResponse(sse([JSON.stringify({ type: "response.created", response: { id: "resp_1" } }), failedTerminal])), {
    requireEligibleModel: true,
  });
  assert.equal(withoutModel.trigger, "invalid_model");
  assert.equal(withoutModel.status, 502);
});

test("responses attempts: the deadline is cleared once an attempt settles", async () => {
  const controller = new AbortController();
  const deadline = createStreamFirstEventDeadline(controller.signal, 5_000);
  const body = sse([JSON.stringify({ type: "response.created", response: { id: "resp_clear" } }), completedFrame("resp_clear")]);

  await prepareResponsesAttempt(sseResponse(body), "chatgpt_codex", deadline, controller.signal, [], {});

  // The terminal completion without semantic output already cleared the deadline,
  // so its signal stays unterminated while the request signal is untouched.
  assert.equal(controller.signal.aborted, false);
  assert.equal(deadline.signal.aborted, false);
});

test("responses attempts: an aborted request signal rethrows the caller's reason", async () => {
  const controller = new AbortController();
  const deadline = createStreamFirstEventDeadline(controller.signal, 5_000);
  const reason = new Error("client went away");
  controller.abort(reason);

  await assert.rejects(
    () => prepareResponsesAttempt(sseResponse(sse([completedFrame("resp_abort")])), "chatgpt_codex", deadline, controller.signal, [], {}),
    (error: unknown) => error === reason
  );
});
