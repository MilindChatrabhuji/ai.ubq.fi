// Chat Completions and Responses input normalization, extracted from src/openai.ts.

import { cerebrasProviderHint, LITHOS_PROVIDER_HINT } from "./request-policy.ts";
import {
  CEREBRAS_GPT_OSS_120B_MODEL,
  CEREBRAS_MODELS,
  CEREBRAS_QWEN_3_8_27B_MODEL,
  cerebrasUpstreamModelFor,
  readCerebrasApiKey,
} from "./provider/cerebras.ts";
import {
  DEEPSEEK_CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_DEFAULT_REASONING_EFFORT,
  DEEPSEEK_DISPLAY_NAMES,
  DEEPSEEK_OFFICIAL_MODEL_IDS,
  DEEPSEEK_REASONING_LEVELS,
  readDeepSeekApiKey,
} from "./deepseek/index.ts";
import { LITHOS_DEFAULT_REASONING_EFFORT, LITHOS_DISPLAY_NAMES, LITHOS_MODEL_IDS, LITHOS_REASONING_LEVELS, readLithosApiKey } from "./provider/lithos.ts";
import {
  DEEPSEEK_WATERFALL_AUTO_COMPACT_TOKEN_LIMIT,
  DEEPSEEK_WATERFALL_CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_WATERFALL_CREATED,
  DEEPSEEK_WATERFALL_DEFAULT_REASONING_LEVEL,
  DEEPSEEK_WATERFALL_DISPLAY_NAME,
  DEEPSEEK_WATERFALL_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  DEEPSEEK_WATERFALL_MODEL_ID,
  DEEPSEEK_WATERFALL_ORDER,
  DEEPSEEK_WATERFALL_REASONING_LEVELS,
  deepSeekWaterfallProviderConfigured,
} from "./deepseek/waterfall.ts";
import { openRouterModelsSnapshot } from "./models/openrouter-models.ts";
import { readOpenRouterApiKey } from "./provider/openrouter.ts";
import { normalizePromptCacheCapabilities } from "./models/codex-models.ts";
import { codexSnapshotMetadataHint, codexSubscriptionMetadataHint, resolveModelMetadata } from "./models/metadata.ts";
import { getString, isRecord } from "./utils.ts";
import type { MessageContentItem, PromptCacheBreakpoint, ResponseInputItem, ResponseMessageItem } from "./types.ts";
import { getCodexModelReasoning, modelIdFromSnapshotRecord } from "./request-policy.ts";

export type NormalizationResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; message: string; param: string }>;

type InputImageDetail = "auto" | "low" | "high" | "original";
type InputFileDetail = "auto" | "low" | "high";

const invalidNormalizedField = <T>(param: string, message: string): NormalizationResult<T> => ({
  ok: false,
  message,
  param,
});

const parseImageDetail = (value: unknown, param: string): NormalizationResult<InputImageDetail | null | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (value === "auto" || value === "low" || value === "high" || value === "original") {
    return { ok: true, value };
  }
  return invalidNormalizedField(param, `${param} must be one of auto, low, high, or original`);
};

const parseInputFileDetail = (value: unknown, param: string): NormalizationResult<InputFileDetail | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === "auto" || value === "low" || value === "high") return { ok: true, value };
  return invalidNormalizedField(param, `${param} must be one of auto, low, or high`);
};

const findUnknownContentField = (value: Record<string, unknown>, allowed: readonly string[]): string | null => {
  const allowedFields = new Set(allowed);
  return Object.keys(value).find((key) => !allowedFields.has(key)) ?? null;
};

const normalizePromptCacheBreakpoint = (value: unknown, param: string): NormalizationResult<PromptCacheBreakpoint | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value) || Array.isArray(value)) {
    return invalidNormalizedField(param, `${param} must be an object`);
  }
  const unknown = findUnknownContentField(value, ["mode"]);
  if (unknown) return invalidNormalizedField(`${param}.${unknown}`, `Unknown cache breakpoint field: ${unknown}`);
  if (value.mode !== "explicit") {
    return invalidNormalizedField(`${param}.mode`, `${param}.mode must be explicit`);
  }
  return { ok: true, value: { mode: "explicit" } };
};

export const validatePromptCacheControls = (rawRecord: Record<string, unknown>): NormalizationResult<void> => {
  if (Object.prototype.hasOwnProperty.call(rawRecord, "prompt_cache_key") && typeof rawRecord.prompt_cache_key !== "string") {
    return invalidNormalizedField("prompt_cache_key", "prompt_cache_key must be a string");
  }

  if (Object.prototype.hasOwnProperty.call(rawRecord, "prompt_cache_options")) {
    const options = rawRecord.prompt_cache_options;
    if (!isRecord(options) || Array.isArray(options)) {
      return invalidNormalizedField("prompt_cache_options", "prompt_cache_options must be an object");
    }
    const unknown = findUnknownContentField(options, ["mode", "ttl"]);
    if (unknown) {
      return invalidNormalizedField(`prompt_cache_options.${unknown}`, `Unknown prompt cache option: ${unknown}`);
    }
    if (options.mode !== undefined && options.mode !== "implicit" && options.mode !== "explicit") {
      return invalidNormalizedField("prompt_cache_options.mode", "prompt_cache_options.mode must be implicit or explicit");
    }
    if (options.ttl !== undefined && options.ttl !== "30m") {
      return invalidNormalizedField("prompt_cache_options.ttl", "prompt_cache_options.ttl must be 30m");
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(rawRecord, "prompt_cache_retention") &&
    rawRecord.prompt_cache_retention !== "in_memory" &&
    rawRecord.prompt_cache_retention !== "24h"
  ) {
    return invalidNormalizedField("prompt_cache_retention", "prompt_cache_retention must be in_memory or 24h");
  }

  return { ok: true, value: undefined };
};

const withPromptCacheBreakpoint = <T extends object>(
  item: T,
  breakpoint: PromptCacheBreakpoint | undefined
): T & { prompt_cache_breakpoint?: PromptCacheBreakpoint } => (breakpoint === undefined ? item : { ...item, prompt_cache_breakpoint: breakpoint });

const normalizeChatTextContentPart = (
  part: Record<string, unknown>,
  partParam: string,
  isAssistant: boolean,
  textItemType: "input_text" | "output_text"
): NormalizationResult<MessageContentItem> => {
  const unknown = findUnknownContentField(part, ["type", "text", "prompt_cache_breakpoint"]);
  if (unknown) return invalidNormalizedField(`${partParam}.${unknown}`, `Unknown content field: ${unknown}`);
  if (typeof part.text !== "string") {
    return invalidNormalizedField(`${partParam}.text`, `${partParam}.text must be a string`);
  }
  if (isAssistant && part.prompt_cache_breakpoint !== undefined) {
    return invalidNormalizedField(
      `${partParam}.prompt_cache_breakpoint`,
      "prompt_cache_breakpoint is not supported for assistant output content in this gateway"
    );
  }
  const breakpoint = normalizePromptCacheBreakpoint(part.prompt_cache_breakpoint, `${partParam}.prompt_cache_breakpoint`);
  if (!breakpoint.ok) return breakpoint;
  if (textItemType === "input_text") {
    return { ok: true, value: withPromptCacheBreakpoint({ type: "input_text", text: part.text }, breakpoint.value) };
  }
  return { ok: true, value: { type: "output_text", text: part.text } };
};

const normalizeChatRefusalContentPart = (
  part: Record<string, unknown>,
  partParam: string,
  isAssistant: boolean,
  partCount: number
): NormalizationResult<MessageContentItem> => {
  const unknown = findUnknownContentField(part, ["type", "refusal", "prompt_cache_breakpoint"]);
  if (unknown) return invalidNormalizedField(`${partParam}.${unknown}`, `Unknown content field: ${unknown}`);
  if (!isAssistant) {
    return invalidNormalizedField(`${partParam}.type`, `${partParam}.type is only valid for assistant messages`);
  }
  if (partCount !== 1) {
    return invalidNormalizedField(`${partParam}.type`, "assistant refusal content must be the only part");
  }
  if (typeof part.refusal !== "string") {
    return invalidNormalizedField(`${partParam}.refusal`, `${partParam}.refusal must be a string`);
  }
  if (part.prompt_cache_breakpoint !== undefined) {
    return invalidNormalizedField(`${partParam}.prompt_cache_breakpoint`, "prompt_cache_breakpoint is not supported for refusal content in this gateway");
  }
  return { ok: true, value: { type: "output_text", text: part.refusal } };
};

const normalizeChatImageContentPart = (
  part: Record<string, unknown>,
  partParam: string,
  role: ResponseMessageItem["role"]
): NormalizationResult<MessageContentItem> => {
  const unknown = findUnknownContentField(part, ["type", "image_url", "prompt_cache_breakpoint"]);
  if (unknown) return invalidNormalizedField(`${partParam}.${unknown}`, `Unknown content field: ${unknown}`);
  if (role !== "user") {
    return invalidNormalizedField(`${partParam}.type`, `${partParam}.type is only valid for user messages`);
  }
  const image = isRecord(part.image_url) && !Array.isArray(part.image_url) ? part.image_url : null;
  if (!image) {
    return invalidNormalizedField(`${partParam}.image_url`, `${partParam}.image_url must be an object`);
  }
  const imageUnknown = findUnknownContentField(image, ["url", "detail"]);
  if (imageUnknown) {
    return invalidNormalizedField(`${partParam}.image_url.${imageUnknown}`, `Unknown image_url field: ${imageUnknown}`);
  }
  if (typeof image.url !== "string" || !image.url.trim()) {
    return invalidNormalizedField(`${partParam}.image_url.url`, `${partParam}.image_url.url must contain a URL`);
  }
  const detail = parseImageDetail(image.detail, `${partParam}.image_url.detail`);
  if (!detail.ok) return detail;
  const breakpoint = normalizePromptCacheBreakpoint(part.prompt_cache_breakpoint, `${partParam}.prompt_cache_breakpoint`);
  if (!breakpoint.ok) return breakpoint;
  const item: Extract<MessageContentItem, { type: "input_image" }> =
    detail.value === undefined
      ? { type: "input_image", image_url: image.url.trim() }
      : { type: "input_image", image_url: image.url.trim(), detail: detail.value };
  return { ok: true, value: withPromptCacheBreakpoint(item, breakpoint.value) };
};

const chatFileContentItem = (
  fileId: string | undefined,
  fileData: string | undefined,
  filename: string | undefined
): Extract<MessageContentItem, { type: "input_file" }> => ({
  type: "input_file",
  ...(fileId === undefined ? {} : { file_id: fileId }),
  ...(fileData === undefined ? {} : { file_data: fileData }),
  ...(filename === undefined ? {} : { filename }),
});

const normalizeChatFileContentPart = (
  part: Record<string, unknown>,
  partParam: string,
  role: ResponseMessageItem["role"]
): NormalizationResult<MessageContentItem> => {
  const unknown = findUnknownContentField(part, ["type", "file", "prompt_cache_breakpoint"]);
  if (unknown) return invalidNormalizedField(`${partParam}.${unknown}`, `Unknown content field: ${unknown}`);
  if (role !== "user") {
    return invalidNormalizedField(`${partParam}.type`, `${partParam}.type is only valid for user messages`);
  }
  const file = isRecord(part.file) && !Array.isArray(part.file) ? part.file : null;
  if (!file) return invalidNormalizedField(`${partParam}.file`, `${partParam}.file must be an object`);
  const fileUnknown = findUnknownContentField(file, ["file_id", "file_data", "filename"]);
  if (fileUnknown) {
    return invalidNormalizedField(`${partParam}.file.${fileUnknown}`, `Unknown file field: ${fileUnknown}`);
  }
  for (const field of ["file_id", "file_data", "filename"] as const) {
    if (file[field] !== undefined && typeof file[field] !== "string") {
      return invalidNormalizedField(`${partParam}.file.${field}`, `${partParam}.file.${field} must be a string`);
    }
  }
  const fileId = getString(file.file_id) ?? undefined;
  const fileData = getString(file.file_data) ?? undefined;
  if (!fileId?.trim() && !fileData?.trim()) {
    return invalidNormalizedField(`${partParam}.file.file_id`, `${partParam}.file must include file_id or file_data`);
  }
  const breakpoint = normalizePromptCacheBreakpoint(part.prompt_cache_breakpoint, `${partParam}.prompt_cache_breakpoint`);
  if (!breakpoint.ok) return breakpoint;
  const filename = typeof file.filename === "string" ? file.filename : undefined;
  const item = chatFileContentItem(fileId, fileData, filename);
  return { ok: true, value: withPromptCacheBreakpoint(item, breakpoint.value) };
};

const normalizeChatContentPart = (
  part: Record<string, unknown>,
  partParam: string,
  role: ResponseMessageItem["role"],
  isAssistant: boolean,
  textItemType: "input_text" | "output_text",
  partCount: number
): NormalizationResult<MessageContentItem> => {
  const partType = getString(part.type);
  if (partType === "text") return normalizeChatTextContentPart(part, partParam, isAssistant, textItemType);
  if (partType === "refusal") return normalizeChatRefusalContentPart(part, partParam, isAssistant, partCount);
  if (partType === "image_url") return normalizeChatImageContentPart(part, partParam, role);
  if (partType === "file") return normalizeChatFileContentPart(part, partParam, role);
  if (partType === "input_audio" && Object.prototype.hasOwnProperty.call(part, "prompt_cache_breakpoint")) {
    return invalidNormalizedField(`${partParam}.prompt_cache_breakpoint`, "prompt_cache_breakpoint is not supported for input_audio content in this gateway");
  }
  return invalidNormalizedField(`${partParam}.type`, `${partParam}.type is not supported`);
};

const normalizeChatContentItems = (role: ResponseMessageItem["role"], content: unknown, param: string): NormalizationResult<MessageContentItem[]> => {
  const isAssistant = role === "assistant";
  const textItemType: "input_text" | "output_text" = isAssistant ? "output_text" : "input_text";
  if (typeof content === "string") return { ok: true, value: [{ type: textItemType, text: content }] };
  if (content === null && isAssistant) return { ok: true, value: [] };
  if (!Array.isArray(content)) return invalidNormalizedField(param, `${param} must be a string or an array`);

  const items: MessageContentItem[] = [];
  for (const [index, part] of content.entries()) {
    const partParam = `${param}[${index}]`;
    if (!isRecord(part) || Array.isArray(part)) {
      return invalidNormalizedField(partParam, `${partParam} must be an object`);
    }
    const normalized = normalizeChatContentPart(part, partParam, role, isAssistant, textItemType, content.length);
    if (!normalized.ok) return normalized;
    items.push(normalized.value);
  }
  return { ok: true, value: items };
};

const messageContentToText = (items: MessageContentItem[]): string =>
  items
    .filter((item) => item.type === "input_text" || item.type === "output_text")
    .map((item) => item.text)
    .filter((text) => text.trim())
    .join("\n");

const chatRoleToCodexRole = (role: string): ResponseMessageItem["role"] | null => {
  if (role === "system") return "developer";
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "developer") return "developer";
  if (role === "tool") return "developer";
  return null;
};

export const normalizeModelForCodex = (model: string): string => {
  return model.trim();
};

const normalizeUnixSeconds = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const seconds = Math.trunc(value);
  return seconds >= 0 ? seconds : null;
};

const normalizeModelEntry = (value: unknown, fallbackCreated: number): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  const id = getString(value.id) ?? getString(value.slug) ?? getString(value.model) ?? getString(value.name);
  if (!id) return null;
  return {
    id,
    object: "model",
    created: normalizeUnixSeconds(value.created) ?? fallbackCreated,
    owned_by: getString(value.owned_by) ?? "openai",
  };
};

export const normalizeModelList = (payload: unknown): { object: "list"; data: Record<string, unknown>[] } | null => {
  if (!isRecord(payload)) return null;
  const fallbackCreated =
    typeof payload.updated_at_ms === "number" && Number.isFinite(payload.updated_at_ms) ? Math.max(0, Math.trunc(payload.updated_at_ms / 1000)) : 0;
  const data = Array.isArray(payload.data) ? payload.data : null;
  if (data) {
    const normalized = data.map((entry) => normalizeModelEntry(entry, fallbackCreated)).filter(Boolean) as Record<string, unknown>[];
    return { object: "list", data: normalized };
  }
  const models = Array.isArray(payload.models) ? payload.models : null;
  if (models) {
    const normalized = models.map((entry) => normalizeModelEntry(entry, fallbackCreated)).filter(Boolean) as Record<string, unknown>[];
    return { object: "list", data: normalized };
  }
  return null;
};

/** Human names for the two Cerebras ids, shared with the Codex catalog rows. */
export const CEREBRAS_MODEL_DISPLAY_NAMES: Record<string, string> = {
  [CEREBRAS_GPT_OSS_120B_MODEL]: "GPT-OSS 120B",
  [CEREBRAS_QWEN_3_8_27B_MODEL]: "Qwen 3.8 27B",
};

const configuredCerebrasModels = (): Record<string, unknown>[] =>
  readCerebrasApiKey()
    ? CEREBRAS_MODELS.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "cerebras",
      }))
    : [];

export const configuredCerebrasModelCapabilities = (model: string = CEREBRAS_GPT_OSS_120B_MODEL): Record<string, unknown> | null => {
  if (!readCerebrasApiKey()) return null;
  // Resolve to the provider's exact id first: the route matches ids
  // case-insensitively, so a differently-cased request must still get this
  // model's platform contract rather than the fallback default's.
  const id = cerebrasUpstreamModelFor(model);
  if (id === null) return null;
  const hint = cerebrasProviderHint(id);
  // Cerebras publishes no context window of its own, so the window on this row
  // comes from enrichment or stays null; the tiers are the route's declaration.
  const resolved = resolveModelMetadata(id, { provider: hint });
  return {
    id,
    object: "uos.model_capabilities",
    owned_by: "cerebras",
    display_name: CEREBRAS_MODEL_DISPLAY_NAMES[id] ?? id,
    upstream_provider: "cerebras",
    supported_endpoints: ["/v1/chat/completions"],
    supported_reasoning_levels: [...(hint.supported_reasoning_levels ?? [])],
    default_reasoning_effort: hint.default_reasoning_effort ?? "medium",
    reasoning_effort_wire_map: {},
    context_window_tokens: resolved.context_window_tokens,
    max_context_window_tokens: resolved.max_context_window_tokens,
    auto_compact_token_limit_tokens: resolved.auto_compact_token_limit_tokens,
    ...(resolved.effective_context_window_percent === null ? {} : { effective_context_window_percent: resolved.effective_context_window_percent }),
    context_source: resolved.context_source,
  };
};

export const withConfiguredCerebrasModel = (models: readonly Record<string, unknown>[], enabled: boolean): Record<string, unknown>[] => {
  const configured = enabled ? configuredCerebrasModels() : [];
  return [...models, ...configured.filter((candidate) => !models.some((model) => model.id === candidate.id))];
};

/**
 * The official DeepSeek ids are interchangeable aliases of one served model,
 * so both are advertised. Unlike the Cerebras entry, an id discovered from
 * another provider is REPLACED rather than skipped: once a request for that id
 * is dispatched to DeepSeek, a catalog row still naming the paid-fallback
 * provider (and its `["none"]` reasoning tiers) would misdescribe the route.
 */
const configuredDeepSeekModels = (): Record<string, unknown>[] =>
  readDeepSeekApiKey()
    ? DEEPSEEK_OFFICIAL_MODEL_IDS.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "deepseek",
      }))
    : [];

const configuredDeepSeekModelCapabilities = (): Record<string, unknown>[] => {
  if (!readDeepSeekApiKey()) return [];
  return DEEPSEEK_OFFICIAL_MODEL_IDS.map((id) => {
    // The official DeepSeek route declares one window for both interchangeable
    // ids; anything more specific comes from the dynamic sources.
    const resolved = resolveModelMetadata(id, {
      provider: { context_window_tokens: DEEPSEEK_CONTEXT_WINDOW_TOKENS, max_context_window_tokens: DEEPSEEK_CONTEXT_WINDOW_TOKENS },
    });
    return {
      id,
      object: "uos.model_capabilities",
      owned_by: "deepseek",
      display_name: DEEPSEEK_DISPLAY_NAMES[id] ?? id,
      upstream_provider: "deepseek",
      supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
      supported_reasoning_levels: [...DEEPSEEK_REASONING_LEVELS],
      default_reasoning_effort: DEEPSEEK_DEFAULT_REASONING_EFFORT,
      // `ultra` is the Codex CLI preset for maximum effort; DeepSeek documents
      // `max` as its wire tier for exactly that request.
      reasoning_effort_wire_map: { ultra: "max" },
      context_window_tokens: resolved.context_window_tokens,
      max_context_window_tokens: resolved.max_context_window_tokens,
      auto_compact_token_limit_tokens: resolved.auto_compact_token_limit_tokens,
      ...(resolved.effective_context_window_percent === null ? {} : { effective_context_window_percent: resolved.effective_context_window_percent }),
      context_source: resolved.context_source,
    };
  });
};

export const withConfiguredDeepSeekModels = (models: readonly Record<string, unknown>[], enabled: boolean): Record<string, unknown>[] => {
  const configured = enabled ? configuredDeepSeekModels() : [];
  if (!configured.length) return [...models];
  const ids = new Set(configured.map((model) => model.id));
  return [...models.filter((model) => !ids.has(getString(model.id) ?? "")), ...configured];
};

export const withConfiguredDeepSeekCapabilities = (data: readonly Record<string, unknown>[], enabled: boolean): Record<string, unknown>[] => {
  const configured = enabled ? configuredDeepSeekModelCapabilities() : [];
  if (!configured.length) return [...data];
  const ids = new Set(configured.map((model) => model.id));
  return [...data.filter((model) => !ids.has(getString(model.id) ?? "")), ...configured];
};

/**
 * The eight LithosAI ids. Unlike the DeepSeek aliases these are eight distinct
 * selectable ids, so each id is advertised in its own right; a row another
 * provider published for one of them is REPLACED, because once a request for
 * that id dispatches to LithosAI a row still naming the other provider would
 * misdescribe the route it now takes.
 */
const configuredLithosModels = (): Record<string, unknown>[] =>
  readLithosApiKey()
    ? LITHOS_MODEL_IDS.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "lithos",
      }))
    : [];

const configuredLithosModelCapabilities = (): Record<string, unknown>[] => {
  if (!readLithosApiKey()) return [];
  return LITHOS_MODEL_IDS.map((id) => {
    const resolved = resolveModelMetadata(id, { provider: LITHOS_PROVIDER_HINT });
    return {
      id,
      object: "uos.model_capabilities",
      owned_by: "lithos",
      display_name: LITHOS_DISPLAY_NAMES[id] ?? id,
      upstream_provider: "lithos",
      supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
      supported_reasoning_levels: [...LITHOS_REASONING_LEVELS],
      default_reasoning_effort: LITHOS_DEFAULT_REASONING_EFFORT,
      // This provider accepted all seven tiers verbatim on 2026-09-23 and
      // refused `ultra`, so no Codex preset is translated here and the map is
      // deliberately empty.
      reasoning_effort_wire_map: {},
      context_window_tokens: resolved.context_window_tokens,
      max_context_window_tokens: resolved.max_context_window_tokens,
      auto_compact_token_limit_tokens: resolved.auto_compact_token_limit_tokens,
      ...(resolved.effective_context_window_percent === null ? {} : { effective_context_window_percent: resolved.effective_context_window_percent }),
      context_source: resolved.context_source,
    };
  });
};

export const withConfiguredLithosModels = (models: readonly Record<string, unknown>[], enabled: boolean): Record<string, unknown>[] => {
  const configured = enabled ? configuredLithosModels() : [];
  if (!configured.length) return [...models];
  const ids = new Set(configured.map((model) => model.id));
  return [...models.filter((model) => !ids.has(getString(model.id) ?? "")), ...configured];
};

/** The gateway-owned DeepSeek waterfall id, listed whenever one hop is usable. */
const configuredDeepSeekWaterfallModels = (): Record<string, unknown>[] =>
  DEEPSEEK_WATERFALL_ORDER.some(deepSeekWaterfallProviderConfigured)
    ? [{ id: DEEPSEEK_WATERFALL_MODEL_ID, object: "model", created: DEEPSEEK_WATERFALL_CREATED, owned_by: "ubiquity" }]
    : [];

const configuredDeepSeekWaterfallModelCapabilities = (): Record<string, unknown>[] => {
  if (!DEEPSEEK_WATERFALL_ORDER.some(deepSeekWaterfallProviderConfigured)) return [];
  return [
    {
      id: DEEPSEEK_WATERFALL_MODEL_ID,
      object: "uos.model_capabilities",
      owned_by: "ubiquity",
      display_name: DEEPSEEK_WATERFALL_DISPLAY_NAME,
      upstream_provider: "ubiquity",
      supported_endpoints: ["/v1/responses"],
      supported_reasoning_levels: [...DEEPSEEK_WATERFALL_REASONING_LEVELS],
      default_reasoning_effort: DEEPSEEK_WATERFALL_DEFAULT_REASONING_LEVEL,
      reasoning_effort_wire_map: {},
      context_window_tokens: DEEPSEEK_WATERFALL_CONTEXT_WINDOW_TOKENS,
      max_context_window_tokens: DEEPSEEK_WATERFALL_CONTEXT_WINDOW_TOKENS,
      auto_compact_token_limit_tokens: DEEPSEEK_WATERFALL_AUTO_COMPACT_TOKEN_LIMIT,
      effective_context_window_percent: DEEPSEEK_WATERFALL_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
      // The window and tiers are the intersection measured across the candidate
      // providers; the source labels keep the admin surfaces honest about it.
      context_source: "openrouter",
      reasoning_source: "provider_discovery",
    },
  ];
};

export const withConfiguredDeepSeekWaterfallModels = (models: readonly Record<string, unknown>[], enabled: boolean): Record<string, unknown>[] => {
  const configured = enabled ? configuredDeepSeekWaterfallModels() : [];
  if (!configured.length) return [...models];
  const ids = new Set(configured.map((model) => model.id));
  return [...models.filter((model) => !ids.has(getString(model.id) ?? "")), ...configured];
};

export const withConfiguredDeepSeekWaterfallCapabilities = (data: readonly Record<string, unknown>[], enabled: boolean): Record<string, unknown>[] => {
  const configured = enabled ? configuredDeepSeekWaterfallModelCapabilities() : [];
  if (!configured.length) return [...data];
  const ids = new Set(configured.map((model) => model.id));
  return [...data.filter((model) => !ids.has(getString(model.id) ?? "")), ...configured];
};

/** The Typesafe System One decision model, served through the same upstream. */
export const OPENROUTER_SERVED_MODEL_ID = "typesafe/jev-latest";

/**
 * Everything this gateway can dispatch to OpenRouter: the cached public model
 * catalogue (OpenAI-compatible chat and responses wires) plus the Typesafe
 * System One decision model behind `/v1/systemone`. The dispatch path reads the
 * same snapshot, so a model listed here is a model that works, and a new
 * upstream model appears as soon as the cached list refreshes.
 */
const openRouterServedModels = (): readonly { id: string; endpoints: readonly string[]; ownedBy: string }[] => {
  if (readOpenRouterApiKey() === null) return [];
  const catalogue: { id: string; endpoints: readonly string[]; ownedBy: string }[] = (openRouterModelsSnapshot()?.models ?? []).map((model) => ({
    id: model.id,
    endpoints: ["/v1/responses", "/v1/chat/completions"] as const,
    ownedBy: model.id.split("/", 1)[0] || "openrouter",
  }));
  const seen = new Set(catalogue.map((model) => model.id));
  if (!seen.has(OPENROUTER_SERVED_MODEL_ID)) {
    catalogue.push({ id: OPENROUTER_SERVED_MODEL_ID, endpoints: ["/v1/systemone"] as const, ownedBy: "typesafe" });
  }
  return catalogue;
};

/**
 * OpenRouter's served rows are published by the upstream and refresh on the
 * cache TTL, so the listing routes append them after the operator whitelist
 * instead of letting a curated list hide ids the upstream already serves.
 */
export const configuredOpenRouterModels = (): Record<string, unknown>[] =>
  openRouterServedModels().map((model) => ({ id: model.id, object: "model", created: 0, owned_by: model.ownedBy }));

export const configuredOpenRouterModelCapabilities = (): Record<string, unknown>[] =>
  openRouterServedModels().map((model) => {
    const resolved = resolveModelMetadata(model.id);
    const defaultReasoningEffort = model.id === OPENROUTER_SERVED_MODEL_ID ? "none" : resolved.default_reasoning_effort;
    return {
      id: model.id,
      object: "uos.model_capabilities",
      owned_by: model.ownedBy,
      display_name: model.id === OPENROUTER_SERVED_MODEL_ID ? "Jev (Typesafe System One decisions)" : model.id,
      upstream_provider: "openrouter",
      supported_endpoints: [...model.endpoints],
      supported_reasoning_levels: model.id === OPENROUTER_SERVED_MODEL_ID ? ["none"] : (resolved.supported_reasoning_levels ?? ["none"]),
      ...(defaultReasoningEffort === null && resolved.supported_reasoning_levels !== null
        ? {}
        : { default_reasoning_effort: defaultReasoningEffort ?? "none" }),
      reasoning_effort_wire_map: {},
      context_window_tokens: model.id === OPENROUTER_SERVED_MODEL_ID ? null : resolved.context_window_tokens,
      max_context_window_tokens: model.id === OPENROUTER_SERVED_MODEL_ID ? null : resolved.max_context_window_tokens,
      auto_compact_token_limit_tokens: model.id === OPENROUTER_SERVED_MODEL_ID ? null : resolved.auto_compact_token_limit_tokens,
      context_source: model.id === OPENROUTER_SERVED_MODEL_ID ? "unknown" : resolved.context_source,
      reasoning_source: model.id === OPENROUTER_SERVED_MODEL_ID ? "unknown" : resolved.reasoning_source,
    };
  });

export const withConfiguredLithosCapabilities = (data: readonly Record<string, unknown>[], enabled: boolean): Record<string, unknown>[] => {
  const configured = enabled ? configuredLithosModelCapabilities() : [];
  if (!configured.length) return [...data];
  const ids = new Set(configured.map((model) => model.id));
  return [...data.filter((model) => !ids.has(getString(model.id) ?? "")), ...configured];
};

export const normalizeModelCapabilitiesEntry = (value: unknown): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  const id = modelIdFromSnapshotRecord(value);
  if (!id) return null;
  const reasoning = getCodexModelReasoning(value);
  const promptCache = normalizePromptCacheCapabilities(value.prompt_cache);
  // The uploaded catalog is authoritative whenever it publishes a value; the
  // dynamic sources only fill what it leaves unstated.
  const resolved = resolveModelMetadata(id, { codex: codexSnapshotMetadataHint(value), codexSubscription: codexSubscriptionMetadataHint() });
  return {
    id,
    object: "uos.model_capabilities",
    owned_by: getString(value.owned_by) ?? "openai",
    display_name: getString(value.display_name),
    upstream_provider: "codex_chatgpt",
    supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
    supported_reasoning_levels: reasoning.levels,
    default_reasoning_effort: reasoning.defaultLevel,
    reasoning_effort_wire_map: Object.fromEntries(reasoning.wireEfforts),
    context_window_tokens: resolved.context_window_tokens,
    max_context_window_tokens: resolved.max_context_window_tokens,
    auto_compact_token_limit_tokens: resolved.auto_compact_token_limit_tokens,
    ...(resolved.effective_context_window_percent === null ? {} : { effective_context_window_percent: resolved.effective_context_window_percent }),
    context_source: resolved.context_source,
    reasoning_source: resolved.reasoning_source,
    ...(promptCache !== null ? { prompt_cache: promptCache } : {}),
  };
};

const normalizeResponseTextContentItem = (
  value: Record<string, unknown>,
  partType: "input_text" | "output_text",
  param: string,
  role: ResponseMessageItem["role"]
): NormalizationResult<MessageContentItem> => {
  if (partType === "output_text" && role !== "assistant") {
    return invalidNormalizedField(`${param}.type`, `${param}.type is only valid for assistant messages`);
  }
  const unknown = findUnknownContentField(value, partType === "output_text" ? ["type", "text", "annotations"] : ["type", "text", "prompt_cache_breakpoint"]);
  if (unknown) return invalidNormalizedField(`${param}.${unknown}`, `Unknown content field: ${unknown}`);
  if (typeof value.text !== "string") {
    return invalidNormalizedField(`${param}.text`, `${param}.text must be a string`);
  }
  if (partType === "output_text" && value.annotations !== undefined && !Array.isArray(value.annotations)) {
    return invalidNormalizedField(`${param}.annotations`, `${param}.annotations must be an array`);
  }
  if (partType === "output_text") return { ok: true, value: { type: partType, text: value.text } };
  const breakpoint = normalizePromptCacheBreakpoint(value.prompt_cache_breakpoint, `${param}.prompt_cache_breakpoint`);
  if (!breakpoint.ok) return breakpoint;
  return {
    ok: true,
    value: withPromptCacheBreakpoint({ type: "input_text", text: value.text }, breakpoint.value),
  };
};

const normalizeResponseImageContentItem = (value: Record<string, unknown>, param: string): NormalizationResult<MessageContentItem> => {
  const unknown = findUnknownContentField(value, ["type", "image_url", "file_id", "detail", "prompt_cache_breakpoint"]);
  if (unknown) return invalidNormalizedField(`${param}.${unknown}`, `Unknown content field: ${unknown}`);
  const imageUrl = getString(value.image_url)?.trim() ?? "";
  const fileId = getString(value.file_id)?.trim() ?? "";
  if ((imageUrl && fileId) || (!imageUrl && !fileId)) {
    return invalidNormalizedField(`${param}.image_url`, `${param} must include exactly one of image_url or file_id`);
  }
  if (value.image_url !== undefined && typeof value.image_url !== "string") {
    return invalidNormalizedField(`${param}.image_url`, `${param}.image_url must be a string`);
  }
  if (value.file_id !== undefined && typeof value.file_id !== "string") {
    return invalidNormalizedField(`${param}.file_id`, `${param}.file_id must be a string`);
  }
  const detail = parseImageDetail(value.detail, `${param}.detail`);
  if (!detail.ok) return detail;
  const breakpoint = normalizePromptCacheBreakpoint(value.prompt_cache_breakpoint, `${param}.prompt_cache_breakpoint`);
  if (!breakpoint.ok) return breakpoint;
  const item: Extract<MessageContentItem, { type: "input_image" }> = imageUrl
    ? { type: "input_image", image_url: imageUrl }
    : { type: "input_image", file_id: fileId };
  if (detail.value === undefined) return { ok: true, value: withPromptCacheBreakpoint(item, breakpoint.value) };
  return { ok: true, value: withPromptCacheBreakpoint({ ...item, detail: detail.value }, breakpoint.value) };
};

const responseFileContentItem = (value: Record<string, unknown>, detail: InputFileDetail | undefined): Extract<MessageContentItem, { type: "input_file" }> => {
  const item: {
    type: "input_file";
    file_id?: string;
    file_data?: string;
    file_url?: string;
    filename?: string | null;
    detail?: InputFileDetail;
  } = { type: "input_file" };
  for (const field of ["file_id", "file_data", "file_url"] as const) {
    const fieldValue = getString(value[field]);
    if (fieldValue) item[field] = fieldValue;
  }
  if (Object.prototype.hasOwnProperty.call(value, "filename")) item.filename = value.filename as string | null;
  if (detail !== undefined) item.detail = detail;
  return item;
};

const normalizeResponseFileContentItem = (value: Record<string, unknown>, param: string): NormalizationResult<MessageContentItem> => {
  const unknown = findUnknownContentField(value, ["type", "file_id", "file_data", "file_url", "filename", "detail", "prompt_cache_breakpoint"]);
  if (unknown) return invalidNormalizedField(`${param}.${unknown}`, `Unknown content field: ${unknown}`);
  const fields = ["file_id", "file_data", "file_url"] as const;
  const present = fields.filter((field) => typeof value[field] === "string" && value[field].trim());
  if (!present.length) {
    return invalidNormalizedField(`${param}.file_id`, `${param} must include file_id, file_data, or file_url`);
  }
  for (const field of fields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return invalidNormalizedField(`${param}.${field}`, `${param}.${field} must be a string`);
    }
  }
  if (value.filename !== undefined && value.filename !== null && typeof value.filename !== "string") {
    return invalidNormalizedField(`${param}.filename`, `${param}.filename must be a string or null`);
  }
  const detail = parseInputFileDetail(value.detail, `${param}.detail`);
  if (!detail.ok) return detail;
  const breakpoint = normalizePromptCacheBreakpoint(value.prompt_cache_breakpoint, `${param}.prompt_cache_breakpoint`);
  if (!breakpoint.ok) return breakpoint;
  return { ok: true, value: withPromptCacheBreakpoint(responseFileContentItem(value, detail.value), breakpoint.value) };
};

export const normalizeResponseContentItem = (value: unknown, param: string, role: ResponseMessageItem["role"]): NormalizationResult<MessageContentItem> => {
  if (!isRecord(value) || Array.isArray(value)) {
    return invalidNormalizedField(param, `${param} must be an object`);
  }
  const partType = getString(value.type);
  if (!partType) return invalidNormalizedField(`${param}.type`, `${param}.type must be a string`);

  if (partType === "input_text" || partType === "output_text") return normalizeResponseTextContentItem(value, partType, param, role);
  if (partType === "input_image") return normalizeResponseImageContentItem(value, param);
  if (partType === "input_file") return normalizeResponseFileContentItem(value, param);
  return invalidNormalizedField(`${param}.type`, `${param}.type is not supported`);
};

export const normalizeResponseMessageItem = (value: unknown, param: string): NormalizationResult<ResponseMessageItem> => {
  if (!isRecord(value) || Array.isArray(value)) return invalidNormalizedField(param, `${param} must be an object`);
  if (Object.prototype.hasOwnProperty.call(value, "prompt_cache_breakpoint")) {
    return invalidNormalizedField(`${param}.prompt_cache_breakpoint`, "prompt_cache_breakpoint is only valid on supported input content blocks");
  }
  if (Object.prototype.hasOwnProperty.call(value, "type") && value.type !== "message") {
    return invalidNormalizedField(`${param}.type`, `${param}.type must be message`);
  }
  const roleRaw = getString(value.role);
  // Native Responses tool output is a top-level function_call_output item;
  // do not silently reinterpret a message role:"tool" as developer text.
  const role = roleRaw && roleRaw !== "tool" ? chatRoleToCodexRole(roleRaw) : null;
  if (!role) return invalidNormalizedField(`${param}.role`, `${param}.role is invalid`);
  const content = value.content;
  if (typeof content === "string") {
    return {
      ok: true,
      value: {
        type: "message",
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text: content }],
      },
    };
  }
  if (!Array.isArray(content)) {
    return invalidNormalizedField(`${param}.content`, `${param}.content must be a string or an array`);
  }
  const items: MessageContentItem[] = [];
  for (const [index, part] of content.entries()) {
    const normalized = normalizeResponseContentItem(part, `${param}.content[${index}]`, role);
    if (!normalized.ok) return normalized;
    items.push(normalized.value);
  }
  return { ok: true, value: { type: "message", role, content: items } };
};

/**
 * Responses permits a function-call result to carry the same input content
 * blocks as a message. Normalize that known standard shape so cache
 * breakpoints are neither passed through unchecked nor omitted from telemetry.
 * Other Codex Responses extension items remain opaque passthrough values.
 */
export const normalizeFunctionCallOutputItem = (value: Record<string, unknown>, param: string): NormalizationResult<ResponseInputItem> => {
  if (value.type !== "function_call_output" || !Array.isArray(value.output)) {
    return { ok: true, value: value as ResponseInputItem };
  }
  const output: MessageContentItem[] = [];
  for (const [index, content] of value.output.entries()) {
    const normalized = normalizeResponseContentItem(content, `${param}.output[${index}]`, "user");
    if (!normalized.ok) return normalized;
    output.push(normalized.value);
  }
  return { ok: true, value: { ...value, type: "function_call_output", output } };
};

const normalizeChatToolCall = (value: unknown, param: string): NormalizationResult<Readonly<Record<string, unknown> & { type: "function_call" }>> => {
  if (!isRecord(value) || Array.isArray(value)) return invalidNormalizedField(param, `${param} must be an object`);
  const unknownField = findUnknownContentField(value, ["id", "type", "function"]);
  if (unknownField) {
    return invalidNormalizedField(`${param}.${unknownField}`, `Unknown tool call field: ${unknownField}`);
  }
  if (value.type !== "function") {
    return invalidNormalizedField(`${param}.type`, `${param}.type must be function`);
  }
  const callId = getString(value.id)?.trim();
  if (!callId) return invalidNormalizedField(`${param}.id`, `${param}.id must be a non-empty string`);
  if (!isRecord(value.function) || Array.isArray(value.function)) {
    return invalidNormalizedField(`${param}.function`, `${param}.function must be an object`);
  }
  const unknownFunctionField = findUnknownContentField(value.function, ["name", "arguments"]);
  if (unknownFunctionField) {
    return invalidNormalizedField(`${param}.function.${unknownFunctionField}`, `Unknown tool call function field: ${unknownFunctionField}`);
  }
  const name = getString(value.function.name)?.trim();
  if (!name) {
    return invalidNormalizedField(`${param}.function.name`, `${param}.function.name must be a non-empty string`);
  }
  if (typeof value.function.arguments !== "string") {
    return invalidNormalizedField(`${param}.function.arguments`, `${param}.function.arguments must be a string`);
  }
  // Arguments are an opaque JSON string in the Chat contract. Do not parse,
  // validate, or reserialize them: callers rely on byte-for-byte fidelity.
  return {
    ok: true,
    value: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: value.function.arguments,
    },
  };
};

const normalizeChatToolOutput = (value: unknown, param: string): NormalizationResult<string | Extract<MessageContentItem, { type: "input_text" }>[]> => {
  if (typeof value === "string") return { ok: true, value };
  if (!Array.isArray(value)) return invalidNormalizedField(param, `${param} must be a string or an array`);
  const output: Extract<MessageContentItem, { type: "input_text" }>[] = [];
  for (const [index, part] of value.entries()) {
    const partParam = `${param}[${index}]`;
    if (!isRecord(part) || Array.isArray(part)) {
      return invalidNormalizedField(partParam, `${partParam} must be an object`);
    }
    const type = getString(part.type);
    if (type !== "text") {
      return invalidNormalizedField(`${partParam}.type`, `${partParam}.type must be a text content part`);
    }
    const unknown = findUnknownContentField(part, ["type", "text", "prompt_cache_breakpoint"]);
    if (unknown) return invalidNormalizedField(`${partParam}.${unknown}`, `Unknown content field: ${unknown}`);
    if (typeof part.text !== "string") {
      return invalidNormalizedField(`${partParam}.text`, `${partParam}.text must be a string`);
    }
    const breakpoint = normalizePromptCacheBreakpoint(part.prompt_cache_breakpoint, `${partParam}.prompt_cache_breakpoint`);
    if (!breakpoint.ok) return breakpoint;
    output.push(withPromptCacheBreakpoint({ type: "input_text", text: part.text }, breakpoint.value));
  }
  return { ok: true, value: output };
};

const normalizeChatToolMessage = (
  value: Record<string, unknown>,
  param: string
): NormalizationResult<Readonly<{ instruction: string | null; instructionContent: MessageContentItem[] | null; input: ResponseInputItem[] }>> => {
  if (Object.prototype.hasOwnProperty.call(value, "tool_calls")) {
    return invalidNormalizedField(`${param}.tool_calls`, "tool_calls are only valid for assistant messages");
  }
  const callId = getString(value.tool_call_id)?.trim();
  if (!callId) {
    return invalidNormalizedField(`${param}.tool_call_id`, `${param}.tool_call_id must be a non-empty string`);
  }
  const output = normalizeChatToolOutput(value.content, `${param}.content`);
  if (!output.ok) return output;
  return {
    ok: true,
    value: {
      instruction: null,
      instructionContent: null,
      input: [{ type: "function_call_output", call_id: callId, output: output.value }],
    },
  };
};

const appendChatToolCallInputs = (input: ResponseInputItem[], toolCalls: unknown, param: string): NormalizationResult<void> => {
  if (!Array.isArray(toolCalls)) {
    return invalidNormalizedField(`${param}.tool_calls`, `${param}.tool_calls must be an array`);
  }
  for (const [callIndex, call] of toolCalls.entries()) {
    const normalized = normalizeChatToolCall(call, `${param}.tool_calls[${callIndex}]`);
    if (!normalized.ok) return normalized;
    input.push(normalized.value);
  }
  return { ok: true, value: undefined };
};

const normalizeChatAssistantMessage = (
  value: Record<string, unknown>,
  param: string,
  role: ResponseMessageItem["role"]
): NormalizationResult<Readonly<{ instruction: string | null; instructionContent: MessageContentItem[] | null; input: ResponseInputItem[] }>> => {
  const hasToolCalls = Object.prototype.hasOwnProperty.call(value, "tool_calls");
  const refusal = value.refusal === undefined || value.refusal === null ? null : getString(value.refusal);
  if (refusal === null && value.refusal !== undefined && value.refusal !== null) {
    return invalidNormalizedField(`${param}.refusal`, `${param}.refusal must be a string or null`);
  }
  // Chat permits an omitted assistant content field when the message is
  // solely a function-call turn. Normalize it as the same empty content as
  // the explicit null form, but keep missing content invalid otherwise.
  const content =
    value.content === undefined && hasToolCalls
      ? { ok: true as const, value: [] as MessageContentItem[] }
      : normalizeChatContentItems(role, value.content, `${param}.content`);
  if (!content.ok) return content;
  const input: ResponseInputItem[] = [];
  // A Chat assistant's natural-language output must precede its function
  // calls so a multi-turn tool conversation retains the original order.
  const messageContent = refusal === null ? content.value : [...content.value, { type: "output_text" as const, text: refusal }];
  if (messageContent.length) input.push({ type: "message", role, content: messageContent });
  if (hasToolCalls) {
    const toolCalls = appendChatToolCallInputs(input, value.tool_calls, param);
    if (!toolCalls.ok) return toolCalls;
  }
  if (!input.length) {
    return invalidNormalizedField(`${param}.content`, "assistant messages require content, refusal, or tool_calls");
  }
  return { ok: true, value: { instruction: null, instructionContent: null, input } };
};

const normalizeChatPlainMessage = (
  value: Record<string, unknown>,
  param: string,
  role: ResponseMessageItem["role"],
  roleRaw: string
): NormalizationResult<Readonly<{ instruction: string | null; instructionContent: MessageContentItem[] | null; input: ResponseInputItem[] }>> => {
  const content = normalizeChatContentItems(role, value.content, `${param}.content`);
  if (!content.ok) return content;

  if (roleRaw === "system" || roleRaw === "developer") {
    if (Object.prototype.hasOwnProperty.call(value, "tool_calls")) {
      return invalidNormalizedField(`${param}.tool_calls`, "tool_calls are only valid for assistant messages");
    }
    return {
      ok: true,
      value: { instruction: messageContentToText(content.value), instructionContent: content.value, input: [] },
    };
  }

  if (Object.prototype.hasOwnProperty.call(value, "tool_calls")) {
    return invalidNormalizedField(`${param}.tool_calls`, "tool_calls are only valid for assistant messages");
  }
  return {
    ok: true,
    value: { instruction: null, instructionContent: null, input: [{ type: "message", role, content: content.value }] },
  };
};

export const normalizeChatMessage = (
  value: unknown,
  index: number
): NormalizationResult<Readonly<{ instruction: string | null; instructionContent: MessageContentItem[] | null; input: ResponseInputItem[] }>> => {
  const param = `messages[${index}]`;
  if (!isRecord(value) || Array.isArray(value)) return invalidNormalizedField(param, `${param} must be an object`);
  if (Object.prototype.hasOwnProperty.call(value, "prompt_cache_breakpoint")) {
    return invalidNormalizedField(`${param}.prompt_cache_breakpoint`, "prompt_cache_breakpoint is only valid on supported input content blocks");
  }
  const roleRaw = getString(value.role);
  if (!roleRaw) return invalidNormalizedField(`${param}.role`, `${param}.role must be a string`);
  const role = chatRoleToCodexRole(roleRaw);
  if (!role) return invalidNormalizedField(`${param}.role`, `${param}.role is not supported`);

  if (roleRaw === "tool") return normalizeChatToolMessage(value, param);

  if (Object.prototype.hasOwnProperty.call(value, "tool_call_id")) {
    return invalidNormalizedField(`${param}.tool_call_id`, "tool_call_id is only valid for tool messages");
  }
  if (roleRaw === "assistant") return normalizeChatAssistantMessage(value, param, role);
  return normalizeChatPlainMessage(value, param, role, roleRaw);
};
