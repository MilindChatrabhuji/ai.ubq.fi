/** Local offline producer only: no HTTP, process/service control, environment discovery or restore. */
import { assertPortableKvKeyBytes, assertPortableKvValue } from "../../../../src/storage/kv.ts";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { deserialize } from "node:v8";
import { withPrivateConsistentBunSnapshot } from "../../../../src/kv-conversion/convert.ts";
import { validateNativeRow, type NativeRow } from "../../../../src/kv-conversion/native-schema.ts";
import { encodeNativeCaptureValue, type TypedValue } from "../../../../src/kv-conversion/typed-value.ts";

type NativeValue = { encoding: "source-graph-v1"; value: TypedValue } | { encoding: "counter-le64" | "bytes"; value: number[] };
type RawJsonNumber = Readonly<{ rawJSON: string }>;
type NativeJson = Readonly<{ rawJSON: (source: string) => unknown; isRawJSON: (value: unknown) => unknown }>;
const isNativeJson = (value: unknown): value is NativeJson =>
  typeof value === "object" &&
  value !== null &&
  "rawJSON" in value &&
  typeof value.rawJSON === "function" &&
  "isRawJSON" in value &&
  typeof value.isRawJSON === "function";
const isRawJsonNumber = (value: unknown, json: NativeJson): value is RawJsonNumber =>
  typeof value === "object" && value !== null && "rawJSON" in value && typeof value.rawJSON === "string" && json.isRawJSON(value) === true;
const exactJsonNumber = (value: bigint): RawJsonNumber => {
  const json: unknown = JSON;
  if (!isNativeJson(json)) throw new Error("Pinned Bun raw JSON number support is unavailable");
  const raw = json.rawJSON(String(value));
  if (!isRawJsonNumber(raw, json)) throw new Error("Pinned Bun raw JSON number support is unavailable");
  return raw;
};
export type NativeCapture = {
  v: 2;
  source_git_sha: string;
  captured_at_ms: number;
  source_codec: "bun-jsc-v1";
  native_schema_version: 3;
  data_revision: { version: string; sequence: string };
  queue_entries: number;
  running_queue_entries: number;
  entries: {
    raw_key: number[];
    value: NativeValue;
    revision: { version: string; sequence: string };
    expiration_ms: number | RawJsonNumber;
  }[];
};

export type PrivateNativeCaptureFileReceipt = Readonly<{
  v: 1;
  destination: string;
  sha256: string;
  bytes: number;
  entries: number;
  maximum_entry_bytes: number;
  source_git_sha: string;
  captured_at_ms: number;
  source_identity: Readonly<{ sha256: string; size: string }>;
  data_revision: Readonly<{ version: string; sequence: string }>;
  queue_entries: number;
  running_queue_entries: number;
}>;

const writeAll = (fd: number, bytes: Uint8Array): void => {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
};

/** Stream one complete native capture into a NEW owner-only file.
 * The header is emitted once and each ordered source row is serialized once.
 * The whole-file SHA-256 and count bind the exact bytes for a separate
 * Captured::read EOF/inventory verification. This does not copy the source
 * database into memory or claim current source ownership.
 */
export const writePrivateNativeCapture = async (
  source: string,
  stagingParent: string,
  sourceGitSha: string,
  capturedAtMs: number,
  destination: string
): Promise<PrivateNativeCaptureFileReceipt> => {
  if (!/^[a-f0-9]{40}$/.test(sourceGitSha) || !Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0)
    throw new Error("Native capture identity or clock is invalid");
  const requested = resolve(destination);
  const parent = realpathSync(dirname(requested));
  const target = join(parent, basename(requested));
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || (parentStat.mode & 0o077) !== 0) throw new Error("Native capture destination parent must be canonical and owner-only");
  const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  let written = 0;
  let entries = 0;
  let maximumEntryBytes = 0;
  const hash = createHash("sha256");
  const emit = (text: string): void => {
    const bytes = Buffer.from(text, "utf8");
    writeAll(fd, bytes);
    hash.update(bytes);
    written += bytes.length;
  };
  try {
    const captured = await withPrivateConsistentBunSnapshot(
      source,
      stagingParent,
      (reader, revision): Omit<PrivateNativeCaptureFileReceipt, "v" | "destination" | "sha256" | "bytes" | "source_identity"> => {
        const count = (table: "queue" | "queue_running"): number =>
          Number(reader.query<{ count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`).all()[0]?.count);
        const queueEntries = count("queue");
        const runningQueueEntries = count("queue_running");
        const header = {
          v: 2,
          source_git_sha: sourceGitSha,
          captured_at_ms: capturedAtMs,
          source_codec: "bun-jsc-v1",
          native_schema_version: 3,
          data_revision: { version: String(revision.version), sequence: String(revision.seq) },
          queue_entries: queueEntries,
          running_queue_entries: runningQueueEntries,
        };
        const serializedHeader = JSON.stringify(header);
        emit(serializedHeader.slice(0, -1));
        emit(',"entries":[');
        for (const row of reader.query<NativeRow>("SELECT k,v,v_encoding,version,seq,expiration_ms FROM kv ORDER BY k").iterate()) {
          validateNativeRow(row, revision);
          assertPortableKvKeyBytes(row.k);
          const numericExpiry = Number(row.expiration_ms);
          const expiration = Number.isSafeInteger(numericExpiry) ? numericExpiry : exactJsonNumber(row.expiration_ms);
          let value: NativeValue;
          if (row.v_encoding === 1n) {
            const decoded: unknown = deserialize(row.v);
            assertPortableKvValue(decoded);
            value = { encoding: "source-graph-v1", value: encodeNativeCaptureValue(decoded) };
          } else value = { encoding: row.v_encoding === 2n ? "counter-le64" : "bytes", value: [...row.v] };
          const entry = JSON.stringify({
            raw_key: [...row.k],
            value,
            revision: { version: String(row.version), sequence: String(row.seq) },
            expiration_ms: expiration,
          });
          if (entries !== 0) emit(",");
          emit(entry);
          entries++;
          maximumEntryBytes = Math.max(maximumEntryBytes, Buffer.byteLength(entry));
        }
        emit("]}");
        return {
          entries,
          maximum_entry_bytes: maximumEntryBytes,
          source_git_sha: sourceGitSha,
          captured_at_ms: capturedAtMs,
          data_revision: header.data_revision,
          queue_entries: queueEntries,
          running_queue_entries: runningQueueEntries,
        };
      }
    );
    fsyncSync(fd);
    closeSync(fd);
    const final = lstatSync(target);
    if (!final.isFile() || final.nlink !== 1 || (final.mode & 0o777) !== 0o600 || final.size !== written)
      throw new Error("Native capture destination changed while writing");
    return {
      v: 1,
      destination: target,
      sha256: hash.digest("hex"),
      bytes: written,
      source_identity: { sha256: captured.sourceIdentity.sha256, size: captured.sourceIdentity.size },
      ...captured.value,
    };
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(target);
    } catch {}
    throw error;
  }
};

/** Caller-owned process quiescence is separate from the verified private snapshot.
 * This returns source data, not a native-owner registration or adoption permission.
 */
export const capturePrivateNativeState = async (source: string, stagingParent: string, sourceGitSha: string, capturedAtMs: number) => {
  if (!/^[a-f0-9]{40}$/.test(sourceGitSha) || !Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0)
    throw new Error("Native capture identity or clock is invalid");
  return withPrivateConsistentBunSnapshot(source, stagingParent, (reader, revision): NativeCapture => {
    const entries: NativeCapture["entries"] = [];
    for (const row of reader.query<NativeRow>("SELECT k,v,v_encoding,version,seq,expiration_ms FROM kv ORDER BY k").iterate()) {
      validateNativeRow(row, revision);
      assertPortableKvKeyBytes(row.k);
      const numericExpiry = Number(row.expiration_ms);
      // Retain the existing i64 JSON number wire beyond JavaScript's safe range.
      // Callers must send these serialized bytes without parsing them through Number.
      const expiration = Number.isSafeInteger(numericExpiry) ? numericExpiry : exactJsonNumber(row.expiration_ms);
      let value: NativeValue;
      if (row.v_encoding === 1n) {
        const decoded: unknown = deserialize(row.v);
        assertPortableKvValue(decoded);
        value = { encoding: "source-graph-v1", value: encodeNativeCaptureValue(decoded) };
      } else value = { encoding: row.v_encoding === 2n ? "counter-le64" : "bytes", value: [...row.v] };
      entries.push({
        raw_key: [...row.k],
        value,
        revision: { version: String(row.version), sequence: String(row.seq) },
        expiration_ms: expiration,
      });
    }
    const count = (table: "queue" | "queue_running"): number =>
      Number(reader.query<{ count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`).all()[0]?.count);
    return {
      v: 2,
      source_git_sha: sourceGitSha,
      captured_at_ms: capturedAtMs,
      source_codec: "bun-jsc-v1",
      native_schema_version: 3,
      data_revision: { version: String(revision.version), sequence: String(revision.seq) },
      queue_entries: count("queue"),
      running_queue_entries: count("queue_running"),
      entries,
    };
  });
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const source = value("source");
  const stagingParent = value("staging-parent");
  const sourceGitSha = value("source-git-sha");
  const capturedAt = value("captured-at-ms");
  const destination = value("destination");
  const receipt = value("receipt");
  if (!source || !stagingParent || !sourceGitSha || !capturedAt || !destination || !receipt) {
    console.error(
      "usage: bun native-operator-capture.ts --source <sqlite> --staging-parent <private-dir> --source-git-sha <sha> --captured-at-ms <ms> --destination <new-private-file> --receipt <new-private-file>"
    );
    process.exit(2);
  }
  const result = await writePrivateNativeCapture(source, stagingParent, sourceGitSha, Number(capturedAt), destination);
  writeFileSync(receipt, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(result));
}
