import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

import { broadToolSurface, compactToolSurface, surfaceTokenCost } from "../../src/harmony/reliability/surfaces.ts";
import { buildContextEvidence } from "../compare.ts";
import { loadTasks } from "../manifest.ts";

const TASKS_DIR = `${process.cwd()}/benchmarks/tasks`;

function freshOptions() {
  mkdirSync(`${process.cwd()}/benchmark-runs`, { recursive: true });
  const runsRoot = mkdtempSync(join(`${process.cwd()}/benchmark-runs`, "fixture-"));
  return { runsRoot };
}

function requireFound<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`missing compare evidence: ${description}`);
  return value;
}

test("compare: evidence runs deterministically without inference", async () => {
  const { runsRoot } = freshOptions();
  try {
    const tasks = loadTasks(TASKS_DIR).filter((t) => ["nav-001", "fail-001", "long-003"].includes(t.id));
    assert.equal(tasks.length, 3);
    const evidence = await buildContextEvidence(tasks, runsRoot);
    assert.equal(evidence.schema_version, "1.0");
    assert.equal(evidence.mode, "deterministic");
    assert.equal(evidence.tasks.length, 3);
    const compactSurface = requireFound(
      evidence.surfaces.find((s) => s.id === "compact"),
      "compact surface"
    );
    const broadSurface = requireFound(
      evidence.surfaces.find((s) => s.id === "broad"),
      "broad surface"
    );
    assert.equal(compactSurface.tools, 9);
    assert.equal(broadSurface.tools, 13);
    assert.ok(broadSurface.tokens > compactSurface.tokens);
    for (const task of evidence.tasks) {
      assert.ok(task.full_transcript_tokens > 0);
      assert.equal(task.budgets.length, 3);
      for (const budget of task.budgets) {
        assert.equal(budget.contract_preserved, true, `${task.task_id}@${budget.budget}`);
        assert.ok(budget.full_transcript_tokens >= budget.compaction_tokens);
        assert.ok(budget.structured_tokens >= compactSurface.tokens, "structured totals must include the compact tool schema");
      }
    }
    // Structured context costs strictly less than a full replay in the
    // long-horizon task, where the compaction/state-summary payoff is real.
    const long = requireFound(
      evidence.tasks.find((t) => t.task_id === "long-003"),
      "long-003 task"
    );
    const medium = requireFound(
      long.budgets.find((b) => b.budget === "medium"),
      "long-003 medium budget"
    );
    assert.ok(medium.structured_tokens < medium.full_transcript_tokens, `structured ${medium.structured_tokens} < full ${medium.full_transcript_tokens}`);
  } finally {
    rmSync(runsRoot, { recursive: true });
  }
});

test("compare: surfaces report compact always cheaper than broad", () => {
  const compact = compactToolSurface();
  const broad = broadToolSurface();
  assert.equal(compact.definitions.length, 9);
  assert.equal(broad.definitions.length, 13);
  assert.ok(surfaceTokenCost(broad) > surfaceTokenCost(compact));
  assert.equal(surfaceTokenCost(compact), surfaceTokenCost(compactToolSurface()));
});

test("compare: aggregation carries per-budget evidence", async () => {
  const { runsRoot } = freshOptions();
  try {
    const tasks = loadTasks(TASKS_DIR).filter((t) => t.id === "nav-001");
    const evidence = await buildContextEvidence(tasks, runsRoot);
    for (const kind of ["short", "medium", "large"] as const) {
      const agg = evidence.aggregate[kind];
      assert.equal(agg.tasks, 1);
      assert.equal(agg.contract_preserved, 1);
      assert.ok(agg.structured_ratio > 0);
    }
  } finally {
    rmSync(runsRoot, { recursive: true });
  }
});
