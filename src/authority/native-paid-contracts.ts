import type { PaidFallbackProvider, PaidFallbackRequestV3, PaidFallbackWindowV3 } from "../types.ts";
export type { PaidFallbackProvider, PaidFallbackRequestV3, PaidFallbackWindowV3 } from "../types.ts";

/** Private source snapshots. Revisions and absolute expiry come from trusted storage. */
export type NativePaidRow<T> = Readonly<{ value: T | null; versionstamp: string | null; expiresAtMs?: number | null }>;
export type NativePaidKey = readonly (Uint8Array | string | number | bigint | boolean)[];
export type PaidFallbackPendingV3 = Readonly<{
  created_at_ms: number;
  next_reconciliation_at_ms: number;
}>;

export type PaidFallbackReconciliationGateV3 = Readonly<{
  next_due_at_ms: number | null;
}>;

export type PaidFallbackReconciliationJobV3 = Readonly<{
  key_id: string;
}>;

export type PaidFallbackReconciliationLeaseV3 = Readonly<{
  token: string;
  expires_at_ms: number;
}>;

export type PaidFallbackBackfillLeaseV3 = Readonly<{
  token: string;
  expires_at_ms: number;
}>;

export type PaidFallbackBackfillStateV3 = Readonly<{
  v: 1;
  completed_at_ms: number;
}>;

export type PaidFallbackDeletionGuardV3 = Readonly<{
  created_at_ms: number;
}>;

export type PaidFallbackAdmissionV3 = Readonly<{
  key_id: string;
  request_id: string;
  created_at_ms: number;
  reserved_microcredits: number;
  quota_per_credit: number;
  window_reset_at_ms: number;
  quota_used_percent: number | null;
}>;

export type PaidFallbackWindowProjectionV3 = Readonly<{
  key_id: string;
  policy_version: string | null;
  window_reset_at_ms: number;
  limit_microcredits: number;
  settled_microcredits: number;
  reserved_microcredits: number;
  pending_count: number;
  updated_at_ms: number | null;
}>;

export type PaidFallbackOutstandingV3 = Readonly<{
  pending_requests: number;
  unresolved_requests: number;
  pending_markers: number;
  has_outstanding: boolean;
}>;

export type NativePaidAdmissionInput = Readonly<{
  keyId: string;
  requestId: string;
  createdAtMs: number;
  policyVersion: string;
  limitMicrocredits: number;
  maximumExposureMicrocredits: number | null;
  initialSettledMicrocredits: number;
  quotaPerCredit: number;
  windowResetAtMs: number;
  model: string;
  route: string;
  path: string;
  stream: boolean;
  reasoning: string | null;
  dispatchIntent?: boolean;
}>;

export type PaidFallbackRequestLifecyclePatchV3 = Readonly<
  Partial<
    Pick<PaidFallbackRequestV3, "provider" | "provider_request_id" | "dispatch_state" | "terminal_state"> & {
      reconciliation_attempts?: number;
      last_reconciliation_at_ms?: number | null;
      increment_reconciliation_attempts?: boolean;
    }
  >
>;

/** Lifecycle fields one patch resolves to, before they are compared to the row. */
export type ResolvedRequestLifecycleV3 = Readonly<{
  provider: PaidFallbackProvider | undefined;
  providerRequestId: string | null;
  dispatchState: PaidFallbackRequestV3["dispatch_state"];
  terminalState: PaidFallbackRequestV3["terminal_state"];
  reconciliationAttempts: number;
  lastReconciliationAtMs: number | null;
}>;

export type PaidFallbackUsageRollup = Readonly<{
  v: 1;
  bucket_start_at_ms: number;
  model: string;
  provider: string;
  request_count: number;
  quota_sum: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  spend_microcredits: number;
  first_request_at_ms: number;
  last_request_at_ms: number;
  updated_at_ms: number;
}>;

export type PaidFallbackUsageRollupInput = Readonly<{
  bucket_start_at_ms: number;
  model: string;
  provider: string;
  request_id: string;
  quota: number;
  input_tokens: number;
  cached_input_tokens: number | null;
  output_tokens: number;
  spend_microcredits: number;
  request_created_at_ms: number;
  updated_at_ms: number;
}>;

/**
 * One terminal inference response observed by the gateway. `model` and
 * `provider` are nullable because a rejection that never dispatched an
 * upstream still reaches the terminal log; the writer skips those. Token
 * counts are nullable because an aborted, rejected or unmeasured response
 * never observed usage, and the writer skips an unobserved response instead
 * of recording fabricated zeros.
 */
export type TerminalUsageRollupInput = Readonly<{
  model: string | null;
  provider: string | null;
  request_id: string;
  request_created_at_ms?: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
}>;

/** Transport-free provider facts; native code owns lookup and reservation identity. */
export type NativePaidProviderLog = Readonly<{
  request_id: string;
  quota: number;
  prompt_tokens: number;
  cached_prompt_tokens?: number;
  cache_write_prompt_tokens?: number;
  completion_tokens: number;
  model: string;
  created_at: number;
}>;
export type NativePaidCorrelation = "provider_request_id" | "surplus_reservation";
export type NativePaidAdmissionSnapshot = Readonly<{
  request: NativePaidRow<PaidFallbackRequestV3>;
  window: NativePaidRow<PaidFallbackWindowV3>;
  deletionGuard: NativePaidRow<PaidFallbackDeletionGuardV3>;
  /** Only the authenticated native owner can reconstruct the H row. */
  policyFence?: Readonly<{ versionstamp: string | null }>;
}>;
export type NativePaidAdmissionPolicy = Readonly<{ unlimited: boolean; maximumExposure: number | null }>;
export type NativePaidAdmissionPlan =
  | Readonly<{ kind: "blocked"; reason: "invalid_policy" | "limit_exceeded" }>
  | Readonly<{ kind: "reserved"; reservation: PaidFallbackAdmissionV3 }>
  | Readonly<{ kind: "exhausted_policy"; window: PaidFallbackWindowV3; windowExpireIn: number; checks: readonly ("window" | "deletionGuard" | "policy")[] }>
  | Readonly<{
      kind: "write";
      request: PaidFallbackRequestV3;
      pending: PaidFallbackPendingV3;
      window: PaidFallbackWindowV3 | null;
      reservation: PaidFallbackAdmissionV3;
      checkGate: boolean;
      checkPolicy: boolean;
      requestExpireIn: number;
      windowExpireIn: number | null;
      checks: readonly ("request" | "deletionGuard" | "policy" | "gate" | "window")[];
    }>;
export type NativePaidLifecyclePlan = Readonly<{
  request: PaidFallbackRequestV3;
  readGate: boolean;
  dispatchBoundary: boolean;
  requestExpireIn: number;
  checks: readonly ("request" | "gate")[];
}>;
export type NativePaidReleaseSnapshot = Readonly<{
  request: NativePaidRow<PaidFallbackRequestV3>;
  window: NativePaidRow<PaidFallbackWindowV3>;
  gate: NativePaidRow<PaidFallbackReconciliationGateV3>;
}>;
export type NativePaidReleasePlan = Readonly<{
  request: PaidFallbackRequestV3;
  window: PaidFallbackWindowV3 | null;
  gate: PaidFallbackReconciliationGateV3;
  requestExpireIn: number;
  windowExpireIn: number | null;
  checks: readonly ("request" | "gate" | "window")[];
}>;
export type NativePaidDeferralPlan =
  | Readonly<{ kind: "noop"; checks: readonly [] }>
  | Readonly<{ kind: "cleanup"; checks: readonly ["pending", "gate"] }>
  | Readonly<{
      kind: "write";
      request: PaidFallbackRequestV3;
      pending: PaidFallbackPendingV3;
      delay: number;
      requestExpireIn: number;
      checks: readonly ["request", "pending"];
    }>;
export type NativePaidRollupIdentity = Readonly<{ bucketStartAtMs: number; model: string; provider: string; shard: number }>;
export type NativePaidSettlementMetadata = Readonly<{
  correlation: NativePaidCorrelation;
  microcreditsPerCredit: number;
  surplusBuyerCostMicro?: number;
}>;
export type NativePaidSettlementEvaluation =
  Readonly<{ kind: "cleanup" }> | Readonly<{ kind: "noop" }> | Readonly<{ kind: "defer" }> | Readonly<{ kind: "settle"; spend: number }>;
export type NativePaidSettlementSnapshot = Readonly<{
  request: NativePaidRow<PaidFallbackRequestV3>;
  pending: NativePaidRow<PaidFallbackPendingV3>;
  gate: NativePaidRow<PaidFallbackReconciliationGateV3>;
  window: NativePaidRow<PaidFallbackWindowV3>;
  rollup: NativePaidRow<PaidFallbackUsageRollup>;
}>;

export type NativePaidSettlementPlan = Omit<NativePaidReleasePlan, "checks"> &
  Readonly<{ checks: readonly ("request" | "pending" | "rollup" | "gate" | "window")[] }>;
export type NativePaidTerminalUsage = Readonly<{ model: string; provider: string; inputTokens: number; outputTokens: number }>;
