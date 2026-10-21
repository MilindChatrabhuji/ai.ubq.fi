// Source-owned capacity/normalization decisions. All clocks and identity metadata are injected.
import { isRecord } from "../utils.ts";
import {
  CODEX_CAPACITY_ROUTING_MAX_AGE_MS,
  type CodexAccountRoutingState,
  type CodexCapacityRoutingAdditionalRateLimit,
  type CodexCapacityRoutingObservation,
  type CodexCapacityRoutingWindow,
  type CodexProbeCircuit,
  type CodexQuotaClass,
  type CodexQuotaClassBlock,
  type CodexRoutingSlot,
  type CodexRoutingAccount,
  type CodexRoutingIdentity,
  isLegacyStableResetIdentity,
  isSafeMs,
  parseOptionalSafeMs,
} from "./native-codex-contracts.ts";
type CodexRoutingAccountIdentity = Readonly<{ accountIdHash: string; credentialVersion: string }>;
export const neutralSlot = (credentialVersion: string, accountIdHash: string | null): CodexRoutingSlot => ({
  account_id_hash: accountIdHash,
  credential_version: credentialVersion,
  quota_blocked_until_ms: null,
  quota_block_source: null,
  quota_blocked_classes: [],
  quota_blocks_by_class: {},
  invalid_credential_version: null,
  primary_used_percent: null,
  secondary_used_percent: null,
  quota_signal_observed_at_ms: null,
  capacity_observed_at_ms: null,
  upstream_timeout_blocked_until_ms: null,
  observed_reset_at_ms: null,
  observed_reset_at_is_stable: false,
  banked_reset_generation_ambiguous: false,
  banked_reset_recovery_probe_pending: false,
  generation: 0,
  probe_lease: null,
});

/**
 * Timeout fences were a shared provider gate. They are retained in the parser
 * only for a safe hard cut from existing durable rows, then discarded before
 * any live routing decision.
 */
const withoutLegacyTimeoutCircuit = (slot: CodexRoutingSlot): CodexRoutingSlot => {
  const hasTimeoutLease = slot.probe_lease?.circuit === "upstream_timeout";
  if (!slot.upstream_timeout_blocked_until_ms && !hasTimeoutLease) return slot;
  return {
    ...slot,
    upstream_timeout_blocked_until_ms: null,
    probe_lease: hasTimeoutLease ? null : slot.probe_lease,
    generation: slot.generation + 1,
  };
};

const preservesStableResetIdentity = (slot: CodexRoutingSlot): boolean =>
  slot.banked_reset_generation_ambiguous || (slot.observed_reset_at_ms !== null && slot.observed_reset_at_is_stable);

export const withoutLegacyTimeoutCircuits = (state: CodexAccountRoutingState): CodexAccountRoutingState => {
  const slots = state.slots.map(withoutLegacyTimeoutCircuit);
  return slots.some((slot, index) => slot !== state.slots[index]) ? { ...state, slots } : state;
};

/**
 * A token refresh stays in the same provider quota scope. Release ordinary
 * routing for the refreshed credential, but keep any pre-refresh stable reset
 * observation lookup-only until a successful recovery probe proves the
 * account recovered.
 */
export const rotateCredentialForSameAccount = (slot: CodexRoutingSlot, identity: CodexRoutingAccountIdentity): CodexRoutingSlot => {
  const generation = slot.generation + 1;
  const preservedBlock = Object.values(slot.quota_blocks_by_class ?? {}).reduce<CodexQuotaClassBlock | null>(
    (latest, block) => (!latest || block.blocked_until_ms > latest.blocked_until_ms ? block : latest),
    slot.observed_reset_at_ms !== null && slot.quota_block_source !== null
      ? {
          blocked_until_ms: slot.quota_blocked_until_ms ?? slot.observed_reset_at_ms,
          source: slot.quota_block_source,
          legacy_fallback: true,
          quota_signal_observed_at_ms: slot.quota_signal_observed_at_ms,
          observed_reset_at_ms: slot.observed_reset_at_ms,
          observed_reset_at_is_stable: slot.observed_reset_at_is_stable,
          banked_reset_generation_ambiguous: slot.banked_reset_generation_ambiguous,
          banked_reset_recovery_probe_pending: slot.banked_reset_recovery_probe_pending,
        }
      : null
  );
  return {
    ...slot,
    account_id_hash: identity.accountIdHash,
    credential_version: identity.credentialVersion,
    quota_blocked_until_ms: null,
    quota_block_source: null,
    quota_blocked_classes: [],
    quota_blocks_by_class: {},
    invalid_credential_version: null,
    primary_used_percent: null,
    secondary_used_percent: null,
    quota_signal_observed_at_ms: null,
    capacity_observed_at_ms: null,
    observed_reset_at_ms: preservedBlock?.observed_reset_at_ms ?? null,
    observed_reset_at_is_stable: preservedBlock?.observed_reset_at_is_stable ?? false,
    banked_reset_generation_ambiguous: preservesStableResetIdentity(slot) || preservedBlock?.banked_reset_generation_ambiguous === true,
    banked_reset_recovery_probe_pending: slot.banked_reset_recovery_probe_pending || preservedBlock?.banked_reset_recovery_probe_pending === true,
    generation,
    // A refresh does not end an already-dispatched half-open probe. Transfer
    // its lease to the new credential and fence completions to this generation.
    probe_lease: slot.probe_lease ? { ...slot.probe_lease, generation } : null,
  };
};

const attachLegacyAccountIdentity = (slot: CodexRoutingSlot, identity: CodexRoutingAccountIdentity): CodexRoutingSlot => ({
  ...slot,
  account_id_hash: identity.accountIdHash,
  // A pre-account-identity record cannot establish that its stable deadline
  // belongs to this account after a pool transition. Keep it lookup-only.
  banked_reset_generation_ambiguous: preservesStableResetIdentity(slot),
});

export const normalizeRoutingState = (
  raw: CodexAccountRoutingState | null,
  identities: readonly CodexRoutingIdentity[],
  now: number,
  discardLegacyTimeoutCircuit = false
): CodexAccountRoutingState => {
  const priorSlots = raw?.slots ?? [];
  const usedPriorSlots = new Set<number>();
  const takePrior = (matches: (slot: CodexRoutingSlot) => boolean): CodexRoutingSlot | null => {
    const index = priorSlots.findIndex((slot, candidateIndex) => !usedPriorSlots.has(candidateIndex) && matches(slot));
    if (index < 0) return null;
    usedPriorSlots.add(index);
    return priorSlots[index];
  };
  const slots = identities.map((identity, index) => {
    const direct = priorSlots.at(index);
    let prior: CodexRoutingSlot | null = null;
    if (
      direct &&
      !usedPriorSlots.has(index) &&
      (direct.account_id_hash === identity.accountIdHash || (direct.account_id_hash === null && direct.credential_version === identity.credentialVersion))
    ) {
      usedPriorSlots.add(index);
      prior = direct;
    }
    prior ??= takePrior((slot) => slot.account_id_hash === identity.accountIdHash);
    // Version equality is the only safe way to attach an account identity to a
    // legacy record that predates the opaque account hash.
    prior ??= takePrior((slot) => slot.account_id_hash === null && slot.credential_version === identity.credentialVersion);
    if (!prior) return neutralSlot(identity.credentialVersion, identity.accountIdHash);
    if (discardLegacyTimeoutCircuit) prior = withoutLegacyTimeoutCircuit(prior);
    if (prior.credential_version === identity.credentialVersion) {
      return withoutLegacyTimeoutCircuit(prior.account_id_hash === identity.accountIdHash ? prior : attachLegacyAccountIdentity(prior, identity));
    }
    return withoutLegacyTimeoutCircuit(rotateCredentialForSameAccount(prior, identity));
  });
  // Do not attach an unidentifiable legacy identity to whichever account now
  // occupies its old slot. A global claim fence keeps ordinary routing usable
  // while preventing a same-account token rotation from minting a new key.
  const legacyIdentityUnresolved =
    raw?.banked_reset_legacy_identity_unresolved === true || priorSlots.some((slot, index) => !usedPriorSlots.has(index) && isLegacyStableResetIdentity(slot));
  return {
    v: 2,
    updated_at_ms: now,
    banked_reset_legacy_identity_unresolved: legacyIdentityUnresolved,
    slots,
  };
};

export const slotFor = (state: CodexAccountRoutingState, account: CodexRoutingAccount): CodexRoutingSlot =>
  state.slots[account.slot] ?? neutralSlot(account.credentialVersion, account.accountIdHash);

export const slotMatchesCodexRoutingAccount = (slot: CodexRoutingSlot, account: CodexRoutingAccount): boolean =>
  slot.credential_version === account.credentialVersion &&
  // Exact credential-version equality is the legacy proof of account scope;
  // every successful transition writes the opaque account hash immediately.
  (slot.account_id_hash === account.accountIdHash || slot.account_id_hash === null);

export const routingProbeCircuit = (account: CodexRoutingAccount): CodexProbeCircuit => account.probeCircuit ?? "quota";

/**
 * A lease matches only when its token, generation, circuit and (for the quota
 * circuit) model class all belong to this account's claim.
 */
export const probeLeaseMatchesCodexRoutingAccount = (slot: CodexRoutingSlot, account: CodexRoutingAccount): boolean => {
  const lease = slot.probe_lease;
  if (account.probeGeneration === null || lease === null) return false;
  if (slot.generation !== account.probeGeneration) return false;
  if (lease.generation !== account.probeGeneration || lease.token !== account.probeToken) return false;
  if (lease.circuit !== routingProbeCircuit(account)) return false;
  if (routingProbeCircuit(account) !== "quota") return true;
  return lease.quota_class === null || lease.quota_class === undefined || lease.quota_class === quotaClass(account.requestedModel);
};

export const withSlot = (state: CodexAccountRoutingState, index: number, slot: CodexRoutingSlot, updatedAtMs: number): CodexAccountRoutingState => {
  const slots = [...state.slots];
  while (slots.length <= index) slots.push(neutralSlot(slot.credential_version, slot.account_id_hash));
  slots[index] = slot;
  return { ...state, updated_at_ms: updatedAtMs, slots };
};

export const parseFinitePercent = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
};

export const quotaHeadroomFor = (slot: CodexRoutingSlot): number | null => {
  const used = [slot.primary_used_percent, slot.secondary_used_percent].filter((value): value is number => value !== null);
  return used.length ? Math.max(0, Math.min(...used.map((value) => 100 - value))) : null;
};

export const capacityState = (value: unknown): CodexCapacityRoutingObservation["state"] | null =>
  value === "available" || value === "stale" || value === "unavailable" ? value : null;

// A missing field and a non-canonical value both mean "no usable observation",
// so each reader needs only the canonical-value test.
const capacityPercent = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);

const capacityWindowSeconds = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

const capacityResetAtMs = (value: unknown): number | null => parseOptionalSafeMs(value);

export const normalizeCapacityWindow = (value: unknown): CodexCapacityRoutingWindow | null => {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  return {
    limit_window_seconds: capacityWindowSeconds(value.limit_window_seconds),
    used_percent: capacityPercent(value.used_percent),
    reset_at_ms: capacityResetAtMs(value.reset_at_ms),
  };
};

const normalizeCapacityAdditionalRateLimit = (value: unknown): CodexCapacityRoutingAdditionalRateLimit | null => {
  if (!isRecord(value)) return null;
  const limitName = typeof value.limit_name === "string" ? value.limit_name.trim() : "";
  if (!limitName) return null;
  const windows = isRecord(value.windows) ? value.windows : null;
  if (!windows) return null;
  const meteredFeature = value.metered_feature;
  if (meteredFeature !== null && meteredFeature !== undefined && typeof meteredFeature !== "string") return null;
  return {
    limit_name: limitName,
    metered_feature: typeof meteredFeature === "string" ? meteredFeature.trim() || null : null,
    windows: {
      primary: normalizeCapacityWindow(windows.primary),
      secondary: normalizeCapacityWindow(windows.secondary),
    },
  };
};

export const normalizeCapacityAdditionalRateLimits = (value: unknown): readonly CodexCapacityRoutingAdditionalRateLimit[] =>
  Array.isArray(value)
    ? value.flatMap((candidate) => {
        const parsed = normalizeCapacityAdditionalRateLimit(candidate);
        return parsed ? [parsed] : [];
      })
    : [];

const capacityHeadroomForWindows = (
  windows: Readonly<{ primary: CodexCapacityRoutingWindow | null; secondary: CodexCapacityRoutingWindow | null }>
): number | null => {
  const used = [windows.primary?.used_percent ?? null, windows.secondary?.used_percent ?? null].filter((value): value is number => value !== null);
  return used.length ? Math.max(0, Math.min(...used.map((value) => 100 - value))) : null;
};

const normalizeQuotaLabel = (value: string | null | undefined): string => (typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "");

export const quotaClass = (model: string | null | undefined): CodexQuotaClass => {
  const normalized = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (normalized === "gpt-5.3-codex-spark") return "spark";
  if (normalized === "gpt-oss-120b") return "gpt_oss_120b";
  // `gpt-reserve` is the owner-authorized second id for luna. It keeps its own
  // bucket so exhausting reserve can never fence the standard class, and the
  // compact form matches however the id is spelled at the call site.
  if (normalizeQuotaLabel(normalized) === "gptreserve") return "reserve";
  return normalized ? "standard" : "unknown";
};

export const quotaBlockForClass = (slot: CodexRoutingSlot, quotaClassKey: CodexQuotaClass): CodexQuotaClassBlock | null => {
  const exact = slot.quota_blocks_by_class?.[quotaClassKey];
  const unknown = quotaClassKey === "unknown" ? null : slot.quota_blocks_by_class?.unknown;
  const legacyClasses = slot.quota_blocked_classes ?? [];
  const hasClassMap = Object.keys(slot.quota_blocks_by_class ?? {}).length > 0;
  // Records written before class-aware routing have only a slot-wide deadline
  // plus the classes observed so far. Preserve those named blocks during the
  // one-time migration instead of dispatching directly into a known circuit.
  const legacy =
    !hasClassMap &&
    slot.quota_blocked_until_ms !== null &&
    slot.quota_block_source !== null &&
    (legacyClasses.length === 0 || quotaClassKey === "unknown" || legacyClasses.includes("unknown") || legacyClasses.includes(quotaClassKey))
      ? {
          blocked_until_ms: slot.quota_blocked_until_ms,
          source: slot.quota_block_source,
          legacy_fallback: true,
          quota_signal_observed_at_ms: slot.quota_signal_observed_at_ms,
          observed_reset_at_ms: slot.observed_reset_at_ms,
          observed_reset_at_is_stable: slot.observed_reset_at_is_stable,
          banked_reset_generation_ambiguous: slot.banked_reset_generation_ambiguous,
          banked_reset_recovery_probe_pending: slot.banked_reset_recovery_probe_pending,
        }
      : null;
  return [exact, unknown, legacy]
    .filter((block): block is CodexQuotaClassBlock => block !== null && block !== undefined)
    .reduce<CodexQuotaClassBlock | null>((latest, block) => (!latest || block.blocked_until_ms > latest.blocked_until_ms ? block : latest), null);
};

const quotaClassKeys = ["spark", "gpt_oss_120b", "reserve", "standard", "unknown"] as const;

const isQuotaClassKey = (value: string): value is CodexQuotaClass => (quotaClassKeys as readonly string[]).includes(value);

export const quotaBlocksIncludingLegacy = (slot: CodexRoutingSlot): Partial<Record<CodexQuotaClass, CodexQuotaClassBlock>> => {
  const blocks = { ...slot.quota_blocks_by_class };
  if (slot.quota_blocked_until_ms === null || slot.quota_block_source === null) return blocks;
  const legacyClasses = (slot.quota_blocked_classes ?? []).filter(isQuotaClassKey);
  // An unclassified legacy deadline is conservatively copied to every quota
  // class so clearing one class cannot release the other separately metered
  // pools. The synthetic unknown entry remains the slot-wide fallback for
  // callers that do not provide a model.
  const classes = legacyClasses.length ? legacyClasses : quotaClassKeys;
  const legacyBlock: CodexQuotaClassBlock = {
    blocked_until_ms: slot.quota_blocked_until_ms,
    source: slot.quota_block_source,
    legacy_fallback: true,
    quota_signal_observed_at_ms: slot.quota_signal_observed_at_ms,
    observed_reset_at_ms: slot.observed_reset_at_ms,
    observed_reset_at_is_stable: slot.observed_reset_at_is_stable,
    banked_reset_generation_ambiguous: slot.banked_reset_generation_ambiguous,
    banked_reset_recovery_probe_pending: slot.banked_reset_recovery_probe_pending,
  };
  for (const quotaClassKey of classes) {
    blocks[quotaClassKey] ??= legacyBlock;
  }
  return blocks;
};

export const withLegacyQuotaClassMap = (slot: CodexRoutingSlot): CodexRoutingSlot => {
  const quotaBlocksByClass = quotaBlocksIncludingLegacy(slot);
  return Object.keys(quotaBlocksByClass).length === 0
    ? slot
    : {
        ...slot,
        quota_blocks_by_class: quotaBlocksByClass,
        quota_blocked_classes: Object.keys(quotaBlocksByClass),
      };
};

const quotaBlocksForClass = (slot: CodexRoutingSlot, quotaClassKey: CodexQuotaClass): readonly CodexQuotaClassBlock[] => {
  const classAwareSlot = withLegacyQuotaClassMap(slot);
  const candidates = [
    classAwareSlot.quota_blocks_by_class?.[quotaClassKey],
    quotaClassKey === "unknown" ? undefined : classAwareSlot.quota_blocks_by_class?.unknown,
  ].filter((block): block is CodexQuotaClassBlock => block !== undefined);
  return candidates.filter((block, index) => candidates.indexOf(block) === index);
};

export const quotaSignalObservedAtForClass = (slot: CodexRoutingSlot, quotaClassKey: CodexQuotaClass): number | null => {
  const signals = quotaBlocksForClass(slot, quotaClassKey)
    .map((block) => block.quota_signal_observed_at_ms ?? slot.quota_signal_observed_at_ms)
    .filter((value): value is number => value !== null);
  return signals.length ? Math.max(...signals) : slot.quota_signal_observed_at_ms;
};

export const quotaBlockKeyForClass = (slot: CodexRoutingSlot, quotaClassKey: CodexQuotaClass): CodexQuotaClass | null => {
  const block = quotaBlockForClass(slot, quotaClassKey);
  if (!block) return null;
  const blocks = slot.quota_blocks_by_class ?? {};
  if (blocks[quotaClassKey] === block) return quotaClassKey;
  // An independent unknown fence protects every model class. A known-class
  // recovery can release the shared fallback only when migration marked it as
  // a synthetic copy of the legacy slot-wide fence.
  if (quotaClassKey !== "unknown" && blocks.unknown === block && block.legacy_fallback) return "unknown";
  return null;
};

export const withoutQuotaClass = (slot: CodexRoutingSlot, quotaClassKey: CodexQuotaClass): CodexRoutingSlot => {
  // Rebuilt rather than copied-and-deleted: the map keeps a plain data shape,
  // and an unknown-class legacy fallback is dropped with the requested class.
  const currentBlocks = slot.quota_blocks_by_class ?? {};
  const dropUnknownLegacyFallback = quotaClassKey !== "unknown" && currentBlocks.unknown?.legacy_fallback === true;
  const quotaBlocksByClass = Object.fromEntries(
    Object.entries(currentBlocks).filter(([key]) => key !== quotaClassKey && !(dropUnknownLegacyFallback && key === "unknown"))
  ) as NonNullable<CodexRoutingSlot["quota_blocks_by_class"]>;
  const remaining = Object.values(quotaBlocksByClass);
  const latest = remaining.reduce<CodexQuotaClassBlock | null>(
    (candidate, block) => (!candidate || block.blocked_until_ms > candidate.blocked_until_ms ? block : candidate),
    null
  );
  const observedQuotaSignals = remaining.map((block) => block.quota_signal_observed_at_ms).filter((value): value is number => value !== null);
  const latestQuotaSignalObservedAtMs = observedQuotaSignals.length ? Math.max(...observedQuotaSignals) : slot.quota_signal_observed_at_ms;
  return {
    ...slot,
    quota_blocks_by_class: quotaBlocksByClass,
    quota_blocked_classes: Object.keys(quotaBlocksByClass),
    quota_blocked_until_ms: latest?.blocked_until_ms ?? null,
    quota_block_source: latest?.source ?? null,
    quota_signal_observed_at_ms: latestQuotaSignalObservedAtMs,
    observed_reset_at_ms: latest?.observed_reset_at_ms ?? null,
    observed_reset_at_is_stable: latest?.observed_reset_at_is_stable ?? false,
    banked_reset_generation_ambiguous: remaining.some((block) => block.banked_reset_generation_ambiguous),
    banked_reset_recovery_probe_pending: remaining.some((block) => block.banked_reset_recovery_probe_pending),
  };
};

export const recheckQuotaClasses = (slot: CodexRoutingSlot, recheckAtMs: number): CodexRoutingSlot => {
  if (Object.keys(slot.quota_blocks_by_class ?? {}).length === 0) {
    return {
      ...slot,
      // Preserve the legacy class list until a model-specific transition can
      // migrate it. Rechecking must not erase the only evidence that names
      // which old quota pool was blocked.
      quota_blocked_until_ms: slot.quota_blocked_until_ms === null ? null : recheckAtMs,
      banked_reset_generation_ambiguous: slot.quota_blocked_until_ms !== null || slot.banked_reset_generation_ambiguous,
    };
  }
  const quotaBlocksByClass = Object.fromEntries(
    Object.entries(slot.quota_blocks_by_class ?? {}).map(([key, block]) => [
      key,
      {
        ...block,
        blocked_until_ms: recheckAtMs,
        quota_signal_observed_at_ms: recheckAtMs,
        banked_reset_generation_ambiguous: true,
      },
    ])
  ) as Partial<Record<CodexQuotaClass, CodexQuotaClassBlock>>;
  const latest = Object.values(quotaBlocksByClass).reduce<CodexQuotaClassBlock | null>(
    (candidate, block) => (!candidate || block.blocked_until_ms > candidate.blocked_until_ms ? block : candidate),
    null
  );
  return {
    ...slot,
    quota_blocked_until_ms: latest?.blocked_until_ms ?? (slot.quota_blocked_until_ms ? recheckAtMs : null),
    quota_block_source: latest?.source ?? slot.quota_block_source,
    quota_blocked_classes: Object.keys(quotaBlocksByClass),
    quota_blocks_by_class: quotaBlocksByClass,
    observed_reset_at_ms: latest?.observed_reset_at_ms ?? slot.observed_reset_at_ms,
    observed_reset_at_is_stable: latest?.observed_reset_at_is_stable ?? slot.observed_reset_at_is_stable,
  };
};

export const releaseQuotaClassProbe = (slot: CodexRoutingSlot, quotaClassKey: CodexQuotaClass): CodexRoutingSlot => {
  const classAwareSlot = withLegacyQuotaClassMap(slot);
  const block = quotaBlockForClass(classAwareSlot, quotaClassKey);
  const released = withoutQuotaClass(classAwareSlot, quotaBlockKeyForClass(classAwareSlot, quotaClassKey) ?? quotaClassKey);
  if (!classAwareSlot.banked_reset_recovery_probe_pending) return released;
  return {
    ...released,
    observed_reset_at_ms: block?.observed_reset_at_ms ?? slot.observed_reset_at_ms,
    observed_reset_at_is_stable: block?.observed_reset_at_is_stable ?? slot.observed_reset_at_is_stable,
    banked_reset_generation_ambiguous: true,
    banked_reset_recovery_probe_pending: released.banked_reset_recovery_probe_pending,
  };
};

export const capacityHeadroomForObservation = (observation: CodexCapacityRoutingObservation, model: string | null): number | null => {
  const baseHeadroom = capacityHeadroomForWindows(observation.windows);
  const modelKey = normalizeQuotaLabel(model);
  if (!modelKey) return baseHeadroom;
  const modelLimits = observation.additional_rate_limits.filter((limit) => normalizeQuotaLabel(limit.limit_name) === modelKey);
  if (modelLimits.length) {
    const modelHeadrooms = modelLimits.map((limit) => capacityHeadroomForWindows(limit.windows)).filter((value): value is number => value !== null);
    return modelHeadrooms.length ? Math.max(...modelHeadrooms) : null;
  }
  return baseHeadroom;
};

const capacityHasAnyPositiveHeadroom = (observation: CodexCapacityRoutingObservation, model: string | null): boolean => {
  const headroom = capacityHeadroomForObservation(observation, model);
  return observation.state === "available" && headroom !== null && headroom > 0;
};

export const capacityObservationIsFresh = (observation: CodexCapacityRoutingObservation, now: number): boolean =>
  observation.state === "available" &&
  isSafeMs(observation.snapshot_at_ms) &&
  observation.snapshot_at_ms <= now &&
  now - observation.snapshot_at_ms <= CODEX_CAPACITY_ROUTING_MAX_AGE_MS;

const parseStoredCapacityObservation = (value: unknown): CodexCapacityRoutingObservation | null => {
  const slot = isRecord(value) && typeof value.slot === "number" && Number.isInteger(value.slot) && value.slot >= 0 && value.slot <= 1 ? value.slot : null;
  if (!isRecord(value) || slot === null) return null;
  if (typeof value.account_id_hash !== "string" || !value.account_id_hash) return null;
  const state = capacityState(value.state);
  const snapshotAtMs = isSafeMs(value.snapshot_at_ms) ? value.snapshot_at_ms : null;
  const sourceObservedAtMs =
    value.source_observed_at_ms === null || isSafeMs(value.source_observed_at_ms) ? (value.source_observed_at_ms as number | null) : null;
  const windows = isRecord(value.windows) ? value.windows : null;
  if (!state || snapshotAtMs === null || !windows) return null;
  return {
    slot,
    account_id_hash: value.account_id_hash,
    state,
    source_observed_at_ms: sourceObservedAtMs,
    snapshot_at_ms: snapshotAtMs,
    windows: {
      primary: normalizeCapacityWindow(windows.primary),
      secondary: normalizeCapacityWindow(windows.secondary),
    },
    additional_rate_limits: normalizeCapacityAdditionalRateLimits(value.additional_rate_limits),
  };
};

export const parseStoredCapacityObservationStore = (value: unknown): readonly CodexCapacityRoutingObservation[] => {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.observations)) return [];
  return value.observations.flatMap((candidate) => {
    const parsed = parseStoredCapacityObservation(candidate);
    return parsed ? [parsed] : [];
  });
};

export const mergeCapacityObservations = (...sets: readonly (readonly CodexCapacityRoutingObservation[])[]): readonly CodexCapacityRoutingObservation[] => {
  const byAccount = new Map<string, CodexCapacityRoutingObservation>();
  for (const set of sets) {
    for (const observation of set) {
      const prior = byAccount.get(observation.account_id_hash);
      if (!prior || observation.snapshot_at_ms >= prior.snapshot_at_ms) {
        byAccount.set(observation.account_id_hash, observation);
      }
    }
  }
  return [...byAccount.values()].sort((left, right) => left.slot - right.slot);
};

export const retainRecentCapacityObservations = (
  observations: readonly CodexCapacityRoutingObservation[],
  now: number
): readonly CodexCapacityRoutingObservation[] => {
  const oldestRetainedAtMs = Math.max(0, now - CODEX_CAPACITY_ROUTING_MAX_AGE_MS);
  return observations.filter((observation) => observation.snapshot_at_ms >= oldestRetainedAtMs && observation.snapshot_at_ms <= now);
};

const capacityObservedSlot = (
  current: CodexRoutingSlot,
  capacityClearedSlot: CodexRoutingSlot,
  observation: CodexCapacityRoutingObservation,
  clearCircuit: boolean
): CodexRoutingSlot => {
  const observed: CodexRoutingSlot = {
    ...capacityClearedSlot,
    primary_used_percent: observation.windows.primary?.used_percent ?? null,
    secondary_used_percent: observation.windows.secondary?.used_percent ?? null,
    capacity_observed_at_ms: observation.snapshot_at_ms,
  };
  if (!clearCircuit) return observed;
  const cleared: CodexRoutingSlot = {
    ...observed,
    account_id_hash: observation.account_id_hash,
  };
  const preserveResetSafety = current.banked_reset_generation_ambiguous || current.banked_reset_recovery_probe_pending || current.probe_lease !== null;
  if (preserveResetSafety) {
    return {
      ...cleared,
      observed_reset_at_ms: current.observed_reset_at_ms,
      observed_reset_at_is_stable: current.observed_reset_at_is_stable,
      banked_reset_generation_ambiguous: current.banked_reset_generation_ambiguous,
      banked_reset_recovery_probe_pending: current.banked_reset_recovery_probe_pending,
      probe_lease: current.probe_lease,
    };
  }
  if (Object.keys(capacityClearedSlot.quota_blocks_by_class ?? {}).length > 0) return cleared;
  return {
    ...cleared,
    observed_reset_at_ms: null,
    observed_reset_at_is_stable: false,
    banked_reset_generation_ambiguous: false,
    banked_reset_recovery_probe_pending: false,
    generation: current.generation + 1,
    probe_lease: null,
  };
};

/**
 * Materialize or reconcile the requested class block from a fresh, complete
 * capacity observation. Unlike a live 429, the usage read describes the
 * current provider window directly, so a newer exhausted sample may replace a
 * retained deadline whose identity became ambiguous. A live quota signal that
 * is newer than the sample remains authoritative.
 */
export const applyCapacityQuotaBlock = (
  state: CodexAccountRoutingState,
  account: CodexRoutingAccount,
  observation: CodexCapacityRoutingObservation,
  now: number,
  updatedAtMs: number
): CodexAccountRoutingState | null => {
  if (!capacityObservationIsFresh(observation, now)) return null;
  if (observation.slot !== account.slot || observation.account_id_hash !== account.accountIdHash) return null;
  if (capacityHeadroomForObservation(observation, account.requestedModel ?? null) !== 0) return null;
  const resetAtMs = observation.windows.primary?.reset_at_ms ?? null;
  if (!isSafeMs(resetAtMs) || resetAtMs <= now) return null;
  const current = slotFor(state, account);
  if (!slotMatchesCodexRoutingAccount(current, account) || current.probe_lease !== null) return null;
  const requestedQuotaClass = quotaClass(account.requestedModel);
  const classAwareCurrent = withLegacyQuotaClassMap(current);
  const priorBlock = quotaBlockForClass(classAwareCurrent, requestedQuotaClass);
  const priorSignalObservedAtMs = quotaSignalObservedAtForClass(classAwareCurrent, requestedQuotaClass);
  // A request that reached the provider after the sample may have established
  // a newer authoritative circuit. The older sample cannot replace it.
  if (priorSignalObservedAtMs !== null && priorSignalObservedAtMs > observation.snapshot_at_ms) return null;
  const recoveryProbePending = current.banked_reset_recovery_probe_pending || (priorBlock?.banked_reset_recovery_probe_pending ?? false);
  const nextBlock: CodexQuotaClassBlock = {
    blocked_until_ms: resetAtMs,
    source: "header_retry_after",
    legacy_fallback: false,
    quota_signal_observed_at_ms: observation.snapshot_at_ms,
    observed_reset_at_ms: resetAtMs,
    observed_reset_at_is_stable: true,
    banked_reset_generation_ambiguous: false,
    banked_reset_recovery_probe_pending: recoveryProbePending,
  };
  if (
    priorBlock?.blocked_until_ms === nextBlock.blocked_until_ms &&
    priorBlock.source === nextBlock.source &&
    priorBlock.observed_reset_at_ms === nextBlock.observed_reset_at_ms &&
    priorBlock.observed_reset_at_is_stable &&
    !priorBlock.banked_reset_generation_ambiguous &&
    priorBlock.banked_reset_recovery_probe_pending === recoveryProbePending
  )
    return null;
  const quotaBlocksByClass = {
    ...quotaBlocksIncludingLegacy(current),
    [requestedQuotaClass]: nextBlock,
  } satisfies Partial<Record<CodexQuotaClass, CodexQuotaClassBlock>>;
  const blocks = Object.values(quotaBlocksByClass);
  const latest = blocks.reduce<CodexQuotaClassBlock>(
    (candidate, block) => (block.blocked_until_ms > candidate.blocked_until_ms ? block : candidate),
    nextBlock
  );
  const observedSignals = blocks.map((block) => block.quota_signal_observed_at_ms).filter((value): value is number => value !== null);
  const latestSignalObservedAtMs = observedSignals.length ? Math.max(...observedSignals) : observation.snapshot_at_ms;
  return {
    ...state,
    updated_at_ms: updatedAtMs,
    slots: state.slots.map((slot, index) =>
      index === account.slot
        ? {
            ...current,
            account_id_hash: account.accountIdHash,
            quota_blocked_until_ms: latest.blocked_until_ms,
            quota_block_source: latest.source,
            quota_blocked_classes: Object.keys(quotaBlocksByClass),
            quota_blocks_by_class: quotaBlocksByClass,
            quota_signal_observed_at_ms: latestSignalObservedAtMs,
            observed_reset_at_ms: latest.observed_reset_at_ms,
            observed_reset_at_is_stable: latest.observed_reset_at_is_stable,
            banked_reset_generation_ambiguous: blocks.some((block) => block.banked_reset_generation_ambiguous),
            banked_reset_recovery_probe_pending: blocks.some((block) => block.banked_reset_recovery_probe_pending),
            generation: current.generation + 1,
          }
        : slot
    ),
  };
};

export const applyCapacityObservation = (
  state: CodexAccountRoutingState,
  observation: CodexCapacityRoutingObservation,
  now: number,
  model: string | null,
  updatedAtMs: number
): CodexAccountRoutingState | null => {
  if (observation.snapshot_at_ms > now) return null;
  const current = state.slots.at(observation.slot);
  if (current?.account_id_hash !== observation.account_id_hash) return null;
  if (current.capacity_observed_at_ms !== null && observation.snapshot_at_ms < current.capacity_observed_at_ms) return null;
  const fresh = capacityObservationIsFresh(observation, now);
  const capacityPositive = fresh && capacityHasAnyPositiveHeadroom(observation, model);
  const requestedQuotaClass = quotaClass(model);
  const classAwareCurrent = withLegacyQuotaClassMap(current);
  const classQuotaSignalObservedAtMs = quotaSignalObservedAtForClass(classAwareCurrent, requestedQuotaClass);
  const newerQuotaSignal = classQuotaSignalObservedAtMs !== null && classQuotaSignalObservedAtMs >= observation.snapshot_at_ms;
  const clearCircuit = capacityPositive && !newerQuotaSignal;
  const capacityClearedSlot = clearCircuit
    ? withoutQuotaClass(classAwareCurrent, quotaBlockKeyForClass(classAwareCurrent, requestedQuotaClass) ?? requestedQuotaClass)
    : current;
  const nextSlot = capacityObservedSlot(current, capacityClearedSlot, observation, clearCircuit);
  const changed = Object.keys(nextSlot).some((key) => nextSlot[key as keyof CodexRoutingSlot] !== current[key as keyof CodexRoutingSlot]);
  return changed ? withSlot(state, observation.slot, nextSlot, updatedAtMs) : null;
};

/** Merge/retention and the exact unexpired observation-store row under its native C-only revision fence. */
export const planCapacityObservationStore = (
  capacityRevision: string | null,
  durable: readonly CodexCapacityRoutingObservation[],
  observations: readonly CodexCapacityRoutingObservation[],
  now: number
) => {
  const merged = retainRecentCapacityObservations(mergeCapacityObservations(durable, observations), now);
  return {
    kind: "capacity_observations" as const,
    checks: { capacity: capacityRevision },
    writes: { capacity: { v: 1 as const, updated_at_ms: now, observations: merged } },
  };
};
