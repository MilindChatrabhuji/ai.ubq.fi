import type { Kv } from "#kv";
import { getKv } from "../kv.ts";
import { isRecord, sha256Hex } from "../utils.ts";
import { CLAUDE_CODE_MODELS_URL, claudeCodeRequestHeaders, type ClaudeCodeEnvLookup, type ClaudeCodeFetch } from "./claude-code.ts";
import {
  claudeCodeStateGeneration,
  resolveClaudeCodeCredential,
  resolveClaudeCodeWorkspace,
  type ClaudeCodeResolvedCredential,
} from "./claude-code-credentials.ts";
import { isSurplusClaudeModel } from "./surplus-claude-request.ts";
import { resolveClaudeCodeAccount, isClaudeCodeAccountCurrent, type ClaudeCodeAccountBinding } from "./claude-code-accounts.ts";

export type ClaudeCodeModel = Readonly<{
  id: string;
  display_name?: string;
  created: number;
  context_window_tokens?: number;
  supports_disabled_thinking?: boolean;
  supports_adaptive_thinking?: boolean;
  supported_reasoning_levels?: readonly string[];
  max_output_tokens?: number;
  supports_image_input?: boolean;
  supports_pdf_input?: boolean;
}>;
export type ClaudeCodeModelsSnapshot = Readonly<{ models: readonly ClaudeCodeModel[]; updated_at_ms: number; stale?: boolean }>;
type DiscoveryOptions = Readonly<{ fetcher?: ClaudeCodeFetch; now?: () => number }>;
type CatalogOptions = DiscoveryOptions &
  Readonly<{
    kv?: Kv | null;
    env?: ClaudeCodeEnvLookup;
    force?: boolean;
    accountBinding?: ClaudeCodeAccountBinding;
    expectedBinding?: Readonly<{ credential: Pick<ClaudeCodeResolvedCredential, "kind" | "secret">; workspaceId: string | null }>;
  }>;
type Cache = { identity: string; snapshot: ClaudeCodeModelsSnapshot | null; expires: number; pending: Promise<ClaudeCodeModelsSnapshot | null> | null };
const CACHE_TTL_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const MAX_PAGES = 20;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const environmentScope = {};
let caches = new WeakMap<object, Map<string, Cache>>();

export class ClaudeCodeModelsError extends Error {
  constructor(readonly status: number | null) {
    super("Claude model discovery is unavailable");
    this.name = "ClaudeCodeModelsError";
  }
}

const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const observedFlag = (parent: Record<string, unknown> | null, key: string): boolean | undefined => {
  const flag = parent && isRecord(parent[key]) ? parent[key] : null;
  return flag && typeof flag.supported === "boolean" ? flag.supported : undefined;
};
const observedEfforts = (capabilities: Record<string, unknown> | null, types: Record<string, unknown> | null): string[] => {
  const effort = capabilities && isRecord(capabilities.effort) ? capabilities.effort : null;
  if (effort?.supported !== true || observedFlag(types, "adaptive") !== true) return [];
  return Object.entries(effort)
    .filter(([key, flag]) => key !== "supported" && key !== "none" && key.length > 0 && isRecord(flag) && flag.supported === true)
    .map(([key]) => key);
};
const observedCapabilities = (value: Record<string, unknown>) => {
  const capabilities = isRecord(value.capabilities) ? value.capabilities : null;
  const thinking = isRecord(capabilities?.thinking) ? capabilities.thinking : null;
  const types = isRecord(thinking?.types) ? thinking.types : null;
  return {
    supports_disabled_thinking: observedFlag(types, "disabled"),
    supports_adaptive_thinking: observedFlag(types, "adaptive"),
    supported_reasoning_levels: observedEfforts(capabilities, types),
    supports_image_input: observedFlag(capabilities, "image_input"),
    supports_pdf_input: observedFlag(capabilities, "pdf_input"),
  };
};
const modelFromRecord = (value: unknown): ClaudeCodeModel | null => {
  if (!isRecord(value) || typeof value.id !== "string" || !isSurplusClaudeModel(value.id) || value.id.length > 512) return null;
  const created = typeof value.created_at === "string" ? Math.floor(Date.parse(value.created_at) / 1000) : 0;
  return {
    id: value.id,
    display_name: typeof value.display_name === "string" ? value.display_name : undefined,
    created: Number.isSafeInteger(created) && created > 0 ? created : 0,
    context_window_tokens: positiveInteger(value.max_input_tokens) ? value.max_input_tokens : undefined,
    max_output_tokens: positiveInteger(value.max_tokens) ? value.max_tokens : undefined,
    ...observedCapabilities(value),
  };
};

/** Native effort strings are source observations, never a model-name tier table. */
export const claudeCodeReasoningLevels = (model: ClaudeCodeModel): string[] => [
  ...(model.supports_disabled_thinking === true ? ["none"] : []),
  ...(model.supported_reasoning_levels ?? []),
];

const readPage = async (response: Response): Promise<Record<string, unknown>> => {
  if (!response.body) throw new ClaudeCodeModelsError(response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_PAGE_BYTES) throw new ClaudeCodeModelsError(response.status);
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new ClaudeCodeModelsError(response.status);
  return payload;
};

const parsedPage = async (response: Response): Promise<{ models: ClaudeCodeModel[]; next: string | null }> => {
  const payload = await readPage(response);
  const models: ClaudeCodeModel[] = [];
  for (const row of payload.data as unknown[]) {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id.trim()) throw new ClaudeCodeModelsError(response.status);
    const model = modelFromRecord(row);
    if (model) models.push(model);
  }
  if (typeof payload.has_more !== "boolean") throw new ClaudeCodeModelsError(response.status);
  if (!payload.has_more) return { models, next: null };
  if (typeof payload.last_id !== "string" || !payload.last_id) throw new ClaudeCodeModelsError(response.status);
  return { models, next: payload.last_id };
};

/** List only IDs observed on this account, following Anthropic's after_id cursor to completion. */
export const discoverClaudeCodeModels = async (
  credential: Pick<ClaudeCodeResolvedCredential, "kind" | "secret">,
  workspaceId: string | null,
  options: DiscoveryOptions = {}
): Promise<ClaudeCodeModelsSnapshot> => {
  const models = new Map<string, ClaudeCodeModel>();
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(8_000);
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(CLAUDE_CODE_MODELS_URL);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("after_id", cursor);
    const response = await (options.fetcher ?? fetch)(url, {
      headers: claudeCodeRequestHeaders(credential, { stream: false, workspaceId }),
      redirect: "manual",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ClaudeCodeModelsError(response.status);
    }
    const payload = await parsedPage(response);
    for (const model of payload.models) models.set(model.id, model);
    if (payload.next === null) return { models: [...models.values()], updated_at_ms: (options.now ?? Date.now)() };
    const next = payload.next;
    if (cursors.has(next)) throw new ClaudeCodeModelsError(response.status);
    cursors.add(next);
    cursor = next;
  }
  throw new ClaudeCodeModelsError(null);
};

const binding = async (kv: Kv | null, env?: ClaudeCodeEnvLookup, expectedAccount?: ClaudeCodeAccountBinding) => {
  const generation = claudeCodeStateGeneration(kv);
  const account = kv ? await resolveClaudeCodeAccount(kv, env, { accountId: expectedAccount?.account_id }) : null;
  if (kv && !account) return null;
  if (expectedAccount && !(await isClaudeCodeAccountCurrent(kv, expectedAccount))) return null;
  const credential = account?.credential ?? (await resolveClaudeCodeCredential(null, env));
  const workspace = account?.workspace ?? (kv ? null : await resolveClaudeCodeWorkspace(null, env));
  if (!credential || generation !== claudeCodeStateGeneration(kv)) return null;
  const workspaceId = workspace?.id ?? null;
  const identity = await sha256Hex(
    JSON.stringify([account?.account_id, account?.account_cohort_id, credential.kind, credential.secret, workspaceId, generation])
  );
  if (generation !== claudeCodeStateGeneration(kv)) return null;
  return { credential, workspaceId, identity, generation, cacheKey: account?.account_id ?? "environment" };
};

/** A failed refresh retains only this generation's snapshot and explicitly marks it stale. */
export const fetchClaudeCodeModels = async (options: CatalogOptions = {}): Promise<ClaudeCodeModelsSnapshot | null> => {
  const kv = options.kv === undefined ? await getKv() : options.kv;
  const scope = kv ?? environmentScope;
  const current = await binding(kv, options.env, options.accountBinding).catch(() => null);
  if (!current) {
    if (!options.accountBinding) caches.delete(scope);
    return null;
  }
  const expected = options.expectedBinding;
  if (
    expected &&
    (current.credential.kind !== expected.credential.kind ||
      current.credential.secret !== expected.credential.secret ||
      current.workspaceId !== expected.workspaceId)
  ) {
    return null;
  }
  const scoped = caches.get(scope) ?? new Map<string, Cache>();
  caches.set(scope, scoped);
  let cached = scoped.get(current.cacheKey);
  if (cached?.identity !== current.identity) {
    cached = { identity: current.identity, snapshot: null, expires: 0, pending: null };
    scoped.set(current.cacheKey, cached);
  }
  const state = cached;
  const now = (options.now ?? Date.now)();
  if (!options.force && state.expires > now) return state.snapshot;
  if (state.pending) return await state.pending;
  const pending = (async () => {
    let snapshot: ClaudeCodeModelsSnapshot | null;
    try {
      snapshot = await discoverClaudeCodeModels(current.credential, current.workspaceId, options);
    } catch {
      snapshot = state.snapshot
        ? {
            ...state.snapshot,
            models: state.snapshot.models.map((model) => ({
              ...model,
              supports_disabled_thinking: undefined,
              supports_adaptive_thinking: undefined,
              supported_reasoning_levels: undefined,
            })),
            stale: true,
          }
        : null;
    }
    const latest = await binding(kv, options.env, options.accountBinding).catch(() => null);
    if (caches.get(scope)?.get(current.cacheKey) !== state || latest?.identity !== current.identity || current.generation !== claudeCodeStateGeneration(kv))
      return null;
    state.snapshot = snapshot;
    state.expires = now + (snapshot && !snapshot.stale ? CACHE_TTL_MS : RETRY_MS);
    return snapshot;
  })();
  state.pending = pending;
  try {
    return await pending;
  } finally {
    state.pending = null;
  }
};

/** Reuse the successful upload validation without publishing it for a rotated credential/workspace. */
export const cacheValidatedClaudeCodeModels = async (
  kv: Kv,
  secret: string,
  workspaceId: string | null,
  snapshot: ClaudeCodeModelsSnapshot,
  env?: ClaudeCodeEnvLookup,
  accountBinding?: ClaudeCodeAccountBinding
): Promise<void> => {
  const current = await binding(kv, env, accountBinding).catch(() => null);
  if (current?.credential.secret !== secret || current.workspaceId !== workspaceId || current.generation !== claudeCodeStateGeneration(kv)) return;
  const scoped = caches.get(kv) ?? new Map<string, Cache>();
  scoped.set(current.cacheKey, { identity: current.identity, snapshot, expires: Date.now() + CACHE_TTL_MS, pending: null });
  caches.set(kv, scoped);
};

export const resetClaudeCodeModelsCacheForTest = (): void => {
  caches = new WeakMap();
};
