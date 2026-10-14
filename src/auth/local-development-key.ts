import type { Kv, KvKey } from "#kv";
import {
  API_KEY_NO_EXPIRATION_MS,
  API_KEY_NO_USAGE_LIMIT,
  PAID_FALLBACK_NO_LIMIT,
  USAGE_RESET_PERIOD_MS,
  apiKeyHashKey,
  apiKeyIdKey,
  calculateNextResetMs,
  generateApiKeyToken,
} from "../api-keys.ts";
import {
  API_KEY_USAGE_V2_PREFIX,
  API_KEY_USAGE_V3_REQUEST_PREFIX,
  API_KEY_USAGE_V3_WINDOW_PREFIX,
  type ApiKeyPolicy,
  apiKeyPolicyFromHashRecord,
  apiKeyUsageV3RetentionMs,
  apiKeyUsageV3WindowKey,
  makeApiKeyUsageWindowV3,
} from "../api-key-policy.ts";
import { apiKeyRequestLogPrefix, legacyApiKeyRequestLogPrefix } from "../analytics.ts";
import { defaultPaidFallbackPolicy, initializePaidFallbackPolicy, paidFallbackHashFields } from "../paid-fallback/index.ts";
import {
  getPaidFallbackOutstandingV3,
  paidFallbackDeletionGuardV3Key,
  paidFallbackReconciliationLeaseV3Key,
  paidFallbackRequestV3Prefix,
  paidFallbackWindowV3Prefix,
} from "../paid-fallback/ledger-state.ts";
import { readMeteredApiKey } from "../provider/metered.ts";
import { readSurplusApiKey } from "../provider/surplus.ts";
import type { ApiKeyHashRecord, ApiKeyRecord } from "../types.ts";
import { isRecord, sha256Base64Url } from "../utils.ts";

/**
 * The loopback development principal (`--disable-admin-auth` / the Mac service)
 * authenticates every local request as this one API key. It exists so a local
 * request is a *super-admin* principal with no limits rather than a
 * policy-free one: without a key record the paid-provider admission path has no
 * policy to read, so every model that routes directly to a paid provider is
 * refused with `paid_fallback_disabled`.
 *
 * The record is created only by a local loopback server at boot. Its token is
 * minted, stored, and never printed: nothing authenticates with it as a bearer
 * credential, and the bypass never reads it back.
 */
export const LOCAL_DEVELOPMENT_KEY_ID = "local-development";

/** The single account the loopback development server provisions for itself. */
export const LOCAL_DEVELOPMENT_KEY_NAME = "Local development (loopback)";

/** Extends the retained guard without changing any other guard reader. */
export type LocalDevelopmentDeletionGuard = Readonly<{
  created_at_ms: number;
  local_deletion: Readonly<{ owner: string | null; completed_at_ms: number | null }>;
}>;

const isCompletedLocalDevelopmentDeletion = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    typeof value.created_at_ms !== "number" ||
    !Number.isSafeInteger(value.created_at_ms) ||
    value.created_at_ms <= 0 ||
    !isRecord(value.local_deletion)
  )
    return false;
  const { owner, completed_at_ms: completedAtMs } = value.local_deletion;
  return typeof owner === "string" && owner.length > 0 && typeof completedAtMs === "number" && Number.isSafeInteger(completedAtMs) && completedAtMs > 0;
};

/**
 * Fixed internal deadline for the local paid-pricing snapshot.
 *
 * Listener startup awaits local provisioning, so a pricing source that stalls
 * (or that ignores the abort signal it is handed) must not hold the listener
 * open. The deadline is deliberately internal - no environment variable, CLI
 * flag, or caller option - and it leaves generous room next to the 10s fetch
 * budget each upstream metadata call already carries, so a healthy
 * initialization is never cut short.
 */
export const LOCAL_DEVELOPMENT_PRICING_DEADLINE_MS = 30_000;

let localDevelopmentPricingDeadlineMs = LOCAL_DEVELOPMENT_PRICING_DEADLINE_MS;

/** Test-only override; `null` restores the fixed production deadline. */
export const setLocalDevelopmentPricingDeadlineMsForTest = (deadlineMs: number | null): void => {
  localDevelopmentPricingDeadlineMs = deadlineMs ?? LOCAL_DEVELOPMENT_PRICING_DEADLINE_MS;
};

export type LocalDevelopmentKeyStatus = "created" | "present" | "revoked" | "unconfigured" | "unavailable" | "conflict";

type LocalDevelopmentKeyMaterial = Readonly<{
  record: ApiKeyRecord;
  hashKey: KvKey;
  hashRecord: ApiKeyHashRecord;
  policy: ApiKeyPolicy;
}>;

/** The pricing fields an unlimited local key inherits; injectable for tests. */
export type LocalDevelopmentPricingInitializer = (
  signal?: AbortSignal
) => Promise<
  Pick<
    ReturnType<typeof defaultPaidFallbackPolicy>,
    "paid_fallback_model_ids" | "paid_fallback_quota_per_credit" | "paid_fallback_pricing_checked_at_ms" | "paid_fallback_max_exposure_microcredits"
  >
>;

/** The reason carried by a cancelled or expired signal, or a generic AbortError. */
const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted.", "AbortError");

/**
 * Settles as soon as `operation` does or `signal` aborts, whichever happens
 * first. The operation always stays observed by the race, so a late rejection
 * cannot surface as an unhandled rejection and a late result can never be
 * published by a caller that already moved on.
 */
const awaitWithAbort = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    if (signal.aborted) onAbort();
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const buildLocalDevelopmentKey = async (
  nowMs: number,
  initializePolicy: LocalDevelopmentPricingInitializer,
  signal?: AbortSignal
): Promise<LocalDevelopmentKeyMaterial> => {
  // Reuse the operator-facing pricing initializer so the local key's paid
  // policy is byte-for-byte the policy an unlimited admin key would receive.
  const policyFields = {
    ...defaultPaidFallbackPolicy(),
    ...(await initializePolicy(signal)),
    paid_fallback_enabled: true,
    paid_fallback_limit_microcredits: PAID_FALLBACK_NO_LIMIT,
  };
  // Minted per provisioning and never exposed: the record's only purpose is to
  // be the principal local requests are admitted as.
  const token = generateApiKeyToken();
  const hash = await sha256Base64Url(token);
  const usageResetAtMs = calculateNextResetMs(nowMs, USAGE_RESET_PERIOD_MS);
  const record: ApiKeyRecord = {
    id: LOCAL_DEVELOPMENT_KEY_ID,
    name: LOCAL_DEVELOPMENT_KEY_NAME,
    prefix: token.slice(0, 12),
    hash,
    created_at_ms: nowMs,
    expires_at_ms: API_KEY_NO_EXPIRATION_MS,
    revoked_at_ms: null,
    usage_limit_requests: API_KEY_NO_USAGE_LIMIT,
    usage_requests: 0,
    usage_reset_at_ms: usageResetAtMs,
    window_ms: USAGE_RESET_PERIOD_MS,
    usage_quota_version: 3,
    ...policyFields,
  };
  const hashRecord: ApiKeyHashRecord = {
    id: LOCAL_DEVELOPMENT_KEY_ID,
    expires_at_ms: API_KEY_NO_EXPIRATION_MS,
    revoked_at_ms: null,
    usage_limit_requests: API_KEY_NO_USAGE_LIMIT,
    usage_requests: 0,
    usage_reset_at_ms: usageResetAtMs,
    window_ms: USAGE_RESET_PERIOD_MS,
    usage_quota_version: 3,
    ...paidFallbackHashFields(record),
  };
  const policy = apiKeyPolicyFromHashRecord(hash, hashRecord, nowMs);
  if (!policy) throw new Error("[ai.ubq.fi] Local development key policy is not strict");
  return { record, hashKey: apiKeyHashKey(hash), hashRecord, policy };
};

/** Completion is owner-published only after every old cleanup iterator settles. */
const localDevelopmentDeletionStateEmpty = async (kv: Kv): Promise<boolean> => {
  const outstanding = await getPaidFallbackOutstandingV3(LOCAL_DEVELOPMENT_KEY_ID, kv);
  if (!outstanding || outstanding.has_outstanding) return false;
  const lease = await kv.get(paidFallbackReconciliationLeaseV3Key(LOCAL_DEVELOPMENT_KEY_ID), { consistency: "strong" });
  if (lease.value) return false;
  const prefixes = [
    paidFallbackRequestV3Prefix(LOCAL_DEVELOPMENT_KEY_ID),
    paidFallbackWindowV3Prefix(LOCAL_DEVELOPMENT_KEY_ID),
    apiKeyRequestLogPrefix(LOCAL_DEVELOPMENT_KEY_ID),
    legacyApiKeyRequestLogPrefix(LOCAL_DEVELOPMENT_KEY_ID),
    [...API_KEY_USAGE_V2_PREFIX, LOCAL_DEVELOPMENT_KEY_ID],
    [...API_KEY_USAGE_V3_WINDOW_PREFIX, LOCAL_DEVELOPMENT_KEY_ID],
    [...API_KEY_USAGE_V3_REQUEST_PREFIX, LOCAL_DEVELOPMENT_KEY_ID],
  ];
  for (const prefix of prefixes) {
    if (!(await kv.list({ prefix }, { consistency: "strong", limit: 1 }).next()).done) return false;
  }
  return true;
};

/**
 * Creates the loopback development key when it is absent. Idempotent and
 * best-effort: an existing record is never rewritten, so an operator can revoke
 * it to switch local paid routing off, or adjust it in the console. Deleting it
 * re-provisions a fresh unlimited key (with current pricing) at the next local
 * start. Pricing initialization is bounded by
 * {@link LOCAL_DEVELOPMENT_PRICING_DEADLINE_MS}, so listener startup resumes
 * even when the initializer never settles.
 */
export const ensureLocalDevelopmentApiKey = async (
  kv: Kv,
  options: Readonly<{ signal?: AbortSignal; initializePolicy?: LocalDevelopmentPricingInitializer }> = {}
): Promise<LocalDevelopmentKeyStatus> => {
  const idKey = apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID);
  const existing = await kv.get<ApiKeyRecord>(idKey, { consistency: "strong" });
  if (existing.value) return existing.value.revoked_at_ms === null ? "present" : "revoked";
  const deletionGuard = await kv.get(paidFallbackDeletionGuardV3Key(LOCAL_DEVELOPMENT_KEY_ID), { consistency: "strong" });
  if (deletionGuard.value && (!isCompletedLocalDevelopmentDeletion(deletionGuard.value) || !(await localDevelopmentDeletionStateEmpty(kv)))) return "conflict";
  if (!readMeteredApiKey() && !readSurplusApiKey()) {
    console.warn("[ai.ubq.fi] Local development key was not provisioned: no paid provider API key is configured.");
    return "unconfigured";
  }

  const nowMs = Date.now();
  let material: LocalDevelopmentKeyMaterial;
  // The initializer receives a cooperative abort at the deadline, while the
  // race bounds an initializer that never observes it. Both paths end the same
  // way: startup resumes and nothing is published from the aborted attempt.
  const pricingDeadline = new AbortController();
  const deadlineTimer = setTimeout(() => {
    pricingDeadline.abort(new DOMException("Local development pricing initialization exceeded its internal deadline.", "TimeoutError"));
  }, localDevelopmentPricingDeadlineMs);
  const pricingSignal = options.signal ? AbortSignal.any([options.signal, pricingDeadline.signal]) : pricingDeadline.signal;
  try {
    material = await awaitWithAbort(buildLocalDevelopmentKey(nowMs, options.initializePolicy ?? initializePaidFallbackPolicy, pricingSignal), pricingSignal);
  } catch (error) {
    console.warn(
      "[ai.ubq.fi] Local development key was not provisioned; paid providers stay unavailable locally:",
      error instanceof Error ? error.message : String(error)
    );
    return "unavailable";
  } finally {
    clearTimeout(deadlineTimer);
  }
  // A deadline or caller cancellation that landed during the attempt must never
  // publish, even when the initializer resolved before it was observed.
  if (pricingSignal.aborted) return "unavailable";

  const hashEntry = await kv.get<ApiKeyHashRecord>(material.hashKey);
  const window = makeApiKeyUsageWindowV3(material.policy, nowMs);
  const atomic = kv
    .atomic()
    .check(existing)
    .check(hashEntry)
    .check(deletionGuard)
    .set(idKey, material.record)
    .set(material.hashKey, material.hashRecord)
    .set(apiKeyUsageV3WindowKey(material.policy), window, {
      expireIn: apiKeyUsageV3RetentionMs(window.window_reset_at_ms, nowMs),
    });
  if (deletionGuard.value) atomic.delete(deletionGuard.key);
  const committed = await atomic.commit();
  if (!committed.ok) return "conflict";
  return "created";
};

/**
 * The policy every loopback development request is authenticated as, or null
 * when the local development key is absent, revoked, malformed, or expired.
 * A null result degrades the local principal to the policy-free `disabled`
 * method, which is the pre-existing behavior.
 */
export const resolveLocalDevelopmentApiKeyPolicy = async (kv: Kv | null, nowMs = Date.now()): Promise<ApiKeyPolicy | null> => {
  if (!kv) return null;
  const record = (await kv.get<ApiKeyRecord>(apiKeyIdKey(LOCAL_DEVELOPMENT_KEY_ID), { consistency: "strong" })).value;
  if (record?.revoked_at_ms !== null) return null;
  if (typeof record.hash !== "string" || !record.hash) return null;
  const hashRecord = (await kv.get<ApiKeyHashRecord>(apiKeyHashKey(record.hash), { consistency: "strong" })).value;
  if (hashRecord?.revoked_at_ms !== null) return null;
  const policy = apiKeyPolicyFromHashRecord(record.hash, hashRecord, nowMs);
  if (!policy) return null;
  if (policy.expires_at_ms !== API_KEY_NO_EXPIRATION_MS && policy.expires_at_ms <= nowMs) return null;
  return policy;
};
