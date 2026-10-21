import type { AtomicOperation, Kv } from "#kv";
import { getKv } from "../kv.ts";
import { PROVIDER_CAPACITY_SNAPSHOT_KEY } from "../provider/capacity-contract.ts";
import { isRecord, sha256Hex } from "../utils.ts";
import { type CodexAuthPoolState, type CodexAuthState } from "../types.ts";
import {
  CODEX_ACCOUNT_ROUTING_KV_KEY,
  CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY,
  ROUTING_CACHE_REVALIDATE_MS,
  type CodexAccountRoutingState,
  type CodexCapacityRoutingObservation,
  type CodexCapacityRoutingObservationInput,
  type CodexProbeCircuit,
  type CodexRoutingSlot,
  type RoutingAccount,
  isSafeMs,
  parseCodexAccountRoutingState,
  parseOptionalSafeMs,
  routingStateCache,
} from "./routing-state.ts";
import * as capacityDecisions from "../authority/native-codex-capacity.ts";
import { nativeCodexAccountMetadata } from "./routing-state.ts";
import {
  withoutLegacyTimeoutCircuits,
  capacityState,
  normalizeCapacityWindow,
  normalizeCapacityAdditionalRateLimits,
  mergeCapacityObservations,
  retainRecentCapacityObservations,
  parseStoredCapacityObservationStore,
} from "../authority/native-codex-capacity.ts";
export {
  neutralSlot,
  parseFinitePercent,
  quotaHeadroomFor,
  capacityState,
  quotaClass,
  quotaBlockForClass,
  quotaBlocksIncludingLegacy,
  quotaSignalObservedAtForClass,
  quotaBlockKeyForClass,
  withoutQuotaClass,
  recheckQuotaClasses,
  releaseQuotaClassProbe,
  capacityHeadroomForObservation,
  capacityObservationIsFresh,
  parseStoredCapacityObservationStore,
} from "../authority/native-codex-capacity.ts";
export const normalizeRoutingState = async (
  raw: CodexAccountRoutingState | null,
  pool: CodexAuthPoolState,
  now = Date.now(),
  discardLegacyTimeoutCircuit = false
): Promise<CodexAccountRoutingState> => {
  const identities = await Promise.all(pool.accounts.map(routingAccountIdentity));
  return capacityDecisions.normalizeRoutingState(
    raw,
    identities.map((identity, slot) => ({ ...identity, slot })),
    now,
    discardLegacyTimeoutCircuit
  );
};
export const slotFor = (state: CodexAccountRoutingState, account: RoutingAccount): CodexRoutingSlot =>
  capacityDecisions.slotFor(state, nativeCodexAccountMetadata(account));
export const slotMatchesRoutingAccount = (slot: CodexRoutingSlot, account: RoutingAccount): boolean =>
  capacityDecisions.slotMatchesCodexRoutingAccount(slot, nativeCodexAccountMetadata(account));
export const routingProbeCircuit = (account: RoutingAccount): CodexProbeCircuit => capacityDecisions.routingProbeCircuit(nativeCodexAccountMetadata(account));
export const probeLeaseMatchesRoutingAccount = (slot: CodexRoutingSlot, account: RoutingAccount): boolean =>
  capacityDecisions.probeLeaseMatchesCodexRoutingAccount(slot, nativeCodexAccountMetadata(account));
export const withSlot = (state: CodexAccountRoutingState, index: number, slot: CodexRoutingSlot): CodexAccountRoutingState =>
  capacityDecisions.withSlot(state, index, slot, Date.now());
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

/**
 * Persist a class block from one fresh exhausted capacity observation. The
 * pure transition owns validity and identity rules; this wrapper serializes it
 * through the same compare-and-set path as every other routing mutation.
 */
export const reconcileCapacityQuotaBlock = async (
  account: RoutingAccount,
  observation: CodexCapacityRoutingObservation,
  now = Date.now()
): Promise<boolean> => {
  let changed = false;
  await updateRoutingState((state) => {
    const next = capacityDecisions.applyCapacityQuotaBlock(state, nativeCodexAccountMetadata(account), observation, now, Date.now());
    if (next !== null) changed = true;
    return next;
  });
  return changed;
};

/** Routing state reads and writes fail closed when the KV binding itself is unavailable. */
export const openRoutingKv = async (): Promise<Kv | null> => {
  try {
    return await getKv();
  } catch {
    return null;
  }
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
      const applied = capacityDecisions.applyCapacityObservation(result, observation, now, model, Date.now());
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
      const plan = capacityDecisions.planCapacityObservationStore(entry.versionstamp, durable, observations, observationNow);
      const committed = await kv
        .atomic()
        .check({ key: entry.key, versionstamp: plan.checks.capacity })
        .set(CODEX_CAPACITY_ROUTING_OBSERVATION_KV_KEY, plan.writes.capacity)
        .commit();
      if (committed.ok) return plan.writes.capacity.observations;
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
