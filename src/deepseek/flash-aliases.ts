// Resolution of each provider's latest DeepSeek Flash alias.
//
// The gateway never puts a release number or snapshot date into the synthetic
// model identity. At request time it prefers an explicit `~...latest` alias when
// a provider publishes one; otherwise it finds the newest DeepSeek Flash entry
// in that provider's catalogue and uses its undated base id, which the provider
// keeps on the latest weights. Every provider stays in the hop plan; the static
// aliases below are cold-start fallbacks only.

import { fetchMeteredModels, meteredModelsSnapshot, readMeteredApiKey } from "../provider/metered.ts";
import { fetchLithosModels, lithosModelsSnapshot } from "../provider/lithos-models.ts";
import { LITHOS_MODEL_IDS, readLithosApiKey } from "../provider/lithos.ts";
import { fetchSurplusModels, readSurplusApiKey, surplusModelsSnapshot } from "../provider/surplus.ts";
import { fetchOpenRouterModels, openRouterModelsSnapshot } from "../models/openrouter-models.ts";

export type DeepSeekFlashProvider = "lithos" | "deepseek" | "openrouter" | "surplus" | "openlux";

export type DeepSeekFlashAliases = Readonly<{
  models: Readonly<Record<DeepSeekFlashProvider, string>>;
}>;

export const DEEPSEEK_FLASH_FALLBACK_ALIASES: DeepSeekFlashAliases = {
  models: {
    lithos: "deepseek-ai/DeepSeek-V4.1-Flash",
    deepseek: "deepseek-flash",
    openrouter: "~deepseek/deepseek-flash-latest",
    surplus: "deepseek-v4.1-flash",
    openlux: "deepseek-v4.1-flash",
  },
};

type CatalogModel = Readonly<{ id: string }>;

export type DeepSeekFlashCatalogInput = Readonly<{
  lithos?: readonly CatalogModel[] | null;
  openrouter?: readonly CatalogModel[] | null;
  surplus?: readonly CatalogModel[] | null;
  openlux?: readonly CatalogModel[] | null;
}>;

type FlashCandidate = Readonly<{
  id: string;
  version: string;
  dateOrder: number;
  baseId: string;
}>;

const FLASH_ID_PATTERN = /^deepseek-v(\d+(?:\.\d+)?)-flash(?:-(\d{4}|\d{8}))?$/;
const VARIANT_MARKER_PATTERN = /(?:^|[-:])(?:fast|ultra|chat|vision|exp|web|e2ee|free|batch)(?:$|[-:])/;
const LATEST_ALIAS_PATTERN = /(?:^|[/-])deepseek(?:-v[\d.]+)?-flash-latest$/;

const dateOrder = (date: string | null): number => {
  if (!date) return 0;
  const year = date.length === 8 ? Number(date.slice(0, 4)) : new Date().getUTCFullYear();
  const month = Number(date.length === 8 ? date.slice(4, 6) : date.slice(0, 2));
  const day = Number(date.length === 8 ? date.slice(6, 8) : date.slice(2, 4));
  if (!Number.isSafeInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return 0;
  return year * 10000 + month * 100 + day;
};

const candidateFrom = (model: CatalogModel): FlashCandidate | null => {
  const trimmed = model.id.trim();
  const lower = trimmed.toLowerCase();
  if (!lower || VARIANT_MARKER_PATTERN.test(lower)) return null;
  const slug = lower.slice(lower.lastIndexOf("/") + 1);
  const match = FLASH_ID_PATTERN.exec(slug);
  if (!match) return null;
  const date = match.at(2) ?? null;
  const order = dateOrder(date);
  if (date && order === 0) return null;
  const prefix = trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
  return { id: trimmed, version: match.at(1) ?? "", dateOrder: order, baseId: `${prefix}${slug.replace(/-\d{4,8}$/, "")}` };
};

const versionParts = (version: string): readonly number[] => version.split(".").map((part) => Number(part) || 0);

const compareCandidates = (left: FlashCandidate, right: FlashCandidate): number => {
  const a = versionParts(left.version);
  const b = versionParts(right.version);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.dateOrder - right.dateOrder;
};

const latestAliasFor = (models: readonly CatalogModel[]): string | null => {
  const aliases = models
    .map((model) => model.id.trim())
    .filter((id) => id.startsWith("~") && LATEST_ALIAS_PATTERN.test(id.toLowerCase()))
    .sort((left, right) => {
      const leftUnversioned = /^~\w+\/deepseek-flash-latest$/i.test(left);
      const rightUnversioned = /^~\w+\/deepseek-flash-latest$/i.test(right);
      if (leftUnversioned !== rightUnversioned) return leftUnversioned ? -1 : 1;
      return left.localeCompare(right);
    });
  return aliases[0] ?? null;
};

const providerAliasFrom = (models: readonly CatalogModel[]): string | null => {
  const latest = latestAliasFor(models);
  if (latest) return latest;
  let newest: FlashCandidate | null = null;
  let baseAlias: string | null = null;
  for (const model of models) {
    const candidate = candidateFrom(model);
    if (!candidate) continue;
    if (newest === null || compareCandidates(candidate, newest) > 0) newest = candidate;
  }
  if (newest === null) return null;
  for (const model of models) {
    const candidate = candidateFrom(model);
    if (candidate?.version !== newest.version) continue;
    // Prefer an undated base id in the same version family; it is the alias the
    // provider keeps current. Fall back to the newest dated id when none exists.
    if (candidate.dateOrder === 0) baseAlias = candidate.id;
  }
  return baseAlias ?? newest.id;
};

/**
 * Resolve every provider's latest Flash alias. Provider catalogues may be absent
 * or partial; the cold-start alias remains in that case. No provider is removed.
 */
export const resolveDeepSeekFlashAliases = (input: DeepSeekFlashCatalogInput = {}): DeepSeekFlashAliases => {
  const fallback = DEEPSEEK_FLASH_FALLBACK_ALIASES.models;
  const lithosModels = input.lithos ?? lithosModelsSnapshot()?.models ?? LITHOS_MODEL_IDS.map((id) => ({ id }));
  return {
    models: {
      lithos: providerAliasFrom(lithosModels) ?? fallback.lithos,
      deepseek: "deepseek-flash",
      openrouter: providerAliasFrom(input.openrouter ?? []) ?? fallback.openrouter,
      surplus: providerAliasFrom(input.surplus ?? []) ?? fallback.surplus,
      openlux: providerAliasFrom(input.openlux ?? []) ?? fallback.openlux,
    },
  };
};

let currentAliasesCache: Readonly<{ signature: string; aliases: DeepSeekFlashAliases }> | null = null;

/** The current aliases from cached catalogues. Reads never wait on a refresh. */
export const currentDeepSeekFlashAliases = (): DeepSeekFlashAliases => {
  const lithos = lithosModelsSnapshot();
  const openrouter = openRouterModelsSnapshot();
  const surplus = surplusModelsSnapshot();
  const openlux = meteredModelsSnapshot();
  const signature = `${lithos?.updated_at_ms ?? 0}:${openrouter?.updated_at_ms ?? 0}:${surplus?.updated_at_ms ?? 0}:${openlux?.updated_at_ms ?? 0}`;
  if (currentAliasesCache?.signature === signature) return currentAliasesCache.aliases;
  const aliases = resolveDeepSeekFlashAliases({
    lithos: lithos?.models,
    openrouter: openrouter?.models,
    surplus: surplus?.models,
    openlux: openlux?.models,
  });
  currentAliasesCache = { signature, aliases };
  return aliases;
};

/** Start catalogue refreshes without waiting. */
export const warmDeepSeekFlashCatalogs = (): void => {
  void fetchOpenRouterModels().catch(() => {});
  if (readLithosApiKey()) void fetchLithosModels().catch(() => {});
  if (readSurplusApiKey()) void fetchSurplusModels().catch(() => {});
  if (readMeteredApiKey()) void fetchMeteredModels().catch(() => {});
};

/** Whether an id is one of the paid catalogue's DeepSeek Flash aliases. */
export const isDeepSeekFlashPaidModel = (model: string): boolean => {
  const trimmed = model.trim().toLowerCase();
  const slug = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return /^deepseek-v\d+(?:\.\d+)?-flash(?:-\d{4}|\d{8})?$/.test(slug);
};
