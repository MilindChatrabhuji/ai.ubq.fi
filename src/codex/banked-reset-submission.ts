import type { Kv } from "#kv";
// Codex banked reset submission, redemption and reconciliation, split out of src/codex_banked_reset.ts.

import { getKv } from "../kv.ts";
import { readCodexResetUsage as readBankedResetUsage } from "./reset-settings.ts";
import {
  type CodexUsageResetProvider,
  providerSupportsLiveRedemption,
  providerSupportsResetType,
  providerTreatsRedeemOutcomeAsFinal,
  type RedeemResetResult,
  type ResetInventory,
  type ResetInventoryCredit,
} from "./banked-reset-provider.ts";
import type { CodexResetRedemptionRecord } from "../types.ts";
import { sha256Hex } from "../utils.ts";
import type {
  CodexBankedResetCandidate,
  CodexBankedResetConfig,
  CodexBankedResetDependencies,
  CodexBankedResetOutcome,
  CodexBankedResetTelemetry,
  CodexBankedResetTelemetryFields,
  ResetContext,
} from "./banked-reset.ts";
import {
  boundedInventorySignal,
  claimedDuringCurrentUtcDay,
  defaultTelemetry,
  emit,
  isNonEmptyText,
  isSafeMs,
  metric,
  outcome,
  policyReason,
  providerPolicyReason,
  safeOwnerToken,
  telemetryFields,
} from "./banked-reset.ts";
import type { ClaimResult } from "./banked-reset-claim.ts";
import {
  claimTransaction,
  durableReceiptId,
  liveSubmissionPolicyReason,
  loadLiveSubmissionConfig,
  makeResetContext,
  matchesContext,
  prepareSubmission,
  preserveReceipt,
  quotaWindowIsOpen,
  readClock,
  readExistingRecord,
  receiptId,
  rejectOwned,
  renewSubmittedForRedeem,
  selectInventoryCredit,
  stateWith,
  unknownOutcome,
  unknownOwned,
  updateOwnedRecord,
  validInventory,
  validRedeemResult,
} from "./banked-reset-claim.ts";

const verifyOwned = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  provider: CodexUsageResetProvider,
  clock: () => number,
  telemetry: CodexBankedResetTelemetry
): Promise<CodexBankedResetOutcome> => {
  if (candidate.signal?.aborted) return outcome("pending", "client_aborted_before_verification", context, record);
  const startedAt = performance.now();
  let result: unknown;
  try {
    result = await provider.verifyApplied(context.account, candidate.signal ?? new AbortController().signal);
  } catch {
    const nowMs = readClock(clock);
    if (nowMs === null) return outcome("pending", "invalid_clock", context, record);
    const unknown = await unknownOwned(kv, context, record, nowMs, "verification_unavailable", record.provider_receipt_id);
    return unknownOutcome(telemetry, context, candidate, "verification_unavailable", unknown ?? record);
  }
  const nowMs = readClock(clock);
  if (nowMs === null) return outcome("pending", "invalid_clock", context, record);
  if (result !== true) {
    const reason = typeof result === "boolean" ? "verification_not_applied" : "verification_response_invalid";
    const unknown = await unknownOwned(kv, context, record, nowMs, reason, record.provider_receipt_id);
    return unknownOutcome(telemetry, context, candidate, reason, unknown ?? record);
  }
  const finalized = await updateOwnedRecord(kv, context, record, (current) =>
    stateWith(current, "verified", nowMs, { verified_at_ms: nowMs, last_error_code: null })
  );
  if (!finalized) return outcome("pending", "verification_cas_failed", context, record);
  emit(telemetry, "codex_reset_verified", telemetryFields(context, candidate, { state: "verified" }));
  metric(telemetry, "codex_reset_verified_total", 1, telemetryFields(context, candidate, {}));
  metric(telemetry, "codex_reset_verification_latency_ms", Math.max(0, Math.round(performance.now() - startedAt)), telemetryFields(context, candidate, {}));
  metric(telemetry, "codex_reset_estimated_spend_total", 1, telemetryFields(context, candidate, {}));
  return outcome("verified", "verified", context, finalized);
};

/**
 * The upstream adapter has already parsed a documented terminal redemption
 * result (`reset` or `already_redeemed`). Lost, malformed, non-2xx, and unknown
 * responses never reach this path and remain durable `unknown`.
 */
const finalizeDocumentedRedeemOutcome = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  nowMs: number,
  telemetry: CodexBankedResetTelemetry,
  redeemOutcome: "reset" | "already_redeemed"
): Promise<CodexBankedResetOutcome> => {
  const finalized = await updateOwnedRecord(kv, context, record, (current) =>
    stateWith(current, "verified", nowMs, { verified_at_ms: nowMs, last_error_code: null })
  );
  if (!finalized) return outcome("pending", "redeem_outcome_finalization_cas_failed", context, record);
  emit(
    telemetry,
    "codex_reset_verified",
    telemetryFields(context, candidate, {
      state: "verified",
      verification_source: "redeem_outcome",
      redeem_outcome: redeemOutcome,
    })
  );
  metric(telemetry, "codex_reset_verified_total", 1, telemetryFields(context, candidate, {}));
  metric(telemetry, "codex_reset_verification_latency_ms", 0, telemetryFields(context, candidate, {}));
  metric(telemetry, "codex_reset_estimated_spend_total", 1, telemetryFields(context, candidate, {}));
  return outcome("verified", `redeem_outcome_${redeemOutcome}`, context, finalized);
};

/**
 * The capability fields an injected contract may be missing. The contract is
 * supplied by the caller, so it is read the same defensive way
 * `codex_banked_reset_provider.ts` reads it before trusting one: an absent
 * capability is never evidence of support.
 */
type UnverifiedResetContract = Readonly<{
  lookup?: Readonly<{ byIdempotencyKey?: boolean; byProviderReceiptId?: boolean }> | null;
  verification?: Readonly<{ independentlyVerifiable?: boolean }> | null;
}>;

/**
 * A terminal redeem outcome can only be reconciled when the contract proves a
 * lookup or an independent verification. The provider check runs first so a
 * provider that does not claim a final outcome is never inspected further.
 */
const terminalOutcomeCannotReconcile = (provider: CodexUsageResetProvider): boolean => {
  if (!providerTreatsRedeemOutcomeAsFinal(provider)) return false;
  const contract: UnverifiedResetContract = provider.contract;
  return !contract.lookup?.byIdempotencyKey && !contract.lookup?.byProviderReceiptId && !contract.verification?.independentlyVerifiable;
};

const reconcileOwned = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  provider: CodexUsageResetProvider,
  clock: () => number,
  telemetry: CodexBankedResetTelemetry
): Promise<CodexBankedResetOutcome> => {
  if (candidate.signal?.aborted) return outcome("pending", "client_aborted_before_reconciliation", context, record);
  let cannotReconcile: boolean;
  try {
    cannotReconcile = terminalOutcomeCannotReconcile(provider);
  } catch {
    return outcome("pending", "provider_contract_unproven", context, record);
  }
  if (cannotReconcile) {
    return outcome("pending", "terminal_outcome_ambiguous", context, record);
  }
  let lookedUp: RedeemResetResult;
  try {
    lookedUp = await provider.lookup(
      { ...context.account, idempotencyKey: context.idempotencyKey, providerReceiptId: record.provider_receipt_id },
      candidate.signal ?? new AbortController().signal
    );
  } catch {
    const nowMs = readClock(clock);
    if (nowMs === null) return outcome("pending", "invalid_clock", context, record);
    const unknown = await unknownOwned(kv, context, record, nowMs, "lookup_unavailable", record.provider_receipt_id);
    return unknownOutcome(telemetry, context, candidate, "lookup_unavailable", unknown ?? record);
  }
  const nowMs = readClock(clock);
  if (nowMs === null) return outcome("pending", "invalid_clock", context, record);
  if (!validRedeemResult(lookedUp)) {
    const unknown = await unknownOwned(kv, context, record, nowMs, "lookup_response_invalid", record.provider_receipt_id);
    return unknownOutcome(telemetry, context, candidate, "lookup_response_invalid", unknown ?? record);
  }
  if (lookedUp.kind === "rejected" || lookedUp.kind === "unknown") {
    // A recovery lookup can race a slow original provider invocation after its
    // lease expires. A negative lookup alone is therefore not proof that a
    // reset was never spent; only independent verification may resolve it.
    return await verifyOwned(kv, context, record, candidate, provider, clock, telemetry);
  }
  const receipt = receiptId(lookedUp.providerReceiptId);
  if (!receipt) {
    const unknown = await unknownOwned(kv, context, record, nowMs, "lookup_response_invalid", record.provider_receipt_id);
    return unknownOutcome(telemetry, context, candidate, "lookup_response_invalid", unknown ?? record);
  }
  const submitted = await preserveReceipt(kv, context, record, nowMs, durableReceiptId(provider, receipt));
  if (!submitted) return outcome("pending", "lookup_cas_failed", context, record);
  return await verifyOwned(kv, context, submitted, candidate, provider, clock, telemetry);
};

/**
 * A claimed record may only be submitted while its UTC day and quota window are
 * still open. A violation is durably rejected, exactly as before.
 */
const rejectIfClaimWindowClosed = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  nowMs: number
): Promise<CodexBankedResetOutcome | null> => {
  if (!claimedDuringCurrentUtcDay(record, nowMs)) {
    const rejected = await rejectOwned(kv, context, record, nowMs, "claim_day_elapsed");
    return outcome("rejected", "claim_day_elapsed", context, rejected ?? record);
  }
  if (!quotaWindowIsOpen(candidate, nowMs)) {
    const rejected = await rejectOwned(kv, context, record, nowMs, "quota_window_expired");
    return outcome("rejected", "quota_window_expired", context, rejected ?? record);
  }
  return null;
};

/** Pre-inventory policy and clock checks; `ready` carries the observed time. */
const submissionPreflight = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  dependencies: CodexBankedResetDependencies,
  clock: () => number
): Promise<Readonly<{ kind: "ready"; nowMs: number }> | Readonly<{ kind: "outcome"; outcome: CodexBankedResetOutcome }>> => {
  const initialPolicy = liveSubmissionPolicyReason(dependencies);
  if (initialPolicy) return { kind: "outcome", outcome: outcome("pending", `new_submission_${initialPolicy}`, context, record) };
  const nowBeforeInventory = readClock(clock);
  if (nowBeforeInventory === null) return { kind: "outcome", outcome: outcome("pending", "invalid_clock", context, record) };
  const closed = await rejectIfClaimWindowClosed(kv, context, record, candidate, nowBeforeInventory);
  if (closed) return { kind: "outcome", outcome: closed };
  if (candidate.signal?.aborted) {
    const rejected = await rejectOwned(kv, context, record, nowBeforeInventory, "client_aborted_before_submission");
    return { kind: "outcome", outcome: outcome("rejected", "client_aborted_before_submission", context, rejected ?? record) };
  }
  return { kind: "ready", nowMs: nowBeforeInventory };
};

/** Inventory fallback: read once, re-check the claim, and select one credit. */
const resolveInventoryCredit = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  dependencies: CodexBankedResetDependencies,
  clock: () => number,
  telemetry: CodexBankedResetTelemetry
): Promise<Readonly<{ kind: "selected"; credit: ResetInventoryCredit; nowMs: number }> | Readonly<{ kind: "outcome"; outcome: CodexBankedResetOutcome }>> => {
  let inventory: ResetInventory;
  try {
    inventory = await dependencies.provider.readInventory(context.account, boundedInventorySignal(candidate.signal));
  } catch {
    const nowMs = readClock(clock);
    if (nowMs === null) return { kind: "outcome", outcome: outcome("pending", "invalid_clock", context, record) };
    const rejected = await rejectOwned(kv, context, record, nowMs, "inventory_unavailable");
    emit(telemetry, "codex_reset_rejected", telemetryFields(context, candidate, { state: "rejected", reason: "inventory_unavailable" }));
    return { kind: "outcome", outcome: outcome("rejected", "inventory_unavailable", context, rejected ?? record) };
  }
  const nowMs = readClock(clock);
  if (nowMs === null) return { kind: "outcome", outcome: outcome("pending", "invalid_clock", context, record) };
  const closed = await rejectIfClaimWindowClosed(kv, context, record, candidate, nowMs);
  if (closed) return { kind: "outcome", outcome: closed };
  if (!validInventory(inventory, nowMs)) {
    const rejected = await rejectOwned(kv, context, record, nowMs, "inventory_response_invalid_or_unsupported");
    emit(telemetry, "codex_reset_rejected", telemetryFields(context, candidate, { state: "rejected", reason: "inventory_response_invalid_or_unsupported" }));
    return { kind: "outcome", outcome: outcome("rejected", "inventory_response_invalid_or_unsupported", context, rejected ?? record) };
  }
  const selection = selectInventoryCredit(inventory, dependencies.provider, nowMs);
  if (selection.kind !== "selected") {
    const reason = selection.kind === "empty" ? "inventory_empty" : "inventory_no_eligible_codex_credit";
    const rejected = await rejectOwned(kv, context, record, nowMs, reason);
    emit(telemetry, "codex_reset_rejected", telemetryFields(context, candidate, { state: "rejected", reason }));
    return { kind: "outcome", outcome: outcome("rejected", reason, context, rejected ?? record) };
  }
  return { kind: "selected", credit: selection.credit, nowMs };
};

/** The credit to spend must still be a live, supported Codex rate-limit credit. */
const isUsableSelectedCredit = (credit: ResetInventoryCredit | undefined, provider: CodexUsageResetProvider, nowMs: number): credit is ResetInventoryCredit =>
  credit !== undefined &&
  isNonEmptyText(credit.id, 512) &&
  credit.status === "available" &&
  credit.resetType === "codex_rate_limits" &&
  providerSupportsResetType(provider, credit.resetType) &&
  (credit.expiresAtMs === null || (isSafeMs(credit.expiresAtMs) && credit.expiresAtMs > nowMs));

/**
 * Resolve the credit for this submission: the evaluator's in-memory pick when
 * present, otherwise one read of the provider inventory.
 */
const resolveSelectedCredit = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  dependencies: CodexBankedResetDependencies,
  clock: () => number,
  telemetry: CodexBankedResetTelemetry,
  nowBeforeInventory: number
): Promise<Readonly<{ kind: "selected"; credit: ResetInventoryCredit; nowMs: number }> | Readonly<{ kind: "outcome"; outcome: CodexBankedResetOutcome }>> => {
  let selectedCredit = candidate.selectedCredit;
  let nowAfterInventory = nowBeforeInventory;
  if (!selectedCredit) {
    const resolved = await resolveInventoryCredit(kv, context, record, candidate, dependencies, clock, telemetry);
    if (resolved.kind === "outcome") return { kind: "outcome", outcome: resolved.outcome };
    selectedCredit = resolved.credit;
    nowAfterInventory = resolved.nowMs;
  }
  if (!isUsableSelectedCredit(selectedCredit, dependencies.provider, nowAfterInventory)) {
    const rejected = await rejectOwned(kv, context, record, nowAfterInventory, "selected_credit_invalid_or_expired");
    emit(telemetry, "codex_reset_rejected", telemetryFields(context, candidate, { state: "rejected", reason: "selected_credit_invalid_or_expired" }));
    return { kind: "outcome", outcome: outcome("rejected", "selected_credit_invalid_or_expired", context, rejected ?? record) };
  }
  const closed = await rejectIfClaimWindowClosed(kv, context, record, candidate, nowAfterInventory);
  if (closed) return { kind: "outcome", outcome: closed };
  return { kind: "selected", credit: selectedCredit, nowMs: nowAfterInventory };
};

/**
 * Cross the durable `claimed -> submitted` side-effect boundary after the last
 * policy re-read, keeping the observed inventory time as the commit time.
 */
const prepareLiveSubmission = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  dependencies: CodexBankedResetDependencies,
  clock: () => number,
  nowAfterInventory: number
): Promise<Readonly<{ kind: "prepared"; record: CodexResetRedemptionRecord }> | Readonly<{ kind: "outcome"; outcome: CodexBankedResetOutcome }>> => {
  // Re-read the kill switch after inventory and immediately before the fenced
  // side-effect boundary. A disable leaves `claimed` intact and makes no call.
  const finalConfig = loadLiveSubmissionConfig(dependencies);
  if (finalConfig.config === null) return { kind: "outcome", outcome: outcome("pending", `new_submission_${finalConfig.reason}`, context, record) };
  if (candidate.signal?.aborted) {
    const rejected = await rejectOwned(kv, context, record, nowAfterInventory, "client_aborted_before_submission");
    return { kind: "outcome", outcome: outcome("rejected", "client_aborted_before_submission", context, rejected ?? record) };
  }
  // Inventory validation and policy checks may take long enough for the
  // current quota window to end. Do not cross the durable side-effect
  // boundary after that deadline.
  const nowBeforePreparation = readClock(clock);
  if (nowBeforePreparation === null) return { kind: "outcome", outcome: outcome("pending", "invalid_clock", context, record) };
  const closed = await rejectIfClaimWindowClosed(kv, context, record, candidate, nowBeforePreparation);
  if (closed) return { kind: "outcome", outcome: closed };
  const prepared = await prepareSubmission(kv, context, candidate, record, nowBeforePreparation, clock, finalConfig.config.maxPerAccountPerDay);
  if (prepared.kind === "failure") {
    return { kind: "outcome", outcome: outcome(prepared.code === "account_day_limit_reached" ? "skipped" : "pending", prepared.code, context, record) };
  }
  return { kind: "prepared", record: prepared.record };
};

const submitClaimed = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  dependencies: CodexBankedResetDependencies,
  clock: () => number,
  telemetry: CodexBankedResetTelemetry
): Promise<CodexBankedResetOutcome> => {
  const preflight = await submissionPreflight(kv, context, record, candidate, dependencies, clock);
  if (preflight.kind === "outcome") return preflight.outcome;
  const resolution = await resolveSelectedCredit(kv, context, record, candidate, dependencies, clock, telemetry, preflight.nowMs);
  if (resolution.kind === "outcome") return resolution.outcome;
  const preparation = await prepareLiveSubmission(kv, context, record, candidate, dependencies, clock, resolution.nowMs);
  if (preparation.kind === "outcome") return preparation.outcome;
  return await renewAndRedeem(kv, context, candidate, dependencies, clock, telemetry, resolution.credit, preparation.record);
};
/**
 * The last checks before the provider call. This function deliberately does not
 * await: nothing may run between the final kill-switch read and `redeem`
 * except these in-memory checks.
 */
const redeemGate = (
  candidate: CodexBankedResetCandidate,
  record: CodexResetRedemptionRecord,
  context: ResetContext,
  clock: () => number
): Readonly<{ kind: "ready"; nowMs: number }> | Readonly<{ kind: "outcome"; outcome: CodexBankedResetOutcome }> => {
  const nowMs = readClock(clock);
  if (nowMs === null) return { kind: "outcome", outcome: outcome("pending", "invalid_clock", context, record) };
  if (!claimedDuringCurrentUtcDay(record, nowMs)) return { kind: "outcome", outcome: outcome("pending", "claim_day_elapsed", context, record) };
  if (!quotaWindowIsOpen(candidate, nowMs)) return { kind: "outcome", outcome: outcome("pending", "quota_window_expired", context, record) };
  if (record.lease_expires_at_ms <= nowMs) return { kind: "outcome", outcome: outcome("pending", "stale_owner", context, record) };
  return { kind: "ready", nowMs };
};

/**
 * A parsed terminal redeem outcome is finalized directly when the contract says
 * that outcome is authoritative; `null` leaves the result to the ordinary path.
 */
const finalizeTerminalRedeemResult = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  provider: CodexUsageResetProvider,
  nowMs: number,
  submittedResult: RedeemResetResult,
  telemetry: CodexBankedResetTelemetry
): Promise<CodexBankedResetOutcome | null> => {
  if (submittedResult.kind !== "completed" && submittedResult.kind !== "already_redeemed") return null;
  if (!providerTreatsRedeemOutcomeAsFinal(provider)) return null;
  emit(telemetry, "codex_reset_submitted", telemetryFields(context, candidate, { state: "submitted", provider_receipt_id: null }));
  return await finalizeDocumentedRedeemOutcome(
    kv,
    context,
    record,
    candidate,
    nowMs,
    telemetry,
    submittedResult.kind === "completed" ? "reset" : "already_redeemed"
  );
};

/** Record the receipt durably and verify the reset it belongs to. */
const persistReceiptAndVerify = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  provider: CodexUsageResetProvider,
  nowMs: number,
  receipt: string,
  clock: () => number,
  telemetry: CodexBankedResetTelemetry
): Promise<CodexBankedResetOutcome> => {
  const persistedReceipt = await preserveReceipt(kv, context, record, nowMs, durableReceiptId(provider, receipt));
  if (!persistedReceipt) return outcome("pending", "receipt_cas_failed", context, record);
  emit(
    telemetry,
    "codex_reset_submitted",
    telemetryFields(context, candidate, {
      state: "submitted",
      provider_receipt_id: durableReceiptId(provider, receipt),
    })
  );
  return await verifyOwned(kv, context, persistedReceipt, candidate, provider, clock, telemetry);
};

/** Invoke `redeem` once and finalize the durable record for its outcome. */
const redeemSubmittedOwned = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  provider: CodexUsageResetProvider,
  credit: ResetInventoryCredit,
  clock: () => number,
  telemetry: CodexBankedResetTelemetry
): Promise<CodexBankedResetOutcome> => {
  let submittedPromise: Promise<RedeemResetResult>;
  try {
    // Do not insert telemetry or another await between the final synchronous
    // kill-switch check in the caller and starting the provider invocation.
    submittedPromise = provider.redeem(
      { ...context.account, idempotencyKey: context.idempotencyKey, creditId: credit.id },
      candidate.signal ?? new AbortController().signal
    );
  } catch {
    const nowMs = readClock(clock);
    if (nowMs === null) return outcome("pending", "invalid_clock", context, record);
    const unknown = await unknownOwned(kv, context, record, nowMs, "submit_transport_unknown", null);
    return unknownOutcome(telemetry, context, candidate, "submit_transport_unknown", unknown ?? record);
  }
  emit(telemetry, "codex_reset_submit_started", telemetryFields(context, candidate, { state: "submitted" }));
  metric(telemetry, "codex_reset_submission_attempts_total", 1, telemetryFields(context, candidate, {}));

  let submittedResult: RedeemResetResult;
  try {
    submittedResult = await submittedPromise;
  } catch {
    const nowMs = readClock(clock);
    if (nowMs === null) return outcome("pending", "invalid_clock", context, record);
    const unknown = await unknownOwned(kv, context, record, nowMs, "submit_transport_unknown", null);
    return unknownOutcome(telemetry, context, candidate, "submit_transport_unknown", unknown ?? record);
  }
  const nowAfterRedeem = readClock(clock);
  if (nowAfterRedeem === null) return outcome("pending", "invalid_clock", context, record);
  if (!validRedeemResult(submittedResult)) {
    const unknown = await unknownOwned(kv, context, record, nowAfterRedeem, "submit_response_invalid", null);
    return unknownOutcome(telemetry, context, candidate, "submit_response_invalid", unknown ?? record);
  }
  if (submittedResult.kind === "rejected") {
    const rejected = await rejectOwned(kv, context, record, nowAfterRedeem, "provider_rejected");
    emit(telemetry, "codex_reset_rejected", telemetryFields(context, candidate, { state: "rejected", reason: "provider_rejected" }));
    return outcome("rejected", "provider_rejected", context, rejected ?? record);
  }
  if (submittedResult.kind === "unknown") {
    const unknown = await unknownOwned(
      kv,
      context,
      record,
      nowAfterRedeem,
      "provider_commit_unknown",
      durableReceiptId(provider, submittedResult.providerReceiptId)
    );
    return unknownOutcome(telemetry, context, candidate, "provider_commit_unknown", unknown ?? record);
  }
  const terminal = await finalizeTerminalRedeemResult(kv, context, record, candidate, provider, nowAfterRedeem, submittedResult, telemetry);
  if (terminal) return terminal;
  const receipt = receiptId(submittedResult.providerReceiptId);
  if (!receipt) {
    const unknown = await unknownOwned(kv, context, record, nowAfterRedeem, "submit_response_invalid", null);
    return unknownOutcome(telemetry, context, candidate, "submit_response_invalid", unknown ?? record);
  }
  return await persistReceiptAndVerify(kv, context, record, candidate, provider, nowAfterRedeem, receipt, clock, telemetry);
};

/**
 * Renew the lease at the last possible moment and then invoke the provider.
 * Every policy read here is synchronous, so a disable observed after the final
 * renewal still prevents the redemption.
 */
const renewAndRedeem = async (
  kv: Kv,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  dependencies: CodexBankedResetDependencies,
  clock: () => number,
  telemetry: CodexBankedResetTelemetry,
  credit: ResetInventoryCredit,
  preparedRecord: CodexResetRedemptionRecord
): Promise<CodexBankedResetOutcome> => {
  // `prepareSubmission` itself awaits strong reads and a CAS. Re-read the
  // kill switch after that durable transition. A disable visible at this
  // final pre-renewal check leaves the conservative `submitted` record
  // available for non-submitting recovery and makes no provider call.
  const beforeRedeemPolicy = liveSubmissionPolicyReason(dependencies);
  if (beforeRedeemPolicy) return outcome("pending", `new_submission_${beforeRedeemPolicy}`, context, preparedRecord);
  if (candidate.signal?.aborted) {
    const nowMs = readClock(clock);
    if (nowMs === null) return outcome("pending", "invalid_clock", context, preparedRecord);
    const unknown = await unknownOwned(kv, context, preparedRecord, nowMs, "client_aborted_after_submission", null);
    return unknownOutcome(telemetry, context, candidate, "client_aborted_after_submission", unknown ?? preparedRecord);
  }
  const renewed = await renewSubmittedForRedeem(kv, context, candidate, preparedRecord, clock);
  if (renewed.kind === "failure") return outcome("pending", renewed.code, context, preparedRecord);
  // The last lease/fence renewal itself awaits KV. Re-read the kill switch
  // synchronously after it returns so a disable that landed during that final
  // renewal cannot proceed to the provider call. `reloadConfig` is
  // deliberately synchronous; do not introduce an await after this point.
  const afterRenewalPolicy = liveSubmissionPolicyReason(dependencies);
  if (afterRenewalPolicy) {
    return outcome("pending", `new_submission_${afterRenewalPolicy}`, context, renewed.record);
  }
  if (candidate.signal?.aborted) {
    const nowMs = readClock(clock);
    if (nowMs === null) return outcome("pending", "invalid_clock", context, renewed.record);
    const unknown = await unknownOwned(kv, context, renewed.record, nowMs, "client_aborted_after_submission", null);
    return unknownOutcome(telemetry, context, candidate, "client_aborted_after_submission", unknown ?? renewed.record);
  }
  const gate = redeemGate(candidate, renewed.record, context, clock);
  if (gate.kind === "outcome") return gate.outcome;
  return await redeemSubmittedOwned(kv, context, renewed.record, candidate, dependencies.provider, credit, clock, telemetry);
};

/**
 * The production KV accessor. An unavailable accessor and an explicit null
 * override both fail closed, exactly as before.
 */
const openResetKv = async (dependencies: CodexBankedResetDependencies): Promise<Kv | null> => {
  try {
    return dependencies.kv === undefined ? await getKv() : dependencies.kv;
  } catch {
    return null;
  }
};

/** A settled record is terminal: it is reported and never reopened. */
const settledRecordDisposition = (
  telemetry: CodexBankedResetTelemetry,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  existing: CodexResetRedemptionRecord | null,
  fields: CodexBankedResetTelemetryFields
): CodexBankedResetOutcome | null => {
  if (existing?.state === "verified") {
    if (existing.routing_generation !== candidate.routingGeneration) {
      // The provider reset was verified for an older routing observation. The
      // old credit is already spent, and the post-reset probe may already have
      // re-blocked the account. Never present that old verification as a
      // recovery candidate for a newer quota circuit.
      emit(
        telemetry,
        "codex_reset_duplicate_prevented",
        telemetryFields(context, candidate, {
          state: "verified",
          fence: existing.fence,
          reason: "routing_generation_stale",
        })
      );
      metric(telemetry, "codex_reset_duplicate_prevented_total", 1, fields);
      return outcome("skipped", "verified_routing_generation_stale", context, existing);
    }
    emit(telemetry, "codex_reset_duplicate_prevented", telemetryFields(context, candidate, { state: "verified", fence: existing.fence }));
    metric(telemetry, "codex_reset_duplicate_prevented_total", 1, fields);
    return outcome("verified", "previously_verified", context, existing);
  }
  if (existing?.state === "rejected") {
    emit(telemetry, "codex_reset_duplicate_prevented", telemetryFields(context, candidate, { state: "rejected", fence: existing.fence }));
    metric(telemetry, "codex_reset_duplicate_prevented_total", 1, fields);
    return outcome("rejected", existing.last_error_code ?? "previously_rejected", context, existing);
  }
  return null;
};

/** Policy gate for the very first claim of an observed quota window. */
const resolveNewSubmissionAllowance = async (
  kv: Kv,
  context: ResetContext,
  dependencies: CodexBankedResetDependencies,
  reconcileOnly: boolean,
  telemetry: CodexBankedResetTelemetry,
  fields: CodexBankedResetTelemetryFields
): Promise<Readonly<{ kind: "allow"; allowNewSubmission: boolean }> | Readonly<{ kind: "outcome"; outcome: CodexBankedResetOutcome }>> => {
  if (reconcileOnly) return { kind: "outcome", outcome: outcome("skipped", "no_existing_transaction", context) };
  let configForClaim: CodexBankedResetConfig;
  try {
    if (!(await readBankedResetUsage(kv, context.account.accountIdHash)).allowed) {
      return { kind: "outcome", outcome: outcome("skipped", "usage_disabled", context) };
    }
    configForClaim = dependencies.reloadConfig?.() ?? dependencies.config;
  } catch {
    return { kind: "outcome", outcome: outcome("skipped", "configuration_unavailable", context) };
  }
  const reason = policyReason(configForClaim);
  if (reason) return { kind: "outcome", outcome: outcome("skipped", reason, context) };
  const providerReason = providerPolicyReason(configForClaim, dependencies.provider);
  if (providerReason) return { kind: "outcome", outcome: outcome("skipped", providerReason, context) };
  emit(telemetry, "codex_reset_eligible", fields);
  metric(telemetry, "codex_reset_eligible_total", 1, fields);
  if (configForClaim.mode === "shadow") {
    emit(telemetry, "codex_reset_shadow_candidate", fields);
    metric(telemetry, "codex_reset_shadow_candidates_total", 1, fields);
    // Shadow mode deliberately makes no provider call, including inventory.
    return { kind: "outcome", outcome: outcome("skipped", "shadow", context) };
  }
  return { kind: "allow", allowNewSubmission: true };
};

/**
 * Whether this call may create a new submission. An existing `submitted` or
 * `unknown` record is only ever reconciled, never re-submitted.
 */
const resolveSubmissionAllowance = async (
  kv: Kv,
  context: ResetContext,
  existing: CodexResetRedemptionRecord | null,
  dependencies: CodexBankedResetDependencies,
  reconcileOnly: boolean,
  telemetry: CodexBankedResetTelemetry,
  fields: CodexBankedResetTelemetryFields
): Promise<Readonly<{ kind: "allow"; allowNewSubmission: boolean }> | Readonly<{ kind: "outcome"; outcome: CodexBankedResetOutcome }>> => {
  if (!existing) return await resolveNewSubmissionAllowance(kv, context, dependencies, reconcileOnly, telemetry, fields);
  if (existing.state !== "claimed") return { kind: "allow", allowNewSubmission: false };
  if (reconcileOnly) return { kind: "outcome", outcome: outcome("pending", "unsubmitted_transaction", context, existing) };
  const reason = liveSubmissionPolicyReason(dependencies);
  if (reason) return { kind: "outcome", outcome: outcome("pending", `new_submission_${reason}`, context, existing) };
  return { kind: "allow", allowNewSubmission: true };
};

/** Translate one claim result into the caller-visible outcome. */
const handleClaimResult = async (
  kv: Kv,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  dependencies: CodexBankedResetDependencies,
  clock: () => number,
  telemetry: CodexBankedResetTelemetry,
  fields: CodexBankedResetTelemetryFields,
  claimed: ClaimResult
): Promise<CodexBankedResetOutcome> => {
  switch (claimed.kind) {
    case "failure":
      return outcome("skipped", claimed.code, context);
    case "no_transaction":
      return outcome("skipped", "no_existing_transaction", context);
    case "account_day_limit":
      return outcome("skipped", "account_day_limit_reached", context);
    case "in_progress":
      emit(telemetry, "codex_reset_duplicate_prevented", telemetryFields(context, candidate, { state: claimed.record.state, fence: claimed.record.fence }));
      metric(telemetry, "codex_reset_duplicate_prevented_total", 1, fields);
      return outcome("pending", "transaction_in_progress", context, claimed.record);
    case "rejected":
      emit(telemetry, "codex_reset_duplicate_prevented", telemetryFields(context, candidate, { state: "rejected", fence: claimed.record.fence }));
      metric(telemetry, "codex_reset_duplicate_prevented_total", 1, fields);
      return outcome("rejected", claimed.record.last_error_code ?? "previously_rejected", context, claimed.record);
    case "verified":
      emit(telemetry, "codex_reset_duplicate_prevented", telemetryFields(context, candidate, { state: "verified", fence: claimed.record.fence }));
      metric(telemetry, "codex_reset_duplicate_prevented_total", 1, fields);
      return outcome("verified", "previously_verified", context, claimed.record);
    case "submit":
      emit(
        telemetry,
        "codex_reset_claimed",
        telemetryFields(context, candidate, {
          state: "claimed",
          fence: claimed.record.fence,
          takeover: claimed.tookOver,
        })
      );
      return await submitClaimed(kv, context, claimed.record, candidate, dependencies, clock, telemetry);
    case "reconcile":
      emit(
        telemetry,
        "codex_reset_duplicate_prevented",
        telemetryFields(context, candidate, {
          state: claimed.record.state,
          fence: claimed.record.fence,
          takeover: claimed.tookOver,
        })
      );
      metric(telemetry, "codex_reset_duplicate_prevented_total", 1, fields);
      return await reconcileOwned(kv, context, claimed.record, candidate, dependencies.provider, clock, telemetry);
    default: {
      // Every variant above is handled, so this branch is unreachable. Assigning
      // to a `never` makes a future variant a compile error instead of a silent
      // `undefined` return.
      const unhandled: never = claimed;
      throw new Error(`unhandled codex banked reset claim result: ${JSON.stringify(unhandled)}`);
    }
  }
};

const attemptInternal = async (
  candidate: CodexBankedResetCandidate,
  dependencies: CodexBankedResetDependencies,
  reconcileOnly: boolean
): Promise<CodexBankedResetOutcome> => {
  const hash = dependencies.hash ?? sha256Hex;
  const context = await makeResetContext(candidate, hash);
  if (!context) return outcome("skipped", "invalid_quota_generation");
  const telemetry = dependencies.telemetry ?? defaultTelemetry;
  const fields = telemetryFields(context, candidate, {});
  const kv = await openResetKv(dependencies);
  if (!kv) return outcome("skipped", "kv_unavailable", context);

  const existing = await readExistingRecord(kv, context);
  if (existing.code) return outcome("skipped", existing.code, context);
  if (existing.record && !matchesContext(existing.record, context)) {
    return outcome("skipped", "redemption_record_context_mismatch", context, existing.record);
  }
  const settled = settledRecordDisposition(telemetry, context, candidate, existing.record, fields);
  if (settled) return settled;
  const allowance = await resolveSubmissionAllowance(kv, context, existing.record, dependencies, reconcileOnly, telemetry, fields);
  if (allowance.kind === "outcome") return allowance.outcome;

  if (!providerSupportsLiveRedemption(dependencies.provider)) {
    if (!existing.record) {
      emit(telemetry, "codex_reset_rejected", telemetryFields(context, candidate, { state: "rejected", reason: "provider_contract_unproven" }));
    }
    return outcome("skipped", "provider_contract_unproven", context, existing.record);
  }
  const clock = dependencies.now ?? Date.now;
  const nowMs = readClock(clock);
  if (nowMs === null) return outcome("skipped", "invalid_clock", context, existing.record);
  const ownerToken = safeOwnerToken(dependencies.newOwnerToken ?? (() => crypto.randomUUID()));
  if (!ownerToken) return outcome("skipped", "owner_token_unavailable", context, existing.record);
  const claimed = await claimTransaction(kv, context, candidate, nowMs, clock, ownerToken, allowance.allowNewSubmission);
  return await handleClaimResult(kv, context, candidate, dependencies, clock, telemetry, fields, claimed);
};

/**
 * Attempt or reconcile exactly one logical reset after normal account
 * failover. New external submissions require live policy and all durable
 * fences; an existing submitted/unknown record is reconciled even while the
 * kill switch is disabled.
 */
export const attemptCodexBankedReset = async (
  candidate: CodexBankedResetCandidate,
  dependencies: CodexBankedResetDependencies
): Promise<CodexBankedResetOutcome> => await attemptInternal(candidate, dependencies, false);

/**
 * Recovery-only path for a durable submitted/unknown record. It never creates
 * a claim or calls `redeem`, so it remains safe during a rollback.
 */
export const reconcileCodexBankedReset = async (
  candidate: CodexBankedResetCandidate,
  dependencies: CodexBankedResetDependencies
): Promise<CodexBankedResetOutcome> => await attemptInternal(candidate, dependencies, true);

export { openResetKv };
