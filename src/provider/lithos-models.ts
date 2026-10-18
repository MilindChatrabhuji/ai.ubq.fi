import { getString, isRecord } from "../utils.ts";
import { readLithosApiKey } from "./lithos.ts";

export type LithosModel = Readonly<{ id: string; created: number }>;
export type LithosModelsSnapshot = Readonly<{ models: readonly LithosModel[]; updated_at_ms: number }>;

export const LITHOS_MODELS_URL = "https://api.lithosai.cloud/v1/models";
export const LITHOS_MODELS_CACHE_TTL_MS = 5 * 60_000;
const LITHOS_MODELS_FETCH_TIMEOUT_MS = 10_000;
const LITHOS_MODELS_FAILURE_BACKOFF_MS = 30_000;

let lithosModelsCache: LithosModelsSnapshot | null = null;
let lithosModelsFetchInFlight: Promise<LithosModelsSnapshot | null> | null = null;
let lithosModelsFetchGeneration = 0;
let lithosModelsCacheGeneration = 0;
let lithosModelsRetryAfterMs = 0;
const defaultLithosFetch = globalThis.fetch;

const listedLithosModels = (data: readonly unknown[]): LithosModel[] => {
  const models: LithosModel[] = [];
  const seen = new Set<string>();
  for (const value of data) {
    if (!isRecord(value)) continue;
    const id = getString(value.id)?.trim();
    if (!id || seen.has(id)) continue;
    const created = typeof value.created === "number" && Number.isSafeInteger(value.created) ? value.created : 0;
    seen.add(id);
    models.push({ id, created });
  }
  return models;
};

/**
 * Fetch the provider's current model list for alias resolution. The static
 * `LITHOS_MODEL_IDS` list remains the cold-start and failure fallback.
 */
export const fetchLithosModels = async (
  options: Readonly<{ fetcher?: typeof fetch; signal?: AbortSignal; force?: boolean; cachedOnly?: boolean }> = {}
): Promise<LithosModelsSnapshot | null> => {
  if (!options.force && lithosModelsCache && Date.now() - lithosModelsCache.updated_at_ms < LITHOS_MODELS_CACHE_TTL_MS) return lithosModelsCache;
  if (!options.force && Date.now() < lithosModelsRetryAfterMs) return lithosModelsCache;
  if (options.cachedOnly) return lithosModelsCache;
  const apiKey = readLithosApiKey();
  if (!apiKey) return lithosModelsCache;
  const fetcher = options.fetcher ?? (globalThis.fetch === defaultLithosFetch ? defaultLithosFetch : null);
  if (!fetcher) return lithosModelsCache;
  const shouldCoalesce = !options.force && options.fetcher === undefined && options.signal === undefined;
  if (shouldCoalesce && lithosModelsFetchInFlight) return await lithosModelsFetchInFlight;

  const requestGeneration = ++lithosModelsFetchGeneration;
  const request = (async (): Promise<LithosModelsSnapshot | null> => {
    const signal = AbortSignal.any([AbortSignal.timeout(LITHOS_MODELS_FETCH_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
    try {
      const response = await fetcher(LITHOS_MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal });
      if (!response.ok) {
        lithosModelsRetryAfterMs = Date.now() + LITHOS_MODELS_FAILURE_BACKOFF_MS;
        return lithosModelsCache;
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        lithosModelsRetryAfterMs = Date.now() + LITHOS_MODELS_FAILURE_BACKOFF_MS;
        return lithosModelsCache;
      }
      const models = listedLithosModels(payload.data);
      const snapshot = { models, updated_at_ms: Date.now() } satisfies LithosModelsSnapshot;
      if (requestGeneration > lithosModelsCacheGeneration) {
        lithosModelsCacheGeneration = requestGeneration;
        lithosModelsCache = snapshot;
        lithosModelsRetryAfterMs = 0;
      }
      return lithosModelsCache;
    } catch (error) {
      if (signal.aborted && options.signal?.aborted) throw error;
      lithosModelsRetryAfterMs = Date.now() + LITHOS_MODELS_FAILURE_BACKOFF_MS;
      return lithosModelsCache;
    }
  })();
  if (!shouldCoalesce) return await request;
  lithosModelsFetchInFlight = request;
  try {
    return await request;
  } finally {
    if (lithosModelsFetchInFlight === request) lithosModelsFetchInFlight = null;
  }
};

export const lithosModelsSnapshot = (): LithosModelsSnapshot | null => lithosModelsCache;
