import type { Kv, KvEntryMaybe, KvKey } from "#kv";
// Paid-fallback ledger v3: admission layer, split out of src/paid_fallback_ledger.ts.

import { PAID_FALLBACK_NO_LIMIT } from "../api-keys.ts";
import { getKv } from "../kv.ts";
import { paidFallbackBackfillAttempted, paidFallbackBackfillRetryPending, schedulePaidFallbackBackfill } from "./ledger-backfill.ts";
import {} from "./ledger-settlement.ts";
import {
  type AdmissionInput,
  MAX_CAS_ATTEMPTS,
  type PaidFallbackAdmissionV3,
  type PaidFallbackDeletionGuardV3,
  type PaidFallbackOutstandingV3,
  type PaidFallbackPendingV3,
  type PaidFallbackReconciliationGateV3,
  getPaidFallbackOutstandingV3,
  isPositiveSafeInteger,
  paidFallbackDeletionGuardV3Key,
  paidFallbackPendingV3Key,
  paidFallbackPendingV3Prefix,
  paidFallbackReconciliationGateDueNow,
  paidFallbackReconciliationGateNeedsArm,
  paidFallbackReconciliationGateV3Key,
  paidFallbackReconciliationLeaseV3Key,
  paidFallbackRequestV3Key,
  paidFallbackRequestV3Prefix,
  paidFallbackWindowV3Key,
  paidFallbackWindowV3Prefix,
  requestRowExpireIn,
  resolveKv,
  windowExpireIn,
} from "./ledger-state.ts";
import { type PaidFallbackProvider, type PaidFallbackRequestV3, type PaidFallbackWindowV3 } from "../types.ts";

export type PaidFallbackDeletionV3 =
  | Readonly<{
      kind: "deleted";
      deleted_requests: number;
      deleted_windows: number;
      deleted_pending: number;
      deleted_leases: number;
    }>
  | Readonly<{ kind: "blocked"; outstanding: PaidFallbackOutstandingV3 }>
  | Readonly<{ kind: "unavailable" }>;

const deleteKvKeys = async (kv: Kv, keys: readonly KvKey[]): Promise<void> => {
  for (let offset = 0; offset < keys.length; offset += 100) {
    let atomic = kv.atomic();
    for (const key of keys.slice(offset, offset + 100)) atomic = atomic.delete(key);
    const commit = await atomic.commit();
    if (!commit.ok) throw new Error("Paid fallback state deletion changed concurrently.");
  }
};

export const deletePaidFallbackStateV3 = async (keyId: string, kvOverride?: Kv | null): Promise<PaidFallbackDeletionV3> => {
  const kv = await resolveKv(kvOverride);
  if (!kv) return { kind: "unavailable" };
  const guardKey = paidFallbackDeletionGuardV3Key(keyId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const guard = await kv.get<PaidFallbackDeletionGuardV3>(guardKey, { consistency: "strong" });
    if (guard.value) break;
    const commit = await kv.atomic().check(guard).set(guardKey, { created_at_ms: Date.now() }).commit();
    if (commit.ok) break;
    if (attempt === MAX_CAS_ATTEMPTS - 1) {
      throw new Error("Paid fallback deletion guard changed concurrently.");
    }
  }
  const outstanding = await getPaidFallbackOutstandingV3(keyId, kv);
  if (!outstanding) return { kind: "unavailable" };
  if (outstanding.has_outstanding) return { kind: "blocked", outstanding };

  const requestKeys: KvKey[] = [];
  const windowKeys: KvKey[] = [];
  const pendingKeys: KvKey[] = [];
  for await (const entry of kv.list({ prefix: paidFallbackRequestV3Prefix(keyId) }, { consistency: "strong" })) {
    requestKeys.push(entry.key);
  }
  for await (const entry of kv.list({ prefix: paidFallbackWindowV3Prefix(keyId) }, { consistency: "strong" })) {
    windowKeys.push(entry.key);
  }
  for await (const entry of kv.list({ prefix: paidFallbackPendingV3Prefix(keyId) }, { consistency: "strong" })) {
    pendingKeys.push(entry.key);
  }
  const leaseKey = paidFallbackReconciliationLeaseV3Key(keyId);
  const lease = await kv.get(leaseKey, { consistency: "strong" });
  await deleteKvKeys(kv, [...requestKeys, ...windowKeys, ...pendingKeys, ...(lease.value ? [leaseKey] : [])]);
  return {
    kind: "deleted",
    deleted_requests: requestKeys.length,
    deleted_windows: windowKeys.length,
    deleted_pending: pendingKeys.length,
    deleted_leases: lease.value ? 1 : 0,
  };
};

export type PaidFallbackAdmissionBlockedReason = "limit_exceeded" | "invalid_policy" | "concurrent_update";

/** Default window row for a key that has no window yet. */
const defaultPaidFallbackWindowV3 = (input: AdmissionInput): PaidFallbackWindowV3 => ({
  v: 3,
  key_id: input.keyId,
  policy_version: input.policyVersion,
  window_reset_at_ms: input.windowResetAtMs,
  limit_microcredits: input.limitMicrocredits,
  settled_microcredits: input.initialSettledMicrocredits,
  reserved_microcredits: 0,
  pending_count: 0,
  updated_at_ms: input.createdAtMs,
});

/** The row written for one admitted request. */
const buildPaidFallbackRequestV3 = (input: AdmissionInput, reservation: number, now: number): PaidFallbackRequestV3 => ({
  v: 3,
  key_id: input.keyId,
  request_id: input.requestId,
  policy_version: input.policyVersion,
  route: input.route,
  path: input.path,
  model: input.model,
  stream: input.stream,
  reasoning: input.reasoning,
  window_reset_at_ms: input.windowResetAtMs,
  reserved_microcredits: reservation,
  quota_per_credit: input.quotaPerCredit,
  provider_request_id: null,
  provider_quota: null,
  input_tokens: null,
  cached_input_tokens: null,
  output_tokens: null,
  dispatch_state: input.dispatchIntent ? "dispatched" : "reserved",
  terminal_state: "pending",
  spend_microcredits: null,
  billing_state: "pending",
  reconciliation_attempts: 0,
  last_reconciliation_at_ms: null,
  dispatched_at_ms: input.dispatchIntent ? now : null,
  terminal_at_ms: null,
  settled_at_ms: null,
  created_at_ms: input.createdAtMs,
  updated_at_ms: now,
});

/** Everything the write phase of one admission attempt needs. */
type AdmissionWriteContext = Readonly<{
  unlimited: boolean;
  requestKey: KvKey;
  pendingKey: KvKey;
  windowKey: KvKey;
  gateKey: KvKey;
  requestEntry: KvEntryMaybe<PaidFallbackRequestV3>;
  windowEntry: KvEntryMaybe<PaidFallbackWindowV3>;
  deletionGuardEntry: KvEntryMaybe<PaidFallbackDeletionGuardV3>;
  transitioned: PaidFallbackWindowV3;
  reservation: number;
  now: number;
}>;

type AdmissionDecision =
  | Readonly<{ kind: "reserved"; reservation: PaidFallbackAdmissionV3 }>
  | Readonly<{ kind: "blocked"; reason: Exclude<PaidFallbackAdmissionBlockedReason, "concurrent_update"> }>
  | Readonly<{ kind: "write"; context: AdmissionWriteContext }>;

/**
 * Commits the policy transition that unblocks a limit-exceeded window so the
 * next attempt re-reads the new policy. Returns `true` when the caller should
 * report `limit_exceeded`, `false` when the CAS lost and the attempt retries.
 */
const commitExhaustedPolicyTransitionV3 = async (
  kv: Kv,
  input: AdmissionInput,
  windowKey: KvKey,
  windowEntry: KvEntryMaybe<PaidFallbackWindowV3>,
  deletionGuardEntry: KvEntryMaybe<PaidFallbackDeletionGuardV3>,
  transitioned: PaidFallbackWindowV3,
  now: number
): Promise<boolean> => {
  let atomic = kv.atomic().check(windowEntry).check(deletionGuardEntry);
  if (input.policyCheck) atomic = atomic.check(input.policyCheck);
  const transition = await atomic.set(windowKey, transitioned, { expireIn: windowExpireIn(transitioned, now) }).commit();
  return transition.ok;
};

/** Outcome for a window with no remaining exposure: blocked, or a lost CAS to retry. */
const exhaustedAdmissionV3 = async (
  kv: Kv,
  input: AdmissionInput,
  windowKey: KvKey,
  windowEntry: KvEntryMaybe<PaidFallbackWindowV3>,
  deletionGuardEntry: KvEntryMaybe<PaidFallbackDeletionGuardV3>,
  transitioned: PaidFallbackWindowV3,
  policyChanged: boolean,
  now: number
): Promise<AdmissionDecision | null> => {
  if (!policyChanged) return { kind: "blocked", reason: "limit_exceeded" };
  const transitionedPolicy = await commitExhaustedPolicyTransitionV3(kv, input, windowKey, windowEntry, deletionGuardEntry, transitioned, now);
  return transitionedPolicy ? { kind: "blocked", reason: "limit_exceeded" } : null;
};

/** Reads the current rows and decides what this admission attempt should do. */
const decidePaidFallbackAdmissionV3 = async (
  kv: Kv,
  input: AdmissionInput,
  unlimited: boolean,
  maximumExposure: number | null
): Promise<AdmissionDecision | null> => {
  const requestKey = paidFallbackRequestV3Key(input.keyId, input.requestId);
  const pendingKey = paidFallbackPendingV3Key(input.keyId, input.requestId);
  const windowKey = paidFallbackWindowV3Key(input.keyId, input.windowResetAtMs);
  const gateKey = paidFallbackReconciliationGateV3Key();

  const [requestEntry, windowEntry, deletionGuardEntry] = await Promise.all([
    kv.get<PaidFallbackRequestV3>(requestKey, { consistency: "strong" }),
    unlimited
      ? Promise.resolve({ key: windowKey, value: null, versionstamp: null } as KvEntryMaybe<PaidFallbackWindowV3>)
      : kv.get<PaidFallbackWindowV3>(windowKey, { consistency: "strong" }),
    kv.get<PaidFallbackDeletionGuardV3>(paidFallbackDeletionGuardV3Key(input.keyId), {
      consistency: "strong",
    }),
  ]);
  if (deletionGuardEntry.value) return { kind: "blocked", reason: "invalid_policy" };
  const existing = requestEntry.value;
  if (existing) {
    // A request row may only be reused while its billing contract still allows
    // settlement. `settled` and `not_billed` are the ledger's unbillable states
    // (the negation of `isBillableRequestV3`), so re-admitting one would
    // dispatch new paid work that settlement must then refuse to record.
    if (existing.billing_state === "settled" || existing.billing_state === "not_billed") {
      return { kind: "blocked", reason: "invalid_policy" };
    }
    return { kind: "reserved", reservation: existingReservationV3(input, existing) };
  }
  const current: PaidFallbackWindowV3 = windowEntry.value ?? defaultPaidFallbackWindowV3(input);
  const now = Date.now();
  const policyChanged = !unlimited && (current.policy_version !== input.policyVersion || current.limit_microcredits !== input.limitMicrocredits);
  const transitioned = policyChanged
    ? {
        ...current,
        policy_version: input.policyVersion,
        limit_microcredits: input.limitMicrocredits,
        updated_at_ms: now,
      }
    : current;
  const remaining = unlimited ? 0 : transitioned.limit_microcredits - transitioned.settled_microcredits - transitioned.reserved_microcredits;
  if (!unlimited && remaining <= 0) {
    return await exhaustedAdmissionV3(kv, input, windowKey, windowEntry, deletionGuardEntry, transitioned, policyChanged, now);
  }
  return {
    kind: "write",
    context: {
      unlimited,
      requestKey,
      pendingKey,
      windowKey,
      gateKey,
      requestEntry,
      windowEntry,
      deletionGuardEntry,
      transitioned,
      reservation: unlimited ? 0 : Math.min(remaining, maximumExposure ?? 0),
      now,
    },
  };
};

/** Writes one reservation; returns the admission, or `null` when the CAS lost. */
const writePaidFallbackAdmissionV3 = async (kv: Kv, input: AdmissionInput, context: AdmissionWriteContext): Promise<PaidFallbackAdmissionV3 | null> => {
  const { unlimited, requestKey, pendingKey, windowKey, gateKey, requestEntry, windowEntry, deletionGuardEntry, transitioned, reservation, now } = context;
  const request = buildPaidFallbackRequestV3(input, reservation, now);
  const gateEntry = input.dispatchIntent ? await kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" }) : null;
  let atomic = kv.atomic().check(requestEntry).check(deletionGuardEntry);
  if (input.policyCheck) atomic = atomic.check(input.policyCheck);
  atomic = atomic.set(requestKey, request, { expireIn: requestRowExpireIn(request, now) }).set(pendingKey, {
    created_at_ms: now,
    next_reconciliation_at_ms: now,
  } satisfies PaidFallbackPendingV3);
  if (gateEntry) {
    // A dispatch-intent admission creates a new billable marker. Always
    // advance the gate version with it so a concurrent recompute cannot
    // publish a scan that predates this marker.
    atomic = atomic.check(gateEntry).set(gateKey, paidFallbackReconciliationGateDueNow(gateEntry, now));
  }
  if (!unlimited) {
    atomic = atomic.check(windowEntry).set(
      windowKey,
      {
        ...transitioned,
        reserved_microcredits: transitioned.reserved_microcredits + reservation,
        pending_count: transitioned.pending_count + 1,
        updated_at_ms: now,
      },
      { expireIn: windowExpireIn(transitioned, now) }
    );
  }
  const commit = await atomic.commit();
  if (!commit.ok) return null;
  return {
    key_id: input.keyId,
    request_id: input.requestId,
    created_at_ms: input.createdAtMs,
    reserved_microcredits: reservation,
    quota_per_credit: input.quotaPerCredit,
    window_reset_at_ms: input.windowResetAtMs,
    quota_used_percent: unlimited ? null : (100 * transitioned.settled_microcredits) / transitioned.limit_microcredits,
  };
};

/** Projection of an already-admitted request row back into a reservation. */
const existingReservationV3 = (input: AdmissionInput, existing: PaidFallbackRequestV3): PaidFallbackAdmissionV3 => ({
  key_id: input.keyId,
  request_id: input.requestId,
  created_at_ms: existing.created_at_ms,
  reserved_microcredits: existing.reserved_microcredits,
  quota_per_credit: input.quotaPerCredit,
  window_reset_at_ms: existing.window_reset_at_ms,
  quota_used_percent: null,
});

/** True when any admission field fails its policy validation. */
const isInvalidAdmissionPolicy = (input: AdmissionInput, unlimited: boolean, maximumExposure: number | null): boolean =>
  (!unlimited && !isPositiveSafeInteger(input.limitMicrocredits)) ||
  !Number.isSafeInteger(input.initialSettledMicrocredits) ||
  input.initialSettledMicrocredits < 0 ||
  !isPositiveSafeInteger(input.quotaPerCredit) ||
  (!unlimited && !isPositiveSafeInteger(maximumExposure));

export const admitPaidFallbackV3 = async (
  input: AdmissionInput
): Promise<
  Readonly<{ kind: "reserved"; reservation: PaidFallbackAdmissionV3 }> | Readonly<{ kind: "blocked"; reason: PaidFallbackAdmissionBlockedReason }>
> => {
  const kv = await getKv();
  if (!kv) return { kind: "blocked", reason: "invalid_policy" };
  if (!paidFallbackBackfillAttempted || paidFallbackBackfillRetryPending) schedulePaidFallbackBackfill(kv);
  const unlimited = input.limitMicrocredits === PAID_FALLBACK_NO_LIMIT;
  if (isInvalidAdmissionPolicy(input, unlimited, input.maximumExposureMicrocredits)) {
    return { kind: "blocked", reason: "invalid_policy" };
  }
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const decision = await decidePaidFallbackAdmissionV3(kv, input, unlimited, input.maximumExposureMicrocredits);
    if (decision === null) continue;
    if (decision.kind !== "write") return decision;
    const reservation = await writePaidFallbackAdmissionV3(kv, input, decision.context);
    if (reservation !== null) return { kind: "reserved", reservation };
  }
  return { kind: "blocked", reason: "concurrent_update" };
};

type PaidFallbackRequestLifecyclePatchV3 = Readonly<
  Partial<
    Pick<PaidFallbackRequestV3, "provider" | "provider_request_id" | "dispatch_state" | "terminal_state"> & {
      reconciliation_attempts?: number;
      last_reconciliation_at_ms?: number | null;
      increment_reconciliation_attempts?: boolean;
    }
  >
>;

/** Lifecycle fields one patch resolves to, before they are compared to the row. */
type ResolvedRequestLifecycleV3 = Readonly<{
  provider: PaidFallbackProvider | undefined;
  providerRequestId: string | null;
  dispatchState: PaidFallbackRequestV3["dispatch_state"];
  terminalState: PaidFallbackRequestV3["terminal_state"];
  reconciliationAttempts: number;
  lastReconciliationAtMs: number | null;
}>;

/** Resolves one lifecycle patch against the stored row. */
const resolveRequestLifecyclePatchV3 = (
  current: PaidFallbackRequestV3,
  patch: PaidFallbackRequestLifecyclePatchV3,
  now: number
): ResolvedRequestLifecycleV3 => {
  const provider = current.provider ?? patch.provider;
  const providerRequestId = current.provider_request_id ?? (patch.provider_request_id === undefined ? null : patch.provider_request_id);
  const dispatchState = current.dispatch_state === "reserved" && patch.dispatch_state !== undefined ? patch.dispatch_state : current.dispatch_state;
  const terminalState = current.terminal_state === "pending" && patch.terminal_state !== undefined ? patch.terminal_state : current.terminal_state;
  const shouldIncrementReconciliationAttempts =
    patch.increment_reconciliation_attempts && (patch.terminal_state === undefined || current.terminal_state === "pending");
  const reconciliationAttempts = shouldIncrementReconciliationAttempts
    ? current.reconciliation_attempts + 1
    : (patch.reconciliation_attempts ?? current.reconciliation_attempts);
  const lastReconciliationAtMs = shouldIncrementReconciliationAttempts ? now : (patch.last_reconciliation_at_ms ?? current.last_reconciliation_at_ms);
  return { provider, providerRequestId, dispatchState, terminalState, reconciliationAttempts, lastReconciliationAtMs };
};

/** True when a resolved patch differs from the stored row. */
const requestLifecycleChangedV3 = (current: PaidFallbackRequestV3, resolved: ResolvedRequestLifecycleV3): boolean =>
  resolved.providerRequestId !== current.provider_request_id ||
  resolved.provider !== current.provider ||
  resolved.dispatchState !== current.dispatch_state ||
  resolved.terminalState !== current.terminal_state ||
  resolved.reconciliationAttempts !== current.reconciliation_attempts ||
  resolved.lastReconciliationAtMs !== current.last_reconciliation_at_ms;

/** Builds the row a resolved lifecycle patch writes. */
const buildRequestLifecycleRowV3 = (current: PaidFallbackRequestV3, resolved: ResolvedRequestLifecycleV3, now: number): PaidFallbackRequestV3 => {
  const provider = resolved.provider;
  return {
    ...current,
    ...(provider === undefined ? {} : { provider }),
    provider_request_id: resolved.providerRequestId,
    dispatch_state: resolved.dispatchState,
    terminal_state: resolved.terminalState,
    reconciliation_attempts: resolved.reconciliationAttempts,
    last_reconciliation_at_ms: resolved.lastReconciliationAtMs,
    dispatched_at_ms: resolved.dispatchState === "dispatched" && current.dispatched_at_ms === null ? now : current.dispatched_at_ms,
    terminal_at_ms: resolved.terminalState !== "pending" && current.terminal_at_ms === null ? now : current.terminal_at_ms,
    updated_at_ms: now,
  };
};

/** Reads the reconciliation gate when a lifecycle transition must arm it. */
const loadLifecycleGateEntryV3 = async (kv: Kv, gateKey: KvKey, shouldArm: boolean): Promise<KvEntryMaybe<PaidFallbackReconciliationGateV3> | null> =>
  shouldArm ? await kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" }) : null;

export const updatePaidFallbackRequestV3 = async (reservation: PaidFallbackAdmissionV3, patch: PaidFallbackRequestLifecyclePatchV3): Promise<void> => {
  const kv = await getKv();
  if (!kv) return;
  const key = paidFallbackRequestV3Key(reservation.key_id, reservation.request_id);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<PaidFallbackRequestV3>(key, { consistency: "strong" });
    if (!entry.value) return;
    const current = entry.value;
    const now = Date.now();
    const resolved = resolveRequestLifecyclePatchV3(current, patch, now);
    if (!requestLifecycleChangedV3(current, resolved)) return;
    const dispatchBoundary = current.dispatch_state !== "dispatched" && (resolved.dispatchState === "dispatched" || resolved.providerRequestId !== null);
    const shouldArmReconciliationGate = dispatchBoundary || (current.provider_request_id === null && resolved.providerRequestId !== null);
    const gateKey = paidFallbackReconciliationGateV3Key();
    const gateEntry = await loadLifecycleGateEntryV3(kv, gateKey, shouldArmReconciliationGate);
    let atomic = kv
      .atomic()
      .check(entry)
      .set(key, buildRequestLifecycleRowV3(current, resolved, now), { expireIn: requestRowExpireIn(current, now) });
    if (gateEntry) {
      atomic = atomic.check(gateEntry);
      if (dispatchBoundary || paidFallbackReconciliationGateNeedsArm(gateEntry, now)) {
        atomic = atomic.set(gateKey, paidFallbackReconciliationGateDueNow(gateEntry, now));
      }
    }
    if ((await atomic.commit()).ok) return;
  }
  throw new Error("Paid fallback request changed concurrently.");
};

const releasePaidFallbackBeforeDispatchV3 = async (reservation: PaidFallbackAdmissionV3, allowDispatchIntent: boolean): Promise<void> => {
  const kv = await getKv();
  if (!kv) return;
  const requestKey = paidFallbackRequestV3Key(reservation.key_id, reservation.request_id);
  const pendingKey = paidFallbackPendingV3Key(reservation.key_id, reservation.request_id);
  const windowKey = paidFallbackWindowV3Key(reservation.key_id, reservation.window_reset_at_ms);
  const gateKey = paidFallbackReconciliationGateV3Key();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const [requestEntry, windowEntry, gateEntry] = await Promise.all([
      kv.get<PaidFallbackRequestV3>(requestKey, { consistency: "strong" }),
      kv.get<PaidFallbackWindowV3>(windowKey, { consistency: "strong" }),
      kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" }),
    ]);
    if (
      requestEntry.value?.billing_state !== "pending" ||
      requestEntry.value.provider_request_id !== null ||
      (requestEntry.value.dispatch_state !== "reserved" && !(allowDispatchIntent && requestEntry.value.dispatch_state === "dispatched"))
    )
      return;
    const now = Date.now();
    let atomic = kv
      .atomic()
      .check(requestEntry)
      .set(
        requestKey,
        {
          ...requestEntry.value,
          dispatch_state: "not_dispatched",
          terminal_state: "cancelled",
          spend_microcredits: 0,
          billing_state: "not_billed",
          terminal_at_ms: requestEntry.value.terminal_at_ms ?? now,
          updated_at_ms: now,
        },
        { expireIn: requestRowExpireIn(requestEntry.value, now) }
      )
      .delete(pendingKey);
    atomic = atomic.check(gateEntry);
    // Deleting a pending marker must version-bump the gate even when it is
    // already due; otherwise an overlapping recompute can publish a stale
    // future timestamp for this row.
    atomic = atomic.set(gateKey, paidFallbackReconciliationGateDueNow(gateEntry, now));
    if (windowEntry.value) {
      atomic = atomic.check(windowEntry).set(
        windowKey,
        {
          ...windowEntry.value,
          reserved_microcredits: Math.max(0, windowEntry.value.reserved_microcredits - requestEntry.value.reserved_microcredits),
          pending_count: Math.max(0, windowEntry.value.pending_count - 1),
          updated_at_ms: now,
        },
        { expireIn: windowExpireIn(windowEntry.value, now) }
      );
    }
    if ((await atomic.commit()).ok) return;
  }
  throw new Error("Paid fallback release changed concurrently.");
};

export const releaseUndispatchedPaidFallbackV3 = async (reservation: PaidFallbackAdmissionV3): Promise<void> => {
  await releasePaidFallbackBeforeDispatchV3(reservation, false);
};

/**
 * Releases a reservation after a durable dispatch intent was written but
 * before provider fetch was invoked. This must never be called once provider
 * fetch can have started.
 */
export const releasePaidFallbackBeforeProviderFetchV3 = async (reservation: PaidFallbackAdmissionV3): Promise<void> => {
  await releasePaidFallbackBeforeDispatchV3(reservation, true);
};
