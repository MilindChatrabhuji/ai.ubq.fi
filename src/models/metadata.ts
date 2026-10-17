import { normalizeReasoningEffort, type ReasoningEffort } from "../defaults.ts";
import { openRouterMetadataFor, type OpenRouterModelMetadata } from "./openrouter-models.ts";
import { CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT, resolvedAutoCompactTokenLimit } from "../recent-model-context.ts";

/**
 * One place resolves what the gateway knows about a model.
 *
 * Context windows come from `openrouter`, which publishes the model's real
 * maximum. The Codex endpoint's own catalog understates what it accepts: 916,463
 * tokens verified for `gpt-6-astra` against a 272,000 served window and an
 * 872,000 override cap that Codex clamps client overrides to. OpenRouter leads
 * the candidate list and breaks ties; a narrower third-party entry never shrinks
 * a route below what that route itself declares, and the Codex subscription bound
 * is the last resort so a Codex-served id is never reported as unknown.
 *
 * Reasoning tiers keep the opposite order — `codex_upload`, then the serving
 * provider, then OpenRouter — because the uploaded catalog is authoritative for
 * the tier strings the gateway must preserve verbatim.
 *
 * The curated per-model tables this replaced are commented out in
 * `src/recent_model_context.ts`. Nothing here invents a value: an id no source
 * describes resolves to nulls and reports `unknown`, so a gap shows up as a gap
 * instead of as a plausible-looking wrong number. Derivation is still allowed and
 * is labeled as such — the auto-compaction limit is computed from a known
 * context window by the shared 85%-or-50k-reserve rule, which is arithmetic, not
 * per-model knowledge.
 */
export type ModelMetadataSource = "codex_upload" | "codex_subscription" | "provider_discovery" | "openrouter" | "unknown";

/**
 * What a single source claims about a model, in upstream vocabulary: Codex
 * snapshot records use `context_window`/`default_reasoning_level`, and callers
 * adapt those before handing them over.
 */
export type ModelMetadataHint = Readonly<{
  context_window_tokens?: number | null;
  max_context_window_tokens?: number | null;
  auto_compact_token_limit_tokens?: number | null;
  effective_context_window_percent?: number | null;
  supported_reasoning_levels?: readonly unknown[] | null;
  default_reasoning_effort?: unknown;
}>;

export type ResolvedModelMetadata = Readonly<{
  context_window_tokens: number | null;
  max_context_window_tokens: number | null;
  auto_compact_token_limit_tokens: number | null;
  effective_context_window_percent: number | null;
  supported_reasoning_levels: readonly ReasoningEffort[] | null;
  default_reasoning_effort: ReasoningEffort | null;
  context_source: ModelMetadataSource;
  reasoning_source: ModelMetadataSource;
}>;

export type ModelMetadataSources = Readonly<{
  codex?: ModelMetadataHint | null;
  /**
   * The conservative Codex-subscription bound, passed by callers that know the
   * id is served by the Codex subscription. It outranks provider discovery and
   * enrichment so a subscription model never advertises a window Codex will not
   * honor, and it never overrides a window the upload stated.
   */
  codexSubscription?: ModelMetadataHint | null;
  provider?: ModelMetadataHint | null;
  openRouter?: OpenRouterModelMetadata | null;
}>;

const positiveTokenCount = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

const firstTokenCount = (...values: readonly unknown[]): number | null => {
  for (const value of values) {
    const resolved = positiveTokenCount(value);
    if (resolved !== null) return resolved;
  }
  return null;
};

/**
 * Advertised tiers arrive as bare strings, `null` (an explicit no-reasoning
 * entry), or `{ effort }` objects. Every non-empty advertised tier is preserved
 * in its advertised order: the gateway has no tier allowlist to enforce.
 */
const advertisedReasoningLevels = (levels: readonly unknown[] | null | undefined): ReasoningEffort[] => {
  if (!Array.isArray(levels)) return [];
  const resolved: ReasoningEffort[] = [];
  for (const entry of levels) {
    const raw = entry !== null && typeof entry === "object" && "effort" in entry ? (entry as { effort?: unknown }).effort : entry;
    const level = raw === null ? "none" : normalizeReasoningEffort(raw);
    if (level && !resolved.includes(level)) resolved.push(level);
  }
  return resolved;
};

const openRouterHint = (metadata: OpenRouterModelMetadata): ModelMetadataHint => ({
  context_window_tokens: metadata.context_window_tokens,
  max_context_window_tokens: metadata.max_context_window_tokens,
  supported_reasoning_levels: metadata.reasoning?.supported_efforts ?? null,
  default_reasoning_effort: metadata.reasoning?.default_effort ?? null,
});

/**
 * Advertised tiers pass through verbatim, plus the source's own default level when
 * it did not list it. No tier is invented: the upstream rejects an effort its
 * catalog omits (`gpt-6-astra` refuses `none`), so a fabricated tier is a promise
 * the endpoint breaks with a 400.
 */
const withDefaultLevel = (
  advertised: readonly ReasoningEffort[],
  defaultLevel: ReasoningEffort | null
): { levels: readonly ReasoningEffort[]; defaultLevel: ReasoningEffort | null } => {
  const levels = [...advertised];
  return { levels: defaultLevel && !levels.includes(defaultLevel) ? [...levels, defaultLevel] : levels, defaultLevel };
};

/**
 * Adapt a Codex snapshot record to a hint. The uploaded catalog publishes
 * `context_window`, `max_context_window`, `auto_compact_token_limit` and
 * `effective_context_window_percent` as plain numbers, a
 * `supported_reasoning_levels` array whose entries are bare strings, `null`, or
 * `{ effort }` objects, and a `default_reasoning_level` whose explicit `null`
 * means `none`.
 */
export const codexSnapshotMetadataHint = (record: Record<string, unknown> | null | undefined): ModelMetadataHint | null => {
  if (!record) return null;
  const explicitNoneDefault = Object.prototype.hasOwnProperty.call(record, "default_reasoning_level") && record.default_reasoning_level === null;
  return {
    context_window_tokens: positiveTokenCount(record.context_window),
    max_context_window_tokens: positiveTokenCount(record.max_context_window),
    auto_compact_token_limit_tokens: positiveTokenCount(record.auto_compact_token_limit),
    effective_context_window_percent: positiveTokenCount(record.effective_context_window_percent),
    supported_reasoning_levels: Array.isArray(record.supported_reasoning_levels) ? record.supported_reasoning_levels : null,
    default_reasoning_effort: explicitNoneDefault ? "none" : record.default_reasoning_level,
  };
};

/**
 * The window a Codex subscription serves when the uploaded catalog does not state
 * one. A subscription serves frontier models below their API-level maximum, and
 * third-party catalogs publish that larger maximum, so falling through to
 * enrichment would advertise a window the subscription cannot honor. Measured
 * from the uploaded catalog on 2026-09-17: every Codex-served id reports
 * `context_window` 272,000 with `max_context_window` 872,000.
 *
 * This is a conservative deployment bound, not per-model curation: an explicit
 * window in the uploaded catalog still wins, and ids Codex does not serve are
 * untouched.
 */
export const CODEX_SUBSCRIPTION_CONTEXT_WINDOW_TOKENS = 272_000;
export const CODEX_SUBSCRIPTION_MAX_CONTEXT_WINDOW_TOKENS = 872_000;

/** The conservative Codex window as a hint, for Codex-served ids the upload leaves unstated. */
export const codexSubscriptionMetadataHint = (): ModelMetadataHint => ({
  context_window_tokens: CODEX_SUBSCRIPTION_CONTEXT_WINDOW_TOKENS,
  max_context_window_tokens: CODEX_SUBSCRIPTION_MAX_CONTEXT_WINDOW_TOKENS,
});

/**
 * OpenRouter is the capability catalog for context windows: it publishes the
 * model's real maximum, while the Codex endpoint's catalog understates what it
 * accepts (916,463 tokens verified for `gpt-6-astra` against a 272,000 served
 * window and an 872,000 override cap). First-party statements only fill ids
 * OpenRouter does not know, in descending authority. A client that wants to stay
 * inside a cheaper tier sets its own window or compaction limit.
 */
const windowFrom = (
  candidates: readonly (readonly [ModelMetadataSource, number | null])[]
): Readonly<{ tokens: number | null; source: ModelMetadataSource }> => {
  let tokens: number | null = null;
  let source: ModelMetadataSource = "unknown";
  for (const [candidateSource, value] of candidates) {
    const count = positiveTokenCount(value);
    if (count === null) continue;
    // OpenRouter leads the list, so it also breaks ties. A narrower third-party
    // entry never shrinks a route below what the route itself declares.
    if (tokens === null || count > tokens) {
      tokens = count;
      source = candidateSource;
    }
  }
  return { tokens, source };
};

const hintWindow = (hint: ModelMetadataHint | null): number | null =>
  positiveTokenCount(hint?.context_window_tokens) ?? positiveTokenCount(hint?.max_context_window_tokens);

/** The wider of a declared maximum and the active window it has to contain. */
const containingWindow = (contextWindow: number | null, declaredMaxWindow: number | null): number | null => {
  if (contextWindow === null) return declaredMaxWindow;
  if (declaredMaxWindow === null) return contextWindow;
  return Math.max(contextWindow, declaredMaxWindow);
};

type ReasoningResolution = Readonly<{
  levels: readonly ReasoningEffort[];
  defaultLevel: ReasoningEffort | null;
  source: ModelMetadataSource;
}>;

/** First source, in precedence order, that advertises at least one tier. */
const reasoningFrom = (codex: ModelMetadataHint | null, provider: ModelMetadataHint | null, enrichment: ModelMetadataHint | null): ReasoningResolution => {
  const candidates: readonly (readonly [ModelMetadataSource, ModelMetadataHint | null])[] = [
    ["codex_upload", codex],
    ["provider_discovery", provider],
    ["openrouter", enrichment],
  ];
  for (const [source, hint] of candidates) {
    const resolved = withDefaultLevel(advertisedReasoningLevels(hint?.supported_reasoning_levels), normalizeReasoningEffort(hint?.default_reasoning_effort));
    if (resolved.levels.length) return { ...resolved, source };
  }
  return { levels: [], defaultLevel: null, source: "unknown" };
};

export const resolveModelMetadata = (modelId: string, sources: ModelMetadataSources = {}): ResolvedModelMetadata => {
  const openRouter = sources.openRouter === undefined ? openRouterMetadataFor(modelId) : sources.openRouter;
  const codex = sources.codex ?? null;
  const subscription = sources.codexSubscription ?? null;
  const provider = sources.provider ?? null;
  const enrichment = openRouter ? openRouterHint(openRouter) : null;
  // Once the uploaded endpoint declares a window, its subscription bound is
  // only a fallback and must not participate as a wider peer candidate.
  const subscriptionFallback = hintWindow(codex) === null ? subscription : null;

  const resolvedWindow = windowFrom([
    ["openrouter", hintWindow(enrichment)],
    ["codex_upload", hintWindow(codex)],
    ["provider_discovery", hintWindow(provider)],
    ["codex_subscription", hintWindow(subscriptionFallback)],
  ]);
  const contextWindow = resolvedWindow.tokens;
  const declaredMaxWindow = windowFrom([
    ["openrouter", positiveTokenCount(enrichment?.max_context_window_tokens)],
    ["codex_upload", positiveTokenCount(codex?.max_context_window_tokens)],
    ["provider_discovery", positiveTokenCount(provider?.max_context_window_tokens)],
    ["codex_subscription", positiveTokenCount(subscriptionFallback?.max_context_window_tokens)],
  ]).tokens;
  const declaredAutoCompact = firstTokenCount(codex?.auto_compact_token_limit_tokens, provider?.auto_compact_token_limit_tokens);
  const declaredPercent = codex?.effective_context_window_percent ?? provider?.effective_context_window_percent;
  const reasoning = reasoningFrom(codex, provider, enrichment);

  return {
    context_window_tokens: contextWindow,
    max_context_window_tokens: containingWindow(contextWindow, declaredMaxWindow),
    auto_compact_token_limit_tokens: contextWindow === null ? declaredAutoCompact : resolvedAutoCompactTokenLimit(contextWindow, declaredAutoCompact),
    effective_context_window_percent: positiveTokenCount(declaredPercent) ?? (contextWindow === null ? null : CODEX_EFFECTIVE_CONTEXT_WINDOW_PERCENT),
    supported_reasoning_levels: reasoning.levels.length ? reasoning.levels : null,
    default_reasoning_effort: reasoning.defaultLevel,
    context_source: resolvedWindow.source,
    reasoning_source: reasoning.source,
  };
};
