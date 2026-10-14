import { config } from "../config.ts";
import { getKv } from "../kv.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../types.ts";
import { getString, isRecord, sha256Hex } from "../utils.ts";
import {
  CODEX_AUTH_POOL_KV_KEY,
  CodexError,
  cacheCodexAuthPool,
  getCodexAccountEmail,
  getJwtExpMs,
  parseCodexAuthFromAuthJson,
  parseCodexAuthPool,
} from "./auth.ts";
import type { CodexAuthAccountEntry, CodexAuthPoolEntry } from "./auth.ts";
import { requestNativeCodexRefresh } from "./native-auth-transport.ts";
import { externalCodexIdentity, parseExternalNativeCodexDocument } from "./external-auth.ts";

type NativeAuthHooks = {
  codexHome?: string;
  os?: typeof Deno.build.os;
  getEnv?: (name: string) => string | undefined;
  readAuth?: () => Promise<unknown>;
  refresh?: (home: string, email: string, accountId?: string) => Promise<void>;
};

let hooks: NativeAuthHooks | null = null;
/** Isolated fixtures never touch the owner's credential home or daemon. */
export const setNativeCodexAuthHooksForTest = (value: NativeAuthHooks | null): void => {
  hooks = value;
};

const nativeHome = (): string | null => {
  if (hooks?.codexHome) return hooks.codexHome;
  const os = hooks?.os ?? Deno.build.os;
  // Darwin keeps its original single-home behavior. Linux uses the same single home so the
  // VPS gateway can delegate refresh to the local daemon; multiple homes stay out of scope,
  // and a credential-home path is never trusted from a remote upload.
  if ((os !== "darwin" && os !== "linux") || config.isDeploy) return null;
  try {
    const getEnv = hooks?.getEnv ?? ((name: string) => Deno.env.get(name));
    const codexHome = getEnv("CODEX_HOME");
    if (codexHome) return codexHome;
    const home = getEnv("HOME");
    return home ? `${home}/.codex` : null;
  } catch {
    return null;
  }
};

/** The recovery contract permits the primary and the one existing named Ubiquity home. */
export const nativeCodexConsumerHomes = (): readonly string[] => {
  const primary = nativeHome();
  if (!primary) return [];
  try {
    const home = (hooks?.getEnv ?? ((name: string) => Deno.env.get(name)))("HOME");
    return home ? [...new Set([primary, `${home}/.codex-ubiquity`])] : [primary];
  } catch {
    return [primary];
  }
};

export const nativeCodexCredentialGeneration = async (auth: Pick<CodexAuthState, "account_id" | "access_token" | "refresh_token">): Promise<string> =>
  await sha256Hex(JSON.stringify([auth.account_id, auth.access_token, auth.refresh_token]));

const sameCredentials = (
  left: Pick<CodexAuthState, "access_token" | "refresh_token">,
  right: Pick<CodexAuthState, "access_token" | "refresh_token">
): boolean => left.access_token === right.access_token && left.refresh_token === right.refresh_token;

type NativeDocument = { auth: CodexAuthState; email: string | null; refreshedAt: string | null; externalUserId?: string };
const readNativeDocument = async (home: string): Promise<NativeDocument> => {
  const raw: unknown = hooks?.readAuth ? await hooks.readAuth() : JSON.parse(await Deno.readTextFile(`${home}/auth.json`));
  const external = parseExternalNativeCodexDocument(raw);
  if (external) {
    return {
      auth: { ...external.auth, updated_at_ms: Date.now() },
      email: getCodexAccountEmail(external.auth.access_token),
      refreshedAt: external.refreshedAt,
      externalUserId: external.userId,
    };
  }
  const auth = parseCodexAuthFromAuthJson(raw);
  if (!auth || !isRecord(raw) || (raw.auth_mode !== undefined && raw.auth_mode !== "chatgpt")) {
    throw new CodexError("Native Codex credentials are not managed ChatGPT auth.", "codex_auth_owner_unavailable", 503);
  }
  const tokens = isRecord(raw.tokens) ? raw.tokens : null;
  const idToken = tokens ? getString(tokens.id_token) : null;
  const refreshedAt = getString(raw.last_refresh);
  return {
    auth: { ...auth, updated_at_ms: Date.now() },
    email: idToken ? getCodexAccountEmail(idToken) : null,
    refreshedAt: refreshedAt && Number.isFinite(Date.parse(refreshedAt)) ? refreshedAt : null,
  };
};

/** Equality is the only bootstrap proof; a file never overlays uploaded siblings. */
export const bindNativeCodexAuthPool = async (input: CodexAuthPoolEntry): Promise<CodexAuthPoolEntry> => {
  const home = nativeHome();
  if (!home || !input.kv || !input.entry) return input;
  let document: NativeDocument;
  try {
    document = await readNativeDocument(home);
  } catch {
    return input;
  }
  let current = { ...input, entry: input.entry };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const index = current.pool.accounts.findIndex((candidate) => candidate.account_id === document.auth.account_id);
    if (index < 0) return current;
    const auth = current.pool.accounts[index];
    if (auth.native_owner || !sameCredentials(auth, document.auth)) return current;
    const bound: CodexAuthState = {
      ...auth,
      native_owner: {
        codex_home: home,
        generation_hash: await nativeCodexCredentialGeneration(auth),
        ...(document.refreshedAt ? { native_refreshed_at: document.refreshedAt } : {}),
      },
    };
    const accounts = [...current.pool.accounts];
    accounts[index] = bound;
    const pool = { ...current.pool, accounts };
    const committed = await input.kv.atomic().check(current.entry).set(CODEX_AUTH_POOL_KV_KEY, pool).commit();
    if (committed.ok) return { ...current, pool, entry: { key: CODEX_AUTH_POOL_KV_KEY, value: pool, versionstamp: committed.versionstamp } };
    const entry = await input.kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" });
    const latest = parseCodexAuthPool(entry.value);
    if (!latest) throw new CodexError("Native Codex ownership could not bind the current pool.", "codex_auth_owner_unavailable", 503);
    current = { kv: input.kv, entry, pool: latest };
  }
  throw new CodexError("Native Codex ownership changed concurrently; no refresh was attempted.", "codex_auth_refresh_failed", 503);
};

/** Preserve native sub-millisecond generation order when two JWTs share expiry. */
const nativeRefreshTime = (value: string | null | undefined): bigint | null => {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fractional = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "";
  return BigInt(milliseconds) * 1_000_000n + BigInt(fractional.padEnd(9, "0").slice(3, 9));
};

const verifyNativeProgress = (previous: CodexAuthState, document: NativeDocument, requireUsableAccessToken = true): void => {
  const next = document.auth;
  verifyExternalNativeIdentity(previous, document);
  const previousExpiry = getJwtExpMs(previous.access_token);
  const nextExpiry = getJwtExpMs(next.access_token);
  const priorNativeTime = nativeRefreshTime(previous.native_owner?.native_refreshed_at);
  const nextNativeTime = nativeRefreshTime(document.refreshedAt);
  const advancedNativeTime = priorNativeTime !== null && nextNativeTime !== null && nextNativeTime > priorNativeTime;
  if (
    next.account_id !== previous.account_id ||
    !nextExpiry ||
    (!requireUsableAccessToken && previousExpiry === null && !advancedNativeTime) ||
    (requireUsableAccessToken && nextExpiry <= Date.now() + 120_000) ||
    (previousExpiry !== null && (nextExpiry < previousExpiry || (nextExpiry === previousExpiry && !advancedNativeTime)))
  ) {
    throw new CodexError("Native Codex credential generation did not advance; no stale credentials were adopted.", "codex_auth_refresh_failed", 503);
  }
};

const verifyExternalNativeIdentity = (previous: CodexAuthState, document: NativeDocument): void => {
  if (!document.externalUserId && previous.native_owner?.auth_mode !== "chatgptAuthTokens") return;
  const identity = externalCodexIdentity(previous.access_token);
  if (!document.externalUserId || document.externalUserId !== identity?.userId || identity.accountId !== previous.account_id) {
    throw new CodexError("External native Codex user or workspace changed; nothing was adopted.", "codex_auth_owner_conflict", 409);
  }
};

const nativeOwnerForDocument = async (document: NativeDocument, home: string): Promise<NonNullable<CodexAuthState["native_owner"]>> => ({
  codex_home: home,
  generation_hash: await nativeCodexCredentialGeneration(document.auth),
  ...(document.refreshedAt ? { native_refreshed_at: document.refreshedAt } : {}),
  ...(document.externalUserId ? { auth_mode: "chatgptAuthTokens" as const, chatgpt_user_id: document.externalUserId } : {}),
});

/** The CLI proves the current fixed-home file and passive authorization before this plan. */
export const planExternalNativeCodexAdoption = async (
  pool: CodexAuthPoolState,
  raw: unknown,
  home: string,
  nowMs: number,
  previousRejected: boolean
): Promise<CodexAuthPoolState> => {
  const external = parseExternalNativeCodexDocument(raw);
  const index = external ? pool.accounts.findIndex((auth) => auth.account_id === external.auth.account_id) : -1;
  if (!external || index < 0 || !nativeCodexConsumerHomes().includes(home)) {
    throw new CodexError("External native Codex requires the current fixed-home account.", "codex_auth_owner_unavailable", 503);
  }
  const previous = pool.accounts[index];
  const owner = previous.native_owner;
  if (owner && (owner.codex_home !== home || owner.generation_hash !== (await nativeCodexCredentialGeneration(previous)))) {
    throw new CodexError("External native Codex destination ownership changed.", "codex_auth_owner_conflict", 409);
  }
  const document: NativeDocument = {
    auth: { ...external.auth, updated_at_ms: nowMs },
    email: null,
    refreshedAt: external.refreshedAt,
    externalUserId: external.userId,
  };
  verifyExternalNativeIdentity(previous, document);
  if (sameCredentials(previous, document.auth) && owner?.auth_mode === "chatgptAuthTokens") {
    if ((getJwtExpMs(previous.access_token) ?? 0) <= nowMs + 120_000) {
      throw new CodexError("External native access is expired or awaiting renewal.", "codex_auth_owner_unavailable", 503);
    }
    return pool;
  }
  if (owner?.auth_mode !== "chatgptAuthTokens" && !previousRejected && (getJwtExpMs(previous.access_token) ?? Infinity) > nowMs) {
    throw new CodexError("A valid managed Codex account cannot be replaced by an external consumer.", "codex_auth_owner_conflict", 409);
  }
  verifyNativeProgress(previous, document);
  const accounts = [...pool.accounts];
  accounts[index] = { ...document.auth, native_owner: await nativeOwnerForDocument(document, home) };
  return { accounts, updated_at_ms: nowMs };
};

const persistNativeGeneration = async (current: CodexAuthAccountEntry, document: NativeDocument, home: string): Promise<CodexAuthState> => {
  if (!current.kv || !current.entry) throw new CodexError("Native Codex ownership requires the durable auth pool.", "codex_auth_refresh_failed", 503);
  let entry = current.entry;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pool = parseCodexAuthPool(entry.value);
    const index = pool?.accounts.findIndex((auth) => auth.account_id === current.auth.account_id) ?? -1;
    if (!pool || index < 0) throw new CodexError("Native Codex account was removed during refresh.", "codex_auth_missing", 503);
    const previous = pool.accounts[index];
    if (previous.native_owner?.codex_home !== home || previous.native_owner.generation_hash !== (await nativeCodexCredentialGeneration(previous))) {
      throw new CodexError("Native Codex credential ownership changed during refresh.", "codex_auth_owner_unavailable", 503);
    }
    if (sameCredentials(previous, document.auth)) {
      cacheCodexAuthPool(pool);
      return previous;
    }
    verifyNativeProgress(previous, document);
    const next = {
      ...document.auth,
      native_owner: await nativeOwnerForDocument(document, home),
    };
    const accounts = [...pool.accounts];
    accounts[index] = next;
    const nextPool = { accounts, updated_at_ms: Date.now() };
    const commit = await current.kv.atomic().check(entry).set(CODEX_AUTH_POOL_KV_KEY, nextPool).commit();
    if (commit.ok) {
      cacheCodexAuthPool(nextPool);
      return next;
    }
    entry = await current.kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" });
  }
  throw new CodexError("Native Codex refresh could not persist after concurrent changes.", "codex_auth_refresh_failed", 503);
};

const verifyNativeAccountBinding = async (pool: CodexAuthPoolState, accountId: string, home: string, document: NativeDocument): Promise<CodexAuthState> => {
  const auth = pool.accounts.find((candidate) => candidate.account_id === accountId);
  if (auth?.native_owner?.codex_home !== home || document.auth.account_id !== accountId) {
    throw new CodexError("Native Codex account or credential generation is mismatched; direct refresh was refused.", "codex_auth_owner_unavailable", 503);
  }
  if (auth.native_owner.generation_hash !== (await nativeCodexCredentialGeneration(auth))) {
    throw new CodexError("Native Codex ownership no longer matches its durable credentials.", "codex_auth_owner_unavailable", 503);
  }
  verifyExternalNativeIdentity(auth, document);
  return auth;
};

type NativeAccountContext = { home: string; document: NativeDocument; current: CodexAuthAccountEntry };
const loadNativeOwnedAccount = async (input: CodexAuthState): Promise<NativeAccountContext | null> => {
  const homes = nativeCodexConsumerHomes();
  const home = input.native_owner?.codex_home ?? homes.at(0) ?? null;
  if (!home && !input.native_owner) return null;
  const ownerHome = input.native_owner?.codex_home;
  if (!home || !homes.includes(home) || (ownerHome && ownerHome !== home)) {
    throw new CodexError("Native Codex credential home is unavailable or changed.", "codex_auth_owner_unavailable", 503);
  }
  const kv = await getKv();
  const entry = kv ? await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" }) : null;
  const pool = entry ? parseCodexAuthPool(entry.value) : null;
  const stored = pool?.accounts.find((auth) => auth.account_id === input.account_id);
  let document: NativeDocument;
  try {
    document = await readNativeDocument(home);
  } catch (error) {
    if (!input.native_owner && !stored?.native_owner) return null;
    throw new CodexError("Native Codex credential file is unavailable; direct refresh was refused.", "codex_auth_owner_unavailable", 503, error);
  }
  if (!input.native_owner && !stored?.native_owner && document.auth.account_id !== input.account_id) return null;
  if (!kv || !pool || !entry || !stored)
    throw new CodexError("Native Codex ownership requires the current durable account.", "codex_auth_owner_unavailable", 503);
  const bound = await bindNativeCodexAuthPool({ kv, entry, pool });
  const auth = await verifyNativeAccountBinding(bound.pool, input.account_id, home, document);
  return { home, document, current: { ...bound, auth } };
};

/** Returns null only for an unrelated, unbound account. Never falls open for an owner. */
export const refreshNativeCodexAuthIfOwned = async (input: CodexAuthState, rejectStaleReplacement = false): Promise<CodexAuthState | null> => {
  const context = await loadNativeOwnedAccount(input);
  if (!context) return null;
  const { home, current } = context;
  const auth = current.auth;
  let document = context.document;
  if (!sameCredentials(input, auth) && !sameCredentials(input, document.auth)) {
    if (
      !rejectStaleReplacement &&
      input.native_owner?.codex_home === home &&
      input.native_owner.generation_hash === (await nativeCodexCredentialGeneration(input)) &&
      sameCredentials(auth, document.auth)
    ) {
      cacheCodexAuthPool(current.pool);
      return auth;
    }
    throw new CodexError("A stale native Codex credential replacement was refused.", "codex_auth_owner_conflict", 409);
  }
  if (!sameCredentials(auth, document.auth)) {
    if ((getJwtExpMs(document.auth.access_token) ?? 0) > Date.now() + 120_000) return await persistNativeGeneration(current, document, home);
    // Prove generation order before asking its owner to repair an expired token.
    // The expired generation is never adopted; persistence still requires usability.
    verifyNativeProgress(auth, document, false);
  }
  if (document.externalUserId || auth.native_owner?.auth_mode === "chatgptAuthTokens") {
    throw new CodexError("External Codex access must be renewed by its credential owner; local refresh was refused.", "codex_auth_owner_unavailable", 503);
  }
  if (!document.email) throw new CodexError("Native Codex account identity could not be verified.", "codex_auth_owner_unavailable", 503);
  try {
    await (hooks?.refresh ?? requestNativeCodexRefresh)(home, document.email, auth.account_id);
  } catch (error) {
    throw new CodexError("Native Codex refresh request failed; direct refresh was refused.", "codex_auth_owner_unavailable", 503, error);
  }
  document = await readNativeDocument(home);
  if (sameCredentials(auth, document.auth)) {
    throw new CodexError("Native Codex did not persist a new credential generation.", "codex_auth_refresh_failed", 503);
  }
  return await persistNativeGeneration(current, document, home);
};
