import type { Kv } from "#kv";
// Codex account routing: probes, recovery, serial selection (remainder of the original module), split out of src/codex_account_routing.ts.

import { getKv } from "../kv.ts";

import { type CodexAuthPoolState, type CodexAuthState } from "../types.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY,
  type CodexAccountRoutingState,
  type CodexActiveAccountSelection,
  type CodexActiveAccountSnapshot,
  type CodexCapacityRoutingObservation,
  type CodexRoutingSlot,
  type RouteSelection,
  type RoutingAccount,
  isSafeMs,
  isVersionstamp,
  parseCodexAccountRoutingState,
  parseCodexActiveAccountSelection,
  setRoutingStateCache,
  getCachedRoutingState,
} from "./routing-state.ts";
import {
  loadCodexAccountRouting,
  loadCodexCapacityRoutingObservations,
  normalizeRoutingState,
  openRoutingKv,
  parseStoredCapacityObservationStore,
  quotaBlockForClass,
  quotaClass,
  recheckQuotaClasses,
  reconcileCapacityRoutingState,
  routingAccountIdentity,
  withSlot,
} from "./capacity-routing.ts";

import { isCodexQuotaBlockFenceCurrent } from "./routing-mutations.ts";
import {
  accumulateCodexRoutingAccounts,
  classifyCodexRouteSelection,
  parseCodexAuthPoolSnapshot,
  routingStateChangedByNormalization,
} from "./routing-evaluation.ts";
import type { CodexRoutingSlotIdentity } from "./routing-evaluation.ts";
import {
  activeSelectionForAccount,
  evaluateSerialRoutingAccounts,
  readStrongCodexRoutingRows,
  selectSerialCodexRoutingAccounts,
  withCodexAdmission,
} from "./routing-serial.ts";
export {
  claimCodexRoutingProbe,
  getCodexQuotaBlockFence,
  isCodexQuotaBlockFenceCurrent,
  markCodexCredentialInvalid,
  markCodexRecoveryProbeQuotaBlocked,
  markCodexSuccess,
  markCodexUpstreamTimeout,
  reconcileCodexQuotaAfterStaleVerifiedReset,
  reconcileCodexQuotaAfterVerifiedReset,
  reconcileCodexRoutingAccount,
  releaseCodexRoutingProbe,
} from "./routing-mutations.ts";
export const isCodexActiveAccountSnapshotCurrent = (value: unknown, snapshot: CodexActiveAccountSnapshot): boolean => {
  const current = parseCodexActiveAccountSelection(value);
  const observed = snapshot.selection;
  if (current === null || observed === null) return current === null && observed === null;
  return (
    current.account_id_hash === observed.account_id_hash &&
    current.credential_version === observed.credential_version &&
    current.pool_versionstamp === observed.pool_versionstamp &&
    current.slot === observed.slot &&
    current.routing_generation === observed.routing_generation &&
    current.generation === observed.generation &&
    current.transition_reason === observed.transition_reason &&
    current.updated_at_ms === observed.updated_at_ms
  );
};

/**
 * Elect the account a verified banked reset selected. The original active
 * snapshot must still be current, the candidate's pool credential and quota
 * routing fence must match, and every current pool account must still be
 * authoritatively exhausted: a concurrent active switch, a recovered sibling,
 * or newly eligible ordinary capacity wins over the stale reset. The same
 * account keeps its active generation; an account change advances it.
 */
/**
 * A ledger record that predates later routing transitions cannot satisfy the
 * exact current-generation fence; the same proof the stale reconciliation is
 * about to apply is sufficient here.
 */
const staleResetRoutingIdentityCurrent = (value: unknown, account: RoutingAccount, quotaResetAtMs: number): boolean => {
  const state = parseCodexAccountRoutingState(value);
  const current = state?.slots.at(account.slot);
  if (!current) return false;
  const classBlock = quotaBlockForClass(current, quotaClass(account.requestedModel));
  return (
    current.account_id_hash === account.accountIdHash &&
    current.credential_version === account.credentialVersion &&
    current.generation === account.routingGeneration &&
    current.invalid_credential_version !== account.credentialVersion &&
    classBlock !== null &&
    classBlock.observed_reset_at_ms === quotaResetAtMs &&
    classBlock.observed_reset_at_is_stable
  );
};

/** The same account keeps its active generation; an account change advances it. */
const nextResetElectionGeneration = (active: CodexActiveAccountSelection | null, candidate: RoutingAccount): number => {
  if (active === null) return 1;
  if (active.account_id_hash === candidate.accountIdHash && active.slot === candidate.slot) return active.generation;
  return active.generation + 1;
};

/** The exact pool credential an elected slot must still carry. */
const routingAuthMatchesAccount = (currentAuth: CodexAuthState, account: RoutingAccount): boolean =>
  currentAuth.account_id === account.auth.account_id &&
  currentAuth.access_token === account.auth.access_token &&
  currentAuth.refresh_token === account.auth.refresh_token;

/** The normalized slot an election candidate must still own, including its quota fence. */
const resetCandidateSlotMatches = (currentSlot: CodexRoutingSlot, account: RoutingAccount, routingIdentityCurrent: boolean): boolean =>
  currentSlot.account_id_hash === account.accountIdHash &&
  currentSlot.credential_version === account.credentialVersion &&
  currentSlot.generation === account.routingGeneration &&
  routingIdentityCurrent;

type CodexResetElectionPreparation = Readonly<{
  normalized: CodexAccountRoutingState;
  routing: CodexAccountRoutingState | null;
  routedCandidate: RoutingAccount;
  next: CodexActiveAccountSelection;
}>;

/**
 * Prove the original active snapshot, exact credential, routing fence, and
 * complete exhausted cohort, then build the next active row. Normalization,
 * evaluation, and the row itself keep their separate clock reads.
 */
const prepareCodexResetRecoveryElection = async (
  account: RoutingAccount,
  routingGeneration: number,
  originalActive: CodexActiveAccountSnapshot,
  quotaResetAtMs: number,
  staleVerified: boolean,
  rows: Awaited<ReturnType<typeof readStrongCodexRoutingRows>>
): Promise<CodexResetElectionPreparation | null> => {
  if (!isCodexActiveAccountSnapshotCurrent(rows.activeEntry.value, originalActive)) return null;
  const active = originalActive.selection;
  const pool = rows.authEntry.value === null ? null : parseCodexAuthPoolSnapshot(rows.authEntry.value);
  const poolVersionstamp = rows.authEntry.versionstamp;
  if (!pool || !isVersionstamp(poolVersionstamp)) return null;
  const currentAuth = pool.accounts.at(account.slot);
  if (!currentAuth || !routingAuthMatchesAccount(currentAuth, account)) return null;
  const routing = rows.routingEntry.value === null ? null : parseCodexAccountRoutingState(rows.routingEntry.value);
  if (rows.routingEntry.value !== null && routing === null) return null;
  const normalized = await normalizeRoutingState(routing, pool, Date.now(), true);
  const currentSlot = normalized.slots.at(account.slot);
  const routingIdentityCurrent = staleVerified
    ? staleResetRoutingIdentityCurrent(rows.routingEntry.value, account, quotaResetAtMs)
    : isCodexQuotaBlockFenceCurrent(rows.routingEntry.value, account, quotaResetAtMs, routingGeneration);
  if (!currentSlot || !resetCandidateSlotMatches(currentSlot, account, routingIdentityCurrent)) return null;
  const accountIdHash = currentSlot.account_id_hash;
  if (accountIdHash === null) return null;
  const observations = parseStoredCapacityObservationStore(rows.capacityEntry.value);
  const evaluations = await evaluateSerialRoutingAccounts(normalized, pool, account.requestedModel ?? null, observations, Date.now());
  const fullCohortExhausted =
    pool.accounts.length > 0 && pool.accounts.every((auth) => evaluations.byAccountId.get(auth.account_id)?.activeTransitionReason === "quota_exhausted");
  if (!fullCohortExhausted) return null;
  const routedCandidate: RoutingAccount = {
    ...account,
    accountIdHash,
    credentialVersion: currentSlot.credential_version,
    routingGeneration: currentSlot.generation,
  };
  const next = activeSelectionForAccount(
    routedCandidate,
    poolVersionstamp,
    nextResetElectionGeneration(active, routedCandidate),
    Date.now(),
    "quota_exhausted"
  );
  if (!next) return null;
  return { normalized, routing, routedCandidate, next };
};

/** Commit the prepared election, writing routing before the active row. */
const commitCodexResetRecoveryElection = async (
  kv: Kv,
  rows: Awaited<ReturnType<typeof readStrongCodexRoutingRows>>,
  prepared: CodexResetElectionPreparation
): Promise<RoutingAccount | "conflict"> => {
  const routingChanged = routingStateChangedByNormalization(prepared.routing, prepared.normalized);
  let operation = kv.atomic().check(rows.activeEntry).check(rows.authEntry).check(rows.routingEntry).check(rows.capacityEntry);
  if (routingChanged) operation = operation.set(CODEX_ACCOUNT_ROUTING_KV_KEY, prepared.normalized);
  const committed = await operation.set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, prepared.next).commit();
  if (!committed.ok) return "conflict";
  setRoutingStateCache(prepared.normalized, routingChanged ? committed.versionstamp : rows.routingEntry.versionstamp);
  return {
    ...prepared.routedCandidate,
    activeGeneration: prepared.next.generation,
    activePoolVersionstamp: prepared.next.pool_versionstamp,
    activeTransitionReason: prepared.next.transition_reason,
  };
};

export const electCodexResetRecoveryAccount = async (
  account: RoutingAccount,
  originalActive: CodexActiveAccountSnapshot,
  quotaResetAtMs: number,
  staleVerified = false
): Promise<RoutingAccount | null> => {
  if (account.routingGeneration === undefined || !isSafeMs(quotaResetAtMs)) return null;
  const routingGeneration = account.routingGeneration;
  try {
    const kv = await getKv();
    if (!kv) return null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = await readStrongCodexRoutingRows(kv);
      const prepared = await prepareCodexResetRecoveryElection(account, routingGeneration, originalActive, quotaResetAtMs, staleVerified, rows);
      if (prepared === null) return null;
      const elected = await commitCodexResetRecoveryElection(kv, rows, prepared);
      if (elected === "conflict") continue;
      return elected;
    }
  } catch {
    return null;
  }
  return null;
};

/** The routing generation an admission refresh must bind to, or null when its slot cannot be proven. */
const resolveAdmissionRefreshGeneration = async (account: RoutingAccount, pool: CodexAuthPoolState, routingValue: unknown): Promise<number | null> => {
  const routing = parseCodexAccountRoutingState(routingValue);
  if (routingValue !== null && routing === null) return null;
  const normalized = routing === null ? null : await normalizeRoutingState(routing, pool, Date.now(), true);
  const currentSlot = normalized?.slots.at(account.slot) ?? null;
  if (normalized !== null && currentSlot === null) return null;
  if (
    currentSlot !== null &&
    (currentSlot.account_id_hash !== account.accountIdHash ||
      currentSlot.credential_version !== account.credentialVersion ||
      currentSlot.invalid_credential_version === account.credentialVersion)
  )
    return null;
  return currentSlot?.generation ?? 0;
};

type CodexAdmissionRefreshPreparation =
  Readonly<{ kind: "current" }> | Readonly<{ kind: "refresh"; next: CodexActiveAccountSelection }> | Readonly<{ kind: "reject" }>;

/**
 * Prove the admitted active identity and generation, then prepare a same-identity
 * fence refresh. A current row returns without any write; every conflict rejects
 * so the caller reloads all four rows.
 */
const prepareCodexActiveAccountAdmissionRefresh = async (
  account: RoutingAccount,
  rows: Awaited<ReturnType<typeof readStrongCodexRoutingRows>>
): Promise<CodexAdmissionRefreshPreparation> => {
  const active = rows.activeEntry.value === null ? null : parseCodexActiveAccountSelection(rows.activeEntry.value);
  if (active === null) return { kind: "reject" };
  if (active.generation !== account.activeGeneration) return { kind: "reject" };
  if (active.account_id_hash !== account.accountIdHash || active.slot !== account.slot) return { kind: "reject" };
  const pool = rows.authEntry.value === null ? null : parseCodexAuthPoolSnapshot(rows.authEntry.value);
  const poolVersionstamp = rows.authEntry.versionstamp;
  if (!pool || !isVersionstamp(poolVersionstamp)) return { kind: "reject" };
  const currentAuth = pool.accounts.at(account.slot);
  if (!currentAuth || !routingAuthMatchesAccount(currentAuth, account)) return { kind: "reject" };
  const routingGeneration = await resolveAdmissionRefreshGeneration(account, pool, rows.routingEntry.value);
  if (routingGeneration === null) return { kind: "reject" };
  if (
    active.credential_version === account.credentialVersion &&
    active.pool_versionstamp === poolVersionstamp &&
    active.routing_generation === routingGeneration
  ) {
    return { kind: "current" };
  }
  return {
    kind: "refresh",
    next: {
      ...active,
      credential_version: account.credentialVersion,
      pool_versionstamp: poolVersionstamp,
      routing_generation: routingGeneration,
      updated_at_ms: Date.now(),
    },
  };
};

/**
 * Final pre-transport admission. The active identity and generation must still
 * match the admitted request; the request's own probe claim or same-identity
 * credential refresh may have advanced the credential/routing fences, so those
 * are refreshed atomically without changing the active identity or generation.
 * A concurrent active switch, pool rotation, or conflicting writer fails.
 */
export const refreshCodexActiveAccountAdmission = async (account: RoutingAccount): Promise<boolean> => {
  if (account.activeGeneration === undefined || !Number.isSafeInteger(account.activeGeneration) || account.activeGeneration < 1) return false;
  try {
    const kv = await getKv();
    if (!kv) return false;
    return await withCodexAdmission(kv, async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const rows = await readStrongCodexRoutingRows(kv);
        const prepared = await prepareCodexActiveAccountAdmissionRefresh(account, rows);
        if (prepared.kind === "reject") return false;
        if (prepared.kind === "current") return true;
        const committed = await kv
          .atomic()
          .check(rows.activeEntry)
          .check(rows.authEntry)
          .check(rows.routingEntry)
          .check(rows.capacityEntry)
          .set(CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY, prepared.next)
          .commit();
        if (!committed.ok) continue;
        return true;
      }
      return false;
    });
  } catch {
    return false;
  }
};

const selectCodexRoutingAccountsFromState = async (
  state: CodexAccountRoutingState,
  pool: CodexAuthPoolState,
  orderedAccounts: readonly CodexAuthState[],
  now: number,
  model: string | null,
  capacityObservations: readonly CodexCapacityRoutingObservation[]
): Promise<RouteSelection> => {
  const identities = await Promise.all(pool.accounts.map(routingAccountIdentity));
  const byId = new Map<string, CodexRoutingSlotIdentity>();
  for (const [slot, auth] of pool.accounts.entries()) {
    const identity = identities.at(slot);
    if (identity === undefined) continue;
    byId.set(auth.account_id, { slot, accountIdHash: identity.accountIdHash, credentialVersion: identity.credentialVersion });
  }
  const observationsByAccount = new Map(capacityObservations.map((observation) => [observation.account_id_hash, observation]));
  return classifyCodexRouteSelection(accumulateCodexRoutingAccounts(state, byId, orderedAccounts, model, observationsByAccount, now));
};

/**
 * Slot-scoped eligibility for the internal prompt-cache experiment and other
 * pinned callers that already chose their account. It hydrates the shared
 * routing/capacity caches and reconciles existing capacity observations exactly
 * as the pre-cutover helper did, so a following transition CAS is based on the
 * row this read returned. It never reads or writes the global active-selection
 * row; ordinary inference admissions must use `selectCodexRoutingAccountsStrong`.
 */
export const selectCodexRoutingAccounts = async (
  pool: CodexAuthPoolState,
  orderedAccounts: readonly CodexAuthState[],
  now = Date.now(),
  model: string | null = null
): Promise<RouteSelection> =>
  await (async () => {
    const state = await loadCodexAccountRouting(pool);
    const observations = await loadCodexCapacityRoutingObservations(pool);
    const reconciled = await reconcileCapacityRoutingState(state, observations, now, model);
    return await selectCodexRoutingAccountsFromState(reconciled, pool, orderedAccounts, now, model, observations);
  })();

export const selectCodexRoutingAccountsStrong = async (
  pool: CodexAuthPoolState,
  orderedAccounts: readonly CodexAuthState[],
  now = Date.now(),
  model: string | null = null
): Promise<RouteSelection> => await selectSerialCodexRoutingAccounts(pool, orderedAccounts, now, model);

/**
 * A rechecked slot keeps its circuit deadline but loses the reset identity that
 * authorized it: an administrative deadline mutation is not provider proof of
 * the same quota generation, so a later recovery probe is required before a
 * stable identity may authorize a banked claim again.
 */
const recheckSlotTransition = (current: CodexRoutingSlot, recheckAtMs: number): CodexRoutingSlot => {
  const rechecked = recheckQuotaClasses(current, recheckAtMs);
  return {
    ...rechecked,
    quota_signal_observed_at_ms: recheckAtMs,
    banked_reset_generation_ambiguous:
      rechecked.banked_reset_generation_ambiguous ||
      rechecked.quota_blocked_until_ms !== null ||
      current.banked_reset_generation_ambiguous ||
      (current.observed_reset_at_ms !== null && current.observed_reset_at_is_stable),
    generation: current.generation + 1,
    probe_lease: null,
  };
};

/** Resolve a 1-based administrative slot number against the state's slots. */
const locateRoutingSlot = (state: CodexAccountRoutingState, slotNumber: number): Readonly<{ index: number; slot: CodexRoutingSlot }> | null => {
  if (slotNumber > state.slots.length) return null;
  const index = slotNumber - 1;
  const slot = state.slots.at(index);
  return slot === undefined ? null : { index, slot };
};

/** Strong-read recheck loop: three compare-and-set attempts, then give up. */
const recheckCodexRoutingSlotFromKv = async (kv: Kv, slotNumber: number, recheckAtMs: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await kv.get<CodexAccountRoutingState>(CODEX_ACCOUNT_ROUTING_KV_KEY, { consistency: "strong" });
    const state = parseCodexAccountRoutingState(entry.value);
    if (!state) return false;
    const located = locateRoutingSlot(state, slotNumber);
    if (located === null) return false;
    if (!located.slot.quota_blocked_until_ms) {
      setRoutingStateCache(state, entry.versionstamp);
      return true;
    }
    const next = withSlot(state, located.index, recheckSlotTransition(located.slot, recheckAtMs));
    const committed = await kv.atomic().check(entry).set(CODEX_ACCOUNT_ROUTING_KV_KEY, next).commit();
    if (committed.ok) {
      setRoutingStateCache(next, committed.versionstamp);
      return true;
    }
  }
  return false;
};

/** Recheck against the cached record when KV is unavailable. */
const recheckCodexRoutingSlotLocally = (slotNumber: number, recheckAtMs: number): boolean => {
  const state = getCachedRoutingState();
  if (!state) return false;
  const located = locateRoutingSlot(state, slotNumber);
  if (located === null) return false;
  if (!located.slot.quota_blocked_until_ms) return true;
  setRoutingStateCache(withSlot(state, located.index, recheckSlotTransition(located.slot, recheckAtMs)));
  return true;
};

/**
 * Makes a manually redeemed reset eligible for one normal-request probe.
 * This never clears reset-generation ambiguity: only a successful probe can
 * prove recovery and authorize a later provisional identity.
 */
export const recheckCodexRoutingSlot = async (slotNumber: number): Promise<boolean> => {
  if (!Number.isInteger(slotNumber) || slotNumber < 1) return false;
  const recheckAtMs = Date.now();

  // Rechecks are rare, administrative transitions. Always use a strong read
  // when available so a cold isolate can release a persisted circuit and a
  // stale local cache cannot overwrite a newer quota deadline.
  const kv = await openRoutingKv();
  if (!kv) return recheckCodexRoutingSlotLocally(slotNumber, recheckAtMs);
  return await recheckCodexRoutingSlotFromKv(kv, slotNumber, recheckAtMs);
};

// The state, capacity and 429 layers moved into their own modules; they are
// re-exported here until the rest of this module is extracted too.
export * from "./routing-state.ts";
export * from "./capacity-routing.ts";
export * from "./rate-limit-429.ts";
