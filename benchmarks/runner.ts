import { statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
/**
 * Benchmark runner CLI.
 *
 * Usage (from the repository root):
 *   bun run benchmark:run -- --configs=reference            # hermetic default
 *   bun run benchmark:run -- --configs=reference --tasks=nav-*,fail-*
 *   bun run benchmark:run -- --configs=reference --tasks=category:long --limit=3
 *   bun run benchmark:run -- --runs=benchmark-runs --configs=all
 *
 * The runner only executes adapters registered in defaultAdapters(). The
 * built-in `reference` adapter is deterministic and calls no external model;
 * adapters flagged requiresExternalInference are refused until an approved
 * live-inference gate exists (m03/m05). Selection flags are the only
 * configuration surface; no environment variables are read.
 */

import { type AdapterRunContext, type BenchmarkAdapter, defaultAdapters, TaskTimeoutError, ToolCallLimitExceededError } from "./adapter.ts";
import { computeFixtureRevision, FixtureRevisionMismatchError, FixtureWorkspace } from "./fixture.ts";
import { loadTasks, selectTasks } from "./manifest.ts";
import { aggregateResults, deriveMetrics, formatSummary } from "./metrics.ts";
import { evaluateOracle, runVerification } from "./oracle.ts";
import { deriveReliability } from "./reliability.ts";
import {
  BENCHMARK_ROOT,
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkResult,
  DEFAULT_RUNS_ROOT,
  type FailureClass,
  type TaskManifest,
  type TrajectoryEvent,
  validateBenchmarkResult,
  validateTrajectoryEvent,
  type VerificationOutcome,
} from "./schemas.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type RunOptions = {
  /** Adapter config ids, or ["all"] for every registered adapter. */
  configs: string[];
  /** Task selectors: exact id, glob, `*`, or `category:<name>`. */
  taskSelectors: string[];
  /** Cap the number of (task × config) pairs executed. */
  limit?: number;
  /** Writable results root (git-ignored). */
  runsRoot: string;
  tasksDir: string;
  fixturesDir: string;
  /** Adapter registry; defaults to defaultAdapters() (m03 registers A/B/D here). */
  adapters?: BenchmarkAdapter[];
};

export function defaultRunOptions(): RunOptions {
  return {
    configs: ["reference"],
    taskSelectors: ["*"],
    runsRoot: DEFAULT_RUNS_ROOT,
    tasksDir: `${BENCHMARK_ROOT}/tasks`,
    fixturesDir: `${BENCHMARK_ROOT}/fixtures`,
  };
}

export function parseRunArgs(argv: string[]): RunOptions | { help: true } {
  // `bun run benchmark:run -- args` forwards a literal "--"; accept both forms.
  if (argv[0] === "--") argv = argv.slice(1);
  const opts = defaultRunOptions();
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg.startsWith("--configs=")) opts.configs = arg.slice("--configs=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--tasks=")) opts.taskSelectors = arg.slice("--tasks=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--limit=")) opts.limit = parseInt(arg.slice("--limit=".length), 10);
    else if (arg.startsWith("--runs=")) opts.runsRoot = arg.slice("--runs=".length);
    else throw new Error(`unknown argument ${arg} (see --help)`);
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  return opts;
}

export const RUN_HELP = `usage: bun run benchmark:run -- [--configs=reference] [--tasks=*] [--limit=N] [--runs=benchmark-runs]

  --configs    comma-separated adapter config ids, or "all" (default: reference)
  --tasks      comma-separated selectors: exact id, glob (* pattern), "category:<name>"
  --limit      cap the number of (task x config) pairs
  --runs       results root directory (default: benchmark-runs)

registered configs: ${defaultAdapters()
  .map((a) => a.configId)
  .join(", ")}`;

// ---------------------------------------------------------------------------
// Single run
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

function uniqueRunId(runsRoot: string, configId: string, taskId: string): string {
  const stamp = isoNow().replace(/\D/g, "").slice(0, 14);
  const base = `${stamp}-${configId}-${taskId}`;
  let candidate = base;
  let n = 2;
  while (exists(`${runsRoot}/runs/${candidate}`)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeJsonl(path: string, records: unknown[]): void {
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, body);
}

export type RunOneOutcome = {
  result: BenchmarkResult;
  events: TrajectoryEvent[];
};

/** Classifies a thrown adapter failure into the benchmark failure taxonomy; null means the adapter completed. */
async function classifyAdapterFailure(
  adapter: BenchmarkAdapter,
  ctx: AdapterRunContext
): Promise<{ failureClass: FailureClass; failureDetail: string } | null> {
  try {
    await adapter.run(ctx);
    return null;
  } catch (err) {
    if (err instanceof TaskTimeoutError) return { failureClass: "timeout", failureDetail: err.message };
    if (err instanceof ToolCallLimitExceededError) return { failureClass: "tool_call_limit", failureDetail: err.message };
    return { failureClass: "adapter_error", failureDetail: (err as Error).message };
  }
}

/** Maps the observed run onto the benchmark failure taxonomy; null means the run passed. */
function classifyRunFailure(
  task: TaskManifest,
  metrics: ReturnType<typeof deriveMetrics>,
  requiredCallsMet: boolean,
  verification: Awaited<ReturnType<typeof runVerification>>,
  oracle: Awaited<ReturnType<typeof evaluateOracle>>
): { failureClass: FailureClass; failureDetail: string } | null {
  if (!requiredCallsMet) {
    return {
      failureClass: "min_calls_not_met",
      failureDetail: `recorded ${metrics.tool_calls} tool calls (min ${task.min_tool_calls}) and ${metrics.model_calls} model calls (min ${task.min_model_calls})`,
    };
  }
  if (!verification.passed) {
    return {
      failureClass: "verification_failed",
      failureDetail: verification.timed_out
        ? `verification command timed out: ${verification.command}`
        : `verification command exited ${verification.exit_code}: ${verification.command}`,
    };
  }
  if (!oracle.passed) {
    return {
      failureClass: "verification_failed",
      failureDetail: `oracle checks failed: ${oracle.checks
        .filter((c) => !c.passed)
        .map((c) => c.detail)
        .join("; ")}`,
    };
  }
  return null;
}

/** Execute one task against one adapter configuration. */
export async function runOne(task: TaskManifest, adapter: BenchmarkAdapter, opts: RunOptions, runIdHint = ""): Promise<RunOneOutcome> {
  const runId = runIdHint || uniqueRunId(opts.runsRoot, adapter.configId, task.id);
  const runDir = `${opts.runsRoot}/runs/${runId}`;
  await mkdir(runDir, { recursive: true });

  const events: TrajectoryEvent[] = [];
  const started = isoNow();
  let prepared = false;
  let failureClass: FailureClass | null = null;
  let failureDetail: string | null = null;

  const record = (event: TrajectoryEvent): void => {
    try {
      validateTrajectoryEvent(event);
    } catch (err) {
      throw new Error(`invalid trajectory event: ${(err as Error).message}`, { cause: err });
    }
    events.push(event);
  };

  const workspace = new FixtureWorkspace({
    fixtureDir: `${opts.fixturesDir}/${task.fixture}`,
    runId,
    tmpParent: `${opts.runsRoot}/tmp`,
    task,
  });

  const signal = AbortSignal.timeout(task.timeout_ms);
  const ctx: AdapterRunContext = {
    runId,
    task,
    workspace,
    signal,
    record,
    time: isoNow,
    checkToolLimit: () => {
      const calls = events.filter((e) => e.type === "tool_call").length;
      if (calls >= task.max_tool_calls) throw new ToolCallLimitExceededError(task.max_tool_calls);
    },
  };

  record({
    type: "run",
    at: started,
    run_id: runId,
    task_id: task.id,
    category: task.category,
    config_id: adapter.configId,
    adapter_id: adapter.configId,
    fixture: task.fixture,
    fixture_revision: task.fixture_revision,
  });

  try {
    await workspace.prepare();
    prepared = true;
    const actualRevision = await computeFixtureRevision(`${opts.fixturesDir}/${task.fixture}`);
    if (actualRevision !== task.fixture_revision) {
      throw new FixtureRevisionMismatchError(task.id, task.fixture_revision, actualRevision);
    }
  } catch (err) {
    if (err instanceof FixtureRevisionMismatchError) {
      failureClass = "fixture_revision_mismatch";
      failureDetail = err.message;
    } else {
      failureClass = "adapter_error";
      failureDetail = `fixture preparation failed: ${(err as Error).message}`;
    }
  }

  if (failureClass === null) {
    const adapterFailure = await classifyAdapterFailure(adapter, ctx);
    if (adapterFailure) {
      failureClass = adapterFailure.failureClass;
      failureDetail = adapterFailure.failureDetail;
    }
  }

  // Verification and oracle evaluation against the final workspace state.
  let verification: VerificationOutcome;
  if (!prepared) {
    verification = { ran: false, passed: false, command: null, exit_code: null, timed_out: false, output: null };
  } else {
    try {
      verification = await runVerification(task, workspace);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      verification = {
        ran: true,
        passed: false,
        command: task.verify?.command ?? null,
        exit_code: null,
        timed_out: false,
        output: `verification failed: ${message}`.slice(0, 4000),
      };
    }
  }
  record({
    type: "verify",
    at: isoNow(),
    command: verification.command ?? "(no verification command)",
    passed: verification.passed,
    exit_code: verification.exit_code ?? undefined,
    timed_out: verification.timed_out,
    output: verification.output ?? undefined,
  });

  const oracle = prepared
    ? await evaluateOracle(task, workspace)
    : { passed: false, checks: [{ kind: "file" as const, detail: "fixture workspace not prepared", passed: false }] };

  const metrics = deriveMetrics(events);
  const reliability = deriveReliability(events, { verificationCommand: task.verify?.command ?? null });
  const requiredCalls = {
    min_tool_calls: task.min_tool_calls,
    tool_calls: metrics.tool_calls,
    min_model_calls: task.min_model_calls,
    model_calls: metrics.model_calls,
    met: metrics.tool_calls >= task.min_tool_calls && metrics.model_calls >= task.min_model_calls,
  };

  if (failureClass === null) {
    const runFailure = classifyRunFailure(task, metrics, requiredCalls.met, verification, oracle);
    if (runFailure) {
      failureClass = runFailure.failureClass;
      failureDetail = runFailure.failureDetail;
    }
  }

  const ended = isoNow();
  const result: BenchmarkResult = {
    schema_version: BENCHMARK_SCHEMA_VERSION,
    run_id: runId,
    task_id: task.id,
    config_id: adapter.configId,
    adapter_id: adapter.configId,
    fixture: task.fixture,
    fixture_revision: task.fixture_revision,
    started_at: started,
    ended_at: ended,
    wall_time_ms: Date.parse(ended) - Date.parse(started),
    success: failureClass === null,
    failure_class: failureClass,
    failure_detail: failureDetail,
    metrics,
    reliability: reliability.summary,
    verification,
    oracle,
    required_calls: requiredCalls,
    trajectory: `runs/${runId}/trajectory.jsonl`,
    created_at: ended,
  };
  validateBenchmarkResult(result);
  writeJsonl(`${runDir}/trajectory.jsonl`, events);
  writeJsonl(`${runDir}/result.jsonl`, [result]);

  try {
    await workspace.remove();
  } catch {
    // The disposable workspace may not exist when preparation failed early.
  }
  return { result, events };
}

// ---------------------------------------------------------------------------
// Full matrix
// ---------------------------------------------------------------------------

/** Resolves the adapters to execute, refusing unknown configs and external-inference adapters. */
function selectAdapters(opts: RunOptions, adapters: BenchmarkAdapter[]): BenchmarkAdapter[] {
  const chosen = opts.configs.includes("all") ? adapters : adapters.filter((a) => opts.configs.includes(a.configId));
  const missing = opts.configs.filter((c) => c !== "all" && !adapters.some((a) => a.configId === c));
  if (missing.length > 0) {
    throw new Error(`unknown configs: ${missing.join(", ")} (registered: ${adapters.map((a) => a.configId).join(", ")})`);
  }
  const external = chosen.filter((a) => a.requiresExternalInference);
  if (external.length > 0) {
    throw new Error(
      `refusing to run external-inference adapters (${external.map((a) => a.configId).join(", ")}): ` +
        `the hermetic runner only executes deterministic adapters; live runs are staged and gated by m03/m05`
    );
  }
  return chosen;
}

/** One progress line per executed (task x config) pair. */
function reportPairResult(result: BenchmarkResult): void {
  const icon = result.success ? "ok " : "FAIL";
  console.log(
    `  ${icon} ${result.config_id} ${result.task_id} ${result.wall_time_ms}ms ` +
      `tools=${result.metrics.tool_calls} errs=${result.metrics.tool_errors}` +
      (result.failure_class ? ` -> ${result.failure_class}: ${result.failure_detail}` : "")
  );
}

export async function runBenchmarks(opts: RunOptions): Promise<BenchmarkResult[]> {
  const tasks = loadTasks(opts.tasksDir);
  const selected = selectTasks(tasks, opts.taskSelectors);
  const chosen = selectAdapters(opts, opts.adapters ?? defaultAdapters());

  await mkdir(`${opts.runsRoot}/runs`, { recursive: true });
  await mkdir(`${opts.runsRoot}/tmp`, { recursive: true });

  const results: BenchmarkResult[] = [];
  for (const task of selected) {
    for (const adapter of chosen) {
      if (opts.limit !== undefined && results.length >= opts.limit) break;
      const { result } = await runOne(task, adapter, opts);
      results.push(result);
      reportPairResult(result);
    }
    if (opts.limit !== undefined && results.length >= opts.limit) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    const parsed = parseRunArgs(process.argv.slice(2));
    if ("help" in parsed) {
      console.log(RUN_HELP);
      process.exit(0);
    }
    console.log(`benchmark run: configs=[${parsed.configs.join(",")}] tasks=[${parsed.taskSelectors.join(",")}] runs=${parsed.runsRoot}`);
    const results = await runBenchmarks(parsed);
    const summary = aggregateResults(results, parsed.runsRoot);
    console.log("");
    console.log(formatSummary(summary, true));
    if (results.some((r) => !r.success)) process.exit(1);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    console.error(RUN_HELP);
    process.exit(2);
  }
}
