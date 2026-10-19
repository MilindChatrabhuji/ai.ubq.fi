import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPrivateConsistentBunSnapshot } from "../src/kv-conversion/convert.ts";
import { NATIVE_DDL } from "../src/kv-conversion/native-schema.ts";

const owned: string[] = [];
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});
const fixture = (marked = true) => {
  const directory = mkdtempSync(join(tmpdir(), "uos-stopped-snapshot-"));
  owned.push(directory);
  const source = join(directory, "source.sqlite3");
  const database = new Database(source, { create: true, strict: true, safeIntegers: true });
  database.run("PRAGMA journal_mode=DELETE");
  for (const ddl of NATIVE_DDL) database.run(ddl);
  database.run("INSERT INTO migration_state(k,version) VALUES(0,3)");
  database.run("INSERT INTO data_version(k,version,seq) VALUES(0,7,0)");
  if (marked) {
    database.run("CREATE TABLE uos_kv_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    database.run("INSERT INTO uos_kv_metadata(key,value) VALUES('codec','bun-jsc-v1')");
  }
  database.close(true);
  return { directory, source };
};

test("private Bun callback reads a verified immutable marked snapshot and removes its private copy", async () => {
  const { directory, source } = fixture();
  const original = readFileSync(source);
  const result = await withPrivateConsistentBunSnapshot(source, directory, (reader, revision) => {
    assert.deepEqual(revision, { k: 0n, version: 7n, seq: 0n });
    assert.throws(() => reader.query("DELETE FROM data_version").all(), /readonly/i);
    return reader.query<{ version: bigint }>("SELECT version FROM data_version").all();
  });
  assert.deepEqual(result.value, [{ version: 7n }]);
  assert.match(result.sourceIdentity.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.sourceIdentity.drain_boundary, "checkpointed-no-wal");
  assert.deepEqual(readFileSync(source), original);
  assert.deepEqual(readdirSync(directory), ["source.sqlite3"]);
});

test("unmarked, corrupt, unsettled and symlink sources refuse before invoking the callback", async () => {
  const { directory, source } = fixture(false);
  let calls = 0;
  const read = () => ++calls;
  await assert.rejects(withPrivateConsistentBunSnapshot(source, directory, read));
  const corrupt = join(directory, "corrupt.sqlite3");
  writeFileSync(corrupt, "not a database");
  await assert.rejects(withPrivateConsistentBunSnapshot(corrupt, directory, read));
  const link = join(directory, "link.sqlite3");
  symlinkSync(source, link);
  await assert.rejects(withPrivateConsistentBunSnapshot(link, directory, read), /regular SQLite/);
  for (const suffix of ["-wal", "-journal"]) {
    writeFileSync(source + suffix, "unsettled");
    await assert.rejects(withPrivateConsistentBunSnapshot(source, directory, read), /stopped|journal/);
    rmSync(source + suffix);
  }
  assert.equal(calls, 0);
  assert.ok(!readdirSync(directory).some((entry) => entry.startsWith(".uos-kv-capture-")));
});

test("source changes and callback errors fail without publishing or retaining a snapshot", async () => {
  const { directory, source } = fixture();
  await assert.rejects(
    withPrivateConsistentBunSnapshot(source, directory, () => {
      const changed = new Database(source, { strict: true, safeIntegers: true });
      changed.run("UPDATE data_version SET version=8");
      changed.close(true);
    }),
    /Source changed/
  );
  await assert.rejects(
    withPrivateConsistentBunSnapshot(source, directory, () => {
      throw new Error("synthetic callback refusal");
    }),
    /synthetic callback refusal/
  );
  assert.deepEqual(readdirSync(directory), ["source.sqlite3"]);
});
