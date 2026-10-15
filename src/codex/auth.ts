import type { Kv, KvEntryMaybe } from "#kv";
import { readFileSync } from "node:fs";
// Codex auth pool parsing, caching and loading, split out of src/codex.ts.

import { config } from "../config.ts";
import { markCodexSuccess, releaseCodexRoutingProbe } from "./account-routing.ts";
import { type RoutingAccount } from "./routing-state.ts";
import { resetCodexAccountRoutingForTest } from "./capacity-routing.ts";
import { type CodexActiveAccountTransitionReason } from "./routing-state.ts";

import { getKv } from "../kv.ts";
import { recordCodexProviderHealth } from "../provider/health.ts";
import { base64UrlDecode, decodeBase64ToString, getString, isRecord, sha256Hex } from "../utils.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../types.ts";
import { bindNativeCodexAuthPool } from "./native-auth.ts";
import { externalCodexIdentity } from "./external-auth.ts";

const CODEX_REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_CLIENT_VERSION = "0.100.0";
export const CODEX_QUOTA_BLOCKED_ERROR_CODE = "codex_quota_blocked";
export const CODEX_SUBSCRIPTIONS_UNAVAILABLE_ERROR_CODE = "codex_subscriptions_unavailable";
export const CODEX_UPSTREAM_DEGRADED_ERROR_CODE = "codex_upstream_degraded";
export const CODEX_AUTH_REAUTH_WARNING = "codex_auth_reauthentication_required";
export const CODEX_AUTH_REAUTH_MESSAGE = "The gateway's Codex auth.json needs re-authentication. Upload a fresh auth.json and retry.";
/** Bounded one-account re-admissions after an authoritative transition signal. */
const CODEX_ACTIVE_ADMISSION_RESEELECTION_LIMIT = 3;

// Routing errors need to remain distinguishable to the gateway's fallback
// adapter without adding gateway-only headers to OpenAI-compatible responses.
const codexRoutingErrors = new WeakMap<Response, string>();
const codexAuthWarnings = new WeakMap<Response, string>();

export const getCodexRoutingError = (response: Response): string | null => codexRoutingErrors.get(response) ?? null;

const parseSemverTriplet = (value: string): [number, number, number] | null => {
  const parts = value.trim().split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((num) => !Number.isFinite(num) || num < 0)) return null;
  const [major, minor, patch = 0] = nums;
  return [Math.trunc(major), Math.trunc(minor), Math.trunc(patch)];
};

const pickHigherSemver = (a: string | null | undefined, b: string | null | undefined): string | null => {
  const aNorm = typeof a === "string" ? a.trim() : "";
  const bNorm = typeof b === "string" ? b.trim() : "";
  if (!aNorm && !bNorm) return null;
  if (!aNorm) return bNorm || null;
  if (!bNorm) return aNorm || null;

  const aParsed = parseSemverTriplet(aNorm);
  const bParsed = parseSemverTriplet(bNorm);
  if (!aParsed || !bParsed) return aNorm;
  for (let i = 0; i < 3; i++) {
    if (aParsed[i] > bParsed[i]) return aNorm;
    if (aParsed[i] < bParsed[i]) return bNorm;
  }
  return aNorm;
};

const codexUserAgent = (clientVersion?: string | null): string => {
  const version = pickHigherSemver(clientVersion, CODEX_CLIENT_VERSION) ?? CODEX_CLIENT_VERSION;
  return `codex_cli_rs/${version} (ai.ubq.fi)`;
};

export type CodexErrorCode =
  | "codex_auth_missing"
  | "codex_auth_invalid"
  | "codex_auth_refresh_failed"
  | "refresh_token_reused"
  | "codex_auth_refresh_unreachable"
  | "codex_auth_owner_unavailable"
  | "codex_auth_owner_conflict"
  | "codex_upstream_unreachable"
  | "gateway_timeout";

export class CodexError extends Error {
  readonly code: CodexErrorCode;
  readonly status: number;

  constructor(message: string, code: CodexErrorCode, status: number, cause?: unknown) {
    super(message);
    this.name = "CodexError";
    this.code = code;
    this.status = status;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export const CODEX_AUTH_POOL_KV_KEY = ["ubq_ai", "codex_auth"] as const;
export const CODEX_MODELS_KV_KEY = ["ubq_ai", "codex_models"] as const;
export const CODEX_AUTH_REFRESH_LEASE_PREFIX = ["uos_ai", "codex_auth_refresh", "v1"] as const;
export const CODEX_AUTH_CACHE_TTL_MS = 5 * 60_000;
export const CODEX_AUTH_POOL_MAX_ACCOUNTS = 2;
const CODEX_AUTH_REFRESH_LEASE_MS = 15_000;
const CODEX_AUTH_REFRESH_WAIT_MS = 10_000;
export const CODEX_ADDITIONAL_429_RETRY_MAX_DELAY_MS = 2_000;

export const parseCodexAuthFromAuthJson = (value: unknown): Omit<CodexAuthState, "updated_at_ms"> | null => {
  if (!isRecord(value) || value.auth_mode === "chatgptAuthTokens") return null;
  const tokens = isRecord(value.tokens) ? value.tokens : null;
  if (!tokens) return null;
  const accessToken = getString(tokens.access_token);
  const refreshToken = getString(tokens.refresh_token);
  const accountId = getString(tokens.account_id);
  if (!accessToken || !refreshToken || !accountId) return null;
  return { access_token: accessToken, refresh_token: refreshToken, account_id: accountId };
};

const parseNativeAuthOwner = (value: unknown): CodexAuthState["native_owner"] => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !getString(value.codex_home)?.startsWith("/") || !/^[a-f0-9]{64}$/.test(getString(value.generation_hash) ?? "")) {
    throw new CodexError("Codex native credential ownership is malformed; nothing was replaced.", "codex_auth_owner_unavailable", 503);
  }
  const refreshedAt = getString(value.native_refreshed_at);
  const userId = getString(value.chatgpt_user_id);
  if (value.auth_mode !== undefined && (value.auth_mode !== "chatgptAuthTokens" || !userId)) {
    throw new CodexError("Codex external native ownership is malformed; nothing was replaced.", "codex_auth_owner_unavailable", 503);
  }
  return {
    codex_home: String(value.codex_home),
    generation_hash: String(value.generation_hash),
    ...(refreshedAt ? { native_refreshed_at: refreshedAt } : {}),
    ...(value.auth_mode === "chatgptAuthTokens" ? { auth_mode: "chatgptAuthTokens" as const, chatgpt_user_id: userId ?? undefined } : {}),
  };
};

const parsePoolRefreshToken = (candidate: Record<string, unknown>, owner: CodexAuthState["native_owner"]): string | null => {
  const refreshToken = getString(candidate.refresh_token);
  if (owner?.auth_mode !== "chatgptAuthTokens") return refreshToken === "" ? null : refreshToken;
  const accessToken = getString(candidate.access_token);
  const identity = accessToken ? externalCodexIdentity(accessToken) : null;
  if (candidate.refresh_token !== "" || identity?.userId !== owner.chatgpt_user_id || identity?.accountId !== candidate.account_id) return null;
  return "";
};

const parsePoolAccount = (candidate: unknown): CodexAuthState | null => {
  if (!isRecord(candidate)) return null;
  const accessToken = getString(candidate.access_token);
  const owner = parseNativeAuthOwner(candidate.native_owner);
  const refreshToken = parsePoolRefreshToken(candidate, owner);
  const accountId = getString(candidate.account_id);
  const updatedAtMs = typeof candidate.updated_at_ms === "number" && Number.isFinite(candidate.updated_at_ms) ? candidate.updated_at_ms : null;
  if (!accessToken || refreshToken === null || !accountId || updatedAtMs === null) return null;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: accountId,
    updated_at_ms: updatedAtMs,
    ...(owner ? { native_owner: owner } : {}),
  };
};

export const parseCodexAuthPool = (value: unknown): CodexAuthPoolState | null => {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return null;
  if (value.accounts.length < 1 || value.accounts.length > CODEX_AUTH_POOL_MAX_ACCOUNTS) return null;
  const updatedAtMs = typeof value.updated_at_ms === "number" && Number.isFinite(value.updated_at_ms) ? value.updated_at_ms : null;
  if (updatedAtMs === null) return null;

  const accountIds = new Set<string>();
  const accounts: CodexAuthState[] = [];
  for (const candidate of value.accounts) {
    const account = parsePoolAccount(candidate);
    if (!account || accountIds.has(account.account_id)) return null;
    accountIds.add(account.account_id);
    accounts.push(account);
  }

  return { accounts, updated_at_ms: updatedAtMs };
};

export const upsertCodexAuthAccount = (pool: CodexAuthPoolState | null, auth: CodexAuthState): CodexAuthPoolState | null => {
  if (!auth.refresh_token && auth.native_owner?.auth_mode !== "chatgptAuthTokens") {
    throw new CodexError("Access-only Codex auth requires proven external native ownership.", "codex_auth_owner_unavailable", 503);
  }
  const accounts = pool ? [...pool.accounts] : [];
  const matchingIndex = accounts.findIndex((candidate) => candidate.account_id === auth.account_id);
  if (matchingIndex >= 0) {
    const previous = accounts[matchingIndex];
    const sameTokens = previous.access_token === auth.access_token && previous.refresh_token === auth.refresh_token;
    if (
      previous.native_owner &&
      !sameTokens &&
      (auth.native_owner?.codex_home !== previous.native_owner.codex_home || (getJwtExpMs(auth.access_token) ?? 0) < (getJwtExpMs(previous.access_token) ?? 0))
    ) {
      throw new CodexError("The native Codex owner must advance this account's credentials before replacement.", "codex_auth_owner_conflict", 409);
    }
    accounts[matchingIndex] = previous.native_owner && sameTokens ? { ...auth, native_owner: previous.native_owner } : auth;
  } else if (accounts.length < CODEX_AUTH_POOL_MAX_ACCOUNTS) {
    accounts.push(auth);
  } else {
    return null;
  }
  return { accounts, updated_at_ms: Date.now() };
};

export const getJwtExpMs = (token: unknown): number | null => {
  if (typeof token !== "string") return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[1].length === 0) return null;
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const decoded = decodeBase64ToString(padded);
    const parsed: unknown = JSON.parse(decoded);
    const exp = isRecord(parsed) && typeof parsed.exp === "number" && Number.isFinite(parsed.exp) ? parsed.exp : null;
    return exp ? exp * 1000 : null;
  } catch {
    return null;
  }
};

/** True when the value contains a C0 control character or DEL, which never appear in a real address. */
const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
};

const normalizeCodexAccountEmail = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (email.length === 0 || email.length > 320 || hasControlCharacter(email)) return null;
  return email.includes("@") ? email : null;
};

const jwtPayload = (token: string): Record<string, unknown> | null => {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Returns the provider email claim without retaining or exposing the token. */
export const getCodexAccountEmail = (accessToken: string): string | null => {
  const payload = jwtPayload(accessToken);
  if (!payload) return null;
  const profile = isRecord(payload["https://api.openai.com/profile"]) ? payload["https://api.openai.com/profile"] : null;
  return normalizeCodexAccountEmail(profile?.email) ?? normalizeCodexAccountEmail(payload.email);
};

const needsRefresh = (auth: CodexAuthState): boolean => {
  const expMs = getJwtExpMs(auth.access_token);
  const now = Date.now();
  if (expMs) return expMs - now < 2 * 60_000;
  return now - auth.updated_at_ms > 7 * 60_000;
};

const accessTokenExpired = (auth: CodexAuthState): boolean => {
  const expMs = getJwtExpMs(auth.access_token);
  return expMs !== null && expMs <= Date.now();
};

const codexAuthWarningForError = (error: unknown): string | null =>
  error instanceof CodexError && (error.code === "codex_auth_invalid" || error.code === "codex_auth_refresh_failed" || error.code === "refresh_token_reused")
    ? CODEX_AUTH_REAUTH_WARNING
    : null;

type CodexAuthPoolEntry = {
  kv: Kv | null;
  entry: KvEntryMaybe<CodexAuthPoolState> | null;
  pool: CodexAuthPoolState;
};

type CodexAuthAccountEntry = CodexAuthPoolEntry & {
  auth: CodexAuthState;
  routing?: RoutingAccount;
};

/** A routable account entry: `routing` is always present once a slot is selected. */
type CodexDispatchAccountEntry = CodexAuthAccountEntry & { routing: RoutingAccount };

/**
 * Safe response-local active-subscription telemetry. It is captured from the
 * routing account that was actually admitted and never inferred later from
 * mutable slot state. No raw account ids, keys or session metadata.
 */
export type CodexResponseActiveTelemetry = Readonly<{
  activeGeneration: number | null;
  activeTransitionReason: CodexActiveAccountTransitionReason | null;
}>;

type CodexRefreshLease = Readonly<{
  owner: string;
  lease_until_ms: number;
}>;

let cachedAuthPool: CodexAuthPoolState | null = null;
let cachedAuthPoolExpiresAtMs = 0;
let authCacheGeneration = 0;
let authPoolEntryInFlight: Promise<CodexAuthPoolEntry> | null = null;
const refreshesInFlight = new Map<string, Promise<CodexAuthState>>();
const codexProbeByResponse = new WeakMap<Response, RoutingAccount>();
const codexSlotByResponse = new WeakMap<Response, number>();
const codexAccountIdByResponse = new WeakMap<Response, string>();
const codexActiveTelemetryByResponse = new WeakMap<Response, CodexResponseActiveTelemetry>();
const codexTerminalOutcomeByResponse = new WeakSet<Response>();
const codexProbeTransitionsInFlight = new Set<Promise<void>>();

const setCodexResponseAccountTelemetry = (response: Response, slot: number, accountId: string): void => {
  codexSlotByResponse.set(response, slot);
  codexAccountIdByResponse.set(response, accountId);
};

const setCodexResponseActiveTelemetry = (response: Response, routing: RoutingAccount): void => {
  if (routing.activeGeneration === undefined) return;
  codexActiveTelemetryByResponse.set(response, {
    activeGeneration: routing.activeGeneration,
    activeTransitionReason: routing.activeTransitionReason ?? null,
  });
};

const inheritCodexResponseActiveTelemetry = (response: Response, source: Response): void => {
  const telemetry = codexActiveTelemetryByResponse.get(source);
  if (telemetry !== undefined) codexActiveTelemetryByResponse.set(response, telemetry);
};

/** Null fields mean the response was not admitted through a durable active decision. */
export const getCodexResponseActiveTelemetry = (response: Response): CodexResponseActiveTelemetry =>
  codexActiveTelemetryByResponse.get(response) ?? { activeGeneration: null, activeTransitionReason: null };

const withCodexWarnings = (response: Response, warnings: readonly string[]): Response => {
  const headers = new Headers(response.headers);
  const existing =
    headers
      .get("x-uos-warning")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  for (const warning of warnings) {
    if (!existing.includes(warning)) existing.push(warning);
  }
  if (!existing.length) return response;
  headers.set("x-uos-warning", existing.join(", "));
  const decorated = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const routingError = codexRoutingErrors.get(response);
  if (routingError) codexRoutingErrors.set(decorated, routingError);
  const probe = codexProbeByResponse.get(response);
  if (probe) codexProbeByResponse.set(decorated, probe);
  const slot = codexSlotByResponse.get(response);
  if (slot !== undefined) codexSlotByResponse.set(decorated, slot);
  const accountId = codexAccountIdByResponse.get(response);
  if (accountId !== undefined) codexAccountIdByResponse.set(decorated, accountId);
  const activeTelemetry = codexActiveTelemetryByResponse.get(response);
  if (activeTelemetry !== undefined) codexActiveTelemetryByResponse.set(decorated, activeTelemetry);
  const authWarning = codexAuthWarnings.get(response);
  if (authWarning !== undefined) codexAuthWarnings.set(decorated, authWarning);
  if (codexTerminalOutcomeByResponse.has(response)) codexTerminalOutcomeByResponse.add(decorated);
  return decorated;
};

const withCodexAuthWarning = (response: Response, warning: string): Response => {
  const decorated = withCodexWarnings(response, [warning]);
  codexAuthWarnings.set(decorated, warning);
  return decorated;
};

/** The metadata stays isolate-local and never becomes a response header or durable credential record. */
export const getCodexRoutingProbe = (response: Response): RoutingAccount | null => codexProbeByResponse.get(response) ?? null;

/** The slot is isolate-local telemetry only; account IDs never leave the routing layer. */
export const getCodexResponseSlot = (response: Response): number | null => codexSlotByResponse.get(response) ?? null;

/** Returns a stable digest while keeping the raw account ID inside this module. */
export const getCodexResponseAccountCohortId = async (response: Response): Promise<string | null> => {
  const accountId = codexAccountIdByResponse.get(response);
  return accountId === undefined ? null : await sha256Hex(`uos-prompt-cache-account-cohort-v1\u0000${accountId}`);
};

const takeCodexResponseProbe = (response: Response): RoutingAccount | null => {
  const probe = codexProbeByResponse.get(response);
  if (probe) codexProbeByResponse.delete(response);
  return probe ?? null;
};

const beginCodexResponseTerminalOutcome = (
  response: Response
): Readonly<{
  accountId: string | null;
  probe: RoutingAccount | null;
}> | null => {
  if (codexTerminalOutcomeByResponse.has(response)) return null;
  codexTerminalOutcomeByResponse.add(response);
  return {
    accountId: codexAccountIdByResponse.get(response) ?? null,
    probe: takeCodexResponseProbe(response),
  };
};

const completeCodexProbeTransition = async (transition: Promise<void>): Promise<void> => {
  codexProbeTransitionsInFlight.add(transition);
  try {
    await transition;
  } finally {
    codexProbeTransitionsInFlight.delete(transition);
  }
};

const codexProviderRequestId = (response: Response): string | null =>
  response.headers.get("X-Request-Id") ?? response.headers.get("X-Api-Request-Id") ?? response.headers.get("X-Oneapi-Request-Id");

/**
 * Detach a response from its recovery probe without claiming success. Failed,
 * cancelled, or incomplete streams release ordinary routing, but retain the
 * durable ambiguity tombstone until a later recovery probe proves the account
 * healthy.
 */
export const releaseCodexResponseProbe = async (response: Response): Promise<void> => {
  const terminal = beginCodexResponseTerminalOutcome(response);
  if (!terminal) return;
  if (terminal.probe) await completeCodexProbeTransition(releaseCodexRoutingProbe(terminal.probe));
};

/** Only a validated upstream `response.completed` event may clear the recovery probe. */
export const markCodexResponseCompleted = async (response: Response): Promise<void> => {
  const terminal = beginCodexResponseTerminalOutcome(response);
  if (!terminal) return;
  if (terminal.probe) await completeCodexProbeTransition(markCodexSuccess(terminal.probe));
  if (terminal.accountId !== null) {
    void recordCodexProviderHealth(terminal.accountId, "success", response.status, Date.now, codexProviderRequestId(response)).catch(() => {});
  }
};

/** A trustworthy failure after 2xx headers degrades health without treating cancellation or incompletion as failure. */
export const markCodexResponseUpstreamError = async (response: Response): Promise<void> => {
  const terminal = beginCodexResponseTerminalOutcome(response);
  if (!terminal) return;
  if (response.ok && terminal.accountId !== null) {
    void recordCodexProviderHealth(terminal.accountId, "upstream_error", response.status, Date.now, codexProviderRequestId(response)).catch(() => {});
  }
  if (terminal.probe) await completeCodexProbeTransition(releaseCodexRoutingProbe(terminal.probe));
};

export const cacheCodexAuthPool = (pool: CodexAuthPoolState): void => {
  authCacheGeneration += 1;
  cachedAuthPool = pool;
  cachedAuthPoolExpiresAtMs = Date.now() + CODEX_AUTH_CACHE_TTL_MS;
};

export const resetCodexAuthCacheForTest = (): void => {
  authCacheGeneration += 1;
  cachedAuthPool = null;
  cachedAuthPoolExpiresAtMs = 0;
  authPoolEntryInFlight = null;
  refreshesInFlight.clear();
  codexProbeTransitionsInFlight.clear();
  resetCodexAccountRoutingForTest();
};

const loadAuthSeedFromEnv = (): CodexAuthState => {
  if (config.isDeploy) {
    if (!config.codexAuthJsonB64) {
      throw new CodexError("Codex auth missing: CODEX_AUTH_JSON_B64 unset and no KV entry.", "codex_auth_missing", 503);
    }
  }

  if (config.codexAuthJsonB64) {
    let decoded: string;
    try {
      decoded = decodeBase64ToString(config.codexAuthJsonB64);
    } catch (error) {
      throw new CodexError("Codex auth invalid: CODEX_AUTH_JSON_B64 is not valid base64.", "codex_auth_invalid", 503, error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded) as unknown;
    } catch (error) {
      throw new CodexError("Codex auth invalid: CODEX_AUTH_JSON_B64 is not valid JSON.", "codex_auth_invalid", 503, error);
    }
    const tokenData = parseCodexAuthFromAuthJson(parsed);
    if (!tokenData) {
      throw new CodexError("Codex auth invalid: CODEX_AUTH_JSON_B64 does not look like a Codex auth.json.", "codex_auth_invalid", 503);
    }
    return { ...tokenData, updated_at_ms: Date.now() };
  }

  if (config.isDeploy) {
    throw new CodexError("Codex auth missing: CODEX_AUTH_JSON_B64 unset and no KV entry.", "codex_auth_missing", 503);
  }

  return loadAuthSeedFromDisk();
};

const loadAuthSeedFromDisk = (): CodexAuthState => {
  if (!config.isDeploy) {
    const home = process.env.HOME;
    if (!home) {
      throw new CodexError("Could not resolve home directory for ~/.codex/auth.json.", "codex_auth_invalid", 503);
    }
    try {
      const raw = readFileSync(`${home}/.codex/auth.json`, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const tokenData = parseCodexAuthFromAuthJson(parsed);
      if (!tokenData) {
        throw new CodexError("Codex auth invalid: ~/.codex/auth.json does not look like a Codex auth.json.", "codex_auth_invalid", 503);
      }
      return { ...tokenData, updated_at_ms: Date.now() };
    } catch (error) {
      if (error instanceof CodexError) throw error;
      throw new CodexError("Codex auth invalid: ~/.codex/auth.json is missing or unreadable.", "codex_auth_invalid", 503, error);
    }
  }
  throw new CodexError("Codex auth missing: CODEX_AUTH_JSON_B64 unset and no KV entry.", "codex_auth_missing", 503);
};

const getConfiguredCodexAuthSeed = (): CodexAuthState | null => {
  if (!config.codexAuthJsonB64) {
    return loadAuthSeedFromEnv(); // throws when unavailable in deploy or returns fallback in local
  }
  try {
    return loadAuthSeedFromEnv();
  } catch {
    if (config.isDeploy) return null;
    try {
      return loadAuthSeedFromDisk();
    } catch {
      return null;
    }
  }
};

const poolFromSeed = (auth: CodexAuthState): CodexAuthPoolState => ({
  accounts: [auth],
  updated_at_ms: auth.updated_at_ms,
});

const loadedAuthPoolEntry = (
  pool: CodexAuthPoolState,
  generationAtStart: number,
  kv: Kv | null,
  entry: KvEntryMaybe<CodexAuthPoolState> | null
): CodexAuthPoolEntry => {
  if (authCacheGeneration !== generationAtStart && cachedAuthPool) {
    return { kv: null, entry: null, pool: cachedAuthPool };
  }
  cacheCodexAuthPool(pool);
  return { kv, entry, pool };
};

const loadAuthPoolEntry = async (generationAtStart: number): Promise<CodexAuthPoolEntry> => {
  const kv = await getKv();
  if (!kv) {
    const pool =
      cachedAuthPool ??
      (() => {
        const seed = getConfiguredCodexAuthSeed();
        return seed ? poolFromSeed(seed) : null;
      })();
    if (!pool) {
      throw new CodexError("Codex auth missing: CODEX_AUTH_JSON_B64 unset and no KV entry.", "codex_auth_missing", 503);
    }
    return loadedAuthPoolEntry(pool, generationAtStart, null, null);
  }

  const entry = await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" });
  const storedPool = parseCodexAuthPool(entry.value);
  if (storedPool) {
    // A valid persisted pool is the authority. Local/disk seeds may bootstrap
    // an absent row or run without KV, but must never overwrite or append to
    // credentials an admin has already uploaded.
    const nativeEntry = await bindNativeCodexAuthPool({ pool: storedPool, kv, entry });
    return loadedAuthPoolEntry(nativeEntry.pool, generationAtStart, kv, nativeEntry.entry);
  }

  const seed = getConfiguredCodexAuthSeed();
  if (!seed) {
    throw new CodexError("Codex auth missing: CODEX_AUTH_JSON_B64 unset and no KV entry.", "codex_auth_missing", 503);
  }
  if (authCacheGeneration !== generationAtStart && cachedAuthPool) {
    return { kv: null, entry: null, pool: cachedAuthPool };
  }
  const pool = poolFromSeed(seed);
  const seeded = await kv.set(CODEX_AUTH_POOL_KV_KEY, pool);
  const nativeEntry = await bindNativeCodexAuthPool({ kv, pool, entry: { key: CODEX_AUTH_POOL_KV_KEY, value: pool, versionstamp: seeded.versionstamp } });
  return loadedAuthPoolEntry(nativeEntry.pool, generationAtStart, kv, nativeEntry.entry);
};

const getAuthPoolEntry = async (forceKv = false, bypassInFlight = false): Promise<CodexAuthPoolEntry> => {
  if (!forceKv && cachedAuthPool && Date.now() < cachedAuthPoolExpiresAtMs) {
    return { kv: null, entry: null, pool: cachedAuthPool };
  }

  // A banked-reset retry uses this after a verified, expensive side effect.
  // It must not inherit an in-flight read that began before an auth-pool
  // rotation. A direct strong read is deliberately narrower than the normal
  // warm-cache single-flight path.
  if (bypassInFlight) return await loadAuthPoolEntry(authCacheGeneration);

  // A bounded single read makes credential replacement converge across warm
  // isolates without restoring a KV lookup to every inference request.
  if (authPoolEntryInFlight) return await authPoolEntryInFlight;
  authPoolEntryInFlight = loadAuthPoolEntry(authCacheGeneration).finally(() => {
    authPoolEntryInFlight = null;
  });
  return await authPoolEntryInFlight;
};

export type { CodexAuthAccountEntry, CodexAuthPoolEntry, CodexDispatchAccountEntry, CodexRefreshLease };
export {
  CODEX_ACTIVE_ADMISSION_RESEELECTION_LIMIT,
  CODEX_AUTH_REFRESH_LEASE_MS,
  CODEX_AUTH_REFRESH_WAIT_MS,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CODEX_REFRESH_CLIENT_ID,
  CODEX_REFRESH_TOKEN_URL,
  accessTokenExpired,
  authCacheGeneration,
  cachedAuthPool,
  codexAuthWarningForError,
  codexProbeByResponse,
  codexProbeTransitionsInFlight,
  codexRoutingErrors,
  codexUserAgent,
  getAuthPoolEntry,
  inheritCodexResponseActiveTelemetry,
  needsRefresh,
  refreshesInFlight,
  setCodexResponseAccountTelemetry,
  setCodexResponseActiveTelemetry,
  withCodexAuthWarning,
  withCodexWarnings,
};
