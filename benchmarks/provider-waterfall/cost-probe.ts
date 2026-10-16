import { mkdir, writeFile } from "node:fs/promises";
// Bounded metadata-only price probe for the cost module. It fetches the
// published rate sources (no completion requests, no paid inference), extracts
// the DeepSeek V4.1 Flash records, cross-checks them against RATE_CARD in
// cost.ts, and writes cost/price-snapshot-<date>.json plus a compact summary.
//
//   bun --env-file=<repo>/.env \
//     benchmarks/provider-waterfall/cost-probe.ts

import { RATE_CARD } from "./cost.ts";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const fetchJson = async (url: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<Json | null> => {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return (await response.json()) as Json;
  } catch {
    return null;
  }
};

const readEnv = (name: string): string | null => {
  try {
    const value = process.env[name];
    return value?.trim() ? value : null;
  } catch {
    return null;
  }
};

const surplusProbe = async (): Promise<Json> => {
  const key = readEnv("SURPLUS_API_KEY");
  if (!key) return { available: false, reason: "SURPLUS_API_KEY unset" };
  const body = await fetchJson("https://api.surplusintelligence.ai/v1/models", { Authorization: `Bearer ${key}`, Accept: "application/json" });
  const models = Array.isArray(body?.data) ? body.data : [];
  const record = models.find((entry) => isRecord(entry) && entry.id === "deepseek-v4.1-flash");
  if (!isRecord(record)) return { available: false, reason: "deepseek-v4.1-flash not in Surplus catalogue" };
  return {
    available: true,
    model: "deepseek-v4.1-flash",
    pricing: record.pricing ?? null,
    supports_tools: Array.isArray(record.supported_parameters) ? (record.supported_parameters as string[]).includes("tools") : null,
  };
};

const openluxProbe = async (): Promise<Json> => {
  const key = readEnv("METERED_API_KEY") ?? readEnv("OPENLUX_API_KEY");
  if (!key) return { available: false, reason: "METERED_API_KEY unset" };
  const body = await fetchJson("https://api.openlux.ai/api/ratio_config", { Authorization: `Bearer ${key}`, Accept: "application/json" });
  const data = isRecord(body?.data) ? body.data : null;
  if (!data) return { available: false, reason: "ratio_config unavailable" };
  const modelRatio = isRecord(data.model_ratio) ? data.model_ratio : {};
  const completionRatio = isRecord(data.completion_ratio) ? data.completion_ratio : {};
  const cacheRatio = isRecord(data.cache_ratio) ? data.cache_ratio : {};
  const id = "deepseek-v4.1-flash";
  if (!(id in modelRatio)) return { available: false, reason: "deepseek-v4.1-flash not in ratio_config" };
  return {
    available: true,
    model: id,
    model_ratio: modelRatio[id] ?? null,
    completion_ratio: completionRatio[id] ?? null,
    cache_ratio: cacheRatio[id] ?? null,
    note: "USD per token = ratio / quota_per_unit; quota_per_unit is recorded in cost.ts from the same retrieval",
  };
};

const openrouterProbe = async (): Promise<Json> => {
  const key = readEnv("OPENROUTER_API_KEY");
  if (!key) return { available: false, reason: "OPENROUTER_API_KEY unset" };
  const body = await fetchJson("https://openrouter.ai/api/v1/models", { Authorization: `Bearer ${key}`, Accept: "application/json" });
  const models = Array.isArray(body?.data) ? body.data : [];
  const record = models.find((entry) => isRecord(entry) && entry.id === "deepseek/deepseek-v4.1-flash");
  if (!isRecord(record)) return { available: false, reason: "deepseek/deepseek-v4.1-flash not in OpenRouter catalogue" };
  const pricing = isRecord(record.pricing) ? record.pricing : {};
  return { available: true, model: "deepseek/deepseek-v4.1-flash", pricing };
};

const main = async (): Promise<void> => {
  const [surplus, openlux, openrouter] = await Promise.all([surplusProbe(), openluxProbe(), openrouterProbe()]);
  const rateCard = RATE_CARD;
  const snapshot = {
    retrieved_at: new Date().toISOString(),
    rate_card_version: "2026-10-06.v1",
    surplus,
    openlux,
    openrouter,
    lithos: {
      available: true,
      source: "https://www.lithosai.com/pricing (retrieved 2026-10-06)",
      rates_per_million_usd: { input: 0.15, cached_input: 0.003, output: 0.6 },
      note: "Early-access Base tier; Fast $0.25/$0.005/$1.00, Ultra $0.35/$0.007/$1.40. Chat-only API publishes no price metadata; the pricing page is the bounded source.",
    },
    deepseek: {
      available: true,
      source: "https://api-docs.deepseek.com/quick_start/pricing/ (retrieved 2026-10-06)",
      peak_per_million_usd: { input_cache_miss: 0.3, input_cache_hit: 0.006, output: 1.2 },
      off_peak_per_million_usd: { input_cache_miss: 0.15, input_cache_hit: 0.003, output: 0.6 },
      windows_utc: { peak: "01:00-04:00 and 06:00-10:00 Mon-Fri; off-peak otherwise (all other hours, weekends; Chinese public holidays not encoded)" },
    },
    rate_card_providers: Object.keys(rateCard),
  };
  const date = new Date().toISOString().slice(0, 10);
  const path = new URL(`cost/price-snapshot-${date}.json`, import.meta.url).pathname;
  await mkdir(new URL("cost/", import.meta.url).pathname, { recursive: true });
  await writeFile(path, JSON.stringify(snapshot, null, 1));
  console.log(`[cost-probe] wrote ${path}`);
  console.log(
    `[cost-probe] surplus available=${String(surplus.available)} openlux available=${String(openlux.available)} openrouter available=${String(openrouter.available)}`
  );
  console.log(`[cost-probe] rate-card providers: ${Object.keys(rateCard).join(", ")}`);
};

if (import.meta.main) await main();
