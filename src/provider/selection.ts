import type { Kv } from "#kv";
import { getKv } from "../kv.ts";
import { getString, isRecord, sha256Hex } from "../utils.ts";
import { GATEWAY_PROVIDER_ID } from "./presentation.ts";

// ── KV key ───────────────────────────────────────────────────────────────────

export const PROVIDER_SELECTION_KV_KEY = ["uos_ai", "provider_selection", "v1"] as const;

/** Routing reads this control on the hot path, so a short cache bounds KV reads. */
export const PROVIDER_SELECTION_CACHE_TTL_MS = 5_000;

// ── Provider roster ──────────────────────────────────────────────────────────

/**
 * The provider vocabulary the model catalog already publishes, in the order the
 * inference waterfall tries it: the Codex subscription tier first, then the two
 * paid fallback tiers (`surplus` before `openlux`), then the credential-gated
 * direct routes (`deepseek`, `cerebras`, `lithos`), and the gateway-owned
 * `ubiquity` identity last. Checking `ubiquity` allows the synthetic
 * `ubiquity/deepseek-v4.1-flash` route; in an active selection its absence
 * switches that route off like any other unchecked provider.
 */
export const SELECTABLE_PROVIDER_IDS = ["codex", "claude_code", "surplus", "openlux", "deepseek", "cerebras", "lithos", "openrouter", "ubiquity"] as const;

export type SelectableProviderId = (typeof SELECTABLE_PROVIDER_IDS)[number];

/**
 * One configured Codex subscription, addressed by the opaque hash of its
 * account id. A selection may therefore narrow the Codex tier to a subset of
 * the configured accounts the same way it narrows the whole waterfall:
 * `codex` alone means every configured subscription, `codex:<hash>` entries
 * mean exactly those, and neither means the Codex tier is switched off.
 */
export type CodexSubscriptionId = `codex:${string}`;

export type ProviderSelectionId = SelectableProviderId | CodexSubscriptionId;

export type ProviderSelection = Readonly<{
  provider_ids: readonly ProviderSelectionId[];
  updated_at_ms: number;
}>;

const selectableProviderIdSet = new Set<string>(SELECTABLE_PROVIDER_IDS);
const CODEX_SUBSCRIPTION_ID_PREFIX = "codex:";
const CODEX_SUBSCRIPTION_HASH_PATTERN = /^[a-f0-9]{64}$/;
const subscriptionHashCache = new Map<string, string>();

/**
 * Stable opaque id for one configured subscription, for the operator picker.
 * The selection never stores a raw account id: this is deliberately the same
 * unsalted account hash the admin console already uses to name one subscription
 * in the banked-reset settings, so both admin surfaces identify the same
 * account with the same opaque id.
 */
export const codexSubscriptionHash = async (accountId: string): Promise<string> => {
  const cached = subscriptionHashCache.get(accountId);
  if (cached !== undefined) return cached;
  const hash = await sha256Hex(accountId);
  subscriptionHashCache.set(accountId, hash);
  return hash;
};

export const codexSubscriptionSelectionId = (accountIdHash: string): CodexSubscriptionId =>
  `${CODEX_SUBSCRIPTION_ID_PREFIX}${accountIdHash}` as CodexSubscriptionId;

export const isCodexSubscriptionSelectionId = (value: unknown): value is CodexSubscriptionId =>
  typeof value === "string" &&
  value.startsWith(CODEX_SUBSCRIPTION_ID_PREFIX) &&
  CODEX_SUBSCRIPTION_HASH_PATTERN.test(value.slice(CODEX_SUBSCRIPTION_ID_PREFIX.length));

/** The account hash inside a subscription id, or `null` for any other id. */
export const codexSubscriptionHashFromSelectionId = (value: unknown): string | null =>
  isCodexSubscriptionSelectionId(value) ? value.slice(CODEX_SUBSCRIPTION_ID_PREFIX.length) : null;

/** Every id the operator API may store: a roster provider or one subscription. */
export const isProviderSelectionId = (value: unknown): value is ProviderSelectionId => isSelectableProviderId(value) || isCodexSubscriptionSelectionId(value);

/** Last selection served to the routing path, with the write path priming it. */
let cachedSelection: Readonly<{ value: ProviderSelection | null; expires_at_ms: number }> | null = null;
let selectionLoadInFlight: Promise<ProviderSelection | null> | null = null;
/** Invalidates a read that began before a successful write primed the cache. */
let selectionCacheGeneration = 0;
/** Prevents a reset from letting an obsolete read clear a replacement load. */
let selectionLoadToken = 0;

export const isSelectableProviderId = (value: unknown): value is SelectableProviderId => typeof value === "string" && selectableProviderIdSet.has(value.trim());

// ── Normalize / validate ─────────────────────────────────────────────────────

/**
 * Canonical form of a submitted selection: known provider ids in roster order,
 * then subscription ids in hash order, de-duplicated. The `codex` umbrella
 * means every configured subscription, so it absorbs any subscription id
 * submitted alongside it and storage can never hold an ambiguous pair.
 */
export const normalizeSelectedProviderIds = (rawIds: readonly unknown[]): ProviderSelectionId[] => {
  const submittedProviders = new Set<string>();
  const submittedSubscriptions = new Set<CodexSubscriptionId>();
  for (const raw of rawIds) {
    const id = getString(raw)?.trim();
    if (!id) continue;
    if (selectableProviderIdSet.has(id)) {
      submittedProviders.add(id);
      continue;
    }
    if (isCodexSubscriptionSelectionId(id)) submittedSubscriptions.add(id);
  }
  const providers = SELECTABLE_PROVIDER_IDS.filter((id) => submittedProviders.has(id));
  if (submittedProviders.has("codex")) return [...providers];
  return [...providers, ...[...submittedSubscriptions].sort((left, right) => left.localeCompare(right))];
};

/**
 * Read a stored selection. Ids that are no longer on the roster are dropped
 * rather than voiding the whole selection, so retiring a provider cannot
 * silently switch every other provider back on.
 */
export const normalizeProviderSelection = (value: unknown): ProviderSelection | null => {
  if (!isRecord(value)) return null;
  const rawIds = value.provider_ids;
  if (!Array.isArray(rawIds)) return null;
  if (rawIds.some((raw) => getString(raw) === null)) return null;
  const updatedAtMs = value.updated_at_ms;
  if (typeof updatedAtMs !== "number" || !Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) return null;
  return { provider_ids: normalizeSelectedProviderIds(rawIds), updated_at_ms: updatedAtMs };
};

// ── KV helpers ───────────────────────────────────────────────────────────────

export const loadProviderSelection = async (kv: Kv | null): Promise<ProviderSelection | null> => {
  if (!kv) return null;
  const entry = await kv.get(PROVIDER_SELECTION_KV_KEY, { consistency: "strong" });
  return normalizeProviderSelection(entry.value);
};

/**
 * Persist a selection and prime the routing cache with exactly what was
 * written, so an operator sees the effect of a save on the next request
 * instead of waiting out the cache TTL. Returns `null` when KV rejected it.
 */
export const storeProviderSelection = async (kv: Kv, providerIds: readonly ProviderSelectionId[]): Promise<ProviderSelection | null> => {
  const selection: ProviderSelection = { provider_ids: normalizeSelectedProviderIds(providerIds), updated_at_ms: Date.now() };
  try {
    await kv.set(PROVIDER_SELECTION_KV_KEY, selection);
  } catch {
    return null;
  }
  selectionCacheGeneration += 1;
  cachedSelection = { value: selection, expires_at_ms: selection.updated_at_ms + PROVIDER_SELECTION_CACHE_TTL_MS };
  return selection;
};

// ── Enforcement ──────────────────────────────────────────────────────────────

const selectionIds = (selection: ProviderSelection | null): readonly string[] => selection?.provider_ids ?? [];

/**
 * An empty or absent selection is no filter at all: every provider stays
 * eligible. That matches the model whitelist contract and keeps an accidental
 * (or stale) empty selection from disabling inference.
 *
 * `codex` is enabled by its own id or by any single selected subscription, so
 * narrowing the tier to one account never reads as switching the tier off.
 */
export const isProviderEnabled = (provider: SelectableProviderId, selection: ProviderSelection | null): boolean => {
  if (selection === null || selection.provider_ids.length === 0) return true;
  if (selection.provider_ids.includes(provider)) return true;
  if (provider !== "codex") return false;
  return selection.provider_ids.some((id) => isCodexSubscriptionSelectionId(id));
};

export const providerSelectionIsActive = (selection: ProviderSelection | null): boolean => selection !== null && selection.provider_ids.length > 0;

/**
 * Which configured Codex subscriptions may serve inference: every account (no
 * restriction), none of them (the tier is switched off), or exactly the hashes
 * the operator selected.
 */
export type CodexAccountEligibility = Readonly<{ kind: "all" }> | Readonly<{ kind: "none" }> | Readonly<{ kind: "only"; hashes: readonly string[] }>;

export const codexAccountEligibility = (selection: ProviderSelection | null): CodexAccountEligibility => {
  const ids = selectionIds(selection);
  if (!ids.length || ids.includes("codex")) return { kind: "all" };
  const hashes = ids.map((id) => codexSubscriptionHashFromSelectionId(id)).filter((hash): hash is string => hash !== null);
  return hashes.length ? { kind: "only", hashes } : { kind: "none" };
};

export const isCodexSubscriptionEnabled = (accountIdHash: string, selection: ProviderSelection | null): boolean => {
  const eligibility = codexAccountEligibility(selection);
  if (eligibility.kind === "all") return true;
  if (eligibility.kind === "none") return false;
  return eligibility.hashes.includes(accountIdHash);
};

/**
 * Keep only the entries an enabled provider serves, narrowing each row to the
 * providers that are still active. An entry no enabled provider serves is
 * dropped, so a disabled provider can never be advertised or dispatched to.
 * Catalog vocabulary the picker does not control stays listed untouched.
 */
export const filterCatalogEntriesByProviderSelection = <T extends Readonly<{ providers: readonly Readonly<{ id: string }>[] }>>(
  entries: readonly T[],
  selection: ProviderSelection | null
): T[] => {
  if (!providerSelectionIsActive(selection)) return [...entries];
  const enabled = (id: string): boolean => (selectableProviderIdSet.has(id) ? isProviderEnabled(id as SelectableProviderId, selection) : true);
  const filtered: T[] = [];
  for (const entry of entries) {
    // The gateway identity owns its route's entry: when it is switched off the
    // whole entry leaves, even if one of its upstream hops stays enabled.
    if (entry.providers.some((provider) => provider.id === GATEWAY_PROVIDER_ID) && !enabled(GATEWAY_PROVIDER_ID)) continue;
    const providers = entry.providers.filter((provider) => enabled(provider.id));
    if (!providers.length) continue;
    filtered.push(providers.length === entry.providers.length ? entry : { ...entry, providers });
  }
  return filtered;
};

// ── Cached routing read ──────────────────────────────────────────────────────

/**
 * The routing path reads the selection through this cache. A failed read keeps
 * the last known selection and, with nothing cached, fails open: an operator
 * control must never turn a KV hiccup into a routing outage.
 */
export const loadProviderSelectionCached = async (nowMs = Date.now()): Promise<ProviderSelection | null> => {
  if (cachedSelection && cachedSelection.expires_at_ms > nowMs) return cachedSelection.value;
  if (selectionLoadInFlight) return await selectionLoadInFlight;
  const stale = cachedSelection?.value ?? null;
  const cacheGenerationAtLoad = selectionCacheGeneration;
  const loadToken = ++selectionLoadToken;
  selectionLoadInFlight = (async () => {
    try {
      const value = await loadProviderSelection(await getKv());
      if (selectionCacheGeneration === cacheGenerationAtLoad) {
        cachedSelection = { value, expires_at_ms: nowMs + PROVIDER_SELECTION_CACHE_TTL_MS };
      }
      return value;
    } catch {
      return stale;
    } finally {
      if (selectionLoadToken === loadToken) selectionLoadInFlight = null;
    }
  })();
  return await selectionLoadInFlight;
};

export const resetProviderSelectionCacheForTest = (): void => {
  selectionCacheGeneration += 1;
  selectionLoadToken += 1;
  cachedSelection = null;
  selectionLoadInFlight = null;
};
