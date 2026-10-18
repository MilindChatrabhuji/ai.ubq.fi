import type { Kv, KvEntry, KvKey } from "#kv";
/** Reconstruct TTL-bound metadata counters only from a complete, unchanged-ledger scan. */
import { HEX_DIGEST, SENTINEL_REPLAY_REQUEST_PREFIX } from "./replay-model.ts";
import { SENTINEL_REPLAY_MAX_STATUS_RECORDS } from "./replay-limits.ts";
import { isSentinelReplayCaptureStatusRow, isSentinelReplayRequestId } from "./replay-observation.ts";
import {
  counter,
  readLedger,
  SENTINEL_REPLAY_BUDGET_LEDGER_KEY,
  SENTINEL_REPLAY_EVICTION_PREFIX,
  SENTINEL_REPLAY_EVICTION_REASON,
  SENTINEL_REPLAY_EXPIRED_REASON,
  sentinelReplayStatusMetadataBytes,
  withBudget,
} from "./replay-retention-schema.ts";

/** Durable marker of the last committed maintenance recount; it sits outside every counted prefix. */
export const SENTINEL_REPLAY_METADATA_RECONCILED_KEY = ["uos_ai", "sentinel_replay", "v1", "metadata_reconciled"] as const;
/**
 * When a maintenance recount last met a corrupt or mismatched metadata row. It
 * defers the next maintenance recount like the marker does, so a bad row costs
 * one bounded scan per interval instead of one per admin poll; it is written with
 * the interval as its TTL. It sits outside every counted prefix.
 */
const SENTINEL_REPLAY_METADATA_RECOUNT_FAILED_KEY = ["uos_ai", "sentinel_replay", "v1", "metadata_recount_failed"] as const;
/**
 * Admin-poll maintenance recounts status/tombstone metadata at most once per
 * interval. Native TTL deletion only leaves the counters conservatively high, so
 * between recounts the admin status may overstate them by rows that already
 * expired; the first maintenance pass at least this long after the last
 * committed recount removes that residual charge. Admission and publish under
 * metadata pressure never wait for it: their pruning path recounts at once.
 */
export const SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS = 15 * 60 * 1_000;

type ReconcileMarker = Readonly<{ version: 1; reconciled_at_ms: number }>;
type RecountFailure = Readonly<{ version: 1; failed_at_ms: number }>;
/** A maintenance recount: its time, and the marker version it read, which its commit checks. */
type MaintenanceRecount = Readonly<{ at_ms: number; marker_versionstamp: string | null }>;
type MetadataTotals = Readonly<{ records: number; bytes: number }>;
type MetadataScan = Readonly<{ kind: "complete"; totals: MetadataTotals }> | Readonly<{ kind: "over_limit" | "failed" }>;

const isTombstone = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.version === 1 &&
    typeof row.fingerprint === "string" &&
    HEX_DIGEST.test(row.fingerprint) &&
    (row.request_id === "" || isSentinelReplayRequestId(row.request_id)) &&
    counter(row.evicted_at_ms) &&
    (row.reason === SENTINEL_REPLAY_EVICTION_REASON || row.reason === SENTINEL_REPLAY_EXPIRED_REASON)
  );
};

export const metadataEntryMatches = (entry: KvEntry<unknown>, prefix: KvKey): boolean => {
  if (entry.key.length !== prefix.length + 1 || !prefix.every((part, index) => entry.key[index] === part)) return false;
  if (prefix === SENTINEL_REPLAY_REQUEST_PREFIX) {
    return isSentinelReplayCaptureStatusRow(entry.value) && entry.key[prefix.length] === entry.value.request_id;
  }
  return isTombstone(entry.value) && entry.key[prefix.length] === entry.value.fingerprint;
};

const scanMetadata = async (kv: Kv): Promise<MetadataScan> => {
  let records = 0;
  let bytes = 0;
  for (const prefix of [SENTINEL_REPLAY_REQUEST_PREFIX, SENTINEL_REPLAY_EVICTION_PREFIX]) {
    // One extra entry proves truncation. Both iterators must genuinely exhaust,
    // and the combined row budget remains bounded even for legacy over-cap data.
    const limit = SENTINEL_REPLAY_MAX_STATUS_RECORDS + 1 - records;
    for await (const entry of kv.list({ prefix }, { consistency: "strong", limit, batchSize: 128 })) {
      if (!metadataEntryMatches(entry, prefix)) return { kind: "failed" };
      if (records >= SENTINEL_REPLAY_MAX_STATUS_RECORDS) return { kind: "over_limit" };
      records += 1;
      bytes += sentinelReplayStatusMetadataBytes(entry.value);
    }
  }
  return { kind: "complete", totals: { records, bytes } };
};

/**
 * Deliberate metadata mutations change the ledger with their rows, so its version
 * must be captured BEFORE listing and checked AFTER both complete prefix scans.
 * Native TTL deletion can only make this count conservatively high; a later pass
 * removes that residual charge. Valid over-cap data permits bounded pruning only
 * after the same ledger CAS; its partial totals are never committed.
 * A partial/corrupt scan or CAS loss changes no counter.
 *
 * A recount that matches the ledger leaves the ledger unwritten, so an unchanged
 * pass never moves its version under concurrent CAS writers. For a maintenance
 * recount the same commit records the marker and checks that the marker is still
 * the version this pass read: a lost CAS therefore never records a recount that
 * did not land, and of two concurrent due passes only one records its time, so
 * the marker never moves back. A maintenance scan that meets a corrupt or
 * mismatched row records the failure under the same marker check.
 */
export const reconcileSentinelReplayStatusMetadata = async (
  kv: Kv,
  budgetBytes: number,
  maintenance?: MaintenanceRecount
): Promise<"reconciled" | "over_limit" | "failed"> => {
  try {
    const state = await readLedger(kv, budgetBytes);
    if (state.kind !== "ok" || !state.ledger.bootstrap_complete || state.ledger.accounting_error !== null) return "failed";
    const scan = await scanMetadata(kv);
    if (scan.kind === "failed") {
      if (maintenance !== undefined) await recordRecountFailure(kv, maintenance);
      return "failed";
    }
    const operation = kv.atomic().check({ key: SENTINEL_REPLAY_BUDGET_LEDGER_KEY, versionstamp: state.versionstamp });
    if (scan.kind === "complete") {
      const ledger = withBudget(state.ledger, budgetBytes);
      const changed = ledger !== state.ledger || ledger.status_records !== scan.totals.records || ledger.metadata_bytes !== scan.totals.bytes;
      if (changed) operation.set(SENTINEL_REPLAY_BUDGET_LEDGER_KEY, { ...ledger, status_records: scan.totals.records, metadata_bytes: scan.totals.bytes });
    }
    if (maintenance !== undefined) {
      const marker: ReconcileMarker = { version: 1, reconciled_at_ms: maintenance.at_ms };
      operation.check({ key: SENTINEL_REPLAY_METADATA_RECONCILED_KEY, versionstamp: maintenance.marker_versionstamp });
      operation.set(SENTINEL_REPLAY_METADATA_RECONCILED_KEY, marker);
    }
    const committed = await operation.commit();
    if (!committed.ok) return "failed";
    return scan.kind === "complete" ? "reconciled" : "over_limit";
  } catch {
    return "failed";
  }
};

/** Best effort: a lost write only means the next poll scans again, as before the backoff existed. */
const recordRecountFailure = async (kv: Kv, maintenance: MaintenanceRecount): Promise<void> => {
  const failure: RecountFailure = { version: 1, failed_at_ms: maintenance.at_ms };
  await kv
    .atomic()
    .check({ key: SENTINEL_REPLAY_METADATA_RECONCILED_KEY, versionstamp: maintenance.marker_versionstamp })
    .set(SENTINEL_REPLAY_METADATA_RECOUNT_FAILED_KEY, failure, { expireIn: SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS })
    .commit();
};

/** Whether a valid time recorded under `field` is no later than `nowMs` and less than one interval before it. */
const withinInterval = (value: unknown, field: "reconciled_at_ms" | "failed_at_ms", nowMs: number): boolean => {
  if (!counter(nowMs) || typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const at = row[field];
  if (row.version !== 1 || !counter(at)) return false;
  return at <= nowMs && nowMs - at < SENTINEL_REPLAY_METADATA_RECONCILE_INTERVAL_MS;
};

/**
 * The throttled recount for admin-poll maintenance. A valid marker inside the
 * interval, or a recorded scan failure inside it, defers the recount: the poll
 * reads those two rows instead of every status/tombstone row, and the recount
 * writes nothing. A missing or malformed row, one at least the interval old, one
 * from a clock that ran ahead of `nowMs`, or an invalid `nowMs` defers nothing.
 * A due recount that commits (including a valid over-cap witness) records the
 * marker. A lost CAS records nothing, so the next poll retries it; a scan that
 * meets a corrupt or mismatched row records the failure, so the next scan waits
 * one interval.
 */
export const reconcileSentinelReplayStatusMetadataIfDue = async (
  kv: Kv,
  budgetBytes: number,
  nowMs: number
): Promise<"reconciled" | "over_limit" | "failed" | "not_due"> => {
  let markerVersionstamp: string | null;
  try {
    const [marker, failure] = await kv.getMany([SENTINEL_REPLAY_METADATA_RECONCILED_KEY, SENTINEL_REPLAY_METADATA_RECOUNT_FAILED_KEY]);
    if (withinInterval(marker.value, "reconciled_at_ms", nowMs) || withinInterval(failure.value, "failed_at_ms", nowMs)) return "not_due";
    markerVersionstamp = marker.versionstamp;
  } catch {
    return "failed";
  }
  return await reconcileSentinelReplayStatusMetadata(kv, budgetBytes, counter(nowMs) ? { at_ms: nowMs, marker_versionstamp: markerVersionstamp } : undefined);
};
