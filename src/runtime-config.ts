import type { Kv } from "#kv";
import {
  type CodexModelsSnapshot,
  compactPromptCacheCapabilities,
  getCodexModelsSnapshotDefaultModel,
  type RuntimePromptCacheCapabilities,
} from "./models/codex-models.ts";
import { DEFAULT_REASONING_EFFORT, normalizeReasoningEffort, type ReasoningEffort } from "./defaults.ts";
import { getKv } from "./kv.ts";
import { getString, isRecord } from "./utils.ts";

export const RUNTIME_CONFIG_V2_KEY = ["uos_ai", "runtime_config", "v2"] as const;
export const RUNTIME_CONFIG_CACHE_TTL_MS = 5 * 60_000;
export const RUNTIME_CONFIG_MAX_BYTES = 4_096;

export type RuntimeCodexModel = Readonly<{
  slug: string;
  default_reasoning_level?: ReasoningEffort;
  supported_reasoning_levels: ReasoningEffort[];
  reasoning_effort_wire_map?: Readonly<Record<string, ReasoningEffort>>;
  prompt_cache?: RuntimePromptCacheCapabilities;
}>;

export type RuntimeCodexModelsSnapshot = Readonly<{
  models: RuntimeCodexModel[];
  source: string;
  updated_at_ms: number;
  client_version?: string | null;
}>;

export type RuntimeConfigV2 = Readonly<{
  version: 2;
  default_model: string;
  default_reasoning_effort: ReasoningEffort;
  codex_models: RuntimeCodexModelsSnapshot;
  updated_at_ms: number;
}>;

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

let cachedRuntimeConfig: Readonly<{ value: RuntimeConfigV2; expires_at_ms: number }> | null = null;
let runtimeConfigLoadInFlight: Promise<RuntimeConfigV2 | null> | null = null;

const serializedSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

const reasoningLevel = (value: unknown): ReasoningEffort | null => {
  if (value === null) return "none";
  if (typeof value === "string") return normalizeReasoningEffort(value);
  if (!isRecord(value)) return null;
  return value.effort === null ? "none" : normalizeReasoningEffort(value.effort);
};

const compactReasoningLevels = (model: Record<string, unknown>): ReasoningEffort[] => {
  // Verbatim advertised tiers only: a null entry is the upstream's own `none`, and
  // no tier is added because the endpoint rejects an effort its catalog omits.
  const levels = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.map(reasoningLevel).filter((value): value is ReasoningEffort => value !== null)
    : [];
  return Array.from(new Set(levels));
};

const compactReasoningWireMap = (model: Record<string, unknown>, levels: readonly ReasoningEffort[]): Readonly<Record<string, ReasoningEffort>> | undefined => {
  const entries = new Map<string, ReasoningEffort>();
  if (isRecord(model.reasoning_effort_wire_map)) {
    for (const [effortRaw, wireRaw] of Object.entries(model.reasoning_effort_wire_map)) {
      const effort = normalizeReasoningEffort(effortRaw);
      const wireEffort = normalizeReasoningEffort(wireRaw);
      if (effort && wireEffort) entries.set(effort, wireEffort);
    }
  }
  if (levels.includes("ultra")) entries.set("ultra", "max");
  return entries.size ? Object.fromEntries(entries) : undefined;
};

const compactRuntimeCodexModel = (value: Record<string, unknown>): RuntimeCodexModel | null => {
  const slug = (getString(value.slug) ?? getString(value.id) ?? getString(value.model) ?? getString(value.name))?.trim();
  if (!slug) return null;
  const supportedReasoningLevels = compactReasoningLevels(value);
  const defaultReasoningLevel = reasoningLevel(value.default_reasoning_level);
  if (defaultReasoningLevel && !supportedReasoningLevels.includes(defaultReasoningLevel)) {
    supportedReasoningLevels.push(defaultReasoningLevel);
  }
  const wireMap = compactReasoningWireMap(value, supportedReasoningLevels);
  const promptCache = compactPromptCacheCapabilities(value.prompt_cache);
  return {
    slug,
    ...(defaultReasoningLevel ? { default_reasoning_level: defaultReasoningLevel } : {}),
    supported_reasoning_levels: supportedReasoningLevels,
    ...(wireMap ? { reasoning_effort_wire_map: wireMap } : {}),
    ...(promptCache !== null ? { prompt_cache: promptCache } : {}),
  };
};

const compactRuntimeCodexModelEntries = (values: readonly unknown[]): RuntimeCodexModel[] => {
  const models: RuntimeCodexModel[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isRecord(value)) continue;
    const model = compactRuntimeCodexModel(value);
    if (model === null || seen.has(model.slug)) continue;
    models.push(model);
    seen.add(model.slug);
  }
  return models;
};

const withRuntimeCodexModelsMeta = (snapshot: CodexModelsSnapshot, models: RuntimeCodexModel[]): RuntimeCodexModelsSnapshot => {
  const source = getString(snapshot.source)?.trim();
  const updatedAtMs = typeof snapshot.updated_at_ms === "number" && Number.isFinite(snapshot.updated_at_ms) ? Math.trunc(snapshot.updated_at_ms) : 0;
  const clientVersion = getString(snapshot.client_version)?.trim();
  if (!source || updatedAtMs <= 0) {
    throw new RuntimeConfigError("runtime config requires valid Codex catalog metadata");
  }
  return {
    models,
    source,
    updated_at_ms: updatedAtMs,
    ...(clientVersion ? { client_version: clientVersion } : {}),
  };
};

/**
 * Compacts one Codex model catalog snapshot. `snapshot` is deliberately typed
 * as possibly nullish: callers hand it values read from KV or casts (for
 * example `codexModels.value as never` in kv_migration.ts), so the runtime
 * guard below still has to reject a missing snapshot with this module's error
 * rather than a property access TypeError.
 */
export const compactRuntimeCodexModels = (snapshot: CodexModelsSnapshot | null | undefined): RuntimeCodexModelsSnapshot => {
  if (!snapshot || !Array.isArray(snapshot.models)) {
    throw new RuntimeConfigError("runtime config requires a non-empty Codex model catalog");
  }
  const models = compactRuntimeCodexModelEntries(snapshot.models);
  if (!models.length) throw new RuntimeConfigError("runtime config requires a non-empty Codex model catalog");
  return withRuntimeCodexModelsMeta(snapshot, models);
};

const enforceRuntimeConfigSize = (config: RuntimeConfigV2): RuntimeConfigV2 => {
  const bytes = serializedSize(config);
  if (bytes > RUNTIME_CONFIG_MAX_BYTES) {
    throw new RuntimeConfigError(`runtime config is too large (${bytes} bytes; maximum ${RUNTIME_CONFIG_MAX_BYTES} bytes)`);
  }
  return config;
};

export const normalizeRuntimeConfig = (value: unknown): RuntimeConfigV2 | null => {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.codex_models)) return null;
  try {
    const snapshot = compactRuntimeCodexModels(value.codex_models as CodexModelsSnapshot);
    const defaultModel = typeof value.default_model === "string" ? value.default_model.trim() : "";
    const defaultReasoning = normalizeReasoningEffort(value.default_reasoning_effort);
    const updatedAtMs = typeof value.updated_at_ms === "number" && Number.isFinite(value.updated_at_ms) ? Math.trunc(value.updated_at_ms) : 0;
    if (!defaultModel || !defaultReasoning || updatedAtMs <= 0) return null;
    if (!snapshot.models.some((model) => model.slug === defaultModel)) return null;
    return enforceRuntimeConfigSize({
      version: 2,
      default_model: defaultModel,
      default_reasoning_effort: defaultReasoning,
      codex_models: snapshot,
      updated_at_ms: updatedAtMs,
    });
  } catch {
    return null;
  }
};

export const buildRuntimeConfig = (
  fullSnapshot: CodexModelsSnapshot,
  options: Readonly<{ defaultModel?: string | null; defaultReasoningEffort?: string | null; nowMs?: number }> = {}
): RuntimeConfigV2 => {
  const snapshot = compactRuntimeCodexModels(fullSnapshot);
  const requestedDefaultModel = options.defaultModel?.trim();
  // An absent (or whitespace-only) request falls back to the catalog default.
  const defaultModel =
    requestedDefaultModel === undefined || requestedDefaultModel === "" ? getCodexModelsSnapshotDefaultModel(snapshot) : requestedDefaultModel;
  if (!defaultModel) throw new RuntimeConfigError("runtime config requires a default model");
  if (!snapshot.models.some((model) => model.slug === defaultModel)) {
    throw new RuntimeConfigError(`runtime config default model is absent from the catalog: ${defaultModel}`);
  }
  return enforceRuntimeConfigSize({
    version: 2,
    default_model: defaultModel,
    default_reasoning_effort: normalizeReasoningEffort(options.defaultReasoningEffort) ?? DEFAULT_REASONING_EFFORT,
    codex_models: snapshot,
    updated_at_ms: options.nowMs ?? Date.now(),
  });
};

export const loadRuntimeConfig = async (kvOverride?: Kv | null, nowMs = Date.now()): Promise<RuntimeConfigV2 | null> => {
  if (cachedRuntimeConfig && cachedRuntimeConfig.expires_at_ms > nowMs) return cachedRuntimeConfig.value;
  if (runtimeConfigLoadInFlight) return await runtimeConfigLoadInFlight;
  const stale = cachedRuntimeConfig?.value ?? null;
  runtimeConfigLoadInFlight = (async () => {
    try {
      const kv = kvOverride === undefined ? await getKv() : kvOverride;
      if (!kv) {
        if (stale) cachedRuntimeConfig = { value: stale, expires_at_ms: nowMs + RUNTIME_CONFIG_CACHE_TTL_MS };
        return stale;
      }
      const entry = await kv.get<RuntimeConfigV2>(RUNTIME_CONFIG_V2_KEY, { consistency: "strong" });
      const value = normalizeRuntimeConfig(entry.value) ?? stale;
      if (value) cachedRuntimeConfig = { value, expires_at_ms: nowMs + RUNTIME_CONFIG_CACHE_TTL_MS };
      return value;
    } catch (error) {
      console.warn("[ai.ubq.fi] Runtime configuration refresh failed; using stale configuration:", error);
      if (stale) cachedRuntimeConfig = { value: stale, expires_at_ms: nowMs + RUNTIME_CONFIG_CACHE_TTL_MS };
      return stale;
    } finally {
      runtimeConfigLoadInFlight = null;
    }
  })();
  return await runtimeConfigLoadInFlight;
};

export const cacheRuntimeConfig = (config: RuntimeConfigV2, nowMs = Date.now()): void => {
  const normalized = normalizeRuntimeConfig(config);
  if (!normalized) throw new RuntimeConfigError("runtime config is invalid or exceeds one 4 KiB read unit");
  cachedRuntimeConfig = { value: normalized, expires_at_ms: nowMs + RUNTIME_CONFIG_CACHE_TTL_MS };
};

export const resetRuntimeConfigCacheForTest = (): void => {
  cachedRuntimeConfig = null;
  runtimeConfigLoadInFlight = null;
};
