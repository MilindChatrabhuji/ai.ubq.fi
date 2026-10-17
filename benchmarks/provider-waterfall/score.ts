import { readdir, readFile, writeFile } from "node:fs/promises";
// Normalization and overall scoring for the DeepSeek V4.1 Flash provider
// waterfall benchmark. Cost 50%, reliability 30%, speed 20%, each dimension
// normalized to 0-100 across the providers under comparison.

import { expectedCostMicroUsd } from "./cost.ts";
import { computeProviderMetrics, type ProviderMetrics } from "./metrics.ts";
import { BENCHMARK_PROVIDERS, type ProviderId } from "./providers.ts";
import type { AttemptRecord } from "./types.ts";

export type CostSummary = Readonly<{
  provider: ProviderId;
  priced: boolean;
  cost_source: string;
  actual_total_micro_usd: number | null;
  effective_cost_per_request_micro_usd: number | null;
  effective_cost_per_1m_output_micro_usd: number | null;
  priced_attempts: number;
  unpriced_attempts: number;
  observed_note: string | null;
}>;

export type ScoreRow = Readonly<{
  rank: number;
  provider: ProviderId;
  label: string;
  model: string;
  wire: string;
  samples: number;
  successful_items: number;
  first_attempt_success_rate: number;
  retry_recovery_rate: number | null;
  median_ttft_ms: number | null;
  p95_ttft_ms: number | null;
  p99_ttft_ms: number | null;
  median_tps: number | null;
  p95_tps: number | null;
  median_e2e_ms: number | null;
  p95_e2e_ms: number | null;
  p99_e2e_ms: number | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  cache_hit_ratio: number | null;
  actual_total_cost_micro_usd: number | null;
  effective_cost_per_request_micro_usd: number | null;
  effective_cost_per_1m_output_micro_usd: number | null;
  cost_score: number | null;
  speed_score: number | null;
  reliability_score: number;
  overall_score: number | null;
}>;

const normalizeLowerBetter = (values: readonly (number | null)[]): (number | null)[] => {
  const present = values.filter((value): value is number => value !== null);
  if (!present.length) return values.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  return values.map((value) => {
    if (value === null) return null;
    if (max - min < 1e-12) return 100;
    return ((max - value) / (max - min)) * 100;
  });
};

const normalizeHigherBetter = (values: readonly (number | null)[]): (number | null)[] => {
  const present = values.filter((value): value is number => value !== null);
  if (!present.length) return values.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  return values.map((value) => {
    if (value === null) return null;
    if (max - min < 1e-12) return 100;
    return ((value - min) / (max - min)) * 100;
  });
};

type ProviderCostTotals = Readonly<{ total: number; priced: number; unpriced: number; outputTokens: number; successful: number }>;

const providerCostTotals = (spec: (typeof BENCHMARK_PROVIDERS)[number], records: readonly AttemptRecord[]): ProviderCostTotals => {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  let outputTokens = 0;
  let successful = 0;
  for (const record of records) {
    if (record.provider !== spec.id || !record.success || !record.usage) continue;
    successful += 1;
    const cost = expectedCostMicroUsd(
      spec.id,
      {
        input_tokens: record.usage.input_tokens,
        cached_input_tokens: record.usage.cached_input_tokens,
        cache_write_input_tokens: record.usage.cache_write_input_tokens,
        output_tokens: record.usage.output_tokens,
      },
      Date.parse(record.started_at)
    );
    if (cost === null) {
      unpriced += 1;
      continue;
    }
    total += cost.total_micro_usd;
    priced += 1;
    outputTokens += record.usage.output_tokens;
  }
  return { total, priced, unpriced, outputTokens, successful };
};

export const summarizeCosts = (records: readonly AttemptRecord[]): readonly CostSummary[] => {
  const summaries: CostSummary[] = [];
  for (const spec of BENCHMARK_PROVIDERS) {
    const providerRecords = records.filter((record) => record.provider === spec.id);
    if (!providerRecords.length) continue;
    const { total, priced, unpriced, outputTokens, successful } = providerCostTotals(spec, records);
    const costKnown = priced > 0;
    summaries.push({
      provider: spec.id,
      priced: costKnown,
      cost_source: costKnown ? "published rate card (cost.ts RATE_CARD)" : "no bounded published rate",
      actual_total_micro_usd: costKnown ? Math.round(total) : null,
      effective_cost_per_request_micro_usd: costKnown && successful ? Math.round(total / successful) : null,
      effective_cost_per_1m_output_micro_usd: costKnown && outputTokens > 0 ? Math.round((total / outputTokens) * 1_000_000) : null,
      priced_attempts: priced,
      unpriced_attempts: unpriced,
      observed_note: null,
    });
  }
  return summaries;
};

export const scoreProviders = (metrics: readonly ProviderMetrics[], costs: readonly CostSummary[]): readonly ScoreRow[] => {
  const byId = new Map(metrics.map((row) => [row.provider, row]));
  const costById = new Map(costs.map((row) => [row.provider, row]));
  const specById = new Map(BENCHMARK_PROVIDERS.map((spec) => [spec.id, spec]));
  const providers = metrics.map((row) => row.provider as ProviderId);
  const costValues = providers.map((id) => costById.get(id)?.effective_cost_per_request_micro_usd ?? null);
  const e2eP50 = providers.map((id) => byId.get(id)?.median_e2e_ms ?? null);
  const e2eP95 = providers.map((id) => byId.get(id)?.p95_e2e_ms ?? null);
  const tps = providers.map((id) => byId.get(id)?.median_tps ?? null);
  const reliability = providers.map((id) => {
    const row = byId.get(id);
    if (!row?.samples) return 0;
    const itemRate = row.successful_items / row.samples;
    const combined = 0.6 * row.first_attempt_success_rate + 0.4 * itemRate;
    return combined * 100;
  });
  const costScores = normalizeLowerBetter(costValues);
  const e2eP50Scores = normalizeLowerBetter(e2eP50);
  const e2eP95Scores = normalizeLowerBetter(e2eP95);
  const tpsScores = normalizeHigherBetter(tps);
  const rows: ScoreRow[] = providers.map((id, index) => {
    const metric = byId.get(id) as ProviderMetrics;
    const spec = specById.get(id);
    const cost = costById.get(id);
    const speedParts = [e2eP50Scores[index], e2eP95Scores[index], tpsScores[index]];
    const speedScore = speedParts.every((value) => value === null)
      ? null
      : 0.5 * (e2eP50Scores[index] ?? 0) + 0.25 * (e2eP95Scores[index] ?? 0) + 0.25 * (tpsScores[index] ?? 0);
    const reliabilityScore = reliability[index];
    const costScore = costScores[index];
    const overall = costScore === null || speedScore === null ? null : 0.5 * costScore + 0.3 * reliabilityScore + 0.2 * speedScore;
    return {
      rank: 0,
      provider: id as ProviderId,
      label: spec?.label ?? id,
      model: metric.model,
      wire: metric.wire,
      samples: metric.samples,
      successful_items: metric.successful_items,
      first_attempt_success_rate: metric.first_attempt_success_rate,
      retry_recovery_rate: metric.retry_recovery_rate,
      median_ttft_ms: metric.median_ttft_ms,
      p95_ttft_ms: metric.p95_ttft_ms,
      p99_ttft_ms: metric.p99_ttft_ms,
      median_tps: metric.median_tps,
      p95_tps: metric.p95_tps,
      median_e2e_ms: metric.median_e2e_ms,
      p95_e2e_ms: metric.p95_e2e_ms,
      p99_e2e_ms: metric.p99_e2e_ms,
      input_tokens: metric.input_tokens,
      cached_input_tokens: metric.cached_input_tokens,
      cache_write_input_tokens: metric.cache_write_input_tokens,
      output_tokens: metric.output_tokens,
      cache_hit_ratio: metric.cache_hit_ratio,
      actual_total_cost_micro_usd: cost?.actual_total_micro_usd ?? null,
      effective_cost_per_request_micro_usd: cost?.effective_cost_per_request_micro_usd ?? null,
      effective_cost_per_1m_output_micro_usd: cost?.effective_cost_per_1m_output_micro_usd ?? null,
      cost_score: costScore,
      speed_score: speedScore,
      reliability_score: reliabilityScore,
      overall_score: overall,
    };
  });
  rows.sort((left, right) => (right.overall_score ?? -1) - (left.overall_score ?? -1));
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
};

const usd = (micro: number | null | undefined): string => (micro === null || micro === undefined ? "-" : `$${(micro / 1_000_000).toFixed(4)}`);
const ms = (value: number | null | undefined): string => (value === null || value === undefined ? "-" : value.toFixed(0));
const score = (value: number | null | undefined): string => (value === null || value === undefined ? "-" : value.toFixed(1));

export const renderComparisonTable = (rows: readonly ScoreRow[]): string => {
  const lines = [
    "| Rank | Provider | Effective cost | TTFT P50/P95 | TPS P50 | E2E P50/P95 | Success | Cache hit | Score |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.rank} | ${row.label} (${row.wire}) | ${usd(row.effective_cost_per_request_micro_usd)} | ${ms(row.median_ttft_ms)}/${ms(row.p95_ttft_ms)} ms | ` +
        `${row.median_tps?.toFixed(1) ?? "-"} tok/s | ${ms(row.median_e2e_ms)}/${ms(row.p95_e2e_ms)} ms | ` +
        `${(row.first_attempt_success_rate * 100).toFixed(1)}% | ${row.cache_hit_ratio === null ? "-" : (row.cache_hit_ratio * 100).toFixed(1) + "%"} | ` +
        `${score(row.overall_score)} |`
    );
  }
  return lines.join("\n");
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
    if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.startsWith("probe-")) files.push(`${dir}/${entry.name}`);
  }
  return files.sort((left, right) => left.localeCompare(right));
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.get("dir") ?? new URL("results/", import.meta.url).pathname;
  const period = args.get("period") ?? "w1-eve";
  const filesArg = args.get("files");
  const files = filesArg ? filesArg.split(",") : await listJsonl(dir);
  const records: AttemptRecord[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as AttemptRecord;
      if (record.period !== period) continue;
      records.push(record);
    }
  }
  const metrics = computeProviderMetrics(records);
  const costs = summarizeCosts(records);
  const rows = scoreProviders(metrics, costs);
  const out = args.get("out") ?? `${dir.replace(/\/$/, "")}/scores.json`;
  await writeFile(out, JSON.stringify({ generated_at: new Date().toISOString(), sources: files, costs, rows }, null, 1));
  await writeFile(out.replace(/\.json$/, ".md"), `${renderComparisonTable(rows)}\n`);
  console.log(renderComparisonTable(rows));
  console.log(`[score] wrote ${out}`);
}
