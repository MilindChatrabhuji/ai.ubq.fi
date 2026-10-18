// Source-owned routing/probe/reset-fence transitions. Native owners inject clocks and lease tokens.
import {
  CODEX_HALF_OPEN_LEASE_MS,
  CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS,
  type CodexAccountRoutingState,
  type CodexRoutingSlot,
  type CodexRoutingAccount,
  type CodexActiveAccountSelection,
  type CodexActiveAccountSnapshot,
  type CodexProbeLease,
  hasUnresolvedLegacyResetIdentity,
  isSafeMs,
  parseCodexAccountRoutingState,
  parseCodexActiveAccountSelection,
} from "./native-codex-contracts.ts";
import {
  neutralSlot,
  slotFor,
  slotMatchesCodexRoutingAccount,
  probeLeaseMatchesCodexRoutingAccount,
  quotaBlockForClass,
  quotaBlockKeyForClass,
  quotaClass,
  releaseQuotaClassProbe,
  rotateCredentialForSameAccount,
  routingProbeCircuit,
  withLegacyQuotaClassMap,
  withSlot,
  withoutQuotaClass,
  recheckQuotaClasses,
} from "./native-codex-capacity.ts";

export const markCodexUpstreamTimeout = (
  state: CodexAccountRoutingState,
  account: CodexRoutingAccount,
  now: number,
  updatedAtMs: number
): CodexAccountRoutingState | null => {
  const blockedUntil = now + CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS;

  const current = slotFor(state, account);
  if (!slotMatchesCodexRoutingAccount(current, account)) return null;
  if (account.probeGeneration === null && current.probe_lease !== null) return null;
  if (account.probeGeneration !== null && !probeLeaseMatchesCodexRoutingAccount(current, account)) return null;
  const priorTimeout = current.upstream_timeout_blocked_until_ms ?? 0;
  return withSlot(
    state,
    account.slot,
    {
      ...current,
      account_id_hash: account.accountIdHash,
      upstream_timeout_blocked_until_ms: Math.max(priorTimeout, blockedUntil),
      generation: current.generation + 1,
      probe_lease: null,
    },
    updatedAtMs
  );
};

export const markCodexCredentialInvalid = (
  state: CodexAccountRoutingState,
  account: CodexRoutingAccount,
  now: number,
  updatedAtMs: number
): CodexAccountRoutingState | null => {
  const current = slotFor(state, account);
  if (!slotMatchesCodexRoutingAccount(current, account)) return null;
  if (account.probeGeneration !== null && !probeLeaseMatchesCodexRoutingAccount(current, account)) return null;
  return withSlot(
    state,
    account.slot,
    {
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
    },
    updatedAtMs
  );
};

export const releaseCodexRoutingProbe = (
  state: CodexAccountRoutingState,
  account: CodexRoutingAccount,
  updatedAtMs: number
): CodexAccountRoutingState | null => {
  const current = slotFor(state, account);
  if (!slotMatchesCodexRoutingAccount(current, account) || !probeLeaseMatchesCodexRoutingAccount(current, account)) return null;
  const released = routingProbeCircuit(account) === "quota" ? releaseQuotaClassProbe(current, quotaClass(account.requestedModel)) : current;
  return withSlot(
    state,
    account.slot,
    {
      ...released,
      account_id_hash: account.accountIdHash,
      upstream_timeout_blocked_until_ms: routingProbeCircuit(account) === "upstream_timeout" ? null : current.upstream_timeout_blocked_until_ms,
      probe_lease: null,
    },
    updatedAtMs
  );
};

export const markCodexSuccess = (state: CodexAccountRoutingState, account: CodexRoutingAccount, updatedAtMs: number): CodexAccountRoutingState | null => {
  const current = slotFor(state, account);
  if (!slotMatchesCodexRoutingAccount(current, account) || !probeLeaseMatchesCodexRoutingAccount(current, account)) return null;
  const classAwareCurrent = withLegacyQuotaClassMap(current);
  const released =
    routingProbeCircuit(account) === "quota"
      ? withoutQuotaClass(classAwareCurrent, quotaBlockKeyForClass(classAwareCurrent, quotaClass(account.requestedModel)) ?? quotaClass(account.requestedModel))
      : current;
  const hasOtherQuotaClasses = Object.keys(released.quota_blocks_by_class ?? {}).length > 0;
  return withSlot(
    state,
    account.slot,
    {
      ...released,
      account_id_hash: account.accountIdHash,
      upstream_timeout_blocked_until_ms: routingProbeCircuit(account) === "upstream_timeout" ? null : current.upstream_timeout_blocked_until_ms,
      observed_reset_at_ms: hasOtherQuotaClasses ? released.observed_reset_at_ms : null,
      observed_reset_at_is_stable: hasOtherQuotaClasses ? released.observed_reset_at_is_stable : false,
      banked_reset_generation_ambiguous: hasOtherQuotaClasses ? released.banked_reset_generation_ambiguous : false,
      banked_reset_recovery_probe_pending: hasOtherQuotaClasses ? released.banked_reset_recovery_probe_pending : false,
      probe_lease: null,
    },
    updatedAtMs
  );
};

export const reconcileRoutingCredential = (
  state: CodexAccountRoutingState,
  account: CodexRoutingAccount,
  identity: Readonly<{ accountIdHash: string; credentialVersion: string }>,
  sameAccount: boolean,
  updatedAtMs: number
): CodexAccountRoutingState | null => {
  const { accountIdHash, credentialVersion } = identity;

  const current = slotFor(state, account);
  if (current.credential_version === credentialVersion) return null;
  if (!slotMatchesCodexRoutingAccount(current, account)) return null;
  return withSlot(
    state,
    account.slot,
    sameAccount ? rotateCredentialForSameAccount(current, { accountIdHash, credentialVersion }) : neutralSlot(credentialVersion, accountIdHash),
    updatedAtMs
  );
};

export const isCodexQuotaBlockFenceCurrent = (value: unknown, account: CodexRoutingAccount, quotaResetAtMs: number, routingGeneration: number): boolean => {
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

export const recoveryProbeTransition = (
  state: CodexAccountRoutingState,
  account: CodexRoutingAccount,
  recoveryLease: CodexProbeLease,
  updatedAtMs: number
): CodexAccountRoutingState => {
  const current = state.slots[account.slot];
  const requestedQuotaClass = quotaClass(account.requestedModel);
  const nextGeneration = recoveryLease.generation;
  const classAwareCurrent = withLegacyQuotaClassMap(current);
  const releasedClassBlock = quotaBlockForClass(classAwareCurrent, requestedQuotaClass);
  const released = withoutQuotaClass(classAwareCurrent, quotaBlockKeyForClass(classAwareCurrent, requestedQuotaClass) ?? requestedQuotaClass);
  const next = withSlot(
    state,
    account.slot,
    {
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
    },
    updatedAtMs
  );
  return next;
};

export const buildExpiredProbeClaim = (
  base: CodexAccountRoutingState,
  account: CodexRoutingAccount,
  now: number,
  token: string,
  updatedAtMs: number
): Readonly<{ next: CodexAccountRoutingState; lease: CodexProbeLease }> | null => {
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
    !slotMatchesCodexRoutingAccount(current, account) ||
    current.invalid_credential_version === account.credentialVersion ||
    (!capacityProbe && !overageProbe && (!circuitDeadline || circuitDeadline > now)) ||
    (current.probe_lease?.expires_at_ms ?? 0) > now
  )
    return null;
  const lease: CodexProbeLease = {
    token,
    expires_at_ms: now + CODEX_HALF_OPEN_LEASE_MS,
    generation: current.generation,
    circuit,
    quota_class: circuit === "quota" ? requestedQuotaClass : null,
  };
  return {
    next: withSlot(
      base,
      account.slot,
      {
        ...current,
        account_id_hash: account.accountIdHash,
        probe_lease: lease,
      },
      updatedAtMs
    ),
    lease,
  };
};

export const staleVerifiedResetProbeEligible = (
  state: CodexAccountRoutingState,
  current: CodexRoutingSlot,
  account: CodexRoutingAccount,
  input: Readonly<{ quotaResetAtMs: number; routingGeneration: number }>,
  nowMs: number
): boolean =>
  !state.banked_reset_legacy_identity_unresolved &&
  slotMatchesCodexRoutingAccount(current, account) &&
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
  (current.probe_lease?.expires_at_ms ?? 0) <= nowMs;

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

export const staleResetRoutingIdentityCurrent = (value: unknown, account: CodexRoutingAccount, quotaResetAtMs: number): boolean => {
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

export const nextResetElectionGeneration = (active: CodexActiveAccountSelection | null, candidate: CodexRoutingAccount): number => {
  if (active === null) return 1;
  if (active.account_id_hash === candidate.accountIdHash && active.slot === candidate.slot) return active.generation;
  return active.generation + 1;
};

export const resetCandidateSlotMatches = (currentSlot: CodexRoutingSlot, account: CodexRoutingAccount, routingIdentityCurrent: boolean): boolean =>
  currentSlot.account_id_hash === account.accountIdHash &&
  currentSlot.credential_version === account.credentialVersion &&
  currentSlot.generation === account.routingGeneration &&
  routingIdentityCurrent;

export const recheckSlotTransition = (current: CodexRoutingSlot, recheckAtMs: number): CodexRoutingSlot => {
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

export const locateRoutingSlot = (state: CodexAccountRoutingState, slotNumber: number): Readonly<{ index: number; slot: CodexRoutingSlot }> | null => {
  if (slotNumber > state.slots.length) return null;
  const index = slotNumber - 1;
  const slot = state.slots.at(index);
  return slot === undefined ? null : { index, slot };
};

/** A source admission fence binds normalized slot metadata without inventing a missing routing row. */
export const admissionRefreshRoutingGeneration = (normalized: CodexAccountRoutingState | null, account: CodexRoutingAccount): number | null => {
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
export const prepareCodexAdmissionRefresh = (
  active: CodexActiveAccountSelection,
  account: CodexRoutingAccount,
  poolVersionstamp: string,
  routingGeneration: number
): Readonly<{ kind: "current" }> | Readonly<{ kind: "refresh"; next: CodexActiveAccountSelection }> => {
  if (
    active.credential_version === account.credentialVersion &&
    active.pool_versionstamp === poolVersionstamp &&
    active.routing_generation === routingGeneration
  )
    return { kind: "current" };
  return {
    kind: "refresh",
    next: { ...active, credential_version: account.credentialVersion, pool_versionstamp: poolVersionstamp, routing_generation: routingGeneration },
  };
};
