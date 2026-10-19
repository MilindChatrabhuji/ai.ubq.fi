// Source-owned native API-key parsing and admin decisions. Native wrappers retain I/O, clocks, random IDs and response formatting.
import {
  API_KEY_NO_EXPIRATION_MS,
  API_KEY_NO_USAGE_LIMIT,
  USAGE_RESET_PERIOD_MS,
  normalizeApiKeyWindowMs,
  coerceApiKeyWindowMs,
  paidFallbackCreditsToMicrocredits,
  paidFallbackMicrocreditsToCredits,
  calculateNextResetMs,
} from "../api-keys.ts";
import { isRecord } from "../utils.ts";
import type { ApiKeyHashRecord, ApiKeyRecord } from "../types.ts";
import type { LocalDevelopmentDeletionGuard } from "../auth/local-development-key.ts";
import type { ApiKeyPolicy } from "./native-contracts.ts";
import { apiKeyUsageV3PolicyVersion, currentApiKeyUsageWindow } from "./native-api-key.ts";
import { hasStrictPaidFallbackPolicy, paidFallbackHashFields } from "./native-paid-policy.ts";

const hasUsageQuotaV3 = (record: unknown): boolean => isRecord(record) && record.usage_quota_version === 3;

const policyVersion = (record: ApiKeyHashRecord): string => apiKeyUsageV3PolicyVersion(normalizeApiKeyWindowMs(record.window_ms));

export const apiKeyPolicyFromHashRecord = (tokenHash: string, record: ApiKeyHashRecord, nowMs: number): ApiKeyPolicy | null => {
  if (!hasStrictPaidFallbackPolicy(record) || !hasUsageQuotaV3(record)) return null;
  const windowMs = normalizeApiKeyWindowMs(record.window_ms);
  const window = currentApiKeyUsageWindow(record.usage_reset_at_ms, windowMs, nowMs);
  return {
    token_hash: tokenHash,
    key_id: record.id,
    expires_at_ms: Number.isFinite(record.expires_at_ms) ? Math.trunc(record.expires_at_ms) : API_KEY_NO_EXPIRATION_MS,
    usage_limit_requests: record.usage_limit_requests,
    window_ms: windowMs,
    window_start_ms: window.start,
    usage_reset_at_ms: window.reset,
    policy_version: policyVersion(record),
    paid_fallback_enabled: record.paid_fallback_enabled,
    paid_fallback_limit_microcredits: record.paid_fallback_limit_microcredits,
    paid_fallback_spent_microcredits: record.paid_fallback_spent_microcredits,
    paid_fallback_reserved_microcredits: record.paid_fallback_reserved_microcredits,
    paid_fallback_reservation_request_id: record.paid_fallback_reservation_request_id,
  };
};

export const looksLikeUosApiKey = (token: string): boolean => /^u_[0-9a-f]{64}$/.test(token.trim());

export const normalizeApiKeyName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name) return null;
  if (name.length > 80) return null;
  if (/[\r\n]/.test(name)) return null;
  return name;
};

export const normalizeOptionalApiKeyToken = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const token = value.trim();
  return looksLikeUosApiKey(token) ? token : null;
};

export const normalizeApiKeyExpiresAtMs = (value: unknown, nowMs: number, defaultExpiryMs: number): number | null => {
  if (value === undefined || value === null) return defaultExpiryMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const expiresAtMs = Math.trunc(value);
  if (expiresAtMs === API_KEY_NO_EXPIRATION_MS) return API_KEY_NO_EXPIRATION_MS;
  if (expiresAtMs < 0) return null;
  if (expiresAtMs <= nowMs) return null;
  return expiresAtMs;
};

export const normalizeApiKeyUsageLimit = (value: unknown, defaultUsageLimit: number): number | null => {
  if (value === undefined || value === null) return defaultUsageLimit;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const limit = Math.trunc(value);
  if (limit === API_KEY_NO_USAGE_LIMIT) return API_KEY_NO_USAGE_LIMIT;
  if (limit < 0) return null;
  return limit;
};

export const normalizeApiKeyWindowMsInput = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    value = parsed;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const windowMs = Math.trunc(value);
  if (windowMs <= 0) return null;
  return windowMs;
};

export type ApiKeyCreateFields = Readonly<{
  expiresAtMs: number;
  usageLimitRequests: number;
  windowMs: number;
  paidFallbackEnabled: boolean;
  paidFallbackLimitMicrocredits: number;
}>;

/** `paid_fallback_enabled` and `paid_fallback_limit_credits`, validated in that order. */
const resolveApiKeyCreatePaidFallback = (
  raw: Record<string, unknown>
): { ok: true; paidFallbackEnabled: boolean; paidFallbackLimitMicrocredits: number } | { ok: false; error: string } => {
  if (Object.prototype.hasOwnProperty.call(raw, "paid_fallback_enabled") && typeof raw.paid_fallback_enabled !== "boolean") {
    return { ok: false, error: "paid_fallback_enabled must be a boolean" };
  }
  const paidFallbackEnabled = raw.paid_fallback_enabled === true;
  const paidFallbackLimitMicrocredits = Object.prototype.hasOwnProperty.call(raw, "paid_fallback_limit_credits")
    ? paidFallbackCreditsToMicrocredits(raw.paid_fallback_limit_credits)
    : 0;
  if (paidFallbackLimitMicrocredits === null) {
    return { ok: false, error: "paid_fallback_limit_credits must be a non-negative number or -1" };
  }
  if (paidFallbackEnabled && paidFallbackLimitMicrocredits === 0) {
    return { ok: false, error: "paid_fallback_limit_credits must be positive or -1 when paid fallback is enabled" };
  }
  return { ok: true, paidFallbackEnabled, paidFallbackLimitMicrocredits };
};

/** Every create-time field except `name` and `token`, validated in the original order. */
export const resolveApiKeyCreateFields = (
  raw: Record<string, unknown>,
  nowMs: number,
  defaults: Readonly<{ expiryMs: number; usageLimitRequests: number }>
): { ok: true; fields: ApiKeyCreateFields } | { ok: false; error: string } => {
  const expiresAtMs = normalizeApiKeyExpiresAtMs(raw.expires_at_ms, nowMs, defaults.expiryMs);
  if (expiresAtMs === null) {
    return { ok: false, error: "expires_at_ms must be a Unix epoch ms timestamp in the future, or -1" };
  }

  const usageLimitRequests = normalizeApiKeyUsageLimit(raw.usage_limit_requests, defaults.usageLimitRequests);
  if (usageLimitRequests === null) {
    return { ok: false, error: "usage_limit_requests must be a positive number or -1 for unlimited" };
  }

  const windowMs = normalizeApiKeyWindowMsInput(raw.window_ms);
  if (raw.window_ms !== undefined && windowMs === null) {
    return { ok: false, error: "window_ms must be a positive number" };
  }

  const paidFallback = resolveApiKeyCreatePaidFallback(raw);
  if (!paidFallback.ok) return paidFallback;

  return {
    ok: true,
    fields: {
      expiresAtMs,
      usageLimitRequests,
      windowMs: windowMs ?? USAGE_RESET_PERIOD_MS,
      paidFallbackEnabled: paidFallback.paidFallbackEnabled,
      paidFallbackLimitMicrocredits: paidFallback.paidFallbackLimitMicrocredits,
    },
  };
};

export type ApiKeyUpdateFields = Readonly<{
  name: string;
  expiresAtMs: number;
  usageLimitRequests: number;
  windowMs: number;
  paidFallbackEnabled: boolean;
  paidFallbackLimitMicrocredits: number;
  paidFallbackModelIds: string[];
  paidFallbackQuotaPerCredit: number;
  paidFallbackMaxExposureMicrocredits: Record<string, number>;
  paidFallbackPricingCheckedAtMs: number | null;
  resetUsage: boolean;
}>;

export type ApiKeyUpdateIdentity = Pick<ApiKeyUpdateFields, "name" | "expiresAtMs">;
export type ApiKeyUpdateQuota = Pick<ApiKeyUpdateFields, "usageLimitRequests" | "windowMs">;
export type ApiKeyUpdatePaidFallback = Pick<
  ApiKeyUpdateFields,
  | "paidFallbackEnabled"
  | "paidFallbackLimitMicrocredits"
  | "paidFallbackModelIds"
  | "paidFallbackQuotaPerCredit"
  | "paidFallbackMaxExposureMicrocredits"
  | "paidFallbackPricingCheckedAtMs"
>;

/** `name` and `expires_at_ms`, validated in that order. */
export const resolveApiKeyUpdateIdentity = (
  raw: Record<string, unknown>,
  record: ApiKeyRecord,
  currentExpiresAtMs: number,
  nowMs: number,
  defaultExpiryMs: number
): { ok: true; identity: ApiKeyUpdateIdentity } | { ok: false; error: string } => {
  let name = record.name;
  if (Object.prototype.hasOwnProperty.call(raw, "name")) {
    const normalized = normalizeApiKeyName(raw.name);
    if (!normalized) return { ok: false, error: "name must be a non-empty string (<=80 chars)" };
    name = normalized;
  }

  let expiresAtMs = currentExpiresAtMs;
  if (Object.prototype.hasOwnProperty.call(raw, "expires_at_ms")) {
    const normalized = normalizeApiKeyExpiresAtMs(raw.expires_at_ms, nowMs, defaultExpiryMs);
    if (normalized === null) {
      return {
        ok: false,
        error: "expires_at_ms must be a Unix epoch ms timestamp in the future, or -1",
      };
    }
    expiresAtMs = normalized;
  }

  return { ok: true, identity: { name, expiresAtMs } };
};

/** `usage_limit_requests` and `window_ms`, validated in that order. */
export const resolveApiKeyUpdateQuota = (
  raw: Record<string, unknown>,
  record: ApiKeyRecord,
  defaultUsageLimit: number
): { ok: true; quota: ApiKeyUpdateQuota } | { ok: false; error: string } => {
  let usageLimitRequests = record.usage_limit_requests;
  if (Object.prototype.hasOwnProperty.call(raw, "usage_limit_requests")) {
    const normalized = normalizeApiKeyUsageLimit(raw.usage_limit_requests, defaultUsageLimit);
    if (normalized === null) {
      return { ok: false, error: "usage_limit_requests must be a non-negative number or -1 for unlimited" };
    }
    usageLimitRequests = normalized;
  }

  let windowMs = coerceApiKeyWindowMs(record);
  if (Object.prototype.hasOwnProperty.call(raw, "window_ms")) {
    const normalized = normalizeApiKeyWindowMsInput(raw.window_ms);
    if (normalized === null) {
      return { ok: false, error: "window_ms must be a positive number" };
    }
    windowMs = normalized;
  }

  return { ok: true, quota: { usageLimitRequests, windowMs } };
};

export const resolveApiKeyUpdatePaidFallback = (
  raw: Record<string, unknown>,
  record: ApiKeyRecord
): { ok: true; paidFallback: ApiKeyUpdatePaidFallback; needsInitialization: boolean } | { ok: false; error: string } => {
  if (Object.prototype.hasOwnProperty.call(raw, "paid_fallback_enabled") && typeof raw.paid_fallback_enabled !== "boolean") {
    return { ok: false, error: "paid_fallback_enabled must be a boolean" };
  }
  let paidFallbackEnabled = record.paid_fallback_enabled;
  if (Object.prototype.hasOwnProperty.call(raw, "paid_fallback_enabled")) {
    paidFallbackEnabled = raw.paid_fallback_enabled === true;
  }

  let paidFallbackLimitMicrocredits = record.paid_fallback_limit_microcredits;
  if (Object.prototype.hasOwnProperty.call(raw, "paid_fallback_limit_credits")) {
    const limitMicrocredits = paidFallbackCreditsToMicrocredits(raw.paid_fallback_limit_credits);
    if (limitMicrocredits === null) {
      return { ok: false, error: "paid_fallback_limit_credits must be a non-negative number or -1" };
    }
    paidFallbackLimitMicrocredits = limitMicrocredits;
  }
  if (paidFallbackEnabled && paidFallbackLimitMicrocredits === 0) {
    return { ok: false, error: "paid_fallback_limit_credits must be positive or -1 when paid fallback is enabled" };
  }

  const paidFallback: ApiKeyUpdatePaidFallback = {
    paidFallbackEnabled,
    paidFallbackLimitMicrocredits,
    paidFallbackModelIds: record.paid_fallback_model_ids,
    paidFallbackQuotaPerCredit: record.paid_fallback_quota_per_credit,
    paidFallbackMaxExposureMicrocredits: record.paid_fallback_max_exposure_microcredits ?? {},
    paidFallbackPricingCheckedAtMs: record.paid_fallback_pricing_checked_at_ms,
  };
  return { ok: true, paidFallback, needsInitialization: !record.paid_fallback_enabled && paidFallbackEnabled };
};

/**
 * Merges the patch into the stored record. A reset (explicit, or implied by a
 * window change) must always select a distinct V3 aggregate identity: a create
 * followed by an immediate reset can otherwise share the same millisecond start
 * and overwrite the current window instead of opening a fresh one.
 */
export const buildApiKeyUpdateRecord = (
  record: ApiKeyRecord,
  fields: ApiKeyUpdateFields,
  nowMs: number,
  currentWindowMs: number
): { updated: ApiKeyRecord; resetUsage: boolean; replaceQuotaWindow: boolean } => {
  const replaceQuotaWindow = fields.resetUsage || fields.windowMs !== currentWindowMs;
  let usageRequests = record.usage_requests;
  let usageResetAtMs = record.usage_reset_at_ms;
  let paidFallbackSpentMicrocredits = record.paid_fallback_spent_microcredits;
  if (replaceQuotaWindow) {
    usageRequests = 0;
    const currentWindowStartMs = record.usage_reset_at_ms - currentWindowMs;
    const freshWindowStartMs = Math.max(nowMs, currentWindowStartMs + 1);
    usageResetAtMs = freshWindowStartMs + fields.windowMs;
    paidFallbackSpentMicrocredits = 0;
  }
  return {
    updated: {
      ...record,
      name: fields.name,
      expires_at_ms: fields.expiresAtMs,
      usage_limit_requests: fields.usageLimitRequests,
      usage_requests: usageRequests,
      usage_reset_at_ms: usageResetAtMs,
      window_ms: fields.windowMs,
      paid_fallback_enabled: fields.paidFallbackEnabled,
      paid_fallback_limit_microcredits: fields.paidFallbackLimitMicrocredits,
      paid_fallback_spent_microcredits: paidFallbackSpentMicrocredits,
      paid_fallback_reserved_microcredits: record.paid_fallback_reserved_microcredits,
      paid_fallback_reservation_request_id: record.paid_fallback_reservation_request_id,
      paid_fallback_model_ids: fields.paidFallbackModelIds,
      paid_fallback_quota_per_credit: fields.paidFallbackQuotaPerCredit,
      paid_fallback_max_exposure_microcredits: fields.paidFallbackMaxExposureMicrocredits,
      paid_fallback_pricing_checked_at_ms: fields.paidFallbackPricingCheckedAtMs,
    },
    resetUsage: fields.resetUsage,
    replaceQuotaWindow,
  };
};

const apiKeyUpdateIdentityChanged = (record: ApiKeyRecord, updated: ApiKeyRecord, currentExpiresAtMs: number): boolean =>
  updated.name !== record.name || updated.expires_at_ms !== currentExpiresAtMs;

const apiKeyUpdateQuotaChanged = (record: ApiKeyRecord, updated: ApiKeyRecord, currentWindowMs: number, resetUsage: boolean): boolean =>
  updated.usage_limit_requests !== record.usage_limit_requests ||
  updated.window_ms !== currentWindowMs ||
  (resetUsage && (updated.usage_requests !== record.usage_requests || updated.usage_reset_at_ms !== record.usage_reset_at_ms));

const apiKeyUpdatePaidFallbackChanged = (record: ApiKeyRecord, updated: ApiKeyRecord): boolean =>
  updated.paid_fallback_enabled !== record.paid_fallback_enabled ||
  updated.paid_fallback_limit_microcredits !== record.paid_fallback_limit_microcredits ||
  updated.paid_fallback_spent_microcredits !== record.paid_fallback_spent_microcredits ||
  updated.paid_fallback_reserved_microcredits !== record.paid_fallback_reserved_microcredits ||
  updated.paid_fallback_reservation_request_id !== record.paid_fallback_reservation_request_id ||
  updated.paid_fallback_model_ids !== record.paid_fallback_model_ids ||
  updated.paid_fallback_quota_per_credit !== record.paid_fallback_quota_per_credit ||
  updated.paid_fallback_pricing_checked_at_ms !== record.paid_fallback_pricing_checked_at_ms;

/** Every comparison is pure, so this matches the original short-circuit chain. */
export const apiKeyUpdateChanged = (
  record: ApiKeyRecord,
  updated: ApiKeyRecord,
  currentExpiresAtMs: number,
  currentWindowMs: number,
  resetUsage: boolean
): boolean =>
  apiKeyUpdateIdentityChanged(record, updated, currentExpiresAtMs) ||
  apiKeyUpdateQuotaChanged(record, updated, currentWindowMs, resetUsage) ||
  apiKeyUpdatePaidFallbackChanged(record, updated);

/** The safe policy fields that actually changed, ready for the audit allowlist. */
export const apiKeyUpdateAuditChanges = (
  record: ApiKeyRecord,
  updated: ApiKeyRecord,
  currentExpiresAtMs: number,
  currentWindowMs: number,
  resetUsage: boolean
): Record<string, unknown> => {
  const changed: Record<string, unknown> = {};
  if (updated.name !== record.name) changed.name = updated.name;
  if (updated.expires_at_ms !== currentExpiresAtMs) changed.expires_at_ms = updated.expires_at_ms;
  if (updated.usage_limit_requests !== record.usage_limit_requests) changed.usage_limit_requests = updated.usage_limit_requests;
  if (updated.window_ms !== currentWindowMs) changed.window_ms = updated.window_ms;
  if (updated.paid_fallback_enabled !== record.paid_fallback_enabled) changed.paid_fallback_enabled = updated.paid_fallback_enabled;
  if (updated.paid_fallback_limit_microcredits !== record.paid_fallback_limit_microcredits) {
    changed.paid_fallback_limit_credits = paidFallbackMicrocreditsToCredits(updated.paid_fallback_limit_microcredits);
  }
  if (resetUsage) changed.reset_usage = true;
  return changed;
};

export const retryableLocalDeletionGuard = (value: unknown): LocalDevelopmentDeletionGuard | null => {
  if (!isRecord(value) || !isRecord(value.local_deletion)) return null;
  if (typeof value.created_at_ms !== "number" || !Number.isSafeInteger(value.created_at_ms) || value.created_at_ms <= 0) return null;
  if (value.local_deletion.owner !== null || value.local_deletion.completed_at_ms !== null) return null;
  return { created_at_ms: value.created_at_ms, local_deletion: { owner: null, completed_at_ms: null } };
};

export const rejectRetiredApiKeyResetSetting = (raw: Record<string, unknown>): string | null =>
  Object.prototype.hasOwnProperty.call(raw, "banked_resets_enabled")
    ? "banked_resets_enabled is retired; configure banked resets per Codex subscription"
    : null;

export const resolveApiKeyResetUsage = (raw: Record<string, unknown>): { ok: true; resetUsage: boolean } | { ok: false; error: string } => {
  if (Object.prototype.hasOwnProperty.call(raw, "reset_usage") && typeof raw.reset_usage !== "boolean")
    return { ok: false, error: "reset_usage must be a boolean" };
  return { ok: true, resetUsage: raw.reset_usage === true };
};

export const apiKeyHashRecordFor = (record: ApiKeyRecord, id = record.id): ApiKeyHashRecord => ({
  id,
  expires_at_ms: record.expires_at_ms,
  revoked_at_ms: record.revoked_at_ms,
  usage_limit_requests: record.usage_limit_requests,
  usage_requests: record.usage_requests,
  usage_reset_at_ms: record.usage_reset_at_ms,
  window_ms: record.window_ms,
  usage_quota_version: record.usage_quota_version,
  ...paidFallbackHashFields(record),
});

export const buildApiKeyCreateRecords = (
  identity: Readonly<{ id: string; name: string; prefix: string; hash: string }>,
  fields: ApiKeyCreateFields,
  policy: Pick<
    ApiKeyRecord,
    | "paid_fallback_enabled"
    | "paid_fallback_limit_microcredits"
    | "paid_fallback_spent_microcredits"
    | "paid_fallback_reserved_microcredits"
    | "paid_fallback_reservation_request_id"
    | "paid_fallback_model_ids"
    | "paid_fallback_quota_per_credit"
    | "paid_fallback_max_exposure_microcredits"
    | "paid_fallback_pricing_checked_at_ms"
  >,
  now: number
): { record: ApiKeyRecord; hashRecord: ApiKeyHashRecord } => {
  const usageResetAtMs = calculateNextResetMs(now, fields.windowMs);
  const record: ApiKeyRecord = {
    id: identity.id,
    name: identity.name,
    prefix: identity.prefix,
    hash: identity.hash,
    created_at_ms: now,
    expires_at_ms: fields.expiresAtMs,
    revoked_at_ms: null,
    usage_limit_requests: fields.usageLimitRequests,
    usage_requests: 0,
    usage_reset_at_ms: usageResetAtMs,
    window_ms: fields.windowMs,
    usage_quota_version: 3,
    ...policy,
  };
  const hashRecord: ApiKeyHashRecord = {
    id: identity.id,
    expires_at_ms: fields.expiresAtMs,
    revoked_at_ms: null,
    usage_limit_requests: fields.usageLimitRequests,
    usage_requests: 0,
    usage_reset_at_ms: usageResetAtMs,
    window_ms: fields.windowMs,
    usage_quota_version: 3,
    ...paidFallbackHashFields(record),
  };
  return { record, hashRecord };
};

export const buildApiKeyRevocationRecord = (record: ApiKeyRecord, expiresAtMs: number, now: number): ApiKeyRecord =>
  record.revoked_at_ms ? { ...record, expires_at_ms: expiresAtMs } : { ...record, expires_at_ms: expiresAtMs, revoked_at_ms: now };
export const buildApiKeyUnrevocationRecord = (record: ApiKeyRecord, expiresAtMs: number): ApiKeyRecord => ({
  ...record,
  expires_at_ms: expiresAtMs,
  revoked_at_ms: null,
});
export const apiKeyRevokeAuditChanges = (record: ApiKeyRecord, updated: ApiKeyRecord): Record<string, unknown> => ({
  ...(updated.revoked_at_ms !== record.revoked_at_ms ? { revoked_at_ms: updated.revoked_at_ms } : {}),
  ...(updated.expires_at_ms !== record.expires_at_ms ? { expires_at_ms: updated.expires_at_ms } : {}),
});
export const apiKeyUnrevokeDecision = (record: ApiKeyRecord, deletionGuard: unknown): "blocked" | "unchanged" | "write" => {
  if (deletionGuard) return "blocked";
  return !record.revoked_at_ms ? "unchanged" : "write";
};
export const apiKeyDeleteDecision = (record: ApiKeyRecord): "requires_revocation" | "delete" => (!record.revoked_at_ms ? "requires_revocation" : "delete");
