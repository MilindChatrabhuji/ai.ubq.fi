// Model catalog assembly and the public model endpoints, extracted from src/openai.ts.

import { type CodexModelsSnapshot, loadCodexModelsSnapshot, loadFullCodexModelsSnapshot } from "../codex/index.ts";
import { CEREBRAS_MODELS, readCerebrasApiKey } from "../provider/cerebras.ts";
import {
  DEEPSEEK_CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_DEFAULT_REASONING_EFFORT,
  DEEPSEEK_OFFICIAL_MODEL_IDS,
  DEEPSEEK_REASONING_LEVELS,
  readDeepSeekApiKey,
} from "../deepseek/index.ts";
import { LITHOS_MODEL_IDS, readLithosApiKey } from "../provider/lithos.ts";
import { getCatalogClientVersion, handleCodexCatalogModels } from "../catalog/index.ts";
import { loadCodexModelsWhitelist, filterWhitelistedModelList, filterWhitelistedModelMap } from "./codex-models-whitelist.ts";
import {
  filterCatalogEntriesByProviderSelection,
  isProviderEnabled,
  loadProviderSelectionCached,
  type ProviderSelection,
  SELECTABLE_PROVIDER_IDS,
} from "../provider/selection.ts";
import { json } from "../http.ts";
import { getKv } from "../kv.ts";
import {
  codexSnapshotMetadataHint,
  codexSubscriptionMetadataHint,
  resolveModelMetadata,
  type ModelMetadataHint,
  type ModelMetadataSource,
  type ModelMetadataSources,
} from "./metadata.ts";
import { warmOpenRouterModels, openRouterModelsSnapshot } from "./openrouter-models.ts";
import { getString, isRecord } from "../utils.ts";
import { fetchMeteredModels } from "../provider/metered.ts";
import { fetchSurplusModels } from "../provider/surplus.ts";
import { fetchClaudeCodeModels, claudeCodeReasoningLevels, type ClaudeCodeModel } from "../provider/claude-code-models.ts";
import { resolveClaudeCodeCredential } from "../provider/claude-code-credentials.ts";
import { readOpenRouterApiKey } from "../provider/openrouter.ts";
import { cerebrasProviderHint, LITHOS_PROVIDER_HINT, modelIdFromSnapshotRecord } from "../request-policy.ts";
import {
  configuredCerebrasModelCapabilities,
  configuredOpenRouterModelCapabilities,
  configuredOpenRouterModels,
  normalizeModelCapabilitiesEntry,
  normalizeModelList,
  withConfiguredCerebrasModel,
  withConfiguredDeepSeekCapabilities,
  withConfiguredDeepSeekModels,
  withConfiguredDeepSeekWaterfallCapabilities,
  withConfiguredDeepSeekWaterfallModels,
  withConfiguredLithosCapabilities,
  withConfiguredLithosModels,
  OPENROUTER_SERVED_MODEL_ID,
} from "../input-normalization.ts";
import {
  DEEPSEEK_WATERFALL_CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_WATERFALL_CREATED,
  DEEPSEEK_WATERFALL_DEFAULT_REASONING_LEVEL,
  DEEPSEEK_WATERFALL_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  DEEPSEEK_WATERFALL_MODEL_ID,
  DEEPSEEK_WATERFALL_ORDER,
  DEEPSEEK_WATERFALL_REASONING_LEVELS,
  deepSeekWaterfallCatalogEnabled,
  deepSeekWaterfallProviderConfigured,
} from "../deepseek/waterfall.ts";

const snapshotUpstreamSource = (snapshot: CodexModelsSnapshot | null): string => {
  const source = snapshot?.source;
  if (!source) return "stored_codex_models";
  return source;
};

const enabledClaudeCatalog = (selection: ProviderSelection | null) =>
  isProviderEnabled("claude_code", selection) ? fetchClaudeCodeModels() : Promise.resolve(null);
const appendClaudeModels = (models: Record<string, unknown>[], claude: readonly ClaudeCodeModel[]): void => {
  const seen = new Set(models.map((model) => model.id));
  for (const model of claude) {
    if (!seen.has(model.id)) models.push({ id: model.id, object: "model", created: model.created, owned_by: "anthropic" });
  }
};

const claudeCapabilities = (models: readonly ClaudeCodeModel[]): Record<string, unknown>[] =>
  models.map((model) => ({
    id: model.id,
    object: "uos.model_capabilities",
    owned_by: "anthropic",
    display_name: model.display_name ?? model.id,
    upstream_provider: "claude_code",
    supported_endpoints: ["/v1/responses", "/v1/chat/completions"],
    supported_reasoning_levels: claudeCodeReasoningLevels(model),
    ...(model.supports_disabled_thinking === true ? { default_reasoning_effort: "none" } : {}),
    context_window_tokens: model.context_window_tokens ?? null,
    context_source: model.context_window_tokens ? "provider_discovery" : "unknown",
    reasoning_source: claudeCodeReasoningLevels(model).length ? "provider_discovery" : "unknown",
    max_output_tokens: model.max_output_tokens ?? null,
    upstream_capabilities: { image_input: model.supports_image_input ?? null, pdf_input: model.supports_pdf_input ?? null },
  }));

export const handleModels = async (req?: Request): Promise<Response> => {
  if (req) {
    const clientVersion = getCatalogClientVersion(req);
    if (clientVersion !== null) return await handleCodexCatalogModels(req, clientVersion);
  }
  // A switched-off provider is not advertised, so its rows leave this list even
  // while the discovery snapshots still hold them.
  // Start the OpenRouter catalogue refresh without waiting: the first request
  // after a cold start may still miss its rows, and the next one has them.
  warmOpenRouterModels();
  const selection = await loadProviderSelectionCached();
  const snapshot = await loadCodexModelsSnapshot();
  const normalized = snapshot && Array.isArray(snapshot.models) && snapshot.models.length > 0 ? normalizeModelList(snapshot) : null;
  const codexModels = isProviderEnabled("codex", selection) ? (normalized?.data ?? []) : [];
  const providerModels = withConfiguredDeepSeekWaterfallModels(
    withConfiguredLithosModels(
      withConfiguredDeepSeekModels(
        withConfiguredCerebrasModel(codexModels, isProviderEnabled("cerebras", selection)),
        isProviderEnabled("deepseek", selection)
      ),
      isProviderEnabled("lithos", selection)
    ),
    deepSeekWaterfallCatalogEnabled(selection)
  );
  const [metered, surplus, claude] = await Promise.all([
    isProviderEnabled("openlux", selection) ? fetchMeteredModels() : Promise.resolve(null),
    isProviderEnabled("surplus", selection) ? fetchSurplusModels() : Promise.resolve(null),
    enabledClaudeCatalog(selection),
  ]);
  const merged = [...providerModels];
  appendClaudeModels(merged, claude?.models ?? []);
  for (const model of [...(metered?.models ?? []), ...(surplus?.models ?? [])]) {
    if (!model.supported_endpoint_types.some((type) => type === "openai" || type === "openai-response")) continue;
    if (merged.some((candidate) => candidate.id === model.id)) continue;
    merged.push({
      id: model.id,
      object: "model",
      created: model.created,
      owned_by: model.owned_by,
    });
  }

  const modelsKv = await getKv();
  const whitelist = modelsKv ? await loadCodexModelsWhitelist(modelsKv) : null;
  const filtered = filterWhitelistedModelList(merged, whitelist);
  // OpenRouter's served catalogue is the upstream's own and refreshes on its
  // own TTL, so its rows stay advertised whenever the provider is on: a new
  // upstream model lists without an operator re-save. The operator whitelist
  // keeps curating every gateway-hosted id above.
  const openRouterModels = isProviderEnabled("openrouter", selection) ? configuredOpenRouterModels() : [];
  const listedIds = new Set(filtered.map((model) => getString(model.id) ?? ""));
  const data = [...filtered, ...openRouterModels.filter((model) => !listedIds.has(getString(model.id) ?? ""))];

  return json(200, { object: "list", data }, { "x-uos-upstream": snapshotUpstreamSource(snapshot) });
};

type PublicModelProvider = Readonly<{
  id: "codex" | "claude_code" | "openlux" | "surplus" | "deepseek" | "cerebras" | "lithos" | "openrouter" | "ubiquity";
  owned_by: string;
  supported_endpoints: readonly string[];
}>;

export type PublicModelCatalogEntry = {
  id: string;
  providers: PublicModelProvider[];
  created?: number;
  context_window_tokens?: number;
  max_context_window_tokens?: number;
  auto_compact_token_limit_tokens?: number;
  effective_context_window_percent?: number;
  /**
   * The reasoning tiers this model accepts, from the same resolver the
   * capabilities endpoint uses. Absent means no source advertises any tier.
   */
  supported_reasoning_levels?: readonly string[];
  default_reasoning_effort?: string;
  /** Where the context numbers came from: `codex_upload`, `provider_discovery`, `openrouter`, or `unknown`. */
  context_source?: ModelMetadataSource;
  /** Where the reasoning tiers came from, in the same vocabulary. */
  reasoning_source?: ModelMetadataSource;
};

/**
 * What each credential-gated route declares about its own model. These are the
 * route's statements, not curated per-model knowledge, so both the catalog and
 * the capabilities endpoint read them from here.
 */
const DEEPSEEK_PROVIDER_HINT: ModelMetadataHint = {
  context_window_tokens: DEEPSEEK_CONTEXT_WINDOW_TOKENS,
  max_context_window_tokens: DEEPSEEK_CONTEXT_WINDOW_TOKENS,
  supported_reasoning_levels: [...DEEPSEEK_REASONING_LEVELS],
  default_reasoning_effort: DEEPSEEK_DEFAULT_REASONING_EFFORT,
};

const providerSupportedEndpointPaths = (supportedEndpointTypes: readonly string[]): string[] => [
  ...(supportedEndpointTypes.includes("openai-response") ? ["/v1/responses"] : []),
  ...(supportedEndpointTypes.includes("openai") ? ["/v1/chat/completions"] : []),
];

const catalogAvailabilityStatus = (available: unknown): "available" | "unavailable" => (available ? "available" : "unavailable");

/**
 * One catalog row for one model id. Metadata comes from `resolveModelMetadata`,
 * so a row carries a value only when a source actually published one, and it
 * names that source. Ids no source describes stay bare instead of inheriting a
 * curated guess.
 */
const publicModelCatalogEntry = (id: string, provider: PublicModelProvider, created: unknown, sources: ModelMetadataSources = {}): PublicModelCatalogEntry => {
  const resolved = resolveModelMetadata(id, sources);
  const createdSeconds = typeof created === "number" && Number.isSafeInteger(created) && created > 0 ? created : null;
  return {
    id,
    providers: [provider],
    ...(createdSeconds === null ? {} : { created: createdSeconds }),
    ...(resolved.context_window_tokens === null ? {} : { context_window_tokens: resolved.context_window_tokens }),
    ...(resolved.max_context_window_tokens === null ? {} : { max_context_window_tokens: resolved.max_context_window_tokens }),
    ...(resolved.auto_compact_token_limit_tokens === null ? {} : { auto_compact_token_limit_tokens: resolved.auto_compact_token_limit_tokens }),
    ...(resolved.effective_context_window_percent === null ? {} : { effective_context_window_percent: resolved.effective_context_window_percent }),
    ...(resolved.supported_reasoning_levels === null ? {} : { supported_reasoning_levels: resolved.supported_reasoning_levels }),
    ...(resolved.default_reasoning_effort === null ? {} : { default_reasoning_effort: resolved.default_reasoning_effort }),
    context_source: resolved.context_source,
    reasoning_source: resolved.reasoning_source,
  };
};

const mergeProviderMetadata = (entry: PublicModelCatalogEntry, id: string, sources: ModelMetadataSources): void => {
  // A provider declaration describes this gateway route, not another serving of
  // the same weights. Do not let a cached enrichment entry win when the
  // declaration arrives after a paid discovery row.
  const resolved = resolveModelMetadata(id, { ...sources, openRouter: null });
  const hasContext = resolved.context_window_tokens !== null || resolved.max_context_window_tokens !== null;
  if (resolved.context_window_tokens !== null) entry.context_window_tokens = resolved.context_window_tokens;
  if (resolved.max_context_window_tokens !== null) entry.max_context_window_tokens = resolved.max_context_window_tokens;
  if (resolved.auto_compact_token_limit_tokens !== null) entry.auto_compact_token_limit_tokens = resolved.auto_compact_token_limit_tokens;
  if (resolved.effective_context_window_percent !== null) entry.effective_context_window_percent = resolved.effective_context_window_percent;
  if (hasContext) entry.context_source = resolved.context_source;
  if (resolved.supported_reasoning_levels !== null) entry.supported_reasoning_levels = resolved.supported_reasoning_levels;
  if (resolved.default_reasoning_effort !== null) entry.default_reasoning_effort = resolved.default_reasoning_effort;
  if (resolved.supported_reasoning_levels !== null || resolved.default_reasoning_effort !== null) entry.reasoning_source = resolved.reasoning_source;
};

const addPublicModelCatalogEntry = (
  models: Map<string, PublicModelCatalogEntry>,
  id: string,
  provider: PublicModelProvider,
  created: unknown = null,
  sources: ModelMetadataSources = {}
): void => {
  const existing = models.get(id);
  if (existing) {
    existing.providers.push(provider);
    if (existing.created === undefined && typeof created === "number" && Number.isSafeInteger(created) && created > 0) {
      existing.created = created;
    }
    if (sources.provider) mergeProviderMetadata(existing, id, sources);
    return;
  }
  models.set(id, publicModelCatalogEntry(id, provider, created, sources));
};

/** Raw uploaded records by id, so the catalog can read metadata `normalizeModelList` drops. */
const collectCodexSnapshotRecords = (snapshot: CodexModelsSnapshot | null): Map<string, Record<string, unknown>> => {
  const records = new Map<string, Record<string, unknown>>();
  if (!snapshot || !Array.isArray(snapshot.models)) return records;
  for (const entry of snapshot.models) {
    if (!isRecord(entry)) continue;
    const id = modelIdFromSnapshotRecord(entry);
    if (id) records.set(id, entry);
  }
  return records;
};

export type ModelCatalogSourceId = "codex" | "claude_code" | "openlux" | "surplus" | "deepseek" | "cerebras" | "lithos" | "openrouter";

export type ModelCatalogSource = Readonly<{
  status: "available" | "unavailable";
  count: number;
  updated_at_ms: number | null;
  /**
   * Present only for credential-gated providers, which are served from a
   * configured API key instead of discovery. `false` means the gateway does not
   * serve that provider at all, which is not the same as a failed discovery.
   */
  configured?: boolean;
  /** Set when the operator switched this provider off in the admin console. */
  disabled?: boolean;
  /** The same credential's last good discovery remains visible after a failed refresh. */
  stale?: boolean;
}>;

export type ModelCatalogSnapshot = Readonly<{
  models: PublicModelCatalogEntry[];
  sources: Readonly<Record<ModelCatalogSourceId, ModelCatalogSource>>;
}>;

/** A credential-gated provider is configured or it is absent; it has no upstream timestamp. */
const credentialGatedCatalogSource = (configured: boolean, count: number): ModelCatalogSource => ({
  status: configured ? "available" : "unavailable",
  count: configured ? count : 0,
  updated_at_ms: null,
  configured,
});

/**
 * Every provider's models are listed, each attributed to every provider that
 * publishes it. Nothing is filtered or re-attributed here: the operator's
 * whitelist selection is the only thing that decides what the gateway
 * advertises, so an id this route can serve must stay selectable.
 */
const addCredentialGatedCatalogProviders = (models: Map<string, PublicModelCatalogEntry>): { deepseek: number; cerebras: number; lithos: number } => {
  let deepseek = 0;
  if (readDeepSeekApiKey()) {
    const provider: PublicModelProvider = {
      id: "deepseek",
      owned_by: "deepseek",
      supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
    };
    for (const id of DEEPSEEK_OFFICIAL_MODEL_IDS) {
      // Both official ids are one served model behind two aliases, and the route
      // declares its window and tiers so the row matches what the capabilities
      // endpoint reports for the same id.
      addPublicModelCatalogEntry(models, id, provider, null, { provider: DEEPSEEK_PROVIDER_HINT });
      deepseek += 1;
    }
  }
  let cerebras = 0;
  if (readCerebrasApiKey()) {
    const provider: PublicModelProvider = { id: "cerebras", owned_by: "cerebras", supported_endpoints: ["/v1/chat/completions"] };
    for (const id of CEREBRAS_MODELS) {
      addPublicModelCatalogEntry(models, id, provider, null, { provider: cerebrasProviderHint(id) });
      cerebras += 1;
    }
  }
  let lithos = 0;
  if (readLithosApiKey()) {
    // Eight ids, each individually addressable: the three per-model speed tiers
    // (`-fast`, `-ultra`, `-ultra-chat`) are the same weights at higher per-token
    // rates, so they are commercial tiers of one model rather than one model
    // behind an alias. The catalog and capabilities schemas have no speed-tier
    // field, and collapsing the ids would make a client-requestable model
    // unselectable, so the tier stays in the id and the display name.
    const provider: PublicModelProvider = {
      id: "lithos",
      owned_by: "lithos",
      // Chat Completions is the vendor's own endpoint; `/v1/responses` is served
      // by this gateway's translation, exactly as the DeepSeek adapter's rows
      // declare it.
      supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
    };
    for (const id of LITHOS_MODEL_IDS) {
      addPublicModelCatalogEntry(models, id, provider, null, { provider: LITHOS_PROVIDER_HINT });
      lithos += 1;
    }
  }
  return { deepseek, cerebras, lithos };
};

/**
 * Build the complete catalog without applying the operator whitelist.
 * `/uos/models/catalog` filters this snapshot for the public page, while the
 * admin console reads it unfiltered so a disabled model stays visible (and can
 * be switched back on) in the operator's picker.
 */
/** One catalog row for the gateway waterfall id: identity first, then hops. */
const addDeepSeekWaterfallCatalogEntries = (models: Map<string, PublicModelCatalogEntry>): void => {
  if (!DEEPSEEK_WATERFALL_ORDER.some(deepSeekWaterfallProviderConfigured)) return;
  addPublicModelCatalogEntry(
    models,
    DEEPSEEK_WATERFALL_MODEL_ID,
    { id: "ubiquity", owned_by: "ubiquity", supported_endpoints: ["/v1/responses"] },
    DEEPSEEK_WATERFALL_CREATED,
    {
      provider: {
        context_window_tokens: DEEPSEEK_WATERFALL_CONTEXT_WINDOW_TOKENS,
        max_context_window_tokens: DEEPSEEK_WATERFALL_CONTEXT_WINDOW_TOKENS,
        effective_context_window_percent: DEEPSEEK_WATERFALL_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
        supported_reasoning_levels: DEEPSEEK_WATERFALL_REASONING_LEVELS,
        default_reasoning_effort: DEEPSEEK_WATERFALL_DEFAULT_REASONING_LEVEL,
      },
    }
  );
  for (const provider of DEEPSEEK_WATERFALL_ORDER) {
    if (!deepSeekWaterfallProviderConfigured(provider)) continue;
    addPublicModelCatalogEntry(models, DEEPSEEK_WATERFALL_MODEL_ID, { id: provider, owned_by: "ubiquity", supported_endpoints: ["/v1/responses"] }, null);
  }
};

export const buildModelCatalogSnapshot = async (): Promise<ModelCatalogSnapshot> => {
  // Enrichment is cache-only and never awaited, so a slow third party cannot
  // delay the catalog; the first load after a cold start simply shows less.
  warmOpenRouterModels();
  // The compacted runtime copy keeps reasoning tiers and drops context windows,
  // so reading it here let a third-party API-level window (1M) outrank the window
  // Codex actually serves (272k for these ids). The full uploaded catalog is the
  // Codex override; the runtime copy is only a fallback when it is unavailable.
  const snapshot = (await loadFullCodexModelsSnapshot()) ?? (await loadCodexModelsSnapshot());
  const normalized = snapshot && Array.isArray(snapshot.models) && snapshot.models.length > 0 ? normalizeModelList(snapshot) : null;
  const [metered, surplus, claude, claudeCredential] = await Promise.all([
    fetchMeteredModels(),
    fetchSurplusModels({ requireApiKey: false }),
    fetchClaudeCodeModels(),
    resolveClaudeCodeCredential(await getKv()),
  ]);
  const codexModels = normalized?.data ?? [];
  const surplusModels = surplus?.models ?? [];
  const models = new Map<string, PublicModelCatalogEntry>();
  // The uploaded records carry the context and reasoning metadata that
  // `normalizeModelList` strips down to id/object/created/owned_by.
  const codexRecords = collectCodexSnapshotRecords(snapshot);

  for (const model of codexModels) {
    const id = getString(model.id);
    if (!id) continue;
    const codexRecord = codexRecords.get(id) ?? null;
    addPublicModelCatalogEntry(
      models,
      id,
      {
        id: "codex",
        owned_by: getString(model.owned_by) ?? "openai",
        supported_endpoints: ["/v1/responses", "/v1/chat/completions"],
      },
      model.created,
      { codex: codexSnapshotMetadataHint(codexRecord), codexSubscription: codexSubscriptionMetadataHint() }
    );
  }
  for (const model of metered?.models ?? []) {
    addPublicModelCatalogEntry(
      models,
      model.id,
      {
        id: "openlux",
        owned_by: model.owned_by,
        supported_endpoints: providerSupportedEndpointPaths(model.supported_endpoint_types),
      },
      model.created
    );
  }
  for (const model of surplusModels) {
    addPublicModelCatalogEntry(
      models,
      model.id,
      {
        id: "surplus",
        owned_by: model.owned_by,
        supported_endpoints: providerSupportedEndpointPaths(model.supported_endpoint_types),
      },
      model.created
    );
  }
  for (const model of claude?.models ?? []) {
    addPublicModelCatalogEntry(
      models,
      model.id,
      { id: "claude_code", owned_by: "anthropic", supported_endpoints: ["/v1/responses", "/v1/chat/completions"] },
      model.created,
      { provider: { context_window_tokens: model.context_window_tokens, max_context_window_tokens: model.context_window_tokens } }
    );
  }

  const credentialGated = addCredentialGatedCatalogProviders(models);
  // The gateway-owned DeepSeek waterfall id is a real client-selectable model,
  // so the admin picker and the public catalog must list it too: one provider
  // row per usable hop, attributed to the gateway itself.
  addDeepSeekWaterfallCatalogEntries(models);
  // OpenRouter serves its cached public catalogue on the OpenAI-compatible
  // wires and the Typesafe System One model behind /v1/systemone.
  let openrouterServed = 0;
  if (readOpenRouterApiKey() !== null) {
    for (const model of openRouterModelsSnapshot()?.models ?? []) {
      addPublicModelCatalogEntry(
        models,
        model.id,
        { id: "openrouter", owned_by: model.id.split("/", 1)[0] || "openrouter", supported_endpoints: ["/v1/responses", "/v1/chat/completions"] },
        0
      );
      openrouterServed += 1;
    }
    addPublicModelCatalogEntry(models, OPENROUTER_SERVED_MODEL_ID, { id: "openrouter", owned_by: "typesafe", supported_endpoints: ["/v1/systemone"] }, 0);
    openrouterServed += 1;
  }

  return {
    models: [...models.values()].sort((left, right) => left.id.localeCompare(right.id)),
    sources: {
      codex: {
        status: catalogAvailabilityStatus(normalized),
        count: normalized?.data.length ?? 0,
        updated_at_ms: snapshot?.updated_at_ms ?? null,
      },
      claude_code: {
        status: catalogAvailabilityStatus(claude && !claude.stale),
        count: claude?.models.length ?? 0,
        updated_at_ms: claude?.updated_at_ms ?? null,
        configured: claudeCredential !== null,
        ...(claude?.stale ? { stale: true } : {}),
      },
      openlux: {
        status: catalogAvailabilityStatus(metered),
        count: metered?.models.length ?? 0,
        updated_at_ms: metered?.updated_at_ms ?? null,
      },
      surplus: {
        status: catalogAvailabilityStatus(surplus),
        count: surplus?.models.length ?? 0,
        updated_at_ms: surplus?.updated_at_ms ?? null,
      },
      deepseek: credentialGatedCatalogSource(readDeepSeekApiKey() !== null, credentialGated.deepseek),
      cerebras: credentialGatedCatalogSource(readCerebrasApiKey() !== null, credentialGated.cerebras),
      lithos: credentialGatedCatalogSource(readLithosApiKey() !== null, credentialGated.lithos),
      // The public OpenRouter catalog stays a metadata-enrichment source, but
      // the source row reports what this gateway serves through the upstream,
      // exactly like every other provider row.
      openrouter: {
        ...credentialGatedCatalogSource(readOpenRouterApiKey() !== null, openrouterServed),
        updated_at_ms: openRouterModelsSnapshot()?.updated_at_ms ?? null,
      },
    },
  };
};

/** `sources` carries exactly one key per catalog source id, so a key it owns is one of them. */
const isModelCatalogSourceId = (sources: ModelCatalogSnapshot["sources"], id: string): id is ModelCatalogSourceId => Object.hasOwn(sources, id);

/**
 * Public catalog sources for one provider selection. A switched-off provider
 * contributes nothing and is marked `disabled`, which the models page reads as
 * "not served at all" rather than as a failed discovery. The admin picker keeps
 * using the unfiltered snapshot so every provider stays visible and switchable.
 *
 * The selectable roster can name a provider this snapshot has no source for: a
 * provider is wired into the routing vocabulary before its catalog source is
 * published, so only ids this snapshot actually reports are marked disabled.
 */
export const selectedCatalogSources = (sources: ModelCatalogSnapshot["sources"], selection: ProviderSelection | null): ModelCatalogSnapshot["sources"] => {
  if (!selection || selection.provider_ids.length === 0) return sources;
  const adjusted = { ...sources };
  for (const id of SELECTABLE_PROVIDER_IDS) {
    if (isProviderEnabled(id, selection)) continue;
    if (!isModelCatalogSourceId(adjusted, id)) continue;
    adjusted[id] = { status: "unavailable", count: 0, updated_at_ms: null, configured: false, disabled: true };
  }
  return adjusted;
};

export const handlePublicModelCatalog = async (): Promise<Response> => {
  const [catalog, selection] = await Promise.all([buildModelCatalogSnapshot(), loadProviderSelectionCached()]);
  const catalogKv = await getKv();
  const catalogWhitelist = catalogKv ? await loadCodexModelsWhitelist(catalogKv) : null;
  const selected = filterCatalogEntriesByProviderSelection(catalog.models, selection);
  // The public page advertises the operator's enabled set and nothing else, so
  // the whitelist curates every row here, OpenRouter's dynamic entries included.
  // An absent or empty whitelist stays no filter at all, exactly as it does on
  // the Codex-native catalog.
  const data = filterWhitelistedModelMap(selected, catalogWhitelist).sort((left, right) => left.id.localeCompare(right.id));
  return json(200, {
    object: "uos.model_catalog",
    data,
    sources: selectedCatalogSources(catalog.sources, selection),
  });
};

const discoveredModelCapabilitiesEntry = (
  model: Readonly<{ id: string; owned_by: string; supported_endpoint_types: readonly string[] }>,
  provider: "metered" | "surplus"
): Record<string, unknown> => {
  const supportedEndpoints = providerSupportedEndpointPaths(model.supported_endpoint_types);
  // A discovery row states which endpoints exist, not what the model can do, so
  // enrichment is the only source left for these ids. When even that is silent
  // the model advertises `none` alone: that is the gateway's no-reasoning
  // default, not a claim about the model's tiers.
  const resolved = resolveModelMetadata(model.id);
  return {
    id: model.id,
    object: "uos.model_capabilities",
    owned_by: model.owned_by,
    display_name: model.id,
    upstream_provider: provider,
    supported_endpoints: supportedEndpoints,
    supported_reasoning_levels: resolved.supported_reasoning_levels ?? ["none"],
    default_reasoning_effort: resolved.default_reasoning_effort ?? "none",
    reasoning_effort_wire_map: {},
    context_window_tokens: resolved.context_window_tokens,
    max_context_window_tokens: resolved.max_context_window_tokens,
    auto_compact_token_limit_tokens: resolved.auto_compact_token_limit_tokens,
    ...(resolved.effective_context_window_percent === null ? {} : { effective_context_window_percent: resolved.effective_context_window_percent }),
    context_source: resolved.context_source,
    reasoning_source: resolved.reasoning_source,
  };
};

/**
 * Appends one credential-gated row per configured id, skipping any id another
 * source already owns. Kept out of `handleModelCapabilities` so the handler's
 * own branch count stays inside the linted complexity budget.
 */
const appendConfiguredCerebrasRows = (data: Record<string, unknown>[], enabled: boolean): void => {
  if (!enabled) return;
  for (const id of CEREBRAS_MODELS) {
    const entry = configuredCerebrasModelCapabilities(id);
    if (entry && !data.some((model) => model.id === id)) data.push(entry);
  }
};

export const handleModelCapabilities = async (): Promise<Response> => {
  warmOpenRouterModels();
  // Capabilities describe the routes the gateway can still dispatch to, so a
  // switched-off provider contributes no entries here either.
  const selection = await loadProviderSelectionCached();
  const snapshot = await loadFullCodexModelsSnapshot();
  let data =
    snapshot && Array.isArray(snapshot.models) && snapshot.models.length > 0 && isProviderEnabled("codex", selection)
      ? (snapshot.models.map(normalizeModelCapabilitiesEntry).filter(Boolean) as Record<string, unknown>[])
      : [];
  // One entry per configured id, skipping any id the Codex snapshot already owns.
  appendConfiguredCerebrasRows(data, isProviderEnabled("cerebras", selection));
  const [metered, surplus, claude] = await Promise.all([
    isProviderEnabled("openlux", selection) ? fetchMeteredModels() : Promise.resolve(null),
    isProviderEnabled("surplus", selection) ? fetchSurplusModels() : Promise.resolve(null),
    enabledClaudeCatalog(selection),
  ]);
  const seen = new Set(data.map((model) => model.id));
  data.push(...claudeCapabilities(claude?.models ?? []).filter((model) => !seen.has(model.id)));
  for (const [provider, models] of [
    ["metered", metered?.models ?? []],
    ["surplus", surplus?.models ?? []],
  ] as const) {
    for (const model of models) {
      if (data.some((candidate) => candidate.id === model.id)) continue;
      data.push(discoveredModelCapabilitiesEntry(model, provider));
    }
  }
  // Applied last so a DeepSeek-official id discovered above from the paid
  // fallback is replaced by the capabilities of the route it actually uses.
  data = withConfiguredDeepSeekCapabilities(data, isProviderEnabled("deepseek", selection));
  data = withConfiguredLithosCapabilities(data, isProviderEnabled("lithos", selection));
  data = withConfiguredDeepSeekWaterfallCapabilities(data, deepSeekWaterfallCatalogEnabled(selection));

  const capabilitiesKv = await getKv();
  const capabilitiesWhitelist = capabilitiesKv ? await loadCodexModelsWhitelist(capabilitiesKv) : null;
  const filteredData = filterWhitelistedModelList(data, capabilitiesWhitelist);
  // Appended after the whitelist for the same reason as `/v1/models`:
  // OpenRouter's rows follow its own catalogue rather than the operator's
  // curated gateway list.
  const openRouterCapabilities = isProviderEnabled("openrouter", selection) ? configuredOpenRouterModelCapabilities() : [];
  const listedIds = new Set(filteredData.map((model) => getString(model.id) ?? ""));
  const dataWithOpenRouter = [...filteredData, ...openRouterCapabilities.filter((model) => !listedIds.has(getString(model.id) ?? ""))];

  return json(
    200,
    {
      object: "list",
      data: dataWithOpenRouter,
      upstream_provider: "codex_chatgpt",
      source: snapshot?.source ?? "stored_codex_models",
      client_version: snapshot?.client_version ?? null,
      updated_at_ms: snapshot?.updated_at_ms ?? null,
    },
    { "x-uos-upstream": snapshotUpstreamSource(snapshot) }
  );
};
