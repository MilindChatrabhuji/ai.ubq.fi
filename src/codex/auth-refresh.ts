import type { Kv, KvKey } from "#kv";
// Codex auth refresh coordination, split out of src/codex.ts.

import { readBoundedResponseBody } from "../bounded-response-body.ts";
import { recordCodexProviderHealth } from "../provider/health.ts";
import { getString, isRecord, sha256Hex } from "../utils.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../types.ts";
import type { CodexAuthAccountEntry, CodexErrorCode, CodexRefreshLease } from "./auth.ts";
import { refreshNativeCodexAuthIfOwned } from "./native-auth.ts";
import {
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_AUTH_REAUTH_MESSAGE,
  CODEX_AUTH_REFRESH_LEASE_MS,
  CODEX_AUTH_REFRESH_LEASE_PREFIX,
  CODEX_AUTH_REFRESH_WAIT_MS,
  CODEX_REFRESH_CLIENT_ID,
  CODEX_REFRESH_TOKEN_URL,
  CodexError,
  authCacheGeneration,
  cacheCodexAuthPool,
  cachedAuthPool,
  getAuthPoolEntry,
  needsRefresh,
  parseCodexAuthPool,
  refreshesInFlight,
} from "./auth.ts";

const getCurrentAccountEntry = async (accountId: string, forceKv: boolean): Promise<CodexAuthAccountEntry> => {
  const poolEntry = await getAuthPoolEntry(forceKv);
  const auth = poolEntry.pool.accounts.find((candidate) => candidate.account_id === accountId);
  if (!auth) {
    throw new CodexError("Codex auth account is no longer configured.", "codex_auth_missing", 503);
  }
  return { ...poolEntry, auth };
};

const refreshFailureStatus = (status: number): number => (status === 400 || status === 401 || status === 403 ? 401 : 503);

type CodexRefreshFailure = Readonly<{
  message: string;
  code: Extract<CodexErrorCode, "codex_auth_refresh_failed" | "refresh_token_reused">;
  status: number;
}>;

/**
 * OAuth error bodies are advisory only; the status stays authoritative. The
 * recognized fields are collected in a stable order so the classifier below
 * can match an exact token or a described failure.
 */
const readCodexRefreshFailureValues = (bytes: Uint8Array): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    // OAuth error bodies are advisory only; the status remains authoritative.
    return [];
  }
  if (!isRecord(parsed)) return [];
  const values: string[] = [];
  const error = parsed.error;
  if (typeof error === "string") values.push(error);
  if (isRecord(error)) {
    for (const key of ["code", "message", "type"] as const) {
      const value = getString(error[key]);
      if (value) values.push(value);
    }
  }
  for (const key of ["error_description", "detail", "message", "code", "type"] as const) {
    const value = getString(parsed[key]);
    if (value) values.push(value);
  }
  return values;
};

// A rotated or shared refresh token is reported either as an exact code or as
// prose in the provider's error detail; both shapes mean re-authentication.
const codexRefreshTokenReused = (values: readonly string[], detail: string): boolean =>
  values.some((value) => value.trim().toLowerCase() === "refresh_token_reused") ||
  /refresh token.{0,80}(already|previously) used|token.{0,40}reused/.test(detail);

const codexInvalidGrant = (values: readonly string[], detail: string): boolean =>
  values.some((value) => value.trim().toLowerCase() === "invalid_grant") ||
  /refresh token.{0,80}(expired|invalid|revoked)|authorization grant.{0,80}(expired|invalid|revoked)/.test(detail);

const classifyCodexRefreshFailure = async (response: Response): Promise<CodexRefreshFailure> => {
  const bounded = await readBoundedResponseBody(response, {
    maxBytes: 16 * 1024,
    timeoutMs: 1_000,
    cancellationReason: "Codex auth refresh error body discarded",
  });
  const values = bounded.complete && bounded.bytes.byteLength ? readCodexRefreshFailureValues(bounded.bytes) : [];
  const detail = values.join(" ").toLowerCase();
  if (codexRefreshTokenReused(values, detail)) {
    return {
      message: "The gateway's Codex refresh token was already used. Sign in again or upload a fresh auth.json and retry.",
      code: "refresh_token_reused",
      status: refreshFailureStatus(response.status),
    };
  }
  const invalidGrant = codexInvalidGrant(values, detail);
  if (invalidGrant || response.status === 400 || response.status === 401 || response.status === 403) {
    return {
      message: `${CODEX_AUTH_REAUTH_MESSAGE} The provider rejected the configured refresh token.`,
      code: "codex_auth_refresh_failed",
      status: refreshFailureStatus(response.status),
    };
  }
  return {
    message: `Codex auth refresh failed (status ${response.status}).`,
    code: "codex_auth_refresh_failed",
    status: 503,
  };
};

/**
 * A concurrent refresh inside this isolate may already have persisted a newer
 * token for the account. Adopting it avoids overwriting a rotation this request
 * never observed.
 */
const adoptConcurrentRefreshedAuth = (auth: CodexAuthState, generationAtStart: number): CodexAuthState | null => {
  if (authCacheGeneration === generationAtStart || !cachedAuthPool) return null;
  const cached = cachedAuthPool.accounts.find((candidate) => candidate.account_id === auth.account_id);
  if (!cached) return null;
  if (cached.access_token === auth.access_token && cached.refresh_token === auth.refresh_token) return null;
  return cached;
};

/**
 * Persist a refreshed token with optimistic concurrency. Every attempt
 * re-reads and re-validates the pool, adopts a token another writer already
 * rotated, and retries the compare-and-set while the pool keeps changing.
 */
const persistRefreshedAuthAccount = async (current: CodexAuthAccountEntry, next: CodexAuthState, kv: Kv): Promise<CodexAuthState> => {
  let poolEntry = current.entry;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    poolEntry ??= await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" });
    const latestPool = parseCodexAuthPool(poolEntry.value);
    const latestIndex = latestPool?.accounts.findIndex((candidate) => candidate.account_id === current.auth.account_id) ?? -1;
    if (!latestPool || latestIndex < 0) {
      throw new CodexError("Codex auth account disappeared during refresh.", "codex_auth_missing", 503);
    }
    const latestAuth = latestPool.accounts[latestIndex];
    if (latestAuth.access_token !== current.auth.access_token || latestAuth.refresh_token !== current.auth.refresh_token) {
      cacheCodexAuthPool(latestPool);
      return latestAuth;
    }

    const accounts = [...latestPool.accounts];
    accounts[latestIndex] = next;
    const nextPool: CodexAuthPoolState = { accounts, updated_at_ms: Date.now() };
    const commit = await kv.atomic().check(poolEntry).set(CODEX_AUTH_POOL_KV_KEY, nextPool).commit();
    if (commit.ok) {
      cacheCodexAuthPool(nextPool);
      return next;
    }
    poolEntry = await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" });
  }
  throw new CodexError("Codex auth refresh could not persist after concurrent updates.", "codex_auth_refresh_failed", 503);
};

const refreshAuth = async (current: CodexAuthAccountEntry): Promise<CodexAuthState> => {
  const generationAtStart = authCacheGeneration;
  let response: Response;
  try {
    response = await fetch(CODEX_REFRESH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: CODEX_REFRESH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: current.auth.refresh_token,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new CodexError("Codex auth refresh failed: auth server unreachable.", "codex_auth_refresh_unreachable", 502, error);
  }

  if (!response.ok) {
    const failure = await classifyCodexRefreshFailure(response);
    throw new CodexError(failure.message, failure.code, failure.status);
  }

  const parsed = (await response.json().catch(() => null)) as null | Record<string, unknown>;
  const accessToken = parsed && getString(parsed.access_token);
  const refreshToken = parsed && getString(parsed.refresh_token);
  if (!accessToken) {
    throw new CodexError("Codex auth refresh failed: upstream response missing access_token.", "codex_auth_refresh_failed", 503);
  }

  const next: CodexAuthState = {
    access_token: accessToken,
    refresh_token: refreshToken ?? current.auth.refresh_token,
    account_id: current.auth.account_id,
    updated_at_ms: Date.now(),
  };

  const adopted = adoptConcurrentRefreshedAuth(current.auth, generationAtStart);
  if (adopted) return adopted;

  const kv = current.kv;
  if (kv) return await persistRefreshedAuthAccount(current, next, kv);

  const basePool = cachedAuthPool ?? current.pool;
  const accounts = basePool.accounts.map((candidate) => (candidate.account_id === current.auth.account_id ? next : candidate));
  cacheCodexAuthPool({ accounts, updated_at_ms: Date.now() });
  return next;
};

const refreshAuthWithHealth = async (current: CodexAuthAccountEntry): Promise<CodexAuthState> => {
  try {
    const refreshed = await refreshAuth(current);
    void recordCodexProviderHealth(current.auth.account_id, "refresh_success", 200);
    return refreshed;
  } catch (error) {
    const status = error instanceof CodexError ? error.status : null;
    void recordCodexProviderHealth(current.auth.account_id, "refresh_failed", status);
    throw error;
  }
};

const sameCodexCredentials = (left: CodexAuthState, right: CodexAuthState): boolean =>
  left.access_token === right.access_token && left.refresh_token === right.refresh_token;

const refreshLeaseKey = async (accountId: string): Promise<KvKey> => [...CODEX_AUTH_REFRESH_LEASE_PREFIX, await sha256Hex(accountId)];

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const releaseRefreshLease = async (kv: Kv, key: KvKey, owner: string): Promise<void> => {
  try {
    const entry = await kv.get<CodexRefreshLease>(key, { consistency: "strong" });
    if (entry.value?.owner !== owner) return;
    await kv.atomic().check(entry).delete(key).commit();
  } catch {
    // Leases expire on their own; a release failure must not mask refresh work.
  }
};

type CodexRefreshLeaseAcquisition = Readonly<
  | { kind: "adopted"; auth: CodexAuthState }
  | { kind: "owned"; owner: string; entry: CodexAuthAccountEntry }
  | { kind: "unclaimed"; entry: CodexAuthAccountEntry }
>;

type CodexRefreshLeaseWait = Readonly<{ kind: "adopted"; auth: CodexAuthState } | { kind: "released"; entry: CodexAuthAccountEntry }>;

/**
 * A lease owner may have persisted rotating credentials immediately before
 * releasing its lease. Re-read once at that handoff so this waiter never
 * refreshes an obsolete token.
 */
const adoptCodexCredentialsAtLeaseHandoff = async (current: CodexAuthAccountEntry): Promise<CodexRefreshLeaseWait> => {
  try {
    const newest = await getCurrentAccountEntry(current.auth.account_id, true);
    if (!sameCodexCredentials(newest.auth, current.auth)) return { kind: "adopted", auth: newest.auth };
    return { kind: "released", entry: newest };
  } catch {
    // The normal fail-open refresh remains available if KV is transiently
    // unavailable at the handoff.
    return { kind: "released", entry: current };
  }
};

/**
 * Observe one live lease. The wait is bounded by the remaining lease window and
 * is deliberately not bound to an individual request signal: callers race the
 * resulting shared refresh independently, so one aborted client cannot cancel a
 * refresh another client still needs.
 */
const waitForCodexRefreshLeaseHandoff = async (
  kv: Kv,
  key: KvKey,
  lease: CodexRefreshLease,
  nowMs: number,
  initial: CodexAuthAccountEntry
): Promise<CodexRefreshLeaseWait> => {
  let current = initial;
  let waitedMs = 0;
  let stepMs = 50;
  const maxWaitMs = Math.min(CODEX_AUTH_REFRESH_WAIT_MS, Math.max(0, lease.lease_until_ms - nowMs));
  while (waitedMs < maxWaitMs) {
    await delay(stepMs);
    waitedMs += stepMs;
    stepMs = Math.min(500, stepMs * 2);
    try {
      const newest = await getCurrentAccountEntry(current.auth.account_id, true);
      if (!sameCodexCredentials(newest.auth, current.auth)) return { kind: "adopted", auth: newest.auth };
      current = newest;
    } catch {
      // The current owner may still persist a refreshed token. Keep waiting
      // until the bounded lease observation window elapses.
    }
    const currentLease = await kv.get<CodexRefreshLease>(key, { consistency: "strong" });
    if (!currentLease.value || currentLease.value.lease_until_ms <= Date.now()) {
      return await adoptCodexCredentialsAtLeaseHandoff(current);
    }
  }
  return { kind: "released", entry: current };
};

/**
 * Claim the cross-isolate refresh lease for this account, or observe the owner
 * that already holds it. Lease reads and CAS operations are an optional
 * coordination optimization: a failure here is reported as `unclaimed` so the
 * caller falls open to a bounded direct refresh. OAuth itself never runs inside
 * this helper, so its deterministic errors are never retried here.
 */
const acquireCodexRefreshLease = async (kv: Kv, key: KvKey, initial: CodexAuthAccountEntry): Promise<CodexRefreshLeaseAcquisition> => {
  let current = initial;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const leaseEntry = await kv.get<CodexRefreshLease>(key, { consistency: "strong" });
      const lease = leaseEntry.value;
      const now = Date.now();
      if (!lease || lease.lease_until_ms <= now) {
        const owner = crypto.randomUUID();
        const claimed = await kv
          .atomic()
          .check(leaseEntry)
          .set(key, { owner, lease_until_ms: now + CODEX_AUTH_REFRESH_LEASE_MS } satisfies CodexRefreshLease, { expireIn: CODEX_AUTH_REFRESH_LEASE_MS * 2 })
          .commit();
        if (!claimed.ok) continue;
        return { kind: "owned", owner, entry: current };
      }

      const wait = await waitForCodexRefreshLeaseHandoff(kv, key, lease, now, current);
      if (wait.kind === "adopted") return wait;
      current = wait.entry;
    }
  } catch {
    return { kind: "unclaimed", entry: current };
  }
  return { kind: "unclaimed", entry: current };
};

/**
 * Coalesce refreshes across isolates. A waiter repeatedly force-reads the
 * pool and adopts a newer token instead of issuing OAuth itself. The lease
 * contains only a hash-derived slot key and an opaque owner token.
 */
const refreshAuthCoordinated = async (input: CodexAuthAccountEntry): Promise<CodexAuthState> => {
  const native = await refreshNativeCodexAuthIfOwned(input.auth);
  if (native) return native;
  let current = input;
  try {
    const newest = await getCurrentAccountEntry(input.auth.account_id, true);
    if (!sameCodexCredentials(newest.auth, input.auth)) return newest.auth;
    current = newest;
  } catch {
    // Continue with the supplied in-memory account when the optional
    // cross-isolate read is unavailable; refreshAuth still persists safely.
  }

  const kv = current.kv;
  if (!kv) return await refreshAuthWithHealth(current);
  let key: KvKey;
  try {
    key = await refreshLeaseKey(current.auth.account_id);
  } catch {
    return await refreshAuthWithHealth(current);
  }

  const lease = await acquireCodexRefreshLease(kv, key, current);
  if (lease.kind === "adopted") return lease.auth;
  if (lease.kind === "owned") {
    try {
      return await refreshAuthWithHealth(lease.entry);
    } finally {
      await releaseRefreshLease(kv, key, lease.owner);
    }
  }

  // No usable cross-isolate lease was observed or claimed. The refresh itself
  // remains generation-aware and bounded.
  return await refreshAuthWithHealth(lease.entry);
};

/**
 * Abort reasons become promise rejection reasons and thrown values, both of
 * which must be Errors. A non-Error abort reason is preserved as the cause.
 */
const abortReasonAsError = (reason: unknown): Error => {
  if (reason instanceof Error) return reason;
  if (reason === undefined) return new DOMException("The request was aborted.", "AbortError");
  return new Error("The request was aborted.", { cause: reason });
};

const awaitWithoutCancellingSharedWork = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return await promise;
  if (signal.aborted) throw signal.reason ?? new DOMException("The request was aborted.", "AbortError");
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(abortReasonAsError(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
        })
        .catch(() => {});
    }),
  ]);
};

const refreshAuthStateless = async (auth: CodexAuthState): Promise<CodexAuthState> => {
  const native = await refreshNativeCodexAuthIfOwned(auth, true);
  if (native) return native;
  let response: Response;
  try {
    response = await fetch(CODEX_REFRESH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: CODEX_REFRESH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: auth.refresh_token,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new CodexError("Codex auth refresh failed: auth server unreachable.", "codex_auth_refresh_unreachable", 502, error);
  }

  if (!response.ok) {
    const failure = await classifyCodexRefreshFailure(response);
    throw new CodexError(failure.message, failure.code, failure.status);
  }

  const parsed = (await response.json().catch(() => null)) as null | Record<string, unknown>;
  const accessToken = parsed && getString(parsed.access_token);
  const refreshToken = parsed && getString(parsed.refresh_token);
  if (!accessToken) {
    throw new CodexError("Codex auth refresh failed: upstream response missing access_token.", "codex_auth_refresh_failed", 503);
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken ?? auth.refresh_token,
    account_id: auth.account_id,
    updated_at_ms: Date.now(),
  };
};

const getValidAuth = async (current: CodexAuthAccountEntry): Promise<CodexAuthState> => {
  if (!needsRefresh(current.auth)) return current.auth;

  const existing = refreshesInFlight.get(current.auth.account_id);
  if (existing) return await existing;
  const refresh = refreshAuthCoordinated(current).finally(() => {
    refreshesInFlight.delete(current.auth.account_id);
  });
  refreshesInFlight.set(current.auth.account_id, refresh);
  return await refresh;
};

export {
  abortReasonAsError,
  awaitWithoutCancellingSharedWork,
  delay,
  getCurrentAccountEntry,
  getValidAuth,
  refreshAuthCoordinated,
  refreshAuthStateless,
  sameCodexCredentials,
};
