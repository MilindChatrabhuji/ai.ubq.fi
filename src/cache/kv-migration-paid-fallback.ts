import type { Kv, KvEntry, KvKey } from "#kv";
// Paid fallback v3 inspection, split out of src/kv_migration.ts.

import type { ApiKeyHashRecord, ApiKeyRecord, ApiKeyRequestLogRecord, PaidFallbackRequestV3, PaidFallbackWindowV3 } from "../types.ts";
import { hasStrictPaidFallbackKeyPolicy, hasStrictPaidFallbackPolicy } from "../paid-fallback/index.ts";
import { isPaidFallbackWindowV3, PAID_FALLBACK_REQUEST_LOG_RETENTION_MS } from "../paid-fallback/ledger-state.ts";
import { isRecord } from "../utils.ts";

export const KV_READ_INCIDENT_V2_MIGRATION_KEY = ["uos_ai", "migrations", "kv_read_incident_v2"] as const;
const API_KEY_USAGE_V2_MIGRATION_BASELINE_PREFIX = [...KV_READ_INCIDENT_V2_MIGRATION_KEY, "api_key_usage_baseline"] as const;
const LEGACY_REQUEST_LOG_PREFIX = ["ubq_ai", "api_keys", "request_log"] as const;
const PAID_FALLBACK_LEDGER_PREFIX = ["uos_ai", "paid_fallback", "ledger"] as const;
const PAID_FALLBACK_V3_PREFIX = ["uos_ai", "paid_fallback", "v3"] as const;
const PAID_FALLBACK_WINDOW_V3_PREFIX = [...PAID_FALLBACK_V3_PREFIX, "window"] as const;
const PAID_FALLBACK_REQUEST_V3_PREFIX = [...PAID_FALLBACK_V3_PREFIX, "request"] as const;
const PAID_FALLBACK_PENDING_V3_PREFIX = [...PAID_FALLBACK_V3_PREFIX, "pending"] as const;
const PAID_FALLBACK_RECONCILIATION_LEASE_V3_PREFIX = [...PAID_FALLBACK_V3_PREFIX, "reconciliation_lease"] as const;
const PAID_FALLBACK_DELETION_GUARD_V3_PREFIX = [...PAID_FALLBACK_V3_PREFIX, "deletion_guard"] as const;
const isRoutableApiKeyPrefix = (value: unknown): boolean => typeof value === "string" && /^u_[0-9a-f]{10}$/.test(value);
const isSafeUsageCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Larger than any supported API-key window preset (1m/1h/1d/1w), so exact
// window reconstruction stops before its earliest rows can age out.
const PAID_FALLBACK_VALIDATION_SLACK_MS = 32 * 24 * 60 * 60 * 1_000;
const isApiKeyId = (value: unknown): value is string => typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 200;
const isApiKeyHash = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const isExpirationTimestamp = (value: unknown): value is number => value === -1 || isSafeUsageCount(value);
const isRevocationTimestamp = (value: unknown): value is number | null => value === null || isSafeUsageCount(value);
const isUsageLimit = (value: unknown): value is number => value === -1 || isSafeUsageCount(value);
const isPositiveSafeInteger = (value: unknown): value is number => isSafeUsageCount(value) && value > 0;
const isFiniteNonNegativeNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isNullablePositiveSafeInteger = (value: unknown): value is number | null => value === null || isPositiveSafeInteger(value);
const isNullableNonEmptyString = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length > 0);

const hasPaidFallbackLedgerIdentity = (value: unknown): value is ApiKeyRequestLogRecord =>
  isRecord(value) && isApiKeyId(value.key_id) && isApiKeyId(value.id) && isPositiveSafeInteger(value.created_at_ms) && value.provider === "metered";

const isPendingPaidFallbackLedgerRecord = (value: unknown): value is ApiKeyRequestLogRecord =>
  hasPaidFallbackLedgerIdentity(value) && (value.billing_status === "pending" || value.billing_status === "unresolved");

const paidFallbackLedgerReference = (keyId: string, requestId: string): string => JSON.stringify([keyId, requestId]);

const pendingPaidFallbackLedgerReferenceFromEntry = (entry: Pick<KvEntry<unknown>, "key" | "value">, prefix: KvKey): string | null => {
  if (entry.key.length !== prefix.length + 3 || !isPendingPaidFallbackLedgerRecord(entry.value)) return null;
  const [keyId, createdAtMs, requestId] = entry.key.slice(prefix.length);
  if (keyId !== entry.value.key_id || createdAtMs !== entry.value.created_at_ms || requestId !== entry.value.id) return null;
  return paidFallbackLedgerReference(entry.value.key_id, entry.value.id);
};

const paidFallbackLedgerEntryMatchesIdentity = (
  entry: Pick<KvEntry<unknown>, "key" | "value">,
  expected: Pick<ApiKeyRequestLogRecord, "key_id" | "id" | "created_at_ms">
): boolean => {
  if (entry.key.length !== PAID_FALLBACK_LEDGER_PREFIX.length + 3 || !hasPaidFallbackLedgerIdentity(entry.value)) return false;
  const [keyId, createdAtMs, requestId] = entry.key.slice(PAID_FALLBACK_LEDGER_PREFIX.length);
  return (
    keyId === expected.key_id &&
    createdAtMs === expected.created_at_ms &&
    requestId === expected.id &&
    entry.value.key_id === expected.key_id &&
    entry.value.created_at_ms === expected.created_at_ms &&
    entry.value.id === expected.id
  );
};

const hasStrictApiKeyHashCorePolicy = (value: unknown): value is ApiKeyHashRecord => {
  if (!hasStrictPaidFallbackPolicy(value)) return false;
  const record = value as ApiKeyHashRecord;
  return (
    isApiKeyId(record.id) &&
    isExpirationTimestamp(record.expires_at_ms) &&
    isRevocationTimestamp(record.revoked_at_ms) &&
    isUsageLimit(record.usage_limit_requests) &&
    isSafeUsageCount(record.usage_requests) &&
    isPositiveSafeInteger(record.usage_reset_at_ms) &&
    isPositiveSafeInteger(record.window_ms)
  );
};

const hasStrictApiKeyCorePolicy = (value: unknown): value is ApiKeyRecord => {
  if (!hasStrictPaidFallbackKeyPolicy(value)) return false;
  const record = value as ApiKeyRecord;
  return (
    isApiKeyId(record.id) &&
    isApiKeyHash(record.hash) &&
    isRoutableApiKeyPrefix(record.prefix) &&
    isExpirationTimestamp(record.expires_at_ms) &&
    isRevocationTimestamp(record.revoked_at_ms) &&
    isUsageLimit(record.usage_limit_requests) &&
    isSafeUsageCount(record.usage_requests) &&
    isPositiveSafeInteger(record.usage_reset_at_ms) &&
    isPositiveSafeInteger(record.window_ms)
  );
};

const apiKeyHashPolicyMatches = (record: ApiKeyRecord, hashRecord: ApiKeyHashRecord): boolean =>
  record.id === hashRecord.id &&
  record.expires_at_ms === hashRecord.expires_at_ms &&
  record.revoked_at_ms === hashRecord.revoked_at_ms &&
  record.usage_limit_requests === hashRecord.usage_limit_requests &&
  record.usage_requests === hashRecord.usage_requests &&
  record.usage_reset_at_ms === hashRecord.usage_reset_at_ms &&
  record.window_ms === hashRecord.window_ms &&
  record.usage_quota_version === hashRecord.usage_quota_version &&
  record.paid_fallback_enabled === hashRecord.paid_fallback_enabled &&
  record.paid_fallback_limit_microcredits === hashRecord.paid_fallback_limit_microcredits &&
  record.paid_fallback_spent_microcredits === hashRecord.paid_fallback_spent_microcredits &&
  record.paid_fallback_reserved_microcredits === hashRecord.paid_fallback_reserved_microcredits &&
  record.paid_fallback_reservation_request_id === hashRecord.paid_fallback_reservation_request_id;

const isPaidFallbackRequestV3 = (value: unknown): value is PaidFallbackRequestV3 => {
  if (!isRecord(value)) return false;
  return (
    value.v === 3 &&
    isApiKeyId(value.key_id) &&
    isApiKeyId(value.request_id) &&
    typeof value.policy_version === "string" &&
    value.policy_version.length > 0 &&
    typeof value.route === "string" &&
    value.route.length > 0 &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    typeof value.stream === "boolean" &&
    isNullableNonEmptyString(value.reasoning) &&
    isPositiveSafeInteger(value.window_reset_at_ms) &&
    isSafeUsageCount(value.reserved_microcredits) &&
    isPositiveSafeInteger(value.quota_per_credit) &&
    (value.provider === undefined || value.provider === "metered" || value.provider === "surplus") &&
    isNullableNonEmptyString(value.provider_request_id) &&
    (value.provider_quota === null || isFiniteNonNegativeNumber(value.provider_quota)) &&
    (value.input_tokens === null || isSafeUsageCount(value.input_tokens)) &&
    (value.output_tokens === null || isSafeUsageCount(value.output_tokens)) &&
    ["reserved", "dispatched", "not_dispatched"].includes(String(value.dispatch_state)) &&
    ["pending", "completed", "failed", "incomplete", "cancelled", "ambiguous"].includes(String(value.terminal_state)) &&
    (value.spend_microcredits === null || isSafeUsageCount(value.spend_microcredits)) &&
    ["pending", "settled", "not_billed", "unresolved"].includes(String(value.billing_state)) &&
    isSafeUsageCount(value.reconciliation_attempts) &&
    isNullablePositiveSafeInteger(value.last_reconciliation_at_ms) &&
    isNullablePositiveSafeInteger(value.dispatched_at_ms) &&
    isNullablePositiveSafeInteger(value.terminal_at_ms) &&
    isNullablePositiveSafeInteger(value.settled_at_ms) &&
    isPositiveSafeInteger(value.created_at_ms) &&
    isPositiveSafeInteger(value.updated_at_ms)
  );
};

type PaidFallbackV3Inventory = Readonly<{
  windows: number;
  requests: number;
  pending: number;
  reconciliationLeases: number;
  deletionGuards: number;
  errors: string[];
}>;

const paidFallbackV3Reference = (keyId: string, requestId: string): string => JSON.stringify([keyId, requestId]);
const paidFallbackV3WindowReference = (keyId: string, windowResetAtMs: number): string => JSON.stringify([keyId, windowResetAtMs]);

type PaidFallbackWindowMap = Map<string, PaidFallbackWindowV3>;
type PaidFallbackRequestMap = Map<string, PaidFallbackRequestV3>;

/** Validates every V3 window row and indexes it by its key reference. */
const collectPaidFallbackWindows = async (
  kv: Kv,
  knownKeyIds: ReadonlySet<string>,
  errors: string[]
): Promise<Readonly<{ count: number; windows: PaidFallbackWindowMap }>> => {
  const windows: PaidFallbackWindowMap = new Map();
  let count = 0;
  for await (const entry of kv.list({ prefix: PAID_FALLBACK_WINDOW_V3_PREFIX })) {
    count += 1;
    const [keyId, windowResetAtMs] = entry.key.slice(PAID_FALLBACK_WINDOW_V3_PREFIX.length);
    if (
      entry.key.length !== PAID_FALLBACK_WINDOW_V3_PREFIX.length + 2 ||
      !isApiKeyId(keyId) ||
      !isPositiveSafeInteger(windowResetAtMs) ||
      !isPaidFallbackWindowV3(entry.value) ||
      entry.value.key_id !== keyId ||
      entry.value.window_reset_at_ms !== windowResetAtMs
    ) {
      errors.push(`paid fallback V3 window is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (!knownKeyIds.has(keyId)) errors.push(`paid fallback V3 window is orphaned: ${keyId}`);
    windows.set(paidFallbackV3WindowReference(keyId, windowResetAtMs), entry.value);
  }
  return { count, windows };
};

/** Validates every V3 request row and indexes it by its key reference. */
const collectPaidFallbackRequests = async (
  kv: Kv,
  knownKeyIds: ReadonlySet<string>,
  errors: string[]
): Promise<Readonly<{ count: number; requests: PaidFallbackRequestMap }>> => {
  const requests: PaidFallbackRequestMap = new Map();
  let count = 0;
  for await (const entry of kv.list({ prefix: PAID_FALLBACK_REQUEST_V3_PREFIX })) {
    count += 1;
    const [keyId, requestId] = entry.key.slice(PAID_FALLBACK_REQUEST_V3_PREFIX.length);
    if (
      entry.key.length !== PAID_FALLBACK_REQUEST_V3_PREFIX.length + 2 ||
      !isApiKeyId(keyId) ||
      !isApiKeyId(requestId) ||
      !isPaidFallbackRequestV3(entry.value) ||
      entry.value.key_id !== keyId ||
      entry.value.request_id !== requestId
    ) {
      errors.push(`paid fallback V3 request is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (!knownKeyIds.has(keyId)) errors.push(`paid fallback V3 request is orphaned: ${keyId}/${requestId}`);
    requests.set(paidFallbackV3Reference(keyId, requestId), entry.value);
  }
  return { count, requests };
};

/** Validates every outstanding-pending marker row. */
const collectPaidFallbackPending = async (kv: Kv, errors: string[]): Promise<Readonly<{ count: number; pending: Set<string> }>> => {
  const pending = new Set<string>();
  let count = 0;
  for await (const entry of kv.list({ prefix: PAID_FALLBACK_PENDING_V3_PREFIX })) {
    count += 1;
    const [keyId, requestId] = entry.key.slice(PAID_FALLBACK_PENDING_V3_PREFIX.length);
    if (
      entry.key.length !== PAID_FALLBACK_PENDING_V3_PREFIX.length + 2 ||
      !isApiKeyId(keyId) ||
      !isApiKeyId(requestId) ||
      !isRecord(entry.value) ||
      !isPositiveSafeInteger(entry.value.created_at_ms) ||
      !isPositiveSafeInteger(entry.value.next_reconciliation_at_ms) ||
      entry.value.next_reconciliation_at_ms < entry.value.created_at_ms ||
      ("key_id" in entry.value && entry.value.key_id !== keyId) ||
      ("request_id" in entry.value && entry.value.request_id !== requestId)
    ) {
      errors.push(`paid fallback V3 pending marker is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    pending.add(paidFallbackV3Reference(keyId, requestId));
  }
  return { count, pending };
};

/** Validates every reconciliation lease row and counts them. */
const countPaidFallbackLeases = async (kv: Kv, knownKeyIds: ReadonlySet<string>, errors: string[]): Promise<number> => {
  let count = 0;
  for await (const entry of kv.list({ prefix: PAID_FALLBACK_RECONCILIATION_LEASE_V3_PREFIX })) {
    count += 1;
    const [keyId] = entry.key.slice(PAID_FALLBACK_RECONCILIATION_LEASE_V3_PREFIX.length);
    if (
      entry.key.length !== PAID_FALLBACK_RECONCILIATION_LEASE_V3_PREFIX.length + 1 ||
      !isApiKeyId(keyId) ||
      !isRecord(entry.value) ||
      typeof entry.value.token !== "string" ||
      entry.value.token.length === 0 ||
      !isPositiveSafeInteger(entry.value.expires_at_ms)
    ) {
      errors.push(`paid fallback V3 reconciliation lease is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    if (!knownKeyIds.has(keyId)) errors.push(`paid fallback V3 reconciliation lease is orphaned: ${keyId}`);
  }
  return count;
};

/** Validates every deletion guard row and counts them. */
const countPaidFallbackDeletionGuards = async (kv: Kv, errors: string[]): Promise<number> => {
  let count = 0;
  for await (const entry of kv.list({ prefix: PAID_FALLBACK_DELETION_GUARD_V3_PREFIX })) {
    count += 1;
    const [keyId] = entry.key.slice(PAID_FALLBACK_DELETION_GUARD_V3_PREFIX.length);
    if (
      entry.key.length !== PAID_FALLBACK_DELETION_GUARD_V3_PREFIX.length + 1 ||
      !isApiKeyId(keyId) ||
      !isRecord(entry.value) ||
      !isPositiveSafeInteger(entry.value.created_at_ms)
    ) {
      errors.push(`paid fallback V3 deletion guard is malformed: ${JSON.stringify(entry.key)}`);
    }
  }
  return count;
};

/** Reports every pending-marker inconsistency for one request row. */
const pushRequestMarkerErrors = (reference: string, request: PaidFallbackRequestV3, pending: ReadonlySet<string>, errors: string[]): void => {
  const isOutstanding = request.billing_state === "pending" || request.billing_state === "unresolved";
  if (isOutstanding && !pending.has(reference)) {
    errors.push(`paid fallback V3 request is missing its pending marker: ${request.key_id}/${request.request_id}`);
  }
  if (!isOutstanding && pending.has(reference)) {
    errors.push(`paid fallback V3 terminal request retains a pending marker: ${request.key_id}/${request.request_id}`);
  }
};

/** Reports every window/spend inconsistency for one request row. */
const pushRequestWindowErrors = (
  request: PaidFallbackRequestV3,
  windows: PaidFallbackWindowMap,
  unlimitedKeyIds: ReadonlySet<string>,
  errors: string[]
): void => {
  const window = windows.get(paidFallbackV3WindowReference(request.key_id, request.window_reset_at_ms));
  const isBounded = !unlimitedKeyIds.has(request.key_id);
  if (isBounded && (request.reserved_microcredits > 0 || (request.billing_state === "settled" && (request.spend_microcredits ?? 0) > 0)) && !window) {
    errors.push(`paid fallback V3 bounded request is missing its window: ${request.key_id}/${request.request_id}`);
  }
  if (request.billing_state === "settled" && request.spend_microcredits === null) {
    errors.push(`paid fallback V3 settled request is missing spend: ${request.key_id}/${request.request_id}`);
  }
  if ((request.billing_state === "pending" || request.billing_state === "unresolved") && request.spend_microcredits !== null) {
    errors.push(`paid fallback V3 outstanding request has spend: ${request.key_id}/${request.request_id}`);
  }
};

/** Cross-checks every request row against its pending marker and window. */
const auditPaidFallbackRequests = (
  requests: PaidFallbackRequestMap,
  pending: ReadonlySet<string>,
  windows: PaidFallbackWindowMap,
  unlimitedKeyIds: ReadonlySet<string>,
  errors: string[]
): void => {
  for (const [reference, request] of requests) {
    pushRequestMarkerErrors(reference, request, pending, errors);
    pushRequestWindowErrors(request, windows, unlimitedKeyIds, errors);
    // Historical requests retain the policy version that admitted them. A
    // window can carry a newer version after an admin policy edit.
  }
  for (const reference of pending) {
    if (!requests.has(reference)) errors.push(`paid fallback V3 pending marker is orphaned: ${reference}`);
  }
};

/** Recomputes every window aggregate that is still fully reconstructible. */
const auditPaidFallbackWindows = (windows: PaidFallbackWindowMap, requests: PaidFallbackRequestMap, nowMs: number, errors: string[]): void => {
  for (const [reference, window] of windows) {
    // Raw request rows expire one year after their individual creation times,
    // so a window's earliest rows can age out up to one window length before
    // `reset + retention`. Stop exact reconstruction with a conservative
    // slack (larger than any supported window preset) instead of reporting a
    // healthy window as inconsistent once its rows start disappearing.
    if (window.window_reset_at_ms + PAID_FALLBACK_REQUEST_LOG_RETENTION_MS - PAID_FALLBACK_VALIDATION_SLACK_MS <= nowMs) continue;
    const outstanding = [...requests.values()].filter(
      (request) =>
        request.key_id === window.key_id &&
        request.window_reset_at_ms === window.window_reset_at_ms &&
        (request.billing_state === "pending" || request.billing_state === "unresolved")
    );
    const reservedMicrocredits = outstanding.reduce((sum, request) => sum + request.reserved_microcredits, 0);
    const settledRequests = [...requests.values()].filter(
      (request) => request.key_id === window.key_id && request.window_reset_at_ms === window.window_reset_at_ms && request.billing_state === "settled"
    );
    const settledMicrocredits = settledRequests.reduce((sum, request) => sum + (request.spend_microcredits ?? 0), 0);
    if (
      !Number.isSafeInteger(reservedMicrocredits) ||
      !Number.isSafeInteger(settledMicrocredits) ||
      window.pending_count !== outstanding.length ||
      window.reserved_microcredits !== reservedMicrocredits ||
      window.settled_microcredits !== settledMicrocredits
    ) {
      errors.push(`paid fallback V3 window aggregate is inconsistent: ${reference}`);
    }
  }
};

const inspectPaidFallbackV3 = async (
  kv: Kv,
  knownKeyIds: ReadonlySet<string>,
  unlimitedKeyIds: ReadonlySet<string>,
  nowMs = Date.now()
): Promise<PaidFallbackV3Inventory> => {
  const errors: string[] = [];
  const windowInventory = await collectPaidFallbackWindows(kv, knownKeyIds, errors);
  const requestInventory = await collectPaidFallbackRequests(kv, knownKeyIds, errors);
  const pendingInventory = await collectPaidFallbackPending(kv, errors);
  const reconciliationLeases = await countPaidFallbackLeases(kv, knownKeyIds, errors);
  const deletionGuards = await countPaidFallbackDeletionGuards(kv, errors);

  auditPaidFallbackRequests(requestInventory.requests, pendingInventory.pending, windowInventory.windows, unlimitedKeyIds, errors);
  auditPaidFallbackWindows(windowInventory.windows, requestInventory.requests, nowMs, errors);

  return {
    windows: windowInventory.count,
    requests: requestInventory.count,
    pending: pendingInventory.count,
    reconciliationLeases,
    deletionGuards,
    errors,
  };
};

export {
  API_KEY_USAGE_V2_MIGRATION_BASELINE_PREFIX,
  LEGACY_REQUEST_LOG_PREFIX,
  PAID_FALLBACK_LEDGER_PREFIX,
  PAID_FALLBACK_PENDING_V3_PREFIX,
  PAID_FALLBACK_REQUEST_V3_PREFIX,
  PAID_FALLBACK_V3_PREFIX,
  PAID_FALLBACK_WINDOW_V3_PREFIX,
  apiKeyHashPolicyMatches,
  hasStrictApiKeyCorePolicy,
  hasStrictApiKeyHashCorePolicy,
  inspectPaidFallbackV3,
  isApiKeyHash,
  isApiKeyId,
  isFiniteNonNegativeNumber,
  isPaidFallbackRequestV3,
  isPendingPaidFallbackLedgerRecord,
  isPositiveSafeInteger,
  isSafeUsageCount,
  paidFallbackLedgerEntryMatchesIdentity,
  paidFallbackLedgerReference,
  paidFallbackV3WindowReference,
  pendingPaidFallbackLedgerReferenceFromEntry,
};
