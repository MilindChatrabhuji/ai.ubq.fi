import { test } from "bun:test";
import type { Kv, KvKey } from "#kv";
import assert from "node:assert/strict";
import { apiKeyHashKey } from "../src/api-keys.ts";
import {
  API_KEY_USAGE_V3_RESERVATION_LEASE_MS,
  type ApiKeyPolicy,
  ApiKeyQuotaDispatchError,
  type ApiKeyProviderDispatch,
  apiKeyPolicyFromHashRecord,
  type ApiKeyUsageReservationDecision,
  apiKeyUsageV3RequestKey,
  apiKeyUsageV3WindowKey,
  reserveApiKeyUsageV3,
} from "../src/api-key-policy.ts";
import { setKvForTest } from "../src/kv.ts";
import { admitPaidFallbackV3, releaseUndispatchedPaidFallbackV3, updatePaidFallbackRequestV3 } from "../src/paid-fallback/ledger-admission.ts";
import { settlePaidFallbackUsageV3 } from "../src/paid-fallback/ledger-settlement.ts";
import { paidFallbackRequestV3Key, paidFallbackWindowV3Key } from "../src/paid-fallback/ledger-state.ts";
import type { ApiKeyHashRecord, ApiKeyUsageRequestV3, ApiKeyUsageWindowV3, PaidFallbackRequestV3 } from "../src/types.ts";
import { CountingKv } from "./helpers/counting-kv.ts";

/**
 * Adversarial reservation-lifecycle fixtures for the V3 API-key ledger.
 *
 * These exercise the identity and compare-and-set boundary of one reservation:
 * duplicate commit/release callbacks, cancellation racing usage settlement, and
 * request ids re-presented by the caller. The assertions are economic
 * invariants (a provider transport may only proceed against its own charge, and
 * the window may never under- or over-count), not a mirror of the code.
 */

const ROUTE = "responses";

const setupPolicy = (id: string, usageLimitRequests: number, nowMs = Date.now()): Readonly<{ kv: CountingKv; policy: ApiKeyPolicy }> => {
  const tokenHash = `oss-accounting-${id}`;
  const record: ApiKeyHashRecord = {
    id,
    expires_at_ms: -1,
    revoked_at_ms: null,
    usage_limit_requests: usageLimitRequests,
    usage_requests: 0,
    usage_reset_at_ms: nowMs + 60 * 60_000,
    window_ms: 60 * 60_000,
    usage_quota_version: 3,
    paid_fallback_enabled: false,
    paid_fallback_limit_microcredits: 0,
    paid_fallback_spent_microcredits: 0,
    paid_fallback_reserved_microcredits: 0,
    paid_fallback_reservation_request_id: null,
  };
  const policy = apiKeyPolicyFromHashRecord(tokenHash, record, nowMs);
  if (!policy) throw new Error("test API key policy must be valid");
  const kv = new CountingKv();
  kv.seed(apiKeyHashKey(tokenHash), record);
  return { kv, policy };
};

const kvFor = (kv: CountingKv): Kv => kv as unknown as Kv;

const storedValue = (kv: CountingKv, key: KvKey): unknown => kv.entries.get(JSON.stringify(key))?.value ?? null;

const windowFor = (kv: CountingKv, policy: ApiKeyPolicy): ApiKeyUsageWindowV3 => {
  const window = storedValue(kv, apiKeyUsageV3WindowKey(policy)) as ApiKeyUsageWindowV3 | null;
  if (!window) throw new Error("expected a V3 usage window");
  return window;
};

const requestFor = (kv: CountingKv, policy: ApiKeyPolicy, requestId: string): ApiKeyUsageRequestV3 | null =>
  storedValue(kv, apiKeyUsageV3RequestKey(policy, requestId)) as ApiKeyUsageRequestV3 | null;

/** The row and aggregate a client could observe for one request id. */
const accountingFor = (kv: CountingKv, policy: ApiKeyPolicy, requestId: string) => {
  const window = windowFor(kv, policy);
  const request = requestFor(kv, policy, requestId);
  return {
    committed: window.committed_requests,
    reserved: window.reserved_requests,
    state: request?.state ?? null,
    reason: request?.release_reason ?? null,
  };
};

/** Every reservation mutation must keep the aggregate consistent with the row. */
const assertLedgerConsistent = (kv: CountingKv, policy: ApiKeyPolicy, requestId: string, limit: number): void => {
  const accounting = accountingFor(kv, policy, requestId);
  assert.ok(accounting.reserved >= 0, `reserved_requests must never underflow: ${JSON.stringify(accounting)}`);
  assert.ok(accounting.committed + accounting.reserved <= limit, `committed + reserved must never exceed the window limit: ${JSON.stringify(accounting)}`);
  if (accounting.state === "reserved") assert.equal(accounting.committed, 0, `a reserved row owns no committed request: ${JSON.stringify(accounting)}`);
  if (accounting.state === "dispatched")
    assert.equal(accounting.committed, 1, `a dispatched row owns exactly one committed request: ${JSON.stringify(accounting)}`);
  if (accounting.state === "released") assert.equal(accounting.committed, 0, `a released row owns no committed request: ${JSON.stringify(accounting)}`);
};

const reserve = async (kv: CountingKv, policy: ApiKeyPolicy, requestId: string, nowMs?: number, route = ROUTE): Promise<ApiKeyUsageReservationDecision> =>
  await reserveApiKeyUsageV3(policy, requestId, route, nowMs === undefined ? { kv: kvFor(kv) } : { kv: kvFor(kv), nowMs });

const admitted = (decision: ApiKeyUsageReservationDecision) => {
  if (!decision.ok) throw new Error(`unexpected admission failure: ${decision.response.status}`);
  return decision.reservation;
};

test("a released request identity is refused at admission instead of admitted then failed", async () => {
  const { kv, policy } = setupPolicy("released-identity", 2);
  const first = admitted(await reserve(kv, policy, "reused-request"));
  await first.release("validation_failed");
  assert.deepEqual(accountingFor(kv, policy, "reused-request"), { committed: 0, reserved: 0, state: "released", reason: "validation_failed" });

  const replayed = await reserve(kv, policy, "reused-request");
  if (replayed.ok) {
    // Today this admission reports success and the request is only refused later,
    // inside provider dispatch, after the request was already accepted.
    let dispatchFailure: unknown = null;
    try {
      await replayed.reservation.beforeProviderDispatch("cerebras");
    } catch (error) {
      dispatchFailure = error;
    }
    throw new Error(`a spent request identity must not be re-admitted (dispatch failed with ${String(dispatchFailure)})`);
  }
  assert.equal(replayed.response.status, 503, "a spent identity is refused as an unavailable reservation");
  // The refusal is scoped to the spent identity: fresh work is still admitted.
  const fresh = admitted(await reserve(kv, policy, "fresh-request"));
  const dispatch = await fresh.beforeProviderDispatch("cerebras");
  if (!dispatch) throw new Error("fresh work must still reserve and dispatch");
  dispatch.markTransportStarted();
  assertLedgerConsistent(kv, policy, "fresh-request", 2);
  assert.equal(windowFor(kv, policy).committed_requests, 1);
});

test("a dispatched request identity is never re-admitted without its own charge", async () => {
  const { kv, policy } = setupPolicy("dispatched-identity", 2);
  const first = admitted(await reserve(kv, policy, "shared-request"));
  const firstDispatch = await first.beforeProviderDispatch("surplus");
  if (!firstDispatch) throw new Error("the first reservation must commit its dispatch");
  firstDispatch.markTransportStarted();
  assert.deepEqual(accountingFor(kv, policy, "shared-request"), { committed: 1, reserved: 0, state: "dispatched", reason: null });

  const readmission = await reserve(kv, policy, "shared-request");
  let secondContext: ApiKeyProviderDispatch | undefined;
  let refusal: unknown = null;
  if (readmission.ok) {
    try {
      secondContext = await readmission.reservation.beforeProviderDispatch("surplus");
    } catch (error) {
      refusal = error;
    }
  }
  const transportsWithoutOwnCharge = readmission.ok && secondContext === undefined && refusal === null;
  assert.equal(transportsWithoutOwnCharge, false, "a re-presented consumed identity must be refused or must commit its own charge before provider transport");
  assertLedgerConsistent(kv, policy, "shared-request", 2);
});

test("concurrent cancellation and dispatch settlement agree on one outcome", async () => {
  const { kv, policy } = setupPolicy("cancel-settlement-race", 1);
  const reservation = admitted(await reserve(kv, policy, "race-request"));
  const [dispatchOutcome, releaseOutcome] = await Promise.allSettled([reservation.beforeProviderDispatch("deepseek"), reservation.release("client_cancelled")]);
  assert.equal(releaseOutcome.status, "fulfilled", "completion must settle without error");
  const accounting = accountingFor(kv, policy, "race-request");
  assertLedgerConsistent(kv, policy, "race-request", 1);
  if (accounting.state === "dispatched") {
    assert.ok(dispatchOutcome.status === "fulfilled", "the winning dispatch must return a transport context");
    assert.ok(dispatchOutcome.value, "a committed dispatch must be compensatable by its caller");
  } else {
    assert.equal(accounting.state, "released", `the race must end in a settled row: ${JSON.stringify(accounting)}`);
    assert.equal(dispatchOutcome.status, "rejected", "a release that won the race must leave no dispatch context");
  }
});

test("duplicate pre-transport cancellation callbacks refund exactly once", async () => {
  const { kv, policy } = setupPolicy("duplicate-cancellation", 1);
  const reservation = admitted(await reserve(kv, policy, "duplicate-cancel-request"));
  const dispatch = await reservation.beforeProviderDispatch("cerebras");
  if (!dispatch) throw new Error("the reservation must commit its dispatch");

  await Promise.all([dispatch.cancelBeforeTransport(), dispatch.cancelBeforeTransport()]);

  assert.deepEqual(accountingFor(kv, policy, "duplicate-cancel-request"), {
    committed: 0,
    reserved: 0,
    state: "released",
    reason: "transport_cancelled_before_fetch",
  });
  assertLedgerConsistent(kv, policy, "duplicate-cancel-request", 1);
});

test("accepted upstream work is not refunded by a later completion callback", async () => {
  const { kv, policy } = setupPolicy("accepted-not-refunded", 1);
  const reservation = admitted(await reserve(kv, policy, "accepted-request"));
  const dispatch = await reservation.beforeProviderDispatch("chatgpt_codex");
  if (!dispatch) throw new Error("the reservation must commit its dispatch");
  dispatch.markTransportStarted();

  await dispatch.cancelBeforeTransport();
  await reservation.release("provider_http_failure");
  await reservation.release("provider_http_failure");

  assert.deepEqual(accountingFor(kv, policy, "accepted-request"), {
    committed: 1,
    reserved: 0,
    state: "dispatched",
    reason: null,
  });
  assertLedgerConsistent(kv, policy, "accepted-request", 1);
});

test("a reclaimed expired lease returns its slot once and never rides free later", async () => {
  const baseMs = Date.now();
  const { kv, policy } = setupPolicy("lease-expiry-late-dispatch", 1, baseMs);
  const abandoned = admitted(await reserve(kv, policy, "abandoned-request", baseMs));
  const replacement = admitted(await reserve(kv, policy, "replacement-request", baseMs + API_KEY_USAGE_V3_RESERVATION_LEASE_MS + 1));
  // The window aggregate and the reclaimed row are separate facts: the one live
  // slot belongs to the replacement, while the reclaimed identity's own row must
  // be terminal and uncharged.
  const abandonedRow = requestFor(kv, policy, "abandoned-request");
  assert.deepEqual(
    { state: abandonedRow?.state ?? null, reason: abandonedRow?.release_reason ?? null, committed: windowFor(kv, policy).committed_requests },
    { state: "released", reason: "lease_expired", committed: 0 },
    "the reclaimed identity's own row must be released without charging it"
  );
  assert.equal(windowFor(kv, policy).reserved_requests, 1, "exactly one live reservation remains, and it is the replacement's, not the reclaimed identity's");

  let lateDispatch: ApiKeyProviderDispatch | undefined;
  let lateRefusal: unknown = null;
  try {
    lateDispatch = await abandoned.beforeProviderDispatch("chatgpt_codex");
  } catch (error) {
    lateRefusal = error;
  }
  assert.ok(
    lateRefusal instanceof ApiKeyQuotaDispatchError || lateDispatch !== undefined,
    "a reclaimed identity must either re-reserve its own charge or fail closed, never dispatch uncharged"
  );
  assertLedgerConsistent(kv, policy, "abandoned-request", 1);
  assertLedgerConsistent(kv, policy, "replacement-request", 1);

  await replacement.release("validation_failed");
  assert.deepEqual(accountingFor(kv, policy, "replacement-request"), {
    committed: 0,
    reserved: 0,
    state: "released",
    reason: "validation_failed",
  });
});

test("a request id reused on another route cannot share the first route's charge", async () => {
  const { kv, policy } = setupPolicy("route-scoped-identity", 2);
  const first = admitted(await reserve(kv, policy, "cross-route-id", undefined, "chat.completions"));

  const otherRoute = await reserve(kv, policy, "cross-route-id", undefined, "embeddings");
  assert.ok(!otherRoute.ok, "one request id must not span two routes");
  assert.equal(otherRoute.response.status, 503);
  assert.deepEqual(accountingFor(kv, policy, "cross-route-id"), { committed: 0, reserved: 1, state: "reserved", reason: null });

  await first.release("validation_failed");
  assertLedgerConsistent(kv, policy, "cross-route-id", 2);
});

test("a live duplicate admission still shares one reservation and one committed request", async () => {
  const { kv, policy } = setupPolicy("live-idempotency", 1);
  const first = admitted(await reserve(kv, policy, "live-request"));
  const duplicate = admitted(await reserve(kv, policy, "live-request"));
  assert.equal(windowFor(kv, policy).reserved_requests, 1, "a duplicate admission must not reserve twice");

  const dispatch = await duplicate.beforeProviderDispatch("metered");
  if (!dispatch) throw new Error("a live duplicate admission must dispatch the one durable row");
  dispatch.markTransportStarted();
  const retry = await duplicate.beforeProviderDispatch("surplus");
  assert.equal(retry, undefined, "a retry of one reservation must not commit a second dispatch");

  await first.release();
  assert.deepEqual(accountingFor(kv, policy, "live-request"), { committed: 1, reserved: 0, state: "dispatched", reason: null });
  assertLedgerConsistent(kv, policy, "live-request", 1);
});

/**
 * Paid-fallback request rows are keyed by (key id, request id) with no window
 * component, and `admitPaidFallbackV3` projects any existing row back into a
 * reservation. The ledger's own billing contract is `isBillableRequestV3`, which
 * treats `settled` and `not_billed` rows as unbillable. These fixtures drive the
 * real exported lifecycle to check the identity boundary: a live pending row
 * must stay reusable, while a consumed identity must not be re-admitted for new
 * paid work that settlement would then refuse to record.
 */

const PAID_KEY_ID = "oss-accounting-paid-key";
const PAID_MODEL = "gpt-5.6-luna";

const paidAdmissionInput = (requestId: string, nowMs: number) => ({
  keyId: PAID_KEY_ID,
  requestId,
  createdAtMs: nowMs,
  policyVersion: "3600000:1",
  limitMicrocredits: 1_000,
  maximumExposureMicrocredits: 100,
  initialSettledMicrocredits: 0,
  quotaPerCredit: 1_000_000,
  windowResetAtMs: nowMs + 60 * 60_000,
  model: PAID_MODEL,
  route: "responses",
  path: "/v1/responses",
  stream: false,
  reasoning: null,
});

const surplusSettlement = (requestId: string, providerQuota: number) => ({
  settlement_request_id: requestId,
  provider_quota: providerQuota,
  input_tokens: 10,
  output_tokens: 5,
  model: PAID_MODEL,
  created_at_ms: Date.now(),
});

const paidLedgerRow = (kv: CountingKv, requestId: string): PaidFallbackRequestV3 | null =>
  storedValue(kv, paidFallbackRequestV3Key(PAID_KEY_ID, requestId)) as PaidFallbackRequestV3 | null;

/** Re-admits a consumed identity and reports whether settlement recorded the new paid work. */
const readmitAndSettle = async (requestId: string, nowMs: number): Promise<Readonly<{ kind: "reserved" | "blocked"; recorded: boolean | null }>> => {
  const readmission = await admitPaidFallbackV3(paidAdmissionInput(requestId, nowMs));
  if (readmission.kind !== "reserved") return { kind: readmission.kind, recorded: null };
  await updatePaidFallbackRequestV3(readmission.reservation, {
    provider: "surplus",
    provider_request_id: `${requestId}-second-upstream`,
    dispatch_state: "dispatched",
  });
  return {
    kind: readmission.kind,
    recorded: await settlePaidFallbackUsageV3(readmission.reservation, surplusSettlement(`${requestId}-second-settlement`, 5)),
  };
};

test("a settled paid-fallback identity is not re-admitted as unrecorded new paid work", async () => {
  const kv = new CountingKv();
  setKvForTest(kv as unknown as Kv);
  try {
    const nowMs = Date.now();
    const first = await admitPaidFallbackV3(paidAdmissionInput("paid-settled-request", nowMs));
    if (first.kind !== "reserved") throw new Error(`the first paid admission must reserve: ${JSON.stringify(first)}`);

    const duplicate = await admitPaidFallbackV3(paidAdmissionInput("paid-settled-request", nowMs));
    assert.equal(duplicate.kind, "reserved", "a live pending identity must remain reusable");
    const window = storedValue(kv, paidFallbackWindowV3Key(PAID_KEY_ID, nowMs + 60 * 60_000)) as { reserved_microcredits: number } | null;
    assert.equal(window?.reserved_microcredits, 100, "a duplicate paid admission must not reserve exposure twice");

    await updatePaidFallbackRequestV3(first.reservation, {
      provider: "surplus",
      provider_request_id: "paid-settled-upstream",
      dispatch_state: "dispatched",
    });
    assert.equal(
      await settlePaidFallbackUsageV3(first.reservation, surplusSettlement("paid-settled-settlement", 5)),
      true,
      "the first settlement must record its usage"
    );
    assert.equal(paidLedgerRow(kv, "paid-settled-request")?.billing_state, "settled", "the ledger must record the settled billing state");

    const replayed = await readmitAndSettle("paid-settled-request", nowMs + 60 * 60_000);
    assert.equal(
      replayed.recorded,
      null,
      `a settled identity must not be re-admitted for new paid work (kind=${replayed.kind}, new usage recorded=${String(replayed.recorded)})`
    );
  } finally {
    setKvForTest(null);
  }
});

test("a not-billed paid-fallback identity is not re-admitted as unrecorded new paid work", async () => {
  const kv = new CountingKv();
  setKvForTest(kv as unknown as Kv);
  try {
    const nowMs = Date.now();
    const first = await admitPaidFallbackV3(paidAdmissionInput("paid-not-billed-request", nowMs));
    if (first.kind !== "reserved") throw new Error(`the first paid admission must reserve: ${JSON.stringify(first)}`);

    await releaseUndispatchedPaidFallbackV3(first.reservation);
    assert.equal(paidLedgerRow(kv, "paid-not-billed-request")?.billing_state, "not_billed", "an undispatched release must record the identity as unbilled");

    const replayed = await readmitAndSettle("paid-not-billed-request", nowMs + 60 * 60_000);
    assert.equal(
      replayed.recorded,
      null,
      `a not-billed identity must not be re-admitted for new paid work (kind=${replayed.kind}, new usage recorded=${String(replayed.recorded)})`
    );
  } finally {
    setKvForTest(null);
  }
});
