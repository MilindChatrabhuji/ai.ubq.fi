import type { Kv, KvEntryMaybe, KvKey } from "#kv";
// Paid-fallback ledger v3: admission layer, split out of src/paid_fallback_ledger.ts.

import {
  planPaidFallbackAdmissionV3,
  planPaidFallbackLifecycleV3,
  planPaidFallbackReleaseV3,
  planPaidFallbackDeletionGuardV3,
  planPaidFallbackDeletionV3,
  isInvalidAdmissionPolicy,
} from "../authority/native-paid.ts";
import type { NativePaidAdmissionPlan, PaidFallbackRequestLifecyclePatchV3 } from "../authority/native-paid-contracts.ts";
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
  type PaidFallbackReconciliationGateV3,
  getPaidFallbackOutstandingV3,
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
  resolveKv,
  windowExpireIn,
} from "./ledger-state.ts";
import { type PaidFallbackRequestV3, type PaidFallbackWindowV3 } from "../types.ts";

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
    const nextGuard = planPaidFallbackDeletionGuardV3(guard.value, Date.now());
    if (!nextGuard) break;
    const commit = await kv.atomic().check(guard).set(guardKey, nextGuard).commit();
    if (commit.ok) break;
    if (attempt === MAX_CAS_ATTEMPTS - 1) {
      throw new Error("Paid fallback deletion guard changed concurrently.");
    }
  }
  const outstanding = await getPaidFallbackOutstandingV3(keyId, kv);
  const decision = planPaidFallbackDeletionV3(outstanding);
  if (decision.kind !== "delete") return decision;

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

type AdmissionWriteContext = Readonly<{
  requestKey: KvKey;
  pendingKey: KvKey;
  windowKey: KvKey;
  gateKey: KvKey;
  requestEntry: KvEntryMaybe<PaidFallbackRequestV3>;
  windowEntry: KvEntryMaybe<PaidFallbackWindowV3>;
  deletionGuardEntry: KvEntryMaybe<PaidFallbackDeletionGuardV3>;
  plan: Extract<NativePaidAdmissionPlan, { kind: "write" }>;
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
  const now = Date.now();
  const plan = planPaidFallbackAdmissionV3(
    input,
    {
      request: requestEntry,
      window: windowEntry,
      deletionGuard: deletionGuardEntry,
      ...(input.policyCheck ? { policyFence: { versionstamp: input.policyCheck.versionstamp } } : {}),
    },
    { unlimited, maximumExposure },
    now
  );
  if (plan.kind === "exhausted_policy") {
    const committed = await commitExhaustedPolicyTransitionV3(kv, input, windowKey, windowEntry, deletionGuardEntry, plan.window, now);
    return committed ? { kind: "blocked", reason: "limit_exceeded" } : null;
  }
  if (plan.kind !== "write") return plan;
  return { kind: "write", context: { requestKey, pendingKey, windowKey, gateKey, requestEntry, windowEntry, deletionGuardEntry, plan, now } };
};

/** Writes one reservation; returns the admission, or `null` when the CAS lost. */
const writePaidFallbackAdmissionV3 = async (kv: Kv, input: AdmissionInput, context: AdmissionWriteContext): Promise<PaidFallbackAdmissionV3 | null> => {
  const { requestKey, pendingKey, windowKey, gateKey, requestEntry, windowEntry, deletionGuardEntry, plan, now } = context;
  const gateEntry = plan.checkGate ? await kv.get<PaidFallbackReconciliationGateV3>(gateKey, { consistency: "strong" }) : null;
  let atomic = kv.atomic().check(requestEntry).check(deletionGuardEntry);
  if (input.policyCheck) atomic = atomic.check(input.policyCheck);
  atomic = atomic.set(requestKey, plan.request, { expireIn: plan.requestExpireIn }).set(pendingKey, plan.pending);
  if (gateEntry) atomic = atomic.check(gateEntry).set(gateKey, paidFallbackReconciliationGateDueNow(gateEntry, now));
  if (plan.window) atomic = atomic.check(windowEntry).set(windowKey, plan.window, { expireIn: windowExpireIn(plan.window, now) });
  if (!(await atomic.commit()).ok) return null;
  return plan.reservation;
};

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
    const plan = planPaidFallbackLifecycleV3(current, patch, now);
    if (!plan) return;
    const gateKey = paidFallbackReconciliationGateV3Key();
    const gateEntry = await loadLifecycleGateEntryV3(kv, gateKey, plan.readGate);
    let atomic = kv.atomic().check(entry).set(key, plan.request, { expireIn: plan.requestExpireIn });
    if (gateEntry) {
      atomic = atomic.check(gateEntry);
      if (plan.dispatchBoundary || paidFallbackReconciliationGateNeedsArm(gateEntry, now)) {
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
    const now = Date.now();
    const plan = planPaidFallbackReleaseV3({ request: requestEntry, window: windowEntry, gate: gateEntry }, allowDispatchIntent, now);
    if (!plan) return;
    let atomic = kv.atomic().check(requestEntry).set(requestKey, plan.request, { expireIn: plan.requestExpireIn }).delete(pendingKey);
    // Removing a marker always versions G, including when G is already due.
    atomic = atomic.check(gateEntry).set(gateKey, plan.gate);
    if (plan.window) atomic = atomic.check(windowEntry).set(windowKey, plan.window, { expireIn: windowExpireIn(plan.window, now) });
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
