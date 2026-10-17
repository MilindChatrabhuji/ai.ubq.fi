/**
 * Metric derivation from trajectory events and aggregation of result records.
 *
 * Derivation is deterministic and adapter-agnostic: it reads only the
 * recorded event stream. Aggregation produces the per-config and
 * per-task×config groups consumed by the summarize command and later reports.
 */

import { type BenchmarkResult, type BenchmarkSummary, type ConfigGroup, type RunMetrics, type TaskConfigGroup, type TrajectoryEvent } from "./schemas.ts";

/** Deterministic canonical form of tool arguments for duplicate detection. */
export function canonicalArgs(args: Record<string, unknown>): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort((a, b) => a.localeCompare(b))) {
        out[k] = sort((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(args));
}

type ToolCallEvent = Extract<TrajectoryEvent, { type: "tool_call" }>;
type ToolResultEvent = Extract<TrajectoryEvent, { type: "tool_result" }>;
type ModelRequestEvent = Extract<TrajectoryEvent, { type: "model_request" }>;

/**
 * Repeated calls: explicit flags plus consecutive identical calls whose
 * predecessor succeeded. Retries after failures count as recovery instead.
 */
function collectRepeatedIds(calls: ToolCallEvent[], results: Map<string, ToolResultEvent>): Set<string> {
  const repeated = new Set<string>();
  for (const c of calls) if (c.is_repeated) repeated.add(c.id);
  for (let i = 1; i < calls.length; i++) {
    if (repeated.has(calls[i].id)) continue;
    const prev = calls[i - 1];
    const cur = calls[i];
    const prevOk = results.get(prev.id)?.ok === true;
    if (prevOk && prev.tool === cur.tool && canonicalArgs(prev.arguments) === canonicalArgs(cur.arguments)) {
      repeated.add(cur.id);
    }
  }
  return repeated;
}

/** Recovery: a failed call id whose tool name later succeeds. */
function collectRecoveryIds(calls: ToolCallEvent[], results: Map<string, ToolResultEvent>): Set<string> {
  const recovery = new Set<string>();
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const result = results.get(c.id);
    if (result?.ok) continue;
    const later = calls.slice(i + 1).find((d) => d.tool === c.tool);
    const rel = later === undefined ? undefined : results.get(later.id);
    if (rel?.ok) recovery.add(c.id);
  }
  return recovery;
}

/** Derive run metrics from a complete event list. */
export function deriveMetrics(events: TrajectoryEvent[]): RunMetrics {
  const calls = events.filter((e): e is ToolCallEvent => e.type === "tool_call");
  const results = new Map(events.filter((e): e is ToolResultEvent => e.type === "tool_result").map((e) => [e.id, e]));
  const requests = events.filter((e): e is ModelRequestEvent => e.type === "model_request");

  const repeated = collectRepeatedIds(calls, results);
  const recovery = collectRecoveryIds(calls, results);

  const invalidResults = [...results.values()].filter((r) => !r.ok && r.error_code === "invalid_args").map((r) => r.id);
  const invalidIds = new Set([...calls.filter((c) => !c.valid).map((c) => c.id), ...invalidResults]);

  const contextSize = requests.reduce((m, r) => Math.max(m, r.input_tokens + r.output_tokens), 0);
  return {
    model_calls: requests.length,
    tool_calls: calls.length,
    invalid_tool_calls: invalidIds.size,
    wrong_tool_calls: calls.filter((c) => c.is_wrong_tool).length,
    repeated_calls: repeated.size,
    tool_errors: [...results.values()].filter((r) => !r.ok).length,
    recovery_attempts: recovery.size,
    input_tokens: requests.reduce((n, r) => n + r.input_tokens, 0),
    output_tokens: requests.reduce((n, r) => n + r.output_tokens, 0),
    context_size: contextSize,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

export function groupMetrics(results: BenchmarkResult[]): Omit<ConfigGroup, "config_id" | "task_count"> {
  const failures = results.filter((r) => !r.success);
  const failureClasses: Record<string, number> = {};
  for (const f of failures) {
    const key = f.failure_class ?? "unknown";
    failureClasses[key] = (failureClasses[key] ?? 0) + 1;
  }
  const summarize = (v: (r: BenchmarkResult) => number): { median: number; max: number } => {
    const values = results.map(v);
    return { median: median(values), max: values.length === 0 ? 0 : Math.max(...values) };
  };
  return {
    runs: results.length,
    successes: results.length - failures.length,
    failures: failures.length,
    success_rate: results.length === 0 ? 0 : (results.length - failures.length) / results.length,
    wall_time_ms: {
      median: median(results.map((r) => r.wall_time_ms)),
      p95: percentile(
        results.map((r) => r.wall_time_ms),
        0.95
      ),
    },
    tool_calls: summarize((r) => r.metrics.tool_calls),
    model_calls: summarize((r) => r.metrics.model_calls),
    total_tool_errors: results.reduce((n, r) => n + r.metrics.tool_errors, 0),
    total_recovery_attempts: results.reduce((n, r) => n + r.metrics.recovery_attempts, 0),
    total_invalid_tool_calls: results.reduce((n, r) => n + r.metrics.invalid_tool_calls, 0),
    total_repeated_calls: results.reduce((n, r) => n + r.metrics.repeated_calls, 0),
    total_input_tokens: results.reduce((n, r) => n + r.metrics.input_tokens, 0),
    total_output_tokens: results.reduce((n, r) => n + r.metrics.output_tokens, 0),
    failure_classes: failureClasses,
  };
}

/** Aggregate result records into per-config and per-task×config groups. */
export function aggregateResults(results: BenchmarkResult[], runsRoot: string): BenchmarkSummary {
  const byConfig = new Map<string, BenchmarkResult[]>();
  const byTaskConfig = new Map<string, BenchmarkResult[]>();
  for (const r of results) {
    byConfig.set(r.config_id, [...(byConfig.get(r.config_id) ?? []), r]);
    const key = `${r.task_id}\u0000${r.config_id}`;
    byTaskConfig.set(key, [...(byTaskConfig.get(key) ?? []), r]);
  }
  const configs: ConfigGroup[] = [...byConfig.entries()]
    .map(([configId, rs]) => ({
      config_id: configId,
      task_count: new Set(rs.map((r) => r.task_id)).size,
      ...groupMetrics(rs),
    }))
    .sort((a, b) => a.config_id.localeCompare(b.config_id));
  const taskConfigs: TaskConfigGroup[] = [...byTaskConfig.entries()]
    .map(([key, rs]) => {
      const [taskId, configId] = key.split("\u0000");
      return { task_id: taskId, config_id: configId, ...groupMetrics(rs) };
    })
    .sort((a, b) => (a.task_id + a.config_id).localeCompare(b.task_id + b.config_id));
  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    runs_root: runsRoot,
    run_count: results.length,
    success_count: results.filter((r) => r.success).length,
    failure_count: results.filter((r) => !r.success).length,
    success_rate: results.length === 0 ? 0 : results.filter((r) => r.success).length / results.length,
    by_config: configs,
    by_task_config: taskConfigs,
  };
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Human-readable table used by the summarize command and the runner tail. */
export function formatSummary(summary: BenchmarkSummary, verbose = false): string {
  const lines: string[] = [];
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  lines.push(`runs: ${summary.run_count}  success: ${summary.success_count} (${pct(summary.success_rate)})  failures: ${summary.failure_count}`);
  lines.push("");
  lines.push(
    pad("config", 10) +
      pad("tasks", 8) +
      pad("runs", 7) +
      pad("ok", 7) +
      pad("rate", 9) +
      pad("wall med", 11) +
      pad("wall p95", 11) +
      pad("tool med", 10) +
      pad("model med", 11) +
      pad("tool err", 9) +
      "failure classes"
  );
  for (const g of summary.by_config) {
    lines.push(
      pad(g.config_id, 10) +
        pad(String(g.task_count), 8) +
        pad(String(g.runs), 7) +
        pad(String(g.successes), 7) +
        pad(pct(g.success_rate), 9) +
        pad(`${g.wall_time_ms.median}ms`, 11) +
        pad(`${g.wall_time_ms.p95}ms`, 11) +
        pad(String(g.tool_calls.median), 10) +
        pad(String(g.model_calls.median), 11) +
        pad(String(g.total_tool_errors), 9) +
        Object.entries(g.failure_classes)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")
    );
  }
  if (verbose) {
    lines.push("", "per task × config:");
    lines.push(
      pad("task", 12) +
        pad("config", 10) +
        pad("runs", 7) +
        pad("ok", 7) +
        pad("rate", 9) +
        pad("wall med", 11) +
        pad("tool med", 10) +
        pad("tool err", 9) +
        "failure classes"
    );
    for (const g of summary.by_task_config) {
      lines.push(
        pad(g.task_id, 12) +
          pad(g.config_id, 10) +
          pad(String(g.runs), 7) +
          pad(String(g.successes), 7) +
          pad(pct(g.success_rate), 9) +
          pad(`${g.wall_time_ms.median}ms`, 11) +
          pad(String(g.tool_calls.median), 10) +
          pad(String(g.total_tool_errors), 9) +
          Object.entries(g.failure_classes)
            .map(([k, v]) => `${k}:${v}`)
            .join(" ")
      );
    }
  }
  return lines.join("\n");
}
