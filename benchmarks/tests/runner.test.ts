import { test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type BenchmarkAdapter, referenceAdapter } from "../adapter.ts";
import { loadTasks } from "../manifest.ts";
import { runBenchmarks, runOne, type RunOptions } from "../runner.ts";
import { type TaskManifest, validateTrajectoryEvent } from "../schemas.ts";

const TASKS_DIR = `${process.cwd()}/benchmarks/tasks`;
const FIXTURES_DIR = `${process.cwd()}/benchmarks/fixtures`;

function freshOptions(): RunOptions & { runsRoot: string } {
  mkdirSync(`${process.cwd()}/benchmark-runs`, { recursive: true });
  const runsRoot = mkdtempSync(join(`${process.cwd()}/benchmark-runs`, "fixture-"));
  return {
    configs: ["reference"],
    taskSelectors: [],
    runsRoot,
    tasksDir: TASKS_DIR,
    fixturesDir: FIXTURES_DIR,
  };
}

function nav001(): TaskManifest {
  const task = loadTasks(TASKS_DIR).find((t) => t.id === "nav-001");
  if (!task) throw new Error(`benchmark task nav-001 is missing from ${TASKS_DIR}`);
  return task;
}

test("runner: reference run succeeds with recorded trajectory and metrics", async () => {
  const opts = freshOptions();
  try {
    const { result, events } = await runOne(nav001(), referenceAdapter, opts);
    if (!result.success || result.failure_class !== null) {
      throw new Error(`expected success, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (result.metrics.tool_calls !== 4) throw new Error(`expected 4 tool calls, got ${result.metrics.tool_calls}`);
    if (!result.verification.passed || !result.oracle.passed) {
      throw new Error("expected verification and oracle to pass");
    }
    if (events.length !== result.metrics.tool_calls * 2 + 2) throw new Error("unexpected event count"); // run + verify + call/result pairs
    for (const event of events) validateTrajectoryEvent(event);
    const traj = readFileSync(`${opts.runsRoot}/${result.trajectory}`, "utf8");
    const lines = traj.trimEnd().split("\n");
    if (lines.length !== events.length) throw new Error("trajectory.jsonl row count mismatch");
    const summary = readFileSync(`${opts.runsRoot}/runs/${result.run_id}/result.jsonl`, "utf8");
    if (summary.trimEnd().split("\n").length !== 1) throw new Error("result.jsonl must be one record");
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("runner: verification failure is classified", async () => {
  const opts = freshOptions();
  try {
    const task = { ...nav001(), verify: { command: "false" } };
    const { result } = await runOne(task, referenceAdapter, opts);
    if (result.success || result.failure_class !== "verification_failed") {
      throw new Error(`expected verification_failed, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (!result.verification.ran || result.verification.exit_code !== 1) throw new Error("verify evidence missing");
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("runner: min_tool_calls not met is classified", async () => {
  const opts = freshOptions();
  try {
    const task = { ...nav001(), min_tool_calls: 10 };
    const { result } = await runOne(task, referenceAdapter, opts);
    if (result.success || result.failure_class !== "min_calls_not_met") {
      throw new Error(`expected min_calls_not_met, got ${result.failure_class}: ${result.failure_detail}`);
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("runner: tool_call_limit is classified", async () => {
  const opts = freshOptions();
  try {
    const task = { ...nav001(), max_tool_calls: 2 };
    const { result } = await runOne(task, referenceAdapter, opts);
    if (result.success || result.failure_class !== "tool_call_limit") {
      throw new Error(`expected tool_call_limit, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (result.metrics.tool_calls !== 2) throw new Error(`expected 2 recorded calls, got ${result.metrics.tool_calls}`);
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("runner: whole-run timeout cancels in-flight shell and classifies", async () => {
  const opts = freshOptions();
  try {
    const task: TaskManifest = {
      ...nav001(),
      timeout_ms: 400,
      scripted_trail: [
        { tool: "shell.exec", args: { command: "sleep 5" } },
        { tool: "filesystem.read", args: { path: "docs/spec.txt" } },
      ],
    };
    const { result } = await runOne(task, referenceAdapter, opts);
    if (result.success || result.failure_class !== "timeout") {
      throw new Error(`expected timeout, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (result.wall_time_ms > 4000) throw new Error(`timeout did not cancel work: ${result.wall_time_ms}ms`);
    if (result.metrics.tool_errors < 1) throw new Error("expected the interrupted tool error to be recorded");
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("runner: fixture revision mismatch fails before the adapter runs", async () => {
  const opts = freshOptions();
  try {
    const task = { ...nav001(), fixture_revision: "sha256:" + "0".repeat(64) };
    const { result, events } = await runOne(task, referenceAdapter, opts);
    if (result.success || result.failure_class !== "fixture_revision_mismatch") {
      throw new Error(`expected fixture_revision_mismatch, got ${result.failure_class}: ${result.failure_detail}`);
    }
    if (events.some((e) => e.type === "tool_call")) throw new Error("adapter must not run on revision mismatch");
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("runner: refuses unused configs and external-inference adapters", async () => {
  const opts = freshOptions();
  try {
    let threw = false;
    try {
      await runBenchmarks({ ...opts, configs: ["nope"], taskSelectors: ["nav-001"] });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("expected unknown-config error");
    const live: BenchmarkAdapter = {
      configId: "live",
      name: "live",
      description: "external",
      requiresExternalInference: true,
      run: async () => {},
    };
    let refused = false;
    try {
      await runBenchmarks({ ...opts, configs: ["live"], taskSelectors: ["nav-001"], adapters: [live] });
    } catch (err) {
      refused = (err as Error).message.includes("external-inference");
    }
    if (!refused) throw new Error("expected external-inference refusal");
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("runner: selection and limit flags compose", async () => {
  const opts = freshOptions();
  try {
    const results = await runBenchmarks({
      ...opts,
      configs: ["reference"],
      taskSelectors: ["category:long"],
      limit: 2,
    });
    if (results.length !== 2) throw new Error(`expected 2 limited runs, got ${results.length}`);
    if (!results.every((r) => r.config_id === "reference" && r.task_id.startsWith("long-"))) {
      throw new Error("unexpected selection");
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("runner: parseRunArgs accepts the task '--' separator", async () => {
  const { parseRunArgs } = await import("../runner.ts");
  const opts = parseRunArgs(["--", "--configs=reference", "--tasks=nav-001,code-*", "--limit=3"]);
  if ("help" in opts) throw new Error("unexpected help");
  if (opts.configs[0] !== "reference" || opts.taskSelectors.join(",") !== "nav-001,code-*" || opts.limit !== 3) {
    throw new Error("arg parsing failed");
  }
  let threw = false;
  try {
    parseRunArgs(["--bogus=1"]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected unknown argument rejection");
});
