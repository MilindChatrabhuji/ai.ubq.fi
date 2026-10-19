import { test, spyOn } from "bun:test";
import assert from "node:assert/strict";
import { responseObject } from "../tools/cloudflare/runtime-matrix/contracts.ts";
import { captureUnexpectedStatus, registerFixtureResponse } from "../tools/cloudflare/runtime-matrix/failure-capture.ts";

class ControlledResponse extends Response {
  cloneCalls = 0;
  constructor(
    readonly diagnostic: Response,
    status = 503
  ) {
    super("untouched original", { status });
  }
  override clone(): Response {
    this.cloneCalls++;
    return this.diagnostic;
  }
}

test("unexpected fixture status captures bounded body/case before the original assertion and releases its reader", async () => {
  let cancelled = false;
  const diagnostic = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(70_000).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/plain" } }
  );
  const response = new ControlledResponse(diagnostic);
  registerFixtureResponse(response, { input: "fixture:matrix:paid:surplus" });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await assert.rejects(
      responseObject(response),
      (error: unknown) => error instanceof assert.AssertionError && error.actual === 503 && error.expected === 200
    );
    assert.equal(log.mock.calls.length, 1);
    const record: unknown = JSON.parse(String(log.mock.calls[0]?.[0]).split("RUNTIME_MATRIX_HTTP_FAILURE=")[1] ?? "null");
    assert(record !== null && typeof record === "object");
    assert("case" in record && record.case === "fixture:matrix:paid:surplus");
    assert("body_bytes" in record && record.body_bytes === 65536);
    assert("truncated" in record && record.truncated === true);
    assert.equal(response.bodyUsed, false);
    assert.equal(diagnostic.body?.locked, false);
    assert.equal(cancelled, true);
  } finally {
    log.mockRestore();
  }
});

test("successful responses are not cloned or consumed", async () => {
  const response = new ControlledResponse(new Response("diagnostic must stay unread"), 200);
  registerFixtureResponse(response, { input: "fixture:matrix:success" });
  await captureUnexpectedStatus(response, 200);
  assert.equal(response.cloneCalls, 0);
  assert.equal(response.bodyUsed, false);
  assert.equal(response.diagnostic.bodyUsed, false);
});

test("existing structured fixture input retains a finite case identity without logging the request", async () => {
  const response = new ControlledResponse(new Response("controlled failure"));
  registerFixtureResponse(response, { input: [{ role: "user", content: [{ type: "input_text", text: "fixture:matrix:structured" }] }] });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await assert.rejects(responseObject(response), assert.AssertionError);
    assert(String(log.mock.calls[0]?.[0]).includes('"case":"fixture:matrix:structured"'));
    assert(!String(log.mock.calls[0]?.[0]).includes("input_text"));
  } finally {
    log.mockRestore();
  }
});

test("unregistered or non-fixture responses never expose credential documents", async () => {
  const response = new ControlledResponse(new Response("not a fixture document"));
  registerFixtureResponse(response, { input: "credential document, not a finite fixture marker" });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await assert.rejects(responseObject(response), assert.AssertionError);
    assert.equal(log.mock.calls.length, 0);
    assert.equal(response.cloneCalls, 0);
  } finally {
    log.mockRestore();
  }
});

test("stalled bounded diagnostic reads time out and cancel without replacing the status assertion", async () => {
  let cancelled = false;
  const diagnostic = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    })
  );
  const response = new ControlledResponse(diagnostic);
  registerFixtureResponse(response, { messages: [{ role: "user", content: "fixture:matrix:stalled" }] });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await assert.rejects(responseObject(response), assert.AssertionError);
    assert(String(log.mock.calls[0]?.[0]).includes('"timed_out":true'));
    assert.equal(cancelled, true);
    assert.equal(diagnostic.body?.locked, false);
    assert.equal(response.bodyUsed, false);
  } finally {
    log.mockRestore();
  }
});
