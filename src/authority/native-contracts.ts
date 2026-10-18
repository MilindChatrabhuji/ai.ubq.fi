import type { ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "../types.ts";

export type { ApiKeyUsageRequestV3, ApiKeyUsageWindowV3 } from "../types.ts";
export type ApiKeyUsageProvider = NonNullable<ApiKeyUsageRequestV3["provider"]>;

/** Trusted API-key policy projection; never populated from a client request body. */
export type ApiKeyPolicy = Readonly<{
  token_hash: string;
  key_id: string;
  expires_at_ms: number;
  usage_limit_requests: number;
  window_ms: number;
  window_start_ms: number;
  usage_reset_at_ms: number;
  policy_version: string;
  paid_fallback_enabled: boolean;
  paid_fallback_limit_microcredits: number;
  paid_fallback_spent_microcredits: number;
  paid_fallback_reserved_microcredits: number;
  paid_fallback_reservation_request_id: string | null;
}>;

export type ApiKeyUsagePolicyScope = "key_id" | "policy_version" | "window_start_ms";

/** Named rows already read by a trusted adapter. Keys and storage capabilities stay there. */
export type ApiKeyUsageSnapshot = Readonly<{ request: unknown; window: unknown }>;
export type ApiKeyUsageWritePlan = Readonly<{
  kind: "write";
  checks: readonly ["policy", "window", "request"] | readonly ["request", "window"];
  request: ApiKeyUsageRequestV3;
  window: ApiKeyUsageWindowV3;
  expireIn: number;
}>;

export type ApiKeyUsageReservationPlan =
  | ApiKeyUsageWritePlan
  | Readonly<{ kind: "reuse" }>
  | Readonly<{ kind: "full"; window: ApiKeyUsageWindowV3 }>
  | Readonly<{ kind: "unavailable"; reason: "request_malformed" | "identity_conflict" | "identity_consumed" | "window_malformed" }>;

export type ApiKeyUsageDispatchPlan = ApiKeyUsageWritePlan | Readonly<{ kind: "already_dispatched" }> | Readonly<{ kind: "invalid" }>;
export type ApiKeyUsageReleasePlan = ApiKeyUsageWritePlan | Readonly<{ kind: "missing" | "invalid" | "settled" }>;
