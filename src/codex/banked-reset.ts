import type { Kv, KvEntryMaybe, KvKey } from "#kv";
import { readCodexResetUsage as readBankedResetUsage } from "./reset-settings.ts";
import {
  type CodexUsageResetProvider,
  providerTreatsRedeemOutcomeAsFinal,
  type ResetAccountContext,
  type ResetInventoryCredit,
} from "./banked-reset-provider.ts";
import type { CodexResetGlobalDailyRecord, CodexResetRedemptionRecord, CodexResetRedemptionState, CodexResetShadowDecisionRecord } from "../types.ts";
import { isRecord } from "../utils.ts";

/**
 * A banked reset is an externally visible mutation. Its ledger deliberately
 * does not share the routing key: a routing update must never erase a record
 * describing a provider-side redemption that may still need reconciliation.
 */
export const CODEX_RESET_REDEMPTION_KV_PREFIX = ["uos_ai", "codex_reset_redemption", "v1"] as const;
/** Retained for rollback and audit only: the submission budget never reads this key after the per-account cutover. */
export const CODEX_RESET_GLOBAL_DAILY_KV_PREFIX = ["uos_ai", "codex_reset_redemption", "global_day", "v1"] as const;
export const CODEX_RESET_ACCOUNT_DAILY_KV_PREFIX = ["uos_ai", "codex_reset_redemption", "account_day", "v1"] as const;
export const CODEX_RESET_SHADOW_DECISION_KV_PREFIX = ["uos_ai", "codex_reset_shadow_decision", "v1"] as const;
export const CODEX_BANKED_RESET_LEASE_MS = 30_000;
/** Inventory is an authorization input for an external spend, not a cache. */
export const CODEX_BANKED_RESET_INVENTORY_MAX_AGE_MS = 30_000;
/** A reset preflight may not hold an otherwise healthy fallback indefinitely. */
export const CODEX_BANKED_RESET_INVENTORY_TIMEOUT_MS = 5_000;
const MAX_CAS_ATTEMPTS = 4;

export const codexResetRedemptionKey = (accountIdHash: string, quotaGeneration: string): KvKey => [
  ...CODEX_RESET_REDEMPTION_KV_PREFIX,
  accountIdHash,
  quotaGeneration,
];

/** Retained for rollback and audit only; never enforced after the per-account cutover. */
export const codexResetGlobalDailyKey = (day: string): KvKey => [...CODEX_RESET_GLOBAL_DAILY_KV_PREFIX, day];

export const codexResetAccountDailyKey = (accountIdHash: string, day: string): KvKey => [...CODEX_RESET_ACCOUNT_DAILY_KV_PREFIX, accountIdHash, day];

export const codexResetShadowDecisionKey = (episodeHash: string): KvKey => [...CODEX_RESET_SHADOW_DECISION_KV_PREFIX, episodeHash];

export type CodexBankedResetMode = "disabled" | "shadow" | "live";

export type CodexBankedResetConfig = Readonly<{
  enabled: boolean;
  mode: CodexBankedResetMode;
  maxPerAccountPerDay: number;
  maxPerAccountPerWindow: number;
}>;

const getEnv = (key: string): string | undefined => {
  try {
    return process.env[key];
  } catch {
    return undefined;
  }
};

const parseStrictBoolean = (value: string | undefined, defaultValue: boolean): boolean =>
  value === undefined ? defaultValue : value.trim().toLowerCase() === "true";

const parseNonNegativeInteger = (value: string | undefined, defaultValue: number): number => {
  if (value === undefined) return defaultValue;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return 0;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const parseMode = (value: string | undefined): CodexBankedResetMode => {
  if (value === undefined) return "shadow";
  switch (value.trim().toLowerCase()) {
    case "shadow":
      return "shadow";
    case "live":
      return "live";
    case "disabled":
      return "disabled";
    default:
      return "disabled";
  }
};

/**
 * This is intentionally read at use time rather than module load time. A
 * configuration update can kill new claims immediately without deleting an
 * existing submitted/unknown record that still requires reconciliation.
 */
export const parseCodexBankedResetConfig = (readEnv: (key: string) => string | undefined = getEnv): CodexBankedResetConfig => ({
  // Shadow telemetry never consumes a credit. A spend still requires
  // explicit live mode, valid caps, and an approved provider contract.
  enabled: parseStrictBoolean(readEnv("CODEX_BANKED_RESET_ENABLED"), true),
  mode: parseMode(readEnv("CODEX_BANKED_RESET_MODE")),
  // The retired CODEX_BANKED_RESET_MAX_GLOBAL_PER_DAY environment is no longer read.
  // Fail closed like the retired global cap: an absent cap disables live submissions until an explicit 1 is configured.
  maxPerAccountPerDay: parseNonNegativeInteger(readEnv("CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_DAY"), 0),
  maxPerAccountPerWindow: parseNonNegativeInteger(readEnv("CODEX_BANKED_RESET_MAX_PER_ACCOUNT_PER_WINDOW"), 1),
});

export const loadCodexBankedResetConfig = (): CodexBankedResetConfig => parseCodexBankedResetConfig();

/**
 * The usage gate that every path writing a durable submission passes through.
 * An unavailable configuration and a disabled subscription both stop the
 * caller. Reset settings are owned by the account, never by an API key.
 */
const readUsageGate = async (
  kv: Kv,
  accountIdHash: string
): Promise<Readonly<{ kind: "allowed"; entries: readonly KvEntryMaybe<unknown>[] }> | Readonly<{ kind: "failure"; code: string }>> => {
  let usage: Awaited<ReturnType<typeof readBankedResetUsage>>;
  try {
    usage = await readBankedResetUsage(kv, accountIdHash);
  } catch {
    return { kind: "failure", code: "configuration_unavailable" };
  }
  if (!usage.allowed) return { kind: "failure", code: "usage_disabled" };
  return { kind: "allowed", entries: usage.entries };
};

export type CodexBankedResetEvent =
  | "codex_reset_eligible"
  | "codex_reset_skipped_healthy_fallback"
  | "codex_reset_claimed"
  | "codex_reset_submit_started"
  | "codex_reset_submitted"
  | "codex_reset_unknown"
  | "codex_reset_rejected"
  | "codex_reset_verified"
  | "codex_reset_inference_retry"
  | "codex_reset_inference_retry_result"
  | "codex_reset_duplicate_prevented"
  | "codex_reset_shadow_candidate";

export type CodexBankedResetMetric =
  | "codex_reset_eligible_total"
  | "codex_reset_shadow_candidates_total"
  | "codex_reset_submission_attempts_total"
  | "codex_reset_verified_total"
  | "codex_reset_unknown_total"
  | "codex_reset_duplicate_prevented_total"
  | "codex_reset_verification_latency_ms"
  | "codex_reset_post_retry_total"
  | "codex_reset_estimated_spend_total";

export type CodexBankedResetTelemetryFields = Readonly<Record<string, string | number | boolean | null>>;

export type CodexBankedResetTelemetry = Readonly<{
  event?: (event: CodexBankedResetEvent, fields: CodexBankedResetTelemetryFields) => void;
  metric?: (metric: CodexBankedResetMetric, value: number, fields: CodexBankedResetTelemetryFields) => void;
}>;

const defaultTelemetry: CodexBankedResetTelemetry = {
  event(event, fields) {
    try {
      console.info("[ai.ubq.fi] codex_banked_reset", JSON.stringify({ event, ...fields }));
    } catch {
      // Telemetry may never make a reset safer-looking or less safe.
    }
  },
  metric(metric, value, fields) {
    try {
      console.info("[ai.ubq.fi] codex_banked_reset_metric", JSON.stringify({ metric, value, ...fields }));
    } catch {
      // Metrics are deliberately best effort.
    }
  },
};

export type CodexBankedResetCandidate = Readonly<{
  /** Raw account id is passed only to the provider; it is never persisted or logged. */
  accountId: string;
  /**
   * An opaque routing credential fence. It is hashed before it reaches a
   * durable record, provider context, or telemetry sink.
   */
  credentialVersion: string;
  quotaResetAtMs: number;
  routingGeneration: number;
  /**
   * Each fence is strongly read and atomically checked at both the initial
   * claim and the durable `claimed -> submitted` side-effect boundary.
   * Production passes routing and auth-pool fences; fakes use the same KV
   * shape without exposing a privileged bypass.
   */
  fences: readonly CodexBankedResetFence[];
  requestId: string | null;
  /**
   * A fresh, account-bound credit selected by the pool evaluator. It remains
   * in memory only; durable records retain its hash at most.
   */
  selectedCredit?: ResetInventoryCredit;
  signal?: AbortSignal;
}>;

export type CodexBankedResetFence = Readonly<{
  key: KvKey;
  isCurrent: (value: unknown) => boolean;
}>;

export type CodexBankedResetDependencies = Readonly<{
  config: CodexBankedResetConfig;
  /** Re-read before a new submission so an operator kill switch wins mid-request. */
  reloadConfig?: () => CodexBankedResetConfig;
  provider: CodexUsageResetProvider;
  /** `undefined` uses the production KV accessor; explicit null fails closed. */
  kv?: Kv | null;
  now?: () => number;
  newOwnerToken?: () => string;
  hash?: (value: string) => Promise<string>;
  telemetry?: CodexBankedResetTelemetry;
  /**
   * Hermetic integration-test seam for pre-shadow legacy fixtures. Production
   * never supplies this and always requires a matching shadow decision.
   */
  allowLiveWithoutShadowForTest?: boolean;
}>;

export type CodexBankedResetOutcome = Readonly<{
  kind: "verified" | "pending" | "rejected" | "skipped";
  reason: string;
  accountIdHash: string | null;
  quotaGeneration: string | null;
  idempotencyKeyHash: string | null;
  record: CodexResetRedemptionRecord | null;
}>;

/** One currently fenced account supplied to the blocked-cohort evaluator. */
export type CodexBankedResetPoolCandidate = Readonly<{
  slot: number;
  candidate: CodexBankedResetCandidate;
  provider: CodexUsageResetProvider;
}>;

/**
 * The evaluator returns the in-memory selected account only after the shadow
 * evidence or live reset path has succeeded. No raw account or credit value
 * is written by this return value.
 */
export type CodexBankedResetPoolOutcome = Readonly<{
  kind: "shadow" | "verified" | "skipped" | "pending" | "rejected";
  reason: string;
  selected: CodexBankedResetPoolCandidate | null;
  reset: CodexBankedResetOutcome | null;
}>;

type ResetContext = Readonly<{
  account: ResetAccountContext;
  idempotencyKey: string;
  idempotencyKeyHash: string;
}>;

const isSafeMs = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isSafeNonnegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isNonEmptyText = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

const isState = (value: unknown): value is CodexResetRedemptionState =>
  value === "claimed" || value === "submitted" || value === "unknown" || value === "verified" || value === "rejected";

/** The stored record minus the version tag, which the parser checks separately. */
type ValidatedRedemptionRecordFields = Omit<CodexResetRedemptionRecord, "v">;

/**
 * A state is only durable when it agrees with the timestamps and error fields
 * that state allows. `isState` has already narrowed `state` to the five durable
 * states, so the default branch is unreachable; it assigns to a `never`-typed
 * local so a future state cannot be accepted without a compile error here.
 */
const redemptionRecordStateIsConsistent = (
  state: CodexResetRedemptionState,
  providerReceiptId: string | null,
  submittedAtMs: number | null,
  verifiedAtMs: number | null,
  lastErrorCode: string | null
): boolean => {
  switch (state) {
    case "claimed":
      return providerReceiptId === null && submittedAtMs === null && verifiedAtMs === null && lastErrorCode === null;
    case "submitted":
      return submittedAtMs !== null && verifiedAtMs === null && lastErrorCode === null;
    case "unknown":
      return submittedAtMs !== null && verifiedAtMs === null && lastErrorCode !== null;
    case "verified":
      return submittedAtMs !== null && verifiedAtMs !== null && lastErrorCode === null;
    case "rejected":
      return verifiedAtMs === null && lastErrorCode !== null;
    default: {
      const unreachableState: never = state;
      throw new Error(`unhandled codex reset redemption state: ${JSON.stringify(unreachableState)}`);
    }
  }
};

/** Ordering that every accepted record must satisfy, independent of its state. */
const redemptionRecordTimestampsAreOrdered = (createdAtMs: number, updatedAtMs: number, submittedAtMs: number | null, verifiedAtMs: number | null): boolean =>
  updatedAtMs >= createdAtMs &&
  (submittedAtMs === null || submittedAtMs >= createdAtMs) &&
  (submittedAtMs === null || updatedAtMs >= submittedAtMs) &&
  (verifiedAtMs === null || (submittedAtMs !== null && verifiedAtMs >= submittedAtMs)) &&
  (verifiedAtMs === null || updatedAtMs >= verifiedAtMs);

/**
 * Field-by-field validation of one stored record. The predicate form keeps the
 * narrowing at the call site, so the parser only assembles an object it has
 * already proven field by field, in the same order as before.
 */
const hasValidRedemptionRecordFields = (value: Record<string, unknown>): value is ValidatedRedemptionRecordFields => {
  if (
    !isNonEmptyText(value.account_id_hash) ||
    !isNonEmptyText(value.credential_version) ||
    !isNonEmptyText(value.quota_generation) ||
    !isNonEmptyText(value.idempotency_key_hash) ||
    !isState(value.state) ||
    !isNonEmptyText(value.owner_token) ||
    !isSafeNonnegativeInteger(value.routing_generation) ||
    !isSafeNonnegativeInteger(value.fence) ||
    !isSafeMs(value.lease_expires_at_ms) ||
    !isSafeMs(value.created_at_ms) ||
    !isSafeMs(value.updated_at_ms)
  )
    return false;
  if (value.provider_receipt_id !== null && !isNonEmptyText(value.provider_receipt_id)) return false;
  if (value.submitted_at_ms !== null && !isSafeMs(value.submitted_at_ms)) return false;
  if (value.verified_at_ms !== null && !isSafeMs(value.verified_at_ms)) return false;
  if (value.last_error_code !== null && !isNonEmptyText(value.last_error_code, 128)) return false;
  if (!redemptionRecordTimestampsAreOrdered(value.created_at_ms, value.updated_at_ms, value.submitted_at_ms, value.verified_at_ms)) return false;
  return redemptionRecordStateIsConsistent(value.state, value.provider_receipt_id, value.submitted_at_ms, value.verified_at_ms, value.last_error_code);
};

export const parseCodexResetRedemptionRecord = (value: unknown): CodexResetRedemptionRecord | null => {
  if (!isRecord(value) || value.v !== 1) return null;
  if (!hasValidRedemptionRecordFields(value)) return null;
  return {
    v: 1,
    account_id_hash: value.account_id_hash,
    credential_version: value.credential_version,
    quota_generation: value.quota_generation,
    routing_generation: value.routing_generation,
    idempotency_key_hash: value.idempotency_key_hash,
    state: value.state,
    owner_token: value.owner_token,
    fence: value.fence,
    lease_expires_at_ms: value.lease_expires_at_ms,
    provider_receipt_id: value.provider_receipt_id,
    created_at_ms: value.created_at_ms,
    updated_at_ms: value.updated_at_ms,
    submitted_at_ms: value.submitted_at_ms,
    verified_at_ms: value.verified_at_ms,
    last_error_code: value.last_error_code,
  };
};

const parseAccountDayRecord = (value: unknown, day: string): CodexResetGlobalDailyRecord | null => {
  if (!isRecord(value) || value.v !== 1 || value.day !== day || !isSafeMs(value.updated_at_ms)) return null;
  if (!isSafeNonnegativeInteger(value.submission_count)) return null;
  return { v: 1, day, submission_count: value.submission_count, updated_at_ms: value.updated_at_ms };
};

const parseShadowDecisionFence = (value: unknown): CodexResetShadowDecisionRecord["fences"][number] | null => {
  if (
    !isRecord(value) ||
    !isSafeNonnegativeInteger(value.slot) ||
    !isNonEmptyText(value.account_id_hash) ||
    !isNonEmptyText(value.quota_generation) ||
    !isSafeNonnegativeInteger(value.routing_generation) ||
    !isSafeMs(value.quota_reset_at_ms)
  )
    return null;
  return {
    slot: value.slot,
    account_id_hash: value.account_id_hash,
    quota_generation: value.quota_generation,
    routing_generation: value.routing_generation,
    quota_reset_at_ms: value.quota_reset_at_ms,
  };
};

/** Parse only redacted, safe-to-return shadow decision evidence. */
export const parseCodexResetShadowDecisionRecord = (value: unknown): CodexResetShadowDecisionRecord | null => {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    !isNonEmptyText(value.episode_hash) ||
    !isSafeMs(value.created_at_ms) ||
    !isSafeMs(value.expires_at_ms) ||
    value.expires_at_ms < value.created_at_ms ||
    !isNonEmptyText(value.decision_reason, 128) ||
    !Array.isArray(value.fences)
  )
    return null;
  if (value.selected_account_id_hash !== null && !isNonEmptyText(value.selected_account_id_hash)) return null;
  if (value.selected_credit_id_hash !== null && !isNonEmptyText(value.selected_credit_id_hash)) return null;
  if (value.selected_credit_expires_at_ms !== null && !isSafeMs(value.selected_credit_expires_at_ms)) return null;
  if ((value.selected_account_id_hash === null) !== (value.selected_credit_id_hash === null)) return null;
  const fences = value.fences.map(parseShadowDecisionFence);
  if (!fences.length || fences.some((fence) => !fence)) return null;
  const parsedFences = fences as CodexResetShadowDecisionRecord["fences"];
  const slots = new Set<number>();
  if (parsedFences.some((fence) => slots.has(fence.slot) || (slots.add(fence.slot), false))) return null;
  return {
    v: 1,
    episode_hash: value.episode_hash,
    created_at_ms: value.created_at_ms,
    expires_at_ms: value.expires_at_ms,
    decision_reason: value.decision_reason,
    selected_account_id_hash: value.selected_account_id_hash,
    selected_credit_id_hash: value.selected_credit_id_hash,
    selected_credit_expires_at_ms: value.selected_credit_expires_at_ms,
    fences: parsedFences,
  };
};

const utcDay = (nowMs: number): string | null => {
  if (!isSafeMs(nowMs)) return null;
  try {
    return new Date(nowMs).toISOString().slice(0, 10);
  } catch {
    return null;
  }
};

/**
 * The daily cap is a cap on externally visible submissions, not merely on
 * ledger claims. A claim that crosses UTC midnight must never carry an old
 * day's reservation into a new day, where it could bypass that day's cap.
 */
const claimedDuringCurrentUtcDay = (record: CodexResetRedemptionRecord, nowMs: number): boolean => {
  const claimedDay = utcDay(record.created_at_ms);
  const currentDay = utcDay(nowMs);
  return claimedDay !== null && claimedDay === currentDay;
};

const outcome = (
  kind: CodexBankedResetOutcome["kind"],
  reason: string,
  context: ResetContext | null = null,
  record: CodexResetRedemptionRecord | null = null
): CodexBankedResetOutcome => ({
  kind,
  reason,
  accountIdHash: context?.account.accountIdHash ?? null,
  quotaGeneration: context?.account.quotaGeneration ?? null,
  idempotencyKeyHash: context?.idempotencyKeyHash ?? null,
  record,
});

const safeOwnerToken = (source: () => string): string | null => {
  try {
    const token = source();
    return isNonEmptyText(token, 256) ? token : null;
  } catch {
    return null;
  }
};

const policyReason = (config: CodexBankedResetConfig): string | null => {
  try {
    if (!config.enabled) return "feature_disabled";
    if (config.mode === "disabled") return "mode_disabled";
    // This single-candidate state-machine seam makes no provider call in
    // shadow. The production cohort evaluator requires a positive cap before
    // its bounded inventory reads.
    if (config.mode === "shadow") return null;
    if (config.maxPerAccountPerDay <= 0) return "per_account_day_limit_invalid";
    // The non-negotiable at-most-once rule is stronger than a mutable setting.
    if (config.maxPerAccountPerWindow !== 1) return "per_account_window_limit_invalid";
    return null;
  } catch {
    return "configuration_invalid";
  }
};

/**
 * Live mode is exactly one redemption per account per UTC day. A provider whose
 * redeem outcome is final gets the terminal-specific message because a lost
 * response can never be reconciled; every other live provider still fails
 * closed instead of handing out a second daily submission.
 */
const providerPolicyReason = (config: CodexBankedResetConfig, provider: CodexUsageResetProvider): string | null => {
  if (config.mode !== "live" || config.maxPerAccountPerDay === 1) return null;
  return providerTreatsRedeemOutcomeAsFinal(provider) ? "terminal_outcome_account_day_limit_must_be_one" : "per_account_day_limit_invalid";
};

const boundedInventorySignal = (signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(CODEX_BANKED_RESET_INVENTORY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

const telemetryFields = (
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  extras: CodexBankedResetTelemetryFields = {}
): CodexBankedResetTelemetryFields => ({
  request_id: candidate.requestId,
  account_id_hash: context.account.accountIdHash,
  credential_version: context.account.credentialVersion,
  quota_generation: context.account.quotaGeneration,
  idempotency_key_hash: context.idempotencyKeyHash,
  routing_generation: candidate.routingGeneration,
  ...extras,
});

const emit = (telemetry: CodexBankedResetTelemetry, event: CodexBankedResetEvent, fields: CodexBankedResetTelemetryFields): void => {
  try {
    telemetry.event?.(event, fields);
  } catch {
    // An observer must not affect state transitions.
  }
};

const metric = (telemetry: CodexBankedResetTelemetry, name: CodexBankedResetMetric, value: number, fields: CodexBankedResetTelemetryFields): void => {
  try {
    telemetry.metric?.(name, value, fields);
  } catch {
    // An observer must not affect state transitions.
  }
};

/** Allows gateway-level events and metrics to share the same injectable sink. */
export const reportCodexBankedResetEvent = (
  telemetry: CodexBankedResetTelemetry | undefined,
  event: CodexBankedResetEvent,
  fields: CodexBankedResetTelemetryFields
): void => {
  emit(telemetry ?? defaultTelemetry, event, fields);
};

/** Allows gateway-level post-retry metrics to share the default sink. */
export const reportCodexBankedResetMetric = (
  telemetry: CodexBankedResetTelemetry | undefined,
  name: CodexBankedResetMetric,
  value: number,
  fields: CodexBankedResetTelemetryFields
): void => {
  metric(telemetry ?? defaultTelemetry, name, value, fields);
};

export type { ResetContext };
export {
  MAX_CAS_ATTEMPTS,
  boundedInventorySignal,
  claimedDuringCurrentUtcDay,
  defaultTelemetry,
  emit,
  isNonEmptyText,
  isSafeMs,
  isSafeNonnegativeInteger,
  metric,
  outcome,
  parseAccountDayRecord,
  policyReason,
  providerPolicyReason,
  readUsageGate,
  safeOwnerToken,
  telemetryFields,
  utcDay,
};
