import type { KvKey } from "#kv";
import { isRecord } from "../utils.ts";
import type {
  KernelQuotaConstants,
  KernelQuotaScope,
  KernelQuotaPolicyV2,
  KernelQuotaWindowV2,
  KernelQuotaReservationRowV2,
  KernelDefaultWindowCutoverV2,
  KernelQuotaDefaults,
  KernelQuotaEffectivePolicy,
  KernelQuotaEffectiveWindow,
  KernelReservationSettlement,
  KernelQuotaIdentity,
  KernelQuotaReservationIdentity,
  KernelQuotaRead,
  KernelQuotaEligibilitySnapshot,
  KernelQuotaEligibilityPlan,
  KernelQuotaReservePlan,
  KernelQuotaTerminalPlan,
  KernelQuotaSettlePlan,
  KernelQuotaCutoverPlan,
  KernelQuotaPolicySetOptions,
  KernelQuotaPolicyWritePlan,
} from "./native-kernel-contracts.ts";
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
export const KERNEL_QUOTA_RESERVATION_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const KERNEL_DEFAULT_WINDOW_CUTOVER_LEASE_MS = 5 * 60_000;
export const KERNEL_QUOTA_SETTLEMENT_RETRY_MS = 1_000;

export const MAX_KV_RETRIES = 3;

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

/**
 * Repo-scope keys are only ever built once a repo is known to be present. The
 * invariant is asserted here so a missing repo fails loudly instead of reaching
 * Deno KV as an `undefined` key part.
 */
export const kernelRepoPart = (repo: string | undefined): string => {
  if (repo === undefined) throw new Error("Kernel quota repo scope requires a repo");
  return repo;
};

export const kernelScopedPolicyKey = (scope: KernelQuotaScope, owner: string, repo: string | undefined): KvKey =>
  scope === "repo" ? kernelRepoPolicyKey(owner, kernelRepoPart(repo)) : kernelOrgPolicyKey(owner);

export const kernelScopedWindowKey = (scope: KernelQuotaScope, owner: string, repo: string | undefined): KvKey =>
  scope === "repo" ? kernelRepoWindowKey(owner, kernelRepoPart(repo)) : kernelOrgWindowKey(owner);

export const kernelPolicyKeys = (scope: KernelQuotaScope, owner: string, repo: string | undefined): Readonly<{ policyKey: KvKey; windowKey: KvKey }> => ({
  policyKey: kernelScopedPolicyKey(scope, owner, repo),
  windowKey: kernelScopedWindowKey(scope, owner, repo),
});

/** A window that still holds reservations that have not passed their reset time. */
export const hasLiveKernelReservations = (window: KernelQuotaWindowV2 | null, nowMs: number): window is KernelQuotaWindowV2 =>
  window !== null && window.usage_reset_at_ms > nowMs && window.reserved_requests > 0;

export const positiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const nonNegativeSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const normalizeUsageLimit = (value: unknown, fallback: number, noUsageLimit: number): number => {
  if (typeof value === "string") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.trunc(value);
  if (parsed === noUsageLimit) return parsed;
  return parsed >= 0 ? parsed : fallback;
};

export const normalizeWindow = (value: unknown, fallback: number): number => {
  if (typeof value === "string") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : fallback;
};

export const normalizeExpiration = (value: unknown, noExpirationMs: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return noExpirationMs;
  const parsed = Math.trunc(value);
  return parsed === noExpirationMs || parsed >= 0 ? parsed : noExpirationMs;
};

export const validIdentity = (scope: KernelQuotaScope, owner: string, repo: string | undefined, value: Record<string, unknown>): boolean =>
  value.v === 2 && value.scope === scope && value.owner === owner && (scope === "org" ? value.repo === undefined || value.repo === null : value.repo === repo);

export const normalizeKernelQuotaPolicyV2 = (
  value: unknown,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  constants: KernelQuotaConstants
): KernelQuotaPolicyV2 | null => {
  if (!isRecord(value) || !validIdentity(scope, owner, repo, value)) return null;
  if (!nonNegativeSafeInteger(value.created_at_ms) || !nonNegativeSafeInteger(value.updated_at_ms)) return null;
  const windowMs = normalizeWindow(value.window_ms, 0);
  const limit = normalizeUsageLimit(value.usage_limit_requests, Number.NaN, constants.noUsageLimit);
  if (!positiveSafeInteger(windowMs) || !(limit === constants.noUsageLimit || nonNegativeSafeInteger(limit))) {
    return null;
  }
  const expiresAtMs = normalizeExpiration(value.expires_at_ms, constants.noExpirationMs);
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

export const newWindow = (scope: KernelQuotaScope, owner: string, repo: string | undefined, windowMs: number, nowMs: number): KernelQuotaWindowV2 => ({
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

export const windowForEffectivePolicy = (
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

export const policyFor = (
  entry: KernelQuotaRead,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  defaults: KernelQuotaDefaults,
  constants: KernelQuotaConstants
): KernelQuotaEffectivePolicy => {
  if (entry.value === null) {
    return {
      policy: null,
      limit: defaults.limit,
      windowMs: defaults.windowMs,
      expiresAtMs: constants.noExpirationMs,
      source: "default",
    };
  }
  const policy = normalizeKernelQuotaPolicyV2(entry.value, scope, owner, repo, constants);
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

export const isExpired = (expiresAtMs: number, nowMs: number, noExpirationMs: number): boolean => expiresAtMs !== noExpirationMs && expiresAtMs <= nowMs;

export const kernelReservationRetentionMs = (windowResetAtMs: number, nowMs: number): number =>
  Math.max(1, windowResetAtMs + KERNEL_QUOTA_RESERVATION_RETENTION_MS - nowMs);

export const kernelReservationKey = (scope: KernelQuotaScope, owner: string, repo: string | undefined, windowCreatedAtMs: number, requestId: string): KvKey =>
  scope === "repo"
    ? kernelRepoReservationKey(owner, kernelRepoPart(repo), windowCreatedAtMs, requestId)
    : kernelOrgReservationKey(owner, windowCreatedAtMs, requestId);

export const kernelReservationWindowPrefix = (scope: KernelQuotaScope, owner: string, repo: string | undefined, windowCreatedAtMs: number): KvKey =>
  scope === "repo"
    ? [...KERNEL_REPO_RESERVATION_V2_PREFIX, owner, kernelRepoPart(repo), windowCreatedAtMs]
    : [...KERNEL_ORG_RESERVATION_V2_PREFIX, owner, windowCreatedAtMs];

export const normalizeKernelQuotaReservationRowV2 = (
  value: unknown,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined
): KernelQuotaReservationRowV2 | null => {
  if (!isRecord(value) || !validIdentity(scope, owner, repo, value)) return null;
  const terminalIntent = value.terminal_intent === undefined ? null : value.terminal_intent;
  if (
    typeof value.request_id !== "string" ||
    !value.request_id ||
    typeof value.route !== "string" ||
    !value.route ||
    !nonNegativeSafeInteger(value.window_created_at_ms) ||
    !positiveSafeInteger(value.window_reset_at_ms) ||
    (value.state !== "reserved" && value.state !== "committed" && value.state !== "released") ||
    (terminalIntent !== null && terminalIntent !== "committed" && terminalIntent !== "released") ||
    !nonNegativeSafeInteger(value.reserved_at_ms) ||
    !positiveSafeInteger(value.lease_expires_at_ms) ||
    !(value.committed_at_ms === null || nonNegativeSafeInteger(value.committed_at_ms)) ||
    !(value.released_at_ms === null || nonNegativeSafeInteger(value.released_at_ms)) ||
    !(value.release_reason === null || typeof value.release_reason === "string")
  )
    return null;
  if (value.window_reset_at_ms <= value.window_created_at_ms || value.lease_expires_at_ms <= value.reserved_at_ms) return null;
  if (
    (value.state === "reserved" && (value.committed_at_ms !== null || value.released_at_ms !== null || value.release_reason !== null)) ||
    (value.state === "committed" &&
      (value.committed_at_ms === null || value.released_at_ms !== null || value.release_reason !== null || terminalIntent === "released")) ||
    (value.state === "released" &&
      (value.committed_at_ms !== null ||
        value.released_at_ms === null ||
        typeof value.release_reason !== "string" ||
        value.release_reason.trim() === "" ||
        terminalIntent === "committed"))
  )
    return null;
  return { ...value, terminal_intent: terminalIntent } as KernelQuotaReservationRowV2;
};

/**
 * True when the stored row is the reservation this request owns, identified by its
 * request id, route, and window.
 */
export const kernelReservationMatchesRequest = (
  reservation: KernelQuotaReservationRowV2 | null,
  requestId: string,
  route: string,
  windowCreatedAtMs: number
): reservation is KernelQuotaReservationRowV2 =>
  reservation !== null && reservation.request_id === requestId && reservation.route === route && reservation.window_created_at_ms === windowCreatedAtMs;

/**
 * Reads one reservation row from a listing. A row whose key, request id, or window
 * disagrees with the listing is malformed rather than merely unknown.
 */
export const requireKernelReservationRow = (
  key: KvKey,
  value: unknown,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  windowCreatedAtMs: number
): KernelQuotaReservationRowV2 => {
  const reservation = normalizeKernelQuotaReservationRowV2(value, scope, owner, repo);
  const requestId = key.at(-1);
  if (!reservation || typeof requestId !== "string" || requestId !== reservation.request_id || reservation.window_created_at_ms !== windowCreatedAtMs) {
    throw new Error("Kernel quota reservation is malformed");
  }
  return reservation;
};

/**
 * Terminal-state precondition for a known reservation row: a row owned by another
 * request is invalid, an already-terminal row is settled or mismatched.
 */
export const kernelReservationPrecondition = (
  reservation: KernelQuotaReservationRowV2,
  requestId: string,
  route: string,
  windowCreatedAtMs: number,
  terminalState: "committed" | "released"
): KernelReservationSettlement | null => {
  if (!kernelReservationMatchesRequest(reservation, requestId, route, windowCreatedAtMs)) return "invalid";
  if (reservation.state !== "reserved") return reservation.state === terminalState ? "settled" : "terminal_mismatch";
  if (reservation.terminal_intent !== null && reservation.terminal_intent !== terminalState) return "terminal_mismatch";
  return null;
};

/** Builds the terminal row of a settled reservation, mirroring the terminal state. */
export const settledKernelReservationRow = (
  reservation: KernelQuotaReservationRowV2,
  terminalState: "committed" | "released",
  reason: string,
  nowMs: number
): KernelQuotaReservationRowV2 =>
  terminalState === "committed"
    ? { ...reservation, state: "committed", terminal_intent: "committed", committed_at_ms: nowMs }
    : {
        ...reservation,
        state: "released",
        terminal_intent: "released",
        released_at_ms: nowMs,
        release_reason: reason.slice(0, 120) || "request_incomplete",
      };

export const normalizeKernelDefaultWindowCutoverV2 = (value: unknown): KernelDefaultWindowCutoverV2 | null => {
  if (
    !isRecord(value) ||
    value.v !== 2 ||
    typeof value.id !== "string" ||
    !value.id ||
    !nonNegativeSafeInteger(value.created_at_ms) ||
    !positiveSafeInteger(value.expires_at_ms) ||
    value.expires_at_ms <= value.created_at_ms
  )
    return null;
  return value as KernelDefaultWindowCutoverV2;
};

/** Owner and repo encoded in a listed window key, validated against the scope. */
export const kernelWindowScopeTarget = (
  scope: KernelQuotaScope,
  key: KvKey,
  prefix: readonly string[]
): Readonly<{ owner: string; repo: string | undefined }> => {
  const ownerPart = key[prefix.length];
  if (typeof ownerPart !== "string" || !ownerPart) throw new Error("Kernel quota window key is malformed");
  const repoPart = key[prefix.length + 1];
  const repo = scope === "repo" && typeof repoPart === "string" && repoPart ? repoPart : undefined;
  if (scope === "repo" && !repo) throw new Error("Kernel repo quota window key is malformed");
  return { owner: ownerPart, repo };
};

export const decideKernelQuotaScope = (
  snapshot: Readonly<{ repoPolicy: KernelQuotaRead; orgPolicy: KernelQuotaRead }>,
  owner: string,
  repo: string,
  constants: KernelQuotaConstants
) => {
  if (snapshot.repoPolicy.value !== null && !normalizeKernelQuotaPolicyV2(snapshot.repoPolicy.value, "repo", owner, repo, constants)) {
    throw new Error("Kernel repo quota policy is malformed");
  }
  if (snapshot.orgPolicy.value !== null && !normalizeKernelQuotaPolicyV2(snapshot.orgPolicy.value, "org", owner, undefined, constants)) {
    throw new Error("Kernel org quota policy is malformed");
  }
  return snapshot.repoPolicy.value !== null
    ? { limit_scope: "repo" as const, has_policy: true }
    : { limit_scope: "org" as const, has_policy: snapshot.orgPolicy.value !== null };
};

export const decideKernelQuotaEligibility = (
  identity: KernelQuotaIdentity,
  snapshot: KernelQuotaEligibilitySnapshot,
  defaults: KernelQuotaDefaults,
  constants: KernelQuotaConstants,
  nowMs: number
): KernelQuotaEligibilityPlan => {
  if (
    (snapshot.expectedRepoPolicy === "present" && snapshot.policy.value === null) ||
    (snapshot.expectedRepoPolicy === "absent" && snapshot.repoGuard !== null && snapshot.repoGuard.value !== null)
  )
    return { kind: "refused", status: 503, message: "Kernel quota policy scope changed; retry" };
  const effective = policyFor(snapshot.policy, identity.scope, identity.owner, identity.repo, defaults, constants);
  if (kernelQuotaDefaultCutoverBlocks(effective, snapshot.defaultCutover)) {
    return { kind: "refused", status: 503, message: "Kernel quota defaults are changing; retry" };
  }
  if (isExpired(effective.expiresAtMs, nowMs, constants.noExpirationMs)) {
    return { kind: "refused", status: 429, message: "Kernel auth usage limit expired; update it via /admin/kernel-usage." };
  }
  if (effective.limit === 0) return { kind: "refused", status: 429, message: "Kernel auth usage limit is 0; update it via /admin/kernel-usage." };
  return { kind: "eligible", effective };
};

export const decideKernelQuotaReserve = (
  identity: KernelQuotaIdentity,
  effective: KernelQuotaEffectivePolicy,
  window: KernelQuotaWindowV2,
  reservationEntry: KernelQuotaRead,
  requestId: string,
  route: string,
  noUsageLimit: number,
  nowMs: number
): KernelQuotaReservePlan => {
  if (reservationEntry.value !== null) {
    const existing = normalizeKernelQuotaReservationRowV2(reservationEntry.value, identity.scope, identity.owner, identity.repo);
    if (!kernelReservationMatchesRequest(existing, requestId, route, window.created_at_ms)) {
      return { kind: "refused", status: 503, message: "Kernel quota request identity conflicts" };
    }
    return { kind: "refused", status: 503, message: "Kernel quota request already has a reservation" };
  }
  if (effective.limit !== noUsageLimit && window.usage_requests + window.reserved_requests >= effective.limit) {
    return { kind: "full", window, limit: effective.limit };
  }
  const reservation: KernelQuotaReservationRowV2 = {
    v: 2,
    scope: identity.scope,
    owner: identity.owner,
    ...(identity.scope === "repo" ? { repo: identity.repo } : {}),
    request_id: requestId,
    route,
    window_created_at_ms: window.created_at_ms,
    window_reset_at_ms: window.usage_reset_at_ms,
    state: "reserved",
    terminal_intent: null,
    reserved_at_ms: nowMs,
    lease_expires_at_ms: nowMs + KERNEL_QUOTA_RESERVATION_LEASE_MS,
    committed_at_ms: null,
    released_at_ms: null,
    release_reason: null,
  };
  const reservedWindow: KernelQuotaWindowV2 = { ...window, reserved_requests: window.reserved_requests + 1, updated_at_ms: nowMs };
  return { kind: "reserve", reservation, window: reservedWindow, expireIn: kernelReservationRetentionMs(reservedWindow.usage_reset_at_ms, nowMs) };
};

export const decideKernelQuotaTerminalIntent = (
  identity: KernelQuotaReservationIdentity,
  snapshot: KernelQuotaRead,
  terminalState: "committed" | "released",
  nowMs: number
): KernelQuotaTerminalPlan => {
  const reservation = normalizeKernelQuotaReservationRowV2(snapshot.value, identity.scope, identity.owner, identity.repo);
  if (!reservation) return { kind: "unchanged", outcome: snapshot.value === null ? "missing" : "invalid" };
  const outcome = kernelReservationPrecondition(reservation, identity.requestId, identity.route, identity.windowCreatedAtMs, terminalState);
  if (outcome) return { kind: "unchanged", outcome };
  const leaseExpiresAtMs = nowMs + KERNEL_QUOTA_RESERVATION_LEASE_MS;
  return {
    kind: "intent",
    reservation: { ...reservation, terminal_intent: terminalState, lease_expires_at_ms: leaseExpiresAtMs },
    expireIn: kernelReservationRetentionMs(reservation.window_reset_at_ms, nowMs),
    leaseExpiresAtMs,
  };
};

/** The native adapter reconciles legacy window cardinality before this decision. */
export const decideKernelQuotaSettlement = (
  reservation: KernelQuotaReservationRowV2,
  snapshot: Readonly<{ window: KernelQuotaWindowV2 | null; windowPresent: boolean }>,
  terminalState: "committed" | "released",
  reason: string,
  nowMs: number
): KernelQuotaSettlePlan => {
  const window = snapshot.window;
  if (snapshot.windowPresent && !window) return { kind: "unchanged", outcome: "invalid" };
  const expireIn = kernelReservationRetentionMs(reservation.window_reset_at_ms, nowMs);
  if (window?.created_at_ms !== reservation.window_created_at_ms) {
    return { kind: "settle", reservation: settledKernelReservationRow(reservation, terminalState, reason, nowMs), window: null, expireIn };
  }
  if (window.reserved_requests < 1) return { kind: "unchanged", outcome: "invalid" };
  const settled = settledKernelReservationRow(reservation, terminalState, reason, nowMs);
  return {
    kind: "settle",
    reservation: settled,
    window: {
      ...window,
      usage_requests: window.usage_requests + (terminalState === "committed" ? 1 : 0),
      reserved_requests: window.reserved_requests - 1,
      updated_at_ms: nowMs,
    },
    expireIn,
  };
};

export const decideKernelQuotaRenewal = (identity: KernelQuotaReservationIdentity, snapshot: KernelQuotaRead, nowMs: number) => {
  const reservation = normalizeKernelQuotaReservationRowV2(snapshot.value, identity.scope, identity.owner, identity.repo);
  if (!kernelReservationMatchesRequest(reservation, identity.requestId, identity.route, identity.windowCreatedAtMs)) {
    throw new Error("Kernel quota reservation is missing or malformed");
  }
  if (reservation.state !== "reserved") throw new Error(`Kernel quota reservation was already ${reservation.state}`);
  const leaseExpiresAtMs = nowMs + KERNEL_QUOTA_RESERVATION_LEASE_MS;
  return {
    reservation: { ...reservation, lease_expires_at_ms: leaseExpiresAtMs },
    expireIn: kernelReservationRetentionMs(reservation.window_reset_at_ms, nowMs),
    leaseExpiresAtMs,
  };
};

export const decideKernelQuotaReclaim = (reservation: KernelQuotaReservationRowV2, nowMs: number): "committed" | "released" | null =>
  reservation.state !== "reserved" || reservation.lease_expires_at_ms > nowMs ? null : (reservation.terminal_intent ?? "released");

export const decideKernelDefaultWindowCutover = (snapshot: KernelQuotaRead, id: string, nowMs: number): KernelQuotaCutoverPlan => {
  if (snapshot.value !== null) {
    return { kind: "refused", reason: normalizeKernelDefaultWindowCutoverV2(snapshot.value) ? "concurrent_change" : "unavailable" };
  }
  return {
    kind: "acquire",
    marker: { v: 2, id, created_at_ms: nowMs, expires_at_ms: nowMs + KERNEL_DEFAULT_WINDOW_CUTOVER_LEASE_MS },
    expireIn: KERNEL_DEFAULT_WINDOW_CUTOVER_LEASE_MS,
  };
};

export const kernelDefaultWindowCutoverAcquired = (snapshot: KernelQuotaRead, id: string): boolean =>
  normalizeKernelDefaultWindowCutoverV2(snapshot.value)?.id === id && snapshot.revision !== null;

export const resolveKernelPolicyTiming = (options: KernelQuotaPolicySetOptions, current: KernelQuotaEffectivePolicy, noExpirationMs: number) => ({
  windowMs: options.windowMs === undefined ? current.windowMs : normalizeWindow(options.windowMs, current.windowMs),
  expiresAtMs: options.expiresAtMs === undefined ? current.expiresAtMs : normalizeExpiration(options.expiresAtMs, noExpirationMs),
});

export const decideKernelPolicyWindowGuard = (
  window: KernelQuotaWindowV2 | null,
  windowPresent: boolean,
  reset: boolean,
  nowMs: number
): Readonly<{ kind: "abort" | "proceed" }> | Readonly<{ kind: "reclaim"; window: KernelQuotaWindowV2 }> => {
  if (windowPresent && !window) return { kind: "abort" };
  if (reset && hasLiveKernelReservations(window, nowMs)) return { kind: "reclaim", window };
  return { kind: "proceed" };
};

export const makeKernelQuotaPolicy = (
  identity: KernelQuotaIdentity,
  current: KernelQuotaEffectivePolicy,
  usageLimitRequests: number,
  timing: Readonly<{ windowMs: number; expiresAtMs: number }>,
  noUsageLimit: number,
  nowMs: number
): KernelQuotaPolicyV2 => ({
  v: 2,
  scope: identity.scope,
  owner: identity.owner,
  ...(identity.scope === "repo" ? { repo: identity.repo } : {}),
  usage_limit_requests: normalizeUsageLimit(usageLimitRequests, current.limit, noUsageLimit),
  window_ms: timing.windowMs,
  expires_at_ms: timing.expiresAtMs,
  created_at_ms: current.policy?.created_at_ms ?? nowMs,
  updated_at_ms: nowMs,
});

export const decideKernelQuotaPolicyWrite = (
  identity: KernelQuotaIdentity,
  policy: KernelQuotaPolicyV2,
  currentWindow: KernelQuotaWindowV2 | null,
  reset: boolean,
  nowMs: number
): KernelQuotaPolicyWritePlan => {
  const baseWindow = reset
    ? newWindow(identity.scope, identity.owner, identity.repo, policy.window_ms, nowMs)
    : windowForEffectivePolicy(currentWindow, identity.scope, identity.owner, identity.repo, policy.window_ms, nowMs).window;
  return { policy, window: reset ? baseWindow : { ...baseWindow, updated_at_ms: nowMs } };
};

export const decideKernelQuotaPolicyDeleteWindow = (
  identity: KernelQuotaIdentity,
  current: KernelQuotaEffectivePolicy,
  defaults: KernelQuotaDefaults,
  oldWindow: KernelQuotaWindowV2 | null,
  nowMs: number
): KernelQuotaWindowV2 =>
  current.windowMs === defaults.windowMs
    ? windowForEffectivePolicy(oldWindow, identity.scope, identity.owner, identity.repo, defaults.windowMs, nowMs).window
    : newWindow(identity.scope, identity.owner, identity.repo, defaults.windowMs, nowMs);

export const kernelQuotaDefaultCutoverBlocks = (current: KernelQuotaEffectivePolicy, marker: KernelQuotaRead): boolean =>
  current.source === "default" && marker.value !== null;

export const kernelQuotaPolicyResetRequested = (options: KernelQuotaPolicySetOptions, currentWindowMs: number, nextWindowMs: number): boolean =>
  options.resetUsage === true || currentWindowMs !== nextWindowMs;

export const decideKernelQuotaPolicyDeletePrecondition = (
  snapshot: Readonly<{ policy: KernelQuotaRead; defaultCutover: KernelQuotaRead }>
): "absent" | "conflict" | "proceed" => {
  if (snapshot.policy.value === null) return "absent";
  return snapshot.defaultCutover.value !== null ? "conflict" : "proceed";
};
