import type { AtomicOperation, Kv, KvEntryMaybe, KvKey } from "#kv";
// Kernel quota v2 policy write path, split out of src/kernel_quota_v2.ts.

import { getKv } from "../kv.ts";
import { type KernelAuthLimitRecord, type KernelOrgLimitRecord } from "../types.ts";
import {
  KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY,
  type KernelDefaultWindowCutoverV2,
  type KernelDefaults,
  type KernelQuotaEffectivePolicy,
  type KernelQuotaPolicyV2,
  type KernelQuotaScope,
  type KernelQuotaWindowV2,
  MAX_KV_RETRIES,
  hasLiveKernelReservations,
  kernelOrgPolicyKey,
  kernelOrgWindowKey,
  kernelPolicyKeys,
  kernelRepoPart,
  loadDefaults,
  newWindow,
  normalizeExpiration,
  normalizeUsageLimit,
  normalizeWindow,
  orgRecord,
  policyFor,
  repoRecord,
  windowForEffectivePolicy,
} from "./quota-v2.ts";
import { reclaimExpiredKernelReservationUnlocked, reconcileKernelQuotaWindowReservations, withKernelQuotaLock } from "./quota-reservations.ts";

type KernelQuotaPolicySetOptions = { resetUsage?: boolean; windowMs?: number; expiresAtMs?: number };

type KernelQuotaPolicyRequest = Readonly<{
  scope: KernelQuotaScope;
  owner: string;
  repo: string | undefined;
  usageLimitRequests: number;
  options: KernelQuotaPolicySetOptions;
}>;

/** Every KV entry one policy write compares against. */
type KernelQuotaPolicyWriteEntries = Readonly<{
  defaults: KernelDefaults;
  policyEntry: KvEntryMaybe<KernelQuotaPolicyV2>;
  windowEntry: KvEntryMaybe<KernelQuotaWindowV2>;
  orgPolicyEntry: KvEntryMaybe<KernelQuotaPolicyV2> | null;
  orgWindowEntry: KvEntryMaybe<KernelQuotaWindowV2> | null;
  defaultCutoverEntry: KvEntryMaybe<KernelDefaultWindowCutoverV2>;
}>;

type KernelQuotaPolicyWriteAttempt =
  Readonly<{ outcome: "written"; record: KernelAuthLimitRecord | KernelOrgLimitRecord }> | Readonly<{ outcome: "retry" }> | Readonly<{ outcome: "abort" }>;

/** Resolves the window and expiration this write applies, honouring explicit overrides. */
const resolveKernelPolicyTiming = (
  options: KernelQuotaPolicySetOptions,
  current: KernelQuotaEffectivePolicy
): Readonly<{ windowMs: number; expiresAtMs: number }> => ({
  windowMs: options.windowMs === undefined ? current.windowMs : normalizeWindow(options.windowMs, current.windowMs),
  expiresAtMs: options.expiresAtMs === undefined ? current.expiresAtMs : normalizeExpiration(options.expiresAtMs),
});

/**
 * A repo policy created on top of an inherited org policy must not orphan live org
 * reservations: reconcile the org aggregate and reclaim an expired lease first.
 */
const reconcileKernelPolicyOrgInheritance = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  entries: KernelQuotaPolicyWriteEntries,
  nowMs: number
): Promise<"proceed" | "retry" | "abort"> => {
  const { defaults, policyEntry, orgPolicyEntry, orgWindowEntry } = entries;
  if (scope !== "repo") return "proceed";
  if (policyEntry.value !== null) return "proceed";
  if (orgPolicyEntry === null || orgWindowEntry === null) return "proceed";
  policyFor(orgPolicyEntry, "org", owner, undefined, defaults);
  const inheritedOrgWindow = await reconcileKernelQuotaWindowReservations(kv, orgWindowEntry, "org", owner, undefined);
  if (orgWindowEntry.value !== null && !inheritedOrgWindow) return "abort";
  if (!hasLiveKernelReservations(inheritedOrgWindow, nowMs)) return "proceed";
  const reclaimed = await reclaimExpiredKernelReservationUnlocked(kv, "org", owner, undefined, inheritedOrgWindow, nowMs);
  return reclaimed ? "retry" : "abort";
};

/** A reset that would discard live reservations must first reclaim an expired lease. */
const guardKernelPolicyWindowReset = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  currentWindow: KernelQuotaWindowV2 | null,
  nowMs: number,
  reset: boolean
): Promise<"proceed" | "retry" | "abort"> => {
  if (!reset) return "proceed";
  if (!hasLiveKernelReservations(currentWindow, nowMs)) return "proceed";
  const reclaimed = await reclaimExpiredKernelReservationUnlocked(kv, scope, owner, repo, currentWindow, nowMs);
  return reclaimed ? "retry" : "abort";
};

/** The compare-and-set guards that make the policy write atomic for every reader. */
const kernelPolicyWriteAtomic = (
  kv: Kv,
  scope: KernelQuotaScope,
  entries: KernelQuotaPolicyWriteEntries,
  current: KernelQuotaEffectivePolicy
): AtomicOperation => {
  let atomic = kv.atomic().check(entries.policyEntry).check(entries.windowEntry);
  if (current.source === "default") {
    atomic = atomic.check(entries.defaults.limitEntry).check(entries.defaults.windowEntry).check(entries.defaultCutoverEntry);
  }
  if (scope === "repo" && entries.policyEntry.value === null && entries.orgPolicyEntry !== null && entries.orgWindowEntry !== null) {
    atomic = atomic.check(entries.orgPolicyEntry).check(entries.orgWindowEntry);
  }
  return atomic;
};

const attemptSetKernelQuotaPolicy = async (
  kv: Kv,
  request: KernelQuotaPolicyRequest,
  keys: Readonly<{ policyKey: KvKey; windowKey: KvKey }>
): Promise<KernelQuotaPolicyWriteAttempt> => {
  const { scope, owner, repo, usageLimitRequests, options } = request;
  const nowMs = Date.now();
  const [defaults, policyEntry, windowEntry, orgPolicyEntry, orgWindowEntry, defaultCutoverEntry] = await Promise.all([
    loadDefaults(kv),
    kv.get<KernelQuotaPolicyV2>(keys.policyKey, { consistency: "strong" }),
    kv.get<KernelQuotaWindowV2>(keys.windowKey, { consistency: "strong" }),
    scope === "repo" ? kv.get<KernelQuotaPolicyV2>(kernelOrgPolicyKey(owner), { consistency: "strong" }) : Promise.resolve(null),
    scope === "repo" ? kv.get<KernelQuotaWindowV2>(kernelOrgWindowKey(owner), { consistency: "strong" }) : Promise.resolve(null),
    kv.get<KernelDefaultWindowCutoverV2>(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, {
      consistency: "strong",
    }),
  ]);
  const entries: KernelQuotaPolicyWriteEntries = { defaults, policyEntry, windowEntry, orgPolicyEntry, orgWindowEntry, defaultCutoverEntry };
  const current = policyFor(policyEntry, scope, owner, repo, defaults);
  if (current.source === "default" && defaultCutoverEntry.value !== null) return { outcome: "abort" };
  const { windowMs, expiresAtMs } = resolveKernelPolicyTiming(options, current);
  const policy: KernelQuotaPolicyV2 = {
    v: 2,
    scope,
    owner,
    ...(scope === "repo" ? { repo } : {}),
    usage_limit_requests: normalizeUsageLimit(usageLimitRequests, current.limit),
    window_ms: windowMs,
    expires_at_ms: expiresAtMs,
    created_at_ms: current.policy?.created_at_ms ?? nowMs,
    updated_at_ms: nowMs,
  };
  const currentWindow = await reconcileKernelQuotaWindowReservations(kv, windowEntry, scope, owner, repo);
  if (windowEntry.value !== null && !currentWindow) return { outcome: "abort" };
  const inheritance = await reconcileKernelPolicyOrgInheritance(kv, scope, owner, entries, nowMs);
  if (inheritance !== "proceed") return { outcome: inheritance };
  const reset = options.resetUsage === true || current.windowMs !== windowMs;
  const resetGuard = await guardKernelPolicyWindowReset(kv, scope, owner, repo, currentWindow, nowMs, reset);
  if (resetGuard !== "proceed") return { outcome: resetGuard };
  const baseWindow = reset
    ? newWindow(scope, owner, repo, windowMs, nowMs)
    : windowForEffectivePolicy(currentWindow, scope, owner, repo, windowMs, nowMs).window;
  const window: KernelQuotaWindowV2 = reset ? baseWindow : { ...baseWindow, updated_at_ms: nowMs };
  const committed = await kernelPolicyWriteAtomic(kv, scope, entries, current).set(keys.policyKey, policy).set(keys.windowKey, window).commit();
  if (!committed.ok) return { outcome: "retry" };
  const summary = { limit: policy.usage_limit_requests, windowMs, expiresAtMs };
  return {
    outcome: "written",
    record: scope === "repo" ? repoRecord(owner, kernelRepoPart(repo), summary, window, nowMs) : orgRecord(owner, summary, window, nowMs),
  };
};

const setPolicy = async (
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  usageLimitRequests: number,
  options: KernelQuotaPolicySetOptions
): Promise<KernelAuthLimitRecord | KernelOrgLimitRecord | null> => {
  try {
    const kv = await getKv();
    if (!kv) return null;
    const request: KernelQuotaPolicyRequest = { scope, owner, repo, usageLimitRequests, options };
    const keys = kernelPolicyKeys(scope, owner, repo);
    return await withKernelQuotaLock(scope, owner, repo, async () => {
      for (let attempt = 0; attempt < MAX_KV_RETRIES; attempt += 1) {
        const result = await attemptSetKernelQuotaPolicy(kv, request, keys);
        if (result.outcome === "retry") continue;
        if (result.outcome === "abort") return null;
        return result.record;
      }
      return null;
    });
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to set kernel quota policy:", error);
    return null;
  }
};

export const setKernelUsageLimit = async (
  owner: string,
  repo: string,
  usageLimitRequests: number,
  options: { resetUsage?: boolean; windowMs?: number; expiresAtMs?: number } = {}
): Promise<KernelAuthLimitRecord | null> => (await setPolicy("repo", owner, repo, usageLimitRequests, options)) as KernelAuthLimitRecord | null;

export const setKernelOrgUsageLimit = async (
  owner: string,
  usageLimitRequests: number,
  options: { resetUsage?: boolean; windowMs?: number; expiresAtMs?: number } = {}
): Promise<KernelOrgLimitRecord | null> => (await setPolicy("org", owner, undefined, usageLimitRequests, options)) as KernelOrgLimitRecord | null;

type KernelQuotaDeleteResult = boolean | "conflict" | null;

/** One delete attempt: true when deleted, false when absent, "retry"/"abort" to steer the loop. */
type KernelQuotaPolicyDeleteOutcome = boolean | "conflict" | "retry" | "abort";

const attemptDeleteKernelQuotaPolicy = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  keys: Readonly<{ policyKey: KvKey; windowKey: KvKey }>
): Promise<KernelQuotaPolicyDeleteOutcome> => {
  const nowMs = Date.now();
  const [defaults, policyEntry, windowEntry, defaultCutoverEntry] = await Promise.all([
    loadDefaults(kv),
    kv.get<KernelQuotaPolicyV2>(keys.policyKey, { consistency: "strong" }),
    kv.get<KernelQuotaWindowV2>(keys.windowKey, { consistency: "strong" }),
    kv.get<KernelDefaultWindowCutoverV2>(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, {
      consistency: "strong",
    }),
  ]);
  if (policyEntry.value === null) return false;
  if (defaultCutoverEntry.value !== null) return "conflict";
  const current = policyFor(policyEntry, scope, owner, repo, defaults);
  const oldWindow = await reconcileKernelQuotaWindowReservations(kv, windowEntry, scope, owner, repo);
  if (windowEntry.value !== null && !oldWindow) return "abort";
  if (hasLiveKernelReservations(oldWindow, nowMs)) {
    const reclaimed = await reclaimExpiredKernelReservationUnlocked(kv, scope, owner, repo, oldWindow, nowMs);
    return reclaimed ? "retry" : "conflict";
  }
  const nextWindow =
    current.windowMs === defaults.windowMs
      ? windowForEffectivePolicy(oldWindow, scope, owner, repo, defaults.windowMs, nowMs).window
      : newWindow(scope, owner, repo, defaults.windowMs, nowMs);
  const committed = await kv
    .atomic()
    .check(policyEntry)
    .check(windowEntry)
    .check(defaults.limitEntry)
    .check(defaults.windowEntry)
    .check(defaultCutoverEntry)
    .delete(keys.policyKey)
    .set(keys.windowKey, nextWindow)
    .commit();
  return committed.ok ? true : "retry";
};

const deletePolicy = async (scope: KernelQuotaScope, owner: string, repo?: string): Promise<KernelQuotaDeleteResult> => {
  try {
    const kv = await getKv();
    if (!kv) return null;
    const keys = kernelPolicyKeys(scope, owner, repo);
    return await withKernelQuotaLock(scope, owner, repo, async () => {
      for (let attempt = 0; attempt < MAX_KV_RETRIES; attempt += 1) {
        const outcome = await attemptDeleteKernelQuotaPolicy(kv, scope, owner, repo, keys);
        if (outcome === "retry") continue;
        if (outcome === "abort") return null;
        return outcome;
      }
      return null;
    });
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to delete kernel quota policy:", error);
    return null;
  }
};

export const deleteKernelUsageLimit = async (owner: string, repo: string): Promise<KernelQuotaDeleteResult> => await deletePolicy("repo", owner, repo);
export const deleteKernelOrgUsageLimit = async (owner: string): Promise<KernelQuotaDeleteResult> => await deletePolicy("org", owner);
