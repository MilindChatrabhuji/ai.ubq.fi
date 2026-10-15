import type { Database, Statement } from "bun:sqlite";

type NativeReadStatement<TRow> = Pick<Statement<TRow, []>, "get" | "all" | "iterate">;
export type NativeReader = { query<TRow>(sql: string): NativeReadStatement<TRow> };

/** Numeric SQLite URI flags cannot also set Bun's database-level binding options. */
export const createNativeSnapshotReader = (database: Database): NativeReader & { close(): void } => ({
  query<TRow>(sql: string): NativeReadStatement<TRow> {
    const statement = database.query<TRow, []>(sql);
    if (statement.paramsCount !== 0) throw new Error("Conversion snapshot queries must not have bound parameters");
    // Pinned Bun exposes this method, although its installed type declaration omits it.
    if (!("safeIntegers" in statement) || typeof statement.safeIntegers !== "function") throw new Error("Bun statement safe integers are unavailable");
    statement.safeIntegers(true);
    return { get: () => statement.get(), all: () => statement.all(), iterate: () => statement.iterate() };
  },
  close: () => {
    database.close(true);
  },
});

export type NativeRow = { k: Uint8Array; v: Uint8Array; v_encoding: bigint; version: bigint; seq: bigint; expiration_ms: bigint };
export type NativeRevision = { k: bigint; version: bigint; seq: bigint };
export const NATIVE_DDL = [
  "CREATE TABLE data_version (k INTEGER PRIMARY KEY, version INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE kv (k BLOB PRIMARY KEY, v BLOB NOT NULL, v_encoding INTEGER NOT NULL, version INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, expiration_ms INTEGER NOT NULL DEFAULT -1) WITHOUT ROWID",
  "CREATE INDEX kv_expiration_ms_idx ON kv (expiration_ms)",
  "CREATE TABLE migration_state (k INTEGER NOT NULL PRIMARY KEY, version INTEGER NOT NULL)",
  "CREATE TABLE queue (ts INTEGER NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, backoff_schedule TEXT NOT NULL, keys_if_undelivered BLOB NOT NULL, PRIMARY KEY (ts, id))",
  "CREATE TABLE queue_running (deadline INTEGER NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, backoff_schedule TEXT NOT NULL, keys_if_undelivered BLOB NOT NULL, PRIMARY KEY (deadline, id))",
];
const expectedColumns: Record<string, string[]> = {
  data_version: ["k:INTEGER:1", "version:INTEGER:0", "seq:INTEGER:0"],
  kv: ["k:BLOB:1", "v:BLOB:0", "v_encoding:INTEGER:0", "version:INTEGER:0", "seq:INTEGER:0", "expiration_ms:INTEGER:0"],
  migration_state: ["k:INTEGER:1", "version:INTEGER:0"],
  queue: ["ts:INTEGER:1", "id:TEXT:2", "data:BLOB:0", "backoff_schedule:TEXT:0", "keys_if_undelivered:BLOB:0"],
  queue_running: ["deadline:INTEGER:1", "id:TEXT:2", "data:BLOB:0", "backoff_schedule:TEXT:0", "keys_if_undelivered:BLOB:0"],
  uos_kv_metadata: ["key:TEXT:1", "value:TEXT:0"],
};

/** The supported schema is deliberately narrow: no guessing at newer schemas or queued payloads. */
const verifySchemaLayout = (db: NativeReader, codec: "deno-v8" | "bun-jsc-v1"): void => {
  const schema = db.query<{ type: string; name: string; sql: string | null }>("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  const tables = schema.filter((item) => item.type === "table").map((item) => item.name);
  const required = Object.keys(expectedColumns).filter((name) => codec === "bun-jsc-v1" || name !== "uos_kv_metadata");
  const compareNames = (left: string, right: string): number => left.localeCompare(right);
  if (JSON.stringify(tables.toSorted(compareNames)) !== JSON.stringify(required.toSorted(compareNames)))
    throw new Error("Unsupported native KV tables or codec marker");
  for (const item of schema) {
    if (
      item.type !== "table" &&
      !(item.type === "index" && ["kv_expiration_ms_idx", "sqlite_autoindex_queue_1", "sqlite_autoindex_queue_running_1"].includes(item.name))
    )
      throw new Error("Unsupported native schema object");
    if (item.sql !== null && !supportedSql.has(normalizeSql(item.sql))) throw new Error("Unsupported native schema definition");
  }
  for (const table of required) {
    const columns = db.query<{ name: string; type: string; pk: number }>(`PRAGMA table_info(${table})`).all();
    if (JSON.stringify(columns.map((column) => `${column.name}:${column.type.toUpperCase()}:${column.pk}`)) !== JSON.stringify(expectedColumns[table]))
      throw new Error(`Unsupported schema for ${table}`);
  }
};

const normalizeSql = (sql: string): string => sql.toLowerCase().replaceAll(" ", "").replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", "");
const supportedSql = new Set([...NATIVE_DDL, "CREATE TABLE uos_kv_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID"].map(normalizeSql));
const isNativeInteger = (value: unknown): value is bigint => typeof value === "bigint";

export const verifyNativeSchema = (db: NativeReader, codec: "deno-v8" | "bun-jsc-v1"): NativeRevision => {
  verifySchemaLayout(db, codec);
  if (
    db.query<{ user_version: bigint }>("PRAGMA user_version").get()?.user_version !== 0n ||
    db.query<{ application_id: bigint }>("PRAGMA application_id").get()?.application_id !== 0n
  )
    throw new Error("Unsupported native SQLite header metadata");
  const migration = db.query<{ k: bigint; version: bigint }>("SELECT k,version FROM migration_state").all();
  if (migration.length !== 1 || migration[0].k !== 0n || migration[0].version !== 3n) throw new Error("Unsupported native KV migration version");
  for (const queue of ["queue", "queue_running"]) {
    if (db.query<{ count: bigint }>(`SELECT COUNT(*) AS count FROM ${queue}`).get()?.count !== 0n)
      throw new Error("Nonempty native queues require a separate supported migration");
  }
  if (codec === "bun-jsc-v1") {
    if (db.query<{ value: string }>("SELECT value FROM uos_kv_metadata WHERE key='codec'").get()?.value !== codec) throw new Error("Incompatible source codec");
  }
  const revision = db.query<NativeRevision>("SELECT k,version,seq FROM data_version").all();
  if (!revision.every((row) => [row.k, row.version, row.seq].every(isNativeInteger))) throw new Error("Unsupported native revision metadata types");
  if (revision.length !== 1 || revision[0].k !== 0n || revision[0].version < 0n || revision[0].seq < 0n)
    throw new Error("Unsupported native revision metadata");
  if (db.query<{ integrity_check: string }>("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Native SQLite integrity check failed");
  return revision[0];
};

export const validateNativeRow = (row: NativeRow, revision: NativeRevision): void => {
  if (![row.v_encoding, row.version, row.seq, row.expiration_ms].every(isNativeInteger)) throw new Error("Unsupported native row metadata types");
  if (!(row.k instanceof Uint8Array) || !row.k.length || !(row.v instanceof Uint8Array)) throw new Error("Invalid native binary row");
  if (![1, 2, 3].includes(Number(row.v_encoding))) throw new Error("Unsupported native value encoding");
  if (Number(row.v_encoding) === 2 && row.v.length !== 8) throw new Error("Malformed native unsigned counter");
  if (row.version < 0n || row.version > revision.version || row.seq < 0n || row.expiration_ms < -1n)
    throw new Error("Invalid native revision or absolute expiration");
};
