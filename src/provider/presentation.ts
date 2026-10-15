import type { RecordProvider } from "./health.ts";
import type { SelectableProviderId } from "./selection.ts";

// ── Provider presentation ────────────────────────────────────────────────────

/**
 * The waterfall tiers, in the order the gateway tries them. The operator panel
 * renders its tier filter from this list, so a new tier is one entry here.
 */
export const PROVIDER_TIERS = [
  { id: "subscription", label: "Subscription" },
  { id: "paid", label: "Paid fallback" },
  { id: "direct", label: "Direct" },
  { id: "gateway", label: "Gateway" },
] as const;

export type ProviderTierId = (typeof PROVIDER_TIERS)[number]["id"];

export type ProviderPresentation = Readonly<{
  label: string;
  tier: ProviderTierId;
  detail: string;
  endpoints: readonly string[];
  /** The key the provider-health view reports this route under. */
  health_key: RecordProvider;
}>;

/**
 * The gateway-owned provider identity behind the synthetic
 * `ubiquity/deepseek-v4.1-flash` model. It is an ordinary selectable provider:
 * checking it allows the route, and an active selection without it switches the
 * route off.
 */
export const GATEWAY_PROVIDER_ID = "ubiquity" as const;

export const GATEWAY_PROVIDER_PRESENTATION: ProviderPresentation = {
  label: "Ubiquity",
  tier: "gateway",
  detail: "Gateway-owned DeepSeek V4.1 Flash waterfall: LithosAI, then DeepSeek, then OpenRouter, then Surplus, then OpenLux.",
  endpoints: ["/v1/responses"],
  health_key: "ubiquity",
};

/**
 * Display copy for every selectable provider, in the order the roster lists
 * them. The panel holds no provider list of its own: it renders these rows, so
 * adding a provider here is what makes it appear in the operator UI.
 */
export const PROVIDER_PRESENTATION: Readonly<Record<SelectableProviderId, ProviderPresentation>> = {
  codex: {
    label: "Codex",
    tier: "subscription",
    detail: "ChatGPT subscription capacity. The waterfall always tries it first.",
    endpoints: ["/v1/responses", "/v1/chat/completions"],
    health_key: "codex",
  },
  claude_code: {
    label: "Claude Code",
    tier: "subscription",
    detail:
      "Claude subscription capacity. Tried before the paid waterfall for Claude models when a credential, the principal allowlist, and a workspace are configured.",
    endpoints: ["/v1/responses", "/v1/chat/completions"],
    health_key: "claude_code",
  },
  surplus: {
    label: "Metered 1",
    tier: "paid",
    detail: "Surplus Intelligence. Second tier of the paid waterfall.",
    endpoints: ["/v1/responses", "/v1/chat/completions"],
    health_key: "surplus",
  },
  openlux: {
    label: "Metered 2",
    tier: "paid",
    detail: "OpenLux. Last tier of the paid waterfall.",
    endpoints: ["/v1/responses", "/v1/chat/completions"],
    health_key: "metered",
  },
  deepseek: {
    label: "DeepSeek",
    tier: "direct",
    detail: "Official DeepSeek key, served on Chat Completions upstream and Responses through the gateway's translation.",
    endpoints: ["/v1/chat/completions", "/v1/responses"],
    health_key: "deepseek",
  },
  cerebras: {
    label: "Cerebras",
    tier: "direct",
    detail: "GPT-OSS 120B, served on Chat Completions only.",
    endpoints: ["/v1/chat/completions"],
    health_key: "cerebras",
  },
  openrouter: {
    label: "OpenRouter",
    tier: "direct",
    detail: "OpenRouter's full served catalogue on both OpenAI wires, plus System One decisions (Typesafe Jev) for the selector-repair design step.",
    endpoints: ["/v1/chat/completions", "/v1/responses", "/v1/systemone"],
    health_key: "openrouter",
  },
  lithos: {
    label: "LithosAI",
    tier: "direct",
    detail: "LithosAI key, served on Chat Completions upstream and Responses through the gateway's translation.",
    endpoints: ["/v1/chat/completions", "/v1/responses"],
    health_key: "lithos",
  },
  ubiquity: GATEWAY_PROVIDER_PRESENTATION,
};

/**
 * Presentation for any roster id: the table entry, or a complete derived one so
 * a provider added to `SELECTABLE_PROVIDER_IDS` renders correctly before anyone
 * writes its copy.
 */
export const providerPresentation = (id: string): ProviderPresentation => {
  const known = Object.entries(PROVIDER_PRESENTATION).find(([knownId]) => knownId === id)?.[1];
  if (known) return known;
  return {
    label: id,
    tier: "direct",
    detail: `${id} has no presentation entry yet.`,
    endpoints: [],
    // The fallback reports under its own id, the convention every direct route
    // already follows, so a new provider can be rostered before its health key.
    health_key: id as RecordProvider,
  };
};
