import { readFile, writeFile } from "node:fs/promises";
// Emits the objective's machine-readable per-provider rows from the measured
// artifacts: metrics.json (full-corpus window), scores.json (normalized
// scores), the concurrency probe rows and the OpenRouter reconciliation.

import { MICROCREDITS_PER_CREDIT, observedCostSource, RATE_CARD_VERSION } from "./cost.ts";
import { percentile, type ProviderMetrics } from "./metrics.ts";
import { BENCHMARK_PROVIDERS } from "./providers.ts";
import type { AttemptRecord } from "./types.ts";

type Json = Record<string, unknown>;

const OBSERVED_BILLING_SOURCE: Readonly<Record<string, string>> = {
  surplus: "gateway paid ledger spend_microcredits (settled; matches the rate card within 5 micro-USD over 35 requests)",
  openlux: "gateway paid ledger quota settlement (authoritative; ~0.45x the catalogue-ratio expectation, unreconciled conversion)",
  openrouter: "OpenRouter generation endpoint returned zeroed usage/cost for these generations; expected cost only",
  deepseek: "official published rate card (exact for this provider); the full-corpus run was in a peak window",
  lithos: "vendor pricing page (bounded, early-access rates); no observed billing surface",
};
const observedBillingSource = (provider: string): string => OBSERVED_BILLING_SOURCE[provider] ?? "unknown";

const dir = new URL("results/", import.meta.url).pathname;
const readJson = async (name: string): Promise<Json> => JSON.parse(await readFile(`${dir}${name}`, "utf8")) as Json;
const readRows = async (names: readonly string[]): Promise<AttemptRecord[]> => {
  const rows: AttemptRecord[] = [];
  for (const name of names) {
    for (const line of (await readFile(`${dir}${name}`, "utf8")).split("\n")) {
      if (line.trim()) rows.push(JSON.parse(line) as AttemptRecord);
    }
  }
  return rows;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const metricsFile = await readJson("metrics.json");
const scoresFile = await readJson("scores.json");
const metrics = asArray(metricsFile.providers) as ProviderMetrics[];
const scores = asArray(scoresFile.rows) as Json[];
const costs = asArray(scoresFile.costs) as Json[];
const metricById = new Map(metrics.map((row) => [row.provider, row]));
const scoreById = new Map(scores.map((row) => [row.provider as string, row]));
const costById = new Map(costs.map((row) => [row.provider as string, row]));

const probeNames = BENCHMARK_PROVIDERS.map((spec) => `${spec.id}-probe-concurrency-w1-b0.jsonl`);
const probeRows = await readRows(probeNames);
const probeIds = ["corpus-small-03", "corpus-medium-03", "corpus-medium-07", "corpus-large-03"];
const mainNames = BENCHMARK_PROVIDERS.map((spec) => `${spec.id}-w1-eve-b1.jsonl`).concat(BENCHMARK_PROVIDERS.map((spec) => `${spec.id}-w1-eve-b2.jsonl`));
const mainRows = await readRows(mainNames);

const exclusionNotes: Record<string, string> = {
  openlux:
    "Excluded from the subagent waterfall: the model record advertises only /v1/chat/completions, so the gateway cannot select OpenLux for the /v1/responses wire subagent traffic uses. Its chat-wire measurement is recorded.",
  surplus:
    "Included only after the operator funded the account mid-benchmark (402 insufficient USDC balance before funding); upstream serving path is not exposed, so failure independence is unknown.",
};

const rows = BENCHMARK_PROVIDERS.map((spec) => {
  const metric = metricById.get(spec.id);
  const score = scoreById.get(spec.id);
  const cost = costById.get(spec.id);
  const probe = probeRows.filter((row) => row.provider === spec.id && row.success);
  const baseline = mainRows.filter((row) => row.provider === spec.id && row.success && probeIds.includes(row.corpus_id));
  const probeE2e = probe.map((row) => row.t_end_ms ?? 0).filter((value) => value > 0);
  const baseE2e = baseline.map((row) => row.t_end_ms ?? 0).filter((value) => value > 0);
  const probeMedian = percentile(probeE2e, 0.5);
  const baseMedian = percentile(baseE2e, 0.5);
  const perEntryRatios = baseline
    .map((row) => {
      const match = probe.find((candidate) => candidate.corpus_id === row.corpus_id);
      if (!match?.t_end_ms || !row.t_end_ms) return null;
      return match.t_end_ms / row.t_end_ms;
    })
    .filter((value): value is number => value !== null);
  const meanRatio = perEntryRatios.length ? perEntryRatios.reduce((total, value) => total + value, 0) / perEntryRatios.length : null;
  const maxRatio = perEntryRatios.length ? Math.max(...perEntryRatios) : null;
  const input = metric?.input_tokens ?? 0;
  const cached = metric?.cached_input_tokens ?? 0;
  return {
    provider: spec.id,
    label: spec.label,
    model: spec.model,
    wire: spec.wire,
    sample_count: metric?.samples ?? 0,
    successful_requests: metric?.successful_items ?? 0,
    first_attempt_success_rate: metric?.first_attempt_success_rate ?? 0,
    retry_recovery_rate: metric?.retry_recovery_rate ?? null,
    median_ttft_ms: metric?.median_ttft_ms ?? null,
    p90_ttft_ms: metric?.p90_ttft_ms ?? null,
    p95_ttft_ms: metric?.p95_ttft_ms ?? null,
    p99_ttft_ms: metric?.p99_ttft_ms ?? null,
    median_tps: metric?.median_tps ?? null,
    p95_tps: metric?.p95_tps ?? null,
    median_e2e_ms: metric?.median_e2e_ms ?? null,
    p95_e2e_ms: metric?.p95_e2e_ms ?? null,
    p99_e2e_ms: metric?.p99_e2e_ms ?? null,
    cold_input_tokens: input - cached,
    cached_input_tokens: cached,
    cache_write_input_tokens: metric?.cache_write_input_tokens ?? 0,
    output_tokens: metric?.output_tokens ?? 0,
    cache_hit_ratio: metric?.cache_hit_ratio ?? null,
    actual_total_cost_micro_usd: cost?.actual_total_micro_usd ?? null,
    effective_cost_per_request_micro_usd: cost?.effective_cost_per_request_micro_usd ?? null,
    effective_cost_per_1m_output_micro_usd: cost?.effective_cost_per_1m_output_micro_usd ?? null,
    rate_card_version: RATE_CARD_VERSION,
    observed_cost_source: observedCostSource(spec.id).fields,
    effective_cost_per_request_usd:
      typeof cost?.effective_cost_per_request_micro_usd === "number" ? cost.effective_cost_per_request_micro_usd / MICROCREDITS_PER_CREDIT : null,
    observed_billing_source: observedBillingSource(spec.id),
    concurrency_probe: {
      requests: probe.length,
      successes: probe.length,
      median_e2e_ms: probeMedian,
      median_e2e_ms_concurrency_1: baseMedian,
      mean_per_entry_ratio: meanRatio,
      max_per_entry_ratio: maxRatio,
    },
    cost_score: score?.cost_score ?? null,
    speed_score: score?.speed_score ?? null,
    reliability_score: score?.reliability_score ?? null,
    overall_score: score?.overall_score ?? null,
    rank: score?.rank ?? null,
    wire_compatible_with_subagent_responses: spec.wire === "responses",
    qualification_notes: exclusionNotes[spec.id] ?? null,
  };
});

const out = {
  generated_at: new Date().toISOString(),
  corpus_sha256: "6aa1248dac25135f6fe2dfe8444f33f8f357d369940d296cd692b68ba1cdb288",
  gateway_release: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698",
  providers: rows,
  recommended_waterfall: ["openrouter", "lithos", "deepseek", "surplus"],
  excluded: [
    {
      provider: "openlux",
      reason: "Cannot serve the /v1/responses wire for deepseek-v4.1-flash (chat-only model record); measured on the chat wire only.",
    },
  ],
  pre_funding_excluded_probes:
    "Surplus 402 insufficient_balance probes before the operator funded the account are retained as probe rows and excluded from scoring.",
};
await writeFile(`${dir}provider-rows.json`, JSON.stringify(out, null, 1));
console.log(`[provider-rows] wrote ${dir}provider-rows.json (${rows.length} providers)`);
