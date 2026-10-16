import type { Kv, KvEntryMaybe, KvKey } from "#kv";
// Kernel quota v2 reservation entry points, split out of src/kernel_quota_v2.ts.

import { API_KEY_NO_USAGE_LIMIT } from "../api-keys.ts";
import { openaiError } from "../http.ts";
import { getKv } from "../kv.ts";
import {
  KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY,
  KERNEL_QUOTA_RESERVATION_LEASE_MS,
  type KernelDefaultWindowCutoverV2,
  type KernelDefaults,
  type KernelQuotaEffectivePolicy,
  type KernelQuotaEffectiveWindow,
  type KernelQuotaPolicyV2,
  type KernelQuotaReservationDecision,
  type KernelQuotaReservationRowV2,
  type KernelQuotaScope,
  type KernelQuotaWindowV2,
  MAX_KV_RETRIES,
  isExpired,
  kernelPolicyKeys,
  kernelRepoPolicyKey,
  loadDefaults,
  policyFor,
  windowForEffectivePolicy,
} from "./quota-v2.ts";
import {
  kernelQuotaUnavailable,
  kernelReservationContext,
  kernelReservationKey,
  kernelReservationMatchesRequest,
  kernelReservationRetentionMs,
  normalizeKernelQuotaReservationRowV2,
  readKernelQuotaPolicyState,
  reclaimExpiredKernelReservationUnlocked,
  reconcileKernelQuotaWindowReservations,
  withKernelQuotaLock,
} from "./quota-reservations.ts";

const kernelLimitBlocked = (message: string, code = "rate_limit_exceeded"): KernelQuotaReservationDecision => ({
  ok: false,
  response: openaiError(429, message, code),
});

const quotaExceeded = (window: KernelQuotaWindowV2, limit: number): KernelQuotaReservationDecision => {
  const admitted = window.usage_requests + window.reserved_requests;
  return kernelLimitBlocked(`Usage limit exceeded (${admitted}/${limit}). Resets at ${new Date(window.usage_reset_at_ms).toISOString()}`);
};

type KernelQuotaReserveOptions = Readonly<{
  kv?: Kv | null;
  nowMs?: number;
  renewalIntervalMs?: number;
  expectedRepoPolicy?: "present" | "absent";
  guardedRepo?: string;
}>;

/** Every entry one reservation attempt compares against. */
type KernelQuotaReservationEntries = Readonly<{
  defaults: KernelDefaults;
  policyEntry: KvEntryMaybe<KernelQuotaPolicyV2>;
  windowEntry: KvEntryMaybe<KernelQuotaWindowV2>;
  repoGuardEntry: KvEntryMaybe<KernelQuotaPolicyV2> | null;
  defaultCutoverEntry: KvEntryMaybe<KernelDefaultWindowCutoverV2>;
  windowKey: KvKey;
}>;

/** The loaded entries together with the policy and window this attempt reserves against. */
type KernelQuotaReservationTarget = KernelQuotaReservationEntries &
  Readonly<{
    effective: KernelQuotaEffectivePolicy;
    resolved: KernelQuotaEffectiveWindow;
  }>;

type KernelQuotaEligibility =
  Readonly<{ kind: "decision"; decision: KernelQuotaReservationDecision }> | Readonly<{ kind: "eligible"; target: KernelQuotaReservationTarget }>;

// `reclaimedCapacity` distinguishes a reclaimed expired lease from a lost
// compare-and-set: only a reclaim must stop the next attempt from reclaiming twice.
type KernelQuotaCapacityOutcome =
  Readonly<{ kind: "decision"; decision: KernelQuotaReservationDecision }> | Readonly<{ kind: "retry"; reclaimedCapacity: boolean }>;

/** Loads every entry one reservation attempt compares against. */
const loadKernelQuotaReservationEntries = async (
  kv: Kv,
  keys: Readonly<{ policyKey: KvKey; windowKey: KvKey }>,
  owner: string,
  options: KernelQuotaReserveOptions
): Promise<KernelQuotaReservationEntries> => {
  const [defaults, policyEntry, windowEntry, repoGuardEntry, defaultCutoverEntry] = await Promise.all([
    loadDefaults(kv),
    kv.get<KernelQuotaPolicyV2>(keys.policyKey, { consistency: "strong" }),
    kv.get<KernelQuotaWindowV2>(keys.windowKey, { consistency: "strong" }),
    options.expectedRepoPolicy === "absent" && options.guardedRepo
      ? kv.get<KernelQuotaPolicyV2>(kernelRepoPolicyKey(owner, options.guardedRepo), { consistency: "strong" })
      : Promise.resolve(null),
    kv.get<KernelDefaultWindowCutoverV2>(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, { consistency: "strong" }),
  ]);
  return { defaults, policyEntry, windowEntry, repoGuardEntry, defaultCutoverEntry, windowKey: keys.windowKey };
};

/**
 * Applies the policy scope, cutover, expiry, and aggregate guards. Returns the
 * effective policy and resolved window when the request may reserve capacity.
 */
const evaluateKernelQuotaEligibility = async (
  kv: Kv,
  entries: KernelQuotaReservationEntries,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  options: KernelQuotaReserveOptions,
  nowMs: number
): Promise<KernelQuotaEligibility> => {
  if (options.expectedRepoPolicy === "present" && entries.policyEntry.value === null) {
    return { kind: "decision", decision: kernelQuotaUnavailable("Kernel quota policy scope changed; retry") };
  }
  if (options.expectedRepoPolicy === "absent" && entries.repoGuardEntry !== null && entries.repoGuardEntry.value !== null) {
    return { kind: "decision", decision: kernelQuotaUnavailable("Kernel quota policy scope changed; retry") };
  }
  const effective = policyFor(entries.policyEntry, scope, owner, repo, entries.defaults);
  if (effective.source === "default" && entries.defaultCutoverEntry.value !== null) {
    return { kind: "decision", decision: kernelQuotaUnavailable("Kernel quota defaults are changing; retry") };
  }
  if (isExpired(effective.expiresAtMs, nowMs)) {
    return { kind: "decision", decision: kernelLimitBlocked("Kernel auth usage limit expired; update it via /admin/kernel-usage.") };
  }
  if (effective.limit === 0) {
    return { kind: "decision", decision: kernelLimitBlocked("Kernel auth usage limit is 0; update it via /admin/kernel-usage.") };
  }
  const existingWindow = await reconcileKernelQuotaWindowReservations(kv, entries.windowEntry, scope, owner, repo);
  if (entries.windowEntry.value !== null && !existingWindow) {
    return { kind: "decision", decision: kernelQuotaUnavailable("Kernel quota aggregate is malformed") };
  }
  return {
    kind: "eligible",
    target: { ...entries, effective, resolved: windowForEffectivePolicy(existingWindow, scope, owner, repo, effective.windowMs, nowMs) },
  };
};

/**
 * Frees capacity for an over-limit window by reclaiming an expired lease first.
 * Returns "retry" once capacity was reclaimed, so the attempt is repeated.
 */
const reclaimKernelQuotaCapacity = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  window: KernelQuotaWindowV2,
  limit: number,
  nowMs: number,
  reclaimedExpiredReservation: boolean
): Promise<KernelQuotaCapacityOutcome> => {
  if (reclaimedExpiredReservation) return { kind: "decision", decision: quotaExceeded(window, limit) };
  try {
    const reclaimed = await reclaimExpiredKernelReservationUnlocked(kv, scope, owner, repo, window, nowMs);
    if (reclaimed) return { kind: "retry", reclaimedCapacity: true };
    return { kind: "decision", decision: quotaExceeded(window, limit) };
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to reclaim kernel quota lease:", error);
    return { kind: "decision", decision: kernelQuotaUnavailable() };
  }
};

const commitKernelQuotaReservation = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  requestId: string,
  route: string,
  options: KernelQuotaReserveOptions,
  target: KernelQuotaReservationTarget,
  nowMs: number,
  reclaimedExpiredReservation: boolean
): Promise<KernelQuotaCapacityOutcome> => {
  const { policyEntry, windowEntry, repoGuardEntry, defaultCutoverEntry, defaults, windowKey, effective, resolved } = target;
  const reservationKey = kernelReservationKey(scope, owner, repo, resolved.window.created_at_ms, requestId);
  const reservationEntry = await kv.get<KernelQuotaReservationRowV2>(reservationKey, { consistency: "strong" });
  if (reservationEntry.value !== null) {
    const existingReservation = normalizeKernelQuotaReservationRowV2(reservationEntry.value, scope, owner, repo);
    if (!kernelReservationMatchesRequest(existingReservation, requestId, route, resolved.window.created_at_ms)) {
      return { kind: "decision", decision: kernelQuotaUnavailable("Kernel quota request identity conflicts") };
    }
    return { kind: "decision", decision: kernelQuotaUnavailable("Kernel quota request already has a reservation") };
  }
  const admitted = resolved.window.usage_requests + resolved.window.reserved_requests;
  if (effective.limit !== API_KEY_NO_USAGE_LIMIT && admitted >= effective.limit) {
    return await reclaimKernelQuotaCapacity(kv, scope, owner, repo, resolved.window, effective.limit, nowMs, reclaimedExpiredReservation);
  }
  const reservation: KernelQuotaReservationRowV2 = {
    v: 2,
    scope,
    owner,
    ...(scope === "repo" ? { repo } : {}),
    request_id: requestId,
    route,
    window_created_at_ms: resolved.window.created_at_ms,
    window_reset_at_ms: resolved.window.usage_reset_at_ms,
    state: "reserved",
    terminal_intent: null,
    reserved_at_ms: nowMs,
    lease_expires_at_ms: nowMs + KERNEL_QUOTA_RESERVATION_LEASE_MS,
    committed_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  };
  const reservedWindow: KernelQuotaWindowV2 = {
    ...resolved.window,
    reserved_requests: resolved.window.reserved_requests + 1,
    updated_at_ms: nowMs,
  };
  const retentionMs = kernelReservationRetentionMs(reservedWindow.usage_reset_at_ms, nowMs);
  let atomic = kv.atomic().check(policyEntry).check(windowEntry).check(reservationEntry);
  if (repoGuardEntry !== null) atomic = atomic.check(repoGuardEntry);
  if (effective.source === "default") {
    atomic = atomic.check(defaults.limitEntry).check(defaults.windowEntry).check(defaultCutoverEntry);
  }
  const committed = await atomic.set(windowKey, reservedWindow, { expireIn: retentionMs }).set(reservationKey, reservation, { expireIn: retentionMs }).commit();
  if (!committed.ok) return { kind: "retry", reclaimedCapacity: false };
  return {
    kind: "decision",
    decision: {
      ok: true,
      reservation: kernelReservationContext(
        kv,
        scope,
        owner,
        repo,
        reservedWindow.created_at_ms,
        requestId,
        route,
        reservation.lease_expires_at_ms,
        options.renewalIntervalMs
      ),
    },
  };
};

const attemptReserveKernelQuota = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  requestId: string,
  route: string,
  options: KernelQuotaReserveOptions,
  nowMs: number,
  reclaimedExpiredReservation: boolean
): Promise<KernelQuotaCapacityOutcome> => {
  const entries = await loadKernelQuotaReservationEntries(kv, kernelPolicyKeys(scope, owner, repo), owner, options);
  const eligibility = await evaluateKernelQuotaEligibility(kv, entries, scope, owner, repo, options, nowMs);
  if (eligibility.kind === "decision") return eligibility;
  return await commitKernelQuotaReservation(kv, scope, owner, repo, requestId, route, options, eligibility.target, nowMs, reclaimedExpiredReservation);
};

const reserveLimit = async (
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  requestId: string,
  route: string,
  options: KernelQuotaReserveOptions = {}
): Promise<KernelQuotaReservationDecision> => {
  try {
    const kv = options.kv === undefined ? await getKv() : options.kv;
    if (!kv) return kernelQuotaUnavailable();
    if (!requestId || !route) return kernelQuotaUnavailable("Kernel quota reservation requires a request id and route");
    return await withKernelQuotaLock(scope, owner, repo, async () => {
      let reclaimedExpiredReservation = false;
      for (let attempt = 0; attempt < MAX_KV_RETRIES; attempt += 1) {
        const nowMs = options.nowMs ?? Date.now();
        const outcome = await attemptReserveKernelQuota(kv, scope, owner, repo, requestId, route, options, nowMs, reclaimedExpiredReservation);
        if (outcome.kind === "retry") {
          if (outcome.reclaimedCapacity) reclaimedExpiredReservation = true;
          continue;
        }
        return outcome.decision;
      }
      return kernelQuotaUnavailable("Kernel quota changed concurrently; retry");
    });
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to reserve kernel quota:", error);
    return kernelQuotaUnavailable();
  }
};

export const reserveKernelOrgUsageLimit = async (
  owner: string,
  requestId: string,
  route: string,
  options: Readonly<{ kv?: Kv | null; nowMs?: number; renewalIntervalMs?: number }> = {}
): Promise<KernelQuotaReservationDecision> => await reserveLimit("org", owner, undefined, requestId, route, options);

export const reserveEffectiveKernelUsageLimit = async (
  owner: string,
  repo: string,
  requestId: string,
  route: string,
  options: Readonly<{ kv?: Kv | null; nowMs?: number; renewalIntervalMs?: number }> = {}
): Promise<KernelQuotaReservationDecision> => {
  try {
    const kv = options.kv === undefined ? await getKv() : options.kv;
    if (!kv) return kernelQuotaUnavailable();
    const state = await readKernelQuotaPolicyState(kv, owner, repo);
    return state.limit_scope === "repo"
      ? await reserveLimit("repo", owner, repo, requestId, route, {
          kv,
          nowMs: options.nowMs,
          renewalIntervalMs: options.renewalIntervalMs,
          expectedRepoPolicy: "present",
        })
      : await reserveLimit("org", owner, undefined, requestId, route, {
          kv,
          nowMs: options.nowMs,
          renewalIntervalMs: options.renewalIntervalMs,
          expectedRepoPolicy: "absent",
          guardedRepo: repo,
        });
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to reserve effective kernel quota:", error);
    return kernelQuotaUnavailable();
  }
};
