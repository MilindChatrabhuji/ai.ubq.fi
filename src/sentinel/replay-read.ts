import type { Kv, KvEntry, KvKey } from "#kv";
// Sentinel replay manifest reading and export, split out of src/sentinel_replay_capture.ts.

import { isSentinelIncidentCaptureReference, isSentinelIncidentId, SENTINEL_INCIDENT_CAPTURE_REF_PREFIX } from "./incident-outbox.ts";
import { base64UrlDecode, base64UrlEncode, isRecord } from "../utils.ts";
import type {
  AcceptedSentinelReplayInput,
  ExportedSentinelReplayCapture,
  SentinelReplayCaptureStatusRow,
  SentinelReplayManifest,
  SentinelReplayPlaintext,
} from "./replay-model.ts";
import {
  AES_GCM_IV_BYTES,
  CAPTURE_ID,
  ENVELOPE_VERSION,
  HEX_DIGEST,
  KV_CURSOR,
  MAX_CAPTURE_ID_CHARS,
  MAX_REPLAY_CHUNKS,
  MAX_REPLAY_CIPHERTEXT_BYTES,
  REPLAY_KEY_BYTES,
  SENTINEL_REPLAY_CHUNK_BYTES,
  SENTINEL_REPLAY_CHUNK_PREFIX,
  SENTINEL_REPLAY_EXPORT_PAGE_LIMIT,
  SENTINEL_REPLAY_MANIFEST_PREFIX,
  SENTINEL_REPLAY_TTL_MS,
  cloneBytes,
  concatBytes,
  requestStatusKey,
} from "./replay-model.ts";
import { isSentinelReplayCaptureStatusRow, isSentinelReplayRequestId, sentinelFailureSignature } from "./replay-observation.ts";
import { decodePlaintext, encryptionAdditionalData, fingerprintParts, gunzip, hmacHex, importAesKey } from "./replay-envelope.ts";
import {
  readSentinelReplayLedgerSnapshot,
  SENTINEL_REPLAY_EVICTION_REASON,
  SENTINEL_REPLAY_EXPIRED_REASON,
  SENTINEL_REPLAY_STATUS_NOT_RETAINED,
  sentinelReplayEvictionKey,
} from "./replay-retention-schema.ts";

const decodedIvIsValid = (value: string): boolean => {
  if (value.length < 16 || value.length > 24 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return base64UrlDecode(value).byteLength === AES_GCM_IV_BYTES;
  } catch {
    return false;
  }
};

export const isSentinelReplayManifest = (value: unknown): value is SentinelReplayManifest => {
  if (
    !isRecord(value) ||
    value.version !== ENVELOPE_VERSION ||
    typeof value.capture_id !== "string" ||
    value.capture_id.length < 1 ||
    value.capture_id.length > MAX_CAPTURE_ID_CHARS ||
    !CAPTURE_ID.test(value.capture_id) ||
    typeof value.fingerprint !== "string" ||
    !HEX_DIGEST.test(value.fingerprint) ||
    typeof value.case_group_digest !== "string" ||
    !HEX_DIGEST.test(value.case_group_digest) ||
    typeof value.captured_at_ms !== "number" ||
    !Number.isSafeInteger(value.captured_at_ms) ||
    value.captured_at_ms < 0 ||
    typeof value.expires_at_ms !== "number" ||
    !Number.isSafeInteger(value.expires_at_ms) ||
    value.expires_at_ms !== value.captured_at_ms + SENTINEL_REPLAY_TTL_MS ||
    value.algorithm !== "AES-256-GCM" ||
    value.compression !== "gzip" ||
    typeof value.iv !== "string" ||
    !decodedIvIsValid(value.iv) ||
    typeof value.chunk_count !== "number" ||
    !Number.isSafeInteger(value.chunk_count) ||
    value.chunk_count < 1 ||
    value.chunk_count > MAX_REPLAY_CHUNKS ||
    typeof value.ciphertext_bytes !== "number" ||
    !Number.isSafeInteger(value.ciphertext_bytes) ||
    value.ciphertext_bytes < 16 ||
    value.ciphertext_bytes > MAX_REPLAY_CIPHERTEXT_BYTES ||
    (value.stored_bytes !== undefined && (typeof value.stored_bytes !== "number" || !Number.isSafeInteger(value.stored_bytes) || value.stored_bytes <= 0)) ||
    (value.request_id !== undefined && !isSentinelReplayRequestId(value.request_id))
  )
    return false;
  const minimumBytes = (value.chunk_count - 1) * SENTINEL_REPLAY_CHUNK_BYTES + 1;
  return value.ciphertext_bytes >= minimumBytes && value.ciphertext_bytes <= value.chunk_count * SENTINEL_REPLAY_CHUNK_BYTES;
};

const expectedChunkBytes = (manifest: SentinelReplayManifest, index: number): number =>
  index < manifest.chunk_count - 1 ? SENTINEL_REPLAY_CHUNK_BYTES : manifest.ciphertext_bytes - (manifest.chunk_count - 1) * SENTINEL_REPLAY_CHUNK_BYTES;

const assertChunkSize = (manifest: SentinelReplayManifest, index: number, bytes: Uint8Array): void => {
  if (bytes.byteLength !== expectedChunkBytes(manifest, index)) {
    throw new Error("Sentinel replay chunk size does not match its manifest");
  }
};

export const isExportedSentinelReplayCapture = (value: unknown): value is ExportedSentinelReplayCapture => {
  if (!isRecord(value) || !isSentinelReplayManifest(value.manifest) || !Array.isArray(value.chunks)) return false;
  if (value.chunks.length !== value.manifest.chunk_count) return false;
  try {
    for (let index = 0; index < value.chunks.length; index++) {
      const encoded = value.chunks[index];
      if (
        typeof encoded !== "string" ||
        encoded.length < 1 ||
        encoded.length > Math.ceil(SENTINEL_REPLAY_CHUNK_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9_-]+$/.test(encoded)
      )
        return false;
      assertChunkSize(value.manifest, index, base64UrlDecode(encoded));
    }
    return true;
  } catch {
    return false;
  }
};

const getChunks = async (kv: Kv, manifest: SentinelReplayManifest): Promise<Uint8Array<ArrayBuffer>[]> => {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < manifest.chunk_count; offset += 10) {
    const keys = Array.from(
      { length: Math.min(10, manifest.chunk_count - offset) },
      (_, index) => [...SENTINEL_REPLAY_CHUNK_PREFIX, manifest.capture_id, offset + index] as KvKey
    );
    const entries = await kv.getMany<readonly Uint8Array[]>(keys);
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex];
      if (!(entry.value instanceof Uint8Array)) throw new Error("Sentinel replay chunk is missing");
      assertChunkSize(manifest, offset + entryIndex, entry.value);
      chunks.push(cloneBytes(entry.value));
    }
  }
  return chunks;
};

const manifestEntryMatchesKey = (entry: KvEntry<SentinelReplayManifest>): boolean => {
  if (!SENTINEL_REPLAY_MANIFEST_PREFIX.every((part, index) => entry.key[index] === part)) return false;
  const suffix = entry.key.slice(SENTINEL_REPLAY_MANIFEST_PREFIX.length);
  return suffix.length === 3 && suffix[0] === entry.value.captured_at_ms && suffix[1] === entry.value.fingerprint && suffix[2] === entry.value.capture_id;
};

const manifestMatchesKey = (key: KvKey, manifest: SentinelReplayManifest): boolean => {
  const suffix = key.slice(SENTINEL_REPLAY_MANIFEST_PREFIX.length);
  return (
    SENTINEL_REPLAY_MANIFEST_PREFIX.every((part, index) => key[index] === part) &&
    suffix.length === 3 &&
    suffix[0] === manifest.captured_at_ms &&
    suffix[1] === manifest.fingerprint &&
    suffix[2] === manifest.capture_id
  );
};

/**
 * Project a stored manifest onto the frozen export wire schema. `stored_bytes`
 * and `request_id` are additive retention-accounting fields of the stored row;
 * the export contract is frozen and its strict consumer rejects unknown
 * manifest keys, so those fields never leave the store.
 */
const exportedManifest = (manifest: SentinelReplayManifest): SentinelReplayManifest => ({
  version: manifest.version,
  capture_id: manifest.capture_id,
  fingerprint: manifest.fingerprint,
  case_group_digest: manifest.case_group_digest,
  captured_at_ms: manifest.captured_at_ms,
  expires_at_ms: manifest.expires_at_ms,
  algorithm: manifest.algorithm,
  compression: manifest.compression,
  iv: manifest.iv,
  chunk_count: manifest.chunk_count,
  ciphertext_bytes: manifest.ciphertext_bytes,
});

export const listEncryptedSentinelReplays = async (
  kv: Kv,
  options: Readonly<{ afterMs: number; beforeMs: number; cursor?: string; limit?: number }>
): Promise<Readonly<{ captures: ExportedSentinelReplayCapture[]; cursor: string }>> => {
  if (!Number.isSafeInteger(options.afterMs) || options.afterMs < 0) {
    throw new Error("Sentinel replay export start is invalid");
  }
  if (!Number.isSafeInteger(options.beforeMs) || options.beforeMs < options.afterMs || options.beforeMs >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Sentinel replay export end is invalid");
  }
  if (options.limit !== undefined && options.limit !== SENTINEL_REPLAY_EXPORT_PAGE_LIMIT) {
    throw new Error("Sentinel replay export limit must be one");
  }
  if (options.cursor !== undefined && (options.cursor.length < 1 || options.cursor.length > 2_048 || !KV_CURSOR.test(options.cursor))) {
    throw new Error("Sentinel replay export cursor is invalid");
  }
  const iterator = kv.list<SentinelReplayManifest>(
    {
      prefix: SENTINEL_REPLAY_MANIFEST_PREFIX,
      start: [...SENTINEL_REPLAY_MANIFEST_PREFIX, options.afterMs],
    },
    { cursor: options.cursor, limit: SENTINEL_REPLAY_EXPORT_PAGE_LIMIT }
  );
  const captures: ExportedSentinelReplayCapture[] = [];
  let rangeExhausted = false;
  for await (const entry of iterator) {
    if (!isSentinelReplayManifest(entry.value) || !manifestEntryMatchesKey(entry)) {
      throw new Error("Sentinel replay manifest is invalid");
    }
    if (entry.value.captured_at_ms < options.afterMs) throw new Error("Sentinel replay manifest order is invalid");
    if (entry.value.captured_at_ms > options.beforeMs) {
      rangeExhausted = true;
      break;
    }
    const chunks = await getChunks(kv, entry.value);
    captures.push({ manifest: exportedManifest(entry.value), chunks: chunks.map(base64UrlEncode) });
    break;
  }
  return { captures, cursor: rangeExhausted ? "" : iterator.cursor };
};

/** Validate one capture reference row and return its fingerprint and manifest key. */
const incidentCaptureReference = (reference: KvEntry<unknown>, prefixLength: number): Readonly<{ fingerprint: string; manifestKey: KvKey }> => {
  const fingerprint = reference.key.at(-1);
  if (
    reference.key.length !== prefixLength + 1 ||
    typeof fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(fingerprint) ||
    !isSentinelIncidentCaptureReference(reference.value)
  )
    throw new Error("Sentinel incident replay reference is invalid");
  return { fingerprint, manifestKey: reference.value.manifest_key };
};

/**
 * Best-effort CAS cleanup of a reference whose manifest is gone. The check is
 * pinned to the listed versionstamp so a concurrent writer that re-created the
 * reference wins; the scan still advances past the entry either way.
 */
const dropStaleCaptureReference = async (kv: Kv, reference: KvEntry<unknown>): Promise<void> => {
  await kv
    .atomic()
    .check({ key: reference.key, versionstamp: reference.versionstamp })
    .delete(reference.key)
    .commit()
    .catch(() => {});
};

/**
 * List one incident's exportable captures, one capture per page.
 *
 * A capture reference whose manifest is gone names a capture the store no
 * longer holds (its payload was evicted or expired). That is a real "gone"
 * state, never a fault: the stale reference is removed with a CAS-guarded
 * delete and the scan continues, so one dangling reference can never turn the
 * whole incident export into an error. A reference record that exists but does
 * not describe a capture is still rejected fail-closed.
 */
export const listEncryptedSentinelIncidentReplays = async (
  kv: Kv,
  options: Readonly<{ incidentId: string; cursor?: string; limit?: number }>
): Promise<Readonly<{ captures: ExportedSentinelReplayCapture[]; cursor: string }>> => {
  if (!isSentinelIncidentId(options.incidentId)) throw new Error("Sentinel incident ID is invalid");
  if (options.limit !== undefined && options.limit !== SENTINEL_REPLAY_EXPORT_PAGE_LIMIT) {
    throw new Error("Sentinel replay export limit must be one");
  }
  if (options.cursor !== undefined && (options.cursor.length < 1 || options.cursor.length > 2_048 || !KV_CURSOR.test(options.cursor)))
    throw new Error("Sentinel replay export cursor is invalid");
  const prefix = [...SENTINEL_INCIDENT_CAPTURE_REF_PREFIX, options.incidentId] as const;
  const captures: ExportedSentinelReplayCapture[] = [];
  let scanCursor = options.cursor;
  for (;;) {
    const iterator = kv.list({ prefix }, { cursor: scanCursor, limit: SENTINEL_REPLAY_EXPORT_PAGE_LIMIT });
    let reference: KvEntry<unknown> | null = null;
    for await (const entry of iterator) {
      reference = entry;
      break;
    }
    // Exhaustion is an empty page, never a fault: an incident whose captures
    // were all evicted or expired genuinely has nothing left to export.
    if (reference === null) return { captures, cursor: "" };
    const resumeCursor = iterator.cursor;
    const { fingerprint, manifestKey } = incidentCaptureReference(reference, prefix.length);
    const manifestEntry = await kv.get<SentinelReplayManifest>(manifestKey);
    if (manifestEntry.value === null) {
      await dropStaleCaptureReference(kv, reference);
      scanCursor = resumeCursor;
      continue;
    }
    if (
      !isSentinelReplayManifest(manifestEntry.value) ||
      manifestEntry.value.fingerprint !== fingerprint ||
      !manifestMatchesKey(manifestKey, manifestEntry.value)
    )
      throw new Error("Sentinel incident replay manifest is unavailable");
    const chunks = await getChunks(kv, manifestEntry.value);
    captures.push({ manifest: exportedManifest(manifestEntry.value), chunks: chunks.map(base64UrlEncode) });
    return { captures, cursor: resumeCursor };
  }
};

/**
 * Read the capture status for one request id. `expired` is derived at read time
 * from the stored expiry. A request with no row is `unknown` while every
 * capture-owned status row is still retained; once bounded pruning has removed
 * any status/tombstone row, a missing lookup is reported as the distinct
 * `status_not_retained` instead of inventing `evicted`/`expired`/`ready`,
 * because the store can no longer prove the row never existed.
 */
export const readSentinelReplayCaptureStatus = async (kv: Kv, requestId: string, nowMs: number = Date.now()): Promise<SentinelReplayCaptureStatusRow> => {
  if (!isSentinelReplayRequestId(requestId)) throw new Error("Sentinel replay request ID is invalid");
  const entry = await kv.get<SentinelReplayCaptureStatusRow>(requestStatusKey(requestId));
  if (entry.value === null) {
    const ledger = await readSentinelReplayLedgerSnapshot(kv).catch(() => null);
    const pruned = (ledger?.ledger.status_pruned_records ?? 0) > 0;
    return {
      version: 1,
      request_id: requestId,
      status: pruned ? "status_not_retained" : "unknown",
      reason: pruned ? SENTINEL_REPLAY_STATUS_NOT_RETAINED : "no_capture_record",
      captured_at_ms: nowMs,
      manifest_key: null,
      fingerprint: null,
      expires_at_ms: null,
    };
  }
  if (!isSentinelReplayCaptureStatusRow(entry.value)) throw new Error("Sentinel replay capture status record is invalid");
  if (entry.value.expires_at_ms !== null && entry.value.expires_at_ms <= nowMs) {
    return { ...entry.value, status: "expired" };
  }
  return entry.value;
};

/** Export the capture a request id points at, if its manifest is still present. */
export const listEncryptedSentinelReplaysByRequestId = async (
  kv: Kv,
  requestId: string,
  nowMs: number = Date.now()
): Promise<Readonly<{ captures: ExportedSentinelReplayCapture[]; status: SentinelReplayCaptureStatusRow }>> => {
  const status = await readSentinelReplayCaptureStatus(kv, requestId, nowMs);
  if (status.manifest_key === null || status.fingerprint === null) return { captures: [], status };
  const manifestEntry = await kv.get<SentinelReplayManifest>(status.manifest_key);
  if (
    !manifestEntry.value ||
    !isSentinelReplayManifest(manifestEntry.value) ||
    manifestEntry.value.fingerprint !== status.fingerprint ||
    !manifestMatchesKey(status.manifest_key, manifestEntry.value)
  ) {
    // A missing manifest is either a retention eviction or a TTL/expiry race.
    // The bounded eviction tombstone distinguishes them truthfully; absence of
    // a tombstone keeps the existing expired classification.
    const tombstone = await kv.get(sentinelReplayEvictionKey(status.fingerprint));
    if (isRecord(tombstone.value) && tombstone.value.reason === SENTINEL_REPLAY_EVICTION_REASON) {
      return { captures: [], status: { ...status, status: "evicted", reason: SENTINEL_REPLAY_EVICTION_REASON } };
    }
    if (isRecord(tombstone.value) && tombstone.value.reason === SENTINEL_REPLAY_EXPIRED_REASON) {
      return { captures: [], status: { ...status, status: "expired", reason: SENTINEL_REPLAY_EXPIRED_REASON } };
    }
    return { captures: [], status: { ...status, status: "expired", reason: "manifest_unavailable" } };
  }
  const chunks = await getChunks(kv, manifestEntry.value);
  return { captures: [{ manifest: exportedManifest(manifestEntry.value), chunks: chunks.map(base64UrlEncode) }], status };
};

export const decryptExportedSentinelReplay = async (
  exported: ExportedSentinelReplayCapture,
  keyBytes: Uint8Array<ArrayBuffer>
): Promise<SentinelReplayPlaintext> => {
  if (keyBytes.byteLength !== REPLAY_KEY_BYTES) throw new Error("Sentinel replay key must be 32 bytes");
  if (!isExportedSentinelReplayCapture(exported)) throw new Error("Sentinel replay export is invalid");
  const decodedChunks = exported.chunks.map(base64UrlDecode);
  const ciphertext = concatBytes(decodedChunks);
  if (ciphertext.byteLength !== exported.manifest.ciphertext_bytes) {
    ciphertext.fill(0);
    for (const chunk of decodedChunks) chunk.fill(0);
    throw new Error("Sentinel replay ciphertext length does not match its manifest");
  }
  const iv = base64UrlDecode(exported.manifest.iv);
  let compressed: Uint8Array<ArrayBuffer>;
  try {
    compressed = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encryptionAdditionalData(exported.manifest.fingerprint) },
        await importAesKey(keyBytes),
        ciphertext
      )
    );
  } finally {
    ciphertext.fill(0);
    for (const chunk of decodedChunks) chunk.fill(0);
  }
  let decodedPlaintext: Uint8Array<ArrayBuffer>;
  try {
    decodedPlaintext = await gunzip(compressed);
  } finally {
    compressed.fill(0);
  }
  let plaintext: SentinelReplayPlaintext;
  try {
    plaintext = decodePlaintext(decodedPlaintext);
  } finally {
    decodedPlaintext.fill(0);
  }
  const accepted: AcceptedSentinelReplayInput = {
    endpoint: plaintext.endpoint,
    method: plaintext.method,
    body: plaintext.body,
    content_type: plaintext.content_type,
    compatibility_headers: plaintext.compatibility_headers,
    request_id: plaintext.request_id,
    git_sha: plaintext.git_sha,
    deno_revision: plaintext.deno_revision,
  };
  try {
    const fingerprint = await hmacHex(keyBytes, "fingerprint", fingerprintParts(accepted, plaintext.failure_signature, "fingerprint", plaintext.upstream));
    const caseGroupDigest = await hmacHex(keyBytes, "case-group", fingerprintParts(accepted, plaintext.failure_signature, "case-group"));
    if (
      fingerprint !== exported.manifest.fingerprint ||
      caseGroupDigest !== exported.manifest.case_group_digest ||
      plaintext.captured_at_ms !== exported.manifest.captured_at_ms ||
      sentinelFailureSignature(plaintext.client_observation) !== plaintext.failure_signature
    ) {
      throw new Error("Sentinel replay manifest integrity check failed");
    }
    return plaintext;
  } catch (error) {
    plaintext.body.fill(0);
    throw error;
  }
};

export { getChunks, manifestMatchesKey };
