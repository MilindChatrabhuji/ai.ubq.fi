// `ubiquity/deepseek-flash` — the synthetic, versionless DeepSeek Flash model
// that walks the measured provider waterfall on the client's behalf. The order
// is data from the 2026-10-06 benchmark (docs/deepseek-waterfall-model-plan.md)
// with the 2026-10-07 economy reorder (docs/DECISIONS.md), not control flow: the
// cost-first order runs the direct routes, then the paid hops through the
// ordinary paid pipeline, and pins each paid hop to its own tier. Provider model
// ids are the provider-owned latest aliases, so a DeepSeek release does not
// require a gateway rename or a per-release code change.

import type { DeepSeekWaterfallFallbackReason } from "../openai-telemetry.ts";
import { readMeteredApiKey } from "../provider/metered.ts";
import { readSurplusApiKey } from "../provider/surplus.ts";
import { readDeepSeekApiKey } from "./index.ts";
import { readLithosApiKey } from "../provider/lithos.ts";
import { readOpenRouterApiKey } from "../provider/openrouter.ts";
import { GATEWAY_PROVIDER_ID } from "../provider/presentation.ts";
import { isProviderEnabled, type ProviderSelection } from "../provider/selection.ts";
import { DEEPSEEK_FLASH_FALLBACK_ALIASES, type DeepSeekFlashProvider } from "./flash-aliases.ts";

export const DEEPSEEK_WATERFALL_MODEL_ID = "ubiquity/deepseek-flash";
/** The pre-rename id remains accepted for clients and saved sessions. */
export const DEEPSEEK_WATERFALL_LEGACY_MODEL_ID = "ubiquity/deepseek-v4.1-flash";
export const DEEPSEEK_WATERFALL_DISPLAY_NAME = "Ubiquity DeepSeek Flash";
export const DEEPSEEK_WATERFALL_DESCRIPTION =
  "Latest DeepSeek Flash waterfall: official DeepSeek, OpenRouter, LithosAI, Surplus, and OpenLux. Each hop uses the provider's latest alias and falls back only on infrastructure or serving failures.";
export const DEEPSEEK_WATERFALL_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const DEEPSEEK_WATERFALL_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;
export const DEEPSEEK_WATERFALL_AUTO_COMPACT_TOKEN_LIMIT = 891_289;
/** Stable creation instant for catalogue rows (2026-10-06T00:00:00Z). */
export const DEEPSEEK_WATERFALL_CREATED = 1_791_244_800;
export const DEEPSEEK_WATERFALL_REASONING_LEVELS = ["low", "high", "max"] as const;
export const DEEPSEEK_WATERFALL_DEFAULT_REASONING_LEVEL = "high";

export type DeepSeekWaterfallProvider = DeepSeekFlashProvider;

/**
 * The paid catalogue alias used by the Surplus and OpenLux hops. Paid hops
 * re-enter the ordinary Responses pipeline under this provider-owned alias so
 * admission, reservation and ledger settlement stay the paid path's.
 */
export const DEEPSEEK_WATERFALL_PAID_MODEL_ID = DEEPSEEK_FLASH_FALLBACK_ALIASES.models.surplus;

/**
 * The cost-first economy order (2026-10-07): LithosAI Base and the DeepSeek
 * off-peak rate are half of OpenRouter's per-token price for the same weights,
 * so the cheaper direct routes lead. Surplus and OpenLux are the two paid hops
 * and are each pinned to their own tier by {@link DEEPSEEK_WATERFALL_PAID_PIN}.
 */
export const DEEPSEEK_WATERFALL_ORDER: readonly DeepSeekWaterfallProvider[] = ["lithos", "deepseek", "openrouter", "surplus", "openlux"];

/**
 * The provider-owned latest alias each hop is dispatched with. These are not
 * gateway release pins: no snapshot date or gateway-side version is encoded.
 */
export const DEEPSEEK_WATERFALL_PROVIDER_MODEL: Readonly<Record<DeepSeekWaterfallProvider, string>> = DEEPSEEK_FLASH_FALLBACK_ALIASES.models;

/**
 * The paid tier each paid hop is pinned to. Both paid hops re-enter the
 * ordinary paid pipeline under {@link DEEPSEEK_WATERFALL_PAID_MODEL_ID}, and
 * without a pin that pipeline would pick the fixed Surplus -> Metered cost
 * order for either hop — so the Surplus hop could silently advance to metered
 * and the OpenLux hop might never be tried. The routing layer names OpenLux
 * "metered", hence the `metered` entry for the openlux hop.
 */
export const DEEPSEEK_WATERFALL_PAID_PIN: Readonly<Partial<Record<DeepSeekWaterfallProvider, readonly ("metered" | "surplus")[]>>> = {
  surplus: ["surplus"],
  openlux: ["metered"],
};

export const isDeepSeekWaterfallModel = (model: string): boolean => {
  const normalized = model.trim().toLowerCase();
  return normalized === DEEPSEEK_WATERFALL_MODEL_ID || normalized === DEEPSEEK_WATERFALL_LEGACY_MODEL_ID;
};

export const isDeepSeekWaterfallReasoningLevel = (effort: string): boolean => (DEEPSEEK_WATERFALL_REASONING_LEVELS as readonly string[]).includes(effort);

/** Whether the route has a credential for one hop. */
export const deepSeekWaterfallProviderConfigured = (provider: DeepSeekWaterfallProvider): boolean => {
  if (provider === "lithos") return readLithosApiKey() !== null;
  if (provider === "deepseek") return readDeepSeekApiKey() !== null;
  if (provider === "openrouter") return readOpenRouterApiKey() !== null;
  if (provider === "openlux") return readMeteredApiKey() !== null;
  return readSurplusApiKey() !== null;
};

/** The hop order after removing providers the operator switched off or that have no credential. */
export const deepSeekWaterfallPlan = (
  input: Readonly<{
    enabled: (provider: DeepSeekWaterfallProvider) => boolean;
    configured: (provider: DeepSeekWaterfallProvider) => boolean;
  }>
): readonly DeepSeekWaterfallProvider[] => DEEPSEEK_WATERFALL_ORDER.filter((provider) => input.enabled(provider) && input.configured(provider));

/**
 * A hop status worth trying the next provider for: upstream transport, quota or
 * server failures that are not the client's fault. A request-validation 4xx is
 * the client's answer and must be returned as-is, and a valid completion — even
 * a wrong one — is a model result, never a serving failure.
 */
export const isDeepSeekWaterfallRetryStatus = (status: number): boolean => status >= 500 || status === 429 || status === 402 || status === 403;

/** Requested reasoning effort from a Responses record, or null when omitted. */
export const deepSeekWaterfallRequestedEffort = (rawRecord: Readonly<Record<string, unknown>>): string | null => {
  const reasoning = rawRecord.reasoning;
  if (typeof reasoning === "object" && reasoning !== null && !Array.isArray(reasoning)) {
    const effort = (reasoning as Readonly<Record<string, unknown>>).effort;
    if (typeof effort === "string" && effort.trim()) return effort.trim();
  }
  const legacy = rawRecord.reasoning_effort;
  if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  return null;
};

/** The exact fallback reason recorded for one failed hop. */
export const deepSeekWaterfallFailureReason = (
  provider: DeepSeekWaterfallProvider,
  failure: number | "transport" | "stream"
): DeepSeekWaterfallFallbackReason => {
  const failureLabel: Readonly<Record<"transport" | "stream", string>> = { transport: "transport_failure", stream: "stream_failure" };
  const label = typeof failure === "number" ? String(failure) : failureLabel[failure];
  return `deepseek_waterfall:${provider}:${label}` as DeepSeekWaterfallFallbackReason;
};

/**
 * Whether the synthetic route may be advertised and dispatched: the operator
 * leaves the gateway identity enabled (absent or empty selection, or `ubiquity`
 * checked) and at least one hop has a credential. An active selection without
 * `ubiquity` switches the whole route off.
 */
export const deepSeekWaterfallCatalogEnabled = (selection: ProviderSelection | null): boolean =>
  isProviderEnabled(GATEWAY_PROVIDER_ID, selection) && DEEPSEEK_WATERFALL_ORDER.some((provider) => deepSeekWaterfallProviderConfigured(provider));
