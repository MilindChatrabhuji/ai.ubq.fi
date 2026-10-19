// Offline synthetic native fixture only. Every source module path is frozen by its receipt.
import { Database } from "bun:sqlite";
import { deserialize, serialize } from "node:v8";
import { existsSync } from "node:fs";

const [mode, directory, profilePath, graphPath, keyPath, schemaPath, inputPath] = Bun.argv.slice(2);
if (!["capture", "restore"].includes(mode) || !directory.startsWith("/tmp/ai-rust-wasm-20261018/")) throw new Error("Invalid isolated fixture arguments");
const { toValue } = await import(profilePath);
const { decodeTypedValue, encodeTypedValue } = await import(graphPath);
const { packKey } = await import(keyPath);
const { NATIVE_DDL, createNativeSnapshotReader, validateNativeRow, verifyNativeSchema } = await import(schemaPath);
const input = await Bun.file(inputPath).json();
let capture;
if (mode === "capture") {
  const entries = input.entries.map((entry, index) => ({
    raw_key: [...packKey(entry.key.map(toValue))],
    value: { encoding: "source-graph-v1", value: encodeTypedValue(toValue(entry.value)) },
    revision: { version: "10", sequence: String(index) },
    expiration_ms: entry.expires_at_ms ?? -1,
  }));
  const shared = new ArrayBuffer(16);
  new Uint8Array(shared).set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const alias = { text: "\ud83d", negative: -0 };
  const cycle = { shared, a: new Uint8Array(shared, 3, 4), b: new DataView(shared, 5, 2), first: alias, second: alias };
  cycle.self = cycle;
  const sparse = new Array(5);
  sparse[3] = cycle;
  sparse.named = alias;
  const values = [cycle, sparse, { buffer: Buffer.from([1, 2, 3]) }, new Map([[alias, new Set([alias])]])];
  for (const [index, value] of values.entries()) {
    entries.push({
      raw_key: [...packKey(["default", "native-graph", index])],
      value: { encoding: "source-graph-v1", value: encodeTypedValue(value) },
      revision: { version: "11", sequence: String(index) },
      expiration_ms: 9000,
    });
  }
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, 18446744073709551615n, true);
  entries.push({
    raw_key: [...packKey(["default", "native-counter"])],
    value: { encoding: "counter-le64", value: [...counter] },
    revision: { version: "12", sequence: "0" },
    expiration_ms: -1,
  });
  entries.push({
    raw_key: [...packKey(["default", "native-bytes"])],
    value: { encoding: "bytes", value: [0, 255, 3] },
    revision: { version: "12", sequence: "1" },
    expiration_ms: 9000,
  });
  entries.push({
    raw_key: [...packKey(["default"]), 2, 255, 254, 0],
    value: { encoding: "source-graph-v1", value: encodeTypedValue("opaque raw string tuple") },
    revision: { version: "13", sequence: "0" },
    expiration_ms: 9000,
  });
  capture = {
    v: 2,
    source_git_sha: input.source_git_sha,
    captured_at_ms: input.captured_at_ms,
    source_codec: "bun-jsc-v1",
    native_schema_version: 3,
    data_revision: { version: "50", sequence: "0" },
    queue_entries: 0,
    running_queue_entries: 0,
    entries,
  };
} else capture = input;

const destination = `${directory}/${mode}-new.sqlite3`;
if (existsSync(destination)) throw new Error("The synthetic destination must be new");
let database = new Database(destination, { create: true, strict: true, safeIntegers: true });
database.run("PRAGMA journal_mode=DELETE");
database.run("BEGIN IMMEDIATE");
for (const ddl of NATIVE_DDL) database.run(ddl);
database.run("CREATE TABLE uos_kv_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
database.run("INSERT INTO uos_kv_metadata(key,value) VALUES('codec','bun-jsc-v1')");
database.run("INSERT INTO migration_state(k,version) VALUES(0,3)");
database.run("INSERT INTO data_version(k,version,seq) VALUES(0,?,?)", [BigInt(capture.data_revision.version), BigInt(capture.data_revision.sequence)]);
for (const entry of capture.entries) {
  const graph = entry.value.encoding === "source-graph-v1";
  const bytes = graph ? serialize(decodeTypedValue(entry.value.value)) : new Uint8Array(entry.value.value);
  const encoding = graph ? 1n : entry.value.encoding === "counter-le64" ? 2n : 3n;
  database.run("INSERT INTO kv(k,v,v_encoding,version,seq,expiration_ms) VALUES(?,?,?,?,?,?)", [
    new Uint8Array(entry.raw_key),
    bytes,
    encoding,
    BigInt(entry.revision.version),
    BigInt(entry.revision.sequence),
    BigInt(entry.expiration_ms),
  ]);
}
database.run("COMMIT");
database.close(true);
database = new Database(destination, { readonly: true, strict: true, safeIntegers: true });
const reader = createNativeSnapshotReader(database);
const revision = verifyNativeSchema(reader, "bun-jsc-v1");
const rows = reader.query("SELECT k,v,v_encoding,version,seq,expiration_ms FROM kv ORDER BY k").all();
if (rows.length !== capture.entries.length) throw new Error("Native fixture row inventory differs");
for (const row of rows) {
  validateNativeRow(row, revision);
  const expected = capture.entries.find((entry) => Buffer.from(entry.raw_key).equals(row.k));
  if (
    !expected ||
    String(row.version) !== expected.revision.version ||
    String(row.seq) !== expected.revision.sequence ||
    Number(row.expiration_ms) !== expected.expiration_ms
  )
    throw new Error("Native key/revision/expiry changed");
  if (row.v_encoding === 1n) {
    const actual = encodeTypedValue(deserialize(row.v));
    if (JSON.stringify(actual) !== JSON.stringify(expected.value.value)) throw new Error("Native graph topology, UTF16 or view backing changed");
  } else if (!Buffer.from(row.v).equals(new Uint8Array(expected.value.value))) throw new Error("Native counter or bytes changed");
}
reader.close();
if (mode === "capture") await Bun.write(`${directory}/capture.json`, JSON.stringify(capture, null, 2) + "\n");
process.stdout.write(
  JSON.stringify({ runtime: Bun.version, mode, rows: rows.length, native_schema_restart: "passed", exact_graph_roundtrip: "passed" }) + "\n"
);
