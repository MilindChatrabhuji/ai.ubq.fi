// Source-owned sticky serial selection and fixed A/P/R/C transition plans.
import {
  type CodexAccountRoutingState,
  type CodexActiveAccountSelection,
  type CodexActiveAccountTransitionReason,
  type CodexRoutingAccount,
  type CodexRouteSelection,
  type CodexRoutingIdentity,
  type CodexRoutingAccountPolicy,
  type CodexRoutingRowRevisions,
  type CodexSerialAdmissionPlan,
  isVersionstamp,
  parseCodexAccountRoutingState,
  parseCodexActiveAccountSelection,
} from "./native-codex-contracts.ts";
import {
  classifyCodexRouteSelection,
  evaluateCodexRoutingAccount,
  foldCodexRoutingEvaluation,
  routingStateChangedByNormalization,
  type CodexRoutingAccountEvaluation,
  type CodexRoutingAccumulation,
  type CodexRoutingAccumulator,
  type CodexRoutingSlotIdentity,
} from "./native-codex-evaluation.ts";
import { normalizeRoutingState, parseStoredCapacityObservationStore } from "./native-codex-capacity.ts";
export type SerialRoutingEvaluations = Readonly<{
  accumulated: CodexRoutingAccumulation;
  byAccountId: ReadonlyMap<string, CodexRoutingAccountEvaluation>;
  identityByAccountId: ReadonlyMap<string, CodexRoutingSlotIdentity>;
}>;
const activeSelectionForAccount = (
  account: CodexRoutingAccount,
  poolVersionstamp: string,
  generation: number,
  now: number,
  transitionReason: CodexActiveAccountTransitionReason | null
): CodexActiveAccountSelection | null => {
  if (account.routingGeneration === undefined || !isVersionstamp(poolVersionstamp) || !Number.isSafeInteger(generation) || generation < 1) return null;
  return {
    v: 1,
    account_id_hash: account.accountIdHash,
    credential_version: account.credentialVersion,
    pool_versionstamp: poolVersionstamp,
    slot: account.slot,
    routing_generation: account.routingGeneration,
    generation,
    transition_reason: transitionReason,
    updated_at_ms: now,
  };
};

const activeSelectionNeedsRefresh = (active: CodexActiveAccountSelection, account: CodexRoutingAccount, poolVersionstamp: string): boolean =>
  active.account_id_hash !== account.accountIdHash ||
  active.credential_version !== account.credentialVersion ||
  active.pool_versionstamp !== poolVersionstamp ||
  active.slot !== account.slot ||
  active.routing_generation !== account.routingGeneration;

type SerialSelectionDecision = Readonly<{
  selection: CodexRouteSelection;
  nextActive: CodexActiveAccountSelection | null;
}>;

type SerialSelectionContext = Readonly<{
  evaluations: SerialRoutingEvaluations;
  poolVersionstamp: string;
  now: number;
  poolSnapshotJson: string | null;
  capacitySnapshotJson: string | null;
  eligibleInPoolOrder: readonly CodexRoutingAccount[];
  fullCohortExhausted: boolean;
  fullCohortUnavailable: boolean;
  activeEvaluation: CodexRoutingAccountEvaluation | null;
}>;

/** One eligible account admitted under a committed active row. */
const eligibleSerialSelection = (
  account: CodexRoutingAccount,
  selection: CodexActiveAccountSelection,
  evaluations: SerialRoutingEvaluations
): CodexRouteSelection => ({
  kind: "eligible",
  accounts: [
    {
      ...account,
      activeGeneration: selection.generation,
      activePoolVersionstamp: selection.pool_versionstamp,
      activeTransitionReason: selection.transition_reason,
    },
  ],
  skippedSlots: evaluations.accumulated.skipped,
  blockedAccounts: evaluations.accumulated.blockedAccounts,
});

/**
 * The blocked/credential-invalid result bound to the active row as this
 * decision leaves it: a same-identity fence refresh the decision commits is
 * the observed active row, not a stale pre-refresh value.
 */
const blockedSerialSelection = (context: SerialSelectionContext, current: CodexActiveAccountSelection | null): CodexRouteSelection =>
  classifyCodexRouteSelection(
    context.evaluations.accumulated,
    context.fullCohortExhausted,
    { selection: current },
    context.poolSnapshotJson,
    context.capacitySnapshotJson,
    context.fullCohortUnavailable
  );

/** A missing active row bootstraps the first account eligible under the requested model. */
const serialBootstrapDecision = (context: SerialSelectionContext): SerialSelectionDecision | null => {
  const bootstrap = context.eligibleInPoolOrder.at(0);
  if (!bootstrap) return { selection: blockedSerialSelection(context, null), nextActive: null };
  const nextActive = activeSelectionForAccount(bootstrap, context.poolVersionstamp, 1, context.now, null);
  if (!nextActive) return null;
  return { selection: eligibleSerialSelection(bootstrap, nextActive, context.evaluations), nextActive };
};

/**
 * A pool reorder preserves the opaque identity; removal or replacement is the
 * only membership observation that may select a sibling.
 */
const serialReplacementDecision = (context: SerialSelectionContext, active: CodexActiveAccountSelection): SerialSelectionDecision | null => {
  const replacement = context.eligibleInPoolOrder.at(0);
  if (!replacement) return { selection: blockedSerialSelection(context, active), nextActive: null };
  const nextActive = activeSelectionForAccount(replacement, context.poolVersionstamp, active.generation + 1, context.now, "account_removed_or_replaced");
  if (!nextActive) return null;
  return { selection: eligibleSerialSelection(replacement, nextActive, context.evaluations), nextActive };
};

/** The active account is still eligible; only its same-identity fences may refresh. */
const serialCurrentActiveDecision = (
  context: SerialSelectionContext,
  active: CodexActiveAccountSelection,
  current: CodexRoutingAccount
): SerialSelectionDecision | null => {
  const needsRefresh = activeSelectionNeedsRefresh(active, current, context.poolVersionstamp);
  const refreshed = needsRefresh
    ? activeSelectionForAccount(current, context.poolVersionstamp, active.generation, context.now, active.transition_reason)
    : null;
  if (needsRefresh && refreshed === null) return null;
  return { selection: eligibleSerialSelection(current, refreshed ?? active, context.evaluations), nextActive: refreshed };
};

/** The active account is blocked, invalid, or probing: move only for an authoritative reason. */
const serialBlockedActiveDecision = (
  context: SerialSelectionContext,
  active: CodexActiveAccountSelection,
  activeEvaluation: CodexRoutingAccountEvaluation
): SerialSelectionDecision | null => {
  // A recovery-probe lease or transient circuit is not capacity evidence. It
  // must fail retryably without sending traffic to a healthy sibling, and it
  // must not unlock reset or paid fallback paths.
  if (activeEvaluation.activeTransitionReason === null) return { selection: { kind: "routing_unavailable" }, nextActive: null };
  const replacement = context.eligibleInPoolOrder.at(0);
  if (!replacement) {
    const needsRefresh = activeSelectionNeedsRefresh(active, activeEvaluation.account, context.poolVersionstamp);
    const refreshed = needsRefresh
      ? activeSelectionForAccount(activeEvaluation.account, context.poolVersionstamp, active.generation, context.now, active.transition_reason)
      : null;
    if (needsRefresh && refreshed === null) return null;
    return { selection: blockedSerialSelection(context, refreshed ?? active), nextActive: refreshed };
  }
  const nextActive = activeSelectionForAccount(
    replacement,
    context.poolVersionstamp,
    active.generation + 1,
    context.now,
    activeEvaluation.activeTransitionReason
  );
  if (!nextActive) return null;
  return { selection: eligibleSerialSelection(replacement, nextActive, context.evaluations), nextActive };
};

const serialSelectionDecision = (
  active: CodexActiveAccountSelection | null,
  pool: readonly CodexRoutingIdentity[],
  evaluations: SerialRoutingEvaluations,
  poolVersionstamp: string,
  now: number,
  poolSnapshotJson: string | null,
  capacitySnapshotJson: string | null
): SerialSelectionDecision | null => {
  const eligibleInPoolOrder = pool
    .map((auth) => evaluations.byAccountId.get(auth.accountIdHash)?.routedAccount ?? null)
    .filter((account): account is CodexRoutingAccount => account !== null);
  const accountForActive =
    active === null ? null : pool.find((account) => evaluations.identityByAccountId.get(account.accountIdHash)?.accountIdHash === active.account_id_hash);
  const activeEvaluation = accountForActive ? (evaluations.byAccountId.get(accountForActive.accountIdHash) ?? null) : null;
  const fullCohortExhausted =
    pool.length > 0 && pool.every((auth) => evaluations.byAccountId.get(auth.accountIdHash)?.activeTransitionReason === "quota_exhausted");
  const fullCohortUnavailable =
    pool.length > 0 &&
    pool.every((auth) => {
      const reason = evaluations.byAccountId.get(auth.accountIdHash)?.activeTransitionReason;
      return reason === "quota_exhausted" || reason === "credential_invalid";
    });
  const context: SerialSelectionContext = {
    evaluations,
    poolVersionstamp,
    now,
    poolSnapshotJson,
    capacitySnapshotJson,
    eligibleInPoolOrder,
    fullCohortExhausted,
    fullCohortUnavailable,
    activeEvaluation,
  };
  if (active === null) return serialBootstrapDecision(context);
  if (activeEvaluation === null) return serialReplacementDecision(context, active);
  const current = activeEvaluation.routedAccount;
  if (current !== null) return serialCurrentActiveDecision(context, active, current);
  return serialBlockedActiveDecision(context, active, activeEvaluation);
};

/** Preserve the native four-row checks, including check-only hot admissions and write order R then A. */
export const planCodexSerialCommit = (
  checks: CodexRoutingRowRevisions,
  durableRouting: CodexAccountRoutingState | null,
  normalized: CodexAccountRoutingState,
  decision: SerialSelectionDecision
): CodexSerialAdmissionPlan => ({
  kind: "serial_admission",
  checks,
  writes: { routing: routingStateChangedByNormalization(durableRouting, normalized) ? normalized : null, active: decision.nextActive },
  selection: decision.selection,
});

/** Credential-free coherent snapshot, populated only by the trusted native owner/authority adapter. */
export type CodexSerialSnapshot = Readonly<{
  active: unknown;
  routing: unknown;
  capacity: unknown;
  poolIdentities: readonly CodexRoutingIdentity[];
  selectedAccountHashes: readonly string[];
  accountPolicies: ReadonlyMap<string, CodexRoutingAccountPolicy>;
  revisions: CodexRoutingRowRevisions;
}>;
export const selectCodex = (snapshot: CodexSerialSnapshot, now: number, model: string | null): CodexSerialAdmissionPlan | null => {
  const active = snapshot.active === null ? null : parseCodexActiveAccountSelection(snapshot.active);
  if (snapshot.active !== null && active === null) return null;
  if (!isVersionstamp(snapshot.revisions.pool)) return null;
  const durable = snapshot.routing === null ? null : parseCodexAccountRoutingState(snapshot.routing);
  if (snapshot.routing !== null && durable === null) return null;
  const normalized = normalizeRoutingState(durable, snapshot.poolIdentities, now, true);
  const selected = new Set(snapshot.selectedAccountHashes);
  const cohort = snapshot.poolIdentities.filter((identity) => selected.has(identity.accountIdHash));
  const observations = new Map(parseStoredCapacityObservationStore(snapshot.capacity).map((observation) => [observation.account_id_hash, observation]));
  const accumulator: CodexRoutingAccumulator = {
    available: [],
    blockedAccounts: [],
    skipped: [],
    retryAt: null,
    hasQuotaBlock: false,
    hasUpstreamTimeoutBlock: false,
    modelUnavailable: null,
  };
  const byAccountId = new Map<string, CodexRoutingAccountEvaluation>();
  const identityByAccountId = new Map(snapshot.poolIdentities.map((identity) => [identity.accountIdHash, identity]));
  for (const identity of cohort) {
    const policy = snapshot.accountPolicies.get(identity.accountIdHash);
    if (!policy) return null;
    const evaluated = evaluateCodexRoutingAccount(normalized, identity, model, observations, now, policy);
    byAccountId.set(identity.accountIdHash, evaluated);
    foldCodexRoutingEvaluation(accumulator, evaluated);
  }
  const decision = serialSelectionDecision(
    active,
    cohort,
    { accumulated: accumulator, byAccountId, identityByAccountId },
    snapshot.revisions.pool,
    now,
    null,
    null
  );
  return decision === null ? null : planCodexSerialCommit(snapshot.revisions, durable, normalized, decision);
};
export { activeSelectionForAccount, serialSelectionDecision };
export type { SerialSelectionDecision };

/** A verified-reset election checks the same four native rows and always writes A after optional normalization R. */
export const planCodexResetElection = (
  checks: CodexRoutingRowRevisions,
  durableRouting: CodexAccountRoutingState | null,
  normalized: CodexAccountRoutingState,
  nextActive: CodexActiveAccountSelection
): Readonly<{
  kind: "reset_election";
  checks: CodexRoutingRowRevisions;
  writes: Readonly<{ routing: CodexAccountRoutingState | null; active: CodexActiveAccountSelection }>;
}> => ({
  kind: "reset_election",
  checks,
  writes: { routing: routingStateChangedByNormalization(durableRouting, normalized) ? normalized : null, active: nextActive },
});
