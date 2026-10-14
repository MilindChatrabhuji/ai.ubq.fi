import type { KvKey } from "#kv";
// Codex Responses execution helpers, split out of src/codex.ts.

import { ApiKeyQuotaDispatchError } from "../api-key-policy.ts";
import { markCodexQuotaBlocked } from "./rate-limit-429.ts";
import {
  capacityHeadroomForObservation,
  capacityObservationIsFresh,
  loadCodexCapacityRoutingObservations,
  probeLeaseMatchesRoutingAccount,
  quotaBlockForClass,
  quotaClass,
  routingAccountIdentity,
  slotMatchesRoutingAccount,
  withLegacyQuotaClassMap,
} from "./capacity-routing.ts";
import {
  claimCodexRoutingProbe,
  getCodexQuotaBlockFence,
  isCodexActiveAccountSnapshotCurrent,
  isCodexQuotaBlockFenceCurrent,
  reconcileCodexRoutingAccount,
  refreshCodexActiveAccountAdmission,
  releaseCodexRoutingProbe,
  selectCodexRoutingAccountsStrong,
} from "./account-routing.ts";
import {
  CODEX_ADDITIONAL_429_RETRY_MAX_DELAY_MS,
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_AUTH_REAUTH_MESSAGE,
  CODEX_AUTH_REAUTH_WARNING,
  CODEX_QUOTA_BLOCKED_ERROR_CODE,
  type CodexAuthAccountEntry,
  CodexError,
  codexAuthWarningForError,
  codexRoutingErrors,
  codexProbeByResponse,
  codexUserAgent,
  getAuthPoolEntry,
  parseCodexAuthPool,
  setCodexResponseAccountTelemetry,
  setCodexResponseActiveTelemetry,
  withCodexAuthWarning,
} from "./auth.ts";
import { awaitWithoutCancellingSharedWork, getValidAuth, refreshAuthCoordinated, sameCodexCredentials } from "./auth-refresh.ts";
import {
  type CodexBankedResetConfig,
  type CodexBankedResetDependencies,
  type CodexBankedResetEvent,
  type CodexBankedResetTelemetryFields,
  loadCodexBankedResetConfig,
  reportCodexBankedResetEvent,
} from "./banked-reset.ts";
import { evaluateCodexBankedResetPool } from "./banked-reset-pool.ts";
import { createUpstreamCodexUsageResetProvider } from "./banked-reset-provider.ts";
import { reconcileCodexBankedReset } from "./banked-reset-submission.ts";
import {
  CodexActiveAccountFenceError,
  type CodexAttemptPhase,
  type CodexBankedResetCandidate,
  CodexBankedResetRetryFenceError,
  codexErrorClass,
  codexStatusClass,
  fetchCodexResponseWithAuth,
  isCodexSiblingTransportFailure,
  logCodexRouting,
  recordCodexResponseHealth,
  recordCodexThrownHealth,
  reportCodexResponseTiming,
  routingErrorResponse,
} from "./dispatch.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  parseCodexAccountRoutingState,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  type CodexAccountRoutingState,
  type CodexActiveAccountSnapshot,
  type CodexBlockedRoutingAccount,
  type RoutingAccount,
  isCodexActiveAccountSelectionCurrent,
} from "./routing-state.ts";
import { config } from "../config.ts";
import { getKv } from "../kv.ts";
import { recordProviderCapacityResetEvent, triggerProviderCapacitySample } from "../provider/capacity-events.ts";
import { type SentinelUpstreamRecorder } from "../sentinel/upstream-capture.ts";
import { type CodexAuthState } from "../types.ts";
import { sha256Hex } from "../utils.ts";
import type {
  CodexResetCohortSnapshot,
  CodexResponseContext,
  EvaluatedBlockedReset,
  PendingOverageFallback,
  PreexistingBankedReset,
} from "./responses-state.ts";

const hasExhaustedBlockedCohort = (
  pool: Awaited<ReturnType<typeof selectCodexRoutingAccountsStrong>>
): pool is Extract<Awaited<ReturnType<typeof selectCodexRoutingAccountsStrong>>, { kind: "quota_blocked" }> =>
  pool.kind === "quota_blocked" && pool.fullCohortExhausted && pool.blockedAccounts.length > 0;

const observedCapacityResetDeadline = (
  observation: Awaited<ReturnType<typeof loadCodexCapacityRoutingObservations>>[number] | undefined,
  requestedModel: string | null,
  nowMs: number
): number | null => {
  if (observation?.state !== "available") return null;
  if (!capacityObservationIsFresh(observation, nowMs)) return null;
  if (capacityHeadroomForObservation(observation, requestedModel) !== 0) return null;
  const resetAtMs = observation.windows.primary?.reset_at_ms ?? null;
  return resetAtMs === null || !Number.isSafeInteger(resetAtMs) || resetAtMs <= nowMs ? null : resetAtMs;
};

/** Outcomes whose reason proves no banked reset could be redeemed this episode. */
const OVERAGE_FALLBACK_REASONS: ReadonlySet<string> = new Set([
  "no_eligible_credit",
  "inventory_empty",
  "inventory_no_eligible_codex_credit",
  "inventory_response_invalid_or_expired",
  "inventory_unavailable",
  "account_day_limit_reached",
]);

/**
 * Plan at most one bounded overage attempt for the current blocked cohort.
 * The best candidate is the credit the evaluator selected (the day-cap
 * refusal), then the current active blocked account, then the first blocked
 * account. Arming (`live_armed`), a completed spend, and fence/config
 * failures are not in the reason set and never fall back.
 */
const planOverageFallback = (
  evaluated: Awaited<ReturnType<typeof evaluateCodexBankedResetPool>>,
  blockedAccounts: readonly CodexBlockedRoutingAccount[],
  activeSnapshot: CodexActiveAccountSnapshot,
  currentPoolEntry: Awaited<ReturnType<typeof getAuthPoolEntry>>,
  requestedModel: string | null
): PendingOverageFallback | null => {
  if (!OVERAGE_FALLBACK_REASONS.has(evaluated.reason)) return null;
  const active = activeSnapshot.selection;
  const selectedSlot = evaluated.selected?.slot;
  const blocked =
    (selectedSlot === undefined ? undefined : blockedAccounts.find((account) => account.slot === selectedSlot)) ??
    (active === null ? undefined : blockedAccounts.find((account) => account.accountIdHash === active.account_id_hash && account.slot === active.slot)) ??
    blockedAccounts.at(0);
  if (!blocked) return null;
  const routing: RoutingAccount = { ...blocked, probeRequired: true, probeCircuit: "quota", overageFallback: true, requestedModel };
  return { reason: evaluated.reason, accountEntry: { ...currentPoolEntry, auth: blocked.auth, routing }, routing };
};

/**
 * The scoped fence for a fallback attempt: the claimed probe lease must still
 * name this account, slot generation, circuit and quota class before any
 * transport. Global routing fences are untouched by the fallback itself.
 */
const ensureOverageProbeLeaseCurrent = async (routing: RoutingAccount): Promise<void> => {
  try {
    const kv = await getKv();
    if (!kv) throw new CodexActiveAccountFenceError();
    const entry = await kv.get<CodexAccountRoutingState>(CODEX_ACCOUNT_ROUTING_KV_KEY, { consistency: "strong" });
    const state = parseCodexAccountRoutingState(entry.value);
    const slot = state?.slots.at(routing.slot);
    if (!slot || !slotMatchesRoutingAccount(slot, routing) || !probeLeaseMatchesRoutingAccount(slot, routing)) {
      throw new CodexActiveAccountFenceError();
    }
  } catch (error) {
    if (error instanceof CodexActiveAccountFenceError) throw error;
    throw new CodexActiveAccountFenceError();
  }
};

export const installCodexResponseOperations = (ctx: CodexResponseContext): void => {
  const reloadConfiguredBankedResetConfig = (ctx.reloadConfiguredBankedResetConfig = (): CodexBankedResetConfig =>
    ctx.configuredBankedResetConfig ?? loadCodexBankedResetConfig());

  const requestActiveReselection = (ctx.requestActiveReselection = (optionsArg?: Readonly<{ preserveRetry?: boolean; routing?: RoutingAccount }>): void => {
    ctx.activeReselectionRequested = true;
    const candidate = ctx.retryState.candidate;
    ctx.retryState.candidate = null;
    const routing = optionsArg?.routing;
    if (optionsArg?.preserveRetry === true && candidate !== null && routing !== undefined) {
      const activeGeneration = routing.activeGeneration;
      if (activeGeneration !== undefined && Number.isSafeInteger(activeGeneration)) {
        ctx.preservedShortRetryState.current = { candidate, accountIdHash: routing.accountIdHash, activeGeneration };
        return;
      }
    }
    ctx.preservedShortRetryState.current = null;
  });

  const noteCodexAuthFailure = (ctx.noteCodexAuthFailure = (error: unknown): void => {
    ctx.authWarning ??= codexAuthWarningForError(error) ?? CODEX_AUTH_REAUTH_WARNING;
    if (error instanceof CodexError && error.status === 401) ctx.authFailureState.error ??= error;
  });

  const decorateAuthWarning = (ctx.decorateAuthWarning = (response: Response): Response =>
    ctx.authWarning ? withCodexAuthWarning(response, ctx.authWarning) : response);

  const freshFullCohortExhaustedProof = (ctx.freshFullCohortExhaustedProof = async (): Promise<boolean> => {
    try {
      const currentPoolEntry = await getAuthPoolEntry(true, true);
      const currentSelection = await selectCodexRoutingAccountsStrong(currentPoolEntry.pool, currentPoolEntry.pool.accounts, Date.now(), ctx.requestedModel);
      return currentSelection.kind === "quota_blocked" && currentSelection.fullCohortExhausted;
    } catch {
      return false;
    }
  });

  const quotaBlockedOrRetryableResponse = (ctx.quotaBlockedOrRetryableResponse = async (retryAtMs: number | null = null): Promise<Response> =>
    (await ctx.freshFullCohortExhaustedProof())
      ? routingErrorResponse(429, "All configured Codex accounts are quota-blocked; retry after their next reset.", CODEX_QUOTA_BLOCKED_ERROR_CODE, retryAtMs)
      : routingErrorResponse(429, "Codex capacity is temporarily unavailable; retry the request.", "codex_capacity_unavailable", retryAtMs));

  const authFailureResponse = (ctx.authFailureResponse = (error: CodexError | null): Response => {
    const response = routingErrorResponse(
      401,
      error?.message ?? CODEX_AUTH_REAUTH_MESSAGE,
      error?.code === "refresh_token_reused" ? error.code : "codex_auth_invalid"
    );
    return ctx.decorateAuthWarning(response);
  });

  const ensureActiveRoutingAdmissionCurrent = (ctx.ensureActiveRoutingAdmissionCurrent = async (routing: RoutingAccount): Promise<void> => {
    if (
      routing.activeGeneration === undefined ||
      !Number.isSafeInteger(routing.activeGeneration) ||
      routing.activeGeneration < 1 ||
      typeof routing.activePoolVersionstamp !== "string" ||
      routing.activePoolVersionstamp.length === 0
    ) {
      throw new CodexActiveAccountFenceError();
    }
    try {
      if (!(await refreshCodexActiveAccountAdmission(routing))) throw new CodexActiveAccountFenceError();
    } catch (error) {
      if (error instanceof CodexActiveAccountFenceError) throw error;
      throw new CodexActiveAccountFenceError();
    }
  });

  const refreshBankedResetCandidate = (ctx.refreshBankedResetCandidate = async (
    candidate: CodexBankedResetCandidate
  ): Promise<CodexBankedResetCandidate | null> => {
    try {
      // A banked reset is stricter than normal routing: force-read the auth
      // pool immediately before the durable side-effect path. A rotated or
      // reordered account is not eligible for an old candidate.
      const currentPoolEntry = await getAuthPoolEntry(true, true);
      const currentAuth = currentPoolEntry.pool.accounts.at(candidate.routing.slot);
      if (!currentAuth) return null;
      if (currentAuth.account_id !== candidate.auth.account_id || !sameCodexCredentials(currentAuth, candidate.auth)) return null;
      return {
        ...candidate,
        auth: currentAuth,
        accountEntry: { ...currentPoolEntry, auth: currentAuth, routing: candidate.routing },
      };
    } catch {
      return null;
    }
  });

  const withResetRecoveryProbe = (ctx.withResetRecoveryProbe = (candidate: CodexBankedResetCandidate, probe: RoutingAccount): CodexBankedResetCandidate => {
    const routing = { ...probe, auth: candidate.auth };
    return {
      ...candidate,
      routing,
      accountEntry: { ...candidate.accountEntry, auth: candidate.auth, routing },
    };
  });

  const authPoolFence = (ctx.authPoolFence = (candidate: CodexBankedResetCandidate) => ({
    key: CODEX_AUTH_POOL_KV_KEY,
    isCurrent: (value: unknown): boolean => {
      const current = parseCodexAuthPool(value)?.accounts[candidate.routing.slot];
      return current?.account_id === candidate.auth.account_id && sameCodexCredentials(current, candidate.auth);
    },
  }));

  const activeSelectionFence = (ctx.activeSelectionFence = (candidate: CodexBankedResetCandidate) => ({
    key: CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
    isCurrent: (value: unknown): boolean =>
      candidate.routing.activeGeneration !== undefined && isCodexActiveAccountSelectionCurrent(value, candidate.routing, candidate.routing.activeGeneration),
  }));

  const activeSnapshotFence = (ctx.activeSnapshotFence = (snapshot: CodexActiveAccountSnapshot) => ({
    key: CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
    isCurrent: (value: unknown): boolean => isCodexActiveAccountSnapshotCurrent(value, snapshot),
  }));

  const ensurePostResetRetryAuthCurrent = (ctx.ensurePostResetRetryAuthCurrent = async (candidate: CodexBankedResetCandidate): Promise<void> => {
    const currentPoolEntry = await getAuthPoolEntry(true, true);
    const currentAuth = currentPoolEntry.pool.accounts.at(candidate.routing.slot);
    if (!currentAuth) throw new CodexBankedResetRetryFenceError();
    if (currentAuth.account_id !== candidate.auth.account_id || !sameCodexCredentials(currentAuth, candidate.auth)) {
      throw new CodexBankedResetRetryFenceError();
    }
  });

  const exactValueFence = (ctx.exactValueFence = (key: KvKey, expectedJson: string) => ({
    key,
    isCurrent: (value: unknown): boolean => JSON.stringify(value ?? null) === expectedJson,
  }));

  const resetFences = (ctx.resetFences = (
    candidate: CodexBankedResetCandidate,
    routingGeneration: number,
    originalActive: CodexActiveAccountSnapshot,
    cohort: CodexResetCohortSnapshot
  ) => [
    {
      key: CODEX_ACCOUNT_ROUTING_KV_KEY,
      isCurrent: (value: unknown): boolean => isCodexQuotaBlockFenceCurrent(value, candidate.routing, candidate.quotaResetAtMs, routingGeneration),
    },
    {
      key: CODEX_AUTH_POOL_KV_KEY,
      isCurrent: (value: unknown): boolean => ctx.authPoolFence(candidate).isCurrent(value),
    },
    ctx.activeSnapshotFence(originalActive),
    ctx.exactValueFence(CODEX_AUTH_POOL_KV_KEY, cohort.poolJson),
    ctx.exactValueFence(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, cohort.capacityJson),
  ]);

  const electedResetFences = (ctx.electedResetFences = (candidate: CodexBankedResetCandidate, routingGeneration: number) => [
    {
      key: CODEX_ACCOUNT_ROUTING_KV_KEY,
      isCurrent: (value: unknown): boolean => isCodexQuotaBlockFenceCurrent(value, candidate.routing, candidate.quotaResetAtMs, routingGeneration),
    },
    {
      key: CODEX_AUTH_POOL_KV_KEY,
      isCurrent: (value: unknown): boolean => ctx.authPoolFence(candidate).isCurrent(value),
    },
    ctx.activeSelectionFence(candidate),
  ]);

  const resetInput = (ctx.resetInput = (
    candidate: CodexBankedResetCandidate,
    routingGeneration: number,
    originalActive: CodexActiveAccountSnapshot,
    cohort: CodexResetCohortSnapshot
  ) => ({
    accountId: candidate.auth.account_id,
    credentialVersion: candidate.routing.credentialVersion,
    quotaResetAtMs: candidate.quotaResetAtMs,
    routingGeneration,
    fences: ctx.resetFences(candidate, routingGeneration, originalActive, cohort),
    requestId: ctx.options.requestId ?? null,
    signal: ctx.options.signal,
  }));

  const resetDependenciesForCandidate = (ctx.resetDependenciesForCandidate = (candidate: CodexBankedResetCandidate): CodexBankedResetDependencies => {
    if (ctx.configuredBankedReset?.provider) return ctx.bankedResetDependencies;
    try {
      return {
        ...ctx.bankedResetDependencies,
        provider: createUpstreamCodexUsageResetProvider({
          codexBaseUrl: config.codexBaseUrl,
          accountId: candidate.auth.account_id,
          accessToken: candidate.auth.access_token,
          userAgent: codexUserAgent(ctx.options.clientVersion),
          now: ctx.bankedResetDependencies.now,
        }),
      };
    } catch {
      return ctx.bankedResetDependencies;
    }
  });

  const captureBankedResetCandidate = (ctx.captureBankedResetCandidate = async (
    accountEntry: CodexAuthAccountEntry,
    routing: RoutingAccount,
    auth: CodexAuthState,
    disposition: Readonly<{
      usageLimitReached: boolean;
      retryAtMs: number | null;
      resetDeadlineIsStable: boolean;
    }>
  ): Promise<"captured" | "ineligible" | "routing_fence_unavailable"> => {
    // Relative Retry-After delays are valid for ordinary routing, but their
    // Date.now-derived deadline cannot name a durable reset window. A
    // canonical absolute HTTP-date is only a provisional identity; the
    // durable no-revision fence is what permits it to receive a key.
    if (!disposition.usageLimitReached || disposition.retryAtMs === null || !disposition.resetDeadlineIsStable) {
      return "ineligible";
    }
    const routingGeneration = await getCodexQuotaBlockFence(routing, disposition.retryAtMs);
    if (routingGeneration === null) {
      // A revised quota window invalidates any older observation for this
      // slot. It must not remain selectable just because capture could not
      // establish a fresh fence for the new deadline.
      ctx.bankedResetCandidates.delete(routing.slot);
      return "routing_fence_unavailable";
    }
    ctx.bankedResetCandidates.set(routing.slot, {
      accountEntry,
      auth,
      routing,
      quotaResetAtMs: disposition.retryAtMs,
      routingGeneration,
    });
    return "captured";
  });

  const logBankedResetEvent = (ctx.logBankedResetEvent = (event: CodexBankedResetEvent, fields: CodexBankedResetTelemetryFields): void => {
    reportCodexBankedResetEvent(ctx.bankedResetDependencies.telemetry, event, fields);
  });

  const reportHealthyFallback = (ctx.reportHealthyFallback = async (): Promise<void> => {
    for (const candidate of ctx.bankedResetCandidates.values()) {
      try {
        const hash = ctx.bankedResetDependencies.hash ?? sha256Hex;
        const accountIdHash = await hash(candidate.auth.account_id);
        const quotaGeneration = await hash(`uos_ai\u0000codex_reset_generation\u0000${accountIdHash}\u0000${candidate.quotaResetAtMs}`);
        ctx.logBankedResetEvent("codex_reset_skipped_healthy_fallback", {
          request_id: ctx.options.requestId ?? null,
          account_id_hash: accountIdHash,
          quota_generation: `v1:${quotaGeneration}`,
          routing_generation: candidate.routingGeneration,
        });
      } catch {
        // A telemetry hash failure must not delay a healthy inference response.
      }
    }
  });

  const preexistingBankedReset = (ctx.preexistingBankedReset = async (
    localCandidates: readonly CodexBankedResetCandidate[],
    originalActive: CodexActiveAccountSnapshot,
    cohort: CodexResetCohortSnapshot
  ): Promise<PreexistingBankedReset> => {
    for (const candidate of localCandidates) {
      const reset = await reconcileCodexBankedReset(
        ctx.resetInput(candidate, candidate.routingGeneration, originalActive, cohort),
        ctx.resetDependenciesForCandidate(candidate)
      );
      if (reset.kind === "verified") {
        return { kind: "evaluated", evaluated: { candidate, reset, staleVerified: false, originalActive } };
      }
      if (reset.reason === "verified_routing_generation_stale") {
        return { kind: "evaluated", evaluated: { candidate, reset, staleVerified: true, originalActive } };
      }
      if (reset.reason !== "no_existing_transaction") return { kind: "blocked" };
    }
    return { kind: "none" };
  });

  const selectedBankedResetCandidate = (ctx.selectedBankedResetCandidate = (
    evaluated: Awaited<ReturnType<typeof evaluateCodexBankedResetPool>>,
    localCandidates: readonly CodexBankedResetCandidate[],
    originalActive: CodexActiveAccountSnapshot
  ): EvaluatedBlockedReset | null => {
    if (!evaluated.selected || !evaluated.reset) return null;
    const selectedSlot = evaluated.selected.slot;
    const candidate = localCandidates.find((item) => item.routing.slot === selectedSlot);
    return candidate ? { candidate, reset: evaluated.reset, staleVerified: false, originalActive } : null;
  });

  const evaluateBlockedCohortBankedReset = (ctx.evaluateBlockedCohortBankedReset = async (): Promise<EvaluatedBlockedReset | null> => {
    // Each evaluation replaces the previous plan; a request can attempt at most
    // one overage fallback.
    ctx.overageFallbackPending = null;
    if (ctx.probeUnavailable) return null;
    let currentPoolEntry: Awaited<ReturnType<typeof getAuthPoolEntry>>;
    try {
      currentPoolEntry = await getAuthPoolEntry(true, true);
    } catch {
      return null;
    }
    // A fully used capacity observation is authoritative evidence that the
    // subscription cannot serve the requested class until its reset deadline:
    // materialize the durable class block so a local request can drive the
    // same banked-reset redemption a live 429 would. Without it the pool
    // dead-ends locally and silently burns the account's overage credits.
    const materializeCapacityQuotaBlocks = async (): Promise<boolean> => {
      const nowMs = Date.now();
      const observations = await loadCodexCapacityRoutingObservations(currentPoolEntry.pool, true);
      const kv = ctx.bankedResetDependencies.kv ?? (await getKv());
      const existing = kv ? parseCodexAccountRoutingState((await kv.get(CODEX_ACCOUNT_ROUTING_KV_KEY, { consistency: "strong" })).value) : null;
      let wrote = false;
      for (const [slot, auth] of currentPoolEntry.pool.accounts.entries()) {
        try {
          const identity = await routingAccountIdentity(auth);
          const blockedClass = quotaClass(ctx.requestedModel ?? null);
          const currentSlot = existing?.slots.at(slot);
          const currentBlock = currentSlot ? quotaBlockForClass(withLegacyQuotaClassMap(currentSlot), blockedClass) : null;
          const blockedUntilMs = currentBlock?.blocked_until_ms;
          if (blockedUntilMs !== undefined && blockedUntilMs > nowMs) continue;
          const observation = observations.find((candidate) => candidate.account_id_hash === identity.accountIdHash);
          const resetAtMs = observedCapacityResetDeadline(observation, ctx.requestedModel, nowMs);
          if (resetAtMs === null) continue;
          const account: RoutingAccount = {
            auth,
            slot,
            accountIdHash: identity.accountIdHash,
            credentialVersion: identity.credentialVersion,
            quotaHeadroom: 0,
            probeRequired: false,
            probeGeneration: null,
            probeToken: null,
            probeCircuit: null,
            requestedModel: ctx.requestedModel ?? null,
          };
          await markCodexQuotaBlocked(
            account,
            new Response(JSON.stringify({ error: { type: "usage_limit_reached" } }), {
              status: 429,
              headers: { "Content-Type": "application/json", "Retry-After": new Date(resetAtMs).toUTCString() },
            }),
            nowMs
          );
          wrote = true;
        } catch {
          // One account's failed materialization must not stop the others.
        }
      }
      return wrote;
    };
    let routedPool = await selectCodexRoutingAccountsStrong(currentPoolEntry.pool, currentPoolEntry.pool.accounts, Date.now(), ctx.requestedModel);
    if (hasExhaustedBlockedCohort(routedPool)) {
      const materialized = await materializeCapacityQuotaBlocks();
      if (materialized) {
        routedPool = await selectCodexRoutingAccountsStrong(currentPoolEntry.pool, currentPoolEntry.pool.accounts, Date.now(), ctx.requestedModel);
      }
    }
    if (routedPool.kind === "routing_unavailable") {
      logCodexRouting("codex_banked_reset_preflight", {
        request_id: ctx.options.requestId ?? null,
        require_full_pool: "true",
        outcome: "routing_unavailable",
        reason: "strong_routing_read_failed",
      });
      return null;
    }
    // Every current account must be authoritatively exhausted. A held recovery
    // lease, an invalid credential, or unclassified state is not quota
    // exhaustion and must not spend a credit.
    if (routedPool.kind !== "quota_blocked" || !routedPool.fullCohortExhausted) return null;
    let blockedAccounts = routedPool.blockedAccounts;
    if (!blockedAccounts.length) {
      await materializeCapacityQuotaBlocks();
      const refreshed = await selectCodexRoutingAccountsStrong(currentPoolEntry.pool, currentPoolEntry.pool.accounts, Date.now(), ctx.requestedModel);
      if (hasExhaustedBlockedCohort(refreshed)) {
        routedPool = refreshed;
        blockedAccounts = refreshed.blockedAccounts;
      } else {
        logCodexRouting("codex_banked_reset_preflight", {
          request_id: ctx.options.requestId ?? null,
          require_full_pool: "true",
          outcome: "skipped",
          reason: "no_blocked_identity",
          candidate_count: 0,
          selected_slot: null,
        });
        return null;
      }
    }
    if (routedPool.poolSnapshotJson === null || routedPool.capacitySnapshotJson === null) return null;
    const cohort: CodexResetCohortSnapshot = { poolJson: routedPool.poolSnapshotJson, capacityJson: routedPool.capacitySnapshotJson };
    const originalActive = routedPool.activeSnapshot;
    // Consider every blocked account's credit inventory. The original active
    // snapshot fences inventory, arming and consume; the selected account is
    // elected only after its reset is verified.
    const localCandidates = blockedAccounts.map(
      (routing) =>
        ({
          accountEntry: { ...currentPoolEntry, auth: routing.auth, routing },
          auth: routing.auth,
          routing,
          quotaResetAtMs: routing.quotaResetAtMs,
          routingGeneration: routing.routingGeneration,
        }) satisfies CodexBankedResetCandidate
    );

    const preexisting = await ctx.preexistingBankedReset(localCandidates, originalActive, cohort);
    if (preexisting.kind === "blocked") return null;
    if (preexisting.kind === "evaluated") return preexisting.evaluated;

    const poolCandidates = localCandidates.map((candidate) => ({
      slot: candidate.routing.slot,
      candidate: ctx.resetInput(candidate, candidate.routingGeneration, originalActive, cohort),
      provider: ctx.resetDependenciesForCandidate(candidate).provider,
    }));
    const evaluated = await evaluateCodexBankedResetPool(poolCandidates, ctx.bankedResetDependencies);
    logCodexRouting("codex_banked_reset_preflight", {
      request_id: ctx.options.requestId ?? null,
      require_full_pool: "true",
      outcome: evaluated.kind,
      reason: evaluated.reason,
      candidate_count: poolCandidates.length,
      selected_slot: evaluated.selected === null ? null : evaluated.selected.slot + 1,
    });
    ctx.overageFallbackPending = planOverageFallback(evaluated, blockedAccounts, routedPool.activeSnapshot, currentPoolEntry, ctx.requestedModel ?? null);
    return ctx.selectedBankedResetCandidate(evaluated, localCandidates, originalActive);
  });

  /**
   * Run the one planned bounded overage attempt. The claim reuses the probe
   * lease machinery (single-flight, generation/token fenced) and the
   * active-selection admission fence; a serve returns its response, while any
   * failure leaves the original refusal intact so the next request can still
   * redeem.
   */
  const runOverageFallbackAttempt = (ctx.runOverageFallbackAttempt = async (): Promise<Response | null> => {
    const pending = ctx.overageFallbackPending;
    ctx.overageFallbackPending = null;
    if (!pending) return null;
    const claimed = await claimCodexRoutingProbe(ctx.poolEntry.pool, pending.routing);
    if (!claimed) return null;
    logCodexRouting("codex_overage_served", {
      request_id: ctx.options.requestId ?? null,
      account_id_hash: claimed.accountIdHash,
      slot: claimed.slot + 1,
      reason: pending.reason,
    });
    try {
      const response = await ctx.fetchAttempt(
        pending.accountEntry,
        claimed.auth,
        claimed,
        "overage_fallback",
        () => ensureOverageProbeLeaseCurrent(claimed),
        true
      );
      if (response.ok) {
        if (claimed.probeGeneration !== null) codexProbeByResponse.set(response, claimed);
        return ctx.decorateAuthWarning(response);
      }
      if (response.status === 429) {
        // Re-arm the durable fences from this fresh authoritative 429 exactly
        // as an ordinary probe would, then keep the original refusal.
        const disposition = await markCodexQuotaBlocked(claimed, response);
        if (disposition.usageLimitReached && disposition.retryAtMs !== null) {
          await ctx.captureBankedResetCandidate(pending.accountEntry, claimed, claimed.auth, disposition);
        } else {
          ctx.bankedResetCandidates.clear();
        }
      } else {
        await releaseCodexRoutingProbe(claimed);
      }
      return null;
    } catch {
      await releaseCodexRoutingProbe(claimed);
      return null;
    }
  });

  const fetchAttempt = (ctx.fetchAttempt = async (
    accountEntry: CodexAuthAccountEntry,
    auth: CodexAuthState,
    routing: RoutingAccount,
    phase: CodexAttemptPhase,
    beforeTransport?: () => Promise<void>,
    activeAdmissionAlreadyFenced = false
  ): Promise<Response> => {
    ctx.attemptNumber += 1;
    ctx.transportState.started = false;
    // Assigned inside the actual onDispatch callback; a holder avoids control
    // flow narrowing `null` to `never` across the opaque transport call.
    const upstreamAttempt: { current: ReturnType<SentinelUpstreamRecorder["startAttempt"]> | null } = {
      current: null,
    };
    try {
      await ctx.providerDispatch.claim();
      const response = await fetchCodexResponseWithAuth(
        auth,
        ctx.url,
        ctx.serializedBody,
        ctx.baseHeaders,
        ctx.options.signal,
        async () => {
          await beforeTransport?.();
          if (!activeAdmissionAlreadyFenced) await ctx.ensureActiveRoutingAdmissionCurrent(routing);
        },
        () => {
          ctx.providerDispatch.markTransportStarted();
          ctx.transportState.started = true;
          reportCodexResponseTiming(ctx.options.timing?.onDispatch);
          upstreamAttempt.current = ctx.options.sentinelUpstreamRecorder?.startAttempt("chatgpt_codex") ?? null;
        }
      );
      // Wrap before the response WeakMap account/health registration
      // so the wrapper is the canonical identity every consumer observes.
      const recordedResponse = upstreamAttempt.current ? upstreamAttempt.current.wrap(response) : response;
      setCodexResponseAccountTelemetry(recordedResponse, routing.slot + 1, auth.account_id);
      setCodexResponseActiveTelemetry(recordedResponse, routing);
      reportCodexResponseTiming(ctx.options.timing?.onHeaders);
      void recordCodexResponseHealth(auth.account_id, recordedResponse, auth);
      logCodexRouting("codex_attempt", {
        request_id: ctx.options.requestId ?? null,
        attempt: ctx.attemptNumber,
        slot: routing.slot + 1,
        phase,
        status: recordedResponse.status,
        status_class: codexStatusClass(recordedResponse.status),
        active_generation: routing.activeGeneration ?? null,
        active_transition_reason: routing.activeTransitionReason ?? null,
      });
      return recordedResponse;
    } catch (error) {
      upstreamAttempt.current?.recordFetchError();
      const signalReason = ctx.options.signal?.reason;
      const clientCancelled = ctx.options.signal?.aborted === true && !(signalReason instanceof Error && signalReason.name === "TimeoutError");
      const siblingTransportFailure = isCodexSiblingTransportFailure(error);
      if (
        !(error instanceof CodexBankedResetRetryFenceError) &&
        !(error instanceof CodexActiveAccountFenceError) &&
        !(error instanceof ApiKeyQuotaDispatchError) &&
        !siblingTransportFailure &&
        !clientCancelled
      ) {
        void recordCodexThrownHealth(accountEntry.auth.account_id, error);
      }
      logCodexRouting("codex_attempt", {
        request_id: ctx.options.requestId ?? null,
        attempt: ctx.attemptNumber,
        slot: routing.slot + 1,
        phase,
        status: error instanceof CodexError ? error.status : null,
        status_class: error instanceof CodexBankedResetRetryFenceError ? "banked_reset_fenced" : codexErrorClass(error),
        active_generation: routing.activeGeneration ?? null,
        active_transition_reason: routing.activeTransitionReason ?? null,
      });
      throw error;
    }
  });

  const refreshAfter401 = (ctx.refreshAfter401 = async (
    routing: RoutingAccount,
    auth: CodexAuthState,
    trigger: "401" | "proactive"
  ): Promise<Readonly<{ auth: CodexAuthState; routing: RoutingAccount }>> => {
    ctx.refreshedSlots.add(routing.slot);
    try {
      const refreshed =
        trigger === "proactive"
          ? await awaitWithoutCancellingSharedWork(getValidAuth({ ...ctx.poolEntry, auth, routing }), ctx.options.signal)
          : await awaitWithoutCancellingSharedWork(refreshAuthCoordinated({ ...ctx.poolEntry, auth, routing }), ctx.options.signal);
      const reconciled = await reconcileCodexRoutingAccount(routing, refreshed);
      logCodexRouting("codex_token_refresh", {
        request_id: ctx.options.requestId ?? null,
        slot: routing.slot + 1,
        trigger,
        outcome: "succeeded",
        status_class: "2xx",
        active_generation: routing.activeGeneration ?? null,
        active_transition_reason: routing.activeTransitionReason ?? null,
      });
      return { auth: refreshed, routing: reconciled };
    } catch (error) {
      logCodexRouting("codex_token_refresh", {
        request_id: ctx.options.requestId ?? null,
        slot: routing.slot + 1,
        trigger,
        outcome: "failed",
        status_class: codexErrorClass(error),
        active_generation: routing.activeGeneration ?? null,
        active_transition_reason: routing.activeTransitionReason ?? null,
      });
      throw error;
    }
  });

  const classify429 = (ctx.classify429 = async (
    accountEntry: CodexAuthAccountEntry,
    routing: RoutingAccount,
    auth: CodexAuthState,
    response: Response
  ): Promise<Response> => {
    const disposition = await markCodexQuotaBlocked(routing, response);
    // Ordinary exhaustion is a valid usage-limit classification with a known
    // deadline, relative or absolute. A stable absolute deadline remains
    // required only to mint a banked-reset candidate.
    const ordinaryQuotaExhaustion = disposition.usageLimitReached && disposition.retryAtMs !== null;
    let candidateOutcome: "captured" | "ineligible" | "routing_fence_unavailable" = "ineligible";
    if (ordinaryQuotaExhaustion) {
      candidateOutcome = await ctx.captureBankedResetCandidate(accountEntry, routing, auth, disposition);
    } else {
      // A generic 429 is not proof that the account is exhausted. Do not spend
      // a reset based on an older candidate in the same failover pass.
      ctx.bankedResetCandidates.clear();
    }
    logCodexRouting("codex_quota_classification", {
      request_id: ctx.options.requestId ?? null,
      slot: routing.slot + 1,
      usage_limit_reached: disposition.usageLimitReached ? "true" : "false",
      retry_at_ms: disposition.retryAtMs,
      quota_block_source: disposition.quotaBlockSource,
      reset_deadline_is_stable: disposition.resetDeadlineIsStable ? "true" : "false",
      reset_deadline_conflict: disposition.resetDeadlineConflict ? "true" : "false",
      candidate_outcome: candidateOutcome,
      active_generation: routing.activeGeneration ?? null,
      active_transition_reason: routing.activeTransitionReason ?? null,
    });
    const classifiedAtMs = Date.now();
    const retryAfterDelay = disposition.retryAtMs === null ? 0 : Math.max(0, disposition.retryAtMs - classifiedAtMs);
    const mayRetryWithinBound = !disposition.usageLimitReached || retryAfterDelay <= CODEX_ADDITIONAL_429_RETRY_MAX_DELAY_MS;
    if (mayRetryWithinBound) {
      const candidate = {
        accountEntry,
        auth,
        routing: {
          ...routing,
          probeRequired: disposition.usageLimitReached && disposition.retryAtMs !== null,
          probeGeneration: null,
          probeToken: null,
          probeCircuit: disposition.usageLimitReached && disposition.retryAtMs !== null ? ("quota" as const) : null,
        },
        delayMs: Math.min(retryAfterDelay, CODEX_ADDITIONAL_429_RETRY_MAX_DELAY_MS),
        readyAtMs: disposition.retryAtMs ?? classifiedAtMs,
        expiresAtMs: classifiedAtMs + CODEX_ADDITIONAL_429_RETRY_MAX_DELAY_MS,
      };
      if (!ctx.retryState.candidate || candidate.delayMs < ctx.retryState.candidate.delayMs) {
        ctx.retryState.candidate = candidate;
      }
    }
    if (ordinaryQuotaExhaustion) {
      // Authoritative exhaustion is a global transition reason. Its former
      // short retry is preserved across the reselect only when the same active
      // identity and generation are re-admitted.
      ctx.requestActiveReselection({ preserveRetry: true, routing });
    }
    return disposition.response;
  });

  const authorizePaidFallbackForCompleteQuotaEvidence = (ctx.authorizePaidFallbackForCompleteQuotaEvidence = async (response: Response): Promise<Response> => {
    if (response.status === 429 && (await ctx.freshFullCohortExhaustedProof())) {
      codexRoutingErrors.set(response, CODEX_QUOTA_BLOCKED_ERROR_CODE);
    }
    return response;
  });

  const persistVerifiedCapacityReset = (ctx.persistVerifiedCapacityReset = async (
    candidate: CodexBankedResetCandidate,
    record: NonNullable<Awaited<ReturnType<typeof reconcileCodexBankedReset>>>["record"]
  ): Promise<void> => {
    if (record?.state !== "verified" || record.verified_at_ms === null) return;
    const slot = candidate.routing.slot + 1;
    if (slot !== 1 && slot !== 2) return;
    try {
      const kv = ctx.bankedResetDependencies.kv ?? (await getKv());
      if (!kv) return;
      await recordProviderCapacityResetEvent(
        {
          v: 1,
          event_id: record.idempotency_key_hash,
          slot,
          observed_at_ms: record.verified_at_ms,
        },
        kv
      );
      // A verified reset changes the capacity picture; refresh the sample.
      triggerProviderCapacitySample();
    } catch {
      // Capacity telemetry is best effort and must never change inference.
    }
  });

  Object.assign(ctx, {
    reloadConfiguredBankedResetConfig,
    requestActiveReselection,
    noteCodexAuthFailure,
    decorateAuthWarning,
    freshFullCohortExhaustedProof,
    quotaBlockedOrRetryableResponse,
    authFailureResponse,
    ensureActiveRoutingAdmissionCurrent,
    refreshBankedResetCandidate,
    withResetRecoveryProbe,
    authPoolFence,
    activeSelectionFence,
    activeSnapshotFence,
    ensurePostResetRetryAuthCurrent,
    exactValueFence,
    resetFences,
    electedResetFences,
    resetInput,
    resetDependenciesForCandidate,
    captureBankedResetCandidate,
    logBankedResetEvent,
    reportHealthyFallback,
    preexistingBankedReset,
    selectedBankedResetCandidate,
    evaluateBlockedCohortBankedReset,
    runOverageFallbackAttempt,
    fetchAttempt,
    refreshAfter401,
    classify429,
    authorizePaidFallbackForCompleteQuotaEvidence,
    persistVerifiedCapacityReset,
  });
};
