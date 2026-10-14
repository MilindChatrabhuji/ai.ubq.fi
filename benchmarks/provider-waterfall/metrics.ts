import { readFile, readdir, writeFile } from "node:fs/promises";
// Metric derivation for the DeepSeek V4.1 Flash provider waterfall benchmark.
//
// Aggregation unit: one (provider, corpus entry) item. Every attempt is a row;
// first-attempt success, retry recovery, speed, usage and cost come from the
// item's attempts, and the failure taxonomy counts classified failures.

import type { AttemptRecord, CorpusClass } from "./types.ts";

export type FailureCounts = Readonly<Record<string, number>>;

export type ProviderMetrics = Readonly<{
  provider: string;
  wire: string;
  model: string;
  samples: number;
  successful_items: number;
  first_attempt_successes: number;
  first_attempt_success_rate: number;
  retried_items: number;
  retry_recoveries: number;
  retry_recovery_rate: number | null;
  attempts_total: number;
  failures_total: number;
  failures: FailureCounts;
  median_ttft_ms: number | null;
  p90_ttft_ms: number | null;
  p95_ttft_ms: number | null;
  p99_ttft_ms: number | null;
  median_tps: number | null;
  p90_tps: number | null;
  p95_tps: number | null;
  median_e2e_ms: number | null;
  p90_e2e_ms: number | null;
  p95_e2e_ms: number | null;
  p99_e2e_ms: number | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_hit_ratio: number | null;
  usage_coverage: number;
  per_class: Readonly<Record<CorpusClass, { samples: number; successes: number }>>;
  by_wire: Readonly<Record<string, number>>;
}>;

export const percentile = (values: readonly number[], fraction: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};

const isSuccess = (record: AttemptRecord): boolean => record.success;

const itemKey = (record: AttemptRecord): string => `${record.provider}::${record.corpus_id}`;

type Accumulator = {
  classes: Record<CorpusClass, { samples: number; successes: number }>;
  failures: Record<string, number>;
  ttfts: number[];
  tpsValues: number[];
  e2eValues: number[];
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
  };
  successfulItems: number;
  firstAttemptSuccesses: number;
  retriedItems: number;
  retryRecoveries: number;
  usageRows: number;
  byWire: Record<string, number>;
  attempts: AttemptRecord[];
};

const emptyAccumulator = (): Accumulator => ({
  classes: {
    small: { samples: 0, successes: 0 },
    medium: { samples: 0, successes: 0 },
    large: { samples: 0, successes: 0 },
    xlarge: { samples: 0, successes: 0 },
  },
  failures: {},
  ttfts: [],
  tpsValues: [],
  e2eValues: [],
  usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 },
  successfulItems: 0,
  firstAttemptSuccesses: 0,
  retriedItems: 0,
  retryRecoveries: 0,
  usageRows: 0,
  byWire: {},
  attempts: [],
});

const applySuccess = (successful: AttemptRecord, acc: Accumulator, cls: CorpusClass): void => {
  acc.successfulItems += 1;
  acc.classes[cls].successes += 1;
  if (successful.first_attempt) acc.firstAttemptSuccesses += 1;
  const firstOutput = successful.t_first_output_ms;
  const end = successful.t_end_ms;
  if (firstOutput !== null) acc.ttfts.push(firstOutput);
  if (firstOutput !== null && end !== null && successful.usage && end > firstOutput) {
    acc.tpsValues.push((successful.usage.output_tokens / (end - firstOutput)) * 1000);
  }
  if (end !== null) acc.e2eValues.push(end);
  if (!successful.usage) return;
  acc.usageRows += 1;
  acc.usage.input_tokens += successful.usage.input_tokens;
  acc.usage.cached_input_tokens += successful.usage.cached_input_tokens;
  acc.usage.cache_write_input_tokens += successful.usage.cache_write_input_tokens;
  acc.usage.output_tokens += successful.usage.output_tokens;
  acc.usage.reasoning_tokens += successful.usage.reasoning_tokens;
  acc.usage.total_tokens += successful.usage.total_tokens;
};

const applyItem = (attempts: readonly AttemptRecord[], acc: Accumulator): void => {
  const ordered = [...attempts].sort((left, right) => left.attempt - right.attempt);
  const first = ordered[0];
  acc.attempts.push(...ordered);
  for (const attempt of ordered) {
    if (!attempt.success && attempt.failure_kind) acc.failures[attempt.failure_kind] = (acc.failures[attempt.failure_kind] ?? 0) + 1;
    acc.byWire[attempt.wire] = (acc.byWire[attempt.wire] ?? 0) + 1;
  }
  acc.classes[first.cls].samples += 1;
  const successful = ordered.find(isSuccess) ?? null;
  if (successful) applySuccess(successful, acc, first.cls);
  if (ordered.length > 1) {
    acc.retriedItems += 1;
    if (!first.success && successful) acc.retryRecoveries += 1;
  }
};

const groupBy = <T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const list = groups.get(key(value)) ?? [];
    list.push(value);
    groups.set(key(value), list);
  }
  return groups;
};

const providerRow = (provider: string, providerRecords: readonly AttemptRecord[], acc: Accumulator): ProviderMetrics => {
  const retryOffered = acc.retriedItems;
  const samples = acc.classes.small.samples + acc.classes.medium.samples + acc.classes.large.samples + acc.classes.xlarge.samples;
  return {
    provider,
    wire: providerRecords[0]?.wire ?? "unknown",
    model: providerRecords[0]?.model ?? "unknown",
    samples,
    successful_items: acc.successfulItems,
    first_attempt_successes: acc.firstAttemptSuccesses,
    first_attempt_success_rate: samples ? acc.firstAttemptSuccesses / samples : 0,
    retried_items: retryOffered,
    retry_recoveries: acc.retryRecoveries,
    retry_recovery_rate: retryOffered ? acc.retryRecoveries / retryOffered : null,
    attempts_total: acc.attempts.length,
    failures_total: acc.attempts.filter((record) => !record.success).length,
    failures: acc.failures,
    median_ttft_ms: percentile(acc.ttfts, 0.5),
    p90_ttft_ms: percentile(acc.ttfts, 0.9),
    p95_ttft_ms: percentile(acc.ttfts, 0.95),
    p99_ttft_ms: percentile(acc.ttfts, 0.99),
    median_tps: percentile(acc.tpsValues, 0.5),
    p90_tps: percentile(acc.tpsValues, 0.9),
    p95_tps: percentile(acc.tpsValues, 0.95),
    median_e2e_ms: percentile(acc.e2eValues, 0.5),
    p90_e2e_ms: percentile(acc.e2eValues, 0.9),
    p95_e2e_ms: percentile(acc.e2eValues, 0.95),
    p99_e2e_ms: percentile(acc.e2eValues, 0.99),
    input_tokens: acc.usage.input_tokens,
    cached_input_tokens: acc.usage.cached_input_tokens,
    cache_write_input_tokens: acc.usage.cache_write_input_tokens,
    output_tokens: acc.usage.output_tokens,
    reasoning_tokens: acc.usage.reasoning_tokens,
    cache_hit_ratio: acc.usage.input_tokens > 0 ? acc.usage.cached_input_tokens / acc.usage.input_tokens : null,
    usage_coverage: acc.successfulItems ? acc.usageRows / acc.successfulItems : 0,
    per_class: acc.classes,
    by_wire: acc.byWire,
  };
};

export const computeProviderMetrics = (records: readonly AttemptRecord[]): readonly ProviderMetrics[] => {
  const byProvider = groupBy(records, (record) => record.provider);
  const rows: ProviderMetrics[] = [];
  for (const [provider, providerRecords] of byProvider) {
    const acc = emptyAccumulator();
    for (const attempts of groupBy(providerRecords, itemKey).values()) applyItem(attempts, acc);
    rows.push(providerRow(provider, providerRecords, acc));
  }
  return rows.sort((left, right) => left.provider.localeCompare(right.provider));
};

export const loadRunRecords = async (paths: readonly string[]): Promise<readonly AttemptRecord[]> => {
  const records: AttemptRecord[] = [];
  for (const path of paths) {
    const text = await readFile(path, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line) as AttemptRecord);
    }
  }
  return records;
};

const parseArgs = (args: readonly string[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(arg);
    if (match) {
      const value: string | undefined = match[2] as string | undefined;
      map.set(match[1].toLowerCase(), value ?? "true");
    }
  }
  return map;
};

const listJsonl = async (dir: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(`${dir}/${entry.name}`);
  }
  return files.sort((left, right) => left.localeCompare(right));
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.get("dir") ?? new URL("results/", import.meta.url).pathname;
  const filesArg = args.get("files");
  const paths = filesArg ? filesArg.split(",") : await listJsonl(dir);
  const all = await loadRunRecords(paths);
  const period = args.get("period") ?? "w1-eve";
  const records = args.get("all") === "true" ? all : all.filter((record) => record.period === period);
  const metrics = computeProviderMetrics(records);
  const out = args.get("out") ?? `${dir.replace(/\/$/, "")}/metrics.json`;
  await writeFile(out, JSON.stringify({ generated_at: new Date().toISOString(), sources: paths, providers: metrics }, null, 1));
  for (const row of metrics) {
    console.log(
      `${row.provider.padEnd(11)} n=${row.samples} ok=${row.successful_items} first=${row.first_attempt_success_rate.toFixed(3)} ` +
        `e2e_p50=${row.median_e2e_ms?.toFixed(0) ?? "-"} e2e_p95=${row.p95_e2e_ms?.toFixed(0) ?? "-"} ` +
        `ttft_p50=${row.median_ttft_ms?.toFixed(0) ?? "-"} tps_p50=${row.median_tps?.toFixed(1) ?? "-"} cache=${row.cache_hit_ratio?.toFixed(3) ?? "-"}`
    );
  }
  console.log(`[metrics] wrote ${out}`);
}
