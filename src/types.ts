export type CodexAuthState = Readonly<{
  access_token: string;
  refresh_token: string;
  account_id: string;
  updated_at_ms: number;
  /** Local native Codex owns this account's rotating credential lineage. */
  native_owner?: Readonly<{ codex_home: string; generation_hash: string; native_refreshed_at?: string }>;
}>;

export type CodexAuthPoolState = Readonly<{
  accounts: readonly CodexAuthState[];
  updated_at_ms: number;
}>;

/**
 * A durable audit record for a banked Codex reset. This is intentionally
 * separate from account-routing state: routing answers whether an account is
 * currently usable, while this record fences an expensive external mutation.
 * It never contains an access token, refresh token, raw account identifier,
 * or raw provider idempotency key.
 */
export type CodexResetRedemptionState = "claimed" | "submitted" | "unknown" | "verified" | "rejected";

export type CodexResetRedemptionRecord = Readonly<{
  v: 1;
  account_id_hash: string;
  credential_version: string;
  quota_generation: string;
  routing_generation: number;
  idempotency_key_hash: string;
  state: CodexResetRedemptionState;
  owner_token: string;
  fence: number;
  lease_expires_at_ms: number;
  provider_receipt_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  submitted_at_ms: number | null;
  verified_at_ms: number | null;
  last_error_code: string | null;
}>;

/** A UTC-day budget consumed at the durable external-submission boundary. */
export type CodexResetGlobalDailyRecord = Readonly<{
  v: 1;
  day: string;
  submission_count: number;
  updated_at_ms: number;
}>;

/**
 * Redacted, read-only evidence of one complete account-pool exhaustion
 * episode. It is deliberately separate from the redemption ledger: this
 * record can attest a shadow decision but can never authorize a provider
 * consume on its own.
 */
export type CodexResetShadowDecisionRecord = Readonly<{
  v: 1;
  episode_hash: string;
  created_at_ms: number;
  expires_at_ms: number;
  decision_reason: string;
  selected_account_id_hash: string | null;
  selected_credit_id_hash: string | null;
  selected_credit_expires_at_ms: number | null;
  fences: readonly Readonly<{
    slot: number;
    account_id_hash: string;
    quota_generation: string;
    routing_generation: number;
    quota_reset_at_ms: number;
  }>[];
}>;

export type ApiKeyRecord = Readonly<{
  id: string;
  name: string;
  prefix: string;
  hash: string;
  created_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  usage_limit_requests: number;
  usage_requests: number;
  usage_reset_at_ms: number;
  window_ms: number;
  /**
   * Runtime request-quota ledger version. Version 3 reserves capacity before
   * route handling and commits it immediately before the first provider
   * transport; V2 counters are migration input only.
   */
  // Read back from KV, where rows written before the V2 -> V3 quota-ledger
  // migration still carry their old version. Typing this as the literal 3 made
  // the migration's own `!== 3` upgrade and validation checks look dead.
  usage_quota_version: number;
  paid_fallback_enabled: boolean;
  paid_fallback_limit_microcredits: number;
  paid_fallback_spent_microcredits: number;
  paid_fallback_reserved_microcredits: number;
  paid_fallback_reservation_request_id: string | null;
  paid_fallback_model_ids: string[];
  paid_fallback_quota_per_credit: number;
  paid_fallback_max_exposure_microcredits?: Record<string, number>;
  paid_fallback_pricing_checked_at_ms: number | null;
}>;

export type ApiKeyHashRecord = Readonly<{
  id: string;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  usage_limit_requests: number;
  usage_requests: number;
  usage_reset_at_ms: number;
  window_ms: number;
  // Read back from KV, where rows written before the V2 -> V3 quota-ledger
  // migration still carry their old version. Typing this as the literal 3 made
  // the migration's own `!== 3` upgrade and validation checks look dead.
  usage_quota_version: number;
  paid_fallback_enabled: boolean;
  paid_fallback_limit_microcredits: number;
  paid_fallback_spent_microcredits: number;
  paid_fallback_reserved_microcredits: number;
  paid_fallback_reservation_request_id: string | null;
}>;

export type ApiKeyUsageWindowV3 = Readonly<{
  v: 3;
  key_id: string;
  policy_version: string;
  window_start_ms: number;
  window_reset_at_ms: number;
  committed_requests: number;
  reserved_requests: number;
  updated_at_ms: number;
}>;

export type ApiKeyUsageRequestV3 = Readonly<{
  v: 3;
  key_id: string;
  request_id: string;
  route: string;
  state: "reserved" | "dispatched" | "released";
  reserved_at_ms: number;
  lease_expires_at_ms: number;
  provider: "cerebras" | "chatgpt_codex" | "claude_code" | "deepseek" | "lithos" | "openrouter" | "removed_provider" | "metered" | "surplus" | "voyage" | null;
  dispatched_at_ms: number | null;
  released_at_ms: number | null;
  release_reason: string | null;
}>;

export type PaidFallbackProvider = "metered" | "surplus";

export type PaidFallbackProviderUsageV3 = Readonly<{
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  spend_microcredits: number;
}>;

export type ApiKeyRequestLogRecord = Readonly<{
  id: string;
  key_id: string;
  route: string;
  path: string;
  method: string;
  status_code: number;
  stream: boolean;
  model: string | null;
  reasoning: string | null;
  created_at_ms: number;
  provider: "cerebras" | "chatgpt_codex" | "deepseek" | "lithos" | "openrouter" | "voyage" | PaidFallbackProvider;
  fallback_reason: string | null;
  provider_request_id: string | null;
  completed_at_ms: number | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  provider_quota: number | null;
  quota_per_credit: number | null;
  spend_microcredits: number | null;
  paid_fallback_window_reset_at_ms: number | null;
  billing_status: "not_applicable" | "pending" | "reconciled" | "not_billed" | "unresolved";
}>;

export type PaidFallbackWindowV3 = Readonly<{
  v: 3;
  key_id: string;
  policy_version: string;
  window_reset_at_ms: number;
  limit_microcredits: number;
  settled_microcredits: number;
  reserved_microcredits: number;
  pending_count: number;
  updated_at_ms: number;
}>;

export type PaidFallbackRequestV3 = Readonly<{
  v: 3;
  key_id: string;
  request_id: string;
  policy_version: string;
  route: string;
  path: string;
  model: string;
  stream: boolean;
  reasoning: string | null;
  // Added after the V3 ledger launch. Missing values are legacy Metered rows.
  provider?: PaidFallbackProvider;
  window_reset_at_ms: number;
  reserved_microcredits: number;
  quota_per_credit: number;
  provider_request_id: string | null;
  provider_quota: number | null;
  input_tokens: number | null;
  cached_input_tokens?: number | null;
  output_tokens: number | null;
  dispatch_state: "reserved" | "dispatched" | "not_dispatched";
  terminal_state: "pending" | "completed" | "failed" | "incomplete" | "cancelled" | "ambiguous";
  spend_microcredits: number | null;
  billing_state: "pending" | "settled" | "not_billed" | "unresolved";
  reconciliation_attempts: number;
  last_reconciliation_at_ms: number | null;
  dispatched_at_ms: number | null;
  terminal_at_ms: number | null;
  settled_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  /**
   * Set when this row's usage was folded into the hourly rollup, either by the
   * settlement write or by the one-time backfill. Prevents a later backfill
   * run from double-counting settle-path rows.
   */
  usage_rollup_at_ms?: number | null;
}>;

export type KernelAuthUsageRecord = Readonly<{
  owner: string;
  repo: string;
  total_requests: number;
  stream_requests: number;
  non_stream_requests: number;
  completed_requests: number;
  error_requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  last_model: string | null;
  last_reasoning: string | null;
  last_route: string | null;
}>;

export type KernelAuthUsageDay = Readonly<{
  day: string;
  request_count: number;
}>;

export type KernelAuthUsageDailyRecord = Readonly<{
  owner: string;
  repo: string;
  days: KernelAuthUsageDay[];
  updated_at_ms: number;
}>;

export type KernelAuthLimitRecord = Readonly<{
  owner: string;
  repo: string;
  usage_limit_requests: number;
  usage_requests: number;
  usage_reset_at_ms: number;
  window_ms: number;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}>;

export type KernelOrgUsageRecord = Readonly<{
  owner: string;
  total_requests: number;
  stream_requests: number;
  non_stream_requests: number;
  completed_requests: number;
  error_requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  last_model: string | null;
  last_reasoning: string | null;
  last_route: string | null;
}>;

export type KernelOrgUsageDay = Readonly<{
  day: string;
  request_count: number;
}>;

export type KernelOrgUsageDailyRecord = Readonly<{
  owner: string;
  days: KernelOrgUsageDay[];
  updated_at_ms: number;
}>;

export type KernelOrgLimitRecord = Readonly<{
  owner: string;
  usage_limit_requests: number;
  usage_requests: number;
  usage_reset_at_ms: number;
  window_ms: number;
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}>;

export type KernelPolicyQueueItem = Readonly<{
  owner: string;
  repo: string;
  request_count: number;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  last_route: string | null;
}>;

export type ChatCompletionRequest = Readonly<{
  model?: unknown;
  messages?: unknown;
  reasoning_effort?: unknown;
  stream?: unknown;
}>;

export type ResponsesRequest = Readonly<{
  client_metadata?: unknown;
  model?: unknown;
  input?: unknown;
  instructions?: unknown;
  reasoning?: unknown;
  stream?: unknown;
}>;

export type PromptCacheBreakpoint = Readonly<{ mode: "explicit" }>;

export type MessageContentItem = Readonly<
  | { type: "input_text"; text: string; prompt_cache_breakpoint?: PromptCacheBreakpoint }
  | { type: "output_text"; text: string }
  | {
      type: "input_image";
      image_url?: string;
      file_id?: string;
      detail?: "auto" | "low" | "high" | "original" | null;
      prompt_cache_breakpoint?: PromptCacheBreakpoint;
    }
  | {
      type: "input_file";
      file_id?: string;
      file_data?: string;
      file_url?: string;
      filename?: string | null;
      detail?: "auto" | "low" | "high";
      prompt_cache_breakpoint?: PromptCacheBreakpoint;
    }
>;

export type ResponseMessageItem = Readonly<{
  type: "message";
  role: "user" | "assistant" | "developer";
  content: MessageContentItem[];
}>;

// The Responses API can accept additional input item types beyond "message"
// (e.g. tool-calling items like reasoning/function_call/function_call_output).
export type ResponseInputItem = ResponseMessageItem | Readonly<Record<string, unknown> & { type: string }>;
