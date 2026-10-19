import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { MATRIX_MODELS } from "../tools/cloudflare/fixtures/provider-matrix.mjs";
import { dispatches, type MatrixContext } from "../tools/cloudflare/runtime-matrix/contracts.ts";
import { transientNoFailover } from "../tools/cloudflare/runtime-matrix/paid.ts";

const marker = "fixture:matrix:paid:transient";
const failure = "Transient failure cannot mint pool or paid capacity proof";
function dispatch(provider: unknown): Record<string, unknown> {
  return { kind: "matrix_dispatch", marker, provider };
}
function fixture(before: unknown[], after: unknown[], options: { status?: number; semantic?: boolean } = {}) {
  const trace: string[] = [];
  const requests: unknown[] = [];
  const response = new Response("never log response body", { status: options.status ?? 503, headers: { "x-uos-request-id": "original-request" } });
  let reads = 0;
  const unused = () => {
    throw new Error("unrelated fixture capability must remain unused");
  };
  const context: MatrixContext = {
    url: unused,
    post: (path, body) => {
      trace.push("post");
      assert.equal(path, "/v1/responses");
      requests.push(body);
      return Promise.resolve(response);
    },
    rpc: unused,
    read: unused,
    lifecycle: (id) => {
      trace.push("settled");
      assert.equal(id, "original-request");
      return Promise.resolve({ semantic_committed: options.semantic ?? false, terminal_intent: { delivery: "unknown" } });
    },
    events: () => {
      trace.push(reads === 0 ? "events-before" : "events-after");
      return Promise.resolve(structuredClone(reads++ === 0 ? before : after));
    },
    cases: [],
  };
  return { context, trace, requests, response };
}
function capture() {
  const log = spyOn(console, "error").mockImplementation(() => {});
  return {
    log,
    record: () => JSON.parse(String(log.mock.calls[0]?.[0]).split("RUNTIME_MATRIX_DISPATCH_FAILURE=")[1] ?? "null") as unknown,
  };
}

test("reused transient marker excludes observed historical Codex dispatch while retaining the unchanged current Surplus request", async () => {
  const before = [dispatch("codex"), { kind: "matrix_models", provider: "surplus" }];
  const after = [...before, dispatch("surplus")];
  const cumulative = dispatches(after, marker);
  assert.equal(cumulative.length > 0 && cumulative.every((call) => call.provider === "surplus"), false, "old all-history assertion reproduces contamination");
  const { context, trace, requests, response } = fixture(before, after);
  await transientNoFailover(context, "surplus");
  assert.deepEqual(requests, [{ model: MATRIX_MODELS.codex, input: marker, stream: false }]);
  assert.deepEqual(trace, ["events-before", "post", "settled", "events-after"]);
  assert.equal(response.bodyUsed, true);
  assert.deepEqual(context.cases, ["matrix_surplus_transient_503_never_advances_paid_waterfall"]);
});

test("current wrong-provider dispatch remains a no-failover failure with bounded provider-only evidence", async () => {
  const before = [dispatch("codex")];
  const { context } = fixture(before, [...before, dispatch("surplus"), dispatch("openlux")]);
  const { log, record } = capture();
  try {
    await assert.rejects(transientNoFailover(context, "surplus"), { message: failure });
    assert.deepEqual(record(), { case: marker, expected_provider: "surplus", dispatch_count: 2, providers: { surplus: 1, openlux: 1 } });
    assert.equal(context.cases.length, 0);
  } finally {
    log.mockRestore();
  }
});

test("an empty current dispatch window cannot pass using historical matching calls", async () => {
  const before = [dispatch("surplus")];
  const { context } = fixture(before, before);
  const { log, record } = capture();
  try {
    await assert.rejects(transientNoFailover(context, "surplus"), { message: failure });
    assert.deepEqual(record(), { case: marker, expected_provider: "surplus", dispatch_count: 0, providers: {} });
  } finally {
    log.mockRestore();
  }
});

test("multiple current expected dispatches remain valid without inventing a fixed dispatch count", async () => {
  const before = [dispatch("codex")];
  const { context } = fixture(before, [...before, dispatch("surplus"), dispatch("surplus"), dispatch("surplus")]);
  await transientNoFailover(context, "surplus");
  const codex = fixture([], [dispatch("codex"), dispatch("codex")]);
  await transientNoFailover(codex.context, "codex");
});

test("event truncation mutation and reordering fail closed without dumping prefix payloads", async () => {
  const before = [dispatch("codex"), { kind: "telemetry", body: "private-prefix-document" }];
  for (const after of [[], [dispatch("surplus"), before[1]], [before[1], before[0], dispatch("surplus")]]) {
    const { context } = fixture(before, after);
    await assert.rejects(transientNoFailover(context, "surplus"), (error: unknown) => {
      assert(error instanceof assert.AssertionError);
      assert.equal(error.message, "Controlled fixture event log must retain its complete append-only prefix");
      assert.equal(String(error).includes("private-prefix-document"), false);
      return true;
    });
  }
});

test("only safe finite provider identifiers and counts enter dispatch diagnostics", async () => {
  const unsafe = { ...dispatch("Bearer private-token"), headers: { authorization: "private-header" }, body: "private-request-document" };
  const { context } = fixture([], [unsafe, dispatch({ secret: "private-provider-document" }), ...Array.from({ length: 50 }, () => dispatch("openlux"))]);
  const { log, record } = capture();
  try {
    await assert.rejects(transientNoFailover(context, "surplus"), { message: failure });
    assert.deepEqual(record(), { case: marker, expected_provider: "surplus", dispatch_count: 52, providers: { "[invalid]": 2, openlux: 50 } });
    const output = String(log.mock.calls[0]?.[0]);
    assert(output.length < 300);
    assert.equal(/private|Bearer|authorization|headers|body/.test(output), false);
  } finally {
    log.mockRestore();
  }
});

test("original HTTP503 and semantic false assertions are not narrowed by event correlation", async () => {
  for (const options of [{ status: 500 }, { semantic: true }]) {
    const { context, trace } = fixture([], [dispatch("surplus")], options);
    await assert.rejects(transientNoFailover(context, "surplus"), (error: unknown) => error instanceof assert.AssertionError);
    assert.equal(trace.includes("events-after"), false);
    assert.equal(context.cases.length, 0);
  }
});

test("diagnostic logging failure does not replace the original no-failover assertion", async () => {
  const { context } = fixture([], [dispatch("openlux")]);
  const log = spyOn(console, "error").mockImplementation(() => {
    throw new Error("logger unavailable");
  });
  try {
    await assert.rejects(transientNoFailover(context, "surplus"), { message: failure });
  } finally {
    log.mockRestore();
  }
});
