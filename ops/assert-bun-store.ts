import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
/** No native KV open, automatic creation or conversion during deploy/startup. */
export const assertBunConvertedStore = async (root: string): Promise<void> => {
  const path = join(root, ".data/kv-bun.sqlite3");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("An explicitly converted regular Bun database is required");
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const value = db.query<{ value: string }, []>("SELECT value FROM uos_kv_metadata WHERE key='codec'").get();
    if (value?.value !== "bun-jsc-v1") throw new Error("Offline KV conversion must publish the explicit Bun/JSC marker before deployment");
  } finally {
    db.close(true);
  }
};
