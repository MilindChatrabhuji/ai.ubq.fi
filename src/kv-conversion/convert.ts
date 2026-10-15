import { constants as sqlite, Database } from "bun:sqlite";
import { assertPortableKvKeyBytes, assertPortableKvValue } from "#kv";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deserialize, serialize } from "node:v8";
import { transcodePersistedCursor, type ConversionDirection } from "./cursors.ts";
import { fileDigest, openLegacyCodec } from "./legacy-codec.ts";
import { createNativeSnapshotReader, NATIVE_DDL, validateNativeRow, verifyNativeSchema, type NativeReader, type NativeRow } from "./native-schema.ts";
import { decodeTypedValue, encodeTypedValue } from "./typed-value.ts";

export type ConvertOptions = {
  direction: ConversionDirection;
  source: string;
  destination: string;
  receipt: string;
  deno: string;
  denoSha256: string;
  signal?: AbortSignal;
};
const syncFile = (path: string): void => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
const snapshotIdentity = async (path: string) => {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error("Source must be a regular SQLite file");
  const wal = `${path}-wal`;
  if (existsSync(wal) && lstatSync(wal).size !== 0) throw new Error("Source must be stopped, drained and checkpointed; nonempty WAL is refused");
  if (existsSync(`${path}-journal`)) throw new Error("Source has an unsettled rollback journal");
  return {
    sha256: await fileDigest(path),
    size: String(stat.size),
    device: String(stat.dev),
    inode: String(stat.ino),
    mtime_ns: String(stat.mtimeNs),
    wal: existsSync(wal) ? "empty" : "absent",
    drain_boundary: "checkpointed-no-wal",
  };
};
const privateSnapshotIdentity = async (path: string, expected?: Awaited<ReturnType<typeof snapshotIdentity>>) => {
  if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(path + suffix))) throw new Error("Exclusive conversion snapshot must not have SQLite sidecars");
  const identity = await snapshotIdentity(path);
  if (expected && JSON.stringify(identity) !== JSON.stringify(expected)) throw new Error("Private conversion snapshot changed");
  return identity;
};
const openPrivateSnapshot = async (path: string, codec: "deno-v8" | "bun-jsc-v1", expected: Awaited<ReturnType<typeof snapshotIdentity>>) => {
  // URI is explicit on every platform; no normal WAL open may create snapshot sidecars.
  await privateSnapshotIdentity(path, expected);
  const uri = pathToFileURL(path);
  uri.searchParams.set("immutable", "1");
  const reader = createNativeSnapshotReader(new Database(uri.href, sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_URI));
  try {
    return { reader, revision: verifyNativeSchema(reader, codec) };
  } catch (error) {
    reader.close();
    throw error;
  }
};
const digestRows = (db: NativeReader, expiryOnly = false): string => {
  const hash = createHash("sha256");
  for (const row of db.query<NativeRow>("SELECT k,v,v_encoding,version,seq,expiration_ms FROM kv ORDER BY k").iterate()) {
    hash.update(
      JSON.stringify(
        expiryOnly
          ? [Buffer.from(row.k).toString("hex"), String(row.expiration_ms)]
          : [
              Buffer.from(row.k).toString("hex"),
              Buffer.from(row.v).toString("base64"),
              String(row.v_encoding),
              String(row.version),
              String(row.seq),
              String(row.expiration_ms),
            ]
      )
    );
    hash.update("\n");
  }
  return hash.digest("hex");
};

type LegacyCodec = Awaited<ReturnType<typeof openLegacyCodec>>;
const transcodeValue = async (row: NativeRow, codec: LegacyCodec, direction: ConversionDirection) => {
  if (Number(row.v_encoding) !== 1) return { bytes: row.v, changed: false };
  const graph = direction === "deno-to-bun" ? await codec.decode(row.v) : encodeTypedValue(deserialize(row.v));
  const translated = transcodePersistedCursor(row.k, decodeTypedValue(graph), direction);
  const targetGraph = translated.changed ? encodeTypedValue(translated.value) : graph;
  if (direction === "bun-to-deno") return { bytes: await codec.encode(targetGraph), changed: translated.changed };
  const convertedValue = decodeTypedValue(targetGraph);
  assertPortableKvValue(convertedValue);
  const bytes = serialize(convertedValue);
  if (JSON.stringify(encodeTypedValue(deserialize(bytes))) !== JSON.stringify(targetGraph)) throw new Error("Bun typed-value roundtrip changed semantics");
  return { bytes, changed: translated.changed };
};
const transferRows = async (
  input: NativeReader,
  output: Database,
  codec: LegacyCodec,
  options: ConvertOptions,
  revision: import("./native-schema.ts").NativeRevision
) => {
  let count = 0;
  let cursors = 0;
  const insert = output.query("INSERT INTO kv(k,v,v_encoding,version,seq,expiration_ms) VALUES(?,?,?,?,?,?)");
  for (const row of input.query<NativeRow>("SELECT k,v,v_encoding,version,seq,expiration_ms FROM kv ORDER BY k").iterate()) {
    options.signal?.throwIfAborted();
    validateNativeRow(row, revision);
    assertPortableKvKeyBytes(row.k);
    const converted = await transcodeValue(row, codec, options.direction);
    cursors += Number(converted.changed);
    insert.run(row.k, converted.bytes, row.v_encoding, row.version, row.seq, row.expiration_ms);
    count++;
  }
  return { count, cursors };
};

/** Convert a drained full database, never a filtered profile export or a writable live handle. */
export const convertKvDatabase = async (options: ConvertOptions) => {
  if (!["deno-to-bun", "bun-to-deno"].includes(options.direction)) throw new Error("Unknown conversion direction");
  const source = resolve(options.source);
  const destination = resolve(options.destination);
  const receiptPath = resolve(options.receipt);
  if (source === destination || source === receiptPath || destination === receiptPath || existsSync(destination) || existsSync(receiptPath))
    throw new Error("Conversion destination and receipt must be NEW paths");
  options.signal?.throwIfAborted();
  const identity = await snapshotIdentity(source);
  const staging = mkdtempSync(join(dirname(destination), ".uos-kv-conversion-"));
  let input: ReturnType<typeof createNativeSnapshotReader> | undefined;
  let output: Database | undefined;
  let codec: Awaited<ReturnType<typeof openLegacyCodec>> | undefined;
  let published = false;
  let receiptPublished = false;
  const abort = () => {
    options.signal?.throwIfAborted();
  };
  try {
    const snapshot = join(staging, "source.sqlite3");
    const candidate = join(staging, "candidate.sqlite3");
    const receiptFile = join(staging, "receipt.json");
    copyFileSync(source, snapshot, constants.COPYFILE_EXCL);
    const copiedIdentity = await privateSnapshotIdentity(snapshot);
    if (copiedIdentity.sha256 !== identity.sha256 || JSON.stringify(await snapshotIdentity(source)) !== JSON.stringify(identity))
      throw new Error("Source changed during snapshot");
    const sourceCodec = options.direction === "deno-to-bun" ? "deno-v8" : "bun-jsc-v1";
    const destinationCodec = options.direction === "deno-to-bun" ? "bun-jsc-v1" : "deno-v8";
    const opened = await openPrivateSnapshot(snapshot, sourceCodec, copiedIdentity);
    input = opened.reader;
    const revision = opened.revision;
    const schemaMetadata = input.query<{ type: string; name: string; sql: string | null }>("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
    codec = await openLegacyCodec(options.deno, options.denoSha256, staging, options.signal);
    output = new Database(candidate, { create: true, strict: true, safeIntegers: true });
    output.run("PRAGMA journal_mode=DELETE");
    output.run("BEGIN IMMEDIATE");
    for (const statement of NATIVE_DDL) output.run(statement);
    output.run("INSERT INTO migration_state(k,version) VALUES(0,3)");
    output.run("INSERT INTO data_version(k,version,seq) VALUES(?,?,?)", [revision.k, revision.version, revision.seq]);
    if (destinationCodec === "bun-jsc-v1") {
      output.run("CREATE TABLE uos_kv_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
      output.run("INSERT INTO uos_kv_metadata(key,value) VALUES('codec','bun-jsc-v1'),('created_bun_version',?)", [Bun.version]);
    }
    const { count, cursors } = await transferRows(input, output, codec, options, revision);
    await codec.close();
    abort();
    output.run("COMMIT");
    verifyNativeSchema(output, destinationCodec);
    const sourceDigest = digestRows(input);
    const destinationDigest = digestRows(output);
    const expiryDigest = digestRows(input, true);
    if (expiryDigest !== digestRows(output, true)) throw new Error("Absolute expiration or raw key changed during conversion");
    input.close();
    input = undefined;
    output.close(true);
    output = undefined;
    await privateSnapshotIdentity(snapshot, copiedIdentity);
    if (JSON.stringify(await snapshotIdentity(source)) !== JSON.stringify(identity)) throw new Error("Source changed before conversion publication");
    const receipt = {
      schema: "uos-kv-runtime-conversion-v1" as const,
      direction: options.direction,
      source: { path: source, codec: sourceCodec, file: identity, snapshot: identity, row_count: count, content_sha256: sourceDigest },
      destination: {
        path: destination,
        codec: destinationCodec,
        file: { sha256: await fileDigest(candidate), size: String(lstatSync(candidate).size) },
        row_count: count,
        content_sha256: destinationDigest,
      },
      native_schema_version: 3,
      schema_metadata: {
        source: schemaMetadata,
        migration_state: { k: "0", version: "3" },
        data_version: { k: String(revision.k), version: String(revision.version), seq: String(revision.seq) },
        user_version: "0",
        application_id: "0",
      },
      last_native_revision: { version: String(revision.version), seq: String(revision.seq) },
      absolute_expiry_sha256: expiryDigest,
      transcoded_cursors: cursors,
      deno: codec.identity,
      bun_version: Bun.version,
      completed_at: new Date().toISOString(),
    };
    writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(candidate, 0o600);
    syncFile(candidate);
    syncFile(receiptFile);
    abort();
    // Hard links are atomic and exclusive: even a concurrent destination creator cannot be overwritten.
    linkSync(candidate, destination);
    published = true;
    linkSync(receiptFile, receiptPath);
    receiptPublished = true;
    syncFile(dirname(destination));
    if (dirname(receiptPath) !== dirname(destination)) syncFile(dirname(receiptPath));
    return receipt;
  } catch (error) {
    await codec?.abort();
    input?.close();
    output?.close(true);
    if (receiptPublished) rmSync(receiptPath);
    if (published) rmSync(destination);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};
