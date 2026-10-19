/** Local offline producer only: no HTTP, process/service control, environment discovery or restore. */
import { assertPortableKvKeyBytes, assertPortableKvValue } from "../../../../src/storage/kv.ts";
import { deserialize } from "node:v8";
import { withPrivateConsistentBunSnapshot } from "../../../../src/kv-conversion/convert.ts";
import { validateNativeRow, type NativeRow } from "../../../../src/kv-conversion/native-schema.ts";
import { encodeNativeCaptureValue, type TypedValue } from "../../../../src/kv-conversion/typed-value.ts";

type NativeValue = { encoding: "source-graph-v1"; value: TypedValue } | { encoding: "counter-le64" | "bytes"; value: number[] };
export type NativeCapture = {
  v: 2;
  source_git_sha: string;
  captured_at_ms: number;
  source_codec: "bun-jsc-v1";
  native_schema_version: 3;
  data_revision: { version: string; sequence: string };
  queue_entries: number;
  running_queue_entries: number;
  entries: { raw_key: number[]; value: NativeValue; revision: { version: string; sequence: string }; expiration_ms: number }[];
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
      const expiration = Number(row.expiration_ms);
      if (!Number.isSafeInteger(expiration)) throw new Error("Native capture absolute expiry is not exactly representable");
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
