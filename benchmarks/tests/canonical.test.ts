import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

import type { HarmonyTransport } from "../../src/harmony/adapter.ts";
import { canonicalAdapter, CanonicalAdapterError, createCanonicalAdapter } from "../adapter.ts";
import { loadTasks } from "../manifest.ts";
import { runBenchmarks, runOne } from "../runner.ts";
import { type BenchmarkResult, type TaskManifest, validateTrajectoryEvent } from "../schemas.ts";

const TASKS_DIR = `${process.cwd()}/benchmarks/tasks`;
const FIXTURES_DIR = `${process.cwd()}/benchmarks/fixtures`;

function freshOptions() {
  mkdirSync(`${process.cwd()}/benchmark-runs`, { recursive: true });
  const runsRoot = mkdtempSync(join(`${process.cwd()}/benchmark-runs`, "fixture-"));
  return { runsRoot };
}

let completionCounter = 0;
function respond(message: Record<string, unknown>): Response {
  completionCounter += 1;
  return new Response(
    JSON.stringify({
      id: `cmpl-${completionCounter}`,
      object: "chat.completion",
      created: 1,
      model: "gpt-oss-120b",
      choices: [
        {
          index: 0,
          message: { role: "assistant", ...message },
          finish_reason: "tool_calls" in message ? "tool_calls" : "stop",
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Deterministic fake model for the C-fake matrix: replays the task's
 * scripted trail one call per request, then answers; when the reliability
 * harness rejects the answer, the next request verifies with the task's
 * declared verification command (the runner re-runs the same gate).
 */
export function trailTransport(task: TaskManifest): HarmonyTransport {
  const trail = task.scripted_trail ?? [];
  let index = 0;
  return () => {
    index += 1;
    if (index <= trail.length) {
      const step = trail[index - 1];
      return Promise.resolve(
        respond({
          content: `Step ${index}.`,
          tool_calls: [
            {
              id: `call-${index}`,
              type: "function",
              function: { name: step.tool, arguments: JSON.stringify(step.args) },
            },
          ],
        })
      );
    }
    if (index === trail.length + 1) return Promise.resolve(respond({ content: "Task complete." }));
    if (index === trail.length + 2) {
      return Promise.resolve(
        respond({
          content: "Verifying with the declared command.",
          tool_calls: [
            {
              id: `call-${index}`,
              type: "function",
              function: { name: "shell.exec", arguments: JSON.stringify({ command: task.verify?.command ?? "true" }) },
            },
          ],
        })
      );
    }
    if (index === trail.length + 3) {
      // Deterministic abandonment evidence when the guard still blocks.
      return Promise.resolve(
        respond({
          content: "Revising the plan after verification.",
          tool_calls: [
            {
              id: `call-${index}`,
              type: "function",
              function: { name: "task.update_plan", arguments: JSON.stringify({ plan: ["verified", "complete"] }) },
            },
          ],
        })
      );
    }
    return Promise.resolve(respond({ content: "Task complete." }));
  };
}

test("canonical: registered C is external-inference by default and inert without an approved gate", async () => {
  assert.equal(canonicalAdapter.configId, "C");
  assert.equal(canonicalAdapter.requiresExternalInference, true);
  await assert.rejects(() => createCanonicalAdapter().run(null as never), CanonicalAdapterError);
  const { runsRoot } = freshOptions();
  try {
    let refused = false;
    try {
      await runBenchmarks({
        configs: ["C"],
        taskSelectors: ["nav-001"],
        runsRoot,
        tasksDir: TASKS_DIR,
        fixturesDir: FIXTURES_DIR,
      });
    } catch (err) {
      refused = (err as Error).message.includes("external-inference");
    }
    assert.equal(refused, true, "the runner must refuse the default C adapter");
  } finally {
    rmSync(runsRoot, { recursive: true });
  }
});

test("canonical: a fake-transport C run completes a task with guard evidence", async () => {
  const { runsRoot } = freshOptions();
  try {
    const task = loadTasks(TASKS_DIR).find((t) => t.id === "nav-001");
    assert.ok(task, "nav-001 must exist in the benchmark manifest");
    const adapter = createCanonicalAdapter({
      transport: trailTransport(task),
      configId: "C-fake",
      name: "C-fake",
      requiresExternalInference: false,
    });
    const { result, events } = await runOne(task, adapter, {
      configs: ["C-fake"],
      taskSelectors: ["nav-001"],
      runsRoot,
      tasksDir: TASKS_DIR,
      fixturesDir: FIXTURES_DIR,
    });
    assert.equal(result.success, true, result.failure_detail ?? "no detail");
    // The fake model writes without verifying first: the guard rejects the
    // first final and the verification-command recovery satisfies it.
    assert.equal(result.reliability?.final_accepted, true);
    assert.ok(result.reliability.guard_rejections >= 1);
    assert.equal(result.reliability.unverified_writes, 0);
    assert.equal(result.reliability.verification.required, 1);
    assert.equal(result.reliability.verification.satisfied, 1);
    assert.ok(result.metrics.model_calls >= 6);
    assert.ok(result.metrics.output_tokens > 0, "model response tokens must be included in metrics");
    for (const event of events) validateTrajectoryEvent(event);
    const requests = events.filter((event) => event.type === "model_request");
    assert.ok(requests.every((request) => request.output_tokens > 0));
    const guards = events.filter((e) => e.type === "guard");
    assert.ok(guards.length >= 1);
    assert.equal(guards[0].kind, "unverified_write");
  } finally {
    rmSync(runsRoot, { recursive: true });
  }
});

test("canonical: the C-fake matrix succeeds on every manifest with deterministic reliability evidence", async () => {
  const { runsRoot } = freshOptions();
  const tasks = loadTasks(TASKS_DIR);
  assert.equal(tasks.length, 25);
  const results: BenchmarkResult[] = [];
  try {
    for (const task of tasks) {
      const adapter = createCanonicalAdapter({
        transport: trailTransport(task),
        configId: "C-fake",
        requiresExternalInference: false,
        transcriptBudget: "medium",
      });
      const { result } = await runOne(task, adapter, {
        configs: ["C-fake"],
        taskSelectors: [task.id],
        runsRoot,
        tasksDir: TASKS_DIR,
        fixturesDir: FIXTURES_DIR,
      });
      results.push(result);
      if (!result.success) {
        throw new Error(`${task.id}: ${result.failure_class}: ${result.failure_detail} ` + `(reliability: ${JSON.stringify(result.reliability)})`);
      }
    }
    const byId = (id: string): BenchmarkResult => {
      const found = results.find((r) => r.task_id === id);
      assert.ok(found, `${id} must have produced a result`);
      return found;
    };
    // Guard evidence profiles are deterministic.
    assert.ok((byId("nav-001").reliability?.guard_rejections ?? 0) >= 1);
    assert.equal(byId("fail-001").reliability?.duplicate_calls, 1); // identical exec retry blocked
    assert.ok(byId("fail-003").metrics.invalid_tool_calls >= 1); // path: 42 rejected before execution
    for (const result of results) {
      assert.equal(result.reliability?.final_accepted, true, `${result.task_id} final must be accepted`);
      assert.equal(typeof result.reliability.state_contract, "string");
    }
  } finally {
    rmSync(runsRoot, { recursive: true });
  }
});

test("canonical: a stalled transport stops at the task timeout and is classified as timeout", async () => {
  const { runsRoot } = freshOptions();
  try {
    const task = loadTasks(TASKS_DIR).find((t) => t.id === "nav-001");
    assert.ok(task, "nav-001 must exist in the benchmark manifest");
    // A hung provider call that never settles and ignores the run signal: the
    // configured deadline must still end the run and be reported as a timeout.
    const stalled: HarmonyTransport = () => new Promise<Response>(() => {});
    const adapter = createCanonicalAdapter({
      transport: stalled,
      configId: "C-fake",
      name: "C-fake",
      requiresExternalInference: false,
    });
    const { result } = await runOne({ ...task, timeout_ms: 300 }, adapter, {
      configs: ["C-fake"],
      taskSelectors: ["nav-001"],
      runsRoot,
      tasksDir: TASKS_DIR,
      fixturesDir: FIXTURES_DIR,
    });
    assert.equal(result.success, false);
    assert.equal(result.failure_class, "timeout");
    assert.match(result.failure_detail ?? "", /timed out after 300ms/);
  } finally {
    rmSync(runsRoot, { recursive: true });
  }
});

test("canonical: the compact surface never exposes experimental broad tools", async () => {
  const { runsRoot } = freshOptions();
  try {
    const task = loadTasks(TASKS_DIR).find((t) => t.id === "nav-001");
    assert.ok(task, "nav-001 must exist in the benchmark manifest");
    const adapter = createCanonicalAdapter({
      transport: trailTransport(task),
      configId: "C-fake",
      requiresExternalInference: false,
      toolSurface: "compact",
    });
    const { result } = await runOne(task, adapter, {
      configs: ["C-fake"],
      taskSelectors: ["nav-001"],
      runsRoot,
      tasksDir: TASKS_DIR,
      fixturesDir: FIXTURES_DIR,
    });
    const requestEvents = JSON.stringify(result);
    assert.equal(requestEvents.includes("filesystem.write"), false);
  } finally {
    rmSync(runsRoot, { recursive: true });
  }
});

test("canonical: unused config selection still rejects unknown ids", async () => {
  const { runsRoot } = freshOptions();
  try {
    let threw = false;
    try {
      await runBenchmarks({
        configs: ["nope"],
        taskSelectors: ["nav-001"],
        runsRoot,
        tasksDir: TASKS_DIR,
        fixturesDir: FIXTURES_DIR,
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
  } finally {
    rmSync(runsRoot, { recursive: true });
  }
});
