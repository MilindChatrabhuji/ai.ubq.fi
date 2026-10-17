import { test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  BENCHMARK_SCHEMA_VERSION,
  SchemaError,
  type TrajectoryEvent,
  validateBenchmarkResult,
  validateTaskManifest,
  validateTrajectoryEvent,
} from "../schemas.ts";
import { loadTasks, selectTasks, taskFamily } from "../manifest.ts";
import { computeFixtureRevision } from "../fixture.ts";

function baseManifest(): Record<string, unknown> {
  return {
    id: "t-001",
    category: "navigation",
    title: "t",
    description: "d",
    fixture: "t-001",
    fixture_revision: "sha256:" + "0".repeat(64),
    timeout_ms: 1000,
    max_tool_calls: 10,
    min_tool_calls: 1,
    min_model_calls: 0,
    allowed_write_scope: ["**"],
    verify: { command: "true" },
    scripted_trail: [{ tool: "filesystem.read", args: { path: "a.txt" } }],
  };
}

test("schemas: valid manifest round-trips", () => {
  const m = validateTaskManifest(baseManifest());
  if (m.id !== "t-001" || m.category !== "navigation") throw new Error("identity lost");
});

test("schemas: manifest rejects unknown category", () => {
  const m = baseManifest();
  m.category = "space";
  let threw = false;
  try {
    validateTaskManifest(m);
  } catch (err) {
    threw = err instanceof SchemaError;
  }
  if (!threw) throw new Error("expected SchemaError for bad category");
});

test("schemas: manifest rejects malformed fixture revision", () => {
  const m = baseManifest();
  m.fixture_revision = "sha256:zz";
  let threw = false;
  try {
    validateTaskManifest(m);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected rejection of malformed revision");
});

test("schemas: manifest rejects empty allowed_write_scope", () => {
  const m = baseManifest();
  m.allowed_write_scope = [];
  let threw = false;
  try {
    validateTaskManifest(m);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected rejection of empty scope");
});

test("schemas: manifest rejects min > max tool calls", () => {
  const m = baseManifest();
  m.min_tool_calls = 11;
  let threw = false;
  try {
    validateTaskManifest(m);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected rejection of min > max");
});

test("schemas: manifest validates file-check invert as boolean", () => {
  const m = baseManifest();
  m.oracle = { file_checks: [{ path: "a", kind: "exists", invert: 1 }] };
  let threw = false;
  try {
    validateTaskManifest(m);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected rejection of non-boolean invert");
});

test("schemas: trajectory run event validates", () => {
  const event: TrajectoryEvent = {
    type: "run",
    at: "2026-01-01T00:00:00.000Z",
    run_id: "r1",
    task_id: "t-001",
    category: "navigation",
    config_id: "reference",
    adapter_id: "reference",
    fixture: "t-001",
    fixture_revision: "sha256:" + "0".repeat(64),
  };
  validateTrajectoryEvent(event);
});

test("schemas: trajectory tool_call requires valid flag", () => {
  let threw = false;
  try {
    validateTrajectoryEvent({
      type: "tool_call",
      at: "2026-01-01T00:00:00.000Z",
      id: "t1",
      tool: "shell.exec",
      arguments: {},
    });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected rejection of tool_call without valid");
});

test("schemas: result validates and rejects unknown failure class", () => {
  const result = {
    schema_version: BENCHMARK_SCHEMA_VERSION,
    run_id: "r1",
    task_id: "t-001",
    config_id: "reference",
    adapter_id: "reference",
    fixture: "t-001",
    fixture_revision: "sha256:" + "0".repeat(64),
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:01.000Z",
    wall_time_ms: 1000,
    success: false,
    failure_class: "timeout",
    failure_detail: "x",
    metrics: {
      model_calls: 0,
      tool_calls: 1,
      invalid_tool_calls: 0,
      wrong_tool_calls: 0,
      repeated_calls: 0,
      tool_errors: 0,
      recovery_attempts: 0,
      input_tokens: 0,
      output_tokens: 0,
      context_size: 0,
    },
    verification: { ran: true, passed: true, command: "true", exit_code: 0, timed_out: false, output: null },
    oracle: { passed: true, checks: [] },
    required_calls: { min_tool_calls: 0, tool_calls: 1, min_model_calls: 0, model_calls: 0, met: true },
    trajectory: "runs/r1/trajectory.jsonl",
    created_at: "2026-01-01T00:00:01.000Z",
  };
  validateBenchmarkResult(result);
  (result as { failure_class: string }).failure_class = "made_up";
  let threw = false;
  try {
    validateBenchmarkResult(result);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected rejection of unknown failure class");
});

// ---------------------------------------------------------------------------
// Manifest corpus
// ---------------------------------------------------------------------------

const TASKS_DIR = `${process.cwd()}/benchmarks/tasks`;
const FIXTURES_DIR = `${process.cwd()}/benchmarks/fixtures`;

test("manifests: 25 tasks across all required categories", () => {
  const tasks = loadTasks(TASKS_DIR);
  if (tasks.length !== 25) throw new Error(`expected 25 tasks, got ${tasks.length}`);
  for (const cat of ["navigation", "coding", "sequential", "failure", "long"]) {
    if (!tasks.some((t) => t.category === cat)) throw new Error(`missing category ${cat}`);
  }
});

test("manifests: every task declares fixture revision, verify command, trail, and write scope", () => {
  const tasks = loadTasks(TASKS_DIR);
  for (const task of tasks) {
    if (task.fixture_revision === "") throw new Error(`${task.id}: missing fixture_revision`);
    if (!task.verify?.command) throw new Error(`${task.id}: missing verify command`);
    if (!task.scripted_trail?.length) throw new Error(`${task.id}: missing scripted_trail`);
    if (task.allowed_write_scope.length === 0) throw new Error(`${task.id}: empty write scope`);
    const head = `${FIXTURES_DIR}/${task.fixture}`;
    const entries = [...readdirSync(head, { withFileTypes: true })];
    if (entries.length === 0) throw new Error(`${task.id}: fixture dir ${task.fixture} is empty`);
    // Reference adapter records exactly one tool_call event per trail step.
    if (task.scripted_trail.length < task.min_tool_calls) {
      throw new Error(`${task.id}: trail length ${task.scripted_trail.length} < min_tool_calls ${task.min_tool_calls}`);
    }
  }
});

test("manifests: fixture revisions match the checked-in snapshots", async () => {
  const tasks = loadTasks(TASKS_DIR);
  for (const task of tasks) {
    const actual = await computeFixtureRevision(`${FIXTURES_DIR}/${task.fixture}`);
    if (actual !== task.fixture_revision) {
      throw new Error(`${task.id}: declared ${task.fixture_revision} != computed ${actual}`);
    }
  }
});

test("manifests: long-horizon tasks exceed 10 and 20 tool calls", () => {
  const tasks = loadTasks(TASKS_DIR);
  const over10 = tasks.filter((t) => t.min_tool_calls > 10);
  const over20 = tasks.filter((t) => t.min_tool_calls > 20);
  if (over10.length < 1) throw new Error("expected at least one task with min_tool_calls > 10");
  if (over20.length < 1) throw new Error("expected at least one task with min_tool_calls > 20");
  if (over20.some((t) => t.min_tool_calls <= 20)) throw new Error("over20 selection wrong");
});

test("manifests: selection supports id, glob, category, and rejects unknown", () => {
  const tasks = loadTasks(TASKS_DIR);
  if (
    selectTasks(tasks, ["nav-001"])
      .map((t) => t.id)
      .join(",") !== "nav-001"
  )
    throw new Error("id selection failed");
  const globbed = selectTasks(tasks, ["code-*"]);
  if (!globbed.every((t) => t.id.startsWith("code-")) || globbed.length !== 5) throw new Error("glob selection failed");
  const cat = selectTasks(tasks, ["category:long"]);
  if (cat.length !== 5 || !cat.every((t) => t.category === "long")) throw new Error("category selection failed");
  let threw = false;
  try {
    selectTasks(tasks, ["nope-*"]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("expected unknown selector rejection");
  const navTask = loadTasks(TASKS_DIR).find((t) => t.id === "nav-001");
  if (navTask === undefined) throw new Error("nav-001 must be present in the task manifests");
  if (taskFamily(navTask) !== "nav") {
    throw new Error("taskFamily derived wrong family");
  }
});
