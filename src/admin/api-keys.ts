import type { Kv } from "#kv";
// Admin API key creation and listing, split out of src/admin.ts.

import { normalizeReasoningEffort, type ReasoningEffort } from "../defaults.ts";
import { json, openaiError } from "../http.ts";
import {
  API_KEY_ID_PREFIX,
  API_KEY_NO_EXPIRATION_MS,
  API_KEY_NO_USAGE_LIMIT,
  apiKeyHashKey,
  apiKeyIdKey,
  calculateNextResetMs,
  coerceApiKeyExpiresAtMs,
  coerceApiKeyWindowMs,
  DEFAULT_USAGE_LIMIT_REQUESTS,
  generateApiKeyToken,
  getDefaultExpiryMs,
  paidFallbackCreditsToMicrocredits,
  paidFallbackMicrocreditsToCredits,
  USAGE_RESET_PERIOD_MS,
} from "../api-keys.ts";
import {
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3RetentionMs,
  apiKeyUsageV3WindowKey,
  getApiKeyUsageV3,
  looksLikeUosApiKey,
  makeApiKeyUsageWindowV3,
} from "../api-key-policy.ts";
import { defaultPaidFallbackPolicy, initializePaidFallbackPolicy, paidFallbackHashFields } from "../paid-fallback/index.ts";
import { reconcileDuePaidFallbacksV3 } from "../paid-fallback/ledger-backfill.ts";
import { getPaidFallbackProviderUsageV3, getPaidFallbackWindowProjectionV3, listPaidFallbackRequestsV3 } from "../paid-fallback/ledger-state.ts";
import { appendApiKeyChangeEvent, buildApiKeyChangeEvent, type ApiKeyAuditContext } from "./api-key-audit.ts";
import { getKv } from "../kv.ts";
import { readJsonBody } from "../request.ts";
import { isRecord, sha256Base64Url } from "../utils.ts";
import type { ApiKeyHashRecord, ApiKeyRecord } from "../types.ts";
import { MeteredError } from "../provider/metered.ts";

const normalizeApiKeyName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name) return null;
  if (name.length > 80) return null;
  if (/[\r\n]/.test(name)) return null;
  return name;
};

const normalizeOptionalApiKeyToken = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const token = value.trim();
  return looksLikeUosApiKey(token) ? token : null;
};

const normalizeApiKeyExpiresAtMs = (value: unknown, nowMs: number): number | null => {
  if (value === undefined || value === null) return getDefaultExpiryMs(nowMs);
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const expiresAtMs = Math.trunc(value);
  if (expiresAtMs === API_KEY_NO_EXPIRATION_MS) return API_KEY_NO_EXPIRATION_MS;
  if (expiresAtMs < 0) return null;
  if (expiresAtMs <= nowMs) return null;
  return expiresAtMs;
};

const shouldIncludeUsage = (value: string | null): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const normalizeApiKeyUsageLimit = (value: unknown): number | null => {
  if (value === undefined || value === null) return DEFAULT_USAGE_LIMIT_REQUESTS;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const limit = Math.trunc(value);
  if (limit === API_KEY_NO_USAGE_LIMIT) return API_KEY_NO_USAGE_LIMIT;
  if (limit < 0) return null;
  return limit;
};

const normalizeWindowMsInput = (value: unknown): number | null => {
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

/** API-key quota windows and Kernel policy windows share this positive-number validation. */
const normalizeApiKeyWindowMsInput = normalizeWindowMsInput;
const normalizeKernelWindowMsInput = normalizeWindowMsInput;

const paidFallbackInputError = (message: string): Response => openaiError(400, message, "invalid_request_error");

const rejectRetiredApiKeyResetSetting = (raw: Record<string, unknown>): Response | null => {
  if (!Object.prototype.hasOwnProperty.call(raw, "banked_resets_enabled")) return null;
  return openaiError(400, "banked_resets_enabled is retired; configure banked resets per Codex subscription", "invalid_request_error");
};

const paidFallbackInitializationError = (error: unknown): Response => {
  if (error instanceof MeteredError) {
    return openaiError(error.status, error.message, error.code, { type: "server_error" });
  }
  console.error("[ai.ubq.fi] Failed to initialize Metered paid fallback:", error);
  return openaiError(502, "Failed to initialize Metered paid fallback", "metered_pricing_unavailable", {
    type: "server_error",
  });
};

const paidFallbackPublicFields = async (record: ApiKeyRecord, kv: Kv, windowResetAtMs = record.usage_reset_at_ms) => {
  const [projection, providerUsage] = await Promise.all([
    getPaidFallbackWindowProjectionV3(record.id, windowResetAtMs, record.paid_fallback_limit_microcredits, kv),
    getPaidFallbackProviderUsageV3(record.id, windowResetAtMs, kv),
  ]);
  return {
    paid_fallback_enabled: record.paid_fallback_enabled,
    paid_fallback_limit_credits: paidFallbackMicrocreditsToCredits(record.paid_fallback_limit_microcredits),
    paid_fallback_spent_credits: paidFallbackMicrocreditsToCredits(projection?.settled_microcredits ?? 0),
    paid_fallback_reserved_credits: paidFallbackMicrocreditsToCredits(projection?.reserved_microcredits ?? 0),
    paid_fallback_pending_count: projection?.pending_count ?? 0,
    paid_fallback_provider_usage: providerUsage,
    paid_fallback_model_ids: record.paid_fallback_model_ids,
    paid_fallback_pricing_checked_at_ms: record.paid_fallback_pricing_checked_at_ms,
  };
};

const paidFallbackHistoryRecord = (request: Awaited<ReturnType<typeof listPaidFallbackRequestsV3>>[number]) => {
  const startedAtMs = request.dispatched_at_ms ?? request.created_at_ms;
  const completedAtMs = request.terminal_at_ms;
  return {
    ...request,
    id: request.request_id,
    method: "POST",
    status_code: request.terminal_state === "completed" ? 200 : null,
    provider: request.provider ?? "metered",
    fallback_reason: "codex_429",
    started_at_ms: startedAtMs,
    completed_at_ms: completedAtMs,
    latency_ms: completedAtMs === null ? null : Math.max(0, completedAtMs - startedAtMs),
    paid_fallback_window_reset_at_ms: request.window_reset_at_ms,
    billing_status: request.billing_state === "settled" ? "reconciled" : request.billing_state,
  };
};

const normalizeKernelRepoPart = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 100) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.includes("/")) return null;
  return trimmed;
};

const normalizeKernelUsageLimitInput = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed === "unlimited") return API_KEY_NO_USAGE_LIMIT;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    value = parsed;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const limit = Math.trunc(value);
  if (limit === API_KEY_NO_USAGE_LIMIT) return API_KEY_NO_USAGE_LIMIT;
  if (limit < 0) return null;
  return limit;
};

const normalizeKernelExpiresAtMsInput = (value: unknown, nowMs: number): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    value = parsed;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const expiresAtMs = Math.trunc(value);
  if (expiresAtMs === API_KEY_NO_EXPIRATION_MS) return API_KEY_NO_EXPIRATION_MS;
  if (expiresAtMs <= nowMs) return null;
  return expiresAtMs;
};

const normalizeKernelScope = (value: unknown): "repo" | "org" => {
  if (typeof value !== "string") return "repo";
  const normalized = value.trim().toLowerCase();
  if (normalized === "org") return "org";
  return "repo";
};

const normalizeOptionalBoolean = (value: unknown): boolean => {
  return value === true;
};

const normalizeDefaultModel = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const model = value.trim();
  if (!model) return null;
  if (/\s/.test(model)) return null;
  return model;
};

const extractModelReasoningLevels = (model: Record<string, unknown> | null): ReasoningEffort[] => {
  if (!model) return [];
  const raw = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
  const levels = raw
    .map((entry): ReasoningEffort | null => {
      if (entry === null) return "none";
      if (typeof entry === "string") return normalizeReasoningEffort(entry);
      if (isRecord(entry)) return entry.effort === null ? "none" : normalizeReasoningEffort(entry.effort);
      return null;
    })
    .filter((entry): entry is ReasoningEffort => Boolean(entry));
  return Array.from(new Set(levels));
};

const estimateJsonSize = (value: unknown): number | null => {
  try {
    const text = JSON.stringify(value);
    return new TextEncoder().encode(text).length;
  } catch {
    return null;
  }
};

const MAX_KV_BYTES = 65_536;
const SAFE_KV_BYTES = 60_000;

type ApiKeyCreateFields = Readonly<{
  expiresAtMs: number;
  usageLimitRequests: number;
  windowMs: number;
  paidFallbackEnabled: boolean;
  paidFallbackLimitMicrocredits: number;
}>;

/** Resolves the caller-supplied token, or mints one when it is absent. */
const resolveApiKeyCreateToken = (raw: Record<string, unknown>): { ok: true; token: string } | { ok: false; response: Response } => {
  const providedToken = normalizeOptionalApiKeyToken(raw.token);
  if (raw.token !== undefined && raw.token !== null && providedToken === null) {
    return { ok: false, response: openaiError(400, "token must use the u_ prefix followed by 64 lowercase hexadecimal characters", "invalid_request_error") };
  }
  return { ok: true, token: providedToken ?? generateApiKeyToken() };
};

/** `paid_fallback_enabled` and `paid_fallback_limit_credits`, validated in that order. */
const resolveApiKeyCreatePaidFallback = (
  raw: Record<string, unknown>
): { ok: true; paidFallbackEnabled: boolean; paidFallbackLimitMicrocredits: number } | { ok: false; response: Response } => {
  if (Object.prototype.hasOwnProperty.call(raw, "paid_fallback_enabled") && typeof raw.paid_fallback_enabled !== "boolean") {
    return { ok: false, response: paidFallbackInputError("paid_fallback_enabled must be a boolean") };
  }
  const paidFallbackEnabled = raw.paid_fallback_enabled === true;
  const paidFallbackLimitMicrocredits = Object.prototype.hasOwnProperty.call(raw, "paid_fallback_limit_credits")
    ? paidFallbackCreditsToMicrocredits(raw.paid_fallback_limit_credits)
    : 0;
  if (paidFallbackLimitMicrocredits === null) {
    return { ok: false, response: paidFallbackInputError("paid_fallback_limit_credits must be a non-negative number or -1") };
  }
  if (paidFallbackEnabled && paidFallbackLimitMicrocredits === 0) {
    return { ok: false, response: paidFallbackInputError("paid_fallback_limit_credits must be positive or -1 when paid fallback is enabled") };
  }
  return { ok: true, paidFallbackEnabled, paidFallbackLimitMicrocredits };
};

/** Every create-time field except `name` and `token`, validated in the original order. */
const resolveApiKeyCreateFields = (
  raw: Record<string, unknown>,
  nowMs: number
): { ok: true; fields: ApiKeyCreateFields } | { ok: false; response: Response } => {
  const expiresAtMs = normalizeApiKeyExpiresAtMs(raw.expires_at_ms, nowMs);
  if (expiresAtMs === null) {
    return { ok: false, response: openaiError(400, "expires_at_ms must be a Unix epoch ms timestamp in the future, or -1", "invalid_request_error") };
  }

  const usageLimitRequests = normalizeApiKeyUsageLimit(raw.usage_limit_requests);
  if (usageLimitRequests === null) {
    return { ok: false, response: openaiError(400, "usage_limit_requests must be a positive number or -1 for unlimited", "invalid_request_error") };
  }

  const windowMs = normalizeApiKeyWindowMsInput(raw.window_ms);
  if (raw.window_ms !== undefined && windowMs === null) {
    return { ok: false, response: openaiError(400, "window_ms must be a positive number", "invalid_request_error") };
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

/**
 * Starts from the strict default policy. An enabled key additionally inherits
 * the Metered-owned pricing fields, and an initialization failure is reported
 * before anything is written.
 */
const resolveApiKeyCreatePolicy = async (
  signal: AbortSignal,
  fields: ApiKeyCreateFields
): Promise<{ ok: true; policy: ReturnType<typeof defaultPaidFallbackPolicy> } | { ok: false; response: Response }> => {
  const paidFallbackPolicy = defaultPaidFallbackPolicy();
  if (!fields.paidFallbackEnabled) {
    return { ok: true, policy: { ...paidFallbackPolicy, paid_fallback_limit_microcredits: fields.paidFallbackLimitMicrocredits } };
  }
  try {
    return {
      ok: true,
      policy: {
        ...paidFallbackPolicy,
        ...(await initializePaidFallbackPolicy(signal)),
        paid_fallback_enabled: true,
        paid_fallback_limit_microcredits: fields.paidFallbackLimitMicrocredits,
      },
    };
  } catch (error) {
    return { ok: false, response: paidFallbackInitializationError(error) };
  }
};

export const handleAdminApiKeysCreate = async (req: Request, context?: ApiKeyAuditContext): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot manage API keys", "server_error");
  }

  const raw = await readJsonBody(req);
  if (!raw || !isRecord(raw)) return openaiError(400, "Invalid JSON body", "invalid_request_error");
  const retiredResetSettingError = rejectRetiredApiKeyResetSetting(raw);
  if (retiredResetSettingError) return retiredResetSettingError;

  const name = normalizeApiKeyName(raw.name);
  if (!name) return openaiError(400, "name must be a non-empty string (<=80 chars)", "invalid_request_error");

  const tokenResult = resolveApiKeyCreateToken(raw);
  if (!tokenResult.ok) return tokenResult.response;
  const { token } = tokenResult;

  const now = Date.now();
  const createFields = resolveApiKeyCreateFields(raw, now);
  if (!createFields.ok) return createFields.response;
  const { expiresAtMs, usageLimitRequests, windowMs } = createFields.fields;

  const hash = await sha256Base64Url(token);
  const hashKey = apiKeyHashKey(hash);
  const hashEntry = await kv.get<ApiKeyHashRecord>(hashKey);
  if (hashEntry.value) {
    return openaiError(409, "API key already exists", "invalid_request_error");
  }

  const policy = await resolveApiKeyCreatePolicy(req.signal, createFields.fields);
  if (!policy.ok) return policy.response;

  const id = crypto.randomUUID();
  const usageResetAtMs = calculateNextResetMs(now, windowMs);
  const record: ApiKeyRecord = {
    id,
    name,
    prefix: token.slice(0, 12),
    hash,
    created_at_ms: now,
    expires_at_ms: expiresAtMs,
    revoked_at_ms: null,
    usage_limit_requests: usageLimitRequests,
    usage_requests: 0,
    usage_reset_at_ms: usageResetAtMs,
    window_ms: windowMs,
    usage_quota_version: 3,
    ...policy.policy,
  };
  const hashRecord: ApiKeyHashRecord = {
    id,
    expires_at_ms: expiresAtMs,
    revoked_at_ms: null,
    usage_limit_requests: usageLimitRequests,
    usage_requests: 0,
    usage_reset_at_ms: usageResetAtMs,
    window_ms: windowMs,
    usage_quota_version: 3,
    ...paidFallbackHashFields(record),
  };
  const quotaPolicy = apiKeyPolicyFromHashRecord(hash, hashRecord, now);
  if (!quotaPolicy) {
    return openaiError(500, "Failed to build API key quota policy", "server_error");
  }
  const quotaWindow = makeApiKeyUsageWindowV3(quotaPolicy, now);

  const commit = await appendApiKeyChangeEvent(
    kv
      .atomic()
      .check(hashEntry)
      .set(apiKeyIdKey(id), record)
      .set(hashKey, hashRecord)
      .set(apiKeyUsageV3WindowKey(quotaPolicy), quotaWindow, {
        expireIn: apiKeyUsageV3RetentionMs(quotaWindow.window_reset_at_ms, now),
      }),
    buildApiKeyChangeEvent({
      action: "create",
      targetKeyId: id,
      targetKeyName: name,
      changed: {
        name,
        expires_at_ms: expiresAtMs,
        usage_limit_requests: usageLimitRequests,
        window_ms: windowMs,
        paid_fallback_enabled: record.paid_fallback_enabled,
        paid_fallback_limit_credits: paidFallbackMicrocreditsToCredits(record.paid_fallback_limit_microcredits),
      },
      context,
      nowMs: now,
    })
  ).commit();
  if (!commit.ok) {
    return openaiError(500, "Failed to persist API key", "server_error");
  }

  return json(
    200,
    {
      id,
      name,
      token,
      prefix: record.prefix,
      created_at_ms: record.created_at_ms,
      expires_at_ms: record.expires_at_ms,
      usage_limit_requests: record.usage_limit_requests,
      usage_requests: record.usage_requests,
      usage_reset_at_ms: record.usage_reset_at_ms,
      window_ms: record.window_ms,
      ...(await paidFallbackPublicFields(record, kv)),
    },
    { "x-uos-upstream": "chatgpt_codex" }
  );
};

export const handleAdminApiKeysList = async (req: Request): Promise<Response> => {
  const kv = await getKv();
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot manage API keys", "server_error");
  }

  const records: ApiKeyRecord[] = [];
  // A listed record may be missing its value; only well-formed records are listed.
  for await (const entry of kv.list<ApiKeyRecord | null>({ prefix: API_KEY_ID_PREFIX })) {
    const record = entry.value;
    if (record) records.push(record);
  }
  records.sort((a, b) => b.created_at_ms - a.created_at_ms);

  const includeUsage = shouldIncludeUsage(new URL(req.url).searchParams.get("include_usage"));
  const usageById = new Map<string, Record<string, number>>();
  const paidFallbackResetById = new Map<string, number>();
  for (const record of records) {
    const hashRecord: ApiKeyHashRecord = {
      id: record.id,
      expires_at_ms: record.expires_at_ms,
      revoked_at_ms: record.revoked_at_ms,
      usage_limit_requests: record.usage_limit_requests,
      usage_requests: record.usage_requests,
      usage_reset_at_ms: record.usage_reset_at_ms,
      window_ms: record.window_ms,
      usage_quota_version: record.usage_quota_version,
      ...paidFallbackHashFields(record),
    };
    const policy = apiKeyPolicyFromHashRecord(record.hash, hashRecord, Date.now());
    if (policy) {
      paidFallbackResetById.set(record.id, record.revoked_at_ms === null ? policy.usage_reset_at_ms : record.usage_reset_at_ms);
      if (includeUsage) {
        usageById.set(record.id, {
          request_count: await getApiKeyUsageV3(policy, kv),
          limit: policy.usage_limit_requests,
          reset_at_ms: policy.usage_reset_at_ms,
        });
      }
    }
  }
  const paidFallbackById = new Map(
    await Promise.all(
      records.map(
        async (record) => [record.id, await paidFallbackPublicFields(record, kv, paidFallbackResetById.get(record.id) ?? record.usage_reset_at_ms)] as const
      )
    )
  );

  return json(
    200,
    {
      object: "list",
      data: records.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        created_at_ms: r.created_at_ms,
        expires_at_ms: coerceApiKeyExpiresAtMs(r),
        revoked_at_ms: r.revoked_at_ms,
        usage_limit_requests: r.usage_limit_requests,
        usage_reset_at_ms: includeUsage ? (usageById.get(r.id)?.reset_at_ms ?? r.usage_reset_at_ms) : r.usage_reset_at_ms,
        window_ms: coerceApiKeyWindowMs(r),
        ...paidFallbackById.get(r.id),
        ...(includeUsage
          ? {
              usage_requests: usageById.get(r.id)?.request_count ?? 0,
              usage: usageById.get(r.id) ?? null,
            }
          : {}),
      })),
    },
    { "x-uos-upstream": "chatgpt_codex" }
  );
};

export const handleAdminApiKeysPaidFallbacks = async (req: Request, keyId: string, kvOverride?: Kv | null): Promise<Response> => {
  const kv = kvOverride === undefined ? await getKv() : kvOverride;
  if (!kv) {
    return openaiError(500, "Deno KV is not available; cannot load paid fallbacks", "server_error");
  }

  const normalizedKeyId = keyId.trim();
  if (!normalizedKeyId || normalizedKeyId.length > 200) {
    return openaiError(400, "Invalid API key id", "invalid_request_error");
  }

  const keyEntry = await kv.get<ApiKeyRecord>(apiKeyIdKey(normalizedKeyId));
  if (!keyEntry.value) return openaiError(404, "Not found", "not_found");

  const rawLimit = new URL(req.url).searchParams.get("limit");
  if (rawLimit !== null && !/^\d+$/.test(rawLimit.trim())) {
    return openaiError(400, "limit must be a positive integer", "invalid_request_error");
  }
  const requestedLimit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    return openaiError(400, "limit must be a positive integer", "invalid_request_error");
  }
  const limit = Math.min(requestedLimit, 100);

  try {
    // An operator reading the ledger settles whatever its terminal events made
    // due, so the view cannot sit on unreconciled rows with no traffic arriving.
    void reconcileDuePaidFallbacksV3(Date.now(), kv).catch(() => {});
    const records = (await listPaidFallbackRequestsV3(normalizedKeyId, limit, kv)).map(paidFallbackHistoryRecord);
    return json(200, { object: "list", data: records }, { "Cache-Control": "no-store" });
  } catch (error) {
    console.error("[ai.ubq.fi] Failed to load paid fallback ledger:", error);
    return openaiError(500, "Failed to load paid fallbacks", "server_error");
  }
};

export {
  MAX_KV_BYTES,
  SAFE_KV_BYTES,
  estimateJsonSize,
  extractModelReasoningLevels,
  normalizeApiKeyExpiresAtMs,
  normalizeApiKeyName,
  normalizeApiKeyUsageLimit,
  normalizeApiKeyWindowMsInput,
  normalizeDefaultModel,
  normalizeKernelExpiresAtMsInput,
  normalizeKernelRepoPart,
  normalizeKernelScope,
  normalizeKernelUsageLimitInput,
  normalizeKernelWindowMsInput,
  normalizeOptionalBoolean,
  paidFallbackInitializationError,
  paidFallbackInputError,
  paidFallbackPublicFields,
  rejectRetiredApiKeyResetSetting,
  shouldIncludeUsage,
};
