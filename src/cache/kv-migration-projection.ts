import type { Kv, KvEntry, KvEntryMaybe, KvKey } from "#kv";
// Legacy paid fallback projection and repair, split out of src/kv_migration.ts.

import type { ApiKeyRecord, ApiKeyRequestLogRecord, PaidFallbackRequestV3, PaidFallbackWindowV3 } from "../types.ts";
import { isPaidFallbackWindowV3, recomputePaidFallbackReconciliationGateV3, requestRowExpireIn } from "../paid-fallback/ledger-state.ts";
import { isRecord } from "../utils.ts";
import {
  LEGACY_REQUEST_LOG_PREFIX,
  PAID_FALLBACK_LEDGER_PREFIX,
  PAID_FALLBACK_PENDING_V3_PREFIX,
  PAID_FALLBACK_REQUEST_V3_PREFIX,
  PAID_FALLBACK_V3_PREFIX,
  PAID_FALLBACK_WINDOW_V3_PREFIX,
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
} from "./kv-migration-paid-fallback.ts";
import type { StrictApiKeyPair } from "./kv-migration-usage.ts";

type LegacyPaidFallbackLedgerCandidate = Readonly<{
  value: ApiKeyRequestLogRecord;
  ledgerKey: KvKey;
  existing: KvEntryMaybe<ApiKeyRequestLogRecord>;
}>;

type LegacyPaidFallbackProjectionCandidate = Readonly<{
  value: ApiKeyRequestLogRecord;
  source_key: KvKey;
}>;

type LegacyPaidFallbackProjectionResult = Readonly<{
  projected: number;
  pending: number;
}>;

const LEGACY_PAID_FALLBACK_BILLING_STATES = new Set(["pending", "reconciled", "not_billed", "unresolved"]);

/** True when an untrusted billing status is one of the legacy states. */
const isLegacyPaidFallbackBillingState = (value: unknown): boolean => typeof value === "string" && LEGACY_PAID_FALLBACK_BILLING_STATES.has(value);

/** The first value accepted by `isValid`, or null when none is. */
const firstValid = <T>(values: readonly unknown[], isValid: (value: unknown) => value is T): T | null => {
  for (const value of values) {
    if (isValid(value)) return value;
  }
  return null;
};

/** A non-empty trimmed string field, or the fallback. */
const legacyText = (value: unknown, fallback: string): string => (typeof value === "string" && value.trim() ? value : fallback);

/** A non-empty trimmed string field, or null. */
const legacyNullableText = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** A clamped HTTP status code, or 0 when the field is absent or not finite. */
const legacyStatusCode = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(599, Math.trunc(value))) : 0);

/** The legacy billing status a projected row carries. */
const legacyBillingStatus = (billing: unknown): ApiKeyRequestLogRecord["billing_status"] => {
  if (billing === "reconciled" || billing === "not_billed" || billing === "unresolved") return billing;
  return "pending";
};

/** Projects an untrusted legacy request-log value onto the request shape. */
const legacyPaidFallbackValue = (
  raw: Record<string, unknown>,
  identity: Readonly<{ keyId: string; requestId: string; createdAtMs: number; billing: unknown }>
): ApiKeyRequestLogRecord => ({
  id: identity.requestId,
  key_id: identity.keyId,
  route: legacyText(raw.route, "responses"),
  path: legacyText(raw.path, "/v1/responses"),
  method: legacyText(raw.method, "POST"),
  status_code: legacyStatusCode(raw.status_code),
  stream: raw.stream === true,
  model: legacyText(raw.model, "legacy-unknown"),
  reasoning: legacyNullableText(raw.reasoning),
  created_at_ms: identity.createdAtMs,
  provider: "metered",
  fallback_reason: typeof raw.fallback_reason === "string" ? raw.fallback_reason : "primary_429",
  provider_request_id: legacyNullableText(raw.provider_request_id),
  completed_at_ms: isPositiveSafeInteger(raw.completed_at_ms) ? raw.completed_at_ms : null,
  latency_ms: isSafeUsageCount(raw.latency_ms) ? raw.latency_ms : null,
  input_tokens: isSafeUsageCount(raw.input_tokens) ? raw.input_tokens : null,
  output_tokens: isSafeUsageCount(raw.output_tokens) ? raw.output_tokens : null,
  provider_quota: isFiniteNonNegativeNumber(raw.provider_quota) ? raw.provider_quota : null,
  quota_per_credit: isPositiveSafeInteger(raw.quota_per_credit) ? raw.quota_per_credit : null,
  spend_microcredits: isSafeUsageCount(raw.spend_microcredits) ? raw.spend_microcredits : null,
  paid_fallback_window_reset_at_ms: isPositiveSafeInteger(raw.paid_fallback_window_reset_at_ms) ? raw.paid_fallback_window_reset_at_ms : null,
  billing_status: legacyBillingStatus(identity.billing),
});

const legacyPaidFallbackReference = (keyId: string, requestId: string): string => JSON.stringify([keyId, requestId]);

const legacyPaidFallbackCandidate = (entry: Pick<KvEntry<unknown>, "key" | "value">): LegacyPaidFallbackProjectionCandidate | null => {
  if (!isRecord(entry.value) || entry.value.provider !== "metered") return null;
  const keyId = isApiKeyId(entry.value.key_id) ? entry.value.key_id : null;
  const keySuffix = entry.key.at(-2);
  const requestSuffix = entry.key.at(-1);
  const requestId = firstValid([entry.value.id, requestSuffix], isApiKeyId);
  const createdAtMs = firstValid([entry.value.created_at_ms, keySuffix], isPositiveSafeInteger);
  if (!keyId || !requestId || createdAtMs === null) return null;
  const billing = entry.value.billing_status;
  if (billing !== undefined && !isLegacyPaidFallbackBillingState(billing)) return null;
  return {
    source_key: entry.key,
    value: legacyPaidFallbackValue(entry.value, { keyId, requestId, createdAtMs, billing }),
  };
};

const listLegacyPaidFallbackProjectionCandidates = async (kv: Kv): Promise<LegacyPaidFallbackProjectionCandidate[]> => {
  const byReference = new Map<string, LegacyPaidFallbackProjectionCandidate>();
  for (const prefix of [LEGACY_REQUEST_LOG_PREFIX, PAID_FALLBACK_LEDGER_PREFIX] as const) {
    for await (const entry of kv.list({ prefix })) {
      const candidate = legacyPaidFallbackCandidate(entry);
      if (!candidate) continue;
      // The dedicated paid-fallback ledger is the newer copy of a request log.
      // Prefer it when both prefixes contain the same immutable request.
      const reference = legacyPaidFallbackReference(candidate.value.key_id, candidate.value.id);
      if (prefix === PAID_FALLBACK_LEDGER_PREFIX || !byReference.has(reference)) {
        byReference.set(reference, candidate);
      }
    }
  }
  return [...byReference.values()];
};

const legacyWindowResetAtMs = (record: ApiKeyRecord, request: ApiKeyRequestLogRecord): number => {
  if (request.paid_fallback_window_reset_at_ms !== null) return request.paid_fallback_window_reset_at_ms;
  if (request.created_at_ms < record.usage_reset_at_ms) return record.usage_reset_at_ms;
  const initialStart = record.usage_reset_at_ms - record.window_ms;
  const elapsed = Math.floor((request.created_at_ms - initialStart) / record.window_ms);
  return initialStart + (elapsed + 1) * record.window_ms;
};

const legacyPolicyVersion = (record: ApiKeyRecord, _request: ApiKeyRequestLogRecord, windowResetAtMs: number): string =>
  `legacy:${windowResetAtMs}:${record.window_ms}:${record.paid_fallback_pricing_checked_at_ms ?? 0}`;

const legacyMaximumExposure = (record: ApiKeyRecord, request: ApiKeyRequestLogRecord): number => {
  if (record.paid_fallback_limit_microcredits === -1) return 0;
  if (record.paid_fallback_reservation_request_id === request.id && isSafeUsageCount(record.paid_fallback_reserved_microcredits)) {
    // The legacy policy stores the one live reservation's exact exposure.
    // Prefer it over today's model policy, which may have changed since the
    // request was admitted.
    return record.paid_fallback_reserved_microcredits;
  }
  const configured = record.paid_fallback_max_exposure_microcredits ? record.paid_fallback_max_exposure_microcredits[request.model ?? ""] : 0;
  if (isPositiveSafeInteger(configured)) return configured;
  return 0;
};

const paidFallbackV3WindowKey = (keyId: string, windowResetAtMs: number): KvKey => [...PAID_FALLBACK_WINDOW_V3_PREFIX, keyId, windowResetAtMs];

const isPaidFallbackPendingV3 = (
  value: unknown
): value is {
  created_at_ms: number;
  next_reconciliation_at_ms: number;
} =>
  isRecord(value) &&
  isPositiveSafeInteger(value.created_at_ms) &&
  isPositiveSafeInteger(value.next_reconciliation_at_ms) &&
  value.next_reconciliation_at_ms >= value.created_at_ms;

const paidFallbackPendingIdentityMatches = (value: unknown, keyId: string, requestId: string): boolean => {
  if (!isPaidFallbackPendingV3(value)) return false;
  const record = value as Record<string, unknown>;
  return (!("key_id" in record) || record.key_id === keyId) && (!("request_id" in record) || record.request_id === requestId);
};

const repairProjectedPaidFallbackPending = async (kv: Kv, nowMs: number): Promise<void> => {
  for await (const requestEntry of kv.list({ prefix: PAID_FALLBACK_REQUEST_V3_PREFIX })) {
    if (!isPaidFallbackRequestV3(requestEntry.value)) continue;
    const request = requestEntry.value;
    const pendingKey = [...PAID_FALLBACK_PENDING_V3_PREFIX, request.key_id, request.request_id] as const;
    const pendingEntry = await kv.get(pendingKey, { consistency: "strong" });
    const outstanding = request.billing_state === "pending" || request.billing_state === "unresolved";
    if (
      outstanding &&
      pendingEntry.value !== null &&
      paidFallbackPendingIdentityMatches(pendingEntry.value, request.key_id, request.request_id) &&
      (pendingEntry.value as { created_at_ms: number }).created_at_ms >= request.created_at_ms
    ) {
      continue;
    }
    if (!outstanding && pendingEntry.value === null) continue;
    let atomic = kv.atomic().check(requestEntry).check(pendingEntry);
    if (outstanding) {
      atomic = atomic.set(pendingKey, {
        created_at_ms: request.created_at_ms,
        next_reconciliation_at_ms: Math.max(nowMs, request.created_at_ms),
      });
    } else {
      atomic = atomic.delete(pendingKey);
    }
    const committed = await atomic.commit();
    if (!committed.ok) {
      throw new Error(`Paid fallback V3 pending state changed concurrently: ${request.key_id}/${request.request_id}`);
    }
  }
};

type PaidFallbackWindowReference = Readonly<{ key_id: string; window_reset_at_ms: number }>;

/** Every window reference that must agree with its projected request rows. */
const collectRepairablePaidFallbackWindows = async (
  kv: Kv,
  recordsByKey: ReadonlyMap<string, ApiKeyRecord>,
  candidateWindowReferences: ReadonlySet<string>
): Promise<Map<string, PaidFallbackWindowReference>> => {
  const windows = new Map<string, PaidFallbackWindowReference>();
  for (const reference of candidateWindowReferences) {
    const parsed = JSON.parse(reference) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || !isApiKeyId(parsed[0]) || !isPositiveSafeInteger(parsed[1])) {
      continue;
    }
    const record = recordsByKey.get(parsed[0]);
    if (record && record.paid_fallback_limit_microcredits !== -1) {
      windows.set(reference, { key_id: parsed[0], window_reset_at_ms: parsed[1] });
    }
  }
  for await (const entry of kv.list({ prefix: PAID_FALLBACK_WINDOW_V3_PREFIX })) {
    const [keyId, windowResetAtMs] = entry.key.slice(PAID_FALLBACK_WINDOW_V3_PREFIX.length);
    if (isApiKeyId(keyId) && isPositiveSafeInteger(windowResetAtMs) && recordsByKey.get(keyId)?.paid_fallback_limit_microcredits !== -1) {
      windows.set(paidFallbackV3WindowReference(keyId, windowResetAtMs), { key_id: keyId, window_reset_at_ms: windowResetAtMs });
    }
  }
  for await (const entry of kv.list({ prefix: PAID_FALLBACK_REQUEST_V3_PREFIX })) {
    if (!isPaidFallbackRequestV3(entry.value)) continue;
    if (recordsByKey.get(entry.value.key_id)?.paid_fallback_limit_microcredits === -1) continue;
    windows.set(paidFallbackV3WindowReference(entry.value.key_id, entry.value.window_reset_at_ms), {
      key_id: entry.value.key_id,
      window_reset_at_ms: entry.value.window_reset_at_ms,
    });
  }
  return windows;
};

/** Request rows currently stored for one window. */
const listPaidFallbackWindowRequests = async (kv: Kv, keyId: string, windowResetAtMs: number): Promise<PaidFallbackRequestV3[]> => {
  const requests: PaidFallbackRequestV3[] = [];
  for await (const requestEntry of kv.list({ prefix: PAID_FALLBACK_REQUEST_V3_PREFIX })) {
    if (isPaidFallbackRequestV3(requestEntry.value) && requestEntry.value.key_id === keyId && requestEntry.value.window_reset_at_ms === windowResetAtMs) {
      requests.push(requestEntry.value);
    }
  }
  return requests;
};

/** Aggregates the projected request rows of one window. */
const paidFallbackRequestAggregate = (
  requests: readonly PaidFallbackRequestV3[]
): Readonly<{ settledMicrocredits: number; reservedMicrocredits: number; pendingCount: number }> => ({
  settledMicrocredits: requests.reduce((sum, request) => sum + (request.billing_state === "settled" ? (request.spend_microcredits ?? 0) : 0), 0),
  reservedMicrocredits: requests.reduce(
    (sum, request) => sum + (request.billing_state === "pending" || request.billing_state === "unresolved" ? request.reserved_microcredits : 0),
    0
  ),
  pendingCount: requests.reduce((count, request) => count + (request.billing_state === "pending" || request.billing_state === "unresolved" ? 1 : 0), 0),
});

/** The stored window row, or a freshly projected one when it is missing. */
const projectedPaidFallbackWindow = (
  stored: PaidFallbackWindowV3 | null,
  context: Readonly<{
    keyId: string;
    windowResetAtMs: number;
    nowMs: number;
    record: ApiKeyRecord | undefined;
    firstRequest: PaidFallbackRequestV3 | undefined;
  }>
): PaidFallbackWindowV3 =>
  stored ?? {
    v: 3,
    key_id: context.keyId,
    policy_version: context.firstRequest?.policy_version ?? `legacy:${context.windowResetAtMs}:${context.record?.window_ms ?? 0}:0`,
    window_reset_at_ms: context.windowResetAtMs,
    limit_microcredits: context.record?.paid_fallback_limit_microcredits ?? 0,
    settled_microcredits: 0,
    reserved_microcredits: 0,
    pending_count: 0,
    updated_at_ms: context.nowMs,
  };

/** Repairs one window aggregate with a bounded CAS retry loop. */
const repairOnePaidFallbackWindow = async (
  kv: Kv,
  context: Readonly<{ keyId: string; windowResetAtMs: number; record: ApiKeyRecord | undefined; nowMs: number }>
): Promise<void> => {
  const windowKey = paidFallbackV3WindowKey(context.keyId, context.windowResetAtMs);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const requests = await listPaidFallbackWindowRequests(kv, context.keyId, context.windowResetAtMs);
    const { settledMicrocredits, reservedMicrocredits, pendingCount } = paidFallbackRequestAggregate(requests);
    if (!Number.isSafeInteger(settledMicrocredits) || !Number.isSafeInteger(reservedMicrocredits) || !Number.isSafeInteger(pendingCount)) {
      throw new Error(`Paid fallback V3 window aggregate overflow: ${context.keyId}/${context.windowResetAtMs}`);
    }
    const entry = await kv.get<PaidFallbackWindowV3>(windowKey, { consistency: "strong" });
    if (entry.value !== null && !isPaidFallbackWindowV3(entry.value)) {
      throw new Error(`Paid fallback V3 window is invalid: ${context.keyId}/${context.windowResetAtMs}`);
    }
    const current = projectedPaidFallbackWindow(entry.value, { ...context, firstRequest: requests.at(0) });
    if (
      entry.value &&
      current.settled_microcredits === settledMicrocredits &&
      current.reserved_microcredits === reservedMicrocredits &&
      current.pending_count === pendingCount
    ) {
      break;
    }
    const next = {
      ...current,
      settled_microcredits: settledMicrocredits,
      reserved_microcredits: reservedMicrocredits,
      pending_count: pendingCount,
      updated_at_ms: Math.max(context.nowMs, current.updated_at_ms),
    } satisfies PaidFallbackWindowV3;
    const committed = await kv.atomic().check(entry).set(windowKey, next).commit();
    if (committed.ok) break;
    if (attempt === 4) {
      throw new Error(`Paid fallback V3 window changed concurrently: ${context.keyId}/${context.windowResetAtMs}`);
    }
  }
};

const repairProjectedPaidFallbackWindows = async (
  kv: Kv,
  pairs: readonly StrictApiKeyPair[],
  candidateWindowReferences: ReadonlySet<string>,
  nowMs: number
): Promise<void> => {
  const recordsByKey = new Map(pairs.map(({ record }) => [record.id, record]));
  const windows = await collectRepairablePaidFallbackWindows(kv, recordsByKey, candidateWindowReferences);
  for (const { key_id: keyId, window_reset_at_ms: windowResetAtMs } of windows.values()) {
    await repairOnePaidFallbackWindow(kv, { keyId, windowResetAtMs, record: recordsByKey.get(keyId), nowMs });
  }
};

/** Maps a legacy billing status onto the V3 billing state. */
const legacyV3BillingState = (billingStatus: ApiKeyRequestLogRecord["billing_status"]): PaidFallbackRequestV3["billing_state"] => {
  if (billingStatus === "reconciled") return "settled";
  if (billingStatus === "not_billed") return "not_billed";
  if (billingStatus === "unresolved") return "unresolved";
  return "pending";
};

/** Maps a legacy billing state and status code onto the V3 terminal state. */
const legacyV3TerminalState = (billingState: PaidFallbackRequestV3["billing_state"], statusCode: number): PaidFallbackRequestV3["terminal_state"] => {
  if (billingState === "settled") return statusCode >= 200 && statusCode < 300 ? "completed" : "failed";
  if (billingState === "not_billed") return "cancelled";
  if (billingState === "unresolved") return "ambiguous";
  return "pending";
};

type LegacyPaidFallbackProjectionStep = Readonly<{ projected: number; pending: number }>;

/** V3 request row projected from one legacy request-log row. */
const legacyPaidFallbackRequestRow = (
  legacy: ApiKeyRequestLogRecord,
  record: ApiKeyRecord,
  windowResetAtMs: number,
  billingState: PaidFallbackRequestV3["billing_state"],
  quotaPerCredit: number,
  nowMs: number
): PaidFallbackRequestV3 => {
  const outstanding = billingState === "pending" || billingState === "unresolved";
  const dispatchState: PaidFallbackRequestV3["dispatch_state"] = legacy.provider_request_id || legacy.status_code > 0 ? "dispatched" : "reserved";
  const terminalState = legacyV3TerminalState(billingState, legacy.status_code);
  const terminalAtMs = legacy.completed_at_ms ?? legacy.created_at_ms;
  return {
    v: 3,
    key_id: legacy.key_id,
    request_id: legacy.id,
    policy_version: legacyPolicyVersion(record, legacy, windowResetAtMs),
    route: legacy.route,
    path: legacy.path,
    model: legacy.model ?? "legacy-unknown",
    stream: legacy.stream,
    reasoning: legacy.reasoning,
    ...(legacy.provider === "surplus" ? { provider: "surplus" as const } : {}),
    window_reset_at_ms: windowResetAtMs,
    reserved_microcredits: outstanding ? legacyMaximumExposure(record, legacy) : 0,
    quota_per_credit: quotaPerCredit,
    provider_request_id: legacy.provider_request_id,
    provider_quota: legacy.provider_quota,
    input_tokens: legacy.input_tokens,
    output_tokens: legacy.output_tokens,
    dispatch_state: dispatchState,
    terminal_state: terminalState,
    spend_microcredits: billingState === "settled" ? (legacy.spend_microcredits ?? 0) : null,
    billing_state: billingState,
    reconciliation_attempts: 0,
    last_reconciliation_at_ms: null,
    dispatched_at_ms: dispatchState === "dispatched" ? legacy.created_at_ms : null,
    terminal_at_ms: terminalState === "pending" ? null : terminalAtMs,
    settled_at_ms: billingState === "settled" ? terminalAtMs : null,
    created_at_ms: legacy.created_at_ms,
    updated_at_ms: Math.max(legacy.created_at_ms, legacy.completed_at_ms ?? 0, nowMs),
  };
};

/** Writes the projected V3 request and pending rows for one legacy candidate. */
const commitLegacyPaidFallbackStep = async (
  kv: Kv,
  keys: Readonly<{ requestKey: KvKey; pendingKey: KvKey }>,
  request: PaidFallbackRequestV3,
  requestEntry: KvEntryMaybe<PaidFallbackRequestV3>,
  pendingEntry: KvEntryMaybe<{ created_at_ms: number; next_reconciliation_at_ms: number }>,
  nowMs: number
): Promise<LegacyPaidFallbackProjectionStep> => {
  const existingRequest = requestEntry.value;
  const effectiveRequest = existingRequest ?? request;
  let atomic = kv.atomic().check(requestEntry).check(pendingEntry);
  let needsCommit = false;
  let projected = 0;
  let pending = 0;
  if (existingRequest === null) {
    // Migrated rows inherit the one-year raw-row retention anchored to
    // their original creation time, so a re-run of this migration cannot
    // resurrect rows that have already aged out of the retention window.
    atomic = atomic.set(keys.requestKey, request, { expireIn: requestRowExpireIn(request, nowMs) });
    projected += 1;
    needsCommit = true;
  }
  const effectiveOutstanding = effectiveRequest.billing_state === "pending" || effectiveRequest.billing_state === "unresolved";
  if (effectiveOutstanding) {
    atomic = atomic.set(keys.pendingKey, {
      created_at_ms: effectiveRequest.created_at_ms,
      next_reconciliation_at_ms: Math.max(nowMs, effectiveRequest.created_at_ms),
    });
    if (pendingEntry.value === null) {
      pending += 1;
      needsCommit = true;
    } else if (!paidFallbackPendingIdentityMatches(pendingEntry.value, request.key_id, request.request_id)) {
      needsCommit = true;
    }
  } else if (pendingEntry.value !== null) {
    atomic = atomic.delete(keys.pendingKey);
    needsCommit = true;
  }
  if (needsCommit) {
    const committed = await atomic.commit();
    if (!committed.ok) {
      throw new Error(`Paid fallback V3 migration changed concurrently: ${request.key_id}/${request.request_id}`);
    }
  }
  return { projected, pending };
};

/** Projects one legacy paid-fallback candidate into the V3 rows. */
const projectLegacyPaidFallbackCandidate = async (
  kv: Kv,
  legacy: ApiKeyRequestLogRecord,
  recordsByKey: ReadonlyMap<string, ApiKeyRecord>,
  candidateWindowReferences: Set<string>,
  nowMs: number
): Promise<LegacyPaidFallbackProjectionStep> => {
  const record = recordsByKey.get(legacy.key_id);
  if (record === undefined) return { projected: 0, pending: 0 };
  const requestKey = [...PAID_FALLBACK_V3_PREFIX, "request", legacy.key_id, legacy.id] as const;
  const pendingKey = [...PAID_FALLBACK_V3_PREFIX, "pending", legacy.key_id, legacy.id] as const;
  const windowResetAtMs = legacyWindowResetAtMs(record, legacy);
  if (record.paid_fallback_limit_microcredits !== -1) {
    candidateWindowReferences.add(paidFallbackV3WindowReference(legacy.key_id, windowResetAtMs));
  }
  const billingState = legacyV3BillingState(legacy.billing_status);
  const quotaPerCredit = legacy.quota_per_credit ?? record.paid_fallback_quota_per_credit;
  if (!isPositiveSafeInteger(quotaPerCredit)) {
    throw new Error(`Legacy paid fallback request has no valid pricing: ${legacy.key_id}/${legacy.id}`);
  }
  const request = legacyPaidFallbackRequestRow(legacy, record, windowResetAtMs, billingState, quotaPerCredit, nowMs);
  const [requestEntry, pendingEntry] = await Promise.all([
    kv.get<PaidFallbackRequestV3>(requestKey, { consistency: "strong" }),
    kv.get<{ created_at_ms: number; next_reconciliation_at_ms: number }>(pendingKey, { consistency: "strong" }),
  ]);
  const existingRequest = requestEntry.value;
  if (
    existingRequest !== null &&
    (!isPaidFallbackRequestV3(existingRequest) || existingRequest.key_id !== request.key_id || existingRequest.request_id !== request.request_id)
  ) {
    throw new Error(`V3 paid fallback request identity collision: ${legacy.key_id}/${legacy.id}`);
  }
  return await commitLegacyPaidFallbackStep(kv, { requestKey, pendingKey }, request, requestEntry, pendingEntry, nowMs);
};

const projectLegacyPaidFallbackV3 = async (kv: Kv, pairs: readonly StrictApiKeyPair[], nowMs: number): Promise<LegacyPaidFallbackProjectionResult> => {
  const recordsByKey = new Map(pairs.map(({ record }) => [record.id, record]));
  const candidates = await listLegacyPaidFallbackProjectionCandidates(kv);
  let projected = 0;
  let pending = 0;
  const candidateWindowReferences = new Set<string>();
  for (const candidate of candidates) {
    const step = await projectLegacyPaidFallbackCandidate(kv, candidate.value, recordsByKey, candidateWindowReferences, nowMs);
    projected += step.projected;
    pending += step.pending;
  }
  await repairProjectedPaidFallbackPending(kv, nowMs);
  await repairProjectedPaidFallbackWindows(kv, pairs, candidateWindowReferences, nowMs);
  // Migration can create or repair pending markers after the runtime gate has
  // already been initialized. Recompute it so the next cron wake-up cannot
  // miss newly projected billable fallback work.
  await recomputePaidFallbackReconciliationGateV3(kv);
  return { projected, pending };
};

/** True when an untrusted row is an outstanding paid-fallback ledger row. */
const isPendingPaidFallbackLedgerValue = (value: unknown): boolean =>
  isRecord(value) && value.provider === "metered" && (value.billing_status === "pending" || value.billing_status === "unresolved");

/** References of every pending row already stored in the dedicated ledger. */
const collectPendingPaidFallbackLedgerReferences = async (kv: Kv, errors: string[]): Promise<Set<string>> => {
  const availableReferences = new Set<string>();
  for await (const entry of kv.list({ prefix: PAID_FALLBACK_LEDGER_PREFIX })) {
    if (!isPendingPaidFallbackLedgerValue(entry.value)) continue;
    const reference = pendingPaidFallbackLedgerReferenceFromEntry(entry, PAID_FALLBACK_LEDGER_PREFIX);
    if (reference === null) {
      errors.push(`pending paid fallback ledger is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    availableReferences.add(reference);
  }
  return availableReferences;
};

/** Pending legacy request-log rows and their dedicated-ledger destinations. */
const collectPendingLegacyPaidFallbackCandidates = async (
  kv: Kv,
  availableReferences: Set<string>,
  errors: string[]
): Promise<LegacyPaidFallbackLedgerCandidate[]> => {
  const candidates: LegacyPaidFallbackLedgerCandidate[] = [];
  for await (const entry of kv.list({ prefix: LEGACY_REQUEST_LOG_PREFIX })) {
    const value = entry.value;
    if (!isPendingPaidFallbackLedgerValue(value)) continue;
    const reference = pendingPaidFallbackLedgerReferenceFromEntry(entry, LEGACY_REQUEST_LOG_PREFIX);
    if (reference === null || !isPendingPaidFallbackLedgerRecord(value)) {
      errors.push(`pending legacy paid fallback ledger is malformed: ${JSON.stringify(entry.key)}`);
      continue;
    }
    const ledgerKey = [...PAID_FALLBACK_LEDGER_PREFIX, value.key_id, value.created_at_ms, value.id] as const;
    const existing = await kv.get<ApiKeyRequestLogRecord>(ledgerKey);
    candidates.push({ value, ledgerKey, existing });
    if (existing.value === null) {
      availableReferences.add(reference);
      continue;
    }
    if (!paidFallbackLedgerEntryMatchesIdentity(existing, value)) {
      errors.push(`paid fallback ledger destination conflicts with legacy record: ${value.id}`);
      continue;
    }
    const existingReference = pendingPaidFallbackLedgerReferenceFromEntry(existing, PAID_FALLBACK_LEDGER_PREFIX);
    if (existingReference === reference) availableReferences.add(reference);
  }
  return candidates;
};

/** Reports reservations whose pending ledger row is missing. */
const auditPaidFallbackReservationLedgers = (pairs: readonly StrictApiKeyPair[], availableReferences: ReadonlySet<string>, errors: string[]): void => {
  for (const { record } of pairs) {
    const requestId = record.paid_fallback_reservation_request_id;
    if (requestId === null) continue;
    if (!availableReferences.has(paidFallbackLedgerReference(record.id, requestId))) {
      errors.push(`paid fallback reservation has no pending ledger record: ${record.id}`);
    }
  }
};

const inspectPendingPaidFallbackLedgers = async (
  kv: Kv,
  pairs: StrictApiKeyPair[]
): Promise<{ candidates: LegacyPaidFallbackLedgerCandidate[]; errors: string[] }> => {
  const errors: string[] = [];
  const availableReferences = await collectPendingPaidFallbackLedgerReferences(kv, errors);
  const candidates = await collectPendingLegacyPaidFallbackCandidates(kv, availableReferences, errors);
  auditPaidFallbackReservationLedgers(pairs, availableReferences, errors);
  return { candidates, errors };
};

export type { LegacyPaidFallbackLedgerCandidate };
export { inspectPendingPaidFallbackLedgers, projectLegacyPaidFallbackV3 };
