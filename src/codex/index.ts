import { createCodexResponseState, type CodexResponseContext } from "./responses-state.ts";
import { installCodexResponseOperations } from "./responses-operations.ts";
import { installCodexResponseRunners } from "./responses-runners.ts";

import { withCodexWarnings } from "./auth.ts";

import type { CodexProviderDispatchCoordinator, FetchCodexResponsesOptions, PreparedCodexSubscriptionRequest } from "./dispatch.ts";
import { createCodexProviderDispatchCoordinator, prepareCodexSubscriptionRequest, runCodexSerialAdmissionLoop } from "./dispatch.ts";

const fetchPreparedCodexResponses = async (
  prepared: PreparedCodexSubscriptionRequest,
  options: FetchCodexResponsesOptions,
  providerDispatch: CodexProviderDispatchCoordinator
): Promise<Response> => {
  const created = await createCodexResponseState(prepared, options, providerDispatch);
  if (created.kind === "terminal") return created.response;
  const ctx = created.state as CodexResponseContext;
  installCodexResponseOperations(ctx);
  installCodexResponseRunners(ctx);
  if (ctx.selected.kind === "quota_blocked") {
    return await ctx.exhaustedQuotaBlockedCohort(ctx.selected.retryAtMs);
  }
  return await runCodexSerialAdmissionLoop({
    runPendingShortRetry: ctx.runPendingShortRetry,
    dispatchActive: ctx.dispatchEligibleAccounts,
    terminalTransportResponse: ctx.terminalTransportOutcome,
    hasQueuedRetry: () => ctx.retryState.candidate !== null,
    reselectionRequested: () => ctx.activeReselectionRequested,
    advanceReselection: ctx.advanceActiveReselection,
    exhaustedResponse: ctx.exhaustedCodexDispatchResponse,
  });
};

export const fetchCodexResponses = async (body: unknown, options: FetchCodexResponsesOptions = {}): Promise<Response> => {
  const prepared = await prepareCodexSubscriptionRequest(body, options.cacheScope ?? null);
  const providerDispatch = createCodexProviderDispatchCoordinator(options.beforeDispatch);
  try {
    const response = await fetchPreparedCodexResponses(prepared, options, providerDispatch);
    return withCodexWarnings(response, prepared.warnings);
  } finally {
    await providerDispatch.cancelBeforeTransport();
  }
};

/**
 * One models attempt for one account: fetch, and on an expired bearer refresh
 * the coordinated token before retrying the same URL exactly once.
 */
export {
  CODEX_AUTH_POOL_KV_KEY,
  CODEX_AUTH_REAUTH_MESSAGE,
  CODEX_AUTH_REAUTH_WARNING,
  CODEX_MODELS_KV_KEY,
  CODEX_QUOTA_BLOCKED_ERROR_CODE,
  CODEX_SUBSCRIPTIONS_UNAVAILABLE_ERROR_CODE,
  CODEX_UPSTREAM_DEGRADED_ERROR_CODE,
  CodexError,
  cacheCodexAuthPool,
  getCodexAccountEmail,
  getCodexResponseAccountCohortId,
  getCodexResponseActiveTelemetry,
  getCodexResponseSlot,
  getCodexRoutingError,
  getCodexRoutingProbe,
  getJwtExpMs,
  markCodexResponseCompleted,
  markCodexResponseUpstreamError,
  parseCodexAuthFromAuthJson,
  parseCodexAuthPool,
  releaseCodexResponseProbe,
  resetCodexAuthCacheForTest,
  upsertCodexAuthAccount,
} from "./auth.ts";

export {
  CodexCacheScopeExperimentError,
  beginCodexCacheScopeExperiment,
  fetchCodexResponsesForCacheScopeExperiment,
  getCodexCapacityAccounts,
  refreshCodexCacheScopeExperimentSlot,
} from "./experiment.ts";
export type { CodexCacheScopeExperimentSession, CodexCapacityAccount } from "./experiment.ts";
export { orderCodexAuthAccounts } from "./dispatch.ts";
export {
  buildCodexRequest,
  fetchCodexModels,
  loadCodexModelsSnapshot,
  loadFullCodexModelsSnapshot,
  preserveCodexDefaultModel,
  storeCodexModelsSnapshot,
  validateCodexAuthJson,
} from "../models/codex-models-fetch.ts";
export type { CodexModelsSnapshot } from "../models/codex-models.ts";
export { getCodexModelsSnapshotDefaultModel } from "../models/codex-models.ts";
