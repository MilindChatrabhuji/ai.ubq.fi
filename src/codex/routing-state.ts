// Codex account routing state: types, parsers, KV load/save and normalization, split out of src/codex_account_routing.ts.

import { isRecord } from "../utils.ts";
import type { CodexAuthState } from "../types.ts";

/**
 * Durable, slot-indexed routing state. It intentionally contains neither raw
 * account ids nor credentials; an opaque account-scope hash keeps a circuit
 * with the same account through a pool reorder without letting a replacement
 * account inherit it.
 */
export const CODEX_ACCOUNT_ROUTING_KV_KEY = ["uos_ai", "codex_account_routing", "v2"] as const;
/**
 * One opaque subscription selection shared by every ordinary Codex request.
 * It is separate from slot routing so an older quota/reset row stays intact
 * while the active account advances through the configured pool.
 */
export const CODEX_ACTIVE_ACCOUNT_SELECTION_KV_KEY = ["uos_ai", "codex_active_account", "v1"] as const;
// Keep this local to avoid a runtime import cycle with codex.ts. The public
// transport exports the same stable key for admin and test callers.
export const CODEX_AUTH_POOL_KV_KEY = ["ubq_ai", "codex_auth"] as const;
export const CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY = ["uos_ai", "codex_capacity_routing", "v1", "observations"] as const;
export const CODEX_HALF_OPEN_LEASE_MS = 30_000;
/** Keep new requests away from an account after an ambiguous response-header timeout. */
export const CODEX_UPSTREAM_TIMEOUT_CIRCUIT_MS = 60_000;
/** Capacity observations older than this cannot reopen a quota circuit. */
export const CODEX_CAPACITY_ROUTING_MAX_AGE_MS = 30 * 60_000;
// A warm isolate avoids per-request routing reads, but it must eventually
// observe circuits opened by another isolate. This bounded revalidation keeps
// normal traffic off KV while limiting cross-isolate stale routing decisions.
export const ROUTING_CACHE_REVALIDATE_MS = 5_000;

export type CodexQuotaBlockSource = "body_resets_at" | "header_retry_after";
export type CodexProbeCircuit = "quota" | "upstream_timeout";
export type CodexQuotaClass = "spark" | "gpt_oss_120b" | "reserve" | "standard" | "unknown";
/** Shared routing-state cache: the capacity and probe paths write it, selectors read it. */
export const routingStateCache: {
  state: CodexAccountRoutingState | null;
  versionstamp: string | null;
  loadedAtMs: number;
} = { state: null, versionstamp: null, loadedAtMs: 0 };

/** Accessors for the routing-state cache, which the probe and selection code shares. */
export const isCodexActiveAccountSelectionCurrent = (value: unknown, account: RoutingAccount, activeGeneration: number): boolean => {
  const active = parseCodexActiveAccountSelection(value);
  return (
    active !== null &&
    active.generation === activeGeneration &&
    active.account_id_hash === account.accountIdHash &&
    active.credential_version === account.credentialVersion &&
    active.pool_versionstamp === account.activePoolVersionstamp &&
    active.slot === account.slot &&
    active.routing_generation === account.routingGeneration
  );
};

export const setRoutingStateCache = (state: CodexAccountRoutingState | null, versionstamp?: string | null): void => {
  routingStateCache.state = state;
  routingStateCache.versionstamp = versionstamp ?? null;
  routingStateCache.loadedAtMs = Date.now();
};

export const getCachedRoutingState = (): CodexAccountRoutingState | null => routingStateCache.state;

export type CodexActiveAccountTransitionReason = "quota_exhausted" | "credential_invalid" | "account_removed_or_replaced" | "model_unavailable";

/**
 * Durable active-account admission fence. Account identifiers stay hashed and
 * a pool reorder is resolved through that identity rather than the slot alone.
 */
export type CodexActiveAccountSelection = Readonly<{
  v: 1;
  account_id_hash: string;
  credential_version: string;
  /** Versionstamp of the auth-pool snapshot that admitted this identity. */
  pool_versionstamp: string;
  slot: number;
  routing_generation: number;
  generation: number;
  /** Null denotes the initial deterministic bootstrap, not a transition. */
  transition_reason: CodexActiveAccountTransitionReason | null;
  updated_at_ms: number;
}>;

/**
 * The active-selection row exactly as one strong read observed it. A banked
 * reset binds its inventory, arming and consume fences to this snapshot --
 * including a validly absent row -- and only elects its verified account after
 * proving the snapshot was not superseded.
 */
export type CodexActiveAccountSnapshot = Readonly<{
  selection: CodexActiveAccountSelection | null;
}>;

export type CodexQuotaClassBlock = Readonly<{
  blocked_until_ms: number;
  source: CodexQuotaBlockSource;
  /** True when this entry is the synthetic fallback copied from legacy slot state. */
  legacy_fallback: boolean;
  quota_signal_observed_at_ms: number | null;
  observed_reset_at_ms: number | null;
  observed_reset_at_is_stable: boolean;
  banked_reset_generation_ambiguous: boolean;
  banked_reset_recovery_probe_pending: boolean;
}>;

export type CodexRoutingSlot = Readonly<{
  /** Opaque account-scope hash; durable state never stores a raw account id. */
  account_id_hash: string | null;
  credential_version: string;
  quota_blocked_until_ms: number | null;
  quota_block_source: CodexQuotaBlockSource | null;
  /** Separately metered model classes exhausted during the current quota circuit. */
  quota_blocked_classes?: readonly string[];
  /** Independent deadlines for each separately metered model class. */
  quota_blocks_by_class?: Readonly<Partial<Record<CodexQuotaClass, CodexQuotaClassBlock>>>;
  invalid_credential_version: string | null;
  primary_used_percent: number | null;
  secondary_used_percent: number | null;
  /** Timestamp of the newest provider quota signal written by inference. */
  quota_signal_observed_at_ms: number | null;
  /** Timestamp of the newest capacity sampler observation applied to this slot. */
  capacity_observed_at_ms: number | null;
  /** A transport timeout circuit that must not be confused with a quota reset. */
  upstream_timeout_blocked_until_ms?: number | null;
  observed_reset_at_ms: number | null;
  /** True only when the upstream supplied a canonical absolute reset deadline. */
  observed_reset_at_is_stable: boolean;
  /**
   * A stable reset deadline plus any later conflicting or relative value cannot
   * be proved to name a new provider quota generation. While it remains true,
   * ordinary routing continues but banked-reset claims fail closed and
   * existing records are lookup-only.
   */
  banked_reset_generation_ambiguous: boolean;
  /** A verified banked reset is waiting for its bounded post-reset probe. */
  banked_reset_recovery_probe_pending: boolean;
  generation: number;
  /** The circuit whose half-open request owns this lease. Missing on legacy records and normalized to quota. */
  probe_lease: Readonly<{
    token: string;
    expires_at_ms: number;
    generation: number;
    circuit: CodexProbeCircuit;
    quota_class?: CodexQuotaClass | null;
  }> | null;
}>;

export type CodexAccountRoutingState = Readonly<{
  v: 2;
  updated_at_ms: number;
  /** A pre-account-hash stable identity could not be matched to a current account. */
  banked_reset_legacy_identity_unresolved: boolean;
  slots: readonly CodexRoutingSlot[];
}>;

export type RoutingAccount = Readonly<{
  auth: CodexAuthState;
  slot: number;
  /** Opaque account-scope hash used only to keep durable slots attached to an account across reordering. */
  accountIdHash: string;
  credentialVersion: string;
  quotaHeadroom: number | null;
  probeRequired: boolean;
  probeGeneration: number | null;
  probeToken: string | null;
  /** Circuit selected for a pending half-open probe. */
  probeCircuit?: CodexProbeCircuit | null;
  /**
   * Set only for the one bounded overage attempt that follows a blocked cohort
   * proving no redeemable credit. The probe-claim allowance honors it for that
   * attempt alone; it is never persisted.
   */
  overageFallback?: boolean;
  /** Durable routing generation observed when this account was selected. */
  routingGeneration?: number;
  /** Global active-account generation that admitted this request. */
  activeGeneration?: number;
  /** Auth-pool versionstamp bound to the active admission. */
  activePoolVersionstamp?: string;
  /** Last durable reason that moved the active selection. */
  activeTransitionReason?: CodexActiveAccountTransitionReason | null;
  /** Exact incoming model id used to keep separately metered pools independent. */
  requestedModel?: string | null;
}>;

export type CodexCapacityRoutingWindow = Readonly<{
  limit_window_seconds: number | null;
  used_percent: number | null;
  reset_at_ms: number | null;
}>;

export type CodexCapacityRoutingAdditionalRateLimit = Readonly<{
  limit_name: string;
  metered_feature: string | null;
  windows: Readonly<{
    primary: CodexCapacityRoutingWindow | null;
    secondary: CodexCapacityRoutingWindow | null;
  }>;
}>;

/**
 * Control-plane input only. `account_id` is hashed before it enters durable
 * routing state; the dashboard and observation record never contain it.
 * `slot` is zero-based, matching the routing state slot index.
 */
export type CodexCapacityRoutingObservationInput = Readonly<{
  slot: number;
  account_id: string;
  state: "available" | "stale" | "unavailable";
  source_observed_at_ms: number | null;
  snapshot_at_ms: number;
  windows: Readonly<{
    primary: CodexCapacityRoutingWindow | null;
    secondary: CodexCapacityRoutingWindow | null;
  }>;
  additional_rate_limits: readonly CodexCapacityRoutingAdditionalRateLimit[];
}>;

export type CodexCapacityRoutingObservation = Readonly<{
  slot: number;
  account_id_hash: string;
  state: "available" | "stale" | "unavailable";
  source_observed_at_ms: number | null;
  snapshot_at_ms: number;
  windows: Readonly<{
    primary: CodexCapacityRoutingWindow | null;
    secondary: CodexCapacityRoutingWindow | null;
  }>;
  additional_rate_limits: readonly CodexCapacityRoutingAdditionalRateLimit[];
}>;

/** A durable provider-deadline circuit that may have an existing reset record to reconcile. */
export type CodexBlockedRoutingAccount = RoutingAccount &
  Readonly<{
    quotaResetAtMs: number;
    routingGeneration: number;
  }>;

export type RouteSelection =
  | Readonly<{
      kind: "eligible";
      accounts: readonly RoutingAccount[];
      skippedSlots: readonly number[];
      /** Stable absolute quota fences omitted from ordinary eligible routing. */
      blockedAccounts: readonly CodexBlockedRoutingAccount[];
    }>
  | Readonly<{
      kind: "quota_blocked";
      skippedSlots: readonly number[];
      retryAtMs: number | null;
      /** Stable absolute quota fences omitted from ordinary eligible routing. */
      blockedAccounts: readonly CodexBlockedRoutingAccount[];
      /**
       * Every current pool account proved authoritative applicable quota or
       * capacity exhaustion. Credential failures never authorize quota resets.
       */
      fullCohortExhausted: boolean;
      /** Every current subscription is quota-exhausted or has invalid current credentials. */
      fullCohortUnavailable?: boolean;
      /** The active-selection row exactly as this strong read observed it. */
      activeSnapshot: CodexActiveAccountSnapshot;
      /**
       * Canonical strong-read snapshots for pre-election reset fences. Ordered
       * pool membership, credential material, pool update identity, and the
       * stored capacity observations must all stay exactly as observed through
       * inventory, arming and consume.
       */
      poolSnapshotJson: string | null;
      capacitySnapshotJson: string | null;
    }>
  | Readonly<{
      kind: "upstream_blocked";
      skippedSlots: readonly number[];
      retryAtMs: number | null;
      blockedAccounts: readonly [];
    }>
  | Readonly<{
      /**
       * No configured account can serve the named model. This is neither a
       * quota nor a credential outcome: no fence was written, so the request is
       * answered as an unavailable model rather than a retryable failure.
       */
      kind: "model_unavailable";
      model: string;
      /** Upstream's own detail text when a live rejection was observed. */
      detail: string | null;
      skippedSlots: readonly number[];
    }>
  | Readonly<{ kind: "credentials_invalid"; skippedSlots: readonly number[]; fullCohortUnavailable?: boolean }>
  | Readonly<{ kind: "routing_unavailable" }>;

export const isSafeMs = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const isLegacyStableResetIdentity = (slot: CodexRoutingSlot): boolean =>
  slot.account_id_hash === null && slot.observed_reset_at_ms !== null && slot.observed_reset_at_is_stable;

export const hasUnresolvedLegacyResetIdentity = (state: CodexAccountRoutingState | null): boolean =>
  state?.banked_reset_legacy_identity_unresolved === true || state?.slots.some(isLegacyStableResetIdentity) === true;

const quotaClassBlockFieldsMatch = (left: Record<string, unknown>, right: Record<string, unknown>): boolean =>
  left.blocked_until_ms === right.blocked_until_ms &&
  left.source === right.source &&
  left.quota_signal_observed_at_ms === right.quota_signal_observed_at_ms &&
  left.observed_reset_at_ms === right.observed_reset_at_ms &&
  left.observed_reset_at_is_stable === right.observed_reset_at_is_stable &&
  left.banked_reset_generation_ambiguous === right.banked_reset_generation_ambiguous &&
  left.banked_reset_recovery_probe_pending === right.banked_reset_recovery_probe_pending;

/**
 * The previous class-migration release copied an unclassified slot fence into
 * every class, including `unknown`, without a marker. Recognize that exact
 * all-class shape so a later class recovery does not retain a synthetic
 * fallback forever. Explicitly marked entries are always authoritative.
 */
const hasUnmarkedSyntheticLegacyUnknown = (rawClassBlocks: Record<string, unknown>): boolean => {
  const unknown = rawClassBlocks.unknown;
  if (!isRecord(unknown) || "legacy_fallback" in unknown) return false;
  // This detects the shape one historical release wrote, so it stays the four
  // entries of that release; `reserve` did not exist then.
  const knownClassKeys = ["spark", "gpt_oss_120b", "standard"] as const;
  if (
    !knownClassKeys.every((key) => {
      const candidate = rawClassBlocks[key];
      return isRecord(candidate) && !("legacy_fallback" in candidate);
    })
  )
    return false;
  // The preceding migration copied one unmarked block into all four entries.
  // Require every known entry to retain that exact shape; one matching class
  // is not enough because independent 429s can share a deadline by chance.
  return knownClassKeys.every((key) => {
    const candidate = rawClassBlocks[key];
    return isRecord(candidate) && quotaClassBlockFieldsMatch(candidate, unknown);
  });
};

/**
 * A missing or unrecognized probe circuit is the legacy representation of a
 * quota probe. An explicitly unrecognized value still fails the whole slot.
 */
const parseProbeLeaseCircuit = (lease: unknown): CodexProbeCircuit | null => {
  if (lease === null || !isRecord(lease) || lease.circuit === undefined) return "quota";
  if (lease.circuit === "quota" || lease.circuit === "upstream_timeout") return lease.circuit;
  return null;
};

const parseProbeQuotaClass = (value: unknown): CodexQuotaClass | null =>
  value === "spark" || value === "gpt_oss_120b" || value === "reserve" || value === "standard" || value === "unknown" ? value : null;

const parseProbeLease = (lease: unknown, leaseCircuit: CodexProbeCircuit | null): CodexRoutingSlot["probe_lease"] => {
  if (lease === null || !isRecord(lease)) return null;
  if (
    typeof lease.token !== "string" ||
    !isSafeMs(lease.expires_at_ms) ||
    typeof lease.generation !== "number" ||
    !Number.isSafeInteger(lease.generation) ||
    leaseCircuit === null
  ) {
    return null;
  }
  return {
    token: lease.token,
    expires_at_ms: lease.expires_at_ms,
    generation: lease.generation,
    circuit: leaseCircuit,
    quota_class: parseProbeQuotaClass(lease.quota_class),
  };
};

/** `null`, `undefined` and every non-canonical value mean "no absolute deadline was persisted". */
export const parseOptionalSafeMs = (value: unknown): number | null => (isSafeMs(value) ? value : null);

/** `undefined` marks an unrecognized value, which fails the slot it was read from. */
const parseQuotaBlockSource = (value: unknown): CodexQuotaBlockSource | null | undefined => {
  if (value === null) return null;
  if (value === "body_resets_at" || value === "header_retry_after") return value;
  return undefined;
};

const parseStoredGeneration = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

const parseStoredPercent = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const parseAccountIdHash = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const parseQuotaBlockedClasses = (value: unknown): readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...new Set(value as string[])] : [];

/** The slot-wide reset fields a per-class block may inherit when it shares the slot deadline. */
type CodexSlotClassBlockFields = Readonly<{
  observedResetAtMs: number | null;
  observedResetAtIsStable: boolean;
  bankedResetGenerationAmbiguous: boolean;
  bankedResetRecoveryProbePending: boolean;
}>;

const parseSlotClassBlock = (
  block: Record<string, unknown>,
  quotaClassKey: CodexQuotaClass,
  unmarkedSyntheticLegacyUnknown: boolean,
  slotFields: CodexSlotClassBlockFields
): CodexQuotaClassBlock | null => {
  if (!isSafeMs(block.blocked_until_ms)) return null;
  if (block.source !== "body_resets_at" && block.source !== "header_retry_after") return null;
  // A class block that shares the slot-wide deadline inherits that deadline's
  // reset identity; an independent block keeps only the identity it stored.
  const sharesSlotDeadline = block.blocked_until_ms === slotFields.observedResetAtMs;
  let observedResetAtMs: number | null = null;
  if (isSafeMs(block.observed_reset_at_ms)) {
    observedResetAtMs = block.observed_reset_at_ms;
  } else if (sharesSlotDeadline && slotFields.observedResetAtIsStable) {
    observedResetAtMs = slotFields.observedResetAtMs;
  }
  return {
    blocked_until_ms: block.blocked_until_ms,
    source: block.source,
    legacy_fallback: block.legacy_fallback === true || (quotaClassKey === "unknown" && unmarkedSyntheticLegacyUnknown),
    quota_signal_observed_at_ms: isSafeMs(block.quota_signal_observed_at_ms) ? block.quota_signal_observed_at_ms : null,
    observed_reset_at_ms: observedResetAtMs,
    observed_reset_at_is_stable: block.observed_reset_at_is_stable === true || (sharesSlotDeadline && slotFields.observedResetAtIsStable),
    banked_reset_generation_ambiguous: block.banked_reset_generation_ambiguous === true || (sharesSlotDeadline && slotFields.bankedResetGenerationAmbiguous),
    banked_reset_recovery_probe_pending:
      block.banked_reset_recovery_probe_pending === true || (sharesSlotDeadline && slotFields.bankedResetRecoveryProbePending),
  };
};

const parseQuotaBlocksByClass = (
  rawClassBlocks: Record<string, unknown>,
  unmarkedSyntheticLegacyUnknown: boolean,
  slotFields: CodexSlotClassBlockFields
): Partial<Record<CodexQuotaClass, CodexQuotaClassBlock>> => {
  const quotaBlocksByClass: Partial<Record<CodexQuotaClass, CodexQuotaClassBlock>> = {};
  for (const quotaClassKey of ["spark", "gpt_oss_120b", "reserve", "standard", "unknown"] as const) {
    const block = rawClassBlocks[quotaClassKey];
    if (!isRecord(block)) continue;
    const parsedBlock = parseSlotClassBlock(block, quotaClassKey, unmarkedSyntheticLegacyUnknown, slotFields);
    if (parsedBlock) quotaBlocksByClass[quotaClassKey] = parsedBlock;
  }
  return quotaBlocksByClass;
};

/**
 * The exact pre-account-hash slot shape: every field is absent or neutral, so
 * the parser's synthetic ambiguity may be treated as inherited rather than
 * observed. Any other record keeps the fail-closed default.
 */
const isExactLegacyNeutralSlot = (value: Record<string, unknown>, source: CodexQuotaBlockSource | null, lease: unknown): boolean =>
  !("account_id_hash" in value) &&
  !("observed_reset_at_is_stable" in value) &&
  !("banked_reset_generation_ambiguous" in value) &&
  value.generation === 0 &&
  value.quota_blocked_until_ms === null &&
  source === null &&
  value.invalid_credential_version === null &&
  value.primary_used_percent === null &&
  value.secondary_used_percent === null &&
  value.observed_reset_at_ms === null &&
  lease === null;

/**
 * The first body-derived fence written after an exact legacy-neutral slot
 * inherited the old parser's synthetic ambiguity. Generation one proves there
 * was no prior quota transition; every real revision, recheck, credential
 * rotation, or recovery transition increments it again.
 */
const isLegacyNeutralFirstBodyFence = (
  value: Record<string, unknown>,
  fields: Readonly<{
    accountIdHash: string | null;
    quotaBlockedUntilMs: number | null;
    observedResetAtMs: number | null;
    observedResetAtIsStable: boolean;
    source: CodexQuotaBlockSource | null;
    lease: unknown;
  }>
): boolean =>
  value.banked_reset_generation_ambiguous === true &&
  value.generation === 1 &&
  fields.accountIdHash !== null &&
  fields.source === "body_resets_at" &&
  fields.quotaBlockedUntilMs !== null &&
  fields.observedResetAtMs === fields.quotaBlockedUntilMs &&
  fields.observedResetAtIsStable &&
  fields.lease === null &&
  value.invalid_credential_version === null;

const repairedBankedResetGenerationAmbiguous = (
  value: Record<string, unknown>,
  exactLegacyNeutralSlot: boolean,
  legacyNeutralFirstBodyFence: boolean
): boolean => (exactLegacyNeutralSlot || legacyNeutralFirstBodyFence ? false : value.banked_reset_generation_ambiguous !== false);

const parseSlot = (value: unknown, allowLegacyNeutralRepair: boolean): CodexRoutingSlot | null => {
  if (!isRecord(value) || typeof value.credential_version !== "string") return null;
  const credentialVersion = value.credential_version;
  const source = parseQuotaBlockSource(value.quota_block_source);
  if (source === undefined) return null;
  const lease = value.probe_lease;
  const leaseCircuit = parseProbeLeaseCircuit(lease);
  const parsedLease = parseProbeLease(lease, leaseCircuit);
  if (lease !== null && !parsedLease) return null;
  const accountIdHash = parseAccountIdHash(value.account_id_hash);
  const quotaBlockedUntilMs = parseOptionalSafeMs(value.quota_blocked_until_ms);
  const invalidCredentialVersion = typeof value.invalid_credential_version === "string" ? value.invalid_credential_version : null;
  const observedResetAtMs = parseOptionalSafeMs(value.observed_reset_at_ms);
  const quotaSignalObservedAtMs = parseOptionalSafeMs(value.quota_signal_observed_at_ms);
  const capacityObservedAtMs = parseOptionalSafeMs(value.capacity_observed_at_ms);
  const upstreamTimeoutBlockedUntilMs = parseOptionalSafeMs(value.upstream_timeout_blocked_until_ms);
  const observedResetAtIsStable = value.observed_reset_at_is_stable === true;
  const generation = parseStoredGeneration(value.generation);
  const isExactLegacyNeutralSlotRepair = allowLegacyNeutralRepair && isExactLegacyNeutralSlot(value, source, lease);
  const isLegacyNeutralFirstBodyFenceRepair =
    allowLegacyNeutralRepair &&
    isLegacyNeutralFirstBodyFence(value, {
      accountIdHash,
      quotaBlockedUntilMs,
      observedResetAtMs,
      observedResetAtIsStable,
      source,
      lease,
    });
  const bankedResetGenerationAmbiguous = repairedBankedResetGenerationAmbiguous(value, isExactLegacyNeutralSlotRepair, isLegacyNeutralFirstBodyFenceRepair);
  const bankedResetRecoveryProbePending = value.banked_reset_recovery_probe_pending === true;
  const quotaBlockedClasses = parseQuotaBlockedClasses(value.quota_blocked_classes);
  const rawClassBlocks = isRecord(value.quota_blocks_by_class) ? value.quota_blocks_by_class : {};
  const unmarkedSyntheticLegacyUnknown = hasUnmarkedSyntheticLegacyUnknown(rawClassBlocks);
  const quotaBlocksByClass = parseQuotaBlocksByClass(rawClassBlocks, unmarkedSyntheticLegacyUnknown, {
    observedResetAtMs,
    observedResetAtIsStable,
    bankedResetGenerationAmbiguous,
    bankedResetRecoveryProbePending,
  });
  return {
    account_id_hash: accountIdHash,
    credential_version: credentialVersion,
    quota_blocked_until_ms: quotaBlockedUntilMs,
    quota_block_source: source,
    quota_blocked_classes: quotaBlockedClasses,
    quota_blocks_by_class: quotaBlocksByClass,
    invalid_credential_version: invalidCredentialVersion,
    primary_used_percent: parseStoredPercent(value.primary_used_percent),
    secondary_used_percent: parseStoredPercent(value.secondary_used_percent),
    quota_signal_observed_at_ms: quotaSignalObservedAtMs,
    capacity_observed_at_ms: capacityObservedAtMs,
    upstream_timeout_blocked_until_ms: upstreamTimeoutBlockedUntilMs,
    observed_reset_at_ms: observedResetAtMs,
    // Older routing records did not carry this flag. Treat their header
    // deadline as unsuitable for an expensive reset rather than guessing its
    // identity from a relative timeout.
    observed_reset_at_is_stable: observedResetAtIsStable,
    // A record written before this fence cannot prove that its deadline was
    // never revised. The two exact legacy-contamination repairs above are the
    // only exceptions; every other old or malformed record remains fail closed.
    banked_reset_generation_ambiguous: bankedResetGenerationAmbiguous,
    banked_reset_recovery_probe_pending: bankedResetRecoveryProbePending,
    generation,
    probe_lease: parsedLease,
  };
};

export const parseCodexAccountRoutingState = (value: unknown): CodexAccountRoutingState | null => {
  if (!isRecord(value) || value.v !== 2 || !isSafeMs(value.updated_at_ms) || !Array.isArray(value.slots)) return null;
  const legacyIdentityUnresolved = value.banked_reset_legacy_identity_unresolved === true;
  const slots = value.slots.map((slot) => parseSlot(slot, !legacyIdentityUnresolved));
  if (slots.some((slot) => !slot)) return null;
  return {
    v: 2,
    updated_at_ms: value.updated_at_ms,
    // The field is deliberately opt-in here: normalization can still attach a
    // legacy stable identity when its credential version proves the account.
    // Exact reset fences independently reject any un-hashed stable slot.
    banked_reset_legacy_identity_unresolved: legacyIdentityUnresolved,
    slots: slots as CodexRoutingSlot[],
  };
};

const isOpaqueHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export const isVersionstamp = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

const parseActiveTransitionReason = (value: unknown): CodexActiveAccountTransitionReason | null | undefined => {
  if (value === null) return null;
  if (value === "quota_exhausted" || value === "credential_invalid" || value === "account_removed_or_replaced" || value === "model_unavailable") return value;
  return undefined;
};

/** Invalid active rows fail closed; only an absent row is a bootstrap case. */
export const parseCodexActiveAccountSelection = (value: unknown): CodexActiveAccountSelection | null => {
  if (!isRecord(value) || value.v !== 1) return null;
  const transitionReason = parseActiveTransitionReason(value.transition_reason);
  const slot = value.slot;
  const routingGeneration = value.routing_generation;
  const generation = value.generation;
  if (
    !isOpaqueHash(value.account_id_hash) ||
    !isOpaqueHash(value.credential_version) ||
    !isVersionstamp(value.pool_versionstamp) ||
    typeof slot !== "number" ||
    !Number.isSafeInteger(slot) ||
    slot < 0 ||
    typeof routingGeneration !== "number" ||
    !Number.isSafeInteger(routingGeneration) ||
    routingGeneration < 0 ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    transitionReason === undefined ||
    !isSafeMs(value.updated_at_ms)
  )
    return null;
  return {
    v: 1,
    account_id_hash: value.account_id_hash,
    credential_version: value.credential_version,
    pool_versionstamp: value.pool_versionstamp,
    slot,
    routing_generation: routingGeneration,
    generation,
    transition_reason: transitionReason,
    updated_at_ms: value.updated_at_ms,
  };
};

/** Exact active-generation fence used by reset recovery and final dispatch. */
