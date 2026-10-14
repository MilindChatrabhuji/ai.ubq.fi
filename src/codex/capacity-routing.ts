import type { AtomicOperation, Kv } from "#kv";
// Codex capacity-routing observations, windows and persistence, split out of src/codex_account_routing.ts.

import { getKv } from "../kv.ts";
import { PROVIDER_CAPACITY_SNAPSHOT_KEY } from "../provider/capacity-contract.ts";
import { isRecord, sha256Hex } from "../utils.ts";
import { type CodexAuthPoolState, type CodexAuthState } from "../types.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_CAPACITY_ROUTING_MAX_AGE_MS,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  type CodexAccountRoutingState,
  type CodexCapacityRoutingAdditionalRateLimit,
  type CodexCapacityRoutingObservation,
  type CodexCapacityRoutingObservationInput,
  type CodexCapacityRoutingWindow,
  type CodexProbeCircuit,
  type CodexQuotaClass,
  type CodexQuotaClassBlock,
  type CodexRoutingSlot,
  ROUTING_CACHE_REVALIDATE_MS,
  type RoutingAccount,
  isLegacyStableResetIdentity,
  isSafeMs,
  parseCodexAccountRoutingState,
  parseOptionalSafeMs,
  routingStateCache,
} from "./routing-state.ts";

export const codexCredentialVersion = async (auth: CodexAuthState): Promise<string> =>
  await sha256Hex(`${auth.account_id}\u0000${auth.access_token}\u0000${auth.refresh_token}`);

const codexRoutingAccountIdHashForId = async (accountId: string): Promise<string> => await sha256Hex(`uos_ai\u0000codex_routing_account\u0000${accountId}`);

const codexRoutingAccountIdHash = async (auth: CodexAuthState): Promise<string> => await codexRoutingAccountIdHashForId(auth.account_id);

type CodexRoutingAccountIdentity = Readonly<{
  accountIdHash: string;
  credentialVersion: string;
}>;

export const routingAccountIdentity = async (auth: CodexAuthState): Promise<CodexRoutingAccountIdentity> => {
  const [accountIdHash, credentialVersion] = await Promise.all([codexRoutingAccountIdHash(auth), codexCredentialVersion(auth)]);
  return { accountIdHash, credentialVersion };
};

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

const withoutLegacyTimeoutCircuits = (state: CodexAccountRoutingState): CodexAccountRoutingState => {
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

export const normalizeRoutingState = async (
  raw: CodexAccountRoutingState | null,
  pool: CodexAuthPoolState,
  now = Date.now(),
  discardLegacyTimeoutCircuit = false
): Promise<CodexAccountRoutingState> => {
  const identities = await Promise.all(pool.accounts.map(routingAccountIdentity));
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

// `undefined` means this isolate only has synthesized/local state, so it
// must refresh before attempting a durable compare-and-set. `null` is a real
// KV versionstamp for an absent routing record and is safe to check directly.

let cachedCapacityObservations: readonly CodexCapacityRoutingObservation[] = [];
let cachedCapacityObservationsLoadedAtMs = 0;

export const resetCodexAccountRoutingForTest = (): void => {
  routingStateCache.state = null;
  routingStateCache.versionstamp = null;
  routingStateCache.loadedAtMs = 0;
  cachedCapacityObservations = [];
  cachedCapacityObservationsLoadedAtMs = 0;
};

/** Loads routing alongside a cold auth read.  KV failure deliberately fails open. */
export const loadCodexAccountRouting = async (pool: CodexAuthPoolState): Promise<CodexAccountRoutingState> => {
  if (routingStateCache.state && Date.now() - routingStateCache.loadedAtMs < ROUTING_CACHE_REVALIDATE_MS) {
    const normalized = await normalizeRoutingState(routingStateCache.state, pool);
    // `normalizeRoutingState` preserves matching slot references, so this is
    // a cheap way to spot an auth-pool rotation without persisting anything
    // until a later routing transition actually needs to write it.
    const cached = routingStateCache.state;
    const routingStateChanged =
      normalized.banked_reset_legacy_identity_unresolved !== cached.banked_reset_legacy_identity_unresolved ||
      normalized.slots.length !== cached.slots.length ||
      normalized.slots.some((slot, index) => slot !== cached.slots[index]);
    if (routingStateChanged) routingStateCache.state = normalized;
    return routingStateCache.state;
  }
  try {
    const kv = await getKv();
    if (!kv) {
      const normalized = await normalizeRoutingState(routingStateCache.state, pool);
      routingStateCache.state = normalized;
      routingStateCache.versionstamp = null;
      routingStateCache.loadedAtMs = Date.now();
      return normalized;
    }
    const entry = await kv.get<CodexAccountRoutingState>(CODEX_ACCOUNT_ROUTING_KV_KEY, { consistency: "strong" });
    routingStateCache.state = await normalizeRoutingState(parseCodexAccountRoutingState(entry.value), pool, Date.now(), true);
    routingStateCache.versionstamp = entry.versionstamp;
    routingStateCache.loadedAtMs = Date.now();
    return routingStateCache.state;
  } catch {
    const normalized = await normalizeRoutingState(routingStateCache.state, pool);
    routingStateCache.state = normalized;
    routingStateCache.versionstamp = null;
    routingStateCache.loadedAtMs = Date.now();
    return normalized;
  }
};

type CodexRoutingTransform = (state: CodexAccountRoutingState) => CodexAccountRoutingState | null;

/**
 * Commit a checked transition and refresh this isolate's cache. `null` means the
 * compare-and-set lost the race, so the caller must re-read the durable record
 * before retrying.
 */
const commitRoutingCandidate = async (operation: AtomicOperation, next: CodexAccountRoutingState): Promise<CodexAccountRoutingState | null> => {
  const committed = await operation.set(CODEX_ACCOUNT_ROUTING_KV_KEY, next).commit();
  if (!committed.ok) return null;
  routingStateCache.state = next;
  routingStateCache.versionstamp = committed.versionstamp;
  routingStateCache.loadedAtMs = Date.now();
  return next;
};

/** Every attempt re-reads the committed row before its compare-and-set. */
const commitRoutingTransitionWithStrongRead = async (kv: Kv, transform: CodexRoutingTransform): Promise<CodexAccountRoutingState | null> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await kv.get<CodexAccountRoutingState>(CODEX_ACCOUNT_ROUTING_KV_KEY, { consistency: "strong" });
    const durable = parseCodexAccountRoutingState(entry.value);
    const rawBase = durable ?? routingStateCache.state;
    const base = rawBase ? withoutLegacyTimeoutCircuits(rawBase) : null;
    if (!base) return null;
    const next = transform(base);
    if (!next) {
      routingStateCache.state = base;
      routingStateCache.versionstamp = entry.versionstamp;
      routingStateCache.loadedAtMs = Date.now();
      return base;
    }
    const committed = await commitRoutingCandidate(kv.atomic().check(entry), next);
    if (committed !== null) return committed;
  }
  return null;
};

/**
 * Apply a small state transition against the latest durable record. This is
 * deliberately compare-and-set rather than a blind `set`: independent slot
 * transitions must not erase each other when different isolates observe
 * failures at the same time.
 */
export const updateRoutingState = async (transform: CodexRoutingTransform): Promise<CodexAccountRoutingState | null> => {
  const applyLocally = (): CodexAccountRoutingState | null => {
    if (!routingStateCache.state) return null;
    const current = withoutLegacyTimeoutCircuits(routingStateCache.state);
    const next = transform(current);
    if (next) {
      routingStateCache.state = next;
      // The local update was not committed, so its old versionstamp can no
      // longer safely authorize a future write.
      routingStateCache.versionstamp = null;
      routingStateCache.loadedAtMs = Date.now();
    } else if (current !== routingStateCache.state) {
      routingStateCache.state = current;
      routingStateCache.versionstamp = null;
      routingStateCache.loadedAtMs = Date.now();
    }
    return next ?? routingStateCache.state;
  };

  let kv: Kv | null;
  try {
    kv = await getKv();
  } catch {
    return applyLocally();
  }
  if (!kv) return applyLocally();

  // A cold auth hydration already obtained this record. Reuse that
  // versionstamp for the first transition instead of paying a second routing
  // read on a request that just received a 401/429. A concurrent writer makes
  // this CAS fail, after which the strong-read retry below preserves its work.
  const cachedStamp = routingStateCache.versionstamp;
  if (routingStateCache.state && cachedStamp !== null) {
    const current = withoutLegacyTimeoutCircuits(routingStateCache.state);
    const next = transform(current);
    if (!next) {
      routingStateCache.state = current;
      return current;
    }
    try {
      const committed = await commitRoutingCandidate(kv.atomic().check({ key: CODEX_ACCOUNT_ROUTING_KV_KEY, versionstamp: cachedStamp }), next);
      if (committed !== null) return committed;
    } catch {
      return applyLocally();
    }
  }

  try {
    return await commitRoutingTransitionWithStrongRead(kv, transform);
  } catch {
    return applyLocally();
  }
};

/** Routing state reads and writes fail closed when the KV binding itself is unavailable. */
export const openRoutingKv = async (): Promise<Kv | null> => {
  try {
    return await getKv();
  } catch {
    return null;
  }
};

export const slotFor = (state: CodexAccountRoutingState, account: RoutingAccount): CodexRoutingSlot =>
  state.slots[account.slot] ?? neutralSlot(account.credentialVersion, account.accountIdHash);

export const slotMatchesRoutingAccount = (slot: CodexRoutingSlot, account: RoutingAccount): boolean =>
  slot.credential_version === account.credentialVersion &&
  // Exact credential-version equality is the legacy proof of account scope;
  // every successful transition writes the opaque account hash immediately.
  (slot.account_id_hash === account.accountIdHash || slot.account_id_hash === null);

export const routingProbeCircuit = (account: RoutingAccount): CodexProbeCircuit => account.probeCircuit ?? "quota";

/**
 * A lease matches only when its token, generation, circuit and (for the quota
 * circuit) model class all belong to this account's claim.
 */
export const probeLeaseMatchesRoutingAccount = (slot: CodexRoutingSlot, account: RoutingAccount): boolean => {
  const lease = slot.probe_lease;
  if (account.probeGeneration === null || lease === null) return false;
  if (slot.generation !== account.probeGeneration) return false;
  if (lease.generation !== account.probeGeneration || lease.token !== account.probeToken) return false;
  if (lease.circuit !== routingProbeCircuit(account)) return false;
  if (routingProbeCircuit(account) !== "quota") return true;
  return lease.quota_class === null || lease.quota_class === undefined || lease.quota_class === quotaClass(account.requestedModel);
};

export const withSlot = (state: CodexAccountRoutingState, index: number, slot: CodexRoutingSlot): CodexAccountRoutingState => {
  const slots = [...state.slots];
  while (slots.length <= index) slots.push(neutralSlot(slot.credential_version, slot.account_id_hash));
  slots[index] = slot;
  return { ...state, updated_at_ms: Date.now(), slots };
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

const normalizeCapacityWindow = (value: unknown): CodexCapacityRoutingWindow | null => {
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

const normalizeCapacityAdditionalRateLimits = (value: unknown): readonly CodexCapacityRoutingAdditionalRateLimit[] =>
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

const capacityObservationFromInput = async (input: CodexCapacityRoutingObservationInput): Promise<CodexCapacityRoutingObservation | null> => {
  if (
    !Number.isInteger(input.slot) ||
    input.slot < 0 ||
    input.slot > 1 ||
    typeof input.account_id !== "string" ||
    !input.account_id.trim() ||
    !isSafeMs(input.snapshot_at_ms)
  )
    return null;
  const state = capacityState(input.state);
  if (!state) return null;
  const sourceObservedAtMs = input.source_observed_at_ms === null || isSafeMs(input.source_observed_at_ms) ? input.source_observed_at_ms : null;
  const accountIdHash = await codexRoutingAccountIdHashForId(input.account_id.trim());
  return {
    slot: input.slot,
    account_id_hash: accountIdHash,
    state,
    source_observed_at_ms: sourceObservedAtMs,
    snapshot_at_ms: input.snapshot_at_ms,
    windows: {
      primary: normalizeCapacityWindow(input.windows.primary),
      secondary: normalizeCapacityWindow(input.windows.secondary),
    },
    additional_rate_limits: normalizeCapacityAdditionalRateLimits(input.additional_rate_limits),
  };
};

const mergeCapacityObservations = (...sets: readonly (readonly CodexCapacityRoutingObservation[])[]): readonly CodexCapacityRoutingObservation[] => {
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

const retainRecentCapacityObservations = (
  observations: readonly CodexCapacityRoutingObservation[],
  now: number
): readonly CodexCapacityRoutingObservation[] => {
  const oldestRetainedAtMs = Math.max(0, now - CODEX_CAPACITY_ROUTING_MAX_AGE_MS);
  return observations.filter((observation) => observation.snapshot_at_ms >= oldestRetainedAtMs && observation.snapshot_at_ms <= now);
};

/**
 * One legacy snapshot source, re-expressed as an account-hash-bound observation.
 * A source without a usable state, window set or snapshot timestamp is dropped
 * rather than guessed at.
 */
const legacyCapacityObservationForSlot = async (
  pool: CodexAuthPoolState,
  source: Record<string, unknown>,
  slot: number,
  fallbackSnapshotAtMs: number
): Promise<CodexCapacityRoutingObservation | null> => {
  const state = capacityState(source.state);
  const sourceSnapshotAtMs = isSafeMs(source.snapshot_at_ms) ? source.snapshot_at_ms : fallbackSnapshotAtMs;
  const windows = isRecord(source.windows) ? source.windows : null;
  if (!state || !windows || !isSafeMs(sourceSnapshotAtMs)) return null;
  const slotAccount = pool.accounts.at(slot);
  if (!slotAccount) return null;
  return {
    slot,
    account_id_hash: await codexRoutingAccountIdHashForId(slotAccount.account_id),
    state,
    source_observed_at_ms: parseOptionalSafeMs(source.source_observed_at_ms),
    snapshot_at_ms: sourceSnapshotAtMs,
    windows: {
      primary: normalizeCapacityWindow(windows.primary),
      secondary: normalizeCapacityWindow(windows.secondary),
    },
    additional_rate_limits: normalizeCapacityAdditionalRateLimits(source.additional_rate_limits),
  };
};

const readLegacyProviderCapacityObservations = async (pool: CodexAuthPoolState, kv: Kv): Promise<readonly CodexCapacityRoutingObservation[]> => {
  try {
    const entry = await kv.get(PROVIDER_CAPACITY_SNAPSHOT_KEY, { consistency: "strong" });
    const value = entry.value;
    if (!isRecord(value) || !isSafeMs(value.snapshot_at_ms) || !Array.isArray(value.sources)) return [];
    // A slot-only snapshot is safe to reuse only when the auth pool existed no
    // later than the sample. New observations are account-hash bound; this
    // guard is the migration boundary for snapshots written before that key.
    if (!isSafeMs(pool.updated_at_ms) || pool.updated_at_ms > value.snapshot_at_ms) return [];
    const snapshotAtMs = value.snapshot_at_ms;
    const observations: CodexCapacityRoutingObservation[] = [];
    for (let slot = 0; slot < Math.min(2, pool.accounts.length); slot += 1) {
      const source = value.sources.find((candidate) => isRecord(candidate) && candidate.source === "codex" && candidate.slot === slot + 1);
      if (!isRecord(source)) continue;
      const observation = await legacyCapacityObservationForSlot(pool, source, slot, snapshotAtMs);
      if (observation) observations.push(observation);
    }
    return observations;
  } catch {
    return [];
  }
};

export const loadCodexCapacityRoutingObservations = async (pool: CodexAuthPoolState, forceKv = false): Promise<readonly CodexCapacityRoutingObservation[]> => {
  const now = Date.now();
  if (!forceKv && now - cachedCapacityObservationsLoadedAtMs < ROUTING_CACHE_REVALIDATE_MS) {
    return cachedCapacityObservations;
  }
  try {
    const kv = await getKv();
    if (!kv) {
      cachedCapacityObservationsLoadedAtMs = now;
      return cachedCapacityObservations;
    }
    const [observationEntry, legacy] = await Promise.all([
      kv.get(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, { consistency: "strong" }),
      readLegacyProviderCapacityObservations(pool, kv),
    ]);
    const durable = parseStoredCapacityObservationStore(observationEntry.value);
    cachedCapacityObservations = mergeCapacityObservations(durable, legacy);
    cachedCapacityObservationsLoadedAtMs = now;
    return cachedCapacityObservations;
  } catch {
    cachedCapacityObservationsLoadedAtMs = now;
    return cachedCapacityObservations;
  }
};

/**
 * The slot after a positive capacity observation. Clearing the requested class
 * circuit keeps a pending reset claim or half-open lease intact, and only the
 * last remaining class circuit releases the slot-wide reset scope.
 */
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

const applyCapacityObservation = (
  state: CodexAccountRoutingState,
  observation: CodexCapacityRoutingObservation,
  now: number,
  model: string | null
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
  return changed ? withSlot(state, observation.slot, nextSlot) : null;
};

export const reconcileCapacityRoutingState = async (
  state: CodexAccountRoutingState,
  observations: readonly CodexCapacityRoutingObservation[],
  now: number,
  model: string | null
): Promise<CodexAccountRoutingState> => {
  const next = await updateRoutingState((base) => {
    let changed = false;
    let result = base;
    for (const observation of observations) {
      const applied = applyCapacityObservation(result, observation, now, model);
      if (applied) {
        result = applied;
        changed = true;
      }
    }
    return changed ? result : null;
  });
  return next ?? state;
};

/**
 * Persist the merged observation set with compare-and-set, re-reading the durable
 * store on every attempt. `null` means the merge could not be committed, so the
 * caller must not treat this isolate's view as durable.
 */
const persistCapacityObservations = async (
  kv: Kv,
  observations: readonly CodexCapacityRoutingObservation[],
  observationNow: number
): Promise<readonly CodexCapacityRoutingObservation[] | null> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const entry = await kv.get(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, { consistency: "strong" });
      const durable = parseStoredCapacityObservationStore(entry.value);
      const merged = retainRecentCapacityObservations(mergeCapacityObservations(durable, observations), observationNow);
      const next = {
        v: 1,
        updated_at_ms: observationNow,
        observations: merged,
      };
      const committed = await kv.atomic().check(entry).set(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, next).commit();
      if (committed.ok) return merged;
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Persist the redacted, account-hash-bound sampler result and immediately
 * reconcile any matching routing slot. A positive observation clears only an
 * older quota signal; a newer inference 429 remains authoritative.
 */
export const recordCodexCapacityRoutingObservations = async (inputs: readonly CodexCapacityRoutingObservationInput[], now = Date.now()): Promise<void> => {
  const observations = (await Promise.all(inputs.map(capacityObservationFromInput))).filter(
    (observation): observation is CodexCapacityRoutingObservation => observation !== null
  );
  if (!observations.length) return;
  const observationNow = isSafeMs(now) ? now : Date.now();
  let merged = retainRecentCapacityObservations(mergeCapacityObservations(cachedCapacityObservations, observations), observationNow);
  let kv: Kv | null;
  try {
    kv = await getKv();
  } catch {
    kv = null;
  }
  if (kv) {
    const persisted = await persistCapacityObservations(kv, observations, observationNow);
    if (!persisted) return;
    merged = persisted;
    cachedCapacityObservations = merged;
    cachedCapacityObservationsLoadedAtMs = Date.now();
  } else {
    cachedCapacityObservations = merged;
    cachedCapacityObservationsLoadedAtMs = Date.now();
  }

  // The direct transition is useful for a dashboard refresh that runs before
  // the next inference request. Selection repeats this reconciliation and can
  // still override a stale local circuit if a concurrent CAS loses a race.
  if (routingStateCache.state) await reconcileCapacityRoutingState(routingStateCache.state, merged, observationNow, null);
};

/**
 * RFC 7231 IMF-fixdate. The weekday and month permit lists are checked as data
 * instead of as regex alternation, so the pattern stays one linear scan while
 * the accepted grammar remains exactly the protocol's. `futureRetryAfterDeadline`
 * additionally requires the parsed instant to round-trip through `toUTCString()`.
 */
