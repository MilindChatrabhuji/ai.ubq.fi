import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { constants, Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectSqliteReadOnly } from "../src/storage/sqlite-readonly.ts";
import { assertBunConvertedStore } from "../ops/assert-bun-store.ts";
import { openKv } from "#kv";

const fixtureRoot = resolve(".cleanup-evidence/sqlite-readonly");
mkdirSync(fixtureRoot, { recursive: true });
const directories: string[] = [];

const fixture = (wal = true): { root: string; path: string } => {
  const root = mkdtempSync(fixtureRoot + "/case-");
  directories.push(root);
  mkdirSync(root + "/.data");
  const path = root + "/.data/kv-bun.sqlite3";
  const db = new Database(path);
  try {
    db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    if (wal) db.run("PRAGMA journal_mode=WAL");
    db.run("CREATE TABLE uos_kv_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    db.run("INSERT INTO uos_kv_metadata VALUES ('codec','bun-jsc-v1')");
  } finally {
    db.close(true);
  }
  return { root, path };
};

const marker = (db: Database): string | undefined => db.query<{ value: string }, []>("SELECT value FROM uos_kv_metadata WHERE key='codec'").get()?.value;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("readonly codec inspection accepts a drained WAL-mode file without changing database bytes", async () => {
  const { root, path } = fixture();
  const before = readFileSync(path);
  for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(path + suffix)).toBe(false);
  expect(inspectSqliteReadOnly(path, marker)).toBe("bun-jsc-v1");
  await assertBunConvertedStore(root);
  expect(readFileSync(path)).toEqual(before);
});

test("readonly codec inspection sees the latest live WAL marker before native opening", async () => {
  const { root, path } = fixture();
  const writer = new Database(path);
  try {
    writer.run("UPDATE uos_kv_metadata SET value='deno-v8' WHERE key='codec'");
    expect(existsSync(path + "-wal")).toBe(true);
    const before = readFileSync(path);
    const walBefore = readFileSync(path + "-wal");
    expect(inspectSqliteReadOnly(path, marker)).toBe("deno-v8");
    await assert.rejects(assertBunConvertedStore(root), /explicit Bun\/JSC marker/);
    await assert.rejects(openKv(path), /codec is missing or incompatible/);
    expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(path + "-wal")).toEqual(walBefore);
  } finally {
    writer.close(true);
  }
});

test("read-only validation errors propagate without retrying an inspection", () => {
  const { path } = fixture(false);
  let reads = 0;
  expect(() =>
    inspectSqliteReadOnly(path, () => {
      reads++;
      throw new Error("marker inspection rejected");
    })
  ).toThrow("marker inspection rejected");
  expect(reads).toBe(1);
});

if (process.platform === "darwin") {
  test("immutable readonly inspection refuses every sidecar appearing during its fence", () => {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const { path } = fixture();
      const before = readFileSync(path);
      expect(() =>
        inspectSqliteReadOnly(path, (db) => {
          const value = marker(db);
          writeFileSync(path + suffix, "");
          return value;
        })
      ).toThrow("refuses WAL");
      expect(readFileSync(path)).toEqual(before);
    }
  });

  test("immutable readonly inspection refuses a file changed during its fence", () => {
    const { path } = fixture();
    const before = readFileSync(path);
    expect(() =>
      inspectSqliteReadOnly(path, (db) => {
        const value = marker(db);
        utimesSync(path, new Date(), new Date(Date.now() + 1000));
        return value;
      })
    ).toThrow("source changed");
    expect(readFileSync(path)).toEqual(before);
  });
}
