// Model metadata, prompt-cache, reasoning and warning policy for upstream requests, extracted from src/openai.ts.

/**
 * What the Cerebras route declares about its own models, per id. The two ids
 * differ in both context window and reasoning contract, so a single shared
 * hint cannot describe them.
 *
 * Facts below are from Cerebras' own catalog and reasoning pages (verified
 * 2026-09-26):
 * - Context window: 65,536 free-trial / 131,072 paid, for BOTH ids. Shared
 *   Inference bills these ids at paid tiers, so 131,072 is the window a request
 *   can actually use. Cerebras reports no context length over `/v1/models`.
 * - `gpt-oss-120b` accepts low/medium/high, defaults to `medium`, and cannot
 *   disable reasoning.
 * - `qwen-3.8-27b` additionally accepts `none` and defaults to `high`.
 *
 * One shared list would advertise a tier a model rejects (a promise the gateway
 * cannot keep) or hide `none` from a client that needs it.
 */
const CEREBRAS_CONTEXT_WINDOW_TOKENS = 131_072;

const CEREBRAS_PROVIDER_HINTS: Record<string, ModelMetadataHint> = {
  [CEREBRAS_GPT_OSS_120B_MODEL]: {
    context_window_tokens: CEREBRAS_CONTEXT_WINDOW_TOKENS,
    max_context_window_tokens: CEREBRAS_CONTEXT_WINDOW_TOKENS,
    supported_reasoning_levels: ["low", "medium", "high"],
    default_reasoning_effort: "medium",
  },
  [CEREBRAS_QWEN_3_8_27B_MODEL]: {
    context_window_tokens: CEREBRAS_CONTEXT_WINDOW_TOKENS,
    max_context_window_tokens: CEREBRAS_CONTEXT_WINDOW_TOKENS,
    supported_reasoning_levels: ["none", "low", "medium", "high"],
    default_reasoning_effort: "high",
  },
};

/**
 * The hint for a Cerebras id. An unrecognized id falls back to the gpt-oss
 * contract, which is the route's original single-model declaration.
 */
export const cerebrasProviderHint = (model: string): ModelMetadataHint =>
  CEREBRAS_PROVIDER_HINTS[model] ?? CEREBRAS_PROVIDER_HINTS[CEREBRAS_GPT_OSS_120B_MODEL];

/**
 * What the LithosAI route declares about its own models. All eight ids serve
 * one 1,048,576-token window (verified 2026-09-23), and `reasoning_effort` is
 * accepted verbatim for the seven tiers the route advertises, so the hint
 * carries the window, the effective percentage and the tiers together rather
 * than restating them at each call site.
 */
export const LITHOS_PROVIDER_HINT: ModelMetadataHint = {
  context_window_tokens: LITHOS_CONTEXT_WINDOW_TOKENS,
  max_context_window_tokens: LITHOS_CONTEXT_WINDOW_TOKENS,
  effective_context_window_percent: LITHOS_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  supported_reasoning_levels: [...LITHOS_REASONING_LEVELS],
  default_reasoning_effort: LITHOS_DEFAULT_REASONING_EFFORT,
};

// Temporary hard cut while this exact gateway model has free Surplus inference.
// Remove the cut when the free-inference window ends; do not generalize it to
// other catalog models or paid-fallback routing.
export const TEMPORARY_FREE_SURPLUS_MODEL = "glm-5.2";

export const isTemporaryFreeSurplusModel = (model: string): boolean => model === TEMPORARY_FREE_SURPLUS_MODEL;

/**
 * Codex ids the owner authorized as servable before the upstream discovery
 * catalog advertises them. This is deliberately a closed list of exact ids, not
 * a recognition pattern, and it fabricates no catalog entry: the requested id is
 * forwarded to the Codex transport verbatim. `gpt-reserve` is the second,
 * separately metered id for luna, so it also owns its own quota class.
 */
export const ADDITIONAL_TRUSTED_CODEX_MODEL_IDS: readonly string[] = ["gpt-reserve"];

export const isAdditionalTrustedCodexModel = (model: string): boolean => ADDITIONAL_TRUSTED_CODEX_MODEL_IDS.includes(model.trim());

import { type CodexModelsSnapshot, loadCodexModelsSnapshot } from "./codex/index.ts";
import { CODEX_CHATGPT_PROMPT_CACHE_PROVIDER, normalizePromptCacheCapabilities, type PromptCacheControls } from "./models/codex-models.ts";
import { normalizeReasoningEffort, type ReasoningEffort } from "./defaults.ts";
import {
  LITHOS_CONTEXT_WINDOW_TOKENS,
  LITHOS_DEFAULT_REASONING_EFFORT,
  LITHOS_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  LITHOS_REASONING_LEVELS,
} from "./provider/lithos.ts";
import type { ModelMetadataHint } from "./models/metadata.ts";
import { CEREBRAS_GPT_OSS_120B_MODEL, CEREBRAS_QWEN_3_8_27B_MODEL } from "./provider/cerebras.ts";
import { openaiError } from "./http.ts";
import { getString, isRecord } from "./utils.ts";
import type { ResponseInputItem } from "./types.ts";
import { fetchMeteredModels } from "./provider/metered.ts";
import { fetchSurplusModels } from "./provider/surplus.ts";
import { isSurplusClaudeModel } from "./provider/surplus-claude-request.ts";
import { fetchClaudeCodeModels, claudeCodeReasoningLevels } from "./provider/claude-code-models.ts";
import { isProviderEnabled, loadProviderSelectionCached } from "./provider/selection.ts";
import { countExplicitPromptCacheBreakpoints } from "./openai-telemetry.ts";

export type CodexModelReasoning = Readonly<{
  levels: ReasoningEffort[];
  defaultLevel: ReasoningEffort | null;
  wireEfforts: ReadonlyMap<ReasoningEffort, ReasoningEffort>;
}>;

export type CodexModelMetadata = Readonly<{
  snapshot: CodexModelsSnapshot | null;
  record: Record<string, unknown> | null;
  reasoning: CodexModelReasoning;
  supportedEndpoints: readonly string[] | null;
}>;

export const modelIdFromSnapshotRecord = (model: Record<string, unknown>): string | null => {
  const id = getString(model.slug) ?? getString(model.id) ?? getString(model.model) ?? getString(model.name);
  const trimmed = id?.trim();
  if (!trimmed) return null;
  return trimmed;
};

const findSnapshotModelRecord = (snapshot: CodexModelsSnapshot | null, model: string): Record<string, unknown> | null => {
  const target = model.trim();
  if (!target) return null;
  if (!snapshot || !Array.isArray(snapshot.models)) return null;
  return (
    snapshot.models.find((entry) => {
      if (!isRecord(entry)) return false;
      return modelIdFromSnapshotRecord(entry) === target;
    }) ?? null
  );
};

const normalizeSnapshotReasoningEffort = (value: unknown): ReasoningEffort | null => (value === null ? "none" : normalizeReasoningEffort(value));

const extractSnapshotReasoningLevels = (model: Record<string, unknown> | null): ReasoningEffort[] => {
  const raw = Array.isArray(model?.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
  const levels = raw
    .map((entry) => {
      if (entry === null || typeof entry === "string") return normalizeSnapshotReasoningEffort(entry);
      if (isRecord(entry)) return normalizeSnapshotReasoningEffort(entry.effort);
      return null;
    })
    .filter((entry): entry is ReasoningEffort => Boolean(entry));
  return Array.from(new Set(levels));
};

const extractSnapshotReasoningEffortWireMap = (model: Record<string, unknown> | null): ReadonlyMap<ReasoningEffort, ReasoningEffort> => {
  const raw = model?.reasoning_effort_wire_map;
  if (!isRecord(raw)) return new Map();
  const entries = Object.entries(raw)
    .map(([effort, wireEffort]) => [normalizeReasoningEffort(effort), normalizeReasoningEffort(wireEffort)] as const)
    .filter((entry): entry is readonly [ReasoningEffort, ReasoningEffort] => entry[0] !== null && entry[1] !== null);
  return new Map(entries);
};

export const getCodexModelReasoning = (record: Record<string, unknown> | null): CodexModelReasoning => {
  const defaultLevel = normalizeSnapshotReasoningEffort(record?.default_reasoning_level);
  const catalogLevels = extractSnapshotReasoningLevels(record);
  // Advertised tiers are preserved verbatim; `none` is never added, because the
  // upstream rejects an effort its catalog does not list.
  const levels = [...catalogLevels];
  return {
    levels: defaultLevel && !levels.includes(defaultLevel) ? [...levels, defaultLevel] : levels,
    defaultLevel,
    wireEfforts: extractSnapshotReasoningEffortWireMap(record),
  };
};

const findClaudeCodeModel = async (model: string) => {
  if (!isSurplusClaudeModel(model) || !isProviderEnabled("claude_code", await loadProviderSelectionCached())) return null;
  const snapshot = await fetchClaudeCodeModels();
  return snapshot?.models.find((candidate) => candidate.id === model) ?? null;
};

export const getCodexModelMetadata = async (model: string, route: "chat.completions" | "responses"): Promise<CodexModelMetadata> => {
  if (isTemporaryFreeSurplusModel(model)) {
    // This non-Codex routing record deliberately omits reasoning capability
    // claims. GLM preserves each caller-selected effort; no Surplus catalog
    // metadata currently authorizes the gateway to advertise a fixed list.
    const record = { slug: TEMPORARY_FREE_SURPLUS_MODEL };
    return {
      snapshot: null,
      record,
      reasoning: getCodexModelReasoning(record),
      supportedEndpoints: ["openai", "openai-response"],
    };
  }
  const snapshot = await loadCodexModelsSnapshot();
  const record = findSnapshotModelRecord(snapshot, model);
  if (record) return { snapshot, record, reasoning: getCodexModelReasoning(record), supportedEndpoints: null };
  const claudeModel = await findClaudeCodeModel(model);
  if (claudeModel) {
    // The native subscription adapter serves both wires. A same-id paid row
    // cannot remove that route, but only this credential's observed IDs add it.
    const subscriptionRecord = {
      slug: model,
      supported_reasoning_levels: claudeCodeReasoningLevels(claudeModel),
      ...(claudeModel.supports_disabled_thinking === true ? { default_reasoning_level: "none" } : {}),
    };
    return {
      snapshot,
      record: subscriptionRecord,
      reasoning: getCodexModelReasoning(subscriptionRecord),
      supportedEndpoints: ["openai", "openai-response"],
    };
  }
  const [metered, surplus] = await Promise.all([fetchMeteredModels(), fetchSurplusModels()]);
  const meteredRecord = metered?.models.find((candidate) => candidate.id === model);
  const surplusRecord = surplus?.models.find((candidate) => candidate.id === model);
  const endpointType = route === "responses" ? "openai-response" : "openai";
  const routeRecord = [meteredRecord, surplusRecord].find((candidate) => candidate?.supported_endpoint_types.includes(endpointType));
  const paidRecord = routeRecord ?? meteredRecord ?? surplusRecord;
  if (paidRecord) {
    const routeProvider = routeRecord === surplusRecord && surplusRecord ? "surplus" : "metered";
    const routeSnapshot = routeProvider === "surplus" ? surplus : metered;
    return {
      snapshot: snapshot ?? {
        models: [],
        source: routeProvider,
        updated_at_ms: routeSnapshot?.updated_at_ms ?? Date.now(),
      },
      record: {
        slug: paidRecord.id,
        supported_reasoning_levels: ["none"],
        default_reasoning_level: "none",
      },
      reasoning: getCodexModelReasoning({ supported_reasoning_levels: ["none"], default_reasoning_level: "none" }),
      supportedEndpoints: paidRecord.supported_endpoint_types,
    };
  }
  return { snapshot, record: null, reasoning: getCodexModelReasoning(null), supportedEndpoints: null };
};

export const validateCodexModelAvailable = (model: string, route: "chat.completions" | "responses", metadata: CodexModelMetadata): Response | null => {
  if (metadata.supportedEndpoints && !metadata.supportedEndpoints.includes(route === "responses" ? "openai-response" : "openai")) {
    return openaiError(404, `The model '${model}' does not support ${route}. Use /v1/models for supported models.`, "model_not_found", { param: "model" });
  }
  // The snapshot is read back from KV, so keep the runtime guard on `models`
  // even though the declared type always presents it.
  const snapshotModels = metadata.snapshot?.models;
  if (!snapshotModels?.length || metadata.record) return null;
  // An owner-authorized id stays servable while the published catalog lags; it
  // is dispatched to the Codex transport under the requested id, and no catalog
  // record is invented for it.
  if (isAdditionalTrustedCodexModel(model)) return null;
  return openaiError(
    404,
    `The model '${model}' does not exist or is not available through this gateway. Use /v1/models for supported models.`,
    "model_not_found",
    { param: "model" }
  );
};

const promptCacheControlParam = (rawRecord: Record<string, unknown>): string | null => {
  for (const key of ["prompt_cache_key", "prompt_cache_options", "prompt_cache_retention"] as const) {
    if (Object.prototype.hasOwnProperty.call(rawRecord, key)) return key;
  }
  return null;
};

const hasExplicitPromptCacheBreakpoint = (value: unknown): boolean => isRecord(value) && !Array.isArray(value) && value.mode === "explicit";

type ExplicitPromptCacheBreakpoint = Readonly<{
  param: string;
  blockType: string | null;
}>;

const collectExplicitPromptCacheBreakpoint = (value: Record<string, unknown>, param: string, breakpoints: ExplicitPromptCacheBreakpoint[]): void => {
  if (!hasExplicitPromptCacheBreakpoint(value.prompt_cache_breakpoint)) return;
  breakpoints.push({ param, blockType: getString(value.type) });
};

const collectIndexedExplicitPromptCacheBreakpoints = (values: readonly unknown[], paramPrefix: string, breakpoints: ExplicitPromptCacheBreakpoint[]): void => {
  for (const [index, value] of values.entries()) {
    if (!isRecord(value) || Array.isArray(value)) continue;
    collectExplicitPromptCacheBreakpoint(value, `${paramPrefix}[${index}].prompt_cache_breakpoint`, breakpoints);
  }
};

const findExplicitPromptCacheBreakpoints = (rawInput: unknown, inputParam: "input" | "messages"): ExplicitPromptCacheBreakpoint[] => {
  if (!Array.isArray(rawInput)) return [];

  const breakpoints: ExplicitPromptCacheBreakpoint[] = [];

  for (const [index, item] of rawInput.entries()) {
    if (!isRecord(item) || Array.isArray(item)) continue;
    const itemParam = `${inputParam}[${index}]`;
    if (inputParam === "input") {
      collectExplicitPromptCacheBreakpoint(item, `${itemParam}.prompt_cache_breakpoint`, breakpoints);
    }
    if (Array.isArray(item.content)) {
      collectIndexedExplicitPromptCacheBreakpoints(item.content, `${itemParam}.content`, breakpoints);
    }
    if (inputParam !== "input" || item.type !== "function_call_output" || !Array.isArray(item.output)) continue;
    collectIndexedExplicitPromptCacheBreakpoints(item.output, `${itemParam}.output`, breakpoints);
  }
  return breakpoints;
};

const activePromptCacheControls = (metadata: CodexModelMetadata): PromptCacheControls | null => {
  const capabilities = normalizePromptCacheCapabilities(metadata.record?.prompt_cache);
  if (capabilities === null || capabilities === false) return null;
  return capabilities.providers.find((provider) => provider.id === CODEX_CHATGPT_PROMPT_CACHE_PROVIDER)?.controls ?? null;
};

type RequestedPromptCacheMode = Readonly<{
  value: "implicit" | "explicit";
  param: "prompt_cache_options" | "prompt_cache_options.mode";
}>;

const requestedPromptCacheMode = (rawRecord: Record<string, unknown>): RequestedPromptCacheMode | null => {
  if (!Object.prototype.hasOwnProperty.call(rawRecord, "prompt_cache_options")) return null;
  const options = rawRecord.prompt_cache_options;
  if (!isRecord(options) || Array.isArray(options)) return null;
  if (options.mode === "explicit") return { value: "explicit", param: "prompt_cache_options.mode" };
  return {
    value: "implicit",
    param: options.mode === "implicit" ? "prompt_cache_options.mode" : "prompt_cache_options",
  };
};

const requestedPromptCacheTtl = (rawRecord: Record<string, unknown>): string | null => {
  const options = rawRecord.prompt_cache_options;
  if (!isRecord(options) || Array.isArray(options)) return null;
  return getString(options.ttl);
};

const knownUnsupportedPromptCacheUseError = (model: string, param: string): Response =>
  openaiError(400, `Prompt cache control '${param}' is not supported for model '${model}'.`, "invalid_request_error", { param });

const promptCacheControlModeIsKnownUnsupported = (controls: PromptCacheControls, value: "implicit" | "explicit"): boolean =>
  controls.modes !== undefined && !controls.modes.includes(value);

const validatePromptCacheControlKey = (model: string, controls: PromptCacheControls, rawRecord: Record<string, unknown>): Response | null => {
  if (Object.prototype.hasOwnProperty.call(rawRecord, "prompt_cache_key") && controls.key === false) {
    return knownUnsupportedPromptCacheUseError(model, "prompt_cache_key");
  }
  return null;
};

const validatePromptCacheControlOptions = (model: string, controls: PromptCacheControls, rawRecord: Record<string, unknown>): Response | null => {
  const ttl = requestedPromptCacheTtl(rawRecord);
  if (ttl !== null && controls.ttls !== undefined && !controls.ttls.includes(ttl)) {
    return knownUnsupportedPromptCacheUseError(model, "prompt_cache_options.ttl");
  }

  const retention = getString(rawRecord.prompt_cache_retention);
  if (retention !== null && controls.legacy_retentions !== undefined && !controls.legacy_retentions.includes(retention)) {
    return knownUnsupportedPromptCacheUseError(model, "prompt_cache_retention");
  }
  return null;
};

const validatePromptCacheControlBreakpoints = (
  model: string,
  controls: PromptCacheControls,
  inputParam: "input" | "messages",
  breakpoints: readonly ExplicitPromptCacheBreakpoint[]
): Response | null => {
  for (const breakpoint of breakpoints) {
    if (controls.explicit_breakpoints === false || promptCacheControlModeIsKnownUnsupported(controls, "explicit")) {
      return knownUnsupportedPromptCacheUseError(model, breakpoint.param);
    }
    const endpoint = inputParam === "input" ? "responses" : "chat_completions";
    const supportedBlockTypes = controls.breakpoint_block_types?.[endpoint];
    if (supportedBlockTypes !== undefined && (breakpoint.blockType === null || !supportedBlockTypes.includes(breakpoint.blockType))) {
      return knownUnsupportedPromptCacheUseError(model, breakpoint.param);
    }
  }
  return null;
};

export const validateKnownUnsupportedPromptCacheUse = (
  model: string,
  metadata: CodexModelMetadata,
  rawRecord: Record<string, unknown>,
  input: readonly ResponseInputItem[],
  inputParam: "input" | "messages"
): Response | null => {
  const breakpoints = countExplicitPromptCacheBreakpoints(input) > 0 ? findExplicitPromptCacheBreakpoints(rawRecord[inputParam], inputParam) : [];

  if (metadata.record?.prompt_cache === false) {
    const param = promptCacheControlParam(rawRecord) ?? breakpoints[0]?.param;
    if (!param) return null;
    return openaiError(400, `Prompt caching is not supported for model '${model}'.`, "invalid_request_error", { param });
  }

  // A missing capability envelope, another provider's record, or an omitted
  // control field is unknown—not an unsupported upstream feature. Preserve
  // standard OpenAI controls in each of those cases for forward compatibility.
  const controls = activePromptCacheControls(metadata);
  if (!controls) return null;

  const keyError = validatePromptCacheControlKey(model, controls, rawRecord);
  if (keyError) return keyError;

  const mode = requestedPromptCacheMode(rawRecord);
  if (mode?.value === "implicit" && (controls.implicit === false || promptCacheControlModeIsKnownUnsupported(controls, "implicit"))) {
    return knownUnsupportedPromptCacheUseError(model, mode.param);
  }

  const optionsError = validatePromptCacheControlOptions(model, controls, rawRecord);
  if (optionsError) return optionsError;

  const breakpointsError = validatePromptCacheControlBreakpoints(model, controls, inputParam, breakpoints);
  if (breakpointsError) return breakpointsError;

  if (mode?.value === "explicit" && (controls.explicit_breakpoints === false || promptCacheControlModeIsKnownUnsupported(controls, "explicit"))) {
    return knownUnsupportedPromptCacheUseError(model, mode.param);
  }

  return null;
};

export const resolveDefaultReasoningLabel = (_modelReasoning: CodexModelReasoning, defaultEffort: ReasoningEffort): ReasoningEffort => defaultEffort;

export const resolveReasoningLabelFromEffort = (effort: ReasoningEffort | undefined, defaultLabel: ReasoningEffort): ReasoningEffort => {
  if (effort === undefined) return defaultLabel;
  return effort;
};

export const resolveReasoningLabelFromParam = (reasoning: Record<string, unknown> | undefined, defaultLabel: ReasoningEffort): ReasoningEffort => {
  if (reasoning === undefined) return defaultLabel;
  if (!isRecord(reasoning)) return defaultLabel;
  if ("effort" in reasoning) {
    const effort = normalizeReasoningEffort(reasoning.effort);
    if (effort) return effort;
  }
  return defaultLabel;
};

const extractReasoningParamEffort = (reasoning: Record<string, unknown> | undefined): ReasoningEffort | undefined => {
  if (reasoning === undefined) return undefined;
  if (!Object.prototype.hasOwnProperty.call(reasoning, "effort")) return undefined;
  return normalizeReasoningEffort(reasoning.effort) ?? undefined;
};

export const reasoningEffortForCodexRequest = (effort: ReasoningEffort, modelReasoning: CodexModelReasoning): ReasoningEffort => {
  if (effort === "none") return "none";
  // Codex CLI's advanced `ultra` preset is client-side orchestration and
  // always uses `max` on the upstream wire, even for an older catalog that
  // has not yet published its wire map.
  if (effort === "ultra") return "max";
  return modelReasoning.wireEfforts.get(effort) ?? effort;
};

export const normalizeReasoningParamForCodex = (
  reasoning: Record<string, unknown> | undefined,
  modelReasoning: CodexModelReasoning
): Record<string, unknown> | undefined => {
  if (reasoning === undefined) return undefined;
  const effort = extractReasoningParamEffort(reasoning);
  if (effort === undefined) return reasoning;
  return { ...reasoning, effort: reasoningEffortForCodexRequest(effort, modelReasoning) };
};

export const UOS_WARNING_HEADER = "x-uos-warning";
const TEMPERATURE_IGNORED_WARNING = "temperature_ignored";
const MAX_OUTPUT_TOKENS_IGNORED_WARNING = "max_output_tokens_ignored";

export const WARNING_KEY_MAP = new Map<string, string>([
  ["temperature", TEMPERATURE_IGNORED_WARNING],
  ["max_tokens", MAX_OUTPUT_TOKENS_IGNORED_WARNING],
  ["max_completion_tokens", MAX_OUTPUT_TOKENS_IGNORED_WARNING],
  ["max_output_tokens", MAX_OUTPUT_TOKENS_IGNORED_WARNING],
]);

export const buildIgnoredWarnings = (record: Record<string, unknown>, usedKeys: ReadonlySet<string>): string[] => {
  const warnings = new Set<string>();
  for (const key of Object.keys(record)) {
    if (usedKeys.has(key)) continue;
    const mapped = WARNING_KEY_MAP.get(key) ?? `${key}_ignored`;
    warnings.add(mapped);
  }
  return Array.from(warnings);
};

export const responseWarnings = (response: Response): string[] =>
  (response.headers.get(UOS_WARNING_HEADER) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

export type PassthroughToolSchemaKey =
  | "tools"
  | "tool_choice"
  | "parallel_tool_calls"
  | "prompt_cache_key"
  | "prompt_cache_options"
  | "prompt_cache_retention"
  | "text"
  | "include"
  | "context_management";

const normalizeCodexToolChoice = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  if (getString(value.type) !== "function") return value;

  const normalized: Record<string, unknown> = { ...value };
  const topLevelName = getString(normalized.name);
  const fn = isRecord(value.function) ? value.function : null;
  if (!fn && !topLevelName) return value;

  if (!topLevelName) {
    const functionName = getString(fn?.name);
    if (!functionName) return value;
    normalized.name = functionName;
  }

  delete normalized.function;
  return normalized;
};

const normalizeCodexTools = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((tool) => {
    if (!isRecord(tool)) return tool;
    if (getString(tool.type) !== "function") return tool;
    const nestedFunction = isRecord(tool.function) ? tool.function : null;
    if (!nestedFunction) return tool;

    const normalized: Record<string, unknown> = { ...tool };
    const topLevelName = getString(normalized.name);
    const nestedName = getString(nestedFunction.name);
    if (!topLevelName && !nestedName) return tool;

    if (!topLevelName) {
      normalized.name = nestedName;
    }
    for (const [key, nestedValue] of Object.entries(nestedFunction)) {
      if (key in normalized) continue;
      normalized[key] = nestedValue;
    }
    delete normalized.function;
    return normalized;
  });
};

const normalizePassthroughForCodex = (key: PassthroughToolSchemaKey, value: unknown): unknown => {
  if (key === "tools") return normalizeCodexTools(value);
  if (key === "tool_choice") return normalizeCodexToolChoice(value);
  return value;
};

export const applyPassthroughToCodexRequest = (
  codexBody: Record<string, unknown>,
  rawRecord: Record<string, unknown>,
  keys: readonly PassthroughToolSchemaKey[]
): void => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(rawRecord, key)) {
      codexBody[key] = normalizePassthroughForCodex(key, rawRecord[key]);
    }
  }
};

export const withUosWarning = (response: Response, warnings: string[]): Response => {
  const merged = Array.from(new Set([...responseWarnings(response), ...warnings]));
  if (!merged.length) return response;
  const headers = new Headers(response.headers);
  headers.set(UOS_WARNING_HEADER, merged.join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
export const parseReasoningEffortField = (
  value: unknown,
  fieldName: string
): { ok: true; value: ReasoningEffort | undefined } | { ok: false; message: string } => {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, message: `${fieldName} must be a string` };
  }
  const normalized = normalizeReasoningEffort(value);
  if (!normalized) return { ok: false, message: `${fieldName} must be a non-empty string` };
  return { ok: true, value: normalized };
};

const normalizeReasoningSummaryField = (record: Record<string, unknown>): { ok: false; message: string } | null => {
  if (!("summary" in record)) return null;
  const summary = record.summary;
  if (summary === undefined || summary === null) delete record.summary;
  else if (typeof summary !== "string") {
    return { ok: false, message: "reasoning.summary must be a string" };
  }
  return null;
};

const normalizeReasoningGenerateSummaryField = (record: Record<string, unknown>): { ok: false; message: string } | null => {
  if (!("generate_summary" in record)) return null;
  const generateSummary = record.generate_summary;
  if (generateSummary === undefined || generateSummary === null) delete record.generate_summary;
  else if (typeof generateSummary !== "string") {
    return { ok: false, message: "reasoning.generate_summary must be a string" };
  }
  return null;
};

export const parseReasoningParam = (value: unknown): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; message: string } => {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!isRecord(value) || Array.isArray(value)) return { ok: false, message: "reasoning must be an object" };
  const normalized = { ...value };
  if ("effort" in normalized) {
    const effort = parseReasoningEffortField(normalized.effort, "reasoning.effort");
    if (!effort.ok) return effort;
    if (effort.value === undefined) delete normalized.effort;
    else normalized.effort = effort.value;
  }
  const summaryError = normalizeReasoningSummaryField(normalized);
  if (summaryError) return summaryError;
  const generateSummaryError = normalizeReasoningGenerateSummaryField(normalized);
  if (generateSummaryError) return generateSummaryError;

  return { ok: true, value: Object.keys(normalized).length ? normalized : undefined };
};

export const parseStreamField = (value: unknown): { ok: true; value: boolean } | { ok: false; message: string } => {
  if (value === undefined || value === false) return { ok: true, value: false };
  if (value === true) return { ok: true, value: true };
  return { ok: false, message: "stream must be a boolean" };
};

export const parseChatStreamOptions = (value: unknown): { ok: true; includeUsage: boolean } | { ok: false; message: string } => {
  if (value === undefined) return { ok: true, includeUsage: false };
  if (!isRecord(value) || Array.isArray(value)) {
    return { ok: false, message: "stream_options must be an object" };
  }
  if (value.include_usage !== undefined && typeof value.include_usage !== "boolean") {
    return { ok: false, message: "stream_options.include_usage must be a boolean" };
  }
  return { ok: true, includeUsage: value.include_usage === true };
};

export const parseMaxCompletionTokensField = (value: unknown): { ok: true; value: number | undefined } | { ok: false; message: string } => {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, message: "max_completion_tokens must be a positive integer" };
  }
  return { ok: true, value };
};
