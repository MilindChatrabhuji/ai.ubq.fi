import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Scalar = string | number | bigint | boolean | null | undefined;

const fileState = (path: string): string => {
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || typeof info.mtimeNs !== "bigint" || typeof info.ctimeNs !== "bigint")
    throw new Error("Read-only SQLite inspection requires a regular file and precise change timestamps");
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
};

const requireNoSidecars = (path: string): void => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      lstatSync(path + suffix);
      throw new Error("Read-only SQLite fallback refuses WAL, shared-memory or rollback-journal files");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
};

const inspect = <T extends Scalar>(path: string, read: (database: Database) => T): T => {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return read(database);
  } finally {
    database.close(true);
  }
};

/** Read live WAL normally; immutable retry is limited to a stable, sidecar-free stopped file. */
export const inspectSqliteReadOnly = <T extends Scalar>(path: string, read: (database: Database) => T): T => {
  try {
    return inspect(path, read);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "SQLITE_CANTOPEN") throw error;
  }
  const physical = resolve(path);
  requireNoSidecars(physical);
  const before = fileState(physical);
  const uri = pathToFileURL(physical);
  uri.searchParams.set("immutable", "1");
  const result = inspect(uri.href, read);
  // The immutable connection is already closed: never expose it beyond this synchronous fence.
  requireNoSidecars(physical);
  if (fileState(physical) !== before) throw new Error("SQLite source changed during read-only inspection");
  return result;
};
