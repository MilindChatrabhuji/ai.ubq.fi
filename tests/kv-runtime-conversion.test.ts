import assert from "node:assert/strict";
import { createTestNativeKvPreload, currentTestNativeKvBinding } from "../scripts/test-native-kv.ts";
import { afterEach, expect, test } from "bun:test";
import { constants as sqlite, Database } from "bun:sqlite";
import { assertPortableKvKeyBytes, KvU64, openKv } from "#kv";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyKvMigrationKey, parseKvMigrationEntryLine } from "../src/cache/kv-migration-base.ts";
import { convertKvDatabase } from "../src/kv-conversion/convert.ts";
import { fileDigest } from "../src/kv-conversion/legacy-codec.ts";
import { packStringKey, transcodePersistedCursor } from "../src/kv-conversion/cursors.ts";
import { createNativeSnapshotReader, NATIVE_DDL, verifyNativeSchema } from "../src/kv-conversion/native-schema.ts";
import { entryToJson, exportEntries, toKey, toValue, valueToJson } from "../src/kv-conversion/profile-json.ts";
import { decodeTypedValue, encodeTypedValue } from "../src/kv-conversion/typed-value.ts";

const owned: string[] = [];
const fixture = () => {
  const path = mkdtempSync(join(tmpdir(), "uos-kv-converter-test-"));
  owned.push(path);
  return path;
};
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("actual Bun profile CLI exports, analyzes and imports disposable typed state with unchanged filtering", async () => {
  const root = fixture();
  const source = join(root, "source.sqlite3");
  const destination = join(root, "destination.sqlite3");
  const ndjson = join(root, "profile.ndjson");
  const cli = fileURLToPath(new URL("../scripts/kv-migrate.ts", import.meta.url));
  const payload = { bytes: new Uint8Array([7, 4]), missing: undefined, synthetic_fixture: true };
  const original = await openKv(source);
  try {
    await original.set(["uos_ai", "runtime_config", "v2"], payload);
    await original.set(["ubq_ai", "codex_auth"], { synthetic_fixture: true });
    await original.set(["uos_ai", "auth", "challenges", "synthetic"], "skip");
  } finally {
    original.close();
  }
  const execute = async (args: string[]): Promise<{ imported?: number; skipped?: number; total?: number }> => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--no-install",
        "--define",
        "UOS_TEST_NATIVE_KV_BINDING:" + JSON.stringify(currentTestNativeKvBinding()),
        "--preload",
        createTestNativeKvPreload(root),
        cli,
        ...args,
      ],
      { env: {}, stdout: "pipe", stderr: "pipe" }
    );
    const [text, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(exit, 0, error);
    return JSON.parse(text);
  };
  await execute(["export", "--source", source, "--out", ndjson]);
  expect((await execute(["analyze", "--in", ndjson, "--profile", "local"])).total).toBe(3);
  const result = await execute(["import-local", "--in", ndjson, "--db", destination, "--profile", "local"]);
  expect(result.imported).toBe(2);
  expect(result.skipped).toBe(1);
  const restored = await openKv(destination);
  try {
    expect((await restored.get(["uos_ai", "runtime_config", "v2"])).value).toEqual(payload);
    expect((await restored.get(["uos_ai", "auth", "challenges", "synthetic"])).value).toBeNull();
  } finally {
    restored.close();
  }
});

test("retains profile JSON wire tags, nested values, U64 identity and profile namespace filtering", () => {
  const source = {
    nested: [undefined, 4n, new Uint8Array([0, 255])],
    when: new Date(1700000000000),
    set: new Set([2n]),
    map: new Map([[true, "yes"]]),
    count: new KvU64(18446744073709551615n),
  };
  const row = entryToJson({
    key: ["uos_ai", "runtime_config", "v2", new Uint8Array([7]), 9n, true, Infinity],
    value: source,
    versionstamp: "00000000000000010000",
  });
  expect(row.value.type).toBe("object");
  expect(toKey(row.key)).toEqual(["uos_ai", "runtime_config", "v2", new Uint8Array([7]), 9n, true, Infinity]);
  expect(parseKvMigrationEntryLine(JSON.stringify(row)).value).toEqual(source);
  expect((toValue({ type: "KvU64", value: "42" }) as KvU64).value).toBe(42n);
  expect(
    classifyKvMigrationKey(["uos_ai", "sentinel_replay", "v1", "manifest", "x"], { profile: "prod", includeCache: false, includeLegacy: false }).action
  ).toBe("skip");
  expect(classifyKvMigrationKey(["ubq_ai", "codex_auth"], { profile: "local", includeCache: false, includeLegacy: true }).action).toBe("import");
  expect(classifyKvMigrationKey(["ubq_ai", "codex_auth"], { profile: "prod", includeCache: false, includeLegacy: false }).action).toBe("skip");
});

test("profile export is NDJSON through actual Bun KV with typed values", async () => {
  const kv = await openKv(":memory:");
  try {
    await kv.set(["uos_ai", "runtime_config", "v2"], { payload: new Uint8Array([1, 2]), missing: undefined });
    const text = await new Response(exportEntries(kv, { prefix: [] })).text();
    expect(text.endsWith("\n")).toBe(true);
    expect(parseKvMigrationEntryLine(text.trim()).value).toEqual({ payload: new Uint8Array([1, 2]), missing: undefined });
  } finally {
    kv.close();
  }
});

test("graph interchange preserves cycles, sparse arrays, shared buffers, offsets, special numbers and errors", () => {
  const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
  const sparse = new Array(3);
  sparse[2] = undefined;
  const source: Record<string, unknown> = {
    sparse,
    first: new Uint8Array(buffer, 1, 2),
    second: new DataView(buffer, 2, 1),
    buffer,
    zero: -0,
    nan: NaN,
    inf: Infinity,
    large: -(2n ** 120n),
    date: new Date(NaN),
    expression: /a\/b/giu,
    error: new TypeError("typed", { cause: 7n }),
  };
  source.self = source;
  const result = decodeTypedValue(encodeTypedValue(source)) as typeof source;
  expect(result.self).toBe(result);
  expect(0 in (result.sparse as unknown[])).toBe(false);
  const restoredBuffer = result.buffer;
  assert(restoredBuffer instanceof ArrayBuffer);
  expect((result.first as Uint8Array).buffer).toBe(restoredBuffer);
  expect((result.second as DataView).buffer).toBe(restoredBuffer);
  expect(encodeTypedValue(result)).toEqual(encodeTypedValue(source));
  expect(() => encodeTypedValue(new WeakMap())).toThrow("Unsupported runtime class");
  expect(() => valueToJson(source)).toThrow("cyclic");
});

test("persisted replay cursors transcode their exact prefix boundary both ways without resetting counters", () => {
  const suffix = packStringKey(["capture"]);
  const denoCursor = Buffer.from(suffix).toString("base64url");
  for (const [parts, value] of [
    [["uos_ai", "sentinel_replay", "v1", "reap_cursor"], denoCursor],
    [["uos_ai", "sentinel_replay", "v1", "budget"], { bootstrap_cursor: `4|${denoCursor}`, stored_bytes: 123, records: 7 }],
  ] as const) {
    const key = packStringKey(parts);
    const forward = transcodePersistedCursor(key, value, "deno-to-bun");
    expect(forward.changed).toBe(true);
    expect(transcodePersistedCursor(key, forward.value, "bun-to-deno").value).toEqual(value);
  }
  const paid = { request_key: ["paid", 7n, new Uint8Array([8])] };
  expect(transcodePersistedCursor(packStringKey(["uos_ai", "paid_fallback", "v3", "rollup_backfill_cursor"]), paid, "deno-to-bun").value).toBe(paid);
  expect(() => transcodePersistedCursor(packStringKey(["uos_ai", "sentinel_replay", "v1", "budget"]), { bootstrap_cursor: "99|bad" }, "deno-to-bun")).toThrow(
    "Unsupported"
  );
});

test("raw tuple guard rejects negative NaN and truncation without searching inside byte strings", () => {
  expect(() => {
    assertPortableKvKeyBytes(Buffer.from("026e616e00210007ffffffffffff", "hex"));
  }).toThrow("Negative NaN");
  for (const key of ["21fff8000000000000", "217fffffffffffffff", "218000000000000000", "21000fffffffffffff", "012100ff07ffffffffffff00"])
    expect(() => {
      assertPortableKvKeyBytes(Buffer.from(key, "hex"));
    }).not.toThrow();
  expect(() => {
    assertPortableKvKeyBytes(new Uint8Array([33, 0]));
  }).toThrow("Truncated");
});

test("immutable native snapshot reader preserves signed64-bit integers without parameters, writes or close sidecars", async () => {
  const root = fixture();
  const source = join(root, "native.sqlite3");
  const snapshot = join(root, "private # % ?.sqlite3");
  const kv = await openKv(source);
  try {
    await kv.set(["snapshot"], { count: 9007199254740993n });
  } finally {
    kv.close();
  }
  expect((await Bun.file(source).bytes())[18]).toBe(2);
  const before = await fileDigest(source);
  copyFileSync(source, snapshot, constants.COPYFILE_EXCL);
  expect(await fileDigest(snapshot)).toBe(before);
  for (const path of [source, snapshot]) for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(path + suffix)).toBe(false);
  const uri = pathToFileURL(snapshot);
  uri.searchParams.set("immutable", "1");
  const reader = createNativeSnapshotReader(new Database(uri.href, sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_URI));
  try {
    expect(verifyNativeSchema(reader, "bun-jsc-v1").version).toBeGreaterThan(0n);
    const statement = reader.query<{ exact: bigint; minimum: bigint; maximum: bigint }>(
      "SELECT 9007199254740993 AS exact, -9223372036854775808 AS minimum, 9223372036854775807 AS maximum"
    );
    const expected = { exact: 9007199254740993n, minimum: -9223372036854775808n, maximum: 9223372036854775807n };
    expect(statement.get()).toEqual(expected);
    expect(statement.all()).toEqual([expected]);
    expect([...statement.iterate()]).toEqual([expected]);
    const compareNames = (left: string, right: string): number => left.localeCompare(right);
    expect(Object.keys(statement).sort(compareNames)).toEqual(["all", "get", "iterate"]);
    expect(Object.keys(reader).sort(compareNames)).toEqual(["close", "query"]);
    expect(() => reader.query("SELECT ?")).toThrow("must not have bound parameters");
    expect(() => reader.query("SELECT $missing")).toThrow("must not have bound parameters");
    expect(() => reader.query("DELETE FROM kv").all()).toThrow(/readonly/i);
  } finally {
    reader.close();
  }
  expect(await fileDigest(snapshot)).toBe(before);
  expect(await fileDigest(source)).toBe(before);
  for (const path of [source, snapshot]) for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(path + suffix)).toBe(false);
});

test("snapshot reader fails closed if the pinned statement safe-integer API is unavailable", () => {
  const database = new Database(":memory:");
  const statement = database.query("SELECT 1");
  Object.defineProperty(statement, "safeIntegers", { value: undefined });
  const reader = createNativeSnapshotReader(database);
  try {
    expect(() => reader.query("SELECT 1")).toThrow("safe integers are unavailable");
  } finally {
    reader.close();
  }
});

test("converter reads its private immutable native WAL snapshot before invoking the offline codec", async () => {
  const root = fixture();
  const source = join(root, "native.sqlite3");
  const output = join(root, "output # % ?");
  mkdirSync(output);
  const destination = join(output, "deno.sqlite3");
  const receipt = join(root, "receipt.json");
  const missingCodec = join(root, "missing-offline-codec");
  const kv = await openKv(source);
  try {
    await kv.set(["snapshot"], { bytes: new Uint8Array([7]), count: 9n });
  } finally {
    kv.close();
  }
  expect((await Bun.file(source).bytes())[18]).toBe(2);
  for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(source + suffix)).toBe(false);
  const before = await fileDigest(source);
  await assert.rejects(convertKvDatabase({ direction: "bun-to-deno", source, destination, receipt, deno: missingCodec, denoSha256: "0".repeat(64) }), {
    code: "ENOENT",
    path: missingCodec,
  });
  expect(await fileDigest(source)).toBe(before);
  expect(existsSync(destination)).toBe(false);
  expect(existsSync(receipt)).toBe(false);
});

test("converter refuses preexisting destinations, nonempty WAL, unsupported schemas and queues without publishing", async () => {
  const root = fixture();
  const source = join(root, "source.sqlite3");
  const destination = join(root, "candidate.sqlite3");
  const receipt = join(root, "receipt.json");
  const options = { direction: "deno-to-bun" as const, source, destination, receipt, deno: "/invalid-deno", denoSha256: "0".repeat(64) };
  writeFileSync(destination, "preserved");
  await assert.rejects(convertKvDatabase(options), /NEW/);
  expect(await Bun.file(destination).text()).toBe("preserved");
  rmSync(destination);
  writeFileSync(source, "empty");
  writeFileSync(`${source}-wal`, "busy");
  await assert.rejects(convertKvDatabase(options), /nonempty WAL/);
  rmSync(`${source}-wal`);
  rmSync(source);
  const db = new Database(source, { safeIntegers: true });
  for (const ddl of NATIVE_DDL) db.run(ddl);
  db.run("INSERT INTO migration_state VALUES(0,3)");
  db.run("INSERT INTO data_version VALUES(0,11,0)");
  db.run("INSERT INTO queue VALUES(0,'queued',X'00','[]',X'00')");
  expect(() => verifyNativeSchema(db, "deno-v8")).toThrow("Nonempty");
  db.run("DELETE FROM queue");
  db.run("UPDATE data_version SET version='unsupported'");
  expect(() => verifyNativeSchema(db, "deno-v8")).toThrow("metadata types");
  db.run("UPDATE data_version SET version=11");
  db.run("CREATE TABLE unknown_state (value TEXT)");
  expect(() => verifyNativeSchema(db, "deno-v8")).toThrow("Unsupported native KV tables");
  db.run("DROP TABLE unknown_state");
  db.run("INSERT INTO queue VALUES(0,'queued',X'00','[]',X'00')");
  db.close(true);
  await assert.rejects(convertKvDatabase(options), /Nonempty/);
  expect(existsSync(destination)).toBe(false);
  expect(existsSync(receipt)).toBe(false);
});
