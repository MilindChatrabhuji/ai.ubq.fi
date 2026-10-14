import type { AtomicOperation, Kv, KvEntryMaybe, KvKey } from "#kv";
// Codex banked reset claim and submission preparation, split out of src/codex_banked_reset.ts.

import {
  type CodexUsageResetProvider,
  providerReceiptIdsSafeToPersistAndLog,
  providerSupportsResetType,
  type RedeemResetResult,
  type ResetInventory,
  type ResetInventoryCredit,
} from "./banked-reset-provider.ts";
import type { CodexResetGlobalDailyRecord, CodexResetRedemptionRecord, CodexResetRedemptionState } from "../types.ts";
import { isRecord } from "../utils.ts";
import type {
  CodexBankedResetCandidate,
  CodexBankedResetConfig,
  CodexBankedResetDependencies,
  CodexBankedResetOutcome,
  CodexBankedResetTelemetry,
  ResetContext,
} from "./banked-reset.ts";
import {
  CODEX_BANKED_RESET_INVENTORY_MAX_AGE_MS,
  CODEX_BANKED_RESET_LEASE_MS,
  MAX_CAS_ATTEMPTS,
  claimedDuringCurrentUtcDay,
  codexResetAccountDailyKey,
  codexResetRedemptionKey,
  emit,
  isNonEmptyText,
  isSafeMs,
  isSafeNonnegativeInteger,
  metric,
  outcome,
  parseCodexResetRedemptionRecord,
  parseAccountDayRecord,
  policyReason,
  providerPolicyReason,
  readUsageGate,
  telemetryFields,
  utcDay,
} from "./banked-reset.ts";

const makeResetContext = async (candidate: CodexBankedResetCandidate, hash: (value: string) => Promise<string>): Promise<ResetContext | null> => {
  if (
    !isNonEmptyText(candidate.accountId, 1024) ||
    !isNonEmptyText(candidate.credentialVersion, 512) ||
    !isSafeMs(candidate.quotaResetAtMs) ||
    !Number.isSafeInteger(candidate.routingGeneration) ||
    candidate.routingGeneration < 0
  ) {
    return null;
  }
  try {
    const accountIdHash = await hash(candidate.accountId);
    // The routing layer permits this deadline-derived identity only while its
    // durable fence proves the absolute observation has not been revised.
    // A future provider-proven quota generation should replace this deadline
    // identity; an observed deadline change fails closed before this path.
    // Credential version remains a separate routing fence, so refresh cannot
    // manufacture a second logical redemption for one observed window.
    const credentialVersionInput = `uos_ai\u0000codex_reset_credential_version\u0000${candidate.credentialVersion}`;
    const credentialVersion = `v1:${await hash(credentialVersionInput)}`;
    const quotaGenerationInput = `uos_ai\u0000codex_reset_generation\u0000${accountIdHash}\u0000${candidate.quotaResetAtMs}`;
    const quotaGeneration = `v1:${await hash(quotaGenerationInput)}`;
    const idempotencyKeyInput = `uos_ai\u0000codex_reset_idempotency\u0000${accountIdHash}\u0000${quotaGeneration}`;
    const idempotencyKey = `uos_ai_codex_reset_v1_${await hash(idempotencyKeyInput)}`;
    const idempotencyKeyHash = await hash(idempotencyKey);
    if (!isNonEmptyText(accountIdHash) || !isNonEmptyText(credentialVersion) || !isNonEmptyText(quotaGeneration) || !isNonEmptyText(idempotencyKeyHash)) {
      return null;
    }
    return {
      account: {
        accountId: candidate.accountId,
        accountIdHash,
        credentialVersion,
        quotaGeneration,
      },
      idempotencyKey,
      idempotencyKeyHash,
    };
  } catch {
    return null;
  }
};

type ClaimResult =
  | Readonly<{ kind: "submit"; record: CodexResetRedemptionRecord; tookOver: boolean }>
  | Readonly<{ kind: "reconcile"; record: CodexResetRedemptionRecord; tookOver: boolean }>
  | Readonly<{ kind: "verified"; record: CodexResetRedemptionRecord }>
  | Readonly<{ kind: "rejected"; record: CodexResetRedemptionRecord }>
  | Readonly<{ kind: "in_progress"; record: CodexResetRedemptionRecord }>
  | Readonly<{ kind: "no_transaction" }>
  | Readonly<{ kind: "account_day_limit" }>
  | Readonly<{ kind: "failure"; code: string }>;

type FenceRead =
  Readonly<{ kind: "valid"; entries: readonly KvEntryMaybe<unknown>[] }> | Readonly<{ kind: "stale" }> | Readonly<{ kind: "failure"; code: string }>;

type SubmissionPreparation = Readonly<{ kind: "submitted"; record: CodexResetRedemptionRecord }> | Readonly<{ kind: "failure"; code: string }>;

type SubmissionRenewal = Readonly<{ kind: "renewed"; record: CodexResetRedemptionRecord }> | Readonly<{ kind: "failure"; code: string }>;

const matchesContext = (record: CodexResetRedemptionRecord, context: ResetContext): boolean =>
  record.account_id_hash === context.account.accountIdHash &&
  record.credential_version === context.account.credentialVersion &&
  record.quota_generation === context.account.quotaGeneration &&
  record.idempotency_key_hash === context.idempotencyKeyHash;

/**
 * Ownership fence for a record this worker still holds: same reset context, the
 * same owner token and fence it wrote, and the expected durable state.
 */
const isOwnedRecordInState = (
  current: CodexResetRedemptionRecord | null,
  context: ResetContext,
  expected: CodexResetRedemptionRecord,
  state: CodexResetRedemptionState
): current is CodexResetRedemptionRecord =>
  current !== null &&
  matchesContext(current, context) &&
  current.owner_token === expected.owner_token &&
  current.fence === expected.fence &&
  current.state === state;

const leaseUntil = (nowMs: number): number | null => {
  const next = nowMs + CODEX_BANKED_RESET_LEASE_MS;
  return isSafeMs(next) ? next : null;
};

const nextFence = (fence: number): number | null => {
  const next = fence + 1;
  return Number.isSafeInteger(next) ? next : null;
};

const quotaWindowIsOpen = (candidate: CodexBankedResetCandidate, nowMs: number): boolean => nowMs < candidate.quotaResetAtMs;

const readClock = (clock: () => number): number | null => {
  try {
    const value = clock();
    return isSafeMs(value) ? value : null;
  } catch {
    return null;
  }
};

const hasUsableFences = (candidate: CodexBankedResetCandidate): boolean =>
  Array.isArray(candidate.fences) &&
  candidate.fences.length > 0 &&
  candidate.fences.every((fence) => isRecord(fence) && Array.isArray(fence.key) && typeof fence.isCurrent === "function");

const readCurrentFences = async (kv: Kv, candidate: CodexBankedResetCandidate): Promise<FenceRead> => {
  if (!hasUsableFences(candidate)) return { kind: "failure", code: "routing_fence_missing" };
  const entries: KvEntryMaybe<unknown>[] = [];
  for (const fence of candidate.fences) {
    let entry: KvEntryMaybe<unknown>;
    try {
      entry = await kv.get(fence.key, { consistency: "strong" });
    } catch {
      return { kind: "failure", code: "kv_unavailable" };
    }
    try {
      if (!fence.isCurrent(entry.value)) return { kind: "stale" };
    } catch {
      return { kind: "stale" };
    }
    entries.push(entry);
  }
  return { kind: "valid", entries };
};

const withFenceChecks = (operation: AtomicOperation, entries: readonly KvEntryMaybe<unknown>[]): AtomicOperation => {
  let next = operation;
  for (const entry of entries) next = next.check(entry);
  return next;
};

/**
 * A fence read that a caller may act on. An unavailable read and a stale fence
 * are both stops, but only the stale fence reports a routing fence problem.
 */
type RequiredFences = Readonly<{ kind: "valid"; entries: readonly KvEntryMaybe<unknown>[] }> | Readonly<{ kind: "failure"; code: string }>;

const readRequiredFences = async (kv: Kv, candidate: CodexBankedResetCandidate): Promise<RequiredFences> => {
  const fences = await readCurrentFences(kv, candidate);
  if (fences.kind === "failure") return { kind: "failure", code: fences.code };
  if (fences.kind === "stale") return { kind: "failure", code: "routing_fence_stale" };
  return { kind: "valid", entries: fences.entries };
};

const readExistingRecord = async (kv: Kv, context: ResetContext): Promise<Readonly<{ record: CodexResetRedemptionRecord | null; code: string | null }>> => {
  const key = codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration);
  try {
    const entry = await kv.get<CodexResetRedemptionRecord>(key, { consistency: "strong" });
    if (entry.value === null) return { record: null, code: null };
    const record = parseCodexResetRedemptionRecord(entry.value);
    return record ? { record, code: null } : { record: null, code: "redemption_record_invalid" };
  } catch {
    return { record: null, code: "kv_unavailable" };
  }
};

/**
 * Create the first durable claim for a quota window. `null` means the atomic
 * write lost a race and the caller must re-read the record and try again.
 */
const createClaimRecord = async (
  kv: Kv,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  nowMs: number,
  clock: () => number,
  ownerToken: string,
  allowNewSubmission: boolean,
  expiresAtMs: number,
  entry: KvEntryMaybe<CodexResetRedemptionRecord>,
  key: KvKey
): Promise<ClaimResult | null> => {
  if (!allowNewSubmission) return { kind: "no_transaction" };
  // Do not claim a quota window that has already recovered. In particular, this
  // must precede the daily-cap write so an expired candidate cannot consume
  // capacity without reaching the provider.
  if (!quotaWindowIsOpen(candidate, nowMs)) return { kind: "failure", code: "quota_window_expired" };
  const fences = await readRequiredFences(kv, candidate);
  if (fences.kind === "failure") return { kind: "failure", code: fences.code };
  const created: CodexResetRedemptionRecord = {
    v: 1,
    account_id_hash: context.account.accountIdHash,
    credential_version: context.account.credentialVersion,
    quota_generation: context.account.quotaGeneration,
    routing_generation: candidate.routingGeneration,
    idempotency_key_hash: context.idempotencyKeyHash,
    state: "claimed",
    owner_token: ownerToken,
    fence: 1,
    lease_expires_at_ms: expiresAtMs,
    provider_receipt_id: null,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    submitted_at_ms: null,
    verified_at_ms: null,
    last_error_code: null,
  };
  // Fence reads are asynchronous. Re-check immediately before the atomic write
  // so a window that expired during those reads cannot create a fresh
  // submission path.
  const nowBeforeClaim = readClock(clock);
  if (nowBeforeClaim === null) return { kind: "failure", code: "invalid_clock" };
  if (!quotaWindowIsOpen(candidate, nowBeforeClaim)) {
    return { kind: "failure", code: "quota_window_expired" };
  }
  try {
    const committed = await withFenceChecks(kv.atomic().check(entry), fences.entries).set(key, created).commit();
    if (committed.ok) return { kind: "submit", record: created, tookOver: false };
  } catch {
    return { kind: "failure", code: "kv_unavailable" };
  }
  return null;
};

/** Terminal or still-owned records short-circuit a takeover before any write. */
const existingRecordDisposition = (
  record: CodexResetRedemptionRecord,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  nowMs: number,
  allowNewSubmission: boolean
): ClaimResult | null => {
  if (!matchesContext(record, context)) return { kind: "failure", code: "redemption_record_context_mismatch" };
  if (record.state === "verified") return { kind: "verified", record };
  if (record.state === "rejected") return { kind: "rejected", record };
  if (record.lease_expires_at_ms > nowMs) return { kind: "in_progress", record };
  if (record.state === "claimed" && !allowNewSubmission) return { kind: "in_progress", record };
  // A takeover of an expired `claimed` record would otherwise create a fresh
  // submission path after the observed quota window has reopened.
  // Submitted/unknown records deliberately bypass this guard and reconcile
  // lookup-only; they are never re-redeemed here.
  if (record.state === "claimed" && !quotaWindowIsOpen(candidate, nowMs)) {
    return { kind: "failure", code: "quota_window_expired" };
  }
  return null;
};

/** Only a `claimed` record is fenced on takeover; reconciliation reads none. */
const takeOverFences = async (kv: Kv, candidate: CodexBankedResetCandidate, record: CodexResetRedemptionRecord): Promise<RequiredFences> => {
  if (record.state !== "claimed") return { kind: "valid", entries: [] };
  if (record.routing_generation !== candidate.routingGeneration) {
    return { kind: "failure", code: "routing_fence_stale" };
  }
  return await readRequiredFences(kv, candidate);
};

/** Commit the takeover. `null` means the CAS lost and the caller must retry. */
const commitTakeOver = async (
  kv: Kv,
  candidate: CodexBankedResetCandidate,
  record: CodexResetRedemptionRecord,
  nowMs: number,
  clock: () => number,
  ownerToken: string,
  expiresAtMs: number,
  fenceEntries: readonly KvEntryMaybe<unknown>[],
  entry: KvEntryMaybe<CodexResetRedemptionRecord>,
  key: KvKey
): Promise<ClaimResult | null> => {
  // A stale claimant may have spent time reading its routing/auth fences.
  // Recheck here before it can become the new owner of an expired quota
  // window. Submitted/unknown reconciliation remains outside this path.
  const nowBeforeTakeover = readClock(clock);
  if (nowBeforeTakeover === null) return { kind: "failure", code: "invalid_clock" };
  if (record.state === "claimed" && !quotaWindowIsOpen(candidate, nowBeforeTakeover)) {
    return { kind: "failure", code: "quota_window_expired" };
  }
  const renewedFence = nextFence(record.fence);
  if (renewedFence === null) return { kind: "failure", code: "owner_fence_exhausted" };
  const takenOver: CodexResetRedemptionRecord = {
    ...record,
    owner_token: ownerToken,
    fence: renewedFence,
    lease_expires_at_ms: expiresAtMs,
    updated_at_ms: nowMs,
  };
  try {
    const committed = await withFenceChecks(kv.atomic().check(entry), fenceEntries).set(key, takenOver).commit();
    if (!committed.ok) return null;
  } catch {
    return { kind: "failure", code: "kv_unavailable" };
  }
  return record.state === "claimed" ? { kind: "submit", record: takenOver, tookOver: true } : { kind: "reconcile", record: takenOver, tookOver: true };
};

/**
 * One compare-and-set attempt. `null` means a concurrent writer changed the
 * record between the read and the write, so the caller must try again.
 */
const claimAttempt = async (
  kv: Kv,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  nowMs: number,
  clock: () => number,
  ownerToken: string,
  allowNewSubmission: boolean,
  expiresAtMs: number,
  key: KvKey
): Promise<ClaimResult | null> => {
  let entry: KvEntryMaybe<CodexResetRedemptionRecord>;
  try {
    entry = await kv.get<CodexResetRedemptionRecord>(key, { consistency: "strong" });
  } catch {
    return { kind: "failure", code: "kv_unavailable" };
  }
  const record = entry.value === null ? null : parseCodexResetRedemptionRecord(entry.value);
  if (entry.value !== null && !record) return { kind: "failure", code: "redemption_record_invalid" };
  if (!record) {
    return await createClaimRecord(kv, context, candidate, nowMs, clock, ownerToken, allowNewSubmission, expiresAtMs, entry, key);
  }

  const disposition = existingRecordDisposition(record, context, candidate, nowMs, allowNewSubmission);
  if (disposition) return disposition;
  const fences = await takeOverFences(kv, candidate, record);
  if (fences.kind === "failure") return { kind: "failure", code: fences.code };
  return await commitTakeOver(kv, candidate, record, nowMs, clock, ownerToken, expiresAtMs, fences.entries, entry, key);
};

const claimTransaction = async (
  kv: Kv,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  nowMs: number,
  clock: () => number,
  ownerToken: string,
  allowNewSubmission: boolean
): Promise<ClaimResult> => {
  const expiresAtMs = leaseUntil(nowMs);
  if (expiresAtMs === null) return { kind: "failure", code: "invalid_clock" };
  const key = codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const claimed = await claimAttempt(kv, context, candidate, nowMs, clock, ownerToken, allowNewSubmission, expiresAtMs, key);
    if (claimed) return claimed;
  }
  return { kind: "failure", code: "kv_cas_exhausted" };
};

const updateOwnedRecord = async (
  kv: Kv,
  context: ResetContext,
  expected: CodexResetRedemptionRecord,
  mutate: (record: CodexResetRedemptionRecord) => CodexResetRedemptionRecord
): Promise<CodexResetRedemptionRecord | null> => {
  const key = codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    let entry: KvEntryMaybe<CodexResetRedemptionRecord>;
    try {
      entry = await kv.get<CodexResetRedemptionRecord>(key, { consistency: "strong" });
    } catch {
      return null;
    }
    const current = parseCodexResetRedemptionRecord(entry.value);
    if (!current || !matchesContext(current, context) || current.owner_token !== expected.owner_token || current.fence !== expected.fence) {
      return null;
    }
    const next = mutate(current);
    try {
      const committed = await kv.atomic().check(entry).set(key, next).commit();
      if (committed.ok) return next;
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Atomically renew the owner lease and fence the `claimed -> submitted`
 * transition against both routing and auth. The external call follows only
 * after this durable side-effect boundary succeeds.
 */
/**
 * Strong read of the account's UTC-day submission budget. A corrupt daily
 * record fails closed rather than resetting the cap to zero.
 */
const readDailySubmissionBudget = async (
  kv: Kv,
  dailyKey: KvKey,
  day: string,
  maxPerAccountPerDay: number
): Promise<
  Readonly<{ kind: "ok"; entry: KvEntryMaybe<CodexResetGlobalDailyRecord>; submissionCount: number }> | Readonly<{ kind: "failure"; code: string }>
> => {
  let dailyEntry: KvEntryMaybe<CodexResetGlobalDailyRecord>;
  try {
    dailyEntry = await kv.get<CodexResetGlobalDailyRecord>(dailyKey, { consistency: "strong" });
  } catch {
    return { kind: "failure", code: "kv_unavailable" };
  }
  const daily = dailyEntry.value === null ? null : parseAccountDayRecord(dailyEntry.value, day);
  if (dailyEntry.value !== null && !daily) return { kind: "failure", code: "account_day_record_invalid" };
  const submissionCount = daily?.submission_count ?? 0;
  if (submissionCount >= maxPerAccountPerDay) return { kind: "failure", code: "account_day_limit_reached" };
  return { kind: "ok", entry: dailyEntry, submissionCount };
};

/**
 * One compare-and-set attempt of the durable `claimed -> submitted` boundary.
 * `null` means the CAS lost and the caller must try again.
 */
const prepareSubmissionAttempt = async (
  kv: Kv,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  expected: CodexResetRedemptionRecord,
  nowMs: number,
  clock: () => number,
  maxPerAccountPerDay: number,
  expiresAtMs: number,
  day: string,
  key: KvKey,
  dailyKey: KvKey
): Promise<SubmissionPreparation | null> => {
  let entry: KvEntryMaybe<CodexResetRedemptionRecord>;
  try {
    entry = await kv.get<CodexResetRedemptionRecord>(key, { consistency: "strong" });
  } catch {
    return { kind: "failure", code: "kv_unavailable" };
  }
  const current = parseCodexResetRedemptionRecord(entry.value);
  if (!isOwnedRecordInState(current, context, expected, "claimed")) return { kind: "failure", code: "stale_owner" };
  if (!claimedDuringCurrentUtcDay(current, nowMs)) return { kind: "failure", code: "claim_day_elapsed" };
  if (current.routing_generation !== candidate.routingGeneration || current.lease_expires_at_ms <= nowMs) {
    return { kind: "failure", code: "stale_owner" };
  }
  const fences = await readRequiredFences(kv, candidate);
  if (fences.kind === "failure") return { kind: "failure", code: fences.code };

  const usage = await readUsageGate(kv, context.account.accountIdHash);
  if (usage.kind === "failure") return { kind: "failure", code: usage.code };
  const budget = await readDailySubmissionBudget(kv, dailyKey, day, maxPerAccountPerDay);
  if (budget.kind === "failure") return { kind: "failure", code: budget.code };
  const submissionCount = budget.submissionCount;
  // Inventory, fences, and the daily budget are all strong reads. Check
  // again after them so a naturally recovered quota window cannot cross the
  // durable submission boundary or consume the daily budget.
  const nowBeforeCommit = readClock(clock);
  if (nowBeforeCommit === null) return { kind: "failure", code: "invalid_clock" };
  if (!quotaWindowIsOpen(candidate, nowBeforeCommit)) return { kind: "failure", code: "quota_window_expired" };
  if (!claimedDuringCurrentUtcDay(current, nowBeforeCommit)) return { kind: "failure", code: "claim_day_elapsed" };
  const submitted = {
    ...stateWith(current, "submitted", nowMs, { submitted_at_ms: nowMs, last_error_code: null }),
    lease_expires_at_ms: expiresAtMs,
  };
  const nextDaily: CodexResetGlobalDailyRecord = {
    v: 1,
    day,
    submission_count: submissionCount + 1,
    updated_at_ms: nowMs,
  };
  try {
    const committed = await withFenceChecks(kv.atomic().check(entry).check(budget.entry), [...fences.entries, ...usage.entries])
      .set(key, submitted)
      .set(dailyKey, nextDaily)
      .commit();
    if (committed.ok) return { kind: "submitted", record: submitted };
  } catch {
    return { kind: "failure", code: "kv_unavailable" };
  }
  return null;
};

const prepareSubmission = async (
  kv: Kv,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  expected: CodexResetRedemptionRecord,
  nowMs: number,
  clock: () => number,
  maxPerAccountPerDay: number
): Promise<SubmissionPreparation> => {
  const expiresAtMs = leaseUntil(nowMs);
  const day = utcDay(nowMs);
  if (expiresAtMs === null || !day) return { kind: "failure", code: "invalid_clock" };
  const key = codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration);
  const dailyKey = codexResetAccountDailyKey(context.account.accountIdHash, day);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const prepared = await prepareSubmissionAttempt(kv, context, candidate, expected, nowMs, clock, maxPerAccountPerDay, expiresAtMs, day, key, dailyKey);
    if (prepared) return prepared;
  }
  return { kind: "failure", code: "kv_cas_exhausted" };
};

/**
 * Last-moment checks before the renewal CAS: the lease may only be extended
 * while the observed window is still open and inside the claim's UTC day.
 */
const renewalCommitGate = (
  current: CodexResetRedemptionRecord,
  candidate: CodexBankedResetCandidate,
  clock: () => number
): Readonly<{ kind: "ready"; nowMs: number }> | Readonly<{ kind: "failure"; code: string }> => {
  // A slow strong read must not commit a new lease after the observed quota
  // window has naturally reopened.
  const nowMs = readClock(clock);
  if (nowMs === null) return { kind: "failure", code: "invalid_clock" };
  if (!quotaWindowIsOpen(candidate, nowMs)) return { kind: "failure", code: "quota_window_expired" };
  if (!claimedDuringCurrentUtcDay(current, nowMs)) return { kind: "failure", code: "claim_day_elapsed" };
  if (current.lease_expires_at_ms <= nowMs) return { kind: "failure", code: "stale_owner" };
  return { kind: "ready", nowMs };
};

/** The renewed record, or the failure code that stops the lease extension. */
const renewedLeaseRecord = (
  current: CodexResetRedemptionRecord,
  nowMs: number
): Readonly<{ kind: "renewed"; record: CodexResetRedemptionRecord }> | Readonly<{ kind: "failure"; code: string }> => {
  const expiresAtMs = leaseUntil(nowMs);
  const renewedFence = nextFence(current.fence);
  if (expiresAtMs === null) return { kind: "failure", code: "invalid_clock" };
  if (renewedFence === null) return { kind: "failure", code: "owner_fence_exhausted" };
  return {
    kind: "renewed",
    record: {
      ...current,
      fence: renewedFence,
      lease_expires_at_ms: expiresAtMs,
      updated_at_ms: nowMs,
    },
  };
};

/**
 * One compare-and-set attempt of the pre-redeem lease renewal. `null` means the
 * CAS lost and the caller must try again.
 */
const renewSubmittedAttempt = async (
  kv: Kv,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  expected: CodexResetRedemptionRecord,
  clock: () => number,
  key: KvKey
): Promise<SubmissionRenewal | null> => {
  const nowBeforeRead = readClock(clock);
  if (nowBeforeRead === null) return { kind: "failure", code: "invalid_clock" };
  if (!quotaWindowIsOpen(candidate, nowBeforeRead)) return { kind: "failure", code: "quota_window_expired" };

  let entry: KvEntryMaybe<CodexResetRedemptionRecord>;
  try {
    entry = await kv.get<CodexResetRedemptionRecord>(key, { consistency: "strong" });
  } catch {
    return { kind: "failure", code: "kv_unavailable" };
  }
  const current = parseCodexResetRedemptionRecord(entry.value);
  if (!isOwnedRecordInState(current, context, expected, "submitted")) return { kind: "failure", code: "stale_owner" };
  if (current.routing_generation !== candidate.routingGeneration || current.lease_expires_at_ms <= nowBeforeRead) {
    return { kind: "failure", code: "stale_owner" };
  }
  if (!claimedDuringCurrentUtcDay(current, nowBeforeRead)) return { kind: "failure", code: "claim_day_elapsed" };

  const usage = await readUsageGate(kv, context.account.accountIdHash);
  if (usage.kind === "failure") return { kind: "failure", code: usage.code };

  const fences = await readRequiredFences(kv, candidate);
  if (fences.kind === "failure") return { kind: "failure", code: fences.code };

  const gate = renewalCommitGate(current, candidate, clock);
  if (gate.kind === "failure") return { kind: "failure", code: gate.code };
  const renewed = renewedLeaseRecord(current, gate.nowMs);
  if (renewed.kind === "failure") return { kind: "failure", code: renewed.code };
  try {
    const committed = await withFenceChecks(kv.atomic().check(entry), [...fences.entries, ...usage.entries])
      .set(key, renewed.record)
      .commit();
    if (committed.ok) return { kind: "renewed", record: renewed.record };
  } catch {
    return { kind: "failure", code: "kv_unavailable" };
  }
  return null;
};

/**
 * The `submitted` state is intentionally durable before a provider invocation
 * because a process can die after issuing it. Renew ownership again at the
 * last possible moment so a worker paused after `prepareSubmission()` cannot
 * spend a reset after losing its lease, routing fence, or auth-pool fence.
 *
 * There must be no await between a successful return and invoking `redeem`.
 */
const renewSubmittedForRedeem = async (
  kv: Kv,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  expected: CodexResetRedemptionRecord,
  clock: () => number
): Promise<SubmissionRenewal> => {
  const key = codexResetRedemptionKey(context.account.accountIdHash, context.account.quotaGeneration);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const renewed = await renewSubmittedAttempt(kv, context, candidate, expected, clock, key);
    if (renewed) return renewed;
  }
  return { kind: "failure", code: "kv_cas_exhausted" };
};

const receiptId = (value: unknown): string | null => (isNonEmptyText(value, 512) ? value : null);

/**
 * Receipt identifiers are optional optimization hints: reconciliation is
 * required to work by deterministic idempotency key. Keep an unapproved
 * receipt in process memory only, never in the durable record or telemetry.
 */
const durableReceiptId = (provider: Pick<CodexUsageResetProvider, "contract">, value: unknown): string | null =>
  providerReceiptIdsSafeToPersistAndLog(provider) ? receiptId(value) : null;

const validInventory = (inventory: unknown, nowMs: number): inventory is ResetInventory =>
  isRecord(inventory) &&
  isSafeNonnegativeInteger(inventory.availableCount) &&
  isSafeMs(inventory.observedAtMs) &&
  Array.isArray(inventory.credits) &&
  inventory.observedAtMs <= nowMs &&
  nowMs - inventory.observedAtMs <= CODEX_BANKED_RESET_INVENTORY_MAX_AGE_MS &&
  inventory.credits.every(
    (credit) =>
      isRecord(credit) &&
      isNonEmptyText(credit.id, 512) &&
      isNonEmptyText(credit.status, 128) &&
      isNonEmptyText(credit.resetType, 128) &&
      (credit.expiresAtMs === null || isSafeMs(credit.expiresAtMs))
  ) &&
  // The production adapter rejects duplicate opaque IDs. Retain that same
  // invariant at the evaluator boundary so an injected or future provider
  // cannot make an ambiguous inventory look selectable.
  new Set(inventory.credits.map((credit) => credit.id)).size === inventory.credits.length &&
  inventory.credits.filter((credit) => credit.status === "available").length === inventory.availableCount;

type InventoryCreditSelection =
  Readonly<{ kind: "selected"; credit: ResetInventoryCredit }> | Readonly<{ kind: "empty" }> | Readonly<{ kind: "no_eligible_credit" }>;

/**
 * The only selectable credits are explicit, currently valid Codex
 * rate-limit credits. Finite expiry wins over non-expiring credits; callers
 * add the account slot as the next global tie-breaker.
 */
const selectInventoryCredit = (inventory: ResetInventory, provider: CodexUsageResetProvider, nowMs: number): InventoryCreditSelection => {
  if (inventory.availableCount === 0) return { kind: "empty" };
  const candidates = inventory.credits.filter(
    (credit) =>
      credit.status === "available" &&
      credit.resetType === "codex_rate_limits" &&
      providerSupportsResetType(provider, credit.resetType) &&
      (credit.expiresAtMs === null || credit.expiresAtMs > nowMs)
  );
  if (!candidates.length) return { kind: "no_eligible_credit" };
  candidates.sort((left, right) => {
    const leftExpiry = left.expiresAtMs ?? Number.POSITIVE_INFINITY;
    const rightExpiry = right.expiresAtMs ?? Number.POSITIVE_INFINITY;
    return leftExpiry - rightExpiry || left.id.localeCompare(right.id);
  });
  const best = candidates.at(0);
  if (!best) return { kind: "no_eligible_credit" };
  return { kind: "selected", credit: best };
};

const validRedeemResult = (value: unknown): value is RedeemResetResult => {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "completed":
    case "accepted":
    case "already_redeemed":
      return receiptId(value.providerReceiptId) !== null;
    case "rejected":
      return typeof value.reason === "string";
    case "unknown":
      return value.providerReceiptId === null || receiptId(value.providerReceiptId) !== null;
    default:
      return false;
  }
};

const stateWith = (
  record: CodexResetRedemptionRecord,
  state: CodexResetRedemptionState,
  nowMs: number,
  patch: Partial<Pick<CodexResetRedemptionRecord, "provider_receipt_id" | "submitted_at_ms" | "verified_at_ms" | "last_error_code">> = {}
): CodexResetRedemptionRecord => ({
  ...record,
  ...patch,
  state,
  updated_at_ms: nowMs,
});

const rejectOwned = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  nowMs: number,
  code: string
): Promise<CodexResetRedemptionRecord | null> =>
  await updateOwnedRecord(kv, context, record, (current) => stateWith(current, "rejected", nowMs, { last_error_code: code }));

const unknownOwned = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  nowMs: number,
  code: string,
  providerReceiptId: string | null
): Promise<CodexResetRedemptionRecord | null> =>
  await updateOwnedRecord(kv, context, record, (current) =>
    stateWith(current, "unknown", nowMs, {
      provider_receipt_id: providerReceiptId ?? current.provider_receipt_id,
      last_error_code: code,
    })
  );

const preserveReceipt = async (
  kv: Kv,
  context: ResetContext,
  record: CodexResetRedemptionRecord,
  nowMs: number,
  providerReceiptId: string | null
): Promise<CodexResetRedemptionRecord | null> =>
  await updateOwnedRecord(kv, context, record, (current) =>
    stateWith(current, "submitted", nowMs, {
      provider_receipt_id: providerReceiptId,
      submitted_at_ms: current.submitted_at_ms ?? nowMs,
      last_error_code: null,
    })
  );

const unknownOutcome = (
  telemetry: CodexBankedResetTelemetry,
  context: ResetContext,
  candidate: CodexBankedResetCandidate,
  reason: string,
  record: CodexResetRedemptionRecord
): CodexBankedResetOutcome => {
  emit(telemetry, "codex_reset_unknown", telemetryFields(context, candidate, { state: record.state, reason }));
  metric(telemetry, "codex_reset_unknown_total", 1, telemetryFields(context, candidate, {}));
  return outcome("pending", reason, context, record);
};

const liveSubmissionPolicyReason = (dependencies: CodexBankedResetDependencies): string | null => {
  return loadLiveSubmissionConfig(dependencies).reason;
};

const loadLiveSubmissionConfig = (
  dependencies: CodexBankedResetDependencies
): Readonly<{ config: CodexBankedResetConfig; reason: null }> | Readonly<{ config: null; reason: string }> => {
  let config: CodexBankedResetConfig;
  try {
    config = dependencies.reloadConfig?.() ?? dependencies.config;
  } catch {
    return { config: null, reason: "configuration_unavailable" };
  }
  const reason = policyReason(config) ?? providerPolicyReason(config, dependencies.provider);
  return reason || config.mode !== "live" ? { config: null, reason: reason ?? "mode_not_live" } : { config, reason: null };
};

export type { ClaimResult };
export {
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
  readCurrentFences,
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
  withFenceChecks,
};
