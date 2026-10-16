import type { Kv, KvEntry, KvEntryMaybe, KvKey } from "#kv";
import { API_KEY_NO_EXPIRATION_MS, API_KEY_NO_USAGE_LIMIT } from "../api-keys.ts";
import {
  DEFAULT_KERNEL_POLICY_LIMIT_KEY,
  DEFAULT_KERNEL_POLICY_LIMIT_REQUESTS,
  DEFAULT_KERNEL_POLICY_WINDOW_KEY,
  DEFAULT_KERNEL_POLICY_WINDOW_MS,
} from "../defaults.ts";
import { getKv } from "../kv.ts";
import type { KernelAuthLimitRecord, KernelOrgLimitRecord } from "../types.ts";
import { isRecord } from "../utils.ts";

export const KERNEL_QUOTA_V2_PREFIX = ["uos_ai", "kernel_quota", "v2"] as const;
export const KERNEL_REPO_POLICY_V2_PREFIX = [...KERNEL_QUOTA_V2_PREFIX, "repo_policy"] as const;
export const KERNEL_ORG_POLICY_V2_PREFIX = [...KERNEL_QUOTA_V2_PREFIX, "org_policy"] as const;
export const KERNEL_REPO_WINDOW_V2_PREFIX = [...KERNEL_QUOTA_V2_PREFIX, "repo_window"] as const;
export const KERNEL_ORG_WINDOW_V2_PREFIX = [...KERNEL_QUOTA_V2_PREFIX, "org_window"] as const;
export const KERNEL_REPO_RESERVATION_V2_PREFIX = [...KERNEL_QUOTA_V2_PREFIX, "repo_reservation"] as const;
export const KERNEL_ORG_RESERVATION_V2_PREFIX = [...KERNEL_QUOTA_V2_PREFIX, "org_reservation"] as const;
export const KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY = [...KERNEL_QUOTA_V2_PREFIX, "default_window_cutover"] as const;
export const KERNEL_QUOTA_RESERVATION_LEASE_MS = 5 * 60_000;
export const KERNEL_QUOTA_RESERVATION_RENEWAL_MS = 60_000;
const KERNEL_QUOTA_RESERVATION_RETENTION_MS = 7 * 24 * 60 * 60_000;
const KERNEL_DEFAULT_WINDOW_CUTOVER_LEASE_MS = 5 * 60_000;
const KERNEL_QUOTA_SETTLEMENT_RETRY_MS = 1_000;

const MAX_KV_RETRIES = 3;

export const kernelRepoPolicyKey = (owner: string, repo: string) => [...KERNEL_REPO_POLICY_V2_PREFIX, owner, repo] as const;
export const kernelOrgPolicyKey = (owner: string) => [...KERNEL_ORG_POLICY_V2_PREFIX, owner] as const;
export const kernelRepoWindowKey = (owner: string, repo: string) => [...KERNEL_REPO_WINDOW_V2_PREFIX, owner, repo] as const;
export const kernelOrgWindowKey = (owner: string) => [...KERNEL_ORG_WINDOW_V2_PREFIX, owner] as const;
export const kernelRepoReservationKey = (owner: string, repo: string, windowCreatedAtMs: number, requestId: string) =>
  [...KERNEL_REPO_RESERVATION_V2_PREFIX, owner, repo, windowCreatedAtMs, requestId] as const;
export const kernelOrgReservationKey = (owner: string, windowCreatedAtMs: number, requestId: string) =>
  [...KERNEL_ORG_RESERVATION_V2_PREFIX, owner, windowCreatedAtMs, requestId] as const;

// Existing admin and queue call sites retain these names, but they now point
// only at policy records. Usage is deliberately never co-located with policy.
export const kernelLimitKey = kernelRepoPolicyKey;
export const kernelOrgLimitKey = kernelOrgPolicyKey;

type KernelQuotaScope = "repo" | "org";

/**
 * Repo-scope keys are only ever built once a repo is known to be present. The
 * invariant is asserted here so a missing repo fails loudly instead of reaching
 * Deno KV as an `undefined` key part.
 */
const kernelRepoPart = (repo: string | undefined): string => {
  if (repo === undefined) throw new Error("Kernel quota repo scope requires a repo");
  return repo;
};

const kernelScopedPolicyKey = (scope: KernelQuotaScope, owner: string, repo: string | undefined): KvKey =>
  scope === "repo" ? kernelRepoPolicyKey(owner, kernelRepoPart(repo)) : kernelOrgPolicyKey(owner);

const kernelScopedWindowKey = (scope: KernelQuotaScope, owner: string, repo: string | undefined): KvKey =>
  scope === "repo" ? kernelRepoWindowKey(owner, kernelRepoPart(repo)) : kernelOrgWindowKey(owner);

const kernelPolicyKeys = (scope: KernelQuotaScope, owner: string, repo: string | undefined): Readonly<{ policyKey: KvKey; windowKey: KvKey }> => ({
  policyKey: kernelScopedPolicyKey(scope, owner, repo),
  windowKey: kernelScopedWindowKey(scope, owner, repo),
});

export type KernelQuotaPolicyV2 = Readonly<{
  v: 2;
  scope: KernelQuotaScope;
  owner: string;
  repo?: string;
  usage_limit_requests: number;
  window_ms: number;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}>;

export type KernelQuotaWindowV2 = Readonly<{
  v: 2;
  scope: KernelQuotaScope;
  owner: string;
  repo?: string;
  usage_requests: number;
  reserved_requests: number;
  usage_reset_at_ms: number;
  applied_window_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}>;

export type KernelQuotaReservationRowV2 = Readonly<{
  v: 2;
  scope: KernelQuotaScope;
  owner: string;
  repo?: string;
  request_id: string;
  route: string;
  window_created_at_ms: number;
  window_reset_at_ms: number;
  state: "reserved" | "committed" | "released";
  terminal_intent: "committed" | "released" | null;
  reserved_at_ms: number;
  lease_expires_at_ms: number;
  committed_at_ms: number | null;
  released_at_ms: number | null;
  release_reason: string | null;
}>;

type KernelDefaultWindowCutoverV2 = Readonly<{
  v: 2;
  id: string;
  created_at_ms: number;
  expires_at_ms: number;
}>;

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

type KernelQuotaEffectivePolicy = Readonly<{
  policy: KernelQuotaPolicyV2 | null;
  limit: number;
  windowMs: number;
  expiresAtMs: number;
  source: "default" | "kv";
}>;

type KernelQuotaEffectiveWindow = Readonly<{ window: KernelQuotaWindowV2; needsWrite: boolean }>;

/** A window that still holds reservations that have not passed their reset time. */
const hasLiveKernelReservations = (window: KernelQuotaWindowV2 | null, nowMs: number): window is KernelQuotaWindowV2 =>
  window !== null && window.usage_reset_at_ms > nowMs && window.reserved_requests > 0;

const positiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonNegativeSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const normalizeUsageLimit = (value: unknown, fallback: number): number => {
  if (typeof value === "string") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.trunc(value);
  if (parsed === API_KEY_NO_USAGE_LIMIT) return parsed;
  return parsed >= 0 ? parsed : fallback;
};

const normalizeWindow = (value: unknown, fallback: number): number => {
  if (typeof value === "string") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : fallback;
};

const normalizeExpiration = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return API_KEY_NO_EXPIRATION_MS;
  const parsed = Math.trunc(value);
  return parsed === API_KEY_NO_EXPIRATION_MS || parsed >= 0 ? parsed : API_KEY_NO_EXPIRATION_MS;
};

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

const validIdentity = (scope: KernelQuotaScope, owner: string, repo: string | undefined, value: Record<string, unknown>): boolean =>
  value.v === 2 && value.scope === scope && value.owner === owner && (scope === "org" ? value.repo === undefined || value.repo === null : value.repo === repo);

export const normalizeKernelQuotaPolicyV2 = (value: unknown, scope: KernelQuotaScope, owner: string, repo: string | undefined): KernelQuotaPolicyV2 | null => {
  if (!isRecord(value) || !validIdentity(scope, owner, repo, value)) return null;
  if (!nonNegativeSafeInteger(value.created_at_ms) || !nonNegativeSafeInteger(value.updated_at_ms)) return null;
  const windowMs = normalizeWindow(value.window_ms, 0);
  const limit = normalizeUsageLimit(value.usage_limit_requests, Number.NaN);
  if (!positiveSafeInteger(windowMs) || !(limit === API_KEY_NO_USAGE_LIMIT || nonNegativeSafeInteger(limit))) {
    return null;
  }
  const expiresAtMs = normalizeExpiration(value.expires_at_ms);
  return {
    v: 2,
    scope,
    owner,
    ...(scope === "repo" ? { repo } : {}),
    usage_limit_requests: limit,
    window_ms: windowMs,
    expires_at_ms: expiresAtMs,
    created_at_ms: value.created_at_ms,
    updated_at_ms: value.updated_at_ms,
  };
};

export const normalizeKernelQuotaWindowV2 = (value: unknown, scope: KernelQuotaScope, owner: string, repo: string | undefined): KernelQuotaWindowV2 | null => {
  if (!isRecord(value) || !validIdentity(scope, owner, repo, value)) return null;
  const reservedRequests = value.reserved_requests === undefined ? 0 : value.reserved_requests;
  if (
    !nonNegativeSafeInteger(value.usage_requests) ||
    !nonNegativeSafeInteger(reservedRequests) ||
    !positiveSafeInteger(value.usage_reset_at_ms) ||
    !positiveSafeInteger(value.applied_window_ms) ||
    !nonNegativeSafeInteger(value.created_at_ms) ||
    !nonNegativeSafeInteger(value.updated_at_ms)
  )
    return null;
  return {
    v: 2,
    scope,
    owner,
    ...(scope === "repo" ? { repo } : {}),
    usage_requests: value.usage_requests,
    reserved_requests: reservedRequests,
    usage_reset_at_ms: value.usage_reset_at_ms,
    applied_window_ms: value.applied_window_ms,
    created_at_ms: value.created_at_ms,
    updated_at_ms: value.updated_at_ms,
  };
};

const newWindow = (scope: KernelQuotaScope, owner: string, repo: string | undefined, windowMs: number, nowMs: number): KernelQuotaWindowV2 => ({
  v: 2,
  scope,
  owner,
  ...(scope === "repo" ? { repo } : {}),
  usage_requests: 0,
  reserved_requests: 0,
  usage_reset_at_ms: nowMs + windowMs,
  applied_window_ms: windowMs,
  created_at_ms: nowMs,
  updated_at_ms: nowMs,
});

const windowForEffectivePolicy = (
  existing: KernelQuotaWindowV2 | null,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  effectiveWindowMs: number,
  nowMs: number
): KernelQuotaEffectiveWindow => {
  if (existing?.applied_window_ms !== effectiveWindowMs || existing.usage_reset_at_ms <= nowMs) {
    return { window: newWindow(scope, owner, repo, effectiveWindowMs, nowMs), needsWrite: true };
  }
  return { window: existing, needsWrite: false };
};

const policyFor = (
  entry: KvEntryMaybe<KernelQuotaPolicyV2>,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  defaults: KernelDefaults
): KernelQuotaEffectivePolicy => {
  if (entry.value === null) {
    return {
      policy: null,
      limit: defaults.limit,
      windowMs: defaults.windowMs,
      expiresAtMs: API_KEY_NO_EXPIRATION_MS,
      source: "default",
    };
  }
  const policy = normalizeKernelQuotaPolicyV2(entry.value, scope, owner, repo);
  if (!policy) {
    // A corrupt explicit policy must never silently turn into a permissive
    // default; callers surface it as an unavailable quota record.
    throw new Error("kernel quota policy is malformed");
  }
  return {
    policy,
    limit: policy.usage_limit_requests,
    windowMs: policy.window_ms,
    expiresAtMs: policy.expires_at_ms,
    source: "kv",
  };
};

const isExpired = (expiresAtMs: number, nowMs: number): boolean => expiresAtMs !== API_KEY_NO_EXPIRATION_MS && expiresAtMs <= nowMs;

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
