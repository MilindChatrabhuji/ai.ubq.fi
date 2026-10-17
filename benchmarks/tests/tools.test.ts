import { test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { referenceAdapter } from "../adapter.ts";
import { loadTasks } from "../manifest.ts";
import { runOne, type RunOptions } from "../runner.ts";
import { type TaskManifest, type ToolResultEvent } from "../schemas.ts";

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
  if (task === undefined) throw new Error(`missing nav-001 task fixture in ${TASKS_DIR}`);
  return task;
}

function fail002(): TaskManifest {
  const task = loadTasks(TASKS_DIR).find((t) => t.id === "fail-002");
  if (task === undefined) throw new Error(`missing fail-002 task fixture in ${TASKS_DIR}`);
  return task;
}

test("tools: canonical browser fakes resolve inside the reference adapter", async () => {
  const opts = freshOptions();
  try {
    const task: TaskManifest = {
      ...nav001(),
      scripted_trail: [
        {
          tool: "browser.search",
          args: { query: "example" },
          expect: { ok: true, output_contains: ["https://example.com/index.html", "Welcome to the example site."] },
        },
        {
          tool: "browser.open",
          args: { url: "https://example.com/index.html" },
          expect: { ok: true, output_contains: ["Example", "Welcome to the example site."] },
        },
        {
          tool: "browser.find",
          args: { query: "find content" },
          expect: { ok: true, output_contains: ["Find content"] },
        },
        { tool: "editor.apply_patch", args: { path: "answer.txt", add: true, new: "done" } },
      ],
      verify: { command: "test -f answer.txt", timeout_ms: 20000 },
      oracle: { file_checks: [{ path: "answer.txt", kind: "equals", value: "done" }] },
    };
    const { result } = await runOne(task, referenceAdapter, opts);
    if (!result.success || result.failure_class !== null) {
      throw new Error(`expected success, got ${result.failure_class}: ${result.failure_detail}`);
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("tools: canonical boundaries and error codes flow through the adapter", async () => {
  const opts = freshOptions();
  try {
    const task: TaskManifest = {
      ...nav001(),
      scripted_trail: [
        {
          tool: "filesystem.read",
          args: { path: "../etc/passwd" },
          expect: { ok: false, error_contains: "path escapes workspace root" },
        },
        {
          tool: "filesystem.read",
          args: { path: "docs/spec.txt" },
          expect: { ok: true, output_contains: ["Section 1"] },
        },
        {
          tool: "filesystem.read",
          args: { path: "docs/missing.txt" },
          expect: { ok: false, error_contains: "not found" },
        },
        { tool: "editor.apply_patch", args: { path: "answer.txt", add: true, new: "ok" } },
      ],
      verify: { command: "test -f answer.txt", timeout_ms: 20000 },
      oracle: { file_checks: [{ path: "answer.txt", kind: "equals", value: "ok" }] },
    };
    const { result, events } = await runOne(task, referenceAdapter, opts);
    if (!result.success || result.failure_class !== null) {
      throw new Error(`expected success, got ${result.failure_class}: ${result.failure_detail}`);
    }
    const toolResults = events.filter((e): e is ToolResultEvent => e.type === "tool_result");
    if (toolResults.length !== 4) throw new Error(`expected 4 tool results, got ${toolResults.length}`);
    if (toolResults[0].error_code !== "path_escape") {
      throw new Error(`expected path_escape, got ${toolResults[0].error_code}`);
    }
    if (!toolResults[1].ok) throw new Error("expected the in-scope read to succeed");
    if (toolResults[2].error_code !== "not_found") {
      throw new Error(`expected not_found, got ${toolResults[2].error_code}`);
    }
    if (toolResults[3].error_code !== undefined || !toolResults[3].ok) {
      throw new Error("expected the final patch to be a clean success");
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});

test("tools: shell.exec write-scope violations surface as write_scope failures and are rolled back", async () => {
  const opts = freshOptions();
  try {
    const task: TaskManifest = {
      ...fail002(),
      scripted_trail: [
        {
          tool: "shell.exec",
          // The first write is in scope for fail-002 and must survive the
          // second, out-of-scope write's rollback.
          args: { command: "printf 'changed\\n' > data/target.txt; printf 'TAMPERED\\n' > protected/keep.txt" },
          expect: { ok: false, error_contains: "write scope violation: protected/keep.txt" },
        },
        { tool: "shell.exec", args: { command: "sh tests/run.sh" }, expect: { ok: true } },
        {
          tool: "filesystem.read",
          args: { path: "protected/keep.txt" },
          expect: { ok: true, output_contains: ["ORIGINAL"] },
        },
      ],
    };
    const { result, events } = await runOne(task, referenceAdapter, opts);
    if (!result.success || result.failure_class !== null) {
      throw new Error(`expected success, got ${result.failure_class}: ${result.failure_detail}`);
    }
    const toolResults = events.filter((e): e is ToolResultEvent => e.type === "tool_result");
    if (toolResults.length !== 3) throw new Error(`expected 3 tool results, got ${toolResults.length}`);
    if (toolResults[0].ok || toolResults[0].error_code !== "write_scope") {
      throw new Error(`expected a write_scope failure, got ok=${toolResults[0].ok} code=${toolResults[0].error_code}`);
    }
    if (!toolResults[1].ok) throw new Error("expected the verification command to pass after the rollback");
    if (!toolResults[2].ok || !(toolResults[2].output ?? "").includes("ORIGINAL")) {
      throw new Error("expected the protected file to be restored for the follow-up read");
    }
  } finally {
    rmSync(opts.runsRoot, { recursive: true });
  }
});
