import { test } from "bun:test";
import { runCommand } from "../../process.ts";
import { rmSync } from "node:fs";
import {
  bridgeEventToTrajectory,
  CODEX_INFINITY_SOURCE_PIN,
  createBaselineB,
  drainChildStream,
  parseCodexProcessLine,
  scriptedBridgeDriverFromTrail,
} from "../adapter-b.ts";
import { runOne } from "../../runner.ts";
import { validateTrajectoryEvent } from "../../schemas.ts";
import { freshRunOptions, nav001 } from "./helpers.ts";

test("B: implements the BenchmarkAdapter contract and is refused by default", () => {
  const adapter = createBaselineB();
  if (adapter.configId !== "B") throw new Error(`configId must be B, got ${adapter.configId}`);
  if (adapter.name !== "codex-infinity-bridge") throw new Error(`unexpected name ${adapter.name}`);
  if (!adapter.requiresExternalInference) throw new Error("B must require external inference");
  if (typeof adapter.run !== "function") throw new Error("run must be a function");
});

test("B: default instance refuses to run without cloning or spawning", async () => {
  const opts = freshRunOptions();
  try {
    const { result } = await runOne(nav001(), createBaselineB(), opts);
    if (result.success || result.failure_class !== "adapter_error") {
      throw new Error(`expected adapter_error, got ${result.failure_class}: ${result.failure_detail}`);
    }
    const detail = String(result.failure_detail);
    if (!detail.includes("never clones or spawns") || !detail.includes("not provisioned")) {
      throw new Error(`unexpected refusal text: ${detail}`);
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("B: live driver is refused without the explicit allowLiveProcess opt-in", async () => {
  const opts = freshRunOptions();
  try {
    const adapter = createBaselineB({ driver: "live" });
    const { result } = await runOne(nav001(), adapter, opts);
    if (result.success || result.failure_class !== "adapter_error") {
      throw new Error(`expected adapter_error, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (!String(result.failure_detail).includes("allowLiveProcess")) {
      throw new Error(`expected the allowLiveProcess refusal, got ${result.failure_detail}`);
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("B: scripted driver completes nav-001 and records bridge events", async () => {
  const opts = freshRunOptions();
  try {
    const task = nav001();
    const adapter = createBaselineB({ driver: scriptedBridgeDriverFromTrail() });
    const { result, events } = await runOne(task, adapter, opts);
    if (!result.success || result.failure_class !== null) {
      throw new Error(`expected success, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (result.metrics.model_calls !== 2) throw new Error(`expected 2 model calls, got ${result.metrics.model_calls}`);
    if (result.metrics.tool_calls !== 4) throw new Error(`expected 4 tool calls, got ${result.metrics.tool_calls}`);
    for (const event of events) validateTrajectoryEvent(event);
    // Every tool_call must be paired with a tool_result of the same id.
    const callIds = events.filter((e) => e.type === "tool_call").map((e) => (e as { id: string }).id);
    const resultIds = events.filter((e) => e.type === "tool_result").map((e) => (e as { id: string }).id);
    if (callIds.join(",") !== resultIds.join(",")) throw new Error("tool_call/tool_result ids must be paired");
    const requestIds = events
      .filter((e) => e.type === "model_request")
      .map((e) => (e as { id: number }).id)
      .join(",");
    if (requestIds !== "1,2") throw new Error(`expected monotonic bridge request ids, got ${requestIds}`);
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("B: pinned provenance record matches the live primary-source facts", () => {
  // Read through a widened view on purpose: the pin's own fields are literal
  // types, so a literal-vs-literal comparison is decided statically and would
  // stop catching drift the moment the pin is edited.
  const pin: Readonly<Record<string, string>> = CODEX_INFINITY_SOURCE_PIN;
  if (pin.repositoryUrl !== "https://github.com/lee101/codex-infinity") {
    throw new Error("repository URL drifted");
  }
  if (pin.pinnedRef.length !== 40 || pin.pinnedRef !== "fbb52680c30a968384b15cfe6dadbec22faba73f") {
    throw new Error(`pinned ref drifted: ${pin.pinnedRef}`);
  }
  if (pin.upstreamRepositoryUrl !== "https://github.com/openai/codex") throw new Error("upstream URL drifted");
  if (pin.license !== "Apache-2.0") throw new Error("license drifted");
  if (pin.npmPackage !== "@codex-infinity/codex-infinity") throw new Error("npm package drifted");
});

test("B: assumed JSONL parser maps events and skips unverified lines", () => {
  const request = parseCodexProcessLine(JSON.stringify({ type: "model_request", id: 1, model: "cerebras/gpt-oss-120b", message_count: 2 }));
  if (request?.kind !== "model_request" || request.id !== 1 || request.model !== "cerebras/gpt-oss-120b") {
    throw new Error("model_request line did not map");
  }
  const response = parseCodexProcessLine(
    JSON.stringify({
      type: "model_response",
      request_id: 1,
      content: "text",
      tool_calls: [{ id: "call-1", name: "filesystem.read", arguments: { path: "a.txt" } }],
      finish_reason: "tool_calls",
    })
  );
  if (response?.kind !== "model_response" || response.tool_calls[0]?.name !== "filesystem.read") {
    throw new Error("model_response line did not map");
  }
  if (parseCodexProcessLine("not json at all") !== null) throw new Error("garbage must be skipped");
  if (parseCodexProcessLine(JSON.stringify({ type: "unknown_event" })) !== null) {
    throw new Error("unverified event types must be skipped, not interpreted");
  }
});

test("B: bridge event mapping produces schema-valid trajectory events", () => {
  const event = bridgeEventToTrajectory(
    {
      kind: "tool_call",
      id: "c1",
      tool: "filesystem.read",
      arguments: { path: "docs/spec.txt" },
      valid: true,
    },
    "2026-08-29T00:00:00.000Z"
  );
  validateTrajectoryEvent(event);
  if (event.type !== "tool_call" || !event.valid) throw new Error("tool_call mapping failed");
});

test("B: child stderr is drained without waiting for stdout", async () => {
  let stderrPulls = 0;
  let releaseStdout!: () => void;
  const stderrReady = new Promise<void>((resolve) => (releaseStdout = resolve));
  const stderr = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
      stderrPulls += 1;
      if (stderrPulls === 4) {
        controller.close();
        releaseStdout();
      }
    },
  });
  const stdout = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await stderrReady;
      controller.enqueue(new TextEncoder().encode("stdout-ready"));
      controller.close();
    },
  });

  const drain = drainChildStream(stderr);
  const stdoutRead = stdout.getReader().read();
  const result = await Promise.race([
    stdoutRead,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error("stream drain deadlocked"));
      }, 1_000)
    ),
  ]);
  await drain;

  if (result.done || new TextDecoder().decode(result.value) !== "stdout-ready") {
    throw new Error("stdout was not released after concurrent stderr drain");
  }
  if (stderrPulls !== 4) throw new Error(`expected all stderr chunks to drain, got ${stderrPulls}`);
});

test("B: native child emits stdout after stderr exceeds pipe capacity", async () => {
  const script = 'await new Promise(resolve => process.stderr.write("x".repeat(512 * 1024), resolve)); process.stdout.write("stdout-ready");';
  const result = await runCommand([process.execPath, "--no-env-file", "-e", script]);
  if (result.code !== 0 || result.stdout !== "stdout-ready" || result.stderr.length !== 512 * 1024) {
    throw new Error("native child output was lost or its pipes did not drain concurrently");
  }
});

test("B: native child settles when its caller aborts", async () => {
  const signal = AbortSignal.timeout(100);
  try {
    const result = await runCommand([process.execPath, "--no-env-file", "-e", "setTimeout(() => {}, 10_000);"], { signal });
    if (!signal.aborted || result.code === 0) throw new Error("the native child did not stop on cancellation");
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }
});
