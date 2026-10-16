import type { Kv, KvEntry, KvEntryMaybe, KvKey } from "#kv";
// Kernel quota v2 reservations and settlement, split out of src/kernel_quota_v2.ts.

import { openaiError } from "../http.ts";
import { getKv } from "../kv.ts";
import { isRecord } from "../utils.ts";
import {
  KERNEL_DEFAULT_WINDOW_CUTOVER_LEASE_MS,
  KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY,
  KERNEL_ORG_RESERVATION_V2_PREFIX,
  KERNEL_ORG_WINDOW_V2_PREFIX,
  KERNEL_QUOTA_RESERVATION_LEASE_MS,
  KERNEL_QUOTA_RESERVATION_RENEWAL_MS,
  KERNEL_QUOTA_RESERVATION_RETENTION_MS,
  KERNEL_QUOTA_SETTLEMENT_RETRY_MS,
  KERNEL_REPO_RESERVATION_V2_PREFIX,
  KERNEL_REPO_WINDOW_V2_PREFIX,
  type KernelDefaultWindowCutoverDecision,
  type KernelDefaultWindowCutoverGuard,
  type KernelDefaultWindowCutoverV2,
  type KernelQuotaPolicyStateDecision,
  type KernelQuotaPolicyV2,
  type KernelQuotaReservation,
  type KernelQuotaReservationDecision,
  type KernelQuotaReservationRowV2,
  type KernelQuotaScope,
  type KernelQuotaWindowV2,
  MAX_KV_RETRIES,
  hasLiveKernelReservations,
  kernelOrgPolicyKey,
  kernelOrgReservationKey,
  kernelRepoPart,
  kernelRepoPolicyKey,
  kernelRepoReservationKey,
  kernelScopedPolicyKey,
  kernelScopedWindowKey,
  nonNegativeSafeInteger,
  normalizeKernelQuotaPolicyV2,
  normalizeKernelQuotaWindowV2,
  positiveSafeInteger,
  validIdentity,
} from "./quota-v2.ts";

const kernelQuotaUnavailableResponse = (message = "Kernel quota is unavailable"): Response =>
  openaiError(503, message, "server_error", { type: "server_error" });

const kernelQuotaUnavailable = (message = "Kernel quota is unavailable"): KernelQuotaReservationDecision => ({
  ok: false,
  response: kernelQuotaUnavailableResponse(message),
});

const readKernelQuotaPolicyState = async (
  kv: Kv,
  owner: string,
  repo: string
): Promise<
  Readonly<{
    limit_scope: KernelQuotaScope;
    has_policy: boolean;
    repo_entry: KvEntryMaybe<KernelQuotaPolicyV2>;
    org_entry: KvEntryMaybe<KernelQuotaPolicyV2>;
  }>
> => {
  const [repoEntry, orgEntry] = await Promise.all([
    kv.get<KernelQuotaPolicyV2>(kernelRepoPolicyKey(owner, repo), { consistency: "strong" }),
    kv.get<KernelQuotaPolicyV2>(kernelOrgPolicyKey(owner), { consistency: "strong" }),
  ]);
  if (repoEntry.value !== null && !normalizeKernelQuotaPolicyV2(repoEntry.value, "repo", owner, repo)) {
    throw new Error("Kernel repo quota policy is malformed");
  }
  if (orgEntry.value !== null && !normalizeKernelQuotaPolicyV2(orgEntry.value, "org", owner, undefined)) {
    throw new Error("Kernel org quota policy is malformed");
  }
  if (repoEntry.value !== null) {
    return { limit_scope: "repo", has_policy: true, repo_entry: repoEntry, org_entry: orgEntry };
  }
  return {
    limit_scope: "org",
    has_policy: orgEntry.value !== null,
    repo_entry: repoEntry,
    org_entry: orgEntry,
  };
};

export const resolveKernelQuotaPolicyState = async (
  owner: string,
  repo: string,
  options: Readonly<{ kv?: Kv | null }> = {}
): Promise<KernelQuotaPolicyStateDecision> => {
  try {
    const kv = options.kv === undefined ? await getKv() : options.kv;
    if (!kv) return { ok: false, response: kernelQuotaUnavailableResponse() };
    const state = await readKernelQuotaPolicyState(kv, owner, repo);
    return { ok: true, limit_scope: state.limit_scope, has_policy: state.has_policy };
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to resolve kernel quota policy scope:", error);
    return { ok: false, response: kernelQuotaUnavailableResponse() };
  }
};

const kernelReservationRetentionMs = (windowResetAtMs: number, nowMs: number): number =>
  Math.max(1, windowResetAtMs + KERNEL_QUOTA_RESERVATION_RETENTION_MS - nowMs);

const kernelReservationKey = (scope: KernelQuotaScope, owner: string, repo: string | undefined, windowCreatedAtMs: number, requestId: string): KvKey =>
  scope === "repo"
    ? kernelRepoReservationKey(owner, kernelRepoPart(repo), windowCreatedAtMs, requestId)
    : kernelOrgReservationKey(owner, windowCreatedAtMs, requestId);

const kernelReservationWindowPrefix = (scope: KernelQuotaScope, owner: string, repo: string | undefined, windowCreatedAtMs: number): KvKey =>
  scope === "repo"
    ? [...KERNEL_REPO_RESERVATION_V2_PREFIX, owner, kernelRepoPart(repo), windowCreatedAtMs]
    : [...KERNEL_ORG_RESERVATION_V2_PREFIX, owner, windowCreatedAtMs];

export const normalizeKernelQuotaReservationRowV2 = (
  value: unknown,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined
): KernelQuotaReservationRowV2 | null => {
  if (!isRecord(value) || !validIdentity(scope, owner, repo, value)) return null;
  const terminalIntent = value.terminal_intent === undefined ? null : value.terminal_intent;
  if (
    typeof value.request_id !== "string" ||
    !value.request_id ||
    typeof value.route !== "string" ||
    !value.route ||
    !nonNegativeSafeInteger(value.window_created_at_ms) ||
    !positiveSafeInteger(value.window_reset_at_ms) ||
    (value.state !== "reserved" && value.state !== "committed" && value.state !== "released") ||
    (terminalIntent !== null && terminalIntent !== "committed" && terminalIntent !== "released") ||
    !nonNegativeSafeInteger(value.reserved_at_ms) ||
    !positiveSafeInteger(value.lease_expires_at_ms) ||
    !(value.committed_at_ms === null || nonNegativeSafeInteger(value.committed_at_ms)) ||
    !(value.released_at_ms === null || nonNegativeSafeInteger(value.released_at_ms)) ||
    !(value.release_reason === null || typeof value.release_reason === "string")
  )
    return null;
  if (
    value.window_reset_at_ms <= value.window_created_at_ms ||
    value.lease_expires_at_ms <= value.reserved_at_ms
  )
    return null;
  if (
    (value.state === "reserved" && (value.committed_at_ms !== null || value.released_at_ms !== null || value.release_reason !== null)) ||
    (value.state === "committed" &&
      (value.committed_at_ms === null || value.released_at_ms !== null || value.release_reason !== null || terminalIntent === "released")) ||
    (value.state === "released" &&
      (value.committed_at_ms !== null ||
        value.released_at_ms === null ||
        typeof value.release_reason !== "string" ||
        value.release_reason.trim() === "" ||
        terminalIntent === "committed"))
  )
    return null;
  return { ...value, terminal_intent: terminalIntent } as KernelQuotaReservationRowV2;
};

/**
 * True when the stored row is the reservation this request owns, identified by its
 * request id, route, and window.
 */
const kernelReservationMatchesRequest = (
  reservation: KernelQuotaReservationRowV2 | null,
  requestId: string,
  route: string,
  windowCreatedAtMs: number
): reservation is KernelQuotaReservationRowV2 =>
  reservation !== null && reservation.request_id === requestId && reservation.route === route && reservation.window_created_at_ms === windowCreatedAtMs;

/**
 * Reads one reservation row from a listing. A row whose key, request id, or window
 * disagrees with the listing is malformed rather than merely unknown.
 */
const requireKernelReservationRow = (
  key: KvKey,
  value: unknown,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  windowCreatedAtMs: number
): KernelQuotaReservationRowV2 => {
  const reservation = normalizeKernelQuotaReservationRowV2(value, scope, owner, repo);
  const requestId = key.at(-1);
  if (!reservation || typeof requestId !== "string" || requestId !== reservation.request_id || reservation.window_created_at_ms !== windowCreatedAtMs) {
    throw new Error("Kernel quota reservation is malformed");
  }
  return reservation;
};

/**
 * Repair the reservation aggregate after a pre-reservation writer rewrites a
 * window without the new field. The window CAS at every mutating caller makes
 * the row count stable for admission: reservation cardinality changes always
 * update the same window atomically, while lease-only row updates do not.
 */
export const reconcileKernelQuotaWindowReservations = async (
  kv: Kv,
  entry: KvEntryMaybe<KernelQuotaWindowV2>,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined
): Promise<KernelQuotaWindowV2 | null> => {
  const window = normalizeKernelQuotaWindowV2(entry.value, scope, owner, repo);
  if (!window || (isRecord(entry.value) && Object.hasOwn(entry.value, "reserved_requests"))) return window;
  let reservedRequests = 0;
  const prefix = kernelReservationWindowPrefix(scope, owner, repo, window.created_at_ms);
  for await (const reservationEntry of kv.list<KernelQuotaReservationRowV2>({ prefix }, { consistency: "strong" })) {
    const reservation = requireKernelReservationRow(reservationEntry.key, reservationEntry.value, scope, owner, repo, window.created_at_ms);
    if (reservation.state === "reserved") reservedRequests += 1;
  }
  return { ...window, reserved_requests: reservedRequests };
};

const kernelQuotaLocks = new Map<string, Promise<void>>();

const withKernelQuotaLock = async <T>(scope: KernelQuotaScope, owner: string, repo: string | undefined, operation: () => Promise<T>): Promise<T> => {
  const lockKey = JSON.stringify(kernelScopedWindowKey(scope, owner, repo));
  const previous = kernelQuotaLocks.get(lockKey);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  kernelQuotaLocks.set(lockKey, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (kernelQuotaLocks.get(lockKey) === current) kernelQuotaLocks.delete(lockKey);
  }
};

type KernelReservationSettlement = "settled" | "terminal_mismatch" | "missing" | "invalid" | "conflict";

/**
 * Terminal-state precondition for a known reservation row: a row owned by another
 * request is invalid, an already-terminal row is settled or mismatched.
 */
const kernelReservationPrecondition = (
  reservation: KernelQuotaReservationRowV2,
  requestId: string,
  route: string,
  windowCreatedAtMs: number,
  terminalState: "committed" | "released"
): KernelReservationSettlement | null => {
  if (!kernelReservationMatchesRequest(reservation, requestId, route, windowCreatedAtMs)) return "invalid";
  if (reservation.state !== "reserved") return reservation.state === terminalState ? "settled" : "terminal_mismatch";
  if (reservation.terminal_intent !== null && reservation.terminal_intent !== terminalState) return "terminal_mismatch";
  return null;
};

/** Builds the terminal row of a settled reservation, mirroring the terminal state. */
const settledKernelReservationRow = (
  reservation: KernelQuotaReservationRowV2,
  terminalState: "committed" | "released",
  reason: string,
  nowMs: number
): KernelQuotaReservationRowV2 =>
  terminalState === "committed"
    ? { ...reservation, state: "committed", terminal_intent: "committed", committed_at_ms: nowMs }
    : {
        ...reservation,
        state: "released",
        terminal_intent: "released",
        released_at_ms: nowMs,
        release_reason: reason.slice(0, 120) || "request_incomplete",
      };

const recordKernelReservationTerminalIntentUnlocked = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  windowCreatedAtMs: number,
  requestId: string,
  route: string,
  terminalState: "committed" | "released",
  nowMs: number
): Promise<KernelReservationSettlement | number> => {
  const reservationKey = kernelReservationKey(scope, owner, repo, windowCreatedAtMs, requestId);
  const reservationEntry = await kv.get<KernelQuotaReservationRowV2>(reservationKey, { consistency: "strong" });
  const reservation = normalizeKernelQuotaReservationRowV2(reservationEntry.value, scope, owner, repo);
  if (!reservation) return reservationEntry.value === null ? "missing" : "invalid";
  const precondition = kernelReservationPrecondition(reservation, requestId, route, windowCreatedAtMs, terminalState);
  if (precondition) return precondition;
  const leaseExpiresAtMs = nowMs + KERNEL_QUOTA_RESERVATION_LEASE_MS;
  const pendingReservation: KernelQuotaReservationRowV2 = {
    ...reservation,
    terminal_intent: terminalState,
    lease_expires_at_ms: leaseExpiresAtMs,
  };
  const committed = await kv
    .atomic()
    .check(reservationEntry)
    .set(reservationKey, pendingReservation, {
      expireIn: kernelReservationRetentionMs(reservation.window_reset_at_ms, nowMs),
    })
    .commit();
  return committed.ok ? leaseExpiresAtMs : "conflict";
};

/**
 * One attempt at recording the terminal intent: the lease expiry when the intent
 * was written, null when it was already settled, "retry" on a lost compare-and-set.
 */
const attemptRecordKernelReservationTerminalIntent = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  windowCreatedAtMs: number,
  requestId: string,
  route: string,
  terminalState: "committed" | "released",
  nowMs: number
): Promise<number | null | "retry"> => {
  const outcome = await recordKernelReservationTerminalIntentUnlocked(kv, scope, owner, repo, windowCreatedAtMs, requestId, route, terminalState, nowMs);
  if (typeof outcome === "number") return outcome;
  if (outcome === "settled") return null;
  if (outcome === "conflict") return "retry";
  if (outcome === "terminal_mismatch") {
    throw new Error(`Kernel quota reservation was already ${terminalState === "committed" ? "released" : "committed"}`);
  }
  throw new Error(outcome === "missing" ? "Kernel quota reservation is missing" : "Kernel quota reservation is malformed");
};

const recordKernelReservationTerminalIntent = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  windowCreatedAtMs: number,
  requestId: string,
  route: string,
  terminalState: "committed" | "released"
): Promise<number | null> =>
  await withKernelQuotaLock(scope, owner, repo, async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_KV_RETRIES; attempt += 1) {
      try {
        const outcome = await attemptRecordKernelReservationTerminalIntent(
          kv,
          scope,
          owner,
          repo,
          windowCreatedAtMs,
          requestId,
          route,
          terminalState,
          Date.now()
        );
        if (outcome !== "retry") return outcome;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("Kernel quota reservation terminal intent could not be recorded", { cause: lastError });
  });

const settleKernelReservationUnlocked = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  windowCreatedAtMs: number,
  requestId: string,
  route: string,
  terminalState: "committed" | "released",
  reason: string,
  nowMs: number
): Promise<KernelReservationSettlement> => {
  const windowKey = kernelScopedWindowKey(scope, owner, repo);
  const reservationKey = kernelReservationKey(scope, owner, repo, windowCreatedAtMs, requestId);
  const [windowEntry, reservationEntry] = await Promise.all([
    kv.get<KernelQuotaWindowV2>(windowKey, { consistency: "strong" }),
    kv.get<KernelQuotaReservationRowV2>(reservationKey, { consistency: "strong" }),
  ]);
  const reservation = normalizeKernelQuotaReservationRowV2(reservationEntry.value, scope, owner, repo);
  if (!reservation) return reservationEntry.value === null ? "missing" : "invalid";
  const precondition = kernelReservationPrecondition(reservation, requestId, route, windowCreatedAtMs, terminalState);
  if (precondition) return precondition;

  const normalizedWindow = await reconcileKernelQuotaWindowReservations(kv, windowEntry, scope, owner, repo);
  if (windowEntry.value !== null && !normalizedWindow) return "invalid";
  const retentionMs = kernelReservationRetentionMs(reservation.window_reset_at_ms, nowMs);
  if (normalizedWindow?.created_at_ms !== reservation.window_created_at_ms) {
    const settledReservation = settledKernelReservationRow(reservation, terminalState, reason, nowMs);
    const committed = await kv.atomic().check(windowEntry).check(reservationEntry).set(reservationKey, settledReservation, { expireIn: retentionMs }).commit();
    return committed.ok ? "settled" : "conflict";
  }
  if (normalizedWindow.reserved_requests < 1) return "invalid";

  const updatedWindow: KernelQuotaWindowV2 = {
    ...normalizedWindow,
    usage_requests: normalizedWindow.usage_requests + (terminalState === "committed" ? 1 : 0),
    reserved_requests: normalizedWindow.reserved_requests - 1,
    updated_at_ms: nowMs,
  };
  const settledReservation = settledKernelReservationRow(reservation, terminalState, reason, nowMs);
  const committed = await kv
    .atomic()
    .check(windowEntry)
    .check(reservationEntry)
    .set(windowKey, updatedWindow, { expireIn: retentionMs })
    .set(reservationKey, settledReservation, { expireIn: retentionMs })
    .commit();
  return committed.ok ? "settled" : "conflict";
};

const settleKernelReservation = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  windowCreatedAtMs: number,
  requestId: string,
  route: string,
  terminalState: "committed" | "released",
  reason: string
): Promise<void> => {
  await withKernelQuotaLock(scope, owner, repo, async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_KV_RETRIES; attempt += 1) {
      try {
        const outcome = await settleKernelReservationUnlocked(kv, scope, owner, repo, windowCreatedAtMs, requestId, route, terminalState, reason, Date.now());
        if (outcome === "settled") return;
        if (outcome === "conflict") continue;
        if (outcome === "terminal_mismatch") {
          throw new Error(`Kernel quota reservation was already ${terminalState === "committed" ? "released" : "committed"}`);
        }
        throw new Error(outcome === "missing" ? "Kernel quota reservation is missing" : "Kernel quota reservation is malformed");
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("Kernel quota reservation could not be settled", { cause: lastError });
  });
};

const renewKernelReservation = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  windowCreatedAtMs: number,
  requestId: string,
  route: string
): Promise<number> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_KV_RETRIES; attempt += 1) {
    try {
      const reservationKey = kernelReservationKey(scope, owner, repo, windowCreatedAtMs, requestId);
      const entry = await kv.get<KernelQuotaReservationRowV2>(reservationKey, { consistency: "strong" });
      const reservation = normalizeKernelQuotaReservationRowV2(entry.value, scope, owner, repo);
      if (!kernelReservationMatchesRequest(reservation, requestId, route, windowCreatedAtMs)) {
        throw new Error("Kernel quota reservation is missing or malformed");
      }
      if (reservation.state !== "reserved") {
        throw new Error(`Kernel quota reservation was already ${reservation.state}`);
      }
      const nowMs = Date.now();
      const leaseExpiresAtMs = nowMs + KERNEL_QUOTA_RESERVATION_LEASE_MS;
      const renewed: KernelQuotaReservationRowV2 = {
        ...reservation,
        lease_expires_at_ms: leaseExpiresAtMs,
      };
      const committed = await kv
        .atomic()
        .check(entry)
        .set(reservationKey, renewed, {
          expireIn: kernelReservationRetentionMs(reservation.window_reset_at_ms, nowMs),
        })
        .commit();
      if (committed.ok) return leaseExpiresAtMs;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Kernel quota reservation lease could not be renewed", { cause: lastError });
};

/**
 * Timer handles of the reservation lease. Each slot is optional because the
 * matching timer is absent before it is first scheduled and after it is cleared.
 */
type KernelQuotaTimerSlots = {
  renewal?: ReturnType<typeof setInterval>;
  leaseExpiry?: ReturnType<typeof setTimeout>;
  settlementRetry?: ReturnType<typeof setTimeout>;
};

const kernelReservationContext = (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  windowCreatedAtMs: number,
  requestId: string,
  route: string,
  initialLeaseExpiresAtMs: number,
  renewalIntervalMs = KERNEL_QUOTA_RESERVATION_RENEWAL_MS
): KernelQuotaReservation => {
  const leaseAbort = new AbortController();
  let leaseExpiresAtMs = initialLeaseExpiresAtMs;
  let renewalInFlight: Promise<void> | null = null;
  let terminalIntent: "committed" | "released" | null = null;
  let terminalReason = "request_incomplete";
  let terminalSettled: "committed" | "released" | null = null;
  let terminalInFlight: Promise<void> | null = null;
  const timers: KernelQuotaTimerSlots = {};
  let settlementRetryDelayMs = KERNEL_QUOTA_SETTLEMENT_RETRY_MS;
  const stopRenewal = (): void => {
    if (timers.renewal === undefined) return;
    clearInterval(timers.renewal);
    timers.renewal = undefined;
  };
  const clearLeaseExpiry = (): void => {
    if (timers.leaseExpiry === undefined) return;
    clearTimeout(timers.leaseExpiry);
    timers.leaseExpiry = undefined;
  };
  const stopAfterSettlement = (): void => {
    stopRenewal();
    clearLeaseExpiry();
    if (timers.settlementRetry !== undefined) {
      clearTimeout(timers.settlementRetry);
      timers.settlementRetry = undefined;
    }
  };
  const scheduleLeaseExpiry = (): void => {
    clearLeaseExpiry();
    if (terminalSettled) return;
    timers.leaseExpiry = setTimeout(
      () => {
        timers.leaseExpiry = undefined;
        if (terminalSettled) return;
        if (Date.now() < leaseExpiresAtMs) {
          scheduleLeaseExpiry();
          return;
        }
        if (!leaseAbort.signal.aborted) {
          leaseAbort.abort(new DOMException("Kernel quota reservation lease expired", "TimeoutError"));
        }
        // A terminal intent still needs lease renewal and durable settlement.
        // For in-flight inference, abort is the fail-closed terminal condition.
        if (!terminalIntent) stopRenewal();
      },
      Math.max(1, leaseExpiresAtMs - Date.now())
    );
  };
  const updateLease = (nextLeaseExpiresAtMs: number): void => {
    leaseExpiresAtMs = nextLeaseExpiresAtMs;
    scheduleLeaseExpiry();
  };
  const renew = (): void => {
    if (terminalSettled || renewalInFlight) return;
    const current = renewKernelReservation(kv, scope, owner, repo, windowCreatedAtMs, requestId, route)
      .then((nextLeaseExpiresAtMs) => {
        updateLease(nextLeaseExpiresAtMs);
      })
      .catch((error: unknown) => {
        console.warn("[ai.ubq.fi] Failed to renew kernel quota reservation lease:", error);
      })
      .finally(() => {
        if (renewalInFlight === current) renewalInFlight = null;
      });
    renewalInFlight = current;
  };
  timers.renewal = setInterval(renew, renewalIntervalMs);
  scheduleLeaseExpiry();
  const scheduleSettlementRetry = (): void => {
    if (terminalSettled || timers.settlementRetry !== undefined) return;
    const delayMs = settlementRetryDelayMs;
    settlementRetryDelayMs = Math.min(settlementRetryDelayMs * 2, 30_000);
    timers.settlementRetry = setTimeout(() => {
      timers.settlementRetry = undefined;
      void launchSettlement().catch((error: unknown) => {
        console.warn("[ai.ubq.fi] Failed to settle kernel quota reservation; retrying:", error);
      });
    }, delayMs);
  };
  function launchSettlement(): Promise<void> {
    if (!terminalIntent) return Promise.reject(new Error("Kernel quota reservation has no terminal state"));
    if (terminalSettled === terminalIntent) return Promise.resolve();
    if (terminalInFlight) return terminalInFlight;
    const state = terminalIntent;
    const current = (async () => {
      const nextLeaseExpiresAtMs = await recordKernelReservationTerminalIntent(kv, scope, owner, repo, windowCreatedAtMs, requestId, route, state);
      if (nextLeaseExpiresAtMs !== null) updateLease(nextLeaseExpiresAtMs);
      await settleKernelReservation(kv, scope, owner, repo, windowCreatedAtMs, requestId, route, state, terminalReason);
    })()
      .then(() => {
        terminalSettled = state;
        stopAfterSettlement();
      })
      .catch((error: unknown) => {
        scheduleSettlementRetry();
        throw error;
      })
      .finally(() => {
        if (terminalInFlight === current) terminalInFlight = null;
      });
    terminalInFlight = current;
    return current;
  }
  const settle = (state: "committed" | "released", reason: string): Promise<void> => {
    if (terminalIntent === null) {
      terminalIntent = state;
      terminalReason = state === "committed" ? "completed" : reason;
    }
    if (terminalIntent !== state) {
      return Promise.reject(new Error(`Kernel quota reservation terminal state is already ${terminalIntent}`));
    }
    if (terminalSettled === state) return Promise.resolve();
    return launchSettlement();
  };
  return {
    signal: leaseAbort.signal,
    commit: () => settle("committed", "completed"),
    release: (reason = "request_incomplete") => settle("released", reason),
  };
};

/**
 * Settles one expired reservation. Returns true once the row is terminal; when
 * every attempt loses its compare-and-set the caller moves on to the next row.
 */
const settleExpiredKernelReservation = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  window: KernelQuotaWindowV2,
  reservation: KernelQuotaReservationRowV2,
  terminalState: "committed" | "released",
  nowMs: number
): Promise<boolean> => {
  for (let attempt = 0; attempt < MAX_KV_RETRIES; attempt += 1) {
    const outcome = await settleKernelReservationUnlocked(
      kv,
      scope,
      owner,
      repo,
      window.created_at_ms,
      reservation.request_id,
      reservation.route,
      terminalState,
      terminalState === "committed" ? "completed" : "lease_expired",
      nowMs
    );
    if (outcome === "conflict") continue;
    if (outcome === "invalid") throw new Error("Kernel quota reservation is malformed");
    return true;
  }
  return false;
};

const reclaimExpiredKernelReservationUnlocked = async (
  kv: Kv,
  scope: KernelQuotaScope,
  owner: string,
  repo: string | undefined,
  window: KernelQuotaWindowV2,
  nowMs: number
): Promise<boolean> => {
  let sawExpired = false;
  const prefix = kernelReservationWindowPrefix(scope, owner, repo, window.created_at_ms);
  for await (const entry of kv.list<KernelQuotaReservationRowV2>({ prefix }, { consistency: "strong" })) {
    const reservation = requireKernelReservationRow(entry.key, entry.value, scope, owner, repo, window.created_at_ms);
    if (reservation.state !== "reserved" || reservation.lease_expires_at_ms > nowMs) continue;
    sawExpired = true;
    const terminalState = reservation.terminal_intent ?? "released";
    if (await settleExpiredKernelReservation(kv, scope, owner, repo, window, reservation, terminalState, nowMs)) return true;
  }
  if (sawExpired) throw new Error("Kernel quota reservation changed concurrently");
  return false;
};

const normalizeKernelDefaultWindowCutoverV2 = (value: unknown): KernelDefaultWindowCutoverV2 | null => {
  if (
    !isRecord(value) ||
    value.v !== 2 ||
    typeof value.id !== "string" ||
    !value.id ||
    !nonNegativeSafeInteger(value.created_at_ms) ||
    !positiveSafeInteger(value.expires_at_ms) ||
    value.expires_at_ms <= value.created_at_ms
  )
    return null;
  return value as KernelDefaultWindowCutoverV2;
};

/** Owner and repo encoded in a listed window key, validated against the scope. */
const kernelWindowScopeTarget = (scope: KernelQuotaScope, key: KvKey, prefix: readonly string[]): Readonly<{ owner: string; repo: string | undefined }> => {
  const ownerPart = key[prefix.length];
  if (typeof ownerPart !== "string" || !ownerPart) throw new Error("Kernel quota window key is malformed");
  const repoPart = key[prefix.length + 1];
  const repo = scope === "repo" && typeof repoPart === "string" && repoPart ? repoPart : undefined;
  if (scope === "repo" && !repo) throw new Error("Kernel repo quota window key is malformed");
  return { owner: ownerPart, repo };
};

/** True when the scope has an explicit policy, which supersedes the defaults. */
const kernelScopeHasPolicy = async (kv: Kv, scope: KernelQuotaScope, owner: string, repo: string | undefined): Promise<boolean> => {
  const policyEntry = await kv.get<KernelQuotaPolicyV2>(kernelScopedPolicyKey(scope, owner, repo), { consistency: "strong" });
  if (policyEntry.value === null) return false;
  if (!normalizeKernelQuotaPolicyV2(policyEntry.value, scope, owner, repo)) {
    throw new Error("Kernel quota policy is malformed");
  }
  return true;
};

/** True when the scope window holds reservations that have not yet expired. */
const kernelWindowHasLiveReservations = async (kv: Kv, scope: KernelQuotaScope, owner: string, repo: string | undefined): Promise<boolean> => {
  const windowKey = kernelScopedWindowKey(scope, owner, repo);
  for (let attempt = 0; attempt < MAX_KV_RETRIES; attempt += 1) {
    const nowMs = Date.now();
    const windowEntry = await kv.get<KernelQuotaWindowV2>(windowKey, { consistency: "strong" });
    const window = await reconcileKernelQuotaWindowReservations(kv, windowEntry, scope, owner, repo);
    if (windowEntry.value !== null && !window) throw new Error("Kernel quota window is malformed");
    if (!hasLiveKernelReservations(window, nowMs)) return false;
    if (!(await reclaimExpiredKernelReservationUnlocked(kv, scope, owner, repo, window, nowMs))) return true;
  }
  throw new Error("Kernel quota reservations changed concurrently");
};

const hasLiveDefaultBackedKernelReservations = async (kv: Kv): Promise<boolean> => {
  for (const scope of ["repo", "org"] as const) {
    const prefix = scope === "repo" ? KERNEL_REPO_WINDOW_V2_PREFIX : KERNEL_ORG_WINDOW_V2_PREFIX;
    for await (const listedEntry of kv.list<KernelQuotaWindowV2>({ prefix }, { consistency: "strong" })) {
      const { owner, repo } = kernelWindowScopeTarget(scope, listedEntry.key, prefix);
      const hasLive = await withKernelQuotaLock(scope, owner, repo, async () => {
        if (await kernelScopeHasPolicy(kv, scope, owner, repo)) return false;
        return await kernelWindowHasLiveReservations(kv, scope, owner, repo);
      });
      if (hasLive) return true;
    }
  }
  return false;
};

export const releaseKernelDefaultWindowCutover = async (kv: Kv, guard: KernelDefaultWindowCutoverGuard): Promise<void> => {
  try {
    await kv.atomic().check(guard.entry).delete(guard.key).commit();
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to release Kernel default-window cutover guard:", error);
  }
};

export const acquireKernelDefaultWindowCutover = async (
  kv: Kv,
  expectedLimitEntry: KvEntryMaybe<number>,
  expectedWindowEntry: KvEntryMaybe<number>
): Promise<KernelDefaultWindowCutoverDecision> => {
  let guard: KernelDefaultWindowCutoverGuard | null = null;
  try {
    const markerEntry = await kv.get<KernelDefaultWindowCutoverV2>(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, {
      consistency: "strong",
    });
    if (markerEntry.value !== null) {
      return {
        ok: false,
        reason: normalizeKernelDefaultWindowCutoverV2(markerEntry.value) ? "concurrent_change" : "unavailable",
      };
    }
    const nowMs = Date.now();
    const marker: KernelDefaultWindowCutoverV2 = {
      v: 2,
      id: crypto.randomUUID(),
      created_at_ms: nowMs,
      expires_at_ms: nowMs + KERNEL_DEFAULT_WINDOW_CUTOVER_LEASE_MS,
    };
    const acquired = await kv
      .atomic()
      .check(markerEntry)
      .check(expectedLimitEntry)
      .check(expectedWindowEntry)
      .set(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, marker, { expireIn: KERNEL_DEFAULT_WINDOW_CUTOVER_LEASE_MS })
      .commit();
    if (!acquired.ok) return { ok: false, reason: "concurrent_change" };
    const acquiredEntry = await kv.get<KernelDefaultWindowCutoverV2>(KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY, {
      consistency: "strong",
    });
    const acquiredMarker = normalizeKernelDefaultWindowCutoverV2(acquiredEntry.value);
    if (acquiredMarker?.id !== marker.id || acquiredEntry.versionstamp === null) {
      return { ok: false, reason: "unavailable" };
    }
    guard = {
      key: KERNEL_DEFAULT_WINDOW_CUTOVER_V2_KEY,
      entry: acquiredEntry as KvEntry<KernelDefaultWindowCutoverV2>,
    };
    if (await hasLiveDefaultBackedKernelReservations(kv)) {
      await releaseKernelDefaultWindowCutover(kv, guard);
      return { ok: false, reason: "active_reservations" };
    }
    return { ok: true, guard };
  } catch (error) {
    console.warn("[ai.ubq.fi] Failed to prepare Kernel default-window cutover:", error);
    if (guard) await releaseKernelDefaultWindowCutover(kv, guard);
    return { ok: false, reason: "unavailable" };
  }
};

export {
  kernelQuotaUnavailable,
  kernelReservationContext,
  kernelReservationKey,
  kernelReservationMatchesRequest,
  kernelReservationRetentionMs,
  readKernelQuotaPolicyState,
  reclaimExpiredKernelReservationUnlocked,
  withKernelQuotaLock,
};
