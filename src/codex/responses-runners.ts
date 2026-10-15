// Codex Responses execution helpers, split out of src/codex.ts.

import { markCodexQuotaBlocked } from "./rate-limit-429.ts";
import {
  claimCodexRoutingProbe,
  electCodexResetRecoveryAccount,
  markCodexCredentialInvalid,
  markCodexRecoveryProbeQuotaBlocked,
  reconcileCodexQuotaAfterStaleVerifiedReset,
  reconcileCodexQuotaAfterVerifiedReset,
  releaseCodexRoutingProbe,
  selectCodexRoutingAccountsStrong,
} from "./account-routing.ts";
import {
  CODEX_AUTH_REAUTH_WARNING,
  CodexDispatchAccountEntry,
  CodexError,
  accessTokenExpired,
  codexProbeByResponse,
  getAuthPoolEntry,
  inheritCodexResponseActiveTelemetry,
  needsRefresh,
  setCodexResponseAccountTelemetry,
} from "./auth.ts";
import { delay } from "./auth-refresh.ts";
import { reportCodexBankedResetMetric } from "./banked-reset.ts";
import {
  CodexActiveAccountFenceError,
  CodexBankedResetCandidate,
  CodexBankedResetRetryFenceError,
  cancelResponseBody,
  dispatchFailureAsError,
  initialCodexSelectionResponse,
  isCodexSiblingTransportFailure,
  logCodexRouting,
  routingErrorResponse,
  upstreamTimeoutCircuitResponse,
  waitForCodexRetry,
} from "./dispatch.ts";
import { RoutingAccount } from "./routing-state.ts";
import { CodexAuthState } from "../types.ts";
import type {
  CodexAccountAttemptOutcome,
  CodexCredentialAttempt,
  CodexResponseContext,
  CodexRetryCandidate,
  EvaluatedBlockedReset,
} from "./responses-state.ts";

export const installCodexResponseRunners = (ctx: CodexResponseContext): void => {
  const responseIsCodexAuthFailure = (ctx.responseIsCodexAuthFailure = (auth: CodexAuthState, response: Response): boolean =>
    response.status === 401 || (response.status === 403 && accessTokenExpired(auth)));

  const finalizePostResetRetry = (ctx.finalizePostResetRetry = async (
    retryCandidate: CodexBankedResetCandidate,
    retried: Response,
    normalResponse: Response | null
  ): Promise<Response> => {
    if (normalResponse) cancelResponseBody(normalResponse);
    if (ctx.responseIsCodexAuthFailure(retryCandidate.auth, retried)) {
      await markCodexCredentialInvalid(retryCandidate.routing);
      ctx.authWarning ??= CODEX_AUTH_REAUTH_WARNING;
    }
    let response = retried;
    if (retried.status === 429) {
      // This is the one permitted post-reset inference attempt. Preserve a
      // replayable normal 429 and never feed it back into reset selection.
      const disposition = await markCodexRecoveryProbeQuotaBlocked(retryCandidate.routing, retried);
      response = disposition.response;
      inheritCodexResponseActiveTelemetry(response, retried);
      if (disposition.usageLimitReached && disposition.retryAtMs !== null) {
        await ctx.captureBankedResetCandidate(retryCandidate.accountEntry, retryCandidate.routing, retryCandidate.auth, disposition);
      } else {
        ctx.bankedResetCandidates.clear();
      }
    } else if (!retried.ok) {
      await releaseCodexRoutingProbe(retryCandidate.routing);
    }
    if (response.ok && retryCandidate.routing.probeGeneration !== null) {
      codexProbeByResponse.set(response, retryCandidate.routing);
    }
    return response;
  });

  const runPostResetRetry = (ctx.runPostResetRetry = async (evaluated: EvaluatedBlockedReset, normalResponse: Response | null): Promise<Response | null> => {
    const { candidate, reset, originalActive } = evaluated;
    const resetRecord = reset.record;
    if (!resetRecord || (reset.kind !== "verified" && !evaluated.staleVerified)) {
      return normalResponse;
    }
    await ctx.persistVerifiedCapacityReset(candidate, resetRecord);
    // Elect the verified account before any recovery-probe acquisition or
    // inference. The original active snapshot, the candidate's pool credential
    // and quota fence, and the full-cohort exhaustion proof must all still hold.
    const elected = await electCodexResetRecoveryAccount(candidate.routing, originalActive, candidate.quotaResetAtMs, evaluated.staleVerified);
    if (!elected) return normalResponse;
    const electedCandidate: CodexBankedResetCandidate = {
      ...candidate,
      routing: elected,
      accountEntry: { ...candidate.accountEntry, auth: elected.auth, routing: elected },
    };
    const reconciled = evaluated.staleVerified
      ? await reconcileCodexQuotaAfterStaleVerifiedReset(elected, {
          quotaResetAtMs: candidate.quotaResetAtMs,
          // The stale predicate proves the current circuit, not the ledger's
          // older generation.
          routingGeneration: candidate.routingGeneration,
          fences: [ctx.authPoolFence(electedCandidate), ctx.activeSelectionFence(electedCandidate)],
        })
      : await reconcileCodexQuotaAfterVerifiedReset(elected, {
          quotaResetAtMs: candidate.quotaResetAtMs,
          routingGeneration: resetRecord.routing_generation,
          fences: ctx.electedResetFences(electedCandidate, resetRecord.routing_generation),
        });
    if (!reconciled) return normalResponse;
    const refreshedCandidate = await ctx.refreshBankedResetCandidate(electedCandidate);
    if (!refreshedCandidate) return normalResponse;
    const retryCandidate = ctx.withResetRecoveryProbe(refreshedCandidate, reconciled);

    ctx.logBankedResetEvent("codex_reset_inference_retry", {
      request_id: ctx.options.requestId ?? null,
      account_id_hash: reset.accountIdHash,
      quota_generation: reset.quotaGeneration,
      idempotency_key_hash: reset.idempotencyKeyHash,
      routing_generation: resetRecord.routing_generation,
    });
    let retried: Response;
    try {
      retried = await ctx.fetchAttempt(retryCandidate.accountEntry, retryCandidate.auth, retryCandidate.routing, "post_banked_reset", () =>
        ctx.ensurePostResetRetryAuthCurrent(retryCandidate)
      );
    } catch (error) {
      if (error instanceof CodexBankedResetRetryFenceError || error instanceof CodexActiveAccountFenceError) return normalResponse;
      ctx.logBankedResetEvent("codex_reset_inference_retry_result", {
        request_id: ctx.options.requestId ?? null,
        account_id_hash: reset.accountIdHash,
        quota_generation: reset.quotaGeneration,
        idempotency_key_hash: reset.idempotencyKeyHash,
        routing_generation: resetRecord.routing_generation,
        status: error instanceof CodexError ? error.status : null,
      });
      reportCodexBankedResetMetric(ctx.bankedResetDependencies.telemetry, "codex_reset_post_retry_total", 1, {
        request_id: ctx.options.requestId ?? null,
        account_id_hash: reset.accountIdHash,
        quota_generation: reset.quotaGeneration,
        idempotency_key_hash: reset.idempotencyKeyHash,
        routing_generation: resetRecord.routing_generation,
        status: error instanceof CodexError ? error.status : null,
      });
      throw error;
    }
    retried = await ctx.finalizePostResetRetry(retryCandidate, retried, normalResponse);
    ctx.logBankedResetEvent("codex_reset_inference_retry_result", {
      request_id: ctx.options.requestId ?? null,
      account_id_hash: reset.accountIdHash,
      quota_generation: reset.quotaGeneration,
      idempotency_key_hash: reset.idempotencyKeyHash,
      routing_generation: resetRecord.routing_generation,
      status: retried.status,
    });
    reportCodexBankedResetMetric(ctx.bankedResetDependencies.telemetry, "codex_reset_post_retry_total", 1, {
      request_id: ctx.options.requestId ?? null,
      account_id_hash: reset.accountIdHash,
      quota_generation: reset.quotaGeneration,
      idempotency_key_hash: reset.idempotencyKeyHash,
      routing_generation: resetRecord.routing_generation,
      status: retried.status,
    });
    return ctx.decorateAuthWarning(await ctx.authorizePaidFallbackForCompleteCapacityEvidence(retried));
  });

  const redeemAndRetryOnce = (ctx.redeemAndRetryOnce = async (normalResponse: Response): Promise<Response> => {
    // A half-open account could still be healthy, but another isolate owns
    // its recovery probe. Keep the normal quota response instead of spending
    // a reset that was inferred only from a sibling's 429.
    if (ctx.probeUnavailable) return normalResponse;
    const evaluated = await ctx.evaluateBlockedCohortBankedReset();
    if (!evaluated) {
      // No banked reset could be redeemed for this episode: one bounded
      // overage probe may still serve the request for a blocked account.
      return (await ctx.runOverageFallbackAttempt()) ?? normalResponse;
    }
    return (await ctx.runPostResetRetry(evaluated, normalResponse)) ?? normalResponse;
  });

  const recoverBlockedReset = (ctx.recoverBlockedReset = async (): Promise<Response | null> => {
    const evaluated = await ctx.evaluateBlockedCohortBankedReset();
    if (evaluated) return await ctx.runPostResetRetry(evaluated, null);
    return await ctx.runOverageFallbackAttempt();
  });

  const exhaustedQuotaBlockedCohort = (ctx.exhaustedQuotaBlockedCohort = async (retryAtMs: number | null): Promise<Response> => {
    const recovered = await ctx.recoverBlockedReset();
    if (recovered) return recovered;
    return await ctx.quotaBlockedOrRetryableResponse(retryAtMs);
  });

  const claimAttemptRouting = (ctx.claimAttemptRouting = async (
    routing: RoutingAccount
  ): Promise<Readonly<{ kind: "claimed"; routing: RoutingAccount } | { kind: "unavailable" }>> => {
    if (!routing.probeRequired) return { kind: "claimed", routing };
    const claimed = await claimCodexRoutingProbe(ctx.poolEntry.pool, routing);
    if (!claimed) {
      ctx.probeUnavailable = true;
      if (routing.probeCircuit === "upstream_timeout") ctx.probeUnavailableCircuit = "upstream_timeout";
      return { kind: "unavailable" };
    }
    return { kind: "claimed", routing: claimed };
  });

  const recoverCodexAuthFailure = (ctx.recoverCodexAuthFailure = async (
    accountEntry: CodexDispatchAccountEntry,
    attempt: CodexCredentialAttempt,
    response: Response
  ): Promise<Readonly<{ kind: "recovered"; response: Response } | { kind: "reselect_active" }>> => {
    if (!ctx.responseIsCodexAuthFailure(attempt.auth, response)) return { kind: "recovered", response };
    if (ctx.refreshedSlots.has(attempt.routing.slot)) {
      await markCodexCredentialInvalid(attempt.routing);
      ctx.requestActiveReselection();
      ctx.authWarning ??= CODEX_AUTH_REAUTH_WARNING;
      return { kind: "recovered", response };
    }
    cancelResponseBody(response);
    try {
      const refreshed = await ctx.refreshAfter401(attempt.routing, attempt.auth, "401");
      attempt.auth = refreshed.auth;
      attempt.routing = refreshed.routing;
      const retried = await ctx.fetchAttempt(accountEntry, attempt.auth, attempt.routing, "post_refresh");
      if (ctx.responseIsCodexAuthFailure(attempt.auth, retried)) {
        await markCodexCredentialInvalid(attempt.routing);
        ctx.requestActiveReselection();
        ctx.authWarning ??= CODEX_AUTH_REAUTH_WARNING;
      }
      return { kind: "recovered", response: retried };
    } catch (error) {
      if (error instanceof CodexError && error.status === 401) {
        await markCodexCredentialInvalid(attempt.routing);
        ctx.requestActiveReselection();
        ctx.noteCodexAuthFailure(error);
        ctx.lastError = error;
        return { kind: "reselect_active" };
      }
      throw error;
    }
  });

  const classifyAccountAttemptResponse = (ctx.classifyAccountAttemptResponse = async (
    accountEntry: CodexDispatchAccountEntry,
    attempt: CodexCredentialAttempt,
    response: Response
  ): Promise<CodexAccountAttemptOutcome> => {
    let current = response;
    if (current.status === 429) {
      current = await ctx.classify429(accountEntry, attempt.routing, attempt.auth, current);
      setCodexResponseAccountTelemetry(current, attempt.routing.slot + 1, attempt.auth.account_id);
      inheritCodexResponseActiveTelemetry(current, response);
    } else if (!current.ok) {
      await releaseCodexRoutingProbe(attempt.routing);
    }
    if (current.ok && attempt.routing.probeGeneration !== null) codexProbeByResponse.set(current, attempt.routing);
    if (current.status === 401 || current.status === 403 || current.status === 429) {
      if (ctx.lastResponse) cancelResponseBody(ctx.lastResponse);
      ctx.lastResponse = current;
      return { kind: "next_account" };
    }
    if (ctx.lastResponse) cancelResponseBody(ctx.lastResponse);
    if (current.ok) await ctx.reportHealthyFallback();
    return { kind: "response", response: ctx.decorateAuthWarning(current) };
  });

  const absorbSiblingTransportFailure = (ctx.absorbSiblingTransportFailure = async (
    error: CodexError,
    routing: RoutingAccount
  ): Promise<CodexAccountAttemptOutcome> => {
    if (ctx.transportState.started) {
      if (error.code !== "gateway_timeout") await releaseCodexRoutingProbe(routing);
      if (ctx.lastResponse) cancelResponseBody(ctx.lastResponse);
      throw error;
    }
    ctx.transportFailure = error;
    await releaseCodexRoutingProbe(routing);
    if (ctx.lastResponse) {
      cancelResponseBody(ctx.lastResponse);
      ctx.lastResponse = null;
    }
    ctx.retryState.candidate = null;
    ctx.bankedResetCandidates.clear();
    if (ctx.options.signal?.aborted) return { kind: "stop" };
    return { kind: "next_account" };
  });

  const handleAccountAttemptFailure = (ctx.handleAccountAttemptFailure = async (
    error: unknown,
    routing: RoutingAccount
  ): Promise<CodexAccountAttemptOutcome> => {
    ctx.lastError = error;
    if (error instanceof CodexError && error.status === 401) {
      await markCodexCredentialInvalid(routing);
      ctx.requestActiveReselection();
      ctx.noteCodexAuthFailure(error);
      return { kind: "reselect_active" };
    }
    if (error instanceof CodexActiveAccountFenceError) {
      // The admission never reached transport, so its half-open lease is
      // released before the bounded loop re-elects the current active account.
      await releaseCodexRoutingProbe(routing);
      ctx.requestActiveReselection();
      return { kind: "reselect_active" };
    }
    if (isCodexSiblingTransportFailure(error)) return await ctx.absorbSiblingTransportFailure(error, routing);
    await releaseCodexRoutingProbe(routing);
    // Other request-local failures never open a shared provider gate.
    if (ctx.lastResponse) cancelResponseBody(ctx.lastResponse);
    throw error;
  });

  const attemptCodexAccount = (ctx.attemptCodexAccount = async (accountEntry: CodexDispatchAccountEntry): Promise<CodexAccountAttemptOutcome> => {
    const claim = await ctx.claimAttemptRouting(accountEntry.routing);
    if (claim.kind === "unavailable") return { kind: "next_account" };
    const attempt: CodexCredentialAttempt = { auth: accountEntry.auth, routing: claim.routing };
    try {
      if (needsRefresh(attempt.auth)) {
        const refreshed = await ctx.refreshAfter401(attempt.routing, attempt.auth, "proactive");
        attempt.auth = refreshed.auth;
        attempt.routing = refreshed.routing;
      }
      const response = await ctx.fetchAttempt(accountEntry, attempt.auth, attempt.routing, "initial");
      const recovered = await ctx.recoverCodexAuthFailure(accountEntry, attempt, response);
      if (recovered.kind === "reselect_active") return { kind: "reselect_active" };
      return await ctx.classifyAccountAttemptResponse(accountEntry, attempt, recovered.response);
    } catch (error) {
      return await ctx.handleAccountAttemptFailure(error, attempt.routing);
    }
  });

  const dispatchEligibleAccounts = (ctx.dispatchEligibleAccounts = async (): Promise<Response | null> => {
    for (const accountEntry of ctx.accountEntries) {
      const outcome = await ctx.attemptCodexAccount(accountEntry);
      if (outcome.kind === "next_account") continue;
      if (outcome.kind === "stop") break;
      // An authoritative exhaustion or final credential failure asks the
      // bounded admission loop to re-elect the current global active account
      // instead of walking a stale sibling list.
      if (outcome.kind === "reselect_active") return null;
      return outcome.response;
    }
    return null;
  });

  const terminalTransportOutcome = (ctx.terminalTransportOutcome = async (): Promise<Response | null> => {
    if (ctx.transportFailure) {
      if (ctx.lastResponse) cancelResponseBody(ctx.lastResponse);
      throw ctx.transportFailure;
    }
    if (ctx.probeUnavailableCircuit !== "upstream_timeout") return null;
    if (ctx.lastResponse) cancelResponseBody(ctx.lastResponse);
    let retryAtMs: number | null = null;
    try {
      const currentPoolEntry = await getAuthPoolEntry(true, true);
      const currentSelection = await selectCodexRoutingAccountsStrong(currentPoolEntry.pool, currentPoolEntry.pool.accounts, Date.now(), ctx.requestedModel);
      if (currentSelection.kind === "upstream_blocked") retryAtMs = currentSelection.retryAtMs;
    } catch {
      // The failed claim already proves a competing timeout probe. Preserve its
      // 503 classification if a fresh routing read is unavailable.
    }
    return upstreamTimeoutCircuitResponse(retryAtMs);
  });

  const redeemOrReportQuotaBlocked = (ctx.redeemOrReportQuotaBlocked = async (): Promise<Response> =>
    ctx.lastResponse ? await ctx.redeemAndRetryOnce(ctx.lastResponse) : await ctx.quotaBlockedOrRetryableResponse());

  const prepareTwoSecondRetry = (ctx.prepareTwoSecondRetry = async (
    candidate: CodexRetryCandidate
  ): Promise<Readonly<{ kind: "ready"; attempt: CodexCredentialAttempt; delayMs: number } | { kind: "respond"; response: Response }>> => {
    const retryCheckAtMs = Date.now();
    const retryDelayMs = Math.max(0, candidate.readyAtMs - retryCheckAtMs);
    if (retryCheckAtMs > candidate.expiresAtMs || retryCheckAtMs + retryDelayMs > candidate.expiresAtMs) {
      return { kind: "respond", response: await ctx.redeemOrReportQuotaBlocked() };
    }
    await waitForCodexRetry(retryDelayMs, ctx.options.signal, ctx.options.retrySleep ?? delay);
    if (Date.now() > candidate.expiresAtMs) return { kind: "respond", response: await ctx.redeemOrReportQuotaBlocked() };
    const attempt: CodexCredentialAttempt = { auth: candidate.auth, routing: candidate.routing };
    if (attempt.routing.probeRequired) {
      const claimed = await claimCodexRoutingProbe(ctx.poolEntry.pool, attempt.routing, Math.max(Date.now(), candidate.readyAtMs));
      if (!claimed) {
        return {
          kind: "respond",
          response: ctx.lastResponse ?? (await ctx.quotaBlockedOrRetryableResponse()),
        };
      }
      attempt.routing = claimed;
    }
    if (Date.now() > candidate.expiresAtMs) {
      await releaseCodexRoutingProbe(attempt.routing);
      return { kind: "respond", response: await ctx.redeemOrReportQuotaBlocked() };
    }
    return { kind: "ready", attempt, delayMs: retryDelayMs };
  });

  const recoverTwoSecondRetryAuthFailure = (ctx.recoverTwoSecondRetryAuthFailure = async (
    candidate: CodexRetryCandidate,
    attempt: CodexCredentialAttempt,
    response: Response
  ): Promise<Readonly<{ kind: "recovered"; response: Response } | { kind: "respond"; response: Response }>> => {
    if (!ctx.responseIsCodexAuthFailure(attempt.auth, response)) return { kind: "recovered", response };
    if (ctx.refreshedSlots.has(attempt.routing.slot)) {
      await markCodexCredentialInvalid(attempt.routing);
      ctx.authWarning ??= CODEX_AUTH_REAUTH_WARNING;
      return { kind: "recovered", response };
    }
    cancelResponseBody(response);
    let retried: Response;
    try {
      const refreshed = await ctx.refreshAfter401(attempt.routing, attempt.auth, "401");
      attempt.auth = refreshed.auth;
      attempt.routing = refreshed.routing;
      retried = await ctx.fetchAttempt(candidate.accountEntry, attempt.auth, attempt.routing, "post_retry_refresh");
    } catch (error) {
      if (error instanceof CodexError && error.status === 401) {
        await markCodexCredentialInvalid(attempt.routing);
        ctx.noteCodexAuthFailure(error);
        return { kind: "respond", response: ctx.authFailureResponse(error) };
      }
      if (!(error instanceof CodexError && error.code === "gateway_timeout")) {
        await releaseCodexRoutingProbe(attempt.routing);
      }
      throw error;
    }
    if (ctx.responseIsCodexAuthFailure(attempt.auth, retried)) {
      await markCodexCredentialInvalid(attempt.routing);
      ctx.authWarning ??= CODEX_AUTH_REAUTH_WARNING;
    }
    return { kind: "recovered", response: retried };
  });

  const classifyTwoSecondRetryResponse = (ctx.classifyTwoSecondRetryResponse = async (
    candidate: CodexRetryCandidate,
    attempt: CodexCredentialAttempt,
    response: Response
  ): Promise<Response> => {
    let current = response;
    if (current.status === 429) {
      const disposition = await markCodexQuotaBlocked(attempt.routing, current);
      current = disposition.response;
      if (disposition.usageLimitReached && disposition.retryAtMs !== null) {
        await ctx.captureBankedResetCandidate(candidate.accountEntry, attempt.routing, attempt.auth, disposition);
      } else {
        // The ordinary bounded retry gave a generic answer. It is not evidence
        // that a banked reset is safe to spend.
        ctx.bankedResetCandidates.clear();
      }
      setCodexResponseAccountTelemetry(current, attempt.routing.slot + 1, attempt.auth.account_id);
      inheritCodexResponseActiveTelemetry(current, response);
    } else if (!current.ok) {
      // A 401/403 says this retrying account cannot serve, but does not erase
      // a separately verified quota-exhaustion candidate from another slot.
      // Other non-successes remain conservative and discard that candidate.
      if (current.status !== 401 && current.status !== 403) ctx.bankedResetCandidates.clear();
      await releaseCodexRoutingProbe(attempt.routing);
    }
    if (current.ok && attempt.routing.probeGeneration !== null) codexProbeByResponse.set(current, attempt.routing);
    // A successful ordinary bounded retry has already served the original
    // inference request. A captured exhaustion observation from before that
    // retry is no longer a reason to spend a reset or issue another request.
    if (current.ok) return ctx.decorateAuthWarning(current);
    return ctx.decorateAuthWarning(await ctx.authorizePaidFallbackForCompleteCapacityEvidence(await ctx.redeemAndRetryOnce(current)));
  });

  const runTwoSecondRetryCandidate = (ctx.runTwoSecondRetryCandidate = async (candidate: CodexRetryCandidate): Promise<Response> => {
    const ready = await ctx.prepareTwoSecondRetry(candidate);
    if (ready.kind === "respond") return ready.response;
    const { attempt } = ready;
    logCodexRouting("codex_two_second_retry", {
      request_id: ctx.options.requestId ?? null,
      slot: candidate.routing.slot + 1,
      delay_ms: ready.delayMs,
      active_generation: candidate.routing.activeGeneration ?? null,
      active_transition_reason: candidate.routing.activeTransitionReason ?? null,
    });
    if (ctx.lastResponse) cancelResponseBody(ctx.lastResponse);
    let response: Response;
    try {
      response = await ctx.fetchAttempt(candidate.accountEntry, attempt.auth, attempt.routing, "two_second_retry");
    } catch (error) {
      if (!(error instanceof CodexError && error.code === "gateway_timeout")) {
        await releaseCodexRoutingProbe(attempt.routing);
      }
      throw error;
    }
    const recovered = await ctx.recoverTwoSecondRetryAuthFailure(candidate, attempt, response);
    if (recovered.kind === "respond") return recovered.response;
    return await ctx.classifyTwoSecondRetryResponse(candidate, attempt, recovered.response);
  });

  const exhaustedCodexDispatchResponse = (ctx.exhaustedCodexDispatchResponse = async (): Promise<Response> => {
    if (ctx.lastResponse) {
      return ctx.decorateAuthWarning(await ctx.authorizePaidFallbackForCompleteCapacityEvidence(await ctx.redeemAndRetryOnce(ctx.lastResponse)));
    }
    if (ctx.authFailureState.error) return await ctx.authorizePaidFallbackForCompleteCapacityEvidence(ctx.authFailureResponse(ctx.authFailureState.error));
    if (ctx.lastError instanceof CodexError && ctx.lastError.status === 401)
      return await ctx.authorizePaidFallbackForCompleteCapacityEvidence(ctx.authFailureResponse(ctx.lastError));
    if (ctx.selected.kind === "credentials_invalid") {
      ctx.authWarning ??= CODEX_AUTH_REAUTH_WARNING;
      return await ctx.authorizePaidFallbackForCompleteCapacityEvidence(ctx.authFailureResponse(null));
    }
    if (ctx.probeUnavailable) {
      // A held recovery lease is retryable, not proof of quota exhaustion.
      return await ctx.quotaBlockedOrRetryableResponse();
    }
    throw dispatchFailureAsError(ctx.lastError, () => new CodexError("Codex auth pool is empty.", "codex_auth_missing", 503));
  });

  const runPendingShortRetry = (ctx.runPendingShortRetry = async (): Promise<Response | null> => {
    const candidate = ctx.retryState.candidate;
    if (candidate === null) return null;
    ctx.retryState.candidate = null;
    try {
      return await ctx.runTwoSecondRetryCandidate(candidate);
    } catch (error) {
      if (!(error instanceof CodexActiveAccountFenceError)) throw error;
      // A concurrent transition superseded this request's admitted account;
      // re-admit the current global active instead of surfacing the fence.
      ctx.requestActiveReselection();
      return null;
    }
  });

  const reselectedActiveIdentity = (ctx.reselectedActiveIdentity = (): Readonly<{
    accountIdHash: string | undefined;
    generation: number | undefined;
  }> | null => {
    if (ctx.selected.kind === "eligible") {
      const active = ctx.selected.accounts[0];
      return { accountIdHash: active.accountIdHash, generation: active.activeGeneration };
    }
    if (ctx.selected.kind === "quota_blocked") {
      const active = ctx.selected.activeSnapshot.selection;
      return { accountIdHash: active?.account_id_hash, generation: active?.generation };
    }
    return null;
  });

  const restorePreservedShortRetry = (ctx.restorePreservedShortRetry = (): boolean => {
    const preserved = ctx.preservedShortRetryState.current;
    ctx.preservedShortRetryState.current = null;
    if (preserved === null) return false;
    const currentActive = ctx.reselectedActiveIdentity();
    if (currentActive === null) return false;
    if (currentActive.accountIdHash !== preserved.accountIdHash || currentActive.generation !== preserved.activeGeneration) return false;
    // Same active opaque identity and generation: the unchanged account may
    // still spend its one bounded retry before any reset or redemption.
    ctx.retryState.candidate = preserved.candidate;
    return true;
  });

  const advanceActiveReselection = (ctx.advanceActiveReselection = async (): Promise<Response | null> => {
    ctx.activeReselectionRequested = false;
    try {
      ctx.poolEntry = await getAuthPoolEntry(true, true);
      ctx.selected = await selectCodexRoutingAccountsStrong(ctx.poolEntry.pool, ctx.poolEntry.pool.accounts, Date.now(), ctx.requestedModel);
    } catch {
      return routingErrorResponse(503, "Codex routing state is temporarily unavailable; retry the request.", "codex_auth_missing");
    }
    if (ctx.selected.kind === "credentials_invalid") {
      // Preserve the request-local actionable credential error (for example a
      // reused refresh token) instead of replacing it with the generic
      // all-credentials-invalid response.
      return await ctx.authorizePaidFallbackForCompleteCapacityEvidence(ctx.authFailureResponse(ctx.authFailureState.error));
    }
    const reselectedTerminal = initialCodexSelectionResponse(ctx.selected);
    if (reselectedTerminal) return reselectedTerminal;
    if (ctx.restorePreservedShortRetry()) return null;
    if (ctx.selected.kind === "quota_blocked") {
      // A request that already holds the upstream quota answer keeps that
      // actionable body; a cold all-blocked cohort reports the routing error.
      if (ctx.lastResponse) return await ctx.exhaustedCodexDispatchResponse();
      return await ctx.exhaustedQuotaBlockedCohort(ctx.selected.retryAtMs);
    }
    if (ctx.selected.kind !== "eligible") return await ctx.exhaustedCodexDispatchResponse();
    ctx.accountEntries = ctx.selected.accounts.map((routing) => ({ ...ctx.poolEntry, auth: routing.auth, routing }));
    return null;
  });

  Object.assign(ctx, {
    responseIsCodexAuthFailure,
    finalizePostResetRetry,
    runPostResetRetry,
    redeemAndRetryOnce,
    recoverBlockedReset,
    exhaustedQuotaBlockedCohort,
    claimAttemptRouting,
    recoverCodexAuthFailure,
    classifyAccountAttemptResponse,
    absorbSiblingTransportFailure,
    handleAccountAttemptFailure,
    attemptCodexAccount,
    dispatchEligibleAccounts,
    terminalTransportOutcome,
    redeemOrReportQuotaBlocked,
    prepareTwoSecondRetry,
    recoverTwoSecondRetryAuthFailure,
    classifyTwoSecondRetryResponse,
    runTwoSecondRetryCandidate,
    exhaustedCodexDispatchResponse,
    runPendingShortRetry,
    reselectedActiveIdentity,
    restorePreservedShortRetry,
    advanceActiveReselection,
  });
};
