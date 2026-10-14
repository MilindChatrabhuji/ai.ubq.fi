import { openKv as openNativeKv, type Kv } from "@deno/kv";
import { Database } from "bun:sqlite";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deserialize, serialize } from "node:v8";
import { guardNativeKv, retrySqliteBusy } from "./native-kv.ts";
import { assertPortableKvValue } from "./value-compatibility.ts";

export type {
  AtomicCheck,
  AtomicOperation,
  Kv,
  KvCommitError,
  KvCommitResult,
  KvConsistencyLevel,
  KvEntry,
  KvEntryMaybe,
  KvKey,
  KvKeyPart,
  KvListIterator,
  KvListOptions,
  KvListSelector,
  KvMutation,
} from "@deno/kv";
export { KvU64 } from "@deno/kv";
export { assertPortableKvKeyBytes } from "./key-compatibility.ts";
export { assertPortableKvValue } from "./value-compatibility.ts";
export { prepareNativeKvBackend, verifyNativeKvArtifact } from "./native-addon.ts";
export type { NativeKvArtifactBinding, VerifiedNativeKvArtifact } from "./native-addon.ts";

export const BUN_KV_DATABASE_PATH = ".data/kv-bun.sqlite3";
export const BUN_KV_CODEC = "bun-jsc-v1";
export const BUN_KV_CODEC_TABLE = "uos_kv_metadata";

/** Inspect the marker before the native backend can migrate or mutate a file. */
const verifyCodec = (path: string): void => {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const table = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'uos_kv_metadata'").get();
    const marker = table ? database.query<{ value: string }, []>("SELECT value FROM uos_kv_metadata WHERE key = 'codec'").get() : null;
    if (marker?.value !== BUN_KV_CODEC) {
      throw new Error("KV codec is missing or incompatible; convert the legacy database offline before opening it with Bun");
    }
  } finally {
    database.close(true);
  }
};

const prepareDatabase = (path: string): void => {
  try {
    const file = lstatSync(path);
    if (!file.isFile()) throw new Error("KV database must be a regular file, not a symlink or directory");
    verifyCodec(path);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  mkdirSync(dirname(path), { recursive: true });
  // Exclusive creation cannot adopt a legacy file planted between stat and open.
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
  const database = new Database(path, { strict: true });
  try {
    database
      .transaction(() => {
        database.run("CREATE TABLE uos_kv_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
        database.run("INSERT INTO uos_kv_metadata (key, value) VALUES (?, ?)", ["codec", BUN_KV_CODEC]);
        database.run("INSERT INTO uos_kv_metadata (key, value) VALUES (?, ?)", ["created_bun_version", Bun.version]);
      })
      .immediate();
  } finally {
    database.close(true);
  }
};

/** Open only native SQLite databases whose values belong to the explicit Bun codec. */
export const openKv = async (path = BUN_KV_DATABASE_PATH): Promise<Kv> => {
  if (!path || /^https?:\/\//i.test(path)) throw new Error("Bun KV requires an explicit local SQLite path or :memory:");
  const target = path === ":memory:" ? path : resolve(path);
  return await retrySqliteBusy(async () => {
    if (target !== ":memory:") prepareDatabase(target);
    return guardNativeKv(
      await openNativeKv(target, {
        implementation: "sqlite",
        encodeV8: (value: unknown) => {
          assertPortableKvValue(value);
          return serialize(value);
        },
        decodeV8: deserialize,
      })
    );
  });
};
