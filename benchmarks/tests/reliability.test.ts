import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

import { referenceAdapter } from "../adapter.ts";
import { loadTasks } from "../manifest.ts";
import { deriveReliability, finalsFromEvents, retrySummaryFromEvents, trailingInvalidStreak } from "../reliability.ts";
import { runOne } from "../runner.ts";
import { validateBenchmarkResult, validateTrajectoryEvent } from "../schemas.ts";

const TASKS_DIR = `${process.cwd()}/benchmarks/tasks`;
const FIXTURES_DIR = `${process.cwd()}/benchmarks/fixtures`;

function freshOptions() {
  mkdirSync(`${process.cwd()}/benchmark-runs`, { recursive: true });
  const runsRoot = mkdtempSync(join(`${process.cwd()}/benchmark-runs`, "fixture-"));
  return { runsRoot };
}

test("reliability: derives evidence from a recorded reference trajectory", async () => {
  const { runsRoot } = freshOptions();
  try {
    const task = loadTasks(TASKS_DIR).find((t) => t.id === "nav-001");
    assert.ok(task);
    const { events } = await runOne(task, referenceAdapter, {
      configs: ["reference"],
      taskSelectors: ["nav-001"],
      runsRoot,
      tasksDir: TASKS_DIR,
      fixturesDir: FIXTURES_DIR,
    });
    const { summary, state_contract } = deriveReliability(events, {
      verificationCommand: task.verify?.command ?? null,
    });
    // The reference trail writes answer.txt and never reads it back in-trail.
    assert.equal(summary.phase, "verifying");
    assert.equal(summary.unverified_writes, 1);
    assert.equal(summary.verification.required, 1);
    assert.equal(summary.verification.satisfied, 0);
    assert.equal(summary.final_accepted, false);
    assert.equal(typeof state_contract, "string");
    assert.equal(summary.guard_rejections, 0);
  } finally {
    rmSync(runsRoot, { recursive: true });
  }
});

test("reliability: duplicate and retry counters derive deterministically from events", () => {
  const events = [
    { type: "tool_call", at: "t", id: "a", tool: "filesystem.read", arguments: { path: "x" }, valid: true },
    { type: "tool_result", at: "t", id: "a", ok: true, output: "v" },
    { type: "tool_call", at: "t", id: "b", tool: "filesystem.read", arguments: { path: "x" }, valid: true },
    { type: "tool_result", at: "t", id: "b", ok: true, output: "v" },
    { type: "tool_call", at: "t", id: "c", tool: "shell.exec", arguments: { command: "false" }, valid: true },
    { type: "tool_result", at: "t", id: "c", ok: false, error_code: "exec_failed", error: "nope" },
    { type: "tool_call", at: "t", id: "d", tool: "shell.exec", arguments: { command: "false" }, valid: true },
    { type: "tool_result", at: "t", id: "d", ok: false, error_code: "exec_failed", error: "nope" },
  ] as unknown as Parameters<typeof deriveReliability>[0];
  const retries = retrySummaryFromEvents(events);
  // Both repeats are attempts; neither is allowed (success repeat and
  // deterministic failure repeat), so the policy rejects both.
  assert.deepEqual(retries, { attempts: 2, allowed: 0, rejected: 2 });
  const { summary } = deriveReliability(events);
  // b is a repeat-after-success; d is a repeat-after-failure (both counted).
  assert.equal(summary.duplicate_calls, 2);
  assert.equal(summary.unverified_writes, 0);
});

test("reliability: finals and guard events drive final_accepted and false_completions", () => {
  const events = [
    { type: "model_response", at: "t", request_id: 1, content: "done" },
    { type: "guard", at: "t", kind: "false_completion", reason: "repeated", attempt: 2, phase: "completing" },
    {
      type: "model_response",
      at: "t",
      request_id: 2,
      content: "done",
      tool_calls: [{ id: "x", name: "filesystem.read", arguments: { path: "a" } }],
    },
    { type: "tool_call", at: "t", id: "x", tool: "filesystem.read", arguments: { path: "a" }, valid: true },
    { type: "tool_result", at: "t", id: "x", ok: true, output: "a" },
    { type: "model_response", at: "t", request_id: 3, content: "done" },
  ] as unknown as Parameters<typeof deriveReliability>[0];
  const finals = finalsFromEvents(events);
  assert.equal(finals.length, 2); // the tool-call response is not a final
  assert.equal(finals[0].accepted, false); // followed by a guard
  assert.equal(finals[1].accepted, true);
  const { summary } = deriveReliability(events);
  assert.equal(summary.final_accepted, true);
  assert.equal(summary.false_completions, 1);
});

test("reliability: trailing invalid streak is counted deterministically", () => {
  const observations = [
    { seq: 1, tool: "filesystem.read", args: { path: "a" }, valid: true, result: { ok: true, output: "a" } },
    {
      seq: 2,
      tool: "filesystem.read",
      args: { path: 42 },
      valid: false,
      result: { ok: false, error_code: "invalid_args" },
    },
    {
      seq: 3,
      tool: "filesystem.read",
      args: { path: 43 },
      valid: false,
      result: { ok: false, error_code: "invalid_args" },
    },
  ];
  assert.equal(trailingInvalidStreak(observations), 2);
});

test("reliability: the runner attaches a validated summary to every result", async () => {
  const { runsRoot } = freshOptions();
  try {
    const task = loadTasks(TASKS_DIR).find((t) => t.id === "nav-001");
    assert.ok(task);
    const { result } = await runOne(task, referenceAdapter, {
      configs: ["reference"],
      taskSelectors: ["nav-001"],
      runsRoot,
      tasksDir: TASKS_DIR,
      fixturesDir: FIXTURES_DIR,
    });
    assert.equal(result.reliability?.phase, "verifying");
    assert.equal(result.reliability.verification.required, 1);
    // The result record round-trips through the schema validator.
    validateBenchmarkResult(result);
  } finally {
    rmSync(runsRoot, { recursive: true });
  }
});

test("reliability: guard trajectory events validate and reject malformed attempts", () => {
  const event = {
    type: "guard",
    at: "2026-01-01T00:00:00.000Z",
    kind: "unverified_write",
    reason: "[guard] final answer rejected: [unverified_write] answer.txt",
    attempt: 1,
    phase: "verifying",
  };
  validateTrajectoryEvent(event as never);
  assert.throws(() => validateTrajectoryEvent({ ...event, attempt: -1 } as never));
});
