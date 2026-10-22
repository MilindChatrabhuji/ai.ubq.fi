import assert from "node:assert/strict";
import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";
import { capturePrivateNativeState, writePrivateNativeCapture } from "../rust/crates/gateway-migration/examples/native-operator-capture.ts";
import { NATIVE_DDL } from "../src/kv-conversion/native-schema.ts";
import { packStringKey } from "../src/kv-conversion/cursors.ts";
import { decodeNativeCaptureValue, decodeTypedValue, encodeNativeCaptureValue, encodeTypedValue } from "../src/kv-conversion/typed-value.ts";

const sourceGraph = () => {
  const raw = new ArrayBuffer(16);
  new Uint8Array(raw).set([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const native = Buffer.from(raw, 3, 5);
  const source: Record<string, unknown> = { raw, native, again: native, ordinary: new Uint8Array(raw, 3, 5), text: "\ud83d" };
  source.self = source;
  return source;
};

test("native capture Buffer retains brand, backing aliases, cycles and equal-but-distinct ordinary views without widening legacy", () => {
  const source = sourceGraph();
  assert.throws(() => encodeTypedValue(source), /Unsupported typed array/);
  const graph = encodeNativeCaptureValue(source);
  assert.throws(() => decodeTypedValue(graph), /Unsupported interchange node: Buffer/);
  const restored = decodeNativeCaptureValue(graph) as typeof source;
  assert.ok(Buffer.isBuffer(restored.native));
  assert.equal(restored.native, restored.again);
  assert.equal(restored.self, restored);
  assert.equal(restored.native.buffer, restored.raw);
  assert.equal(restored.native.byteOffset, 3);
  assert.equal(restored.native.byteLength, 5);
  assert.notEqual(restored.native, restored.ordinary);
  assert.equal((restored.ordinary as Uint8Array).buffer, restored.raw);
  assert.deepEqual(encodeNativeCaptureValue(restored), graph);
  const ordinary = { text: "\ud83d", values: [undefined, -0, 7n, new Date(NaN), /x/gi] };
  assert.equal(JSON.stringify(encodeNativeCaptureValue(ordinary)), JSON.stringify(encodeTypedValue(ordinary)));
});

test("native capture Buffer rejects missing coordinates and a non-buffer backing", () => {
  for (const malformed of ["offset", "backing"]) {
    const graph = encodeNativeCaptureValue(sourceGraph());
    const view = graph.nodes.find((node) => node.type === "Buffer");
    assert.ok(view);
    if (malformed === "offset") delete view.offset;
    else view.buffer = graph.root;
    assert.throws(() => decodeNativeCaptureValue(graph), /Incomplete|ArrayBuffer backing/);
  }
});

test("finite native producer reads actual marked SQLite bytes and preserves raw keys, revisions, expiry, counter and Buffer topology", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uos-native-producer-"));
  try {
    const source = join(directory, "source.sqlite3");
    const database = new Database(source, { create: true, strict: true, safeIntegers: true });
    database.run("PRAGMA journal_mode=DELETE");
    for (const ddl of NATIVE_DDL) database.run(ddl);
    database.run("CREATE TABLE uos_kv_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    database.run("INSERT INTO uos_kv_metadata(key,value) VALUES('codec','bun-jsc-v1')");
    database.run("INSERT INTO migration_state(k,version) VALUES(0,3)");
    database.run("INSERT INTO data_version(k,version,seq) VALUES(0,10,0)");
    const graph = sourceGraph();
    const key = packStringKey(["default", "native-capture"]);
    database.run("INSERT INTO kv(k,v,v_encoding,version,seq,expiration_ms) VALUES(?,?,?,?,?,?)", [key, serialize(graph), 1n, 9n, 0n, 9500n]);
    database.run("INSERT INTO kv(k,v,v_encoding,version,seq,expiration_ms) VALUES(?,?,?,?,?,?)", [
      packStringKey(["default", "counter"]),
      new Uint8Array(8).fill(255),
      2n,
      8n,
      0n,
      -1n,
    ]);
    database.run("INSERT INTO kv(k,v,v_encoding,version,seq,expiration_ms) VALUES(?,?,?,?,?,?)", [
      packStringKey(["default", "bytes"]),
      new Uint8Array([0, 255]),
      3n,
      8n,
      1n,
      9223372036854775807n,
    ]);
    database.close(true);
    const original = readFileSync(source);
    const capture = await capturePrivateNativeState(source, directory, "a".repeat(40), 2300);
    assert.deepEqual(capture.value.data_revision, { version: "10", sequence: "0" });
    assert.equal(capture.value.queue_entries, 0);
    assert.equal(capture.value.running_queue_entries, 0);
    const row = capture.value.entries.find((entry) => Buffer.from(entry.raw_key).equals(key));
    assert.ok(row);
    assert.deepEqual(row.revision, { version: "9", sequence: "0" });
    assert.equal(row.expiration_ms, 9500);
    assert.equal(row.value.encoding, "source-graph-v1");
    assert.deepEqual(row.value.value, encodeNativeCaptureValue(graph));
    assert.equal(capture.value.entries.find((entry) => entry.value.encoding === "counter-le64")?.expiration_ms, -1);
    assert.ok(JSON.stringify(capture.value).includes('"expiration_ms":9223372036854775807'));
    assert.deepEqual(readFileSync(source), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming private producer writes one owner-only file with exact count, hash and raw i64 expiry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uos-native-stream-"));
  try {
    const source = join(directory, "source.sqlite3");
    const database = new Database(source, { create: true, strict: true, safeIntegers: true });
    database.run("PRAGMA journal_mode=DELETE");
    for (const ddl of NATIVE_DDL) database.run(ddl);
    database.run("CREATE TABLE uos_kv_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    database.run("INSERT INTO uos_kv_metadata(key,value) VALUES('codec','bun-jsc-v1')");
    database.run("INSERT INTO migration_state(k,version) VALUES(0,3)");
    database.run("INSERT INTO data_version(k,version,seq) VALUES(0,10,0)");
    database.run("INSERT INTO kv(k,v,v_encoding,version,seq,expiration_ms) VALUES(?,?,?,?,?,?)", [
      packStringKey(["default", "stream-graph"]),
      serialize(sourceGraph()),
      1n,
      9n,
      0n,
      9500n,
    ]);
    database.run("INSERT INTO kv(k,v,v_encoding,version,seq,expiration_ms) VALUES(?,?,?,?,?,?)", [
      packStringKey(["default", "stream-counter"]),
      new Uint8Array(8).fill(255),
      2n,
      8n,
      0n,
      -1n,
    ]);
    database.run("INSERT INTO kv(k,v,v_encoding,version,seq,expiration_ms) VALUES(?,?,?,?,?,?)", [
      packStringKey(["default", "stream-bytes"]),
      new Uint8Array([0, 255]),
      3n,
      8n,
      1n,
      9223372036854775807n,
    ]);
    database.close(true);
    const destination = join(directory, "native-capture.json");
    const receipt = await writePrivateNativeCapture(source, directory, "b".repeat(40), 2400, destination);
    const bytes = readFileSync(destination);
    assert.equal(receipt.bytes, bytes.length);
    assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(receipt.entries, 3);
    assert.equal(receipt.maximum_entry_bytes > 0, true);
    const file = lstatSync(destination);
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal(file.nlink, 1);
    const parsed = JSON.parse(bytes.toString()) as {
      v: number;
      entries: { raw_key: number[]; revision: { version: string; sequence: string }; expiration_ms: number | { rawJSON: string } }[];
      data_revision: { version: string; sequence: string };
    };
    assert.equal(parsed.v, 2);
    assert.equal(parsed.entries.length, receipt.entries);
    assert.deepEqual(parsed.data_revision, { version: "10", sequence: "0" });
    assert.equal(parsed.entries[0].raw_key.length > 0, true);
    assert.ok(bytes.toString().includes('"expiration_ms":9223372036854775807'));
    await assert.rejects(writePrivateNativeCapture(source, directory, "b".repeat(40), 2400, destination), /EEXIST|file already exists/);
    const shared = join(directory, "shared");
    mkdirSync(shared, { mode: 0o755 });
    await assert.rejects(writePrivateNativeCapture(source, directory, "b".repeat(40), 2400, join(shared, "capture.json")), /owner-only/);
    assert.deepEqual(readFileSync(destination), bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
