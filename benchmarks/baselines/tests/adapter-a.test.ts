import { test } from "bun:test";
import { rmSync } from "node:fs";
import { createBaselineA } from "../adapter-a.ts";
import { BaselineAdapterError } from "../errors.ts";
import { runOne } from "../../runner.ts";
import { freshRunOptions, gatewayCompletionBody, gatewayEventToolCalls, nav001, scriptedTransport } from "./helpers.ts";

const FIND = { name: "filesystem.find", args: { path: "docs", pattern: "*.txt" } };
const READ = { name: "filesystem.read", args: { path: "docs/spec.txt" } };
const PATCH = { name: "editor.apply_patch", args: { path: "answer.txt", add: true, new: "docs/spec.txt" } };

test("A: implements the BenchmarkAdapter contract and is refused by default", () => {
  const adapter = createBaselineA({
    transport: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) }),
  });
  if (adapter.configId !== "A") throw new Error(`configId must be A, got ${adapter.configId}`);
  if (adapter.name !== "gateway-gpt-oss-chat") throw new Error(`unexpected name ${adapter.name}`);
  if (!adapter.requiresExternalInference) throw new Error("A must require external inference");
  if (typeof adapter.run !== "function") throw new Error("run must be a function");
});

test("A: completes nav-001 through the fake transport with schema-valid events", async () => {
  const opts = freshRunOptions();
  try {
    const fake = scriptedTransport([{ toolCalls: [FIND, READ, PATCH] }, { content: "docs/spec.txt is the largest document" }], gatewayCompletionBody);
    const adapter = createBaselineA({ transport: fake.transport });
    const { result, events } = await runOne(nav001(), adapter, opts);
    if (!result.success || result.failure_class !== null) {
      throw new Error(`expected success, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (result.metrics.model_calls !== 2) throw new Error(`expected 2 model calls, got ${result.metrics.model_calls}`);
    if (result.metrics.tool_calls !== 3) throw new Error(`expected 3 tool calls, got ${result.metrics.tool_calls}`);
    if (result.metrics.input_tokens !== 200) {
      throw new Error(`expected 200 input tokens, got ${result.metrics.input_tokens}`);
    }
    if (result.metrics.output_tokens !== 100) {
      throw new Error(`expected 100 output tokens, got ${result.metrics.output_tokens}`);
    }
    if (result.metrics.context_size !== 150) {
      throw new Error(`expected context 150, got ${result.metrics.context_size}`);
    }

    const requests = events.filter((e) => e.type === "model_request");
    if (requests.map((e) => (e as { id: number }).id).join(",") !== "1,2") {
      throw new Error("model request ids must be monotonic 1,2");
    }
    const responses = events.filter((e) => e.type === "model_response");
    if (responses.length !== 2 || (responses[1] as { content?: string }).content === undefined) {
      throw new Error("expected a final model response with content");
    }
    if (gatewayEventToolCalls(events, "filesystem.find").length !== 1) {
      throw new Error("expected one recorded filesystem.find call");
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("A: records a model request before an upstream failure", async () => {
  const opts = freshRunOptions();
  try {
    const adapter = createBaselineA({
      transport: () =>
        Promise.resolve({
          status: 500,
          ok: false,
          json: () => Promise.resolve({ error: { code: "failed", message: "upstream failed" } }),
        }),
    });
    const { result, events } = await runOne(nav001(), adapter, opts);
    if (result.success || result.metrics.model_calls !== 1) {
      throw new Error(`failed dispatch must count one model call, got ${result.metrics.model_calls}`);
    }
    const request = events.find((event) => event.type === "model_request");
    if (request?.input_tokens !== 0 || request.output_tokens !== 0) {
      throw new Error("failed dispatch must retain its zero-usage model_request event");
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("A: sends the gateway wire shape (no stream, medium effort, official tools)", async () => {
  const opts = freshRunOptions();
  try {
    const fake = scriptedTransport([{ content: "done" }], gatewayCompletionBody);
    const adapter = createBaselineA({ transport: fake.transport });
    await runOne(nav001(), adapter, opts);
    if (fake.requests.length !== 1) throw new Error("expected exactly one request");
    const body = fake.requests[0];
    if (body.model !== "gpt-oss-120b") throw new Error(`unexpected model ${String(body.model)}`);
    if (body.stream !== false) throw new Error("gateway sends stream: false");
    if (body.reasoning_effort !== "medium") {
      throw new Error(`expected medium effort, got ${String(body.reasoning_effort)}`);
    }
    const tools = body.tools as Record<string, unknown>[];
    if (tools.length !== 9) throw new Error(`expected 9 canonical tools, got ${tools.length}`);
    for (const tool of tools) {
      if ((tool.type as string) !== "function") throw new Error("tools must use the official function shape");
    }
    if ((body.messages as unknown[]).length !== 2) throw new Error("expected system + user messages");
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("A: invalid tool arguments become valid:false calls and continue the loop", async () => {
  const opts = freshRunOptions();
  try {
    const fake = scriptedTransport([{ toolCalls: [{ name: "filesystem.read", args: { path: 42 } }] }, { content: "recovered" }], gatewayCompletionBody);
    const adapter = createBaselineA({ transport: fake.transport });
    const { result, events } = await runOne(nav001(), adapter, opts);
    if (result.success) throw new Error("nav-001 must not succeed without the answer file");
    if (result.metrics.invalid_tool_calls !== 1) {
      throw new Error(`expected 1 invalid call, got ${result.metrics.invalid_tool_calls}`);
    }
    if (result.metrics.tool_errors !== 1) throw new Error("expected the invalid call to record one tool error");
    const call = events.find((e) => e.type === "tool_call") as { valid?: boolean; invalid_reason?: string } | undefined;
    if (call?.valid !== false || call.invalid_reason === undefined) {
      throw new Error("invalid arguments must be flagged on the tool_call event");
    }
    // The loop must continue after the failure and produce a final turn.
    if (result.metrics.model_calls !== 2) throw new Error("expected a second model request after the failed call");
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("A: mirrors the gateway rejection of reasoning_effort 'none'", () => {
  let threw = false;
  try {
    createBaselineA({
      // @ts-expect-error deliberately constructing the invalid effort
      reasoningEffort: "none",
      transport: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) }),
    });
  } catch (err) {
    threw = err instanceof BaselineAdapterError && err.code === "invalid-config" && (err as Error).message.includes("'none' is not supported for gpt-oss-120b");
  }
  if (!threw) throw new Error("'none' must be rejected exactly like the gateway");
});

test("A: an upstream model mismatch becomes a classified adapter error", async () => {
  const opts = freshRunOptions();
  try {
    const fake = scriptedTransport([{ content: "done" }], (step) => ({
      ...gatewayCompletionBody(step),
      model: "some-other-model",
    }));
    const adapter = createBaselineA({ transport: fake.transport });
    const { result } = await runOne(nav001(), adapter, opts);
    if (result.success || result.failure_class !== "adapter_error") {
      throw new Error(`expected adapter_error, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (!String(result.failure_detail).includes("different model")) {
      throw new Error(`model mismatch must be reported, got ${result.failure_detail}`);
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});
