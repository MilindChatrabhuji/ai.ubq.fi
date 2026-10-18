import type {
  NativePaidKey,
  NativePaidAdmissionInput,
  NativePaidAdmissionSnapshot,
  NativePaidAdmissionPolicy,
  NativePaidAdmissionPlan,
  NativePaidLifecyclePlan,
  NativePaidReleaseSnapshot,
  NativePaidReleasePlan,
  NativePaidDeferralPlan,
  NativePaidProviderLog,
  NativePaidCorrelation,
  NativePaidSettlementPlan,
  NativePaidTerminalUsage,
  NativePaidRollupIdentity,
  NativePaidSettlementMetadata,
  NativePaidSettlementEvaluation,
  NativePaidSettlementSnapshot,
  PaidFallbackRequestV3,
  PaidFallbackWindowV3,
  PaidFallbackPendingV3,
  PaidFallbackReconciliationGateV3,
  PaidFallbackReconciliationLeaseV3,
  PaidFallbackBackfillLeaseV3,
  PaidFallbackBackfillStateV3,
  PaidFallbackDeletionGuardV3,
  PaidFallbackAdmissionV3,
  PaidFallbackOutstandingV3,
  PaidFallbackRequestLifecyclePatchV3,
  ResolvedRequestLifecycleV3,
  PaidFallbackUsageRollup,
  PaidFallbackUsageRollupInput,
  TerminalUsageRollupInput,
} from "./native-paid-contracts.ts";
import { isRecord } from "../utils.ts";

const PREFIX = ["uos_ai", "paid_fallback", "v3"] as const;
const MAX_CAS_ATTEMPTS = 128;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
const UNRESOLVED_AFTER_MS = 24 * 60 * 60_000;
const RECONCILIATION_LEASE_MS = 60_000;
const PAID_FALLBACK_BACKFILL_LEASE_MS = 5 * 60_000;
const PAID_FALLBACK_AUTOMATIC_BACKFILL_LIMIT = 5_000;

/**
 * Raw paid-fallback request rows are retained for one year from request
 * creation, then expire. Research that needs older data reads the compact
 * per-hour usage rollups (paid_fallback_rollups.ts), which never expire.
 */
export const PAID_FALLBACK_REQUEST_LOG_RETENTION_MS = 365 * 24 * 60 * 60_000;

export const requestRowExpireIn = (row: PaidFallbackRequestV3, nowMs: number): number =>
  Math.max(1, row.created_at_ms + PAID_FALLBACK_REQUEST_LOG_RETENTION_MS - nowMs);

const isSafeUsageCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isApiKeyId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

/**
 * Window rows expire one year after their reset so they never outlive the
 * request rows that validate them; the per-request detail is gone by then.
 */
const windowExpireIn = (window: PaidFallbackWindowV3, nowMs: number): number =>
  Math.max(1, window.window_reset_at_ms + PAID_FALLBACK_REQUEST_LOG_RETENTION_MS - nowMs);

export const isPaidFallbackWindowV3 = (value: unknown): value is PaidFallbackWindowV3 => {
  if (!isRecord(value)) return false;
  return (
    value.v === 3 &&
    isApiKeyId(value.key_id) &&
    typeof value.policy_version === "string" &&
    value.policy_version.length > 0 &&
    isPositiveSafeInteger(value.window_reset_at_ms) &&
    (value.limit_microcredits === -1 || isPositiveSafeInteger(value.limit_microcredits)) &&
    isSafeUsageCount(value.settled_microcredits) &&
    isSafeUsageCount(value.reserved_microcredits) &&
    isSafeUsageCount(value.pending_count) &&
    isPositiveSafeInteger(value.updated_at_ms)
  );
};

export const paidFallbackWindowV3Key = (keyId: string, resetAtMs: number): NativePaidKey => [...PREFIX, "window", keyId, resetAtMs];
export const paidFallbackRequestV3Key = (keyId: string, requestId: string): NativePaidKey => [...PREFIX, "request", keyId, requestId];
export const paidFallbackPendingV3Key = (keyId: string, requestId: string): NativePaidKey => [...PREFIX, "pending", keyId, requestId];
const paidFallbackWindowV3Prefix = (keyId: string): NativePaidKey => [...PREFIX, "window", keyId];
const paidFallbackRequestV3Prefix = (keyId: string): NativePaidKey => [...PREFIX, "request", keyId];
export const paidFallbackRequestV3GlobalPrefix: NativePaidKey = [...PREFIX, "request"];
const paidFallbackWindowV3GlobalPrefix: NativePaidKey = [...PREFIX, "window"];
const paidFallbackPendingV3Prefix = (keyId: string): NativePaidKey => [...PREFIX, "pending", keyId];
const paidFallbackPendingV3GlobalPrefix: NativePaidKey = [...PREFIX, "pending"];
export const paidFallbackReconciliationGateV3Key = (): NativePaidKey => [...PREFIX, "reconciliation_gate"];
export const paidFallbackReconciliationLeaseV3Key = (keyId: string): NativePaidKey => [...PREFIX, "reconciliation_lease", keyId];
export const paidFallbackBackfillCursorV3Key = (): NativePaidKey => [...PREFIX, "rollup_backfill_cursor"];
export const paidFallbackBackfillWindowCursorV3Key = (): NativePaidKey => [...PREFIX, "rollup_backfill_window_cursor"];
export const paidFallbackBackfillLeaseV3Key = (): NativePaidKey => [...PREFIX, "rollup_backfill_lease"];
export const paidFallbackBackfillStateV3Key = (): NativePaidKey => [...PREFIX, "rollup_backfill_state"];
export const paidFallbackDeletionGuardV3Key = (keyId: string): NativePaidKey => [...PREFIX, "deletion_guard", keyId];

const isPaidFallbackReconciliationGate = (value: unknown): value is PaidFallbackReconciliationGateV3 =>
  value !== null &&
  typeof value === "object" &&
  "next_due_at_ms" in value &&
  (value.next_due_at_ms === null || (typeof value.next_due_at_ms === "number" && Number.isSafeInteger(value.next_due_at_ms) && value.next_due_at_ms >= 0));

const paidFallbackReconciliationGateDueNow = (
  entry: Readonly<{ value: PaidFallbackReconciliationGateV3 | null }>,
  now: number
): PaidFallbackReconciliationGateV3 => {
  const current = isPaidFallbackReconciliationGate(entry.value) ? entry.value.next_due_at_ms : null;
  return { next_due_at_ms: current === null ? now : Math.min(current, now) };
};

const paidFallbackReconciliationGateNeedsArm = (entry: Readonly<{ value: PaidFallbackReconciliationGateV3 | null }>, now: number): boolean => {
  if (!isPaidFallbackReconciliationGate(entry.value)) return true;
  return entry.value.next_due_at_ms === null || entry.value.next_due_at_ms > now;
};

const defaultPaidFallbackWindowV3 = (input: NativePaidAdmissionInput): PaidFallbackWindowV3 => ({
  v: 3,
  key_id: input.keyId,
  policy_version: input.policyVersion,
  window_reset_at_ms: input.windowResetAtMs,
  limit_microcredits: input.limitMicrocredits,
  settled_microcredits: input.initialSettledMicrocredits,
  reserved_microcredits: 0,
  pending_count: 0,
  updated_at_ms: input.createdAtMs,
});

/** The row written for one admitted request. */
const buildPaidFallbackRequestV3 = (input: NativePaidAdmissionInput, reservation: number, now: number): PaidFallbackRequestV3 => ({
  v: 3,
  key_id: input.keyId,
  request_id: input.requestId,
  policy_version: input.policyVersion,
  route: input.route,
  path: input.path,
  model: input.model,
  stream: input.stream,
  reasoning: input.reasoning,
  window_reset_at_ms: input.windowResetAtMs,
  reserved_microcredits: reservation,
  quota_per_credit: input.quotaPerCredit,
  provider_request_id: null,
  provider_quota: null,
  input_tokens: null,
  cached_input_tokens: null,
  output_tokens: null,
  dispatch_state: input.dispatchIntent ? "dispatched" : "reserved",
  terminal_state: "pending",
  spend_microcredits: null,
  billing_state: "pending",
  reconciliation_attempts: 0,
  last_reconciliation_at_ms: null,
  dispatched_at_ms: input.dispatchIntent ? now : null,
  terminal_at_ms: null,
  settled_at_ms: null,
  created_at_ms: input.createdAtMs,
  updated_at_ms: now,
});

const existingReservationV3 = (input: NativePaidAdmissionInput, existing: PaidFallbackRequestV3): PaidFallbackAdmissionV3 => ({
  key_id: input.keyId,
  request_id: input.requestId,
  created_at_ms: existing.created_at_ms,
  reserved_microcredits: existing.reserved_microcredits,
  quota_per_credit: input.quotaPerCredit,
  window_reset_at_ms: existing.window_reset_at_ms,
  quota_used_percent: null,
});

/** True when any admission field fails its policy validation. */
const isInvalidAdmissionPolicy = (input: NativePaidAdmissionInput, unlimited: boolean, maximumExposure: number | null): boolean =>
  (!unlimited && !isPositiveSafeInteger(input.limitMicrocredits)) ||
  !Number.isSafeInteger(input.initialSettledMicrocredits) ||
  input.initialSettledMicrocredits < 0 ||
  !isPositiveSafeInteger(input.quotaPerCredit) ||
  (!unlimited && !isPositiveSafeInteger(maximumExposure));

const resolveRequestLifecyclePatchV3 = (
  current: PaidFallbackRequestV3,
  patch: PaidFallbackRequestLifecyclePatchV3,
  now: number
): ResolvedRequestLifecycleV3 => {
  const provider = current.provider ?? patch.provider;
  const providerRequestId = current.provider_request_id ?? (patch.provider_request_id === undefined ? null : patch.provider_request_id);
  const dispatchState = current.dispatch_state === "reserved" && patch.dispatch_state !== undefined ? patch.dispatch_state : current.dispatch_state;
  const terminalState = current.terminal_state === "pending" && patch.terminal_state !== undefined ? patch.terminal_state : current.terminal_state;
  const shouldIncrementReconciliationAttempts =
    patch.increment_reconciliation_attempts && (patch.terminal_state === undefined || current.terminal_state === "pending");
  const reconciliationAttempts = shouldIncrementReconciliationAttempts
    ? current.reconciliation_attempts + 1
    : (patch.reconciliation_attempts ?? current.reconciliation_attempts);
  const lastReconciliationAtMs = shouldIncrementReconciliationAttempts ? now : (patch.last_reconciliation_at_ms ?? current.last_reconciliation_at_ms);
  return { provider, providerRequestId, dispatchState, terminalState, reconciliationAttempts, lastReconciliationAtMs };
};

/** True when a resolved patch differs from the stored row. */
const requestLifecycleChangedV3 = (current: PaidFallbackRequestV3, resolved: ResolvedRequestLifecycleV3): boolean =>
  resolved.providerRequestId !== current.provider_request_id ||
  resolved.provider !== current.provider ||
  resolved.dispatchState !== current.dispatch_state ||
  resolved.terminalState !== current.terminal_state ||
  resolved.reconciliationAttempts !== current.reconciliation_attempts ||
  resolved.lastReconciliationAtMs !== current.last_reconciliation_at_ms;

/** Builds the row a resolved lifecycle patch writes. */
const buildRequestLifecycleRowV3 = (current: PaidFallbackRequestV3, resolved: ResolvedRequestLifecycleV3, now: number): PaidFallbackRequestV3 => {
  const provider = resolved.provider;
  return {
    ...current,
    ...(provider === undefined ? {} : { provider }),
    provider_request_id: resolved.providerRequestId,
    dispatch_state: resolved.dispatchState,
    terminal_state: resolved.terminalState,
    reconciliation_attempts: resolved.reconciliationAttempts,
    last_reconciliation_at_ms: resolved.lastReconciliationAtMs,
    dispatched_at_ms: resolved.dispatchState === "dispatched" && current.dispatched_at_ms === null ? now : current.dispatched_at_ms,
    terminal_at_ms: resolved.terminalState !== "pending" && current.terminal_at_ms === null ? now : current.terminal_at_ms,
    updated_at_ms: now,
  };
};

const correlationMatchesV3 = (
  request: PaidFallbackRequestV3,
  providerLog: NativePaidProviderLog,
  correlation: "provider_request_id" | "surplus_reservation"
): boolean => (correlation === "surplus_reservation" ? request.provider === "surplus" : request.provider_request_id === providerLog.request_id);

/** True when the row still needs settlement; a settled or unbilled row does not. */
const isBillableRequestV3 = (request: PaidFallbackRequestV3 | null): request is PaidFallbackRequestV3 =>
  request !== null && request.billing_state !== "settled" && request.billing_state !== "not_billed";

const buildSettledRequestRowV3 = (
  request: PaidFallbackRequestV3,
  providerLog: NativePaidProviderLog,
  spend: number,
  dispatchedAtMs: number,
  foldIntoRollup: boolean,
  now: number
): PaidFallbackRequestV3 => ({
  ...request,
  provider_quota: providerLog.quota,
  input_tokens: providerLog.prompt_tokens,
  cached_input_tokens: providerLog.cached_prompt_tokens ?? null,
  output_tokens: providerLog.completion_tokens,
  dispatch_state: request.dispatch_state === "reserved" ? "dispatched" : request.dispatch_state,
  dispatched_at_ms: dispatchedAtMs,
  spend_microcredits: spend,
  billing_state: "settled",
  // The terminal lifecycle update records the attempt that triggered this
  // lookup. Settlement itself must be replay-idempotent and not inflate
  // the attempt count when a queue delivery is duplicated.
  reconciliation_attempts: request.reconciliation_attempts,
  last_reconciliation_at_ms: now,
  settled_at_ms: request.settled_at_ms ?? now,
  updated_at_ms: now,
  // The settlement write just folded this usage into the hourly rollup;
  // mark it so a later backfill run cannot double-count it.
  ...(foldIntoRollup ? { usage_rollup_at_ms: now } : {}),
});

export const PAID_FALLBACK_USAGE_ROLLUP_PREFIX = ["uos_ai", "paid_fallback", "v3", "usage_rollup"] as const;
export const PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS = 60 * 60 * 1_000;
export const PAID_FALLBACK_USAGE_ROLLUP_SHARD_COUNT = 16;

const FNV_PRIME = 0x01000193;

/**
 * Deterministic shard for a request id: spreads concurrent settlements of one
 * model/provider across PAID_FALLBACK_USAGE_ROLLUP_SHARD_COUNT keys while
 * keeping every settlement of the same request on one key.
 */
export const paidFallbackUsageRollupShard = (requestId: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < requestId.length; index += 1) {
    hash ^= requestId.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash % PAID_FALLBACK_USAGE_ROLLUP_SHARD_COUNT;
};

/**
 * Providers whose usage the paid-fallback ledger already folds into these
 * rollups inside its settlement atomic. `PaidFallbackProvider` is exactly
 * `"metered" | "surplus"`, and both the live settlement
 * (`prepareSettlementRollupV3`) and the historical backfill
 * (`foldRequestRowIntoRollupV3`, where a legacy row without a provider label
 * defaults to `metered`) write rows under those two labels.
 * `recordTerminalUsageRollup` skips them: a terminal observation would
 * otherwise count the same request twice.
 */
export const PAID_FALLBACK_SETTLED_PROVIDERS: ReadonlySet<string> = new Set(["metered", "surplus"]);

const safeInteger = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;

const nonNegativeFinite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export const isPaidFallbackUsageRollup = (value: unknown): value is PaidFallbackUsageRollup => {
  if (!isRecord(value)) return false;
  return (
    value.v === 1 &&
    safeInteger(value.bucket_start_at_ms) &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    safeInteger(value.request_count) &&
    nonNegativeFinite(value.quota_sum) &&
    safeInteger(value.input_tokens) &&
    safeInteger(value.cached_input_tokens) &&
    safeInteger(value.output_tokens) &&
    nonNegativeFinite(value.spend_microcredits) &&
    safeInteger(value.first_request_at_ms) &&
    safeInteger(value.last_request_at_ms) &&
    safeInteger(value.updated_at_ms)
  );
};

export const paidFallbackUsageRollupKey = (bucketStartAtMs: number, model: string, provider: string, shard: number): NativePaidKey => [
  ...PAID_FALLBACK_USAGE_ROLLUP_PREFIX,
  bucketStartAtMs,
  model,
  provider,
  shard,
];

/**
 * Merges one settled request into an existing/hour bucket. Pure so tests can
 * assert sums without a KV backend.
 */
export const mergePaidFallbackUsageRollup = (existing: PaidFallbackUsageRollup | null, input: PaidFallbackUsageRollupInput): PaidFallbackUsageRollup => {
  const firstRequestAtMs = existing ? Math.min(existing.first_request_at_ms, input.request_created_at_ms) : input.request_created_at_ms;
  const lastRequestAtMs = existing ? Math.max(existing.last_request_at_ms, input.request_created_at_ms) : input.request_created_at_ms;
  return {
    v: 1,
    bucket_start_at_ms: existing?.bucket_start_at_ms ?? input.bucket_start_at_ms,
    model: existing?.model ?? input.model,
    provider: existing?.provider ?? input.provider,
    request_count: (existing?.request_count ?? 0) + 1,
    quota_sum: (existing?.quota_sum ?? 0) + input.quota,
    input_tokens: (existing?.input_tokens ?? 0) + input.input_tokens,
    cached_input_tokens: (existing?.cached_input_tokens ?? 0) + (input.cached_input_tokens ?? 0),
    output_tokens: (existing?.output_tokens ?? 0) + input.output_tokens,
    spend_microcredits: (existing?.spend_microcredits ?? 0) + input.spend_microcredits,
    first_request_at_ms: firstRequestAtMs,
    last_request_at_ms: lastRequestAtMs,
    updated_at_ms: input.updated_at_ms,
  };
};

const observedTokenCount = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
};

const isPaidFallbackBackfillState = (value: unknown): value is PaidFallbackBackfillStateV3 =>
  isRecord(value) && value.v === 1 && typeof value.completed_at_ms === "number" && Number.isSafeInteger(value.completed_at_ms) && value.completed_at_ms >= 0;

const isBackfillableSettledPaidFallbackRequest = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    value.billing_state === "settled" &&
    typeof value.model === "string" &&
    value.model.trim().length > 0 &&
    typeof value.provider_quota === "number" &&
    Number.isFinite(value.provider_quota) &&
    value.provider_quota >= 0 &&
    typeof value.spend_microcredits === "number" &&
    Number.isFinite(value.spend_microcredits) &&
    value.spend_microcredits >= 0
  );
};

const buildPaidFallbackAdmissionPlanV3 = (
  input: NativePaidAdmissionInput,
  snapshot: NativePaidAdmissionSnapshot,
  policy: NativePaidAdmissionPolicy,
  transitioned: PaidFallbackWindowV3,
  reservation: number,
  now: number
): Extract<NativePaidAdmissionPlan, { kind: "write" }> => {
  const request = buildPaidFallbackRequestV3(input, reservation, now);
  return {
    kind: "write",
    request,
    pending: { created_at_ms: now, next_reconciliation_at_ms: now },
    window: policy.unlimited
      ? null
      : {
          ...transitioned,
          reserved_microcredits: transitioned.reserved_microcredits + reservation,
          pending_count: transitioned.pending_count + 1,
          updated_at_ms: now,
        },
    reservation: {
      key_id: input.keyId,
      request_id: input.requestId,
      created_at_ms: input.createdAtMs,
      reserved_microcredits: reservation,
      quota_per_credit: input.quotaPerCredit,
      window_reset_at_ms: input.windowResetAtMs,
      quota_used_percent: policy.unlimited ? null : (100 * transitioned.settled_microcredits) / transitioned.limit_microcredits,
    },
    checkGate: !!input.dispatchIntent,
    checkPolicy: snapshot.policyFence !== undefined,
    requestExpireIn: requestRowExpireIn(request, now),
    windowExpireIn: policy.unlimited ? null : windowExpireIn(transitioned, now),
    checks: [
      "request",
      "deletionGuard",
      ...(snapshot.policyFence ? ["policy" as const] : []),
      ...(input.dispatchIntent ? ["gate" as const] : []),
      ...(!policy.unlimited ? ["window" as const] : []),
    ],
  };
};

/** Admission reads stay native; this is the source decision for those exact named rows. */
export const planPaidFallbackAdmissionV3 = (
  input: NativePaidAdmissionInput,
  snapshot: NativePaidAdmissionSnapshot,
  policy: NativePaidAdmissionPolicy,
  now: number
): NativePaidAdmissionPlan => {
  if (snapshot.deletionGuard.value) return { kind: "blocked", reason: "invalid_policy" };
  const existing = snapshot.request.value;
  if (existing) {
    if (existing.billing_state === "settled" || existing.billing_state === "not_billed") return { kind: "blocked", reason: "invalid_policy" };
    return { kind: "reserved", reservation: existingReservationV3(input, existing) };
  }
  const current = snapshot.window.value ?? defaultPaidFallbackWindowV3(input);
  const policyChanged = !policy.unlimited && (current.policy_version !== input.policyVersion || current.limit_microcredits !== input.limitMicrocredits);
  const transitioned = policyChanged
    ? { ...current, policy_version: input.policyVersion, limit_microcredits: input.limitMicrocredits, updated_at_ms: now }
    : current;
  const remaining = policy.unlimited ? 0 : transitioned.limit_microcredits - transitioned.settled_microcredits - transitioned.reserved_microcredits;
  if (!policy.unlimited && remaining <= 0)
    return policyChanged
      ? {
          kind: "exhausted_policy",
          window: transitioned,
          windowExpireIn: windowExpireIn(transitioned, now),
          checks: ["window", "deletionGuard", ...(snapshot.policyFence ? ["policy" as const] : [])],
        }
      : { kind: "blocked", reason: "limit_exceeded" };
  const reservation = policy.unlimited ? 0 : Math.min(remaining, policy.maximumExposure ?? 0);
  return buildPaidFallbackAdmissionPlanV3(input, snapshot, policy, transitioned, reservation, now);
};
export const planPaidFallbackLifecycleV3 = (
  current: PaidFallbackRequestV3,
  patch: PaidFallbackRequestLifecyclePatchV3,
  now: number
): NativePaidLifecyclePlan | null => {
  const resolved = resolveRequestLifecyclePatchV3(current, patch, now);
  if (!requestLifecycleChangedV3(current, resolved)) return null;
  const dispatchBoundary = current.dispatch_state !== "dispatched" && (resolved.dispatchState === "dispatched" || resolved.providerRequestId !== null);
  const readGate = dispatchBoundary || (current.provider_request_id === null && resolved.providerRequestId !== null);
  return {
    request: buildRequestLifecycleRowV3(current, resolved, now),
    dispatchBoundary,
    requestExpireIn: requestRowExpireIn(current, now),
    checks: readGate ? ["request", "gate"] : ["request"],
    readGate: dispatchBoundary || (current.provider_request_id === null && resolved.providerRequestId !== null),
  };
};
export const planPaidFallbackReleaseV3 = (snapshot: NativePaidReleaseSnapshot, allowDispatchIntent: boolean, now: number): NativePaidReleasePlan | null => {
  const request = snapshot.request.value;
  const window = snapshot.window.value;
  if (
    request?.billing_state !== "pending" ||
    request.provider_request_id !== null ||
    (request.dispatch_state !== "reserved" && !(allowDispatchIntent && request.dispatch_state === "dispatched"))
  )
    return null;
  return {
    request: {
      ...request,
      dispatch_state: "not_dispatched",
      terminal_state: "cancelled",
      spend_microcredits: 0,
      billing_state: "not_billed",
      terminal_at_ms: request.terminal_at_ms ?? now,
      updated_at_ms: now,
    },
    window: window
      ? {
          ...window,
          reserved_microcredits: Math.max(0, window.reserved_microcredits - request.reserved_microcredits),
          pending_count: Math.max(0, window.pending_count - 1),
          updated_at_ms: now,
        }
      : null,
    gate: paidFallbackReconciliationGateDueNow(snapshot.gate, now),
    requestExpireIn: requestRowExpireIn(request, now),
    windowExpireIn: window ? windowExpireIn(window, now) : null,
    checks: window ? ["request", "gate", "window"] : ["request", "gate"],
  };
};
export const planPaidFallbackDeferralV3 = (
  request: PaidFallbackRequestV3 | null,
  pending: PaidFallbackPendingV3 | null,
  now: number
): NativePaidDeferralPlan => {
  if (!pending) return { kind: "noop", checks: [] };
  if (!request || request.billing_state === "settled" || request.billing_state === "not_billed") return { kind: "cleanup", checks: ["pending", "gate"] };
  const attempts = request.reconciliation_attempts + 1;
  const unresolved = now - request.created_at_ms >= UNRESOLVED_AFTER_MS;
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  return {
    kind: "write",
    delay,
    requestExpireIn: requestRowExpireIn(request, now),
    checks: ["request", "pending"],
    request: {
      ...request,
      reconciliation_attempts: attempts,
      last_reconciliation_at_ms: now,
      billing_state: unresolved ? "unresolved" : request.billing_state,
      updated_at_ms: now,
    },
    pending: { ...pending, next_reconciliation_at_ms: now + delay },
  };
};
export const evaluatePaidFallbackSettlementV3 = (
  request: PaidFallbackRequestV3 | null,
  pending: PaidFallbackPendingV3 | null,
  providerLog: NativePaidProviderLog,
  metadata: NativePaidSettlementMetadata
): NativePaidSettlementEvaluation => {
  if (!isBillableRequestV3(request)) return { kind: "cleanup" };
  if (!pending || !correlationMatchesV3(request, providerLog, metadata.correlation)) return { kind: "noop" };
  const spend =
    metadata.correlation === "surplus_reservation" && metadata.surplusBuyerCostMicro !== undefined
      ? metadata.surplusBuyerCostMicro
      : Math.round((providerLog.quota * metadata.microcreditsPerCredit) / request.quota_per_credit);
  return !Number.isSafeInteger(spend) || spend < 0 ? { kind: "defer" } : { kind: "settle", spend };
};
export const paidFallbackRequestRollupIdentity = (
  request: PaidFallbackRequestV3,
  correlation: NativePaidCorrelation = "provider_request_id"
): NativePaidRollupIdentity => ({
  model: request.model.trim(),
  provider: request.provider ?? (correlation === "surplus_reservation" ? "surplus" : "metered"),
  bucketStartAtMs: Math.floor(request.created_at_ms / PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS) * PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS,
  shard: paidFallbackUsageRollupShard(request.request_id),
});
export const paidFallbackSettlementRollupV3 = (
  request: PaidFallbackRequestV3,
  providerLog: NativePaidProviderLog,
  spend: number,
  correlation: NativePaidCorrelation,
  existing: PaidFallbackUsageRollup | null,
  now: number
): Readonly<{ rollup: PaidFallbackUsageRollup; foldIntoRollup: boolean }> => {
  const { model, provider, bucketStartAtMs } = paidFallbackRequestRollupIdentity(request, correlation);
  return {
    foldIntoRollup: model !== "" && provider !== "",
    rollup: mergePaidFallbackUsageRollup(existing, {
      bucket_start_at_ms: bucketStartAtMs,
      request_id: request.request_id,
      model,
      provider,
      quota: providerLog.quota,
      input_tokens: providerLog.prompt_tokens,
      cached_input_tokens: providerLog.cached_prompt_tokens ?? null,
      output_tokens: providerLog.completion_tokens,
      spend_microcredits: spend,
      request_created_at_ms: request.created_at_ms,
      updated_at_ms: now,
    }),
  };
};
export const planPaidFallbackSettlementRowsV3 = (
  snapshot: NativePaidSettlementSnapshot,
  providerLog: NativePaidProviderLog,
  spend: number,
  foldIntoRollup: boolean,
  now: number
): NativePaidSettlementPlan => {
  const request = snapshot.request.value;
  if (!request) throw new Error("Paid fallback settlement request is missing");
  const window = snapshot.window.value;
  const dispatchedAtMs = request.dispatched_at_ms ?? Math.max(request.created_at_ms, providerLog.created_at * 1000);
  return {
    request: buildSettledRequestRowV3(request, providerLog, spend, dispatchedAtMs, foldIntoRollup, now),
    window: window
      ? {
          ...window,
          settled_microcredits: window.settled_microcredits + spend,
          reserved_microcredits: Math.max(0, window.reserved_microcredits - request.reserved_microcredits),
          pending_count: Math.max(0, window.pending_count - 1),
          updated_at_ms: now,
        }
      : null,
    gate: paidFallbackReconciliationGateDueNow(snapshot.gate, now),
    requestExpireIn: requestRowExpireIn(request, now),
    windowExpireIn: window ? windowExpireIn(window, now) : null,
    checks: ["request", "pending", ...(foldIntoRollup ? ["rollup" as const] : []), "gate", ...(window ? ["window" as const] : [])],
  };
};
export const planPaidFallbackBackfillFoldV3 = (request: PaidFallbackRequestV3, existing: PaidFallbackUsageRollup | null, now: number) => {
  const settled = request.billing_state === "settled" && request.provider_quota !== null && request.spend_microcredits !== null;
  const { model, provider, bucketStartAtMs } = paidFallbackRequestRollupIdentity(request);
  return {
    request: { ...request, updated_at_ms: now, usage_rollup_at_ms: now },
    requestExpireIn: requestRowExpireIn(request, now),
    checks: ["request", ...(settled && model ? ["rollup"] : [])],
    rollup:
      settled && model
        ? mergePaidFallbackUsageRollup(existing, {
            bucket_start_at_ms: bucketStartAtMs,
            request_id: request.request_id,
            model,
            provider,
            quota: request.provider_quota,
            input_tokens: request.input_tokens ?? 0,
            cached_input_tokens: request.cached_input_tokens ?? null,
            output_tokens: request.output_tokens ?? 0,
            spend_microcredits: request.spend_microcredits,
            request_created_at_ms: request.created_at_ms,
            updated_at_ms: now,
          })
        : null,
  };
};
export const paidFallbackBackfillRollupEligibleV3 = (request: PaidFallbackRequestV3): boolean =>
  request.billing_state === "settled" && request.provider_quota !== null && request.spend_microcredits !== null && !!request.model.trim();
export const paidFallbackBackfillNeedsSweepV3 = (state: unknown, requestCursor: unknown, windowCursor: unknown): boolean =>
  !isPaidFallbackBackfillState(state) || requestCursor !== null || windowCursor !== null;
export const planPaidFallbackDeletionGuardV3 = (guard: PaidFallbackDeletionGuardV3 | null, now: number): PaidFallbackDeletionGuardV3 | null =>
  guard ? null : { created_at_ms: now };
export const planPaidFallbackDeletionV3 = (outstanding: PaidFallbackOutstandingV3 | null) => {
  if (outstanding === null) return { kind: "unavailable" as const };
  if (outstanding.has_outstanding) return { kind: "blocked" as const, outstanding };
  return { kind: "delete" as const };
};
export const paidFallbackLeaseActiveV3 = (lease: PaidFallbackReconciliationLeaseV3 | null, now: number): boolean => !!lease && lease.expires_at_ms > now;
export const paidFallbackReconciliationLeaseV3 = (token: string, now: number): PaidFallbackReconciliationLeaseV3 => ({
  token,
  expires_at_ms: now + RECONCILIATION_LEASE_MS,
});
export const paidFallbackBackfillLeaseV3 = (token: string, now: number): PaidFallbackBackfillLeaseV3 => ({
  token,
  expires_at_ms: now + PAID_FALLBACK_BACKFILL_LEASE_MS,
});
export const paidFallbackLeaseOwnedV3 = (lease: PaidFallbackReconciliationLeaseV3 | null, token: string): boolean => lease?.token === token;
export const paidFallbackGateAfterScanV3 = (earliestDueAtMs: number | null): PaidFallbackReconciliationGateV3 => ({ next_due_at_ms: earliestDueAtMs });
export const paidFallbackTerminalUsageV3 = (input: TerminalUsageRollupInput): NativePaidTerminalUsage | null => {
  const model = input.model?.trim() ?? "";
  const provider = input.provider?.trim() ?? "";
  if (!model || !provider || provider === "gateway" || provider === "mixed" || PAID_FALLBACK_SETTLED_PROVIDERS.has(provider)) return null;
  const inputTokens = observedTokenCount(input.input_tokens);
  const outputTokens = observedTokenCount(input.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  return { model, provider, inputTokens, outputTokens };
};
export const paidFallbackTerminalRollupV3 = (
  input: TerminalUsageRollupInput,
  usage: NativePaidTerminalUsage,
  requestId: string,
  now: number
): PaidFallbackUsageRollupInput => {
  const requested = input.request_created_at_ms;
  const created = typeof requested === "number" && Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : now;
  return {
    bucket_start_at_ms: Math.floor(created / PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS) * PAID_FALLBACK_USAGE_ROLLUP_BUCKET_MS,
    request_id: requestId,
    model: usage.model,
    provider: usage.provider,
    quota: 0,
    input_tokens: usage.inputTokens,
    cached_input_tokens: observedTokenCount(input.cached_input_tokens),
    output_tokens: usage.outputTokens,
    spend_microcredits: 0,
    request_created_at_ms: created,
    updated_at_ms: now,
  };
};
export {
  MAX_CAS_ATTEMPTS,
  PAID_FALLBACK_AUTOMATIC_BACKFILL_LIMIT,
  PAID_FALLBACK_BACKFILL_LEASE_MS,
  RECONCILIATION_LEASE_MS,
  RETRY_DELAYS_MS,
  UNRESOLVED_AFTER_MS,
  isPositiveSafeInteger,
  windowExpireIn,
  paidFallbackWindowV3Prefix,
  paidFallbackWindowV3GlobalPrefix,
  paidFallbackRequestV3Prefix,
  paidFallbackPendingV3Prefix,
  paidFallbackPendingV3GlobalPrefix,
  isPaidFallbackReconciliationGate,
  paidFallbackReconciliationGateDueNow,
  paidFallbackReconciliationGateNeedsArm,
  isInvalidAdmissionPolicy,
  isBillableRequestV3,
  isBackfillableSettledPaidFallbackRequest,
};

/** A marked row is a retention rewrite only; it must never fold twice. */
export const paidFallbackRequestBackfillStateV3 = (request: PaidFallbackRequestV3 | null): "missing" | "retention" | "fold" => {
  if (!request) return "missing";
  return typeof request.usage_rollup_at_ms === "number" ? "retention" : "fold";
};
export const planPaidFallbackGateAfterScanV3 = (
  gate: Readonly<{ value: PaidFallbackReconciliationGateV3 | null; versionstamp: string | null }>,
  earliestDueAtMs: number | null
) => ({ gate: paidFallbackGateAfterScanV3(earliestDueAtMs), checks: ["gate"] as const, versionstamp: gate.versionstamp });
