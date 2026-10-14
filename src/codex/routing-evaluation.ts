// Codex routing account evaluation and accumulation, split out of src/codex_account_routing.ts.

import { getString, isRecord } from "../utils.ts";
import { type CodexAuthPoolState, type CodexAuthState } from "../types.ts";
import { parseCodexAuthPool } from "./auth.ts";
import {
  type CodexAccountRoutingState,
  type CodexActiveAccountSnapshot,
  type CodexActiveAccountTransitionReason,
  type CodexBlockedRoutingAccount,
  type CodexCapacityRoutingObservation,
  type CodexProbeCircuit,
  type CodexQuotaClass,
  type CodexQuotaClassBlock,
  type CodexRoutingSlot,
  type RouteSelection,
  type RoutingAccount,
  isSafeMs,
} from "./routing-state.ts";
import {
  capacityHeadroomForObservation,
  capacityObservationIsFresh,
  neutralSlot,
  quotaBlockForClass,
  quotaClass,
  quotaHeadroomFor,
  quotaSignalObservedAtForClass,
  slotFor,
  slotMatchesRoutingAccount,
  withLegacyQuotaClassMap,
} from "./capacity-routing.ts";
import { codexModelUnavailableAccounts } from "../models/codex-models-availability.ts";
import { overageUsageAllowedSync } from "./overage-settings.ts";

/** A slot identity resolved from the pool before its durable routing state is read. */
type CodexRoutingSlotIdentity = Readonly<{
  slot: number;
  accountIdHash: string;
  credentialVersion: string;
}>;

/** A selectable account whose durable routing generation is already resolved. */
type CodexRoutedAccount = RoutingAccount & Readonly<{ routingGeneration: number }>;

type CodexRoutingAccountEvaluation = Readonly<{
  /** The resolved slot identity even when the account cannot serve now. */
  account: CodexRoutedAccount;
  /** Set when the account can take traffic now. */
  routedAccount: RoutingAccount | null;
  /** The 1-based slot number of a skipped account. */
  skippedSlot: number | null;
  /** The circuit that recorded the skip, or null for a credential fence. */
  blockedCircuit: CodexProbeCircuit | null;
  retryAtMs: number | null;
  blockedAccount: CodexBlockedRoutingAccount | null;
  /** Only these observed states may advance the global active selection. */
  activeTransitionReason: Exclude<CodexActiveAccountTransitionReason, "account_removed_or_replaced"> | null;
  /** A fresh, account-bound capacity sample proved the requested class empty. */
  capacityExhausted: boolean;
  /** Set only when catalog evidence or a learned rejection proves this account cannot serve the named model. */
  modelUnavailable: Readonly<{ model: string; detail: string | null }> | null;
}>;

const skippedRoutingAccount = (
  account: CodexRoutedAccount,
  slotNumber: number,
  blockedCircuit: CodexProbeCircuit | null,
  retryAtMs: number | null = null,
  blockedAccount: CodexBlockedRoutingAccount | null = null,
  activeTransitionReason: Exclude<CodexActiveAccountTransitionReason, "account_removed_or_replaced"> | null = null
): CodexRoutingAccountEvaluation => ({
  account,
  routedAccount: null,
  skippedSlot: slotNumber,
  blockedCircuit,
  retryAtMs,
  blockedAccount,
  activeTransitionReason,
  capacityExhausted: false,
  modelUnavailable: null,
});

const routedRoutingAccount = (routedAccount: CodexRoutedAccount): CodexRoutingAccountEvaluation => ({
  account: routedAccount,
  routedAccount,
  skippedSlot: null,
  blockedCircuit: null,
  retryAtMs: null,
  blockedAccount: null,
  activeTransitionReason: null,
  capacityExhausted: false,
  modelUnavailable: null,
});

/** A stale capacity record is not an observation; only a fresh one may override a circuit. */
const freshCapacityObservation = (observation: CodexCapacityRoutingObservation | undefined, now: number): CodexCapacityRoutingObservation | null =>
  observation !== undefined && capacityObservationIsFresh(observation, now) ? observation : null;

/**
 * The last in-memory guard after the durable reconciliation CAS. It prevents a
 * stale local circuit from suppressing a fresh, positive account observation
 * that lost a concurrent write race.
 */
const resolveCodexCapacityDecision = (
  slot: CodexRoutingSlot,
  classAwareSlot: CodexRoutingSlot,
  requestedQuotaClass: CodexQuotaClass,
  observation: CodexCapacityRoutingObservation | undefined,
  model: string | null,
  now: number
): Readonly<{ quotaHeadroom: number | null; capacityOverride: boolean; capacityExhausted: boolean }> => {
  const freshObservation = freshCapacityObservation(observation, now);
  const observedCapacityHeadroom = freshObservation === null ? null : capacityHeadroomForObservation(freshObservation, model);
  const classQuotaSignalObservedAtMs = quotaSignalObservedAtForClass(classAwareSlot, requestedQuotaClass);
  const snapshotAtMs = freshObservation?.snapshot_at_ms;
  const quotaSignalNewer = snapshotAtMs !== undefined && classQuotaSignalObservedAtMs !== null && classQuotaSignalObservedAtMs >= snapshotAtMs;
  const capacityOverride = freshObservation !== null && observedCapacityHeadroom !== null && observedCapacityHeadroom > 0 && !quotaSignalNewer;
  const capacityExhausted = freshObservation !== null && observedCapacityHeadroom === 0 && !quotaSignalNewer;
  return {
    quotaHeadroom: freshObservation === null ? quotaHeadroomFor(slot) : observedCapacityHeadroom,
    capacityOverride,
    capacityExhausted,
  };
};

/** A running class circuit skips the account and keeps its reset identity available to banked redemption. */
const quotaBlockedSkipFor = (
  requestedClassBlock: CodexQuotaClassBlock | null,
  routedAccount: CodexRoutedAccount,
  now: number,
  capacityOverride: boolean
): Readonly<{ retryAtMs: number; blockedAccount: CodexBlockedRoutingAccount | null }> | null => {
  if (requestedClassBlock === null || requestedClassBlock.blocked_until_ms <= now || capacityOverride) return null;
  const blockedAccount =
    requestedClassBlock.observed_reset_at_ms !== null && requestedClassBlock.observed_reset_at_is_stable
      ? { ...routedAccount, quotaResetAtMs: requestedClassBlock.observed_reset_at_ms }
      : null;
  return { retryAtMs: requestedClassBlock.blocked_until_ms, blockedAccount };
};

/**
 * A verified banked reset releases the quota deadline but retains its
 * recovery-probe lease. Ordinary routing stays unavailable until that exact
 * fenced probe succeeds, fails, or expires.
 */
const probeLeaseSkipFor = (
  slot: CodexRoutingSlot,
  requestedQuotaClass: CodexQuotaClass,
  now: number
): Readonly<{ circuit: CodexProbeCircuit; retryAtMs: number }> | null => {
  const lease = slot.probe_lease;
  if (lease === null || lease.expires_at_ms <= now) return null;
  const leaseBlocksRequest =
    lease.circuit !== "upstream_timeout" && (lease.quota_class === null || lease.quota_class === undefined || lease.quota_class === requestedQuotaClass);
  return leaseBlocksRequest ? { circuit: lease.circuit, retryAtMs: lease.expires_at_ms } : null;
};

const evaluateCodexRoutingAccount = (
  state: CodexAccountRoutingState,
  auth: CodexAuthState,
  mapped: CodexRoutingSlotIdentity,
  model: string | null,
  observationsByAccount: ReadonlyMap<string, CodexCapacityRoutingObservation>,
  now: number,
  modelUnavailable: ReadonlyMap<string, string | null>
): CodexRoutingAccountEvaluation => {
  const account: RoutingAccount = {
    auth,
    slot: mapped.slot,
    accountIdHash: mapped.accountIdHash,
    credentialVersion: mapped.credentialVersion,
    quotaHeadroom: null,
    probeRequired: false,
    probeGeneration: null,
    probeToken: null,
    probeCircuit: null,
    requestedModel: model,
  };
  const storedSlot = slotFor(state, account);
  const slot = slotMatchesRoutingAccount(storedSlot, account) ? storedSlot : neutralSlot(account.credentialVersion, account.accountIdHash);
  const requestedQuotaClass = quotaClass(model);
  const classAwareSlot = withLegacyQuotaClassMap(slot);
  const requestedClassBlock = quotaBlockForClass(classAwareSlot, requestedQuotaClass);
  const observation = observationsByAccount.get(account.accountIdHash);
  const capacity = resolveCodexCapacityDecision(slot, classAwareSlot, requestedQuotaClass, observation, model, now);
  const routedAccount: CodexRoutedAccount = { ...account, quotaHeadroom: capacity.quotaHeadroom, routingGeneration: slot.generation };
  if (slot.invalid_credential_version === account.credentialVersion) {
    return skippedRoutingAccount(routedAccount, mapped.slot + 1, null, null, null, "credential_invalid");
  }
  // A model this account provably cannot serve is not a quota or credential
  // observation: skip it without touching any fence and let an entitled sibling
  // take the request. Unknown availability never skips.
  if (model !== null && modelUnavailable.has(auth.account_id)) {
    return {
      ...skippedRoutingAccount(routedAccount, mapped.slot + 1, null, null, null, "model_unavailable"),
      modelUnavailable: { model, detail: modelUnavailable.get(auth.account_id) ?? null },
    };
  }
  const quotaSkip = quotaBlockedSkipFor(requestedClassBlock, routedAccount, now, capacity.capacityOverride);
  if (quotaSkip !== null) {
    return skippedRoutingAccount(routedAccount, mapped.slot + 1, "quota", quotaSkip.retryAtMs, quotaSkip.blockedAccount, "quota_exhausted");
  }
  if (capacity.capacityExhausted) {
    // The operator explicitly allows overage spending for this subscription:
    // keep it half-open so the request may serve through the paid backup
    // balance instead of waiting for a banked-reset redemption.
    if (overageUsageAllowedSync(account.accountIdHash)) {
      return { ...routedRoutingAccount({ ...routedAccount, probeRequired: true, probeCircuit: "quota" }), capacityExhausted: true };
    }
    // A fully used capacity observation with a future reset deadline is the
    // authoritative quota block for that window: it must feed the blocked
    // cohort so the automatic banked-reset flow can redeem (the deploy
    // materializes the durable class block). Without a deadline, keep the
    // subscription half-open so a bounded probe can re-observe the account.
    const freshObservation = freshCapacityObservation(observation, now);
    const observationResetAtMs = freshObservation?.windows.primary?.reset_at_ms ?? null;
    if (observationResetAtMs !== null && Number.isSafeInteger(observationResetAtMs) && observationResetAtMs > now) {
      return {
        ...skippedRoutingAccount(
          routedAccount,
          mapped.slot + 1,
          "quota",
          observationResetAtMs,
          { ...routedAccount, quotaResetAtMs: observationResetAtMs },
          "quota_exhausted"
        ),
        capacityExhausted: true,
      };
    }
    return { ...routedRoutingAccount({ ...routedAccount, probeRequired: true, probeCircuit: "quota" }), capacityExhausted: true };
  }
  const leaseSkip = probeLeaseSkipFor(slot, requestedQuotaClass, now);
  if (leaseSkip !== null) return skippedRoutingAccount(routedAccount, mapped.slot + 1, leaseSkip.circuit, leaseSkip.retryAtMs, null);
  // Claim the half-open lease only if request execution actually reaches this
  // slot. This preserves first/second order without abandoning a secondary
  // lease when the healthy first account returns directly.
  if (requestedClassBlock !== null) {
    return routedRoutingAccount({ ...routedAccount, probeRequired: !capacity.capacityOverride, probeCircuit: capacity.capacityOverride ? null : "quota" });
  }
  return routedRoutingAccount(routedAccount);
};

type CodexRoutingAccumulation = Readonly<{
  available: RoutingAccount[];
  blockedAccounts: CodexBlockedRoutingAccount[];
  skipped: number[];
  retryAt: number | null;
  hasQuotaBlock: boolean;
  hasUpstreamTimeoutBlock: boolean;
  /** The first account skipped because it cannot serve the requested model. */
  modelUnavailable: Readonly<{ model: string; detail: string | null }> | null;
}>;

type CodexRoutingAccumulator = {
  available: RoutingAccount[];
  blockedAccounts: CodexBlockedRoutingAccount[];
  skipped: number[];
  retryAt: number | null;
  hasQuotaBlock: boolean;
  hasUpstreamTimeoutBlock: boolean;
  modelUnavailable: Readonly<{ model: string; detail: string | null }> | null;
};

/** Fold one evaluated account into the running selection accumulator. */
const foldCodexRoutingEvaluation = (accumulator: CodexRoutingAccumulator, evaluated: CodexRoutingAccountEvaluation): void => {
  if (evaluated.routedAccount !== null) {
    accumulator.available.push(evaluated.routedAccount);
    return;
  }
  if (evaluated.skippedSlot !== null) accumulator.skipped.push(evaluated.skippedSlot);
  if (evaluated.blockedCircuit === "upstream_timeout") accumulator.hasUpstreamTimeoutBlock = true;
  if (evaluated.blockedCircuit === "quota") accumulator.hasQuotaBlock = true;
  if (evaluated.modelUnavailable !== null && accumulator.modelUnavailable === null) accumulator.modelUnavailable = evaluated.modelUnavailable;
  if (evaluated.retryAtMs !== null) {
    accumulator.retryAt = accumulator.retryAt === null ? evaluated.retryAtMs : Math.min(accumulator.retryAt, evaluated.retryAtMs);
  }
  if (evaluated.blockedAccount !== null) accumulator.blockedAccounts.push(evaluated.blockedAccount);
};

/** Accumulate every ordered account's routing outcome, preserving selection order. */
const accumulateCodexRoutingAccounts = (
  state: CodexAccountRoutingState,
  byId: ReadonlyMap<string, CodexRoutingSlotIdentity>,
  orderedAccounts: readonly CodexAuthState[],
  model: string | null,
  observationsByAccount: ReadonlyMap<string, CodexCapacityRoutingObservation>,
  now: number
): CodexRoutingAccumulation => {
  const accumulator: CodexRoutingAccumulator = {
    available: [],
    blockedAccounts: [],
    skipped: [],
    retryAt: null,
    hasQuotaBlock: false,
    hasUpstreamTimeoutBlock: false,
    modelUnavailable: null,
  };
  const unavailableAccounts = codexModelUnavailableAccounts(
    model,
    orderedAccounts.map((auth) => auth.account_id)
  );
  for (const auth of orderedAccounts) {
    const mapped = byId.get(auth.account_id);
    if (!mapped) continue;
    foldCodexRoutingEvaluation(accumulator, evaluateCodexRoutingAccount(state, auth, mapped, model, observationsByAccount, now, unavailableAccounts));
  }
  return { ...accumulator };
};

const classifyCodexRouteSelection = (
  accumulated: CodexRoutingAccumulation,
  fullCohortExhausted = false,
  activeSnapshot: CodexActiveAccountSnapshot = { selection: null },
  poolSnapshotJson: string | null = null,
  capacitySnapshotJson: string | null = null
): RouteSelection => {
  const { available, blockedAccounts, skipped, retryAt, hasQuotaBlock, hasUpstreamTimeoutBlock, modelUnavailable } = accumulated;
  if (available.length) return { kind: "eligible", accounts: available, skippedSlots: skipped, blockedAccounts };
  if (hasUpstreamTimeoutBlock) {
    return { kind: "upstream_blocked", skippedSlots: skipped, retryAtMs: retryAt, blockedAccounts: [] };
  }
  if (hasQuotaBlock) {
    return {
      kind: "quota_blocked",
      skippedSlots: skipped,
      retryAtMs: retryAt,
      blockedAccounts,
      fullCohortExhausted,
      activeSnapshot,
      poolSnapshotJson,
      capacitySnapshotJson,
    };
  }
  // No account is even entitled to serve the named model: answer the model
  // itself rather than a retryable quota or credential failure.
  if (modelUnavailable !== null) {
    return { kind: "model_unavailable", model: modelUnavailable.model, detail: modelUnavailable.detail, skippedSlots: skipped };
  }
  return { kind: "credentials_invalid", skippedSlots: skipped };
};

const parseCodexAuthPoolSnapshot = (value: unknown): CodexAuthPoolState | null => {
  if (!isRecord(value) || !Array.isArray(value.accounts) || !isSafeMs(value.updated_at_ms) || value.accounts.length < 1) return null;
  const accountIds = new Set<string>();
  for (const candidate of value.accounts) {
    if (!isRecord(candidate)) return null;
    const accountId = getString(candidate.account_id);
    const accessToken = getString(candidate.access_token);
    if (!accountId || !accessToken || !isSafeMs(candidate.updated_at_ms) || accountIds.has(accountId)) return null;
    accountIds.add(accountId);
  }
  // Preserve validated ownership and the canonical maximum-pool bound.
  return parseCodexAuthPool(value);
};

const routingStateChangedByNormalization = (durable: CodexAccountRoutingState | null, normalized: CodexAccountRoutingState): boolean => {
  if (durable === null) return true;
  return (
    durable.banked_reset_legacy_identity_unresolved !== normalized.banked_reset_legacy_identity_unresolved ||
    durable.slots.length !== normalized.slots.length ||
    durable.slots.some((slot, index) => slot !== normalized.slots[index])
  );
};

export {
  accumulateCodexRoutingAccounts,
  classifyCodexRouteSelection,
  evaluateCodexRoutingAccount,
  foldCodexRoutingEvaluation,
  parseCodexAuthPoolSnapshot,
  routingStateChangedByNormalization,
};
export type { CodexRoutingAccumulation, CodexRoutingAccumulator, CodexRoutingAccountEvaluation, CodexRoutingSlotIdentity };
