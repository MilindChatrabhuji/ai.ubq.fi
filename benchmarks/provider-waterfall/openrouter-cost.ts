import { readdir, readFile, writeFile } from "node:fs/promises";
// Reconciles OpenRouter's authoritative per-generation cost against the
// expected rate-card cost for every successful OpenRouter attempt that
// recorded a generation id. Metadata-only GETs; writes
// results/openrouter-observed-costs.json.

import { expectedCostMicroUsd } from "./cost.ts";
import type { AttemptRecord } from "./types.ts";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const readEnv = (name: string): string | null => {
  try {
    const value = process.env[name];
    return value?.trim() ? value : null;
  } catch {
    return null;
  }
};

const listJsonl = async (dir: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.startsWith("openrouter-")) files.push(`${dir}/${entry.name}`);
  }
  return files.sort((left, right) => left.localeCompare(right));
};

type GenerationLookup = Readonly<{ observedUsd: number | null; upstreamProvider: string | null; promptTokens: number; completionTokens: number }>;

const lookupGeneration = async (generationId: string, key: string): Promise<GenerationLookup> => {
  const empty: GenerationLookup = { observedUsd: null, upstreamProvider: null, promptTokens: 0, completionTokens: 0 };
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return empty;
    const body = (await response.json()) as unknown;
    if (!isRecord(body) || !isRecord(body.data)) return empty;
    const data = body.data;
    const total = data.total_cost;
    const promptTokens = typeof data.tokens_prompt === "number" ? data.tokens_prompt : 0;
    const completionTokens = typeof data.tokens_completion === "number" ? data.tokens_completion : 0;
    // Observed 2026-10-06: these responses-wire generations stay at
    // tokens_prompt/completion = 0 and total_cost = 0 on the public
    // generation endpoint even long after completion, so observed billing is
    // unavailable and catalogue pricing is used instead.
    const observedUsd = typeof total === "number" && Number.isFinite(total) && (promptTokens > 0 || completionTokens > 0) ? total : null;
    return {
      observedUsd,
      upstreamProvider: typeof data.provider_name === "string" ? data.provider_name : null,
      promptTokens,
      completionTokens,
    };
  } catch {
    return empty;
  }
};

const reconcileRecord = async (record: AttemptRecord, usage: NonNullable<AttemptRecord["usage"]>, responseId: string, key: string): Promise<Json> => {
  const expected = expectedCostMicroUsd(
    "openrouter",
    {
      input_tokens: usage.input_tokens,
      cached_input_tokens: usage.cached_input_tokens,
      cache_write_input_tokens: usage.cache_write_input_tokens,
      output_tokens: usage.output_tokens,
    },
    Date.parse(record.started_at)
  );
  const lookup = await lookupGeneration(responseId, key);
  return {
    run_id: record.run_id,
    corpus_id: record.corpus_id,
    generation_id: responseId,
    upstream_provider: lookup.upstreamProvider,
    generation_tokens_prompt: lookup.promptTokens,
    generation_tokens_completion: lookup.completionTokens,
    expected_micro_usd: expected?.total_micro_usd ?? null,
    observed_micro_usd: lookup.observedUsd === null ? null : Math.round(lookup.observedUsd * 1_000_000),
    output_tokens: usage.output_tokens,
    input_tokens: usage.input_tokens,
  };
};

const main = async (): Promise<void> => {
  const key = readEnv("OPENROUTER_API_KEY") ?? "";
  const dir = new URL("results/", import.meta.url).pathname;
  const files = await listJsonl(dir);
  const rows: Json[] = [];
  let reconciled = 0;
  let missingId = 0;
  let unavailable = 0;
  const reconcileFile = async (file: string): Promise<Readonly<{ reconciled: number; missing: number; unavailable: number }>> => {
    const counts = { reconciled: 0, missing: 0, unavailable: 0 };
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as AttemptRecord;
      if (!record.success || !record.usage) continue;
      const responseId = record.response_id;
      if (!responseId) {
        counts.missing += 1;
        continue;
      }
      const row = await reconcileRecord(record, record.usage, responseId, key);
      rows.push(row);
      if (row.observed_micro_usd === null) counts.unavailable += 1;
      else counts.reconciled += 1;
    }
    return counts;
  };
  for (const file of files) {
    const counts = await reconcileFile(file);
    reconciled += counts.reconciled;
    missingId += counts.missing;
    unavailable += counts.unavailable;
  }
  await writeFile(
    `${dir}openrouter-observed-costs.json`,
    JSON.stringify({ generated_at: new Date().toISOString(), reconciled, missing_id: missingId, unavailable, rows }, null, 1)
  );
  console.log(`[openrouter-cost] reconciled=${reconciled} missing_id=${missingId} unavailable=${unavailable} rows=${rows.length}`);
};

if (import.meta.main) await main();
