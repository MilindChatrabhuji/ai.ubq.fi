import type { AtomicOperation, Kv, KvEntryMaybe, KvKey } from "#kv";
// Codex routing account mutations and probe claiming, split out of src/codex_account_routing.ts.

import { getKv } from "../kv.ts";
import { isRecord } from "../utils.ts";
import { type CodexAuthPoolState, type CodexAuthState } from "../types.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_HALF_OPEN_LEASE_MS,
  CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
  type CodexAccountRoutingState,
  type CodexRoutingSlot,
  type RoutingAccount,
  hasUnresolvedLegacyResetIdentity,
  isSafeMs,
  parseCodexAccountRoutingState,
  setRoutingStateCache,
} from "./routing-state.ts";
import {
  loadCodexAccountRouting,
  neutralSlot,
  openRoutingKv,
  probeLeaseMatchesRoutingAccount,
  quotaBlockForClass,
  quotaBlockKeyForClass,
  quotaClass,
  quotaHeadroomFor,
  releaseQuotaClassProbe,
  rotateCredentialForSameAccount,
  routingAccountIdentity,
  routingProbeCircuit,
  slotFor,
  slotMatchesRoutingAccount,
  updateRoutingState,
  withLegacyQuotaClassMap,
  withSlot,
  withoutQuotaClass,
} from "./capacity-routing.ts";
import { type Codex429Classification, type CodexKnownProbeLease, markCodexQuotaBlockedWithMode } from "./rate-limit-429.ts";

export const markCodexRecoveryProbeQuotaBlocked = async (account: RoutingAccount, response: Response, now = Date.now()): Promise<Codex429Classification> =>
  await markCodexQuotaBlockedWithMode(account, response, now, true);

/**
 * Legacy transition retained for state-migration tests. Live inference no
 * longer calls it; normalized durable reads discard the resulting fence.
 */
export const markCodexUpstreamTimeout = async (account: RoutingAccount, now = Date.now()): Promise<void> => {
  const blockedUntil = now + CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS;
  await updateRoutingState((state) => {
    const current = slotFor(state, account);
    if (!slotMatchesRoutingAccount(current, account)) return null;
    if (account.probeGeneration === null && current.probe_lease !== null) return null;
    if (account.probeGeneration !== null && !probeLeaseMatchesRoutingAccount(current, account)) return null;
    const priorTimeout = current.upstream_timeout_blocked_until_ms ?? 0;
    return withSlot(state, account.slot, {
      ...current,
      account_id_hash: account.accountIdHash,
      upstream_timeout_blocked_until_ms: Math.max(priorTimeout, blockedUntil),
      generation: current.generation + 1,
      probe_lease: null,
    });
  });
};

export const markCodexCredentialInvalid = async (account: RoutingAccount): Promise<void> => {
  const now = Date.now();
  await updateRoutingState((state) => {
    const current = slotFor(state, account);
    if (!slotMatchesRoutingAccount(current, account)) return null;
    if (account.probeGeneration !== null && !probeLeaseMatchesRoutingAccount(current, account)) return null;
    return withSlot(state, account.slot, {
      ...current,
      account_id_hash: account.accountIdHash,
      quota_blocked_until_ms: null,
      quota_block_source: null,
      quota_blocked_classes: [],
      quota_blocks_by_class: {},
      upstream_timeout_blocked_until_ms: null,
      invalid_credential_version: account.credentialVersion,
      quota_signal_observed_at_ms: now,
      probe_lease: null,
    });
  });
};

/**
 * OAuth refresh can replace a token while an inference attempt is in flight.
 * Treat the token as a new credential version while retaining the account's
 * stable reset observation, so a refresh cannot manufacture a second key.
 */
export const reconcileCodexRoutingAccount = async (account: RoutingAccount, auth: CodexAuthState): Promise<RoutingAccount> => {
  const { accountIdHash, credentialVersion } = await routingAccountIdentity(auth);
  // The normal refresh check can return unchanged credentials. Preserve any
  // half-open probe fence so a successful response can clear the quota
  // circuit claimed for this request.
  if (credentialVersion === account.credentialVersion) return { ...account, auth, accountIdHash };

  const reconciled: RoutingAccount = {
    ...account,
    auth,
    accountIdHash,
    credentialVersion,
    probeRequired: false,
    probeGeneration: null,
    probeToken: null,
    probeCircuit: null,
  };

  // Credential rotation is exceptional. For the same account it releases
  // ordinary routing but retains a stable reset identity as lookup-only; only
  // a genuinely different account starts a neutral reset scope.
  const nextState = await updateRoutingState((state) => {
    const current = slotFor(state, account);
    if (current.credential_version === credentialVersion) return null;
    if (!slotMatchesRoutingAccount(current, account)) return null;
    return withSlot(
      state,
      account.slot,
      auth.account_id === account.auth.account_id
        ? rotateCredentialForSameAccount(current, { accountIdHash, credentialVersion })
        : neutralSlot(credentialVersion, accountIdHash)
    );
  });
  const nextSlot = nextState?.slots.at(account.slot);
  const nextProbeLease = nextSlot?.probe_lease ?? null;
  const retainedProbe =
    auth.account_id === account.auth.account_id &&
    account.probeGeneration !== null &&
    account.probeToken !== null &&
    nextSlot?.credential_version === credentialVersion &&
    nextProbeLease !== null &&
    nextProbeLease.token === account.probeToken &&
    nextProbeLease.circuit === routingProbeCircuit(account) &&
    nextProbeLease.generation === nextSlot.generation;
  return retainedProbe
    ? {
        ...reconciled,
        probeGeneration: nextSlot.generation,
        probeToken: nextProbeLease.token,
        probeCircuit: nextProbeLease.circuit,
      }
    : reconciled;
};

export const releaseCodexRoutingProbe = async (account: RoutingAccount): Promise<void> => {
  if (account.probeGeneration === null || !account.probeToken) return;
  await updateRoutingState((state) => {
    const current = slotFor(state, account);
    if (!slotMatchesRoutingAccount(current, account) || !probeLeaseMatchesRoutingAccount(current, account)) return null;
    const released = routingProbeCircuit(account) === "quota" ? releaseQuotaClassProbe(current, quotaClass(account.requestedModel)) : current;
    return withSlot(state, account.slot, {
      ...released,
      account_id_hash: account.accountIdHash,
      upstream_timeout_blocked_until_ms: routingProbeCircuit(account) === "upstream_timeout" ? null : current.upstream_timeout_blocked_until_ms,
      probe_lease: null,
    });
  });
};

/** A successful recovery probe is the only trusted way to clear reset ambiguity. */
export const markCodexSuccess = async (account: RoutingAccount): Promise<void> => {
  if (account.probeGeneration === null || !account.probeToken) return;
  await updateRoutingState((state) => {
    const current = slotFor(state, account);
    if (!slotMatchesRoutingAccount(current, account) || !probeLeaseMatchesRoutingAccount(current, account)) return null;
    const classAwareCurrent = withLegacyQuotaClassMap(current);
    const released =
      routingProbeCircuit(account) === "quota"
        ? withoutQuotaClass(
            classAwareCurrent,
            quotaBlockKeyForClass(classAwareCurrent, quotaClass(account.requestedModel)) ?? quotaClass(account.requestedModel)
          )
        : current;
    const hasOtherQuotaClasses = Object.keys(released.quota_blocks_by_class ?? {}).length > 0;
    return withSlot(state, account.slot, {
      ...released,
      account_id_hash: account.accountIdHash,
      upstream_timeout_blocked_until_ms: routingProbeCircuit(account) === "upstream_timeout" ? null : current.upstream_timeout_blocked_until_ms,
      observed_reset_at_ms: hasOtherQuotaClasses ? released.observed_reset_at_ms : null,
      observed_reset_at_is_stable: hasOtherQuotaClasses ? released.observed_reset_at_is_stable : false,
      banked_reset_generation_ambiguous: hasOtherQuotaClasses ? released.banked_reset_generation_ambiguous : false,
      banked_reset_recovery_probe_pending: hasOtherQuotaClasses ? released.banked_reset_recovery_probe_pending : false,
      probe_lease: null,
    });
  });
};

/**
 * Pure exact-fence predicate used by both strong-read helpers and the banked
 * reset's atomic KV checks. Equality (rather than `>=`) prevents a shorter
 * later Retry-After from authorizing a reset against a longer existing block;
 * an unresolved legacy account association denies every new claim.
 */
export const isCodexQuotaBlockFenceCurrent = (value: unknown, account: RoutingAccount, quotaResetAtMs: number, routingGeneration: number): boolean => {
  if (!isSafeMs(quotaResetAtMs) || !Number.isSafeInteger(routingGeneration) || routingGeneration < 0) return false;
  const state = parseCodexAccountRoutingState(value);
  const current = state?.slots[account.slot];
  const classBlock = current ? quotaBlockForClass(current, quotaClass(account.requestedModel)) : null;
  return (
    !hasUnresolvedLegacyResetIdentity(state) &&
    current?.credential_version === account.credentialVersion &&
    current.account_id_hash === account.accountIdHash &&
    current.generation === routingGeneration &&
    classBlock !== null &&
    classBlock.observed_reset_at_ms === quotaResetAtMs &&
    classBlock.observed_reset_at_is_stable &&
    !classBlock.banked_reset_generation_ambiguous &&
    classBlock.blocked_until_ms === quotaResetAtMs
  );
};

/**
 * Returns a durable routing fence for a fully persisted quota observation.
 * Account routing otherwise fails open when KV is down; banked redemption is
 * stricter and must refuse to start without this strong-read proof.
 */
export const getCodexQuotaBlockFence = async (account: RoutingAccount, quotaResetAtMs: number): Promise<number | null> => {
  if (!isSafeMs(quotaResetAtMs)) return null;
  let kv: Kv | null;
  try {
    kv = await getKv();
  } catch {
    return null;
  }
  if (!kv) return null;
  try {
    const entry = await kv.get<CodexAccountRoutingState>(CODEX_ACCOUNT_ROUTING_KV_KEY, { consistency: "strong" });
    const state = parseCodexAccountRoutingState(entry.value);
    const generation = state?.slots[account.slot]?.generation;
    return generation !== undefined && isCodexQuotaBlockFenceCurrent(entry.value, account, quotaResetAtMs, generation) ? generation : null;
  } catch {
    return null;
  }
};

/**
 * An additional immutable record that must remain current while a verified
 * reset clears its routing circuit. The gateway uses this for the auth-pool
 * slot, so a credential rotation cannot turn a verified reset into a retry
 * with a removed credential.
 */
export type CodexQuotaResetReconciliationFence = Readonly<{
  key: KvKey;
  isCurrent: (value: unknown) => boolean;
}>;

const readCurrentReconciliationFences = async (
  kv: Kv,
  fences: readonly CodexQuotaResetReconciliationFence[]
): Promise<readonly KvEntryMaybe<unknown>[] | null> => {
  if (!Array.isArray(fences) || !fences.every((fence) => isRecord(fence) && Array.isArray(fence.key) && typeof fence.isCurrent === "function")) return null;
  const entries: KvEntryMaybe<unknown>[] = [];
  for (const fence of fences) {
    let entry: KvEntryMaybe<unknown>;
    try {
      entry = await kv.get(fence.key, { consistency: "strong" });
      if (!fence.isCurrent(entry.value)) return null;
    } catch {
      return null;
    }
    entries.push(entry);
  }
  return entries;
};

const withReconciliationFences = (operation: AtomicOperation, entries: readonly KvEntryMaybe<unknown>[]): AtomicOperation => {
  let next = operation;
  for (const entry of entries) next = next.check(entry);
  return next;
};

type CodexQuotaProbeEligibility = (state: CodexAccountRoutingState, current: CodexRoutingSlot, nowMs: number) => boolean;

/** Apply the fenced half-open claim a verified reset just persisted. */
const applyRecoveryProbeLease = (account: RoutingAccount, next: CodexAccountRoutingState, lease: CodexKnownProbeLease): RoutingAccount | null => {
  const claimedSlot = next.slots.at(account.slot);
  if (claimedSlot === undefined) return null;
  return {
    ...account,
    quotaHeadroom: quotaHeadroomFor(claimedSlot),
    probeRequired: false,
    probeGeneration: lease.generation,
    probeToken: lease.token,
    probeCircuit: lease.circuit,
  };
};

/**
 * One strong-read compare-and-set attempt for a verified-reset recovery probe.
 * Returns "retry" when a concurrent writer won the CAS, and null when the
 * attempt must fail closed.
 */
const attemptCodexQuotaRecoveryProbe = async (
  kv: Kv,
  account: RoutingAccount,
  input: Readonly<{
    quotaResetAtMs: number;
    routingGeneration: number;
    fences?: readonly CodexQuotaResetReconciliationFence[];
  }>,
  isEligible: CodexQuotaProbeEligibility
): Promise<RoutingAccount | "retry" | null> => {
  try {
    const entry = await kv.get<CodexAccountRoutingState>(CODEX_ACCOUNT_ROUTING_KV_KEY, { consistency: "strong" });
    const state = parseCodexAccountRoutingState(entry.value);
    const current = state?.slots.at(account.slot);
    const nowMs = Date.now();
    if (!state || current === undefined || !isEligible(state, current, nowMs)) return null;
    const fenceEntries = input.fences === undefined ? [] : await readCurrentReconciliationFences(kv, input.fences);
    if (!fenceEntries) return null;
    const nextGeneration = current.generation + 1;
    const probeExpiresAtMs = nowMs + CODEX_HALF_OPEN_LEASE_MS;
    if (!Number.isSafeInteger(nextGeneration) || !isSafeMs(nowMs) || !isSafeMs(probeExpiresAtMs)) return null;
    const requestedQuotaClass = quotaClass(account.requestedModel);
    const recoveryLease: CodexKnownProbeLease = {
      token: crypto.randomUUID(),
      expires_at_ms: probeExpiresAtMs,
      generation: nextGeneration,
      circuit: "quota",
      quota_class: requestedQuotaClass,
    };
    const classAwareCurrent = withLegacyQuotaClassMap(current);
    const releasedClassBlock = quotaBlockForClass(classAwareCurrent, requestedQuotaClass);
    const released = withoutQuotaClass(classAwareCurrent, quotaBlockKeyForClass(classAwareCurrent, requestedQuotaClass) ?? requestedQuotaClass);
    const next = withSlot(state, account.slot, {
      ...released,
      // The verified reset makes normal routing eligible, but an absolute
      // Retry-After cannot prove whether a delayed response names this old
      // window or a new one. Keep the observation lookup-only until a
      // recovery probe independently proves the circuit healthy.
      observed_reset_at_ms: releasedClassBlock?.observed_reset_at_ms ?? current.observed_reset_at_ms,
      observed_reset_at_is_stable: releasedClassBlock?.observed_reset_at_is_stable ?? current.observed_reset_at_is_stable,
      banked_reset_generation_ambiguous: true,
      banked_reset_recovery_probe_pending: true,
      generation: nextGeneration,
      probe_lease: recoveryLease,
    });
    const committed = await withReconciliationFences(kv.atomic().check(entry), fenceEntries).set(CODEX_ACCOUNT_ROUTING_KV_KEY, next).commit();
    if (!committed.ok) return "retry";
    setRoutingStateCache(next, committed.versionstamp);
    return applyRecoveryProbeLease(account, next, recoveryLease);
  } catch {
    return null;
  }
};

/**
 * Claim a fenced recovery probe after a verified reset. The eligibility
 * predicate is kept separate because stale ledger records need a different
 * proof than the current-generation fence, while the CAS/lease transition
 * must remain identical.
 */
const reconcileCodexQuotaAfterProbe = async (
  account: RoutingAccount,
  input: Readonly<{
    quotaResetAtMs: number;
    routingGeneration: number;
    fences?: readonly CodexQuotaResetReconciliationFence[];
  }>,
  isEligible: CodexQuotaProbeEligibility
): Promise<RoutingAccount | null> => {
  if (!isSafeMs(input.quotaResetAtMs) || !Number.isSafeInteger(input.routingGeneration) || input.routingGeneration < 0) return null;
  const kv = await openRoutingKv();
  if (!kv) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claimed = await attemptCodexQuotaRecoveryProbe(kv, account, input, isEligible);
    if (claimed === null) return null;
    if (claimed !== "retry") return claimed;
  }
  return null;
};

/**
 * A verified reset may release only the exact circuit observation that caused
 * it. Credential and generation checks prevent an old provider transaction
 * from admitting a newly rotated credential or a later quota window.
 */
export const reconcileCodexQuotaAfterVerifiedReset = async (
  account: RoutingAccount,
  input: Readonly<{
    quotaResetAtMs: number;
    routingGeneration: number;
    fences?: readonly CodexQuotaResetReconciliationFence[];
  }>
): Promise<RoutingAccount | null> =>
  await reconcileCodexQuotaAfterProbe(account, input, (state) => isCodexQuotaBlockFenceCurrent(state, account, input.quotaResetAtMs, input.routingGeneration));

/**
 * Recover an account whose verified reset record predates later routing
 * transitions. The ledger proves the reset was already spent, so this path
 * only fences a new inference probe; it never submits another reset.
 */
export const reconcileCodexQuotaAfterStaleVerifiedReset = async (
  account: RoutingAccount,
  input: Readonly<{
    quotaResetAtMs: number;
    routingGeneration: number;
    fences?: readonly CodexQuotaResetReconciliationFence[];
  }>
): Promise<RoutingAccount | null> => {
  return await reconcileCodexQuotaAfterProbe(
    account,
    input,
    (state, current, nowMs) =>
      !state.banked_reset_legacy_identity_unresolved &&
      slotMatchesRoutingAccount(current, account) &&
      current.account_id_hash === account.accountIdHash &&
      current.credential_version === account.credentialVersion &&
      current.generation === input.routingGeneration &&
      current.invalid_credential_version !== account.credentialVersion &&
      (() => {
        const requestedClass = quotaClass(account.requestedModel);
        const classBlock = quotaBlockForClass(current, requestedClass);
        const legacyDeadline = requestedClass === "unknown" ? (current.quota_blocked_until_ms ?? 0) : 0;
        return (
          classBlock !== null &&
          Math.max(classBlock.blocked_until_ms, legacyDeadline) >= input.quotaResetAtMs &&
          classBlock.observed_reset_at_ms === input.quotaResetAtMs &&
          classBlock.observed_reset_at_is_stable
        );
      })() &&
      (current.probe_lease?.expires_at_ms ?? 0) <= nowMs
  );
};

/** Adopt a lease this isolate just minted as the account's half-open claim. */
const applyClaimedProbeLease = (account: RoutingAccount, lease: CodexKnownProbeLease): RoutingAccount => ({
  ...account,
  probeRequired: false,
  probeGeneration: lease.generation,
  probeToken: lease.token,
  probeCircuit: lease.circuit,
});

const buildExpiredProbeClaim = (
  base: CodexAccountRoutingState,
  account: RoutingAccount,
  now: number
): Readonly<{ next: CodexAccountRoutingState; lease: CodexKnownProbeLease }> | null => {
  const current = slotFor(base, account);
  const circuit = routingProbeCircuit(account);
  const requestedQuotaClass = quotaClass(account.requestedModel);
  const classBlock = quotaBlockForClass(current, requestedQuotaClass);
  const circuitDeadline = circuit === "upstream_timeout" ? current.upstream_timeout_blocked_until_ms : classBlock?.blocked_until_ms;
  // A capacity-exhausted subscription with no class circuit is the probe
  // candidate that has no deadline to expire: its only trusted recovery is a
  // successful bounded probe, so it is claimed like an expired circuit.
  const capacityProbe = circuit === "quota" && classBlock === null && account.quotaHeadroom === 0;
  // A blocked cohort that proved no redeemable credit may hold exactly one
  // scoped overage attempt even while its class-block deadline is still live.
  // The live-lease check below still serializes the attempt.
  const overageProbe = circuit === "quota" && account.overageFallback === true;
  if (
    !slotMatchesRoutingAccount(current, account) ||
    current.invalid_credential_version === account.credentialVersion ||
    (!capacityProbe && !overageProbe && (!circuitDeadline || circuitDeadline > now)) ||
    (current.probe_lease?.expires_at_ms ?? 0) > now
  )
    return null;
  const lease: CodexKnownProbeLease = {
    token: crypto.randomUUID(),
    expires_at_ms: now + CODEX_HALF_OPEN_LEASE_MS,
    generation: current.generation,
    circuit,
    quota_class: circuit === "quota" ? requestedQuotaClass : null,
  };
  return {
    next: withSlot(base, account.slot, {
      ...current,
      account_id_hash: account.accountIdHash,
      probe_lease: lease,
    }),
    lease,
  };
};

/**
 * Claim locally. This retains availability when KV is unavailable, but not
 * cross-isolate coordination.
 */
const applyLocalExpiredProbeClaim = (state: CodexAccountRoutingState, account: RoutingAccount, now: number): RoutingAccount | null => {
  const claimed = buildExpiredProbeClaim(state, account, now);
  if (!claimed) return null;
  setRoutingStateCache(claimed.next);
  return applyClaimedProbeLease(account, claimed.lease);
};

const claimExpiredProbeFromKv = async (kv: Kv, account: RoutingAccount, state: CodexAccountRoutingState, now: number): Promise<RoutingAccount | null> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await kv.get<CodexAccountRoutingState>(CODEX_ACCOUNT_ROUTING_KV_KEY, { consistency: "strong" });
    const durable = parseCodexAccountRoutingState(entry.value);
    const claimed = buildExpiredProbeClaim(durable ?? state, account, now);
    if (!claimed) return null;
    const commit = await kv.atomic().check(entry).set(CODEX_ACCOUNT_ROUTING_KV_KEY, claimed.next).commit();
    if (!commit.ok) continue;
    setRoutingStateCache(claimed.next, commit.versionstamp);
    return applyClaimedProbeLease(account, claimed.lease);
  }
  return null;
};

const claimExpiredProbe = async (state: CodexAccountRoutingState, account: RoutingAccount, now: number): Promise<RoutingAccount | null> => {
  try {
    const kv = await openRoutingKv();
    if (kv === null) return applyLocalExpiredProbeClaim(state, account, now);
    return await claimExpiredProbeFromKv(kv, account, state, now);
  } catch {
    // Fail open if KV itself is unavailable. This retains availability but not cross-isolate coordination.
    return applyLocalExpiredProbeClaim(state, account, now);
  }
};

export const claimCodexRoutingProbe = async (pool: CodexAuthPoolState, account: RoutingAccount, now = Date.now()): Promise<RoutingAccount | null> => {
  if (!account.probeRequired) return account;
  const state = await loadCodexAccountRouting(pool);
  return await claimExpiredProbe(state, account, now);
};
