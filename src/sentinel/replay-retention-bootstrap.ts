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
 *
 * A chunk key names only its capture, while owner keys lead with a timestamp,
 * so a chunk's owner has no point lookup. Chunks are judged against a
 * process-local index of owner capture ids for the current sweep, filled in
 * the background in fixed slices of BOOTSTRAP_OWNER_SCAN_ENTRIES rows, so each
 * owner read stays bounded, the reads stay linear over the sweep instead of
 * one full scan per chunk, and a batch waits for the index only briefly. An
 * ownerless chunk is deleted only in a commit that also checks the ledger
 * versionstamp its batch read, so an owner published after that read keeps
 * its payload.
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
  BOOTSTRAP_OWNER_INDEX_WAIT_MS,
  BOOTSTRAP_OWNER_SCAN_ENTRIES,
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

/**
 * Capture ids of every valid accounting row and manifest, for one sweep. While
 * the ledger is incomplete no capture gains its first owner: admission requires
 * completed accounting, and publication and this sweep's manifest phase add
 * rows only for a capture that already has one. Each sweep carries the random
 * id its first batch stamped (`bootstrap_sweep`), so an index filled at any
 * point of a sweep holds every owner that existed when a later batch of that
 * same sweep read its ledger, whichever cursor either was at, and it never
 * serves another sweep, not even one started after the ledger was deleted. No
 * index is built for an id until a ledger carries it: a batch that reaches the
 * chunk phase while stamping a new id commits the id first, and then runs one
 * more pass, so a small store still finishes in one call and the stamping
 * commit never waits on a fill.
 *
 * A batch can still outlive that read: another caller may finish the sweep, and
 * an admission may then reserve and stage a capture this index never saw. Every
 * commit that creates an owner (admission, publication, materialization) also
 * writes the ledger, and an ownerless chunk is deleted only in a commit that
 * checks the ledger versionstamp the batch read, so such a delete fails instead.
 * The same check makes the batch's own ledger commit fail, so the failed delete
 * never persists as an invalid row.
 *
 * A handle fills at most one index at a time, in the background: one slice of
 * BOOTSTRAP_OWNER_SCAN_ENTRIES rows after another, from the first batch that
 * needs it until both owner prefixes are read. Its progress therefore depends
 * neither on further requests nor on any batch's commit, and concurrent batches
 * share it instead of each starting their own. A batch waits for it at most
 * BOOTSTRAP_OWNER_INDEX_WAIT_MS, and otherwise judges no chunk and writes no
 * ledger. The index lives in memory, so a restarted process starts one new
 * fill. A complete index is only read.
 *
 * Restoring an older copy of the ledger alone, rather than of the whole store,
 * brings back a sweep id a running process may still hold an index for, so
 * restart every process after such a restore.
 */
type ChunkOwnerIndex = {
  readonly sweep: string;
  /** A stand-in for a sweep whose chunk phase a commit on this handle has passed: it never fills. */
  readonly retired: boolean;
  prefix: number;
  scan: string | undefined;
  readonly owners: Set<string>;
  filled: Promise<void>;
  failure: Readonly<{ error: unknown }> | null;
};
const chunkOwnerIndexes = new WeakMap<Kv, ChunkOwnerIndex>();
const ownerIndexPrefixes = (): readonly KvKey[] => [SENTINEL_REPLAY_ACCOUNTING_PREFIX, SENTINEL_REPLAY_MANIFEST_PREFIX];
const isOwnerIndexComplete = (index: ChunkOwnerIndex): boolean => index.prefix >= ownerIndexPrefixes().length;
const emptyChunkOwnerIndex = (sweep: string, retired: boolean): ChunkOwnerIndex => ({
  sweep,
  retired,
  prefix: 0,
  scan: undefined,
  owners: new Set<string>(),
  filled: Promise.resolve(),
  failure: null,
});

/** Hold no owner index on this handle. A fill still running for one stops before its next slice. */
export const forgetChunkOwnerIndex = (kv: Kv): void => {
  chunkOwnerIndexes.delete(kv);
};

const ownerCaptureId = (prefix: KvKey, { key, value }: KvEntry<unknown>): string | null => {
  if (prefix === SENTINEL_REPLAY_ACCOUNTING_PREFIX) return isAccountingRow(value) && accountingKeyMatches(key, value) ? value.capture_id : null;
  return isSentinelReplayManifest(value) && manifestKeyMatches(key, value) ? value.capture_id : null;
};

/** Read at most BOOTSTRAP_OWNER_SCAN_ENTRIES owner rows; true once both owner prefixes are indexed. */
const advanceChunkOwnerIndex = async (kv: Kv, index: ChunkOwnerIndex): Promise<boolean> => {
  const ownerPrefixes = ownerIndexPrefixes();
  let budget = BOOTSTRAP_OWNER_SCAN_ENTRIES;
  while (index.prefix < ownerPrefixes.length && budget > 0) {
    const prefix = ownerPrefixes[index.prefix];
    const iterator = kv.list({ prefix }, { cursor: index.scan, limit: budget });
    let read = 0;
    for await (const entry of iterator) {
      read += 1;
      const owner = ownerCaptureId(prefix, entry);
      if (owner !== null) index.owners.add(owner);
    }
    if (read < budget) {
      index.prefix += 1;
      index.scan = undefined;
    } else {
      index.scan = iterator.cursor;
    }
    budget -= read;
  }
  return index.prefix >= ownerPrefixes.length;
};

/** One bounded slice after another, for as long as this handle still holds the index. */
const fillChunkOwnerIndex = async (kv: Kv, index: ChunkOwnerIndex): Promise<void> => {
  let complete = false;
  while (!complete && chunkOwnerIndexes.get(kv) === index) complete = await advanceChunkOwnerIndex(kv, index);
};

/**
 * Hold a new index for this sweep, replacing one held for another, and start
 * filling it. A failed fill is dropped, so the next batch that needs an index
 * starts another, and the batches waiting on it see the error.
 */
const startChunkOwnerIndex = (kv: Kv, sweep: string): ChunkOwnerIndex => {
  const index = emptyChunkOwnerIndex(sweep, false);
  chunkOwnerIndexes.set(kv, index);
  index.filled = fillChunkOwnerIndex(kv, index).catch((error: unknown) => {
    index.failure = { error };
    if (chunkOwnerIndexes.get(kv) === index) chunkOwnerIndexes.delete(kv);
  });
  return index;
};

/** Resolve once `settled` does or `ms` have passed, whichever is first. */
const settledWithin = async (settled: Promise<void>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([settled, elapsed]);
  } finally {
    clearTimeout(timer);
  }
};

const chunkRemains = async (kv: Kv, cursor: string | null): Promise<boolean> =>
  (await kv.list({ prefix: SENTINEL_REPLAY_CHUNK_PREFIX }, { cursor: cursor ?? undefined, limit: 1 }).next()).done !== true;

/**
 * The owner index a chunk page is judged against. A chunk prefix with nothing
 * left needs none. Otherwise the page waits for the sweep's index, and is not
 * ready while the sweep's id is not durable yet, while that index is still
 * filling after the bounded wait, or when the sweep's chunk phase is already
 * past on this handle.
 */
const prepareChunkOwners = async (
  kv: Kv,
  sweep: string | null,
  cursor: string | null
): Promise<Readonly<{ ready: boolean; index: ChunkOwnerIndex | null }>> => {
  const held = chunkOwnerIndexes.get(kv);
  if (sweep !== null && held?.sweep === sweep && isOwnerIndexComplete(held)) return { ready: true, index: held };
  if (!(await chunkRemains(kv, cursor))) return { ready: true, index: null };
  if (sweep === null) return { ready: false, index: null };
  const current = chunkOwnerIndexes.get(kv);
  const index = current?.sweep === sweep ? current : startChunkOwnerIndex(kv, sweep);
  if (!index.retired && !isOwnerIndexComplete(index)) await settledWithin(index.filled, BOOTSTRAP_OWNER_INDEX_WAIT_MS);
  if (index.failure !== null) throw index.failure.error;
  return isOwnerIndexComplete(index) ? { ready: true, index } : { ready: false, index: null };
};

/**
 * Reclaim staged chunks that have no durable manifest or accounting owner. A
 * null index means no chunk remained when this pass began, so a chunk seen now
 * was staged since by a capture whose reservation already owns it. The delete
 * also checks the ledger versionstamp this batch read: any owner created since
 * wrote the ledger, so the delete fails rather than reclaim a live payload. A
 * chunk that another batch sharing the index already reclaimed is gone, not
 * invalid.
 */
const bootstrapChunkDelta = async (
  kv: Kv,
  entry: KvEntry<unknown>,
  delta: BootstrapDelta,
  owners: ChunkOwnerIndex | null,
  ledgerVersionstamp: string | null
): Promise<BootstrapDelta> => {
  const { key } = entry;
  if (key.length !== SENTINEL_REPLAY_CHUNK_PREFIX.length + 2 || typeof key[4] !== "string" || !counter(key[5])) return addDelta(delta, { invalid: true });
  if (owners === null || owners.owners.has(key[4])) return delta;
  fault("delete");
  const deleted = await kv
    .atomic()
    .check({ key, versionstamp: entry.versionstamp })
    .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: ledgerVersionstamp })
    .delete(key)
    .commit();
  if (deleted.ok) return delta;
  return (await kv.get(key)).versionstamp === null ? delta : addDelta(delta, { invalid: true });
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
const bootstrapEntryDelta = async (
  kv: Kv,
  prefix: KvKey,
  entry: KvEntry<unknown>,
  delta: BootstrapDelta,
  budgetBytes: number,
  owners: ChunkOwnerIndex | null,
  ledgerVersionstamp: string | null
): Promise<BootstrapDelta> => {
  if (prefix === SENTINEL_REPLAY_ACCOUNTING_PREFIX) return bootstrapAccountingDelta(entry.key, entry.value, delta);
  if (prefix === SENTINEL_REPLAY_MANIFEST_PREFIX) return await bootstrapManifestDelta(kv, entry, delta);
  if (prefix === SENTINEL_REPLAY_REQUEST_PREFIX) return bootstrapStatusDelta(entry.value, delta);
  if (prefix === SENTINEL_REPLAY_EVICTION_PREFIX) return bootstrapTombstoneDelta(entry.value, delta);
  if (prefix === SENTINEL_REPLAY_RESERVATION_PREFIX) return await bootstrapLegacyDelta(kv, entry.key, entry.value, delta, budgetBytes);
  if (prefix === SENTINEL_REPLAY_CHUNK_PREFIX) return await bootstrapChunkDelta(kv, entry, delta, owners, ledgerVersionstamp);
  return bootstrapDedupeDelta(entry.value, delta);
};

/** Outcome of sweeping one bootstrap prefix within the remaining entry budget. */
type BootstrapSweep = Readonly<{ delta: BootstrapDelta; scanned: number; cursor: string | null; exhausted: boolean }>;

/**
 * Sweep one prefix up to `budget` entries. `exhausted` means the sweep consumed
 * its whole budget mid-prefix, or is still waiting for the chunk owner index,
 * so the caller must resume from `cursor` at the same prefix instead of advancing.
 */
const sweepBootstrapPrefix = async (
  kv: Kv,
  prefix: KvKey,
  cursor: string | null,
  budget: number,
  delta: BootstrapDelta,
  budgetBytes: number,
  sweep: string | null,
  ledgerVersionstamp: string | null
): Promise<BootstrapSweep> => {
  let owners: ChunkOwnerIndex | null = null;
  if (prefix === SENTINEL_REPLAY_CHUNK_PREFIX) {
    // Judge no chunk until every owner is indexed; the cursor stays here meanwhile.
    const prepared = await prepareChunkOwners(kv, sweep, cursor);
    if (!prepared.ready) return { delta, scanned: 0, cursor, exhausted: true };
    owners = prepared.index;
  }
  const iterator = kv.list({ prefix }, { cursor: cursor ?? undefined, limit: budget });
  let scanned = 0;
  for await (const entry of iterator) {
    scanned += 1;
    delta = await bootstrapEntryDelta(kv, prefix, entry, delta, budgetBytes, owners, ledgerVersionstamp);
    if (scanned >= budget) return { delta, scanned, cursor: iterator.cursor, exhausted: true };
  }
  return { delta, scanned, cursor: null, exhausted: false };
};

/**
 * After a committed batch: a finished sweep leaves no index held, and a sweep
 * past its chunk phase judges no chunk again, so its index gives way to a
 * stand-in that keeps a batch still at an older chunk cursor from refilling it.
 */
const settleChunkOwnerIndex = (kv: Kv, sweep: string, phase: number): void => {
  const prefixes = bootstrapPrefixes();
  if (phase >= prefixes.length) {
    forgetChunkOwnerIndex(kv);
    return;
  }
  const held = chunkOwnerIndexes.get(kv);
  if (phase > prefixes.indexOf(SENTINEL_REPLAY_CHUNK_PREFIX) && !(held?.sweep === sweep && held.retired)) {
    chunkOwnerIndexes.set(kv, emptyChunkOwnerIndex(sweep, true));
  }
};

/** The id of the sweep in flight, or null for a sweep not started yet or one stamped before sweeps had ids. */
const durableSweep = (ledger: SentinelReplayBudgetLedger): string | null => (ledger.bootstrap_cursor === null ? null : (ledger.bootstrap_sweep ?? null));

/**
 * Commit the batch's ledger and materialized accounting rows, each checked
 * against what the batch read. Returns the new ledger versionstamp, or null
 * when another write won.
 */
const commitBootstrapBatch = async (kv: Kv, versionstamp: string | null, delta: BootstrapDelta, next: SentinelReplayBudgetLedger): Promise<string | null> => {
  fault("commit");
  let operation = kv.atomic().check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp });
  for (const materialization of delta.materializations) {
    operation = operation
      .check({ key: materialization.accounting_key, versionstamp: null })
      .check({ key: materialization.manifest_key, versionstamp: materialization.manifest_versionstamp })
      .set(materialization.accounting_key, materialization.row);
  }
  const committed = await operation.set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, next).commit();
  return committed.ok ? committed.versionstamp : null;
};

/** A batch that stamped a new id and stopped at the chunk phase, its entries unspent, did so only to make that id durable. */
const stampedBeforeChunks = (durable: string | null, phase: number, scanned: number): boolean =>
  durable === null && bootstrapPrefixes()[phase] === SENTINEL_REPLAY_CHUNK_PREFIX && scanned < BOOTSTRAP_BATCH_ENTRIES;

/** Sweep from the cursor, prefix by prefix, until the batch's entries are spent, a prefix is left mid-way, or every prefix is done. */
const sweepBootstrapBatch = async (
  kv: Kv,
  from: string | null,
  sweep: string | null,
  versionstamp: string | null,
  budgetBytes: number
): Promise<Readonly<{ delta: BootstrapDelta; scanned: number; index: number; inner: string | null }>> => {
  let { index, inner } = parseCursor(from);
  const prefixes = bootstrapPrefixes();
  let delta = emptyDelta();
  let scanned = 0;
  while (index < prefixes.length && scanned < BOOTSTRAP_BATCH_ENTRIES) {
    const swept = await sweepBootstrapPrefix(kv, prefixes[index], inner, BOOTSTRAP_BATCH_ENTRIES - scanned, delta, budgetBytes, sweep, versionstamp);
    delta = swept.delta;
    scanned += swept.scanned;
    if (swept.exhausted) {
      // Keep this prefix and its cursor: the next pass resumes exactly here.
      return { delta, scanned, index, inner: swept.cursor };
    }
    index += 1;
    inner = null;
  }
  return { delta, scanned, index, inner };
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
  // A batch that starts a sweep, or continues one stamped before sweeps had
  // ids, stamps a new id, and judges no chunk until a ledger carries it.
  const durable = durableSweep(ledger);
  // A fresh sweep clears the sticky error so a removed corrupt row can resolve it.
  let error = ledger.bootstrap_cursor === null ? null : ledger.accounting_error;
  // A failed full sweep retained its deltas. Rebuild live counters on restart;
  // cursor continuations still accumulate, and cumulative history stays intact.
  const live = ledger.bootstrap_cursor === null && ledger.accounting_error !== null ? emptyDelta() : ledger;
  const { delta, scanned, index, inner } = await sweepBootstrapBatch(kv, ledger.bootstrap_cursor, durable, versionstamp, budgetBytes);
  const complete = index >= bootstrapPrefixes().length;
  const cursor = complete ? null : `${index}|${inner ?? ""}`;
  // Still waiting for its sweep's owner index, the batch scanned and moved
  // nothing, so it writes no ledger that could cost a judging batch its commit.
  if (scanned === 0 && durable !== null && cursor === ledger.bootstrap_cursor) return ledger;
  if (delta.invalid) error = "invalid_in_scope_row";
  const sweep = durable ?? crypto.randomUUID();
  const next: SentinelReplayBudgetLedger = {
    ...ledger,
    budget_bytes: budgetBytes,
    stored_bytes: live.stored_bytes + delta.stored_bytes,
    reserved_bytes: live.reserved_bytes + delta.reserved_bytes,
    records: live.records + delta.records,
    status_records: live.status_records + delta.status_records,
    metadata_bytes: live.metadata_bytes + delta.metadata_bytes,
    bootstrap_complete: complete && error === null,
    bootstrap_cursor: cursor,
    bootstrap_sweep: sweep,
    accounting_error: error,
    over_budget: live.stored_bytes + delta.stored_bytes > sentinelReplayPayloadBudgetBytes(budgetBytes),
    last_warning_at_ms: live.stored_bytes + delta.stored_bytes > sentinelReplayPayloadBudgetBytes(budgetBytes) ? nowMs : ledger.last_warning_at_ms,
  };
  const committed = await commitBootstrapBatch(kv, versionstamp, delta, next);
  if (committed !== null) {
    settleChunkOwnerIndex(kv, sweep, index);
    // With the id now durable, one more pass may judge chunks in this same call.
    return stampedBeforeChunks(durable, index, scanned) ? await runBootstrapBatch(kv, next, committed, budgetBytes, nowMs) : next;
  }
  // Another write won. The owner index belongs to the sweep, not to this batch, so it stays as it was.
  const reread = await readLedger(kv, budgetBytes);
  return reread.kind === "corrupt" ? ledger : withBudget(reread.ledger, budgetBytes);
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
  if (ledger.bootstrap_complete) {
    // Admissions may create owners from here on, so no earlier index can be trusted again.
    forgetChunkOwnerIndex(kv);
    return ledger;
  }
  const bootstrapped = await runBootstrapBatch(kv, ledger, state.versionstamp, budgetBytes, nowMs);
  return bootstrapped.bootstrap_complete ? bootstrapped : null;
};
