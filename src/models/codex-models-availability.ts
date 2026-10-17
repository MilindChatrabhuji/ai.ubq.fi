import type { Kv } from "#kv";
// Per-account Codex model availability: the catalog each subscription account
// advertised and the account+model pairs upstream has rejected as unsupported.
// The store is a non-secret routing hint; raw tokens never enter it.

import { getKv } from "../kv.ts";
import { getString, isRecord } from "../utils.ts";

export const CODEX_ACCOUNT_MODELS_KV_KEY = ["uos_ai", "codex_account_models", "v1"] as const;
/** Per-request routing reads this isolate-local snapshot, never KV, while it is fresh. */
export const CODEX_ACCOUNT_MODELS_CACHE_TTL_MS = 30_000;
/** Bound the learned map per account: newest entries win, old observations age out. */
export const CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_COUNT = 32;
export const CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export type CodexAccountModelCatalog = Readonly<{
  client_version: string;
  slugs: readonly string[];
  updated_at_ms: number;
}>;

export type CodexAccountModelsStore = Readonly<{
  accounts: Readonly<Record<string, CodexAccountModelCatalog>>;
  unsupported: Readonly<Record<string, Readonly<Record<string, number>>>>;
}>;

export const emptyCodexAccountModelsStore = (): CodexAccountModelsStore => ({ accounts: {}, unsupported: {} });

const uniqueSlugs = (values: readonly unknown[]): string[] => {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const slug = getString(value)?.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
};

/** Indexed lookup that keeps the absent-key case in the type, independently of the checker's index-access flags. */
const recordValue = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

const parseCodexAccountModelCatalog = (value: unknown): CodexAccountModelCatalog | null => {
  if (!isRecord(value)) return null;
  const clientVersion = getString(value.client_version)?.trim();
  const updatedAtMs = value.updated_at_ms;
  if (!clientVersion) return null;
  if (typeof updatedAtMs !== "number" || !Number.isSafeInteger(updatedAtMs) || updatedAtMs <= 0) return null;
  if (!Array.isArray(value.slugs)) return null;
  return { client_version: clientVersion, slugs: uniqueSlugs(value.slugs), updated_at_ms: updatedAtMs };
};

const parseUnsupportedEntry = (value: unknown): Record<string, number> | null => {
  if (!isRecord(value)) return null;
  const models: Record<string, number> = {};
  for (const [model, observedAtMs] of Object.entries(value)) {
    if (!model.trim()) continue;
    if (typeof observedAtMs !== "number" || !Number.isSafeInteger(observedAtMs) || observedAtMs <= 0) continue;
    models[model] = observedAtMs;
  }
  return models;
};

const parseStoredAccounts = (value: Record<string, unknown>): Record<string, CodexAccountModelCatalog> => {
  const accounts: Record<string, CodexAccountModelCatalog> = {};
  for (const [accountId, entry] of Object.entries(value)) {
    if (!accountId.trim()) continue;
    const catalog = parseCodexAccountModelCatalog(entry);
    if (catalog) accounts[accountId] = catalog;
  }
  return accounts;
};

const parseStoredUnsupported = (value: Record<string, unknown>): Record<string, Record<string, number>> => {
  const unsupported: Record<string, Record<string, number>> = {};
  for (const [accountId, entry] of Object.entries(value)) {
    if (!accountId.trim()) continue;
    const models = parseUnsupportedEntry(entry);
    if (models && Object.keys(models).length) unsupported[accountId] = models;
  }
  return unsupported;
};

/**
 * Parse the durable store defensively: a value that cannot be a store at all is
 * rejected, while individually malformed entries are dropped so one bad row
 * cannot erase every other account's evidence.
 */
export const parseCodexAccountModelsStore = (value: unknown): CodexAccountModelsStore | null => {
  if (!isRecord(value)) return null;
  const rawAccounts = isRecord(value.accounts) ? value.accounts : null;
  const rawUnsupported = isRecord(value.unsupported) ? value.unsupported : null;
  if (rawAccounts === null && rawUnsupported === null) return null;
  return {
    accounts: rawAccounts === null ? {} : parseStoredAccounts(rawAccounts),
    unsupported: rawUnsupported === null ? {} : parseStoredUnsupported(rawUnsupported),
  };
};

export type CodexAccountCatalogInput = Readonly<{
  accountId: string;
  clientVersion: string;
  slugs: readonly unknown[];
  updatedAtMs?: number;
}>;

/**
 * Merge fresh per-account catalogs. A slug now present in an account's own
 * catalog clears that account's learned rejection for the same model, which
 * keeps the learned signal from outliving the upstream capability it described.
 */
export const mergeCodexAccountCatalogs = (
  store: CodexAccountModelsStore,
  entries: readonly CodexAccountCatalogInput[],
  nowMs: number
): CodexAccountModelsStore => {
  if (!entries.length) return store;
  const accounts: Record<string, CodexAccountModelCatalog> = { ...store.accounts };
  const unsupported: Record<string, Record<string, number>> = {};
  for (const [accountId, models] of Object.entries(store.unsupported)) unsupported[accountId] = { ...models };
  for (const entry of entries) {
    const slugs = uniqueSlugs(entry.slugs);
    accounts[entry.accountId] = {
      client_version: entry.clientVersion,
      slugs,
      updated_at_ms: entry.updatedAtMs ?? nowMs,
    };
    const models = recordValue(unsupported, entry.accountId);
    if (models === undefined) continue;
    const present = new Set(slugs);
    for (const model of Object.keys(models)) {
      if (present.has(model)) Reflect.deleteProperty(models, model);
    }
    if (!Object.keys(models).length) Reflect.deleteProperty(unsupported, entry.accountId);
  }
  return { accounts, unsupported };
};

/** Record one learned upstream rejection, pruning the account's map by age and count. */
export const withCodexModelUnsupported = (
  store: CodexAccountModelsStore,
  accountId: string,
  model: string,
  observedAtMs: number,
  nowMs = observedAtMs
): CodexAccountModelsStore => {
  const models: Record<string, number> = { ...(store.unsupported[accountId] ?? {}), [model]: observedAtMs };
  const kept = Object.entries(models)
    .filter(([, observed]) => nowMs - observed <= CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_AGE_MS)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_COUNT);
  return { accounts: store.accounts, unsupported: { ...store.unsupported, [accountId]: Object.fromEntries(kept) } };
};

// ── In-memory cache ──────────────────────────────────────────────────────────
//
// Ordinary routing evaluates accounts synchronously, so it reads this snapshot
// only. A stale snapshot schedules one background KV read and keeps serving
// until it lands: dropping to "unknown" here would forget a learned rejection
// after the TTL instead of refreshing it.

type CodexAccountModelsCache = { store: CodexAccountModelsStore | null; loadedAtMs: number };

const cache: CodexAccountModelsCache = { store: null, loadedAtMs: 0 };
const learnedDetails = new Map<string, Map<string, string>>();
let refreshInFlight: Promise<void> | null = null;

const loadCodexAccountModelsFromKv = async (kvOverride?: Kv | null): Promise<CodexAccountModelsStore | null> => {
  const kv = kvOverride === undefined ? await getKv() : kvOverride;
  if (!kv) return null;
  const entry = await kv.get(CODEX_ACCOUNT_MODELS_KV_KEY, { consistency: "strong" });
  return entry.value === null ? emptyCodexAccountModelsStore() : parseCodexAccountModelsStore(entry.value);
};

export const loadCodexAccountModels = async (kvOverride?: Kv | null): Promise<CodexAccountModelsStore | null> => {
  let store: CodexAccountModelsStore | null;
  try {
    store = await loadCodexAccountModelsFromKv(kvOverride);
  } catch {
    return cache.store;
  }
  if (store !== null) {
    cache.store = store;
    cache.loadedAtMs = Date.now();
  }
  return store;
};

const scheduleCodexAccountModelsRefresh = (): void => {
  if (refreshInFlight !== null) return;
  refreshInFlight = loadCodexAccountModels()
    .then(() => {})
    .catch(() => {})
    .finally(() => {
      refreshInFlight = null;
    });
};

const currentCodexAccountModelsStore = (nowMs: number): CodexAccountModelsStore | null => {
  if (cache.store === null || nowMs - cache.loadedAtMs > CODEX_ACCOUNT_MODELS_CACHE_TTL_MS) scheduleCodexAccountModelsRefresh();
  return cache.store;
};

/** A bounded retry budget, mirroring the catalog snapshot writer's commit loop. */
const CODEX_ACCOUNT_MODELS_COMMIT_ATTEMPTS = 3;

/**
 * Persist one merged update with a compare-and-set commit, never letting an
 * availability failure affect serving. Catalog refreshes and learned rejections
 * run concurrently in independent isolates, so an unconditional `set` would let
 * the last writer discard the other's rows -- or resurrect a rejection the
 * fresh catalog had already cleared. Every attempt re-reads the durable store
 * strongly, merges on the value it just read, and commits only while that exact
 * version is still current; the in-memory cache follows the committed value.
 */
const mergeAndStoreCodexAccountModels = async (merge: (current: CodexAccountModelsStore) => CodexAccountModelsStore, kvOverride?: Kv | null): Promise<void> => {
  try {
    const kv = kvOverride === undefined ? await getKv() : kvOverride;
    if (!kv) {
      // Without a durable store the hint stays isolate-local, as before.
      const local = merge(cache.store ?? emptyCodexAccountModelsStore());
      cache.store = local;
      cache.loadedAtMs = Date.now();
      return;
    }
    for (let attempt = 0; attempt < CODEX_ACCOUNT_MODELS_COMMIT_ATTEMPTS; attempt += 1) {
      const entry = await kv.get(CODEX_ACCOUNT_MODELS_KV_KEY, { consistency: "strong" });
      // An absent or unreadable durable value merges from an empty store: the
      // base is always the value just read, never a possibly-stale snapshot.
      const current = parseCodexAccountModelsStore(entry.value) ?? emptyCodexAccountModelsStore();
      const next = merge(current);
      const committed = await kv.atomic().check(entry).set(CODEX_ACCOUNT_MODELS_KV_KEY, next).commit();
      if (!committed.ok) continue;
      cache.store = next;
      cache.loadedAtMs = Date.now();
      return;
    }
  } catch {
    // Availability evidence is a hint; a KV failure only loses the hint.
  }
};

/** Record the catalogs every pool account advertised for one client version. */
export const recordCodexAccountCatalogs = async (entries: readonly CodexAccountCatalogInput[], kvOverride?: Kv | null): Promise<void> => {
  if (!entries.length) return;
  const nowMs = Date.now();
  await mergeAndStoreCodexAccountModels((current) => mergeCodexAccountCatalogs(current, entries, nowMs), kvOverride);
};

/** Record one account+model pair upstream rejected, with the detail text for diagnostics. */
export const recordCodexModelUnsupported = async (
  accountId: string,
  model: string,
  options: Readonly<{ detail?: string | null; nowMs?: number; kv?: Kv | null }> = {}
): Promise<void> => {
  const target = model.trim();
  if (!accountId || !target) return;
  const nowMs = options.nowMs ?? Date.now();
  if (options.detail) {
    const details = learnedDetails.get(accountId) ?? new Map<string, string>();
    details.set(target, options.detail);
    learnedDetails.set(accountId, details);
  }
  await mergeAndStoreCodexAccountModels((current) => withCodexModelUnsupported(current, accountId, target, nowMs, nowMs), options.kv);
};

/** Whether a sibling's same-version catalog proves the model is servable somewhere. */
const siblingListsModel = (store: CodexAccountModelsStore, other: string, catalog: CodexAccountModelCatalog, target: string): boolean => {
  const sibling = recordValue(store.accounts, other);
  if (sibling?.client_version !== catalog.client_version) return false;
  return sibling.slugs.includes(target);
};

/**
 * Accounts in the current pool that cannot serve a named model, mapped to the
 * upstream detail when one was learned. Only current pool accounts are
 * considered: a removed or replaced account's stored catalog or rejection says
 * nothing about the accounts serving now. A stored catalog proves absence only
 * against a current sibling's catalog for the same client version, and a
 * learned rejection ages back to unknown availability after
 * CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_AGE_MS instead of excluding the account
 * forever.
 */
export const codexModelUnavailableAccounts = (model: string | null, currentAccountIds: readonly string[]): ReadonlyMap<string, string | null> => {
  const unavailable = new Map<string, string | null>();
  const target = model?.trim();
  if (!target) return unavailable;
  const nowMs = Date.now();
  const store = currentCodexAccountModelsStore(nowMs);
  if (store === null) return unavailable;
  const accountIds = [...new Set(currentAccountIds)];
  for (const accountId of accountIds) {
    const unsupported = recordValue(store.unsupported, accountId);
    const observedAtMs = unsupported === undefined ? undefined : recordValue(unsupported, target);
    if (observedAtMs !== undefined && nowMs - observedAtMs <= CODEX_ACCOUNT_MODELS_UNSUPPORTED_MAX_AGE_MS) {
      unavailable.set(accountId, learnedDetails.get(accountId)?.get(target) ?? null);
      continue;
    }
    const catalog = recordValue(store.accounts, accountId);
    if (catalog === undefined || catalog.slugs.includes(target)) continue;
    if (accountIds.some((other) => other !== accountId && siblingListsModel(store, other, catalog, target))) unavailable.set(accountId, null);
  }
  return unavailable;
};

// ── Test hooks ───────────────────────────────────────────────────────────────

export const setCodexAccountModelsStoreForTest = (store: CodexAccountModelsStore | null, loadedAtMs = Date.now()): void => {
  cache.store = store;
  cache.loadedAtMs = store === null ? 0 : loadedAtMs;
};

export const getCodexAccountModelsCacheForTest = (): Readonly<{ store: CodexAccountModelsStore | null; loadedAtMs: number; refreshing: boolean }> => ({
  store: cache.store,
  loadedAtMs: cache.loadedAtMs,
  refreshing: refreshInFlight !== null,
});

export const resetCodexAccountModelsCacheForTest = (): void => {
  cache.store = null;
  cache.loadedAtMs = 0;
  learnedDetails.clear();
  refreshInFlight = null;
};

export const awaitCodexAccountModelsRefreshForTest = async (): Promise<void> => {
  await refreshInFlight;
};
