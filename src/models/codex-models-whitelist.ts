import type { Kv } from "#kv";
import { DEEPSEEK_WATERFALL_LEGACY_MODEL_ID, DEEPSEEK_WATERFALL_MODEL_ID } from "../deepseek/waterfall.ts";
import { getString, isRecord } from "../utils.ts";

// ── KV key ───────────────────────────────────────────────────────────────────

export const CODEX_MODELS_WHITELIST_KV_KEY = ["uos_ai", "codex_models_whitelist"] as const;

/** Preserve a saved pre-rename synthetic selection across the versionless rename. */
const canonicalWhitelistModelId = (id: string): string => (id === DEEPSEEK_WATERFALL_LEGACY_MODEL_ID ? DEEPSEEK_WATERFALL_MODEL_ID : id);

// ── Types ────────────────────────────────────────────────────────────────────

export type CodexModelsWhitelist = Readonly<{
  model_ids: readonly string[];
  updated_at_ms: number;
}>;

// ── Normalize / validate ─────────────────────────────────────────────────────

/**
 * Normalize a raw KV value into a valid `CodexModelsWhitelist`.
 * Returns `null` when the value is absent or cannot be read.
 */
export const normalizeCodexModelsWhitelist = (value: unknown): CodexModelsWhitelist | null => {
  if (!isRecord(value)) return null;
  const rawIds = value.model_ids;
  if (!Array.isArray(rawIds)) return null;
  const modelIds: string[] = [];
  for (const raw of rawIds) {
    const id = getString(raw);
    if (!id) return null;
    const trimmed = id.trim();
    if (!trimmed) return null;
    modelIds.push(canonicalWhitelistModelId(trimmed));
  }
  if (typeof value.updated_at_ms !== "number" || !Number.isSafeInteger(value.updated_at_ms) || value.updated_at_ms <= 0) return null;
  return { model_ids: modelIds, updated_at_ms: value.updated_at_ms };
};

// ── KV helpers ───────────────────────────────────────────────────────────────

/**
 * Canonical form of a submitted model-ID list: non-empty identifiers only, in
 * first-seen order, without duplicates. Storage and the wire response both use
 * this form so a re-save of an already-normalized selection is a no-op.
 */
export const normalizeWhitelistModelIds = (rawIds: readonly unknown[]): string[] => {
  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const id = getString(raw);
    if (!id) continue;
    const trimmed = id.trim();
    const modelId = canonicalWhitelistModelId(trimmed);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
};

/**
 * Load the whitelist from KV. Returns `null` when KV is unavailable or the value
 * is absent/invalid.
 */
export const loadCodexModelsWhitelist = async (kv: Kv | null): Promise<CodexModelsWhitelist | null> => {
  if (!kv) return null;
  const entry = await kv.get(CODEX_MODELS_WHITELIST_KV_KEY, { consistency: "strong" });
  return normalizeCodexModelsWhitelist(entry.value);
};

/**
 * Store a whitelist to KV.
 * `modelIds` is the list of model identifiers to allow. An empty list clears the filter.
 * Identifiers are trimmed and de-duplicated before they are persisted.
 */
export const storeCodexModelsWhitelist = async (kv: Kv, modelIds: readonly string[]): Promise<boolean> => {
  const whitelist: CodexModelsWhitelist = { model_ids: normalizeWhitelistModelIds(modelIds), updated_at_ms: Date.now() };
  const commit = await kv.set(CODEX_MODELS_WHITELIST_KV_KEY, whitelist);
  return commit.ok;
};

// ── Filter utilities ─────────────────────────────────────────────────────────

/**
 * Build a Set of whitelisted model identifiers for efficient lookup.
 * Returns `null` when the whitelist is empty or absent.
 */
const whitelistAsSet = (whitelist: CodexModelsWhitelist | null): Set<string> | null => {
  if (!whitelist || whitelist.model_ids.length === 0) return null;
  return new Set(whitelist.model_ids);
};

/**
 * Extract a model identifier from a raw catalog snapshot record (slug/id/model/name).
 * Returns `null` when no valid identifier is found.
 */
const modelIdFromRecord = (model: Record<string, unknown>): string | null => {
  const id = getString(model.slug) ?? getString(model.id) ?? getString(model.model) ?? getString(model.name);
  const trimmed = id?.trim();
  return trimmed ?? null;
};

/**
 * Filter a `Record<string, unknown>[]` (the model-object array format used by
 * `/v1/models`, `/uos/models/capabilities`, and catalog entries).
 * When the whitelist is empty/absent, returns the input unchanged.
 */
export const filterWhitelistedModelList = (models: readonly Record<string, unknown>[], whitelist: CodexModelsWhitelist | null): Record<string, unknown>[] => {
  const set = whitelistAsSet(whitelist);
  if (!set) return [...models];
  return models.filter((model) => {
    const id = getString(model.id);
    return id !== null && set.has(id);
  });
};

/**
 * Filter a catalog `parsed.models` array in the Codex catalog response format
 * (raw records with slug/id/model/name identifiers).
 * When the whitelist is empty/absent, returns the input unchanged.
 */
export const filterWhitelistedCatalogModels = (
  models: readonly Record<string, unknown>[],
  whitelist: CodexModelsWhitelist | null
): Record<string, unknown>[] => {
  const set = whitelistAsSet(whitelist);
  if (!set) return [...models];
  return models.filter((model) => {
    if (!isRecord(model)) return false;
    const id = modelIdFromRecord(model);
    return id !== null && set.has(id);
  });
};

/**
 * Filter a catalog-public model entries (entries with `id` field).
 * When the whitelist is empty/absent, returns the input unchanged.
 */
export const filterWhitelistedModelMap = <T extends { id: string }>(entries: readonly T[], whitelist: CodexModelsWhitelist | null): T[] => {
  const set = whitelistAsSet(whitelist);
  if (!set) return [...entries];
  return entries.filter((entry) => set.has(entry.id));
};
