/** Source-owned kernel V2 data. These private snapshots are populated only by trusted server adapters. */
export type KernelQuotaScope = "repo" | "org";
export type KernelQuotaIdentity = Readonly<{ scope: KernelQuotaScope; owner: string; repo: string | undefined }>;
export type KernelQuotaConstants = Readonly<{ noUsageLimit: number; noExpirationMs: number }>;
/** Opaque storage revisions and expiry metadata are never supplied by an API caller. */
export type KernelQuotaRead<T = unknown> = Readonly<{ value: T | null; revision: string | null; expiresAtMs?: number | null }>;
export type KernelQuotaDefaults = Readonly<{ limit: number; windowMs: number }>;
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

export type KernelDefaultWindowCutoverV2 = Readonly<{
  v: 2;
  id: string;
  created_at_ms: number;
  expires_at_ms: number;
}>;

export type KernelQuotaEffectivePolicy = Readonly<{
  policy: KernelQuotaPolicyV2 | null;
  limit: number;
  windowMs: number;
  expiresAtMs: number;
  source: "default" | "kv";
}>;
export type KernelQuotaEffectiveWindow = Readonly<{ window: KernelQuotaWindowV2; needsWrite: boolean }>;
export type KernelQuotaPolicySetOptions = Readonly<{ resetUsage?: boolean; windowMs?: number; expiresAtMs?: number }>;
export type KernelReservationSettlement = "settled" | "terminal_mismatch" | "missing" | "invalid" | "conflict";
export type KernelQuotaReservationIdentity = KernelQuotaIdentity & Readonly<{ requestId: string; route: string; windowCreatedAtMs: number }>;
export type KernelQuotaEligibilitySnapshot = Readonly<{
  policy: KernelQuotaRead;
  repoGuard: KernelQuotaRead | null;
  defaultCutover: KernelQuotaRead;
  expectedRepoPolicy?: "present" | "absent";
}>;
export type KernelQuotaRefusal = Readonly<{ kind: "refused"; status: 429 | 503; message: string }>;
export type KernelQuotaEligibilityPlan = KernelQuotaRefusal | Readonly<{ kind: "eligible"; effective: KernelQuotaEffectivePolicy }>;
/** Closed family write sets. Adapters derive fixed keys and retain complete row CAS checks. */
export type KernelQuotaReservePlan =
  | KernelQuotaRefusal
  | Readonly<{ kind: "full"; window: KernelQuotaWindowV2; limit: number }>
  | Readonly<{ kind: "reserve"; reservation: KernelQuotaReservationRowV2; window: KernelQuotaWindowV2; expireIn: number }>;
export type KernelQuotaTerminalPlan =
  | Readonly<{ kind: "unchanged"; outcome: KernelReservationSettlement }>
  | Readonly<{ kind: "intent"; reservation: KernelQuotaReservationRowV2; expireIn: number; leaseExpiresAtMs: number }>;
export type KernelQuotaSettlePlan =
  | Readonly<{ kind: "unchanged"; outcome: KernelReservationSettlement }>
  | Readonly<{ kind: "settle"; reservation: KernelQuotaReservationRowV2; window: KernelQuotaWindowV2 | null; expireIn: number }>;
export type KernelQuotaCutoverPlan =
  | Readonly<{ kind: "refused"; reason: "concurrent_change" | "unavailable" }>
  | Readonly<{ kind: "acquire"; marker: KernelDefaultWindowCutoverV2; expireIn: number }>;
export type KernelQuotaPolicyWritePlan = Readonly<{ policy: KernelQuotaPolicyV2; window: KernelQuotaWindowV2 }>;
