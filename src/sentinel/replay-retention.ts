import type { AtomicOperation, Kv, KvEntryMaybe, KvKey } from "#kv";
/**
 * Durable, concurrency-safe retention accounting for capture-owned data.
 *
 * One fixed per-host budget covers the encoded KV payload this feature retains
 * (base64-expanded ciphertext chunks, metadata, status/dedupe/index row
 * overhead) plus in-progress reservations. It is not a bound on the shared
 * SQLite database, WAL or unrelated namespaces.
 *
 * Source of truth: one durable accounting row per capture under
 * ["uos_ai","sentinel_replay","v1","accounting", captured_at_ms, capture_id].
 * The timestamp-first key order IS the oldest-first index; there is no second
 * index namespace. Accounting rows carry NO `expireIn`: they are the durable
 * record of retained bytes and a row stops existing only through one atomic
 * commit that deletes it and decrements the ledger in the same operation.
 *
 * The ledger under SENTINEL_REPLAY_BUDGET_LEDGER_KEY is derived cached state and
 * is never the source of truth. Every accounting mutation (admit, publish,
 * revoke, release, evict, expire, status admit/prune) is ONE kv.atomic() commit
 * that checks the exact versionstamp of BOTH the accounting/status row it
 * mutates AND the ledger, and writes both. A ledger delta is never applied in a
 * commit separate from the row change it describes.
 *
 * State machine:
 *   reserved --publish--> stored --evict--> (row deleted, ledger stored_bytes-=,
 *                                            records-=, evicted_*+=)
 *   reserved --revoke--> revoked --release--> (row deleted, reserved_bytes-=)
 *   stored --expire--> (row deleted, records-=, NO evicted_* increment)
 *
 * This module owns the runtime path only; the durable row/ledger schema lives in
 * replay-retention-schema.ts and the resumable pre-accounting sweep lives in
 * replay-retention-bootstrap.ts, so neither is duplicated here.
 *
 * Fencing: a writer advances `stage` through a CAS that requires
 * state==="reserved", its own fence and an unexpired row before each bounded
 * chunk batch; a reaper revoking the same row increments the fence, so a paused
 * writer can never advance again and can never publish.
 */
import {
  SENTINEL_REPLAY_DEDUPE_PREFIX,
  SENTINEL_REPLAY_REQUEST_PREFIX,
  SENTINEL_REPLAY_STATUS_TTL_MS,
  SENTINEL_REPLAY_TTL_MS,
  type SentinelReplayCaptureStatusRow,
} from "./replay-model.ts";
import { SENTINEL_REPLAY_MAX_RECORDS, SENTINEL_REPLAY_MAX_STATUS_RECORDS, sentinelReplayReservationBytes } from "./replay-limits.ts";
import { isSentinelReplayCaptureStatusRow } from "./replay-observation.ts";
import { isSentinelReplayManifest } from "./replay-read.ts";
import { bootstrapBeforeMutation, forgetChunkOwnerIndex, releaseLegacyReservation, runBootstrapBatch } from "./replay-retention-bootstrap.ts";
import { metadataEntryMatches, reconcileSentinelReplayStatusMetadata, reconcileSentinelReplayStatusMetadataIfDue } from "./replay-retention-metadata.ts";
import {
  accountingKeyMatches,
  CAS_ATTEMPTS,
  commitAccountingMutation,
  countChunks,
  deleteChunkBatch,
  EVICTION_BATCH_RECORDS,
  EVICTION_MAX_CHUNK_DELETES,
  fault,
  isAccountingRow,
  isLegacyReservation,
  manifestKeyMatches,
  readLedger,
  readSentinelReplayRetentionStatus,
  RESERVATION_REAP_LIMIT,
  SENTINEL_REPLAY_ACCOUNTING_PREFIX,
  SENTINEL_REPLAY_ACCOUNTING_REASON,
  SENTINEL_REPLAY_BUDGET_LEDGER_KEY,
  SENTINEL_REPLAY_CLEAN_TARGET_RATIO,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  SENTINEL_REPLAY_EVICTION_REASON,
  SENTINEL_REPLAY_EXPIRED_REASON,
  SENTINEL_REPLAY_RESERVATION_PREFIX,
  SENTINEL_REPLAY_RESERVATION_TTL_MS,
  SENTINEL_REPLAY_STORAGE_FULL_REASON,
  sentinelReplayAccountingKey,
  sentinelReplayBudgetBytes,
  sentinelReplayEvictionKey,
  sentinelReplayManifestKey,
  sentinelReplayMetadataReserve,
  sentinelReplayPayloadBudgetBytes,
  sentinelReplayRequestStatusKey,
  sentinelReplayStatusMetadataBytes,
  STATUS_PRUNE_BATCH,
  storedStatusMetadataBytes,
  type SentinelReplayAccountingRow,
  type SentinelReplayAdmission,
  type SentinelReplayBudgetLedger,
  type SentinelReplayClaimKind,
  type SentinelReplayPublication,
  type SentinelReplayRetentionStatus,
  withBudget,
} from "./replay-retention-schema.ts";

/**
 * Admit one bounded status/tombstone row through a CAS on the ledger's
 * status_records/metadata_bytes counters. When either bound is exceeded the
 * oldest capture-owned status/tombstone rows are pruned first.
 */
export const admitSentinelReplayStatusMetadata = async (
  kv: Kv,
  input: Readonly<{ key: KvKey; row: unknown; now_ms: number; ttl_ms: number; budget_bytes?: number }>
): Promise<boolean> => {
  const budgetBytes = Math.max(64 * 1_024, Math.trunc(input.budget_bytes ?? sentinelReplayBudgetBytes()));
  const reserve = sentinelReplayMetadataReserve(budgetBytes);
  const bytes = sentinelReplayStatusMetadataBytes(input.row);
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    // The sweep counts every in-scope row, so until it has finished no row may
    // also be counted by its own admission, or the same row is charged twice.
    if ((await bootstrapBeforeMutation(kv, budgetBytes, input.now_ms)) === null) return false;
    await pruneCaptureOwnedStatusMetadata(kv, input.now_ms, 1, bytes, 1, budgetBytes);
    // The bound tracks the LIVE row set, so replacing the row already stored at
    // this key adds one record and the byte difference, never a second full
    // charge. Checking the exact versionstamp of the replaced row keeps that
    // delta true while another writer touches the same key.
    const [current, existing] = await Promise.all([readLedger(kv, budgetBytes), kv.get(input.key)]);
    if (current.kind === "corrupt") return false;
    const ledger = withBudget(current.ledger, budgetBytes);
    const addedRecords = existing.value === null ? 1 : 0;
    const addedBytes = bytes - storedStatusMetadataBytes(existing.value);
    if (ledger.status_records + addedRecords > SENTINEL_REPLAY_MAX_STATUS_RECORDS || ledger.metadata_bytes + addedBytes > reserve) return false;
    const next: SentinelReplayBudgetLedger = {
      ...ledger,
      status_records: ledger.status_records + addedRecords,
      metadata_bytes: Math.max(0, ledger.metadata_bytes + addedBytes),
    };
    const committed = await kv
      .atomic()
      .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: current.versionstamp })
      .check({ key: input.key, versionstamp: existing.versionstamp })
      .set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, next)
      .set(input.key, input.row, { expireIn: input.ttl_ms })
      .commit();
    if (committed.ok) return true;
  }
  return false;
};

type StatusCandidate = Readonly<{ key: KvKey; versionstamp: string; bytes: number; captured_at_ms: number }>;

const statusCandidates = async (kv: Kv): Promise<StatusCandidate[] | null> => {
  const candidates: StatusCandidate[] = [];
  for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_REQUEST_PREFIX })) {
    if (!isSentinelReplayCaptureStatusRow(entry.value) || !metadataEntryMatches(entry, SENTINEL_REPLAY_REQUEST_PREFIX)) return null;
    candidates.push({
      key: entry.key,
      versionstamp: entry.versionstamp,
      bytes: sentinelReplayStatusMetadataBytes(entry.value),
      captured_at_ms: entry.value.captured_at_ms,
    });
  }
  for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_EVICTION_PREFIX })) {
    if (!metadataEntryMatches(entry, SENTINEL_REPLAY_EVICTION_PREFIX)) return null;
    const value = entry.value as { evicted_at_ms: number };
    candidates.push({
      key: entry.key,
      versionstamp: entry.versionstamp,
      bytes: sentinelReplayStatusMetadataBytes(value),
      captured_at_ms: value.evicted_at_ms,
    });
  }
  return candidates.sort((left, right) => left.captured_at_ms - right.captured_at_ms);
};

/** Prune the oldest capture-owned status/tombstone rows until `extra` fits the bound. */
export const pruneCaptureOwnedStatusMetadata = async (
  kv: Kv,
  nowMs: number,
  extraRecords: number,
  extraBytes: number,
  maxDeletes: number,
  budgetBytesOverride?: number
): Promise<number> => {
  const budgetBytes = Math.max(64 * 1_024, Math.trunc(budgetBytesOverride ?? sentinelReplayBudgetBytes()));
  const reserve = sentinelReplayMetadataReserve(budgetBytes);
  const initial = await readLedger(kv, budgetBytes);
  if (initial.kind === "corrupt") return 0;
  const ledger = withBudget(initial.ledger, budgetBytes);
  if (ledger.status_records + extraRecords <= SENTINEL_REPLAY_MAX_STATUS_RECORDS && ledger.metadata_bytes + extraBytes <= reserve) return 0;
  if ((await reconcileSentinelReplayStatusMetadata(kv, budgetBytes)) === "failed") return 0;
  let deleted = 0;
  for (const candidate of (await statusCandidates(kv)) ?? []) {
    if (deleted >= maxDeletes) break;
    const state = await readLedger(kv, budgetBytes);
    if (state.kind === "corrupt") break;
    const current = withBudget(state.ledger, budgetBytes);
    if (current.status_records + extraRecords <= SENTINEL_REPLAY_MAX_STATUS_RECORDS && current.metadata_bytes + extraBytes <= reserve) break;
    const next: SentinelReplayBudgetLedger = {
      ...current,
      status_records: Math.max(0, current.status_records - 1),
      metadata_bytes: Math.max(0, current.metadata_bytes - candidate.bytes),
      status_pruned_records: current.status_pruned_records + 1,
      last_warning_at_ms: nowMs,
    };
    const committed = await kv
      .atomic()
      .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: state.versionstamp })
      .check({ key: candidate.key, versionstamp: candidate.versionstamp })
      .set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, next)
      .delete(candidate.key)
      .commit();
    if (committed.ok) deleted += 1;
  }
  return deleted;
};

/** Fenced staging: advance `stage` before a batch of chunks may be written. */
export const advanceSentinelReplayStagingFence = async (
  kv: Kv,
  input: Readonly<{ accounting_key: KvKey; fence: number; now_ms: number; budget_bytes?: number }>
): Promise<Readonly<{ ok: true; stage: number; versionstamp: string }> | Readonly<{ ok: false; reason: "revoked" | "expired" | "missing" }>> => {
  const budgetBytes = Math.max(64 * 1_024, Math.trunc(input.budget_bytes ?? sentinelReplayBudgetBytes()));
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<SentinelReplayAccountingRow>(input.accounting_key);
    if (!isAccountingRow(entry.value) || !accountingKeyMatches(input.accounting_key, entry.value)) {
      return { ok: false, reason: "missing" };
    }
    const row = entry.value;
    if (row.state === "revoked") return { ok: false, reason: "revoked" };
    if (row.state !== "reserved") return { ok: false, reason: "missing" };
    if (row.fence !== input.fence) return { ok: false, reason: "revoked" };
    if (row.expires_at_ms <= input.now_ms) return { ok: false, reason: "expired" };
    const state = await readLedger(kv, budgetBytes);
    if (state.kind === "corrupt") return { ok: false, reason: "missing" };
    const next: SentinelReplayAccountingRow = { ...row, stage: row.stage + 1 };
    const committed = await kv
      .atomic()
      .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: state.versionstamp })
      .check({ key: input.accounting_key, versionstamp: entry.versionstamp })
      .set(input.accounting_key, next)
      .commit();
    if (committed.ok) return { ok: true, stage: next.stage, versionstamp: committed.versionstamp };
  }
  return { ok: false, reason: "missing" };
};

/** Everything one publish attempt must re-verify before it may write anything. */
type PublishAttemptContext = Readonly<{
  accountingKey: KvKey;
  accounting: SentinelReplayAccountingRow;
  actualCharge: number;
  payloadBudget: number;
  reserve: number;
  /** Net record and byte movement of the status row this attempt replaces. */
  statusRecordsDelta: number;
  statusBytesDelta: number;
  leaseNowMs: number;
}>;

/**
 * Read the metadata bounds and, when the record cap or the byte reserve would be
 * exceeded, prune the oldest capture-owned status rows first. Returns the metadata
 * reserve, or null when the ledger is corrupt and cannot be trusted.
 */
const prepareStatusMetadataRoom = async (kv: Kv, budgetBytes: number, statusBytes: number, nowMs: number): Promise<number | null> => {
  const state = await readLedger(kv, budgetBytes);
  if (state.kind === "corrupt") return null;
  const ledger = withBudget(state.ledger, budgetBytes);
  const reserve = sentinelReplayMetadataReserve(budgetBytes);
  const tooManyRecords = ledger.status_records + 1 > SENTINEL_REPLAY_MAX_STATUS_RECORDS;
  const tooManyBytes = ledger.metadata_bytes + statusBytes > reserve;
  if (tooManyRecords || tooManyBytes) await pruneCaptureOwnedStatusMetadata(kv, nowMs, 1, statusBytes, STATUS_PRUNE_BATCH, budgetBytes);
  return reserve;
};

/**
 * Re-verify the reservation against the live row and ledger for one publish
 * attempt. The row must still be this writer's unexpired `reserved` row with its
 * original identity, the actual charge must fit both the reservation that was
 * already held back and the payload budget, and the status row must fit the
 * metadata reserve. Returns null when the reservation may no longer publish.
 */
const publishAttemptRow = (
  entry: KvEntryMaybe<SentinelReplayAccountingRow>,
  ledger: SentinelReplayBudgetLedger,
  context: PublishAttemptContext
): SentinelReplayAccountingRow | null => {
  if (!isAccountingRow(entry.value) || !accountingKeyMatches(context.accountingKey, entry.value)) return null;
  const row = entry.value;
  if (row.state !== "reserved") return null;
  if (row.fence !== context.accounting.fence) return null;
  if (row.expires_at_ms <= context.leaseNowMs) return null;
  if (row.created_at_ms !== context.accounting.created_at_ms) return null;
  if (!Number.isSafeInteger(context.actualCharge) || context.actualCharge <= 0) return null;
  if (context.actualCharge > row.bytes) return null;
  if (ledger.reserved_bytes < row.bytes) return null;
  if (ledger.records + 1 > SENTINEL_REPLAY_MAX_RECORDS) return null;
  // The published charge must fit what the reservation already held back: the
  // reserved charge is released in the same commit that stores the actual one.
  if (ledger.stored_bytes + ledger.reserved_bytes - row.bytes + context.actualCharge > context.payloadBudget) return null;
  if (ledger.status_records + context.statusRecordsDelta > SENTINEL_REPLAY_MAX_STATUS_RECORDS) return null;
  if (ledger.metadata_bytes + context.statusBytesDelta > context.reserve) return null;
  return row;
};

/**
 * Read the fresh ledger and accounting row for a publish attempt. Returns null
 * unless the row is still `reserved` at the writer's fence, unexpired, and the
 * actual charge fits both the row's own bound and the payload budget.
 */
export const prepareSentinelReplayPublication = async (
  kv: Kv,
  accounting: SentinelReplayAccountingRow,
  accountingKey: KvKey,
  actualCharge: number,
  options: Readonly<{
    /** Frozen capture time used to keep published expiry aligned with the manifest. */
    now_ms: number;
    /** Fresh wall-clock time used only to validate the reservation lease. */
    lease_now_ms: number;
    status_key: KvKey;
    status_bytes?: number;
    budget_bytes?: number;
  }>
): Promise<SentinelReplayPublication | null> => {
  const budgetBytes = Math.max(64 * 1_024, Math.trunc(options.budget_bytes ?? sentinelReplayBudgetBytes()));
  const payloadBudget = sentinelReplayPayloadBudgetBytes(budgetBytes);
  const statusBytes = Math.max(0, Math.trunc(options.status_bytes ?? 0));
  const reserve = await prepareStatusMetadataRoom(kv, budgetBytes, statusBytes, options.now_ms);
  if (reserve === null) return null;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const [entry, ledgerState, statusEntry] = await Promise.all([
      kv.get<SentinelReplayAccountingRow>(accountingKey),
      readLedger(kv, budgetBytes),
      kv.get(options.status_key),
    ]);
    if (ledgerState.kind === "corrupt") return null;
    const ledger = withBudget(ledgerState.ledger, budgetBytes);
    // Publishing replaces the request own status row, so the metadata bound moves
    // by the difference instead of charging a second full row for it.
    const statusRecordsDelta = statusEntry.value === null ? 1 : 0;
    const statusBytesDelta = statusBytes - storedStatusMetadataBytes(statusEntry.value);
    const row = publishAttemptRow(entry, ledger, {
      accountingKey,
      accounting,
      actualCharge,
      payloadBudget,
      reserve,
      statusRecordsDelta,
      statusBytesDelta,
      leaseNowMs: options.lease_now_ms,
    });
    if (row === null) return null;
    const stored = ledger.stored_bytes + actualCharge;
    const nextLedger: SentinelReplayBudgetLedger = {
      ...ledger,
      reserved_bytes: Math.max(0, ledger.reserved_bytes - row.bytes),
      stored_bytes: stored,
      records: ledger.records + 1,
      status_records: Math.max(0, ledger.status_records + statusRecordsDelta),
      metadata_bytes: Math.max(0, ledger.metadata_bytes + statusBytesDelta),
      over_budget: stored > payloadBudget,
      last_warning_at_ms: stored > payloadBudget ? options.now_ms : ledger.last_warning_at_ms,
    };
    // The short reservation lease becomes the payload TTL only here, at publish.
    const nextRow: SentinelReplayAccountingRow = {
      ...row,
      state: "stored",
      bytes: actualCharge,
      expires_at_ms: options.now_ms + SENTINEL_REPLAY_TTL_MS,
      status_expires_at_ms: options.now_ms + SENTINEL_REPLAY_STATUS_TTL_MS,
    };
    return {
      ledger_key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY,
      ledger_versionstamp: ledgerState.versionstamp,
      ledger: nextLedger,
      accounting_key: accountingKey,
      accounting_versionstamp: entry.versionstamp,
      accounting: nextRow,
      status_key: options.status_key,
      status_versionstamp: statusEntry.versionstamp,
    };
  }
  return null;
};

/**
 * Fence a `reserved` row so its writer can never stage or publish again, and
 * report the row cleanup should act on. A row that already published (`stored`)
 * or was already claimed (`evicting`) is NOT revoked here: releasing its charge is
 * the ordinary eviction/TTL path's job, never this cleanup's.
 */
const revokeReservedAccounting = async (
  kv: Kv,
  accounting: SentinelReplayAccountingRow,
  accountingKey: KvKey
): Promise<Readonly<{ row: SentinelReplayAccountingRow; revoked: boolean }>> => {
  if (accounting.state === "revoked") return { row: accounting, revoked: true };
  if (accounting.state !== "reserved") return { row: accounting, revoked: false };
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<SentinelReplayAccountingRow>(accountingKey);
    if (!isAccountingRow(entry.value) || entry.value.fence !== accounting.fence) break;
    if (entry.value.state === "revoked") return { row: entry.value, revoked: true };
    if (entry.value.state === "stored") return { row: entry.value, revoked: false };
    if (entry.value.state !== "reserved") break;
    const next: SentinelReplayAccountingRow = { ...entry.value, state: "revoked", fence: entry.value.fence + 1 };
    const committed = await kv.atomic().check({ key: accountingKey, versionstamp: entry.versionstamp }).set(accountingKey, next).commit();
    if (committed.ok) return { row: next, revoked: true };
  }
  return { row: accounting, revoked: false };
};

/**
 * Revoke a reservation or resume an `evicting` row: fence it, delete its staged
 * chunks in bounded batches, and release the charge ONLY when a fresh list over
 * the chunk prefix returns zero entries. A partial deletion leaves the row
 * revoked/evicting with its charge held for a later pass.
 */
export const abandonSentinelReplayAccounting = async (
  kv: Kv,
  accounting: SentinelReplayAccountingRow,
  accountingKey: KvKey,
  options: Readonly<{ now_ms: number; max_chunk_deletes?: number; budget_bytes?: number }>
): Promise<Readonly<{ revoked: boolean; deleted_chunks: number; released: boolean; remaining: number }>> => {
  const budgetBytes = Math.max(64 * 1_024, Math.trunc(options.budget_bytes ?? sentinelReplayBudgetBytes()));
  const maxDeletes = Math.max(1, options.max_chunk_deletes ?? EVICTION_MAX_CHUNK_DELETES);
  const { row: current, revoked } = await revokeReservedAccounting(kv, accounting, accountingKey);
  if (!revoked) return { revoked: false, deleted_chunks: 0, released: false, remaining: 0 };
  const cleanup = await deleteChunkBatch(kv, current.capture_id, maxDeletes);
  const remaining = cleanup.remaining > 0 ? cleanup.remaining : await countChunks(kv, current.capture_id);
  if (remaining > 0) return { revoked: true, deleted_chunks: cleanup.deleted, released: false, remaining };
  // Release the charge only in the same commit that deletes the row, and only
  // when a fresh listing proves no chunk survives.
  let released = false;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const entry = await kv.get<SentinelReplayAccountingRow>(accountingKey);
    if (!isAccountingRow(entry.value) || entry.value.fence !== current.fence) break;
    // Bind the narrowed row: TypeScript does not carry a property narrowing into
    // the mutation closure, and no assertion should be needed for that.
    const releasedRow: SentinelReplayAccountingRow = entry.value;
    released = await commitAccountingMutation(
      kv,
      accountingKey,
      entry.versionstamp,
      (ledger) => ({ ...ledger, reserved_bytes: Math.max(0, ledger.reserved_bytes - releasedRow.bytes) }),
      (operation) => operation.delete(accountingKey),
      budgetBytes
    );
    if (released) break;
  }
  return { revoked: true, deleted_chunks: cleanup.deleted, released, remaining: 0 };
};

/** Find fenced/abandoned rows with bounded work and a durable prefix cursor. */
// Keep the cursor outside the accounting prefix so discovery never counts it as a row.
const SENTINEL_REPLAY_REAP_CURSOR_KEY = ["uos_ai", "sentinel_replay", "v1", "reap_cursor"] as const;
const reapCandidates = async (kv: Kv, nowMs: number, limit: number): Promise<Readonly<{ key: KvKey; row: SentinelReplayAccountingRow }>[]> => {
  const cursorEntry = await kv.get<string>(SENTINEL_REPLAY_REAP_CURSOR_KEY);
  const cursor = typeof cursorEntry.value === "string" && cursorEntry.value.length > 0 ? cursorEntry.value : undefined;
  const iterator = kv.list<SentinelReplayAccountingRow>({ prefix: SENTINEL_REPLAY_ACCOUNTING_PREFIX }, { cursor, limit: limit * 4 });
  const found: { key: KvKey; row: SentinelReplayAccountingRow }[] = [];
  const isCandidate = (row: SentinelReplayAccountingRow): boolean => row.state === "revoked" || (row.state === "reserved" && row.expires_at_ms <= nowMs);
  for await (const entry of iterator) {
    if (isAccountingRow(entry.value) && accountingKeyMatches(entry.key, entry.value) && isCandidate(entry.value)) {
      found.push({ key: entry.key, row: entry.value });
    }
    if (found.length >= limit) break;
  }
  const nextCursor = iterator.cursor || null;
  const operation = kv.atomic().check({ key: SENTINEL_REPLAY_REAP_CURSOR_KEY, versionstamp: cursorEntry.versionstamp });
  const committed = nextCursor === null ? operation.delete(SENTINEL_REPLAY_REAP_CURSOR_KEY) : operation.set(SENTINEL_REPLAY_REAP_CURSOR_KEY, nextCursor);
  await committed.commit();
  return found;
};

const reapAccountingRows = async (kv: Kv, nowMs: number, budgetBytes: number): Promise<number> => {
  const candidates = await reapCandidates(kv, nowMs, RESERVATION_REAP_LIMIT);
  let reaped = 0;
  for (const candidate of candidates) {
    const result = await abandonSentinelReplayAccounting(kv, candidate.row, candidate.key, { now_ms: nowMs, budget_bytes: budgetBytes });
    if (result.revoked) reaped += 1;
  }
  // A victim whose final commit failed keeps its charge and is resumed here.
  reaped += await resumeEvictingRows(kv, nowMs, budgetBytes, RESERVATION_REAP_LIMIT);
  return reaped;
};

const reapLegacyReservations = async (kv: Kv, budgetBytes: number): Promise<number> => {
  let reaped = 0;
  for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_RESERVATION_PREFIX }, { limit: RESERVATION_REAP_LIMIT })) {
    if (!isLegacyReservation(entry.value)) continue;
    await releaseLegacyReservation(kv, entry.key, entry.value, budgetBytes);
    reaped += 1;
  }
  return reaped;
};

const recordSkipReason = async (kv: Kv, reason: string | null, nowMs: number, budgetBytes: number): Promise<void> => {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const state = await readLedger(kv, budgetBytes);
    if (state.kind === "corrupt") return;
    const ledger = withBudget(state.ledger, budgetBytes);
    const next: SentinelReplayBudgetLedger = {
      ...ledger,
      last_skip_reason: reason,
      last_full_at_ms: reason === SENTINEL_REPLAY_STORAGE_FULL_REASON ? nowMs : ledger.last_full_at_ms,
      last_warning_at_ms: reason === null ? ledger.last_warning_at_ms : nowMs,
    };
    const committed = await kv
      .atomic()
      .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: state.versionstamp })
      .set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, next)
      .commit();
    if (committed.ok) return;
  }
};

/**
 * Delete a claimed victim's manifest and, only when the dedupe row still
 * references that exact manifest key, its dedupe row. The CAS is what stops an
 * old capture's eviction from deleting a newer capture that shares the
 * fingerprint, and a manifest that no longer matches the claim is left alone.
 */
const deleteClaimedVictimPayload = async (kv: Kv, row: SentinelReplayAccountingRow, manifestKey: KvKey): Promise<void> => {
  const manifestEntry = await kv.get(manifestKey);
  if (manifestEntry.value !== null || manifestEntry.versionstamp !== null) {
    if (!isSentinelReplayManifest(manifestEntry.value)) return;
    if (!manifestKeyMatches(manifestKey, manifestEntry.value) || manifestEntry.value.fingerprint !== row.fingerprint) return;
    fault("delete");
    await kv.delete(manifestKey);
  }
  const dedupeKey = [...SENTINEL_REPLAY_DEDUPE_PREFIX, row.fingerprint];
  const dedupeEntry = await kv.get<{ manifest_key?: unknown }>(dedupeKey);
  if (!Array.isArray(dedupeEntry.value?.manifest_key)) return;
  if (dedupeEntry.value.manifest_key.length !== 7) return;
  if (dedupeEntry.value.manifest_key.join("\u0000") !== manifestKey.join("\u0000")) return;
  await kv.atomic().check({ key: dedupeKey, versionstamp: dedupeEntry.versionstamp }).delete(dedupeKey).commit();
};

/**
 * The ledger transition for one finalized victim: release exactly its charge and
 * count it as either evicted or expired. Status/tombstone counters move only when
 * `statusFits`, because the metadata reserve is a hard bound even during cleanup.
 */
const finalizedLedger = (
  ledger: SentinelReplayBudgetLedger,
  row: SentinelReplayAccountingRow,
  kind: "evicted" | "expired",
  nowMs: number,
  budgetBytes: number,
  statusRecordsDelta: number,
  metadataBytesDelta: number
): SentinelReplayBudgetLedger => {
  const stored = Math.max(0, ledger.stored_bytes - row.bytes);
  return {
    ...ledger,
    stored_bytes: stored,
    records: Math.max(0, ledger.records - 1),
    status_records: Math.max(0, ledger.status_records + statusRecordsDelta),
    metadata_bytes: Math.max(0, ledger.metadata_bytes + metadataBytesDelta),
    evicted_bytes: kind === "evicted" ? ledger.evicted_bytes + row.bytes : ledger.evicted_bytes,
    evicted_records: kind === "evicted" ? ledger.evicted_records + 1 : ledger.evicted_records,
    expired_bytes: kind === "expired" ? ledger.expired_bytes + row.bytes : ledger.expired_bytes,
    expired_records: kind === "expired" ? ledger.expired_records + 1 : ledger.expired_records,
    last_eviction_at_ms: kind === "evicted" ? nowMs : ledger.last_eviction_at_ms,
    over_budget: stored > sentinelReplayPayloadBudgetBytes(budgetBytes),
  };
};

/** Ownerless legacy victims retain a tombstone without inventing a request-status row. */
const applyClaimedVictimMetadata = (
  operation: AtomicOperation,
  existingStatus: KvEntryMaybe<unknown> | null,
  statusRow: SentinelReplayCaptureStatusRow,
  tombstoneKey: KvKey,
  tombstone: Readonly<Record<string, unknown>>,
  statusFits: boolean
): AtomicOperation => {
  let applied = operation;
  if (existingStatus !== null) {
    applied = applied.check({ key: existingStatus.key, versionstamp: existingStatus.versionstamp }).delete(existingStatus.key);
  }
  if (!statusFits) return applied;
  applied = applied.set(tombstoneKey, tombstone, { expireIn: SENTINEL_REPLAY_STATUS_TTL_MS });
  return existingStatus === null ? applied : applied.set(existingStatus.key, statusRow, { expireIn: SENTINEL_REPLAY_STATUS_TTL_MS });
};

/**
 * Delete one already-claimed victim's payload and release its charge in a single
 * atomic commit. The charge is released only after a fresh listing proves the
 * chunk prefix is empty, so a partial deletion never frees capacity.
 */
const finalizeClaimedVictim = async (
  kv: Kv,
  key: KvKey,
  row: SentinelReplayAccountingRow,
  nowMs: number,
  budgetBytes: number,
  maxChunkDeletes = EVICTION_MAX_CHUNK_DELETES
): Promise<Readonly<{ finalized: boolean; chunks: number }>> => {
  const kind = row.claim_kind;
  if (kind === undefined) return { finalized: false, chunks: 0 };
  const reason = kind === "evicted" ? SENTINEL_REPLAY_EVICTION_REASON : SENTINEL_REPLAY_EXPIRED_REASON;
  const cleanup = await deleteChunkBatch(kv, row.capture_id, maxChunkDeletes);
  const remaining = cleanup.remaining > 0 ? cleanup.remaining : await countChunks(kv, row.capture_id);
  if (remaining > 0) return { finalized: false, chunks: cleanup.deleted };
  const manifestKey = sentinelReplayManifestKey({
    version: 1,
    capture_id: row.capture_id,
    fingerprint: row.fingerprint,
    case_group_digest: "",
    captured_at_ms: row.created_at_ms,
    expires_at_ms: row.expires_at_ms,
    algorithm: "AES-256-GCM",
    compression: "gzip",
    iv: "",
    chunk_count: 0,
    ciphertext_bytes: 0,
  });
  await deleteClaimedVictimPayload(kv, row, manifestKey);
  const statusRow: SentinelReplayCaptureStatusRow = {
    version: 1,
    request_id: row.request_id,
    status: kind,
    reason,
    captured_at_ms: row.created_at_ms,
    manifest_key: null,
    fingerprint: null,
    expires_at_ms: null,
  };
  const tombstone = {
    version: 1,
    fingerprint: row.fingerprint,
    request_id: row.request_id,
    evicted_at_ms: nowMs,
    reason,
  };
  const statusKey = sentinelReplayRequestStatusKey(row.request_id);
  const hasOwner = row.request_id !== "";
  const statusRows = hasOwner ? 2 : 1;
  const tombstoneKey = sentinelReplayEvictionKey(row.fingerprint);
  const statusBytes = (hasOwner ? sentinelReplayStatusMetadataBytes(statusRow) : 0) + sentinelReplayStatusMetadataBytes(tombstone);
  await pruneCaptureOwnedStatusMetadata(kv, nowMs, statusRows, statusBytes, STATUS_PRUNE_BATCH, budgetBytes);
  // Read the rows this commit really replaces or deletes. The bound tracks the
  // live row set, so re-creating the victim status row and adding its tombstone
  // may move it only by the difference; the versionstamps checked below keep that
  // delta true while another writer touches those keys.
  const [ledgerState, existingStatus, existingTombstone] = await Promise.all([
    readLedger(kv, budgetBytes),
    hasOwner ? kv.get(statusKey) : Promise.resolve(null),
    kv.get(tombstoneKey),
  ]);
  if (ledgerState.kind === "corrupt") return { finalized: false, chunks: cleanup.deleted };
  const ledger = withBudget(ledgerState.ledger, budgetBytes);
  const existingStatusBytes = storedStatusMetadataBytes(existingStatus?.value);
  const existingTombstoneBytes = storedStatusMetadataBytes(existingTombstone.value);
  const statusPresent = existingStatus === null || existingStatus.value === null ? 0 : 1;
  const tombstonePresent = existingTombstone.value === null ? 0 : 1;
  // The metadata bound is hard even during cleanup: when the reserve cannot take
  // the tombstone, the victim's bytes are still released below, but the bounded
  // status/tombstone rows are dropped instead of exceeding the bound.
  const metadataReserve = sentinelReplayMetadataReserve(budgetBytes);
  // Room for both rows means both are written; otherwise the status row is
  // deleted and any existing tombstone survives exactly as it was.
  const statusFits =
    ledger.status_records + statusRows - statusPresent - tombstonePresent <= SENTINEL_REPLAY_MAX_STATUS_RECORDS &&
    ledger.metadata_bytes + statusBytes - existingStatusBytes - existingTombstoneBytes <= metadataReserve;
  const afterRecords = statusFits ? statusRows : tombstonePresent;
  const afterBytes = statusFits ? statusBytes : existingTombstoneBytes;
  const statusRecordsDelta = afterRecords - statusPresent - tombstonePresent;
  const metadataBytesDelta = afterBytes - existingStatusBytes - existingTombstoneBytes;
  const nextLedger = finalizedLedger(ledger, row, kind, nowMs, budgetBytes, statusRecordsDelta, metadataBytesDelta);
  const entry = await kv.get<SentinelReplayAccountingRow>(key);
  if (!isAccountingRow(entry.value) || entry.value.state !== "evicting") return { finalized: false, chunks: cleanup.deleted };
  fault("commit");
  const operation = kv
    .atomic()
    .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: ledgerState.versionstamp })
    .check({ key, versionstamp: entry.versionstamp })
    .check({ key: tombstoneKey, versionstamp: existingTombstone.versionstamp })
    .set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, nextLedger)
    .delete(key);
  const committed = await applyClaimedVictimMetadata(operation, existingStatus, statusRow, tombstoneKey, tombstone, statusFits).commit();
  // A commit failure leaves the victim in `evicting` with its charge held for a
  // later pass; its bytes were fully removed, so nothing is double-charged.
  return { finalized: committed.ok, chunks: cleanup.deleted };
};

/**
 * Claim one stored victim for exactly-once deletion, then finalize it. The claim
 * commit is what makes eviction exactly-once: exactly one caller can move
 * stored -> evicting at this row versionstamp, and a loser must move on without
 * touching the victim.
 */
const claimVictim = async (
  kv: Kv,
  key: KvKey,
  row: SentinelReplayAccountingRow,
  kind: SentinelReplayClaimKind,
  budgetBytes: number
): Promise<SentinelReplayAccountingRow | null> => {
  // Re-read before claiming: a stale victim whose row was already deleted or
  // already claimed must never be resurrected by a `versionstamp: null` check.
  const current = await kv.get<SentinelReplayAccountingRow>(key);
  if (
    !isAccountingRow(current.value) ||
    !accountingKeyMatches(key, current.value) ||
    current.value.state !== "stored" ||
    current.value.fence !== row.fence ||
    current.value.bytes !== row.bytes
  ) {
    return null;
  }
  // Bind the narrowed row: TypeScript does not carry a property narrowing into
  // the mutation closure, and no assertion should be needed for that.
  const claimed: SentinelReplayAccountingRow = current.value;
  const claimedRow: SentinelReplayAccountingRow = {
    ...claimed,
    state: "evicting",
    fence: row.fence + 1,
    claim_kind: kind,
  };
  const committed = await commitAccountingMutation(
    kv,
    key,
    current.versionstamp,
    (ledger) => ledger,
    (operation) => operation.set(key, claimedRow),
    budgetBytes
  );
  return committed ? claimedRow : null;
};

/**
 * Resume an `evicting` victim whose final commit failed after its bytes were
 * removed. The claim kind is persisted on the row because the current clock
 * may have passed the payload TTL before this continuation runs.
 */
const resumeEvictingRows = async (kv: Kv, nowMs: number, budgetBytes: number, limit: number): Promise<number> => {
  const victims = await selectVictims(kv, limit, (row) => row.state === "evicting", nowMs);
  let resumed = 0;
  for (const victim of victims) {
    const result = await finalizeClaimedVictim(kv, victim.key, victim.row, nowMs, budgetBytes);
    if (result.finalized) resumed += 1;
  }
  return resumed;
};

const selectVictims = async (
  kv: Kv,
  limit: number,
  predicate: (row: SentinelReplayAccountingRow, nowMs: number) => boolean,
  nowMs: number
): Promise<Readonly<{ key: KvKey; row: SentinelReplayAccountingRow }>[]> => {
  const victims: Readonly<{ key: KvKey; row: SentinelReplayAccountingRow }>[] = [];
  // Accounting keys are timestamp-first, so listing this prefix IS the
  // oldest-first index; no second index namespace is needed.
  for await (const entry of kv.list<SentinelReplayAccountingRow>({ prefix: SENTINEL_REPLAY_ACCOUNTING_PREFIX }, { limit: limit * 8 })) {
    if (!isAccountingRow(entry.value) || !accountingKeyMatches(entry.key, entry.value)) continue;
    if (!predicate(entry.value, nowMs)) continue;
    victims.push({ key: entry.key, row: entry.value });
    if (victims.length >= limit) break;
  }
  return victims;
};

/**
 * Evict oldest stored captures until the ledger reaches its byte and record
 * targets. Each victim is claimed by exactly one caller before anything is
 * deleted, and its charge is released only when its chunk prefix is proven empty.
 */
export const evictSentinelReplays = async (
  kv: Kv,
  options: Readonly<{
    target_bytes: number;
    target_records?: number;
    max_records?: number;
    max_chunk_deletes?: number;
    now_ms: number;
    budget_bytes?: number;
  }>
): Promise<Readonly<{ records: number; bytes: number; chunks: number }>> => {
  const budgetBytes = Math.max(64 * 1_024, Math.trunc(options.budget_bytes ?? sentinelReplayBudgetBytes()));
  const maxRecords = Math.max(1, Math.min(EVICTION_BATCH_RECORDS, options.max_records ?? EVICTION_BATCH_RECORDS));
  const targetRecords = options.target_records === undefined ? null : Math.max(0, Math.trunc(options.target_records));
  // Expired payloads belong to the TTL reclamation pass, which reports them as
  // `expired`; each claim records its cause so a resumed row keeps that cause
  // even when its payload TTL has since passed.
  const victims = await selectVictims(kv, maxRecords, (row, nowMs) => row.state === "stored" && row.expires_at_ms > nowMs, options.now_ms);
  let records = 0;
  let bytes = 0;
  let chunks = 0;
  for (const victim of victims) {
    const remainingDeletes = Math.max(0, (options.max_chunk_deletes ?? EVICTION_MAX_CHUNK_DELETES) - chunks);
    if (remainingDeletes <= 0) break;
    const state = await readLedger(kv, budgetBytes);
    if (state.kind === "corrupt") break;
    const ledger = withBudget(state.ledger, budgetBytes);
    if (ledger.stored_bytes <= options.target_bytes && (targetRecords === null || ledger.records <= targetRecords)) break;
    const claimed = await claimVictim(kv, victim.key, victim.row, "evicted", budgetBytes);
    if (claimed === null) continue;
    const result = await finalizeClaimedVictim(kv, victim.key, claimed, options.now_ms, budgetBytes, remainingDeletes);
    chunks += result.chunks;
    if (!result.finalized) continue;
    records += 1;
    bytes += victim.row.bytes;
  }
  return { records, bytes, chunks };
};

/**
 * TTL reclamation: accounting rows outlive their payload TTL, so a maintenance
 * pass claims rows whose payload already expired and releases the charge with
 * records-1 and NO evicted_* increment, reporting `expired`/`payload_expired`.
 */
export const reclaimExpiredSentinelReplays = async (
  kv: Kv,
  options: Readonly<{ now_ms: number; max_records?: number; budget_bytes?: number }>
): Promise<Readonly<{ records: number; bytes: number }>> => {
  const budgetBytes = Math.max(64 * 1_024, Math.trunc(options.budget_bytes ?? sentinelReplayBudgetBytes()));
  const maxRecords = Math.max(1, Math.min(EVICTION_BATCH_RECORDS, options.max_records ?? EVICTION_BATCH_RECORDS));
  const victims = await selectVictims(kv, maxRecords, (row, nowMs) => row.state === "stored" && row.expires_at_ms <= nowMs, options.now_ms);
  let records = 0;
  let bytes = 0;
  for (const victim of victims) {
    const claimed = await claimVictim(kv, victim.key, victim.row, "expired", budgetBytes);
    if (claimed === null) continue;
    const result = await finalizeClaimedVictim(kv, victim.key, claimed, options.now_ms, budgetBytes);
    if (!result.finalized) continue;
    records += 1;
    bytes += victim.row.bytes;
  }
  return { records, bytes };
};

/**
 * Bounded cleanup for an over-budget or over-cap admission: reclaim payload-TTL
 * expiry first, then evict oldest-first toward both clean targets. Returns whether
 * any capacity was actually reclaimed, so a refusal is only reported when nothing moved.
 */
const reclaimAdmissionCapacity = async (kv: Kv, budgetBytes: number, payloadBudget: number, charge: number, nowMs: number): Promise<boolean> => {
  const target = Math.floor(payloadBudget * SENTINEL_REPLAY_CLEAN_TARGET_RATIO) - charge;
  const expired = await reclaimExpiredSentinelReplays(kv, { now_ms: nowMs, budget_bytes: budgetBytes });
  const evicted = await evictSentinelReplays(kv, {
    target_bytes: Math.max(0, target),
    target_records: SENTINEL_REPLAY_MAX_RECORDS - 1,
    now_ms: nowMs,
    budget_bytes: budgetBytes,
  });
  return evicted.records > 0 || expired.records > 0;
};

/**
 * Reserve capacity for one capture before any chunk is written: the accounting
 * row (state=reserved) and the ledger's reserved_bytes increment commit
 * together. Refuses with storage_full when bounded cleanup cannot admit it.
 */
export const reserveSentinelReplayCapacity = async (
  kv: Kv,
  input: Readonly<{
    capture_id: string;
    request_id: string;
    plaintext_bytes: number;
    metadata_bytes: number;
    fingerprint: string;
    now_ms: number;
    budget_bytes?: number;
  }>
): Promise<SentinelReplayAdmission> => {
  const budgetBytes = Math.max(64 * 1_024, Math.trunc(input.budget_bytes ?? sentinelReplayBudgetBytes()));
  const payloadBudget = sentinelReplayPayloadBudgetBytes(budgetBytes);
  const charge = sentinelReplayReservationBytes(input.plaintext_bytes, input.metadata_bytes);
  for (let round = 0; round < 4; round += 1) {
    await reapAccountingRows(kv, input.now_ms, budgetBytes);
    const state = await readLedger(kv, budgetBytes);
    if (state.kind === "corrupt") {
      await recordSkipReason(kv, SENTINEL_REPLAY_ACCOUNTING_REASON, input.now_ms, budgetBytes);
      return { ok: false, reason: SENTINEL_REPLAY_ACCOUNTING_REASON };
    }
    const ledger = withBudget(state.ledger, budgetBytes);
    if (!ledger.bootstrap_complete) {
      const bootstrapped = await runBootstrapBatch(kv, ledger, state.versionstamp, budgetBytes, input.now_ms);
      if (!bootstrapped.bootstrap_complete) {
        await recordSkipReason(kv, SENTINEL_REPLAY_ACCOUNTING_REASON, input.now_ms, budgetBytes);
        return { ok: false, reason: SENTINEL_REPLAY_ACCOUNTING_REASON };
      }
      continue;
    }
    // Admissions may create owners from here on, so no earlier chunk owner index can be trusted again.
    forgetChunkOwnerIndex(kv);
    const overBudget = ledger.stored_bytes + ledger.reserved_bytes + charge > payloadBudget || ledger.records + 1 > SENTINEL_REPLAY_MAX_RECORDS;
    if (overBudget) {
      if (!(await reclaimAdmissionCapacity(kv, budgetBytes, payloadBudget, charge, input.now_ms))) {
        await recordSkipReason(kv, SENTINEL_REPLAY_STORAGE_FULL_REASON, input.now_ms, budgetBytes);
        return { ok: false, reason: SENTINEL_REPLAY_STORAGE_FULL_REASON };
      }
      continue;
    }
    const row: SentinelReplayAccountingRow = {
      version: 1,
      capture_id: input.capture_id,
      request_id: input.request_id,
      fingerprint: input.fingerprint,
      bytes: charge,
      state: "reserved",
      fence: 1,
      created_at_ms: input.now_ms,
      // A short staging lease: a crashed writer's charge is reaped promptly. The
      // payload TTL is written only when publish turns this row into `stored`.
      expires_at_ms: input.now_ms + SENTINEL_REPLAY_RESERVATION_TTL_MS,
      status_expires_at_ms: input.now_ms + SENTINEL_REPLAY_STATUS_TTL_MS,
      stage: 0,
    };
    const key = sentinelReplayAccountingKey(row.created_at_ms, row.capture_id);
    const nextLedger: SentinelReplayBudgetLedger = {
      ...ledger,
      reserved_bytes: ledger.reserved_bytes + charge,
      last_skip_reason: null,
    };
    fault("commit");
    const committed = await kv
      .atomic()
      .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: state.versionstamp })
      .check({ key, versionstamp: null })
      .set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, nextLedger)
      .set(key, row)
      .commit();
    if (committed.ok) return { ok: true, accounting_key: key, accounting: row, charge };
  }
  await recordSkipReason(kv, SENTINEL_REPLAY_STORAGE_FULL_REASON, input.now_ms, budgetBytes);
  return { ok: false, reason: SENTINEL_REPLAY_STORAGE_FULL_REASON };
};

/** Bounded maintenance: reap, bootstrap, reclaim expired payloads, evict if needed, and recount metadata when due. */
export const runSentinelReplayRetentionMaintenance = async (
  kv: Kv,
  options: Readonly<{ now_ms: number; budget_bytes?: number }>
): Promise<SentinelReplayRetentionStatus> => {
  const budgetBytes = Math.max(64 * 1_024, Math.trunc(options.budget_bytes ?? sentinelReplayBudgetBytes()));
  const payloadBudget = sentinelReplayPayloadBudgetBytes(budgetBytes);
  // The resumable sweep runs FIRST and gates every counter mutation below. It
  // counts each in-scope row itself, so a release or reclamation that moved a
  // counter while the sweep was still pending would let that row be counted a
  // second time once the sweep reached it.
  if ((await bootstrapBeforeMutation(kv, budgetBytes, options.now_ms)) === null) return await readSentinelReplayRetentionStatus(kv, budgetBytes);
  await reapAccountingRows(kv, options.now_ms, budgetBytes);
  await reapLegacyReservations(kv, budgetBytes);
  await reclaimExpiredSentinelReplays(kv, { now_ms: options.now_ms, budget_bytes: budgetBytes });
  const current = await readLedger(kv, budgetBytes);
  if (current.kind === "ok" && current.ledger.stored_bytes + current.ledger.reserved_bytes > payloadBudget) {
    await evictSentinelReplays(kv, {
      target_bytes: Math.floor(payloadBudget * SENTINEL_REPLAY_CLEAN_TARGET_RATIO),
      now_ms: options.now_ms,
      budget_bytes: budgetBytes,
    });
  }
  // Throttled: a healthy admin poll inside the interval neither rescans metadata nor writes the ledger.
  await reconcileSentinelReplayStatusMetadataIfDue(kv, budgetBytes, options.now_ms);
  return await readSentinelReplayRetentionStatus(kv, budgetBytes);
};

export { readSentinelReplayRetentionStatus } from "./replay-retention-schema.ts";
