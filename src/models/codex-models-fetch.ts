import type { Kv } from "#kv";
// Codex models fetching and snapshots, split out of src/codex.ts.

import { type CodexModelsSnapshot, mergeCodexModelPromptCacheCapabilities, parseCodexClientVersion } from "./codex-models.ts";
import { getKv } from "../kv.ts";
import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { buildRuntimeConfig, cacheRuntimeConfig, loadRuntimeConfig, normalizeRuntimeConfig, RUNTIME_CONFIG_V2_KEY } from "../runtime-config.ts";
import { getString, isRecord } from "../utils.ts";
import type { CodexAuthState, ResponseInputItem } from "../types.ts";
import type { CodexAuthAccountEntry, CodexAuthPoolEntry } from "../codex/auth.ts";
import { CODEX_CLIENT_VERSION, CODEX_MODELS_KV_KEY, CodexError, getAuthPoolEntry } from "../codex/auth.ts";
import { awaitWithoutCancellingSharedWork, getCurrentAccountEntry, getValidAuth, refreshAuthCoordinated, refreshAuthStateless } from "../codex/auth-refresh.ts";
import {
  cancelResponseBody,
  codexModelsBaseUrls,
  fetchCodexModelsWithAuth,
  randomizedAuthEntries,
  recordCodexResponseHealth,
  recordCodexThrownHealth,
} from "../codex/dispatch.ts";
import { recordCodexAccountCatalogs } from "./codex-models-availability.ts";

const SINGLE_ACCOUNT_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
const SINGLE_ACCOUNT_CATALOG_TIMEOUT_MS = 1_000;

const fetchCodexModelsForAccount = async (
  accountEntry: CodexAuthAccountEntry,
  url: string,
  clientVersion: string,
  ifNoneMatch: string | null | undefined,
  signal: AbortSignal | undefined
): Promise<Response> => {
  let auth = await awaitWithoutCancellingSharedWork(getValidAuth(accountEntry), signal);
  let res = await fetchCodexModelsWithAuth(auth, url, clientVersion, ifNoneMatch, signal);
  await recordCodexResponseHealth(auth.account_id, res, auth, "reachable");
  if (res.status === 401) {
    cancelResponseBody(res);
    auth = await awaitWithoutCancellingSharedWork(refreshAuthCoordinated(await getCurrentAccountEntry(auth.account_id, true)), signal);
    res = await fetchCodexModelsWithAuth(auth, url, clientVersion, ifNoneMatch, signal);
    await recordCodexResponseHealth(auth.account_id, res, auth, "reachable");
  }
  return res;
};

/**
 * A transport failure is reported to the caller before provider health is
 * recorded, so a throwing callback can never suppress that bookkeeping.
 */
const reportCodexModelsTransportFailure = (error: unknown, onProviderTransportFailure?: () => void): void => {
  if (!(error instanceof CodexError && (error.code === "gateway_timeout" || error.code === "codex_upstream_unreachable"))) return;
  try {
    onProviderTransportFailure?.();
  } catch (callbackError) {
    console.error("[ai.ubq.fi] Codex models transport failure callback failed:", callbackError);
  }
};

type CodexModelsAccountsOutcome = Readonly<{ kind: "response"; response: Response } | { kind: "next_url"; fallback: Response | null }>;

/**
 * Try every account for one models URL in order. A sibling account absorbs an
 * expired bearer or quota answer; a 404/400 on a multi-URL base list defers to
 * the next URL with the response kept for the final diagnostic. Any other
 * answer is final.
 */
const fetchCodexModelsFromAccounts = async (
  url: string,
  accountEntries: readonly CodexAuthAccountEntry[],
  clientVersion: string,
  hasFallbackUrl: boolean,
  options: Readonly<{ ifNoneMatch?: string | null; signal?: AbortSignal; onProviderTransportFailure?: () => void }>
): Promise<CodexModelsAccountsOutcome> => {
  let fallback: Response | null = null;
  for (let index = 0; index < accountEntries.length; index += 1) {
    const accountEntry = accountEntries[index];
    const hasFallbackAccount = index < accountEntries.length - 1;
    let res: Response;
    try {
      res = await fetchCodexModelsForAccount(accountEntry, url, clientVersion, options.ifNoneMatch, options.signal);
    } catch (error) {
      reportCodexModelsTransportFailure(error, options.onProviderTransportFailure);
      await recordCodexThrownHealth(accountEntry.auth.account_id, error);
      if (!hasFallbackAccount) throw error;
      continue;
    }
    if (hasFallbackAccount && (res.status === 401 || res.status === 429)) {
      cancelResponseBody(res);
      fallback = res;
      continue;
    }
    if (codexModelsUrlNotFound(res, hasFallbackUrl)) {
      fallback = res;
      break;
    }
    await recordSingleAccountCodexCatalog(res, accountEntry.auth.account_id, clientVersion);
    return { kind: "response", response: res };
  }
  return { kind: "next_url", fallback };
};

/**
 * A missing models endpoint on a multi-URL base list defers to the next
 * candidate URL instead of being reported as the account's answer.
 */
const codexModelsUrlNotFound = (res: Response, hasFallbackUrl: boolean): boolean => (res.status === 404 || res.status === 400) && hasFallbackUrl;

/**
 * The last failed attempt is the only diagnostic evidence left, so its bounded
 * snippet becomes the caller's error body.
 */
const codexModelsFailureResult = async (fallback: Response): Promise<{ ok: false; status: number; body: string }> => {
  const text = await fallback.text().catch(() => "");
  return { ok: false, status: fallback.status, body: (text || fallback.statusText).slice(0, 8_000) };
};

/**
 * A stateless 401 retry keeps the original response *and* credentials whenever
 * the refresh or its retry fails, while a successful refresh is reported even
 * if the retry fetch itself throws.
 */
const retryCodexModelsAfterAuthRefresh = async (
  auth: CodexAuthState,
  url: string,
  clientVersion: string
): Promise<{ res: Response | null; auth: CodexAuthState; refreshed: boolean }> => {
  try {
    const next = await refreshAuthStateless(auth);
    const res = await fetchCodexModelsWithAuth(next, url, clientVersion);
    return { res, auth: next, refreshed: true };
  } catch {
    // Ignore and let the caller return the original 401 response.
    return { res: null, auth, refreshed: false };
  }
};

/**
 * Read a models body from a successful upstream response. A non-JSON body is
 * reported as `null` models with the raw text preserved for diagnostics; the
 * already-buffered stream is cancelled on a best-effort basis.
 */
const readCodexModelsResponseBody = async (res: Response, contentType: string | null): Promise<{ models: unknown; body: string }> => {
  const text = await res.text().catch(() => "");
  let models: unknown = null;
  if (contentType?.includes("application/json") && text) {
    try {
      models = JSON.parse(text) as unknown;
    } catch {
      models = null;
    }
  }
  try {
    await res.body?.cancel();
  } catch {
    // The body is already buffered; cancellation is best effort.
  }
  return { models, body: text };
};

export const fetchCodexModels = async (
  options: Readonly<{
    clientVersion?: string | null;
    ifNoneMatch?: string | null;
    signal?: AbortSignal;
    onProviderTransportFailure?: () => void;
  }> = {}
): Promise<Response> => {
  const poolEntry = await getAuthPoolEntry();
  const requestedVersion = options.clientVersion?.trim() ?? null;
  const clientVersion = requestedVersion && parseCodexClientVersion(requestedVersion) ? requestedVersion : CODEX_CLIENT_VERSION;
  const urls = codexModelsBaseUrls(clientVersion);

  // One configured account keeps the historical single-account contract exactly,
  // conditional requests and 304 revalidation included. A pool asks every
  // account and unions their answers, because one account's catalog cannot
  // express what its siblings are entitled to serve.
  if (poolEntry.pool.accounts.length <= 1) {
    const accountEntries = randomizedAuthEntries(poolEntry);
    let lastResponse: Response | null = null;

    for (const url of urls) {
      const outcome = await fetchCodexModelsFromAccounts(url, accountEntries, clientVersion, urls.length > 1, options);
      if (outcome.kind === "response") return outcome.response;
      lastResponse = outcome.fallback ?? lastResponse;
    }

    return lastResponse ?? new Response("Codex upstream models endpoint not found.", { status: 404 });
  }

  return await fetchCodexModelsUnion(poolEntry, urls, clientVersion, options);
};

/** A usable JSON catalog one account advertised, with its rows and slugs. */
type CodexAccountCatalogContribution = Readonly<{
  accountId: string;
  body: Record<string, unknown>;
  models: readonly unknown[];
  slugs: readonly string[];
}>;

const codexModelRowSlug = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  const slug = getString(value.slug) ?? getString(value.id) ?? getString(value.model) ?? getString(value.name);
  return slug?.trim() ? slug.trim() : null;
};

const contributionFromBody = (accountId: string, body: Record<string, unknown>): CodexAccountCatalogContribution => {
  const models = Array.isArray(body.models) ? body.models : [];
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const slug = codexModelRowSlug(model);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return { accountId, body, models, slugs };
};

/**
 * Read one successful models body as JSON. A body without a `models` array is
 * not a catalog, so it contributes nothing to the union instead of poisoning it.
 */
const readCodexModelsJsonBody = async (res: Response): Promise<Record<string, unknown> | null> => {
  const text = await res.text().catch(() => "");
  try {
    await res.body?.cancel();
  } catch {
    // The body is already buffered; cancellation is best effort.
  }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) && Array.isArray(parsed.models) ? parsed : null;
  } catch {
    return null;
  }
};

/** Record fresh single-account evidence without consuming or rewriting its upstream response. */
const recordSingleAccountCodexCatalog = async (res: Response, accountId: string, clientVersion: string): Promise<void> => {
  if (!res.ok) return;
  const observation = await readBoundedResponseBody(res.clone(), {
    maxBytes: SINGLE_ACCOUNT_CATALOG_MAX_BYTES,
    timeoutMs: SINGLE_ACCOUNT_CATALOG_TIMEOUT_MS,
  });
  if (!observation.complete) return;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(observation.bytes)) as unknown;
  } catch {
    return;
  }
  if (!isRecord(body) || !Array.isArray(body.models)) return;
  const contribution = contributionFromBody(accountId, body);
  await recordCodexAccountCatalogs([{ accountId, clientVersion, slugs: contribution.slugs }]);
};

type CodexAccountCatalogAttempt = Readonly<{ catalog: CodexAccountCatalogContribution | null; fallback: Response | null }>;

/**
 * Walk one account's candidate URLs with the existing 401-refresh, 429 and
 * 404/400 fallback semantics, but never with `If-None-Match`: a 304 from one
 * account cannot express another account's rows.
 */
const fetchCodexModelsCatalogForAccount = async (
  accountEntry: CodexAuthAccountEntry,
  urls: readonly string[],
  clientVersion: string,
  options: Readonly<{ signal?: AbortSignal; onProviderTransportFailure?: () => void }>
): Promise<CodexAccountCatalogAttempt> => {
  let fallback: Response | null = null;
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetchCodexModelsForAccount(accountEntry, url, clientVersion, null, options.signal);
    } catch (error) {
      reportCodexModelsTransportFailure(error, options.onProviderTransportFailure);
      await recordCodexThrownHealth(accountEntry.auth.account_id, error);
      throw error;
    }
    if (res.ok) {
      const body = await readCodexModelsJsonBody(res);
      if (body) {
        if (fallback !== null) cancelResponseBody(fallback);
        return { catalog: contributionFromBody(accountEntry.auth.account_id, body), fallback: null };
      }
      fallback = res;
      continue;
    }
    fallback = res;
    if (codexModelsUrlNotFound(res, urls.length > 1)) continue;
    break;
  }
  return { catalog: null, fallback };
};

/**
 * Union every pool account's catalog in pool order. Rows deduplicate by slug and
 * the first-in-pool-order row is kept verbatim; the first contributing body
 * supplies the other top-level keys. When no account returns a usable catalog,
 * the last upstream failure is returned unchanged.
 */
type CodexModelsUnionCollection = Readonly<{
  contributions: CodexAccountCatalogContribution[];
  fallback: Response | null;
  transportError: unknown;
}>;

/** Ask every pool account in pool order, keeping the last failure for the all-failed answer. */
const collectCodexModelsUnion = async (
  poolEntry: CodexAuthPoolEntry,
  urls: readonly string[],
  clientVersion: string,
  options: Readonly<{ signal?: AbortSignal; onProviderTransportFailure?: () => void }>
): Promise<CodexModelsUnionCollection> => {
  const contributions: CodexAccountCatalogContribution[] = [];
  let fallback: Response | null = null;
  let transportError: unknown = null;
  for (const auth of poolEntry.pool.accounts) {
    let attempt: CodexAccountCatalogAttempt;
    try {
      attempt = await fetchCodexModelsCatalogForAccount({ ...poolEntry, auth }, urls, clientVersion, options);
    } catch (error) {
      transportError = error;
      continue;
    }
    if (attempt.catalog) {
      contributions.push(attempt.catalog);
      continue;
    }
    if (attempt.fallback !== null) {
      if (fallback !== null) cancelResponseBody(fallback);
      fallback = attempt.fallback;
    }
  }
  return { contributions, fallback, transportError };
};

/** The unchanged upstream failure when no account produced a usable catalog. */
const codexModelsUnionFailureResponse = (fallback: Response | null, transportError: unknown): Response => {
  if (fallback !== null) return fallback;
  if (transportError === null) return new Response("Codex upstream models endpoint not found.", { status: 404 });
  throw transportError instanceof Error ? transportError : new Error("Codex models fetch failed with a non-Error value.", { cause: transportError });
};

/** Merge the contributing rows by slug, keeping the first-in-pool-order row verbatim. */
const buildCodexModelsUnionResponse = (contributions: readonly CodexAccountCatalogContribution[]): Response => {
  const models: unknown[] = [];
  const seen = new Set<string>();
  for (const contribution of contributions) {
    for (const model of contribution.models) {
      const slug = codexModelRowSlug(model);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      models.push(model);
    }
  }
  const body = { ...contributions[0].body, models };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};

const fetchCodexModelsUnion = async (
  poolEntry: CodexAuthPoolEntry,
  urls: readonly string[],
  clientVersion: string,
  options: Readonly<{ signal?: AbortSignal; onProviderTransportFailure?: () => void }>
): Promise<Response> => {
  const collected = await collectCodexModelsUnion(poolEntry, urls, clientVersion, options);
  if (!collected.contributions.length) return codexModelsUnionFailureResponse(collected.fallback, collected.transportError);

  await recordCodexAccountCatalogs(
    collected.contributions.map((contribution) => ({
      accountId: contribution.accountId,
      clientVersion,
      slugs: contribution.slugs,
    }))
  );
  return buildCodexModelsUnionResponse(collected.contributions);
};

export const loadCodexModelsSnapshot = async (): Promise<CodexModelsSnapshot | null> => {
  return (await loadRuntimeConfig())?.codex_models ?? null;
};

export const preserveCodexDefaultModel = (snapshot: CodexModelsSnapshot, candidate: string | null | undefined): string | undefined => {
  const target = candidate?.trim();
  if (!target) return undefined;
  const found = snapshot.models.some((model) => {
    if (!isRecord(model)) return false;
    const id = getString(model.slug) ?? getString(model.id) ?? getString(model.model) ?? getString(model.name);
    return id?.trim() === target;
  });
  return found ? target : undefined;
};

export const loadFullCodexModelsSnapshot = async (kvOverride?: Kv | null): Promise<CodexModelsSnapshot | null> => {
  const kv = kvOverride === undefined ? await getKv() : kvOverride;
  if (!kv) return null;
  // This optional snapshot may be unavailable while the runtime catalog still serves.
  const entry = await kv.get<CodexModelsSnapshot>(CODEX_MODELS_KV_KEY, { consistency: "strong" }).catch(() => null);
  const snapshot = entry?.value;
  if (!snapshot || !Array.isArray(snapshot.models) || snapshot.models.length === 0) return null;
  if (snapshot.models.some((model) => !isRecord(model))) return null;
  if (!getString(snapshot.source)?.trim()) return null;
  if (typeof snapshot.updated_at_ms !== "number" || !Number.isSafeInteger(snapshot.updated_at_ms) || snapshot.updated_at_ms <= 0) return null;
  return snapshot;
};

export const storeCodexModelsSnapshot = async (snapshot: CodexModelsSnapshot): Promise<boolean> => {
  const kv = await getKv();
  if (!kv) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [currentEntry, runtimeEntry] = await Promise.all([
      kv.get<CodexModelsSnapshot>(CODEX_MODELS_KV_KEY, { consistency: "strong" }),
      kv.get(RUNTIME_CONFIG_V2_KEY, { consistency: "strong" }),
    ]);
    const currentRuntime = normalizeRuntimeConfig(runtimeEntry.value);
    const nextSnapshot = mergeCodexModelPromptCacheCapabilities(snapshot, currentEntry.value);
    const runtimeConfig = buildRuntimeConfig(nextSnapshot, {
      defaultModel: preserveCodexDefaultModel(nextSnapshot, currentRuntime?.default_model),
      defaultReasoningEffort: currentRuntime?.default_reasoning_effort,
    });

    // Guard: refuse to overwrite a populated catalog with empty models.
    // A failed upstream /models probe must not nuke the serving catalog.
    if (
      currentEntry.value &&
      Array.isArray(currentEntry.value.models) &&
      currentEntry.value.models.length > 0 &&
      (!Array.isArray(nextSnapshot.models) || nextSnapshot.models.length === 0)
    ) {
      return false;
    }
    const commit = await kv
      .atomic()
      .check(currentEntry)
      .check(runtimeEntry)
      .set(CODEX_MODELS_KV_KEY, nextSnapshot)
      .set(RUNTIME_CONFIG_V2_KEY, runtimeConfig)
      .commit();
    if (!commit.ok) continue;
    cacheRuntimeConfig(runtimeConfig);
    return true;
  }
  return false;
};

/**
 * The item ids the gateway's own Chat-only Responses translators synthesize.
 *
 * The producer mints `responseId` as `resp_` plus up to 40 alphanumerics, so a
 * gateway item id is `<responseId>_<kind>_<indexes>` in the legacy shape or
 * `<kind>_<responseId>_<indexes>` once the kind carries its official prefix.
 * Only those exact producer shapes are recognized, so a genuine OpenAI id is
 * never rewritten. A replayed legacy id fails the upstream's prefix validation,
 * and a replayed synthetic reasoning item cannot be looked up under
 * `store: false`.
 */
const GATEWAY_RESPONSE_ID = "resp_[A-Za-z0-9]{1,40}";
const GATEWAY_ITEM_IDS = [
  new RegExp(`^${GATEWAY_RESPONSE_ID}_(?:rs|msg|fc|ctc)(?:_\\d+){1,2}$`),
  new RegExp(`^(?:rs|msg|fc|ctc)_${GATEWAY_RESPONSE_ID}(?:_\\d+){1,2}$`),
];

const isGatewaySyntheticItemId = (id: string): boolean => GATEWAY_ITEM_IDS.some((pattern) => pattern.test(id));

/** Only an encrypted payload lets a stateless upstream resolve a replayed reasoning item. */
const hasEncryptedReasoningReplay = (item: Record<string, unknown>): boolean => typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;

/**
 * One replayed input item for the Codex seam, with gateway-local provenance
 * removed. A gateway-synthesized reasoning item carries no encrypted payload,
 * so a `store: false` upstream cannot resolve it and it is dropped. Every other
 * gateway-synthesized item keeps its content, order and `call_id` and loses
 * only the nonportable synthetic `id`; unrelated items pass through untouched.
 */
const replayItemForCodex = (value: unknown): ResponseInputItem | null => {
  if (!isRecord(value)) return value as ResponseInputItem;
  const id = getString(value.id);
  if (!id || !isGatewaySyntheticItemId(id)) return value as ResponseInputItem;
  if (value.type === "reasoning" && !hasEncryptedReasoningReplay(value)) return null;
  const copy: Record<string, unknown> = { ...value };
  delete copy.id;
  return copy as ResponseInputItem;
};

export const buildCodexRequest = (
  model: string,
  input: ResponseInputItem[],
  options: Readonly<{ reasoning?: Record<string, unknown> | null; instructions?: string | null }> = {}
): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model,
    input: input.map(replayItemForCodex).filter((item): item is ResponseInputItem => item !== null),
    store: false,
    stream: true,
  };

  if (options.reasoning !== undefined) body.reasoning = options.reasoning;
  if (options.instructions !== undefined) body.instructions = options.instructions;

  return body;
};

export const validateCodexAuthJson = async (
  auth: CodexAuthState,
  options: Readonly<{ clientVersion?: string | null }> = {}
): Promise<
  | {
      ok: true;
      auth: CodexAuthState;
      refreshed: boolean;
      status: number;
      contentType: string | null;
      models: unknown;
      modelsBody: string;
      etag: string | null;
      clientVersion: string;
    }
  | {
      ok: false;
      status: number;
      body: string;
    }
> => {
  const requestedVersion = options.clientVersion?.trim() ?? null;
  const clientVersion = requestedVersion && parseCodexClientVersion(requestedVersion) ? requestedVersion : CODEX_CLIENT_VERSION;
  const urls = codexModelsBaseUrls(clientVersion);
  let refreshed = false;
  let lastResponse: Response | null = null;

  for (const url of urls) {
    let res = await fetchCodexModelsWithAuth(auth, url, clientVersion);
    if (res.status === 401) {
      const retry = await retryCodexModelsAfterAuthRefresh(auth, url, clientVersion);
      if (retry.res) {
        res = retry.res;
        auth = retry.auth;
      }
      if (retry.refreshed) refreshed = true;
    }
    if (codexModelsUrlNotFound(res, urls.length > 1)) {
      lastResponse = res;
      continue;
    }

    const contentType = res.headers.get("Content-Type");
    if (res.ok) {
      const body = await readCodexModelsResponseBody(res, contentType);
      return {
        ok: true,
        auth,
        refreshed,
        status: res.status,
        contentType,
        models: body.models,
        modelsBody: body.body,
        etag: res.headers.get("ETag"),
        clientVersion,
      };
    }

    return await codexModelsFailureResult(res);
  }

  return await codexModelsFailureResult(lastResponse ?? new Response("Codex upstream models endpoint not found.", { status: 404 }));
};
