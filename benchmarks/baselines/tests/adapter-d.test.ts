import { test } from "bun:test";
import { rmSync } from "node:fs";
import { adapterD, assertControlModelApproved, CONTROL_MODEL_PLACEHOLDER, createBaselineD } from "../adapter-d.ts";
import { BaselineAdapterError } from "../errors.ts";
import type { ChatTransport } from "../transport.ts";
import { runOne } from "../../runner.ts";
import { controlCompletionBody, freshRunOptions, nav001, scriptedTransport } from "./helpers.ts";

const CONTROL_MODEL = "control-strong-test-1";
const FIND = { name: "filesystem.find", args: { path: "docs", pattern: "*.txt" } };
const READ = { name: "filesystem.read", args: { path: "docs/spec.txt" } };
const PATCH = { name: "editor.apply_patch", args: { path: "answer.txt", add: true, new: "docs/spec.txt" } };

function configuredD(transport: ChatTransport) {
  return createBaselineD({ model: CONTROL_MODEL, baseUrl: "https://control.invalid/v1", apiKey: null, transport });
}

test("D: implements the BenchmarkAdapter contract and is refused by default", () => {
  if (adapterD.configId !== "D") throw new Error(`configId must be D, got ${adapterD.configId}`);
  if (adapterD.name !== "strong-control") throw new Error(`unexpected name ${adapterD.name}`);
  if (!adapterD.requiresExternalInference) throw new Error("D must require external inference");
  if (typeof adapterD.run !== "function") throw new Error("run must be a function");
});

test("D: default instance refuses to run (unapproved control model, no transport)", async () => {
  const opts = freshRunOptions();
  try {
    const { result } = await runOne(nav001(), adapterD, opts);
    if (result.success || result.failure_class !== "adapter_error") {
      throw new Error(`expected adapter_error, got ${result.failure_class}: ${result.failure_detail}`);
    }
    const detail = String(result.failure_detail);
    if (!detail.includes("not provisioned") || !detail.includes("not approved")) {
      throw new Error(`unexpected refusal text: ${detail}`);
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("D: configured fake transport completes nav-001 under the control model", async () => {
  const opts = freshRunOptions();
  try {
    const fake = scriptedTransport([{ toolCalls: [FIND, READ, PATCH] }, { content: "strong control done" }], (step) =>
      controlCompletionBody(step, CONTROL_MODEL)
    );
    const adapter = configuredD(fake.transport);
    const { result, events } = await runOne(nav001(), adapter, opts);
    if (!result.success || result.failure_class !== null) {
      throw new Error(`expected success, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (result.metrics.model_calls !== 2) throw new Error(`expected 2 model calls, got ${result.metrics.model_calls}`);
    if (result.metrics.tool_calls !== 3) throw new Error(`expected 3 tool calls, got ${result.metrics.tool_calls}`);
    const requests = events.filter((e) => e.type === "model_request");
    for (const request of requests) {
      if ((request as { model?: string }).model !== CONTROL_MODEL) {
        throw new Error("model requests must record the configured control model");
      }
    }
    if (fake.requests[0].model !== CONTROL_MODEL) throw new Error("request body must carry the control model");
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("D: a mismatched upstream model is rejected deterministically", async () => {
  const opts = freshRunOptions();
  try {
    const fake = scriptedTransport([{ content: "done" }], (step) => controlCompletionBody(step, "someone-elses-model"));
    const adapter = configuredD(fake.transport);
    const { result } = await runOne(nav001(), adapter, opts);
    if (result.success || result.failure_class !== "adapter_error") {
      throw new Error(`expected adapter_error, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (!String(result.failure_detail).includes("instead of")) {
      throw new Error(`expected the model mismatch message, got ${result.failure_detail}`);
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("D: control model approval gate stays closed for the placeholder", () => {
  // The approved name must pass: assertControlModelApproved returns void, so passing means not throwing.
  assertControlModelApproved(CONTROL_MODEL);
  let threw = false;
  try {
    assertControlModelApproved(CONTROL_MODEL_PLACEHOLDER);
  } catch (err) {
    threw = err instanceof BaselineAdapterError && err.code === "invalid-config";
  }
  if (!threw) throw new Error("placeholder model must be rejected");
});
