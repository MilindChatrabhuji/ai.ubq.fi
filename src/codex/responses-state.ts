import type { KvKey } from "#kv";
// Codex Responses execution state and operations interface, split out of src/codex.ts.

import { selectCodexRoutingAccountsStrong } from "./account-routing.ts";
import { loadOverageUsageSettings } from "./overage-settings.ts";
import { CODEX_ORIGINATOR, type CodexAuthAccountEntry, type CodexDispatchAccountEntry, CodexError, codexUserAgent, getAuthPoolEntry } from "./auth.ts";
import {
  type CodexBankedResetConfig,
  type CodexBankedResetDependencies,
  type CodexBankedResetEvent,
  type CodexBankedResetTelemetryFields,
  loadCodexBankedResetConfig,
} from "./banked-reset.ts";
import { evaluateCodexBankedResetPool } from "./banked-reset-pool.ts";
import { unavailableCodexUsageResetProvider } from "./banked-reset-provider.ts";
import { reconcileCodexBankedReset } from "./banked-reset-submission.ts";
import {
  type CodexAttemptPhase,
  type CodexBankedResetCandidate,
  applyNativeSessionHeaders,
  awaitPendingCodexProbeTransitions,
  initialCodexSelectionResponse,
  requestedCodexModel,
} from "./dispatch.ts";
import type { CodexProviderDispatchCoordinator, FetchCodexResponsesOptions, PreparedCodexSubscriptionRequest } from "./dispatch.ts";
import { type CodexActiveAccountSnapshot, type CodexProbeCircuit, type RoutingAccount } from "./routing-state.ts";
import { config } from "../config.ts";
import { type CodexAuthState } from "../types.ts";

export type CodexCredentialAttempt = { auth: CodexAuthState; routing: RoutingAccount };
export type CodexAccountAttemptOutcome =
  Readonly<{ kind: "response"; response: Response }> | Readonly<{ kind: "next_account" }> | Readonly<{ kind: "reselect_active" }> | Readonly<{ kind: "stop" }>;
export type CodexRetryCandidate = Readonly<{
  accountEntry: CodexAuthAccountEntry;
  auth: CodexAuthState;
  routing: RoutingAccount;
  delayMs: number;
  readyAtMs: number;
  expiresAtMs: number;
}>;
export type CodexResetCohortSnapshot = Readonly<{ poolJson: string; capacityJson: string }>;

/** One bounded overage attempt planned by a blocked cohort that proved no redeemable credit. */
export type PendingOverageFallback = Readonly<{
  reason: string;
  accountEntry: CodexDispatchAccountEntry;
  routing: RoutingAccount;
}>;
export type EvaluatedBlockedReset = Readonly<{
  candidate: CodexBankedResetCandidate;
  reset: Awaited<ReturnType<typeof reconcileCodexBankedReset>>;
  /** A verified record that predates the current routing generation. */
  staleVerified: boolean;
  /** The active-selection row observed before this reset transaction began. */
  originalActive: CodexActiveAccountSnapshot;
}>;
export type PreexistingBankedReset = Readonly<{ kind: "evaluated"; evaluated: EvaluatedBlockedReset } | { kind: "none" } | { kind: "blocked" }>;

type BankedResetFence = { key: KvKey; isCurrent: (value: unknown) => boolean };
type BankedResetInput = {
  accountId: string;
  credentialVersion: string;
  quotaResetAtMs: number;
  routingGeneration: number;
  fences: BankedResetFence[];
  requestId: string | null;
  signal: AbortSignal | undefined;
};

export type CodexResponseOperations = {
  reloadConfiguredBankedResetConfig: () => CodexBankedResetConfig;
  requestActiveReselection: (options?: Readonly<{ preserveRetry?: boolean; routing?: RoutingAccount }>) => void;
  noteCodexAuthFailure: (error: unknown) => void;
  decorateAuthWarning: (response: Response) => Response;
  freshFullCohortExhaustedProof: () => Promise<boolean>;
  freshFullCohortUnavailableProof: () => Promise<boolean>;
  quotaBlockedOrRetryableResponse: (retryAtMs?: number | null) => Promise<Response>;
  authFailureResponse: (error: CodexError | null) => Response;
  ensureActiveRoutingAdmissionCurrent: (routing: RoutingAccount) => Promise<void>;
  refreshBankedResetCandidate: (candidate: CodexBankedResetCandidate) => Promise<CodexBankedResetCandidate | null>;
  withResetRecoveryProbe: (candidate: CodexBankedResetCandidate, probe: RoutingAccount) => CodexBankedResetCandidate;
  authPoolFence: (candidate: CodexBankedResetCandidate) => BankedResetFence;
  activeSelectionFence: (candidate: CodexBankedResetCandidate) => BankedResetFence;
  activeSnapshotFence: (snapshot: CodexActiveAccountSnapshot) => BankedResetFence;
  ensurePostResetRetryAuthCurrent: (candidate: CodexBankedResetCandidate) => Promise<void>;
  exactValueFence: (key: KvKey, expectedJson: string) => BankedResetFence;
  resetFences: (
    candidate: CodexBankedResetCandidate,
    routingGeneration: number,
    originalActive: CodexActiveAccountSnapshot,
    cohort: CodexResetCohortSnapshot
  ) => BankedResetFence[];
  electedResetFences: (candidate: CodexBankedResetCandidate, routingGeneration: number) => BankedResetFence[];
  resetInput: (
    candidate: CodexBankedResetCandidate,
    routingGeneration: number,
    originalActive: CodexActiveAccountSnapshot,
    cohort: CodexResetCohortSnapshot
  ) => BankedResetInput;
  resetDependenciesForCandidate: (candidate: CodexBankedResetCandidate) => CodexBankedResetDependencies;
  captureBankedResetCandidate: (
    accountEntry: CodexAuthAccountEntry,
    routing: RoutingAccount,
    auth: CodexAuthState,
    disposition: Readonly<{ usageLimitReached: boolean; retryAtMs: number | null; resetDeadlineIsStable: boolean }>
  ) => Promise<"captured" | "ineligible" | "routing_fence_unavailable">;
  logBankedResetEvent: (event: CodexBankedResetEvent, fields: CodexBankedResetTelemetryFields) => void;
  reportHealthyFallback: () => Promise<void>;
  preexistingBankedReset: (
    localCandidates: readonly CodexBankedResetCandidate[],
    originalActive: CodexActiveAccountSnapshot,
    cohort: CodexResetCohortSnapshot
  ) => Promise<PreexistingBankedReset>;
  selectedBankedResetCandidate: (
    evaluated: Awaited<ReturnType<typeof evaluateCodexBankedResetPool>>,
    localCandidates: readonly CodexBankedResetCandidate[],
    originalActive: CodexActiveAccountSnapshot
  ) => EvaluatedBlockedReset | null;
  evaluateBlockedCohortBankedReset: () => Promise<EvaluatedBlockedReset | null>;
  runOverageFallbackAttempt: () => Promise<Response | null>;
  fetchAttempt: (
    accountEntry: CodexAuthAccountEntry,
    auth: CodexAuthState,
    routing: RoutingAccount,
    phase: CodexAttemptPhase,
    beforeTransport?: () => Promise<void>,
    activeAdmissionAlreadyFenced?: boolean
  ) => Promise<Response>;
  refreshAfter401: (
    routing: RoutingAccount,
    auth: CodexAuthState,
    trigger: "401" | "proactive"
  ) => Promise<Readonly<{ auth: CodexAuthState; routing: RoutingAccount }>>;
  classify429: (accountEntry: CodexAuthAccountEntry, routing: RoutingAccount, auth: CodexAuthState, response: Response) => Promise<Response>;
  authorizePaidFallbackForCompleteCapacityEvidence: (response: Response) => Promise<Response>;
  persistVerifiedCapacityReset: (
    candidate: CodexBankedResetCandidate,
    record: NonNullable<Awaited<ReturnType<typeof reconcileCodexBankedReset>>>["record"]
  ) => Promise<void>;
};

export type CodexResponseRunners = {
  responseIsCodexAuthFailure: (auth: CodexAuthState, response: Response) => boolean;
  finalizePostResetRetry: (retryCandidate: CodexBankedResetCandidate, retried: Response, normalResponse: Response | null) => Promise<Response>;
  runPostResetRetry: (evaluated: EvaluatedBlockedReset, normalResponse: Response | null) => Promise<Response | null>;
  redeemAndRetryOnce: (normalResponse: Response) => Promise<Response>;
  recoverBlockedReset: () => Promise<Response | null>;
  exhaustedQuotaBlockedCohort: (retryAtMs: number | null) => Promise<Response>;
  claimAttemptRouting: (routing: RoutingAccount) => Promise<Readonly<{ kind: "claimed"; routing: RoutingAccount } | { kind: "unavailable" }>>;
  recoverCodexAuthFailure: (
    accountEntry: CodexDispatchAccountEntry,
    attempt: CodexCredentialAttempt,
    response: Response
  ) => Promise<Readonly<{ kind: "recovered"; response: Response } | { kind: "reselect_active" }>>;
  classifyAccountAttemptResponse: (
    accountEntry: CodexDispatchAccountEntry,
    attempt: CodexCredentialAttempt,
    response: Response
  ) => Promise<CodexAccountAttemptOutcome>;
  absorbSiblingTransportFailure: (error: CodexError, routing: RoutingAccount) => Promise<CodexAccountAttemptOutcome>;
  handleAccountAttemptFailure: (error: unknown, routing: RoutingAccount) => Promise<CodexAccountAttemptOutcome>;
  attemptCodexAccount: (accountEntry: CodexDispatchAccountEntry) => Promise<CodexAccountAttemptOutcome>;
  dispatchEligibleAccounts: () => Promise<Response | null>;
  terminalTransportOutcome: () => Promise<Response | null>;
  redeemOrReportQuotaBlocked: () => Promise<Response>;
  prepareTwoSecondRetry: (
    candidate: CodexRetryCandidate
  ) => Promise<Readonly<{ kind: "ready"; attempt: CodexCredentialAttempt; delayMs: number } | { kind: "respond"; response: Response }>>;
  recoverTwoSecondRetryAuthFailure: (
    candidate: CodexRetryCandidate,
    attempt: CodexCredentialAttempt,
    response: Response
  ) => Promise<Readonly<{ kind: "recovered"; response: Response } | { kind: "respond"; response: Response }>>;
  classifyTwoSecondRetryResponse: (candidate: CodexRetryCandidate, attempt: CodexCredentialAttempt, response: Response) => Promise<Response>;
  runTwoSecondRetryCandidate: (candidate: CodexRetryCandidate) => Promise<Response>;
  exhaustedCodexDispatchResponse: () => Promise<Response>;
  runPendingShortRetry: () => Promise<Response | null>;
  reselectedActiveIdentity: () => Readonly<{ accountIdHash: string | undefined; generation: number | undefined }> | null;
  restorePreservedShortRetry: () => boolean;
  advanceActiveReselection: () => Promise<Response | null>;
};

export const createCodexResponseState = async (
  prepared: PreparedCodexSubscriptionRequest,
  options: FetchCodexResponsesOptions,
  providerDispatch: CodexProviderDispatchCoordinator
) => {
  await awaitPendingCodexProbeTransitions();
  const body = prepared.body;
  const requestedModel = requestedCodexModel(body);
  const poolEntry = await getAuthPoolEntry(true, true);
  // Refresh the per-account overage switch once per request so the synchronous
  // routing evaluation reads a bounded, current value.
  await loadOverageUsageSettings(poolEntry.pool);
  const selected = await selectCodexRoutingAccountsStrong(poolEntry.pool, poolEntry.pool.accounts, Date.now(), requestedModel);
  // Current-invalid pools use the same fresh complete proof as mixed pools
  // before they may authorize paid fallback.
  const terminalSelection = selected.kind === "credentials_invalid" ? null : initialCodexSelectionResponse(selected);
  if (terminalSelection) return { kind: "terminal" as const, response: terminalSelection };
  const accountEntries: CodexDispatchAccountEntry[] =
    selected.kind === "eligible" ? selected.accounts.map((routing) => ({ ...poolEntry, auth: routing.auth, routing })) : [];
  const url = `${config.codexBaseUrl}/responses`;
  const serializedBody = prepared.serializedBody;
  const baseHeaders = new Headers({
    originator: CODEX_ORIGINATOR,
    "user-agent": codexUserAgent(options.clientVersion),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    conversation_id: prepared.conversationIdentity,
  });
  applyNativeSessionHeaders(baseHeaders, prepared.nativeSessionIdentity);
  const configuredBankedReset = options.bankedReset;
  const configuredBankedResetConfig = configuredBankedReset?.config;
  const bankedResetDependencies: CodexBankedResetDependencies = {
    config: configuredBankedResetConfig ?? loadCodexBankedResetConfig(),
    reloadConfig:
      configuredBankedReset?.reloadConfig ??
      (configuredBankedResetConfig ? (): CodexBankedResetConfig => configuredBankedResetConfig : loadCodexBankedResetConfig),
    provider: configuredBankedReset?.provider ?? unavailableCodexUsageResetProvider,
    kv: configuredBankedReset?.kv,
    now: configuredBankedReset?.now,
    newOwnerToken: configuredBankedReset?.newOwnerToken,
    hash: configuredBankedReset?.hash,
    telemetry: configuredBankedReset?.telemetry,
    // A supplied provider exists only as the hermetic `fetchCodexResponses`
    // test seam. Real traffic creates its account-bound adapter below and
    // therefore always enforces a durable decision before live submission.
    allowLiveWithoutShadowForTest: configuredBankedReset?.provider !== undefined,
  };
  const lastResponse: Response | null = null;
  const lastError: unknown = null;
  const transportFailure: CodexError | null = null;
  const authWarning: string | null = null;
  const authFailureState: { error: CodexError | null } = { error: null };
  const probeUnavailable = false;
  const probeUnavailableCircuit: CodexProbeCircuit | null = null;
  const attemptNumber = 0;
  const transportState: { started: boolean } = { started: false };
  const refreshedSlots = new Set<number>();
  const retryState: { candidate: CodexRetryCandidate | null } = { candidate: null };
  const bankedResetCandidates = new Map<number, CodexBankedResetCandidate>();
  const activeReselectionRequested = false;
  const preservedShortRetryState: { current: Readonly<{ candidate: CodexRetryCandidate; accountIdHash: string; activeGeneration: number }> | null } = {
    current: null,
  };
  const state = {
    prepared,
    options,
    providerDispatch,
    body,
    requestedModel,
    poolEntry,
    selected,
    accountEntries,
    url,
    serializedBody,
    baseHeaders,
    configuredBankedReset,
    configuredBankedResetConfig,
    bankedResetDependencies,
    lastResponse: lastResponse as Response | null,
    lastError: lastError as unknown,
    transportFailure: transportFailure as CodexError | null,
    authWarning: authWarning as string | null,
    authFailureState,
    probeUnavailable: probeUnavailable as boolean,
    probeUnavailableCircuit: probeUnavailableCircuit as CodexProbeCircuit | null,
    attemptNumber,
    transportState,
    refreshedSlots,
    retryState,
    bankedResetCandidates,
    activeReselectionRequested,
    preservedShortRetryState,
    overageFallbackPending: null as PendingOverageFallback | null,
  };
  return { kind: "state" as const, state };
};

export type CodexResponseState = Extract<Awaited<ReturnType<typeof createCodexResponseState>>, { kind: "state" }>["state"];
export type CodexResponseContext = CodexResponseState & CodexResponseOperations & CodexResponseRunners;
