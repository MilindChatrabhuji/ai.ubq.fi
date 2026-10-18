import type { Kv, KvEntry, KvEntryMaybe } from "#kv";
import { API_KEY_NO_EXPIRATION_MS, API_KEY_NO_USAGE_LIMIT } from "../api-keys.ts";
import {
  DEFAULT_KERNEL_POLICY_LIMIT_KEY,
  DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS,
  DEFAULT_KERNEL_POLICY_WINDOW_KEY,
  DEFAULT_KERNEL_POLICY_WINDOW_MS,
} from "../defaults.ts";
import { getKv } from "../kv.ts";
import type { KernelAuthLimitRecord, KernelOrgLimitRecord } from "../types.ts";

import {
  KERNEL_QUOTA_V2_PREFIX,
  KERNEL_REPO_POLICY_V2_PREFIX,
  KERNEL_ORG_POLICY_V2_PREFIX,
  KERNEL_REPO_WINDOW_V2_PREFIX,
  KERNEL_ORG_WINDOW_V2_PREFIX,
  KERNEL_REPO_RESERVATION_V2_PREFIX,
  KERNEL_ORG_RESERVATION_V2_PREFIX,
  KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY,
  KERNEL_QUOTA_RESERVATION_LEASE_MS,
  KERNEL_QUOTA_RESERVATION_RENEWAL_MS,
  KERNEL_QUOTA_RESERVATION_RETENTION_MS,
  KERNEL_DEFAULT_WINDOW_CUTOVER_LEASE_MS,
  KERNEL_QUOTA_SETTLEMENT_RETRY_MS,
  MAX_KV_RETRIES,
  kernelRepoPolicyKey,
  kernelOrgPolicyKey,
  kernelRepoWindowKey,
  kernelOrgWindowKey,
  kernelRepoReservationKey,
  kernelOrgReservationKey,
  kernelLimitKey,
  kernelOrgLimitKey,
  kernelRepoPart,
  kernelScopedPolicyKey,
  kernelScopedWindowKey,
  kernelPolicyKeys,
  hasLiveKernelReservations,
  positiveSafeInteger,
  nonNegativeSafeInteger,
  normalizeWindow,
  validIdentity,
  newWindow,
  windowForEffectivePolicy,
  normalizeUsageLimit as pureNormalizeUsageLimit,
  normalizeExpiration as pureNormalizeExpiration,
  normalizeKernelQuotaPolicyV2 as pureNormalizeKernelQuotaPolicyV2,
  normalizeKernelQuotaWindowV2,
  policyFor as purePolicyFor,
  isExpired as pureIsExpired,
} from "../authority/native-kernel.ts";
import type {
  KernelQuotaScope,
  KernelQuotaPolicyV2,
  KernelQuotaWindowV2,
  KernelQuotaReservationRowV2,
  KernelDefaultWindowCutoverV2,
  KernelQuotaEffectivePolicy,
  KernelQuotaEffectiveWindow,
  KernelQuotaRead,
} from "../authority/native-kernel-contracts.ts";
export {
  KERNEL_QUOTA_V2_PREFIX,
  KERNEL_REPO_POLICY_V2_PREFIX,
  KERNEL_ORG_POLICY_V2_PREFIX,
  KERNEL_REPO_WINDOW_V2_PREFIX,
  KERNEL_ORG_WINDOW_V2_PREFIX,
  KERNEL_REPO_RESERVATION_V2_PREFIX,
  KERNEL_ORG_RESERVATION_V2_PREFIX,
  KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY,
  KERNEL_QUOTA_RESERVATION_LEASE_MS,
  KERNEL_QUOTA_RESERVATION_RENEWAL_MS,
  kernelRepoPolicyKey,
  kernelOrgPolicyKey,
  kernelRepoWindowKey,
  kernelOrgWindowKey,
  kernelRepoReservationKey,
  kernelOrgReservationKey,
  kernelLimitKey,
  kernelOrgLimitKey,
  normalizeKernelQuotaWindowV2,
};
export type { KernelQuotaPolicyV2, KernelQuotaWindowV2, KernelQuotaReservationRowV2 };

export type KernelDefaultWindowCutoverGuard = Readonly<{
  key: typeof KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY;
  entry: KvEntry<KernelDefaultWindowCutoverV2>;
}>;

export type KernelDefaultWindowCutoverDecision =
  Readonly<{ ok: true; guard: KernelDefaultWindowCutoverGuard }> | Readonly<{ ok: false; reason: "active_reservations" | "concurrent_change" | "unavailable" }>;

export type KernelQuotaReservation = Readonly<{
  signal: AbortSignal;
  commit: () => Promise<void>;
  release: (reason?: string) => Promise<void>;
}>;

export type KernelQuotaReservationDecision = Readonly<{ ok: true; reservation: KernelQuotaReservation }> | Readonly<{ ok: false; response: Response }>;

export type KernelQuotaPolicyStateDecision =
  Readonly<{ ok: true; limit_scope: KernelQuotaScope; has_policy: boolean }> | Readonly<{ ok: false; response: Response }>;

type KernelDefaults = Readonly<{
  limit: number;
  windowMs: number;
  limitEntry: KvEntryMaybe<number>;
  windowEntry: KvEntryMaybe<number>;
}>;

export const KERNEL_QUOTA_CONSTANTS = Object.freeze({ noUsageLimit: API_KEY_NO_USAGE_LIMIT, noExpirationMs: API_KEY_NO_EXPIRATION_MS });
export const kernelQuotaRead = <T>(entry: KvEntryMaybe<T>): KernelQuotaRead<T> => ({ value: entry.value, revision: entry.versionstamp });
const normalizeUsageLimit = (value: unknown, fallback: number): number => pureNormalizeUsageLimit(value, fallback, API_KEY_NO_USAGE_LIMIT);
const normalizeExpiration = (value: unknown): number => pureNormalizeExpiration(value, API_KEY_NO_EXPIRATION_MS);
export const normalizeKernelQuotaPolicyV2 = (value: unknown, scope: KernelQuotaScope, owner: string, repo: string | undefined): KernelQuotaPolicyV2 | null =>
  pureNormalizeKernelQuotaPolicyV2(value, scope, owner, repo, KERNEL_QUOTA_CONSTANTS);
const policyFor = (
  entry: KvEntryMaybe<KernelQuotaPolicyV2>,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  defaults: KernelDefaults
): KernelQuotaEffectivePolicy => purePolicyFor(kernelQuotaRead(entry), scope, owner, repo, defaults, KERNEL_QUOTA_CONSTANTS);
const isExpired = (expiresAtMs: number, nowMs: number): boolean => pureIsExpired(expiresAtMs, nowMs, API_KEY_NO_EXPIRATION_MS);

const loadDefaults = async (kv: Kv): Promise<KernelDefaults> => {
  const [limitEntry, windowEntry] = await Promise.all([
    kv.get<number>(DEFAULT_KERNEL_POLICY_LIMIT_KEY, { consistency: "strong" }),
    kv.get<number>(DEFAULT_KERNEL_POLICY_WINDOW_KEY, { consistency: "strong" }),
  ]);
  return {
    limit: normalizeUsageLimit(limitEntry.value, DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS),
    windowMs: normalizeWindow(windowEntry.value, DEFAULT_KERNEL_POLICY_WINDOW_MS),
    limitEntry,
    windowEntry,
  };
};

const repoRecord = (
  owner: string,
  repo: string,
  policy: { limit: number; windowMs: number; expiresAtMs: number },
  window: KernelQuotaWindowV2,
  nowMs: number
): KernelAuthLimitRecord => ({
  owner,
  repo,
  usage_limit_requests: policy.limit,
  usage_requests: window.usage_requests,
  usage_reset_at_ms: window.usage_reset_at_ms,
  window_ms: policy.windowMs,
  expires_at_ms: policy.expiresAtMs,
  created_at_ms: window.created_at_ms || nowMs,
  updated_at_ms: Math.max(window.updated_at_ms, nowMs),
});

const orgRecord = (
  owner: string,
  policy: { limit: number; windowMs: number; expiresAtMs: number },
  window: KernelQuotaWindowV2,
  nowMs: number
): KernelOrgLimitRecord => ({
  owner,
  usage_limit_requests: policy.limit,
  usage_requests: window.usage_requests,
  usage_reset_at_ms: window.usage_reset_at_ms,
  window_ms: policy.windowMs,
  expires_at_ms: policy.expiresAtMs,
  created_at_ms: window.created_at_ms || nowMs,
  updated_at_ms: Math.max(window.updated_at_ms, nowMs),
});

export type KernelAuthLimitSnapshot = Readonly<{ record: KernelAuthLimitRecord; source: "default" | "kv" }>;
export type KernelOrgLimitSnapshot = Readonly<{ record: KernelOrgLimitRecord; source: "default" | "kv" }>;

const getSnapshot = async (
  scope: KernelQuotaScope,
  owner: string,
  repo?: string
): Promise<{ record: KernelAuthLimitRecord | KernelOrgLimitRecord; source: "default" | "kv" } | null> => {
  try {
    const kv = await getKv();
    if (!kv) return null;
    const keys = kernelPolicyKeys(scope, owner, repo);
    const [defaults, policyEntry, windowEntry] = await Promise.all([
      loadDefaults(kv),
      kv.get<KernelQuotaPolicyV2>(keys.policyKey, { consistency: "strong" }),
      kv.get<KernelQuotaWindowV2>(keys.windowKey, { consistency: "strong" }),
    ]);
    const effective = policyFor(policyEntry, scope, owner, repo, defaults);
    const window = windowForEffectivePolicy(
      normalizeKernelQuotaWindowV2(windowEntry.value, scope, owner, repo),
      scope,
      owner,
      repo,
      effective.windowMs,
      Date.now()
    ).window;
    return {
      record: scope === "repo" ? repoRecord(owner, kernelRepoPart(repo), effective, window, Date.now()) : orgRecord(owner, effective, window, Date.now()),
      source: effective.source,
    };
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to load kernel quota snapshot:", error);
    return null;
  }
};

export const getKernelUsageLimitSnapshot = async (owner: string, repo: string): Promise<KernelAuthLimitSnapshot | null> => {
  const snapshot = await getSnapshot("repo", owner, repo);
  return snapshot ? (snapshot as KernelAuthLimitSnapshot) : null;
};

export const getKernelOrgUsageLimitSnapshot = async (owner: string): Promise<KernelOrgLimitSnapshot | null> => {
  const snapshot = await getSnapshot("org", owner);
  return snapshot ? (snapshot as KernelOrgLimitSnapshot) : null;
};

/** Orders listed policy records by owner, then by repo for repo-scope records. */
const compareKernelPolicyRows = (a: KernelAuthLimitRecord | KernelOrgLimitRecord, b: KernelAuthLimitRecord | KernelOrgLimitRecord): number =>
  a.owner.localeCompare(b.owner) || ("repo" in a && "repo" in b ? a.repo.localeCompare(b.repo) : 0);

/**
 * Projects one listed policy entry into its usage record, or null when the entry
 * does not describe a policy for the requested scope.
 */
const kernelPolicyRow = async (
  kv: Kv,
  scope: KernelQuotaScope,
  prefix: readonly string[],
  entry: KvEntry<KernelQuotaPolicyV2>
): Promise<KernelAuthLimitRecord | KernelOrgLimitRecord | null> => {
  const owner = entry.key[prefix.length];
  if (typeof owner !== "string" || !owner) return null;
  const repoPart = entry.key[prefix.length + 1];
  const repo = scope === "repo" && typeof repoPart === "string" && repoPart ? repoPart : undefined;
  if (scope === "repo" && !repo) return null;
  const policy = normalizeKernelQuotaPolicyV2(entry.value, scope, owner, repo);
  if (!policy) return null;
  const windowEntry = await kv.get<KernelQuotaWindowV2>(kernelScopedWindowKey(scope, owner, repo), { consistency: "strong" });
  const window = windowForEffectivePolicy(
    normalizeKernelQuotaWindowV2(windowEntry.value, scope, owner, repo),
    scope,
    owner,
    repo,
    policy.window_ms,
    Date.now()
  ).window;
  const summary = { limit: policy.usage_limit_requests, windowMs: policy.window_ms, expiresAtMs: policy.expires_at_ms };
  return scope === "repo" ? repoRecord(owner, kernelRepoPart(repo), summary, window, Date.now()) : orgRecord(owner, summary, window, Date.now());
};

const listPolicies = async (scope: KernelQuotaScope): Promise<(KernelAuthLimitRecord | KernelOrgLimitRecord)[] | null> => {
  try {
    const kv = await getKv();
    if (!kv) return null;
    const prefix = scope === "repo" ? KERNEL_REPO_POLICY_V2_PREFIX : KERNEL_ORG_POLICY_V2_PREFIX;
    const rows: (KernelAuthLimitRecord | KernelOrgLimitRecord)[] = [];
    for await (const entry of kv.list<KernelQuotaPolicyV2>({ prefix })) {
      const row = await kernelPolicyRow(kv, scope, prefix, entry);
      if (row) rows.push(row);
    }
    rows.sort(compareKernelPolicyRows);
    return rows;
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to list kernel quota policies:", error);
    return null;
  }
};

export const listKernelUsageLimits = async (): Promise<KernelAuthLimitRecord[] | null> => {
  const rows = await listPolicies("repo");
  return rows as KernelAuthLimitRecord[] | null;
};

export const listKernelOrgUsageLimits = async (): Promise<KernelOrgLimitRecord[] | null> => {
  const rows = await listPolicies("org");
  return rows as KernelOrgLimitRecord[] | null;
};

export {
  KERNEL_DEFAULT_WINDOW_CUTOVER_LEASE_MS,
  KERNEL_QUOTA_RESERVATION_RETENTION_MS,
  KERNEL_QUOTA_SETTLEMENT_RETRY_MS,
  MAX_KV_RETRIES,
  hasLiveKernelReservations,
  isExpired,
  kernelPolicyKeys,
  kernelRepoPart,
  kernelScopedPolicyKey,
  kernelScopedWindowKey,
  loadDefaults,
  newWindow,
  nonNegativeSafeInteger,
  normalizeExpiration,
  normalizeUsageLimit,
  normalizeWindow,
  orgRecord,
  policyFor,
  positiveSafeInteger,
  repoRecord,
  validIdentity,
  windowForEffectivePolicy,
};
export type { KernelDefaultWindowCutoverV2, KernelDefaults, KernelQuotaEffectivePolicy, KernelQuotaEffectiveWindow, KernelQuotaScope };

// The write path, reservations and reserve entry points moved into their own
// modules; they are re-exported here so existing callers keep one import site.
export * from "./quota-write.ts";
export * from "./quota-reservations.ts";
export * from "./quota-reserve.ts";
