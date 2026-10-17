import type { Kv, KvEntry } from "#kv";
// Codex capacity and cache scope experiment, split out of src/codex.ts.

import { config } from "../config.ts";
import { claimCodexRoutingProbe, reconcileCodexRoutingAccount, releaseCodexRoutingProbe, selectCodexRoutingAccounts } from "./account-routing.ts";
import { type RoutingAccount } from "./routing-state.ts";
import { markCodexQuotaBlocked } from "./rate-limit-429.ts";
import { getKv } from "../kv.ts";
import { getString, isRecord } from "../utils.ts";
import type { CodexAuthPoolState, CodexAuthState } from "../types.ts";
import type { CodexAuthPoolEntry } from "./auth.ts";
import {
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_AUTH_POOL_MAX_ACCOUNTS,
  CODEX_ORIGINATOR,
  CodexError,
  cacheCodexAuthPool,
  codexProbeByResponse,
  codexProbeTransitionsInFlight,
  codexUserAgent,
  getAuthPoolEntry,
  getCodexAccountEmail,
  parseCodexAuthPool,
  setCodexResponseAccountTelemetry,
} from "./auth.ts";
import { awaitWithoutCancellingSharedWork, refreshAuthStateless, sameCodexCredentials } from "./auth-refresh.ts";
import {
  cancelResponseBody,
  codexErrorClass,
  codexStatusClass,
  fetchCodexResponseWithAuth,
  logCodexRouting,
  recordCodexResponseHealth,
  recordCodexThrownHealth,
} from "./dispatch.ts";

/**
 * Control-plane credentials for the redacted admin capacity snapshot. The
 * caller uses these only to make account-bound upstream reads; account IDs
 * and access tokens must never cross the HTTP response boundary.
 */
export type CodexCapacityAccount = Readonly<{
  slot: number;
  account_id: string;
  access_token: string;
  email: string | null;
}>;

export const getCodexCapacityAccounts = async (): Promise<readonly CodexCapacityAccount[]> => {
  const current = await getAuthPoolEntry(true);
  return current.pool.accounts.map((account, index) => ({
    slot: index + 1,
    account_id: account.account_id,
    access_token: account.access_token,
    email: getCodexAccountEmail(account.access_token),
  }));
};

/**
 * Private control-plane state for the fixed prompt-cache experiment. Account
 * identities stay inside this transport module and are never persisted by the
 * experiment coordinator or returned from its admin endpoint.
 */
export type CodexCacheScopeExperimentSession = Readonly<{
  expectedAccountIds: readonly [string, string];
  authPoolVersionstamp: string;
}>;

export class CodexCacheScopeExperimentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCacheScopeExperimentError";
  }
}

type CodexCacheScopeExperimentRefreshResult =
  | Readonly<{
      status: "refreshed";
      tokenChanged: boolean;
      session: CodexCacheScopeExperimentSession;
    }>
  | Readonly<{ status: "auth_pool_drift" }>;

const getStrongAuthPoolEntryForCacheScopeExperiment = async (): Promise<CodexAuthPoolEntry & { kv: Kv; entry: KvEntry<CodexAuthPoolState> }> => {
  const kv = await getKv();
  if (!kv) {
    throw new CodexCacheScopeExperimentError("Prompt-cache scope experiments require Deno KV-backed Codex auth.");
  }
  const entry = await kv.get<CodexAuthPoolState>(CODEX_AUTH_POOL_KV_KEY, { consistency: "strong" });
  const pool = parseCodexAuthPool(entry.value);
  if (!pool || !entry.versionstamp) {
    throw new CodexCacheScopeExperimentError("Codex auth pool is unavailable for the prompt-cache scope experiment.");
  }
  cacheCodexAuthPool(pool);
  return { kv, entry: entry as KvEntry<CodexAuthPoolState>, pool };
};

const cacheScopeExperimentAccount = (
  session: CodexCacheScopeExperimentSession,
  poolEntry: CodexAuthPoolEntry & { entry: KvEntry<CodexAuthPoolState> },
  slot: number
): CodexAuthState => {
  if (!Number.isInteger(slot) || slot < 1 || slot > CODEX_AUTH_POOL_MAX_ACCOUNTS) {
    throw new CodexCacheScopeExperimentError("Prompt-cache scope experiment slot is invalid.");
  }
  if (poolEntry.entry.versionstamp !== session.authPoolVersionstamp) {
    throw new CodexCacheScopeExperimentError("Codex auth pool changed during the prompt-cache scope experiment.");
  }
  // `Array.prototype.at` keeps the unchecked slot visible as possibly absent,
  // which the pool can be: it may hold only the first of the two slots.
  const auth = poolEntry.pool.accounts.at(slot - 1);
  const expectedAccountId = session.expectedAccountIds.at(slot - 1);
  if (auth === undefined) {
    throw new CodexCacheScopeExperimentError("Codex auth pool changed during the prompt-cache scope experiment.");
  }
  if (auth.account_id !== expectedAccountId) {
    throw new CodexCacheScopeExperimentError("Codex auth pool changed during the prompt-cache scope experiment.");
  }
  return auth;
};

export const beginCodexCacheScopeExperiment = async (): Promise<CodexCacheScopeExperimentSession> => {
  const poolEntry = await getStrongAuthPoolEntryForCacheScopeExperiment();
  const first = poolEntry.pool.accounts.at(0);
  const second = poolEntry.pool.accounts.at(1);
  if (poolEntry.pool.accounts.length !== 2 || !first || !second) {
    throw new CodexCacheScopeExperimentError("Prompt-cache scope experiments require exactly two configured Codex slots.");
  }
  return {
    expectedAccountIds: [first.account_id, second.account_id],
    authPoolVersionstamp: poolEntry.entry.versionstamp,
  };
};

/**
 * Refresh one pinned slot exactly once. The returned session carries the new
 * pool versionstamp; callers must use it for every following dispatch.
 */
export const refreshCodexCacheScopeExperimentSlot = async (
  session: CodexCacheScopeExperimentSession,
  slot: number,
  signal?: AbortSignal
): Promise<CodexCacheScopeExperimentRefreshResult> => {
  const current = await getStrongAuthPoolEntryForCacheScopeExperiment();
  const auth = cacheScopeExperimentAccount(session, current, slot);
  const selected = await selectCodexRoutingAccounts(current.pool, [auth]);
  if (selected.kind !== "eligible" || selected.accounts.length !== 1 || selected.accounts[0]?.slot !== slot - 1) {
    throw new CodexCacheScopeExperimentError("The requested Codex slot is not eligible for OAuth refresh during the prompt-cache scope experiment.");
  }
  let refreshed: CodexAuthState;
  try {
    // Unlike normal inference refreshes, this is a controlled experiment
    // transition. It must not adopt a same-account rotation from another
    // request, because that would falsely make the experiment's refresh row
    // appear to prove a cache scope. Persistence below is fenced to the exact
    // pool version we just validated.
    refreshed = await awaitWithoutCancellingSharedWork(refreshAuthStateless(auth), signal);
  } catch (error) {
    const afterFailure = await getStrongAuthPoolEntryForCacheScopeExperiment().catch(() => null);
    if (afterFailure && afterFailure.entry.versionstamp !== current.entry.versionstamp) {
      return { status: "auth_pool_drift" };
    }
    throw error;
  }
  if (refreshed.account_id !== auth.account_id) {
    throw new CodexCacheScopeExperimentError("Codex OAuth refresh changed account identity during the prompt-cache scope experiment.");
  }

  const accounts = [...current.pool.accounts];
  accounts[slot - 1] = refreshed;
  const nextPool: CodexAuthPoolState = { accounts, updated_at_ms: Date.now() };
  const persisted = await current.kv.atomic().check(current.entry).set(CODEX_AUTH_POOL_KV_KEY, nextPool).commit();
  if (!persisted.ok) return { status: "auth_pool_drift" };

  await reconcileCodexRoutingAccount(selected.accounts[0], refreshed);
  const after = await getStrongAuthPoolEntryForCacheScopeExperiment();
  const persistedAuth = after.pool.accounts.at(slot - 1);
  if (persistedAuth === undefined) return { status: "auth_pool_drift" };
  if (
    after.entry.versionstamp !== persisted.versionstamp ||
    persistedAuth.account_id !== refreshed.account_id ||
    !sameCodexCredentials(persistedAuth, refreshed) ||
    after.pool.accounts[0]?.account_id !== session.expectedAccountIds[0] ||
    after.pool.accounts[1]?.account_id !== session.expectedAccountIds[1]
  ) {
    return { status: "auth_pool_drift" };
  }
  return {
    status: "refreshed",
    tokenChanged: persistedAuth.access_token !== auth.access_token || persistedAuth.refresh_token !== auth.refresh_token,
    session: { ...session, authPoolVersionstamp: after.entry.versionstamp },
  };
};

/**
 * Slot-pinned dispatch must observe the exact credentials it selected. Both
 * fences force-read the pool, once before the upstream call and once after it,
 * so a concurrent rotation can never be attributed to the experiment.
 */
const assertCacheScopeExperimentCredentialsCurrent = async (
  session: CodexCacheScopeExperimentSession,
  slot: number,
  auth: CodexAuthState,
  phase: "before dispatch" | "after dispatch"
): Promise<void> => {
  const poolEntry = await getStrongAuthPoolEntryForCacheScopeExperiment();
  const persisted = cacheScopeExperimentAccount(session, poolEntry, slot);
  if (!sameCodexCredentials(persisted, auth)) {
    throw new CodexCacheScopeExperimentError(`Codex credentials changed ${phase} during the prompt-cache scope experiment.`);
  }
};

/** Claim the pinned slot's probe lease when routing requires one. */
const claimCacheScopeExperimentRouting = async (pool: CodexAuthPoolState, routing: RoutingAccount): Promise<RoutingAccount> => {
  if (!routing.probeRequired) return routing;
  const claimed = await claimCodexRoutingProbe(pool, routing);
  if (!claimed) {
    throw new CodexCacheScopeExperimentError("The requested Codex slot could not be claimed for the prompt-cache scope experiment.");
  }
  return claimed;
};

/**
 * The experiment never retries inference, so a failed dispatch is recorded as
 * thrown provider health and rerouted through the normal routing telemetry
 * before it propagates to the caller.
 */
const dispatchCacheScopeExperimentAttempt = async (
  routing: RoutingAccount,
  body: unknown,
  headers: Headers,
  signal: AbortSignal | undefined
): Promise<Response> => {
  try {
    return await fetchCodexResponseWithAuth(routing.auth, `${config.codexBaseUrl}/responses`, JSON.stringify(body), headers, signal);
  } catch (error) {
    void recordCodexThrownHealth(routing.auth.account_id, error);
    logCodexRouting("codex_attempt", {
      request_id: null,
      attempt: 1,
      slot: routing.slot + 1,
      phase: "initial",
      status: error instanceof CodexError ? error.status : null,
      status_class: codexErrorClass(error),
    });
    throw error;
  }
};

/**
 * Slot-pinned internal transport for the cache-scope experiment. It never
 * tries a sibling account or retries inference. Conversation IDs are internal
 * upstream headers, never public request fields or durable evidence.
 */
export const fetchCodexResponsesForCacheScopeExperiment = async (
  body: unknown,
  options: Readonly<{
    session: CodexCacheScopeExperimentSession;
    slot: number;
    conversationId: string;
    clientVersion?: string | null;
    signal?: AbortSignal;
  }>
): Promise<Response> => {
  const conversationId = options.conversationId.trim();
  if (!conversationId) {
    throw new CodexCacheScopeExperimentError("Prompt-cache scope experiment conversation id is invalid.");
  }
  if (codexProbeTransitionsInFlight.size) await Promise.allSettled([...codexProbeTransitionsInFlight]);

  const current = await getStrongAuthPoolEntryForCacheScopeExperiment();
  const auth = cacheScopeExperimentAccount(options.session, current, options.slot);
  const requestedModel = isRecord(body) ? getString(body.model) : null;
  const selected = await selectCodexRoutingAccounts(current.pool, [auth], Date.now(), requestedModel);
  if (selected.kind !== "eligible" || selected.accounts.length !== 1) {
    throw new CodexCacheScopeExperimentError("The requested Codex slot is not eligible for the prompt-cache scope experiment.");
  }
  let routing = selected.accounts[0];
  if (routing.slot !== options.slot - 1 || routing.auth.account_id !== auth.account_id) {
    throw new CodexCacheScopeExperimentError("Prompt-cache scope experiment routing did not preserve the requested slot.");
  }
  routing = await claimCacheScopeExperimentRouting(current.pool, routing);

  let response: Response | null = null;
  const headers = new Headers({
    originator: CODEX_ORIGINATOR,
    "user-agent": codexUserAgent(options.clientVersion),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    conversation_id: conversationId,
  });
  try {
    await assertCacheScopeExperimentCredentialsCurrent(options.session, options.slot, routing.auth, "before dispatch");
    response = await dispatchCacheScopeExperimentAttempt(routing, body, headers, options.signal);
    setCodexResponseAccountTelemetry(response, options.slot, routing.auth.account_id);
    void recordCodexResponseHealth(routing.auth.account_id, response, routing.auth);
    logCodexRouting("codex_attempt", {
      request_id: null,
      attempt: 1,
      slot: routing.slot + 1,
      phase: "initial",
      status: response.status,
      status_class: codexStatusClass(response.status),
    });

    if (response.status === 429) {
      response = (await markCodexQuotaBlocked(routing, response)).response;
      setCodexResponseAccountTelemetry(response, options.slot, routing.auth.account_id);
    }
    if (!response.ok) {
      await releaseCodexRoutingProbe(routing);
    } else if (routing.probeGeneration !== null) {
      codexProbeByResponse.set(response, routing);
    }

    await assertCacheScopeExperimentCredentialsCurrent(options.session, options.slot, routing.auth, "after dispatch");
  } catch (error) {
    if (response) cancelResponseBody(response);
    await releaseCodexRoutingProbe(routing);
    throw error;
  }
  return response;
};
