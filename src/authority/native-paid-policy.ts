// Source-owned paid policy validators and hash projection; no storage or provider I/O.
import { PAID_FALLBACK_NO_LIMIT } from "../api-keys.ts";
import { isRecord } from "../utils.ts";
import type { ApiKeyHashRecord, ApiKeyRecord } from "../types.ts";

const isNonNegativeSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isPaidFallbackLimit = (value: unknown): value is number => value === PAID_FALLBACK_NO_LIMIT || isNonNegativeSafeInteger(value);

const isNullableString = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.trim().length > 0);

export const hasStrictPaidFallbackPolicy = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (typeof value.paid_fallback_enabled !== "boolean") return false;
  if (!isPaidFallbackLimit(value.paid_fallback_limit_microcredits)) return false;
  if (!isNonNegativeSafeInteger(value.paid_fallback_spent_microcredits)) return false;
  if (!isNonNegativeSafeInteger(value.paid_fallback_reserved_microcredits)) return false;
  if (!isNullableString(value.paid_fallback_reservation_request_id)) return false;

  const limit = value.paid_fallback_limit_microcredits;
  if (value.paid_fallback_enabled && limit !== PAID_FALLBACK_NO_LIMIT && !isPositiveSafeInteger(limit)) return false;
  return true;
};

export const hasStrictPaidFallbackKeyPolicy = (value: unknown): boolean => {
  if (!hasStrictPaidFallbackPolicy(value) || !isRecord(value)) return false;
  if (!Array.isArray(value.paid_fallback_model_ids) || value.paid_fallback_model_ids.some((model) => typeof model !== "string" || !model.trim())) {
    return false;
  }
  if (!isNonNegativeSafeInteger(value.paid_fallback_quota_per_credit)) return false;
  if (value.paid_fallback_pricing_checked_at_ms !== null && !isPositiveSafeInteger(value.paid_fallback_pricing_checked_at_ms)) {
    return false;
  }
  if (value.paid_fallback_enabled) {
    if (value.paid_fallback_model_ids.length === 0) return false;
    if (!isPositiveSafeInteger(value.paid_fallback_quota_per_credit)) return false;
    if (!isPositiveSafeInteger(value.paid_fallback_pricing_checked_at_ms)) return false;
  }
  return true;
};

export const paidFallbackHashFields = (
  record: ApiKeyRecord
): Pick<
  ApiKeyHashRecord,
  | "paid_fallback_enabled"
  | "paid_fallback_limit_microcredits"
  | "paid_fallback_spent_microcredits"
  | "paid_fallback_reserved_microcredits"
  | "paid_fallback_reservation_request_id"
> => ({
  paid_fallback_enabled: record.paid_fallback_enabled,
  paid_fallback_limit_microcredits: record.paid_fallback_limit_microcredits,
  paid_fallback_spent_microcredits: record.paid_fallback_spent_microcredits,
  paid_fallback_reserved_microcredits: record.paid_fallback_reserved_microcredits,
  paid_fallback_reservation_request_id: record.paid_fallback_reservation_request_id,
});
