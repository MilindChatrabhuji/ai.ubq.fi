// Admin API key mutation handlers, split out of src/admin.ts.

import { json, openaiError } from "../http.ts";
import {
  apiKeyHashKey,
  apiKeyIdKey,
  coerceApiKeyExpiresAtMs,
  coerceApiKeyWindowMs,
  paidFallbackCreditsToMicrocredits,
  paidFallbackMicrocreditsToCredits,
} from "../api-keys.ts";
import {
  API_KEY_USAGE_V2_PREFIX,
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3RetentionMs,
  apiKeyUsageV3WindowKey,
  deleteApiKeyUsageV3,
  getApiKeyUsageV3,
  hasLiveApiKeyUsageReservationsV3,
  invalidateApiKeyPolicy,
  makeApiKeyUsageWindowV3,
  reclaimApiKeyUsageReservationsForKeyV3,
} from "../api-key-policy.ts";
import { apiKeyRequestLogPrefix, apiKeyUsageDailyKey, apiKeyUsageKey, legacyApiKeyRequestLogPrefix } from "../analytics.ts";
import { hasStrictPaidFallbackKeyPolicy, initializePaidFallbackPolicy, paidFallbackHashFields } from "../paid-fallback/index.ts";
import { deletePaidFallbackStateV3 } from "../paid-fallback/ledger-admission.ts";
import { paidFallbackDeletionGuardV3Key } from "../paid-fallback/ledger-state.ts";
import { getKv } from "../kv.ts";
import { LOCAL_DEVELOPMENT_KEY_ID, type LocalDevelopmentDeletionGuard } from "../auth/local-development-key.ts";
import { readJsonBody } from "../request.ts";
import { getString, isRecord } from "../utils.ts";
import type { ApiKeyHashRecord, ApiKeyRecord, ApiKeyUsageWindowV3 } from "../types.ts";
import { appendApiKeyChangeEvent, buildApiKeyChangeEvent, type ApiKeyAuditContext } from "./api-key-audit.ts";
import {
  normalizeApiKeyExpiresAtMs,
  normalizeApiKeyName,
  normalizeApiKeyUsageLimit,
  normalizeApiKeyWindowMsInput,
  normalizeOptionalBoolean,
  paidFallbackInitializationError,
  paidFallbackInputError,
  paidFallbackPublicFields,
  rejectRetiredApiKeyResetSetting,
} from "./api-keys.ts";

type ApiKeyUpdateTarget = Readonly<{
  ok: true;
  id: string;
  idKey: Deno.KvKey;
  entry: Deno.KvEntryMaybe<ApiKeyRecord>;
  record: ApiKeyRecord;
}>;

/** Reads the target key and enforces the paid-fallback migration policy. */
const resolveApiKeyUpdateTarget = async (kv: Deno.Kv, raw: Record<string, unknown>): Promise<ApiKeyUpdateTarget | { ok: false; response: Response }> => {
  const id = getString(raw.id);
  if (!id) return { ok: false, response: openaiError(400, "id is required", "invalid_request_error") };

  const idKey = apiKeyIdKey(id);
  const entry = await kv.get<ApiKeyRecord>(idKey);
  const record = entry.value;
  if (!record) return { ok: false, response: openaiError(404, "Not found", "not_found") };
  if (!hasStrictPaidFallbackKeyPolicy(record)) {
    return {
      ok: false,
      response: openaiError(503, "API key paid fallback migration is incomplete", "server_error", {
        type: "server_error",
      }),
    };
  }
  return { ok: true, id, idKey, entry, record };
};

type ApiKeyUpdateFields = Readonly<{
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

type ApiKeyUpdateIdentity = Pick<ApiKeyUpdateFields, "name" | "expiresAtMs">;
type ApiKeyUpdateQuota = Pick<ApiKeyUpdateFields, "usageLimitRequests" | "windowMs">;
type ApiKeyUpdatePaidFallback = Pick<
  ApiKeyUpdateFields,
  | "paidFallbackEnabled"
  | "paidFallbackLimitMicrocredits"
  | "paidFallbackModelIds"
  | "paidFallbackQuotaPerCredit"
  | "paidFallbackMaxExposureMicrocredits"
  | "paidFallbackPricingCheckedAtMs"
>;

/** `name` and `expires_at_ms`, validated in that order. */
const resolveApiKeyUpdateIdentity = (
  raw: Record<string, unknown>,
  record: ApiKeyRecord,
  currentExpiresAtMs: number,
  nowMs: number
): { ok: true; identity: ApiKeyUpdateIdentity } | { ok: false; response: Response } => {
  let name = record.name;
  if (Object.prototype.hasOwnProperty.call(raw, "name")) {
    const normalized = normalizeApiKeyName(raw.name);
    if (!normalized) return { ok: false, response: openaiError(400, "name must be a non-empty string (<=80 chars)", "invalid_request_error") };
    name = normalized;
  }

  let expiresAtMs = currentExpiresAtMs;
  if (Object.prototype.hasOwnProperty.call(raw, "expires_at_ms")) {
    const normalized = normalizeApiKeyExpiresAtMs(raw.expires_at_ms, nowMs);
    if (normalized === null) {
      return {
        ok: false,
        response: openaiError(400, "expires_at_ms must be a Unix epoch ms timestamp in the future, or -1", "invalid_request_error"),
      };
    }
    expiresAtMs = normalized;
  }

  return { ok: true, identity: { name, expiresAtMs } };
};

/** `usage_limit_requests` and `window_ms`, validated in that order. */
const resolveApiKeyUpdateQuota = (
  raw: Record<string, unknown>,
  record: ApiKeyRecord
): { ok: true; quota: ApiKeyUpdateQuota } | { ok: false; response: Response } => {
  let usageLimitRequests = record.usage_limit_requests;
  if (Object.prototype.hasOwnProperty.call(raw, "usage_limit_requests")) {
    const normalized = normalizeApiKeyUsageLimit(raw.usage_limit_requests);
    if (normalized === null) {
      return { ok: false, response: openaiError(400, "usage_limit_requests must be a non-negative number or -1 for unlimited", "invalid_request_error") };
    }
    usageLimitRequests = normalized;
  }

  let windowMs = coerceApiKeyWindowMs(record);
  if (Object.prototype.hasOwnProperty.call(raw, "window_ms")) {
    const normalized = normalizeApiKeyWindowMsInput(raw.window_ms);
    if (normalized === null) {
      return { ok: false, response: openaiError(400, "window_ms must be a positive number", "invalid_request_error") };
    }
    windowMs = normalized;
  }

  return { ok: true, quota: { usageLimitRequests, windowMs } };
};

/**
 * The paid-fallback patch, including the one-shot Metered policy initialization
 * that only runs when the key is being enabled for the first time.
 */
const resolveApiKeyUpdatePaidFallback = async (
  raw: Record<string, unknown>,
  record: ApiKeyRecord,
  signal: AbortSignal
): Promise<{ ok: true; paidFallback: ApiKeyUpdatePaidFallback } | { ok: false; response: Response }> => {
  if (Object.prototype.hasOwnProperty.call(raw, "paid_fallback_enabled") && typeof raw.paid_fallback_enabled !== "boolean") {
    return { ok: false, response: paidFallbackInputError("paid_fallback_enabled must be a boolean") };
  }
  let paidFallbackEnabled = record.paid_fallback_enabled;
  if (Object.prototype.hasOwnProperty.call(raw, "paid_fallback_enabled")) {
    paidFallbackEnabled = raw.paid_fallback_enabled === true;
  }

  let paidFallbackLimitMicrocredits = record.paid_fallback_limit_microcredits;
  if (Object.prototype.hasOwnProperty.call(raw, "paid_fallback_limit_credits")) {
    const limitMicrocredits = paidFallbackCreditsToMicrocredits(raw.paid_fallback_limit_credits);
    if (limitMicrocredits === null) {
      return { ok: false, response: paidFallbackInputError("paid_fallback_limit_credits must be a non-negative number or -1") };
    }
    paidFallbackLimitMicrocredits = limitMicrocredits;
  }
  if (paidFallbackEnabled && paidFallbackLimitMicrocredits === 0) {
    return { ok: false, response: paidFallbackInputError("paid_fallback_limit_credits must be positive or -1 when paid fallback is enabled") };
  }

  const paidFallback: ApiKeyUpdatePaidFallback = {
    paidFallbackEnabled,
    paidFallbackLimitMicrocredits,
    paidFallbackModelIds: record.paid_fallback_model_ids,
    paidFallbackQuotaPerCredit: record.paid_fallback_quota_per_credit,
    paidFallbackMaxExposureMicrocredits: record.paid_fallback_max_exposure_microcredits ?? {},
    paidFallbackPricingCheckedAtMs: record.paid_fallback_pricing_checked_at_ms,
  };
  if (record.paid_fallback_enabled || !paidFallbackEnabled) return { ok: true, paidFallback };

  try {
    const initialized = await initializePaidFallbackPolicy(signal);
    return {
      ok: true,
      paidFallback: {
        ...paidFallback,
        paidFallbackModelIds: [...initialized.paid_fallback_model_ids],
        paidFallbackQuotaPerCredit: initialized.paid_fallback_quota_per_credit,
        paidFallbackMaxExposureMicrocredits: initialized.paid_fallback_max_exposure_microcredits ?? {},
        paidFallbackPricingCheckedAtMs: initialized.paid_fallback_pricing_checked_at_ms,
      },
    };
  } catch (error) {
    return { ok: false, response: paidFallbackInitializationError(error) };
  }
};

const resolveApiKeyUpdateFields = async (
  raw: Record<string, unknown>,
  record: ApiKeyRecord,
  currentExpiresAtMs: number,
  nowMs: number,
  signal: AbortSignal
): Promise<{ ok: true; fields: ApiKeyUpdateFields } | { ok: false; response: Response }> => {
  const identity = resolveApiKeyUpdateIdentity(raw, record, currentExpiresAtMs, nowMs);
  if (!identity.ok) return identity;

  const quota = resolveApiKeyUpdateQuota(raw, record);
  if (!quota.ok) return quota;

  const paidFallback = await resolveApiKeyUpdatePaidFallback(raw, record, signal);
  if (!paidFallback.ok) return paidFallback;

  if (Object.prototype.hasOwnProperty.call(raw, "reset_usage") && typeof raw.reset_usage !== "boolean") {
    return { ok: false, response: openaiError(400, "reset_usage must be a boolean", "invalid_request_error") };
  }

  return {
    ok: true,
    fields: {
      ...identity.identity,
      ...quota.quota,
      ...paidFallback.paidFallback,
      resetUsage: normalizeOptionalBoolean(raw.reset_usage),
    },
  };
};

/**
 * Merges the patch into the stored record. A reset (explicit, or implied by a
 * window change) must always select a distinct V3 aggregate identity: a create
 * followed by an immediate reset can otherwise share the same millisecond start
 * and overwrite the current window instead of opening a fresh one.
 */
const buildApiKeyUpdateRecord = (
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
const apiKeyUpdateChanged = (record: ApiKeyRecord, updated: ApiKeyRecord, currentExpiresAtMs: number, currentWindowMs: number, resetUsage: boolean): boolean =>
  apiKeyUpdateIdentityChanged(record, updated, currentExpiresAtMs) ||
  apiKeyUpdateQuotaChanged(record, updated, currentWindowMs, resetUsage) ||
  apiKeyUpdatePaidFallbackChanged(record, updated);

/** The safe policy fields that actually changed, ready for the audit allowlist. */
const apiKeyUpdateAuditChanges = (
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

/** The no-op response, which reports the live usage counter of the stored policy. */
const apiKeyUpdateUnchangedResponse = async (
  kv: Deno.Kv,
  record: ApiKeyRecord,
  currentExpiresAtMs: number,
  currentWindowMs: number,
  nowMs: number
): Promise<Response> => {
  const currentPolicy = apiKeyPolicyFromHashRecord(
    record.hash,
    {
      id: record.id,
      expires_at_ms: record.expires_at_ms,
      revoked_at_ms: record.revoked_at_ms,
      usage_limit_requests: record.usage_limit_requests,
      usage_requests: record.usage_requests,
      usage_reset_at_ms: record.usage_reset_at_ms,
      window_ms: record.window_ms,
      usage_quota_version: record.usage_quota_version,
      ...paidFallbackHashFields(record),
    },
    nowMs
  );
  return json(
    200,
    {
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      created_at_ms: record.created_at_ms,
      expires_at_ms: currentExpiresAtMs,
      revoked_at_ms: record.revoked_at_ms,
      usage_limit_requests: record.usage_limit_requests,
      usage_requests: currentPolicy ? await getApiKeyUsageV3(currentPolicy, kv) : 0,
      usage_reset_at_ms: record.usage_reset_at_ms,
      window_ms: currentWindowMs,
      ...(await paidFallbackPublicFields(record, kv)),
    },
    { "x-uos-upstream": "chatgpt_codex" }
  );
};

/**
 * Reads the superseded V3 aggregate after reclaim and before the live scan. A
 * reservation before this read is included in the scan; one after it mutates
 * this checked entry and makes the reset conflict atomically.
 */
const inspectApiKeyQuotaResetReservations = async (
  kv: Deno.Kv,
  input: Readonly<{ keyId: string; currentQuotaPolicy: NonNullable<ReturnType<typeof apiKeyPolicyFromHashRecord>>; nowMs: number }>
): Promise<{ ok: true; windowEntry: Deno.KvEntryMaybe<ApiKeyUsageWindowV3> } | { ok: false; response: Response }> => {
  try {
    await reclaimApiKeyUsageReservationsForKeyV3(kv, input.keyId, input.nowMs);
    const windowEntry = await kv.get<ApiKeyUsageWindowV3>(apiKeyUsageV3WindowKey(input.currentQuotaPolicy), { consistency: "strong" });
    if (await hasLiveApiKeyUsageReservationsV3(kv, input.keyId, input.nowMs)) {
      return {
        ok: false,
        response: openaiError(
          409,
          "Cannot reset API key quota while requests are reserved; retry after their five-minute lease expires",
          "invalid_request_error"
        ),
      };
    }
    return { ok: true, windowEntry };
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to inspect API key quota reservations before reset:", error);
    return { ok: false, response: openaiError(503, "API key quota ledger is unavailable", "server_error", { type: "server_error" }) };
  }
};

/** Rechecks reservations after a lost commit race, then reports the conflict. */
const resolveApiKeyUpdateCommitConflict = async (
  kv: Deno.Kv,
  input: Readonly<{ keyId: string; nowMs: number; replaceQuotaWindow: boolean }>
): Promise<Response> => {
  if (!input.replaceQuotaWindow) return openaiError(409, "API key was modified concurrently; retry", "invalid_request_error");
  try {
    await reclaimApiKeyUsageReservationsForKeyV3(kv, input.keyId, input.nowMs);
    if (await hasLiveApiKeyUsageReservationsV3(kv, input.keyId, input.nowMs)) {
      return openaiError(409, "Cannot reset API key quota while requests are reserved; retry after their five-minute lease expires", "invalid_request_error");
    }
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to recheck API key quota reservations after reset conflict:", error);
    return openaiError(503, "API key quota ledger is unavailable", "server_error", { type: "server_error" });
  }
  return openaiError(409, "API key was modified concurrently; retry", "invalid_request_error");
};

/** Writes the record, hash record, and (when the window is replaced) quota windows atomically. */
const persistApiKeyUpdate = async (
  kv: Deno.Kv,
  input: Readonly<{
    idKey: Deno.KvKey;
    entry: Deno.KvEntryMaybe<ApiKeyRecord>;
    record: ApiKeyRecord;
    updated: ApiKeyRecord;
    replaceQuotaWindow: boolean;
    nowMs: number;
    currentExpiresAtMs: number;
    currentWindowMs: number;
    resetUsage: boolean;
    context?: ApiKeyAuditContext;
  }>
): Promise<
  { ok: true; updated: ApiKeyRecord; quotaPolicy: NonNullable<ReturnType<typeof apiKeyPolicyFromHashRecord>> } | { ok: false; response: Response }
> => {
  const hashKey = apiKeyHashKey(input.record.hash);
  const hashEntry = await kv.get<ApiKeyHashRecord>(hashKey);
  const updatedHash: ApiKeyHashRecord = {
    id: input.updated.id,
    expires_at_ms: input.updated.expires_at_ms,
    revoked_at_ms: input.updated.revoked_at_ms,
    usage_limit_requests: input.updated.usage_limit_requests,
    usage_requests: input.updated.usage_requests,
    usage_reset_at_ms: input.updated.usage_reset_at_ms,
    window_ms: input.updated.window_ms,
    usage_quota_version: input.updated.usage_quota_version,
    ...paidFallbackHashFields(input.updated),
  };

  const quotaPolicy = apiKeyPolicyFromHashRecord(input.updated.hash, updatedHash, input.nowMs);
  if (!quotaPolicy) {
    return { ok: false, response: openaiError(503, "API key quota migration is incomplete", "server_error", { type: "server_error" }) };
  }

  let currentQuotaWindowEntry: Deno.KvEntryMaybe<ApiKeyUsageWindowV3> | null = null;
  if (input.replaceQuotaWindow) {
    // The guard lives here so control-flow narrowing proves `currentQuotaPolicy`
    // is non-null for `apiKeyUsageV3WindowKey` below.
    const currentQuotaPolicy = apiKeyPolicyFromHashRecord(input.record.hash, input.record, input.nowMs);
    if (!currentQuotaPolicy) {
      return { ok: false, response: openaiError(503, "API key quota migration is incomplete", "server_error", { type: "server_error" }) };
    }
    const inspected = await inspectApiKeyQuotaResetReservations(kv, { keyId: input.updated.id, currentQuotaPolicy, nowMs: input.nowMs });
    if (!inspected.ok) return inspected;
    currentQuotaWindowEntry = inspected.windowEntry;
  }

  const quotaWindow = input.replaceQuotaWindow ? makeApiKeyUsageWindowV3(quotaPolicy, input.nowMs) : null;
  const quotaWindowEntry = quotaWindow ? await kv.get(apiKeyUsageV3WindowKey(quotaPolicy), { consistency: "strong" }) : null;

  const atomic = kv.atomic().check(input.entry).check(hashEntry).set(input.idKey, input.updated).set(hashKey, updatedHash);
  if (quotaWindow && quotaWindowEntry) {
    atomic.check(quotaWindowEntry).set(apiKeyUsageV3WindowKey(quotaPolicy), quotaWindow, {
      expireIn: apiKeyUsageV3RetentionMs(quotaWindow.window_reset_at_ms, input.nowMs),
    });
  }
  if (currentQuotaWindowEntry) atomic.check(currentQuotaWindowEntry);
  appendApiKeyChangeEvent(
    atomic,
    buildApiKeyChangeEvent({
      action: "update",
      targetKeyId: input.updated.id,
      targetKeyName: input.updated.name,
      changed: apiKeyUpdateAuditChanges(input.record, input.updated, input.currentExpiresAtMs, input.currentWindowMs, input.resetUsage),
      context: input.context,
      nowMs: input.nowMs,
    })
  );

  const commit = await atomic.commit();
  if (!commit.ok) {
    return {
      ok: false,
      response: await resolveApiKeyUpdateCommitConflict(kv, {
        keyId: input.updated.id,
        nowMs: input.nowMs,
        replaceQuotaWindow: input.replaceQuotaWindow,
      }),
    };
  }
  invalidateApiKeyPolicy(input.updated.id);
  return { ok: true, updated: input.updated, quotaPolicy };
};

export const handleAdminApiKeysUpdate = async (req: Request, context?: ApiKeyAuditContext): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot manage API keys", "server_error");
  }

  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const retiredResetSettingError = rejectRetiredApiKeyResetSetting(raw);
  if (retiredResetSettingError) return retiredResetSettingError;

  const target = await resolveApiKeyUpdateTarget(kv, raw);
  if (!target.ok) return target.response;
  const { idKey, entry, record } = target;

  const now = Date.now();
  const currentExpiresAtMs = coerceApiKeyExpiresAtMs(record);
  const currentWindowMs = coerceApiKeyWindowMs(record);
  const fields = await resolveApiKeyUpdateFields(raw, record, currentExpiresAtMs, now, req.signal);
  if (!fields.ok) return fields.response;

  const { updated, resetUsage, replaceQuotaWindow } = buildApiKeyUpdateRecord(record, fields.fields, now, currentWindowMs);
  if (!apiKeyUpdateChanged(record, updated, currentExpiresAtMs, currentWindowMs, resetUsage)) {
    return await apiKeyUpdateUnchangedResponse(kv, record, currentExpiresAtMs, currentWindowMs, now);
  }

  const persisted = await persistApiKeyUpdate(kv, {
    idKey,
    entry,
    record,
    updated,
    replaceQuotaWindow,
    nowMs: now,
    currentExpiresAtMs,
    currentWindowMs,
    resetUsage,
    context,
  });
  if (!persisted.ok) return persisted.response;

  return json(
    200,
    {
      id: persisted.updated.id,
      name: persisted.updated.name,
      prefix: persisted.updated.prefix,
      created_at_ms: persisted.updated.created_at_ms,
      expires_at_ms: coerceApiKeyExpiresAtMs(persisted.updated),
      revoked_at_ms: persisted.updated.revoked_at_ms,
      usage_limit_requests: persisted.updated.usage_limit_requests,
      usage_requests: await getApiKeyUsageV3(persisted.quotaPolicy, kv),
      usage_reset_at_ms: persisted.updated.usage_reset_at_ms,
      window_ms: persisted.updated.window_ms,
      ...(await paidFallbackPublicFields(persisted.updated, kv)),
    },
    { "x-uos-upstream": "chatgpt_codex" }
  );
};

export const handleAdminApiKeysRevoke = async (req: Request, context?: ApiKeyAuditContext): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot manage API keys", "server_error");
  }

  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const id = getString(raw.id);
  if (!id) return openaiError(400, "id is required", "invalid_request_error");

  const idKey = apiKeyIdKey(id);
  const entry = await kv.get<ApiKeyRecord>(idKey);
  if (!entry.value) return openaiError(404, "Not found", "not_found");
  if (!hasStrictPaidFallbackKeyPolicy(entry.value)) {
    return openaiError(503, "API key paid fallback migration is incomplete", "server_error", {
      type: "server_error",
    });
  }

  const now = Date.now();
  const expiresAtMs = coerceApiKeyExpiresAtMs(entry.value);
  const updated: ApiKeyRecord = entry.value.revoked_at_ms
    ? { ...entry.value, expires_at_ms: expiresAtMs }
    : { ...entry.value, expires_at_ms: expiresAtMs, revoked_at_ms: now };
  const hashKey = apiKeyHashKey(entry.value.hash);
  const hashEntry = await kv.get<ApiKeyHashRecord>(hashKey);
  const updatedHash: ApiKeyHashRecord = {
    id,
    expires_at_ms: updated.expires_at_ms,
    revoked_at_ms: updated.revoked_at_ms,
    usage_limit_requests: updated.usage_limit_requests,
    usage_requests: updated.usage_requests,
    usage_reset_at_ms: updated.usage_reset_at_ms,
    window_ms: updated.window_ms,
    usage_quota_version: updated.usage_quota_version,
    ...paidFallbackHashFields(updated),
  };

  const atomic = kv.atomic().check(entry).set(idKey, updated).set(hashKey, updatedHash);
  if (hashEntry.versionstamp) atomic.check(hashEntry);
  appendApiKeyChangeEvent(
    atomic,
    buildApiKeyChangeEvent({
      action: "revoke",
      targetKeyId: id,
      targetKeyName: updated.name,
      changed: {
        ...(updated.revoked_at_ms !== entry.value.revoked_at_ms ? { revoked_at_ms: updated.revoked_at_ms } : {}),
        ...(updated.expires_at_ms !== entry.value.expires_at_ms ? { expires_at_ms: updated.expires_at_ms } : {}),
      },
      context,
      nowMs: now,
    })
  );

  const commit = await atomic.commit();
  if (!commit.ok) {
    return openaiError(409, "API key was modified concurrently; retry", "invalid_request_error");
  }
  invalidateApiKeyPolicy(updated.id);

  return json(
    200,
    {
      id: updated.id,
      revoked_at_ms: updated.revoked_at_ms,
    },
    { "x-uos-upstream": "chatgpt_codex" }
  );
};

export const handleAdminApiKeysUnrevoke = async (req: Request, context?: ApiKeyAuditContext): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot manage API keys", "server_error");
  }

  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const id = getString(raw.id);
  if (!id) return openaiError(400, "id is required", "invalid_request_error");

  const idKey = apiKeyIdKey(id);
  const entry = await kv.get<ApiKeyRecord>(idKey);
  if (!entry.value) return openaiError(404, "Not found", "not_found");
  if (!hasStrictPaidFallbackKeyPolicy(entry.value)) {
    return openaiError(503, "API key paid fallback migration is incomplete", "server_error", {
      type: "server_error",
    });
  }

  const deletionGuard = await kv.get(paidFallbackDeletionGuardV3Key(id), { consistency: "strong" });
  if (deletionGuard.value) {
    return openaiError(409, "API key deletion is in progress and cannot be reversed", "paid_fallback_deletion_in_progress");
  }
  if (!entry.value.revoked_at_ms) {
    return json(200, { id, revoked_at_ms: null }, { "x-uos-upstream": "chatgpt_codex" });
  }

  const now = Date.now();
  const expiresAtMs = coerceApiKeyExpiresAtMs(entry.value);
  const updated: ApiKeyRecord = { ...entry.value, expires_at_ms: expiresAtMs, revoked_at_ms: null };
  const hashKey = apiKeyHashKey(entry.value.hash);
  const hashEntry = await kv.get<ApiKeyHashRecord>(hashKey);
  const updatedHash: ApiKeyHashRecord = {
    id,
    expires_at_ms: updated.expires_at_ms,
    revoked_at_ms: updated.revoked_at_ms,
    usage_limit_requests: updated.usage_limit_requests,
    usage_requests: updated.usage_requests,
    usage_reset_at_ms: updated.usage_reset_at_ms,
    window_ms: updated.window_ms,
    usage_quota_version: updated.usage_quota_version,
    ...paidFallbackHashFields(updated),
  };

  const atomic = kv.atomic().check(entry).check(deletionGuard).set(idKey, updated).set(hashKey, updatedHash);
  if (hashEntry.versionstamp) atomic.check(hashEntry);
  appendApiKeyChangeEvent(
    atomic,
    buildApiKeyChangeEvent({
      action: "unrevoke",
      targetKeyId: id,
      targetKeyName: updated.name,
      changed: { revoked_at_ms: null },
      context,
      nowMs: now,
    })
  );

  const commit = await atomic.commit();
  if (!commit.ok) {
    return openaiError(409, "API key was modified concurrently; retry", "invalid_request_error");
  }
  invalidateApiKeyPolicy(updated.id);

  return json(
    200,
    {
      id: updated.id,
      revoked_at_ms: updated.revoked_at_ms,
    },
    { "x-uos-upstream": "chatgpt_codex" }
  );
};

type LocalApiKeyDeletionClaim = Readonly<{
  guard: LocalDevelopmentDeletionGuard;
  check: Readonly<{ key: Deno.KvKey; versionstamp: string }>;
}>;

const retryableLocalDeletionGuard = (value: unknown): LocalDevelopmentDeletionGuard | null => {
  if (!isRecord(value) || !isRecord(value.local_deletion)) return null;
  if (typeof value.created_at_ms !== "number" || !Number.isSafeInteger(value.created_at_ms) || value.created_at_ms <= 0) return null;
  if (value.local_deletion.owner !== null || value.local_deletion.completed_at_ms !== null) return null;
  return { created_at_ms: value.created_at_ms, local_deletion: { owner: null, completed_at_ms: null } };
};

const claimLocalDeletion = async (
  kv: Deno.Kv,
  entry: Deno.KvEntryMaybe<ApiKeyRecord>,
  deletionGuard: Deno.KvEntryMaybe<unknown>
): Promise<LocalApiKeyDeletionClaim | Response> => {
  const retryable = retryableLocalDeletionGuard(deletionGuard.value);
  if (deletionGuard.value && !retryable) return openaiError(409, "Local API key deletion already has an owner", "paid_fallback_deletion_in_progress");
  const guard: LocalDevelopmentDeletionGuard = {
    created_at_ms: retryable?.created_at_ms ?? Date.now(),
    local_deletion: { owner: crypto.randomUUID(), completed_at_ms: null },
  };
  const claim = await kv.atomic().check(entry).check(deletionGuard).set(deletionGuard.key, guard).commit();
  return claim.ok
    ? { guard, check: { key: deletionGuard.key, versionstamp: claim.versionstamp } }
    : openaiError(409, "Local API key deletion was claimed concurrently", "paid_fallback_deletion_in_progress");
};

const prepareDeletionGuard = async (
  kv: Deno.Kv,
  id: string,
  entry: Deno.KvEntryMaybe<ApiKeyRecord>,
  deletionGuard: Deno.KvEntryMaybe<unknown>
): Promise<LocalApiKeyDeletionClaim | Response | null> => {
  if (id === LOCAL_DEVELOPMENT_KEY_ID) return await claimLocalDeletion(kv, entry, deletionGuard);
  if (deletionGuard.value) return null;
  const commit = await kv.atomic().check(entry).check(deletionGuard).set(deletionGuard.key, { created_at_ms: Date.now() }).commit();
  return commit.ok ? null : openaiError(409, "API key was modified concurrently; retry", "invalid_request_error");
};

/** Only a known refusal before ID deletion releases ownership for explicit retry. */
const releaseLocalDeletionClaim = async (kv: Deno.Kv, entry: Deno.KvEntryMaybe<ApiKeyRecord>, claim: LocalApiKeyDeletionClaim | null): Promise<void> => {
  if (!claim) return;
  await kv
    .atomic()
    .check(entry)
    .check(claim.check)
    .set(claim.check.key, {
      ...claim.guard,
      local_deletion: { owner: null, completed_at_ms: null },
    })
    .commit();
};

/** A failed ID deletion can release only after a fresh read still proves the key is revoked. */
const releaseLocalDeletionClaimAfterConflict = async (kv: Deno.Kv, idKey: Deno.KvKey, claim: LocalApiKeyDeletionClaim | null): Promise<void> => {
  try {
    if (!claim) return;
    const entry = await kv.get<ApiKeyRecord>(idKey, { consistency: "strong" });
    if (!entry.value?.revoked_at_ms) return;
    await releaseLocalDeletionClaim(kv, entry, claim);
  } catch (error) {
    console.error("[ai.ubq.fi] Failed to release local API key deletion claim after a concurrent update:", { error });
  }
};

const completeLocalDeletion = async (kv: Deno.Kv, idKey: Deno.KvKey, claim: LocalApiKeyDeletionClaim | null): Promise<Response | null> => {
  if (!claim) return null;
  const absentId = await kv.get(idKey, { consistency: "strong" });
  if (absentId.value) return openaiError(409, "Local API key deletion ownership changed", "paid_fallback_deletion_in_progress");
  const completion = await kv
    .atomic()
    .check(absentId)
    .check(claim.check)
    .set(claim.check.key, {
      ...claim.guard,
      local_deletion: { ...claim.guard.local_deletion, completed_at_ms: Date.now() },
    })
    .commit();
  return completion.ok ? null : openaiError(409, "Local API key deletion ownership changed", "paid_fallback_deletion_in_progress");
};

export const handleAdminApiKeysDelete = async (req: Request, context?: ApiKeyAuditContext): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot manage API keys", "server_error");
  }

  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const id = getString(raw.id);
  if (!id) return openaiError(400, "id is required", "invalid_request_error");

  const idKey = apiKeyIdKey(id);
  const entry = await kv.get<ApiKeyRecord>(idKey);
  if (!entry.value) return openaiError(404, "Not found", "not_found");

  if (!entry.value.revoked_at_ms) {
    return openaiError(400, "Only revoked keys can be deleted", "invalid_request_error");
  }

  const deletionGuardKey = paidFallbackDeletionGuardV3Key(id);
  const deletionGuard = await kv.get(deletionGuardKey, { consistency: "strong" });
  const localDeletionClaim = await prepareDeletionGuard(kv, id, entry, deletionGuard);
  if (localDeletionClaim instanceof Response) return localDeletionClaim;

  let paidFallbackDeletion: Awaited<ReturnType<typeof deletePaidFallbackStateV3>>;
  try {
    paidFallbackDeletion = await deletePaidFallbackStateV3(id, kv);
  } catch (error) {
    console.error("[ai.ubq.fi] Failed to clean V3 paid fallback state before API key deletion:", {
      error,
    });
    await releaseLocalDeletionClaim(kv, entry, localDeletionClaim);
    return openaiError(500, "Failed to prepare paid fallback state for API key deletion", "server_error");
  }
  if (paidFallbackDeletion.kind === "unavailable") {
    await releaseLocalDeletionClaim(kv, entry, localDeletionClaim);
    return openaiError(500, "Deno KV is not available; cannot inspect paid fallback billing", "server_error");
  }
  if (paidFallbackDeletion.kind === "blocked") {
    await releaseLocalDeletionClaim(kv, entry, localDeletionClaim);
    const outstandingPaidFallback = paidFallbackDeletion.outstanding;
    return openaiError(
      409,
      `Cannot delete API key while metered billing is pending or unresolved ` +
        `(pending=${outstandingPaidFallback.pending_requests}, ` +
        `unresolved=${outstandingPaidFallback.unresolved_requests}, ` +
        `markers=${outstandingPaidFallback.pending_markers})`,
      "paid_fallback_billing_outstanding"
    );
  }

  const atomic = kv.atomic().check(entry).delete(idKey).delete(apiKeyHashKey(entry.value.hash)).delete(apiKeyUsageKey(id)).delete(apiKeyUsageDailyKey(id));
  if (localDeletionClaim) atomic.check(localDeletionClaim.check);
  appendApiKeyChangeEvent(
    atomic,
    buildApiKeyChangeEvent({
      action: "delete",
      targetKeyId: id,
      targetKeyName: entry.value.name,
      changed: {},
      context,
      nowMs: Date.now(),
    })
  );

  const commit = await atomic.commit();
  if (!commit.ok) {
    await releaseLocalDeletionClaimAfterConflict(kv, idKey, localDeletionClaim);
    return openaiError(409, "API key was modified concurrently; retry", "invalid_request_error");
  }
  invalidateApiKeyPolicy(id);

  for await (const requestEntry of kv.list({ prefix: apiKeyRequestLogPrefix(id) })) {
    await kv.delete(requestEntry.key);
  }
  for await (const legacyRequestEntry of kv.list({ prefix: legacyApiKeyRequestLogPrefix(id) })) {
    await kv.delete(legacyRequestEntry.key);
  }
  for await (const counterEntry of kv.list({ prefix: [...API_KEY_USAGE_V2_PREFIX, id] })) {
    await kv.delete(counterEntry.key);
  }
  await deleteApiKeyUsageV3(kv, id);

  const completionError = await completeLocalDeletion(kv, idKey, localDeletionClaim);
  if (completionError) return completionError;

  return json(200, { id }, { "x-uos-upstream": "chatgpt_codex" });
};
