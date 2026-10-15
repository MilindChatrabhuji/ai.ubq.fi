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

export type ClaudeCodeModel = Readonly<{
  id: string;
  display_name?: string;
  created: number;
  context_window_tokens?: number;
  supports_disabled_thinking?: boolean;
}>;
export type ClaudeCodeModelsSnapshot = Readonly<{ models: readonly ClaudeCodeModel[]; updated_at_ms: number; stale?: boolean }>;
type DiscoveryOptions = Readonly<{ fetcher?: ClaudeCodeFetch; now?: () => number }>;
type CatalogOptions = DiscoveryOptions &
  Readonly<{
    kv?: Kv | null;
    env?: ClaudeCodeEnvLookup;
    force?: boolean;
    expectedBinding?: Readonly<{ credential: Pick<ClaudeCodeResolvedCredential, "kind" | "secret">; workspaceId: string | null }>;
  }>;
type Cache = { identity: string; snapshot: ClaudeCodeModelsSnapshot | null; expires: number; pending: Promise<ClaudeCodeModelsSnapshot | null> | null };
const CACHE_TTL_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const MAX_PAGES = 20;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const environmentScope = {};
let caches = new WeakMap<object, Cache>();

export class ClaudeCodeModelsError extends Error {
  constructor(readonly status: number | null) {
    super("Claude model discovery is unavailable");
    this.name = "ClaudeCodeModelsError";
  }
}

const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const modelFromRecord = (value: unknown): ClaudeCodeModel | null => {
  if (!isRecord(value) || typeof value.id !== "string" || !isSurplusClaudeModel(value.id) || value.id.length > 512) return null;
  const created = typeof value.created_at === "string" ? Math.floor(Date.parse(value.created_at) / 1000) : 0;
  const capabilities = isRecord(value.capabilities) ? value.capabilities : null;
  const thinking = isRecord(capabilities?.thinking) ? capabilities.thinking : null;
  const types = isRecord(thinking?.types) ? thinking.types : null;
  const disabled = isRecord(types?.disabled) ? types.disabled : null;
  return {
    id: value.id,
    ...(typeof value.display_name === "string" ? { display_name: value.display_name } : {}),
    created: Number.isSafeInteger(created) && created > 0 ? created : 0,
    ...(positiveInteger(value.max_input_tokens) ? { context_window_tokens: value.max_input_tokens } : {}),
    ...(typeof disabled?.supported === "boolean" ? { supports_disabled_thinking: disabled.supported } : {}),
  };
};

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

const binding = async (kv: Kv | null, env?: ClaudeCodeEnvLookup) => {
  const generation = claudeCodeStateGeneration(kv);
  const [credential, workspace] = await Promise.all([resolveClaudeCodeCredential(kv, env), resolveClaudeCodeWorkspace(kv, env)]);
  if (!credential || generation !== claudeCodeStateGeneration(kv)) return null;
  const workspaceId = workspace?.id ?? null;
  const identity = await sha256Hex(JSON.stringify([credential.kind, credential.secret, credential.updated_at_ms, workspaceId, generation]));
  if (generation !== claudeCodeStateGeneration(kv)) return null;
  return { credential, workspaceId, identity, generation };
};

/** A failed refresh retains only this generation's snapshot and explicitly marks it stale. */
export const fetchClaudeCodeModels = async (options: CatalogOptions = {}): Promise<ClaudeCodeModelsSnapshot | null> => {
  const kv = options.kv === undefined ? await getKv() : options.kv;
  const scope = kv ?? environmentScope;
  const current = await binding(kv, options.env).catch(() => null);
  if (!current) {
    caches.delete(scope);
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
  let cached = caches.get(scope);
  if (cached?.identity !== current.identity) {
    cached = { identity: current.identity, snapshot: null, expires: 0, pending: null };
    caches.set(scope, cached);
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
            models: state.snapshot.models.map((model) => ({ ...model, supports_disabled_thinking: undefined })),
            stale: true,
          }
        : null;
    }
    const latest = await binding(kv, options.env).catch(() => null);
    if (caches.get(scope) !== state || latest?.identity !== current.identity || current.generation !== claudeCodeStateGeneration(kv)) return null;
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
  env?: ClaudeCodeEnvLookup
): Promise<void> => {
  const current = await binding(kv, env).catch(() => null);
  if (current?.credential.secret !== secret || current.workspaceId !== workspaceId || current.generation !== claudeCodeStateGeneration(kv)) return;
  caches.set(kv, { identity: current.identity, snapshot, expires: Date.now() + CACHE_TTL_MS, pending: null });
};

export const resetClaudeCodeModelsCacheForTest = (): void => {
  caches = new WeakMap();
};
