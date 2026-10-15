import type { Kv, KvEntry, KvKey } from "#kv";
/**
 * Resumable bootstrap accounting for capture-owned storage.
 *
 * The sweep counts every in-scope row itself, so while it is pending no other
 * writer may also count a row, or the same row is charged twice; every counter
 * mutation is gated behind `bootstrapBeforeMutation`. It counts scanned entries
 * rather than only valid records: an invalid or unreadable in-scope row marks
 * accounting incomplete so new admissions stay refused instead of trusting a
 * zero. Legacy reservation rows are read only to release their charge once.
 */
import {
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_DEDUPE_PREFIX,
  SENTINEL_REPLAY_MANIFEST_PREFIX,
  SENTINEL_REPLAY_REQUEST_PREFIX,
  SENTINEL_REPLAY_STATUS_TTL_MS,
} from "./replay-model.ts";
import { isSentinelReplayCaptureStatusRow } from "./replay-observation.ts";
import { isSentinelReplayManifest } from "./replay-read.ts";
import {
  accountingKeyMatches,
  BOOTSTRAP_BATCH_ENTRIES,
  commitAccountingMutation,
  counter,
  deleteChunkBatch,
  EVICTION_MAX_CHUNK_DELETES,
  fault,
  isAccountingRow,
  isLegacyReservation,
  manifestKeyMatches,
  readLedger,
  SENTINEL_REPLAY_ACCOUNTING_PREFIX,
  SENTINEL_REPLAY_BUDGET_LEDGER_KEY,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  SENTINEL_REPLAY_RESERVATION_PREFIX,
  sentinelReplayAccountingKey,
  sentinelReplayManifestCharge,
  sentinelReplayPayloadBudgetBytes,
  sentinelReplayStatusMetadataBytes,
  type SentinelReplayAccountingRow,
  type SentinelReplayBudgetLedger,
  type SentinelReplayLegacyReservation,
  withBudget,
} from "./replay-retention-schema.ts";

/** Legacy reservation release: read once, delete chunks, then delete the row. */
export const releaseLegacyReservation = async (kv: Kv, key: KvKey, reservation: SentinelReplayLegacyReservation, budgetBytes: number): Promise<void> => {
  if (reservation.state === "published") {
    await kv.delete(key);
    return;
  }
  const cleanup = await deleteChunkBatch(kv, reservation.capture_id, EVICTION_MAX_CHUNK_DELETES);
  if (cleanup.remaining > 0) return;
  const entry = await kv.get<SentinelReplayLegacyReservation>(key);
  if (!isLegacyReservation(entry.value)) return;
  await commitAccountingMutation(
    kv,
    key,
    entry.versionstamp,
    (ledger) => ({ ...ledger, reserved_bytes: Math.max(0, ledger.reserved_bytes - reservation.bytes) }),
    (operation) => operation.delete(key),
    budgetBytes
  );
};

/**
 * Prefixes in capture-owned key order. Built lazily: replay-store.ts imports the
 * retention modules, so a top-level array here would read model or store
 * bindings before that module body has initialized them. The order is
 * significant — "accounting" sorts before "manifest", so the accounting sweep is
 * always complete before a manifest is checked for an existing accounting row.
 */
const bootstrapPrefixes = (): readonly KvKey[] => [
  SENTINEL_REPLAY_ACCOUNTING_PREFIX,
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_DEDUPE_PREFIX,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  SENTINEL_REPLAY_MANIFEST_PREFIX,
  SENTINEL_REPLAY_REQUEST_PREFIX,
  SENTINEL_REPLAY_RESERVATION_PREFIX,
];

type BootstrapMaterialization = Readonly<{
  accounting_key: KvKey;
  manifest_key: KvKey;
  manifest_versionstamp: string;
  row: SentinelReplayAccountingRow;
}>;

type BootstrapDelta = Readonly<{
  stored_bytes: number;
  reserved_bytes: number;
  records: number;
  status_records: number;
  metadata_bytes: number;
  invalid: boolean;
  legacy_reaped: number;
  materializations: readonly BootstrapMaterialization[];
}>;

const emptyDelta = (): BootstrapDelta => ({
  stored_bytes: 0,
  reserved_bytes: 0,
  records: 0,
  status_records: 0,
  metadata_bytes: 0,
  invalid: false,
  legacy_reaped: 0,
  materializations: [],
});

const addDelta = (delta: BootstrapDelta, patch: Partial<BootstrapDelta>): BootstrapDelta => ({
  stored_bytes: delta.stored_bytes + (patch.stored_bytes ?? 0),
  reserved_bytes: delta.reserved_bytes + (patch.reserved_bytes ?? 0),
  records: delta.records + (patch.records ?? 0),
  status_records: delta.status_records + (patch.status_records ?? 0),
  metadata_bytes: delta.metadata_bytes + (patch.metadata_bytes ?? 0),
  invalid: delta.invalid || Boolean(patch.invalid),
  legacy_reaped: delta.legacy_reaped + (patch.legacy_reaped ?? 0),
  materializations: [...delta.materializations, ...(patch.materializations ?? [])],
});

const parseCursor = (cursor: string | null): Readonly<{ index: number; inner: string | null }> => {
  if (cursor === null) return { index: 0, inner: null };
  const separator = cursor.indexOf("|");
  if (separator < 0) return { index: 0, inner: null };
  const index = Number.parseInt(cursor.slice(0, separator), 10);
  return { index: Number.isSafeInteger(index) && index >= 0 ? index : 0, inner: cursor.slice(separator + 1) || null };
};

/** Accounting rows own the durable charge, so the sweep counts them directly. */
const bootstrapAccountingDelta = (key: KvKey, value: unknown, delta: BootstrapDelta): BootstrapDelta => {
  if (!isAccountingRow(value) || !accountingKeyMatches(key, value)) return addDelta(delta, { invalid: true });
  if (value.state === "stored" || value.state === "evicting") return addDelta(delta, { stored_bytes: value.bytes, records: 1 });
  return addDelta(delta, { reserved_bytes: value.bytes });
};

/** A legacy manifest gains its durable charge owner in the same commit as the bootstrap ledger delta. */
const bootstrapManifestDelta = async (kv: Kv, entry: KvEntry<unknown>, delta: BootstrapDelta): Promise<BootstrapDelta> => {
  const { key, value } = entry;
  if (!isSentinelReplayManifest(value) || !manifestKeyMatches(key, value)) return addDelta(delta, { invalid: true });
  const accountingKey = sentinelReplayAccountingKey(value.captured_at_ms, value.capture_id);
  const accounting = await kv.get(accountingKey);
  if (accounting.value !== null) {
    const matches =
      isAccountingRow(accounting.value) && accountingKeyMatches(accountingKey, accounting.value) && accounting.value.fingerprint === value.fingerprint;
    return matches ? delta : addDelta(delta, { invalid: true });
  }
  const pending = delta.materializations.find((candidate) => candidate.accounting_key.join("\u0000") === accountingKey.join("\u0000"));
  if (pending) return pending.row.fingerprint === value.fingerprint ? delta : addDelta(delta, { invalid: true });
  const bytes = sentinelReplayManifestCharge(value);
  const row: SentinelReplayAccountingRow = {
    version: 1,
    capture_id: value.capture_id,
    request_id: value.request_id ?? "",
    fingerprint: value.fingerprint,
    bytes,
    state: "stored",
    fence: 1,
    created_at_ms: value.captured_at_ms,
    expires_at_ms: value.expires_at_ms,
    status_expires_at_ms: value.captured_at_ms + SENTINEL_REPLAY_STATUS_TTL_MS,
    stage: 0,
  };
  return addDelta(delta, {
    stored_bytes: bytes,
    records: 1,
    materializations: [{ accounting_key: accountingKey, manifest_key: key, manifest_versionstamp: entry.versionstamp, row }],
  });
};

/** Request status rows are capture-owned metadata and consume the metadata reserve. */
const bootstrapStatusDelta = (value: unknown, delta: BootstrapDelta): BootstrapDelta => {
  if (!isSentinelReplayCaptureStatusRow(value)) return addDelta(delta, { invalid: true });
  return addDelta(delta, { status_records: 1, metadata_bytes: sentinelReplayStatusMetadataBytes(value) });
};

/** Eviction and expiry tombstones are capture-owned metadata too. */
const bootstrapTombstoneDelta = (value: unknown, delta: BootstrapDelta): BootstrapDelta => {
  const tombstone = value as { fingerprint?: unknown; reason?: unknown } | null;
  if (typeof tombstone !== "object" || tombstone === null || typeof tombstone.fingerprint !== "string" || typeof tombstone.reason !== "string") {
    return addDelta(delta, { invalid: true });
  }
  return addDelta(delta, { status_records: 1, metadata_bytes: sentinelReplayStatusMetadataBytes(tombstone) });
};

/** Legacy reservation rows are read only to release their own charge once. */
const bootstrapLegacyDelta = async (kv: Kv, key: KvKey, value: unknown, delta: BootstrapDelta, budgetBytes: number): Promise<BootstrapDelta> => {
  if (!isLegacyReservation(value)) return addDelta(delta, { invalid: true });
  await releaseLegacyReservation(kv, key, value, budgetBytes);
  return addDelta(delta, { legacy_reaped: 1 });
};

const chunkHasOwner = async (kv: Kv, captureId: string): Promise<boolean> => {
  for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_ACCOUNTING_PREFIX })) {
    if (isAccountingRow(entry.value) && accountingKeyMatches(entry.key, entry.value) && entry.value.capture_id === captureId) return true;
  }
  for await (const entry of kv.list({ prefix: SENTINEL_REPLAY_MANIFEST_PREFIX })) {
    if (isSentinelReplayManifest(entry.value) && manifestKeyMatches(entry.key, entry.value) && entry.value.capture_id === captureId) return true;
  }
  return false;
};

/** Reclaim staged chunks that have no durable manifest or accounting owner. */
const bootstrapChunkDelta = async (kv: Kv, entry: KvEntry<unknown>, delta: BootstrapDelta): Promise<BootstrapDelta> => {
  const { key } = entry;
  if (key.length !== SENTINEL_REPLAY_CHUNK_PREFIX.length + 2 || typeof key[4] !== "string" || !counter(key[5])) return addDelta(delta, { invalid: true });
  if (await chunkHasOwner(kv, key[4])) return delta;
  fault("delete");
  const deleted = await kv.atomic().check({ key, versionstamp: entry.versionstamp }).delete(key).commit();
  return deleted.ok ? delta : addDelta(delta, { invalid: true });
};

/** A dedupe row must reference a well-formed manifest key. */
const bootstrapDedupeDelta = (value: unknown, delta: BootstrapDelta): BootstrapDelta => {
  const dedupe = value as { manifest_key?: unknown } | null;
  if (typeof dedupe !== "object" || dedupe === null || !Array.isArray(dedupe.manifest_key) || dedupe.manifest_key.length !== 7) {
    return addDelta(delta, { invalid: true });
  }
  return delta;
};

/**
 * Fold one scanned in-scope row into the running bootstrap delta. Rows that do
 * not match their own prefix's contract are counted as invalid rather than
 * trusted or deleted on a guess, which keeps discovery fail-closed.
 */
const bootstrapEntryDelta = async (kv: Kv, prefix: KvKey, entry: KvEntry<unknown>, delta: BootstrapDelta, budgetBytes: number): Promise<BootstrapDelta> => {
  if (prefix === SENTINEL_REPLAY_ACCOUNTING_PREFIX) return bootstrapAccountingDelta(entry.key, entry.value, delta);
  if (prefix === SENTINEL_REPLAY_MANIFEST_PREFIX) return await bootstrapManifestDelta(kv, entry, delta);
  if (prefix === SENTINEL_REPLAY_REQUEST_PREFIX) return bootstrapStatusDelta(entry.value, delta);
  if (prefix === SENTINEL_REPLAY_EVICTION_PREFIX) return bootstrapTombstoneDelta(entry.value, delta);
  if (prefix === SENTINEL_REPLAY_RESERVATION_PREFIX) return await bootstrapLegacyDelta(kv, entry.key, entry.value, delta, budgetBytes);
  if (prefix === SENTINEL_REPLAY_CHUNK_PREFIX) return await bootstrapChunkDelta(kv, entry, delta);
  return bootstrapDedupeDelta(entry.value, delta);
};

/** Outcome of sweeping one bootstrap prefix within the remaining entry budget. */
type BootstrapSweep = Readonly<{ delta: BootstrapDelta; scanned: number; cursor: string | null; exhausted: boolean }>;

/**
 * Sweep one prefix up to `budget` entries. `exhausted` means the sweep consumed
 * its whole budget mid-prefix, so the caller must resume from `cursor` at the
 * same prefix instead of advancing.
 */
const sweepBootstrapPrefix = async (
  kv: Kv,
  prefix: KvKey,
  cursor: string | null,
  budget: number,
  delta: BootstrapDelta,
  budgetBytes: number
): Promise<BootstrapSweep> => {
  const iterator = kv.list({ prefix }, { cursor: cursor ?? undefined, limit: budget });
  let scanned = 0;
  for await (const entry of iterator) {
    scanned += 1;
    delta = await bootstrapEntryDelta(kv, prefix, entry, delta, budgetBytes);
    if (scanned >= budget) return { delta, scanned, cursor: iterator.cursor, exhausted: true };
  }
  return { delta, scanned, cursor: null, exhausted: false };
};

/**
 * One bounded, resumable bootstrap sweep across EVERY capture-owned prefix that
 * holds retained bytes or metadata. It counts scanned entries, not just valid
 * records: an invalid or unreadable in-scope row marks accounting incomplete so
 * new admissions stay refused instead of trusting a zero.
 */
export const runBootstrapBatch = async (
  kv: Kv,
  ledger: SentinelReplayBudgetLedger,
  versionstamp: string | null,
  budgetBytes: number,
  nowMs: number
): Promise<SentinelReplayBudgetLedger> => {
  let { index, inner } = parseCursor(ledger.bootstrap_cursor);
  const prefixes = bootstrapPrefixes();
  // A fresh sweep clears the sticky error so a removed corrupt row can resolve it.
  let error = ledger.bootstrap_cursor === null ? null : ledger.accounting_error;
  // A failed full sweep retained its deltas. Rebuild live counters on restart;
  // cursor continuations still accumulate, and cumulative history stays intact.
  const live = ledger.bootstrap_cursor === null && ledger.accounting_error !== null ? emptyDelta() : ledger;
  let delta = emptyDelta();
  let scanned = 0;
  while (index < prefixes.length && scanned < BOOTSTRAP_BATCH_ENTRIES) {
    const sweep = await sweepBootstrapPrefix(kv, prefixes[index], inner, BOOTSTRAP_BATCH_ENTRIES - scanned, delta, budgetBytes);
    delta = sweep.delta;
    scanned += sweep.scanned;
    if (sweep.exhausted) {
      // Keep this prefix and its cursor: the next pass resumes exactly here.
      inner = sweep.cursor;
      break;
    }
    index += 1;
    inner = null;
  }
  const complete = index >= prefixes.length;
  if (delta.invalid) error = "invalid_in_scope_row";
  const next: SentinelReplayBudgetLedger = {
    ...ledger,
    budget_bytes: budgetBytes,
    stored_bytes: live.stored_bytes + delta.stored_bytes,
    reserved_bytes: live.reserved_bytes + delta.reserved_bytes,
    records: live.records + delta.records,
    status_records: live.status_records + delta.status_records,
    metadata_bytes: live.metadata_bytes + delta.metadata_bytes,
    bootstrap_complete: complete && error === null,
    bootstrap_cursor: complete ? null : `${index}|${inner ?? ""}`,
    accounting_error: error,
    over_budget: live.stored_bytes + delta.stored_bytes > sentinelReplayPayloadBudgetBytes(budgetBytes),
    last_warning_at_ms: live.stored_bytes + delta.stored_bytes > sentinelReplayPayloadBudgetBytes(budgetBytes) ? nowMs : ledger.last_warning_at_ms,
  };
  fault("commit");
  let operation = kv.atomic().check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp });
  for (const materialization of delta.materializations) {
    operation = operation
      .check({ key: materialization.accounting_key, versionstamp: null })
      .check({ key: materialization.manifest_key, versionstamp: materialization.manifest_versionstamp })
      .set(materialization.accounting_key, materialization.row);
  }
  const committed = await operation.set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, next).commit();
  if (committed.ok) return next;
  const reread = await readLedger(kv, budgetBytes);
  if (reread.kind === "corrupt") return ledger;
  return withBudget(reread.ledger, budgetBytes);
};

/**
 * Ensure the resumable sweep has finished before any counter mutation. The sweep
 * counts every in-scope row itself, so while it is pending no other writer may
 * also count a row, or the same row is charged twice. Returns the fresh ledger
 * when accounting is authoritative, and null when the ledger is corrupt or the
 * sweep is still incomplete, in which case no counter may move.
 */
export const bootstrapBeforeMutation = async (kv: Kv, budgetBytes: number, nowMs: number): Promise<SentinelReplayBudgetLedger | null> => {
  const state = await readLedger(kv, budgetBytes);
  if (state.kind === "corrupt") return null;
  const ledger = withBudget(state.ledger, budgetBytes);
  if (ledger.bootstrap_complete) return ledger;
  const bootstrapped = await runBootstrapBatch(kv, ledger, state.versionstamp, budgetBytes, nowMs);
  return bootstrapped.bootstrap_complete ? bootstrapped : null;
};
