import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { deserialize } from "node:v8";
import { convertKvDatabase, type ConvertOptions } from "../src/kv-conversion/convert.ts";
import { fileDigest, openLegacyCodec } from "../src/kv-conversion/legacy-codec.ts";
import { transcodePersistedCursor } from "../src/kv-conversion/cursors.ts";
import { verifyNativeSchema, type NativeRow } from "../src/kv-conversion/native-schema.ts";
import { decodeTypedValue, encodeTypedValue } from "../src/kv-conversion/typed-value.ts";
import { exists } from "./io.ts";

export type CutoverBudgets = Readonly<{ conversionAndProofMs: number; recoveryConversionMs: number; recoveryProofMs: number }>;
export function checkedCutoverBudgets(value: CutoverBudgets): CutoverBudgets {
  const budgets = {
    conversionAndProofMs: value.conversionAndProofMs,
    recoveryConversionMs: value.recoveryConversionMs,
    recoveryProofMs: value.recoveryProofMs,
  };
  if (Object.values(budgets).some((ms) => !Number.isSafeInteger(ms) || ms < 60_000 || ms > 2 * 60 * 60_000))
    throw new Error("Finite rehearsal-sized internal phase budgets are required");
  return Object.freeze(budgets);
}

export async function privateCutoverDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.() || (await realpath(path)) !== path)
    throw new Error("Cutover workspace must be a private owned physical directory");
  if ((await statfs(path)).type === 0x01021994) throw new Error("Cutover storage must be disk-backed");
}

/** A baseline-left-live recovery check must never put its codec cache in the immutable artifact. */
export async function withCutoverCodecProbe<T>(root: string, work: (directory: string) => Promise<T>): Promise<T> {
  const parent = join(root, ".data/cutovers");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await privateCutoverDirectory(parent);
  const probe = await mkdtemp(join(parent, ".codec-probe-"));
  try {
    await privateCutoverDirectory(probe);
    return await work(probe);
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

/** Called only after the host has proved the service and every database holder stopped. */
export async function checkpointCutoverStore(path: string, codec: "deno-v8" | "bun-jsc-v1"): Promise<{ sha256: string; bytes: number }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("Unsafe stopped database");
  await cutoverSourceBytes(path);
  const db = new Database(path, { strict: true, safeIntegers: true });
  try {
    const checkpoint = db.query<{ busy: bigint }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy !== 0n) throw new Error("Stopped database checkpoint is busy");
    verifyNativeSchema(db, codec);
    const largest = db.query<{ bytes: bigint | null }, []>("SELECT MAX(length(v)) AS bytes FROM kv").get()?.bytes ?? 0n;
    if (largest > 65_536n) throw new Error("Stopped database exceeds the supported per-value memory bound");
  } finally {
    db.close(true);
  }
  if ((await exists(path + "-wal")) && (await lstat(path + "-wal")).size !== 0) throw new Error("Stopped database still has pending WAL writes");
  return { sha256: await fileDigest(path), bytes: (await lstat(path)).size };
}

export async function retainedCutoverCopy(source: string, destination: string): Promise<string> {
  const before = await fileDigest(source);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  const file = await open(destination, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  if ((await fileDigest(destination)) !== before || (await fileDigest(source)) !== before) throw new Error("Stopped backup changed during preservation");
  return before;
}

type LegacyCodec = Awaited<ReturnType<typeof openLegacyCodec>>;
async function expectedRowValue(row: NativeRow, codec: LegacyCodec, sourceCodec: "deno-v8" | "bun-jsc-v1"): Promise<string> {
  if (row.v_encoding !== 1n) return Buffer.from(row.v).toString("base64");
  const graph = sourceCodec === "deno-v8" ? await codec.decode(row.v) : encodeTypedValue(deserialize(row.v));
  const value = decodeTypedValue(graph);
  const translated =
    sourceCodec === "bun-jsc-v1"
      ? transcodePersistedCursor(row.k, value, "bun-to-deno")
      : transcodePersistedCursor(row.k, transcodePersistedCursor(row.k, value, "deno-to-bun").value, "bun-to-deno");
  return JSON.stringify(encodeTypedValue(translated.value));
}

/** Compare every retained row semantically, with separate raw-key/revision/expiry evidence. */
export async function proveCutoverRoundtrip(
  source: string,
  reversed: string,
  deno: string,
  denoSha256: string,
  workspace: string,
  signal?: AbortSignal,
  sourceCodec: "deno-v8" | "bun-jsc-v1" = "deno-v8"
) {
  const left = new Database(source, { readonly: true, strict: true, safeIntegers: true });
  const right = new Database(reversed, { readonly: true, strict: true, safeIntegers: true });
  let codec: Awaited<ReturnType<typeof openLegacyCodec>> | undefined;
  const metadata = createHash("sha256"),
    semantic = createHash("sha256");
  let rows = 0;
  try {
    codec = await openLegacyCodec(deno, denoSha256, workspace, signal);
    if (
      JSON.stringify(verifyNativeSchema(left, sourceCodec), (_, value) => (typeof value === "bigint" ? String(value) : value)) !==
      JSON.stringify(verifyNativeSchema(right, "deno-v8"), (_, value) => (typeof value === "bigint" ? String(value) : value))
    )
      throw new Error("Reverse proof changed native revision metadata");
    const sql = "SELECT k,v,v_encoding,version,seq,expiration_ms FROM kv ORDER BY k";
    const original = left.query<NativeRow, []>(sql).iterate(),
      restored = right.query<NativeRow, []>(sql).iterate();
    for (;;) {
      signal?.throwIfAborted();
      const a = original.next(),
        b = restored.next();
      if (a.done || b.done) {
        if (a.done !== b.done) throw new Error("Reverse proof changed the full row count");
        break;
      }
      const fields = (row: NativeRow) =>
        JSON.stringify([Buffer.from(row.k).toString("hex"), ...[row.v_encoding, row.version, row.seq, row.expiration_ms].map(String)]);
      const key = fields(a.value);
      if (key !== fields(b.value)) throw new Error("Reverse proof changed raw keys, revisions, sequence or absolute expiry");
      const expected = await expectedRowValue(a.value, codec, sourceCodec);
      const actual = a.value.v_encoding === 1n ? JSON.stringify(await codec.decode(b.value.v)) : Buffer.from(b.value.v).toString("base64");
      if (expected !== actual) throw new Error("Reverse proof changed a typed value");
      metadata.update(key + "\n");
      semantic.update(key + "\n" + actual + "\n");
      rows++;
    }
    await codec.close();
    return { rows, metadataSha256: metadata.digest("hex"), semanticSha256: semantic.digest("hex") };
  } catch (error) {
    await codec?.abort();
    throw error;
  } finally {
    left.close(true);
    right.close(true);
  }
}

export async function convertAndProveCutover(options: Omit<ConvertOptions, "direction">, workspace: string) {
  const forward = await convertKvDatabase({ ...options, direction: "deno-to-bun" });
  const reversed = join(workspace, "reverse-proof.sqlite3");
  const reverseReceipt = join(workspace, "reverse-proof.json");
  const reverse = await convertKvDatabase({
    ...options,
    direction: "bun-to-deno",
    source: options.destination,
    destination: reversed,
    receipt: reverseReceipt,
  });
  const proof = await proveCutoverRoundtrip(options.source, reversed, options.deno, options.denoSha256, workspace, options.signal);
  if (proof.rows !== forward.source.row_count || proof.rows !== reverse.destination.row_count) throw new Error("Conversion proof row counts disagree");
  return { forward, reverse, proof, forwardReceiptSha256: await fileDigest(options.receipt), reverseReceiptSha256: await fileDigest(reverseReceipt) };
}

export async function cutoverSourceBytes(source: string): Promise<number> {
  const database = await lstat(source);
  if (!database.isFile() || database.isSymbolicLink() || database.uid !== process.getuid?.()) throw new Error("Unsafe database capacity input");
  if (await exists(source + "-journal")) throw new Error("An unsettled rollback journal is not a stopped boundary");
  let wal = 0;
  for (const suffix of ["-wal", "-shm"])
    if (await exists(source + suffix)) {
      const info = await lstat(source + suffix);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.nlink !== 1) throw new Error("Unsafe SQLite sidecar");
      if (suffix === "-wal") wal = info.size;
    }
  return database.size + wal;
}

export async function assertCutoverCapacity(directory: string, sourceBytes: number): Promise<void> {
  const fs = await statfs(directory);
  const free = fs.bavail * fs.bsize;
  const memory = /MemAvailable:\s+(\d+) kB/.exec(await readFile("/proc/meminfo", "utf8"));
  if (free < sourceBytes * 10 + 512 * 1024 * 1024 || !memory || Number(memory[1]) * 1024 < sourceBytes * 3 + 512 * 1024 * 1024)
    throw new Error("Insufficient measured cutover storage or memory headroom");
}
