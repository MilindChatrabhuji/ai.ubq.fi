import type { AtomicOperation, Kv, KvKey } from "#kv";
/**
 * Shared retention schema for capture-owned storage accounting.
 *
 * This module owns the durable row/ledger shapes, key builders, reason codes,
 * test seams, ledger IO and the single-commit mutation helper. Both the runtime
 * retention module and the resumable bootstrap module import it; it never
 * imports either of them, so the retention split has no cycles.
 *
 * The ledger under SENTINEL_REPLAY_BUDGET_LEDGER_KEY is derived cached state.
 * Durable per-capture accounting rows are the source of truth, and every
 * accounting mutation writes the row change and its ledger delta in ONE
 * kv.atomic() commit that checks the exact versionstamp of both.
 */
import { SENTINEL_REPLAY_CHUNK_PREFIX, SENTINEL_REPLAY_MANIFEST_PREFIX, SENTINEL_REPLAY_REQUEST_PREFIX, type SentinelReplayManifest } from "./replay-model.ts";
import {
  SENTINEL_REPLAY_BUDGET_BYTES,
  SENTINEL_REPLAY_LEGACY_METADATA_BYTES,
  SENTINEL_REPLAY_METADATA_RESERVE_BYTES,
  SENTINEL_REPLAY_RECORD_OVERHEAD_BYTES,
  sentinelReplayStoredCharge,
} from "./replay-limits.ts";

export const SENTINEL_REPLAY_BUDGET_LEDGER_KEY = ["uos_ai", "sentinel_replay", "v1", "budget"] as const;
/** Durable per-capture accounting rows; the 5th component is the captured-at millisecond. */
export const SENTINEL_REPLAY_ACCOUNTING_PREFIX = ["uos_ai", "sentinel_replay", "v1", "accounting"] as const;
/** Legacy pre-accounting-row reservations: read only to release their charge once, then deleted. */
export const SENTINEL_REPLAY_RESERVATION_PREFIX = ["uos_ai", "sentinel_replay", "v1", "reservation"] as const;
/** Bounded eviction/expiry tombstones consulted when a manifest is gone. */
export const SENTINEL_REPLAY_EVICTION_PREFIX = ["uos_ai", "sentinel_replay", "v1", "evicted"] as const;
export const SENTINEL_REPLAY_RESERVATION_TTL_MS = 120_000;
export const SENTINEL_REPLAY_EVICTION_REASON = "storage_budget";
export const SENTINEL_REPLAY_EXPIRED_REASON = "payload_expired";
export const SENTINEL_REPLAY_STORAGE_FULL_REASON = "storage_full";
export const SENTINEL_REPLAY_ACCOUNTING_REASON = "storage_accounting_in_progress";
export const SENTINEL_REPLAY_STATUS_NOT_RETAINED = "status_not_retained";
export const SENTINEL_REPLAY_CLEAN_TARGET_RATIO = 0.9;
/** Chunks written per bounded, fence-guarded staging batch. */
export const SENTINEL_REPLAY_STAGING_BATCH_CHUNKS = 12;
export const EVICTION_BATCH_RECORDS = 16;
export const EVICTION_MAX_CHUNK_DELETES = 512;
// One legacy materialization adds two CAS checks plus the ledger fence. Bun's
// native atomic backend accepts at most ten checks, so four rows (nine checks)
// is the largest portable batch.
export const BOOTSTRAP_BATCH_ENTRIES = 4;
// Owner rows (accounting + manifest) one slice of the chunk owner index reads.
// Fixed, so no single owner read grows with retained captures.
export const BOOTSTRAP_OWNER_SCAN_ENTRIES = 64;
// Longest a bootstrap batch waits for its sweep's owner index fill, which runs
// in the background, before it leaves the sweep in place for a later batch. A
// small store's index fills well inside it; a large one keeps filling after.
export const BOOTSTRAP_OWNER_INDEX_WAIT_MS = 500;
export const RESERVATION_REAP_LIMIT = 8;
export const STATUS_PRUNE_BATCH = 16;
export const CAS_ATTEMPTS = 5;
const TEXT_ENCODER = new TextEncoder();
const HEX_DIGEST = /^[0-9a-f]{64}$/;

export type SentinelReplayAccountingState = "reserved" | "stored" | "evicting" | "revoked";
export type SentinelReplayClaimKind = "evicted" | "expired";

/** The durable per-capture accounting row. Never written with `expireIn`. */
export type SentinelReplayAccountingRow = Readonly<{
  version: 1;
  capture_id: string;
  /** Empty only for a legacy manifest whose request owner was never recorded. */
  request_id: string;
  fingerprint: string;
  bytes: number;
  state: SentinelReplayAccountingState;
  fence: number;
  created_at_ms: number;
  /** Payload TTL: after this instant the reaper reclaims the charge as `expired`. */
  expires_at_ms: number;
  /** Bounded status/tombstone TTL, independent of the payload TTL. */
  status_expires_at_ms: number;
  /** Count of completed fence-guarded staging batches. */
  stage: number;
  /** Cause recorded when this row moves to `evicting`. */
  claim_kind?: SentinelReplayClaimKind;
}>;

/** A pre-accounting-row reservation; only ever read to release its charge once. */
export type SentinelReplayLegacyReservation = Readonly<{
  version: 1;
  capture_id: string;
  request_id: string;
  bytes: number;
  fence: number;
  state: "reserved" | "revoked" | "published";
  created_at_ms: number;
  expires_at_ms: number;
}>;

export type SentinelReplayBudgetLedger = Readonly<{
  version: 1;
  budget_bytes: number;
  stored_bytes: number;
  reserved_bytes: number;
  records: number;
  /** Capture-owned status + eviction-tombstone rows, bounded by the metadata reserve. */
  status_records: number;
  /** Approximate encoded bytes of those status/tombstone rows. */
  metadata_bytes: number;
  evicted_bytes: number;
  evicted_records: number;
  expired_bytes: number;
  expired_records: number;
  status_pruned_records: number;
  last_eviction_at_ms: number | null;
  last_warning_at_ms: number | null;
  last_full_at_ms: number | null;
  last_skip_reason: string | null;
  bootstrap_complete: boolean;
  /** "<prefix index>|<kv cursor>" while a resumable bootstrap sweep is in flight. */
  bootstrap_cursor: string | null;
  /**
   * Random id the batch that starts a sweep stamps, so in-memory state built for
   * one sweep never serves another, even after the ledger is deleted. Absent on
   * ledgers written before it existed.
   */
  bootstrap_sweep?: string | null;
  /** Sticky fail-closed marker set when an in-scope row could not be accounted. */
  accounting_error: string | null;
  over_budget: boolean;
}>;

export type SentinelReplayPublication = Readonly<{
  ledger_key: KvKey;
  ledger_versionstamp: string | null;
  ledger: SentinelReplayBudgetLedger;
  accounting_key: KvKey;
  accounting_versionstamp: string | null;
  accounting: SentinelReplayAccountingRow;
  /**
   * The exact request-status row the publication commit replaces. Its versionstamp
   * is checked with the ledger so the accounted metadata delta always describes
   * the row that was really replaced, never a row written by someone else.
   */
  status_key: KvKey;
  status_versionstamp: string | null;
}>;

export type SentinelReplayAdmission =
  | Readonly<{ ok: true; accounting_key: KvKey; accounting: SentinelReplayAccountingRow; charge: number }>
  | Readonly<{ ok: false; reason: typeof SENTINEL_REPLAY_STORAGE_FULL_REASON | typeof SENTINEL_REPLAY_ACCOUNTING_REASON }>;

export type SentinelReplayRetentionStatus = Readonly<{
  state: "ok" | "unavailable";
  scope: "capture_owned_kv_payload";
  budget_bytes: number | null;
  stored_bytes: number | null;
  reserved_bytes: number | null;
  records: number | null;
  metadata_bytes: number | null;
  status_records: number | null;
  evicted_records: number | null;
  evicted_bytes: number | null;
  expired_records: number | null;
  last_eviction_at_ms: number | null;
  last_warning_at_ms: number | null;
  over_budget: boolean;
  near_capacity: boolean;
  accounting_complete: boolean;
  accounting_error: string | null;
  skipped_reason: string | null;
}>;

let budgetOverrideForTest: number | null = null;
let faultInjectorForTest: ((kind: "delete" | "commit") => boolean) | null = null;

/** Test seam: an injectable small budget; production always uses the fixed default. */
export const setSentinelReplayBudgetForTest = (bytes: number | null): void => {
  budgetOverrideForTest = bytes === null ? null : Math.max(64 * 1_024, Math.trunc(bytes));
};

/** Test seam: an injected payload-delete or final-commit failure. One-shot by construction. */
export const setSentinelReplayRetentionFaultsForTest = (injector: ((kind: "delete" | "commit") => boolean) | null): void => {
  faultInjectorForTest = injector;
};

export const fault = (kind: "delete" | "commit"): void => {
  if (faultInjectorForTest?.(kind)) throw new Error(`injected_${kind}_failure`);
};

export const sentinelReplayBudgetBytes = (): number => budgetOverrideForTest ?? SENTINEL_REPLAY_BUDGET_BYTES;

/**
 * Fixed 64 MiB metadata reserve inside the production 1 GiB budget, so payload
 * admissions may use at most `budget_bytes - reserve`. Budgets below 1 GiB are
 * only reachable through the injectable test seam, where the reserve scales as
 * budget/16 so both bounds stay exercisable; at exactly 1 GiB the reserve is
 * exactly SENTINEL_REPLAY_METADATA_RESERVE_BYTES.
 */
export const sentinelReplayMetadataReserve = (budgetBytes: number): number =>
  Math.max(0, Math.min(SENTINEL_REPLAY_METADATA_RESERVE_BYTES, Math.floor(Math.max(0, budgetBytes) / 16)));

/** Payload admissions may use at most this much of the budget. */
export const sentinelReplayPayloadBudgetBytes = (budgetBytes: number): number => Math.max(0, budgetBytes - sentinelReplayMetadataReserve(budgetBytes));

export const sentinelReplayAccountingKey = (capturedAtMs: number, captureId: string): KvKey => [...SENTINEL_REPLAY_ACCOUNTING_PREFIX, capturedAtMs, captureId];

export const sentinelReplayManifestKey = (manifest: SentinelReplayManifest): KvKey => [
  ...SENTINEL_REPLAY_MANIFEST_PREFIX,
  manifest.captured_at_ms,
  manifest.fingerprint,
  manifest.capture_id,
];

/** The bounded eviction tombstone an owner lookup consults when a manifest is gone. */
export const sentinelReplayEvictionKey = (fingerprint: string): KvKey => [...SENTINEL_REPLAY_EVICTION_PREFIX, fingerprint];

export const sentinelReplayRequestStatusKey = (requestId: string): KvKey => [...SENTINEL_REPLAY_REQUEST_PREFIX, requestId];

/** Conservative charge for a retained manifest; legacy rows predate stored_bytes. */
export const sentinelReplayManifestCharge = (manifest: SentinelReplayManifest): number => {
  if (typeof manifest.stored_bytes === "number" && Number.isSafeInteger(manifest.stored_bytes) && manifest.stored_bytes > 0) return manifest.stored_bytes;
  return sentinelReplayStoredCharge(manifest.ciphertext_bytes, SENTINEL_REPLAY_LEGACY_METADATA_BYTES) + SENTINEL_REPLAY_RECORD_OVERHEAD_BYTES;
};

const emptyLedger = (budgetBytes: number): SentinelReplayBudgetLedger => ({
  version: 1,
  budget_bytes: budgetBytes,
  stored_bytes: 0,
  reserved_bytes: 0,
  records: 0,
  status_records: 0,
  metadata_bytes: 0,
  evicted_bytes: 0,
  evicted_records: 0,
  expired_bytes: 0,
  expired_records: 0,
  status_pruned_records: 0,
  last_eviction_at_ms: null,
  last_warning_at_ms: null,
  last_full_at_ms: null,
  last_skip_reason: null,
  bootstrap_complete: false,
  bootstrap_cursor: null,
  accounting_error: null,
  over_budget: false,
});

export const counter = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isAbsentOrString = (value: unknown): boolean => value === undefined || value === null || typeof value === "string";

/**
 * A present ledger is only accepted when every counter is a non-negative safe
 * integer and every marker has its declared shape. A malformed ledger is
 * reported as corrupt, never silently replaced with an empty ledger.
 */
const isLedger = (value: unknown): value is SentinelReplayBudgetLedger => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return false;
  for (const field of [
    "budget_bytes",
    "stored_bytes",
    "reserved_bytes",
    "records",
    "status_records",
    "metadata_bytes",
    "evicted_bytes",
    "evicted_records",
    "expired_bytes",
    "expired_records",
    "status_pruned_records",
  ]) {
    if (!counter(row[field])) return false;
  }
  if (typeof row.bootstrap_complete !== "boolean" || typeof row.over_budget !== "boolean") return false;
  for (const field of ["last_eviction_at_ms", "last_warning_at_ms", "last_full_at_ms"]) {
    if (row[field] !== null && !counter(row[field])) return false;
  }
  for (const field of ["last_skip_reason", "bootstrap_cursor", "accounting_error"]) {
    if (row[field] !== null && typeof row[field] !== "string") return false;
  }
  // Optional: ledgers written before sweeps had ids omit it.
  return isAbsentOrString(row.bootstrap_sweep);
};

export const isAccountingRow = (value: unknown): value is SentinelReplayAccountingRow => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.version === 1 &&
    typeof row.capture_id === "string" &&
    row.capture_id.length > 0 &&
    row.capture_id.length <= 128 &&
    typeof row.request_id === "string" &&
    typeof row.fingerprint === "string" &&
    HEX_DIGEST.test(row.fingerprint) &&
    counter(row.bytes) &&
    row.bytes > 0 &&
    (row.state === "reserved" || row.state === "stored" || row.state === "evicting" || row.state === "revoked") &&
    counter(row.fence) &&
    (row.fence as number) >= 1 &&
    counter(row.created_at_ms) &&
    counter(row.expires_at_ms) &&
    counter(row.status_expires_at_ms) &&
    counter(row.stage) &&
    (row.claim_kind === undefined || row.claim_kind === "evicted" || row.claim_kind === "expired")
  );
};

/** The key shape must agree with the row it holds before anything derived is touched. */
export const accountingKeyMatches = (key: KvKey, row: SentinelReplayAccountingRow): boolean =>
  key.length === SENTINEL_REPLAY_ACCOUNTING_PREFIX.length + 2 && key[3] === "accounting" && key[4] === row.created_at_ms && key[5] === row.capture_id;

export const manifestKeyMatches = (key: KvKey, manifest: SentinelReplayManifest): boolean =>
  key.length === SENTINEL_REPLAY_MANIFEST_PREFIX.length + 3 &&
  key[3] === "manifest" &&
  key[4] === manifest.captured_at_ms &&
  key[5] === manifest.fingerprint &&
  key[6] === manifest.capture_id;

export const isLegacyReservation = (value: unknown): value is SentinelReplayLegacyReservation => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.version === 1 &&
    typeof row.capture_id === "string" &&
    counter(row.bytes) &&
    counter(row.fence) &&
    (row.state === "reserved" || row.state === "revoked" || row.state === "published")
  );
};

export const sentinelReplayStatusMetadataBytes = (value: unknown): number => {
  try {
    return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength + SENTINEL_REPLAY_RECORD_OVERHEAD_BYTES;
  } catch {
    return SENTINEL_REPLAY_RECORD_OVERHEAD_BYTES;
  }
};

/**
 * Bytes an already-stored status/tombstone row contributes to the metadata bound.
 * A missing row contributes nothing, so replacing a row costs only its difference.
 */
export const storedStatusMetadataBytes = (value: unknown): number => (value === null || value === undefined ? 0 : sentinelReplayStatusMetadataBytes(value));

type LedgerState =
  | Readonly<{ kind: "absent"; ledger: SentinelReplayBudgetLedger; versionstamp: null }>
  | Readonly<{ kind: "ok"; ledger: SentinelReplayBudgetLedger; versionstamp: string }>
  | Readonly<{ kind: "corrupt"; versionstamp: string | null }>;

export const readLedger = async (kv: Kv, budgetBytes: number): Promise<LedgerState> => {
  const entry = await kv.get<SentinelReplayBudgetLedger>(SENTINEL_REPLAY_BUDGET_LEDGER_KEY);
  if (entry.value === null) return { kind: "absent", ledger: emptyLedger(budgetBytes), versionstamp: null };
  if (!isLedger(entry.value)) return { kind: "corrupt", versionstamp: entry.versionstamp };
  return { kind: "ok", ledger: entry.value, versionstamp: entry.versionstamp };
};

export const withBudget = (ledger: SentinelReplayBudgetLedger, budgetBytes: number): SentinelReplayBudgetLedger =>
  ledger.budget_bytes === budgetBytes ? ledger : { ...ledger, budget_bytes: budgetBytes };

/** Public read-only snapshot for the admin surface and tests; `null` means corrupt. */
export const readSentinelReplayLedgerSnapshot = async (
  kv: Kv,
  budgetBytes?: number
): Promise<Readonly<{ ledger: SentinelReplayBudgetLedger; versionstamp: string | null }> | null> => {
  const budget = Math.max(64 * 1_024, Math.trunc(budgetBytes ?? sentinelReplayBudgetBytes()));
  const state = await readLedger(kv, budget);
  if (state.kind === "corrupt") return null;
  return { ledger: withBudget(state.ledger, budget), versionstamp: state.versionstamp };
};

export const deleteChunkBatch = async (kv: Kv, captureId: string, limit: number): Promise<Readonly<{ deleted: number; remaining: number }>> => {
  if (limit <= 0) return { deleted: 0, remaining: 1 };
  const keys: KvKey[] = [];
  for await (const entry of kv.list({ prefix: [...SENTINEL_REPLAY_CHUNK_PREFIX, captureId] }, { limit: limit + 1 })) keys.push(entry.key);
  const batch = keys.slice(0, limit);
  for (const key of batch) {
    fault("delete");
    await kv.delete(key);
  }
  return { deleted: batch.length, remaining: keys.length - batch.length };
};

export const countChunks = async (kv: Kv, captureId: string): Promise<number> => {
  const prefix = [...SENTINEL_REPLAY_CHUNK_PREFIX, captureId];
  for await (const entry of kv.list({ prefix }, { limit: 1 })) {
    // Only a row that really sits under this capture's chunk prefix proves the
    // payload survives; an unrelated stray key must not hold the charge.
    if (entry.key.length === prefix.length + 1) return 1;
  }
  return 0;
};

/** One atomic commit: the row change and the ledger delta it describes. */
export const commitAccountingMutation = async (
  kv: Kv,
  key: KvKey,
  rowVersionstamp: string | null,
  mutate: (ledger: SentinelReplayBudgetLedger) => SentinelReplayBudgetLedger,
  applyRow: (operation: AtomicOperation) => AtomicOperation,
  budgetBytes: number
): Promise<boolean> => {
  const state = await readLedger(kv, budgetBytes);
  if (state.kind === "corrupt") return false;
  const ledger = withBudget(state.ledger, budgetBytes);
  const next = mutate(ledger);
  fault("commit");
  const committed = await applyRow(
    kv
      .atomic()
      .check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: state.versionstamp })
      .check({ key, versionstamp: rowVersionstamp })
      .set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, next)
  ).commit();
  return committed.ok;
};

/** Current retention status for the admin surface; `unavailable` is never reported as zero. */
export const readSentinelReplayRetentionStatus = async (kv: Kv, budgetBytes?: number): Promise<SentinelReplayRetentionStatus> => {
  const budget = Math.max(64 * 1_024, Math.trunc(budgetBytes ?? sentinelReplayBudgetBytes()));
  try {
    const state = await readLedger(kv, budget);
    if (state.kind === "corrupt") {
      return {
        state: "ok",
        scope: "capture_owned_kv_payload",
        budget_bytes: budget,
        stored_bytes: null,
        reserved_bytes: null,
        records: null,
        metadata_bytes: null,
        status_records: null,
        evicted_records: null,
        evicted_bytes: null,
        expired_records: null,
        last_eviction_at_ms: null,
        last_warning_at_ms: null,
        over_budget: false,
        near_capacity: false,
        accounting_complete: false,
        accounting_error: "ledger_corrupt",
        skipped_reason: SENTINEL_REPLAY_ACCOUNTING_REASON,
      };
    }
    const ledger = withBudget(state.ledger, budget);
    const payloadBudget = sentinelReplayPayloadBudgetBytes(budget);
    const used = ledger.stored_bytes + ledger.reserved_bytes;
    return {
      state: "ok",
      scope: "capture_owned_kv_payload",
      budget_bytes: budget,
      stored_bytes: ledger.stored_bytes,
      reserved_bytes: ledger.reserved_bytes,
      records: ledger.records,
      metadata_bytes: ledger.metadata_bytes,
      status_records: ledger.status_records,
      evicted_records: ledger.evicted_records,
      evicted_bytes: ledger.evicted_bytes,
      expired_records: ledger.expired_records,
      last_eviction_at_ms: ledger.last_eviction_at_ms,
      last_warning_at_ms: ledger.last_warning_at_ms,
      over_budget: used > payloadBudget,
      near_capacity: used >= Math.floor(payloadBudget * SENTINEL_REPLAY_CLEAN_TARGET_RATIO),
      accounting_complete: ledger.bootstrap_complete && ledger.accounting_error === null,
      accounting_error: ledger.accounting_error,
      skipped_reason: ledger.last_skip_reason,
    };
  } catch {
    return {
      state: "unavailable",
      scope: "capture_owned_kv_payload",
      budget_bytes: null,
      stored_bytes: null,
      reserved_bytes: null,
      records: null,
      metadata_bytes: null,
      status_records: null,
      evicted_records: null,
      evicted_bytes: null,
      expired_records: null,
      last_eviction_at_ms: null,
      last_warning_at_ms: null,
      over_budget: false,
      near_capacity: false,
      accounting_complete: false,
      accounting_error: "unavailable",
      skipped_reason: null,
    };
  }
};
